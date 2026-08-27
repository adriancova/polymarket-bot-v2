/**
 * The domain boundary: a decoded Binance frame becomes a frozen domain payload.
 *
 * DECIMALS ARE NORMALIZED HERE, EXPLICITLY. ADR-001 §3: "The boundary never
 * coerces. There is no implicit normalization anywhere in `packages/domain`. An
 * adapter that receives a non-canonical venue spelling must call
 * `normalizeDecimalString` explicitly, in the adapter, and pass the *result*
 * across the boundary." Binance sends decimal strings (`"25.35190000"`,
 * `"0.001"`), which are *not* canonical — trailing fractional zeros are exactly
 * the redundancy §7.3 forbids — so every price and size goes through
 * `tryNormalizeDecimalString` with the range the target field requires. No
 * JavaScript number ever touches an economic value (§7.3, ADR-001 §7).
 *
 * OUT-OF-RANGE IS A FAILURE, NEVER A CLAMP. ADR-002 §7: an out-of-range price
 * "is a typed adapter failure plus a `DataQualityIncidentOpened`, never a clamp
 * and never a silent drop". So this module returns a `FAILED` result rather than
 * substituting a representable value, and the feed turns that into an incident.
 *
 * VENUE TIME VS. RECEIPT TIME.
 *
 * - A trade carries two epochs: `T` ("Trade time") and `E` ("Event time").
 *   `venueTimestamp` is taken from **`T`**, because §7.1 describes it as the
 *   time the *source* supplies for the event and `T` is when the trade happened,
 *   while `E` is when Binance generated the message. Both survive on the decoded
 *   frame, so a consumer that wants the difference has it.
 * - A `bookTicker` payload carries **no timestamp at all** — the documented
 *   payload is exactly `u`, `s`, `b`, `B`, `a`, `A`. A top-of-book emission
 *   therefore has no `venueTimestamp`, and the receipt stamp is never copied
 *   into its place. Substituting the receipt time would manufacture a venue
 *   statement that does not exist, which §6 invariant 15 and ADR-002 §2.2 both
 *   forbid in substance ("A venue timestamp is data, not an order").
 */

import { tryNormalizeDecimalString } from "@polymarket-bot/decimal";
import {
  ReferenceTopOfBookChangedContract,
  ReferenceTradeObservedContract,
  type BookSide,
  type ReferenceTopOfBookChangedPayload,
  type ReferenceTradeObservedPayload,
} from "@polymarket-bot/domain";

import { BINANCE_EVENT_SOURCE } from "./emission.js";
import type { DecodedBookTickerFrame, DecodedTradeFrame } from "./frames.js";
import { venueEpochToIso } from "./time.js";
import type { BinanceTimeUnit } from "./venue.js";

export { ReferenceTopOfBookChangedContract, ReferenceTradeObservedContract };

/**
 * How (or whether) the venue's `m` flag becomes the domain's `takerSide`.
 *
 * THE AMBIGUITY IS REAL AND IS NOT THIS PACKAGE'S TO RESOLVE (`BNC-U5`). Binance
 * documents `m` as "Is the buyer the market maker?". The frozen contract
 * documents `takerSide` as "Taker side when the venue reports it" and says
 * nothing more; `BookSide` is `BID | ASK`. Two readings are equally available
 * and they map `m` to OPPOSITE values:
 *
 * - `BOOK_SIDE_CONSUMED` — the side of the book the taker removed liquidity
 *   from. `m = true` means the buyer was the maker, so the taker was the seller,
 *   so the taker hit the **bid**.
 * - `TAKER_ORDER_DIRECTION` — the direction of the taker's own order expressed
 *   as a book side. `m = true` means the taker was selling, which is an **ask**.
 *
 * `OMIT` is the default. `takerSide` is optional in the contract, and ADR-002 §6
 * settles the precedent for exactly this situation: "a producer that cannot
 * supply them must omit them rather than guess." The raw `buyerIsMaker` boolean
 * is preserved on the decoded frame either way, so nothing is lost — the fact
 * simply does not cross the boundary under an invented interpretation. A caller
 * that owns the ruling opts into a named convention and thereby records which
 * one it meant.
 */
export const TAKER_SIDE_CONVENTIONS = [
  "OMIT",
  "BOOK_SIDE_CONSUMED",
  "TAKER_ORDER_DIRECTION",
] as const;
export type TakerSideConvention = (typeof TAKER_SIDE_CONVENTIONS)[number];

/** Context a normalization needs from the connection. */
export type NormalizationContext = {
  /** The unit the connection was opened with; nothing in a frame states it. */
  readonly timeUnit: BinanceTimeUnit;
  readonly takerSideConvention: TakerSideConvention;
};

/** One value that could not be represented at the domain boundary. */
export type NormalizationFailure = {
  readonly field: string;
  readonly rawValue: string;
  readonly detail: string;
};

export type NormalizedTrade = {
  readonly ok: true;
  readonly payload: ReferenceTradeObservedPayload;
  /** From `T`, converted with the connection's declared unit. */
  readonly venueTimestamp: string;
};

export type NormalizedTopOfBook = {
  readonly ok: true;
  readonly payload: ReferenceTopOfBookChangedPayload;
  /** Always absent: `bookTicker` carries no venue timestamp. */
  readonly venueTimestamp: undefined;
  /**
   * Sides the venue reported but that could not cross the boundary.
   *
   * Non-empty means the emission is partial: the representable side was kept and
   * this records exactly what was left out, so a partial event is never mistaken
   * for a complete one.
   */
  readonly omittedSides: readonly NormalizationFailure[];
};

