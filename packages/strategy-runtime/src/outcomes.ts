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
 *   `DecisionResult`; exactly one strategy-attributed record was persisted,
 *   and one checkpoint saved when ADR-027 Decision 1 says the decision owes
 *   one (`checkpointTransitions` non-empty; `CKPT-1`) — otherwise
 *   `checkpoint` is `null`. Until `CKPT-1` every decision saved one.
 * - `CONTAINED` — the callback threw, timed out, or returned an invalid
 *   result; exactly one RUNTIME-attributed `skip` record was persisted
 *   (ADR-005 §3), the strategy's returned value (if any) was discarded, the
 *   instance is PAUSED, and `incident` describes what to raise. The
 *   evaluation is recorded as having happened and produced no intent. The
 *   pause is a STATUS transition, so a contained evaluation always saves its
 *   checkpoint.
 * - `REFUSED` — the callback was NEVER invoked (paused/stopped instance,
 *   re-entrant call, invalid input), so §6 invariant 3 does not bind and NO
 *   record was persisted. A refusal is a caller error surface, not a decision.
 * - `HALTED` — a persistence port threw. The runtime made exactly one persist
 *   attempt and will not retry (an unknown-fate write must not be retried
 *   blindly — the §6 invariant 6 reasoning); the instance is PAUSED and the
 *   incident must be raised. `stage` says which port; on `SAVE_CHECKPOINT` the
 *   decision record WAS handed to the sink and only its owed checkpoint was
 *   not — a composition root that makes decisions durable must then keep that
 *   record from becoming durable alone (ADR-027 D3; `packages/trading-core`
 *   drops it with the rest of its outbox under a GLOBAL halt).
 */

import type { StrategyStateCheckpoint } from "./checkpoint.js";
import { describeLabel } from "./describe.js";
import type { CheckpointTransition } from "./transitions.js";
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
  | "INPUT_INVALID"
  /**
   * The injected `MonotonicClock` threw or returned a non-`bigint` BEFORE the
   * callback was invoked (remediation round 3). The clock is caller-supplied
   * like any other port, and `evaluate()` may not throw; nothing ran, so no
   * record exists and this is a refusal rather than containment. A clock that
   * fails AFTER the callback ran is contained instead, with the reserved
   * `RUNTIME.CLOCK_INVALID` reason code, because the evaluation happened.
   */
  | "CLOCK_INVALID"
  /**
   * The instance's evaluation-sequence counter has reached
   * `Number.MAX_SAFE_INTEGER` and cannot advance without two decisions sharing
   * one sequence number (remediation round 4; see `MAX_EVALUATION_SEQ` in
   * `checkpoint.ts` for the arithmetic and for why the counter stays a
   * `number`). The check runs BEFORE the callback, so nothing was evaluated and
   * no record is owed; the condition is monotone, so every later `evaluate()`
   * refuses the same way. A run that reaches it is finished: resumption is a
   * new run, not a runtime affordance (§9.6).
   */
  | "EVALUATION_SEQ_EXHAUSTED";

export interface EvaluationRefusal {
  readonly code: EvaluationRefusalCode;
  readonly detail: string;
}

export type EvaluationOutcome =
  | {
      readonly kind: "DECIDED";
      readonly record: DecisionRecord;
      readonly telemetry: DecisionTelemetry;
      /** `null` when the decision met no ADR-027 Decision 1 transition. */
      readonly checkpoint: StrategyStateCheckpoint | null;
      /** `CKPT-1`: the ADR-027 Decision 1 transitions it made; empty means no checkpoint. */
      readonly checkpointTransitions: readonly CheckpointTransition[];
    }
  | {
      readonly kind: "CONTAINED";
      readonly record: DecisionRecord;
      readonly telemetry: DecisionTelemetry;
      /** Always a checkpoint in practice: the pause is a STATUS transition. */
      readonly checkpoint: StrategyStateCheckpoint | null;
      readonly checkpointTransitions: readonly CheckpointTransition[];
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
    // `describeLabel`, not raw interpolation: this constructor is PUBLIC and
    // its argument is interpolated, which is the same shape as review round 4's
    // MEDIUM 1 (`new StrategyContextRevokedError(Symbol() as never)` threw
    // `TypeError: Cannot convert a Symbol value to a string` from a class whose
    // whole purpose is to be the typed refusal). The runtime's own call sites
    // all pass a literal capability name; this makes that not the load-bearing
    // part. Found by the derived boundary sweep, not by a report.
    super(
      `StrategyContext capability ${describeLabel(capability)} was used after its callback ` +
        "returned; the " +
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
  /**
   * The parsed params could not be taken into runtime ownership: freezing them
   * (or reading their own properties in order to freeze them) threw. Distinct
   * from `PARAMS_REJECTED`, which is the strategy's own schema saying no
   * (remediation round 3).
   *
   * BELT since remediation round 4: params are MATERIALIZED before they are
   * frozen, so what `deepFreeze` now walks is the runtime's own fresh copy and
   * cannot refuse. The code and its guard are kept because "unreachable" is a
   * claim about today's call graph, and a `deepFreeze` that ever did throw here
   * must still be a typed refusal rather than an escaped exception.
   */
  | "PARAMS_NOT_FREEZABLE"
  /**
   * The parsed params could not be read into the inert copy the runtime owns:
   * they are (or contain) a `Map`, a `Set`, a `Date`, a class instance, a
   * function, an accessor property, a symbol key, a cycle, or a value whose
   * property access executes code (remediation round 4, review round 4's
   * HIGH 2). Distinct from `PARAMS_REJECTED` (the strategy's own schema said
   * no) and from `PARAMS_NOT_FREEZABLE` (the copy could not be frozen).
   *
   * The rule this enforces: §9.6 params are IMMUTABLE configuration, they are
   * persisted as a `strategy.configs` record, and `ctx.params()` must answer
   * the same thing for the whole life of a run. A strategy that wants a derived
   * structure (a compiled matcher, a `Map` index) builds it from the
   * materialized params inside `onStart` and keeps it on its own object — the
   * runtime applies every callback with the strategy as its receiver.
   */
  | "PARAMS_NOT_MATERIALIZABLE"
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
  | "CHECKPOINT_STATE_INVALID"
  /** `CKPT-1`: see `CheckpointRefusalCode` in `checkpoint.ts`. */
  | "RESTORE_POINT_INVALID"
  | "RESTORE_SEQ_INVALID"
  | "RESTORE_INSTANT_INVALID"
  /**
   * `ROLLOVER-1` (`sequence.ts`): `sequence` is not a run evaluation sequence
   * this package minted.
   */
  | "SEQUENCE_SOURCE_INVALID"
  /**
   * `ROLLOVER-1`: the run's evaluation sequence would issue a number at or
   * below the restore point's highest durable sequence.
   */
  | "SEQUENCE_SOURCE_BEHIND";

export interface RuntimeCreationRefusal {
  readonly code: RuntimeCreationRefusalCode;
  readonly detail: string;
}
