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
 *
 * ## Brackets (`BRACKET-1b`)
 *
 * A run may hold SEVERAL brackets of the scenario instance: the Static Bracket
 * strategy re-arms after a close (`SB.REARMED`) and may enter again up to its
 * `maximum_entries_per_market`. The table is then built PER BRACKET, with the
 * brackets read from the run rather than invented: the instance's decisions
 * are split at the strategy's OWN `SB.REARMED` decisions, each boundary must
 * follow a close (`SB.CLOSED`) and must be placed in the order the run
 * consumed its fills, and this module's own average-cost fold must find the
 * instance FLAT at it — otherwise the run is refused, not reconciled. See
 * {@link attributeByProvenance}.
 *
 * A run with ONE bracket (no `SB.REARMED`) is reconciled exactly as before:
 * the same rows, ids, texts and order, so a single-bracket golden's
 * `reconciliation` section does not move. With several, every row computed
 * from one bracket's decisions and fills carries a `bracket.<n>.` prefix, the
 * `ledger.*` and `pnl.*` rows stay run-cumulative under their own ids, and two
 * row kinds are added: `bracket.<n>.pnl.realized` (the bracket's realized PnL
 * from its own fills, against its §9.16 trade records) and the cumulative
 * `pnl.realized` (the per-bracket sum against the last snapshot).
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
  ArtifactOrderProvenance,
  ArtifactPnlRecord,
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
      "exit.take_profit.price. A bracket closed by a PROTECTIVE REDUCTION does not: the stop, " +
      "the holding timeout or exit_cutoff_before_close_seconds (§13.3's final_policy " +
      "PROTECTED_REDUCE) closed it by crossing the book under exit.stop.minimum_sell_price " +
      "instead. The contribution is (realized exit proceeds − take_profit price × shares " +
      "exited), exact in decimal: NEGATIVE whenever an exit sold below the take-profit target, " +
      "and ZERO for a bracket its take-profit closed at that price (`BRACKET-1b`).",
    noRealizedValue: false,
  },
  POSITION_OPEN_AT_RUN_END: {
    detail:
      "the entry intent's expectedNetEdge projects the WHOLE position leaving at " +
      "exit.take_profit.price, net of the configured exit_fee_per_share. Shares the run still " +
      "held when it ended have not left: the projected net proceeds for them, " +
      "(take_profit price − exit_fee_per_share) × open shares, have not happened, and this " +
      "contribution states that, NEGATIVE, rather than leaving it as a residual. It appears " +
      "only when the open shares are not zero, so a fully closed round trip never carries it " +
      "(`RECON-2`, the orchestrator's `RECON1-EDGE` ruling).",
    noRealizedValue: false,
  },
  RESTING_EXIT_CANCELLED_UNFILLED: {
    detail:
      "no realized value exists. An EXIT order — a take-profit an `exit` decision placed, or a " +
      "protective reduction a `reduce` decision placed, named on the row from the order's own " +
      "provenance record — rested and was WITHDRAWN unfilled: a take-profit withdrawn under §6 " +
      "invariant 13's cancel-before-replace because the confirmed allocation grew after it had " +
      "been sized, or withdrawn because a protective reduction outranks it (safety " +
      "cancellation before new placement, the same invariant). A cancelled order " +
      "produces no fill, so the proceeds it projected have no realized counterpart and this row " +
      "states an ABSENCE rather than a zero. The cancel is counted on the health surface " +
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
 * are not exits, and an order one of their intents placed is refused below
 * rather than assigned to either side.
 */
const EXIT_DECISION_TYPES: ReadonlySet<string> = new Set(["exit", "reduce"]);

/** What an exit decision's order IS, for the rows that name it. */
function exitKindOf(decisionType: string): string {
  return decisionType === "exit"
    ? "take-profit"
    : decisionType === "reduce"
      ? "protective reduction"
      : `\`${decisionType}\` order`;
}

// --- brackets: delimited by the strategy's OWN `SB.REARMED` (`BRACKET-1b`) --

/**
 * The two Static Bracket reason codes this module reads from the PERSISTED
 * decisions. They are literals, not imports: the oracle's imports are fixed to
 * the decimal arithmetic and the artefact's types (the independence pin in
 * `reconciliation-attribution.test.ts`), and these are values the run itself
 * wrote, read back from the document like every other value here.
 *
 * `SB.REARMED` is emitted by `planRearm` alone, on the `CLOSED --REARM-->
 * ARMED` edge; `SB.CLOSED` on every edge INTO `CLOSED` that follows a filled
 * bracket (`EXIT_FILL_COMPLETE`, `POSITION_FLAT`).
 */
const REARMED_CODE = "SB.REARMED";
const CLOSED_CODE = "SB.CLOSED";

/** One bracket: the scenario instance's decisions from one `SB.REARMED` to the next. */
interface Bracket {
  /** 1-based, in evaluation order. */
  readonly ordinal: number;
  /** The `SB.REARMED` decision that opened it; `null` for the first bracket. */
  readonly opener: ArtifactDecision | null;
  /** Its decisions in `evaluationSeq` order, the opener first when there is one. */
  readonly decisions: readonly ArtifactDecision[];
}

/** What {@link attributeByProvenance} proved, by id, about one bracket's fills and orders. */
interface Attribution {
  readonly bracket: Bracket;
  readonly entry: ArtifactDecision;
  readonly entryIntent: ArtifactIntent;
  readonly entryFills: readonly ArtifactFill[];
  readonly exitFills: readonly ArtifactFill[];
  /** Every order attributed to an EXIT of this bracket, with the emission whose decision placed it. */
  readonly exitOrigins: ReadonlyMap<string, Emission>;
}

/** A persisted decision's §10.3 primary key, as a map key. */
function decisionKeyOf(decision: ArtifactDecision): string {
  return JSON.stringify([decision.runId, decision.evaluationSeq]);
}

/**
 * The scenario instance's decisions, split at the strategy's own `SB.REARMED`.
 *
 * SCOPED BY `instanceId` (`RECON-1`'s note: "decision counting is not scoped to
 * one instance"): a SHADOW observer over the same market persists decisions of
 * its own — `enter` ones included — and they are not this instance's brackets.
 * Ordered by `evaluationSeq`, the order the instance EVALUATED them in, not the
 * order a document happens to list them in (a stable sort, so the persisted
 * order breaks a tie, which §10.3's key forbids anyway).
 *
 * Every `SB.REARMED` decision OPENS a bracket; the decisions before the first
 * one are bracket 1. A document whose first decision is an `SB.REARMED` has an
 * EMPTY bracket 1, which {@link attributeByProvenance} refuses (a re-arm with
 * no preceding close).
 */
function bracketsOf(artifact: Omit<PaperRunArtifact, "reconciliation">): readonly Bracket[] {
  const own = artifact.decisions
    .map((decision, index) => ({ decision, index }))
    .filter(({ decision }) => decision.instanceId === artifact.scenario.instanceId)
    .sort(
      (left, right) =>
        left.decision.evaluationSeq - right.decision.evaluationSeq || left.index - right.index,
    )
    .map(({ decision }) => decision);
  const split: { readonly opener: ArtifactDecision | null; readonly decisions: ArtifactDecision[] }[] =
    [{ opener: null, decisions: [] }];
  for (const decision of own) {
    if (decision.reasonCodes.includes(REARMED_CODE)) {
      split.push({ opener: decision, decisions: [decision] });
      continue;
    }
    split[split.length - 1]?.decisions.push(decision);
  }
  return split.map((bracket, index) =>
    Object.freeze({
      ordinal: index + 1,
      opener: bracket.opener,
      decisions: Object.freeze([...bracket.decisions]),
    }),
  );
}

function describeBracket(bracket: Bracket): string {
  return bracket.opener === null
    ? `bracket ${String(bracket.ordinal)}`
    : `bracket ${String(bracket.ordinal)} (opened by the \`${REARMED_CODE}\` decision at ` +
        `evaluationSeq ${String(bracket.opener.evaluationSeq)})`;
}

function seqList(decisions: readonly ArtifactDecision[]): string {
  return decisions.map((decision) => String(decision.evaluationSeq)).join(", ");
}

/**
 * One bracket's entry: exactly one `enter` decision, exactly one POSITION
 * intent, at most one order-placing intent, and an intent id — the refusals
 * `RISK2-R3` introduced for the whole run, now applied PER BRACKET.
 *
 * `single` keeps the one-bracket messages exactly as they were, except the
 * second-`enter` refusal, whose rule changed: two entries are refused when no
 * `SB.REARMED` separates them, and are two brackets when one does.
 */
function entryOf(
  bracket: Bracket,
  single: boolean,
): { readonly entry: ArtifactDecision; readonly entryIntent: ArtifactIntent; readonly key: string } {
  const where = single ? "" : `${describeBracket(bracket)}: `;
  const entries = bracket.decisions.filter((decision) => decision.decisionType === "enter");
  const entry = entries[0];
  if (entry === undefined) {
    throw new Error(
      single
        ? "the run produced no entry decision; the reconciliation has nothing to compare and " +
            "refuses to report an empty table as a passing one"
        : `${where}the bracket holds no \`enter\` decision, so it has no entry to compare and ` +
            "the reconciliation refuses rather than report an empty bracket as a passing one",
    );
  }
  if (entries.length > 1) {
    throw new Error(
      `${single ? "the run's only bracket (the run holds no `" + REARMED_CODE + "`)" : describeBracket(bracket)} ` +
        `holds ${String(entries.length)} \`enter\` decisions (evaluationSeq ${seqList(entries)}) ` +
        `with no \`${REARMED_CODE}\` between them. A bracket opens only through the strategy's ` +
        `own ${REARMED_CODE}, after a close, so ONE bracket has ONE entry — one set of entry.* ` +
        "rows, one cost cap, one expected net edge. Reconciling the first would leave every " +
        "other entry's fills to be counted as something they are not, so the reconciliation " +
        "refuses instead of reading only the first",
    );
  }
  const entryIntent = entry.intents.find((intent) => intent.type === "POSITION");
  if (entryIntent === undefined) {
    throw new Error(`${where}the entry decision emitted no POSITION intent`);
  }
  const placing = entry.intents.filter((intent) => intent.type !== "CANCEL");
  if (placing.length > 1) {
    throw new Error(
      `${where}the entry decision (evaluationSeq ${String(entry.evaluationSeq)}) emitted ` +
        `${String(placing.length)} order-placing intents (${placing.map(describeIntent).join(", ")}); ` +
        "one bracket has one entry intent, and reconciling the first would leave the others' " +
        "fills unattributed",
    );
  }
  const entryIntentId = entryIntent.intentId;
  if (entryIntentId === undefined) {
    throw new Error(
      `${where}the entry POSITION intent carries no intentId, so no fill can be attributed to ` +
        "it by id",
    );
  }
  return { entry, entryIntent, key: emissionKey(entry.runId, entry.evaluationSeq, entryIntentId) };
}

/**
 * Every boundary FOLLOWS A CLOSE: the bracket an `SB.REARMED` ends holds a
 * decision carrying `SB.CLOSED` after that bracket's entry.
 *
 * The strategy reaches `planRearm` only from `CLOSED` (`decide.ts` `planTick`),
 * and a filled bracket enters `CLOSED` only through an edge that reports
 * `SB.CLOSED`. So a re-arm with no preceding close — the first decision of the
 * run, or after an entry that never closed — is not a boundary this strategy
 * produces, and nothing delimited by it is reconciled.
 */
function refuseUnclosedBoundaries(brackets: readonly Bracket[]): void {
  for (const bracket of brackets) {
    const opener = bracket.opener;
    if (opener === null) continue;
    const previous = brackets[bracket.ordinal - 2];
    const entry = previous?.decisions.find((decision) => decision.decisionType === "enter");
    const closed = previous?.decisions.some(
      (decision) =>
        decision.reasonCodes.includes(CLOSED_CODE) &&
        (entry === undefined || decision.evaluationSeq > entry.evaluationSeq),
    );
    if (closed !== true) {
      throw new Error(
        `the strategy's \`${REARMED_CODE}\` at evaluationSeq ${String(opener.evaluationSeq)} ` +
          `opens bracket ${String(bracket.ordinal)}, but no decision carrying \`${CLOSED_CODE}\` ` +
          `precedes it in bracket ${String(bracket.ordinal - 1)}` +
          (previous === undefined || previous.decisions.length === 0
            ? " (which holds no decision at all)"
            : ` (evaluationSeq ${seqList(previous.decisions)})`) +
          ". The strategy re-arms only from CLOSED, so this is not a boundary it produced, and " +
          "the brackets it would delimit are not reconciled",
      );
    }
  }
}

/**
 * Every boundary is placed in the order the run CONSUMED its fills, and the
 * instance is FLAT there by this module's own fold (`BRACKET-1b`).
 *
 * The boundary's instant is the `SB.REARMED` decision's recorded source event:
 * its `ingestSeq` is the point in the fill sequence (`atEventIngestSeq`) the
 * re-arm was decided at. A re-arm with no recorded source event cannot be
 * placed there and is refused (the strategy re-arms from a tick — `onFeatures`
 * or `onMarketClosing` — and the trader dispatches no timer, so one never has
 * none in a run this harness drives).
 *
 * Refused, each by name:
 * - a fill of an EARLIER bracket consumed at or after the boundary, or a fill
 *   of this or a later bracket consumed before it: attribution (by id) and time
 *   would disagree about which bracket the position at the boundary belongs to;
 * - an instance that is NOT FLAT at the boundary: the average-cost fold
 *   ({@link foldMovements}, `packages/pnl`'s method restated) of every fill
 *   consumed before it leaves shares in some token. The strategy re-arms only
 *   from a closed, flat bracket, so a boundary over an open position is not the
 *   run's.
 */
function refuseMisplacedBoundaries(
  artifact: Omit<PaperRunArtifact, "reconciliation">,
  attributions: readonly Attribution[],
): void {
  const ingestSeqOf = new Map(artifact.events.map((event) => [event.eventId, event.ingestSeq]));
  for (const later of attributions) {
    const opener = later.bracket.opener;
    if (opener === null) continue;
    const boundary = opener.sourceEventId === null ? undefined : ingestSeqOf.get(opener.sourceEventId);
    const where =
      `the boundary the \`${REARMED_CODE}\` at evaluationSeq ${String(opener.evaluationSeq)} ` +
      `marks (opening bracket ${String(later.bracket.ordinal)})`;
    if (boundary === undefined) {
      throw new Error(
        `${where} names ${opener.sourceEventId === null ? "no source event" : `source event ${opener.sourceEventId}, which is not in the recorded event list`}; ` +
          "it cannot be placed in the order the run consumed its fills, so the position there " +
          "cannot be verified and the brackets are not reconciled",
      );
    }
    for (const attribution of attributions) {
      const earlier = attribution.bracket.ordinal < later.bracket.ordinal;
      for (const fill of [...attribution.entryFills, ...attribution.exitFills]) {
        const order = compareIngestSeq(fill.atEventIngestSeq, boundary);
        if (earlier ? order >= 0 : order < 0) {
          throw new Error(
            `fill ${fill.simulatedFillId} is bracket ${String(attribution.bracket.ordinal)}'s by ` +
              `its provenance, but it was consumed at ingestSeq ${fill.atEventIngestSeq}, ` +
              `${earlier ? "at or after" : "before"} ${where} at ingestSeq ${boundary}. Attribution ` +
              "and time disagree about which bracket the position at the boundary belongs to, so " +
              "the brackets are not reconciled",
          );
        }
      }
    }
    const before = attributions.filter(
      (attribution) => attribution.bracket.ordinal < later.bracket.ordinal,
    );
    const fold = foldFills(
      before.flatMap((attribution) => attribution.entryFills),
      before.flatMap((attribution) => attribution.exitFills),
    );
    const open = [...fold.lots.entries()].filter(([, lot]) => compareDecimal(lot.shares, "0") !== 0);
    if (open.length > 0) {
      throw new Error(
        `the instance is not flat at ${where}: this module's average-cost fold of every fill ` +
          `consumed before it still holds ${open.map(([token, lot]) => `${lot.shares} shares of token ${token}`).join(", ")}. ` +
          "The strategy re-arms only from a CLOSED, flat bracket, so a boundary over an open " +
          "position is not the run's, and the brackets are not reconciled",
      );
    }
  }
}

/** The side of the bracket an emission's DECISION puts it on. */
type EmissionSide = "ENTRY" | "EXIT" | "NEITHER";

/**
 * One intent EMISSION: an intent as one persisted decision emitted it.
 *
 * Its identity is `(runId, evaluationSeq, intentId)` — the decision's §10.3
 * primary key plus the intent's id — which is exactly the triple a trace and a
 * provenance record carry (`RECON-1` r2). An `intentId` alone is not an
 * identity: §9.8 check 18's duplicate guard remembers only the last 256 ids, so
 * one id can be emitted by two decisions, and the decision that emitted it
 * decides its side.
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

function describeEmission({ decision, intent }: Emission): string {
  return (
    `${describeIntent(intent)} of the \`${decision.decisionType}\` decision at ` +
    `evaluationSeq ${String(decision.evaluationSeq)}`
  );
}

/**
 * Every emission the artefact holds, indexed by identity — or a refusal.
 *
 * A duplicate identity is a MALFORMED artefact, refused outright (`RECON-1`
 * r2): two persisted decisions sharing `(runId, evaluationSeq)` — §10.3's
 * primary key — or one decision emitting the same `intentId` twice would give
 * one identity two meanings, and a copy of an existing decision would
 * otherwise count as a second origin for an order it never placed. An intent
 * with no `intentId` (a CANCEL, a REDUCE_POSITION) is indexed by its position
 * instead: no trace or provenance record can name it, and it is still one
 * emission.
 */
function emissionsOf(artifact: Omit<PaperRunArtifact, "reconciliation">): {
  readonly byKey: ReadonlyMap<string, Emission>;
} {
  const decisionKeys = new Set<string>();
  const byKey = new Map<string, Emission>();
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
      byKey.set(key, { key, decision, intent, side, placesOrders: intent.type !== "CANCEL" });
    }
  }
  return { byKey };
}

