import { homedir } from "node:os";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { PaseoApi } from "@getpaseo/client";
// clearInterval is global
const HOME = process.env.HOME || homedir();

import { adminAvailable, adminStatus, adminStats, adminStatsOverview, adminCalls, adminCache, adminCacheClear, adminClearCalls, adminFlush, type AdminStatus, type AdminStats } from "./server/admin-client";
import { Storage, type Provider } from "./server/storage";
import { ResponseCache } from "./server/cache";
import { startGateway, type GatewayHandle } from "./server/gateway";
import { buildBootstrap, type BootstrapInput } from "./server/bootstrap";
import {
  buildPaseoProviderOverrides,
  syncAgentConfigs,
  type AgentConfigSyncResult,
  type PaseoProviderOverrides,
} from "./server/agent-config-sync";
import { modelRouting, providerProtocols, PROVIDER_TYPE_LABELS, formatModelLabel, isChatModel, type Protocol } from "./server/protocols";
import { aggregateStats, getPricing, clearCache, invalidateStatsCache, getCacheStatus } from "./server/token-stats";
import {
  listProviders,
  upsertProvider,
  deleteProvider,
  toggleProvider,
  gatewayStatus,
  gatewayStart,
  gatewayStop,
  overview,
  recentCalls,
  clearStats,
  cacheStatus,
  cacheConfig,
  cacheClear,
  catalogue,
  bootstrapAgent,
  syncAgentConfigsRpc,
  fetchProviderModelsList,
  syncProviderModelsNow,
  setProviderSyncInterval,
  providerSyncStatus,
  testProvider,
  tokenGetStats,
  tokenGetRecentRecords,
  tokenGetPricing,
  tokenRefresh,
  tokenClearCache,
  tokenGetCacheStatus,
} from "./shared/rpc";

const PLUGIN_VERSION = "0.9.0";

interface PluginState {
  storage: Storage;
  cache: ResponseCache;
  gateway: GatewayHandle | null;
  providers: Provider[];
  dataDir: string;
  flushTimer: NodeJS.Timeout | null;
  compactTimer: NodeJS.Timeout | null;
  syncTimer: NodeJS.Timeout | null;
  syncIntervalMs: number;
  lastSyncAt: number;
  lastSyncResults: Record<string, { at: number; ok: boolean; count: number; error?: string }>;
}

