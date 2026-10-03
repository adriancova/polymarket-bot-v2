/**
 * `CADENCE-1` — ADR-026 in the REAL core loop: at most one `onFeatures`
 * evaluation per market per `evaluationIntervalMs` of event time, plus a
 * heartbeat, every other callback in place.
 *
 * The harness is `createPaperTrader`'s assembly with a RECORDING strategy
 * double in place of Static Bracket, so what is pinned is WHICH callbacks the
 * loop invokes, at which source event and instant — not what a strategy
 * decides. Two markets, A then B in the configured order, one instance each.
 * Every record is read through the runtime's own `evaluate` (spied) and the
 * store the outbox drains into.
 *
 * Work-plan acceptance, test by test (each `describe` names its criterion):
 *
 * 1. D4 — fill, order-update and lifecycle callbacks fire exactly as before,
 *    and the loop has no start/stop/timer producer under either cadence;
 * 2. D5 — a coalesced market is not evaluated and persists nothing; every
 *    invoked callback persists exactly one decision;
 * 3. D6 — the same events give byte-identical decisions; no clock is read;
 * 4. D2.1/D2.8 — the high-water mark; a backward step neither adds nor stops
 *    an evaluation;
 * 6. D2.1/D3.2-D3.3 — refused events never move the clock or source an
 *    evaluation; carried and heartbeat evaluations take the frame's last
 *    APPLIED event; a frame with none evaluates nothing;
 * 7. D2.12 — owed first, in ADR-024 D3's order, then carried and heartbeat
 *    evaluations in configured order, in one close;
 * 8. the ADR-024 D3 one-event row — callbacks in place, `onFeatures` by the
 *    cadence;
 * 9. D2.10 — a forward jump: the hold, its end, the alarm.
 *
 * (5, the policy, is `cadence.test.ts` and the composition roots' tests; 10
 * and 11 are the control API's and the run record's; 12 is
 * `apps/backtest-cli/src/cadence-one-code-path.test.ts`.)
 */

import { parseAllocatorCaps } from "@polymarket-bot/capital-allocator";
import type { DecisionResult, EventEnvelope, Intent } from "@polymarket-bot/domain";
import { Ledger } from "@polymarket-bot/ledger";
import { parseRiskPolicy } from "@polymarket-bot/risk";
import {
  SimulatedVenue,
  readFeeScheduleSnapshot,
  tier0Model,
  unmodeledRateLimits,
  type BookView,
  type FeeScheduleSnapshot,
} from "@polymarket-bot/simulation";
import { createStrategyInstanceRuntime, type EvaluationInput } from "@polymarket-bot/strategy-runtime";
import type { Strategy, StrategyContext } from "@polymarket-bot/strategy-sdk";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { DeterministicIdFactory, type PostingIdentity } from "./accounting.js";
import { AllocatorGate, allocationMarketOf, type AllocationMarket } from "./allocation.js";
import {
  PAPER_EVALUATION_CADENCE,
  PER_FRAME_EVALUATION_CADENCE,
  type CadenceAlarm,
  type EvaluationCadenceOption,
} from "./cadence.js";
import { configuredFeatureKeys, parseTraderConfig } from "./config.js";
import { EVERY_FILL_ACCOUNTING_CHECKS } from "./folds.js";
import { HaltController } from "./halt.js";
import { HealthState } from "./health.js";
import { InstanceRegistry } from "./instances.js";
import { CoreLoop, DecisionOutboxBuffer } from "./loop.js";
import { MarketState } from "./market-state.js";
import type { Clock, IngestedEvent } from "./ports.js";
import { REPOSITORY_MAXIMUM_RUN_MODE, TRADER_RUN_MODE } from "./safety.js";
import { ManualClock, MemoryTraderStore } from "./testing/index.js";
import { formatStrictUtc } from "./time.js";

const MARKET_A = "018f5c20-1000-7a10-8b00-0000000000c1";
const MARKET_B = "018f5c20-1000-7a10-8b00-0000000000c2";
/** A market this trader does not run: its events are applied and owe nothing. */
const MARKET_X = "018f5c20-1000-7a10-8b00-0000000000c9";
const TOKENS = {
  [MARKET_A]: { yes: "8101", no: "8102" },
  [MARKET_B]: { yes: "8201", no: "8202" },
  [MARKET_X]: { yes: "8901", no: "8902" },
} as const;
const INSTANCE_A = "e18f5c20-2000-7a20-8b00-0000000000c1";
const INSTANCE_B = "e18f5c20-2000-7a20-8b00-0000000000c2";
const RUN_A = "018f5c20-3000-7a30-8b00-0000000000c1";
const RUN_B = "018f5c20-3000-7a30-8b00-0000000000c2";
const CONFIG_ID = "018f5c20-4000-7a40-8b00-0000000000c0";
const GATEWAY_EPOCH = "018f5c20-5000-7a50-8b00-0000000000c5";
const T0_MS = Date.parse("2026-05-01T09:00:00.000Z");
const T_OPEN = "2026-05-01T09:00:00.000Z";
const T_CLOSE = "2026-05-02T09:00:00.000Z";
const PER_FRAME: EvaluationCadenceOption = { ...PER_FRAME_EVALUATION_CADENCE, reproduces: "cadence-1:loop-cadence.test.ts" };

function feeSnapshot(): FeeScheduleSnapshot {
  return {
    snapshotVersion: "cadence1.sim.2026-05-01",
    takerFeeRate: "0",
    makerFeeRate: "0",
    roundingDecimalPlaces: 3,
    roundingMode: "HALF_UP",
    minimumChargedFee: "0",
    feeCurrency: "pUSD",
  };
}

function marketDocument(marketId: string, tokens: { readonly yes: string; readonly no: string }): Record<string, unknown> {
  return {
    marketId,
    conditionId: `0xcadence1${marketId.slice(-2)}`,
    yesTokenId: tokens.yes,
    noTokenId: tokens.no,
    tickSize: "0.01",
    minimumOrderSize: "5",
    makerFeeRate: "0",
    takerFeeRate: "0",
    parametersVersion: 1,
    settlementReadiness: { modelDependentActivationAllowed: true },
    openTime: T_OPEN,
    closeTime: T_CLOSE,
    seriesKey: "cadence1-sim",
    underlyingKey: "SIMBTC",
    resolutionWindowKey: "w2026-05-02T09.00",
  };
}

