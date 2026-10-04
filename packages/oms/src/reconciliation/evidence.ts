/**
 * The EVIDENCE STORE (WP-290 r6): the ONE choke point of "evidence forgetting" (class A of rounds 2 to 6).
 *
 * WHAT IT HOLDS. Every VALIDATED venue observation, from EVERY source, whatever the run's soundness or the
 * answer's completeness, recorded BEFORE anything is classified:
 *
 * | Source (code) | Provenance | What it records |
 * | --- | --- | --- |
 * | `OPEN_ORDERS_LIST` | SHOWN | a row of a complete open-orders list: the order's facts, matched size, status |
 * | `OPEN_ORDERS_ROW` | SHOWN | a row that validated in full inside a partial, malformed or duplicated answer |
 * | `OPEN_ORDERS_ID` | NAMED | the id alone of a malformed row (nothing else of it validated) |
 * | `TRADES_LEG` | SHOWN | an own leg of a trade in a valid trades read: the trade, its shares, its status |
 * | `TRADES_LEG_SALVAGED` | SHOWN | an own leg that validated in full inside an unusable trades answer |
 * | `TRADES_LEG_UNKEYED` | SHOWN | the same, when its trade's own id did not validate: the order matched at least its shares (r10: at least the shares of every trade known on it, plus its answer's unkeyed legs'); and (r10) an UNKEYED_LEG record of a WHOLE answer: the leg's every fill fact, and how many such legs its answer showed |
 * | `TRADES_LEG_UNKEYED_PARTIAL` | SHOWN | (r10) the same UNKEYED_LEG record, from an answer that was not whole (partial, or a row of it not identified): no read can ever answer it |
 * | `TRADES_LEG_ID` | NAMED | the id alone of a malformed leg |
 * | `TRADES_ROW` | SHOWN | (r9) a TRADE record: a trade row that validated in full, its ownership determined (its own legs exactly) |
 * | `TRADES_ROW_PARTIAL` | SHOWN | (r9) a TRADE record: a trade row that validated in full, its ownership undetermined (no own leg, possibly) |
 * | `TRADES_ROW_ID` | NAMED | (r9) a TRADE record: the trade id (and status, when text) of a row that did not validate in full |
 * | `BY_ID` | SHOWN | a by-id read that found the order |
 * | `BY_ID_ROW` | SHOWN | (r10) an order row that validated in full inside an unusable by-id answer (not found, found unsaid, another order's): under the row's OWN id |
 * | `BY_ID_ID` | NAMED | (r10) the id alone of an invalid order row of an unusable by-id answer |
 * | `OMS_RETAINED` | NAMED | a venue order id the OMS retains as user-stream evidence |
 * | `STREAM_ORDER`, `STREAM_FILL`, `STREAM_SETTLEMENT` | NAMED | what the user stream reported, as routed to the OMS |
 *
 * Per venue order: whether any source SHOWED it, EVERY value any observation showed of each of its fixed facts
 * (token, side, price, original size: r7), the HIGH-WATER matched size (the most any order observation showed, and
 * at least the sum of every distinct trade's leg on it), whether any observation showed it TERMINAL, every status
 * seen. Per venue trade: its legs, each with EVERY value any observation showed of each of its fill facts (shares,
 * price, fee, fee asset, liquidity role, match time, token, side: r7), the furthest settlement status seen, EVERY
 * terminal settlement status any observation showed (CONFIRMED, FAILED: r8), from a leg or (r9) from a TRADE record (a
 * row with no own leg, or a malformed row, shows its trade's status all the same), and (r9) whether an observation
 * carried the trade without identifying all of its own legs, and whether a valid row ever showed it with them. The
 * marks are MONOTONIC and move on validated evidence from ANY run: an unsound, stale or unusable run's observations
 * count as much as a sound run's (r6, WP290-CX-R6-01). What this rests on (a matched size never decreases, a terminal
 * order is never live again, a trade id is not replaced, an order's and a fill's facts never change for one id) is an
 * UNVERIFIED venue assumption held as a conservative policy: no venue document states it (E-14 says only that a by-id
 * read finds canceled and fully matched orders), so a read that disagrees is held as wrong, never taken as a
 * correction (runbook §10, with the FAILED-trade case).
 *
 * DURABLE. The coordinator journals every informative record (`EVIDENCE_RECORDED`) and rebuilds this store
 * from the journal at every run ({@link EvidenceStore.fold}), so a restart forgets nothing (a record whose
 * append failed is kept in memory and appended again).
 *
 * THE RULES (the coordinator asks only {@link EvidenceStore.judge}, its ONE query):
 * - every venue order with any evidence is READ BY ID in every run until a SOUND run classifies it
 *   consistently with ALL of its evidence (a `SETTLED` record at its current level); new evidence about it
 *   makes it unsettled again;
 * - a read that shows LESS than the evidence (a matched size below the high-water mark, live after terminal,
 *   a settlement backwards, a trade or leg an earlier read showed now missing) is a CONFLICT: it can never
 *   resolve, answer, or fix a final size below the evidence; it only holds;
 * - a by-id read that does not find an unclaimed order a source SHOWED is a CONFLICT (E-14: canceled and
 *   fully matched orders are found by id); one only NAMED is a GHOST (it could be any attempt's: no
 *   signed-identity answer is given while it stands, and it is a releasable quarantine), or, once an
 *   operator released that quarantine and nothing new arrived since, ACKNOWLEDGED;
 * - a claimed order (the OMS tracks it) that its by-id read does not find is MISSING: the OMS's comparison
 *   holds it (`ORDER_STATE_MISMATCH`), and nothing is answered from it;
 * - (r7, WP290-CX-R7-01 and R7-02) a fixed fact of an order, or a fill fact of a trade's leg, that two observations
 *   showed with DIFFERENT values is a DURABLE CONTRADICTION: the order (or trade) is a CONFLICT in every run from
 *   then on, whatever a later read shows, so nothing is answered (no signed-identity resolution either), compared,
 *   delivered, resolved or resumed from it. Filling in a value no observation showed yet is not a contradiction;
 *   a value is compared by what it means (decimals by value, a match time as an instant: `sameInstantText`);
 * - (r7, WP290-CX-R7-03; r8, WP290-CX-R8-01) EVERY trade identity in the evidence carries a classification
 *   obligation: a trade that a complete trades read does not show is a CONFLICT while an unresolved break names it
 *   (`TradeReads.held`) or any of its legs is not ACCOUNTED FOR under the trade's own identity (the coordinator
 *   decides, leg by leg: `TradeReads.accounted`). That includes a trade only the user stream NAMED (a fill or a
 *   settlement the OMS did not apply): no read has shown it, so nothing else (a claimed order, an order's matched
 *   size covered by other trades) answers it. A leg the stream named on a trade a read shows is a CONFLICT too
 *   while the read does not show that leg and it is not accounted for;
 * - (r8, WP290-CX-R8-02) a trade that observations showed both CONFIRMED and FAILED, from any source and any run
 *   (a valid row of an unusable answer, an unapplied stream item and, r9, WP290-V9-UNFOLDED-TERMINAL, a row that
 *   showed no own leg of it, or a malformed row, included), is a DURABLE CONTRADICTION: both are terminal
 *   (`states.ts`: either order is a conflict), so no later read ends it. Normal forward progress (MATCHED, MINED,
 *   RETRYING, then one terminal status) never is;
 * - (r9, WP290-CX-R9-01) a trade an observation carried WITHOUT identifying all of its own legs (a valid row whose
 *   ownership is undetermined, legless or not; a malformed row whose trade id is readable), that no valid row has
 *   shown with its ownership determined, is OPEN: a complete trades read that omits it is a CONFLICT, whatever the
 *   accounting of the legs the evidence holds (its legs are unknown). Nothing of a malformed row but its trade id and
 *   status is kept, so no malformed economics is ever compared or booked;
 * - (r7) an order a trade names (any leg, its shares known or not) matched something: a read showing nothing
 *   matched is a CONFLICT;
 * - (r10, WP290-V10-UNKEYED-LEG-DISCHARGED) an own leg a trades read showed in full in a row whose TRADE ID was
 *   unreadable is a leg of a trade the evidence may not know. Its record (UNKEYED_LEG) carries every fill fact and how
 *   many such legs of exactly those facts its answer showed on the order. An unkeyed row may be any trade the
 *   evidence already held (its answer's other rows, folded first, and every trade any source named before, a lagging
 *   read's or the stream's included), or a new one: fail closed, it is a new one. So the order is a CONFLICT, in every
 *   run, until the reads have SHOWN, each under a readable trade id with a leg of exactly those facts on the order,
 *   that many distinct trades the evidence did NOT hold when the unkeyed leg was seen (the store's fold order, journal
 *   order: replayed the same). Only then is the activity accounted for under trade identities, each one durable (its
 *   shares in the order's high-water mark, its own classification obligation). That is sound only for a WHOLE answer
 *   (complete, every row identified): every trade of that time is in it, keyed (so held) or unkeyed, so a trade first
 *   shown later by a lagging read is the unkeyed one (the r7 assumption: the trades read keeps every trade not yet
 *   accounted for). An answer that is NOT whole may have left out a trade of exactly the same facts that no observation
 *   knew, which a lagging read could show in the unkeyed one's place: its unkeyed leg (`TRADES_LEG_UNKEYED_PARTIAL`)
 *   is never answered, and its order holds for good (fail closed; an operator path needs the retraction ADR).
 *   Keeping the order's matched lower bound is not enough (a leg no larger than what the order already showed adds
 *   nothing to it: the coordinator now records the known trades' shares PLUS the unkeyed legs'), and no economics of
 *   an unkeyed leg is ever booked;
 *
 * Pure: no I/O, no clock, no randomness. Exact decimal strings throughout.
 */

