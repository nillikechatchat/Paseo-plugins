// Anthropic Messages API adapter. Translates OpenAI-style chat into Anthropic's
// messages schema and back. Supports streaming via SSE.

import type {
  NormalizedRequest,
  NormalizedResponse,
  NormalizedMessage,
  ProviderAdapter,
} from "./base";
import type { Provider } from "../storage";

function pickBaseUrl(provider: Provider): string {
  return (provider.baseUrl || "https://api.anthropic.com").replace(/\/$/, "");
}

// Native Anthropic authenticates with x-api-key; Anthropic-compatible
// gateways (MiniMax, SenseNova, …) use Bearer tokens.
function isNativeAnthropic(provider: Provider): boolean {
  const base = provider.baseUrl || "https://api.anthropic.com";
  try {
    return new URL(base).hostname === "api.anthropic.com";
  } catch {
    return false;
  }
}

function anthropicHeaders(provider: Provider): Record<string, string> {
  const key = provider.apiKey ?? "";
  return isNativeAnthropic(provider)
    ? { "x-api-key": key }
    : { authorization: `Bearer ${key}` };
}

function anthropicProtocolHeaders(provider: Provider, proto: "messages" | "responses"): Record<string, string> {
  const h = anthropicHeaders(provider);
  if (proto === "messages") h["anthropic-version"] = "2023-06-01";
  return h;
}

// ---- tool conversion (OpenAI chat / Responses flat → Anthropic schema) ----

export function toAnthropicTool(entry: unknown): Record<string, unknown> | null {
  if (!entry || typeof entry !== "object") return null;
  const o = entry as Record<string, unknown>;
  const inner = o.function && typeof o.function === "object"
    ? (o.function as Record<string, unknown>)
    : o;
  const name = inner.name ?? o.name;
  if (!name) return null;
  const tool: Record<string, unknown> = { name: String(name) };
  const desc = inner.description ?? o.description;
  if (desc) tool.description = String(desc);
  const schema = inner.parameters ?? inner.input_schema ?? o.input_schema;
  if (schema && typeof schema === "object") tool.input_schema = schema;
  return tool;
}

export function toAnthropicToolChoice(choice: unknown): Record<string, unknown> | undefined {
  if (choice === "auto" || choice === undefined) return { type: "auto" };
  if (choice === "none") return { type: "none" };
  if (choice === "required" || choice === "any") return { type: "any" };
  if (choice && typeof choice === "object") {
    const o = choice as Record<string, unknown>;
    const fn = o.function && typeof o.function === "object" ? (o.function as Record<string, unknown>) : o;
    if (o.type === "function" && fn.name) return { type: "tool", name: String(fn.name) };
    if (o.type === "tool" && o.name) return { type: "tool", name: String(o.name) };
  }
  return undefined;
}

interface AnthropicBlock { [k: string]: unknown; type: string; }

function toAnthropicMessages(messages: NormalizedRequest["messages"]): Array<{ role: string; content: unknown }> {
  const out: Array<{ role: string; content: unknown }> = [];
  let pendingToolResults: AnthropicBlock[] = [];
  const flushTools = (role: "user" | "assistant") => {
    if (pendingToolResults.length > 0 && role === "user") {
      out.push({ role: "user", content: pendingToolResults });
      pendingToolResults = [];
    }
  };
  for (const m of messages) {
    if (m.role === "system") continue; // handled separately
    if (m.role === "tool") {
      pendingToolResults.push({
        type: "tool_result",
        tool_use_id: m.tool_call_id ?? String(m.name ?? ""),
        content: m.content ?? "",
      });
      continue;
    }
    flushTools(m.role === "user" ? "user" : "assistant");
    const blocks: AnthropicBlock[] = [];
    const raw = m as NormalizedMessage & { tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> };
    if (m.content) blocks.push({ type: "text", text: m.content });
    if (Array.isArray(raw.tool_calls)) {
      for (const tc of raw.tool_calls) {
        const name = tc.function?.name ?? "";
        if (!name) continue;
        let input: unknown = {};
        const args = tc.function?.arguments;
        if (typeof args === "string" && args) {
          try { input = JSON.parse(args); } catch { input = { _raw: args }; }
        }
        blocks.push({ type: "tool_use", id: tc.id ?? `toolu_${Math.random().toString(36).slice(2, 12)}`, name, input });
      }
    }
    out.push({ role: m.role === "assistant" ? "assistant" : "user", content: blocks.length > 0 ? blocks : "" });
  }
  if (pendingToolResults.length > 0) out.push({ role: "user", content: pendingToolResults });
  return out;
}

