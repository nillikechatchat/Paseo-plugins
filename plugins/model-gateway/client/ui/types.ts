// Types shared between the surface and any sub-components.

export type ProviderType =
  | "openai"
  | "openai-compatible"
  | "azure-openai"
  | "anthropic"
  | "google"
  | "ollama"
  | "zhipu"
  | "volcengine";

export interface ProviderRecord {
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
  maxOutputTokens?: number;
  contextWindow?: number;
  /** Opt-in: advertise this provider on the Claude Code (Messages) surface. */
  exposeMessages?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface GatewayStatus {
  running: boolean;
  baseUrl: string | null;
  port: number | null;
  host: string;
  startedAt: number | null;
  pid: number | null;
  requests: number;
  bytesIn: number;
  bytesOut: number;
}

export interface OverviewStats {
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
  byModel: Array<{
    provider: string;
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

export interface RecentCall {
  id: string;
  ts: number;
  provider: string;
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
}

export interface CacheStatus {
  enabled: boolean;
  entries: number;
  maxEntries: number;
  hitRate: number;
  hits: number;
  misses: number;
}

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

export const PROVIDER_TYPE_DEFAULT_BASE: Record<ProviderType, string> = {
  openai: "https://api.openai.com",
  "openai-compatible": "",
  "azure-openai": "",
  anthropic: "https://api.anthropic.com",
  google: "https://generativelanguage.googleapis.com",
  ollama: "http://127.0.0.1:11434",
  zhipu: "https://open.bigmodel.cn/api/paas/v4",
  volcengine: "https://ark.cn-beijing.volces.com/api/v3",
};
