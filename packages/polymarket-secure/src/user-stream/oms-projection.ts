/**
 * Projection of normalized user-stream events into the inputs of the OMS's
 * observation, fill and settlement ports (WP-280 deliverable 2; WP-270's
 * `OrderObservation`, `FillReport` and `SettlementObservation`, which name
 * WP-280 as their source).
 *
 * `packages/oms` is a layer-1 package and this one is layer 2, and this
 * package declares no dependency on it, so the three shapes are declared here
 * STRUCTURALLY. `test/contract/user-stream/` proves at compile time that each
 * is assignable to the OMS's own type, and at run time that a real
 * `OrderManager` accepts the projected fixtures.
 *
 * FAIL-CLOSED RULES. The projection states only what the event states
 * unambiguously; everything else is a SHORTFALL, and every shortfall makes the
 * stream request reconciliation (`manager.ts`). Nothing is guessed:
 *
 * - An order status outside the verified vocabulary is passed to the OMS as
 *   the fixed sentinel {@link UNRECOGNIZED_ORDER_STATUS}, never as the wire
 *   lexeme: the OMS's own vocabulary is wider than the user channel's (it
 *   knows `EXPIRED`), and a wire value must not be recognised by accident.
 *   The OMS sends such an order to RECONCILING (WP-270).
 * - Which side of a trade is the account's comes from `trader_side`. A TAKER
 *   trade's own leg is the taker order. A MAKER trade's own legs are the maker
 *   orders the transport's `isAccountOwner` affirmed; an undetermined leg is
 *   never projected.
 * - A fill is projected only with its match time (`match_time`/`matchtime`)
 *   and with an exact fee AMOUNT. The stream carries only a fee RATE, and the
 *   fee rounding direction is undocumented (U-16), so the amount is known
 *   exactly in two cases only: a maker leg (makers are never charged fees,
 *   `venue-facts.ts`) and a taker leg whose rate is exactly zero. A taker fill
 *   with a non-zero or absent rate is a shortfall, never a zero-fee fill.
 * - A taker fill is projected only when the maker legs fix its economics
 *   without any reading of trade-level semantics: every maker leg is on the
 *   same asset, on the opposite side and at the trade price, and the matched
 *   amounts sum exactly to the trade size. Otherwise (several prices, a
 *   complementary-asset match, missing legs) it is a shortfall.
 * - Fill shortfalls are raised on the `MATCHED` event, which is the event that
 *   establishes a match. Later settlement events project a fill only when they
 *   carry the complete facts again (the OMS de-duplicates identical reports);
 *   when they do not, they still project their settlement observation.
 * - `allocationDiscriminator` is omitted, so the OMS's default `"0"` applies:
 *   one fill per (trade id, order id). A trade naming one own maker order id
 *   twice is a shortfall.
 *
 * Pure and total; never throws.
 */

import type { DecimalString } from "@polymarket-bot/domain";

import type { NormalizedMakerOrder, NormalizedOrderEvent, NormalizedTradeEvent } from "./normalize.js";
import type { UserTradeStatus } from "./venue-facts.js";
import { compareDecimals, sumDecimals } from "./wire.js";

/** Structurally the OMS's `OrderObservation` (WP-270). */
export interface OmsOrderObservation {
  readonly venueOrderId: string;
  readonly status: string;
}

/** Structurally the OMS's `FillReport` (WP-270), always with an explicit fee. */
export interface OmsFillReport {
  readonly venueTradeId: string;
  readonly venueOrderId: string;
  readonly shares: DecimalString;
  readonly price: DecimalString;
  readonly liquidityRole: "MAKER" | "TAKER";
  readonly feeAmount: DecimalString;
  readonly feeAssetId: null;
  readonly matchedAt: string;
}

/** Structurally the OMS's `SettlementObservation` (WP-270). */
export interface OmsSettlementObservation {
  readonly venueTradeId: string;
  readonly venueOrderId: string;
  readonly status: UserTradeStatus;
  readonly transactionHash: string | null;
  readonly observedAt: string;
}

