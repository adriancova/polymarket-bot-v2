/**
 * r1, finding I2 (ADR-008 §8: "Kill switches outrank everything"; §14.1): a
 * kill switch OBSERVED after an order was decided and signed refuses that
 * order's transmission — through the REAL `OrderManager`'s later
 * `transmitSigned`, the path the candidate let through because its
 * submission fence asked an unscoped question that could not see a MARKET or
 * STRATEGY_INSTANCE switch. The order's market and instance travel from its
 * signing request to every transmission of it (`fenced-venue.ts`).
 *
 * The scenario: the order is signed and its attempt persisted; the venue mode
 * turns `TRADING_UNAVAILABLE` during the signing, so the OMS holds the SIGNED
 * attempt back (WP-270). The switch is then engaged AND read by the
 * composition, the mode recovers, and the OMS is asked to transmit it.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { composition, engageRow, HEALTH_MAX_AGE, ManualClock } from "../../../apps/trader/src/live-safety/fakes.test-support.js";
import type { PlacementClassifier } from "../../../apps/trader/src/live-safety/index.js";
import type { LimitOrderRequest, PlacementOutcome, SignedOrderHandle, SignOutcome } from "../../../packages/oms/src/index.js";
import { installNetworkTripwire, type NetworkTripwire } from "../../../packages/polymarket-secure/src/testing/network-tripwire.js";
import { group, INSTANCE_A, MARKET, openHarness, reopen, ticket } from "../../unit/oms/support/harness.js";

let tripwire: NetworkTripwire;
beforeEach(() => {
  tripwire = installNetworkTripwire();
});
afterEach(() => {
  const refused = tripwire.refused();
  tripwire.uninstall();
  expect(refused).toEqual([]);
});

const LONG = Object.fromEntries(Object.keys(HEALTH_MAX_AGE).map((input) => [input, 60_000])) as typeof HEALTH_MAX_AGE;

const REFUSALS = {
  signRefused: (reasons: readonly string[]): SignOutcome => ({ kind: "FAILED", error: { kind: reasons[0] ?? "GATE_REFUSED", effect: "NOT_SENT", retryAfterSeconds: null } }),
  placementRefused: (reasons: readonly string[]): PlacementOutcome => ({ kind: "NOT_SENT", error: { kind: reasons[0] ?? "GATE_REFUSED", effect: "NOT_SENT", retryAfterSeconds: null } }),
};

const OTHER_MARKET = "0190a3e0-0000-7000-8000-0000000000ff";

/**
 * Every order of this suite reduces a position, for instance A (no heartbeat is attached, which would block an
 * entry): in the harness's market, or — an order limited at 0.4 — in another market.
 */
const CLASSIFIER: PlacementClassifier<LimitOrderRequest, SignOutcome, SignedOrderHandle> = {
  request: (request) => ({ intent: "REDUCTION", marketId: request.price === "0.4" ? OTHER_MARKET : MARKET, instanceId: INSTANCE_A }),
  signedOrder: (outcome) => (outcome.kind === "SIGNED" ? outcome.order : undefined),
  order: () => null,
};

async function signedAndHeldBack(): Promise<{
  c: ReturnType<typeof composition>;
  h: Awaited<ReturnType<typeof openHarness>>;
  manager: Awaited<ReturnType<typeof reopen>>["manager"];
  attemptId: string;
}> {
  const clock = new ManualClock();
  const c = composition({ health: { maxAgeMs: LONG, eventLoop: { intervalMs: 500, maxLagMs: 250 } } }, clock);
  expect((await c.safety.acquireFence()).kind).toBe("ACQUIRED");
  c.safety.start();
  await clock.advance(500);
  c.proveComposition();
  const h = await openHarness();
  const { manager } = await reopen(h, { venue: c.safety.fenceVenue(h.venue, REFUSALS, CLASSIFIER) });
  expect((await manager.registerGroup(group(1))).ok).toBe(true);
  // The decision was permitted, and the order is signed; the venue mode turns during the signing.
  h.venue.sign = () => {
    h.mode.value = "TRADING_UNAVAILABLE";
    return undefined;
  };
  const result = await manager.submit(ticket(group(1), { n: 11 }));
  h.venue.sign = null;
  if (!result.ok) throw new Error(`submit refused: ${result.refusal.code}`);
  expect(h.venue.signed).toHaveLength(1);
  expect(h.venue.received).toEqual([]);
  const attemptId = result.value.submissionAttemptId;
  expect(manager.attempt(attemptId)?.state).toBe("SIGNED");
  h.mode.value = "NORMAL";
  return { c, h, manager, attemptId };
}

