/**
 * WP-290 r12: THE STREAM DOOR, END TO END, UNDER LAGGING READS (the class fix's requirement 3 for the user-stream door;
 * WP290-CX-R12-01). The door property (`door-property.test.ts`) judges the stream door alone; this property feeds
 * WP-280's outputs through a real coordinator, OMS, ledger and journal, with the reads LAGGING behind what the stream
 * reported (the stream ahead of every read: the shape of r7's WP290-V7-STREAM-REFUSAL-DROPPED, r12's WP290-CX-R12-01,
 * r13's WP290-CX-R13-01 and r14's WP290-V14-WP280-EVENT-IDS-DISCARDED), with a restart in one seed in two.
 *
 * (r14) Its oracle is the VENUE'S TRUTH, not the door's mirror: three seeds in five draw WP-280's REAL output, its
 * normalizer and projection over a venue wire message whose fields the seed varies (the trade status in either
 * spelling, C-3's, garbled; the trader side known, absent or garbled; our maker leg determined, undetermined, or listed
 * twice; `isAccountOwner` bound, unbound or throwing; an order event with no status), emitted exactly as WP-280's manager
 * emits it: the output, then its `EVENT_NOT_FULLY_APPLICABLE` request when the projection has a shortfall
 * (`support/wp280.ts`). In one such seed in six the listener does not take the output, and WP-280's
 * `EVENT_NOT_DELIVERED` request follows. The other seeds draw r12's synthetic projections. Either may then be mutated
 * (`support/mutate.ts`: the key deletion, r13's readable kinds and statuses, r14's event and shortfall mutations).
 *
 * Each seed draws one scenario:
 * - TRADE: a tracked BUY of 1 at 0.5, resumed; the venue matches 0.4 against it (MATCHED, our order the maker); the
 *   stream's output for that match; the order is canceled and every read lags (no trades, no positions, the collateral
 *   as before, the order by id with nothing matched);
 * - ORDER: an UNKNOWN submission the venue took (LIVE); the stream's ORDER output for it; the list reads replay a
 *   snapshot taken before the submission (the by-id read is truthful, or, one seed in three, does not find it either);
 * - SETTLE: a tracked BUY matched 0.4 (MATCHED), its fill delivered by the stream, resumed; the venue FAILS the trade;
 *   the stream's output for the FAILED event; every read replays the snapshot from before the failure.
 *
 * It asserts, for every seed:
 * 1. NOTHING IS LOST WHILE THE READS LAG: no oracle violation (`harness.ts`: R1, resumed only when consistent; R2,
 *    ABSENT never accepted for an order the venue holds; R3), and never ABSENT for the unknown submission;
 * 2. EVERY UNREADABLE ENTRY the door's oracle states (`expectedStream`) is a journaled obligation, and the account never
 *    resumes after it (it holds for good: runbook §10);
 * 3. a fill (or a failed settlement) the OMS did not apply never lets the account resume on the lagging reads;
 * 4. (r14) EVERY IDENTITY the delivered output's event names, and every identity a delivered request names, is in a
 *    journaled evidence record (the trade: `STREAM_TRADE`; an order event's order: any record of it);
 * 5. then the reads are truthful: still no oracle violation, never ABSENT, and an unreadable entry still holds.
 *
 * The seeds and counts per shape are printed (`STREAM-LAG-PROPERTY ...`) for the handoff.
 *
 * PAPER only: every port is the in-memory simulated venue; WP-280's code is pure; no network, key or signer.
 */

import { describe, expect, it } from "vitest";

import type { OrderManager } from "../../../packages/oms/src/index.js";
import { MAX_STREAM_ITEMS } from "../../../packages/oms/src/reconciliation/door.js";
import { PROJECTION_SHORTFALLS, RECONCILIATION_CAUSES, type NormalizeOptions } from "../../../packages/polymarket-secure/src/user-stream/index.js";

import { boot, streamTrade } from "./support/harness.js";
import { MUTATIONS, expectedRequest, expectedStream, mutateAnswer, own, type Mutation } from "./support/mutate.js";
import { seeded } from "./support/property.js";
import { ready, reconcileRounds, sequence, submitOne, type Ready } from "./support/scenario.js";
import type { ReadFaults, VenueTrade } from "./support/world.js";
import { OUR_OWNER, OURS, THEIR_OWNER, Wp280Backlog, wireOrder, wireTrade, wp280Emit, type Wp280Emission } from "./support/wp280.js";

