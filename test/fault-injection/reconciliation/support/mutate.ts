/**
 * WP-290 r11: WIRE MUTATIONS of valid answers, for the door property (`door-property.test.ts`) and the end-to-end
 * property (`property.ts`), and the INDEPENDENT FRAGMENT ORACLE they are judged by.
 *
 * A mutation takes a valid answer of one door and returns another wire answer: a field dropped, a field of the wrong
 * type (or an inexact decimal), a field that is an accessor, a row relabelled with another id, a by-id `found` flag
 * flipped or removed, a row listed twice, a malformed sibling row added, the list truncated (rows dropped from its
 * end, or a row cut short), a list entry that is not own data (an accessor or a hole), an envelope field (the route,
 * `complete`, the list itself) dropped or garbled; for a user-stream output (r12, WP290-CX-R12-01), its own keys
 * (`kind`, `oms`, an ORDER's `observation`, a TRADE's `fills` and `settlements`) DELETED, made an accessor, or given a
 * value outside their shape. Every mutated answer is a fresh plain object; nothing of the input is changed.
 *
 * The ORACLE reads a delivered answer field by field, each on its own, with the field domains of `ports.ts` (the
 * guards are the domains' definitions; the oracle's walk over rows, legs and entries is its own): a field that is own
 * data and in its domain is a VALIDATED fragment; one that is present but not (an accessor, the wrong type, out of its
 * domain) or missing is UNREADABLE. An entry of a readable list that is not own data is a row every field of which is
 * unreadable. An answer whose route (or source) is a READABLE string naming another source keeps nothing (E-15, U-22).
 *
 * PAPER only: pure; no network, key or signer.
 */

import { isCanonicalDecimalString } from "../../../../packages/decimal/src/index.js";
import { isIdentifier, isNonNegativeAmount, isPositiveAmount, isTokenId, isUnitPrice } from "../../../../packages/oms/src/guards.js";
import { isVenueId } from "../../../../packages/oms/src/outcomes.js";

export type Door = "open-orders" | "by-id" | "trades" | "positions" | "collateral" | "approvals" | "wallet-member" | "stream";
export const DOORS: readonly Door[] = ["open-orders", "by-id", "trades", "positions", "collateral", "approvals", "wallet-member", "stream"];

export type Mutation =
  | "NONE"
  | "DROP_FIELD"
  | "WRONG_TYPE"
  | "INEXACT_DECIMAL"
  | "ACCESSOR"
  | "WRONG_ID"
  | "FOUND_FLIP"
  | "DUPLICATE"
  | "SIBLING_MALFORMED"
  | "TRUNCATE_LIST"
  | "TRUNCATE_ROW"
  | "OPAQUE_ENTRY"
  | "HOLE_ENTRY"
  | "LEG_FIELD"
  | "OPAQUE_LEG"
  | "ENVELOPE";
export const MUTATIONS: readonly Mutation[] = [
  "NONE",
  "DROP_FIELD",
  "WRONG_TYPE",
  "INEXACT_DECIMAL",
  "ACCESSOR",
  "WRONG_ID",
  "FOUND_FLIP",
  "DUPLICATE",
  "SIBLING_MALFORMED",
  "TRUNCATE_LIST",
  "TRUNCATE_ROW",
  "OPAQUE_ENTRY",
  "HOLE_ENTRY",
  "LEG_FIELD",
  "OPAQUE_LEG",
  "ENVELOPE",
];

type Row = Record<string, unknown>;
type Rand = () => number;

const ORDER_KEYS = ["venueOrderId", "tokenId", "side", "price", "originalSize", "sizeMatched", "status"] as const;
const LEG_KEYS = ["venueOrderId", "role", "tokenId", "side", "shares", "price", "feeAmount", "feeAssetId", "matchedAt"] as const;
const TRADE_KEYS = ["venueTradeId", "status", "transactionHash", "ownershipUndetermined", "ownLegs"] as const;
const POSITION_KEYS = ["tokenId", "size"] as const;
const COLLATERAL_KEYS = ["assetId", "balance"] as const;
const APPROVAL_KEYS = ["spender", "approved"] as const;
const MEMBER_KEYS = ["state", "transactionHash", "credited"] as const;
const FILL_KEYS = ["venueTradeId", "venueOrderId", "shares", "price", "liquidityRole", "feeAmount", "feeAssetId", "matchedAt"] as const;
const SETTLEMENT_KEYS = ["venueTradeId", "venueOrderId", "status", "transactionHash"] as const;
const OBSERVATION_KEYS = ["venueOrderId", "status"] as const;

