/**
 * WP-340, work-plan acceptance 1: "Mid-order crashes recover without duplicate
 * exposure" — against the mock CLOB, through the REAL WP-260 secure client.
 *
 * Each scenario places orders through WP-270's `OrderManager` over WP-260's
 * `SecureVenueClient` (the mock CLOB behind its fake-SDK seam), with WP-290's
 * `ReconciliationCoordinator` as the reconciler and WP-280's manager feeding
 * it the user channel. The first process is killed BEFORE and AFTER every
 * port call it makes, one call per run:
 *
 * - every OMS port: the reservation, the signing, the attempt's persistence,
 *   the durable SENDING mark, the transmission, the answer's persistence,
 *   cancels, consumption, release, reconciliation requests;
 * - every reconciliation port: each read, each journal append, each ledger
 *   read and booking, each halt;
 * - and the steps BENEATH WP-260's client: the signer call (MID-SIGNING),
 *   the venue's processing of a placement or cancel, entered (killed before
 *   it: the request never left, MID-TRANSMISSION) or completed (killed after
 *   it: the venue acted and the answer never came back, MID-ANSWER).
 *
 * A fresh process then restarts over what survives (the venue, the OMS
 * store, the journal's durable events, the ledger, the inventory), binds
 * (STARTUP), reconciles until it resumes, and does what a live composition
 * does after a restart (`drainAfterRestart`: the same signed order resent on
 * the restart path, a recovered SIGNED attempt sent as it is). The oracle
 * (`support/oracle.ts`) then holds: no duplicate exposure at any instant,
 * resumed only when consistent, consistent at the end, nothing lost,
 * reservations conserved, no signature in clear, the journal replays.
 *
 * PAPER only: the live-SHAPED context reaches only the fake SDK and the mock
 * venue; the tripwire refuses every network attempt in every test.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { GroupSpec, OrderManager } from "../../../packages/oms/src/index.js";
import { installNetworkTripwire, type NetworkTripwire } from "../../../packages/polymarket-secure/src/testing/index.js";
import { group, ticket } from "../../unit/oms/support/harness.js";

import {
  bootNode,
  drainAfterRestart,
  liveWorld,
  NO,
  reconcileUntilResumed,
  survive,
  YES,
  type KillPlan,
  type LiveNode,
  type LiveWorld,
} from "./support/live-node.js";
import { expectRecovered, recoveryProblems } from "./support/oracle.js";

let tripwire: NetworkTripwire;
beforeEach(() => {
  tripwire = installNetworkTripwire();
});
afterEach(() => {
  const refused = tripwire.refused();
  tripwire.uninstall();
  expect(refused).toEqual([]);
});

const G1 = group(34001, { tokenId: YES, plannedShares: "5" });
const G2 = group(34002, { tokenId: NO, plannedShares: "5" });
/** A post-only group: its order may be resent on the restart path into the post-only window (§9). */
const G_POST = group(34003, { tokenId: YES, plannedShares: "5", postOnly: true });

type Scenario = (node: LiveNode, world: LiveWorld) => Promise<void>;

function manager(node: LiveNode): OrderManager | null {
  return node.oms;
}

async function settle(world: LiveWorld, node: LiveNode): Promise<void> {
  await reconcileUntilResumed(world, node, 4);
}

async function registered(node: LiveNode, world: LiveWorld, ...groups: GroupSpec[]): Promise<OrderManager | null> {
  await settle(world, node);
  const oms = manager(node);
  if (oms === null) return null;
  for (const spec of groups) await oms.registerGroup(spec);
  return oms;
}

