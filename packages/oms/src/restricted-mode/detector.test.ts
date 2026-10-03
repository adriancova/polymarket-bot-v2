/**
 * WP-310 deliverable 3 and acceptance 2: 425 / post-only / cancel-only state
 * handling, backoff by kind, the gates, and the OMS-mode mapping. Synthetic
 * snapshot numbers (`fixtures.test-support.ts`): post-only window 5 s,
 * restart backoff 100 ms ×3 capped at 1 s, unavailable pause 2 s ×2 capped
 * at 10 s.
 */

import { describe, expect, it } from "vitest";

import type { PlacementClass } from "../outcomes.js";
import type { CancelOutcome, OmsVenuePort, PlacementOutcome, SignOutcome } from "../ports.js";

import type { VenueModeDetector } from "./detector.js";
import { T0, detectorOf, modeSnapshot } from "./fixtures.test-support.js";
import { conditionOfCancelOutcome, conditionOfPlacement, conditionsOfBatchOutcome } from "./signals.js";
import { venueModeSource, withModeDetection } from "./venue-port.js";

const RESTART = (retryAfterSeconds: number | null): PlacementClass => ({ kind: "UNKNOWN", reason: "ERROR", errorKind: "ENGINE_RESTARTING", retryAfterSeconds });
const POST_ONLY_REFUSED = (retryAfterSeconds: number | null): PlacementClass => ({ kind: "REFUSED", errorKind: "POST_ONLY_MODE", retryAfterSeconds });
const POST_ONLY_BATCH_ENTRY: PlacementClass = { kind: "REJECTED", reason: "POST_ONLY_MODE" };
const UNAVAILABLE = (retryAfterSeconds: number | null = null): PlacementClass => ({ kind: "UNKNOWN", reason: "ERROR", errorKind: "TRADING_UNAVAILABLE", retryAfterSeconds });
const ACCEPTED: PlacementClass = { kind: "ACCEPTED", venueOrderId: "venue-1", status: "LIVE" };

function place(detector: VenueModeDetector, placement: PlacementClass, atMs: number): void {
  const result = detector.observe({ operation: "PLACEMENT", condition: conditionOfPlacement(placement) }, atMs);
  expect(result.ok).toBe(true);
}

function modes(detector: VenueModeDetector, instants: readonly number[]): string[] {
  return instants.map((atMs) => detector.snapshot(atMs).mode);
}

/** An answer (a completed cancel, or a placement the engine answered) to a request sent at `sentAtMs`, observed at `atMs`. */
function answered(detector: VenueModeDetector, operation: "PLACEMENT" | "CANCEL", sentAtMs: number | undefined, atMs: number): void {
  const signal = sentAtMs === undefined ? { operation, condition: { kind: "ANSWERED" as const } } : { operation, condition: { kind: "ANSWERED" as const }, sentAtMs };
  expect(detector.observe(signal, atMs).ok).toBe(true);
}

