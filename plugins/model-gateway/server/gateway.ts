// HTTP gateway. Pure Node http server. Exposes an OpenAI-compatible surface
// at /v1/* and routes each request to a configured upstream provider.
//
// Performance choices:
//   - Single Node http server, no Express middleware overhead.
//   - Per-provider http.Agent with keep-alive for upstream connection reuse.
//   - Streaming responses are piped chunk-by-chunk; bytes are NOT buffered.
//   - Stats are recorded synchronously after response end (off the hot path).
//   - Cache lookup is in-memory (LRU + TTL).

import * as http from "node:http";
import type { AddressInfo } from "net";
import { Agent } from "undici";
// delay removed (unused)
import type { Provider, CallRecord, ProviderType } from "./storage";
import { newCallId } from "./storage";
import { ResponseCache } from "./cache";
import { getAdapter } from "./providers";
import { buildBridgeRequest, buildBridgeResponse, writeBridgeStream } from "./providers/responses-bridge";
import { buildAnthropicBridgeRequest, buildAnthropicBridgeResponse, writeAnthropicBridgeStream } from "./providers/anthropic-bridge";
import { sanitizeResponsesTools, sanitizeAnthropicTools, sanitizeResponsesInput, ensureInputContentValid } from "./tools-sanitize";
import type {
  NormalizedRequest,
  NormalizedChunk,
  ProviderAdapter,
} from "./providers/base";
import { pickProvider, pickProviderCandidates, checkRateLimit, resolveAutoChainFor, classifyTask, demoteCandidates, embeddingModelOf } from "./routing";
import type { RouteDecision } from "./routing";
import { isContextOverflow, isFailover4xx, upstreamErrorMessage } from "./upstream-errors";
import { cacheAdmission, cacheKeyFor } from "./cache-key";
import { contextWindowFor, maxOutputTokensFor } from "./model-params";
import { failCooldown, runFailover, runStreamFailover } from "./upstream-failover";
import type { FailoverCandidate } from "./upstream-failover";
import { UpstreamPump, safeWrite, safeEnd, truncatedTail, trimSseEvent, isAbortError, errorText } from "./stream-relay";
import type { StreamRelayResult } from "./stream-relay";
import type { BootstrapInput, BootstrapOutput } from "./bootstrap";
import { parseModelRef, resolveProviderByName } from "./protocols";

/** Rough prompt-size estimate: ~4 bytes per token of the raw body.
 *  Deliberately conservative (overestimates) — its only job is to reject
 *  prompts that clearly cannot fit before paying an upstream round-trip.
 *  The caller applies 150% headroom (mirrors gatewayd's pre-check) so the
 *  gateway never races the agent's own auto-compaction. */
function estimatePromptTokens(bodyBytes: Buffer): number {
  return Math.ceil(bodyBytes.length / 4);
}

/** Context-window pre-check shared by the chat and passthrough paths. Rejects
 *  prompts that clearly cannot fit before paying an upstream round-trip, and
 *  reports whether it already answered the client. The 150% headroom mirrors
 *  gatewayd: the ~4B/token estimate over-counts CJK and escaped JSON by
 *  ~30-40% versus the agent's exact counter, so rejecting at exactly the limit
 *  races the agent's own auto-compaction (observed: gateway est 167K vs codex
 *  122K on the same session). Wording matters too — Claude Code's reactive
 *  auto-compact fires on a 413 containing "context window" / "prompt is too
 *  long", so both phrases stay in the message. */
function rejectIfPromptTooLarge(res: http.ServerResponse, provider: Provider, bodyBytes: Buffer, model?: string): boolean {
  // Provider record first (an operator may run a shorter window than the
  // model card), then the per-model registry (model-params.ts): a provider
  // that declares nothing still gets a pre-check for every model we know.
  const ctxWindow = model ? contextWindowFor(provider, model) : provider.contextWindow;
  if (typeof ctxWindow !== "number" || ctxWindow <= 0) return false;
  const est = estimatePromptTokens(bodyBytes);
  if (est <= ctxWindow + ctxWindow / 2) return false;
  sendJson(res, 413, {
    error: {
      message:
        `Prompt too large for ${provider.name}: ~${est} tokens estimated (limit ${ctxWindow}). ` +
        `Trim the conversation or pick a provider with a larger context window.`,
    },
  });
  return true;
}

/** A route candidate paired with the concrete model its upstream body must
 * carry. `auto` requests expand to a cross-model chain so a rate-limited or
 * failing model rolls to the next one (mirrors gatewayd chain_candidates). */
interface TaggedCandidate {
  model: string;
  decision: RouteDecision;
}

function chainCandidates(
  model: string,
  surface: "chat" | "responses" | "messages",
  providers: Provider[],
  explicitProvider?: string,
  body?: unknown,
): TaggedCandidate[] {
  // Task-aware `auto`: classify the request and re-rank the static failover
  // chain toward the best-fit model (mirrors gatewayd's resolve_auto_chain_for).
  const task = body !== undefined ? classifyTask(body) : undefined;
  const out: TaggedCandidate[] = [];
  for (const m of resolveAutoChainFor(model, surface, providers, explicitProvider, task)) {
    for (const decision of pickProviderCandidates({ model: m, explicitProvider, providers })) {
      out.push({ model: m, decision });
    }
  }
  return out;
}

// Strict Responses upstreams reject native input items at JSON-deserialise
// time (Agnes/litellm: "Failed to deserialize the JSON body into the target
// type: input: data did not match any variant of untagged enum ResponseInput").
// Matching on it lets the passthrough retry once with sanitised input.
const RESPONSE_INPUT_DESERIALIZE_RE = /ResponseInput|did not match any variant|Failed to deserialize the JSON body|message content must be a string|non-empty array|text is required|message content must not be empty/i;

interface GatewayDeps {
  getProviders: () => Promise<Provider[]>;
  recordCall: (call: CallRecord) => void;
  recordBytes: (inBytes: number, outBytes: number) => void;
  cache: ResponseCache;
  /**
   * Return the full agent-bootstrap payload over HTTP. Lets external sync
   * scripts (Python/curl) pull provider-prefixed model labels without
   * needing a Paseo RPC client.
   */
  getBootstrap?: (input: BootstrapInput) => Promise<BootstrapOutput>;
  /** Called once before the first request so the plugin can finalize init. */
  onFirstRequest?: () => Promise<void> | void;
}

export interface StartGatewayOptions {
  /** Bind port. 0 = OS-assigned (random). */
  port?: number;
  /** Bind host. Default 127.0.0.1 (loopback only). */
  host?: string;
}

export interface GatewayHandle {
  baseUrl: string;
  port: number;
  host: string;
  startedAt: number;
  pid: number;
  close: () => Promise<void>;
}

// Agents inline images into tool results as base64 (codex view_image: ~1.6MB
// per PNG), so a multi-image turn legitimately exceeds 10MB. 50MB covers it
// while still rejecting runaway payloads.
const MAX_BODY_BYTES = 50 * 1024 * 1024; // 50 MB cap per request

// Hard ceiling per upstream request (incl. streaming). Without it a hung
// upstream pins the client session until the client gives up. Client
// disconnects still abort earlier via abortOnClientDisconnect.
const UPSTREAM_TIMEOUT_MS = 10 * 60 * 1000; // 10 min — long reasoning turns are expected

// Combine the client-disconnect controller with a hard upstream timeout.
function upstreamSignal(controller: AbortController): AbortSignal {
  return AbortSignal.any([controller.signal, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)]);
}

// Keep-alive upstream connections. Must pin undici@6: Node 22's built-in
// fetch bundles undici 6.28, and an npm-installed undici 8 Agent fails its
// dispatcher interface check ("invalid onRequestStart method"). With the
// matching major, a shared dispatcher reuses sockets across requests to the
// same host instead of a fresh TLS handshake per call (~100-300ms saved).
const UPSTREAM_DISPATCHER = new Agent({
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 600_000,
  connections: 64,
});
const DISPATCHER_OPTS = { dispatcher: UPSTREAM_DISPATCHER };

// OpenAI-schema families whose chat/completions path is a safe
// responses-bridge target when the upstream has no native /v1/responses.
const OPENAI_FAMILY = new Set(["openai", "openai-compatible", "azure-openai", "ollama"]);

export function startGateway(deps: GatewayDeps, opts: StartGatewayOptions = {}): Promise<GatewayHandle> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    let firstRequestDone = false;
    server.on("request", (req, res) => {
      const wrap = async () => {
        if (!firstRequestDone) {
          firstRequestDone = true;
          if (deps.onFirstRequest) {
            try { await deps.onFirstRequest(); } catch { /* ignore */ }
          }
        }
        await handleRequest(req, res, deps);
      };
      wrap().catch((err) => {
        // Oversized request bodies are a client fault, not a server fault.
        if (err instanceof Error && /Request body exceeds/.test(err.message)) {
          sendJson(res, 413, { error: { message: err.message } });
          return;
        }
        sendJson(res, 500, { error: { message: String(err?.message ?? err) } });
      });
    });
    server.on("error", reject);
    const port = opts.port ?? 0;
    const host = opts.host ?? "127.0.0.1";
    server.listen(port, host, () => {
      const addr = server.address() as AddressInfo;
      const boundPort = addr.port;
      const handle: GatewayHandle = {
        baseUrl: `http://${host}:${boundPort}`,
        port: boundPort,
        host,
        startedAt: Date.now(),
        pid: process.pid,
        close: () => new Promise<void>((res) => server.close(() => res())),
      };
      resolve(handle);
    });
  });
}

// ---- HTTP handler --------------------------------------------------------------

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse, deps: GatewayDeps): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname;

  // CORS preflight - allow the gateway to be exercised from browser tools
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  if (pathname === "/health" || pathname === "/") {
    sendJson(res, 200, { ok: true, ts: Date.now() });
    return;
  }

  if (pathname === "/v1/models" && req.method === "GET") {
    await handleModels(res, deps);
    return;
  }

  // Agent-bootstrap snapshot. Mirrors the gateway.agent.bootstrap RPC so
  // external sync scripts (Python/curl) can read the same payload — the
  // `[<userProviderName>] <model>` labels flow into ~/.pi/agent/models.json
  // and ~/.paseo/config.json to make the agent's model picker show the
  // owning upstream for each entry.
  if (pathname === "/v1/agents/bootstrap" && req.method === "GET") {
    await handleBootstrap(req, res, deps);
    return;
  }

  if (pathname === "/v1/chat/completions" && req.method === "POST") {
    await handleChatCompletions(req, res, deps);
    return;
  }

  if (pathname === "/v1/embeddings" && req.method === "POST") {
    await handleEmbeddings(req, res, deps);
    return;
  }

  // Anthropic-protocol passthrough (Claude Code family agents)
  if (pathname === "/v1/messages" && req.method === "POST") {
    await handleProtocolPassthrough(req, res, deps, "messages");
    return;
  }

  // OpenAI Responses-protocol passthrough (Codex family agents)
  if (pathname === "/v1/responses" && req.method === "POST") {
    await handleProtocolPassthrough(req, res, deps, "responses");
    return;
  }

  sendJson(res, 404, { error: { message: `No route for ${req.method} ${pathname}` } });
}

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
  };
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": buf.length,
    ...corsHeaders(),
  });
  res.end(buf);
}

