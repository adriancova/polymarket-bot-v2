/**
 * WP-340, work-plan acceptance 1, SEEDED: random trading programs against the
 * mock CLOB, each killed at random port calls (the SDK-level steps beneath
 * WP-260's client included), restarted, reconciled and drained, and held to
 * the same oracle as the named cases (`support/oracle.ts`): no duplicate
 * exposure at any instant, resumed only when consistent, consistent at the
 * end, nothing lost, reservations conserved, no signature in clear.
 *
 * A program mixes single and batch placements under every placement answer
 * the mock models (accepted, the answer lost after or before the venue
 * acted, a late arrival, `unmatched`, a documented rejection), venue matches,
 * cancels, engine restarts (a real 425, then the post-only window), dropped
 * user-channel sockets, time and reconciliation. Group B is post-only, so its
 * orders may be resent on the restart path into the post-only window.
 *
 * Seeds 1..SEEDS, each with a no-crash baseline and KILLS random kill
 * points. A failure lists the seed, the kill plan and the oracle's problems.
 * The recovery driver releases only quarantines bound to WP340-F1
 * (`classifyQuarantine`); any halt it refuses fails the run, and the total
 * of its releases is pinned exactly.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { GroupSpec } from "../../../packages/oms/src/index.js";
import { installNetworkTripwire, type NetworkTripwire } from "../../../packages/polymarket-secure/src/testing/index.js";
import { group, ticket } from "../../unit/oms/support/harness.js";

import type { PlacementAnswer } from "./support/mock-clob.js";
import { bootNode, drainAfterRestart, liveWorld, NO, reconcileUntilResumed, survive, YES, type KillPlan, type LiveNode, type LiveWorld } from "./support/live-node.js";
import { F1_RELEASES } from "./support/expected-releases.js";
import { recoveryProblems } from "./support/oracle.js";
import { rng, type Rng } from "./support/seeded.js";

let tripwire: NetworkTripwire;
beforeEach(() => {
  tripwire = installNetworkTripwire();
});
afterEach(() => {
  const refused = tripwire.refused();
  tripwire.uninstall();
  expect(refused).toEqual([]);
});

const SEEDS = 200;
const KILLS = 4;
const STEPS = 9;
/** WP340-F1 releases over all 1,000 runs, exact (J1, J3: WP-340 r1; `support/expected-releases.ts`). */
const EXPECTED_F1_RELEASES = F1_RELEASES.crashProperty;

const GROUPS: readonly GroupSpec[] = [group(34101, { tokenId: YES, plannedShares: "5" }), group(34102, { tokenId: NO, plannedShares: "5", postOnly: true })];
const ANSWERS: readonly PlacementAnswer[] = ["ACCEPT", "ACCEPT", "ACCEPT", "LOST_AFTER", "LOST_BEFORE", "LATE", "UNMATCHED", "REJECT"];

type Step =
  | { readonly kind: "SUBMIT"; readonly group: number; readonly answer: PlacementAnswer; readonly shares: string }
  | { readonly kind: "BATCH"; readonly answers: readonly [PlacementAnswer, PlacementAnswer] }
  | { readonly kind: "MATCH"; readonly pick: number; readonly shares: string }
  | { readonly kind: "CANCEL"; readonly pick: number }
  | { readonly kind: "ADVANCE"; readonly ms: number }
  | { readonly kind: "RECONCILE" }
  | { readonly kind: "ENGINE_RESTART"; readonly ms: number }
  | { readonly kind: "DROP_SOCKET" }
  | { readonly kind: "RESEND" };

function program(random: Rng): readonly Step[] {
  const steps: Step[] = [{ kind: "RECONCILE" }];
  for (let index = 0; index < STEPS; index += 1) {
    const roll = random.int(100);
    if (roll < 30) steps.push({ kind: "SUBMIT", group: random.int(2), answer: random.pick(ANSWERS), shares: random.pick(["1", "2"]) });
    else if (roll < 38) steps.push({ kind: "BATCH", answers: [random.pick(ANSWERS), random.pick(ANSWERS)] });
    else if (roll < 52) steps.push({ kind: "MATCH", pick: random.int(8), shares: random.pick(["0.3", "0.5", "1"]) });
    else if (roll < 60) steps.push({ kind: "CANCEL", pick: random.int(8) });
    else if (roll < 72) steps.push({ kind: "ADVANCE", ms: random.pick([0, 1_000, 3_000, 6_000]) });
    else if (roll < 86) steps.push({ kind: "RECONCILE" });
    else if (roll < 90) steps.push({ kind: "ENGINE_RESTART", ms: random.pick([500, 2_000]) });
    else if (roll < 95) steps.push({ kind: "DROP_SOCKET" });
    else steps.push({ kind: "RESEND" });
  }
  steps.push({ kind: "RECONCILE" });
  return steps;
}

