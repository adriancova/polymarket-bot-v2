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
 * value outside their shape. (r13, WP290-V13-STREAM-UNKNOWN-KIND-SILENT = WP290-CX-R13-01) A closed-vocabulary
 * discriminant is also given READABLE text outside its vocabulary: a stream output's `kind` (`""`, `"Trade"`,
 * `"TRADE "`, `"order"`, `"ORDERS"`, `"TRADE_BAD"`, and WP-280's non-activity kinds on an output that still carries its
 * projection), and a `status` (`"Failed"`, `"BOGUS"`, `"TRADE_STATUS_FAILED"`, `"MATCHED_NOT_BROADCASTED"`). Every
 * mutated answer is a fresh plain object; nothing of the input is changed.
 *
 * The ORACLE reads a delivered answer field by field, each on its own, with the field domains of `ports.ts` (the
 * guards are the domains' definitions; the oracle's walk over rows, legs and entries is its own): a field that is own
 * data and in its domain is a VALIDATED fragment; one that is present but not (an accessor, the wrong type, out of its
 * domain) or missing is UNREADABLE. An entry of a readable list that is not own data is a row every field of which is
 * unreadable. An answer whose route (or source) is a READABLE string naming another source keeps nothing (E-15, U-22).
 * (r13) The domains of the closed vocabularies are stated from their PRODUCERS' contracts, not from the door: WP-280's
 * five output kinds (`manager.ts`, `UserStreamOutput`) and its five settlement statuses (`venue-facts.ts`,
 * `USER_TRADE_STATUSES`).
 *
 * PAPER only: pure; no network, key or signer.
 */

import { isCanonicalDecimalString } from "../../../../packages/decimal/src/index.js";
import { isIdentifier, isNonNegativeAmount, isPositiveAmount, isTokenId, isUnitPrice } from "../../../../packages/oms/src/guards.js";
import { isVenueId } from "../../../../packages/oms/src/outcomes.js";

export type Door = "open-orders" | "by-id" | "trades" | "positions" | "collateral" | "approvals" | "wallet-member" | "stream" | "stream-request";
/** (r14) The ninth door: a WP-280 reconciliation request (`door.ts`, `readStreamRequest`). */
export const DOORS: readonly Door[] = ["open-orders", "by-id", "trades", "positions", "collateral", "approvals", "wallet-member", "stream", "stream-request"];

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
  // (r13) A status: also readable text outside the documented vocabulary (closed for a stream settlement, WP-280's
  // five; open for an order, a REST trade and a stream order observation, which keep it as text).
  if (key === "status") return pick(rand, [42, "", ["x"], { x: 1 }, "Failed", "BOGUS", "TRADE_STATUS_FAILED", "MATCHED_NOT_BROADCASTED"]);
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
  if (door === "stream-request") return mutateRequest(rand, base, mutation);
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

/** (r14) The fields of WP-280's normalized events the stream door reads (`door.ts`, `EVENT_FIELDS`). */
const EVENT_ORDER_KEYS = ["venueOrderId", "assetId", "side", "price", "originalSize", "sizeMatched", "status"] as const;
const EVENT_TRADE_KEYS = ["venueTradeId", "takerOrderId", "status", "traderSide", "makerOrders", "transactionHash"] as const;
const EVENT_MUTATIONS: readonly Mutation[] = ["DROP_FIELD", "WRONG_TYPE", "ACCESSOR", "WRONG_ID", "TRUNCATE_ROW", "OPAQUE_ENTRY", "HOLE_ENTRY"];

/** (r14) A value of the wrong shape for one of WP-280's `WireEnum` fields, or one outside its vocabulary. */
const WIRE_ENUM_WRONG: readonly unknown[] = [
  7,
  "MATCHED",
  { kind: "KNOWN", value: 7 },
  { kind: "KNOWN", value: "Failed" },
  { kind: "KNOWN" },
  { kind: "WEIRD", value: "MATCHED" },
  { kind: "ABSENT" },
  { kind: "UNRECOGNIZED", lexeme: null, reason: "NOT_IN_VERIFIED_VOCABULARY" },
];

