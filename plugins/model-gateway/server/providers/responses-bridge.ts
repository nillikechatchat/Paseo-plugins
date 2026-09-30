// Responses-API → Chat-Completions bridge.
//
// Some vendors (notably Zhipu GLM) expose the OpenAI chat schema but no
// native /responses endpoint. Codex-family agents speak Responses only, so
// the gateway translates: Responses request in → chat/completions upstream →
// Responses payload back out, including the SSE event stream Codex expects.

import type { Provider } from "../storage";
import type { NormalizedChunk, ProviderAdapter } from "./base";

interface ResponsesIn {
  model: string;
  input?: unknown;
  instructions?: unknown;
  max_output_tokens?: unknown;
  temperature?: unknown;
  top_p?: unknown;
  stream?: boolean;
}

export function parseInput(input: unknown, instructions: unknown): Array<{ role: string; content: string }> {
  const messages: Array<{ role: string; content: string }> = [];
  if (typeof instructions === "string" && instructions) {
    messages.push({ role: "system", content: instructions });
  }
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (!item || typeof item !== "object") continue;
      const o = item as { role?: string; content?: unknown; type?: string; text?: string };
      // OpenAI's `developer` role (newer synonym for system) is rejected by
      // strict/GLM upstreams that only accept user/assistant/system/root —
      // normalise it to `system` so the bridged request is portable.
      let role: string = typeof o.role === "string" ? o.role : "user";
      if (role === "developer") role = "system";
      let content = "";
      if (typeof o.content === "string") {
        content = o.content;
      } else if (Array.isArray(o.content)) {
        // Responses-style content parts: [{type:"input_text"|"output_text", text}]
        content = o.content
          .map((c) => (c && typeof c === "object" && typeof (c as { text?: string }).text === "string"
            ? (c as { text: string }).text : ""))
          .join("");
      } else if (typeof o.text === "string") {
        content = o.text;
      }
      if (content || role !== "user") messages.push({ role, content });
    }
  }
  if (messages.length === 0) messages.push({ role: "user", content: "" });
  return messages;
}

export function buildBridgeRequest(parsed: ResponsesIn): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: parsed.model,
    messages: parseInput(parsed.input, parsed.instructions),
    stream: parsed.stream === true,
  };
  if (typeof parsed.max_output_tokens === "number") body.max_tokens = parsed.max_output_tokens;
  if (typeof parsed.temperature === "number") body.temperature = parsed.temperature;
  if (typeof parsed.top_p === "number") body.top_p = parsed.top_p;
  return body;
}

