// Unit tests for the pure routing helpers: the embeddings candidate pick
// (which used to route every /v1/embeddings call to whichever provider
// happened to fall out of the chat picker) and the `embed` bucket fallback.

import { test } from "node:test";
import assert from "node:assert/strict";

import { embeddingModelOf, pickProviderCandidates, resolveAutoChain } from "./routing";
import type { Provider } from "./storage";

function provider(id: string, models: string[], extra: Partial<Provider> = {}): Provider {
  return {
    id,
    name: id,
    type: "openai-compatible",
    baseUrl: "https://api.example.com/v1",
    apiKey: "key",
    models,
    priority: 10,
    weight: 1,
    enabled: true,
    createdAt: 0,
    ...extra,
  } as unknown as Provider;
}

test("embeddingModelOf reads the requested embedding model", () => {
  assert.equal(embeddingModelOf('{"model":"text-embedding-3-small","input":["hi"]}'), "text-embedding-3-small");
  assert.equal(embeddingModelOf('{"model":"bge-m3"}'), "bge-m3");
});

test("embeddingModelOf falls back to the generic embed bucket", () => {
  assert.equal(embeddingModelOf('{"input":["hi"]}'), "embed");
  assert.equal(embeddingModelOf('{"model":""}'), "embed");
  assert.equal(embeddingModelOf('{"model":123}'), "embed");
  assert.equal(embeddingModelOf("not json at all"), "embed");
  assert.equal(embeddingModelOf(""), "embed");
  assert.equal(embeddingModelOf(undefined), "embed");
  assert.equal(embeddingModelOf("[1,2,3]"), "embed");
});

test("embeddings route to the provider that claims the embedding model", () => {
  const text = provider("text-only", ["glm-5.2", "kimi-k3"], { priority: 1 });
  const embed = provider("embedder", ["text-embedding-3-small", "bge-m3"], { priority: 50 });
  const wildcard = provider("anything", [], { priority: 90 });

  const candidates = pickProviderCandidates({ model: "text-embedding-3-small", providers: [text, embed, wildcard] });
  assert.deepEqual(
    candidates.map((c) => c.provider.id),
    ["embedder", "anything"],
  );
  assert.equal(candidates.every((c) => c.reason === "model-match"), true);
});

test("embeddings on an unknown model still avoid text-only providers", () => {
  const text = provider("text-only", ["glm-5.2"], { priority: 1 });
  const wildcard = provider("anything", [], { priority: 90 });
  const candidates = pickProviderCandidates({ model: "embed", providers: [text, wildcard] });
  assert.deepEqual(
    candidates.map((c) => c.provider.id),
    ["anything"],
  );
});

test("disabled providers never serve embeddings", () => {
  const embed = provider("embedder", ["bge-m3"], { priority: 50, enabled: false });
  const wildcard = provider("anything", [], { priority: 90 });
  assert.deepEqual(pickProviderCandidates({ model: "bge-m3", providers: [embed, wildcard] }).map((c) => c.provider.id), ["anything"]);
});

test("auto chain stays a singleton for concrete models", () => {
  const providers = [provider("p", ["glm-5.2"]), provider("q", ["kimi-k3"])];
  assert.deepEqual(resolveAutoChain("text-embedding-3-small", "chat", providers), ["text-embedding-3-small"]);
});
