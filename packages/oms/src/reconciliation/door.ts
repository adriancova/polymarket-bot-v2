/**
 * The reconciliation coordinator's DOORS (WP-290): every answer of the {@link AccountReadPort}, of the wallet member
 * read, and every item of a user-stream output is read ONCE, by own data property, into a frozen copy, before
 * anything is decided on it (the WP-300b lesson; `guards.ts`).
 *
 * SALVAGE IS THE DEFAULT PATH (r11, the class fix at the door layer). Every door first reads EVERY field of EVERY
 * row of the answer, each on its own, into FRAGMENTS: a field's value when it validated in isolation, or its name
 * in the row's `unreadable` list when it was present but could not be read (an accessor, a wrong type, an inexact
 * decimal, an id out of its domain, a missing field). An entry of a list that is not own data (an accessor, a hole)
 * is a row every field of which is unreadable: present, never "nothing". Only then is the outcome decided, from
 * those fragments, and EVERY outcome carries them (`ReadOutcome.salvage`, required on every variant: a door cannot
 * return MALFORMED, INCOMPLETE or OK without its salvage). The coordinator records every salvage list through its
 * ONE recording function (`coordinator.ts`, `#recordSalvage`) into the evidence store (`evidence.ts`), whatever the
 * answer's usability, so no validated fact is lost between the wire and the store; and every unreadable fragment of
 * a row is recorded as an explicit UNREADABLE obligation (an unreadable identity: `UNKEYED_ORDER`, `UNKEYED_LEG`,
 * `ORPHAN_LEG`, `UNKEYED_TRADE`; an unreadable fact of a keyed object: the object's own obligation, read again until
 * a sound read shows it in full). (r12, WP290-CX-R12-01) The same holds for the user-stream door's own keys: a
 * WP-280 projection whose `observation`, `fills` or `settlements` key is MISSING carries an unreadable entry (an
 * obligation of the account, and a run), exactly as one whose key is not own data or not in its shape.
 *
 * CLOSED VOCABULARIES (r13, WP290-V13-STREAM-UNKNOWN-KIND-SILENT = WP290-CX-R13-01). A discriminant whose vocabulary
 * is closed by its producer's contract is read against that vocabulary, and a READABLE value outside it is unreadable
 * (an obligation), never "nothing" and never "harmless": a user-stream output's `kind` (WP-280's five outputs:
 * {@link classifyStreamOutput}; a non-activity output that carries an ORDER or TRADE output's own key is unreadable
 * too), and a user-stream settlement's `status` (WP-280's five settlement statuses, `USER_TRADE_STATUSES`). Every other
 * closed discriminant a door reads was already so: a route or source naming another source is WRONG_ROUTE; a side,
 * role, boolean or wallet member state outside its vocabulary is an unreadable fragment (MALFORMED). An order status,
 * a REST trade status and a stream order observation's status are OPEN by their producers' contracts (C-3; WP-280
 * passes order statuses through, and the OMS's vocabulary is wider: `EXPIRED`): they are kept as text, and one outside
 * the documented vocabulary holds (`STATUS_UNRECOGNISED`; the OMS's RECONCILING); a settlement status no one can order
 * is answered only by an observation of the trade at a terminal status (`evidence.ts`, r13).
 *
 * (r14, WP290-V14-WP280-EVENT-IDS-DISCARDED) An EMPTY stream projection is never "nothing" either. WP-280 projects nothing
 * (an ORDER's `observation: null`; a TRADE with no fill and no settlement) exactly for an account event it could NOT
 * project, and says why in `shortfalls`; its event-level reconciliation request names "the identifiers the event named,
 * exactly". So the stream door reads the output's `event` whenever it can (`StreamEventFragments`: an order event's
 * order and facts; a trade event's trade, status, and the legs it attributes to the account), REQUIRES it when the
 * projection is not attested whole (a shortfall, `shortfalls` missing or unreadable, nothing projected: an event, or its
 * id, that cannot be read is then an unreadable entry), and reads every WP-280 request's identities on their own
 * ({@link readStreamRequest}: required for an event-level cause or one outside WP-280's closed vocabulary).
 *
 * (r15, WP290-V15-EFA-REQUEST-STATUS-ASSUMED) A door states what its answer SAYS, never what it implies: a request says
 * whether WP-280 recognised its event's status (`statusRecognised`), never which status that was (a request carries
 * none). The stream door also returns the projection's `shortfalls` as read, so the coordinator can tell an event's
 * output from its request ({@link StreamOutput}).
 *
 * A read has exactly one outcome:
 *
 * | Outcome | Meaning | Break |
 * | --- | --- | --- |
 * | `OK` | the answer is in the port's shape | — |
 * | `FAILED` | the port threw or rejected (nothing was read: empty salvage) | `READ_MISSING` |
 * | `MALFORMED` | outside the shape: an inexact decimal, a bad id, an opaque field, a duplicate, an impossible size | `READ_MALFORMED` |
 * | `INCOMPLETE` | a paginated read did not reach its last page | `READ_INCOMPLETE` |
 * | `WRONG_ROUTE` | the answer names another route (Data API v1, E-15; the CLOB balance cache, U-22) | `READ_WRONG_ROUTE` |
 *
 * None of them is ever read as "empty". The one boundary of the salvage: an answer whose route (or, for the
 * collateral, its source) is READABLE and names ANOTHER source keeps nothing (its rows are another source's, not
 * this door's observation: E-15, U-22); an answer whose route is unreadable keeps every row (its provenance is
 * unknown, so its rows are kept, fail closed). The envelope's own unreadable fields (`route`, `complete`, `found`,
 * the list itself) are listed in `salvage.envelope`; their obligation is the read's own break (`READ_MALFORMED`,
 * `READ_INCOMPLETE` or `READ_WRONG_ROUTE`, keyed by the read, journaled, cleared only by a CONCLUSIVE run whose read
 * of the same door answered in full: `coordinator.ts`, `#resolve`).
 *
 * A by-id answer (r10, WP290-CX-R10-01) keeps its order row under the id the row ITSELF carries, never the one asked
 * about; its `found` flag, when it is `true`, is the venue's statement about the order asked about (E-14: once found,
 * always found by id), and is kept as such (`salvage.found`). Statuses are kept as data: an order or trade status
 * outside the documented vocabulary is not malformed, it is UNRECOGNISED, and the coordinator holds on it
 * (`STATUS_UNRECOGNISED`). Trade statuses are accepted in both documented spellings (E-13, C-5): `TRADE_STATUS_<X>`
 * (REST) and `<X>` (stream).
 *
 * Pure: no I/O, no clock, no randomness.
 */

import { compareDecimal, isCanonicalDecimalString, isZeroDecimal, type DecimalString } from "@polymarket-bot/decimal";

import { compositeKey, isIdentifier, isNonNegativeAmount, isPositiveAmount, isTokenId, isUnitPrice, readArray, readField, readFields, type FieldRead } from "../guards.js";
import { isVenueId } from "../outcomes.js";