// ---- /v1/models ----------------------------------------------------------------

async function handleModels(res: http.ServerResponse, deps: GatewayDeps): Promise<void> {
  const providers = await deps.getProviders();
  const data = providers
    .filter((p) => p.enabled)
    .flatMap((p) =>
      p.models.map((model) => ({
        id: model,
        object: "model",
        created: Math.floor(p.createdAt / 1000),
        owned_by: p.type,
      })),
    );
  // Always expose the synthetic gateway identity for health probes.
  data.push({ id: "gateway", object: "model", created: 0, owned_by: "gateway" as ProviderType });
  sendJson(res, 200, { object: "list", data });
}

// ---- /v1/agents/bootstrap ------------------------------------------------------

async function handleBootstrap(req: http.IncomingMessage, res: http.ServerResponse, deps: GatewayDeps): Promise<void> {
  if (!deps.getBootstrap) {
    sendJson(res, 503, { error: { message: "Bootstrap endpoint not available" } });
    return;
  }
  // includeRaw can be toggled via ?includeRaw=true; defaults to false so a
  // plain GET returns the smallest payload sufficient for agent config sync.
  const url = new URL(req.url ?? "/", "http://localhost");
  const includeRaw = url.searchParams.get("includeRaw") === "true";
  try {
    const data = await deps.getBootstrap({ includeRaw });
    sendJson(res, 200, data);
  } catch (err) {
    sendJson(res, 500, { error: { message: err instanceof Error ? err.message : String(err) } });
  }
}

// ---- /v1/chat/completions ------------------------------------------------------

async function handleChatCompletions(req: http.IncomingMessage, res: http.ServerResponse, deps: GatewayDeps): Promise<void> {
  const providers = await deps.getProviders();
  if (providers.length === 0) {
    sendJson(res, 503, { error: { message: "No providers configured. Add one in the gateway panel." } });
    return;
  }

  const bodyBytes = await readBody(req, MAX_BODY_BYTES);
  deps.recordBytes(bodyBytes.length, 0);

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(bodyBytes.toString("utf8"));
  } catch (err) {
    sendJson(res, 400, { error: { message: "Invalid JSON body" } });
    return;
  }

  const rawModel = String(parsed.model ?? "");
  if (!rawModel) {
    sendJson(res, 400, { error: { message: "Missing `model`" } });
    return;
  }
  // Accept `[<userProviderName>] <modelName>` so the agent picker can show
  // upstream ownership directly in the model id. Strip the prefix and use
  // the bare name for routing; if a name hint is found, resolve it to a
  // provider id and pass through as an explicit hint.
  const ref = parseModelRef(rawModel);
  const nameHint = resolveProviderByName(ref.providerNameHint, providers);
  const explicitProvider = typeof parsed.provider === "string"
    ? (parsed.provider as string)
    : nameHint;
  // Expand the virtual `auto` model to a cross-model failover chain (mirrors
  // gatewayd's chain_candidates): each candidate carries the concrete model
  // its upstream body must use, so a rate-limited or failing model rolls to
  // the next chain entry, not just the next provider.
  const candidates = chainCandidates(ref.model, "chat", providers, explicitProvider, parsed);
  if (candidates.length === 0) {
    sendJson(res, 503, { error: { message: "No enabled providers" } });
    return;
  }
  let model = candidates[0].model;
  let decision = candidates[0].decision;
  const rate = checkRateLimit(decision.provider);
  if (!rate.ok) {
    res.setHeader("retry-after", Math.ceil(rate.retryAfterMs / 1000).toString());
    sendJson(res, 429, { error: { message: `Provider ${decision.provider.name} rate-limited`, retry_after_ms: rate.retryAfterMs } });
    return;
  }

  // Same context-window pre-check the passthrough path has always applied.
  if (rejectIfPromptTooLarge(res, decision.provider, bodyBytes, model)) return;

  const stream = parsed.stream === true;
  const normalized: NormalizedRequest = {
    model,
    messages: Array.isArray(parsed.messages) ? (parsed.messages as NormalizedRequest["messages"]) : [],
    temperature: typeof parsed.temperature === "number" ? parsed.temperature : undefined,
    top_p: typeof parsed.top_p === "number" ? parsed.top_p : undefined,
    max_tokens: typeof parsed.max_tokens === "number" ? parsed.max_tokens : undefined,
    stop: Array.isArray(parsed.stop) ? (parsed.stop as string[]) : undefined,
    stream,
    tools: Array.isArray(parsed.tools) ? parsed.tools : undefined,
    tool_choice: parsed.tool_choice,
    user: typeof parsed.user === "string" ? parsed.user : undefined,
    extra: typeof parsed.provider === "string" ? { gateway_provider_hint: parsed.provider } : undefined,
  };


  const startedAt = Date.now();
  let bytesOut = 0;
  const controller = new AbortController();
  abortOnClientDisconnect(req, res, controller);

  // Upstream bodies are built per candidate: adapters can render different
  // shapes per provider, and chain entries must each carry their own
  // concrete model (for `auto`).
  const buildUpstreamBody = (cand: TaggedCandidate, withStreamOptions: boolean): Record<string, unknown> => {
    const { body } = getAdapter(cand.decision.provider.type).transformRequest(
      { ...normalized, model: cand.model },
      cand.decision.provider,
    );
    const obj = body as Record<string, unknown>;
    if (withStreamOptions && stream && cand.decision.provider.type !== "anthropic" && cand.decision.provider.type !== "google") {
      // Ask OpenAI-shape upstreams to include a usage frame in streaming
      // mode; strict upstreams that reject stream_options get one retry
      // without it.
      obj.stream_options = { include_usage: true };
    }
    return obj;
  };
  const doFetch = (cand: TaggedCandidate, withStreamOptions = true) => {
    const url = getAdapter(cand.decision.provider.type).buildUrl(cand.decision.provider, "chat");
    const hdrs = getAdapter(cand.decision.provider.type).buildHeaders(cand.decision.provider);
    return fetch(url, {
      method: "POST",
      headers: hdrs,
      body: JSON.stringify(buildUpstreamBody(cand, withStreamOptions)),
      signal: upstreamSignal(controller),
      ...DISPATCHER_OPTS,
    } as RequestInit);
  };

  // Cache admission (mirrors gatewayd chat.mbt): non-stream, tool-free,
  // deterministic sampling only (`temperature` 0 or absent). The key is a
  // canonical serialisation of the *semantic* request fields, so JSON key
  // order and side channels (`user`, `metadata`) no longer change it, and
  // `tool_choice` participates instead of disabling caching outright.
  const admission = cacheAdmission(parsed, "chat");
  let cacheKey: string | null = null;
  if (admission.cacheable) {
    cacheKey = cacheKeyFor(candidates[0].decision.provider.id, buildUpstreamBody(candidates[0], true));
    const hit = deps.cache.get(cacheKey);
    if (hit) {
      const buf = Buffer.from(hit.body);
      res.writeHead(hit.status, { "content-type": hit.contentType, "content-length": buf.length, "x-gateway-cache": "HIT", ...corsHeaders() });
      res.end(buf);
      // A replayed response still bills tokens: re-extract the usage the
      // winning upstream reported when the entry was stored, so a cache-heavy
      // session no longer shows up as a run of zero-token calls.
      const cachedUsage = usageFromCachedBody(hit.body, decision.provider.type);
      recordCallAfter({
        deps,
        provider: decision,
        model,
        endpoint: "chat",
        status: "ok",
        statusCode: hit.status,
        durationMs: 0,
        stream: false,
        cached: true,
        usage: cachedUsage,
      });
      return;
    }
  }

  try {
    // Strict OpenAI-shape upstreams reject `stream_options` with a 400 —
    // one retry without it before the response is committed.
    const retryWithoutStreamOptions = (cand: TaggedCandidate, res: Response) => {
      if (!stream || res.status !== 400) return Promise.resolve(null);
      const type = cand.decision.provider.type;
      if (type === "anthropic" || type === "google") return Promise.resolve(null);
      console.log(`[model-gateway] retrying ${cand.decision.provider.id} without stream_options`);
      return doFetch(cand, false);
    };

    // Shared failover runner (upstream-failover.ts): 429/5xx and transport
    // errors move to the next candidate, failover 4xx (billing, model
    // unavailable, dead credential, invalid-inference) move to the next
    // candidate, everything else commits. Cooled (provider, model, surface)
    // pairs sit at the tail (see demoteCandidates).
    //
    // Streaming uses the stream runner: establishment failures behave the
    // same, but a candidate whose stream never produced a byte is also
    // retryable, because the client has seen nothing yet.
    const failoverCandidates = demoteCandidates(candidates, failCooldown, "chat");
    const outcome = stream
      ? await runStreamFailover(failoverCandidates, "chat", {
          attempt: (cand) => doFetch(cand),
          retry: retryWithoutStreamOptions,
          relay: async (cand, upstreamRes) => {
            decision = cand.decision;
            model = cand.model;
            return pipeStream(res, upstreamRes, cand.decision.provider, cand.model, startedAt);
          },
        })
      : await runFailover(failoverCandidates, "chat", {
          attempt: (cand) => doFetch(cand),
          retry: retryWithoutStreamOptions,
        });
    if (!outcome.ok) {
      const duration = Date.now() - startedAt;
      const status = outcome.status ?? 502;
      const message = upstreamErrorMessage(status, outcome.message, decision.provider.name);
      if (!res.headersSent) sendJson(res, status, { error: { message: `Upstream error: ${message}` } });
      recordCallAfter({
        deps, provider: decision, model, endpoint: "chat",
        status: "error", statusCode: status,
        durationMs: duration, stream, error: message,
      });
      return;
    }
    const winner = outcome.candidate;
    const upstreamRes = outcome.response;
    decision = winner.decision;
    model = winner.model;
    if (upstreamRes.status < 400) {
      failCooldown.reset(winner.decision.provider.id, winner.model, "chat");
    }
    // Only the stream runner sets `relay`; the buffered path leaves it null so
    // the non-2xx render below still applies to it.
    const streamRelayed: StreamRelayResult | null = stream && "relay" in outcome
      ? ((outcome as { relay: StreamRelayResult | null }).relay)
      : null;
    // A relayed stream is already written to the client — only telemetry is
    // left. A truncated stream (the upstream died or hung mid-answer) is
    // recorded as an error so the panel shows it instead of a silent "ok".
    if (streamRelayed !== null) {
      deps.recordBytes(0, streamRelayed.bytesOut);
      recordCallAfter({
        deps, provider: decision, model, endpoint: "chat",
        status: streamRelayed.truncated ? "error" : "ok",
        statusCode: upstreamRes.status,
        durationMs: Date.now() - startedAt,
        stream: true,
        ttfbMs: streamRelayed.ttfbMs || undefined,
        usage: streamRelayed.usage,
        error: streamRelayed.truncated
          ? (streamRelayed.error ?? "upstream stream ended before completion")
          : undefined,
      });
      return;
    }

    // A committed non-2xx (the stream runner returns `relay: null` for it,
    // and so does the buffered runner for any non-2xx) is rendered here.
    if (streamRelayed === null && (!upstreamRes.ok || !upstreamRes.body)) {
      const text = await upstreamRes.text().catch(() => "");
      const duration = Date.now() - startedAt;
      deps.recordBytes(0, text.length);
      // Normalize vendor "context length exceeded" 400s into a clear 413.
      if (isContextOverflow(upstreamRes.status, text)) {
        sendJson(res, 413, { error: { message: `Context length exceeded on ${decision.provider.name}: ${text}` } });
        recordCallAfter({
          deps, provider: decision, model, endpoint: "chat",
          status: "error", statusCode: 413,
          durationMs: duration, stream, error: text,
        });
        return;
      }
      sendJson(res, upstreamRes.status, { error: { message: upstreamErrorMessage(upstreamRes.status, text || upstreamRes.statusText, decision.provider.name) } });
      recordCallAfter({
        deps,
        provider: decision,
        model,
        endpoint: "chat",
        status: "error",
        statusCode: upstreamRes.status,
        durationMs: duration,
        stream,
        error: upstreamErrorMessage(upstreamRes.status, text || upstreamRes.statusText, decision.provider.name),
      });
      return;
    }


    // Non-stream: buffer (so we can cache and parse usage).
    const text = await upstreamRes.text();
    const duration = Date.now() - startedAt;
    deps.recordBytes(0, text.length);
    bytesOut = text.length;

    let parsedBody: unknown;
    try { parsedBody = JSON.parse(text); } catch { parsedBody = text; }

    // Usage for the panel; the body itself is passed through verbatim.
    // Every OpenAI-shaped family (openai, openai-compatible, azure-openai,
    // ollama, zhipu, volcengine) reports `usage`, so zhipu/volcengine
    // traffic is accounted too — the old per-type branch skipped them and
    // their calls showed up as zero-token.
    const usage = usageFromBody(parsedBody, decision.provider.type);

    const outBuf = Buffer.from(text);
    res.writeHead(upstreamRes.status, {
      "content-type": upstreamRes.headers.get("content-type") ?? "application/json",
      "content-length": outBuf.length,
      ...corsHeaders(),
    });
    res.end(outBuf);

    // Only cache 2xx: a 400/429 error body cached here would be replayed to
    // every identical request for the whole cache TTL. The key is recomputed
    // for the *winning* provider, so a failover never files provider B's
    // response under provider A's name.
    if (admission.cacheable && upstreamRes.status >= 200 && upstreamRes.status < 300) {
      deps.cache.set(
        cacheKeyFor(winner.decision.provider.id, buildUpstreamBody(winner, true)),
        text,
        upstreamRes.headers.get("content-type") ?? "application/json",
        upstreamRes.status,
      );
    }

    recordCallAfter({
      deps,
      provider: decision,
      model,
      endpoint: "chat",
      status: "ok",
      statusCode: upstreamRes.status,
      durationMs: duration,
      stream: false,
      usage,
    });
  } catch (err) {
    const duration = Date.now() - startedAt;
    const message = err instanceof Error ? err.message : String(err);
    if (!res.headersSent) sendJson(res, 502, { error: { message: `Upstream error: ${message}` } });
    recordCallAfter({
      deps,
      provider: decision,
      model,
      endpoint: "chat",
      status: "error",
      durationMs: duration,
      stream,
      error: message,
    });
  }
}

