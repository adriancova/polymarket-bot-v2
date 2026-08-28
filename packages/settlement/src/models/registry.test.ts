import { describe, expect, it } from "vitest";

import type { SettlementResult } from "../errors.js";
import type { ThresholdByDateObservation } from "../observation.js";
import { parseSettlementSpec, type SettlementSpec } from "../spec.js";
import {
  referenceOpenUpDownObservationSample,
  referenceOpenUpDownSpecSample,
  terminalSpotObservationSample,
  terminalSpotSpecSample,
  thresholdByDateObservationSample,
  thresholdByDateSpecSample,
  twapObservationSample,
  twapSpecSample,
  verifiedSpec,
} from "../testing/index.js";
import { evaluateSettlement, satisfiesComparison, selectPayoffModel } from "./registry.js";

const terminalSpot = parseSettlementSpec(terminalSpotSpecSample());
const twap = parseSettlementSpec(twapSpecSample());
const upDown = parseSettlementSpec(referenceOpenUpDownSpecSample());
const thresholdByDate = parseSettlementSpec(thresholdByDateSpecSample());

function refusalCodes<T>(result: SettlementResult<T>): readonly string[] {
  return result.ok ? [] : result.refusals.map((refusal) => refusal.code);
}

describe("satisfiesComparison", () => {
  it("compares exactly, by decimal and not by float", () => {
    // 0.1 + 0.2 > 0.3 in IEEE-754; here the comparison is exact.
    expect(satisfiesComparison("0.3", "0.3", "GT")).toBe(false);
    expect(satisfiesComparison("0.3", "0.3", "GTE")).toBe(true);
    expect(satisfiesComparison("0.30000000000000004", "0.3", "GT")).toBe(true);
    expect(satisfiesComparison("64000.000000000000000001", "64000", "GT")).toBe(true);
  });

  it.each([
    ["GT", "2", "1", true],
    ["GT", "1", "1", false],
    ["GTE", "1", "1", true],
    ["LT", "1", "2", true],
    ["LT", "1", "1", false],
    ["LTE", "1", "1", true],
    ["LTE", "2", "1", false],
  ] as const)("%s %s %s → %s", (operator, left, right, expected) => {
    expect(satisfiesComparison(left, right, operator)).toBe(expected);
  });
});

describe("selectPayoffModel", () => {
  it("selects the model the spec declares", () => {
    expect(selectPayoffModel(terminalSpot)).toEqual({
      ok: true,
      value: "TerminalSpotBinaryModel",
    });
    expect(selectPayoffModel(twap)).toEqual({ ok: true, value: "TwapBinaryModel" });
    expect(selectPayoffModel(upDown)).toEqual({
      ok: true,
      value: "ReferenceOpenUpDownModel",
    });
    expect(selectPayoffModel(thresholdByDate)).toEqual({
      ok: true,
      value: "ThresholdByDateModel",
    });
  });

  it("refuses a spec whose observation type has no implementing model", () => {
    const spec = parseSettlementSpec({
      settlementSpecId: "01936f00-0000-7000-8000-00000000c009",
      seriesId: "01936f00-0000-7000-8000-00000000a001",
      specVersion: 1,
      resolutionSource: "A human oracle reading an official announcement.",
      referenceSymbol: "btc.usd",
      observationType: "MANUAL_ORACLE",
      timestampBoundary: "Inclusive of the close instant.",
      roundingRule: "No rounding.",
      fallbackSource: "Halt and escalate.",
      disputePolicy: "Halt and escalate.",
      clarificationPolicy: "Halt and require re-review.",
      verification: { status: "UNVERIFIED" },
    });

    expect(refusalCodes(selectPayoffModel(spec))).toEqual([
      "SETTLEMENT_OBSERVATION_TYPE_HAS_NO_MODEL",
    ]);
  });
});

describe("evaluateSettlement — routing", () => {
  it("refuses an observation belonging to a different model", () => {
    const result = evaluateSettlement(twap, terminalSpotObservationSample());
    expect(refusalCodes(result)).toEqual(["SETTLEMENT_OBSERVATION_MODEL_MISMATCH"]);
  });

  it("refuses a terminal-spot reading for a TWAP-settled market (§9.3)", () => {
    // The spec cannot even declare the terminal-spot model, and the reading for
    // that model is refused as well: both gates close on the same mistake.
    const result = evaluateSettlement(twap, {
      ...terminalSpotObservationSample(),
      referenceSymbol: twap.referenceSymbol,
    });
    expect(result.ok).toBe(false);
  });

  it("refuses an observation of a different reference symbol", () => {
    const result = evaluateSettlement(terminalSpot, {
      ...terminalSpotObservationSample(),
      referenceSymbol: "eth.usd",
    });
    expect(refusalCodes(result)).toEqual(["SETTLEMENT_OBSERVATION_SYMBOL_MISMATCH"]);
  });

  it("reports whether the spec behind the number was reviewed", () => {
    const unreviewed = evaluateSettlement(terminalSpot, terminalSpotObservationSample());
    expect(unreviewed.ok && unreviewed.value.reviewed).toBe(false);

    const reviewed = evaluateSettlement(
      parseSettlementSpec(verifiedSpec(terminalSpotSpecSample())),
      terminalSpotObservationSample(),
    );
    expect(reviewed.ok && reviewed.value.reviewed).toBe(true);
  });
});