export type NormalizationRejected = {
  readonly ok: false;
  readonly failures: readonly NormalizationFailure[];
};

/**
 * `<symbol>@trade` → `ReferenceTradeObserved`.
 *
 * The domain payload requires a POSITIVE price and a POSITIVE size, so a
 * zero-or-negative value is a rejection rather than an event. That constraint is
 * the contract's, and ADR-001's Consequences state the intent plainly: "the
 * adapter fails loudly rather than clamping".
 */
export function normalizeTrade(
  frame: DecodedTradeFrame,
  context: NormalizationContext,
): NormalizedTrade | NormalizationRejected {
  const failures: NormalizationFailure[] = [];

  const price = tryNormalizeDecimalString(frame.priceRaw, { range: "POSITIVE" });
  if (!price.ok) {
    failures.push({ field: "p", rawValue: frame.priceRaw, detail: price.message });
  }
  const size = tryNormalizeDecimalString(frame.quantityRaw, { range: "POSITIVE" });
  if (!size.ok) {
    failures.push({ field: "q", rawValue: frame.quantityRaw, detail: size.message });
  }

  let venueTimestamp: string | undefined;
  try {
    venueTimestamp = venueEpochToIso(frame.tradeTimeEpoch, context.timeUnit);
  } catch (error: unknown) {
    failures.push({
      field: "T",
      rawValue: String(frame.tradeTimeEpoch),
      detail: error instanceof Error ? error.message : "venue timestamp conversion failed",
    });
  }

  if (!price.ok || !size.ok || venueTimestamp === undefined) {
    return { ok: false, failures };
  }

  const takerSide = takerSideFor(frame.buyerIsMaker, context.takerSideConvention);
  const payload: ReferenceTradeObservedPayload = {
    venue: BINANCE_EVENT_SOURCE,
    symbol: frame.symbol,
    price: price.value,
    size: size.value,
    ...(takerSide === undefined ? {} : { takerSide }),
    venueTradeId: String(frame.tradeId),
  };

  return { ok: true, payload, venueTimestamp };
}

/**
 * `<symbol>@bookTicker` → `ReferenceTopOfBookChanged`.
 *
 * PER-SIDE, ON PURPOSE. The contract types `bidPrice`/`askPrice` as strictly
 * positive and every field as optional, and the venue does not document how it
 * spells an empty side (`BNC-U4`). Mapping a non-positive price to *absent*
 * would be the mirror of the mistake ADR-001 §8.1 names — "an absent best bid is
 * not a zero best bid" — so a non-representable side is recorded as an omission
 * with its raw value, not quietly turned into "no bid". A frame in which neither
 * side is representable produces no event at all and is reported as a rejection.
 */
export function normalizeBookTicker(
  frame: DecodedBookTickerFrame,
): NormalizedTopOfBook | NormalizationRejected {
  const omitted: NormalizationFailure[] = [];

  const bidPrice = tryNormalizeDecimalString(frame.bidPriceRaw, { range: "POSITIVE" });
  const bidSize = tryNormalizeDecimalString(frame.bidQuantityRaw, { range: "NON_NEGATIVE" });
  const askPrice = tryNormalizeDecimalString(frame.askPriceRaw, { range: "POSITIVE" });
  const askSize = tryNormalizeDecimalString(frame.askQuantityRaw, { range: "NON_NEGATIVE" });

  const bidUsable = bidPrice.ok && bidSize.ok;
  const askUsable = askPrice.ok && askSize.ok;

  if (!bidUsable) {
    omitted.push({
      field: "b/B",
      rawValue: `${frame.bidPriceRaw}/${frame.bidQuantityRaw}`,
      detail: bidPrice.ok
        ? (bidSize.ok ? "unreachable" : bidSize.message)
        : bidPrice.message,
    });
  }
  if (!askUsable) {
    omitted.push({
      field: "a/A",
      rawValue: `${frame.askPriceRaw}/${frame.askQuantityRaw}`,
      detail: askPrice.ok
        ? (askSize.ok ? "unreachable" : askSize.message)
        : askPrice.message,
    });
  }

  if (!bidUsable && !askUsable) {
    return { ok: false, failures: omitted };
  }

  const payload: ReferenceTopOfBookChangedPayload = {
    venue: BINANCE_EVENT_SOURCE,
    symbol: frame.symbol,
    ...(bidUsable && bidPrice.ok && bidSize.ok
      ? { bidPrice: bidPrice.value, bidSize: bidSize.value }
      : {}),
    ...(askUsable && askPrice.ok && askSize.ok
      ? { askPrice: askPrice.value, askSize: askSize.value }
      : {}),
  };

  return { ok: true, payload, venueTimestamp: undefined, omittedSides: omitted };
}

/** Applies the caller's declared {@link TakerSideConvention} to Binance's `m`. */
export function takerSideFor(
  buyerIsMaker: boolean,
  convention: TakerSideConvention,
): BookSide | undefined {
  switch (convention) {
    case "OMIT":
      return undefined;
    case "BOOK_SIDE_CONSUMED":
      // buyer is maker → taker sold into the resting bid.
      return buyerIsMaker ? "BID" : "ASK";
    case "TAKER_ORDER_DIRECTION":
      // buyer is maker → the taker's own order was a sell, i.e. an ask.
      return buyerIsMaker ? "ASK" : "BID";
  }
}
