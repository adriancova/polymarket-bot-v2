/**
 * ACCUMULATED BINDING OBLIGATION 8 — RTDS data-quality handling.
 *
 * Four separable clauses, each with its own test:
 *
 * - `openGap.recoverableFromVenue === false` halts the feed with an incident
 *   (also asserted in acceptance 3);
 * - BOTH interval fields are handled — the measured `unobservedInterval` AND
 *   the typed `unobservedIntervalUnavailable`. "No measured interval" is never
 *   read as "no gap" (WP-100 round-1 known risk 2, follow-up 2);
 * - the freshness/eviction signals are read: a series that is REALLY evicted
 *   (257 distinct series against the adapter's 256-series bound) reports
 *   `firstObservationEver` again, which is a statement about this adapter
 *   instance and not about the venue (WP-100 known risk 4);
 * - a SECONDS-spelled RTDS observation timestamp publishes a visibly-wrong
 *   1970 window, and the gateway's freshness logic must FAIL it (WP-100
 *   round-1 known risk 1).
 *
 * Plus the WP-100 symbol-filter obligation: a multi-symbol subscription
 * receives every symbol, and the gateway filters on `payload.symbol` — the
 * unplanned ones are counted, never silently dropped and never published.
 */

import { describe, expect, it } from "vitest";

import { buildHarness, rtdsUpdateFrame } from "./support/harness.js";

const RTDS_CONFIG = {
  rtds: {
    feedId: "polymarket-rtds-twap",
    subscriptions: [{ windowSeconds: 60 }],
    plannedSymbols: ["btc/usd"],
    maxObservationAgeMs: 300_000,
  },
} as const;

