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

  it("reports a lower id as REGRESSED with a negative step", () => {
    const tracker = new SequenceTracker();
    tracker.observe("btcusdt@trade", 10, "a");
    const observation = tracker.observe("btcusdt@trade", 7, "b");
    expect(observation.outcome).toBe("REGRESSED");
    expect(observation.step).toBe(-3);
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
  });

  it("snapshots keys in a stable sorted order", () => {
    const tracker = new SequenceTracker();
    tracker.observe("z", 1, "x");
    tracker.observe("a", 2, "x");
    tracker.observe("a", 3, "y");
    expect(tracker.snapshot()).toEqual([
      { key: "a", lastId: 3, observations: 2 },
      { key: "z", lastId: 1, observations: 1 },
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
