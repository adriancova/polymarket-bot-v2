/**
 * `WP-080` deliverable 5: malformed and unknown inputs surface typed errors or
 * UNKNOWN classifications, never silent drops.
 *
 * The rule being enforced is ADR-002 §7 — "A runtime parser must treat an
 * unrecognized value as first-class UNKNOWN — routed to
 * `DataQualityIncidentOpened` and preserved raw — rather than assuming the
 * enumeration is exhaustive" — together with §8.3's prohibition on silent drops.
 */

import { decodeFrame } from "@polymarket-bot/binance-adapter";
import { describe, expect, it } from "vitest";

import { framesFixture, frameText } from "./fixtures.js";
import { createHarness, eventTypesOf, open } from "./support.js";

const FIXTURE = framesFixture("malformed-synthetic");

function drive(): {
  readonly harness: ReturnType<typeof createHarness>;
  readonly byLabel: Map<string, ReturnType<ReturnType<typeof createHarness>["feed"]["onFrame"]>>;
} {
  const harness = createHarness();
  open(harness, "conn-malformed");
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

describe("malformed and unknown frames", () => {
  it("never throws out of the feed, whatever the frame", () => {
    expect(() => drive()).not.toThrow();
  });

  it("returns a classification and the raw frame for every input", () => {
    const { byLabel } = drive();
    for (const frame of FIXTURE.frames) {
      const outcome = byLabel.get(frame.label);
      expect(outcome, frame.label).toBeDefined();
      expect(outcome?.classification, frame.label).toBe(frame.expectedClassification);
      expect(outcome?.decoded.raw, frame.label).toBe(frameText(frame));
    }
  });

  it("opens a data-quality incident the first time each condition appears", () => {
    const { harness } = drive();
    const reasons = harness.emissions
      .filter((emission) => emission.eventType === "DataQualityIncidentOpened")
      .map((emission) => (emission.payload as { reasonCode: string }).reasonCode);

    expect(reasons).toContain("BINANCE_FRAME_MALFORMED");
    expect(reasons).toContain("BINANCE_FRAME_UNKNOWN");
    expect(reasons).toContain("BINANCE_VALUE_UNREPRESENTABLE");
    expect(reasons).toContain("BINANCE_BOOK_SIDE_UNREPRESENTABLE");
    expect(reasons).toContain("BINANCE_FRAME_UNKNOWN_FIELDS");
  });

  it("preserves an excerpt of the offending frame on the incident", () => {
    const { harness } = drive();
    const malformed = harness.emissions.find(
      (emission) =>
        emission.eventType === "DataQualityIncidentOpened" &&
        (emission.payload as { reasonCode: string }).reasonCode === "BINANCE_FRAME_MALFORMED",
    );
    expect((malformed?.payload as { detail: string }).detail).toContain("PONG");
  });

  it("counts a repeat occurrence even when its incident is suppressed", () => {
    const { harness } = drive();
    const metrics = harness.feed.metrics(harness.clock.peek());
    const malformedFixtures = FIXTURE.frames.filter(
      (frame) => frame.expectedClassification === "MALFORMED",
    ).length;
    const unknownFixtures = FIXTURE.frames.filter(
      (frame) => frame.expectedClassification === "UNKNOWN",
    ).length;

    expect(malformedFixtures).toBeGreaterThan(1);
    expect(metrics.frames.malformedFrames).toBe(malformedFixtures);
    expect(metrics.frames.unknownFrames).toBe(unknownFixtures);
    // One incident per reason code per connection, but every occurrence counted.
    expect(metrics.connections.incidentsOpened).toBeLessThan(
      malformedFixtures + unknownFixtures,
    );
  });

  it("never publishes a domain event for a frame it could not understand", () => {
    const { byLabel } = drive();
    for (const frame of FIXTURE.frames) {
      if (!["MALFORMED", "UNKNOWN", "UNREPRESENTABLE"].includes(frame.expectedClassification)) {
        continue;
      }
      const emitted = eventTypesOf(byLabel.get(frame.label)?.emissions ?? []);
      expect(emitted, frame.label).not.toContain("ReferenceTradeObserved");
      expect(emitted, frame.label).not.toContain("ReferenceTopOfBookChanged");
    }
  });

  it("refuses a trade id JSON could only represent approximately (BNC-U6)", () => {
    const frame = FIXTURE.frames.find((entry) => entry.label === "trade-unsafe-integer-id");
    if (frame === undefined) {
      throw new Error("fixture frame missing");
    }
    const decoded = decodeFrame(frameText(frame));
    expect(decoded.kind).toBe("MALFORMED");

    // The point, demonstrated rather than asserted: the wire says one id and
    // `JSON.parse` produces a different one, so publishing the parsed value
    // would have recorded a WRONG `venueTradeId` that no later reader could
    // detect. (The comparison is made on the STRING form, because writing the
    // wire literal in TypeScript source would itself be rounded to the same
    // value and the two would compare equal.)
    const parsed = JSON.parse(frameText(frame)) as { t: number };
    expect(frameText(frame)).toContain("9007199254740993");
    expect(String(parsed.t)).toBe("9007199254740992");
  });

  it("emits the representable side of a half-empty book and records the omission", () => {
    const { byLabel, harness } = drive();
    const outcome = byLabel.get("book-ticker-empty-bid-side");
    expect(outcome?.classification).toBe("NORMALIZED");
    const emission = outcome?.emissions.find(
      (entry) => entry.eventType === "ReferenceTopOfBookChanged",
    );
    const payload = emission?.payload as Record<string, unknown>;
    expect("bidPrice" in payload).toBe(false);
    expect(payload["askPrice"]).toBe("25.3652");
    expect(harness.feed.metrics(harness.clock.peek()).frames.partialTopOfBook).toBe(1);
  });

  it("emits nothing at all when neither book side can cross the boundary", () => {
    const { byLabel } = drive();
    const outcome = byLabel.get("book-ticker-both-sides-empty");
    expect(outcome?.classification).toBe("UNREPRESENTABLE");
    expect(eventTypesOf(outcome?.emissions ?? [])).not.toContain("ReferenceTopOfBookChanged");
  });

  it("accepts a frame carrying an added venue field and reports the drift", () => {
    const { byLabel } = drive();
    const outcome = byLabel.get("book-ticker-with-added-venue-fields");
    expect(outcome?.classification).toBe("NORMALIZED");
    expect(outcome?.decoded.unknownFields).toEqual(["someFutureField"]);
  });
});