/**
 * The nine fields a provenance record and every trace of the same order share.
 * The loop builds the record at SUBMISSION and completes it into a trace, field
 * for field, when a fill arrives (`apps/trader/src/loop.ts` `#harvestFills`).
 */
const PROVENANCE_FIELDS = [
  "sourceEventId",
  "featureSnapshotRef",
  "runId",
  "evaluationSeq",
  "intentId",
  "approvedIntentId",
  "executionPlanId",
  "submissionAttemptId",
  "venueOrderId",
] as const satisfies readonly (keyof ArtifactOrderProvenance)[];

/**
 * Attributes EVERY order and EVERY fill of the run to the entry or to an exit,
 * positively and BY ID, or throws (`RECON-1`, closing `RISK2-R3`; `RECON-2`,
 * closing `RECON1-ORIGIN`).
 *
 * ## Every order, by its provenance record
 *
 * The loop records each order's §6 invariant 4 trace PREFIX when it SUBMITS
 * the order — event, feature snapshot, `(runId, evaluationSeq, intentId)`,
 * approved intent, plan, submission attempt, venue order — whether the order
 * later fills or not (`CoreLoop.orderProvenance()`), and the artefact carries
 * that record for every order (golden format 2). An order is resolved through
 * its record to the EMISSION it names, and the decision found at that key
 * decides the side: the entry emission, an order-placing intent of an `exit`
 * or `reduce` decision, or neither. Nothing is assigned to a side for not
 * being the other one, and the walk never reads `action`, which would break
 * on the complement leg where an entry SELLS and its exit BUYS.
 *
 * `RECON-1` had no such record for an order that never filled — the loop
 * records a trace per FILL — and attributed those orders by a CLOSED-WORLD
 * INFERENCE: a compatible origin, no non-exit candidate, and a one-to-one
 * matching of untraced plans to untraced exit emissions. That inference is
 * RETIRED. Its review (`RECON1-ORIGIN`) showed a fabricated but compatible
 * exit re-emission could absorb a phantom plan, because compatibility is not
 * provenance. The record is provenance; an order without one is refused.
 *
 * ## Refused, each by name
 *
 * - an artefact with no provenance section at all (format 1);
 * - an order id booked twice, or a provenance record for an order the venue
 *   never booked, or two records for one order: the record and the book must
 *   agree one to one before either can attribute anything;
 * - an order with NO provenance record (`RECON1-ORIGIN`): nothing in the
 *   document can name its origin;
 * - a record whose plan is not the booked order's plan;
 * - a record naming an emission no persisted decision emitted;
 * - a record naming an emission that COULD NOT have placed the order
 *   ({@link couldHavePlaced});
 * - a record naming an emission that is neither the entry nor an order-placing
 *   exit (a QUOTE, a CANCEL, a `hold`'s intent);
 * - one plan whose orders name two emissions, or one emission claimed by two
 *   plans (below);
 * - a fill whose order the venue never booked;
 * - a trace that is not bound to its own fill (`RECON2-R1`): the fill id it
 *   carries names no fill, or names more than one, or names a fill that
 *   belongs to ANOTHER order than the one the trace names. The loop completes
 *   an order's record into a trace only with a fill of that order;
 * - a trace that DISAGREES with its order's provenance record on any shared
 *   field (`RECON1-ORIGIN`): the loop completes the trace FROM the record;
 * - an order that reports filled shares while no trace names it: the loop
 *   traces every fill of an order it placed.
 *
 * ## Two cross-checks KEPT from the closed-world rule, and why
 *
 * Neither infers an origin; each tests the one the record names.
 *
 * 1. {@link couldHavePlaced}, the compatibility test. A record resolves an
 *    order to an emission by id, but ids alone cannot tell that the order it
 *    names is one that intent could have produced. An intent places orders in
 *    its own market, on one of that market's outcome tokens, labelled with the
 *    token's side, so a record that pairs the take-profit's emission with an
 *    order in a foreign market, on a foreign token or under the wrong side
 *    label contradicts the order it describes — `RECON-1` r2's three
 *    displaced-order reproductions — and is refused.
 * 2. ONE PLAN PER EMISSION, the matcher's surviving content. The loop mints ONE
 *    execution plan per routed emission (`#routeIntent`: one
 *    `executionPlanId` per call, one call per intent of a decided
 *    evaluation), and a plan's orders — its slices and groups — all serve that
 *    emission. `RECON-1` needed augmenting paths to establish that without
 *    ids; with the records it is a direct check in both directions, and it is
 *    what refuses a phantom order whose fabricated record borrows an emission
 *    a real plan already holds.
 *
 * ## Brackets, read from the run (`BRACKET-1b`, `RECON-1` option (a))
 *
 * `RECON-1` chose option (b) — one bracket, and a second `enter` refused —
 * because reconciling several needed bracket-scoped rows and a rule pairing
 * each exit with the entry it closes, and the artefact holds NO id from an exit
 * intent to its entry: the pairing would have been a timing policy invented
 * here. `BRACKET-1b` does not invent one. The brackets are the strategy's OWN:
 *
 * 1. the scenario instance's decisions are split at its `SB.REARMED` decisions
 *    ({@link bracketsOf}; scoped by `instanceId`, ordered by `evaluationSeq`);
 * 2. every boundary must follow a close ({@link refuseUnclosedBoundaries});
 * 3. each bracket has exactly one entry, as the whole run used to
 *    ({@link entryOf});
 * 4. every order is attributed by its provenance record, exactly as below, and
 *    the emission it names belongs to ONE bracket — the bracket of the
 *    decision that emitted it. An exit is therefore paired with its entry BY
 *    ID: both were emitted by decisions of the same bracket;
 * 5. every boundary is placed in the order the run consumed its fills, and the
 *    instance is flat there by this module's own fold
 *    ({@link refuseMisplacedBoundaries}).
 *
 * A run with no `SB.REARMED` is ONE bracket and takes exactly the path it
 * always took. Two `enter` decisions with no `SB.REARMED` between them are
 * still refused: what is not acceptable is silently reading only the first.
 */
