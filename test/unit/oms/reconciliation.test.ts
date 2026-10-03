/**
 * WP-270: §9.11 step 8 and ADR-007 §3. An unknown submission resolves only
 * through an authoritative answer bound to the attempt's CURRENT request, by
 * exact id (ADR-032's binding, applied to orders): never by time, a stream
 * message, an unbound, superseded, consumed, undelivered or foreign answer.
 */

import { describe, expect, it } from "vitest";

import { type PlacementOutcome } from "../../../packages/oms/src/index.js";

import { venueError, venueIdFor } from "./support/fake-venue.js";
import { group, openHarness, ticket, type Harness } from "./support/harness.js";

const UNKNOWN: PlacementOutcome = { kind: "UNKNOWN", reason: "ERROR", error: venueError("TRANSPORT_FAILURE", "UNKNOWN") };

async function unknownAttempt(h: Harness, n: number): Promise<{ attemptId: string; orderId: string; salt: string }> {
  h.venue.placement = () => UNKNOWN;
  const g = group(n);
  await h.manager.registerGroup(g);
  const t = ticket(g, { n });
  const result = await h.manager.submit(t);
  if (!result.ok) throw new Error(`submit failed: ${result.refusal.code}`);
  return { attemptId: result.value.submissionAttemptId, orderId: t.orderId, salt: h.venue.signed.at(-1) as string };
}

