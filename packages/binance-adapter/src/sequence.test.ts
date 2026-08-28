import { describe, expect, it } from "vitest";

import { bookTickerIdentity, SequenceTracker, tradeIdentity } from "./sequence.js";

describe("SequenceTracker", () => {
  it("reports the first observation on a key as FIRST", () => {
    const tracker = new SequenceTracker();
    expect(tracker.observe("btcusdt@trade", 10, "a").outcome).toBe("FIRST");
  });

  it("reports a strictly greater id as ADVANCED, with the step", () => {
    const tracker = new SequenceTracker();
    tracker.observe("btcusdt@trade", 10, "a");
    const observation = tracker.observe("btcusdt@trade", 14, "b");
    expect(observation.outcome).toBe("ADVANCED");
    expect(observation.previous).toBe(10);
    expect(observation.step).toBe(4);
  });

  it("reports a repeat with identical content as DUPLICATE", () => {
    const tracker = new SequenceTracker();
    tracker.observe("btcusdt@trade", 10, "same");
    expect(tracker.observe("btcusdt@trade", 10, "same").outcome).toBe("DUPLICATE");
  });

  it("reports a repeat with different content as CONFLICTING_DUPLICATE", () => {
    const tracker = new SequenceTracker();
    tracker.observe("btcusdt@trade", 10, "one");
    expect(tracker.observe("btcusdt@trade", 10, "two").outcome).toBe("CONFLICTING_DUPLICATE");
  });

  it("reports an UNSEEN lower id as REGRESSED with a negative step", () => {
    const tracker = new SequenceTracker();
    tracker.observe("btcusdt@trade", 10, "a");
    const observation = tracker.observe("btcusdt@trade", 7, "b");
    expect(observation.outcome).toBe("REGRESSED");
    expect(observation.step).toBe(-3);
    expect(observation.previouslySeen).toBe(false);
  });

  it("reports a DELAYED repeat as a duplicate, not as a late arrival (round-1 M2)", () => {
    // The schedule `100, 101, 100` used to classify the second `100` as
    // REGRESSED, because only the latest id was remembered — so the same venue
    // trade was published twice while `100, 100, 101` suppressed it. Whether a
    // frame is a duplicate is a property of the data, not of what arrived in
    // between.
    const tracker = new SequenceTracker();
    tracker.observe("k", 100, "same");
    tracker.observe("k", 101, "next");
    const delayed = tracker.observe("k", 100, "same");

    expect(delayed.outcome).toBe("DUPLICATE");
    expect(delayed.previouslySeen).toBe(true);
    expect(delayed.previous).toBe(101);
    expect(delayed.step).toBe(-1);
    // The highest id observed is unchanged by a repeat.
    expect(tracker.lastIdFor("k")).toBe(101);
  });

  it("reports a DELAYED repeat with different content as a conflict", () => {
    const tracker = new SequenceTracker();
    tracker.observe("k", 100, "one");
    tracker.observe("k", 101, "next");
    const delayed = tracker.observe("k", 100, "two");

    expect(delayed.outcome).toBe("CONFLICTING_DUPLICATE");
    expect(delayed.previouslySeen).toBe(true);
  });

  it("remembers a late arrival, so ITS repeat is a duplicate too", () => {
    const tracker = new SequenceTracker();
    tracker.observe("k", 10, "a");
    expect(tracker.observe("k", 7, "late").outcome).toBe("REGRESSED");
    expect(tracker.observe("k", 7, "late").outcome).toBe("DUPLICATE");
  });

  it("bounds the duplicate window per key, and says how wide it is", () => {
    const tracker = new SequenceTracker(4096, 3);
    for (const id of [1, 2, 3]) {
      tracker.observe("k", id, `v${String(id)}`);
    }
    expect(tracker.hasSeen("k", 1)).toBe(true);
    expect(tracker.snapshot()[0]?.recentIdsTracked).toBe(3);

    // A fourth id evicts the oldest: the window is a bound, not a promise.
    tracker.observe("k", 4, "v4");
    expect(tracker.hasSeen("k", 1)).toBe(false);
    expect(tracker.hasSeen("k", 2)).toBe(true);
    expect(tracker.snapshot()[0]?.recentIdsTracked).toBe(3);

    // The documented consequence, asserted rather than assumed: an id that has
    // fallen out of the window is no longer recognised as a repeat.
    const evicted = tracker.observe("k", 1, "v1");
    expect(evicted.outcome).toBe("REGRESSED");
    expect(evicted.previouslySeen).toBe(false);
  });

  it("keeps each key's window independent", () => {
    const tracker = new SequenceTracker(4096, 2);
    tracker.observe("btcusdt@trade", 1, "a");
    tracker.observe("ethusdt@trade", 10, "a");
    tracker.observe("ethusdt@trade", 11, "b");
    tracker.observe("ethusdt@trade", 12, "c");
    // A busy stream evicting its own ids must not evict a quiet stream's.
    expect(tracker.hasSeen("btcusdt@trade", 1)).toBe(true);
    expect(tracker.observe("btcusdt@trade", 1, "a").outcome).toBe("DUPLICATE");
  });

  it("does not advance its state on a duplicate or a regression", () => {
    const tracker = new SequenceTracker();
    tracker.observe("k", 10, "a");
    tracker.observe("k", 7, "b");
    tracker.observe("k", 10, "a");
    expect(tracker.lastIdFor("k")).toBe(10);
  });

  it("keeps keys independent", () => {
    const tracker = new SequenceTracker();
    tracker.observe("btcusdt@trade", 100, "a");
    expect(tracker.observe("ethusdt@trade", 5, "a").outcome).toBe("FIRST");
    expect(tracker.lastIdFor("btcusdt@trade")).toBe(100);
  });

  it("does not carry a jump into a gap claim — the step is reported, nothing more", () => {
    // BNC-U2 / BNC-U3: Binance does not document consecutive ids on these
    // streams, so a large step is data, never a `FeedGapDetected`.
    const tracker = new SequenceTracker();
    tracker.observe("k", 1, "a");
    const observation = tracker.observe("k", 1_000_000, "b");
    expect(observation.outcome).toBe("ADVANCED");
    expect(observation.step).toBe(999_999);
  });

  it("is bounded, and says so instead of growing without limit", () => {
    const tracker = new SequenceTracker(2);
    expect(tracker.observe("a", 1, "x").outcome).toBe("FIRST");
    expect(tracker.observe("b", 1, "x").outcome).toBe("FIRST");
    const overflow = tracker.observe("c", 1, "x");
    expect(overflow.outcome).toBe("UNTRACKED");
    expect(tracker.trackedKeys).toBe(2);
    expect(tracker.untrackedObservations).toBe(1);
  });

  it("rejects a non-positive bound", () => {
    expect(() => new SequenceTracker(0)).toThrow(RangeError);
    expect(() => new SequenceTracker(1.5)).toThrow(RangeError);
    expect(() => new SequenceTracker(4096, 0)).toThrow(RangeError);
    expect(() => new SequenceTracker(4096, 2.5)).toThrow(RangeError);
  });

  it("snapshots keys in a stable sorted order", () => {
    const tracker = new SequenceTracker();
    tracker.observe("z", 1, "x");
    tracker.observe("a", 2, "x");
    tracker.observe("a", 3, "y");
    expect(tracker.snapshot()).toEqual([
      { key: "a", lastId: 3, observations: 2, recentIdsTracked: 2 },
      { key: "z", lastId: 1, observations: 1, recentIdsTracked: 1 },
    ]);
  });
});

describe("content fingerprints", () => {
  it("distinguishes two trades that share an id but differ in price", () => {
    const base = { priceRaw: "1", quantityRaw: "2", tradeTimeEpoch: 3, buyerIsMaker: false };
    expect(tradeIdentity(base)).not.toBe(tradeIdentity({ ...base, priceRaw: "1.0" }));
  });

  it("uses the wire spelling, because the question is what the venue sent", () => {
    // `"1"` and `"1.0"` are the same VALUE but not the same FRAME; a repeat that
    // changed spelling is still a change the operator should see.
    const base = { priceRaw: "1", quantityRaw: "2", tradeTimeEpoch: 3, buyerIsMaker: false };
    expect(tradeIdentity({ ...base, priceRaw: "1.000" })).not.toBe(tradeIdentity(base));
  });

  it("covers every documented economic field of a bookTicker frame", () => {
    const base = {
      bidPriceRaw: "1",
      bidQuantityRaw: "2",
      askPriceRaw: "3",
      askQuantityRaw: "4",
    };
    for (const key of Object.keys(base) as (keyof typeof base)[]) {
      expect(bookTickerIdentity({ ...base, [key]: "9" })).not.toBe(bookTickerIdentity(base));
    }
  });
});
