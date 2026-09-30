import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// ---- Provider CRUD --------------------------------------------------------------

export const providerTypeSchema = z.enum([
  "openai",
  "openai-compatible",
  "azure-openai",
  "anthropic",
  "google",
  "ollama",
  "zhipu",
  "volcengine",
]);

export const providerSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: providerTypeSchema,
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  models: z.array(z.string()).default([]),
  priority: z.number().int().min(0).default(0),
  weight: z.number().int().min(1).max(1000).default(100),
  enabled: z.boolean().default(true),
  rateLimitRpm: z.number().int().min(0).default(0),
  timeoutMs: z.number().int().min(1000).max(600_000).default(120_000),
  notes: z.string().optional(),
  /** Ceiling for Responses-API max_output_tokens on this provider (see Provider.maxOutputTokens). */
  maxOutputTokens: z.number().int().min(1).optional(),
  /** Context window in tokens (see Provider.contextWindow). */
  contextWindow: z.number().int().min(1).optional(),
  /** Opt-in: advertise this provider's models on the Claude Code (Anthropic
   *  Messages) surface too, even when the provider type is not natively
   *  anthropic (see Provider.exposeMessages). */
  exposeMessages: z.boolean().optional(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});

export const listProviders = defineRpc({
  name: "gateway.providers.list",
  input: z.object({}),
  output: z.object({ providers: z.array(providerSchema) }),
});

export const upsertProvider = defineRpc({
  name: "gateway.providers.upsert",
  input: providerSchema.omit({ createdAt: true, updatedAt: true }),
  output: providerSchema,
});

export const deleteProvider = defineRpc({
  name: "gateway.providers.delete",
  input: z.object({ id: z.string() }),
  output: z.object({ ok: z.boolean() }),
});

export const toggleProvider = defineRpc({
  name: "gateway.providers.toggle",
  input: z.object({ id: z.string(), enabled: z.boolean() }),
  output: providerSchema,
});

// ---- Gateway control ------------------------------------------------------------

export const gatewayStatus = defineRpc({
  name: "gateway.status",
  input: z.object({}),
  output: z.object({
    running: z.boolean(),
    baseUrl: z.string().nullable(),
    port: z.number().int().nullable(),
    host: z.string(),
    startedAt: z.number().int().nullable(),
    pid: z.number().int().nullable(),
    requests: z.number().int(),
    bytesIn: z.number().int(),
    bytesOut: z.number().int(),
    dataDir: z.string(),
  }),
});

export const gatewayStart = defineRpc({
  name: "gateway.start",
  input: z.object({
    port: z.number().int().min(1).max(65535).optional(),
    host: z.string().optional(),
  }),
  output: z.object({ baseUrl: z.string(), port: z.number().int(), host: z.string() }),
});

export const gatewayStop = defineRpc({
  name: "gateway.stop",
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
});

// ---- Stats / telemetry ----------------------------------------------------------

export const overview = defineRpc({
  name: "gateway.stats.overview",
  input: z.object({
    windowMinutes: z.number().int().min(1).max(60 * 24 * 14).default(60),
  }),
  output: z.object({
    windowMinutes: z.number().int(),
    requests: z.number().int(),
    errors: z.number().int(),
    errorRate: z.number(),
    promptTokens: z.number().int(),
    completionTokens: z.number().int(),
    totalTokens: z.number().int(),
    avgDurationMs: z.number(),
    p50DurationMs: z.number(),
    p95DurationMs: z.number(),
    p99DurationMs: z.number(),
    avgTtfbMs: z.number(),
    p95TtfbMs: z.number(),
    cacheHits: z.number().int(),
    cacheHitRate: z.number(),
    byProvider: z.array(
      z.object({
        provider: z.string(),
        requests: z.number().int(),
        errors: z.number().int(),
        promptTokens: z.number().int(),
        completionTokens: z.number().int(),
        avgDurationMs: z.number(),
      }),
    ),
    byModel: z.array(
      z.object({
        model: z.string(),
        provider: z.string(),
        requests: z.number().int(),
        errors: z.number().int(),
        promptTokens: z.number().int(),
        completionTokens: z.number().int(),
        avgDurationMs: z.number(),
      }),
    ),
    timeseries: z.array(
      z.object({
        bucket: z.number().int(),
        requests: z.number().int(),
        errors: z.number().int(),
        tokens: z.number().int(),
      }),
    ),
  }),
});

