import { describe, expect, it } from "vitest";

import {
  BasketFailurePolicySchema,
  BasketIntentSchema,
  BasketLegSchema,
  CancelIntentSchema,
  IntentSchema,
  IntentTypeSchema,
  LiquidityPreferenceSchema,
  PartialFillPolicySchema,
  PositionIntentSchema,
  PositionTargetModeSchema,
  PositionUrgencySchema,
  QuoteIntentSchema,
  QuoteLevelSchema,
  ReducePositionIntentSchema,
  ReductionUrgencySchema,
} from "./intents.js";
import {
  SAMPLE_BASKET_INTENT,
  SAMPLE_CANCEL_INTENT,
  SAMPLE_POSITION_INTENT,
  SAMPLE_QUOTE_INTENT,
  SAMPLE_REDUCE_POSITION_INTENT,
} from "./testing/samples.js";

describe("intent enumerations reproduce §7.7 exactly", () => {
  it("intent types", () => {
    expect(IntentTypeSchema.options).toEqual([
      "POSITION",
      "QUOTE",
      "BASKET",
      "CANCEL",
      "REDUCE_POSITION",
    ]);
  });

  it("position target modes", () => {
    expect(PositionTargetModeSchema.options).toEqual(["DELTA", "ABSOLUTE"]);
  });

  it("position urgency", () => {
    expect(PositionUrgencySchema.options).toEqual([
      "PASSIVE",
      "NORMAL",
      "AGGRESSIVE",
      "IMMEDIATE",
    ]);
  });

  it("liquidity preference", () => {
    expect(LiquidityPreferenceSchema.options).toEqual([
      "MAKER_ONLY",
      "MAKER_PREFERRED",
      "TAKER_OK",
      "TAKER_ONLY",
    ]);
  });

  it("partial fill policy", () => {
    expect(PartialFillPolicySchema.options).toEqual(["REJECT", "ACCEPT_ANY", "ACCEPT_MINIMUM"]);
  });

  it("reduction urgency is narrower than position urgency", () => {
    expect(ReductionUrgencySchema.options).toEqual(["NORMAL", "AGGRESSIVE", "IMMEDIATE"]);
    expect(ReductionUrgencySchema.safeParse("PASSIVE").success).toBe(false);
    expect(PositionUrgencySchema.safeParse("PASSIVE").success).toBe(true);
  });

  it("basket failure policy", () => {
    expect(BasketFailurePolicySchema.options).toEqual([
      "ABANDON",
      "PROTECTED_UNWIND",
      "HOLD_FILLED_LEGS",
    ]);
  });
});

describe("PositionIntent (§7.7)", () => {
  it("accepts a valid intent", () => {
    expect(PositionIntentSchema.safeParse(SAMPLE_POSITION_INTENT).success).toBe(true);
  });

  it("accepts a negative DELTA target", () => {
    expect(
      PositionIntentSchema.safeParse({
        ...SAMPLE_POSITION_INTENT,
        targetMode: "DELTA",
        targetShares: "-50",
      }).success,
    ).toBe(true);
  });

  const requiredFields = [
    "type",
    "intentId",
    "marketId",
    "direction",
    "targetMode",
    "targetShares",
    "urgency",
    "liquidityPreference",
    "partialFillPolicy",
    "validUntil",
    "tags",
  ] as const;

  it.each(requiredFields)("rejects an intent missing %s", (field) => {
    const intent: Record<string, unknown> = { ...SAMPLE_POSITION_INTENT };
    delete intent[field];
    expect(PositionIntentSchema.safeParse(intent).success).toBe(false);
  });

  const optionalFields = [
    "maximumBuyPrice",
    "maximumTotalCost",
    "minimumFillShares",
    "expectedProbability",
    "expectedNetEdge",
  ] as const;

  it.each(optionalFields)("allows %s to be absent", (field) => {
    const intent: Record<string, unknown> = { ...SAMPLE_POSITION_INTENT };
    delete intent[field];
    expect(PositionIntentSchema.safeParse(intent).success).toBe(true);
  });

  const economicFields = [
    "targetShares",
    "maximumBuyPrice",
    "maximumTotalCost",
    "minimumFillShares",
    "expectedProbability",
    "expectedNetEdge",
  ] as const;

  it.each(economicFields)("rejects a JavaScript number for %s", (field) => {
    expect(
      PositionIntentSchema.safeParse({ ...SAMPLE_POSITION_INTENT, [field]: 1.5 }).success,
    ).toBe(false);
    expect(
      PositionIntentSchema.safeParse({ ...SAMPLE_POSITION_INTENT, [field]: "1e5" }).success,
    ).toBe(false);
    expect(
      PositionIntentSchema.safeParse({ ...SAMPLE_POSITION_INTENT, [field]: "1.50" }).success,
    ).toBe(false);
  });

  it("constrains prices and probabilities to [0, 1]", () => {
    for (const field of ["maximumBuyPrice", "minimumSellPrice", "expectedProbability"] as const) {
      expect(
        PositionIntentSchema.safeParse({ ...SAMPLE_POSITION_INTENT, [field]: "1.5" }).success,
      ).toBe(false);
    }
  });

  it("rejects a negative cost cap", () => {
    expect(
      PositionIntentSchema.safeParse({ ...SAMPLE_POSITION_INTENT, maximumTotalCost: "-1" })
        .success,
    ).toBe(false);
  });

  it("rejects unknown fields and bad enum values", () => {
    expect(
      PositionIntentSchema.safeParse({ ...SAMPLE_POSITION_INTENT, extra: true }).success,
    ).toBe(false);
    expect(
      PositionIntentSchema.safeParse({ ...SAMPLE_POSITION_INTENT, urgency: "URGENT" }).success,
    ).toBe(false);
    expect(
      PositionIntentSchema.safeParse({ ...SAMPLE_POSITION_INTENT, direction: "MAYBE" }).success,
    ).toBe(false);
    expect(
      PositionIntentSchema.safeParse({ ...SAMPLE_POSITION_INTENT, type: "POSITIONS" }).success,
    ).toBe(false);
  });

  it("rejects an invalid validUntil timestamp", () => {
    expect(
      PositionIntentSchema.safeParse({ ...SAMPLE_POSITION_INTENT, validUntil: "soon" }).success,
    ).toBe(false);
    expect(
      PositionIntentSchema.safeParse({ ...SAMPLE_POSITION_INTENT, validUntil: 1 }).success,
    ).toBe(false);
  });
});

