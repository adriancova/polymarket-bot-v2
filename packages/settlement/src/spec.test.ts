import { describe, expect, it } from "vitest";

import { SettlementSpecValidationError } from "./errors.js";
import {
  CONVENTIONAL_TOKEN_CANONICAL,
  PLACEHOLDER_STOPWORD_TOKENS,
  RTDS_TWAP_WINDOW_SECONDS_VERIFIED_2026_08_24,
  WHOLE_FIELD_FAMILY_MAX_TAIL_TOKENS,
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
      // Expectation UPDATED in round 4 (annotated per the round-1 precedent):
      // the soft hyphen becomes whitespace under normalization, so the new
      // (strictly earlier) whitespace-split marker rule now catches this
      // sample on the plain candidate. The refusal itself is unchanged and
      // still pinned at both gates via the shared fixtures; the stripping
      // layer keeps its own dedicated pin below.
      expect(placeholderRuleTextReason("tb\u00add - complete after review")).toContain("tbd");
    });

    it("still reaches the stripping layer for a non-ASCII-split PREFIX form", () => {
      // Round-4 pin: no whitespace/join rule reassembles a split multi-word
      // prefix, so only the non-ASCII-stripping candidate catches this \u2014 the
      // stripping layer stays mutation-visible after the round-4 rules landed.
      expect(placeholderRuleTextReason("unspec\u00adified complete later")).toContain(
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

  // Round-4 review, M-1 and M-2: pin WHICH rule catches each newly closed
  // class and which boundary each new rule must not cross, so a refactor
  // cannot silently shift a class onto a narrower rule or widen a rule past
  // its pinned boundary.
  describe("placeholderRuleTextReason round-4 rules (M-1, M-2)", () => {
    it("refuses a marker split across whitespace at any position (reviewer probe)", () => {
      expect(placeholderRuleTextReason("Policy TO DO later.")).toContain("split across whitespace");
      expect(placeholderRuleTextReason("Policy TO DO later.")).toContain("todo");
      expect(placeholderRuleTextReason("Policy is TO DO.")).toContain("split across whitespace");
    });

    it("refuses a field-start split marker with a non-grammatical tail", () => {
      expect(placeholderRuleTextReason("TO DO: confirm with ops")).toContain(
        "split across whitespace",
      );
      expect(placeholderRuleTextReason("to do later")).toContain("split across whitespace");
    });

    it("refuses the split-fixme adjacency as self-announcing (deliberate call)", () => {
      expect(placeholderRuleTextReason("fix me before launch")).toContain("fixme");
    });

    it("joins split fragments of mixed lengths and digit substitutions", () => {
      expect(placeholderRuleTextReason("to d o later")).toContain("todo");
      expect(placeholderRuleTextReason("place holder")).toContain("placeholder");
      expect(placeholderRuleTextReason("f1x me before launch")).toContain("fixme");
    });

    it("exempts only the grammatical To-do opener, at field start, with a clause", () => {
      expect(
        placeholderRuleTextReason("To do so, the operator must first halt the series."),
      ).toBeUndefined();
      expect(
        placeholderRuleTextReason(
          "To do this correctly, the operator halts the series before any settlement.",
        ),
      ).toBeUndefined();
      expect(
        placeholderRuleTextReason("To do that, escalate to the operator and halt the series first."),
      ).toBeUndefined();
      // The exemption's own boundary: a bare opener with nothing after the
      // continuation word, a digit-substituted opener, and a mid-sentence
      // marker all refuse.
      expect(placeholderRuleTextReason("to do so")).toContain("split across whitespace");
      expect(placeholderRuleTextReason("t0 d0 so later")).toContain("todo");
      expect(placeholderRuleTextReason("Policy is TO DO.")).toContain("todo");
    });

    it("refuses a whole-field entry split by whitespace (condensed rule)", () => {
      expect(placeholderRuleTextReason("un known")).toContain("ignoring whitespace");
      expect(placeholderRuleTextReason("un known")).toContain("unknown");
    });

    it("refuses the whole-field unfinished families regardless of the tail (reviewer probes)", () => {
      expect(placeholderRuleTextReason("pending legal review")).toContain(
        "unfinished-form family",
      );
      expect(placeholderRuleTextReason("awaiting input")).toContain("unfinished-form family");
      expect(placeholderRuleTextReason("pending outside counsel signoff")).toContain(
        "unfinished-form family",
      );
      expect(placeholderRuleTextReason("not yet drafted")).toContain("unfinished-form family");
      expect(placeholderRuleTextReason("to be agreed")).toContain("unfinished-form family");
      expect(placeholderRuleTextReason("yet to be agreed")).toContain("unfinished-form family");
    });

    it("refuses the conventional unfinished-field entries (reviewer probe)", () => {
      expect(placeholderRuleTextReason("intentionally left blank")).toContain(
        "intentionally left blank",
      );
      expect(placeholderRuleTextReason("left blank")).toContain("left blank");
      expect(placeholderRuleTextReason("see attached")).toContain("see attached");
    });

    it("bounds the family at four trailing tokens (the documented residual)", () => {
      expect(WHOLE_FIELD_FAMILY_MAX_TAIL_TOKENS).toBe(4);
      // head + 4 refuses; head + 5 passes the family rule (an honestly
      // disclosed residual, defended by the human verified_by gate — NOT a
      // claim that such text is a rule).
      expect(placeholderRuleTextReason("pending legal review and signoff")).toContain(
        "unfinished-form family",
      );
      expect(
        placeholderRuleTextReason("pending review by outside counsel signoff"),
      ).toBeUndefined();
    });

    it("keeps long head-opened sentences past the family bound (whole-field only)", () => {
      expect(
        placeholderRuleTextReason(
          "Awaiting venue confirmation, the operator holds settlement open and escalates within 24h.",
        ),
      ).toBeUndefined();
      expect(
        placeholderRuleTextReason(
          "Not yet resolved markets are held open and escalated to the operator after 48 hours.",
        ),
      ).toBeUndefined();
      expect(
        placeholderRuleTextReason("Pending completion of the dispute review, no position is settled."),
      ).toBeUndefined();
    });
  });

  // Round-5 review, R5-M1: pin WHICH rule catches each newly closed class and
  // which boundary each new rule must not cross. The conventional-entry class
  // is closed STRUCTURALLY (canonical token multisets + entry-side condensed
  // expansion), not by enumerating the two reviewer strings.
  describe("placeholderRuleTextReason round-5 rules (R5-M1)", () => {
    it("refuses a word-order permutation of a conventional entry (reviewer probe)", () => {
      expect(placeholderRuleTextReason("left intentionally blank")).toContain("up to word order");
      expect(placeholderRuleTextReason("left intentionally blank")).toContain(
        "intentionally left blank",
      );
      expect(placeholderRuleTextReason("blank intentionally left")).toContain("up to word order");
      expect(placeholderRuleTextReason("intentionally blank left")).toContain("up to word order");
      expect(placeholderRuleTextReason("blank left")).toContain("left blank");
    });

    it("refuses a morphological variant of a referential entry (reviewer probe)", () => {
      expect(placeholderRuleTextReason("see attachment")).toContain("see attached");
      expect(placeholderRuleTextReason("see attachments")).toContain("see attached");
      expect(placeholderRuleTextReason("see enclosure")).toContain("see enclosed");
      expect(placeholderRuleTextReason("dittos")).toContain("ditto");
      expect(placeholderRuleTextReason("no contents")).toContain("no content");
      expect(placeholderRuleTextReason("purposefully left blank")).toContain(
        "purposely left blank",
      );
    });

    it("drops exactly the four stopwords the/a/an/to before comparing", () => {
      expect([...PLACEHOLDER_STOPWORD_TOKENS]).toEqual(["the", "a", "an", "to"]);
      expect(placeholderRuleTextReason("see the attachment")).toContain("see attached");
      expect(placeholderRuleTextReason("refer to attachment")).toContain("see attached");
      expect(placeholderRuleTextReason("refer to the attachment")).toContain("see attached");
      expect(placeholderRuleTextReason("the attachment")).toContain("attached");
    });

    it("keeps the morphology table bounded and explicit (no stemmer)", () => {
      // Pin the load-bearing rows: a refactor that drops a class silently
      // reopens its variants. The table is variant → canonical.
      expect(CONVENTIONAL_TOKEN_CANONICAL["attachment"]).toBe("attached");
      expect(CONVENTIONAL_TOKEN_CANONICAL["attachments"]).toBe("attached");
      expect(CONVENTIONAL_TOKEN_CANONICAL["enclosure"]).toBe("enclosed");
      expect(CONVENTIONAL_TOKEN_CANONICAL["refer"]).toBe("see");
      expect(CONVENTIONAL_TOKEN_CANONICAL["below"]).toBe("above");
      expect(Object.isFrozen(CONVENTIONAL_TOKEN_CANONICAL)).toBe(true);
      // Un-stemmed forms outside the table stay outside: "specified" is not
      // laundered into "unspecified", and unknown words are identity.
      expect(CONVENTIONAL_TOKEN_CANONICAL["specified"]).toBeUndefined();
      expect(CONVENTIONAL_TOKEN_CANONICAL["document"]).toBeUndefined();
    });

    it("refuses glued permutation/morphology combinations (expanded condensed map)", () => {
      expect(placeholderRuleTextReason("seeattachment")).toContain("ignoring whitespace");
      expect(placeholderRuleTextReason("seeattachment")).toContain("see attached");
      expect(placeholderRuleTextReason("leftintentionallyblank")).toContain("ignoring whitespace");
      expect(placeholderRuleTextReason("leftintentionallyblank")).toContain(
        "intentionally left blank",
      );
    });

    it("stays whole-field only: real sentences containing the words parse (reviewer negatives)", () => {
      expect(
        placeholderRuleTextReason("The attachment referenced in §2 governs disputes."),
      ).toBeUndefined();
      expect(
        placeholderRuleTextReason("Intentionally leaving the venue field blank is refused by the schema."),
      ).toBeUndefined();
      expect(placeholderRuleTextReason("See §4.")).toBeUndefined();
      expect(
        placeholderRuleTextReason("Refer all disputes to the operator; see §4 for the escalation path."),
      ).toBeUndefined();
      expect(
        placeholderRuleTextReason("Attached exhibits do not override this policy; the stated rule governs."),
      ).toBeUndefined();
      expect(
        placeholderRuleTextReason("Blank observations are refused and escalated to the operator."),
      ).toBeUndefined();
    });

    it("keeps the disclosed round-5 residuals visible rather than claiming them away", () => {
      // An entry plus a substantive (non-stopword) extra token is NOT closed:
      // cardinality must match exactly, so this passes the matcher and the
      // human verified_by gate remains the defense. Pinned so the residual
      // cannot silently move in either direction.
      expect(placeholderRuleTextReason("see attached document")).toBeUndefined();
      // A NEW COMBINATION of enumerated tokens that is not itself an entry
      // (nor a permutation/morph of one) is a novel family, not closed.
      expect(placeholderRuleTextReason("ditto above")).toBeUndefined();
      // A glued form with a fused stopword: segmenting unspaced text is out
      // of scope for the condensed expansion (documented on the map).
      expect(placeholderRuleTextReason("seetheattachment")).toBeUndefined();
    });

    it("keeps the pre-round-5 disclosed residuals passing (no silent widening)", () => {
      // These demonstrate the round-4 residual disclosure (novel families,
      // split prefixes, family-bound padding, novel prose) and must KEEP
      // passing: the round-5 closure is scoped to the conventional-entry
      // class, not a general prose judgment.
      expect(placeholderRuleTextReason("ask ops first")).toBeUndefined();
      expect(placeholderRuleTextReason("Ask Bob before settling.")).toBeUndefined();
      expect(placeholderRuleTextReason("To be clear, disputes settle per §4.")).toBeUndefined();
      expect(placeholderRuleTextReason("un specified complete later")).toBeUndefined();
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
