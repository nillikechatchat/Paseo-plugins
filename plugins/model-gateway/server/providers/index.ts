// Registry of provider adapters keyed by ProviderType.

import type { ProviderType } from "../storage";
import type { ProviderAdapter } from "./base";
import { openaiAdapter, openaiCompatibleAdapter, azureOpenaiAdapter } from "./openai";
import { anthropicAdapter } from "./anthropic";
import { googleAdapter } from "./google";
import { ollamaAdapter } from "./ollama";
import { zhipuAdapter } from "./zhipu";
import { volcengineAdapter } from "./volcengine";

const ADAPTERS: Record<ProviderType, ProviderAdapter> = {
  openai: openaiAdapter,
  "openai-compatible": openaiCompatibleAdapter,
  "azure-openai": azureOpenaiAdapter,
  anthropic: anthropicAdapter,
  google: googleAdapter,
  ollama: ollamaAdapter,
  zhipu: zhipuAdapter,
  volcengine: volcengineAdapter,
};

export function getAdapter(type: ProviderType): ProviderAdapter {
  const adapter = ADAPTERS[type];
  if (!adapter) throw new Error(`Unsupported provider type: ${type}`);
  return adapter;
}

export function listAdapterIds(): string[] {
  return Object.keys(ADAPTERS);
}
