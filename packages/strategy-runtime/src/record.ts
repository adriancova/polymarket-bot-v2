/**
 * The persisted decision record: the strategy's §7.5 `DecisionResult` plus the
 * identifiers the RUNTIME adds — "timing, run, market, event, and strategy
 * identifiers" (§7.5) — so a strategy cannot forge them (ADR-005 §2).
 *
 * Determinism split (§12.4): everything in `DecisionRecord` is a pure function
 * of (event sequence, config, seed) and must be byte-identical across replays.
 * Machine-dependent measurements (the watchdog's elapsed time) live in
 * `DecisionTelemetry`, which the store may persist alongside the record
 * (§10.3 `decisions.evaluation_duration_us` is nullable for exactly this
 * reason) but which never participates in replay comparison.
 *
 * The record deliberately carries NO decision id: `strategy.decisions`
 * assigns `decision_id` at insert (WP-040), and inventing one here would
 * either import a UUID source (nondeterministic) or invent an identifier
 * format the domain refuses to pin (`docs/contracts/domain.md` §8).
 * Exactly-one-ness is keyed on `(runId, evaluationSeq)` — the same key the
 * database enforces unique.
 */

import type { DecisionResult, InternalMarketId, IsoTimestamp } from "@polymarket-bot/domain";
import type { SourceEventRef, StrategyCallbackName } from "@polymarket-bot/strategy-sdk";

/**
 * Who decided: the strategy, or the runtime containing a failed evaluation
 * (ADR-005 §3 — a timeout "may not be attributed to the strategy as though
 * the strategy had decided to skip").
 */
export type DecisionAttribution = "STRATEGY" | "RUNTIME";

export interface DecisionRecord {
  /** §7.5 contract version of `decision` (`DECISION_RESULT_SCHEMA_VERSION`). */
  readonly decisionContractVersion: number;
  readonly runId: string;
  readonly instanceId: string;
  readonly marketId: InternalMarketId;
  /** Zero-based, contiguous per run; unique with `runId` (§10.3). */
  readonly evaluationSeq: number;
  readonly callback: StrategyCallbackName;
  readonly attribution: DecisionAttribution;
  /** The logical evaluation timestamp — the same value `ctx.now()` returned. */
  readonly evaluatedAt: IsoTimestamp;
  /** §7.1 information-arrival identity of the triggering event, when there is one. */
  readonly sourceEvent?: SourceEventRef;
  readonly decision: DecisionResult;
}

export interface DecisionTelemetry {
  /**
   * Wall-elapsed evaluation time in microseconds per the injected monotonic
   * clock, or `null` when unavailable. Machine-dependent by nature; excluded
   * from `DecisionRecord` so §12.4 byte-identity holds.
   */
  readonly evaluationDurationUs: number | null;
}
