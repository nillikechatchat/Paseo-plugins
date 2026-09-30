// Response-cache keying. Follows the industry approach (LiteLLM /
// Cloudflare AI Gateway) and gatewayd's `gateway/cachekey.mbt`: canonical
// serialise the *semantically meaningful* request fields — provider + model +
// messages/input + tools + tool_choice + sampling params — then hash. Object
// keys are sorted, so identical requests map to the same key regardless of
// JSON field order (the previous implementation hashed the raw request bytes,
// so a reordered or extra-decorated body always missed and a `[provider] `
// prefixed model never matched its bare twin).

import { createHash } from "node:crypto";

export type CacheSurface = "chat" | "responses" | "messages";

/** Fields that change what the model returns. Everything else (`user`,
 *  `metadata`, gateway routing hints) is a side channel and must not
 *  participate (mirrors gatewayd's cache_key_of). */
const SEMANTIC_FIELDS: readonly string[] = [
  "model",
  "messages",
  "input",
  "instructions",
  "tools",
  "tool_choice",
  "temperature",
  "top_p",
  "max_tokens",
  "max_output_tokens",
  "reasoning_effort",
  "response_format",
];

/** Canonical JSON text of a JSON-ish value with object keys sorted. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
  return `{${parts.join(",")}}`;
}

/**
 * Build the 32-char cache key for one request under one provider. The
 * provider id is part of the key so two providers serving the same model
 * never replay each other's responses.
 */
export function cacheKeyFor(providerId: string, body: Record<string, unknown>): string {
  const parts = [providerId];
  for (const field of SEMANTIC_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      parts.push(`${field}=${canonicalJson(body[field])}`);
    }
  }
  return createHash("sha1").update(parts.join("&")).digest("hex").slice(0, 32);
}

/** Deterministic sampling only: `temperature` 0 or absent. */
export function isDeterministicSampling(body: Record<string, unknown>): boolean {
  const t = body.temperature;
  if (t === undefined || t === null) return true;
  return typeof t === "number" && t === 0;
}

function noTools(body: Record<string, unknown>): boolean {
  const tools = body.tools;
  if (tools === undefined || tools === null) return true;
  return Array.isArray(tools) && tools.length === 0;
}

export interface CacheAdmission {
  cacheable: boolean;
  /** Why a response was rejected; absent when it is admissible. */
  reason?: "stream" | "tools" | "sampling" | "store" | "no-input";
}

/** A Responses `input` is usable when it is present and non-empty. gatewayd
 *  only checks presence; an empty string/array is rejected here as well
 *  because there is nothing to replay from it. */
function hasUsableInput(input: unknown): boolean {
  if (input === undefined || input === null) return false;
  if (typeof input === "string") return input.trim().length > 0;
  if (Array.isArray(input)) return input.length > 0;
  return true;
}

/**
 * Whether a response may be cached (mirrors gatewayd's chat/responses
 * admission rules):
 *  - non-streaming, tool-free, deterministic sampling (`temperature` 0/absent)
 *  - responses surface additionally requires `store:false` (agent traffic
 *    marks replayable turns) and a non-empty `input`
 */
export function cacheAdmission(
  body: Record<string, unknown>,
  surface: CacheSurface,
): CacheAdmission {
  if (body.stream === true) return { cacheable: false, reason: "stream" };
  if (!noTools(body)) return { cacheable: false, reason: "tools" };
  if (!isDeterministicSampling(body)) return { cacheable: false, reason: "sampling" };
  if (surface === "responses") {
    if (body.store !== false) return { cacheable: false, reason: "store" };
    if (!hasUsableInput(body.input)) {
      return { cacheable: false, reason: "no-input" };
    }
  }
  return { cacheable: true };
}