const DECIMAL_KEYS = new Set(["price", "originalSize", "sizeMatched", "shares", "feeAmount", "size", "balance", "credited"]);
const ID_KEYS = new Set(["venueOrderId", "venueTradeId"]);

function pick<T>(rand: Rand, list: readonly T[]): T {
  return list[Math.floor(rand() * list.length)] as T;
}

/** A deep plain copy (arrays and plain objects; every value own data). */
function clone<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => clone(entry)) as T;
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value as Row).map(([key, entry]) => [key, clone(entry)])) as T;
  return value;
}

/** A value of the wrong type for a field (or out of its domain). */
function wrongValue(rand: Rand, key: string, value: unknown): unknown {
  if (typeof value === "boolean") return pick(rand, ["no", 0, null]);
  if (DECIMAL_KEYS.has(key)) return pick(rand, [0.4, "0.4.0", "-1", "", { amount: "1" }]);
  if (ID_KEYS.has(key)) return pick(rand, [42, "", "has space", ["id"], null]);
  if (key === "tokenId") return pick(rand, ["01", "x", 7]);
  if (key === "matchedAt") return pick(rand, ["1790000000", "yesterday", 0]);
  if (key === "side") return pick(rand, ["buy", "HOLD", 1]);
  if (key === "role" || key === "liquidityRole") return pick(rand, ["maker", "BOTH"]);
  if (key === "state") return pick(rand, ["confirmed", "DONE", 3]);
  return pick(rand, [42, "", ["x"], { x: 1 }]);
}

/** The same decimal, not in canonical form (a door must refuse it as inexact). */
function inexact(value: unknown): unknown {
  if (typeof value !== "string" || !isCanonicalDecimalString(value)) return value;
  return value.includes(".") ? `${value}0` : `${value}.0`;
}

function withAccessor(row: Row, key: string): Row {
  const copy: Row = { ...row };
  const value = copy[key];
  delete copy[key];
  Object.defineProperty(copy, key, { get: () => value, enumerable: true, configurable: true });
  return copy;
}

function opaqueEntry(list: unknown[], index: number): unknown[] {
  const copy = [...list];
  const value = copy[index];
  Object.defineProperty(copy, String(index), { get: () => value, enumerable: true, configurable: true });
  return copy;
}

function holeEntry(list: unknown[], index: number): unknown[] {
  const copy = [...list];
  // A hole: the list's length says the entry exists; it has no own property.
  delete copy[index];
  return copy;
}

/** The row-list field of each list door, and the keys of its rows. */
const LISTS: Partial<Record<Door, { readonly field: string; readonly keys: readonly string[] }>> = {
  "open-orders": { field: "orders", keys: ORDER_KEYS },
  trades: { field: "trades", keys: TRADE_KEYS },
  positions: { field: "positions", keys: POSITION_KEYS },
  approvals: { field: "approvals", keys: APPROVAL_KEYS },
};

/** The rows a single-row door carries (by id: its `order`; the collateral and a member: the answer itself). */
function mutateRowFields(rand: Rand, row: Row, keys: readonly string[], mutation: Mutation): Row {
  const key = pick(rand, keys);
  switch (mutation) {
    case "DROP_FIELD": {
      const copy = { ...row };
      delete copy[key];
      return copy;
    }
    case "WRONG_TYPE":
      return { ...row, [key]: wrongValue(rand, key, row[key]) };
    case "INEXACT_DECIMAL": {
      const decimal = keys.filter((name) => DECIMAL_KEYS.has(name) && typeof row[name] === "string");
      if (decimal.length === 0) return { ...row, [key]: wrongValue(rand, key, row[key]) };
      const name = pick(rand, decimal);
      return { ...row, [name]: inexact(row[name]) };
    }
    case "ACCESSOR":
      return withAccessor(row, key);
    case "TRUNCATE_ROW": {
      const kept = Math.floor(rand() * keys.length);
      const copy: Row = {};
      for (const name of keys.slice(0, kept)) if (name in row) copy[name] = row[name];
      return copy;
    }
    default:
      return row;
  }
}

