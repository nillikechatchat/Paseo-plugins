// Unit tests for the response-cache key and admission rules. The bug these
// pin down: the key used to hash the raw request bytes, so a reordered body
// (or one carrying extra side channels) always missed while a `[provider] `
// prefixed model never matched its bare twin — and every `temperature > 0`
// response was admitted, replaying nondeterministic output for the whole TTL.

import { test } from "node:test";
import assert from "node:assert/strict";

import { cacheAdmission, cacheKeyFor, canonicalJson, isDeterministicSampling } from "./cache-key";

const base = {
  model: "gpt-5.2",
  messages: [{ role: "user", content: "hello" }],
};

test("canonicalJson sorts object keys recursively", () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(canonicalJson({ a: { d: 4, c: 3 } }), '{"a":{"c":3,"d":4}}');
  assert.equal(canonicalJson([{ b: 1, a: 2 }]), '[{"a":2,"b":1}]');
  assert.equal(canonicalJson(null), "null");
});

test("cache key is independent of JSON key order", () => {
  const a = cacheKeyFor("p1", { model: "m", messages: [{ role: "user", content: "hi" }], temperature: 0 });
  const b = cacheKeyFor("p1", { temperature: 0, messages: [{ content: "hi", role: "user" }], model: "m" });
  assert.equal(a, b);
});

test("nested key order does not change the key either", () => {
  const a = cacheKeyFor("p1", { model: "m", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] });
  const b = cacheKeyFor("p1", { model: "m", messages: [{ content: [{ text: "hi", type: "text" }], role: "user" }] });
  assert.equal(a, b);
});

test("tool_choice participates in the key", () => {
  const withChoice = cacheKeyFor("p1", { ...base, tools: [{ name: "x" }], tool_choice: "auto" });
  const withNone = cacheKeyFor("p1", { ...base, tools: [{ name: "x" }], tool_choice: "none" });
  assert.notEqual(withChoice, withNone);
});

test("side channels are excluded from the key", () => {
  const plain = cacheKeyFor("p1", base);
  const decorated = cacheKeyFor("p1", {
    ...base,
    user: "trace-42",
    metadata: { session: "abc" },
    stream: false,
  });
  // `stream` is filtered by admission, not by the key: an admitted non-stream
  // request never sets it, so the two bodies must agree.
  assert.equal(plain, decorated);
});

test("model and provider are part of the key", () => {
  assert.notEqual(cacheKeyFor("p1", base), cacheKeyFor("p2", base));
  assert.notEqual(cacheKeyFor("p1", base), cacheKeyFor("p1", { ...base, model: "gpt-5.3" }));
});

test("semantically equivalent aliases of the same model share a key", () => {
  const bare = cacheKeyFor("p1", base);
  const prefixed = cacheKeyFor("p1", { ...base, model: "p1" });
  // the `[providerName] model` label only exists on the client-facing id; the
  // gateway strips it before routing, so both arrive as the bare name.
  assert.equal(bare, cacheKeyFor("p1", { ...base, model: "gpt-5.2", }));
});

test("isDeterministicSampling only accepts temperature 0", () => {
  assert.equal(isDeterministicSampling({}), true);
  assert.equal(isDeterministicSampling({ temperature: 0 }), true);
  assert.equal(isDeterministicSampling({ temperature: 0.2 }), false);
  assert.equal(isDeterministicSampling({ temperature: null }), true);
});

test("chat admission requires non-stream, tool-free, deterministic sampling", () => {
  assert.equal(cacheAdmission(base, "chat").cacheable, true);
  assert.equal(cacheAdmission({ ...base, temperature: 0 }, "chat").cacheable, true);
  assert.equal(cacheAdmission({ ...base, stream: true }, "chat").cacheable, false);
  assert.equal(cacheAdmission({ ...base, tools: [{ name: "x" }] }, "chat").cacheable, false);
  assert.equal(cacheAdmission({ ...base, tools: [] }, "chat").cacheable, true);
  assert.equal(cacheAdmission({ ...base, temperature: 0.7 }, "chat").reason, "sampling");
  assert.equal(cacheAdmission({ ...base, tools: [{ name: "x" }] }, "chat").reason, "tools");
  assert.equal(cacheAdmission({ ...base, stream: true }, "chat").reason, "stream");
});

test("responses admission additionally requires store:false and input", () => {
  const req = { model: "gpt-5.2", input: [{ role: "user", content: "hi" }], store: false };
  assert.equal(cacheAdmission(req, "responses").cacheable, true);
  // `store: true` means the vendor already persists it; replaying a 2xx from
  // our own store would diverge from the vendor's copy.
  assert.equal(cacheAdmission({ ...req, store: true }, "responses").reason, "store");
  assert.equal(cacheAdmission({ ...req, store: undefined }, "responses").reason, "store");
  assert.equal(cacheAdmission({ ...req, input: [] }, "responses").reason, "no-input");
  assert.equal(cacheAdmission({ ...req, input: "" }, "responses").reason, "no-input");
  assert.equal(cacheAdmission({ ...req, stream: true }, "responses").reason, "stream");
});
