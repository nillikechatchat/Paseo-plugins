// File-backed persistence for providers and call telemetry.
// Designed for high write throughput (append-only JSONL) with periodic compaction
// into pre-aggregated hourly buckets for cheap overview queries.

const fs = require("node:fs").promises;
const crypto = require("node:crypto"); const createHash = crypto.createHash, randomUUID = crypto.randomUUID;
import { z } from "zod";

// ---- Types --------------------------------------------------------------------

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

export type ProviderType = z.infer<typeof providerTypeSchema>;

export interface Provider {
  id: string;
  name: string;
  type: ProviderType;
  baseUrl?: string;
  apiKey?: string;
  models: string[];
  priority: number;
  weight: number;
  enabled: boolean;
  rateLimitRpm: number;
  timeoutMs: number;
  notes?: string;
  /** Opt-in: expose this provider's models on the Claude Code (Anthropic Messages)
   *  surface via the gateway's /v1/messages passthrough, even though the
   *  provider type does not natively advertise the "messages" protocol
   *  (e.g. Agnes: OpenAI-type vendor that also serves /v1/messages). */
  exposeMessages?: boolean;
  /** Ceiling for Responses-API `max_output_tokens` on this provider. Strict
   *  upstreams (Agnes/litellm) cap omitted values at ~4096 — too small for
   *  reasoning: long-thinking turns get cut off at exactly 4094 reasoning
   *  tokens with no final message. When set, the gateway bumps requests
   *  below the ceiling so reasoning + reply both fit. */
  maxOutputTokens?: number;
  /** Context window in tokens for this provider's models. When set, requests
   *  whose estimated prompt size exceeds it get an early, clear 413 instead
   *  of an opaque upstream "context length exceeded" error. */
  contextWindow?: number;
  createdAt: number;
  updatedAt: number;
}

export interface CallRecord {
  id: string;
  ts: number;
  provider: string;
  providerName: string;
  model: string;
  endpoint: string;
  status: "ok" | "error";
  statusCode?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  durationMs: number;
  ttfbMs?: number;
  stream: boolean;
  error?: string;
  cached?: boolean;
}

interface HourBucket {
  bucket: number;
  provider: string;
  model: string;
  requests: number;
  errors: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  durationSum: number;
  durationMax: number;
  durationSamples: number[];
}

interface AggregateFile {
  version: 1;
  hours: Record<string, HourBucket>;
  counters: {
    requests: number;
    errors: number;
    cacheHits: number;
    cacheMisses: number;
    bytesIn: number;
    bytesOut: number;
  };
}

const AGG_VERSION: AggregateFile["version"] = 1;

// ---- Storage ------------------------------------------------------------------

