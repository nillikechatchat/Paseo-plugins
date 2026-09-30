// Unit tests for the per-model parameter registry. These are the values the
// gateway uses to configure a call *before* spending an upstream round-trip
// on it: the context pre-check, the Responses max_output_tokens ceiling and
// the generated agent config files.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  contextWindowFor,
  familyOf,
  maxOutputTokensFor,
  modelParamsFor,
  normalizeModelId,
  knownModelIds,
} from "./model-params";
import type { Provider } from "./storage";

function provider(patch: Partial<Provider> = {}): Provider {
  return {
    id: "p",
    name: "p",
    type: "openai-compatible",
    baseUrl: "http://x",
    apiKey: "k",
    models: [],
    enabled: true,
    ...patch,
  } as unknown as Provider;
}

test("normalizeModelId lowercases and strips a vendor prefix", () => {
  assert.equal(normalizeModelId("Zhipu/GLM-5.2"), "glm-5.2");
  assert.equal(normalizeModelId("openai/gpt-5"), "gpt-5");
  assert.equal(normalizeModelId("  GLM-4.6  "), "glm-4.6");
  assert.equal(normalizeModelId("claude-sonnet-4-5"), "claude-sonnet-4-5");
});

test("modelParamsFor resolves exact ids and aliases", () => {
  assert.equal(modelParamsFor("glm-5.2")?.contextWindow, 200000);
  assert.equal(modelParamsFor("glm-5.3-flashx")?.contextWindow, 200000);
  assert.equal(modelParamsFor("glm-5.3-flashx")?.maxOutputTokens, 16384);
  assert.equal(modelParamsFor("deepseek-r1")?.family, "deepseek");
  assert.equal(modelParamsFor("kimi-k2.6")?.family, "kimi");
});

test("modelParamsFor strips trailing -segments, longest match first", () => {
  // datestamped snapshot of the flash tier
  assert.equal(modelParamsFor("deepseek-v4-flash-0731")?.maxOutputTokens, 8192);
  // a real variant must not degrade into a sibling: the flash tier is fast,
  // the pro tier is not, and both share the 128K window.
  assert.equal(modelParamsFor("deepseek-v4-pro")?.contextWindow, 128000);
  assert.equal(modelParamsFor("deepseek-v4-pro")?.caps.fast, false);
  assert.equal(modelParamsFor("deepseek-v4-flash")?.caps.fast, true);
});

test("modelParamsFor returns undefined for unknown or non-chat models", () => {
  assert.equal(modelParamsFor("senseaudio-asr-pro-1.5-260319"), undefined);
  assert.equal(modelParamsFor("totally-made-up-model"), undefined);
  assert.equal(modelParamsFor(""), undefined);
  assert.equal(modelParamsFor("   "), undefined);
});

test("contextWindowFor takes the wider of the provider record and the registry", () => {
  // a record that declares nothing still inherits the registry value
  assert.equal(contextWindowFor(provider(), "glm-5.2"), 200000);
  assert.equal(contextWindowFor(undefined, "glm-5.2"), 200000);
  // a blanket default that understates this model must not fabricate a 413:
  // `glm` declares 128k for every model while glm-5.2 really serves 200k.
  assert.equal(contextWindowFor(provider({ contextWindow: 64000 }), "glm-5.2"), 200000);
  // a record that is *wider* than the card (step declares 1M for 200k models)
  // keeps its value — only the upstream can be the authority on the limit.
  assert.equal(contextWindowFor(provider({ contextWindow: 1000000 }), "step-5-preview"), 1000000);
  // a negative / zero record is ignored rather than trusted
  assert.equal(contextWindowFor(provider({ contextWindow: 0 }), "glm-5.2"), 200000);
  assert.equal(contextWindowFor(provider({ contextWindow: -1 }), "glm-5.2"), 200000);
  // neither source knows anything about the model
  assert.equal(contextWindowFor(provider(), "who-knows"), undefined);
  assert.equal(contextWindowFor(undefined, "who-knows"), undefined);
  // vendor prefix in the request body still resolves
  assert.equal(contextWindowFor(undefined, "zhipu/glm-5.2"), 200000);
});

test("maxOutputTokensFor takes the smaller of record and registry", () => {
  // registry only
  assert.equal(maxOutputTokensFor(undefined, "glm-5.2"), 32768);
  // record only (unknown model)
  assert.equal(maxOutputTokensFor(provider({ maxOutputTokens: 8192 }), "who-knows"), 8192);
  // both known: the smaller wins — an oversized value is rejected outright
  // by strict upstreams, a small one merely truncates.
  assert.equal(maxOutputTokensFor(provider({ maxOutputTokens: 4096 }), "glm-5.2"), 4096);
  assert.equal(maxOutputTokensFor(provider({ maxOutputTokens: 60000 }), "glm-5.2"), 32768);
  assert.equal(maxOutputTokensFor(provider({ maxOutputTokens: 0 }), "glm-5.2"), 32768);
  assert.equal(maxOutputTokensFor(provider(), "who-knows"), undefined);
});

test("familyOf falls back to the model id itself for unknown models", () => {
  assert.equal(familyOf("zhipu/GLM-5.2"), "glm");
  assert.equal(familyOf("GLM-5.2"), "glm");
  assert.equal(familyOf("claude-sonnet-4-5"), "claude");
  assert.equal(familyOf("somevendor-model-x"), "somevendor");
});

test("caps drive the generated agent config" /* smoke */, () => {
  const glm = modelParamsFor("glm-5.2");
  assert.ok(glm);
  assert.equal(glm.caps.strongReasoning, true);
  assert.equal(glm.caps.strongCode, true);
  assert.equal(glm.caps.vision, false);
  const flash = modelParamsFor("glm-5.3-flash");
  assert.ok(flash);
  assert.equal(flash.caps.fast, true);
  const gemini = modelParamsFor("gemini-3-pro");
  assert.ok(gemini);
  assert.equal(gemini.caps.vision, true);
});

test("knownModelIds covers the vendors the gateway actually routes to", () => {
  const ids = new Set(knownModelIds());
  for (const id of ["glm-5.2", "deepseek-chat", "kimi-k2", "claude-sonnet-4-5", "gemini-2.5-pro", "gpt-5", "minimax-m2"]) {
    assert.ok(ids.has(id), `missing ${id}`);
  }
  // aliases are not registered as their own entries
  assert.equal(ids.has("deepseek-r1"), false);
});
