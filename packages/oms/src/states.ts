/**
 * The OMS state machines (handoff §9.11; ADR-007 §1), every transition explicit.
 *
 * THREE MACHINES, KEPT SEPARATE (§6 invariant 5: "Order state and settlement
 * state are separate"):
 *
 * - the ORDER state (§9.11), one per order row (`execution.orders.state`,
 *   `internal.order_state`);
 * - the SUBMISSION-ATTEMPT state (`execution.submission_attempts.state`,
 *   `internal.submission_state`: `SIGNED`, `SENDING`, `RESPONDED`,
 *   `SUBMISSION_UNKNOWN`, `RECONCILING`, `ABANDONED`), one per signed order;
 * - the TRADE SETTLEMENT state (§9.11), one per fill
 *   (`execution.trade_settlements.state`).
 *
 * A transition that is not in a table is refused (`OMS_ILLEGAL_TRANSITION`).
 * Evidence the manager cannot classify never selects a state by assumption: it
 * sends a non-terminal order to `RECONCILING` and a placement to
 * `SUBMISSION_UNKNOWN` (ADR-007 §3, §6).
 */

export const ORDER_STATES = [
  "PLANNED",
  "SIGNED",
  "SENDING",
  "ACKNOWLEDGED",
  "LIVE",
  "DELAYED",
  "PARTIALLY_FILLED",
  "FILLED",
  "CANCEL_PENDING",
  "CANCELED",
  "REJECTED",
  "SUBMISSION_UNKNOWN",
  "RECONCILING",
  "EXPIRED",
] as const;

export type OrderState = (typeof ORDER_STATES)[number];

/** Terminal order states. Each may be reopened only to `RECONCILING`, on contradicting evidence. */
export const TERMINAL_ORDER_STATES: ReadonlySet<OrderState> = new Set<OrderState>(["FILLED", "CANCELED", "REJECTED", "EXPIRED"]);

/**
 * The order transition table. Self-transitions are listed only where an event
 * may leave the state unchanged on purpose (`PARTIALLY_FILLED` on a further
 * partial fill, `RECONCILING` on a fresh request).
 *
 * - `PLANNED → CANCELED` and `SIGNED → CANCELED`: abandoned before any
 *   transmission (nothing reached the venue).
 * - `SENDING → REJECTED`: a definitive non-placement (a venue rejection, a
 *   documented refusal, or nothing left the process).
 * - `SENDING → SUBMISSION_UNKNOWN`: the response is lost or cannot be
 *   classified (§9.11 step 7).
 * - `SUBMISSION_UNKNOWN → RECONCILING`: an authoritative read was requested
 *   (§9.11 step 8).
 * - `RECONCILING → SENDING`: the documented same-signed-order resubmission
 *   only (§9.11 step 9; see `order-manager.ts`, "RETRANSMISSION").
 * - `RECONCILING → REJECTED`: authoritatively absent.
 * - `CANCEL_PENDING → ACKNOWLEDGED | LIVE | DELAYED | PARTIALLY_FILLED |
 *   RECONCILING`: the cancel was not applied, or its effect is unknown.
 * - terminal `→ RECONCILING`: contradicting evidence reopens the order; it is
 *   never left untracked while the venue may still hold it.
 */
export const ORDER_TRANSITIONS: Readonly<Record<OrderState, readonly OrderState[]>> = Object.freeze({
  PLANNED: ["SIGNED", "CANCELED"],
  SIGNED: ["SENDING", "CANCELED"],
  SENDING: ["ACKNOWLEDGED", "LIVE", "DELAYED", "REJECTED", "SUBMISSION_UNKNOWN"],
  ACKNOWLEDGED: ["LIVE", "DELAYED", "PARTIALLY_FILLED", "FILLED", "CANCEL_PENDING", "CANCELED", "EXPIRED", "RECONCILING"],
  LIVE: ["PARTIALLY_FILLED", "FILLED", "CANCEL_PENDING", "CANCELED", "EXPIRED", "RECONCILING"],
  DELAYED: ["LIVE", "PARTIALLY_FILLED", "FILLED", "CANCEL_PENDING", "CANCELED", "REJECTED", "EXPIRED", "RECONCILING"],
  PARTIALLY_FILLED: ["PARTIALLY_FILLED", "FILLED", "CANCEL_PENDING", "CANCELED", "EXPIRED", "RECONCILING"],
  CANCEL_PENDING: [
    "ACKNOWLEDGED",
    "LIVE",
    "DELAYED",
    "PARTIALLY_FILLED",
    "FILLED",
    "CANCELED",
    "EXPIRED",
    "RECONCILING",
  ],
  SUBMISSION_UNKNOWN: ["RECONCILING"],
  RECONCILING: [
    "RECONCILING",
    "SENDING",
    "ACKNOWLEDGED",
    "LIVE",
    "DELAYED",
    "PARTIALLY_FILLED",
    "FILLED",
    "CANCEL_PENDING",
    "CANCELED",
    "REJECTED",
    "EXPIRED",
  ],
  FILLED: ["RECONCILING"],
  CANCELED: ["RECONCILING"],
  REJECTED: ["RECONCILING"],
  EXPIRED: ["RECONCILING"],
});

