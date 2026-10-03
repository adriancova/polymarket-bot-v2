/**
 * WP-270 r1 (OP-R1-02): a VENUE-ID CONFLICT is sticky and durable
 * (`order-manager.ts`, "VENUE-ID CONFLICTS"). When a placement answer (in time
 * or late) or an authoritative read names, for one signed order, a venue order
 * id other than the one the OMS tracks for it, or one another order holds, the
 * OMS cannot rule out a venue order it does not track. So:
 * - the conflict is recorded in the order's event log and survives a restart,
 *   which raises its market-halt alert again;
 * - no read of the tracked id, no cancel and no abandonment clears it;
 * - while it is open, the group's salt gate stays closed (no new salt) and
 *   the order's reservation stays held;
 * - a late answer that does not resolve the attempt still supersedes the read
 *   that was outstanding when the port settled.
 *
 * r2 (OP-R2-01): while one is open, the signed order is never retransmitted
 * (§9.11 step 9): a quiescent ABSENT abandons a conflicted 425 attempt rather
 * than holding it, and `retransmitSameSignedOrder` refuses.
 */

import { describe, expect, it } from "vitest";

import { type PlacementOutcome } from "../../../packages/oms/src/index.js";

import { accepted, venueError, venueIdFor } from "./support/fake-venue.js";
import { flush, group, openHarness, reopen, ticket, type Harness } from "./support/harness.js";

const UNKNOWN_TIMEOUT: PlacementOutcome = { kind: "UNKNOWN", reason: "ERROR", error: venueError("TIMEOUT", "UNKNOWN") };
const UNKNOWN_425: PlacementOutcome = { kind: "UNKNOWN", reason: "ERROR", error: venueError("ENGINE_RESTARTING", "UNKNOWN", 1) };

/** A placement whose answer is held back: the watchdog declares it lost; returns the attempt and the late answer's trigger. */
async function lostInFlight(h: Harness, n: number): Promise<{ attemptId: string; orderId: string; answer: (outcome: PlacementOutcome) => Promise<void> }> {
  let resolve: (outcome: PlacementOutcome) => void = () => undefined;
  h.venue.placement = () => new Promise<PlacementOutcome>((r) => (resolve = r));
  const g = group(n);
  await h.manager.registerGroup(g);
  const t = ticket(g, { n });
  const received = h.venue.received.length;
  const pending = h.manager.submit(t);
  for (let i = 0; i < 50 && h.venue.received.length === received; i += 1) await Promise.resolve();
  const attemptId = h.manager.order(t.orderId)?.submissionAttemptId as string;
  const lost = await h.manager.declareTransmissionLost(attemptId);
  expect(lost.ok && lost.value.state).toBe("RECONCILING");
  return {
    attemptId,
    orderId: t.orderId,
    answer: async (outcome) => {
      resolve(outcome);
      await pending;
      await flush();
    },
  };
}

function conflictEvents(h: Harness, orderId: string): unknown[] {
  return h.store
    .snapshotSync()
    .events.filter((event) => event.orderId === orderId && event.payload !== null && "conflictingVenueOrderId" in event.payload)
    .map((event) => event.payload?.["conflictingVenueOrderId"]);
}

function haltAlertsFor(h: Harness, orderId: string): number {
  return h.manager.alerts().filter((alert) => alert.kind === "EVIDENCE_CONFLICT" && alert.haltMarket && alert.orderId === orderId).length;
}