function attributeByProvenance(
  artifact: Omit<PaperRunArtifact, "reconciliation">,
): readonly Attribution[] {
  // --- the brackets, and one entry decision / one entry intent in each ------
  const brackets = bracketsOf(artifact);
  const single = brackets.length === 1;
  refuseUnclosedBoundaries(brackets);
  const entries = brackets.map((bracket) => entryOf(bracket, single));

  const fills = artifact.fills;
  if (fills.length === 0) {
    throw new Error("the run produced no fill; there is nothing realized to reconcile against");
  }

  const emissions = emissionsOf(artifact);
  /** Each entry emission's key, to its bracket's ordinal. */
  const entryBracket = new Map(
    entries.map((entry, index) => [entry.key, brackets[index]?.ordinal ?? 0] as const),
  );
  /** Each of the scenario instance's decisions, to its bracket's ordinal. */
  const decisionBracket = new Map<string, number>();
  for (const bracket of brackets) {
    for (const decision of bracket.decisions) {
      decisionBracket.set(decisionKeyOf(decision), bracket.ordinal);
    }
  }

  // A format-1 artefact has no provenance section at all. The types forbid it;
  // a document parsed from old bytes does not read the types, so the absence is
  // refused by name rather than surfacing as "not iterable".
  const records: unknown = artifact.orderProvenance;
  if (!Array.isArray(records)) {
    throw new Error(
      "the artefact carries no orderProvenance section (golden format 2 added it), so no " +
        "order can be attributed to the intent that placed it by id and none is attributed",
    );
  }

  // --- the book and the provenance section agree, one to one -----------------
  const booked = new Map<string, ArtifactOrder>();
  for (const order of artifact.orders) {
    const twin = booked.get(order.simulatedOrderId);
    if (twin !== undefined) {
      throw new Error(
        `order id ${order.simulatedOrderId} is booked twice (under plans ${twin.executionPlanId} ` +
          `and ${order.executionPlanId}); an order id names one order, placed under one plan, so ` +
          "neither booking can be attributed by it",
      );
    }
    booked.set(order.simulatedOrderId, order);
  }
  const provenance = new Map<string, ArtifactOrderProvenance>();
  for (const record of artifact.orderProvenance) {
    if (provenance.has(record.venueOrderId)) {
      throw new Error(
        `order ${record.venueOrderId} has two provenance records; the loop records ONE per ` +
          "order, at submission, so this order's origin is ambiguous and it is not attributed",
      );
    }
    if (!booked.has(record.venueOrderId)) {
      throw new Error(
        `a provenance record names order ${record.venueOrderId} (plan ${record.executionPlanId}), ` +
          "which the venue never booked; the loop records provenance only for an order the " +
          "venue accepted, so the record and the book disagree and neither is attributed",
      );
    }
    provenance.set(record.venueOrderId, record);
  }

  const fillsOf = (orderId: string): readonly ArtifactFill[] =>
    fills.filter((fill) => fill.simulatedOrderId === orderId);
  const named = (order: ArtifactOrder): string => {
    const own = fillsOf(order.simulatedOrderId);
    return own.length === 0
      ? `order ${order.simulatedOrderId}`
      : `order ${order.simulatedOrderId} (fill ${own.map((fill) => fill.simulatedFillId).join(", ")})`;
  };

  // --- every order: resolved BY ID to the emission that placed it -----------
  // …and, since `BRACKET-1b`, to the bracket of the decision that emitted it.
  const placement = new Map<string, { readonly side: "ENTRY" | "EXIT"; readonly bracket: number }>();
  const exitOrigins = new Map<string, Emission>();
  const emissionOfPlan = new Map<string, { readonly key: string; readonly order: string }>();
  const planOfEmission = new Map<string, { readonly plan: string; readonly order: string }>();
  for (const order of artifact.orders) {
    const record = provenance.get(order.simulatedOrderId);
    if (record === undefined) {
      throw new Error(
        `${named(order)} has no provenance record. The loop records one at SUBMISSION for every ` +
          "order it places, filled or not (CoreLoop.orderProvenance), so nothing in this " +
          "document names the intent that placed this order, and it is attributed to neither " +
          "side",
      );
    }
    if (record.executionPlanId !== order.executionPlanId) {
      throw new Error(
        `${named(order)} was booked under plan ${order.executionPlanId}, but its provenance ` +
          `record says plan ${record.executionPlanId}; the record was written from the plan the ` +
          "venue accepted, so the two cannot differ",
      );
    }
    const key = emissionKey(record.runId, record.evaluationSeq, record.intentId);
    const emission = emissions.byKey.get(key);
    if (emission === undefined) {
      throw new Error(
        `${named(order)}'s provenance record names intent ${record.intentId} of the decision at ` +
          `(${record.runId}, ${String(record.evaluationSeq)}), and no persisted decision emitted ` +
          "that intent there; the order's origin is not in this document, so it is attributed " +
          "to neither side",
      );
    }
    if (!couldHavePlaced(emission, order, artifact.scenario)) {
      throw new Error(
        `${named(order)}'s provenance record names ${describeEmission(emission)}, which could ` +
          `not have placed it (market ${order.marketId}, token ${order.tokenId}, side ` +
          `${order.side}): an emission places orders only in its own market, on an outcome ` +
          "token this document names for that market, under that token's side label. The " +
          "record contradicts the order, so the order has no possible origin in this document " +
          "and is not attributed to either side",
      );
    }
    // The bracket of the emitting decision — `undefined` for a decision of
    // another instance (a SHADOW observer's, say), which is no bracket's.
    const bracket = decisionBracket.get(decisionKeyOf(emission.decision));
    const side: "ENTRY" | "EXIT" | undefined = entryBracket.has(key)
      ? "ENTRY"
      : emission.placesOrders && emission.side === "EXIT" && bracket !== undefined
        ? "EXIT"
        : undefined;
    if (side === undefined || bracket === undefined) {
      const own = fillsOf(order.simulatedOrderId);
      const foreign =
        bracket === undefined
          ? ` (a decision of instance ${emission.decision.instanceId}, not of the scenario's ` +
            `instance ${artifact.scenario.instanceId})`
          : "";
      throw new Error(
        own.length > 0
          ? `fill ${own.map((fill) => fill.simulatedFillId).join(", ")} (order ` +
              `${order.simulatedOrderId}) belongs to neither the entry's chain nor any exit's: ` +
              `its order's provenance resolves to ${describeEmission(emission)}${foreign}, which is neither ` +
              "the entry emission nor an order-placing emission of an exit or reduce decision. " +
              "Counting it as exit proceeds because it is not the entry's is the error this " +
              "refusal exists to prevent"
          : `order ${order.simulatedOrderId} was placed under ${describeEmission(emission)}${foreign} — ` +
              "neither the entry intent nor one an exit or reduce decision emitted — so its " +
              "withdrawal is not an exit cancellation, and it is attributed to neither side",
      );
    }
    const planHolds = emissionOfPlan.get(order.executionPlanId);
    if (planHolds !== undefined && planHolds.key !== key) {
      throw new Error(
        `plan ${order.executionPlanId} names two emissions — ${planHolds.key} (order ` +
          `${planHolds.order}) and ${key} (order ${order.simulatedOrderId}); the loop routes ` +
          "each emission to ONE plan, so this plan's orders cannot be attributed to one origin",
      );
    }
    const emissionHeld = planOfEmission.get(key);
    if (emissionHeld !== undefined && emissionHeld.plan !== order.executionPlanId) {
      throw new Error(
        `${describeEmission(emission)} is claimed by two plans — ${emissionHeld.plan} (order ` +
          `${emissionHeld.order}) and ${order.executionPlanId} (order ${order.simulatedOrderId}); ` +
          "the loop mints ONE plan per routed emission (#routeIntent), so at least one of these " +
          "orders was not placed by it and neither is attributed",
      );
    }
    emissionOfPlan.set(order.executionPlanId, { key, order: order.simulatedOrderId });
    planOfEmission.set(key, { plan: order.executionPlanId, order: order.simulatedOrderId });
    placement.set(order.simulatedOrderId, { side, bracket });
    if (side === "EXIT") exitOrigins.set(order.simulatedOrderId, emission);
  }

  // --- every fill: its order's side, or refused -----------------------------
  const unbooked = fills.filter((fill) => !placement.has(fill.simulatedOrderId));
  if (unbooked.length > 0) {
    throw new Error(
      `fill ${unbooked.map((fill) => fill.simulatedFillId).join(", ")} (order ` +
        `${unbooked.map((fill) => fill.simulatedOrderId).join(", ")}) belongs to neither the ` +
        "entry's chain nor any exit's: the venue never booked that order, so no provenance " +
        "record can name its origin. Counting it as exit proceeds because it is not the " +
        "entry's is the error this refusal exists to prevent",
    );
  }
  // --- each bracket's own fills and exit orders -----------------------------
  const attributions: Attribution[] = brackets.map((bracket, index) => {
    const entry = entries[index];
    if (entry === undefined) throw new Error(`${describeBracket(bracket)} lost its entry`);
    const ownFills = (side: "ENTRY" | "EXIT"): readonly ArtifactFill[] =>
      fills.filter((fill) => {
        const placed = placement.get(fill.simulatedOrderId);
        return placed?.side === side && placed.bracket === bracket.ordinal;
      });
    const entryFills = ownFills("ENTRY");
    if (entryFills.length === 0) {
      throw new Error(
        `${single ? "" : `${describeBracket(bracket)}: `}no fill could be attributed to the ` +
          "entry intent through its orders' provenance; the entry rows would compare against an " +
          "empty set and are refused rather than reported as reconciled",
      );
    }
    return {
      bracket,
      entry: entry.entry,
      entryIntent: entry.entryIntent,
      entryFills,
      exitFills: ownFills("EXIT"),
      exitOrigins: new Map(
        [...exitOrigins].filter(
          ([orderId]) => placement.get(orderId)?.bracket === bracket.ordinal,
        ),
      ),
    };
  });

  // --- every trace is bound to its own fill, and agrees with that fill's
  // order's provenance record ------------------------------------------------
  for (const trace of artifact.traces) {
    const record = provenance.get(trace.venueOrderId);
    if (record === undefined) {
      throw new Error(
        `the trace of fill ${trace.venueFillId} names order ${trace.venueOrderId}, which has no ` +
          "provenance record; a trace is its order's submission-time record completed by a " +
          "fill, so a trace without one is not the run's",
      );
    }
    // `RECON2-R1`: a trace names its fill AND its order, and the two must be
    // one link. The loop looks the prefix up by the fill's OWN order id
    // (`#harvestFills`: `#orderTraces.get(fill.simulatedOrderId)`), so a trace
    // whose fill belongs to another order — two traces that swapped their
    // prefixes, or a fill re-pointed at another order — is not the run's.
    // Without this join every filled order could still show "a" trace, and
    // every trace "a" matching record, while the fills sat under the wrong
    // orders. Once it holds, the record compared below is the record of the
    // fill's own order.
    const produced = fills.filter((fill) => fill.simulatedFillId === trace.venueFillId);
    const own = produced[0];
    if (own === undefined || produced.length > 1) {
      throw new Error(
        own === undefined
          ? `the trace of fill ${trace.venueFillId} (order ${trace.venueOrderId}) names a fill ` +
              "the venue never produced; a trace is completed BY its fill, so a trace without " +
              "one is not the run's and its order is not attributed by it"
          : `fill id ${trace.venueFillId}, which the trace of order ${trace.venueOrderId} ` +
              `names, is carried by ${String(produced.length)} fills (orders ` +
              `${produced.map((fill) => fill.simulatedOrderId).join(", ")}); a trace binds ONE ` +
              "fill, so which one it traces is ambiguous and neither is attributed by it",
      );
    }
    if (own.simulatedOrderId !== trace.venueOrderId) {
      throw new Error(
        `the trace of fill ${trace.venueFillId} names order ${trace.venueOrderId}, but fill ` +
          `${trace.venueFillId} belongs to order ${own.simulatedOrderId}; the loop completes an ` +
          "order's provenance record into a trace only with a fill OF THAT ORDER, so this trace " +
          "is not the run's and the fill is not attributed by it",
      );
    }
    const disagreements = PROVENANCE_FIELDS.filter((field) => trace[field] !== record[field]);
    if (disagreements.length > 0) {
      throw new Error(
        `the trace of fill ${trace.venueFillId} disagrees with order ${trace.venueOrderId}'s ` +
          "provenance record on " +
          disagreements
            .map(
              (field) =>
                `${field} (trace ${JSON.stringify(trace[field])}, provenance ` +
                `${JSON.stringify(record[field])})`,
            )
            .join(", ") +
          "; the loop completes a trace FROM that record when the fill arrives, so the two " +
          "cannot both be the run's and the order is not attributed",
      );
    }
  }

  // --- an order that reports fills has traces --------------------------------
  // After the join above, a trace that names an order is bound to one of that
  // order's OWN fills, so a trace borrowed from another order's fill cannot
  // satisfy this check.
  const tracedOrders = new Set(artifact.traces.map((trace) => trace.venueOrderId));
  const untracedFilled = artifact.orders.filter(
    (order) =>
      compareDecimal(order.filledShares, "0") !== 0 && !tracedOrders.has(order.simulatedOrderId),
  );
  if (untracedFilled.length > 0) {
    throw new Error(
      untracedFilled
        .map(
          (order) =>
            `order ${order.simulatedOrderId} reports ${order.filledShares} filled shares, but no ` +
            "trace names it; the loop traces every fill of an order it placed, so this order's " +
            "fills cannot be attributed by id",
        )
        .join("; "),
    );
  }

  // --- several brackets: every boundary placed, and flat (`BRACKET-1b`) -----
  if (!single) refuseMisplacedBoundaries(artifact, attributions);

  return attributions;
}

