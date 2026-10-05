/**
 * r3, findings J1 and J2 (both HIGH; ADR-008 §8: "Kill switches outrank
 * everything"; §14.1; ADR-033 D1 item 3), against the REAL `OrderManager`,
 * read by the composition and placing through its fenced venue
 * (`support/placing-oms.ts`), with the order heartbeat running. A MARKET or
 * STRATEGY_INSTANCE switch never stops the account's heartbeat, so its scope's
 * cancel obligation is the only thing that removes a resting order.
 *
 * - **J1 (Opus R3-M-1 = astra CX320-R3-02).** WP-270's order view carries no
 *   strategy instance; at round 2 an instance obligation read "nothing
 *   resting" and ended after its confirming or settling pass. Both verifiers'
 *   reproduction: a placement in flight at an instance FULL_HALT answers
 *   UNKNOWN, the venue processes it after all and reconciliation shows it
 *   LIVE; over 60 s the cancel count stayed at 4, the order rested, and twelve
 *   more heartbeats were sent (the MARKET control went from 6 to 66 cancels
 *   and the order was removed). An instance order already resting whose
 *   cancels were accepted but that still rested escaped the same way.
 * - **J2 (astra CX320-R3-01).** At round 2 one cancel that never answered
 *   stopped every later cancel of its switch: one call, the order LIVE and
 *   resting, health green, twelve more heartbeats over 60 s.
 *
 * Fakes only (the heartbeat transport, WP-270's scripted venue, the cancel
 * binding): nothing reaches a network or a venue.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { engageRow } from "../../../apps/trader/src/live-safety/fakes.test-support.js";
import type { PlacementClassifier } from "../../../apps/trader/src/live-safety/index.js";
import type { LimitOrderRequest, PlacementOutcome, SignedOrderHandle, SignOutcome } from "../../../packages/oms/src/index.js";
import { installNetworkTripwire, type NetworkTripwire } from "../../../packages/polymarket-secure/src/testing/network-tripwire.js";
import { group, INSTANCE_A, ticket } from "../../unit/oms/support/harness.js";

import { SUITE_MARKET } from "./support/live-process.js";
import { cancelThroughOms, placingProcess } from "./support/placing-oms.js";

let tripwire: NetworkTripwire;
beforeEach(() => {
  tripwire = installNetworkTripwire();
});
afterEach(() => {
  const refused = tripwire.refused();
  tripwire.uninstall();
  expect(refused).toEqual([]);
});

/** Every order of this suite reduces a position in the suite's market, for instance A (the OMS harness's tickets). */
const CLASSIFIER: PlacementClassifier<LimitOrderRequest, SignOutcome, SignedOrderHandle> = {
  request: () => ({ intent: "REDUCTION", marketId: SUITE_MARKET, instanceId: INSTANCE_A }),
  signedOrder: (outcome) => (outcome.kind === "SIGNED" ? outcome.order : undefined),
  order: () => null,
};
const GROUP = group(1, { marketId: SUITE_MARKET, side: "SELL" });

