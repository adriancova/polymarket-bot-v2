/**
 * Contract: the restricted-mode detector wired into the REAL `OrderManager`
 * (WP-270) through its two hooks, `venueMode: venueModeSource(...)` and the
 * venue port wrapped by `withModeDetection(...)`, over the documented
 * restricted-mode snapshot. Every port is the WP-270 suite's mock
 * (`test/unit/oms/support`): no key, no signer, no network.
 *
 * WP-310 acceptance 2 ("A non-post-only order is never blindly retried in
 * post-only mode"), path by path:
 *
 * 1. the 425 retransmission of the SAME signed order (WP-270 decision 2),
 *    against a venue that MODELS the restart: 425 until the engine returns,
 *    then post-only for two minutes (S-D26 line 33), then normal. The order
 *    is never resent into that window, whatever the restart's length;
 * 2. a NEW signed order for a non-post-only group while POST_ONLY holds;
 * 3. the same group after a post-only refusal (503 `post_only_mode`), even
 *    after the mode has returned to NORMAL;
 * 4. a batch whose non-post-only entry was rejected in post-only mode;
 * 5. a 429 (no restart path, no mode);
 * 6. a closed-only rejection (a 400 without a documented code, D-24);
 *
 * and the companions: cancels stay allowed under TRADING_UNAVAILABLE, and the
 * 425 path waits out the restart backoff before anything is resent.
 *
 * OFFLINE: every test installs WP-260's network tripwire, and none may be
 * refused (every port here is in memory).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { venueModeSource, withModeDetection, type CancelOutcome, type GroupSpec, type OmsVenuePort, type PlacementOutcome, type VenueModeDetector } from "../../../packages/oms/src/index.js";
import { installNetworkTripwire, type NetworkTripwire } from "../../../packages/polymarket-secure/src/testing/index.js";
import { accepted, venueError, venueIdFor } from "../../unit/oms/support/fake-venue.js";
import { group, openHarness, reopen, ticket, type Harness } from "../../unit/oms/support/harness.js";

import { T0, documentedDetector } from "./support.js";

let tripwire: NetworkTripwire;
beforeEach(() => {
  tripwire = installNetworkTripwire();
});
afterEach(() => {
  tripwire.uninstall();
  expect(tripwire.refused()).toEqual([]);
});

const RESTART_1S: PlacementOutcome = { kind: "UNKNOWN", reason: "ERROR", error: venueError("ENGINE_RESTARTING", "UNKNOWN", 1) };
const POST_ONLY_79S: PlacementOutcome = { kind: "REFUSED", error: venueError("POST_ONLY_MODE", "NOT_APPLIED", 79) };
const UNAVAILABLE: PlacementOutcome = { kind: "UNKNOWN", reason: "ERROR", error: venueError("TRADING_UNAVAILABLE", "UNKNOWN") };
const RATE_LIMITED: PlacementOutcome = { kind: "UNKNOWN", reason: "ERROR", error: venueError("RATE_LIMITED", "UNKNOWN", 2) };

interface Wired {
  readonly h: Harness;
  readonly detector: VenueModeDetector;
  readonly clock: { now: number };
  /** The decorated venue port the OMS uses (the composition's other cancels go through it too). */
  readonly port: OmsVenuePort;
}

/** An OMS whose venue mode is the detector's, and whose venue answers feed the detector. */
async function wired(): Promise<Wired> {
  const base = await openHarness();
  const detector = documentedDetector();
  const clock = { now: T0 };
  const port = withModeDetection(base.venue, detector, () => clock.now);
  const h = await reopen(base, { venue: port, venueMode: venueModeSource(detector, () => clock.now) });
  return { h, detector, clock, port };
}

type EngineState = "RESTARTING" | "POST_ONLY" | "NORMAL";

/** The documented post-restart window: "enters post-only mode for two minutes" (S-D26 line 33). Venue behaviour, not the detector's snapshot. */
const VENUE_POST_ONLY_WINDOW_MS = 120_000;

