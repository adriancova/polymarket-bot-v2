/**
 * The series seeds under `db/seeds/settlement-specs/series/**` are validated
 * here.
 *
 * TEST-ONLY FILE ACCESS: this is the only module in this package that touches
 * the filesystem, and it is a test. The package's production code performs no
 * I/O; the seeds are data a composition root loads, and reading them is the
 * only way to prove they are still valid and still unapproved.
 *
 * The property that matters is negative: NO series seed may claim an approved
 * binding. §9.2 forbids auto-approving a new market pattern for live trading,
 * and a seed that shipped `binding.approved: true` would do exactly that, on
 * every environment that loads it.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { registerSeries, createUniverseRegistry } from "./registry.js";
import { SeriesDefinitionSchema } from "./series.js";

const SERIES_SEED_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../db/seeds/settlement-specs/series",
);

const seriesFiles = readdirSync(SERIES_SEED_DIR)
  .filter((entry) => entry.endsWith(".json"))
  .sort()
  .map((entry) => path.join(SERIES_SEED_DIR, entry));

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

describe("series seeds", () => {
  it("ships at least one example series", () => {
    expect(seriesFiles.length).toBeGreaterThan(0);
  });

  it.each(seriesFiles)("%s is marked EXAMPLE_UNREVIEWED", (file) => {
    const seed = readJson(file);
    expect(seed["seedFormatVersion"]).toBe(1);
    expect(seed["status"]).toBe("EXAMPLE_UNREVIEWED");
  });

  it.each(seriesFiles)("%s is a valid series definition", (file) => {
    const parsed = SeriesDefinitionSchema.safeParse(readJson(file)["series"]);
    expect(parsed.success ? [] : parsed.error.issues.map((issue) => issue.message)).toEqual([]);
  });

  it.each(seriesFiles)("%s approves nothing", (file) => {
    const parsed = SeriesDefinitionSchema.safeParse(readJson(file)["series"]);
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }
    expect(parsed.data.binding).toEqual({ approved: false });
    expect(parsed.data.activeSettlementSpecId).toBeUndefined();

    // Checked over the raw text too, so an approver hidden in a block this test
    // does not read still fails.
    const text = readFileSync(file, "utf8");
    for (const forbidden of ["approvedBy", "approved_by", "approvedAt", "approved_at"]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it.each(seriesFiles)("%s loads into a registry", (file) => {
    const result = registerSeries(createUniverseRegistry(), readJson(file)["series"]);
    expect(result.ok).toBe(true);
  });
});
