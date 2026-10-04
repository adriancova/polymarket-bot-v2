/**
 * `CAP-1` — `CAP-OVERSHOOT`: a filled order's capital must never vanish from
 * the cap check. PAPER only; no network, credential, signer or real order.
 *
 * THE DEFECT. An order's allocator reservation was released at its FILLED
 * view, and its fill became a position only at its harvest point (ADR-024;
 * ADR-026 for the carried path). An order an `onFill` decision places and the
 * venue fills at once is FILLED in the same close, while its fill is read at
 * the NEXT harvest point — so every evaluation in between saw neither the
 * reservation nor the position. `CADENCE-1`'s review probe (R4-CAP) admitted
 * three 10 @ 0.34 BUYs (10.20 pUSD) under a per-strategy cap of 8 pUSD, on the
 * carried AND the ordinary path; a booked control refused the third.
 *
 * THE INVARIANT (`allocation.ts`, the choke point `AllocatorGate#buildState`):
 * at every evaluation the capital the cap check counts for a strategy is at
 * least the exact sum of its open reservations plus its booked and unbooked
 * filled exposure — and, with no double count, EXACTLY each order's
 * reservation while it can still fill, and exactly its fills' debits once its
 * final size is settled.
 *
 * What this file pins, in the REAL core loop (`createPaperTrader`'s assembly
 * with a SCRIPTED strategy double, the real allocator, risk engine, planner,
 * simulated venue and ledger):
 *
 * 1. the `CADENCE-1` R4-CAP probe, as a named regression (it fails at base
 *    `a8b733e`: three BUYs admitted on each path);
 * 2. one pin per path: the release at FILLED; a partial fill (no double
 *    count); a cancel after a partial fill (the exact remainder released); a
 *    partly sold covered SELL (the account rebuilds); an `onOrderUpdate`
 *    placement; a fill applied at an unconfigured market's `observe()`;
 * 3. a seeded property over random fills, partial fills, cancels, `onFill`
 *    and `onOrderUpdate` placements, carried and ordinary harvests and
 *    restarts: the invariant at EVERY evaluation (every strategy callback,
 *    every cap check, every reservation), and no admitted intent taking a
 *    strategy over its cap.
 *
 * `CAP-1` r0 — THE RULING ON RISK CHECKS 16 AND 17 (2026-10-04). The same
 * window hid an unbooked fill from §9.8's worst-case and scenario checks: they
 * read booked positions and NON-terminal orders only. The ruling extends the
 * invariant to them through a SEPARATE risk input (`unbookedFills`), wired
 * from the allocator's own commitments. Pinned here, in the real loop:
 *
 * 4. the R4-CAP shape with `maxWorstCaseContractualLoss` 8 (allocator caps
 *    out of the way): the third BUY is refused `RISK_WORST_CASE_LOSS_EXCEEDED`
 *    on the carried, ordinary and per-frame paths, as the booked control
 *    refuses it (at `13994b9` all three admitted it);
 * 5. a protective SELL in the unbooked window: admitted, sized to the BOOKED
 *    shares only (§6 invariant 10), and the filled order is in no open order
 *    (§9.8 check 18 never sees it);
 * 6. the property, extended: at EVERY risk evaluation, the holdings checks 16
 *    and 17 count are at least the venue's floor, and no admitted entry takes
 *    the strategy's floor over its worst-case limit.
 */

import { parseAllocatorCaps } from "@polymarket-bot/capital-allocator";
import { addDecimal, compareDecimal, mulDecimal, subDecimal } from "@polymarket-bot/decimal";
import type { DecisionResult, EventEnvelope, Intent } from "@polymarket-bot/domain";
import { Ledger } from "@polymarket-bot/ledger";
import { parseRiskPolicy, type RiskEvaluation } from "@polymarket-bot/risk";
import {
  SimulatedVenue,
  deriveStreams,
  readFeeScheduleSnapshot,
  tier0Model,
  tier1Model,
  unmodeledRateLimits,
  type BookView,
  type FeeScheduleSnapshot,
  type LatencyModel,
  type QueueModelParameters,
} from "@polymarket-bot/simulation";
import { createStrategyInstanceRuntime, type EvaluationInput } from "@polymarket-bot/strategy-runtime";
import type { Strategy, StrategyContext } from "@polymarket-bot/strategy-sdk";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type * as Pipeline from "./pipeline.js";

/**
 * `CAP-1` r0: the risk seam, OBSERVED. Every risk input the loop builds and
 * the real engine's verdict on it reach the current harness (`assemble` sets
 * `observe`); both functions run unchanged, so nothing the loop decides
 * differs.
 */
const riskSeam = vi.hoisted(() => ({
  context: undefined as unknown,
  observe: undefined as ((context: unknown, document: unknown, evaluation: unknown) => void) | undefined,
}));

vi.mock("./pipeline.js", async (importOriginal) => {
  const original = await importOriginal<typeof Pipeline>();
  return {
    ...original,
    buildRiskEvaluationInput(context: Parameters<typeof original.buildRiskEvaluationInput>[0]) {
      riskSeam.context = context;
      return original.buildRiskEvaluationInput(context);
    },
    runRiskCheck(policy: Parameters<typeof original.runRiskCheck>[0], input: unknown) {
      const evaluation = original.runRiskCheck(policy, input);
      riskSeam.observe?.(riskSeam.context, input, evaluation);
      return evaluation;
    },
  };
});

import { DeterministicIdFactory, type PostingIdentity } from "./accounting.js";
import { AllocatorGate, allocationMarketOf, type AllocationMarket } from "./allocation.js";
import {
  PAPER_EVALUATION_CADENCE,
  PER_FRAME_EVALUATION_CADENCE,
  type EvaluationCadenceOption,
} from "./cadence.js";
import { configuredFeatureKeys, parseTraderConfig } from "./config.js";
import { EVERY_FILL_ACCOUNTING_CHECKS } from "./folds.js";
import { HaltController } from "./halt.js";
import { HealthState } from "./health.js";
import { InstanceRegistry } from "./instances.js";
import { CoreLoop, DecisionOutboxBuffer } from "./loop.js";
import { MarketState } from "./market-state.js";
import type { RiskInputContext } from "./pipeline.js";
import type { IngestedEvent } from "./ports.js";
import { REPOSITORY_MAXIMUM_RUN_MODE, TRADER_RUN_MODE } from "./safety.js";
import { ManualClock, MemoryTraderStore } from "./testing/index.js";
import { formatStrictUtc } from "./time.js";

const MARKET_A = "018f5c20-1000-7a10-8b00-0000000000e1";
const MARKET_B = "018f5c20-1000-7a10-8b00-0000000000e2";
/** A market this trader does not run: its events are applied and owe nothing. */
const MARKET_X = "018f5c20-1000-7a10-8b00-0000000000e9";
const TOKENS = {
  [MARKET_A]: { yes: "8301", no: "8302" },
  [MARKET_B]: { yes: "8401", no: "8402" },
  [MARKET_X]: { yes: "8901", no: "8902" },
} as const;
const INSTANCE_A = "e18f5c20-2000-7a20-8b00-0000000000e1";
const INSTANCE_B = "e18f5c20-2000-7a20-8b00-0000000000e2";
const RUN_A = "018f5c20-3000-7a30-8b00-0000000000e1";
const RUN_B = "018f5c20-3000-7a30-8b00-0000000000e2";
const CONFIG_ID = "018f5c20-4000-7a40-8b00-0000000000e0";
const GATEWAY_EPOCH = "018f5c20-5000-7a50-8b00-0000000000e5";
const T0_MS = Date.parse("2026-05-01T09:00:00.000Z");
const T_OPEN = "2026-05-01T09:00:00.000Z";
const T_CLOSE = "2026-05-02T09:00:00.000Z";
const PER_FRAME: EvaluationCadenceOption = { ...PER_FRAME_EVALUATION_CADENCE, reproduces: "cap-1:loop-capital.test.ts" };
const TERMINAL = new Set(["FILLED", "CANCELLED", "EXPIRED", "REJECTED"]);

function feeSnapshot(): FeeScheduleSnapshot {
  return {
    snapshotVersion: "cap1.sim.2026-05-01",
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
    conditionId: `0xcap1${marketId.slice(-2)}`,
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
    seriesKey: "cap1-sim",
    underlyingKey: "SIMBTC",
    resolutionWindowKey: "w2026-05-02T09.00",
  };
}

/** The §9.8 check-16 and check-17 limits a harness runs under (generous unless a pin tightens one). */
interface RiskLimits {
  readonly maxWorstCaseContractualLoss?: string;
  readonly maxScenarioLoss?: string;
}

