// Routing picks a provider for a request. Strategy:
//   1. Honor an explicit `provider` hint in the request body (gateway-specific).
//   2. Match the requested `model` against each enabled provider's `models` list.
//   3. If no provider claims the model, fall back to the highest-priority enabled
//      provider (and let the upstream surface its own model-not-found error).
// The picker also enforces a simple per-minute rate limit.

import type { Provider } from "./storage";
import { modelParamsFor, type ModelCaps } from "./model-params";

/** Capability shape lives with the model registry now (model-params.ts);
 *  re-exported here so existing callers keep importing it from routing. */
export type { ModelCaps } from "./model-params";

/** Virtual model id advertised in the agent pickers: "route for me". */
export const AUTO_MODEL = "auto";

// Preference order for AUTO_MODEL resolution, per protocol surface. The
// first entry claimed by at least one enabled provider wins; the normal
// candidate list then provides cross-provider failover. Entries must be
// chat-capable models that actually exist in provider catalogues.
const AUTO_PREFERENCES: Record<"chat" | "responses" | "messages", readonly string[]> = {
  // glm-5.2 is claimed by several providers (good failover) and is the
  // Claude-surface default in agent-config-sync.
  messages: ["glm-5.2", "kimi-k3", "deepseek-v4-flash"],
  responses: ["glm-5.2", "agnes-2.5-flash", "kimi-k3", "deepseek-v4-flash"],
  chat: ["glm-5.2", "agnes-2.5-flash", "kimi-k3", "deepseek-v4-flash"],
};

/**
 * Ordered failover chain for the virtual `auto` model: every preference
 * entry claimed by an in-scope provider, most-preferred first. Non-auto
 * models yield a singleton chain. 429/5xx/transport failures walk to the
 * next model; per-model providers come from pickProviderCandidates.
 */
export function resolveAutoChain(
  model: string,
  surface: "chat" | "responses" | "messages",
  providers: Provider[],
  explicitProvider?: string,
): string[] {
  if (model !== AUTO_MODEL) return [model];
  const enabled = providers.filter((p) => p.enabled);
  if (enabled.length === 0) return [model];
  const scope = explicitProvider ? enabled.filter((p) => p.id === explicitProvider) : enabled;
  const pool = scope.length > 0 ? scope : enabled;
  const chain = AUTO_PREFERENCES[surface].filter((wanted) =>
    pool.some((p) => p.models.length === 0 || p.models.includes(wanted)),
  );
  if (chain.length === 0) {
    const sorted = pool.slice().sort((a, b) => (a.priority - b.priority) || (b.weight - a.weight));
    if (sorted[0]?.models[0]) chain.push(sorted[0].models[0]);
  }
  return chain.length > 0 ? chain : [model];
}

/**
 * Resolve the virtual `auto` model to a concrete catalogue model. Returns
 * the input unchanged when it is not `auto`. When a provider hint is given
 * (explicit `provider` field or `[name]` prefix), only that provider's
 * catalogue is consulted. Falls back to the first chat-ish model of the
 * highest-priority enabled provider when no preference matches.
 */
export function resolveAutoModel(
  model: string,
  surface: "chat" | "responses" | "messages",
  providers: Provider[],
  explicitProvider?: string,
): string {
  return resolveAutoChain(model, surface, providers, explicitProvider)[0];
}

interface RouteInput {
  model: string;
  explicitProvider?: string;
  providers: Provider[];
  now?: number;
}

export interface RouteDecision {
  provider: Provider;
  reason: "explicit" | "model-match" | "fallback";
}

const counters = new Map<string, { minute: number; count: number }>();

export function pickProvider(input: RouteInput): RouteDecision | null {
  return pickProviderCandidates(input)[0] ?? null;
}

/**
 * All viable candidates in failover order (same priority/weight ordering as
 * pickProvider). Explicit-provider requests yield a single candidate — when
 * the caller names a provider they get exactly that one, no silent rerouting.
 */