export default function contribute(server: PluginServerContext) {
  const FIXED_HOST = process.env.MODEL_GATEWAY_HOST || "127.0.0.1";

  // ---- Server-only state and RPC handlers ---------------------------
  // Data lives in ~/.paseo/cache/model-gateway/. The Paseo runtime does
  // not expose the plugin source directory to the bundled server code,
  // and `import.meta.dirname` is lost during bundling, so a stable
  // per-user location is the most reliable choice.
  const dataDir = `${HOME}/.paseo/cache/model-gateway`;

  const storage = new Storage(dataDir);
  const cache = new ResponseCache();

  const DEFAULT_SYNC_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

  const state: PluginState = {
    storage,
    cache,
    gateway: null,
    providers: [],
    dataDir,
    flushTimer: null,
    compactTimer: null,
    syncTimer: null,
    syncIntervalMs: DEFAULT_SYNC_INTERVAL_MS,
    lastSyncAt: 0,
    lastSyncResults: {},
  };

  /**
   * Daemon API handle captured from the first RPC context that runs a config
   * sync. Timer-driven and start-up syncs have no handler context, so they
   * leave this null and only write the files — a daemon that has just started
   * already read them from disk, so it needs no notification.
   */
  let paseoApi: PaseoApi | null = null;

  let initPromise: Promise<void> | null = null;
  async function ensureInit(): Promise<void> {
    if (initPromise) return initPromise;
    initPromise = (async () => {
      await storage.init();
      state.providers = await storage.loadProviders();
    })();
    return initPromise;
  }

  async function persistProviders(): Promise<void> {
    await storage.saveProviders(state.providers);
  }

  /**
   * Base URL the agent config files must point at, resolved from whatever
   * currently owns the data plane: gatewayd (survives daemon restarts and
   * binds its own port) first, then the in-process fallback gateway, then
   * the persisted port setting. Resolving it — instead of assuming
   * gatewayd's default port — is what keeps `~/.paseo/config.json` usable
   * while the TS gateway is dormant.
   */
  async function resolveLiveGatewayBase(): Promise<string | undefined> {
    try {
      const admin = await adminStatus();
      if (admin?.baseUrl) return admin.baseUrl.replace(/\/+$/, "");
    } catch {
      // gatewayd unreachable; fall through to the in-process gateway
    }
    if (state.gateway?.baseUrl) return state.gateway.baseUrl.replace(/\/+$/, "");
    await ensureInit();
    try {
      const settings = await storage.loadSettings();
      const port = Number(settings["gatewayPort"]);
      if (Number.isInteger(port) && port >= 1 && port <= 65535) return `http://${FIXED_HOST}:${port}`;
    } catch {
      // ignore — let agent-config-sync apply its own default
    }
    return undefined;
  }

  /**
   * Best-effort sync of the user's agent config files. Runs after every
   * provider CRUD so the model picker picks up the new `[<providerName>]`
   * model ids as soon as the provider is saved. Errors are logged but never
   * propagated — the originating RPC handler should not fail because a
   * config file is read-only or missing.
   */
  async function syncAgentConfigsBestEffort(paseo?: PaseoApi | null): Promise<void> {
    try {
      await ensureInit();
      const gatewayBase = await resolveLiveGatewayBase();
      const result = await syncAgentConfigs(state.providers, { gatewayBase });
      const piOk = result.pi.ok ? "✓" : "✗";
      const paOk = result.paseo.ok ? "✓" : "✗";
      console.log(
        `[model-gateway] agent config sync: pi ${piOk}${result.pi.written ?? 0}` +
        ` · paseo ${paOk}${result.paseo.written ?? 0}`,
      );
      if (!result.pi.ok) console.warn(`[model-gateway] pi sync failed: ${result.pi.reason}`);
      if (!result.paseo.ok) console.warn(`[model-gateway] paseo sync failed: ${result.paseo.reason}`);
      // Writing the file is only half the job (see applyPaseoProviderOverrides).
      await applyPaseoProviderOverrides(result.overrides, paseo ?? paseoApi);
    } catch (err) {
      console.error("[model-gateway] agent config sync crashed:", err);
    }
  }

  /**
   * Push the provider overrides into the *running daemon* so the model picker
   * reflects them at once.
   *
   * The daemon serves `listProviderModels` from an in-memory provider snapshot
   * it rebuilds on start-up or on a config patch. Writing
   * `~/.paseo/config.json` directly (what syncAgentConfigs does) therefore left
   * the picker showing the previous model set until the user ran
   * `paseo reload` or restarted — e.g. a `[Glm] glm-5.3-flash` claimant that
   * existed in gateway-codex/gateway-claude on disk but not in the picker.
   *
   * `paseo.config.patch` deep-merges into the daemon config, so the user's
   * unrelated providers survive, and the daemon re-resolves the providers we
   * named. Fully best-effort: a failure here must never fail the originating
   * RPC handler, the file write already landed and `paseo reload` recovers.
   */
  async function applyPaseoProviderOverrides(
    overrides: PaseoProviderOverrides,
    paseo?: PaseoApi | null,
  ): Promise<void> {
    if (!paseo) return;
    try {
      await paseo.config.patch({
        providers: {
          pi: overrides.pi,
          "gateway-codex": overrides["gateway-codex"],
          "gateway-claude": overrides["gateway-claude"],
        },
      });
    } catch (err) {
      console.warn(
        "[model-gateway] daemon config patch failed; run `paseo reload` to refresh the model picker:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Snapshot the runtime state into the bootstrap payload shape. Called by
  // both the RPC handler and the HTTP /v1/agents/bootstrap route so both
  // surfaces return identical data (including `[<userProviderName>] <model>`
  // labels the agent picker uses to identify each upstream).
  async function snapshotBootstrap(input: BootstrapInput = {}): Promise<ReturnType<typeof buildBootstrap>> {
    await ensureInit();
    return buildBootstrap(
      {
        providers: state.providers,
        gateway: {
          running: !!state.gateway,
          baseUrl: state.gateway?.baseUrl ?? null,
          port: state.gateway?.port ?? null,
          host: state.gateway?.host ?? FIXED_HOST,
          version: PLUGIN_VERSION,
        },
        sync: {
          intervalMs: state.syncIntervalMs,
          lastSyncAt: state.lastSyncAt,
          results: state.lastSyncResults,
        },
      },
      input,
    );
  }

  async function startGatewayServer(): Promise<GatewayHandle> {
    if (state.gateway) return state.gateway;
    await ensureInit();
    // Persistent port wins so reloads/daemon restarts keep the same address
    // that downstream agent providers are configured against; env var is the
    // escape hatch for one-shot overrides, random port only as last resort.
    const settings = await storage.loadSettings();
    const persisted = Number(settings["gatewayPort"]);
    const envPort = Math.max(0, Math.min(65535, parseInt(process.env.MODEL_GATEWAY_PORT || "0", 10) || 0));
    const port = Number.isInteger(persisted) && persisted >= 1 && persisted <= 65535 ? persisted : (envPort || 0);
    const handle = await startGateway(
      {
        getProviders: async () => {
          await ensureInit();
          return state.providers;
        },
        recordCall: (c) => storage.recordCall(c),
        recordBytes: (i, o) => storage.recordBytes(i, o),
        getBootstrap: async (input) => snapshotBootstrap(input),
        cache,
      },
      { port, host: FIXED_HOST }
    );
    state.gateway = handle;
    return handle;
  }

  // Pull upstream /v1/models for one provider and persist the merged list.
  async function syncProviderModels(provider: Provider): Promise<{ count: number }> {
    const { getAdapter } = await import("./server/providers/index");
    const adapter = getAdapter(provider.type);
    if (typeof adapter.listModels !== "function") {
      throw new Error(`${provider.type} provider does not expose a model catalogue`);
    }
    const { models: upstream } = await adapter.listModels(provider);
    // Merge: keep user's manual entries that the upstream doesn't expose, then
    // append the upstream list (deduped). This way custom aliases survive.
    const existing = new Set(provider.models);
    const merged = provider.models.slice();
    for (const m of upstream) {
      if (!existing.has(m)) merged.push(m);
      existing.add(m);
    }
    const idx = state.providers.findIndex((p) => p.id === provider.id);
    if (idx >= 0) {
      state.providers[idx] = { ...state.providers[idx], models: merged, updatedAt: Date.now() };
      await persistProviders();
    }
    return { count: upstream.length };
  }

  async function syncAllProviderModels(): Promise<Record<string, unknown>> {
    const results: Record<string, { at: number; ok: boolean; count: number; error?: string }> = {};
    const enabled = state.providers.filter((p) => p.enabled);
    for (const p of enabled) {
      try {
        const { count } = await syncProviderModels(p);
        results[p.id] = { at: Date.now(), ok: true, count };
      } catch (err) {
        results[p.id] = {
          at: Date.now(),
          ok: false,
          count: 0,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
    state.lastSyncAt = Date.now();
    state.lastSyncResults = results;
    return results;
  }

  function scheduleTimers(): void {
    if (state.flushTimer) clearInterval(state.flushTimer);
    state.flushTimer = (setInterval(() => {
      if (!state.providers.length && !state.gateway) return; // skip when fully idle
      storage.flushAggregates().catch((err) => {
        console.error("[model-gateway] flush aggregates failed:", err);
      });
    }, 15_000) as unknown as NodeJS.Timeout);

    if (state.compactTimer) clearInterval(state.compactTimer);
    state.compactTimer = (setInterval(() => {
      storage.compactCalls(7 * 24 * 60 * 60 * 1000).catch((err) => {
        console.error("[model-gateway] compact failed:", err);
      });
    }, 60 * 60 * 1000) as unknown as NodeJS.Timeout);

    if (state.syncTimer) clearInterval(state.syncTimer);
    state.syncTimer = (setInterval(() => {
      if (!state.providers.length) return; // skip when fully idle
      syncAllProviderModels()
        // Re-write the agent configs after a catalogue refresh: providers.json
        // gaining upstream models used to leave the Paseo picker showing the
        // previous set until the next provider CRUD or daemon restart.
        .then(() => syncAgentConfigsBestEffort(paseoApi))
        .catch((err) => {
          console.error("[model-gateway] provider model sync failed:", err);
        });
    }, state.syncIntervalMs) as unknown as NodeJS.Timeout);
  }

  // ---- RPC handlers ---------------------------------------------------------

  server.handle(listProviders, async () => {
    await ensureInit();
    return { providers: state.providers };
  });

  server.handle(upsertProvider, async (input, ctx) => {
    paseoApi ??= ctx.paseo;
    await ensureInit();
    const now = Date.now();
    const idx = state.providers.findIndex((p) => p.id === input.id);
    const next: Provider = {
      id: input.id,
      name: input.name,
      type: input.type,
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      models: input.models,
      priority: input.priority,
      weight: input.weight,
      enabled: input.enabled,
      rateLimitRpm: input.rateLimitRpm,
      timeoutMs: input.timeoutMs,
      notes: input.notes,
      ...(typeof input.maxOutputTokens === "number" ? { maxOutputTokens: input.maxOutputTokens } : {}),
      ...(typeof input.contextWindow === "number" ? { contextWindow: input.contextWindow } : {}),
      ...(typeof input.exposeMessages === "boolean" ? { exposeMessages: input.exposeMessages } : {}),
      createdAt: idx >= 0 ? state.providers[idx].createdAt : now,
      updatedAt: now,
    };
    if (idx >= 0) state.providers[idx] = next;
    else state.providers.push(next);
    await persistProviders();
    void syncAgentConfigsBestEffort(paseoApi);
    return next;
  });

  server.handle(deleteProvider, async ({ id }, ctx) => {
    paseoApi ??= ctx.paseo;
    await ensureInit();
    const before = state.providers.length;
    state.providers = state.providers.filter((p) => p.id !== id);
    await persistProviders();
    void syncAgentConfigsBestEffort(paseoApi);
    return { ok: state.providers.length < before };
  });

  server.handle(toggleProvider, async ({ id, enabled }, ctx) => {
    paseoApi ??= ctx.paseo;
    await ensureInit();
    const idx = state.providers.findIndex((p) => p.id === id);
    if (idx < 0) throw new Error(`Unknown provider: ${id}`);
    state.providers[idx] = { ...state.providers[idx], enabled, updatedAt: Date.now() };
    await persistProviders();
    void syncAgentConfigsBestEffort(paseoApi);
    return state.providers[idx];
  });

  server.handle(gatewayStatus, async () => {
    // gatewayd (standalone process) takes precedence: it survives daemon
    // restarts and owns the data plane once migrated.
    const admin = await adminStatus();
    if (admin) return admin;
    await ensureInit();
    const c = storage.counters();
    return {
      running: !!state.gateway,
      baseUrl: state.gateway?.baseUrl ?? null,
      port: state.gateway?.port ?? null,
      host: state.gateway?.host ?? "127.0.0.1",
      startedAt: state.gateway?.startedAt ?? null,
      pid: state.gateway?.pid ?? null,
      requests: c.requests,
      bytesIn: c.bytesIn,
      bytesOut: c.bytesOut,
      dataDir: state.dataDir,
    };
  });

  server.handle(gatewayStart, async (input) => {
    // When gatewayd (standalone process) is already running, the data plane
    // is owned by it — starting the in-process gateway would double-bind the
    // port. Report the gatewayd status instead.
    const admin = await adminStatus();
    if (admin && admin.baseUrl && admin.port != null) {
      return { baseUrl: admin.baseUrl, port: admin.port, host: admin.host };
    }
    await ensureInit();
    const settings = await storage.loadSettings();
    const persisted = Number(settings["gatewayPort"]);
    const fallback = Number.isInteger(persisted) && persisted >= 1 && persisted <= 65535 ? persisted : 0;
    const port = input?.port ?? fallback;
    const host = input?.host ?? FIXED_HOST;
    if (input?.port) {
      await storage.saveSettings({ ...settings, gatewayPort: input.port });
    }
    if (state.gateway) await state.gateway.close();
    const handle = await startGateway(
      {
        getProviders: async () => {
          await ensureInit();
          return state.providers;
        },
        recordCall: (c) => storage.recordCall(c),
        recordBytes: (i, o) => storage.recordBytes(i, o),
        getBootstrap: async (input) => snapshotBootstrap(input),
        cache,
      },
      { port, host }
    );
    state.gateway = handle;
    if (!state.flushTimer) scheduleTimers();
    return { baseUrl: handle.baseUrl, port: handle.port, host: handle.host };
  });

  server.handle(gatewayStop, async () => {
    // gatewayd lifecycle is managed by systemd; the plugin can only stop the
    // in-process fallback gateway.
    if (!state.gateway) return { ok: true };
    await state.gateway.close();
    state.gateway = null;
    return { ok: true };
  });

  server.handle(overview, async ({ windowMinutes }) => {
    // When gatewayd owns the data plane, aggregate from its ring buffer via
    // the windowed overview endpoint. Reading percentiles / byModel /
    // timeseries from the same endpoint that keeps them is what stops the
    // panel from showing a wall of zeros next to a non-zero request count
    // (the old path only had instantaneous counters to work with).
    const ov = await adminStatsOverview(windowMinutes);
    if (ov) {
      return {
        windowMinutes,
        requests: ov.requests,
        errors: ov.errors,
        errorRate: ov.errorRate ?? (ov.requests > 0 ? ov.errors / ov.requests : 0),
        // Prefer the aggregate gatewayd already computed; the byProvider sum
        // is only a fallback for an older gatewayd that omits it. Summing the
        // per-provider rows looked equivalent but silently under-reports the
        // moment that array is capped or bucketed differently.
        promptTokens: ov.promptTokens ?? ov.byProvider.reduce((acc, p) => acc + (p.promptTokens ?? 0), 0),
        completionTokens: ov.completionTokens ?? ov.byProvider.reduce((acc, p) => acc + (p.completionTokens ?? 0), 0),
        totalTokens: ov.totalTokens ?? ov.byProvider.reduce((acc, p) => acc + (p.promptTokens ?? 0) + (p.completionTokens ?? 0), 0),
        avgDurationMs: ov.avgDurationMs,
        p50DurationMs: ov.p50DurationMs,
        p95DurationMs: ov.p95DurationMs,
        p99DurationMs: ov.p99DurationMs,
        avgTtfbMs: ov.avgTtfbMs,
        p95TtfbMs: ov.p95TtfbMs,
        cacheHits: ov.cacheHits,
        cacheHitRate: ov.requests > 0 ? ov.cacheHits / ov.requests : 0,
        byProvider: ov.byProvider.map((p) => ({
          provider: p.provider,
          requests: p.requests,
          errors: p.errors,
          promptTokens: p.promptTokens,
          completionTokens: p.completionTokens,
          avgDurationMs: p.avgDurationMs,
        })),
        byModel: ov.byModel.map((m) => ({
          provider: m.provider ?? "",
          model: m.model,
          requests: m.requests,
          errors: m.errors,
          promptTokens: m.promptTokens,
          completionTokens: m.completionTokens,
          avgDurationMs: m.avgDurationMs,
        })),
        timeseries: ov.timeseries.map((t) => ({
          bucket: t.bucket,
          requests: t.requests,
          errors: t.errors,
          tokens: t.tokens,
        })),
      };
    }
    await ensureInit();
    const agg = storage.aggregateWindow(windowMinutes * 60_000);
    return { windowMinutes, ...agg };
  });

  server.handle(recentCalls, async ({ limit, provider, status }) => {
    // gatewayd owns the live call ring once migrated; push the filters down
    // so the 500-row page survives the query instead of being sliced from a
    // 100-row default page.
    const admin = await adminCalls({ limit, provider, status });
    if (admin) {
      // gatewayd already applies provider/status *and* the limit, so the rows
      // below are exactly the page the panel asked for. Map them explicitly
      // instead of casting: the RPC output schema is validated, and a cast
      // trusts every field name to line up by accident.
      const calls = admin.slice(0, limit).map((c) => ({
        id: String(c["id"] ?? ""),
        ts: Number(c["ts"] ?? 0),
        provider: String(c["provider"] ?? ""),
        model: String(c["model"] ?? ""),
        endpoint: String(c["endpoint"] ?? ""),
        status: (c["status"] === "ok" ? "ok" : "error") as "ok" | "error",
        ...(c["statusCode"] != null ? { statusCode: Number(c["statusCode"]) } : {}),
        ...(c["promptTokens"] != null ? { promptTokens: Number(c["promptTokens"]) } : {}),
        ...(c["completionTokens"] != null ? { completionTokens: Number(c["completionTokens"]) } : {}),
        ...(c["totalTokens"] != null ? { totalTokens: Number(c["totalTokens"]) } : {}),
        durationMs: Number(c["durationMs"] ?? 0),
        ...(c["ttfbMs"] != null ? { ttfbMs: Number(c["ttfbMs"]) } : {}),
        stream: c["stream"] === true,
        ...(typeof c["error"] === "string" ? { error: c["error"] } : {}),
      }));
      return { calls };
    }
    await ensureInit();
    const calls = storage.recentCalls(limit, { provider, status });
    return { calls };
  });

  server.handle(clearStats, async () => {
    await ensureInit();
    await storage.resetAll();
    cache.clear();
    // Clear the data plane too: with gatewayd owning :39000 the ring the panel
    // reads lives inside the gatewayd process, so a plugin-side-only reset left
    // the panel's "clear stats" button a no-op.
    const cleared = await adminClearCalls();
    if (!cleared) {
      console.warn(
        "[model-gateway] stats.clear: data-plane call ring was not cleared (gatewayd admin unreachable?)",
      );
    }
    await adminCacheClear();
    await adminFlush();
    return { ok: true };
  });

  server.handle(cacheStatus, async () => {
    const admin = await adminCache();
    if (admin) {
      const stats = (admin.stats ?? {}) as { hits?: number; misses?: number };
      const hits = stats.hits ?? 0;
      const misses = stats.misses ?? 0;
      return {
        enabled: (admin.enabled as boolean) ?? true,
        entries: (admin.entries as number) ?? 0,
        maxEntries: (admin.maxEntries as number) ?? 1024,
        hitRate: hits + misses > 0 ? hits / (hits + misses) : 0,
        hits,
        misses,
      };
    }
    const snap = cache.snapshot();
    const total = snap.stats.hits + snap.stats.misses;
    return {
      enabled: snap.enabled,
      entries: snap.entries,
      maxEntries: snap.maxEntries,
      hitRate: total > 0 ? snap.stats.hits / total : 0,
      hits: snap.stats.hits,
      misses: snap.stats.misses,
    };
  });

  server.handle(cacheConfig, async ({ enabled, maxEntries, ttlSeconds }) => {
    cache.configure({ enabled, maxEntries, ttlSeconds });
    const snap = cache.snapshot();
    return { enabled: snap.enabled, maxEntries: snap.maxEntries, ttlSeconds: snap.ttlSeconds };
  });

  server.handle(cacheClear, async () => {
    const ok = await adminCacheClear();
    if (ok) return { ok: true };
    cache.clear();
    return { ok: true };
  });

  server.handle(catalogue, async () => {
    await ensureInit();
    // Build a per-model view: which providers claim the model (incl.
    // wildcards), what protocols they collectively support, and the
    // highest-priority one. Replaces the older "model → single primary
    // provider" view so agents can pick a different tier via the body
    // `provider` field without a separate fetch_models round-trip.
    const grouped = new Map<string, { model: string; claiming: Provider[] }>();
    for (const p of state.providers) {
      if (!p.enabled) continue;
      for (const m of p.models) {
        // Same chat-only filter the agent picker applies, so this catalogue
        // and the conversation model selectors list the same models. Without
        // it the panel advertised 90 entries (ASR/image/audio included) while
        // only 51 were actually selectable.
        if (!isChatModel(m)) continue;
        const entry = grouped.get(m) ?? { model: m, claiming: [] };
        entry.claiming.push(p);
        grouped.set(m, entry);
      }
    }
    // Also surface models that any wildcard (`models=[]`) provider claims
    // even if no provider lists them explicitly — those are the agents'
    // actual targets, and silently dropping them used to confuse the UI.
    const wildcards = state.providers.filter((p) => p.enabled && p.models.length === 0);
    if (wildcards.length > 0) {
      const known = new Set(grouped.keys());
      for (const w of wildcards) {
        for (const m of known) {
          const entry = grouped.get(m)!;
          if (!entry.claiming.includes(w)) entry.claiming.push(w);
        }
      }
    }
    const models: Array<{
      model: string;
      provider: string;
      providerName: string;
      providerType: Provider["type"];
      providerTypeLabel: string;
      label: string;
      protocols: Protocol[];
      claimingProviders: Array<{ id: string; name: string; type: Provider["type"]; typeLabel: string; label: string; protocols: Protocol[] }>;
    }> = [];
    for (const { model, claiming } of grouped.values()) {
      const sorted = claiming.slice().sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        return b.weight - a.weight;
      });
      const primary = sorted[0];
      const protocols = new Set<Protocol>();
      for (const p of claiming) for (const pr of providerProtocols(p)) protocols.add(pr);
      models.push({
        model,
        provider: primary.id,
        providerName: primary.name,
        providerType: primary.type,
        providerTypeLabel: PROVIDER_TYPE_LABELS[primary.type],
        label: formatModelLabel(primary, model),
        protocols: [...protocols],
        claimingProviders: sorted.map((p) => ({
          id: p.id,
          name: p.name,
          type: p.type,
          typeLabel: PROVIDER_TYPE_LABELS[p.type],
          label: formatModelLabel(p, model),
          protocols: providerProtocols(p),
        })),
      });
    }
    return { models };
  });

  server.handle(bootstrapAgent, async ({ includeRaw }) => {
    return snapshotBootstrap({ includeRaw });
  });

  server.handle(fetchProviderModelsList, async (input) => {
    // No ensureInit() — we don't touch storage. The handler only needs the
    // adapter to call its upstream catalogue endpoint.
    // Reconstruct a Provider draft from the input. id/createdAt/updatedAt
    // aren't required because the adapter only needs baseUrl/apiKey/type
    // to call its upstream catalogue endpoint.
    const draft: Provider = {
      id: input.name || "draft",
      name: input.name,
      type: input.type,
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      models: input.models,
      priority: input.priority,
      weight: input.weight,
      enabled: input.enabled,
      rateLimitRpm: input.rateLimitRpm,
      timeoutMs: input.timeoutMs,
      notes: input.notes,
      createdAt: 0,
      updatedAt: 0,
    };
    const { getAdapter } = await import("./server/providers/index");
    const adapter = getAdapter(draft.type);
    if (typeof adapter.listModels !== "function") {
      throw new Error(`${draft.type} provider does not expose a model catalogue`);
    }
    const url = adapter.buildUrl(draft, "models");
    const { models: upstream } = await adapter.listModels(draft);
    return { models: upstream, endpoint: url };
  });

  server.handle(syncProviderModelsNow, async ({ id }, ctx) => {
    paseoApi ??= ctx.paseo;
    await ensureInit();
    if (id) {
      const p = state.providers.find((x) => x.id === id);
      if (!p) throw new Error(`Unknown provider: ${id}`);
      const { count } = await syncProviderModels(p);
      state.lastSyncResults[id] = { at: Date.now(), ok: true, count };
    } else {
      await syncAllProviderModels();
    }
    state.lastSyncAt = Date.now();
    // Keep the picker in lockstep with the refreshed catalogue (same reason
    // as the periodic timer above).
    await syncAgentConfigsBestEffort(paseoApi);
    return { results: state.lastSyncResults, lastSyncAt: state.lastSyncAt };
  });

  server.handle(setProviderSyncInterval, async ({ intervalMs }) => {
    await ensureInit();
    state.syncIntervalMs = intervalMs;
    if (state.syncTimer) clearInterval(state.syncTimer);
    if (intervalMs > 0) {
      state.syncTimer = (setInterval(() => {
        if (!state.providers.length) return;
        syncAllProviderModels().catch((err) => {
          console.error("[model-gateway] provider model sync failed:", err);
        });
      }, intervalMs) as unknown as NodeJS.Timeout);
    } else {
      state.syncTimer = null;
    }
    const nextSyncAt = intervalMs > 0 ? Date.now() + intervalMs : 0;
    return { intervalMs, nextSyncAt };
  });

  server.handle(providerSyncStatus, async () => {
    await ensureInit();
    return {
      intervalMs: state.syncIntervalMs,
      lastSyncAt: state.lastSyncAt,
      results: state.lastSyncResults,
    };
  });

  server.handle(testProvider, async ({ id }) => {
    await ensureInit();
    const provider = state.providers.find((p) => p.id === id);
    if (!provider) {
      return { ok: false, status: null, latencyMs: 0, upstreamModels: [], error: `Unknown provider: ${id}` };
    }
    const { getAdapter } = await import("./server/providers/index");
    const adapter = getAdapter(provider.type);
    const url = adapter.buildUrl(provider, "models");
    const headers = adapter.buildHeaders(provider);
    const started = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), provider.timeoutMs);
    try {
      const res = await fetch(url, { method: "GET", headers, signal: controller.signal } as RequestInit);
      const text = await res.text();
      let models: string[] = [];
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed?.data)) {
          models = parsed.data.map((m: { id?: string }) => m.id ?? "").filter(Boolean);
        } else if (Array.isArray(parsed)) {
          models = parsed.map((m: { id?: string; name?: string }) => m.id ?? m.name ?? "").filter(Boolean);
        }
      } catch { /* unparseable - leave models empty */ }
      return {
        ok: res.ok,
        status: res.status,
        latencyMs: Date.now() - started,
        upstreamModels: models,
        ...(res.ok ? {} : { error: text.slice(0, 500) }),
      };
    } catch (err) {
      return {
        ok: false,
        status: null,
        latencyMs: Date.now() - started,
        upstreamModels: [],
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearTimeout(timeout);
    }
  });

  server.handle(syncAgentConfigsRpc, async (_input, ctx) => {
    paseoApi ??= ctx.paseo;
    await ensureInit();
    const gatewayBase = await resolveLiveGatewayBase();
    const result = await syncAgentConfigs(state.providers, { gatewayBase });
    await applyPaseoProviderOverrides(result.overrides, ctx.paseo);
    return {
      pi: { path: result.pi.path, ok: result.pi.ok, reason: result.pi.reason, written: result.pi.written },
      paseo: { path: result.paseo.path, ok: result.paseo.ok, reason: result.paseo.reason, written: result.paseo.written },
    };
  });

  // ---- Token usage tracking (migrated from paseo-hub) -------------------------

  server.handle(tokenGetStats, async ({ sinceDays, workspace }) => {
    const { stats } = await aggregateStats(sinceDays, workspace);
    return stats;
  });

  server.handle(tokenGetRecentRecords, async ({ sinceDays, limit, workspace }) => {
    const { records } = await aggregateStats(sinceDays, workspace);
    return { records: records.slice(-limit).reverse(), total: records.length };
  });

  server.handle(tokenGetPricing, async () => await getPricing());

  server.handle(tokenRefresh, async () => {
    const result = await invalidateStatsCache();
    return { ok: true, scannedAt: new Date().toISOString(), clearedStatsEntries: result.cleared };
  });

  server.handle(tokenClearCache, async () => await clearCache());

  server.handle(tokenGetCacheStatus, async () => await getCacheStatus());

  // Auto-start the gateway on plugin load. When the standalone gatewayd
  // (MoonBit) process is already serving the data plane, the in-process
  // gateway stays dormant — the panel's status/overview/calls/cache RPCs
  // proxy to its admin plane (see admin-client.ts) and double-binding the
  // port would crash-loop whichever process starts second.
  void (async () => {
    try {
      await ensureInit();
      // Dormant only when gatewayd binds the port THIS plugin would use
      // (the persisted 39000). A gatewayd on another port (coexistence /
      // test mode) leaves production traffic on the in-process gateway.
      const admin = await adminStatus();
      const settings = await storage.loadSettings();
      const persisted = Number(settings["gatewayPort"]);
      const ownsOurPort = admin != null && admin.port != null && admin.port === persisted;
      if (ownsOurPort) {
        console.log(`[model-gateway] gatewayd owns :${admin.port}; in-process gateway dormant`);
        console.log(`[model-gateway] data dir: ${state.dataDir}`);
      } else {
        await startGatewayServer();
        scheduleTimers();
        console.log(`[model-gateway] listening on ${state.gateway?.baseUrl}`);
        console.log(`[model-gateway] data dir: ${state.dataDir}`);
      }
      // Kick off an initial model catalogue sync so newly added providers
      // pick up upstream models without the user clicking a button. Failures
      // here are non-fatal — the periodic timer will retry.
      const enabled = state.providers.filter((p) => p.enabled);
      if (enabled.length > 0) {
        syncAllProviderModels()
          .then((results) => {
            const ok = Object.values(results).filter((r) => (r as { ok: boolean }).ok).length;
            const total = enabled.length;
            console.log(`[model-gateway] initial sync: ${ok}/${total} providers updated`);
            // After the first catalogue sync, write the agent config files
            // so the picker picks up the new `[<providerName>] <model>` ids
            // without the user running any external script.
            return syncAgentConfigsBestEffort(paseoApi);
          })
          .catch((err) => {
            console.error("[model-gateway] initial sync failed:", err);
          });
      } else {
        // No upstream providers yet — still write (clears stale entries).
        void syncAgentConfigsBestEffort(paseoApi);
      }
    } catch (err) {
      console.error("[model-gateway] auto-start failed:", err);
    }
  })();

  return async () => {
    if (state.flushTimer) clearInterval(state.flushTimer);
    if (state.compactTimer) clearInterval(state.compactTimer);
    if (state.syncTimer) clearInterval(state.syncTimer);
    if (state.gateway) {
      try { await state.gateway.close(); } catch { /* ignore */ }
      state.gateway = null;
    }
    try { await storage.flushAggregates(); } catch { /* ignore */ }
    storage.close();
  };
}
