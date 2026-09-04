/**
 * WP-160 acceptance 2: INPUT STALENESS IS INCLUDED — the age of every input
 * feed, and the active data-quality incident flags — inside the
 * content-addressed snapshot body, not beside it.
 */

import { describe, expect, it } from "vitest";

import { computeFeatureSnapshot } from "../../../packages/features/src/index.js";
import type { FeatureSnapshot } from "../../../packages/features/src/index.js";
import { validInput } from "./fixtures.js";

function computeOk(input: unknown): { snapshot: FeatureSnapshot; serialization: string } {
  const result = computeFeatureSnapshot(input);
  if (!result.ok) throw new Error(`expected success, got ${result.refusal.code}`);
  return { snapshot: result.snapshot, serialization: result.serialization };
}

function featureEntry(snapshot: FeatureSnapshot, id: string): FeatureSnapshot["features"][number] {
  const entry = snapshot.features.find((feature) => feature.id === id);
  if (entry === undefined) throw new Error(`no entry for ${id}`);
  return entry;
}

describe("acceptance 2: input staleness is included", () => {
  it("reports the age of EVERY supplied input feed, hand-computed, sorted by feedId", () => {
    const { snapshot } = computeOk(validInput());
    // asOf 12:00:00.000; book stamp 11:59:59.500 → 500ms; trades 11:59:58 →
    // 2000ms; binance 11:59:59.900 → 100ms; coinbase 11:59:59 → 1000ms;
    // chainlink 11:59:30 → 30000ms.
    expect(featureEntry(snapshot, "quality.input_feed_ages")).toMatchObject({
      status: "OK",
      value: [
        { feedId: "polymarket.book", ageMs: 500 },
        { feedId: "polymarket.trades", ageMs: 2_000 },
        { feedId: "reference.binance", ageMs: 100 },
        { feedId: "reference.chainlink", ageMs: 30_000 },
        { feedId: "reference.coinbase", ageMs: 1_000 },
      ],
    });
  });

  it("includes the active incident flags, sorted, inside the snapshot", () => {
    const { snapshot } = computeOk(validInput());
    expect(featureEntry(snapshot, "quality.active_incidents")).toMatchObject({
      status: "OK",
      value: [
        { incidentId: "inc-1", reasonCode: "STALE_FEED", severity: "NOTIFY" },
        { incidentId: "inc-2", reasonCode: "FEED_GAP", severity: "PAGE", feedId: "reference.binance" },
      ],
    });
  });

  it("staleness lives INSIDE the addressed content: an age change changes the address", () => {
    const base = computeOk(validInput());
    const staler = validInput();
    (staler["book"] as Record<string, unknown>)["lastEventAt"] = "2026-09-03T11:59:58.500Z";
    const changed = computeOk(staler);
    // The age itself moved…
    expect(featureEntry(changed.snapshot, "quality.input_feed_ages")).toMatchObject({
      value: [{ feedId: "polymarket.book", ageMs: 1_500 }, {}, {}, {}, {}],
    });
    // …and the serialized body carries it, so the address moved with it.
    expect(base.serialization).toContain('"ageMs":500');
    expect(changed.serialization).toContain('"ageMs":1500');
    expect(changed.snapshot.contentAddress).not.toBe(base.snapshot.contentAddress);
  });

  it("a feed that is not supplied has no fabricated age; its features are typed ABSENT", () => {
    const input = validInput();
    const reference = input["reference"] as Record<string, unknown>;
    delete reference["coinbase"];
    const { snapshot } = computeOk(input);
    const ages = featureEntry(snapshot, "quality.input_feed_ages");
    expect(ages.status).toBe("OK");
    const feedIds = (ages.value as { feedId: string }[]).map((age) => age.feedId);
    expect(feedIds).toEqual(["polymarket.book", "polymarket.trades", "reference.binance", "reference.chainlink"]);
    expect(featureEntry(snapshot, "reference.coinbase.return_1s")).toMatchObject({
      status: "ABSENT",
      reason: "INPUT_MISSING",
    });
    expect(featureEntry(snapshot, "reference.cross_venue.direction_agreement_1s")).toMatchObject({
      status: "ABSENT",
      reason: "INPUT_MISSING",
    });
  });

  it("a negative age (feed stamp ahead of the event's asOf) is reported as-is, never clamped", () => {
    const input = validInput();
    (input["book"] as Record<string, unknown>)["lastEventAt"] = "2026-09-03T12:00:00.250Z";
    const { snapshot } = computeOk(input);
    expect(featureEntry(snapshot, "quality.input_feed_ages")).toMatchObject({
      value: [{ feedId: "polymarket.book", ageMs: -250 }, {}, {}, {}, {}],
    });
  });

  it("no active incidents is an explicit empty answer, not an absent feature", () => {
    const input = validInput();
    (input["quality"] as Record<string, unknown>)["activeIncidents"] = [];
    const { snapshot } = computeOk(input);
    expect(featureEntry(snapshot, "quality.active_incidents")).toMatchObject({ status: "OK", value: [] });
  });
});
