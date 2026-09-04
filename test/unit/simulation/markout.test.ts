/**
 * WP-210 acceptance 3: **markout is not double-counted** (§12.3, ADR-012 §3).
 *
 * §12.3, verbatim: "Do not subtract an additional markout penalty from a replay
 * path that already includes the subsequent adverse price movement. Produce
 * separate stress scenarios when desired."
 *
 * ## The probe that proves it
 *
 * `the replay path does not subtract the adverse move twice` builds a path that
 * ALREADY CONTAINS the adverse move: buy 100 at `0.50`, the mid falls to `0.40`,
 * sell 100 at `0.40`. The realized loss is in the cash flow. It then computes the
 * markouts — which are negative, because the move was adverse — and asserts that
 * the replay economics are UNCHANGED. The independent oracle is the hand-computed
 * cash flow, `(0.40 − 0.50) × 100 − fees`, written out in the test rather than
 * read back from the implementation.
 *
 * The double-count is then shown to be a DIFFERENT, LABELLED record: the stress
 * scenario's `stressedNetCashFlow` is worse than the replay's `netCashFlow` by
 * exactly the markout, and it carries `basis: "STRESS_SCENARIO"` plus the
 * untouched replay economics beside it.
 */

import { describe, expect, it } from "vitest";

import {
  MARKOUT_HORIZONS,
  REPLAY_PATH_ECONOMICS_KEYS,
  computeMarkouts,
  markoutStressScenario,
  replayPathEconomics,
  simulatedFill,
  tier1Model,
  type MidTimeline,
  type SimulatedFill,
} from "../../../packages/simulation/src/index.js";

const MODEL = tier1Model({
  fillModelVersion: "sim/tier1/v1",
  fillModelParametersHash: "0".repeat(64),
});

const AT_EVENT = {
  gatewayEpoch: "0190a3e0-0000-7000-8000-000000000001",
  ingestSeq: "1",
  receivedAt: "2026-01-01T00:00:00.000Z",
  datasetRowOrdinal: 0,
};

function fill(overrides: Partial<SimulatedFill> = {}): SimulatedFill {
  return simulatedFill({
    simulatedFillId: "f-1",
    simulatedOrderId: "o-1",
    marketId: "0190a3e0-0000-7000-8000-00000000000a",
    tokenId: "1234",
    side: "YES",
    action: "BUY",
    price: "0.5",
    shares: "100",
    feeAmount: "0",
    liquidityRole: "TAKER",
    model: MODEL,
    atEvent: AT_EVENT,
    ...overrides,
  });
}

/** A mid path that falls from 0.50 to 0.40 — adverse for a long. */
function fallingMid(): MidTimeline {
  return {
    midAt: ({ monotonicNs }) => ({
      mid: monotonicNs >= 1_000_000_000n ? "0.4" : "0.5",
      atEvent: AT_EVENT,
    }),
  };
}