export function pickProviderCandidates(input: RouteInput): RouteDecision[] {
  const enabled = input.providers.filter((p) => p.enabled);
  if (enabled.length === 0) return [];

  if (input.explicitProvider) {
    const found = enabled.find((p) => p.id === input.explicitProvider);
    if (found) return [{ provider: found, reason: "explicit" }];
  }

  const sort = (list: Provider[]) => list.slice().sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    // Stable secondary: weight
    return b.weight - a.weight;
  });

  const modelClaimed = enabled.filter((p) => p.models.length === 0 || p.models.includes(input.model));
  if (modelClaimed.length > 0) {
    return sort(modelClaimed).map((provider) => ({ provider, reason: "model-match" as const }));
  }

  // Fallback: lowest priority value, then highest weight
  return sort(enabled).map((provider) => ({ provider, reason: "fallback" as const }));
}

/**
 * Model id an embeddings request names, or the generic `embed` bucket when
 * the body does not name one. An embeddings call names a specific embedding
 * model, so routing on it is what keeps a text-only chain from swallowing
 * the request. Tolerates a non-JSON body (raw bytes are forwarded verbatim
 * under the generic bucket).
 */
export function embeddingModelOf(body: string | undefined): string {
  if (!body) return "embed";
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const model = (parsed as Record<string, unknown>).model;
      if (typeof model === "string" && model.length > 0) return model;
    }
  } catch {
    // Not JSON (or empty): generic bucket.
  }
  return "embed";
}

export function checkRateLimit(provider: Provider, now: number = Date.now()): { ok: true } | { ok: false; retryAfterMs: number } {
  if (!provider.rateLimitRpm || provider.rateLimitRpm <= 0) return { ok: true };
  const minute = Math.floor(now / 60_000);
  const cur = counters.get(provider.id);
  if (!cur || cur.minute !== minute) {
    counters.set(provider.id, { minute, count: 1 });
    return { ok: true };
  }
  if (cur.count >= provider.rateLimitRpm) {
    return { ok: false, retryAfterMs: 60_000 - (now - minute * 60_000) };
  }
  cur.count++;
  return { ok: true };
}

export function clearRateLimitState(): void {
  counters.clear();
}

// ========================================================================
// Task-aware `auto` routing (mirrors gatewayd's protocol/routing.mbt).
//
// The virtual `auto` model is a *static* preference chain (resolveAutoChain).
// To make `auto` route by task, we classify the request into TaskProfile
// signals and re-rank the failover chain by capability fit (capsFor/fitScore).
// Unknown models fall back to a permissive default so adding a new
// provider/model never hard-breaks `auto`.
// ========================================================================

/** Task signals classified from a request body. */
export interface TaskProfile {
  hasTools: boolean;
  hasVision: boolean;
  wantsReasoning: boolean;
  looksCode: boolean;
  estTokens: number;
}


function contentHasImage(c: unknown): boolean {
  if (!Array.isArray(c)) return false;
  for (const p of c) {
    if (typeof p === "object" && p !== null) {
      const t = (p as Record<string, unknown>).type;
      if (t === "input_image" || t === "image_url" || t === "image") return true;
    }
  }
  return false;
}

function textOfContent(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((p) =>
        typeof p === "object" && p !== null && typeof (p as Record<string, unknown>).text === "string"
          ? ((p as Record<string, unknown>).text as string)
          : "",
      )
      .filter((s) => s.length > 0)
      .join("\n");
  }
  return "";
}

function countOccurrences(s: string, sub: string): number {
  if (sub.length === 0) return 0;
  let count = 0;
  let idx = 0;
  for (;;) {
    idx = s.indexOf(sub, idx);
    if (idx === -1) break;
    count++;
    idx += sub.length;
  }
  return count;
}

/**
 * Capability lookup for a model. The registry (model-params.ts) answers
 * first for every model it knows — those are per-model facts, not family
 * guesses. Unknown models fall back to the family heuristic below, which
 * stays deliberately conservative: vision is asserted only for clearly
 * multimodal families (a false-positive would silently drop images).
 */
export function capsFor(model: string): ModelCaps {
  const known = modelParamsFor(model);
  if (known) {
    return { ...known.caps, approxCtx: known.contextWindow };
  }
  return familyCaps(model);
}

