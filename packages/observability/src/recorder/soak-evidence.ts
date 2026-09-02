/**
 * Soak-evidence records and their fail-closed evaluation (`WP-140`).
 *
 * ## The rule this module enforces
 *
 * Handoff §16.7: "Time-based operational gates cannot be faked by an agent.
 * The orchestrator must mark them PENDING_EXTERNAL_EVIDENCE until real
 * elapsed-time evidence exists." The `WP-140` acceptance criterion restates
 * it: "Time-based soak remains pending until real elapsed evidence exists."
 *
 * This module is the machinery that makes PENDING the explicit,
 * machine-visible state. The soak harness (`test/soak/recorder/`) writes one
 * evidence record per recording window; the record's duration is
 * **first-class and recomputed** — `startedAt`/`endedAt` ISO timestamps plus
 * a claimed `elapsedMs` that evaluation recomputes and cross-checks. The
 * ONLY way to a `SATISFIED` status is through `evaluateSoakEvidence`, and it
 * fails closed:
 *
 * - no records → PENDING;
 * - any record that does not parse, whose timestamps are incoherent, whose
 *   claimed elapsed disagrees with its timestamps, or whose `endedAt` lies
 *   in the future → INVALID (the whole evidence set; a tampered or broken
 *   record is a fact an operator must resolve, not skip);
 * - the longest valid window below the threshold → PENDING;
 * - SATISFIED requires one single contiguous valid window at or above the
 *   threshold during which the recorder demonstrably ran (`runningBannerSeen`),
 *   shut down cleanly when asked, and reported **zero** unexplained-gap
 *   signals — the Phase-1 operational gate is "sustained recording soak with
 *   no unexplained gaps", so a window with gap signals cannot satisfy it no
 *   matter how long it is.
 *
 * There is deliberately no way to inject a lower threshold: the threshold is
 * a reviewed constant. A run that is not long enough is PENDING, honestly.
 *
 * ## The threshold value
 *
 * Neither the handoff nor the work plan states a duration for the Phase-1
 * "sustained recording soak". 24 hours is chosen here as a conservative
 * default — it covers every venue's daily maintenance/rollover cycle and the
 * ephemeral-market series the recorder exists to capture — and is recorded
 * as an ASSUMPTION in `docs/handoffs/WP-140.md`. Changing it is a one-line,
 * reviewed edit; nothing else in the machinery moves.
 */

export const SOAK_EVIDENCE_SCHEMA_VERSION = 1;

export const SOAK_EVIDENCE_KIND = "recorder-soak-window";

/** See the module header before touching this value. */
export const SOAK_ELAPSED_EVIDENCE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/**
 * Tolerance between a record's claimed `elapsedMs` and the value recomputed
 * from its timestamps. `startedAt`/`endedAt` are wall-clock ISO strings while
 * harnesses measure elapsed monotonically, so a small skew is legitimate;
 * beyond this, the record is contradicting itself.
 */
export const SOAK_ELAPSED_TOLERANCE_MS = 5_000;

/**
 * Allowed forward skew of `endedAt` past the evaluator's `nowMs`. Evidence
 * of time that has not elapsed cannot exist; this only absorbs clock skew
 * between the machine that wrote the record and the one evaluating it.
 */
export const SOAK_FUTURE_SKEW_TOLERANCE_MS = 60_000;

export interface SoakExitEvidence {
  /** The subprocess exit code; `null` when it was killed by a signal. */
  readonly code: number | null;
  /** The killing signal name; `null` on a normal exit. */
  readonly signal: string | null;
  /** True when the recorder exited 0 after the harness's shutdown signal. */
  readonly cleanShutdown: boolean;
  /** True when the harness had to force-kill the recorder (failed to exit). */
  readonly forcedKill: boolean;
}

