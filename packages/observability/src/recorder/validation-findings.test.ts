import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  BOOK_COMPARISON_FINDING_CLASSES,
  DATASET_VALIDATION_FINDING_CLASSES,
  KNOWN_VALIDATION_FINDING_CLASSES,
} from "./validation-findings.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../..");
const validatorPath = resolve(repoRoot, "python/research/compaction/validate.py");

describe("the mirrored WP-130 validator finding classes", () => {
  it("cover every literal check class the Python validator can emit", () => {
    // The list in validation-findings.ts is a MIRROR of the Python source (a
    // TS module cannot import Python); this test is what keeps the mirror
    // honest. It extracts every `check="..."` literal, plus the dynamic
    // manifest-digest family, from the validator's actual source.
    const source = readFileSync(validatorPath, "utf8");
    const literal = new Set<string>();
    for (const match of source.matchAll(/check="(?<name>[a-z0-9-]+)"/gu)) {
      literal.add(match.groups?.["name"] ?? "");
    }
    expect(literal.size).toBeGreaterThan(30);
    for (const name of literal) {
      expect(
        DATASET_VALIDATION_FINDING_CLASSES,
        `Python validator class "${name}" is missing from DATASET_VALIDATION_FINDING_CLASSES`,
      ).toContain(name);
    }
    // The manifest-digest family is passed positionally rather than as a
    // `check=` keyword (validate.py section 1b), so it escapes the extraction
    // above; assert each full class literal is present in the source AND in
    // the mirror.
    for (const suffix of ["absent", "unreadable", "malformed", "mismatch"]) {
      const name = `manifest-digest-${suffix}`;
      expect(source).toContain(`"${name}"`);
      expect(DATASET_VALIDATION_FINDING_CLASSES).toContain(name);
    }
  });

  it("lists no class the Python validator cannot emit (no invented classes)", () => {
    const source = readFileSync(validatorPath, "utf8");
    for (const name of DATASET_VALIDATION_FINDING_CLASSES) {
      if (name.startsWith("manifest-digest-")) {
        continue; // dynamic family, asserted above
      }
      expect(source, `class "${name}" does not appear in the validator source`).toContain(
        `"${name}"`,
      );
    }
  });
});

describe("the combined class list", () => {
  it("is the union of both jobs' classes, without duplicates", () => {
    expect(KNOWN_VALIDATION_FINDING_CLASSES).toEqual([
      ...DATASET_VALIDATION_FINDING_CLASSES,
      ...BOOK_COMPARISON_FINDING_CLASSES,
    ]);
    expect(new Set(KNOWN_VALIDATION_FINDING_CLASSES).size).toBe(
      KNOWN_VALIDATION_FINDING_CLASSES.length,
    );
  });

  it("book-comparison classes match what book-comparison.ts can produce", async () => {
    const bookComparison = await import("./book-comparison.js");
    // The finding `check` union is a type, erased at runtime; produce each
    // class behaviorally instead so the list cannot drift from the code.
    const asset = "1234567890";
    const reports = [
      // book-frame-unparseable
      bookComparison.compareRecordedBooks([{ ingestSeq: "1", payloadUtf8: "{" }]),
      // book-level-grammar
      bookComparison.compareRecordedBooks([
        {
          ingestSeq: "1",
          payloadUtf8: JSON.stringify({
            event_type: "book",
            asset_id: asset,
            bids: [{ price: "0.4", size: "x" }],
            asks: [],
          }),
        },
      ]),
      // book-delta-before-snapshot
      bookComparison.compareRecordedBooks([
        {
          ingestSeq: "1",
          payloadUtf8: JSON.stringify({
            event_type: "price_change",
            price_changes: [{ asset_id: asset, price: "0.4", size: "1", side: "BUY" }],
          }),
        },
      ]),
      // book-divergence and book-crossed-reconstruction
      bookComparison.compareRecordedBooks([
        {
          ingestSeq: "1",
          payloadUtf8: JSON.stringify({
            event_type: "book",
            asset_id: asset,
            bids: [{ price: "0.7", size: "1" }],
            asks: [{ price: "0.6", size: "1" }],
          }),
        },
        {
          ingestSeq: "2",
          payloadUtf8: JSON.stringify({
            event_type: "book",
            asset_id: asset,
            bids: [],
            asks: [{ price: "0.6", size: "1" }],
          }),
        },
      ]),
    ];
    const produced = new Set(
      reports.flatMap((report) => report.findings.map((finding) => finding.check)),
    );
    for (const name of BOOK_COMPARISON_FINDING_CLASSES) {
      expect(produced, `class "${name}" was not produced behaviorally`).toContain(name);
    }
  });
});