describe("QuoteIntent (§7.7)", () => {
  it("accepts a valid intent", () => {
    expect(QuoteIntentSchema.safeParse(SAMPLE_QUOTE_INTENT).success).toBe(true);
  });

  it("requires postOnly to be literally true", () => {
    expect(QuoteIntentSchema.safeParse({ ...SAMPLE_QUOTE_INTENT, postOnly: false }).success).toBe(
      false,
    );
    const intent: Record<string, unknown> = { ...SAMPLE_QUOTE_INTENT };
    delete intent["postOnly"];
    expect(QuoteIntentSchema.safeParse(intent).success).toBe(false);
  });

  it("validates quote levels", () => {
    expect(QuoteLevelSchema.safeParse({ price: "0.5", shares: "10" }).success).toBe(true);
    expect(QuoteLevelSchema.safeParse({ price: 0.5, shares: "10" }).success).toBe(false);
    expect(QuoteLevelSchema.safeParse({ price: "0.5", shares: -10 }).success).toBe(false);
    expect(QuoteLevelSchema.safeParse({ price: "0.5", shares: "-10" }).success).toBe(false);
    expect(QuoteLevelSchema.safeParse({ price: "1.5", shares: "10" }).success).toBe(false);
    expect(
      QuoteIntentSchema.safeParse({
        ...SAMPLE_QUOTE_INTENT,
        bids: [{ price: 0.51, shares: "100" }],
      }).success,
    ).toBe(false);
  });

  it("accepts empty quote sides", () => {
    expect(
      QuoteIntentSchema.safeParse({ ...SAMPLE_QUOTE_INTENT, bids: [], asks: [] }).success,
    ).toBe(true);
  });

  it("keeps durations and tick counts as integers, not decimals", () => {
    expect(
      QuoteIntentSchema.safeParse({ ...SAMPLE_QUOTE_INTENT, quoteLifetimeMs: "2000" }).success,
    ).toBe(false);
    expect(
      QuoteIntentSchema.safeParse({ ...SAMPLE_QUOTE_INTENT, quoteLifetimeMs: 0 }).success,
    ).toBe(false);
    expect(
      QuoteIntentSchema.safeParse({ ...SAMPLE_QUOTE_INTENT, quoteLifetimeMs: 1.5 }).success,
    ).toBe(false);
    expect(
      QuoteIntentSchema.safeParse({ ...SAMPLE_QUOTE_INTENT, replaceThresholdTicks: -1 }).success,
    ).toBe(false);
    expect(
      QuoteIntentSchema.safeParse({ ...SAMPLE_QUOTE_INTENT, replaceThresholdTicks: 0 }).success,
    ).toBe(true);
  });

  it("rejects a number or negative value for maximumInventory", () => {
    expect(
      QuoteIntentSchema.safeParse({ ...SAMPLE_QUOTE_INTENT, maximumInventory: 500 }).success,
    ).toBe(false);
    expect(
      QuoteIntentSchema.safeParse({ ...SAMPLE_QUOTE_INTENT, maximumInventory: "-1" }).success,
    ).toBe(false);
  });
});