/**
 * A venue whose matching engine is down until `backMs` (every order-related request: 425, no Retry-After),
 * then post-only for two minutes (a non-post-only order is refused with the 503 `post_only_mode`; post-only
 * orders and cancels go through), then normal. Records every placement it receives with the engine's state.
 */
function restartingVenue(h: Harness, clock: { readonly now: number }, backMs: number): { readonly salt: string; readonly postOnly: boolean; readonly state: EngineState }[] {
  const state = (): EngineState => (clock.now < backMs ? "RESTARTING" : clock.now < backMs + VENUE_POST_ONLY_WINDOW_MS ? "POST_ONLY" : "NORMAL");
  const landed: { readonly salt: string; readonly postOnly: boolean; readonly state: EngineState }[] = [];
  h.venue.placement = (handle) => {
    const now = state();
    landed.push({ salt: handle.identity.salt, postOnly: handle.identity.postOnly, state: now });
    if (now === "RESTARTING") return { kind: "UNKNOWN", reason: "ERROR", error: venueError("ENGINE_RESTARTING", "UNKNOWN") };
    if (now === "POST_ONLY" && !handle.identity.postOnly) {
      return { kind: "REFUSED", error: venueError("POST_ONLY_MODE", "NOT_APPLIED", Math.ceil((backMs + VENUE_POST_ONLY_WINDOW_MS - clock.now) / 1000)) };
    }
    return accepted(venueIdFor(handle.identity.salt));
  };
  h.venue.cancel = (orderId): CancelOutcome =>
    state() === "RESTARTING"
      ? { kind: "UNKNOWN", error: venueError("ENGINE_RESTARTING", "UNKNOWN") }
      : { kind: "COMPLETED", canceled: [orderId], notCanceled: [] };
  return landed;
}

async function absent(h: Harness, attemptId: string): Promise<void> {
  const request = h.reconciler.latestFor(attemptId);
  const result = await h.manager.applyReconciliation({ requestId: request?.requestId, submissionAttemptId: attemptId, verdict: "ABSENT", transmissionQuiescent: true });
  expect(result.ok).toBe(true);
}

async function submitted(h: Harness, g: GroupSpec, n: number, shares?: string): Promise<string> {
  const result = await h.manager.submit(ticket(g, shares === undefined ? { n } : { n, shares }));
  if (!result.ok) throw new Error(`submit refused: ${result.refusal.code}`);
  return result.value.submissionAttemptId;
}

