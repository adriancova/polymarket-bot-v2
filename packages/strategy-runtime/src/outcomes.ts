/**
 * Typed outcomes and refusals. Everything recoverable is a returned value,
 * never a throw (the order-book/WP-150 convention): the composition root
 * branches on `kind`/`code`, and a hung, throwing, or misbehaving strategy is
 * CONTAINED — the runtime never crashes and never lets §6 invariant 3 slip.
 *
 * The four kinds:
 *
 * - `DECIDED` — the callback ran within budget and returned a valid §7.5
 *   `DecisionResult`; exactly one strategy-attributed record was persisted and
 *   one checkpoint saved.
 * - `CONTAINED` — the callback threw, timed out, or returned an invalid
 *   result; exactly one RUNTIME-attributed `skip` record was persisted
 *   (ADR-005 §3), the strategy's returned value (if any) was discarded, the
 *   instance is PAUSED, and `incident` describes what to raise. The
 *   evaluation is recorded as having happened and produced no intent.
 * - `REFUSED` — the callback was NEVER invoked (paused/stopped instance,
 *   re-entrant call, invalid input), so §6 invariant 3 does not bind and NO
 *   record was persisted. A refusal is a caller error surface, not a decision.
 * - `HALTED` — a persistence port threw. The runtime made exactly one persist
 *   attempt and will not retry (an unknown-fate write must not be retried
 *   blindly — the §6 invariant 6 reasoning); the instance is PAUSED and the
 *   incident must be raised. `stage` says which port; on `SAVE_CHECKPOINT` the
 *   decision record IS durable and only the checkpoint is not.
 */

import type { StrategyStateCheckpoint } from "./checkpoint.js";
import type { DecisionRecord, DecisionTelemetry } from "./record.js";
import type { ReservedRuntimeReasonCode } from "./reserved-codes.js";

export interface IncidentReport {
  readonly code: string;
  readonly detail: string;
}

export interface ContainedFailure {
  readonly reasonCode: ReservedRuntimeReasonCode;
  readonly detail: string;
  /** The thrown value, when the failure was a throw. */
  readonly cause?: unknown;
}

export type EvaluationRefusalCode =
  | "INSTANCE_PAUSED"
  | "INSTANCE_STOPPED"
  | "EVALUATION_REENTRANT"
  | "INPUT_INVALID";

export interface EvaluationRefusal {
  readonly code: EvaluationRefusalCode;
  readonly detail: string;
}

export type EvaluationOutcome =
  | {
      readonly kind: "DECIDED";
      readonly record: DecisionRecord;
      readonly telemetry: DecisionTelemetry;
      readonly checkpoint: StrategyStateCheckpoint;
    }
  | {
      readonly kind: "CONTAINED";
      readonly record: DecisionRecord;
      readonly telemetry: DecisionTelemetry;
      readonly checkpoint: StrategyStateCheckpoint;
      readonly failure: ContainedFailure;
      readonly incident: IncidentReport;
    }
  | {
      readonly kind: "REFUSED";
      readonly refusal: EvaluationRefusal;
    }
  | {
      readonly kind: "HALTED";
      readonly stage: "PERSIST_DECISION" | "SAVE_CHECKPOINT";
      readonly record: DecisionRecord;
      readonly cause: unknown;
      readonly incident: IncidentReport;
    };

export type RuntimeCreationRefusalCode =
  | "STRATEGY_SHAPE_INVALID"
  | "PARAMS_SCHEMA_UNSUPPORTED"
  | "PARAMS_REJECTED"
  | "RUN_IDENTITY_INVALID"
  | "RUN_SEED_INVALID"
  | "WATCHDOG_BUDGET_INVALID"
  | "PORTS_INVALID"
  | "CHECKPOINT_UNKNOWN_SCHEMA_VERSION"
  | "CHECKPOINT_RUN_MISMATCH"
  | "CHECKPOINT_STRATEGY_MISMATCH"
  | "CHECKPOINT_STATE_SCHEMA_MISMATCH"
  | "CHECKPOINT_CONFIG_MISMATCH"
  | "CHECKPOINT_SEED_MISMATCH"
  | "CHECKPOINT_SEQ_INVALID"
  | "CHECKPOINT_STATUS_INVALID"
  | "CHECKPOINT_RNG_STATE_INVALID"
  | "CHECKPOINT_STATE_INVALID";

export interface RuntimeCreationRefusal {
  readonly code: RuntimeCreationRefusalCode;
  readonly detail: string;
}