/** (r14) The output's `event` broken (deleted, an accessor, not a record), or the projection's `shortfalls` (deleted, an accessor, out of shape, changed). */
function mutateEventEnvelope(rand: Rand, base: Row, oms: Row): Row {
  if (rand() < 0.5) {
    const how = rand();
    if (how < 1 / 3) return without(base, "event");
    if (how < 2 / 3) return withAccessor(base, "event");
    return { ...base, event: pick(rand, [7, null, "not an event", []]) };
  }
  const how = rand();
  if (how < 0.25) return { ...base, oms: without(oms, "shortfalls") };
  if (how < 0.5) return { ...base, oms: withAccessor(oms, "shortfalls") };
  return { ...base, oms: { ...oms, shortfalls: pick(rand, ["none", 7, [7], ["TRADE_STATUS_UNRECOGNIZED"], ["TRADE_STATUS_C3"], ["NOT_A_SHORTFALL"], [], ["MAKER_FEE_NOT_ON_STREAM"]]) } };
}

/** (r14) One field of WP-280's event broken: deleted, an accessor, relabelled, the wrong type or out of its vocabulary, a maker entry unreadable. */
function mutateEvent(rand: Rand, event: Row, kind: "ORDER" | "TRADE", mutation: Mutation): Row {
  const keys: readonly string[] = kind === "ORDER" ? EVENT_ORDER_KEYS : EVENT_TRADE_KEYS;
  const key = pick(rand, keys);
  const makers = Array.isArray(event["makerOrders"]) ? (event["makerOrders"] as Row[]) : [];
  switch (mutation) {
    case "DROP_FIELD":
      return without(event, key);
    case "ACCESSOR":
      return withAccessor(event, key);
    case "TRUNCATE_ROW": {
      const kept = Math.floor(rand() * keys.length);
      const copy = { ...event };
      for (const name of keys.slice(kept)) delete copy[name];
      return copy;
    }
    case "WRONG_ID": {
      if (kind === "ORDER") return { ...event, venueOrderId: pick(rand, ["venue-9", "venue-2", "has space", 7]) };
      const which = pick(rand, ["venueTradeId", "takerOrderId", "makerOrders"]);
      if (which !== "makerOrders" || makers.length === 0) return { ...event, [which === "makerOrders" ? "takerOrderId" : which]: pick(rand, ["t9", "venue-9", "", 42]) };
      const index = Math.floor(rand() * makers.length);
      return { ...event, makerOrders: makers.map((maker, at) => (at === index ? { ...maker, venueOrderId: pick(rand, ["venue-9", "", 7]) } : maker)) };
    }
    case "OPAQUE_ENTRY":
    case "HOLE_ENTRY": {
      if (kind === "ORDER" || makers.length === 0) return withAccessor(event, key);
      const index = Math.floor(rand() * makers.length);
      return { ...event, makerOrders: mutation === "OPAQUE_ENTRY" ? opaqueEntry(makers, index) : holeEntry(makers, index) };
    }
    default: {
      if (key === "status" || key === "traderSide") return { ...event, [key]: pick(rand, WIRE_ENUM_WRONG) };
      if (key === "makerOrders") {
        const index = Math.floor(rand() * Math.max(makers.length, 1));
        return {
          ...event,
          makerOrders: pick(rand, [
            "not a list",
            [7],
            makers.map((maker, at) => (at === index ? { ...maker, account: pick(rand, ["own", 7, "OWNED"]) } : maker)),
            makers.map((maker, at) => (at === index ? without(maker, "account") : maker)),
          ]),
        };
      }
      if (key === "assetId") return { ...event, assetId: pick(rand, ["0xabc", "x", 7]) };
      return { ...event, [key]: wrongValue(rand, key, event[key]) };
    }
  }
}

