/**
 * The compatibility matrix is walked in full: all 5 observation types × 4 payoff
 * models. Sampling would be the wrong test here — the point of §9.3's rule is
 * that the WRONG cell is silent, so every cell states its verdict.
 */

import { describe, expect, it } from "vitest";

import {
  checkPayoffModelCompatibility,
  isCompatiblePayoffModel,
  observationTypesForPayoffModel,
  payoffModelRequirements,
  payoffModelsForObservationType,
  type PayoffModelSpecView,
} from "./compatibility.js";
import { OBSERVATION_TYPES, PAYOFF_MODEL_IDS } from "../vocabulary.js";
import type { ObservationType, PayoffModelId } from "../vocabulary.js";

/** The matrix, restated independently of the implementation. */
const EXPECTED_MODELS: Readonly<Record<ObservationType, readonly PayoffModelId[]>> = {
  TERMINAL_SPOT: [
    "TerminalSpotBinaryModel",
    "ReferenceOpenUpDownModel",
    "ThresholdByDateModel",
  ],
  TWAP: ["TwapBinaryModel", "ReferenceOpenUpDownModel"],
  VWAP: [],
  EVENT_RESULT: [],
  MANUAL_ORACLE: [],
};

const ALL_FIELDS = {
  comparison: "GT",
  windowSeconds: 30,
  windowStartRule: "start rule",
  windowEndRule: "end rule",
  strikeSource: "strike rule",
  referenceOpenSource: "reference open rule",
} as const;

/** A spec view carrying exactly what the pair requires and nothing it forbids. */
function conformingView(
  observationType: ObservationType,
  payoffModel: PayoffModelId,
): PayoffModelSpecView {
  const requirements = payoffModelRequirements(observationType, payoffModel);
  const view: Record<string, unknown> = { observationType, payoffModel };
  for (const field of requirements?.required ?? []) {
    view[field] = ALL_FIELDS[field];
  }
  return view as unknown as PayoffModelSpecView;
}

describe("payoff-model compatibility matrix", () => {
  it("covers every observation type and every model", () => {
    expect(OBSERVATION_TYPES).toHaveLength(5);
    expect(PAYOFF_MODEL_IDS).toHaveLength(4);
  });

  for (const observationType of OBSERVATION_TYPES) {
    for (const payoffModel of PAYOFF_MODEL_IDS) {
      const compatible = EXPECTED_MODELS[observationType].includes(payoffModel);

      it(`${observationType} × ${payoffModel} is ${compatible ? "permitted" : "refused"}`, () => {
        expect(isCompatiblePayoffModel(observationType, payoffModel)).toBe(compatible);
        expect(payoffModelRequirements(observationType, payoffModel) !== undefined).toBe(
          compatible,
        );

        const refusals = checkPayoffModelCompatibility(
          conformingView(observationType, payoffModel),
        );
        if (compatible) {
          expect(refusals).toEqual([]);
        } else {
          expect(refusals.length).toBeGreaterThan(0);
        }
      });
    }
  }

  it("refuses a terminal-spot model on a TWAP market with its own code (§9.3, acceptance 1)", () => {
    const refusals = checkPayoffModelCompatibility({
      observationType: "TWAP",
      payoffModel: "TerminalSpotBinaryModel",
      comparison: "GT",
      strikeSource: "strike rule",
    });

    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.code).toBe("SETTLEMENT_TWAP_TERMINAL_SPOT_FORBIDDEN");
    expect(refusals[0]?.details["candidates"]).toEqual([
      "TwapBinaryModel",
      "ReferenceOpenUpDownModel",
    ]);
  });

  it("refuses every model for an observation type that has none (ADR-009 §2)", () => {
    for (const observationType of ["VWAP", "EVENT_RESULT", "MANUAL_ORACLE"] as const) {
      expect(payoffModelsForObservationType(observationType)).toEqual([]);
      for (const payoffModel of PAYOFF_MODEL_IDS) {
        const refusals = checkPayoffModelCompatibility({ observationType, payoffModel });
        expect(refusals[0]?.code).toBe("SETTLEMENT_OBSERVATION_TYPE_HAS_NO_MODEL");
      }
    }
  });

  it("reports a missing model as a required field when one could be chosen", () => {
    const refusals = checkPayoffModelCompatibility({ observationType: "TERMINAL_SPOT" });
    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.code).toBe("SETTLEMENT_SPEC_FIELD_REQUIRED");
    expect(refusals[0]?.details["field"]).toBe("payoffModel");
  });

  it("reports a missing model as 'no model exists' when none could be chosen", () => {
    const refusals = checkPayoffModelCompatibility({ observationType: "MANUAL_ORACLE" });
    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.code).toBe("SETTLEMENT_OBSERVATION_TYPE_HAS_NO_MODEL");
  });

  it("lists the observation types each model may settle", () => {
    expect(observationTypesForPayoffModel("TerminalSpotBinaryModel")).toEqual(["TERMINAL_SPOT"]);
    expect(observationTypesForPayoffModel("TwapBinaryModel")).toEqual(["TWAP"]);
    expect(observationTypesForPayoffModel("ReferenceOpenUpDownModel")).toEqual([
      "TERMINAL_SPOT",
      "TWAP",
    ]);
    expect(observationTypesForPayoffModel("ThresholdByDateModel")).toEqual(["TERMINAL_SPOT"]);
  });

  it("names every missing required field, not only the first", () => {
    const refusals = checkPayoffModelCompatibility({
      observationType: "TWAP",
      payoffModel: "TwapBinaryModel",
    });

    expect(refusals.map((refusal) => refusal.details["field"])).toEqual([
      "comparison",
      "strikeSource",
      "windowSeconds",
      "windowStartRule",
      "windowEndRule",
    ]);
    expect(new Set(refusals.map((refusal) => refusal.code))).toEqual(
      new Set(["SETTLEMENT_SPEC_FIELD_REQUIRED"]),
    );
  });

  it("refuses a field the model forbids, because it makes the settlement value ambiguous", () => {
    const refusals = checkPayoffModelCompatibility({
      observationType: "TERMINAL_SPOT",
      payoffModel: "ReferenceOpenUpDownModel",
      comparison: "GT",
      referenceOpenSource: "reference open rule",
      strikeSource: "a second, contradictory strike",
    });

    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.code).toBe("SETTLEMENT_SPEC_FIELD_FORBIDDEN");
    expect(refusals[0]?.details["field"]).toBe("strikeSource");
  });

  it("refuses an averaging window on a terminal-spot model", () => {
    const refusals = checkPayoffModelCompatibility({
      observationType: "TERMINAL_SPOT",
      payoffModel: "TerminalSpotBinaryModel",
      comparison: "GT",
      strikeSource: "strike rule",
      windowSeconds: 30,
    });

    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.code).toBe("SETTLEMENT_SPEC_FIELD_FORBIDDEN");
    expect(refusals[0]?.details["field"]).toBe("windowSeconds");
  });

  it("returns frozen refusals", () => {
    const refusals = checkPayoffModelCompatibility({ observationType: "VWAP" });
    expect(Object.isFrozen(refusals)).toBe(true);
    expect(Object.isFrozen(refusals[0])).toBe(true);
  });
});