describe("r3 J1: a STRATEGY_INSTANCE FULL_HALT keeps cancelling while the OMS shows an order it cannot prove is another instance's", () => {
  it("UNKNOWN, then reconciled PRESENT/LIVE (both verifiers' reproduction): the instance obligation is RETAINED and the order is cancelled through the OMS; the heartbeat runs on", async () => {
    const { live, h, manager } = await placingProcess(CLASSIFIER);
    await live.step(6_000);
    let answer: (outcome: PlacementOutcome) => void = () => undefined;
    let resting = false;
    h.venue.placement = async () =>
      new Promise<PlacementOutcome>((resolve) => {
        answer = resolve;
      });
    h.venue.cancel = (orderId) => {
      resting = false;
      return Object.freeze({ kind: "COMPLETED", canceled: [orderId], notCanceled: [] });
    };
    expect((await manager().registerGroup(GROUP)).ok).toBe(true);
    const submission = manager().submit(ticket(GROUP, { n: 99 }));
    for (let turn = 0; turn < 200 && h.venue.received.length === 0; turn += 1) await Promise.resolve();
    expect(h.venue.received).toHaveLength(1);
    let cancels = 0;
    live.cancels.cancel = async (directive) => {
      cancels += 1;
      // The composition's own record: every order of this suite is instance A's.
      return cancelThroughOms(manager(), directive, () => INSTANCE_A);
    };
    live.reader.rows = [engageRow({ id: "instance-halt", scope: "STRATEGY_INSTANCE", scopeRef: INSTANCE_A, action: "FULL_HALT" })];
    expect(await live.safety.refreshKillSwitch()).toBe(true);
    await live.step(3_000);
    // The client's answer is lost: UNKNOWN. The OMS holds it as an unknown submission.
    answer({ kind: "UNKNOWN", reason: "TRANSPORT_ERROR", error: null } as unknown as PlacementOutcome);
    const result = await submission;
    if (!result.ok) throw new Error("the submission was refused");
    expect(manager().orders().some((order) => order.state === "SUBMISSION_UNKNOWN" || order.state === "RECONCILING")).toBe(true);
    await live.step(3_000);
    const before = cancels;
    // The venue processed it after all; authoritative reconciliation shows it PRESENT and LIVE.
    resting = true;
    const attemptId = result.value.submissionAttemptId;
    const request = h.reconciler.latestFor(attemptId);
    const applied = await manager().applyReconciliation({
      requestId: request?.requestId,
      submissionAttemptId: attemptId,
      verdict: "PRESENT",
      order: { venueOrderId: "late-order", status: "LIVE", sizeMatched: "0", originalSize: "10" },
    });
    expect(applied.ok).toBe(true);
    expect(manager().orders().map((order) => order.state)).toEqual(["LIVE"]);
    const beats = live.transport.requests.length;
    await live.step(60_000);
    // On f42019a: cancels stayed at `before`, the order rested LIVE, and twelve more heartbeats were sent.
    expect(cancels).toBeGreaterThan(before);
    expect(resting).toBe(false);
    expect(manager().orders().map((order) => order.state)).toEqual(["CANCELED"]);
    expect(live.journal.of("KILL_SWITCH_CANCEL_REQUESTED").slice(-1)[0]?.pass).toBe("RETAINED");
    // Quiescent now (the OMS shows nothing resting or unknown): the obligation asks no more.
    const asked = cancels;
    await live.step(10_000);
    expect(cancels).toBe(asked);
    // An instance switch never stops the account's heartbeat (ADR-033 D1 item 3).
    expect(live.transport.requests.length - beats).toBeGreaterThan(10);
    expect(live.safety.status().health.healthy).toBe(true);
    live.safety.stop();
    live.controller.close();
  });

  it("an instance order already resting whose FIRST and CONFIRMING cancels are accepted but which still rests: the obligation is RETAINED until the OMS shows it CANCELED", async () => {
    const { live, h, manager } = await placingProcess(CLASSIFIER);
    await live.step(6_000);
    let resting = false;
    h.venue.cancel = (orderId) => {
      resting = false;
      return Object.freeze({ kind: "COMPLETED", canceled: [orderId], notCanceled: [] });
    };
    expect((await manager().registerGroup(GROUP)).ok).toBe(true);
    expect((await manager().submit(ticket(GROUP, { n: 101 }))).ok).toBe(true);
    resting = true;
    expect(manager().orders().map((order) => order.state)).toEqual(["LIVE"]);
    // The composition's port accepts the first two requests without the venue acting on them yet (queued beneath the
    // budget, say); from the third on it cancels through the OMS.
    let calls = 0;
    live.cancels.cancel = async (directive) => {
      calls += 1;
      if (calls <= 2) return true;
      return cancelThroughOms(manager(), directive, () => INSTANCE_A);
    };
    live.reader.rows = [engageRow({ id: "instance-halt", scope: "STRATEGY_INSTANCE", scopeRef: INSTANCE_A, action: "FULL_HALT" })];
    const beats = live.transport.requests.length;
    await live.step(10_000);
    // On f42019a: two calls (FIRST, CONFIRMING), then nothing while the order rested.
    expect(live.journal.of("KILL_SWITCH_CANCEL_REQUESTED").map((entry) => entry.pass)).toEqual(["FIRST", "CONFIRMING", "RETAINED"]);
    expect(calls).toBe(3);
    expect(resting).toBe(false);
    expect(manager().orders().map((order) => order.state)).toEqual(["CANCELED"]);
    expect(live.transport.requests.length - beats).toBeGreaterThan(0);
    live.safety.stop();
    live.controller.close();
  });
});

describe("r3 J2: a cancel that never answers is abandoned after its deadline and requested again", () => {
  for (const scope of ["MARKET", "STRATEGY_INSTANCE"] as const) {
    it(`${scope} FULL_HALT over a LIVE order: the first cancel never answers; the next read abandons it, pages once and requests again; the working service removes the order; the heartbeat runs on`, async () => {
      const { live, h, manager } = await placingProcess(CLASSIFIER);
      await live.step(6_000);
      let resting = false;
      h.venue.cancel = (orderId) => {
        resting = false;
        return Object.freeze({ kind: "COMPLETED", canceled: [orderId], notCanceled: [] });
      };
      expect((await manager().registerGroup(GROUP)).ok).toBe(true);
      expect((await manager().submit(ticket(GROUP, { n: 102 }))).ok).toBe(true);
      resting = true;
      expect(manager().orders().map((order) => order.state)).toEqual(["LIVE"]);
      let calls = 0;
      live.cancels.cancel = async (directive) => {
        calls += 1;
        if (calls === 1) return new Promise<never>(() => undefined);
        return cancelThroughOms(manager(), directive, () => INSTANCE_A);
      };
      live.reader.rows = [engageRow({ id: "halt", scope, scopeRef: scope === "MARKET" ? SUITE_MARKET : INSTANCE_A, action: "FULL_HALT" })];
      void live.safety.refreshKillSwitch();
      await live.step(1_000);
      const beats = live.transport.requests.length;
      await live.step(60_000);
      // On f42019a: one call, the order LIVE and resting, health green, twelve more heartbeats.
      expect(calls).toBeGreaterThan(1);
      expect(resting).toBe(false);
      expect(manager().orders().map((order) => order.state)).toEqual(["CANCELED"]);
      const outcomes = live.journal.of("KILL_SWITCH_CANCEL_REQUESTED").map((entry) => [entry.pass, entry.outcome]);
      expect(outcomes.slice(0, 2)).toEqual([
        ["FIRST", "ABANDONED"],
        ["FIRST", "ACCEPTED"],
      ]);
      expect(live.alerts.pages.filter((page) => page.page === "KILL_SWITCH_CANCEL_UNANSWERED")).toHaveLength(1);
      // A scoped switch never stops the account's heartbeat (ADR-033 D1 item 3).
      expect(live.transport.requests.length - beats).toBeGreaterThan(10);
      expect(live.safety.status().health.healthy).toBe(true);
      live.safety.stop();
      live.controller.close();
    });
  }
});
