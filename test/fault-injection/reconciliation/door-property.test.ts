/**
 * WP-290 r11: THE DOOR PROPERTY (the class fix at the door layer). For every door (open orders, by id, trades,
 * positions, the collateral balance, approvals, a wallet member, a user-stream output), a seeded generator builds a
 * VALID answer, MUTATES it (`support/mutate.ts`: a field dropped, of the wrong type, an inexact decimal, an accessor, a
 * row relabelled, `found` flipped or removed, a row listed twice, a malformed sibling, the list or a row truncated, a
 * list entry that is not own data, a leg broken, the envelope broken), and asserts, for every delivered answer:
 *
 * 1. EVERY FRAGMENT VALIDATED IN ISOLATION appears in the door's output (`ReadOutcome.salvage`, or the stream door's
 *    items), with its value; EVERY FRAGMENT PRESENT BUT UNREADABLE (or missing) appears as unreadable, never as
 *    nothing; an entry of a readable list that is not own data is a row every field of which is unreadable. The oracle
 *    reads the delivered answer itself, field by field (`support/mutate.ts`), independently of the door's code. The
 *    one boundary: an answer whose route (or source) is a readable string naming ANOTHER source keeps nothing (E-15,
 *    U-22), whatever it carries;
 * 2. every outcome carries its salvage (a door cannot return MALFORMED, INCOMPLETE or OK without it), and an OK outcome
 *    carries no unreadable fragment;
 * 3. (the recording, end to end) every salvage list goes into the evidence store through the coordinator's ONE
 *    recording function, journaled: each fragment the door kept is in a journaled evidence record, and each row whose
 *    identity was unreadable is an UNREADABLE obligation that a restart replays and that holds the account in every
 *    run.
 *
 * The seeds and case counts are printed (`DOOR-PROPERTY ...`) for the handoff.
 *
 * PAPER only: pure doors over generated plain data, and the in-memory simulated venue; no network, key or signer.
 */

import { describe, expect, it } from "vitest";

import { compareDecimal } from "../../../packages/decimal/src/index.js";
import { compositeKey } from "../../../packages/oms/src/guards.js";
import type { OrderManager } from "../../../packages/oms/src/index.js";
import {
  MAX_LEGS_PER_TRADE,
  MAX_READ_ENTRIES,
  MAX_STREAM_ITEMS,
  readApprovals,
  readCollateral,
  readOpenOrders,
  readOrderById,
  readPositions,
  readStreamOutput,
  readTrades,
  readWalletMember,
  type LegFragments,
  type OrderFragments,
  type ReadOutcome,
  type Salvage,
  type TradeFragments,
} from "../../../packages/oms/src/reconciliation/door.js";
import { EvidenceStore, readEvidenceRecords } from "../../../packages/oms/src/reconciliation/evidence.js";

import { PUSD, YES, boot } from "./support/harness.js";
import {
  APPROVAL_KEYS,
  COLLATERAL_KEYS,
  DOORS,
  FILL_KEYS,
  LEG_KEYS,
  MEMBER_KEYS,
  MUTATIONS,
  OBSERVATION_KEYS,
  ORDER_KEYS,
  POSITION_KEYS,
  SETTLEMENT_KEYS,
  UNREADABLE,
  expectedEntries,
  expectedRoute,
  expectedRow,
  expectedStream,
  mutateAnswer,
  own,
  type Door,
  type Expected,
  type Mutation,
} from "./support/mutate.js";
import { seeded } from "./support/property.js";
import { ready, type Ready } from "./support/scenario.js";

type Row = Record<string, unknown>;
type Rand = () => number;

const NO = "48331043336612883890938759509493159234755048973500640148014422747788308965732";
const TOKENS = [YES, NO];
const COLLATERAL = PUSD;

function pick<T>(rand: Rand, list: readonly T[]): T {
  return list[Math.floor(rand() * list.length)] as T;
}

function decimal(rand: Rand, choices: readonly string[]): string {
  return pick(rand, choices);
}

function orderRow(rand: Rand, id: string): Row {
  const original = decimal(rand, ["1", "2", "0.5"]);
  return { venueOrderId: id, tokenId: pick(rand, TOKENS), side: pick(rand, ["BUY", "SELL"]), price: decimal(rand, ["0.5", "0.45", "0.9"]), originalSize: original, sizeMatched: decimal(rand, ["0", "0.2", original]), status: pick(rand, ["LIVE", "MATCHED", "CANCELED"]) };
}

