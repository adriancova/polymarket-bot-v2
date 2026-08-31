import { describe, expect, it } from "vitest";

import { SettlementSpecValidationError } from "./errors.js";
import {
  RTDS_TWAP_WINDOW_SECONDS_VERIFIED_2026_08_24,
  isReviewedSettlementSpec,
  parseSettlementSpec,
  placeholderRuleTextReason,
  safeParseSettlementSpec,
  settlementSpecReviewBlockers,
  SettlementSpecSchema,
} from "./spec.js";
import {
  LEGITIMATE_POLICY_SAMPLES,
  PLACEHOLDER_POLICY_ATTACK_SAMPLES,
  referenceOpenUpDownSpecSample,
  terminalSpotSpecSample,
  thresholdByDateSpecSample,
  twapSpecSample,
  verifiedSpec,
} from "./testing/index.js";

const SAMPLES = [
  terminalSpotSpecSample(),
  twapSpecSample(),
  referenceOpenUpDownSpecSample(),
  thresholdByDateSpecSample(),
];

/** Drops a key without introducing an explicit `undefined`. */
function without(spec: object, key: string): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...(spec as Record<string, unknown>) };
  delete copy[key];
  return copy;
}

describe("SettlementSpecSchema", () => {
  it("accepts every sample spec", () => {
    for (const sample of SAMPLES) {
      expect(SettlementSpecSchema.safeParse(sample).success).toBe(true);
    }
  });

  it("carries every §9.3 required field", () => {
    const spec = twapSpecSample();
    for (const field of [
      "settlementSpecId",
      "seriesId",
      "rulesVersionId",
      "resolutionSource",
      "referenceSymbol",
      "observationType",
      "windowSeconds",
      "windowStartRule",
      "windowEndRule",
      "comparison",
      "strikeSource",
      "timestampBoundary",
      "roundingRule",
      "fallbackSource",
      "disputePolicy",
      "clarificationPolicy",
      "verification",
    ]) {
      expect(spec).toHaveProperty(field);
    }
  });

  it("rejects an unknown key rather than stripping it", () => {
    const result = SettlementSpecSchema.safeParse({
      ...terminalSpotSpecSample(),
      unreviewedExtra: "smuggled in",
    });
    expect(result.success).toBe(false);
  });

  it.each([
    "resolutionSource",
    "referenceSymbol",
    "observationType",
    "timestampBoundary",
    "roundingRule",
    "fallbackSource",
    "disputePolicy",
    "clarificationPolicy",
    "verification",
    "settlementSpecId",
    "seriesId",
    "specVersion",
  ])("requires %s", (field) => {
    expect(SettlementSpecSchema.safeParse(without(terminalSpotSpecSample(), field)).success).toBe(
      false,
    );
  });

  it.each(["unspecified", "TBD", "n/a", "  ", "-", "none", "TODO"])(
    "refuses %s as a dispute policy (ADR-009 §5.4)",
    (placeholder) => {
      const result = SettlementSpecSchema.safeParse({
        ...terminalSpotSpecSample(),
        disputePolicy: placeholder,
      });
      expect(result.success).toBe(false);
    },
  );

  // Round-1 review, M1: exact-string matching let every one of these through.
  // The matcher now normalizes case, whitespace and punctuation, refuses
  // punctuation-only values, semantic placeholder phrases, and placeholder
  // prefixes.
  it.each([
    "TBD - complete after review", // reviewer probe: placeholder prefix
    "to be determined", // reviewer probe: semantic phrase
    "???", // reviewer probe: punctuation-only above the length minimum
    "not specified", // reviewer probe: semantic phrase
    "N / A", // reviewer probe: spaced punctuation variant
    "To Be Determined.",
    "T.B.D.",
    "n.a.",
    "TODO: write the dispute policy",
    "FIXME later",
    "placeholder text",
    "not applicable",
    "to be confirmed with legal",
    "...",
    "- - -",
  ])("refuses the placeholder variant %j (round-1, M1)", (placeholder) => {
    const result = SettlementSpecSchema.safeParse({
      ...terminalSpotSpecSample(),
      disputePolicy: placeholder,
    });
    expect(result.success).toBe(false);
  });

  it.each([
    "Halt and escalate to the operator; no substitute source is used.",
    "None of the fallback sources may be used; halt and page the operator.",
    "Unknown outcomes are escalated to a human reviewer before any settlement.",
  ])("still accepts the stated policy %j", (policy) => {
    const result = SettlementSpecSchema.safeParse({
      ...terminalSpotSpecSample(),
      disputePolicy: policy,
    });
    expect(result.success).toBe(true);
  });

  // Round-2 review, M1: the round-1 matcher stripped non-ASCII characters and
  // matched only whole fields or prefixes, so a whole-field common phrase, a
  // mid-sentence marker, and a Cyrillic-lookalike marker all reached
  // REVIEWED_MODEL_BACKED. The shared fixture list pins every reviewer probe
  // and every added attack case; `activation.test.ts` pins the SAME list at
  // the activation gate.
  it.each([...PLACEHOLDER_POLICY_ATTACK_SAMPLES])(
    "refuses the placeholder %j at construction (round-2, M1)",
    (placeholder) => {
      const result = SettlementSpecSchema.safeParse({
        ...terminalSpotSpecSample(),
        disputePolicy: placeholder,
      });
      expect(result.success).toBe(false);
    },
  );

  it.each([...LEGITIMATE_POLICY_SAMPLES])(
    "still accepts the legitimate policy %j (round-2, M1 boundary)",
    (policy) => {
      const result = SettlementSpecSchema.safeParse({
        ...terminalSpotSpecSample(),
        disputePolicy: policy,
      });
      expect(result.success).toBe(true);
    },
  );

  // Pin WHICH Unicode rule catches each confusable class, so a refactor that
  // keeps refusing but for the wrong reason (or stops refusing one class while
  // another still catches the sample) is visible.
  describe("placeholderRuleTextReason Unicode handling (round-2, M1)", () => {
    it("refuses a token mixing Latin and non-Latin scripts outright", () => {
      expect(placeholderRuleTextReason("ТВD - complete after review")).toContain(
        "mixes Unicode scripts",
      );
    });

    it("reads an all-Cyrillic homoglyph marker as what it visually spells", () => {
      expect(placeholderRuleTextReason("Т В D - complete after review")).toContain(
        "folding Unicode homoglyphs",
      );
    });

    it("reassembles a marker split by non-ASCII characters instead of laundering it", () => {
      expect(placeholderRuleTextReason("tb\u00add - complete after review")).toContain(
        "stripping non-ASCII",
      );
    });

    it("normalizes fullwidth forms before matching (NFKC)", () => {
      expect(placeholderRuleTextReason("ＴＢＤ - complete after review")).toContain("tbd");
    });

    it("folds digit-for-letter substitutions inside a token", () => {
      expect(placeholderRuleTextReason("T0D0: write the dispute policy")).toContain("todo");
    });

    it("finds a self-announcing marker at any token position", () => {
      expect(placeholderRuleTextReason("Use primary source; TBD - complete after review.")).toContain(
        "tbd",
      );
    });

    it("does not treat ordinary words about reviewing as markers", () => {
      expect(
        placeholderRuleTextReason("Disputes are resolved by the review committee within 48 hours."),
      ).toBeUndefined();
    });
  });

  // Round-3 review, M1: pin WHICH rule catches each newly closed class, so a
  // refactor cannot silently shift a class onto a different (and possibly
  // narrower) rule without this suite noticing.
  describe("placeholderRuleTextReason round-3 rules (M1)", () => {
    it("joins multi-letter dotted segments within one span (TO.DO)", () => {
      expect(placeholderRuleTextReason("TO.DO: confirm with ops")).toContain("todo");
    });

    it("joins multi-letter dotted segments within one span (FI.XME)", () => {
      expect(placeholderRuleTextReason("FI.XME before launch")).toContain("fixme");
    });

    it("joins dotted segments of mixed lengths within one span (W.IP)", () => {
      expect(placeholderRuleTextReason("W.IP: finalize escalation matrix")).toContain("wip");
    });

    it("refuses a Greek token left partially non-Latin after folding (lunate sigma)", () => {
      expect(placeholderRuleTextReason("τβϲ; use primary source.")).toContain(
        "after folding known homoglyphs",
      );
    });

    it("refuses a Cyrillic token left partially non-Latin after folding (д)", () => {
      expect(placeholderRuleTextReason("ТВД; use primary source.")).toContain(
        "after folding known homoglyphs",
      );
    });

    it("treats a digit in a marker-length token as a stand-in for any letter (TB0)", () => {
      expect(placeholderRuleTextReason("TB0")).toContain("tbd");
    });

    it("catches a marker that is both dotted and digit-substituted (F1X.ME)", () => {
      expect(placeholderRuleTextReason("F1X.ME later")).toContain("fixme");
    });

    it("keeps accented Latin out of the post-fold non-Latin refusal", () => {
      expect(
        placeholderRuleTextReason("A naïve reading of the rules is escalated for human review."),
      ).toBeUndefined();
      expect(
        placeholderRuleTextReason("Résolution follows the venue's published procedure."),
      ).toBeUndefined();
    });

    it("keeps ordinary words containing marker substrings at token boundaries", () => {
      expect(
        placeholderRuleTextReason("Mastodon announcements by the venue are not authoritative."),
      ).toBeUndefined();
      expect(
        placeholderRuleTextReason("Autodial escalation is disabled; a human operator confirms."),
      ).toBeUndefined();
    });

    it("keeps mixed letter+digit tokens whose letters match no marker", () => {
      expect(
        placeholderRuleTextReason("The T+1 settlement convention applies; escalate within 24h."),
      ).toBeUndefined();
    });

    it("refuses the whole-field pending/to-do family, whole field only", () => {
      expect(placeholderRuleTextReason("pending completion")).toContain("pending completion");
      expect(placeholderRuleTextReason("to do")).toContain("to do");
      expect(placeholderRuleTextReason("to be done")).toContain("to be done");
      expect(
        placeholderRuleTextReason("Pending completion of the dispute review, no position is settled."),
      ).toBeUndefined();
      expect(
        placeholderRuleTextReason("To do so, the operator must first halt the series."),
      ).toBeUndefined();
    });
  });

  it("refuses a clarification policy that states a placeholder", () => {
    const result = SettlementSpecSchema.safeParse({
      ...terminalSpotSpecSample(),
      clarificationPolicy: "unknown",
    });
    expect(result.success).toBe(false);
  });

  it("refuses rule text with leading or trailing whitespace", () => {
    const result = SettlementSpecSchema.safeParse({
      ...terminalSpotSpecSample(),
      roundingRule: " round half even ",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a number where a decimal-free rule string belongs", () => {
    const result = SettlementSpecSchema.safeParse({
      ...terminalSpotSpecSample(),
      roundingRule: 2,
    });
    expect(result.success).toBe(false);
  });

  describe("verification", () => {
    it("accepts a verified spec that names its reviewer and instant", () => {
      const spec = parseSettlementSpec(verifiedSpec(terminalSpotSpecSample()));
      expect(isReviewedSettlementSpec(spec)).toBe(true);
    });

    it("cannot claim VERIFIED without a reviewer", () => {
      const result = SettlementSpecSchema.safeParse({
        ...terminalSpotSpecSample(),
        verification: { status: "VERIFIED", verifiedAt: "2026-08-28T00:00:00Z" },
      });
      expect(result.success).toBe(false);
    });

    it("cannot claim VERIFIED without a review instant", () => {
      const result = SettlementSpecSchema.safeParse({
        ...terminalSpotSpecSample(),
        verification: { status: "VERIFIED", verifiedBy: "reviewer" },
      });
      expect(result.success).toBe(false);
    });

    it("cannot name a reviewer while claiming to be unverified", () => {
      const result = SettlementSpecSchema.safeParse({
        ...terminalSpotSpecSample(),
        verification: { status: "UNVERIFIED", verifiedBy: "reviewer" },
      });
      expect(result.success).toBe(false);
    });

    it("treats UNVERIFIED and REJECTED as unreviewed", () => {
      expect(isReviewedSettlementSpec(parseSettlementSpec(terminalSpotSpecSample()))).toBe(false);
      expect(
        isReviewedSettlementSpec(
          parseSettlementSpec({
            ...terminalSpotSpecSample(),
            verification: { status: "REJECTED" },
          }),
        ),
      ).toBe(false);
    });
  });

  describe("windowed observations", () => {
    it("requires window_seconds for TWAP and VWAP", () => {
      for (const observationType of ["TWAP", "VWAP"] as const) {
        const result = SettlementSpecSchema.safeParse({
          ...without(twapSpecSample(), "windowSeconds"),
          observationType,
        });
        expect(result.success).toBe(false);
      }
    });

    it("requires both window boundary rules when a window is declared", () => {
      for (const field of ["windowStartRule", "windowEndRule"]) {
        const result = SettlementSpecSchema.safeParse(without(twapSpecSample(), field));
        expect(result.success).toBe(false);
      }
    });
  });

  describe("payoff-model compatibility (§9.3 / acceptance 1)", () => {
    it("cannot construct a TWAP spec that selects the terminal-spot model", () => {
      const result = SettlementSpecSchema.safeParse({
        ...twapSpecSample(),
        payoffModel: "TerminalSpotBinaryModel",
      });

      expect(result.success).toBe(false);
      const messages = result.success
        ? []
        : result.error.issues.map((issue) => issue.message);
      expect(messages.join(" ")).toContain("SETTLEMENT_TWAP_TERMINAL_SPOT_FORBIDDEN");
    });

    it("accepts a spec whose observation type has no model at all", () => {
      // ADR-009 §2: such a spec exists; it simply cannot be activated.
      const spec = parseSettlementSpec({
        ...without(terminalSpotSpecSample(), "payoffModel"),
        observationType: "MANUAL_ORACLE",
      });
      expect(spec.payoffModel).toBeUndefined();
    });

    it("refuses a spec that names a model requiring a field it does not carry", () => {
      const result = SettlementSpecSchema.safeParse(
        without(terminalSpotSpecSample(), "strikeSource"),
      );
      expect(result.success).toBe(false);
    });
  });

  describe("parse entry points", () => {
    it("throws a typed error with the issue list", () => {
      expect(() => parseSettlementSpec({})).toThrow(SettlementSpecValidationError);
      try {
        parseSettlementSpec({});
      } catch (error) {
        expect(error).toBeInstanceOf(SettlementSpecValidationError);
        const typed = error as SettlementSpecValidationError;
        expect(typed.code).toBe("SETTLEMENT_SPEC_INVALID");
        expect(typed.issues.length).toBeGreaterThan(0);
      }
    });

    it("returns a refusal instead of throwing in the safe variant", () => {
      const result = safeParseSettlementSpec(42);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.refusal.code).toBe("SETTLEMENT_SPEC_INVALID");
      }
    });

    it("returns the parsed spec in the safe variant", () => {
      const result = safeParseSettlementSpec(terminalSpotSpecSample());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.spec.payoffModel).toBe("TerminalSpotBinaryModel");
      }
    });
  });
});