export interface SoakObservedEvidence {
  /** The `data-gateway running:` banner was seen — the recorder actually ran. */
  readonly runningBannerSeen: boolean;
  /** The banner carried "PUBLICATION HALTED, RECORDING ONLY". */
  readonly recordingOnly: boolean;
  /** The `data-gateway: shutting down` log was seen. */
  readonly shutdownLogSeen: boolean;
  /** The `cleanup deadline … expired` forced-exit log was seen. */
  readonly cleanupDeadlineExpired: boolean;
  /** `[disposal]` cleanup-failure lines counted. */
  readonly disposalFailures: number;
  /** `[incident]` lines counted. */
  readonly incidents: number;
  /** `[halt]` lines counted. */
  readonly halts: number;
  /** `[wal] recording failure` lines counted. */
  readonly walRecordingFailures: number;
}

export interface SoakWalEvidence {
  /** Epoch directories found under the WAL root after the window. */
  readonly epochs: number;
  /** Finalized segments (manifest sidecars) found. */
  readonly segments: number;
  /** Sum of manifest `recordCount`s. */
  readonly records: number;
  /** Sum of manifest `byteSize`s. */
  readonly bytes: number;
  /**
   * Unexplained-gap signals for the window: WAL recording failures plus any
   * frames-refused / messages-dropped evidence the harness observed. Zero is
   * required for a SATISFIED soak (Phase-1 operational gate).
   */
  readonly unexplainedGapSignals: number;
}

/**
 * One recording window, as the harness observed it. The record carries **no
 * status field**: status exists only as the output of evaluation.
 */
export interface SoakWindowEvidence {
  readonly schemaVersion: typeof SOAK_EVIDENCE_SCHEMA_VERSION;
  readonly kind: typeof SOAK_EVIDENCE_KIND;
  /** What produced the record, e.g. "test/soak/recorder/run-soak.mjs". */
  readonly harness: string;
  /** ISO-8601 wall-clock start of the window. */
  readonly startedAt: string;
  /** ISO-8601 wall-clock end of the window. */
  readonly endedAt: string;
  /** Elapsed milliseconds as the harness measured them (cross-checked). */
  readonly elapsedMs: number;
  readonly exit: SoakExitEvidence;
  readonly observed: SoakObservedEvidence;
  readonly wal: SoakWalEvidence;
  readonly notes?: string | undefined;
}

export type SoakStatus = "PENDING" | "SATISFIED" | "INVALID";

export interface SoakEvaluation {
  readonly status: SoakStatus;
  /** Longest single valid window, ms; 0 with no valid windows. */
  readonly longestWindowMs: number;
  /** Longest single window that also qualifies (clean, gap-free), ms. */
  readonly longestQualifyingWindowMs: number;
  readonly validWindows: number;
  readonly invalidRecords: number;
  readonly thresholdMs: number;
  /** Human-readable reasons for the status, in evaluation order. */
  readonly reasons: readonly string[];
}