describe("RESTARTING (HTTP 425)", () => {
  it("honours Retry-After EXACTLY, then POST_ONLY with no end until the engine is seen back, then the window from that answer, then normal (OP-R1-02)", () => {
    const detector = detectorOf();
    place(detector, RESTART(2), T0);
    // However long it takes: the backoff's end is not the engine's return.
    expect(modes(detector, [T0, T0 + 1999, T0 + 2000, T0 + 7000, T0 + 86_400_000])).toEqual(["RESTARTING", "RESTARTING", "POST_ONLY", "POST_ONLY", "POST_ONLY"]);
    expect(detector.snapshot(T0 + 2000)).toMatchObject({ engineReturnPending: true, lastRestartObservedMs: T0, postOnlyUntilMs: null });
    expect(detector.omsVenueMode(T0 + 1999)).toBe("TRADING_UNAVAILABLE");
    expect(detector.omsVenueMode(T0 + 2000)).toBe("POST_ONLY");
    // A cancel sent at T0 + 3000 is answered at T0 + 3010: the engine is back, and its window ends at most 5 s later.
    answered(detector, "CANCEL", T0 + 3000, T0 + 3010);
    expect(detector.snapshot(T0 + 3010)).toMatchObject({ mode: "POST_ONLY", engineReturnPending: false, postOnlyUntilMs: T0 + 8010 });
    expect(modes(detector, [T0 + 8009, T0 + 8010])).toEqual(["POST_ONLY", "NORMAL"]);
    expect(detector.omsVenueMode(T0 + 8010)).toBe("NORMAL");
  });

  it("only an answer to a request SENT after the last 425 shows the engine back (OP-R1-02)", () => {
    const detector = detectorOf();
    place(detector, RESTART(1), T0);
    // Sent before the 425 (a request in flight when the engine went down), at the same instant, or with no send instant: no evidence.
    answered(detector, "CANCEL", T0 - 50, T0 + 2000);
    answered(detector, "PLACEMENT", T0, T0 + 2000);
    answered(detector, "PLACEMENT", undefined, T0 + 2000);
    expect(detector.snapshot(T0 + 2000)).toMatchObject({ mode: "POST_ONLY", engineReturnPending: true });
    // A post-only refusal of a request sent after the 425 is the running engine's own answer: its Retry-After ends the window.
    const refusal = conditionOfPlacement(POST_ONLY_REFUSED(30));
    expect(detector.observe({ operation: "PLACEMENT", condition: refusal, sentAtMs: T0 + 2000 }, T0 + 2001).ok).toBe(true);
    expect(detector.snapshot(T0 + 2001)).toMatchObject({ engineReturnPending: false, postOnlyUntilMs: T0 + 32_001 });
    expect(modes(detector, [T0 + 32_000, T0 + 32_001])).toEqual(["POST_ONLY", "NORMAL"]);
    // A later 425 starts a new episode: the earlier evidence no longer counts.
    place(detector, RESTART(1), T0 + 40_000);
    answered(detector, "CANCEL", T0 + 39_999, T0 + 41_000);
    expect(detector.snapshot(T0 + 41_000)).toMatchObject({ mode: "POST_ONLY", engineReturnPending: true });
    expect(detector.observe({ operation: "CANCEL", condition: { kind: "ANSWERED" }, sentAtMs: T0 + 41_001 }, T0 + 41_000)).toMatchObject({ ok: false, reason: "INVALID_INPUT" });
  });

  it("without Retry-After, a bounded exponential backoff that escalates only per failed attempt, and resets on an answer", () => {
    const detector = detectorOf();
    const waits: number[] = [];
    let at = T0;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      place(detector, RESTART(null), at);
      const until = detector.snapshot(at).restartingUntilMs ?? at;
      waits.push(until - at);
      // A second rejection inside the running wait (another request sent before it began) does not escalate.
      place(detector, RESTART(null), at + 1);
      expect(detector.snapshot(at + 1).restartingUntilMs).toBe(until);
      at = until;
    }
    expect(waits).toEqual([100, 300, 900, 1000, 1000]);
    expect(detector.snapshot(at).consecutiveRestartFallbacks).toBe(5);
    // An answer to a request sent before the last 425 is not the engine's return: the run goes on.
    place(detector, ACCEPTED, at + 5);
    expect(detector.snapshot(at + 5).consecutiveRestartFallbacks).toBe(5);
    answered(detector, "PLACEMENT", at + 5, at + 10);
    expect(detector.snapshot(at + 10).consecutiveRestartFallbacks).toBe(0);
    place(detector, RESTART(null), at + 20);
    expect((detector.snapshot(at + 20).restartingUntilMs ?? 0) - (at + 20)).toBe(100);
  });

  it("a 425 on a cancel is a restart signal too", () => {
    const detector = detectorOf();
    const outcome: CancelOutcome = { kind: "UNKNOWN", error: { kind: "ENGINE_RESTARTING", effect: "UNKNOWN", retryAfterSeconds: 1 } };
    expect(detector.observe({ operation: "CANCEL", condition: conditionOfCancelOutcome(outcome) }, T0)).toMatchObject({ ok: true, after: "RESTARTING" });
    expect(detector.snapshot(T0).restartingUntilMs).toBe(T0 + 1000);
  });
});

