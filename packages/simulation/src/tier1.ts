/**
 * Tier 1 — the latency and queue-estimated model, immediate-order half (§12.2).
 *
 * §12.2, verbatim:
 *
 * > 1. Add sampled decision, signing, network, and venue latency.
 * > 2. Replay market events during the delay.
 * > 3. Execute against resulting depth.
 * > 4. Apply FAK/FOK/limit semantics and historical fee parameters.
 *
 * The resting half is {@link ./queue.js}.
 *
 * ## Step 2 is a PORT, deliberately
 *
 * "Replay market events during the delay" means the execution happens against
 * the book as it was at `submit + latency`, not as it was at `submit`. This
 * module does not own the book — `packages/order-book` is a same-layer package
 * with no §2.1 edge — so the run driver supplies a {@link DepthTimeline} that
 * answers "what did this book look like at this recorded monotonic instant".
 * The timeline is built from RECORDED events, so nothing here can see a future
 * the live process did not have (§6 invariant 15).
 *
 * ## The venue behaviours this models, each cited
 *
 * ADR-012 §5 requires each of these because each materially changes fill
 * quality, and each cites the dated venue report rather than an assumption:
 *
 * - **Per-market trading delay** (§5.1; venue report §2.2, §7). When
 *   `market.trading.secondsDelay > 0` a marketable order "is accepted but has
 *   not matched yet … Treat it as a pending order rather than a fill". So a
 *   delayed market executes against the depth at
 *   `submit + latency + secondsDelay`, and the outcome is labelled `DELAYED`.
 *   "A simulator that fills marketable orders immediately on a delayed market
 *   **overstates** immediate fills."
 * - **GTD early expiry** (§5.2; venue report §2.3). "GTD orders expire one
 *   minute before their stated expiration as a security threshold", so
 *   {@link GTD_EARLY_EXPIRY_MS} is subtracted from the stated expiry. The same
 *   source mentions a minimum stated expiration "around 3 minutes"; "around" is
 *   not a threshold, so this module does NOT enforce one — inventing a precise
 *   bound from an imprecise sentence is exactly what `AGENTS.md` forbids. It is
 *   carried as a disclosure in `packages/simulation/README.md` §5 item 2.
 * - **Order-type semantics** (§5.3; venue report §2.3). FAK fills available
 *   liquidity and cancels the remainder; FOK is all-or-nothing; `postOnly`
 *   applies only to resting limit types.
 * - **Taker-only fees from the historical snapshot** (§5.4) — {@link ./fees.js}.
 * - **No rebate is credited to a fill** (§5.5, ADR-006 §6). Nothing in this
 *   module adds one, and `SimulatedFill` has no field to put one in.
 */

import { compareDecimal } from "@polymarket-bot/decimal";

import { addMilliseconds } from "./clock.js";
import { computeFee, readFeeScheduleSnapshot, type FeeScheduleSnapshot } from "./fees.js";
import {
  consumeDepth,
  simulatedFill,
  type DepthConsumption,
  type FillModelIdentity,
  type SimulatedFill,
} from "./fill-model.js";
import { isNonNegativeInteger } from "./grammar.js";
import { readLatencyModel, sampleLatency, type LatencyModel, type SampledLatency } from "./latency.js";
import { ownFrozenTree, readOwnPlainInput } from "./plain.js";
import type { BookView, RecordedEventIdentity } from "./ports.js";
import { describeForRefusal, simulationFailure, simulationOk, totally, type SimulationResult } from "./refusals.js";
import type { SeededStreams } from "./seed.js";

/**
 * GTD's stated-to-effective offset.
 *
 * `docs/venue/verified-2026-08-24.md` §2.3, quoted in ADR-012 §5.2: "GTD orders
 * expire one minute before their stated expiration as a security threshold." A
 * VENUE FACT with a date; re-verify each phase (§1.2).
 */
export const GTD_EARLY_EXPIRY_MS = 60_000;

/** The four order types the venue report §2.3 documents. */
export type TimeInForce = "GTC" | "GTD" | "FAK" | "FOK";

