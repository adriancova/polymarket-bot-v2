/**
 * The deterministic strategy-instance runtime (§9.6).
 *
 * Responsibilities implemented here, in the handoff's order:
 * - load a strategy definition and IMMUTABLE configuration (validated, then
 *   deep-frozen; a mutation attempt throws in strict mode);
 * - validate parameters against the strategy's schema (Zod-structural
 *   `safeParse`; anything else is a typed refusal, never a guess);
 * - own per-instance state and the deterministic seeded RNG;
 * - invoke synchronous callbacks, handing each ONE invocation-scoped
 *   `StrategyContext` that is revoked in a `finally` the moment the callback
 *   returns or throws (a retained context must never advance the RNG between
 *   callbacks — see `context.ts` and review finding H1);
 * - enforce the evaluation-time watchdog (injected monotonic clock; the
 *   runtime itself reads no clock);
 * - persist EXACTLY ONE `DecisionResult` per evaluation (§6 invariant 3):
 *   one `DecisionSink.persist` call per invoked callback, on every path —
 *   valid decision, empty/no-op decision (persisted like any other, ADR-005
 *   §2), throwing callback, watchdog timeout, invalid returned value;
 * - do all of that work BEFORE persisting anything (review round 2). Every
 *   step that reads strategy-supplied data — parsing the returned decision,
 *   materializing and validating its `statePatch`, merging it into the state,
 *   serializing the state — happens in one fallible region ahead of
 *   `DecisionSink.persist`, so the commit that follows a persist cannot fail.
 *   The invariants this protects: a persisted decision ALWAYS has its
 *   checkpoint, an evaluation sequence number is NEVER re-used, and no
 *   misbehaving strategy value can make `evaluate()` throw;
 * - checkpoint state after every persisted decision;
 * - restore compatible state on restart, refusing incompatibility (§9.6 "new
 *   run for every code, config, model, feature, or state-schema change").
 *
 * Containment (ADR-005 §3): a failed evaluation persists one RUNTIME-
 * attributed `skip` with a reserved reason code and no intents, discards
 * whatever the strategy returned, rolls the RNG back to its pre-invocation
 * state (a discarded evaluation leaves no trace on instance state), PAUSES
 * the instance, and reports an incident in the returned outcome. A paused
 * instance refuses every further evaluation; resumption is an operator
 * decision expressed as a new run, not a runtime affordance.
 *
 * Watchdog honesty: callbacks are synchronous (§9.6), so a callback that
 * never returns cannot be preempted in-process — the budget is enforced when
 * the callback returns or throws, and a genuinely wedged process is the
 * composition root's process-level watchdog to kill (WP-230 health state).
 * What THIS runtime guarantees is that an over-budget return is discarded,
 * recorded as a runtime skip, and pauses the instance.
 */

import {
  DECISION_RESULT_SCHEMA_VERSION,
  DecisionResultSchema,
  MAX_IDENTIFIER_LENGTH,
  UnsignedBigIntStringSchema,
  type DecisionResult,
} from "@polymarket-bot/domain";
import {
  STRATEGY_CALLBACK_NAMES,
  type Strategy,
  type StrategyCallbackName,
  type StrategyContext,
} from "@polymarket-bot/strategy-sdk";

import {
  restoreCheckpoint,
  STRATEGY_STATE_CHECKPOINT_SCHEMA_VERSION,
  type InstanceStatus,
  type StrategyStateCheckpoint,
} from "./checkpoint.js";
import { buildStrategyContext, type ScopedStrategyContext } from "./context.js";
import { validateEvaluationInput, type EvaluationInput } from "./input.js";
import { canonicalJsonStringify, deepFreeze, materializeCheckpointableJson } from "./json.js";
import type {
  ContainedFailure,
  EvaluationOutcome,
  RuntimeCreationRefusal,
  RuntimeCreationRefusalCode,
} from "./outcomes.js";
import type { CheckpointStore, DecisionSink, MonotonicClock } from "./ports.js";
import type { DecisionRecord, DecisionTelemetry } from "./record.js";
import { isReservedRuntimeReasonCode, RUNTIME_REASON_CODES } from "./reserved-codes.js";
import { DeterministicRng } from "./rng.js";

