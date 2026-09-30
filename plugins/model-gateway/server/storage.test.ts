import assert from "node:assert/strict";
import { test } from "node:test";

import { percentile } from "./storage";

test("percentile: interpolates between ranks (numpy type-7)", () => {
  assert.equal(percentile([], 0.95), 0);
  assert.equal(percentile([7], 0.95), 7);
  assert.equal(percentile([100, 200, 300], 0.95), 290);
  assert.equal(percentile([100, 200, 300], 0.5), 200);
  assert.equal(percentile([50, 100, 200, 300, 500], 0.5), 200);
  assert.equal(percentile([50, 100, 200, 300, 500], 0.95), 460);
});

test("percentile: p95 never collapses to the minimum on small windows", () => {
  // The old floor(n * p) index returned the minimum for 2 samples, which made
  // the panel report p95 == p0 right after a gateway restart.
  const two = [10, 500];
  assert.equal(percentile(two, 0.95), 475.5);
  assert.ok(percentile(two, 0.5) === 255);
});

test("percentile: p0/p1 are exact and input order is irrelevant", () => {
  assert.equal(percentile([300, 100, 200], 0), 100);
  assert.equal(percentile([300, 100, 200], 1), 300);
  assert.equal(percentile([1, 2, 3, 4], 1), 4);
});