export const recentCalls = defineRpc({
  name: "gateway.stats.recent",
  input: z.object({
    limit: z.number().int().min(1).max(500).default(50),
    provider: z.string().optional(),
    status: z.enum(["ok", "error"]).optional(),
  }),
  output: z.object({
    calls: z.array(
      z.object({
        id: z.string(),
        ts: z.number().int(),
        provider: z.string(),
        model: z.string(),
        endpoint: z.string(),
        status: z.enum(["ok", "error"]),
        statusCode: z.number().int().optional(),
        promptTokens: z.number().int().optional(),
        completionTokens: z.number().int().optional(),
        totalTokens: z.number().int().optional(),
        durationMs: z.number().int(),
        ttfbMs: z.number().int().optional(),
        stream: z.boolean(),
        error: z.string().optional(),
      }),
    ),
  }),
});

export const clearStats = defineRpc({
  name: "gateway.stats.clear",
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
});

// ---- Cache management -----------------------------------------------------------

export const cacheStatus = defineRpc({
  name: "gateway.cache.status",
  input: z.object({}),
  output: z.object({
    enabled: z.boolean(),
    entries: z.number().int(),
    maxEntries: z.number().int(),
    hitRate: z.number(),
    hits: z.number().int(),
    misses: z.number().int(),
  }),
});

export const cacheConfig = defineRpc({
  name: "gateway.cache.config",
  input: z.object({
    enabled: z.boolean(),
    maxEntries: z.number().int().min(0).max(100_000),
    ttlSeconds: z.number().int().min(0).max(86_400),
  }),
  output: z.object({
    enabled: z.boolean(),
    maxEntries: z.number().int(),
    ttlSeconds: z.number().int(),
  }),
});

export const cacheClear = defineRpc({
  name: "gateway.cache.clear",
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
});

// ---- Live model catalogue -------------------------------------------------------

const protocolSchema = z.enum(["chat", "responses", "messages"]);

export const catalogue = defineRpc({
  name: "gateway.catalogue",
  input: z.object({}),
  output: z.object({
    models: z.array(
      z.object({
        model: z.string(),
        provider: z.string(),
        providerName: z.string(),
        providerType: providerTypeSchema,
        providerTypeLabel: z.string(),
        // "[<userProviderName>] <model>" — distinct per upstream even when
        // two providers share a type. Drop straight into a model picker.
        label: z.string(),
        // Aggregated across claiming providers; lets an agent pick the right
        // protocol surface (chat/responses/messages) without probing each one.
        protocols: z.array(protocolSchema),
        // Every enabled provider that claims this model, so the agent can
        // pick a different routing tier by setting `provider` in the body.
        claimingProviders: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            type: providerTypeSchema,
            typeLabel: z.string(),
            label: z.string(),
            protocols: z.array(protocolSchema),
          }),
        ),
      }),
    ),
  }),
});


// ---- Agent bootstrap ----------------------------------------------------------
//
// One-shot RPC an agent calls at boot to discover everything it needs:
// gateway URL, sync state, sanitized provider list, and the catalogue with
// per-model protocol/claiming-provider metadata. Replaces the manual Python
// sync scripts that previously rewrote ~/.pi/agent/models.json and
// ~/.paseo/config.json by hand.

