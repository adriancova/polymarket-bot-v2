/**
 * The reconciliation BREAK TAXONOMY (WP-290 deliverable 2; handoff §9.17
 * steps 5–8, §9.15, §6 invariants 7, 8 and 12, §10.6).
 *
 * A BREAK is one discrepancy between authoritative state (a venue read) and
 * this system's projections (the OMS, the ledger, the inventory), or one
 * reason that the comparison could not be made at all. Every class below
 * carries exactly one RULE, which says how the break leaves the open state:
 *
 * | Rule | Blocks resume | Leaves the open state by |
 * | --- | --- | --- |
 * | `RESOLVE_IN_RUN` | until resolved | the same run fixing it (e.g. a missing fill delivered and accepted) |
 * | `HOLD_UNTIL_CONSISTENT` | yes | a LATER complete run that no longer reproduces it (`NOT_REPRODUCED`) |
 * | `QUARANTINE_UNTIL_RELEASED` | yes | an operator's release, recorded with who and why (`OPERATOR_RELEASED`) |
 * | `UNATTRIBUTED_HALT` | yes | the same as above, after the activity was recorded as UNATTRIBUTED and its market halted |
 *
 * EVERY UNRESOLVED BREAK BLOCKS RESUME, whatever its rule. The rule decides
 * only who may resolve it. Ambiguity (a missing, malformed, incomplete, stale,
 * conflicting or out-of-order read; several candidates for one signed
 * identity) is always `HOLD_UNTIL_CONSISTENT`: it can never be released by an
 * operator, only out-read by a later complete run. That is how "ambiguous
 * state never resumes trading" (work-plan acceptance 1) is a property of the
 * table rather than of a caller's diligence. A run clears a break (r6, class
 * B) only through ONE function, and only when the comparison that actually
 * ran in that run POSITIVELY JUDGED the break's exact subject consistent, in
 * a CONCLUSIVE run (every read answered, in its shape, completely,
 * consistently and fresh); anything not judged stays open:
 *
 * | Subject | Positively judged by |
 * | --- | --- |
 * | a read problem keyed by one read (or one by-id read) | that read answering in its shape |
 * | a holding (`HOLDING_*`, `CORRECTION_FAILED`, `APPROVAL_MISSING`, `WALLET_OPERATION_IN_FLIGHT`) | the holding comparison finding that asset matched (that spender approved; no operation in flight) |
 * | one tracked order's state or fills (`ORDER_STATE_MISMATCH`, `ORDER_FACTS_MISMATCH`, `ORDER_TRADES_INCOMPLETE`, `ORDER_FILLS_AHEAD_OF_VENUE`, `TRADE_MISSING_IN_OMS`, `FILL_*`) | a comparison of that order in full (not skipped for an unknown token, other venue facts or a missing read) that found nothing wrong with it; a refused fill also needs its trade read consistent; a missed fill, its delivery accepted |
 * | one venue order or trade (a conflict, regression or unrecognised status keyed by it; `ORDER_UNRESOLVED` keyed by the venue order) | the evidence store's verdict on that object, in this run: CONSISTENT (a named id: answered by its by-id read, found or not) |
 * | `SETTLEMENT_REVERSAL_OWED` | that trade read consistent, and the holdings judged with nothing of its fill booked |
 * | an attempt's identity ambiguity, or a refused answer | that attempt judged without ambiguity, or an answer accepted (or nothing owed any more) |
 * | a wallet member's hold | an answer for that member accepted, or its operation's request gone |
 * | a malformed request | a run its channel presented nothing malformed to |
 *
 * THE EVIDENCE (r6, class A). Every validated venue observation, from every
 * source and whatever the run's soundness, is recorded in the journal
 * (`EVIDENCE_RECORDED`) before anything is classified, so the coordinator's
 * evidence store is rebuilt from it after a restart. Its PROVENANCE: SHOWN
 * when a source showed the order in full (a complete open-orders list, a
 * valid row or leg inside a partial, malformed or duplicated answer, a valid
 * trades read's leg, a by-id read that found it), NAMED otherwise (the id
 * alone of a malformed row or leg; an id the OMS retains as user-stream
 * evidence; one the stream reported). Its HIGH-WATER marks (the most matched
 * any observation showed, at least the sum of the distinct trades' legs;
 * terminal once shown terminal; the furthest settlement) are monotonic. Every
 * venue order with evidence no sound run has settled is read by id in every
 * run. A read below the high-water mark, live after terminal, or a settlement
 * backwards is a `READ_REGRESSION` (a contradiction a `READ_CONFLICT`); a
 * SHOWN order that a later by-id read does not find is a `READ_CONFLICT`
 * (E-14: canceled and fully matched orders are found by id); a NAMED one is
 * an `ORDER_NOT_FOUND_BY_ID` quarantine, which an operator can release.
 * None of these ever resolves an order, answers for it, or fixes its final
 * size below the evidence: each only holds.
 *
 * IMMUTABLE FACTS (r7). The evidence keeps EVERY value any observation showed
 * of an order's fixed facts (token, side, price, original size) and of a
 * fill's facts (shares, price, fee, fee asset, liquidity role, match time).
 * Two different values of one fact are a DURABLE `READ_CONFLICT` on that order
 * or trade: which is the venue's is unknown, so no later read ends it (an
 * unverified venue assumption, held as a conservative policy: these facts never
 * change for one id; no venue document states it). A trade a read SHOWED that
 * a complete trades read omits is a `READ_CONFLICT` while it is not accounted
 * for under its own identity (its order tracked, or ownable by an unresolved
 * attempt, or a `TRADE_UNATTRIBUTED` recorded for it, which the coordinator
 * records from the evidence when no one can own the order). What the user
 * stream reported that the OMS did not apply, whatever the OMS answered, is
 * evidence too.
 *
 * WHAT A RELEASE MEANS ({@link RELEASE_ACKNOWLEDGES_SUBJECT}). Releasing
 * immutable history (an UNATTRIBUTED order or trade, a booking, one OMS alert,
 * one trade's FAILED settlement, one venue order id the venue does not show)
 * acknowledges its subject for good. A release is never proof that a ledger
 * correction was booked: a FAILED trade's compensating reversal is a separate
 * hold (`SETTLEMENT_REVERSAL_OWED`) that only the ledger clears. Releasing
 * a LIVE contradiction (a tracked order whose venue facts differ) does not:
 * every run that still finds it opens it again. A subject must therefore name
 * ONE occurrence: each OMS halting alert is keyed by its OMS instance and its
 * ordinal, each FAILED settlement by its trade and order, and each ledger halt
 * obligation by its transaction, movement kind, asset, market and place, so a
 * release never acknowledges another occurrence like it. Likewise one venue
 * order id's not-found quarantine: released, then named again by new evidence
 * and still not found, is a new occurrence with its own subject. Every halt
 * obligation that needs no consistent view of the venue (a ledger arrival, a
 * FAILED settlement, an OMS alert) is derived again in EVERY run, whatever its
 * soundness, so none waits on (or is lost to) a view the account may never
 * get back.
 *
 * UNMATCHED ACTUAL ACTIVITY becomes UNATTRIBUTED (work-plan acceptance 2;
 * §6 invariant 7; §9.15): an order or a trade of the account that no tracked
 * order or unresolved attempt can own (`ORDER_UNATTRIBUTED`,
 * `TRADE_UNATTRIBUTED`), and a confirmed position or balance delta that no
 * activity explains (`POSITION_UNATTRIBUTED`, `BALANCE_UNATTRIBUTED`, booked
 * to the ledger's `UNATTRIBUTED` scope by a `RECONCILIATION_CORRECTION`;
 * `holdings.ts`). Each halts its market (or the account, when no market is
 * known) and stays quarantined until released.
 *
 * Spellings: every class is a valid `internal.code` (migration 0001: a letter,
 * then letters, digits, `_ . : -`; at most 64 characters), so a class is the
 * `ops.reconciliation_breaks.break_type` value with no mapping. The triggers,
 * run statuses and break statuses are token-identical to the WP-040 enums
 * `internal.reconciliation_trigger`, `internal.reconciliation_status` and
 * `internal.break_status`.
 *
 * Pure data. No I/O, no clock, no randomness.
 */

