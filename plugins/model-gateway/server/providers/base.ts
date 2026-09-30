// Provider adapter contract. Every adapter accepts a normalized request and
// returns a normalized response. Streaming variants return an async iterator
// of normalized chunks so the gateway can pipe bytes while recording tokens.

import type { Provider } from "../storage";

export interface NormalizedMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  tool_call_id?: string;
}

export interface NormalizedRequest {
  model: string;
  messages: NormalizedMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string[];
  stream: boolean;
  tools?: unknown[];
  tool_choice?: unknown;
  user?: string;
  extra?: Record<string, unknown>;
}

export interface UsageInfo {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface NormalizedResponse {
  id: string;
  model: string;
  provider: string;
  content: string;
  finish_reason?: string;
  usage?: UsageInfo;
  raw?: unknown;
}

export interface NormalizedChunk {
  id: string;
  model: string;
  delta: string;
  finish_reason?: string;
  usage?: UsageInfo;
  tool_calls?: Array<{
    index?: number;
    id?: string;
    type?: string;
    function?: {
      name?: string;
      arguments?: string;
    };
  }>;
  raw?: unknown;
}

export interface AdapterContext {
  provider: Provider;
  request: NormalizedRequest;
  signal?: AbortSignal;
  onFirstByte?: () => void;
}

export interface AdapterResult {
  response?: NormalizedResponse;
  stream?: AsyncIterable<NormalizedChunk>;
}

export interface ProviderAdapter {
  readonly id: string;
  readonly supportsStreaming: boolean;
  readonly defaultBaseUrl: string;
  buildUrl(provider: Provider, endpoint: "chat" | "embeddings" | "models"): string;
  buildHeaders(provider: Provider): Record<string, string>;
  transformRequest(req: NormalizedRequest, provider: Provider): { body: unknown; stream: boolean };
  transformResponse(body: unknown, provider: Provider, model: string): NormalizedResponse;
  transformStream?(rawChunks: AsyncIterable<Buffer>, provider: Provider, model: string): AsyncIterable<NormalizedChunk>;
  // Pull the upstream's published model list. Returns a normalized set of
  // model IDs the caller can offer to the user. Adapters that don't expose
  // a public catalogue (anthropic historically) may return an empty array.
  listModels?(provider: Provider, signal?: AbortSignal): Promise<{ models: string[]; raw?: unknown }>;
  // Target URL for the protocol-passthrough endpoints (/v1/messages and
  // /v1/responses on the gateway). Adapters for vendors with non-standard
  // path layouts override this; the default appends the OpenAI-style path.
  buildProtocolUrl?(provider: Provider, proto: "messages" | "responses"): string;
  // Per-protocol auth/surface headers for the passthrough endpoints. Vendors
  // with non-standard auth (Anthropic-compat gateways using Bearer instead of
  // x-api-key) override this; the gateway falls back to proto-based defaults.
  buildProtocolHeaders?(provider: Provider, proto: "messages" | "responses"): Record<string, string>;
  // Shared OpenAI-style catalogue parser exposed by the openai adapter and
  // reused by adapters that speak the same /models shape.
  _parseOpenAIStyleList?(body: unknown): string[];
}

export interface ChatDispatchArgs {
  provider: Provider;
  request: NormalizedRequest;
  adapter: ProviderAdapter;
  signal?: AbortSignal;
  onFirstByte?: () => void;
  bytesIn: number;
}

export interface ChatDispatchResult {
  status: number;
  contentType: string;
  body?: Uint8Array;
  stream?: ReadableStream<Uint8Array>;
  parsed?: NormalizedResponse;
  usage?: UsageInfo;
  ttfbMs?: number;
}

export const CHAT_PATH = "/v1/chat/completions";
export const EMBEDDINGS_PATH = "/v1/embeddings";
export const MODELS_PATH = "/v1/models";