function splitSystem(messages: NormalizedRequest["messages"]): { system: string | null; rest: NormalizedRequest["messages"] } {
  const sysParts: string[] = [];
  const rest: NormalizedRequest["messages"] = [];
  for (const m of messages) {
    if (m.role === "system") {
      if (m.content) sysParts.push(m.content);
    } else {
      rest.push(m);
    }
  }
  return { system: sysParts.length > 0 ? sysParts.join("\n\n") : null, rest };
}

export const anthropicAdapter: ProviderAdapter = {
  id: "anthropic",
  supportsStreaming: true,
  defaultBaseUrl: "https://api.anthropic.com",

  buildUrl(provider, endpoint) {
    const base = pickBaseUrl(provider);
    // Anthropic publishes a /v1/models endpoint that lists every model the
    // key can call. Anything that isn't `chat` falls back to /v1/messages
    // because Anthropic only has one chat-shaped surface.
    if (endpoint === "models") return `${base}/v1/models`;
    return `${base}/v1/messages`;
  },

  buildHeaders(provider) {
    return {
      "content-type": "application/json",
      ...anthropicHeaders(provider),
    };
  },

  buildProtocolUrl(provider, proto) {
    const base = pickBaseUrl(provider);
    // Responses requests to anthropic-type providers are intercepted by the
    // gateway's messages bridge before this is consulted; the generic path
    // is kept for completeness.
    return proto === "messages" ? `${base}/v1/messages` : `${base}/v1/responses`;
  },

  buildProtocolHeaders(provider, proto) {
    return anthropicProtocolHeaders(provider, proto);
  },

  async listModels(provider, signal) {
    const base = pickBaseUrl(provider);
    const res = await fetch(`${base}/v1/models`, {
      method: "GET",
      headers: anthropicHeaders(provider),
      signal,
    } as RequestInit);
    if (!res.ok) throw new Error(`upstream ${res.status}`);
    const body = (await res.json()) as { data?: Array<{ id?: string; name?: string }> };
    const models = (body.data ?? []).map((m) => m.id ?? m.name ?? "").filter(Boolean);
    return { models, raw: body };
  },

  transformRequest(req, provider) {
    const { system, rest } = splitSystem(req.messages);
    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.max_tokens ?? 8192,
      messages: toAnthropicMessages(rest),
    };
    if (system) body.system = system;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.top_p !== undefined) body.top_p = req.top_p;
    if (req.stop) body.stop_sequences = req.stop;
    if (req.stream) body.stream = true;
    if (Array.isArray(req.tools) && req.tools.length > 0) {
      const tools = req.tools.map(toAnthropicTool).filter((t): t is Record<string, unknown> => t !== null);
      if (tools.length > 0) {
        body.tools = tools;
        const tc = toAnthropicToolChoice(req.tool_choice);
        if (tc) body.tool_choice = tc;
      }
    }
    return { body, stream: req.stream };
  },

  transformResponse(body, _provider, model): NormalizedResponse {
    const b = body as {
      id?: string;
      model?: string;
      content?: Array<{ type: string; text?: string }>;
      stop_reason?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const text = (b.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");
    return {
      id: b.id ?? `msg-${Date.now()}`,
      model: b.model ?? model,
      provider: "anthropic",
      content: text,
      finish_reason: b.stop_reason,
      usage: b.usage
        ? {
            prompt_tokens: b.usage.input_tokens,
            completion_tokens: b.usage.output_tokens,
            total_tokens: (b.usage.input_tokens ?? 0) + (b.usage.output_tokens ?? 0),
          }
        : undefined,
      raw: body,
    };
  },

  async *transformStream(rawChunks, _provider, model) {
    let buffer = "";
    let idx = 0;
    let currentId = `msg-${Date.now()}`;
    const decoder = new TextDecoder();
    for await (const chunk of rawChunks) {
      buffer += decoder.decode(chunk, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, sep).trim();
        buffer = buffer.slice(sep + 1);
        if (!line || !line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        try {
          const evt = JSON.parse(payload) as {
            type?: string;
            message?: { id?: string; model?: string; usage?: { input_tokens?: number; output_tokens?: number } };
            index?: number;
            delta?: { type?: string; text?: string; stop_reason?: string };
          };
          if (evt.type === "message_start" && evt.message?.id) {
            currentId = evt.message.id;
          }
          if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") {
            yield {
              id: currentId,
              model,
              delta: evt.delta.text ?? "",
              raw: evt,
            };
            idx++;
          }
          if (evt.type === "message_delta" && evt.delta?.stop_reason) {
            yield {
              id: currentId,
              model,
              delta: "",
              finish_reason: evt.delta.stop_reason,
              raw: evt,
            };
          }
          if (evt.type === "message_stop") {
            return;
          }
        } catch {
          // ignore malformed event
        }
      }
    }
  },
};