// ---- /v1/messages & /v1/responses passthrough ----------------------------------

// Both protocols are natively spoken by OpenAI-compatible gateways upstream
// (verified against senseaudio). The gateway relays the body verbatim,
// keeping routing / rate-limit / telemetry, and only rewrites the target URL
// so providers that do expose native endpoints are used as-is.
async function handleProtocolPassthrough(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: GatewayDeps,
  proto: "messages" | "responses",
): Promise<void> {
  const providers = await deps.getProviders();
  if (providers.length === 0) {
    sendJson(res, 503, { error: { message: "No providers configured. Add one in the gateway panel." } });
    return;
  }

  const bodyBytes = await readBody(req, MAX_BODY_BYTES);
  deps.recordBytes(bodyBytes.length, 0);

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(bodyBytes.toString("utf8"));
  } catch {
    sendJson(res, 400, { error: { message: "Invalid JSON body" } });
    return;
  }

  const rawModel = String(parsed.model ?? "");
  if (!rawModel) {
    sendJson(res, 400, { error: { message: "Missing `model`" } });
    return;
  }

  // Same `[<providerName>] <model>` prefix handling as chat completions —
  // strip and resolve the provider hint so the picker can advertise upstream
  // ownership without breaking routing for bare model requests.
  const ref = parseModelRef(rawModel);
  const nameHint = resolveProviderByName(ref.providerNameHint, providers);
  const explicitProvider = typeof parsed.provider === "string"
    ? (parsed.provider as string)
    : nameHint;
  // Expand the virtual `auto` model to a cross-model failover chain (mirrors
  // gatewayd's chain_candidates): each candidate carries the concrete model
  // its upstream body must use.
  const candidates = chainCandidates(ref.model, proto, providers, explicitProvider, parsed);
  if (candidates.length === 0) {
    sendJson(res, 503, { error: { message: "No enabled providers" } });
    return;
  }
  let model = candidates[0].model;
  let decision = candidates[0].decision;

  // Cooled (provider, model, surface) pairs sit at the tail of the chain
  // (see demoteCandidates). Computed once: the cache lookup walks it in the
  // same order the failover runner will, so a replay is attributed to the
  // provider that actually produced it.
  const protoSurface = proto === "messages" ? "messages" : "responses";
  const failoverCandidates = demoteCandidates(candidates, failCooldown, protoSurface);

  const rate = checkRateLimit(decision.provider);
  if (!rate.ok) {
    res.setHeader("retry-after", Math.ceil(rate.retryAfterMs / 1000).toString());
    sendJson(res, 429, { error: { message: `Provider ${decision.provider.name} rate-limited`, retry_after_ms: rate.retryAfterMs } });
    return;
  }

  // Context-window pre-check (shared with the chat path; see the helper).
  if (rejectIfPromptTooLarge(res, decision.provider, bodyBytes, model)) return;

  const stream = parsed.stream === true;

  // Rebuild the body with the stripped model name so upstream does not see
  // the "[<providerName>] <model>" prefix (which only exists in the agent UI).
  const upstreamParsed: Record<string, unknown> = { ...parsed, model };
  delete (upstreamParsed as Record<string, unknown>).provider;

  // Proactively normalise empty `message` content for every Responses
  // provider (light, semantics-preserving — only drops truly empty plain
  // messages, keeps payload-carrying ones with a placeholder). Strict
  // /v1/responses upstreams reject empty content in every form, so doing it
  // up front avoids a wasted 400 round-trip. The heavier
  // sanitizeResponsesInput (folds reasoning/function items) is still applied
  // up front only for openai-compatible/ollama providers, as before.
  if (proto === "responses") {
    const ec = ensureInputContentValid(upstreamParsed.input);
    if (ec.changed) {
      upstreamParsed.input = ec.input;
      console.log(`[model-gateway] dropped empty message content in responses input for ${decision.provider.id}`);
    }
  }

  // Pre-sanitize Responses input, kept verbatim for the deserialize-retry
  // (only set when this provider does NOT get up-front sanitisation).
  let originalInput: unknown = undefined;

  // Normalise tool entries for upstreams that only accept the spec tool
  // types. Wrapper entries (namespace, custom, …) get unwrapped to their
  // inner function or dropped — otherwise strict JSON deserialisers (Agnes
  // et al.) reject the whole request with json_parse_error.
  //
  // Input sanitisation (folding reasoning/function_call items into text) is
  // NOT applied up front: it destroys conversation continuity on upstreams
  // that fully digest the Responses schema (true OpenAI, Agnes when it works).
  // Instead the request goes out verbatim and, if the upstream rejects it
  // with a deserialization error, the failover loop below retries once with
  // the sanitized input (see RESPONSE_INPUT_DESERIALIZE_RE).
  const needsInputSanitize = decision.provider.type === "openai-compatible" || decision.provider.type === "ollama";
  if (proto === "responses" && !needsInputSanitize) {
    // Remember the pre-sanitize input so the retry can rebuild it.
    originalInput = upstreamParsed.input;
  }
  if (proto === "responses" && needsInputSanitize && Array.isArray(upstreamParsed.input)) {
    const r = sanitizeResponsesInput(upstreamParsed);
    if (r.changed) {
      upstreamParsed.input = r.input;
      if (r.removed.length > 0) {
        console.log(`[model-gateway] input sanitised for ${decision.provider.id}: ${r.removed.slice(0, 6).join(", ")}${r.removed.length > 6 ? ` (+${r.removed.length - 6})` : ""}`);
      }
    }
  }

  if (Array.isArray(upstreamParsed.tools)) {
    if (proto === "responses") {
      const { tools, removed } = sanitizeResponsesTools(upstreamParsed);
      if (removed.length > 0) {
        upstreamParsed.tools = tools.length > 0 ? tools : undefined;
        if (tools.length === 0) delete upstreamParsed.tools;
        console.log(`[model-gateway] tools sanitised for ${decision.provider.id}: ${removed.join(", ")}`);
      }
    } else if (proto === "messages") {
      const { tools, changed } = sanitizeAnthropicTools(upstreamParsed);
      if (changed) upstreamParsed.tools = tools;
    }
  }

  if (proto === "responses") {
    // Strict upstreams (e.g. Agnes via litellm) reject a request that
    // carries tool_choice but no tools: "tool_choice is only allowed when
    // 'tools' are specified" — including after sanitisation dropped every
    // tool entry. Drop the orphan tool_choice; the model still gets the
    // default (auto) behaviour.
    const hasTools = Array.isArray(upstreamParsed.tools) && upstreamParsed.tools.length > 0;
    if (!hasTools) {
      if (upstreamParsed.tool_choice !== undefined || upstreamParsed.toolChoice !== undefined) {
        delete upstreamParsed.tool_choice;
        delete upstreamParsed.toolChoice;
      }
    }
    // Ceiling bump: vendors that cap omitted max_output_tokens at a small
    // default (Agnes: 4096) silently truncate reasoning-heavy turns —
    // every turn ends at ~4094 reasoning tokens with no final message.
    // The provider's own ceiling wins, otherwise the registry's per-model
    // value fills in (model-params.ts), so a provider that declares nothing
    // no longer leaves reasoning turns truncated. Explicit request values
    // are only ever raised, never lowered.
    const ceiling = maxOutputTokensFor(decision.provider, model);
    if (typeof ceiling === "number" && ceiling > 0) {
      const cur = typeof upstreamParsed.max_output_tokens === "number" ? (upstreamParsed.max_output_tokens as number) : 0;
      if (cur < ceiling) upstreamParsed.max_output_tokens = ceiling;
    }
  }

  const upstreamBody = Buffer.from(JSON.stringify(upstreamParsed));

  // Cache lookup for the responses path (mirrors gatewayd server.mbt):
  // non-stream, tool-free, `store:false` and deterministic sampling. Agent
  // traffic flows through /v1/messages & /v1/responses, never
  // /v1/chat/completions, so without this the cache never sees a request.
  const admission = cacheAdmission(upstreamParsed, "responses");
  if (admission.cacheable) {
    // The key is per provider, so the lookup walks the chain in the same
    // order the failover runner will: whichever provider produced the stored
    // answer is the one that replays it, and the call is attributed to that
    // provider rather than to the first candidate.
    for (const cand of failoverCandidates) {
      const key = cacheKeyFor(cand.decision.provider.id, { ...upstreamParsed, model: cand.model });
      const hit = deps.cache.get(key);
      if (!hit) continue;
      const buf = Buffer.from(hit.body);
      res.writeHead(hit.status, { "content-type": hit.contentType, "content-length": buf.length, "x-gateway-cache": "HIT", ...corsHeaders() });
      res.end(buf);
      decision = cand.decision;
      model = cand.model;
      // A replayed response still bills the tokens the winning upstream
      // reported when the entry was stored.
      const cachedUsage = usageFromCachedBody(hit.body, decision.provider.type);
      recordCallAfter({
        deps, provider: decision, model,
        endpoint: "responses",
        status: "ok", statusCode: hit.status,
        durationMs: 0, stream: false, cached: true,
        usage: cachedUsage,
      });
      return;
    }
  }

  // Vendors without a native Responses endpoint (zhipu) get bridged through
  // chat/completions so Codex-family agents still work.
  const adapter = getAdapter(decision.provider.type);
  if (proto === "responses" && decision.provider.type === "zhipu") {
    await handleResponsesBridge(req, res, deps, decision, adapter, upstreamParsed, upstreamBody, stream);
    return;
  }
  // Anthropic (and Anthropic-compat) vendors have no /v1/responses surface
  // at all: bridge Responses → /v1/messages so Codex-family agents can use
  // claude/minimax-m2/sensenova models too.
  if (proto === "responses" && decision.provider.type === "anthropic") {
    await handleAnthropicResponsesBridge(req, res, deps, decision, upstreamParsed, stream);
    return;
  }

  // Vendor-specific protocol surfaces (zhipu /api/anthropic, volcengine
  // /api/v3/anthropic, …) resolve through the adapter inside the failover
  // attempt() helper below.

  const startedAt = Date.now();
  const controller = new AbortController();
  abortOnClientDisconnect(req, res, controller);

  try {
    // Failover over protocol candidates; the target/headers are recomputed
    // per candidate since vendor paths and auth differ per provider.
    const attemptUrl = (cand: TaggedCandidate): string => {
      const a = getAdapter(cand.decision.provider.type);
      if (typeof a.buildProtocolUrl === "function") {
        return a.buildProtocolUrl(cand.decision.provider, proto);
      }
      const base = (cand.decision.provider.baseUrl || "https://api.senseaudio.cn").replace(/\/$/, "");
      return proto === "messages" ? `${base}/v1/messages` : `${base}/v1/responses`;
    };
    const attemptHeaders = (cand: TaggedCandidate): Record<string, string> => {
      const a = getAdapter(cand.decision.provider.type);
      const h: Record<string, string> = { "content-type": "application/json" };
      if (typeof a.buildProtocolHeaders === "function") {
        Object.assign(h, a.buildProtocolHeaders(cand.decision.provider, proto));
      } else if (proto === "messages") {
        h["x-api-key"] = cand.decision.provider.apiKey ?? "";
        h["anthropic-version"] = "2023-06-01";
      } else {
        h["authorization"] = `Bearer ${cand.decision.provider.apiKey ?? ""}`;
      }
      return h;
    };
    const attempt = (cand: TaggedCandidate) => fetch(attemptUrl(cand), {
      method: "POST",
      headers: attemptHeaders(cand),
      // Each chain entry must carry its own concrete model.
      body: Buffer.from(JSON.stringify({ ...upstreamParsed, model: cand.model })),
      signal: upstreamSignal(controller),
      ...DISPATCHER_OPTS,
    } as RequestInit);
    const attemptWith = (cand: TaggedCandidate, body: Buffer) => fetch(attemptUrl(cand), {
      method: "POST",
      headers: attemptHeaders(cand),
      body,
      signal: upstreamSignal(controller),
      ...DISPATCHER_OPTS,
    } as RequestInit);

    // Shared failover runner (upstream-failover.ts). The target/headers are
    // recomputed per candidate; cooled (provider, model, surface) pairs sit
    // at the tail (see demoteCandidates).
    const deserializeRetry = async (cand: TaggedCandidate, r: Response) => {
      // Strict Responses upstreams (Agnes/litellm) reject native Responses
      // input items (reasoning, function_call, …) at JSON-deserialise time:
      // "data did not match any variant of untagged enum ResponseInput".
      // Retry this candidate once with the sanitized input before giving up.
      if (r.status !== 400 || proto !== "responses" || originalInput === undefined) return null;
      const body4 = await r.text().catch(() => "");
      if (!RESPONSE_INPUT_DESERIALIZE_RE.test(body4)) return null;
      console.log(`[model-gateway] ResponseInput deserialize error on ${cand.decision.provider.id}, retrying with sanitised input`);
      const sanitizedParsed: Record<string, unknown> = { ...upstreamParsed, model: cand.model, input: sanitizeResponsesInput({ input: originalInput }).input };
      return attemptWith(cand, Buffer.from(JSON.stringify(sanitizedParsed)));
    };
    // Streaming uses the stream runner (stream-relay.ts): establishment
    // failures behave like the buffered path, plus a candidate whose stream
    // never produced a byte rolls on to the next one, because the client has
    // seen nothing yet. Non-streaming keeps the buffered runner.
    let streamBytesOut = 0;
    const outcome = stream
      ? await runStreamFailover(failoverCandidates, protoSurface, {
          attempt: (cand) => attempt(cand),
          retry: deserializeRetry,
          relay: async (cand, upstreamRes) => {
            decision = cand.decision;
            model = cand.model;
            // Bridge fallbacks below relay upstreamParsed verbatim — pin it
            // to the winning model so bridged requests carry the right one.
            upstreamParsed.model = cand.model;
            return relayProtocolSse(
              res, upstreamRes, proto, cand.decision.provider, startedAt,
              (n) => { streamBytesOut += n; },
            );
          },
        })
      : await runFailover(failoverCandidates, protoSurface, {
          attempt: (cand) => attempt(cand),
          retry: deserializeRetry,
        });
    if (!outcome.ok) {
      const status = outcome.status ?? 502;
      const message = upstreamErrorMessage(status, outcome.message, decision.provider.name);
      if (!res.headersSent) sendJson(res, status, { error: { message: `Upstream error: ${message}` } });
      recordCallAfter({
        deps, provider: decision, model,
        endpoint: proto === "messages" ? "anthropic" : "responses",
        status: "error", statusCode: status,
        durationMs: Date.now() - startedAt, stream,
        error: message,
      });
      return;
    }
    const winner = outcome.candidate;
    const upstreamRes = outcome.response;
    decision = winner.decision;
    model = winner.model;
    if (upstreamRes.status < 400) {
      failCooldown.reset(winner.decision.provider.id, winner.model, protoSurface);
    }
    // Bridge fallbacks below relay upstreamParsed verbatim — pin it to the
    // winning model so bridged requests carry the right one.
    upstreamParsed.model = model;

    if (!upstreamRes.ok && upstreamRes.status === 404 && proto === "responses" &&
        OPENAI_FAMILY.has(decision.provider.type) && !res.headersSent) {
      // Generic OpenAI-compatible upstreams frequently have no native
      // /v1/responses (verified: token.sensenova.cn returns 404 NOT_FOUND,
      // its chat/completions works). Fall back to the responses→chat bridge
      // so Codex-family agents keep working.
      const miss = await upstreamRes.text().catch(() => "");
      deps.recordBytes(0, miss.length);
      console.log(`[model-gateway] native /v1/responses 404 on ${decision.provider.id}, bridging via chat/completions`);
      await handleResponsesBridge(req, res, deps, decision, adapter, upstreamParsed, upstreamBody, stream);
      return;
    }

    if (!upstreamRes.ok || (stream && !upstreamRes.body)) {
      const text = await upstreamRes.text().catch(() => "");
      deps.recordBytes(0, text.length);
      // Normalize vendor "context length exceeded" 400s into a clear 413.
      if (isContextOverflow(upstreamRes.status, text)) {
        sendJson(res, 413, { error: { message: `Context length exceeded on ${decision.provider.name}: ${text}` } });
        recordCallAfter({
          deps, provider: decision, model,
          endpoint: proto === "messages" ? "anthropic" : "responses",
          status: "error", statusCode: 413,
          durationMs: Date.now() - startedAt, stream, error: text,
        });
        return;
      }
      sendJson(res, upstreamRes.status, { error: { message: text || upstreamRes.statusText } });
      recordCallAfter({
        deps, provider: decision, model,
        endpoint: proto === "messages" ? "anthropic" : "responses",
        status: "error", statusCode: upstreamRes.status,
        durationMs: Date.now() - startedAt, stream,
        error: text || upstreamRes.statusText,
      });
      return;
    }

    // A relayed stream is already written to the client — only telemetry is
    // left. A truncated stream (the upstream died or hung mid-answer) is
    // recorded as an error so the panel shows it instead of a silent "ok".
    const streamRelayed: StreamRelayResult | null = stream && "relay" in outcome
      ? ((outcome as { relay: StreamRelayResult | null }).relay)
      : null;
    if (streamRelayed !== null) {
      deps.recordBytes(0, streamBytesOut);
      recordCallAfter({
        deps, provider: decision, model,
        endpoint: proto === "messages" ? "anthropic" : "responses",
        status: streamRelayed.truncated ? "error" : "ok",
        statusCode: upstreamRes.status,
        durationMs: Date.now() - startedAt,
        stream: true,
        ttfbMs: streamRelayed.ttfbMs || undefined,
        usage: streamRelayed.usage,
        error: streamRelayed.truncated
          ? (streamRelayed.error ?? "upstream stream ended before completion")
          : undefined,
      });
      return;
    }


    const text = await upstreamRes.text();
    deps.recordBytes(0, text.length);
    const buf = Buffer.from(text);
    res.writeHead(upstreamRes.status, {
      "content-type": upstreamRes.headers.get("content-type") ?? "application/json",
      "content-length": buf.length,
      ...corsHeaders(),
    });
    res.end(buf);
    // Usage for the panel. Responses bodies report `input_tokens` /
    // `output_tokens` rather than the chat-style names, so the passthrough
    // used to book every non-streaming Responses call as zero tokens.
    let parsedBody: unknown;
    try { parsedBody = JSON.parse(text); } catch { parsedBody = undefined; }
    // Store 2xx responses for the responses-path cache, keyed by the winning
    // provider so a failover never mis-attributes the replay.
    if (admission.cacheable && upstreamRes.status >= 200 && upstreamRes.status < 300) {
      deps.cache.set(
        cacheKeyFor(winner.decision.provider.id, upstreamParsed),
        text,
        upstreamRes.headers.get("content-type") ?? "application/json",
        upstreamRes.status,
      );
    }
    recordCallAfter({
      deps, provider: decision, model,
      endpoint: proto === "messages" ? "anthropic" : "responses",
      status: "ok", statusCode: upstreamRes.status,
      durationMs: Date.now() - startedAt, stream: false,
      usage: usageFromBody(parsedBody, decision.provider.type),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!res.headersSent) sendJson(res, 502, { error: { message: `Upstream error: ${message}` } });
    recordCallAfter({
      deps, provider: decision, model,
      endpoint: proto === "messages" ? "anthropic" : "responses",
      status: "error", durationMs: Date.now() - startedAt, stream,
      error: message,
    });
  }
}

