/**
 * WP-270 r3 (WP270-R3-01): UNATTRIBUTED EVIDENCE (`order-manager.ts` header).
 *
 * No venue fact orders the user stream against the placement response, so a
 * fill or an observation for our own order can arrive while its placement is
 * still in flight (the taker path races naturally), or while a lost response
 * is reconciled: before the OMS knows the order's venue id. On 65f185f such
 * evidence was refused as an unknown venue order and dropped, with an alert
 * naming no venue id, and nothing asked for a read once the placement answer
 * revealed that very id (probes E1 and E3 of the r3 reconciliation).
 *
 * Here: the evidence is retained while an unresolved attempt could own it,
 * applied through the ordinary paths when a placement answer or an
 * authoritative read adopts its venue id, and the order (if still open) gets a
 * fresh authoritative read, durably. Evidence no attempt turns out to own is
 * released with a market-halt alert naming its venue order id. Every held-POST
 * case is pinned, including a restart while the placement is still in flight.
 */

import { describe, expect, it } from "vitest";

import { MAX_RETAINED_EVIDENCE, type PlacementOutcome, type SignedOrderHandle } from "../../../packages/oms/src/index.js";

import { accepted, venueIdFor } from "./support/fake-venue.js";
import { ACCOUNT, PUSD, group, openHarness, reopen, ticket, type Harness } from "./support/harness.js";

const UNKNOWN_TIMEOUT: PlacementOutcome = { kind: "UNKNOWN", reason: "ERROR", error: { kind: "TIMEOUT", effect: "UNKNOWN", retryAfterSeconds: null } };
const UNKNOWN_425: PlacementOutcome = { kind: "UNKNOWN", reason: "ERROR", error: { kind: "ENGINE_RESTARTING", effect: "UNKNOWN", retryAfterSeconds: 1 } };

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Submit one order whose placement call is HELD (in flight) until `release` is called. */
async function held(h: Harness, n: number) {
  let release: (outcome: PlacementOutcome) => void = () => undefined;
  const before = h.venue.received.length;
  h.venue.placement = () => new Promise<PlacementOutcome>((resolve) => (release = resolve));
  const g = group(n);
  await h.manager.registerGroup(g);
  const t = ticket(g, { n });
  const pending = h.manager.submit(t);
  for (let i = 0; i < 200 && h.venue.received.length === before; i += 1) await tick();
  const salt = h.venue.received.at(-1) as string;
  const attemptId = h.manager.order(t.orderId)?.submissionAttemptId as string;
  return { g, t, pending, salt, attemptId, venueOrderId: venueIdFor(salt), release: (outcome: PlacementOutcome) => release(outcome) };
}

function fillOf(venueOrderId: string, venueTradeId: string, shares: string, extra: Record<string, unknown> = {}) {
  return { venueTradeId, venueOrderId, shares, price: "0.5", liquidityRole: "TAKER", matchedAt: "2026-10-03T00:00:01Z", ...extra };
}

async function answer(h: Harness, attemptId: string, venueOrderId: string, status: string, sizeMatched: string) {
  const request = h.reconciler.latestFor(attemptId);
  return h.manager.applyReconciliation({
    requestId: request?.requestId,
    submissionAttemptId: attemptId,
    verdict: "PRESENT",
    order: { venueOrderId, status, sizeMatched, originalSize: "10" },
  });
}

