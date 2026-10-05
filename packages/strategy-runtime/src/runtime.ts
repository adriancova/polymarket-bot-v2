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
 *   So does the ADR-027 checkpoint verdict (`CKPT-1`), which is a pure
 *   function of values already computed. The invariants this protects: a
 *   persisted decision that meets ADR-027 Decision 1 ALWAYS has its checkpoint
 *   (Decision 3), an evaluation sequence number is NEVER re-used, and no
 *   misbehaving strategy value can make `evaluate()` throw;
 * - checkpoint state after a persisted decision that meets ADR-027 Decision 1
 *   (`transitions.ts`: a state, status or RNG change, the start, the stop, or
 *   a 60 s event-time heartbeat). Other decisions have none. Until `CKPT-1`
 *   this read "checkpoint state after every persisted decision" (`WP-170`
 *   decision 4);
 * - restore compatible state on restart, refusing incompatibility (§9.6 "new
 *   run for every code, config, model, feature, or state-schema change"),
 *   from a RESTORE POINT — the last checkpoint plus the highest durable
 *   evaluation sequence (ADR-027 D2; `checkpoint.ts` `restoreFromPoint`).
 *
 * ONE SNAPSHOT PER BOUNDARY (remediation round 3, review round 3's HIGH). Every
 * value a caller hands this module is read exactly ONCE, into inert data, and
 * that same data is what every later step uses:
 *
 * - the DEFINITION is snapshotted at creation — identifiers, versions, the
 *   budget, the nine callback functions, and each port's method — so the
 *   `strategyName` that was validated is the one every checkpoint carries, and
 *   the `onFeatures` that was type-checked is the one that gets invoked;
 * - the EVALUATION INPUT is materialized by `acquireEvaluationInput` before
 *   anything is validated or invoked, so the market the callback sees is the
 *   market the record names. Before this round the views were deep-FROZEN in
 *   place and then re-read: freezing makes properties non-configurable but
 *   leaves getters and Proxy traps live, which produced both an escaped throw
 *   AFTER the callback had run and a silent callback/record divergence;
 * - the returned DECISION's `statePatch` is materialized (round 2) and, since
 *   round 4, ISOLATED from the value the domain schema walks, so the patch is
 *   traversed exactly once and always under its own attribution;
 * - a CHECKPOINT document is snapshotted by `restoreCheckpoint` (round 3);
 * - the PARAMS are materialized at creation (round 4). Round 3 exempted them —
 *   "a paramsSchema may legitimately produce a non-JSON value, and params never
 *   enter a record or checkpoint bytes" — and review round 4 disproved the
 *   exemption with two probes: `Object.freeze` leaves a `Map`'s entries and a
 *   getter live, so a caller that kept its params object changed what
 *   `ctx.params()` answered AFTER the run started, and two runtimes with the
 *   same run identity, input and seed produced different decisions.
 *   `ctx.params()` now answers with the runtime's own inert copy, and a params
 *   value that cannot be copied is a typed `PARAMS_NOT_MATERIALIZABLE` refusal.
 *
 * SEQUENCE ARITHMETIC (round 4). `evaluationSeq` is an IEEE-754 double, so the
 * counter is only meaningful while every increment is exact. `evaluate()`
 * refuses before the callback once the counter reaches
 * `MAX_EVALUATION_SEQ + 1`, and `restoreCheckpoint` refuses a document whose
 * successor sequence would not be exactly representable. Without both, a
 * checkpoint at `Number.MAX_SAFE_INTEGER` restored an instance that persisted
 * two ordinary decisions under one sequence number.
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
  MAX_IDENTIFIER_LENGTH,
  type DecisionResult,
} from "@polymarket-bot/domain";
import { ownDataDescriptor } from "@polymarket-bot/risk/plain-data";
import {
  STRATEGY_CALLBACK_NAMES,
  type Strategy,
  type StrategyCallbackName,
  type StrategyContext,
} from "@polymarket-bot/strategy-sdk";

import {
  MAX_EVALUATION_SEQ,
  restoreFromPoint,
  STRATEGY_STATE_CHECKPOINT_SCHEMA_VERSION,
  type InstanceStatus,
  type StrategyRestorePoint,
  type StrategyStateCheckpoint,
} from "./checkpoint.js";
import { buildStrategyContext, type ScopedStrategyContext } from "./context.js";
import { describeCause } from "./describe.js";
import { acquireEvaluationInput, type EvaluationInput } from "./input.js";
import {
  canonicalJsonStringify,
  deepFreeze,
  materializeCheckpointableJsonAt,
  materializeDecisionViewAt,
  materializeImmutableParamsAt,
} from "./json.js";
import {
  DECISION_FIELD_NAMES,
  DoorDecisionWithoutModelOutputsSchema,
  DoorUnsignedBigIntStringSchema,
  MODEL_OUTPUTS_KEY,
  RawModelOutputsSchema,
} from "./parse-door.js";
import type {
  ContainedFailure,
  EvaluationOutcome,
  RuntimeCreationRefusal,
  RuntimeCreationRefusalCode,
} from "./outcomes.js";
import type { CheckpointStore, DecisionSink, MonotonicClock } from "./ports.js";
import { readOwnFieldsOnce } from "./read-once.js";
import type { DecisionRecord, DecisionTelemetry } from "./record.js";
import { isReservedRuntimeReasonCode, RUNTIME_REASON_CODES } from "./reserved-codes.js";
import { DeterministicRng } from "./rng.js";
import { isRunEvaluationSequence, type RunEvaluationSequence } from "./sequence.js";
import {
  checkpointTransitions,
  type CheckpointMark,
  type CheckpointTransition,
} from "./transitions.js";

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
  /**
   * Present on restart; refused unless fully compatible (§9.6). `CKPT-1`: a
   * RESTORE POINT — the last durable checkpoint, the highest durable
   * `evaluationSeq`, and the instant of the checkpointed decision (ADR-027 D2;
   * {@link StrategyRestorePoint}). Until `CKPT-1` it was the bare checkpoint,
   * and the restored instance resumed at `checkpointSeq + 1`.
   */
  readonly restoreFrom?: StrategyRestorePoint;
  /**
   * `ROLLOVER-1` (ADR-030 Decision 4; the user's ruling Q2): the RUN's
   * evaluation sequence, shared by every runtime of one run — one per admitted
   * window of a series — so no two of them persist the same
   * `(run_id, evaluation_seq)` or `(run_id, checkpoint_seq)` (`sequence.ts`).
   * Only a counter `sequence.ts` minted is accepted (`SEQUENCE_SOURCE_INVALID`).
   * ABSENT: the runtime numbers its own decisions from 0 (or from its restore
   * point), exactly as before.
   */
  readonly sequence?: RunEvaluationSequence;
}

export type CreateRuntimeResult =
  | { readonly ok: true; readonly runtime: StrategyInstanceRuntime }
  | { readonly ok: false; readonly refusal: RuntimeCreationRefusal };

const UUID_SHAPED =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const DEFINITION_FIELDS = [
  "strategy",
  "params",
  "run",
  "watchdog",
  "clock",
  "decisionSink",
  "checkpointStore",
  "restoreFrom",
  "sequence",
] as const;

const STRATEGY_FIELDS = ["name", "version", "stateSchemaVersion", "paramsSchema"] as const;
const RUN_FIELDS = ["runId", "instanceId", "configId", "runSeed"] as const;

/**
 * A captured port: the method read once at creation, plus the object it must
 * be applied to. `Reflect.apply` is used at the call site so that no further
 * property read happens on the caller's object — the method that was type-
 * checked is the method that runs.
 */
interface CapturedPort<M> {
  readonly receiver: unknown;
  readonly method: M;
}