function traderConfig(): Record<string, unknown> {
  return {
    environment: "PAPER",
    riskPolicy: {
      freshness: { venueBookMaxAgeMs: 600_000, referenceFeedMaxAgeMs: 600_000, featuresMaxAgeMs: 600_000 },
      limits: { maxWorstCaseContractualLoss: "1000" },
      scenario: { maxScenarioLoss: "1000" },
      economics: {},
      participation: {},
      rateLimit: { safetyReserveRequests: 0 },
      timeToClose: { entryCutoffSeconds: 30 },
    },
    allocatorCaps: {
      globalAccountCap: "10000",
      perStrategyCap: "1000",
      liveMicroMaxOrderNotional: "0",
      liveMicroMaxAccountExposure: "0",
    },
    accounting: {
      accountRef: "cadence1-paper-account",
      denominationAssetId: "pUSD",
      venueClearingRef: "cadence1-venue-clearing",
      attributionClearingRef: "cadence1-attribution-clearing",
      feeExpenseRef: "cadence1-fee-expense",
      startingCash: "1000",
    },
    queues: { ingestMaximumDepth: 1024, outboxMaximumDepth: 1024 },
    features: {
      depthLevels: [1, 2, 5],
      executableShares: ["10"],
      tradeWindowMs: 60_000,
      ewmaLambda: "0.94",
      primaryReferenceVenue: "binance",
    },
    planning: {
      maxSliceShares: "10",
      marketableSlippageTicks: 2,
      replaceThresholdTicks: 1,
      minimumReplaceIntervalMs: 500,
      cancelDeadlineMs: 5_000,
      maxPlanLifetimeMs: 30_000,
    },
    simulation: {
      fillModelVersion: "tier0.cadence1",
      fillModelParametersHash: "c".repeat(64),
      feeSchedule: { ...feeSnapshot() },
      startingCash: "1000",
    },
    requestBudget: { capacity: 1_000_000, windowMs: 60_000 },
    scenarios: [
      { scenarioId: "spot.down", kind: "SPOT", yesPriceShock: "-0.1" },
      { scenarioId: "vol.up", kind: "VOLATILITY", yesPriceShock: "-0.05" },
      { scenarioId: "time.decay", kind: "TIME", yesPriceShock: "-0.02" },
      { scenarioId: "liq.thin", kind: "LIQUIDITY", yesPriceShock: "-0.03" },
    ],
    infrastructure: {
      eventStream: "polymarket.normalized",
      consumerId: "cadence-1",
      receiveBatchSize: 128,
      retentionMaxEvents: 100_000,
    },
    markets: [marketDocument(MARKET_A, TOKENS[MARKET_A]), marketDocument(MARKET_B, TOKENS[MARKET_B])],
    instances: [
      { instanceId: INSTANCE_A, runId: RUN_A, configId: CONFIG_ID, runSeed: "7", marketId: MARKET_A, ownership: "OWNER", evaluationPriority: 0, evaluationBudgetUs: 5_000_000, params: {} },
      { instanceId: INSTANCE_B, runId: RUN_B, configId: CONFIG_ID, runSeed: "7", marketId: MARKET_B, ownership: "OWNER", evaluationPriority: 0, evaluationBudgetUs: 5_000_000, params: {} },
    ],
  };
}

function hold(ctx: StrategyContext): DecisionResult {
  return { decisionType: "hold", reasonCodes: ["CADENCE1.HOLD"], featureSnapshotRef: ctx.features().snapshotRef, intents: [] };
}

/**
 * The recording double: holds everywhere, except that — when `placeOnOpen` —
 * `onMarketOpen` places ONE resting maker BUY (10 YES at 0.30). Placing from a
 * LIFECYCLE callback, which fires in place under every cadence, gives both
 * cadences the same order at the same event, so what follows from it (order
 * views, the fill) can be compared one to one.
 */
function recordingStrategy(placeOnOpen: boolean): Strategy<unknown, Record<string, never>> {
  return {
    name: "cadence1-recording-double",
    version: "1.0.0",
    paramsSchema: z.strictObject({}),
    stateSchemaVersion: 1,
    onStart: hold,
    onTimer: hold,
    onStop: hold,
    onFeatures: hold,
    onFill: (ctx: StrategyContext) => hold(ctx),
    onOrderUpdate: (ctx: StrategyContext) => hold(ctx),
    onMarketClosing: (ctx: StrategyContext) => hold(ctx),
    onMarketResolved: (ctx: StrategyContext) => hold(ctx),
    onMarketOpen(ctx: StrategyContext): DecisionResult {
      if (!placeOnOpen) return hold(ctx);
      const buy: Intent = {
        type: "POSITION",
        intentId: "cadence1-resting-buy",
        marketId: MARKET_A,
        direction: "YES",
        targetMode: "DELTA",
        targetShares: "10",
        maximumBuyPrice: "0.3",
        maximumTotalCost: "3",
        urgency: "PASSIVE",
        liquidityPreference: "MAKER_ONLY",
        partialFillPolicy: "ACCEPT_ANY",
        validUntil: new Date(Date.parse(ctx.now()) + 600_000).toISOString(),
        expectedNetEdge: "5",
        tags: ["cadence1.entry", "sb.order-type:GTC"],
      };
      return { decisionType: "enter", reasonCodes: ["CADENCE1.PLACE"], featureSnapshotRef: ctx.features().snapshotRef, intents: [buy] };
    },
  };
}

/** One recorded invocation of the runtime. */
interface Seen {
  readonly instanceId: string;
  readonly callback: string;
  readonly evaluatedAt: string;
  readonly source: string | undefined;
}

interface Harness {
  readonly loop: CoreLoop;
  readonly venue: SimulatedVenue;
  readonly store: MemoryTraderStore;
  readonly halts: HaltController;
  readonly seen: Seen[];
  readonly alarms: CadenceAlarm[];
}

interface HarnessOptions {
  readonly cadence: EvaluationCadenceOption;
  readonly placeOnOpen?: boolean;
  readonly clock?: Clock;
}