/** Run identity the composition root assigns (§10.3 `strategy.runs`). */
export interface RunIdentity {
  readonly runId: string;
  readonly instanceId: string;
  /** The immutable config record this run pins (§9.6; `strategy.configs`). */
  readonly configId: string;
  /** Canonical unsigned integer string (§10.3 `runs.run_seed`). */
  readonly runSeed: string;
}

export interface WatchdogPolicy {
  /** Evaluation budget in microseconds; a positive safe integer. */
  readonly evaluationBudgetUs: number;
}

export interface StrategyRuntimeDefinition {
  readonly strategy: Strategy<unknown, unknown>;
  /** Raw params; validated against `strategy.paramsSchema` and frozen. */
  readonly params: unknown;
  readonly run: RunIdentity;
  readonly watchdog: WatchdogPolicy;
  readonly clock: MonotonicClock;
  readonly decisionSink: DecisionSink;
  readonly checkpointStore: CheckpointStore;
  /** Present on restart; refused unless fully compatible (§9.6). */
  readonly restoreFrom?: StrategyStateCheckpoint;
}

export type CreateRuntimeResult =
  | { readonly ok: true; readonly runtime: StrategyInstanceRuntime }
  | { readonly ok: false; readonly refusal: RuntimeCreationRefusal };

interface SafeParseLike {
  safeParse(value: unknown): unknown;
}

const UUID_SHAPED =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function refuse(code: RuntimeCreationRefusalCode, detail: string): CreateRuntimeResult {
  return { ok: false, refusal: { code, detail } };
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Everything one accepted decision commits, computed BEFORE anything is
 * persisted: the decision as it will be recorded (its `statePatch` replaced by
 * the runtime's own materialized copy), the next instance state, and that
 * state's canonical bytes. Producing this can fail — that is the point of
 * producing it first.
 */
interface PreparedDecision {
  readonly decision: DecisionResult;
  readonly state: Readonly<Record<string, unknown>>;
  readonly stateJson: string;
}

type PrepareDecisionResult =
  | { readonly ok: true; readonly prepared: PreparedDecision }
  | { readonly ok: false; readonly failure: ContainedFailure };

function identifierProblem(value: unknown, field: string): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_IDENTIFIER_LENGTH) {
    return `${field} must be a non-empty string of at most ${String(MAX_IDENTIFIER_LENGTH)} characters`;
  }
  if (UUID_SHAPED.test(value) && value !== value.toLowerCase()) {
    return (
      `${field} is UUID-shaped but not canonical lowercase — refused, never case-folded (ADR-016)`
    );
  }
  return null;
}

function hasSafeParse(schema: unknown): schema is SafeParseLike {
  return (
    (typeof schema === "object" || typeof schema === "function") &&
    schema !== null &&
    typeof (schema as { safeParse?: unknown }).safeParse === "function"
  );
}

/**
 * Loads, validates, freezes, and (optionally) restores one strategy instance.
 * Every failure is a typed refusal; nothing here throws.
 */
