/**
 * WP-210 acceptance 4: **paper fills are not labeled real evidence**
 * (§12.2, ADR-012 §1 and §2).
 *
 * The three enforcement points, each measured:
 *
 * 1. Every simulated fill carries `evidenceClass: "SIMULATED_NOT_REAL_EVIDENCE"`
 *    and its `fillModelVersion`, and the class is a ONE-MEMBER union, so no
 *    simulated value is assignable where observed venue evidence is expected.
 * 2. Tier 0 is `deploymentDecisionUse: "FORBIDDEN"` and
 *    `quoteForDeploymentDecision` refuses it — at COMPILE time by the parameter
 *    type, and at runtime for a value laundered through `any`.
 * 3. A Tier-1 resting result is a BAND. There is no exported function returning
 *    a single resting fill, so "one falsely precise fill result" is not
 *    constructible; the band's own ordering is asserted, and a mis-ordered one
 *    is refused rather than reported.
 *
 * The suite also pins that nothing in this package is fitted to observed venue
 * behaviour: ADR-012 §7 records that no execution probe or live-micro run has
 * occurred, and every model identity says `UNCALIBRATED_NO_PROBE_DATA_EXISTS` on
 * its face.
 */

import { describe, expect, it } from "vitest";

import {
  QUEUE_SCENARIOS,
  SIMULATED_EVIDENCE_CLASS,
  checkBandOrdering,
  quoteForDeploymentDecision,
  readQueueModelParameters,
  simulateResting,
  simulatedFill,
  tier0Immediate,
  tier0Model,
  tier1Model,
  type FeeScheduleSnapshot,
  type QueueModelParameters,
  type RestingFillBand,
} from "../../../packages/simulation/src/index.js";

const FEES: FeeScheduleSnapshot = {
  snapshotVersion: "fees/2026-08-24",
  takerFeeRate: "0.07",
  makerFeeRate: "0",
  roundingDecimalPlaces: 5,
  roundingMode: "HALF_UP",
  minimumChargedFee: "0.00001",
  feeCurrency: "USDC",
};

const AT_EVENT = {
  gatewayEpoch: "0190a3e0-0000-7000-8000-000000000001",
  ingestSeq: "1",
  receivedAt: "2026-01-01T00:00:00.000Z",
  datasetRowOrdinal: 0,
};

const QUEUE_PARAMETERS: QueueModelParameters = {
  queueModelVersion: "sim/queue/v1",
  cancellationRatio: { OPTIMISTIC: "0.5", BASE: "0.1", CONSERVATIVE: "0" },
  cancelEffectiveAfterMs: { OPTIMISTIC: 10, BASE: 50, CONSERVATIVE: 250 },
  placedBehindSameInstantAdditions: { OPTIMISTIC: false, BASE: false, CONSERVATIVE: true },
  basis: "ASSUMED_NOT_MEASURED_NO_PROBE_DATA_EXISTS",
};

function book(levels: readonly { price: string; size: string }[]) {
  return {
    internalMarketId: "0190a3e0-0000-7000-8000-00000000000a",
    tokenId: "1234",
    top: () => ({}),
    ladder: () => levels,
  };
}