export const bootstrapAgent = defineRpc({
  name: "gateway.agent.bootstrap",
  input: z.object({
    /**
     * Include the raw per-provider model list (upstream-discovered + manual
     * entries). When false, only the aggregated catalogue is returned —
     * smaller payload, sufficient for most agents.
     */
    includeRaw: z.boolean().default(false),
  }),
  output: z.object({
    gateway: z.object({
      running: z.boolean(),
      baseUrl: z.string().nullable(),
      port: z.number().int().nullable(),
      host: z.string(),
      version: z.string(),
    }),
    sync: z.object({
      intervalMs: z.number().int(),
      lastSyncAt: z.number().int(),
      results: z.record(
        z.string(),
        z.object({
          at: z.number().int(),
          ok: z.boolean(),
          count: z.number().int(),
          error: z.string().optional(),
        }),
      ),
    }),
    // Localised provider-type display names (e.g. "智谱 GLM"), keyed by type.
    // Agents can group/filter models in the picker without shipping their
    // own copy of the mapping.
    providerTypeLabels: z.record(z.string(), z.string()),
    providers: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        type: providerTypeSchema,
        typeLabel: z.string(),
        enabled: z.boolean(),
        priority: z.number().int(),
        weight: z.number().int(),
        models: z.array(z.string()),
        modelCount: z.number().int(),
        notes: z.string().optional(),
        rateLimitRpm: z.number().int(),
        timeoutMs: z.number().int(),
        hasApiKey: z.boolean(),
        protocols: z.array(protocolSchema),
      }),
    ),
    catalogue: z.array(
      z.object({
        model: z.string(),
        primaryProvider: z.string(),
        primaryProviderName: z.string(),
        primaryProviderType: providerTypeSchema,
        primaryProviderTypeLabel: z.string(),
        label: z.string(),
        protocols: z.array(protocolSchema),
        claimingProviders: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            type: providerTypeSchema,
            typeLabel: z.string(),
            label: z.string(),
            protocols: z.array(protocolSchema),
          }),
        ),
      }),
    ),
  }),
});


// ---- Provider model discovery --------------------------------------------------

export const fetchProviderModelsList = defineRpc({
  name: "gateway.providers.fetch_models",
  // Draft provider input — no id/createdAt/updatedAt. Everything except
  // apiKey is required so the upstream URL can be built correctly.
  input: z.object({
    type: providerTypeSchema,
    name: z.string().min(1),
    baseUrl: z.string().optional(),
    apiKey: z.string().optional(),
    models: z.array(z.string()).default([]),
    priority: z.number().int().min(0).default(0),
    weight: z.number().int().min(1).max(1000).default(100),
    enabled: z.boolean().default(true),
    rateLimitRpm: z.number().int().min(0).default(0),
    timeoutMs: z.number().int().min(1000).max(600_000).default(120_000),
    notes: z.string().optional(),
    maxOutputTokens: z.number().int().min(1).optional(),
    contextWindow: z.number().int().min(1).optional(),
    exposeMessages: z.boolean().optional(),
  }),
  output: z.object({
    models: z.array(z.string()),
    raw: z.unknown().optional(),
    endpoint: z.string(),
  }),
});

// ---- Provider model sync -------------------------------------------------------

// Trigger an immediate /v1/models refresh for every enabled provider, or just
// the one whose id is passed. Returns a map of provider id -> result.
export const syncProviderModelsNow = defineRpc({
  name: "gateway.providers.sync_now",
  input: z.object({ id: z.string().optional() }),
  output: z.object({
    results: z.record(
      z.string(),
      z.object({
        at: z.number().int(),
        ok: z.boolean(),
        count: z.number().int(),
        error: z.string().optional(),
      }),
    ),
    lastSyncAt: z.number().int(),
  }),
});

// Adjust how often model-gateway re-fetches /v1/models for every enabled
// provider. Pass 0 to disable the timer.
export const setProviderSyncInterval = defineRpc({
  name: "gateway.providers.set_sync_interval",
  input: z.object({
    intervalMs: z.number().int().min(0).max(365 * 24 * 60 * 60 * 1000),
  }),
  output: z.object({
    intervalMs: z.number().int(),
    nextSyncAt: z.number().int(),
  }),
});

