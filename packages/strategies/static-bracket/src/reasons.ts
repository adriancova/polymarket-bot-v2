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

  // holding and exit
  allocated: "SB.ALLOCATION_CONFIRMED",
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

  // end of market
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
