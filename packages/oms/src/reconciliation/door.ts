/**
 * The reconciliation coordinator's DOOR (WP-290): every answer of the
 * {@link AccountReadPort} is read ONCE, by own data property, into a frozen
 * copy, before anything is decided on it (the WP-300b lesson; `guards.ts`).
 *
 * A read has exactly one outcome:
 *
 * | Outcome | Meaning | Break |
 * | --- | --- | --- |
 * | `OK` | the answer is in the port's shape | — |
 * | `FAILED` | the port threw or rejected | `READ_MISSING` |
 * | `MALFORMED` | outside the shape: an inexact decimal, a bad id, an opaque field, a duplicate, an impossible size | `READ_MALFORMED` |
 * | `INCOMPLETE` | a paginated read did not reach its last page | `READ_INCOMPLETE` |
 * | `WRONG_ROUTE` | the answer names another route (Data API v1, E-15) | `READ_WRONG_ROUTE` |
 *
 * None of them is ever read as "empty". A partial or malformed open-orders,
 * trades or (r10) by-id answer is discarded whole, but what its rows SHOWED is
 * NOT forgotten (r4, WP290-CX-R4-01; r5, R5-NAMED; r6, WP290-CX-R6-01): the
 * outcome keeps `named` (each id a row or leg carries, with its token when the
 * row validated in full, `null` for the id alone of a malformed row) and
 * `salvage` (every row and every leg that validated in full, with its matched
 * size or shares and its status as read, and, r9, every trade identity a
 * trade row carries: a valid row's, legless or not, and the readable trade id
 * and status of a malformed row). (r10, WP290-CX-R10-01) A by-id answer that
 * is unusable for the order asked about (a not-found answer carrying an order,
 * an answer that does not say whether it found it, an order row naming ANOTHER
 * order, an invalid row) keeps its order row the same way, ALWAYS under the id
 * the row itself carries, never the one asked about; the answer still answers
 * nothing about the order asked about. (r10, the door audit) An answer one of
 * whose top-level fields is not own data, or one of whose list entries (a
 * row, a leg) is not, is MALFORMED, but when its route is readable and the
 * right one, its other rows are still read and kept. The coordinator
 * records all of it as evidence (`evidence.ts`) before anything is
 * classified, so a later read that shows less can never be taken for the
 * truth. Statuses are kept as data: an order
 * or trade status outside the documented vocabulary is not malformed, it is
 * UNRECOGNISED, and the coordinator holds on it (`STATUS_UNRECOGNISED`).
 * Trade statuses are accepted in both documented spellings (E-13, C-5):
 * `TRADE_STATUS_<X>` (REST) and `<X>` (stream).
 *
 * Pure: no I/O, no clock, no randomness.
 */

import { compareDecimal, isCanonicalDecimalString, isZeroDecimal, type DecimalString } from "@polymarket-bot/decimal";

import { compositeKey, isIdentifier, isNonNegativeAmount, isPositiveAmount, isTokenId, isUnitPrice, readArray, readField, readFields } from "../guards.js";
import { isVenueId } from "../outcomes.js";

import {
  VENUE_ORDER_STATUSES,
  VENUE_TRADE_STATUSES,
  type BookedAmount,
  type FillIdentity,
  type VenueOrderStatus,
  type VenueOrderView,
  type VenueTradeLeg,
  type VenueTradeStatus,
  type VenueTradeView,
} from "./ports.js";

/**
 * The venue order ids the rows of an unusable answer carry (venue order id → its token id, or `null` when the row
 * did not validate in full). Only the open-orders and trades reads keep them. A token means the row or leg validated
 * in full, so it SHOWED its order (the coordinator's provenance, r5); `null`, that only its id was readable.
 */
export type NamedOrders = ReadonlyMap<string, string | null>;

/** One own leg that validated in full inside an unusable trades answer, with its trade's id and status when those validated too. */
export interface SalvagedLeg {
  readonly venueTradeId: string | null;
  readonly status: string | null;
  readonly leg: VenueTradeLeg;
}

/**
 * How one trade row of an unusable trades answer showed its trade (r9, WP290-CX-R9-01):
 * - `IN_FULL`: the row validated in full and its ownership is determined: its own legs are exactly those it shows;
 * - `OWNERSHIP_UNDETERMINED`: the row validated in full, but the read could not establish which legs are the
 *   account's (it may show none);
 * - `MALFORMED`: the row did not validate in full; only its trade id (and its status, when that is text) was readable.
 */
export type SalvagedTradeShape = "IN_FULL" | "OWNERSHIP_UNDETERMINED" | "MALFORMED";

