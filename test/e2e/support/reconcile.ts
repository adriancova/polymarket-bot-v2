/**
 * PROJECTED vs REALIZED reconciliation — `WP-250` acceptance criterion 2,
 * "zero unexplained projection difference in fixtures".
 *
 * ## What "explained" means here
 *
 * A difference is explained when, and only when, the row can state it as a SUM
 * OF NAMED MECHANISM CONTRIBUTIONS that reproduces it EXACTLY in decimal:
 *
 *     realized − projected = Σ contribution.amount     (residual must be "0")
 *
 * A label alone is not an explanation. `FEE_ROUNDING_HALF_UP` on a row whose
 * arithmetic does not close leaves a non-zero residual and the row is
 * UNEXPLAINED; a mechanism outside {@link MECHANISMS} makes the row unexplained
 * whatever its arithmetic says. That is the whole point of the criterion: it
 * has to be possible to FAIL it.
 *
 * A row may also have NO realized value — `exit.expected_net_edge` in this
 * scenario does not, because the protective exit never reached the venue. Such a
 * row is explained only by a mechanism declared `noRealizedValue`, and the
 * verification report states it as an absence rather than as a zero.
 *
 * ## Independence
 *
 * The venue fee is RECOMPUTED here from the schedule's documented formula
 *
 *     fee = shares × rate × price × (1 − price)
 *
 * (`packages/simulation/src/fees.ts`) and compared with the amount the venue
 * actually charged. That is deliberate: a reconciliation that read the charged
 * fee and called it the projection would agree with itself. The recomputation
 * is exact — `@polymarket-bot/decimal`, never a float — and only the ROUNDING
 * step is left to the venue, which is why the residual it leaves is attributed
 * to the rounding rule and bounded by half a unit in the last place.
 *
 * Everything this module reads comes from the serialised artefact. It never
 * touches a live trader, venue or ledger.
 */

import {
  absDecimal,
  addDecimal,
  compareDecimal,
  mulDecimal,
  negateDecimal,
  subDecimal,
} from "@polymarket-bot/decimal";

import type { ArtifactFill, PaperRunArtifact } from "./artifact.js";

/** The closed set of mechanisms a difference may be attributed to. */
export const MECHANISMS = {
  EXACT_NO_DIFFERENCE: {
    detail:
      "the projected and realized values are equal. A row carrying this mechanism must have a " +
      "difference of exactly zero; a non-zero difference wearing this label is a FAILURE, not " +
      "an explanation.",
    noRealizedValue: false,
  },
  COST_CAP_HEADROOM: {
    detail:
      "§7.7's maximumTotalCost is a BOUND the planner may not exceed, not a forecast of what " +
      "the trade will cost. The headroom is (cap − realized cost) and is expected to be " +
      "non-negative; a negative headroom would mean the cap was breached.",
    noRealizedValue: false,
  },
  FEE_MODEL_BASIS: {
    detail:
      "the strategy's entry.economics fee model is a CONFIGURED CONSTANT PER SHARE — " +
      "packages/strategies/static-bracket asserts no venue fee schedule, because that is a " +
      "versioned venue fact owned elsewhere (§6 invariant 9) — while the venue charges an " +
      "ad-valorem fee, shares × rate × price × (1 − price). The two bases are different by " +
      "design, and the difference is this contribution.",
    noRealizedValue: false,
  },
  FEE_ROUNDING_HALF_UP: {
    detail:
      "the fee schedule's rounding rule: the exact product is rounded HALF_UP to the " +
      "schedule's roundingDecimalPlaces. The contribution is bounded by half a unit in the " +
      "last place, and this module checks that bound rather than assuming it.",
    noRealizedValue: false,
  },
  PROTECTIVE_EXIT_REFUSED_AT_RISK_SEAM: {
    detail:
      "no realized value exists. The WP-220 accepted residual: every exit the Static Bracket " +
      "emits is a §7.7 POSITION intent, packages/risk derives the disposition from the intent " +
      "TYPE alone, so a protective reduction is classified ENTRY and is refused under the " +
      "default requirePositiveNetEdgeForEntries for want of an expectedNetEdge. The refusal " +
      "is counted on the health surface (risk.refusedExits / refusedExitsByCode) and is NOT " +
      "worked around here: the projection therefore has no realized counterpart in this run.",
    noRealizedValue: true,
  },
} as const;

