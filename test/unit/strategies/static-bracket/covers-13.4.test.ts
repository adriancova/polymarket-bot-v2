/**
 * Coverage of handoff §13.4, proved mechanically.
 *
 * §13.4 lists twelve acceptance tests. This file reads those twelve bullets out
 * of the handoff and reads the `describe("§13.4 — …")` titles out of
 * `acceptance.test.ts`, and asserts the two lists are EQUAL as sets. A bullet
 * nobody implemented, a scenario whose name drifted from the spec, and a
 * thirteenth bullet added to §13.4 all fail here — which is the point: a
 * coverage claim that is a sentence in a handoff is not evidence.
 */

import { describe, expect, it } from "vitest";

import { handoffSection, readRepoFile } from "./handoff.js";

function specBullets(): string[] {
  const section = handoffSection("13.4 Acceptance tests");
  const bullets: string[] = [];
  for (const line of section.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("- ")) continue;
    bullets.push(trimmed.slice(2).replace(/\.$/u, "").trim());
  }
  return bullets;
}

function implementedScenarios(): string[] {
  const source = readRepoFile("test/unit/strategies/static-bracket/acceptance.test.ts");
  const titles: string[] = [];
  const pattern = /describe\("§13\.4 — ([^"]+)"/gu;
  let match = pattern.exec(source);
  while (match !== null) {
    titles.push((match[1] ?? "").trim());
    match = pattern.exec(source);
  }
  return titles;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim();
}

describe("§13.4 coverage", () => {
  it("finds exactly twelve bullets in the handoff", () => {
    expect(specBullets()).toHaveLength(12);
  });

  it("implements one named scenario per bullet, with no extras and no gaps", () => {
    const specified = specBullets().map(normalize).sort();
    const implemented = implementedScenarios().map(normalize).sort();
    expect(implemented).toEqual(specified);
  });

  it("names each scenario in the spec's own words", () => {
    // Set equality above already forces this; asserting the raw (unnormalized)
    // bullet text appears verbatim in the suite makes a drifting rename fail
    // with a readable message rather than a sorted-array diff.
    const source = readRepoFile("test/unit/strategies/static-bracket/acceptance.test.ts");
    for (const bullet of specBullets()) {
      expect(source, `§13.4 bullet "${bullet}" is not named by any scenario`).toContain(bullet);
    }
  });
});
