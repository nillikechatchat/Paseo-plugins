// Unit tests for the gateway base URL the agent config files are written
// against. The bug: `~/.paseo/config.json` used to be written with gatewayd's
// port hardcoded, so whenever the data plane moved (dormant in-process
// gateway on a different port, or a user-overridden gatewayPort setting) the
// agent configs pointed the agent at a closed port.

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildPaseoProviderOverrides, resolveGatewayBase, syncAgentConfigs } from "./agent-config-sync";
import type { Provider } from "./storage";

const PROVIDER = {
  id: "p1",
  name: "My OpenAI",
  type: "openai-compatible",
  baseUrl: "https://api.example.com/v1",
  apiKey: "secret",
  models: ["gpt-5.2", "glm-5.2", "text-embedding-3-small"],
  priority: 10,
  weight: 1,
  enabled: true,
} as unknown as Provider;

test("resolveGatewayBase prefers the explicit live base", () => {
  assert.equal(resolveGatewayBase("http://127.0.0.1:41234"), "http://127.0.0.1:41234");
  assert.equal(resolveGatewayBase("http://127.0.0.1:41234", 39000), "http://127.0.0.1:41234");
});

test("resolveGatewayBase strips trailing slashes", () => {
  assert.equal(resolveGatewayBase("http://127.0.0.1:41234/"), "http://127.0.0.1:41234");
  assert.equal(resolveGatewayBase("http://127.0.0.1:41234///"), "http://127.0.0.1:41234");
});

test("resolveGatewayBase falls back to the port, then the default", () => {
  assert.equal(resolveGatewayBase(undefined, 39101), "http://127.0.0.1:39101");
  assert.equal(resolveGatewayBase(undefined, 0), "http://127.0.0.1:39000");
  assert.equal(resolveGatewayBase(undefined, 70_000), "http://127.0.0.1:39000");
  assert.equal(resolveGatewayBase(undefined), "http://127.0.0.1:39000");
});

test("MODEL_GATEWAY_BASE_URL overrides the default when no base is given", () => {
  const previous = process.env.MODEL_GATEWAY_BASE_URL;
  try {
    process.env.MODEL_GATEWAY_BASE_URL = "http://127.0.0.1:45555";
    assert.equal(resolveGatewayBase(), "http://127.0.0.1:45555");
  } finally {
    if (previous === undefined) delete process.env.MODEL_GATEWAY_BASE_URL;
    else process.env.MODEL_GATEWAY_BASE_URL = previous;
  }
});

