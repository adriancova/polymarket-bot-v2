/**
 * WP-310 acceptance 3: limits are configuration snapshots with a source and an
 * effective time, validated, never repaired, and selected by effective time.
 */

import { describe, expect, it } from "vitest";

import { parseRateLimitConfiguration, RateLimitConfigurationTimeline, type RateLimitConfiguration } from "./configuration.js";
import { T0, ZERO_HEADROOM, iso, snapshot, type SnapshotDoc } from "./fixtures.test-support.js";
import { parseIsoInstant } from "./plain-data.js";
import { MAX_DURATION_MS, MAX_TOKEN_MAGNITUDE } from "./units.js";

function parsed(document: unknown): RateLimitConfiguration {
  const result = parseRateLimitConfiguration(document);
  if (!result.ok) throw new Error(result.problems.join("\n"));
  return result.value;
}

function problems(document: unknown): readonly string[] {
  const result = parseRateLimitConfiguration(document);
  return result.ok ? [] : result.problems;
}

function edit(mutate: (document: SnapshotDoc) => void): SnapshotDoc {
  const document = JSON.parse(JSON.stringify(snapshot())) as SnapshotDoc;
  mutate(document);
  return document;
}

describe("parseRateLimitConfiguration", () => {
  it("accepts the synthetic snapshot, deeply frozen, with its source and effective time", () => {
    const config = parsed(snapshot());
    expect(config.snapshotId).toBe("synthetic-a");
    expect(config.effectiveFromMs).toBe(T0 - 60_000);
    expect(config.source.documents[0]?.url).toBe("https://example.invalid/synthetic");
    expect(Object.isFrozen(config) && Object.isFrozen(config.ipEndpointClasses[0]?.windows[0]) && Object.isFrozen(config.policy.headroomPermille)).toBe(true);
  });

  const cases: readonly [string, (document: SnapshotDoc) => void, RegExp][] = [
    ["an unknown top-level field", (d) => (d["extra"] = 1), /\$\.extra: is not a field/u],
    ["a missing source", (d) => delete d["source"], /\$\.source: is required/u],
    ["a wrong schema", (d) => (d["schema"] = "v0"), /\$\.schema/u],
    ["a non-ISO effective time", (d) => (d["effectiveFrom"] = "2026-10-01"), /\$\.effectiveFrom/u],
    ["an impossible date", (d) => (d["effectiveFrom"] = "2026-02-30T00:00:00Z"), /\$\.effectiveFrom/u],
    ["a fractional limit", (d) => (((d["ipEndpointClasses"] as SnapshotDoc[])[0]?.["windows"] as SnapshotDoc[])[0]!["limit"] = 1.5), /limit: must be an integer from 1 to /u],
    ["a zero window", (d) => (((d["ipEndpointClasses"] as SnapshotDoc[])[0]?.["windows"] as SnapshotDoc[])[0]!["windowMs"] = 0), /windowMs/u],
    ["a string rate", (d) => ((d["signerTiers"] as SnapshotDoc[])[0]!["orderTokensPerSecond"] = "40"), /orderTokensPerSecond/u],
    ["a duplicate class (case-insensitive)", (d) => (d["ipEndpointClasses"] as SnapshotDoc[]).push({ classId: "SHARED", windows: [{ limit: 1, windowMs: 1 }] }), /duplicate id SHARED/u],
    ["an undeclared class", (d) => ((d["operations"] as SnapshotDoc[])[0]!["ipEndpointClasses"] = ["nowhere"]), /must name a declared IP endpoint class/u],
    ["a cancel drawing on the order bucket", (d) => ((d["operations"] as SnapshotDoc[])[3]!["signerBucket"] = "ORDER"), /must be CANCEL for kind CANCEL/u],
    ["a read drawing on a signer bucket", (d) => ((d["operations"] as SnapshotDoc[])[6]!["signerBucket"] = "ORDER"), /must be null for kind READ/u],
    ["a relayer flag on a placement", (d) => ((d["operations"] as SnapshotDoc[])[1]!["relayer"] = true), /must be true exactly for kind RELAYER/u],
    ["a zero-cost placement", (d) => ((d["operations"] as SnapshotDoc[])[1]!["tokenCost"] = { base: 0, perEntry: 0, perCanceled: 0 }), /at least 1/u],
    ["a token cost on a read", (d) => ((d["operations"] as SnapshotDoc[])[6]!["tokenCost"] = { base: 1, perEntry: 0, perCanceled: 0 }), /must be null when there is no signer bucket/u],
    ["an unknown kind", (d) => ((d["operations"] as SnapshotDoc[])[0]!["kind"] = "PING"), /\.kind: must be/u],
    ["an assumed tier that is not declared", (d) => ((d["policy"] as SnapshotDoc)["assumedSignerTier"] = "Gold"), /assumedSignerTier: must name a declared signer tier/u],
    ["headroom that rises up the ladder", (d) => ((d["policy"] as SnapshotDoc)["headroomPermille"] = { ...ZERO_HEADROOM, ORDER_HEARTBEAT: 100 }), /EMERGENCY_CANCEL: must not be below/u],
    ["headroom of a whole budget", (d) => ((d["policy"] as SnapshotDoc)["headroomPermille"] = { ...ZERO_HEADROOM, METADATA_ANALYTICS: 1000 }), /must be below 1000/u],
    ["a headroom class missing", (d) => delete ((d["policy"] as SnapshotDoc)["headroomPermille"] as SnapshotDoc)["NEW_ORDER"], /NEW_ORDER: is required/u],
    ["a backoff that does not grow", (d) => ((d["policy"] as SnapshotDoc)["rateLimitedFallback"] = { initialMs: 1000, multiplier: 1, capMs: 2000 }), /multiplier: must exceed 1/u],
    ["a cap below the start", (d) => ((d["policy"] as SnapshotDoc)["rateLimitedFallback"] = { initialMs: 1000, multiplier: 2, capMs: 10 }), /capMs: must be at least initialMs/u],
    ["a non-https source", (d) => (((d["source"] as SnapshotDoc)["documents"] as SnapshotDoc[])[0]!["url"] = "http://example.invalid/"), /url: must be an https URL/u],
    ["no source documents", (d) => ((d["source"] as SnapshotDoc)["documents"] = []), /documents: must not be empty/u],
  ];

  it.each(cases)("refuses %s, naming the path", (_label, mutate, expected) => {
    const found = problems(edit(mutate));
    expect(found.join("\n")).toMatch(expected);
  });

  it("refuses a getter, a proxy and a non-object without throwing", () => {
    const document = snapshot();
    const getter = Object.defineProperty({ ...document }, "policy", { get: () => document["policy"], enumerable: true });
    expect(problems(getter).join()).toMatch(/\$\.policy: is not an own data field/u);
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    expect(problems(revocable.proxy).length).toBeGreaterThan(0);
    expect(problems(null)).toEqual(["$: must be a plain object of own data fields"]);
  });
});