// Relay a streaming responses/messages upstream to the client.
//
// The Anthropic messages path is event-rewritten so broken upstream streams
// get repaired: compat gateways (Agnes et al.) sometimes emit
// content_block_delta/stop without a matching content_block_start, which
// Claude Code fails on with "API Error: Content block not found". The
// responses path stays byte-for-byte.
//
// The client headers wait for the first upstream byte (stream-relay.ts), so
// a candidate whose stream produced nothing rolls to the next one
// invisibly; a stream that dies mid-answer is terminated loudly and
// reported as an error instead of being recorded as a silent success.
async function relayProtocolSse(
  res: http.ServerResponse,
  upstreamRes: Response,
  proto: "messages" | "responses",
  provider: Provider,
  startedAt: number,
  onBytes: (n: number) => void,
): Promise<StreamRelayResult> {
  const pump = new UpstreamPump(upstreamRes, startedAt, () => {
    res.writeHead(upstreamRes.status, {
      "content-type": upstreamRes.headers.get("content-type") ?? "text/event-stream",
      "cache-control": "no-cache",
      "connection": "keep-alive",
      ...corsHeaders(),
    });
  });
  if (!(await pump.prime())) {
    return {
      committed: false,
      ttfbMs: 0,
      bytesOut: 0,
      truncated: false,
      error: "upstream produced no stream data",
    };
  }

  let usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;
  // Client-side fallback counters: some upstreams (Agnes /v1/messages)
  // never send a message_delta usage frame, so completion tokens are
  // estimated from the streamed text at ~4 chars/token.
  let deltaChars = 0;
  // Content blocks the upstream opened but never closed (messages repair).
  const openBlocks = new Set<number>();

  const scanFrame = (frame: string) => {
    if (!frame.startsWith("data:")) return;
    const payload = frame.slice(5).trim();
    if (!payload) return;
    if (payload === "[DONE]") {
      pump.state.completed = true;
      return;
    }
    try {
      const obj = JSON.parse(payload) as {
        type?: string;
        delta?: { text?: string; thinking?: string };
        message?: { usage?: { input_tokens?: number; output_tokens?: number } };
        usage?: { input_tokens?: number; output_tokens?: number };
        response?: { usage?: { input_tokens?: number; output_tokens?: number; prompt_tokens?: number; completion_tokens?: number } };
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
      };
      // Terminal events. The Messages protocol ends with `message_stop`, the
      // Responses protocol with `response.completed`; without this a perfectly
      // complete stream looks truncated and gets a spurious error frame.
      if (obj.type === "message_stop" || obj.type === "response.completed") {
        pump.state.completed = true;
      }
      if (obj.type === "message_start" && obj.message?.usage?.input_tokens != null) {
        usage = { ...usage, prompt_tokens: obj.message.usage.input_tokens };
      }
      if (obj.type === "message_delta" && obj.usage?.output_tokens != null) {
        usage = { ...usage, completion_tokens: obj.usage.output_tokens };
      }
      // Count streamed deltas for the fallback estimate (text + thinking).
      if (obj.type === "content_block_delta") {
        const d = obj.delta ?? {};
        deltaChars += (d.text ?? "").length + (d.thinking ?? "").length;
      }
      // OpenAI Responses protocol: response.completed carries full usage.
      if (obj.response?.usage) {
        const u = obj.response.usage;
        usage = {
          prompt_tokens: u.prompt_tokens ?? u.input_tokens,
          completion_tokens: u.completion_tokens ?? u.output_tokens,
        };
      }
      if (obj.usageMetadata) {
        usage = {
          prompt_tokens: obj.usageMetadata.promptTokenCount,
          completion_tokens: obj.usageMetadata.candidatesTokenCount,
        };
      }
    } catch { /* ignore malformed frame */ }
  };

  const finish = (failure?: string): StreamRelayResult => {
    const truncated = failure !== undefined || !pump.state.completed;
    if (truncated) {
      safeWrite(res, truncatedTail(
        proto,
        failure ?? "upstream stream ended before completion",
        [...openBlocks].sort((a, b) => a - b),
      ));
      pump.state.completed = true;
    }
    safeEnd(res);
    // Fallback: upstream never sent a usage frame — estimate completion
    // tokens from the streamed delta characters (~4 chars/token).
    if (usage?.completion_tokens == null && deltaChars > 0) {
      usage = { ...usage, completion_tokens: Math.ceil(deltaChars / 4) };
    }
    if (usage?.prompt_tokens != null && usage?.completion_tokens != null && usage.total_tokens == null) {
      usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
    }
    return {
      committed: true,
      ttfbMs: pump.state.ttfbMs,
      bytesOut: pump.state.bytesOut,
      truncated,
      error: failure,
      usage,
    };
  };

  try {
    if (proto === "messages") {
      // Split the byte stream into complete SSE events (blank-line
      // separated) and forward each through repair.
      let evtBuf = "";
      const flushEvent = () => {
        if (!evtBuf) return;
        const evtText = evtBuf;
        evtBuf = "";
        for (const line of evtText.split("\n")) {
          if (line.startsWith("data:")) scanFrame(line.replace(/\r$/, ""));
        }
        safeWrite(res, repairEvent(evtText, provider.id, openBlocks));
      };
      for await (const { text } of pump.chunks()) {
        onBytes(text.length);
        let sep: number;
        let carry = text;
        while ((sep = carry.indexOf("\n")) >= 0) {
          const line = carry.slice(0, sep);
          carry = carry.slice(sep + 1);
          if (line.trim() === "") {
            flushEvent();
          } else {
            evtBuf += line + "\n";
          }
        }
        if (carry) evtBuf += carry;
      }
      // Always flush: a stream that ends without its trailing blank line
      // still holds a complete event the client needs.
      flushEvent();
    } else {
      for await (const { raw, text } of pump.chunks()) {
        onBytes(raw.byteLength);
        safeWrite(res, raw);
        // Telemetry-only parse; the byte relay above is untouched.
        for (const line of text.split("\n")) {
          const l = line.replace(/\r$/, "").trim();
          if (l) scanFrame(l);
        }
      }
    }
  } catch (err) {
    const message = isAbortError(err)
      ? "upstream stream interrupted (client disconnected)"
      : `upstream stream error: ${errorText(err)}`;
    return finish(message);
  }

  return finish();
}

