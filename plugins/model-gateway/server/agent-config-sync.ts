// Sync the configured agent config files (`~/.pi/agent/models.json` and
// `~/.paseo/config.json`) so the model picker shows each model's owning
// upstream as a `[<providerName>] <model>` prefix on its `id` field. The
// gateway already strips the prefix on incoming chat requests, so the agent
// side doesn't need any matching logic.
//
// Atomic write (tmp + rename), tolerant of missing files (skip with
// debug log), preserves unrelated content. Errors are surfaced via the
// returned per-file status so the caller can log them without breaking the
// originating RPC handler.

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { formatModelLabel, isChatModel, providerProtocols } from "./protocols";
import { capsFor } from "./routing";
import { contextWindowFor, maxOutputTokensFor } from "./model-params";
import type { Provider } from "./storage";

/** Model carrying `isDefault` in gateway-claude when at least one claimant can serve it. */
const CLAUDE_DEFAULT_MODEL = "glm-5.2";

/** gatewayd's default data-plane address on loopback. Only used when the
 *  caller passes neither a live gateway base nor a port. */
const DEFAULT_GATEWAY_BASE = "http://127.0.0.1:39000";

export interface SyncFileStatus {
  path: string;
  ok: boolean;
  reason?: string;
  written?: number;
}

export interface AgentConfigSyncResult {
  pi: SyncFileStatus;
  paseo: SyncFileStatus;
  /**
   * Provider overrides the caller must hand to the *running daemon* so the
   * model picker picks the new catalogue up immediately. Writing the file is
   * not enough: the daemon serves `listProviderModels` from an in-memory
   * provider snapshot it only rebuilds on start-up or on a config patch, so
   * without this the picker keeps showing the previous model set until the
   * user runs `paseo reload` (or restarts).
   */
  overrides: PaseoProviderOverrides;
}

export interface AgentConfigSyncOptions {
  /** Override the user home; tests use a temp dir. */
  home?: string;
  /** Skip file writes (used by smoke tests that assert in-memory state). */
  dryRun?: boolean;
  /**
   * Base URL of the gateway the agent configs must point at
   * (`http://<host>:<port>`, no trailing slash). Callers pass the *live*
   * address — gatewayd's data-plane port when the native gateway owns the
   * data plane, otherwise the in-process gateway's bound port. Defaults to
   * `MODEL_GATEWAY_BASE_URL`; the last-resort fallback is gatewayd's default
   * port on loopback.
   */
  gatewayBase?: string;
  /** Port of the gateway to derive a loopback base from when `gatewayBase`
   *  is absent (the persisted `gatewayPort` setting). */
  gatewayPort?: number;
}

/** Resolve the gateway base URL the agent config files must point at. */
export function resolveGatewayBase(gatewayBase?: string, gatewayPort?: number): string {
  const explicit = gatewayBase ?? process.env.MODEL_GATEWAY_BASE_URL;
  if (typeof explicit === "string" && explicit.length > 0) return explicit.replace(/\/+$/, "");
  const port = Number(gatewayPort);
  if (Number.isInteger(port) && port >= 1 && port <= 65535) return `http://127.0.0.1:${port}`;
  return DEFAULT_GATEWAY_BASE;
}

interface CatalogueEntryLike {
  model: string;
  primaryProvider: Provider;
  label: string;
  protocols: string[];
}

function protocolsForPrimary(p: Provider): string[] {
  // Delegate to the shared matrix (protocols.ts) so the picker's advertised
  // surfaces can never drift from what the panel catalogue reports. The old
  // private switch disagreed with it (it marked openai-compatible providers
  // as messages-incapable even though the gateway dispatches that surface).
  return providerProtocols(p);
}

function buildViews(providers: Provider[]): {
  chat: CatalogueEntryLike[];
  messages: CatalogueEntryLike[];
} {
  // One entry per (enabled provider, model) pair — NOT one per model name.
  // Collapsing same-named models across providers is what made the picker
  // disagree with the panel: the gateway provider list showed `glm-5.3-flash`
  // under both senseaudio and Glm, while the picker kept whichever claimant
  // won priority, so the entry the user configured under the other provider
  // was simply gone. Each entry keeps its `[<providerName>]` prefix, so the
  // gateway routes it to that exact upstream and every entry is a distinct,
  // truthful selection.
  const enabled = providers
    .filter((p) => p.enabled)
    .slice()
    .sort((a, b) => (a.priority !== b.priority ? a.priority - b.priority : b.weight - a.weight));
  // A wildcard provider (`models: []`) claims every model the gateway routes
  // to it, so it used to contribute nothing at all here — none of the models
  // it can actually serve were selectable, and the panel showed it with "0
  // 个模型" while the gateway happily dispatched to it. Advertise the union of
  // explicitly listed models instead, which is the set anything can name.
  const wildcard = enabled.filter((p) => p.models.length === 0);
  const union = wildcard.length > 0
    ? [...new Set(enabled.flatMap((p) => p.models))].filter(isChatModel)
    : [];
  const chat: CatalogueEntryLike[] = [];
  const messages: CatalogueEntryLike[] = [];
  for (const p of enabled) {
    for (const m of p.models.length === 0 ? union : p.models) {
      if (!isChatModel(m)) continue;
      const entry: CatalogueEntryLike = {
        model: m,
        primaryProvider: p,
        label: formatModelLabel(p, m),
        protocols: protocolsForPrimary(p),
      };
      chat.push(entry);
      // Messages surface: advertise exactly the providers the gateway can
      // dispatch to /v1/messages (see canServeMessages), so an agent that
      // picks an entry here gets a real route rather than a 404/400.
      if (canServeMessages(p, m)) messages.push(entry);
    }
  }
  return { chat, messages };
}

