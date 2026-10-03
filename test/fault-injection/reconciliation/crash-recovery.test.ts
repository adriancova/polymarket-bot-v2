/**
 * WP-290 acceptance 3: STARTUP RECOVERY AFTER A MID-ORDER CRASH.
 *
 * Each scenario runs the OMS's submission protocol (§9.11 steps 1–10) with
 * the reconciliation coordinator as its reconciler. The process is killed
 * BEFORE and AFTER every port call of the first incarnation, one call per
 * run: the OMS's (reserve, sign, persist, the durable SENDING mark,
 * transmit, persist the answer, cancel, consume, release, request
 * reconciliation) and the coordinator's own (every read, every journal
 * write, every ledger read and booking, every halt). A fresh process then
 * restarts over what survives (the venue, the OMS store, the journal's
 * durable events, the ledger, the inventory), binds (STARTUP), and
 * reconciles until it resumes.
 *
 * For every crash point it asserts:
 * - LIVENESS: the restarted coordinator resumes trading in this truthful,
 *   unambiguous world;
 * - RESUME ONLY WHEN CONSISTENT (oracle R1): at every successful resume, in
 *   either incarnation, every venue order of ours is tracked exactly once,
 *   its recorded fills equal what the venue matched, nothing is in transit,
 *   no attempt awaits a read, the ledger's projected holdings equal the
 *   venue's, and every reservation is conserved;
 * - every ABSENT the OMS accepted was true when given (R2), every PRESENT
 *   named the attempt's own order (R3), and no new salt was signed while an
 *   earlier one of its slot was live or still travelling (S2);
 * - NOTHING LOST: every salt the venue received is known to the OMS, and
 *   every fill the venue matched is recorded;
 * - NOTHING DOUBLE-COUNTED: recorded fills equal the venue's matches exactly,
 *   the ledger books each fill once, and no UNATTRIBUTED correction is
 *   booked (none is owed in this world);
 * - RESERVATIONS CONSERVED: consumed + released + remaining = reserved, and
 *   the inventory's own invariants hold;
 * - the journal's durable history replays, and no break is left unresolved;
 * - no signature is ever written in clear.
 */

import { describe, expect, it } from "vitest";

import { projectLedger, projectedHoldings, ReconciliationJournal } from "../../../packages/ledger/src/index.js";
import type { OrderManager } from "../../../packages/oms/src/index.js";
import { signatureFor } from "../../unit/oms/support/fake-venue.js";
import { group, ticket } from "../../unit/oms/support/harness.js";

import {
  ACCOUNT,
  Killed,
  NO,
  YES,
  boot,
  consistencyProblems,
  reconcileUntilResumed,
  streamTrade,
  universe,
  type KillPlan,
  type Process,
  type Universe,
} from "./support/harness.js";
import type { Transmission } from "./support/world.js";

const G1 = group(7101, { tokenId: YES, plannedShares: "5" });
const G2 = group(7102, { tokenId: NO, plannedShares: "5" });

type Scenario = (p: Process, u: Universe) => Promise<void>;

function transmissions(list: readonly Transmission[], then: Transmission = "ACCEPT_LIVE"): () => Transmission {
  let index = 0;
  return () => list[index++] ?? then;
}

function manager(p: Process): OrderManager {
  if (p.oms === null) throw new Killed("no OMS");
  return p.oms;
}

/** The process may die anywhere: every step tolerates a refusal, and a kill ends the scenario. */
async function settle(p: Process, u: Universe): Promise<void> {
  await reconcileUntilResumed(p, u, 4);
}

