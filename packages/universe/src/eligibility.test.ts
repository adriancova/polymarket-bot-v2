import { describe, expect, it } from "vitest";

import {
  currentTradingParameters,
  evaluateMarketReadiness,
  hasApprovedSeriesBinding,
} from "./eligibility.js";
import { applyMarketLifecycleEvent, type MarketProjection } from "./lifecycle.js";
import { createParameterHistory } from "./parameters.js";
import { approvedSeriesBinding, suggestedSeriesBinding, UNBOUND_SERIES_BINDING } from "./series.js";
import { SETTLEMENT_ACTIVATION_STATUSES } from "./settlement-binding.js";
import {
  SAMPLE_MARKET_ID,
  SAMPLE_RULES_VERSION_ID,
  SAMPLE_SERIES_ID,
  marketIdentitySample,
  parameterObservationSample,
  permittingSettlementView,
  seriesDefinitionSample,
  unverifiedSettlementView,
} from "./testing/index.js";

const CONDITION_ID = marketIdentitySample().conditionId;
const AS_OF = "2026-08-28T12:05:00Z";

/** An open market, bound to an approved series, trading under the reviewed rules. */
function tradeableProjection(): MarketProjection {
  const base: MarketProjection = {
    identity: marketIdentitySample(),
    seriesBinding: approvedSeriesBinding(SAMPLE_SERIES_ID, "reviewer", "2026-08-28T00:00:00Z"),
    lifecycleState: "DISCOVERED",
    outcomeState: "PENDING",
    metadataVersion: 1,
    rulesVersionId: SAMPLE_RULES_VERSION_ID,
    clarifications: [],
    parameters: createParameterHistory(SAMPLE_MARKET_ID, parameterObservationSample()),
  };
  const opened = applyMarketLifecycleEvent(base, {
    eventType: "MarketOpened",
    payload: {
      internalMarketId: SAMPLE_MARKET_ID,
      conditionId: CONDITION_ID,
      openedAt: "2026-08-28T12:00:00Z",
    },
  });
  if (!opened.ok) {
    throw new Error("fixture failed to open");
  }
  return opened.value.projection;
}

const approvedSeries = {
  ...seriesDefinitionSample(),
  binding: { approved: true as const, approvedBy: "reviewer", approvedAt: "2026-08-28T00:00:00Z" },
};