/** One trade IDENTITY a row of an unusable trades answer carries, whatever its legs (r9, WP290-CX-R9-01). */
export interface SalvagedTrade {
  readonly venueTradeId: string;
  /** The row's status as read (text only, never interpreted here); `null` when it was not readable. */
  readonly status: string | null;
  readonly shape: SalvagedTradeShape;
}

/**
 * What the rows of an unusable open-orders or trades answer SHOWED in full (r6, WP290-CX-R6-01): every order row
 * and every own leg that validated in full, and (r9, WP290-CX-R9-01) every trade identity a trade row carries, a
 * legless row and a malformed row whose trade id is readable included. The answer is discarded; these facts are not
 * (`evidence.ts`). No economics of a malformed row or leg is ever kept.
 */
export interface Salvage {
  readonly rows: readonly VenueOrderView[];
  readonly legs: readonly SalvagedLeg[];
  readonly trades: readonly SalvagedTrade[];
  /**
   * (r10, WP290-V10-UNKEYED-LEG-DISCHARGED) Trades answers only: the answer said it was complete, its fields and its
   * list were readable, and EVERY row of it was identified (a readable trade id, or every own leg validated in full
   * with its ownership determined), so no trade of the account is missing from what was kept. An unkeyed leg of an
   * answer that is not whole may be any trade the answer left out: no later read can answer it.
   */
  readonly whole?: boolean;
}

export type ReadOutcome<T> =
  | { readonly kind: "OK"; readonly value: T }
  | { readonly kind: "FAILED" }
  | { readonly kind: "MALFORMED"; readonly why: string; readonly named?: NamedOrders; readonly salvage?: Salvage }
  | { readonly kind: "INCOMPLETE"; readonly named?: NamedOrders; readonly salvage?: Salvage }
  | { readonly kind: "WRONG_ROUTE"; readonly route: string };

/** The longest list a read may return (a guard; no venue fact bounds it). */
export const MAX_READ_ENTRIES = 50_000;
/** The most own legs one trade may carry. */
export const MAX_LEGS_PER_TRADE = 64;

const FAILED: ReadOutcome<never> = Object.freeze({ kind: "FAILED" });
const INCOMPLETE: ReadOutcome<never> = Object.freeze({ kind: "INCOMPLETE" });

function ok<T>(value: T): ReadOutcome<T> {
  return Object.freeze({ kind: "OK", value });
}

function frozenSalvage(salvage: Salvage | undefined): Salvage | undefined {
  if (salvage === undefined || (salvage.rows.length === 0 && salvage.legs.length === 0 && salvage.trades.length === 0)) return undefined;
  return Object.freeze({
    rows: Object.freeze([...salvage.rows]),
    legs: Object.freeze(salvage.legs.map((entry) => Object.freeze({ ...entry }))),
    trades: Object.freeze(salvage.trades.map((entry) => Object.freeze({ ...entry }))),
    whole: salvage.whole === true,
  });
}

function malformed<T>(why: string, named?: NamedOrders, salvage?: Salvage): ReadOutcome<T> {
  const kept = frozenSalvage(salvage);
  return Object.freeze({
    kind: "MALFORMED",
    why,
    ...(named === undefined || named.size === 0 ? {} : { named }),
    ...(kept === undefined ? {} : { salvage: kept }),
  });
}

function incomplete<T>(named: NamedOrders, salvage?: Salvage): ReadOutcome<T> {
  const kept = frozenSalvage(salvage);
  if (named.size === 0 && kept === undefined) return INCOMPLETE;
  return Object.freeze({ kind: "INCOMPLETE", ...(named.size === 0 ? {} : { named }), ...(kept === undefined ? {} : { salvage: kept }) });
}

/** A row's own `venueOrderId` field, when it is a venue id (the rest of the row may be anything). */
function rowVenueId(row: unknown): string | undefined {
  const read = readField(row, "venueOrderId");
  return read.kind === "DATA" && isVenueId(read.value) ? read.value : undefined;
}

/** Keep an id a row carries; a token learned from a fully valid row replaces an unknown one. */
function keepNamed(named: Map<string, string | null>, id: string, tokenId: string | null): void {
  if (!named.has(id) || (named.get(id) === null && tokenId !== null)) named.set(id, tokenId);
}

function wrongRoute<T>(route: unknown): ReadOutcome<T> {
  return Object.freeze({ kind: "WRONG_ROUTE", route: typeof route === "string" ? route.slice(0, 64) : "unreadable" });
}

/** ISO-8601 with an offset (the shape `order-manager.ts` reads as `matchedAt`). */
const TIMESTAMP = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?(?:Z|[+-][0-9]{2}:[0-9]{2})$/u;

export function isIsoInstant(value: unknown): value is string {
  return typeof value === "string" && TIMESTAMP.test(value);
}