/** Split a buffer that carries several glued-together events into individual
 *  ones. The blank line is the only SSE event separator, and some upstreams
 *  (and every HTTP proxy that re-frames a chunk) drop it, which makes the
 *  client parse the whole batch as one event with two `data:` lines and
 *  silently lose everything after the first. A new event starts at an
 *  `event:` line once the current one already carries data, which keeps a
 *  legitimately multi-line `data:` field together. */
export function splitSseEvents(evtText: string): string[] {
  const groups: string[] = [];
  let cur: string[] = [];
  let hasData = false;
  for (const line of evtText.replace(/\n+$/, "").split("\n")) {
    if (cur.length > 0 && hasData && line.startsWith("event:")) {
      groups.push(cur.join("\n"));
      cur = [];
      hasData = false;
    }
    if (line.startsWith("data:")) hasData = true;
    cur.push(line);
  }
  if (cur.length > 0) groups.push(cur.join("\n"));
  return groups;
}

/** Rewrite one Anthropic SSE event (or a batch of them) so a stream that
 *  skips `content_block_start` still parses on the client, and track which
 *  blocks are open so a truncated stream can be closed cleanly. */
export function repairEvent(evtText: string, providerId: string, openBlocks: Set<number>): string {
  // Events carry an `event:` line plus a `data:` line; the payload is
  // whatever follows the data: prefix.
  const parts = splitSseEvents(evtText);
  if (parts.length > 1) return parts.map((p) => repairEvent(p, providerId, openBlocks)).join("");
  const evtTextOne = parts.join("\n");
  const dataLine = evtTextOne.split("\n").find((l) => l.startsWith("data:"));
  if (!dataLine) return trimSseEvent(evtTextOne) + "\n\n";
  const payload = dataLine.slice(5).trim();
  if (!payload || payload === "[DONE]") return trimSseEvent(evtTextOne) + "\n\n";
  let evt: Record<string, any>;
  try { evt = JSON.parse(payload); } catch { return trimSseEvent(evtTextOne) + "\n\n"; }
  const idx = typeof evt.index === "number" ? evt.index : undefined;
  if (evt.type === "content_block_start" && idx != null) {
    openBlocks.add(idx);
    return trimSseEvent(evtTextOne) + "\n\n";
  }
  if (evt.type === "content_block_stop" && idx != null) {
    // A stop for a block that was never opened has no content to protect;
    // forwarding it keeps the client's index bookkeeping in step.
    openBlocks.delete(idx);
    return trimSseEvent(evtTextOne) + "\n\n";
  }
  if (evt.type === "content_block_delta" && idx != null && !openBlocks.has(idx)) {
    // Upstream skipped content_block_start for this index — inject
    // a synthetic one so the client sees a well-formed sequence.
    const dType = evt.type === "content_block_delta" ? evt.delta?.type : undefined;
    const block = dType === "input_json_delta"
      ? { type: "tool_use", id: `toolu_repair_${idx}`, name: "", input: {} }
      : dType === "thinking_delta" || dType === "signature_delta"
        ? { type: "thinking", thinking: "" }
        : { type: "text", text: "" };
    console.log(`[model-gateway] injected missing content_block_start (index ${idx}, ${block.type}) for ${providerId}`);
    openBlocks.add(idx);
    const start = `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: idx, content_block: block })}\n\n`;
    return start + trimSseEvent(evtTextOne) + "\n\n";
  }
  return trimSseEvent(evtTextOne) + "\n\n";
}