export function createStrategyInstanceRuntime(
  definition: StrategyRuntimeDefinition,
): CreateRuntimeResult {
  const { strategy, run, watchdog, clock, decisionSink, checkpointStore } = definition;

  // --- strategy shape -----------------------------------------------------
  if (typeof strategy !== "object" || strategy === null) {
    return refuse("STRATEGY_SHAPE_INVALID", "strategy must be an object");
  }
  const nameProblem = identifierProblem(strategy.name, "strategy.name");
  if (nameProblem !== null) {
    return refuse("STRATEGY_SHAPE_INVALID", nameProblem);
  }
  const versionProblem = identifierProblem(strategy.version, "strategy.version");
  if (versionProblem !== null) {
    return refuse("STRATEGY_SHAPE_INVALID", versionProblem);
  }
  if (
    typeof strategy.stateSchemaVersion !== "number" ||
    !Number.isSafeInteger(strategy.stateSchemaVersion) ||
    strategy.stateSchemaVersion < 1
  ) {
    return refuse(
      "STRATEGY_SHAPE_INVALID",
      `strategy.stateSchemaVersion must be a positive safe integer; received ${String(strategy.stateSchemaVersion)}`,
    );
  }
  for (const callbackName of STRATEGY_CALLBACK_NAMES) {
    if (typeof strategy[callbackName] !== "function") {
      return refuse(
        "STRATEGY_SHAPE_INVALID",
        `strategy.${callbackName} must be a function (§9.6 requires all nine callbacks)`,
      );
    }
  }

  // --- run identity and seed ---------------------------------------------
  for (const [field, value] of [
    ["run.runId", run?.runId],
    ["run.instanceId", run?.instanceId],
    ["run.configId", run?.configId],
  ] as const) {
    const problem = identifierProblem(value, field);
    if (problem !== null) {
      return refuse("RUN_IDENTITY_INVALID", problem);
    }
  }
  if (!UnsignedBigIntStringSchema.safeParse(run.runSeed).success) {
    return refuse(
      "RUN_SEED_INVALID",
      "run.runSeed must be a canonical unsigned integer string (§10.3 runs.run_seed)",
    );
  }

  // --- watchdog and ports -------------------------------------------------
  if (
    typeof watchdog?.evaluationBudgetUs !== "number" ||
    !Number.isSafeInteger(watchdog.evaluationBudgetUs) ||
    watchdog.evaluationBudgetUs < 1
  ) {
    return refuse(
      "WATCHDOG_BUDGET_INVALID",
      "watchdog.evaluationBudgetUs must be a positive safe integer",
    );
  }
  if (typeof clock?.nowNs !== "function") {
    return refuse("PORTS_INVALID", "clock.nowNs must be a function");
  }
  if (typeof decisionSink?.persist !== "function") {
    return refuse("PORTS_INVALID", "decisionSink.persist must be a function");
  }
  if (typeof checkpointStore?.save !== "function") {
    return refuse("PORTS_INVALID", "checkpointStore.save must be a function");
  }

  // --- params: validate against the strategy's own schema, then freeze ----
  if (!hasSafeParse(strategy.paramsSchema)) {
    return refuse(
      "PARAMS_SCHEMA_UNSUPPORTED",
      "strategy.paramsSchema must expose safeParse(value) (§9.6 'JSON Schema/Zod'; " +
        "a JSON-Schema-based strategy wraps its validator in a safeParse adapter)",
    );
  }
  const parseResult = strategy.paramsSchema.safeParse(definition.params);
  if (
    typeof parseResult !== "object" ||
    parseResult === null ||
    typeof (parseResult as { success?: unknown }).success !== "boolean"
  ) {
    return refuse(
      "PARAMS_SCHEMA_UNSUPPORTED",
      "strategy.paramsSchema.safeParse must return { success: boolean, ... }",
    );
  }
  const typedResult = parseResult as { success: boolean; data?: unknown; error?: unknown };
  if (!typedResult.success) {
    const error = typedResult.error;
    const errorDetail =
      error instanceof Error ? error.message : error === undefined ? "schema rejection" : String(error);
    return refuse("PARAMS_REJECTED", `params rejected by strategy.paramsSchema: ${errorDetail}`);
  }
  const params = deepFreeze(typedResult.data === undefined ? definition.params : typedResult.data);

  // --- state and RNG: fresh, or restored from a compatible checkpoint -----
  let state: Readonly<Record<string, unknown>> = deepFreeze({});
  let rng = DeterministicRng.fromSeed(run.runSeed);
  let nextEvaluationSeq = 0;
  let status: InstanceStatus = "ACTIVE";

  if (definition.restoreFrom !== undefined) {
    const restored = restoreCheckpoint(definition.restoreFrom, {
      runId: run.runId,
      instanceId: run.instanceId,
      strategyName: strategy.name,
      strategyVersion: strategy.version,
      stateSchemaVersion: strategy.stateSchemaVersion,
      configId: run.configId,
      runSeed: run.runSeed,
    });
    if (!restored.ok) {
      return refuse(restored.refusal.code, restored.refusal.detail);
    }
    state = restored.restored.state;
    rng = DeterministicRng.fromState(restored.restored.rngState);
    nextEvaluationSeq = restored.restored.nextEvaluationSeq;
    status = restored.restored.status;
  }

  return {
    ok: true,
    runtime: new StrategyInstanceRuntime(
      strategy,
      params,
      run,
      watchdog.evaluationBudgetUs,
      clock,
      decisionSink,
      checkpointStore,
      state,
      rng,
      nextEvaluationSeq,
      status,
    ),
  };
}

