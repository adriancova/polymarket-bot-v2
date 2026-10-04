/**
 * WP-290 r12: THE STREAM DOOR, END TO END, UNDER LAGGING READS (the class fix's requirement 3 for the user-stream door;
 * WP290-CX-R12-01). The door property (`door-property.test.ts`) judges the stream door alone; this property feeds the
 * same mutated WP-280 outputs (`support/mutate.ts`, the key deletion included) through a real coordinator, OMS, ledger
 * and journal, with the reads LAGGING behind what the stream reported (the stream ahead of every read: the shape of
 * r7's WP290-V7-STREAM-REFUSAL-DROPPED and r12's WP290-CX-R12-01), with a restart in one seed in two.
 *
 * Each seed draws one scenario:
 * - TRADE: a tracked BUY of 1 at 0.5, resumed; the venue matches 0.4; WP-280's TRADE output for that fill, mutated;
 *   the order is canceled and every read lags (no trades, no positions, the collateral as before, the order by id
 *   with nothing matched);
 * - ORDER: an UNKNOWN submission the venue took (LIVE); WP-280's ORDER output for it, mutated; the list reads replay a
 *   snapshot taken before the submission (the by-id read is truthful: it is made only for an id something named).
 *
 * It asserts, for every seed:
 * 1. NOTHING IS LOST WHILE THE READS LAG: no oracle violation (`harness.ts`: R1, resumed only when consistent; R2,
 *    ABSENT never accepted for an order the venue holds; R3), and never ABSENT for the unknown submission;
 * 2. EVERY UNREADABLE ENTRY the oracle states (`expectedStream`: a missing or garbled key, an entry that is not own
 *    data) is a journaled obligation (`STREAM_UNREADABLE` naming its field, or `STREAM_ORDER_UNKEYED`), and the
 *    account never resumes after it (it holds for good: runbook §10);
 * 3. a fill the OMS did not apply never lets the account resume on the lagging reads;
 * 4. then the reads are truthful: still no oracle violation, never ABSENT, and an unreadable entry still holds.
 *
 * The seeds and counts per shape are printed (`STREAM-LAG-PROPERTY ...`) for the handoff.
 *
 * PAPER only: every port is the in-memory simulated venue; no network, key or signer.
 */

import { describe, expect, it } from "vitest";

import type { OrderManager } from "../../../packages/oms/src/index.js";
import { MAX_STREAM_ITEMS } from "../../../packages/oms/src/reconciliation/door.js";

import { boot, streamTrade } from "./support/harness.js";
import { MUTATIONS, expectedStream, mutateAnswer, type Mutation } from "./support/mutate.js";
import { seeded } from "./support/property.js";
import { ready, reconcileRounds, sequence, submitOne, type Ready } from "./support/scenario.js";
import type { ReadFaults } from "./support/world.js";

type Row = Record<string, unknown>;
type Rand = () => number;

function pick<T>(rand: Rand, list: readonly T[]): T {
  return list[Math.floor(rand() * list.length)] as T;
}

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`no ${what}`);
  return value;
}

