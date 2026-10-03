/**
 * `FOLD-1` — the core loop's HELD accounting state and the rebuild checks
 * (`folds.ts`), through the REAL `CoreLoop`.
 *
 * What is pinned here:
 *
 * - held equals rebuilt over a LONG deterministic synthetic run (1,000+
 *   fills, NOT a soak — §16.7) with the ledger check after every fill, and
 *   the held PnL state equal to `foldPnlRecords` at intervals and at the end;
 * - the test cadence (`EVERY_FILL_ACCOUNTING_CHECKS`) with the PnL check on;
 * - the PAPER cadence: a check at posted fill 50, 100, 150 and at the end of
 *   the run, and `projectLedger` called at construction and in checks ONLY —
 *   never per event (the `LOOPMEM-FOLD` cost this round removes);
 * - a corrupted held view (the documented container-guard bypass) and a
 *   broken incremental step are CAUGHT: a GLOBAL `ACCOUNTING_REBUILD_MISMATCH`
 *   halt, counted, the held view replaced by the rebuild;
 * - a fold that fails is treated exactly as a failed posting;
 * - a refused PnL record stops that instance's snapshots at the SAME fill a
 *   from-zero fold would (today's behaviour), now COUNTED (ruling F3) —
 *   since `SNAP-1` one row per instance per INSTANT, the last of base's rows
 *   at that instant;
 * - round 1: EVERY due posted fill runs every enabled check — an UNOWNED
 *   fill, and an owned fill whose ledger-store write fails, included
 *   (`FOLD1-R1-2`); and a PnL check answers for the WHOLE record list, so a
 *   stream a store failure left behind is caught up before it is compared,
 *   never certified behind (`FOLD1-R1-1`);
 * - `SNAP-1` (the last two describe blocks): ONE PnL snapshot per instance per
 *   instant — the `pnl_snapshots_scope_unique` key, which the in-memory store
 *   now enforces too — equal byte for byte to the last per-fill row base
 *   wrote at that instant; since r1, a LATER event at the same instant (a
 *   second tick, or an exit submitted from `onFill`) REPLACES that row with
 *   the state after its last fill, and the TRDR-3 book follows it; instants
 *   that go backwards each keep their own row; and what a halt latched
 *   mid-harvest — or a refused replacement — does to the staged row. This
 *   harness books ten fills per event, so every tick is the shape the key
 *   used to refuse.
 *
 * WHAT IS REAL: the `CoreLoop`, the strategy RUNTIME, the feature engine,
 * books, capital allocator, risk engine, execution planner, `SimulatedVenue`
 * (Tier 0), ledger and PnL. WHAT IS DOUBLED: the clock, the durable store
 * (the trader's own in-memory doubles) and the strategy — a cycling double
 * that places an immediate BUY of 50 (ten 5-share slices, each FILLED) and
 * then sells the whole holding, so every tick books ten fills. `createPaperTrader`
 * cannot be used: its strategy is Static Bracket, which opens at most
 * `reentry.maximum_entries_per_market` brackets per market (it used to pause
 * after the first, `RISK-2` residual 5, closed by `BRACKET-1a`) — a handful of
 * fills, not ten per tick.
 *
 * THE TEST SEAM is a PASS-THROUGH `vi.mock` of `@polymarket-bot/ledger`: it
 * counts `projectLedger` calls, and a test may wrap ONE export — the
 * incremental step `applyTransaction`, or `buildFillPosting` — to break it on
 * purpose. `projectLedger` folds with the package's module-internal step, so
 * a broken EXPORTED step breaks only the loop's held view, never the rebuild
 * the check compares it with. Every hook is off unless a test sets it.
 */

import { parseAllocatorCaps } from "@polymarket-bot/capital-allocator";
import type { DecisionResult, EventEnvelope, Intent } from "@polymarket-bot/domain";
import type * as LedgerModule from "@polymarket-bot/ledger";
import { Ledger } from "@polymarket-bot/ledger";
import {
  computePnlSnapshot,
  foldPnlRecords,
  serializePnlState,
  type PnlRecord,
  type PnlSnapshot,
  type PnlStreamIdentity,
} from "@polymarket-bot/pnl";
import { parseRiskPolicy } from "@polymarket-bot/risk";
import {
  SimulatedVenue,
  readFeeScheduleSnapshot,
  tier0Model,
  unmodeledRateLimits,
  type BookView,
  type FeeScheduleSnapshot,
} from "@polymarket-bot/simulation";
import { createStrategyInstanceRuntime } from "@polymarket-bot/strategy-runtime";
import type { Strategy, StrategyContext } from "@polymarket-bot/strategy-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { DeterministicIdFactory, type PostingIdentity } from "@polymarket-bot/trading-core";
import { AllocatorGate, allocationMarketOf, type AllocationMarket } from "@polymarket-bot/trading-core";
import { configuredFeatureKeys, parseTraderConfig } from "@polymarket-bot/trading-core";
import {
  EVERY_FILL_ACCOUNTING_CHECKS,
  PAPER_ACCOUNTING_CHECKS,
  type AccountingChecks,
} from "@polymarket-bot/trading-core";
import { HaltController } from "@polymarket-bot/trading-core";
import { PER_FRAME_EVALUATION_CADENCE } from "@polymarket-bot/trading-core";
import { HealthState, RealizedPnlBook } from "@polymarket-bot/trading-core";
import { healthResponseBody } from "./health-server.js";
import { InstanceRegistry } from "@polymarket-bot/trading-core";
import { CoreLoop, DecisionOutboxBuffer, type TraderVenue } from "@polymarket-bot/trading-core";
import { MarketState } from "@polymarket-bot/trading-core";
import { observeRealizedPnl } from "./pnl-observation.js";
import { portFailed, type IngestedEvent } from "@polymarket-bot/trading-core";
import { REPOSITORY_MAXIMUM_RUN_MODE, TRADER_RUN_MODE } from "@polymarket-bot/trading-core";
import { ManualClock, MemoryTraderStore } from "./testing/index.js";
import { formatStrictUtc } from "@polymarket-bot/trading-core";

type ApplyTransaction = typeof LedgerModule.applyTransaction;
type BuildFillPosting = typeof LedgerModule.buildFillPosting;
type FillsPage = ReturnType<TraderVenue["fillsSince"]>;

const hooks = vi.hoisted(() => ({
  projectLedgerCalls: 0,
  /** Rewrites the venue's fill pages on their way to the loop (`FOLD1-R1-2`: fills no order of the loop's owns). */
  fillsPage: undefined as ((page: FillsPage) => FillsPage) | undefined,
  applyTransaction: undefined as
    | ((original: ApplyTransaction, ...args: Parameters<ApplyTransaction>) => ReturnType<ApplyTransaction>)
    | undefined,
  buildFillPosting: undefined as
    | ((result: ReturnType<BuildFillPosting>) => ReturnType<BuildFillPosting>)
    | undefined,
}));

vi.mock("@polymarket-bot/ledger", async (importOriginal) => {
  const original = await importOriginal<typeof LedgerModule>();
  return {
    ...original,
    projectLedger(...args: Parameters<typeof original.projectLedger>) {
      hooks.projectLedgerCalls += 1;
      return original.projectLedger(...args);
    },
    applyTransaction(...args: Parameters<ApplyTransaction>) {
      const hook = hooks.applyTransaction;
      return hook === undefined ? original.applyTransaction(...args) : hook(original.applyTransaction, ...args);
    },
    buildFillPosting(...args: Parameters<BuildFillPosting>) {
      const result = original.buildFillPosting(...args);
      const hook = hooks.buildFillPosting;
      return hook === undefined ? result : hook(result);
    },
  };
});

/** The UNMOCKED package, for this file's own independent rebuilds. */
const actual = await vi.importActual<typeof LedgerModule>("@polymarket-bot/ledger");

afterEach(() => {
  hooks.applyTransaction = undefined;
  hooks.buildFillPosting = undefined;
  hooks.fillsPage = undefined;
});

const MARKET_ID = "018f5c20-1000-7a10-8b00-0000000000f1";
const CONDITION_ID = "0xfold1";
const YES_TOKEN = "8001";
const NO_TOKEN = "8002";
const INSTANCE_ID = "e18f5c20-2000-7a20-8b00-0000000000f2";
const RUN_ID = "018f5c20-3000-7a30-8b00-0000000000f3";
const CONFIG_ID = "018f5c20-4000-7a40-8b00-0000000000f4";
const GATEWAY_EPOCH = "018f5c20-5000-7a50-8b00-0000000000f5";
const ACCOUNT_REF = "fold1-paper-account";
const T_START_MS = Date.parse("2026-05-01T09:00:00.000Z");
const T_OPEN = "2026-05-01T09:00:00.000Z";
const T_CLOSE = "2026-05-02T09:00:00.000Z";
const STEP_MS = 100;