describe("r1 I2: a switch observed after the decision refuses the order's later transmission (real OMS)", () => {
  for (const [scope, scopeRef] of [
    ["MARKET", MARKET],
    ["STRATEGY_INSTANCE", INSTANCE_A],
  ] as const) {
    it(`a ${scope} FULL_HALT engaged and READ after signing: transmitSigned sends nothing, and the attempt is NOT_SENT; heartbeat input unaffected`, async () => {
      const { c, h, manager, attemptId } = await signedAndHeldBack();
      c.reader.rows = [engageRow({ id: `kill-${scope}`, scope, scopeRef, action: "FULL_HALT" })];
      expect(await c.safety.refreshKillSwitch()).toBe(true);
      const sent = await manager.transmitSigned(attemptId);
      expect(h.venue.received).toEqual([]);
      expect(sent.ok && sent.value.placement).toMatchObject({ kind: "NOT_SENT" });
      // The scoped switch never stops the heartbeat (ADR-033 D1 item 3).
      expect(c.safety.status().killSwitch).toMatchObject({ known: true, effects: { stopsHeartbeat: false } });
    });
  }

  it("the control: with no switch, the held-back attempt is transmitted", async () => {
    const { h, manager, attemptId } = await signedAndHeldBack();
    const sent = await manager.transmitSigned(attemptId);
    expect(h.venue.received).toHaveLength(1);
    expect(sent.ok && sent.value.placement?.kind).toBe("ACCEPTED");
  });

  it("a switch on ANOTHER market leaves this order's transmission alone", async () => {
    const { c, h, manager, attemptId } = await signedAndHeldBack();
    c.reader.rows = [engageRow({ id: "kill-other", scope: "MARKET", scopeRef: OTHER_MARKET, action: "FULL_HALT" })];
    expect(await c.safety.refreshKillSwitch()).toBe(true);
    await manager.transmitSigned(attemptId);
    expect(h.venue.received).toHaveLength(1);
  });

  it("a batch with ONE member in a switched market is refused whole: nothing is sent, and the OMS records every member NOT_SENT (never unknown)", async () => {
    const clock = new ManualClock();
    const c = composition({ health: { maxAgeMs: LONG, eventLoop: { intervalMs: 500, maxLagMs: 250 } } }, clock);
    expect((await c.safety.acquireFence()).kind).toBe("ACQUIRED");
    c.safety.start();
    await clock.advance(500);
    c.proveComposition();
    const h = await openHarness();
    const { manager } = await reopen(h, { venue: c.safety.fenceVenue(h.venue, REFUSALS, CLASSIFIER) });
    expect((await manager.registerGroup(group(1))).ok).toBe(true);
    expect((await manager.registerGroup(group(2))).ok).toBe(true);
    // Both members are decided and signed; while the LAST is being signed, a switch on its market is engaged and the
    // composition reads it (before the OMS reaches the batch's transmission: if it did not, the venue would receive
    // the batch and this test would fail).
    let refreshed: Promise<boolean> | null = null;
    h.venue.sign = (request) => {
      if (request.price !== "0.4") return undefined;
      c.reader.rows = [engageRow({ id: "kill-other", scope: "MARKET", scopeRef: OTHER_MARKET, action: "FULL_HALT" })];
      refreshed = c.safety.refreshKillSwitch();
      return undefined;
    };
    const result = await manager.submitBatch([ticket(group(1), { n: 21 }), ticket(group(2), { n: 22, limitPrice: "0.4" })]);
    expect(await refreshed).toBe(true);
    expect(h.venue.signed).toHaveLength(2);
    expect(h.venue.received).toEqual([]);
    expect(result.ok ? "ok" : result.refusal).toBe("ok");
    if (result.ok) expect(result.value.map((report) => report.placement?.kind)).toEqual(["NOT_SENT", "NOT_SENT"]);
  });
});
