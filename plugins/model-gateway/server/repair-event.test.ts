// Unit tests for the SSE event repair used by the /v1/messages passthrough.
// Two upstream quirks motivated it: vendors that omit the blank-line
// separator between events (which used to swallow every event after the
// first) and vendors that open a content block without ever sending
// `content_block_start` (which used to break the client's parser and leave
// the block unclosable on a truncated stream).

import { test } from "node:test";
import assert from "node:assert/strict";

import { repairEvent } from "./gateway";
import { trimSseEvent } from "./stream-relay";

/** Split a repaired stream into events the way an SSE parser does. */
function events(repaired: string): Array<Record<string, unknown>> {
  return repaired
    .split("\n\n")
    .filter((b) => b.trim().length > 0)
    .map((block) => {
      const data = block.split("\n").find((l) => l.startsWith("data:"));
      return data ? (JSON.parse(data.slice(5)) as Record<string, unknown>) : {};
    });
}

test("glued-together events are split and re-separated", () => {
  // A buffer that arrived with the blank-line separators dropped (every
  // event is still `event:` + `data:`, just with no blank line between).
  // Parsed as one event that batch loses everything after the first frame.
  const out = repairEvent(
    [
      'event: message_start\ndata: {"type":"message_start"}',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}',
    ].join("\n"),
    "p",
    new Set(),
  );
  // exactly one blank line per event, no doubled separators
  assert.equal(out.split("\n\n").filter((b) => b.trim()).length, 3);
  assert.equal(out.endsWith("\n\n"), true);
  assert.equal(/\n{3,}/.test(out), false);
  assert.deepEqual(events(out).map((e) => e.type), [
    "message_start",
    "content_block_start",
    "content_block_delta",
  ]);
  // the split survives a re-parse: no glued data: lines
  for (const block of out.split("\n\n").filter((b) => b.trim())) {
    assert.equal(block.split("\n").filter((l) => l.startsWith("data:")).length, 1, block);
  }
});

test("a pass-through event is forwarded verbatim", () => {
  const evt = "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}";
  const blocks = new Set<number>();
  assert.equal(repairEvent(evt, "p", blocks), trimSseEvent(evt) + "\n\n");
  assert.deepEqual([...blocks], [0]);
});

test("a synthetic content_block_start is injected for an orphan delta", () => {
  const blocks = new Set<number>();
  const out = repairEvent("event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"hi\"}}", "p", blocks);
  assert.equal(out.startsWith("event: content_block_start\n"), true);
  const evts = events(out);
  assert.equal(evts.length, 2);
  assert.equal(evts[0].type, "content_block_start");
  assert.equal(evts[1].type, "content_block_delta");
  assert.deepEqual(evts[0].content_block, { type: "text", text: "" });
  assert.deepEqual([...blocks], [0]);
});

test("the injected block type follows the delta type", () => {
  const tool = repairEvent(
    "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":2,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"a\\\":1}\"}}",
    "p",
    new Set(),
  );
  assert.deepEqual(events(tool)[0].content_block, { type: "tool_use", id: "toolu_repair_2", name: "", input: {} });

  const thinking = repairEvent(
    "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"...\"}}",
    "p",
    new Set(),
  );
  assert.deepEqual(events(thinking)[0].content_block, { type: "thinking", thinking: "" });
});

test("an open block is closed and forgotten on content_block_stop", () => {
  const blocks = new Set([0, 1]);
  repairEvent("event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}", "p", blocks);
  assert.deepEqual([...blocks], [1]);
});

test("a stop for a block that was never opened passes through", () => {
  const blocks = new Set<number>();
  const out = repairEvent("event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":5}", "p", blocks);
  assert.deepEqual(events(out).map((e) => e.type), ["content_block_stop"]);
  // no phantom block is left open, so truncatedTail() closes nothing extra
  assert.deepEqual([...blocks], []);
});

test("non-messages payloads and unparseable frames pass through untouched", () => {
  for (const evt of [
    "data: [DONE]",
    "event: response.completed\ndata: {\"type\":\"response.completed\"}",
    "event: ping\ndata: {}",
    "event: message_delta\ndata: not json at all",
    "event: comment\n: keep-alive",
  ]) {
    assert.equal(repairEvent(evt, "p", new Set()), trimSseEvent(evt) + "\n\n", evt);
  }
  // a frame with no data: line at all is still terminated
  assert.equal(repairEvent("event: ping", "p", new Set()), "event: ping\n\n");
});
