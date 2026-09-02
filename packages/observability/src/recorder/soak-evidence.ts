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
 * ## The trust domain, stated plainly (remediation round 1)
 *
 * The harness (`test/soak/recorder/`) and this evaluator share a FILESYSTEM
 * TRUST DOMAIN: evidence records are unauthenticated JSON files, and anything
 * that can write the evidence directory can write a record. Therefore this
 * evaluator enforces INTERNAL CONSISTENCY and STRUCTURAL QUALIFICATION —
 * never provenance. A hand-written but internally consistent record is
 * indistinguishable from a real one HERE, by construction, and the verdict
 * lattice is designed around that fact:
 *
 * - `INVALID` — some record is malformed, carries an unknown key, or
 *   contradicts itself (poisons the whole set; bad evidence is resolved,
 *   never skipped);
 * - `PENDING` — no structurally qualifying window at or above the threshold
 *   exists yet;
 * - `QUALIFYING_WINDOW_FOUND` — the TERMINAL BEST state: one contiguous,
 *   internally consistent window at or above the threshold, in which the
 *   recorder demonstrably recorded, shut down cleanly on request (derived
 *   from primitives, below), and reported zero unexplained-gap signals.
 *
 * `QUALIFYING_WINDOW_FOUND` is a CANDIDATE, not completion. No output of
 * this module — status string, artifact, metric label — is named or
 * presentable as final external-evidence satisfaction. Closing the gate is a
 * GOVERNANCE ACT: the operator/orchestrator reviews the candidate window's
 * provenance out of band (who started the run, the run log, the WAL on disk)
 * and records completion in `IMPLEMENTATION_STATUS.md`. The evaluator's
 * candidate state is the INPUT to that human step, never the step itself.
 *
 * ## Primitives only — no derived claims in the schema
 *
 * Records carry PRIMITIVE observations exclusively (exit code/signal, which
 * signals the harness sent, which log lines it saw, what the WAL scan
 * found). Derived facts — "was the shutdown clean", "how many
 * unexplained-gap signals" — are computed HERE from those primitives
 * (`derivedCleanShutdown`, `derivedUnexplainedGapSignals`), so there is no
 * free-standing boolean a forged record can set to a value its own
 * primitives contradict. Schema v1 carried two such derived fields
 * (`exit.cleanShutdown`, `wal.unexplainedGapSignals`) and validated shape
 * only; v2 removes them, rejects unknown keys at every level (a smuggled
 * `status` key poisons the set), and cross-checks the consistency relations
 * between the primitives that remain.
 *
 * Parsing fails closed:
 *
 * - no records → PENDING;
 * - any record that does not parse, carries an unknown key anywhere, whose
 *   timestamps are incoherent, whose claimed elapsed disagrees with its
 *   timestamps, whose `endedAt` lies in the future, or whose primitive facts
 *   contradict each other → INVALID for the whole set;
 * - the longest valid window below the threshold → PENDING.
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

/**
 * v2: derived fields removed from the schema (primitives only), exact-key
 * validation, consistency relations. v1 records are refused (no real
 * evidence exists; the evidence directory is runtime output, never a commit).
 */
export const SOAK_EVIDENCE_SCHEMA_VERSION = 2;

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

/**
 * Exit facts, primitives only. "Was the shutdown clean" is NOT recorded —
 * it is derived by `derivedCleanShutdown` from these plus the observed log
 * lines, so a record cannot claim a cleanliness its own facts contradict.
 */
export interface SoakExitEvidence {
  /** The subprocess exit code; `null` when it was killed by a signal. */
  readonly code: number | null;
  /** The killing signal name; `null` on a normal exit. */
  readonly signal: string | null;
  /** True when the harness requested shutdown (SIGTERM) after the full window. */
  readonly shutdownRequested: boolean;
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
  /** Of the `[incident]` lines, those whose reason code contains `GAP`. */
  readonly gapIncidents: number;
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
}

/**
 * One recording window, as the harness observed it. The record carries **no
 * status field and no derived fields** — primitives only; unknown keys at
 * any level are refused (exact-key schema). Status exists only as the
 * output of evaluation, and its best value is a candidate state.
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

/**
 * The verdict lattice. `QUALIFYING_WINDOW_FOUND` is the terminal BEST state
 * and is a candidate for out-of-band provenance review — no status value
 * names or implies final external-evidence satisfaction, so no
 * repository-controlled input can produce one that does.
 */
export type SoakStatus = "PENDING" | "QUALIFYING_WINDOW_FOUND" | "INVALID";