/**
 * Exported as a TYPE only: the sole way to obtain an instance is
 * `createStrategyInstanceRuntime`, so no caller can bypass validation,
 * freezing, or checkpoint-compatibility refusal.
 */
class StrategyInstanceRuntime {
  private state: Readonly<Record<string, unknown>>;
  /**
   * The canonical bytes of `state`, computed WITH it and never after a persist.
   * Held as a field rather than recomputed inside `buildCheckpoint` so that no
   * serialization — and therefore no possible failure — sits between
   * `DecisionSink.persist` and `CheckpointStore.save`.
   */
  private stateJson: string;
  private evaluationSeq: number;
  private status: InstanceStatus;
  private evaluating = false;

  constructor(
    private readonly strategy: Strategy<unknown, unknown>,
    private readonly params: unknown,
    private readonly run: RunIdentity,
    private readonly evaluationBudgetUs: number,
    private readonly clock: MonotonicClock,
    private readonly decisionSink: DecisionSink,
    private readonly checkpointStore: CheckpointStore,
    initialState: Readonly<Record<string, unknown>>,
    private readonly rng: DeterministicRng,
    initialEvaluationSeq: number,
    initialStatus: InstanceStatus,
  ) {
    this.state = initialState;
    // Safe here and only here: `initialState` is either the empty object or the
    // `JSON.parse` output `restoreCheckpoint` already validated — inert data in
    // both cases, never a caller's live object.
    this.stateJson = canonicalJsonStringify(initialState);
    this.evaluationSeq = initialEvaluationSeq;
    this.status = initialStatus;
  }

  instanceStatus(): InstanceStatus {
    return this.status;
  }

  nextEvaluationSeq(): number {
    return this.evaluationSeq;
  }

  /**
   * One evaluation: exactly one persisted decision record when (and only
   * when) the callback is invoked. Never throws — not for a callback that
   * throws, not for a value the strategy returns, and not for a view the
   * caller supplies. The two sequence facts that go with it: every persisted
   * record consumes its own `evaluationSeq`, and an evaluation that reaches
   * persistence and fails there leaves the instance PAUSED rather than
   * re-usable, so no two records can ever share a sequence number.
   */
  evaluate(input: EvaluationInput): EvaluationOutcome {
    if (this.evaluating) {
      return {
        kind: "REFUSED",
        refusal: {
          code: "EVALUATION_REENTRANT",
          detail: "evaluate() called re-entrantly during an evaluation; refused without a record",
        },
      };
    }
    if (this.status !== "ACTIVE") {
      return {
        kind: "REFUSED",
        refusal: {
          code: this.status === "PAUSED" ? "INSTANCE_PAUSED" : "INSTANCE_STOPPED",
          detail:
            `instance is ${this.status}; the callback was not invoked and no record was ` +
            "persisted — resumption is a new run, not a runtime affordance",
        },
      };
    }
    const validation = validateEvaluationInput(input);
    if (!validation.ok) {
      return {
        kind: "REFUSED",
        refusal: { code: "INPUT_INVALID", detail: validation.detail },
      };
    }

    this.evaluating = true;
    try {
      return this.runEvaluation(input);
    } finally {
      this.evaluating = false;
    }
  }

