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
 * | `TRADES_LEG_UNKEYED` | SHOWN | the same, when its trade's own id did not validate: the order matched at least its shares |
 * | `TRADES_LEG_ID` | NAMED | the id alone of a malformed leg |
 * | `BY_ID` | SHOWN | a by-id read that found the order |
 * | `OMS_RETAINED` | NAMED | a venue order id the OMS retains as user-stream evidence |
 * | `STREAM_ORDER`, `STREAM_FILL`, `STREAM_SETTLEMENT` | NAMED | what the user stream reported, as routed to the OMS |
 *
 * Per venue order: whether any source SHOWED it, EVERY value any observation showed of each of its fixed facts
 * (token, side, price, original size: r7), the HIGH-WATER matched size (the most any order observation showed, and
 * at least the sum of every distinct trade's leg on it), whether any observation showed it TERMINAL, every status
 * seen. Per venue trade: its legs, each with EVERY value any observation showed of each of its fill facts (shares,
 * price, fee, fee asset, liquidity role, match time, token, side: r7), and the furthest settlement status seen. The
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
 * - (r7, WP290-CX-R7-03) a trade a read SHOWED that a complete trades read no longer shows, while it is not yet
 *   ACCOUNTED FOR under its own identity (the coordinator decides: `TradeReads.accounted`), is a CONFLICT;
 * - (r7) an order a trade names (any leg, its shares known or not) matched something: a read showing nothing
 *   matched is a CONFLICT.
 *
 * Pure: no I/O, no clock, no randomness. Exact decimal strings throughout.
 */

import { addDecimal, compareDecimal, isCanonicalDecimalString, type DecimalString } from "@polymarket-bot/decimal";

import { isIdentifier, isTokenId, readArray, readFields } from "../guards.js";
import { isLegalSettlementTransition } from "../states.js";

import { isIsoInstant, orderStatusOf, tradeStatusOf } from "./door.js";
import type { VenueOrderView, VenueTradeLeg, VenueTradeStatus, VenueTradeView } from "./ports.js";
import { sameInstantText } from "./time.js";

export type EvidenceKind = "ORDER" | "LEG" | "SETTLED";
export type EvidenceProvenance = "SHOWN" | "NAMED";

export const EVIDENCE_SOURCES = [
  "OPEN_ORDERS_LIST",
  "OPEN_ORDERS_ROW",
  "OPEN_ORDERS_ID",
  "TRADES_LEG",
  "TRADES_LEG_SALVAGED",
  "TRADES_LEG_UNKEYED",
  "TRADES_LEG_ID",
  "BY_ID",
  "OMS_RETAINED",
  "STREAM_ORDER",
  "STREAM_FILL",
  "STREAM_SETTLEMENT",
  "SOUND_RUN",
  "OPERATOR_RELEASE",
] as const;
export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number];

/** One record (the journal's `EVIDENCE_RECORDED` without its run, time and position). */
export interface EvidenceRecord {
  readonly evidenceKind: EvidenceKind;
  readonly venueOrderId: string;
  readonly venueTradeId: string | null;
  readonly provenance: EvidenceProvenance;
  readonly source: EvidenceSource;
  readonly tokenId: string | null;
  readonly side: "BUY" | "SELL" | null;
  readonly price: DecimalString | null;
  readonly originalSize: DecimalString | null;
  /** ORDER: the matched size shown (`TRADES_LEG_UNKEYED`: a lower bound); LEG: the leg's shares. */
  readonly size: DecimalString | null;
  readonly status: string | null;
  /** SETTLED only. */
  readonly level: number | null;
  /** LEG only (r7, WP290-CX-R7-02): the leg's exact fee, when the observation fixed it. */
  readonly feeAmount: DecimalString | null;
  /** LEG only: the asset the fee is charged in. */
  readonly feeAssetId: string | null;
  /** LEG only: the leg's liquidity role. */
  readonly role: "MAKER" | "TAKER" | null;
  /** LEG only: the match time (ISO-8601). */
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
type LegFact = (typeof LEG_FACTS)[number];
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
   * (r7, WP290-CX-R7-03) The trade's classification obligation is discharged: every leg a read showed is accounted
   * for under the trade's own identity, and no unresolved break names the trade (the coordinator decides). Only an
   * accounted trade may be absent from a complete trades read without a CONFLICT.
   */
  readonly accounted: boolean;
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
  return new Map([...orders].map(([id, entry]) => [id, { ...entry, sources: [...entry.sources], statuses: [...entry.statuses], facts: cloneFacts(entry.facts) }]));
}

