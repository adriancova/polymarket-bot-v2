/**
 * Every venue fact the emergency CLI acts on is cited, and its quote appears
 * verbatim (whitespace-normalized) in its dated report (handoff §1.2; the
 * WP-310 and WP-320 convention).
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { MAX_CANCEL_IDS_PER_REQUEST } from "@polymarket-bot/polymarket-secure";
import { describe, expect, it } from "vitest";

import { REPO_ROOT } from "./harness.test-support.js";
import { EMERGENCY_VENUE_FACTS } from "./venue-facts.js";

const normalize = (text: string): string => text.replace(/\s+/gu, " ");

describe("cited emergency venue facts", () => {
  for (const fact of Object.values(EMERGENCY_VENUE_FACTS)) {
    it(`${fact.id} is quoted verbatim from ${fact.source} ${fact.section}`, () => {
      expect(fact.source).toMatch(/^docs\/venue\/verified-\d{4}-\d{2}-\d{2}\.md$/u);
      expect(normalize(readFileSync(path.join(REPO_ROOT, fact.source), "utf8"))).toContain(normalize(fact.quote));
    });
  }

  it("the batch-cancel bound acted on is the lower of the two official limits (C-11), WP-260's constant", () => {
    expect(EMERGENCY_VENUE_FACTS.BATCH_CANCEL_LIMIT.quote).toContain("Use the lower (≤ 1,000) until resolved");
    expect(MAX_CANCEL_IDS_PER_REQUEST).toBe(1000);
  });

  it("NON-VACUOUS: a quote that is not in its source is caught", () => {
    expect(normalize(readFileSync(path.join(REPO_ROOT, "docs/venue/verified-2026-09-30.md"), "utf8"))).not.toContain("Use the higher (≤ 3,000) until resolved");
  });
});
