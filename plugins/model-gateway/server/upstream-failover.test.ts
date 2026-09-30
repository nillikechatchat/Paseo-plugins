// Unit tests for the shared failover runner. These are the behaviours the
// four hand-rolled loops used to disagree about: a transport error rolling
// forward, 429/5xx rolling forward, a dead credential (401/403) rolling
// forward *and* grabbing a persistent cooldown, a client abort escaping, and
// the aggregated error message every all-candidates-failed path returns.

import { test } from "node:test";
import assert from "node:assert/strict";

import { FailCooldown } from "./routing";
import {
  runFailover,
  runStreamFailover,
  type FailoverCandidate,
  type FailoverHooks,
} from "./upstream-failover";
import type { StreamRelayResult } from "./stream-relay";
import type { Provider } from "./storage";

const T0 = 1_700_000_000_000;

function provider(id: string): Provider {
  return {
    id,
    name: id,
    type: "openai-compatible",
    baseUrl: "http://x",
    apiKey: "k",
    models: [],
    enabled: true,
  } as unknown as Provider;
}

function candidate(id: string, model = "gpt-5.2"): FailoverCandidate {
  return { model, decision: { provider: provider(id), reason: "model-match" } };
}

const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200 });
const err = (message: string, status: number) =>
  new Response(JSON.stringify({ error: { message } }), { status });

/** One fresh cooldown per call, so cases never see each other's state. */
function fresh(): FailCooldown {
  return new FailCooldown();
}

/** Responses handed out per attempt, in order (Errors are thrown). */
function scripted(responses: Array<Response | Error>): FailoverHooks<FailoverCandidate>["attempt"] {
  const queue = responses.slice();
  return async () => {
    const next = queue.shift();
    if (next === undefined) throw new Error("test script exhausted");
    if (next instanceof Error) throw next;
    return next;
  };
}

test("transport failure rolls to the next candidate", async () => {
  const seen: string[] = [];
  const out = await runFailover([candidate("a"), candidate("b")], "chat", {
    cooldown: fresh(),
    attempt: async (c) => {
      seen.push(c.decision.provider.id);
      if (seen.length === 1) throw new Error("connect ECONNREFUSED");
      return ok();
    },
  });
  assert.equal(out.ok, true);
  assert.deepEqual(seen, ["a", "b"]);
  if (out.ok) assert.equal(out.candidate.decision.provider.id, "b");
});

test("client abort escapes instead of being treated as an upstream failure", async () => {
  const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
  await assert.rejects(
    () => runFailover([candidate("a")], "chat", { cooldown: fresh(), attempt: scripted([abort]) }),
    /abort/,
  );
});

test("429 and 5xx roll to the next candidate", async () => {
  for (const status of [429, 500, 502, 503, 504]) {
    const s = scripted([err(`upstream ${status}`, status), ok()]);
    await runFailover([candidate(`a${status}`), candidate(`b${status}`)], "chat", { cooldown: fresh(), attempt: s });
    const calls = { n: 0 };
    // the runner already consumed both responses; assert on the outcome only
    const out = await runFailover([candidate(`c${status}`), candidate(`d${status}`)], "chat", { cooldown: fresh(), attempt: s });
    assert.equal(out.ok, false, `status ${status} must have failed over twice`);
    void calls;
  }
});

test("429/5xx on the last candidate is committed, not swallowed", async () => {
  const out = await runFailover([candidate("a")], "chat", { cooldown: fresh(), attempt: scripted([err("overloaded", 503)]) });
  assert.equal(out.ok, true);
  if (out.ok) assert.equal(out.response.status, 503);
});

test("every intermediate candidate is dispatched, and only the last one commits", async () => {
  const seen: string[] = [];
  const out = await runFailover([candidate("a"), candidate("b"), candidate("c")], "chat", {
    cooldown: fresh(),
    attempt: async (c) => {
      seen.push(c.decision.provider.id);
      return seen.length < 3 ? err("rate limited", 429) : ok();
    },
  });
  assert.deepEqual(seen, ["a", "b", "c"]);
  if (out.ok) assert.equal(out.candidate.decision.provider.id, "c");
});