describe("WP270-R3-01: a fill or an observation racing its own placement answer is retained, applied, and followed by a read", () => {
  it("E1: a fill during the held POST is retained (no alert), applied when the LIVE acceptance names its venue order id, and the order gets a fresh read; durable across a restart", async () => {
    const h = await openHarness({ balances: { pusd: "100" } });
    const s = await held(h, 1);
    expect(h.manager.order(s.t.orderId)?.state).toBe("SENDING");
    const fill = await h.manager.recordFill(fillOf(s.venueOrderId, "e1", "4"));
    expect(!fill.ok && fill.refusal.code).toBe("OMS_EVIDENCE_RETAINED");
    expect(!fill.ok && fill.refusal.details).toMatchObject({ venueOrderId: s.venueOrderId, candidateAttempts: 1 });
    expect(h.manager.alerts()).toEqual([]);
    expect(h.manager.retainedEvidence()).toEqual([
      { kind: "FILL", venueOrderId: s.venueOrderId, venueTradeId: "e1", allocationDiscriminator: "0", candidateAttemptIds: [s.attemptId] },
    ]);
    const reads = h.reconciler.requests.length;
    s.release(accepted(s.venueOrderId, "LIVE"));
    const report = await s.pending;
    expect(report.ok && report.value).toMatchObject({ attemptState: "RESPONDED", orderState: "RECONCILING" });
    expect(h.manager.order(s.t.orderId)).toMatchObject({ state: "RECONCILING", venueOrderId: s.venueOrderId, filledShares: "4", conflict: false });
    expect(h.manager.order(s.t.orderId)?.reservation).toMatchObject({ consumed: "2", held: true, released: false });
    expect(h.inventory?.book.line(ACCOUNT, PUSD)).toMatchObject({ pendingOut: "2", reserved: "3" });
    expect(h.manager.retainedEvidence()).toEqual([]);
    expect(h.reconciler.requests.length).toBe(reads + 1);
    expect(h.reconciler.latestFor(s.attemptId)?.purpose).toBe("ORDER_STATE");
    expect(h.store.snapshotSync().fills.map((f) => [f.venueTradeId, f.shares])).toEqual([["e1", "4"]]);
    // The forced read settles the race; nothing was alerted along the way.
    const read = await answer(h, s.attemptId, s.venueOrderId, "LIVE", "4");
    expect(read.ok).toBe(true);
    expect(h.manager.order(s.t.orderId)).toMatchObject({ state: "PARTIALLY_FILLED", filledShares: "4" });
    expect(h.manager.alerts()).toEqual([]);
    const r = await reopen(h);
    expect(r.manager.order(s.t.orderId)).toMatchObject({ state: "PARTIALLY_FILLED", filledShares: "4", venueOrderId: s.venueOrderId });
    expect(r.manager.order(s.t.orderId)?.reservation.consumed).toBe("2");
  });

  it("a restart between the adoption and the forced read re-requests that read (the RECONCILING state is durable)", async () => {
    const h = await openHarness({ balances: { pusd: "100" } });
    const s = await held(h, 2);
    await h.manager.recordFill(fillOf(s.venueOrderId, "e1b", "3"));
    s.release(accepted(s.venueOrderId, "LIVE"));
    await s.pending;
    const r = await reopen(h);
    expect(r.manager.order(s.t.orderId)).toMatchObject({ state: "RECONCILING", filledShares: "3" });
    expect(r.manager.outstandingReconciliations()).toBe(0);
    expect(r.reconciler.latestFor(s.attemptId)?.purpose).toBe("ORDER_STATE");
    expect(r.manager.paused).toBe(true);
    const read = await answer(r, s.attemptId, s.venueOrderId, "LIVE", "3");
    expect(read.ok).toBe(true);
    expect(r.manager.order(s.t.orderId)).toMatchObject({ state: "PARTIALLY_FILLED", filledShares: "3" });
    expect(r.manager.resume().ok).toBe(true);
  });

  it("E3: a full fill during the held POST, then ACCEPTED MATCHED: the order ends FILLED with its remainder released (never stranded ACKNOWLEDGED), also after a restart", async () => {
    const h = await openHarness({ balances: { pusd: "100" } });
    const s = await held(h, 3);
    const fill = await h.manager.recordFill(fillOf(s.venueOrderId, "e3", "10", { price: "0.45" }));
    expect(!fill.ok && fill.refusal.code).toBe("OMS_EVIDENCE_RETAINED");
    s.release(accepted(s.venueOrderId, "MATCHED"));
    const report = await s.pending;
    expect(report.ok && report.value.orderState).toBe("FILLED");
    expect(h.manager.order(s.t.orderId)).toMatchObject({ state: "FILLED", filledShares: "10", finalSize: "10" });
    // 10 @ 0.45 consumed 4.5 of the 5 reserved; the unused 0.5 is released, exactly once.
    expect(h.manager.order(s.t.orderId)?.reservation).toMatchObject({ consumed: "4.5", released: true });
    expect(h.inventory?.book.reservation(s.t.reservation.reservationId)).toMatchObject({ consumed: "4.5", released: "0.5", remaining: "0" });
    expect(h.manager.saltGate(s.g.executionGroupId)).toMatchObject({ open: true, remaining: "0" });
    expect(h.manager.outstandingReconciliations()).toBe(0);
    expect(h.manager.alerts()).toEqual([]);
    const r = await reopen(h);
    expect(r.manager.order(s.t.orderId)).toMatchObject({ state: "FILLED", filledShares: "10", finalSize: "10" });
    expect(r.manager.order(s.t.orderId)?.reservation.released).toBe(true);
    expect(r.manager.saltGate(s.g.executionGroupId)).toMatchObject({ open: true, remaining: "0" });
  });

  it("a restart while the POST is still in flight: retained evidence dies with the process; after the restart a redelivered fill is retained again (not refused) and applied when the read adopts the venue order id", async () => {
    const h = await openHarness({ balances: { pusd: "100" } });
    const s = await held(h, 4);
    expect(!(await h.manager.recordFill(fillOf(s.venueOrderId, "e4", "4"))).ok).toBe(true);
    // The process dies with its POST in flight (it is never answered); a new one starts from the store.
    const r = await reopen(h);
    expect(r.manager.paused).toBe(true);
    expect(r.manager.retainedEvidence()).toEqual([]);
    expect(r.manager.attempt(s.attemptId)).toMatchObject({ state: "RECONCILING", venueOrderId: null });
    expect(r.reconciler.latestFor(s.attemptId)?.purpose).toBe("SUBMISSION_UNKNOWN");
    const again = await r.manager.recordFill(fillOf(s.venueOrderId, "e4", "4"));
    expect(!again.ok && again.refusal.code).toBe("OMS_EVIDENCE_RETAINED");
    const observed = await r.manager.applyOrderObservation({ venueOrderId: s.venueOrderId, status: "LIVE" });
    expect(!observed.ok && observed.refusal.code).toBe("OMS_EVIDENCE_RETAINED");
    expect(r.manager.retainedEvidence().map((item) => item.kind)).toEqual(["FILL", "OBSERVATION"]);
    // The read by signed identity finds the order; adopting its id applies the retained fill and observation.
    const found = await answer(r, s.attemptId, s.venueOrderId, "LIVE", "4");
    expect(found.ok).toBe(true);
    expect(r.manager.retainedEvidence()).toEqual([]);
    expect(r.manager.order(s.t.orderId)).toMatchObject({ state: "RECONCILING", venueOrderId: s.venueOrderId, filledShares: "4" });
    expect(r.reconciler.latestFor(s.attemptId)?.purpose).toBe("ORDER_STATE");
    expect((await answer(r, s.attemptId, s.venueOrderId, "LIVE", "4")).ok).toBe(true);
    expect(r.manager.order(s.t.orderId)).toMatchObject({ state: "PARTIALLY_FILLED", filledShares: "4" });
    expect(r.manager.alerts()).toEqual([]);
    // Never resent, never re-signed.
    expect(h.venue.received).toEqual([s.salt]);
    expect(h.venue.signed).toEqual([s.salt]);
  });

  it("a restart while in flight with no redelivery: the read's matched size fixes the group's remainder and the reservation stays held until the fill comes (the E2 bound)", async () => {
    const h = await openHarness({ balances: { pusd: "100" } });
    const s = await held(h, 5);
    await h.manager.recordFill(fillOf(s.venueOrderId, "e5", "4"));
    const r = await reopen(h);
    expect((await answer(r, s.attemptId, s.venueOrderId, "CANCELED", "4")).ok).toBe(true);
    expect(r.manager.order(s.t.orderId)).toMatchObject({ state: "CANCELED", filledShares: "0", finalSize: "4" });
    expect(r.manager.order(s.t.orderId)?.reservation).toMatchObject({ held: true, released: false });
    expect(r.manager.saltGate(s.g.executionGroupId)).toMatchObject({ open: true, remaining: "6" });
    expect((await r.manager.recordFill(fillOf(s.venueOrderId, "e5", "4"))).ok).toBe(true);
    expect(r.manager.order(s.t.orderId)?.reservation).toMatchObject({ consumed: "2", released: true });
  });

  it("an observation during the held POST (CANCELED) is applied after the LIVE acceptance: CANCELED, with a FINAL_SIZE read", async () => {
    const h = await openHarness({ balances: { pusd: "100" } });
    const s = await held(h, 6);
    const observed = await h.manager.applyOrderObservation({ venueOrderId: s.venueOrderId, status: "CANCELED" });
    expect(!observed.ok && observed.refusal.code).toBe("OMS_EVIDENCE_RETAINED");
    s.release(accepted(s.venueOrderId, "LIVE"));
    await s.pending;
    expect(h.manager.order(s.t.orderId)).toMatchObject({ state: "CANCELED", finalSize: null });
    expect(h.reconciler.latestFor(s.attemptId)?.purpose).toBe("FINAL_SIZE");
    expect((await answer(h, s.attemptId, s.venueOrderId, "CANCELED", "0")).ok).toBe(true);
    expect(h.manager.order(s.t.orderId)?.reservation.released).toBe(true);
    expect(h.manager.alerts()).toEqual([]);
  });

  it("after a watchdog timeout: a fill is retained while the attempt reconciles, applied when the authoritative read (PRESENT) adopts the id; the late acceptance then changes nothing", async () => {
    const h = await openHarness({ balances: { pusd: "100" } });
    const s = await held(h, 7);
    expect((await h.manager.declareTransmissionLost(s.attemptId)).ok).toBe(true);
    expect(!(await h.manager.recordFill(fillOf(s.venueOrderId, "e7", "4"))).ok).toBe(true);
    expect(h.manager.retainedEvidence()).toHaveLength(1);
    expect((await answer(h, s.attemptId, s.venueOrderId, "LIVE", "4")).ok).toBe(true);
    expect(h.manager.order(s.t.orderId)).toMatchObject({ state: "RECONCILING", filledShares: "4", venueOrderId: s.venueOrderId });
    s.release(accepted(s.venueOrderId, "LIVE"));
    await s.pending;
    expect(h.manager.order(s.t.orderId)).toMatchObject({ state: "RECONCILING", filledShares: "4" });
    expect((await answer(h, s.attemptId, s.venueOrderId, "LIVE", "4")).ok).toBe(true);
    expect(h.manager.order(s.t.orderId)).toMatchObject({ state: "PARTIALLY_FILLED", filledShares: "4" });
    expect(h.manager.alerts()).toEqual([]);
  });

  it("a batch: a fill for one entry's order during the held postOrders is applied when the batch answer adopts it", async () => {
    const h = await openHarness({ balances: { pusd: "100" } });
    let release: (outcomes: readonly PlacementOutcome[]) => void = () => undefined;
    let handles: readonly SignedOrderHandle[] = [];
    h.venue.batch = (sent) => {
      handles = sent;
      return new Promise((resolve) => (release = resolve));
    };
    const [g1, g2] = [group(8), group(9)];
    await h.manager.registerGroup(g1);
    await h.manager.registerGroup(g2);
    const [t1, t2] = [ticket(g1, { n: 8 }), ticket(g2, { n: 9 })];
    const pending = h.manager.submitBatch([t1, t2]);
    for (let i = 0; i < 200 && handles.length === 0; i += 1) await tick();
    const ids = handles.map((handle) => venueIdFor(handle.identity.salt));
    const fill = await h.manager.recordFill(fillOf(ids[1] as string, "e8", "2"));
    expect(!fill.ok && fill.refusal.code).toBe("OMS_EVIDENCE_RETAINED");
    expect(h.manager.retainedEvidence()[0]?.candidateAttemptIds).toHaveLength(2);
    release(ids.map((id) => accepted(id)));
    await pending;
    expect(h.manager.order(t1.orderId)).toMatchObject({ state: "LIVE", filledShares: "0" });
    expect(h.manager.order(t2.orderId)).toMatchObject({ state: "RECONCILING", filledShares: "2" });
    expect(h.manager.alerts()).toEqual([]);
  });

  it("evidence waits for its own candidate: another attempt's answer arriving first applies nothing and releases nothing", async () => {
    const h = await openHarness({ balances: { pusd: "100" } });
    const a = await held(h, 14);
    const b = await held(h, 15);
    const fill = await h.manager.recordFill(fillOf(b.venueOrderId, "e15", "2"));
    expect(!fill.ok && fill.refusal.details).toMatchObject({ candidateAttempts: 2 });
    a.release(accepted(a.venueOrderId, "LIVE"));
    await a.pending;
    expect(h.manager.order(a.t.orderId)).toMatchObject({ state: "LIVE", filledShares: "0" });
    expect(h.manager.retainedEvidence()).toHaveLength(1);
    expect(h.manager.alerts()).toEqual([]);
    b.release(accepted(b.venueOrderId, "LIVE"));
    await b.pending;
    expect(h.manager.order(b.t.orderId)).toMatchObject({ state: "RECONCILING", filledShares: "2" });
    expect(h.manager.retainedEvidence()).toEqual([]);
    expect(h.manager.alerts()).toEqual([]);
  });

  it("a redelivery of a retained fill is held once; a contradicting one is held too and judged on application (a halt alert)", async () => {
    const h = await openHarness({ balances: { pusd: "100" } });
    const s = await held(h, 10);
    await h.manager.recordFill(fillOf(s.venueOrderId, "e10", "4"));
    await h.manager.recordFill(fillOf(s.venueOrderId, "e10", "4", { matchedAt: "2026-10-03T01:00:01+01:00" }));
    expect(h.manager.retainedEvidence()).toHaveLength(1);
    await h.manager.recordFill(fillOf(s.venueOrderId, "e10", "5"));
    expect(h.manager.retainedEvidence()).toHaveLength(2);
    s.release(accepted(s.venueOrderId, "LIVE"));
    await s.pending;
    expect(h.manager.order(s.t.orderId)?.filledShares).toBe("4");
    expect(h.manager.alerts()).toEqual([expect.objectContaining({ kind: "EVIDENCE_CONFLICT", haltMarket: true, orderId: s.t.orderId, venueOrderId: s.venueOrderId })]);
  });
});