type Row = Record<string, unknown>;
type Rand = () => number;

function pick<T>(rand: Rand, list: readonly T[]): T {
  return list[Math.floor(rand() * list.length)] as T;
}

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`no ${what}`);
  return value;
}

async function restarted(r: Ready, backlog: Wp280Backlog): Promise<Ready> {
  const p = await boot(r.u);
  p.coordinator.bindUserStream(backlog);
  return { u: r.u, p, oms: p.oms as OrderManager };
}

function oracle(r: Ready): string[] {
  return [...r.u.violations, ...r.u.world.violations];
}

/** Every read lags behind the fill (r7's helper). */
function lagEveryRead(r: Ready, collateral: string): void {
  r.u.world.faults = {
    listTrades: () => ({ route: "/data/trades", complete: true, trades: [] }),
    readPositions: () => ({ route: "/v2/positions", complete: true, positions: [] }),
    readCollateral: (answer) => ({ ...(answer() as Row), balance: collateral }),
    readOrder: (_id, answer) => {
      const read = answer() as { order?: Row };
      return { ...read, order: { ...read.order, sizeMatched: "0" } };
    },
  };
}

/** The list reads as the venue answers now (a lagging adapter replays them); the by-id read stays truthful. */
async function listSnapshot(r: Ready): Promise<ReadFaults> {
  const port = r.u.world.readPort();
  const open = await port.listOpenOrders();
  const trades = await port.listTrades();
  const positions = await port.readPositions();
  const collateral = await port.readCollateral();
  return { listOpenOrders: () => open, listTrades: () => trades, readPositions: () => positions, readCollateral: () => collateral };
}

/** (r13) Every read as the venue answers now, the by-id read of `venueOrderId` included (a lagging adapter replays them). */
async function fullSnapshot(r: Ready, venueOrderId: string): Promise<ReadFaults> {
  const faults = await listSnapshot(r);
  const byId = await r.u.world.readPort().readOrder(venueOrderId);
  return { ...faults, readOrder: () => byId };
}

/** (r13) r12's synthetic projection of one settlement event (no fill: the OMS holds it). */
function settlementOutput(trade: { readonly venueTradeId: string; readonly venueOrderId: string }, status: string): Row {
  return { kind: "TRADE", oms: { fills: [], settlements: [{ venueTradeId: trade.venueTradeId, venueOrderId: trade.venueOrderId, status, transactionHash: null, observedAt: "2026-10-03T00:00:01Z" }], shortfalls: [] } };
}

/**
 * (r14) The venue's trade as a wire trade message for WP-280's normalizer, our order the maker leg, its fields varied by
 * the seed: the status (one of `statuses`), the trader side, our leg listed once, twice, or beside another account's,
 * and the binding of `isAccountOwner` (ours, none, one that throws).
 */
function wireOfTrade(rand: Rand, trade: VenueTrade, statuses: readonly string[]): { readonly message: Row; readonly options: NormalizeOptions; readonly tag: string } {
  const status = pick(rand, statuses);
  const traderSide = pick(rand, ["MAKER", "MAKER", "MAKER", "BOGUS", null]);
  const twice = rand() < 0.15;
  const bound = rand();
  const options: NormalizeOptions = bound < 0.6 ? OURS : bound < 0.8 ? {} : { isAccountOwner: (): boolean => { throw new Error("transport"); } };
  const leg = { orderId: trade.venueOrderId, owner: OUR_OWNER, matchedAmount: trade.shares, price: trade.price, assetId: trade.tokenId, side: trade.side };
  const other = { orderId: "their-maker-1", owner: THEIR_OWNER, matchedAmount: trade.shares, price: trade.price, assetId: trade.tokenId, side: trade.side };
  const makers = twice ? [leg, leg] : rand() < 0.2 ? [leg, other] : [leg];
  const message = wireTrade({
    id: trade.venueTradeId,
    takerOrderId: "their-taker-order-1",
    assetId: trade.tokenId,
    side: trade.side === "BUY" ? "SELL" : "BUY",
    size: trade.shares,
    price: trade.price,
    status,
    traderSide,
    transactionHash: trade.transactionHash,
    makers,
  });
  return { message, options, tag: `${status}/${String(traderSide)}/${twice ? "twice" : String(makers.length)}/${bound < 0.6 ? "ours" : bound < 0.8 ? "unbound" : "throws"}` };
}

