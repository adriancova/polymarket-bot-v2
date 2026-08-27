/**
 * `WP-080` acceptance 1 (first half): duplicate fixtures are handled.
 *
 * "Handled" is stronger than "ignored". §8.3 forbids dropping a raw market event
 * silently, so a duplicate must be (a) not re-published as a second trade or a
 * second top-of-book state, (b) returned to the caller with a classification,
 * and (c) counted. This file asserts all three, and asserts the two cases that
 * are NOT ordinary duplicates: a same-id-different-content conflict, and a late
 * arrival — which is published for a trade and suppressed for a quote, because
 * one is a point observation and the other is versioned state.
 */

import { describe, expect, it } from "vitest";

import { framesFixture, frameText } from "./fixtures.js";
import { createHarness, eventTypesOf, open } from "./support.js";

const FIXTURE = framesFixture("duplicates-synthetic");

function driveFixture(): {
  readonly harness: ReturnType<typeof createHarness>;
  readonly byLabel: Map<string, ReturnType<ReturnType<typeof createHarness>["feed"]["onFrame"]>>;
} {
  const harness = createHarness();
  open(harness, "conn-duplicates");
  const byLabel = new Map<
    string,
    ReturnType<ReturnType<typeof createHarness>["feed"]["onFrame"]>
  >();
  for (const frame of FIXTURE.frames) {
    const outcome = harness.feed.onFrame(frameText(frame), harness.clock.advance(1));
    harness.emissions.push(...outcome.emissions);
    byLabel.set(frame.label, outcome);
  }
  return { harness, byLabel };
}

describe("duplicate handling", () => {
  it("publishes the first observation of a trade", () => {
    const { byLabel } = driveFixture();
    const outcome = byLabel.get("trade-first");
    expect(outcome?.classification).toBe("NORMALIZED");
    expect(eventTypesOf(outcome?.emissions ?? [])).toEqual(["ReferenceTradeObserved"]);
  });

  it("does not republish an exact repeat of a trade", () => {
    const { byLabel } = driveFixture();
    const outcome = byLabel.get("trade-exact-repeat");
    expect(outcome?.classification).toBe("DUPLICATE_SUPPRESSED");
    expect(outcome?.emissions).toEqual([]);
    // Not a silent drop: the caller receives the decoded frame and the reason.
    expect(outcome?.decoded.kind).toBe("TRADE");
    expect(outcome?.sequence?.outcome).toBe("DUPLICATE");
  });

  it("does not republish an exact repeat of a top-of-book quote", () => {
    const { byLabel } = driveFixture();
    const outcome = byLabel.get("book-ticker-exact-repeat");
    expect(outcome?.classification).toBe("DUPLICATE_SUPPRESSED");
    expect(outcome?.emissions).toEqual([]);
  });

  it("opens an incident when the venue reuses an id with different content", () => {
    const { byLabel, harness } = driveFixture();
    for (const label of ["trade-same-id-different-price", "book-ticker-same-id-different-quote"]) {
      const outcome = byLabel.get(label);
      expect(outcome?.classification, label).toBe("CONFLICTING_DUPLICATE");
      // A contradiction is never published as if it were a new observation.
      expect(eventTypesOf(outcome?.emissions ?? []), label).not.toContain(
        "ReferenceTradeObserved",
      );
      expect(eventTypesOf(outcome?.emissions ?? []), label).not.toContain(
        "ReferenceTopOfBookChanged",
      );
    }

    // The FIRST conflict opens the incident; the second is deduplicated against
    // it (one incident per reason code per connection) and is still classified
    // and counted, which is what keeps the suppression from being a silent drop.
    const first = byLabel.get("trade-same-id-different-price");
    expect(eventTypesOf(first?.emissions ?? [])).toEqual(["DataQualityIncidentOpened"]);
    expect(
      (first?.emissions[0]?.payload as { reasonCode: string } | undefined)?.reasonCode,
    ).toBe("BINANCE_SEQUENCE_CONFLICT");
    expect(byLabel.get("book-ticker-same-id-different-quote")?.emissions).toEqual([]);
    expect(harness.feed.metrics(harness.clock.peek()).frames.conflictingDuplicates).toBe(2);
  });

  it("publishes a LATE trade, because a trade that happened still happened", () => {
    const { byLabel } = driveFixture();
    const outcome = byLabel.get("trade-late-arrival");
    expect(outcome?.classification).toBe("NORMALIZED");
    expect(outcome?.sequence?.outcome).toBe("REGRESSED");
    expect(eventTypesOf(outcome?.emissions ?? [])).toEqual(["ReferenceTradeObserved"]);
  });

  it("suppresses a STALE quote, because applying it would overwrite newer state", () => {
    const { byLabel } = driveFixture();
    const outcome = byLabel.get("book-ticker-stale-update");
    expect(outcome?.classification).toBe("STALE_SUPPRESSED");
    expect(outcome?.emissions).toEqual([]);
  });

  it("counts every suppression, so nothing disappears without a number", () => {
    const { harness } = driveFixture();
    const metrics = harness.feed.metrics(harness.clock.peek());
    expect(metrics.frames.framesReceived).toBe(FIXTURE.frames.length);
    expect(metrics.frames.duplicatesSuppressed).toBe(2);
    expect(metrics.frames.staleUpdatesSuppressed).toBe(1);
    expect(metrics.frames.conflictingDuplicates).toBe(2);
    expect(metrics.frames.lateTradesEmitted).toBe(1);
    // Three trades published (first, advance, late) and two quotes (first, advance).
    expect(metrics.frames.tradesNormalized).toBe(3);
    expect(metrics.frames.topOfBookNormalized).toBe(2);
    expect(metrics.frames.eventsEmitted).toBe(5);
  });

  it("keeps the per-stream sequence at the highest id observed", () => {
    const { harness } = driveFixture();
    const metrics = harness.feed.metrics(harness.clock.peek());
    const byStream = new Map(metrics.streams.map((entry) => [entry.streamName, entry]));
    expect(byStream.get("bnbbtc@trade")?.lastVenueSequenceId).toBe(12_346);
    expect(byStream.get("bnbusdt@bookTicker")?.lastVenueSequenceId).toBe(400_900_218);
  });

  it("never emits two events carrying the same venue trade id", () => {
    const { harness } = driveFixture();
    const tradeIds = harness.emissions
      .filter((emission) => emission.eventType === "ReferenceTradeObserved")
      .map((emission) => (emission.payload as { venueTradeId?: string }).venueTradeId);
    expect(new Set(tradeIds).size).toBe(tradeIds.length);
  });
});
