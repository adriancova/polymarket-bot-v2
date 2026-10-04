/**
 * `CO2-N1` (ADR-031, option (a), through existing inputs, entries only) — the
 * loop reads its §12.1 clock once per routed PLACEMENT, at admission, and
 * hands two existing §9.8 inputs to the risk engine:
 *
 * - R2/R3: `featuresAgeMs` is the lag, `max(0, processNow − eventNow)`, so
 *   check 7's features row refuses a late ENTRY `RISK_FEATURES_STALE`;
 * - R4: `secondsToClose` is measured from `max(eventNow, processNow)`, so
 *   check 20 refuses an ENTRY the process reaches inside the entry cutoff;
 * - R5: a reading that does not normalise to strict UTC omits the features
 *   measurement (`RISK_FRESHNESS_UNKNOWN`) and leaves seconds-to-close on the
 *   event instant;
 * - R1: the read happens after the decision is durable and before the risk
 *   input is built; a CANCEL reads nothing;
 * - R6: nothing else in the risk input changes.
 *
 * The cases are ADR-031 §7's T2, T3, T5, T7, T8, T9, T10 and T11 at the
 * loop, with the risk input OBSERVED rather than inferred: a pass-through
 * `vi.mock` of `./pipeline.js` records every input document the loop builds
 * and every verdict the REAL risk engine returns, and changes neither. T1, T4
 * and the fixture-level T2, T3, T6 and T10 are in
 * `test/integration/paper-trader/admission-process-clock.test.ts` and
 * `admission-host-clock-postgres.test.ts`.
 *
 * WHAT IS REAL: the `CoreLoop`, the strategy runtime, the feature engine, the
 * books, the allocator, the risk engine, the execution planner, the
 * `SimulatedVenue` (Tier 0) and the ledger. WHAT IS DOUBLED: the loop's clock
 * (a settable clock that counts its `now()` reads; the venue has a clock of
 * its own, so the count is the loop's alone), the store, and the STRATEGY — a
 * scripted double that emits, at named instants, the §7.7 intent shapes the
 * cases need. PAPER only; no network, credential, signer or real order.
 */

import { parseAllocatorCaps } from "@polymarket-bot/capital-allocator";
import type { DecisionResult, EventEnvelope, Intent } from "@polymarket-bot/domain";
import { Ledger } from "@polymarket-bot/ledger";
import { parseRiskPolicy, type RiskEvaluation } from "@polymarket-bot/risk";
import {
  SimulatedVenue,
  readFeeScheduleSnapshot,
  tier0Model,
  unmodeledRateLimits,
  type BookView,
  type FeeScheduleSnapshot,
  type MarketBookProvider,
} from "@polymarket-bot/simulation";
import { createStrategyInstanceRuntime } from "@polymarket-bot/strategy-runtime";
import type { Strategy, StrategyContext } from "@polymarket-bot/strategy-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type * as Pipeline from "./pipeline.js";

/**
 * The ONE seam observed: every risk input document the loop builds, with the
 * context it was built from, and every verdict the real engine returned. Both
 * functions run unchanged (`original`), so nothing the loop decides differs.
 */
const seam = vi.hoisted(() => ({
  inputs: [] as { readonly context: Readonly<Record<string, unknown>>; readonly document: unknown }[],
  verdicts: [] as unknown[],
}));

vi.mock("./pipeline.js", async (importOriginal) => {
  const original = await importOriginal<typeof Pipeline>();
  return {
    ...original,
    buildRiskEvaluationInput(context: Parameters<typeof original.buildRiskEvaluationInput>[0]) {
      const document = original.buildRiskEvaluationInput(context);
      seam.inputs.push({ context: { ...context }, document });
      return document;
    },
    runRiskCheck(policy: Parameters<typeof original.runRiskCheck>[0], input: unknown) {
      const verdict = original.runRiskCheck(policy, input);
      seam.verdicts.push(verdict);
      return verdict;
    },
  };
});

import { DeterministicIdFactory, type PostingIdentity } from "./accounting.js";
import { AllocatorGate, allocationMarketOf, type AllocationMarket } from "./allocation.js";
import { configuredFeatureKeys, parseTraderConfig } from "./config.js";
import { EVERY_FILL_ACCOUNTING_CHECKS } from "./folds.js";
import { HaltController } from "./halt.js";
import { HealthState } from "./health.js";
import { InstanceRegistry } from "./instances.js";
import { CoreLoop, DecisionOutboxBuffer, type TraderVenue } from "./loop.js";
import { MarketState } from "./market-state.js";
import { portOk, type Clock, type GroupCommit, type IngestedEvent, type StagedEvaluations, type TraderStore } from "./ports.js";
import { REPOSITORY_MAXIMUM_RUN_MODE, TRADER_RUN_MODE } from "./safety.js";
import { ManualClock, MemoryTraderStore } from "./testing/index.js";

const MARKET_ID = "018f5c20-1000-7a10-8b00-0000000003c1";
const OTHER_MARKET_ID = "018f5c20-1000-7a10-8b00-0000000003c9";
const CONDITION_ID = "0xco2n1admission";
const YES_TOKEN = "9301";
const NO_TOKEN = "9302";
const OTHER_TOKEN = "9309";
const INSTANCE_ID = "e18f5c20-2000-7a20-8b00-0000000003c2";
const RUN_ID = "018f5c20-3000-7a30-8b00-0000000003c3";
const CONFIG_ID = "018f5c20-4000-7a40-8b00-0000000003c4";
const GATEWAY_EPOCH = "018f5c20-5000-7a50-8b00-0000000003c5";
const T_OPEN = "2026-05-01T09:00:00.000Z";
const T_OPEN_MS = Date.parse(T_OPEN);
const MINUTE_MS = 60_000;
/** The default close: ten minutes after the open. */
const T_CLOSE = "2026-05-01T09:10:00.000Z";
const T_CLOSE_MS = Date.parse(T_CLOSE);

/** An instant `ms` milliseconds after the open, as the gateway stamps it. */
function iso(ms: number): string {
  return new Date(T_OPEN_MS + ms).toISOString();
}

// ---------------------------------------------------------------------------
// The clock
// ---------------------------------------------------------------------------

/**
 * The loop's §12.1 clock: it answers whatever reading the test set — a
 * readable instant, or a string that is not one — and COUNTS every `now()`
 * call. Monotonic time is not read by admission and stays at zero.
 */
class CountingClock implements Clock {
  #reading: string;
  reads = 0;

  constructor(reading: string) {
    this.#reading = reading;
  }

  now(): string {
    this.reads += 1;
    return this.#reading;
  }

  monotonicNs(): bigint {
    return 0n;
  }

  set(reading: string): void {
    this.#reading = reading;
  }
}

// ---------------------------------------------------------------------------
// The configuration
// ---------------------------------------------------------------------------

interface Options {
  readonly featuresMaxAgeMs?: number;
  readonly entryCutoffSeconds?: number;
  readonly closeTime?: string;
  /** ADR-023's block; absent: `LAST_CHANGE`, which reads no clock for a book. */
  readonly basis?: "LAST_CHANGE" | "CONNECTION_CONFIRMED";
  readonly store?: TraderStore;
}

