// Upstream error classification and message normalisation, shared by every
// failover loop (chat / responses / messages / bridges / embeddings).
//
// Mirrors gatewayd's `protocol/routing.mbt` predicates one-for-one so the
// dormant in-process gateway and the native data plane classify the same
// upstream body identically. Divergence here is what used to make a dead
// API key surface as a raw 401 to the agent instead of a failover.

/** Failures that will not recover within the transient cooldown window:
 *  billing/frozen account, model not offered, dead credential. */
export function isPersistentFailure(status: number, body: string): boolean {
  return isBillingError(status, body) || isModelUnavailableError(status, body) || isAuthError(status, body);
}

/**
 * Upstream billing failure (frozen/unpaid account): 4xx bodies pointing at
 * the vendor's billing state rather than the request itself. Failover to
 * the next candidate is the right reaction (mirrors gatewayd's
 * protocol.is_billing_error).
 */
export function isBillingError(status: number, body: string): boolean {
  if (status < 400 || status >= 500) return false;
  const low = body.toLowerCase();
  return (
    low.includes('"ref_code":400901') ||
    low.includes('"code":"billing"') ||
    low.includes("计费账户已被冻结") ||
    low.includes("账户已被冻结") ||
    low.includes("余额不足") ||
    low.includes("account is frozen") ||
    low.includes("billing is frozen") ||
    low.includes("billing_error") ||
    low.includes("out of credits") ||
    low.includes("quota exhausted")
  );
}

/**
 * Upstream "this provider can't serve the requested model" (403 token-plan
 * restriction, 404 unknown model, …): roll to the next candidate that may
 * have it — same as billing/429 failover. Mirrors gatewayd's
 * protocol.is_model_unavailable_error.
 */
export function isModelUnavailableError(status: number, body: string): boolean {
  if (status < 400 || status >= 500) return false;
  const low = body.toLowerCase();
  const needles = [
    "not available in the current token plan",
    "unknown model",
    "model not found",
    "model_not_found",
    "model not available",
    "model does not exist",
    "no such model",
    "invalid model",
    "unsupported model",
    "model is not supported",
    "model not supported",
    "模型未找到",
    "模型不存在",
    "400033",
  ];
  return needles.some((k) => low.includes(k));
}

/**
 * Upstream rejected the gateway's stored credential (401, or 403 with
 * explicit auth-failure phrasing). The gateway always authenticates with the
 * provider's own api_key, so this is never the client's fault — the key is
 * dead/rotated and the right reaction is to roll to the next candidate.
 * A dead key does not recover in seconds: persistent cooldown.
 */
export function isAuthError(status: number, body: string): boolean {
  if (status === 401) return true;
  if (status !== 403) return false;
  const low = body.toLowerCase();
  return (
    low.includes("身份验证失败") ||
    low.includes("invalid api key") ||
    low.includes("incorrect api key") ||
    low.includes("invalid_api_key") ||
    low.includes("authentication")
  );
}

/**
 * Provider-specific "this request body is not acceptable to this vendor"
 * (the OpenAI-style `inference request is invalid` 400). The next candidate
 * may accept the same request, so roll forward like billing/429.
 */
export function isInvalidInferenceError(status: number, body: string): boolean {
  if (status < 400 || status >= 500) return false;
  const low = body.toLowerCase();
  return (
    low.includes("inference request is invalid") ||
    low.includes("invalid inference request")
  );
}

/**
 * Any 4xx that should roll to the next failover candidate: account/billing
 * state, model-unavailable, dead credential, or provider-specific
 * invalid-inference. (429 / 5xx / transport failures are handled separately
 * by the failover runner.)
 */
export function isFailover4xx(status: number, body: string): boolean {
  return (
    isBillingError(status, body) ||
    isModelUnavailableError(status, body) ||
    isInvalidInferenceError(status, body) ||
    isAuthError(status, body)
  );
}

/**
 * Whether a failed candidate's cooldown entry should outlive the transient
 * window (billing / model-unavailable / dead credential).
 */
export function isPersistent4xx(status: number, body: string): boolean {
  return isBillingError(status, body) || isModelUnavailableError(status, body) || isAuthError(status, body);
}

// Vendor "context length exceeded" phrasing across upstreams. Matching on it
// lets the gateway normalize a 400 into a clear 413 so agents show the real
// cause instead of a generic bad-request. Claude Code's reactive
// auto-compact fires on a 413 whose body contains "context window" (or
// "prompt is too long") — keep those phrases in the message.
const CONTEXT_OVERFLOW_NEEDLES = [
  "context length",
  "context_length",
  "maximum context",
  "context window",
  "prompt is too long",
  "input length exceeds",
  "too many tokens",
];

export function isContextOverflow(status: number, text: string): boolean {
  if (status !== 400 && status !== 413) return false;
  const low = text.toLowerCase();
  if (CONTEXT_OVERFLOW_NEEDLES.some((k) => low.includes(k))) return true;
  return low.includes("max_tokens") && (low.includes("exceed") || low.includes("too long"));
}

/**
 * Human-readable message for a failed upstream call. Prefers the upstream's
 * own `error.message` (or top-level `message`) when the body is JSON;
 * synthesizes a descriptive line for empty bodies (some vendors answer 429
 * with no payload at all, which used to surface as an empty message);
 * otherwise returns the raw body.
 */
export function upstreamErrorMessage(status: number, body: string, providerName: string): string {
  if (body.length === 0) {
    return `Provider ${providerName} returned HTTP ${status} with an empty body`;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    const err = obj.error;
    if (err && typeof err === "object" && !Array.isArray(err)) {
      const m = (err as Record<string, unknown>).message;
      if (typeof m === "string" && m.length > 0) return m;
    }
    const m = obj.message;
    if (typeof m === "string" && m.length > 0) return m;
  }
  return body;
}