export class Storage {
  private dataDir: string;
  private providersPath: string;
  private callsPath: string;
  private aggregatesPath: string;
  private settingsPath: string;
  private readonly memLog: CallRecord[] = [];
  private readonly memCap = 2000;
  private aggregates!: AggregateFile;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.providersPath = `${dataDir}/providers.json`;
    this.callsPath = `${dataDir}/calls.jsonl`;
    this.aggregatesPath = `${dataDir}/aggregates.json`;
    this.settingsPath = `${dataDir}/settings.json`;
  }

  async init(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true }).catch(() => {});
    this.aggregates = await this.loadAggregates();
    await this.replayRecentCalls();
  }

  close(): void {
    // Drain buffered telemetry so a shutdown doesn't lose the last flush
    // window of call records.
    this.flushPendingCalls();
  }

  rebind(dataDir: string): void {
    this.dataDir = dataDir;
    this.providersPath = `${dataDir}/providers.json`;
    this.callsPath = `${dataDir}/calls.jsonl`;
    this.aggregatesPath = `${dataDir}/aggregates.json`;
    this.settingsPath = `${dataDir}/settings.json`;
    // No file descriptor to reopen — appendFile manages its own fd.
  }

  async loadSettings(): Promise<Record<string, unknown>> {
    try {
      const raw = await fs.readFile(this.settingsPath, "utf8");
      const obj = JSON.parse(raw);
      return obj && typeof obj === "object" ? (obj as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  async saveSettings(settings: Record<string, unknown>): Promise<void> {
    const tmp = this.settingsPath + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(settings, null, 2), "utf8");
    await fs.rename(tmp, this.settingsPath);
  }

  // ---- Providers ----

  async loadProviders(): Promise<Provider[]> {
    try {
      const raw = await fs.readFile(this.providersPath, "utf8");
      const arr = JSON.parse(raw) as Provider[];
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }

  async saveProviders(providers: Provider[]): Promise<void> {
    const tmp = this.providersPath + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(providers, null, 2), "utf8");
    await fs.rename(tmp, this.providersPath);
  }

  // ---- Calls ----

  private pendingLines: string[] = [];
  private flushCallsTimer: NodeJS.Timeout | null = null;

  recordCall(call: CallRecord): void {
    this.memLog.push(call);
    if (this.memLog.length > this.memCap) this.memLog.shift();
    this.aggregate(call);
    this.aggregates.counters.requests++;
    if (call.status === "error") this.aggregates.counters.errors++;
    if (call.cached) this.aggregates.counters.cacheHits++;
    else if (call.status === "ok") this.aggregates.counters.cacheMisses++;

    // Batch telemetry writes: one appendFile per flush window instead of one
    // syscall per request. Durability is best-effort (same as before).
    this.pendingLines.push(JSON.stringify(call));
    if (this.pendingLines.length >= 200) {
      this.flushPendingCalls();
      return;
    }
    if (!this.flushCallsTimer) {
      const t = setTimeout(() => {
        this.flushCallsTimer = null;
        this.flushPendingCalls();
      }, 2000) as unknown as NodeJS.Timeout;
      t.unref?.();
      this.flushCallsTimer = t;
    }
  }

  private flushPendingCalls(): void {
    if (this.flushCallsTimer) {
      clearTimeout(this.flushCallsTimer);
      this.flushCallsTimer = null;
    }
    if (this.pendingLines.length === 0) return;
    const blob = this.pendingLines.join("\n") + "\n";
    this.pendingLines = [];
    fs.appendFile(this.callsPath, blob).catch(() => {});
  }

  recordBytes(bytesIn: number, bytesOut: number): void {
    this.aggregates.counters.bytesIn += bytesIn;
    this.aggregates.counters.bytesOut += bytesOut;
  }

  recentCalls(limit: number, filter?: { provider?: string; status?: "ok" | "error" }): CallRecord[] {
    const out: CallRecord[] = [];
    for (let i = this.memLog.length - 1; i >= 0 && out.length < limit; i--) {
      const c = this.memLog[i];
      if (filter?.provider && c.provider !== filter.provider) continue;
      if (filter?.status && c.status !== filter.status) continue;
      out.push(c);
    }
    return out;
  }

  counters(): AggregateFile["counters"] {
    return { ...this.aggregates.counters };
  }

  // ---- Aggregates ----

  aggregateWindow(windowMs: number) {
    const cutoff = Date.now() - windowMs;
    const bucketSize = Math.max(60_000, Math.floor(windowMs / 60));
    const byProvider = new Map<string, { requests: number; errors: number; promptTokens: number; completionTokens: number; totalDuration: number; durationCount: number }>();
    const byModel = new Map<string, { provider: string; model: string; requests: number; errors: number; promptTokens: number; completionTokens: number; totalDuration: number; durationCount: number }>();
    const tsBuckets = new Map<number, { requests: number; errors: number; tokens: number }>();
    let requests = 0;
    let errors = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;
    let cacheHits = 0;
    const durations: number[] = [];
    const ttfbs: number[] = [];

    for (const c of this.memLog) {
      if (c.ts < cutoff) continue;
      requests++;
      if (c.status === "error") errors++;
      if (c.cached) cacheHits++;
      if (c.promptTokens) promptTokens += c.promptTokens;
      if (c.completionTokens) completionTokens += c.completionTokens;
      if (c.totalTokens) totalTokens += c.totalTokens;
      durations.push(c.durationMs);
      if (c.ttfbMs !== undefined) ttfbs.push(c.ttfbMs);

      const p = byProvider.get(c.provider) ?? { requests: 0, errors: 0, promptTokens: 0, completionTokens: 0, totalDuration: 0, durationCount: 0 };
      p.requests++;
      if (c.status === "error") p.errors++;
      if (c.promptTokens) p.promptTokens += c.promptTokens;
      if (c.completionTokens) p.completionTokens += c.completionTokens;
      p.totalDuration += c.durationMs;
      p.durationCount++;
      byProvider.set(c.provider, p);

      const mk = `${c.provider}::${c.model}`;
      const m = byModel.get(mk) ?? { provider: c.provider, model: c.model, requests: 0, errors: 0, promptTokens: 0, completionTokens: 0, totalDuration: 0, durationCount: 0 };
      m.requests++;
      if (c.status === "error") m.errors++;
      if (c.promptTokens) m.promptTokens += c.promptTokens;
      if (c.completionTokens) m.completionTokens += c.completionTokens;
      m.totalDuration += c.durationMs;
      m.durationCount++;
      byModel.set(mk, m);

      const b = Math.floor(c.ts / bucketSize) * bucketSize;
      const tb = tsBuckets.get(b) ?? { requests: 0, errors: 0, tokens: 0 };
      tb.requests++;
      if (c.status === "error") tb.errors++;
      tb.tokens += c.totalTokens ?? ((c.promptTokens ?? 0) + (c.completionTokens ?? 0));
      tsBuckets.set(b, tb);
    }

    return {
      requests,
      errors,
      errorRate: requests > 0 ? errors / requests : 0,
      promptTokens,
      completionTokens,
      totalTokens,
      avgDurationMs: durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0,
      p50DurationMs: percentile(durations, 0.5),
      p95DurationMs: percentile(durations, 0.95),
      p99DurationMs: percentile(durations, 0.99),
      avgTtfbMs: ttfbs.length > 0 ? ttfbs.reduce((a, b) => a + b, 0) / ttfbs.length : 0,
      p95TtfbMs: percentile(ttfbs, 0.95),
      cacheHits,
      cacheHitRate: requests > 0 ? cacheHits / requests : 0,
      byProvider: [...byProvider.entries()].map(([k, v]) => ({
        provider: k,
        requests: v.requests,
        errors: v.errors,
        promptTokens: v.promptTokens,
        completionTokens: v.completionTokens,
        avgDurationMs: v.durationCount > 0 ? v.totalDuration / v.durationCount : 0,
      })),
      byModel: [...byModel.values()].map((v) => ({
        provider: v.provider,
        model: v.model,
        requests: v.requests,
        errors: v.errors,
        promptTokens: v.promptTokens,
        completionTokens: v.completionTokens,
        avgDurationMs: v.durationCount > 0 ? v.totalDuration / v.durationCount : 0,
      })),
      timeseries: [...tsBuckets.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([bucket, v]) => ({ bucket, requests: v.requests, errors: v.errors, tokens: v.tokens })),
    };
  }

  // ---- Persistence helpers ----

  private async loadAggregates(): Promise<AggregateFile> {
    try {
      const raw = await fs.readFile(this.aggregatesPath, "utf8");
      const parsed = JSON.parse(raw) as AggregateFile;
      if (parsed.version === AGG_VERSION) return parsed;
    } catch { /* fresh */ }
    return {
      version: AGG_VERSION,
      hours: {},
      counters: { requests: 0, errors: 0, cacheHits: 0, cacheMisses: 0, bytesIn: 0, bytesOut: 0 },
    };
  }

  private async replayRecentCalls(): Promise<void> {
    try {
      const stat = await fs.stat(this.callsPath);
      const maxBytes = 2 * 1024 * 1024;
      const start = Math.max(0, stat.size - maxBytes);
      const fh = await fs.open(this.callsPath, "r");
      try {
        const buf = Buffer.alloc(stat.size - start);
        await fh.read(buf, 0, buf.length, start);
        const text = buf.toString("utf8");
        const lines = text.split("\n");
        const offset = start > 0 ? 1 : 0;
        for (let i = lines.length - 1; i >= offset; i--) {
          const line = lines[i];
          if (!line) continue;
          try {
            const c = JSON.parse(line) as CallRecord;
            this.memLog.unshift(c);
            if (this.memLog.length > this.memCap) this.memLog.pop();
            this.aggregate(c);
          } catch { /* skip malformed */ }
        }
      } finally {
        await fh.close();
      }
    } catch { /* no log yet */ }
  }

  private aggregate(call: CallRecord): void {
    const bucket = Math.floor(call.ts / 3_600_000) * 3_600_000;
    const key = `${bucket}|${call.provider}|${call.model}`;
    const h = this.aggregates.hours[key] ?? {
      bucket,
      provider: call.provider,
      model: call.model,
      requests: 0,
      errors: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      durationSum: 0,
      durationMax: 0,
      durationSamples: [],
    };
    h.requests++;
    if (call.status === "error") h.errors++;
    if (call.promptTokens) h.promptTokens += call.promptTokens;
    if (call.completionTokens) h.completionTokens += call.completionTokens;
    if (call.totalTokens) h.totalTokens += call.totalTokens;
    h.durationSum += call.durationMs;
    if (call.durationMs > h.durationMax) h.durationMax = call.durationMs;
    h.durationSamples.push(call.durationMs);
    if (h.durationSamples.length > 500) {
      h.durationSamples = downsample(h.durationSamples, 500);
    }
    this.aggregates.hours[key] = h;
  }

  async flushAggregates(): Promise<void> {
    if (!this.aggregates) return;
    const tmp = this.aggregatesPath + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(this.aggregates), "utf8");
    await fs.rename(tmp, this.aggregatesPath);
  }

  async resetAll(): Promise<void> {
    // Preserve aggregated hourly buckets & counters (UI: "小时聚合保留").
    // Only clear the in-memory call ring buffer and on-disk JSONL log.
    this.memLog.length = 0;
    await this.flushAggregates();
    await fs.writeFile(this.callsPath, "", "utf8").catch(() => {});
  }

  async compactCalls(maxAgeMs: number): Promise<void> {
    const cutoff = Date.now() - maxAgeMs;
    try {
      const raw = await fs.readFile(this.callsPath, "utf8");
      const lines = raw.split("\n");
      const kept: string[] = [];
      for (const line of lines) {
        if (!line) continue;
        try {
          const c = JSON.parse(line) as CallRecord;
          if (c.ts >= cutoff) kept.push(line);
        } catch { /* drop malformed */ }
      }
      const tmp = this.callsPath + ".tmp";
      await fs.writeFile(tmp, kept.join("\n") + (kept.length > 0 ? "\n" : ""), "utf8");
      await fs.rename(tmp, this.callsPath);
    } catch { /* no file */ }
  }
}

// ---- Helpers ------------------------------------------------------------------

// Linearly-interpolated percentile (numpy "linear" / type-7): identical to the
// gatewayd implementation so the panel reads the same number whichever side
// serves the overview. Truncating the rank collapsed p95 onto the minimum on
// small windows (2 samples -> p95 == p0).
export function percentile(values: number[], p: number): number {
  const n = values.length;
  if (n === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  if (n === 1) return sorted[0];
  const pos = p * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(n - 1, lo + 1);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function downsample(arr: number[], target: number): number[] {
  const step = arr.length / target;
  const out: number[] = [];
  for (let i = 0; i < target; i++) out.push(arr[Math.floor(i * step)] ?? arr[arr.length - 1]);
  return out;
}

export function newCallId(): string {
  return randomUUID();
}

export function hashKey(parts: unknown[]): string {
  return createHash("sha1").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}