type ParseResult =
  | { readonly ok: true; readonly record: SoakWindowEvidence }
  | { readonly ok: false; readonly reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Parse one evidence record, fail-closed: anything missing, mistyped, or
 * incoherent is a stated reason, never a default.
 */
export function parseSoakWindowEvidence(value: unknown): ParseResult {
  if (!isRecord(value)) {
    return { ok: false, reason: "evidence record is not a JSON object" };
  }
  if (value["schemaVersion"] !== SOAK_EVIDENCE_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: `unknown schemaVersion ${JSON.stringify(value["schemaVersion"])}`,
    };
  }
  if (value["kind"] !== SOAK_EVIDENCE_KIND) {
    return { ok: false, reason: `unknown kind ${JSON.stringify(value["kind"])}` };
  }
  const harness = value["harness"];
  if (typeof harness !== "string" || harness === "") {
    return { ok: false, reason: "harness must be a non-empty string" };
  }
  const startedAt = value["startedAt"];
  const endedAt = value["endedAt"];
  if (typeof startedAt !== "string" || Number.isNaN(Date.parse(startedAt))) {
    return { ok: false, reason: "startedAt is not a parseable ISO timestamp" };
  }
  if (typeof endedAt !== "string" || Number.isNaN(Date.parse(endedAt))) {
    return { ok: false, reason: "endedAt is not a parseable ISO timestamp" };
  }
  const elapsedMs = value["elapsedMs"];
  if (!isNonNegativeInteger(elapsedMs)) {
    return { ok: false, reason: "elapsedMs must be a non-negative safe integer" };
  }
  const exit = value["exit"];
  if (
    !isRecord(exit) ||
    !(exit["code"] === null || isFiniteNumber(exit["code"])) ||
    !(exit["signal"] === null || typeof exit["signal"] === "string") ||
    !isBoolean(exit["cleanShutdown"]) ||
    !isBoolean(exit["forcedKill"])
  ) {
    return { ok: false, reason: "exit evidence is malformed" };
  }
  const observed = value["observed"];
  if (
    !isRecord(observed) ||
    !isBoolean(observed["runningBannerSeen"]) ||
    !isBoolean(observed["recordingOnly"]) ||
    !isBoolean(observed["shutdownLogSeen"]) ||
    !isBoolean(observed["cleanupDeadlineExpired"]) ||
    !isNonNegativeInteger(observed["disposalFailures"]) ||
    !isNonNegativeInteger(observed["incidents"]) ||
    !isNonNegativeInteger(observed["halts"]) ||
    !isNonNegativeInteger(observed["walRecordingFailures"])
  ) {
    return { ok: false, reason: "observed evidence is malformed" };
  }
  const wal = value["wal"];
  if (
    !isRecord(wal) ||
    !isNonNegativeInteger(wal["epochs"]) ||
    !isNonNegativeInteger(wal["segments"]) ||
    !isNonNegativeInteger(wal["records"]) ||
    !isNonNegativeInteger(wal["bytes"]) ||
    !isNonNegativeInteger(wal["unexplainedGapSignals"])
  ) {
    return { ok: false, reason: "wal evidence is malformed" };
  }
  const notes = value["notes"];
  if (notes !== undefined && typeof notes !== "string") {
    return { ok: false, reason: "notes must be a string when present" };
  }
  return {
    ok: true,
    record: {
      schemaVersion: SOAK_EVIDENCE_SCHEMA_VERSION,
      kind: SOAK_EVIDENCE_KIND,
      harness,
      startedAt,
      endedAt,
      elapsedMs,
      exit: {
        code: exit["code"] as number | null,
        signal: exit["signal"] as string | null,
        cleanShutdown: exit["cleanShutdown"] as boolean,
        forcedKill: exit["forcedKill"] as boolean,
      },
      observed: {
        runningBannerSeen: observed["runningBannerSeen"] as boolean,
        recordingOnly: observed["recordingOnly"] as boolean,
        shutdownLogSeen: observed["shutdownLogSeen"] as boolean,
        cleanupDeadlineExpired: observed["cleanupDeadlineExpired"] as boolean,
        disposalFailures: observed["disposalFailures"] as number,
        incidents: observed["incidents"] as number,
        halts: observed["halts"] as number,
        walRecordingFailures: observed["walRecordingFailures"] as number,
      },
      wal: {
        epochs: wal["epochs"] as number,
        segments: wal["segments"] as number,
        records: wal["records"] as number,
        bytes: wal["bytes"] as number,
        unexplainedGapSignals: wal["unexplainedGapSignals"] as number,
      },
      ...(notes === undefined ? {} : { notes }),
    },
  };
}

/**
 * Why a valid window does not qualify toward SATISFIED, or `null` if it does.
 */
export function disqualifyingReason(record: SoakWindowEvidence): string | null {
  if (!record.observed.runningBannerSeen) {
    return "the recorder's running banner was never seen — the window shows no recording";
  }
  if (!record.exit.cleanShutdown) {
    return "the window did not end in a clean requested shutdown";
  }
  if (record.exit.forcedKill) {
    return "the harness had to force-kill the recorder";
  }
  if (record.observed.cleanupDeadlineExpired) {
    return "the cleanup deadline expired (forced exit)";
  }
  if (record.wal.unexplainedGapSignals > 0) {
    return `${String(record.wal.unexplainedGapSignals)} unexplained-gap signal(s) — a sustained soak requires zero`;
  }
  if (record.observed.walRecordingFailures > 0) {
    return `${String(record.observed.walRecordingFailures)} WAL recording failure(s)`;
  }
  if (record.wal.records === 0) {
    return "no records were written — a soak must demonstrate recording, not just liveness";
  }
  return null;
}