describe("every simulated fill is labelled as not-real evidence", () => {
  it("carries the one-member evidence class and its fill-model version", () => {
    const model = tier0Model({
      fillModelVersion: "sim/tier0/v1",
      fillModelParametersHash: "0".repeat(64),
    });
    const outcome = tier0Immediate({
      model,
      book: book([{ price: "0.5", size: "100" }]),
      simulatedOrderId: "o-1",
      marketId: "0190a3e0-0000-7000-8000-00000000000a",
      side: "YES",
      action: "BUY",
      limitPrice: "0.6",
      shares: "10",
      feeSnapshot: FEES,
      atEvent: AT_EVENT,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.fills).toHaveLength(1);
    for (const produced of outcome.value.fills) {
      expect(produced.evidenceClass).toBe(SIMULATED_EVIDENCE_CLASS);
      expect(produced.evidenceClass).toBe("SIMULATED_NOT_REAL_EVIDENCE");
      expect(produced.fillModelVersion).toBe("sim/tier0/v1");
      expect(produced.model.calibration).toBe("UNCALIBRATED_NO_PROBE_DATA_EXISTS");
      expect(produced.planningDepthAwareness).toBe("TOP_OF_BOOK_ONLY");
    }
  });

  it("the label is not removable: the constructor always applies it", () => {
    const model = tier1Model({
      fillModelVersion: "sim/tier1/v1",
      fillModelParametersHash: "0".repeat(64),
    });
    const produced = simulatedFill({
      simulatedFillId: "f",
      simulatedOrderId: "o",
      marketId: "m",
      tokenId: "1",
      side: "YES",
      action: "BUY",
      price: "0.5",
      shares: "1",
      feeAmount: "0",
      liquidityRole: "TAKER",
      model,
      atEvent: AT_EVENT,
      // A caller trying to relabel it is ignored: `simulatedFill` sets the
      // class AFTER spreading its input, so the last write wins and it is the
      // constructor's. The cast is what a caller defeating the parameter type
      // would have to write, so the probe measures the runtime behaviour rather
      // than the type.
      ...({ evidenceClass: "REAL_VENUE_OBSERVATION" } as unknown as Record<string, never>),
    });
    expect(produced.evidenceClass).toBe("SIMULATED_NOT_REAL_EVIDENCE");
  });
});

describe("Tier 0 is never used for deployment decisions (§12.2)", () => {
  it("says so on its own model identity", () => {
    const model = tier0Model({
      fillModelVersion: "sim/tier0/v1",
      fillModelParametersHash: "0".repeat(64),
    });
    expect(model.permittedUse).toBe("WIRING_AND_REGRESSION_ONLY");
    expect(model.deploymentDecisionUse).toBe("FORBIDDEN");
  });

  it("is refused by quoteForDeploymentDecision even when laundered through any", () => {
    const model = tier0Model({
      fillModelVersion: "sim/tier0/v1",
      fillModelParametersHash: "0".repeat(64),
    });
    // The compile-time gate is the parameter type; a caller that defeats it with
    // a cast still meets the runtime guard. Both are asserted, because a future
    // refactor could weaken either one alone.
    const laundered = { model } as unknown as never;
    const outcome = quoteForDeploymentDecision(laundered);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal.message).toContain("Tier-0");
    expect(outcome.refusal.message).toContain("deployment decision");
  });

  it("accepts a Tier-1 band, which is permitted AS A BAND", () => {
    const model = tier1Model({
      fillModelVersion: "sim/tier1/v1",
      fillModelParametersHash: "0".repeat(64),
    });
    expect(model.permittedUse).toBe("RESEARCH_AND_COMPARISON_BAND_ONLY");
    expect(model.deploymentDecisionUse).toBe("PERMITTED_AS_BAND");
    const outcome = quoteForDeploymentDecision({ model });
    expect(outcome.ok).toBe(true);
  });
});