describe("a late acceptance that contradicts the venue order id already known (probe P-B)", () => {
  async function setup(n: number): Promise<{ h: Harness; attemptId: string; orderId: string; groupId: string }> {
    const h = await openHarness();
    const { attemptId, orderId, answer } = await lostInFlight(h, n);
    // While the transmission is still in flight, an authoritative read finds the order as venue-A.
    const request = h.reconciler.latestFor(attemptId);
    const present = await h.manager.applyReconciliation({
      requestId: request?.requestId,
      submissionAttemptId: attemptId,
      verdict: "PRESENT",
      order: { venueOrderId: "venue-A", status: "LIVE", sizeMatched: "0", originalSize: "10" },
    });
    expect(present.ok).toBe(true);
    // Then the transmission answers late: accepted as venue-B.
    await answer(accepted("venue-B"));
    expect(h.manager.order(orderId)).toMatchObject({ state: "LIVE", venueOrderId: "venue-A", conflict: true, venueIdConflict: true });
    expect(haltAlertsFor(h, orderId)).toBe(1);
    expect(conflictEvents(h, orderId)).toEqual(["venue-B"]);
    return { h, attemptId, orderId, groupId: group(n).executionGroupId };
  }

  it("survives a restart: the conflict is folded back from the event log and its halt alert is raised again", async () => {
    const { h, orderId } = await setup(1);
    const r = await reopen(h);
    expect(r.manager.order(orderId)).toMatchObject({ state: "LIVE", conflict: true, venueIdConflict: true });
    expect(haltAlertsFor(r, orderId)).toBe(1);
  });

  it("is not cleared by a cancel of venue-A and a final read of venue-A: the gate stays closed, no new salt is signed, the reservation stays held, also after a restart", async () => {
    const { h, attemptId, orderId, groupId } = await setup(2);
    const canceled = await h.manager.requestCancel(orderId);
    expect(canceled.ok && canceled.value.state).toBe("CANCELED");
    expect(h.venue.cancels).toEqual(["venue-A"]);
    const read = h.reconciler.latestFor(attemptId);
    expect(read?.purpose).toBe("FINAL_SIZE");
    const final = await h.manager.applyReconciliation({
      requestId: read?.requestId,
      submissionAttemptId: attemptId,
      verdict: "PRESENT",
      order: { venueOrderId: "venue-A", status: "CANCELED", sizeMatched: "0", originalSize: "10" },
    });
    expect(final.ok).toBe(true);
    expect(h.manager.order(orderId)).toMatchObject({ state: "CANCELED", finalSize: "0", conflict: true, venueIdConflict: true });
    expect(h.manager.saltGate(groupId)).toEqual({ open: false, blockers: [{ id: attemptId, reason: "EVIDENCE_CONFLICT" }], remaining: "10" });
    expect(h.manager.order(orderId)?.reservation.released).toBe(false);
    h.venue.placement = (handle) => accepted(venueIdFor(handle.identity.salt));
    const second = await h.manager.submit(ticket(group(2), { n: 902 }));
    expect(!second.ok && second.refusal.code).toBe("OMS_SALT_GATE_CLOSED");
    expect(h.venue.signed).toHaveLength(1);
    const r = await reopen(h);
    expect(r.manager.saltGate(groupId)?.blockers).toEqual([{ id: attemptId, reason: "EVIDENCE_CONFLICT" }]);
    expect(r.manager.order(orderId)?.reservation.released).toBe(false);
    r.manager.resume();
    const third = await r.manager.submit(ticket(group(2), { n: 903 }));
    expect(!third.ok && third.refusal.code).toBe("OMS_SALT_GATE_CLOSED");
    expect(h.venue.signed).toHaveLength(1);
  });
});

describe("a late acceptance naming a venue order id another order holds (probe P-V14)", () => {
  it("supersedes the read outstanding when the port settled; after a quiescent ABSENT the ABANDONED attempt still blocks its group, across a restart", async () => {
    const h = await openHarness();
    const gx = group(10);
    await h.manager.registerGroup(gx);
    const x = await h.manager.submit(ticket(gx, { n: 10 }));
    expect(x.ok && x.value.orderState).toBe("LIVE");
    const heldId = venueIdFor(h.venue.signed[0] as string);
    const { attemptId, orderId, answer } = await lostInFlight(h, 11);
    const before = h.reconciler.latestFor(attemptId);
    await answer(accepted(heldId));
    expect(h.manager.order(orderId)).toMatchObject({ venueOrderId: null, conflict: true, venueIdConflict: true });
    expect(conflictEvents(h, orderId)).toEqual([heldId]);
    // The read requested before the port settled is superseded; a fresh one is requested.
    const stale = await h.manager.applyReconciliation({ requestId: before?.requestId, submissionAttemptId: attemptId, verdict: "ABSENT", transmissionQuiescent: true });
    expect(!stale.ok && stale.refusal.code).toBe("OMS_RECONCILIATION_SUPERSEDED");
    const fresh = h.reconciler.latestFor(attemptId);
    expect(fresh?.requestId).not.toBe(before?.requestId);
    const absent = await h.manager.applyReconciliation({ requestId: fresh?.requestId, submissionAttemptId: attemptId, verdict: "ABSENT", transmissionQuiescent: true });
    expect(absent.ok && absent.value.state).toBe("ABANDONED");
    const groupId = group(11).executionGroupId;
    expect(h.manager.saltGate(groupId)).toEqual({ open: false, blockers: [{ id: attemptId, reason: "EVIDENCE_CONFLICT" }], remaining: "10" });
    const again = await h.manager.submit(ticket(group(11), { n: 911 }));
    expect(!again.ok && again.refusal.code).toBe("OMS_SALT_GATE_CLOSED");
    const r = await reopen(h);
    expect(r.manager.saltGate(groupId)?.blockers).toEqual([{ id: attemptId, reason: "EVIDENCE_CONFLICT" }]);
    expect(haltAlertsFor(r, orderId)).toBe(1);
    expect(h.venue.signed).toHaveLength(2);
  });
});