function legRow(rand: Rand, orderId: string): Row {
  const fee = rand() < 0.3 ? null : decimal(rand, ["0", "0.01"]);
  return {
    venueOrderId: orderId,
    role: pick(rand, ["MAKER", "TAKER"]),
    tokenId: pick(rand, TOKENS),
    side: pick(rand, ["BUY", "SELL"]),
    shares: decimal(rand, ["0.1", "0.4", "1"]),
    price: decimal(rand, ["0.5", "0.4"]),
    feeAmount: fee,
    feeAssetId: fee !== null && fee !== "0" ? COLLATERAL : rand() < 0.5 ? null : COLLATERAL,
    matchedAt: pick(rand, ["2026-10-03T00:00:00Z", "2026-10-03T00:00:01.5+00:00"]),
  };
}

function tradeRow(rand: Rand, id: string, orderIds: readonly string[]): Row {
  const undetermined = rand() < 0.15;
  const count = undetermined && rand() < 0.5 ? 0 : 1 + Math.floor(rand() * 2);
  const orders = [...orderIds].sort(() => rand() - 0.5).slice(0, count);
  return { venueTradeId: id, status: pick(rand, ["CONFIRMED", "TRADE_STATUS_MINED", "MATCHED", "FAILED"]), transactionHash: rand() < 0.3 ? null : `0x${id}`, ownershipUndetermined: undetermined, ownLegs: orders.map((orderId) => legRow(rand, orderId)) };
}

/** A valid answer of one door (and, for the stream, one output). */
function validAnswer(rand: Rand, door: Door): unknown {
  const orderIds = ["venue-1", "venue-2", "venue-3", "venue-4"];
  switch (door) {
    case "open-orders":
      return { route: "/data/orders", complete: true, orders: orderIds.slice(0, Math.floor(rand() * 4) + 1).map((id) => orderRow(rand, id)) };
    case "by-id":
      return rand() < 0.15 ? { route: "/data/order", found: false } : { route: "/data/order", found: true, order: orderRow(rand, "venue-1") };
    case "trades":
      return { route: "/data/trades", complete: true, trades: ["t1", "t2", "t3"].slice(0, Math.floor(rand() * 3) + 1).map((id) => tradeRow(rand, id, orderIds)) };
    case "positions":
      return { route: "/v2/positions", complete: true, positions: TOKENS.slice(0, Math.floor(rand() * 2) + 1).map((tokenId) => ({ tokenId, size: decimal(rand, ["0", "1.5", "0.4"]) })) };
    case "collateral":
      return { source: "ONCHAIN_ERC20_BALANCE", assetId: COLLATERAL, balance: decimal(rand, ["1000", "999.8"]) };
    case "approvals":
      return { route: "/v2/approvals", approvals: ["0xspender-a", "0xspender-b"].slice(0, Math.floor(rand() * 2) + 1).map((spender) => ({ spender, approved: rand() < 0.7 })) };
    case "wallet-member": {
      const state = pick(rand, ["CONFIRMED", "FAILED", "PENDING", "DROPPED"]);
      return { state, transactionHash: state === "CONFIRMED" || rand() < 0.5 ? "0xhash" : null, credited: state === "CONFIRMED" && rand() < 0.6 ? "5" : null };
    }
    case "stream":
      if (rand() < 0.35) return { kind: "ORDER", oms: { observation: { venueOrderId: pick(rand, orderIds), status: pick(rand, ["LIVE", "CANCELED"]) }, shortfalls: [] } };
      return {
        kind: "TRADE",
        oms: {
          fills: [0, 1].slice(0, Math.floor(rand() * 2) + 1).map((index) => {
            const leg = legRow(rand, orderIds[index] as string);
            const fill: Row = { venueTradeId: `t${String(index + 1)}`, venueOrderId: leg["venueOrderId"], shares: leg["shares"], price: leg["price"], liquidityRole: leg["role"], matchedAt: leg["matchedAt"] };
            if (rand() < 0.7) fill["feeAmount"] = leg["feeAmount"] ?? "0";
            if (rand() < 0.5) fill["feeAssetId"] = leg["feeAssetId"];
            return fill;
          }),
          settlements: rand() < 0.5 ? [] : [{ venueTradeId: "t1", venueOrderId: "venue-1", status: pick(rand, ["MINED", "CONFIRMED"]), transactionHash: rand() < 0.5 ? "0xhash" : null }],
          shortfalls: [],
        },
      };
  }
}

