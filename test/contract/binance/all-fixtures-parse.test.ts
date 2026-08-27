/**
 * Every fixture parses, and every fixture is attributable.
 *
 * `WP-080` deliverable 5: "all fixtures parse". This file is the one that would
 * catch a fixture nobody exercises, a fixture whose provenance was never stated,
 * or a fixture whose expectations drifted from what the decoder does.
 */

import { BINANCE_FACTS_VERIFIED_AT, decodeFrame } from "@polymarket-bot/binance-adapter";
import { describe, expect, it } from "vitest";

import { frameText, loadAllFixtures } from "./fixtures.js";
import { createHarness, open } from "./support.js";

const FIXTURES = loadAllFixtures();

describe("fixture catalogue", () => {
  it("finds every fixture file and validates its shape", () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(5);
    for (const { file, fixture } of FIXTURES) {
      expect(fixture.fixtureId.length).toBeGreaterThan(0);
      expect(file).toContain(fixture.fixtureId);
    }
  });

  it("cites an official source with an access date for every fixture", () => {
    for (const { fixture } of FIXTURES) {
      expect(fixture.source.url).toMatch(
        /^https:\/\/(github\.com\/binance\/binance-spot-api-docs|developers\.binance\.com)/u,
      );
      // Tied to the package's own verification date rather than to a literal,
      // so the fixtures and the venue-fact module cannot drift apart: handoff
      // §1.2 requires venue facts to be re-verified each phase, and a
      // re-verification that updated one and not the other would be invisible.
      expect(fixture.source.accessedAt).toBe(BINANCE_FACTS_VERIFIED_AT);
      expect(fixture.notes.join(" ").length).toBeGreaterThan(50);
    }
  });

  it("labels every synthetic fixture as synthetic, in the file and on each frame", () => {
    for (const { fixture } of FIXTURES) {
      if (fixture.provenance !== "SYNTHETIC_DERIVED") {
        continue;
      }
      expect(fixture.notes.join(" ")).toMatch(/SYNTHETIC/u);
      if (fixture.kind === "frames") {
        for (const frame of fixture.frames) {
          expect(frame.provenance).toBe("SYNTHETIC_DERIVED");
        }
      }
    }
  });

  it("keeps a documented fixture free of synthetic frames", () => {
    for (const { fixture } of FIXTURES) {
      if (fixture.provenance !== "OFFICIAL_EXAMPLE" || fixture.kind !== "frames") {
        continue;
      }
      for (const frame of fixture.frames) {
        expect(frame.provenance).not.toBe("SYNTHETIC_DERIVED");
      }
    }
  });

  it("states the placeholder substitution wherever one was filled", () => {
    for (const { fixture } of FIXTURES) {
      if (fixture.kind !== "frames") {
        continue;
      }
      const filled = fixture.frames.filter(
        (frame) => frame.provenance === "OFFICIAL_EXAMPLE_WITH_PLACEHOLDER_FILLED",
      );
      if (filled.length === 0) {
        continue;
      }
      expect(fixture.notes.join(" ")).toMatch(/SYNTHETIC COMPLETION/u);
    }
  });
});

describe("every fixture frame decodes to the kind it claims", () => {
  for (const { file, fixture } of FIXTURES) {
    if (fixture.kind !== "frames") {
      continue;
    }
    for (const frame of fixture.frames) {
      it(`${file} :: ${frame.label}`, () => {
        const decoded = decodeFrame(frameText(frame));
        expect(decoded.kind).toBe(frame.expectedKind);
        // The raw frame survives every classification (§8.3).
        expect(decoded.raw).toBe(frameText(frame));
      });
    }
  }
});

describe("every fixture frame is classified as it claims when driven through the feed", () => {
  for (const { file, fixture } of FIXTURES) {
    if (fixture.kind !== "frames") {
      continue;
    }
    it(`${file}${fixture.sequential ? " (one stream, in order)" : " (independent examples)"}`, () => {
      // A `sequential` fixture is a transcript, so one feed sees the whole file;
      // a non-sequential one is a catalogue of independent examples, and driving
      // it through one feed would report the second copy of a documented payload
      // as a duplicate of the first.
      let harness = createHarness();
      open(harness, "conn-fixture");

      for (const frame of fixture.frames) {
        if (!fixture.sequential) {
          harness = createHarness();
          open(harness, "conn-fixture");
        }
        const outcome = harness.feed.onFrame(frameText(frame), harness.clock.advance(1));
        expect(
          { label: frame.label, classification: outcome.classification },
          `fixture frame ${frame.label}`,
        ).toEqual({ label: frame.label, classification: frame.expectedClassification });
        if (frame.expectedSequenceOutcome !== undefined) {
          expect(outcome.sequence?.outcome, `sequence outcome for ${frame.label}`).toBe(
            frame.expectedSequenceOutcome,
          );
        }
      }
    });
  }
});

describe("decoding is total", () => {
  it("never throws on any fixture frame, however malformed", () => {
    for (const { fixture } of FIXTURES) {
      if (fixture.kind !== "frames") {
        continue;
      }
      for (const frame of fixture.frames) {
        expect(() => decodeFrame(frameText(frame))).not.toThrow();
      }
    }
  });
});