const SCENARIOS: Readonly<Record<string, Scenario>> = {
  "accepted, partly filled (the user channel and a reconciliation deliver it), canceled": async (node, world) => {
    const oms = await registered(node, world, G1);
    if (oms === null) return;
    const t = ticket(G1, { n: 1, shares: "1" });
    await oms.submit(t);
    const salt = world.clob.receipts.at(-1);
    if (salt !== undefined) world.clob.match(salt, "0.4");
    await world.time.advance(10);
    await settle(world, node);
    await oms.requestCancel(t.orderId);
    node.coordinator.trigger("PERIODIC_TIMER");
    await settle(world, node);
  },
  "MID-ANSWER: the venue acted and the answer was lost (the SDK's TransportError); found PRESENT by signed identity, then filled": async (node, world) => {
    const oms = await registered(node, world, G1);
    if (oms === null) return;
    world.clob.answers.push("LOST_AFTER");
    await oms.submit(ticket(G1, { n: 2, shares: "1" }));
    // A premature second order for the group while the first is unknown: the salt gate must refuse it.
    await oms.submit(ticket(G1, { n: 12, shares: "1" }));
    const salt = world.clob.receipts.at(-1);
    if (salt !== undefined) world.clob.match(salt, "1");
    await settle(world, node);
  },
  "MID-TRANSMISSION: the request never arrived; ABSENT after the quiescence horizon; then a new salt for the group": async (node, world) => {
    const oms = await registered(node, world, G1);
    if (oms === null) return;
    world.clob.answers.push("LOST_BEFORE");
    await oms.submit(ticket(G1, { n: 3, shares: "1" }));
    await settle(world, node);
    await oms.submit(ticket(G1, { n: 4, shares: "1" }));
    await settle(world, node);
  },
  "a late arrival inside the horizon: never ABSENT, found PRESENT": async (node, world) => {
    const oms = await registered(node, world, G1);
    if (oms === null) return;
    world.clob.lateMs = 3_000;
    world.clob.answers.push("LATE");
    await oms.submit(ticket(G1, { n: 5, shares: "1" }));
    await oms.submit(ticket(G1, { n: 13, shares: "1" }));
    await settle(world, node);
    await oms.submit(ticket(G1, { n: 14, shares: "1" }));
    await settle(world, node);
  },
  "a real 425 restart (WP-260 maps the pinned SDK's 425): held ABSENT, the same signed order resent into the post-only window": async (node, world) => {
    const oms = await registered(node, world, G_POST);
    if (oms === null) return;
    world.clob.restart(2_000);
    const submitted = await oms.submit(ticket(G_POST, { n: 6, shares: "1" }));
    await oms.submit(ticket(G_POST, { n: 15, shares: "1" }));
    await settle(world, node);
    if (submitted.ok) await oms.retransmitSameSignedOrder(submitted.value.submissionAttemptId);
    node.coordinator.trigger("PERIODIC_TIMER");
    await settle(world, node);
  },
  "`unmatched` (the pinned SDK turns it into an unknown): found PRESENT": async (node, world) => {
    const oms = await registered(node, world, G1);
    if (oms === null) return;
    world.clob.answers.push("UNMATCHED");
    await oms.submit(ticket(G1, { n: 7, shares: "1" }));
    await oms.submit(ticket(G1, { n: 16, shares: "1" }));
    await settle(world, node);
  },
  "a batch whose answer was lost after the venue acted: both PRESENT, one filled": async (node, world) => {
    const oms = await registered(node, world, G1, G2);
    if (oms === null) return;
    world.clob.answers.push("ACCEPT", "LOST_AFTER");
    await oms.submitBatch([ticket(G1, { n: 8, shares: "1" }), ticket(G2, { n: 9, shares: "1" })]);
    const first = world.clob.receipts.at(-2);
    if (first !== undefined) world.clob.match(first, "0.5");
    await settle(world, node);
  },
  "a documented rejection, then a new salt for the group": async (node, world) => {
    const oms = await registered(node, world, G1);
    if (oms === null) return;
    world.clob.answers.push("REJECT");
    await oms.submit(ticket(G1, { n: 10, shares: "1" }));
    await oms.submit(ticket(G1, { n: 11, shares: "1" }));
    await settle(world, node);
  },
};

interface Execution {
  readonly world: LiveWorld;
  readonly first: LiveNode;
  readonly last: LiveNode;
  readonly killed: boolean;
  readonly resumed: boolean;
}

async function execute(scenario: Scenario, plan: KillPlan | null): Promise<Execution> {
  const world = await liveWorld();
  for (const spec of [G1, G2, G_POST]) world.clob.plannedShares.set(`${spec.tokenId}|${spec.side}`, spec.plannedShares);
  const first = await bootNode(world, { plan });
  await survive(first, () => scenario(first, world));
  const killed = !first.inc.alive;
  // The first process ends here either way: a crash, or a clean stop. Only the world carries over.
  first.reap();
  const last = await bootNode(world);
  const resumed = await drainAfterRestart(world, last);
  return { world, first, last, killed, resumed };
}

describe("WP-340 acceptance 1: a crash before and after every port call, beneath WP-260's client too; restart; no duplicate exposure", () => {
  for (const [name, scenario] of Object.entries(SCENARIOS)) {
    it(name, async () => {
      const baseline = await execute(scenario, null);
      expect(baseline.killed).toBe(false);
      expectRecovered(`${name} (no crash)`, baseline.world, baseline.last, baseline.resumed);
      const calls = baseline.first.inc.calls;
      expect(calls).toBeGreaterThan(20);
      // Every SDK-level step is among the kill points.
      expect(baseline.first.inc.trace).toEqual(expect.arrayContaining(["sdk.signer.signTypedData", "venue.process.placement"]));
      let killedRuns = 0;
      let f1 = 0;
      const failures: string[] = [];
      for (let at = 1; at <= calls; at += 1) {
        for (const phase of ["before", "after"] as const) {
          const run = await execute(scenario, { at, phase });
          if (run.killed) killedRuns += 1;
          f1 += run.world.findings.length;
          const label = `killed ${phase} call ${String(at)} (${run.first.inc.trace[at - 1] ?? "?"})`;
          for (const problem of recoveryProblems(run.world, run.last, run.resumed)) failures.push(`${label}: ${problem}`);
        }
      }
      expect(failures).toEqual([]);
      expect(killedRuns).toBe(2 * calls);
      console.info(`WP-340 crash scenario: ${JSON.stringify({ name, calls, killedRuns, f1Released: f1 })}`);
    }, 600_000);
  }
});

