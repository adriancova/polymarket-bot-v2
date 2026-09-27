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
  divDecimal,
  mulDecimal,
  negateDecimal,
  subDecimal,
  type DivisionOptions,
} from "@polymarket-bot/decimal";

import type {
  ArtifactDecision,
  ArtifactFill,
  ArtifactIntent,
  ArtifactOrder,
  PaperRunArtifact,
} from "./artifact.js";

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

// --- attribution: which fills and orders are the ENTRY's, which an EXIT's ----

/**
 * The §7.5 decision types whose intents CLOSE what the entry opened.
 *
 * `exit` is the bracket's take-profit and `reduce` is §13.3's protective
 * reduction. No other type owns an exit: `quote`, `hold`, `skip` and `cancel`
 * are not exits, and an intent of theirs that reaches a fill is refused below
 * rather than assigned to either side.
 */
const EXIT_DECISION_TYPES: ReadonlySet<string> = new Set(["exit", "reduce"]);

/** What {@link attributeByChain} proved, by id, about every fill and order. */
interface ChainAttribution {
  readonly entry: ArtifactDecision;
  readonly entryIntent: ArtifactIntent;
  readonly entryFills: readonly ArtifactFill[];
  readonly exitFills: readonly ArtifactFill[];
  /** Every order attributed to an exit — by its trace, or by the unfilled-order rule. */
  readonly exitOrderIds: ReadonlySet<string>;
}

/** The side of the bracket an emission's DECISION puts it on. */
type EmissionSide = "ENTRY" | "EXIT" | "NEITHER";

/**
 * One intent EMISSION: an intent as one persisted decision emitted it.
 *
 * Its identity is `(runId, evaluationSeq, intentId)` — the decision's §10.3
 * primary key plus the intent's id — which is exactly the triple a trace
 * carries (`RECON-1` r2). An `intentId` alone is not an identity: §9.8 check
 * 18's duplicate guard remembers only the last 256 ids, so one id can be
 * emitted by two decisions, and the decision that emitted it decides its side.
 */
interface Emission {
  readonly key: string;
  readonly decision: ArtifactDecision;
  readonly intent: ArtifactIntent;
  readonly side: EmissionSide;
  /** False for a CANCEL: its plan withdraws orders and places none. */
  readonly placesOrders: boolean;
}

function emissionKey(runId: string, evaluationSeq: number, intentId: string): string {
  return JSON.stringify([runId, evaluationSeq, intentId]);
}

function describeIntent(intent: ArtifactIntent): string {
  return `${intent.type} ${intent.intentId ?? "(no intentId)"}`;
}

function describeEmissions(emissions: readonly Emission[]): string {
  return emissions.length === 0
    ? "none"
    : emissions
        .map(
          ({ decision, intent }) =>
            `${describeIntent(intent)} of the \`${decision.decisionType}\` decision at ` +
            `evaluationSeq ${String(decision.evaluationSeq)}`,
        )
        .join("; ");
}

/**
 * Every emission the artefact holds, indexed by identity — or a refusal.
 *
 * A duplicate identity is a MALFORMED artefact, refused outright (`RECON-1`
 * r2): two persisted decisions sharing `(runId, evaluationSeq)` — §10.3's
 * primary key — or one decision emitting the same `intentId` twice would give
 * one identity two meanings, and a copy of an existing decision would
 * otherwise count as a second possible origin for an order it never placed.
 * An intent with no `intentId` (a CANCEL, a REDUCE_POSITION) is indexed by its
 * position instead: no trace can name it, and it is still one emission.
 */