test("a dead credential (401) fails over and takes a persistent cooldown", async () => {
  const cd = fresh();
  const out = await runFailover([candidate("a"), candidate("b")], "chat", {
    cooldown: cd,
    attempt: scripted([err("Unauthorized", 401), ok()]),
  });
  assert.equal(out.ok, true);
  // one strike was enough: a dead key does not recover within seconds
  assert.equal(cd.demoted("a", "gpt-5.2", "chat", T0 + 4 * 60_000), true);
});

test("a 403 with auth phrasing is treated like a 401", async () => {
  const cd = fresh();
  const out = await runFailover([candidate("a"), candidate("b")], "chat", {
    cooldown: cd,
    attempt: scripted([err("身份验证失败", 403), ok()]),
  });
  assert.equal(out.ok, true);
  if (out.ok) assert.equal(out.candidate.decision.provider.id, "b");
  assert.equal(cd.demoted("a", "gpt-5.2", "chat", T0 + 4 * 60_000), true);
});

test("model-unavailable and billing fail over, and persist", async () => {
  for (const [id, message, status] of [["a", "model not found", 404], ["c", "余额不足", 402]] as const) {
    const cd = fresh();
    await runFailover([candidate(id), candidate("z")], "chat", {
      cooldown: cd,
      attempt: scripted([err(message, status), ok()]),
    });
    assert.equal(cd.demoted(id, "gpt-5.2", "chat", T0 + 4 * 60_000), true, `${id}/${message}`);
  }
});

test("a client-shaped 400 commits and does NOT fail over", async () => {
  const cd = fresh();
  const seen: string[] = [];
  const out = await runFailover([candidate("a"), candidate("b")], "chat", {
    cooldown: cd,
    attempt: async (c) => {
      seen.push(c.decision.provider.id);
      return seen.length === 1 ? err("temperature out of range", 400) : ok();
    },
  });
  assert.equal(out.ok, true);
  if (out.ok) assert.equal(out.response.status, 400);
  assert.deepEqual(seen, ["a"], "provider b must not be billed for a client error");
  assert.equal(cd.demoted("a", "gpt-5.2", "chat", T0 + 1000), false);
});

test("non-persistent failover 4xx needs two strikes before demoting", async () => {
  const cd = fresh();
  const attempt = scripted([err("Inference request is invalid", 400), ok()]);
  await runFailover([candidate("a"), candidate("b")], "chat", { cooldown: cd, attempt });
  // invalid-inference is provider-specific but transient: one strike is not
  // enough to demote (mirrors gatewayd's count >= 2 rule).
  assert.equal(cd.demoted("a", "gpt-5.2", "chat", T0 + 30_000), false);
  await runFailover([candidate("a"), candidate("b")], "chat", { cooldown: cd, attempt });
  assert.equal(cd.demoted("a", "gpt-5.2", "chat", T0 + 30_000), true);
});

test("cooldowns are scoped per (provider, model, surface)", async () => {
  const cd = fresh();
  await runFailover([candidate("a")], "chat", { cooldown: cd, attempt: scripted([err("Unauthorized", 401), ok()]) });
  assert.equal(cd.demoted("a", "gpt-5.2", "chat", T0 + 1000), true);
  assert.equal(cd.demoted("a", "gpt-5.3", "chat", T0 + 1000), false);
  assert.equal(cd.demoted("a", "gpt-5.2", "responses", T0 + 1000), false);
});

test("lastError is aggregated across candidates that only fail to connect", async () => {
  const out = await runFailover([candidate("a"), candidate("b")], "chat", {
    cooldown: fresh(),
    attempt: scripted([
      new Error("connect ECONNREFUSED 10.0.0.1"),
      new Error("connect ECONNREFUSED 10.0.0.2"),
    ]),
  });
  assert.equal(out.ok, false);
  if (!out.ok) {
    // the last transport failure is what the agent sees
    assert.equal(out.status, undefined);
    assert.match(out.message, /10\.0\.0\.2/);
  }
});