// ---- Responses→Chat bridge (zhipu & friends without native /responses) ---------

async function handleResponsesBridge(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: GatewayDeps,
  decision: RouteDecision,
  adapter: ProviderAdapter,
  parsed: Record<string, unknown>,
  _bodyBytes: Buffer,
  stream: boolean,
): Promise<void> {
  const model = String(parsed.model ?? "");
  const upstreamUrl = adapter.buildUrl(decision.provider, "chat");
  const headers = adapter.buildHeaders(decision.provider);
  {
    const r = sanitizeResponsesInput(parsed);
    if (r.changed) parsed.input = r.input;
  }
  const bridgeBody = buildBridgeRequest(parsed as unknown as Parameters<typeof buildBridgeRequest>[0]);
  // Bridge path: chat/completions upstreams only know OpenAI function tools.
  {
    const { tools, removed } = sanitizeResponsesTools(parsed);
    if (removed.length > 0) {
      console.log(`[model-gateway] bridge tools sanitised: ${removed.join(", ")}`);
    }
    if (tools.length > 0) {
      // Forward the (already sanitised) tool declarations, plus tool_choice
      // when tools survive — otherwise bridged Codex turns silently lose
      // all tool capability (and a bare tool_choice 400s on strict vendors).
      // Responses tool entries are normalised to the chat-completions
      // nested {type:"function", function:{…}} schema upstreams expect.
      const chatTools = toChatTools(tools);
      if (chatTools.length > 0) {
        (bridgeBody as Record<string, unknown>).tools = chatTools;
        if (parsed.tool_choice !== undefined) {
          (bridgeBody as Record<string, unknown>).tool_choice = parsed.tool_choice;
        }
      }
    }
  }

  const startedAt = Date.now();
  const controller = new AbortController();
  abortOnClientDisconnect(req, res, controller);

  const payload = JSON.stringify({ ...bridgeBody, stream });
  const attempt = () => fetch(upstreamUrl, {
    method: "POST",
    headers,
    body: payload,
    signal: upstreamSignal(controller),
    ...DISPATCHER_OPTS,
  } as RequestInit);

  try {
    // Shared failover runner (upstream-failover.ts). A bridge request is
    // routed to exactly one provider, so the candidate list is a singleton —
    // it still gets the transport/429/5xx/4xx classification and the shared
    // cooldown bookkeeping, and the error body goes through
    // `upstreamErrorMessage` so an empty upstream body never reaches the
    // agent as an empty string.
    const outcome = await runFailover([{ model, decision }], "responses", { attempt });
    if (!outcome.ok) {
      const status = outcome.status ?? 502;
      const message = upstreamErrorMessage(status, outcome.message, decision.provider.name);
      if (!res.headersSent) sendJson(res, status, { error: { message: `Upstream error: ${message}` } });
      recordCallAfter({
        deps, provider: decision, model,
        endpoint: "responses",
        status: "error", statusCode: status,
        durationMs: Date.now() - startedAt, stream, error: message,
      });
      return;
    }
    const upstreamRes = outcome.response;
    decision = outcome.candidate.decision;

    if (!upstreamRes.ok || (stream && !upstreamRes.body)) {
      const text = await upstreamRes.text().catch(() => "");
      deps.recordBytes(0, text.length);
      // Normalize vendor "context length exceeded" 400s into a clear 413.
      if (isContextOverflow(upstreamRes.status, text)) {
        sendJson(res, 413, { error: { message: `Context length exceeded on ${decision.provider.name}: ${text}` } });
        recordCallAfter({
          deps, provider: decision, model,
          endpoint: "responses",
          status: "error", statusCode: 413,
          durationMs: Date.now() - startedAt, stream, error: text,
        });
        return;
      }
      const message = upstreamErrorMessage(upstreamRes.status, text, decision.provider.name);
      sendJson(res, upstreamRes.status, { error: { message } });
      recordCallAfter({
        deps, provider: decision, model, endpoint: "responses",
        status: "error", statusCode: upstreamRes.status,
        durationMs: Date.now() - startedAt, stream,
        error: message,
      });
      return;
    }

    if (stream && upstreamRes.body) {
      // Translate the adapter's normalized chunk stream into Responses SSE.
      // The headers wait for the first upstream byte (stream-relay.ts): a
      // bridge upstream that answers 200 and then closes empty used to hand
      // the agent a silent 200, which Codex treats as a finished turn. With
      // the pump primed first, that case becomes an explicit error instead.
      const pump = new UpstreamPump(upstreamRes, startedAt, () => {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          "connection": "keep-alive",
          ...corsHeaders(),
        });
      });
      if (!(await pump.prime())) {
        const message = "upstream returned an empty stream";
        deps.recordBytes(0, 0);
        recordCallAfter({
          deps, provider: decision, model, endpoint: "responses",
          status: "error", statusCode: 502,
          durationMs: Date.now() - startedAt, stream: true,
          error: message,
        });
        if (!res.headersSent) sendJson(res, 502, { error: { message } });
        return;
      }
      const ttfbMs = pump.state.ttfbMs;
      async function* rawChunks(): AsyncIterable<Buffer> {
        for await (const { raw } of pump.chunks()) {
          yield Buffer.from(raw);
        }
      }
      const chunks = adapter.transformStream
        ? adapter.transformStream(rawChunks(), decision.provider, model)
        : (async function* (): AsyncIterable<NormalizedChunk> {})();
      const { usage, failed } = await writeBridgeStream(res, chunks, model);
      safeEnd(res);
      deps.recordBytes(0, pump.state.bytesOut);
      recordCallAfter({
        deps, provider: decision, model, endpoint: "responses",
        status: failed ? "error" : "ok", statusCode: 200,
        durationMs: Date.now() - startedAt, stream: true, usage,
        ttfbMs: ttfbMs || undefined,
        error: failed ? "upstream stream failed mid-answer" : undefined,
      });
      return;
    }

    const text = await upstreamRes.text();
    deps.recordBytes(0, text.length);
    let chatBody: unknown;
    try { chatBody = JSON.parse(text); } catch { chatBody = {}; }
    const out = buildBridgeResponse(chatBody, model);
    const buf = Buffer.from(JSON.stringify(out));
    res.writeHead(200, {
      "content-type": "application/json",
      "content-length": buf.length,
      ...corsHeaders(),
    });
    res.end(buf);
    const usageObj = (chatBody as { usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } }).usage;
    recordCallAfter({
      deps, provider: decision, model, endpoint: "responses",
      status: "ok", statusCode: 200,
      durationMs: Date.now() - startedAt, stream: false,
      usage: usageObj,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!res.headersSent) sendJson(res, 502, { error: { message: `Bridge error: ${message}` } });
    recordCallAfter({
      deps, provider: decision, model, endpoint: "responses",
      status: "error", durationMs: Date.now() - startedAt, stream,
      error: message,
    });
  }
}

// ---- responses → anthropic /v1/messages bridge --------------------------------

