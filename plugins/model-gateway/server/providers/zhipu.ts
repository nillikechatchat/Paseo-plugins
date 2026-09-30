// Zhipu GLM (open.bigmodel.cn) adapter.
//
// Protocol-wise GLM is OpenAI compatible, but its paths are not:
//   chat:      https://open.bigmodel.cn/api/paas/v4/chat/completions
//   responses: https://open.bigmodel.cn/api/paas/v4/responses
//   models:    https://open.bigmodel.cn/api/paas/v4/models
//   anthropic: https://open.bigmodel.cn/api/anthropic  (…/v1/messages)
// The generic openai adapter now handles the versioned-path case, so this
// adapter only pins defaults and provides the Anthropic-compat mapping.

import type { ProviderAdapter } from "./base";
import { openaiAdapter } from "./openai";

function pickBaseUrl(provider: { baseUrl?: string }): string {
  return (provider.baseUrl || "https://open.bigmodel.cn/api/paas/v4").replace(/\/$/, "");
}

export const zhipuAdapter: ProviderAdapter = {
  ...openaiAdapter,
  id: "zhipu",
  defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4",

  buildProtocolUrl(provider, proto) {
    const base = pickBaseUrl(provider);
    if (proto === "messages") {
      // Anthropic-compatible surface lives at /api/anthropic regardless of
      // the chat base: https://open.bigmodel.cn/api/anthropic/v1/messages
      const origin = new URL(base).origin; // https://open.bigmodel.cn
      return `${origin}/api/anthropic/v1/messages`;
    }
    return `${base}/responses`;
  },
};
