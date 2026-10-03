/**
 * Matching-engine mode detection (WP-310 deliverable 3; handoff §9.12 "Detect
 * matching-engine restart, cancel-only, and post-only modes"; WP-270 decision
 * 7: "Venue mode is a caller-supplied snapshot. WP-310 owns detection,
 * backoff and `Retry-After`").
 *
 * ## What it reads, and what it never reads
 *
 * Conditions come from the venue port's CLASSIFIED answers (WP-260's error
 * kind and `retryAfterSeconds`, as the OMS reads them in `outcomes.ts`), so a
 * mode is keyed on the HTTP status and the documented code alone: never on
 * the venue's `error` text (E-05, C-9: three official strings for one
 * condition). See `signals.ts`.
 *
 * | Answer | Condition | Effect here |
 * | --- | --- | --- |
 * | 425 (`ENGINE_RESTARTING`) on a placement or a cancel | RESTARTING | no placement until `Retry-After` has passed EXACTLY, or, without one, the snapshot's bounded exponential backoff; then POST_ONLY, with no end, until the engine is seen back (below) |
 * | 503 `post_only_mode` (`POST_ONLY_MODE`), or a batch entry rejected with it | POST_ONLY | only post-only orders until `Retry-After` / `retry_after_seconds`, or, without one, `postOnlyWindowMs` |
 * | 503 without a documented code (`TRADING_UNAVAILABLE`) | TRADING_UNAVAILABLE | no placement for the snapshot's pause (bounded exponential over consecutive pauses); a `Retry-After` is not documented for it and is not interpreted |
 * | a placement the venue answered (accepted, or rejected for another reason) | — | ends the consecutive pause run; see "The engine's return" for the restart |
 * | a cancel the venue answered | — | records that cancels worked; see "The engine's return" |
 * | anything else (nothing sent, a 429, a timeout, a transport failure, …) | — | nothing: "Retry only restart rejections" (E-07). A 429 is the rate-limit budget's (`polymarket-secure/src/rate-limit`) |
 *
 * A fallback backoff (one the venue gave no delay for) escalates only on a
 * rejection observed after the previous one has run out: an answer to a
 * request sent earlier (or another entry of the same batch) that arrives
 * while it runs neither extends nor escalates it. A delay the venue does
 * give is always honoured as given (and never shortens a running wait).
 *
 * ## The engine's return, and the post-only window after it
 *
 * After a restart the engine "enters post-only mode for two minutes"
 * (`POST_ONLY_WINDOW`), but no answer says WHEN it returned: the end of the
 * local backoff is only when a resend may be TRIED. So after a 425, once
 * the backoff has passed, the mode is POST_ONLY with no end (the engine may
 * still be restarting, or in its post-only window) until the engine is seen
 * back: an answer (a placement the venue answered, a post-only refusal, a
 * completed cancel) to a request SENT after the last 425 was observed. That
 * request was processed after the restart rejection, by a running engine, so
 * the engine returned before the answer arrived, and its two-minute window
 * ends at most `postOnlyWindowMs` after it: POST_ONLY holds until then (a
 * post-only refusal's own `Retry-After`, when it gives one). An answer to a
 * request sent before the last 425 proves nothing about the engine now and
 * is not counted, nor is an answer without a known send instant. Until the
 * engine is seen back a non-post-only order is never cleared, however long
 * that takes; a post-only order, and any cancel, may probe it.
 *
 * ## The OMS's mode
 *
 * The OMS consumes three modes (`VenueMode`). RESTARTING and
 * TRADING_UNAVAILABLE both read as `TRADING_UNAVAILABLE` there ("the venue
 * mode admits no placement"); POST_ONLY as `POST_ONLY`. The OMS never gates
 * a cancel on the mode, and neither does this detector: cancels "work even in
 * cancel-only mode", and after an unclassified 503 "a cancel attempt is the
 * only evidence" (E-05) — {@link VenueModeDetector.cancelGate} always allows
 * it and only records what the last cancel showed.
 *
 * ## No blind retry
 *
 * A non-post-only order is never cleared for placement or retransmission
 * while POST_ONLY holds, and a retransmission of the same signed order is
 * cleared only for the restart path (`ENGINE_RESTARTING`) and only after the
 * backoff (WP-270 decision 2 adds the authoritative, quiescent ABSENT that
 * the OMS itself requires). A restart always ends in POST_ONLY, held until
 * the engine is seen back and its window has passed, before NORMAL: the
 * same non-post-only order is never resent into the venue's post-only
 * window. Any other rejection (a closed-only 400, D-24; a 429; a 503) never
 * clears a resend (`RESTRICTED_MODE_FACTS.CLOSED_ONLY_NO_RESUBMIT`).
 *
 * Layer 1: no clock. Every method takes `atMs` (Unix epoch milliseconds)
 * from the caller; `venueModeSource` binds an injected clock for the OMS.
 */