/** §9.17's eight triggers (`internal.reconciliation_trigger`). */
export const RECONCILIATION_TRIGGERS = [
  "STARTUP",
  "PERIODIC_TIMER",
  "USER_STREAM_RECONNECT",
  "MARKET_STREAM_GAP",
  "SUBMISSION_UNKNOWN",
  "WALLET_OPERATION_UNKNOWN",
  "MANUAL_REQUEST",
  "POSITION_BALANCE_DISCREPANCY",
] as const;
export type ReconciliationTrigger = (typeof RECONCILIATION_TRIGGERS)[number];

/** `internal.reconciliation_status`. */
export const RECONCILIATION_RUN_STATUSES = ["RUNNING", "PASSED", "FAILED", "QUARANTINED"] as const;
export type ReconciliationRunStatus = (typeof RECONCILIATION_RUN_STATUSES)[number];

/** `internal.break_status`. */
export const BREAK_STATUSES = ["OPEN", "RESOLVED", "QUARANTINED"] as const;
export type BreakStatus = (typeof BREAK_STATUSES)[number];

export const BREAK_RULES = ["RESOLVE_IN_RUN", "HOLD_UNTIL_CONSISTENT", "QUARANTINE_UNTIL_RELEASED", "UNATTRIBUTED_HALT"] as const;
export type BreakRule = (typeof BREAK_RULES)[number];