describe("acceptance 3 — the replay path does not subtract the adverse move twice", () => {
  const entry = fill({ simulatedFillId: "f-buy", action: "BUY", price: "0.5", shares: "100" });
  const exit = fill({ simulatedFillId: "f-sell", action: "SELL", price: "0.4", shares: "100" });

  it("the replay path's economics ARE the adverse move, computed once", () => {
    const economics = replayPathEconomics([entry, exit]);
    // The independent oracle, written out: paid 0.5 × 100 = 50, received
    // 0.4 × 100 = 40, no fees. Net −10.
    expect(economics.buyNotional).toBe("50");
    expect(economics.sellNotional).toBe("40");
    expect(economics.fees).toBe("0");
    expect(economics.netCashFlow).toBe("-10");
    expect(economics.markoutPenaltyApplied).toBe(false);
  });

  it("computing markouts does not change the replay path's economics", () => {
    const before = replayPathEconomics([entry, exit]);
    const diagnostics = computeMarkouts({
      fill: entry,
      filledAtNs: 0n,
      midTimeline: fallingMid(),
      resolutionValuePerShare: "0",
    });
    expect(diagnostics.ok).toBe(true);
    if (!diagnostics.ok) return;

    // The markouts ARE adverse — the probe would be vacuous otherwise.
    const oneSecond = diagnostics.value.observations.find((entryAt) => entryAt.horizon === "1s");
    expect(oneSecond?.perShare).toBe("-0.1");
    expect(oneSecond?.total).toBe("-10");

    const after = replayPathEconomics([entry, exit]);
    expect(after).toEqual(before);
    expect(after.netCashFlow).toBe("-10");
    // NOT −20, which is what subtracting the markout from the realized path
    // would give: the same 10 counted twice.
    expect(after.netCashFlow).not.toBe("-20");
  });

  it("markout diagnostics are labelled as diagnostics and carry no applied money", () => {
    const diagnostics = computeMarkouts({
      fill: entry,
      filledAtNs: 0n,
      midTimeline: fallingMid(),
      resolutionValuePerShare: "0",
    });
    expect(diagnostics.ok).toBe(true);
    if (!diagnostics.ok) return;
    expect(diagnostics.value.role).toBe("DIAGNOSTIC_ONLY");
    expect(diagnostics.value.appliedToReplayEconomics).toBe(false);
    expect(diagnostics.value.note).toContain("§12.3");
    expect(diagnostics.value.note).toContain("no additional markout penalty");
  });

  it("the stress scenario is SEPARATE, labelled, and carries the replay path untouched", () => {
    const diagnostics = computeMarkouts({
      fill: entry,
      filledAtNs: 0n,
      midTimeline: fallingMid(),
      resolutionValuePerShare: "0",
    });
    expect(diagnostics.ok).toBe(true);
    if (!diagnostics.ok) return;

    const stress = markoutStressScenario({
      scenarioName: "adverse-1s",
      horizon: "1s",
      fills: [entry, exit],
      diagnostics: [diagnostics.value],
    });
    expect(stress.ok).toBe(true);
    if (!stress.ok) return;

    expect(stress.value.basis).toBe("STRESS_SCENARIO");
    // The replay path is carried beside the stressed figure, unchanged.
    expect(stress.value.replay.netCashFlow).toBe("-10");
    expect(stress.value.replay.markoutPenaltyApplied).toBe(false);
    expect(stress.value.appliedPenalty).toBe("10");
    expect(stress.value.stressedNetCashFlow).toBe("-20");
    expect(stress.value.note).toContain("SEPARATE stress scenario, not the replay result");
  });

  it("a favourable markout does not become a bonus in a stress scenario", () => {
    const rising: MidTimeline = {
      midAt: () => ({ mid: "0.6", atEvent: AT_EVENT }),
    };
    const diagnostics = computeMarkouts({
      fill: entry,
      filledAtNs: 0n,
      midTimeline: rising,
      resolutionValuePerShare: "1",
    });
    expect(diagnostics.ok).toBe(true);
    if (!diagnostics.ok) return;
    const stress = markoutStressScenario({
      scenarioName: "favourable",
      horizon: "1s",
      fills: [entry, exit],
      diagnostics: [diagnostics.value],
    });
    expect(stress.ok).toBe(true);
    if (!stress.ok) return;
    expect(stress.value.appliedPenalty).toBe("0");
    expect(stress.value.stressedNetCashFlow).toBe(stress.value.replay.netCashFlow);
  });
});

describe("the replay-path economics record has no markout term at all", () => {
  it("its key set is exactly the pinned list", () => {
    const economics = replayPathEconomics([]);
    expect(Object.keys(economics).sort()).toEqual([...REPLAY_PATH_ECONOMICS_KEYS].sort());
  });

  it("the pinned list carries no markout, penalty or adjustment field", () => {
    for (const key of REPLAY_PATH_ECONOMICS_KEYS) {
      if (key === "markoutPenaltyApplied") continue;
      expect(key.toLowerCase()).not.toContain("markout");
      expect(key.toLowerCase()).not.toContain("penalt");
      expect(key.toLowerCase()).not.toContain("adjust");
    }
  });

  it("a simulated fill itself carries no markout field", () => {
    const keys = Object.keys(fill());
    for (const key of keys) {
      expect(key.toLowerCase()).not.toContain("markout");
    }
  });
});

describe("§12.3 required horizons", () => {
  it("declares exactly the seven §12.3 horizons in order", () => {
    expect(MARKOUT_HORIZONS.map((horizon) => horizon.label)).toEqual([
      "100ms",
      "500ms",
      "1s",
      "5s",
      "30s",
      "300s",
      "resolution",
    ]);
    expect(MARKOUT_HORIZONS.map((horizon) => horizon.milliseconds)).toEqual([
      100,
      500,
      1_000,
      5_000,
      30_000,
      300_000,
      null,
    ]);
  });

  it("refuses the resolution horizon when the settled value is not supplied", () => {
    const outcome = computeMarkouts({
      fill: fill(),
      filledAtNs: 0n,
      midTimeline: fallingMid(),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal.code).toBe("MARKOUT_HORIZON_UNOBSERVED");
  });

  it("refuses a horizon the recorded path does not reach rather than reporting zero", () => {
    const shortPath: MidTimeline = {
      midAt: ({ monotonicNs }) =>
        monotonicNs <= 1_000_000_000n ? { mid: "0.5", atEvent: AT_EVENT } : undefined,
    };
    const outcome = computeMarkouts({
      fill: fill(),
      filledAtNs: 0n,
      midTimeline: shortPath,
      resolutionValuePerShare: "0",
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal.code).toBe("MARKOUT_HORIZON_UNOBSERVED");
    expect(outcome.refusal.details["horizon"]).toBe("5s");
  });

  it("signs a SELL markout the other way", () => {
    const sell = fill({ simulatedFillId: "f-s", action: "SELL", price: "0.5" });
    const outcome = computeMarkouts({
      fill: sell,
      filledAtNs: 0n,
      midTimeline: fallingMid(),
      resolutionValuePerShare: "0",
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // Selling at 0.5 into a fall to 0.4 is FAVOURABLE.
    expect(outcome.value.observations.find((o) => o.horizon === "1s")?.perShare).toBe("0.1");
  });
});