describe("TerminalSpotBinaryModel", () => {
  it("settles YES when the comparison holds", () => {
    const result = evaluateSettlement(terminalSpot, terminalSpotObservationSample());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outcomeState).toBe("YES_WIN");
    expect(result.value.payoutPerShare).toEqual({ yes: "1", no: "0" });
    expect(result.value.comparison).toEqual({
      operator: "GTE",
      left: "64000.25",
      right: "64000",
      satisfied: true,
    });
  });

  it("settles NO when it does not", () => {
    const result = evaluateSettlement(terminalSpot, {
      ...terminalSpotObservationSample(),
      observedValue: "63999.99",
    });
    expect(result.ok && result.value.outcomeState).toBe("NO_WIN");
    expect(result.ok && result.value.payoutPerShare).toEqual({ yes: "0", no: "1" });
  });

  it("settles the boundary by the spec's comparison, not by convention", () => {
    const atStrike = { ...terminalSpotObservationSample(), observedValue: "64000" };
    const gte = evaluateSettlement(terminalSpot, atStrike);
    expect(gte.ok && gte.value.outcomeState).toBe("YES_WIN");

    const strict = parseSettlementSpec({ ...terminalSpotSpecSample(), comparison: "GT" });
    const gt = evaluateSettlement(strict, atStrike);
    expect(gt.ok && gt.value.outcomeState).toBe("NO_WIN");
  });
});

describe("TwapBinaryModel", () => {
  it("settles on the averaged value", () => {
    const result = evaluateSettlement(twap, twapObservationSample());
    expect(result.ok && result.value.outcomeState).toBe("YES_WIN");
    expect(result.ok && result.value.model).toBe("TwapBinaryModel");
  });

  it("refuses an observation averaged over a different window", () => {
    const result = evaluateSettlement(twap, { ...twapObservationSample(), windowSeconds: 60 });
    expect(refusalCodes(result)).toEqual(["SETTLEMENT_OBSERVATION_WINDOW_MISMATCH"]);
  });

  it("refuses an inverted window", () => {
    const result = evaluateSettlement(twap, {
      ...twapObservationSample(),
      windowStartAt: "2026-08-28T12:00:00Z",
      windowEndAt: "2026-08-28T11:59:30Z",
    });
    expect(refusalCodes(result)).toEqual(["SETTLEMENT_OBSERVATION_WINDOW_INVALID"]);
  });

  it("refuses an unparseable window boundary", () => {
    const result = evaluateSettlement(twap, {
      ...twapObservationSample(),
      windowEndAt: "not-a-timestamp",
    });
    expect(refusalCodes(result)).toEqual(["SETTLEMENT_TIMESTAMP_INVALID"]);
  });

  it("compares instants rather than strings across offsets", () => {
    const result = evaluateSettlement(twap, {
      ...twapObservationSample(),
      windowStartAt: "2026-08-28T13:59:30+02:00",
      windowEndAt: "2026-08-28T12:00:00Z",
    });
    expect(result.ok).toBe(true);
  });
});

describe("ReferenceOpenUpDownModel", () => {
  it("settles against the market's own reference open", () => {
    const result = evaluateSettlement(upDown, referenceOpenUpDownObservationSample());
    expect(result.ok && result.value.outcomeState).toBe("YES_WIN");
    expect(result.ok && result.value.comparison.right).toBe("64000");
  });

  it("settles NO when the close is at or below the open under GT", () => {
    const result = evaluateSettlement(upDown, {
      ...referenceOpenUpDownObservationSample(),
      observedValue: "64000",
    });
    expect(result.ok && result.value.outcomeState).toBe("NO_WIN");
  });

  it("refuses an observation that is not after the reference open", () => {
    const result = evaluateSettlement(upDown, {
      ...referenceOpenUpDownObservationSample(),
      observedAt: "2026-08-28T11:45:00Z",
    });
    expect(refusalCodes(result)).toEqual(["SETTLEMENT_OBSERVATION_WINDOW_INVALID"]);
  });

  it("refuses an averaging window when the spec settles on a terminal spot", () => {
    const result = evaluateSettlement(upDown, {
      ...referenceOpenUpDownObservationSample(),
      windowSeconds: 30,
      windowStartAt: "2026-08-28T11:59:30Z",
      windowEndAt: "2026-08-28T12:00:00Z",
    });
    expect(refusalCodes(result)).toEqual(["SETTLEMENT_OBSERVATION_WINDOW_MISMATCH"]);
  });

  describe("on a TWAP-settled up/down series", () => {
    const twapUpDown: SettlementSpec = parseSettlementSpec({
      ...referenceOpenUpDownSpecSample(),
      observationType: "TWAP",
      windowSeconds: 60,
      windowStartRule: "Sixty seconds before the market close instant.",
      windowEndRule: "The market close instant, inclusive.",
    });

    it("settles on the windowed observation", () => {
      const result = evaluateSettlement(twapUpDown, {
        ...referenceOpenUpDownObservationSample(),
        windowSeconds: 60,
        windowStartAt: "2026-08-28T11:59:00Z",
        windowEndAt: "2026-08-28T12:00:00Z",
      });
      expect(result.ok && result.value.outcomeState).toBe("YES_WIN");
    });

    it("refuses a reading with no window at all", () => {
      const result = evaluateSettlement(twapUpDown, referenceOpenUpDownObservationSample());
      expect(refusalCodes(result)).toEqual(["SETTLEMENT_OBSERVATION_WINDOW_MISMATCH"]);
    });

    it("refuses a reading averaged over the wrong window", () => {
      const result = evaluateSettlement(twapUpDown, {
        ...referenceOpenUpDownObservationSample(),
        windowSeconds: 30,
        windowStartAt: "2026-08-28T11:59:30Z",
        windowEndAt: "2026-08-28T12:00:00Z",
      });
      expect(refusalCodes(result)).toEqual(["SETTLEMENT_OBSERVATION_WINDOW_MISMATCH"]);
    });
  });
});