describe("the salt gate waits for a transmission still in flight (r3, found with the early-arrival world)", () => {
  async function closedWhileInFlight(h: Harness, n: number) {
    const s = await held(h, n);
    expect((await h.manager.declareTransmissionLost(s.attemptId)).ok).toBe(true);
    // The read by signed identity finds the order, already canceled with nothing matched: final size 0.
    expect((await answer(h, s.attemptId, s.venueOrderId, "CANCELED", "0")).ok).toBe(true);
    expect(h.manager.order(s.t.orderId)).toMatchObject({ state: "CANCELED", finalSize: "0" });
    expect(h.manager.attempt(s.attemptId)?.inFlight).toBe(true);
    return s;
  }

  it("a terminal read while the attempt's own POST is pending leaves the gate closed; the late answer naming another venue order keeps it closed: no new salt either way", async () => {
    const h = await openHarness();
    const s = await closedWhileInFlight(h, 17);
    expect(h.manager.saltGate(s.g.executionGroupId)).toEqual({ open: false, blockers: [{ id: s.attemptId, reason: "TRANSMISSION_IN_FLIGHT" }], remaining: "10" });
    const early = await h.manager.submit(ticket(s.g, { n: 917 }));
    expect(!early.ok && early.refusal.code).toBe("OMS_SALT_GATE_CLOSED");
    s.release(accepted("venue-someone-else", "LIVE"));
    await s.pending;
    expect(h.manager.order(s.t.orderId)).toMatchObject({ venueIdConflict: true });
    expect(h.manager.saltGate(s.g.executionGroupId)?.open).toBe(false);
    expect(h.venue.signed).toEqual([s.salt]);
  });

  it("the late answer naming the same venue order opens the gate", async () => {
    const h = await openHarness();
    const s = await closedWhileInFlight(h, 18);
    expect(h.manager.saltGate(s.g.executionGroupId)?.open).toBe(false);
    s.release(accepted(s.venueOrderId, "LIVE"));
    await s.pending;
    expect(h.manager.saltGate(s.g.executionGroupId)).toEqual({ open: true, blockers: [], remaining: "10" });
    h.venue.placement = (handle) => accepted(venueIdFor(handle.identity.salt));
    expect((await h.manager.submit(ticket(s.g, { n: 918 }))).ok).toBe(true);
  });
});