async function restarted(r: Ready): Promise<Ready> {
  const p = await boot(r.u);
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

const SEEDS = 160;

describe("WP-290 r12: the stream door end to end, under lagging reads (WP290-CX-R12-01's class)", () => {
  it(`${String(SEEDS)} seeds (1 to ${String(SEEDS)}): a mutated WP-280 output, the reads lagging behind it, a restart in one seed in two: nothing is lost; every unreadable entry is a journaled obligation that holds`, async () => {
    const shapes = new Map<string, number>();
    let unreadableSeeds = 0;
    let unappliedFills = 0;
    let restarts = 0;
    let resumedAfter = 0;
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const rand = seeded(seed * 104_729);
      const scenario = rand() < 0.35 ? "ORDER" : "TRADE";
      const withRestart = rand() < 0.5;
      const r0 = await ready();
      let attempt: string | null = null;
      let applied = true;
      let label: string;
      let expected: ReturnType<typeof expectedStream>;
      if (scenario === "TRADE") {
        await submitOne(r0.oms);
        expect(await reconcileRounds(r0, 3)).toBe(true);
        const collateral = r0.u.world.collateral;
        const trade = must(r0.u.world.match(must(r0.u.world.receipts.at(-1), "receipt"), "0.4"), "match");
        const draw = mutated(rand, streamTrade(r0.u, trade.venueTradeId));
        expected = expectedStream(draw.delivered, MAX_STREAM_ITEMS);
        label = `seed ${String(seed)} TRADE ${draw.mutation}+${draw.second} unreadable=[${expected.unreadable.join(",")}]`;
        r0.p.coordinator.onUserStreamOutput(draw.delivered);
        await r0.p.coordinator.settled();
        applied = r0.oms.orders()[0]?.filledShares === "0.4";
        r0.u.world.cancel(trade.venueOrderId);
        lagEveryRead(r0, collateral);
      } else {
        const stale = await listSnapshot(r0);
        r0.u.world.nextTransmission = sequence(["UNKNOWN_EXISTS"]);
        attempt = await submitOne(r0.oms);
        const order = must(r0.u.world.orders.get(must(r0.u.world.receipts.at(-1), "receipt")), "venue order");
        const draw = mutated(rand, { kind: "ORDER", oms: { observation: { venueOrderId: order.venueOrderId, status: "LIVE" }, shortfalls: [] } });
        expected = expectedStream(draw.delivered, MAX_STREAM_ITEMS);
        label = `seed ${String(seed)} ORDER ${draw.mutation}+${draw.second} unreadable=[${expected.unreadable.join(",")}]`;
        r0.p.coordinator.onUserStreamOutput(draw.delivered);
        await r0.p.coordinator.settled();
        r0.u.world.faults = stale;
      }
      for (const entry of expected.unreadable) shapes.set(`${scenario}:${entry}`, (shapes.get(`${scenario}:${entry}`) ?? 0) + 1);
      if (withRestart) restarts += 1;
      const r = withRestart ? await restarted(r0) : r0;
      const resumed = await anyResumed(r, 4);
      // 1. Nothing is lost while the reads lag.
      expect(oracle(r), label).toEqual([]);
      if (attempt !== null) expect(r.u.accepted.filter((answer) => answer.attemptId === attempt && answer.verdict === "ABSENT"), label).toEqual([]);
      // 2. Every unreadable entry is a journaled obligation, and the account does not resume after it.
      if (expected.unreadable.length > 0) {
        unreadableSeeds += 1;
        expect(resumed, `${label}: resumed after an unreadable entry`).toBe(false);
        for (const entry of expected.unreadable) expect(journaled(r, entry), `${label}: ${entry} journaled`).toBe(true);
      }
      // 3. A fill the OMS did not apply never lets the account resume on the lagging reads.
      if (!applied) {
        unappliedFills += 1;
        expect(resumed, `${label}: resumed with the fill unapplied`).toBe(false);
      }
      // 4. Then the reads are truthful: still nothing lost, and an unreadable entry still holds.
      r.u.world.faults = {};
      const caughtUp = await anyResumed(r, 3);
      expect(oracle(r), `${label} (truthful reads)`).toEqual([]);
      if (attempt !== null) expect(r.u.accepted.filter((answer) => answer.attemptId === attempt && answer.verdict === "ABSENT"), `${label} (truthful reads)`).toEqual([]);
      if (expected.unreadable.length > 0) expect(caughtUp, `${label}: resumed after an unreadable entry (truthful reads)`).toBe(false);
      else if (caughtUp) resumedAfter += 1;
    }
    console.log(
      `STREAM-LAG-PROPERTY seeds=1..${String(SEEDS)} seed=s*104729 restarts=${String(restarts)} withUnreadable=${String(unreadableSeeds)} unappliedFills=${String(unappliedFills)} resumedOnceTruthful=${String(resumedAfter)} byUnreadableEntry=${JSON.stringify(Object.fromEntries([...shapes].sort()))}`,
    );
    // The draw reaches every missing key the finding named.
    for (const shape of ["TRADE:FILL:fills", "TRADE:SETTLEMENT:settlements", "ORDER:ORDER:observation"]) expect(shapes.get(shape) ?? 0, shape).toBeGreaterThan(0);
  }, 120_000);
});
