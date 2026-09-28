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
 *   from-zero fold would (today's behaviour), now COUNTED (ruling F3).
 *
 * WHAT IS REAL: the `CoreLoop`, the strategy RUNTIME, the feature engine,
 * books, capital allocator, risk engine, execution planner, `SimulatedVenue`
 * (Tier 0), ledger and PnL. WHAT IS DOUBLED: the clock, the durable store
 * (the trader's own in-memory doubles) and the strategy — a cycling double
 * that places an immediate BUY of 50 (ten 5-share slices, each FILLED) and
 * then sells the whole holding, so every tick books ten fills. `createPaperTrader`
 * cannot be used: its strategy is Static Bracket, which opens one bracket per
 * market and pauses (`RISK-2` residual 5).
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
  foldPnlRecords,
  serializePnlState,
  type PnlRecord,
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

import { DeterministicIdFactory, type PostingIdentity } from "./accounting.js";
import { AllocatorGate, allocationMarketOf, type AllocationMarket } from "./allocation.js";
import { configuredFeatureKeys, parseTraderConfig } from "./config.js";
import {
  EVERY_FILL_ACCOUNTING_CHECKS,
  PAPER_ACCOUNTING_CHECKS,
  type AccountingChecks,
} from "./folds.js";
import { HaltController } from "./halt.js";
import { HealthState } from "./health.js";
import { healthResponseBody } from "./health-server.js";
import { InstanceRegistry } from "./instances.js";
import { CoreLoop, DecisionOutboxBuffer } from "./loop.js";
import { MarketState } from "./market-state.js";
import type { IngestedEvent } from "./ports.js";
import { REPOSITORY_MAXIMUM_RUN_MODE, TRADER_RUN_MODE } from "./safety.js";
import { ManualClock, MemoryTraderStore } from "./testing/index.js";

type ApplyTransaction = typeof LedgerModule.applyTransaction;
type BuildFillPosting = typeof LedgerModule.buildFillPosting;

const hooks = vi.hoisted(() => ({
  projectLedgerCalls: 0,
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

type CyclingState = { readonly step?: number };

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
  ordinal: number;
}

/** `createPaperTrader`'s assembly, with the round-trip double's runtime registered. */
function assemble(accountingChecks: AccountingChecks | undefined): Harness {
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
    strategy: roundTrips,
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
    ids: new DeterministicIdFactory("fold-1"),
    health: new HealthState({ runMode: TRADER_RUN_MODE, maximumRunMode: REPOSITORY_MAXIMUM_RUN_MODE }),
    halts: new HaltController(),
    featureKeys: configuredFeatureKeys(config),
    posting,
    tokenAssetIds,
    outbox,
    ...(accountingChecks === undefined ? {} : { accountingChecks }),
  });
  wiring.loop = loop;
  return { loop, store, ordinal: 0 };
}

function envelope(ordinal: number, eventType: string, payload: unknown, source: "polymarket" | "binance" = "polymarket"): IngestedEvent {
  const receivedAt = new Date(T_START_MS + ordinal * STEP_MS).toISOString();
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

/** One strategy step: a deep YES snapshot — a BUY of 50 or a SELL of the holding, ten fills either way. */
async function tick(harness: Harness): Promise<void> {
  await feed(harness, (n) =>
    envelope(n, "BookSnapshot", {
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
    }),
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
      // Every fill wrote its snapshot: nothing refused, nothing skipped.
      expect(harness.store.pnlSnapshots).toHaveLength(health.seams.folds.fillsPosted);
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
    // The loop wrote exactly those snapshots, at those fills' instants.
    expect(harness.store.pnlSnapshots).toHaveLength(baseWrites.length);
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
