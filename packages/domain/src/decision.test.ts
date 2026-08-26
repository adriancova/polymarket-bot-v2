import { describe, expect, it } from "vitest";

import { DecisionResultSchema, DecisionTypeSchema } from "./decision.js";
import { DECISION_RESULT_SCHEMA_VERSION, DOMAIN_CONTRACT_VERSIONS } from "./schema-version.js";
import {
  SAMPLE_HOLD_DECISION,
  SAMPLE_POSITION_INTENT,
  SAMPLE_QUOTE_INTENT,
} from "./testing/samples.js";

describe("DecisionResult (handoff §7.5)", () => {
  it("enumerates exactly the specified decision types", () => {
    expect(DecisionTypeSchema.options).toEqual([
      "enter",
      "exit",
      "quote",
      "hold",
      "skip",
      "cancel",
      "reduce",
    ]);
    expect(DecisionTypeSchema.safeParse("ENTER").success).toBe(false);
  });

  it("persists zero intents (acceptance criterion 5)", () => {
    const parsed = DecisionResultSchema.parse(SAMPLE_HOLD_DECISION);
    expect(parsed.intents).toEqual([]);
    expect(parsed.decisionType).toBe("hold");
  });

  it("persists one or more intents", () => {
    const one = DecisionResultSchema.parse({
      ...SAMPLE_HOLD_DECISION,
      decisionType: "enter",
      intents: [SAMPLE_POSITION_INTENT],
    });
    expect(one.intents).toHaveLength(1);

    const two = DecisionResultSchema.parse({
      ...SAMPLE_HOLD_DECISION,
      decisionType: "quote",
      intents: [SAMPLE_POSITION_INTENT, SAMPLE_QUOTE_INTENT],
    });
    expect(two.intents).toHaveLength(2);
  });

  it("rejects an invalid intent inside an otherwise valid result", () => {
    expect(
      DecisionResultSchema.safeParse({
        ...SAMPLE_HOLD_DECISION,
        intents: [{ ...SAMPLE_POSITION_INTENT, targetShares: 100 }],
      }).success,
    ).toBe(false);
  });

  it.each(["decisionType", "reasonCodes", "featureSnapshotRef", "intents"] as const)(
    "requires %s",
    (field) => {
      const decision: Record<string, unknown> = { ...SAMPLE_HOLD_DECISION };
      delete decision[field];
      expect(DecisionResultSchema.safeParse(decision).success).toBe(false);
    },
  );

  it("accepts an empty reason-code list but not malformed codes", () => {
    expect(
      DecisionResultSchema.safeParse({ ...SAMPLE_HOLD_DECISION, reasonCodes: [] }).success,
    ).toBe(true);
    expect(
      DecisionResultSchema.safeParse({ ...SAMPLE_HOLD_DECISION, reasonCodes: ["no edge"] })
        .success,
    ).toBe(false);
    expect(
      DecisionResultSchema.safeParse({ ...SAMPLE_HOLD_DECISION, reasonCodes: [1] }).success,
    ).toBe(false);
  });

  it("accepts the optional fields", () => {
    const parsed = DecisionResultSchema.parse({
      ...SAMPLE_HOLD_DECISION,
      modelOutputs: { edge: "0.012", stale: false, note: "ok", missing: null },
      statePatch: { bracketState: "ARMED", attempts: 2 },
      nextWakeupAt: "2026-08-26T12:00:05.000Z",
    });
    expect(parsed.modelOutputs?.["edge"]).toBe("0.012");
    expect(parsed.statePatch?.["attempts"]).toBe(2);
  });

  it("rejects a JavaScript number as a model output value", () => {
    expect(
      DecisionResultSchema.safeParse({
        ...SAMPLE_HOLD_DECISION,
        modelOutputs: { edge: 0.012 },
      }).success,
    ).toBe(false);
  });

  it("rejects unknown top-level keys", () => {
    expect(
      DecisionResultSchema.safeParse({ ...SAMPLE_HOLD_DECISION, loggedAt: "now" }).success,
    ).toBe(false);
  });

  it("rejects an invalid nextWakeupAt", () => {
    expect(
      DecisionResultSchema.safeParse({ ...SAMPLE_HOLD_DECISION, nextWakeupAt: "later" }).success,
    ).toBe(false);
  });

  it("carries an explicit contract version", () => {
    expect(DECISION_RESULT_SCHEMA_VERSION).toBe(1);
    expect(DOMAIN_CONTRACT_VERSIONS.DecisionResult).toBe(DECISION_RESULT_SCHEMA_VERSION);
  });
});