describe("path 1: the 425 retransmission of the same signed order (WP-270 decision 2)", () => {
  it("a non-post-only order: nothing during the backoff, nothing while the engine's return is unseen (however long), nothing in the two minutes after it is seen, then the same salt", async () => {
    const { h, detector, clock, port } = await wired();
    h.venue.placement = () => RESTART_1S;
    const g = group(1);
    await h.manager.registerGroup(g);
    const attemptId = await submitted(h, g, 1);
    expect(detector.snapshot(T0)).toMatchObject({ mode: "RESTARTING", restartingUntilMs: T0 + 1000, engineReturnPending: true });
    await absent(h, attemptId);
    h.venue.placement = (handle) => accepted(venueIdFor(handle.identity.salt));

    clock.now = T0 + 999;
    const early = await h.manager.retransmitSameSignedOrder(attemptId);
    expect(!early.ok && early.refusal.code).toBe("OMS_TRADING_UNAVAILABLE");
    for (const later of [T0 + 1000, T0 + 121_000, T0 + 3_600_000]) {
      clock.now = later;
      const unseen = await h.manager.retransmitSameSignedOrder(attemptId);
      expect(!unseen.ok && unseen.refusal.code, String(later - T0)).toBe("OMS_POST_ONLY_MODE");
    }
    expect(h.venue.received).toHaveLength(1);

    // A cancel sent now completes: the engine is back, and its post-only window ends within two minutes of it.
    await port.cancelOrder("venue-probe");
    expect(detector.snapshot(clock.now)).toMatchObject({ mode: "POST_ONLY", engineReturnPending: false, postOnlyUntilMs: T0 + 3_720_000 });
    clock.now = T0 + 3_719_999;
    const stillPostOnly = await h.manager.retransmitSameSignedOrder(attemptId);
    expect(!stillPostOnly.ok && stillPostOnly.refusal.code).toBe("OMS_POST_ONLY_MODE");
    expect(h.venue.received).toHaveLength(1);

    clock.now = T0 + 3_720_000;
    const resent = await h.manager.retransmitSameSignedOrder(attemptId);
    expect(resent.ok && resent.value.orderState).toBe("LIVE");
    expect(h.venue.signed).toHaveLength(1);
    expect(h.venue.received).toEqual([h.venue.signed[0], h.venue.signed[0]]);
  });

  it.each([1_500, 10_000, 60_000, 119_000, 300_000, 900_000])(
    "a restart lasting %i ms, then the venue's two-minute post-only window: the same non-post-only order is never resent into that window (OP-R1-02)",
    async (restartMs) => {
      const { h, detector, clock, port } = await wired();
      const landed = restartingVenue(h, clock, T0 + restartMs);
      const g = group(80, { postOnly: false });
      await h.manager.registerGroup(g);
      const attemptId = await submitted(h, g, 80);
      expect(landed).toEqual([{ salt: h.venue.signed[0], postOnly: false, state: "RESTARTING" }]);
      let reconcile = true;
      let live = false;
      let probes = 0;
      for (let step = 0; step < 400 && !live; step += 1) {
        if (reconcile) {
          await absent(h, attemptId);
          reconcile = false;
        }
        const result = await h.manager.retransmitSameSignedOrder(attemptId);
        if (result.ok) {
          live = result.value.orderState === "LIVE";
          reconcile = !live;
          continue;
        }
        // Refused before reaching the venue: wait as the detector says, or, while the engine's return is
        // unseen, let a cancel the composition sends anyway (here, a probe) show it.
        const snapshot = detector.snapshot(clock.now);
        if (snapshot.mode === "RESTARTING") clock.now = snapshot.restartingUntilMs ?? clock.now + 1;
        else if (snapshot.engineReturnPending) {
          probes += 1;
          await port.cancelOrder(`venue-probe-${String(probes)}`);
          if (detector.snapshot(clock.now).engineReturnPending) clock.now += 1;
        } else clock.now = snapshot.postOnlyUntilMs ?? clock.now + 1;
      }
      expect(live).toBe(true);
      // The one signed order (one salt) reached the venue twice: rejected while restarting, accepted in NORMAL.
      expect(h.venue.signed).toHaveLength(1);
      expect(landed.map((entry) => entry.state)).toEqual(["RESTARTING", "NORMAL"]);
      expect(landed.filter((entry) => !entry.postOnly && entry.state === "POST_ONLY")).toEqual([]);
      expect(clock.now).toBeGreaterThanOrEqual(T0 + restartMs + VENUE_POST_ONLY_WINDOW_MS);
    },
  );

  it("a post-only order: resent as soon as the restart backoff has passed", async () => {
    const { h, clock } = await wired();
    h.venue.placement = () => RESTART_1S;
    const g = group(2, { postOnly: true });
    await h.manager.registerGroup(g);
    const attemptId = await submitted(h, g, 2);
    await absent(h, attemptId);
    h.venue.placement = (handle) => accepted(venueIdFor(handle.identity.salt));
    clock.now = T0 + 999;
    expect((await h.manager.retransmitSameSignedOrder(attemptId)).ok).toBe(false);
    clock.now = T0 + 1000;
    const resent = await h.manager.retransmitSameSignedOrder(attemptId);
    expect(resent.ok && resent.value.orderState).toBe("LIVE");
    expect(h.venue.received).toEqual([h.venue.signed[0], h.venue.signed[0]]);
  });

  it("a second 425 on the retransmission doubles the wait (bounded exponential backoff, no Retry-After)", async () => {
    const { h, detector, clock } = await wired();
    h.venue.placement = () => ({ kind: "UNKNOWN", reason: "ERROR", error: venueError("ENGINE_RESTARTING", "UNKNOWN") });
    const g = group(3, { postOnly: true });
    await h.manager.registerGroup(g);
    const attemptId = await submitted(h, g, 3);
    expect(detector.snapshot(T0).restartingUntilMs).toBe(T0 + 1000);
    await absent(h, attemptId);
    clock.now = T0 + 1000;
    await h.manager.retransmitSameSignedOrder(attemptId);
    expect(detector.snapshot(T0 + 1000).restartingUntilMs).toBe(T0 + 3000);
    await absent(h, attemptId);
    clock.now = T0 + 2999;
    const early = await h.manager.retransmitSameSignedOrder(attemptId);
    expect(!early.ok && early.refusal.code).toBe("OMS_TRADING_UNAVAILABLE");
    expect(h.venue.received).toHaveLength(2);
  });
});