/** The door's output for one delivered answer. */
function readDoor(door: Door, answer: unknown): ReadOutcome<unknown> | ReturnType<typeof readStreamOutput> {
  switch (door) {
    case "open-orders":
      return readOpenOrders(answer);
    case "by-id":
      return readOrderById(answer, "venue-1");
    case "trades":
      return readTrades(answer);
    case "positions":
      return readPositions(answer);
    case "collateral":
      return readCollateral(answer, COLLATERAL);
    case "approvals":
      return readApprovals(answer);
    case "wallet-member":
      return readWalletMember(answer);
    case "stream":
      return readStreamOutput(answer);
  }
}

/** A door fragment row, as the oracle states it: each field's value, or UNREADABLE when the door listed it unreadable. */
function asExpected(fragments: Readonly<Record<string, unknown>> & { readonly unreadable: readonly string[] }, keys: readonly string[], rename: Readonly<Record<string, string>> = {}): Expected {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const field = rename[key] ?? key;
    out[key] = fragments.unreadable.includes(key) || fragments.unreadable.includes(field) ? UNREADABLE : fragments[field];
  }
  return out;
}

function orderRows(salvage: Salvage): Expected[] {
  return salvage.orders.map((row: OrderFragments) => asExpected(row as unknown as Readonly<Record<string, unknown>> & { unreadable: readonly string[] }, ORDER_KEYS));
}

function legRows(legs: readonly LegFragments[]): Expected[] {
  return legs.map((leg) => asExpected(leg as unknown as Readonly<Record<string, unknown>> & { unreadable: readonly string[] }, LEG_KEYS));
}

function tradeRows(salvage: Salvage): { readonly row: Expected; readonly legs: Expected[] | "UNREADABLE" }[] {
  return salvage.trades.map((trade: TradeFragments) => ({
    row: asExpected(trade as unknown as Readonly<Record<string, unknown>> & { unreadable: readonly string[] }, ["venueTradeId", "status", "transactionHash", "ownershipUndetermined"]),
    legs: trade.unreadable.includes("ownLegs") ? ("UNREADABLE" as const) : legRows(trade.legs),
  }));
}

function holdingRows(salvage: Salvage, keys: readonly [string, string]): Expected[] {
  return salvage.holdings.map((holding) => {
    const [key, value] = keys;
    const out: Record<string, unknown> = {};
    out[key] = holding.unreadable.includes(key as never) ? UNREADABLE : holding.key;
    out[value] = holding.unreadable.includes(value as never) ? UNREADABLE : value === "approved" ? holding.value === "true" : holding.value;
    return out;
  });
}

/** The fragments the oracle expects of a delivered answer (independent of the door). */
function oracle(door: Door, answer: unknown): unknown {
  const list = (key: string, max: number): unknown[] => {
    const read = own(answer, key);
    return (read.data ? expectedEntries(read.value, max) : undefined) ?? [];
  };
  switch (door) {
    case "open-orders":
      return expectedRoute(answer, "route", "/data/orders") === "OTHER" ? [] : list("orders", MAX_READ_ENTRIES).map((entry) => expectedRow(entry, ORDER_KEYS));
    case "by-id": {
      if (expectedRoute(answer, "route", "/data/order") === "OTHER") return { rows: [], found: null };
      const descriptor = answer !== null && typeof answer === "object" ? Object.getOwnPropertyDescriptor(answer, "order") : undefined;
      const accessor = descriptor !== undefined && !("value" in descriptor);
      const value = descriptor !== undefined && "value" in descriptor ? (descriptor.value as unknown) : undefined;
      const rows = accessor ? [expectedRow(UNREADABLE, ORDER_KEYS)] : value === undefined || value === null ? [] : [expectedRow(value, ORDER_KEYS)];
      const found = own(answer, "found");
      return { rows, found: found.data && typeof found.value === "boolean" ? found.value : null };
    }
    case "trades":
      return expectedRoute(answer, "route", "/data/trades") === "OTHER"
        ? []
        : list("trades", MAX_READ_ENTRIES).map((entry) => {
            const legs = own(entry === UNREADABLE ? null : entry, "ownLegs");
            const entries = legs.data ? expectedEntries(legs.value, MAX_LEGS_PER_TRADE) : undefined;
            return { row: expectedRow(entry, ["venueTradeId", "status", "transactionHash", "ownershipUndetermined"]), legs: entries === undefined ? "UNREADABLE" : entries.map((leg) => expectedRow(leg, LEG_KEYS)) };
          });
    case "positions":
      return expectedRoute(answer, "route", "/v2/positions") === "OTHER" ? [] : list("positions", MAX_READ_ENTRIES).map((entry) => expectedRow(entry, POSITION_KEYS));
    case "approvals":
      return expectedRoute(answer, "route", "/v2/approvals") === "OTHER" ? [] : list("approvals", MAX_READ_ENTRIES).map((entry) => expectedRow(entry, APPROVAL_KEYS));
    case "collateral":
      return expectedRoute(answer, "source", "ONCHAIN_ERC20_BALANCE") === "OTHER" ? [] : [expectedRow(answer !== null && typeof answer === "object" ? answer : UNREADABLE, COLLATERAL_KEYS)];
    case "wallet-member":
      return [expectedRow(answer !== null && typeof answer === "object" ? answer : UNREADABLE, MEMBER_KEYS)];
    case "stream":
      return expectedStream(answer, MAX_STREAM_ITEMS);
  }
}