/**
 * Whether `provider` can serve this model on the Anthropic Messages surface
 * (i.e. whether it may be advertised to the Claude Code picker for it).
 *
 * Derived from the single source of truth — the protocol matrix — instead of
 * a hand-maintained model allowlist. The old rule (`type==="anthropic" ||
 * exposeMessages || model.startsWith("glm-") || curated set`) invented
 * capability from model names: it hid `[senseaudio] kimi-k3` from the Claude
 * picker even though the gateway dispatches it, and it claimed `glm-*` and
 * five hand-picked names for every provider regardless of what the vendor
 * actually serves. `exposeMessages` remains an explicit user override for
 * vendors whose type the matrix does not list as messages-capable.
 *
 * Exported for tests — the per-surface attribution in `buildViews` is the
 * difference between the model appearing in `gateway-claude` or not.
 */
export function canServeMessages(provider: Provider, model: string): boolean {
  // `model` is accepted for symmetry with the other capability gates and
  // for future per-model overrides; the decision is per provider because
  // the surface is a property of the vendor's adapter, not of the model.
  void model;
  return provider.exposeMessages === true || providerProtocols(provider).includes("messages");
}

async function readJsonFile(path: string): Promise<unknown | undefined> {
  try {
    const raw = await fs.readFile(path, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    throw err;
  }
}

/** Atomic JSON write. Creates the parent directories first: a fresh
 *  install has no `~/.paseo/config.json` (and often no `~/.paseo` at all),
 *  and a sync that fails there used to return ok:false silently. */
async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  const dir = dirname(path);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${path}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tmp, path);
}

function ensureObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} root must be an object`);
  }
  return value as Record<string, unknown>;
}

/** Build the catalogue views and write them into the agent config files. */
export async function syncAgentConfigs(
  providers: Provider[],
  options: AgentConfigSyncOptions = {},
): Promise<AgentConfigSyncResult> {
  const home = options.home ?? homedir();
  const piPath = join(home, ".pi/agent/models.json");
  const paseoPath = join(home, ".paseo/config.json");

  const { chat, messages } = buildViews(providers);

  const piStatus = await syncPiModelsFile(piPath, chat, options);
  const paseoStatus = await syncPaseoConfigFile(paseoPath, chat, messages, options);
  const overrides = buildPaseoProviderOverrides(chat, messages, options);

  return { pi: piStatus, paseo: paseoStatus, overrides };
}

async function syncPiModelsFile(
  path: string,
  chat: CatalogueEntryLike[],
  options: AgentConfigSyncOptions,
): Promise<SyncFileStatus> {
  try {
    const existing = await readJsonFile(path);
    const root = existing ? ensureObject(existing, "models.json") : { providers: {} };
    const providers = ensureObject(root["providers"] ?? {}, "providers");
    const modelGateway = ensureObject(
      providers["model-gateway"] ?? { models: [] },
      "providers.model-gateway",
    );
    // Model metadata the picker shows comes from the per-model registry
    // (model-params.ts), with the provider record's own overrides on top.
    // These used to be hardcoded 131072/32768 for every model, so the agent
    // picker advertised a window the model did not have — an agent that
    // trusts it stops compacting too late and gets a 413 from upstream.
    const entries = chat.map((c) => {
      const caps = capsFor(c.model);
      return {
        id: c.label,
        name: c.label,
        reasoning: caps.strongReasoning,
        input: caps.vision ? ["text", "image"] : ["text"],
        contextWindow: contextWindowFor(c.primaryProvider, c.model) ?? 131072,
        maxTokens: maxOutputTokensFor(c.primaryProvider, c.model) ?? 32768,
      };
    });
    modelGateway["models"] = entries;
    providers["model-gateway"] = modelGateway;
    root["providers"] = providers;

    if (!options.dryRun) {
      await writeJsonAtomic(path, root);
    }
    return { path, ok: true, written: entries.length };
  } catch (err) {
    return {
      path,
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/** A gateway provider entry as it appears under `agents.providers`. Mirrors
 *  the fields `ProviderOverrideSchema` keeps, so the very same object is safe
 *  to hand to the daemon through `paseo.config.patch` (the schema strips
 *  anything else). */
interface PaseoGatewayProviderEntry {
  // The schema inferred for the daemon patch carries a string index
  // signature; keep one here so the object we hand over stays assignable.
  [key: string]: unknown;
  extends: "codex" | "claude";
  label: string;
  description: string;
  env: Record<string, string>;
  models: Array<{ id: string; label: string; isDefault?: true }>;
}

export interface PaseoProviderOverrides {
  [key: string]: unknown;
  pi: { additionalModels: Array<{ id: string; label: string }> };
  "gateway-codex": PaseoGatewayProviderEntry;
  "gateway-claude": PaseoGatewayProviderEntry;
}

/**
 * Build the three `agents.providers` entries the gateway owns: the flat list
 * exposed to the `pi` agent and the two monolithic gateway providers, one per
 * agent protocol surface. All traffic shares the gateway's fixed port;
 * per-model upstream ownership is carried by the `[<providerName>]` id prefix
 * (the gateway strips it and routes). Earlier revisions wrote one provider
 * group per upstream (`gateway-codex-<id>` / `gateway-claude-<id>`); those went
 * stale whenever an upstream's catalogue changed and bloated the picker — they
 * are removed on every sync (see `syncPaseoConfigFile`).
 *
 * Single source of truth for what the agent configs must say, so the file
 * writer and the daemon patch below can never drift apart.
 */
export function buildPaseoProviderOverrides(
  chat: CatalogueEntryLike[],
  messages: CatalogueEntryLike[],
  options: { gatewayBase?: string; gatewayPort?: number } = {},
): PaseoProviderOverrides {
  // Written from the *live* gateway address (see AgentConfigSyncOptions):
  // hardcoding gatewayd's port here used to leave the agent configs pointing
  // at a port the gateway was not bound to whenever the data plane moved.
  const GATEWAY_BASE = resolveGatewayBase(options.gatewayBase, options.gatewayPort);
  return {
    // pi additionalModels: keep prefixed ids to avoid duplicates in flat list
    pi: { additionalModels: chat.map((c) => ({ id: c.label, label: c.label })) },
    "gateway-codex": {
      extends: "codex",
      label: "Model Gateway (Codex)",
      description: "All gateway chat models via OpenAI Responses surface",
      env: {
        OPENAI_BASE_URL: `${GATEWAY_BASE}/v1`,
        OPENAI_API_KEY: "local-gateway",
      },
      models: [
        { id: "auto", label: "auto · 按请求自动路由(能力/延迟/健康)" },
        ...chat.map((c) => ({ id: c.label, label: c.label })),
      ],
    },
    "gateway-claude": {
      extends: "claude",
      label: "Model Gateway (Claude)",
      description: "Messages-capable gateway models via Anthropic surface",
      env: {
        ANTHROPIC_BASE_URL: GATEWAY_BASE,
        ANTHROPIC_AUTH_TOKEN: "local-gateway",
        API_TIMEOUT_MS: "3000000",
        IS_SANDBOX: "1",
      },
      models: [
        { id: "auto", label: "auto · 自动路由" },
        ...messages.map((c, i) => {
          const out: { id: string; label: string; isDefault?: true } = { id: c.label, label: c.label };
          // The default model may be served by several providers; only the
          // best claimant (first in priority order) carries the flag so the
          // picker has exactly one default.
          if (c.model === CLAUDE_DEFAULT_MODEL && !messages.slice(0, i).some((x) => x.model === CLAUDE_DEFAULT_MODEL)) {
            out.isDefault = true;
          }
          return out;
        }),
      ],
    },
  };
}

async function syncPaseoConfigFile(
  path: string,
  chat: CatalogueEntryLike[],
  messages: CatalogueEntryLike[],
  options: AgentConfigSyncOptions = {},
): Promise<SyncFileStatus> {
  try {
    const existing = await readJsonFile(path);
    const root = existing ? ensureObject(existing, "config.json") : { agents: { providers: {} } };
    const agents = ensureObject(root["agents"] ?? {}, "agents");
    const providers = ensureObject(agents["providers"] ?? {}, "agents.providers");

    // The per-surface entries come from the shared builder so the file and the
    // daemon patch always agree (see buildPaseoProviderOverrides).
    const overrides = buildPaseoProviderOverrides(chat, messages, options);

    // pi additionalModels: keep prefixed ids to avoid duplicates in flat list.
    // Merge into whatever the user already has for `pi` (only replace the
    // gateway-owned field) so hand-added keys survive a sync.
    const pi = ensureObject(providers["pi"] ?? {}, "agents.providers.pi");
    pi["additionalModels"] = overrides.pi.additionalModels;
    providers["pi"] = pi;

    providers["gateway-codex"] = overrides["gateway-codex"];
    providers["gateway-claude"] = overrides["gateway-claude"];

    for (const key of Object.keys(providers)) {
      if (/^gateway-(codex|claude)-.+/.test(key)) delete providers[key];
    }

    agents["providers"] = providers;
    root["agents"] = agents;

    if (!options.dryRun) {
      await writeJsonAtomic(path, root);
    }
    return {
      path,
      ok: true,
      written: chat.length + messages.length,
    };
  } catch (err) {
    return {
      path,
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