/** The status given to the OMS for an order status this adapter does not recognise. */
export const UNRECOGNIZED_ORDER_STATUS = "UNRECOGNIZED" as const;

export const PROJECTION_SHORTFALLS = [
  "ORDER_STATUS_UNRECOGNIZED",
  "ORDER_STATUS_ABSENT",
  "ORDER_LIFECYCLE_UNRECOGNIZED",
  "TRADE_STATUS_UNRECOGNIZED",
  "TRADE_STATUS_C3",
  "TRADER_SIDE_UNKNOWN",
  "MAKER_LEG_OWNERSHIP_UNDETERMINED",
  "NO_OWN_MAKER_LEG",
  "OWN_MAKER_LEG_ON_TAKER_TRADE",
  "DUPLICATE_OWN_MAKER_LEG",
  "MATCH_TIME_ABSENT",
  "TAKER_ECONOMICS_UNVERIFIABLE",
  "TAKER_FEE_NOT_ON_STREAM",
  "FILL_SIZE_NOT_POSITIVE",
] as const;
export type ProjectionShortfall = (typeof PROJECTION_SHORTFALLS)[number];

export interface OrderProjection {
  readonly observation: OmsOrderObservation | null;
  readonly shortfalls: readonly ProjectionShortfall[];
}

export interface TradeProjection {
  /** Apply before `settlements`: the OMS records a settlement only against a recorded fill. */
  readonly fills: readonly OmsFillReport[];
  readonly settlements: readonly OmsSettlementObservation[];
  readonly shortfalls: readonly ProjectionShortfall[];
}

export function projectOrderEventForOms(event: NormalizedOrderEvent): OrderProjection {
  const shortfalls: ProjectionShortfall[] = [];
  if (event.lifecycle.kind !== "KNOWN") shortfalls.push("ORDER_LIFECYCLE_UNRECOGNIZED");
  let observation: OmsOrderObservation | null = null;
  switch (event.status.kind) {
    case "KNOWN":
      observation = Object.freeze({ venueOrderId: event.venueOrderId, status: event.status.value });
      break;
    case "UNRECOGNIZED":
      observation = Object.freeze({ venueOrderId: event.venueOrderId, status: UNRECOGNIZED_ORDER_STATUS });
      shortfalls.push("ORDER_STATUS_UNRECOGNIZED");
      break;
    case "ABSENT":
      shortfalls.push("ORDER_STATUS_ABSENT");
      break;
  }
  return Object.freeze({ observation, shortfalls: Object.freeze(shortfalls) });
}

interface OwnLeg {
  readonly role: "TAKER" | "MAKER";
  readonly venueOrderId: string;
  readonly maker: NormalizedMakerOrder | null;
}

function ownLegs(event: NormalizedTradeEvent, shortfalls: ProjectionShortfall[]): readonly OwnLeg[] {
  const makers = event.makerOrders ?? [];
  if (event.traderSide.kind !== "KNOWN") {
    shortfalls.push("TRADER_SIDE_UNKNOWN");
    return [];
  }
  if (event.traderSide.value === "TAKER") {
    // Same-account matching is a registered venue-fact gap; an own maker leg on our own taker trade is not judged here.
    if (makers.some((maker) => maker.account === "OWN")) shortfalls.push("OWN_MAKER_LEG_ON_TAKER_TRADE");
    return [{ role: "TAKER", venueOrderId: event.takerOrderId, maker: null }];
  }
  const own = makers.filter((maker) => maker.account === "OWN");
  if (makers.some((maker) => maker.account === "UNDETERMINED")) shortfalls.push("MAKER_LEG_OWNERSHIP_UNDETERMINED");
  else if (own.length === 0) shortfalls.push("NO_OWN_MAKER_LEG");
  const counts = new Map<string, number>();
  for (const maker of own) counts.set(maker.venueOrderId, (counts.get(maker.venueOrderId) ?? 0) + 1);
  if ([...counts.values()].some((count) => count > 1)) shortfalls.push("DUPLICATE_OWN_MAKER_LEG");
  return own
    .filter((maker) => counts.get(maker.venueOrderId) === 1)
    .map((maker) => ({ role: "MAKER" as const, venueOrderId: maker.venueOrderId, maker }));
}

