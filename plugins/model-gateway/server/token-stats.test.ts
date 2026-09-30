// Unit tests for the cost estimator's honesty contract: a model with no
// configured price must read as "unknown" (null), never as ¥0 — the panel
// used to show unpriced models as free AND invent a grey "potential cost"
// segment scaled off the priced total.

import { test } from "node:test";
import assert from "node:assert/strict";

import { estimateCost } from "./token-stats";

const PRICING = {
  "glm-5.2": { inputPerMTokCNY: 2.0, outputPerMTokCNY: 8.0, cachedInputPerMTokCNY: 0.4 },
  "local-q4": { inputPerMTokCNY: 0, outputPerMTokCNY: 0, isLocal: true },
} as Parameters<typeof estimateCost>[4];

test("estimateCost computes the priced cost", () => {
  // 1M in @¥2 + 1M out @¥8 = ¥10
  assert.equal(estimateCost("glm-5.2", 1_000_000, 1_000_000, 0, PRICING), 10);
  // cached input bills at the cached rate: 1M cached @¥0.4
  assert.equal(estimateCost("glm-5.2", 0, 0, 1_000_000, PRICING), 0.4);
});

test("estimateCost returns null for unpriced models (unknown, not free)", () => {
  assert.equal(estimateCost("step-5-preview", 1_000_000, 1_000_000, 0, PRICING), null);
  assert.equal(estimateCost("kimi-k3", 500, 200, 0, PRICING), null);
});

test("estimateCost honors the wildcard fallback", () => {
  const withWildcard = { ...PRICING, "*": { inputPerMTokCNY: 1.0, outputPerMTokCNY: 2.0 } };
  assert.equal(estimateCost("never-seen-model", 1_000_000, 1_000_000, 0, withWildcard), 3);
});

test("local models are the one deliberate zero", () => {
  assert.equal(estimateCost("local-q4", 1_000_000, 1_000_000, 0, PRICING), 0);
});