export interface SoakEvaluation {
  readonly status: SoakStatus;
  /** Longest single valid window, ms; 0 with no valid windows. */
  readonly longestWindowMs: number;
  /** Longest single window that also structurally qualifies, ms. */
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

const TOP_LEVEL_KEYS = [
  "schemaVersion",
  "kind",
  "harness",
  "startedAt",
  "endedAt",
  "elapsedMs",
  "exit",
  "observed",
  "wal",
  "notes",
] as const;

const EXIT_KEYS = ["code", "signal", "shutdownRequested", "forcedKill"] as const;

const OBSERVED_KEYS = [
  "runningBannerSeen",
  "recordingOnly",
  "shutdownLogSeen",
  "cleanupDeadlineExpired",
  "disposalFailures",
  "incidents",
  "gapIncidents",
  "halts",
  "walRecordingFailures",
] as const;

const WAL_KEYS = ["epochs", "segments", "records", "bytes"] as const;

/**
 * Exact-key check: the first key not in `allowed`, or `null`. A smuggled key
 * — `status` above all — poisons the record; evidence carries exactly the
 * declared primitives and nothing else.
 */
function unknownKey(
  value: Record<string, unknown>,
  allowed: readonly string[],
): string | null {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      return key;
    }
  }
  return null;
}

/**
 * Parse one evidence record, fail-closed: anything missing, mistyped,
 * unknown-keyed, or self-contradictory is a stated reason, never a default.
 */