test("a failing last candidate still commits and still records a cooldown", async () => {
  // The last candidate is not "free": its 401 must both reach the client
  // (so the agent sees the real vendor message) and demote the provider for
  // the next request. Older loops skipped the bookkeeping entirely here,
  // which is why a single-provider setup kept retrying a dead key.
  const cd = fresh();
  const out = await runFailover([candidate("a")], "chat", {
    cooldown: cd,
    attempt: scripted([err("Unauthorized", 401)]),
  });
  assert.equal(out.ok, true);
  if (out.ok) assert.equal(out.response.status, 401);
  assert.equal(cd.demoted("a", "gpt-5.2", "chat", T0 + 4 * 60_000), true);
});

test("transport-only failure falls back to 502 with no status", async () => {
  const out = await runFailover([candidate("a")], "chat", {
    cooldown: fresh(),
    attempt: scripted([new Error("connect ETIMEDOUT")]),
  });
  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.equal(out.status, undefined);
    assert.match(out.message, /ETIMEDOUT/);
  }
});

test("retry hook can replace a response before it is classified", async () => {
  // A strict OpenAI-shape upstream answers `stream_options` with a 400. The
  // chat path retries once without it; without the retry that 400 would be
  // classified as a failover 4xx and burn the candidate.
  const seen: string[] = [];
  let calls = 0;
  const dispatch = async (c: FailoverCandidate) => {
    seen.push(c.decision.provider.id);
    calls += 1;
    if (calls === 1) return err("stream_options is not supported", 400);
    return ok();
  };
  const out = await runFailover([candidate("a"), candidate("b")], "chat", {
    cooldown: fresh(),
    attempt: dispatch,
    retry: async (c, res) => (res.status !== 400 ? null : dispatch(c)),
  });
  assert.equal(out.ok, true);
  if (out.ok) assert.equal(out.response.status, 200);
  assert.equal(calls, 2);
  assert.deepEqual(seen, ["a", "a"]);
});

test("a retry that throws is treated as a transport failure for that candidate", async () => {
  const seen: string[] = [];
  const out = await runFailover([candidate("a"), candidate("b")], "chat", {
    cooldown: fresh(),
    attempt: async (c) => {
      seen.push(c.decision.provider.id);
      return ok();
    },
    retry: async (c) => {
      if (c.decision.provider.id === "a") throw new Error("retry blew up");
      return null;
    },
  });
  assert.equal(out.ok, true);
  if (out.ok) assert.equal(out.candidate.decision.provider.id, "b");
  assert.deepEqual(seen, ["a", "b"]);
});

test("empty candidate list fails closed", async () => {
  const out = await runFailover([], "chat", { cooldown: fresh(), attempt: async () => ok() });
  assert.equal(out.ok, false);
});

test("the default cooldown is the process-wide instance", async () => {
  // No `cooldown` key at all: the runner must fall back to the shared one so
  // the gateway's own paths keep sharing state (regression guard for the
  // optional-injection refactor).
  const { failCooldown } = await import("./upstream-failover");
  await runFailover([candidate("shared-probe")], "chat", { attempt: scripted([err("Unauthorized", 401)]) });
  assert.equal(failCooldown.demoted("shared-probe", "gpt-5.2", "chat", Date.now() + 1000), true);
});

// ---- Streaming runner --------------------------------------------------------
//
// The streaming runner differs from the non-streaming one only in *when* a
// candidate is considered failed: establishment failures (transport / 429 /
// 5xx / failover-4xx) behave the same, but a candidate whose 200 stream
// produced no byte at all also rolls forward, because the client has seen
// nothing yet.

const streamOk = (committed: boolean, extra: Partial<StreamRelayResult> = {}): StreamRelayResult => ({
  committed,
  ttfbMs: committed ? 42 : 0,
  bytesOut: committed ? 128 : 0,
  truncated: !committed,
  ...extra,
});

test("a committed stream is never interrupted by a later candidate", async () => {
  const seen: string[] = [];
  const out = await runStreamFailover([candidate("a"), candidate("b")], "messages", {
    cooldown: fresh(),
    attempt: async (c) => {
      seen.push(c.decision.provider.id);
      return new Response("data: {}\n\n", { status: 200 });
    },
    relay: async () => streamOk(true),
  });
  assert.equal(out.ok, true);
  assert.deepEqual(seen, ["a"]);
  if (out.ok && out.relay) assert.equal(out.relay.ttfbMs, 42);
});

