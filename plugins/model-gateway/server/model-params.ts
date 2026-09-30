// Per-model parameters: the official, vendor-documented context window /
// max-output / capability facts the gateway needs to configure a call
// *before* it spends an upstream round-trip on it.
//
// Why this exists: `Provider.contextWindow` / `Provider.maxOutputTokens` are
// optional per-provider overrides, and most records leave them unset. Without
// a model-level view the gateway either skips the context pre-check entirely
// (the upstream answers a 400 the caller could have avoided) or bumps
// `max_output_tokens` to an arbitrary constant. With it, routing, the
// context-window pre-check, the Responses `max_output_tokens` ceiling and the
// agent config files all read the same numbers.
//
// Precedence, most specific first:
//   1. the provider record's own `contextWindow` / `maxOutputTokens` — the
//      operator's explicit, per-deployment choice (self-hosted gateways
//      serve shorter windows than the public model card);
//   2. the entry below for the model id;
//   3. family defaults (`familyDefaults`);
//   4. nothing (unknown model) — callers must degrade gracefully.
//
// Model ids are matched leniently: lowercase, vendor prefixes (`zhipu/`,
// `openai/`, …) stripped, then trailing `-<segment>` groups removed until a
// registered entry matches. `deepseek-v4-flash-0731` therefore resolves to
// `deepseek-v4-flash`, and `senseaudio-asr-pro-1.5-260319` to nothing at all
// (non-chat models are deliberately absent).

import type { Provider } from "./storage";

/** Conservative capability view of a model (re-exported by routing.ts). */
export interface ModelCaps {
  vision: boolean;
  strongTools: boolean;
  strongReasoning: boolean;
  strongCode: boolean;
  fast: boolean;
  /** 0 = rely on the provider's contextWindow. */
  approxCtx: number;
}

export interface ModelParams {
  /** Context window in tokens, as documented by the vendor. */
  contextWindow: number;
  /** Maximum output tokens the model accepts. */
  maxOutputTokens: number;
  caps: ModelCaps;
  /** Vendor family, e.g. "glm", "claude", "gpt". */
  family: string;
  /** Other ids that resolve to this entry. */
  aliases?: readonly string[];
  note?: string;
}

const CHAT_CAPS: ModelCaps = { vision: false, strongTools: true, strongReasoning: true, strongCode: true, fast: false, approxCtx: 0 };
const FAST_CAPS: ModelCaps = { vision: false, strongTools: true, strongReasoning: false, strongCode: false, fast: true, approxCtx: 0 };
const REASON_CAPS: ModelCaps = { vision: false, strongTools: true, strongReasoning: true, strongCode: true, fast: false, approxCtx: 0 };
const VISION_CAPS: ModelCaps = { vision: true, strongTools: true, strongReasoning: true, strongCode: true, fast: false, approxCtx: 0 };

/** Known models, by canonical id. `aliases` are additional ids that resolve
 *  to the same entry (vendor renames, datestamped snapshots). */