/** The kill plan that stops the first process at the `occurrence`-th call named `name` (counted on the baseline). */
function planAt(baseline: Execution, name: string, phase: "before" | "after", occurrence = 1): KillPlan {
  let seen = 0;
  for (let index = 0; index < baseline.first.inc.trace.length; index += 1) {
    if (baseline.first.inc.trace[index] !== name) continue;
    seen += 1;
    if (seen === occurrence) return { at: index + 1, phase };
  }
  throw new Error(`no call ${name} #${String(occurrence)} in the baseline`);
}

describe("WP-340 acceptance 1, named: mid-signing, mid-transmission, mid-answer", () => {
  const scenario = SCENARIOS["accepted, partly filled (the user channel and a reconciliation deliver it), canceled"] as Scenario;

  it("MID-SIGNING: killed after the signer produced a signature the SDK never returned: no order exists anywhere, the signature is nowhere at rest, the group trades again", async () => {
    const baseline = await execute(scenario, null);
    const run = await execute(scenario, planAt(baseline, "sdk.signer.signTypedData", "after"));
    expect(run.killed).toBe(true);
    expect(run.world.clob.signatures.size, "the signature was made").toBe(1);
    expect(run.world.clob.receipts, "nothing reached the venue").toEqual([]);
    expectRecovered("mid-signing", run.world, run.last, run.resumed);
    // The group is not blocked by the half-made order: a new submission is signed and placed.
    const oms = run.last.oms as OrderManager;
    const again = await oms.submit(ticket(G1, { n: 90, shares: "1" }));
    expect(again.ok, JSON.stringify(again)).toBe(true);
    expect(run.world.clob.openOrderIds()).toHaveLength(1);
    expectRecovered("mid-signing, then a new order", run.world, run.last, await reconcileUntilResumed(run.world, run.last));
  });

  it("MID-TRANSMISSION: killed with the durable SENDING mark written and the request not yet out: the venue never sees it; ABSENT only after the horizon; no second salt while it might travel", async () => {
    const baseline = await execute(scenario, null);
    const run = await execute(scenario, planAt(baseline, "venue.process.placement", "before"));
    expect(run.killed).toBe(true);
    expect(run.world.clob.receipts).toEqual([]);
    const attempt = (run.last.oms as OrderManager).attempts()[0];
    expect(attempt?.state, "the attempt was resolved, not forgotten").not.toBe("SENDING");
    // Every ABSENT the restarted OMS accepted was quiescent (WP-270: ABSENT needs the attestation).
    expect(run.world.u.accepted.filter((answer) => answer.verdict === "ABSENT").every((answer) => answer.quiescent)).toBe(true);
    expectRecovered("mid-transmission", run.world, run.last, run.resumed);
  });

  it("MID-ANSWER: killed after the venue created the order and before its answer came back: the restarted process finds it PRESENT by signed identity; exactly one order at the venue, never resent", async () => {
    const baseline = await execute(scenario, null);
    const run = await execute(scenario, planAt(baseline, "venue.process.placement", "after"));
    expect(run.killed).toBe(true);
    const salt = run.world.clob.receipts[0] as string;
    expect(run.world.clob.receipts.filter((received) => received === salt)).toHaveLength(1);
    expect(run.world.clob.orders.size).toBe(1);
    const attempt = (run.last.oms as OrderManager).attempts().find((candidate) => candidate.salt === salt);
    expect(attempt).toMatchObject({ venueOrderId: run.world.clob.venueOrderIdOf(salt) });
    expect(run.world.u.accepted.some((answer) => answer.verdict === "PRESENT" && answer.venueOrderId === run.world.clob.venueOrderIdOf(salt))).toBe(true);
    expectRecovered("mid-answer", run.world, run.last, run.resumed);
  });

  it("MID-ANSWER of a reconciliation: killed after the coordinator's answer was persisted by the OMS and before the journal recorded it: nothing is applied twice", async () => {
    const lost = SCENARIOS["MID-ANSWER: the venue acted and the answer was lost (the SDK's TransportError); found PRESENT by signed identity, then filled"] as Scenario;
    const baseline = await execute(lost, null);
    const answerAt = baseline.first.inc.trace.findIndex((name, index) => name.startsWith("store.apply[UPDATE_ATTEMPT") && index > baseline.first.inc.trace.indexOf("read.order"));
    expect(answerAt).toBeGreaterThan(0);
    const run = await execute(lost, { at: answerAt + 1, phase: "after" });
    expect(run.killed).toBe(true);
    expect(run.world.clob.orders.size).toBe(1);
    expectRecovered("mid-answer of a reconciliation", run.world, run.last, run.resumed);
  });
});