async function handleAnthropicResponsesBridge(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: GatewayDeps,
  decision: RouteDecision,
  parsed: Record<string, unknown>,
  stream: boolean,
): Promise<void> {
  const model = String(parsed.model ?? "");
  const adapter = getAdapter("anthropic");
  const target = adapter.buildProtocolUrl!(decision.provider, "messages");
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (typeof adapter.buildProtocolHeaders === "function") {
    Object.assign(headers, adapter.buildProtocolHeaders(decision.provider, "messages"));
  }
  {
    const r = sanitizeResponsesInput(parsed);
    if (r.changed) parsed.input = r.input;
  }
  const bridgeBody = buildAnthropicBridgeRequest(parsed as unknown as Parameters<typeof buildAnthropicBridgeRequest>[0]);
  const startedAt = Date.now();
  const controller = new AbortController();
  abortOnClientDisconnect(req, res, controller);

  const payload = JSON.stringify(bridgeBody);
  const attempt = () => fetch(target, {
    method: "POST",
    headers,
    body: payload,
    signal: upstreamSignal(controller),
    ...DISPATCHER_OPTS,
  } as RequestInit);

  try {
    // Shared failover runner (upstream-failover.ts): singleton candidate
    // chain, shared error classification and shared cooldown bookkeeping.
    const outcome = await runFailover([{ model, decision }], "messages", { attempt });
    if (!outcome.ok) {
      const status = outcome.status ?? 502;
      const message = upstreamErrorMessage(status, outcome.message, decision.provider.name);
      if (!res.headersSent) sendJson(res, status, { error: { message: `Upstream error: ${message}` } });
      recordCallAfter({
        deps, provider: decision, model,
        endpoint: "responses",
        status: "error", statusCode: status,
        durationMs: Date.now() - startedAt, stream, error: message,
      });
      return;
    }
    const upstreamRes = outcome.response;
    decision = outcome.candidate.decision;

    if (!upstreamRes.ok || (stream && !upstreamRes.body)) {
      const text = await upstreamRes.text().catch(() => "");
      deps.recordBytes(0, text.length);
      // Normalize vendor "context length exceeded" 400s into a clear 413.
      if (isContextOverflow(upstreamRes.status, text)) {
        sendJson(res, 413, { error: { message: `Context length exceeded on ${decision.provider.name}: ${text}` } });
        recordCallAfter({
          deps, provider: decision, model,
          endpoint: "responses",
          status: "error", statusCode: 413,
          durationMs: Date.now() - startedAt, stream, error: text,
        });
        return;
      }
      const message = upstreamErrorMessage(upstreamRes.status, text, decision.provider.name);
      sendJson(res, upstreamRes.status, { error: { message } });
      recordCallAfter({
        deps, provider: decision, model, endpoint: "responses",
        status: "error", statusCode: upstreamRes.status,
        durationMs: Date.now() - startedAt, stream,
        error: message,
      });
      return;
    }

    if (stream && upstreamRes.body) {
      // Same deferred-commit rule as the chat bridge: the agent must not get a
      // 200 SSE header (and a `response.created` frame) for a stream that
      // never delivered a byte.
      const pump = new UpstreamPump(upstreamRes, startedAt, () => {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          "connection": "keep-alive",
          ...corsHeaders(),
        });
      });
      if (!(await pump.prime())) {
        const message = "upstream returned an empty stream";
        deps.recordBytes(0, 0);
        recordCallAfter({
          deps, provider: decision, model, endpoint: "responses",
          status: "error", statusCode: 502,
          durationMs: Date.now() - startedAt, stream: true,
          error: message,
        });
        if (!res.headersSent) sendJson(res, 502, { error: { message } });
        return;
      }
      const { usage, ttfbMs } = await pipeAnthropicSse(res, pumpBytes(pump), model, startedAt);
      safeEnd(res);
      deps.recordBytes(0, pump.state.bytesOut);
      recordCallAfter({
        deps, provider: decision, model, endpoint: "responses",
        status: "ok", statusCode: 200,
        durationMs: Date.now() - startedAt, stream: true, usage,
        ttfbMs: ttfbMs || undefined,
      });
      return;
    }

    const text = await upstreamRes.text();
    deps.recordBytes(0, text.length);
    let msgBody: unknown;
    try { msgBody = JSON.parse(text); } catch { msgBody = {}; }
    const out = buildAnthropicBridgeResponse(msgBody, model);
    const buf = Buffer.from(JSON.stringify(out));
    res.writeHead(200, {
      "content-type": "application/json",
      "content-length": buf.length,
      ...corsHeaders(),
    });
    res.end(buf);
    const u = (msgBody as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
    recordCallAfter({
      deps, provider: decision, model, endpoint: "responses",
      status: "ok", statusCode: 200,
      durationMs: Date.now() - startedAt, stream: false,
      usage: u ? { prompt_tokens: u.input_tokens, completion_tokens: u.output_tokens } : undefined,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!res.headersSent) sendJson(res, 502, { error: { message: `Anthropic bridge error: ${message}` } });
    recordCallAfter({
      deps, provider: decision, model, endpoint: "responses",
      status: "error", durationMs: Date.now() - startedAt, stream,
      error: message,
    });
  }
}

/** Feed an already-primed pump to the byte-level SSE parsers. */
async function* pumpBytes(pump: UpstreamPump): AsyncIterable<Uint8Array> {
  for await (const { raw } of pump.chunks()) {
    yield raw;
  }
}

// Parse raw Anthropic SSE bytes into data-lines and drive the Responses SSE writer.
async function pipeAnthropicSse(
  res: http.ServerResponse,
  bytes: AsyncIterable<Uint8Array>,
  model: string,
  startedAt: number = 0,
): Promise<{ usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }; ttfbMs: number }> {
  const decoder = new TextDecoder();
  let carry = "";
  let ttfbMs = 0;
  async function* frames(): AsyncIterable<string> {
    for await (const value of bytes) {
      if (ttfbMs === 0) ttfbMs = Date.now() - startedAt;
      carry += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = carry.indexOf("\n")) >= 0) {
        const line = carry.slice(0, sep).trim();
        carry = carry.slice(sep + 1);
        if (line.startsWith("data:")) yield line;
      }
    }
  }
  const { usage } = await writeAnthropicBridgeStream(res, frames(), model);
  return { usage, ttfbMs };
}