import type { VenueMode } from "../ports.js";

import { parseRestrictedModeConfiguration, RestrictedModeTimeline, type ModeBackoffPolicy, type RestrictedModeConfiguration } from "./configuration.js";
import { readCondition, type VenueCondition, type VenueOperation } from "./signals.js";

/** Unit: milliseconds per second. */
export const MS_PER_SECOND = 1000;

export type RestrictedVenueMode = "NORMAL" | "RESTARTING" | "POST_ONLY" | "TRADING_UNAVAILABLE";

export type CancelsEvidence =
  /** No cancel answer has been seen since the detector started. */
  | { readonly observation: "UNTESTED"; readonly atMs: null }
  /** The last cancel the venue answered completed. */
  | { readonly observation: "WORKED"; readonly atMs: number }
  /** The last cancel was answered with a 503 without a documented code. */
  | { readonly observation: "FAILED"; readonly atMs: number };

export interface VenueModeSnapshot {
  readonly atMs: number;
  readonly mode: RestrictedVenueMode;
  /** What the OMS's `venueMode` dependency should return. */
  readonly omsMode: VenueMode;
  readonly restartingUntilMs: number | null;
  readonly tradingUnavailableUntilMs: number | null;
  readonly postOnlyUntilMs: number | null;
  /** A 425 was seen and no answer to a request sent after it has shown the engine back: POST_ONLY, with no end, once the restart wait has passed. */
  readonly engineReturnPending: boolean;
  /** The latest instant a 425 was observed, or `null`. */
  readonly lastRestartObservedMs: number | null;
  readonly consecutiveRestartFallbacks: number;
  readonly consecutiveUnavailablePauses: number;
  readonly cancelsEvidence: CancelsEvidence;
  /** The snapshot in effect, or `null` (then the mode is TRADING_UNAVAILABLE: fail closed). */
  readonly configurationId: string | null;
}

export type GateRefusalReason =
  | "INVALID_INPUT"
  | "NO_ACTIVE_CONFIGURATION"
  | "RESTARTING"
  | "TRADING_UNAVAILABLE"
  /** POST_ONLY holds and the order is not post-only: "Do not retry the same non-post-only order unchanged." */
  | "POST_ONLY_MODE_REQUIRES_POST_ONLY"
  /** Only a restart rejection is retried with the same signed order ("Retry only restart rejections"). */
  | "RETRY_ONLY_RESTART";

export type Gate =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: GateRefusalReason; readonly retryAtMs: number | null };

export type ObservationFlag =
  /** `Retry-After` arrived with a condition the venue documents none for (an unclassified 503): not interpreted. */
  | "RETRY_AFTER_NOT_DOCUMENTED_FOR_CONDITION"
  /** A post-only refusal of a cancel: undocumented (cancels are allowed in post-only mode); not interpreted. */
  | "POST_ONLY_ON_CANCEL_NOT_DOCUMENTED";

export type ObservationResult =
  | {
      readonly ok: true;
      readonly condition: VenueCondition["kind"];
      readonly before: RestrictedVenueMode;
      readonly after: RestrictedVenueMode;
      readonly flags: readonly ObservationFlag[];
    }
  | { readonly ok: false; readonly reason: "INVALID_INPUT" | "NO_ACTIVE_CONFIGURATION" | "INVALID_CONFIGURATION" | "EFFECTIVE_TIME_NOT_IN_FUTURE"; readonly message: string };