import { addDecimal, compareDecimal, isCanonicalDecimalString, type DecimalString } from "@polymarket-bot/decimal";

import { isIdentifier, isTokenId, readArray, readFields } from "../guards.js";
import { isLegalSettlementTransition } from "../states.js";

import { isIsoInstant, orderStatusOf, tradeStatusOf } from "./door.js";
import type { VenueOrderView, VenueTradeLeg, VenueTradeStatus, VenueTradeView } from "./ports.js";
import { sameInstantText } from "./time.js";

export type EvidenceKind = "ORDER" | "LEG" | "TRADE" | "UNKEYED_LEG" | "SETTLED";
export type EvidenceProvenance = "SHOWN" | "NAMED";

export const EVIDENCE_SOURCES = [
  "OPEN_ORDERS_LIST",
  "OPEN_ORDERS_ROW",
  "OPEN_ORDERS_ID",
  "TRADES_LEG",
  "TRADES_LEG_SALVAGED",
  "TRADES_LEG_UNKEYED",
  "TRADES_LEG_UNKEYED_PARTIAL",
  "TRADES_LEG_ID",
  "TRADES_ROW",
  "TRADES_ROW_PARTIAL",
  "TRADES_ROW_ID",
  "BY_ID",
  "BY_ID_ROW",
  "BY_ID_ID",
  "OMS_RETAINED",
  "STREAM_ORDER",
  "STREAM_FILL",
  "STREAM_SETTLEMENT",
  "SOUND_RUN",
  "OPERATOR_RELEASE",
] as const;
export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number];

/**
 * (r9, WP290-CX-R9-01 and WP290-V9-UNFOLDED-TERMINAL) The sources of a TRADE record, one per trade row a trades read
 * carried, whatever its legs and whatever the answer's completeness:
 * - `TRADES_ROW` (SHOWN): the row validated in full and its ownership is determined: its own legs are exactly those it
 *   showed (each its own LEG record);
 * - `TRADES_ROW_PARTIAL` (SHOWN): the row validated in full, but its ownership is undetermined: it may not show (or
 *   show none of) the account's own legs;
 * - `TRADES_ROW_ID` (NAMED): the trade id of a row that did not validate in full, with its status when that is text.
 */
export const TRADE_SOURCES = ["TRADES_ROW", "TRADES_ROW_PARTIAL", "TRADES_ROW_ID"] as const;
export type TradeSource = (typeof TRADE_SOURCES)[number];

/** One record (the journal's `EVIDENCE_RECORDED` without its run, time and position). */
export interface EvidenceRecord {
  readonly evidenceKind: EvidenceKind;
  /** The venue order (`null` only for a TRADE record, r9: a trade identity, whatever its legs). */
  readonly venueOrderId: string | null;
  /** LEG and TRADE: the venue trade. */
  readonly venueTradeId: string | null;
  readonly provenance: EvidenceProvenance;
  readonly source: EvidenceSource;
  readonly tokenId: string | null;
  readonly side: "BUY" | "SELL" | null;
  readonly price: DecimalString | null;
  readonly originalSize: DecimalString | null;
  /** ORDER: the matched size shown (`TRADES_LEG_UNKEYED`: a lower bound); LEG and UNKEYED_LEG: the leg's shares. */
  readonly size: DecimalString | null;
  readonly status: string | null;
  /**
   * SETTLED: the level it covers. (r10) UNKEYED_LEG: how many unkeyed legs of exactly its fill facts its answer showed
   * on its order (at least one).
   */
  readonly level: number | null;
  /** LEG and (r10) UNKEYED_LEG only (r7, WP290-CX-R7-02): the leg's exact fee, when the observation fixed it. */
  readonly feeAmount: DecimalString | null;
  /** LEG and UNKEYED_LEG only: the asset the fee is charged in. */
  readonly feeAssetId: string | null;
  /** LEG and UNKEYED_LEG only: the leg's liquidity role. */
  readonly role: "MAKER" | "TAKER" | null;
  /** LEG and UNKEYED_LEG only: the match time (ISO-8601). */
  readonly matchedAt: string | null;
}

const TERMINAL_SETTLEMENTS: readonly VenueTradeStatus[] = ["CONFIRMED", "FAILED"];

/** The most distinct statuses or sources kept per order (detail only; nothing is decided on the count). */
const MAX_TEXTS = 16;
/**
 * The most distinct values kept per fact (r7). Two values already make a durable contradiction; the rest are kept
 * for the operator's detail only, so nothing is decided on the count.
 */
const MAX_VALUES = 8;

/** An order's fixed facts (r7, WP290-CX-R7-01): never change for one venue order. */
const ORDER_FACTS = ["tokenId", "side", "price", "originalSize"] as const;
type OrderFact = (typeof ORDER_FACTS)[number];
/** A trade leg's fill facts (r7, WP290-CX-R7-02): never change for one (trade, order) fill. */
const LEG_FACTS = ["shares", "price", "feeAmount", "feeAssetId", "role", "matchedAt", "tokenId", "side"] as const;
export type LegFact = (typeof LEG_FACTS)[number];
const DECIMAL_FACTS: readonly string[] = ["price", "originalSize", "shares", "feeAmount"];

/** Whether two values of one fact are the same value: decimals by value, a match time as an instant, text exactly. */
function sameValue(fact: string, a: string, b: string): boolean {
  if (DECIMAL_FACTS.includes(fact)) return compareDecimal(a, b) === 0;
  if (fact === "matchedAt") return sameInstantText(a, b);
  return a === b;
}

/** Add a value to a fact's distinct values (in the order first shown); `true` when it is new information. */
function pushValue(fact: string, values: string[], value: string | null): boolean {
  if (value === null || values.some((known) => sameValue(fact, known, value)) || values.length >= MAX_VALUES) return false;
  values.push(value);
  return true;
}

/** One fill's facts, each `null` when the observation did not fix it (an UNKEYED_LEG's are those of a valid leg). */
export type FillFacts = Readonly<Record<LegFact, string | null>>;

/** Two fills' facts are the same fill's facts: every fact the same value (decimals by value, a time as an instant), or unfixed in both. */
function sameFill(a: FillFacts, b: FillFacts): boolean {
  return LEG_FACTS.every((fact) => {
    const x = a[fact];
    const y = b[fact];
    return x === null || y === null ? x === y : sameValue(fact, x, y);
  });
}

/**
 * (r10) Whether a leg the evidence holds SHOWS exactly these fill facts: shown in full by a read (with its trade's
 * readable id), and every fact with exactly one value, the same (a fact the facts leave unfixed: none shown). A leg
 * whose facts were shown two ways (a durable contradiction of its own) is never one.
 */
function showsFacts(leg: LegEntry, facts: FillFacts): boolean {
  if (!leg.shown) return false;
  return LEG_FACTS.every((fact) => {
    const values = leg.facts[fact];
    const value = facts[fact];
    if (value === null) return values.length === 0;
    const only = values[0];
    return values.length === 1 && only !== undefined && sameValue(fact, only, value);
  });
}

function factsOf(record: EvidenceRecord): FillFacts {
  return {
    shares: record.size,
    price: record.price,
    feeAmount: record.feeAmount,
    feeAssetId: record.feeAssetId,
    role: record.role,
    matchedAt: record.matchedAt,
    tokenId: record.tokenId,
    side: record.side,
  };
}

function describeFill(facts: FillFacts): string {
  return `${facts.side ?? "?"} ${facts.shares ?? "?"} at ${facts.price ?? "?"}, fee ${facts.feeAmount ?? "unfixed"}${facts.feeAssetId === null ? "" : ` in ${facts.feeAssetId}`}, ${facts.role ?? "?"}, matched ${facts.matchedAt ?? "?"}`;
}