describe("path 2: a new signed order for a non-post-only group while POST_ONLY holds", () => {
  it("is refused before signing; a post-only group is placed", async () => {
    const { h, detector, clock } = await wired();
    h.venue.placement = () => POST_ONLY_79S;
    const probe = group(10, { postOnly: false });
    await h.manager.registerGroup(probe);
    await submitted(h, probe, 10);
    expect(detector.snapshot(T0)).toMatchObject({ mode: "POST_ONLY", postOnlyUntilMs: T0 + 79_000 });
    h.venue.placement = (handle) => accepted(venueIdFor(handle.identity.salt));

    clock.now = T0 + 78_999;
    const other = group(11, { postOnly: false });
    await h.manager.registerGroup(other);
    const refused = await h.manager.submit(ticket(other, { n: 11 }));
    expect(!refused.ok && refused.refusal.code).toBe("OMS_POST_ONLY_MODE");
    const maker = group(12, { postOnly: true });
    await h.manager.registerGroup(maker);
    const placed = await h.manager.submit(ticket(maker, { n: 12 }));
    expect(placed.ok && placed.value.orderState).toBe("LIVE");
    expect(h.venue.signed).toHaveLength(2);

    clock.now = T0 + 79_000;
    const later = await h.manager.submit(ticket(other, { n: 13 }));
    expect(later.ok && later.value.orderState).toBe("LIVE");
  });
});

describe("path 3: the same group after a post-only refusal, even once the mode is NORMAL", () => {
  it("is never sent again unchanged, re-signed or retransmitted", async () => {
    const { h, detector, clock } = await wired();
    h.venue.placement = () => POST_ONLY_79S;
    const g = group(20, { postOnly: false, plannedShares: "20" });
    await h.manager.registerGroup(g);
    const attemptId = await submitted(h, g, 20, "10");
    h.venue.placement = (handle) => accepted(venueIdFor(handle.identity.salt));
    clock.now = T0 + 80_000;
    expect(detector.snapshot(clock.now).mode).toBe("NORMAL");
    const again = await h.manager.submit(ticket(g, { n: 21, shares: "10" }));
    expect(!again.ok && again.refusal.code).toBe("OMS_POST_ONLY_RETRY_FORBIDDEN");
    const resent = await h.manager.retransmitSameSignedOrder(attemptId);
    expect(!resent.ok && resent.refusal.code).toBe("OMS_RETRANSMIT_NOT_SUPPORTED");
    expect(h.venue.received).toHaveLength(1);
  });
});

