/**
 * The strategy's reason-code and tag vocabulary.
 *
 * A strategy does not log (§7.5, ADR-005 §1): what it has to say about a
 * decision it says in `reasonCodes`, which the runtime persists and §14.3
 * aggregates. Every code here satisfies the frozen `CodeString` grammar
 * (`^[A-Za-z][A-Za-z0-9_.:-]*$`, at most 64 characters) and none uses the
 * `RUNTIME.` prefix, which ADR-005 §3 reserves for runtime attribution — a
 * strategy impersonating the runtime would make decision analytics lie.
 *
 * The `SB.` prefix namespaces this strategy inside a process that will run
 * several. Codes are stable identifiers: renaming one is a change to the
 * analytics surface, not a cosmetic edit.
 */

export const REASONS = {
  // lifecycle
  started: "SB.STARTED",
  armed: "SB.ARMED",
  marketOpen: "SB.MARKET_OPEN",
  idle: "SB.IDLE",
  stopped: "SB.STOPPED",
  rearmed: "SB.REARMED",

  // entry
  entryTriggerMet: "SB.ENTRY_TRIGGER_MET",
  entryTriggerNotMet: "SB.ENTRY_TRIGGER_NOT_MET",
  entryIntentEmitted: "SB.ENTRY_INTENT_EMITTED",
  entryLegDirect: "SB.ENTRY_LEG_DIRECT",
  entryLegComplement: "SB.ENTRY_LEG_COMPLEMENT",
  entryLegComplementUnavailable: "SB.ENTRY_LEG_COMPLEMENT_NO_INVENTORY",
  entryOrderWorking: "SB.ENTRY_ORDER_WORKING",
  entryEscalated: "SB.ENTRY_CONVERTED_TO_AGGRESSIVE",
  entryOrderTerminal: "SB.ENTRY_ORDER_TERMINAL",
  entrySubmissionUnknown: "SB.ENTRY_SUBMISSION_UNKNOWN",
  entryAwaitingReconciliation: "SB.AWAITING_RECONCILIATION",
  entryReconciled: "SB.ENTRY_RECONCILED",
  /**
   * An ORDER VIEW reported a filled size the fill stream has not yet delivered
   * (§8.1 orders neither before the other). The execution is real, so the
   * instance neither re-enters nor sizes anything from the view: it waits.
   */
  awaitingFillAllocation: "SB.AWAITING_FILL_ALLOCATION",
  /**
   * A repeated order view for an order this instance already tracks as
   * TERMINAL. §8.1 promises no at-most-once delivery, so a second `FILLED`
   * view is ordinary traffic, not a contradiction: the evidence is folded and
   * the sub-machine is not consulted (a terminal state has no outgoing edge,
   * and asking it for one used to HALT the instance with an open position).
   */
  terminalOrderViewAbsorbed: "SB.TERMINAL_ORDER_VIEW_ABSORBED",

  // entry refusals
  refusedCostCap: "SB.REFUSED_MAXIMUM_TOTAL_COST",
  refusedPositionCap: "SB.REFUSED_MAXIMUM_POSITION_SHARES",
  refusedContractualLoss: "SB.REFUSED_MAXIMUM_CONTRACTUAL_LOSS",
  refusedSlippage: "SB.REFUSED_MAXIMUM_SLIPPAGE",
  refusedParticipation: "SB.REFUSED_BOOK_PARTICIPATION",
  refusedEdge: "SB.REFUSED_INSUFFICIENT_NET_EDGE",
  refusedMinimumOrderSize: "SB.REFUSED_BELOW_MINIMUM_ORDER_SIZE",
  refusedTickGrid: "SB.REFUSED_PRICE_OFF_TICK_GRID",
  refusedEntryCutoff: "SB.REFUSED_ENTRY_CUTOFF",
  refusedMaxEntries: "SB.REFUSED_MAXIMUM_ENTRIES",
  refusedCooldown: "SB.REFUSED_COOLDOWN",
  refusedTriggerUnusable: "SB.REFUSED_TRIGGER_UNUSABLE",
  refusedTriggerAbsent: "SB.REFUSED_TRIGGER_ABSENT",
  /**
   * An entry was refused because this instance still has an order in flight.
   * Structural, not economic: the risk caps happened to answer these shapes
   * before, which made the refusal a coincidence rather than a rule.
   */
  refusedOrderInFlight: "SB.REFUSED_ORDER_IN_FLIGHT",

  // holding and exit
  allocated: "SB.ALLOCATION_CONFIRMED",
  /**
   * A CONFIRMED fill folded into the allocation while the instance was PAUSED.
   * Settlement accounting is not a state transition (§6 invariant 5): the
   * allocation is updated, the instance stays PAUSED, and no intent is emitted
   * until it resumes. Discarding the fill instead left the instance believing
   * it held nothing while it held the position (§6 invariant 10).
   */
  fillFoldedWhilePaused: "SB.FILL_FOLDED_WHILE_PAUSED",
  exitProportional: "SB.EXIT_SIZED_TO_ALLOCATION",
  takeProfitPlaced: "SB.TAKE_PROFIT_INTENT",
  takeProfitReplaced: "SB.TAKE_PROFIT_REPLACED",
  stopTriggered: "SB.STOP_TRIGGERED",
  stopNotTriggered: "SB.STOP_NOT_TRIGGERED",
  holdingTimeout: "SB.HOLDING_TIMEOUT",
  exitCutoff: "SB.EXIT_CUTOFF",
  exitOrderWorking: "SB.EXIT_ORDER_WORKING",
  exitOrderTerminal: "SB.EXIT_ORDER_TERMINAL",
  exitFilled: "SB.EXIT_FILLED",
  closed: "SB.CLOSED",
  /**
   * A protective reduction placed by the STOP or the HOLDING TIMEOUT
   * (`BRACKET-1a`, D8). Until then every protective reduction reported
   * `SB.FINAL_PROTECTED_REDUCE`, which names the end-of-market policy; that
   * code now marks the close-cutoff reduction only, so the decision log says
   * which kind of cause placed the order (the cause itself is still
   * `SB.STOP_TRIGGERED` / `SB.HOLDING_TIMEOUT` / `SB.EXIT_CUTOFF` beside it).
   */
  protectedReduce: "SB.PROTECTED_REDUCE",
  /**
   * A protective reduction nothing ever answered was RETIRED (`BRACKET-1a`,
   * ruling R2): its intent's own `validUntil` has passed and no order view and
   * no fill ever named it, so no order can exist for it any more — risk and the
   * planner both refuse an expired intent. The track is cleared through the
   * existing `EXIT_ABANDONED` edge and the ladder may plan one reduction for
   * the new validity window.
   */
  exitIntentExpired: "SB.EXIT_INTENT_EXPIRED",
  /**
   * A protective reduction has been silent for `submission_unknown_after_ms`:
   * `PENDING --SILENCE_EXCEEDED--> SUBMISSION_UNKNOWN`, reported as the entry's
   * `SB.ENTRY_SUBMISSION_UNKNOWN` is (§6 invariant 6: unknown is never a
   * rejection, so nothing is re-sent) — `BRACKET-1a`, ruling R2.
   */
  exitSubmissionUnknown: "SB.EXIT_SUBMISSION_UNKNOWN",
  /**
   * An EXIT order in `SUBMISSION_UNKNOWN` was found by a view — the exit twin
   * of `SB.ENTRY_RECONCILED`, which it used to borrow (an exit could not be
   * unknown before `BRACKET-1a`).
   */
  exitReconciled: "SB.EXIT_RECONCILED",

  // end of market
  /**
   * The END-OF-MARKET protective reduction (§13.2 `final_policy:
   * PROTECTED_REDUCE`, inside `exit_cutoff_before_close_seconds`). Since
   * `BRACKET-1a` a stop or a holding-timeout reduction reports
   * `SB.PROTECTED_REDUCE` instead.
   */
  finalProtectedReduce: "SB.FINAL_PROTECTED_REDUCE",
  finalHoldToResolution: "SB.FINAL_HOLD_TO_RESOLUTION",
  finalCancelOnly: "SB.FINAL_CANCEL_ONLY",
  resolutionHoldAllowed: "SB.RESOLUTION_HOLD_ALLOWED",
  resolutionHoldDisallowed: "SB.RESOLUTION_HOLD_DISALLOWED",
  resolvedWhileOpen: "SB.RESOLVED_WHILE_OPEN",
  marketClosed: "SB.MARKET_CLOSED",

  // data quality and safety
  staleBook: "SB.STALE_BOOK",
  dataQualityIncident: "SB.DATA_QUALITY_INCIDENT",
  incidentPolicyFirst: "SB.INCIDENT_POLICY_FIRST",
  stopSuppressedStaleData: "SB.STOP_SUPPRESSED_STALE_DATA",
  noBlindFlatten: "SB.NO_BLIND_FLATTEN",
  paused: "SB.PAUSED",
  resumed: "SB.RESUMED",
  safetyCancel: "SB.SAFETY_CANCEL",
  awaitingCancel: "SB.AWAITING_CANCEL_CONFIRMATION",
  positionMismatch: "SB.POSITION_MISMATCH",
  unattributedFill: "SB.UNATTRIBUTED_FILL",
  halted: "SB.HALTED",
  stateUnreadable: "SB.STATE_UNREADABLE",
  paramsUnreadable: "SB.PARAMS_UNREADABLE",
  viewUnusable: "SB.VIEW_UNUSABLE",
  illegalTransition: "SB.ILLEGAL_TRANSITION",
  tickSizeChanged: "SB.TICK_SIZE_CHANGED",
  internalRefusal: "SB.INTERNAL_REFUSAL",
} as const;

export type Reason = (typeof REASONS)[keyof typeof REASONS];

/** Tags carried on emitted intents (§7.7 `tags`; the same `CodeString` grammar). */
export const TAGS = {
  strategy: "static-bracket",
  entry: "sb.entry",
  takeProfit: "sb.take-profit",
  /** Carried by every protected reduction, whatever triggered it. */
  protectedReduce: "sb.protected-reduce",
  stop: "sb.stop",
  final: "sb.final",
} as const;

/** Tag naming the configured venue order type, e.g. `sb.order-type:FAK`. */
export function orderTypeTag(orderType: string): string {
  return `sb.order-type:${orderType}`;
}

/** Tag naming the outcome leg an intent trades, e.g. `sb.leg:YES`. */
export function legTag(outcome: string): string {
  return `sb.leg:${outcome}`;
}
