// Responses-API → Anthropic Messages bridge.
//
// Anthropic (and Anthropic-compat gateways) have no /v1/responses surface.
// Codex-family agents speak Responses only, so the gateway translates:
// Responses request in → /v1/messages upstream → Responses payload out,
// including the SSE event stream Codex expects.

import { parseInput, ResponsesSseWriter } from "./responses-bridge";

export interface AnthropicBridgeIn {
  model: string;
  input?: unknown;
  instructions?: unknown;
  max_output_tokens?: unknown;
  temperature?: unknown;
  top_p?: unknown;
  stream?: boolean;
  tools?: unknown[];
  tool_choice?: unknown;
}

/** Responses tool entries (flat `{type,name,input_schema}` and nested
 *  `{type:"function",function:{...}}`) → Anthropic `tools` schema. */
export function toAnthropicTools(entries: unknown[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const raw of entries) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const inner = o.function && typeof o.function === "object"
      ? (o.function as Record<string, unknown>)
      : o;
    const name = inner.name ?? o.name;
    if (!name) continue;
    const tool: Record<string, unknown> = { name: String(name) };
    const desc = inner.description ?? o.description;
    if (desc) tool.description = String(desc);
    const schema = inner.parameters ?? inner.input_schema ?? o.input_schema;
    if (schema && typeof schema === "object") tool.input_schema = schema;
    out.push(tool);
  }
  return out;
}

export function toAnthropicToolChoice(choice: unknown): Record<string, unknown> | undefined {
  if (choice === "auto") return { type: "auto" };
  if (choice === "any" || choice === "required") return { type: "any" };
  if (choice === "none") return { type: "none" };
  if (choice && typeof choice === "object") {
    const o = choice as Record<string, unknown>;
    if (o.type === "function" || o.type === "tool") {
      const inner = o.function && typeof o.function === "object"
        ? (o.function as Record<string, unknown>)
        : o;
      const name = inner.name ?? o.name;
      if (name) return { type: "tool", name: String(name) };
    }
  }
  return undefined;
}

export function buildAnthropicBridgeRequest(parsed: AnthropicBridgeIn): Record<string, unknown> {
  const all = parseInput(parsed.input, parsed.instructions);
  const sysParts = all.filter((m) => m.role === "system").map((m) => m.content);
  const msgs = all
    .filter((m) => m.role !== "system")
    .filter((m) => m.content.length > 0)
    .map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content }));
  const body: Record<string, unknown> = {
    model: parsed.model,
    // Anthropic requires max_tokens; Responses requests rarely carry it.
    max_tokens: typeof parsed.max_output_tokens === "number" ? parsed.max_output_tokens : 8192,
    messages: msgs,
    stream: parsed.stream === true,
  };
  if (sysParts.length > 0) body.system = sysParts.join("\n\n");
  if (typeof parsed.temperature === "number") body.temperature = parsed.temperature;
  if (typeof parsed.top_p === "number") body.top_p = parsed.top_p;
  if (Array.isArray(parsed.tools) && parsed.tools.length > 0) {
    const tools = toAnthropicTools(parsed.tools);
    if (tools.length > 0) {
      body.tools = tools;
      if (parsed.tool_choice !== undefined) {
        const tc = toAnthropicToolChoice(parsed.tool_choice);
        if (tc) body.tool_choice = tc;
      }
    }
  }
  return body;
}