/** "price 0.5 / 0.6"-style texts for every fact shown with more than one value. */
function contradictionsOf(facts: Readonly<Record<string, readonly string[]>>, names: readonly string[]): string[] {
  return names.filter((name) => (facts[name]?.length ?? 0) > 1).map((name) => `${name} ${(facts[name] ?? []).join(" / ")}`);
}

interface OrderEntry {
  shown: boolean;
  sources: string[];
  /** Every value shown of each fixed fact, in the order first shown (two or more: a durable contradiction). */
  facts: Record<OrderFact, string[]>;
  /** The most an ORDER observation showed matched (`null`: none showed a matched size). */
  observedMatched: DecimalString | null;
  /** An observation showed it terminal (CANCELED, or fully matched). */
  terminal: boolean;
  statuses: string[];
  /** Informative records folded (ORDER and LEG): new evidence raises it. */
  level: number;
  /** The level a SETTLED record covers (-1: never settled). */
  settledLevel: number;
  /**
   * (r10, WP290-V10-UNKEYED-LEG-DISCHARGED) Every UNKEYED_LEG observation on this order that owes something new: the
   * fill's facts, how many such unkeyed legs its answer showed (`need`), and how many trades the evidence then held
   * (`before`: the first `before` trades of the store's fold order, on any order or none, which can never answer it).
   * Never bounded: each is decided on.
   */
  unkeyed: { readonly facts: FillFacts; readonly need: number; readonly before: number; readonly partial: boolean }[];
}

interface LegEntry {
  /** The most shares any observation showed (the leg's part of its order's high-water matched size). */
  shares: DecimalString | null;
  /** Every value shown of each fill fact, in the order first shown (two or more: a durable contradiction). */
  facts: Record<LegFact, string[]>;
  shown: boolean;
}

interface TradeEntry {
  shown: boolean;
  legs: Map<string, LegEntry>;
  /** The furthest settlement status seen (moved only by a legal forward transition). */
  status: VenueTradeStatus | null;
  statuses: string[];
  /**
   * (r8) Every TERMINAL settlement status any observation showed (CONFIRMED, FAILED), in the order first shown; kept
   * apart from `statuses` (whose length is bounded) so a terminal status is never dropped. Both: a durable contradiction.
   */
  terminals: VenueTradeStatus[];
  /**
   * (r9, WP290-CX-R9-01) An observation carried the trade WITHOUT identifying all of its own legs: a valid row whose
   * ownership is undetermined (`TRADES_ROW_PARTIAL`), or a row that did not validate in full (`TRADES_ROW_ID`).
   */
  legsUnidentified: boolean;
  /** (r9) A valid row with its ownership determined showed the trade (`TRADES_ROW`): its own legs are known in full. */
  legsInFull: boolean;
  /** The sources that carried it (detail only; nothing is decided on the list, whose length is bounded). */
  sources: string[];
}

/** What the store knows of one venue order (frozen). */
export interface OrderEvidence {
  readonly venueOrderId: string;
  readonly shown: boolean;
  readonly sources: readonly string[];
  readonly tokenId: string | null;
  readonly side: "BUY" | "SELL" | null;
  /** The high-water matched size: the most any order observation showed, and at least the sum of its trades' legs. */
  readonly matchedHigh: DecimalString;
  readonly observedMatched: DecimalString | null;
  readonly legSum: DecimalString;
  readonly terminal: boolean;
  readonly statuses: readonly string[];
  readonly level: number;
  readonly settled: boolean;
  /** The fixed facts two observations showed with different values (r7): a durable contradiction when not empty. */
  readonly contradictions: readonly string[];
  /** Distinct trades with a leg on it (any source; a leg's shares known or not). */
  readonly tradeCount: number;
}

/** What the store knows of one leg of one venue trade (frozen). */
export interface LegEvidence {
  readonly venueOrderId: string;
  readonly shown: boolean;
  readonly shares: DecimalString | null;
  readonly tokenId: string | null;
  readonly side: "BUY" | "SELL" | null;
  readonly price: DecimalString | null;
  /** The fill facts two observations showed with different values (r7): a durable contradiction when not empty. */
  readonly contradictions: readonly string[];
}

/** What the store knows of one venue trade (frozen). */
export interface TradeEvidence {
  readonly venueTradeId: string;
  /** A read SHOWED it (a leg of a valid trades read, or one that validated in full inside an unusable answer). */
  readonly shown: boolean;
  readonly status: VenueTradeStatus | null;
  /** (r8) Every terminal settlement status any observation showed: both CONFIRMED and FAILED is a durable contradiction. */
  readonly terminals: readonly VenueTradeStatus[];
  /**
   * (r9, WP290-CX-R9-01) An observation carried the trade without identifying all of its own legs (its ownership
   * undetermined, or its row malformed), and no valid row has shown it with its ownership determined: its identity is
   * not answered, so no omission discharges it.
   */
  readonly identityOpen: boolean;
  readonly sources: readonly string[];
  readonly legs: readonly LegEvidence[];
}

/** This run's reads of one venue order, as the coordinator assembled them (see {@link EvidenceStore.judge}). */
export interface OrderReads {
  /** An OMS order or attempt tracks this venue order id. */
  readonly claimed: boolean;
  /** Its row in this run's complete open-orders list. */
  readonly listed: VenueOrderView | undefined;
  /** This run's by-id answer: the order, `null` (answered: not found), or `undefined` (not asked, or the read failed). */
  readonly byId: VenueOrderView | null | undefined;
  /** This run's own legs on it (a valid trades read). */
  readonly legs: readonly VenueTradeLeg[];
}

/** This run's reads of one venue trade. */
export interface TradeReads {
  /** The trades read answered in its shape, completely. */
  readonly tradesOk: boolean;
  /** The trade as that read showed it (`undefined`: not in the read). */
  readonly shown: VenueTradeView | undefined;
  /**
   * (r7) An unresolved break that holds names the trade (a read problem keyed by it, or `SETTLEMENT_REVERSAL_OWED`):
   * a hold about it is judged until a read shows it consistent, so its absence from a complete read is a CONFLICT.
   */
  readonly held: boolean;
  /**
   * (r7, WP290-CX-R7-03; r8, WP290-CX-R8-01) Whether one leg of the trade is ACCOUNTED FOR under the trade's own
   * identity (the coordinator decides, from the journal and this run's reads). Only a trade whose every leg is
   * accounted for, and that is not held, may be absent from a complete trades read without a CONFLICT; and only an
   * accounted leg the user stream named may be absent from a read that shows its trade.
   */
  readonly accounted: (leg: LegEvidence) => boolean;
}

export interface EvidenceProblem {
  readonly breakClass: "READ_CONFLICT" | "READ_REGRESSION" | "STATUS_UNRECOGNISED" | "READ_INCOMPLETE";
  readonly detail: string;
  readonly expected: DecimalString | null;
  readonly observed: DecimalString | null;
}

export type OrderVerdict =
  /** Read this run, and consistent with every observation of this run and with ALL its evidence. */
  | { readonly kind: "CONSISTENT"; readonly order: VenueOrderView }
  /** This run's reads contradict each other or the evidence: nothing about it is concluded (a hold). */
  | { readonly kind: "CONFLICT"; readonly problems: readonly EvidenceProblem[] }
  /** Only NAMED, unclaimed, not found by id, not settled: it could be any attempt's. */
  | { readonly kind: "GHOST" }
  /** The same, after an operator released its quarantine, with nothing new since. */
  | { readonly kind: "ACKNOWLEDGED" }
  /** Not found by id: a claimed order (the OMS's to judge), or an id with no evidence at all. */
  | { readonly kind: "MISSING" }
  /** Nothing this run answered about it. */
  | { readonly kind: "UNREAD" };

export type TradeVerdict =
  | { readonly kind: "CONSISTENT"; readonly status: VenueTradeStatus }
  | { readonly kind: "CONFLICT"; readonly problems: readonly EvidenceProblem[] }
  | { readonly kind: "UNREAD" };

function venueTerminal(order: VenueOrderView): boolean {
  return order.status === "CANCELED" || compareDecimal(order.sizeMatched, order.originalSize) === 0;
}

function maxDecimal(a: DecimalString | null, b: DecimalString | null): DecimalString | null {
  if (a === null) return b;
  if (b === null) return a;
  return compareDecimal(a, b) >= 0 ? a : b;
}

function pushText(list: string[], text: string): boolean {
  if (list.includes(text) || list.length >= MAX_TEXTS) return false;
  list.push(text);
  return true;
}

function sameFixedFacts(a: VenueOrderView, b: VenueOrderView): boolean {
  return a.tokenId === b.tokenId && a.side === b.side && compareDecimal(a.price, b.price) === 0 && compareDecimal(a.originalSize, b.originalSize) === 0;
}

function problem(breakClass: EvidenceProblem["breakClass"], detail: string, expected: DecimalString | null = null, observed: DecimalString | null = null): EvidenceProblem {
  return Object.freeze({ breakClass, detail, expected, observed });
}