function emissionsOf(artifact: Omit<PaperRunArtifact, "reconciliation">): {
  readonly byKey: ReadonlyMap<string, Emission>;
  readonly all: readonly Emission[];
} {
  const decisionKeys = new Set<string>();
  const byKey = new Map<string, Emission>();
  const all: Emission[] = [];
  for (const decision of artifact.decisions) {
    const decisionKey = JSON.stringify([decision.runId, decision.evaluationSeq]);
    if (decisionKeys.has(decisionKey)) {
      throw new Error(
        `two persisted decisions share (runId, evaluationSeq) = (${decision.runId}, ` +
          `${String(decision.evaluationSeq)}), §10.3's primary key; every intent they emit ` +
          "would have two origins, so the artefact is malformed and nothing in it is attributed",
      );
    }
    decisionKeys.add(decisionKey);
    const side: EmissionSide =
      decision.decisionType === "enter"
        ? "ENTRY"
        : EXIT_DECISION_TYPES.has(decision.decisionType)
          ? "EXIT"
          : "NEITHER";
    for (const [index, intent] of decision.intents.entries()) {
      const key =
        intent.intentId === undefined
          ? JSON.stringify([decision.runId, decision.evaluationSeq, null, index])
          : emissionKey(decision.runId, decision.evaluationSeq, intent.intentId);
      if (byKey.has(key)) {
        throw new Error(
          `the decision at (${decision.runId}, ${String(decision.evaluationSeq)}) emits intent ` +
            `${intent.intentId ?? ""} twice; one emission identity may name one intent`,
        );
      }
      const emission: Emission = {
        key,
        decision,
        intent,
        side,
        placesOrders: intent.type !== "CANCEL",
      };
      byKey.set(key, emission);
      all.push(emission);
    }
  }
  return { byKey, all };
}

/**
 * Attributes EVERY fill and EVERY order of the run to the entry or to an exit,
 * positively and by id, or throws (`RECON-1`, closing `RISK2-R3`).
 *
 * ## The chain, on both sides, resolved by EMISSION
 *
 * `RISK-2` attributed the ENTRY by id down the artefact's own §6 invariant 4
 * chain — intent → trace → execution plan → order → fill — and then defined the
 * EXIT as everything else. The complement is exact for a run whose only fills
 * are one entry's and its exits', and wrong for anything more: a second entry's
 * purchase, or a fill no chain accounts for at all, would have been summed into
 * `exitProceeds` and reconciled as a sale. Every trace is now resolved to the
 * EMISSION it names — `(runId, evaluationSeq, intentId)`, never the id alone
 * (`RECON-1` r2) — and the decision found at that key decides the side: the
 * entry emission, an order-placing intent of an `exit` or `reduce` decision,
 * or neither. A fill that neither side reaches is REFUSED, by name; a plan
 * whose traces resolve to two different emissions is refused; nothing is
 * assigned to a side for not being the other one. The walk never reads
 * `action`, which would break on the complement leg where an entry SELLS and
 * its exit BUYS.
 *
 * ## One bracket, and why a second one is refused rather than reconciled
 *
 * Option (b) of the two `RECON-1` offered, deliberately. Every row this module
 * emits is a ONE-BRACKET quantity with no bracket dimension: the `entry.*` rows
 * compare one intent's `targetShares`, `maximumTotalCost` and `expectedNetEdge`
 * with one set of fills; `exit.expected_net_edge` is that one intent's
 * projection; the `ledger.*` rows read instance-wide balances and the `pnl.*`
 * rows read the LAST snapshot, both of which are cumulative over every bracket
 * the instance ever ran. Reconciling several brackets (option (a)) would need
 * bracket-scoped row ids, per-bracket ledger and PnL checkpoints the artefact
 * does not carry, and a rule pairing each exit with the entry it closes — and
 * the artefact holds NO id from an exit intent to its entry, so that pairing
 * would be a timing policy invented here, not a chain read from the run. That
 * is a redesign of the table, and the first two-bracket scenario is the right
 * place for it. Until then a run with more than one `enter` decision, or with
 * more than one order-placing intent in its entry decision, is refused: what
 * is not acceptable is silently reading only the first.
 *
 * ## Unfilled orders, which have NO trace
 *
 * `apps/trader/src/loop.ts` records a trace per FILL (`#harvestFills`), so an
 * order that never filled has no trace, and nothing in the artefact links it to
 * its intent by id. The golden's withdrawn take-profit is exactly such an order.
 * Such an order is attributed by a CLOSED-WORLD rule, never by complement — see
 * {@link untracedExitOrders}. An untraced order that reports filled shares is
 * refused outright: its fills should have traces.
 */