export function isLegalOrderTransition(from: OrderState, to: OrderState): boolean {
  return ORDER_TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------------------
// Submission attempts.

export const ATTEMPT_STATES = ["SIGNED", "SENDING", "RESPONDED", "SUBMISSION_UNKNOWN", "RECONCILING", "ABANDONED"] as const;

export type AttemptState = (typeof ATTEMPT_STATES)[number];

/**
 * - `SIGNED → ABANDONED`: never transmitted (the durable `SENDING` mark is
 *   written before every transmission, so `SIGNED` proves no transmission).
 * - `SENDING → RESPONDED`: a definitive placement response (accepted,
 *   rejected, or a documented refusal).
 * - `SENDING → ABANDONED`: the port reports that nothing left the process.
 * - `SENDING → SUBMISSION_UNKNOWN`: lost or unclassifiable (§9.11 step 7).
 * - `RECONCILING → RESPONDED`: an authoritative read found the order.
 * - `RECONCILING → ABANDONED`: an authoritative read found it absent.
 * - `RECONCILING → SENDING`: the documented resubmission of the same signed
 *   order (no new salt).
 * - `SUBMISSION_UNKNOWN → RESPONDED`: a late acceptance (after a watchdog
 *   timeout) proves the order exists.
 * - `ABANDONED` and `RESPONDED` are final for the attempt. Later evidence about
 *   its order moves the ORDER (to RECONCILING), never the attempt.
 */
export const ATTEMPT_TRANSITIONS: Readonly<Record<AttemptState, readonly AttemptState[]>> = Object.freeze({
  SIGNED: ["SENDING", "ABANDONED"],
  SENDING: ["RESPONDED", "ABANDONED", "SUBMISSION_UNKNOWN"],
  SUBMISSION_UNKNOWN: ["RECONCILING", "RESPONDED"],
  RECONCILING: ["RECONCILING", "RESPONDED", "ABANDONED", "SENDING"],
  RESPONDED: [],
  ABANDONED: [],
});

export function isLegalAttemptTransition(from: AttemptState, to: AttemptState): boolean {
  return ATTEMPT_TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------------------
// Trade settlement.

export const SETTLEMENT_STATES = ["MATCHED", "MINED", "CONFIRMED", "RETRYING", "FAILED"] as const;

export type SettlementState = (typeof SETTLEMENT_STATES)[number];

/** `CONFIRMED` is terminal success and `FAILED` terminal failure (venue report §4; ADR-006 §5). */
export const TERMINAL_SETTLEMENT_STATES: ReadonlySet<SettlementState> = new Set<SettlementState>(["CONFIRMED", "FAILED"]);

/**
 * Forward settlement transitions. The first observation of a trade may be any
 * state: stream messages can be missed (venue report §4: real-time updates do
 * not replay what was missed), so a trade first seen as `MINED` is not an
 * anomaly. A transition to an earlier state is a stale delivery
 * (`OMS_SETTLEMENT_REGRESSION`); `CONFIRMED` against `FAILED`, either order, is
 * a conflict (`OMS_SETTLEMENT_CONFLICT`).
 */
export const SETTLEMENT_TRANSITIONS: Readonly<Record<SettlementState, readonly SettlementState[]>> = Object.freeze({
  MATCHED: ["MINED", "CONFIRMED", "RETRYING", "FAILED"],
  MINED: ["CONFIRMED", "RETRYING", "FAILED"],
  RETRYING: ["MINED", "CONFIRMED", "FAILED"],
  CONFIRMED: [],
  FAILED: [],
});

export function isLegalSettlementTransition(from: SettlementState, to: SettlementState): boolean {
  return SETTLEMENT_TRANSITIONS[from].includes(to);
}

export function isOrderState(value: unknown): value is OrderState {
  return typeof value === "string" && (ORDER_STATES as readonly string[]).includes(value);
}

export function isAttemptState(value: unknown): value is AttemptState {
  return typeof value === "string" && (ATTEMPT_STATES as readonly string[]).includes(value);
}

export function isSettlementState(value: unknown): value is SettlementState {
  return typeof value === "string" && (SETTLEMENT_STATES as readonly string[]).includes(value);
}
