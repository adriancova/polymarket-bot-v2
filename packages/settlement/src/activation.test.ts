import { describe, expect, it } from "vitest";

import {
  ACTIVATION_PERMITTED_STATUS,
  SETTLEMENT_ACTIVATION_STATUSES,
  classifySettlementActivation,
  type SettlementActivationInput,
  type SettlementActivationStatus,
} from "./activation.js";
import { RTDS_TWAP_WINDOW_SECONDS_VERIFIED_2026_08_24 } from "./spec.js";
import {
  LEGITIMATE_POLICY_SAMPLES,
  PLACEHOLDER_POLICY_ATTACK_SAMPLES,
  stopwordPairEncodingMatrix,
  terminalSpotSpecSample,
  twapSpecSample,
  verifiedSpec,
} from "./testing/index.js";

const publishedWindows = { publishedWindowSeconds: RTDS_TWAP_WINDOW_SECONDS_VERIFIED_2026_08_24 };

function without(spec: object, key: string): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...(spec as Record<string, unknown>) };
  delete copy[key];
  return copy;
}

describe("classifySettlementActivation", () => {
  it("permits activation for a reviewed, model-backed spec", () => {
    const verdict = classifySettlementActivation({
      spec: verifiedSpec(terminalSpotSpecSample()),
    });

    expect(verdict.status).toBe("REVIEWED_MODEL_BACKED");
    expect(verdict.modelDependentActivationAllowed).toBe(true);
    expect(verdict.refusals).toEqual([]);
    expect(verdict.payoffModel).toBe("TerminalSpotBinaryModel");
    expect(verdict.rulesVersionId).toBe("01936f00-0000-7000-8000-00000000b001");
  });

  it("blocks activation on an unverified spec (acceptance 3)", () => {
    const verdict = classifySettlementActivation({ spec: terminalSpotSpecSample() });

    expect(verdict.status).toBe("SPEC_UNVERIFIED");
    expect(verdict.modelDependentActivationAllowed).toBe(false);
    expect(verdict.refusals.map((refusal) => refusal.code)).toEqual([
      "SETTLEMENT_SPEC_UNVERIFIED",
    ]);
  });

  it("blocks activation when no spec is bound at all", () => {
    for (const spec of [undefined, null]) {
      const verdict = classifySettlementActivation({ spec });
      expect(verdict.status).toBe("SPEC_MISSING");
      expect(verdict.modelDependentActivationAllowed).toBe(false);
    }
    expect(classifySettlementActivation().status).toBe("SPEC_MISSING");
  });

  it("blocks activation on a rejected spec, distinctly from an unreviewed one", () => {
    const verdict = classifySettlementActivation({
      spec: { ...terminalSpotSpecSample(), verification: { status: "REJECTED" } },
    });
    expect(verdict.status).toBe("SPEC_REJECTED");
    expect(verdict.refusals[0]?.code).toBe("SETTLEMENT_SPEC_REJECTED");
  });

  it("blocks activation on a structurally invalid spec", () => {
    const verdict = classifySettlementActivation({ spec: { settlementSpecId: "not-a-uuid" } });
    expect(verdict.status).toBe("SPEC_INVALID");
    expect(verdict.refusals[0]?.code).toBe("SETTLEMENT_SPEC_INVALID");
  });

  // Round-1 review, M1: each of these was previously accepted AND classified
  // REVIEWED_MODEL_BACKED with a verified verification block. A placeholder in
  // a required policy field must never reach the permitted status.
  it.each([
    "TBD - complete after review",
    "to be determined",
    "???",
    "not specified",
    "N / A",
    "TODO: write the dispute policy",
    "not applicable",
  ])("never permits activation on the placeholder policy %j (round-1, M1)", (placeholder) => {
    const verdict = classifySettlementActivation({
      spec: { ...verifiedSpec(terminalSpotSpecSample()), disputePolicy: placeholder },
    });
    expect(verdict.status).toBe("SPEC_INVALID");
    expect(verdict.modelDependentActivationAllowed).toBe(false);
  });

  // Round-2 review, M1: the same shared fixture list `spec.test.ts` pins at
  // construction, pinned here at the ACTIVATION gate — a placeholder policy on
  // an otherwise verified spec must never reach REVIEWED_MODEL_BACKED. The
  // four reviewer probes head the list.
  it.each([...PLACEHOLDER_POLICY_ATTACK_SAMPLES])(
    "never permits activation on the placeholder policy %j (round-2, M1)",
    (placeholder) => {
      const verdict = classifySettlementActivation({
        spec: { ...verifiedSpec(terminalSpotSpecSample()), disputePolicy: placeholder },
      });
      expect(verdict.status).toBe("SPEC_INVALID");
      expect(verdict.modelDependentActivationAllowed).toBe(false);
    },
  );

  it.each([...LEGITIMATE_POLICY_SAMPLES])(
    "still permits activation with the legitimate policy %j (round-2, M1 boundary)",
    (policy) => {
      const verdict = classifySettlementActivation({
        spec: { ...verifiedSpec(terminalSpotSpecSample()), disputePolicy: policy },
      });
      expect(verdict.status).toBe("REVIEWED_MODEL_BACKED");
      expect(verdict.modelDependentActivationAllowed).toBe(true);
    },
  );

  // Round-7 review, R7-M1: the generated 256-value stopword pair matrix (all
  // pairs of {the, a, an, to} across the four encodings — plain, dotted,
  // whitespace-split, U+200B-split) pinned at the ACTIVATION gate, matching
  // the matcher/construction pins in spec.test.ts. 37 of these were live
  // activation bypasses at the round-7 candidate — all with a
  // whitespace-split neighbor whose single-letter run joined into an opaque
  // blob ("t h e t o" -> "theto").
  it("never permits activation on any generated stopword pair matrix value (round-7, R7-M1)", () => {
    const bypasses = stopwordPairEncodingMatrix().filter((value) => {
      const verdict = classifySettlementActivation({
        spec: { ...verifiedSpec(terminalSpotSpecSample()), disputePolicy: value },
      });
      return verdict.status !== "SPEC_INVALID" || verdict.modelDependentActivationAllowed;
    });
    expect(bypasses).toEqual([]);
  });

  it("blocks activation when the observation type has no implementing model", () => {
    const verdict = classifySettlementActivation({
      spec: {
        ...without(verifiedSpec(terminalSpotSpecSample()), "payoffModel"),
        observationType: "EVENT_RESULT",
      },
    });

    expect(verdict.status).toBe("SPEC_NO_PAYOFF_MODEL");
    expect(verdict.refusals[0]?.code).toBe("SETTLEMENT_OBSERVATION_TYPE_HAS_NO_MODEL");
    expect(verdict.payoffModel).toBeUndefined();
  });

  it("blocks a spec that claims a review it cannot support", () => {
    const verdict = classifySettlementActivation({
      spec: without(verifiedSpec(terminalSpotSpecSample()), "rulesVersionId"),
    });

    expect(verdict.status).toBe("SPEC_VERIFICATION_UNSOUND");
    expect(verdict.refusals.map((refusal) => refusal.code)).toEqual([
      "SETTLEMENT_RULES_VERSION_REQUIRED",
    ]);
  });

  it("blocks a verified TWAP spec whose window the feed no longer publishes (ADR-009 §6)", () => {
    const spec = verifiedSpec({ ...twapSpecSample(), windowSeconds: 45 });

    const withoutContext = classifySettlementActivation({ spec });
    expect(withoutContext.status).toBe("SPEC_VERIFICATION_UNSOUND");
    expect(withoutContext.refusals[0]?.code).toBe("SETTLEMENT_PUBLISHED_WINDOWS_UNKNOWN");

    const withContext = classifySettlementActivation({ spec, reviewContext: publishedWindows });
    expect(withContext.status).toBe("SPEC_VERIFICATION_UNSOUND");
    expect(withContext.refusals[0]?.code).toBe("SETTLEMENT_WINDOW_NOT_PUBLISHED");
  });

  it("permits a verified TWAP spec on a published window", () => {
    const verdict = classifySettlementActivation({
      spec: verifiedSpec(twapSpecSample()),
      reviewContext: publishedWindows,
    });
    expect(verdict.status).toBe("REVIEWED_MODEL_BACKED");
    expect(verdict.payoffModel).toBe("TwapBinaryModel");
  });

  it("permits exactly one status, and every other status carries a reason", () => {
    const observed = new Map<SettlementActivationStatus, boolean>();
    const cases: readonly SettlementActivationInput[] = [
      { spec: verifiedSpec(terminalSpotSpecSample()) },
      {},
      { spec: { nonsense: true } },
      {
        spec: {
          ...without(verifiedSpec(terminalSpotSpecSample()), "payoffModel"),
          observationType: "VWAP",
          windowSeconds: 30,
          windowStartRule: "Thirty seconds before close.",
          windowEndRule: "The close instant.",
        },
      },
      { spec: terminalSpotSpecSample() },
      { spec: { ...terminalSpotSpecSample(), verification: { status: "REJECTED" } } },
      { spec: without(verifiedSpec(terminalSpotSpecSample()), "rulesVersionId") },
    ];

    for (const input of cases) {
      const verdict = classifySettlementActivation(input);
      observed.set(verdict.status, verdict.modelDependentActivationAllowed);
      if (verdict.status === ACTIVATION_PERMITTED_STATUS) {
        expect(verdict.refusals).toEqual([]);
      } else {
        expect(verdict.refusals.length).toBeGreaterThan(0);
      }
    }

    // Every status in the published union is reachable, and only one permits.
    expect([...observed.keys()].sort()).toEqual([...SETTLEMENT_ACTIVATION_STATUSES].sort());
    expect([...observed.entries()].filter(([, allowed]) => allowed)).toEqual([
      [ACTIVATION_PERMITTED_STATUS, true],
    ]);
  });

  it("returns a frozen verdict", () => {
    const verdict = classifySettlementActivation({ spec: terminalSpotSpecSample() });
    expect(Object.isFrozen(verdict)).toBe(true);
    expect(Object.isFrozen(verdict.refusals)).toBe(true);
  });
});