function feeSnapshot(): FeeScheduleSnapshot {
  return {
    snapshotVersion: "fold1.sim.2026-05-01",
    takerFeeRate: "0.0195",
    makerFeeRate: "0",
    roundingDecimalPlaces: 3,
    roundingMode: "HALF_UP",
    minimumChargedFee: "0",
    feeCurrency: "pUSD",
  };
}

function traderConfig(): Record<string, unknown> {
  const fees = feeSnapshot();
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
      accountRef: ACCOUNT_REF,
      denominationAssetId: "pUSD",
      venueClearingRef: "fold1-venue-clearing",
      attributionClearingRef: "fold1-attribution-clearing",
      feeExpenseRef: "fold1-fee-expense",
      startingCash: "1000",
    },
    queues: { ingestMaximumDepth: 1024, outboxMaximumDepth: 1024 },
    features: {
      depthLevels: [1, 2, 5],
      executableShares: ["50"],
      tradeWindowMs: 5_000,
      ewmaLambda: "0.94",
      primaryReferenceVenue: "binance",
    },
    planning: {
      maxSliceShares: "5",
      marketableSlippageTicks: 2,
      replaceThresholdTicks: 1,
      minimumReplaceIntervalMs: 500,
      cancelDeadlineMs: 5_000,
      maxPlanLifetimeMs: 30_000,
    },
    simulation: {
      fillModelVersion: "tier0.fold1",
      fillModelParametersHash: "d".repeat(64),
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
    infrastructure: {
      eventStream: "polymarket.normalized",
      consumerId: "fold-1",
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
        closeTime: T_CLOSE,
        seriesKey: "fold1-sim",
        underlyingKey: "SIMBTC",
        resolutionWindowKey: "w2026-05-02T09.00",
      },
    ],
    instances: [
      {
        instanceId: INSTANCE_ID,
        runId: RUN_ID,
        configId: CONFIG_ID,
        runSeed: "7",
        marketId: MARKET_ID,
        ownership: "OWNER",
        evaluationPriority: 0,
        evaluationBudgetUs: 5_000_000,
        params: {},
      },
    ],
  };
}

type CyclingState = { readonly step?: number; readonly exited?: boolean };

function hold(ctx: StrategyContext): DecisionResult {
  return { decisionType: "hold", reasonCodes: ["FOLD1.HOLD"], featureSnapshotRef: ctx.features().snapshotRef, intents: [] };
}

function validUntil(ctx: StrategyContext): string {
  return new Date(Date.parse(ctx.now()) + 30_000).toISOString();
}

/** Every tick: an immediate BUY of 50 (ten FILLED slices), or the SELL of the whole holding. */
const roundTrips: Strategy<unknown, CyclingState> = {
  name: "fold1-round-trip-double",
  version: "1.0.0",
  paramsSchema: z.strictObject({}),
  stateSchemaVersion: 1,
  onStart: hold,
  onMarketOpen: hold,
  onTimer: hold,
  onFill: (ctx: StrategyContext) => hold(ctx),
  onOrderUpdate: (ctx: StrategyContext) => hold(ctx),
  onMarketClosing: (ctx: StrategyContext) => hold(ctx),
  onMarketResolved: (ctx: StrategyContext) => hold(ctx),
  onStop: (ctx: StrategyContext) => hold(ctx),
  onFeatures(ctx: StrategyContext): DecisionResult {
    const step = ctx.state<CyclingState>().step ?? 0;
    const base = { reasonCodes: ["FOLD1.STEP"], featureSnapshotRef: ctx.features().snapshotRef, statePatch: { step: step + 1 } };
    const held = ctx.position().yesShares;
    if (held !== "0") {
      const sell: Intent = {
        type: "POSITION",
        intentId: `fold1-sell-${String(step)}`,
        marketId: MARKET_ID,
        direction: "YES",
        targetMode: "DELTA",
        targetShares: `-${held}`,
        minimumSellPrice: "0.3",
        urgency: "IMMEDIATE",
        liquidityPreference: "TAKER_OK",
        partialFillPolicy: "ACCEPT_ANY",
        validUntil: validUntil(ctx),
        tags: ["fold1.exit", "sb.order-type:FAK"],
      };
      return { ...base, decisionType: "exit" as const, intents: [sell] };
    }
    const buy: Intent = {
      type: "POSITION",
      intentId: `fold1-buy-${String(step)}`,
      marketId: MARKET_ID,
      direction: "YES",
      targetMode: "DELTA",
      targetShares: "50",
      maximumBuyPrice: "0.35",
      maximumTotalCost: "18",
      urgency: "IMMEDIATE",
      liquidityPreference: "TAKER_OK",
      partialFillPolicy: "ACCEPT_ANY",
      validUntil: validUntil(ctx),
      expectedNetEdge: "5",
      tags: ["fold1.entry", "sb.order-type:FAK"],
    };
    return { ...base, decisionType: "enter" as const, intents: [buy] };
  },
};

interface Harness {
  readonly loop: CoreLoop;
  readonly store: MemoryTraderStore;
  /**
   * `SNAP-1` r1: the TRDR-3 realized-PnL book, when `assemble` was asked to
   * observe the store the way the composition root does (`observeRealizedPnl`).
   */
  readonly book: RealizedPnlBook | undefined;
  ordinal: number;
}

/**
 * `createPaperTrader`'s assembly, with the round-trip double's runtime registered.
 *
 * `SNAP-1` r1 (both optional, absent everywhere before it): `observe` wraps the
 * store in the composition root's `observeRealizedPnl` decorator with a fresh
 * book, and `strategy` registers another strategy in the round-trip double's
 * place.
 */