function attributeByChain(
  artifact: Omit<PaperRunArtifact, "reconciliation">,
): ChainAttribution {
  // --- one entry decision, one entry intent ---------------------------------
  const entries = artifact.decisions.filter((decision) => decision.decisionType === "enter");
  const entry = entries[0];
  if (entry === undefined) {
    throw new Error(
      "the run produced no entry decision; the reconciliation has nothing to compare and " +
        "refuses to report an empty table as a passing one",
    );
  }
  if (entries.length > 1) {
    throw new Error(
      `the run holds ${String(entries.length)} \`enter\` decisions (evaluationSeq ` +
        `${entries.map((decision) => String(decision.evaluationSeq)).join(", ")}), and this ` +
        "table has ONE bracket's shape — one set of entry.* rows, one cost cap, one expected " +
        "net edge. Reconciling the first would leave every other entry's fills to be counted " +
        "as something they are not, so the reconciliation refuses instead of reading only the " +
        "first",
    );
  }
  const entryIntent = entry.intents.find((intent) => intent.type === "POSITION");
  if (entryIntent === undefined) {
    throw new Error("the entry decision emitted no POSITION intent");
  }
  const placing = entry.intents.filter((intent) => intent.type !== "CANCEL");
  if (placing.length > 1) {
    throw new Error(
      `the entry decision (evaluationSeq ${String(entry.evaluationSeq)}) emitted ` +
        `${String(placing.length)} order-placing intents (${placing.map(describeIntent).join(", ")}); ` +
        "one bracket has one entry intent, and reconciling the first would leave the others' " +
        "fills unattributed",
    );
  }
  const entryIntentId = entryIntent.intentId;
  if (entryIntentId === undefined) {
    throw new Error(
      "the entry POSITION intent carries no intentId, so no fill can be attributed to it by id",
    );
  }

  const fills = artifact.fills;
  if (fills.length === 0) {
    throw new Error("the run produced no fill; there is nothing realized to reconcile against");
  }

  const emissions = emissionsOf(artifact);
  const entryKey = emissionKey(entry.runId, entry.evaluationSeq, entryIntentId);

  // --- plan → emission, from the traces, by the FULL key ---------------------
  const originOfPlan = new Map<string, string>();
  for (const trace of artifact.traces) {
    const key = emissionKey(trace.runId, trace.evaluationSeq, trace.intentId);
    const known = originOfPlan.get(trace.executionPlanId);
    if (known !== undefined && known !== key) {
      throw new Error(
        `execution plan ${trace.executionPlanId} is traced to two intents — emissions ${known} ` +
          `and ${key}; one plan serves one approved intent evaluation, so its orders cannot be ` +
          "attributed to a single side",
      );
    }
    originOfPlan.set(trace.executionPlanId, key);
  }
  /** What a TRACED plan's emission makes it; `undefined` for a plan no trace names. */
  const sideOfPlan = (plan: string): EmissionSide | undefined => {
    const key = originOfPlan.get(plan);
    if (key === undefined) return undefined;
    if (key === entryKey) return "ENTRY";
    const emission = emissions.byKey.get(key);
    // A trace naming no emission, or a CANCEL's, or a decision that is neither
    // the entry nor an exit: nothing this table can own.
    return emission !== undefined && emission.placesOrders && emission.side === "EXIT"
      ? "EXIT"
      : "NEITHER";
  };
  const ordersOn = (side: EmissionSide): Set<string> =>
    new Set(
      artifact.orders
        .filter((order) => sideOfPlan(order.executionPlanId) === side)
        .map((order) => order.simulatedOrderId),
    );
  const entryOrderIds = ordersOn("ENTRY");
  const exitOrderIds = ordersOn("EXIT");
  const onBothSides = [...entryOrderIds].filter((orderId) => exitOrderIds.has(orderId));
  if (onBothSides.length > 0) {
    throw new Error(
      `order ${onBothSides.join(", ")} is reached from the entry's chain AND from an exit's; ` +
        "an order id names one order, placed under one plan",
    );
  }

  // --- every fill: the entry's, an exit's, or refused -----------------------
  const entryFills = fills.filter((fill) => entryOrderIds.has(fill.simulatedOrderId));
  const exitFills = fills.filter((fill) => exitOrderIds.has(fill.simulatedOrderId));
  const unattributed = fills.filter(
    (fill) =>
      !entryOrderIds.has(fill.simulatedOrderId) && !exitOrderIds.has(fill.simulatedOrderId),
  );
  if (unattributed.length > 0) {
    throw new Error(
      `fill ${unattributed.map((fill) => fill.simulatedFillId).join(", ")} (order ` +
        `${unattributed.map((fill) => fill.simulatedOrderId).join(", ")}) belongs to neither ` +
        "the entry's chain nor any exit's: no trace resolves its order's plan to the entry " +
        "emission or to an order-placing emission of an exit or reduce decision. Counting it " +
        "as exit proceeds because it is not the entry's is the error this refusal exists to " +
        "prevent",
    );
  }
  if (entryFills.length === 0) {
    throw new Error(
      "no fill could be attributed to the entry intent through the trace chain; the entry rows " +
        "would compare against an empty set and are refused rather than reported as reconciled",
    );
  }

  // --- every order: the entry's, an exit's, or refused ----------------------
  const tracedElsewhere = artifact.orders.filter(
    (order) => sideOfPlan(order.executionPlanId) === "NEITHER",
  );
  if (tracedElsewhere.length > 0) {
    throw new Error(
      tracedElsewhere
        .map(
          (order) =>
            `order ${order.simulatedOrderId} was placed under plan ${order.executionPlanId}, ` +
            `which traces to emission ${originOfPlan.get(order.executionPlanId) ?? ""} — neither ` +
            "the entry intent nor one an exit or reduce decision emitted",
        )
        .join("; "),
    );
  }
  const untraced = artifact.orders.filter(
    (order) => sideOfPlan(order.executionPlanId) === undefined,
  );
  const deduced = untracedExitOrders(
    artifact,
    untraced,
    emissions.all,
    new Set(originOfPlan.values()),
  );

  return {
    entry,
    entryIntent,
    entryFills,
    exitFills,
    exitOrderIds: new Set([...exitOrderIds, ...deduced]),
  };
}