/** (r14) One mutation of a WP-280 reconciliation request: a field dropped, an accessor, the wrong type, a cause outside the vocabulary, an id relabelled, its order list's entries broken. */
function mutateRequest(rand: Rand, base: Row, mutation: Mutation): Row {
  const keys = ["requestId", "cause", "markets", "shortfalls", "venueOrderIds", "venueTradeId"] as const;
  const key = pick(rand, keys);
  const ids = Array.isArray(base["venueOrderIds"]) ? (base["venueOrderIds"] as unknown[]) : [];
  switch (mutation) {
    case "DROP_FIELD":
      return without(base, key);
    case "ACCESSOR":
      return withAccessor(base, key);
    case "ENVELOPE":
      return { ...base, cause: pick(rand, ["EVENT_NOT_DELIVERED ", "event_not_delivered", "SOCKET_CLOSED", "EVENT_NOT_FULLY_APPLICABLE", "EVENT_NOT_DELIVERED", 7, ""]) };
    case "WRONG_ID":
      return rand() < 0.5 ? { ...base, venueTradeId: pick(rand, ["t9", null, "trade-x"]) } : { ...base, venueOrderIds: [...ids, pick(rand, ["venue-9", "their-maker-9"])] };
    case "OPAQUE_ENTRY":
    case "HOLE_ENTRY":
      if (ids.length === 0) return withAccessor(base, "venueOrderIds");
      return { ...base, venueOrderIds: mutation === "OPAQUE_ENTRY" ? opaqueEntry(ids, 0) : holeEntry(ids, 0) };
    case "DUPLICATE":
      return { ...base, venueOrderIds: [...ids, ...ids.slice(0, 1)] };
    case "TRUNCATE_LIST":
      return { ...base, venueOrderIds: ids.slice(0, Math.floor(rand() * ids.length)) };
    default:
      return {
        ...base,
        [key]: pick<unknown>(
          rand,
          (
            {
              requestId: [7, "", "has\u0001control"],
              cause: [7, null],
              markets: ["m", [7]],
              shortfalls: ["x", [7], ["TRADE_STATUS_C3"], ["NOT_A_SHORTFALL"]],
              venueOrderIds: ["venue-1", [7], ["has space"], null],
              venueTradeId: [7, "", ["t1"], "has\u0000nul"],
            } as Readonly<Record<string, readonly unknown[]>>
          )[key] as readonly unknown[],
        ),
      };
  }
}

/**
 * (r13) Readable `kind` texts outside WP-280's activity kinds: not one of its five outputs (`""`, `"Trade"`,
 * `"TRADE "`, ...), or one of its three non-activity outputs on an output that still carries its projection.
 */
export const STREAM_KIND_TEXTS = ["", "Trade", "TRADE ", "trade", "order", "ORDERS", "TRADE_BAD", "ORDER_BAD", "STATE", "UNRECOGNIZED_MESSAGE", "RECONCILIATION_REQUESTED"] as const;

/** Whether a stream output's `kind` is own data naming one of WP-280's two activity outputs. */
function activityKind(row: Row): boolean {
  const kind = own(row, "kind");
  return kind.data && (kind.value === "ORDER" || kind.value === "TRADE");
}

/**
 * One mutation of a user-stream output (WP-280's ORDER or TRADE output). ENVELOPE breaks the output's own keys: its
 * `kind` or `oms` (two draws in five), else an ORDER's `observation` or one of a TRADE's lists. Each such key is made an
 * accessor, given a value outside its shape, or (r12, WP290-CX-R12-01) DELETED; (r13) a `kind` is given READABLE text
 * outside WP-280's activity kinds in one draw in two ({@link STREAM_KIND_TEXTS}). A second mutation may meet an output
 * a first one broke (no `oms`, no list): it then mutates what is there. It never DELETES the projection of an output
 * whose kind no longer names an activity output: that would forge a well-formed non-activity output, which carries no
 * fact at all (indistinguishable from a message never sent; WP-280's own gap detection is the defence there), so the
 * projection is made an accessor instead.
 */