/**
 * The envelope fields the oracle expects named unreadable: a route (or source) that is not text; `complete` or `found`
 * that is not a boolean; a list that is not a list of own data; a by-id answer that says found but carries no row. An
 * answer of another readable route names none (it keeps nothing).
 */
function envelopeOracle(door: Door, answer: unknown): string[] {
  const out: string[] = [];
  const routeKey = door === "collateral" ? "source" : "route";
  const right = { "open-orders": "/data/orders", "by-id": "/data/order", trades: "/data/trades", positions: "/v2/positions", collateral: "ONCHAIN_ERC20_BALANCE", approvals: "/v2/approvals" }[door as "open-orders"];
  const route = expectedRoute(answer, routeKey, right);
  if (route === "OTHER") return out;
  if (route === "UNREADABLE") out.push(routeKey);
  const boolean = (key: string): boolean => {
    const read = own(answer, key);
    return read.data && typeof read.value === "boolean";
  };
  if ((door === "open-orders" || door === "trades" || door === "positions") && !boolean("complete")) out.push("complete");
  const list = { "open-orders": "orders", trades: "trades", positions: "positions", approvals: "approvals" }[door as "open-orders"];
  if (list !== undefined) {
    const read = own(answer, list);
    const entries = read.data ? expectedEntries(read.value, MAX_READ_ENTRIES) : undefined;
    if (entries === undefined || entries.includes(UNREADABLE)) out.push(list);
  }
  if (door === "by-id") {
    if (!boolean("found")) out.push("found");
    const descriptor = answer !== null && typeof answer === "object" ? Object.getOwnPropertyDescriptor(answer, "order") : undefined;
    const carried = descriptor !== undefined && (!("value" in descriptor) || (descriptor.value !== undefined && descriptor.value !== null));
    const found = own(answer, "found");
    if (found.data && found.value === true && !carried) out.push("order");
  }
  return out.sort();
}

/** The door's output, stated as the oracle states it. */
function stated(door: Door, output: ReturnType<typeof readDoor>): unknown {
  if (door === "stream") {
    const stream = output as ReturnType<typeof readStreamOutput>;
    return {
      items: stream.items.map((item) => {
        const keys = item.fragments.kind === "ORDER" ? OBSERVATION_KEYS : item.fragments.kind === "FILL" ? FILL_KEYS : SETTLEMENT_KEYS;
        return { kind: item.fragments.kind, row: asExpected(item.fragments as unknown as Readonly<Record<string, unknown>> & { unreadable: readonly string[] }, keys, { liquidityRole: "role" }) };
      }),
      unreadable: stream.unreadable.map((entry) => `${entry.kind}:${entry.field}`),
    };
  }
  const { salvage } = output as ReadOutcome<unknown>;
  switch (door) {
    case "open-orders":
      return orderRows(salvage);
    case "by-id":
      return { rows: orderRows(salvage), found: salvage.found };
    case "trades":
      return tradeRows(salvage);
    case "positions":
      return holdingRows(salvage, ["tokenId", "size"]);
    case "approvals":
      return holdingRows(salvage, ["spender", "approved"]);
    case "collateral":
      return holdingRows(salvage, ["assetId", "balance"]);
    case "wallet-member":
      return salvage.members.map((member) => asExpected(member as unknown as Readonly<Record<string, unknown>> & { unreadable: readonly string[] }, MEMBER_KEYS));
  }
}