function assemble(
  accountingChecks: AccountingChecks | undefined,
  options: { readonly observe?: boolean; readonly strategy?: Strategy<unknown, CyclingState> } = {},
): Harness {
  const parsed = parseTraderConfig(traderConfig());
  if (!parsed.ok) throw new Error(`config refused: ${parsed.refusal.detail} ${parsed.refusal.issues.join("; ")}`);
  const config = parsed.config;
  const policy = parseRiskPolicy(config.riskPolicy);
  if (!policy.ok) throw new Error("risk policy refused");
  const caps = parseAllocatorCaps(config.allocatorCaps);
  if (!caps.ok) throw new Error("allocator caps refused");
  const clock = new ManualClock(T_OPEN);
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
    strategy: options.strategy ?? roundTrips,
    params: {},
    run: { runId: RUN_ID, instanceId: INSTANCE_ID, configId: CONFIG_ID, runSeed: "7" },
    watchdog: { evaluationBudgetUs: 5_000_000 },
    clock: { nowNs: () => clock.monotonicNs() },
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
  const venue = new SimulatedVenue({
    clock,
    runMode: "PAPER",
    model: tier0Model({ fillModelVersion: "tier0.fold1", fillModelParametersHash: "d".repeat(64) }),
    feeSnapshot: fees.value,
    rateLimits: unmodeledRateLimits("no venue rate-limit budget is modelled in this synthetic run"),
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
  const book = options.observe === true ? new RealizedPnlBook() : undefined;
  // The venue as the loop sees it: pass-through, except that a test may
  // rewrite the fill pages (`hooks.fillsPage`). Every other member is the
  // venue's own, bound to it (its state is in private fields).
  const port = new Proxy(venue, {
    get(target, property): unknown {
      if (property === "fillsSince") {
        return (sequence: number): FillsPage => {
          const page = target.fillsSince(sequence);
          const rewrite = hooks.fillsPage;
          return rewrite === undefined ? page : rewrite(page);
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  const loop = new CoreLoop({
    config,
    riskPolicy: policy.value,
    allocator: new AllocatorGate({ caps: caps.value, markets: allocationMarkets, tokenAssetIds }),
    clock,
    venue: port,
    store: book === undefined ? store : observeRealizedPnl(store, book),
    registry,
    markets,
    instanceConfigs: new Map(),
    ledger: Ledger.empty(config.environment),
    ids: new DeterministicIdFactory("fold-1"),
    health: new HealthState({ runMode: TRADER_RUN_MODE, maximumRunMode: REPOSITORY_MAXIMUM_RUN_MODE }),
    halts: new HaltController(),
    featureKeys: configuredFeatureKeys(config),
    posting,
    tokenAssetIds,
    outbox,
    ...(accountingChecks === undefined ? {} : { accountingChecks }),
    // `CADENCE-1` (ADR-026 D1.6): this harness's timelines were written for,
    // and pin, ADR-024's per-frame cadence — fills booked at named events, several at one
    // instant. They are not about
    // the cadence, so they REPRODUCE that cadence (the value 0, declared);
    // the cadence itself is pinned by `cadence.test.ts` and
    // `loop-cadence.test.ts`.
    evaluationCadence: { ...PER_FRAME_EVALUATION_CADENCE, reproduces: "adr-024:apps/trader/src/loop-folds.test.ts" },
  });
  wiring.loop = loop;
  return { loop, store, book, ordinal: 0 };
}

function envelope(
  ordinal: number,
  eventType: string,
  payload: unknown,
  source: "polymarket" | "binance" = "polymarket",
  /** `SNAP-1`: an explicit instant, for two events that share one (default: the ordinal's own). */
  at?: string,
): IngestedEvent {
  const receivedAt = at ?? new Date(T_START_MS + ordinal * STEP_MS).toISOString();
  const wire: EventEnvelope<unknown> = {
    eventId: `018f5c20-9000-7a90-8b00-${String(ordinal).padStart(12, "0")}`,
    eventType,
    schemaVersion: 1,
    source,
    sourceChannel: "market",
    receivedAt,
    receivedMonotonicNs: String(ordinal * 1_000_000),
    gatewayEpoch: GATEWAY_EPOCH,
    ingestSeq: String(ordinal),
    subscriptionGeneration: 1,
    payload,
  };
  return {
    envelope: wire,
    identity: { gatewayEpoch: GATEWAY_EPOCH, ingestSeq: String(ordinal), receivedAt, datasetRowOrdinal: ordinal },
  };
}

async function feed(harness: Harness, event: (ordinal: number) => IngestedEvent): Promise<void> {
  harness.ordinal += 1;
  if (!harness.loop.ingest(event(harness.ordinal))) throw new Error(`ingest refused event ${String(harness.ordinal)}`);
  await harness.loop.drain();
}

/** The reference print, the market opening and the NO book; then the harness is ready to tick. */
async function open(harness: Harness): Promise<void> {
  await feed(harness, (n) => envelope(n, "ReferenceTradeObserved", { venue: "binance", symbol: "BTCUSDT", price: "64000", size: "0.5" }, "binance"));
  await feed(harness, (n) => envelope(n, "MarketOpened", { internalMarketId: MARKET_ID, conditionId: CONDITION_ID, openedAt: T_OPEN }));
  await feed(harness, (n) =>
    envelope(n, "BookSnapshot", {
      internalMarketId: MARKET_ID,
      tokenId: NO_TOKEN,
      bids: [{ price: "0.65", size: "5000" }],
      asks: [{ price: "0.66", size: "5000" }],
    }),
  );
}

/**
 * One strategy step: a deep YES snapshot — a BUY of 50 or a SELL of the
 * holding, ten fills either way. `at` (`SNAP-1`) places it at an explicit
 * instant instead of its ordinal's.
 */
async function tick(harness: Harness, at?: string): Promise<void> {
  await feed(harness, (n) =>
    envelope(
      n,
      "BookSnapshot",
      {
        internalMarketId: MARKET_ID,
        tokenId: YES_TOKEN,
        bids: [
          { price: "0.32", size: "5000" },
          { price: "0.31", size: "5000" },
        ],
        asks: [
          { price: "0.34", size: "5000" },
          { price: "0.35", size: "5000" },
        ],
      },
      "polymarket",
      at,
    ),
  );
}

/** Yields to the macrotask queue so a long synchronous stretch never starves the worker (CI-2). */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

function identity(): PnlStreamIdentity {
  return {
    scope: "VIRTUAL_STRATEGY",
    environment: "PAPER",
    accountRef: ACCOUNT_REF,
    instanceId: INSTANCE_ID,
    runId: RUN_ID,
    marketId: MARKET_ID,
  };
}

/** The held view against this file's OWN rebuild (the unmocked package), bytes AND Map order. */
function expectViewEqualsRebuild(loop: CoreLoop): void {
  const held = loop.ledgerView();
  const rebuilt = actual.projectLedger(loop.ledger());
  expect(actual.serializeProjection(held)).toBe(actual.serializeProjection(rebuilt));
  expect([...held.balances.keys()]).toEqual([...rebuilt.balances.keys()]);
  expect([...held.virtualPositions.keys()]).toEqual([...rebuilt.virtualPositions.keys()]);
  expect(held.transactionCount).toBe(loop.ledger().length);
}

/** The held PnL state against `foldPnlRecords` over the instance's whole stream. */
function expectPnlEqualsRebuild(loop: CoreLoop): void {
  const held = loop.pnlState(INSTANCE_ID);
  expect(held).toBeDefined();
  if (held === undefined) return;
  const rebuilt = foldPnlRecords(identity(), loop.pnlRecords(INSTANCE_ID));
  expect(rebuilt.ok).toBe(true);
  if (!rebuilt.ok) return;
  expect(serializePnlState(held)).toBe(serializePnlState(rebuilt.value));
}

describe("FOLD-1: held equals rebuilt over a long synthetic run (NOT a soak — §16.7)", () => {
  it(
    "over 1,000+ fills with the ledger check after EVERY fill: every check ran and matched; the held view and PnL state equal their rebuilds",
    async () => {
      const harness = assemble({ everyFills: 1, pnl: false });
      await open(harness);
      let lastPnlCompare = 0;
      while (harness.loop.health().seams.folds.fillsPosted < 1_000) {
        expect(harness.ordinal, "the synthetic run stopped filling").toBeLessThan(200);
        await tick(harness);
        const folds = harness.loop.health().seams.folds;
        // Every posted fill was checked, and no check found a difference.
        expect(folds.ledgerChecks).toBe(folds.fillsPosted);
        expect(folds.fillsAtLastCheck).toBe(folds.fillsPosted);
        expect(folds.ledgerMismatches).toBe(0);
        if (folds.fillsPosted - lastPnlCompare >= 100) {
          expectPnlEqualsRebuild(harness.loop);
          lastPnlCompare = folds.fillsPosted;
        }
        await yieldToEventLoop();
      }
      const health = harness.loop.health();
      expect(health.halts).toEqual([]);
      expect(health.seams.folds).toMatchObject({
        checkEveryFills: 1,
        pnlCheck: false,
        pnlChecks: 0,
        ledgerMismatches: 0,
        pnlMismatches: 0,
        pnlRefusals: {},
      });
      expect(health.seams.folds.fillsPosted).toBeGreaterThanOrEqual(1_000);
      expect(health.execution.fillsObserved).toBe(health.seams.folds.fillsPosted);
      // Three transactions per fill (principal, token, fee) — the paper shape.
      expect(harness.loop.ledger().length).toBe(3 * health.seams.folds.fillsPosted);
      expectViewEqualsRebuild(harness.loop);
      expectPnlEqualsRebuild(harness.loop);
      // Every INSTANT with fills wrote its snapshot — nothing refused, nothing
      // skipped. `SNAP-1` (one snapshot per instance per instant, the
      // database's key): every tick is one event booking ten fills, so ONE row
      // per tick, not one per fill as before; each at its own instant.
      expect(health.seams.folds.fillsPosted % 10).toBe(0);
      expect(harness.store.pnlSnapshots).toHaveLength(health.seams.folds.fillsPosted / 10);
      expect(new Set(harness.store.pnlSnapshots.map((snapshot) => snapshot.asOf)).size).toBe(
        harness.store.pnlSnapshots.length,
      );
      // And the end-of-run check agrees.
      expect(harness.loop.checkAccountingRebuild("END_OF_RUN")).toEqual({ matched: true, pnlStreamsChecked: 0 });
    },
    600_000,
  );

  it("the test cadence (EVERY_FILL_ACCOUNTING_CHECKS) over 200+ fills: the ledger AND the PnL stream checked after every fill, all matched", async () => {
    const harness = assemble(EVERY_FILL_ACCOUNTING_CHECKS);
    await open(harness);
    while (harness.loop.health().seams.folds.fillsPosted < 200) {
      await tick(harness);
      await yieldToEventLoop();
    }
    const folds = harness.loop.health().seams.folds;
    expect(harness.loop.health().halts).toEqual([]);
    expect(folds).toEqual({
      checkEveryFills: 1,
      pnlCheck: true,
      fillsPosted: folds.fillsPosted,
      ledgerChecks: folds.fillsPosted,
      // One held stream, compared after every (owned) fill.
      pnlChecks: folds.fillsPosted,
      fillsAtLastCheck: folds.fillsPosted,
      ledgerMismatches: 0,
      pnlMismatches: 0,
      pnlRefusals: {},
    });
    expect(harness.loop.checkAccountingRebuild("END_OF_RUN")).toEqual({ matched: true, pnlStreamsChecked: 1 });
    expect(harness.loop.health().seams.folds).toMatchObject({
      ledgerChecks: folds.fillsPosted + 1,
      pnlChecks: folds.fillsPosted + 1,
    });
    expectViewEqualsRebuild(harness.loop);
    expectPnlEqualsRebuild(harness.loop);
  }, 120_000);
});

describe("FOLD-1: the PAPER cadence, and no fold from zero per event", () => {
  it("checks at posted fill 50, 100, 150 and at the end of the run; projectLedger runs at construction and in those checks ONLY", async () => {
    const before = hooks.projectLedgerCalls;
    const harness = assemble(undefined);
    // Construction: the one fold from zero outside the checks.
    expect(hooks.projectLedgerCalls - before).toBe(1);
    await open(harness);
    const perEvent: number[] = [];
    const checkedAt: number[] = [];
    let lastChecks = 0;
    while (harness.loop.health().seams.folds.fillsPosted < 150) {
      const calls = hooks.projectLedgerCalls;
      await tick(harness);
      perEvent.push(hooks.projectLedgerCalls - calls);
      const folds = harness.loop.health().seams.folds;
      // One call per check the event ran, and nothing else.
      expect(hooks.projectLedgerCalls - calls).toBe(folds.ledgerChecks - lastChecks);
      if (folds.ledgerChecks > lastChecks) checkedAt.push(folds.fillsAtLastCheck ?? -1);
      lastChecks = folds.ledgerChecks;
    }
    const folds = harness.loop.health().seams.folds;
    expect(folds.fillsPosted).toBe(150);
    expect(checkedAt).toEqual([50, 100, 150]);
    expect(folds).toEqual({
      checkEveryFills: PAPER_ACCOUNTING_CHECKS.everyFills,
      pnlCheck: false,
      fillsPosted: 150,
      ledgerChecks: 3,
      pnlChecks: 0,
      fillsAtLastCheck: 150,
      ledgerMismatches: 0,
      pnlMismatches: 0,
      pnlRefusals: {},
    });
    // Fifteen ten-fill events, and a from-zero fold in only the three that crossed a multiple of 50.
    expect(perEvent).toHaveLength(15);
    expect(perEvent.filter((count) => count > 0)).toHaveLength(3);
    expect(hooks.projectLedgerCalls - before).toBe(1 + 3);

    // The end of the run: one more ledger check; no PnL check in PAPER (ruling F2).
    expect(harness.loop.checkAccountingRebuild("END_OF_RUN")).toEqual({ matched: true, pnlStreamsChecked: 0 });
    expect(harness.loop.health().seams.folds).toMatchObject({ ledgerChecks: 4, pnlChecks: 0, fillsAtLastCheck: 150 });
    expect(hooks.projectLedgerCalls - before).toBe(1 + 4);
    expect(harness.loop.checkAccountingRebuild("SHUTDOWN").matched).toBe(true);
    expect(harness.loop.health().halts).toEqual([]);
    expectViewEqualsRebuild(harness.loop);
    expectPnlEqualsRebuild(harness.loop);
  }, 120_000);
});

describe("FOLD-1: a held state that diverges from its rebuild is CAUGHT — GLOBAL ACCOUNTING_REBUILD_MISMATCH", () => {
  it("an in-place corruption of the held view (the container guard's documented bypass) halts GLOBAL at the next check, counted; the view is replaced by the rebuild", async () => {
    const harness = assemble(EVERY_FILL_ACCOUNTING_CHECKS);
    await open(harness);
    await tick(harness);
    expect(harness.loop.health().halts).toEqual([]);
    const posted = harness.loop.health().seams.folds.fillsPosted;
    expect(posted).toBe(10);

    // `Map.prototype.set.call(guarded, k, v)` still reaches a frozen map's
    // internal slot (`packages/ledger/src/immutable.ts`): a held view can be
    // contaminated in place, and would carry it forward.
    const view = harness.loop.ledgerView();
    const [key, line] = [...view.balances.entries()][0] ?? [];
    expect(key).toBeDefined();
    if (key === undefined || line === undefined) return;
    Map.prototype.set.call(view.balances, key, { ...line, balance: "999" });

    await tick(harness);
    const health = harness.loop.health();
    expect(health.halts.map((halt) => [halt.scope.kind, halt.code, halt.action])).toEqual([
      ["GLOBAL", "ACCOUNTING_REBUILD_MISMATCH", "FULL_HALT"],
    ]);
    expect(health.halts[0]?.detail).toContain("the held ledger view differs from projectLedger(ledger)");
    expect(health.halts[0]?.detail).toContain(`after posted fill ${String(posted + 1)}`);
    expect(health.halts[0]?.detail).toContain("first difference at byte");
    expect(health.halts[0]?.detail).toContain("the view was replaced by the rebuild");
    expect(health.healthy).toBe(false);
    expect(health.seams.folds).toMatchObject({ ledgerMismatches: 1, pnlMismatches: 0 });
    // Replaced by the rebuild: every later check matches again, and the view is the ledger's.
    expectViewEqualsRebuild(harness.loop);
    expect(harness.loop.checkAccountingRebuild("END_OF_RUN").matched).toBe(true);
    expect(harness.loop.health().seams.folds.ledgerMismatches).toBe(1);
  });

  it("an in-place corruption is caught at SHUTDOWN too, on the PAPER cadence between two cadence checks", async () => {
    const harness = assemble(undefined);
    await open(harness);
    await tick(harness);
    const view = harness.loop.ledgerView();
    const [key, line] = [...view.virtualPositions.entries()][0] ?? [];
    expect(key).toBeDefined();
    if (key === undefined || line === undefined) return;
    Map.prototype.set.call(view.virtualPositions, key, { ...line, balance: "1" });
    // No cadence check is due at 10 fills, so nothing has noticed yet.
    expect(harness.loop.health().halts).toEqual([]);
    const answer = harness.loop.checkAccountingRebuild("SHUTDOWN");
    expect(answer).toEqual({ matched: false, pnlStreamsChecked: 0 });
    const health = harness.loop.health();
    expect(health.halts.map((halt) => [halt.scope.kind, halt.code])).toEqual([["GLOBAL", "ACCOUNTING_REBUILD_MISMATCH"]]);
    expect(health.halts[0]?.detail).toContain("at shutdown");
    expect(health.seams.folds).toMatchObject({ ledgerChecks: 1, ledgerMismatches: 1, fillsAtLastCheck: 10 });
    expectViewEqualsRebuild(harness.loop);
  });

  it("a broken incremental step that counts a transaction but folds nothing is caught by the rebuild check", async () => {
    const harness = assemble(EVERY_FILL_ACCOUNTING_CHECKS);
    await open(harness);
    await tick(harness);
    expect(harness.loop.health().halts).toEqual([]);
    // The next appended transaction is COUNTED but not folded: the view's
    // transaction count still matches the ledger, so only the bytes can tell.
    let broken = 0;
    hooks.applyTransaction = (original, projection, appended) => {
      if (broken > 0) return original(projection, appended);
      broken += 1;
      return Object.freeze({ ...projection, transactionCount: projection.transactionCount + 1 });
    };
    await tick(harness);
    expect(broken).toBe(1);
    const health = harness.loop.health();
    expect(health.halts.map((halt) => [halt.scope.kind, halt.code])).toEqual([["GLOBAL", "ACCOUNTING_REBUILD_MISMATCH"]]);
    expect(health.seams.folds.ledgerMismatches).toBe(1);
    expectViewEqualsRebuild(harness.loop);
  });

  it("a broken PnL advance is caught by the PnL check (test cadence): GLOBAL halt, counted, the stream replaced by its rebuild", async () => {
    const harness = assemble(EVERY_FILL_ACCOUNTING_CHECKS);
    await open(harness);
    await tick(harness);
    // Corrupt the HELD PnL state in place — its lots map — the same bypass.
    const state = harness.loop.pnlState(INSTANCE_ID);
    expect(state).toBeDefined();
    if (state === undefined) return;
    const [lotKey, lot] = [...state.lots.entries()][0] ?? [];
    expect(lotKey).toBeDefined();
    if (lotKey === undefined || lot === undefined) return;
    Map.prototype.set.call(state.lots, lotKey, { ...lot, shares: "1" });
    await tick(harness);
    const health = harness.loop.health();
    expect(health.halts.map((halt) => [halt.scope.kind, halt.code])).toEqual([["GLOBAL", "ACCOUNTING_REBUILD_MISMATCH"]]);
    expect(health.halts[0]?.detail).toContain(`instance ${INSTANCE_ID}'s held PnL state differs from foldPnlRecords`);
    expect(health.halts[0]?.detail).toContain("The stream was replaced by the rebuild");
    expect(health.seams.folds).toMatchObject({ ledgerMismatches: 0, pnlMismatches: 1 });
    expectPnlEqualsRebuild(harness.loop);
  });
});

/** Corrupts the HELD PnL state in place — one lot's shares — through the container guard's documented bypass. */
function corruptHeldPnl(loop: CoreLoop): void {
  const state = loop.pnlState(INSTANCE_ID);
  if (state === undefined) throw new Error("no held PnL state to corrupt");
  const [lotKey, lot] = [...state.lots.entries()][0] ?? [];
  if (lotKey === undefined || lot === undefined) throw new Error("no held lot to corrupt");
  Map.prototype.set.call(state.lots, lotKey, { ...lot, shares: "1" });
}

/** Re-labels every fill as one of an order this process never placed: each is posted UNATTRIBUTED. */
function unownEveryFill(page: FillsPage): FillsPage {
  if (!page.ok) return page;
  return {
    ...page,
    value: {
      ...page.value,
      fills: page.value.fills.map((fill) => ({ ...fill, simulatedOrderId: `fold1-unowned-${fill.simulatedOrderId}` })),
    },
  };
}

describe("FOLD1-R1-2: EVERY due posted fill runs every enabled check — unowned fills and the store-failure return included", () => {
  it("UNOWNED fills run the PnL check too: a corrupted held PnL state is caught at the FIRST unowned fill, a GLOBAL halt", async () => {
    const harness = assemble(EVERY_FILL_ACCOUNTING_CHECKS);
    await open(harness);
    await tick(harness);
    expect(harness.loop.health().seams.folds).toMatchObject({ fillsPosted: 10, ledgerChecks: 10, pnlChecks: 10 });
    corruptHeldPnl(harness.loop);

    // The next tick's ten fills name orders the loop does not own.
    hooks.fillsPage = unownEveryFill;
    await tick(harness);
    const health = harness.loop.health();
    expect(health.seams.orders.unownedFills).toBe(10);
    expect(health.seams.folds).toMatchObject({
      fillsPosted: 20,
      ledgerChecks: 20,
      // One stream, compared at EVERY due fill — the ten unowned ones too.
      pnlChecks: 20,
      pnlMismatches: 1,
      ledgerMismatches: 0,
    });
    const global = health.halts.find((halt) => halt.scope.kind === "GLOBAL");
    expect(global?.code).toBe("ACCOUNTING_REBUILD_MISMATCH");
    expect(global?.action).toBe("FULL_HALT");
    expect(global?.detail).toContain(`instance ${INSTANCE_ID}'s held PnL state differs from foldPnlRecords`);
    expect(global?.detail).toContain("after posted fill 11");
    // The unattributed-fill halt still latches exactly as before (TRDR-4).
    expect(health.halts.map((halt) => [halt.scope.kind, halt.code])).toContainEqual(["MARKET", "UNATTRIBUTED_ACTIVITY"]);
    // Replaced by the rebuild, so the later checks matched.
    expectPnlEqualsRebuild(harness.loop);
    expectViewEqualsRebuild(harness.loop);
  });

  it("an owned fill whose ledger-store write FAILS still runs its due PnL check before that early return: caught AT that fill", async () => {
    const harness = assemble(EVERY_FILL_ACCOUNTING_CHECKS);
    await open(harness);
    await tick(harness);
    corruptHeldPnl(harness.loop);
    harness.store.failOnly(["appendLedgerTransaction"], "UNAVAILABLE", "FOLD1-R1-2 test: the ledger store refuses");
    await tick(harness);
    const health = harness.loop.health();
    // The first fill of the tick was adopted and checked; then its store write failed and the harvest returned.
    expect(health.seams.folds).toMatchObject({ fillsPosted: 11, ledgerChecks: 11, pnlChecks: 11, pnlMismatches: 1 });
    // The check runs BEFORE the store write, so its halt latched first (a scope keeps its first record).
    expect(health.halts.map((halt) => [halt.scope.kind, halt.code])).toEqual([["GLOBAL", "ACCOUNTING_REBUILD_MISMATCH"]]);
    expect(health.halts[0]?.detail).toContain("after posted fill 11");
    expectPnlEqualsRebuild(harness.loop);
  });
});

describe("FOLD1-R1-1: a PnL check never certifies a held stream that is BEHIND its records", () => {
  it("a ledger-store failure leaves the stream behind (as base's snapshot was); END_OF_RUN catches it up and compares the WHOLE list", async () => {
    // The PnL check is on but never due on the cadence, so only END_OF_RUN runs it.
    const harness = assemble({ everyFills: 1_000, pnl: true });
    await open(harness);
    await tick(harness);
    // `SNAP-1`: the tick's ten fills share one instant, so ONE row (was ten, one per fill).
    expect(harness.store.pnlSnapshots).toHaveLength(1);
    harness.store.failOnly(["appendLedgerTransaction"], "UNAVAILABLE", "FOLD1-R1-1 test: the ledger store refuses");
    await tick(harness);
    // Fill 11 was adopted and its two records joined the stream; its store write failed and the
    // harvest returned before its snapshot, so nothing has folded them yet.
    expect(harness.loop.pnlRecords(INSTANCE_ID)).toHaveLength(22);
    expect(harness.loop.pnlState(INSTANCE_ID)?.recordCount).toBe(20);
    expect(harness.store.pnlSnapshots).toHaveLength(1);

    expect(harness.loop.checkAccountingRebuild("END_OF_RUN")).toEqual({ matched: true, pnlStreamsChecked: 1 });
    // `matched` is said of the WHOLE stream: the held state now folds all 22 records.
    expect(harness.loop.pnlState(INSTANCE_ID)?.recordCount).toBe(22);
    expectPnlEqualsRebuild(harness.loop);
    expect(harness.loop.health().seams.folds).toMatchObject({ pnlChecks: 1, pnlMismatches: 0 });
    // The store failure is still the process's GLOBAL halt; the check added none.
    expect(harness.loop.health().halts.map((halt) => [halt.scope.kind, halt.code])).toEqual([["GLOBAL", "STORE_UNAVAILABLE"]]);
  });

  it("the same failure on the every-fill cadence: the failing fill's own check caught the stream up, so it is never behind a check", async () => {
    const harness = assemble(EVERY_FILL_ACCOUNTING_CHECKS);
    await open(harness);
    await tick(harness);
    harness.store.failOnly(["appendLedgerTransaction"], "UNAVAILABLE", "FOLD1-R1-1 test: the ledger store refuses");
    await tick(harness);
    expect(harness.loop.pnlRecords(INSTANCE_ID)).toHaveLength(22);
    expect(harness.loop.pnlState(INSTANCE_ID)?.recordCount).toBe(22);
    expectPnlEqualsRebuild(harness.loop);
    // …and no snapshot was written for it: the snapshot semantics are base's
    // (`SNAP-1`: tick 1's ten fills wrote ONE row, at their one instant).
    expect(harness.store.pnlSnapshots).toHaveLength(1);
    expect(harness.loop.health().seams.folds).toMatchObject({ fillsPosted: 11, pnlChecks: 11, pnlMismatches: 0 });
    expect(harness.loop.checkAccountingRebuild("END_OF_RUN")).toEqual({ matched: true, pnlStreamsChecked: 1 });
  });

  it("a corruption of a stream that is behind is still caught by END_OF_RUN, over the whole list", async () => {
    const harness = assemble({ everyFills: 1_000, pnl: true });
    await open(harness);
    await tick(harness);
    corruptHeldPnl(harness.loop);
    harness.store.failOnly(["appendLedgerTransaction"], "UNAVAILABLE", "FOLD1-R1-1 test: the ledger store refuses");
    await tick(harness);
    expect(harness.loop.checkAccountingRebuild("END_OF_RUN")).toEqual({ matched: false, pnlStreamsChecked: 1 });
    expect(harness.loop.health().seams.folds).toMatchObject({ pnlChecks: 1, pnlMismatches: 1 });
    expectPnlEqualsRebuild(harness.loop);
  });
});

describe("FOLD-1: a fold that fails is a failed posting — the ledger and its view never move apart", () => {
  it("a throwing step: the fill is NOT booked, the market halts LEDGER_POSTING_REFUSED (stage VIEW_FOLD), ledgerRefusals counts it", async () => {
    const harness = assemble(EVERY_FILL_ACCOUNTING_CHECKS);
    await open(harness);
    await tick(harness);
    const lengthBefore = harness.loop.ledger().length;
    const recordsBefore = harness.loop.pnlRecords(INSTANCE_ID).length;
    let thrown = 0;
    hooks.applyTransaction = (original, projection, appended) => {
      if (thrown > 0) return original(projection, appended);
      thrown += 1;
      throw new TypeError("FOLD-1 test: the step fails");
    };
    await tick(harness);
    expect(thrown).toBe(1);
    const health = harness.loop.health();
    expect(health.halts.map((halt) => [halt.scope.kind, halt.code])).toEqual([["MARKET", "LEDGER_POSTING_REFUSED"]]);
    expect(health.halts[0]?.detail).toContain("VIEW_FOLD LEDGER_VIEW_FOLD_FAILED");
    expect(health.halts[0]?.detail).toContain("applyTransaction threw a TypeError");
    expect(health.accounting.ledgerRefusals).toBe(1);
    // That one fill is not booked; the other nine of the tick are.
    expect(health.seams.folds.fillsPosted).toBe(19);
    expect(harness.loop.ledger().length).toBe(lengthBefore + 9 * 3);
    expect(harness.loop.pnlRecords(INSTANCE_ID).length).toBe(recordsBefore + 9 * 2);
    // The view and the ledger stayed together through the refused posting.
    expect(health.seams.folds.ledgerMismatches).toBe(0);
    expectViewEqualsRebuild(harness.loop);
  });

  it("a step that SKIPS a transaction outright is refused at adoption (LEDGER_VIEW_OUT_OF_STEP), before any check is needed", async () => {
    const harness = assemble(EVERY_FILL_ACCOUNTING_CHECKS);
    await open(harness);
    let skipped = 0;
    hooks.applyTransaction = (original, projection, appended) => {
      if (skipped > 0) return original(projection, appended);
      skipped += 1;
      return projection;
    };
    await tick(harness);
    expect(skipped).toBe(1);
    const health = harness.loop.health();
    expect(health.halts.map((halt) => [halt.scope.kind, halt.code])).toEqual([["MARKET", "LEDGER_POSTING_REFUSED"]]);
    expect(health.halts[0]?.detail).toContain("VIEW_FOLD LEDGER_VIEW_OUT_OF_STEP");
    expect(health.seams.folds).toMatchObject({ fillsPosted: 9, ledgerMismatches: 0 });
    expectViewEqualsRebuild(harness.loop);
  });
});

describe("FOLD-1 ruling F3: a refused PnL record stops that instance's snapshots at the SAME fill as a from-zero fold — now counted", () => {
  it("a duplicate-ref record planted in the third fill's posting: snapshots for fills 1-2 only (the from-zero model's answer), one counted refusal, no mismatch", async () => {
    const harness = assemble(EVERY_FILL_ACCOUNTING_CHECKS);
    await open(harness);
    // The third posting's instance TRADE record reuses the first posting's
    // ref: `packages/pnl` refuses it (PNL_DUPLICATE_REF) wherever it is
    // folded — from zero or incrementally. The ledger itself is untouched.
    let postings = 0;
    let firstTradeRef: string | undefined;
    hooks.buildFillPosting = (result) => {
      if (!result.ok) return result;
      postings += 1;
      const records = result.value.pnlRecords.map((record) => {
        const instanceTrade = record.kind === "TRADE" && record.owner.scope === "VIRTUAL_STRATEGY";
        if (instanceTrade && postings === 1) firstTradeRef = record.ref;
        if (instanceTrade && postings === 3 && firstTradeRef !== undefined) return { ...record, ref: firstTradeRef };
        return record;
      });
      return { ...result, value: { ...result.value, pnlRecords: records } };
    };
    await tick(harness);
    await tick(harness);
    const health = harness.loop.health();
    expect(health.halts).toEqual([]);
    expect(health.seams.folds.fillsPosted).toBe(20);

    // The from-zero model — exactly what `#writePnlSnapshot` computed before
    // FOLD-1: after each fill, fold the WHOLE stream so far; write a snapshot
    // iff it folds. Each fill adds two records (TRADE and FEE).
    const records: readonly PnlRecord[] = harness.loop.pnlRecords(INSTANCE_ID);
    expect(records).toHaveLength(40);
    const baseWrites: number[] = [];
    for (let fill = 1; fill <= 20; fill += 1) {
      if (foldPnlRecords(identity(), records.slice(0, 2 * fill)).ok) baseWrites.push(fill);
    }
    expect(baseWrites).toEqual([1, 2]);
    // Base wrote exactly those snapshots, at those fills' instant. `SNAP-1`
    // (one snapshot per instance per instant): fills 1 and 2 are both tick 1's,
    // ONE instant, so the loop writes ONE row there — the LAST of base's two,
    // fill 2's: the from-zero model after fill 2, marked at fill 2's own price
    // (every slice of tick 1's BUY fills at the 0.34 ask). The refused fills
    // 3-20 replace nothing, exactly as they wrote nothing in base.
    const afterFill2 = foldPnlRecords(identity(), records.slice(0, 4));
    expect(afterFill2.ok).toBe(true);
    if (!afterFill2.ok) return;
    const tick1 = "2026-05-01T09:00:00.400Z";
    const lastBaseRow = computePnlSnapshot(afterFill2.value, {
      asOf: tick1,
      marks: { [`token:${YES_TOKEN}`]: { midpoint: "0.34" } },
    });
    expect(lastBaseRow.ok).toBe(true);
    if (!lastBaseRow.ok) return;
    expect(harness.store.pnlSnapshots).toEqual([...lastBaseRow.value]);
    // F3: the refused record is COUNTED once — not once per retry.
    expect(health.seams.folds.pnlRefusals).toEqual({ [INSTANCE_ID]: { PNL_DUPLICATE_REF: 1 } });
    // …and it is SERVED: the health endpoint's own-data encoder carries the
    // counts (null-prototype records, nested) byte for byte.
    const served = JSON.parse(healthResponseBody(harness.loop.health())) as {
      seams: { folds: { pnlRefusals: unknown } };
    };
    expect(served.seams.folds.pnlRefusals).toEqual({ [INSTANCE_ID]: { PNL_DUPLICATE_REF: 1 } });
    // Held and rebuilt stop at the same record from the same state, so the
    // every-fill PnL check found no difference.
    expect(health.seams.folds).toMatchObject({ pnlMismatches: 0, ledgerMismatches: 0 });
    expect(health.seams.folds.pnlChecks).toBe(20);
    const held = harness.loop.pnlState(INSTANCE_ID);
    const before = foldPnlRecords(identity(), records.slice(0, 4));
    expect(before.ok).toBe(true);
    if (held === undefined || !before.ok) return;
    expect(serializePnlState(held)).toBe(serializePnlState(before.value));
    expect(harness.loop.checkAccountingRebuild("END_OF_RUN")).toEqual({ matched: true, pnlStreamsChecked: 1 });
  });
});

// ---------------------------------------------------------------------------
// SNAP-1 — one PnL snapshot per instance per instant (user ruling 2026-09-28)
// ---------------------------------------------------------------------------

/** The loop's own instant for the harness's `ordinal`-th event (`time.ts`, strict UTC). */
function instantOf(ordinal: number): string {
  return formatStrictUtc(T_START_MS + ordinal * STEP_MS);
}

/**
 * The row base wrote after the instance's `fills`-th booked fill: the
 * from-zero fold of that fill's records (TRADE + FEE per fill), at `asOf`,
 * marked at the fill's own price — `#writePnlSnapshot`'s computation.
 */
function modelRows(loop: CoreLoop, fills: number, asOf: string, price: string): readonly PnlSnapshot[] {
  const folded = foldPnlRecords(identity(), loop.pnlRecords(INSTANCE_ID).slice(0, 2 * fills));
  if (!folded.ok) throw new Error("the model refused the stream");
  const rows = computePnlSnapshot(folded.value, { asOf, marks: { [`token:${YES_TOKEN}`]: { midpoint: price } } });
  if (!rows.ok) throw new Error("the model refused the snapshot");
  return rows.value;
}

/**
 * A `MarketClosing` at the harness's next ordinal — or at `at` (`SNAP-1` r1):
 * its callback HOLDS, so the event evaluates no entry; its harvest books
 * whatever the venue filled since the last one.
 */
async function closing(harness: Harness, at?: string): Promise<void> {
  await feed(harness, (n) =>
    envelope(
      n,
      "MarketClosing",
      { internalMarketId: MARKET_ID, conditionId: CONDITION_ID, closesAt: T_CLOSE },
      "polymarket",
      at,
    ),
  );
}

/** `SNAP-1` r1: every booked fill's two records (TRADE + FEE), so the stream's fill count. */
function bookedFills(loop: CoreLoop): number {
  return loop.pnlRecords(INSTANCE_ID).length / 2;
}

/** `SNAP-1` r1: what the TRDR-3 book serves for the harness's one instance. */
function bookReads(realizedPnl: string | undefined): unknown {
  return { byInstance: { [INSTANCE_ID]: realizedPnl }, account: realizedPnl };
}

/**
 * `SNAP-1` r1 — the reviewer's second shape (`SNAP1-R1`): the first tick BUYS
 * 50 (ten fills, as `roundTrips`); the FIRST `onFill` answers an immediate
 * SELL of the holding, which the venue fills AT SUBMISSION — during the
 * entry event's deliveries, after that event's harvest — so those fills wait
 * for the NEXT event's harvest. Every other callback holds.
 */
const exitsOnFill: Strategy<unknown, CyclingState> = {
  ...roundTrips,
  name: "snap1-exit-on-fill-double",
  onFeatures(ctx: StrategyContext): DecisionResult {
    if ((ctx.state<CyclingState>().step ?? 0) > 0) return hold(ctx);
    return roundTrips.onFeatures(ctx);
  },
  onFill(ctx: StrategyContext): DecisionResult {
    const held = ctx.position().yesShares;
    if (ctx.state<CyclingState>().exited === true || held === "0") return hold(ctx);
    const sell: Intent = {
      type: "POSITION",
      intentId: "snap1-exit-on-fill",
      marketId: MARKET_ID,
      direction: "YES",
      targetMode: "DELTA",
      targetShares: `-${held}`,
      minimumSellPrice: "0.3",
      urgency: "IMMEDIATE",
      liquidityPreference: "TAKER_OK",
      partialFillPolicy: "ACCEPT_ANY",
      validUntil: validUntil(ctx),
      tags: ["snap1.exit-on-fill", "sb.order-type:FAK"],
    };
    return {
      decisionType: "exit",
      reasonCodes: ["SNAP1.EXIT_ON_FILL"],
      featureSnapshotRef: ctx.features().snapshotRef,
      statePatch: { exited: true },
      intents: [sell],
    };
  },
};

describe("SNAP-1: one PnL snapshot per instance per instant — the database's key, in the loop", () => {
  it("ten fills in one event write ONE row: base's LAST per-fill row at that instant, byte for byte; the per-fill PnL checks are unchanged", async () => {
    const harness = assemble(EVERY_FILL_ACCOUNTING_CHECKS);
    await open(harness);
    await tick(harness); // event 4: a BUY of 50 in ten 5-share slices, all at the 0.34 ask
    const health = harness.loop.health();
    expect(health.halts).toEqual([]);
    // FOLD-1's checks still ran after EVERY fill: the advance is still per fill.
    expect(health.seams.folds).toMatchObject({ fillsPosted: 10, ledgerChecks: 10, pnlChecks: 10, pnlMismatches: 0, pnlRefusals: {} });
    // Base wrote ten rows here, one per fill, all at instant 4 — which the key refuses.
    // Now ONE: exactly the tenth, marked at the tenth fill's price.
    expect(harness.store.pnlSnapshots).toEqual([...modelRows(harness.loop, 10, instantOf(4), "0.34")]);
    // …and that row IS the held state after the last fill.
    const held = harness.loop.pnlState(INSTANCE_ID);
    const rebuilt = foldPnlRecords(identity(), harness.loop.pnlRecords(INSTANCE_ID));
    expect(rebuilt.ok).toBe(true);
    if (held === undefined || !rebuilt.ok) return;
    expect(serializePnlState(held)).toBe(serializePnlState(rebuilt.value));
  });

  it("a SECOND event at the same instant books ten more fills: the instant's ONE row is REPLACED with the state after the LAST (20th) fill; the TRDR-3 book reads it; nothing is pending when the run ends there (SNAP1-R1)", async () => {
    const harness = assemble(EVERY_FILL_ACCOUNTING_CHECKS, { observe: true });
    await open(harness);
    const shared = instantOf(4);
    await tick(harness, shared); // event 4: BUY 50 @ 0.34, ten fills — the row is INSERTED
    expect(harness.store.pnlSnapshots).toEqual([...modelRows(harness.loop, 10, shared, "0.34")]);
    expect(harness.store.pnlSnapshotReplacements).toBe(0);
    await tick(harness, shared); // event 5, SAME receivedAt: SELL 50 @ 0.32 — and the run's LAST event
    const health = harness.loop.health();
    expect(health.halts).toEqual([]);
    expect(health.seams.folds).toMatchObject({ fillsPosted: 20, pnlChecks: 20, pnlMismatches: 0, pnlRefusals: {} });
    // ONE row at the shared instant — the database's key — and it holds the state after ALL
    // twenty fills, marked at the last one's 0.32: the from-zero model's 20th per-fill row.
    const last = modelRows(harness.loop, 20, shared, "0.32");
    expect(harness.store.pnlSnapshots).toEqual([...last]);
    expect(harness.store.pnlSnapshotReplacements).toBe(1);
    // The values the reviewer measured as REQUIRED (the candidate served 0 / 17 / 0.22 / -0.22).
    expect(last[0]).toMatchObject({ realizedPnl: "-1", capitalCommitted: "0", feesPaid: "0.43", coreNetPnl: "-1.43" });
    // TRDR-3: the book the health surface serves is the replaced row's realized PnL.
    expect(harness.book?.view()).toEqual(bookReads("-1"));
    // Terminal: no later event ran, and nothing is owed — the held state IS the row.
    const held = harness.loop.pnlState(INSTANCE_ID);
    const rebuilt = foldPnlRecords(identity(), harness.loop.pnlRecords(INSTANCE_ID));
    expect(rebuilt.ok).toBe(true);
    if (held === undefined || !rebuilt.ok) return;
    expect(serializePnlState(held)).toBe(serializePnlState(rebuilt.value));
    expect(harness.loop.checkAccountingRebuild("SHUTDOWN").matched).toBe(true);
    expect(harness.store.pnlSnapshots).toEqual([...last]);
  });

  it("an exit submitted from onFill fills at submission and is harvested by a LATER event at the SAME instant: the instant's row is replaced with the state after that exit (the reviewer's second shape, SNAP1-R1)", async () => {
    const harness = assemble(EVERY_FILL_ACCOUNTING_CHECKS, { observe: true, strategy: exitsOnFill });
    await open(harness);
    const shared = instantOf(4);
    await tick(harness, shared); // event 4: the BUY's ten fills are booked; the first onFill SELLS
    expect(harness.loop.decisions().filter((decision) => decision.reasonCodes.includes("SNAP1.EXIT_ON_FILL"))).toHaveLength(1);
    expect(bookedFills(harness.loop)).toBe(10);
    expect(harness.store.pnlSnapshots).toEqual([...modelRows(harness.loop, 10, shared, "0.34")]);
    await closing(harness, shared); // event 5, SAME instant: its harvest books the SELL's fills
    const health = harness.loop.health();
    expect(health.halts).toEqual([]);
    expect(bookedFills(harness.loop)).toBe(20);
    const last = modelRows(harness.loop, 20, shared, "0.32");
    expect(harness.store.pnlSnapshots).toEqual([...last]);
    expect(harness.store.pnlSnapshotReplacements).toBe(1);
    expect(last[0]).toMatchObject({ realizedPnl: "-1", capitalCommitted: "0" });
    expect(harness.book?.view()).toEqual(bookReads("-1"));
    expect(harness.loop.checkAccountingRebuild("SHUTDOWN").matched).toBe(true);
  });

  it("instants that go BACKWARDS and come back: each distinct instant keeps its OWN row, at its own as_of; a revisited instant's row is replaced (SNAP1-R2)", async () => {
    const harness = assemble(EVERY_FILL_ACCOUNTING_CHECKS, { observe: true });
    await open(harness);
    await tick(harness, instantOf(5)); // event 4, stamped at instant 5: BUY
    await tick(harness, instantOf(4)); // event 5, stamped EARLIER: SELL — a distinct identity
    expect(harness.loop.health().halts).toEqual([]);
    // Two instants with fills, two rows, each the state after its own last fill: nothing lost,
    // nothing moved to an instant where the instance had no fill.
    expect(harness.store.pnlSnapshots).toEqual([
      ...modelRows(harness.loop, 10, instantOf(5), "0.34"),
      ...modelRows(harness.loop, 20, instantOf(4), "0.32"),
    ]);
    expect(harness.store.pnlSnapshotReplacements).toBe(0);
    expect(harness.book?.view()).toEqual(bookReads("-1"));

    await tick(harness, instantOf(5)); // event 6, back at instant 5: BUY again
    expect(harness.loop.health().halts).toEqual([]);
    expect(bookedFills(harness.loop)).toBe(30);
    // Instant 5's one row (inserted first, so first) now holds the state after fill 30.
    expect(harness.store.pnlSnapshots).toEqual([
      ...modelRows(harness.loop, 30, instantOf(5), "0.34"),
      ...modelRows(harness.loop, 20, instantOf(4), "0.32"),
    ]);
    expect(harness.store.pnlSnapshotReplacements).toBe(1);
    // Every instant with a booked fill has exactly one row.
    expect(harness.store.pnlSnapshots.map((row) => row.asOf).sort()).toEqual([instantOf(4), instantOf(5)]);
    expect(harness.book?.view()).toEqual(bookReads(modelRows(harness.loop, 30, instantOf(5), "0.34")[0]?.realizedPnl));
  });
});

describe("SNAP-1: a halt latched mid-harvest, and the staged row", () => {
  it("a REFUSED posting mid-harvest (MARKET LEDGER_POSTING_REFUSED) does not stop the row: it is the state after the last BOOKED fill", async () => {
    const harness = assemble(EVERY_FILL_ACCOUNTING_CHECKS);
    await open(harness);
    // The fifth fill's first transaction (calls 1-12 are fills 1-4's three each) fails to fold.
    let calls = 0;
    hooks.applyTransaction = (original, projection, appended) => {
      calls += 1;
      if (calls === 13) throw new TypeError("SNAP-1 test: the fifth fill's fold fails");
      return original(projection, appended);
    };
    await tick(harness);
    const health = harness.loop.health();
    expect(health.halts.map((halt) => [halt.scope.kind, halt.code])).toEqual([["MARKET", "LEDGER_POSTING_REFUSED"]]);
    // Nine fills booked (1-4 and 6-10), fill 5 not; base wrote a row after each booked one.
    expect(health.seams.folds.fillsPosted).toBe(9);
    expect(harness.loop.pnlRecords(INSTANCE_ID)).toHaveLength(18);
    expect(harness.store.pnlSnapshots).toEqual([...modelRows(harness.loop, 9, instantOf(4), "0.34")]);
  });

  it("a LEDGER-STORE failure mid-harvest: the row staged by the fills booked before it is written (base had written it), then the harvest returns", async () => {
    const harness = assemble(EVERY_FILL_ACCOUNTING_CHECKS);
    await open(harness);
    await tick(harness); // event 4: fills 1-10, one row
    const append = harness.store.appendLedgerTransaction.bind(harness.store);
    let calls = 0;
    harness.store.appendLedgerTransaction = async (transaction) => {
      calls += 1;
      // Fills 11-14 persist their three transactions each; fill 15's first is refused.
      if (calls === 13) return portFailed<null>("UNAVAILABLE", "SNAP-1 test: the ledger store refuses");
      return await append(transaction);
    };
    await tick(harness); // event 5: the SELL
    const health = harness.loop.health();
    expect(health.halts.map((halt) => [halt.scope.kind, halt.code])).toEqual([["GLOBAL", "STORE_UNAVAILABLE"]]);
    expect(health.halts[0]?.detail).toContain("the ledger transaction could not be persisted");
    expect(health.seams.folds.fillsPosted).toBe(15);
    expect(harness.store.pnlSnapshots).toEqual([
      ...modelRows(harness.loop, 10, instantOf(4), "0.34"),
      // The state after fill 14 — the last row base wrote at instant 5 before fill 15's failure.
      ...modelRows(harness.loop, 14, instantOf(5), "0.32"),
    ]);
  });

  it("a SNAPSHOT-store failure at the flush: the same GLOBAL STORE_UNAVAILABLE, latched BEFORE the harvest's deliveries; the rows are dropped, never retried", async () => {
    const harness = assemble(EVERY_FILL_ACCOUNTING_CHECKS);
    await open(harness);
    harness.store.failOnly(["writePnlSnapshot"], "UNAVAILABLE", "SNAP-1 test: the snapshot store refuses");
    await tick(harness);
    const health = harness.loop.health();
    expect(health.halts.map((halt) => [halt.scope.kind, halt.code, halt.action, halt.at])).toEqual([
      ["GLOBAL", "STORE_UNAVAILABLE", "FULL_HALT", instantOf(4)],
    ]);
    expect(health.halts[0]?.detail).toBe(
      "a PnL snapshot could not be persisted: SNAP-1 test: the snapshot store refuses",
    );
    // §4.2's MEDIUM-1 gate: the ten fills are booked, and NONE is delivered.
    expect(health.seams.folds.fillsPosted).toBe(10);
    expect(health.loop.deliveriesSuppressedByHalt).toBeGreaterThanOrEqual(10);
    expect(harness.loop.decisions().map((decision) => decision.callback)).not.toContain("onFill");
    expect(harness.store.pnlSnapshots).toEqual([]);
    // The store recovers; a later harvest has nothing staged — the failed row is not retried.
    harness.store.recover();
    await closing(harness);
    expect(harness.store.pnlSnapshots).toEqual([]);
  });

  it("a REPLACEMENT the store refuses: the same GLOBAL STORE_UNAVAILABLE, latched BEFORE that harvest's deliveries; the row keeps the earlier state and the TRDR-3 book does not move (SNAP1-R1)", async () => {
    const harness = assemble(EVERY_FILL_ACCOUNTING_CHECKS, { observe: true });
    await open(harness);
    const shared = instantOf(4);
    await tick(harness, shared); // event 4: BUY, row inserted, its fills delivered
    const decisionsBefore = harness.loop.decisions().length;
    harness.store.failOnly(["replacePnlSnapshot"], "UNAVAILABLE", "SNAP-1 r1 test: the replacement is refused");
    await tick(harness, shared); // event 5, SAME instant: SELL — its flush must REPLACE, and is refused
    const health = harness.loop.health();
    expect(health.halts.map((halt) => [halt.scope.kind, halt.code, halt.action, halt.at])).toEqual([
      ["GLOBAL", "STORE_UNAVAILABLE", "FULL_HALT", shared],
    ]);
    expect(health.halts[0]?.detail).toBe(
      "a PnL snapshot could not be persisted: SNAP-1 r1 test: the replacement is refused",
    );
    // §4.2's MEDIUM-1 gate holds for a replacement too: the ten SELL fills are booked, none delivered.
    expect(health.seams.folds.fillsPosted).toBe(20);
    expect(health.loop.deliveriesSuppressedByHalt).toBeGreaterThanOrEqual(10);
    expect(harness.loop.decisions().slice(decisionsBefore).map((decision) => decision.callback)).not.toContain("onFill");
    // Nothing was inserted in its place: the one row still holds event 4's state.
    expect(harness.store.pnlSnapshots).toEqual([...modelRows(harness.loop, 10, shared, "0.34")]);
    expect(harness.store.pnlSnapshotReplacements).toBe(0);
    expect(harness.book?.view()).toEqual(bookReads("0"));
  });
});
