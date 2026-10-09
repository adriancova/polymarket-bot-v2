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
 *
 * `CAP-1` r1 — THE JOINT REVIEW OF `651d258`. Three over-counts a booked
 * control did not make, each now pinned against its booked control:
 *
 * 7. an order the venue ENDED at once, not yet settled, kept its whole
 *    reservation in the cap check (`CAP1-ASTRA-R1-01`), and its unbooked fills
 *    were priced at its limit for check 16 (`CAP1-ASTRA-R1-03`);
 * 8. a partly filled WORKING order was presented whole in risk's open orders
 *    while its booked fills were also a position (`CAP1-ASTRA-R1-02`);
 * 9. the property's oracles are now EXACT, keyed on the venue's own state:
 *    the cap check counts a terminal order at exactly its fills' debits, and
 *    checks 16 and 17 count exactly the venue's floor. Round 0 keyed `exact`
 *    on the loop's own release marker and held risk only to a lower bound,
 *    which hid all three;
 * 10. a DELAYED disposition whose fill a trade's ANSWER carries is priced at
 *     that fill. One that `observe()` applies is the single stated residual
 *     (`observe()`'s answer carries no fills): it is held at the limit, never
 *     below its debit.
 *
 * The property yields to the macrotask queue after every seed
 * (`CAP1-R1-GATE-1`).
 *
 * `CAP-1` r2 — THE JOINT REVIEW OF `0c75a17` (`CAP1-ASTRA-R2-01`):
 *
 * 11. a DELAYED fill on a fill page the loop has ALREADY READ is priced at
 *     its own price. That covers the carried harvest's page, where only the
 *     pass's own fills are booked, and the ordinary harvest's page when a
 *     posting is refused. A tight-cap booked control and the pending account
 *     therefore admit the same intent (terminal and working orders, the
 *     allocator and check 16);
 * 12. the property also runs on a TIER-1 venue with delayed markets. Its
 *     oracle is its own evidence of what each answer and page handed the
 *     loop (`evidenceVenue`). It is exact everywhere except one residual:
 *     `(limit − price) × shares` for each fill nothing has handed the loop
 *     yet. That is the r2 STOPPED residual. It is pinned exactly against its
 *     booked controls and awaits the orchestrator's ruling. In Tier 0 the
 *     residual is asserted to be zero.
 *
 * `ROLLOVER-1` r7 — ONE SERIES-BOUND INSTANCE, TWO WINDOWS (`windows: true`:
 * A and B registered as `trader.ts`'s window attach registers them, under one
 * instance id with distinct registration keys):
 *
 * 13. R7-FABLE-02: the R4-CAP check-16 pin inside one window — the unbooked
 *     fill is asked of the allocator under the INSTANCE id, never the
 *     window's key;
 * 14. R7-FABLE-01: window A's booked position, unbooked fill, working order
 *     and mark all reach window B's checks 16 and 17, each at its exact
 *     boundary; two market-bound instances in the same shape stay apart.
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
import { createRunEvaluationSequence, createStrategyInstanceRuntime, type EvaluationInput } from "@polymarket-bot/strategy-runtime";
import type { Strategy, StrategyContext } from "@polymarket-bot/strategy-sdk";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type * as Accounting from "./accounting.js";
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

/**
 * `CAP-1` r2: the posting seam, a PASS-THROUGH unless a pin sets `refuse`.
 * `postFill` then answers a stage-named refusal for each fill `refuse` names,
 * exactly as a ledger that refused it would, and the loop halts its market
 * `LEDGER_POSTING_REFUSED`. Every other member is the original module's.
 */
const postingSeam = vi.hoisted(() => ({
  refuse: undefined as ((fill: { readonly simulatedFillId: string; readonly marketId: string }) => boolean) | undefined,
}));

vi.mock("./accounting.js", async (importOriginal) => {
  const original = await importOriginal<typeof Accounting>();
  return {
    ...original,
    postFill(input: Parameters<typeof original.postFill>[0]): ReturnType<typeof original.postFill> {
      if (postingSeam.refuse?.(input.fill) === true) {
        return {
          ok: false,
          stage: "APPEND",
          code: "CAP1_TEST_POSTING_REFUSED",
          detail: `cap1 test: the ledger refuses the posting of ${input.fill.simulatedFillId}`,
          issues: [],
        };
      }
      return original.postFill(input);
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
import { CoreLoop, DecisionOutboxBuffer, type TraderVenue } from "./loop.js";
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
  /**
   * A TIER-1 venue on a delayed market (`secondsDelay`, zero latency): how a
   * fill reaches `observe()`. `CAP-1` r2: per market, when a function.
   */
  readonly tier1DelaySeconds?: number | ((marketId: string) => number);
  /** `CAP-1` r0: the §9.8 check-16 and check-17 limits (generous by default). */
  readonly risk?: RiskLimits;
  /** `CAP-1` r0: runs at EVERY risk evaluation, after the engine answered — the property's check-16/17 floor. */
  readonly onRisk?: (harness: Harness, risk: Harness["risks"][number]) => void;
  /** `CAP-1` r1: the venue port the LOOP is handed, wrapping the simulated venue (the harness's own reads stay on it). */
  readonly wrapVenue?: (venue: SimulatedVenue, clock: ManualClock) => TraderVenue;
  /**
   * `ROLLOVER-1` r7: A and B are two WINDOWS of ONE series-bound instance
   * (`INSTANCE_A`, `RUN_A`, one run-scoped evaluation sequence), registered
   * as `trader.ts`'s window attach registers them — each its own runtime and
   * registration key (`<instanceId>|<marketId>`), both under one instance id.
   * Absent: two market-bound instances, as before.
   */
  readonly windows?: boolean;
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
  const windows = options.windows === true;
  // `ROLLOVER-1` r7: one run's windows share ONE evaluation sequence (ruling Q2).
  const sequence = windows ? createRunEvaluationSequence() : undefined;
  for (const [instanceId, runId, marketId, label] of [
    [INSTANCE_A, RUN_A, MARKET_A, "A"],
    windows ? ([INSTANCE_A, RUN_A, MARKET_B, "B"] as const) : ([INSTANCE_B, RUN_B, MARKET_B, "B"] as const),
  ] as const) {
    const created = createStrategyInstanceRuntime({
      ...(sequence === undefined ? {} : { sequence }),
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
      ...(windows ? { window: true } : {}),
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
            secondsDelay: typeof delay === "function" ? delay(marketId) : delay,
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
    venue: options.wrapVenue?.(venue, clock) ?? venue,
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
      // By MARKET: A's market is MARKET_A in both shapes (`ROLLOVER-1` r7:
      // two windows share one instance id).
      label: (built.marketConfig.marketId === MARKET_A ? "A" : "B") as Label,
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
 *   remainder released — each WORKING order at its whole reservation `limit ×
 *   shares` (WP-270 decision 5: the unused part goes only once the final size
 *   is confirmed); each order the venue shows TERMINAL at exactly its fills'
 *   debits, booked or not.
 *
 * `CAP-1` r1 (`CAP1-ASTRA-R1-01`): `exact` is keyed on the VENUE's state
 * alone. Round 0 keyed it on the loop's own time-in-force marker, so an order
 * the venue had ended but the loop had not yet settled was "exactly" its
 * whole reservation, and the delayed release passed the oracle.
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
      TERMINAL.has(order.state) ? debit : mulDecimal(order.limitPrice, order.requestedShares),
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
 * read through the gate's own `countedExposure` — exactly the account a
 * placement evaluated now would be judged against (§9.8 check 14). Until
 * C1-RISK this asked `evaluate` with a CANCEL and read the snapshot it carried.
 */
function counted(harness: Harness): { readonly A: string; readonly B: string; readonly global: string } {
  const outcome = AllocatorGate.prototype.countedExposure.call(harness.gate, {
    liveOwners: OWNERS,
    projection: harness.loop.ledgerView(),
    // The read only: collateral moves no exposure entry. The real questions
    // (`evaluate` and `applyForPlan` in the loop) carry the real balance.
    availableCollateral: "1000000",
    // `CAP-1` r1: the venue's own view of each order, as the loop's questions read it.
    viewOf: (plannedOrderId) => venueViewOf(harness, plannedOrderId),
  });
  if (outcome === undefined) throw new Error("the cap check's account could not be built");
  return {
    A: combinedOf(outcome.byStrategyInstance, INSTANCE_A),
    B: combinedOf(outcome.byStrategyInstance, INSTANCE_B),
    global: outcome.global.combined,
  };
}

/**
 * What the cap check counted for one instance at the `evaluate` it just
 * answered: the gate's `countedExposure` over the same inputs (`evaluate`
 * changes nothing, so the account is the one it judged).
 */
function countedAt(gate: Harness["gate"], input: Parameters<AllocatorGate["evaluate"]>[0], instanceId: string): string {
  const snapshot = gate.countedExposure(input);
  if (snapshot === undefined) return "unbuildable";
  return combinedOf(snapshot.byStrategyInstance, instanceId);
}

/** `CAP-1` r1: one planned order as the VENUE shows it now (its state and filled size), read without the loop. */
function venueViewOf(harness: Harness, plannedOrderId: string): { readonly terminal: boolean; readonly filledShares: string } | undefined {
  const order = harness.venue.orderByPlannedId(plannedOrderId);
  return order === undefined ? undefined : { terminal: TERMINAL.has(order.state), filledShares: order.filledShares };
}

/**
 * Asserts the invariant for both strategies and the account: `floor ≤ counted
 * = exact`.
 *
 * `unseen` (`CAP-1` r1) names, per strategy, the ONE stated residual: a fill
 * no venue answer the loop received has carried yet. That is a Tier-1
 * DELAYED order's disposition applied inside `observe()`, whose answer
 * carries no fills, until a fill page is read (r2: ANY page the loop reads).
 * Such a share is held at its order's limit, so the cap check counts `exact
 * + (limit − price) × shares`, never less. A test that expects it states that
 * excess exactly; every other caller states none.
 */
function expectInvariant(harness: Harness, where: string, unseen: Partial<Record<Label, string>> = {}): void {
  const now = counted(harness);
  const venue = committed(harness);
  let exactGlobal = "0";
  for (const label of ["A", "B"] as const) {
    const truth = venue[label];
    const expected = addDecimal(truth.exact, unseen[label] ?? "0");
    expect(now[label], `${where}: ${label} counted ≥ its floor ${truth.floor}`).toSatisfy(
      (value: string) => compareDecimal(value, truth.floor) >= 0,
    );
    expect(now[label], `${where}: ${label} counted exactly (no double count, the exact remainder released)`).toBe(expected);
    exactGlobal = addDecimal(exactGlobal, expected);
  }
  expect(now.global, `${where}: the account`).toBe(exactGlobal);
}

/**
 * `CAP-1` r2 — the property's INDEPENDENT oracle of what the loop can price
 * exactly: every venue fill the LOOP has been handed, recorded by a
 * pass-through wrapper on the port it drives ({@link evidenceVenue}), never
 * read from the allocator.
 */
interface Evidence {
  /** Fill ids a venue ANSWER the loop received carried: a placement's (`submit`) or a trade's (`observeTrade`). */
  readonly answered: Set<string>;
  /** Fill ids a fill PAGE the loop read (`fillsSince`) carried. */
  readonly paged: Set<string>;
  /** Fill id -> the batch (`feed` call) during which the venue produced it. */
  readonly producedIn: Map<string, number>;
  /** The batch being fed now. */
  batch: number;
}

function newEvidence(): Evidence {
  return { answered: new Set(), paged: new Set(), producedIn: new Map(), batch: 0 };
}

/** Whether the loop has been handed `fillId`, in an answer or on a page it read. */
function handed(evidence: Evidence, fillId: string): boolean {
  return evidence.answered.has(fillId) || evidence.paged.has(fillId);
}

/**
 * `CAP-1` r2: the venue port the loop is handed, as a PASS-THROUGH that
 * records `evidence` — what each answer and each page carried, and the batch
 * each fill was produced in. It changes nothing the loop reads.
 */
function evidenceVenue(evidence: Evidence): (inner: SimulatedVenue) => TraderVenue {
  return (inner) => {
    const stamp = (): void => {
      for (const fill of inner.fills) {
        if (!evidence.producedIn.has(fill.simulatedFillId)) evidence.producedIn.set(fill.simulatedFillId, evidence.batch);
      }
    };
    return {
      observe: (identity) => {
        const answer = inner.observe(identity);
        stamp();
        return answer;
      },
      observeTrade: (input) => {
        const answer = inner.observeTrade(input);
        stamp();
        if (answer.ok) for (const fill of answer.value.fills) evidence.answered.add(fill.simulatedFillId);
        return answer;
      },
      submit: async (plan) => {
        const answer = await inner.submit(plan as Parameters<SimulatedVenue["submit"]>[0]);
        stamp();
        for (const fill of answer.fills) evidence.answered.add(fill.simulatedFillId);
        return answer;
      },
      fillsSince: (sequence) => {
        const page = inner.fillsSince(sequence);
        if (page.ok) for (const fill of page.value.fills) evidence.paged.add(fill.simulatedFillId);
        return page;
      },
      orderById: (venueOrderId) => inner.orderById(venueOrderId),
      orderByPlannedId: (plannedOrderId) => inner.orderByPlannedId(plannedOrderId),
      acknowledgeTerminal: (venueOrderId) => inner.acknowledgeTerminal(venueOrderId),
    };
  };
}

/**
 * `CAP-1` r2: per strategy, the EXCESS the cap check must count over the
 * venue's exact commitment — `(limit − price) × shares` for each BUY fill the
 * loop has NOT been handed, which nothing lets it price below its order's
 * limit — and the fills that make it up. `terminalOnly`: of TERMINAL orders
 * only (the allocator, which counts a working order at its whole
 * reservation); otherwise of every order (checks 16 and 17, which state a
 * working order's filled shares beside its unfilled remainder).
 */
function unhandedExcess(
  harness: Harness,
  evidence: Evidence,
  terminalOnly: boolean,
): { readonly excess: Readonly<Record<Label, string>>; readonly fills: readonly string[] } {
  const excess = { A: "0", B: "0" };
  const fills: string[] = [];
  const orders = new Map(harness.venue.ordersSnapshot().map((order) => [order.simulatedOrderId, order]));
  for (const fill of harness.venue.fills) {
    if (fill.action !== "BUY" || handed(evidence, fill.simulatedFillId)) continue;
    const order = orders.get(fill.simulatedOrderId);
    expect(order, `the venue's order for fill ${fill.simulatedFillId}`).toBeDefined();
    if (order === undefined || (terminalOnly && !TERMINAL.has(order.state))) continue;
    const label: Label = fill.marketId === MARKET_A ? "A" : "B";
    excess[label] = addDecimal(excess[label], mulDecimal(subDecimal(order.limitPrice, fill.price), fill.shares));
    fills.push(fill.simulatedFillId);
  }
  return { excess, fills };
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
      if (input.instanceId === INSTANCE_B) judged.push(countedAt(harness.gate, input, INSTANCE_B));
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

  it("r1 — SIM-2's cursor budget on the same paths: at most ONE fillsSince read per event (651d258 read the venue's fill page a SECOND time to settle the onFill order filled at once)", async () => {
    for (const variant of ["carried", "ordinary"] as const) {
      ordinal = 0;
      const harness = assemble({
        cadence: PAPER_EVALUATION_CADENCE,
        perStrategyCap: CAP,
        script: scheduled({ B: { onFeatures: [[FIRST, BUY10], [iso(S + 10_000), BUY10]], onFill: [[FIRST, BUY10]] } }),
      });
      const cursor = vi.spyOn(harness.venue, "fillsSince");
      const reads: number[] = [];
      for (const ingested of [
        ...opening(),
        opened(S + 150, MARKET_B),
        snapshot(S + 5_000, variant === "ordinary" ? MARKET_A : MARKET_X, "yes"),
        snapshot(S + 10_000, MARKET_X, "yes"),
      ]) {
        const before = cursor.mock.calls.length;
        await feed(harness, ingested);
        reads.push(cursor.mock.calls.length - before);
      }
      // The onFill order filled at once was SETTLED at its view (its fill seen
      // in the placement answer) without reading the page again.
      expect(Math.max(...reads), `${variant}: fillsSince reads per event ${JSON.stringify(reads)}`).toBeLessThanOrEqual(1);
      expect(outcomeOf(harness)).toMatchObject({ accepted: 2, allocator: { CAPITAL_STRATEGY_CAP_EXCEEDED: 1 } });
      expect(harness.halts.records()).toEqual([]);
    }
  });

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
  it("an UNSETTLED terminal order (an onOrderUpdate FAK, partly filled and cancelled at once, outside its harvest's view boundary): checks 16 and 17 count exactly its FILLED unbooked shares — r1: at the 0.34 its placement answer carried, no longer at its 0.35 limit (CAP1-ASTRA-R1-03) — and a RESTING order only through openOrders", async () => {
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
    // Exactly the 5 FILLED shares, at their own 0.34 (the placement answer
    // carried it; round 0 stated the 0.35 limit, 1.75) — not the 5 cancelled
    // ones, and not the resting order, which openOrders presents whole.
    expect(third?.document.unbookedFills).toEqual([{ marketId: MARKET_B, side: "YES", shares: "5", debit: "1.7" }]);
    expect(third?.document.portfolio.openOrders.map((open) => open.orderId)).toHaveLength(1);
    // Check 16: 3.00 resting + 1.70 unbooked + 3.50 this BUY (round 0: 8.25).
    expect(third?.evaluation.worstCase?.maximumContractualLoss).toBe("8.2");
    expect(harness.halts.records()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 1c. Round 1's named regressions (the joint review of 651d258)
// ---------------------------------------------------------------------------

describe("CAP-1 r1 regression (CAP1-ASTRA-R1-01, -03) — an order the venue ENDED at once (an onOrderUpdate FAK: 5 filled at 0.34, 5 cancelled), not yet booked or settled: the cap check and check 16 judge it at its final size and its fills' own prices, exactly as the booked control does", () => {
  /**
   * B rests a maker BUY of 10 at 0.30 (3.00). Its RESTING view places a FAK of
   * 10 at ≤ 0.35 against 5 shares at 0.34: 5 fill (1.70) and 5 are cancelled
   * at once — CANCELLED 5/10, outside its harvest's view boundary, so no loop
   * site settles it before the next harvest. A heartbeat at an event for no
   * configured market then asks for another FAK BUY of 10 at ≤ 0.35 (3.50).
   *
   * The booked control books the fill first (B's own event at S + 9 500).
   *
   * At `651d258` the PENDING run counted the FAK's whole 3.50 reservation
   * (6.50 + 3.50 = 10 > 8.30: refused CAPITAL_STRATEGY_CAP_EXCEEDED) and
   * priced its 5 filled shares at the 0.35 limit for check 16 (3.00 + 1.75 +
   * 3.50 = 8.25 > 8.22: refused RISK_WORST_CASE_LOSS_EXCEEDED). The booked
   * control admitted both: 4.70 and 8.20.
   */
  async function run(booked: boolean, limits: "allocator" | "risk"): Promise<{ readonly harness: Harness; readonly judged: string[] }> {
    ordinal = 0;
    const judged: string[] = [];
    const harness = assemble({
      cadence: PAPER_EVALUATION_CADENCE,
      perStrategyCap: limits === "allocator" ? "8.3" : "1000",
      risk: { maxWorstCaseContractualLoss: limits === "risk" ? "8.22" : "1000" },
      script: scheduled({
        B: {
          onFeatures: [
            [iso(S + 5_000), { kind: "BUY", shares: "10", style: "MAKER" }],
            [iso(S + 15_000), { kind: "BUY", shares: "10", style: "FAK" }],
          ],
          onOrderUpdate: [[iso(S + 5_000), { kind: "BUY", shares: "10", style: "FAK" }]],
        },
      }),
    });
    const original = harness.gate.evaluate.bind(harness.gate);
    vi.spyOn(harness.gate, "evaluate").mockImplementation((input) => {
      const outcome = original(input);
      if (input.instanceId === INSTANCE_B) judged.push(countedAt(harness.gate, input, INSTANCE_B));
      return outcome;
    });
    await feed(harness, ...opening(), opened(S + 150, MARKET_B), askLevel(S + 200, MARKET_B, "0.4", "500"), askLevel(S + 210, MARKET_B, "0.34", "5"));
    await feed(harness, level(S + 5_000, MARKET_B, "0.31"));
    expect(outcomeOf(harness).orders).toEqual(["BUY RESTING 0/10", "BUY CANCELLED 5/10"]);
    expect(harness.loop.health().execution.fillsObserved).toBe(0);
    if (booked) {
      await feed(harness, level(S + 9_500, MARKET_B, "0.31"));
      expect(harness.loop.health().execution.fillsObserved).toBe(1);
    }
    // At the heartbeat, before the third BUY is judged: 3.00 + 1.70, and the
    // FAK's 1.80 unused remainder released, on BOTH runs.
    expect(counted(harness).B).toBe("4.7");
    expectInvariant(harness, `${booked ? "booked" : "pending"} run, before the heartbeat`);
    await feed(harness, snapshot(S + 15_000, MARKET_X, "yes"));
    expect(harness.halts.records()).toEqual([]);
    return { harness, judged };
  }

  it("the allocator (per-strategy cap 8.30): the third BUY is ADMITTED at 4.70 + 3.50 = 8.20, exactly as the booked control admits it (651d258: 6.50 counted, refused)", async () => {
    const pending = await run(false, "allocator");
    const control = await run(true, "allocator");
    expect(outcomeOf(pending.harness)).toMatchObject({ accepted: 3, risk: {}, allocator: {} });
    expect(outcomeOf(control.harness)).toMatchObject({ accepted: 3, risk: {}, allocator: {} });
    // B's cap checks: nothing; the resting 3.00; then the third BUY's.
    expect(pending.judged).toEqual(["0", "3", "4.7"]);
    expect(control.judged.at(-1)).toBe("4.7");
  });

  it("check 16 (maxWorstCaseContractualLoss 8.22): the third BUY is ADMITTED at 3.00 + 1.70 + 3.50 = 8.20, exactly as the booked control admits it (651d258: 1.75 stated at the limit, 8.25, refused)", async () => {
    const pending = await run(false, "risk");
    const control = await run(true, "risk");
    expect(outcomeOf(pending.harness)).toMatchObject({ accepted: 3, risk: {}, allocator: {} });
    expect(outcomeOf(control.harness)).toMatchObject({ accepted: 3, risk: {}, allocator: {} });
    expect(checkSixteen(pending.harness, "B").at(-1)).toBe("8.2");
    expect(checkSixteen(control.harness, "B").at(-1)).toBe("8.2");
    // The pending run states the unbooked fill at its own 0.34; the control's is a position.
    expect(unbookedInputs(pending.harness, "B").at(-1)).toEqual([{ marketId: MARKET_B, side: "YES", shares: "5", debit: "1.7" }]);
    expect(unbookedInputs(control.harness, "B").at(-1)).toEqual([]);
  });
});

describe("CAP-1 r1 regression (CAP1-ASTRA-R1-02) — a PARTLY FILLED working order: risk's open orders present only its UNFILLED remainder, so no share is counted in the position (or the unbooked input) AND in the order", () => {
  it("BOOKED partial fill: a GTC BUY of 10 at ≤ 0.35 fills 5 at 0.34 and rests 5; at check 16's limit of 5, a maker BUY of 5 at 0.30 is ADMITTED at 1.70 + 1.75 + 1.50 = 4.95 (651d258: 1.70 + 3.50 + 1.50 = 6.70, refused)", async () => {
    ordinal = 0;
    const harness = assemble({
      cadence: PAPER_EVALUATION_CADENCE,
      perStrategyCap: "1000",
      risk: { maxWorstCaseContractualLoss: "5" },
      script: scheduled({
        B: {
          onFeatures: [
            [iso(S + 5_000), { kind: "BUY", shares: "10", style: "GTC" }],
            [iso(S + 6_100), { kind: "BUY", shares: "5", style: "MAKER" }],
          ],
        },
      }),
    });
    await feed(harness, ...opening(), opened(S + 150, MARKET_B), askLevel(S + 200, MARKET_B, "0.4", "500"), askLevel(S + 210, MARKET_B, "0.34", "5"));
    await feed(harness, level(S + 5_000, MARKET_B, "0.31"));
    expect(outcomeOf(harness).orders).toEqual(["BUY PARTIALLY_FILLED 5/10"]);
    expect(harness.loop.health().execution.fillsObserved).toBe(1);
    await feed(harness, level(S + 6_100, MARKET_B, "0.31"));
    expect(outcomeOf(harness)).toMatchObject({ accepted: 2, risk: {}, allocator: {} });
    const second = harness.risks.filter((risk) => risk.label === "B").at(-1);
    expect(second?.document.portfolio.positions.map((position) => position.shares)).toEqual(["5"]);
    // The working order at its 5 UNFILLED shares; nothing unbooked.
    expect(second?.context.openOrders.map((open) => open.shares)).toEqual(["5"]);
    expect(second?.document.unbookedFills).toEqual([]);
    expect(second?.evaluation.worstCase?.maximumContractualLoss).toBe("4.95");
    expect(harness.halts.records()).toEqual([]);
  });

  /**
   * B rests a maker BUY of 10 at 0.30 (3.00). Its RESTING view places a GTC
   * BUY of 10 at ≤ 0.35 against 5 shares at 0.34: PARTIALLY FILLED 5/10 at
   * once, 5 resting at 0.35, its fill unread until the next harvest. A
   * heartbeat then asks for a maker BUY of 5 at 0.30 (1.50). Check 16's limit
   * is 7.97. The booked control books the fill first.
   *
   * Pending and control both measure 3.00 + 1.70 (the 5 filled shares: unbooked
   * at their own price, or booked) + 1.75 (the 5 unfilled) + 1.50 = 7.95.
   * At `651d258` the pending run measured 3.00 + 3.50 (the order presented
   * whole) + 1.50 = 8.00, refused; its control 9.70 (position AND whole order).
   */
  async function workingPartial(booked: boolean): Promise<Harness> {
    ordinal = 0;
    const harness = assemble({
      cadence: PAPER_EVALUATION_CADENCE,
      perStrategyCap: "1000",
      risk: { maxWorstCaseContractualLoss: "7.97" },
      script: scheduled({
        B: {
          onFeatures: [
            [iso(S + 5_000), { kind: "BUY", shares: "10", style: "MAKER" }],
            [iso(S + 15_000), { kind: "BUY", shares: "5", style: "MAKER" }],
          ],
          onOrderUpdate: [[iso(S + 5_000), { kind: "BUY", shares: "10", style: "GTC" }]],
        },
      }),
    });
    await feed(harness, ...opening(), opened(S + 150, MARKET_B), askLevel(S + 200, MARKET_B, "0.4", "500"), askLevel(S + 210, MARKET_B, "0.34", "5"));
    await feed(harness, level(S + 5_000, MARKET_B, "0.31"));
    expect(outcomeOf(harness).orders).toEqual(["BUY RESTING 0/10", "BUY PARTIALLY_FILLED 5/10"]);
    expect(harness.loop.health().execution.fillsObserved).toBe(0);
    if (booked) {
      await feed(harness, level(S + 9_500, MARKET_B, "0.31"));
      expect(harness.loop.health().execution.fillsObserved).toBe(1);
    }
    expectInvariant(harness, `${booked ? "booked" : "pending"} working partial, before the heartbeat`);
    await feed(harness, snapshot(S + 15_000, MARKET_X, "yes"));
    expect(harness.halts.records()).toEqual([]);
    return harness;
  }

  it("UNBOOKED partial fill of a working order (an onOrderUpdate GTC): its 5 filled shares are stated at their own 0.34 and its 5 unfilled ones presented as the open order — 7.95, ADMITTED at 7.97, exactly as the booked control (651d258: 8.00, refused)", async () => {
    const pending = await workingPartial(false);
    const control = await workingPartial(true);
    for (const harness of [pending, control]) {
      expect(outcomeOf(harness)).toMatchObject({ accepted: 3, risk: {}, allocator: {} });
      expect(checkSixteen(harness, "B").at(-1)).toBe("7.95");
      const last = harness.risks.filter((risk) => risk.label === "B").at(-1);
      // The resting maker whole (10 unfilled) and the GTC at its 5 unfilled.
      expect(last?.context.openOrders.map((open) => open.shares)).toEqual(["10", "5"]);
    }
    expect(unbookedInputs(pending, "B").at(-1)).toEqual([{ marketId: MARKET_B, side: "YES", shares: "5", debit: "1.7" }]);
    expect(unbookedInputs(control, "B").at(-1)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 1d. Round 2's named regressions (the joint review of 0c75a17)
// ---------------------------------------------------------------------------

/** `CAP-1` r2: the three arms of `CAP1-ASTRA-R2-01`, each judged at a limit between the pending and the over-counted measure. */
type DelayedArm = "terminal allocator" | "terminal risk" | "working risk";

/**
 * `CAP-1` r2 — one run of `CAP1-ASTRA-R2-01`'s shape, on a 5 s DELAYED
 * market (Tier 1):
 *
 * - B places a taker BUY of 10 at ≤ 0.35 at S + 5 000: a FAK (the terminal
 *   arms), or a GTC against 5 shares at 0.34 (the working arm). It is DELAYED;
 * - at S + 11 000, an event for market X (which this trader does not run):
 *   `observe()` applies the disposition — FILLED 10/10 at 0.34, or PARTIALLY
 *   FILLED 5/10 with 5 resting at 0.35. `observe()`'s answer carries no fill;
 * - `pageRead`: A's heartbeat at that same close places a maker BUY of 5, so
 *   the CARRIED harvest reads the venue's fill page, which carries B's fill
 *   (not the pass's own: it is left to its ADR-024 harvest point);
 * - `booked`: the booked control. B's own event at S + 11 100 books the fill;
 * - at S + 17 000, another event for X: B's heartbeat asks for a FAK BUY of 10
 *   (the terminal arms) or a maker BUY of 5 at 0.30 (the working arm).
 *
 * The limits sit 0.05 pUSD above the booked control's measure and below the
 * measure that prices B's filled shares at their 0.35 limit.
 */
async function delayedRun(
  arm: DelayedArm,
  options: { readonly pageRead: boolean; readonly booked: boolean },
): Promise<{ readonly harness: Harness; readonly before: ReturnType<typeof counted>; readonly reads: readonly number[]; readonly pages: readonly (readonly string[])[] }> {
  ordinal = 0;
  const working = arm === "working risk";
  const harness = assemble({
    cadence: PAPER_EVALUATION_CADENCE,
    perStrategyCap: arm === "terminal allocator" ? "6.95" : "1000",
    risk: { maxWorstCaseContractualLoss: arm === "terminal risk" ? "6.95" : working ? "4.97" : "1000" },
    tier1DelaySeconds: 5,
    script: scheduled({
      A: options.pageRead ? { onFeatures: [[iso(S + 11_000), { kind: "BUY", shares: "5", style: "MAKER" }]] } : {},
      B: {
        onFeatures: [
          [iso(S + 5_000), { kind: "BUY", shares: "10", style: working ? "GTC" : "FAK" }],
          [iso(S + 17_000), working ? { kind: "BUY", shares: "5", style: "MAKER" } : { kind: "BUY", shares: "10", style: "FAK" }],
        ],
      },
    }),
  });
  await feed(harness, ...opening(), opened(S + 140, MARKET_A), opened(S + 150, MARKET_B));
  if (working) await feed(harness, askLevel(S + 210, MARKET_B, "0.34", "5"));
  await feed(harness, level(S + 5_000, MARKET_B, "0.31"));
  expect(outcomeOf(harness).orders).toEqual(["BUY DELAYED 0/10"]);
  // Every fill page the loop reads from here on, per event (SIM-2's budget).
  const cursor = vi.spyOn(harness.venue, "fillsSince");
  const reads: number[] = [];
  const at = async (ingested: IngestedEvent): Promise<void> => {
    const before = cursor.mock.calls.length;
    await feed(harness, ingested);
    reads.push(cursor.mock.calls.length - before);
  };
  harness.clock.positionAt(iso(S + 11_000), 6_000_000_000n);
  await at(snapshot(S + 11_000, MARKET_X, "yes"));
  expect(outcomeOf(harness).orders[0]).toBe(working ? "BUY PARTIALLY_FILLED 5/10" : "BUY FILLED 10/10");
  // No harvest point at X: nothing booked.
  expect(harness.loop.health().execution.fillsObserved).toBe(0);
  if (options.booked) {
    await at(level(S + 11_100, MARKET_B, "0.31"));
    expect(harness.loop.health().execution.fillsObserved).toBe(1);
  }
  const before = counted(harness);
  await at(snapshot(S + 17_000, MARKET_X, "yes"));
  const pages = cursor.mock.results.map((result) => {
    const page = result.value as ReturnType<SimulatedVenue["fillsSince"]>;
    return page.ok ? page.value.fills.map((fill) => `${fill.shares}@${fill.price}`) : ["REFUSED"];
  });
  expect(harness.halts.records()).toEqual([]);
  return { harness, before, reads, pages };
}

describe("CAP-1 r2 regression (CAP1-ASTRA-R2-01) — a DELAYED fill on a page the carried harvest ALREADY READ is judged at its own price: the cap check and check 16 admit exactly what the booked control admits (0c75a17 discarded the page's other fills and held them at their limit)", () => {
  it("terminal, the allocator (per-strategy cap 6.95): B's third BUY is ADMITTED at 3.40 + 3.50 = 6.90, exactly as the booked control admits it (0c75a17: 3.50 counted, 7.00, refused CAPITAL_STRATEGY_CAP_EXCEEDED)", async () => {
    const pending = await delayedRun("terminal allocator", { pageRead: true, booked: false });
    const control = await delayedRun("terminal allocator", { pageRead: true, booked: true });
    // The carried harvest at S + 11 000 read ONE page, and it carried B's fill; no read was added.
    expect(pending.reads).toEqual([1, 1]);
    expect(pending.pages[0]).toEqual(["10@0.34"]);
    for (const run of [pending, control]) {
      expect(outcomeOf(run.harness)).toMatchObject({ accepted: 3, risk: {}, allocator: {} });
      expect(run.before).toEqual({ A: "1.5", B: "3.4", global: "4.9" });
    }
    expect(control.reads).toEqual([1, 1, 1]);
  });

  it("terminal, check 16 (maxWorstCaseContractualLoss 6.95): ADMITTED at 3.40 + 3.50 = 6.90, its unbooked fill stated at its own 0.34, exactly as the booked control (0c75a17: 3.50 stated, 7.00, refused)", async () => {
    const pending = await delayedRun("terminal risk", { pageRead: true, booked: false });
    const control = await delayedRun("terminal risk", { pageRead: true, booked: true });
    for (const run of [pending, control]) {
      expect(outcomeOf(run.harness)).toMatchObject({ accepted: 3, risk: {}, allocator: {} });
      expect(checkSixteen(run.harness, "B").at(-1)).toBe("6.9");
    }
    expect(unbookedInputs(pending.harness, "B").at(-1)).toEqual([{ marketId: MARKET_B, side: "YES", shares: "10", debit: "3.4" }]);
    expect(unbookedInputs(control.harness, "B").at(-1)).toEqual([]);
    expect(pending.reads).toEqual([1, 1]);
  });

  it("WORKING, check 16 (maxWorstCaseContractualLoss 4.97): a maker BUY of 5 is ADMITTED at 1.70 + 1.75 + 1.50 = 4.95, its 5 filled shares stated at 0.34 and its 5 unfilled ones in the open order, exactly as the booked control (0c75a17: 1.75 + 1.75 + 1.50 = 5.00, refused)", async () => {
    const pending = await delayedRun("working risk", { pageRead: true, booked: false });
    const control = await delayedRun("working risk", { pageRead: true, booked: true });
    expect(pending.pages[0]).toEqual(["5@0.34"]);
    for (const run of [pending, control]) {
      expect(outcomeOf(run.harness)).toMatchObject({ accepted: 3, risk: {}, allocator: {} });
      expect(checkSixteen(run.harness, "B").at(-1)).toBe("4.95");
      const last = run.harness.risks.filter((risk) => risk.label === "B").at(-1);
      expect(last?.context.openOrders.map((open) => open.shares)).toEqual(["5"]);
      // While it works, the allocator counts its whole reservation (WP-270 decision 5).
      expect(run.before.B).toBe("3.5");
    }
    expect(unbookedInputs(pending.harness, "B").at(-1)).toEqual([{ marketId: MARKET_B, side: "YES", shares: "5", debit: "1.7" }]);
    expect(unbookedInputs(control.harness, "B").at(-1)).toEqual([]);
  });

  it("the cap check is EXACT at the pending heartbeat: B's FILLED order at its 3.40 debit, no residual (0c75a17: 0.10 over)", async () => {
    const pending = await delayedRun("terminal allocator", { pageRead: true, booked: false });
    // After the third BUY: B holds the FILLED order (3.40, read on the page, unbooked) and the third (DELAYED, 3.50).
    expectInvariant(pending.harness, "after B's third BUY, the first fill read on the carried harvest's page");
    expect(counted(pending.harness).B).toBe("6.9");
  });
});

describe("CAP-1 r2 regression (CAP1-ASTRA-R2-01, the ordinary page): a fill the ordinary harvest READ but could not book (its posting REFUSED) is counted at its own price, the venue's exact debit, as the booked control counts it (0c75a17: held at its limit)", () => {
  /**
   * B's DELAYED FAK BUY of 10 at ≤ 0.35 fills 10 at 0.34 inside `observe()`
   * at B's own event at S + 11 000, and that event's ORDINARY harvest reads
   * the page. With `refused`, the ledger refuses the posting: the loop halts
   * `LEDGER_POSTING_REFUSED` (a FULL_HALT), the fill is never booked, and its
   * commitment keeps its capital — at 3.40, the price the page carried. At
   * `0c75a17` the page was not evidence, and the account counted 3.50.
   *
   * The halt blocks every ENTRY by the run state (§9.8 check 1), so no
   * decision turns on the difference here: the measure itself is what is
   * pinned — the §9.8 check-15 snapshot and the allocator's account — and the
   * entry A asks for after it is refused by the run state, by nothing else.
   * The booked control is the same run with the posting allowed.
   */
  async function run(refused: boolean): Promise<{ readonly harness: Harness; readonly before: ReturnType<typeof counted> }> {
    ordinal = 0;
    const harness = assemble({
      cadence: PAPER_EVALUATION_CADENCE,
      perStrategyCap: "1000",
      tier1DelaySeconds: 5,
      script: scheduled({
        A: { onFeatures: [[iso(S + 12_000), { kind: "BUY", shares: "10", style: "FAK" }]] },
        B: { onFeatures: [[iso(S + 5_000), { kind: "BUY", shares: "10", style: "FAK" }]] },
      }),
    });
    postingSeam.refuse = refused ? (fill) => fill.marketId === MARKET_B : undefined;
    try {
      await feed(harness, ...opening(), opened(S + 140, MARKET_A), opened(S + 150, MARKET_B));
      await feed(harness, level(S + 5_000, MARKET_B, "0.31"));
      expect(outcomeOf(harness).orders).toEqual(["BUY DELAYED 0/10"]);
      harness.clock.positionAt(iso(S + 11_000), 6_000_000_000n);
      await feed(harness, level(S + 11_000, MARKET_B, "0.31"));
      expect(outcomeOf(harness).orders).toEqual(["BUY FILLED 10/10"]);
      expect(harness.loop.health().execution.fillsObserved).toBe(1);
      const before = counted(harness);
      expectInvariant(harness, `${refused ? "refused" : "booked"} run, before A's BUY`);
      await feed(harness, level(S + 12_000, MARKET_A, "0.31"));
      return { harness, before };
    } finally {
      postingSeam.refuse = undefined;
    }
  }

  it("the refused posting: the account counts B at 3.40, exactly as the booked control, and A's entry is refused by the run state alone", async () => {
    const pending = await run(true);
    const control = await run(false);
    expect(pending.harness.loop.health().halts.map((halt) => [halt.scope.kind, halt.code, halt.action])).toEqual([
      ["MARKET", "LEDGER_POSTING_REFUSED", "FULL_HALT"],
    ]);
    expect(control.harness.halts.records()).toEqual([]);
    for (const current of [pending, control]) expect(current.before).toEqual({ A: "0", B: "3.4", global: "3.4" });
    expect(outcomeOf(pending.harness)).toMatchObject({ accepted: 1, risk: { RISK_RUN_STATE_BLOCKS: 1 }, allocator: {} });
    expect(outcomeOf(control.harness)).toMatchObject({ accepted: 2, risk: {}, allocator: {} });
    // The refused fill stays in B's commitment (its posting is not retried), at its own price.
    expect(counted(pending.harness)).toEqual({ A: "0", B: "3.4", global: "3.4" });
    expectInvariant(pending.harness, "after A's refused entry");
  });
});

describe("CAP-1 r2 STOPPED residual (CAP1-ASTRA-R2-01 (ii)) — a DELAYED fill that NO page or answer the loop received has carried yet: held at its order's limit, exactly (limit − price) × shares above the booked control, and nothing else (awaiting the orchestrator's ruling; these pins state the residual, they do not endorse it)", () => {
  it("terminal, the allocator: no page is read between observe()'s fill and the heartbeat, so B counts 3.50 (the booked control 3.40) and the BUY is refused at 6.95 — exactly 10 × (0.35 − 0.34) = 0.10 over, never under", async () => {
    const pending = await delayedRun("terminal allocator", { pageRead: false, booked: false });
    const control = await delayedRun("terminal allocator", { pageRead: false, booked: true });
    // SIM-2: neither event at X reads a page — no pass touches an order of its
    // own (the refused BUY places nothing) — so no fill evidence reaches the
    // loop at all. The control reads one page at B's own event, and one at
    // S + 17 000, after its admitted BUY.
    expect(pending.reads).toEqual([0, 0]);
    expect(control.reads).toEqual([0, 1, 1]);
    expect(pending.before).toEqual({ A: "0", B: "3.5", global: "3.5" });
    expect(control.before).toEqual({ A: "0", B: "3.4", global: "3.4" });
    expect(outcomeOf(pending.harness)).toMatchObject({ accepted: 1, risk: { RISK_ALLOCATION_REFUSED: 1 }, allocator: { CAPITAL_STRATEGY_CAP_EXCEEDED: 1 } });
    expect(outcomeOf(control.harness)).toMatchObject({ accepted: 2, risk: {}, allocator: {} });
    // The residual, stated exactly: the venue's exact 3.40 plus 10 × 0.01.
    expectInvariant(pending.harness, "after the refused heartbeat", { B: "0.1" });
  });

  it("terminal, check 16: 7.00 measured against the booked control's 6.90 (the 10 filled shares stated at the 0.35 limit), refused at 6.95", async () => {
    const pending = await delayedRun("terminal risk", { pageRead: false, booked: false });
    const control = await delayedRun("terminal risk", { pageRead: false, booked: true });
    expect(checkSixteen(pending.harness, "B").at(-1)).toBe("7");
    expect(checkSixteen(control.harness, "B").at(-1)).toBe("6.9");
    expect(unbookedInputs(pending.harness, "B").at(-1)).toEqual([{ marketId: MARKET_B, side: "YES", shares: "10", debit: "3.5" }]);
    expect(outcomeOf(pending.harness)).toMatchObject({ accepted: 1, risk: { RISK_WORST_CASE_LOSS_EXCEEDED: 1 } });
    expect(outcomeOf(control.harness)).toMatchObject({ accepted: 2, risk: {} });
  });

  it("working, check 16: 5.00 measured against the booked control's 4.95 (the 5 filled shares at the limit: 0.05 over), refused at 4.97", async () => {
    const pending = await delayedRun("working risk", { pageRead: false, booked: false });
    const control = await delayedRun("working risk", { pageRead: false, booked: true });
    expect(checkSixteen(pending.harness, "B").at(-1)).toBe("5");
    expect(checkSixteen(control.harness, "B").at(-1)).toBe("4.95");
    expect(unbookedInputs(pending.harness, "B").at(-1)).toEqual([{ marketId: MARKET_B, side: "YES", shares: "5", debit: "1.75" }]);
    expect(outcomeOf(pending.harness)).toMatchObject({ accepted: 1, risk: { RISK_WORST_CASE_LOSS_EXCEEDED: 1 } });
    expect(outcomeOf(control.harness)).toMatchObject({ accepted: 2, risk: {} });
  });
});

// ---------------------------------------------------------------------------
// 2. One pin per path
// ---------------------------------------------------------------------------

describe("CAP-1 paths: each place a commitment could leave the cap check before a position carries it", () => {
  it("THE RELEASE AT FILLED (ordinary harvest): the onFill order's FILLED view releases only its unused remainder; its fill's exact debit is counted until the next harvest point books it, and then the commitment closes", async () => {
    ordinal = 0;
    const first = iso(S + 5_000);
    const atOnFill: ReturnType<AllocatorGate["metrics"]>[] = [];
    const harness = assemble({
      cadence: PAPER_EVALUATION_CADENCE,
      perStrategyCap: "1000",
      script: scheduled({ B: { onFeatures: [[first, { kind: "BUY", shares: "10", style: "FAK" }]], onFill: [[first, { kind: "BUY", shares: "10", style: "FAK" }]] } }),
      beforeEvaluation: (current, input, label) => {
        if (label === "B" && input.callback === "onFill") atOnFill.push(current.gate.metrics());
      },
    });
    await feed(harness, ...opening(), opened(S + 150, MARKET_B));
    await feed(harness, snapshot(S + 5_000, MARKET_A, "yes"));
    // r1: the harvest's release step SETTLED (and, every share booked, CLOSED)
    // the first order BEFORE its onFill ran — the allocator's half of
    // CADENCE-1's A-R3-01 ordering. Since the cap check judges a terminal
    // order at its view anyway, only the gate's own book shows the order.
    expect(atOnFill).toHaveLength(1);
    expect(atOnFill[0]).toMatchObject({ open: 0, applied: 1, released: 1, reservedCollateral: "0" });
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
    // `CAP-1` r0: the partly filled order RESTS, and its fill is booked, so the
    // separate unbooked input states nothing for it. r1 (`CAP1-ASTRA-R1-02`):
    // risk's open orders present it at its 5 UNFILLED shares — its 5 booked
    // ones are the position's (651d258 presented all 10 again).
    expect(harness.risks.at(-1)?.document.portfolio.openOrders).toHaveLength(1);
    expect(harness.risks.at(-1)?.context.openOrders.map((open) => open.shares)).toEqual(["5"]);
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

  it("AN onOrderUpdate PLACEMENT that fills at once: not in its harvest's view boundary, so it is not settled until the next harvest — r1: the cap check judges it at its final size at once (its exact 3.40 debit counted, its 0.10 unused remainder released), and its capital still never leaves the check", async () => {
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
    // 3 (resting maker) + 3.40 (the FAK order: FILLED at the venue, not yet
    // booked or settled — judged at its final size; round 0 counted 3.50).
    expect(counted(harness).B).toBe("6.4");
    expect(harness.loop.health().execution.fillsObserved).toBe(0);
    expectInvariant(harness, "after the onOrderUpdate placement");
    // A heartbeat at an event for no configured market: 6.40 + 3.50 > 8.
    await feed(harness, snapshot(S + 10_000, MARKET_X, "yes"));
    expect(outcomeOf(harness)).toMatchObject({ accepted: 2, allocator: { CAPITAL_STRATEGY_CAP_EXCEEDED: 1 } });
    await feed(harness, level(S + 10_100, MARKET_B, "0.31"));
    expect(counted(harness).B).toBe("6.4");
    expectInvariant(harness, "after the booking");
  });

  it("A FILL APPLIED AT AN UNCONFIGURED MARKET'S observe() (Tier 1, a 5 s delayed market): the DELAYED order's capital stays counted through the heartbeats at that event until the next ordinary harvest books its fill — r1: at its final size, its unseen fill at the limit (the stated residual: observe()'s answer carries no fills)", async () => {
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
    // The fill is unread (no harvest point at X), and its capital stays:
    // 3.50 + 3.50 > 6, so the heartbeat's BUY is refused.
    expect(harness.loop.health().execution.fillsObserved).toBe(0);
    expect(outcomeOf(harness)).toMatchObject({ accepted: 1, allocator: { CAPITAL_STRATEGY_CAP_EXCEEDED: 1 } });
    // r1: the order is FILLED 10/10 at the venue, so it is judged at that
    // final size. No answer the loop received carried the fill (`observe()`
    // answers no fills, and no page is read here: SIM-2), so its 10 shares
    // are held at the 0.35 limit: 3.50, which is 10 × (0.35 − 0.34) = 0.10
    // over the 3.40 debit, never under it. The STATED residual.
    expect(harness.venue.fills.map((fill) => `${fill.shares}@${fill.price}`)).toEqual(["10@0.34"]);
    expect(counted(harness).B).toBe("3.5");
    expectInvariant(harness, "at the heartbeat after observe()'s fill", { B: "0.1" });
    await feed(harness, level(S + 11_100, MARKET_B, "0.31"));
    expect(harness.loop.health().execution.fillsObserved).toBe(1);
    expect(counted(harness).B).toBe(harness.venue.fills.reduce((total, fill) => addDecimal(total, mulDecimal(fill.price, fill.shares)), "0"));
    expectInvariant(harness, "after the booking");
  });
  it("r1: a WORKING order whose filled shares no answer carried (Tier 1: a DELAYED GTC partly filled inside observe(), its remainder resting): risk's open orders present its 5 unfilled shares and the separate input its 5 filled ones — at the limit, the stated residual, never below their debit, and never dropped", async () => {
    ordinal = 0;
    const harness = assemble({
      cadence: PAPER_EVALUATION_CADENCE,
      perStrategyCap: "1000",
      tier1DelaySeconds: 5,
      script: scheduled({
        B: {
          onFeatures: [
            [iso(S + 5_000), { kind: "BUY", shares: "10", style: "GTC" }],
            [iso(S + 11_000), { kind: "BUY", shares: "5", style: "MAKER" }],
          ],
        },
      }),
    });
    await feed(harness, ...opening(), opened(S + 150, MARKET_B), askLevel(S + 200, MARKET_B, "0.4", "500"), askLevel(S + 210, MARKET_B, "0.34", "5"));
    await feed(harness, level(S + 5_000, MARKET_B, "0.31"));
    expect(outcomeOf(harness).orders).toEqual(["BUY DELAYED 0/10"]);
    harness.clock.positionAt(iso(S + 11_000), 6_000_000_000n);
    await feed(harness, snapshot(S + 11_000, MARKET_X, "yes"));
    const gtc = outcomeOf(harness).orders[0];
    expect(gtc).toBe("BUY PARTIALLY_FILLED 5/10");
    expect(harness.loop.health().execution.fillsObserved).toBe(0);
    const heartbeat = harness.risks.filter((risk) => risk.label === "B").at(-1);
    expect(heartbeat?.context.evaluatedAt).toBe(iso(S + 11_000));
    // Disjoint: 5 unfilled in the open order, 5 filled-but-unbooked here.
    expect(heartbeat?.context.openOrders.map((open) => open.shares)).toEqual(["5"]);
    expect(heartbeat?.document.unbookedFills).toEqual([{ marketId: MARKET_B, side: "YES", shares: "5", debit: "1.75" }]);
    // Check 16: 1.75 unfilled + 1.75 filled (at the limit: 0.05 over their
    // 1.70 debit, never under it) + 1.50 this BUY = 5. The venue's floor, now
    // that BUY rests too: 1.70 + 1.75 + 1.50 = 4.95.
    expect(heartbeat?.evaluation.worstCase?.maximumContractualLoss).toBe("5");
    expect(outcomeOf(harness).orders).toEqual(["BUY PARTIALLY_FILLED 5/10", "BUY RESTING 0/5"]);
    expect(holdingsFloor(harness, "B")).toEqual({ cost: "4.95", shares: "15" });
    expect(harness.halts.records()).toEqual([]);
  });

  it("r1: a DELAYED disposition reached through a TRADE's answer (observeTrade's own sweep — a venue clock that lags the loop's): the answer carries the fill, so every evaluation before its harvest judges the order at its 0.34, not its 0.35 limit", async () => {
    ordinal = 0;
    const counts: string[] = [];
    let lagging = false;
    const harness = assemble({
      cadence: PAPER_EVALUATION_CADENCE,
      perStrategyCap: "1000",
      tier1DelaySeconds: 5,
      script: scheduled({ B: { onFeatures: [[iso(S + 5_000), { kind: "BUY", shares: "10", style: "FAK" }]] } }),
      beforeEvaluation: (current, input, label) => {
        if (label === "B" && input.evaluatedAt === iso(S + 11_000)) {
          counts.push(`${input.callback} (${String(current.loop.health().execution.fillsObserved)} booked): ${counted(current).B}`);
        }
      },
      // The trade reaches the venue after its clock moved past matchableAtNs:
      // the DELAYED order's disposition is applied by observeTrade's sweep,
      // and its fill comes back in observeTrade's ANSWER.
      wrapVenue: (inner, clock): TraderVenue => ({
        observe: (identity) => inner.observe(identity),
        observeTrade: (input) => {
          if (!lagging) return inner.observeTrade(input);
          clock.positionAt(iso(S + 11_000), 6_000_000_000n);
          return inner.observeTrade({ ...input, monotonicNs: 6_000_000_000n });
        },
        submit: (plan) => inner.submit(plan as Parameters<SimulatedVenue["submit"]>[0]),
        fillsSince: (sequence) => inner.fillsSince(sequence),
        orderById: (venueOrderId) => inner.orderById(venueOrderId),
        orderByPlannedId: (plannedOrderId) => inner.orderByPlannedId(plannedOrderId),
        acknowledgeTerminal: (venueOrderId) => inner.acknowledgeTerminal(venueOrderId),
      }),
    });
    await feed(harness, ...opening(), opened(S + 150, MARKET_B));
    await feed(harness, level(S + 5_000, MARKET_B, "0.31"));
    expect(outcomeOf(harness).orders).toEqual(["BUY DELAYED 0/10"]);
    // observe() runs at 4 s (not yet due); the trade's answer applies it.
    harness.clock.positionAt(iso(S + 11_000), 4_000_000_000n);
    lagging = true;
    await feed(harness, trade(S + 11_000, MARKET_B, "0.3", "5", "ASK"));
    expect(outcomeOf(harness).orders).toEqual(["BUY FILLED 10/10"]);
    expect(harness.venue.fills.map((fill) => `${fill.shares}@${fill.price}`)).toEqual(["10@0.34"]);
    // At B's evaluation of that event — after the trade, BEFORE its harvest
    // (nothing booked): the FILLED order at its seen 3.40, not its 3.50
    // limit. Then booked, its fill delivered and its view: 3.40 throughout.
    expect(counts[0]).toBe("onFeatures (0 booked): 3.4");
    expect(counts.slice(1).every((entry) => entry.endsWith("(1 booked): 3.4"))).toBe(true);
    expect(harness.loop.health().execution.fillsObserved).toBe(1);
    expectInvariant(harness, "after the harvest");
    expect(harness.halts.records()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. The seeded property
// ---------------------------------------------------------------------------

/** Yields to the macrotask queue so a long synchronous stretch never starves the worker (CI-2; `CAP1-R1-GATE-1`). */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

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
  /**
   * `CAP-1` r1: evaluations at which a BUY order the venue shows TERMINAL is
   * still held by the loop (not yet settled): where the cap check judges a
   * final size the loop has not acted on yet (`CAP1-ASTRA-R1-01`).
   */
  terminalUnsettledAtEvaluation: number;
  /** `CAP-1` r1: risk evaluations presenting a PARTLY FILLED working order (`CAP1-ASTRA-R1-02`). */
  partlyFilledPresented: number;
  /**
   * `CAP-1` r2 (`CAP1-ASTRA-R2-01`): evaluations at which an UNBOOKED fill
   * was handed to the loop by a fill PAGE only (no answer carried it): where
   * the cap check prices a fill from a page a harvest already read.
   */
  pageSeenUnbookedAtEvaluation: number;
  /**
   * `CAP-1` r2, the STOPPED residual: evaluations at which some fill no
   * answer or page has handed the loop yet is held at its limit — produced
   * in the batch being evaluated (no read could have preceded the evaluation
   * within SIM-2's budget) …
   */
  unhandedSameBatchAtEvaluation: number;
  /** … or in an EARLIER batch, with no page read since (what a trailing read would reach). */
  unhandedEarlierBatchAtEvaluation: number;
}

/** `CAP-1` r2: a coverage record with every counter at zero. */
function newCoverage(): Coverage {
  return {
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
    terminalUnsettledAtEvaluation: 0,
    partlyFilledPresented: 0,
    pageSeenUnbookedAtEvaluation: 0,
    unhandedSameBatchAtEvaluation: 0,
    unhandedEarlierBatchAtEvaluation: 0,
  };
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
 * `CAP-1` r1 (`CAP1-ASTRA-R1-02`, `-03`): and EXACTLY the floor — no more.
 * Round 0 asserted only the lower bound, so a booked partial fill counted
 * twice (in the position AND in its order presented whole) and an unbooked
 * fill priced at its limit both passed.
 *
 * `CAP-1` r2: `excess` is the ONE stated residual, computed from the
 * property's own evidence (`unhandedExcess`): `(limit − price) × shares` for
 * each fill of the market no answer or page has handed the loop yet. In Tier
 * 0 every fill is carried by an answer, and the Tier-0 run asserts it is
 * `"0"` at every evaluation; in Tier 1 it is exactly the DELAYED fills that
 * no page has carried yet. Checks 16 and 17 must count EXACTLY the floor plus
 * that excess — a fill on a page the loop already read is at its own price.
 *
 * - check 16: the evaluating market's lot, less the intent's own leg, holds
 *   exactly the floor's cost and shares (its primary measure is that cost);
 * - check 17: every scenario that marks the lot measures, less the intent's
 *   own loss, exactly the floor's loss under the same mark (`cost − shares ×
 *   mark`) — the evaluation reports the with-unbooked assessment, which counts
 *   an unbooked fill exactly as booked;
 * - an APPROVED entry: floor + its bounded cost ≤ `maxWorstCaseContractualLoss`.
 */
function expectRiskFloor(
  harness: Harness,
  risk: Harness["risks"][number],
  worstCaseLimit: string,
  coverage: Coverage,
  where: string,
  excess: string,
): void {
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
  // r1: exactly — no share counted twice, no fill above its own price.
  // r2: … but the stated residual (`excess`, "0" unless a fill is unhanded).
  expect(countedCost, `${where}: check 16 counts the floor's cost exactly (+ ${excess} unhanded)`).toBe(addDecimal(floor.cost, excess));
  expect(countedShares, `${where}: check 16 counts the floor's shares exactly`).toBe(floor.shares);
  for (const outcome of risk.evaluation.scenario?.outcomes ?? []) {
    // C1-RISK: a market the scenario does not mark (an empty YES bid) is
    // valued at 0 — its full committed cost is loss (ADR-030 Rule 8 item 2,
    // note of 2026-10-08). So the oracle reads a missing mark as "0" rather
    // than skipping the outcome, and the floored outcome is checked exactly.
    const mark =
      risk.document.scenarios
        .find((scenario) => scenario.scenarioId === outcome.scenarioId)
        ?.marks.find((entry) => entry.marketId === marketId)?.yesPrice ?? "0";
    coverage.scenarioOutcomesChecked += 1;
    const countedLoss = subDecimal(outcome.loss, subDecimal(bought.cost, mulDecimal(bought.shares, mark)));
    const floorLoss = subDecimal(floor.cost, mulDecimal(floor.shares, mark));
    expect(countedLoss, `${where}: check 17 (${outcome.scenarioId}) measures ${countedLoss} of the floor's ${floorLoss}`).toSatisfy(
      (value: string) => compareDecimal(value, floorLoss) >= 0,
    );
    expect(countedLoss, `${where}: check 17 (${outcome.scenarioId}) measures the floor's loss exactly (+ ${excess} unhanded)`).toBe(
      addDecimal(floorLoss, excess),
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
 *
 * `CAP-1` r2 (`CAP1-ASTRA-R2-01`): `tier` `"TIER_1"` runs the same property on
 * a Tier-1 venue whose market B (and, per seed, A) is DELAYED 5 s, with the
 * venue's clock positioned at each batch's instant — so dispositions are
 * applied inside `observe()` and a cancel's own sweep, whose answers carry no
 * fills. The oracle is the property's own EVIDENCE (`evidenceVenue`): every
 * check above is EXACT plus `(limit − price) × shares` for each fill no
 * answer or page has handed the loop yet (`unhandedExcess`), and nothing
 * else. In Tier 0 that excess is asserted to be zero at every evaluation.
 */
type VenueTier = "TIER_0" | "TIER_1";

async function propertyRun(seed: number, cadence: EvaluationCadenceOption, steps: number, coverage: Coverage, tier: VenueTier = "TIER_0"): Promise<void> {
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
  // `CAP-1` r2: Tier 1 — B always DELAYED; A delayed or immediate, from its OWN stream.
  const delayA = tier === "TIER_1" ? pick(prng(seed ^ 0x0de1_a7ed), [0, 5]) : 0;
  // The CURRENT process's evidence (a restart starts it afresh).
  let evidence = newEvidence();
  /**
   * The excess the cap check (`terminalOnly`: terminal orders) and checks 16
   * and 17 (every order) must count for the fills not handed to the loop yet.
   * Tier 0 hands every fill in an answer, so there it must be none.
   */
  const excessNow = (current: Harness, terminalOnly: boolean): ReturnType<typeof unhandedExcess> => {
    const measured = unhandedExcess(current, evidence, terminalOnly);
    if (tier === "TIER_0") expect(measured.fills, `seed ${String(seed)}: Tier 0 hands the loop every fill in an answer`).toEqual([]);
    return measured;
  };

  const start = (): Harness => {
    const local = newEvidence();
    evidence = local;
    // The fills this process BOOKED (converted into a position).
    const booked = new Set<string>();
    const harness = assemble({
      cadence,
      perStrategyCap,
      globalAccountCap,
      risk: { maxWorstCaseContractualLoss: worstCaseLimit },
      script: tracking,
      ...(tier === "TIER_1" ? { tier1DelaySeconds: (marketId: string) => (marketId === MARKET_A ? delayA : 5) } : {}),
      wrapVenue: evidenceVenue(local),
      onRisk: (current, risk) => {
        expectRiskFloor(
          current,
          risk,
          worstCaseLimit,
          coverage,
          `seed ${String(seed)} at ${risk.label}'s risk check at ${risk.context.evaluatedAt}`,
          excessNow(current, false).excess[risk.label],
        );
        const presented = new Set(risk.context.openOrders.map((open) => open.orderId));
        if (current.venue.ordersSnapshot().some((order) => presented.has(order.simulatedOrderId) && compareDecimal(order.filledShares, "0") > 0)) {
          coverage.partlyFilledPresented += 1;
        }
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
        if (
          current.venue
            .ordersSnapshot()
            .some((order) => order.action === "BUY" && TERMINAL.has(order.state) && current.loop.timeInForceFor(order.plannedOrderId) !== undefined)
        ) {
          coverage.terminalUnsettledAtEvaluation += 1;
        }
        // r2: a fill a page handed the loop (no answer did) that is not booked yet.
        for (const fillId of local.paged) {
          if (local.answered.has(fillId) || booked.has(fillId)) continue;
          coverage.pageSeenUnbookedAtEvaluation += 1;
          break;
        }
        // r2: the STOPPED residual, by where its fills were produced.
        const unhanded = excessNow(current, false).fills;
        if (unhanded.length > 0) {
          if (unhanded.some((fillId) => (local.producedIn.get(fillId) ?? local.batch) < local.batch)) {
            coverage.unhandedEarlierBatchAtEvaluation += 1;
          } else {
            coverage.unhandedSameBatchAtEvaluation += 1;
          }
        }
        expectInvariant(current, `seed ${String(seed)} before ${input.callback} at ${input.evaluatedAt}`, excessNow(current, true).excess);
      },
    });
    const observeFill = harness.gate.observeFill.bind(harness.gate);
    vi.spyOn(harness.gate, "observeFill").mockImplementation((instanceId, fill, plannedOrderId) => {
      booked.add(fill.simulatedFillId);
      observeFill(instanceId, fill, plannedOrderId);
    });
    const evaluate = harness.gate.evaluate.bind(harness.gate);
    vi.spyOn(harness.gate, "evaluate").mockImplementation((input) => {
      const outcome = evaluate(input);
      coverage.capChecks += 1;
      const label: Label = input.instanceId === INSTANCE_A ? "A" : "B";
      expect(
        countedAt(harness.gate, input, input.instanceId),
        `seed ${String(seed)}: the cap check's own snapshot for ${label}`,
      ).toBe(addDecimal(committed(harness)[label].exact, excessNow(harness, true).excess[label]));
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

  /**
   * One batch, as its own drain. `CAP-1` r2: the batch is numbered for the
   * evidence, and in Tier 1 the venue's clock is positioned at the batch's
   * instant first (recorded time is what applies a DELAYED disposition).
   * Tier 0 leaves the clock where it always was, so its runs are unchanged.
   */
  const feedBatch = async (current: Harness, at: number, batch: IngestedEvent | readonly IngestedEvent[]): Promise<void> => {
    evidence.batch += 1;
    if (tier === "TIER_1") current.clock.positionAt(iso(at), BigInt(at) * 1_000_000n);
    await feed(current, batch);
  };

  const warmUp = async (harness: Harness, at: number): Promise<void> => {
    unconfiguredOnly = false;
    await feedBatch(harness, at, [reference(at), snapshot(at, MARKET_A, "yes"), snapshot(at, MARKET_A, "no"), snapshot(at, MARKET_B, "yes"), snapshot(at, MARKET_B, "no")]);
    await feedBatch(harness, at + 10, opened(at + 10, MARKET_A));
    await feedBatch(harness, at + 20, opened(at + 20, MARKET_B));
  };

  let harness = start();
  let at = S;
  await warmUp(harness, at);
  for (let step = 0; step < steps; step += 1) {
    at += pick(events, [0, 20, 400, 1_000, 1_500, 3_000, 5_000, 6_000]);
    if (events() < 0.03) {
      // A RESTART: the process ends here; a new one starts from the stream.
      expectInvariant(harness, `seed ${String(seed)} at the restart`, excessNow(harness, true).excess);
      coverage.restarts += 1;
      harness = start();
      expect(harness.gate.metrics()).toMatchObject({ open: 0, applied: 0 });
      expect(harness.venue.ordersSnapshot()).toEqual([]);
      await warmUp(harness, at);
      continue;
    }
    const drawn = randomEvents(events, at, `cap1-${String(seed)}-${String(step)}`);
    unconfiguredOnly = drawn.unconfiguredOnly;
    await feedBatch(harness, at, drawn.events);
    expectInvariant(harness, `seed ${String(seed)} after step ${String(step)}`, excessNow(harness, true).excess);
  }
  for (const order of harness.venue.ordersSnapshot()) {
    if (order.state === "CANCELLED" && compareDecimal(order.filledShares, "0") > 0) coverage.cancelledAfterPartial += 1;
  }
  expect(harness.halts.records(), `seed ${String(seed)}: no halt`).toEqual([]);
}

/** The coverage counters every Tier-0 run must reach (rounds 0 and 1). */
const TIER_0_PATHS = [
  "evaluationsChecked",
  "capChecks",
  "admissions",
  "capRefusals",
  "partialFills",
  "cancelledAfterPartial",
  "onFillPlacements",
  "onOrderUpdatePlacements",
  "carriedHarvestFills",
  "ordinaryHarvestFills",
  "unbookedFillsAtEvaluation",
  "restarts",
  "riskEvaluationsChecked",
  "riskEvaluationsWithUnbooked",
  "scenarioOutcomesChecked",
  "worstCaseRefusals",
  "riskAdmissions",
  "terminalUnsettledAtEvaluation",
  "partlyFilledPresented",
] as const satisfies readonly (keyof Coverage)[];

describe("CAP-1 property — over random fills, partial fills, cancels, onFill and onOrderUpdate placements, carried and ordinary harvests and restarts, the cap check counts every committed pUSD exactly once, at every evaluation; and (r0, r1) risk checks 16 and 17 count exactly the venue's floor at every risk evaluation", () => {
  it("holds for 60 seeds at the PAPER cadence and 30 at the per-frame cadence, and every listed path occurs", async () => {
    const coverage = newCoverage();
    // `CAP1-R1-GATE-1`: one MACROTASK turn per seed (CI-2's helper). A run of
    // ~50-70 s that never yields starves the worker's RPC with vitest, which
    // then exits 1 ("Timeout calling onTaskUpdate") with every test passed.
    for (let seed = 1; seed <= 60; seed += 1) {
      await propertyRun(seed, PAPER_EVALUATION_CADENCE, 40, coverage);
      await yieldToEventLoop();
    }
    for (let seed = 1_001; seed <= 1_030; seed += 1) {
      await propertyRun(seed, PER_FRAME, 40, coverage);
      await yieldToEventLoop();
    }
    // Non-vacuity: every path the packet lists occurred, and the cap bound.
    for (const path of TIER_0_PATHS) expect(coverage[path], path).toBeGreaterThan(0);
    // `CAP-1` r2: and in Tier 0 no evaluation ever met a fill the loop had not been handed.
    expect(coverage.unhandedSameBatchAtEvaluation + coverage.unhandedEarlierBatchAtEvaluation).toBe(0);
  }, 300_000);

  it("r2 (CAP1-ASTRA-R2-01): holds EXACTLY on a Tier-1 venue whose DELAYED dispositions are applied inside observe() and a cancel's sweep, for 40 seeds at the PAPER cadence and 20 per-frame — a fill on a page the loop already read is at its own price, and only a fill no page or answer has handed the loop is at its limit, by exactly (limit − price) × shares", async () => {
    const coverage = newCoverage();
    for (let seed = 2_001; seed <= 2_040; seed += 1) {
      await propertyRun(seed, PAPER_EVALUATION_CADENCE, 40, coverage, "TIER_1");
      await yieldToEventLoop();
    }
    for (let seed = 3_001; seed <= 3_020; seed += 1) {
      await propertyRun(seed, PER_FRAME, 40, coverage, "TIER_1");
      await yieldToEventLoop();
    }
    // Non-vacuity: every path occurred on the Tier-1 venue too, including an
    // evaluation that priced a fill from a page a harvest had read (the fix),
    // and the stated residual both within a batch and across batches.
    for (const [path, count] of Object.entries(coverage)) expect(count, path).toBeGreaterThan(0);
  }, 300_000);
});

// ---------------------------------------------------------------------------
// `ROLLOVER-1` r7 — one series-bound instance, two live windows
// ---------------------------------------------------------------------------

/** The markets one risk document's portfolio and scenarios name, in order (positions, unbooked fills, marks). */
function portfolioMarkets(risk: Harness["risks"][number]): {
  readonly positions: readonly string[];
  readonly unbooked: readonly string[];
  readonly marks: readonly string[];
} {
  const named = (marketId: string): string => (marketId === MARKET_A ? "A" : marketId === MARKET_B ? "B" : marketId);
  const positions = risk.context.positions.map((position) => `${named(position.marketId)} ${position.side} ${position.shares} @ ${position.costBasis}`);
  return {
    positions,
    unbooked: (risk.document.unbookedFills ?? []).map((entry) => `${named(entry.marketId)} ${entry.side} ${entry.shares} / ${entry.debit}`),
    marks: (risk.document.scenarios[0]?.marks ?? []).map((mark) => `${named(mark.marketId)} ${mark.yesPrice}`),
  };
}

describe("ROLLOVER-1 r7 (R7-FABLE-02): the R4-CAP check-16 shape inside ONE WINDOW of a series-bound instance — its filled-but-unbooked fill reaches check 16 under the INSTANCE id, never the window's registration key", () => {
  /**
   * CAP-1's carried-path pin, unchanged except that A and B are two windows
   * of one instance (`windows: true`): B's registration key is
   * `<INSTANCE_A>|<MARKET_B>`, never equal to the instance id the allocator's
   * commitments carry. B places 10 @ 0.34 twice at S + 5 000 (the second from
   * its `onFill`, filled at once and unbooked until the next harvest), then a
   * third at S + 10 000: 3.40 booked + 3.40 unbooked + 3.50 = 10.30 > 8.
   *
   * Asking the allocator under the registration key (mutant R7-U1, which
   * survived every suite at `95a0b76`) states no unbooked fill for a window:
   * check 16 measures 6.90 and the third BUY is admitted.
   */
  it("the third BUY is REFUSED RISK_WORST_CASE_LOSS_EXCEEDED at 10.30, its unbooked 10 @ 0.34 stated through the separate input", async () => {
    ordinal = 0;
    const FIRST = iso(S + 5_000);
    const BUY10: Act = { kind: "BUY", shares: "10", style: "FAK" };
    const harness = assemble({
      cadence: PAPER_EVALUATION_CADENCE,
      perStrategyCap: "1000",
      risk: { maxWorstCaseContractualLoss: "8" },
      windows: true,
      script: scheduled({ B: { onFeatures: [[FIRST, BUY10], [iso(S + 10_000), BUY10]], onFill: [[FIRST, BUY10]] } }),
    });
    await feed(harness, ...opening(), opened(S + 150, MARKET_B));
    await feed(harness, snapshot(S + 5_000, MARKET_X, "yes"));
    await feed(harness, snapshot(S + 10_000, MARKET_X, "yes"));
    expect(outcomeOf(harness)).toEqual({
      accepted: 2,
      risk: { RISK_WORST_CASE_LOSS_EXCEEDED: 1 },
      allocator: {},
      fills: ["BUY 10@0.34", "BUY 10@0.34"],
      orders: ["BUY FILLED 10/10", "BUY FILLED 10/10"],
    });
    expect(checkSixteen(harness, "B")).toEqual(["3.5", "6.9", "10.3"]);
    expect(unbookedInputs(harness, "B")).toEqual([[], [], [{ marketId: MARKET_B, side: "YES", shares: "10", debit: "3.4" }]]);
    // Both registrations are the ONE instance's windows.
    expect(harness.risks.map((risk) => risk.context.strategyInstanceId)).toEqual([INSTANCE_A, INSTANCE_A, INSTANCE_A]);
    expect(harness.halts.records()).toEqual([]);
  });
});

describe("ROLLOVER-1 r7 (R7-FABLE-01): checks 16 and 17 judge the series-bound INSTANCE — window A's booked position, its filled-but-unbooked fill and its mark all reach window B's evaluation", () => {
  /**
   * Window A places 10 @ 0.34 at S + 5 000 and, from its `onFill`, another
   * that fills at once and stays UNBOOKED until the next harvest; window B's
   * first BUY (10, bound 3.50) is evaluated at S + 10 000. The instance holds
   * 3.40 booked + 3.40 unbooked in A, so B's worst case is 10.30; B ALONE —
   * what `95a0b76` measured — is 3.50.
   *
   * Check 17 (`spot.down`, −0.1): A and B are each marked from their own YES
   * book, bid 0.32 → 0.22. The instance's 30 YES are worth 6.60 against
   * 10.30 of cost: a loss of 3.70 (B alone: 3.50 − 2.20 = 1.30).
   */
  const FIRST = iso(S + 5_000);
  const BUY10: Act = { kind: "BUY", shares: "10", style: "FAK" };

  async function run(risk: RiskLimits): Promise<Harness> {
    ordinal = 0;
    const harness = assemble({
      cadence: PAPER_EVALUATION_CADENCE,
      perStrategyCap: "1000",
      risk,
      windows: true,
      script: scheduled({ A: { onFeatures: [[FIRST, BUY10]], onFill: [[FIRST, BUY10]] }, B: { onFeatures: [[iso(S + 10_000), BUY10]] } }),
    });
    await feed(harness, ...opening(), opened(S + 100, MARKET_A), opened(S + 150, MARKET_B));
    await feed(harness, snapshot(S + 5_000, MARKET_X, "yes"));
    await feed(harness, snapshot(S + 10_000, MARKET_X, "yes"));
    return harness;
  }

  it("check 16: B's entry is measured at 3.40 + 3.40 + 3.50 = 10.30 — REFUSED under 10.29, ADMITTED under 10.30 (95a0b76: 3.50, admitted under both)", async () => {
    const under = await run({ maxWorstCaseContractualLoss: "10.29" });
    expect(outcomeOf(under)).toMatchObject({ accepted: 2, risk: { RISK_WORST_CASE_LOSS_EXCEEDED: 1 }, allocator: {}, fills: ["BUY 10@0.34", "BUY 10@0.34"] });
    expect(checkSixteen(under, "B")).toEqual(["10.3"]);
    const judged = under.risks.find((risk) => risk.label === "B");
    if (judged === undefined) throw new Error("B was never risk-checked");
    // The portfolio B was judged on: A's booked position, A's unbooked fill
    // (under the INSTANCE id), and both markets marked — B's first.
    expect(portfolioMarkets(judged)).toEqual({
      positions: ["A YES 10 @ 3.4"],
      unbooked: ["A YES 10 / 3.4"],
      marks: ["B 0.22", "A 0.22"],
    });
    expect(under.halts.records()).toEqual([]);

    const at = await run({ maxWorstCaseContractualLoss: "10.3" });
    expect(outcomeOf(at)).toMatchObject({ accepted: 3, risk: {}, allocator: {}, fills: ["BUY 10@0.34", "BUY 10@0.34", "BUY 10@0.34"] });
  });

  it("check 17: B's entry is measured at the instance's scenario loss, 10.30 − 30 × 0.22 = 3.70 — REFUSED under 3.69, ADMITTED under 3.70 (95a0b76: 1.30, admitted under both)", async () => {
    const under = await run({ maxScenarioLoss: "3.69" });
    expect(outcomeOf(under)).toMatchObject({ accepted: 2, risk: { RISK_SCENARIO_LOSS_EXCEEDED: 1 }, allocator: {} });
    const judged = under.risks.find((risk) => risk.label === "B");
    expect(judged?.evaluation.scenario?.worstLoss).toBe("3.7");
    const at = await run({ maxScenarioLoss: "3.7" });
    expect(outcomeOf(at)).toMatchObject({ accepted: 3, risk: {} });
  });

  it("a WORKING order of window A (a maker BUY of 10 resting at 0.30) is one of B's open orders: B's entry measures 3.00 + 3.50 = 6.50 — REFUSED under 6.49, ADMITTED under 6.50 (95a0b76: 3.50)", async () => {
    async function working(limit: string): Promise<Harness> {
      ordinal = 0;
      const harness = assemble({
        cadence: PAPER_EVALUATION_CADENCE,
        perStrategyCap: "1000",
        risk: { maxWorstCaseContractualLoss: limit },
        windows: true,
        script: scheduled({ A: { onFeatures: [[FIRST, { kind: "BUY", shares: "10", style: "MAKER" }]] }, B: { onFeatures: [[iso(S + 10_000), BUY10]] } }),
      });
      await feed(harness, ...opening(), opened(S + 100, MARKET_A), opened(S + 150, MARKET_B));
      await feed(harness, snapshot(S + 5_000, MARKET_X, "yes"));
      await feed(harness, snapshot(S + 10_000, MARKET_X, "yes"));
      return harness;
    }
    const under = await working("6.49");
    expect(outcomeOf(under)).toMatchObject({ accepted: 1, risk: { RISK_WORST_CASE_LOSS_EXCEEDED: 1 }, fills: [], orders: ["BUY RESTING 0/10"] });
    expect(checkSixteen(under, "B")).toEqual(["6.5"]);
    const judged = under.risks.find((risk) => risk.label === "B");
    expect(judged?.document.portfolio.openOrders).toHaveLength(1);
    const at = await working("6.5");
    expect(outcomeOf(at)).toMatchObject({ accepted: 2, risk: {}, fills: ["BUY 10@0.34"] });
  });

  it("control: A's OWN evaluations are judged on A — B holds nothing, so A's first BUY measures 3.50 and its onFill BUY 6.90 — and two MARKET-BOUND instances in the same shape never see each other (B measures 3.50)", async () => {
    const windows = await run({});
    expect(checkSixteen(windows, "A")).toEqual(["3.5", "6.9"]);
    ordinal = 0;
    const bound = assemble({
      cadence: PAPER_EVALUATION_CADENCE,
      perStrategyCap: "1000",
      script: scheduled({ A: { onFeatures: [[FIRST, BUY10]], onFill: [[FIRST, BUY10]] }, B: { onFeatures: [[iso(S + 10_000), BUY10]] } }),
    });
    await feed(bound, ...opening(), opened(S + 100, MARKET_A), opened(S + 150, MARKET_B));
    await feed(bound, snapshot(S + 5_000, MARKET_X, "yes"));
    await feed(bound, snapshot(S + 10_000, MARKET_X, "yes"));
    expect(checkSixteen(bound, "B")).toEqual(["3.5"]);
    const judged = bound.risks.find((risk) => risk.label === "B");
    if (judged === undefined) throw new Error("B was never risk-checked");
    expect(portfolioMarkets(judged)).toEqual({ positions: [], unbooked: [], marks: ["B 0.22"] });
  });
});
