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

/** Context a normalization needs from the connection. */
export type NormalizationContext = {
  /** The unit the connection was opened with; nothing in a frame states it. */
  readonly timeUnit: BinanceTimeUnit;
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

  const payload: ReferenceTradeObservedPayload = {
    venue: BINANCE_EVENT_SOURCE,
    symbol: frame.symbol,
    price: price.value,
    size: size.value,
    // Always present, never configured: see {@link takerSideFor} (ADR-014).
    takerSide: takerSideFor(frame.buyerIsMaker),
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

/**
 * Binance's documented `m` flag → the domain's `takerSide`, under ADR-014.
 *
 * THE VOCABULARY IS RULED, NOT CHOSEN HERE. ADR-014 ("`takerSide` names the
 * aggressor order's own side", Accepted 2026-08-28) §1 fixes the meaning of the
 * frozen field: "**`BID`** ⇔ **the taker was buying.**" and "**`ASK`** ⇔ **the
 * taker was selling.**" §2 states the rejected reading separately, because the
 * two are exact inverses and a reader who assumes the other one gets every sign
 * backwards: "A **buying** taker consumes resting **asks** and is still recorded
 * as **`BID`**. A **selling** taker hits resting **bids** and is still recorded
 * as **`ASK`**."
 *
 * THE VENUE FIELD. `WS_STREAMS` documents `m` as "Is the buyer the market
 * maker?", and ADR-014 §3's Binance row derives this mapping from that one
 * sentence: "`m = true → ASK` (the buyer was the maker, so the taker was the
 * **seller**); `m = false → BID`". This function is that row and nothing else.
 *
 * WHY IT IS ALWAYS EMITTED. ADR-014's §7 follow-up item 3 required this package
 * to decide AND state whether the default becomes the mapping or stays `OMIT`;
 * it decided emission. `m` is documented on every `<symbol>@trade` payload, so
 * the aggressor's role is always reported and never inferred: ADR-002 §6 ("a
 * producer that cannot supply them must omit them rather than guess") — the rule
 * that kept this field absent while `BNC-U5` was open — no longer applies to it.
 * The mapping is therefore
 * the adapter's behavior, not an option, and this function is total.
 *
 * WHY THERE IS NO SELECTABLE CONVENTION ANY MORE. The shipped
 * `BOOK_SIDE_CONSUMED` reading (`m = true → BID`) emits the inverse of the ruled
 * meaning, which ADR-014 §4.3 calls "a contract violation, not a configuration
 * choice"; the §7 follow-up's item 2 therefore requires its removal rather than
 * its demotion to a non-default, "one configuration flag away". `BNC-U5` is
 * closed by that ruling — see `BINANCE_RESOLVED` in `./venue.ts`.
 *
 * The venue's own boolean is untouched by any of this: `buyerIsMaker` survives
 * verbatim on the decoded frame (`./frames.ts`), so a consumer can read the raw
 * fact without re-deriving it from the mapped side.
 */
export function takerSideFor(buyerIsMaker: boolean): BookSide {
  // ADR-014 §3: the buyer being the maker means the TAKER was the seller.
  return buyerIsMaker ? "ASK" : "BID";
}