/** Family-name heuristic for models outside the registry. */
function familyCaps(model: string): ModelCaps {
  const m = model.toLowerCase();
  const has = (sub: string) => m.includes(sub);
  if (has("claude") || has("gemini") || has("gpt-4o") || has("o1") || has("o3") || has("o4")) {
    return { vision: true, strongTools: true, strongReasoning: true, strongCode: true, fast: false, approxCtx: 200000 };
  }
  if (has("glm")) {
    // Zhipu GLM: strong code + reasoning + tools; vision kept conservative.
    return { vision: false, strongTools: true, strongReasoning: true, strongCode: true, fast: false, approxCtx: 128000 };
  }
  if (has("kimi") || has("moonshot")) {
    // Kimi/Moonshot: strong reasoning + very long context; agentic tools.
    return { vision: false, strongTools: true, strongReasoning: true, strongCode: false, fast: false, approxCtx: 200000 };
  }
  if (has("deepseek")) {
    const fast = has("flash") || has("fast") || has("lite");
    return { vision: false, strongTools: true, strongReasoning: true, strongCode: true, fast, approxCtx: fast ? 64000 : 128000 };
  }
  if (has("agnes")) {
    // Agnes flash tier: fast / cheap general-purpose.
    return { vision: false, strongTools: false, strongReasoning: false, strongCode: false, fast: true, approxCtx: 0 };
  }
  // Permissive default: neutral soft scores, no hard exclusion.
  return { vision: false, strongTools: false, strongReasoning: false, strongCode: false, fast: false, approxCtx: 0 };
}

/**
 * Classify a request body into TaskProfile signals. Reads both the Responses
 * (`input`) and chat (`messages`) shapes, plus `tools` / `tool_choice` /
 * `reasoning_effort` / `thinking`.
 */
export function classifyTask(body: unknown): TaskProfile {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, any>;
  let hasTools = false;
  let hasVision = false;
  let wantsReasoning = false;
  const userTexts: string[] = [];

  if (Array.isArray(b.tools) && b.tools.length > 0) hasTools = true;
  if (b.tool_choice !== undefined && b.tool_choice !== null) hasTools = true;
  if (typeof b.reasoning_effort === "string" && b.reasoning_effort !== "" && b.reasoning_effort !== "none") wantsReasoning = true;
  if (b.thinking?.type === "enabled" || b.thinking?.type === "adaptive") wantsReasoning = true;

  const walkItems = (items: unknown[]) => {
    for (const it of items) {
      if (typeof it !== "object" || it === null) continue;
      const o = it as Record<string, any>;
      const ty = typeof o.type === "string" ? o.type : "";
      const role = typeof o.role === "string" ? o.role : "";
      if (contentHasImage(o.content)) hasVision = true;
      const isToolItem =
        ty === "function_call" ||
        ty === "function_call_output" ||
        ty === "tool_use" ||
        ty === "tool_result" ||
        o.tool_calls !== undefined;
      if (isToolItem) hasTools = true;
      if (role === "user") userTexts.push(textOfContent(o.content));
    }
  };
  if (Array.isArray(b.input)) walkItems(b.input);
  if (Array.isArray(b.messages)) walkItems(b.messages);

  const joined = userTexts.join("\n");
  const low = joined.toLowerCase();
  let codeScore = countOccurrences(joined, "```") * 3;
  const codeKw: string[] = [
    ".py", ".ts", ".js", ".tsx", ".jsx", ".go", ".rs", ".java", ".cpp",
    ".cc", ".mb", ".mbt", ".sh", ".rb", ".php", ".cs",
    "def ", "fn ", "pub fn", "import ", "class ", "function ", "const ",
    "panic", "stack trace", "compile", "lint", "traceback", "segmentation fault",
  ];
  for (const kw of codeKw) if (low.includes(kw)) codeScore += 2;
  const looksCode = codeScore >= 4;

  let estTokens = 0;
  try {
    estTokens = Math.ceil(JSON.stringify(b).length / 4);
  } catch {
    estTokens = 0;
  }

  return { hasTools, hasVision, wantsReasoning, looksCode, estTokens };
}

/**
 * Capability-fit score for one (model, provider) candidate on a task.
 * Higher = better. Context-overflow is the only near-fatal penalty; every
 * other signal is a soft preference so no candidate is hard-excluded.
 * Deliberately NO "fast model for simple task" bonus: in this topology the
 * fast/flash tier is served by flaky or stub providers that answer HTTP 200
 * with placeholder content, so prefering them would silently degrade simple
 * tasks. Simple tasks keep the proven static chain order.
 */