function isEpochMs(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** `initialMs × multiplier^count`, capped. */
function backoffDelay(policy: ModeBackoffPolicy, count: number): number {
  let delay = policy.initialMs;
  for (let step = 0; step < count && delay < policy.capMs; step += 1) delay *= policy.multiplier;
  return Math.min(delay, policy.capMs);
}

const ALLOWED: Gate = Object.freeze({ allowed: true as const });

function blocked(reason: GateRefusalReason, retryAtMs: number | null): Gate {
  return Object.freeze({ allowed: false as const, reason, retryAtMs });
}

export class VenueModeDetector {
  #timeline: RestrictedModeTimeline;
  #restartUntilMs = 0;
  #unavailableUntilMs = 0;
  #postOnlyUntilMs = 0;
  #lastRestartObservedMs: number | null = null;
  #engineReturnPending = false;
  #restartFallbacks = 0;
  #unavailablePauses = 0;
  #latestObservationMs = 0;
  #cancels: CancelsEvidence = Object.freeze({ observation: "UNTESTED" as const, atMs: null });

  private constructor(timeline: RestrictedModeTimeline) {
    this.#timeline = timeline;
  }

  /** A detector over one or more snapshot documents. */
  static create(
    configurations: readonly unknown[],
  ): { readonly ok: true; readonly value: VenueModeDetector } | { readonly ok: false; readonly problems: readonly string[] } {
    let timeline = RestrictedModeTimeline.empty();
    const documents = Array.isArray(configurations) ? configurations : [];
    if (documents.length === 0) return Object.freeze({ ok: false as const, problems: Object.freeze(["at least one configuration snapshot is required"]) });
    for (const raw of documents) {
      const parsed = parseRestrictedModeConfiguration(raw);
      if (!parsed.ok) return Object.freeze({ ok: false as const, problems: parsed.problems });
      const next = timeline.with(parsed.value);
      if (!next.ok) return Object.freeze({ ok: false as const, problems: Object.freeze([next.problem]) });
      timeline = next.value;
    }
    return Object.freeze({ ok: true as const, value: new VenueModeDetector(timeline) });
  }

  /** Add a snapshot that takes effect after every instant already observed. */
  addConfiguration(raw: unknown): ObservationResult | { readonly ok: true; readonly snapshotId: string } {
    const parsed = parseRestrictedModeConfiguration(raw);
    if (!parsed.ok) return Object.freeze({ ok: false as const, reason: "INVALID_CONFIGURATION" as const, message: parsed.problems.join("; ") });
    if (parsed.value.effectiveFromMs <= this.#latestObservationMs) {
      return Object.freeze({ ok: false as const, reason: "EFFECTIVE_TIME_NOT_IN_FUTURE" as const, message: "a new snapshot must take effect after every observed instant" });
    }
    const next = this.#timeline.with(parsed.value);
    if (!next.ok) return Object.freeze({ ok: false as const, reason: "INVALID_CONFIGURATION" as const, message: next.problem });
    this.#timeline = next.value;
    return Object.freeze({ ok: true as const, snapshotId: parsed.value.snapshotId });
  }

  configurationAt(atMs: number): RestrictedModeConfiguration | undefined {
    return isEpochMs(atMs) ? this.#timeline.activeAt(atMs) : undefined;
  }

  /**
   * Record one classified venue answer (see `signals.ts` for the adapters
   * from the OMS's placement classes and the venue port's cancel outcomes).
   */
  observe(signal: { readonly operation: VenueOperation; readonly condition: VenueCondition; readonly sentAtMs?: number }, atMs: number): ObservationResult {
    if (!isEpochMs(atMs)) return Object.freeze({ ok: false as const, reason: "INVALID_INPUT" as const, message: "atMs must be a non-negative safe integer" });
    const read = readCondition(signal);
    if (read === undefined) return Object.freeze({ ok: false as const, reason: "INVALID_INPUT" as const, message: "not a { operation, condition } signal" });
    const config = this.#timeline.activeAt(atMs);
    if (config === undefined) {
      return Object.freeze({ ok: false as const, reason: "NO_ACTIVE_CONFIGURATION" as const, message: "no restricted-mode snapshot is in effect at this instant" });
    }
    if (read.sentAtMs !== null && read.sentAtMs > atMs) {
      return Object.freeze({ ok: false as const, reason: "INVALID_INPUT" as const, message: "a request cannot be sent after its answer was observed" });
    }
    const before = this.#modeAt(atMs);
    if (atMs > this.#latestObservationMs) this.#latestObservationMs = atMs;
    const flags: ObservationFlag[] = [];
    const { operation, condition } = read;
    // Was this request sent after the last restart rejection was observed? Only then can its answer show the engine back.
    const sentAfterRestart = read.sentAtMs !== null && this.#lastRestartObservedMs !== null && read.sentAtMs > this.#lastRestartObservedMs;
    switch (condition.kind) {
      case "RESTARTING": {
        // E-06: "Honor `Retry-After` when the response includes it; otherwise, apply bounded exponential backoff".
        // A rejection that arrives while a backoff is still running (a request sent before it began, another
        // entry of the same batch) is not a new failed attempt: it does not escalate the backoff.
        let until: number;
        if (condition.retryAfterSeconds !== null) {
          until = atMs + condition.retryAfterSeconds * MS_PER_SECOND;
        } else if (atMs < this.#restartUntilMs) {
          until = this.#restartUntilMs;
        } else {
          until = atMs + backoffDelay(config.restartBackoff, this.#restartFallbacks);
          this.#restartFallbacks += 1;
        }
        this.#restartUntilMs = Math.max(this.#restartUntilMs, until);
        // The engine is down now; when it returns, it "enters post-only mode for two minutes". That instant is
        // unknown until an answer shows it back, so POST_ONLY has no end until then.
        this.#lastRestartObservedMs = this.#lastRestartObservedMs === null ? atMs : Math.max(this.#lastRestartObservedMs, atMs);
        this.#engineReturnPending = true;
        break;
      }
      case "POST_ONLY": {
        if (operation === "CANCEL") {
          flags.push("POST_ONLY_ON_CANCEL_NOT_DOCUMENTED");
          break;
        }
        const until = condition.retryAfterSeconds === null ? atMs + config.postOnlyWindowMs : atMs + condition.retryAfterSeconds * MS_PER_SECOND;
        this.#postOnlyUntilMs = Math.max(this.#postOnlyUntilMs, until);
        // A post-only refusal of a request sent after the last 425 is the running engine's own answer.
        if (this.#engineReturnPending && sentAfterRestart) this.#engineSeenBack();
        break;
      }
      case "TRADING_UNAVAILABLE": {
        // E-05: "Pause new submissions". No duration is documented: the snapshot's pause, growing while it repeats.
        if (condition.retryAfterSeconds !== null) flags.push("RETRY_AFTER_NOT_DOCUMENTED_FOR_CONDITION");
        if (atMs >= this.#unavailableUntilMs) {
          this.#unavailableUntilMs = atMs + backoffDelay(config.tradingUnavailableBackoff, this.#unavailablePauses);
          this.#unavailablePauses += 1;
        }
        if (operation === "CANCEL") this.#cancels = Object.freeze({ observation: "FAILED" as const, atMs });
        break;
      }
      case "ANSWERED": {
        if (this.#engineReturnPending) {
          // Only an answer to a request sent after the last 425 shows the engine back; its post-only window
          // began before this answer arrived, so it ends at most `postOnlyWindowMs` from now.
          if (sentAfterRestart) {
            this.#engineSeenBack();
            this.#postOnlyUntilMs = Math.max(this.#postOnlyUntilMs, atMs + config.postOnlyWindowMs);
          }
        } else {
          this.#restartFallbacks = 0;
        }
        if (operation === "PLACEMENT") this.#unavailablePauses = 0;
        else this.#cancels = Object.freeze({ observation: "WORKED" as const, atMs });
        break;
      }
      case "NONE":
        break;
    }
    return Object.freeze({ ok: true as const, condition: condition.kind, before, after: this.#modeAt(atMs), flags: Object.freeze(flags) });
  }

  /** The mode at `atMs`, with its deadlines. */
  snapshot(atMs: number): VenueModeSnapshot {
    const t = isEpochMs(atMs) ? atMs : 0;
    const mode = isEpochMs(atMs) ? this.#modeAt(t) : "TRADING_UNAVAILABLE";
    const pending = (until: number): number | null => (until > t ? until : null);
    return Object.freeze({
      atMs: t,
      mode,
      omsMode: toOmsMode(mode),
      restartingUntilMs: pending(this.#restartUntilMs),
      tradingUnavailableUntilMs: pending(this.#unavailableUntilMs),
      postOnlyUntilMs: pending(this.#postOnlyUntilMs),
      engineReturnPending: this.#engineReturnPending,
      lastRestartObservedMs: this.#lastRestartObservedMs,
      consecutiveRestartFallbacks: this.#restartFallbacks,
      consecutiveUnavailablePauses: this.#unavailablePauses,
      cancelsEvidence: this.#cancels,
      configurationId: this.#timeline.activeAt(t)?.snapshotId ?? null,
    });
  }

  /** The OMS's `VenueMode` at `atMs`. Fails closed (`TRADING_UNAVAILABLE`) on a bad instant or no snapshot. */
  omsVenueMode(atMs: number): VenueMode {
    return isEpochMs(atMs) ? toOmsMode(this.#modeAt(atMs)) : "TRADING_UNAVAILABLE";
  }

  /** May an order with this post-only flag be placed now? */
  placementGate(order: { readonly postOnly: boolean }, atMs: number): Gate {
    if (!isEpochMs(atMs) || order === null || typeof order !== "object") return blocked("INVALID_INPUT", null);
    const postOnly = Object.getOwnPropertyDescriptor(order, "postOnly");
    if (postOnly === undefined || !("value" in postOnly) || typeof postOnly.value !== "boolean") return blocked("INVALID_INPUT", null);
    if (this.#timeline.activeAt(atMs) === undefined) return blocked("NO_ACTIVE_CONFIGURATION", null);
    const mode = this.#modeAt(atMs);
    if (mode === "RESTARTING") return blocked("RESTARTING", this.#restartUntilMs);
    if (mode === "TRADING_UNAVAILABLE") return blocked("TRADING_UNAVAILABLE", this.#unavailableUntilMs);
    if (mode === "POST_ONLY" && !postOnly.value) {
      // While the engine's return is unseen, no instant is known at which a non-post-only order may go.
      return blocked("POST_ONLY_MODE_REQUIRES_POST_ONLY", this.#engineReturnPending ? null : this.#postOnlyUntilMs);
    }
    return ALLOWED;
  }

  /**
   * May the SAME signed order be sent again now? Only on the restart path
   * (its last transmission ended `ENGINE_RESTARTING`), only once the backoff
   * has passed, and, while POST_ONLY holds, only for a post-only order. The
   * OMS additionally requires an authoritative, quiescent ABSENT (WP-270
   * decision 2).
   */
  retransmissionGate(attempt: { readonly errorKind: string | null; readonly postOnly: boolean }, atMs: number): Gate {
    if (attempt === null || typeof attempt !== "object") return blocked("INVALID_INPUT", null);
    const errorKind = Object.getOwnPropertyDescriptor(attempt, "errorKind");
    if (errorKind === undefined || !("value" in errorKind)) return blocked("INVALID_INPUT", null);
    if (errorKind.value !== "ENGINE_RESTARTING") return blocked("RETRY_ONLY_RESTART", null);
    return this.placementGate(attempt, atMs);
  }

  /** A cancel is always allowed to be attempted; the evidence of the last one is reported with it. */
  cancelGate(): { readonly allowed: true; readonly cancelsEvidence: CancelsEvidence } {
    return Object.freeze({ allowed: true as const, cancelsEvidence: this.#cancels });
  }

  /** An answer to a request sent after the last 425 showed the engine running: the restart episode is over. */
  #engineSeenBack(): void {
    this.#engineReturnPending = false;
    this.#restartFallbacks = 0;
  }

  #modeAt(atMs: number): RestrictedVenueMode {
    if (this.#timeline.activeAt(atMs) === undefined) return "TRADING_UNAVAILABLE";
    if (atMs < this.#restartUntilMs) return "RESTARTING";
    if (atMs < this.#unavailableUntilMs) return "TRADING_UNAVAILABLE";
    if (this.#engineReturnPending) return "POST_ONLY";
    if (atMs < this.#postOnlyUntilMs) return "POST_ONLY";
    return "NORMAL";
  }
}

/** RESTARTING and TRADING_UNAVAILABLE both admit no placement in the OMS. */
export function toOmsMode(mode: RestrictedVenueMode): VenueMode {
  switch (mode) {
    case "NORMAL":
      return "NORMAL";
    case "POST_ONLY":
      return "POST_ONLY";
    default:
      return "TRADING_UNAVAILABLE";
  }
}