/** A delivered output whose kind is READABLE text naming neither activity output (r13). */
function kindText(answer: unknown): boolean {
  const kind = own(answer, "kind");
  return kind.data && typeof kind.value === "string" && kind.value !== "ORDER" && kind.value !== "TRADE";
}

/** (r13) A delivered output carrying a settlement whose status is READABLE text outside WP-280's five. */
function settlementStatusText(answer: unknown): boolean {
  const projection = own(answer, "oms");
  const list = projection.data ? own(projection.value, "settlements") : { data: false as const };
  if (!list.data || !Array.isArray(list.value)) return false;
  return (list.value as unknown[]).some((entry) => {
    const status = own(entry, "status");
    return status.data && typeof status.value === "string" && !["MATCHED", "MINED", "CONFIRMED", "RETRYING", "FAILED"].includes(status.value);
  });
}

async function anyResumed(r: Ready, rounds: number): Promise<boolean> {
  let resumed = false;
  for (let round = 0; round < rounds; round += 1) {
    resumed = (await r.p.coordinator.reconcile()).resumed || resumed;
    r.u.clock.t += r.u.policy.quiescenceHorizonMs + 1;
  }
  return resumed;
}

/** One mutated output: ENVELOPE (the output's own keys, deletion included) in about a third of the draws; a second mutation in one in three. */
function mutated(rand: Rand, valid: unknown): { readonly delivered: unknown; readonly mutation: Mutation; readonly second: Mutation } {
  const mutation: Mutation = rand() < 0.3 ? "ENVELOPE" : pick(rand, MUTATIONS);
  const second: Mutation = rand() < 1 / 3 ? pick(rand, MUTATIONS) : "NONE";
  return { delivered: mutateAnswer(rand, "stream", mutateAnswer(rand, "stream", valid, mutation), second), mutation, second };
}

/** Whether the journal holds a stream obligation for the oracle's unreadable entry `<kind>:<field>`. */
function journaled(r: Ready, entry: string): boolean {
  const [kind, field] = entry.split(":") as [string, string];
  return r.p.journal
    .evidence()
    .some((record) =>
      kind === "ORDER" ? record.evidenceKind === "UNKEYED_ORDER" && record.source === "STREAM_ORDER_UNKEYED" : record.evidenceKind === "UNKEYED_TRADE" && record.source === "STREAM_UNREADABLE" && record.unreadable.includes(field as never),
    );
}

/**
 * (r14) The identities a delivered output's event, and the delivered requests, name, as the ORACLE reads them
 * (`support/mutate.ts`, `expectedEvent` and `expectedRequest`, from WP-280's contract): each must be journaled.
 */
function namedIdentities(
  expected: ReturnType<typeof expectedStream> | null,
  requests: readonly unknown[],
): { readonly trades: Set<string>; readonly orders: Set<string>; readonly legs: Set<string>; readonly orphans: Set<string> } {
  const trades = new Set<string>();
  const orders = new Set<string>();
  const legs = new Set<string>();
  const orphans = new Set<string>();
  const event = expected?.event;
  if (event !== undefined) {
    const tradeId = event["venueTradeId"];
    if (typeof tradeId === "string") {
      trades.add(tradeId);
      // Each leg the event attributes to the account, by its order; an own leg with no readable order id, an orphan.
      for (const orderId of (event["own"] as readonly string[] | undefined) ?? []) legs.add(`${tradeId} ${orderId}`);
      if (((event["orphans"] as number | undefined) ?? 0) > 0) orphans.add(tradeId);
    }
    if ("tokenId" in event && typeof event["venueOrderId"] === "string") orders.add(event["venueOrderId"]);
  }
  for (const request of requests) {
    const read = expectedRequest(request, RECONCILIATION_CAUSES, PROJECTION_SHORTFALLS) as { readonly venueTradeId: string | null; readonly venueOrderIds: readonly string[]; readonly unreadable: readonly string[] };
    if (read.venueTradeId !== null) trades.add(read.venueTradeId);
    else if (!read.unreadable.includes("venueTradeId")) for (const id of read.venueOrderIds) orders.add(id);
  }
  return { trades, orders, legs, orphans };
}

const SEEDS = 160;