type ClockMethod = (this: unknown) => unknown;
type PersistMethod = (
  this: unknown,
  record: DecisionRecord,
  telemetry: DecisionTelemetry,
) => unknown;
type SaveMethod = (this: unknown, checkpoint: StrategyStateCheckpoint) => unknown;
type CallbackMethod = (this: unknown, context: StrategyContext, payload?: unknown) => unknown;

/** The strategy as inert data plus the nine functions captured once. */
interface CapturedStrategy {
  readonly name: string;
  readonly version: string;
  readonly stateSchemaVersion: number;
  /** The strategy object itself, used ONLY as the `this` of its own callbacks. */
  readonly receiver: unknown;
  readonly callbacks: Readonly<Record<StrategyCallbackName, CallbackMethod>>;
}

type SafeParseMethod = (this: unknown, value: unknown) => unknown;

function refuse(code: RuntimeCreationRefusalCode, detail: string): CreateRuntimeResult {
  return { ok: false, refusal: { code, detail } };
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

/**
 * Loads, validates, freezes, and (optionally) restores one strategy instance.
 * Every failure is a typed refusal; nothing here throws — including for a
 * definition whose accessors throw, a `paramsSchema.safeParse` that throws, a
 * params value that refuses to be frozen, and a checkpoint document whose
 * `stateJson` getter throws on a second read (all four were live before
 * remediation round 3).
 */
export function createStrategyInstanceRuntime(
  definition: StrategyRuntimeDefinition,
): CreateRuntimeResult {
  // --- ONE read of every field of the caller's definition ------------------
  const outer = readOwnFieldsOnce(definition, "definition", DEFINITION_FIELDS);
  if (!outer.ok) {
    return refuse("STRATEGY_SHAPE_INVALID", outer.problem);
  }
  const strategy = outer.fields.strategy;
  const rawParams = outer.fields.params;
  const run = outer.fields.run;
  const watchdog = outer.fields.watchdog;
  const clock = outer.fields.clock;
  const decisionSink = outer.fields.decisionSink;
  const checkpointStore = outer.fields.checkpointStore;
  const restoreFrom = outer.fields.restoreFrom;
  const sequenceField = outer.fields.sequence;

  // --- strategy shape -----------------------------------------------------
  if (typeof strategy !== "object" || strategy === null) {
    return refuse("STRATEGY_SHAPE_INVALID", "strategy must be an object");
  }
  const strategyFields = readOwnFieldsOnce(strategy, "strategy", STRATEGY_FIELDS);
  if (!strategyFields.ok) {
    return refuse("STRATEGY_SHAPE_INVALID", strategyFields.problem);
  }
  const name = strategyFields.fields.name;
  const version = strategyFields.fields.version;
  const stateSchemaVersion = strategyFields.fields.stateSchemaVersion;
  const paramsSchema = strategyFields.fields.paramsSchema;

  const nameProblem = identifierProblem(name, "strategy.name");
  if (nameProblem !== null) {
    return refuse("STRATEGY_SHAPE_INVALID", nameProblem);
  }
  const versionProblem = identifierProblem(version, "strategy.version");
  if (versionProblem !== null) {
    return refuse("STRATEGY_SHAPE_INVALID", versionProblem);
  }
  if (
    typeof stateSchemaVersion !== "number" ||
    !Number.isSafeInteger(stateSchemaVersion) ||
    stateSchemaVersion < 1
  ) {
    return refuse(
      "STRATEGY_SHAPE_INVALID",
      `strategy.stateSchemaVersion must be a positive safe integer; received ${describeCause(stateSchemaVersion)}`,
    );
  }
  const callbackFields = readOwnFieldsOnce(strategy, "strategy", STRATEGY_CALLBACK_NAMES);
  if (!callbackFields.ok) {
    return refuse("STRATEGY_SHAPE_INVALID", callbackFields.problem);
  }
  const callbacks: Partial<Record<StrategyCallbackName, CallbackMethod>> = {};
  for (const callbackName of STRATEGY_CALLBACK_NAMES) {
    const callback = callbackFields.fields[callbackName];
    if (typeof callback !== "function") {
      return refuse(
        "STRATEGY_SHAPE_INVALID",
        `strategy.${callbackName} must be a function (§9.6 requires all nine callbacks)`,
      );
    }
    callbacks[callbackName] = callback as CallbackMethod;
  }
  const capturedStrategy: CapturedStrategy = {
    name: name as string,
    version: version as string,
    stateSchemaVersion,
    receiver: strategy,
    callbacks: Object.freeze(callbacks as Record<StrategyCallbackName, CallbackMethod>),
  };

  // --- run identity and seed ---------------------------------------------
  const runFields = readOwnFieldsOnce(run, "run", RUN_FIELDS);
  if (!runFields.ok) {
    return refuse("RUN_IDENTITY_INVALID", runFields.problem);
  }
  const runId = runFields.fields.runId;
  const instanceId = runFields.fields.instanceId;
  const configId = runFields.fields.configId;
  const runSeed = runFields.fields.runSeed;
  for (const [field, value] of [
    ["run.runId", runId],
    ["run.instanceId", instanceId],
    ["run.configId", configId],
  ] as const) {
    const problem = identifierProblem(value, field);
    if (problem !== null) {
      return refuse("RUN_IDENTITY_INVALID", problem);
    }
  }
  // D2: the ARENA copy, not the raw domain schema. `runSeed` is the one thing
  // that makes a run replayable (§12.4), and at base `53e9f62` a non-enumerable
  // inherited `skipChecks` made this parse accept `"007"` and `"-1"` — a seed
  // that is not a canonical unsigned integer string, admitted at creation.
  if (typeof runSeed !== "string" || !DoorUnsignedBigIntStringSchema.safeParse(runSeed).success) {
    return refuse(
      "RUN_SEED_INVALID",
      "run.runSeed must be a canonical unsigned integer string (§10.3 runs.run_seed)",
    );
  }
  const capturedRun: RunIdentity = {
    runId: runId as string,
    instanceId: instanceId as string,
    configId: configId as string,
    runSeed,
  };

  // --- watchdog and ports -------------------------------------------------
  const watchdogFields = readOwnFieldsOnce(watchdog, "watchdog", ["evaluationBudgetUs"]);
  if (!watchdogFields.ok) {
    return refuse("WATCHDOG_BUDGET_INVALID", watchdogFields.problem);
  }
  const evaluationBudgetUs = watchdogFields.fields.evaluationBudgetUs;
  if (
    typeof evaluationBudgetUs !== "number" ||
    !Number.isSafeInteger(evaluationBudgetUs) ||
    evaluationBudgetUs < 1
  ) {
    return refuse(
      "WATCHDOG_BUDGET_INVALID",
      "watchdog.evaluationBudgetUs must be a positive safe integer",
    );
  }

  const clockFields = readOwnFieldsOnce(clock, "clock", ["nowNs"]);
  if (!clockFields.ok) {
    return refuse("PORTS_INVALID", clockFields.problem);
  }
  const nowNs = clockFields.fields.nowNs;
  if (typeof nowNs !== "function") {
    return refuse("PORTS_INVALID", "clock.nowNs must be a function");
  }
  const sinkFields = readOwnFieldsOnce(decisionSink, "decisionSink", ["persist"]);
  if (!sinkFields.ok) {
    return refuse("PORTS_INVALID", sinkFields.problem);
  }
  const persist = sinkFields.fields.persist;
  if (typeof persist !== "function") {
    return refuse("PORTS_INVALID", "decisionSink.persist must be a function");
  }
  const storeFields = readOwnFieldsOnce(checkpointStore, "checkpointStore", ["save"]);
  if (!storeFields.ok) {
    return refuse("PORTS_INVALID", storeFields.problem);
  }
  const save = storeFields.fields.save;
  if (typeof save !== "function") {
    return refuse("PORTS_INVALID", "checkpointStore.save must be a function");
  }

  // --- the run's evaluation sequence (`ROLLOVER-1`, ruling Q2) -------------
  // Only a counter `sequence.ts` minted: a caller-built object would put caller
  // code inside `evaluate()`'s numbering, which the brand check rules out.
  if (sequenceField !== undefined && !isRunEvaluationSequence(sequenceField)) {
    return refuse(
      "SEQUENCE_SOURCE_INVALID",
      "sequence must be a run evaluation sequence minted by createRunEvaluationSequence or " +
        "runEvaluationSequenceAfter (@polymarket-bot/strategy-runtime); a caller-built counter is refused",
    );
  }
  const sequence: RunEvaluationSequence | undefined = sequenceField;

  // --- params: validate against the strategy's own schema, then freeze ----
  // `safeParse` is read ONCE (through the prototype chain, so a Zod schema's
  // method is found) and applied with `Reflect.apply`: the function that was
  // type-checked is the function that runs.
  const schemaFields = readOwnFieldsOnce(paramsSchema, "strategy.paramsSchema", ["safeParse"]);
  if (!schemaFields.ok) {
    return refuse("PARAMS_SCHEMA_UNSUPPORTED", schemaFields.problem);
  }
  const safeParse = schemaFields.fields.safeParse;
  if (typeof safeParse !== "function") {
    return refuse(
      "PARAMS_SCHEMA_UNSUPPORTED",
      "strategy.paramsSchema must expose safeParse(value) (§9.6 'JSON Schema/Zod'; " +
        "a JSON-Schema-based strategy wraps its validator in a safeParse adapter)",
    );
  }
  let parseResult: unknown;
  try {
    parseResult = Reflect.apply(safeParse as SafeParseMethod, paramsSchema, [rawParams]);
  } catch (cause) {
    // A schema that throws is a schema the runtime cannot evaluate. Refused,
    // not propagated: creation returns typed refusals only.
    return refuse(
      "PARAMS_SCHEMA_UNSUPPORTED",
      `strategy.paramsSchema.safeParse threw (${describeCause(cause)}); a validator that throws ` +
        "cannot answer whether the params are valid",
    );
  }
  if (typeof parseResult !== "object" || parseResult === null) {
    return refuse(
      "PARAMS_SCHEMA_UNSUPPORTED",
      "strategy.paramsSchema.safeParse must return { success: boolean, ... }",
    );
  }
  const resultFields = readOwnFieldsOnce(parseResult, "paramsSchema.safeParse(...)", [
    "success",
    "data",
    "error",
  ]);
  if (!resultFields.ok) {
    return refuse("PARAMS_SCHEMA_UNSUPPORTED", resultFields.problem);
  }
  if (typeof resultFields.fields.success !== "boolean") {
    return refuse(
      "PARAMS_SCHEMA_UNSUPPORTED",
      "strategy.paramsSchema.safeParse must return { success: boolean, ... }",
    );
  }
  if (!resultFields.fields.success) {
    const error = resultFields.fields.error;
    const errorDetail = error === undefined ? "schema rejection" : describeCause(error);
    return refuse("PARAMS_REJECTED", `params rejected by strategy.paramsSchema: ${errorDetail}`);
  }
  // The adapter result shape, made unambiguous in remediation round 4 (review
  // round 4's MEDIUM 3). A successful result that CARRIES `data` supplies the
  // parsed params — including when that value is `undefined`, which is what a
  // legitimate Zod transform to `undefined` produces. A successful result with
  // NO `data` property is the lenient adapter that validated without
  // transforming, and the raw params it validated are used. Before this round
  // both cases were read as "absent", so a schema that transformed the params
  // away was ignored and the RAW caller object survived into the run:
  //
  //     safeParse → {success:true, data:undefined}
  //     raw params → {raw:"should-not-survive-transform"}
  //     ctx.params() observed the raw object
  //
  // `readOwnFieldsOnce` answers the presence question with one guarded
  // `Reflect.has` per field, so telling the two apart costs no second read of
  // the value.
  const parsedParams = resultFields.present.data ? resultFields.fields.data : rawParams;

  // Params are MATERIALIZED into the runtime's own inert copy (round 4, HIGH
  // 2). Round 3 argued they should be guarded but not materialized, because a
  // `paramsSchema` might legitimately produce a non-JSON value and params never
  // reach a record or checkpoint bytes. Review round 4 disproved both halves of
  // that with one probe: `Object.freeze` does not freeze a `Map`'s entries or
  // make a getter inert, so two runtimes with the same run identity, input,
  // seed and initially identical params produced DIFFERENT decisions after the
  // caller mutated the `Map` it still held — a determinism break through the
  // config id, and a `StrategyContext` that was not exclusively runtime-owned.
  const materializedParams = materializeImmutableParamsAt(parsedParams, "params");
  if (!materializedParams.ok) {
    return refuse("PARAMS_NOT_MATERIALIZABLE", materializedParams.problem);
  }
  let params: unknown;
  try {
    params = deepFreeze(materializedParams.value);
  } catch (cause) {
    // A belt since round 4: what is frozen here is the copy above, which is
    // fresh plain data. Kept because `evaluate()`'s and `create`'s "never
    // throws" contracts may not rest on a reachability argument.
    return refuse(
      "PARAMS_NOT_FREEZABLE",
      `params could not be frozen for the run (${describeCause(cause)}); immutable ` +
        "configuration (§9.6) must be a freezable object graph",
    );
  }

  // --- state and RNG: fresh, or restored from a compatible checkpoint -----
  let state: Readonly<Record<string, unknown>> = deepFreeze({});
  let rng = DeterministicRng.fromSeed(capturedRun.runSeed);
  let nextEvaluationSeq = 0;
  let status: InstanceStatus = "ACTIVE";
  // `CKPT-1`: no mark — the first decision of a fresh runtime is the START
  // transition (ADR-027 D1.4). A restored runtime resumes from the restored
  // checkpoint's mark instead, so its first decision is judged exactly as the
  // uninterrupted runtime would have judged it (D4.2).
  let mark: CheckpointMark | undefined;

  if (restoreFrom !== undefined) {
    const restored = restoreFromPoint(restoreFrom as StrategyRestorePoint, {
      runId: capturedRun.runId,
      instanceId: capturedRun.instanceId,
      strategyName: capturedStrategy.name,
      strategyVersion: capturedStrategy.version,
      stateSchemaVersion: capturedStrategy.stateSchemaVersion,
      configId: capturedRun.configId,
      runSeed: capturedRun.runSeed,
    });
    if (!restored.ok) {
      return refuse(restored.refusal.code, restored.refusal.detail);
    }
    state = restored.restored.state;
    rng = DeterministicRng.fromState(restored.restored.rngState);
    nextEvaluationSeq = restored.restored.nextEvaluationSeq;
    status = restored.restored.status;
    mark = restored.restored.mark;
    // `ROLLOVER-1`: the run's counter must not be BEHIND the restore point —
    // it would re-issue a sequence the store already holds for this run.
    if (sequence !== undefined && sequence.peek() < nextEvaluationSeq) {
      return refuse(
        "SEQUENCE_SOURCE_BEHIND",
        `the run's evaluation sequence would issue ${String(sequence.peek())} next, but the restore ` +
          `point's highest durable evaluation sequence is ${String(nextEvaluationSeq - 1)}; a run's ` +
          "counter is seeded from its highest durable sequence plus one (runEvaluationSequenceAfter), " +
          "so this counter would re-issue a durable (run_id, evaluation_seq)",
      );
    }
  }

  return {
    ok: true,
    runtime: new StrategyInstanceRuntime(
      capturedStrategy,
      params,
      capturedRun,
      evaluationBudgetUs,
      { receiver: clock, method: nowNs as ClockMethod },
      { receiver: decisionSink, method: persist as PersistMethod },
      { receiver: checkpointStore, method: save as SaveMethod },
      state,
      rng,
      nextEvaluationSeq,
      status,
      mark,
      sequence,
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
  /**
   * `CKPT-1`: what the LAST checkpoint this runtime saved (or was restored
   * from) pinned — the ADR-027 Decision 1 comparison base. `undefined` until a
   * fresh runtime's first checkpoint, which is the START transition.
   */
  private lastCheckpoint: CheckpointMark | undefined;

  constructor(
    private readonly strategy: CapturedStrategy,
    private readonly params: unknown,
    private readonly run: RunIdentity,
    private readonly evaluationBudgetUs: number,
    private readonly clock: CapturedPort<ClockMethod>,
    private readonly decisionSink: CapturedPort<PersistMethod>,
    private readonly checkpointStore: CapturedPort<SaveMethod>,
    initialState: Readonly<Record<string, unknown>>,
    private readonly rng: DeterministicRng,
    initialEvaluationSeq: number,
    initialStatus: InstanceStatus,
    initialMark: CheckpointMark | undefined,
    /**
     * `ROLLOVER-1`: the run's shared counter, or `undefined` for a runtime that
     * numbers its own decisions (every runtime before `ROLLOVER-1`).
     */
    private readonly sequence: RunEvaluationSequence | undefined,
  ) {
    this.lastCheckpoint = initialMark;
    this.state = initialState;
    // Safe here and only here: `initialState` is either the empty object or the
    // materialized copy `restoreCheckpoint` produced — inert data in both
    // cases, never a caller's live object.
    this.stateJson = canonicalJsonStringify(initialState);
    this.evaluationSeq = initialEvaluationSeq;
    this.status = initialStatus;
  }

  instanceStatus(): InstanceStatus {
    return this.status;
  }

  /**
   * The sequence this runtime's next persisted decision would carry: its own
   * counter, or — with a run sequence (`ROLLOVER-1`) — the run's, which every
   * runtime of the run shares.
   */
  nextEvaluationSeq(): number {
    return this.sequence === undefined ? this.evaluationSeq : this.sequence.peek();
  }

  /**
   * One evaluation: exactly one persisted decision record when (and only
   * when) the callback is invoked. Never throws — not for a callback that
   * throws, not for a value the strategy returns, not for a view the caller
   * supplies, and not for a port that misbehaves. The two sequence facts that
   * go with it: every persisted record consumes its own `evaluationSeq`, and an
   * evaluation that reaches persistence and fails there leaves the instance
   * PAUSED rather than re-usable, so no two records can ever share a sequence
   * number.
   *
   * The input is ACQUIRED first: one inert, deep-frozen snapshot that
   * validation, the context, the callback, the record and the checkpoint all
   * read. Nothing below ever touches the caller's object again.
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
    // The sequence space is finite (round 4, HIGH 1). This check runs BEFORE
    // anything is acquired or invoked, so an exhausted instance evaluates
    // nothing, owes no record, and cannot silently continue: the condition is
    // monotone in `evaluationSeq`, which only ever grows, so every subsequent
    // call refuses identically. `MAX_EVALUATION_SEQ` is the last sequence a
    // record may carry; reaching `MAX_EVALUATION_SEQ + 1` means the NEXT
    // increment would not be exact, and two records under one sequence is
    // precisely what this refuses to do.
    if (this.nextEvaluationSeq() > MAX_EVALUATION_SEQ) {
      return {
        kind: "REFUSED",
        refusal: {
          code: "EVALUATION_SEQ_EXHAUSTED",
          detail:
            `the instance has consumed evaluation sequence ${String(MAX_EVALUATION_SEQ)}, the ` +
            "last one this run can represent exactly; the callback was not invoked and no " +
            "record was persisted — a further evaluation would have to share a sequence " +
            "number with an existing decision, so the run is finished and resumption is a " +
            "new run (§9.6)",
        },
      };
    }
    // The re-entrancy flag is set BEFORE the input is acquired, because
    // acquiring it can run caller code: the view grammar invokes a getter once,
    // and a getter that calls `evaluate()` again would otherwise start a nested
    // evaluation that this one knows nothing about. Acquisition is part of the
    // evaluation, so it is inside the guard.
    this.evaluating = true;
    try {
      const acquired = acquireEvaluationInput(input);
      if (!acquired.ok) {
        return {
          kind: "REFUSED",
          refusal: { code: "INPUT_INVALID", detail: acquired.detail },
        };
      }
      return this.runEvaluation(acquired.input);
    } finally {
      this.evaluating = false;
    }
  }

  /** @param input the runtime's own inert snapshot, never the caller's object. */
  private runEvaluation(input: EvaluationInput): EvaluationOutcome {
    const rngSnapshot = this.rng.snapshot();
    let scoped: ScopedStrategyContext;
    try {
      scoped = buildStrategyContext(input, this.params, this.state, this.rng);
    } catch (cause) {
      // Unreachable since round 3 — the context is built from inert snapshot
      // data — and kept as a belt: `evaluate()` may not throw, and a context
      // that cannot be built means the callback was never invoked, so §6
      // invariant 3 does not bind and no record exists.
      return {
        kind: "REFUSED",
        refusal: {
          code: "INPUT_INVALID",
          detail:
            `the evaluation context could not be built (${describeCause(cause)}); the callback ` +
            "was not invoked and no record was persisted",
        },
      };
    }

    const start = this.readClockNs();
    if (!start.ok) {
      // Before the callback: nothing ran, nothing is owed. A broken clock is a
      // caller-error surface, not a strategy failure, so the instance stays
      // usable and no sequence is consumed.
      scoped.revoke();
      return { kind: "REFUSED", refusal: { code: "CLOCK_INVALID", detail: start.detail } };
    }

    let returned: DecisionResult | undefined;
    let thrown: unknown;
    let threw = false;
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
    const end = this.readClockNs();
    if (!end.ok) {
      // AFTER the callback: the evaluation happened, so exactly one record is
      // owed. The duration is unknown and telemetry says so with `null` rather
      // than claiming zero.
      return this.contain(
        input,
        { evaluationDurationUs: null },
        rngSnapshot,
        {
          reasonCode: RUNTIME_REASON_CODES.clockInvalid,
          detail:
            `${end.detail} — the callback had already run, so the evaluation is recorded, but ` +
            "whether it met the watchdog budget cannot be known",
        },
      );
    }
    const elapsedNs = end.value > start.value ? end.value - start.value : 0n;
    const durationUs = Number(elapsedNs / 1000n);
    const telemetry: DecisionTelemetry = { evaluationDurationUs: durationUs };

    if (threw) {
      return this.contain(
        input,
        telemetry,
        rngSnapshot,
        {
          reasonCode: RUNTIME_REASON_CODES.callbackThrew,
          detail: `strategy callback ${input.callback} threw: ${describeCause(thrown)}`,
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
    // now, so the commit below has nothing left that can fail. `prepareDecision`
    // attributes its own failures — a throw while READING the decision is
    // `DECISION_INVALID`, a throw while materializing the PATCH is
    // `STATE_PATCH_INVALID` — and the `catch` here is the belt to those braces
    // (round 3 fixed the mis-attribution that came from doing it the other way
    // round).
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

    // `ROLLOVER-1`: the sequence is CLAIMED here, as the record that carries it
    // is built — from the run's counter when there is one (taken, so no other
    // runtime of the run can carry it), else the runtime's own counter, which
    // moves only after the persist, exactly as before.
    const recordedSeq = this.claimSequence();
    if (recordedSeq === undefined) return this.sequenceExhaustedAfterInvocation(input, rngSnapshot);
    const record = this.buildRecord(input, "STRATEGY", prepared.decision, recordedSeq);
    // `CKPT-1` — ADR-027 Decision 1's verdict, taken BEFORE the persist from
    // values already computed: the state bytes the commit will hold, the
    // status it will set, and the RNG exactly as the callback left it. Pure
    // and total (`transitions.ts`), so nothing fallible is added between the
    // persist and the save.
    const nextStatus: InstanceStatus = input.callback === "onStop" ? "STOPPED" : this.status;
    const transitions = checkpointTransitions(this.lastCheckpoint, {
      callback: input.callback,
      evaluatedAt: input.evaluatedAt,
      stateJson: prepared.stateJson,
      status: nextStatus,
      rngState: this.rng.snapshot(),
    });
    try {
      this.persistRecord(record, telemetry);
    } catch (cause) {
      return this.halt("PERSIST_DECISION", record, cause);
    }

    // Commit: state, sequence, lifecycle — only after the record is persisted.
    // Every value assigned here was computed above, so this block cannot fail:
    // a persisted decision always gets its sequence number, and — when
    // ADR-027 Decision 1 says it owes one — its checkpoint.
    this.state = prepared.state;
    this.stateJson = prepared.stateJson;
    if (this.sequence === undefined) this.evaluationSeq += 1;
    this.status = nextStatus;

    const saved = this.saveOwedCheckpoint(transitions, recordedSeq, input.evaluatedAt);
    if (!saved.ok) {
      return this.halt("SAVE_CHECKPOINT", record, saved.cause);
    }

    return { kind: "DECIDED", record, telemetry, checkpoint: saved.checkpoint, checkpointTransitions: transitions };
  }

  /**
   * `CKPT-1` — writes the checkpoint a persisted decision owes (ADR-027
   * Decision 1), or none when `transitions` is empty, and moves the comparison
   * base to it. Called only after the record is persisted and the commit is
   * applied. A `save` that throws is answered as data (the caller halts);
   * the base does not move then, and the instance is paused anyway.
   */
  private saveOwedCheckpoint(
    transitions: readonly CheckpointTransition[],
    recordedSeq: number,
    evaluatedAt: string,
  ):
    | { readonly ok: true; readonly checkpoint: StrategyStateCheckpoint | null }
    | { readonly ok: false; readonly cause: unknown } {
    if (transitions.length === 0) {
      return { ok: true, checkpoint: null };
    }
    const checkpoint = this.buildCheckpoint(recordedSeq);
    // The next comparison base, from the runtime's OWN values — taken before
    // the checkpoint object is handed to a caller-supplied port, so nothing
    // that port does to it (it is not frozen) can move what the next verdict
    // compares against, or make a read here throw.
    const mark: CheckpointMark = {
      stateJson: this.stateJson,
      status: this.status,
      rngState: this.rng.snapshot(),
      evaluatedAt,
    };
    try {
      this.saveCheckpoint(checkpoint);
    } catch (cause) {
      return { ok: false, cause };
    }
    this.lastCheckpoint = mark;
    return { ok: true, checkpoint };
  }

  /**
   * Reads the injected clock. The clock is a caller-supplied port like any
   * other, so calling it is guarded and its answer is type-checked before any
   * arithmetic: mixing a non-`bigint` into `end - start` throws a `TypeError`
   * out of a function that promises not to throw (remediation round 3).
   */
  private readClockNs(): { readonly ok: true; readonly value: bigint } | { readonly ok: false; readonly detail: string } {
    let value: unknown;
    try {
      value = Reflect.apply(this.clock.method, this.clock.receiver, []);
    } catch (cause) {
      return { ok: false, detail: `MonotonicClock.nowNs threw (${describeCause(cause)})` };
    }
    if (typeof value !== "bigint") {
      return {
        ok: false,
        detail: `MonotonicClock.nowNs must return a bigint of nanoseconds; received ${describeCause(value)}`,
      };
    }
    return { ok: true, value };
  }

  /**
   * `ROLLOVER-1`: the sequence the record being built carries. Without a run
   * sequence, the runtime's own counter (moved after the persist, as before).
   * With one, a number TAKEN from the run's counter — spent now, so a persist
   * that then fails leaves a gap and never a re-use — or `undefined` when the
   * run has consumed its last representable sequence.
   */
  private claimSequence(): number | undefined {
    if (this.sequence === undefined) return this.evaluationSeq;
    return this.sequence.take();
  }

  /**
   * `ROLLOVER-1`: the run's counter was exhausted between the check at the top
   * of `evaluate()` and the claim. Unreachable while the run's runtimes are
   * evaluated one at a time (a strategy callback holds no runtime), and kept
   * because `evaluate()` may not throw and may not persist two records under
   * one sequence: nothing is persisted, the RNG rolls back, and the instance
   * pauses, so it cannot evaluate again.
   */
  private sequenceExhaustedAfterInvocation(
    input: EvaluationInput,
    rngSnapshot: ReturnType<DeterministicRng["snapshot"]>,
  ): EvaluationOutcome {
    this.rng.restore(rngSnapshot);
    this.status = "PAUSED";
    return {
      kind: "REFUSED",
      refusal: {
        code: "EVALUATION_SEQ_EXHAUSTED",
        detail:
          `the run's evaluation sequence was exhausted while strategy callback ${input.callback} ran ` +
          `(the last representable sequence is ${String(MAX_EVALUATION_SEQ)}); no record was persisted, ` +
          "the instance is paused, and the run is finished — resumption is a new run (§9.6)",
      },
    };
  }

  private persistRecord(record: DecisionRecord, telemetry: DecisionTelemetry): void {
    Reflect.apply(this.decisionSink.method, this.decisionSink.receiver, [record, telemetry]);
  }

  private saveCheckpoint(checkpoint: StrategyStateCheckpoint): void {
    Reflect.apply(this.checkpointStore.method, this.checkpointStore.receiver, [checkpoint]);
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
   *
   * Attribution is per REGION (round 3), and since round 4 the regions are
   * SEPARATED IN THE DATA rather than only in the control flow: reading the
   * returned value is `RUNTIME.DECISION_INVALID`, and everything about the
   * patch — reading it, traversing it, materializing it — is
   * `RUNTIME.STATE_PATCH_INVALID`.
   *
   * Why the data separation was necessary (review round 4's MEDIUM 2). Round 3
   * put the two regions in different `try` blocks but still ran
   * `DecisionResultSchema.safeParse` over the WHOLE returned value first, and
   * the domain schema types `statePatch` as `z.record(z.string(),
   * z.unknown())` — a record whose own keys Zod enumerates. So a hostile patch
   * at the TOP level was traversed inside the decision region and reported as a
   * decision problem, while the SAME hostility one level down was reported as a
   * patch problem:
   *
   *     topLevelRevoked outcome=CONTAINED reason=RUNTIME.DECISION_INVALID
   *     nestedRevoked   outcome=CONTAINED reason=RUNTIME.STATE_PATCH_INVALID
   *
   * `isolateStatePatch` now lifts the raw patch out of the returned value
   * before any schema traversal can inspect it, the schema validates the rest,
   * and the patch is materialized afterwards under the patch attribution. The
   * patch is read exactly ONCE on the way out, which also removes the double
   * traversal the old order performed (Zod's record walk, then the boundary's).
   *
   * -------------------------------------------------------------------------
   * WP-170-FU1 (2026-09-05) — this region is now a D1-D4 DOOR
   * -------------------------------------------------------------------------
   *
   * `docs/contracts/schema-boundary.md` §5 item 2 assigns this parse. What it
   * was, and what one non-enumerable inherited `skipChecks` did to it at base
   * `53e9f62`:
   *
   * ```text
   *   strategy returns { decisionType:"hold", reasonCodes:["not a reason code"],
   *                      featureSnapshotRef:"snap-1", intents:[],
   *                      nextWakeupAt:"yesterday" }
   *     clean    → CONTAINED  attribution=RUNTIME  RUNTIME.DECISION_INVALID
   *     polluted → DECIDED    attribution=STRATEGY, and that exact object is
   *                the one persisted decision this evaluation owes
   *                (§6 invariant 3).
   *   with an intent:
   *     polluted → the record carries intentId "018F4A7E-2222-…" (UPPERCASE,
   *                which ADR-016 says is REFUSED, never case-folded) and
   *                validUntil "whenever".
   * ```
   *
   * Four changes, in the order the door runs them:
   *
   * - **D1** the isolation copy is built PROTOTYPE-FREE with
   *   `Object.defineProperty` and the prototype-free descriptor from
   *   `@polymarket-bot/risk/plain-data`, and the isolated decision is then
   *   MATERIALIZED (`materializeDecisionViewAt`) into the runtime's own inert
   *   tree before anything parses it. The MATERIALIZATION is what closes an
   *   AVAILABILITY defeat measured at base — `z.strictObject` finds unknown
   *   keys with `for…in`, which enumerates INHERITED enumerable names, so ONE
   *   enumerable `Object.prototype.zzUnrelated = 1` turned a perfectly valid
   *   decision into `CONTAINED / RUNTIME.DECISION_INVALID`
   *   (`unrecognized_keys: ["zzUnrelated"]`) on every parse, not only a cold
   *   one. (Which of the two closes it was established by mutation, not by
   *   reading: see the note at the isolation copy itself.);
   * - **D2** the parse is the ARENA copy (`./parse-door.js`), so `skipChecks`,
   *   `optin`/`optout`, `when` and `values` are read off containers no caller
   *   can reach;
   * - **D3** the decision the record carries is taken from the MATERIALIZED
   *   TREE, never from `parsed.data`. That is not only the §1 rule: the arena
   *   assembles into prototype-free containers, so an arena `parsed.data` would
   *   hand this runtime a `reasonCodes` array with no `Array.prototype` — and
   *   the reserved-code check two lines below calls `.some` on it;
   * - **D4** the decision handed to `buildRecord` has a null prototype, so a
   *   consumer's `decision.nextWakeupAt ?? …` cannot be answered by
   *   `Object.prototype`.
   *
   * `modelOutputs` is held aside exactly as `statePatch` is, for the reason
   * measured in `parse-door.ts`: the arena FAILS CLOSED on the `null` node
   * inside `ModelOutputValueSchema`, and widening it is a `packages/risk`
   * change this package's grant does not carry.
   *
   * REMEDIATION ROUND 1 (2026-09-06), review round 1's HIGH 1 and MEDIUM 1 —
   * two corrections to the above, both on the same region:
   *
   * - the decision and its `modelOutputs` are materialized under the DECISION
   *   grammar (`materializeDecisionViewAt`), which drops an own enumerable
   *   `__proto__` at EVERY level. The pinned `zod@4.4.3` skips that name at
   *   every level rather than validating it, so base `53e9f62`'s `parsed.data`
   *   never carried it and a D3 rebuild off the tree would have persisted an
   *   unvalidated, contract-forbidden value (`json.ts` header for the
   *   base-vs-tip table);
   * - the `modelOutputs` `safeParse` is wrapped in the SAME region-attributing
   *   `try`/`catch` the decision parse has. It is the one parse in this package
   *   that is not an arena copy, so it is the one that could still throw out of
   *   `safeParse`; before this round that throw reached `evaluate()`'s outer
   *   catch, which attributes it to the wrong region.
   */
  private prepareDecision(
    input: EvaluationInput,
    returned: DecisionResult | undefined,
  ): PrepareDecisionResult {
    const invalid = (detail: string): PrepareDecisionResult => ({
      ok: false,
      failure: { reasonCode: RUNTIME_REASON_CODES.decisionInvalid, detail },
    });
    const patchInvalid = (detail: string): PrepareDecisionResult => ({
      ok: false,
      failure: { reasonCode: RUNTIME_REASON_CODES.statePatchInvalid, detail },
    });

    // REGION 1 — isolate the raw statePatch and modelOutputs. Nothing
    // traverses either here.
    const isolated = isolateStatePatch(returned, input.callback);
    if (!isolated.ok) {
      return isolated.region === "PATCH"
        ? patchInvalid(isolated.problem)
        : invalid(isolated.problem);
    }

    // REGION 2 — the decision WITHOUT its patch or modelOutputs: D1
    // materialized, D2 parsed through the arena, D3 read back off the tree.
    let materializedDecision: unknown;
    try {
      const walked = materializeDecisionViewAt(isolated.decision, "decision");
      if (!walked.ok) {
        return invalid(
          `the value returned by strategy callback ${input.callback} could not be read into ` +
            `the runtime's own inert copy (${walked.problem}); a decision the runtime cannot ` +
            "read without executing strategy code is not a decision",
        );
      }
      materializedDecision = walked.value;
    } catch (cause) {
      // The walk is total; this is the belt, kept because `prepareDecision`
      // runs inside the one fallible region and a throw here would otherwise
      // be attributed by the outer catch rather than by this region.
      return invalid(
        `reading the value returned by strategy callback ${input.callback} threw ` +
          `(${describeCause(cause)}); a decision the runtime cannot read without executing ` +
          "strategy code is not a decision",
      );
    }
    let parsed: ReturnType<typeof DoorDecisionWithoutModelOutputsSchema.safeParse>;
    try {
      parsed = DoorDecisionWithoutModelOutputsSchema.safeParse(materializedDecision);
    } catch (cause) {
      // Zod's `safeParse` catches its own errors, not a trap throw from the
      // value being parsed. Unreachable since this round — the value parsed is
      // the runtime's own materialized tree, which holds no getter and no
      // proxy — and kept as the belt to that claim.
      return invalid(
        `reading the value returned by strategy callback ${input.callback} threw ` +
          `(${describeCause(cause)}); a decision the runtime cannot read without executing ` +
          "strategy code is not a decision",
      );
    }
    if (!parsed.success) {
      return invalid(
        `strategy callback ${input.callback} did not return a valid §7.5 DecisionResult: ` +
          parsed.error.message,
      );
    }
    // The `modelOutputs` half, held aside in REGION 1 (see the header): the
    // arena cannot copy the `null` node inside `ModelOutputValueSchema`, so
    // this subtree is asked of the RAW picked schema. It carries zero format
    // checks, so `skipChecks` is a no-op on it — measured and pinned in
    // `test/unit/strategy-runtime/schema-door.test.ts`, together with the
    // `values`/availability class that DOES reach it (pre-existing, fail-closed,
    // base == tip). The value asked is the materialized copy; the answer is used
    // and the output is discarded (D3).
    let materializedModelOutputs: unknown;
    if (isolated.modelOutputs !== undefined) {
      const walked = materializeDecisionViewAt(isolated.modelOutputs, "modelOutputs");
      if (!walked.ok) {
        return invalid(
          `the modelOutputs returned by strategy callback ${input.callback} could not be read ` +
            `into the runtime's own inert copy (${walked.problem})`,
        );
      }
      materializedModelOutputs = walked.value;
      const outputsProbe = ownData({ [MODEL_OUTPUTS_KEY]: materializedModelOutputs });
      let outputs: ReturnType<typeof RawModelOutputsSchema.safeParse>;
      try {
        outputs = RawModelOutputsSchema.safeParse(outputsProbe);
      } catch (cause) {
        // The SAME belt the decision parse above carries, and on this parse it
        // is not merely a belt: this is the one schema in the package that is
        // NOT an arena copy, so it is the one whose lazy normalization can still
        // throw out of `safeParse` instead of being returned by it. The schema
        // is warmed at module load (`parse-door.ts`, review round 1 HIGH 1),
        // which closes the cold-lazy class — but the catch IS reachable: the
        // disclosed `values`/availability residual still throws out of this
        // parse, and the catch converts that escaping TypeError into a
        // region-attributed refusal instead of `evaluate()`'s outer catch
        // naming the callback. Defence-in-depth for attribution, not an
        // unreachable branch (review round 2 LOW 2).
        return invalid(
          `reading the modelOutputs returned by strategy callback ${input.callback} threw ` +
            `(${describeCause(cause)}); a decision the runtime cannot read without executing ` +
            "strategy code is not a decision",
        );
      }
      if (!outputs.success) {
        return invalid(
          `strategy callback ${input.callback} did not return a valid §7.5 DecisionResult: ` +
            outputs.error.message,
        );
      }
    }
    // D3 — the decision is built from the MATERIALIZED TREE, never from
    // `parsed.data`, and from the CONTRACT'S OWN field names, so a key the
    // library SKIPS rather than validates (`__proto__`; the pinned zod skips it
    // at every level, `parse-door.ts`) is not emitted at the top level. The
    // NESTED levels are handled one step earlier, by the decision grammar's
    // `dropOwnProtoKey` — the field list cannot reach inside `intents[0]` or
    // `modelOutputs`, and review round 1's MEDIUM 1 is exactly that gap.
    //
    // The fields are emitted in the CONTRACT's declaration order, which is the
    // order the library's own object assembly used. That is not cosmetic: the
    // first draft appended `modelOutputs` after the loop, and the honest-path
    // fold diverged from base in exactly one place — the same 7,805 bytes with
    // `"modelOutputs":{…}` moved from its shape position to the end. Measured
    // base→tip over a 9-stage run, the fold is byte-identical.
    const built = Object.create(null) as Record<string, unknown>;
    const tree = materializedDecision as Record<string, unknown>;
    for (const field of DECISION_FIELD_NAMES) {
      if (field === MODEL_OUTPUTS_KEY) {
        if (isolated.modelOutputs === undefined) continue;
        Object.defineProperty(built, field, ownDataDescriptor(materializedModelOutputs));
        continue;
      }
      if (!Object.hasOwn(tree, field)) continue;
      Object.defineProperty(built, field, ownDataDescriptor(tree[field]));
    }
    const decision = deepFreeze(built as unknown as DecisionResult);
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
    if (isolated.patch === undefined) {
      return {
        ok: true,
        prepared: { decision, state: this.state, stateJson: this.stateJson },
      };
    }

    // REGION 3 — the patch, materialized into the runtime's own inert copy.
    try {
      const materialized = materializeCheckpointableJsonAt(isolated.patch, "statePatch");
      if (!materialized.ok) {
        return patchInvalid(`statePatch is not checkpointable JSON: ${materialized.problem}`);
      }
      const copy = materialized.value;
      if (copy === null || typeof copy !== "object" || Array.isArray(copy)) {
        // The shape rule the domain schema used to apply (`z.record(z.string(),
        // …)`), applied here instead — to the inert copy, where the answer
        // cannot change afterwards, and under the patch's own attribution.
        return patchInvalid(
          `statePatch must be a JSON object of string keys; the strategy returned ` +
            `${describeCause(copy)} — state is the shallow-merge fold of these objects (§9.6)`,
        );
      }
      const patch = deepFreeze(copy) as Readonly<Record<string, unknown>>;
      const state = deepFreeze({ ...this.state, ...patch });
      return {
        ok: true,
        prepared: {
          // D4: prototype-free, like every other value this door emits. An
          // object-literal spread would hand the record back an ordinary
          // container whose absent optional fields answer from
          // `Object.prototype`.
          decision: deepFreeze(
            ownData({ ...decision, [STATE_PATCH_KEY]: patch }) as unknown as DecisionResult,
          ),
          state,
          stateJson: canonicalJsonStringify(state),
        },
      };
    } catch (cause) {
      // The boundary is total, so this is a belt; if it ever fires, the failure
      // belongs to the PATCH, which is what the caller is told.
      return patchInvalid(
        `the statePatch returned by strategy callback ${input.callback} could not be ` +
          `materialized (${describeCause(cause)})`,
      );
    }
  }

  private invokeCallback(input: EvaluationInput, context: StrategyContext): DecisionResult {
    // The captured function — the one validated at creation — applied to the
    // strategy object as its receiver, so `this` still means what a class-based
    // strategy expects while no property is re-read from the caller's object.
    const method = this.strategy.callbacks[input.callback];
    const payload = payloadFor(input);
    const args = payload === undefined ? [context] : [context, payload];
    return Reflect.apply(method, this.strategy.receiver, args) as DecisionResult;
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

    // D4: the containment decision is emitted prototype-free like every other
    // decision this runtime produces, so a consumer's
    // `decision.statePatch ?? …` cannot be answered by `Object.prototype`.
    const decision = ownData({
      decisionType: "skip",
      reasonCodes: [failure.reasonCode],
      featureSnapshotRef: input.features.snapshotRef,
      intents: [],
    }) as unknown as DecisionResult;
    const recordedSeq = this.claimSequence();
    if (recordedSeq === undefined) return this.sequenceExhaustedAfterInvocation(input, rngSnapshot);
    const record = this.buildRecord(input, "RUNTIME", decision, recordedSeq);
    // `CKPT-1`: the same ADR-027 Decision 1 verdict as a decided evaluation,
    // before the persist. The state is unchanged and the RNG was rolled back,
    // but the status becomes PAUSED — a STATUS transition — so a contained
    // evaluation always owes its checkpoint (an instance evaluates only while
    // ACTIVE).
    const transitions = checkpointTransitions(this.lastCheckpoint, {
      callback: input.callback,
      evaluatedAt: input.evaluatedAt,
      stateJson: this.stateJson,
      status: "PAUSED",
      rngState: this.rng.snapshot(),
    });
    try {
      this.persistRecord(record, telemetry);
    } catch (cause) {
      return this.halt("PERSIST_DECISION", record, cause);
    }

    if (this.sequence === undefined) this.evaluationSeq += 1;
    this.status = "PAUSED";

    const saved = this.saveOwedCheckpoint(transitions, recordedSeq, input.evaluatedAt);
    if (!saved.ok) {
      return this.halt("SAVE_CHECKPOINT", record, saved.cause);
    }

    return {
      kind: "CONTAINED",
      record,
      telemetry,
      checkpoint: saved.checkpoint,
      checkpointTransitions: transitions,
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
          `${port} threw (${describeCause(cause)}); ` +
          "instance paused; the write was attempted exactly once and is not retried — " +
          "reconcile against the store's (runId, evaluationSeq) key before resuming",
      },
    };
  }

  private buildRecord(
    input: EvaluationInput,
    attribution: DecisionRecord["attribution"],
    decision: DecisionResult,
    evaluationSeq: number,
  ): DecisionRecord {
    // Every field here comes from the runtime's own inert snapshots: the
    // acquired evaluation input and the captured run identity. Round 3's HIGH
    // was exactly this method re-reading `input.market.marketId` from the
    // caller's live object AFTER the callback had run, which could throw or
    // answer differently than the value the callback saw.
    //
    // D4 (`WP-170-FU1`): the record is emitted PROTOTYPE-FREE. The snapshot's
    // own D4 closed the READ below — `input.sourceEvent` on a prototype-free
    // snapshot answers `undefined` — but the record was still an object
    // LITERAL, and the defeat simply moved into it:
    //
    //     Object.prototype.sourceEvent = { eventId:"018f4a7e-3333-…", … }  (NE)
    //       runtime.evaluate(a valid input carrying NO sourceEvent)
    //       base   → record.sourceEvent = the fabricated event
    //       tip    → record.sourceEvent = undefined
    //
    // The record is what §6 invariant 4's traceability chain IS, so a consumer
    // reading `record.sourceEvent` must get the answer this evaluation had.
    const base = ownData({
      decisionContractVersion: DECISION_RESULT_SCHEMA_VERSION,
      runId: this.run.runId,
      instanceId: this.run.instanceId,
      marketId: input.market.marketId,
      evaluationSeq,
      callback: input.callback satisfies StrategyCallbackName,
      attribution,
      evaluatedAt: input.evaluatedAt,
      decision,
    }) as unknown as DecisionRecord;
    if (input.sourceEvent === undefined) {
      return base;
    }
    return ownData({ ...base, sourceEvent: input.sourceEvent }) as unknown as DecisionRecord;
  }

  private buildCheckpoint(recordedSeq: number): StrategyStateCheckpoint {
    // D4, for the same reason as the record: a checkpoint is read back by
    // `restoreCheckpoint` and by the store that hashes its bytes.
    return ownData({
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
    }) as unknown as StrategyStateCheckpoint;
  }
}

const STATE_PATCH_KEY = "statePatch";

/**
 * Rebuilds a record as an OWN-DATA, PROTOTYPE-FREE object (D1/D4).
 *
 * `Object.defineProperty` with the prototype-free descriptor from
 * `@polymarket-bot/risk/plain-data`, never `out[key] = value`: assignment is
 * `Set` and `Set` consults the chain, and a descriptor written as an object
 * literal is read with `HasProperty` and consults it too. Both were measured
 * against this package at base `53e9f62` — see the transcripts in `json.ts`.
 *
 * The input is always a value this runtime already owns (a materialized tree or
 * a spread of one), so the read below cannot run caller code.
 */
function ownData(source: Record<string, unknown>): Record<string, unknown> {
  const out = Object.create(null) as Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(source)) {
    Object.defineProperty(out, key, ownDataDescriptor(source[key]));
  }
  return out;
}

/**
 * The result of lifting the raw `statePatch` and `modelOutputs` out of a
 * strategy's returned value before anything traverses them. `decision` is what
 * the arena schema validates; `patch` and `modelOutputs` are the untouched
 * values their own boundaries will materialize.
 */
type IsolatedDecision =
  | {
      readonly ok: true;
      readonly decision: unknown;
      readonly patch: unknown;
      readonly modelOutputs: unknown;
    }
  | { readonly ok: false; readonly region: "DECISION" | "PATCH"; readonly problem: string };

/**
 * Reads a returned decision's own enumerable string-keyed properties exactly
 * ONCE and rebuilds them as plain data, holding `statePatch` aside.
 *
 * Two properties matter and neither is incidental:
 *
 * 1. **The patch is never in the object the schema walks.** `z.record` would
 *    enumerate a top-level hostile patch inside the decision region and get it
 *    the wrong attribution (round 4, MEDIUM 2). Attribution must not depend on
 *    how deep inside the same field the hostility sits.
 * 2. **Every property is read once**, so the value the schema validates is the
 *    value the record carries — the round-3 principle applied to the one
 *    caller-supplied object it had not reached yet. `Object.keys` is used
 *    rather than `Reflect.ownKeys` because it is exactly what the strict object
 *    schema itself can see, so the copy neither hides an unrecognized key nor
 *    invents one.
 *
 * TOTAL: every operation on the returned value is guarded, and a failure names
 * the region it belongs to.
 */
function isolateStatePatch(returned: unknown, callback: StrategyCallbackName): IsolatedDecision {
  // `typeof` is the only operation performed before the guard, and it is the
  // only one that cannot run caller code. A non-object cannot carry a patch;
  // the schema below rejects it as the invalid decision it is.
  if (typeof returned !== "object" || returned === null) {
    return { ok: true, decision: returned, patch: undefined, modelOutputs: undefined };
  }
  let keys: readonly string[];
  try {
    keys = Object.keys(returned);
  } catch (cause) {
    return {
      ok: false,
      region: "DECISION",
      problem:
        `enumerating the own keys of the value returned by strategy callback ${callback} threw ` +
        `(${describeCause(cause)}); a decision the runtime cannot read without executing ` +
        "strategy code is not a decision",
    };
  }
  // D1/D4 (`WP-170-FU1`): the isolation copy has NO PROTOTYPE, and the appends
  // below are `defineProperty` with a prototype-free descriptor, so a declared
  // key can be neither lost to nor adopted from an inherited accessor on the
  // way into the copy.
  //
  // DEFENCE IN DEPTH, STATED AS SUCH — measured, not assumed. Reverting this
  // ONE line to `{}` is BEHAVIOURALLY INERT at this tip (mutation M7: the whole
  // suite stays green), because `prepareDecision` MATERIALIZES this copy before
  // anything parses it and it is the materialized tree that `z.strictObject`
  // walks with `for…in`. So the availability defeat measured at base `53e9f62`
  //   Object.prototype.zzUnrelated = 1   (enumerable)
  //     → CONTAINED  RUNTIME.DECISION_INVALID  unrecognized_keys:["zzUnrelated"]
  // is closed by the MATERIALIZATION, not by this line. This line is what makes
  // the claim survive a future refactor that drops the materialization, and it
  // is the reason the copy is safe to hand to that walk in the first place.
  const decision = Object.create(null) as Record<string, unknown>;
  let patch: unknown;
  let modelOutputs: unknown;
  for (const key of keys) {
    let value: unknown;
    try {
      value = (returned as Record<string, unknown>)[key];
    } catch (cause) {
      const isPatch = key === STATE_PATCH_KEY;
      return {
        ok: false,
        region: isPatch ? "PATCH" : "DECISION",
        problem: isPatch
          ? `reading the statePatch returned by strategy callback ${callback} threw ` +
            `(${describeCause(cause)})`
          : `reading ${key} on the value returned by strategy callback ${callback} threw ` +
            `(${describeCause(cause)}); a decision the runtime cannot read without executing ` +
            "strategy code is not a decision",
      };
    }
    if (key === STATE_PATCH_KEY) {
      patch = value;
      continue;
    }
    if (key === MODEL_OUTPUTS_KEY) {
      // Held aside for the same structural reason the patch is, and for one of
      // its own: the arena FAILS CLOSED on the `null` node inside
      // `ModelOutputValueSchema`, so this key cannot travel through the door
      // copy (`parse-door.ts`).
      modelOutputs = value;
      continue;
    }
    // `defineProperty` with a prototype-free descriptor for EVERY key — it used
    // to be `__proto__` alone, with plain assignment for the rest. An own
    // `__proto__` data property must land ON the copy as own data so nothing is
    // re-parented (the library SKIPS that name at every level — it neither
    // refuses nor emits it; the drop is `DECISION_FIELD_NAMES` plus the
    // `dropOwnProtoKey` grammar axis), and every OTHER key needs the same
    // treatment for the reason `json.ts`'s header transcripts C1-C3 record.
    Object.defineProperty(decision, key, ownDataDescriptor(value));
  }
  return { ok: true, decision, patch, modelOutputs };
}

/** The one payload a callback takes beyond its context, if it takes one. */
function payloadFor(input: EvaluationInput): unknown {
  switch (input.callback) {
    case "onFill":
      return input.fill;
    case "onOrderUpdate":
      return input.order;
    case "onMarketClosing":
      return input.secondsRemaining;
    case "onMarketResolved":
      return input.resolution;
    case "onStop":
      return input.reason;
    default:
      return undefined;
  }
}

export type { StrategyInstanceRuntime };