describe("WP270-R3-01: evidence no attempt owns is released with a halt alert naming its venue order id", () => {
  it("with no unresolved attempt, evidence for an unknown venue order is refused at once; the alert names the venue order id", async () => {
    const h = await openHarness();
    const fill = await h.manager.recordFill(fillOf("venue-nobody", "u1", "1"));
    expect(!fill.ok && fill.refusal.code).toBe("OMS_UNKNOWN_VENUE_ORDER");
    const observed = await h.manager.applyOrderObservation({ venueOrderId: "venue-nobody-2", status: "LIVE" });
    expect(!observed.ok && observed.refusal.code).toBe("OMS_UNKNOWN_VENUE_ORDER");
    expect(h.manager.alerts()).toEqual([
      expect.objectContaining({ kind: "UNKNOWN_VENUE_ORDER", haltMarket: true, marketId: null, orderId: null, venueOrderId: "venue-nobody" }),
      expect.objectContaining({ kind: "UNKNOWN_VENUE_ORDER", haltMarket: true, marketId: null, orderId: null, venueOrderId: "venue-nobody-2" }),
    ]);
    expect(h.manager.retainedEvidence()).toEqual([]);
  });

  it("evidence retained during a held POST whose answer names another id is released, with the alert, once nothing can own it", async () => {
    const h = await openHarness();
    const s = await held(h, 11);
    const fill = await h.manager.recordFill(fillOf("venue-stranger", "x1", "1"));
    expect(!fill.ok && fill.refusal.code).toBe("OMS_EVIDENCE_RETAINED");
    expect(h.manager.alerts()).toEqual([]);
    s.release(accepted(s.venueOrderId, "LIVE"));
    await s.pending;
    expect(h.manager.retainedEvidence()).toEqual([]);
    expect(h.manager.alerts()).toEqual([
      expect.objectContaining({ kind: "UNKNOWN_VENUE_ORDER", haltMarket: true, marketId: null, venueOrderId: "venue-stranger" }),
    ]);
    // Our own order was not touched by it: no fill, no forced read.
    expect(h.manager.order(s.t.orderId)).toMatchObject({ state: "LIVE", filledShares: "0" });
  });

  it("a quiescent ABSENT that closes the only candidate releases its retained evidence with the alert", async () => {
    const h = await openHarness();
    const s = await held(h, 12);
    await h.manager.declareTransmissionLost(s.attemptId);
    s.release(UNKNOWN_TIMEOUT);
    await s.pending;
    expect(!(await h.manager.recordFill(fillOf("venue-elsewhere", "x2", "1"))).ok).toBe(true);
    expect(h.manager.retainedEvidence()).toHaveLength(1);
    const request = h.reconciler.latestFor(s.attemptId);
    const absent = await h.manager.applyReconciliation({ requestId: request?.requestId, submissionAttemptId: s.attemptId, verdict: "ABSENT", transmissionQuiescent: true });
    expect(absent.ok && absent.value.state).toBe("ABANDONED");
    expect(h.manager.retainedEvidence()).toEqual([]);
    expect(h.manager.alerts().filter((alert) => alert.kind === "UNKNOWN_VENUE_ORDER")).toEqual([
      expect.objectContaining({ haltMarket: true, venueOrderId: "venue-elsewhere" }),
    ]);
  });

  it("an attempt held absent for the 425 decision cannot own evidence: what it was a candidate for is released once it is held, and new evidence is refused at once", async () => {
    const h = await openHarness();
    const s = await held(h, 16);
    s.release(UNKNOWN_425);
    await s.pending;
    expect(!(await h.manager.recordFill(fillOf("venue-before-absent", "x3", "1"))).ok).toBe(true);
    expect(h.manager.retainedEvidence()).toHaveLength(1);
    const request = h.reconciler.latestFor(s.attemptId);
    const absent = await h.manager.applyReconciliation({ requestId: request?.requestId, submissionAttemptId: s.attemptId, verdict: "ABSENT", transmissionQuiescent: true });
    expect(absent.ok && absent.value).toMatchObject({ state: "RECONCILING", absentConfirmed: true });
    expect(h.manager.retainedEvidence()).toEqual([]);
    expect(h.manager.alerts()).toEqual([expect.objectContaining({ kind: "UNKNOWN_VENUE_ORDER", venueOrderId: "venue-before-absent" })]);
    const after = await h.manager.recordFill(fillOf("venue-while-held", "x4", "1"));
    expect(!after.ok && after.refusal.code).toBe("OMS_UNKNOWN_VENUE_ORDER");
    // Retransmitted (§9.11 step 9), the attempt is in flight again and can own new evidence.
    h.venue.placement = () => new Promise<PlacementOutcome>(() => undefined);
    void h.manager.retransmitSameSignedOrder(s.attemptId);
    for (let i = 0; i < 200 && h.venue.received.length < 2; i += 1) await tick();
    const during = await h.manager.recordFill(fillOf(s.venueOrderId, "x5", "1"));
    expect(!during.ok && during.refusal.code).toBe("OMS_EVIDENCE_RETAINED");
  });

  it(`beyond MAX_RETAINED_EVIDENCE (${String(MAX_RETAINED_EVIDENCE)}), evidence is refused with the alert, and the attempt that could own it gets a forced read once identified`, async () => {
    const h = await openHarness();
    const s = await held(h, 13);
    for (let i = 0; i < MAX_RETAINED_EVIDENCE; i += 1) {
      const result = await h.manager.recordFill(fillOf(`venue-x-${String(i)}`, `x-${String(i)}`, "1"));
      expect(!result.ok && result.refusal.code).toBe("OMS_EVIDENCE_RETAINED");
    }
    const over = await h.manager.recordFill(fillOf(s.venueOrderId, "own", "1"));
    expect(!over.ok && over.refusal.code).toBe("OMS_UNKNOWN_VENUE_ORDER");
    expect(h.manager.alerts()).toEqual([expect.objectContaining({ kind: "UNKNOWN_VENUE_ORDER", haltMarket: true, venueOrderId: s.venueOrderId })]);
    const reads = h.reconciler.requests.length;
    s.release(accepted(s.venueOrderId, "LIVE"));
    await s.pending;
    // The lost evidence named our own order: the acceptance alone is not trusted; an authoritative read follows.
    expect(h.manager.order(s.t.orderId)).toMatchObject({ state: "RECONCILING", filledShares: "0" });
    expect(h.reconciler.requests.length).toBe(reads + 1);
    expect(h.reconciler.latestFor(s.attemptId)?.purpose).toBe("ORDER_STATE");
    expect(h.manager.retainedEvidence()).toEqual([]);
    expect(h.manager.alerts().filter((alert) => alert.kind === "UNKNOWN_VENUE_ORDER")).toHaveLength(MAX_RETAINED_EVIDENCE + 1);
  });
});
