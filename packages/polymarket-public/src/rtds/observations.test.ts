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

  it("carries no unavailability record when it measured the interval", () => {
    const subject = tracker();
    subject.remember(facts());
    const verdict = subject.judge(
      facts({ observationEpochMs: BASE_MS + 300_000, subscriptionGeneration: 2 }),
    );
    expect(
      verdict.status === "accepted" ? verdict.quality.unobservedIntervalUnavailable : "missing",
    ).toBeUndefined();
  });
});

describe("a first post-reconnect observation that is NOT newer (round-1 finding M2)", () => {
  /**
   * The pre-gap newest is T+60s and the first observation of generation 2 is T,
   * so the two cannot bound an interval — `fromAt` would be after `toAt`. The
   * earlier design reported `unobservedInterval: undefined` here AND recorded
   * generation 2, so no later observation could ever carry the interval either:
   * the gap obligation was consumed and nothing was ever said about it.
   */
  function regressed() {
    const subject = tracker();
    subject.remember(facts({ observationEpochMs: BASE_MS + 60_000 }));
    const first = facts({ observationEpochMs: BASE_MS, subscriptionGeneration: 2 });
    const verdict = subject.judge(first);
    subject.remember(first);
    return { subject, verdict };
  }

  it("says so in a typed record instead of reporting nothing", () => {
    const { verdict } = regressed();
    expect(verdict.status).toBe("accepted");
    if (verdict.status !== "accepted") return;
    expect(verdict.quality.firstObservationOnSubscription).toBe(true);
    expect(verdict.quality.outOfOrder).toBe(true);
    expect(verdict.quality.sincePreviousObservationMs).toBe(-60_000);
    // No interval can be MEASURED from this observation …
    expect(verdict.quality.unobservedInterval).toBeUndefined();
    // … and the gap is stated rather than dropped.
    expect(verdict.quality.unobservedIntervalUnavailable).toEqual({
      fromAt: new Date(BASE_MS + 60_000).toISOString(),
      reasonCode: "RTDS_NO_OBSERVATION_NEWER_THAN_GAP",
      previousSubscriptionGeneration: 1,
    });
  });

  it("does NOT consume the obligation: the first newer observation pays it", () => {
    const { subject } = regressed();
    const verdict = subject.judge(
      facts({ observationEpochMs: BASE_MS + 90_000, subscriptionGeneration: 2 }),
    );
    expect(verdict.status).toBe("accepted");
    if (verdict.status !== "accepted") return;
    // It is not the first observation of the subscription — that one already
    // arrived, and this adapter does not restate history to make a field fit.
    expect(verdict.quality.firstObservationOnSubscription).toBe(false);
    expect(verdict.quality.unobservedIntervalUnavailable).toBeUndefined();
    expect(verdict.quality.unobservedInterval).toEqual({
      fromAt: new Date(BASE_MS + 60_000).toISOString(),
      toAt: new Date(BASE_MS + 90_000).toISOString(),
      durationMs: 30_000,
      reasonCode: "RTDS_NO_REPLAY_AFTER_DISCONNECT",
      previousSubscriptionGeneration: 1,
    });
  });

  it("discharges the obligation exactly once", () => {
    const { subject } = regressed();
    const paying = facts({ observationEpochMs: BASE_MS + 90_000, subscriptionGeneration: 2 });
    subject.remember(paying);
    const verdict = subject.judge(
      facts({ observationEpochMs: BASE_MS + 120_000, subscriptionGeneration: 2 }),
    );
    expect(verdict.status).toBe("accepted");
    if (verdict.status !== "accepted") return;
    expect(verdict.quality.unobservedInterval).toBeUndefined();
    expect(verdict.quality.unobservedIntervalUnavailable).toBeUndefined();
  });

  it("keeps saying the gap is unmeasured while nothing newer arrives", () => {
    const { subject } = regressed();
    const stillOlder = facts({ observationEpochMs: BASE_MS + 30_000, subscriptionGeneration: 2 });
    const verdict = subject.judge(stillOlder);
    expect(verdict.status).toBe("accepted");
    if (verdict.status !== "accepted") return;
    expect(verdict.quality.firstObservationOnSubscription).toBe(false);
    expect(verdict.quality.unobservedIntervalUnavailable).toEqual({
      fromAt: new Date(BASE_MS + 60_000).toISOString(),
      reasonCode: "RTDS_NO_OBSERVATION_NEWER_THAN_GAP",
      previousSubscriptionGeneration: 1,
    });
  });

  it("keeps the OLDER bound when a further reconnect happens first", () => {
    // Two breaks, one still unmeasured: the interval reported must span the
    // whole unobserved stretch, from the last observation before the FIRST
    // break, not a shorter suffix of it.
    const { subject } = regressed();
    const verdict = subject.judge(
      facts({ observationEpochMs: BASE_MS + 200_000, subscriptionGeneration: 3 }),
    );
    expect(verdict.status).toBe("accepted");
    if (verdict.status !== "accepted") return;
    expect(verdict.quality.firstObservationOnSubscription).toBe(true);
    expect(verdict.quality.unobservedInterval).toEqual({
      fromAt: new Date(BASE_MS + 60_000).toISOString(),
      toAt: new Date(BASE_MS + 200_000).toISOString(),
      durationMs: 140_000,
      reasonCode: "RTDS_NO_REPLAY_AFTER_DISCONNECT",
      previousSubscriptionGeneration: 1,
    });
  });

  it("names the generation whose stream actually ended, not a later restatement", () => {
    // The outstanding record is authoritative about the bound, and it must be:
    // a later subscription can restate an instant this feed already had (a
    // redelivery older than the bounded duplicate window is republished rather
    // than suppressed), which moves the "newest observation's generation"
    // forward without moving the observation. The unmeasured break still began
    // when generation 1's stream ended.
    const subject = tracker({ duplicateWindow: 1 });
    subject.remember(facts({ observationEpochMs: BASE_MS + 60_000 }));
    subject.remember(facts({ observationEpochMs: BASE_MS, subscriptionGeneration: 2 }));
    // Outside the one-entry duplicate window, so this is a late observation,
    // not a suppressed duplicate — and it re-stamps the newest instant with
    // generation 2.
    const restated = facts({
      observationEpochMs: BASE_MS + 60_000,
      subscriptionGeneration: 2,
      value: "65000.5",
    });
    expect(subject.judge(restated).status).toBe("accepted");
    subject.remember(restated);

    const verdict = subject.judge(
      facts({ observationEpochMs: BASE_MS + 90_000, subscriptionGeneration: 3 }),
    );
    expect(verdict.status === "accepted" ? verdict.quality.unobservedInterval : undefined).toEqual({
      fromAt: new Date(BASE_MS + 60_000).toISOString(),
      toAt: new Date(BASE_MS + 90_000).toISOString(),
      durationMs: 30_000,
      reasonCode: "RTDS_NO_REPLAY_AFTER_DISCONNECT",
      previousSubscriptionGeneration: 1,
    });
  });

  it("never states both an interval and its unavailability", () => {
    // Mechanical guard over the whole ordering space of one break.
    const offsets = [-60_000, -1, 0, 1, 30_000, 300_000];
    for (const first of offsets) {
      for (const second of offsets) {
        const subject = tracker({ duplicateWindow: 1 });
        subject.remember(facts({ observationEpochMs: BASE_MS }));
        for (const [index, offset] of [first, second].entries()) {
          const next = facts({
            observationEpochMs: BASE_MS + offset,
            subscriptionGeneration: 2 + index,
          });
          const verdict = subject.judge(next);
          if (verdict.status !== "accepted") continue;
          const measured = verdict.quality.unobservedInterval;
          const unavailable = verdict.quality.unobservedIntervalUnavailable;
          expect(measured === undefined || unavailable === undefined).toBe(true);
          if (measured !== undefined) expect(measured.durationMs).toBeGreaterThan(0);
          subject.remember(next);
        }
      }
    }
  });

  it("still opens no gap at all while the subscription is unchanged", () => {
    // The obligation exists only across a generation transition; an ordinary
    // out-of-order arrival on one subscription is not a gap.
    const subject = tracker();
    subject.remember(facts({ observationEpochMs: BASE_MS + 60_000 }));
    const verdict = subject.judge(facts({ observationEpochMs: BASE_MS }));
    expect(verdict.status).toBe("accepted");
    if (verdict.status !== "accepted") return;
    expect(verdict.quality.outOfOrder).toBe(true);
    expect(verdict.quality.unobservedInterval).toBeUndefined();
    expect(verdict.quality.unobservedIntervalUnavailable).toBeUndefined();
  });

  it("holds the obligation for an observation that was judged but never published", () => {
    // `judge` records nothing, so a regressed first observation refused at the
    // domain boundary leaves the series exactly as it was: the NEXT first
    // observation of that subscription still measures the interval.
    const subject = tracker();
    subject.remember(facts({ observationEpochMs: BASE_MS + 60_000 }));
    subject.judge(facts({ observationEpochMs: BASE_MS, subscriptionGeneration: 2 }));
    const verdict = subject.judge(
      facts({ observationEpochMs: BASE_MS + 90_000, subscriptionGeneration: 2 }),
    );
    expect(verdict.status === "accepted" ? verdict.quality : undefined).toMatchObject({
      firstObservationOnSubscription: true,
      unobservedInterval: {
        fromAt: new Date(BASE_MS + 60_000).toISOString(),
        toAt: new Date(BASE_MS + 90_000).toISOString(),
        durationMs: 30_000,
        previousSubscriptionGeneration: 1,
      },
    });
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