describe("request binding", () => {
  it("refuses an answer naming an id never issued, and never issues that id later (ADR-032 D7)", async () => {
    let n = 0;
    const h = await openHarness({ requestToken: () => ((n += 1) === 2 ? "predicted" : `t-${String(n)}`) });
    // The first request is not delivered, so a retry will build request #2, whose token is "predicted".
    h.reconciler.throwNext = 1;
    const { attemptId } = await unknownAttempt(h, 1);
    expect(h.reconciler.requests).toHaveLength(0);
    const part = (text: string): string => `${String(text.length)}:${text};`;
    const predicted = `${part("oms-attempt")}${part(attemptId)}${part("reconciliation")}${part("2")}${part("predicted")}`;
    const early = await h.manager.applyReconciliation({ requestId: predicted, submissionAttemptId: attemptId, verdict: "ABSENT", transmissionQuiescent: true });
    expect(!early.ok && early.refusal.code).toBe("OMS_RECONCILIATION_UNBOUND");
    // The retry draws exactly that id: it is skipped and stays owed.
    const skipped = await h.manager.retryReconciliationRequests();
    expect(skipped.ok && skipped.value).toBe(0);
    expect(h.reconciler.requests).toHaveLength(0);
    expect(h.manager.outstandingReconciliations()).toBe(1);
    // The next retry draws a fresh token and delivers.
    const delivered = await h.manager.retryReconciliationRequests();
    expect(delivered.ok && delivered.value).toBe(1);
    const request = h.reconciler.latestFor(attemptId);
    expect(request?.requestId).not.toBe(predicted);
    // The pre-named id stays refused.
    const late = await h.manager.applyReconciliation({ requestId: predicted, submissionAttemptId: attemptId, verdict: "ABSENT", transmissionQuiescent: true });
    expect(!late.ok && late.refusal.code).toBe("OMS_RECONCILIATION_UNBOUND");
    expect(h.manager.attempt(attemptId)?.state).toBe("RECONCILING");
  });

  it("refuses a superseded answer, a consumed one, one for another attempt, and accepts only the current one", async () => {
    const h = await openHarness();
    const a = await unknownAttempt(h, 2);
    const b = await unknownAttempt(h, 3);
    const first = h.reconciler.latestFor(a.attemptId);
    const other = h.reconciler.latestFor(b.attemptId);
    const foreign = await h.manager.applyReconciliation({ requestId: other?.requestId, submissionAttemptId: a.attemptId, verdict: "ABSENT", transmissionQuiescent: true });
    expect(!foreign.ok && foreign.refusal.code).toBe("OMS_RECONCILIATION_SUBJECT_MISMATCH");
    const accepted = await h.manager.applyReconciliation({ requestId: first?.requestId, submissionAttemptId: a.attemptId, verdict: "ABSENT", transmissionQuiescent: true });
    expect(accepted.ok).toBe(true);
    const replay = await h.manager.applyReconciliation({ requestId: first?.requestId, submissionAttemptId: a.attemptId, verdict: "ABSENT", transmissionQuiescent: true });
    expect(!replay.ok && replay.refusal.code).toBe("OMS_RECONCILIATION_SUPERSEDED");
  });

  it("an undelivered request (the reconciler threw) cannot be answered; retry delivers a fresh one", async () => {
    const h = await openHarness();
    h.reconciler.throwNext = 1;
    const { attemptId } = await unknownAttempt(h, 4);
    expect(h.reconciler.requests).toHaveLength(0);
    expect(h.manager.outstandingReconciliations()).toBe(1);
    expect(h.manager.alerts().some((alert) => alert.kind === "RECONCILIATION_UNDELIVERED")).toBe(true);
    const retried = await h.manager.retryReconciliationRequests();
    expect(retried.ok && retried.value).toBe(1);
    expect(h.manager.outstandingReconciliations()).toBe(0);
    const request = h.reconciler.latestFor(attemptId);
    const answer = await h.manager.applyReconciliation({ requestId: request?.requestId, submissionAttemptId: attemptId, verdict: "ABSENT", transmissionQuiescent: true });
    expect(answer.ok && answer.value.state).toBe("ABANDONED");
  });

  it("a failed token draw leaves the attempt SUBMISSION_UNKNOWN with the request owed; a repeated token is a failed draw", async () => {
    let calls = 0;
    const h = await openHarness({ requestToken: () => (calls += 1) <= 2 ? "same" : `fresh-${String(calls)}` });
    const a = await unknownAttempt(h, 5);
    expect(h.manager.attempt(a.attemptId)?.state).toBe("RECONCILING");
    const b = await unknownAttempt(h, 6);
    // "same" was drawn again: refused; the attempt stays SUBMISSION_UNKNOWN, owed.
    expect(h.manager.attempt(b.attemptId)?.state).toBe("SUBMISSION_UNKNOWN");
    expect(h.manager.order(b.orderId)?.state).toBe("SUBMISSION_UNKNOWN");
    expect(h.manager.outstandingReconciliations()).toBe(1);
    const retried = await h.manager.retryReconciliationRequests();
    expect(retried.ok && retried.value).toBe(1);
    expect(h.manager.attempt(b.attemptId)?.state).toBe("RECONCILING");
  });

  it("a coordinator answering synchronously inside `request` is bound (the request counts as received)", async () => {
    const h = await openHarness();
    let inner: Promise<unknown> | undefined;
    h.reconciler.onRequest = (request) => {
      inner = h.manager.applyReconciliation({ requestId: request.requestId, submissionAttemptId: request.submissionAttemptId, verdict: "ABSENT", transmissionQuiescent: true });
    };
    const { attemptId } = await unknownAttempt(h, 7);
    await inner;
    expect(h.manager.attempt(attemptId)?.state).toBe("ABANDONED");
  });

  it("refuses answers that are not own data, or that carry an unknown verdict, or an ABSENT with an order", async () => {
    const h = await openHarness();
    const { attemptId } = await unknownAttempt(h, 8);
    const request = h.reconciler.latestFor(attemptId);
    const getter = Object.defineProperty({ submissionAttemptId: attemptId, verdict: "ABSENT" }, "requestId", { get: () => request?.requestId });
    expect((await h.manager.applyReconciliation(getter)).ok).toBe(false);
    const inherited = Object.assign(Object.create({ verdict: "ABSENT", transmissionQuiescent: true }) as object, { requestId: request?.requestId, submissionAttemptId: attemptId });
    const inheritedResult = await h.manager.applyReconciliation(inherited);
    expect(!inheritedResult.ok && inheritedResult.refusal.code).toBe("OMS_RECONCILIATION_UNRECOGNISED");
    const weird = await h.manager.applyReconciliation({ requestId: request?.requestId, submissionAttemptId: attemptId, verdict: "GONE" });
    expect(!weird.ok && weird.refusal.code).toBe("OMS_RECONCILIATION_UNRECOGNISED");
    const absentWithOrder = await h.manager.applyReconciliation({
      requestId: request?.requestId,
      submissionAttemptId: attemptId,
      verdict: "ABSENT",
      order: { venueOrderId: "x", status: "LIVE", sizeMatched: "0", originalSize: "10" },
    });
    expect(!absentWithOrder.ok && absentWithOrder.refusal.code).toBe("OMS_RECONCILIATION_UNRECOGNISED");
    expect(h.manager.attempt(attemptId)?.state).toBe("RECONCILING");
  });
});