async function handleEmbeddings(req: http.IncomingMessage, res: http.ServerResponse, deps: GatewayDeps): Promise<void> {
  const providers = await deps.getProviders();
  if (providers.length === 0) {
    sendJson(res, 503, { error: { message: "No enabled providers" } });
    return;
  }
  const bodyBytes = await readBody(req, MAX_BODY_BYTES);
  deps.recordBytes(bodyBytes.length, 0);

  // Route on the *requested* model, not a hardcoded "embed": an embeddings
  // call names a specific embedding model, and picking a provider by that
  // name is what keeps a text-only chain from swallowing the request. Only
  // fall back to the generic "embed" bucket when the body carries no model.
  const requestedModel = embeddingModelOf(bodyBytes.toString("utf8"));
  const decisions = pickProviderCandidates({ model: requestedModel, providers });
  if (decisions.length === 0) {
    sendJson(res, 503, { error: { message: "No enabled providers" } });
    return;
  }
  const candidates: FailoverCandidate[] = decisions.map((d) => ({ model: requestedModel, decision: d }));

  const startedAt = Date.now();
  const controller = new AbortController();
  abortOnClientDisconnect(req, res, controller);

  try {
    // Shared failover runner: a transport error or a 429/5xx rolls to the
    // next embedding-capable provider, and the cooldown is shared with every
    // other surface so a dead key is felt once.
    const outcome = await runFailover(
      demoteCandidates(candidates, failCooldown, "embeddings"),
      "embeddings",
      {
        attempt: (cand) => {
          const adapter = getAdapter(cand.decision.provider.type);
          return fetch(adapter.buildUrl(cand.decision.provider, "embeddings"), {
            method: "POST",
            headers: adapter.buildHeaders(cand.decision.provider),
            body: bodyBytes,
            signal: upstreamSignal(controller),
            ...DISPATCHER_OPTS,
          } as RequestInit);
        },
      },
    );

    if (!outcome.ok) {
      const status = outcome.status ?? 502;
      const message = upstreamErrorMessage(status, outcome.message, decisions[0].provider.name);
      if (!res.headersSent) sendJson(res, status, { error: { message: `Upstream error: ${message}` } });
      recordCallAfter({
        deps,
        provider: decisions[0],
        model: requestedModel,
        endpoint: "embeddings",
        status: "error",
        statusCode: status,
        durationMs: Date.now() - startedAt,
        stream: false,
        error: message,
      });
      return;
    }

    const { decision } = outcome.candidate;
    const upstreamRes = outcome.response;
    const text = await upstreamRes.text().catch(() => "");
    deps.recordBytes(0, text.length);
    const buf = Buffer.from(text);
    if (!res.headersSent) {
      res.writeHead(upstreamRes.status, {
        "content-type": upstreamRes.headers.get("content-type") ?? "application/json",
        "content-length": buf.length,
        ...corsHeaders(),
      });
      res.end(buf);
    }
    recordCallAfter({
      deps,
      provider: decision,
      model: requestedModel,
      endpoint: "embeddings",
      status: upstreamRes.ok ? "ok" : "error",
      statusCode: upstreamRes.status,
      durationMs: Date.now() - startedAt,
      stream: false,
      error: upstreamRes.ok ? undefined : upstreamErrorMessage(upstreamRes.status, text, decision.provider.name),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!res.headersSent) sendJson(res, 502, { error: { message } });
    recordCallAfter({
      deps,
      provider: decisions[0],
      model: requestedModel,
      endpoint: "embeddings",
      status: "error",
      durationMs: Date.now() - startedAt,
      stream: false,
      error: message,
    });
  }
}

// ---- Streaming passthrough -----------------------------------------------------

async function pipeStream(
  res: http.ServerResponse,
  upstreamRes: Response,
  provider: Provider,
  model: string,
  startedAt: number,
): Promise<StreamRelayResult> {
  // For OpenAI-compatible providers, stream raw bytes back to the client.
  // For non-OpenAI providers (Anthropic, Google), translate chunks into
  // OpenAI's SSE format so clients (Paseo, OpenAI SDK, etc.) just work.
  const isOpenAIShape = provider.type === "openai" || provider.type === "openai-compatible" || provider.type === "azure-openai" || provider.type === "ollama" || provider.type === "zhipu" || provider.type === "volcengine";

  // The client's status line waits for the first upstream byte
  // (stream-relay.ts): a candidate that answers 200 and then dies, hangs or
  // closes with an empty stream must leave no trace so the failover runner
  // can swap in the next one invisibly.
  const pump = new UpstreamPump(upstreamRes, startedAt, () => {
    res.writeHead(upstreamRes.status, {
      "content-type": upstreamRes.headers.get("content-type") ?? "text/event-stream",
      "cache-control": "no-cache",
      "connection": "keep-alive",
      ...corsHeaders(),
    });
  });
  if (!(await pump.prime())) {
    return {
      committed: false,
      ttfbMs: 0,
      bytesOut: 0,
      truncated: false,
      error: "upstream produced no stream data",
    };
  }

  let usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;
  // Text deltas seen, used to estimate completion tokens when the upstream
  // never sends a usage frame (ported from the messages/responses relays).
  let deltaChars = 0;
  // Whether a `data: [DONE]` was already forwarded verbatim.
  let wroteDone = false;
  let sawChunk = false;

  /** Terminate the client stream: an explicit error frame plus `[DONE]` when
   *  the upstream never terminated it itself. */
  const finish = (failure?: string): StreamRelayResult => {
    const truncated = failure !== undefined || !pump.state.completed;
    if (truncated) {
      safeWrite(res, truncatedTail("chat", failure ?? "upstream stream ended before completion"));
      pump.state.completed = true;
    } else if (!wroteDone) {
      safeWrite(res, "data: [DONE]\n\n");
    }
    safeEnd(res);
    if (usage?.completion_tokens == null && deltaChars > 0) {
      usage = { ...usage, completion_tokens: Math.ceil(deltaChars / 4) };
    }
    if (usage?.prompt_tokens != null && usage?.completion_tokens != null && usage.total_tokens == null) {
      usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
    }
    return {
      committed: true,
      ttfbMs: pump.state.ttfbMs,
      bytesOut: pump.state.bytesOut,
      truncated,
      error: failure,
      usage,
    };
  };

  try {
    let buffer = "";
    if (isOpenAIShape) {
      for await (const { text } of pump.chunks()) {
        buffer += text;
        let sep: number;
        while ((sep = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 1);
          // `lineStream` used to strip the newline; re-add it so upstream
          // framing (including \r\n) is preserved byte for byte.
          safeWrite(res, line + "\n");
          if (/^data:\s*\[DONE]/.test(line.trim())) {
            wroteDone = true;
            pump.state.completed = true;
          }
          // Usage arrives in a dedicated final frame (stream_options.include_usage).
          // Substring guard keeps the hot path free of JSON.parse.
          if (line.startsWith("data:") && line.includes('"usage"')) {
            try {
              const obj = JSON.parse(line.slice(5).trim()) as { usage?: typeof usage };
              if (obj.usage) usage = { ...usage, ...obj.usage };
            } catch { /* ignore malformed frame */ }
          }
          // Fallback accounting: some OpenAI-shape upstreams (Agnes and
          // friends) omit the usage frame entirely.
          if (line.includes('"content"') && line.includes('"delta"')) {
            try {
              const obj = JSON.parse(line.slice(5).trim()) as { choices?: Array<{ delta?: { content?: string } }> };
              const d = obj.choices?.[0]?.delta?.content;
              if (typeof d === "string") deltaChars += d.length;
            } catch { /* ignore malformed frame */ }
          }
        }
      }
      if (buffer.length > 0) safeWrite(res, buffer);
    } else {
      const emit = (obj: unknown): void => {
        const normalized: NormalizedChunk | null = provider.type === "anthropic"
          ? mapAnthropicEvent(obj as Parameters<typeof mapAnthropicEvent>[0])
          : mapGoogleChunk(obj as Parameters<typeof mapGoogleChunk>[0]);
        if (!normalized) return;
        if (normalized.delta) deltaChars += normalized.delta.length;
        if (normalized.finish_reason) pump.state.completed = true;
        if (normalized.usage) usage = { ...usage, ...normalized.usage };
        const sse = {
          id: normalized.id,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: normalized.model ?? model,
          choices: [{
            index: 0,
            delta: { content: normalized.delta ?? "" },
            finish_reason: normalized.finish_reason ?? null,
          }],
          ...(normalized.usage && normalized.usage.prompt_tokens != null && normalized.usage.completion_tokens != null ? { usage: normalized.usage } : {}),
        };
        safeWrite(res, `data: ${JSON.stringify(sse)}\n\n`);
        sawChunk = true;
      };
      for await (const { text } of pump.chunks()) {
        buffer += text;
        let sep: number;
        while ((sep = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, sep).replace(/\r$/, "").trim();
          buffer = buffer.slice(sep + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          if (payload === "[DONE]") {
            wroteDone = true;
            pump.state.completed = true;
            continue;
          }
          try {
            emit(JSON.parse(payload));
          } catch { /* ignore malformed upstream event */ }
        }
      }
      const tail = buffer.replace(/\r$/, "").trim();
      if (tail.startsWith("data:")) {
        const payload = tail.slice(5).trim();
        if (payload && payload !== "[DONE]") {
          try {
            emit(JSON.parse(payload));
          } catch { /* ignore malformed upstream event */ }
        }
      }
    }
  } catch (err) {
    // The stream already started, so the response is committed: terminate it
    // honestly instead of leaving the agent to wait on half an answer.
    const message = isAbortError(err)
      ? "upstream stream interrupted (client disconnected)"
      : `upstream stream error: ${errorText(err)}`;
    return finish(message);
  }

  return finish();
}

function mapAnthropicEvent(evt: { type?: string; message?: { id?: string; usage?: { input_tokens?: number; output_tokens?: number } }; delta?: { type?: string; text?: string; stop_reason?: string }; index?: number; usage?: { input_tokens?: number; output_tokens?: number } }): NormalizedChunk | null {
  if (evt.type === "message_start") {
    const input = evt.message?.usage?.input_tokens;
    return { id: evt.message?.id ?? "anthropic", model: "anthropic", delta: "", usage: input != null ? { prompt_tokens: input } : undefined, raw: evt };
  }
  if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") {
    return { id: "anthropic", model: "anthropic", delta: evt.delta.text ?? "", raw: evt };
  }
  if (evt.type === "message_delta") {
    const output = evt.usage?.output_tokens;
    return {
      id: "anthropic",
      model: "anthropic",
      delta: "",
      finish_reason: evt.delta?.stop_reason,
      usage: output != null ? { completion_tokens: output } : undefined,
      raw: evt,
    };
  }
  if (evt.type === "message_stop") {
    return { id: "anthropic", model: "anthropic", delta: "", finish_reason: "stop", raw: evt };
  }
  return null;
}

function mapGoogleChunk(obj: { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number } }): NormalizedChunk | null {
  const cand = obj.candidates?.[0];
  if (!cand) return null;
  const text = (cand.content?.parts ?? []).map((p) => p.text ?? "").join("");
  return {
    id: "google",
    model: "google",
    delta: text,
    finish_reason: cand.finishReason,
    usage: obj.usageMetadata
      ? {
          prompt_tokens: obj.usageMetadata.promptTokenCount,
          completion_tokens: obj.usageMetadata.candidatesTokenCount,
          total_tokens: obj.usageMetadata.totalTokenCount,
        }
      : undefined,
    raw: obj,
  };
}

// ---- Helpers -------------------------------------------------------------------

// Abort an upstream fetch only when the CLIENT disconnects before the
// response finished. `req`'s `close` event is NOT usable for this: since
// Node 18 it fires as soon as the request body is fully received, so
// aborting on it kills the upstream request right after readBody (which
// surfaced as Codex/Agnes streams cutting off mid-generation). `res.close`
// fires when the connection drops OR the response ends, so gate on
// writableEnded.
function abortOnClientDisconnect(req: http.IncomingMessage, res: http.ServerResponse, controller: AbortController): void {
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });
}

async function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > limit) {
      throw new Error(`Request body exceeds ${limit} bytes`);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks, total);
}

// Normalize Responses-API tool entries (flat {type,name,input_schema} as
// well as nested/wrapper shapes) into the chat-completions tool schema
// that every OpenAI-compatible chat endpoint expects.
function toChatTools(tools: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const t of tools) {
    if (!t || typeof t !== "object") continue;
    const o = t as Record<string, unknown>;
    const inner = o.function && typeof o.function === "object"
      ? (o.function as Record<string, unknown>)
      : o;
    const name = inner.name ?? o.name;
    if (!name) continue;
    out.push({
      type: "function",
      function: {
        name: String(name),
        description: String(inner.description ?? o.description ?? ""),
        parameters: inner.parameters ?? inner.input_schema ?? { type: "object", properties: {} },
      },
    });
  }
  return out;
}

interface RecordCallArgs {
  deps: GatewayDeps;
  provider: RouteDecision;
  model: string;
  endpoint: "chat" | "embeddings" | "anthropic" | "responses";
  status: "ok" | "error";
  statusCode?: number;
  durationMs: number;
  ttfbMs?: number;
  stream: boolean;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  error?: string;
  cached?: boolean;
}

/** Usage out of a buffered upstream body, per provider family. Kept as one
 *  function so the cached-replay path and the fresh-response path can never
 *  disagree about what a provider's usage frame looks like. Only the
 *  OpenAI-shaped families (which includes zhipu / volcengine) report
 *  `usage`; Anthropic and Google use their own field names. */
function usageFromBody(body: unknown, type: ProviderType): { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined {
  if (!body || typeof body !== "object") return undefined;
  const obj = body as Record<string, unknown>;
  if (type === "anthropic") {
    const pt = (obj.usage as { input_tokens?: number } | undefined)?.input_tokens;
    const ct = (obj.usage as { output_tokens?: number } | undefined)?.output_tokens;
    if (pt == null && ct == null) return undefined;
    return { prompt_tokens: pt ?? 0, completion_tokens: ct ?? 0, total_tokens: (pt ?? 0) + (ct ?? 0) };
  }
  if (type === "google") {
    const u = obj.usageMetadata as { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number } | undefined;
    if (!u) return undefined;
    return {
      prompt_tokens: u.promptTokenCount,
      completion_tokens: u.candidatesTokenCount,
      total_tokens: u.totalTokenCount,
    };
  }
  // Accepts both agreements in the wild: chat-style `prompt_tokens` /
  // `completion_tokens`, and Responses-style `input_tokens` / `output_tokens`
  // (the Responses surface never uses the chat names, so a Responses body
  // used to be recorded with no usage at all).
  const usage = obj.usage as {
    prompt_tokens?: number; completion_tokens?: number; total_tokens?: number;
    input_tokens?: number; output_tokens?: number;
  } | undefined;
  if (!usage) return undefined;
  const prompt = usage.prompt_tokens ?? usage.input_tokens;
  const completion = usage.completion_tokens ?? usage.output_tokens;
  if (prompt == null && completion == null) return undefined;
  const total = usage.total_tokens ?? ((prompt ?? 0) + (completion ?? 0));
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total };
}

/** Same extraction, applied to the raw text a cache entry holds. */
function usageFromCachedBody(body: string, type: ProviderType): { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined {
  try {
    return usageFromBody(JSON.parse(body), type);
  } catch {
    return undefined;
  }
}

function recordCallAfter(args: RecordCallArgs): void {
  const call: CallRecord = {
    id: newCallId(),
    ts: Date.now(),
    provider: args.provider.provider.id,
    providerName: args.provider.provider.name,
    model: args.model,
    endpoint: args.endpoint,
    status: args.status,
    statusCode: args.statusCode,
    promptTokens: args.usage?.prompt_tokens,
    completionTokens: args.usage?.completion_tokens,
    totalTokens: args.usage?.total_tokens,
    durationMs: args.durationMs,
    ttfbMs: args.ttfbMs,
    stream: args.stream,
    error: args.error,
    cached: args.cached,
  };
  args.deps.recordCall(call);
}
