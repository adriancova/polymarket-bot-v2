/**
 * WP-270 fault injection: a crash BEFORE and AFTER every port call of each
 * scenario, then a restart through the store port and a truthful drain.
 *
 * For every crash point it asserts:
 * - the independent oracle (`test/unit/oms/support/world.ts`): no new salt
 *   while an earlier attempt of the group is not authoritatively closed (S1),
 *   never two live orders for a slot (S2), never a superseded signed order
 *   resent (S3), and the same signed order resent only after an accepted,
 *   fresh ABSENT (S5);
 * - never forgotten (S4): every salt the venue received is known after the
 *   restart, and every attempt ends resolved (none SENDING,
 *   SUBMISSION_UNKNOWN or RECONCILING);
 * - reservations: exact conservation for every order (consumed + released +
 *   remaining = reserved), consumption equal to the recorded fills' debits,
 *   every closed order's remainder released, and the inventory's own
 *   invariants intact;
 * - encryption at rest: no signature ever written in clear.
 */

import { describe, expect, it } from "vitest";

import type { OrderManager } from "../../../packages/oms/src/index.js";
import { addDecimal, compareDecimal, subDecimal } from "../../../packages/decimal/src/index.js";
import { signatureFor, venueIdFor } from "../../unit/oms/support/fake-venue.js";
import { NO, YES, group, ticket } from "../../unit/oms/support/harness.js";
import type { Behavior } from "../../unit/oms/support/world.js";

import { restartAndDrain, start, universe, type Incarnation, type KillPlan, type Universe } from "./support/crash-harness.js";

const G1 = group(7001, { tokenId: YES, plannedShares: "5" });
const G2 = group(7002, { tokenId: NO, plannedShares: "5" });

interface PendingFill {
  readonly id: string;
  readonly venueOrderId: string;
  readonly shares: string;
}

interface Run {
  readonly u: Universe;
  readonly fills: PendingFill[];
}

type Scenario = (inc: Incarnation, run: Run) => Promise<void>;

function behaviors(list: readonly Behavior[], then: Behavior = "ACCEPT_LIVE"): () => Behavior {
  let index = 0;
  return () => list[index++] ?? then;
}

async function deliver(manager: OrderManager, run: Run): Promise<void> {
  for (const fill of [...run.fills]) {
    const result = await manager.recordFill({
      venueTradeId: fill.id,
      venueOrderId: fill.venueOrderId,
      shares: fill.shares,
      price: "0.5",
      liquidityRole: "MAKER",
      matchedAt: "2026-10-03T00:00:00Z",
    });
    if (result.ok) run.fills.splice(run.fills.indexOf(fill), 1);
  }
}

function venueMatch(run: Run, salt: string | undefined, centi: number): void {
  if (salt === undefined) return;
  const matched = run.u.world.match(salt, centi);
  if (matched !== undefined) run.fills.push({ id: `fill-${salt}-${String(run.fills.length)}`, venueOrderId: matched.venueOrderId, shares: matched.shares });
}

async function answerCurrent(manager: OrderManager, run: Run): Promise<void> {
  for (const attempt of manager.attempts()) {
    const request = [...run.u.requests].reverse().find((candidate) => candidate.submissionAttemptId === attempt.submissionAttemptId);
    if (request === undefined || attempt.currentRequestId !== request.requestId) continue;
    const read = run.u.world.read(request);
    const result = await manager.applyReconciliation(read.answer);
    if (result.ok) run.u.world.answerAccepted(read);
  }
}

const SCENARIOS: Readonly<Record<string, Scenario>> = {
  "accepted, partially filled, canceled, final size read": async (inc, run) => {
    const m = inc.manager as OrderManager;
    run.u.world.nextBehavior = behaviors(["ACCEPT_LIVE"]);
    await m.registerGroup(G1);
    const t = ticket(G1, { n: 1, shares: "1" });
    await m.submit(t);
    venueMatch(run, run.u.world.receipts[0], 40);
    await deliver(m, run);
    await m.requestCancel(t.orderId);
    await answerCurrent(m, run);
  },
  "425 unknown, absent, the same signed order retransmitted": async (inc, run) => {
    const m = inc.manager as OrderManager;
    run.u.world.nextBehavior = behaviors(["UNKNOWN_425", "ACCEPT_LIVE"]);
    run.u.world.existsOnUnknown = () => false;
    await m.registerGroup(G1);
    const submitted = await m.submit(ticket(G1, { n: 2, shares: "1" }));
    await answerCurrent(m, run);
    if (submitted.ok) await m.retransmitSameSignedOrder(submitted.value.submissionAttemptId);
  },
  "a refused batch, then new signed orders for both groups": async (inc, run) => {
    const m = inc.manager as OrderManager;
    run.u.world.nextBehavior = behaviors(["NOT_SENT", "ACCEPT_LIVE", "ACCEPT_LIVE"]);
    await m.registerGroup(G1);
    await m.registerGroup(G2);
    await m.submitBatch([ticket(G1, { n: 3, shares: "1" }), ticket(G2, { n: 4, shares: "1" })]);
    await m.submitBatch([ticket(G1, { n: 5, shares: "1" }), ticket(G2, { n: 6, shares: "1" })]);
  },
  "a lost response the venue did act on, found PRESENT, then fully filled": async (inc, run) => {
    const m = inc.manager as OrderManager;
    run.u.world.nextBehavior = behaviors(["UNKNOWN_SOCKET"]);
    run.u.world.existsOnUnknown = () => true;
    await m.registerGroup(G1);
    await m.submit(ticket(G1, { n: 7, shares: "1" }));
    await answerCurrent(m, run);
    venueMatch(run, run.u.world.receipts[0], 100);
    await deliver(m, run);
  },
  "`unmatched` turned UNKNOWN, found absent, then a new salt for the slot": async (inc, run) => {
    const m = inc.manager as OrderManager;
    run.u.world.nextBehavior = behaviors(["UNKNOWN_UNMATCHED", "ACCEPT_LIVE"]);
    run.u.world.existsOnUnknown = () => false;
    await m.registerGroup(G1);
    await m.submit(ticket(G1, { n: 8, shares: "1" }));
    await answerCurrent(m, run);
    await m.submit(ticket(G1, { n: 9, shares: "1" }));
  },
};