const REGISTRY: Record<string, ModelParams> = {
  // ---- Zhipu GLM (bigmodel) ----
  "glm-4.5":      { contextWindow: 128000, maxOutputTokens: 32768, caps: REASON_CAPS, family: "glm" },
  "glm-4.5-air":  { contextWindow: 128000, maxOutputTokens: 32768, caps: { ...REASON_CAPS, fast: true }, family: "glm" },
  "glm-4.6":      { contextWindow: 200000, maxOutputTokens: 32768, caps: REASON_CAPS, family: "glm" },
  "glm-4.7":      { contextWindow: 200000, maxOutputTokens: 32768, caps: REASON_CAPS, family: "glm" },
  "glm-5":        { contextWindow: 200000, maxOutputTokens: 32768, caps: REASON_CAPS, family: "glm" },
  "glm-5-turbo":  { contextWindow: 128000, maxOutputTokens: 32768, caps: { ...REASON_CAPS, fast: true }, family: "glm" },
  "glm-5.1":      { contextWindow: 200000, maxOutputTokens: 32768, caps: REASON_CAPS, family: "glm" },
  "glm-5.2":      { contextWindow: 200000, maxOutputTokens: 32768, caps: REASON_CAPS, family: "glm", note: "thinking=max bills high" },
  "glm-5.3":      { contextWindow: 200000, maxOutputTokens: 32768, caps: REASON_CAPS, family: "glm" },
  "glm-5.3-flash":{ contextWindow: 200000, maxOutputTokens: 16384, caps: { ...REASON_CAPS, fast: true }, family: "glm",
                    aliases: ["glm-5.3-flashx"] },

  // ---- DeepSeek ----
  "deepseek-chat":     { contextWindow: 128000, maxOutputTokens: 8192, caps: CHAT_CAPS, family: "deepseek", aliases: ["deepseek-v3", "deepseek-v3.1"] },
  "deepseek-reasoner": { contextWindow: 128000, maxOutputTokens: 8192, caps: REASON_CAPS, family: "deepseek", aliases: ["deepseek-r1"] },
  "deepseek-v4-flash": { contextWindow: 128000, maxOutputTokens: 8192, caps: { ...REASON_CAPS, fast: true }, family: "deepseek",
                         aliases: ["deepseek-flash", "deepseek-v4-flash-0731", "deepseek-v4.1-flash"] },
  "deepseek-v4-pro":   { contextWindow: 128000, maxOutputTokens: 8192, caps: REASON_CAPS, family: "deepseek" },

  // ---- Moonshot Kimi ----
  "kimi-k2":   { contextWindow: 256000, maxOutputTokens: 16384, caps: REASON_CAPS, family: "kimi", aliases: ["kimi-k2.5", "kimi-k2.6"] },
  "kimi-k3":   { contextWindow: 256000, maxOutputTokens: 16384, caps: REASON_CAPS, family: "kimi" },

  // ---- Qwen (Alibaba) ----
  "qwen-max":    { contextWindow: 32768, maxOutputTokens: 8192, caps: REASON_CAPS, family: "qwen" },
  "qwen-plus":   { contextWindow: 131072, maxOutputTokens: 8192, caps: REASON_CAPS, family: "qwen" },
  "qwen-turbo":  { contextWindow: 131072, maxOutputTokens: 8192, caps: { ...REASON_CAPS, fast: true }, family: "qwen" },
  "qwen3-30b-a3b-q4": { contextWindow: 32768, maxOutputTokens: 8192, caps: REASON_CAPS, family: "qwen", note: "local exo cluster" },
  "qwen3.6-35b-a3b":  { contextWindow: 262144, maxOutputTokens: 16384, caps: REASON_CAPS, family: "qwen" },
  "qwen3.8-27b":      { contextWindow: 131072, maxOutputTokens: 8192, caps: REASON_CAPS, family: "qwen", aliases: ["qwen3-8-27b-q4", "qwen3.8-27b-q4"] },

  // ---- SenseAudio / SenseNova (via the senseaudio & sensenova providers) ----
  "senseaudio-s2":       { contextWindow: 131072, maxOutputTokens: 32768, caps: CHAT_CAPS, family: "senseaudio" },
  "senseaudio-s2-flash": { contextWindow: 131072, maxOutputTokens: 16384, caps: { ...FAST_CAPS, strongReasoning: true }, family: "senseaudio" },
  "senseaudio-s2-lite":  { contextWindow: 131072, maxOutputTokens: 8192, caps: FAST_CAPS, family: "senseaudio" },
  "sensenova-6.7-flash-lite": { contextWindow: 65536, maxOutputTokens: 8192, caps: FAST_CAPS, family: "sensenova" },
  "sensenova-6.8-flash-lite": { contextWindow: 65536, maxOutputTokens: 8192, caps: FAST_CAPS, family: "sensenova" },
  "sensenova-u1-fast":   { contextWindow: 65536, maxOutputTokens: 8192, caps: FAST_CAPS, family: "sensenova", aliases: ["sensenova-u1.5-fast"] },
  "sensenova-u1-lite":   { contextWindow: 65536, maxOutputTokens: 8192, caps: FAST_CAPS, family: "sensenova", aliases: ["sensenova-u1.5-lite"] },
  "doubao-seed-2-0-pro": { contextWindow: 256000, maxOutputTokens: 16384, caps: VISION_CAPS, family: "doubao" },
  "doubao-seed-1-6":     { contextWindow: 256000, maxOutputTokens: 16384, caps: VISION_CAPS, family: "doubao" },

  // ---- StepFun ----
  "step-3":          { contextWindow: 200000, maxOutputTokens: 16384, caps: REASON_CAPS, family: "step" },
  "step-3.5":        { contextWindow: 200000, maxOutputTokens: 16384, caps: REASON_CAPS, family: "step", aliases: ["step-3.5-flash", "step-3.5-flash-2603"] },
  "step-3.7":        { contextWindow: 200000, maxOutputTokens: 16384, caps: REASON_CAPS, family: "step", aliases: ["step-3.7-flash"] },
  "step-5":          { contextWindow: 200000, maxOutputTokens: 16384, caps: REASON_CAPS, family: "step", aliases: ["step-5-preview"] },
  "step-router":     { contextWindow: 200000, maxOutputTokens: 16384, caps: { ...REASON_CAPS, fast: true }, family: "step", aliases: ["step-router-v1"] },

  // ---- Agnes (OpenAI-compatible vendor that also serves /v1/messages) ----
  "agnes-2.0-flash": { contextWindow: 131072, maxOutputTokens: 32768, caps: FAST_CAPS, family: "agnes" },
  "agnes-2.5-flash": { contextWindow: 131072, maxOutputTokens: 32768, caps: { ...FAST_CAPS, strongCode: true }, family: "agnes" },
  "agnes-3.0-flash": { contextWindow: 131072, maxOutputTokens: 32768, caps: { ...FAST_CAPS, strongCode: true }, family: "agnes" },

  // ---- Volcengine Ark ----
  "ark-code-latest": { contextWindow: 256000, maxOutputTokens: 16384, caps: { ...REASON_CAPS, strongCode: true }, family: "doubao" },

  // ---- Anthropic Claude ----
  "claude-3-5-haiku":  { contextWindow: 200000, maxOutputTokens: 8192, caps: { ...VISION_CAPS, fast: true }, family: "claude" },
  "claude-haiku-4-5":  { contextWindow: 200000, maxOutputTokens: 64000, caps: { ...VISION_CAPS, fast: true }, family: "claude", aliases: ["claude-haiku-4.5"] },
  "claude-sonnet-4-5": { contextWindow: 200000, maxOutputTokens: 64000, caps: VISION_CAPS, family: "claude", aliases: ["claude-sonnet-4.5", "claude-3-5-sonnet", "claude-3-7-sonnet"] },
  "claude-opus-4-1":   { contextWindow: 200000, maxOutputTokens: 32000, caps: VISION_CAPS, family: "claude", aliases: ["claude-opus-4.1"] },

  // ---- OpenAI ----
  "gpt-4o":       { contextWindow: 128000, maxOutputTokens: 16384, caps: VISION_CAPS, family: "gpt" },
  "gpt-4o-mini":  { contextWindow: 128000, maxOutputTokens: 16384, caps: { ...VISION_CAPS, fast: true }, family: "gpt" },
  "gpt-4.1":      { contextWindow: 1047576, maxOutputTokens: 32768, caps: VISION_CAPS, family: "gpt" },
  "gpt-4.1-mini": { contextWindow: 1047576, maxOutputTokens: 32768, caps: { ...VISION_CAPS, fast: true }, family: "gpt" },
  "gpt-5":        { contextWindow: 400000, maxOutputTokens: 128000, caps: VISION_CAPS, family: "gpt" },
  "gpt-5-mini":   { contextWindow: 400000, maxOutputTokens: 128000, caps: { ...VISION_CAPS, fast: true }, family: "gpt" },
  "o3":           { contextWindow: 200000, maxOutputTokens: 100000, caps: VISION_CAPS, family: "gpt" },
  "o4-mini":      { contextWindow: 200000, maxOutputTokens: 100000, caps: { ...VISION_CAPS, fast: true }, family: "gpt" },

  // ---- Google Gemini ----
  "gemini-2.5-pro":   { contextWindow: 1048576, maxOutputTokens: 65536, caps: VISION_CAPS, family: "gemini" },
  "gemini-2.5-flash": { contextWindow: 1048576, maxOutputTokens: 65536, caps: { ...VISION_CAPS, fast: true }, family: "gemini" },
  "gemini-3-pro":     { contextWindow: 1048576, maxOutputTokens: 65536, caps: VISION_CAPS, family: "gemini" },

  // ---- MiniMax ----
  "minimax-m2":   { contextWindow: 1000000, maxOutputTokens: 16384, caps: REASON_CAPS, family: "minimax" },
  "minimax-m2.1": { contextWindow: 1000000, maxOutputTokens: 16384, caps: REASON_CAPS, family: "minimax", aliases: ["minimax-m2.1-highspeed"] },
  "minimax-m2.5": { contextWindow: 1000000, maxOutputTokens: 16384, caps: REASON_CAPS, family: "minimax", aliases: ["minimax-m2.5-highspeed"] },
  "minimax-m2.7": { contextWindow: 1000000, maxOutputTokens: 16384, caps: REASON_CAPS, family: "minimax", aliases: ["minimax-m2.7-highspeed"] },
  "minimax-m3":   { contextWindow: 1000000, maxOutputTokens: 16384, caps: REASON_CAPS, family: "minimax", note: "1M context, thinking bills high" },
};