describe("the quiescence rule (ABSENT)", () => {
  it("refuses an ABSENT answer that does not attest the read was made after every transmission could arrive", async () => {
    const h = await openHarness();
    const { attemptId } = await unknownAttempt(h, 9);
    const request = h.reconciler.latestFor(attemptId);
    for (const attestation of [undefined, false, "true", 1]) {
      const result = await h.manager.applyReconciliation({
        requestId: request?.requestId,
        submissionAttemptId: attemptId,
        verdict: "ABSENT",
        ...(attestation === undefined ? {} : { transmissionQuiescent: attestation }),
      });
      expect(!result.ok && result.refusal.code).toBe("OMS_RECONCILIATION_NOT_QUIESCENT");
    }
    const getter = Object.defineProperty({ requestId: request?.requestId, submissionAttemptId: attemptId, verdict: "ABSENT" }, "transmissionQuiescent", {
      get: () => true,
    });
    expect((await h.manager.applyReconciliation(getter)).ok).toBe(false);
    expect(h.manager.attempt(attemptId)?.state).toBe("RECONCILING");
    expect(h.manager.saltGate(h.manager.attempt(attemptId)?.executionGroupId as string)?.open).toBe(false);
    const attested = await h.manager.applyReconciliation({ requestId: request?.requestId, submissionAttemptId: attemptId, verdict: "ABSENT", transmissionQuiescent: true });
    expect(attested.ok && attested.value.state).toBe("ABANDONED");
  });
});