export function parseSoakWindowEvidence(value: unknown): ParseResult {
  if (!isRecord(value)) {
    return { ok: false, reason: "evidence record is not a JSON object" };
  }
  const topExtra = unknownKey(value, TOP_LEVEL_KEYS);
  if (topExtra !== null) {
    return {
      ok: false,
      reason: `unknown key ${JSON.stringify(topExtra)} at the top level — evidence records carry exactly the declared primitive fields (no status, no derived claims)`,
    };
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
  if (!isRecord(exit)) {
    return { ok: false, reason: "exit evidence is malformed" };
  }
  const exitExtra = unknownKey(exit, EXIT_KEYS);
  if (exitExtra !== null) {
    return {
      ok: false,
      reason: `unknown key ${JSON.stringify(exitExtra)} in exit — exit facts are primitives only (cleanliness is derived at evaluation, never recorded)`,
    };
  }
  if (
    !(exit["code"] === null || isFiniteNumber(exit["code"])) ||
    !(exit["signal"] === null || typeof exit["signal"] === "string") ||
    !isBoolean(exit["shutdownRequested"]) ||
    !isBoolean(exit["forcedKill"])
  ) {
    return { ok: false, reason: "exit evidence is malformed" };
  }
  const observed = value["observed"];
  if (!isRecord(observed)) {
    return { ok: false, reason: "observed evidence is malformed" };
  }
  const observedExtra = unknownKey(observed, OBSERVED_KEYS);
  if (observedExtra !== null) {
    return {
      ok: false,
      reason: `unknown key ${JSON.stringify(observedExtra)} in observed — exact-key schema`,
    };
  }
  if (
    !isBoolean(observed["runningBannerSeen"]) ||
    !isBoolean(observed["recordingOnly"]) ||
    !isBoolean(observed["shutdownLogSeen"]) ||
    !isBoolean(observed["cleanupDeadlineExpired"]) ||
    !isNonNegativeInteger(observed["disposalFailures"]) ||
    !isNonNegativeInteger(observed["incidents"]) ||
    !isNonNegativeInteger(observed["gapIncidents"]) ||
    !isNonNegativeInteger(observed["halts"]) ||
    !isNonNegativeInteger(observed["walRecordingFailures"])
  ) {
    return { ok: false, reason: "observed evidence is malformed" };
  }
  const wal = value["wal"];
  if (!isRecord(wal)) {
    return { ok: false, reason: "wal evidence is malformed" };
  }
  const walExtra = unknownKey(wal, WAL_KEYS);
  if (walExtra !== null) {
    return {
      ok: false,
      reason: `unknown key ${JSON.stringify(walExtra)} in wal — exact-key schema (gap signals are derived from observed primitives, never recorded)`,
    };
  }
  if (
    !isNonNegativeInteger(wal["epochs"]) ||
    !isNonNegativeInteger(wal["segments"]) ||
    !isNonNegativeInteger(wal["records"]) ||
    !isNonNegativeInteger(wal["bytes"])
  ) {
    return { ok: false, reason: "wal evidence is malformed" };
  }
  const notes = value["notes"];
  if (notes !== undefined && typeof notes !== "string") {
    return { ok: false, reason: "notes must be a string when present" };
  }

  const record: SoakWindowEvidence = {
    schemaVersion: SOAK_EVIDENCE_SCHEMA_VERSION,
    kind: SOAK_EVIDENCE_KIND,
    harness,
    startedAt,
    endedAt,
    elapsedMs,
    exit: {
      code: exit["code"] as number | null,
      signal: exit["signal"] as string | null,
      shutdownRequested: exit["shutdownRequested"] as boolean,
      forcedKill: exit["forcedKill"] as boolean,
    },
    observed: {
      runningBannerSeen: observed["runningBannerSeen"] as boolean,
      recordingOnly: observed["recordingOnly"] as boolean,
      shutdownLogSeen: observed["shutdownLogSeen"] as boolean,
      cleanupDeadlineExpired: observed["cleanupDeadlineExpired"] as boolean,
      disposalFailures: observed["disposalFailures"] as number,
      incidents: observed["incidents"] as number,
      gapIncidents: observed["gapIncidents"] as number,
      halts: observed["halts"] as number,
      walRecordingFailures: observed["walRecordingFailures"] as number,
    },
    wal: {
      epochs: wal["epochs"] as number,
      segments: wal["segments"] as number,
      records: wal["records"] as number,
      bytes: wal["bytes"] as number,
    },
    ...(notes === undefined ? {} : { notes }),
  };

  const contradiction = consistencyViolation(record);
  if (contradiction !== null) {
    return { ok: false, reason: `facts contradict: ${contradiction}` };
  }
  return { ok: true, record };
}

/**
 * Consistency relations between the recorded primitives. A violated relation
 * is a contradiction; a contradictory record poisons the set to INVALID.
 * Every relation here is a strict invariant of the harness/process contract
 * — a real record cannot violate one.
 */
export function consistencyViolation(record: SoakWindowEvidence): string | null {
  const { exit, observed, wal } = record;
  if ((exit.code === null) === (exit.signal === null)) {
    return "exactly one of exit.code / exit.signal must be null — a process exits with a code or by a signal, never both or neither";
  }
  if (exit.forcedKill && !exit.shutdownRequested) {
    return "forcedKill without shutdownRequested — the harness only force-kills after a requested shutdown timed out";
  }
  if (observed.recordingOnly && !observed.runningBannerSeen) {
    return "recordingOnly without runningBannerSeen — the recording-only marker is a suffix of the running banner";
  }
  if (observed.gapIncidents > observed.incidents) {
    return "gapIncidents exceeds incidents — every gap incident is an incident";
  }
  if (observed.cleanupDeadlineExpired && exit.code === 0) {
    return "cleanupDeadlineExpired with exit code 0 — the cleanup-deadline force-exit is nonzero by contract (WP-120)";
  }
  if (wal.records > 0 && wal.segments === 0) {
    return "wal.records > 0 with zero segments — records are summed from segment manifests";
  }
  if (wal.bytes > 0 && wal.segments === 0) {
    return "wal.bytes > 0 with zero segments — bytes are summed from segment manifests";
  }
  if (wal.segments > 0 && wal.epochs === 0) {
    return "wal.segments > 0 with zero epochs — segments live inside epoch directories";
  }
  return null;
}

/**
 * Was the shutdown clean? DERIVED, never recorded: the harness requested it,
 * did not have to force-kill, the process exited 0 without a signal, the
 * shutdown log was seen, and no cleanup deadline expired.
 */
export function derivedCleanShutdown(record: SoakWindowEvidence): boolean {
  return (
    record.exit.shutdownRequested &&
    !record.exit.forcedKill &&
    record.exit.code === 0 &&
    record.exit.signal === null &&
    record.observed.shutdownLogSeen &&
    !record.observed.cleanupDeadlineExpired
  );
}

/**
 * Unexplained-gap signals for the window: WAL recording failures plus
 * GAP-reason incidents. DERIVED from observed primitives, never recorded.
 * Zero is required for a window to qualify (Phase-1 operational gate:
 * "sustained recording soak with no unexplained gaps") — the conservative
 * reading: even a venue-side gap disqualifies until an operator reviews it.
 */
export function derivedUnexplainedGapSignals(record: SoakWindowEvidence): number {
  return record.observed.walRecordingFailures + record.observed.gapIncidents;
}

/**
 * Why a valid window does not structurally qualify, or `null` if it does.
 * Qualification feeds `QUALIFYING_WINDOW_FOUND` — a candidate state; see the
 * module header for what qualification does NOT establish (provenance).
 */
export function disqualifyingReason(record: SoakWindowEvidence): string | null {
  if (!record.observed.runningBannerSeen) {
    return "the recorder's running banner was never seen — the window shows no recording";
  }
  if (record.exit.forcedKill) {
    return "the harness had to force-kill the recorder";
  }
  if (record.observed.cleanupDeadlineExpired) {
    return "the cleanup deadline expired (forced exit)";
  }
  if (!derivedCleanShutdown(record)) {
    return "the window did not end in a clean requested shutdown (derived from the exit and log primitives)";
  }
  if (record.observed.walRecordingFailures > 0) {
    return `${String(record.observed.walRecordingFailures)} WAL recording failure(s)`;
  }
  const gapSignals = derivedUnexplainedGapSignals(record);
  if (gapSignals > 0) {
    return `${String(gapSignals)} unexplained-gap signal(s) — a sustained soak requires zero`;
  }
  if (record.wal.records === 0) {
    return "no records were written — a soak must demonstrate recording, not just liveness";
  }
  return null;
}

/**
 * Evaluate an evidence set. See the module header for the fail-closed rules
 * and for what the best status does — and does not — mean.
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
      `status QUALIFYING_WINDOW_FOUND: a structurally qualifying window of ${String(longestQualifyingWindowMs)} ms meets the ${String(thresholdMs)} ms threshold — a CANDIDATE for out-of-band provenance review, not completion; the evaluator cannot verify provenance (shared filesystem trust domain), and the external-evidence gate closes only by a governance record in IMPLEMENTATION_STATUS.md`,
    );
    return {
      status: "QUALIFYING_WINDOW_FOUND",
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