/** The identity every Tier-1 result carries. */
export function tier1Model(input: {
  readonly fillModelVersion: string;
  readonly fillModelParametersHash: string;
}): FillModelIdentity {
  return ownFrozenTree<FillModelIdentity>({
    tier: "TIER_1",
    fillModelVersion: input.fillModelVersion,
    fillModelParametersHash: input.fillModelParametersHash,
    permittedUse: "RESEARCH_AND_COMPARISON_BAND_ONLY",
    deploymentDecisionUse: "PERMITTED_AS_BAND",
    calibration: "UNCALIBRATED_NO_PROBE_DATA_EXISTS",
  });
}

/**
 * The recorded book, as of a recorded monotonic instant.
 *
 * Supplied by the run driver: it is the only component that has replayed the
 * events, and it may not hand back a book from an instant later than the one
 * asked for. Returning `undefined` means "no book state is known at that
 * instant", which §6 invariant 12 treats as a reason to refuse, not to guess.
 */
export interface DepthTimeline {
  bookAt(input: {
    readonly marketId: string;
    readonly side: "YES" | "NO";
    readonly monotonicNs: bigint;
  }): { readonly book: BookView; readonly atEvent: RecordedEventIdentity } | undefined;
}

/** Per-market versioned parameters the execution depends on (§6 invariant 9). */
export interface MarketExecutionParameters {
  readonly marketId: string;
  readonly tickSize: string;
  readonly minimumOrderSize: string;
  /** `market.trading.secondsDelay` for the instant replayed (venue report §7). */
  readonly secondsDelay: number;
  /** The version these parameters were read at, so a run can pin them. */
  readonly parametersVersion: number;
}

/** What a Tier-1 immediate execution produced. */
export interface Tier1ImmediateOutcome {
  readonly model: FillModelIdentity;
  readonly timeInForce: TimeInForce;
  readonly latency: SampledLatency;
  /** Recorded monotonic instant the order reached the matching engine. */
  readonly arrivesAtNs: string;
  /** Recorded monotonic instant it could match, after any per-market delay. */
  readonly matchableAtNs: string;
  readonly delayedByMarket: boolean;
  /** The outcome token whose book was consulted; `null` when none was. */
  readonly tokenId: string | null;
  readonly fills: readonly SimulatedFill[];
  readonly filledShares: string;
  readonly remainingShares: string;
  /** What happened to the size that did not fill. */
  readonly remainderDisposition:
    | "RESTS"
    | "CANCELLED_BY_FAK"
    | "REJECTED_BY_FOK"
    | "EXPIRED_BEFORE_MATCHING"
    | "NONE";
  readonly consumption: DepthConsumption;
  /**
   * The recorded event whose book this executed against.
   *
   * `null` when nothing was executed against a book at all — a GTD order whose
   * effective expiry had already passed. A fabricated identity would be a
   * recorded event that never happened, which is exactly what §6 invariant 15
   * exists to prevent.
   */
  readonly atEvent: RecordedEventIdentity | null;
}

/**
 * Executes one immediate (marketable) order under Tier 1.
 *
 * Total: every failure is a typed refusal, including "no book state is known at
 * the arrival instant", which is refused rather than filled against a stale book.
 */
export function tier1Immediate(input: {
  readonly model: FillModelIdentity;
  readonly timeline: DepthTimeline;
  readonly latencyModel: LatencyModel;
  readonly streams: SeededStreams;
  readonly simulatedOrderId: string;
  readonly marketId: string;
  readonly side: "YES" | "NO";
  readonly action: "BUY" | "SELL";
  readonly limitPrice: string;
  readonly shares: string;
  readonly timeInForce: TimeInForce;
  readonly postOnly: boolean;
  readonly submittedAtNs: bigint;
  /** Stated GTD expiry, when the order is GTD. */
  readonly statedExpiryNs?: bigint;
  readonly market: MarketExecutionParameters;
  readonly feeSnapshot: FeeScheduleSnapshot;
}): SimulationResult<Tier1ImmediateOutcome> {
  return totally("executing a Tier-1 immediate order", () => tier1ImmediateInner(input));
}