  private runEvaluation(input: EvaluationInput): EvaluationOutcome {
    const rngSnapshot = this.rng.snapshot();
    let scoped: ScopedStrategyContext;
    try {
      scoped = buildStrategyContext(input, this.params, this.state, this.rng);
    } catch (cause) {
      // Building the context takes ownership of the caller's view objects and
      // deep-freezes them in place (`input.ts`, `assumptions` 13). A view that
      // refuses to be frozen — a Proxy, a host object, a sealed exotic — is an
      // unusable INPUT, and the honest outcome is the input refusal: the
      // callback was never invoked, so §6 invariant 3 does not bind and no
      // record exists. It is refused rather than propagated because
      // `evaluate()` may not throw.
      return {
        kind: "REFUSED",
        refusal: {
          code: "INPUT_INVALID",
          detail:
            `evaluation input could not be taken into runtime ownership (${describeCause(cause)}); ` +
            "every view passed to evaluate() must be a plain, freezable object — the callback " +
            "was not invoked and no record was persisted",
        },
      };
    }

    let returned: DecisionResult | undefined;
    let thrown: unknown;
    let threw = false;
    const startNs = this.clock.nowNs();
    try {
      returned = this.invokeCallback(input, scoped.context);
    } catch (cause) {
      threw = true;
      thrown = cause;
    } finally {
      // The context is a capability for THIS invocation only. Revoking here —
      // on the returning path and the throwing path alike — is what stops a
      // retained `ctx` from drawing from the live generator between callbacks
      // and desynchronizing the stream from every checkpoint (finding H1).
      scoped.revoke();
    }
    const endNs = this.clock.nowNs();
    const elapsedNs = endNs > startNs ? endNs - startNs : 0n;
    const durationUs = Number(elapsedNs / 1000n);
    const telemetry: DecisionTelemetry = { evaluationDurationUs: durationUs };

    if (threw) {
      return this.contain(
        input,
        telemetry,
        rngSnapshot,
        {
          reasonCode: RUNTIME_REASON_CODES.callbackThrew,
          detail:
            `strategy callback ${input.callback} threw: ` +
            (thrown instanceof Error ? thrown.message : String(thrown)),
          cause: thrown,
        },
      );
    }
    if (durationUs > this.evaluationBudgetUs) {
      // ADR-005 §3: the runtime "discards any value the strategy later
      // returns for that evaluation" — the returned decision is dropped.
      return this.contain(input, telemetry, rngSnapshot, {
        reasonCode: RUNTIME_REASON_CODES.watchdogTimeout,
        detail:
          `strategy callback ${input.callback} exceeded the evaluation budget: ` +
          `${String(durationUs)}us > ${String(this.evaluationBudgetUs)}us`,
      });
    }

    // Everything that inspects what the strategy RETURNED happens here, in one
    // fallible region that runs strictly BEFORE any persistence and entirely
    // inside containment (review round 2). Validation, materialization of the
    // state patch, the merged state and its canonical bytes are all produced
    // now, so the commit below has nothing left that can fail. The `catch` is
    // the belt to the materializer's braces: every step in `prepareDecision`
    // already returns its failure, and a step that nonetheless throws — a
    // hostile value reached through a path not yet enumerated — is still
    // contained as the strategy's fault instead of escaping `evaluate()`.
    let preparation: PrepareDecisionResult;
    try {
      preparation = this.prepareDecision(input, returned);
    } catch (cause) {
      preparation = {
        ok: false,
        failure: {
          reasonCode: RUNTIME_REASON_CODES.decisionInvalid,
          detail:
            `inspecting the value returned by strategy callback ${input.callback} threw ` +
            `(${describeCause(cause)}); a decision the runtime cannot read without executing ` +
            "strategy code is not a decision",
          cause,
        },
      };
    }
    if (!preparation.ok) {
      return this.contain(input, telemetry, rngSnapshot, preparation.failure);
    }
    const prepared = preparation.prepared;

    const record = this.buildRecord(input, "STRATEGY", prepared.decision);
    try {
      this.decisionSink.persist(record, telemetry);
    } catch (cause) {
      return this.halt("PERSIST_DECISION", record, cause);
    }

    // Commit: state, sequence, lifecycle — only after the record is persisted.
    // Every value assigned here was computed above, so this block cannot fail:
    // a persisted decision always gets its sequence number and its checkpoint.
    this.state = prepared.state;
    this.stateJson = prepared.stateJson;
    const recordedSeq = this.evaluationSeq;
    this.evaluationSeq += 1;
    if (input.callback === "onStop") {
      this.status = "STOPPED";
    }

    const checkpoint = this.buildCheckpoint(recordedSeq);
    try {
      this.checkpointStore.save(checkpoint);
    } catch (cause) {
      return this.halt("SAVE_CHECKPOINT", record, cause);
    }

    return { kind: "DECIDED", record, telemetry, checkpoint };
  }