/** Whether any fragment of a stated output is unreadable. */
function anyUnreadable(value: unknown): boolean {
  if (value === UNREADABLE || value === "UNREADABLE") return true;
  if (Array.isArray(value)) return value.some(anyUnreadable);
  if (value !== null && typeof value === "object") return Object.values(value).some(anyUnreadable);
  return false;
}

const SEEDS_PER_DOOR = 2500;

/** (r12) Whether a delivered stream output lacks one of the keys the door reads (`kind`, `oms`, `observation`, `fills`, `settlements`). */
function streamKeyMissing(answer: unknown): boolean {
  const has = (value: unknown, key: string): boolean => value !== null && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, key);
  if (!has(answer, "kind") || !has(answer, "oms")) return true;
  const kind = own(answer, "kind");
  const projection = own(answer, "oms");
  if (!kind.data || !projection.data) return false;
  if (kind.value === "ORDER") return !has(projection.value, "observation");
  return kind.value === "TRADE" && (!has(projection.value, "fills") || !has(projection.value, "settlements"));
}

describe("WP-290 r11: the door property (the class fix at the door layer)", () => {
  it(`every door, ${String(SEEDS_PER_DOOR)} seeds each (1 to ${String(SEEDS_PER_DOOR)}): every fragment validated in isolation is in the door's output, every fragment present but unreadable is listed unreadable, every outcome carries its salvage`, () => {
    const counts = new Map<string, number>();
    let cases = 0;
    let unreadableCases = 0;
    let doubles = 0;
    let streamKeysMissing = 0;
    for (const door of DOORS) {
      for (let seed = 1; seed <= SEEDS_PER_DOOR; seed += 1) {
        const rand = seeded(seed * 31 + DOORS.indexOf(door));
        const valid = validAnswer(rand, door);
        const mutation: Mutation = pick(rand, MUTATIONS);
        // One case in three applies a second mutation on top (a garbled id AND a broken leg, say).
        const second: Mutation = rand() < 1 / 3 ? pick(rand, MUTATIONS) : "NONE";
        const delivered = mutateAnswer(rand, door, mutateAnswer(rand, door, valid, mutation, ["venue-2", "venue-9", "t2", "t9"]), second, ["venue-2", "venue-9", "t2", "t9"]);
        const output = readDoor(door, delivered);
        cases += 1;
        if (second !== "NONE") doubles += 1;
        counts.set(`${door}/${mutation}`, (counts.get(`${door}/${mutation}`) ?? 0) + 1);
        const expected = oracle(door, delivered);
        const actual = stated(door, output);
        expect(actual, `${door} seed ${String(seed)} ${mutation}`).toEqual(expected);
        if (anyUnreadable(expected) || (door === "stream" && (expected as ReturnType<typeof expectedStream>).unreadable.length > 0)) unreadableCases += 1;
        // (r12) The stream outputs delivered with one of the door's own keys MISSING (WP290-CX-R12-01's shape).
        if (door === "stream" && streamKeyMissing(delivered)) streamKeysMissing += 1;
        if (door !== "stream") {
          const outcome = output as ReadOutcome<unknown>;
          expect(outcome.salvage, `${door} seed ${String(seed)}: an outcome without its salvage`).toBeDefined();
          // Every envelope field present but unreadable is named (the read's own break is its obligation).
          if (door !== "wallet-member") expect([...outcome.salvage.envelope], `${door} seed ${String(seed)} ${mutation}: the envelope`).toEqual(envelopeOracle(door, delivered));
          if (outcome.kind === "OK") {
            expect(anyUnreadable(actual), `${door} seed ${String(seed)}: an OK outcome with an unreadable fragment`).toBe(false);
            expect(outcome.salvage.envelope).toEqual([]);
          }
        }
      }
    }
    console.log(`DOOR-PROPERTY doors=${String(DOORS.length)} seeds=1..${String(SEEDS_PER_DOOR)} cases=${String(cases)} doubleMutations=${String(doubles)} withUnreadable=${String(unreadableCases)} streamKeyMissing=${String(streamKeysMissing)} byMutation=${JSON.stringify(Object.fromEntries([...counts].sort()))}`);
    expect(cases).toBe(DOORS.length * SEEDS_PER_DOOR);
    expect(streamKeysMissing, "the key-deletion mutation is drawn").toBeGreaterThan(0);
    // About 0.5 s alone; a generous bound, so a loaded host never times it out (vitest's default is 5 s).
  }, 120_000);

  it("(named) the CX-R9-01, CX-R10-01 and V10-UNKEYED shapes: a readable trade id under a malformed leg; a by-id row under found false, found absent, and another id; a valid leg under an unreadable trade id: every fragment kept", () => {
    const leg = { venueOrderId: "venue-1", role: "MAKER", tokenId: YES, side: "BUY", shares: "0.4", price: "0.5", feeAmount: "0", feeAssetId: null, matchedAt: "2026-10-03T00:00:00Z" };
    const trade = { venueTradeId: "t2", status: "FAILED", transactionHash: "0xh", ownershipUndetermined: false, ownLegs: [{ ...leg, feeAmount: "bad" }] };
    const cx9 = readTrades({ route: "/data/trades", complete: true, trades: [trade] });
    expect(stated("trades", cx9)).toEqual(oracle("trades", { route: "/data/trades", complete: true, trades: [trade] }));
    expect(cx9.salvage.trades[0]?.venueTradeId).toBe("t2");
    expect(cx9.salvage.trades[0]?.legs[0]?.unreadable).toEqual(["feeAmount"]);
    const row = { venueOrderId: "venue-1", tokenId: YES, side: "BUY", price: "0.5", originalSize: "1", sizeMatched: "0.8", status: "LIVE" };
    for (const answer of [{ route: "/data/order", found: false, order: row }, { route: "/data/order", order: row }, { route: "/data/order", found: true, order: { ...row, venueOrderId: "venue-2" } }]) {
      const outcome = readOrderById(answer, "venue-1");
      expect(outcome.kind).toBe("MALFORMED");
      expect(stated("by-id", outcome)).toEqual(oracle("by-id", answer));
      expect(outcome.salvage.orders[0]?.inFull?.sizeMatched).toBe("0.8");
    }
    const v10 = readTrades({ route: "/data/trades", complete: true, trades: [{ ...trade, venueTradeId: 42, ownLegs: [leg] }] });
    expect(v10.salvage.trades[0]).toMatchObject({ venueTradeId: null, status: "FAILED", unreadable: ["venueTradeId"] });
    expect(v10.salvage.trades[0]?.legs[0]?.inFull).toEqual(leg);
  });
});

