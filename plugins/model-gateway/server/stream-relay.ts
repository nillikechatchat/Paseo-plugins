// Shared streaming relay plumbing for every SSE path (chat completions,
// /v1/responses, /v1/messages and both bridges).
//
// Two rules drive the design, both mirroring gatewayd's failover loops:
//
//   1. Nothing may reach the client before the upstream has actually
//      produced a byte. Holding the client response headers back until that
//      first byte is what makes "switch provider on a broken upstream"
//      possible: a candidate that answers 200 and then dies, hangs or closes
//      with an empty stream leaves no trace on the client, so the next
//      candidate takes over invisibly. Once the first byte is out the
//      response is committed — no router can transparently restart a stream
//      the agent has already started reading.
//   2. A committed stream that never terminates is worse than one that ends
//      loudly. A truncated upstream used to leave the client with half an
//      answer and no terminal event, so the agent waited on (or replayed) a
//      stream that would never finish. The gateway now appends the
//      protocol's terminal events plus an explicit error frame, and records
//      the call as an error so the panel shows it.

import type * as http from "node:http";

/** Which protocol the relayed bytes speak — decides the terminal events. */
export type StreamSurface = "chat" | "responses" | "messages";

/** Strip the trailing newline(s) an SSE event buffer accumulates so the
 *  caller can append exactly one blank-line separator. */
export function trimSseEvent(evtText: string): string {
  return evtText.replace(/\n+$/, "");
}

export interface StreamState {
  readonly startedAt: number;
  /** Anything written to the client yet (headers or bytes). */
  committed: boolean;
  ttfbMs: number;
  bytesOut: number;
  /** A protocol terminal event was observed on the upstream stream. */
  completed: boolean;
}

/** Result of relaying one candidate's stream. */
export interface StreamRelayResult {
  /** false when nothing reached the client, so the candidate is retryable. */
  committed: boolean;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  ttfbMs: number;
  bytesOut: number;
  /** true when the stream ended without its terminal event. */
  truncated: boolean;
  error?: string;
}

export function isAbortError(err: unknown): boolean {
  const e = err as { name?: string; message?: string } | null | undefined;
  if (!e) return false;
  if (e.name === "AbortError") return true;
  return /abort/i.test(e.message ?? "");
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Append the terminal events for a committed-but-truncated stream so the
 *  agent's SSE parser terminates instead of waiting on a stream that will
 *  never finish. */
export function truncatedTail(surface: StreamSurface, message: string, openBlocks: number[] = []): string {
  if (surface === "messages") {
    let out = "";
    for (const idx of openBlocks) {
      out += `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: idx })}\n\n`;
    }
    out += `event: message_delta\ndata: ${JSON.stringify({
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
    })}\n\n`;
    out += `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`;
    return out + `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message } })}\n\n`;
  }
  return `data: ${JSON.stringify({ error: { message } })}\n\n` + "data: [DONE]\n\n";
}

/**
 * Pulls an upstream response body while deferring the client response
 * headers until the first byte arrives (see the module comment).
 *
 * Typical use:
 *   const pump = new UpstreamPump(upstreamRes, startedAt, () => res.writeHead(...));
 *   if (!await pump.prime()) return { committed: false };   // retry next candidate
 *   for await (const { text } of pump.chunks()) { ... }
 */
export class UpstreamPump {
  readonly state: StreamState;
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private readonly commit: () => void;
  private buffered: ReadableStreamReadResult<Uint8Array> | null = null;

  constructor(response: Response, startedAt: number, commit: () => void) {
    const body = response.body;
    if (!body) throw new Error("upstream response has no body");
    this.state = { startedAt, committed: false, ttfbMs: 0, bytesOut: 0, completed: false };
    this.reader = body.getReader();
    this.commit = commit;
  }

  /** Read up to the first body byte, then write the client headers.
   *  Returns false when the upstream produced nothing or failed first:
   *  the caller may then retry with another candidate. Aborts (the client
   *  went away) are rethrown — they are never retryable. */
  async prime(): Promise<boolean> {
    if (this.state.committed) return true;
    let read: ReadableStreamReadResult<Uint8Array>;
    try {
      read = await this.reader.read();
    } catch (err) {
      if (isAbortError(err)) throw err;
      return false;
    }
    if (read.done || !read.value || read.value.byteLength === 0) return false;
    this.state.ttfbMs = Date.now() - this.state.startedAt;
    this.buffered = read;
    this.state.committed = true;
    this.commit();
    return true;
  }

  /** Decoded chunks. A `{ stream: true }` decoder keeps a multi-byte UTF-8
   *  sequence split across two network chunks pending instead of emitting
   *  U+FFFD. */
  async *chunks(): AsyncGenerator<{ raw: Uint8Array; text: string }> {
    let first = this.buffered;
    this.buffered = null;
    while (true) {
      let read: ReadableStreamReadResult<Uint8Array> | null = first ?? null;
      first = null;
      if (!read) {
        read = await this.reader.read();
        if (!this.state.committed) {
          // Defensive: chunks() used without prime(). Commit now so the
          // client still gets a status line.
          this.state.ttfbMs = Date.now() - this.state.startedAt;
          this.state.committed = true;
          this.commit();
        }
      }
      if (read.done) return;
      const value = read.value;
      if (!value || value.byteLength === 0) continue;
      this.state.bytesOut += value.byteLength;
      yield { raw: value, text: this.decoder.decode(value, { stream: true }) };
    }
  }
}

/** Best-effort write: the client socket may already be gone. */
export function safeWrite(res: http.ServerResponse, chunk: string | Uint8Array): void {
  if (res.destroyed || res.writableEnded) return;
  try {
    res.write(chunk);
  } catch { /* socket closed mid-write */ }
}

/** Best-effort end: the client socket may already be gone. */
export function safeEnd(res: http.ServerResponse): void {
  if (res.destroyed || res.writableEnded) return;
  try {
    res.end();
  } catch { /* socket closed */ }
}