/**
 * Whether an emission could have placed `order`, by what the artefact can
 * ESTABLISH (`RECON-1` r2).
 *
 * An intent places orders only in its own market (§7.7 `marketId`), and on
 * either outcome token of that market: `execution-planner` may express an
 * exposure increase as BUY-direction or SELL-opposite (`leg.ts`
 * `selectIncreaseLeg`), and a reduction acts on both sides (`build.ts`), so the
 * token alone does not reveal the intent's `direction` — which the artefact
 * does not carry anyway. The artefact names outcome tokens for the SCENARIO
 * market only, so an order in any other market, on a token that is not one of
 * the scenario's two, or labelled with the other token's side, has no origin
 * this document can establish. A BASKET carries no top-level `marketId` here,
 * and so establishes none either.
 */
function couldHavePlaced(
  emission: Emission,
  order: ArtifactOrder,
  scenario: PaperRunArtifact["scenario"],
): boolean {
  if (emission.intent.marketId === undefined) return false;
  if (emission.intent.marketId !== order.marketId || order.marketId !== scenario.marketId) {
    return false;
  }
  return (
    (order.tokenId === scenario.yesTokenId && order.side === "YES") ||
    (order.tokenId === scenario.noTokenId && order.side === "NO")
  );
}

/**
 * The size of a maximum one-to-one assignment of plans to DISTINCT compatible
 * emissions (augmenting paths; the sets are tiny).
 */