/** Run a port call: a throw or a rejection is a FAILED read, never an empty one. */
export async function callRead(run: () => Promise<unknown>): Promise<{ readonly ok: true; readonly raw: unknown } | { readonly ok: false }> {
  try {
    return { ok: true, raw: await run() };
  } catch {
    return { ok: false };
  }
}

/** Normalize a trade status: `TRADE_STATUS_<X>` or `<X>` for a documented `<X>`; `null` for anything else (C-3 included). */
export function tradeStatusOf(status: string): VenueTradeStatus | null {
  const plain = status.startsWith("TRADE_STATUS_") ? status.slice("TRADE_STATUS_".length) : status;
  return (VENUE_TRADE_STATUSES as readonly string[]).includes(plain) ? (plain as VenueTradeStatus) : null;
}

export function orderStatusOf(status: string): VenueOrderStatus | null {
  return (VENUE_ORDER_STATUSES as readonly string[]).includes(status) ? (status as VenueOrderStatus) : null;
}

function readOrderView(raw: unknown): VenueOrderView | string {
  const fields = readFields(raw, ["venueOrderId", "tokenId", "side", "price", "originalSize", "sizeMatched", "status"]);
  if (fields === undefined) return "an order carries a field that is not own data";
  if (!isVenueId(fields.venueOrderId)) return "an order's venue id is not a venue id";
  if (!isTokenId(fields.tokenId)) return "an order's token id is not a token id";
  if (fields.side !== "BUY" && fields.side !== "SELL") return "an order's side is not BUY or SELL";
  if (!isUnitPrice(fields.price)) return "an order's price is not an exact price in [0, 1]";
  if (!isPositiveAmount(fields.originalSize) || !isNonNegativeAmount(fields.sizeMatched)) return "an order's sizes are not exact";
  if (compareDecimal(fields.sizeMatched, fields.originalSize) > 0) return "an order's matched size exceeds its original size";
  if (!isIdentifier(fields.status)) return "an order's status is not text";
  return Object.freeze({
    venueOrderId: fields.venueOrderId,
    tokenId: fields.tokenId,
    side: fields.side,
    price: fields.price,
    originalSize: fields.originalSize,
    sizeMatched: fields.sizeMatched,
    status: fields.status,
  });
}

/**
 * (r10, the door audit) The entries of a list that are own data, each read once, index by index, for SALVAGE only:
 * an accessor or a hole at one index drops that entry, never the others (`readArray`, which decides whether the
 * answer is usable, refuses the whole list). `undefined` for a non-array, a length outside `0..max`, or any
 * reflection failure. Never throws.
 */
function ownEntries(value: unknown, max: number): readonly unknown[] | undefined {
  const whole = readArray(value, max);
  if (whole !== undefined) return whole;
  try {
    if (!Array.isArray(value)) return undefined;
    const length = readField(value, "length");
    if (length.kind !== "DATA" || typeof length.value !== "number" || !Number.isSafeInteger(length.value) || length.value < 0 || length.value > max) return undefined;
    const out: unknown[] = [];
    for (let index = 0; index < length.value; index += 1) {
      const entry = readField(value, String(index));
      if (entry.kind === "DATA") out.push(entry.value);
    }
    return out;
  } catch {
    return undefined;
  }
}

/**
 * (r10, the door audit) One field of an answer some other top-level field of which is not own data, read only when
 * the answer's route is readable and is `route`: an answer from an unknown route keeps nothing.
 */
function fieldOfRightRoute(raw: unknown, route: string, key: string): unknown {
  const read = readField(raw, "route");
  if (read.kind !== "DATA" || read.value !== route) return undefined;
  const value = readField(raw, key);
  return value.kind === "DATA" ? value.value : undefined;
}

/** The open-orders rows of one list, each read once: the valid ones, and the ids of the others (`named`). */
function readOrderRows(list: readonly unknown[] | undefined): {
  readonly out: VenueOrderView[];
  readonly named: Map<string, string | null>;
  readonly rows: VenueOrderView[];
  readonly problem: string | undefined;
} {
  const out: VenueOrderView[] = [];
  const named = new Map<string, string | null>();
  // Every row that validated in full, a repeated one included (r6): each SHOWED its order.
  const rows: VenueOrderView[] = [];
  const seen = new Set<string>();
  let problem: string | undefined;
  for (const entry of list ?? []) {
    const order = readOrderView(entry);
    if (typeof order === "string") {
      problem ??= order;
      const id = rowVenueId(entry);
      if (id !== undefined) keepNamed(named, id, null);
      continue;
    }
    keepNamed(named, order.venueOrderId, order.tokenId);
    rows.push(order);
    if (seen.has(order.venueOrderId)) {
      problem ??= "an open order is listed twice";
      continue;
    }
    seen.add(order.venueOrderId);
    out.push(order);
  }
  return { out, named, rows, problem };
}

