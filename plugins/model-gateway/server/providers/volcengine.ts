// Volcengine Ark (ark.cn-beijing.volces.com) adapter.
//
// Paths differ per surface:
//   chat:      https://ark.cn-beijing.volces.com/api/v3/chat/completions
//   responses: https://ark.cn-beijing.volces.com/api/v3/responses
//   models:    https://ark.cn-beijing.volces.com/api/v3/models
//   anthropic: https://ark.cn-beijing.volces.com/api/v3/anthropic/v1/messages
//              (coding-plan surface: https://ark.cn-beijing.volces.com/api/coding/v1/messages)
// All OpenAI-schema, Bearer auth. The versioned-base handling in the shared
// openai adapter covers chat/models; this adapter pins defaults and the
// Anthropic-compat mapping.

import type { ProviderAdapter } from "./base";
import { openaiAdapter } from "./openai";

function pickBaseUrl(provider: { baseUrl?: string }): string {
  return (provider.baseUrl || "https://ark.cn-beijing.volces.com/api/v3").replace(/\/$/, "");
}

export const volcengineAdapter: ProviderAdapter = {
  ...openaiAdapter,
  id: "volcengine",
  defaultBaseUrl: "https://ark.cn-beijing.volces.com/api/v3",

  buildProtocolUrl(provider, proto) {
    const base = pickBaseUrl(provider);
    // Coding-plan subscribers use /api/coding as their Anthropic surface;
    // detect it from the configured base so both shapes work.
    if (proto === "messages") {
      if (base.endsWith("/api/coding")) return `${base}/v1/messages`;
      return `${base}/anthropic/v1/messages`;
    }
    return `${base}/responses`;
  },
};