describe("evaluateMarketReadiness", () => {
  it("permits activation for an open, bound, reviewed market", () => {
    const readiness = evaluateMarketReadiness(tradeableProjection(), {
      asOf: AS_OF,
      settlement: permittingSettlementView(),
      series: approvedSeries,
    });

    expect(readiness.refusals).toEqual([]);
    expect(readiness.modelDependentActivationAllowed).toBe(true);
    expect(readiness.observationReady).toBe(true);
    expect(readiness.effectiveLifecycleState).toBe("OPEN");
  });

  it("blocks activation on an unverified settlement spec (acceptance 3)", () => {
    const readiness = evaluateMarketReadiness(tradeableProjection(), {
      asOf: AS_OF,
      settlement: unverifiedSettlementView(),
      series: approvedSeries,
    });

    expect(readiness.modelDependentActivationAllowed).toBe(false);
    // Observation is still permitted: you cannot review what you cannot see.
    expect(readiness.observationReady).toBe(true);
    expect(readiness.refusals.map((refusal) => refusal.code)).toEqual([
      "UNIVERSE_SETTLEMENT_ACTIVATION_BLOCKED",
    ]);
    expect(readiness.refusals[0]?.details["settlementRefusals"]).toEqual([
      "SETTLEMENT_SPEC_UNVERIFIED",
    ]);
  });

  it.each(SETTLEMENT_ACTIVATION_STATUSES.filter((status) => status !== "REVIEWED_MODEL_BACKED"))(
    "blocks activation when the settlement verdict is %s",
    (status) => {
      const readiness = evaluateMarketReadiness(tradeableProjection(), {
        asOf: AS_OF,
        settlement: permittingSettlementView({
          status,
          modelDependentActivationAllowed: false,
        }),
        series: approvedSeries,
      });
      expect(readiness.modelDependentActivationAllowed).toBe(false);
      expect(readiness.refusals.map((refusal) => refusal.code)).toContain(
        "UNIVERSE_SETTLEMENT_ACTIVATION_BLOCKED",
      );
    },
  );

  it("refuses to trust a verdict that contradicts itself", () => {
    const readiness = evaluateMarketReadiness(tradeableProjection(), {
      asOf: AS_OF,
      settlement: permittingSettlementView({
        status: "SPEC_UNVERIFIED",
        modelDependentActivationAllowed: true,
      }),
      series: approvedSeries,
    });

    expect(readiness.modelDependentActivationAllowed).toBe(false);
    expect(readiness.refusals.map((refusal) => refusal.code)).toEqual([
      "UNIVERSE_SETTLEMENT_VERDICT_INCONSISTENT",
    ]);
  });

  it("blocks activation when the reviewed rules version is not the one trading (§6 invariant 9)", () => {
    const drifted: MarketProjection = {
      ...tradeableProjection(),
      rulesVersionId: "01936f00-0000-7000-8000-00000000b999",
    };
    const readiness = evaluateMarketReadiness(drifted, {
      asOf: AS_OF,
      settlement: permittingSettlementView(),
      series: approvedSeries,
    });

    expect(readiness.refusals.map((refusal) => refusal.code)).toEqual([
      "UNIVERSE_SETTLEMENT_RULES_VERSION_DRIFT",
    ]);
  });

  it("blocks activation on a suggested series binding (§9.2)", () => {
    const suggested: MarketProjection = {
      ...tradeableProjection(),
      seriesBinding: suggestedSeriesBinding(SAMPLE_SERIES_ID, ["market text matched"]),
    };
    const readiness = evaluateMarketReadiness(suggested, {
      asOf: AS_OF,
      settlement: permittingSettlementView(),
    });

    expect(readiness.modelDependentActivationAllowed).toBe(false);
    expect(readiness.refusals.map((refusal) => refusal.code)).toEqual([
      "UNIVERSE_SERIES_BINDING_NOT_APPROVED",
    ]);
    expect(hasApprovedSeriesBinding(suggested)).toBe(false);
  });

  it("blocks activation on an unbound market", () => {
    const unbound: MarketProjection = {
      ...tradeableProjection(),
      seriesBinding: UNBOUND_SERIES_BINDING,
    };
    const readiness = evaluateMarketReadiness(unbound, {
      asOf: AS_OF,
      settlement: permittingSettlementView(),
    });
    expect(readiness.refusals.map((refusal) => refusal.code)).toEqual([
      "UNIVERSE_SERIES_UNBOUND",
    ]);
  });

  it("blocks activation when the supplied series is inactive, withdrawn, or the wrong one", () => {
    const projection = tradeableProjection();

    expect(
      evaluateMarketReadiness(projection, {
        asOf: AS_OF,
        settlement: permittingSettlementView(),
        series: { ...approvedSeries, active: false },
      }).refusals.map((refusal) => refusal.code),
    ).toEqual(["UNIVERSE_SERIES_INACTIVE"]);

    expect(
      evaluateMarketReadiness(projection, {
        asOf: AS_OF,
        settlement: permittingSettlementView(),
        series: { ...approvedSeries, binding: { approved: false } },
      }).refusals.map((refusal) => refusal.code),
    ).toEqual(["UNIVERSE_SERIES_BINDING_NOT_APPROVED"]);

    expect(
      evaluateMarketReadiness(projection, {
        asOf: AS_OF,
        settlement: permittingSettlementView(),
        series: { ...approvedSeries, seriesId: "01936f00-0000-7000-8000-00000000a555" },
      }).refusals.map((refusal) => refusal.code),
    ).toEqual(["UNIVERSE_SERIES_UNKNOWN"]);
  });

  it("blocks a market that has not opened", () => {
    const discovered: MarketProjection = {
      ...tradeableProjection(),
      lifecycleState: "DISCOVERED",
    };
    const readiness = evaluateMarketReadiness(discovered, {
      asOf: "2026-08-28T11:59:30Z",
      settlement: permittingSettlementView(),
      series: approvedSeries,
    });

    expect(readiness.observationReady).toBe(false);
    expect(readiness.refusals.map((refusal) => refusal.code)).toEqual([
      "UNIVERSE_MARKET_NOT_OPEN",
    ]);
  });

  it("blocks a market whose trading window has ended", () => {
    const readiness = evaluateMarketReadiness(tradeableProjection(), {
      asOf: "2026-08-28T12:16:00Z",
      settlement: permittingSettlementView(),
      series: approvedSeries,
    });

    expect(readiness.effectiveLifecycleState).toBe("CLOSED");
    expect(readiness.observationReady).toBe(false);
    expect(readiness.refusals.map((refusal) => refusal.code)).toEqual(["UNIVERSE_MARKET_CLOSED"]);
  });

  it("blocks a resolved market", () => {
    const resolved: MarketProjection = {
      ...tradeableProjection(),
      lifecycleState: "RESOLVED",
      outcomeState: "YES_WIN",
      resolvedAt: "2026-08-28T12:15:30Z",
    };
    const readiness = evaluateMarketReadiness(resolved, {
      asOf: AS_OF,
      settlement: permittingSettlementView(),
      series: approvedSeries,
    });

    expect(readiness.refusals.map((refusal) => refusal.code)).toEqual([
      "UNIVERSE_MARKET_RESOLVED",
      "UNIVERSE_OUTCOME_STATE_NOT_PENDING",
    ]);
  });

  it("blocks a market awaiting a clarification, and says how many arrived after open", () => {
    const clarified = applyMarketLifecycleEvent(tradeableProjection(), {
      eventType: "MarketClarificationObserved",
      payload: {
        internalMarketId: SAMPLE_MARKET_ID,
        conditionId: CONDITION_ID,
        clarificationId: "clar-1",
        observedAt: "2026-08-28T12:03:00Z",
      },
    });
    expect(clarified.ok).toBe(true);
    if (!clarified.ok) return;

    const readiness = evaluateMarketReadiness(clarified.value.projection, {
      asOf: AS_OF,
      settlement: permittingSettlementView(),
      series: approvedSeries,
    });

    expect(readiness.modelDependentActivationAllowed).toBe(false);
    expect(readiness.observationReady).toBe(true);
    expect(readiness.refusals.map((refusal) => refusal.code)).toEqual([
      "UNIVERSE_OUTCOME_STATE_NOT_PENDING",
    ]);
    expect(readiness.refusals[0]?.details["clarificationsAfterOpen"]).toBe(1);
  });

  it("blocks a disputed market", () => {
    const disputed: MarketProjection = { ...tradeableProjection(), outcomeState: "DISPUTED" };
    const readiness = evaluateMarketReadiness(disputed, {
      asOf: AS_OF,
      settlement: permittingSettlementView(),
      series: approvedSeries,
    });
    expect(readiness.refusals.map((refusal) => refusal.code)).toEqual([
      "UNIVERSE_OUTCOME_STATE_NOT_PENDING",
    ]);
  });

  describe("close cutoff policy", () => {
    it("is not applied unless the caller supplies one", () => {
      const readiness = evaluateMarketReadiness(tradeableProjection(), {
        asOf: "2026-08-28T12:14:59Z",
        settlement: permittingSettlementView(),
        series: approvedSeries,
      });
      expect(readiness.modelDependentActivationAllowed).toBe(true);
    });

    it("blocks activation inside the caller's cutoff", () => {
      const readiness = evaluateMarketReadiness(tradeableProjection(), {
        asOf: "2026-08-28T12:14:30Z",
        settlement: permittingSettlementView(),
        series: approvedSeries,
        policy: { minimumSecondsToClose: 45 },
      });
      expect(readiness.refusals.map((refusal) => refusal.code)).toEqual([
        "UNIVERSE_CLOSE_CUTOFF",
      ]);
      expect(readiness.refusals[0]?.details["secondsToClose"]).toBe(30);
    });

    it("permits activation outside the cutoff", () => {
      const readiness = evaluateMarketReadiness(tradeableProjection(), {
        asOf: "2026-08-28T12:14:00Z",
        settlement: permittingSettlementView(),
        series: approvedSeries,
        policy: { minimumSecondsToClose: 45 },
      });
      expect(readiness.modelDependentActivationAllowed).toBe(true);
    });

    it("refuses when a cutoff policy has no close instant to measure against", () => {
      const noClose: MarketProjection = {
        ...tradeableProjection(),
        parameters: createParameterHistory(SAMPLE_MARKET_ID, {
          ...parameterObservationSample(),
          parameters: (() => {
            const parameters = { ...parameterObservationSample().parameters };
            delete (parameters as { closeTime?: string }).closeTime;
            return parameters;
          })(),
        }),
      };
      const readiness = evaluateMarketReadiness(noClose, {
        asOf: AS_OF,
        settlement: permittingSettlementView(),
        series: approvedSeries,
        policy: { minimumSecondsToClose: 45 },
      });
      expect(readiness.refusals.map((refusal) => refusal.code)).toEqual([
        "UNIVERSE_CLOSE_CUTOFF",
      ]);
    });

    it("refuses an unparseable `asOf` rather than skipping the check", () => {
      const readiness = evaluateMarketReadiness(tradeableProjection(), {
        asOf: "not-a-timestamp",
        settlement: permittingSettlementView(),
        series: approvedSeries,
        policy: { minimumSecondsToClose: 45 },
      });
      expect(readiness.refusals.map((refusal) => refusal.code)).toEqual([
        "UNIVERSE_TIMESTAMP_INVALID",
      ]);
    });
  });

  it("returns a frozen readiness value", () => {
    const readiness = evaluateMarketReadiness(tradeableProjection(), {
      asOf: AS_OF,
      settlement: permittingSettlementView(),
      series: approvedSeries,
    });
    expect(Object.isFrozen(readiness)).toBe(true);
    expect(Object.isFrozen(readiness.refusals)).toBe(true);
  });
});

describe("currentTradingParameters", () => {
  it("exposes the tick size and minimum order size in force", () => {
    expect(currentTradingParameters(tradeableProjection())).toEqual({
      tickSize: "0.01",
      minimumOrderSize: "5",
    });
  });
});
