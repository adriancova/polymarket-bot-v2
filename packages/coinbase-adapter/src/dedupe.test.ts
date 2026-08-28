import type { ReferenceTopOfBookChangedPayload } from "@polymarket-bot/domain";
import { describe, expect, it } from "vitest";

import {
  CoinbaseTopOfBookTracker,
  CoinbaseTradeDeduplicator,
  DEFAULT_TRADE_DEDUPE_CAPACITY,
  fingerprintTopOfBook,
} from "./dedupe.js";

describe("CoinbaseTradeDeduplicator", () => {
  it("accepts a trade once", () => {
    const dedupe = new CoinbaseTradeDeduplicator();
    expect(dedupe.isKnown("ETH-USD", "t1")).toBe(false);
    dedupe.remember("ETH-USD", "t1");
    expect(dedupe.isKnown("ETH-USD", "t1")).toBe(true);
    expect(dedupe.size).toBe(1);
  });

  it("does not reserve an identity merely by asking about it", () => {
    // The whole reason the question and the record are separate calls: a caller
    // that asks and then FAILS to normalize the trade must leave the window
    // untouched, so the venue's corrected copy is still emitted.
    const dedupe = new CoinbaseTradeDeduplicator();
    expect(dedupe.isKnown("ETH-USD", "t1")).toBe(false);
    expect(dedupe.isKnown("ETH-USD", "t1")).toBe(false);
    expect(dedupe.size).toBe(0);
  });

  it("keys on the product as well as the trade id", () => {
    const dedupe = new CoinbaseTradeDeduplicator();
    dedupe.remember("ETH-USD", "t1");
    // Nothing documents that trade ids are unique across products, so assuming
    // it would silently discard a real trade on another market.
    expect(dedupe.isKnown("BTC-USD", "t1")).toBe(false);
  });

  it("cannot be confused by a key that spans the separator", () => {
    const dedupe = new CoinbaseTradeDeduplicator();
    dedupe.remember("A B", "C");
    expect(dedupe.isKnown("A", "B C")).toBe(false);
    expect(dedupe.isKnown("A B", "C")).toBe(true);
  });

  it("is bounded, evicting oldest first", () => {
    const dedupe = new CoinbaseTradeDeduplicator(2);
    dedupe.remember("P", "1");
    dedupe.remember("P", "2");
    expect(dedupe.size).toBe(2);
    dedupe.remember("P", "3");
    expect(dedupe.size).toBe(2);
    // "1" was evicted, so it is emitted again rather than suppressed. Emitting a
    // duplicate is visible downstream; suppressing a real trade is not.
    expect(dedupe.isKnown("P", "1")).toBe(false);
    expect(dedupe.isKnown("P", "3")).toBe(true);
  });

  it("does not move a known identity in the eviction order when remembered again", () => {
    const dedupe = new CoinbaseTradeDeduplicator(2);
    dedupe.remember("P", "1");
    dedupe.remember("P", "2");
    // A redelivered snapshot re-remembers "1"; that must not evict "2" or push
    // "1" to the back, or the window would stop being first-seen FIFO.
    dedupe.remember("P", "1");
    expect(dedupe.size).toBe(2);
    dedupe.remember("P", "3");
    expect(dedupe.isKnown("P", "1")).toBe(false);
    expect(dedupe.isKnown("P", "2")).toBe(true);
    expect(dedupe.isKnown("P", "3")).toBe(true);
  });

  it("refuses a capacity that is not a positive safe integer", () => {
    expect(() => new CoinbaseTradeDeduplicator(0)).toThrow(RangeError);
    expect(() => new CoinbaseTradeDeduplicator(-1)).toThrow(RangeError);
    expect(() => new CoinbaseTradeDeduplicator(1.5)).toThrow(RangeError);
    expect(() => new CoinbaseTradeDeduplicator(Number.NaN)).toThrow(RangeError);
  });

  it("has a bounded default", () => {
    expect(Number.isSafeInteger(DEFAULT_TRADE_DEDUPE_CAPACITY)).toBe(true);
    expect(DEFAULT_TRADE_DEDUPE_CAPACITY).toBeGreaterThan(0);
  });
});

function top(
  fields: Partial<ReferenceTopOfBookChangedPayload>,
): ReferenceTopOfBookChangedPayload {
  return { venue: "coinbase", symbol: "BTC-USD", ...fields };
}

describe("CoinbaseTopOfBookTracker", () => {
  it("reports the first observation per symbol as a change", () => {
    const tracker = new CoinbaseTopOfBookTracker();
    expect(tracker.observe("BTC-USD", top({ bidPrice: "1", askPrice: "2" }))).toBe("CHANGED");
    expect(tracker.observe("BTC-USD", top({ bidPrice: "1", askPrice: "2" }))).toBe("UNCHANGED");
  });

  it("tracks symbols independently", () => {
    const tracker = new CoinbaseTopOfBookTracker();
    tracker.observe("BTC-USD", top({ bidPrice: "1" }));
    expect(tracker.observe("ETH-USD", top({ bidPrice: "1" }))).toBe("CHANGED");
  });

  it("notices a change in any one of the four values", () => {
    const tracker = new CoinbaseTopOfBookTracker();
    const base = { bidPrice: "1", bidSize: "2", askPrice: "3", askSize: "4" } as const;
    tracker.observe("BTC-USD", top(base));
    expect(tracker.observe("BTC-USD", top({ ...base, bidSize: "2.5" }))).toBe("CHANGED");
    expect(tracker.observe("BTC-USD", top({ ...base, bidSize: "2.5" }))).toBe("UNCHANGED");
  });

  it("distinguishes an absent value from a present one", () => {
    const tracker = new CoinbaseTopOfBookTracker();
    tracker.observe("BTC-USD", top({ bidPrice: "1", askPrice: "2" }));
    // Losing the ask entirely is a change, not the same top of book.
    expect(tracker.observe("BTC-USD", top({ bidPrice: "1" }))).toBe("CHANGED");
  });

  it("republishes after a new generation, even when nothing moved", () => {
    const tracker = new CoinbaseTopOfBookTracker();
    tracker.observe("BTC-USD", top({ bidPrice: "1" }));
    tracker.newGeneration();
    expect(tracker.observe("BTC-USD", top({ bidPrice: "1" }))).toBe("CHANGED");
  });
});

describe("fingerprintTopOfBook", () => {
  it("is stable, and different for different values", () => {
    const a = fingerprintTopOfBook(top({ bidPrice: "1", askPrice: "2" }));
    expect(fingerprintTopOfBook(top({ bidPrice: "1", askPrice: "2" }))).toBe(a);
    expect(fingerprintTopOfBook(top({ bidPrice: "1", askPrice: "3" }))).not.toBe(a);
  });

  it("does not collide when fields shift position", () => {
    expect(fingerprintTopOfBook(top({ bidPrice: "1" }))).not.toBe(
      fingerprintTopOfBook(top({ bidSize: "1" })),
    );
    expect(fingerprintTopOfBook(top({ askPrice: "1" }))).not.toBe(
      fingerprintTopOfBook(top({ askSize: "1" })),
    );
  });
});
