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
  MARKET,
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

/**
 * r3 (D-A1): A FAILED SETTLEMENT'S HALT SURVIVES A CRASH. The OMS raises `SETTLEMENT_FAILED` only into its in-memory
 * alert list, once, on the transition into FAILED, and then persists the settlement; its restore replays the
 * settlement without the alert, and a repeated FAILED is idempotent. So the coordinator derives the obligation
 * from the venue's authoritative read in every run: one `SETTLEMENT_FAILED` quarantine per (trade, order).
 *
 * One order, matched once (MINED), reconciled and resumed; then the venue's trade FAILS, seen by the coordinator's
 * own probe (the venue path) or first delivered by the user stream (the stream path). The process is killed before
 * and after every port call from that moment on: both sides of the OMS's settlement write and of every journal
 * write (the break, its quarantine). After the restart, the account NEVER resumes while the trade's quarantine is
 * unreleased, its market is halted, and once an operator releases the quarantines, it resumes consistent.
 */
const G_FAIL = group(7103, { tokenId: YES, plannedShares: "5" });

interface FailedRun {
  readonly u: Universe;
  readonly first: Process;
  readonly trade: { readonly venueTradeId: string; status: string } | undefined;
  /** The first incarnation's port calls before the trade FAILED. */
  readonly before: number;
}

function failedSettlementOutput(trade: { readonly venueTradeId: string; readonly venueOrderId: string; readonly transactionHash: string }): unknown {
  return {
    kind: "TRADE",
    oms: {
      fills: [],
      settlements: [{ venueTradeId: trade.venueTradeId, venueOrderId: trade.venueOrderId, status: "FAILED", transactionHash: trade.transactionHash, observedAt: "2026-10-03T00:00:01Z" }],
      shortfalls: [],
    },
  };
}

async function failedSettlement(path: "venue" | "stream", plan: KillPlan | null): Promise<FailedRun> {
  const u = universe();
  const first = await boot(u, plan);
  let trade: ReturnType<Universe["world"]["match"]>;
  let before = -1;
  try {
    await reconcileUntilResumed(first, u, 2);
    const oms = manager(first);
    await oms.registerGroup(G_FAIL);
    await oms.submit(ticket(G_FAIL, { n: 11, shares: "1" }));
    const salt = u.world.receipts.at(-1);
    trade = salt === undefined ? undefined : u.world.match(salt, "0.4", { status: "MINED" });
    await reconcileUntilResumed(first, u, 4);
    before = first.inc.calls;
    if (trade !== undefined) trade.status = "FAILED";
    if (path === "stream" && trade !== undefined) {
      first.coordinator.onUserStreamOutput(failedSettlementOutput(trade));
      await first.coordinator.settled();
    }
    first.coordinator.trigger("PERIODIC_TIMER");
    await first.coordinator.reconcile();
  } catch (error) {
    if (!(error instanceof Killed) && first.inc.alive) throw error;
  }
  first.inc.alive = false;
  return { u, first, trade, before };
}

async function checkFailed(label: string, run: FailedRun): Promise<void> {
  const { u, trade } = run;
  expect(trade?.status, `${label}: the venue's trade FAILED`).toBe("FAILED");
  const last = await boot(u, null);
  expect(await reconcileUntilResumed(last, u, 4), `${label}: never resumed while the reversal is owed`).toBe(false);
  expect(last.oms?.paused, `${label}: paused`).toBe(true);
  const failed = last.journal.unresolvedBreaks().filter((view) => view.breakClass === "SETTLEMENT_FAILED");
  expect(failed, `${label}: one quarantine for the FAILED trade`).toHaveLength(1);
  expect(failed[0], label).toMatchObject({ status: "QUARANTINED", scope: "MARKET", marketId: MARKET, assetId: YES });
  expect(failed[0]?.subjectKey, label).toContain(trade?.venueTradeId ?? "?");
  expect(
    u.halts.some((halt) => halt.breakId === failed[0]?.breakId && halt.marketId === MARKET),
    `${label}: the market is halted`,
  ).toBe(true);
  // The operator handles the reversal and releases every quarantine: the account resumes, consistent.
  for (const view of last.journal.unresolvedBreaks()) {
    if (view.status !== "QUARANTINED") continue;
    expect((await last.coordinator.releaseQuarantine({ breakId: view.breakId, operatorRef: "operator-1", reason: "the reversal is booked" })).ok, label).toBe(true);
  }
  expect(await reconcileUntilResumed(last, u, 4), `${label}: resumes once released`).toBe(true);
  expect([...u.violations, ...u.world.violations], `${label}: oracle`).toEqual([]);
}

describe("WP-290 acceptance 3 (r3, D-A1): a FAILED settlement's halt survives a crash on either side of every write", () => {
  it("(D-A1, R3-B) a crash right after the OMS durably recorded the FAILED settlement: after the restart, quarantined and halted, never resumed", async () => {
    const r = await failedSettlement("venue", null);
    // The same history, with the process killed right after the OMS's durable APPEND_SETTLEMENT(FAILED).
    const at = r.first.inc.trace.findIndex((name, index) => index >= r.before && name.includes("APPEND_SETTLEMENT")) + 1;
    expect(at).toBeGreaterThan(r.before);
    const run = await failedSettlement("venue", { at, phase: "after" });
    expect(run.u.store.snapshotSync().settlements.map((settlement) => settlement.state)).toEqual(["MINED", "FAILED"]);
    // Nothing the coordinator journaled after the settlement write survives: the OMS's alert is gone with its process.
    expect(run.u.journalEvents.some((event) => event.kind === "BREAK_OPENED" && (event.breakClass === "OMS_HALTING_ALERT" || event.breakClass === "SETTLEMENT_FAILED"))).toBe(false);
    await checkFailed("R3-B", run);
  });

  for (const path of ["venue", "stream"] as const) {
    it(`(D-A1) the ${path} path: killed before and after every port call once the trade FAILED; restart; quarantined until released`, async () => {
      const baseline = await failedSettlement(path, null);
      await checkFailed(`${path} (no crash)`, baseline);
      const total = baseline.first.inc.calls;
      expect(total - baseline.before).toBeGreaterThan(10);
      // Both sides of the settlement write and of the break's journal writes are among the calls.
      const phase = baseline.first.inc.trace.slice(baseline.before);
      expect(phase.some((name) => name.includes("APPEND_SETTLEMENT"))).toBe(true);
      expect(phase.filter((name) => name === "journal.append").length).toBeGreaterThan(2);
      for (let at = baseline.before + 1; at <= total; at += 1) {
        for (const phaseName of ["before", "after"] as const) {
          const run = await failedSettlement(path, { at, phase: phaseName });
          expect(run.first.inc.alive).toBe(false);
          await checkFailed(`${path}: killed ${phaseName} call ${String(at)} (${baseline.first.inc.trace[at - 1] ?? "?"})`, run);
        }
      }
    }, 300_000);
  }
});