function cloneFacts<K extends string>(facts: Readonly<Record<K, readonly string[]>>): Record<K, string[]> {
  return Object.fromEntries(Object.entries(facts).map(([name, values]) => [name, [...(values as readonly string[])]])) as Record<K, string[]>;
}

function cloneOrders(orders: ReadonlyMap<string, OrderEntry>): Map<string, OrderEntry> {
  return new Map(
    [...orders].map(([id, entry]) => [
      id,
      {
        ...entry,
        sources: [...entry.sources],
        statuses: [...entry.statuses],
        facts: cloneFacts(entry.facts),
        unkeyed: entry.unkeyed.map((fill) => ({ ...fill })),
      },
    ]),
  );
}

function cloneTrades(trades: ReadonlyMap<string, TradeEntry>): Map<string, TradeEntry> {
  return new Map(
    [...trades].map(([id, trade]) => [
      id,
      { ...trade, statuses: [...trade.statuses], terminals: [...trade.terminals], sources: [...trade.sources], legs: new Map([...trade.legs].map(([order, leg]) => [order, { ...leg, facts: cloneFacts(leg.facts) }])) },
    ]),
  );
}

function emptyFacts<K extends string>(names: readonly K[]): Record<K, string[]> {
  return Object.fromEntries(names.map((name) => [name, [] as string[]])) as Record<K, string[]>;
}

/** The sum over every distinct trade of its leg's shares on one order, and how many distinct trades have a leg on it. */
function legsOn(trades: ReadonlyMap<string, TradeEntry>, id: string): { readonly sum: DecimalString; readonly count: number } {
  let sum: DecimalString = "0";
  let count = 0;
  for (const trade of trades.values()) {
    const leg = trade.legs.get(id);
    if (leg === undefined) continue;
    count += 1;
    if (leg.shares !== null) sum = addDecimal(sum, leg.shares);
  }
  return { sum, count };
}

function first(values: readonly string[]): string | null {
  return values[0] ?? null;
}

function orderView(orders: ReadonlyMap<string, OrderEntry>, trades: ReadonlyMap<string, TradeEntry>, id: string): OrderEvidence | undefined {
  const entry = orders.get(id);
  if (entry === undefined) return undefined;
  const legs = legsOn(trades, id);
  return Object.freeze({
    venueOrderId: id,
    shown: entry.shown,
    sources: Object.freeze([...entry.sources]),
    tokenId: first(entry.facts.tokenId),
    side: first(entry.facts.side) as "BUY" | "SELL" | null,
    matchedHigh: maxDecimal(entry.observedMatched, legs.sum) ?? "0",
    observedMatched: entry.observedMatched,
    legSum: legs.sum,
    terminal: entry.terminal,
    statuses: Object.freeze([...entry.statuses]),
    level: entry.level,
    settled: entry.settledLevel >= entry.level,
    contradictions: Object.freeze(contradictionsOf(entry.facts, ORDER_FACTS)),
    tradeCount: legs.count,
  });
}

export class EvidenceStore {
  readonly #orders = new Map<string, OrderEntry>();
  readonly #trades = new Map<string, TradeEntry>();
  /**
   * (r10) Every trade the evidence holds, in the order it was first folded (journal order, so a rebuild makes the same
   * list): what the evidence held at any point of the fold, whatever the record (a leg, on any order; a trade identity).
   */
  readonly #tradeOrder: string[] = [];
  /** The evidence as it stood before this run's reads were folded in (`beginRun`): each observation is judged against it. */
  #baseline: { readonly orders: Map<string, OrderEntry>; readonly trades: Map<string, TradeEntry> } = { orders: new Map(), trades: new Map() };

  /**
   * Mark the start of a run's reads: every observation the run makes is judged on its own against the evidence as
   * it stands now (an earlier read's), and its latest view of an order against everything, this run's included.
   */
  beginRun(): void {
    this.#baseline = { orders: cloneOrders(this.#orders), trades: cloneTrades(this.#trades) };
  }

  /** A store folded from records in order (the journal's, then any kept in memory only). */
  static fold(records: readonly EvidenceRecord[]): EvidenceStore {
    const store = new EvidenceStore();
    for (const record of records) store.add(record);
    return store;
  }