/**
 * Whether an emission could have placed `order`, by what the artefact can
 * ESTABLISH (`RECON-1` r2) — kept by `RECON-2` as a CROSS-CHECK on the
 * emission an order's provenance record names, no longer as a way to find one.
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

// --- the fold's order: the sequence the run consumed the fills in -----------

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
  return sum([...foldFills(entryFills, exitFills).lots.values()].map((lot) => lot.costBasis));
}

/** One lot of one token, as the average-cost fold holds it. */
interface Lot {
  readonly shares: string;
  readonly costBasis: string;
}

/**
 * One movement the fold consumes: shares of a token that OPEN (add to the lot)
 * or CLOSE (remove from it), at a price. `label` names it in a refusal.
 */
interface Movement {
  readonly label: string;
  readonly token: string;
  readonly shares: string;
  readonly price: string;
  readonly opens: boolean;
}

/**
 * {@link openCostBasisOf}'s fold, over movements ALREADY in consumption order,
 * returning the lots it leaves AND the realized PnL of every closing movement
 * (`BRACKET-1b`): `price × q − the basis q removes`, which is `packages/pnl`'s
 * realized trading PnL under its own average-cost method (fees are not in it;
 * the engine books them apart, `feesPaid`). The arithmetic of the lots is
 * exactly `RECON-1` r1's, and so is the oversell refusal.
 */