function feeSnapshot(): FeeScheduleSnapshot {
  return {
    snapshotVersion: "co2n1.sim.2026-05-01",
    takerFeeRate: "0",
    makerFeeRate: "0",
    roundingDecimalPlaces: 3,
    roundingMode: "HALF_UP",
    minimumChargedFee: "0",
    feeCurrency: "pUSD",
  };
}

function traderConfig(options: Options): Record<string, unknown> {
  const fees = feeSnapshot();
  return {
    environment: "PAPER",
    riskPolicy: {
      freshness: {
        venueBookMaxAgeMs: 600_000,
        referenceFeedMaxAgeMs: 600_000,
        // The shipped example's bound (`trader.config.example.json`).
        featuresMaxAgeMs: options.featuresMaxAgeMs ?? 2_000,
      },
      limits: { maxWorstCaseContractualLoss: "1000" },
      scenario: { maxScenarioLoss: "1000" },
      economics: {},
      participation: {},
      rateLimit: { safetyReserveRequests: 0 },
      timeToClose: { entryCutoffSeconds: options.entryCutoffSeconds ?? 30 },
    },
    allocatorCaps: {
      globalAccountCap: "10000",
      perStrategyCap: "1000",
      liveMicroMaxOrderNotional: "0",
      liveMicroMaxAccountExposure: "0",
    },
    accounting: {
      accountRef: "co2n1-paper-account",
      denominationAssetId: "pUSD",
      venueClearingRef: "co2n1-venue-clearing",
      attributionClearingRef: "co2n1-attribution-clearing",
      feeExpenseRef: "co2n1-fee-expense",
      startingCash: "1000",
    },
    queues: { ingestMaximumDepth: 1024, outboxMaximumDepth: 1024 },
    features: {
      depthLevels: [1, 2, 5],
      executableShares: ["50"],
      tradeWindowMs: 60_000,
      ewmaLambda: "0.94",
      primaryReferenceVenue: "binance",
    },
    planning: {
      maxSliceShares: "100",
      marketableSlippageTicks: 2,
      replaceThresholdTicks: 1,
      minimumReplaceIntervalMs: 500,
      cancelDeadlineMs: 5_000,
      maxPlanLifetimeMs: 30_000,
    },
    simulation: {
      fillModelVersion: "tier0.co2n1",
      fillModelParametersHash: "f".repeat(64),
      feeSchedule: { ...fees },
      startingCash: "1000",
    },
    requestBudget: { capacity: 1_000_000, windowMs: 60_000 },
    scenarios: [
      { scenarioId: "spot.down", kind: "SPOT", yesPriceShock: "-0.1" },
      { scenarioId: "vol.up", kind: "VOLATILITY", yesPriceShock: "-0.05" },
      { scenarioId: "time.decay", kind: "TIME", yesPriceShock: "-0.02" },
      { scenarioId: "liq.thin", kind: "LIQUIDITY", yesPriceShock: "-0.03" },
    ],
    ...(options.basis === undefined
      ? {}
      : {
          bookFreshness:
            options.basis === "CONNECTION_CONFIRMED"
              ? { basis: options.basis, maximumLastChangeAgeMs: 30_000 }
              : { basis: options.basis },
        }),
    infrastructure: {
      eventStream: "polymarket.normalized",
      consumerId: "co2-n1-admission",
      receiveBatchSize: 128,
      retentionMaxEvents: 100_000,
    },
    markets: [
      {
        marketId: MARKET_ID,
        conditionId: CONDITION_ID,
        yesTokenId: YES_TOKEN,
        noTokenId: NO_TOKEN,
        tickSize: "0.01",
        minimumOrderSize: "5",
        makerFeeRate: fees.makerFeeRate,
        takerFeeRate: fees.takerFeeRate,
        parametersVersion: 1,
        settlementReadiness: { modelDependentActivationAllowed: true },
        openTime: T_OPEN,
        closeTime: options.closeTime ?? T_CLOSE,
        seriesKey: "co2n1-admission-sim",
        underlyingKey: "SIMBTC",
        resolutionWindowKey: "w2026-05-01T09.10",
      },
    ],
    instances: [
      {
        instanceId: INSTANCE_ID,
        runId: RUN_ID,
        configId: CONFIG_ID,
        runSeed: "31",
        marketId: MARKET_ID,
        ownership: "OWNER",
        evaluationPriority: 0,
        evaluationBudgetUs: 5_000_000,
        params: {},
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// The scripted strategy, and the intents it emits
// ---------------------------------------------------------------------------

/** What the strategy emits at an `onFeatures` evaluation; an empty list holds. */
type Script = (ctx: StrategyContext) => readonly Intent[];

function hold(ctx: StrategyContext): DecisionResult {
  return { decisionType: "hold", reasonCodes: ["CO2N1.HOLD"], featureSnapshotRef: ctx.features().snapshotRef, intents: [] };
}

function scriptedStrategy(script: Script): Strategy<unknown, Record<string, never>> {
  return {
    name: "co2-n1-scripted-double",
    version: "1.0.0",
    paramsSchema: z.strictObject({}),
    stateSchemaVersion: 1,
    onStart: hold,
    onMarketOpen: hold,
    onTimer: hold,
    onFill: hold,
    onOrderUpdate: hold,
    onMarketClosing: hold,
    onMarketResolved: hold,
    onStop: hold,
    onFeatures(ctx: StrategyContext): DecisionResult {
      const intents = script(ctx);
      if (intents.length === 0) return hold(ctx);
      const first = intents[0];
      return {
        decisionType: first?.type === "CANCEL" ? "cancel" : first?.type === "POSITION" && first.targetShares.startsWith("-") ? "exit" : "enter",
        reasonCodes: ["CO2N1.SCRIPTED"],
        featureSnapshotRef: ctx.features().snapshotRef,
        intents: [...intents],
      };
    },
  };
}

/** A direct-leg BUY of 10 YES shares, marketable (FAK) into the 0.34 ask: an ENTRY. */
function entryIntent(ctx: StrategyContext, intentId: string): Intent {
  return {
    type: "POSITION",
    intentId,
    marketId: MARKET_ID,
    direction: "YES",
    targetMode: "DELTA",
    targetShares: "10",
    maximumBuyPrice: "0.35",
    maximumTotalCost: "4",
    urgency: "IMMEDIATE",
    liquidityPreference: "TAKER_OK",
    partialFillPolicy: "ACCEPT_ANY",
    validUntil: new Date(Date.parse(ctx.now()) + 60 * MINUTE_MS).toISOString(),
    expectedNetEdge: "5",
    tags: ["co2n1.entry", "sb.order-type:FAK"],
  };
}

/** A protective, fully covered SELL of the 10 YES shares the entry bought: an EXIT. */
function exitIntent(ctx: StrategyContext, intentId: string): Intent {
  return {
    type: "POSITION",
    intentId,
    marketId: MARKET_ID,
    direction: "YES",
    targetMode: "DELTA",
    targetShares: "-10",
    minimumSellPrice: "0.3",
    urgency: "AGGRESSIVE",
    liquidityPreference: "TAKER_OK",
    partialFillPolicy: "ACCEPT_ANY",
    validUntil: new Date(Date.parse(ctx.now()) + 60 * MINUTE_MS).toISOString(),
    tags: ["co2n1.exit", "sb.order-type:FAK"],
  };
}

const MARKET_CANCEL: Intent = { type: "CANCEL", marketId: MARKET_ID, reason: "co2-n1: a safety cancellation" };

/** Emits `intents` at the evaluation whose instant is `atMs` after the open, and holds otherwise. */
function at(schedule: ReadonlyMap<number, (ctx: StrategyContext) => readonly Intent[]>): Script {
  return (ctx) => schedule.get(Date.parse(ctx.now()) - T_OPEN_MS)?.(ctx) ?? [];
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

interface Session {
  readonly connectionId: string;
  readonly generation: number;
}

const A1: Session = { connectionId: "polymarket-market-a1", generation: 1 };

interface Recorded {
  readonly eventType: string;
  readonly payload: unknown;
  /** Milliseconds after the open. */
  readonly atMs: number;
  readonly source?: "polymarket" | "binance";
  readonly session?: Session;
}

let ordinal = 0;
/** Fixes the previous harness's last admission (see `assemble`). */
let sealPreviousHarness: (() => void) | undefined;

function ingested(recorded: Recorded): IngestedEvent {
  ordinal += 1;
  const receivedAt = iso(recorded.atMs);
  const envelope: EventEnvelope<unknown> = {
    eventId: `018f5c20-9000-7a90-8b00-${String(ordinal).padStart(12, "0")}`,
    eventType: recorded.eventType,
    schemaVersion: 1,
    source: recorded.source ?? "polymarket",
    sourceChannel: "polymarket:market-ws",
    receivedAt,
    receivedMonotonicNs: String(ordinal * 1_000_000),
    gatewayEpoch: GATEWAY_EPOCH,
    ingestSeq: String(ordinal),
    ...(recorded.session === undefined
      ? { subscriptionGeneration: 1 }
      : { connectionId: recorded.session.connectionId, subscriptionGeneration: recorded.session.generation }),
    payload: recorded.payload,
  };
  return {
    envelope,
    identity: { gatewayEpoch: GATEWAY_EPOCH, ingestSeq: String(ordinal), receivedAt, datasetRowOrdinal: ordinal },
  };
}

function tick(atMs: number): Recorded {
  return {
    eventType: "ReferenceTradeObserved",
    payload: { venue: "binance", symbol: "BTCUSDT", price: "64000", size: "0.5" },
    atMs,
    source: "binance",
  };
}

function opened(atMs: number): Recorded {
  return { eventType: "MarketOpened", payload: { internalMarketId: MARKET_ID, conditionId: CONDITION_ID, openedAt: T_OPEN }, atMs };
}

function yesBook(atMs: number, session?: Session): Recorded {
  return {
    eventType: "BookSnapshot",
    payload: {
      internalMarketId: MARKET_ID,
      tokenId: YES_TOKEN,
      bids: [{ price: "0.32", size: "5000" }],
      asks: [{ price: "0.34", size: "5000" }],
    },
    atMs,
    ...(session === undefined ? {} : { session }),
  };
}

function noBook(atMs: number, session?: Session): Recorded {
  return {
    eventType: "BookSnapshot",
    payload: {
      internalMarketId: MARKET_ID,
      tokenId: NO_TOKEN,
      bids: [{ price: "0.65", size: "5000" }],
      asks: [{ price: "0.66", size: "5000" }],
    },
    atMs,
    ...(session === undefined ? {} : { session }),
  };
}

function otherMarketBook(atMs: number, session: Session): Recorded {
  return {
    eventType: "BookSnapshot",
    payload: {
      internalMarketId: OTHER_MARKET_ID,
      tokenId: OTHER_TOKEN,
      bids: [{ price: "0.1", size: "10" }],
      asks: [{ price: "0.9", size: "10" }],
    },
    atMs,
    session,
  };
}

/** The market's opening: a reference print, the opening, both books. Evaluations follow at 1 s steps. */
function opening(): Recorded[] {
  return [tick(-1_000), opened(0), noBook(200), yesBook(400)];
}

/** A YES book re-sent at `atMs`: one more evaluation of the market, the book unchanged. */
function evaluationAt(atMs: number): Recorded {
  return yesBook(atMs);
}

// ---------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------

interface Admission {
  /** The `RiskInputContext` the loop handed `buildRiskEvaluationInput` (shallow copy). */
  readonly context: Readonly<Record<string, unknown>>;
  /** The §9.8 input document that context produced. */
  readonly document: RiskDocument;
  /** The REAL risk engine's verdict on it. */
  readonly verdict: RiskEvaluation;
}

interface RiskDocument {
  readonly intent: Intent;
  readonly evaluatedAt: string;
  readonly markets: readonly { readonly secondsToClose?: number }[];
  readonly freshness: readonly { readonly feed: string; readonly ageMs: number; readonly marketId?: string }[];
  readonly rateLimit: { readonly availableRequests?: number };
}

interface Harness {
  readonly loop: CoreLoop;
  readonly clock: CountingClock;
  readonly venue: SimulatedVenue;
  readonly submitted: unknown[];
  /** Runs as the loop hands the venue a plan, before the venue sees it. */
  beforeSubmit: (() => void) | undefined;
  /** Every admission the loop made since this harness was built, in order. */
  admissions(): readonly Admission[];
}

function assemble(script: Script, options: Options = {}): Harness {
  ordinal = 0;
  const parsed = parseTraderConfig(traderConfig(options));
  if (!parsed.ok) throw new Error(`config refused: ${parsed.refusal.detail} ${parsed.refusal.issues.join("; ")}`);
  const config = parsed.config;
  const policy = parseRiskPolicy(config.riskPolicy);
  if (!policy.ok) throw new Error("risk policy refused");
  const caps = parseAllocatorCaps(config.allocatorCaps);
  if (!caps.ok) throw new Error("allocator caps refused");
  // The loop's clock starts at the open; every case positions it per event.
  const clock = new CountingClock(T_OPEN);
  // The venue's OWN clock, so every `now()` the counting clock answers is the loop's.
  const venueClock = new ManualClock(T_OPEN);
  const markets = new Map<string, MarketState>();
  const tokenAssetIds = new Map<string, string>();
  const allocationMarkets = new Map<string, AllocationMarket>();
  for (const market of config.markets) {
    markets.set(market.marketId, new MarketState({ config: market, tradeWindowMs: config.features.tradeWindowMs, maximumTrades: 512 }));
    tokenAssetIds.set(`${market.marketId}|YES`, `token:${market.yesTokenId}`);
    tokenAssetIds.set(`${market.marketId}|NO`, `token:${market.noTokenId}`);
    allocationMarkets.set(market.marketId, allocationMarketOf(market));
  }
  const outbox = new DecisionOutboxBuffer(config.queues.outboxMaximumDepth);
  const created = createStrategyInstanceRuntime({
    strategy: scriptedStrategy(script),
    params: {},
    run: { runId: RUN_ID, instanceId: INSTANCE_ID, configId: CONFIG_ID, runSeed: "31" },
    watchdog: { evaluationBudgetUs: 5_000_000 },
    clock: { nowNs: () => venueClock.monotonicNs() },
    decisionSink: { persist: (record, telemetry) => outbox.appendDecision(record, telemetry) },
    checkpointStore: { save: (checkpoint) => outbox.appendCheckpoint(checkpoint) },
  });
  if (!created.ok) throw new Error(`runtime refused: ${created.refusal.detail}`);
  const registry = new InstanceRegistry();
  const registered = registry.register({
    instanceId: INSTANCE_ID,
    runId: RUN_ID,
    configId: CONFIG_ID,
    marketId: MARKET_ID,
    ownership: "OWNER",
    evaluationPriority: 0,
    runtime: created.runtime,
    direction: "YES",
    params: {},
    immediateOrderType: "FAK",
    submissionUnknownAfterMs: 5_000,
  });
  if (!registered.ok) throw new Error(registered.detail);

  const fees = readFeeScheduleSnapshot(feeSnapshot());
  if (!fees.ok) throw new Error("fees refused");
  const wiring: { loop: CoreLoop | undefined } = { loop: undefined };
  const books: MarketBookProvider = {
    book(request): BookView | undefined {
      const market = markets.get(request.marketId);
      if (market === undefined) return undefined;
      return {
        internalMarketId: request.marketId,
        tokenId: request.side === "YES" ? market.config.yesTokenId : market.config.noTokenId,
        top() {
          const top = market.bookFor(request.side).topOfBook();
          return {
            ...(top.bestBidPrice === undefined ? {} : { bestBidPrice: top.bestBidPrice }),
            ...(top.bestBidSize === undefined ? {} : { bestBidSize: top.bestBidSize }),
            ...(top.bestAskPrice === undefined ? {} : { bestAskPrice: top.bestAskPrice }),
            ...(top.bestAskSize === undefined ? {} : { bestAskSize: top.bestAskSize }),
            ...(top.spread === undefined ? {} : { spread: top.spread }),
          };
        },
        ladder(side) {
          return market.bookFor(request.side).levels(side).map((level) => ({ price: level.price, size: level.size }));
        },
      };
    },
  };
  const venue = new SimulatedVenue({
    clock: venueClock,
    runMode: "PAPER",
    model: tier0Model({ fillModelVersion: "tier0.co2n1", fillModelParametersHash: "f".repeat(64) }),
    feeSnapshot: fees.value,
    rateLimits: unmodeledRateLimits("no venue rate-limit budget is modelled in this unit test"),
    policy: {
      timeInForceFor(order: { readonly plannedOrderId: string }) {
        const resolved = wiring.loop?.timeInForceFor(order.plannedOrderId);
        if (resolved === undefined) throw new Error(`no time-in-force for ${order.plannedOrderId}`);
        return resolved;
      },
      statedExpiryNsFor: () => undefined,
      sameInstantAdditionsFor: () => "NOT_OBSERVED" as const,
    },
    startingCash: "1000",
    books,
  });
  const posting: PostingIdentity = {
    environment: config.environment,
    accountRef: config.accounting.accountRef,
    denominationAssetId: config.accounting.denominationAssetId,
    venueClearingRef: config.accounting.venueClearingRef,
    attributionClearingRef: config.accounting.attributionClearingRef,
    feeExpenseRef: config.accounting.feeExpenseRef,
  };
  const traderVenue: TraderVenue = venue;
  const loop = new CoreLoop({
    config,
    riskPolicy: policy.value,
    allocator: new AllocatorGate({ caps: caps.value, markets: allocationMarkets, tokenAssetIds }),
    clock,
    venue: traderVenue,
    store: options.store ?? new MemoryTraderStore(),
    registry,
    markets,
    instanceConfigs: new Map(),
    ledger: Ledger.empty(config.environment),
    ids: new DeterministicIdFactory("co2-n1-admission"),
    health: new HealthState({ runMode: TRADER_RUN_MODE, maximumRunMode: REPOSITORY_MAXIMUM_RUN_MODE }),
    halts: new HaltController(),
    featureKeys: configuredFeatureKeys(config),
    posting,
    tokenAssetIds,
    outbox,
    accountingChecks: EVERY_FILL_ACCOUNTING_CHECKS,
  });
  wiring.loop = loop;

  // A harness's admissions are the seam's records from its creation until the
  // NEXT harness is created (the cases run their harnesses one after another).
  sealPreviousHarness?.();
  const from = seam.inputs.length;
  expect(seam.verdicts.length, "the seam records an input and a verdict per admission").toBe(from);
  let to: number | undefined;
  sealPreviousHarness = () => {
    to = seam.inputs.length;
  };
  const submitted: unknown[] = [];
  const hooks: { beforeSubmit: (() => void) | undefined } = { beforeSubmit: undefined };
  const submit = traderVenue.submit.bind(traderVenue);
  vi.spyOn(traderVenue, "submit").mockImplementation(async (plan: unknown) => {
    submitted.push(plan);
    hooks.beforeSubmit?.();
    return await submit(plan as Parameters<SimulatedVenue["submit"]>[0]);
  });
  // The venue's clock follows the events (it never reads the loop's).
  const observe = venue.observe.bind(venue);
  vi.spyOn(venue, "observe").mockImplementation((identity) => {
    venueClock.positionAt(identity.receivedAt, BigInt(identity.datasetRowOrdinal) * 1_000_000n);
    return observe(identity);
  });
  return {
    loop,
    clock,
    venue,
    submitted,
    get beforeSubmit() {
      return hooks.beforeSubmit;
    },
    set beforeSubmit(hook: (() => void) | undefined) {
      hooks.beforeSubmit = hook;
    },
    admissions(): readonly Admission[] {
      return seam.inputs.slice(from, to).map((input, index) => ({
        context: input.context,
        document: input.document as RiskDocument,
        verdict: seam.verdicts[from + index] as RiskEvaluation,
      }));
    },
  };
}

/** How the loop's clock reads while one event is processed: the event's instant in ms → the reading. */
type ClockPlan = (eventMs: number) => string;

/** Positioned at each event's instant plus `lagMs` (lag 0: the replay clock). */
function lagging(lagMs: number): ClockPlan {
  return (eventMs) => new Date(eventMs + lagMs).toISOString();
}

/** One instant for every event. */
function fixedAt(instant: string): ClockPlan {
  return () => instant;
}

async function drive(harness: Harness, events: readonly Recorded[], plan: ClockPlan): Promise<void> {
  for (const recorded of events) {
    const event = ingested(recorded);
    harness.clock.set(plan(Date.parse(event.envelope.receivedAt)));
    if (!harness.loop.ingest(event)) throw new Error(`ingest refused ${event.envelope.eventType}`);
    await harness.loop.drain();
  }
}

function codes(admission: Admission | undefined): readonly string[] {
  if (admission === undefined) throw new Error("no admission was recorded");
  return admission.verdict.approved ? [] : admission.verdict.refusals.map((refusal) => refusal.code);
}

function featuresAge(admission: Admission | undefined): number | undefined {
  return admission?.document.freshness.find((observation) => observation.feed === "FEATURES")?.ageMs;
}

function secondsToClose(admission: Admission | undefined): number | undefined {
  return admission?.document.markets[0]?.secondsToClose;
}

function bookAge(admission: Admission | undefined): number | undefined {
  return admission?.document.freshness.find((observation) => observation.feed === "VENUE_BOOK")?.ageMs;
}

/** The input document with the two ADR-031 measurements removed: R6 says the rest is unchanged. */
function withoutAdmissionMeasurements(document: RiskDocument): unknown {
  return {
    ...document,
    markets: document.markets.map((market) => Object.fromEntries(Object.entries(market).filter(([key]) => key !== "secondsToClose"))),
    freshness: document.freshness.filter((observation) => observation.feed !== "FEATURES"),
  };
}

/** A verdict without its freshness assessment — what the engine DECIDED, not what it measured. */
function judgement(verdict: RiskEvaluation): unknown {
  return Object.fromEntries(Object.entries(verdict).filter(([key]) => key !== "freshness"));
}

function planKinds(harness: Harness): readonly string[] {
  return harness.submitted.map((plan) => (plan as { readonly planKind: string }).planKind);
}

afterEach(() => {
  vi.restoreAllMocks();
});

const ENTRY_AT_MS = 1_400;
const EXIT_AT_MS = 2_400;
const oneEntry = (): Script => at(new Map([[ENTRY_AT_MS, (ctx: StrategyContext) => [entryIntent(ctx, "co2n1-entry-1")]]]));

// ---------------------------------------------------------------------------
// R1-R6: the two measurements, exactly, and nothing else
// ---------------------------------------------------------------------------

describe("ADR-031 R1-R6: a placement's admission reads the process clock once and changes two inputs only", () => {
  it("lag 1 234 ms: featuresAgeMs is 1 234; secondsToClose counts from the process instant; every other input equals the lag-0 run's", async () => {
    // The close is 100.5 s after the entry's event, so the floor moves: 100 s
    // from the event instant, 99 s from the process instant 1.234 s later.
    const closeTime = iso(ENTRY_AT_MS + 100_500);
    const lagged = assemble(oneEntry(), { closeTime });
    await drive(lagged, [...opening(), evaluationAt(ENTRY_AT_MS)], lagging(1_234));
    const replay = assemble(oneEntry(), { closeTime });
    await drive(replay, [...opening(), evaluationAt(ENTRY_AT_MS)], lagging(0));

    const [late] = lagged.admissions();
    const [onTime] = replay.admissions();
    expect(lagged.admissions()).toHaveLength(1);
    expect(featuresAge(late)).toBe(1_234);
    expect(secondsToClose(late)).toBe(99);
    expect(featuresAge(onTime)).toBe(0);
    expect(secondsToClose(onTime)).toBe(100);
    // R6: `evaluatedAt`, the book and reference ages, the request budget, the
    // intent, the portfolio, the allocator's verdict — all identical.
    expect(late?.document.evaluatedAt).toBe(iso(ENTRY_AT_MS));
    expect(withoutAdmissionMeasurements(late?.document as RiskDocument)).toEqual(
      withoutAdmissionMeasurements(onTime?.document as RiskDocument),
    );
    // Both admitted (1 234 ms is inside a 2 000 ms bound), with the same record.
    expect(late?.verdict.approved).toBe(true);
    expect(judgement(late?.verdict as RiskEvaluation)).toEqual(judgement(onTime?.verdict as RiskEvaluation));
  });

  it("the read comes AFTER the decision is durable: the instant it reads is the one the clock shows once the store answered", async () => {
    // A store whose decision write moves the clock 5 s ahead before it answers:
    // the lag the guard measures includes the time the write took (R1).
    const inner = new MemoryTraderStore();
    const wired: { clock?: CountingClock } = {};
    const store: TraderStore = {
      persistDecision: async (record, telemetry) => {
        if (record.decision.intents.length > 0) wired.clock?.set(iso(ENTRY_AT_MS + 5_000));
        return await inner.persistDecision(record, telemetry);
      },
      // `CKPT-1`: a decision that owes a checkpoint is written with it, so the
      // same clock move applies to the paired write.
      persistDecisionWithCheckpoint: async (record, telemetry, checkpoint, capturedAt) => {
        if (record.decision.intents.length > 0) wired.clock?.set(iso(ENTRY_AT_MS + 5_000));
        return await inner.persistDecisionWithCheckpoint(record, telemetry, checkpoint, capturedAt);
      },
      appendLedgerTransaction: (transaction) => inner.appendLedgerTransaction(transaction),
      writePnlSnapshot: (snapshot) => inner.writePnlSnapshot(snapshot),
      replacePnlSnapshot: (snapshot) => inner.replacePnlSnapshot(snapshot),
      persistRiskRefusal: (refusal) => inner.persistRiskRefusal(refusal),
      close: () => inner.close(),
    };
    const harness = assemble(oneEntry(), { store });
    wired.clock = harness.clock;
    await drive(harness, [...opening(), evaluationAt(ENTRY_AT_MS)], lagging(0));
    const [entry] = harness.admissions();
    expect(featuresAge(entry)).toBe(5_000);
    expect(codes(entry)).toEqual(["RISK_FEATURES_STALE"]);
    expect(harness.submitted).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// T2: the close criterion alone
// ---------------------------------------------------------------------------

describe("ADR-031 T2: the close criterion alone (lag inside the bound, the event instant outside the cutoff)", () => {
  // The entry's event is 120 s before the close; the cutoff is 30 s; the lag
  // bound is 600 000 ms, so a process instant 90 s late is still inside it.
  const closeTime = iso(ENTRY_AT_MS + 120_000);
  const options = { closeTime, featuresMaxAgeMs: 600_000 };

  it("process instant at exactly close − entryCutoffSeconds: refused, RISK_TIME_TO_CLOSE_ENTRY_BLOCKED only", async () => {
    const harness = assemble(oneEntry(), options);
    await drive(harness, opening(), lagging(0));
    await drive(harness, [evaluationAt(ENTRY_AT_MS)], fixedAt(iso(ENTRY_AT_MS + 120_000 - 30_000)));
    const [entry] = harness.admissions();
    expect(secondsToClose(entry)).toBe(30);
    expect(featuresAge(entry)).toBe(90_000);
    expect(codes(entry)).toEqual(["RISK_TIME_TO_CLOSE_ENTRY_BLOCKED"]);
    expect(harness.submitted).toEqual([]);
    expect(harness.loop.health().risk.refusalsByCode).toEqual({ RISK_TIME_TO_CLOSE_ENTRY_BLOCKED: 1 });
  });

  it("process instant at close − (entryCutoffSeconds + 1) s: approved, every other check passing, and filled", async () => {
    const harness = assemble(oneEntry(), options);
    await drive(harness, opening(), lagging(0));
    await drive(harness, [evaluationAt(ENTRY_AT_MS)], fixedAt(iso(ENTRY_AT_MS + 120_000 - 31_000)));
    const [entry] = harness.admissions();
    expect(secondsToClose(entry)).toBe(31);
    expect(entry?.verdict.approved).toBe(true);
    expect(planKinds(harness)).toEqual(["POSITION"]);
    expect(harness.venue.fills).toHaveLength(1);
  });

  it("the same entry with the clock at its event instant: 120 s to close, approved — the event instant alone is outside the cutoff", async () => {
    const harness = assemble(oneEntry(), options);
    await drive(harness, [...opening(), evaluationAt(ENTRY_AT_MS)], lagging(0));
    const [entry] = harness.admissions();
    expect(secondsToClose(entry)).toBe(120);
    expect(entry?.verdict.approved).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T3: a lagging trader
// ---------------------------------------------------------------------------

describe("ADR-031 T3: a lagging trader — the clock at each event's instant plus L", () => {
  it("L equal to the bound (2 000 ms): approved", async () => {
    const harness = assemble(oneEntry());
    await drive(harness, [...opening(), evaluationAt(ENTRY_AT_MS)], lagging(2_000));
    const [entry] = harness.admissions();
    expect(featuresAge(entry)).toBe(2_000);
    expect(entry?.verdict.approved).toBe(true);
    expect(harness.venue.fills).toHaveLength(1);
  });

  it("L one millisecond above the bound: refused, RISK_FEATURES_STALE only", async () => {
    const harness = assemble(oneEntry());
    await drive(harness, [...opening(), evaluationAt(ENTRY_AT_MS)], lagging(2_001));
    const [entry] = harness.admissions();
    expect(featuresAge(entry)).toBe(2_001);
    expect(codes(entry)).toEqual(["RISK_FEATURES_STALE"]);
    expect(harness.submitted).toEqual([]);
    expect(harness.venue.fills).toHaveLength(0);
  });

  it("a backlog whose lag falls below the bound: refused while above it, then approved at the FIRST entry below it — nothing latches", async () => {
    // One entry intent per evaluation, each its own id; the process clock
    // catches up on the stream: lags 9 000, 4 000, 2 001, 2 000, 500 ms.
    const instants = [1_400, 2_400, 3_400, 4_400, 5_400];
    const lags = new Map([
      [1_400, 9_000],
      [2_400, 4_000],
      [3_400, 2_001],
      [4_400, 2_000],
      [5_400, 500],
    ]);
    const harness = assemble(
      at(new Map(instants.map((ms) => [ms, (ctx: StrategyContext) => [entryIntent(ctx, `co2n1-backlog-${String(ms)}`)]]))),
    );
    await drive(harness, opening(), lagging(0));
    await drive(
      harness,
      instants.map((ms) => evaluationAt(ms)),
      (eventMs) => new Date(eventMs + (lags.get(eventMs - T_OPEN_MS) ?? 0)).toISOString(),
    );
    const admissions = harness.admissions();
    expect(admissions.map((admission) => featuresAge(admission))).toEqual([9_000, 4_000, 2_001, 2_000, 500]);
    expect(admissions.map((admission) => codes(admission))).toEqual([
      ["RISK_FEATURES_STALE"],
      ["RISK_FEATURES_STALE"],
      ["RISK_FEATURES_STALE"],
      [],
      [],
    ]);
    expect(harness.loop.health().risk).toMatchObject({ approvals: 2, refusals: 3, refusalsByCode: { RISK_FEATURES_STALE: 3 } });
    expect(harness.venue.fills).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// T5: exits and cancels under lag
// ---------------------------------------------------------------------------

describe("ADR-031 T5 (Q2, as ruled): an EXIT and a CANCEL under lag are judged exactly as at lag 0", () => {
  // The position is opened at lag 0; then the clock runs 30 minutes ahead of
  // the stream, and ONE decision routes a CANCEL and a protective covered SELL.
  const schedule = (): Script =>
    at(
      new Map<number, (ctx: StrategyContext) => readonly Intent[]>([
        [ENTRY_AT_MS, (ctx) => [entryIntent(ctx, "co2n1-entry-t5")]],
        [EXIT_AT_MS, (ctx) => [exitIntent(ctx, "co2n1-exit-t5"), MARKET_CANCEL]],
      ]),
    );
  const closeTime = iso(60 * MINUTE_MS);

  async function run(exitLagMs: number): Promise<Harness> {
    const harness = assemble(schedule(), { closeTime });
    await drive(harness, [...opening(), evaluationAt(ENTRY_AT_MS)], lagging(0));
    await drive(harness, [evaluationAt(EXIT_AT_MS)], lagging(exitLagMs));
    return harness;
  }

  it("the CANCEL and the EXIT get the same verdicts, plans and fills at a 30-minute lag as at lag 0", async () => {
    const lagged = await run(30 * MINUTE_MS);
    const onTime = await run(0);
    const [, cancel, exit] = lagged.admissions();
    const [, cancelOnTime, exitOnTime] = onTime.admissions();
    expect(lagged.admissions()).toHaveLength(3);
    expect(cancel?.document.intent.type).toBe("CANCEL");
    expect(exit?.document.intent).toMatchObject({ type: "POSITION", targetShares: "-10" });

    // The CANCEL read no clock: its inputs are today's, byte for byte.
    expect(cancel?.document).toEqual(cancelOnTime?.document);
    expect(cancel?.verdict).toEqual(cancelOnTime?.verdict);
    expect(cancel?.verdict.approved).toBe(true);

    // The EXIT was MEASURED at its admission (30 minutes late)...
    expect(featuresAge(exit)).toBe(30 * MINUTE_MS);
    expect(exit?.verdict.freshness?.features.status).toBe("STALE");
    // ...and JUDGED as at lag 0: check 7's features row and check 20 judge entries only.
    expect(exit?.verdict.approved).toBe(true);
    expect(judgement(exit?.verdict as RiskEvaluation)).toEqual(judgement(exitOnTime?.verdict as RiskEvaluation));
    expect(withoutAdmissionMeasurements(exit?.document as RiskDocument)).toEqual(
      withoutAdmissionMeasurements(exitOnTime?.document as RiskDocument),
    );

    expect(planKinds(lagged)).toEqual(["POSITION", "CANCEL", "POSITION"]);
    expect(lagged.submitted).toEqual(onTime.submitted);
    expect(lagged.venue.fills).toEqual(onTime.venue.fills);
    expect(lagged.loop.health().risk).toMatchObject({ refusals: 0, approvals: 3 });
  });

  it("control: an ENTRY in the same decision position at the same lag IS refused — the lag was there to see", async () => {
    const harness = assemble(
      at(
        new Map<number, (ctx: StrategyContext) => readonly Intent[]>([
          [ENTRY_AT_MS, (ctx) => [entryIntent(ctx, "co2n1-entry-t5-control")]],
          [EXIT_AT_MS, (ctx) => [entryIntent(ctx, "co2n1-second-entry-t5-control"), MARKET_CANCEL]],
        ]),
      ),
      { closeTime },
    );
    await drive(harness, [...opening(), evaluationAt(ENTRY_AT_MS)], lagging(0));
    await drive(harness, [evaluationAt(EXIT_AT_MS)], lagging(30 * MINUTE_MS));
    const [, cancel, entry] = harness.admissions();
    expect(cancel?.verdict.approved).toBe(true);
    expect(codes(entry)).toEqual(["RISK_FEATURES_STALE"]);
  });
});

// ---------------------------------------------------------------------------
// T7: a clock behind the event instant
// ---------------------------------------------------------------------------

describe("ADR-031 T7: a process clock BEHIND the event instant reads as lag 0", () => {
  const schedule = (): Script =>
    at(
      new Map<number, (ctx: StrategyContext) => readonly Intent[]>([
        [ENTRY_AT_MS, (ctx) => [entryIntent(ctx, "co2n1-entry-t7")]],
        [EXIT_AT_MS, (ctx) => [exitIntent(ctx, "co2n1-exit-t7")]],
      ]),
    );

  it("ten minutes behind: the entry's and the exit's inputs are the lag-0 run's, byte for byte, and both are approved", async () => {
    const behind = assemble(schedule());
    await drive(behind, [...opening(), evaluationAt(ENTRY_AT_MS), evaluationAt(EXIT_AT_MS)], lagging(-10 * MINUTE_MS));
    const onTime = assemble(schedule());
    await drive(onTime, [...opening(), evaluationAt(ENTRY_AT_MS), evaluationAt(EXIT_AT_MS)], lagging(0));
    expect(behind.admissions()).toHaveLength(2);
    expect(behind.admissions().map((admission) => admission.document)).toEqual(onTime.admissions().map((admission) => admission.document));
    expect(behind.admissions().map((admission) => admission.verdict)).toEqual(onTime.admissions().map((admission) => admission.verdict));
    expect(behind.admissions().map((admission) => featuresAge(admission))).toEqual([0, 0]);
    expect(behind.admissions().every((admission) => admission.verdict.approved)).toBe(true);
    expect(behind.venue.fills).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// T8: an unreadable process reading
// ---------------------------------------------------------------------------

describe("ADR-031 T8 (R5): a process reading that does not normalise to strict UTC", () => {
  for (const reading of ["not-an-instant", "2026-05-01T09:00:01.4001Z", "2026-05-01 09:00:01"]) {
    it(`"${reading}": the entry is refused RISK_FRESHNESS_UNKNOWN, seconds-to-close stays on the event instant, and a CANCEL still routes`, async () => {
      const harness = assemble(
        at(
          new Map<number, (ctx: StrategyContext) => readonly Intent[]>([
            [ENTRY_AT_MS, (ctx) => [entryIntent(ctx, "co2n1-entry-t8"), MARKET_CANCEL]],
          ]),
        ),
      );
      await drive(harness, opening(), lagging(0));
      await drive(harness, [evaluationAt(ENTRY_AT_MS)], fixedAt(reading));
      const [cancel, entry] = harness.admissions();
      // The features measurement is OMITTED, never a zero nobody measured.
      expect(entry?.context["featuresAgeMs"]).toBeUndefined();
      expect(featuresAge(entry)).toBeUndefined();
      expect(entry?.document.freshness.map((observation) => observation.feed)).toEqual(["VENUE_BOOK", "REFERENCE_FEED"]);
      expect(secondsToClose(entry)).toBe(Math.floor((T_CLOSE_MS - (T_OPEN_MS + ENTRY_AT_MS)) / 1000));
      expect(codes(entry)).toEqual(["RISK_FRESHNESS_UNKNOWN"]);
      expect(cancel?.verdict.approved).toBe(true);
      expect(planKinds(harness)).toEqual(["CANCEL"]);
    });
  }

  it("an EXIT under an unreadable reading is judged as today (features and time-to-close judge entries only)", async () => {
    const harness = assemble(
      at(
        new Map<number, (ctx: StrategyContext) => readonly Intent[]>([
          [ENTRY_AT_MS, (ctx) => [entryIntent(ctx, "co2n1-entry-t8-exit")]],
          [EXIT_AT_MS, (ctx) => [exitIntent(ctx, "co2n1-exit-t8")]],
        ]),
      ),
    );
    await drive(harness, [...opening(), evaluationAt(ENTRY_AT_MS)], lagging(0));
    await drive(harness, [evaluationAt(EXIT_AT_MS)], fixedAt("not-an-instant"));
    const [, exit] = harness.admissions();
    expect(featuresAge(exit)).toBeUndefined();
    expect(exit?.verdict.approved).toBe(true);
    expect(harness.venue.fills).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// T9: ADR-023's CONNECTION_CONFIRMED, a lag inside D7's range
// ---------------------------------------------------------------------------

describe("ADR-031 T9: under CONNECTION_CONFIRMED the risk input's book age is exactly ADR-023's", () => {
  // ADR-023's check-7 timeline (`book-freshness.test.ts`): the YES book at
  // 1.000 s, only another market's frames on the same session until the NO
  // book at 4.100 s, where the entry is decided. The last change is 3.1 s old;
  // the session's latest PROVEN frame (4.000 s) is 100 ms old.
  const timeline = (): Recorded[] => [
    tick(-2_000),
    opened(0),
    yesBook(1_000, A1),
    ...[1_500, 2_000, 2_500, 3_000, 3_500, 4_000].map((ms) => otherMarketBook(ms, A1)),
    noBook(4_100, A1),
  ];
  const entryAt4100 = (): Script => at(new Map([[4_100, (ctx: StrategyContext) => [entryIntent(ctx, "co2n1-entry-t9")]]]));

  it("lag 1 000 ms (inside D7's range): venueBookAgeMs is 1 100 — D7's confirmation moved back by the lag — and featuresAgeMs is 1 000", async () => {
    const harness = assemble(entryAt4100(), { basis: "CONNECTION_CONFIRMED" });
    await drive(harness, timeline(), lagging(1_000));
    const [entry] = harness.admissions();
    expect(bookAge(entry)).toBe(1_100);
    expect(featuresAge(entry)).toBe(1_000);
    expect(entry?.verdict.approved).toBe(true);
  });

  it("the references: 100 ms unlagged under CONNECTION_CONFIRMED, and 3 100 ms under LAST_CHANGE at the same lag", async () => {
    const unlagged = assemble(entryAt4100(), { basis: "CONNECTION_CONFIRMED" });
    await drive(unlagged, timeline(), lagging(0));
    expect(bookAge(unlagged.admissions()[0])).toBe(100);
    const lastChange = assemble(entryAt4100(), { basis: "LAST_CHANGE" });
    await drive(lastChange, timeline(), lagging(1_000));
    expect(bookAge(lastChange.admissions()[0])).toBe(3_100);
    expect(featuresAge(lastChange.admissions()[0])).toBe(1_000);
  });
});

// ---------------------------------------------------------------------------
// T10: durability held across a bound
// ---------------------------------------------------------------------------

describe("ADR-031 T10: the clock moves while the entry's decision commit is HELD; the read sees where it moved", () => {
  function heldGroupCommitStore(): { readonly store: TraderStore; readonly held: Promise<void>; readonly release: () => void } {
    const inner = new MemoryTraderStore();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const staged: StagedEvaluations[] = [];
    const group: GroupCommit = {
      stage(evaluations) {
        staged.push(evaluations);
        return portOk(null);
      },
      get stagedEvents() {
        return staged.length;
      },
      async commit() {
        const batch = staged.splice(0, staged.length);
        if (batch.some((evaluation) => evaluation.decisions.some((entry) => entry.record.decision.intents.length > 0))) {
          reached();
          await gate;
        }
        let decisions = 0;
        let checkpoints = 0;
        for (const evaluation of batch) {
          for (const entry of evaluation.decisions) {
            await inner.persistDecision(entry.record, entry.telemetry);
            decisions += 1;
          }
          for (const entry of evaluation.checkpoints) {
            await inner.saveCheckpoint(entry.checkpoint, entry.capturedAt);
            checkpoints += 1;
          }
          for (const refusal of evaluation.riskRefusals) await inner.persistRiskRefusal(refusal);
        }
        return portOk({ decisions, checkpoints });
      },
    };
    const store: TraderStore = {
      persistDecision: (record, telemetry) => inner.persistDecision(record, telemetry),
      persistDecisionWithCheckpoint: (record, telemetry, checkpoint, capturedAt) =>
        inner.persistDecisionWithCheckpoint(record, telemetry, checkpoint, capturedAt),
      appendLedgerTransaction: (transaction) => inner.appendLedgerTransaction(transaction),
      writePnlSnapshot: (snapshot) => inner.writePnlSnapshot(snapshot),
      replacePnlSnapshot: (snapshot) => inner.replacePnlSnapshot(snapshot),
      persistRiskRefusal: (refusal) => inner.persistRiskRefusal(refusal),
      close: () => inner.close(),
      groupCommit: group,
    };
    return { store, held, release };
  }

  async function heldAcross(options: Options, movedTo: string): Promise<Harness> {
    const held = heldGroupCommitStore();
    const harness = assemble(oneEntry(), { ...options, store: held.store });
    await drive(harness, opening(), lagging(0));
    const event = ingested(evaluationAt(ENTRY_AT_MS));
    harness.clock.set(iso(ENTRY_AT_MS));
    if (!harness.loop.ingest(event)) throw new Error("ingest refused");
    const drained = harness.loop.drain();
    await held.held;
    for (let turn = 0; turn < 10; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    // Held: nothing has been judged yet.
    expect(harness.admissions()).toEqual([]);
    harness.clock.set(movedTo);
    held.release();
    await drained;
    return harness;
  }

  it("from inside the lag bound to beyond it: refused RISK_FEATURES_STALE, nothing submitted", async () => {
    const harness = await heldAcross({}, iso(ENTRY_AT_MS + 2_001));
    const [entry] = harness.admissions();
    expect(featuresAge(entry)).toBe(2_001);
    expect(codes(entry)).toEqual(["RISK_FEATURES_STALE"]);
    expect(harness.submitted).toEqual([]);
  });

  it("from outside the entry cutoff to inside it, the lag still inside its bound: refused RISK_TIME_TO_CLOSE_ENTRY_BLOCKED, nothing submitted", async () => {
    const closeTime = iso(ENTRY_AT_MS + 120_000);
    const harness = await heldAcross({ closeTime, featuresMaxAgeMs: 600_000 }, iso(ENTRY_AT_MS + 90_000));
    const [entry] = harness.admissions();
    expect(secondsToClose(entry)).toBe(30);
    expect(codes(entry)).toEqual(["RISK_TIME_TO_CLOSE_ENTRY_BLOCKED"]);
    expect(harness.submitted).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// T11: clock reads
// ---------------------------------------------------------------------------

describe("ADR-031 T11: under LAST_CHANGE a CANCEL reads no clock and each placement reads it exactly once", () => {
  async function readsAt(script: Script, intentsAtMs: number): Promise<{ readonly perEvent: readonly number[]; readonly routed: readonly string[] }> {
    const harness = assemble(script);
    await drive(harness, opening(), lagging(0));
    const perEvent: number[] = [];
    for (const ms of [intentsAtMs - 1_000, intentsAtMs, intentsAtMs + 1_000]) {
      const before = harness.clock.reads;
      await drive(harness, [evaluationAt(ms)], lagging(0));
      perEvent.push(harness.clock.reads - before);
    }
    return { perEvent, routed: harness.admissions().map((admission) => admission.document.intent.type) };
  }

  it("hold, CANCEL, hold: no read at all; hold, placement, hold: exactly one, at the placement", async () => {
    const cancel = await readsAt(at(new Map([[ENTRY_AT_MS, () => [MARKET_CANCEL]]])), ENTRY_AT_MS);
    expect(cancel.routed).toEqual(["CANCEL"]);
    expect(cancel.perEvent).toEqual([0, 0, 0]);
    const placement = await readsAt(oneEntry(), ENTRY_AT_MS);
    expect(placement.routed).toEqual(["POSITION"]);
    expect(placement.perEvent).toEqual([0, 1, 0]);
  });

  it("one decision [placement, CANCEL]: one read; [placement, placement]: two — each placement is measured at its own admission", async () => {
    const mixed = await readsAt(
      at(new Map([[ENTRY_AT_MS, (ctx: StrategyContext) => [entryIntent(ctx, "co2n1-t11-a"), MARKET_CANCEL]]])),
      ENTRY_AT_MS,
    );
    expect(mixed.routed).toEqual(["CANCEL", "POSITION"]);
    expect(mixed.perEvent).toEqual([0, 1, 0]);
    const two = await readsAt(
      at(new Map([[ENTRY_AT_MS, (ctx: StrategyContext) => [entryIntent(ctx, "co2n1-t11-b"), entryIntent(ctx, "co2n1-t11-c")]]])),
      ENTRY_AT_MS,
    );
    expect(two.routed).toEqual(["POSITION", "POSITION"]);
    expect(two.perEvent).toEqual([0, 2, 0]);
  });

  it("two placements of ONE decision can get different verdicts when the bound is crossed between their reads (R1)", async () => {
    // The first placement's admission write moves the clock past the bound
    // before the second is read: the second is judged at its own instant.
    const harness = assemble(
      at(new Map([[ENTRY_AT_MS, (ctx: StrategyContext) => [entryIntent(ctx, "co2n1-r1-a"), entryIntent(ctx, "co2n1-r1-b")]]])),
    );
    await drive(harness, opening(), lagging(0));
    harness.beforeSubmit = () => {
      harness.clock.set(iso(ENTRY_AT_MS + 2_001));
    };
    await drive(harness, [evaluationAt(ENTRY_AT_MS)], lagging(0));
    const [first, second] = harness.admissions();
    expect(featuresAge(first)).toBe(0);
    expect(first?.verdict.approved).toBe(true);
    expect(featuresAge(second)).toBe(2_001);
    expect(codes(second)).toEqual(["RISK_FEATURES_STALE"]);
  });
});
