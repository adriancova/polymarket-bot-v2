/**
 * `CADENCE-1` — `infra/prometheus/trader-alerts.yaml` against the platform
 * family table, the way `recorder/infra-consistency.test.ts` holds the
 * recorder's rules to the recorder exporter.
 *
 * Pinned: every `trader_*` / `control_*` series an alert reads is a declared
 * `PLATFORM_METRIC_FAMILIES` entry (a rule on a renamed family would never
 * fire); the declared alert names are EXACTLY the expected set, both
 * directions; the ADR-026 D2.10 forward-jump alarm PAGES, on the family the
 * trader's `cadenceForwardJumpAlarms` counter is rendered as; and the scrape
 * fragment wires the file.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { platformMetricFamily } from "./metric-families.js";
import { traderHealthSamples } from "./samples.js";
import { fullTraderHealthReport } from "./testing.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const alertsSource = readFileSync(resolve(repoRoot, "infra/prometheus/trader-alerts.yaml"), "utf8");
const scrapeSource = readFileSync(resolve(repoRoot, "infra/prometheus/control-api-scrape.yaml"), "utf8");

/** The source with every whole-line comment removed: a series named only in prose binds nothing. */
const rules = alertsSource
  .split("\n")
  .filter((line) => !/^\s*#/u.test(line))
  .join("\n");

const EXPECTED_ALERTS = ["TraderCadenceForwardJump"];

/** One alert's block: from its `- alert:` line to the next one, or the end. */
function alertBlock(name: string): string {
  const match = new RegExp(`- alert: ${name}\\n[\\s\\S]*?(?=\\n\\s*- alert: |$)`, "u").exec(rules);
  return match?.[0] ?? "";
}

describe("infra/prometheus/trader-alerts.yaml", () => {
  it("declares exactly the expected alerts, both directions", () => {
    const declared = [...rules.matchAll(/^\s*-\s*alert:\s*(?<name>\S+)\s*$/gmu)].map((match) => match.groups?.["name"]);
    expect(declared.sort()).toEqual([...EXPECTED_ALERTS].sort());
  });

  it("reads only declared platform families", () => {
    const series = [...rules.matchAll(/\b(?<name>(?:trader|control)_[a-z0-9_]+)\b/gu)].map((match) => match.groups?.["name"] ?? "");
    expect(series.length).toBeGreaterThan(0);
    for (const name of series) {
      expect(platformMetricFamily(name), `${name} is not a declared platform family`).toBeDefined();
    }
  });

  it("ADR-026 D2.10: the forward-jump alarm PAGES on the counter the trader's health report carries", () => {
    const block = alertBlock("TraderCadenceForwardJump");
    expect(block).toContain("expr: increase(trader_cadence_forward_jump_alarms_total[5m]) > 0");
    expect(block).toContain("severity: page");
    expect(block).toContain("for: 0m");
    // The family is rendered from the report's `loop.cadenceForwardJumpAlarms` (fixture value 113).
    const sample = traderHealthSamples(fullTraderHealthReport()).find(
      (entry) => entry.name === "trader_cadence_forward_jump_alarms_total",
    );
    expect(sample?.value).toBe(113);
    expect(platformMetricFamily("trader_cadence_forward_jump_alarms_total")?.type).toBe("counter");
  });

  it("is wired into the control-api scrape fragment's rule_files", () => {
    expect(scrapeSource).toMatch(/^rule_files:\n {2}- "trader-alerts\.yaml"$/mu);
  });
});