describe("path 4: a batch whose non-post-only entry was rejected in post-only mode", () => {
  it("puts the detector in POST_ONLY for the window, and the group is never resent unchanged", async () => {
    const { h, detector, clock } = await wired();
    h.venue.batch = (handles) => handles.map((handle) => (handle.identity.postOnly ? accepted(venueIdFor(handle.identity.salt)) : { kind: "REJECTED" as const, reason: "POST_ONLY_MODE" }));
    const taker = group(30, { postOnly: false, plannedShares: "20" });
    const maker = group(31, { postOnly: true });
    await h.manager.registerGroup(taker);
    await h.manager.registerGroup(maker);
    const result = await h.manager.submitBatch([ticket(taker, { n: 30, shares: "10" }), ticket(maker, { n: 31 })]);
    expect(result.ok).toBe(true);
    expect(detector.snapshot(T0)).toMatchObject({ mode: "POST_ONLY", postOnlyUntilMs: T0 + 120_000 });
    clock.now = T0 + 120_000;
    const again = await h.manager.submit(ticket(taker, { n: 32, shares: "10" }));
    expect(!again.ok && again.refusal.code).toBe("OMS_POST_ONLY_RETRY_FORBIDDEN");
  });
});

describe("path 5: a 429 is not a restart and moves no mode", () => {
  it("the attempt is reconciled, never retransmitted", async () => {
    const { h, detector } = await wired();
    h.venue.placement = () => RATE_LIMITED;
    const g = group(40);
    await h.manager.registerGroup(g);
    const attemptId = await submitted(h, g, 40);
    expect(detector.snapshot(T0).mode).toBe("NORMAL");
    await absent(h, attemptId);
    const resent = await h.manager.retransmitSameSignedOrder(attemptId);
    expect(!resent.ok && resent.refusal.code).toBe("OMS_RETRANSMIT_NOT_SUPPORTED");
    expect(h.venue.received).toHaveLength(1);
  });
});

describe("path 6: a closed-only rejection (D-24) is never resubmitted", () => {
  it("a 400 without a documented code (WP-260's REQUEST_REJECTED) moves no mode; the attempt is reconciled, never retransmitted", async () => {
    const { h, detector } = await wired();
    h.venue.placement = () => ({ kind: "UNKNOWN", reason: "ERROR", error: venueError("REQUEST_REJECTED", "UNKNOWN") });
    const g = group(70);
    await h.manager.registerGroup(g);
    const attemptId = await submitted(h, g, 70);
    expect(detector.snapshot(T0).mode).toBe("NORMAL");
    await absent(h, attemptId);
    const resent = await h.manager.retransmitSameSignedOrder(attemptId);
    expect(!resent.ok && resent.refusal.code).toBe("OMS_RETRANSMIT_NOT_SUPPORTED");
    expect(detector.retransmissionGate({ errorKind: "REQUEST_REJECTED", postOnly: false }, T0)).toMatchObject({ allowed: false, reason: "RETRY_ONLY_RESTART" });
    expect(h.venue.received).toHaveLength(1);
  });
});

describe("cancels stay allowed when trading is unavailable (cancel-only and disabled are indistinguishable, C-9)", () => {
  it("a placement answered by an unclassified 503 pauses placements; a cancel of a live order still reaches the venue", async () => {
    const { h, detector, clock } = await wired();
    const live = group(50);
    await h.manager.registerGroup(live);
    const t = ticket(live, { n: 50 });
    const placed = await h.manager.submit(t);
    expect(placed.ok && placed.value.orderState).toBe("LIVE");
    h.venue.placement = () => UNAVAILABLE;
    const other = group(51);
    await h.manager.registerGroup(other);
    await submitted(h, other, 51);
    expect(detector.snapshot(T0)).toMatchObject({ mode: "TRADING_UNAVAILABLE", tradingUnavailableUntilMs: T0 + 5000 });
    const third = group(52);
    await h.manager.registerGroup(third);
    const refused = await h.manager.submit(ticket(third, { n: 52 }));
    expect(!refused.ok && refused.refusal.code).toBe("OMS_TRADING_UNAVAILABLE");
    clock.now = T0 + 1;
    const canceled = await h.manager.requestCancel(t.orderId);
    expect(canceled.ok && canceled.value.state).toBe("CANCELED");
    expect(h.venue.cancels).toEqual([venueIdFor(h.venue.signed[0] ?? "")]);
    expect(detector.cancelGate().cancelsEvidence).toEqual({ observation: "WORKED", atMs: T0 + 1 });
  });
});