function tier1ImmediateInner(input: {
  readonly model: FillModelIdentity;
  readonly timeline: DepthTimeline;
  readonly latencyModel: LatencyModel;
  readonly streams: SeededStreams;
  readonly simulatedOrderId: string;
  readonly marketId: string;
  readonly side: "YES" | "NO";
  readonly action: "BUY" | "SELL";
  readonly limitPrice: string;
  readonly shares: string;
  readonly timeInForce: TimeInForce;
  readonly postOnly: boolean;
  readonly submittedAtNs: bigint;
  readonly statedExpiryNs?: bigint;
  readonly market: MarketExecutionParameters;
  readonly feeSnapshot: FeeScheduleSnapshot;
}): SimulationResult<Tier1ImmediateOutcome> {
  // D1 (round-3 review, MEDIUM-1, the same rule as `tier0.ts`): `model` and
  // `market` are CALLER RECORDS this door reads repeatedly and copies onto every
  // fill and outcome. `timeline` is a PORT (`bookAt`) and `streams` holds
  // `SeededStream` INSTANCES, so neither is data and neither is materialized;
  // `latencyModel` and `feeSnapshot` are materialized by their own doors below.
  const readModel = readOwnPlainInput<FillModelIdentity>(input.model, "the fill model identity");
  if (!readModel.ok) return readModel;
  const model = readModel.value;
  const readMarket = readOwnPlainInput<MarketExecutionParameters>(
    input.market,
    "the market execution parameters",
  );
  if (!readMarket.ok) return readMarket;
  const market = readMarket.value;
  if (model === null || typeof model !== "object" || market === null || typeof market !== "object") {
    return simulationFailure(
      "SIMULATION_INPUT_INVALID",
      "a Tier-1 immediate execution needs its model identity and its market parameters as records",
    );
  }
  if (model.tier !== "TIER_1") {
    return simulationFailure(
      "SIMULATION_INPUT_INVALID",
      "tier1Immediate requires a Tier-1 model identity; a Tier-0 identity would mislabel a latency-aware result as pipeline smoke",
      { tier: describeForRefusal(model.tier) },
    );
  }
  if (input.postOnly && input.timeInForce !== "GTC" && input.timeInForce !== "GTD") {
    return simulationFailure(
      "SIMULATED_VENUE_PLAN_UNSUPPORTED",
      "postOnly applies only to resting limit types (venue report §2.3, ADR-012 §5.3)",
      { timeInForce: input.timeInForce },
    );
  }
  if (input.timeInForce === "GTD" && input.statedExpiryNs === undefined) {
    return simulationFailure(
      "SIMULATED_VENUE_PLAN_UNSUPPORTED",
      "a GTD order must state its expiration",
    );
  }

  // The latency model is READ here, on the execution path, not merely offered.
  // `sampleLatencyMs` falls back to `?? 0` on a distribution with nothing to
  // draw from, so an unvalidated model turns "we have no latency data" into "no
  // latency" — the Tier-0 assumption §12.2 bounds to wiring use, wearing a
  // Tier-1 label. Round-1 review probe U2 measured exactly that.
  const latencyModel = readLatencyModel(input.latencyModel);
  if (!latencyModel.ok) return latencyModel;
  const feeSnapshot = readFeeScheduleSnapshot(input.feeSnapshot);
  if (!feeSnapshot.ok) return feeSnapshot;
  if (typeof input.submittedAtNs !== "bigint") {
    return simulationFailure(
      "SIMULATION_INPUT_INVALID",
      "an order is submitted at a recorded monotonic instant (§7.1)",
    );
  }
  if (!isNonNegativeInteger(market.secondsDelay)) {
    return simulationFailure(
      "SIMULATION_INPUT_INVALID",
      "market.trading.secondsDelay is a non-negative integer number of seconds (venue report §7)",
      { offered: String(market.secondsDelay) },
    );
  }

  const latency = sampleLatency(latencyModel.value, input.streams);
  const arrivesAtNs = addMilliseconds(input.submittedAtNs, latency.totalMs);
  const delayedByMarket = market.secondsDelay > 0;
  const matchableAtNs = delayedByMarket
    ? addMilliseconds(arrivesAtNs, market.secondsDelay * 1000)
    : arrivesAtNs;

  if (input.timeInForce === "GTD" && input.statedExpiryNs !== undefined) {
    const effectiveExpiryNs = addMilliseconds(input.statedExpiryNs, -GTD_EARLY_EXPIRY_MS);
    if (matchableAtNs >= effectiveExpiryNs) {
      return simulationOk(
        emptyOutcome({
          model,
          timeInForce: input.timeInForce,
          latency,
          arrivesAtNs,
          matchableAtNs,
          delayedByMarket,
          shares: input.shares,
          disposition: "EXPIRED_BEFORE_MATCHING",
          tokenId: null,
          atEvent: null,
        }),
      );
    }
  }

  const observed = input.timeline.bookAt({
    marketId: input.marketId,
    side: input.side,
    monotonicNs: matchableAtNs,
  });
  if (observed === undefined) {
    return simulationFailure(
      "SIMULATED_VENUE_NO_BOOK",
      "no recorded book state is known at the order's arrival instant; §6 invariant 12 refuses to act on unknown book state rather than filling against a stale one",
      { marketId: input.marketId, matchableAtNs: matchableAtNs.toString() },
    );
  }

  const ladder = observed.book.ladder(input.action === "BUY" ? "ASK" : "BID");
  const consumed = consumeDepth({
    ladder,
    action: input.action,
    limitPrice: input.limitPrice,
    shares: input.shares,
  });
  if (!consumed.ok) return consumed;
  const consumption = consumed.value;

  // FOK is all-or-nothing (venue report §2.3): a partial fill is not a legal
  // outcome, so nothing is booked at all.
  if (input.timeInForce === "FOK" && compareDecimal(consumption.remainingShares, "0") > 0) {
    return simulationOk(
      emptyOutcome({
        model,
        timeInForce: input.timeInForce,
        latency,
        arrivesAtNs,
        matchableAtNs,
        delayedByMarket,
        shares: input.shares,
        disposition: "REJECTED_BY_FOK",
        tokenId: observed.book.tokenId,
        atEvent: observed.atEvent,
      }),
    );
  }

  const fills: SimulatedFill[] = [];
  for (let index = 0; index < consumption.matched.length; index += 1) {
    const level = consumption.matched[index];
    /* c8 ignore next */
    if (level === undefined) continue;
    const fee = computeFee({
      shares: level.shares,
      price: level.price,
      liquidityRole: "TAKER",
      snapshot: feeSnapshot.value,
    });
    if (!fee.ok) return fee;
    fills.push(
      simulatedFill({
        simulatedFillId: `${input.simulatedOrderId}/t1/${String(index)}`,
        simulatedOrderId: input.simulatedOrderId,
        marketId: input.marketId,
        tokenId: observed.book.tokenId,
        side: input.side,
        action: input.action,
        price: level.price,
        shares: level.shares,
        feeAmount: fee.value.feeAmount,
        liquidityRole: "TAKER",
        model,
        atEvent: observed.atEvent,
      }),
    );
  }

  const hasRemainder = compareDecimal(consumption.remainingShares, "0") > 0;
  const remainderDisposition: Tier1ImmediateOutcome["remainderDisposition"] = !hasRemainder
    ? "NONE"
    : input.timeInForce === "FAK"
      ? "CANCELLED_BY_FAK"
      : "RESTS";

  return simulationOk(
    ownFrozenTree<Tier1ImmediateOutcome>({
      model,
      timeInForce: input.timeInForce,
      latency,
      arrivesAtNs: arrivesAtNs.toString(),
      matchableAtNs: matchableAtNs.toString(),
      delayedByMarket,
      tokenId: observed.book.tokenId,
      fills,
      filledShares: consumption.filledShares,
      remainingShares: consumption.remainingShares,
      remainderDisposition,
      consumption,
      atEvent: observed.atEvent,
    }),
  );
}

function emptyOutcome(input: {
  readonly model: FillModelIdentity;
  readonly timeInForce: TimeInForce;
  readonly latency: SampledLatency;
  readonly arrivesAtNs: bigint;
  readonly matchableAtNs: bigint;
  readonly delayedByMarket: boolean;
  readonly shares: string;
  readonly disposition: Tier1ImmediateOutcome["remainderDisposition"];
  readonly tokenId: string | null;
  readonly atEvent: RecordedEventIdentity | null;
}): Tier1ImmediateOutcome {
  return ownFrozenTree<Tier1ImmediateOutcome>({
    model: input.model,
    timeInForce: input.timeInForce,
    latency: input.latency,
    arrivesAtNs: input.arrivesAtNs.toString(),
    matchableAtNs: input.matchableAtNs.toString(),
    delayedByMarket: input.delayedByMarket,
    tokenId: input.tokenId,
    fills: [],
    filledShares: "0",
    remainingShares: input.shares,
    remainderDisposition: input.disposition,
    consumption: {
      matched: [],
      filledShares: "0",
      remainingShares: input.shares,
      notional: "0",
      stoppedAtLimit: false,
    },
    atEvent: input.atEvent,
  });
}
