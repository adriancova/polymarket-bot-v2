/**
 * WP-310 acceptance 3 for the restricted-mode durations: they are snapshot
 * data with a source and an effective time, validated and never repaired.
 */

import { describe, expect, it } from "vitest";

import { parseIsoInstant, parseRestrictedModeConfiguration, RestrictedModeTimeline, type RestrictedModeConfiguration } from "./configuration.js";
import { T0, modeSnapshot, type Doc } from "./fixtures.test-support.js";

function parsed(document: unknown): RestrictedModeConfiguration {
  const result = parseRestrictedModeConfiguration(document);
  if (!result.ok) throw new Error(result.problems.join("\n"));
  return result.value;
}

function problems(document: unknown): string {
  const result = parseRestrictedModeConfiguration(document);
  return result.ok ? "" : result.problems.join("\n");
}

describe("parseRestrictedModeConfiguration", () => {
  it("accepts the synthetic snapshot, frozen, with its source and effective time", () => {
    const config = parsed(modeSnapshot());
    expect(config).toMatchObject({ snapshotId: "synthetic-modes-a", effectiveFromMs: T0 - 60_000, postOnlyWindowMs: 5000 });
    expect(config.source.documents).toHaveLength(1);
    expect(Object.isFrozen(config) && Object.isFrozen(config.restartBackoff) && Object.isFrozen(config.source.documents)).toBe(true);
  });

  const cases: readonly [string, Doc, RegExp][] = [
    ["an unknown field", { extra: true }, /\$\.extra: is not a field/u],
    ["a wrong schema", { schema: "x" }, /\$\.schema/u],
    ["a zero window", { postOnlyWindowMs: 0 }, /postOnlyWindowMs/u],
    ["a fractional window", { postOnlyWindowMs: 1.5 }, /postOnlyWindowMs/u],
    ["a backoff that does not grow", { restartBackoff: { initialMs: 100, multiplier: 1, capMs: 1000 } }, /restartBackoff\.multiplier: must exceed 1/u],
    ["a cap below the start", { tradingUnavailableBackoff: { initialMs: 100, multiplier: 2, capMs: 10 } }, /tradingUnavailableBackoff\.capMs/u],
    ["a missing backoff field", { restartBackoff: { initialMs: 100, multiplier: 2 } }, /restartBackoff\.capMs: is required/u],
    ["an impossible effective date", { effectiveFrom: "2026-09-31T00:00:00Z" }, /\$\.effectiveFrom/u],
    ["no source documents", { source: { documents: [], report: "r", policyAuthority: "p" } }, /\$\.source\.documents/u],
    ["a non-https source", { source: { documents: [{ url: "ftp://x", retrievedAt: "2026-09-30T00:00:00Z" }], report: "r", policyAuthority: "p" } }, /url: must be an https URL/u],
  ];

  it.each(cases)("refuses %s, naming the path", (_label, overrides, expected) => {
    expect(problems(modeSnapshot(overrides))).toMatch(expected);
  });

  it("refuses a getter and a non-object without throwing", () => {
    const getter = Object.defineProperty(modeSnapshot(), "postOnlyWindowMs", { get: () => 5000, enumerable: true });
    expect(problems(getter)).toMatch(/postOnlyWindowMs: is not an own data field/u);
    expect(problems(undefined)).toMatch(/\$: must be a plain object/u);
  });
});

describe("RestrictedModeTimeline", () => {
  it("selects by effective time and refuses duplicates", () => {
    const a = parsed(modeSnapshot());
    const b = parsed(modeSnapshot({ snapshotId: "b", effectiveFrom: "2026-10-01T00:00:00Z" }));
    const one = RestrictedModeTimeline.empty().with(b);
    if (!one.ok) throw new Error(one.problem);
    const two = one.value.with(a);
    if (!two.ok) throw new Error(two.problem);
    expect(two.value.activeAt(T0 - 60_001)).toBeUndefined();
    expect(two.value.activeAt(T0 - 1)?.snapshotId).toBe("synthetic-modes-a");
    expect(two.value.activeAt(T0)?.snapshotId).toBe("b");
    expect(two.value.with(a).ok).toBe(false);
    expect(two.value.with(parsed(modeSnapshot({ snapshotId: "c" }))).ok).toBe(false);
  });

  it("parses ISO instants without a clock and without rollover", () => {
    expect(parseIsoInstant("2026-10-01T00:00:00Z")).toBe(T0);
    expect(parseIsoInstant("2026-10-01T00:00:00.250Z")).toBe(T0 + 250);
    for (const bad of ["2026-09-31T00:00:00Z", "2026-10-01T24:00:00Z", "2026-10-01", "0050-01-01T00:00:00Z"]) expect(parseIsoInstant(bad), bad).toBeUndefined();
  });
});