export type MechanismName = keyof typeof MECHANISMS;

export interface Contribution {
  readonly mechanism: MechanismName;
  /** Signed decimal string. The contributions of a row sum to its difference. */
  readonly amount: string;
  readonly note: string;
}

export interface ReconciliationRow {
  readonly id: string;
  readonly quantity: string;
  readonly projected: string;
  readonly projectedSource: string;
  /** `null` when the run produced no realized counterpart at all. */
  readonly realized: string | null;
  readonly realizedSource: string;
  /** `realized − projected`, or `null` when there is no realized value. */
  readonly difference: string | null;
  readonly contributions: readonly Contribution[];
  /** `difference − Σ contributions`. Must be `"0"` for an explained row. */
  readonly residual: string | null;
  readonly explained: boolean;
  /** Why the row is unexplained, when it is. Empty otherwise. */
  readonly unexplainedReasons: readonly string[];
}

function exact(
  id: string,
  quantity: string,
  projected: string,
  projectedSource: string,
  realized: string,
  realizedSource: string,
): ReconciliationRow {
  return finish(id, quantity, projected, projectedSource, realized, realizedSource, [
    {
      mechanism: "EXACT_NO_DIFFERENCE",
      amount: "0",
      note: "the two values agree exactly",
    },
  ]);
}

function finish(
  id: string,
  quantity: string,
  projected: string,
  projectedSource: string,
  realized: string,
  realizedSource: string,
  contributions: readonly Contribution[],
  /**
   * Reasons the CALLER found, folded in here so a row that fails a
   * mechanism-specific bound is unexplained by the same rule as every other
   * failure. The half-unit rounding bound is the only current user.
   */
  extraReasons: readonly string[] = [],
): ReconciliationRow {
  const difference = subDecimal(realized, projected);
  let residual = difference;
  const reasons: string[] = [...extraReasons];
  for (const contribution of contributions) {
    if (!Object.hasOwn(MECHANISMS, contribution.mechanism)) {
      reasons.push(`${contribution.mechanism} is not a named mechanism`);
      continue;
    }
    if (MECHANISMS[contribution.mechanism].noRealizedValue) {
      reasons.push(
        `${contribution.mechanism} explains an ABSENT realized value and cannot explain a ` +
          "numeric difference",
      );
    }
    residual = subDecimal(residual, contribution.amount);
  }
  if (contributions.length === 0) {
    reasons.push("no mechanism was named");
  }
  if (compareDecimal(residual, "0") !== 0) {
    reasons.push(`the named mechanisms leave an unexplained residual of ${residual}`);
  }
  for (const contribution of contributions) {
    if (
      contribution.mechanism === "EXACT_NO_DIFFERENCE" &&
      compareDecimal(difference, "0") !== 0
    ) {
      reasons.push(
        `EXACT_NO_DIFFERENCE claims the values agree, but they differ by ${difference}`,
      );
    }
  }
  return {
    id,
    quantity,
    projected,
    projectedSource,
    realized,
    realizedSource,
    difference,
    contributions,
    residual,
    explained: reasons.length === 0,
    unexplainedReasons: Object.freeze(reasons),
  };
}

function absent(
  id: string,
  quantity: string,
  projected: string,
  projectedSource: string,
  realizedSource: string,
  contribution: Contribution,
): ReconciliationRow {
  const declared = Object.hasOwn(MECHANISMS, contribution.mechanism)
    ? MECHANISMS[contribution.mechanism].noRealizedValue
    : false;
  return {
    id,
    quantity,
    projected,
    projectedSource,
    realized: null,
    realizedSource,
    difference: null,
    contributions: [contribution],
    residual: null,
    explained: declared,
    unexplainedReasons: declared
      ? Object.freeze([])
      : Object.freeze([
          `${contribution.mechanism} is not declared as an absent-realized-value mechanism`,
        ]),
  };
}

/** The exact, unrounded venue fee for one fill, from the schedule's formula. */
export function unroundedVenueFee(
  fill: ArtifactFill,
  schedule: { readonly takerFeeRate: string; readonly makerFeeRate: string },
): string {
  const rate = fill.liquidityRole === "MAKER" ? schedule.makerFeeRate : schedule.takerFeeRate;
  const complement = subDecimal("1", fill.price);
  return mulDecimal(mulDecimal(mulDecimal(fill.shares, rate), fill.price), complement);
}