describe("RateLimitConfigurationTimeline", () => {
  const a = parsed(snapshot());
  const b = parsed(snapshot({ snapshotId: "synthetic-b", effectiveFrom: iso(T0) }));

  it("selects the latest snapshot whose effective time is at or before the instant", () => {
    const timeline = RateLimitConfigurationTimeline.empty().with(b);
    expect(timeline.ok).toBe(true);
    if (!timeline.ok) return;
    const both = timeline.value.with(a);
    if (!both.ok) throw new Error(both.problem);
    expect(both.value.activeAt(T0 - 60_001)).toBeUndefined();
    expect(both.value.activeAt(T0 - 60_000)?.snapshotId).toBe("synthetic-a");
    expect(both.value.activeAt(T0 - 1)?.snapshotId).toBe("synthetic-a");
    expect(both.value.activeAt(T0)?.snapshotId).toBe("synthetic-b");
    expect(both.value.nextChangeAfter(T0 - 60_000)).toBe(T0);
    expect(both.value.nextChangeAfter(T0)).toBeUndefined();
  });

  it("refuses a duplicate id or a duplicate effective time", () => {
    const one = RateLimitConfigurationTimeline.empty().with(a);
    if (!one.ok) throw new Error(one.problem);
    expect(one.value.with(a).ok).toBe(false);
    expect(one.value.with(parsed(snapshot({ snapshotId: "other" }))).ok).toBe(false);
  });
});