/** `createPaperTrader`'s assembly, with the recording double's runtimes registered. */
function assemble(options: HarnessOptions): Harness {
  const parsed = parseTraderConfig(traderConfig());
  if (!parsed.ok) throw new Error(`config refused: ${parsed.refusal.detail} ${parsed.refusal.issues.join("; ")}`);
  const config = parsed.config;
  const policy = parseRiskPolicy(config.riskPolicy);
  if (!policy.ok) throw new Error("risk policy refused");
  const caps = parseAllocatorCaps(config.allocatorCaps);
  if (!caps.ok) throw new Error("allocator caps refused");
  const clock = options.clock ?? new ManualClock(T_OPEN);
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
  const registry = new InstanceRegistry();
  const seen: Seen[] = [];
  for (const [instanceId, runId, marketId] of [
    [INSTANCE_A, RUN_A, MARKET_A],
    [INSTANCE_B, RUN_B, MARKET_B],
  ] as const) {
    const created = createStrategyInstanceRuntime({
      strategy: recordingStrategy(options.placeOnOpen === true && marketId === MARKET_A),
      params: {},
      run: { runId, instanceId, configId: CONFIG_ID, runSeed: "7" },
      watchdog: { evaluationBudgetUs: 5_000_000 },
      clock: { nowNs: () => clock.monotonicNs() },
      decisionSink: { persist: (record, telemetry) => outbox.appendDecision(record, telemetry) },
      checkpointStore: { save: (checkpoint) => outbox.appendCheckpoint(checkpoint) },
    });
    if (!created.ok) throw new Error(`runtime refused: ${created.refusal.detail}`);
    const evaluate = created.runtime.evaluate.bind(created.runtime);
    vi.spyOn(created.runtime, "evaluate").mockImplementation((input: EvaluationInput) => {
      seen.push({
        instanceId,
        callback: input.callback,
        evaluatedAt: input.evaluatedAt,
        source: input.sourceEvent?.eventId,
      });
      return evaluate(input);
    });
    const registered = registry.register({
      instanceId,
      runId,
      configId: CONFIG_ID,
      marketId,
      ownership: "OWNER",
      evaluationPriority: 0,
      runtime: created.runtime,
      direction: "YES",
      params: {},
      immediateOrderType: "FAK",
      submissionUnknownAfterMs: 5_000,
    });
    if (!registered.ok) throw new Error(registered.detail);
  }
  const fees = readFeeScheduleSnapshot(feeSnapshot());
  if (!fees.ok) throw new Error("fees refused");
  const wiring: { loop: CoreLoop | undefined } = { loop: undefined };
  const venue = new SimulatedVenue({
    clock,
    runMode: "PAPER",
    model: tier0Model({ fillModelVersion: "tier0.cadence1", fillModelParametersHash: "c".repeat(64) }),
    feeSnapshot: fees.value,
    rateLimits: unmodeledRateLimits("no venue rate-limit budget is modelled in this test"),
    policy: {
      timeInForceFor(order) {
        const resolved = wiring.loop?.timeInForceFor(order.plannedOrderId);
        if (resolved === undefined) throw new Error(`no time-in-force for ${order.plannedOrderId}`);
        return resolved;
      },
      statedExpiryNsFor: () => undefined,
      sameInstantAdditionsFor: () => "NOT_OBSERVED" as const,
    },
    startingCash: "1000",
    books: {
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
    },
  });
  const posting: PostingIdentity = {
    environment: config.environment,
    accountRef: config.accounting.accountRef,
    denominationAssetId: config.accounting.denominationAssetId,
    venueClearingRef: config.accounting.venueClearingRef,
    attributionClearingRef: config.accounting.attributionClearingRef,
    feeExpenseRef: config.accounting.feeExpenseRef,
  };
  const store = new MemoryTraderStore();
  const halts = new HaltController();
  const alarms: CadenceAlarm[] = [];
  const loop = new CoreLoop({
    config,
    riskPolicy: policy.value,
    allocator: new AllocatorGate({ caps: caps.value, markets: allocationMarkets, tokenAssetIds }),
    clock,
    venue,
    store,
    registry,
    markets,
    instanceConfigs: new Map(),
    ledger: Ledger.empty(config.environment),
    ids: new DeterministicIdFactory("cadence-1"),
    health: new HealthState({ runMode: TRADER_RUN_MODE, maximumRunMode: REPOSITORY_MAXIMUM_RUN_MODE }),
    halts,
    featureKeys: configuredFeatureKeys(config),
    posting,
    tokenAssetIds,
    outbox,
    accountingChecks: EVERY_FILL_ACCOUNTING_CHECKS,
    evaluationCadence: options.cadence,
    onCadenceAlarm: (alarm) => alarms.push(alarm),
  });
  wiring.loop = loop;
  return { loop, venue, store, halts, seen, alarms };
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

let ordinal = 0;

/** One envelope at `offsetMs` after T0. `frame` stamps a shared causationId (one venue frame). */
function event(
  offsetMs: number,
  eventType: string,
  payload: unknown,
  options: { readonly source?: "polymarket" | "binance"; readonly frame?: string } = {},
): IngestedEvent {
  ordinal += 1;
  const receivedAt = new Date(T0_MS + offsetMs).toISOString();
  const wire: EventEnvelope<unknown> = {
    eventId: `018f5c20-9000-7a90-8b00-${String(ordinal).padStart(12, "0")}`,
    eventType,
    schemaVersion: 1,
    source: options.source ?? "polymarket",
    sourceChannel: "market",
    receivedAt,
    receivedMonotonicNs: String(ordinal * 1_000_000),
    gatewayEpoch: GATEWAY_EPOCH,
    ingestSeq: String(ordinal),
    subscriptionGeneration: 1,
    ...(options.frame === undefined ? {} : { causationId: `raw:${GATEWAY_EPOCH}:${options.frame}` }),
    payload,
  };
  return { envelope: wire, identity: { gatewayEpoch: GATEWAY_EPOCH, ingestSeq: String(ordinal), receivedAt, datasetRowOrdinal: ordinal } };
}

function idOf(ingested: IngestedEvent): string {
  return (ingested.envelope as { readonly eventId: string }).eventId;
}

/** The loop's own strict-UTC form of an offset's instant (whole seconds carry no fraction). */
function iso(offsetMs: number): string {
  return formatStrictUtc(T0_MS + offsetMs);
}

const reference = (offsetMs: number, frame?: string): IngestedEvent =>
  event(offsetMs, "ReferenceTradeObserved", { venue: "binance", symbol: "BTCUSDT", price: "64000", size: "0.5" }, {
    source: "binance",
    ...(frame === undefined ? {} : { frame }),
  });

const snapshot = (offsetMs: number, marketId: string, outcome: "yes" | "no", frame?: string): IngestedEvent =>
  event(
    offsetMs,
    "BookSnapshot",
    {
      internalMarketId: marketId,
      tokenId: TOKENS[marketId as keyof typeof TOKENS][outcome],
      bids: [{ price: "0.32", size: "500" }],
      asks: [{ price: "0.34", size: "500" }],
    },
    frame === undefined ? {} : { frame },
  );

const level = (offsetMs: number, marketId: string, price: string, frame?: string): IngestedEvent =>
  event(
    offsetMs,
    "BookLevelChanged",
    { internalMarketId: marketId, tokenId: TOKENS[marketId as keyof typeof TOKENS].yes, side: "BID", price, size: "100" },
    frame === undefined ? {} : { frame },
  );

const opened = (offsetMs: number, marketId: string): IngestedEvent =>
  event(offsetMs, "MarketOpened", { internalMarketId: marketId, conditionId: `0xcadence1${marketId.slice(-2)}`, openedAt: T_OPEN });

const closing = (offsetMs: number, marketId: string): IngestedEvent =>
  event(offsetMs, "MarketClosing", { internalMarketId: marketId, conditionId: `0xcadence1${marketId.slice(-2)}`, closesAt: T_CLOSE });

const resolved = (offsetMs: number, marketId: string): IngestedEvent =>
  event(offsetMs, "MarketResolved", {
    internalMarketId: marketId,
    conditionId: `0xcadence1${marketId.slice(-2)}`,
    outcome: "YES_WIN",
    resolvedAt: new Date(T0_MS + offsetMs).toISOString(),
  });

const trade = (offsetMs: number, marketId: string, price: string): IngestedEvent =>
  event(offsetMs, "PublicTradeObserved", {
    internalMarketId: marketId,
    tokenId: TOKENS[marketId as keyof typeof TOKENS].yes,
    price,
    size: "50",
    takerSide: "ASK",
  });

/** An event type the loop does not consume: REFUSED (counted, no halt), never applied. */
const refused = (offsetMs: number, frame?: string): IngestedEvent =>
  event(
    offsetMs,
    "ReferenceTopOfBookChanged",
    { venue: "binance", symbol: "BTCUSDT", bidPrice: "63999", bidSize: "1", askPrice: "64001", askSize: "1" },
    { source: "binance", ...(frame === undefined ? {} : { frame }) },
  );

/** Delivers each group to one drain (a group is a batch the feed hands out). */
async function feed(harness: Harness, ...batches: readonly (IngestedEvent | readonly IngestedEvent[])[]): Promise<void> {
  for (const batch of batches) {
    for (const ingested of Array.isArray(batch) ? batch : [batch as IngestedEvent]) {
      if (!harness.loop.ingest(ingested)) throw new Error("ingest refused");
    }
    await harness.loop.drain();
  }
}

/** The `onFeatures` invocations since `from`, as `[instance, source event, evaluatedAt]`. */
function featureCalls(harness: Harness, from = 0): [string, string | undefined, string][] {
  return harness.seen
    .slice(from)
    .filter((entry) => entry.callback === "onFeatures")
    .map((entry) => [entry.instanceId === INSTANCE_A ? "A" : "B", entry.source, entry.evaluatedAt]);
}

/**
 * Both markets' books at 10-40 ms, then a reference trade at {@link S}: the
 * trade at 0 evaluated both markets (no book yet: no snapshot), the four
 * snapshots each owed one market inside the interval (4 coalescences, both
 * markets carried), and the trade at 1,000 ms evaluates both. After this,
 * `last` is 1,000 ms for both markets and nothing is owed.
 */
function opening(): IngestedEvent[] {
  return [
    reference(0),
    snapshot(10, MARKET_A, "yes"),
    snapshot(20, MARKET_A, "no"),
    snapshot(30, MARKET_B, "yes"),
    snapshot(40, MARKET_B, "no"),
    reference(S),
  ];
}

/** Where {@link opening} leaves both markets: evaluated at this offset, nothing owed. */
const S = 1_000;

// ---------------------------------------------------------------------------

describe("acceptance 1, ADR-026 D4: every callback but onFeatures fires exactly as before", () => {
  /**
   * One scenario, every event touching a configured market or the reference
   * feed, so ADR-024's harvest points are fixed by the events alone: lifecycle
   * callbacks in place, an order placed from `onMarketOpen`, its WORKING view
   * at every harvest, its fill from a public trade, its terminal view.
   */
  function scenario(): IngestedEvent[] {
    ordinal = 0;
    const events = [
      reference(0),
      snapshot(10, MARKET_A, "yes"),
      snapshot(20, MARKET_A, "no"),
      snapshot(30, MARKET_B, "yes"),
      snapshot(40, MARKET_B, "no"),
      opened(100, MARKET_A),
      opened(150, MARKET_B),
    ];
    for (let offset = 200; offset <= 2_400; offset += 100) {
      events.push(level(offset, offset % 200 === 0 ? MARKET_A : MARKET_B, "0.31"));
    }
    events.push(trade(2_500, MARKET_A, "0.29"));
    for (let offset = 2_600; offset <= 2_900; offset += 100) events.push(level(offset, MARKET_A, "0.31"));
    events.push(closing(3_000, MARKET_A), reference(3_050), resolved(3_100, MARKET_A), level(3_200, MARKET_B, "0.31"));
    return events;
  }

  async function run(cadence: EvaluationCadenceOption): Promise<Harness> {
    const harness = assemble({ cadence, placeOnOpen: true });
    for (const ingested of scenario()) await feed(harness, ingested);
    return harness;
  }

  it("the same fills, order updates and lifecycle callbacks, at the same events and instants, under both cadences", async () => {
    const perFrame = await run(PER_FRAME);
    const paper = await run(PAPER_EVALUATION_CADENCE);
    const others = (harness: Harness) => harness.seen.filter((entry) => entry.callback !== "onFeatures");
    expect(others(paper)).toEqual(others(perFrame));

    // Non-vacuous: every kind is there, the order filled, and the cadences differ on onFeatures.
    const kinds = new Set(others(paper).map((entry) => entry.callback));
    expect([...kinds].sort()).toEqual(["onFill", "onMarketClosing", "onMarketOpen", "onMarketResolved", "onOrderUpdate"]);
    expect(others(paper).filter((entry) => entry.callback === "onOrderUpdate").length).toBeGreaterThan(5);
    expect(paper.venue.fills.length).toBe(1);
    expect(perFrame.venue.fills).toEqual(paper.venue.fills);
    expect(paper.halts.records()).toEqual([]);
    expect(featureCalls(paper).length).toBeLessThan(featureCalls(perFrame).length / 3);
    expect(paper.loop.health().loop.evaluationsCoalesced).toBeGreaterThan(0);
    expect(perFrame.loop.health().loop.evaluationsCoalesced).toBe(0);
    // `onStart`, `onStop` and `onTimer` have no producer in the loop: none fires under either cadence.
    for (const harness of [perFrame, paper]) {
      expect(harness.seen.some((entry) => ["onStart", "onStop", "onTimer"].includes(entry.callback))).toBe(false);
    }
  });
});

describe("acceptance 2, ADR-026 D5: a coalesced market is not evaluated; every invoked callback persists exactly one decision", () => {
  it("counts one coalescence per owed market per close; the runtime is never asked for it; one decision per invocation", async () => {
    ordinal = 0;
    const harness = assemble({ cadence: PAPER_EVALUATION_CADENCE });
    await feed(harness, ...opening());
    expect(featureCalls(harness).map(([market]) => market)).toEqual(["A", "B"]);
    // The opening's four snapshots: A owed at 10 and 20 ms, B at 30 and 40 ms, and
    // A — still owed — at the 30 and 40 ms closes too: one per owed market per close.
    expect(harness.loop.health().loop.evaluationsCoalesced).toBe(6);
    const before = harness.seen.length;
    // Four closes inside the interval: A owed at all four (+4), B owed from the
    // second on (+3, ADR-026 D5.6: "a market that stays owed over three closes
    // adds three"). Nothing is asked of the runtime.
    await feed(harness, level(S + 300, MARKET_A, "0.31"), level(S + 500, MARKET_B, "0.31"));
    await feed(harness, level(S + 600, MARKET_A, "0.3"), level(S + 999, MARKET_A, "0.31"));
    expect(harness.seen.length).toBe(before);
    expect(harness.loop.health().loop.evaluationsCoalesced).toBe(6 + 7);
    // At S + 1,000 A is owed and due, and B, still owed, is carried and due: both evaluated, nothing coalesced.
    const due = level(S + 1_000, MARKET_A, "0.3");
    await feed(harness, due);
    expect(featureCalls(harness, before)).toEqual([
      ["A", idOf(due), iso(S + 1_000)],
      ["B", idOf(due), iso(S + 1_000)],
    ]);
    expect(harness.loop.health().loop.evaluationsCoalesced).toBe(6 + 7);

    const health = harness.loop.health();
    expect(health.loop.evaluations).toBe(harness.seen.length);
    expect(health.loop.decisionsPersisted).toBe(harness.seen.length);
    expect(harness.store.decisions.length).toBe(harness.seen.length);
    expect(harness.store.decisions.map((entry) => entry.record.sourceEvent?.eventId)).toEqual(
      harness.seen.map((entry) => entry.source),
    );
  });
});

describe("acceptance 3, ADR-026 D6: the same events give byte-identical decisions; no clock is read for it", () => {
  /** A clock that answers wildly different instants and monotonic readings on every call. */
  class WanderingClock extends ManualClock {
    #calls = 0;
    override now(): string {
      this.#calls += 1;
      return new Date(T0_MS + ((this.#calls * 7_919_000) % 86_400_000) - 43_200_000).toISOString();
    }
    override monotonicNs(): bigint {
      this.#calls += 1;
      return BigInt(this.#calls) * 1_234_567n;
    }
  }

  function events(): IngestedEvent[] {
    ordinal = 0;
    const list = [...opening(), opened(S + 100, MARKET_A)];
    // Two-token frames, single events, a backward step, an unknown market, a refused event.
    let frame = 0;
    for (let offset = S + 200; offset <= S + 12_000; offset += 137) {
      frame += 1;
      if (frame % 9 === 0) {
        list.push(refused(offset));
      } else if (frame % 7 === 0) {
        list.push(snapshot(offset, MARKET_X, "yes"));
      } else if (frame % 5 === 0) {
        list.push(level(offset - 900, MARKET_B, "0.3"));
      } else {
        list.push(level(offset, MARKET_A, "0.31", `f${String(frame)}`), level(offset + 1, MARKET_A, "0.3", `f${String(frame)}`));
      }
    }
    return list;
  }

  async function decisionBytes(clock: Clock): Promise<string> {
    const harness = assemble({ cadence: PAPER_EVALUATION_CADENCE, clock });
    // One drain per frame, as the feed hands frames out.
    const list = events();
    for (let start = 0; start < list.length; ) {
      let end = start + 1;
      const key = (list[start]?.envelope as { causationId?: string }).causationId;
      while (key !== undefined && end < list.length && (list[end]?.envelope as { causationId?: string }).causationId === key) end += 1;
      await feed(harness, list.slice(start, end));
      start = end;
    }
    expect(harness.halts.records()).toEqual([]);
    expect(harness.loop.health().loop.evaluationsCoalesced).toBeGreaterThan(20);
    return JSON.stringify({
      decisions: harness.store.decisions.map((entry) => entry.record),
      checkpoints: harness.store.checkpoints,
      seen: harness.seen,
      loop: harness.loop.health().loop,
    });
  }

  it("two runs, two unrelated clocks: the same bytes", async () => {
    const first = await decisionBytes(new ManualClock(T_OPEN));
    const second = await decisionBytes(new WanderingClock(T_OPEN));
    expect(second).toBe(first);
  });
});

describe("acceptance 4, ADR-026 D2.1 and D2.8: the high-water mark; a backward step neither stops nor adds an evaluation", () => {
  it("a stamp behind the clock adds no evaluation, and the next one comes when the clock has moved on by the interval", async () => {
    ordinal = 0;
    const harness = assemble({ cadence: PAPER_EVALUATION_CADENCE });
    await feed(harness, ...opening());
    const start = harness.seen.length;
    const ahead = level(S + 1_200, MARKET_A, "0.31");
    await feed(harness, ahead);
    // Back 1,100 ms. Measured from its own instant this event sits 1,100 ms
    // after the S evaluation and would look due; on the high-water mark it is
    // 0 ms after the S + 1,200 one, so it is not evaluated (it stays owed).
    const back = level(S + 100, MARKET_A, "0.3");
    const almost = level(S + 2_199, MARKET_A, "0.31");
    await feed(harness, back, almost);
    expect(featureCalls(harness, start)).toEqual([["A", idOf(ahead), iso(S + 1_200)]]);
    const moved = level(S + 2_200, MARKET_A, "0.3");
    await feed(harness, moved);
    expect(featureCalls(harness, start).slice(1)).toEqual([["A", idOf(moved), iso(S + 2_200)]]);
  });

  it("the same stream without the backward event evaluates at exactly the same events", async () => {
    const run = async (includeBack: boolean): Promise<string[]> => {
      ordinal = 0;
      const harness = assemble({ cadence: PAPER_EVALUATION_CADENCE });
      await feed(harness, ...opening());
      const list = [S + 1_200, S + 100, S + 2_199, S + 2_200, S + 3_000, S + 3_200].map((offset) => level(offset, MARKET_A, "0.31"));
      for (const [index, ingested] of list.entries()) if (includeBack || index !== 1) await feed(harness, ingested);
      return featureCalls(harness).map(([market, , evaluatedAt]) => `${market}@${evaluatedAt}`);
    };
    const withBack = await run(true);
    expect(withBack).toEqual(await run(false));
    expect(withBack.slice(2)).toEqual([`A@${iso(S + 1_200)}`, `A@${iso(S + 2_200)}`, `A@${iso(S + 3_200)}`]);
  });
});

describe("acceptance 6, ADR-026 D2.1 and D3.2-D3.3: refused events and the source of a carried or heartbeat evaluation", () => {
  it("a refused event never moves the clock: an event stamped 10 s ahead, refused, does not make A due", async () => {
    ordinal = 0;
    const harness = assemble({ cadence: PAPER_EVALUATION_CADENCE });
    await feed(harness, ...opening());
    const start = harness.seen.length;
    await feed(harness, refused(S + 10_000), level(S + 500, MARKET_A, "0.31"));
    expect(harness.loop.health().loop.eventsRefused).toBe(1);
    expect(featureCalls(harness, start)).toEqual([]);
    expect(harness.alarms).toEqual([]);
  });

  it("a carried evaluation takes the frame's LAST APPLIED event — one for a market this trader does not run — never a refused one", async () => {
    ordinal = 0;
    const harness = assemble({ cadence: PAPER_EVALUATION_CADENCE });
    await feed(harness, ...opening(), level(S + 300, MARKET_A, "0.31"));
    const start = harness.seen.length;
    // One frame: B owes itself an evaluation, an unknown market's event is
    // applied after it, and a refused event ends it. A is carried and due.
    const owesB = level(S + 1_100, MARKET_B, "0.31", "x1");
    const unknown = snapshot(S + 1_150, MARKET_X, "yes", "x1");
    const refusedLast = refused(S + 1_160, "x1");
    await feed(harness, [owesB, unknown, refusedLast]);
    expect(featureCalls(harness, start)).toEqual([
      ["B", idOf(owesB), iso(S + 1_100)],
      ["A", idOf(unknown), iso(S + 1_150)],
    ]);
  });

  it("a lone event for a market this trader does not run sources a heartbeat, and its close flushes the decisions", async () => {
    ordinal = 0;
    const harness = assemble({ cadence: PAPER_EVALUATION_CADENCE });
    await feed(harness, ...opening());
    const start = harness.seen.length;
    await feed(harness, snapshot(S + 4_999, MARKET_X, "yes"));
    expect(featureCalls(harness, start)).toEqual([]);
    const unknown = snapshot(S + 5_000, MARKET_X, "no");
    await feed(harness, unknown);
    expect(featureCalls(harness, start)).toEqual([
      ["A", idOf(unknown), iso(S + 5_000)],
      ["B", idOf(unknown), iso(S + 5_000)],
    ]);
    // Flushed at that event: the decisions are in the store already.
    expect(harness.store.decisions.slice(-2).map((entry) => entry.record.sourceEvent?.eventId)).toEqual([idOf(unknown), idOf(unknown)]);
  });

  it("a frame with NO applied event evaluates nothing, though a heartbeat would be due; a market still owed stays owed", async () => {
    ordinal = 0;
    const harness = assemble({ cadence: PAPER_EVALUATION_CADENCE });
    await feed(harness, ...opening(), level(S + 300, MARKET_A, "0.31"));
    const start = harness.seen.length;
    // Every event of these frames is refused, at instants where a carried
    // evaluation and both heartbeats would be due.
    await feed(harness, [refused(S + 6_000, "r1"), refused(S + 6_001, "r1")]);
    await feed(harness, refused(S + 7_000));
    expect(featureCalls(harness, start)).toEqual([]);
    // The first APPLIED close evaluates A, still owed, once the clock allows it.
    const early = snapshot(S + 999, MARKET_X, "yes");
    await feed(harness, early);
    expect(featureCalls(harness, start)).toEqual([]);
    const applied = snapshot(S + 1_000, MARKET_X, "no");
    await feed(harness, applied);
    expect(featureCalls(harness, start)).toEqual([["A", idOf(applied), iso(S + 1_000)]]);
  });
});

describe("acceptance 7, ADR-026 D2.12: at one close, owed markets first (ADR-024 D3's order), then carried and heartbeat ones (configured order)", () => {
  it("a close where B is owed and A is carried evaluates B, then A — although A comes first in the configured order", async () => {
    ordinal = 0;
    const harness = assemble({ cadence: PAPER_EVALUATION_CADENCE });
    await feed(harness, ...opening(), level(S + 300, MARKET_A, "0.31"));
    const start = harness.seen.length;
    const owesB = level(S + 1_000, MARKET_B, "0.31");
    await feed(harness, owesB);
    expect(featureCalls(harness, start)).toEqual([
      ["B", idOf(owesB), iso(S + 1_000)],
      ["A", idOf(owesB), iso(S + 1_000)],
    ]);
  });

  it("in a longer frame: owed markets in the order of their last owing events, then carried ones; each at most once", async () => {
    ordinal = 0;
    const harness = assemble({ cadence: PAPER_EVALUATION_CADENCE });
    await feed(harness, ...opening());
    const start = harness.seen.length;
    // B owed, then A, then B again: B moves to the end (ADR-024 r1), each at its last owing event.
    const b1 = level(S + 1_000, MARKET_B, "0.31", "m1");
    const a1 = level(S + 1_001, MARKET_A, "0.31", "m1");
    const b2 = level(S + 1_002, MARKET_B, "0.3", "m1");
    await feed(harness, [b1, a1, b2]);
    expect(featureCalls(harness, start)).toEqual([
      ["A", idOf(a1), iso(S + 1_001)],
      ["B", idOf(b2), iso(S + 1_002)],
    ]);
    // B owed inside the interval: carried. Then a frame owing only A, 5 s on,
    // where B is both carried and heartbeat-due: A first, then B — once.
    await feed(harness, level(S + 1_500, MARKET_B, "0.31"));
    const a2 = level(S + 6_003, MARKET_A, "0.3", "m2");
    const x2 = snapshot(S + 6_004, MARKET_X, "yes", "m2");
    await feed(harness, [a2, x2]);
    expect(featureCalls(harness, start).slice(2)).toEqual([
      ["A", idOf(a2), iso(S + 6_003)],
      ["B", idOf(x2), iso(S + 6_004)],
    ]);
  });

  it("two carried markets come in the configured order — A, then B — whatever order they were owed in", async () => {
    ordinal = 0;
    const harness = assemble({ cadence: PAPER_EVALUATION_CADENCE });
    await feed(harness, ...opening(), level(S + 300, MARKET_B, "0.31"), level(S + 400, MARKET_A, "0.31"));
    const start = harness.seen.length;
    const unknown = snapshot(S + 1_000, MARKET_X, "yes");
    await feed(harness, unknown);
    expect(featureCalls(harness, start)).toEqual([
      ["A", idOf(unknown), iso(S + 1_000)],
      ["B", idOf(unknown), iso(S + 1_000)],
    ]);
  });

  it("the heartbeat: exactly at t − last = 5,000 ms, never before; sourced at the closing event", async () => {
    ordinal = 0;
    const harness = assemble({ cadence: PAPER_EVALUATION_CADENCE });
    await feed(harness, ...opening());
    const start = harness.seen.length;
    // Only B is touched: B is owed and evaluated each second; A gets its heartbeat at S + 5,000.
    for (const offset of [1_000, 2_000, 3_000, 4_000, 4_999]) await feed(harness, level(S + offset, MARKET_B, "0.31"));
    expect(featureCalls(harness, start).map(([market]) => market)).toEqual(["B", "B", "B", "B"]);
    const beat = level(S + 5_000, MARKET_B, "0.3");
    await feed(harness, beat);
    expect(featureCalls(harness, start).slice(4)).toEqual([
      ["B", idOf(beat), iso(S + 5_000)],
      ["A", idOf(beat), iso(S + 5_000)],
    ]);
  });
});

describe("acceptance 8, the ADR-024 D3 one-event row: callbacks in place, onFeatures by the cadence", () => {
  it("a lone lifecycle event fires its callback in place while the market's onFeatures is not due; a lone book event is coalesced", async () => {
    ordinal = 0;
    const harness = assemble({ cadence: PAPER_EVALUATION_CADENCE });
    await feed(harness, ...opening());
    const start = harness.seen.length;
    const open = opened(S + 200, MARKET_A);
    const book = level(S + 300, MARKET_A, "0.31");
    await feed(harness, open, book);
    expect(harness.seen.slice(start).map((entry) => [entry.callback, entry.source])).toEqual([["onMarketOpen", idOf(open)]]);
    // The book event's onFeatures is owed, not evaluated: it comes at the first close the cadence allows.
    const later = reference(S + 1_000);
    await feed(harness, later);
    expect(featureCalls(harness, start)).toEqual([
      ["A", idOf(later), iso(S + 1_000)],
      ["B", idOf(later), iso(S + 1_000)],
    ]);
  });

  it("under the per-frame value 0 the same events evaluate in place at every event, as ADR-024 did", async () => {
    ordinal = 0;
    const harness = assemble({ cadence: PER_FRAME });
    await feed(harness, ...opening());
    const start = harness.seen.length;
    const open = opened(S + 200, MARKET_A);
    const book = level(S + 300, MARKET_A, "0.31");
    await feed(harness, open, book);
    expect(harness.seen.slice(start).map((entry) => [entry.callback, entry.source])).toEqual([
      ["onMarketOpen", idOf(open)],
      ["onFeatures", idOf(book)],
    ]);
    expect(harness.loop.health().loop.evaluationsCoalesced).toBe(0);
  });
});

describe("acceptance 9, ADR-026 D2.10: a forward jump in event time", () => {
  const HOUR = 3_600_000;

  it("holds onFeatures — owed or by heartbeat — until the clock has moved on by the interval, and raises the alarm", async () => {
    ordinal = 0;
    const harness = assemble({ cadence: PAPER_EVALUATION_CADENCE });
    await feed(harness, ...opening());
    const start = harness.seen.length;
    const jump = level(HOUR, MARKET_A, "0.31");
    await feed(harness, jump);
    // A owed and due; B by heartbeat (its last is S, an hour before).
    expect(featureCalls(harness, start)).toEqual([
      ["A", idOf(jump), iso(HOUR)],
      ["B", idOf(jump), iso(HOUR)],
    ]);
    // Twenty seconds of ordinary stamps, both markets touched every second: nothing is evaluated.
    for (let offset = S + 1_000; offset <= S + 20_000; offset += 1_000) {
      await feed(harness, level(offset, MARKET_A, "0.3"), level(offset + 1, MARKET_B, "0.3"));
    }
    expect(featureCalls(harness, start)).toHaveLength(2);
    expect(harness.loop.health().loop.cadenceForwardJumpAlarms).toBe(40);
    expect(harness.alarms).toEqual([
      { kind: "RAISED", eventAt: iso(S + 1_000), clockAt: iso(HOUR), behindMs: HOUR - S - 1_000, boundMs: 5_000 },
    ]);
    // Stamps catch up to within the bound: the episode ends; still no evaluation before HOUR + 1,000.
    await feed(harness, level(HOUR - 5_000, MARKET_A, "0.31"), level(HOUR + 999, MARKET_A, "0.3"));
    expect(featureCalls(harness, start)).toHaveLength(2);
    expect(harness.alarms.at(-1)).toEqual({ kind: "CLEARED", eventAt: iso(HOUR - 5_000), clockAt: iso(HOUR), behindMs: 5_000, boundMs: 5_000 });
    const end = level(HOUR + 1_000, MARKET_A, "0.31");
    await feed(harness, end);
    expect(featureCalls(harness, start).slice(2)).toEqual([
      ["A", idOf(end), iso(HOUR + 1_000)],
      ["B", idOf(end), iso(HOUR + 1_000)],
    ]);
    expect(harness.loop.health().loop.cadenceForwardJumpAlarms).toBe(40);
    expect(harness.halts.records()).toEqual([]);
  });

  it("every other callback still fires during the hold", async () => {
    ordinal = 0;
    const harness = assemble({ cadence: PAPER_EVALUATION_CADENCE });
    await feed(harness, ...opening(), level(HOUR, MARKET_A, "0.31"));
    const start = harness.seen.length;
    const open = opened(S + 2_000, MARKET_B);
    await feed(harness, open);
    expect(harness.seen.slice(start).map((entry) => [entry.callback, entry.source])).toEqual([["onMarketOpen", idOf(open)]]);
    expect(harness.loop.health().loop.cadenceForwardJumpAlarms).toBe(1);
  });

  it("a throwing alarm hook changes nothing the loop does", async () => {
    const run = async (hook: (alarm: CadenceAlarm) => void): Promise<string> => {
      ordinal = 0;
      const harness = assemble({ cadence: PAPER_EVALUATION_CADENCE });
      // The harness's hook pushes into `alarms`; route that push to `hook`.
      harness.alarms.push = (...items: CadenceAlarm[]): number => {
        for (const item of items) hook(item);
        return 0;
      };
      await feed(harness, ...opening(), level(HOUR, MARKET_A, "0.31"), level(S + 1_000, MARKET_A, "0.3"), level(HOUR + 1_000, MARKET_A, "0.31"));
      return JSON.stringify({ seen: harness.seen, loop: harness.loop.health().loop, halts: harness.halts.records() });
    };
    let raised = 0;
    const quiet = await run(() => {
      raised += 1;
    });
    const throwing = await run(() => {
      throw new Error("a log sink that fails");
    });
    expect(raised).toBe(2);
    expect(throwing).toBe(quiet);
  });
});

describe("ADR-026 D2.11 (corrected 2026-10-03): a halted market is not evaluated, and its owed evaluation is dropped", () => {
  it("a market halted while owed is neither evaluated nor counted as coalesced afterwards; the other market goes on", async () => {
    ordinal = 0;
    const harness = assemble({ cadence: PAPER_EVALUATION_CADENCE });
    await feed(harness, ...opening(), level(S + 300, MARKET_A, "0.31"));
    const coalesced = harness.loop.health().loop.evaluationsCoalesced;
    harness.halts.halt({ kind: "MARKET", marketId: MARKET_A }, "OPERATOR_HALT", "test", iso(S + 400));
    const start = harness.seen.length;
    const first = level(S + 1_000, MARKET_B, "0.31");
    const second = level(S + 6_000, MARKET_B, "0.3");
    await feed(harness, first, second);
    expect(featureCalls(harness, start)).toEqual([
      ["B", idOf(first), iso(S + 1_000)],
      ["B", idOf(second), iso(S + 6_000)],
    ]);
    expect(harness.loop.health().loop.evaluationsCoalesced).toBe(coalesced);
  });
});

describe("edges of one close", () => {
  it("a market named twice by ONE event is decided once at its close: evaluated once, never also coalesced and carried", async () => {
    ordinal = 0;
    const harness = assemble({ cadence: PAPER_EVALUATION_CADENCE });
    await feed(harness, ...opening());
    const coalesced = harness.loop.health().loop.evaluationsCoalesced;
    const start = harness.seen.length;
    const incident = event(S + 1_000, "DataQualityIncidentOpened", {
      incidentId: "cadence1-incident",
      openedAt: iso(S + 1_000),
      reasonCode: "FEED_STALE",
      severity: "NOTIFY",
      affectedMarketIds: [MARKET_A, MARKET_A],
    });
    await feed(harness, incident);
    expect(featureCalls(harness, start)).toEqual([["A", idOf(incident), iso(S + 1_000)]]);
    expect(harness.loop.health().loop.evaluationsCoalesced).toBe(coalesced);
    // Nothing was left owed: a later close that allows a carried evaluation evaluates nothing.
    await feed(harness, snapshot(S + 2_000, MARKET_X, "yes"));
    expect(featureCalls(harness, start)).toHaveLength(1);
  });

  it("a longer frame of events for no configured market, at which heartbeats run, reaches the harvest point: harvested and flushed at its close", async () => {
    ordinal = 0;
    const harness = assemble({ cadence: PAPER_EVALUATION_CADENCE, placeOnOpen: true });
    await feed(harness, ...opening(), opened(S + 100, MARKET_A));
    expect(harness.venue.ordersSnapshot()).toHaveLength(1);
    const start = harness.seen.length;
    const decided = harness.store.decisions.length;
    const x1 = snapshot(S + 5_000, MARKET_X, "yes", "u1");
    const x2 = snapshot(S + 5_001, MARKET_X, "no", "u1");
    await feed(harness, [x1, x2]);
    expect(harness.seen.slice(start).map((entry) => [entry.instanceId === INSTANCE_A ? "A" : "B", entry.callback, entry.source])).toEqual([
      ["A", "onFeatures", idOf(x2)],
      ["B", "onFeatures", idOf(x2)],
      ["A", "onOrderUpdate", undefined],
    ]);
    // Flushed at this close, not left in the outbox for a later one.
    expect(harness.store.decisions.length).toBe(decided + 3);
  });
});

describe("the one place harvest points differ: an event at which the cadence evaluates, and which ADR-024 left unharvested", () => {
  it("a heartbeat at a lone event for a market this trader does not run is followed by that event's harvest (its fills booked before the next evaluation reads the position)", async () => {
    const run = async (cadence: EvaluationCadenceOption): Promise<Seen[]> => {
      ordinal = 0;
      const harness = assemble({ cadence, placeOnOpen: true });
      await feed(harness, ...opening(), opened(S + 100, MARKET_A));
      expect(harness.venue.ordersSnapshot()).toHaveLength(1);
      const start = harness.seen.length;
      await feed(harness, snapshot(S + 5_100, MARKET_X, "yes"));
      return harness.seen.slice(start);
    };
    // Per frame: an event for no configured market evaluates nothing and harvests nothing.
    expect(await run(PER_FRAME)).toEqual([]);
    // PAPER: both markets' heartbeats run there, and the harvest that follows every
    // evaluation delivers the resting order's WORKING view, as at every harvest.
    const paper = await run(PAPER_EVALUATION_CADENCE);
    expect(paper.map((entry) => `${entry.instanceId === INSTANCE_A ? "A" : "B"}:${entry.callback}`)).toEqual([
      "A:onFeatures",
      "B:onFeatures",
      "A:onOrderUpdate",
    ]);
  });
});