describe("the other places a venue order id can conflict are sticky too", () => {
  it("an in-time acceptance naming a venue order id another order holds: unknown, reconciled, and still blocking after a quiescent ABSENT", async () => {
    const h = await openHarness();
    const gx = group(20);
    await h.manager.registerGroup(gx);
    await h.manager.submit(ticket(gx, { n: 20 }));
    const heldId = venueIdFor(h.venue.signed[0] as string);
    h.venue.placement = () => accepted(heldId);
    const gy = group(21);
    await h.manager.registerGroup(gy);
    const y = await h.manager.submit(ticket(gy, { n: 21 }));
    expect(y.ok && y.value).toMatchObject({ orderState: "RECONCILING", attemptState: "RECONCILING" });
    if (!y.ok) return;
    expect(h.manager.order(y.value.orderId)).toMatchObject({ venueIdConflict: true });
    const request = h.reconciler.latestFor(y.value.submissionAttemptId);
    const absent = await h.manager.applyReconciliation({ requestId: request?.requestId, submissionAttemptId: y.value.submissionAttemptId, verdict: "ABSENT", transmissionQuiescent: true });
    expect(absent.ok && absent.value.state).toBe("ABANDONED");
    expect(h.manager.saltGate(gy.executionGroupId)?.blockers).toEqual([{ id: y.value.submissionAttemptId, reason: "EVIDENCE_CONFLICT" }]);
    const r = await reopen(h);
    expect(r.manager.saltGate(gy.executionGroupId)?.open).toBe(false);
  });

  it("a PRESENT answer naming another order's venue id is refused AND recorded: a later ABSENT abandons the attempt, but the group stays blocked", async () => {
    const h = await openHarness();
    const gx = group(30);
    await h.manager.registerGroup(gx);
    await h.manager.submit(ticket(gx, { n: 30 }));
    const heldId = venueIdFor(h.venue.signed[0] as string);
    h.venue.placement = () => UNKNOWN_TIMEOUT;
    const gy = group(31);
    await h.manager.registerGroup(gy);
    const y = await h.manager.submit(ticket(gy, { n: 31 }));
    if (!y.ok) throw new Error("submit failed");
    const attemptId = y.value.submissionAttemptId;
    const request = h.reconciler.latestFor(attemptId);
    const taken = await h.manager.applyReconciliation({
      requestId: request?.requestId,
      submissionAttemptId: attemptId,
      verdict: "PRESENT",
      order: { venueOrderId: heldId, status: "LIVE", sizeMatched: "0", originalSize: "10" },
    });
    expect(!taken.ok && taken.refusal.code).toBe("OMS_EVIDENCE_CONFLICT");
    expect(conflictEvents(h, y.value.orderId)).toEqual([heldId]);
    const absent = await h.manager.applyReconciliation({ requestId: request?.requestId, submissionAttemptId: attemptId, verdict: "ABSENT", transmissionQuiescent: true });
    expect(absent.ok && absent.value.state).toBe("ABANDONED");
    expect(h.manager.saltGate(gy.executionGroupId)?.open).toBe(false);
    expect((await reopen(h)).manager.saltGate(gy.executionGroupId)?.open).toBe(false);
  });

  it("a PRESENT answer naming a different venue id for an identified order is refused AND recorded: a later consistent final read does not clear it", async () => {
    const h = await openHarness();
    const g = group(40);
    await h.manager.registerGroup(g);
    const t = ticket(g, { n: 40 });
    const placed = await h.manager.submit(t);
    if (!placed.ok) throw new Error("submit failed");
    const attemptId = placed.value.submissionAttemptId;
    const venueOrderId = venueIdFor(h.venue.signed[0] as string);
    await h.manager.requestCancel(t.orderId);
    const read = h.reconciler.latestFor(attemptId);
    const other = await h.manager.applyReconciliation({
      requestId: read?.requestId,
      submissionAttemptId: attemptId,
      verdict: "PRESENT",
      order: { venueOrderId: "venue-other", status: "CANCELED", sizeMatched: "0", originalSize: "10" },
    });
    expect(!other.ok && other.refusal.code).toBe("OMS_EVIDENCE_CONFLICT");
    const consistent = await h.manager.applyReconciliation({
      requestId: read?.requestId,
      submissionAttemptId: attemptId,
      verdict: "PRESENT",
      order: { venueOrderId, status: "CANCELED", sizeMatched: "0", originalSize: "10" },
    });
    expect(consistent.ok).toBe(true);
    expect(h.manager.order(t.orderId)).toMatchObject({ state: "CANCELED", finalSize: "0", venueIdConflict: true });
    expect(h.manager.saltGate(g.executionGroupId)?.blockers).toEqual([{ id: attemptId, reason: "EVIDENCE_CONFLICT" }]);
  });
});

