/**
 * `V2-1` (ADR-030 Amendment 2 rule 2, item 4: "Both copies of the review
 * schema carry it, so the gateway's and the trader's hashes stay equal"): the
 * trader's MIRROR of the reviewed series carries `parameters.acceptedProtocolVersions`
 * exactly as the gateway's `@polymarket-bot/universe` copy does.
 *
 * This package may not import `universe`, so agreement is pinned through
 * shared values: the two sample-review hashes below are the ones
 * `packages/universe/src/series-admission-v2.test.ts` pins for the gateway's
 * copy, and the refusal text is the gateway's word for word. The paper-trader
 * suite's `rollover-1-series-mirror.test.ts` compares the two implementations
 * directly. The configuration door's refusal is pinned in `config.test.ts`.
 */

import { describe, expect, it } from "vitest";

import { ACCEPTED_PROTOCOL_VERSIONS_REQUIRED, PROTOCOL_VERSIONS, ReviewedSeriesSchema, seriesConfigHash } from "./series.js";
import { reviewedSeriesDocument } from "./testing/series.js";

/** The gateway's pinned hashes of the same sample review (`@polymarket-bot/universe`'s `series-admission-v2.test.ts`). */
const SAMPLE_REVIEW_HASH_V1 = "27a746ce86cb3329920762611f47e7557a188a4a545ad991b0594333a7fcb759";
const SAMPLE_REVIEW_HASH_V1_V2 = "f833fbbca4aaf9c15f0025c041f80471f49aabff0b0979224c4e11518d2beb97";

/** The gateway's refusal text (`@polymarket-bot/universe` `ACCEPTED_PROTOCOL_VERSIONS_REQUIRED`), restated to pin the mirror. */
const GATEWAY_REFUSAL =
  'acceptedProtocolVersions is required: a non-empty list of distinct protocol versions, each "v1" or "v2" ' +
  '(ADR-030 Amendment 2 rule 2; e.g. ["v1"], or ["v1","v2"] once a review accepts V2 windows). It is never inferred';

function withAccepted(accepted: unknown): Record<string, unknown> {
  const document = reviewedSeriesDocument();
  return { ...document, parameters: { ...(document["parameters"] as Record<string, unknown>), acceptedProtocolVersions: accepted } };
}

function withoutAccepted(): Record<string, unknown> {
  const document = reviewedSeriesDocument();
  const parameters = { ...(document["parameters"] as Record<string, unknown>) };
  delete parameters["acceptedProtocolVersions"];
  return { ...document, parameters };
}

function hashOf(document: Record<string, unknown>): string {
  const hash = seriesConfigHash(ReviewedSeriesSchema.parse(document));
  if (!hash.ok) throw new Error(hash.problem);
  return hash.hash;
}

describe("V2-1: the trader's copy of the review carries acceptedProtocolVersions (ADR-030 Amendment 2 rule 2)", () => {
  it("the versions and the refusal text are the gateway's", () => {
    expect(PROTOCOL_VERSIONS).toEqual(["v1", "v2"]);
    expect(ACCEPTED_PROTOCOL_VERSIONS_REQUIRED).toBe(GATEWAY_REFUSAL);
  });

  it("the sample review states [\"v1\"], parses, and hashes to the gateway's pinned value", () => {
    const parameters = reviewedSeriesDocument()["parameters"] as Record<string, unknown>;
    expect(parameters["acceptedProtocolVersions"]).toEqual(["v1"]);
    expect(hashOf(reviewedSeriesDocument())).toBe(SAMPLE_REVIEW_HASH_V1);
    expect(hashOf(withAccepted(["v1", "v2"]))).toBe(SAMPLE_REVIEW_HASH_V1_V2);
    expect(hashOf(withAccepted(["v2", "v1"]))).not.toBe(SAMPLE_REVIEW_HASH_V1_V2);
  });

  it("a review WITHOUT the field is refused, naming it and what to add — never defaulted", () => {
    const parsed = ReviewedSeriesSchema.safeParse(withoutAccepted());
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => [issue.path.join("."), issue.message])).toEqual([
      ["parameters.acceptedProtocolVersions", GATEWAY_REFUSAL],
    ]);
  });

  it("the list is non-empty, of distinct values, each exactly \"v1\" or \"v2\" — the gateway's corpus", () => {
    for (const bad of [[], ["v1", "v1"], ["v2", "v2"], ["v3"], ["V1"], ["v1", "v2", "v1"], ["v1", null], "v1", null, ["v1", "v2", "v3"]]) {
      expect(ReviewedSeriesSchema.safeParse(withAccepted(bad)).success, JSON.stringify(bad)).toBe(false);
    }
    const duplicate = ReviewedSeriesSchema.safeParse(withAccepted(["v2", "v2"]));
    expect(duplicate.error?.issues.map((issue) => issue.message)).toContain("the accepted protocol versions must be distinct");
    for (const good of [["v1"], ["v2"], ["v1", "v2"], ["v2", "v1"]]) {
      expect(ReviewedSeriesSchema.safeParse(withAccepted(good)).success, JSON.stringify(good)).toBe(true);
    }
  });
});