/** A malformed sibling row: some of a row's fields, some of them broken. */
function brokenSibling(rand: Rand, door: Door, template: Row | undefined): Row {
  const keys = LISTS[door]?.keys ?? [];
  const base: Row = template === undefined ? {} : clone(template);
  const out: Row = {};
  for (const key of keys) {
    const roll = rand();
    if (roll < 0.3) continue;
    out[key] = roll < 0.55 ? wrongValue(rand, key, base[key]) : base[key];
  }
  return out;
}

/**
 * One mutation of a valid answer of `door`. `ids` are valid ids the WRONG_ID mutation may relabel a row with (another
 * row's, or a fresh one). Returns the answer to deliver (the input is never changed).
 */
export function mutateAnswer(rand: Rand, door: Door, answer: unknown, mutation: Mutation, ids: readonly string[] = ["venue-relabelled"]): unknown {
  const base = clone(answer) as Row;
  if (mutation === "NONE") return base;
  if (door === "stream") return mutateStream(rand, base, mutation);
  if (mutation === "ENVELOPE") return mutateEnvelope(rand, door, base);
  const list = LISTS[door];
  if (list !== undefined) {
    const rows = Array.isArray(base[list.field]) ? (base[list.field] as Row[]) : [];
    if (rows.length === 0 && mutation !== "SIBLING_MALFORMED") return mutateEnvelope(rand, door, base);
    const index = Math.floor(rand() * Math.max(rows.length, 1));
    switch (mutation) {
      case "DUPLICATE":
        return { ...base, [list.field]: [...rows, clone(rows[index])] };
      case "SIBLING_MALFORMED":
        return { ...base, [list.field]: [...rows, brokenSibling(rand, door, rows[0])] };
      case "TRUNCATE_LIST":
        return { ...base, [list.field]: rows.slice(0, Math.floor(rand() * rows.length)) };
      case "OPAQUE_ENTRY":
        return { ...base, [list.field]: opaqueEntry(rows, index) };
      case "HOLE_ENTRY":
        return { ...base, [list.field]: holeEntry(rows, index) };
      case "WRONG_ID": {
        const key = door === "trades" ? "venueTradeId" : door === "open-orders" ? "venueOrderId" : door === "positions" ? "tokenId" : "spender";
        const replacement = door === "positions" ? "424242" : pick(rand, ids);
        return { ...base, [list.field]: rows.map((row, at) => (at === index ? { ...row, [key]: replacement } : row)) };
      }
      case "LEG_FIELD":
      case "OPAQUE_LEG": {
        if (door !== "trades") return { ...base, [list.field]: rows.map((row, at) => (at === index ? mutateRowFields(rand, row, list.keys, "WRONG_TYPE") : row)) };
        const row = rows[index] as Row | undefined;
        // A second mutation may meet a row the first made unreadable (a hole, a value that is not a row).
        if (row === null || typeof row !== "object") return base;
        const legs = Array.isArray(row["ownLegs"]) ? (row["ownLegs"] as Row[]) : [];
        if (legs.length === 0) return { ...base, [list.field]: rows.map((entry, at) => (at === index ? mutateRowFields(rand, entry, list.keys, "DROP_FIELD") : entry)) };
        const legIndex = Math.floor(rand() * legs.length);
        const mutatedLegs =
          mutation === "OPAQUE_LEG"
            ? opaqueEntry(legs, legIndex)
            : legs.map((leg, at) => (at === legIndex ? mutateRowFields(rand, leg, LEG_KEYS, pick(rand, ["DROP_FIELD", "WRONG_TYPE", "INEXACT_DECIMAL", "ACCESSOR"] as const)) : leg));
        return { ...base, [list.field]: rows.map((entry, at) => (at === index ? { ...entry, ownLegs: mutatedLegs } : entry)) };
      }
      case "FOUND_FLIP":
        return mutateEnvelope(rand, door, base);
      default:
        return { ...base, [list.field]: rows.map((row, at) => (at === index ? mutateRowFields(rand, row, list.keys, mutation) : row)) };
    }
  }
  if (door === "by-id") {
    const order = base["order"];
    switch (mutation) {
      case "FOUND_FLIP": {
        const roll = rand();
        const copy = { ...base };
        if (roll < 0.4) copy["found"] = base["found"] === true ? false : true;
        else if (roll < 0.7) delete copy["found"];
        else copy["found"] = "yes";
        return copy;
      }
      case "WRONG_ID":
        return order !== null && typeof order === "object" ? { ...base, order: { ...(order as Row), venueOrderId: pick(rand, ids) } } : base;
      case "OPAQUE_ENTRY":
      case "HOLE_ENTRY":
        return withAccessor(base, "order");
      default:
        return order !== null && typeof order === "object" ? { ...base, order: mutateRowFields(rand, order as Row, ORDER_KEYS, mutation === "LEG_FIELD" || mutation === "OPAQUE_LEG" || mutation === "DUPLICATE" || mutation === "SIBLING_MALFORMED" || mutation === "TRUNCATE_LIST" ? "WRONG_TYPE" : mutation) } : mutateEnvelope(rand, door, base);
    }
  }
  const keys = door === "collateral" ? COLLATERAL_KEYS : MEMBER_KEYS;
  return mutateRowFields(rand, base, keys, ["DROP_FIELD", "WRONG_TYPE", "INEXACT_DECIMAL", "ACCESSOR", "TRUNCATE_ROW"].includes(mutation) ? mutation : "WRONG_TYPE");
}