/** A break concerns the whole account, or one market (`marketId` then required). */
export const BREAK_SCOPES = ["ACCOUNT", "MARKET"] as const;
export type BreakScope = (typeof BREAK_SCOPES)[number];

export const BREAK_FAMILIES = ["READ", "ORDER", "TRADE", "HOLDING", "WALLET", "CONTROL"] as const;
export type BreakFamily = (typeof BREAK_FAMILIES)[number];

/** How a break left the open state (the `BREAK_RESOLVED` event). */
export const BREAK_RESOLUTIONS = ["RESOLVED_IN_RUN", "NOT_REPRODUCED", "OPERATOR_RELEASED"] as const;
export type BreakResolution = (typeof BREAK_RESOLUTIONS)[number];

export interface BreakClassSpec {
  readonly family: BreakFamily;
  readonly rule: BreakRule;
  /** What was observed. */
  readonly meaning: string;
  /** What the coordinator does about it. */
  readonly handling: string;
}

const HOLD = "HOLD_UNTIL_CONSISTENT" as const;
const QUARANTINE = "QUARANTINE_UNTIL_RELEASED" as const;
const UNATTRIBUTED = "UNATTRIBUTED_HALT" as const;
const IN_RUN = "RESOLVE_IN_RUN" as const;

/** The taxonomy. Keys are the break classes; the operator runbook (`docs/runbooks/reconciliation.md`) explains each. */
export const BREAK_TAXONOMY = Object.freeze({
  // --- reads: the comparison cannot be made; always ambiguity -------------------------------
  READ_MISSING: {
    family: "READ",
    rule: HOLD,
    meaning: "a required authoritative read failed, threw, or was not provided",
    handling: "nothing is concluded from the run; submissions stay paused; the next complete run decides",
  },
  READ_MALFORMED: {
    family: "READ",
    rule: HOLD,
    meaning: "a read answered outside the read port's shape (an inexact decimal, a bad identifier, a field that is not own data)",
    handling: "the answer is discarded whole; submissions stay paused",
  },
  READ_INCOMPLETE: {
    family: "READ",
    rule: HOLD,
    meaning: "a paginated read did not reach its last page (the CLOB's end cursor; verified-2026-09-30 E-13, E-14)",
    handling: "a partial list proves nothing absent; submissions stay paused",
  },
  READ_WRONG_ROUTE: {
    family: "READ",
    rule: HOLD,
    meaning: "a read came from a route other than the one required (Data API v1 is retired on 2026-10-24; only /v2 is accepted; E-15)",
    handling: "the read is refused as if missing",
  },
  READ_STALE: {
    family: "READ",
    rule: HOLD,
    meaning: "the run's reads spanned more than the configured bound, or the clock was unreadable or went backwards at any point of the run (its reads, an answer's record, a receipt, an awaited delivery or write, its closing reading)",
    handling:
      "the run is not trusted as one view of the account: from the moment the fault is detected it gives no further answer, books nothing, acts on no break, clears none and does not resume; submissions stay paused, and a later run with fresh reads (and every pending request's quiescence restarted) answers what it withheld",
  },
  READ_CONFLICT: {
    family: "READ",
    rule: HOLD,
    meaning:
      "two reads of one run disagree about a fixed fact (an order's token, side, price or size; a trade's legs), or a read contradicts the evidence: an order a source showed in full that its by-id read does not find, trades summing to more than the order's matched size (or a trade naming an order a read shows with nothing matched), a trade's leg missing or of other shares, a terminal settlement contradicting an earlier one; (r7) an order's fixed fact or a fill's economics shown with two values by any observations, of any run or source (a durable contradiction); a trade a read showed that a complete trades read omits while it is not accounted for under its own identity",
    handling:
      "nothing about the subject is concluded, the run is not one view of the account (no answer, no signed-identity resolution, no delivery, no classification, no clearing); submissions stay paused until a read agrees with all the evidence. A fact shown with two values never agrees again: it holds for good, and no tool retracts evidence (an ADR is owed)",
  },
  READ_REGRESSION: {
    family: "READ",
    rule: HOLD,
    meaning:
      "a read shows an older state than any earlier validated observation did, from any run or source (an out-of-order read: matched size below the evidence's high-water mark, open after terminal, a settlement backwards, a read behind the OMS's durable settlement)",
    handling: "the evidence is kept (it never moves down); nothing is answered or settled from the read; submissions stay paused until a read catches up",
  },
  STATUS_UNRECOGNISED: {
    family: "READ",
    rule: HOLD,
    meaning: "an order or trade status outside the documented vocabulary (C-3's MATCHED_NOT_BROADCASTED included)",
    handling: "never assumed harmless; submissions stay paused",
  },
  // --- orders ----------------------------------------------------------------------------
  SIGNED_IDENTITY_AMBIGUOUS: {
    family: "ORDER",
    rule: HOLD,
    meaning:
      "more than one venue order could be the unknown attempt's, or one venue order could be more than one attempt's (no order hash exists: WP-270 STOPPED item), or a GHOST stands: an unclaimed venue order id only named (the id alone of a malformed row or leg, an id the OMS retains as user-stream evidence, one the stream reported), which the venue's by-id read does not find (its token is unknown, so it could be any attempt's)",
    handling: "no answer is given; the attempt stays unresolved and submissions stay paused",
  },
  ORDER_UNATTRIBUTED: {
    family: "ORDER",
    rule: UNATTRIBUTED,
    meaning: "the venue holds an order of the account that no tracked order and no unresolved attempt can own",
    handling: "recorded as UNATTRIBUTED activity; its market is halted; quarantined until released",
  },
  ORDER_FACTS_MISMATCH: {
    family: "ORDER",
    rule: QUARANTINE,
    meaning: "a tracked order's fixed facts (token, side, price, original size) differ at the venue",
    handling: "no answer is given; quarantined until released, and opened again by every run that still finds it (a release does not acknowledge a live contradiction)",
  },
  ORDER_STATE_MISMATCH: {
    family: "ORDER",
    rule: HOLD,
    meaning: "a tracked order is open in the OMS but terminal at the venue, or the reverse",
    handling: "routed to the OMS for an authoritative read; held until the OMS agrees",
  },
  ORDER_UNRESOLVED: {
    family: "ORDER",
    rule: HOLD,
    meaning: "an attempt or order still awaits an authoritative read at the end of the run (e.g. the quiescence horizon has not passed)",
    handling: "held; a later run answers it",
  },
  ORDER_TRADES_INCOMPLETE: {
    family: "ORDER",
    rule: HOLD,
    meaning: "the venue's matched size for an order exceeds the trades the reads show for it",
    handling: "held until the trades are visible",
  },
  ORDER_FILLS_AHEAD_OF_VENUE: {
    family: "ORDER",
    rule: HOLD,
    meaning: "the OMS recorded more fill for an order than the venue's reads show",
    handling: "no answer is given (it would contradict recorded fills); held until the reads catch up",
  },
  ORDER_NOT_FOUND_BY_ID: {
    family: "ORDER",
    rule: QUARANTINE,
    meaning:
      "a venue order id with evidence that only NAMED it (the id alone of a malformed row or leg, nothing else of which validated; an id the OMS retains as user-stream evidence; one the stream reported), which a by-id read of a sound run does not find (E-14: canceled and fully matched orders are found by id); one subject per occurrence (a new one after each release)",
    handling:
      "quarantined (the account is halted) until released; while unresolved it is read by id in every run and, once found, classified like any order, and while it is not found no attempt is answered by signed identity (it could be any attempt's); releasing it settles that id's evidence (\"the venue does not show it\"), until new evidence names it again (a new occurrence). An id a source showed in full is a READ_CONFLICT instead",
  },
  // --- trades ----------------------------------------------------------------------------
  TRADE_UNATTRIBUTED: {
    family: "TRADE",
    rule: UNATTRIBUTED,
    meaning:
      "a trade of the account on an order that no tracked order and no unresolved attempt can own: one the trades read shows, or (r7) one the evidence holds that the read no longer shows (a trade a read showed and a complete read omits, or one the stream named), under its own trade id",
    handling: "recorded as UNATTRIBUTED activity; its market is halted; quarantined until released",
  },
  TRADE_MISSING_IN_OMS: {
    family: "TRADE",
    rule: IN_RUN,
    meaning: "a trade of a tracked order that the OMS had not recorded (a missed stream event)",
    handling: "delivered to the OMS as a fill with its exact economics; resolved when the OMS accepts it",
  },
  FILL_ECONOMICS_UNFIXED: {
    family: "TRADE",
    rule: HOLD,
    meaning: "a missing fill whose exact fee the read does not fix (a fee rate is not a fee amount; U-16)",
    handling: "never booked with a guessed fee; held",
  },
  FILL_REFUSED: {
    family: "TRADE",
    rule: HOLD,
    meaning: "the OMS refused a fill or settlement the coordinator delivered",
    handling: "held; a conflicting fill also raises the OMS's own halting alert",
  },
  FILL_MISMATCH: {
    family: "TRADE",
    rule: HOLD,
    meaning:
      "a tracked order's fills in the OMS and its trades at the venue differ: the same trade with other economics (shares, price, fee, role, match time) or a contradicting settlement, or trade ids the OMS did not record while fills it recorded are missing",
    handling: "nothing is delivered or booked for the order, and holdings are not judged; held until a fresh comparison finds the two equal",
  },
  SETTLEMENT_REVERSAL_OWED: {
    family: "TRADE",
    rule: HOLD,
    meaning:
      "the venue shows a trade FAILED and the ledger still books some of its fill: the compensating reversal ADR-006 §5 requires (linked to the transaction it reverses) is not booked yet; one break per trade and order",
    handling:
      "the fill's remaining booking explains the holding difference it causes, and nothing else; held, never released by an operator, until a run that read the trade and judged the holdings finds nothing of the fill booked",
  },
  SETTLEMENT_FAILED: {
    family: "TRADE",
    rule: QUARANTINE,
    meaning:
      "the venue's trades read shows a trade of a tracked order FAILED (ADR-006 §5: the ledger booked the fill at its match and owes a compensating reversal); one break per trade and order, keyed by the venue's own ids",
    handling:
      "the order's market is halted; quarantined until released. Derived from the venue's trades read in every run that read it (whatever the run's soundness), not from the OMS's in-memory alert, so a restart never loses it; releasing it acknowledges that one trade's failure",
  },
  // --- holdings (positions and balances against the ledger projection) -------------------
  HOLDING_IN_TRANSIT_AMBIGUOUS: {
    family: "HOLDING",
    rule: HOLD,
    meaning: "an asset's holding differs from its projection while trades in that asset are unsettled, and no all-or-nothing settlement explains it",
    handling: "held until the trades settle",
  },
  HOLDING_DELTA_UNCONFIRMED: {
    family: "HOLDING",
    rule: HOLD,
    meaning: "an unexplained holding delta seen once, not yet confirmed by a later read",
    handling: "held; booked only if a later read confirms the same delta",
  },
  POSITION_UNATTRIBUTED: {
    family: "HOLDING",
    rule: UNATTRIBUTED,
    meaning: "a confirmed outcome-token position delta that no activity explains",
    handling: "booked to the ledger's UNATTRIBUTED scope (RECONCILIATION_CORRECTION); the market is halted; quarantined until released",
  },
  BALANCE_UNATTRIBUTED: {
    family: "HOLDING",
    rule: UNATTRIBUTED,
    meaning: "a confirmed collateral balance delta that no activity explains",
    handling: "booked to the ledger's UNATTRIBUTED scope (RECONCILIATION_CORRECTION); the account is halted; quarantined until released",
  },
  LEDGER_UNATTRIBUTED_ARRIVAL: {
    family: "HOLDING",
    rule: UNATTRIBUTED,
    meaning: "the ledger holds an UNATTRIBUTED arrival that no break records (e.g. a crash between the booking and the journal); one per transaction, movement kind, asset, market and place",
    handling: "the halt obligation is recovered from the ledger in every run that read the projection (whatever the run's soundness): its market is halted; quarantined until released",
  },
  WALLET_OPERATION_IN_FLIGHT: {
    family: "HOLDING",
    rule: HOLD,
    meaning: "holdings were not judged because a wallet operation is in flight or quarantined",
    handling: "held until the operation is terminal",
  },
  APPROVAL_MISSING: {
    family: "HOLDING",
    rule: HOLD,
    meaning: "a required trading approval is not shown by the approvals read",
    handling: "held",
  },
  CORRECTION_FAILED: {
    family: "HOLDING",
    rule: HOLD,
    meaning: "the ledger refused, or did not confirm, an UNATTRIBUTED correction",
    handling: "held; the delta is booked by a later run",
  },
  // --- wallet operations -----------------------------------------------------------------
  WALLET_MEMBER_PENDING: {
    family: "WALLET",
    rule: HOLD,
    meaning: "an identity member of a wallet operation is not terminal at the source (pending, dropped, not found, or an unrecognised report)",
    handling: "no answer is given; the member is read again until it is terminal, then answered by name",
  },
  WALLET_MEMBER_UNREADABLE: {
    family: "WALLET",
    rule: HOLD,
    meaning: "an identity member could not be read (the read failed, or no read is documented for it, as for a relayer id)",
    handling: "held",
  },
  WALLET_OPERATION_UNIDENTIFIABLE: {
    family: "WALLET",
    rule: QUARANTINE,
    meaning: "a wallet operation that never named a transaction: nothing exists to read by name",
    handling: "never answered automatically; quarantined until released",
  },
  WALLET_ANSWER_REFUSED: {
    family: "WALLET",
    rule: HOLD,
    meaning: "the inventory refused a terminal answer the coordinator delivered",
    handling: "held; the inventory weighs the refused answer itself",
  },
  WALLET_REQUESTS_OUTSTANDING: {
    family: "WALLET",
    rule: HOLD,
    meaning: "after a retry the inventory still holds reconciliation requests it could not deliver (ADR-032 D5)",
    handling: "held; retried every run",
  },
  WALLET_OPERATION_UNSETTLED: {
    family: "WALLET",
    rule: HOLD,
    meaning: "a wallet operation is reconciling, unknown, or quarantined in the inventory",
    handling: "held until the inventory concludes it",
  },
  // --- control ---------------------------------------------------------------------------
  OMS_HALTING_ALERT: {
    family: "CONTROL",
    rule: QUARANTINE,
    meaning: "the OMS raised an alert that halts a market (an evidence conflict, an unknown venue order, a failed settlement, ...); one break per alert raised",
    handling: "the market is halted; quarantined until released; releasing it acknowledges that one alert, never a later one like it",
  },
  OMS_EVIDENCE_RETAINED: {
    family: "CONTROL",
    rule: HOLD,
    meaning: "the OMS holds evidence for a venue order id it cannot yet attribute",
    handling: "held until the evidence is applied or released",
  },
  COMPONENT_UNAVAILABLE: {
    family: "CONTROL",
    rule: HOLD,
    meaning: "a component the run needs is faulted or not bound (the OMS, the wallet manager, the journal sink)",
    handling: "held",
  },
  ANSWER_REFUSED: {
    family: "CONTROL",
    rule: HOLD,
    meaning: "the OMS refused an answer the coordinator delivered",
    handling: "held; a later run reads again",
  },
  HALT_DELIVERY_FAILED: {
    family: "CONTROL",
    rule: HOLD,
    meaning: "a market or account halt could not be handed to the halt port",
    handling: "held; the halt is delivered again by every run",
  },
  REQUEST_MALFORMED: {
    family: "CONTROL",
    rule: HOLD,
    meaning: "a reconciliation request (from the OMS, the inventory or the user stream) could not be read",
    handling: "held",
  },
} as const satisfies Readonly<Record<string, BreakClassSpec>>);