describe("settlementSpecReviewBlockers", () => {
  it("passes a complete spec whose window the feed publishes", () => {
    const blockers = settlementSpecReviewBlockers(parseSettlementSpec(twapSpecSample()), {
      publishedWindowSeconds: RTDS_TWAP_WINDOW_SECONDS_VERIFIED_2026_08_24,
    });
    expect(blockers).toEqual([]);
  });

  it("blocks a spec that names no rules version", () => {
    const spec = parseSettlementSpec(without(terminalSpotSpecSample(), "rulesVersionId"));
    const blockers = settlementSpecReviewBlockers(spec);
    expect(blockers.map((blocker) => blocker.code)).toContain(
      "SETTLEMENT_RULES_VERSION_REQUIRED",
    );
  });

  it("blocks a windowed spec when the caller states no published windows", () => {
    const blockers = settlementSpecReviewBlockers(parseSettlementSpec(twapSpecSample()));
    expect(blockers.map((blocker) => blocker.code)).toEqual([
      "SETTLEMENT_PUBLISHED_WINDOWS_UNKNOWN",
    ]);
  });

  it("blocks a window the feed does not publish (ADR-009 §6)", () => {
    const spec = parseSettlementSpec({ ...twapSpecSample(), windowSeconds: 45 });
    const blockers = settlementSpecReviewBlockers(spec, {
      publishedWindowSeconds: RTDS_TWAP_WINDOW_SECONDS_VERIFIED_2026_08_24,
    });
    expect(blockers.map((blocker) => blocker.code)).toEqual(["SETTLEMENT_WINDOW_NOT_PUBLISHED"]);
  });

  it("keeps the dated published-window constant as a snapshot, not a hardcoded truth", () => {
    expect(RTDS_TWAP_WINDOW_SECONDS_VERIFIED_2026_08_24).toEqual([30, 60]);
    expect(Object.isFrozen(RTDS_TWAP_WINDOW_SECONDS_VERIFIED_2026_08_24)).toBe(true);
  });
});
