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

describe("RESTARTING (HTTP 425)", () => {
  it("honours Retry-After EXACTLY, then post-only for the window, then normal", () => {
    const detector = detectorOf();
    place(detector, RESTART(2), T0);
    expect(modes(detector, [T0, T0 + 1999, T0 + 2000, T0 + 6999, T0 + 7000])).toEqual(["RESTARTING", "RESTARTING", "POST_ONLY", "POST_ONLY", "NORMAL"]);
    expect(detector.omsVenueMode(T0 + 1999)).toBe("TRADING_UNAVAILABLE");
    expect(detector.omsVenueMode(T0 + 2000)).toBe("POST_ONLY");
    expect(detector.omsVenueMode(T0 + 7000)).toBe("NORMAL");
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
    place(detector, ACCEPTED, at + 10);
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
    expect(detector.placementGate({ postOnly: false }, T0 + 1000)).toEqual({ allowed: false, reason: "POST_ONLY_MODE_REQUIRES_POST_ONLY", retryAtMs: T0 + 6000 });
    expect(detector.placementGate({ postOnly: true }, T0 + 1000)).toEqual({ allowed: true });
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
    expect(detector.retransmissionGate({ errorKind: "ENGINE_RESTARTING", postOnly: true }, T0 + 1000)).toEqual({ allowed: true });
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