/**
 * Evaluate an evidence set. See the module header for the fail-closed rules.
 *
 * `nowMs` is injected (epoch milliseconds) so the future-evidence check is
 * testable; callers pass `Date.now()`.
 */
export function evaluateSoakEvidence(
  rawRecords: readonly unknown[],
  nowMs: number,
): SoakEvaluation {
  const reasons: string[] = [];
  let invalidRecords = 0;
  let validWindows = 0;
  let longestWindowMs = 0;
  let longestQualifyingWindowMs = 0;

  for (const [index, raw] of rawRecords.entries()) {
    const parsed = parseSoakWindowEvidence(raw);
    if (!parsed.ok) {
      invalidRecords += 1;
      reasons.push(`record ${String(index)}: INVALID — ${parsed.reason}`);
      continue;
    }
    const record = parsed.record;
    const startMs = Date.parse(record.startedAt);
    const endMs = Date.parse(record.endedAt);
    const recomputedElapsedMs = endMs - startMs;
    if (recomputedElapsedMs < 0) {
      invalidRecords += 1;
      reasons.push(`record ${String(index)}: INVALID — endedAt precedes startedAt`);
      continue;
    }
    if (endMs > nowMs + SOAK_FUTURE_SKEW_TOLERANCE_MS) {
      invalidRecords += 1;
      reasons.push(
        `record ${String(index)}: INVALID — endedAt is in the future; evidence of time that has not elapsed cannot exist`,
      );
      continue;
    }
    if (Math.abs(recomputedElapsedMs - record.elapsedMs) > SOAK_ELAPSED_TOLERANCE_MS) {
      invalidRecords += 1;
      reasons.push(
        `record ${String(index)}: INVALID — claimed elapsedMs ${String(record.elapsedMs)} disagrees with the timestamps (${String(recomputedElapsedMs)} ms)`,
      );
      continue;
    }
    validWindows += 1;
    // The CONSERVATIVE duration: never more than either measurement claims.
    const windowMs = Math.min(recomputedElapsedMs, record.elapsedMs);
    longestWindowMs = Math.max(longestWindowMs, windowMs);
    const disqualified = disqualifyingReason(record);
    if (disqualified === null) {
      longestQualifyingWindowMs = Math.max(longestQualifyingWindowMs, windowMs);
    } else {
      reasons.push(
        `record ${String(index)}: valid window (${String(windowMs)} ms) but not qualifying — ${disqualified}`,
      );
    }
  }

  const thresholdMs = SOAK_ELAPSED_EVIDENCE_THRESHOLD_MS;
  if (invalidRecords > 0) {
    reasons.push(
      `status INVALID: ${String(invalidRecords)} evidence record(s) failed validation; resolve them — evaluation does not skip bad evidence`,
    );
    return {
      status: "INVALID",
      longestWindowMs,
      longestQualifyingWindowMs,
      validWindows,
      invalidRecords,
      thresholdMs,
      reasons,
    };
  }
  if (longestQualifyingWindowMs >= thresholdMs) {
    reasons.push(
      `status SATISFIED: a qualifying window of ${String(longestQualifyingWindowMs)} ms meets the ${String(thresholdMs)} ms threshold`,
    );
    return {
      status: "SATISFIED",
      longestWindowMs,
      longestQualifyingWindowMs,
      validWindows,
      invalidRecords,
      thresholdMs,
      reasons,
    };
  }
  reasons.push(
    validWindows === 0
      ? "status PENDING: no evidence windows exist yet"
      : `status PENDING: longest qualifying window is ${String(longestQualifyingWindowMs)} ms of the required ${String(thresholdMs)} ms`,
  );
  return {
    status: "PENDING",
    longestWindowMs,
    longestQualifyingWindowMs,
    validWindows,
    invalidRecords,
    thresholdMs,
    reasons,
  };
}