describe("a Tier-1 resting result is a BAND, never one falsely precise fill", () => {
  const model = tier1Model({
    fillModelVersion: "sim/tier1/v1",
    fillModelParametersHash: "0".repeat(64),
  });

  function restingBand(): RestingFillBand {
    const outcome = simulateResting({
      model,
      order: {
        simulatedOrderId: "o-1",
        marketId: "0190a3e0-0000-7000-8000-00000000000a",
        tokenId: "1234",
        side: "YES",
        action: "BUY",
        restingPrice: "0.5",
        shares: "100",
        queueAheadAtPlacement: "200",
        sameInstantAdditionsShares: "50",
        restingFromNs: 0n,
      },
      trades: [
        { price: "0.5", shares: "120", monotonicNs: 1_000n, atEvent: AT_EVENT },
        { price: "0.5", shares: "120", monotonicNs: 2_000n, atEvent: AT_EVENT },
      ],
      parameters: QUEUE_PARAMETERS,
      feeSnapshot: FEES,
    });
    if (!outcome.ok) throw new Error(`resting refused: ${outcome.refusal.message}`);
    return outcome.value;
  }

  it("returns all three §12.2 scenarios with the quotation rule on the value", () => {
    const band = restingBand();
    expect(QUEUE_SCENARIOS).toEqual(["OPTIMISTIC", "BASE", "CONSERVATIVE"]);
    expect(band.optimistic.scenario).toBe("OPTIMISTIC");
    expect(band.base.scenario).toBe("BASE");
    expect(band.conservative.scenario).toBe("CONSERVATIVE");
    expect(band.bandBasis).toBe("OPTIMISTIC_BASE_CONSERVATIVE_CANCELLATION_ASSUMPTIONS");
    expect(band.quotationRule).toBe("REPORT_THE_BAND_NEVER_ONE_MEMBER");
  });

  it("the three scenarios actually DIFFER — a band of one number is not a band", () => {
    const band = restingBand();
    const filled = [
      band.optimistic.filledShares,
      band.base.filledShares,
      band.conservative.filledShares,
    ];
    expect(new Set(filled).size).toBeGreaterThan(1);
  });

  it("is ordered OPTIMISTIC >= BASE >= CONSERVATIVE", () => {
    const band = restingBand();
    expect(Number(band.optimistic.filledShares)).toBeGreaterThanOrEqual(
      Number(band.base.filledShares),
    );
    expect(Number(band.base.filledShares)).toBeGreaterThanOrEqual(
      Number(band.conservative.filledShares),
    );
  });

  it("refuses a mis-ordered band rather than reporting it", () => {
    const band = restingBand();
    const inverted = {
      ...band,
      optimistic: { ...band.optimistic, filledShares: "0" },
      conservative: { ...band.conservative, filledShares: "100" },
    };
    const outcome = checkBandOrdering(inverted);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal.code).toBe("FILL_MODEL_BAND_INCONSISTENT");
  });

  it("refuses queue parameters whose ordering would invert the band", () => {
    const inverted = readQueueModelParameters({
      ...QUEUE_PARAMETERS,
      cancellationRatio: { OPTIMISTIC: "0", BASE: "0.1", CONSERVATIVE: "0.5" },
    });
    expect(inverted.ok).toBe(false);
    if (inverted.ok) return;
    expect(inverted.refusal.code).toBe("FILL_MODEL_PARAMETERS_UNPINNED");
    expect(inverted.refusal.message).toContain("OPTIMISTIC >= BASE >= CONSERVATIVE");
  });

  it("refuses an optimistic scenario that assumes placement behind additions", () => {
    const wrong = readQueueModelParameters({
      ...QUEUE_PARAMETERS,
      placedBehindSameInstantAdditions: { OPTIMISTIC: true, BASE: false, CONSERVATIVE: true },
    });
    expect(wrong.ok).toBe(false);
    if (wrong.ok) return;
    expect(wrong.refusal.message).toContain("inverts the band");
  });

  it("refuses a Tier-0 identity for the queue model", () => {
    const outcome = simulateResting({
      model: tier0Model({ fillModelVersion: "t0", fillModelParametersHash: "0".repeat(64) }),
      order: {
        simulatedOrderId: "o-1",
        marketId: "m",
        tokenId: "1",
        side: "YES",
        action: "BUY",
        restingPrice: "0.5",
        shares: "10",
        queueAheadAtPlacement: "0",
        sameInstantAdditionsShares: "0",
        restingFromNs: 0n,
      },
      trades: [],
      parameters: QUEUE_PARAMETERS,
      feeSnapshot: FEES,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal.message).toContain("Tier 1");
  });
});

describe("nothing here is calibrated, and it says so", () => {
  it("every model identity records that no probe data exists (ADR-012 §7)", () => {
    for (const model of [
      tier0Model({ fillModelVersion: "a", fillModelParametersHash: "0".repeat(64) }),
      tier1Model({ fillModelVersion: "b", fillModelParametersHash: "0".repeat(64) }),
    ]) {
      expect(model.calibration).toBe("UNCALIBRATED_NO_PROBE_DATA_EXISTS");
    }
  });

  it("the queue parameters must state their assumed basis", () => {
    const outcome = readQueueModelParameters({
      ...QUEUE_PARAMETERS,
      basis: "MEASURED" as never,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal.message).toContain("ADR-012 §7");
  });
});