test("the written paseo config points at the gateway base it was given", async () => {
  const home = await fs.mkdtemp(join(tmpdir(), "mgsync-"));
  try {
    const result = await syncAgentConfigs([PROVIDER], {
      home,
      gatewayBase: "http://127.0.0.1:40111",
    });
    assert.equal(result.paseo.ok, true, result.paseo.reason ?? "failed");
    assert.equal(result.pi.ok, true, result.pi.reason ?? "failed");

    const written = JSON.parse(await fs.readFile(join(home, ".paseo/config.json"), "utf8"));
    const providers = written.agents.providers as Record<string, { env?: Record<string, string> }>;
    const codex = providers["gateway-codex"]!.env!;
    const claude = providers["gateway-claude"]!.env!;
    assert.equal(codex.OPENAI_BASE_URL, "http://127.0.0.1:40111/v1");
    assert.equal(claude.ANTHROPIC_BASE_URL, "http://127.0.0.1:40111");

    // No stale per-upstream provider groups left behind by earlier revisions.
    assert.deepEqual(Object.keys(providers).filter((k) => /^gateway-(codex|claude)-.+/.test(k)), []);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("re-syncing an existing config rewrites the base when the port moves", async () => {
  const home = await fs.mkdtemp(join(tmpdir(), "mgsync-"));
  try {
    await syncAgentConfigs([PROVIDER], { home, gatewayBase: "http://127.0.0.1:40111" });
    await syncAgentConfigs([PROVIDER], { home, gatewayPort: 40222 });
    const written = JSON.parse(await fs.readFile(join(home, ".paseo/config.json"), "utf8"));
    const providers = written.agents.providers as Record<string, { env?: Record<string, string> }>;
    assert.equal(providers["gateway-codex"]!.env!.OPENAI_BASE_URL, "http://127.0.0.1:40222/v1");
    assert.equal(providers["gateway-claude"]!.env!.ANTHROPIC_BASE_URL, "http://127.0.0.1:40222");
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

// ---- Per-surface primary attribution --------------------------------------
// The bug: `buildViews` picked ONE primary per model name (priority, then
// weight) and gated the Messages view on that primary's type. When an
// anthropic-type provider and an openai-type provider both list the same
// model (Sensenova vs SenseNova (Anthropic) both serve `kimi-k3`), the
// openai one won the chat attribution and the model vanished from the Claude
// picker entirely — the panel showed an 11-model provider the agent could
// never select.

const OPENAI_SN = {
  id: "sn-openai",
  name: "Sensenova",
  type: "openai",
  baseUrl: "https://api.sensenova.cn/v1",
  apiKey: "k",
  models: ["kimi-k3", "deepseek-v4-flash"],
  priority: 0,
  weight: 100,
  enabled: true,
} as unknown as Provider;

const ANTHROPIC_SN = {
  id: "sn-anthropic",
  name: "SenseNova (Anthropic)",
  type: "anthropic",
  baseUrl: "https://api.sensenova.cn/anthropic",
  apiKey: "k",
  models: ["kimi-k3", "deepseek-v4-flash"],
  priority: 10, // lower preference for chat; must NOT hide it from Claude
  weight: 100,
  enabled: true,
} as unknown as Provider;

type WrittenProvider = {
  models?: Array<{ id: string; isDefault?: boolean }>;
  additionalModels?: Array<{ id: string; label: string }>;
  [key: string]: unknown;
};

async function writtenProviders(home: string): Promise<Record<string, WrittenProvider>> {
  const written = JSON.parse(await fs.readFile(join(home, ".paseo/config.json"), "utf8"));
  return written.agents.providers;
}

// ---- One entry per (provider, model) pair --------------------------------
// The bug: same-named models on different providers were collapsed by name,
// so whichever claimant won priority kept the label and the other vanished
// from the picker. The panel listed `glm-5.3-flash` under both senseaudio and
// Glm, but the picker only ever showed `[senseaudio] glm-5.3-flash` — the
// model the user configured under Glm was unreachable from the agent.

const SENSEAUDIO = {
  id: "senseaudio",
  name: "senseaudio",
  type: "openai",
  baseUrl: "https://api.example.com/v1",
  apiKey: "k",
  models: ["glm-5.3-flash", "glm-5.2"],
  priority: 0,
  weight: 100,
  enabled: true,
} as unknown as Provider;

const GLM = {
  id: "glm",
  name: "Glm",
  type: "zhipu",
  baseUrl: "https://open.bigmodel.cn/api/paas/v4",
  apiKey: "k",
  models: ["glm-5.3-flash", "glm-5.2", "glm-4.5"],
  priority: 0,
  weight: 100,
  enabled: true,
} as unknown as Provider;

test("a model claimed by two providers gets one picker entry per claimant", async () => {
  const home = await fs.mkdtemp(join(tmpdir(), "mgsync-"));
  try {
    const result = await syncAgentConfigs([SENSEAUDIO, GLM], {
      home,
      gatewayBase: "http://127.0.0.1:39000",
    });
    assert.equal(result.paseo.ok, true, result.paseo.reason ?? "failed");

    const providers = await writtenProviders(home);
    const codexIds = (providers["gateway-codex"]!.models ?? []).map((m) => m.id);
    const claudeIds = (providers["gateway-claude"]!.models ?? []).map((m) => m.id);

    // Both claimants must be selectable — the label carries the upstream.
    assert.ok(codexIds.includes("[senseaudio] glm-5.3-flash"), JSON.stringify(codexIds));
    assert.ok(codexIds.includes("[Glm] glm-5.3-flash"), JSON.stringify(codexIds));
    // ...and the same pair appears exactly once each, never duplicated.
    assert.equal(codexIds.filter((id) => id === "[senseaudio] glm-5.3-flash").length, 1);
    assert.equal(codexIds.filter((id) => id === "[Glm] glm-5.3-flash").length, 1);

    // pi's flat model list uses the same prefixed ids.
    const piRoot = JSON.parse(await fs.readFile(join(home, ".pi/agent/models.json"), "utf8"));
    const piIds = (piRoot.providers["model-gateway"].models ?? []).map((m: { id: string }) => m.id);
    assert.ok(piIds.includes("[senseaudio] glm-5.3-flash"), JSON.stringify(piIds));
    assert.ok(piIds.includes("[Glm] glm-5.3-flash"), JSON.stringify(piIds));

    // Messages surface: glm-5.2 is servable by either claimant, and exactly one
    // entry carries isDefault (the best claimant), never several.
    assert.ok(claudeIds.includes("[senseaudio] glm-5.2"), JSON.stringify(claudeIds));
    assert.ok(claudeIds.includes("[Glm] glm-5.2"), JSON.stringify(claudeIds));
    const flagged = (providers["gateway-claude"]!.models ?? []).filter(
      (m) => m.id.includes("glm-5.2") && m.isDefault === true,
    );
    assert.equal(flagged.length, 1, JSON.stringify(flagged));
    assert.equal(flagged[0]!.id, "[senseaudio] glm-5.2");
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("disabled providers contribute no picker entries at all", async () => {
  const home = await fs.mkdtemp(join(tmpdir(), "mgsync-"));
  try {
    const disabled = { ...GLM, enabled: false } as unknown as Provider;
    const result = await syncAgentConfigs([SENSEAUDIO, disabled], {
      home,
      gatewayBase: "http://127.0.0.1:39000",
    });
    assert.equal(result.paseo.ok, true, result.paseo.reason ?? "failed");
    const providers = await writtenProviders(home);
    const codexIds = (providers["gateway-codex"]!.models ?? []).map((m) => m.id);
    const claudeIds = (providers["gateway-claude"]!.models ?? []).map((m) => m.id);
    assert.ok(!codexIds.includes("[Glm] glm-4.5"), JSON.stringify(codexIds));
    assert.ok(!claudeIds.includes("[Glm] glm-4.5"), JSON.stringify(claudeIds));
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("anthropic claimants win the Messages view even at a worse chat priority", async () => {
  const home = await fs.mkdtemp(join(tmpdir(), "mgsync-"));
  try {
    const result = await syncAgentConfigs([OPENAI_SN, ANTHROPIC_SN], { home, gatewayBase: "http://127.0.0.1:39000" });
    assert.equal(result.paseo.ok, true, result.paseo.reason ?? "failed");
    const providers = await writtenProviders(home);

    const codexIds = (providers["gateway-codex"]!.models ?? []).map((m) => m.id);
    const claudeIds = (providers["gateway-claude"]!.models ?? []).map((m) => m.id);

    // Chat surface keeps the priority winner's attribution.
    assert.ok(codexIds.includes("[Sensenova] kimi-k3"), JSON.stringify(codexIds));
    assert.ok(codexIds.includes("[Sensenova] deepseek-v4-flash"), JSON.stringify(codexIds));

    // Messages surface: the anthropic-type claimant is listed, and so is the
    // openai-type one — the gateway dispatches /v1/messages for both (the
    // openai adapter builds that path), so hiding either would be a lie.
    assert.ok(claudeIds.includes("[SenseNova (Anthropic)] kimi-k3"), JSON.stringify(claudeIds));
    assert.ok(claudeIds.includes("[SenseNova (Anthropic)] deepseek-v4-flash"), JSON.stringify(claudeIds));
    assert.ok(claudeIds.includes("[Sensenova] kimi-k3"), JSON.stringify(claudeIds));
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("every model the gateway dispatches on Messages reaches the Claude picker", async () => {
  const home = await fs.mkdtemp(join(tmpdir(), "mgsync-"));
  try {
    await syncAgentConfigs([OPENAI_SN], { home, gatewayBase: "http://127.0.0.1:39000" });
    const providers = await writtenProviders(home);
    const codexIds = (providers["gateway-codex"]!.models ?? []).map((m) => m.id);
    const claudeIds = (providers["gateway-claude"]!.models ?? []).map((m) => m.id);
    // The old model-name allowlist hid kimi-k3 from the Messages surface for
    // openai-type providers even though the gateway dispatches it there.
    assert.ok(codexIds.includes("[Sensenova] kimi-k3"), JSON.stringify(codexIds));
    assert.ok(claudeIds.includes("[Sensenova] kimi-k3"), JSON.stringify(claudeIds));
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("exposeMessages opts a chat-only provider type into the Messages surface", async () => {
  const home = await fs.mkdtemp(join(tmpdir(), "mgsync-"));
  try {
    const google = { ...OPENAI_SN, type: "google" } as unknown as Provider;
    await syncAgentConfigs([google], { home, gatewayBase: "http://127.0.0.1:39000" });
    let providers = await writtenProviders(home);
    assert.deepEqual(
      (providers["gateway-claude"]!.models ?? []).map((m) => m.id).filter((id) => id !== "auto"),
      [],
      "google has no /v1/messages dispatch path and no opt-in",
    );

    const optedIn = { ...google, exposeMessages: true } as unknown as Provider;
    await syncAgentConfigs([optedIn], { home, gatewayBase: "http://127.0.0.1:39000" });
    providers = await writtenProviders(home);
    assert.ok(
      (providers["gateway-claude"]!.models ?? []).map((m) => m.id).includes("[Sensenova] kimi-k3"),
      "exposeMessages is the documented override",
    );
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("canServeMessages follows the protocol matrix plus the explicit opt-in", async () => {
  const { canServeMessages } = await import("./agent-config-sync");
  const mk = (type: string, exposeMessages?: boolean) =>
    ({ type, exposeMessages } as unknown as Provider);
  assert.equal(canServeMessages(mk("anthropic"), "any-model"), true);
  assert.equal(canServeMessages(mk("openai"), "any-model"), true);
  assert.equal(canServeMessages(mk("openai-compatible"), "any-model"), true);
  assert.equal(canServeMessages(mk("zhipu"), "glm-4.5"), true);
  assert.equal(canServeMessages(mk("google"), "gemini-3-pro"), false);
  assert.equal(canServeMessages(mk("ollama"), "llama-4"), false);
  assert.equal(canServeMessages(mk("google", true), "gemini-3-pro"), true);
});

test("a wildcard provider's reachable models are selectable in the picker", async () => {
  const home = await fs.mkdtemp(join(tmpdir(), "mgsync-"));
  try {
    const wildcard = {
      id: "local",
      name: "Local",
      type: "zhipu",
      baseUrl: "http://127.0.0.1:8000/v1",
      apiKey: "k",
      models: [], // claims every model
      priority: 20,
      weight: 1,
      enabled: true,
    } as unknown as Provider;
    await syncAgentConfigs([GLM, wildcard], { home, gatewayBase: "http://127.0.0.1:39000" });
    const providers = await writtenProviders(home);
    const codexIds = (providers["gateway-codex"]!.models ?? []).map((m) => m.id);
    const claudeIds = (providers["gateway-claude"]!.models ?? []).map((m) => m.id);
    // `models: []` used to drop the provider out of the picker entirely even
    // though pickProviderCandidates treats it as a claimant for every model.
    assert.ok(codexIds.includes("[Local] glm-5.2"), JSON.stringify(codexIds));
    assert.ok(claudeIds.includes("[Local] glm-5.2"), JSON.stringify(claudeIds));
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

// ---- Daemon patch overrides -------------------------------------------------
// The bug: `syncAgentConfigs` wrote `~/.paseo/config.json` directly and nothing
// told the running daemon. The daemon serves `listProviderModels` from an
// in-memory provider snapshot it only rebuilds on start-up or on a config
// patch, so the picker kept showing the previous model set — a `[Glm]
// glm-5.3-flash` claimant present in gateway-codex/gateway-claude on disk but
// missing from the picker until the user ran `paseo reload`.

test("the daemon patch payload matches the file that was written", async () => {
  const home = await fs.mkdtemp(join(tmpdir(), "mgsync-"));
  try {
    const result = await syncAgentConfigs([SENSEAUDIO, GLM], {
      home,
      gatewayBase: "http://127.0.0.1:40111",
    });
    assert.equal(result.paseo.ok, true, result.paseo.reason ?? "failed");

    const providers = await writtenProviders(home);
    // Same shape, same content: the patch and the file can never drift.
    assert.deepEqual(result.overrides["gateway-codex"], providers["gateway-codex"]);
    assert.deepEqual(result.overrides["gateway-claude"], providers["gateway-claude"]);
    assert.deepEqual(result.overrides.pi, { additionalModels: providers["pi"]!.additionalModels });
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("the daemon patch carries the live gateway base, not a hardcoded port", async () => {
  const home = await fs.mkdtemp(join(tmpdir(), "mgsync-"));
  try {
    await syncAgentConfigs([PROVIDER], { home, gatewayPort: 40222 });
    const again = await syncAgentConfigs([PROVIDER], { home, gatewayBase: "http://127.0.0.1:40333" });
    assert.equal(again.overrides["gateway-codex"].env.OPENAI_BASE_URL, "http://127.0.0.1:40333/v1");
    assert.equal(again.overrides["gateway-claude"].env.ANTHROPIC_BASE_URL, "http://127.0.0.1:40333");
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("overrides are available without touching the filesystem", () => {
  const overrides = buildPaseoProviderOverrides(
    [{ model: "glm-5.2", primaryProvider: GLM, label: "[Glm] glm-5.2", protocols: ["chat"] }],
    [{ model: "glm-5.2", primaryProvider: GLM, label: "[Glm] glm-5.2", protocols: ["messages"] }],
    { gatewayBase: "http://127.0.0.1:40111" },
  );
  // dryRun writes nothing but the caller may still want to notify the daemon.
  assert.deepEqual(
    overrides["gateway-codex"].models.map((m) => m.id),
    ["auto", "[Glm] glm-5.2"],
  );
  assert.deepEqual(
    overrides["gateway-claude"].models.map((m) => m.id),
    ["auto", "[Glm] glm-5.2"],
  );
  // Exactly one default, on the best claimant.
  assert.deepEqual(
    overrides["gateway-claude"].models.filter((m) => m.isDefault).map((m) => m.id),
    ["[Glm] glm-5.2"],
  );
  assert.deepEqual(overrides.pi.additionalModels, [{ id: "[Glm] glm-5.2", label: "[Glm] glm-5.2" }]);
  assert.equal(overrides["gateway-codex"].extends, "codex");
  assert.equal(overrides["gateway-claude"].extends, "claude");
});

test("only the first messages claimant of the default model is marked", () => {
  const mk = (name: string) =>
    ({ model: "glm-5.2", primaryProvider: { ...GLM, name }, label: `[${name}] glm-5.2`, protocols: ["messages"] });
  const overrides = buildPaseoProviderOverrides([mk("A"), mk("B")], [mk("A"), mk("B")], {});
  assert.deepEqual(
    overrides["gateway-claude"].models.filter((m) => m.isDefault).map((m) => m.id),
    ["[A] glm-5.2"],
  );
});

test("syncing keeps unrelated entries in the daemon patch payload scope", async () => {
  // The patch deep-merges into the daemon config, so the plugin must name only
  // the three entries it owns — never a whole replacement of agents.providers.
  const home = await fs.mkdtemp(join(tmpdir(), "mgsync-"));
  try {
    const before = {
      agents: { providers: { "sensenova-claude": { extends: "claude", label: "user" }, pi: { extra: 1 } } },
    };
    await fs.mkdir(join(home, ".paseo"), { recursive: true });
    await fs.writeFile(join(home, ".paseo/config.json"), JSON.stringify(before), "utf8");
    const result = await syncAgentConfigs([PROVIDER], { home, gatewayBase: "http://127.0.0.1:40111" });
    assert.deepEqual(Object.keys(result.overrides).sort(), ["gateway-claude", "gateway-codex", "pi"]);
    // The user's own provider entry is untouched on disk...
    const providers = await writtenProviders(home);
    assert.deepEqual(providers["sensenova-claude"], { extends: "claude", label: "user" });
    // ...and the user's hand-added keys on `pi` survive the merge.
    assert.equal(providers["pi"]!.extra, 1);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});