describe("WP-290 r12 (WP290-CX-R12-01): the stream door's own keys", () => {
  it("(named) a WP-280 output whose observation, fills or settlements key is MISSING: one unreadable entry each, named, as the oracle states; the same key null or an accessor alike; observation null and a missing shortfalls carry none", () => {
    const fill = { venueTradeId: "t1", venueOrderId: "venue-1", shares: "0.4", price: "0.5", liquidityRole: "MAKER", feeAmount: "0", feeAssetId: null, matchedAt: "2026-10-03T00:00:00Z" };
    const settlement = { venueTradeId: "t1", venueOrderId: "venue-1", status: "CONFIRMED", transactionHash: null };
    const accessor = (key: string, value: unknown): Row => {
      const projection: Row = { fills: [fill], settlements: [settlement], observation: { venueOrderId: "venue-1", status: "LIVE" }, shortfalls: [] };
      delete projection[key];
      Object.defineProperty(projection, key, { get: () => value, enumerable: true });
      return projection;
    };
    const cases: [string, unknown, string[]][] = [
      ["TRADE, fills missing", { kind: "TRADE", oms: { settlements: [settlement], shortfalls: [] } }, ["FILL:fills"]],
      ["TRADE, settlements missing", { kind: "TRADE", oms: { fills: [fill], shortfalls: [] } }, ["SETTLEMENT:settlements"]],
      ["TRADE, both missing", { kind: "TRADE", oms: { shortfalls: [] } }, ["FILL:fills", "SETTLEMENT:settlements"]],
      ["TRADE, fills null", { kind: "TRADE", oms: { fills: null, settlements: [settlement], shortfalls: [] } }, ["FILL:fills"]],
      ["TRADE, fills an accessor", { kind: "TRADE", oms: accessor("fills", [fill]) }, ["FILL:fills"]],
      ["ORDER, observation missing", { kind: "ORDER", oms: { shortfalls: [] } }, ["ORDER:observation"]],
      ["ORDER, observation undefined", { kind: "ORDER", oms: { observation: undefined, shortfalls: [] } }, ["ORDER:observation"]],
      ["ORDER, observation an accessor", { kind: "ORDER", oms: accessor("observation", { venueOrderId: "venue-1", status: "LIVE" }) }, ["ORDER:observation"]],
      ["ORDER, oms missing", { kind: "ORDER" }, ["ORDER:oms"]],
      ["TRADE, oms missing", { kind: "TRADE" }, ["FILL:oms"]],
      ["kind missing", { oms: { fills: [fill], settlements: [], shortfalls: [] } }, ["FILL:kind"]],
      ["control: ORDER, observation null", { kind: "ORDER", oms: { observation: null, shortfalls: ["ORDER_STATUS_ABSENT"] } }, []],
      ["control: TRADE, shortfalls missing", { kind: "TRADE", oms: { fills: [fill], settlements: [settlement] } }, []],
      ["control: TRADE, well formed", { kind: "TRADE", oms: { fills: [fill], settlements: [settlement], shortfalls: [] } }, []],
    ];
    for (const [name, answer, names] of cases) {
      const output = readStreamOutput(answer);
      expect(stated("stream", output), name).toEqual(oracle("stream", answer));
      expect(output.unreadable.map((entry) => `${entry.kind}:${entry.field}`), name).toEqual(names);
    }
  });
});