function assignableCount(compatible: ReadonlyMap<string, readonly Emission[]>): number {
  const holderOf = new Map<string, string>();
  const place = (plan: string, visited: Set<string>): boolean => {
    for (const emission of compatible.get(plan) ?? []) {
      if (visited.has(emission.key)) continue;
      visited.add(emission.key);
      const holder = holderOf.get(emission.key);
      if (holder === undefined || place(holder, visited)) {
        holderOf.set(emission.key, plan);
        return true;
      }
    }
    return false;
  };
  let assigned = 0;
  for (const plan of compatible.keys()) {
    if (place(plan, new Set<string>())) assigned += 1;
  }
  return assigned;
}

/**
 * The closed-world rule for orders with NO trace. Returns the ids it proves are
 * exits, and throws for any it cannot.
 *
 * The loop mints ONE execution plan per approved intent evaluation (§8.1 step
 * 8, in `#routeIntent`), and a filled plan is named by its traces, so an
 * untraced plan can only have come from an order-placing emission that no
 * trace names. Among THOSE, only the ones that {@link couldHavePlaced} every
 * order under the plan are its possible origins. The plan's orders are EXIT
 * orders when:
 *
 * 1. it has at least one possible origin (otherwise nothing in the document
 *    could have placed it);
 * 2. EVERY possible origin is an emission of an `exit` or `reduce` decision
 *    (otherwise its side is ambiguous, and it is refused rather than guessed);
 * 3. the untraced plans can be given DISTINCT possible origins, all at once —
 *    one plan per evaluation — which is Hall's condition, checked by
 *    {@link assignableCount}. `RECON-1` r2: counting the candidates globally
 *    let a copied decision, or a candidate in another market, stand in for an
 *    origin no plan actually had.
 *
 * WHICH exit emission placed which plan is not needed by any row — the
 * `exit.cancelled_proceeds.*` row reads the order alone — so an assignment
 * that is not unique does not change the attribution: under (2) every
 * assignment puts every plan on the exit side.
 */
function untracedExitOrders(
  artifact: Omit<PaperRunArtifact, "reconciliation">,
  untraced: readonly ArtifactOrder[],
  emissions: readonly Emission[],
  tracedKeys: ReadonlySet<string>,
): readonly string[] {
  if (untraced.length === 0) return [];

  const filled = untraced.filter((order) => compareDecimal(order.filledShares, "0") !== 0);
  if (filled.length > 0) {
    throw new Error(
      filled
        .map(
          (order) =>
            `order ${order.simulatedOrderId} reports ${order.filledShares} filled shares, but no ` +
            `trace names its plan ${order.executionPlanId}; the loop traces every fill, so this ` +
            "order's fills cannot be attributed by id",
        )
        .join("; "),
    );
  }

  const candidates = emissions.filter(
    (emission) => emission.placesOrders && !tracedKeys.has(emission.key),
  );
  const plans = new Map<string, ArtifactOrder[]>();
  for (const order of untraced) {
    const orders = plans.get(order.executionPlanId) ?? [];
    orders.push(order);
    plans.set(order.executionPlanId, orders);
  }

  const compatible = new Map<string, readonly Emission[]>();
  for (const [plan, orders] of plans) {
    const named = orders.map((order) => order.simulatedOrderId).join(", ");
    const origins = candidates.filter((candidate) =>
      orders.every((order) => couldHavePlaced(candidate, order, artifact.scenario)),
    );
    if (origins.length === 0) {
      throw new Error(
        `order ${named} (plan ${plan}) has no trace, and no order-placing emission without a ` +
          `trace could have placed it — the untraced emissions are ${describeEmissions(candidates)}, ` +
          "and an emission places orders only in its own market, on an outcome token this " +
          "document names for it. The order has no possible origin in this document, so it is " +
          "not attributed to either side",
      );
    }
    const notExits = origins.filter((origin) => origin.side !== "EXIT");
    if (notExits.length > 0) {
      throw new Error(
        `order ${named} has no trace, and the untraced intent emissions that could have placed ` +
          `it include ${describeEmissions(notExits)} — not an exit. An unfilled order's side ` +
          "cannot be read from this document by id, so the reconciliation refuses rather than " +
          "report it as an exit cancellation",
      );
    }
    compatible.set(plan, origins);
  }

  if (assignableCount(compatible) < plans.size) {
    throw new Error(
      `${String(plans.size)} execution plans have no trace (${[...plans.keys()].join(", ")}; ` +
        `orders ${untraced.map((order) => order.simulatedOrderId).join(", ")}), but they cannot ` +
        "each be given a DISTINCT order-placing emission that could have placed them — the " +
        `untraced emissions are ${describeEmissions(candidates)}. The loop mints ONE plan per ` +
        "approved intent evaluation, so at least one of these orders has no possible origin in " +
        "this document and none of them can be attributed",
    );
  }
  return untraced.map((order) => order.simulatedOrderId);
}