describe("ThresholdByDateModel", () => {
  it("is PENDING while the deadline is in the future and the threshold is unmet", () => {
    const result = evaluateSettlement(thresholdByDate, thresholdByDateObservationSample());
    expect(result.ok && result.value.outcomeState).toBe("PENDING");
    expect(result.ok && result.value.payoutPerShare).toBeUndefined();
  });

  it("settles YES as soon as the threshold is met", () => {
    const result = evaluateSettlement(thresholdByDate, {
      ...thresholdByDateObservationSample(),
      extremeValue: "150000",
    });
    expect(result.ok && result.value.outcomeState).toBe("YES_WIN");
  });

  it("settles NO once the deadline has passed with the threshold unmet", () => {
    const result = evaluateSettlement(thresholdByDate, {
      ...thresholdByDateObservationSample(),
      asOf: "2027-01-01T00:00:00Z",
    });
    expect(result.ok && result.value.outcomeState).toBe("NO_WIN");
  });

  it("refuses the wrong extreme for the comparison direction", () => {
    const result = evaluateSettlement(thresholdByDate, {
      ...thresholdByDateObservationSample(),
      extremeKind: "MIN",
    });
    expect(refusalCodes(result)).toEqual(["SETTLEMENT_EXTREME_DIRECTION_MISMATCH"]);
  });

  it("requires the minimum for a downward threshold question", () => {
    const downward = parseSettlementSpec({
      ...thresholdByDateSpecSample(),
      comparison: "LTE",
    });
    const observation = {
      ...thresholdByDateObservationSample(),
      threshold: "20000",
      extremeKind: "MIN" as const,
      extremeValue: "19000",
    };
    const result = evaluateSettlement(downward, observation);
    expect(result.ok && result.value.outcomeState).toBe("YES_WIN");

    const wrongExtreme = evaluateSettlement(downward, {
      ...observation,
      extremeKind: "MAX" as const,
    });
    expect(refusalCodes(wrongExtreme)).toEqual(["SETTLEMENT_EXTREME_DIRECTION_MISMATCH"]);
  });

  it("refuses an extreme observed outside the period", () => {
    const before = evaluateSettlement(thresholdByDate, {
      ...thresholdByDateObservationSample(),
      extremeObservedAt: "2026-07-01T00:00:00Z",
    });
    expect(refusalCodes(before)).toEqual(["SETTLEMENT_OBSERVATION_WINDOW_INVALID"]);
  });

  it("refuses an extreme observed after the instant it claims to be evaluated as of", () => {
    // §8.4: a replayed evaluation must not use information the live one lacked.
    const result = evaluateSettlement(thresholdByDate, {
      ...thresholdByDateObservationSample(),
      extremeObservedAt: "2026-09-01T00:00:00Z",
    });
    expect(refusalCodes(result)).toEqual(["SETTLEMENT_OBSERVATION_WINDOW_INVALID"]);
  });

  it("refuses an inverted period", () => {
    const result = evaluateSettlement(thresholdByDate, {
      ...thresholdByDateObservationSample(),
      periodStartAt: "2027-01-01T00:00:00Z",
    });
    expect(refusalCodes(result)).toEqual(["SETTLEMENT_OBSERVATION_WINDOW_INVALID"]);
  });

  it.each(["asOf", "extremeObservedAt", "periodStartAt", "deadlineAt"] as const)(
    "refuses an unparseable %s",
    (field) => {
      const observation = {
        ...thresholdByDateObservationSample(),
        [field]: "not-a-timestamp",
      } as ThresholdByDateObservation;
      expect(refusalCodes(evaluateSettlement(thresholdByDate, observation))).toEqual([
        "SETTLEMENT_TIMESTAMP_INVALID",
      ]);
    },
  );
});