/**
 * `/data/orders`: every live order of the account. Every row is read once, whatever the answer's outcome: an
 * INCOMPLETE or MALFORMED answer keeps the ids its rows carry (`named`) and every row that validated in full.
 */
export function readOpenOrders(raw: unknown): ReadOutcome<readonly VenueOrderView[]> {
  const fields = readFields(raw, ["route", "complete", "orders"]);
  if (fields === undefined) {
    const kept = readOrderRows(ownEntries(fieldOfRightRoute(raw, "/data/orders", "orders"), MAX_READ_ENTRIES));
    return malformed("the open-orders answer carries a field that is not own data", kept.named, { rows: kept.rows, legs: [], trades: [] });
  }
  if (fields.route !== "/data/orders") return wrongRoute(fields.route);
  const list = readArray(fields.orders, MAX_READ_ENTRIES);
  // (r10, the door audit) A list one entry of which is not own data is unusable, but its other rows are still read.
  const { out, named, rows, problem } = readOrderRows(list ?? ownEntries(fields.orders, MAX_READ_ENTRIES));
  const salvage: Salvage = { rows, legs: [], trades: [] };
  if (fields.complete !== true) {
    return fields.complete === false ? incomplete(named, salvage) : malformed("the open-orders answer does not say whether it is complete", named, salvage);
  }
  if (list === undefined) return malformed("the open orders are not a list", named, salvage);
  if (problem !== undefined) return malformed(problem, named, salvage);
  return ok(Object.freeze(out));
}

/**
 * (r10, WP290-CX-R10-01) What the `order` field of a by-id answer shows, read once, under the id the row ITSELF
 * carries (never the id asked about): a row that validated in full SHOWED its order (`rows`, and its id with its
 * token in `named`); the id alone of a row that did not only NAMED it. `order` is the row as read (or why it is not one).
 */
function keepOrderField(value: unknown): { readonly order: VenueOrderView | string; readonly named: Map<string, string | null>; readonly salvage: Salvage } {
  const named = new Map<string, string | null>();
  const order = readOrderView(value);
  if (typeof order === "string") {
    const id = rowVenueId(value);
    if (id !== undefined) keepNamed(named, id, null);
    return { order, named, salvage: { rows: [], legs: [], trades: [] } };
  }
  keepNamed(named, order.venueOrderId, order.tokenId);
  return { order, named, salvage: { rows: [order], legs: [], trades: [] } };
}

/**
 * `/data/order`: one order by id, any status (E-14). Only a found answer whose row validated in full and names the
 * order asked about answers it (`OK`), and only `found: false` with no order says it is not found (`OK`, `null`).
 * Every other answer of the right route is MALFORMED for the order asked about, and keeps what its row showed, under
 * the row's own id (r10, WP290-CX-R10-01: a fully valid row, of the order asked about or of another, is SHOWN; the
 * id alone of an invalid row is NAMED).
 */
export function readOrderById(raw: unknown, venueOrderId: string): ReadOutcome<VenueOrderView | null> {
  const fields = readFields(raw, ["route", "found", "order"]);
  if (fields === undefined) {
    const row = fieldOfRightRoute(raw, "/data/order", "order");
    const kept = row === undefined || row === null ? undefined : keepOrderField(row);
    return malformed("the order answer carries a field that is not own data", kept?.named, kept?.salvage);
  }
  if (fields.route !== "/data/order") return wrongRoute(fields.route);
  if (fields.found === false && (fields.order === undefined || fields.order === null)) return ok(null);
  const { order, named, salvage } = keepOrderField(fields.order);
  if (fields.found === false) return malformed("a not-found answer carries an order", named, salvage);
  if (fields.found !== true) return malformed("the order answer does not say whether the order was found", named, salvage);
  if (typeof order === "string") return malformed(order, named, salvage);
  if (order.venueOrderId !== venueOrderId) return malformed("the order answer names another order", named, salvage);
  return ok(order);
}