  /**
   * Validates the returned decision and materializes everything the commit will
   * need. Nothing here mutates the instance: a failure leaves the runtime
   * exactly as it was, which is what lets the caller contain it.
   *
   * The `statePatch` is MATERIALIZED, not merely validated. A validated
   * original is worth nothing if it is a Proxy: its traps can answer the
   * validator one way and the serializer, the freezer, or the sink another.
   * The materialized copy is therefore what goes into the state, into the
   * checkpoint bytes, and into the persisted RECORD — the last of these because
   * the decision log is what `rebuildStateFromPatches` folds, and a durable
   * record that disagrees with the checkpoint it accompanies would break §6
   * invariant 8 for strategy state.
   */
  private prepareDecision(
    input: EvaluationInput,
    returned: DecisionResult | undefined,
  ): PrepareDecisionResult {
    const invalid = (detail: string): PrepareDecisionResult => ({
      ok: false,
      failure: { reasonCode: RUNTIME_REASON_CODES.decisionInvalid, detail },
    });

    const parsed = DecisionResultSchema.safeParse(returned);
    if (!parsed.success) {
      return invalid(
        `strategy callback ${input.callback} did not return a valid §7.5 DecisionResult: ` +
          parsed.error.message,
      );
    }
    const decision = parsed.data;
    if (decision.featureSnapshotRef !== input.features.snapshotRef) {
      return invalid(
        `decision names featureSnapshotRef ${decision.featureSnapshotRef}, but this ` +
          `evaluation saw ${input.features.snapshotRef} — the §6 invariant 4 chain must ` +
          "name the snapshot the strategy actually saw",
      );
    }
    if (decision.reasonCodes.some((code) => isReservedRuntimeReasonCode(code))) {
      return invalid(
        "decision uses a reserved RUNTIME.* reason code; runtime attribution cannot be " +
          "claimed by a strategy (ADR-005 §3)",
      );
    }
    if (decision.statePatch === undefined) {
      return {
        ok: true,
        prepared: { decision, state: this.state, stateJson: this.stateJson },
      };
    }

    const materialized = materializeCheckpointableJson(decision.statePatch, "statePatch");
    if (!materialized.ok) {
      return {
        ok: false,
        failure: {
          reasonCode: RUNTIME_REASON_CODES.statePatchInvalid,
          detail: `statePatch is not checkpointable JSON: ${materialized.problem}`,
        },
      };
    }
    const patch = deepFreeze(materialized.value) as Readonly<Record<string, unknown>>;
    const state = deepFreeze({ ...this.state, ...patch });
    return {
      ok: true,
      prepared: {
        decision: { ...decision, statePatch: patch },
        state,
        stateJson: canonicalJsonStringify(state),
      },
    };
  }

  private invokeCallback(input: EvaluationInput, context: StrategyContext): DecisionResult {
    switch (input.callback) {
      case "onStart":
        return this.strategy.onStart(context);
      case "onMarketOpen":
        return this.strategy.onMarketOpen(context);
      case "onFeatures":
        return this.strategy.onFeatures(context);
      case "onFill":
        return this.strategy.onFill(context, input.fill);
      case "onOrderUpdate":
        return this.strategy.onOrderUpdate(context, input.order);
      case "onTimer":
        return this.strategy.onTimer(context);
      case "onMarketClosing":
        return this.strategy.onMarketClosing(context, input.secondsRemaining);
      case "onMarketResolved":
        return this.strategy.onMarketResolved(context, input.resolution);
      case "onStop":
        return this.strategy.onStop(context, input.reason);
    }
  }