async function run(steps: readonly Step[], node: LiveNode, world: LiveWorld): Promise<void> {
  const oms = node.oms;
  if (oms === null) return;
  let n = 0;
  const next = (): number => (n += 1);
  for (const spec of GROUPS) await oms.registerGroup(spec);
  for (const step of steps) {
    switch (step.kind) {
      case "SUBMIT": {
        world.clob.answers.push(step.answer);
        const spec = GROUPS[step.group] as GroupSpec;
        await oms.submit(ticket(spec, { n: 34_100 + next(), shares: step.shares }));
        // An answer the venue never consumed (the OMS refused before sending) must not leak into the next placement.
        world.clob.answers.length = 0;
        break;
      }
      case "BATCH":
        world.clob.answers.push(...step.answers);
        await oms.submitBatch(GROUPS.map((spec) => ticket(spec, { n: 34_100 + next(), shares: "1" })));
        world.clob.answers.length = 0;
        break;
      case "MATCH": {
        const live = [...world.clob.orders.values()].filter((order) => !order.foreign && order.status === "LIVE");
        const order = live[step.pick % Math.max(live.length, 1)];
        if (order !== undefined) world.clob.match(order.salt, step.shares);
        break;
      }
      case "CANCEL": {
        const open = oms.orders().filter((order) => ["LIVE", "PARTIALLY_FILLED", "ACKNOWLEDGED"].includes(order.state));
        const order = open[step.pick % Math.max(open.length, 1)];
        if (order !== undefined) await oms.requestCancel(order.orderId);
        break;
      }
      case "ADVANCE":
        await world.time.advance(step.ms);
        break;
      case "RECONCILE":
        node.coordinator.trigger("PERIODIC_TIMER");
        await reconcileUntilResumed(world, node, 3);
        break;
      case "ENGINE_RESTART":
        world.clob.restart(step.ms);
        break;
      case "DROP_SOCKET":
        node.channel?.dropSocket("TRANSPORT_ERROR");
        break;
      case "RESEND":
        for (const attempt of oms.attempts()) if (attempt.absentConfirmed && !attempt.inFlight) await oms.retransmitSameSignedOrder(attempt.submissionAttemptId);
        break;
    }
  }
}

async function execute(
  steps: readonly Step[],
  plan: KillPlan | null,
): Promise<{ readonly problems: readonly string[]; readonly calls: number; readonly killed: boolean; readonly trace: readonly string[]; readonly placed: number; readonly f1: number }> {
  const world = await liveWorld();
  for (const spec of GROUPS) world.clob.plannedShares.set(`${spec.tokenId}|${spec.side}`, spec.plannedShares);
  const first = await bootNode(world, { plan });
  await survive(first, () => run(steps, first, world));
  const killed = !first.inc.alive;
  first.reap();
  // The engine comes back before the restarted process looks (a restart window cannot outlast the recovery).
  if (world.clob.mode() === "RESTARTING") await world.time.advance(3_000);
  const last = await bootNode(world);
  const resumed = await drainAfterRestart(world, last, 4);
  const refusals = world.refusedReleases.map((entry) => `the driver refused a halt: ${entry.reason}`);
  return { problems: [...recoveryProblems(world, last, resumed), ...refusals], calls: first.inc.calls, killed, trace: first.inc.trace, placed: world.clob.receipts.length, f1: world.findings.length };
}

describe("WP-340 acceptance 1, seeded: random programs, random kill points, restart, no duplicate exposure", () => {
  it(`seeds 1..${String(SEEDS)}: a baseline and ${String(KILLS)} kills each`, async () => {
    const failures: string[] = [];
    let runs = 0;
    let killedRuns = 0;
    let placements = 0;
    let f1 = 0;
    const killedAt = new Map<string, number>();
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const random = rng(seed);
      const steps = program(random);
      const baseline = await execute(steps, null);
      runs += 1;
      placements += baseline.placed;
      f1 += baseline.f1;
      for (const problem of baseline.problems) failures.push(`seed ${String(seed)} (no crash): ${problem}`);
      for (let kill = 0; kill < KILLS; kill += 1) {
        const plan: KillPlan = { at: 1 + random.int(baseline.calls), phase: random.chance(0.5) ? "before" : "after" };
        const result = await execute(steps, plan);
        runs += 1;
        f1 += result.f1;
        if (result.killed) {
          killedRuns += 1;
          const name = baseline.trace[plan.at - 1] ?? "?";
          const family = name.startsWith("store.apply") ? "store.apply" : name;
          killedAt.set(family, (killedAt.get(family) ?? 0) + 1);
        }
        for (const problem of result.problems) failures.push(`seed ${String(seed)} killed ${plan.phase} call ${String(plan.at)} (${baseline.trace[plan.at - 1] ?? "?"}): ${problem}`);
      }
    }
    console.info(`WP-340 crash property: ${JSON.stringify({ seeds: SEEDS, runs, killedRuns, placements, f1Released: f1, killedAt: Object.fromEntries([...killedAt].sort()) })}`);
    expect(failures.slice(0, 20), `${String(failures.length)} failure(s)`).toEqual([]);
    expect(runs).toBe(SEEDS * (1 + KILLS));
    expect(f1, "WP340-F1 releases (J1, J3)").toBe(EXPECTED_F1_RELEASES);
    // Non-vacuous: the programs placed orders, and the kills landed on the SDK-level steps and on every port family.
    expect(placements).toBeGreaterThan(SEEDS);
    expect(killedRuns).toBeGreaterThan(SEEDS * KILLS * 0.95);
    for (const family of ["sdk.signer.signTypedData", "venue.process.placement", "venue.post", "venue.sign", "store.apply", "journal.append", "read.openOrders", "reconciler.request", "inventory.reserve"]) {
      expect(killedAt.get(family) ?? 0, `kills at ${family}`).toBeGreaterThan(0);
    }
  }, 600_000);
});