function readLeg(raw: unknown): VenueTradeLeg | string {
  const fields = readFields(raw, ["venueOrderId", "role", "tokenId", "side", "shares", "price", "feeAmount", "feeAssetId", "matchedAt"]);
  if (fields === undefined) return "a trade leg carries a field that is not own data";
  if (!isVenueId(fields.venueOrderId) || !isTokenId(fields.tokenId)) return "a trade leg's order or token id is not an id";
  if (fields.role !== "MAKER" && fields.role !== "TAKER") return "a trade leg's role is not MAKER or TAKER";
  if (fields.side !== "BUY" && fields.side !== "SELL") return "a trade leg's side is not BUY or SELL";
  if (!isPositiveAmount(fields.shares) || !isUnitPrice(fields.price)) return "a trade leg's shares or price are not exact";
  const fee = fields.feeAmount;
  const feeAsset = fields.feeAssetId;
  if (!(fee === null || isNonNegativeAmount(fee))) return "a trade leg's fee is neither exact nor null";
  if (!(feeAsset === null || isIdentifier(feeAsset))) return "a trade leg's fee asset is not an id";
  if (fee !== null && compareDecimal(fee, "0") > 0 && feeAsset === null) return "a trade leg's fee above zero names no asset";
  if (!isIsoInstant(fields.matchedAt)) return "a trade leg's match time is not an ISO-8601 instant";
  return Object.freeze({
    venueOrderId: fields.venueOrderId,
    role: fields.role,
    tokenId: fields.tokenId,
    side: fields.side,
    shares: fields.shares,
    price: fields.price,
    feeAmount: fee,
    feeAssetId: feeAsset,
    matchedAt: fields.matchedAt,
  });
}

function readTradeView(raw: unknown): VenueTradeView | string {
  const fields = readFields(raw, ["venueTradeId", "status", "transactionHash", "ownLegs", "ownershipUndetermined"]);
  if (fields === undefined) return "a trade carries a field that is not own data";
  if (!isIdentifier(fields.venueTradeId)) return "a trade's id is not an id";
  if (!isIdentifier(fields.status)) return "a trade's status is not text";
  if (!(fields.transactionHash === null || isIdentifier(fields.transactionHash))) return "a trade's transaction hash is neither an id nor null";
  if (typeof fields.ownershipUndetermined !== "boolean") return "a trade does not say whether its ownership is determined";
  const list = readArray(fields.ownLegs, MAX_LEGS_PER_TRADE);
  if (list === undefined) return "a trade's legs are not a list";
  const legs: VenueTradeLeg[] = [];
  const orders = new Set<string>();
  for (const entry of list) {
    const leg = readLeg(entry);
    if (typeof leg === "string") return leg;
    // One fill per (trade, order): the OMS keys fills on it with discriminator "0" (WP-280's convention).
    if (orders.has(leg.venueOrderId)) return "a trade names one own order twice";
    orders.add(leg.venueOrderId);
    legs.push(leg);
  }
  if (legs.length === 0 && !fields.ownershipUndetermined) return "an account trade has no own leg";
  return Object.freeze({
    venueTradeId: fields.venueTradeId,
    status: fields.status,
    transactionHash: fields.transactionHash,
    ownLegs: Object.freeze(legs),
    ownershipUndetermined: fields.ownershipUndetermined,
  });
}

/**
 * The ids a malformed trade row's legs carry, each leg read on its own; every leg that validated in full is kept
 * whole (`salvage`), with the row's trade id and status when those are readable (r6). The row's trade id itself, when
 * readable, is kept as a trade identity (`trades`, shape `MALFORMED`, with its status when that is text), whatever
 * its legs (r9, WP290-CX-R9-01): a leg that fails validation, or a row with no readable leg at all, never drops the
 * identity of the trade the venue reported. Nothing of a malformed leg but its order id is kept. (r10, the door audit)
 * A leg list one entry of which is not own data still keeps its other legs.
 */
function keepLegsOf(named: Map<string, string | null>, salvage: SalvagedLeg[], trades: SalvagedTrade[], row: unknown): boolean {
  const tradeId = readField(row, "venueTradeId");
  const status = readField(row, "status");
  const venueTradeId = tradeId.kind === "DATA" && isIdentifier(tradeId.value) ? tradeId.value : null;
  const statusText = status.kind === "DATA" && isIdentifier(status.value) ? status.value : null;
  if (venueTradeId !== null) trades.push({ venueTradeId, status: statusText, shape: "MALFORMED" });
  const legs = readField(row, "ownLegs");
  // (r10) Whether the row is identified even without its trade id: its leg list readable in full, not empty, every
  // leg valid (each kept, unkeyed), and its ownership determined (its own legs are exactly those).
  const list = legs.kind === "DATA" ? readArray(legs.value, MAX_LEGS_PER_TRADE) : undefined;
  const undetermined = readField(row, "ownershipUndetermined");
  let everyLegKept = list !== undefined && list.length > 0 && undetermined.kind === "DATA" && undetermined.value === false;
  for (const leg of (legs.kind === "DATA" ? ownEntries(legs.value, MAX_LEGS_PER_TRADE) : undefined) ?? []) {
    const valid = readLeg(leg);
    if (typeof valid !== "string") {
      keepNamed(named, valid.venueOrderId, valid.tokenId);
      salvage.push({ venueTradeId, status: statusText, leg: valid });
    } else {
      everyLegKept = false;
      const id = rowVenueId(leg);
      if (id !== undefined) keepNamed(named, id, null);
    }
  }
  return venueTradeId !== null || everyLegKept;
}

