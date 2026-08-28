import { describe, expect, it } from "vitest";

import { TwapObservationTracker, type ObservationFacts } from "./observations.js";

const BASE_MS = Date.UTC(2026, 6, 27, 19, 0, 0);

function facts(overrides: Partial<ObservationFacts> = {}): ObservationFacts {
  const observationEpochMs = overrides.observationEpochMs ?? BASE_MS;
  return {
    topic: "crypto_prices_twap_thirty",
    symbol: "btc/usd",
    observationEpochMs,
    observationIso: new Date(observationEpochMs).toISOString(),
    value: "65000.5",
    subscriptionGeneration: 1,
    receivedEpochMs: observationEpochMs + 120,
    ...overrides,
  };
}

function tracker(overrides: Partial<{ duplicateWindow: number; maxTrackedSeries: number }> = {}) {
  return new TwapObservationTracker({
    duplicateWindow: 4,
    maxTrackedSeries: 8,
    ...overrides,
  });
}

describe("the very first observation of a series", () => {
  it("is reported as first-ever and first-on-subscription, with no invented history", () => {
    const verdict = tracker().judge(facts());
    expect(verdict.status).toBe("accepted");
    if (verdict.status !== "accepted") return;
    expect(verdict.quality).toEqual({
      firstObservationEver: true,
      firstObservationOnSubscription: true,
      outOfOrder: false,
      observationAgeMs: 120,
    });
    // No previous instant, no interval, and — deliberately — no count of
    // anything that came before it.
    expect(verdict.quality.previousObservationAt).toBeUndefined();
    expect(verdict.quality.sincePreviousObservationMs).toBeUndefined();
    expect(verdict.quality.unobservedInterval).toBeUndefined();
  });

  it("judges without recording, so a refused observation reserves nothing", () => {
    const subject = tracker();
    subject.judge(facts());
    subject.judge(facts());
    expect(subject.trackedSeries).toBe(0);
    // The same instant is still publishable once it is actually published.
    expect(subject.judge(facts()).status).toBe("accepted");
  });
});

describe("subsequent observations on the same subscription", () => {
  it("measures the exact interval between venue observation times", () => {
    const subject = tracker();
    subject.remember(facts());
    const verdict = subject.judge(facts({ observationEpochMs: BASE_MS + 30_000 }));
    expect(verdict.status === "accepted" ? verdict.quality : undefined).toMatchObject({
      firstObservationEver: false,
      firstObservationOnSubscription: false,
      previousObservationAt: new Date(BASE_MS).toISOString(),
      sincePreviousObservationMs: 30_000,
      outOfOrder: false,
    });
  });

  it("opens no unobserved interval while the subscription is unchanged", () => {
    const subject = tracker();
    subject.remember(facts());
    const verdict = subject.judge(facts({ observationEpochMs: BASE_MS + 30_000 }));
    expect(
      verdict.status === "accepted" ? verdict.quality.unobservedInterval : "missing",
    ).toBeUndefined();
  });
});

describe("the first observation after a reconnect", () => {
  it("reports a MEASURED unobserved interval and never a missed-update count", () => {
    const subject = tracker();
    subject.remember(facts());
    const verdict = subject.judge(
      facts({ observationEpochMs: BASE_MS + 300_000, subscriptionGeneration: 2 }),
    );
    expect(verdict.status).toBe("accepted");
    if (verdict.status !== "accepted") return;
    expect(verdict.quality.firstObservationOnSubscription).toBe(true);
    expect(verdict.quality.firstObservationEver).toBe(false);
    expect(verdict.quality.unobservedInterval).toEqual({
      fromAt: new Date(BASE_MS).toISOString(),
      toAt: new Date(BASE_MS + 300_000).toISOString(),
      durationMs: 300_000,
      reasonCode: "RTDS_NO_REPLAY_AFTER_DISCONNECT",
      previousSubscriptionGeneration: 1,
    });
    // The interval is measured; how many updates fell inside it is unknown and
    // is not stated anywhere on the quality block.
    expect(JSON.stringify(verdict.quality)).not.toContain("missed");
  });

  it("omits the interval when the first post-reconnect observation is not newer", () => {
    const subject = tracker();
    subject.remember(facts({ observationEpochMs: BASE_MS + 60_000 }));
    const verdict = subject.judge(
      facts({ observationEpochMs: BASE_MS, subscriptionGeneration: 2 }),
    );
    expect(verdict.status).toBe("accepted");
    if (verdict.status !== "accepted") return;
    expect(verdict.quality.unobservedInterval).toBeUndefined();
    expect(verdict.quality.outOfOrder).toBe(true);
    expect(verdict.quality.sincePreviousObservationMs).toBe(-60_000);
  });
});