function foldMovements(movements: readonly Movement[]): {
  readonly lots: ReadonlyMap<string, Lot>;
  readonly realized: string;
} {
  const lots = new Map<string, Lot>();
  let realized = "0";
  for (const movement of movements) {
    const lot = lots.get(movement.token);
    if (movement.opens) {
      lots.set(movement.token, {
        shares: addDecimal(lot?.shares ?? "0", movement.shares),
        costBasis: addDecimal(lot?.costBasis ?? "0", mulDecimal(movement.price, movement.shares)),
      });
      continue;
    }
    if (lot === undefined || compareDecimal(movement.shares, lot.shares) > 0) {
      throw new Error(
        `${movement.label} removes ${movement.shares} shares of token ` +
          `${movement.token} when, at that point in the sequence, the position holds ` +
          `${lot?.shares ?? "0"}; packages/pnl refuses an oversell (PNL_OVERSELL), so there is ` +
          "no engine cost basis to reconcile against",
      );
    }
    const proceeds = mulDecimal(movement.price, movement.shares);
    if (compareDecimal(movement.shares, lot.shares) === 0) {
      // q = Q: the whole basis leaves, exactly, and the lot closes.
      lots.delete(movement.token);
      realized = addDecimal(realized, subDecimal(proceeds, lot.costBasis));
      continue;
    }
    const removed = divDecimal(
      mulDecimal(lot.costBasis, movement.shares),
      lot.shares,
      PNL_COST_DIVISION,
    );
    lots.set(movement.token, {
      shares: subDecimal(lot.shares, movement.shares),
      costBasis: subDecimal(lot.costBasis, removed),
    });
    realized = addDecimal(realized, subDecimal(proceeds, removed));
  }
  return { lots, realized };
}