/** Anthropic /v1/messages (non-stream) body → Responses `response` object. */
export function buildAnthropicBridgeResponse(body: unknown, model: string): Record<string, unknown> {
  const b = body as {
    id?: string;
    content?: Array<{ type?: string; text?: string; id?: string; name?: string; input?: unknown }>;
    stop_reason?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const output: Array<Record<string, unknown>> = [];
  for (const c of b.content ?? []) {
    if (c.type === "text" && c.text) {
      output.push({
        id: `msg_${b.id ?? Date.now()}`,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: c.text, annotations: [] }],
      });
    } else if (c.type === "tool_use") {
      output.push({
        id: `fc_${c.id ?? Date.now()}`,
        type: "function_call",
        status: "completed",
        call_id: c.id,
        name: c.name ?? "",
        arguments: JSON.stringify(c.input ?? {}),
      });
    }
  }
  if (output.length === 0) {
    output.push({
      id: `msg_${b.id ?? Date.now()}`,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "", annotations: [] }],
    });
  }
  const it = b.usage?.input_tokens ?? 0;
  const ot = b.usage?.output_tokens ?? 0;
  return {
    id: `resp_${b.id ?? Date.now()}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: b.stop_reason === "max_tokens" ? "incomplete" : "completed",
    model,
    output,
    usage: { input_tokens: it, output_tokens: ot, total_tokens: it + ot },
  };
}

/** Drive Responses SSE off a raw Anthropic /v1/messages SSE stream. */
export async function writeAnthropicBridgeStream(
  res: import("http").ServerResponse,
  sse: AsyncIterable<string>,
  model: string,
  opts?: { signal?: AbortSignal },
): Promise<{ usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } }> {

  const w = new ResponsesSseWriter(model);
  res.write(w.created());
  let usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;
  let currentBlock: string | undefined;
  const openTools = new Map<number, { id: string; name: string; json: string }>();
  let nextToolIndex = 0;
  let textOpened = false;
  let textClosed = false;
  let failed = false;
  // Errors are unwound when the loop exits (message_stop, break, or throw).
  try {
    for await (const frame of sse) {
      if (!frame.startsWith("data:")) continue;
      const payload = frame.slice(5).trim();
      if (!payload) continue;
      let evt: Record<string, any>;
      try { evt = JSON.parse(payload); } catch { continue; }
      if (evt.type === "message_start" && evt.message?.usage?.input_tokens != null) {
        usage = { ...usage, prompt_tokens: evt.message.usage.input_tokens };
      }
      if (evt.type === "content_block_start") {
        currentBlock = evt.content_block?.type;
        if (currentBlock === "tool_use") {
          openTools.set(evt.index, { id: evt.content_block.id ?? "", name: evt.content_block.name ?? "", json: "" });
        }
      }
      if (evt.type === "content_block_delta") {
        const d = evt.delta ?? {};
        if (currentBlock === "text" && d.type === "text_delta" && d.text) {
          if (!textOpened) {
            res.write(w.messageItemAdded(nextToolIndex));
            textOpened = true;
          }
          res.write(w.delta(d.text));
        }
        if (currentBlock === "tool_use" && d.type === "input_json_delta" && d.partial_json) {
          const t = openTools.get(evt.index ?? -1);
          if (t) t.json += d.partial_json;
        }
      }
      if (evt.type === "content_block_stop") {
        const t = openTools.get(evt.index ?? -1);
        if (t) {
          if (textOpened && !textClosed) {
            res.write(w.messageItemDone(nextToolIndex - 1));
            textClosed = true;
          }
          const idx = nextToolIndex++;
          res.write(w.toolCall(idx, {
            id: t.id,
            type: "function",
            function: { name: t.name, arguments: t.json || "{}" },
          }));
          res.write(w.toolCallDone(idx, {
            id: t.id,
            type: "function",
            function: { name: t.name, arguments: t.json || "{}" },
          }));
          openTools.delete(evt.index);
        }
        currentBlock = undefined;
      }
      if (evt.type === "message_delta" && evt.usage?.output_tokens != null) {
        usage = { ...usage, completion_tokens: evt.usage.output_tokens };
      }
      if (evt.type === "message_stop") break;
    }
  } catch (err) {
    failed = true;
    res.write(w.failed(String(err instanceof Error ? err.message : err)));
  }
  if (usage && (usage.prompt_tokens != null || usage.completion_tokens != null)) {
    usage.total_tokens = (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0);
  }
  if (!failed) {
    if (textOpened && !textClosed) res.write(w.messageItemDone(nextToolIndex - 1));
    res.write(w.completed(usage));
  }
  return { usage };
}