export type BreakClass = keyof typeof BREAK_TAXONOMY;

/** Every break class, in table order. */
export const BREAK_CLASSES: readonly BreakClass[] = Object.freeze(Object.keys(BREAK_TAXONOMY) as BreakClass[]);

export function isBreakClass(value: unknown): value is BreakClass {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(BREAK_TAXONOMY, value);
}

/** The rule of a break class. */
export function breakRule(breakClass: BreakClass): BreakRule {
  return BREAK_TAXONOMY[breakClass].rule;
}

/** Whether an operator may release a break of this rule. Ambiguity (HOLD) never is: only a later complete run clears it. */
export function isOperatorReleasable(rule: BreakRule): boolean {
  return rule === "QUARANTINE_UNTIL_RELEASED" || rule === "UNATTRIBUTED_HALT";
}

/** Whether a break of this rule is QUARANTINED as soon as it is opened. */
export function quarantinesOnOpen(rule: BreakRule): boolean {
  return rule === "QUARANTINE_UNTIL_RELEASED" || rule === "UNATTRIBUTED_HALT";
}

/**
 * The releasable classes whose subject is IMMUTABLE HISTORY: an order or a
 * trade the account's history keeps for good, a booking, one alert the OMS
 * raised (one occurrence: its OMS instance and ordinal, never its kind and
 * order alone), one trade's FAILED settlement (FAILED is "terminal failure":
 * `docs/venue/verified-2026-08-24.md`, the SDK's `TradeStatus`; ADR-006 §5),
 * one venue order id the venue's by-id read does not find, an operation that
 * never named a transaction. An operator's
 * release ACKNOWLEDGES such a subject: the same subject is not opened again
 * (new activity has new subjects, and opens new breaks).
 *
 * Every other releasable class is a LIVE CONTRADICTION (today:
 * `ORDER_FACTS_MISMATCH`, a comparison of current state). A release records
 * the operator's decision, but does not acknowledge the subject: every run
 * that still finds the contradiction opens it again, so it holds until a
 * fresh comparison shows the subject consistent.
 */
export const RELEASE_ACKNOWLEDGES_SUBJECT: ReadonlySet<BreakClass> = new Set<BreakClass>([
  "ORDER_UNATTRIBUTED",
  "TRADE_UNATTRIBUTED",
  "POSITION_UNATTRIBUTED",
  "BALANCE_UNATTRIBUTED",
  "LEDGER_UNATTRIBUTED_ARRIVAL",
  "SETTLEMENT_FAILED",
  "ORDER_NOT_FOUND_BY_ID",
  "OMS_HALTING_ALERT",
  "WALLET_OPERATION_UNIDENTIFIABLE",
]);

/** Whether an operator's release of this class acknowledges its subject for good (see {@link RELEASE_ACKNOWLEDGES_SUBJECT}). */
export function releaseAcknowledgesSubject(breakClass: BreakClass): boolean {
  return RELEASE_ACKNOWLEDGES_SUBJECT.has(breakClass) && isOperatorReleasable(breakRule(breakClass));
}