function mutateStream(rand: Rand, base: Row, mutation: Mutation): Row {
  const projection = base["oms"];
  const oms: Row = projection !== null && typeof projection === "object" && !Array.isArray(projection) ? (projection as Row) : {};
  // (r14, WP290-V14-WP280-EVENT-IDS-DISCARDED) WP-280's event and the projection's shortfalls: one ENVELOPE draw in
  // four goes to them; and, on an output that carries an event, two field mutations in five break one of its fields.
  if (mutation === "ENVELOPE" && rand() < 0.25) return mutateEventEnvelope(rand, base, oms);
  const event = Object.getOwnPropertyDescriptor(base, "event");
  if (event !== undefined && "value" in event && event.value !== null && typeof event.value === "object" && EVENT_MUTATIONS.includes(mutation) && rand() < 0.4) {
    return { ...base, event: mutateEvent(rand, event.value as Row, base["kind"] === "ORDER" ? "ORDER" : "TRADE", mutation) };
  }
  if (mutation === "ENVELOPE" && rand() < 0.4) {
    const key = rand() < 0.5 ? "kind" : "oms";
    if (key === "kind" && rand() < 0.5) return { ...base, kind: pick(rand, STREAM_KIND_TEXTS) };
    const how = rand();
    if (how < 1 / 3) return withAccessor(base, key);
    if (how < 2 / 3) return key === "oms" && !activityKind(base) ? withAccessor(base, key) : without(base, key);
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
export function expectedRow(row: unknown, keys: readonly string[], optionalNull: readonly string[] = [], domains: Readonly<Record<string, (value: unknown) => boolean>> = {}): Expected {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const read = row === UNREADABLE ? ({ data: false } as const) : own(row, key);
    const domain = (domains[key] ?? DOMAINS[key]) as (value: unknown) => boolean;
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

/** (r13) WP-280's non-activity outputs (`manager.ts`, `UserStreamOutput`): STATE, UNRECOGNIZED_MESSAGE, RECONCILIATION_REQUESTED. */
const STREAM_NON_ACTIVITY_KINDS: readonly string[] = ["STATE", "UNRECOGNIZED_MESSAGE", "RECONCILIATION_REQUESTED"];
/** (r13) The keys of WP-280's ORDER and TRADE outputs that none of its other outputs carries. */
const STREAM_ACTIVITY_ONLY_KEYS: readonly string[] = ["event", "oms"];
/** (r13) WP-280's settlement statuses (`venue-facts.ts`, `USER_TRADE_STATUSES`), plain spelling: a stream settlement's domain. */
const USER_TRADE_STATUSES: readonly string[] = ["MATCHED", "MINED", "CONFIRMED", "RETRYING", "FAILED"];
function isStreamSettlementStatusOracle(value: unknown): boolean {
  return typeof value === "string" && USER_TRADE_STATUSES.includes(value);
}

/** (r14) WP-280's projection shortfalls whose presence says the trade status is one no one can order (`oms-projection.ts`). */
const STATUS_SHORTFALLS: readonly string[] = ["TRADE_STATUS_UNRECOGNIZED", "TRADE_STATUS_C3"];

/** (r14) A projection's `shortfalls` as the oracle reads it: a list of own-data texts, else `undefined` (unreadable). */
function expectedShortfalls(projection: unknown): string[] | undefined {
  const read = own(projection, "shortfalls");
  const entries = read.data ? expectedEntries(read.value, 60) : undefined;
  if (entries === undefined || entries.some((entry) => typeof entry !== "string")) return undefined;
  return entries as string[];
}

/** (r14) One of WP-280's `WireEnum` values as the oracle reads it: the KNOWN value, else `undefined`. */
function knownValue(value: unknown): string | undefined {
  const kind = own(value, "kind");
  const known = own(value, "value");
  return kind.data && kind.value === "KNOWN" && known.data && isIdentifier(known.value) ? known.value : undefined;
}

/**
 * (r14, WP290-V14-WP280-EVENT-IDS-DISCARDED) What a delivered output's EVENT names, read by the oracle on its own from
 * WP-280's contract (`normalize.ts`: the event's fields; `oms-projection.ts` `ownLegs`: which legs are the account's):
 * - ORDER: its order and facts (`assetId` is the token), its status when WP-280 recognised it (`KNOWN`);
 * - TRADE: its trade; its status when it is one of WP-280's five, recognised, and no status shortfall says otherwise;
 *   its transaction hash; the orders of the legs it attributes to the account (the taker order of a TAKER trade, every
 *   maker leg called OWN), how many such legs have no readable order id, and whether every leg's ownership was
 *   determined (a KNOWN trader side, a readable maker list, no maker leg UNDETERMINED or unreadable).
 * `undefined` when the event is not an own-data record.
 */
export function expectedEvent(kind: "ORDER" | "TRADE", answer: unknown, shortfalls: readonly string[] | undefined): Expected | undefined {
  const read = own(answer, "event");
  if (!read.data || read.value === null || typeof read.value !== "object") return undefined;
  const event = read.value;
  const value = (key: string, valid: (candidate: unknown) => boolean): unknown => {
    const field = own(event, key);
    return field.data && valid(field.value) ? field.value : UNREADABLE;
  };
  if (kind === "ORDER") {
    const statusField = own(event, "status");
    const status = statusField.data ? knownValue(statusField.value) : undefined;
    return {
      venueOrderId: value("venueOrderId", isVenueId),
      tokenId: value("assetId", isTokenId),
      side: value("side", DOMAINS["side"] as (candidate: unknown) => boolean),
      price: value("price", isUnitPrice),
      originalSize: value("originalSize", isPositiveAmount),
      sizeMatched: value("sizeMatched", isNonNegativeAmount),
      status: status ?? UNREADABLE,
    };
  }
  const statusField = own(event, "status");
  const status = statusField.data ? knownValue(statusField.value) : undefined;
  const ordered = status !== undefined && USER_TRADE_STATUSES.includes(status) && !(shortfalls ?? []).some((entry) => STATUS_SHORTFALLS.includes(entry));
  const sideField = own(event, "traderSide");
  const side = sideField.data ? knownValue(sideField.value) : undefined;
  const traderSide = side === "TAKER" || side === "MAKER" ? side : undefined;
  let determined = traderSide !== undefined;
  const ownIds = new Set<string>();
  let orphans = 0;
  const taker = own(event, "takerOrderId");
  if (traderSide === "TAKER") {
    if (taker.data && isVenueId(taker.value)) ownIds.add(taker.value);
    else orphans += 1;
  }
  const makersField = own(event, "makerOrders");
  const makers = makersField.data ? (makersField.value === null ? [] : expectedEntries(makersField.value, 1024)) : undefined;
  if (makers === undefined || makers.includes(UNREADABLE)) determined = false;
  for (const maker of makers ?? []) {
    const account = maker === UNREADABLE ? ({ data: false } as const) : own(maker, "account");
    const id = maker === UNREADABLE ? ({ data: false } as const) : own(maker, "venueOrderId");
    if (account.data && account.value === "OWN") {
      if (id.data && isVenueId(id.value)) ownIds.add(id.value);
      else orphans += 1;
    } else if (!(account.data && account.value === "OTHER")) {
      determined = false;
    }
  }
  return {
    venueTradeId: value("venueTradeId", isIdentifier),
    status: ordered ? status : UNREADABLE,
    transactionHash: value("transactionHash", (candidate) => candidate === null || isIdentifier(candidate)),
    own: [...ownIds].sort(),
    orphans,
    determined,
  };
}

/**
 * (r12) What a delivered user-stream output carries, read by the oracle on its own: every item (a row of fragments) and
 * every unreadable entry BY NAME (`<item kind>:<field>`, as the door names it: `FILL:kind`, `ORDER:oms`, `FILL:oms`,
 * `ORDER:observation`, `FILL:fills`, `SETTLEMENT:settlements`, `<kind>:entry`). Every key of WP-280's projection the
 * door reads is present in every output WP-280 emits: one that is MISSING is unreadable, never "nothing"
 * (WP290-CX-R12-01). (r14, WP290-V14-WP280-EVENT-IDS-DISCARDED) And its `event` ({@link expectedEvent}), whenever it is
 * an own-data record; the event is REQUIRED when every projection key was readable and WP-280 did not attest the
 * projection whole (a shortfall, `shortfalls` unreadable, or nothing projected): then an event that cannot be read is
 * `<kind>:event`, and one whose order or trade id cannot be read is `ORDER:venueOrderId` or `FILL:venueTradeId`.
 */
export function expectedStream(answer: unknown, maxItems: number): { readonly items: { kind: string; row: Expected }[]; readonly unreadable: string[]; readonly event?: Expected } {
  const kind = own(answer, "kind");
  const oms = own(answer, "oms");
  const items: { kind: string; row: Expected }[] = [];
  // Each unreadable entry by name (`<item kind>:<field>`): r12 states them by name, not by count.
  const unreadable: string[] = [];
  const projection = oms.data && oms.value !== null && typeof oms.value === "object" ? oms.value : undefined;
  // (r13) Whether the output carries, in any form, a key only WP-280's ORDER and TRADE outputs carry.
  const carriesActivity = answer !== null && typeof answer === "object" && STREAM_ACTIVITY_ONLY_KEYS.some((key) => key in answer);
  let activity: "ORDER" | "TRADE" | undefined;
  // An output whose own kind cannot be read: one unreadable entry (it may have been any output, a TRADE among them).
  if (!kind.data || typeof kind.value !== "string") unreadable.push("FILL:kind");
  else if (STREAM_NON_ACTIVITY_KINDS.includes(kind.value)) {
    // (r13) One of WP-280's non-activity outputs carries nothing, unless it carries an activity output's key: then it
    // may be an ORDER or TRADE output, mis-tagged (unreadable).
    if (carriesActivity) unreadable.push("FILL:kind");
  } else if (kind.value === "ORDER") {
    activity = "ORDER";
    // (r12, WP290-CX-R12-01) WP-280's ORDER projection always carries `observation` (null: no observation): a key
    // that is MISSING, not own data, or `undefined` is unreadable, never "nothing".
    const observation = projection === undefined ? undefined : Object.getOwnPropertyDescriptor(projection, "observation");
    if (projection === undefined) unreadable.push("ORDER:oms");
    else if (observation === undefined || !("value" in observation) || observation.value === undefined) unreadable.push("ORDER:observation");
    else if (observation.value !== null) items.push({ kind: "ORDER", row: expectedRow(observation.value, OBSERVATION_KEYS) });
  } else if (kind.value === "TRADE") {
    activity = "TRADE";
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
          else items.push({ kind: itemKind, row: expectedRow(entry, keys, optional, itemKind === "SETTLEMENT" ? { status: isStreamSettlementStatusOracle } : {}) });
        }
      }
    }
  } else {
    // (r13, WP290-V13-STREAM-UNKNOWN-KIND-SILENT = WP290-CX-R13-01) A readable kind outside WP-280's five outputs
    // (`""`, `"Trade"`, `"TRADE "`, `"order"`, ...): it may have been an ORDER or TRADE output: unreadable, never nothing.
    unreadable.push("FILL:kind");
  }
  if (activity === undefined) return { items, unreadable };
  // (r14) The event: stated whenever readable; required when the projection's keys were all readable and WP-280 did not
  // attest it whole.
  const shortfalls = projection === undefined ? undefined : expectedShortfalls(projection);
  const required = unreadable.length === 0 && (shortfalls === undefined || shortfalls.length > 0 || items.length === 0);
  const event = expectedEvent(activity, answer, shortfalls);
  const prefix = activity === "ORDER" ? "ORDER" : "FILL";
  if (required) {
    if (event === undefined) unreadable.push(`${prefix}:event`);
    else if (activity === "ORDER" && event["venueOrderId"] === UNREADABLE) unreadable.push("ORDER:venueOrderId");
    else if (activity === "TRADE" && event["venueTradeId"] === UNREADABLE) unreadable.push("FILL:venueTradeId");
  }
  return event === undefined ? { items, unreadable } : { items, unreadable, event };
}


