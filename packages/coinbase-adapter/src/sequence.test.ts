import { describe, expect, it } from "vitest";

import { CoinbaseCounterTracker } from "./sequence.js";

describe("CoinbaseCounterTracker", () => {
  it("treats the first value as a baseline, whatever it is", () => {
    const tracker = new CoinbaseCounterTracker();
    expect(tracker.previous).toBeUndefined();
    expect(tracker.observe(0)).toEqual({ kind: "FIRST", received: 0 });
    expect(tracker.previous).toBe(0);

    const later = new CoinbaseCounterTracker();
    expect(later.observe(9_001)).toEqual({ kind: "FIRST", received: 9_001 });
  });

  it("accepts exactly-one increments", () => {
    const tracker = new CoinbaseCounterTracker();
    tracker.observe(4);
    expect(tracker.observe(5)).toEqual({ kind: "IN_ORDER", received: 5 });
    expect(tracker.observe(6)).toEqual({ kind: "IN_ORDER", received: 6 });
  });

  it("reports a forward jump as a gap, with the count of missing values", () => {
    const tracker = new CoinbaseCounterTracker();
    tracker.observe(4);
    expect(tracker.observe(7)).toEqual({
      kind: "GAP",
      expected: 5,
      received: 7,
      missing: 2,
    });
    // The baseline moves to the received value, so the next in-order message is
    // in order rather than a second, phantom gap.
    expect(tracker.observe(8)).toEqual({ kind: "IN_ORDER", received: 8 });
  });

  it("reports a repeat and a backward step without moving the baseline", () => {
    const tracker = new CoinbaseCounterTracker();
    tracker.observe(4);
    tracker.observe(5);
    expect(tracker.observe(5)).toEqual({ kind: "REGRESSED", previous: 5, received: 5 });
    expect(tracker.observe(2)).toEqual({ kind: "REGRESSED", previous: 5, received: 2 });
    expect(tracker.previous).toBe(5);
    // Accepting a regressed value would have made this look like a gap of two.
    expect(tracker.observe(6)).toEqual({ kind: "IN_ORDER", received: 6 });
  });

  it("forgets the baseline on reset, because the counter is per connection", () => {
    const tracker = new CoinbaseCounterTracker();
    tracker.observe(5_000);
    tracker.reset();
    expect(tracker.previous).toBeUndefined();
    // A new connection restarting at 0 must not read as a gigantic regression.
    expect(tracker.observe(0)).toEqual({ kind: "FIRST", received: 0 });
  });

  it("never reports a negative number of missing values", () => {
    const tracker = new CoinbaseCounterTracker();
    tracker.observe(0);
    const observation = tracker.observe(1_000);
    expect(observation.kind).toBe("GAP");
    if (observation.kind === "GAP") {
      expect(observation.missing).toBe(999);
      expect(observation.missing).toBeGreaterThanOrEqual(0);
    }
  });
});
