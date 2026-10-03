/**
 * Shared WP-170 test fixtures. Imported RELATIVELY through each package's own
 * `exports` entry module (the WP-150 precedent for test/unit trees: the root
 * test tree declares no dependency on workspace packages and the root
 * `package.json` is outside WP-170's allowed paths). This is the entry point,
 * not a deep import (F16).
 *
 * Purity of the fixtures themselves: no wall clock, no `Math.random` — time is
 * a manual monotonic counter and randomness only ever comes from the runtime's
 * seeded generator, per the GOV-1C ruling that test files follow the same
 * determinism discipline (dependency-direction §6.1 item 2 applies to
 * purity-restricted packages; this tree simply follows the same pattern).
 */

import type { DecisionResult } from "../../../packages/strategy-sdk/src/index.js";
import type {
  Strategy,
  StrategyContext,
} from "../../../packages/strategy-sdk/src/index.js";
import {
  canonicalJsonStringify,
  createStrategyInstanceRuntime,
  rebuildStateFromPatches,
  type CreateRuntimeResult,
  type DecisionRecord,
  type DecisionTelemetry,
  type EvaluationInput,
  type MonotonicClock,
  type StrategyInstanceRuntime,
  type StrategyRestorePoint,
  type StrategyRuntimeDefinition,
  type StrategyStateCheckpoint,
} from "../../../packages/strategy-runtime/src/index.js";

export const MARKET_ID = "018f4a7e-1111-7abc-8def-0123456789ab";
export const RUN_ID = "run-1";
export const INSTANCE_ID = "instance-1";
export const CONFIG_ID = "config-1";
export const RUN_SEED = "12345";
export const SNAPSHOT_REF = "snap-1";
export const T0 = "2026-01-02T03:04:05.000Z";

/** Manual monotonic clock; time only moves when a test (or a test strategy) advances it. */
export class ManualClock implements MonotonicClock {
  private ns = 1_000_000n;

  nowNs(): bigint {
    return this.ns;
  }

  advanceUs(us: number): void {
    this.ns += BigInt(us) * 1000n;
  }
}

/** Records every persist call; optionally throws on demand. */
export class RecordingSink {
  readonly calls: Array<{ record: DecisionRecord; telemetry: DecisionTelemetry }> = [];
  failNext = false;
  onPersist: (() => void) | undefined;

  persist(record: DecisionRecord, telemetry: DecisionTelemetry): void {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("sink write failed");
    }
    this.calls.push({ record, telemetry });
    this.onPersist?.();
  }
}

/** Records every checkpoint; optionally throws on demand. */
export class RecordingStore {
  readonly checkpoints: StrategyStateCheckpoint[] = [];
  failNext = false;

  save(checkpoint: StrategyStateCheckpoint): void {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("checkpoint write failed");
    }
    this.checkpoints.push(checkpoint);
  }
}

/** A permissive Zod-structural params schema. */
export const passthroughParamsSchema = {
  safeParse: (value: unknown) => ({ success: true as const, data: value }),
};

export function holdDecision(ctx: StrategyContext): DecisionResult {
  return {
    decisionType: "hold",
    reasonCodes: ["TEST.HOLD"],
    featureSnapshotRef: ctx.features().snapshotRef,
    intents: [],
  };
}

/** All nine callbacks default to a persisted no-op hold. */
export function makeStrategy(
  overrides: Partial<Strategy<unknown, unknown>> = {},
): Strategy<unknown, unknown> {
  return {
    name: "test-strategy",
    version: "1.0.0",
    paramsSchema: passthroughParamsSchema,
    stateSchemaVersion: 1,
    onStart: holdDecision,
    onMarketOpen: holdDecision,
    onFeatures: holdDecision,
    onFill: holdDecision,
    onOrderUpdate: holdDecision,
    onTimer: holdDecision,
    onMarketClosing: holdDecision,
    onMarketResolved: holdDecision,
    onStop: holdDecision,
    ...overrides,
  };
}

/** Fresh view objects every call — the runtime freezes them in place. */
export function makeViews() {
  return {
    market: {
      marketId: MARKET_ID,
      conditionId: "0xcondition",
      yesTokenId: "123",
      noTokenId: "456",
      tickSize: "0.01",
      minimumOrderSize: "5",
    },
    books: {
      yes: {
        bids: [{ price: "0.4", shares: "10" }],
        asks: [{ price: "0.6", shares: "5" }],
        asOf: T0,
      },
      no: {
        bids: [{ price: "0.39", shares: "7" }],
        asks: [{ price: "0.61", shares: "3" }],
        asOf: T0,
      },
    },
    features: {
      snapshotRef: SNAPSHOT_REF,
      asOf: T0,
      values: { midpoint: "0.5" },
    },
    position: { yesShares: "0", noShares: "0", asOf: T0 },
    orders: [],
    riskBudget: { availableCollateral: "100", asOf: T0 },
  };
}

