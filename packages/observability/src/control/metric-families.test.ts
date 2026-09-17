/**
 * Pins the platform metric-family table to its PRODUCER.
 *
 * The failure this suite exists to prevent is a family in the table that
 * nothing emits — a name a dashboard can bind to and that will read blank
 * forever, which on an operator surface is indistinguishable from "the system
 * is quiet". So the table and `samples.ts` are asserted to cover each other
 * EXACTLY, in both directions, against samples built from fully-populated
 * inputs.
 */

import { describe, expect, it } from "vitest";

import {
  PLATFORM_METRIC_FAMILIES,
  platformMetricFamily,
  platformMetricNames,
  platformMetricNamesByCategory,
} from "./metric-families.js";
import { controlPlaneSamples, traderHealthSamples } from "./samples.js";
import { fullControlPlaneInput, fullTraderHealthReport } from "./testing.js";

const names = platformMetricNames();

describe("PLATFORM_METRIC_FAMILIES", () => {
  it("declares unique, prefixed, convention-following names", () => {
    expect(new Set(names).size).toBe(names.length);
    for (const family of PLATFORM_METRIC_FAMILIES) {
      expect(family.name, `${family.name} must be trader_* or control_*`).toMatch(
        /^(?:trader|control)_[a-z0-9_]+$/u,
      );
      if (family.type === "counter") {
        expect(family.name, `${family.name} is a counter`).toMatch(/_total$/u);
      } else {
        expect(family.name, `${family.name} is a gauge`).not.toMatch(/_total$/u);
      }
      expect(family.help.length, `${family.name} needs help text`).toBeGreaterThan(20);
    }
  });

  it("gives every `_info` family the infoOnly marker and at least one label", () => {
    for (const family of PLATFORM_METRIC_FAMILIES) {
      if (family.name.endsWith("_info")) {
        expect(family.infoOnly, `${family.name}`).toBe(true);
        expect((family.labels ?? []).length, `${family.name}`).toBeGreaterThan(0);
      }
      if (family.infoOnly === true) {
        expect((family.labels ?? []).length, `${family.name}`).toBeGreaterThan(0);
      }
    }
  });

  it("carries NO family whose value would be an economic decimal (§6 invariant 1)", () => {
    // An economics-bearing family would have to name an amount. The exact
    // decimals this surface carries travel as `_info` labels, and the four
    // families that do so are named here so a fifth one cannot appear quietly
    // (`TRDR-3` added the two realized-PnL families to `WP-240`'s two).
    const decimalBearing = PLATFORM_METRIC_FAMILIES.filter((family) =>
      (family.labels ?? []).includes("exact_decimal"),
    ).map((family) => family.name);
    expect(decimalBearing).toEqual([
      "trader_realized_pnl_info",
      "trader_account_realized_pnl_info",
      "trader_seam_reservations_reserved_collateral_info",
      "trader_seam_allocator_reserved_collateral_info",
    ]);
    for (const name of decimalBearing) {
      expect(platformMetricFamily(name)?.infoOnly).toBe(true);
    }
    for (const family of PLATFORM_METRIC_FAMILIES) {
      expect(family.name, "no family may name a bare economic amount").not.toMatch(
        /_(?:price|notional|collateral|balance|pnl|fee)$/u,
      );
    }
  });

  it("looks a family up by name, and answers undefined for one it does not have", () => {
    expect(platformMetricFamily("trader_healthy")?.category).toBe("halts");
    expect(platformMetricFamily("trader_not_a_family")).toBeUndefined();
  });

  it("partitions every family into exactly one category", () => {
    const categories = [
      "run-mode",
      "halts",
      "queues",
      "loop",
      "risk",
      "execution",
      "accounting",
      "seams",
      "control-plane",
      "audit",
    ] as const;
    const seen = categories.flatMap((category) => [...platformMetricNamesByCategory(category)]);
    expect(seen.slice().sort()).toEqual([...names].sort());
    for (const category of categories) {
      expect(platformMetricNamesByCategory(category).length, category).toBeGreaterThan(0);
    }
  });
});

describe("every declared family has a producer, and every producer a declaration", () => {
  const produced = new Set([
    ...traderHealthSamples(fullTraderHealthReport()).map((sample) => sample.name),
    ...controlPlaneSamples(fullControlPlaneInput()).map((sample) => sample.name),
  ]);

  it("emits EVERY declared family from a fully populated snapshot", () => {
    const unproduced = names.filter((name) => !produced.has(name));
    expect(unproduced, "families with no producer in samples.ts").toEqual([]);
  });

  it("emits NOTHING that the table does not declare", () => {
    const undeclared = [...produced].filter((name) => platformMetricFamily(name) === undefined);
    expect(undeclared, "samples emitted for families with no table row").toEqual([]);
  });

  it("declares every label any producer actually emits", () => {
    for (const sample of [
      ...traderHealthSamples(fullTraderHealthReport()),
      ...controlPlaneSamples(fullControlPlaneInput()),
    ]) {
      const family = platformMetricFamily(sample.name);
      expect(family, sample.name).toBeDefined();
      for (const key of Object.keys(sample.labels ?? {})) {
        expect(family?.labels ?? [], `${sample.name} label ${key}`).toContain(key);
      }
    }
  });
});
