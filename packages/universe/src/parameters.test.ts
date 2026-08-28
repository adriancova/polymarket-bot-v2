import { describe, expect, it } from "vitest";

import { UniverseValidationError } from "./errors.js";
import {
  MarketParametersSchema,
  appendParameterVersion,
  changedParameterKinds,
  createParameterHistory,
  currentParameterVersion,
  parameterVersion,
  parametersAsOf,
  type MarketParameterHistory,
  type MarketParameters,
  type ParameterObservation,
} from "./parameters.js";
import { SAMPLE_MARKET_ID, parameterObservationSample } from "./testing/index.js";

const CONDITION_ID = "0x00000000000000000000000000000000000000000000000000000000000000a1";

function historyOfOne(): MarketParameterHistory {
  return createParameterHistory(SAMPLE_MARKET_ID, parameterObservationSample());
}

function observation(
  parameters: Partial<MarketParameters>,
  observedAt = "2026-08-28T12:00:00Z",
): ParameterObservation {
  const base = parameterObservationSample();
  return {
    parameters: { ...base.parameters, ...parameters },
    observedAt,
    source: "polymarket",
  };
}

describe("MarketParametersSchema", () => {
  it("accepts the §9.2 parameter set", () => {
    expect(MarketParametersSchema.safeParse(parameterObservationSample().parameters).success).toBe(
      true,
    );
  });

  it("rejects a JavaScript number for an economic field", () => {
    for (const field of ["tickSize", "minimumOrderSize"] as const) {
      const result = MarketParametersSchema.safeParse({
        ...parameterObservationSample().parameters,
        [field]: 0.01,
      });
      expect(result.success).toBe(false);
    }
  });

  it("rejects a non-canonical decimal", () => {
    const result = MarketParametersSchema.safeParse({
      ...parameterObservationSample().parameters,
      tickSize: "0.010",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-positive tick size or minimum size", () => {
    for (const field of ["tickSize", "minimumOrderSize"] as const) {
      expect(
        MarketParametersSchema.safeParse({
          ...parameterObservationSample().parameters,
          [field]: "0",
        }).success,
      ).toBe(false);
    }
  });

  it("rejects a close that is not after the open", () => {
    const result = MarketParametersSchema.safeParse({
      ...parameterObservationSample().parameters,
      openTime: "2026-08-28T12:15:00Z",
      closeTime: "2026-08-28T12:00:00Z",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown key", () => {
    const result = MarketParametersSchema.safeParse({
      ...parameterObservationSample().parameters,
      surpriseField: 1,
    });
    expect(result.success).toBe(false);
  });
});

describe("changedParameterKinds", () => {
  const base = parameterObservationSample().parameters;

  it.each([
    ["tickSize", "0.001", "tick_size"],
    ["minimumOrderSize", "10", "minimum_order_size"],
    ["feeScheduleRef", "fee-schedule-2026-09-01", "fee_schedule"],
    ["tradingDelaySeconds", 5, "trading_delay"],
    ["negRisk", true, "neg_risk"],
    ["openTime", "2026-08-28T12:01:00Z", "open_time"],
    ["closeTime", "2026-08-28T12:16:00Z", "close_time"],
    ["status", "OPEN", "status"],
  ] as const)("reports %s as %s", (field, value, kind) => {
    const next = { ...base, [field]: value } as MarketParameters;
    expect(changedParameterKinds(base, next)).toEqual([kind]);
  });

  it("reports nothing for an identical snapshot", () => {
    expect(changedParameterKinds(base, { ...base })).toEqual([]);
  });

  it("compares decimals exactly, not as strings", () => {
    // A re-spelled tick size is the same tick size; calling it a change would
    // create a version with no economic content.
    expect(changedParameterKinds(base, { ...base, tickSize: "0.01" })).toEqual([]);
  });

  it("compares instants, not their spellings", () => {
    expect(
      changedParameterKinds(base, { ...base, openTime: "2026-08-28T14:00:00+02:00" }),
    ).toEqual([]);
  });

  it("reports an added or removed optional field", () => {
    const withoutFee: MarketParameters = { ...base };
    delete (withoutFee as { feeScheduleRef?: string }).feeScheduleRef;
    expect(changedParameterKinds(base, withoutFee)).toEqual(["fee_schedule"]);
    expect(changedParameterKinds(withoutFee, base)).toEqual(["fee_schedule"]);
  });

  it("reports every category that changed, in the frozen enum's order", () => {
    const next: MarketParameters = {
      ...base,
      tickSize: "0.001",
      negRisk: true,
      status: "OPEN",
    };
    expect(changedParameterKinds(base, next)).toEqual(["tick_size", "neg_risk", "status"]);
  });
});

describe("parameter history", () => {
  it("starts at version 1 and records what the first snapshot established", () => {
    const history = historyOfOne();
    const version = currentParameterVersion(history);

    expect(history.versions).toHaveLength(1);
    expect(version.parametersVersion).toBe(1);
    expect(version.previousParametersVersion).toBeUndefined();
    expect(version.parameterVersionRef).toBe(`${SAMPLE_MARKET_ID}/v1`);
    expect(version.changedParameters).toEqual([
      "tick_size",
      "minimum_order_size",
      "fee_schedule",
      "trading_delay",
      "neg_risk",
      "open_time",
      "close_time",
      "status",
    ]);
  });

  it("throws a typed error for an invalid observation", () => {
    expect(() =>
      createParameterHistory(SAMPLE_MARKET_ID, {
        ...parameterObservationSample(),
        parameters: { ...parameterObservationSample().parameters, tickSize: "-1" },
      }),
    ).toThrow(UniverseValidationError);
  });

  describe("appending (acceptance 4: parameter changes create immutable history)", () => {
    it("creates a new version and leaves the previous history untouched", () => {
      const first = historyOfOne();
      const result = appendParameterVersion(first, observation({ status: "OPEN" }), CONDITION_ID);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // The old history is unchanged, and its version objects are the SAME
      // objects: appending copies the list, never the entries.
      expect(first.versions).toHaveLength(1);
      expect(result.value.history.versions).toHaveLength(2);
      expect(result.value.history.versions[0]).toBe(first.versions[0]);
      expect(result.value.history).not.toBe(first);

      const version = result.value.version;
      expect(version.parametersVersion).toBe(2);
      expect(version.previousParametersVersion).toBe(1);
      expect(version.changedParameters).toEqual(["status"]);
      expect(version.parameterVersionRef).toBe(`${SAMPLE_MARKET_ID}/v2`);
    });

    it("freezes every recorded version, its snapshot, and the version list", () => {
      const history = historyOfOne();
      const version = currentParameterVersion(history);

      expect(Object.isFrozen(history)).toBe(true);
      expect(Object.isFrozen(history.versions)).toBe(true);
      expect(Object.isFrozen(version)).toBe(true);
      expect(Object.isFrozen(version.parameters)).toBe(true);
      expect(Object.isFrozen(version.changedParameters)).toBe(true);
    });

    it("throws when history is edited in place", () => {
      const history = historyOfOne();
      const version = currentParameterVersion(history);

      // ES modules run in strict mode, so a write to a frozen object throws
      // rather than failing silently.
      expect(() => {
        (version.parameters as { tickSize: string }).tickSize = "0.5";
      }).toThrow(TypeError);
      expect(() => {
        (version as { parametersVersion: number }).parametersVersion = 99;
      }).toThrow(TypeError);
      expect(() => {
        (history.versions as MarketParameterHistory["versions"][number][]).push(version);
      }).toThrow(TypeError);
      expect(currentParameterVersion(history).parameters.tickSize).toBe("0.01");
    });

    it("refuses a change that changes nothing", () => {
      const first = historyOfOne();
      const result = appendParameterVersion(first, observation({}), CONDITION_ID);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.refusals.map((refusal) => refusal.code)).toEqual([
        "UNIVERSE_PARAMETERS_UNCHANGED",
      ]);
    });

    it("refuses an observation older than the version it would follow", () => {
      const first = historyOfOne();
      const result = appendParameterVersion(
        first,
        observation({ status: "OPEN" }, "2026-08-28T10:00:00Z"),
        CONDITION_ID,
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.refusals.map((refusal) => refusal.code)).toEqual([
        "UNIVERSE_PARAMETER_HISTORY_OUT_OF_ORDER",
      ]);
    });

    it("emits a TradingParametersChanged payload describing the change", () => {
      const first = historyOfOne();
      const result = appendParameterVersion(
        first,
        observation({ tickSize: "0.001", status: "OPEN" }),
        CONDITION_ID,
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.event).toEqual({
        internalMarketId: SAMPLE_MARKET_ID,
        conditionId: CONDITION_ID,
        parametersVersion: 2,
        previousParametersVersion: 1,
        parameterVersionRef: `${SAMPLE_MARKET_ID}/v2`,
        changedParameters: ["tick_size", "status"],
        tickSize: "0.001",
        minimumOrderSize: "5",
      });
    });
  });

  describe("querying (§6 invariant 9: historical runs use historical parameters)", () => {
    function threeVersions(): MarketParameterHistory {
      let history = historyOfOne();
      for (const [status, at] of [
        ["OPEN", "2026-08-28T12:00:00Z"],
        ["CLOSING", "2026-08-28T12:14:00Z"],
      ] as const) {
        const result = appendParameterVersion(history, observation({ status }, at), CONDITION_ID);
        expect(result.ok).toBe(true);
        if (result.ok) {
          history = result.value.history;
        }
      }
      return history;
    }

    it("answers with the version in force at an instant", () => {
      const history = threeVersions();

      expect(parametersAsOf(history, "2026-08-28T11:58:00Z")).toBeUndefined();
      expect(parametersAsOf(history, "2026-08-28T11:59:00Z")?.parametersVersion).toBe(1);
      expect(parametersAsOf(history, "2026-08-28T12:13:59Z")?.parametersVersion).toBe(2);
      expect(parametersAsOf(history, "2026-08-28T23:00:00Z")?.parametersVersion).toBe(3);
    });

    it("compares instants rather than strings", () => {
      const history = threeVersions();
      expect(parametersAsOf(history, "2026-08-28T14:13:59+02:00")?.parametersVersion).toBe(2);
    });

    it("returns undefined for an unparseable instant rather than guessing", () => {
      expect(parametersAsOf(threeVersions(), "not-a-timestamp")).toBeUndefined();
    });

    it("looks a version up by number", () => {
      const history = threeVersions();
      expect(parameterVersion(history, 2)?.changedParameters).toEqual(["status"]);
      expect(parameterVersion(history, 9)).toBeUndefined();
    });
  });
});