// Inspect the sync state: current interval, last run, per-provider outcomes.
export const providerSyncStatus = defineRpc({
  name: "gateway.providers.sync_status",
  input: z.object({}),
  output: z.object({
    intervalMs: z.number().int(),
    lastSyncAt: z.number().int(),
    results: z.record(
      z.string(),
      z.object({
        at: z.number().int(),
        ok: z.boolean(),
        count: z.number().int(),
        error: z.string().optional(),
      }),
    ),
  }),
});

// ---- Provider connectivity test ------------------------------------------------

export const testProvider = defineRpc({
  name: "gateway.providers.test",
  input: z.object({ id: z.string() }),
  output: z.object({
    ok: z.boolean(),
    status: z.number().int().nullable(),
    latencyMs: z.number().int(),
    upstreamModels: z.array(z.string()),
    error: z.string().optional(),
  }),
});

// ---- Agent config sync -----------------------------------------------------------

// Manually trigger a sync of the user's agent config files
// (~/.pi/agent/models.json and ~/.paseo/config.json). The gateway also
// runs this automatically on startup and after every provider CRUD; this
// RPC exists for cases where the user edited a config file by hand and
// wants the gateway's view re-applied without waiting for the next CRUD.
export const syncAgentConfigsRpc = defineRpc({
  name: "gateway.agent.sync_config",
  input: z.object({}),
  output: z.object({
    pi: z.object({
      path: z.string(),
      ok: z.boolean(),
      reason: z.string().optional(),
      written: z.number().int().optional(),
    }),
    paseo: z.object({
      path: z.string(),
      ok: z.boolean(),
      reason: z.string().optional(),
      written: z.number().int().optional(),
    }),
  }),
});

// ---- Token usage tracking (migrated from paseo-hub TokenTracker) ----------------
//
// Parses agent session logs (Codex / Claude Code / GLM ACP / Pi) on the daemon
// filesystem and aggregates token + cost usage. Data sources and cache paths are
// unchanged from the original paseo-hub implementation:
//   - ~/.codex/sessions/**/*.jsonl
//   - ~/.claude/projects/**/*.jsonl
//   - ~/.local/state/glm-acp-agent/sessions/*.json
//   - ~/.pi/agent/sessions/**/*.jsonl
// Pricing overrides: ~/.paseo/config.json → plugins.tokenTracker.pricing
// Disk cache:        ~/.paseo/cache/token-tracker-cache.json