/**
 * `/data/trades`: every trade of the account, own legs only. Every row is read once, whatever the answer's
 * outcome: an INCOMPLETE or MALFORMED answer keeps the venue order ids its rows' legs carry (`named`), every leg that
 * validated in full, and (r9) every trade identity its rows carry (`salvage.trades`): a row that validated in full,
 * legless or not, and the readable trade id of a malformed row. (r10, the door audit) So does an answer one of whose
 * top-level fields, or one of whose list entries, is not own data (its route readable and the right one).
 */
export function readTrades(raw: unknown): ReadOutcome<readonly VenueTradeView[]> {
  const fields = readFields(raw, ["route", "complete", "trades"]);
  if (fields === undefined) {
    const kept = readTradeRows(ownEntries(fieldOfRightRoute(raw, "/data/trades", "trades"), MAX_READ_ENTRIES));
    return malformed("the trades answer carries a field that is not own data", kept.named, kept.salvage);
  }
  if (fields.route !== "/data/trades") return wrongRoute(fields.route);
  const list = readArray(fields.trades, MAX_READ_ENTRIES);
  // (r10, the door audit) A list one entry of which is not own data is unusable, but its other rows are still read.
  const rows = readTradeRows(list ?? ownEntries(fields.trades, MAX_READ_ENTRIES));
  const { out, named, problem } = rows;
  // (r10) WHOLE: complete, its list readable, and every row identified: nothing of the account was left out.
  const salvage: Salvage = { ...rows.salvage, whole: fields.complete === true && list !== undefined && rows.identified };
  if (fields.complete !== true) {
    return fields.complete === false ? incomplete(named, salvage) : malformed("the trades answer does not say whether it is complete", named, salvage);
  }
  if (list === undefined) return malformed("the trades are not a list", named, salvage);
  if (problem !== undefined) return malformed(problem, named, salvage);
  return ok(Object.freeze(out));
}

/** The trade rows of one list, each read once: the valid ones, and what every row carries (`named`, `salvage`). */
function readTradeRows(list: readonly unknown[] | undefined): {
  readonly out: VenueTradeView[];
  readonly named: Map<string, string | null>;
  readonly salvage: Salvage;
  readonly problem: string | undefined;
  /** (r10) Every row was identified (`keepLegsOf`): a valid row, a readable trade id, or every own leg kept. */
  readonly identified: boolean;
} {
  const out: VenueTradeView[] = [];
  const named = new Map<string, string | null>();
  const legs: SalvagedLeg[] = [];
  const trades: SalvagedTrade[] = [];
  const seen = new Set<string>();
  let problem: string | undefined;
  let identified = true;
  for (const entry of list ?? []) {
    const trade = readTradeView(entry);
    if (typeof trade === "string") {
      problem ??= trade;
      if (!keepLegsOf(named, legs, trades, entry)) identified = false;
      continue;
    }
    // (r9, WP290-CX-R9-01) The trade's identity and status, whatever its legs: a valid row with no own leg (its
    // ownership undetermined) shows its trade too.
    trades.push({ venueTradeId: trade.venueTradeId, status: trade.status, shape: trade.ownershipUndetermined ? "OWNERSHIP_UNDETERMINED" : "IN_FULL" });
    for (const leg of trade.ownLegs) {
      keepNamed(named, leg.venueOrderId, leg.tokenId);
      legs.push({ venueTradeId: trade.venueTradeId, status: trade.status, leg });
    }
    if (seen.has(trade.venueTradeId)) {
      problem ??= "a trade is listed twice";
      continue;
    }
    seen.add(trade.venueTradeId);
    out.push(trade);
  }
  return { out, named, salvage: { rows: [], legs, trades }, problem, identified };
}

/** `/v2/positions` (Data API v2 only; E-15): token id → size. */
export function readPositions(raw: unknown): ReadOutcome<ReadonlyMap<string, DecimalString>> {
  const fields = readFields(raw, ["route", "complete", "positions"]);
  if (fields === undefined) return malformed("the positions answer carries a field that is not own data");
  if (fields.route !== "/v2/positions") return wrongRoute(fields.route);
  if (fields.complete !== true) return fields.complete === false ? INCOMPLETE : malformed("the positions answer does not say whether it is complete");
  const list = readArray(fields.positions, MAX_READ_ENTRIES);
  if (list === undefined) return malformed("the positions are not a list");
  const out = new Map<string, DecimalString>();
  for (const entry of list) {
    const position = readFields(entry, ["tokenId", "size"]);
    if (position === undefined || !isTokenId(position.tokenId) || !isNonNegativeAmount(position.size)) {
      return malformed("a position is not a token id with an exact non-negative size");
    }
    if (out.has(position.tokenId)) return malformed("a position is listed twice");
    out.set(position.tokenId, position.size);
  }
  return ok(out);
}

