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
 * A row may also have NO realized value. In this scenario the rows that do not
 * are the `exit.cancelled_proceeds.*` ones: the bracket's first take-profit
 * rested and was withdrawn unfilled under §6 invariant 13's cancel-before-
 * replace, so the proceeds it projected have no counterpart. Such a row is
 * explained only by a mechanism declared `noRealizedValue`, and the verification
 * report states it as an absence rather than as a zero.
 *
 * `RISK-2` changed which row that is. It used to be `exit.expected_net_edge`,
 * "because the protective exit never reached the venue" — GOV-2B blocker B2.
 * The exit now reaches the venue and fills, so that row reconciles against a
 * real round trip.
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
  EXIT_BELOW_TAKE_PROFIT: {
    detail:
      "the strategy's edge projection assumes the bracket closes at the configured " +
      "exit.take_profit.price. This run's bracket did not: the market reached " +
      "exit_cutoff_before_close_seconds first, so §13.3's final_policy PROTECTED_REDUCE closed " +
      "it by crossing the book under exit.stop.minimum_sell_price instead. The contribution is " +
      "(realized exit proceeds − take_profit price × shares exited), exact in decimal, and is " +
      "NEGATIVE whenever the protective exit sold below the take-profit target.",
    noRealizedValue: false,
  },
  RESTING_EXIT_CANCELLED_UNFILLED: {
    detail:
      "no realized value exists. The bracket's first take-profit was placed, rested, and was " +
      "then WITHDRAWN unfilled — §6 invariant 13's cancel-before-replace, because the confirmed " +
      "allocation grew after that exit had been sized. A cancelled order produces no fill, so " +
      "the proceeds it projected have no realized counterpart and this row states an ABSENCE " +
      "rather than a zero. The cancel is counted on the health surface " +
      "(execution.cancelsRequested / cancelsConfirmed).",
    noRealizedValue: true,
  },
} as const;