/**
 * The entry fills OPEN and the exit fills CLOSE — the table's sign convention,
 * attributed by id, never `action` — folded in {@link inConsumptionOrder}.
 * Every sequence is validated BEFORE the sort (`RECON-1` r2).
 */
function foldFills(
  entryFills: readonly ArtifactFill[],
  exitFills: readonly ArtifactFill[],
): { readonly lots: ReadonlyMap<string, Lot>; readonly realized: string } {
  const unsorted = [
    ...entryFills.map((fill) => ({ fill, opens: true })),
    ...exitFills.map((fill) => ({ fill, opens: false })),
  ];
  for (const { fill } of unsorted) assertCanonicalIngestSeq(fill.atEventIngestSeq);
  const sequence = unsorted.sort((left, right) => inConsumptionOrder(left.fill, right.fill));
  return foldMovements(
    sequence.map(({ fill, opens }) => ({
      label: `exit fill ${fill.simulatedFillId}`,
      token: fill.tokenId,
      shares: fill.shares,
      price: fill.price,
      opens,
    })),
  );
}

/**
 * Builds the whole reconciliation table for one captured run.
 *
 * Pure. Reads only the artefact, and every number it derives is derived with
 * `@polymarket-bot/decimal` — no float appears anywhere in this file.
 *
 * ONE bracket (`BRACKET-1b`): exactly the table this function always built —
 * the entry rows, every fill's fee row, the fee total, the run's ledger and
 * PnL rows, the round trip's edge and the withdrawn exits, in that order, under
 * the same ids. SEVERAL: each bracket's rows under `bracket.<n>.`, followed by
 * `bracket.<n>.pnl.realized`, then the run-cumulative ledger and PnL rows under
 * their own ids and the cumulative `pnl.realized`.
 */
export function buildReconciliation(
  artifact: Omit<PaperRunArtifact, "reconciliation">,
): readonly ReconciliationRow[] {
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
   * intent → provenance record → execution plan → order → fill — never by
   * `action`, which would break on the complement leg where an entry SELLS and
   * its exit BUYS. `RISK-2` walked it for the entry only and took the exit as
   * the complement; `RECON-1` walked both; {@link attributeByProvenance}
   * (`RECON-2`) resolves EVERY order, filled or not, by its own provenance
   * record and refuses what neither side reaches — and (`BRACKET-1b`) assigns
   * it to the bracket of the decision that emitted it.
   */
  const attributions = attributeByProvenance(artifact);
  const allEntryFills = attributions.flatMap((attribution) => attribution.entryFills);
  const allExitFills = attributions.flatMap((attribution) => attribution.exitFills);

  const [only] = attributions;
  if (attributions.length === 1 && only !== undefined) {
    const bracket = bracketRows("", artifact, only, artifact.fills);
    return Object.freeze([
      ...bracket.entry,
      ...bracket.feeFills,
      bracket.feeTotal,
      ...cumulativeRows(artifact, allEntryFills, allExitFills),
      bracket.exitEdge,
      ...bracket.cancelled,
    ]);
  }

  const rows: ReconciliationRow[] = [];
  const realizedByBracket: string[] = [];
  const recordsByBracket = tradeRecordsByBracket(artifact, attributions);
  for (const attribution of attributions) {
    const prefix = `bracket.${String(attribution.bracket.ordinal)}.`;
    const own = new Set([...attribution.entryFills, ...attribution.exitFills]);
    const bracket = bracketRows(
      prefix,
      artifact,
      attribution,
      artifact.fills.filter((fill) => own.has(fill)),
    );
    const realized = bracketRealizedRow(
      prefix,
      attribution,
      recordsByBracket.get(attribution.bracket.ordinal) ?? [],
    );
    realizedByBracket.push(realized.projected);
    rows.push(
      ...bracket.entry,
      ...bracket.feeFills,
      bracket.feeTotal,
      bracket.exitEdge,
      ...bracket.cancelled,
      realized,
    );
  }
  rows.push(
    ...cumulativeRows(artifact, allEntryFills, allExitFills),
    cumulativeRealizedRow(artifact, attributions, realizedByBracket),
  );
  return Object.freeze(rows);
}

/** One bracket's rows, in the order a one-bracket table has always listed them. */
interface BracketRows {
  readonly entry: readonly ReconciliationRow[];
  readonly feeFills: readonly ReconciliationRow[];
  readonly feeTotal: ReconciliationRow;
  readonly exitEdge: ReconciliationRow;
  readonly cancelled: readonly ReconciliationRow[];
}

/**
 * The rows computed from ONE bracket's decisions and fills: its entry, the fee
 * of each of `fills`, its fee total, its round trip's edge and its withdrawn
 * exits. `prefix` is `""` for a one-bracket run — whose `fills` are every fill
 * of the run, exactly what the table always read — and `bracket.<n>.`
 * otherwise, with `fills` that bracket's own, in artefact order.
 */