/** The collateral balance, from the chain (see `ports.ts` for why not the CLOB cache). */
export function readCollateral(raw: unknown, collateralAssetId: string): ReadOutcome<DecimalString> {
  const fields = readFields(raw, ["source", "assetId", "balance"]);
  if (fields === undefined) return malformed("the collateral answer carries a field that is not own data");
  if (fields.source !== "ONCHAIN_ERC20_BALANCE") return wrongRoute(fields.source);
  if (fields.assetId !== collateralAssetId) return malformed("the collateral answer names another asset");
  if (!isNonNegativeAmount(fields.balance)) return malformed("the collateral balance is not an exact non-negative decimal");
  return ok(fields.balance);
}

/** `/v2/approvals`: spender → approved. */
export function readApprovals(raw: unknown): ReadOutcome<ReadonlyMap<string, boolean>> {
  const fields = readFields(raw, ["route", "approvals"]);
  if (fields === undefined) return malformed("the approvals answer carries a field that is not own data");
  if (fields.route !== "/v2/approvals") return wrongRoute(fields.route);
  const list = readArray(fields.approvals, MAX_READ_ENTRIES);
  if (list === undefined) return malformed("the approvals are not a list");
  const out = new Map<string, boolean>();
  for (const entry of list) {
    const approval = readFields(entry, ["spender", "approved"]);
    if (approval === undefined || !isIdentifier(approval.spender) || typeof approval.approved !== "boolean") {
      return malformed("an approval is not a spender with a boolean");
    }
    if (out.has(approval.spender)) return malformed("an approval is listed twice");
    out.set(approval.spender, approval.approved);
  }
  return ok(out);
}

export const WALLET_MEMBER_STATES = ["CONFIRMED", "FAILED", "PENDING", "DROPPED", "NOT_FOUND", "UNSUPPORTED"] as const;
export type WalletMemberState = (typeof WALLET_MEMBER_STATES)[number];

export interface WalletMemberRead {
  readonly state: WalletMemberState;
  readonly transactionHash: string | null;
  readonly credited: DecimalString | null;
}

/** One wallet-operation member. Anything unrecognised is MALFORMED: it is waited out, never answered. */
export function readWalletMember(raw: unknown): ReadOutcome<WalletMemberRead> {
  const fields = readFields(raw, ["state", "transactionHash", "credited"]);
  if (fields === undefined) return malformed("the member answer carries a field that is not own data");
  if (typeof fields.state !== "string" || !(WALLET_MEMBER_STATES as readonly string[]).includes(fields.state)) {
    return malformed("the member state is not a recognised state");
  }
  if (!(fields.transactionHash === null || isIdentifier(fields.transactionHash))) return malformed("the member hash is neither an id nor null");
  if (!(fields.credited === null || isNonNegativeAmount(fields.credited))) return malformed("the credited amount is neither exact nor null");
  if (fields.state === "CONFIRMED" && fields.transactionHash === null) return malformed("a CONFIRMED member names no transaction hash");
  return ok(Object.freeze({ state: fields.state as WalletMemberState, transactionHash: fields.transactionHash, credited: fields.credited }));
}

/** The holdings projection (`packages/ledger`'s `projectedHoldings`). */
export interface ProjectedHoldingsRead {
  readonly lines: ReadonlyMap<string, { readonly assetKind: "COLLATERAL" | "OUTCOME_TOKEN"; readonly balance: DecimalString }>;
  readonly arrivals: readonly {
    readonly kind: "ACTUAL_ARRIVAL" | "UNEXPLAINED_MOVEMENT";
    readonly ledgerTransactionId: string;
    readonly assetId: string;
    readonly amount: DecimalString;
    readonly marketId: string | null;
  }[];
}

