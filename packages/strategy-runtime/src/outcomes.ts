/**
 * Typed outcomes and refusals. Everything recoverable is a returned value,
 * never a throw (the order-book/WP-150 convention): the composition root
 * branches on `kind`/`code`, and a hung, throwing, or misbehaving strategy is
 * CONTAINED — the runtime never crashes and never lets §6 invariant 3 slip.
 *
 * ONE documented exception, added 2026-09-02 in remediation round 1:
 * `StrategyContextRevokedError` (below) is thrown, because the frozen §7.6
 * context methods have no return channel for a refusal. It is a caller-error
 * surface like `REFUSED`, not a decision; see the class comment.
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

/**
 * The capabilities a `StrategyContext` hands to ONE callback invocation. Every
 * one is revoked when that invocation returns or throws (see `context.ts`);
 * the name is carried on the refusal so an operator reading an incident knows
 * exactly which capability was reached for after the fact.
 */
export type StrategyContextCapability =
  | "now"
  | "market"
  | "book"
  | "features"
  | "position"
  | "orders"
  | "riskBudget"
  | "params"
  | "state"
  | "rng"
  | "rng.nextUint32"
  | "rng.nextFloat53"
  | "rng.nextIntBelow";

/** The `code` carried by every `StrategyContextRevokedError`. */
export const STRATEGY_CONTEXT_REVOKED = "STRATEGY_CONTEXT_REVOKED";

/**
 * The typed refusal for using a `StrategyContext` capability after the
 * invocation that received it has ended.
 *
 * This is the ONE place the package refuses by throwing rather than by
 * returning, and the exception is forced by the frozen §7.6 shape: `SeededRandom
 * .nextUint32(): number` has no return channel for a refusal, and every other
 * context method is likewise typed to return data. Silently returning a stale
 * or fabricated value would be the very failure this class exists to prevent —
 * a post-return `rng()` draw that advanced the live generator produced a
 * decision stream that no checkpoint could reproduce (review finding H1).
 *
 * Where the throw lands:
 * - inside a LATER callback (a strategy that stashed the old context), the
 *   runtime's own containment catches it and persists exactly one
 *   `RUNTIME.CALLBACK_THREW` skip — no new reserved reason code is needed,
 *   and the detail names the capability;
 * - outside any callback, it propagates to whoever made the out-of-band call,
 *   which is the only honest answer: no evaluation is in progress, so there is
 *   no decision record to attribute it to.
 */
export class StrategyContextRevokedError extends Error {
  readonly code: typeof STRATEGY_CONTEXT_REVOKED = STRATEGY_CONTEXT_REVOKED;
  readonly capability: StrategyContextCapability;

  constructor(capability: StrategyContextCapability) {
    super(
      `StrategyContext capability ${capability} was used after its callback returned; the ` +
        "context is invocation-scoped and was revoked (a post-return RNG draw would advance " +
        "a generator no checkpoint can reproduce — §12.4 determinism)",
    );
    this.name = "StrategyContextRevokedError";
    this.capability = capability;
  }
}

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