export function buildBridgeResponse(chatBody: unknown, model: string, idHint?: string): Record<string, unknown> {
  const b = chatBody as {
    id?: string;
    choices?: Array<{ message?: { content?: string; reasoning_content?: string; tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };
  const choice = b.choices?.[0];
  const text = choice?.message?.content ?? "";
  const reasoning = choice?.message?.reasoning_content;
  const toolCalls = choice?.message?.tool_calls ?? [];
  const respId = `resp_${b.id ?? Date.now()}`;
  const output: Array<Record<string, unknown>> = [];
  if (reasoning) {
    output.push({
      id: `rs_${b.id ?? Date.now()}`,
      type: "reasoning",
      summary: [{ type: "summary_text", text: reasoning }],
    });
  }
  // tool_calls → function_call output items (previously dropped in the
  // non-streaming bridge, so codex saw "one sentence and stop").
  toolCalls.forEach((tc, i) => {
    output.push({
      id: `fc_${respId}_${i}`,
      type: "function_call",
      call_id: tc.id ?? `call_${respId}_${i}`,
      name: tc.function?.name ?? "",
      arguments: tc.function?.arguments ?? "",
      status: "completed",
    });
  });
  output.push({
    id: `msg_${b.id ?? Date.now()}`,
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  });
  return {
    id: respId,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model,
    output,
    usage: b.usage
      ? {
          input_tokens: b.usage.prompt_tokens,
          output_tokens: b.usage.completion_tokens,
          total_tokens: b.usage.total_tokens,
        }
      : undefined,
    ...(idHint ? {} : {}),
  };
}

// SSE helpers for the streaming bridge. Emits the minimal event set Codex
// consumes: response.created → response.output_text.delta* → response.completed.
function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export class ResponsesSseWriter {
  private seq = 0;
  private responseId = `resp_${Date.now()}`;
  private startedAt = Math.floor(Date.now() / 1000);
  /** Output index of the currently open message item — deltas must reference
   *  the same index messageItemAdded used, or clients see mismatched items. */
  private messageIndex = 0;

  constructor(private model: string) {}

  created(): string {
    this.seq++;
    return sse("response.created", {
      type: "response.created",
      sequence_number: this.seq,
      response: {
        id: this.responseId, object: "response", status: "in_progress",
        model: this.model, created_at: this.startedAt, output: [],
      },
    });
  }

  delta(text: string): string {
    this.seq++;
    return sse("response.output_text.delta", {
      type: "response.output_text.delta",
      sequence_number: this.seq,
      item_id: `msg_${this.responseId}`,
      output_index: this.messageIndex,
      content_index: 0,
      delta: text,
    });
  }

  messageItemAdded(outputIndex: number): string {
    this.messageIndex = outputIndex;
    this.seq++;
    return sse("response.output_item.added", {
      type: "response.output_item.added",
      sequence_number: this.seq,
      output_index: outputIndex,
      item: {
        id: `msg_${this.responseId}`,
        type: "message",
        role: "assistant",
        status: "in_progress",
        content: [],
      },
    });
  }

  messageItemDone(outputIndex: number): string {
    this.seq++;
    return sse("response.output_item.done", {
      type: "response.output_item.done",
      sequence_number: this.seq,
      output_index: outputIndex,
      item: {
        id: `msg_${this.responseId}`,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "", annotations: [] }],
      },
    });
  }

  toolCallDone(index: number, toolCall: NonNullable<NormalizedChunk["tool_calls"]>[number]): string {
    const id = toolCall.id ?? `call_${this.responseId}_${index}`;
    const name = toolCall.function?.name ?? "";
    const args = toolCall.function?.arguments ?? "";
    this.seq++;
    return sse("response.output_item.done", {
      type: "response.output_item.done",
      sequence_number: this.seq,
      output_index: index,
      item: {
        id: `fc_${id}`,
        type: "function_call",
        status: "completed",
        call_id: id,
        name,
        arguments: args,
      },
    });
  }

  failed(message: string): string {
    this.seq++;
    return sse("response.failed", {
      type: "response.failed",
      sequence_number: this.seq,
      response: {
        id: this.responseId, object: "response", status: "failed",
        model: this.model, created_at: this.startedAt, output: [],
        error: { code: "upstream_error", message },
      },
    });
  }

  completed(usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }): string {
    this.seq++;
    return sse("response.completed", {
      type: "response.completed",
      sequence_number: this.seq,
      response: {
        id: this.responseId, object: "response", status: "completed",
        model: this.model, created_at: this.startedAt,
        output: [{
          id: `msg_${this.responseId}`, type: "message", role: "assistant", status: "completed",
          content: [{ type: "output_text", text: "", annotations: [] }],
        }],
        usage: usage
          ? { input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens, total_tokens: usage.total_tokens }
          : undefined,
      },
    });
  }

  toolCall(index: number, toolCall: NonNullable<NormalizedChunk["tool_calls"]>[number]): string {
    const id = toolCall.id ?? `call_${this.responseId}_${index}`;
    const name = toolCall.function?.name ?? "";
    const args = toolCall.function?.arguments ?? "";
    this.seq++;
    return sse("response.output_item.added", {
      type: "response.output_item.added",
      sequence_number: this.seq,
      output_index: index,
      item: {
        id: `fc_${id}`,
        type: "function_call",
        status: "in_progress",
        call_id: id,
        name,
        arguments: args,
      },
    });
  }
}

// Drive the streaming bridge off the adapter's normalized chunks.
// Emits the full event set Codex consumes: every output item gets an
// `output_item.added` AND `output_item.done` — Codex reads the final tool
// arguments / message text from `output_item.done`, and a stream that skips
// it leaves the client waiting on a tool call forever.
export async function writeBridgeStream(
  res: import("http").ServerResponse,
  chunks: AsyncIterable<NormalizedChunk>,
  model: string,
): Promise<{ usage?: NormalizedChunk["usage"]; failed?: boolean }> {
  const w = new ResponsesSseWriter(model);
  res.write(w.created());
  let usage: NormalizedChunk["usage"];
  let nextToolIndex = 0;
  // Text deltas are folded into one message item (id tracked so added/done match).
  let textOpened = false;
  let textClosed = false;
  let failed = false;
  try {
    for await (const c of chunks) {
      if (c.delta && !textClosed) {
        if (!textOpened) {
          res.write(w.messageItemAdded(nextToolIndex));
          textOpened = true;
        }
        res.write(w.delta(c.delta));
      }
      if (Array.isArray(c.tool_calls)) {
        for (const toolCall of c.tool_calls) {
          if (toolCall.function?.name) {
            const index = nextToolIndex++;
            if (textOpened && !textClosed) {
              res.write(w.messageItemDone(nextToolIndex - 1));
              textClosed = true;
            }
            res.write(w.toolCall(index, toolCall));
            res.write(w.toolCallDone(index, toolCall));
          }
        }
      }
      if (c.usage) usage = c.usage;
    }
  } catch (err) {
    // Mid-stream upstream failure: tell the client explicitly. Silently
    // ending the connection leaves Codex to guess, then replay the turn.
    failed = true;
    res.write(w.failed(String(err instanceof Error ? err.message : err)));
  }
  if (!failed) {
    if (textOpened && !textClosed) res.write(w.messageItemDone(nextToolIndex - 1));
    res.write(w.completed(usage));
  }
  // `failed` lets the gateway record the call as an error instead of "ok" —
  // a turn that broke mid-stream must be visible in the panel.
  return { usage, failed };
}

export function adapterSupportsNativeResponses(provider: Provider, adapter: ProviderAdapter): boolean {
  // zhipu has no /responses surface upstream; everything else routes through
  // buildProtocolUrl / default /v1/responses paths.
  return provider.type !== "zhipu" || typeof adapter.buildProtocolUrl !== "function";
}
