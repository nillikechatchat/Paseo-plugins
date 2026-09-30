// Shared failover runner for every upstream proxy path (chat, responses,
// messages, both bridges, embeddings).
//
// The rules — identical to gatewayd's failover loops — are:
//   - transport error / timeout / 429 / 5xx  → try the next candidate
//   - failover 4xx (billing, model unavailable, dead credential,
//     provider-specific invalid-inference) → try the next candidate
//   - any other status → commit the response to the client
//   - a (provider, model, surface) that fails persistently gets a long
//     cooldown so `demoteCandidates` keeps it at the tail of the chain
//
// Keeping this in one place is what keeps the TS gateway and gatewayd from
// drifting apart; it used to be four near-identical hand-rolled loops.

import { FailCooldown, type RouteDecision } from "./routing";
import { isFailover4xx, isPersistent4xx } from "./upstream-errors";
import { isAbortError } from "./stream-relay";
import type { StreamRelayResult } from "./stream-relay";

/** Any route candidate (mirrors gateway.ts TaggedCandidate). */
export interface FailoverCandidate {
  model: string;
  decision: RouteDecision;
}

/** Cooldown shared by every path; mirrors gatewayd's process-wide cooldown. */
export const failCooldown = new FailCooldown();

export interface FailoverHooks<T> {
  /** Dispatch one candidate to its upstream. */
  attempt: (cand: T) => Promise<Response>;
  /**
   * Optional single re-attempt for a candidate whose response is retryable
   * (chat's `stream_options` fallback, the Responses deserialize retry).
   * Receives the response that was about to be committed and returns either
   * a replacement response or null to keep the original.
   */
  retry?: (cand: T, res: Response) => Promise<Response | null>;
  /**
   * Cooldown to record into. Defaults to the process-wide `failCooldown`;
   * tests inject a fresh instance so cases stay isolated.
   */
  cooldown?: FailCooldown;
}

export type FailoverOutcome<T> =
  | { ok: true; candidate: T; response: Response }
  | { ok: false; message: string; status?: number };

export async function runFailover<T extends FailoverCandidate>(
  candidates: T[],
  surface: string,
  hooks: FailoverHooks<T>,
  nowMs: number = Date.now(),
): Promise<FailoverOutcome<T>> {
  const cooldown = hooks.cooldown ?? failCooldown;
  const last = candidates[candidates.length - 1];
  let lastError: { status?: number; text: string } | undefined;

  for (const cand of candidates) {
    let res: Response;
    try {
      res = await hooks.attempt(cand);
    } catch (err) {
      if (isAbortError(err)) throw err;
      cooldown.record(cand.decision.provider.id, cand.model, surface, false, nowMs);
      lastError = { text: err instanceof Error ? err.message : String(err) };
      continue;
    }

    // Caller-owned single retry (e.g. drop stream_options / sanitise input).
    if (hooks.retry) {
      try {
        const retried = await hooks.retry(cand, res);
        if (retried) res = retried;
      } catch (err) {
        if (isAbortError(err)) throw err;
        cooldown.record(cand.decision.provider.id, cand.model, surface, false, nowMs);
        lastError = { text: err instanceof Error ? err.message : String(err) };
        continue;
      }
    }

    const isLast = cand === last;

    if (res.status === 429 || res.status >= 500) {
      // Record the cooldown even for the last candidate: a provider that is
      // rate-limited or erroring right now must stay demoted for the *next*
      // request, otherwise the single-provider case never learns anything.
      cooldown.record(cand.decision.provider.id, cand.model, surface, false, nowMs);
      if (isLast) return { ok: true, candidate: cand, response: res };
      const text = await res.text().catch(() => "");
      lastError = { status: res.status, text: text || res.statusText };
      continue;
    }

    if (res.status >= 400) {
      // Read from a clone so the response handed back stays fully readable.
      const text = await res.clone().text().catch(() => "");
      if (isFailover4xx(res.status, text)) {
        const persistent = isPersistent4xx(res.status, text);
        // Billing / model-unavailable / dead credential: cooldown even when
        // this was the last candidate, so the next request demotes it.
        cooldown.record(cand.decision.provider.id, cand.model, surface, persistent, nowMs);
        lastError = { status: res.status, text };
        if (isLast) return { ok: true, candidate: cand, response: res };
        console.log(
          `[model-gateway] failover ${res.status}${persistent ? " (persistent)" : ""} on ` +
          `${cand.decision.provider.id}/${cand.model} [${surface}], trying next candidate`,
        );
        continue;
      }
    }

    return { ok: true, candidate: cand, response: res };
  }

  return { ok: false, message: lastError?.text || "all providers failed", status: lastError?.status };
}

/** Verdict on a response whose headers arrived but whose body has not been
 *  relayed yet. Shared by the buffered and the streaming runners so the two
 *  can never disagree about which upstream is worth retrying. */
export interface EstablishmentVerdict {
  /** true when this response must roll to the next candidate. */
  failover: boolean;
  /** true when the failure is persistent (billing / model unavailable /
   *  dead credential) and deserves a long cooldown even as the last one. */
  persistent: boolean;
  status: number;
  /** Body read for classification. Empty for non-4xx statuses. */
  text: string;
}