  /**
   * Fold one record. Returns whether it added information (a new order or trade, a source SHOWING an order only
   * named so far, a fact value not shown before (a value newly known, or a CONTRADICTING one: r7), a higher matched
   * size or leg, terminality, a new status, a settlement covering more): only such a record needs journaling, and a
   * contradicting record is always journaled, so a restart folds the same contradiction again.
   */
  add(record: EvidenceRecord): boolean {
    // (r9) A trade identity, whatever its legs: it names no order.
    if (record.evidenceKind === "TRADE") return this.#addTrade(record);
    const venueOrderId = record.venueOrderId;
    // Unreachable through either door (only a TRADE record names no order); nothing is folded from it.
    if (venueOrderId === null) return false;
    if (record.evidenceKind === "SETTLED") {
      const entry = this.#orders.get(venueOrderId);
      if (entry === undefined || record.level === null || record.level <= entry.settledLevel) return false;
      entry.settledLevel = Math.min(record.level, entry.level);
      return true;
    }
    const entry = this.#orderEntry(venueOrderId);
    let informative = entry.created;
    const order = entry.entry;
    if (record.provenance === "SHOWN" && !order.shown) {
      order.shown = true;
      informative = true;
    }
    pushText(order.sources, record.source);
    // A leg's token and side are its order's: every record's are the order's fixed facts too (r7).
    if (pushValue("tokenId", order.facts.tokenId, record.tokenId)) informative = true;
    if (pushValue("side", order.facts.side, record.side)) informative = true;
    if (record.evidenceKind === "ORDER") {
      if (pushValue("price", order.facts.price, record.price)) informative = true;
      if (pushValue("originalSize", order.facts.originalSize, record.originalSize)) informative = true;
      const matched = maxDecimal(order.observedMatched, record.size);
      if (matched !== order.observedMatched) {
        order.observedMatched = matched;
        informative = true;
      }
      if (record.status !== null) {
        if (pushText(order.statuses, record.status)) informative = true;
        const terminal =
          record.status === "CANCELED" ||
          (record.size !== null && record.originalSize !== null && compareDecimal(record.size, record.originalSize) === 0 && record.source !== "TRADES_LEG_UNKEYED");
        if (terminal && !order.terminal) {
          order.terminal = true;
          informative = true;
        }
      }
    } else if (record.evidenceKind === "UNKEYED_LEG") {
      if (this.#addUnkeyed(order, record)) informative = true;
    } else if (record.venueTradeId !== null) {
      if (this.#addLeg(record, venueOrderId)) informative = true;
    }
    if (informative) order.level += 1;
    return informative;
  }

  /**
   * (r10, WP290-V10-UNKEYED-LEG-DISCHARGED) Fold one UNKEYED_LEG record: the fill it showed, how many unkeyed legs of
   * exactly those facts its answer showed (`level`), and how many trades the evidence holds NOW (they can never answer
   * it: the unkeyed row may be any of them). `true` when it owes something no earlier observation of the same fill
   * owes: a new fill, more legs, or a trade the evidence learned since. A repeated observation of the same answer, with
   * nothing learned between, owes nothing new (and is not journaled).
   */
  #addUnkeyed(order: OrderEntry, record: EvidenceRecord): boolean {
    const need = record.level;
    // Unreachable through either door (an UNKEYED_LEG owes at least one trade); nothing is folded from it.
    if (need === null || need < 1) return false;
    const facts = factsOf(record);
    const before = this.#tradeOrder.length;
    // (r10) One from an answer that was not whole is never answered: nothing about the same fill owes more than it.
    const partial = record.source === "TRADES_LEG_UNKEYED_PARTIAL";
    if (order.unkeyed.some((fill) => sameFill(fill.facts, facts) && (fill.partial || (!partial && fill.before === before && fill.need >= need)))) return false;
    order.unkeyed.push({ facts, need, before, partial });
    return true;
  }

  /**
   * (r10) The trades the evidence holds with a leg on `venueOrderId` that a read SHOWED in full, with a readable trade
   * id, and with exactly these fill facts (sorted): the only trades that can answer an unkeyed leg of those facts.
   */
  keyedTradesShowing(venueOrderId: string, facts: FillFacts): string[] {
    const out: string[] = [];
    for (const [tradeId, trade] of this.#trades) {
      const leg = trade.legs.get(venueOrderId);
      if (leg !== undefined && showsFacts(leg, facts)) out.push(tradeId);
    }
    return out.sort();
  }

  /**
   * (r10, WP290-V10-UNKEYED-LEG-DISCHARGED) Every unkeyed observation on one venue order whose obligation is not met:
   * the reads have shown, with a readable id and a leg of exactly its facts on the order, fewer trades the evidence did
   * not hold when it was made than it showed unkeyed legs. `known` lists, for the operator, the trades with a leg on the
   * order the evidence held then (they cannot answer it; neither can any other trade it held). Each is a CONFLICT of
   * the order in every run until it is met (`#judgeOrder`).
   */
  unaccountedUnkeyed(
    venueOrderId: string,
  ): { readonly facts: FillFacts; readonly need: number; readonly partial: boolean; readonly known: readonly string[]; readonly shown: readonly string[] }[] {
    const order = this.#orders.get(venueOrderId);
    if (order === undefined) return [];
    const out: { readonly facts: FillFacts; readonly need: number; readonly partial: boolean; readonly known: readonly string[]; readonly shown: readonly string[] }[] = [];
    for (const fill of order.unkeyed) {
      const held = new Set(this.#tradeOrder.slice(0, fill.before));
      const shown = this.keyedTradesShowing(venueOrderId, fill.facts).filter((tradeId) => !held.has(tradeId));
      // (r10) One from an answer that was not whole is never met: a trade the answer left out could stand in for it.
      if (!fill.partial && shown.length >= fill.need) continue;
      const known = [...held].filter((tradeId) => this.#trades.get(tradeId)?.legs.has(venueOrderId) === true).sort();
      out.push(Object.freeze({ facts: fill.facts, need: fill.need, partial: fill.partial, known: Object.freeze(known), shown: Object.freeze(shown) }));
    }
    return out;
  }

  /** The trade's entry, created when new (`created`: new information). */
  #tradeEntry(tradeId: string): { readonly trade: TradeEntry; readonly created: boolean } {
    const existing = this.#trades.get(tradeId);
    if (existing !== undefined) return { trade: existing, created: false };
    const trade: TradeEntry = { shown: false, legs: new Map(), status: null, statuses: [], terminals: [], legsUnidentified: false, legsInFull: false, sources: [] };
    this.#trades.set(tradeId, trade);
    // (r10) An unkeyed leg seen from now on may be this trade.
    this.#tradeOrder.push(tradeId);
    return { trade, created: true };
  }

  /**
   * (r9, WP290-CX-R9-01 and WP290-V9-UNFOLDED-TERMINAL) Fold one TRADE record: the trade's identity and its status,
   * whatever its legs. Its status is folded exactly as a leg's (every terminal status kept: a FAILED shown on a trade
   * with no own leg is as durable as one shown on a leg). Whether it identified the trade's own legs is kept as two
   * monotonic marks: `legsInFull` (a valid row with its ownership determined) and `legsUnidentified` (a row whose
   * ownership is undetermined, or a malformed row): the identity is OPEN while the second holds without the first.
   */
  #addTrade(record: EvidenceRecord): boolean {
    const tradeId = record.venueTradeId;
    // Unreachable through either door (a TRADE record names its trade); nothing is folded from it.
    if (tradeId === null) return false;
    const { trade, created } = this.#tradeEntry(tradeId);
    let informative = created;
    pushText(trade.sources, record.source);
    if (record.provenance === "SHOWN" && !trade.shown) {
      trade.shown = true;
      informative = true;
    }
    if (record.source === "TRADES_ROW") {
      if (!trade.legsInFull) {
        trade.legsInFull = true;
        informative = true;
      }
    } else if (!trade.legsUnidentified) {
      trade.legsUnidentified = true;
      informative = true;
    }
    if (this.#foldStatus(trade, record.status)) informative = true;
    return informative;
  }

  /**
   * Fold one observation's settlement status into its trade (a LEG's or a TRADE's): a new status text, a new terminal
   * status (r8: always information, so a restart folds the same contradiction), a legal forward step. `true` when it
   * added information.
   */
  #foldStatus(trade: TradeEntry, text: string | null): boolean {
    if (text === null) return false;
    let informative = pushText(trade.statuses, text);
    const status = tradeStatusOf(text);
    // (r8, WP290-CX-R8-02) Every terminal status, whatever came before it: a second one is a durable contradiction,
    // so it is information (journaled, and folded again after a restart).
    if (status !== null && TERMINAL_SETTLEMENTS.includes(status) && !trade.terminals.includes(status)) {
      trade.terminals.push(status);
      informative = true;
    }
    if (status !== null && (trade.status === null || (status !== trade.status && isLegalSettlementTransition(trade.status, status)))) {
      trade.status = status;
      informative = true;
    }
    return informative;
  }

  #orderEntry(id: string): { readonly entry: OrderEntry; readonly created: boolean } {
    const existing = this.#orders.get(id);
    if (existing !== undefined) return { entry: existing, created: false };
    const entry: OrderEntry = {
      shown: false,
      sources: [],
      facts: emptyFacts(ORDER_FACTS),
      observedMatched: null,
      terminal: false,
      statuses: [],
      level: 0,
      settledLevel: -1,
      unkeyed: [],
    };
    this.#orders.set(id, entry);
    return { entry, created: true };
  }

  #addLeg(record: EvidenceRecord, venueOrderId: string): boolean {
    const { trade, created } = this.#tradeEntry(record.venueTradeId as string);
    let informative = created;
    pushText(trade.sources, record.source);
    if (record.provenance === "SHOWN" && !trade.shown) {
      trade.shown = true;
      informative = true;
    }
    let leg = trade.legs.get(venueOrderId);
    if (leg === undefined) {
      leg = { shares: null, facts: emptyFacts(LEG_FACTS), shown: false };
      trade.legs.set(venueOrderId, leg);
      informative = true;
    }
    if (record.provenance === "SHOWN" && !leg.shown) {
      leg.shown = true;
      informative = true;
    }
    const shares = maxDecimal(leg.shares, record.size);
    if (shares !== leg.shares) {
      leg.shares = shares;
      informative = true;
    }
    // Every fill fact (r7, WP290-CX-R7-02): a value not shown before is information; a second value is a durable
    // contradiction (the fill's economics changed under one identity).
    const values: Record<LegFact, string | null> = {
      shares: record.size,
      price: record.price,
      feeAmount: record.feeAmount,
      feeAssetId: record.feeAssetId,
      role: record.role,
      matchedAt: record.matchedAt,
      tokenId: record.tokenId,
      side: record.side,
    };
    for (const fact of LEG_FACTS) if (pushValue(fact, leg.facts[fact], values[fact])) informative = true;
    if (this.#foldStatus(trade, record.status)) informative = true;
    return informative;
  }