export function fitScore(model: string, p: Provider, task: TaskProfile): number {
  const c = capsFor(model);
  let s = 0;
  const pw = p.contextWindow ?? 0;
  const ctx = Math.max(pw, c.approxCtx);
  if (task.estTokens > 0 && ctx > 0 && task.estTokens > ctx) s -= 10000;
  if (task.hasVision) s += c.vision ? 400 : -200;
  if (task.hasTools) s += c.strongTools ? 250 : -60;
  if (task.wantsReasoning) s += c.strongReasoning ? 250 : -60;
  if (task.looksCode) s += c.strongCode ? 200 : -40;
  return s;
}

/**
 * Re-rank a static auto chain by capability fit for the task. Stable: ties
 * keep the original (static-preference) order, so this is a pure
 * re-priorisation, never an exclusion.
 */
export function rankAutoChain(chain: string[], providers: Provider[], task: TaskProfile): string[] {
  const scored = chain.map((m, i) => {
    const cands = pickProviderCandidates({ model: m, providers });
    let best = -1000000;
    for (const c of cands) best = Math.max(best, fitScore(m, c.provider, task));
    return { score: best, idx: i, model: m };
  });
  scored.sort((a, b) => (b.score - a.score) || (a.idx - b.idx));
  return scored.map((x) => x.model);
}

/**
 * Task-aware auto chain: the static preference chain re-ranked for the
 * classified task. Pinned (non-auto) models return the singleton chain
 * unchanged; `auto` is re-ordered toward the best-fit models while keeping
 * every candidate reachable as a failover target.
 */
export function resolveAutoChainFor(
  model: string,
  surface: "chat" | "responses" | "messages",
  providers: Provider[],
  explicitProvider?: string,
  task?: TaskProfile,
): string[] {
  const base = resolveAutoChain(model, surface, providers, explicitProvider);
  if (model !== AUTO_MODEL) return base;
  if (!task) return base;
  return rankAutoChain(base, providers, task);
}

/**
 * Per-(provider, model, surface) failure cooldown (mirrors gatewayd's
 * cooldown.mbt). Consistently failing pairs — e.g. a provider whose billing
 * account is frozen — are demoted to the tail of the failover chain instead
 * of being the first wasted call of every request. Demotion is never
 * exclusion: cooled candidates stay last-in-chain.
 */
export interface CooldownEntry {
  billing: boolean;
  count: number;
  lastMs: number;
}

const PERSISTENT_TTL_MS = 5 * 60_000;
const TRANSIENT_TTL_MS = 60_000;

export class FailCooldown {
  private entries: Map<string, CooldownEntry>;

  constructor() {
    this.entries = new Map();
  }

  record(
    provider: string,
    model: string,
    surface: string,
    persistent: boolean,
    nowMs: number = Date.now(),
  ): void {
    const key = `${provider}/${model}/${surface}`;
    const prev = this.entries.get(key);
    this.entries.set(key, {
      billing: (prev?.billing ?? false) || persistent,
      count: (prev?.count ?? 0) + 1,
      lastMs: nowMs,
    });
  }

  reset(provider: string, model: string, surface: string): void {
    this.entries.delete(`${provider}/${model}/${surface}`);
  }

  demoted(
    provider: string,
    model: string,
    surface: string,
    nowMs: number = Date.now(),
  ): boolean {
    const e = this.entries.get(`${provider}/${model}/${surface}`);
    if (!e) return false;
    if (e.billing) return nowMs - e.lastMs < PERSISTENT_TTL_MS;
    return e.count >= 2 && nowMs - e.lastMs < TRANSIENT_TTL_MS;
  }
}

/** Reorder candidates so cooled pairs sit at the tail (kept + cooled). */
export function demoteCandidates<T extends { model: string; decision: RouteDecision }>(
  cands: T[],
  cooldown: FailCooldown,
  surface: string,
  nowMs: number = Date.now(),
): T[] {
  const kept: T[] = [];
  const cooled: T[] = [];
  for (const c of cands) {
    if (cooldown.demoted(c.decision.provider.id, c.model, surface, nowMs)) cooled.push(c);
    else kept.push(c);
  }
  return [...kept, ...cooled];
}