function traderConfig(perStrategyCap: string, globalAccountCap: string, risk: RiskLimits = {}): Record<string, unknown> {
  return {
    environment: "PAPER",
    riskPolicy: {
      freshness: { venueBookMaxAgeMs: 3_600_000, referenceFeedMaxAgeMs: 3_600_000, featuresMaxAgeMs: 3_600_000 },
      limits: { maxWorstCaseContractualLoss: risk.maxWorstCaseContractualLoss ?? "1000" },
      scenario: { maxScenarioLoss: risk.maxScenarioLoss ?? "1000" },
      economics: {},
      participation: {},
      rateLimit: { safetyReserveRequests: 0 },
      timeToClose: { entryCutoffSeconds: 30 },
    },
    allocatorCaps: {
      globalAccountCap,
      perStrategyCap,
      liveMicroMaxOrderNotional: "0",
      liveMicroMaxAccountExposure: "0",
    },
    accounting: {
      accountRef: "cap1-paper-account",
      denominationAssetId: "pUSD",
      venueClearingRef: "cap1-venue-clearing",
      attributionClearingRef: "cap1-attribution-clearing",
      feeExpenseRef: "cap1-fee-expense",
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
      fillModelVersion: "tier0.cap1",
      fillModelParametersHash: "e".repeat(64),
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
      consumerId: "cap-1",
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

// ---------------------------------------------------------------------------
// The scripted strategy double
// ---------------------------------------------------------------------------

type Label = "A" | "B";
type Callback = "onFeatures" | "onFill" | "onOrderUpdate" | "onMarketOpen";

/**
 * What the double does at one callback:
 *
 * - `BUY` — one POSITION DELTA intent for `shares` YES. `FAK`: a taker with a
 *   0.35 bound whose remainder is cancelled; `GTC`: a taker whose remainder
 *   RESTS at its limit; `MAKER`: a resting maker BUY at 0.30. (The shapes of
 *   `loop-cadence.test.ts`'s recording double.)
 * - `SELL_ALL` — a COVERED resting SELL of the whole position at 0.36 (Static
 *   Bracket's take-profit shape); with `taker`, a GTC taker SELL of it bounded
 *   at 0.32, whose remainder RESTS.
 * - `CANCEL` — a market-scope CANCEL of the instance's working orders.
 */
type Act =
  | { readonly kind: "HOLD" }
  | { readonly kind: "BUY"; readonly shares: string; readonly style: "FAK" | "GTC" | "MAKER" }
  | { readonly kind: "SELL_ALL"; readonly taker?: boolean }
  | { readonly kind: "CANCEL" };

interface Call {
  readonly instance: Label;
  readonly callback: Callback;
  readonly now: string;
}

type Script = (call: Call) => Act;

const HOLD: Act = { kind: "HOLD" };

function hold(ctx: StrategyContext): DecisionResult {
  return { decisionType: "hold", reasonCodes: ["CAP1.HOLD"], featureSnapshotRef: ctx.features().snapshotRef, intents: [] };
}

function buyIntent(ctx: StrategyContext, marketId: string, intentId: string, shares: string, style: "FAK" | "GTC" | "MAKER"): Intent {
  const maker = style === "MAKER";
  return {
    type: "POSITION",
    intentId,
    marketId,
    direction: "YES",
    targetMode: "DELTA",
    targetShares: shares,
    maximumBuyPrice: maker ? "0.3" : "0.35",
    maximumTotalCost: mulDecimal(shares, maker ? "0.3" : "0.4"),
    urgency: maker ? "PASSIVE" : "IMMEDIATE",
    liquidityPreference: maker ? "MAKER_ONLY" : "TAKER_OK",
    partialFillPolicy: "ACCEPT_ANY",
    validUntil: new Date(Date.parse(ctx.now()) + 600_000).toISOString(),
    expectedNetEdge: "5",
    tags: ["cap1.entry", style === "FAK" ? "sb.order-type:FAK" : "sb.order-type:GTC"],
  };
}

function scriptedStrategy(marketId: string, label: Label, script: Script): Strategy<unknown, Record<string, never>> {
  let placed = 0;
  const act = (ctx: StrategyContext, callback: Callback): DecisionResult => {
    const chosen = script({ instance: label, callback, now: ctx.now() });
    const featureSnapshotRef = ctx.features().snapshotRef;
    switch (chosen.kind) {
      case "HOLD":
        return hold(ctx);
      case "CANCEL":
        return {
          decisionType: "exit",
          reasonCodes: ["CAP1.CANCEL"],
          featureSnapshotRef,
          intents: [{ type: "CANCEL", marketId, reason: "cap1: cancel this market's working orders" }],
        };
      case "BUY":
        placed += 1;
        return {
          decisionType: "enter",
          reasonCodes: ["CAP1.BUY"],
          featureSnapshotRef,
          intents: [buyIntent(ctx, marketId, `cap1-${label}-buy-${String(placed)}`, chosen.shares, chosen.style)],
        };
      case "SELL_ALL":
        placed += 1;
        return {
          decisionType: "enter",
          reasonCodes: ["CAP1.TAKE_PROFIT"],
          featureSnapshotRef,
          intents: [
            {
              type: "POSITION",
              intentId: `cap1-${label}-sell-${String(placed)}`,
              marketId,
              direction: "YES",
              targetMode: "ABSOLUTE",
              targetShares: "0",
              minimumSellPrice: chosen.taker === true ? "0.32" : "0.36",
              urgency: chosen.taker === true ? "IMMEDIATE" : "PASSIVE",
              liquidityPreference: chosen.taker === true ? "TAKER_OK" : "MAKER_ONLY",
              partialFillPolicy: "ACCEPT_ANY",
              validUntil: new Date(Date.parse(ctx.now()) + 600_000).toISOString(),
              tags: ["cap1.take-profit", "sb.order-type:GTC"],
            },
          ],
        };
    }
  };
  return {
    name: "cap1-scripted-double",
    version: "1.0.0",
    paramsSchema: z.strictObject({}),
    stateSchemaVersion: 1,
    onStart: hold,
    onTimer: hold,
    onStop: hold,
    onFeatures: (ctx: StrategyContext) => act(ctx, "onFeatures"),
    onFill: (ctx: StrategyContext) => act(ctx, "onFill"),
    onOrderUpdate: (ctx: StrategyContext) => act(ctx, "onOrderUpdate"),
    onMarketOpen: (ctx: StrategyContext) => act(ctx, "onMarketOpen"),
    onMarketClosing: hold,
    onMarketResolved: hold,
  };
}

/** A script from a schedule: `at[label][callback]` lists `[instant, act]` pairs; everything else holds. */
function scheduled(at: Partial<Record<Label, Partial<Record<Callback, readonly (readonly [string, Act])[]>>>>): Script {
  return (call) => at[call.instance]?.[call.callback]?.find(([instant]) => instant === call.now)?.[1] ?? HOLD;
}

// ---------------------------------------------------------------------------
// The harness: `createPaperTrader`'s assembly with the scripted double
// ---------------------------------------------------------------------------

interface Harness {
  readonly loop: CoreLoop;
  readonly venue: SimulatedVenue;
  readonly gate: AllocatorGate;
  readonly clock: ManualClock;
  readonly halts: HaltController;
  readonly perStrategyCap: string;
  readonly globalAccountCap: string;
  /** Every runtime invocation: `[instance, callback, evaluatedAt, YES shares shown]`. */
  readonly calls: [Label, string, string, string][];
  /** `CAP-1` r0: every risk evaluation — the context the loop built, the document, and the engine's verdict. */
  readonly risks: { readonly label: Label; readonly context: RiskInputContext; readonly document: RiskDocument; readonly evaluation: RiskEvaluation }[];
}

/** The parts of the risk input DOCUMENT these pins read (what the engine was handed). */
interface RiskDocument {
  readonly portfolio: { readonly positions: readonly { readonly shares: string }[]; readonly openOrders: readonly { readonly orderId: string }[] };
  readonly unbookedFills?: readonly { readonly marketId: string; readonly side: string; readonly shares: string; readonly debit: string }[];
  readonly scenarios: readonly { readonly scenarioId: string; readonly marks: readonly { readonly marketId: string; readonly yesPrice: string }[] }[];
}

interface HarnessOptions {
  readonly cadence: EvaluationCadenceOption;
  readonly perStrategyCap: string;
  readonly globalAccountCap?: string;
  readonly script: Script;
  /** Runs BEFORE each runtime invocation — the property's per-evaluation check. */
  readonly beforeEvaluation?: (harness: Harness, input: EvaluationInput, label: Label) => void;
  /** A TIER-1 venue on a delayed market (`secondsDelay`, zero latency): how a fill reaches `observe()`. */
  readonly tier1DelaySeconds?: number;
  /** `CAP-1` r0: the §9.8 check-16 and check-17 limits (generous by default). */
  readonly risk?: RiskLimits;
  /** `CAP-1` r0: runs at EVERY risk evaluation, after the engine answered — the property's check-16/17 floor. */
  readonly onRisk?: (harness: Harness, risk: Harness["risks"][number]) => void;
}

const ZERO_LATENCY: LatencyModel = {
  latencyModelVersion: "cap1/latency/zero",
  decision: { samples: [{ milliseconds: 0, weight: 1 }] },
  signing: { samples: [{ milliseconds: 0, weight: 1 }] },
  network: { samples: [{ milliseconds: 0, weight: 1 }] },
  venue: { samples: [{ milliseconds: 0, weight: 1 }] },
  basis: "ASSUMED_NOT_MEASURED_NO_PROBE_DATA_EXISTS",
};

const QUEUE_PARAMETERS: QueueModelParameters = {
  queueModelVersion: "cap1/queue/v1",
  cancellationRatio: { OPTIMISTIC: "0.5", BASE: "0.1", CONSERVATIVE: "0" },
  cancelEffectiveAfterMs: { OPTIMISTIC: 10, BASE: 50, CONSERVATIVE: 250 },
  placedBehindSameInstantAdditions: { OPTIMISTIC: false, BASE: false, CONSERVATIVE: true },
  basis: "ASSUMED_NOT_MEASURED_NO_PROBE_DATA_EXISTS",
};

function assemble(options: HarnessOptions): Harness {
  const globalAccountCap = options.globalAccountCap ?? "10000";
  const parsed = parseTraderConfig(traderConfig(options.perStrategyCap, globalAccountCap, options.risk));
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
  const registry = new InstanceRegistry();
  const calls: [Label, string, string, string][] = [];
  const wiring: { harness: Harness | undefined; loop: CoreLoop | undefined } = { harness: undefined, loop: undefined };
  for (const [instanceId, runId, marketId, label] of [
    [INSTANCE_A, RUN_A, MARKET_A, "A"],
    [INSTANCE_B, RUN_B, MARKET_B, "B"],
  ] as const) {
    const created = createStrategyInstanceRuntime({
      strategy: scriptedStrategy(marketId, label, options.script),
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
      calls.push([label, input.callback, input.evaluatedAt, input.position.yesShares]);
      if (wiring.harness !== undefined) options.beforeEvaluation?.(wiring.harness, input, label);
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
  const books = {
    book(request: { readonly marketId: string; readonly side: "YES" | "NO" }): BookView | undefined {
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
        ladder(side: "BID" | "ASK") {
          return market.bookFor(request.side).levels(side).map((level) => ({ price: level.price, size: level.size }));
        },
      };
    },
  };
  const common = {
    clock,
    runMode: "PAPER" as const,
    feeSnapshot: fees.value,
    rateLimits: unmodeledRateLimits("no venue rate-limit budget is modelled in this test"),
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
  };
  const built: { venue?: SimulatedVenue } = {};
  const delay = options.tier1DelaySeconds;
  const venue =
    delay === undefined
      ? new SimulatedVenue({
          ...common,
          model: tier0Model({ fillModelVersion: "tier0.cap1", fillModelParametersHash: "e".repeat(64) }),
          books,
        })
      : new SimulatedVenue({
          ...common,
          model: tier1Model({ fillModelVersion: "tier1.cap1", fillModelParametersHash: "e".repeat(64) }),
          timeline: {
            bookAt(request) {
              const book = books.book(request);
              const atEvent = built.venue?.atEvent;
              return book === undefined || atEvent === undefined ? undefined : { book, atEvent };
            },
          },
          latencyModel: ZERO_LATENCY,
          streams: deriveStreams("291"),
          marketParameters: (marketId: string) => ({
            marketId,
            tickSize: "0.01",
            minimumOrderSize: "5",
            secondsDelay: delay,
            parametersVersion: 1,
          }),
          queueParameters: QUEUE_PARAMETERS,
        });
  built.venue = venue;
  const posting: PostingIdentity = {
    environment: config.environment,
    accountRef: config.accounting.accountRef,
    denominationAssetId: config.accounting.denominationAssetId,
    venueClearingRef: config.accounting.venueClearingRef,
    attributionClearingRef: config.accounting.attributionClearingRef,
    feeExpenseRef: config.accounting.feeExpenseRef,
  };
  const halts = new HaltController();
  const gate = new AllocatorGate({ caps: caps.value, markets: allocationMarkets, tokenAssetIds });
  const loop = new CoreLoop({
    config,
    riskPolicy: policy.value,
    allocator: gate,
    clock,
    venue,
    store: new MemoryTraderStore(),
    registry,
    markets,
    instanceConfigs: new Map(),
    ledger: Ledger.empty(config.environment),
    ids: new DeterministicIdFactory("cap-1"),
    health: new HealthState({ runMode: TRADER_RUN_MODE, maximumRunMode: REPOSITORY_MAXIMUM_RUN_MODE }),
    halts,
    featureKeys: configuredFeatureKeys(config),
    posting,
    tokenAssetIds,
    outbox,
    accountingChecks: EVERY_FILL_ACCOUNTING_CHECKS,
    evaluationCadence: options.cadence,
  });
  wiring.loop = loop;
  const risks: Harness["risks"] = [];
  const harness: Harness = { loop, venue, gate, clock, halts, perStrategyCap: options.perStrategyCap, globalAccountCap, calls, risks };
  wiring.harness = harness;
  riskSeam.observe = (context, document, evaluation) => {
    const built = context as RiskInputContext;
    const risk = {
      label: (built.strategyInstanceId === INSTANCE_A ? "A" : "B") as Label,
      context: built,
      document: document as RiskDocument,
      evaluation: evaluation as RiskEvaluation,
    };
    risks.push(risk);
    options.onRisk?.(harness, risk);
  };
  return harness;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

let ordinal = 0;

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

/** The loop's own strict-UTC form of an offset's instant. */
function iso(offsetMs: number): string {
  return formatStrictUtc(T0_MS + offsetMs);
}

const reference = (offsetMs: number, frame?: string): IngestedEvent =>
  event(offsetMs, "ReferenceTradeObserved", { venue: "binance", symbol: "BTCUSDT", price: "64000", size: "0.5" }, {
    source: "binance",
    ...(frame === undefined ? {} : { frame }),
  });

/**
 * A whole YES or NO book: bids 0.32 × 500, asks 0.34 × 500 and 0.40 × 500.
 * The deeper ask prices any size the risk engine's economics ask about, while
 * a taker bounded at 0.35 can only ever take the 0.34 level — so thinning that
 * level (`askLevel`) gives partial fills.
 */
const snapshot = (offsetMs: number, marketId: string, outcome: "yes" | "no", frame?: string): IngestedEvent =>
  event(
    offsetMs,
    "BookSnapshot",
    {
      internalMarketId: marketId,
      tokenId: TOKENS[marketId as keyof typeof TOKENS][outcome],
      bids: [{ price: "0.32", size: "500" }],
      asks: [
        { price: "0.34", size: "500" },
        { price: "0.4", size: "500" },
      ],
    },
    frame === undefined ? {} : { frame },
  );

/** One BID level of the market's YES book (touches the market; changes no ask). */
const level = (offsetMs: number, marketId: string, price: string, frame?: string, size = "100"): IngestedEvent =>
  event(
    offsetMs,
    "BookLevelChanged",
    { internalMarketId: marketId, tokenId: TOKENS[marketId as keyof typeof TOKENS].yes, side: "BID", price, size },
    frame === undefined ? {} : { frame },
  );

/** One ASK level of the market's YES book (the venue fills a taker BUY against it). */
const askLevel = (offsetMs: number, marketId: string, price: string, size: string, frame?: string): IngestedEvent =>
  event(
    offsetMs,
    "BookLevelChanged",
    { internalMarketId: marketId, tokenId: TOKENS[marketId as keyof typeof TOKENS].yes, side: "ASK", price, size },
    frame === undefined ? {} : { frame },
  );

const opened = (offsetMs: number, marketId: string): IngestedEvent =>
  event(offsetMs, "MarketOpened", { internalMarketId: marketId, conditionId: `0xcap1${marketId.slice(-2)}`, openedAt: T_OPEN });

/** A public YES trade. `ASK`: the aggressor SOLD (fills resting BUYs); `BID`: it BOUGHT (fills resting SELLs). */
const trade = (
  offsetMs: number,
  marketId: string,
  price: string,
  size: string,
  takerSide: "ASK" | "BID",
  frame?: string,
): IngestedEvent =>
  event(
    offsetMs,
    "PublicTradeObserved",
    { internalMarketId: marketId, tokenId: TOKENS[marketId as keyof typeof TOKENS].yes, price, size, takerSide },
    frame === undefined ? {} : { frame },
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

/**
 * `loop-cadence.test.ts`'s opening: a reference trade, both markets' books at
 * 0 ms, then a reference trade at {@link S}. After it both markets were last
 * evaluated at S and nothing is owed.
 */
function opening(): IngestedEvent[] {
  return [
    reference(0),
    snapshot(0, MARKET_A, "yes"),
    snapshot(0, MARKET_A, "no"),
    snapshot(0, MARKET_B, "yes"),
    snapshot(0, MARKET_B, "no"),
    reference(S),
  ];
}

const S = 1_000;

// ---------------------------------------------------------------------------
// What the venue says is committed, and what the cap check counted
// ---------------------------------------------------------------------------

/**
 * The capital the VENUE says one market's BUY orders commit — computed from
 * the venue's own orders and fills, with nothing read from the allocator:
 *
 * - `floor`: what MUST be counted — each working order's unfilled shares at
 *   its limit, plus every fill's debit (`price × shares`), booked or not. The
 *   invariant is `counted ≥ floor`.
 * - `exact`: what the cap check counts with no double count and the exact
 *   remainder released — each order the loop still holds (its time-in-force is
 *   recorded: working, or terminal and not yet acted on) at its whole
 *   reservation `limit × shares`; each order the loop has settled at exactly
 *   its fills' debits.
 *
 * BUY-only by construction (the property's double sells nothing), so a
 * position's FIFO cost basis is exactly the sum of its booked BUY debits.
 */
function committed(harness: Harness): Readonly<Record<Label, { readonly floor: string; readonly exact: string }>> {
  const debits = new Map<string, string>();
  for (const fill of harness.venue.fills) {
    if (fill.action !== "BUY") continue;
    debits.set(fill.simulatedOrderId, addDecimal(debits.get(fill.simulatedOrderId) ?? "0", mulDecimal(fill.price, fill.shares)));
  }
  const out = { A: { floor: "0", exact: "0" }, B: { floor: "0", exact: "0" } };
  for (const order of harness.venue.ordersSnapshot()) {
    if (order.action !== "BUY") continue;
    const label: Label | undefined = order.marketId === MARKET_A ? "A" : order.marketId === MARKET_B ? "B" : undefined;
    if (label === undefined) continue;
    const debit = debits.get(order.simulatedOrderId) ?? "0";
    let floor = addDecimal(out[label].floor, debit);
    if (!TERMINAL.has(order.state)) {
      floor = addDecimal(floor, mulDecimal(order.limitPrice, subDecimal(order.requestedShares, order.filledShares)));
    }
    const exact = addDecimal(
      out[label].exact,
      harness.loop.timeInForceFor(order.plannedOrderId) === undefined ? debit : mulDecimal(order.limitPrice, order.requestedShares),
    );
    out[label] = { floor, exact };
  }
  return out;
}

/** One scope's `combined` from an exposure table, or `"0"` when the table does not mention it. */
function combinedOf(table: Readonly<Record<string, { readonly combined: string }>>, key: string): string {
  return Object.hasOwn(table, key) ? (table[key]?.combined ?? "0") : "0";
}

const OWNERS = [
  { marketId: MARKET_A, strategyInstanceId: INSTANCE_A },
  { marketId: MARKET_B, strategyInstanceId: INSTANCE_B },
] as const;

/**
 * What the cap check counts for each strategy and for the account RIGHT NOW,
 * asked through the gate's own `evaluate` with an intent that commits nothing
 * (a CANCEL: no request, so no verdict is recorded) — exactly the snapshot a
 * placement evaluated now would be judged against (§9.8 checks 14 and 15).
 */
function counted(harness: Harness): { readonly A: string; readonly B: string; readonly global: string } {
  const outcome = AllocatorGate.prototype.evaluate.call(harness.gate, {
    intent: { type: "CANCEL", marketId: MARKET_A, reason: "cap1: a read of the cap check's account" },
    instanceId: INSTANCE_A,
    accountingMode: "LIVE",
    liveOwners: OWNERS,
    projection: harness.loop.ledgerView(),
    // The read only: collateral moves no exposure entry. The real questions
    // (`evaluate` and `applyForPlan` in the loop) carry the real balance.
    availableCollateral: "1000000",
    approvedIntentId: "cap1-read",
    heldShares: () => "0",
  });
  return {
    A: combinedOf(outcome.exposures.byStrategyInstance, INSTANCE_A),
    B: combinedOf(outcome.exposures.byStrategyInstance, INSTANCE_B),
    global: outcome.exposures.global.combined,
  };
}

/** Asserts the invariant for both strategies and the account: `floor ≤ counted = exact`. */
function expectInvariant(harness: Harness, where: string): void {
  const now = counted(harness);
  const venue = committed(harness);
  let exactGlobal = "0";
  for (const label of ["A", "B"] as const) {
    const truth = venue[label];
    expect(now[label], `${where}: ${label} counted ≥ its floor ${truth.floor}`).toSatisfy(
      (value: string) => compareDecimal(value, truth.floor) >= 0,
    );
    expect(now[label], `${where}: ${label} counted exactly (no double count, the exact remainder released)`).toBe(truth.exact);
    exactGlobal = addDecimal(exactGlobal, truth.exact);
  }
  expect(now.global, `${where}: the account`).toBe(exactGlobal);
}

/** One run's health, reduced to what these pins compare. */
function outcomeOf(harness: Harness): {
  readonly accepted: number;
  readonly risk: Readonly<Record<string, number>>;
  readonly allocator: Readonly<Record<string, number>>;
  readonly fills: readonly string[];
  readonly orders: readonly string[];
} {
  const health = harness.loop.health();
  return {
    accepted: health.execution.submissionsAccepted,
    risk: health.risk.refusalsByCode,
    allocator: health.seams.allocator.refusalsByCode,
    fills: harness.venue.fills.map((fill) => `${fill.action} ${fill.shares}@${fill.price}`),
    orders: harness.venue.ordersSnapshot().map((order) => `${order.action} ${order.state} ${order.filledShares}/${order.requestedShares}`),
  };
}

// ---------------------------------------------------------------------------
// 1. The named regression
// ---------------------------------------------------------------------------

describe("CAP-1 regression — the CADENCE-1 R4-CAP probe (O-R3-01's capital side): an onFill BUY that fills at once no longer leaves the cap check before its fill is booked", () => {
  /**
   * B's heartbeat at S + 5 000 places a taker BUY of 10 that fills at once at
   * 0.34 (3.40 pUSD); its `onFill` places another, which fills at once too —
   * after the harvest read the venue, so its fill is booked only at the next
   * harvest point. A heartbeat at S + 10 000 then places a THIRD. Per-strategy
   * cap: 8 pUSD. 3 × 3.40 = 10.20 > 8, so the third must be refused.
   *
   * At base `a8b733e` the second BUY's reservation was released at its FILLED
   * view: the heartbeat at S + 10 000 counted 3.40 and admitted the third (on
   * the carried path, on the ordinary path, and under the per-frame cadence).
   */
  const CAP = "8";
  const FIRST = iso(S + 5_000);
  const BUY10: Act = { kind: "BUY", shares: "10", style: "FAK" };

  async function probe(variant: "carried" | "ordinary" | "control"): Promise<{ readonly harness: Harness; readonly judged: string[] }> {
    ordinal = 0;
    const third = variant === "control" ? iso(S + 15_000) : iso(S + 10_000);
    const judged: string[] = [];
    const harness = assemble({
      cadence: PAPER_EVALUATION_CADENCE,
      perStrategyCap: CAP,
      script: scheduled({ B: { onFeatures: [[FIRST, BUY10], [third, BUY10]], onFill: [[FIRST, BUY10]] } }),
    });
    // What B's strategy cap counted at each of B's cap checks.
    const original = harness.gate.evaluate.bind(harness.gate);
    vi.spyOn(harness.gate, "evaluate").mockImplementation((input) => {
      const outcome = original(input);
      if (input.instanceId === INSTANCE_B) judged.push(combinedOf(outcome.exposures.byStrategyInstance, INSTANCE_B));
      return outcome;
    });
    await feed(harness, ...opening(), opened(S + 150, MARKET_B));
    // The heartbeat's close: its source is an event of X (the CARRIED harvest) or of A (ordinary).
    await feed(harness, snapshot(S + 5_000, variant === "ordinary" ? MARKET_A : MARKET_X, "yes"));
    if (variant === "control") {
      // B's own event: the ordinary harvest books the onFill order's fill first.
      await feed(harness, level(S + 9_500, MARKET_B, "0.31"));
      await feed(harness, snapshot(S + 10_000, MARKET_X, "yes"));
      await feed(harness, snapshot(S + 15_000, MARKET_X, "yes"));
    } else {
      await feed(harness, snapshot(S + 10_000, MARKET_X, "yes"));
    }
    return { harness, judged };
  }

  for (const variant of ["carried", "ordinary"] as const) {
    it(`${variant} path: the third BUY is REFUSED at the per-strategy cap, exactly as the booked control refuses it`, async () => {
      const { harness, judged } = await probe(variant);
      const control = await probe("control");
      expect(outcomeOf(harness)).toEqual({
        accepted: 2,
        risk: { RISK_ALLOCATION_REFUSED: 1 },
        allocator: { CAPITAL_STRATEGY_CAP_EXCEEDED: 1 },
        fills: ["BUY 10@0.34", "BUY 10@0.34"],
        orders: ["BUY FILLED 10/10", "BUY FILLED 10/10"],
      });
      expect(outcomeOf(control.harness)).toEqual(outcomeOf(harness));
      // What B's cap check counted: nothing; 3.40 booked (the first order is
      // settled); then 3.40 booked + 3.40 FILLED and not yet booked — the
      // second order's exact debit, its 0.10 unused remainder released.
      // 6.80 + 3.50 > 8.
      expect(judged).toEqual(["0", "3.4", "6.8"]);
      expect(control.judged).toEqual(judged);
      expect(harness.halts.records()).toEqual([]);
    });
  }

  it("per-frame cadence (B's own events at S + 5 000 and S + 10 000): the same refusal", async () => {
    ordinal = 0;
    const harness = assemble({
      cadence: PER_FRAME,
      perStrategyCap: CAP,
      script: scheduled({ B: { onFeatures: [[FIRST, BUY10], [iso(S + 10_000), BUY10]], onFill: [[FIRST, BUY10]] } }),
    });
    await feed(harness, ...opening(), opened(S + 150, MARKET_B));
    await feed(harness, level(S + 5_000, MARKET_B, "0.31"));
    await feed(harness, level(S + 10_000, MARKET_B, "0.3"));
    expect(outcomeOf(harness)).toMatchObject({
      accepted: 2,
      risk: { RISK_ALLOCATION_REFUSED: 1 },
      allocator: { CAPITAL_STRATEGY_CAP_EXCEEDED: 1 },
      fills: ["BUY 10@0.34", "BUY 10@0.34"],
    });
  });
});

// ---------------------------------------------------------------------------
// 1b. The named regression for risk checks 16 and 17 (the r0 ruling)
// ---------------------------------------------------------------------------

/** What §9.8 check 16 measured at each of one strategy's risk evaluations: the maximum contractual loss, holdings plus the intent. */
function checkSixteen(harness: Harness, label: Label): (string | undefined)[] {
  return harness.risks.filter((risk) => risk.label === label).map((risk) => risk.evaluation.worstCase?.maximumContractualLoss);
}

/** The separate `unbookedFills` input each of one strategy's risk evaluations was handed (absent read as none). */
function unbookedInputs(harness: Harness, label: Label): (readonly unknown[])[] {
  return harness.risks.filter((risk) => risk.label === label).map((risk) => risk.document.unbookedFills ?? []);
}

describe("CAP-1 r0 regression — risk check 16 in the same window: the R4-CAP shape with maxWorstCaseContractualLoss 8 (allocator caps out of the way) refuses the third BUY RISK_WORST_CASE_LOSS_EXCEEDED, exactly as the booked control refuses it", () => {
  /**
   * The R4-CAP sequence, with the per-strategy cap at 1000 so the allocator
   * never binds and §9.8 check 16's PRIMARY limit at 8. The third BUY's worst
   * case is 3.40 booked + 3.40 FILLED and not yet booked + 3.50 (its own
   * bound) = 10.30 > 8.
   *
   * At `13994b9` the second order's fill was in no lot — not a position (its
   * harvest point had not come), not an open order (FILLED) — so check 16
   * measured 6.90 and the third BUY was admitted on every path (measured in
   * round 0: `probes/worst-case-candidate.log`).
   */
  const LIMIT = "8";
  const FIRST = iso(S + 5_000);
  const BUY10: Act = { kind: "BUY", shares: "10", style: "FAK" };

  async function probe(variant: "carried" | "ordinary" | "control"): Promise<Harness> {
    ordinal = 0;
    const third = variant === "control" ? iso(S + 15_000) : iso(S + 10_000);
    const harness = assemble({
      cadence: PAPER_EVALUATION_CADENCE,
      perStrategyCap: "1000",
      risk: { maxWorstCaseContractualLoss: LIMIT },
      script: scheduled({ B: { onFeatures: [[FIRST, BUY10], [third, BUY10]], onFill: [[FIRST, BUY10]] } }),
    });
    await feed(harness, ...opening(), opened(S + 150, MARKET_B));
    await feed(harness, snapshot(S + 5_000, variant === "ordinary" ? MARKET_A : MARKET_X, "yes"));
    if (variant === "control") {
      await feed(harness, level(S + 9_500, MARKET_B, "0.31"));
      await feed(harness, snapshot(S + 10_000, MARKET_X, "yes"));
      await feed(harness, snapshot(S + 15_000, MARKET_X, "yes"));
    } else {
      await feed(harness, snapshot(S + 10_000, MARKET_X, "yes"));
    }
    return harness;
  }

  for (const variant of ["carried", "ordinary"] as const) {
    it(`${variant} path: the third BUY is REFUSED at check 16, exactly as the booked control refuses it`, async () => {
      const harness = await probe(variant);
      const control = await probe("control");
      expect(outcomeOf(harness)).toEqual({
        accepted: 2,
        risk: { RISK_WORST_CASE_LOSS_EXCEEDED: 1 },
        allocator: {},
        fills: ["BUY 10@0.34", "BUY 10@0.34"],
        orders: ["BUY FILLED 10/10", "BUY FILLED 10/10"],
      });
      expect(outcomeOf(control)).toEqual(outcomeOf(harness));
      // 3.50 (the first BUY's own bound); 3.40 booked + 3.50; 3.40 booked +
      // 3.40 FILLED and not yet booked + 3.50. The control measures the same
      // 10.30 with the second fill booked.
      expect(checkSixteen(harness, "B")).toEqual(["3.5", "6.9", "10.3"]);
      expect(checkSixteen(control, "B")).toEqual(checkSixteen(harness, "B"));
      // The unbooked fill reached check 16 through its OWN input — its exact
      // debit, the second order's 0.10 unused remainder released — while the
      // control's was a booked position by then.
      expect(unbookedInputs(harness, "B")).toEqual([[], [], [{ marketId: MARKET_B, side: "YES", shares: "10", debit: "3.4" }]]);
      expect(unbookedInputs(control, "B")).toEqual([[], [], []]);
      // The trader always STATES the input — an empty list included — so an
      // absent one can never stand for "nothing unbooked".
      expect(harness.risks.map((risk) => Array.isArray(risk.document.unbookedFills))).toEqual([true, true, true]);
      expect(harness.halts.records()).toEqual([]);
    });
  }

  it("per-frame cadence (B's own events at S + 5 000 and S + 10 000): the same refusal", async () => {
    ordinal = 0;
    const harness = assemble({
      cadence: PER_FRAME,
      perStrategyCap: "1000",
      risk: { maxWorstCaseContractualLoss: LIMIT },
      script: scheduled({ B: { onFeatures: [[FIRST, BUY10], [iso(S + 10_000), BUY10]], onFill: [[FIRST, BUY10]] } }),
    });
    await feed(harness, ...opening(), opened(S + 150, MARKET_B));
    await feed(harness, level(S + 5_000, MARKET_B, "0.31"));
    await feed(harness, level(S + 10_000, MARKET_B, "0.3"));
    expect(outcomeOf(harness)).toMatchObject({
      accepted: 2,
      risk: { RISK_WORST_CASE_LOSS_EXCEEDED: 1 },
      allocator: {},
      fills: ["BUY 10@0.34", "BUY 10@0.34"],
    });
    expect(checkSixteen(harness, "B")).toEqual(["3.5", "6.9", "10.3"]);
    expect(harness.halts.records()).toEqual([]);
  });
});

describe("CAP-1 r0 — what the separate input is NOT: never a sellable position (§6 invariant 10), never an open order (§9.8 check 18)", () => {
  /**
   * The R4-CAP opening (two BUYs of 10 @ 0.34, the second FILLED at once and
   * not yet booked), then, at a heartbeat in that window, B's take-profit: a
   * GTC taker SELL of its WHOLE position bounded at 0.32 — below the FILLED
   * BUY's 0.34 fill and 0.35 limit. Check 16's limit is 7: the holdings alone
   * (6.80) pass it, any further BUY (+3.50) does not.
   */
  const FIRST = iso(S + 5_000);
  const SECOND = iso(S + 10_000);
  const BUY10: Act = { kind: "BUY", shares: "10", style: "FAK" };

  async function run(atSecond: Act): Promise<Harness> {
    ordinal = 0;
    const harness = assemble({
      cadence: PAPER_EVALUATION_CADENCE,
      perStrategyCap: "1000",
      risk: { maxWorstCaseContractualLoss: "7" },
      script: scheduled({ B: { onFeatures: [[FIRST, BUY10], [SECOND, atSecond]], onFill: [[FIRST, BUY10]] } }),
    });
    await feed(harness, ...opening(), opened(S + 150, MARKET_B));
    await feed(harness, snapshot(S + 5_000, MARKET_X, "yes"));
    await feed(harness, snapshot(S + 10_000, MARKET_X, "yes"));
    return harness;
  }

  it("a protective SELL in the unbooked window is ADMITTED and sells only the 10 BOOKED shares; the FILLED order is in no open order, and its fill only in the separate input", async () => {
    const harness = await run({ kind: "SELL_ALL", taker: true });
    expect(outcomeOf(harness)).toEqual({
      accepted: 3,
      risk: {},
      allocator: {},
      fills: ["BUY 10@0.34", "BUY 10@0.34", "SELL 10@0.32"],
      orders: ["BUY FILLED 10/10", "BUY FILLED 10/10", "SELL FILLED 10/10"],
    });
    const exit = harness.risks.filter((risk) => risk.label === "B").at(-1);
    expect(exit?.context.intent).toMatchObject({ type: "POSITION", targetMode: "ABSOLUTE", targetShares: "0" });
    expect(exit?.evaluation.approved).toBe(true);
    // What the engine was handed: the BOOKED position only (so the exit's
    // size, 0 − 10, sells nothing unbooked), NO open order (the FILLED BUY is
    // not resting, so check 18 cannot read it as one), and the unbooked fill
    // in its own input, which only checks 16 and 17 read.
    expect(exit?.document.portfolio.positions.map((position) => position.shares)).toEqual(["10"]);
    expect(exit?.document.portfolio.openOrders).toEqual([]);
    expect(exit?.document.unbookedFills).toEqual([{ marketId: MARKET_B, side: "YES", shares: "10", debit: "3.4" }]);
    expect(harness.halts.records()).toEqual([]);
  });

  it("an ENTRY in the same window is refused at check 16 (6.80 + 3.50 > 7): the exit above was admitted as an exit, not because the window hid anything", async () => {
    const harness = await run(BUY10);
    expect(outcomeOf(harness)).toMatchObject({
      accepted: 2,
      risk: { RISK_WORST_CASE_LOSS_EXCEEDED: 1 },
      allocator: {},
      orders: ["BUY FILLED 10/10", "BUY FILLED 10/10"],
    });
    expect(checkSixteen(harness, "B")).toEqual(["3.5", "6.9", "10.3"]);
  });
});

describe("CAP-1 r0 — exactly what the separate input states, through the real loop", () => {
  it("an UNSETTLED terminal order (an onOrderUpdate FAK, partly filled and cancelled at once, outside its harvest's view boundary): checks 16 and 17 count exactly its FILLED unbooked shares — at its limit, its fill page unread on this path — and a RESTING order only through openOrders", async () => {
    ordinal = 0;
    const harness = assemble({
      cadence: PAPER_EVALUATION_CADENCE,
      perStrategyCap: "1000",
      script: scheduled({
        B: {
          onFeatures: [
            // A resting maker BUY of 10 at 0.30: 3.00, presented as an open order.
            [iso(S + 5_000), { kind: "BUY", shares: "10", style: "MAKER" }],
            [iso(S + 10_000), { kind: "BUY", shares: "10", style: "FAK" }],
          ],
          // Its RESTING view places a FAK of 10 at ≤ 0.35 against 5 shares at
          // 0.34: 5 fill, 5 are cancelled — CANCELLED 5/10 at once.
          onOrderUpdate: [[iso(S + 5_000), { kind: "BUY", shares: "10", style: "FAK" }]],
        },
      }),
    });
    await feed(harness, ...opening(), opened(S + 150, MARKET_B), askLevel(S + 200, MARKET_B, "0.4", "500"), askLevel(S + 210, MARKET_B, "0.34", "5"));
    await feed(harness, level(S + 5_000, MARKET_B, "0.31"));
    expect(outcomeOf(harness).orders).toEqual(["BUY RESTING 0/10", "BUY CANCELLED 5/10"]);
    expect(harness.loop.health().execution.fillsObserved).toBe(0);
    // A heartbeat at an event for no configured market: B's third BUY is
    // judged while the FAK is terminal, unbooked and not yet settled.
    await feed(harness, snapshot(S + 10_000, MARKET_X, "yes"));
    const third = harness.risks.filter((risk) => risk.label === "B").at(-1);
    // Exactly the 5 FILLED shares, at the 0.35 limit (never below their
    // 0.34 debit) — not the 5 cancelled ones, and not the resting order,
    // which openOrders presents whole.
    expect(third?.document.unbookedFills).toEqual([{ marketId: MARKET_B, side: "YES", shares: "5", debit: "1.75" }]);
    expect(third?.document.portfolio.openOrders.map((open) => open.orderId)).toHaveLength(1);
    // Check 16: 3.00 resting + 1.75 unbooked + 3.50 this BUY.
    expect(third?.evaluation.worstCase?.maximumContractualLoss).toBe("8.25");
    expect(harness.halts.records()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. One pin per path
// ---------------------------------------------------------------------------

describe("CAP-1 paths: each place a commitment could leave the cap check before a position carries it", () => {
  it("THE RELEASE AT FILLED (ordinary harvest): the onFill order's FILLED view releases only its unused remainder; its fill's exact debit is counted until the next harvest point books it, and then the commitment closes", async () => {
    ordinal = 0;
    const first = iso(S + 5_000);
    const harness = assemble({
      cadence: PAPER_EVALUATION_CADENCE,
      perStrategyCap: "1000",
      script: scheduled({ B: { onFeatures: [[first, { kind: "BUY", shares: "10", style: "FAK" }]], onFill: [[first, { kind: "BUY", shares: "10", style: "FAK" }]] } }),
    });
    await feed(harness, ...opening(), opened(S + 150, MARKET_B));
    await feed(harness, snapshot(S + 5_000, MARKET_A, "yes"));
    // Both FILLED; the second's fill unread (it keeps its ADR-024 harvest point).
    expect(outcomeOf(harness).orders).toEqual(["BUY FILLED 10/10", "BUY FILLED 10/10"]);
    expect(harness.loop.health().execution.fillsObserved).toBe(1);
    // The first is settled and booked (closed). The second is settled: 10 ×
    // 0.35 reserved, 10 × 0.34 filled — its 0.10 unused remainder released,
    // its 3.40 debit held: it is in no position yet.
    expect(harness.loop.health().seams.allocator).toMatchObject({ open: 1, applied: 2, released: 1, reservedCollateral: "3.4" });
    expect(counted(harness)).toEqual({ A: "0", B: "6.8", global: "6.8" });
    expectInvariant(harness, "after the FILLED view");
    // Heartbeats at events for no configured market: still counted.
    await feed(harness, snapshot(S + 10_000, MARKET_X, "yes"));
    expect(counted(harness).B).toBe("6.8");
    // B's own event: the ordinary harvest books the fill; the commitment closes.
    await feed(harness, level(S + 10_100, MARKET_B, "0.31"));
    expect(harness.loop.health().execution.fillsObserved).toBe(2);
    expect(harness.loop.health().seams.allocator).toMatchObject({ open: 0, applied: 2, released: 2, reservedCollateral: "0" });
    expect(counted(harness)).toEqual({ A: "0", B: "6.8", global: "6.8" });
    expectInvariant(harness, "after the booking");
  });

  it("A PARTIAL FILL, then A CANCEL: no double count while it rests (reservation, not reservation + position), so a BUY a booked account admits is admitted; the cancel releases exactly the unused remainder", async () => {
    ordinal = 0;
    const harness = assemble({
      cadence: PAPER_EVALUATION_CADENCE,
      perStrategyCap: "5",
      script: scheduled({
        B: {
          onFeatures: [
            // A GTC taker BUY of 10 at ≤ 0.35: 5 fill at 0.34, 5 REST at 0.35.
            [iso(S + 5_000), { kind: "BUY", shares: "10", style: "GTC" }],
            // A resting maker BUY of 5 at 0.30 (1.50 pUSD): 3.50 + 1.50 = 5 ≤ 5.
            [iso(S + 6_100), { kind: "BUY", shares: "5", style: "MAKER" }],
            [iso(S + 7_200), { kind: "CANCEL" }],
          ],
        },
      }),
    });
    // B's asks: 5 shares at 0.34, then 0.40 (beyond the 0.35 bound).
    await feed(harness, ...opening(), opened(S + 150, MARKET_B), askLevel(S + 200, MARKET_B, "0.4", "500"), askLevel(S + 210, MARKET_B, "0.34", "5"));
    await feed(harness, level(S + 5_000, MARKET_B, "0.31"));
    expect(outcomeOf(harness).orders).toEqual(["BUY PARTIALLY_FILLED 5/10"]);
    expect(harness.loop.health().execution.fillsObserved).toBe(1);
    // 1.70 is in the position; the commitment holds 3.50 − 1.70 = 1.80: B is
    // counted at its reservation, 3.50 — never 3.50 + 1.70 (base: 5.20).
    expect(harness.loop.health().seams.allocator).toMatchObject({ open: 1, reservedCollateral: "1.8" });
    expect(counted(harness).B).toBe("3.5");
    expectInvariant(harness, "while the partly filled order rests");
    await feed(harness, level(S + 6_100, MARKET_B, "0.31"));
    // Admitted: 3.50 + 1.50 = 5 ≤ 5 (base counted 5.20 and refused it).
    expect(outcomeOf(harness)).toMatchObject({ accepted: 2, allocator: {} });
    // `CAP-1` r0: the partly filled order RESTS, so risk's open orders present
    // it whole and the separate unbooked input states nothing for it.
    expect(harness.risks.at(-1)?.document.portfolio.openOrders).toHaveLength(1);
    expect(harness.risks.at(-1)?.document.unbookedFills).toEqual([]);
    expect(counted(harness).B).toBe("5");
    expectInvariant(harness, "with the maker BUY resting");
    await feed(harness, level(S + 7_200, MARKET_B, "0.3"));
    expect(outcomeOf(harness).orders).toEqual(["BUY CANCELLED 5/10", "BUY CANCELLED 0/5"]);
    // Released: the GTC order's 1.80 and the maker order's 1.50 — exactly the
    // unused remainders. What stays is the position: 5 × 0.34.
    expect(harness.loop.health().seams.allocator).toMatchObject({ open: 0, applied: 2, released: 2, reservedCollateral: "0" });
    expect(counted(harness)).toEqual({ A: "0", B: "1.7", global: "1.7" });
    expectInvariant(harness, "after the cancel");
  });

  it("A PARTLY SOLD covered SELL: its booked sale leaves its reservation, so the account still rebuilds and another strategy's BUY is judged (base refused EVERY placement, CAPITAL_INVENTORY_INSUFFICIENT, while it rested)", async () => {
    ordinal = 0;
    const harness = assemble({
      cadence: PAPER_EVALUATION_CADENCE,
      perStrategyCap: "1000",
      script: scheduled({
        B: {
          onFeatures: [[iso(S + 5_000), { kind: "BUY", shares: "10", style: "FAK" }]],
          // A GTC taker SELL of the 10 shares, bounded at 0.32: 5 sell into the
          // thin 0.32 bid at once, 5 REST.
          onFill: [[iso(S + 5_000), { kind: "SELL_ALL", taker: true }]],
        },
        A: { onFeatures: [[iso(S + 7_000), { kind: "BUY", shares: "10", style: "FAK" }]] },
      }),
    });
    await feed(harness, ...opening(), opened(S + 100, MARKET_A), opened(S + 150, MARKET_B), level(S + 200, MARKET_B, "0.32", undefined, "5"));
    // B's own event (an ask level, so the thin bid stays).
    await feed(harness, askLevel(S + 5_000, MARKET_B, "0.34", "500"));
    expect(outcomeOf(harness).orders).toEqual(["BUY FILLED 10/10", "SELL PARTIALLY_FILLED 5/10"]);
    // B's next event books the sale: the position holds 5, the SELL rests 5.
    await feed(harness, askLevel(S + 6_000, MARKET_B, "0.34", "500"));
    expect(harness.loop.health().execution.fillsObserved).toBe(2);
    await feed(harness, level(S + 7_000, MARKET_A, "0.31"));
    // A's BUY is judged on a rebuilt account, and admitted.
    expect(outcomeOf(harness)).toMatchObject({ accepted: 3, risk: {}, allocator: {} });
    expect(outcomeOf(harness).orders).toEqual(["BUY FILLED 10/10", "SELL PARTIALLY_FILLED 5/10", "BUY FILLED 10/10"]);
    expect(harness.halts.records()).toEqual([]);
  });

  it("AN onOrderUpdate PLACEMENT that fills at once: not in its harvest's view boundary, so its whole reservation stays counted until the next harvest books it", async () => {
    ordinal = 0;
    const harness = assemble({
      cadence: PAPER_EVALUATION_CADENCE,
      perStrategyCap: "8",
      script: scheduled({
        B: {
          onFeatures: [
            [iso(S + 5_000), { kind: "BUY", shares: "10", style: "MAKER" }],
            [iso(S + 10_000), { kind: "BUY", shares: "10", style: "FAK" }],
          ],
          onOrderUpdate: [[iso(S + 5_000), { kind: "BUY", shares: "10", style: "FAK" }]],
        },
      }),
    });
    await feed(harness, ...opening(), opened(S + 150, MARKET_B));
    await feed(harness, level(S + 5_000, MARKET_B, "0.31"));
    expect(outcomeOf(harness).orders).toEqual(["BUY RESTING 0/10", "BUY FILLED 10/10"]);
    // 3 (resting maker) + 3.50 (the FAK order, filled, nothing of it read yet).
    expect(counted(harness).B).toBe("6.5");
    expectInvariant(harness, "after the onOrderUpdate placement");
    // A heartbeat at an event for no configured market: 6.50 + 3.50 > 8.
    await feed(harness, snapshot(S + 10_000, MARKET_X, "yes"));
    expect(outcomeOf(harness)).toMatchObject({ accepted: 2, allocator: { CAPITAL_STRATEGY_CAP_EXCEEDED: 1 } });
    await feed(harness, level(S + 10_100, MARKET_B, "0.31"));
    expect(counted(harness).B).toBe("6.4");
    expectInvariant(harness, "after the booking");
  });

  it("A FILL APPLIED AT AN UNCONFIGURED MARKET'S observe() (Tier 1, a 5 s delayed market): the DELAYED order's reservation stays counted through the heartbeats at that event until the next ordinary harvest books its fill", async () => {
    ordinal = 0;
    const harness = assemble({
      cadence: PAPER_EVALUATION_CADENCE,
      perStrategyCap: "6",
      tier1DelaySeconds: 5,
      script: scheduled({
        B: {
          onFeatures: [
            [iso(S + 5_000), { kind: "BUY", shares: "10", style: "FAK" }],
            [iso(S + 11_000), { kind: "BUY", shares: "10", style: "FAK" }],
          ],
        },
      }),
    });
    await feed(harness, ...opening(), opened(S + 150, MARKET_B));
    await feed(harness, level(S + 5_000, MARKET_B, "0.31"));
    expect(outcomeOf(harness).orders).toEqual(["BUY DELAYED 0/10"]);
    expect(counted(harness).B).toBe("3.5");
    // The venue's clock reaches matchableAtNs; the next event — for a market
    // this trader does not run — applies the disposition in observe(), and
    // B's heartbeat at that same close places another BUY.
    harness.clock.positionAt(iso(S + 11_000), 6_000_000_000n);
    await feed(harness, snapshot(S + 11_000, MARKET_X, "yes"));
    expect(outcomeOf(harness).orders).toEqual(["BUY FILLED 10/10"]);
    // The fill is unread (no harvest point at X), and the reservation stays:
    // 3.50 + 3.50 > 6, so the heartbeat's BUY is refused.
    expect(harness.loop.health().execution.fillsObserved).toBe(0);
    expect(outcomeOf(harness)).toMatchObject({ accepted: 1, allocator: { CAPITAL_STRATEGY_CAP_EXCEEDED: 1 } });
    expect(counted(harness).B).toBe("3.5");
    expectInvariant(harness, "at the heartbeat after observe()'s fill");
    await feed(harness, level(S + 11_100, MARKET_B, "0.31"));
    expect(harness.loop.health().execution.fillsObserved).toBe(1);
    expect(counted(harness).B).toBe(harness.venue.fills.reduce((total, fill) => addDecimal(total, mulDecimal(fill.price, fill.shares)), "0"));
    expectInvariant(harness, "after the booking");
  });
});

// ---------------------------------------------------------------------------
// 3. The seeded property
// ---------------------------------------------------------------------------

/** `mulberry32`: a small seeded PRNG — deterministic, never a host source. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function pick<T>(random: () => number, choices: readonly T[]): T {
  const chosen = choices[Math.floor(random() * choices.length)];
  if (chosen === undefined) throw new Error("pick from an empty list");
  return chosen;
}

/** The random double: what each callback does is drawn from `random`. */
function randomScript(random: () => number): Script {
  return (call) => {
    const r = random();
    const shares = pick(random, ["5", "10", "15"]);
    switch (call.callback) {
      case "onFeatures":
        return r < 0.25
          ? { kind: "BUY", shares, style: "FAK" }
          : r < 0.35
            ? { kind: "BUY", shares, style: "GTC" }
            : r < 0.5
              ? { kind: "BUY", shares, style: "MAKER" }
              : r < 0.58
                ? { kind: "CANCEL" }
                : HOLD;
      case "onFill":
        return r < 0.35
          ? { kind: "BUY", shares, style: "FAK" }
          : r < 0.45
            ? { kind: "BUY", shares, style: "GTC" }
            : r < 0.5
              ? { kind: "BUY", shares, style: "MAKER" }
              : r < 0.55
                ? { kind: "CANCEL" }
                : HOLD;
      case "onOrderUpdate":
        return r < 0.12 ? { kind: "BUY", shares, style: "FAK" } : r < 0.16 ? { kind: "BUY", shares, style: "GTC" } : r < 0.2 ? { kind: "CANCEL" } : HOLD;
      case "onMarketOpen":
        return r < 0.3 ? { kind: "BUY", shares, style: "MAKER" } : HOLD;
    }
  };
}

/** What a run exercised, summed over every seed (the property's non-vacuity). */
interface Coverage {
  evaluationsChecked: number;
  capChecks: number;
  admissions: number;
  capRefusals: number;
  partialFills: number;
  cancelledAfterPartial: number;
  onFillPlacements: number;
  onOrderUpdatePlacements: number;
  carriedHarvestFills: number;
  ordinaryHarvestFills: number;
  unbookedFillsAtEvaluation: number;
  restarts: number;
  /** `CAP-1` r0: risk evaluations at which checks 16 and 17's holdings were held to the venue's floor. */
  riskEvaluationsChecked: number;
  /** … of which the separate `unbookedFills` input was non-empty. */
  riskEvaluationsWithUnbooked: number;
  /** Scenario outcomes (check 17) held to the floor. */
  scenarioOutcomesChecked: number;
  /** Entries refused at check 16's primary limit. */
  worstCaseRefusals: number;
  /** Entries the risk engine admitted, each held under the worst-case limit by the venue's floor. */
  riskAdmissions: number;
}

/**
 * `CAP-1` r0: the holdings §9.8 checks 16 and 17 MUST count for one strategy's
 * market at an evaluation — from the venue's own orders and fills, nothing
 * read from the allocator or the risk input: every BUY fill of the market,
 * booked or not, at its shares and debit, plus each working BUY's unfilled
 * shares at its limit (a resting BUY counts as if filled).
 */
function holdingsFloor(harness: Harness, label: Label): { readonly cost: string; readonly shares: string } {
  const marketId = label === "A" ? MARKET_A : MARKET_B;
  let cost = "0";
  let shares = "0";
  for (const fill of harness.venue.fills) {
    if (fill.action !== "BUY" || fill.marketId !== marketId) continue;
    cost = addDecimal(cost, mulDecimal(fill.price, fill.shares));
    shares = addDecimal(shares, fill.shares);
  }
  for (const order of harness.venue.ordersSnapshot()) {
    if (order.action !== "BUY" || order.marketId !== marketId || TERMINAL.has(order.state)) continue;
    const unfilled = subDecimal(order.requestedShares, order.filledShares);
    cost = addDecimal(cost, mulDecimal(order.limitPrice, unfilled));
    shares = addDecimal(shares, unfilled);
  }
  return { cost, shares };
}

/** What the intent itself adds to check 16's lot: a BUY's shares and its bounded cost (the tighter ceiling). */
function boughtBy(intent: Intent): { readonly cost: string; readonly shares: string } {
  if (intent.type !== "POSITION" || intent.targetMode !== "DELTA" || intent.maximumBuyPrice === undefined) return { cost: "0", shares: "0" };
  if (compareDecimal(intent.targetShares, "0") <= 0) return { cost: "0", shares: "0" };
  const byPrice = mulDecimal(intent.maximumBuyPrice, intent.targetShares);
  const cost = intent.maximumTotalCost !== undefined && compareDecimal(intent.maximumTotalCost, byPrice) < 0 ? intent.maximumTotalCost : byPrice;
  return { cost, shares: intent.targetShares };
}

/**
 * `CAP-1` r0: at one risk evaluation, §9.8 checks 16 and 17 count at least the
 * venue's floor (`holdingsFloor`), and an admitted entry stays under check
 * 16's limit by that floor.
 *
 * - check 16: the evaluating market's lot, less the intent's own leg, holds
 *   at least the floor's cost and shares (its primary measure is that cost);
 * - check 17: every scenario that marks the lot measures, less the intent's
 *   own loss, at least the floor's loss under the same mark (`cost − shares ×
 *   mark`; the harness's marks never exceed a limit price, so a resting
 *   order's over-count cannot hide an undercount here);
 * - an APPROVED entry: floor + its bounded cost ≤ `maxWorstCaseContractualLoss`.
 */
function expectRiskFloor(harness: Harness, risk: Harness["risks"][number], worstCaseLimit: string, coverage: Coverage, where: string): void {
  const marketId = risk.label === "A" ? MARKET_A : MARKET_B;
  const floor = holdingsFloor(harness, risk.label);
  const bought = boughtBy(risk.context.intent);
  const worstCase = risk.evaluation.worstCase;
  expect(worstCase, `${where}: check 16 measured`).toBeDefined();
  if (worstCase === undefined) return;
  coverage.riskEvaluationsChecked += 1;
  if ((risk.document.unbookedFills ?? []).length > 0) coverage.riskEvaluationsWithUnbooked += 1;
  const lot = worstCase.perMarket.find((market) => market.marketId === marketId);
  const countedCost = subDecimal(lot?.committedCost ?? "0", bought.cost);
  const countedShares = subDecimal(lot?.yesShares ?? "0", bought.shares);
  expect(countedCost, `${where}: check 16 counts ${countedCost} of the floor's ${floor.cost} pUSD`).toSatisfy(
    (value: string) => compareDecimal(value, floor.cost) >= 0,
  );
  expect(countedShares, `${where}: check 16 counts ${countedShares} of the floor's ${floor.shares} shares`).toSatisfy(
    (value: string) => compareDecimal(value, floor.shares) >= 0,
  );
  for (const outcome of risk.evaluation.scenario?.outcomes ?? []) {
    if (outcome.unmarkedMarketIds.length > 0) continue;
    const mark = risk.document.scenarios
      .find((scenario) => scenario.scenarioId === outcome.scenarioId)
      ?.marks.find((entry) => entry.marketId === marketId)?.yesPrice;
    if (mark === undefined) continue;
    coverage.scenarioOutcomesChecked += 1;
    const countedLoss = subDecimal(outcome.loss, subDecimal(bought.cost, mulDecimal(bought.shares, mark)));
    const floorLoss = subDecimal(floor.cost, mulDecimal(floor.shares, mark));
    expect(countedLoss, `${where}: check 17 (${outcome.scenarioId}) measures ${countedLoss} of the floor's ${floorLoss}`).toSatisfy(
      (value: string) => compareDecimal(value, floorLoss) >= 0,
    );
  }
  if (risk.evaluation.refusals.some((refusal) => refusal.code === "RISK_WORST_CASE_LOSS_EXCEEDED")) coverage.worstCaseRefusals += 1;
  if (risk.evaluation.approved && risk.context.intent.type !== "CANCEL") {
    coverage.riskAdmissions += 1;
    const projected = addDecimal(floor.cost, bought.cost);
    expect(compareDecimal(projected, worstCaseLimit), `${where}: an entry admitted at ${projected} over check 16's ${worstCaseLimit}`).toBeLessThanOrEqual(0);
  }
}

/** A configured or unconfigured market, by its short name. */
const MARKET_NAMED = { A: MARKET_A, B: MARKET_B, X: MARKET_X } as const;

/** One random event (or one random multi-event frame) at `at`. */
function randomEvents(random: () => number, at: number, frameKey: string): { readonly events: IngestedEvent[]; readonly unconfiguredOnly: boolean } {
  const one = (frame?: string): { readonly event: IngestedEvent; readonly unconfigured: boolean } => {
    const r = random();
    const market = pick(random, ["A", "B"] as const);
    if (r < 0.22) {
      const name = pick(random, ["A", "B", "X", "X"] as const);
      return { event: snapshot(at, MARKET_NAMED[name], pick(random, ["yes", "no"] as const), frame), unconfigured: name === "X" };
    }
    if (r < 0.32) return { event: snapshot(at, MARKET_X, "yes", frame), unconfigured: true };
    if (r < 0.44) return { event: askLevel(at, MARKET_NAMED[market], "0.34", pick(random, ["5", "0"]), frame), unconfigured: false };
    if (r < 0.5) return { event: askLevel(at, MARKET_NAMED[market], "0.34", "500", frame), unconfigured: false };
    if (r < 0.68) {
      return {
        event: trade(at, MARKET_NAMED[market], pick(random, ["0.3", "0.35", "0.29"]), pick(random, ["5", "5", "50"]), "ASK", frame),
        unconfigured: false,
      };
    }
    if (r < 0.76) return { event: reference(at, frame), unconfigured: false };
    return { event: level(at, MARKET_NAMED[market], pick(random, ["0.31", "0.3"]), frame), unconfigured: false };
  };
  if (random() < 0.2) {
    const count = pick(random, [2, 3]);
    const members = Array.from({ length: count }, () => one(frameKey));
    return { events: members.map((member) => member.event), unconfiguredOnly: members.every((member) => member.unconfigured) };
  }
  const single = one();
  return { events: [single.event], unconfiguredOnly: single.unconfigured };
}

/**
 * One seeded run: `steps` random events (or frames), each fed as one batch,
 * with occasional RESTARTS — a fresh process, as PAPER restarts one (a new
 * run, an empty ledger, a fresh simulated venue and allocator: no committed
 * capital survives a restart, because the simulated account does not).
 *
 * Checked at every evaluation:
 *
 * - before EVERY strategy callback: `floor ≤ counted = exact`, per strategy
 *   and for the account (`expectInvariant`);
 * - at EVERY cap check the loop makes (`AllocatorGate.evaluate`): the snapshot
 *   it judged the intent against counted the evaluating strategy exactly;
 * - at EVERY reservation the gate admits (`applyForPlan`): the venue's floor
 *   AND exact commitment plus the admitted cost stay within the per-strategy
 *   and the global cap — no admitted intent takes a strategy over its cap.
 */
async function propertyRun(seed: number, cadence: EvaluationCadenceOption, steps: number, coverage: Coverage): Promise<void> {
  ordinal = 0;
  const events = prng(seed);
  const decisions = prng(seed ^ 0x5eed_cafe);
  const script = randomScript(decisions);
  const perStrategyCap = pick(events, ["6", "8", "10.2", "14"]);
  const globalAccountCap = pick(events, ["12", "20", "1000"]);
  // `CAP-1` r0: check 16's limit, from its OWN stream (so the event sequence
  // is the one round 0 measured): sometimes binding, sometimes not.
  const worstCaseLimit = pick(prng(seed ^ 0x0c16_0c17), ["7", "9", "12", "1000"]);
  const tracking: Script = (call) => {
    const act = script(call);
    if (act.kind === "BUY" && call.callback === "onFill") coverage.onFillPlacements += 1;
    if (act.kind === "BUY" && call.callback === "onOrderUpdate") coverage.onOrderUpdatePlacements += 1;
    return act;
  };
  let unconfiguredOnly = false;

  const start = (): Harness => {
    const harness = assemble({
      cadence,
      perStrategyCap,
      globalAccountCap,
      risk: { maxWorstCaseContractualLoss: worstCaseLimit },
      script: tracking,
      onRisk: (current, risk) => {
        expectRiskFloor(current, risk, worstCaseLimit, coverage, `seed ${String(seed)} at ${risk.label}'s risk check at ${risk.context.evaluatedAt}`);
      },
      beforeEvaluation: (current, input) => {
        coverage.evaluationsChecked += 1;
        if (input.callback === "onFill") {
          if (unconfiguredOnly) coverage.carriedHarvestFills += 1;
          else coverage.ordinaryHarvestFills += 1;
        }
        for (const order of current.venue.ordersSnapshot()) {
          if (compareDecimal(order.filledShares, "0") > 0 && compareDecimal(order.filledShares, order.requestedShares) < 0) {
            coverage.partialFills += 1;
          }
        }
        // A fill the venue made that no position carries yet (BUY-only: the
        // positions' shares are exactly the booked fills' shares).
        let held = "0";
        for (const line of current.loop.ledgerView().virtualPositions.values()) {
          if (line.assetId.startsWith("token:")) held = addDecimal(held, line.balance);
        }
        let filled = "0";
        for (const fill of current.venue.fills) filled = addDecimal(filled, fill.shares);
        if (compareDecimal(filled, held) > 0) coverage.unbookedFillsAtEvaluation += 1;
        expectInvariant(current, `seed ${String(seed)} before ${input.callback} at ${input.evaluatedAt}`);
      },
    });
    const evaluate = harness.gate.evaluate.bind(harness.gate);
    vi.spyOn(harness.gate, "evaluate").mockImplementation((input) => {
      const outcome = evaluate(input);
      coverage.capChecks += 1;
      const label: Label = input.instanceId === INSTANCE_A ? "A" : "B";
      expect(
        combinedOf(outcome.exposures.byStrategyInstance, input.instanceId),
        `seed ${String(seed)}: the cap check's own snapshot for ${label}`,
      ).toBe(committed(harness)[label].exact);
      if (outcome.verdict?.permitted === false && outcome.verdict.refusals.some((refusal) => refusal.code === "CAPITAL_STRATEGY_CAP_EXCEEDED")) {
        coverage.capRefusals += 1;
      }
      return outcome;
    });
    const apply = harness.gate.applyForPlan.bind(harness.gate);
    vi.spyOn(harness.gate, "applyForPlan").mockImplementation((input) => {
      const before = committed(harness);
      const applied = apply(input);
      if (!applied.ok) return applied;
      coverage.admissions += 1;
      let added = { A: "0", B: "0" };
      for (const entry of input.entries) {
        if (entry.request.action !== "BUY") continue;
        const label: Label = entry.request.strategyInstanceId === INSTANCE_A ? "A" : "B";
        added = { ...added, [label]: addDecimal(added[label], mulDecimal(entry.request.price, entry.request.shares)) };
      }
      for (const label of ["A", "B"] as const) {
        for (const measure of ["floor", "exact"] as const) {
          const projected = addDecimal(before[label][measure], added[label]);
          expect(compareDecimal(projected, perStrategyCap), `seed ${String(seed)}: ${label}'s ${measure} ${projected} admitted over ${perStrategyCap}`).toBeLessThanOrEqual(0);
        }
      }
      const account = addDecimal(addDecimal(before.A.exact, before.B.exact), addDecimal(added.A, added.B));
      expect(compareDecimal(account, globalAccountCap), `seed ${String(seed)}: the account ${account} admitted over ${globalAccountCap}`).toBeLessThanOrEqual(0);
      return applied;
    });
    return harness;
  };

  const warmUp = async (harness: Harness, at: number): Promise<void> => {
    unconfiguredOnly = false;
    await feed(
      harness,
      [reference(at), snapshot(at, MARKET_A, "yes"), snapshot(at, MARKET_A, "no"), snapshot(at, MARKET_B, "yes"), snapshot(at, MARKET_B, "no")],
      opened(at + 10, MARKET_A),
      opened(at + 20, MARKET_B),
    );
  };

  let harness = start();
  let at = S;
  await warmUp(harness, at);
  for (let step = 0; step < steps; step += 1) {
    at += pick(events, [0, 20, 400, 1_000, 1_500, 3_000, 5_000, 6_000]);
    if (events() < 0.03) {
      // A RESTART: the process ends here; a new one starts from the stream.
      expectInvariant(harness, `seed ${String(seed)} at the restart`);
      coverage.restarts += 1;
      harness = start();
      expect(harness.gate.metrics()).toMatchObject({ open: 0, applied: 0 });
      expect(harness.venue.ordersSnapshot()).toEqual([]);
      await warmUp(harness, at);
      continue;
    }
    const drawn = randomEvents(events, at, `cap1-${String(seed)}-${String(step)}`);
    unconfiguredOnly = drawn.unconfiguredOnly;
    await feed(harness, drawn.events);
    expectInvariant(harness, `seed ${String(seed)} after step ${String(step)}`);
  }
  for (const order of harness.venue.ordersSnapshot()) {
    if (order.state === "CANCELLED" && compareDecimal(order.filledShares, "0") > 0) coverage.cancelledAfterPartial += 1;
  }
  expect(harness.halts.records(), `seed ${String(seed)}: no halt`).toEqual([]);
}

describe("CAP-1 property — over random fills, partial fills, cancels, onFill and onOrderUpdate placements, carried and ordinary harvests and restarts, the cap check counts every committed pUSD exactly once, at every evaluation; and (r0) risk checks 16 and 17 count at least the venue's floor at every risk evaluation", () => {
  it("holds for 60 seeds at the PAPER cadence and 30 at the per-frame cadence, and every listed path occurs", async () => {
    const coverage: Coverage = {
      evaluationsChecked: 0,
      capChecks: 0,
      admissions: 0,
      capRefusals: 0,
      partialFills: 0,
      cancelledAfterPartial: 0,
      onFillPlacements: 0,
      onOrderUpdatePlacements: 0,
      carriedHarvestFills: 0,
      ordinaryHarvestFills: 0,
      unbookedFillsAtEvaluation: 0,
      restarts: 0,
      riskEvaluationsChecked: 0,
      riskEvaluationsWithUnbooked: 0,
      scenarioOutcomesChecked: 0,
      worstCaseRefusals: 0,
      riskAdmissions: 0,
    };
    for (let seed = 1; seed <= 60; seed += 1) await propertyRun(seed, PAPER_EVALUATION_CADENCE, 40, coverage);
    for (let seed = 1_001; seed <= 1_030; seed += 1) await propertyRun(seed, PER_FRAME, 40, coverage);
    // Non-vacuity: every path the packet lists occurred, and the cap bound.
    for (const [path, count] of Object.entries(coverage)) expect(count, path).toBeGreaterThan(0);
  }, 300_000);
});