/**
 * (r14, WP290-V14-WP280-EVENT-IDS-DISCARDED) A WP-280 reconciliation request as the oracle reads it, on its own, from
 * WP-280's contract (`manager.ts`, `UserStreamReconciliationRequest`, `RECONCILIATION_CAUSES`, `eventScope`;
 * `oms-projection.ts`, `PROJECTION_SHORTFALLS`): its id and cause; the identities it names (required, a missing field
 * unreadable, when the cause is event-level or outside WP-280's vocabulary; an event-level request naming nothing is
 * unreadable); whether its trade's status could have been any.
 */
export function expectedRequest(answer: unknown, causes: readonly string[], shortfallVocabulary: readonly string[]): Expected {
  const present = (key: string): boolean => answer !== null && typeof answer === "object" && Object.prototype.hasOwnProperty.call(answer, key);
  const id = own(answer, "requestId");
  // eslint-disable-next-line no-control-regex
  const requestId = id.data && typeof id.value === "string" && id.value.length > 0 && id.value.length <= 2000 && !/[\u0000-\u001f\u007f]/u.test(id.value) ? id.value : null;
  const causeRead = own(answer, "cause");
  const cause = causeRead.data && typeof causeRead.value === "string" ? causeRead.value : null;
  const eventCause = cause === "EVENT_NOT_FULLY_APPLICABLE" || cause === "EVENT_NOT_DELIVERED";
  const required = eventCause || cause === null || !causes.includes(cause);
  const unreadable = new Set<string>();
  const trade = own(answer, "venueTradeId");
  let venueTradeId: string | null = null;
  if (trade.data && isIdentifier(trade.value)) venueTradeId = trade.value;
  else if (!(trade.data && trade.value === null) && !(!present("venueTradeId") && !required)) unreadable.add("venueTradeId");
  const orders = own(answer, "venueOrderIds");
  const venueOrderIds: string[] = [];
  if (orders.data) {
    const entries = expectedEntries(orders.value, 1024);
    if (entries === undefined) unreadable.add("venueOrderIds");
    for (const entry of entries ?? []) {
      if (entry !== UNREADABLE && isVenueId(entry)) venueOrderIds.push(entry);
      else unreadable.add("venueOrderIds");
    }
  } else if (present("venueOrderIds") || required) {
    unreadable.add("venueOrderIds");
  }
  if (eventCause && venueTradeId === null && venueOrderIds.length === 0 && unreadable.size === 0) unreadable.add("venueOrderIds");
  const shortfalls = !present("shortfalls") && !required ? [] : expectedShortfalls(answer);
  if (shortfalls === undefined) unreadable.add("shortfalls");
  const unordered = cause !== "EVENT_NOT_FULLY_APPLICABLE" || shortfalls === undefined || shortfalls.some((entry) => !shortfallVocabulary.includes(entry) || STATUS_SHORTFALLS.includes(entry));
  const marketsRead = own(answer, "markets");
  const marketEntries = marketsRead.data ? expectedEntries(marketsRead.value, 100_000) : undefined;
  const markets = marketEntries === undefined || marketEntries.includes(UNREADABLE) ? [] : marketEntries.filter((entry): entry is string => typeof entry === "string");
  const opaque = (["requestId", "cause", "markets"] as const).some((key) => present(key) && !own(answer, key).data);
  return { requestId, cause, markets, opaque, eventCause, venueTradeId, venueOrderIds: [...new Set(venueOrderIds)].sort(), unordered, unreadable: [...unreadable].sort() };
}

export { APPROVAL_KEYS, COLLATERAL_KEYS, FILL_KEYS, LEG_KEYS, MEMBER_KEYS, OBSERVATION_KEYS, ORDER_KEYS, POSITION_KEYS, SETTLEMENT_KEYS, TRADE_KEYS, own };
