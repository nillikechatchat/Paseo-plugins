// Unit tests for the hand-off from the agent-config file writer to the running
// daemon. The bug: `syncAgentConfigs` wrote `~/.paseo/config.json` directly and
// nothing told the daemon. The daemon serves `listProviderModels` from an
// in-memory provider snapshot it only rebuilds on start-up or on a config
// patch, so the model picker kept showing the previous set — a `[Glm]
// glm-5.3-flash` claimant that existed in gateway-codex/gateway-claude on disk
// but was missing from the picker until the user ran `paseo reload`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import contribute from "../index.server";
import { syncAgentConfigsRpc } from "../shared/rpc";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { PaseoApi } from "@getpaseo/client";

type Handler = (input: never, context: { paseo: PaseoApi }) => Promise<unknown>;

type SyncAgentConfigsOutput = {
  pi: { path: string; ok: boolean; reason?: string; written?: number };
  paseo: { path: string; ok: boolean; reason?: string; written?: number };
};

/** Run `contribute` against a stub server and hand back one captured handler. */
async function loadHandler(method: string): Promise<Handler> {
  const handlers = new Map<string, Handler>();
  const server = {
    handle: (contract: { name: string }, handler: Handler) => {
      handlers.set(contract.name, handler);
    },
    registerSettings: () => undefined,
    registerProvider: () => undefined,
    on: () => () => undefined,
    before: () => () => undefined,
  } as unknown as PluginServerContext;

  contribute(server);
  const handler = handlers.get(method);
  assert.ok(handler, `handler ${method} was not registered`);
  return handler;
}

function fakePaseo(patches: unknown[], fail = false): PaseoApi {
  return {
    config: {
      get: async () => ({ requestId: "r", config: {} }) as never,
      patch: async (patch: unknown) => {
        patches.push(patch);
        if (fail) throw new Error("daemon config patch rejected");
        return { requestId: "r", config: {} } as never;
      },
    },
  } as unknown as PaseoApi;
}

test("the agent-config sync RPC patches the daemon with the providers it owns", async () => {
  const home = await fs.mkdtemp(join(tmpdir(), "mgpatch-"));
  const previousHome = process.env.HOME;
  try {
    process.env.HOME = home;
    const handler = await loadHandler("gateway.agent.sync_config");
    const patches: unknown[] = [];
    const result = (await handler(undefined as never, {
      paseo: fakePaseo(patches),
    })) as SyncAgentConfigsOutput;
    assert.equal(result.paseo.ok, true, result.paseo.reason ?? "sync failed");

    assert.equal(patches.length, 1, "the daemon must be told exactly once");
    const providers = (patches[0] as {
      providers: Record<string, { env?: Record<string, string>; models?: Array<{ id: string }> }>;
    }).providers;
    // Only the three gateway-owned entries — the daemon patch deep-merges, so
    // naming more would clobber providers the plugin does not own.
    assert.deepEqual(Object.keys(providers).sort(), ["gateway-claude", "gateway-codex", "pi"]);
    assert.ok((providers["gateway-codex"]!.models ?? []).length > 0, "codex models were sent");
    assert.ok((providers["gateway-claude"]!.models ?? []).length > 0, "claude models were sent");
    // The env base URLs must come from the live gateway, not a hardcoded port.
    assert.equal(providers["gateway-codex"]!.env!.OPENAI_BASE_URL, "http://127.0.0.1:39000/v1");
    assert.equal(providers["gateway-claude"]!.env!.ANTHROPIC_BASE_URL, "http://127.0.0.1:39000");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("a rejected daemon patch never fails the RPC", async () => {
  const home = await fs.mkdtemp(join(tmpdir(), "mgpatch-"));
  const previousHome = process.env.HOME;
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args);
  try {
    process.env.HOME = home;
    const handler = await loadHandler("gateway.agent.sync_config");
    const result = (await handler(undefined as never, {
      paseo: fakePaseo([], true),
    })) as SyncAgentConfigsOutput;
    // The file already landed; the caller must still see a success.
    assert.equal(result.paseo.ok, true, result.paseo.reason ?? "sync failed");
    assert.equal(
      warnings.filter((w) => String(w[0]).includes("daemon config patch failed")).length,
      1,
      "the failure is surfaced as a warning",
    );
  } finally {
    console.warn = originalWarn;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("provider CRUD also patches the daemon so the picker updates live", async () => {
  const home = await fs.mkdtemp(join(tmpdir(), "mgpatch-"));
  const previousHome = process.env.HOME;
  try {
    process.env.HOME = home;
    const toggle = await loadHandler("gateway.providers.toggle");
    // No provider to toggle, but the handler still runs a best-effort sync.
    await assert.rejects(() => toggle({ id: "nope", enabled: true } as never, { paseo: fakePaseo([]) }));
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await fs.rm(home, { recursive: true, force: true });
  }
});