/** The envelope: the route (or source) dropped, garbled or an accessor; `complete` garbled; the list not a list. */
function mutateEnvelope(rand: Rand, door: Door, base: Row): Row {
  const routeKey = door === "collateral" ? "source" : "route";
  const list = LISTS[door]?.field;
  const fields = [routeKey, ...(door === "open-orders" || door === "trades" || door === "positions" ? ["complete"] : []), ...(list === undefined ? [] : [list]), ...(door === "by-id" ? ["found"] : [])];
  const key = pick(rand, fields);
  const roll = rand();
  if (roll < 0.33) {
    const copy = { ...base };
    delete copy[key];
    return copy;
  }
  if (roll < 0.66) return withAccessor(base, key);
  return { ...base, [key]: key === "complete" || key === "found" ? "yes" : key === list ? "not a list" : 7 };
}

/** A copy of `row` without `key` (r12: a MISSING key). */
function without(row: Row, key: string): Row {
  const copy = { ...row };
  delete copy[key];
  return copy;
}

/**
 * One mutation of a user-stream output (WP-280's ORDER or TRADE output). ENVELOPE breaks the output's own keys: its
 * `kind` or `oms` (one draw in four), else an ORDER's `observation` or one of a TRADE's lists. Each such key is made an
 * accessor, given a value outside its shape, or (r12, WP290-CX-R12-01) DELETED. A second mutation may meet an output
 * a first one broke (no `oms`, no list): it then mutates what is there.
 */