export const tokenUsageRecordSchema = z.object({
  source: z.enum(["codex", "claude-code", "glm-acp", "pi"]),
  sessionId: z.string(),
  timestamp: z.string(),
  provider: z.string(),
  model: z.string(),
  workspace: z.string().optional(),
  cwd: z.string().optional(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedTokens: z.number().int().nonnegative().default(0),
  reasoningTokens: z.number().int().nonnegative().default(0),
  contextWindow: z.number().int().nonnegative().optional(),
  isEstimate: z.boolean().optional(),
});
export type TokenUsageRecord = z.infer<typeof tokenUsageRecordSchema>;

export const tokenProviderBucketSchema = z.object({
  provider: z.string(), model: z.string(), calls: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(),
  cachedTokens: z.number().int().nonnegative(), reasoningTokens: z.number().int().nonnegative(),
  estimatedCostCNY: z.number().nonnegative(), hasPricing: z.boolean(),
  // Tokens/calls this bucket spent on models with no configured price. They
  // are excluded from estimatedCostCNY (unknown is not the same as free) and
  // surfaced explicitly so the panel never passes a zero off as a real cost.
  unpricedCalls: z.number().int().nonnegative().default(0),
  unpricedTokens: z.number().int().nonnegative().default(0),
  isLocal: z.boolean().default(false), isEstimate: z.boolean().default(false),
  completeness: z.enum(["complete", "partial", "estimate"]).default("complete"),
  missingSessions: z.number().int().nonnegative().default(0),
  totalSessions: z.number().int().nonnegative().default(0),
});
export type TokenProviderBucket = z.infer<typeof tokenProviderBucketSchema>;

export const tokenDailyBucketSchema = z.object({
  date: z.string(), calls: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(),
  estimatedCostCNY: z.number().nonnegative(),
});
export type TokenDailyBucket = z.infer<typeof tokenDailyBucketSchema>;

export const tokenStatsSchema = z.object({
  since: z.string(), until: z.string(), scope: z.string(),
  totalCalls: z.number().int().nonnegative(),
  totalInputTokens: z.number().int().nonnegative(), totalOutputTokens: z.number().int().nonnegative(),
  totalCachedTokens: z.number().int().nonnegative(), totalReasoningTokens: z.number().int().nonnegative(),
  estimatedTotalCostCNY: z.number().nonnegative(),
  // Whole-window view of the pricing gap behind estimatedTotalCostCNY.
  unpricedCalls: z.number().int().nonnegative().default(0),
  unpricedTokens: z.number().int().nonnegative().default(0),
  pricedTokens: z.number().int().nonnegative().default(0),
  byProvider: z.array(tokenProviderBucketSchema), byDay: z.array(tokenDailyBucketSchema),
  byWorkspace: z.array(z.object({
    workspace: z.string(), calls: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(),
    estimatedCostCNY: z.number().nonnegative(),
  })),
  availableWorkspaces: z.array(z.string()),
  recordsScanned: z.number().int().nonnegative(), filesScanned: z.number().int().nonnegative(),
  lastScannedAt: z.string(),
});
export type TokenStats = z.infer<typeof tokenStatsSchema>;

export const tokenGetStats = defineRpc({
  name: "gateway.token.stats",
  input: z.object({
    sinceDays: z.number().int().positive().default(7),
    workspace: z.string().optional(),
  }),
  output: tokenStatsSchema,
});

export const tokenGetRecentRecords = defineRpc({
  name: "gateway.token.recent_records",
  input: z.object({
    sinceDays: z.number().int().positive().default(7),
    limit: z.number().int().positive().max(500).default(100),
    workspace: z.string().optional(),
  }),
  output: z.object({ records: z.array(tokenUsageRecordSchema), total: z.number().int().nonnegative() }),
});

export const tokenGetPricing = defineRpc({
  name: "gateway.token.pricing",
  input: z.object({}),
  output: z.object({
    pricing: z.record(z.string(), z.object({
      inputPerMTokCNY: z.number().nonnegative(), outputPerMTokCNY: z.number().nonnegative(),
      cachedInputPerMTokCNY: z.number().nonnegative().optional(),
      isLocal: z.boolean().default(false), note: z.string().optional(),
    })),
    lastUpdated: z.string(),
  }),
});

export const tokenRefresh = defineRpc({
  name: "gateway.token.refresh",
  input: z.object({}),
  output: z.object({ ok: z.boolean(), scannedAt: z.string(), clearedStatsEntries: z.number().int().nonnegative() }),
});

export const tokenClearCache = defineRpc({
  name: "gateway.token.clear_cache",
  input: z.object({}),
  output: z.object({ ok: z.boolean(), cleared: z.object({ memory: z.number().int().nonnegative(), disk: z.boolean() }) }),
});

export const tokenGetCacheStatus = defineRpc({
  name: "gateway.token.cache_status",
  input: z.object({}),
  output: z.object({
    memoryEntries: z.number().int().nonnegative(), diskEntries: z.number().int().nonnegative(),
    diskCachePath: z.string(), diskSizeBytes: z.number().int().nonnegative(),
    statsCacheSize: z.number().int().nonnegative(), lastFileMtime: z.number().int().nonnegative(),
  }),
});
