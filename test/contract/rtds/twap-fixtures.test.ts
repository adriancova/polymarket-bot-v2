/**
 * Every RTDS fixture parses, and parses into the frozen domain contract.
 *
 * The frozen `WP-000` fixture is the authority for the wire shape; this suite
 * proves the adapter reads it, reads the exact value the way the page says to,
 * and produces a `ReferenceTwapObserved` its own contract accepts.
 */

import { ReferenceTwapObservedContract } from "@polymarket-bot/domain";
import {
  TwapObservationTracker,
  normalizeRtdsFrame,
  type RtdsNormalizationContext,
} from "@polymarket-bot/polymarket-public/rtds";
import { describe, expect, it } from "vitest";

import { frozenExample, loadFrozenTwapFixture, loadLocalFixture } from "./fixtures.js";

const BOTH_TOPICS = new Set(["crypto_prices_twap_thirty", "crypto_prices_twap_sixty"]);

function context(overrides: Partial<RtdsNormalizationContext> = {}): RtdsNormalizationContext {
  return {
    sourceChannel: "rtds:crypto-twap-ws",
    connectionId: "conn-1",
    subscriptionGeneration: 1,
    subscribedTopics: BOTH_TOPICS,
    receivedEpochMs: 1785178800500,
    tracker: new TwapObservationTracker({ duplicateWindow: 16, maxTrackedSeries: 16 }),
    ...overrides,
  };
}

describe("the frozen WP-000 fixture", () => {
  it("is the documentation-derived snapshot this adapter targets", () => {
    const fixture = loadFrozenTwapFixture();
    expect(fixture.source).toBe("https://docs.polymarket.com/market-data/chainlink-twap");
    expect(fixture.sanitized).toBe(true);
    expect(fixture.examples.map((example) => example.name)).toEqual([
      "subscribe-request",
      "subscribe-request-all-symbols-no-filters",
      "twap-update-30s",
      "twap-update-60s",
    ]);
  });

  it("normalizes its 30-second update into the frozen domain payload", () => {
    const { events, problems } = normalizeRtdsFrame([frozenExample("twap-update-30s")], context());
    expect(problems).toEqual([]);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toEqual({
      venue: "rtds",
      symbol: "btc/usd",
      feedId: "crypto_prices_twap_thirty",
      value: "65000.5",
      windowSeconds: 30,
      windowStartAt: "2026-07-27T18:59:30.000Z",
      windowEndAt: "2026-07-27T19:00:00.000Z",
    });
  });

  it("normalizes its 60-second update, with the window from its own topic", () => {
    const { events, problems } = normalizeRtdsFrame([frozenExample("twap-update-60s")], context());
    expect(problems).toEqual([]);
    expect(events[0]?.payload).toEqual({
      venue: "rtds",
      symbol: "eth/usd",
      feedId: "crypto_prices_twap_sixty",
      value: "3200.25",
      windowSeconds: 60,
      windowStartAt: "2026-07-27T19:00:00.000Z",
      windowEndAt: "2026-07-27T19:01:00.000Z",
    });
  });

  it("reads full_accuracy_value under the documented E18 scale", () => {
    // "full_accuracy_value is the exact signed E18 fixed-point value. Divide it
    // by 10^18" (accessed 2026-08-28). The fixture's own display value is the
    // cross-check: 65000500000000000000000 / 10^18 === 65000.5.
    const { events } = normalizeRtdsFrame([frozenExample("twap-update-30s")], context());
    expect(events[0]?.payload.value).toBe("65000.5");
    const raw = frozenExample("twap-update-30s") as { payload: { value: number } };
    expect(Number(events[0]?.payload.value)).toBe(raw.payload.value);
  });
});

describe("the derived stream fixtures", () => {
  const stream = loadLocalFixture("./fixtures/twap-stream.json");

  /** Fails loudly rather than normalizing `undefined` when a name is wrong. */
  function example(name: string): unknown {
    const found = stream.examples.find((entry) => entry.name === name);
    if (found === undefined) throw new Error(`no derived example named "${name}"`);
    return found.payload;
  }

  it("labels its own provenance as derived, not observed", () => {
    expect(stream.provenance).toContain("DERIVED FROM THE DOCUMENTED EXAMPLE");
    expect(stream.provenance).toContain("not observed on a live socket");
    for (const example of stream.examples) {
      expect(example.purpose.length).toBeGreaterThan(0);
    }
  });

  it("normalizes every example that is meant to normalize", () => {
    const shared = context();
    for (const example of stream.examples) {
      const { events, problems } = normalizeRtdsFrame([example.payload], shared);
      // Two of the examples are deliberate restatements of an earlier instant.
      if (example.name.includes("redelivered") || example.name.includes("contradicted")) {
        expect(events).toHaveLength(0);
        expect(problems).toHaveLength(1);
        continue;
      }
      expect(problems).toEqual([]);
      expect(events).toHaveLength(1);
      expect(
        ReferenceTwapObservedContract.payloadSchema.safeParse(events[0]?.payload).success,
      ).toBe(true);
    }
  });

  it("keeps a value no double can hold", () => {
    const { events } = normalizeRtdsFrame([example("thirty-btc-sub-wei-precision")], context());
    expect(events[0]?.payload.value).toBe("65000.500000000000000001");
    // The same digits through a JavaScript number collapse onto the display
    // value in the very same frame, which is exactly why ADR-001 §8.3 forbids
    // reading `value` and why the exact path is a string end to end.
    expect(Number("65000.500000000000000001")).toBe(65000.5);
  });

  it("accounts for every envelope of a batched frame exactly once", () => {
    const payloads = stream.examples.map((example) => example.payload);
    const { events, problems } = normalizeRtdsFrame(payloads, context());
    expect(events.length + problems.length).toBe(payloads.length);
    // Each outcome names the position of its own envelope in the frame.
    const indices = [
      ...events.map((event) => event.provenance.observedIndex),
      ...problems.map((problem) => problem.observedIndex),
    ].sort((a, b) => a - b);
    expect(indices).toEqual(payloads.map((_, index) => index));
  });

  it("keeps every series independent", () => {
    const shared = context();
    for (const name of ["thirty-btc-t0", "thirty-eth-t0", "sixty-eth-t0"]) {
      const { events, problems } = normalizeRtdsFrame([example(name)], shared);
      expect(problems).toEqual([]);
      expect(events).toHaveLength(1);
    }
  });
});