describe("parseIsoInstant (no clock, no rollover)", () => {
  it("parses strict UTC instants and refuses calendar-invalid ones", () => {
    expect(parseIsoInstant("2026-09-30T05:12:03Z")).toBe(Date.UTC(2026, 8, 30, 5, 12, 3));
    expect(parseIsoInstant("2026-09-30T05:12:03.123Z")).toBe(Date.UTC(2026, 8, 30, 5, 12, 3, 123));
    expect(parseIsoInstant("2024-02-29T00:00:00Z")).toBe(Date.UTC(2024, 1, 29));
    for (const bad of ["2026-02-29T00:00:00Z", "2026-02-30T00:00:00Z", "2026-13-01T00:00:00Z", "2026-00-10T00:00:00Z", "2026-01-00T00:00:00Z", "2026-01-01T24:00:00Z", "2026-01-01T23:60:00Z", "2026-01-01T23:59:60Z", "0099-01-01T00:00:00Z", "2026-01-01T00:00:00+01:00", 1]) {
      expect(parseIsoInstant(bad), String(bad)).toBeUndefined();
    }
  });
});

describe("every configured figure keeps the budget's arithmetic exact (OP-R2-02)", () => {
  const ABOVE_TOKENS = [MAX_TOKEN_MAGNITUDE + 1, 1e13, Number.MAX_SAFE_INTEGER] as const;
  const ABOVE_DURATION = [MAX_DURATION_MS + 1, 1e13, Number.MAX_SAFE_INTEGER] as const;
  type Setter = (document: SnapshotDoc, value: number) => void;
  const firstWindow = (d: SnapshotDoc): SnapshotDoc => ((d["ipEndpointClasses"] as SnapshotDoc[])[0]?.["windows"] as SnapshotDoc[])[0]!;
  const placementCost = (d: SnapshotDoc): SnapshotDoc => (d["operations"] as SnapshotDoc[])[1]!["tokenCost"] as SnapshotDoc;
  const policy = (d: SnapshotDoc): SnapshotDoc => d["policy"] as SnapshotDoc;
  const backoff = (d: SnapshotDoc): SnapshotDoc => policy(d)["rateLimitedFallback"] as SnapshotDoc;

  const TOKEN_FIGURES: readonly (readonly [string, Setter])[] = [
    ["limit", (d, v) => (firstWindow(d)["limit"] = v)],
    ...(["orderTokensPerSecond", "orderBurst", "cancelTokensPerSecond", "cancelBurst"] as const).map(
      (field) => [field, (d: SnapshotDoc, v: number) => ((d["signerTiers"] as SnapshotDoc[])[0]![field] = v)] as const,
    ),
    ...(["base", "perEntry", "perCanceled"] as const).map((field) => [`tokenCost.${field}`, (d: SnapshotDoc, v: number) => (placementCost(d)[field] = v)] as const),
  ];
  const DURATIONS: readonly (readonly [string, Setter])[] = [
    ["windowMs", (d, v) => (firstWindow(d)["windowMs"] = v)],
    ["maxHeaderWaitMs", (d, v) => (policy(d)["maxHeaderWaitMs"] = v)],
    ["rateLimitedFallback.capMs", (d, v) => (backoff(d)["capMs"] = v)],
    [
      "rateLimitedFallback.initialMs",
      (d, v) => {
        backoff(d)["initialMs"] = v;
        backoff(d)["capMs"] = Math.max(v, MAX_DURATION_MS);
      },
    ],
  ];

  it.each(TOKEN_FIGURES)("a token figure (%s) above MAX_TOKEN_MAGNITUDE is refused, naming its path; at the bound it is accepted", (path, set) => {
    for (const value of ABOVE_TOKENS) {
      expect(problems(edit((d) => set(d, value))).join("\n"), String(value)).toContain(`${path}: must be an integer from`);
    }
    expect(problems(edit((d) => set(d, MAX_TOKEN_MAGNITUDE)))).toEqual([]);
  });

  it.each(DURATIONS)("a duration (%s) above MAX_DURATION_MS is refused, naming its path; at the bound it is accepted", (path, set) => {
    for (const value of ABOVE_DURATION) {
      expect(problems(edit((d) => set(d, value))).join("\n"), String(value)).toContain(`${path}: must be an integer from 1 to ${String(MAX_DURATION_MS)}`);
    }
    expect(problems(edit((d) => set(d, MAX_DURATION_MS)))).toEqual([]);
  });

  it("the bounds are derived from MAX_SAFE_INTEGER, not venue numbers", () => {
    expect(MAX_TOKEN_MAGNITUDE).toBe(Math.floor(Number.MAX_SAFE_INTEGER / 1_000_000));
    expect(MAX_DURATION_MS).toBe(Math.floor(Number.MAX_SAFE_INTEGER / 1_000_000));
  });
});