describe("POST_ONLY (503 post_only_mode)", () => {
  it("lasts the refusal's Retry-After exactly; without one, the snapshot's window", () => {
    const detector = detectorOf();
    place(detector, POST_ONLY_REFUSED(79), T0);
    expect(modes(detector, [T0, T0 + 78_999, T0 + 79_000])).toEqual(["POST_ONLY", "POST_ONLY", "NORMAL"]);
    const other = detectorOf();
    place(other, POST_ONLY_REFUSED(null), T0);
    expect(modes(other, [T0 + 4999, T0 + 5000])).toEqual(["POST_ONLY", "NORMAL"]);
  });

  it("a batch entry rejected with the post-only code is a post-only signal (the window applies)", () => {
    const detector = detectorOf();
    place(detector, POST_ONLY_BATCH_ENTRY, T0);
    expect(detector.snapshot(T0)).toMatchObject({ mode: "POST_ONLY", postOnlyUntilMs: T0 + 5000 });
  });

  it("a post-only refusal of a CANCEL is undocumented: flagged, not interpreted", () => {
    const detector = detectorOf();
    const outcome: CancelOutcome = { kind: "REFUSED", error: { kind: "POST_ONLY_MODE", effect: "NOT_APPLIED", retryAfterSeconds: 9 } };
    expect(detector.observe({ operation: "CANCEL", condition: conditionOfCancelOutcome(outcome) }, T0)).toMatchObject({
      ok: true,
      after: "NORMAL",
      flags: ["POST_ONLY_ON_CANCEL_NOT_DOCUMENTED"],
    });
  });
});

describe("TRADING_UNAVAILABLE (503 without a documented code: cancel-only or disabled, C-9)", () => {
  it("pauses placements for the snapshot's pause, escalating per repeat, never interpreting a Retry-After", () => {
    const detector = detectorOf();
    const result = detector.observe({ operation: "PLACEMENT", condition: conditionOfPlacement(UNAVAILABLE(1)) }, T0);
    expect(result).toMatchObject({ ok: true, after: "TRADING_UNAVAILABLE", flags: ["RETRY_AFTER_NOT_DOCUMENTED_FOR_CONDITION"] });
    expect(modes(detector, [T0 + 1999, T0 + 2000])).toEqual(["TRADING_UNAVAILABLE", "NORMAL"]);
    place(detector, UNAVAILABLE(), T0 + 2000);
    expect(detector.snapshot(T0 + 2000).tradingUnavailableUntilMs).toBe(T0 + 6000);
    place(detector, UNAVAILABLE(), T0 + 3000);
    expect(detector.snapshot(T0 + 3000).tradingUnavailableUntilMs).toBe(T0 + 6000);
    // A placement the venue answered ends the run.
    place(detector, ACCEPTED, T0 + 7000);
    place(detector, UNAVAILABLE(), T0 + 7001);
    expect(detector.snapshot(T0 + 7001).tradingUnavailableUntilMs).toBe(T0 + 9001);
  });

  it("cancels stay allowed in every mode; the gate reports what the last cancel showed", () => {
    const detector = detectorOf();
    expect(detector.cancelGate()).toEqual({ allowed: true, cancelsEvidence: { observation: "UNTESTED", atMs: null } });
    place(detector, UNAVAILABLE(), T0);
    expect(detector.cancelGate().allowed).toBe(true);
    detector.observe({ operation: "CANCEL", condition: conditionOfCancelOutcome({ kind: "UNKNOWN", error: { kind: "TRADING_UNAVAILABLE", effect: "UNKNOWN", retryAfterSeconds: null } }) }, T0 + 1);
    expect(detector.cancelGate()).toEqual({ allowed: true, cancelsEvidence: { observation: "FAILED", atMs: T0 + 1 } });
    detector.observe({ operation: "CANCEL", condition: conditionOfCancelOutcome({ kind: "COMPLETED", canceled: ["v"], notCanceled: [] }) }, T0 + 2);
    expect(detector.cancelGate()).toEqual({ allowed: true, cancelsEvidence: { observation: "WORKED", atMs: T0 + 2 } });
    place(detector, RESTART(5), T0 + 3);
    place(detector, POST_ONLY_REFUSED(5), T0 + 4);
    expect(detector.cancelGate().allowed).toBe(true);
  });
});