function freshRun(): Run {
  const u = universe();
  u.world.groupOfToken.set(YES, G1.executionGroupId);
  u.world.groupOfToken.set(NO, G2.executionGroupId);
  return { u, fills: [] };
}

async function execute(scenario: Scenario, plan: KillPlan | null): Promise<{ run: Run; first: Incarnation; last: Incarnation; killed: boolean }> {
  const run = freshRun();
  const first = await start(run.u, plan);
  if (first.manager !== null) await scenario(first, run);
  const killed = !first.alive;
  // The first process ends here either way (a crash, or a clean stop); only the store and the world carry over.
  first.alive = false;
  const last = await restartAndDrain(run.u, (manager) => deliver(manager, run));
  return { run, first, last, killed };
}

function check(label: string, run: Run, last: Incarnation): void {
  const { u } = run;
  const manager = last.manager as OrderManager;
  u.world.checkNeverForgotten(new Set(manager.attempts().map((attempt) => attempt.salt)));
  expect(u.world.violations, label).toEqual([]);
  const unresolved = manager.attempts().filter((attempt) => ["SENDING", "SUBMISSION_UNKNOWN", "RECONCILING"].includes(attempt.state));
  expect(unresolved, `${label}: unresolved attempts`).toEqual([]);
  // No order is left in a transient state either (a recovered cancel, an unknown placement, a half-made order).
  const transient = manager.orders().filter((order) => ["PLANNED", "SIGNED", "SENDING", "SUBMISSION_UNKNOWN", "RECONCILING", "CANCEL_PENDING"].includes(order.state));
  expect(transient.map((order) => order.state), `${label}: orders left transient`).toEqual([]);
  expect(u.inventory.book.checkInvariants(), `${label}: inventory invariants`).toEqual([]);
  for (const order of manager.orders()) {
    const reservation = u.inventory.book.reservation(order.reservation.reservationId);
    if (reservation === undefined) {
      // Never reserved: only an order closed before its reservation was made.
      expect(order.reservation.consumed, `${label}: consumption without a reservation`).toBe("0");
      continue;
    }
    expect(addDecimal(addDecimal(reservation.consumed, reservation.released), reservation.remaining), `${label}: conservation`).toBe(reservation.amount);
    expect(reservation.consumed, `${label}: consumed equals the fills' debits`).toBe(order.reservation.consumed);
    const closed = ["FILLED", "CANCELED", "REJECTED", "EXPIRED"].includes(order.state) && order.finalSize !== null && order.filledShares === order.finalSize;
    if (closed) {
      expect(reservation.status, `${label}: a closed order's remainder is released`).not.toBe("ACTIVE");
      expect(reservation.released, `${label}: only the unused part is released`).toBe(subDecimal(reservation.amount, reservation.consumed));
    }
    expect(compareDecimal(reservation.consumed, reservation.amount) <= 0).toBe(true);
  }
  const written = u.store.serialized();
  for (const salt of u.world.ledger.keys()) expect(written.includes(signatureFor(salt)), `${label}: a signature in clear`).toBe(false);
}

describe("crash before and after every port call, then restart through the store", () => {
  for (const [name, scenario] of Object.entries(SCENARIOS)) {
    it(name, async () => {
      const baseline = await execute(scenario, null);
      expect(baseline.killed).toBe(false);
      check(`${name} (no crash)`, baseline.run, baseline.last);
      const calls = baseline.first.calls;
      expect(calls).toBeGreaterThan(5);
      let killedRuns = 0;
      for (let at = 1; at <= calls; at += 1) {
        for (const phase of ["before", "after"] as const) {
          const { run, first, last, killed } = await execute(scenario, { at, phase });
          if (killed) killedRuns += 1;
          check(`${name}: killed ${phase} call ${String(at)} (${first.trace[at - 1] ?? "?"})`, run, last);
        }
      }
      expect(killedRuns).toBe(2 * calls);
    }, 120_000);
  }

  it("a kill after the venue received the order and before the response is persisted: the order is found, never resent, never forgotten", async () => {
    const baseline = await execute(SCENARIOS["accepted, partially filled, canceled, final size read"] as Scenario, null);
    const at = baseline.first.trace.indexOf("venue.post") + 1;
    expect(at).toBeGreaterThan(0);
    const { run, last } = await execute(SCENARIOS["accepted, partially filled, canceled, final size read"] as Scenario, { at, phase: "after" });
    const salt = run.u.world.receipts[0] as string;
    expect(run.u.world.receipts.filter((received) => received === salt)).toHaveLength(1);
    const attempt = (last.manager as OrderManager).attempts().find((candidate) => candidate.salt === salt);
    expect(attempt).toMatchObject({ state: "RESPONDED", responseStatus: "RECONCILED_PRESENT", venueOrderId: venueIdFor(salt) });
    expect(run.u.world.ledger.size).toBe(1);
  });
});