describe("BasketIntent (§7.7)", () => {
  it("accepts a valid intent", () => {
    expect(BasketIntentSchema.safeParse(SAMPLE_BASKET_INTENT).success).toBe(true);
  });

  it("validates legs", () => {
    expect(BasketLegSchema.safeParse(SAMPLE_BASKET_INTENT.legs[0]).success).toBe(true);
    expect(
      BasketLegSchema.safeParse({ ...SAMPLE_BASKET_INTENT.legs[0], targetShares: 100 }).success,
    ).toBe(false);
    expect(
      BasketLegSchema.safeParse({ ...SAMPLE_BASKET_INTENT.legs[0], marketId: "market-1" })
        .success,
    ).toBe(false);
  });

  it.each(["maximumCombinedCost", "minimumLockedEdge", "legRiskLimit"] as const)(
    "rejects a JavaScript number for %s",
    (field) => {
      expect(BasketIntentSchema.safeParse({ ...SAMPLE_BASKET_INTENT, [field]: 99 }).success).toBe(
        false,
      );
    },
  );

  it("rejects an unknown failure policy", () => {
    expect(
      BasketIntentSchema.safeParse({ ...SAMPLE_BASKET_INTENT, failurePolicy: "RETRY" }).success,
    ).toBe(false);
  });

  it.each(["legs", "maximumCombinedCost", "minimumLockedEdge", "legRiskLimit", "failurePolicy", "validUntil"] as const)(
    "rejects a basket missing %s",
    (field) => {
      const intent: Record<string, unknown> = { ...SAMPLE_BASKET_INTENT };
      delete intent[field];
      expect(BasketIntentSchema.safeParse(intent).success).toBe(false);
    },
  );
});

describe("CancelIntent and ReducePositionIntent (§7.7)", () => {
  it("accepts a valid cancel intent", () => {
    expect(CancelIntentSchema.safeParse(SAMPLE_CANCEL_INTENT).success).toBe(true);
  });

  it("allows a scope-wide cancel with neither market nor order ids", () => {
    expect(
      CancelIntentSchema.safeParse({ type: "CANCEL", reason: "global kill switch" }).success,
    ).toBe(true);
  });

  it("requires a cancel reason", () => {
    expect(CancelIntentSchema.safeParse({ type: "CANCEL" }).success).toBe(false);
    expect(CancelIntentSchema.safeParse({ type: "CANCEL", reason: "" }).success).toBe(false);
  });

  it("accepts a valid reduction intent", () => {
    expect(ReducePositionIntentSchema.safeParse(SAMPLE_REDUCE_POSITION_INTENT).success).toBe(true);
  });

  it("rejects a reduction with a number target or a passive urgency", () => {
    expect(
      ReducePositionIntentSchema.safeParse({
        ...SAMPLE_REDUCE_POSITION_INTENT,
        targetShares: 0,
      }).success,
    ).toBe(false);
    expect(
      ReducePositionIntentSchema.safeParse({
        ...SAMPLE_REDUCE_POSITION_INTENT,
        urgency: "PASSIVE",
      }).success,
    ).toBe(false);
  });

  it.each(["marketId", "targetShares", "urgency", "reason"] as const)(
    "rejects a reduction missing %s",
    (field) => {
      const intent: Record<string, unknown> = { ...SAMPLE_REDUCE_POSITION_INTENT };
      delete intent[field];
      expect(ReducePositionIntentSchema.safeParse(intent).success).toBe(false);
    },
  );
});

describe("the intent union", () => {
  it("discriminates on type", () => {
    for (const intent of [
      SAMPLE_POSITION_INTENT,
      SAMPLE_QUOTE_INTENT,
      SAMPLE_BASKET_INTENT,
      SAMPLE_CANCEL_INTENT,
      SAMPLE_REDUCE_POSITION_INTENT,
    ]) {
      const parsed = IntentSchema.safeParse(intent);
      expect(parsed.success, `${intent.type} failed the union`).toBe(true);
    }
  });

  it("rejects an unknown intent type", () => {
    expect(IntentSchema.safeParse({ type: "SPLIT", reason: "x" }).success).toBe(false);
  });

  it("rejects a payload that matches no member", () => {
    expect(IntentSchema.safeParse({}).success).toBe(false);
    expect(IntentSchema.safeParse(null).success).toBe(false);
  });
});