  /** What the store knows of one venue order, or `undefined` when nothing. */
  order(id: string): OrderEvidence | undefined {
    return orderView(this.#orders, this.#trades, id);
  }

  /** What the store knows of one venue trade, or `undefined` when nothing. */
  trade(id: string): TradeEvidence | undefined {
    const trade = this.#trades.get(id);
    if (trade === undefined) return undefined;
    return Object.freeze({
      venueTradeId: id,
      shown: trade.shown,
      status: trade.status,
      terminals: Object.freeze([...trade.terminals]),
      identityOpen: trade.legsUnidentified && !trade.legsInFull,
      sources: Object.freeze([...trade.sources]),
      legs: Object.freeze(
        [...trade.legs].map(([venueOrderId, leg]) =>
          Object.freeze({
            venueOrderId,
            shown: leg.shown,
            shares: leg.shares,
            tokenId: first(leg.facts.tokenId),
            side: first(leg.facts.side) as "BUY" | "SELL" | null,
            price: first(leg.facts.price),
            contradictions: Object.freeze(contradictionsOf(leg.facts, LEG_FACTS)),
          }),
        ),
      ),
    });
  }

  /**
   * Every venue trade the store holds, sorted (r7): each is judged in every run whose trades read answered, so a
   * contradiction of its economics holds whether or not the read shows it, and one a read SHOWED carries a
   * classification obligation until it is accounted for.
   */
  tradeIds(): string[] {
    return [...this.#trades.keys()].sort();
  }

  /** Every trade leg the store holds on one venue order (r7: an UNATTRIBUTED order's trades are named from these too). */
  legsOn(venueOrderId: string): { readonly venueTradeId: string; readonly leg: LegEvidence }[] {
    const out: { readonly venueTradeId: string; readonly leg: LegEvidence }[] = [];
    for (const id of [...this.#trades.keys()].sort()) {
      const leg = this.trade(id)?.legs.find((entry) => entry.venueOrderId === venueOrderId);
      if (leg !== undefined) out.push({ venueTradeId: id, leg });
    }
    return out;
  }

  /** Venue orders with evidence no sound run has settled at their current level: each is read by id in every run. */
  unsettled(): string[] {
    return [...this.#orders].filter(([, entry]) => entry.settledLevel < entry.level).map(([id]) => id).sort();
  }

  /**
   * THE ONE QUERY. This run's reads of one venue order (or trade), judged against each other and against ALL
   * the evidence (this run's records folded in first). Every answer, classification, resolution and booking
   * decision about a venue object goes through the verdict this returns, and through nothing else.
   */
  judge(query: { readonly order: string; readonly reads: OrderReads }): OrderVerdict;
  judge(query: { readonly trade: string; readonly reads: TradeReads }): TradeVerdict;
  judge(query: { readonly order: string; readonly reads: OrderReads } | { readonly trade: string; readonly reads: TradeReads }): OrderVerdict | TradeVerdict {
    return "order" in query ? this.#judgeOrder(query.order, query.reads) : this.#judgeTrade(query.trade, query.reads);
  }

  #judgeOrder(id: string, reads: OrderReads): OrderVerdict {
    const evidence = this.order(id);
    const prior = orderView(this.#baseline.orders, this.#baseline.trades, id);
    const problems: EvidenceProblem[] = [];
    const { listed, byId } = reads;
    // A DURABLE CONTRADICTION (r7, WP290-CX-R7-01): two observations, from any source and any run (this one's
    // folded in first), showed this order with different fixed facts. Which is the venue's is unknown, so it is a
    // conflict in every run from now on, whatever this run read: no signed-identity answer can rest on it.
    if (evidence !== undefined && evidence.contradictions.length > 0) {
      problems.push(
        problem(
          "READ_CONFLICT",
          `venue order ${id}: observations showed different fixed facts (${evidence.contradictions.join("; ")}; sources: ${evidence.sources.join(", ")}): which is the venue's is unknown, so nothing about it is concluded`,
        ),
      );
    }
    // (r10, WP290-V10-UNKEYED-LEG-DISCHARGED) An own leg a trades read showed in full on this order in a row whose
    // trade id was unreadable, that the reads have not yet shown under enough distinct readable trade ids: it may be a
    // trade the evidence does not know, so nothing about the order is concluded, in any run, whatever this run read.
    for (const fill of this.unaccountedUnkeyed(id)) {
      problems.push(
        problem(
          "READ_CONFLICT",
          fill.partial
            ? `venue order ${id}: a trades read showed ${String(fill.need)} own leg(s) on it (${describeFill(fill.facts)}) in a row whose trade id was unreadable, in an answer that did not show every trade of the account (partial, or a row of it not identified): a trade of exactly those facts that the answer left out could be shown in its place, so no read can answer it (it holds until an operator path exists; trades already held there: ${fill.known.join(", ") || "none"})`
            : `venue order ${id}: a trades read showed ${String(fill.need)} own leg(s) on it (${describeFill(fill.facts)}) in a row whose trade id was unreadable: each could be a trade the evidence does not know, so the reads owe ${String(fill.need)} distinct trade(s) with a leg of exactly those facts on it, shown by a readable id, beyond the ${String(fill.known.length)} it already held there (${fill.known.join(", ") || "none"}), and they have shown ${String(fill.shown.length)} (${fill.shown.join(", ") || "none"}): the activity is not accounted for under any trade's identity`,
        ),
      );
    }
    // Each observation on its own, BEFORE two reads of this run are merged (a later read never erases what an earlier
    // one showed): a status outside the documented vocabulary is never assumed harmless, and an observation showing
    // less than an earlier read did (less matched, or live after terminal) is out of order.
    for (const observation of [listed, byId]) {
      if (observation === undefined || observation === null) continue;
      if (orderStatusOf(observation.status) === null) {
        problems.push(problem("STATUS_UNRECOGNISED", `venue order ${id} has a status outside the documented vocabulary (${observation.status})`));
      }
      if (prior !== undefined && compareDecimal(observation.sizeMatched, prior.matchedHigh) < 0) {
        problems.push(
          problem(
            "READ_REGRESSION",
            `venue order ${id}: this read shows ${observation.sizeMatched} matched, less than the ${prior.matchedHigh} an earlier read showed (an out-of-order read; sources: ${prior.sources.join(", ")})`,
            prior.matchedHigh,
            observation.sizeMatched,
          ),
        );
      } else if (prior?.terminal === true && !venueTerminal(observation)) {
        problems.push(problem("READ_REGRESSION", `venue order ${id}: this read shows it ${observation.status}, after an earlier read showed it terminal (an out-of-order read)`));
      }
    }
    if (listed !== undefined && byId === null) {
      problems.push(problem("READ_CONFLICT", `venue order ${id} is in the open-orders list but its by-id read did not find it`));
    }
    if (listed !== undefined && byId !== undefined && byId !== null) {
      if (!sameFixedFacts(listed, byId)) {
        problems.push(problem("READ_CONFLICT", `venue order ${id}: the open-orders list and the by-id read disagree about its token, side, price or size`));
      } else if (compareDecimal(byId.sizeMatched, listed.sizeMatched) < 0 || (venueTerminal(listed) && !venueTerminal(byId))) {
        problems.push(
          problem(
            "READ_REGRESSION",
            `venue order ${id}: the later by-id read shows an older state than the earlier list (${byId.status} with ${byId.sizeMatched} matched, after ${listed.status} with ${listed.sizeMatched})`,
            listed.sizeMatched,
            byId.sizeMatched,
          ),
        );
      } else if (listed.status !== byId.status && venueTerminal(listed) === venueTerminal(byId)) {
        problems.push(problem("READ_CONFLICT", `venue order ${id}: the open-orders list shows ${listed.status} and the by-id read ${byId.status}`));
      }
    }
    const latest = byId !== undefined && byId !== null ? byId : listed;
    if (latest !== undefined) {
      if (reads.legs.some((leg) => leg.tokenId !== latest.tokenId || leg.side !== latest.side)) {
        problems.push(problem("READ_CONFLICT", `a trade leg of venue order ${id} names another token or side than the order`));
      }
      // Against ALL the evidence, this run's other observations included (a row of an unusable answer, a leg): one
      // problem per class is enough (each observation's own check above may have named it already).
      const named = (breakClass: EvidenceProblem["breakClass"]): boolean => problems.some((entry) => entry.breakClass === breakClass);
      if (evidence !== undefined) {
        if (named("READ_REGRESSION")) {
          // already held as out of order
        } else if (evidence.observedMatched !== null && compareDecimal(latest.sizeMatched, evidence.observedMatched) < 0) {
          problems.push(
            problem(
              "READ_REGRESSION",
              `venue order ${id}: this read shows ${latest.sizeMatched} matched, less than the ${evidence.observedMatched} an earlier observation showed (an out-of-order read; sources: ${evidence.sources.join(", ")})`,
              evidence.observedMatched,
              latest.sizeMatched,
            ),
          );
        } else if (compareDecimal(latest.sizeMatched, evidence.legSum) < 0) {
          problems.push(
            problem("READ_CONFLICT", `the trades of venue order ${id} sum to ${evidence.legSum}, more than the ${latest.sizeMatched} matched this read shows`, latest.sizeMatched, evidence.legSum),
          );
        } else if (evidence.tradeCount > 0 && compareDecimal(latest.sizeMatched, "0") === 0) {
          // (r7) A trade names this order (a settlement the stream reported, its shares unknown, say): it matched.
          problems.push(problem("READ_CONFLICT", `venue order ${id}: ${String(evidence.tradeCount)} trade(s) name it, but this read shows nothing matched`, null, latest.sizeMatched));
        }
        if (evidence.terminal && !venueTerminal(latest) && !named("READ_REGRESSION")) {
          problems.push(problem("READ_REGRESSION", `venue order ${id}: this read shows it ${latest.status}, after an earlier observation showed it terminal (an out-of-order read)`));
        }
      }
      return problems.length > 0 ? Object.freeze({ kind: "CONFLICT", problems: Object.freeze(problems) }) : Object.freeze({ kind: "CONSISTENT", order: latest });
    }
    if (problems.length > 0) return Object.freeze({ kind: "CONFLICT", problems: Object.freeze(problems) });
    if (byId !== null) return Object.freeze({ kind: "UNREAD" });
    // Answered: not found.
    if (reads.claimed || evidence === undefined) return Object.freeze({ kind: "MISSING" });
    if (evidence.shown || reads.legs.length > 0) {
      return Object.freeze({
        kind: "CONFLICT",
        problems: Object.freeze([
          problem(
            "READ_CONFLICT",
            `venue order ${id} was seen by an earlier read, but its by-id read does not find it (E-14: canceled and fully matched orders are found by id; shown by ${evidence.sources.join(", ")})`,
            evidence.matchedHigh,
            null,
          ),
        ]),
      });
    }
    return Object.freeze({ kind: evidence.settled ? "ACKNOWLEDGED" : "GHOST" });
  }

  #judgeTrade(id: string, reads: TradeReads): TradeVerdict {
    if (!reads.tradesOk) return Object.freeze({ kind: "UNREAD" });
    const evidence = this.#trades.get(id);
    const legs = this.trade(id)?.legs ?? [];
    const shown = reads.shown;
    const status = shown === undefined ? null : tradeStatusOf(shown.status);
    const problems: EvidenceProblem[] = [];
    // A DURABLE CONTRADICTION (r7, WP290-CX-R7-02): a leg two observations showed with different fill facts (a
    // price and a fee that offset, at equal shares and equal net balances, included). Which is the venue's is
    // unknown: nothing is delivered, compared or resolved from it, in any run from now on.
    for (const [orderId, leg] of evidence?.legs ?? []) {
      const contradictions = contradictionsOf(leg.facts, LEG_FACTS);
      if (contradictions.length > 0) {
        problems.push(problem("READ_CONFLICT", `trade ${id}: its leg on venue order ${orderId} was shown with different fill facts (${contradictions.join("; ")}): which is the venue's is unknown`));
      }
    }
    // A DURABLE CONTRADICTION (r8, WP290-CX-R8-02): observations showed the trade both CONFIRMED and FAILED, from any
    // source and any run (this read's status included; `states.ts`: either order is a conflict). Which is the venue's
    // is unknown, so a later read repeating either one never ends it: nothing is answered, delivered, compared,
    // resolved or resumed from it. Forward progress to ONE terminal status never is.
    const terminals = new Set<VenueTradeStatus>(evidence?.terminals ?? []);
    if (status !== null && TERMINAL_SETTLEMENTS.includes(status)) terminals.add(status);
    if (terminals.has("CONFIRMED") && terminals.has("FAILED")) {
      problems.push(
        problem(
          "READ_CONFLICT",
          `trade ${id}: observations showed it both CONFIRMED and FAILED (both terminal: they contradict each other; statuses seen: ${[...new Set([...(evidence?.statuses ?? []), ...(shown === undefined ? [] : [shown.status])])].join(", ")}): which is the venue's is unknown, so nothing about it is concluded`,
        ),
      );
    }
    if (shown === undefined) {
      // (r7, WP290-CX-R7-03; r8, WP290-CX-R8-01) A trade the evidence holds that this COMPLETE trades read omits,
      // while a hold names it or any of its legs is not accounted for under the trade's own identity: the reads (or a
      // read and the user stream) contradict each other (`listTrades` is every trade of the account), and nothing
      // about the trade's orders or holdings is concluded. A trade only the stream NAMED is judged like one a read
      // SHOWED: no read has answered its identity yet. Once accounted for (each leg classified under the trade's id,
      // and no hold naming it), its absence is not judged: history may age a trade out.
      // (r9, WP290-CX-R9-01) A trade an observation carried WITHOUT identifying all of its own legs (a valid row whose
      // ownership is undetermined, legless or not; a row that did not validate in full, its id readable), that no valid
      // row has shown with its ownership determined, is OPEN: its legs are unknown, so no per-leg accounting can answer
      // it, and no omission discharges it. Only a read showing the trade with its own legs in full does.
      const open = evidence !== undefined && evidence.legsUnidentified && !evidence.legsInFull;
      if (evidence !== undefined && (open || reads.held || legs.some((leg) => !reads.accounted(leg)))) {
        problems.push(
          problem(
            "READ_CONFLICT",
            open
              ? `trade ${id}, which a trades read carried without identifying all of its own legs (its ownership undetermined, or its row malformed; sources: ${evidence.sources.join(", ")}), is missing from a complete trades read, and no read has shown it with its own legs: its identity is not answered (every trade of the account is in that read)`
              : evidence.shown
                ? `trade ${id}, which an earlier read showed, is missing from a complete trades read, and it is not accounted for under its own identity (every trade of the account is in that read)`
                : `trade ${id}, which the user stream named (a fill or settlement the OMS did not apply) and no read has shown, is missing from a complete trades read, and it is not accounted for under its own identity (every trade of the account is in that read)`,
          ),
        );
      }
      return problems.length > 0 ? Object.freeze({ kind: "CONFLICT", problems: Object.freeze(problems) }) : Object.freeze({ kind: "UNREAD" });
    }
    if (status === null) {
      problems.push(problem("STATUS_UNRECOGNISED", `trade ${id} has a status outside the documented vocabulary (C-3's MATCHED_NOT_BROADCASTED included)`));
    } else if (evidence?.status !== null && evidence?.status !== undefined && evidence.status !== status && !isLegalSettlementTransition(evidence.status, status)) {
      // Any other step back is out of order (a later read may catch up). CONFIRMED against FAILED, either order, is the
      // durable contradiction above: this read's status is among the terminal statuses judged there.
      if (!(TERMINAL_SETTLEMENTS.includes(evidence.status) && TERMINAL_SETTLEMENTS.includes(status))) {
        problems.push(problem("READ_REGRESSION", `trade ${id}: settlement ${status} read after ${evidence.status} (an out-of-order read)`));
      }
    }
    if (shown.ownershipUndetermined) problems.push(problem("READ_INCOMPLETE", `trade ${id}: the read could not establish which legs are the account's`));
    for (const leg of legs) {
      const orderId = leg.venueOrderId;
      const now = shown.ownLegs.find((candidate) => candidate.venueOrderId === orderId);
      if (now === undefined) {
        if (leg.shown) {
          problems.push(problem("READ_CONFLICT", `trade ${id}: its leg on venue order ${orderId}, which an earlier read showed, is missing from this read`));
        } else if (!reads.accounted(leg)) {
          // (r8, WP290-CX-R8-01) A leg only the user stream named, which this read of the trade does not show: its
          // identity (trade and order) is not answered.
          problems.push(problem("READ_CONFLICT", `trade ${id}: its leg on venue order ${orderId}, which the user stream named, is not in this read of the trade, and it is not accounted for under the trade's identity`));
        }
      } else if (leg.shown && leg.shares !== null && compareDecimal(now.shares, leg.shares) !== 0) {
        problems.push(problem("READ_CONFLICT", `trade ${id}: its leg on venue order ${orderId} shows ${now.shares} shares; an earlier read showed ${leg.shares}`, leg.shares, now.shares));
      }
    }
    if (problems.length > 0 || status === null) return Object.freeze({ kind: "CONFLICT", problems: Object.freeze(problems) });
    return Object.freeze({ kind: "CONSISTENT", status });
  }
}

/** Read one evidence record the journal returned (the coordinator's door for it); `undefined` when out of shape. */
export function readEvidenceRecord(raw: unknown): EvidenceRecord | undefined {
  const fields = readFields(raw, [
    "evidenceKind",
    "venueOrderId",
    "venueTradeId",
    "provenance",
    "source",
    "tokenId",
    "side",
    "price",
    "originalSize",
    "size",
    "status",
    "level",
    "feeAmount",
    "feeAssetId",
    "role",
    "matchedAt",
  ]);
  if (fields === undefined) return undefined;
  const { evidenceKind, venueOrderId, venueTradeId, provenance, source, tokenId, side, price, originalSize, size, status, level, feeAmount, feeAssetId, role, matchedAt } = fields;
  if (evidenceKind !== "ORDER" && evidenceKind !== "LEG" && evidenceKind !== "TRADE" && evidenceKind !== "UNKEYED_LEG" && evidenceKind !== "SETTLED") return undefined;
  if (!(venueOrderId === null || isIdentifier(venueOrderId)) || !(venueTradeId === null || isIdentifier(venueTradeId))) return undefined;
  if ((provenance !== "SHOWN" && provenance !== "NAMED") || typeof source !== "string" || !(EVIDENCE_SOURCES as readonly string[]).includes(source)) return undefined;
  if (!(tokenId === null || isTokenId(tokenId)) || !(side === null || side === "BUY" || side === "SELL")) return undefined;
  const decimal = (value: unknown): value is DecimalString | null => value === null || isCanonicalDecimalString(value);
  if (!decimal(price) || !decimal(originalSize) || !decimal(size) || !(status === null || isIdentifier(status))) return undefined;
  if (!(level === null || (typeof level === "number" && Number.isSafeInteger(level) && level >= 0))) return undefined;
  // A LEG and a TRADE name their trade, nothing else does; only a TRADE names no order (r9); only a SETTLED and (r10) an
  // UNKEYED_LEG have a level.
  if ((evidenceKind === "LEG" || evidenceKind === "TRADE") !== (venueTradeId !== null) || (evidenceKind === "SETTLED" || evidenceKind === "UNKEYED_LEG") !== (level !== null)) return undefined;
  if ((evidenceKind === "TRADE") !== (venueOrderId === null)) return undefined;
  // (r9) A TRADE comes from a trade row (and only a TRADE does), SHOWN when the row validated in full, and carries its
  // status alone: nothing of an order, and no economics.
  if ((evidenceKind === "TRADE") !== (TRADE_SOURCES as readonly string[]).includes(source)) return undefined;
  if (evidenceKind === "TRADE" && (provenance !== (source === "TRADES_ROW_ID" ? "NAMED" : "SHOWN") || tokenId !== null || side !== null || price !== null || originalSize !== null || size !== null)) {
    return undefined;
  }
  if (!decimal(feeAmount) || !(feeAssetId === null || isIdentifier(feeAssetId)) || !(role === null || role === "MAKER" || role === "TAKER") || !(matchedAt === null || isIsoInstant(matchedAt))) {
    return undefined;
  }
  // (r10) Only an UNKEYED_LEG comes from an answer that was not whole.
  if (source === "TRADES_LEG_UNKEYED_PARTIAL" && evidenceKind !== "UNKEYED_LEG") return undefined;
  // Only a leg (r7) and an unkeyed leg (r10) carry fill facts.
  if (evidenceKind !== "LEG" && evidenceKind !== "UNKEYED_LEG" && (feeAmount !== null || feeAssetId !== null || role !== null || matchedAt !== null)) return undefined;
  // (r10) An UNKEYED_LEG is an own leg SHOWN in full under no readable trade id (`TRADES_LEG_UNKEYED`): every fill fact
  // a valid leg fixes (its fee may be unfixed), nothing of an order, and at least one trade owed.
  if (
    evidenceKind === "UNKEYED_LEG" &&
    (provenance !== "SHOWN" ||
      (source !== "TRADES_LEG_UNKEYED" && source !== "TRADES_LEG_UNKEYED_PARTIAL") ||
      tokenId === null ||
      side === null ||
      price === null ||
      size === null ||
      compareDecimal(size, "0") <= 0 ||
      originalSize !== null ||
      role === null ||
      matchedAt === null ||
      level === null ||
      level < 1)
  ) {
    return undefined;
  }
  return Object.freeze({
    evidenceKind,
    venueOrderId,
    venueTradeId,
    provenance,
    source: source as EvidenceSource,
    tokenId,
    side,
    price,
    originalSize,
    size,
    status,
    level,
    feeAmount,
    feeAssetId,
    role,
    matchedAt,
  });
}

/** Read the journal's evidence list; `undefined` when it, or any record of it, is unreadable (fail closed). */
export function readEvidenceRecords(raw: unknown): EvidenceRecord[] | undefined {
  const list = readArray(raw, 10_000_000);
  if (list === undefined) return undefined;
  const out: EvidenceRecord[] = [];
  for (const entry of list) {
    const record = readEvidenceRecord(entry);
    if (record === undefined) return undefined;
    out.push(record);
  }
  return out;
}

const NO_FILL_FACTS = { feeAmount: null, feeAssetId: null, role: null, matchedAt: null } as const;

/** An ORDER record of a venue order a read showed in full. */
export function shownOrder(order: VenueOrderView, source: EvidenceSource): EvidenceRecord {
  return Object.freeze({
    evidenceKind: "ORDER",
    venueOrderId: order.venueOrderId,
    venueTradeId: null,
    provenance: "SHOWN",
    source,
    tokenId: order.tokenId,
    side: order.side,
    price: order.price,
    originalSize: order.originalSize,
    size: order.sizeMatched,
    status: order.status,
    level: null,
    ...NO_FILL_FACTS,
  });
}

/** The facts of one leg a read (or the stream) showed; the fill facts it did not fix are `null` (r7: all are kept). */
export interface LegFacts {
  readonly venueOrderId: string;
  readonly tokenId: string | null;
  readonly side: "BUY" | "SELL" | null;
  readonly shares: DecimalString | null;
  readonly price: DecimalString | null;
  readonly feeAmount?: DecimalString | null;
  readonly feeAssetId?: string | null;
  readonly role?: "MAKER" | "TAKER" | null;
  readonly matchedAt?: string | null;
}

/** A LEG record of an own leg a read (or the stream) showed, with every fill fact it fixed (r7). */
export function legRecord(venueTradeId: string, leg: LegFacts, status: string | null, provenance: EvidenceProvenance, source: EvidenceSource): EvidenceRecord {
  return Object.freeze({
    evidenceKind: "LEG",
    venueOrderId: leg.venueOrderId,
    venueTradeId,
    provenance,
    source,
    tokenId: leg.tokenId,
    side: leg.side,
    price: leg.price,
    originalSize: null,
    size: leg.shares,
    status,
    level: null,
    feeAmount: leg.feeAmount ?? null,
    feeAssetId: leg.feeAssetId ?? null,
    role: leg.role ?? null,
    matchedAt: leg.matchedAt ?? null,
  });
}

/**
 * (r9, WP290-CX-R9-01 and WP290-V9-UNFOLDED-TERMINAL) A TRADE record: one trade row's trade identity and its status as
 * read (text, or `null` when not readable), whatever its legs. SHOWN for a row that validated in full (`TRADES_ROW`,
 * `TRADES_ROW_PARTIAL`), NAMED for the readable id of a malformed row (`TRADES_ROW_ID`). It carries no economics.
 */
export function tradeRecord(venueTradeId: string, status: string | null, source: TradeSource): EvidenceRecord {
  return Object.freeze({
    evidenceKind: "TRADE",
    venueOrderId: null,
    venueTradeId,
    provenance: source === "TRADES_ROW_ID" ? "NAMED" : "SHOWN",
    source,
    tokenId: null,
    side: null,
    price: null,
    originalSize: null,
    size: null,
    status,
    level: null,
    ...NO_FILL_FACTS,
  });
}

/**
 * (r10, WP290-V10-UNKEYED-LEG-DISCHARGED) An UNKEYED_LEG record: an own leg a trades read showed in full in a row whose
 * trade id was unreadable, with every fill fact, its row's status as read (detail only), `count`: how many such unkeyed
 * legs of exactly these facts on its order the one answer showed, and whether that answer was WHOLE (`door.ts`): one
 * that was not (`TRADES_LEG_UNKEYED_PARTIAL`) is never answered (see {@link EvidenceStore}).
 */
export function unkeyedLegRecord(leg: VenueTradeLeg, status: string | null, count: number, whole: boolean): EvidenceRecord {
  return Object.freeze({
    evidenceKind: "UNKEYED_LEG",
    venueOrderId: leg.venueOrderId,
    venueTradeId: null,
    provenance: "SHOWN",
    source: whole ? "TRADES_LEG_UNKEYED" : "TRADES_LEG_UNKEYED_PARTIAL",
    tokenId: leg.tokenId,
    side: leg.side,
    price: leg.price,
    originalSize: null,
    size: leg.shares,
    status,
    level: count,
    feeAmount: leg.feeAmount,
    feeAssetId: leg.feeAssetId,
    role: leg.role,
    matchedAt: leg.matchedAt,
  });
}

/** The fill facts of one valid leg (an UNKEYED_LEG's, before it is recorded). */
export function fillFactsOfLeg(leg: VenueTradeLeg): FillFacts {
  return {
    shares: leg.shares,
    price: leg.price,
    feeAmount: leg.feeAmount,
    feeAssetId: leg.feeAssetId,
    role: leg.role,
    matchedAt: leg.matchedAt,
    tokenId: leg.tokenId,
    side: leg.side,
  };
}

/** Whether two valid legs show the same fill facts (decimals by value, a time as an instant). */
export function sameFillOfLegs(a: VenueTradeLeg, b: VenueTradeLeg): boolean {
  return sameFill(fillFactsOfLeg(a), fillFactsOfLeg(b));
}

/** An ORDER record of an id only named (and, for the stream, its status when it reported one). */
export function namedOrder(venueOrderId: string, source: EvidenceSource, extra: { readonly tokenId?: string | null; readonly status?: string | null; readonly size?: DecimalString | null; readonly side?: "BUY" | "SELL" | null; readonly provenance?: EvidenceProvenance } = {}): EvidenceRecord {
  return Object.freeze({
    evidenceKind: "ORDER",
    venueOrderId,
    venueTradeId: null,
    provenance: extra.provenance ?? "NAMED",
    source,
    tokenId: extra.tokenId ?? null,
    side: extra.side ?? null,
    price: null,
    originalSize: null,
    size: extra.size ?? null,
    status: extra.status ?? null,
    level: null,
    ...NO_FILL_FACTS,
  });
}

/** A SETTLED record: the order is classified, consistently with all its evidence, up to `level`. */
export function settledRecord(venueOrderId: string, level: number, source: "SOUND_RUN" | "OPERATOR_RELEASE"): EvidenceRecord {
  return Object.freeze({
    evidenceKind: "SETTLED",
    venueOrderId,
    venueTradeId: null,
    provenance: "NAMED",
    source,
    tokenId: null,
    side: null,
    price: null,
    originalSize: null,
    size: null,
    status: null,
    level,
    ...NO_FILL_FACTS,
  });
}
