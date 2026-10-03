/**
 * WP-270: every venue fact the OMS acts on is cited, and its quote appears
 * verbatim (whitespace-normalized) in the cited dated report. A behaviour no
 * row supports is refused, never assumed ("cite it or refuse").
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { MAX_ORDERS_PER_BATCH, VENUE_FACTS } from "../../../packages/oms/src/index.js";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const normalize = (text: string): string => text.replace(/\s+/gu, " ");

describe("cited venue facts", () => {
  for (const fact of Object.values(VENUE_FACTS)) {
    it(`${fact.id} is quoted verbatim from ${fact.source} ${fact.section}`, () => {
      expect(fact.source).toMatch(/^docs\/venue\/verified-\d{4}-\d{2}-\d{2}\.md$/u);
      const report = normalize(readFileSync(resolve(repoRoot, fact.source), "utf8"));
      expect(report).toContain(normalize(fact.quote));
    });
  }

  it("the batch limit constant is the cited one", () => {
    expect(VENUE_FACTS.BATCH_LIMIT.quote).toContain(`1–${String(MAX_ORDERS_PER_BATCH)}`);
  });
});