export async function classifyEstablishment(res: Response): Promise<EstablishmentVerdict> {
  if (res.status === 429 || res.status >= 500) {
    const text = await res.text().catch(() => "");
    return { failover: true, persistent: false, status: res.status, text };
  }
  if (res.status >= 400) {
    // Read from a clone: a committed 4xx is handed back to the caller with
    // its body intact.
    const text = await res.clone().text().catch(() => "");
    if (isFailover4xx(res.status, text)) {
      return { failover: true, persistent: isPersistent4xx(res.status, text), status: res.status, text };
    }
    return { failover: false, persistent: false, status: res.status, text };
  }
  return { failover: false, persistent: false, status: res.status, text: "" };
}

export interface StreamHooks<T> {
  /** Dispatch one candidate to its upstream. */
  attempt: (cand: T) => Promise<Response>;
  /** Relay a 2xx stream. `committed: false` means nothing reached the
   *  client, so the candidate is interchangeable with the next one. */
  relay: (cand: T, res: Response) => Promise<StreamRelayResult>;
  /** Caller-owned single re-attempt (chat's `stream_options` fallback). */
  retry?: (cand: T, res: Response) => Promise<Response | null>;
  cooldown?: FailCooldown;
}

export type StreamFailoverOutcome<T> =
  | { ok: true; candidate: T; response: Response; relay: StreamRelayResult }
  | { ok: true; candidate: T; response: Response; relay: null }
  | { ok: false; message: string; status?: number };

/**
 * Failover for streaming surfaces. Establishment failures (transport /
 * 429 / 5xx / failover-4xx) behave exactly like `runFailover`. The
 * difference is the commit point: the stream is relayed as soon as the
 * upstream produces a byte, and a candidate whose stream produced nothing
 * (empty body, closed early, failed before the first chunk) rolls on to
 * the next one because the client has seen nothing to react to.
 *
 * `relay: null` signals a committed non-2xx response — the caller renders
 * its status and body itself (including the context-overflow → 413 mapping).
 */
export async function runStreamFailover<T extends FailoverCandidate>(
  candidates: T[],
  surface: string,
  hooks: StreamHooks<T>,
  nowMs: number = Date.now(),
): Promise<StreamFailoverOutcome<T>> {
  const cooldown = hooks.cooldown ?? failCooldown;
  const last = candidates[candidates.length - 1];
  let lastError: { status?: number; text: string } | undefined;

  for (const cand of candidates) {
    let res: Response;
    try {
      res = await hooks.attempt(cand);
    } catch (err) {
      if (isAbortError(err)) throw err;
      cooldown.record(cand.decision.provider.id, cand.model, surface, false, nowMs);
      lastError = { text: err instanceof Error ? err.message : String(err) };
      continue;
    }

    if (hooks.retry) {
      try {
        const retried = await hooks.retry(cand, res);
        if (retried) res = retried;
      } catch (err) {
        if (isAbortError(err)) throw err;
        cooldown.record(cand.decision.provider.id, cand.model, surface, false, nowMs);
        lastError = { text: err instanceof Error ? err.message : String(err) };
        continue;
      }
    }

    const verdict = await classifyEstablishment(res);
    if (verdict.failover) {
      // Record the cooldown even for the last candidate so the *next*
      // request demotes it (see runFailover).
      cooldown.record(cand.decision.provider.id, cand.model, surface, verdict.persistent, nowMs);
      lastError = { status: verdict.status, text: verdict.text };
      if (cand === last) return { ok: true, candidate: cand, response: res, relay: null };
      console.log(
        `[model-gateway] failover ${verdict.status}${verdict.persistent ? " (persistent)" : ""} on ` +
        `${cand.decision.provider.id}/${cand.model} [${surface}], trying next candidate`,
      );
      continue;
    }

    // A committed non-2xx (bad request, context overflow, …) has nothing to
    // relay: the caller renders the status and body.
    if (res.status >= 400) {
      return { ok: true, candidate: cand, response: res, relay: null };
    }

    const relayed = await hooks.relay(cand, res);
    if (relayed.committed) return { ok: true, candidate: cand, response: res, relay: relayed };

    // Nothing reached the client, so this candidate is interchangeable with
    // the next one — but a stream that produced no data at all is a signal
    // worth demoting it for.
    cooldown.record(cand.decision.provider.id, cand.model, surface, false, nowMs);
    lastError = { status: res.status, text: relayed.error ?? "upstream returned an empty stream" };
    if (cand === last) {
      // 502, not the upstream's 200: the gateway could not obtain a usable
      // answer, and answering 200 with an error body makes agents treat a
      // failed turn as a successful (empty) one.
      return { ok: false, message: lastError.text, status: 502 };
    }
    console.log(
      `[model-gateway] stream from ${cand.decision.provider.id}/${cand.model} [${surface}] produced no data, trying next candidate`,
    );
  }

  return { ok: false, message: lastError?.text || "all providers failed", status: lastError?.status };
}
