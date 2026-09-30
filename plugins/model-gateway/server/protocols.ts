// Protocol support matrix — which OpenAI / Anthropic-style surface the
// gateway can route a given upstream to. "chat" is always supported via
// /v1/chat/completions. "responses" and "messages" depend on what the
// adapter (or the gateway's zhipu → chat bridge) can dispatch.
//
// This is best-effort: openai-compatible providers may or may not actually
// implement /v1/responses or /v1/messages; the gateway forwards to those
// paths and lets the upstream decide. The matrix is the set of URLs the
// gateway will attempt to dispatch.

import type { Provider, ProviderType } from "./storage";

export type Protocol = "chat" | "responses" | "messages";

const PROTOCOL_MATRIX: Record<ProviderType, ReadonlyArray<Protocol>> = {
  // `openai` implements buildProtocolUrl for both /v1/responses and
  // /v1/messages (providers/openai.ts), so the gateway really does attempt
  // both surfaces; omitting "messages" here made the panel and the agent
  // picker under-report what the gateway can dispatch.
  "openai": ["chat", "responses", "messages"],
  "openai-compatible": ["chat", "responses", "messages"],
  "azure-openai": ["chat", "responses", "messages"],
  "anthropic": ["chat", "messages"],
  "google": ["chat"],
  "ollama": ["chat"],
  "zhipu": ["chat", "responses", "messages"],
  "volcengine": ["chat", "responses", "messages"],
};

/** Protocols the gateway can dispatch to this provider. Always non-empty. */
export function providerProtocols(provider: Provider): Protocol[] {
  return [...PROTOCOL_MATRIX[provider.type]];
}

/**
 * Display labels for each provider type. Same map the gateway UI uses; kept
 * here so the server can return ready-to-render strings without the agent
 * having to maintain a parallel copy.
 */
export const PROVIDER_TYPE_LABELS: Record<ProviderType, string> = {
  openai: "OpenAI",
  "openai-compatible": "OpenAI 兼容",
  "azure-openai": "Azure OpenAI",
  anthropic: "Anthropic",
  google: "Google Gemini",
  ollama: "Ollama (本地)",
  zhipu: "智谱 GLM",
  volcengine: "火山方舟",
};

/** Render `[userProviderName] model` — distinct per upstream even when two providers share a type. */
export function formatModelLabel(provider: Provider, model: string): string {
  return `[${provider.name}] ${model}`;
}

// Substrings that mark a catalogue entry as NOT a conversational model —
// ASR/TTS, image/video/embedding endpoints and the aggregator's internal
// prefixed ids. These cannot be served on /v1/chat/completions,
// /v1/responses or /v1/messages, so advertising them in a model picker
// produces an entry that always fails. Shared by the agent-picker sync and
// the panel catalogue so both show exactly the same set.
const EXCLUDE_MODEL_SUBSTR: readonly string[] = [
  "asr", "tts", "music", "sfx", "image", "video", "realtime", "livetranslate",
  "seedance", "seedream", "u1-", "u1.", "vl-", "s2-", "s1", "a1",
];

/** Whether a catalogue id names a model the gateway can converse with. */
export function isChatModel(model: string): boolean {
  return !EXCLUDE_MODEL_SUBSTR.some((s) => model.includes(s));
}

export interface ModelRouting {
  /** Highest-priority enabled provider that claims this model (or first wildcard). */
  primary?: Provider;
  /** Union of protocols across every claiming provider. */
  protocols: Protocol[];
  /** Enabled providers whose `models` list includes this name (or is empty/wildcard). */
  claimingProviders: Provider[];
}

export interface ParsedModelRef {
  /** Bare upstream model name (prefix stripped). Always equals the input when no prefix present. */
  model: string;
  /**
   * The user's provider name extracted from `[<name>] ` prefix, when present.
   * Used to resolve to a provider id for explicit routing.
   */
  providerNameHint?: string;
}

// Match leading `[<name>] ` prefix. Names may contain spaces/ punctuation but
// not `]`. Used by the agent picker to show which upstream a model belongs to
// without forcing the gateway to maintain a parallel id space.
const PREFIX_RE = /^\[([^\]]+)\]\s+(.+)$/;

/**
 * Parse an incoming model field. Accepts either:
   - bare upstream name (e.g. `glm-5.2`) — returns as-is
   - `[<userProviderName>] <modelName>` (e.g. `[智谱主力] glm-5.2`) — strips the
     prefix and surfaces the provider-name hint so the caller can resolve it
     to a provider id and route explicitly.
 */
export function parseModelRef(raw: string): ParsedModelRef {
  const m = PREFIX_RE.exec(raw);
  if (!m) return { model: raw };
  return { model: m[2], providerNameHint: m[1] };
}

/**
 * Resolve a provider-name hint (from `parseModelRef`) to a provider id. Returns
 * undefined when no enabled provider matches the hint; the caller should treat
 * that as "no explicit provider" and fall back to default routing.
 */
export function resolveProviderByName(name: string | undefined, providers: Provider[]): string | undefined {
  if (!name) return undefined;
  const enabled = providers.filter((p) => p.enabled);
  const exact = enabled.find((p) => p.name === name);
  if (exact) return exact.id;
  // Fallback: case-insensitive match, ignore surrounding whitespace.
  const lower = name.trim().toLowerCase();
  return enabled.find((p) => p.name.trim().toLowerCase() === lower)?.id;
}

/**
 * Resolve routing info for a model across the enabled provider set:
 * which providers claim it, what protocols they collectively support,
 * and which one wins by priority/weight.
 */
export function modelRouting(model: string, providers: Provider[]): ModelRouting {
  const claiming = providers.filter((p) => p.enabled && (p.models.length === 0 || p.models.includes(model)));
  const protocols = new Set<Protocol>();
  for (const p of claiming) for (const pr of providerProtocols(p)) protocols.add(pr);
  const sorted = claiming.slice().sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return b.weight - a.weight;
  });
  return { primary: sorted[0], protocols: [...protocols], claimingProviders: claiming };
}