/** Half a unit in the last place, as a decimal string: the HALF_UP bound. */
export function halfUpBound(places: number): string {
  return `0.${"0".repeat(places)}5`;
}

function sum(values: readonly string[]): string {
  return values.reduce((total, value) => addDecimal(total, value), "0");
}

/**
 * Builds the whole reconciliation table for one captured run.
 *
 * Pure. Reads only the artefact, and every number it derives is derived with
 * `@polymarket-bot/decimal` — no float appears anywhere in this file.
 */
export function buildReconciliation(
  artifact: Omit<PaperRunArtifact, "reconciliation">,
): readonly ReconciliationRow[] {
  const rows: ReconciliationRow[] = [];
  const scenario = artifact.scenario;
  const schedule = scenario.feeSchedule;

  const entry = artifact.decisions.find((decision) => decision.decisionType === "enter");
  if (entry === undefined) {
    throw new Error(
      "the run produced no entry decision; the reconciliation has nothing to compare and " +
        "refuses to report an empty table as a passing one",
    );
  }
  const entryIntent = entry.intents.find((intent) => intent.type === "POSITION");
  if (entryIntent === undefined) {
    throw new Error("the entry decision emitted no POSITION intent");
  }

  const fills = artifact.fills;
  if (fills.length === 0) {
    throw new Error("the run produced no fill; there is nothing realized to reconcile against");
  }

  const notionals = fills.map((fill) => mulDecimal(fill.price, fill.shares));
  const realizedNotional = sum(notionals);
  const realizedShares = sum(fills.map((fill) => fill.shares));
  const chargedFees = sum(fills.map((fill) => fill.feeAmount));
  const unroundedFees = sum(fills.map((fill) => unroundedVenueFee(fill, schedule)));
  const worstRealizedPrice = fills.reduce(
    (worst, fill) => (compareDecimal(fill.price, worst) > 0 ? fill.price : worst),
    fills[0]?.price ?? "0",
  );

  // --- the strategy's own projections, from the PERSISTED decision ----------

  const trigger = String(entry.modelOutputs["trigger"] ?? "");
  const projectedCost = String(entry.modelOutputs["entryCost"] ?? "");
  const worstPrice = String(entry.modelOutputs["worstPrice"] ?? "");
  const projectedEdge = String(entry.modelOutputs["expectedNetEdge"] ?? "");

  rows.push(
    exact(
      "entry.executable_price_notional",
      "the notional the §9.5 executable-buy-price feature projected for the configured size",
      mulDecimal(trigger, realizedShares),
      `persisted decision (runId ${entry.runId}, evaluationSeq ${String(entry.evaluationSeq)}) ` +
        `modelOutputs.trigger = ${trigger}, times the shares actually filled`,
      realizedNotional,
      "Σ over the venue's fills of price × shares",
    ),
  );

  rows.push(
    exact(
      "entry.projected_cost",
      "the entry cost the strategy quoted before emitting the intent",
      projectedCost,
      "persisted decision modelOutputs.entryCost",
      realizedNotional,
      "Σ over the venue's fills of price × shares",
    ),
  );

  rows.push(
    exact(
      "entry.shares",
      "the position size",
      entryIntent.targetShares ?? "",
      "the §7.7 POSITION intent's targetShares, as persisted with the decision",
      realizedShares,
      "Σ over the venue's fills of shares",
    ),
  );

  rows.push(
    exact(
      "entry.worst_price",
      "the worst per-share price the entry would pay",
      worstPrice,
      "persisted decision modelOutputs.worstPrice",
      worstRealizedPrice,
      "the highest price among the venue's fills for this order",
    ),
  );

  const capHeadroom = subDecimal(realizedNotional, entryIntent.maximumTotalCost ?? "0");
  rows.push(
    finish(
      "entry.cost_cap",
      "the §7.7 cost cap against what the entry actually cost",
      entryIntent.maximumTotalCost ?? "",
      "the POSITION intent's maximumTotalCost",
      realizedNotional,
      "Σ over the venue's fills of price × shares",
      [
        {
          mechanism: "COST_CAP_HEADROOM",
          amount: capHeadroom,
          note:
            `the cap was not reached: ${realizedNotional} of ${entryIntent.maximumTotalCost ?? ""} ` +
            `was spent, leaving ${negateDecimal(capHeadroom)} of headroom. A cap is a bound, ` +
            "not a forecast.",
        },
      ],
    ),
  );

  // The strategy's documented edge formula, recomputed here and compared with
  // the number the intent carries: `takeProfit × size − entryCost − (entryFee +
  // exitFee) × size` (`packages/strategies/static-bracket/src/decide.ts`).
  const modelledEdge = subDecimal(
    subDecimal(mulDecimal(scenario.takeProfitPrice, realizedShares), projectedCost),
    mulDecimal(
      addDecimal(scenario.entryFeePerShare, scenario.exitFeePerShare),
      realizedShares,
    ),
  );
  rows.push(
    exact(
      "entry.expected_net_edge_formula",
      "the strategy's expected net edge, recomputed from its documented formula",
      modelledEdge,
      "takeProfitPrice × shares − entryCost − (entryFeePerShare + exitFeePerShare) × shares, " +
        "recomputed by this suite from the scenario's own configuration",
      entryIntent.expectedNetEdge ?? "",
      "the POSITION intent's expectedNetEdge, as persisted with the decision",
    ),
  );

  // --- fees, per fill and in aggregate --------------------------------------

  const bound = halfUpBound(schedule.roundingDecimalPlaces);
  for (const fill of fills) {
    const unrounded = unroundedVenueFee(fill, schedule);
    const delta = subDecimal(fill.feeAmount, unrounded);
    const withinBound = compareDecimal(absDecimal(delta), bound) <= 0;
    rows.push(
      finish(
        `fee.fill.${fill.simulatedFillId}`,
        `the venue fee on ${fill.shares} shares at ${fill.price}`,
        unrounded,
        `recomputed exactly from the schedule formula shares × ${
          fill.liquidityRole === "MAKER" ? schedule.makerFeeRate : schedule.takerFeeRate
        } × price × (1 − price)`,
        fill.feeAmount,
        "the feeAmount the venue charged on this fill",
        [
          {
            mechanism: "FEE_ROUNDING_HALF_UP",
            amount: delta,
            note:
              `HALF_UP to ${String(schedule.roundingDecimalPlaces)} decimal places moved the ` +
              `exact ${unrounded} to ${fill.feeAmount}, a change of ${delta}` +
              (withinBound
                ? `, within the half-unit bound ${bound}`
                : `, which EXCEEDS the half-unit bound ${bound} and is therefore not a rounding step`),
          },
        ],
        withinBound
          ? []
          : [
              `the change of ${delta} exceeds ${bound}, half a unit in the last place: ` +
                "HALF_UP rounding cannot move a value that far, so the mechanism named here " +
                "does not explain the difference",
            ],
      ),
    );
  }

  rows.push(
    finish(
      "fee.total_model_vs_venue",
      "the strategy's per-share fee model against what the venue actually charged",
      mulDecimal(scenario.entryFeePerShare, realizedShares),
      "entry.economics.entry_fee_per_share × shares — the strategy's configured constant",
      chargedFees,
      "Σ over the venue's fills of feeAmount",
      [
        {
          mechanism: "FEE_MODEL_BASIS",
          amount: subDecimal(
            unroundedFees,
            mulDecimal(scenario.entryFeePerShare, realizedShares),
          ),
          note:
            `the ad-valorem schedule's exact total is ${unroundedFees}; the per-share model's ` +
            `total is ${mulDecimal(scenario.entryFeePerShare, realizedShares)}`,
        },
        {
          mechanism: "FEE_ROUNDING_HALF_UP",
          amount: subDecimal(chargedFees, unroundedFees),
          note:
            `rounding each fill HALF_UP to ${String(schedule.roundingDecimalPlaces)} places ` +
            `moved the exact total ${unroundedFees} to ${chargedFees}`,
        },
      ],
      compareDecimal(
        absDecimal(subDecimal(chargedFees, unroundedFees)),
        mulDecimal(bound, String(fills.length)),
      ) <= 0
        ? []
        : [
            "the aggregate rounding change exceeds the number of fills times half a unit in " +
              "the last place, which no sequence of per-fill HALF_UP steps can produce",
          ],
    ),
  );

  // --- the ledger, folded from the append-only history ----------------------

  const cashLine = artifact.ledgerProjection.virtualPositions.find(
    (line) => line.assetId === scenario.denominationAssetId,
  );
  const tokenLine = artifact.ledgerProjection.virtualPositions.find(
    (line) => line.assetKind === "OUTCOME_TOKEN",
  );

  rows.push(
    exact(
      "ledger.virtual_cash_delta",
      "the instance's collateral movement",
      negateDecimal(addDecimal(realizedNotional, chargedFees)),
      "−(Σ fill notional + Σ charged fees), from the venue's own fills",
      cashLine?.balance ?? "",
      "the §6 invariant 8 projection's VIRTUAL_STRATEGY collateral line, folded from the " +
        "append-only ledger",
    ),
  );

  rows.push(
    exact(
      "ledger.virtual_token_balance",
      "the instance's outcome-token position",
      realizedShares,
      "Σ over the venue's fills of shares",
      tokenLine?.balance ?? "",
      "the §6 invariant 8 projection's VIRTUAL_STRATEGY outcome-token line",
    ),
  );

  // --- PnL, from the LAST persisted snapshot --------------------------------

  const snapshot = artifact.pnlSnapshots.at(-1);
  if (snapshot === undefined) {
    throw new Error("the run persisted no PnL snapshot; the chain does not reach §9.16");
  }
  const field = (name: string): string => String(snapshot[name] ?? "");

  rows.push(
    exact(
      "pnl.fees_paid",
      "fees, as the PnL engine folded them",
      chargedFees,
      "Σ over the venue's fills of feeAmount",
      field("feesPaid"),
      "the last persisted PnL snapshot's feesPaid",
    ),
  );

  rows.push(
    exact(
      "pnl.capital_committed",
      "capital committed to the open position",
      realizedNotional,
      "Σ over the venue's fills of price × shares",
      field("capitalCommitted"),
      "the last persisted PnL snapshot's capitalCommitted",
    ),
  );

  rows.push(
    exact(
      "pnl.gross_trading",
      "§9.16's gross trading PnL identity",
      addDecimal(field("realizedPnl"), field("unrealizedPnlMidpoint")),
      "realizedPnl + unrealizedPnlMidpoint, from the snapshot's own components",
      field("grossTradingPnl"),
      "the last persisted PnL snapshot's grossTradingPnl",
    ),
  );

  rows.push(
    exact(
      "pnl.core_net",
      "§6 invariant 14's core net PnL identity",
      subDecimal(field("grossTradingPnl"), field("feesPaid")),
      "grossTradingPnl − feesPaid, from the snapshot's own components (rewards excluded " +
        "entirely, and this run has none)",
      field("coreNetPnl"),
      "the last persisted PnL snapshot's coreNetPnl",
    ),
  );

  rows.push(
    exact(
      "pnl.worst_case_resolution",
      "the documented worst-case-resolution identity",
      subDecimal(field("realizedPnl"), realizedNotional),
      "realizedPnl − Σ open cost basis, the formula packages/pnl states, with the cost basis " +
        "taken from the venue's fills",
      field("worstCaseResolutionPnl"),
      "the last persisted PnL snapshot's worstCaseResolutionPnl",
    ),
  );

  // --- the projection with NO realized counterpart --------------------------

  const refusalCodes = Object.keys(artifact.health.risk.refusedExitsByCode).sort();
  rows.push(
    absent(
      "exit.expected_net_edge",
      "the round trip's expected net edge",
      projectedEdge,
      "the entry POSITION intent's expectedNetEdge, as persisted with the decision",
      "no exit fill exists in this run",
      {
        mechanism: "PROTECTIVE_EXIT_REFUSED_AT_RISK_SEAM",
        amount: "0",
        note:
          `the run's ${String(artifact.health.risk.refusedExits)} refused protective exit(s) ` +
          `carry reason code(s) ${refusalCodes.join(", ")}, counted on the health surface. No ` +
          "exit order was ever submitted, so the projection has no realized counterpart and " +
          "this row states an ABSENCE rather than a zero.",
      },
    ),
  );

  return Object.freeze(rows);
}

/** Every row whose difference is not fully accounted for. */
export function unexplainedRows(
  rows: readonly ReconciliationRow[],
): readonly ReconciliationRow[] {
  return rows.filter((row) => !row.explained);
}
