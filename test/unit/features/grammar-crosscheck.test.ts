/**
 * The features package validates inputs with HAND-WRITTEN predicates (the
 * recorded schema-risk remedy: no runtime schema library). This test binds
 * those mirrored grammars to the frozen domain contracts so they cannot
 * drift into a private dialect: for every probe vector, the features
 * validator's verdict must match (or, for the deliberately-narrower
 * timestamp grammar, be a strict subset of) the domain schema's.
 */

import { describe, expect, it } from "vitest";

import {
  CodeStringSchema,
  IncidentSeveritySchema,
  IsoTimestampSchema,
  TokenIdSchema,
  UuidSchema,
  Uuidv7Schema,
} from "../../../packages/domain/src/index.js";
import { computeFeatureSnapshot, parseUtcTimestamp } from "../../../packages/features/src/index.js";
import { validInput } from "./fixtures.js";

/** Whether the features input validator ACCEPTS `edit`'s modified fixture. */
function accepts(edit: (input: Record<string, unknown>) => void): boolean {
  const input = validInput();
  edit(input);
  const result = computeFeatureSnapshot(input);
  return result.ok;
}

describe("grammar mirrors versus the frozen domain schemas", () => {
  it("internalMarketId ~ Uuidv7Schema over shared probe vectors", () => {
    const vectors = [
      "018f4d2e-0000-7000-8000-000000000001", // valid v7
      "018F4D2E-0000-7000-8000-000000000001", // uppercase — refuse, not fold
      "018f4d2e-0000-4000-8000-000000000001", // v4, not v7
      "018f4d2e-0000-7000-c000-000000000001", // bad variant
      "018f4d2e-0000-7000-8000-00000000001", // short
      "not-a-uuid",
    ];
    for (const vector of vectors) {
      const domainVerdict = Uuidv7Schema.safeParse(vector).success;
      const featuresVerdict = accepts((input) => {
        (input["subject"] as Record<string, unknown>)["internalMarketId"] = vector;
        // Keep the book's identity in agreement so only the grammar decides.
        (input["book"] as Record<string, unknown>)["serializedBook"] = (
          (input["book"] as Record<string, unknown>)["serializedBook"] as string
        ).replace(/^market .*$/mu, `market ${vector}`);
      });
      expect(featuresVerdict, vector).toBe(domainVerdict);
    }
  });

  it("tokenId ~ TokenIdSchema over shared probe vectors", () => {
    for (const vector of ["0", "123456", "999999999999999999999999", "0123", "-1", "1.5", ""]) {
      const domainVerdict = TokenIdSchema.safeParse(vector).success;
      const featuresVerdict = accepts((input) => {
        (input["subject"] as Record<string, unknown>)["tokenId"] = vector;
        (input["book"] as Record<string, unknown>)["serializedBook"] = (
          (input["book"] as Record<string, unknown>)["serializedBook"] as string
        ).replace(/^token .*$/mu, `token ${vector}`);
      });
      expect(featuresVerdict, JSON.stringify(vector)).toBe(domainVerdict);
    }
  });

  it("gatewayEpoch ~ UuidSchema over shared probe vectors", () => {
    for (const vector of [
      "018f4d2e-0000-7000-8000-0000000000aa",
      "123e4567-e89b-12d3-a456-426614174000", // v1 — any canonical version passes
      "123E4567-E89B-12D3-A456-426614174000", // uppercase refused
      "xyz",
    ]) {
      const domainVerdict = UuidSchema.safeParse(vector).success;
      const featuresVerdict = accepts((input) => {
        (input["trigger"] as Record<string, unknown>)["gatewayEpoch"] = vector;
      });
      expect(featuresVerdict, vector).toBe(domainVerdict);
    }
  });

  it("reasonCode/feedId ~ CodeStringSchema over shared probe vectors", () => {
    for (const vector of ["FEED_GAP", "a.b:c-d_e", "9starts-with-digit", "has space", "", "é"]) {
      const domainVerdict = CodeStringSchema.safeParse(vector).success;
      const featuresVerdict = accepts((input) => {
        const quality = input["quality"] as { activeIncidents: Record<string, unknown>[] };
        const incident = quality.activeIncidents[0];
        if (incident !== undefined) incident["reasonCode"] = vector;
      });
      expect(featuresVerdict, JSON.stringify(vector)).toBe(domainVerdict);
    }
  });

  it("severity vocabulary equals the domain IncidentSeveritySchema options", () => {
    expect(IncidentSeveritySchema.options).toEqual(["LOG", "NOTIFY", "PAGE"]);
    for (const vector of ["LOG", "NOTIFY", "PAGE", "CRITICAL", "log"]) {
      const domainVerdict = IncidentSeveritySchema.safeParse(vector).success;
      const featuresVerdict = accepts((input) => {
        const quality = input["quality"] as { activeIncidents: Record<string, unknown>[] };
        const incident = quality.activeIncidents[0];
        if (incident !== undefined) incident["severity"] = vector;
      });
      expect(featuresVerdict, vector).toBe(domainVerdict);
    }
  });

  it("the strict UTC timestamp grammar is a SUBSET of the domain ISO grammar", () => {
    const vectors = [
      "2026-09-03T12:00:00Z",
      "2026-09-03T12:00:00.500Z",
      "2026-02-29T00:00:00Z", // impossible date — both must refuse
      "2026-09-03T12:00:00+02:00", // offset: domain accepts, features refuse
      "2026-09-03T12:00:00", // no designator: both refuse
      "garbage",
    ];
    for (const vector of vectors) {
      const featuresVerdict = parseUtcTimestamp(vector).ok;
      const domainVerdict = IsoTimestampSchema.safeParse(vector).success;
      if (featuresVerdict) {
        // Everything features accept, the domain accepts (subset property).
        expect(domainVerdict, vector).toBe(true);
      }
    }
    // And the narrowing is real: the offset spelling separates the two.
    expect(IsoTimestampSchema.safeParse("2026-09-03T12:00:00+02:00").success).toBe(true);
    expect(parseUtcTimestamp("2026-09-03T12:00:00+02:00").ok).toBe(false);
  });
});