// --- FIFO order: the sequence the run consumed the fills in ------------------

const CANONICAL_UNSIGNED_INTEGER = /^(?:0|[1-9][0-9]*)$/u;
const DIGIT_RUN = /^[0-9]/u;
const RUNS = /[0-9]+|[^0-9]+/gu;

function compareCodeUnits(left: string, right: string): -1 | 0 | 1 {
  return left === right ? 0 : left < right ? -1 : 1;
}

/**
 * Refuses an `atEventIngestSeq` that is not a canonical unsigned integer string.
 *
 * Called for EVERY fill before the fold sorts (`RECON-1` r2): inside the sort
 * comparator alone it never ran for a single fill, which a one-element array
 * never compares, so a lone `"05"` was folded without a word.
 */
function assertCanonicalIngestSeq(value: string): void {
  if (!CANONICAL_UNSIGNED_INTEGER.test(value)) {
    throw new Error(
      `atEventIngestSeq ${JSON.stringify(value)} is not a canonical unsigned integer string, ` +
        "so the order in which the run consumed its fills cannot be established",
    );
  }
}

/**
 * Two canonical unsigned integer strings (§7.1's `ingestSeq`), compared EXACTLY.
 *
 * Length first, then code units — the repository's own rule
 * (`packages/storage-wal`'s `compareIngestSeq`). A lexical comparison would put
 * `"10"` before `"9"`, and `Number` loses exactness past 2^53. Length-first is
 * only correct for CANONICAL strings (`"05"` is longer than `"6"`), so a
 * non-canonical value is refused rather than ordered.
 */
export function compareIngestSeq(left: string, right: string): -1 | 0 | 1 {
  assertCanonicalIngestSeq(left);
  assertCanonicalIngestSeq(right);
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return compareCodeUnits(left, right);
}

/**
 * Two fill ids, with every embedded run of digits compared as an integer.
 *
 * The tiebreak inside one `atEventIngestSeq`, so the fold's order is TOTAL and
 * independent of the array. `packages/simulation` numbers the fills of one
 * crossing `${orderId}/t0/${index}` in the order it walked the book, so a plain
 * code-unit comparison would put `…/t0/10` before `…/t0/9` — the error
 * `compareIngestSeq` exists to avoid, one field later. Digit runs compare by
 * value (leading zeros stripped, then length, then code units), everything else
 * by code units, and a full tie falls back to the raw strings, so the order is
 * total and never consults a locale or a float.
 *
 * Under average cost (`RECON-1` r1) the tiebreak rarely moves the result:
 * consecutive fills on the same side commute up to the last rounded digit of a
 * partial removal, and a purchase and a sale that share one event are ordered
 * by their ORDER ids — a convention, not the venue's booking order, which the
 * artefact does not state beyond the array itself.
 */
