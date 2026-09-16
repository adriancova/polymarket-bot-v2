/**
 * `WP-250` ACCEPTANCE CRITERION 2: **zero unexplained projection difference in
 * fixtures.**
 *
 * Every difference between a projected and a realized value in this scenario is
 * stated as a sum of NAMED MECHANISM contributions that reproduces it exactly in
 * decimal. `support/reconcile.ts` builds the table; this file asserts the
 * property, pins the specific mechanisms this scenario exercises, and — because
 * a criterion that cannot fail is not a criterion — proves the check is
 * falsifiable four different ways.
 *
 * ## The differences this scenario contains, and why each is there
 *
 * | Row | Difference | Mechanism |
 * | --- | --- | --- |
 * | `entry.cost_cap` | `-0.8` | `COST_CAP_HEADROOM` — §7.7's `maximumTotalCost` is a bound, not a forecast |
 * | `fee.fill.…2000:g0:o0/t0/0` | `-0.000274` | `FEE_ROUNDING_HALF_UP` — rounded DOWN to 3 places |
 * | `fee.fill.…2000:g0:o0/t0/1` | `+0.000275` | `FEE_ROUNDING_HALF_UP` — rounded UP to 3 places |
 * | `fee.fill.…13000:g0:o0/t0/0` | `-0.00016` | `FEE_ROUNDING_HALF_UP` — the EXIT fill's fee |
 * | `fee.total_model_vs_venue` | `+0.17` | `FEE_MODEL_BASIS` + `FEE_ROUNDING_HALF_UP` |
 * | `exit.expected_net_edge` | `-9.332` | `EXIT_BELOW_TAKE_PROFIT` (`-9`) + `FEE_MODEL_BASIS` (`-0.332159`) + `FEE_ROUNDING_HALF_UP` (`+0.000159`) |
 * | `exit.cancelled_proceeds.…d000:g0:o0` | none exists | `RESTING_EXIT_CANCELLED_UNFILLED` |
 *
 * The two entry fee rows round in OPPOSITE directions on purpose (see
 * `support/scenario.ts`): a rounding rule observed only downward is a rule half
 * observed. Every other row is an exact equality, and each of those is a claim
 * that could have failed — the strategy's projected entry cost over a TWO-LEVEL
 * ladder, its own edge formula, the ledger's folded balances and four §9.16
 * identities.
 *
 * ## `RISK-2` changed the last two rows, and only those
 *
 * Before GOV-2B blocker B2 was fixed, `exit.expected_net_edge` was an ABSENCE
 * carrying `PROTECTIVE_EXIT_REFUSED_AT_RISK_SEAM` — the protective exit could
 * not clear the risk seam, so the run never sold what it bought and there was no
 * round trip to reconcile. There is one now: the bracket closes under §13.3's
 * `final_policy: PROTECTED_REDUCE` at the exit cutoff, which is why the realized
 * edge is `-1.632` against a projection of `7.7` that assumed a take-profit at
 * `0.5`. The whole `-9.332` is named, and the scenario still contains a row with
 * no realized counterpart — the take-profit that rested and was withdrawn — so
 * the `noRealizedValue` discipline is still exercised rather than retired.
 */

import { describe, expect, it } from "vitest";

import { addDecimal, compareDecimal, subDecimal } from "@polymarket-bot/decimal";

import { captureArtifact, type PaperRunArtifact } from "./support/artifact.js";
import { goldenBytes } from "./support/golden.js";
import { driveScenario } from "./support/harness.js";
import {
  MECHANISMS,
  buildReconciliation,
  halfUpBound,
  unexplainedRows,
  unroundedVenueFee,
} from "./support/reconcile.js";

async function table(): Promise<PaperRunArtifact> {
  return captureArtifact(await driveScenario());
}