import {
  STREAM_EVENT_CAUSES,
  STREAM_PROJECTION_SHORTFALLS,
  STREAM_RECONCILIATION_CAUSES,
  STREAM_STATUS_SHORTFALLS,
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

// ---------------------------------------------------------------------------
// Fragments.

/** The fields of one order row (`VenueOrderView`), each read on its own. */
export const ORDER_FIELDS = ["venueOrderId", "tokenId", "side", "price", "originalSize", "sizeMatched", "status"] as const;
export type OrderField = (typeof ORDER_FIELDS)[number];
/** The fields of one own trade leg (`VenueTradeLeg`). */
export const LEG_FIELDS = ["venueOrderId", "role", "tokenId", "side", "shares", "price", "feeAmount", "feeAssetId", "matchedAt"] as const;
export type LegField = (typeof LEG_FIELDS)[number];
/** The fields of one trade row (`VenueTradeView`). `ownLegs` is unreadable when the list itself is (an entry that is not: a leg every field of which is unreadable). */
export const TRADE_FIELDS = ["venueTradeId", "status", "transactionHash", "ownershipUndetermined", "ownLegs"] as const;
export type TradeField = (typeof TRADE_FIELDS)[number];
/** The fields of one holding: a position (`tokenId`, `size`), the collateral (`assetId`, `balance`), an approval (`spender`, `approved`). */
export const HOLDING_FIELDS = ["tokenId", "size", "assetId", "balance", "spender", "approved"] as const;
export type HoldingField = (typeof HOLDING_FIELDS)[number];
/** The fields of one wallet member read. */
export const MEMBER_FIELDS = ["state", "transactionHash", "credited"] as const;
export type MemberField = (typeof MEMBER_FIELDS)[number];
/** The fields of one user-stream item (WP-280's OMS inputs): an order observation, a fill, a settlement. */
export const STREAM_FIELDS = ["venueOrderId", "venueTradeId", "status", "shares", "price", "liquidityRole", "feeAmount", "feeAssetId", "matchedAt", "transactionHash"] as const;
export type StreamField = (typeof STREAM_FIELDS)[number];
/**
 * An answer's own fields. (r14) A user-stream output's `event` and its projection's `shortfalls`, and a WP-280
 * request's `venueOrderIds` (its `venueTradeId` is a stream field).
 */
export const ENVELOPE_FIELDS = [
  "route",
  "complete",
  "found",
  "order",
  "orders",
  "trades",
  "positions",
  "approvals",
  "source",
  "fills",
  "settlements",
  "observation",
  "oms",
  "kind",
  "event",
  "shortfalls",
  "venueOrderIds",
] as const;
export type EnvelopeField = (typeof ENVELOPE_FIELDS)[number];
/**
 * (r14, WP290-V14-WP280-EVENT-IDS-DISCARDED) The fields of WP-280's normalized EVENT (`normalize.ts`,
 * `NormalizedOrderEvent` and `NormalizedTradeEvent`) the stream door reads: an order event's order and its facts; a
 * trade event's trade, status, trader side, taker order, maker legs and transaction hash.
 */
export const EVENT_FIELDS = [
  "venueOrderId",
  "assetId",
  "side",
  "price",
  "originalSize",
  "sizeMatched",
  "status",
  "venueTradeId",
  "traderSide",
  "takerOrderId",
  "makerOrders",
  "transactionHash",
] as const;
export type EventField = (typeof EVENT_FIELDS)[number];

/**
 * What one order row SHOWED, field by field (r11): each field's value when it validated on its own, `null` when it
 * did not (and then its name is in `unreadable`). `inFull` is the row when every field validated and the row is
 * consistent (its matched size not above its original size); only such a row SHOWED its order.
 */
export interface OrderFragments {
  readonly venueOrderId: string | null;
  readonly tokenId: string | null;
  readonly side: "BUY" | "SELL" | null;
  readonly price: DecimalString | null;
  readonly originalSize: DecimalString | null;
  readonly sizeMatched: DecimalString | null;
  readonly status: string | null;
  readonly unreadable: readonly OrderField[];
  readonly inFull: VenueOrderView | null;
}

/**
 * What one own trade leg SHOWED, field by field (r11). `feeAmount` and `feeAssetId` may be validly `null` (the venue
 * fixed no fee, or no fee asset): a `null` value is unreadable only when its name is in `unreadable`.
 */
export interface LegFragments {
  readonly venueOrderId: string | null;
  readonly role: "MAKER" | "TAKER" | null;
  readonly tokenId: string | null;
  readonly side: "BUY" | "SELL" | null;
  readonly shares: DecimalString | null;
  readonly price: DecimalString | null;
  readonly feeAmount: DecimalString | null;
  readonly feeAssetId: string | null;
  readonly matchedAt: string | null;
  readonly unreadable: readonly LegField[];
  readonly inFull: VenueTradeLeg | null;
}

/** What one trade row SHOWED, field by field (r11), its every leg entry included. */
export interface TradeFragments {
  readonly venueTradeId: string | null;
  /** The row's status as read (text only, never interpreted here). */
  readonly status: string | null;
  /** May be validly `null`; unreadable only when listed. */
  readonly transactionHash: string | null;
  readonly ownershipUndetermined: boolean | null;
  /** Every entry of the row's leg list (an entry that is not own data: a leg every field of which is unreadable). */
  readonly legs: readonly LegFragments[];
  readonly unreadable: readonly TradeField[];
  readonly inFull: VenueTradeView | null;
  /**
   * (r10) The row is IDENTIFIED: its trade id is readable, or its leg list is readable in full, not empty, every leg
   * validated in full, and its ownership is determined (its own legs are exactly those).
   */
  readonly identified: boolean;
}

/** One holding a positions, collateral or approvals answer SHOWED (r11). */
export interface HoldingFragments {
  readonly kind: "POSITION" | "COLLATERAL" | "APPROVAL";
  /** A position's token id, the collateral's asset id, an approval's spender; `null` when unreadable. */
  readonly key: string | null;
  /** A position's size, the collateral balance, an approval's flag (`"true"`, `"false"`); `null` when unreadable. */
  readonly value: string | null;
  readonly unreadable: readonly HoldingField[];
}

/** What one wallet member read SHOWED (r11). `transactionHash` and `credited` may be validly `null`. */
export interface MemberFragments {
  readonly state: WalletMemberState | null;
  readonly transactionHash: string | null;
  readonly credited: DecimalString | null;
  readonly unreadable: readonly MemberField[];
}

/**
 * EVERYTHING an answer showed (r11), whatever its outcome: every row of it as fragments, and the envelope's own
 * fields that were present but unreadable. Empty only for a FAILED read (nothing was read), for an answer of another
 * readable route or source (another source's rows, E-15, U-22), and for the ledger's own projection and bookings
 * (the system's own state, not a venue observation).
 */
export interface Salvage {
  readonly orders: readonly OrderFragments[];
  readonly trades: readonly TradeFragments[];
  readonly holdings: readonly HoldingFragments[];
  readonly members: readonly MemberFragments[];
  /** The answer's own fields present but unreadable (the read's own break is their obligation). */
  readonly envelope: readonly EnvelopeField[];
  /**
   * (r10, WP290-V10-UNKEYED-LEG-DISCHARGED) Trades answers only: the answer said it was complete, its route was the
   * right one, its fields and its list were readable, and EVERY row of it was identified, so no trade of the account
   * is missing from what was kept. An unkeyed leg of an answer that is not whole may be any trade the answer left out:
   * no later read can answer it.
   */
  readonly whole: boolean;
  /** (r11) By-id answers only: the answer's `found` flag when it is readable (`true`: the order asked about exists). */
  readonly found: boolean | null;
}

export type ReadOutcome<T> =
  | { readonly kind: "OK"; readonly value: T; readonly salvage: Salvage }
  | { readonly kind: "FAILED"; readonly salvage: Salvage }
  | { readonly kind: "MALFORMED"; readonly why: string; readonly salvage: Salvage }
  | { readonly kind: "INCOMPLETE"; readonly salvage: Salvage }
  | { readonly kind: "WRONG_ROUTE"; readonly route: string; readonly salvage: Salvage };

/** The longest list a read may return (a guard; no venue fact bounds it). */
export const MAX_READ_ENTRIES = 50_000;
/** The most own legs one trade may carry. */
export const MAX_LEGS_PER_TRADE = 64;

/** Nothing was read (a failed read; an answer of another readable source). */
export const EMPTY_SALVAGE: Salvage = Object.freeze({
  orders: Object.freeze([]),
  trades: Object.freeze([]),
  holdings: Object.freeze([]),
  members: Object.freeze([]),
  envelope: Object.freeze([]),
  whole: false,
  found: null,
});

const FAILED: ReadOutcome<never> = Object.freeze({ kind: "FAILED", salvage: EMPTY_SALVAGE });

/** The salvage of an answer: frozen copies, every list present. */
function salvageOf(parts: Partial<Salvage>): Salvage {
  return Object.freeze({
    orders: Object.freeze([...(parts.orders ?? [])]),
    trades: Object.freeze([...(parts.trades ?? [])]),
    holdings: Object.freeze([...(parts.holdings ?? [])]),
    members: Object.freeze([...(parts.members ?? [])]),
    envelope: Object.freeze([...new Set(parts.envelope ?? [])].sort()),
    whole: parts.whole === true,
    found: parts.found ?? null,
  });
}

function ok<T>(value: T, salvage: Salvage): ReadOutcome<T> {
  return Object.freeze({ kind: "OK", value, salvage });
}

function malformed<T>(why: string, salvage: Salvage): ReadOutcome<T> {
  return Object.freeze({ kind: "MALFORMED", why, salvage });
}

function incomplete<T>(salvage: Salvage): ReadOutcome<T> {
  return Object.freeze({ kind: "INCOMPLETE", salvage });
}

function wrongRoute<T>(route: unknown, salvage: Salvage): ReadOutcome<T> {
  return Object.freeze({ kind: "WRONG_ROUTE", route: typeof route === "string" ? route.slice(0, 64) : "unreadable", salvage });
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

// ---------------------------------------------------------------------------
// Reading once.

/** An entry of a list that is not own data (an accessor, a hole, an index that throws): present, but unreadable. */
const UNREADABLE_ENTRY: unique symbol = Symbol("unreadable entry");
type Entry = unknown;

const OPAQUE_READ: FieldRead = Object.freeze({ kind: "OPAQUE" });

function isRecord(value: unknown): value is object {
  return value !== null && typeof value === "object";
}

/** Every field of one row, each read exactly once (an unreadable entry: every field OPAQUE). */
function readRow<K extends string>(raw: Entry, keys: readonly K[]): Readonly<Record<K, FieldRead>> {
  const out = {} as Record<K, FieldRead>;
  for (const key of keys) out[key] = raw === UNREADABLE_ENTRY ? OPAQUE_READ : readField(raw, key);
  return out;
}

/**
 * Every entry of a list, each index read exactly once: the entry's value, or {@link UNREADABLE_ENTRY} for an index
 * that is not own data. `whole` when every entry is own data (the list as `readArray` accepts it). `undefined` for a
 * value that is not an array, or whose length is unreadable or outside `0..max`. Never throws.
 */
function listEntries(value: unknown, max: number): { readonly entries: readonly Entry[]; readonly whole: boolean } | undefined {
  try {
    if (!Array.isArray(value)) return undefined;
    const length = readField(value, "length");
    if (length.kind !== "DATA" || typeof length.value !== "number" || !Number.isSafeInteger(length.value) || length.value < 0 || length.value > max) return undefined;
    const entries: Entry[] = [];
    let whole = true;
    for (let index = 0; index < length.value; index += 1) {
      const entry = readField(value, String(index));
      if (entry.kind === "DATA") {
        entries.push(entry.value);
      } else {
        whole = false;
        entries.push(UNREADABLE_ENTRY);
      }
    }
    return { entries, whole };
  } catch {
    return undefined;
  }
}

/** A field's value when it validated on its own, else `null` with its name pushed to `unreadable`. */
function keep<K extends string, T>(read: Readonly<Record<K, FieldRead>>, key: K, valid: (value: unknown) => value is T, unreadable: K[]): T | null {
  const field = read[key];
  if (field.kind === "DATA" && valid(field.value)) return field.value;
  unreadable.push(key);
  return null;
}

function isSide(value: unknown): value is "BUY" | "SELL" {
  return value === "BUY" || value === "SELL";
}

function isRole(value: unknown): value is "MAKER" | "TAKER" {
  return value === "MAKER" || value === "TAKER";
}

function isNullOr<T>(valid: (value: unknown) => value is T): (value: unknown) => value is T | null {
  return (value: unknown): value is T | null => value === null || valid(value);
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function dataOf(read: FieldRead): unknown {
  return read.kind === "DATA" ? read.value : undefined;
}

function anyOpaque<K extends string>(read: Readonly<Record<K, FieldRead>>, keys: readonly K[]): boolean {
  return keys.some((key) => read[key].kind === "OPAQUE");
}

// ---------------------------------------------------------------------------
// Rows.

/** One order row, read once: its fragments, and why it is not in full (the message of the first check that fails). */
export function orderFragments(raw: Entry): { readonly fragments: OrderFragments; readonly problem: string | undefined } {
  const read = readRow(raw, ORDER_FIELDS);
  const unreadable: OrderField[] = [];
  const venueOrderId = keep(read, "venueOrderId", isVenueId, unreadable);
  const tokenId = keep(read, "tokenId", isTokenId, unreadable);
  const side = keep(read, "side", isSide, unreadable);
  const price = keep(read, "price", isUnitPrice, unreadable);
  const originalSize = keep(read, "originalSize", isPositiveAmount, unreadable);
  const sizeMatched = keep(read, "sizeMatched", isNonNegativeAmount, unreadable);
  const status = keep(read, "status", isIdentifier, unreadable);
  let problem: string | undefined;
  if (!isRecord(raw) || anyOpaque(read, ORDER_FIELDS)) problem = "an order carries a field that is not own data";
  else if (venueOrderId === null) problem = "an order's venue id is not a venue id";
  else if (tokenId === null) problem = "an order's token id is not a token id";
  else if (side === null) problem = "an order's side is not BUY or SELL";
  else if (price === null) problem = "an order's price is not an exact price in [0, 1]";
  else if (originalSize === null || sizeMatched === null) problem = "an order's sizes are not exact";
  else if (compareDecimal(sizeMatched, originalSize) > 0) problem = "an order's matched size exceeds its original size";
  else if (status === null) problem = "an order's status is not text";
  const inFull =
    problem === undefined && venueOrderId !== null && tokenId !== null && side !== null && price !== null && originalSize !== null && sizeMatched !== null && status !== null
      ? Object.freeze({ venueOrderId, tokenId, side, price, originalSize, sizeMatched, status })
      : null;
  return { fragments: Object.freeze({ venueOrderId, tokenId, side, price, originalSize, sizeMatched, status, unreadable: Object.freeze(unreadable), inFull }), problem };
}

/** One own trade leg, read once: its fragments, and why it is not in full. */
export function legFragments(raw: Entry): { readonly fragments: LegFragments; readonly problem: string | undefined } {
  const read = readRow(raw, LEG_FIELDS);
  const unreadable: LegField[] = [];
  const venueOrderId = keep(read, "venueOrderId", isVenueId, unreadable);
  const role = keep(read, "role", isRole, unreadable);
  const tokenId = keep(read, "tokenId", isTokenId, unreadable);
  const side = keep(read, "side", isSide, unreadable);
  const shares = keep(read, "shares", isPositiveAmount, unreadable);
  const price = keep(read, "price", isUnitPrice, unreadable);
  const feeAmount = keep(read, "feeAmount", isNullOr(isNonNegativeAmount), unreadable);
  const feeAssetId = keep(read, "feeAssetId", isNullOr(isIdentifier), unreadable);
  const matchedAt = keep(read, "matchedAt", isIsoInstant, unreadable);
  const missing = (key: LegField): boolean => unreadable.includes(key);
  let problem: string | undefined;
  if (!isRecord(raw) || anyOpaque(read, LEG_FIELDS)) problem = "a trade leg carries a field that is not own data";
  else if (missing("venueOrderId") || missing("tokenId")) problem = "a trade leg's order or token id is not an id";
  else if (missing("role")) problem = "a trade leg's role is not MAKER or TAKER";
  else if (missing("side")) problem = "a trade leg's side is not BUY or SELL";
  else if (missing("shares") || missing("price")) problem = "a trade leg's shares or price are not exact";
  else if (missing("feeAmount")) problem = "a trade leg's fee is neither exact nor null";
  else if (missing("feeAssetId")) problem = "a trade leg's fee asset is not an id";
  else if (feeAmount !== null && compareDecimal(feeAmount, "0") > 0 && feeAssetId === null) problem = "a trade leg's fee above zero names no asset";
  else if (missing("matchedAt")) problem = "a trade leg's match time is not an ISO-8601 instant";
  const inFull =
    problem === undefined && venueOrderId !== null && role !== null && tokenId !== null && side !== null && shares !== null && price !== null && matchedAt !== null
      ? Object.freeze({ venueOrderId, role, tokenId, side, shares, price, feeAmount, feeAssetId, matchedAt })
      : null;
  return {
    fragments: Object.freeze({ venueOrderId, role, tokenId, side, shares, price, feeAmount, feeAssetId, matchedAt, unreadable: Object.freeze(unreadable), inFull }),
    problem,
  };
}

/** One trade row, read once (its every leg entry included): its fragments, and why it is not in full. */
export function tradeFragments(raw: Entry): { readonly fragments: TradeFragments; readonly problem: string | undefined } {
  const read = readRow(raw, TRADE_FIELDS);
  const unreadable: TradeField[] = [];
  const venueTradeId = keep(read, "venueTradeId", isIdentifier, unreadable);
  const status = keep(read, "status", isIdentifier, unreadable);
  const transactionHash = keep(read, "transactionHash", isNullOr(isIdentifier), unreadable);
  const ownershipUndetermined = keep(read, "ownershipUndetermined", isBoolean, unreadable);
  const list = read.ownLegs.kind === "DATA" ? listEntries(read.ownLegs.value, MAX_LEGS_PER_TRADE) : undefined;
  if (list === undefined) unreadable.push("ownLegs");
  const legReads = (list?.entries ?? []).map(legFragments);
  const legs = legReads.map((entry) => entry.fragments);
  let problem: string | undefined;
  if (!isRecord(raw) || anyOpaque(read, TRADE_FIELDS)) problem = "a trade carries a field that is not own data";
  else if (venueTradeId === null) problem = "a trade's id is not an id";
  else if (status === null) problem = "a trade's status is not text";
  else if (unreadable.includes("transactionHash")) problem = "a trade's transaction hash is neither an id nor null";
  else if (ownershipUndetermined === null) problem = "a trade does not say whether its ownership is determined";
  else if (list === undefined || !list.whole) problem = "a trade's legs are not a list";
  else {
    const orders = new Set<string>();
    for (const leg of legReads) {
      if (leg.problem !== undefined) {
        problem = leg.problem;
        break;
      }
      const id = leg.fragments.venueOrderId as string;
      // One fill per (trade, order): the OMS keys fills on it with discriminator "0" (WP-280's convention).
      if (orders.has(id)) {
        problem = "a trade names one own order twice";
        break;
      }
      orders.add(id);
    }
    if (problem === undefined && legs.length === 0 && ownershipUndetermined === false) problem = "an account trade has no own leg";
  }
  const inFull =
    problem === undefined && venueTradeId !== null && status !== null && ownershipUndetermined !== null
      ? Object.freeze({
          venueTradeId,
          status,
          transactionHash,
          ownLegs: Object.freeze(legs.map((leg) => leg.inFull as VenueTradeLeg)),
          ownershipUndetermined,
        })
      : null;
  // (r10) Identified even without its trade id: its leg list readable in full, not empty, every leg valid (each kept,
  // unkeyed), and its ownership determined (its own legs are exactly those).
  const everyLegKept = list !== undefined && list.whole && legs.length > 0 && ownershipUndetermined === false && legs.every((leg) => leg.inFull !== null);
  return {
    fragments: Object.freeze({
      venueTradeId,
      status,
      transactionHash,
      ownershipUndetermined,
      legs: Object.freeze(legs),
      unreadable: Object.freeze(unreadable),
      inFull,
      identified: venueTradeId !== null || everyLegKept,
    }),
    problem,
  };
}

/** The envelope fields of an answer, read once each; the names of those present but unreadable go to `unreadable`. */
function readEnvelope<K extends EnvelopeField>(raw: unknown, keys: readonly K[]): { readonly read: Readonly<Record<K, FieldRead>>; readonly opaque: boolean } {
  const read = readRow(isRecord(raw) ? raw : UNREADABLE_ENTRY, keys);
  return { read, opaque: !isRecord(raw) || anyOpaque(read, keys) };
}

/**
 * The route of an answer: `RIGHT`, `OTHER` (readable, another source: nothing of it is kept, E-15) or `UNREADABLE`
 * (missing, not text, not own data: its rows are kept, fail closed).
 */
function routeOf(read: FieldRead, route: string): "RIGHT" | "OTHER" | "UNREADABLE" {
  if (read.kind !== "DATA" || typeof read.value !== "string") return "UNREADABLE";
  return read.value === route ? "RIGHT" : "OTHER";
}

// ---------------------------------------------------------------------------
// The doors.

/**
 * `/data/orders`: every live order of the account. Every row is read once into fragments, whatever the answer's
 * outcome (salvage is the default path).
 */
export function readOpenOrders(raw: unknown): ReadOutcome<readonly VenueOrderView[]> {
  const { read, opaque } = readEnvelope(raw, ["route", "complete", "orders"] as const);
  const route = routeOf(read.route, "/data/orders");
  const list = route !== "OTHER" && read.orders.kind === "DATA" ? listEntries(read.orders.value, MAX_READ_ENTRIES) : undefined;
  const rows = (list?.entries ?? []).map(orderFragments);
  const envelope: EnvelopeField[] = [];
  if (route === "UNREADABLE") envelope.push("route");
  if (read.complete.kind !== "DATA" || typeof read.complete.value !== "boolean") envelope.push("complete");
  if (list === undefined || !list.whole) envelope.push("orders");
  const salvage = route === "OTHER" ? EMPTY_SALVAGE : salvageOf({ orders: rows.map((row) => row.fragments), envelope });
  if (opaque) return malformed("the open-orders answer carries a field that is not own data", salvage);
  if (route !== "RIGHT") return wrongRoute(dataOf(read.route), salvage);
  const complete = dataOf(read.complete);
  if (complete !== true) return complete === false ? incomplete(salvage) : malformed("the open-orders answer does not say whether it is complete", salvage);
  if (list === undefined || !list.whole) return malformed("the open orders are not a list", salvage);
  const out: VenueOrderView[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.problem !== undefined) return malformed(row.problem, salvage);
    const order = row.fragments.inFull as VenueOrderView;
    if (seen.has(order.venueOrderId)) return malformed("an open order is listed twice", salvage);
    seen.add(order.venueOrderId);
    out.push(order);
  }
  return ok(Object.freeze(out), salvage);
}

/**
 * `/data/order`: one order by id, any status (E-14). Only a found answer whose row validated in full and names the
 * order asked about answers it (`OK`), and only `found: false` with no order says it is not found (`OK`, `null`).
 * Every other answer of a route that is not another one is MALFORMED for the order asked about, and keeps what its
 * row showed, as fragments, under the row's OWN id (r10, WP290-CX-R10-01: never the id asked about; a row whose id is
 * unreadable is an unkeyed row). `found: true` is kept as the venue's statement that the order asked about exists.
 */
export function readOrderById(raw: unknown, venueOrderId: string): ReadOutcome<VenueOrderView | null> {
  const { read, opaque } = readEnvelope(raw, ["route", "found", "order"] as const);
  const route = routeOf(read.route, "/data/order");
  const orderField = read.order;
  // The row, when the answer carries one: an `order` that is absent or `null` carries none; one that is not own data
  // is a row present but unreadable.
  const carried = orderField.kind === "OPAQUE" || (orderField.kind === "DATA" && orderField.value !== undefined && orderField.value !== null);
  const row = carried && route !== "OTHER" ? orderFragments(orderField.kind === "DATA" ? orderField.value : UNREADABLE_ENTRY) : undefined;
  const found = read.found.kind === "DATA" && typeof read.found.value === "boolean" ? read.found.value : null;
  const envelope: EnvelopeField[] = [];
  if (route === "UNREADABLE") envelope.push("route");
  if (found === null) envelope.push("found");
  // A found answer that carries no row: the order exists, and its row is missing.
  if (found === true && row === undefined) envelope.push("order");
  const salvage = route === "OTHER" ? EMPTY_SALVAGE : salvageOf({ orders: row === undefined ? [] : [row.fragments], envelope, found });
  if (opaque) return malformed("the order answer carries a field that is not own data", salvage);
  if (route !== "RIGHT") return wrongRoute(dataOf(read.route), salvage);
  if (found === false && row === undefined) return ok(null, salvage);
  if (found === false) return malformed("a not-found answer carries an order", salvage);
  if (found !== true) return malformed("the order answer does not say whether the order was found", salvage);
  if (row === undefined) return malformed("an order carries a field that is not own data", salvage);
  if (row.problem !== undefined) return malformed(row.problem, salvage);
  const order = row.fragments.inFull as VenueOrderView;
  if (order.venueOrderId !== venueOrderId) return malformed("the order answer names another order", salvage);
  return ok(order, salvage);
}

/**
 * `/data/trades`: every trade of the account, own legs only. Every row is read once into fragments (its every leg
 * included), whatever the answer's outcome.
 */
export function readTrades(raw: unknown): ReadOutcome<readonly VenueTradeView[]> {
  const { read, opaque } = readEnvelope(raw, ["route", "complete", "trades"] as const);
  const route = routeOf(read.route, "/data/trades");
  const list = route !== "OTHER" && read.trades.kind === "DATA" ? listEntries(read.trades.value, MAX_READ_ENTRIES) : undefined;
  const rows = (list?.entries ?? []).map(tradeFragments);
  const complete = dataOf(read.complete);
  const envelope: EnvelopeField[] = [];
  if (route === "UNREADABLE") envelope.push("route");
  if (typeof complete !== "boolean") envelope.push("complete");
  if (list === undefined || !list.whole) envelope.push("trades");
  // (r10) WHOLE: complete, its route and list readable, and every row identified: nothing of the account was left out.
  const whole = !opaque && route === "RIGHT" && complete === true && list !== undefined && list.whole && rows.every((row) => row.fragments.identified);
  const salvage = route === "OTHER" ? EMPTY_SALVAGE : salvageOf({ trades: rows.map((row) => row.fragments), envelope, whole });
  if (opaque) return malformed("the trades answer carries a field that is not own data", salvage);
  if (route !== "RIGHT") return wrongRoute(dataOf(read.route), salvage);
  if (complete !== true) return complete === false ? incomplete(salvage) : malformed("the trades answer does not say whether it is complete", salvage);
  if (list === undefined || !list.whole) return malformed("the trades are not a list", salvage);
  const out: VenueTradeView[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.problem !== undefined) return malformed(row.problem, salvage);
    const trade = row.fragments.inFull as VenueTradeView;
    if (seen.has(trade.venueTradeId)) return malformed("a trade is listed twice", salvage);
    seen.add(trade.venueTradeId);
    out.push(trade);
  }
  return ok(Object.freeze(out), salvage);
}

/** One holding row, read once: its fragments, and whether the row is not a record or one of its fields is not own data. */
function holdingFragments(raw: Entry, kind: HoldingFragments["kind"]): { readonly fragments: HoldingFragments; readonly opaque: boolean } {
  const unreadable: HoldingField[] = [];
  const keys = kind === "POSITION" ? (["tokenId", "size"] as const) : kind === "COLLATERAL" ? (["assetId", "balance"] as const) : (["spender", "approved"] as const);
  const read = readRow<HoldingField>(raw, keys);
  const opaque = !isRecord(raw) || anyOpaque(read, keys);
  let key: string | null;
  let value: string | null;
  if (kind === "POSITION") {
    key = keep(read, "tokenId", isTokenId, unreadable);
    value = keep(read, "size", isNonNegativeAmount, unreadable);
  } else if (kind === "COLLATERAL") {
    key = keep(read, "assetId", isIdentifier, unreadable);
    value = keep(read, "balance", isNonNegativeAmount, unreadable);
  } else {
    key = keep(read, "spender", isIdentifier, unreadable);
    const approved = keep(read, "approved", isBoolean, unreadable);
    value = approved === null ? null : String(approved);
  }
  return { fragments: Object.freeze({ kind, key, value, unreadable: Object.freeze(unreadable) }), opaque };
}

/** `/v2/positions` (Data API v2 only; E-15): token id → size. Every row is read once into fragments. */
export function readPositions(raw: unknown): ReadOutcome<ReadonlyMap<string, DecimalString>> {
  const { read, opaque } = readEnvelope(raw, ["route", "complete", "positions"] as const);
  const route = routeOf(read.route, "/v2/positions");
  const list = route !== "OTHER" && read.positions.kind === "DATA" ? listEntries(read.positions.value, MAX_READ_ENTRIES) : undefined;
  const rows = (list?.entries ?? []).map((entry) => holdingFragments(entry, "POSITION"));
  const complete = dataOf(read.complete);
  const envelope: EnvelopeField[] = [];
  if (route === "UNREADABLE") envelope.push("route");
  if (typeof complete !== "boolean") envelope.push("complete");
  if (list === undefined || !list.whole) envelope.push("positions");
  const salvage = route === "OTHER" ? EMPTY_SALVAGE : salvageOf({ holdings: rows.map((row) => row.fragments), envelope });
  if (opaque) return malformed("the positions answer carries a field that is not own data", salvage);
  if (route !== "RIGHT") return wrongRoute(dataOf(read.route), salvage);
  if (complete !== true) return complete === false ? incomplete(salvage) : malformed("the positions answer does not say whether it is complete", salvage);
  if (list === undefined || !list.whole) return malformed("the positions are not a list", salvage);
  const out = new Map<string, DecimalString>();
  for (const { fragments: row, opaque: rowOpaque } of rows) {
    if (rowOpaque || row.key === null || row.value === null) return malformed("a position is not a token id with an exact non-negative size", salvage);
    if (out.has(row.key)) return malformed("a position is listed twice", salvage);
    out.set(row.key, row.value);
  }
  return ok(out, salvage);
}

/** The collateral balance, from the chain (see `ports.ts` for why not the CLOB cache). Read once into fragments. */
export function readCollateral(raw: unknown, collateralAssetId: string): ReadOutcome<DecimalString> {
  const source = readField(raw, "source");
  const route = routeOf(source, "ONCHAIN_ERC20_BALANCE");
  const holding = holdingFragments(isRecord(raw) ? raw : UNREADABLE_ENTRY, "COLLATERAL");
  const salvage = route === "OTHER" ? EMPTY_SALVAGE : salvageOf({ holdings: [holding.fragments], envelope: route === "UNREADABLE" ? ["source"] : [] });
  if (!isRecord(raw) || source.kind === "OPAQUE" || holding.opaque) return malformed("the collateral answer carries a field that is not own data", salvage);
  if (route !== "RIGHT") return wrongRoute(dataOf(source), salvage);
  if (holding.fragments.key !== collateralAssetId) return malformed("the collateral answer names another asset", salvage);
  if (holding.fragments.value === null) return malformed("the collateral balance is not an exact non-negative decimal", salvage);
  return ok(holding.fragments.value, salvage);
}

/** `/v2/approvals`: spender → approved. Every row is read once into fragments. */
export function readApprovals(raw: unknown): ReadOutcome<ReadonlyMap<string, boolean>> {
  const { read, opaque } = readEnvelope(raw, ["route", "approvals"] as const);
  const route = routeOf(read.route, "/v2/approvals");
  const list = route !== "OTHER" && read.approvals.kind === "DATA" ? listEntries(read.approvals.value, MAX_READ_ENTRIES) : undefined;
  const rows = (list?.entries ?? []).map((entry) => holdingFragments(entry, "APPROVAL"));
  const envelope: EnvelopeField[] = [];
  if (route === "UNREADABLE") envelope.push("route");
  if (list === undefined || !list.whole) envelope.push("approvals");
  const salvage = route === "OTHER" ? EMPTY_SALVAGE : salvageOf({ holdings: rows.map((row) => row.fragments), envelope });
  if (opaque) return malformed("the approvals answer carries a field that is not own data", salvage);
  if (route !== "RIGHT") return wrongRoute(dataOf(read.route), salvage);
  if (list === undefined || !list.whole) return malformed("the approvals are not a list", salvage);
  const out = new Map<string, boolean>();
  for (const { fragments: row, opaque: rowOpaque } of rows) {
    if (rowOpaque || row.key === null || row.value === null) return malformed("an approval is not a spender with a boolean", salvage);
    if (out.has(row.key)) return malformed("an approval is listed twice", salvage);
    out.set(row.key, row.value === "true");
  }
  return ok(out, salvage);
}

export const WALLET_MEMBER_STATES = ["CONFIRMED", "FAILED", "PENDING", "DROPPED", "NOT_FOUND", "UNSUPPORTED"] as const;
export type WalletMemberState = (typeof WALLET_MEMBER_STATES)[number];

export interface WalletMemberRead {
  readonly state: WalletMemberState;
  readonly transactionHash: string | null;
  readonly credited: DecimalString | null;
}

function isMemberState(value: unknown): value is WalletMemberState {
  return typeof value === "string" && (WALLET_MEMBER_STATES as readonly string[]).includes(value);
}

/** One wallet-operation member, read once into fragments. Anything unrecognised is MALFORMED: it is waited out, never answered. */
export function readWalletMember(raw: unknown): ReadOutcome<WalletMemberRead> {
  const read = readRow(isRecord(raw) ? raw : UNREADABLE_ENTRY, MEMBER_FIELDS);
  const unreadable: MemberField[] = [];
  const state = keep(read, "state", isMemberState, unreadable);
  const transactionHash = keep(read, "transactionHash", isNullOr(isIdentifier), unreadable);
  const credited = keep(read, "credited", isNullOr(isNonNegativeAmount), unreadable);
  const salvage = salvageOf({ members: [Object.freeze({ state, transactionHash, credited, unreadable: Object.freeze(unreadable) })] });
  if (!isRecord(raw) || anyOpaque(read, MEMBER_FIELDS)) return malformed("the member answer carries a field that is not own data", salvage);
  if (state === null) return malformed("the member state is not a recognised state", salvage);
  if (unreadable.includes("transactionHash")) return malformed("the member hash is neither an id nor null", salvage);
  if (unreadable.includes("credited")) return malformed("the credited amount is neither exact nor null", salvage);
  if (state === "CONFIRMED" && transactionHash === null) return malformed("a CONFIRMED member names no transaction hash", salvage);
  return ok(Object.freeze({ state, transactionHash, credited }), salvage);
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

/** The ledger's own projection (the system's state, not a venue observation: it keeps no salvage, `EMPTY_SALVAGE`). */
export function readProjectedHoldings(raw: unknown): ReadOutcome<ProjectedHoldingsRead> {
  const fields = readFields(raw, ["lines", "unattributedArrivals"]);
  if (fields === undefined) return malformed("the projection carries a field that is not own data", EMPTY_SALVAGE);
  const lines = readArray(fields.lines, MAX_READ_ENTRIES);
  const arrivals = readArray(fields.unattributedArrivals, MAX_READ_ENTRIES);
  if (lines === undefined || arrivals === undefined) return malformed("the projection's lines are not lists", EMPTY_SALVAGE);
  const outLines = new Map<string, { readonly assetKind: "COLLATERAL" | "OUTCOME_TOKEN"; readonly balance: DecimalString }>();
  for (const entry of lines) {
    const line = readFields(entry, ["assetId", "assetKind", "balance"]);
    if (line === undefined || !isIdentifier(line.assetId) || (line.assetKind !== "COLLATERAL" && line.assetKind !== "OUTCOME_TOKEN")) {
      return malformed("a projected line is not an asset with a kind", EMPTY_SALVAGE);
    }
    if (!isCanonicalDecimalString(line.balance)) return malformed("a projected balance is not an exact decimal", EMPTY_SALVAGE);
    if (outLines.has(line.assetId)) return malformed("a projected asset is listed twice", EMPTY_SALVAGE);
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
      return malformed("a recorded halt obligation is not in its shape", EMPTY_SALVAGE);
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
  return ok(Object.freeze({ lines: outLines, arrivals: Object.freeze(outArrivals) }), EMPTY_SALVAGE);
}

/** The most assets one fill's remaining booking may name (a guard; a fill books its token, its collateral and a fee). */
export const MAX_BOOKED_ASSETS = 64;

/**
 * The ledger's remaining booking of each FAILED fill asked about (`HoldingsPort.remainingBookings`), keyed by
 * `compositeKey(venueTradeId, venueOrderId)`. Exactly one answer per identity asked: one missing, unasked or
 * repeated is MALFORMED, and so is any amount that is not an exact non-zero decimal. The ledger's own state, not a
 * venue observation: it keeps no salvage (`EMPTY_SALVAGE`).
 */
export function readRemainingBookings(raw: unknown, asked: readonly FillIdentity[]): ReadOutcome<ReadonlyMap<string, readonly BookedAmount[]>> {
  const fields = readFields(raw, ["bookings"]);
  if (fields === undefined) return malformed("the remaining-bookings answer carries a field that is not own data", EMPTY_SALVAGE);
  const list = readArray(fields.bookings, MAX_READ_ENTRIES);
  if (list === undefined) return malformed("the remaining bookings are not a list", EMPTY_SALVAGE);
  const wanted = new Set(asked.map((fill) => compositeKey(fill.venueTradeId, fill.venueOrderId)));
  const out = new Map<string, readonly BookedAmount[]>();
  for (const entry of list) {
    const booking = readFields(entry, ["venueTradeId", "venueOrderId", "entries"]);
    if (booking === undefined || !isIdentifier(booking.venueTradeId) || !isVenueId(booking.venueOrderId)) return malformed("a remaining booking does not name a fill", EMPTY_SALVAGE);
    const key = compositeKey(booking.venueTradeId, booking.venueOrderId);
    if (!wanted.has(key)) return malformed("a remaining booking names a fill that was not asked about", EMPTY_SALVAGE);
    if (out.has(key)) return malformed("a fill's remaining booking is answered twice", EMPTY_SALVAGE);
    const lines = readArray(booking.entries, MAX_BOOKED_ASSETS);
    if (lines === undefined) return malformed("a remaining booking's entries are not a list", EMPTY_SALVAGE);
    const amounts: BookedAmount[] = [];
    const assets = new Set<string>();
    for (const line of lines) {
      const read = readFields(line, ["assetId", "amount"]);
      if (read === undefined || !isIdentifier(read.assetId) || !isCanonicalDecimalString(read.amount) || isZeroDecimal(read.amount)) {
        return malformed("a remaining booking line is not an asset with an exact non-zero amount", EMPTY_SALVAGE);
      }
      if (assets.has(read.assetId)) return malformed("a remaining booking names one asset twice", EMPTY_SALVAGE);
      assets.add(read.assetId);
      amounts.push(Object.freeze({ assetId: read.assetId, amount: read.amount }));
    }
    out.set(key, Object.freeze(amounts));
  }
  for (const key of wanted) if (!out.has(key)) return malformed("the ledger did not answer for a FAILED fill it was asked about", EMPTY_SALVAGE);
  return ok(out, EMPTY_SALVAGE);
}

// ---------------------------------------------------------------------------
// The user stream (r11).

/** One user-stream item (WP-280's OMS input) as fragments: an order observation, a fill or a settlement. */
export interface StreamItemFragments {
  readonly kind: "ORDER" | "FILL" | "SETTLEMENT";
  readonly venueOrderId: string | null;
  readonly venueTradeId: string | null;
  readonly status: string | null;
  readonly shares: DecimalString | null;
  readonly price: DecimalString | null;
  readonly role: "MAKER" | "TAKER" | null;
  readonly feeAmount: DecimalString | null;
  readonly feeAssetId: string | null;
  readonly matchedAt: string | null;
  readonly transactionHash: string | null;
  readonly unreadable: readonly StreamField[];
}

/** One item to route to the OMS (`raw`, read by the OMS at its own door) and what it showed (`fragments`). */
export interface StreamItem {
  readonly raw: unknown;
  readonly fragments: StreamItemFragments;
}

/**
 * (r14, WP290-V14-WP280-EVENT-IDS-DISCARDED) What an activity output's EVENT named (WP-280's normalized event, read by
 * own data property, each field on its own): the account's activity that the event identifies, whatever the projection
 * carried.
 * - ORDER: the order (`venueOrderId`) and its facts as the event stated them (its token, side, price, sizes); `status`
 *   is the event's status when WP-280 recognised it (`KNOWN`), else `null` (and `status` is named in `unreadable`).
 * - TRADE: the trade (`venueTradeId`); `status` is the event's settlement status only when it can be ORDERED (one of
 *   WP-280's five, `KNOWN`, and no status shortfall: `ordered`); the orders of the legs the event attributes to the
 *   account (`ownOrderIds`: the taker order of a TAKER trade, every maker leg WP-280's `isAccountOwner` called `OWN`),
 *   the own legs whose order id could not be read (`ownOrphans`), and whether every leg's ownership was determined
 *   (`legsDetermined`: the trader side KNOWN, and no maker leg undetermined or unreadable).
 * `required`: WP-280 did not attest that its projection carried the whole event (a shortfall; its shortfalls missing
 * or unreadable; or an empty projection: no observation, no fill and no settlement), so the event's identity is
 * REQUIRED: one that cannot be read is an unreadable entry of the output (an obligation), never nothing.
 */
export interface StreamEventFragments {
  readonly kind: "ORDER" | "TRADE";
  readonly required: boolean;
  readonly venueOrderId: string | null;
  readonly tokenId: string | null;
  readonly side: "BUY" | "SELL" | null;
  readonly price: DecimalString | null;
  readonly originalSize: DecimalString | null;
  readonly sizeMatched: DecimalString | null;
  readonly status: string | null;
  readonly venueTradeId: string | null;
  readonly ordered: boolean;
  readonly ownOrderIds: readonly string[];
  readonly ownOrphans: number;
  readonly legsDetermined: boolean;
  readonly transactionHash: string | null;
  readonly unreadable: readonly EventField[];
}

/** The field an unreadable entry of a stream output names (r14: the event, or a required event's identity, included). */
export type StreamUnreadableField = EnvelopeField | "entry" | "venueOrderId" | "venueTradeId";

/**
 * One user-stream output (r11, the stream door): every item it carries, each read once into fragments, and the
 * entries and lists present but unreadable (`unreadable`: each an item of the account's activity the stream reported
 * that nothing identifies). `kind` is `null` when the output is not an ORDER or TRADE output (then `unreadable` names
 * its `kind` when that could not be read, or, r13, was outside WP-280's vocabulary: {@link classifyStreamOutput}).
 * (r14) `event`: what the output's event named, whenever it could be read ({@link StreamEventFragments}); absent when
 * the output carries no readable event.
 * (r15, WP290-V15-EFA-REQUEST-STATUS-ASSUMED) `shortfalls`: the projection's `shortfalls` as read (each entry's text),
 * whenever they could be read; absent when missing or unreadable (or the projection is). A validated fragment like any
 * other: the coordinator compares it with the `EVENT_NOT_FULLY_APPLICABLE` request WP-280 raises right after the output
 * (`coordinator.ts`, `requestEventStatus`).
 */
export interface StreamOutput {
  readonly kind: "ORDER" | "TRADE" | null;
  readonly items: readonly StreamItem[];
  readonly unreadable: readonly { readonly kind: "ORDER" | "FILL" | "SETTLEMENT"; readonly field: StreamUnreadableField }[];
  readonly event?: StreamEventFragments;
  readonly shortfalls?: readonly string[];
}

const STREAM_KEYS: Readonly<Record<StreamItemFragments["kind"], readonly StreamField[]>> = Object.freeze({
  ORDER: ["venueOrderId", "status"],
  FILL: ["venueTradeId", "venueOrderId", "shares", "price", "liquidityRole", "feeAmount", "feeAssetId", "matchedAt"],
  SETTLEMENT: ["venueTradeId", "venueOrderId", "status", "transactionHash"],
});

/**
 * (r13) WP-280's settlement statuses (`venue-facts.ts`, `USER_TRADE_STATUSES`; `oms-projection.ts` projects a
 * settlement only for one of them, and the OMS's own `SETTLEMENT_STATES` are the same five): the plain spelling only,
 * as the stream carries it (E-13). Anything else in a settlement item is outside WP-280's projection: unreadable.
 */
export function isStreamSettlementStatus(value: unknown): value is VenueTradeStatus {
  return typeof value === "string" && (VENUE_TRADE_STATUSES as readonly string[]).includes(value);
}

/**
 * One stream item's fragments. A fill's fee and fee asset may be absent (WP-280: a fee of 0, no asset). (r13) A
 * settlement's status is read against WP-280's closed settlement vocabulary ({@link isStreamSettlementStatus}); an
 * order observation's status is open text (WP-280 passes order statuses through, its sentinel `UNRECOGNIZED`
 * included, and the OMS sends an order it holds to RECONCILING on one it does not recognise).
 */
export function streamItemFragments(kind: StreamItemFragments["kind"], raw: Entry): StreamItemFragments {
  const keys = STREAM_KEYS[kind];
  const read = readRow(raw, keys);
  const unreadable: StreamField[] = [];
  const field = <T>(key: StreamField, valid: (value: unknown) => value is T, absent?: T | null): T | null => {
    if (!keys.includes(key)) return null;
    const entry = read[key];
    if (entry === undefined) return null;
    if (entry.kind === "ABSENT" && absent !== undefined && isRecord(raw)) return absent;
    if (entry.kind === "DATA" && valid(entry.value)) return entry.value;
    unreadable.push(key);
    return null;
  };
  return Object.freeze({
    kind,
    venueOrderId: field("venueOrderId", isVenueId),
    venueTradeId: field("venueTradeId", isIdentifier),
    status: field<string>("status", kind === "SETTLEMENT" ? isStreamSettlementStatus : isIdentifier),
    shares: field("shares", isPositiveAmount),
    price: field("price", isUnitPrice),
    role: field("liquidityRole", isRole),
    feeAmount: field("feeAmount", isNullOr(isNonNegativeAmount), null),
    feeAssetId: field("feeAssetId", isNullOr(isIdentifier), null),
    matchedAt: field("matchedAt", isIsoInstant),
    transactionHash: field("transactionHash", isNullOr(isIdentifier), null),
    unreadable: Object.freeze(unreadable),
  });
}

/** The most items one stream output may carry (a guard). */
export const MAX_STREAM_ITEMS = 1000;

/**
 * (r13) WP-280's `UserStreamOutput` is a CLOSED vocabulary of five outputs (`manager.ts`): `STATE`, `ORDER`, `TRADE`,
 * `UNRECOGNIZED_MESSAGE`, `RECONCILIATION_REQUESTED`. Only ORDER and TRADE carry account activity (`event`, `oms`).
 */
export const STREAM_OUTPUT_KINDS = ["STATE", "ORDER", "TRADE", "UNRECOGNIZED_MESSAGE", "RECONCILIATION_REQUESTED"] as const;
/** (r13) The keys only WP-280's ORDER and TRADE outputs carry (the normalized event and its OMS projection). */
export const STREAM_ACTIVITY_KEYS = ["event", "oms"] as const;

/**
 * (r13) How one user-stream output is read, decided ONCE, here, for both of the coordinator's entry points
 * (`coordinator.ts`, `onUserStreamOutput`, and this door's {@link readStreamOutput}), so the two never diverge:
 * - `read`: `ORDER` or `TRADE` (its items are read); `NOTHING` (a STATE, UNRECOGNIZED_MESSAGE or
 *   RECONCILIATION_REQUESTED output: none carries an item of the account's activity, and WP-280 raises its own
 *   reconciliation request for the first two when they matter); `UNREADABLE` (an obligation of the account, and a
 *   run): a `kind` that cannot be read, a READABLE `kind` outside WP-280's five (WP290-V13-STREAM-UNKNOWN-KIND-SILENT
 *   = WP290-CX-R13-01: `""`, `"Trade"`, `"TRADE "`, `"order"`, ... may have been an ORDER or a TRADE output, so it is
 *   never "nothing"), or a non-activity kind whose output carries a key only an ORDER or TRADE output carries (it may
 *   be one, mis-tagged);
 * - `request`: a RECONCILIATION_REQUESTED output (its request is taken, whatever else the output carries).
 */
export interface StreamOutputClass {
  readonly read: "ORDER" | "TRADE" | "NOTHING" | "UNREADABLE";
  readonly request: boolean;
}

export function classifyStreamOutput(output: unknown): StreamOutputClass {
  const kind = readField(output, "kind");
  if (kind.kind !== "DATA" || typeof kind.value !== "string") return Object.freeze({ read: "UNREADABLE", request: false });
  const value = kind.value;
  if (value === "ORDER" || value === "TRADE") return Object.freeze({ read: value, request: false });
  if (!(STREAM_OUTPUT_KINDS as readonly string[]).includes(value)) return Object.freeze({ read: "UNREADABLE", request: false });
  const request = value === "RECONCILIATION_REQUESTED";
  const carriesActivity = STREAM_ACTIVITY_KEYS.some((key) => readField(output, key).kind !== "ABSENT");
  return Object.freeze({ read: carriesActivity ? "UNREADABLE" : "NOTHING", request });
}

/** (r14) WP-280's `WireEnum` (`normalize.ts`): a recognised value, an absent one, or an unrecognised one. */
type WireEnumRead = { readonly kind: "KNOWN"; readonly value: string } | { readonly kind: "ABSENT" } | { readonly kind: "UNRECOGNIZED" } | { readonly kind: "UNREADABLE" };

/** (r14) Read one of WP-280's `WireEnum` values by own data property: anything outside its three shapes is unreadable. */
function readWireEnum(raw: FieldRead): WireEnumRead {
  if (raw.kind !== "DATA" || !isRecord(raw.value)) return { kind: "UNREADABLE" };
  const kind = readField(raw.value, "kind");
  if (kind.kind !== "DATA") return { kind: "UNREADABLE" };
  if (kind.value === "ABSENT") return { kind: "ABSENT" };
  if (kind.value === "UNRECOGNIZED") return { kind: "UNRECOGNIZED" };
  if (kind.value !== "KNOWN") return { kind: "UNREADABLE" };
  const value = readField(raw.value, "value");
  return value.kind === "DATA" && isIdentifier(value.value) ? { kind: "KNOWN", value: value.value } : { kind: "UNREADABLE" };
}

/**
 * (r14) The projection's `shortfalls` (WP-280's closed vocabulary, `STREAM_PROJECTION_SHORTFALLS`): the list as read
 * (each entry's text), or `undefined` when it is missing, not a list, or carries an entry that is not text. A text
 * outside the vocabulary is kept as read: it is a shortfall all the same (the projection is not the whole event).
 */
function readShortfalls(source: unknown): readonly string[] | undefined {
  const field = readField(source, "shortfalls");
  const list = field.kind === "DATA" ? listEntries(field.value, STREAM_PROJECTION_SHORTFALLS.length * 4) : undefined;
  if (list === undefined || !list.whole) return undefined;
  const out: string[] = [];
  for (const entry of list.entries) {
    if (typeof entry !== "string") return undefined;
    out.push(entry);
  }
  return Object.freeze(out);
}

/** (r14) Whether the shortfalls say the event's trade status is one no one can order (or may: unreadable). */
function statusShortfall(shortfalls: readonly string[] | undefined): boolean {
  return shortfalls !== undefined && shortfalls.some((entry) => (STREAM_STATUS_SHORTFALLS as readonly string[]).includes(entry));
}

/**
 * (r14, WP290-V14-WP280-EVENT-IDS-DISCARDED) Read an activity output's EVENT (WP-280's normalized event) once, each field
 * on its own ({@link StreamEventFragments}). `undefined` when the event is not own data or not a record.
 */
function readEventFragments(kind: "ORDER" | "TRADE", raw: FieldRead, required: boolean, shortfalls: readonly string[] | undefined): StreamEventFragments | undefined {
  if (raw.kind !== "DATA" || !isRecord(raw.value)) return undefined;
  const event = raw.value;
  const unreadable: EventField[] = [];
  const field = <T>(key: EventField, valid: (value: unknown) => value is T): T | null => {
    const read = readField(event, key);
    if (read.kind === "DATA" && valid(read.value)) return read.value;
    unreadable.push(key);
    return null;
  };
  const none = { venueOrderId: null, tokenId: null, side: null, price: null, originalSize: null, sizeMatched: null, venueTradeId: null, ownOrderIds: Object.freeze([]), ownOrphans: 0 } as const;
  if (kind === "ORDER") {
    const venueOrderId = field("venueOrderId", isVenueId);
    const tokenId = field("assetId", isTokenId);
    const side = field("side", isSide);
    const price = field("price", isUnitPrice);
    const originalSize = field("originalSize", isPositiveAmount);
    const sizeMatched = field("sizeMatched", isNonNegativeAmount);
    // WP-280's order status: recognised (KNOWN), or absent or unrecognised (its own shapes: kept as no status, named).
    const status = readWireEnum(readField(event, "status"));
    if (status.kind !== "KNOWN") unreadable.push("status");
    return Object.freeze({
      ...none,
      kind,
      required,
      venueOrderId,
      tokenId,
      side,
      price,
      originalSize,
      sizeMatched,
      status: status.kind === "KNOWN" ? status.value : null,
      ordered: status.kind === "KNOWN",
      legsDetermined: true,
      transactionHash: null,
      unreadable: Object.freeze([...new Set(unreadable)]),
    });
  }
  const venueTradeId = field("venueTradeId", isIdentifier);
  // A settlement status that can be ORDERED: one of WP-280's five (plain spelling), recognised, and no status shortfall.
  const status = readWireEnum(readField(event, "status"));
  const ordered = status.kind === "KNOWN" && isStreamSettlementStatus(status.value) && !statusShortfall(shortfalls);
  if (!ordered) unreadable.push("status");
  const transactionHash = field("transactionHash", isNullOr(isIdentifier));
  // The legs the event attributes to the account (WP-280's own rule, `oms-projection.ts` `ownLegs`): the taker order of
  // a TAKER trade; every maker leg its `isAccountOwner` called OWN (on either side: an own maker leg on a TAKER trade is
  // a same-account match WP-280 does not project, but the leg is the account's all the same).
  const traderSide = readWireEnum(readField(event, "traderSide"));
  if (traderSide.kind === "UNREADABLE") unreadable.push("traderSide");
  const side = traderSide.kind === "KNOWN" && (traderSide.value === "TAKER" || traderSide.value === "MAKER") ? traderSide.value : null;
  let legsDetermined = side !== null;
  const own = new Set<string>();
  let ownOrphans = 0;
  const taker = readField(event, "takerOrderId");
  const takerId = taker.kind === "DATA" && isVenueId(taker.value) ? taker.value : null;
  if (takerId === null) unreadable.push("takerOrderId");
  if (side === "TAKER") {
    if (takerId !== null) own.add(takerId);
    else ownOrphans += 1;
  }
  const makersField = readField(event, "makerOrders");
  const makers = makersField.kind === "DATA" ? (makersField.value === null ? { entries: [], whole: true } : listEntries(makersField.value, MAX_LEGS_PER_TRADE * 16)) : undefined;
  if (makers === undefined || !makers.whole) {
    unreadable.push("makerOrders");
    legsDetermined = false;
  }
  for (const entry of makers?.entries ?? []) {
    const account = entry === UNREADABLE_ENTRY ? OPAQUE_READ : readField(entry, "account");
    const orderId = entry === UNREADABLE_ENTRY ? OPAQUE_READ : readField(entry, "venueOrderId");
    const id = orderId.kind === "DATA" && isVenueId(orderId.value) ? orderId.value : null;
    if (account.kind === "DATA" && account.value === "OWN") {
      if (id !== null) own.add(id);
      else {
        ownOrphans += 1;
        unreadable.push("makerOrders");
      }
    } else if (!(account.kind === "DATA" && account.value === "OTHER")) {
      // UNDETERMINED (WP-280's own verdict), or a verdict that cannot be read: the leg may be the account's.
      legsDetermined = false;
      if (!(account.kind === "DATA" && account.value === "UNDETERMINED")) unreadable.push("makerOrders");
    }
  }
  return Object.freeze({
    ...none,
    kind,
    required,
    venueTradeId,
    status: ordered && status.kind === "KNOWN" ? status.value : null,
    ordered,
    ownOrderIds: Object.freeze([...own].sort()),
    ownOrphans,
    legsDetermined,
    transactionHash,
    unreadable: Object.freeze([...new Set(unreadable)]),
  });
}

/**
 * Read one WP-280 `UserStreamOutput` (an ORDER or TRADE output) once, into its items and their fragments. Every key
 * of WP-280's projection this door reads (`oms`; an ORDER's `observation`; a TRADE's `fills` and `settlements`) is
 * present in every output WP-280 emits (`oms-projection.ts`): one that is missing, not own data, or not in its shape is
 * an UNREADABLE entry (r12: a missing key too, WP290-CX-R12-01), never "nothing". (r13) Its `kind` is read against
 * WP-280's closed vocabulary ({@link classifyStreamOutput}): one outside it is an UNREADABLE entry too.
 *
 * (r14, WP290-V14-WP280-EVENT-IDS-DISCARDED) An EMPTY projection is never "nothing": WP-280 projects nothing (an ORDER's
 * `observation: null`; a TRADE with no fill and no settlement) exactly when it could not project the event, and says
 * why in `shortfalls`. So the projection's `shortfalls` IS read, and the output's `event` too: whenever it can be read,
 * what it names is returned (`event`: the coordinator journals it as stream-NAMED evidence), and when WP-280 did not
 * attest that its projection carried the whole event (a shortfall, `shortfalls` missing or unreadable, or an empty
 * projection) the event is REQUIRED: an event, or its order or trade id, that cannot be read is an UNREADABLE entry (an
 * obligation of the account). A projection one of whose keys is unreadable already carries that obligation; its event
 * is then read for what it names, and nothing more is required of it.
 */
export function readStreamOutput(output: unknown): StreamOutput {
  const read = classifyStreamOutput(output);
  // An output whose kind cannot be read, or (r13) whose kind is readable but outside WP-280's five, or a non-activity
  // output carrying an activity output's own key, may have been an ORDER or a TRADE output: it is present but
  // unreadable (an obligation), never "nothing" (WP290-V13-STREAM-UNKNOWN-KIND-SILENT = WP290-CX-R13-01).
  if (read.read === "UNREADABLE") {
    return Object.freeze({ kind: null, items: Object.freeze([]), unreadable: Object.freeze([{ kind: "FILL" as const, field: "kind" as const }]) });
  }
  // A STATE, UNRECOGNIZED_MESSAGE or RECONCILIATION_REQUESTED output (WP-280's own vocabulary) carries no item of the
  // account's activity.
  if (read.read === "NOTHING") return Object.freeze({ kind: null, items: Object.freeze([]), unreadable: Object.freeze([]) });
  const kind = read.read;
  const projection = readField(output, "oms");
  const items: StreamItem[] = [];
  const unreadable: { readonly kind: "ORDER" | "FILL" | "SETTLEMENT"; readonly field: StreamUnreadableField }[] = [];
  // (r14) Whether every key of the projection was readable, and whether it carried anything at all.
  let keysReadable = true;
  let carried = false;
  if (kind === "ORDER") {
    if (projection.kind !== "DATA" || !isRecord(projection.value)) {
      unreadable.push({ kind: "ORDER", field: "oms" });
      keysReadable = false;
    } else {
      const observation = readField(projection.value, "observation");
      // (r12, WP290-CX-R12-01) WP-280's ORDER projection always carries `observation`: `null` when the event named no
      // status (r14: an EMPTY projection, so the event is required), else the observation. A MISSING key (or one
      // holding `undefined`) is unreadable, an obligation of the account, exactly as one that is not own data.
      if (observation.kind !== "DATA" || observation.value === undefined) {
        unreadable.push({ kind: "ORDER", field: "observation" });
        keysReadable = false;
      } else if (observation.value !== null) {
        items.push(Object.freeze({ raw: observation.value, fragments: streamItemFragments("ORDER", observation.value) }));
        carried = true;
      }
    }
  } else if (projection.kind !== "DATA" || !isRecord(projection.value)) {
    unreadable.push({ kind: "FILL", field: "oms" });
    keysReadable = false;
  } else {
    for (const [field, itemKind] of [
      ["fills", "FILL"],
      ["settlements", "SETTLEMENT"],
    ] as const) {
      // (r12, WP290-CX-R12-01) WP-280's TRADE projection always carries both lists (empty when it projected nothing):
      // a MISSING list is unreadable, an obligation of the account, exactly as one that is not a list: never "nothing".
      const listField = readField(projection.value, field);
      const list = listField.kind === "DATA" ? listEntries(listField.value, MAX_STREAM_ITEMS) : undefined;
      if (list === undefined) {
        unreadable.push({ kind: itemKind, field });
        keysReadable = false;
        continue;
      }
      for (const entry of list.entries) {
        if (entry === UNREADABLE_ENTRY) {
          unreadable.push({ kind: itemKind, field: "entry" });
          keysReadable = false;
          continue;
        }
        items.push(Object.freeze({ raw: entry, fragments: streamItemFragments(itemKind, entry) }));
        carried = true;
      }
    }
  }
  // (r14) The projection is the whole event only when WP-280 says so: its shortfalls readable and empty, and something
  // projected. Otherwise the event's identity is required.
  const shortfalls = projection.kind === "DATA" && isRecord(projection.value) ? readShortfalls(projection.value) : undefined;
  const required = keysReadable && (shortfalls === undefined || shortfalls.length > 0 || !carried);
  const entryKind = kind === "ORDER" ? ("ORDER" as const) : ("FILL" as const);
  const event = readEventFragments(kind, readField(output, "event"), required, shortfalls);
  if (required) {
    if (event === undefined) unreadable.push({ kind: entryKind, field: "event" });
    else if (kind === "ORDER" && event.venueOrderId === null) unreadable.push({ kind: entryKind, field: "venueOrderId" });
    else if (kind === "TRADE" && event.venueTradeId === null) unreadable.push({ kind: entryKind, field: "venueTradeId" });
  }
  return Object.freeze({ kind, items: Object.freeze(items), unreadable: Object.freeze(unreadable), ...(event === undefined ? {} : { event }), ...(shortfalls === undefined ? {} : { shortfalls }) });
}

/**
 * (r14, WP290-V14-WP280-EVENT-IDS-DISCARDED) One WP-280 reconciliation request (`manager.ts`,
 * `UserStreamReconciliationRequest`), read once by own data property, every field on its own, WHATEVER its usability
 * (a request whose id or cause cannot be read still names what it names):
 * - `requestId` (text, at most 2000 characters), `cause` (text), `markets` (the texts of its list): `null`, and `opaque`
 *   (one of the three is not own data), exactly where the request's door refused them before r14 (the coordinator
 *   records such a request as REQUEST_MALFORMED);
 * - `venueTradeId`, `venueOrderIds`: "the identifiers the event named, exactly", for an event-level cause; each id
 *   validated on its own. The fields are REQUIRED (missing is unreadable) when the cause is event-level, or outside
 *   WP-280's closed vocabulary (or unreadable: it may have been an event-level cause); an event-level request that names
 *   no identifier at all is unreadable too (WP-280's `eventScope` always names the event's order or orders);
 * - `shortfalls` (r15): the request's shortfalls as read (each entry's text; empty when the field is absent and not
 *   required), `null` when they cannot be read (then named in `unreadable` too);
 * - `statusRecognised` (r15, WP290-V15-EFA-REQUEST-STATUS-ASSUMED; r14's `unordered`, negated): whether WP-280 RECOGNISED
 *   its event's settlement status: an `EVENT_NOT_FULLY_APPLICABLE` request whose shortfalls are readable, inside
 *   WP-280's vocabulary and name no status shortfall. It says only THAT the status was one of WP-280's five, never
 *   WHICH: FAILED is one of them. A request carries no status (`manager.ts`, `UserStreamReconciliationRequest`): the
 *   value travels only in its event's output, which WP-280 emits immediately before the request (`#onFrame`). So the
 *   request alone never orders its trade's status. The coordinator orders it only from that output, received
 *   immediately before the request (`coordinator.ts`, `requestEventStatus`); otherwise the trade is `unordered`. r14
 *   read a recognised status as an ordered one and journaled the trade with no status and no `unordered` mark: when the
 *   request was the only surviving word of a FAILED event (a coordinator restart lost the output while WP-280's backlog
 *   kept the request), a lagging read showing the trade MATCHED answered it, and the account resumed with the failure
 *   missed (R1).
 */
export interface StreamRequestFragments {
  readonly requestId: string | null;
  readonly cause: string | null;
  readonly markets: readonly string[];
  readonly opaque: boolean;
  readonly eventCause: boolean;
  readonly venueTradeId: string | null;
  readonly venueOrderIds: readonly string[];
  readonly shortfalls: readonly string[] | null;
  readonly statusRecognised: boolean;
  readonly unreadable: readonly ("venueTradeId" | "venueOrderIds" | "shortfalls")[];
}

/** The longest request id the coordinator keeps. */
export const MAX_STREAM_REQUEST_ID = 2000;

export function readStreamRequest(raw: unknown): StreamRequestFragments {
  const unreadable: ("venueTradeId" | "venueOrderIds" | "shortfalls")[] = [];
  const idRead = readField(raw, "requestId");
  // eslint-disable-next-line no-control-regex
  const requestId = idRead.kind === "DATA" && typeof idRead.value === "string" && idRead.value.length > 0 && idRead.value.length <= MAX_STREAM_REQUEST_ID && !/[\u0000-\u001f\u007f]/u.test(idRead.value) ? idRead.value : null;
  const causeRead = readField(raw, "cause");
  const cause = causeRead.kind === "DATA" && typeof causeRead.value === "string" ? causeRead.value : null;
  const marketsRead = readField(raw, "markets");
  const markets = marketsRead.kind === "DATA" ? (readArray(marketsRead.value, 100_000) ?? []).filter((market): market is string => typeof market === "string") : [];
  const eventCause = cause !== null && (STREAM_EVENT_CAUSES as readonly string[]).includes(cause);
  const knownCause = cause !== null && (STREAM_RECONCILIATION_CAUSES as readonly string[]).includes(cause);
  // The identity fields are required where the request may be an event's.
  const required = eventCause || !knownCause;
  const tradeRead = readField(raw, "venueTradeId");
  let venueTradeId: string | null = null;
  if (tradeRead.kind === "DATA" && isIdentifier(tradeRead.value)) venueTradeId = tradeRead.value;
  else if (!(tradeRead.kind === "DATA" && tradeRead.value === null) && !(tradeRead.kind === "ABSENT" && !required)) unreadable.push("venueTradeId");
  const ordersRead = readField(raw, "venueOrderIds");
  const venueOrderIds: string[] = [];
  if (ordersRead.kind === "DATA") {
    const list = listEntries(ordersRead.value, MAX_LEGS_PER_TRADE * 16);
    if (list === undefined || !list.whole) unreadable.push("venueOrderIds");
    for (const entry of list?.entries ?? []) {
      if (entry !== UNREADABLE_ENTRY && isVenueId(entry)) venueOrderIds.push(entry);
      else unreadable.push("venueOrderIds");
    }
  } else if (!(ordersRead.kind === "ABSENT" && !required)) {
    unreadable.push("venueOrderIds");
  }
  if (eventCause && venueTradeId === null && venueOrderIds.length === 0 && unreadable.length === 0) unreadable.push("venueOrderIds");
  const shortfallsRead = readField(raw, "shortfalls");
  const shortfalls = shortfallsRead.kind === "ABSENT" && !required ? Object.freeze([] as string[]) : readShortfalls(raw);
  if (shortfalls === undefined) unreadable.push("shortfalls");
  // (r15) Recognised, never ordered: which status it was is carried by the event's output alone.
  const statusRecognised =
    cause === "EVENT_NOT_FULLY_APPLICABLE" &&
    shortfalls !== undefined &&
    shortfalls.every((entry) => (STREAM_PROJECTION_SHORTFALLS as readonly string[]).includes(entry)) &&
    !statusShortfall(shortfalls);
  return Object.freeze({
    requestId,
    cause,
    markets: Object.freeze(markets),
    opaque: marketsRead.kind === "OPAQUE" || idRead.kind === "OPAQUE" || causeRead.kind === "OPAQUE",
    eventCause,
    venueTradeId,
    venueOrderIds: Object.freeze([...new Set(venueOrderIds)].sort()),
    shortfalls: shortfalls ?? null,
    statusRecognised,
    unreadable: Object.freeze([...new Set(unreadable)].sort()),
  });
}

// ---------------------------------------------------------------------------
// Port results.

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