describe("an open venue-id conflict forbids the step-9 retransmission (r2, OP-R2-01; probe N1)", () => {
  for (const restart of [false, true]) {
    it(`a 425 attempt whose read named another order's venue id: a quiescent ABSENT abandons it (never held), and the same signed order is never resent${restart ? " (a restart between the PRESENT and the ABSENT)" : ""}`, async () => {
      const h = await openHarness();
      const gx = group(restart ? 51 : 50);
      await h.manager.registerGroup(gx);
      await h.manager.submit(ticket(gx, { n: restart ? 51 : 50 }));
      const heldId = venueIdFor(h.venue.signed[0] as string);
      h.venue.placement = () => UNKNOWN_425;
      const gy = group(restart ? 53 : 52);
      await h.manager.registerGroup(gy);
      const y = await h.manager.submit(ticket(gy, { n: restart ? 53 : 52 }));
      if (!y.ok) throw new Error("submit failed");
      const attemptId = y.value.submissionAttemptId;
      expect(h.manager.attempt(attemptId)).toMatchObject({ state: "RECONCILING", errorCode: "ENGINE_RESTARTING" });
      const request = h.reconciler.latestFor(attemptId);
      const taken = await h.manager.applyReconciliation({
        requestId: request?.requestId,
        submissionAttemptId: attemptId,
        verdict: "PRESENT",
        order: { venueOrderId: heldId, status: "LIVE", sizeMatched: "0", originalSize: "10" },
      });
      expect(!taken.ok && taken.refusal.code).toBe("OMS_EVIDENCE_CONFLICT");
      expect(h.manager.order(y.value.orderId)).toMatchObject({ venueIdConflict: true });
      let m: Harness = h;
      if (restart) {
        m = await reopen(h);
        expect(m.manager.order(y.value.orderId)).toMatchObject({ venueIdConflict: true });
      }
      const read = m.reconciler.latestFor(attemptId);
      const absent = await m.manager.applyReconciliation({ requestId: read?.requestId, submissionAttemptId: attemptId, verdict: "ABSENT", transmissionQuiescent: true });
      // Never held for the retransmission decision: abandoned at once, the conflict kept.
      expect(absent.ok && absent.value).toMatchObject({ state: "ABANDONED", absentConfirmed: false });
      expect(m.manager.resume().ok).toBe(true);
      m.venue.placement = (handle) => accepted(venueIdFor(handle.identity.salt));
      const resent = await m.manager.retransmitSameSignedOrder(attemptId);
      expect(!resent.ok && resent.refusal.code).toBe("OMS_RETRANSMIT_NOT_SUPPORTED");
      // The venue received salt 1002 exactly once; nothing was re-signed.
      expect(m.venue.received).toEqual(["1001", "1002"]);
      expect(m.venue.signed).toEqual(["1001", "1002"]);
      expect(m.manager.order(y.value.orderId)).toMatchObject({ state: "REJECTED", venueIdConflict: true, conflict: true });
      expect(m.manager.order(y.value.orderId)?.reservation.released).toBe(false);
      expect(m.manager.saltGate(gy.executionGroupId)?.blockers).toEqual([{ id: attemptId, reason: "EVIDENCE_CONFLICT" }]);
      const again = await m.manager.submit(ticket(gy, { n: restart ? 953 : 952 }));
      expect(!again.ok && again.refusal.code).toBe("OMS_SALT_GATE_CLOSED");
      expect(m.venue.signed).toHaveLength(2);
    });
  }
});