describe("what never moves the mode (\"Retry only restart rejections\", E-07)", () => {
  it.each([
    ["a 429", { kind: "UNKNOWN", reason: "ERROR", errorKind: "RATE_LIMITED", retryAfterSeconds: 2 }],
    ["a timeout", { kind: "UNKNOWN", reason: "ERROR", errorKind: "TIMEOUT", retryAfterSeconds: null }],
    ["a transport failure", { kind: "UNKNOWN", reason: "ERROR", errorKind: "TRANSPORT_FAILURE", retryAfterSeconds: null }],
    ["a 401", { kind: "UNKNOWN", reason: "ERROR", errorKind: "AUTHENTICATION_REJECTED", retryAfterSeconds: null }],
    ["an SDK unmatched", { kind: "UNKNOWN", reason: "SDK_UNMATCHED", errorKind: null, retryAfterSeconds: null }],
    ["nothing sent", { kind: "NOT_SENT", errorKind: "INVALID_REQUEST" }],
  ] as const)("%s", (_label, placement) => {
    const detector = detectorOf();
    expect(conditionOfPlacement(placement as PlacementClass)).toEqual({ kind: "NONE" });
    place(detector, placement as PlacementClass, T0);
    expect(detector.snapshot(T0).mode).toBe("NORMAL");
  });
});

describe("the gates: no blind retry in post-only mode (acceptance 2)", () => {
  it("placementGate: no order while restarting or unavailable; only post-only orders while POST_ONLY", () => {
    const detector = detectorOf();
    place(detector, RESTART(1), T0);
    expect(detector.placementGate({ postOnly: true }, T0)).toEqual({ allowed: false, reason: "RESTARTING", retryAtMs: T0 + 1000 });
    // The engine's return is unseen: no instant is known at which a non-post-only order may go.
    expect(detector.placementGate({ postOnly: false }, T0 + 1000)).toEqual({ allowed: false, reason: "POST_ONLY_MODE_REQUIRES_POST_ONLY", retryAtMs: null });
    expect(detector.placementGate({ postOnly: true }, T0 + 1000)).toEqual({ allowed: true });
    expect(detector.placementGate({ postOnly: false }, T0 + 6000)).toMatchObject({ allowed: false, retryAtMs: null });
    answered(detector, "PLACEMENT", T0 + 1000, T0 + 1000);
    expect(detector.placementGate({ postOnly: false }, T0 + 1000)).toEqual({ allowed: false, reason: "POST_ONLY_MODE_REQUIRES_POST_ONLY", retryAtMs: T0 + 6000 });
    expect(detector.placementGate({ postOnly: false }, T0 + 6000)).toEqual({ allowed: true });
    place(detector, UNAVAILABLE(), T0 + 7000);
    expect(detector.placementGate({ postOnly: true }, T0 + 7000)).toEqual({ allowed: false, reason: "TRADING_UNAVAILABLE", retryAtMs: T0 + 9000 });
  });

  it("retransmissionGate: only the restart path, only after the backoff, and never a non-post-only order while POST_ONLY", () => {
    const detector = detectorOf();
    place(detector, RESTART(1), T0);
    for (const errorKind of ["RATE_LIMITED", "TIMEOUT", "TRADING_UNAVAILABLE", "POST_ONLY_MODE", null]) {
      expect(detector.retransmissionGate({ errorKind, postOnly: true }, T0 + 1000)).toMatchObject({ allowed: false, reason: "RETRY_ONLY_RESTART" });
    }
    expect(detector.retransmissionGate({ errorKind: "ENGINE_RESTARTING", postOnly: true }, T0 + 999)).toMatchObject({ allowed: false, reason: "RESTARTING" });
    expect(detector.retransmissionGate({ errorKind: "ENGINE_RESTARTING", postOnly: false }, T0 + 1000)).toMatchObject({ allowed: false, reason: "POST_ONLY_MODE_REQUIRES_POST_ONLY" });
    expect(detector.retransmissionGate({ errorKind: "ENGINE_RESTARTING", postOnly: false }, T0 + 86_400_000)).toMatchObject({ allowed: false, reason: "POST_ONLY_MODE_REQUIRES_POST_ONLY", retryAtMs: null });
    expect(detector.retransmissionGate({ errorKind: "ENGINE_RESTARTING", postOnly: true }, T0 + 1000)).toEqual({ allowed: true });
  });

  it("a post-only refusal is evidence of the engine's return only for a request SENT after the last 425 (OP-R2-01)", () => {
    const detector = detectorOf();
    place(detector, RESTART(1), T0);
    const refusal = conditionOfPlacement(POST_ONLY_REFUSED(null));
    // In flight across the 425 (sent before it), sent at its very instant, or with no send instant: the refusal may
    // be the pre-restart engine's (or say nothing of when it was processed), so the return stays unseen.
    for (const sentAtMs of [T0 - 10, T0, undefined]) {
      const signal = sentAtMs === undefined ? { operation: "PLACEMENT" as const, condition: refusal } : { operation: "PLACEMENT" as const, condition: refusal, sentAtMs };
      expect(detector.observe(signal, T0 + 2000).ok).toBe(true);
      expect(detector.snapshot(T0 + 2000), String(sentAtMs)).toMatchObject({ mode: "POST_ONLY", engineReturnPending: true });
    }
    expect(detector.placementGate({ postOnly: false }, T0 + 86_400_000)).toEqual({ allowed: false, reason: "POST_ONLY_MODE_REQUIRES_POST_ONLY", retryAtMs: null });
    // Sent after the 425: the running engine's own refusal. The return is seen; the window it names then runs out.
    expect(detector.observe({ operation: "PLACEMENT", condition: refusal, sentAtMs: T0 + 1 }, T0 + 2001).ok).toBe(true);
    expect(detector.snapshot(T0 + 2001)).toMatchObject({ mode: "POST_ONLY", engineReturnPending: false, postOnlyUntilMs: T0 + 7001 });
    expect(detector.snapshot(T0 + 7001).mode).toBe("NORMAL");
  });

  it("a closed-only rejection (a 400 without a documented code, D-24) moves no mode and never clears a resend (OP-R1-10)", () => {
    const detector = detectorOf();
    const closedOnly: PlacementClass = { kind: "UNKNOWN", reason: "ERROR", errorKind: "REQUEST_REJECTED", retryAfterSeconds: null };
    expect(conditionOfPlacement(closedOnly)).toEqual({ kind: "NONE" });
    place(detector, closedOnly, T0);
    expect(detector.snapshot(T0).mode).toBe("NORMAL");
    for (const postOnly of [false, true]) {
      expect(detector.retransmissionGate({ errorKind: "REQUEST_REJECTED", postOnly }, T0 + 1000)).toEqual({ allowed: false, reason: "RETRY_ONLY_RESTART", retryAtMs: null });
    }
  });

  it("malformed gate input is refused, never thrown", () => {
    const detector = detectorOf();
    expect(detector.placementGate({ postOnly: "yes" } as never, T0)).toMatchObject({ allowed: false, reason: "INVALID_INPUT" });
    expect(detector.placementGate({ postOnly: true }, -5)).toMatchObject({ allowed: false, reason: "INVALID_INPUT" });
    expect(detector.retransmissionGate(null as never, T0)).toMatchObject({ allowed: false, reason: "INVALID_INPUT" });
    expect(detector.observe({ operation: "PLACEMENT", condition: { kind: "RESTARTING" } } as never, T0)).toMatchObject({ ok: false, reason: "INVALID_INPUT" });
  });
});

