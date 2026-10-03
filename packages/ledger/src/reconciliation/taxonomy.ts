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
 * table rather than of a caller's diligence.
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
    meaning: "the run's reads spanned more than the configured bound, or the clock went backwards during the run",
    handling: "the run is not trusted as one view of the account; submissions stay paused",
  },
  READ_CONFLICT: {
    family: "READ",
    rule: HOLD,
    meaning: "two reads of one run disagree about a fixed fact (an order's token, side, price or size; a trade's legs)",
    handling: "nothing about the subject is concluded; submissions stay paused",
  },
  READ_REGRESSION: {
    family: "READ",
    rule: HOLD,
    meaning: "a read shows an older state than an earlier read did (an out-of-order read: matched size down, terminal to open, settlement backwards)",
    handling: "the newer observation is kept; submissions stay paused until a read catches up",
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
    meaning: "more than one venue order could be the unknown attempt's, or one venue order could be more than one attempt's (no order hash exists: WP-270 STOPPED item)",
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
    meaning: "a tracked order's fixed facts (side, price, original size) differ at the venue",
    handling: "no answer is given; quarantined until released",
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
  // --- trades ----------------------------------------------------------------------------
  TRADE_UNATTRIBUTED: {
    family: "TRADE",
    rule: UNATTRIBUTED,
    meaning: "a trade of the account on an order that no tracked order and no unresolved attempt can own",
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
    meaning: "the ledger holds an UNATTRIBUTED arrival that no break records (e.g. a crash between the booking and the journal)",
    handling: "the halt obligation is recovered from the ledger: the market is halted; quarantined until released",
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
    meaning: "the OMS raised an alert that halts a market (an evidence conflict, an unknown venue order, a failed settlement, ...)",
    handling: "the market is halted; quarantined until released",
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