function bracketRows(
  prefix: string,
  artifact: Omit<PaperRunArtifact, "reconciliation">,
  attribution: Attribution,
  fills: readonly ArtifactFill[],
): BracketRows {
  const scenario = artifact.scenario;
  const schedule = scenario.feeSchedule;
  const { entry, entryIntent, entryFills, exitFills, exitOrigins } = attribution;
  const entryRows: ReconciliationRow[] = [];
  const feeFills: ReconciliationRow[] = [];
  const cancelled: ReconciliationRow[] = [];

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

  // --- the strategy's own projections, from the PERSISTED decision ----------

  const trigger = String(entry.modelOutputs["trigger"] ?? "");
  const projectedCost = String(entry.modelOutputs["entryCost"] ?? "");
  const worstPrice = String(entry.modelOutputs["worstPrice"] ?? "");
  const projectedEdge = String(entry.modelOutputs["expectedNetEdge"] ?? "");

  entryRows.push(
    exact(
      `${prefix}entry.executable_price_notional`,
      "the notional the §9.5 executable-buy-price feature projected for the configured size",
      mulDecimal(trigger, realizedShares),
      `persisted decision (runId ${entry.runId}, evaluationSeq ${String(entry.evaluationSeq)}) ` +
        `modelOutputs.trigger = ${trigger}, times the shares actually filled`,
      realizedNotional,
      "Σ over the venue's fills of price × shares",
    ),
  );

  entryRows.push(
    exact(
      `${prefix}entry.projected_cost`,
      "the entry cost the strategy quoted before emitting the intent",
      projectedCost,
      "persisted decision modelOutputs.entryCost",
      realizedNotional,
      "Σ over the venue's fills of price × shares",
    ),
  );

  entryRows.push(
    exact(
      `${prefix}entry.shares`,
      "the position size",
      entryIntent.targetShares ?? "",
      "the §7.7 POSITION intent's targetShares, as persisted with the decision",
      realizedShares,
      "Σ over the venue's fills of shares",
    ),
  );

  entryRows.push(
    exact(
      `${prefix}entry.worst_price`,
      "the worst per-share price the entry would pay",
      worstPrice,
      "persisted decision modelOutputs.worstPrice",
      worstRealizedPrice,
      "the highest price among the venue's fills for this order",
    ),
  );

  const capHeadroom = subDecimal(realizedNotional, entryIntent.maximumTotalCost ?? "0");
  entryRows.push(
    finish(
      `${prefix}entry.cost_cap`,
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
  entryRows.push(
    exact(
      `${prefix}entry.expected_net_edge_formula`,
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
    feeFills.push(
      finish(
        `${prefix}fee.fill.${fill.simulatedFillId}`,
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

  const feeTotal = finish(
    `${prefix}fee.total_model_vs_venue`,
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
  );

  // --- the round trip, now that one exists ----------------------------------

  /**
   * `RISK-2`: this row USED TO BE AN ABSENCE. It carried
   * `PROTECTIVE_EXIT_REFUSED_AT_RISK_SEAM` and said "no exit fill exists in this
   * run", which was true only because GOV-2B blocker B2 refused every
   * protective exit at the risk seam. The exit now fills, so the projection has
   * a realized counterpart and is reconciled against it.
   *
   * The difference is large and is stated as exact contributions: the exit did
   * not happen at the take-profit price (the bracket ran out of time and closed
   * under §13.3's `final_policy`), and the venue's ad-valorem fees are not the
   * strategy's per-share constant.
   *
   * ## An open position at run end (`RECON-2`, the `RECON1-EDGE` ruling)
   *
   * The row stays the ENTRY intent's persisted projection against the round
   * trip realized SO FAR. The projection is the strategy's documented formula
   * (`packages/strategies/static-bracket` `expectedNetEdge`), over the entry's
   * size E, at the take-profit price TP, with the configured per-share fees fe
   * and fx:
   *
   *     TP × E − entryCost − (fe + fx) × E
   *
   * The realized side is `P − N − C` — exit proceeds, entry notional, charged
   * fees. With X shares exited and O = E − X still open, the contributions are
   *
   *     EXIT_BELOW_TAKE_PROFIT     P − TP × X
   *     POSITION_OPEN_AT_RUN_END   −(TP − fx) × O          (only when O ≠ 0)
   *     FEE_MODEL_BASIS            −(U − (fe × E + fx × X)) (U = the exact fees)
   *     FEE_ROUNDING_HALF_UP       −(C − U)
   *
   * and they sum to `P − TP × E + (fe + fx) × E − C`, which is the difference
   * EXACTLY when `entryCost = N` and the entry filled its whole size — the two
   * things `entry.projected_cost` and `entry.shares` assert on their own rows.
   * Any other gap stays a residual here too: the decomposition names what the
   * run did, it does not absorb what it did not. `RECON-1` modelled the exit fee
   * on all E shares and had no open-position term, so a correct partial exit
   * left `TP × (X − E)` unexplained (−12.5 selling 25 of 50). For a fully
   * closed round trip X = E, the new term is absent and `fe × E + fx × X` is
   * `(fe + fx) × E`: the golden's row is unchanged, number and word.
   */
  const realizedRoundTrip = subDecimal(
    subDecimal(exitProceeds, realizedNotional),
    allChargedFees,
  );
  const targetProceeds = mulDecimal(scenario.takeProfitPrice, exitShares);
  const openShares = subDecimal(realizedShares, exitShares);
  const positionOpen = compareDecimal(openShares, "0") !== 0;
  const modelledFees = addDecimal(
    mulDecimal(scenario.entryFeePerShare, realizedShares),
    mulDecimal(scenario.exitFeePerShare, exitShares),
  );
  const unrealizedNetProceeds = mulDecimal(
    subDecimal(scenario.takeProfitPrice, scenario.exitFeePerShare),
    openShares,
  );
  /** What realized the exit proceeds, by the decisions that placed the exit orders. */
  const exitKinds = [
    ...new Set(
      exitFills.map((fill) => exitKindOf(exitOrigins.get(fill.simulatedOrderId)?.decision.decisionType ?? "")),
    ),
  ];
  const exitedBy =
    exitKinds.length === 0
      ? "no exit fill"
      : exitKinds.length === 1
        ? `the ${exitKinds[0] ?? ""}`
        : `the exits (${exitKinds.join(", ")})`;
  const exitEdge = finish(
    `${prefix}exit.expected_net_edge`,
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
          `${scenario.takeProfitPrice} for ${targetProceeds}; ${exitedBy} ` +
          `realized ${exitProceeds}`,
      },
      ...(positionOpen
        ? [
            {
              mechanism: "POSITION_OPEN_AT_RUN_END" as const,
              amount: negateDecimal(unrealizedNetProceeds),
              note:
                `${openShares} of the ${realizedShares} entry shares were still held when the ` +
                `run ended; the projection's net proceeds for them, (${scenario.takeProfitPrice} ` +
                `− ${scenario.exitFeePerShare}) × ${openShares} = ${unrealizedNetProceeds}, ` +
                "have not happened",
            },
          ]
        : []),
      {
        mechanism: "FEE_MODEL_BASIS",
        amount: negateDecimal(subDecimal(allUnroundedFees, modelledFees)),
        note:
          (positionOpen
            ? `the strategy modelled entry_fee_per_share × ${realizedShares} entry shares + ` +
              `exit_fee_per_share × ${exitShares} exited shares = ${modelledFees} (the open ` +
              "shares' exit fee is inside POSITION_OPEN_AT_RUN_END)"
            : `the strategy modelled (entry_fee_per_share + exit_fee_per_share) × shares = ` +
              `${modelledFees}`) +
          `; the schedule's exact ad-valorem total over every fill is ${allUnroundedFees}`,
      },
      {
        mechanism: "FEE_ROUNDING_HALF_UP",
        amount: negateDecimal(subDecimal(allChargedFees, allUnroundedFees)),
        note:
          `rounding each fill HALF_UP to ${String(schedule.roundingDecimalPlaces)} places ` +
          `moved the exact total ${allUnroundedFees} to ${allChargedFees}`,
      },
    ],
  );

  // --- the projection with NO realized counterpart --------------------------

  // `RECON-1`: the orders attributed to an EXIT, and no longer every order that
  // is not the entry's — an entry order withdrawn unfilled is not an exit.
  // `RECON-2`: attributed by each order's own provenance record, which also
  // names the decision that placed it, so the row says WHAT was withdrawn: a
  // take-profit (`exit`) or a protective reduction (`reduce`).
  const cancelledExits = artifact.orders.filter(
    (order) =>
      exitOrigins.has(order.simulatedOrderId) &&
      order.state === "CANCELLED" &&
      compareDecimal(order.filledShares, "0") === 0,
  );
  for (const order of cancelledExits) {
    const origin = exitOrigins.get(order.simulatedOrderId);
    const decisionType = origin?.decision.decisionType ?? "";
    const withdrawn = exitKindOf(decisionType);
    cancelled.push(
      absent(
        `${prefix}exit.cancelled_proceeds.${order.simulatedOrderId}`,
        `the proceeds a withdrawn ${withdrawn} projected`,
        mulDecimal(order.limitPrice, order.requestedShares),
        "the cancelled order's own limitPrice × requestedShares",
        "no fill exists for this order",
        {
          mechanism: "RESTING_EXIT_CANCELLED_UNFILLED",
          amount: "0",
          note:
            `order ${order.simulatedOrderId} — the ${withdrawn} the \`${decisionType}\` decision ` +
            `at evaluationSeq ${String(origin?.decision.evaluationSeq ?? "")} placed (intent ` +
            `${origin?.intent.intentId ?? ""}), by its provenance record — rested ` +
            `${order.requestedShares} shares at ${order.limitPrice} and was withdrawn with ` +
            `${order.filledShares} filled; the run confirmed ` +
            `${String(artifact.health.execution["cancelsConfirmed"] ?? 0)} cancel(s)`,
        },
      ),
    );
  }

  return { entry: entryRows, feeFills, feeTotal, exitEdge, cancelled };
}

/**
 * The run-CUMULATIVE rows: the instance's ledger lines and its LAST PnL
 * snapshot, against every attributed fill of every bracket. For a one-bracket
 * run these are exactly the rows the table always listed between the fee total
 * and the round trip's edge.
 */
function cumulativeRows(
  artifact: Omit<PaperRunArtifact, "reconciliation">,
  entryFills: readonly ArtifactFill[],
  exitFills: readonly ArtifactFill[],
): readonly ReconciliationRow[] {
  const rows: ReconciliationRow[] = [];
  const scenario = artifact.scenario;
  const fills = artifact.fills;
  const realizedNotional = sum(entryFills.map((fill) => mulDecimal(fill.price, fill.shares)));
  const realizedShares = sum(entryFills.map((fill) => fill.shares));
  const exitProceeds = sum(exitFills.map((fill) => mulDecimal(fill.price, fill.shares)));
  const exitShares = sum(exitFills.map((fill) => fill.shares));
  const allChargedFees = sum(fills.map((fill) => fill.feeAmount));

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
   * `RECON-1` could not change the golden, so the `projectedSource` text of
   * `pnl.capital_committed` and `pnl.worst_case_resolution` below kept saying
   * "FIFO" (`RECON1-TEXT`). `RECON-2` regenerated the golden and corrected both
   * strings; the NUMBERS did not move, because they never differed for any state
   * the golden holds.
   */
  const openCostBasis = openCostBasisOf(entryFills, exitFills);

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
      "the AVERAGE-COST basis packages/pnl holds for the still-open position, restated from " +
        "its specification: each entry fill adds price × shares, each exit fill removes " +
        "basis × q / Q (34 significant digits, ROUND_HALF_EVEN; the remainder by exact " +
        "subtraction), folded in atEventIngestSeq order — the whole entry notional while the " +
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
        "folded from the venue's fills by packages/pnl's own average-cost method (zero once the " +
        "bracket has closed)",
      field("worstCaseResolutionPnl"),
      "the last persisted PnL snapshot's worstCaseResolutionPnl",
    ),
  );

  return rows;
}

/** One §9.16 TRADE record of the instance's stream, placed in its bracket BY ID. */
interface BracketTrade {
  readonly record: ArtifactPnlRecord;
  /** The venue fill the record books, found through the chain that posted it. */
  readonly fill: ArtifactFill;
  /** True for an entry fill (it opens), false for an exit fill (it closes). */
  readonly opens: boolean;
}

/**
 * Each bracket's §9.16 TRADE records (`BRACKET-1b`), resolved BY ID: a record's
 * `ref` is the ledger transaction it follows from, the chain (trace) that
 * posted that transaction names the fill, and the fill's order places it in a
 * bracket and on a side. Only the scenario instance's `VIRTUAL_STRATEGY`
 * records are read — the artefact carries no other stream.
 *
 * A TRADE record that no chain posted, or whose fill is in no bracket, is
 * REFUSED: its bracket cannot be established by id, and dropping it would make
 * a bracket's realized PnL agree with its fills by omission.
 */
function tradeRecordsByBracket(
  artifact: Omit<PaperRunArtifact, "reconciliation">,
  attributions: readonly Attribution[],
): ReadonlyMap<number, readonly BracketTrade[]> {
  const fillOfTransaction = new Map<string, string>();
  for (const trace of artifact.traces) {
    for (const id of trace.ledgerTransactionIds) fillOfTransaction.set(id, trace.venueFillId);
  }
  const placed = new Map<string, { readonly bracket: number; readonly fill: ArtifactFill; readonly opens: boolean }>();
  for (const attribution of attributions) {
    const bracket = attribution.bracket.ordinal;
    for (const fill of attribution.entryFills) placed.set(fill.simulatedFillId, { bracket, fill, opens: true });
    for (const fill of attribution.exitFills) placed.set(fill.simulatedFillId, { bracket, fill, opens: false });
  }
  const byBracket = new Map<number, BracketTrade[]>();
  for (const record of artifact.pnlRecords) {
    if (record.kind !== "TRADE") continue;
    if (record.scope !== "VIRTUAL_STRATEGY" || record.instanceId !== artifact.scenario.instanceId) {
      continue;
    }
    const fillId = fillOfTransaction.get(record.ref);
    const at = fillId === undefined ? undefined : placed.get(fillId);
    if (at === undefined) {
      throw new Error(
        `the §9.16 TRADE record whose ref is ledger transaction ${record.ref} ` +
          (fillId === undefined
            ? "follows from a transaction no chain in this document posted"
            : `books fill ${fillId}, which no bracket's attribution holds`) +
          ", so the bracket it belongs to cannot be established by id and no per-bracket " +
          "realized PnL is reported",
      );
    }
    const list = byBracket.get(at.bracket) ?? [];
    list.push({ record, fill: at.fill, opens: at.opens });
    byBracket.set(at.bracket, list);
  }
  return byBracket;
}

/**
 * `bracket.<n>.pnl.realized` (`BRACKET-1b`): the bracket's realized trading PnL
 * (before fees), from TWO sources that must agree exactly.
 *
 * - PROJECTED: its own venue FILLS, folded from the bracket's flat start —
 *   which {@link refuseMisplacedBoundaries} proved — by `packages/pnl`'s
 *   average-cost method ({@link foldFills}).
 * - REALIZED: its §9.16 TRADE records, the stream the PnL engine folds,
 *   attributed to the bracket by id ({@link tradeRecordsByBracket}) and folded
 *   the same way, in their fills' consumption order.
 *
 * The run-cumulative `pnl.realized` then checks that these per-bracket values
 * sum to what the engine itself persisted.
 */
function bracketRealizedRow(
  prefix: string,
  attribution: Attribution,
  trades: readonly BracketTrade[],
): ReconciliationRow {
  const fromFills = foldFills(attribution.entryFills, attribution.exitFills).realized;
  const movements = [...trades]
    .sort((left, right) => inConsumptionOrder(left.fill, right.fill))
    .map(({ record, fill, opens }) => {
      if (record.shares === null || record.price === null) {
        throw new Error(
          `the §9.16 TRADE record whose ref is ledger transaction ${record.ref} carries no ` +
            "shares or no price, so it cannot be folded",
        );
      }
      return {
        label: `the TRADE record (ledger transaction ${record.ref}) of fill ${fill.simulatedFillId}`,
        token: record.tokenAssetId ?? fill.tokenId,
        shares: record.shares,
        price: record.price,
        opens,
      };
    });
  const fromRecords = foldMovements(movements).realized;
  return exact(
    `${prefix}pnl.realized`,
    "the bracket's realized trading PnL, before fees",
    fromFills,
    "the bracket's own venue fills, folded from its flat start by packages/pnl's average-cost " +
      "method — each exit fill realizes price × shares less the basis it removes — in " +
      "atEventIngestSeq order",
    fromRecords,
    "the bracket's §9.16 TRADE records in the persisted pnlRecords stream, each placed in the " +
      "bracket by id (record.ref → the chain that posted that ledger transaction → its fill), " +
      "folded the same way",
  );
}

/**
 * The run-cumulative `pnl.realized` (`BRACKET-1b`): the per-bracket realized
 * PnL, summed, against the engine's own last persisted snapshot. This is the
 * row that checks the brackets ADD UP to the run.
 */
function cumulativeRealizedRow(
  artifact: Omit<PaperRunArtifact, "reconciliation">,
  attributions: readonly Attribution[],
  realizedByBracket: readonly string[],
): ReconciliationRow {
  const snapshot = artifact.pnlSnapshots.at(-1);
  if (snapshot === undefined) {
    throw new Error("the run persisted no PnL snapshot; the chain does not reach §9.16");
  }
  return exact(
    "pnl.realized",
    "realized trading PnL, as the sum of the run's brackets",
    sum(realizedByBracket),
    `Σ over the ${String(attributions.length)} brackets of bracket.<n>.pnl.realized's fill-folded ` +
      `value (${realizedByBracket.join(" + ")})`,
    String(snapshot["realizedPnl"] ?? ""),
    "the last persisted PnL snapshot's realizedPnl",
  );
}

/** Every row whose difference is not fully accounted for. */
export function unexplainedRows(
  rows: readonly ReconciliationRow[],
): readonly ReconciliationRow[] {
  return rows.filter((row) => !row.explained);
}