describe("configuration: durations come from the snapshot in effect", () => {
  it("before any snapshot is in effect the mode is TRADING_UNAVAILABLE and observations are refused", () => {
    const detector = detectorOf(modeSnapshot({ effectiveFrom: "2026-10-01T00:00:00Z" }));
    expect(detector.omsVenueMode(T0 - 1)).toBe("TRADING_UNAVAILABLE");
    expect(detector.placementGate({ postOnly: true }, T0 - 1)).toMatchObject({ allowed: false, reason: "NO_ACTIVE_CONFIGURATION" });
    expect(detector.observe({ operation: "PLACEMENT", condition: conditionOfPlacement(ACCEPTED) }, T0 - 1)).toMatchObject({ ok: false, reason: "NO_ACTIVE_CONFIGURATION" });
    expect(detector.omsVenueMode(T0)).toBe("NORMAL");
  });

  it("a later snapshot's window applies to observations from its effective instant", () => {
    const detector = detectorOf(modeSnapshot(), modeSnapshot({ snapshotId: "synthetic-modes-b", effectiveFrom: "2026-10-01T00:00:10Z", postOnlyWindowMs: 50_000 }));
    place(detector, POST_ONLY_REFUSED(null), T0 + 9999);
    expect(detector.snapshot(T0 + 9999).postOnlyUntilMs).toBe(T0 + 9999 + 5000);
    place(detector, POST_ONLY_REFUSED(null), T0 + 10_000);
    expect(detector.snapshot(T0 + 10_000).postOnlyUntilMs).toBe(T0 + 10_000 + 50_000);
    expect(detector.addConfiguration(modeSnapshot({ snapshotId: "late", effectiveFrom: "2026-10-01T00:00:05Z" }))).toMatchObject({ ok: false, reason: "EFFECTIVE_TIME_NOT_IN_FUTURE" });
  });
});