const SCENARIOS: Readonly<Record<string, Scenario>> = {
  "accepted, partly filled (the stream delivers the fill), canceled": async (p, u) => {
    await settle(p, u);
    const oms = manager(p);
    await oms.registerGroup(G1);
    const t = ticket(G1, { n: 1, shares: "1" });
    await oms.submit(t);
    const salt = u.world.receipts.at(-1);
    const trade = salt === undefined ? undefined : u.world.match(salt, "0.4");
    if (trade !== undefined) {
      p.coordinator.onUserStreamOutput(streamTrade(u, trade.venueTradeId));
      await p.coordinator.settled();
    }
    await oms.requestCancel(t.orderId);
    p.coordinator.trigger("PERIODIC_TIMER");
    await settle(p, u);
  },
  "a lost answer the venue acted on: found PRESENT by signed identity, fully filled meanwhile": async (p, u) => {
    await settle(p, u);
    const oms = manager(p);
    await oms.registerGroup(G1);
    u.world.nextTransmission = transmissions(["UNKNOWN_EXISTS"]);
    await oms.submit(ticket(G1, { n: 2, shares: "1" }));
    const salt = u.world.receipts.at(-1);
    if (salt !== undefined) u.world.match(salt, "1");
    await settle(p, u);
  },
  "a lost answer the venue never got: ABSENT after the horizon, then a new salt for the slot": async (p, u) => {
    await settle(p, u);
    const oms = manager(p);
    await oms.registerGroup(G1);
    u.world.nextTransmission = transmissions(["UNKNOWN_ABSENT", "ACCEPT_LIVE"]);
    await oms.submit(ticket(G1, { n: 3, shares: "1" }));
    await settle(p, u);
    await oms.submit(ticket(G1, { n: 4, shares: "1" }));
    await settle(p, u);
  },
  "a transmission that arrives late (inside the horizon): never ABSENT, found PRESENT": async (p, u) => {
    await settle(p, u);
    const oms = manager(p);
    await oms.registerGroup(G1);
    u.world.lateMs = 3_000;
    u.world.nextTransmission = transmissions(["LATE_ARRIVAL"]);
    await oms.submit(ticket(G1, { n: 5, shares: "1" }));
    await settle(p, u);
  },
  "a 425 restart: absent after the horizon, held, the same signed order resent": async (p, u) => {
    await settle(p, u);
    const oms = manager(p);
    await oms.registerGroup(G1);
    u.world.nextTransmission = transmissions(["UNKNOWN_425_ABSENT", "ACCEPT_LIVE"]);
    const submitted = await oms.submit(ticket(G1, { n: 6, shares: "1" }));
    await settle(p, u);
    if (submitted.ok) await oms.retransmitSameSignedOrder(submitted.value.submissionAttemptId);
    p.coordinator.trigger("PERIODIC_TIMER");
    await settle(p, u);
  },
  "a batch: one accepted and filled, one lost and present": async (p, u) => {
    await settle(p, u);
    const oms = manager(p);
    await oms.registerGroup(G1);
    await oms.registerGroup(G2);
    u.world.nextTransmission = transmissions(["ACCEPT_LIVE", "UNKNOWN_EXISTS"]);
    await oms.submitBatch([ticket(G1, { n: 7, shares: "1" }), ticket(G2, { n: 8, shares: "1" })]);
    const first = u.world.receipts.at(-2);
    if (first !== undefined) u.world.match(first, "0.5");
    await settle(p, u);
  },
};

interface Execution {
  readonly u: Universe;
  readonly first: Process;
  readonly last: Process;
  readonly killed: boolean;
  readonly resumed: boolean;
}

async function execute(scenario: Scenario, plan: KillPlan | null): Promise<Execution> {
  const u = universe();
  const first = await boot(u, plan);
  try {
    await scenario(first, u);
  } catch (error) {
    if (!(error instanceof Killed) && first.inc.alive) throw error;
  }
  const killed = !first.inc.alive;
  // The first process ends here either way: a crash, or a clean stop. Only the universe carries over.
  first.inc.alive = false;
  const last = await boot(u, null);
  const resumed = await reconcileUntilResumed(last, u, 8);
  return { u, first, last, killed, resumed };
}

function check(label: string, run: Execution): void {
  const { u, last } = run;
  const oms = last.oms as OrderManager;
  expect(run.resumed, `${label}: the restarted coordinator resumed`).toBe(true);
  expect([...u.violations, ...u.world.violations], `${label}: oracle`).toEqual([]);
  expect(consistencyProblems(u, oms), `${label}: consistent at the end`).toEqual([]);
  expect(oms.paused, `${label}: submissions resumed`).toBe(false);
  // Nothing lost: every salt the venue received is known to the OMS.
  const known = new Set(oms.attempts().map((attempt) => attempt.salt));
  for (const salt of new Set(u.world.receipts)) expect(known.has(salt), `${label}: salt ${salt} forgotten`).toBe(true);
  // Nothing double-counted: no UNATTRIBUTED correction was owed or booked, and no market was halted.
  expect(projectedHoldings(projectLedger(u.ledger), ACCOUNT).unattributedArrivals, `${label}: unattributed bookings`).toEqual([]);
  expect(u.halts, `${label}: halts`).toEqual([]);
  // The journal: durable history replays; nothing is left unresolved.
  const replay = ReconciliationJournal.open({ accountRef: ACCOUNT, sink: { append: async () => undefined }, history: u.journalEvents });
  expect(replay.ok, `${label}: the journal history replays`).toBe(true);
  if (replay.ok) expect(replay.value.unresolvedBreaks(), `${label}: unresolved breaks`).toEqual([]);
  // Encryption at rest.
  const written = u.store.serialized();
  for (const salt of u.world.signed.keys()) expect(written.includes(signatureFor(salt)), `${label}: a signature in clear`).toBe(false);
}

describe("WP-290 acceptance 3: crash before and after every port call, restart, reconcile, resume only when consistent", () => {
  for (const [name, scenario] of Object.entries(SCENARIOS)) {
    it(name, async () => {
      const baseline = await execute(scenario, null);
      expect(baseline.killed).toBe(false);
      check(`${name} (no crash)`, baseline);
      const calls = baseline.first.inc.calls;
      expect(calls).toBeGreaterThan(20);
      let killedRuns = 0;
      for (let at = 1; at <= calls; at += 1) {
        for (const phase of ["before", "after"] as const) {
          const run = await execute(scenario, { at, phase });
          if (run.killed) killedRuns += 1;
          check(`${name}: killed ${phase} call ${String(at)} (${run.first.inc.trace[at - 1] ?? "?"})`, run);
        }
      }
      expect(killedRuns).toBe(2 * calls);
    }, 300_000);
  }
});