export function readProjectedHoldings(raw: unknown): ReadOutcome<ProjectedHoldingsRead> {
  const fields = readFields(raw, ["lines", "unattributedArrivals"]);
  if (fields === undefined) return malformed("the projection carries a field that is not own data");
  const lines = readArray(fields.lines, MAX_READ_ENTRIES);
  const arrivals = readArray(fields.unattributedArrivals, MAX_READ_ENTRIES);
  if (lines === undefined || arrivals === undefined) return malformed("the projection's lines are not lists");
  const outLines = new Map<string, { readonly assetKind: "COLLATERAL" | "OUTCOME_TOKEN"; readonly balance: DecimalString }>();
  for (const entry of lines) {
    const line = readFields(entry, ["assetId", "assetKind", "balance"]);
    if (line === undefined || !isIdentifier(line.assetId) || (line.assetKind !== "COLLATERAL" && line.assetKind !== "OUTCOME_TOKEN")) {
      return malformed("a projected line is not an asset with a kind");
    }
    if (!isCanonicalDecimalString(line.balance)) return malformed("a projected balance is not an exact decimal");
    if (outLines.has(line.assetId)) return malformed("a projected asset is listed twice");
    outLines.set(line.assetId, Object.freeze({ assetKind: line.assetKind, balance: line.balance }));
  }
  const outArrivals: ProjectedHoldingsRead["arrivals"][number][] = [];
  for (const entry of arrivals) {
    const arrival = readFields(entry, ["kind", "ledgerTransactionId", "assetId", "amount", "marketId"]);
    if (
      arrival === undefined ||
      (arrival.kind !== "ACTUAL_ARRIVAL" && arrival.kind !== "UNEXPLAINED_MOVEMENT") ||
      !isIdentifier(arrival.ledgerTransactionId) ||
      !isIdentifier(arrival.assetId) ||
      !isCanonicalDecimalString(arrival.amount) ||
      !(arrival.marketId === null || isIdentifier(arrival.marketId))
    ) {
      return malformed("a recorded halt obligation is not in its shape");
    }
    outArrivals.push(
      Object.freeze({
        kind: arrival.kind,
        ledgerTransactionId: arrival.ledgerTransactionId,
        assetId: arrival.assetId,
        amount: arrival.amount,
        marketId: arrival.marketId,
      }),
    );
  }
  return ok(Object.freeze({ lines: outLines, arrivals: Object.freeze(outArrivals) }));
}

/** The most assets one fill's remaining booking may name (a guard; a fill books its token, its collateral and a fee). */
export const MAX_BOOKED_ASSETS = 64;

/**
 * The ledger's remaining booking of each FAILED fill asked about (`HoldingsPort.remainingBookings`), keyed by
 * `compositeKey(venueTradeId, venueOrderId)`. Exactly one answer per identity asked: one missing, unasked or
 * repeated is MALFORMED, and so is any amount that is not an exact non-zero decimal.
 */
export function readRemainingBookings(raw: unknown, asked: readonly FillIdentity[]): ReadOutcome<ReadonlyMap<string, readonly BookedAmount[]>> {
  const fields = readFields(raw, ["bookings"]);
  if (fields === undefined) return malformed("the remaining-bookings answer carries a field that is not own data");
  const list = readArray(fields.bookings, MAX_READ_ENTRIES);
  if (list === undefined) return malformed("the remaining bookings are not a list");
  const wanted = new Set(asked.map((fill) => compositeKey(fill.venueTradeId, fill.venueOrderId)));
  const out = new Map<string, readonly BookedAmount[]>();
  for (const entry of list) {
    const booking = readFields(entry, ["venueTradeId", "venueOrderId", "entries"]);
    if (booking === undefined || !isIdentifier(booking.venueTradeId) || !isVenueId(booking.venueOrderId)) return malformed("a remaining booking does not name a fill");
    const key = compositeKey(booking.venueTradeId, booking.venueOrderId);
    if (!wanted.has(key)) return malformed("a remaining booking names a fill that was not asked about");
    if (out.has(key)) return malformed("a fill's remaining booking is answered twice");
    const lines = readArray(booking.entries, MAX_BOOKED_ASSETS);
    if (lines === undefined) return malformed("a remaining booking's entries are not a list");
    const amounts: BookedAmount[] = [];
    const assets = new Set<string>();
    for (const line of lines) {
      const read = readFields(line, ["assetId", "amount"]);
      if (read === undefined || !isIdentifier(read.assetId) || !isCanonicalDecimalString(read.amount) || isZeroDecimal(read.amount)) {
        return malformed("a remaining booking line is not an asset with an exact non-zero amount");
      }
      if (assets.has(read.assetId)) return malformed("a remaining booking names one asset twice");
      assets.add(read.assetId);
      amounts.push(Object.freeze({ assetId: read.assetId, amount: read.amount }));
    }
    out.set(key, Object.freeze(amounts));
  }
  for (const key of wanted) if (!out.has(key)) return malformed("the ledger did not answer for a FAILED fill it was asked about");
  return ok(out);
}

/** `{ ok: true }` (own data), or anything else: a refusal. Never throws. */
export function readOkFlag(raw: unknown): boolean {
  const read = readField(raw, "ok");
  return read.kind === "DATA" && read.value === true;
}

/** The refusal code of a port result, or `UNREADABLE`. */
export function readRefusalCode(raw: unknown): string {
  const refusal = readField(raw, "refusal");
  if (refusal.kind !== "DATA") return "UNREADABLE";
  const code = readField(refusal.value, "code");
  return code.kind === "DATA" && typeof code.value === "string" && /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/u.test(code.value) ? code.value : "UNREADABLE";
}

export { FAILED as READ_FAILED };