function cloneTrades(trades: ReadonlyMap<string, TradeEntry>): Map<string, TradeEntry> {
  return new Map(
    [...trades].map(([id, trade]) => [id, { ...trade, statuses: [...trade.statuses], legs: new Map([...trade.legs].map(([order, leg]) => [order, { ...leg, facts: cloneFacts(leg.facts) }])) }]),
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
    if (record.evidenceKind === "SETTLED") {
      const entry = this.#orders.get(record.venueOrderId);
      if (entry === undefined || record.level === null || record.level <= entry.settledLevel) return false;
      entry.settledLevel = Math.min(record.level, entry.level);
      return true;
    }
    const entry = this.#orderEntry(record.venueOrderId);
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
    } else if (record.venueTradeId !== null) {
      if (this.#addLeg(record)) informative = true;
    }
    if (informative) order.level += 1;
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
    };
    this.#orders.set(id, entry);
    return { entry, created: true };
  }

  #addLeg(record: EvidenceRecord): boolean {
    const tradeId = record.venueTradeId as string;
    let informative = false;
    let trade = this.#trades.get(tradeId);
    if (trade === undefined) {
      trade = { shown: false, legs: new Map(), status: null, statuses: [] };
      this.#trades.set(tradeId, trade);
      informative = true;
    }
    if (record.provenance === "SHOWN" && !trade.shown) {
      trade.shown = true;
      informative = true;
    }
    let leg = trade.legs.get(record.venueOrderId);
    if (leg === undefined) {
      leg = { shares: null, facts: emptyFacts(LEG_FACTS), shown: false };
      trade.legs.set(record.venueOrderId, leg);
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
    if (record.status !== null) {
      if (pushText(trade.statuses, record.status)) informative = true;
      const status = tradeStatusOf(record.status);
      if (status !== null && (trade.status === null || (status !== trade.status && isLegalSettlementTransition(trade.status, status)))) {
        trade.status = status;
        informative = true;
      }
    }
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
    const shown = reads.shown;
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
    if (shown === undefined) {
      // (r7, WP290-CX-R7-03) A trade a read SHOWED that this COMPLETE trades read omits, while it is not accounted for
      // under its own identity: the reads contradict each other (`listTrades` is every trade of the account), and
      // nothing about the trade's order or holdings is concluded. Once accounted for (each shown leg classified under
      // the trade's id, and no hold naming it), its absence is not judged: history may age a trade out.
      if (evidence?.shown === true && !reads.accounted) {
        problems.push(
          problem(
            "READ_CONFLICT",
            `trade ${id}, which an earlier read showed, is missing from a complete trades read, and it is not accounted for under its own identity (every trade of the account is in that read)`,
          ),
        );
      }
      return problems.length > 0 ? Object.freeze({ kind: "CONFLICT", problems: Object.freeze(problems) }) : Object.freeze({ kind: "UNREAD" });
    }
    const status = tradeStatusOf(shown.status);
    if (status === null) {
      problems.push(problem("STATUS_UNRECOGNISED", `trade ${id} has a status outside the documented vocabulary (C-3's MATCHED_NOT_BROADCASTED included)`));
    } else if (evidence?.status !== null && evidence?.status !== undefined && evidence.status !== status && !isLegalSettlementTransition(evidence.status, status)) {
      // CONFIRMED against FAILED, either order, is a contradiction (`states.ts`); any other step back is out of order.
      const contradiction = TERMINAL_SETTLEMENTS.includes(evidence.status) && TERMINAL_SETTLEMENTS.includes(status);
      problems.push(
        contradiction
          ? problem("READ_CONFLICT", `trade ${id}: settlement ${status} read after an earlier read showed ${evidence.status} (both terminal: the reads contradict each other)`)
          : problem("READ_REGRESSION", `trade ${id}: settlement ${status} read after ${evidence.status} (an out-of-order read)`),
      );
    }
    if (shown.ownershipUndetermined) problems.push(problem("READ_INCOMPLETE", `trade ${id}: the read could not establish which legs are the account's`));
    for (const [orderId, leg] of evidence?.legs ?? []) {
      if (!leg.shown) continue;
      const now = shown.ownLegs.find((candidate) => candidate.venueOrderId === orderId);
      if (now === undefined) {
        problems.push(problem("READ_CONFLICT", `trade ${id}: its leg on venue order ${orderId}, which an earlier read showed, is missing from this read`));
      } else if (leg.shares !== null && compareDecimal(now.shares, leg.shares) !== 0) {
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
  if (evidenceKind !== "ORDER" && evidenceKind !== "LEG" && evidenceKind !== "SETTLED") return undefined;
  if (!isIdentifier(venueOrderId) || !(venueTradeId === null || isIdentifier(venueTradeId))) return undefined;
  if ((provenance !== "SHOWN" && provenance !== "NAMED") || typeof source !== "string" || !(EVIDENCE_SOURCES as readonly string[]).includes(source)) return undefined;
  if (!(tokenId === null || isTokenId(tokenId)) || !(side === null || side === "BUY" || side === "SELL")) return undefined;
  const decimal = (value: unknown): value is DecimalString | null => value === null || isCanonicalDecimalString(value);
  if (!decimal(price) || !decimal(originalSize) || !decimal(size) || !(status === null || isIdentifier(status))) return undefined;
  if (!(level === null || (typeof level === "number" && Number.isSafeInteger(level) && level >= 0))) return undefined;
  if ((evidenceKind === "LEG") !== (venueTradeId !== null) || (evidenceKind === "SETTLED") !== (level !== null)) return undefined;
  if (!decimal(feeAmount) || !(feeAssetId === null || isIdentifier(feeAssetId)) || !(role === null || role === "MAKER" || role === "TAKER") || !(matchedAt === null || isIsoInstant(matchedAt))) {
    return undefined;
  }
  // Only a leg carries fill facts (r7).
  if (evidenceKind !== "LEG" && (feeAmount !== null || feeAssetId !== null || role !== null || matchedAt !== null)) return undefined;
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