describe("acceptance 2 — zero unexplained projection difference", () => {
  it("every row is explained: the named mechanisms reproduce the difference exactly", async () => {
    const artifact = await table();
    const unexplained = unexplainedRows(artifact.reconciliation);
    expect(
      unexplained.map((row) => `${row.id}: ${row.unexplainedReasons.join("; ")}`),
    ).toEqual([]);
    expect(artifact.reconciliation.length).toBeGreaterThan(0);
    for (const row of artifact.reconciliation) {
      expect(row.explained).toBe(true);
      // A row with a realized value must close to a ZERO residual — the label
      // is never enough on its own.
      if (row.realized !== null) expect(row.residual).toBe("0");
      for (const contribution of row.contributions) {
        expect(Object.keys(MECHANISMS)).toContain(contribution.mechanism);
      }
    }
  });

  it("the same table is reproduced from the COMMITTED GOLDEN bytes", () => {
    const golden = JSON.parse(goldenBytes()) as PaperRunArtifact;
    const rebuilt = buildReconciliation(golden);
    expect(unexplainedRows(rebuilt)).toEqual([]);
    // Rebuilt from the document alone, the table must be the table the golden
    // carries — otherwise the frozen reconciliation and the frozen run disagree.
    expect(rebuilt).toEqual(golden.reconciliation);
  });

  it("every difference that is NOT zero names a non-EXACT mechanism", async () => {
    const artifact = await table();
    const differing = artifact.reconciliation.filter(
      (row) => row.difference !== null && compareDecimal(row.difference, "0") !== 0,
    );
    // The scenario is built to contain differences. A run with none would mean
    // the fixture stopped exercising the mechanisms it exists to exercise.
    expect(differing.length).toBeGreaterThan(0);
    for (const row of differing) {
      expect(row.contributions.map((contribution) => contribution.mechanism)).not.toContain(
        "EXACT_NO_DIFFERENCE",
      );
    }
    expect(differing.map((row) => row.id).sort()).toEqual([
      "entry.cost_cap",
      // `RISK-2`: the round trip exists now, so its edge projection has a
      // realized counterpart and a (large, fully explained) difference.
      "exit.expected_net_edge",
      "fee.fill.9280f970-9280-7000-8000-000000002000:g0:o0/t0/0",
      "fee.fill.9280f970-9280-7000-8000-000000002000:g0:o0/t0/1",
      // …and the EXIT fill has a fee of its own, which also rounds.
      "fee.fill.9280f970-9280-7000-8000-000000013000:g0:o0/t0/0",
      "fee.total_model_vs_venue",
    ]);
  });

  it("the venue's fee is REPRODUCED from the schedule formula, not read back", async () => {
    const artifact = await table();
    const schedule = artifact.scenario.feeSchedule;
    const bound = halfUpBound(schedule.roundingDecimalPlaces);
    expect(schedule.takerFeeRate).not.toBe("0");

    const directions = new Set<string>();
    for (const fill of artifact.fills) {
      const exactFee = unroundedVenueFee(fill, schedule);
      const delta = subDecimal(fill.feeAmount, exactFee);
      // A rounding step moves a value by at most half a unit in the last place.
      expect(compareDecimal(delta, bound) <= 0).toBe(true);
      expect(compareDecimal(delta, `-${bound}`) >= 0).toBe(true);
      directions.add(compareDecimal(delta, "0") > 0 ? "UP" : "DOWN");
      // The exact product is NOT the charged amount: if it were, the fixture
      // would be exercising no rounding at all.
      expect(exactFee).not.toBe(fill.feeAmount);
    }
    // Both directions of HALF_UP are observed in this one run.
    expect([...directions].sort()).toEqual(["DOWN", "UP"]);
  });

  it("the strategy's fee MODEL and the venue's SCHEDULE differ, and the gap is named", async () => {
    const artifact = await table();
    const row = artifact.reconciliation.find((entry) => entry.id === "fee.total_model_vs_venue");
    expect(row).toBeDefined();
    if (row === undefined) return;
    expect(row.projected).toBe("0.05");
    expect(row.realized).toBe("0.22");
    expect(row.difference).toBe("0.17");
    expect(row.contributions.map((contribution) => contribution.mechanism)).toEqual([
      "FEE_MODEL_BASIS",
      "FEE_ROUNDING_HALF_UP",
    ]);
    const summed = row.contributions.reduce(
      (total, contribution) => addDecimal(total, contribution.amount),
      "0",
    );
    expect(summed).toBe(row.difference);
  });

  /**
   * `RISK-2`. This test's subject moved, and its MECHANISM did not.
   *
   * It used to assert the absence on `exit.expected_net_edge`, carrying
   * `PROTECTIVE_EXIT_REFUSED_AT_RISK_SEAM`, together with
   * `artifact.health.risk.refusedExits > 0`. That was GOV-2B blocker B2: the
   * protective exit could not clear the risk seam, so no exit ever filled and
   * the round trip's edge had no realized counterpart. It has one now. What is
   * still pinned is the rule — a row with no realized counterpart must be stated
   * as an ABSENCE and must carry a `noRealizedValue` mechanism — applied to the
   * row that genuinely has none: the take-profit that rested and was withdrawn.
   */
  it("the projection with NO realized value is stated as an ABSENCE, not a zero", async () => {
    const artifact = await table();
    const rows = artifact.reconciliation.filter((entry) =>
      entry.id.startsWith("exit.cancelled_proceeds."),
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.realized).toBeNull();
      expect(row.difference).toBeNull();
      expect(row.residual).toBeNull();
      expect(row.explained).toBe(true);
      expect(row.contributions[0]?.mechanism).toBe("RESTING_EXIT_CANCELLED_UNFILLED");
    }
    expect(MECHANISMS.RESTING_EXIT_CANCELLED_UNFILLED.noRealizedValue).toBe(true);
    // The mechanism's claim is checked against the health surface rather than
    // trusted: an order really was withdrawn unfilled in this run.
    expect(artifact.health.execution["cancelsConfirmed"] ?? 0).toBeGreaterThan(0);
    // …and the fact that moved this test: nothing is refused at the seam any
    // more, and the run really does sell what it bought.
    expect(artifact.health.risk.refusedExits).toBe(0);
    expect(artifact.fills.some((fill) => fill.action === "SELL")).toBe(true);
  });

  it("the ROUND TRIP reconciles: what was an absence is now a realized value", async () => {
    const artifact = await table();
    const row = artifact.reconciliation.find((entry) => entry.id === "exit.expected_net_edge");
    expect(row).toBeDefined();
    if (row === undefined) return;
    expect(row.realized).not.toBeNull();
    expect(row.residual).toBe("0");
    expect(row.explained).toBe(true);
    expect(row.contributions.map((contribution) => contribution.mechanism)).toEqual([
      "EXIT_BELOW_TAKE_PROFIT",
      "FEE_MODEL_BASIS",
      "FEE_ROUNDING_HALF_UP",
    ]);
    const summed = row.contributions.reduce(
      (total, contribution) => addDecimal(total, contribution.amount),
      "0",
    );
    expect(summed).toBe(row.difference);
  });

  it("§6 invariant 1: no reconciliation value is a JavaScript number", async () => {
    const artifact = await table();
    for (const row of artifact.reconciliation) {
      expect(typeof row.projected).toBe("string");
      expect(row.realized === null || typeof row.realized === "string").toBe(true);
      expect(row.difference === null || typeof row.difference === "string").toBe(true);
      for (const contribution of row.contributions) {
        expect(typeof contribution.amount).toBe("string");
      }
    }
  });
});