function opposite(side: "BUY" | "SELL"): "BUY" | "SELL" {
  return side === "BUY" ? "SELL" : "BUY";
}

/** The taker leg's fill facts, or the reason they are not fixed by the event. */
function takerFill(event: NormalizedTradeEvent): { readonly shares: DecimalString; readonly feeAmount: DecimalString } | ProjectionShortfall {
  const makers = event.makerOrders;
  if (makers === null || makers.length === 0) return "TAKER_ECONOMICS_UNVERIFIABLE";
  const direct = makers.every(
    (maker) => maker.assetId === event.assetId && maker.side === opposite(event.side) && compareDecimals(maker.price, event.price) === 0,
  );
  if (!direct || compareDecimals(sumDecimals(makers.map((maker) => maker.matchedAmount)), event.size) !== 0) return "TAKER_ECONOMICS_UNVERIFIABLE";
  if (compareDecimals(event.size, "0") <= 0) return "FILL_SIZE_NOT_POSITIVE";
  if (event.feeRateBps === null || compareDecimals(event.feeRateBps, "0") !== 0) return "TAKER_FEE_NOT_ON_STREAM";
  return { shares: event.size, feeAmount: "0" };
}

export function projectTradeEventForOms(event: NormalizedTradeEvent): TradeProjection {
  const shortfalls: ProjectionShortfall[] = [];
  const fills: OmsFillReport[] = [];
  const settlements: OmsSettlementObservation[] = [];
  const legs = ownLegs(event, shortfalls);
  const status = event.status;
  if (status.kind !== "KNOWN") {
    shortfalls.push(status.kind === "UNRECOGNIZED" && status.reason === "C3_REST_ONLY_STATUS_ON_STREAM" ? "TRADE_STATUS_C3" : "TRADE_STATUS_UNRECOGNIZED");
    return Object.freeze({ fills: Object.freeze(fills), settlements: Object.freeze(settlements), shortfalls: Object.freeze(shortfalls) });
  }
  const establishesMatch = status.value === "MATCHED";
  const fillShortfall = (reason: ProjectionShortfall): void => {
    if (establishesMatch && !shortfalls.includes(reason)) shortfalls.push(reason);
  };
  for (const leg of legs) {
    settlements.push(
      Object.freeze({
        venueTradeId: event.venueTradeId,
        venueOrderId: leg.venueOrderId,
        status: status.value,
        transactionHash: event.transactionHash,
        observedAt: event.venueTimestamp.iso,
      }),
    );
    if (event.matchedAt === null) {
      fillShortfall("MATCH_TIME_ABSENT");
      continue;
    }
    let facts: { readonly shares: DecimalString; readonly price: DecimalString; readonly feeAmount: DecimalString };
    if (leg.maker === null) {
      const taker = takerFill(event);
      if (typeof taker === "string") {
        fillShortfall(taker);
        continue;
      }
      facts = { shares: taker.shares, price: event.price, feeAmount: taker.feeAmount };
    } else {
      if (compareDecimals(leg.maker.matchedAmount, "0") <= 0) {
        fillShortfall("FILL_SIZE_NOT_POSITIVE");
        continue;
      }
      // Makers are never charged fees (venue-facts.ts, MAKERS_ARE_NEVER_CHARGED_FEES).
      facts = { shares: leg.maker.matchedAmount, price: leg.maker.price, feeAmount: "0" };
    }
    fills.push(
      Object.freeze({
        venueTradeId: event.venueTradeId,
        venueOrderId: leg.venueOrderId,
        shares: facts.shares,
        price: facts.price,
        liquidityRole: leg.role,
        feeAmount: facts.feeAmount,
        feeAssetId: null,
        matchedAt: event.matchedAt.iso,
      }),
    );
  }
  return Object.freeze({ fills: Object.freeze(fills), settlements: Object.freeze(settlements), shortfalls: Object.freeze(shortfalls) });
}
