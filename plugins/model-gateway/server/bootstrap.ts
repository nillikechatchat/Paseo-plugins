// Pure aggregation of the bootstrap payload — shared between the RPC handler
// (in index.ts) and the HTTP /v1/agents/bootstrap endpoint (in gateway.ts).
// Keeping it in a single function guarantees both surfaces return identical
// data, including the `[<userProviderName>] <model>` label the agent picker
// uses to identify which upstream each model belongs to.

import type { Provider } from "./storage";
import {
  PROVIDER_TYPE_LABELS,
  formatModelLabel,
  isChatModel,
  modelRouting,
  providerProtocols,
  type Protocol,
} from "./protocols";

export interface BootstrapSyncState {
  intervalMs: number;
  lastSyncAt: number;
  results: Record<string, { at: number; ok: boolean; count: number; error?: string }>;
}

export interface BootstrapGatewayState {
  running: boolean;
  baseUrl: string | null;
  port: number | null;
  host: string;
  version: string;
}

export interface BootstrapInput {
  includeRaw?: boolean;
}

export interface BootstrapProviderOut {
  id: string;
  name: string;
  type: Provider["type"];
  typeLabel: string;
  enabled: boolean;
  priority: number;
  weight: number;
  models: string[];
  modelCount: number;
  notes?: string;
  rateLimitRpm: number;
  timeoutMs: number;
  hasApiKey: boolean;
  protocols: Protocol[];
}

export interface BootstrapClaimingProvider {
  id: string;
  name: string;
  type: Provider["type"];
  typeLabel: string;
  label: string;
  protocols: Protocol[];
}

export interface BootstrapCatalogueEntry {
  model: string;
  primaryProvider: string;
  primaryProviderName: string;
  primaryProviderType: Provider["type"];
  primaryProviderTypeLabel: string;
  label: string;
  protocols: Protocol[];
  claimingProviders: BootstrapClaimingProvider[];
}

export interface BootstrapOutput {
  gateway: BootstrapGatewayState;
  sync: BootstrapSyncState;
  providerTypeLabels: Record<string, string>;
  providers: BootstrapProviderOut[];
  catalogue: BootstrapCatalogueEntry[];
}

export interface BootstrapDeps {
  providers: Provider[];
  gateway: BootstrapGatewayState;
  sync: BootstrapSyncState;
}

export function buildBootstrap(deps: BootstrapDeps, input: BootstrapInput = {}): BootstrapOutput {
  const includeRaw = input.includeRaw ?? false;
  const { providers } = deps;
  const enabled = providers.filter((p) => p.enabled);

  const sanitized: BootstrapProviderOut[] = providers.map((p) => ({
    id: p.id,
    name: p.name,
    type: p.type,
    typeLabel: PROVIDER_TYPE_LABELS[p.type],
    enabled: p.enabled,
    priority: p.priority,
    weight: p.weight,
    models: includeRaw ? p.models.slice() : [],
    modelCount: p.models.length,
    notes: p.notes,
    rateLimitRpm: p.rateLimitRpm,
    timeoutMs: p.timeoutMs,
    hasApiKey: Boolean(p.apiKey && p.apiKey.length > 0),
    protocols: providerProtocols(p),
  }));

  // Catalogue: one entry per distinct upstream-discovered model, with
  // the full claiming-provider fan-out and aggregated protocols.
  const grouped = new Map<string, Provider[]>();
  for (const p of enabled) {
    for (const m of p.models) {
      // Same chat-only filter the picker uses, so the catalogue and the
      // model selectors never disagree about what is offered.
      if (!isChatModel(m)) continue;
      const arr = grouped.get(m) ?? [];
      arr.push(p);
      grouped.set(m, arr);
    }
  }
  const catalogue: BootstrapCatalogueEntry[] = [];
  for (const [m, claiming] of grouped) {
    const r = modelRouting(m, providers);
    if (!r.primary) continue;
    catalogue.push({
      model: m,
      primaryProvider: r.primary.id,
      primaryProviderName: r.primary.name,
      primaryProviderType: r.primary.type,
      primaryProviderTypeLabel: PROVIDER_TYPE_LABELS[r.primary.type],
      label: formatModelLabel(r.primary, m),
      protocols: r.protocols,
      claimingProviders: r.claimingProviders.map((p) => ({
        id: p.id,
        name: p.name,
        type: p.type,
        typeLabel: PROVIDER_TYPE_LABELS[p.type],
        label: formatModelLabel(p, m),
        protocols: providerProtocols(p),
      })),
    });
  }

  return {
    gateway: deps.gateway,
    sync: deps.sync,
    providerTypeLabels: { ...PROVIDER_TYPE_LABELS },
    providers: sanitized,
    catalogue,
  };
}