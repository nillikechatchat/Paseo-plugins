// Google Gemini adapter. Uses the Generative Language generateContent /
// streamGenerateContent endpoints.

import type {
  NormalizedRequest,
  NormalizedResponse,
  ProviderAdapter,
} from "./base";
import type { Provider } from "../storage";

function pickBaseUrl(provider: Provider): string {
  return (provider.baseUrl || "https://generativelanguage.googleapis.com").replace(/\/$/, "");
}

export const googleAdapter: ProviderAdapter = {
  id: "google",
  supportsStreaming: true,
  defaultBaseUrl: "https://generativelanguage.googleapis.com",

  buildUrl(provider, endpoint) {
    const base = pickBaseUrl(provider);
    if (endpoint === "models") {
      // List all available Gemini models for the key.
      return `${base}/v1beta/models?key=${encodeURIComponent(provider.apiKey ?? "")}`;
    }
    const model = provider.models[0] ?? "gemini-pro";
    const action = provider.notes?.includes("stream") ? "streamGenerateContent" : "generateContent";
    return `${base}/v1beta/models/${encodeURIComponent(model)}:${action}`;
  },

  buildHeaders(provider) {
    // Gemini accepts key in header or query string. Prefer header for cleanliness.
    // buildUrl puts the key in the query for /models; skip the header there to
    // avoid leaking the key in two places at once.
    const headers: Record<string, string> = { "content-type": "application/json" };
    // The caller decides via endpoint detection; gate on apiKey presence so
    // we don't send an empty header alongside a real query string key.
    if (provider.apiKey) headers["x-goog-api-key"] = provider.apiKey;
    return headers;
  },

  transformRequest(req, _provider) {
    const { system, rest } = splitSystem(req.messages);
    const contents = rest
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));
    const body: Record<string, unknown> = { contents };
    if (system) {
      body.systemInstruction = { role: "system", parts: [{ text: system }] };
    }
    const genConfig: Record<string, unknown> = {};
    if (req.temperature !== undefined) genConfig.temperature = req.temperature;
    if (req.top_p !== undefined) genConfig.topP = req.top_p;
    if (req.max_tokens !== undefined) genConfig.maxOutputTokens = req.max_tokens;
    if (req.stop) genConfig.stopSequences = req.stop;
    if (Object.keys(genConfig).length > 0) body.generationConfig = genConfig;
    return { body, stream: req.stream };
  },

  transformResponse(body, _provider, model): NormalizedResponse {
    const b = body as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
    };
    const cand = b.candidates?.[0];
    const text = (cand?.content?.parts ?? [])
      .map((p) => p.text ?? "")
      .join("");
    return {
      id: `gemini-${Date.now()}`,
      model,
      provider: "google",
      content: text,
      finish_reason: cand?.finishReason,
      usage: b.usageMetadata
        ? {
            prompt_tokens: b.usageMetadata.promptTokenCount,
            completion_tokens: b.usageMetadata.candidatesTokenCount,
            total_tokens: b.usageMetadata.totalTokenCount,
          }
        : undefined,
      raw: body,
    };
  },

  async listModels(provider, signal) {
    // Google returns either { models: [{ name: "models/gemini-pro", ... }] }
    // or { models: [...] } depending on auth path. Strip the "models/"
    // prefix so the IDs match what callers actually pass to generateContent.
    const url = this.buildUrl(provider, "models");
    const headers = this.buildHeaders(provider);
    // buildUrl embeds the key in the query string for /models; ensure the
    // header is empty so we don't send it twice.
    delete headers["x-goog-api-key"];
    const res = await fetch(url, { method: "GET", headers, signal } as RequestInit);
    if (!res.ok) {
      throw new Error(`Upstream returned ${res.status} ${res.statusText}`);
    }
    const body = await res.json() as { models?: Array<{ name?: string }> } | unknown;
    const arr = body && typeof body === "object" && Array.isArray((body as { models?: unknown[] }).models)
      ? (body as { models: Array<{ name?: string }> }).models
      : [];
    const models: string[] = [];
    for (const m of arr) {
      const raw = (m?.name ?? "").toString().trim();
      if (!raw) continue;
      models.push(raw.replace(/^models\//, ""));
    }
    return { models, raw: body };
  },

  async *transformStream(rawChunks, _provider, model) {
    let buffer = "";
    let idx = 0;
    const decoder = new TextDecoder();
    for await (const chunk of rawChunks) {
      buffer += decoder.decode(chunk, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, sep).trim();
        buffer = buffer.slice(sep + 1);
        if (!line) continue;
        if (line.startsWith("data:")) {
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          try {
            const obj = JSON.parse(payload) as {
              candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
              usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
            };
            const cand = obj.candidates?.[0];
            const text = (cand?.content?.parts ?? []).map((p) => p.text ?? "").join("");
            yield {
              id: `gemini-${idx++}`,
              model,
              delta: text,
              finish_reason: cand?.finishReason,
              usage: obj.usageMetadata
                ? {
                    prompt_tokens: obj.usageMetadata.promptTokenCount,
                    completion_tokens: obj.usageMetadata.candidatesTokenCount,
                    total_tokens: obj.usageMetadata.totalTokenCount,
                  }
                : undefined,
              raw: obj,
            };
          } catch { /* skip */ }
          continue;
        }
        // Some Gemini variants return raw JSON arrays without data: prefix.
        if (line.startsWith("[") || line.startsWith("{")) {
          try {
            const arr = JSON.parse(line) as Array<{
              candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
              usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
            }>;
            for (const obj of arr) {
              const cand = obj.candidates?.[0];
              const text = (cand?.content?.parts ?? []).map((p) => p.text ?? "").join("");
              yield {
                id: `gemini-${idx++}`,
                model,
                delta: text,
                finish_reason: cand?.finishReason,
                raw: obj,
              };
            }
          } catch { /* skip */ }
        }
      }
    }
  },
};

function splitSystem(messages: NormalizedRequest["messages"]): { system: string | null; rest: NormalizedRequest["messages"] } {
  const sysParts: string[] = [];
  const rest: NormalizedRequest["messages"] = [];
  for (const m of messages) {
    if (m.role === "system") sysParts.push(m.content);
    else rest.push(m);
  }
  return { system: sysParts.length > 0 ? sysParts.join("\n\n") : null, rest };
}