export function makeInput(
  callback: EvaluationInput["callback"] = "onFeatures",
  overrides: Record<string, unknown> = {},
): EvaluationInput {
  const base: Record<string, unknown> = {
    callback,
    evaluatedAt: T0,
    ...makeViews(),
  };
  switch (callback) {
    case "onFill":
      base["fill"] = {
        orderId: "order-1",
        marketId: MARKET_ID,
        outcome: "YES",
        side: "BUY",
        price: "0.5",
        shares: "10",
        filledAt: T0,
      };
      break;
    case "onOrderUpdate":
      base["order"] = {
        orderId: "order-1",
        marketId: MARKET_ID,
        outcome: "YES",
        side: "BUY",
        price: "0.5",
        requestedShares: "10",
        filledShares: "4",
        status: "PARTIALLY_FILLED",
        placedAt: T0,
      };
      break;
    case "onMarketClosing":
      base["secondsRemaining"] = 30;
      break;
    case "onMarketResolved":
      base["resolution"] = { marketId: MARKET_ID, outcome: "YES_WIN", resolvedAt: T0 };
      break;
    case "onStop":
      base["reason"] = "operator-stop";
      break;
    default:
      break;
  }
  return { ...base, ...overrides } as unknown as EvaluationInput;
}

export interface Harness {
  runtime: StrategyInstanceRuntime;
  sink: RecordingSink;
  store: RecordingStore;
  clock: ManualClock;
}

export function makeDefinition(
  overrides: Partial<StrategyRuntimeDefinition> = {},
): { definition: StrategyRuntimeDefinition; sink: RecordingSink; store: RecordingStore; clock: ManualClock } {
  const sink = new RecordingSink();
  const store = new RecordingStore();
  const clock = new ManualClock();
  const definition: StrategyRuntimeDefinition = {
    strategy: makeStrategy(),
    params: { edgeThreshold: "0.02" },
    run: { runId: RUN_ID, instanceId: INSTANCE_ID, configId: CONFIG_ID, runSeed: RUN_SEED },
    watchdog: { evaluationBudgetUs: 1000 },
    clock,
    decisionSink: sink,
    checkpointStore: store,
    ...overrides,
  };
  return {
    definition,
    sink: (definition.decisionSink as RecordingSink) ?? sink,
    store: (definition.checkpointStore as RecordingStore) ?? store,
    clock: (definition.clock as ManualClock) ?? clock,
  };
}

/** Creates a runtime, failing the test loudly if creation is refused. */
export function makeHarness(overrides: Partial<StrategyRuntimeDefinition> = {}): Harness {
  const { definition, sink, store, clock } = makeDefinition(overrides);
  const created: CreateRuntimeResult = createStrategyInstanceRuntime(definition);
  if (!created.ok) {
    throw new Error(`runtime creation refused: ${created.refusal.code}: ${created.refusal.detail}`);
  }
  return { runtime: created.runtime, sink, store, clock };
}

/**
 * `CKPT-1` (ADR-027 D2): a restore point for `checkpoint`. The defaults say
 * "this checkpoint follows the LAST durable decision, evaluated at {@link T0}"
 * — which is what every pre-`CKPT-1` restore in this tree assumed, since a
 * checkpoint then followed every decision. A test that restores with later
 * decisions durable passes `highestEvaluationSeq` explicitly.
 */
export function restorePoint(
  checkpoint: StrategyStateCheckpoint,
  highestEvaluationSeq: number = checkpoint.checkpointSeq,
  checkpointEvaluatedAt: string = T0,
): StrategyRestorePoint {
  return { checkpoint, highestEvaluationSeq, checkpointEvaluatedAt };
}

/**
 * `CKPT-1` — an INDEPENDENT oracle for ADR-027 Decision 1, written from the
 * persisted records alone: the `evaluationSeq` of every record that owes a
 * checkpoint. START is the first record; STATE is a record after which the
 * fold of every persisted `statePatch` (`rebuildStateFromPatches`) has bytes
 * other than at the last owed checkpoint; STATUS is a RUNTIME-attributed record
 * (containment pauses) or `onStop` (stops); STOP is `onStop`; HEARTBEAT is
 * 60 s of `evaluatedAt` since the last owed checkpoint's record.
 *
 * PRECONDITION: the strategy draws NO randomness — an RNG draw leaves no trace
 * in a record, which is exactly why ADR-027 D3 makes the decision and its
 * checkpoint durable together rather than relying on a restore to find it.
 */
export function owedCheckpointSeqs(
  calls: ReadonlyArray<{ readonly record: DecisionRecord }>,
): number[] {
  const owed: number[] = [];
  let lastBytes = "";
  let lastAtMs = Number.NaN;
  for (const [index, call] of calls.entries()) {
    const folded = rebuildStateFromPatches(calls.slice(0, index + 1).map((entry) => entry.record.decision.statePatch));
    if (!folded.ok) throw new Error(`the oracle cannot fold the records: ${folded.problem}`);
    const bytes = canonicalJsonStringify(folded.state);
    const atMs = Date.parse(call.record.evaluatedAt);
    const owes =
      index === 0 ||
      bytes !== lastBytes ||
      call.record.attribution === "RUNTIME" ||
      call.record.callback === "onStop" ||
      atMs - lastAtMs >= 60_000;
    if (owes) {
      owed.push(call.record.evaluationSeq);
      lastBytes = bytes;
      lastAtMs = atMs;
    }
  }
  return owed;
}
