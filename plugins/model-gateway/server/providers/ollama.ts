// Ollama adapter. Exposes an OpenAI-compatible chat endpoint at /v1, so we
// reuse the OpenAI adapter shape but resolve to the local daemon URL.

import type { ProviderAdapter } from "./base";
import { openaiAdapter } from "./openai";

export const ollamaAdapter: ProviderAdapter = {
  ...openaiAdapter,
  id: "ollama",
  defaultBaseUrl: "http://127.0.0.1:11434",
};