describe("duplicates and contradictions", () => {
  it("refuses an identical redelivery", () => {
    const subject = tracker();
    subject.remember(facts());
    expect(subject.judge(facts())).toEqual({
      status: "duplicate",
      previousObservationAt: new Date(BASE_MS).toISOString(),
    });
  });

  it("refuses a non-adjacent redelivery within the window", () => {
    const subject = tracker();
    subject.remember(facts());
    subject.remember(facts({ observationEpochMs: BASE_MS + 30_000 }));
    subject.remember(facts({ observationEpochMs: BASE_MS + 60_000 }));
    expect(subject.judge(facts()).status).toBe("duplicate");
  });

  it("distinguishes a contradiction from a redelivery", () => {
    const subject = tracker();
    subject.remember(facts());
    expect(subject.judge(facts({ value: "65000.6" }))).toEqual({
      status: "conflict",
      previousObservationAt: new Date(BASE_MS).toISOString(),
      previousValue: "65000.5",
    });
  });

  it("publishes a redelivery older than the bounded window as a late observation", () => {
    // The stated consequence of the bound, pinned so it cannot change silently.
    const subject = tracker({ duplicateWindow: 2 });
    subject.remember(facts());
    subject.remember(facts({ observationEpochMs: BASE_MS + 30_000 }));
    subject.remember(facts({ observationEpochMs: BASE_MS + 60_000 }));
    const verdict = subject.judge(facts());
    expect(verdict.status).toBe("accepted");
    expect(verdict.status === "accepted" ? verdict.quality.outOfOrder : false).toBe(true);
  });

  it("keeps series independent", () => {
    const subject = tracker();
    subject.remember(facts());
    expect(subject.judge(facts({ symbol: "eth/usd" })).status).toBe("accepted");
    expect(subject.judge(facts({ topic: "crypto_prices_twap_sixty" })).status).toBe("accepted");
    expect(subject.trackedSeries).toBe(1);
  });

  it("cannot confuse two series whose key parts abut", () => {
    // Length-prefixed keys: ("ab", "c") and ("a", "bc") must not collide.
    const subject = tracker();
    subject.remember(facts({ topic: "ab", symbol: "c" }));
    expect(subject.judge(facts({ topic: "a", symbol: "bc" })).status).toBe("accepted");
  });
});

describe("the tracked-series bound", () => {
  it("evicts the least recently updated series and counts the eviction", () => {
    const subject = tracker({ maxTrackedSeries: 2 });
    subject.remember(facts({ symbol: "a/usd" }));
    subject.remember(facts({ symbol: "b/usd" }));
    subject.remember(facts({ symbol: "c/usd" }));
    expect(subject.trackedSeries).toBe(2);
    expect(subject.evictedSeries).toBe(1);
    // The evicted series' next observation truthfully reports what this adapter
    // instance knows: nothing.
    const verdict = subject.judge(facts({ symbol: "a/usd" }));
    expect(verdict.status === "accepted" ? verdict.quality.firstObservationEver : false).toBe(
      true,
    );
  });

  it("keeps a series alive while it keeps updating", () => {
    const subject = tracker({ maxTrackedSeries: 2 });
    subject.remember(facts({ symbol: "a/usd" }));
    subject.remember(facts({ symbol: "b/usd" }));
    subject.remember(facts({ symbol: "a/usd", observationEpochMs: BASE_MS + 30_000 }));
    subject.remember(facts({ symbol: "c/usd" }));
    expect(subject.judge(facts({ symbol: "a/usd" })).status).toBe("duplicate");
  });
});