describe("PRESENT answers", () => {
  const CASES: readonly {
    readonly status: string;
    readonly sizeMatched: string;
    readonly state: string | null;
    readonly finalSize: string | null;
  }[] = [
    { status: "LIVE", sizeMatched: "0", state: "LIVE", finalSize: null },
    { status: "UNMATCHED", sizeMatched: "0", state: "LIVE", finalSize: null },
    { status: "LIVE", sizeMatched: "3", state: "PARTIALLY_FILLED", finalSize: null },
    { status: "DELAYED", sizeMatched: "0", state: "DELAYED", finalSize: null },
    { status: "MATCHED", sizeMatched: "10", state: "FILLED", finalSize: "10" },
    { status: "MATCHED", sizeMatched: "4", state: "PARTIALLY_FILLED", finalSize: null },
    { status: "CANCELED", sizeMatched: "0", state: "CANCELED", finalSize: "0" },
    { status: "CANCELED", sizeMatched: "2.5", state: "CANCELED", finalSize: "2.5" },
    { status: "EXPIRED", sizeMatched: "1", state: "EXPIRED", finalSize: "1" },
    // Contradictory status and sizes are not one order state: refused, nothing changes.
    { status: "DELAYED", sizeMatched: "1", state: null, finalSize: null },
    { status: "MATCHED", sizeMatched: "0", state: null, finalSize: null },
    { status: "LIVE", sizeMatched: "10", state: null, finalSize: null },
    { status: "REJECTED", sizeMatched: "0", state: null, finalSize: null },
  ];
  for (const [index, row] of CASES.entries()) {
    it(`${row.status} with ${row.sizeMatched} matched → ${row.state ?? "refused"}`, async () => {
      const h = await openHarness();
      const { attemptId, orderId, salt } = await unknownAttempt(h, 20 + index);
      const request = h.reconciler.latestFor(attemptId);
      const result = await h.manager.applyReconciliation({
        requestId: request?.requestId,
        submissionAttemptId: attemptId,
        verdict: "PRESENT",
        order: { venueOrderId: venueIdFor(salt), status: row.status, sizeMatched: row.sizeMatched, originalSize: "10" },
      });
      if (row.state === null) {
        expect(!result.ok && result.refusal.code).toBe("OMS_RECONCILIATION_UNRECOGNISED");
        expect(h.manager.order(orderId)?.state).toBe("RECONCILING");
        return;
      }
      expect(result.ok && result.value).toMatchObject({ state: "RESPONDED", venueOrderId: venueIdFor(salt) });
      expect(h.manager.order(orderId)).toMatchObject({ state: row.state, finalSize: row.finalSize, venueSizeMatched: row.sizeMatched });
    });
  }

  it("refuses a PRESENT answer whose original size differs, or whose venue id another order holds", async () => {
    const h = await openHarness();
    const a = await unknownAttempt(h, 40);
    const b = await unknownAttempt(h, 41);
    const ra = h.reconciler.latestFor(a.attemptId);
    const wrongSize = await h.manager.applyReconciliation({
      requestId: ra?.requestId,
      submissionAttemptId: a.attemptId,
      verdict: "PRESENT",
      order: { venueOrderId: venueIdFor(a.salt), status: "LIVE", sizeMatched: "0", originalSize: "11" },
    });
    expect(!wrongSize.ok && wrongSize.refusal.code).toBe("OMS_EVIDENCE_CONFLICT");
    await h.manager.applyReconciliation({
      requestId: ra?.requestId,
      submissionAttemptId: a.attemptId,
      verdict: "PRESENT",
      order: { venueOrderId: "venue-shared", status: "LIVE", sizeMatched: "0", originalSize: "10" },
    });
    const rb = h.reconciler.latestFor(b.attemptId);
    const taken = await h.manager.applyReconciliation({
      requestId: rb?.requestId,
      submissionAttemptId: b.attemptId,
      verdict: "PRESENT",
      order: { venueOrderId: "venue-shared", status: "LIVE", sizeMatched: "0", originalSize: "10" },
    });
    expect(!taken.ok && taken.refusal.code).toBe("OMS_EVIDENCE_CONFLICT");
    expect(h.manager.attempt(b.attemptId)?.state).toBe("RECONCILING");
    expect(h.manager.alerts().filter((alert) => alert.kind === "EVIDENCE_CONFLICT" && alert.haltMarket)).toHaveLength(2);
  });

  it("an ABSENT answer for an order the venue already identified is an evidence conflict (VENUE_FACTS.READ_BY_ID_ANY_STATUS)", async () => {
    const h = await openHarness();
    const { attemptId, orderId, salt } = await unknownAttempt(h, 42);
    let request = h.reconciler.latestFor(attemptId);
    await h.manager.applyReconciliation({
      requestId: request?.requestId,
      submissionAttemptId: attemptId,
      verdict: "PRESENT",
      order: { venueOrderId: venueIdFor(salt), status: "LIVE", sizeMatched: "0", originalSize: "10" },
    });
    h.venue.cancel = () => ({ kind: "UNKNOWN", error: null });
    const canceled = await h.manager.requestCancel(orderId);
    expect(canceled.ok && canceled.value.state).toBe("RECONCILING");
    request = h.reconciler.latestFor(attemptId);
    expect(request?.purpose).toBe("ORDER_STATE");
    expect(request?.venueOrderId).toBe(venueIdFor(salt));
    const absent = await h.manager.applyReconciliation({ requestId: request?.requestId, submissionAttemptId: attemptId, verdict: "ABSENT", transmissionQuiescent: true });
    expect(!absent.ok && absent.refusal.code).toBe("OMS_EVIDENCE_CONFLICT");
    expect(h.manager.order(orderId)?.state).toBe("RECONCILING");
  });

  it("a stream observation never resolves RECONCILING; only an answer does", async () => {
    const h = await openHarness();
    const { attemptId, orderId, salt } = await unknownAttempt(h, 43);
    let request = h.reconciler.latestFor(attemptId);
    await h.manager.applyReconciliation({
      requestId: request?.requestId,
      submissionAttemptId: attemptId,
      verdict: "PRESENT",
      order: { venueOrderId: venueIdFor(salt), status: "LIVE", sizeMatched: "0", originalSize: "10" },
    });
    h.venue.cancel = () => ({ kind: "UNKNOWN", error: null });
    await h.manager.requestCancel(orderId);
    const observed = await h.manager.applyOrderObservation({ venueOrderId: venueIdFor(salt), status: "CANCELED" });
    expect(observed.ok && observed.value.state).toBe("RECONCILING");
    request = h.reconciler.latestFor(attemptId);
    const answered = await h.manager.applyReconciliation({
      requestId: request?.requestId,
      submissionAttemptId: attemptId,
      verdict: "PRESENT",
      order: { venueOrderId: venueIdFor(salt), status: "CANCELED", sizeMatched: "0", originalSize: "10" },
    });
    expect(answered.ok).toBe(true);
    expect(h.manager.order(orderId)).toMatchObject({ state: "CANCELED", finalSize: "0" });
    expect(h.manager.order(orderId)?.reservation.released).toBe(true);
  });
});