  /**
   * ADR-005 §3 containment: one RUNTIME-attributed `skip` record, reserved
   * reason code, no intents; the RNG rolls back to its pre-invocation state;
   * the instance pauses; the incident is reported in the outcome.
   */
  private contain(
    input: EvaluationInput,
    telemetry: DecisionTelemetry,
    rngSnapshot: ReturnType<DeterministicRng["snapshot"]>,
    failure: ContainedFailure,
  ): EvaluationOutcome {
    this.rng.restore(rngSnapshot);

    const decision: DecisionResult = {
      decisionType: "skip",
      reasonCodes: [failure.reasonCode],
      featureSnapshotRef: input.features.snapshotRef,
      intents: [],
    };
    const record = this.buildRecord(input, "RUNTIME", decision);
    try {
      this.decisionSink.persist(record, telemetry);
    } catch (cause) {
      return this.halt("PERSIST_DECISION", record, cause);
    }

    const recordedSeq = this.evaluationSeq;
    this.evaluationSeq += 1;
    this.status = "PAUSED";

    const checkpoint = this.buildCheckpoint(recordedSeq);
    try {
      this.checkpointStore.save(checkpoint);
    } catch (cause) {
      return this.halt("SAVE_CHECKPOINT", record, cause);
    }

    return {
      kind: "CONTAINED",
      record,
      telemetry,
      checkpoint,
      failure,
      incident: { code: failure.reasonCode, detail: failure.detail },
    };
  }

  /** A persistence port threw: pause, report, do NOT retry (§6 invariant 6 reasoning). */
  private halt(
    stage: "PERSIST_DECISION" | "SAVE_CHECKPOINT",
    record: DecisionRecord,
    cause: unknown,
  ): EvaluationOutcome {
    this.status = "PAUSED";
    const port = stage === "PERSIST_DECISION" ? "DecisionSink.persist" : "CheckpointStore.save";
    return {
      kind: "HALTED",
      stage,
      record,
      cause,
      incident: {
        code:
          stage === "PERSIST_DECISION"
            ? "RUNTIME.DECISION_PERSIST_FAILED"
            : "RUNTIME.CHECKPOINT_SAVE_FAILED",
        detail:
          `${port} threw (${cause instanceof Error ? cause.message : String(cause)}); ` +
          "instance paused; the write was attempted exactly once and is not retried — " +
          "reconcile against the store's (runId, evaluationSeq) key before resuming",
      },
    };
  }

  private buildRecord(
    input: EvaluationInput,
    attribution: DecisionRecord["attribution"],
    decision: DecisionResult,
  ): DecisionRecord {
    const base = {
      decisionContractVersion: DECISION_RESULT_SCHEMA_VERSION,
      runId: this.run.runId,
      instanceId: this.run.instanceId,
      marketId: input.market.marketId,
      evaluationSeq: this.evaluationSeq,
      callback: input.callback satisfies StrategyCallbackName,
      attribution,
      evaluatedAt: input.evaluatedAt,
      decision,
    };
    return input.sourceEvent === undefined
      ? base
      : { ...base, sourceEvent: input.sourceEvent };
  }

  private buildCheckpoint(recordedSeq: number): StrategyStateCheckpoint {
    return {
      checkpointSchemaVersion: STRATEGY_STATE_CHECKPOINT_SCHEMA_VERSION,
      runId: this.run.runId,
      instanceId: this.run.instanceId,
      strategyName: this.strategy.name,
      strategyVersion: this.strategy.version,
      stateSchemaVersion: this.strategy.stateSchemaVersion,
      configId: this.run.configId,
      runSeed: this.run.runSeed,
      checkpointSeq: recordedSeq,
      status: this.status,
      rngState: this.rng.snapshot(),
      // The bytes were computed together with the state they describe, before
      // the decision was persisted; nothing is serialized after a persist.
      stateJson: this.stateJson,
    };
  }
}

export type { StrategyInstanceRuntime };