export function compareFillIds(left: string, right: string): -1 | 0 | 1 {
  const leftRuns = left.match(RUNS) ?? [];
  const rightRuns = right.match(RUNS) ?? [];
  const shared = Math.min(leftRuns.length, rightRuns.length);
  for (let index = 0; index < shared; index += 1) {
    const a = leftRuns[index] ?? "";
    const b = rightRuns[index] ?? "";
    let order: -1 | 0 | 1;
    if (DIGIT_RUN.test(a) && DIGIT_RUN.test(b)) {
      const x = a.replace(/^0+(?=[0-9])/u, "");
      const y = b.replace(/^0+(?=[0-9])/u, "");
      order = x.length !== y.length ? (x.length < y.length ? -1 : 1) : compareCodeUnits(x, y);
    } else {
      order = compareCodeUnits(a, b);
    }
    if (order !== 0) return order;
  }
  if (leftRuns.length !== rightRuns.length) return leftRuns.length < rightRuns.length ? -1 : 1;
  return compareCodeUnits(left, right);
}

/** The order the run consumed two fills in: `atEventIngestSeq`, then the fill id. */
function inConsumptionOrder(left: ArtifactFill, right: ArtifactFill): number {
  const bySequence = compareIngestSeq(left.atEventIngestSeq, right.atEventIngestSeq);
  return bySequence !== 0 ? bySequence : compareFillIds(left.simulatedFillId, right.simulatedFillId);
}

// --- the open cost basis, by the engine's own cost method --------------------

/**
 * `packages/pnl`'s division policy for a PARTIAL removal, restated rather than
 * inherited: 34 significant digits, ROUND_HALF_EVEN (`decimal.js` rounding mode
 * 6). `packages/pnl/src/state.ts` calls `divDecimal` with NO options and so
 * relies on the decimal package's documented defaults; writing the numbers
 * down here means a change to those defaults would move the engine and NOT this
 * oracle, and `reconciliation-attribution.test.ts` pins that the two still
 * agree.
 */
export const PNL_COST_DIVISION: DivisionOptions = Object.freeze({
  precision: 34,
  rounding: 6,
});

/**
 * The open cost basis `packages/pnl` holds after these fills, computed here from
 * its SPECIFICATION and not by calling it (`RECON-1` r1).
 *
 * The specification (`packages/pnl/src/state.ts`, header and `applyTrade`):
 * "Cost method: average cost per token asset. Removing q shares from a lot of Q
 * shares with basis B removes basis B·q/Q — computed exactly when q = Q,
 * otherwise via `divDecimal`'s documented policy (34 significant digits,
 * ROUND_HALF_EVEN), with the REMAINING basis derived by exact subtraction so
 * total basis is conserved to the penny across any split." A purchase adds its
 * shares and `price × shares` to the lot; a lot sold down to zero is removed;
 * a sale larger than the lot is refused (`PNL_OVERSELL`).
 *
 * WHY NOT CALL IT. This module is the oracle the engine is checked against; an
 * oracle that ran the engine's fold would agree with it by construction. The
 * decimal primitives are the arithmetic, not the system under test, so they
 * are used; `PNL_COST_DIVISION` states the rounding policy explicitly.
 *
 * WHY IN SEQUENCE ORDER (`RISK2-R4`). Average cost is indifferent to the order
 * of consecutive purchases but NOT to how purchases and sales interleave — a
 * sale removes a share of the basis the lot holds AT THAT POINT — so the entry
 * and exit fills are folded together, in {@link inConsumptionOrder}, never in
 * the order the capture wrote them.
 *
 * THE SIGN CONVENTION IS THE TABLE'S, NOT `action`. The entry's fills add to
 * the lot and the exit's fills remove from it, attributed by id exactly as
 * every other row is. For this strategy's direct leg that is where the
 * engine's BUY/SELL lands; it is also the convention the `ledger.*` and `exit.*`
 * rows already use (the entry pays out, the exit takes in).
 */
