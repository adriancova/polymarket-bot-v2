/**
 * The handoff §9.13 priority ladder (WP-310 deliverable 1; §6 invariant 13,
 * "Safety cancellation outranks new order placement. Rate-limit scheduling
 * reflects this priority"; ADR-007 §9).
 *
 * The ladder is ARCHITECTURE, not a venue limit: it is the handoff's text, in
 * its order, and it is the only ordering the budget grants by. Index 0 is
 * served first. Nothing here is a number the venue publishes.
 *
 * | Rank | Class | Handoff §9.13 text |
 * | --- | --- | --- |
 * | 1 | `ORDER_HEARTBEAT` | Order heartbeat |
 * | 2 | `EMERGENCY_CANCEL` | Emergency cancel and cancel-all |
 * | 3 | `RECONCILIATION_READ` | Reconciliation and account-truth reads |
 * | 4 | `RISK_REDUCING_ORDER` | Risk-reducing orders |
 * | 5 | `STALE_QUOTE_CANCEL` | Stale quote cancellation |
 * | 6 | `NEW_ORDER` | New orders |
 * | 7 | `METADATA_ANALYTICS` | Metadata refresh and analytics |
 *
 * A request names its class; the class must be one its operation's kind
 * permits ({@link PERMITTED_PRIORITIES}), so a new order can never borrow a
 * safety class's rank, and a cancel can never be filed as a new order.
 */

export const PRIORITY_LADDER = Object.freeze([
  "ORDER_HEARTBEAT",
  "EMERGENCY_CANCEL",
  "RECONCILIATION_READ",
  "RISK_REDUCING_ORDER",
  "STALE_QUOTE_CANCEL",
  "NEW_ORDER",
  "METADATA_ANALYTICS",
] as const);

export type PriorityClass = (typeof PRIORITY_LADDER)[number];

/**
 * What an operation does at the venue. Each configured operation declares
 * one; the kind decides which priority classes may be filed for it.
 */
export const OPERATION_KINDS = Object.freeze(["HEARTBEAT", "CANCEL", "READ", "PLACEMENT", "RELAYER"] as const);

export type OperationKind = (typeof OPERATION_KINDS)[number];

/**
 * The classes each kind may be filed under. A placement is risk-reducing or
 * new; a cancel is an emergency (or cancel-all) or a stale-quote cleanup; a
 * read is reconciliation/account truth or metadata/analytics. A relayer
 * submission (a wallet operation) is risk-reducing or routine, like a
 * placement: §9.13 names the relayer as a budget, not as a rank.
 */
export const PERMITTED_PRIORITIES: Readonly<Record<OperationKind, readonly PriorityClass[]>> = Object.freeze({
  HEARTBEAT: Object.freeze(["ORDER_HEARTBEAT"] as const),
  CANCEL: Object.freeze(["EMERGENCY_CANCEL", "STALE_QUOTE_CANCEL"] as const),
  READ: Object.freeze(["RECONCILIATION_READ", "METADATA_ANALYTICS"] as const),
  PLACEMENT: Object.freeze(["RISK_REDUCING_ORDER", "NEW_ORDER"] as const),
  RELAYER: Object.freeze(["RISK_REDUCING_ORDER", "NEW_ORDER"] as const),
});

export function isPriorityClass(value: unknown): value is PriorityClass {
  return typeof value === "string" && (PRIORITY_LADDER as readonly string[]).includes(value);
}

export function isOperationKind(value: unknown): value is OperationKind {
  return typeof value === "string" && (OPERATION_KINDS as readonly string[]).includes(value);
}

/** The class's position on the ladder; a smaller rank is served first. */
export function priorityRank(priority: PriorityClass): number {
  return PRIORITY_LADDER.indexOf(priority);
}

export function isPermittedPriority(kind: OperationKind, priority: PriorityClass): boolean {
  return PERMITTED_PRIORITIES[kind].includes(priority);
}