describe("the reconciliation is falsifiable", () => {
  it("a fabricated realized value leaves an unexplained residual", () => {
    const golden = JSON.parse(goldenBytes()) as PaperRunArtifact;
    const fills = golden.fills.map((fill, index) =>
      index === 0 ? { ...fill, feeAmount: "0.5" } : fill,
    );
    const rebuilt = buildReconciliation({ ...golden, fills });
    const unexplained = unexplainedRows(rebuilt);
    expect(unexplained.length).toBeGreaterThan(0);
    expect(unexplained.map((row) => row.id)).toContain(
      "fee.fill.9280f970-9280-7000-8000-000000002000:g0:o0/t0/0",
    );
    // The reason is the BOUND, not merely a non-zero residual: a fee 0.37 away
    // from the exact product is not a rounding step, and the row says so.
    expect(unexplained[0]?.unexplainedReasons.join(" ")).toContain(
      "half a unit in the last place",
    );
  });

  it("a moved projected value breaks the exact rows", () => {
    const golden = JSON.parse(goldenBytes()) as PaperRunArtifact;
    const decisions = golden.decisions.map((decision) =>
      decision.decisionType === "enter"
        ? { ...decision, modelOutputs: { ...decision.modelOutputs, entryCost: "17.3" } }
        : decision,
    );
    const rebuilt = buildReconciliation({ ...golden, decisions });
    expect(unexplainedRows(rebuilt).map((row) => row.id)).toContain("entry.projected_cost");
  });

  /**
   * `RISK-2` had to change HOW this tampers, and it now tampers twice.
   *
   * It used to rewrite the OUTCOME_TOKEN line's balance to `"49"`. The run now
   * closes its position, so the projection carries no outcome-token line at all
   * — the `.map` found nothing to rewrite and the tampered document was
   * identical to the honest one, which would have made this falsifiability
   * check silently vacuous. Both ledger rows are tampered instead, each in the
   * way that is actually available: a line that EXISTS is corrupted, and a line
   * that does NOT exist is fabricated. That also pins the `absent → "0"` reading
   * in `reconcile.ts` from the other side — a spurious non-zero line is caught.
   */
  it("a ledger balance that disagrees with the fills is unexplained", () => {
    const golden = JSON.parse(goldenBytes()) as PaperRunArtifact;

    // 1. Corrupt the COLLATERAL line, which is present.
    const corrupted = golden.ledgerProjection.virtualPositions.map((line) =>
      line.assetKind === "COLLATERAL" ? { ...line, balance: "-1.5" } : line,
    );
    expect(corrupted.some((line) => line.assetKind === "COLLATERAL")).toBe(true);
    expect(
      unexplainedRows(
        buildReconciliation({
          ...golden,
          ledgerProjection: { ...golden.ledgerProjection, virtualPositions: corrupted },
        }),
      ).map((row) => row.id),
    ).toContain("ledger.virtual_cash_delta");

    // 2. Fabricate an OUTCOME_TOKEN line, which a closed position must not have.
    expect(
      golden.ledgerProjection.virtualPositions.some(
        (line) => line.assetKind === "OUTCOME_TOKEN",
      ),
    ).toBe(false);
    const fabricated = [
      ...golden.ledgerProjection.virtualPositions,
      {
        instanceId: golden.scenario.instanceId,
        assetId: "token:9001",
        assetKind: "OUTCOME_TOKEN",
        marketId: golden.scenario.marketId,
        balance: "49",
      },
    ];
    expect(
      unexplainedRows(
        buildReconciliation({
          ...golden,
          ledgerProjection: { ...golden.ledgerProjection, virtualPositions: fabricated },
        }),
      ).map((row) => row.id),
    ).toContain("ledger.virtual_token_balance");
  });

  it("a run with no fill is refused outright rather than reported as reconciled", () => {
    const golden = JSON.parse(goldenBytes()) as PaperRunArtifact;
    // An empty table is not a table with zero unexplained rows. The builder
    // refuses, so a scenario that silently stopped trading cannot pass the
    // criterion by producing nothing to compare.
    expect(() => buildReconciliation({ ...golden, fills: [] })).toThrow(/no fill/u);
    expect(() =>
      buildReconciliation({
        ...golden,
        decisions: golden.decisions.filter((decision) => decision.decisionType !== "enter"),
      }),
    ).toThrow(/no entry decision/u);
  });
});