describe("signals and the OMS wiring", () => {
  it("batch answers are read with the OMS's own batch classifier", () => {
    const refusedWhole = [{ kind: "NOT_SENT", error: { kind: "INVALID_REQUEST", effect: "NOT_SENT", retryAfterSeconds: null } }];
    expect(conditionsOfBatchOutcome(refusedWhole, 2)).toEqual([{ kind: "NONE" }, { kind: "NONE" }]);
    const entries: PlacementOutcome[] = [
      { kind: "REJECTED", reason: "POST_ONLY_MODE" },
      { kind: "ACCEPTED", orderId: "v-2", status: "LIVE", makingAmount: "1", takingAmount: "2", tradeIds: [], transactionHashes: [] },
    ];
    expect(conditionsOfBatchOutcome(entries, 2)).toEqual([{ kind: "POST_ONLY", retryAfterSeconds: null }, { kind: "ANSWERED" }]);
    expect(conditionOfCancelOutcome({ kind: "WHAT" })).toEqual({ kind: "NONE" });
    expect(conditionOfCancelOutcome(Object.defineProperty({}, "kind", { get: () => "COMPLETED" }))).toEqual({ kind: "NONE" });
  });

  it("withModeDetection returns the port's answers untouched, feeds the detector, and rethrows the port's throws", async () => {
    const detector = detectorOf();
    let now = T0;
    const restartAnswer: PlacementOutcome = { kind: "UNKNOWN", reason: "ERROR", error: { kind: "ENGINE_RESTARTING", effect: "UNKNOWN", retryAfterSeconds: 3 } };
    const cancelAnswer: CancelOutcome = { kind: "COMPLETED", canceled: ["v-1"], notCanceled: [] };
    const signed: SignOutcome = { kind: "FAILED", error: { kind: "SIGNING_FAILED", effect: "NOT_SENT", retryAfterSeconds: null } };
    const port: OmsVenuePort = {
      createLimitOrder: () => Promise.resolve(signed),
      postOrder: () => Promise.resolve(restartAnswer),
      postOrders: () => Promise.reject(new Error("transport")),
      cancelOrder: () => Promise.resolve(cancelAnswer),
    };
    const wrapped = withModeDetection(port, detector, () => now);
    expect(await wrapped.createLimitOrder({ assetId: "1", side: "BUY", price: "0.5", size: "1" })).toBe(signed);
    expect(await wrapped.postOrder({} as never)).toBe(restartAnswer);
    expect(detector.snapshot(T0).restartingUntilMs).toBe(T0 + 3000);
    now = T0 + 10;
    expect(await wrapped.cancelOrder("v-1")).toBe(cancelAnswer);
    expect(detector.cancelGate().cancelsEvidence).toEqual({ observation: "WORKED", atMs: T0 + 10 });
    await expect(wrapped.postOrders([])).rejects.toThrow("transport");
    // A broken clock never breaks the venue call; it only means nothing is learned.
    const broken = withModeDetection(port, detectorOf(), () => {
      throw new Error("clock");
    });
    expect(await broken.postOrder({} as never)).toBe(restartAnswer);
  });

  it("withModeDetection gives the detector each request's SEND instant, read before the call: a cancel in flight across a 425 is no evidence (OP-R1-02)", async () => {
    const detector = detectorOf();
    let now = T0;
    const restart: PlacementOutcome = { kind: "UNKNOWN", reason: "ERROR", error: { kind: "ENGINE_RESTARTING", effect: "UNKNOWN", retryAfterSeconds: null } };
    const completed: CancelOutcome = { kind: "COMPLETED", canceled: ["v"], notCanceled: [] };
    let release: ((outcome: CancelOutcome) => void) | undefined;
    let holdCancels = true;
    const port: OmsVenuePort = {
      createLimitOrder: () => Promise.reject(new Error("unused")),
      postOrder: () => {
        now += 50;
        return Promise.resolve(restart);
      },
      postOrders: () => Promise.reject(new Error("unused")),
      cancelOrder: () =>
        holdCancels
          ? new Promise<CancelOutcome>((resolve) => {
              release = resolve;
            })
          : Promise.resolve(completed),
    };
    const wrapped = withModeDetection(port, detector, () => now);
    // A cancel sent at T0 is still in flight when a placement sent at T0 meets a 425 (observed at T0 + 50).
    const inFlight = wrapped.cancelOrder("v-1");
    await wrapped.postOrder({} as never);
    expect(detector.snapshot(now)).toMatchObject({ mode: "RESTARTING", lastRestartObservedMs: T0 + 50 });
    now = T0 + 5000;
    release?.(completed);
    await inFlight;
    expect(detector.snapshot(now)).toMatchObject({ mode: "POST_ONLY", engineReturnPending: true });
    // A cancel SENT now, after the 425, completes: the engine is back.
    holdCancels = false;
    await wrapped.cancelOrder("v-2");
    expect(detector.snapshot(now)).toMatchObject({ mode: "POST_ONLY", engineReturnPending: false, postOnlyUntilMs: T0 + 10_000 });
  });

  it.each([
    ["postOrder", false],
    ["postOrders", true],
  ] as const)("withModeDetection reads %s's SEND instant before the call: a placement in flight across a 425 is no evidence (OP-R2-01)", async (_label, batch) => {
    const detector = detectorOf();
    let now = T0;
    const restart: PlacementOutcome = { kind: "UNKNOWN", reason: "ERROR", error: { kind: "ENGINE_RESTARTING", effect: "UNKNOWN", retryAfterSeconds: null } };
    const accepted: PlacementOutcome = { kind: "ACCEPTED", orderId: "v-1", status: "LIVE", makingAmount: "1", takingAmount: "2", tradeIds: [], transactionHashes: [] };
    let release: (() => void) | undefined;
    let postOrderCalls = 0;
    const port: OmsVenuePort = {
      createLimitOrder: () => Promise.reject(new Error("unused")),
      postOrder: () => {
        postOrderCalls += 1;
        if (!batch && postOrderCalls === 1) {
          return new Promise<PlacementOutcome>((resolve) => {
            release = () => resolve(accepted);
          });
        }
        // The 425, answered 50 ms after it was sent.
        now += 50;
        return Promise.resolve(restart);
      },
      postOrders: () =>
        new Promise<readonly PlacementOutcome[]>((resolve) => {
          release = () => resolve([accepted]);
        }),
      cancelOrder: () => Promise.reject(new Error("unused")),
    };
    const wrapped = withModeDetection(port, detector, () => now);
    // Sent at T0 and still in flight when another placement, sent at T0, meets a 425 observed at T0 + 50.
    const inFlight = batch ? wrapped.postOrders([{} as never]) : wrapped.postOrder({} as never);
    await wrapped.postOrder({} as never);
    expect(detector.snapshot(now)).toMatchObject({ mode: "RESTARTING", lastRestartObservedMs: T0 + 50 });
    now = T0 + 5000;
    release?.();
    await inFlight;
    // The engine accepted it, but before the restart: its answer says nothing of the engine's return.
    expect(detector.snapshot(now)).toMatchObject({ mode: "POST_ONLY", engineReturnPending: true });
  });

  it("venueModeSource reads the detector at the clock's instant and fails closed on a bad clock", () => {
    const detector = detectorOf();
    place(detector, POST_ONLY_REFUSED(1), T0);
    let now = T0;
    const source = venueModeSource(detector, () => now);
    expect(source()).toBe("POST_ONLY");
    now = T0 + 1000;
    expect(source()).toBe("NORMAL");
    expect(venueModeSource(detector, () => Number.NaN)()).toBe("TRADING_UNAVAILABLE");
    expect(
      venueModeSource(detector, () => {
        throw new Error("clock");
      })(),
    ).toBe("TRADING_UNAVAILABLE");
  });
});
