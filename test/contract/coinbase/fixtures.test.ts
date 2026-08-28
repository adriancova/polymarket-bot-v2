/**
 * Every fixture parses, and every fixture says where it came from.
 *
 * This is the acceptance criterion "all fixtures parse", plus the rule that
 * makes the catalogue trustworthy: a fixture with no citation, or a
 * "documented" fixture that quietly changed a value, fails here rather than
 * silently becoming evidence for something Coinbase never said.
 */

import { describe, expect, it } from "vitest";

import { classifyFrame, COINBASE_DOC_CITATIONS } from "@polymarket-bot/coinbase-adapter";

import { FIXTURES, frameText } from "./fixtures.js";

describe("the fixture catalogue", () => {
  it("is not empty and has unique ids", () => {
    expect(FIXTURES.length).toBeGreaterThan(10);
    const ids = FIXTURES.map((fixture) => fixture.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("cites an official Coinbase page, with an access date, for every fixture", () => {
    for (const fixture of FIXTURES) {
      expect(fixture.provenance.source, fixture.id).toMatch(/^https:\/\/docs\.cdp\.coinbase\.com\//u);
      expect(fixture.provenance.accessedAt, fixture.id).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
      expect(fixture.provenance.section.length, fixture.id).toBeGreaterThan(0);
    }
  });

  it("cites only pages the package's own citation list also uses", () => {
    const citedHosts = new Set(
      COINBASE_DOC_CITATIONS.map((citation) => new URL(citation.url).pathname.split("/")[1]),
    );
    for (const fixture of FIXTURES) {
      const area = new URL(fixture.provenance.source).pathname.split("/")[1];
      expect(citedHosts.has(area ?? ""), `${fixture.id} cites an unrelated docs area`).toBe(true);
    }
  });

  it("resolves every basedOn to another fixture", () => {
    const ids = new Set(FIXTURES.map((fixture) => fixture.id));
    for (const fixture of FIXTURES) {
      const basedOn = fixture.provenance.basedOn;
      if (typeof basedOn === "string") {
        expect(ids.has(basedOn), `${fixture.id} is based on a fixture that does not exist`).toBe(
          true,
        );
      }
    }
  });

  it("labels every synthetic fixture and lists what it changed", () => {
    const synthetic = FIXTURES.filter(
      (fixture) => fixture.provenance.kind === "SYNTHETIC_COMPLETION",
    );
    expect(synthetic.length).toBeGreaterThan(0);
    for (const fixture of synthetic) {
      expect(fixture.provenance.modifications.length, fixture.id).toBeGreaterThan(0);
    }
  });

  it("keeps at least four fixtures byte-faithful to a documented example", () => {
    const documented = FIXTURES.filter(
      (fixture) => fixture.provenance.kind === "DOCUMENTED_EXAMPLE",
    );
    expect(documented.map((fixture) => fixture.id).sort()).toEqual([
      "candles-unhandled-channel",
      "heartbeats",
      "market-trades-snapshot",
      "ticker-snapshot",
    ]);
  });

  it("classifies every fixture into the arm the catalogue declares", () => {
    for (const fixture of FIXTURES) {
      const classified = classifyFrame(frameText(fixture.id));
      expect(classified.kind, fixture.id).toBe(fixture.classification);
    }
  });

  it("covers every classification arm at least once", () => {
    const covered = new Set(FIXTURES.map((fixture) => fixture.classification));
    expect([...covered].sort()).toEqual([
      "CONTROL",
      "HEARTBEATS",
      "MARKET_TRADES",
      "REJECTED",
      "TICKER",
      "UNKNOWN_CHANNEL",
    ]);
  });

  it("preserves the raw text on every rejected fixture", () => {
    const rejected = FIXTURES.filter((fixture) => fixture.classification === "REJECTED");
    expect(rejected.length).toBeGreaterThan(0);
    for (const fixture of rejected) {
      const classified = classifyFrame(frameText(fixture.id));
      if (classified.kind !== "REJECTED") {
        throw new Error(`${fixture.id} was expected to be rejected`);
      }
      expect(classified.text, fixture.id).toBe(frameText(fixture.id));
    }
  });
});