function mutateStream(rand: Rand, base: Row, mutation: Mutation): Row {
  const projection = base["oms"];
  const oms: Row = projection !== null && typeof projection === "object" && !Array.isArray(projection) ? (projection as Row) : {};
  if (mutation === "ENVELOPE" && rand() < 0.25) {
    const key = rand() < 0.5 ? "kind" : "oms";
    const how = rand();
    if (how < 1 / 3) return withAccessor(base, key);
    if (how < 2 / 3) return without(base, key);
    return { ...base, [key]: 7 };
  }
  if (base["kind"] === "ORDER") {
    const observation = oms["observation"];
    if (mutation === "ENVELOPE") {
      const how = rand();
      if (how < 1 / 3) return { ...base, oms: withAccessor(oms, "observation") };
      if (how < 2 / 3) return { ...base, oms: without(oms, "observation") };
      return { ...base, oms: { ...oms, observation: pick(rand, [7, undefined, "not an observation"]) } };
    }
    if (mutation === "OPAQUE_ENTRY" || mutation === "HOLE_ENTRY") return { ...base, oms: withAccessor(oms, "observation") };
    if (observation === null || typeof observation !== "object") return base;
    return { ...base, oms: { ...oms, observation: mutateRowFields(rand, observation as Row, OBSERVATION_KEYS, ["DROP_FIELD", "WRONG_TYPE", "ACCESSOR", "TRUNCATE_ROW"].includes(mutation) ? mutation : "WRONG_TYPE") } };
  }
  const field = pick(rand, ["fills", "settlements"] as const);
  const items = Array.isArray(oms[field]) ? (oms[field] as Row[]) : [];
  const keys = field === "fills" ? FILL_KEYS : SETTLEMENT_KEYS;
  if (mutation === "ENVELOPE") {
    const how = rand();
    if (how < 1 / 3) return { ...base, oms: withAccessor(oms, field) };
    if (how < 2 / 3) return { ...base, oms: without(oms, field) };
    return { ...base, oms: { ...oms, [field]: pick(rand, ["not a list", undefined, null]) } };
  }
  if (items.length === 0) return base;
  const index = Math.floor(rand() * items.length);
  if (mutation === "OPAQUE_ENTRY") return { ...base, oms: { ...oms, [field]: opaqueEntry(items, index) } };
  if (mutation === "HOLE_ENTRY") return { ...base, oms: { ...oms, [field]: holeEntry(items, index) } };
  if (mutation === "DUPLICATE") return { ...base, oms: { ...oms, [field]: [...items, clone(items[index])] } };
  return {
    ...base,
    oms: { ...oms, [field]: items.map((item, at) => (at === index ? mutateRowFields(rand, item, keys, ["DROP_FIELD", "WRONG_TYPE", "INEXACT_DECIMAL", "ACCESSOR", "TRUNCATE_ROW"].includes(mutation) ? mutation : "WRONG_TYPE") : item)) },
  };
}

// ---------------------------------------------------------------------------
// The oracle.

/** One field of a delivered row, read on its own: its value when own data in its domain; `UNREADABLE` otherwise. */
export const UNREADABLE = Symbol("unreadable");
export type Expected = Readonly<Record<string, unknown>>;

function own(row: unknown, key: string): { readonly data: true; readonly value: unknown } | { readonly data: false } {
  if (row === null || typeof row !== "object") return { data: false };
  const descriptor = Object.getOwnPropertyDescriptor(row, key);
  if (descriptor === undefined || !("value" in descriptor)) return { data: false };
  return { data: true, value: descriptor.value };
}

const ISO = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?(?:Z|[+-][0-9]{2}:[0-9]{2})$/u;
const nullOr =
  (valid: (value: unknown) => boolean) =>
  (value: unknown): boolean =>
    value === null || valid(value);

/** The domain of every field the doors read (`ports.ts`). */
export const DOMAINS: Readonly<Record<string, (value: unknown) => boolean>> = {
  venueOrderId: isVenueId,
  venueTradeId: isIdentifier,
  tokenId: isTokenId,
  side: (value) => value === "BUY" || value === "SELL",
  price: isUnitPrice,
  originalSize: isPositiveAmount,
  sizeMatched: isNonNegativeAmount,
  status: isIdentifier,
  role: (value) => value === "MAKER" || value === "TAKER",
  liquidityRole: (value) => value === "MAKER" || value === "TAKER",
  shares: isPositiveAmount,
  feeAmount: nullOr(isNonNegativeAmount),
  feeAssetId: nullOr(isIdentifier),
  matchedAt: (value) => typeof value === "string" && ISO.test(value),
  transactionHash: nullOr(isIdentifier),
  ownershipUndetermined: (value) => typeof value === "boolean",
  size: isNonNegativeAmount,
  assetId: isIdentifier,
  balance: isNonNegativeAmount,
  spender: isIdentifier,
  approved: (value) => typeof value === "boolean",
  state: (value) => typeof value === "string" && ["CONFIRMED", "FAILED", "PENDING", "DROPPED", "NOT_FOUND", "UNSUPPORTED"].includes(value),
  credited: nullOr(isNonNegativeAmount),
};

/** Every field of one delivered row: its value when validated on its own, `UNREADABLE` otherwise. */
export function expectedRow(row: unknown, keys: readonly string[], optionalNull: readonly string[] = []): Expected {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const read = row === UNREADABLE ? ({ data: false } as const) : own(row, key);
    const domain = DOMAINS[key] as (value: unknown) => boolean;
    if (!read.data && optionalNull.includes(key) && row !== UNREADABLE && row !== null && typeof row === "object" && !Object.prototype.hasOwnProperty.call(row, key)) {
      out[key] = null;
      continue;
    }
    out[key] = read.data && domain(read.value) ? read.value : UNREADABLE;
  }
  return out;
}

