/**
 * The seed files under `db/seeds/settlement-specs/**` are validated here.
 *
 * TEST-ONLY FILE ACCESS: this is the single module in this package that touches
 * the filesystem, and it is a test. The package's production code performs no
 * I/O of any kind (see `index.ts`); the seeds are data the composition root
 * loads, and the only way to prove they are still valid — and still unreviewed
 * — is to read them.
 *
 * The property that matters most is negative: NO seed may claim a human review.
 * A seed carrying `verified_by` would silently unblock model-dependent
 * activation for a series nobody reviewed, which is the exact failure §9.2 and
 * ADR-009 §1 exist to prevent.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { classifySettlementActivation } from "./activation.js";
import { SettlementSpecSchema } from "./spec.js";

const SEED_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../db/seeds/settlement-specs",
);

function seedFiles(subdirectory: string): readonly string[] {
  return readdirSync(path.join(SEED_ROOT, subdirectory))
    .filter((entry) => entry.endsWith(".json"))
    .sort()
    .map((entry) => path.join(SEED_ROOT, subdirectory, entry));
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

const specFiles = seedFiles("specs");
const seriesFiles = seedFiles("series");
const allFiles = [...specFiles, ...seriesFiles];

describe("settlement-spec seeds", () => {
  it("ships at least one example series and one example spec", () => {
    expect(specFiles.length).toBeGreaterThan(0);
    expect(seriesFiles.length).toBeGreaterThan(0);
  });

  it.each(allFiles)("%s is marked EXAMPLE_UNREVIEWED", (file) => {
    const seed = readJson(file);
    expect(seed["seedFormatVersion"]).toBe(1);
    expect(seed["status"]).toBe("EXAMPLE_UNREVIEWED");
    expect(String(seed["notice"]).length).toBeGreaterThan(40);
  });

  it.each(allFiles)("%s claims no human review", (file) => {
    // Checked over the RAW TEXT, not the parsed object: a reviewer field nested
    // anywhere — including in a comment-shaped key or a future block this test
    // does not know about — must fail this assertion.
    const text = readFileSync(file, "utf8");
    for (const forbidden of ["verifiedBy", "verified_by", "verifiedAt", "verified_at"]) {
      expect(text).not.toContain(forbidden);
    }
    expect(text).not.toContain("\"VERIFIED\"");
  });

  it.each(specFiles)("%s is a valid, unverified settlement spec", (file) => {
    const seed = readJson(file);
    const parsed = SettlementSpecSchema.safeParse(seed["settlementSpec"]);
    expect(parsed.success ? [] : parsed.error.issues.map((issue) => issue.message)).toEqual([]);
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }
    expect(parsed.data.verification).toEqual({ status: "UNVERIFIED" });
  });

  it.each(specFiles)("%s blocks model-dependent activation", (file) => {
    const seed = readJson(file);
    const verdict = classifySettlementActivation({ spec: seed["settlementSpec"] });
    expect(verdict.modelDependentActivationAllowed).toBe(false);
    expect(verdict.status).toBe("SPEC_UNVERIFIED");
  });

  it.each(specFiles)("%s names a series that exists in the seeds", (file) => {
    const seriesIds = new Set(
      seriesFiles.map((seriesFile) => {
        const series = readJson(seriesFile)["series"] as Record<string, unknown>;
        return series["seriesId"];
      }),
    );
    const spec = readJson(file)["settlementSpec"] as Record<string, unknown>;
    expect(seriesIds.has(spec["seriesId"])).toBe(true);
  });

  it.each(seriesFiles)("%s approves no series binding", (file) => {
    const series = readJson(file)["series"] as Record<string, unknown>;
    expect(series["binding"]).toEqual({ approved: false });
    expect(series["activeSettlementSpecId"]).toBeUndefined();
  });
});
