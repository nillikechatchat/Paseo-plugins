// HTTP client for the gatewayd admin plane (:39011).
// The plugin panel's RPC handlers delegate to these when gatewayd is running.
// Falls back to undefined responses when gatewayd is down (the panel shows
// "gateway not running" rather than erroring).

const ADMIN_BASE = process.env.GATEWAYD_ADMIN ?? "http://127.0.0.1:39011";

/** Probe whether gatewayd's admin plane is reachable. */
export async function adminAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${ADMIN_BASE}/admin/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

export interface AdminStatus {
  running: boolean;
  baseUrl: string | null;
  port: number | null;
  host: string;
  startedAt: number | null;
  pid: number | null;
  requests: number;
  bytesIn: number;
  bytesOut: number;
  dataDir: string;
}

export async function adminStatus(): Promise<AdminStatus | null> {
  try {
    const res = await fetch(`${ADMIN_BASE}/admin/status`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    return (await res.json()) as AdminStatus;
  } catch {
    return null;
  }
}

export interface AdminStats {
  requests: number;
  errors: number;
  cacheHits: number;
  bytesIn: number;
  bytesOut: number;
  byProvider: Array<{
    provider: string;
    requests: number;
    errors: number;
    promptTokens: number;
    completionTokens: number;
    avgDurationMs: number;
  }>;
}

export async function adminStats(): Promise<AdminStats | null> {
  try {
    const res = await fetch(`${ADMIN_BASE}/admin/stats`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    return (await res.json()) as AdminStats;
  } catch {
    return null;
  }
}

/** Windowed overview (percentiles / byModel / timeseries). Mirrors
 *  `storage.aggregateWindow` on the TS side — see gateway/store.mbt
 *  `Telemetry::stats_overview`. */
export interface AdminOverview {
  windowMinutes: number;
  requests: number;
  errors: number;
  errorRate: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  avgDurationMs: number;
  p50DurationMs: number;
  p95DurationMs: number;
  p99DurationMs: number;
  avgTtfbMs: number;
  p95TtfbMs: number;
  cacheHits: number;
  cacheHitRate: number;
  byProvider: Array<{
    provider: string;
    requests: number;
    errors: number;
    promptTokens: number;
    completionTokens: number;
    avgDurationMs: number;
  }>;
  // gatewayd buckets model rows by model only (a model can span providers),
  // so `provider` is always "" there; the panel only uses it as a row key.
  byModel: Array<{
    provider?: string;
    model: string;
    requests: number;
    errors: number;
    promptTokens: number;
    completionTokens: number;
    avgDurationMs: number;
  }>;
  timeseries: Array<{
    bucket: number;
    requests: number;
    errors: number;
    tokens: number;
  }>;
}

export async function adminStatsOverview(windowMinutes?: number): Promise<AdminOverview | null> {
  try {
    const q = windowMinutes !== undefined ? `?windowMinutes=${encodeURIComponent(String(windowMinutes))}` : "";
    const res = await fetch(`${ADMIN_BASE}/admin/stats/overview${q}`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    return (await res.json()) as AdminOverview;
  } catch {
    return null;
  }
}

export interface AdminCallsQuery {
  /** gatewayd clamps this to [1, 500]; the panel passes its page size. */
  limit?: number;
  provider?: string;
  status?: string;
}

export async function adminCalls(query: AdminCallsQuery = {}): Promise<Array<Record<string, unknown>> | null> {
  try {
    // Filtering happens server-side: fetching the default page and slicing in
    // the panel used to truncate to 100 rows before any `limit` applied.
    const params = new URLSearchParams();
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    if (query.provider) params.set("provider", query.provider);
    if (query.status) params.set("status", query.status);
    const qs = params.toString();
    const res = await fetch(`${ADMIN_BASE}/admin/calls${qs ? `?${qs}` : ""}`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const body = (await res.json()) as { calls: Array<Record<string, unknown>> };
    return body.calls;
  } catch {
    return null;
  }
}

export async function adminCache(): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`${ADMIN_BASE}/admin/cache`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function adminCacheClear(): Promise<boolean> {
  try {
    const res = await fetch(`${ADMIN_BASE}/admin/cache/clear`, { method: "POST", signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function adminClearCalls(): Promise<boolean> {
  try {
    const res = await fetch(`${ADMIN_BASE}/admin/calls/clear`, { method: "POST", signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function adminFlush(): Promise<boolean> {
  try {
    const res = await fetch(`${ADMIN_BASE}/admin/flush`, { method: "POST", signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}