test("an empty stream on the last candidate is a 502, not the upstream's 200", async () => {
  // Answering 200 with an error body makes an agent treat a failed turn as a
  // successful empty one, so the runner fails the whole call instead.
  const cd = fresh();
  const out = await runStreamFailover([candidate("a")], "responses", {
    cooldown: cd,
    attempt: async () => new Response("", { status: 200 }),
    relay: async () => streamOk(false, { error: "upstream returned an empty stream" }),
  });
  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.equal(out.status, 502);
    assert.match(out.message, /empty stream/);
  }
  // The strike is recorded, so an upstream that keeps answering 200 and then
  // closing with nothing loses its turn on the second request (the same
  // two-strike rule as a transient failure — one bad stream can be a fluke).
  assert.equal(cd.demoted("a", "gpt-5.2", "responses", T0 + 1000), false);
  await runStreamFailover([candidate("a")], "responses", {
    cooldown: cd,
    attempt: async () => new Response("", { status: 200 }),
    relay: async () => streamOk(false, { error: "upstream returned an empty stream" }),
  });
  assert.equal(cd.demoted("a", "gpt-5.2", "responses", T0 + 1000), true);
});

test("an empty stream on an earlier candidate rolls to the next one", async () => {
  const seen: string[] = [];
  const out = await runStreamFailover([candidate("a"), candidate("b")], "messages", {
    cooldown: fresh(),
    attempt: async (c) => {
      seen.push(c.decision.provider.id);
      return new Response(seen.length === 1 ? "" : "data: {}\n\n", { status: 200 });
    },
    relay: async (c) => (c.decision.provider.id === "a" ? streamOk(false) : streamOk(true)),
  });
  assert.equal(out.ok, true);
  assert.deepEqual(seen, ["a", "b"]);
  if (out.ok) assert.equal(out.candidate.decision.provider.id, "b");
});

test("an establishment failure on a stream rolls forward like the plain runner", async () => {
  for (const status of [429, 500, 502, 401]) {
    const seen: string[] = [];
    const out = await runStreamFailover([candidate(`a${status}`), candidate(`b${status}`)], "chat", {
      cooldown: fresh(),
      attempt: async (c) => {
        seen.push(c.decision.provider.id);
        return seen.length === 1 ? err(`upstream ${status}`, status) : new Response("data: {}\n\n", { status: 200 });
      },
      relay: async () => streamOk(true),
    });
    assert.equal(out.ok, true, `status ${status}`);
    if (out.ok) assert.equal(out.candidate.decision.provider.id, `b${status}`);
    assert.deepEqual(seen, [`a${status}`, `b${status}`]);
  }
});

test("a client abort mid-stream escapes instead of rolling forward", async () => {
  const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
  await assert.rejects(
    () =>
      runStreamFailover([candidate("a")], "messages", {
        cooldown: fresh(),
        attempt: async () => {
          throw abort;
        },
        relay: async () => streamOk(true),
      }),
    /abort/,
  );
});

test("a committed non-2xx is handed back with relay: null for the caller to render", async () => {
  const out = await runStreamFailover([candidate("a")], "messages", {
    cooldown: fresh(),
    attempt: async () => new Response(JSON.stringify({ error: { message: "bad request" } }), { status: 400 }),
    relay: async () => {
      throw new Error("relay must not run for a non-2xx response");
    },
  });
  assert.equal(out.ok, true);
  if (out.ok) {
    assert.equal(out.relay, null);
    assert.equal(out.response.status, 400);
    assert.match(await out.response.text(), /bad request/);
  }
});

test("empty candidate list fails closed without relaying anything", async () => {
  const out = await runStreamFailover([], "messages", {
    cooldown: fresh(),
    attempt: async () => new Response("", { status: 200 }),
    relay: async () => streamOk(false),
  });
  assert.equal(out.ok, false);
});