/** Lowercase the id and drop a vendor prefix (`zhipu/glm-5.2` → `glm-5.2`). */
export function normalizeModelId(model: string): string {
  return model.trim().toLowerCase().replace(/^[a-z0-9_.-]+\//, "");
}

/** Alias → canonical id, built once. */
const ALIAS_INDEX: Map<string, string> = new Map();
for (const [id, p] of Object.entries(REGISTRY)) {
  ALIAS_INDEX.set(id, id);
  for (const a of p.aliases ?? []) ALIAS_INDEX.set(a, id);
}

/**
 * Registry lookup for one model id. Tries the exact (normalised) id, then the
 * alias table, then progressively strips trailing `-<segment>` groups so
 * datestamped and variant-suffixed ids (`…-0731`, `…-flashx`, `…-260319`)
 * resolve to their base entry. Longest match wins, so `deepseek-v4-pro` never
 * degrades to `deepseek-v4-flash`.
 */
export function modelParamsFor(model: string): ModelParams | undefined {
  const norm = normalizeModelId(model);
  if (!norm) return undefined;
  const direct = ALIAS_INDEX.get(norm);
  if (direct) return REGISTRY[direct];
  const parts = norm.split("-");
  for (let i = parts.length - 1; i >= 1; i--) {
    const id = ALIAS_INDEX.get(parts.slice(0, i).join("-"));
    if (id) return REGISTRY[id];
  }
  return undefined;
}

/** Family of a model, from the registry or from the id itself. */
export function familyOf(model: string): string {
  return modelParamsFor(model)?.family ?? normalizeModelId(model).split("-")[0] ?? "unknown";
}

/**
 * Context window for one (provider, model) pair: the **larger** of the
 * provider record and the registry. Returns undefined when neither knows —
 * callers must skip the pre-check rather than guess.
 *
 * The provider field is a deployment-wide default (one number covering 40
 * models on `senseaudio`), so per model it is either over-stated (a 128k
 * model behind a 1M default) or under-stated (a 200k model behind a 128k
 * default). Taking the max keeps the pre-check conservative in the safe
 * direction: the gateway never fabricates a 413 for a request the model
 * would have served, while still rejecting a payload no known window for
 * that model could accept. This mirrors gatewayd `context_window_for`.
 */
export function contextWindowFor(provider: Provider | undefined, model: string): number | undefined {
  const own = typeof provider?.contextWindow === "number" && provider.contextWindow > 0 ? provider.contextWindow : 0;
  const known = modelParamsFor(model)?.contextWindow ?? 0;
  if (own > 0 && known > 0) return Math.max(own, known);
  return Math.max(own, known) || undefined;
}

/**
 * Output-token ceiling for one (provider, model) pair. When both sources
 * know a value the *smaller* one wins,
 * because an oversized `max_output_tokens` is rejected outright by strict
 * upstreams while a smaller one merely truncates.
 */
export function maxOutputTokensFor(provider: Provider | undefined, model: string): number | undefined {
  const known = modelParamsFor(model)?.maxOutputTokens;
  const own = provider?.maxOutputTokens;
  if (typeof own === "number" && own > 0) {
    if (typeof known === "number" && known > 0) return Math.min(own, known);
    return own;
  }
  return known;
}

/** Every registered model id, aliases excluded. */
export function knownModelIds(): string[] {
  return Object.keys(REGISTRY);
}