/** The entries of a delivered list: each own data entry, or `UNREADABLE` for an index that is not; `undefined` when not a list. */
export function expectedEntries(value: unknown, max: number): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (value.length > max) return undefined;
  const out: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const read = own(value, String(index));
    out.push(read.data ? read.value : UNREADABLE);
  }
  return out;
}

/** The route of a delivered answer: `RIGHT`, `OTHER` (a readable string naming another source) or `UNREADABLE`. */
export function expectedRoute(answer: unknown, key: string, right: string): "RIGHT" | "OTHER" | "UNREADABLE" {
  const read = own(answer, key);
  if (!read.data || typeof read.value !== "string") return "UNREADABLE";
  return read.value === right ? "RIGHT" : "OTHER";
}

/**
 * (r12) What a delivered user-stream output carries, read by the oracle on its own: every item (a row of fragments) and
 * every unreadable entry BY NAME (`<item kind>:<field>`, as the door names it: `FILL:kind`, `ORDER:oms`, `FILL:oms`,
 * `ORDER:observation`, `FILL:fills`, `SETTLEMENT:settlements`, `<kind>:entry`). Every key of WP-280's projection the
 * door reads is present in every output WP-280 emits: one that is MISSING is unreadable, never "nothing"
 * (WP290-CX-R12-01).
 */
export function expectedStream(answer: unknown, maxItems: number): { readonly items: { kind: string; row: Expected }[]; readonly unreadable: string[] } {
  const kind = own(answer, "kind");
  const oms = own(answer, "oms");
  const items: { kind: string; row: Expected }[] = [];
  // Each unreadable entry by name (`<item kind>:<field>`): r12 states them by name, not by count.
  const unreadable: string[] = [];
  const projection = oms.data && oms.value !== null && typeof oms.value === "object" ? oms.value : undefined;
  // An output whose own kind cannot be read: one unreadable entry (it may have been any output, a TRADE among them).
  if (!kind.data || typeof kind.value !== "string") unreadable.push("FILL:kind");
  else if (kind.value === "ORDER") {
    // (r12, WP290-CX-R12-01) WP-280's ORDER projection always carries `observation` (null: no observation): a key
    // that is MISSING, not own data, or `undefined` is unreadable, never "nothing".
    const observation = projection === undefined ? undefined : Object.getOwnPropertyDescriptor(projection, "observation");
    if (projection === undefined) unreadable.push("ORDER:oms");
    else if (observation === undefined || !("value" in observation) || observation.value === undefined) unreadable.push("ORDER:observation");
    else if (observation.value !== null) items.push({ kind: "ORDER", row: expectedRow(observation.value, OBSERVATION_KEYS) });
  } else if (kind.value === "TRADE") {
    if (projection === undefined) unreadable.push("FILL:oms");
    else {
      for (const [field, itemKind, keys, optional] of [
        ["fills", "FILL", FILL_KEYS, ["feeAmount", "feeAssetId"]],
        ["settlements", "SETTLEMENT", SETTLEMENT_KEYS, ["transactionHash"]],
      ] as const) {
        // (r12, WP290-CX-R12-01) WP-280's TRADE projection always carries both lists: a MISSING one is unreadable.
        const descriptor = Object.getOwnPropertyDescriptor(projection, field);
        const entries = descriptor !== undefined && "value" in descriptor ? expectedEntries(descriptor.value, maxItems) : undefined;
        if (entries === undefined) {
          unreadable.push(`${itemKind}:${field}`);
          continue;
        }
        for (const entry of entries) {
          if (entry === UNREADABLE) unreadable.push(`${itemKind}:entry`);
          else items.push({ kind: itemKind, row: expectedRow(entry, keys, optional) });
        }
      }
    }
  }
  return { items, unreadable };
}

export { APPROVAL_KEYS, COLLATERAL_KEYS, FILL_KEYS, LEG_KEYS, MEMBER_KEYS, OBSERVATION_KEYS, ORDER_KEYS, POSITION_KEYS, SETTLEMENT_KEYS, TRADE_KEYS, own };