function openCostBasisOf(
  entryFills: readonly ArtifactFill[],
  exitFills: readonly ArtifactFill[],
): string {
  const unsorted = [
    ...entryFills.map((fill) => ({ fill, opens: true })),
    ...exitFills.map((fill) => ({ fill, opens: false })),
  ];
  for (const { fill } of unsorted) assertCanonicalIngestSeq(fill.atEventIngestSeq);
  const sequence = unsorted.sort((left, right) => inConsumptionOrder(left.fill, right.fill));

  const lots = new Map<string, { readonly shares: string; readonly costBasis: string }>();
  for (const { fill, opens } of sequence) {
    const lot = lots.get(fill.tokenId);
    if (opens) {
      lots.set(fill.tokenId, {
        shares: addDecimal(lot?.shares ?? "0", fill.shares),
        costBasis: addDecimal(lot?.costBasis ?? "0", mulDecimal(fill.price, fill.shares)),
      });
      continue;
    }
    if (lot === undefined || compareDecimal(fill.shares, lot.shares) > 0) {
      throw new Error(
        `exit fill ${fill.simulatedFillId} removes ${fill.shares} shares of token ` +
          `${fill.tokenId} when, at that point in the sequence, the position holds ` +
          `${lot?.shares ?? "0"}; packages/pnl refuses an oversell (PNL_OVERSELL), so there is ` +
          "no engine cost basis to reconcile against",
      );
    }
    if (compareDecimal(fill.shares, lot.shares) === 0) {
      // q = Q: the whole basis leaves, exactly, and the lot closes.
      lots.delete(fill.tokenId);
      continue;
    }
    const removed = divDecimal(
      mulDecimal(lot.costBasis, fill.shares),
      lot.shares,
      PNL_COST_DIVISION,
    );
    lots.set(fill.tokenId, {
      shares: subDecimal(lot.shares, fill.shares),
      costBasis: subDecimal(lot.costBasis, removed),
    });
  }
  return sum([...lots.values()].map((lot) => lot.costBasis));
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

  /**
   * THE ENTRY'S OWN FILLS, SEPARATED FROM EVERY OTHER FILL (`RISK-2`), AND THE
   * EXIT'S, WALKED THE SAME WAY (`RECON-1`).
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
   * `RISK-2` walked it for the entry only and took the exit as the complement;
   * {@link attributeByChain} walks both and refuses what neither reaches.
   */
  const { entry, entryIntent, entryFills, exitFills, exitOrderIds } = attributeByChain(artifact);
  const fills = artifact.fills;

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
   * The cost basis the position still holds, by `packages/pnl`'s OWN cost
   * method — average cost — restated in {@link openCostBasisOf} (`RECON-1` r1).
   *
   * THIS USED TO BE A FIFO FOLD, and that was the wrong oracle. `RISK-2` wrote
   * it FIFO to avoid a division (§6 invariant 1), describing it as
   * "`packages/pnl`'s open cost basis … folded FIFO" — but `packages/pnl` is
   * average cost (`state.ts`: "Cost method: average cost per token asset") and
   * the persisted snapshot these rows compare against comes from it; FIFO is
   * `apps/trader`'s allocator book (`allocation.ts`), a different number. The
   * division concern is answered by the engine's own specification, which
   * states an exact-decimal policy for it. The two methods agree in the only
   * two states the committed golden holds — fully open (the whole notional) and
   * fully closed (`"0"`) — so the golden is unchanged; on a PARTIAL exit at
   * mixed lot prices FIFO flagged a correct run as unexplained.
   *
   * RESIDUAL, FROZEN IN THE GOLDEN: the `projectedSource` text of
   * `pnl.capital_committed` and `pnl.worst_case_resolution` below still says
   * "FIFO". It is golden bytes, and this round may not change the golden; the
   * NUMBERS are identical for every state the golden contains. Correcting the
   * text is a golden regeneration, recorded as a `RECON-1` follow-up.
   */
  const openCostBasis = openCostBasisOf(entryFills, exitFills);

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

  // `RECON-1`: the orders attributed to an EXIT — by trace, or by the
  // closed-world rule for unfilled orders — and no longer every order that is
  // not the entry's. An entry order withdrawn unfilled is not a take-profit.
  const cancelledExits = artifact.orders.filter(
    (order) =>
      exitOrderIds.has(order.simulatedOrderId) &&
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