/**
 * RETIRED 2026-09-15 by `RISK-2`: `PROTECTIVE_EXIT_REFUSED_AT_RISK_SEAM`.
 *
 * It read "no realized value exists. The WP-220 accepted residual: every exit
 * the Static Bracket emits is a §7.7 POSITION intent, packages/risk derives the
 * disposition from the intent TYPE alone, so a protective reduction is
 * classified ENTRY and is refused under the default
 * requirePositiveNetEdgeForEntries for want of an expectedNetEdge." That is
 * GOV-2B blocker B2, and it is fixed: `packages/risk` now derives a `POSITION`'s
 * disposition from its effect on the supplied portfolio, the protective exit is
 * approved, and it FILLS. `exit.expected_net_edge` therefore has a realized
 * counterpart and is reconciled as one rather than stated as an absence. The
 * mechanism is deleted rather than reworded because its every clause is now
 * false, and a named mechanism is a claim.
 */

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

  /**
   * THE ENTRY'S OWN FILLS, SEPARATED FROM EVERY OTHER FILL (`RISK-2`).
   *
   * Until B2 was fixed no exit of this scenario ever reached the venue, so
   * `artifact.fills` WAS the entry's fills and this module read the whole array
   * for every `entry.*` row. That is no longer true — the run now closes its
   * position — and reading the whole array would have silently reported
   * Σ(BUY 50 + SELL 50) = 100 shares and Σ notional = 33.2 as the ENTRY's, then
   * labelled the resulting rows "explained". A row that is arithmetically wrong
   * and wearing `EXACT_NO_DIFFERENCE` is worse than a row that fails.
   *
   * The attribution is by ID, down the artefact's own §6 invariant 4 chain —
   * intent → trace → execution plan → order → fill — never by `action`, which
   * would break on the complement leg where an entry SELLS and its exit BUYS.
   */
  const entryPlanIds = new Set(
    artifact.traces
      .filter((trace) => trace.intentId === entryIntent.intentId)
      .map((trace) => trace.executionPlanId),
  );
  const entryOrderIds = new Set(
    artifact.orders
      .filter((order) => entryPlanIds.has(order.executionPlanId))
      .map((order) => order.simulatedOrderId),
  );
  const entryFills = fills.filter((fill) => entryOrderIds.has(fill.simulatedOrderId));
  const exitFills = fills.filter((fill) => !entryOrderIds.has(fill.simulatedOrderId));
  if (entryFills.length === 0) {
    throw new Error(
      "no fill could be attributed to the entry intent through the trace chain; the entry rows " +
        "would compare against an empty set and are refused rather than reported as reconciled",
    );
  }

  const notionals = entryFills.map((fill) => mulDecimal(fill.price, fill.shares));
  const realizedNotional = sum(notionals);
  const realizedShares = sum(entryFills.map((fill) => fill.shares));
  const chargedFees = sum(entryFills.map((fill) => fill.feeAmount));
  const unroundedFees = sum(entryFills.map((fill) => unroundedVenueFee(fill, schedule)));
  const worstRealizedPrice = entryFills.reduce(
    (worst, fill) => (compareDecimal(fill.price, worst) > 0 ? fill.price : worst),
    entryFills[0]?.price ?? "0",
  );

  /** The EXIT side, on the same id-based attribution. */
  const exitProceeds = sum(exitFills.map((fill) => mulDecimal(fill.price, fill.shares)));
  const exitShares = sum(exitFills.map((fill) => fill.shares));
  const allChargedFees = sum(fills.map((fill) => fill.feeAmount));
  const allUnroundedFees = sum(fills.map((fill) => unroundedVenueFee(fill, schedule)));

  /**
   * The cost basis of the entry fills an exit has NOT yet retired, folded FIFO.
   *
   * `packages/pnl`'s open cost basis, computed the way `apps/trader`'s loop
   * describes it ("folded FIFO from the fills"), in exact decimal and with NO
   * DIVISION — an average price would not be exactly representable and §6
   * invariant 1 forbids reaching for a float to get one. It collapses to the
   * whole entry notional while the bracket is open and to exactly `"0"` once it
   * has closed, so the two PnL rows below hold in both states rather than only
   * in the open one they were written for.
   */
  let unretired = exitShares;
  let openCostBasis = "0";
  for (const fill of entryFills) {
    if (compareDecimal(unretired, fill.shares) >= 0) {
      unretired = subDecimal(unretired, fill.shares);
      continue;
    }
    openCostBasis = addDecimal(
      openCostBasis,
      mulDecimal(fill.price, subDecimal(fill.shares, unretired)),
    );
    unretired = "0";
  }

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
      "Σ over the ENTRY's own fills of feeAmount — the model this row compares against is " +
        "`entry.economics.entry_fee_per_share`, so the exit's fees are not in scope here",
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
        // The ENTRY's fills, matching the two totals above: a bound counted over
        // fills this row does not sum would be slack rather than a bound.
        mulDecimal(bound, String(entryFills.length)),
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

  /**
   * A projection line's balance, with an ABSENT line read as `"0"` (`RISK-2`).
   *
   * Both call sites used to write `line?.balance ?? ""`, and the empty string
   * reached `subDecimal`, which threw `InvalidDecimalStringError`. It never
   * fired while B2 kept every exit off the venue, because the position stayed
   * open and both lines were always present. The completed round trip closes the
   * outcome-token position, and this projection CARRIES NO LINE FOR A ZERO
   * BALANCE — verified by reading `virtualPositions` from a completed run, which
   * returns the collateral line alone.
   *
   * SO ABSENT IS READ AS `"0"`, NOT AS AN UNEXPLAINED ROW. The choice is between
   * two claims about the same fact. "Unexplained" would say the projection
   * failed to state a balance it owes; that is false — a zero balance is
   * faithfully represented here by the absence of a line, which is this
   * projection's own convention. Reading `"0"` states the convention, and the
   * row STAYS FALSIFIABLE either way: a ledger that was actually wrong carries a
   * PRESENT line with a non-zero balance, and `projection-reconciliation.test.ts`
   * tampers with exactly that to prove the row can fail.
   *
   * What it cannot distinguish is a correct zero from a line that never existed
   * — which is why `buildReconciliation` refuses a run with no fills at all, and
   * why the entry attribution above refuses a run whose entry fills cannot be
   * found. An absent line is only ever read here for an asset the same run
   * demonstrably traded.
   */
  const balanceOf = (line: { readonly balance: string } | undefined): string =>
    line?.balance ?? "0";

  rows.push(
    exact(
      "ledger.virtual_cash_delta",
      "the instance's collateral movement",
      // SIGNED over every fill: a BUY pays out, a SELL takes in, and fees are
      // paid on both. Before the round trip existed this read
      // `−(Σ notional + Σ fees)`, which is the same number only while every
      // fill is a BUY.
      subDecimal(subDecimal(exitProceeds, realizedNotional), allChargedFees),
      "(Σ exit fill notional − Σ entry fill notional − Σ charged fees on every fill), from " +
        "the venue's own fills",
      balanceOf(cashLine),
      "the §6 invariant 8 projection's VIRTUAL_STRATEGY collateral line, folded from the " +
        "append-only ledger",
    ),
  );

  rows.push(
    exact(
      "ledger.virtual_token_balance",
      "the instance's outcome-token position",
      // The NET position, not the gross traded quantity. Identical while the
      // bracket is open; zero once it has closed.
      subDecimal(realizedShares, exitShares),
      "Σ entry fill shares − Σ exit fill shares, from the venue's own fills",
      balanceOf(tokenLine),
      "the §6 invariant 8 projection's VIRTUAL_STRATEGY outcome-token line; an absent line is " +
        "a zero balance, which is how this projection represents a closed position",
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
      allChargedFees,
      "Σ over EVERY one of the venue's fills of feeAmount — the engine folds the exit's fees " +
        "as well as the entry's",
      field("feesPaid"),
      "the last persisted PnL snapshot's feesPaid",
    ),
  );

  rows.push(
    exact(
      "pnl.capital_committed",
      "capital committed to the STILL-OPEN position",
      openCostBasis,
      "the FIFO cost basis of the entry fills not yet retired by an exit fill — Σ price × " +
        "shares over the unretired remainder, which is the whole entry notional while the " +
        "bracket is open and exactly zero once it has closed",
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
      subDecimal(field("realizedPnl"), openCostBasis),
      "realizedPnl − Σ OPEN cost basis, the formula packages/pnl states, with the cost basis " +
        "folded FIFO from the venue's fills (zero once the bracket has closed)",
      field("worstCaseResolutionPnl"),
      "the last persisted PnL snapshot's worstCaseResolutionPnl",
    ),
  );

  // --- the round trip, now that one exists ----------------------------------

  /**
   * `RISK-2`: this row USED TO BE AN ABSENCE. It carried
   * `PROTECTIVE_EXIT_REFUSED_AT_RISK_SEAM` and said "no exit fill exists in this
   * run", which was true only because GOV-2B blocker B2 refused every
   * protective exit at the risk seam. The exit now fills, so the projection has
   * a realized counterpart and is reconciled against it.
   *
   * The difference is large and is stated as two exact contributions:
   * the exit did not happen at the take-profit price (the bracket ran out of
   * time and closed under §13.3's `final_policy`), and the venue's ad-valorem
   * fees are not the strategy's per-share constant.
   */
  const realizedRoundTrip = subDecimal(
    subDecimal(exitProceeds, realizedNotional),
    allChargedFees,
  );
  const targetProceeds = mulDecimal(scenario.takeProfitPrice, exitShares);
  const modelledFees = mulDecimal(
    addDecimal(scenario.entryFeePerShare, scenario.exitFeePerShare),
    realizedShares,
  );
  rows.push(
    finish(
      "exit.expected_net_edge",
      "the round trip's expected net edge against what the round trip actually returned",
      projectedEdge,
      "the entry POSITION intent's expectedNetEdge, as persisted with the decision",
      realizedRoundTrip,
      "Σ exit fill notional − Σ entry fill notional − Σ charged fees on every fill",
      [
        {
          mechanism: "EXIT_BELOW_TAKE_PROFIT",
          amount: subDecimal(exitProceeds, targetProceeds),
          note:
            `the projection assumed ${exitShares} shares would leave at ` +
            `${scenario.takeProfitPrice} for ${targetProceeds}; the protective reduction ` +
            `realized ${exitProceeds}`,
        },
        {
          mechanism: "FEE_MODEL_BASIS",
          amount: negateDecimal(subDecimal(allUnroundedFees, modelledFees)),
          note:
            `the strategy modelled (entry_fee_per_share + exit_fee_per_share) × shares = ` +
            `${modelledFees}; the schedule's exact ad-valorem total over every fill is ` +
            `${allUnroundedFees}`,
        },
        {
          mechanism: "FEE_ROUNDING_HALF_UP",
          amount: negateDecimal(subDecimal(allChargedFees, allUnroundedFees)),
          note:
            `rounding each fill HALF_UP to ${String(schedule.roundingDecimalPlaces)} places ` +
            `moved the exact total ${allUnroundedFees} to ${allChargedFees}`,
        },
      ],
    ),
  );

  // --- the projection with NO realized counterpart --------------------------

  const cancelledExits = artifact.orders.filter(
    (order) =>
      !entryOrderIds.has(order.simulatedOrderId) &&
      order.state === "CANCELLED" &&
      compareDecimal(order.filledShares, "0") === 0,
  );
  for (const order of cancelledExits) {
    rows.push(
      absent(
        `exit.cancelled_proceeds.${order.simulatedOrderId}`,
        "the proceeds a withdrawn take-profit projected",
        mulDecimal(order.limitPrice, order.requestedShares),
        "the cancelled order's own limitPrice × requestedShares",
        "no fill exists for this order",
        {
          mechanism: "RESTING_EXIT_CANCELLED_UNFILLED",
          amount: "0",
          note:
            `order ${order.simulatedOrderId} rested ${order.requestedShares} shares at ` +
            `${order.limitPrice} and was withdrawn with ${order.filledShares} filled; the run ` +
            `confirmed ${String(artifact.health.execution["cancelsConfirmed"] ?? 0)} cancel(s)`,
        },
      ),
    );
  }

  return Object.freeze(rows);
}

/** Every row whose difference is not fully accounted for. */
export function unexplainedRows(
  rows: readonly ReconciliationRow[],
): readonly ReconciliationRow[] {
  return rows.filter((row) => !row.explained);
}