describe("WP-290 r12, r13, r14: the stream door end to end, under lagging reads (WP290-CX-R12-01's, WP290-CX-R13-01's and WP290-V14-WP280-EVENT-IDS-DISCARDED's class)", () => {
  it(`${String(SEEDS)} seeds (1 to ${String(SEEDS)}): WP-280's real (or a synthetic) output, mutated or not, the reads lagging behind it, a restart in one seed in two: nothing is lost; every unreadable entry is a journaled obligation that holds; every identity named is journaled`, async () => {
    const shapes = new Map<string, number>();
    const shortfallsDrawn = new Map<string, number>();
    let unreadableSeeds = 0;
    let unappliedFills = 0;
    let restarts = 0;
    let resumedAfter = 0;
    let kindTexts = 0;
    let statusTexts = 0;
    let unappliedSettlements = 0;
    let real = 0;
    let notDelivered = 0;
    let identitiesChecked = 0;
    const scenarios = new Map<string, number>();
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const rand = seeded(seed * 104_729);
      const roll = rand();
      const scenario = roll < 0.3 ? "ORDER" : roll < 0.6 ? "SETTLE" : "TRADE";
      scenarios.set(scenario, (scenarios.get(scenario) ?? 0) + 1);
      const withRestart = rand() < 0.5;
      // (r14) Three seeds in five draw WP-280's real output; one such seed in six, the listener does not take it.
      const useReal = rand() < 0.6;
      const taken = !useReal || rand() >= 1 / 6;
      const mutate = rand() < 0.5;
      const r0 = await ready();
      const backlog = new Wp280Backlog();
      r0.p.coordinator.bindUserStream(backlog);
      let attempt: string | null = null;
      let applied = true;
      let valid: unknown;
      let emission: Wp280Emission | null = null;
      let tag: string;
      let after: () => void;
      if (scenario === "TRADE") {
        await submitOne(r0.oms);
        expect(await reconcileRounds(r0, 3)).toBe(true);
        const collateral = r0.u.world.collateral;
        const trade = must(r0.u.world.match(must(r0.u.world.receipts.at(-1), "receipt"), "0.4", { status: "MATCHED" }), "match");
        if (useReal) {
          const wire = wireOfTrade(rand, trade, ["MATCHED", "MATCHED", "TRADE_STATUS_MATCHED", "Matched", "MATCHED_NOT_BROADCASTED"]);
          emission = wp280Emit(wire.message, wire.options);
          valid = emission.output;
          tag = `real ${wire.tag}`;
        } else {
          valid = streamTrade(r0.u, trade.venueTradeId);
          tag = "synthetic";
        }
        after = () => {
          applied = r0.oms.orders()[0]?.filledShares === "0.4";
          r0.u.world.cancel(trade.venueOrderId);
          lagEveryRead(r0, collateral);
        };
      } else if (scenario === "SETTLE") {
        await submitOne(r0.oms);
        expect(await reconcileRounds(r0, 3)).toBe(true);
        const trade = must(r0.u.world.match(must(r0.u.world.receipts.at(-1), "receipt"), "0.4", { status: "MATCHED" }), "match");
        r0.p.coordinator.onUserStreamOutput(streamTrade(r0.u, trade.venueTradeId));
        await r0.p.coordinator.settled();
        expect(await reconcileRounds(r0, 3)).toBe(true);
        const stale = await fullSnapshot(r0, trade.venueOrderId);
        r0.u.world.failTrade(trade);
        if (useReal) {
          const wire = wireOfTrade(rand, trade, ["FAILED", "FAILED", "TRADE_STATUS_FAILED", "Failed", "TRADE_STATUS_REVERTED", "MATCHED_NOT_BROADCASTED"]);
          emission = wp280Emit(wire.message, wire.options);
          valid = emission.output;
          tag = `real ${wire.tag}`;
        } else {
          // One draw in three garbles the settlement's status into readable text outside WP-280's five first (r13).
          valid = settlementOutput(trade, rand() < 1 / 3 ? pick(rand, ["Failed", "FAILED ", "BOGUS", "TRADE_STATUS_FAILED", "MATCHED_NOT_BROADCASTED"]) : "FAILED");
          tag = "synthetic";
        }
        after = () => {
          // Applied: the OMS recorded the failure (its halting alert). Otherwise the reads must never let it resume.
          applied = r0.oms.alerts().some((alert) => (alert as { kind?: string }).kind === "SETTLEMENT_FAILED");
          if (!applied) unappliedSettlements += 1;
          r0.u.world.faults = stale;
        };
      } else {
        const stale = await listSnapshot(r0);
        r0.u.world.nextTransmission = sequence(["UNKNOWN_EXISTS"]);
        attempt = await submitOne(r0.oms);
        const order = must(r0.u.world.orders.get(must(r0.u.world.receipts.at(-1), "receipt")), "venue order");
        if (useReal) {
          const status = pick(rand, [null, null, "LIVE", "BOGUS"]);
          const type = pick(rand, ["PLACEMENT", "PLACEMENT", "UPDATE", "WEIRD"]);
          emission = wp280Emit(wireOrder({ id: order.venueOrderId, assetId: order.tokenId, side: order.side, originalSize: order.original, sizeMatched: order.matched, price: order.price, status, type }));
          valid = emission.output;
          tag = `real ${String(status)}/${type}`;
        } else {
          valid = { kind: "ORDER", oms: { observation: { venueOrderId: order.venueOrderId, status: "LIVE" }, shortfalls: [] } };
          tag = "synthetic";
        }
        const byIdLags = rand() < 1 / 3;
        after = () => {
          r0.u.world.faults = byIdLags ? { ...stale, readOrder: () => ({ route: "/data/order", found: false }) } : stale;
        };
      }
      const draw = mutate ? mutated(rand, valid) : { delivered: valid, mutation: "NONE" as Mutation, second: "NONE" as Mutation };
      const expected = taken ? expectedStream(draw.delivered, MAX_STREAM_ITEMS) : null;
      const requests: unknown[] = [];
      if (emission !== null) {
        real += 1;
        for (const shortfall of emission.shortfalls) shortfallsDrawn.set(shortfall, (shortfallsDrawn.get(shortfall) ?? 0) + 1);
        if (emission.request !== null) requests.push(emission.request);
        if (!taken && emission.notDelivered !== null) {
          requests.push(emission.notDelivered);
          notDelivered += 1;
        }
      }
      const unreadable = expected?.unreadable ?? [];
      const label = `seed ${String(seed)} ${scenario} ${tag} ${taken ? "" : "NOT-TAKEN "}${draw.mutation}+${draw.second} unreadable=[${unreadable.join(",")}]`;
      // What WP-280's manager hands the listener, in its order: the output (when taken), then its requests.
      if (taken) r0.p.coordinator.onUserStreamOutput(draw.delivered);
      for (const request of requests) {
        backlog.pending.push(request as never);
        r0.p.coordinator.onUserStreamOutput(Object.freeze({ kind: "RECONCILIATION_REQUESTED", request }));
      }
      await r0.p.coordinator.settled();
      after();
      if (taken && kindText(draw.delivered)) kindTexts += 1;
      if (taken && scenario === "SETTLE" && settlementStatusText(draw.delivered)) statusTexts += 1;
      for (const entry of unreadable) shapes.set(`${scenario}:${entry}`, (shapes.get(`${scenario}:${entry}`) ?? 0) + 1);
      if (withRestart) restarts += 1;
      const r = withRestart ? await restarted(r0, backlog) : r0;
      const resumed = await anyResumed(r, 4);
      // 1. Nothing is lost while the reads lag.
      expect(oracle(r), label).toEqual([]);
      if (attempt !== null) expect(r.u.accepted.filter((answer) => answer.attemptId === attempt && answer.verdict === "ABSENT"), label).toEqual([]);
      // 2. Every unreadable entry is a journaled obligation, and the account does not resume after it.
      if (unreadable.length > 0) {
        unreadableSeeds += 1;
        expect(resumed, `${label}: resumed after an unreadable entry`).toBe(false);
        for (const entry of unreadable) expect(journaled(r, entry), `${label}: ${entry} journaled`).toBe(true);
      }
      // 3. A fill (r13: or a failed settlement) the OMS did not apply never lets the account resume on the lagging reads.
      if (!applied) {
        if (scenario === "TRADE") unappliedFills += 1;
        expect(resumed, `${label}: resumed with the ${scenario === "SETTLE" ? "settlement" : "fill"} unapplied`).toBe(false);
      }
      // 4. (r14) Every identity the delivered event and requests named is journaled.
      const named = namedIdentities(expected, requests);
      const records = r.p.journal.evidence();
      for (const tradeId of named.trades) {
        identitiesChecked += 1;
        expect(records.some((record) => record.evidenceKind === "TRADE" && record.source === "STREAM_TRADE" && record.venueTradeId === tradeId), `${label}: trade ${tradeId} journaled`).toBe(true);
      }
      for (const leg of named.legs) {
        identitiesChecked += 1;
        const [tradeId, orderId] = leg.split(" ") as [string, string];
        expect(records.some((record) => record.evidenceKind === "LEG" && record.venueTradeId === tradeId && record.venueOrderId === orderId), `${label}: own leg ${leg} journaled`).toBe(true);
      }
      for (const tradeId of named.orphans) {
        identitiesChecked += 1;
        expect(records.some((record) => record.evidenceKind === "ORPHAN_LEG" && record.venueTradeId === tradeId), `${label}: an own leg of ${tradeId} with no readable order id journaled`).toBe(true);
      }
      for (const orderId of named.orders) {
        identitiesChecked += 1;
        // A NAMED record that adds nothing the evidence held (a known order) is not journaled again: any record of it.
        expect(records.some((record) => record.venueOrderId === orderId), `${label}: order ${orderId} journaled`).toBe(true);
      }
      // 5. Then the reads are truthful: still nothing lost, and an unreadable entry still holds.
      r.u.world.faults = {};
      const caughtUp = await anyResumed(r, 3);
      expect(oracle(r), `${label} (truthful reads)`).toEqual([]);
      if (attempt !== null) expect(r.u.accepted.filter((answer) => answer.attemptId === attempt && answer.verdict === "ABSENT"), `${label} (truthful reads)`).toEqual([]);
      if (unreadable.length > 0) expect(caughtUp, `${label}: resumed after an unreadable entry (truthful reads)`).toBe(false);
      else if (caughtUp) resumedAfter += 1;
    }
    console.log(
      `STREAM-LAG-PROPERTY seeds=1..${String(SEEDS)} seed=s*104729 scenarios=${JSON.stringify(Object.fromEntries([...scenarios].sort()))} wp280Real=${String(real)} notDelivered=${String(notDelivered)} restarts=${String(restarts)} withUnreadable=${String(unreadableSeeds)} unappliedFills=${String(unappliedFills)} unappliedSettlements=${String(unappliedSettlements)} kindText=${String(kindTexts)} settlementStatusText=${String(statusTexts)} identitiesChecked=${String(identitiesChecked)} resumedOnceTruthful=${String(resumedAfter)} shortfalls=${JSON.stringify(Object.fromEntries([...shortfallsDrawn].sort()))} byUnreadableEntry=${JSON.stringify(Object.fromEntries([...shapes].sort()))}`,
    );
    // The draw reaches every missing key r12's finding named, (r13) the readable kinds and settlement statuses outside
    // their vocabularies, and (r14) WP-280's real outputs with each shortfall the finding named, an output the listener
    // did not take, and an unreadable event.
    for (const shape of ["TRADE:FILL:fills", "ORDER:ORDER:observation"]) expect(shapes.get(shape) ?? 0, shape).toBeGreaterThan(0);
    expect((shapes.get("TRADE:SETTLEMENT:settlements") ?? 0) + (shapes.get("SETTLE:SETTLEMENT:settlements") ?? 0), "a missing settlements list").toBeGreaterThan(0);
    expect(kindTexts, "(r13) a readable kind outside WP-280's activity kinds").toBeGreaterThan(0);
    expect(statusTexts, "(r13) a readable settlement status outside WP-280's five").toBeGreaterThan(0);
    for (const shortfall of ["TRADE_STATUS_UNRECOGNIZED", "TRADE_STATUS_C3", "MAKER_LEG_OWNERSHIP_UNDETERMINED", "TRADER_SIDE_UNKNOWN", "ORDER_STATUS_ABSENT", "MAKER_FEE_NOT_ON_STREAM"]) {
      expect(shortfallsDrawn.get(shortfall) ?? 0, `(r14) WP-280's ${shortfall}`).toBeGreaterThan(0);
    }
    expect(notDelivered, "(r14) an output the listener did not take").toBeGreaterThan(0);
    expect([...shapes.keys()].some((shape) => /:(event|venueOrderId|venueTradeId)$/u.test(shape)), "(r14) a required event that cannot be read").toBe(true);
    expect(identitiesChecked, "(r14) identities named and checked").toBeGreaterThan(0);
  }, 300_000);
});
