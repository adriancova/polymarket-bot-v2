/**
 * WP-340, work-plan acceptance 2, SEEDED: random trading against the mock
 * CLOB while the user channel drops, duplicates, delays and reorders the
 * venue's frames and drops the socket, all through the REAL WP-280 manager,
 * WP-290 coordinator and WP-270 OMS.
 *
 * Per seed: a random chaos policy (each frame dropped, duplicated, delayed up
 * to 4 s, or delivered; the socket dropped after some frames), and a random
 * program (placements, venue matches, venue-side cancels the stream may
 * never report, OMS cancels, socket drops, time, the composition's periodic
 * reconciliation). Then the composition keeps reconciling.
 *
 * Held, for every seed: WP-290's R1 at EVERY resume (never resumed while
 * the OMS or the ledger differed from the venue, or anything was in
 * flight); at the end, the OMS's orders and fills and the ledger's holdings
 * equal venue truth; no duplicate exposure; nothing lost; reservations
 * conserved; no signature at rest. A stale LIVE frame that lags a terminal
 * read (WP340-F1) is released by the operator's review and counted; any
 * other halt fails the seed.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { OrderManager } from "../../../packages/oms/src/index.js";
import { installNetworkTripwire, type NetworkTripwire } from "../../../packages/polymarket-secure/src/testing/index.js";
import { group, ticket } from "../../unit/oms/support/harness.js";

import { bootNode, liveWorld, reconcileUntilResumed, reconcileUntilResumedOrReviewed, YES, type LiveNode, type LiveWorld } from "./support/live-node.js";
import { recoveryProblems } from "./support/oracle.js";
import { rng, type Rng } from "./support/seeded.js";
import type { ChannelChaos } from "./support/user-channel.js";

let tripwire: NetworkTripwire;
beforeEach(() => {
  tripwire = installNetworkTripwire();
});
afterEach(() => {
  const refused = tripwire.refused();
  tripwire.uninstall();
  expect(refused).toEqual([]);
});

const SEEDS = 300;
const STEPS = 16;
const G = group(34401, { tokenId: YES, plannedShares: "8" });

function chaosOf(random: Rng): ChannelChaos {
  const drop = random.pick([0.05, 0.15, 0.3]);
  const duplicate = random.pick([0, 0.1, 0.2]);
  const delay = random.pick([0, 0.15, 0.3]);
  const socket = random.pick([0, 0.03, 0.08]);
  return {
    policy: () => {
      const roll = random.next();
      if (roll < drop) return "DROP";
      if (roll < drop + duplicate) return "DUPLICATE";
      if (roll < drop + duplicate + delay) return { delayMs: random.int(4_000) };
      return "DELIVER";
    },
    dropAfter: () => random.chance(socket),
    dropCause: random.pick(["TRANSPORT_ERROR", "CLOSED_BY_PEER", "SERVER_ERROR"] as const),
  };
}

interface Tally {
  delivered: number;
  dropped: number;
  published: number;
  socketLosses: number;
  resumes: number;
  f1: number;
  fills: number;
  venueCancels: number;
}

async function seedRun(seed: number, tally: Tally): Promise<readonly string[]> {
  const random = rng(seed);
  const world: LiveWorld = await liveWorld();
  world.clob.plannedShares.set(`${G.tokenId}|${G.side}`, G.plannedShares);
  const node: LiveNode = await bootNode(world);
  if (!(await reconcileUntilResumed(world, node))) return ["the STARTUP run did not resume"];
  const oms = node.oms as OrderManager;
  await oms.registerGroup(G);
  if (node.channel !== null) node.channel.chaos = chaosOf(random);
  let n = 0;
  for (let step = 0; step < STEPS; step += 1) {
    const roll = random.int(100);
    if (roll < 22) {
      n += 1;
      await oms.submit(ticket(G, { n: 34_400 + n, shares: random.pick(["1", "2"]) }));
    } else if (roll < 42) {
      const live = [...world.clob.orders.values()].filter((order) => !order.foreign && order.status === "LIVE");
      const order = live[random.int(Math.max(live.length, 1))];
      if (order !== undefined && world.clob.match(order.salt, random.pick(["0.3", "0.5", "1"])) !== undefined) tally.fills += 1;
    } else if (roll < 50) {
      // A cancel the venue made on its own account (an emergency cancel, a heartbeat sweep): the stream may never say.
      const open = world.clob.openOrderIds();
      const id = open[random.int(Math.max(open.length, 1))];
      if (id !== undefined && world.clob.cancel(id).kind === "COMPLETED") tally.venueCancels += 1;
    } else if (roll < 58) {
      const open = oms.orders().filter((order) => ["LIVE", "PARTIALLY_FILLED"].includes(order.state));
      const order = open[random.int(Math.max(open.length, 1))];
      if (order !== undefined) await oms.requestCancel(order.orderId);
    } else if (roll < 63) {
      node.channel?.dropSocket(random.pick(["TRANSPORT_ERROR", "CLOSED_BY_PEER"] as const));
    } else if (roll < 80) {
      await world.time.advance(random.pick([0, 500, 2_000, 6_000]));
    } else {
      node.coordinator.trigger("PERIODIC_TIMER");
      await reconcileUntilResumed(world, node, 2);
    }
  }
  // The composition keeps going: delayed frames land, the manager reconnects, the periodic timer fires.
  let resumed = false;
  for (let round = 0; round < 4 && !resumed; round += 1) {
    await world.time.advance(5_000);
    node.coordinator.trigger("PERIODIC_TIMER");
    resumed = await reconcileUntilResumedOrReviewed(world, node);
  }
  tally.delivered += node.channel?.delivered.length ?? 0;
  tally.dropped += node.channel?.dropped.length ?? 0;
  tally.published += world.clob.frames.length;
  tally.socketLosses += node.outputs.filter((output) => output.kind === "RECONCILIATION_REQUESTED" && ["TRANSPORT_ERROR", "CLOSED_BY_PEER", "SERVER_ERROR"].includes(output.request.cause)).length;
  tally.resumes += world.u.resumes;
  tally.f1 += world.findings.length;
  return recoveryProblems(world, node, resumed);
}

describe("WP-340 acceptance 2, seeded: dropped, duplicated, delayed and reordered frames and dropped sockets reconcile", () => {
  it(`seeds 1..${String(SEEDS)}: the OMS and the ledger end at venue truth; never resumed while inconsistent`, async () => {
    const tally: Tally = { delivered: 0, dropped: 0, published: 0, socketLosses: 0, resumes: 0, f1: 0, fills: 0, venueCancels: 0 };
    const failures: string[] = [];
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      for (const problem of await seedRun(seed, tally)) failures.push(`seed ${String(seed)}: ${problem}`);
    }
    console.info(`WP-340 stream property: ${JSON.stringify(tally)}`);
    expect(failures.slice(0, 20), `${String(failures.length)} failure(s)`).toEqual([]);
    // Non-vacuous: the chaos really lost and reordered frames, sockets really dropped, and runs really resumed (each one checked by R1).
    expect(tally.dropped).toBeGreaterThan(SEEDS);
    expect(tally.socketLosses).toBeGreaterThan(SEEDS / 5);
    expect(tally.fills).toBeGreaterThan(SEEDS);
    expect(tally.venueCancels).toBeGreaterThan(SEEDS / 10);
    expect(tally.resumes).toBeGreaterThan(SEEDS * 2);
  }, 600_000);
});
