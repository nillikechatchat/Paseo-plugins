// Unit tests for the upstream error classifier shared by every gateway path.
// The golden table at the bottom is the TS half of the "same body, same
// verdict" contract with gatewayd's `protocol/routing.mbt` — when a classifier
// there changes, change it here too.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isAuthError,
  isBillingError,
  isContextOverflow,
  isFailover4xx,
  isInvalidInferenceError,
  isModelUnavailableError,
  isPersistent4xx,
  upstreamErrorMessage,
} from "./upstream-errors";

test("401 is always an auth failure regardless of body", () => {
  assert.equal(isAuthError(401, ""), true);
  assert.equal(isAuthError(401, "whatever the vendor said"), true);
  assert.equal(isAuthError(401, "token quota exceeded"), true);
});

test("403 is an auth failure only with auth phrasing", () => {
  assert.equal(isAuthError(403, '{"error":{"message":"身份验证失败"}}'), true);
  assert.equal(isAuthError(403, "invalid api key"), true);
  assert.equal(isAuthError(403, "Incorrect API key provided"), true);
  assert.equal(isAuthError(403, '{"error":{"code":"invalid_api_key"}}'), true);
  assert.equal(isAuthError(403, "Authentication failed"), true);
  assert.equal(isAuthError(403, "not available in the current token plan"), false);
  assert.equal(isAuthError(403, "forbidden for this account"), false);
  assert.equal(isAuthError(400, "invalid api key"), false);
});

test("billing failures cover frozen accounts and drained credits", () => {
  assert.equal(isBillingError(402, "余额不足"), true);
  assert.equal(isBillingError(400, '{"ref_code":400901}'), true);
  assert.equal(isBillingError(400, "account is frozen"), true);
  assert.equal(isBillingError(429, "quota exhausted"), true);
  assert.equal(isBillingError(500, "out of credits"), false);
  assert.equal(isBillingError(200, "余额不足"), false);
});

test("model-unavailable covers 404/403/400 phrasings", () => {
  assert.equal(isModelUnavailableError(404, "model not found"), true);
  assert.equal(isModelUnavailableError(400, "unknown model"), true);
  assert.equal(isModelUnavailableError(403, "not available in the current token plan"), true);
  assert.equal(isModelUnavailableError(400, '{"error":{"code":400033}}'), true);
  assert.equal(isModelUnavailableError(400, "模型未找到"), true);
  assert.equal(isModelUnavailableError(400, "模型不存在"), true);
  assert.equal(isModelUnavailableError(500, "model not found"), false);
  assert.equal(isModelUnavailableError(400, "temperature out of range"), false);
});

test("invalid-inference is a provider-specific retryable 400", () => {
  assert.equal(isInvalidInferenceError(400, "Inference request is invalid"), true);
  assert.equal(isInvalidInferenceError(400, "invalid inference request"), true);
  assert.equal(isInvalidInferenceError(500, "inference request is invalid"), false);
  // 429 matches (the predicate only bounds to 4xx) — harmless, because the
  // failover runner resolves 429 before consulting is_failover_4xx. Mirrors
  // gatewayd's is_invalid_inference_error, which has the same bound.
  assert.equal(isInvalidInferenceError(429, "inference request is invalid"), true);
  assert.equal(isInvalidInferenceError(400, "context length exceeded"), false);
});

test("isFailover4xx is the union and persists the non-recoverable three", () => {
  const failover = [
    [401, "Unauthorized"],
    [403, "invalid api key"],
    [402, "余额不足"],
    [404, "model not found"],
    [400, "inference request is invalid"],
  ] as const;
  for (const [status, body] of failover) assert.equal(isFailover4xx(status, body), true, `${status} ${body}`);

  const commit = [
    [400, "temperature out of range"],
    [404, "no such route"],
    [422, "unprocessable"],
  ] as const;
  for (const [status, body] of commit) assert.equal(isFailover4xx(status, body), false, `${status} ${body}`);

  for (const [status, body] of [[401, "Unauthorized"], [402, "余额不足"], [404, "model not found"]] as const) {
    assert.equal(isPersistent4xx(status, body), true, `${status} ${body}`);
  }
  assert.equal(isPersistent4xx(400, "inference request is invalid"), false);
});

test("context overflow matches vendor phrasings and normalises max_tokens", () => {
  assert.equal(isContextOverflow(400, "context length exceeded"), true);
  assert.equal(isContextOverflow(400, "This model's maximum context length is 128000 tokens"), true);
  assert.equal(isContextOverflow(413, "prompt is too long: 200000 tokens"), true);
  assert.equal(isContextOverflow(400, "input length exceeds the supported size"), true);
  assert.equal(isContextOverflow(400, "max_tokens is too long for this model"), true);
  assert.equal(isContextOverflow(200, "context length exceeded"), false);
  assert.equal(isContextOverflow(400, "max_tokens must be a positive integer"), false);
  assert.equal(isContextOverflow(400, ""), false);
});

test("upstreamErrorMessage prefers the vendor's own message", () => {
  assert.equal(
    upstreamErrorMessage(400, '{"error":{"message":"model does not exist"}}', "OpenAI"),
    "model does not exist",
  );
  assert.equal(upstreamErrorMessage(400, '{"message":"top-level message"}', "OpenAI"), "top-level message");
  assert.equal(upstreamErrorMessage(502, "<html>bad gateway</html>", "OpenAI"), "<html>bad gateway</html>");
});

test("upstreamErrorMessage synthesises a description for empty bodies", () => {
  // Some vendors answer 429 with no payload at all; the old code forwarded
  // the empty string and agents showed a blank error.
  const msg = upstreamErrorMessage(429, "", "OpenAI");
  assert.match(msg, /OpenAI/);
  assert.match(msg, /429/);
  assert.match(msg, /body/);
  assert.equal(upstreamErrorMessage(400, "   ", "Anthropic").length > 0, true);
});

test("upstreamErrorMessage keeps a non-JSON body verbatim", () => {
  assert.equal(upstreamErrorMessage(500, "upstream connect error", "x"), "upstream connect error");
});

// Golden table — the TS half of the cross-language contract with gatewayd's
// `src/protocol/routing_test.mbt` ("parity golden table"). Keep the rows
// byte-identical on both sides: the dormant in-process gateway and the native
// data plane must roll to the next candidate for exactly the same failures.
const GOLDEN: ReadonlyArray<readonly [number, string, boolean, boolean]> = [
  [401, "", true, true],
  [401, "Unauthorized", true, true],
  [403, "invalid api key", true, true],
  [403, "<html>Attention Required! | Cloudflare</html>", false, false],
  [400, "计费账户已被冻结", true, true],
  [402, "余额不足", true, true],
  [429, "quota exhausted", true, true],
  [404, "model not found: glm-9.9", true, true],
  [403, "model is not available in the current token plan", true, true],
  [400, '{"code":"invalid","message":"模型未找到","ref_code":400033}', true, true],
  [400, "inference request is invalid", true, false],
  [400, "temperature out of range", false, false],
  [400, "context length exceeded", false, false],
  [422, "unprocessable", false, false],
  [500, "out of credits", false, false],
];

test("parity golden table matches gatewayd verdicts", () => {
  for (const [status, body, failover, persistent] of GOLDEN) {
    assert.equal(isFailover4xx(status, body), failover, `failover ${status} ${body}`);
    assert.equal(isPersistent4xx(status, body), persistent, `persistent ${status} ${body}`);
  }
});