describe("obligation 8 — RTDS coverage breaks, freshness, and symbol planning", () => {
  it("opens a coverage-break incident for a MEASURED unobserved interval", async () => {
    const harness = await buildHarness({ config: { ...RTDS_CONFIG } });
    harness.gateway.start();
    const first = harness.rtdsSockets.current;
    first.open();
    const baseMs = harness.clock.nowMs();
    first.message(rtdsUpdateFrame({ symbol: "btc/usd", observationMs: baseMs }));
    await harness.settle();

    // The stream breaks and resumes; the first observation after the break is
    // NEWER than the last one before it, so the interval is measurable.
    first.serverClose();
    harness.timers.advance(5_000);
    await harness.settle();
    const second = harness.rtdsSockets.current;
    second.open();
    harness.clock.advance(1_000);
    second.message(
      rtdsUpdateFrame({ symbol: "btc/usd", observationMs: baseMs + 60_000 }),
    );
    await harness.settle();

    const breaks = harness.incidents.filter(
      (incident) => incident.reasonCode === "RTDS_TWAP_COVERAGE_BROKEN",
    );
    expect(breaks).toHaveLength(1);
    expect(breaks[0]?.severity).toBe("PAGE");
    expect(breaks[0]?.detail).toContain("unobserved interval");
    expect(breaks[0]?.detail).toContain("ADR-009 §6");
    expect(harness.gateway.metrics().rtds?.coverageBreaks).toBe(1);

    await harness.gateway.stop();
  });

  it("opens a coverage-break incident for an UNMEASURABLE interval too (no measured interval is not no gap)", async () => {
    const harness = await buildHarness({ config: { ...RTDS_CONFIG } });
    harness.gateway.start();
    const first = harness.rtdsSockets.current;
    first.open();
    const baseMs = harness.clock.nowMs();
    first.message(rtdsUpdateFrame({ symbol: "btc/usd", observationMs: baseMs }));
    await harness.settle();

    first.serverClose();
    harness.timers.advance(5_000);
    await harness.settle();
    const second = harness.rtdsSockets.current;
    second.open();
    harness.clock.advance(1_000);
    // The first observation after the break REGRESSED: it is older than the
    // last pre-break one, so the interval has no measurable end bound. The gap
    // is still real, and `unobservedIntervalUnavailable` says so.
    second.message(
      rtdsUpdateFrame({ symbol: "btc/usd", observationMs: baseMs - 30_000 }),
    );
    await harness.settle();

    const breaks = harness.incidents.filter(
      (incident) => incident.reasonCode === "RTDS_TWAP_COVERAGE_BROKEN",
    );
    expect(breaks).toHaveLength(1);
    expect(breaks[0]?.detail).toContain("no measurable end bound yet");
    expect(harness.gateway.metrics().rtds?.coverageBreaks).toBe(1);
    // And the regressed observation is flagged out of order, not suppressed.
    expect(harness.gateway.metrics().rtds?.outOfOrderObservations).toBeGreaterThanOrEqual(1);

    await harness.gateway.stop();
  });

  it("fails freshness on a SECONDS-spelled observation timestamp (the visibly-wrong 1970 window)", async () => {
    const harness = await buildHarness({ config: { ...RTDS_CONFIG } });
    harness.gateway.start();
    const socket = harness.rtdsSockets.current;
    socket.open();

    // The venue field is documented as unix MILLISECONDS. A seconds-spelled
    // value is read as documented and produces a 1970 window rather than a
    // silent reinterpretation — which the freshness bound must then fail.
    const secondsSpelled = Math.floor(harness.clock.nowMs() / 1000);
    socket.message(rtdsUpdateFrame({ symbol: "btc/usd", observationMs: secondsSpelled }));
    await harness.settle();

    const failures = harness.incidents.filter(
      (incident) => incident.reasonCode === "RTDS_OBSERVATION_FRESHNESS_FAILED",
    );
    expect(failures).toHaveLength(1);
    expect(harness.gateway.metrics().rtds?.freshnessFailures).toBe(1);

    // The observation IS published — it is real venue data and the raw frame is
    // recorded — but its window is the visibly-wrong one, which is exactly why
    // freshness had to fail it rather than the adapter guessing a rescale.
    const observed = harness.publishedOfType("ReferenceTwapObserved");
    expect(observed).toHaveLength(1);
    const payload = observed[0]?.payload as { windowEndAt: string };
    expect(payload.windowEndAt.startsWith("1970-")).toBe(true);
    expect(failures[0]?.detail).toContain("1970-");

    await harness.gateway.stop();
  });

  it("passes freshness for a correctly-spelled recent observation", async () => {
    const harness = await buildHarness({ config: { ...RTDS_CONFIG } });
    harness.gateway.start();
    const socket = harness.rtdsSockets.current;
    socket.open();
    socket.message(
      rtdsUpdateFrame({ symbol: "btc/usd", observationMs: harness.clock.nowMs() }),
    );
    await harness.settle();

    expect(harness.gateway.metrics().rtds?.freshnessFailures).toBe(0);
    expect(harness.publishedOfType("ReferenceTwapObserved")).toHaveLength(1);

    await harness.gateway.stop();
  });

  it("reads firstObservationEver for a new series and not for a continuing one", async () => {
    const harness = await buildHarness({ config: { ...RTDS_CONFIG } });
    harness.gateway.start();
    const socket = harness.rtdsSockets.current;
    socket.open();
    socket.message(
      rtdsUpdateFrame({ symbol: "btc/usd", observationMs: harness.clock.nowMs() }),
    );
    await harness.settle();

    // The very first observation of a series is a first observation ever — for
    // this adapter instance, which is a statement about this process and not
    // about the venue's history.
    expect(harness.gateway.metrics().rtds?.firstObservations).toBe(1);

    harness.clock.advance(1_000);
    socket.message(
      rtdsUpdateFrame({ symbol: "btc/usd", observationMs: harness.clock.nowMs() }),
    );
    await harness.settle();
    // A continuing series is not a first observation.
    expect(harness.gateway.metrics().rtds?.firstObservations).toBe(1);

    await harness.gateway.stop();
  });

  // ROUND-1 REVIEW L3: the round-1 test was NAMED for reappearance after
  // eviction and never caused an eviction — it sent one series twice. The
  // adapter's tracker holds `maxTrackedSeries` (256) series and evicts the
  // least recently updated, so an eviction takes 257 distinct series. This
  // one actually does it, and the reappearing series' second
  // `firstObservationEver` is the evidence the eviction happened.
  it("reports firstObservationEver AGAIN for a series that really was evicted", async () => {
    const harness = await buildHarness({ config: { ...RTDS_CONFIG } });
    harness.gateway.start();
    const socket = harness.rtdsSockets.current;
    socket.open();

    const observe = (symbol: string): void => {
      harness.clock.advance(1);
      socket.message(rtdsUpdateFrame({ symbol, observationMs: harness.clock.nowMs() }));
    };

    observe("btc/usd");
    await harness.settle();
    expect(harness.gateway.metrics().rtds?.firstObservations).toBe(1);

    // 256 further distinct series push the tracker past its bound, and
    // `btc/usd` is the least recently updated, so it is the one evicted.
    const fillerCount = 256;
    for (let index = 0; index < fillerCount; index += 1) {
      observe(`fil${String(index)}/usd`);
    }
    await harness.settle();
    // Every filler is a new series, hence a first observation of its own; none
    // of them is published, because none is planned.
    expect(harness.gateway.metrics().rtds?.firstObservations).toBe(1 + fillerCount);
    expect(harness.gateway.metrics().rtds?.unplannedSymbolObservations).toBe(fillerCount);
    expect(harness.publishedOfType("ReferenceTwapObserved")).toHaveLength(1);

    // The evicted series reappears. The adapter truthfully reports a FIRST
    // observation again: "first" is a claim about this adapter instance, never
    // about the venue's history (WP-100 known risk 4).
    observe("btc/usd");
    await harness.settle();
    expect(harness.gateway.metrics().rtds?.firstObservations).toBe(2 + fillerCount);
    expect(harness.publishedOfType("ReferenceTwapObserved")).toHaveLength(2);

    await harness.gateway.stop();
  });

  it("publishes only planned symbols and counts the rest (never a silent drop)", async () => {
    const harness = await buildHarness({ config: { ...RTDS_CONFIG } });
    harness.gateway.start();
    const socket = harness.rtdsSockets.current;
    socket.open();

    socket.message(
      rtdsUpdateFrame({ symbol: "btc/usd", observationMs: harness.clock.nowMs() }),
    );
    harness.clock.advance(10);
    // The venue delivers every symbol on a multi-symbol subscription.
    socket.message(
      rtdsUpdateFrame({ symbol: "sol/usd", observationMs: harness.clock.nowMs() }),
    );
    await harness.settle();

    const observed = harness.publishedOfType("ReferenceTwapObserved");
    expect(observed).toHaveLength(1);
    expect((observed[0]?.payload as { symbol: string }).symbol).toBe("btc/usd");
    expect(harness.gateway.metrics().rtds?.unplannedSymbolObservations).toBe(1);

    // Not a silent drop: the unplanned symbol's raw frame is still recorded.
    await harness.gateway.stop();
    const snapshot = harness.walFileSystem.snapshot();
    expect(Object.values(snapshot).some((file) => file.includes("sol/usd"))).toBe(true);
  });
});
