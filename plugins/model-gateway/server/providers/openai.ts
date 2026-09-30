// OpenAI-compatible adapter. Covers OpenAI, Azure OpenAI (with deployment path),
// any provider that speaks the OpenAI Chat Completions schema.

import type {
  AdapterContext,
  NormalizedRequest,
  NormalizedChunk,
  NormalizedResponse,
  ProviderAdapter,
} from "./base";
import type { Provider } from "../storage";

interface OpenAIMessage {
  role: string;
  content: string;
  name?: string;
  tool_call_id?: string;
}

function pickBaseUrl(provider: Provider, fallback: string): string {
  return (provider.baseUrl || fallback).replace(/\/$/, "");
}

export const openaiAdapter: ProviderAdapter = {
  id: "openai",
  supportsStreaming: true,
  defaultBaseUrl: "https://api.openai.com",

  buildUrl(provider, endpoint) {
    if (provider.type === "azure-openai") {
      const base = pickBaseUrl(provider, "");
      if (!base) throw new Error("Azure provider missing baseUrl (endpoint)");
      if (endpoint === "models") {
        // Azure lists deployments (not raw models). The /models endpoint doesn't
        // exist on Azure data-plane; the deployment list is the closest match.
        return `${base}/openai/deployments?api-version=2024-02-01`;
      }
      const deployment = provider.models[0] ?? provider.notes ?? "default";
      const path = endpoint === "chat" ? "chat/completions" : "embeddings";
      return `${base}/openai/deployments/${deployment}/${path}?api-version=2024-02-01`;
    }
    const base = pickBaseUrl(provider, this.defaultBaseUrl);
    // Vendors like Zhipu (…/api/paas/v4) and Volcengine Ark (…/api/v3) use
    // versioned paths that already carry the segment OpenAI puts at /v1. If
    // the baseUrl ends in a version segment (or /chat/completions already),
    // don't inject another /v1.
    const versioned = /\/v\d+$/.test(base);
    const prefix = versioned ? base : `${base}/v1`;
    if (endpoint === "chat") return `${prefix}/chat/completions`;
    if (endpoint === "embeddings") return `${prefix}/embeddings`;
    return `${prefix}/models`;
  },

  buildHeaders(provider) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (provider.type === "azure-openai") {
      headers["api-key"] = provider.apiKey ?? "";
    } else {
      headers["authorization"] = `Bearer ${provider.apiKey ?? ""}`;
    }
    return headers;
  },

  transformRequest(req, provider) {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.name ? { name: m.name } : {}),
        ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
      })) as OpenAIMessage[],
      stream: req.stream,
    };
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.top_p !== undefined) body.top_p = req.top_p;
    if (req.max_tokens !== undefined) body.max_tokens = req.max_tokens;
    if (req.stop) body.stop = req.stop;
    const hasTools = Array.isArray(req.tools) && req.tools.length > 0;
    if (hasTools) {
      body.tools = req.tools;
      if (req.tool_choice) body.tool_choice = req.tool_choice;
    }
    if (req.user) body.user = req.user;
    if (req.extra) Object.assign(body, req.extra);
    if (provider.type === "openai-compatible") body.model = req.model;
    return { body, stream: req.stream };
  },

  transformResponse(body, _provider, model): NormalizedResponse {
    const b = body as {
      id?: string;
      model?: string;
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const choice = b.choices?.[0];
    return {
      id: b.id ?? `chatcmpl-${Date.now()}`,
      model: b.model ?? model,
      provider: "openai",
      content: choice?.message?.content ?? "",
      finish_reason: choice?.finish_reason,
      usage: b.usage,
      raw: body,
    };
  },

  // Standard OpenAI-style model catalogue parser. Handles
  //   { data: [{ id }, ...] }
  //   { data: [{ name }, ...] }
  //   [ { id }, ... ]
  // and trims whitespace.
  _parseOpenAIStyleList(body: unknown): string[] {
    const arr = Array.isArray(body)
      ? body
      : (body && typeof body === "object" && Array.isArray((body as { data?: unknown[] }).data)
          ? (body as { data: unknown[] }).data
          : []);
    const out: string[] = [];
    for (const item of arr) {
      if (!item || typeof item !== "object") continue;
      const o = item as { id?: string; name?: string };
      const v = (o.id ?? o.name ?? "").toString().trim();
      if (v) out.push(v);
    }
    return out;
  },

  buildProtocolUrl(provider, proto) {
    const base = pickBaseUrl(provider, this.defaultBaseUrl);
    const versioned = /\/v\d+$/.test(base);
    const prefix = versioned ? base : `${base}/v1`;
    return proto === "messages" ? `${prefix}/messages` : `${prefix}/responses`;
  },

  async listModels(provider, signal) {
    const url = this.buildUrl(provider, "models");
    const headers = this.buildHeaders(provider);
    const res = await fetch(url, { method: "GET", headers, signal } as RequestInit);
    if (!res.ok) {
      throw new Error(`Upstream returned ${res.status} ${res.statusText}`);
    }
    const body = await res.json();
    return { models: this._parseOpenAIStyleList ? this._parseOpenAIStyleList(body) : [], raw: body };
  },

  async *transformStream(rawChunks, _provider, model) {
    const decoder = new TextDecoder();
    let buffer = "";
    let idx = 0;
    for await (const chunk of rawChunks) {
      buffer += decoder.decode(chunk, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, sep).trim();
        buffer = buffer.slice(sep + 1);
        if (!line || !line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") return;
        try {
          const obj = JSON.parse(payload) as {
            id?: string;
            model?: string;
            choices?: Array<{
              delta?: {
                content?: string;
                reasoning_content?: string;
                tool_calls?: NormalizedChunk["tool_calls"];
              };
              finish_reason?: string;
            }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
          };
          // DeepSeek-style thinking models emit reasoning in a non-standard
          // `reasoning_content` delta; surface it as normal content so
          // downstream clients (pi, codex, claude) can render it.
          const d = obj.choices?.[0]?.delta;
          const delta = d?.content ?? d?.reasoning_content ?? "";
          yield {
            id: obj.id ?? `chatcmpl-${idx++}`,
            model: obj.model ?? model,
            delta,
            finish_reason: obj.choices?.[0]?.finish_reason,
            tool_calls: d?.tool_calls,
            usage: obj.usage,
            raw: obj,
          };
        } catch {
          // ignore malformed chunk
        }
      }
    }
  },
};

export const openaiCompatibleAdapter: ProviderAdapter = {
  ...openaiAdapter,
  id: "openai-compatible",
};

export const azureOpenaiAdapter: ProviderAdapter = {
  ...openaiAdapter,
  id: "azure-openai",
};