// ---------------------------------------------------------------------------
// The recording, end to end.

async function restarted(r: Ready): Promise<Ready> {
  const p = await boot(r.u);
  return { u: r.u, p, oms: p.oms as OrderManager };
}

const RECORDING_SEEDS = 240;

describe("WP-290 r11: every salvage list goes into the evidence store through the one recording function, journaled and replayed", () => {
  it(`(recording) ${String(RECORDING_SEEDS)} seeds (1 to ${String(RECORDING_SEEDS)}), the order and trade doors: each fragment the door kept is journaled; each unreadable identity is an obligation a restart replays, holding every run`, async () => {
    let cases = 0;
    let obligations = 0;
    for (let seed = 1; seed <= RECORDING_SEEDS; seed += 1) {
      const rand = seeded(seed * 7919);
      const door = pick(rand, ["open-orders", "trades", "by-id"] as const);
      const once = mutateAnswer(rand, door, validAnswer(rand, door), pick(rand, MUTATIONS), ["venue-2", "venue-9", "t2", "t9"]);
      // One seed in two applies a second mutation (a garbled id AND a broken leg, say).
      const delivered = rand() < 0.5 ? mutateAnswer(rand, door, once, pick(rand, MUTATIONS), ["venue-2", "venue-9", "t2", "t9"]) : once;
      let r = await ready();
      if (door === "open-orders") r.u.world.faults.listOpenOrders = () => delivered;
      else if (door === "trades") r.u.world.faults.listTrades = () => delivered;
      else r.u.world.faults.readOrder = (id, answer) => (id === "venue-1" ? delivered : answer());
      // `venue-1` is read by id in every run: it is the id a by-id answer is asked about.
      r.u.world.faults.listOpenOrders ??= (answer) => {
        const read = answer() as Row;
        return door === "by-id" ? { ...read, orders: [{ venueOrderId: "venue-1", tokenId: YES, side: "BUY", price: "0.5", originalSize: "1", sizeMatched: "0", status: "LIVE" }] } : read;
      };
      await r.p.coordinator.reconcile();
      cases += 1;
      const salvage = (readDoor(door, delivered) as ReadOutcome<unknown>).salvage;
      const records = r.p.journal.evidence();
      // Each validated fragment is in some journaled record of its object (a record that adds nothing the evidence did
      // not hold is not journaled again; a matched size or shares below one already held is dominated by it), and each
      // row whose identity was unreadable is in an UNKEYED_* record carrying every fragment it validated.
      const covered = (of: (record: (typeof records)[number]) => boolean, field: string, value: unknown, monotonic = false): boolean =>
        records.some((record) => {
          if (!of(record)) return false;
          const held = (record as unknown as Record<string, unknown>)[field];
          if (monotonic && typeof held === "string" && typeof value === "string") return compareDecimal(held, value) >= 0;
          return held === value;
        });
      for (const row of salvage.orders) {
        if (row.venueOrderId === null) {
          const found = records.some(
            (record) =>
              record.evidenceKind === "UNKEYED_ORDER" &&
              record.tokenId === row.tokenId &&
              record.side === row.side &&
              record.price === row.price &&
              record.originalSize === row.originalSize &&
              record.size === row.sizeMatched &&
              record.status === row.status &&
              JSON.stringify(record.unreadable) === JSON.stringify([...row.unreadable].sort()),
          );
          expect(found, `seed ${String(seed)} ${door}: an unkeyed order row was not journaled: ${JSON.stringify(row)}`).toBe(true);
          continue;
        }
        const ofOrder = (record: (typeof records)[number]): boolean => record.evidenceKind === "ORDER" && record.venueOrderId === row.venueOrderId;
        for (const [field, value] of [
          ["tokenId", row.tokenId],
          ["side", row.side],
          ["price", row.price],
          ["originalSize", row.originalSize],
          ["status", row.status],
        ] as const) {
          if (value !== null) expect(covered(ofOrder, field, value), `seed ${String(seed)} ${door}: order ${row.venueOrderId} ${field} ${value} not journaled`).toBe(true);
        }
        if (row.sizeMatched !== null) expect(covered(ofOrder, "size", row.sizeMatched, true), `seed ${String(seed)} ${door}: order ${row.venueOrderId} matched ${row.sizeMatched} not journaled`).toBe(true);
      }
      for (const trade of salvage.trades) {
        if (trade.venueTradeId !== null) {
          const ofTrade = (record: (typeof records)[number]): boolean => record.evidenceKind === "TRADE" && record.venueTradeId === trade.venueTradeId;
          expect(records.some(ofTrade), `seed ${String(seed)}: trade ${trade.venueTradeId}`).toBe(true);
          if (trade.status !== null) expect(covered(ofTrade, "status", trade.status), `seed ${String(seed)}: trade ${trade.venueTradeId} status`).toBe(true);
          if (trade.transactionHash !== null) expect(covered(ofTrade, "transactionHash", trade.transactionHash), `seed ${String(seed)}: trade ${trade.venueTradeId} hash`).toBe(true);
        } else if (trade.legs.length === 0) {
          expect(records.some((record) => record.evidenceKind === "UNKEYED_TRADE" && record.status === trade.status), `seed ${String(seed)}: an unkeyed legless trade row`).toBe(true);
        }
        for (const leg of trade.legs) {
          const of = (record: (typeof records)[number]): boolean =>
            trade.venueTradeId === null
              ? record.evidenceKind === "UNKEYED_LEG" && record.venueOrderId === leg.venueOrderId
              : leg.venueOrderId === null
                ? record.evidenceKind === "ORPHAN_LEG" && record.venueTradeId === trade.venueTradeId
                : record.evidenceKind === "LEG" && record.venueTradeId === trade.venueTradeId && record.venueOrderId === leg.venueOrderId;
          for (const [field, value] of [
            ["tokenId", leg.tokenId],
            ["side", leg.side],
            ["price", leg.price],
            ["role", leg.role],
            ["matchedAt", leg.matchedAt],
            ["feeAmount", leg.feeAmount],
            ["feeAssetId", leg.feeAssetId],
          ] as const) {
            if (value !== null || !leg.unreadable.includes(field)) {
              if (value === null && (trade.venueTradeId !== null && leg.venueOrderId !== null)) continue;
              expect(covered(of, field, value), `seed ${String(seed)}: a leg's ${field} ${String(value)} was not journaled: ${JSON.stringify(leg)}`).toBe(true);
            }
          }
          if (leg.shares !== null) expect(covered(of, "size", leg.shares, true), `seed ${String(seed)}: a leg's shares ${leg.shares} not journaled`).toBe(true);
        }
      }
      // Replayed: a rebuild from the journal holds the same account-level obligations, and a run after a restart, with
      // truthful reads, detects each of them and does not resume.
      const before = EvidenceStore.fold(readEvidenceRecords(r.p.journal.evidence()) ?? []).accountObligations();
      const unkeyedRows = salvage.orders.filter((row) => row.venueOrderId === null).length + salvage.trades.filter((trade) => trade.venueTradeId === null && trade.legs.length === 0).length;
      if (unkeyedRows > 0) expect(before.length, `seed ${String(seed)}: an unkeyed row left no obligation`).toBeGreaterThan(0);
      if (before.length === 0) continue;
      obligations += before.length;
      r.u.world.faults = {};
      r = await restarted(r);
      const report = await r.p.coordinator.reconcile();
      expect(report.resumed).toBe(false);
      const detected = report.runs.flatMap((run) => run.detections).filter((entry) => entry.breakClass === "READ_CONFLICT" && entry.subjectKey.startsWith(compositeKey("READ_CONFLICT", "unreadable")))
        .length;
      expect(detected, `seed ${String(seed)}: not every replayed obligation held the run`).toBeGreaterThanOrEqual(before.length);
    }
    console.log(`DOOR-RECORDING seeds=1..${String(RECORDING_SEEDS)} cases=${String(cases)} accountObligations=${String(obligations)}`);
  }, 120_000);
});
