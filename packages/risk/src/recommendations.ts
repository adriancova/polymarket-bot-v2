/**
 * Incident action RECOMMENDATIONS — WP-180 deliverable "incident action
 * recommendations".
 *
 * THIS PACKAGE EXECUTES NOTHING. It owns no connection, cancels no order,
 * touches no account. "The Incident Controller — not the ordinary risk gate —
 * originates operational safety actions" (handoff §9.9); that controller is a
 * LATER package. What this module emits is typed DATA — a recommendation the
 * controller will consume — and every value is branded `kind:
 * "RECOMMENDATION"` so no consumer can mistake it for an executed action.
 *
 * The action vocabulary is exactly the §9.9 action ladder, and the
 * failure-class mapping below reproduces the §9.9 default-action table row by
 * row (rationales quote it). `POSITION_STATE_UNKNOWN` is added from §6
 * invariant 12 ("No blind flatten. Unknown position or book state causes
 * cancel and reconciliation before any protected reduction action"), which
 * binds this package directly when it refuses a reduction.
 */

import { deepFreeze } from "./guards.js";

/** The §9.9 action ladder, verbatim. */
export const INCIDENT_ACTION_LADDER = [
  "HALT_NEW_ENTRIES",
  "CANCEL_RESTING_ORDERS",
  "RECONCILE_ACCOUNT",
  "MANAGE_KNOWN_POSITIONS_ONLY",
  "PROTECTED_REDUCE",
  "HOLD_TO_RESOLUTION",
  "FULL_HALT",
] as const;
export type IncidentAction = (typeof INCIDENT_ACTION_LADDER)[number];

/** The failure classes this package can recommend for. */
export const INCIDENT_FAILURE_CLASSES = [
  /** §9.9: "External reference feed stale, Polymarket healthy". */
  "REFERENCE_FEED_STALE_VENUE_HEALTHY",
  /** §9.9: "Polymarket book stale". */
  "VENUE_BOOK_STALE",
  /** §9.9: "User stream lost, REST healthy". */
  "USER_STREAM_LOST_REST_HEALTHY",
  /** §9.9: "Submission response lost". */
  "SUBMISSION_RESPONSE_LOST",
  /** §9.9: "Position known near close". */
  "POSITION_KNOWN_NEAR_CLOSE",
  /** §9.9: "Account state unknown". */
  "ACCOUNT_STATE_UNKNOWN",
  /** §6 invariant 12: unknown position state. */
  "POSITION_STATE_UNKNOWN",
] as const;
export type IncidentFailureClass = (typeof INCIDENT_FAILURE_CLASSES)[number];

export type RecommendationOrdersScope = "SIGNAL_DEPENDENT_QUOTES" | "MARKET" | "ACCOUNT";

/** A typed recommendation. NEVER an action; the §9.9 controller consumes it. */
export interface IncidentActionRecommendation {
  /** Always the literal `"RECOMMENDATION"`. */
  readonly kind: "RECOMMENDATION";
  readonly action: IncidentAction;
  readonly failureClass: IncidentFailureClass;
  readonly ordersScope: RecommendationOrdersScope;
  readonly marketId?: string;
  /** Quotes the handoff row this recommendation reproduces. Never parsed. */
  readonly rationale: string;
}

function recommendation(
  action: IncidentAction,
  failureClass: IncidentFailureClass,
  ordersScope: RecommendationOrdersScope,
  rationale: string,
  marketId?: string,
): IncidentActionRecommendation {
  return {
    kind: "RECOMMENDATION",
    action,
    failureClass,
    ordersScope,
    ...(marketId === undefined ? {} : { marketId }),
    rationale,
  };
}

/**
 * The §9.9 default actions for one failure class, as recommendations.
 * Exhaustive over {@link IncidentFailureClass}; a class this switch does not
 * know cannot exist at the type level, and the runtime default fails closed
 * to the bottom of the ladder rather than to silence.
 */
export function recommendIncidentActions(
  failureClass: IncidentFailureClass,
  marketId?: string,
): readonly IncidentActionRecommendation[] {
  switch (failureClass) {
    case "REFERENCE_FEED_STALE_VENUE_HEALTHY":
      return deepFreeze([
        recommendation(
          "CANCEL_RESTING_ORDERS",
          failureClass,
          "SIGNAL_DEPENDENT_QUOTES",
          '§9.9: "Cancel signal-dependent quotes; halt new entries"',
          marketId,
        ),
        recommendation(
          "HALT_NEW_ENTRIES",
          failureClass,
          "ACCOUNT",
          '§9.9: "Cancel signal-dependent quotes; halt new entries"',
        ),
      ]);
    case "VENUE_BOOK_STALE":
      return deepFreeze([
        recommendation(
          "CANCEL_RESTING_ORDERS",
          failureClass,
          "MARKET",
          '§9.9: "Cancel resting orders; no blind aggressive orders"',
          marketId,
        ),
      ]);
    case "USER_STREAM_LOST_REST_HEALTHY":
      return deepFreeze([
        recommendation(
          "HALT_NEW_ENTRIES",
          failureClass,
          "ACCOUNT",
          '§9.9: "Pause submissions; reconcile through REST"',
        ),
        recommendation(
          "RECONCILE_ACCOUNT",
          failureClass,
          "ACCOUNT",
          '§9.9: "Pause submissions; reconcile through REST"',
        ),
      ]);
    case "SUBMISSION_RESPONSE_LOST":
      return deepFreeze([
        recommendation(
          "RECONCILE_ACCOUNT",
          failureClass,
          "ACCOUNT",
          '§9.9: "Reconcile using persisted signed order/order hash" (§6 invariant 6: unknown submission state is never treated as rejection)',
        ),
      ]);
    case "POSITION_KNOWN_NEAR_CLOSE":
      return deepFreeze([
        recommendation(
          "PROTECTED_REDUCE",
          failureClass,
          "MARKET",
          '§9.9: "Apply configured protected exit or explicit resolution-hold policy" — the controller selects per configuration',
          marketId,
        ),
        recommendation(
          "HOLD_TO_RESOLUTION",
          failureClass,
          "MARKET",
          '§9.9: "Apply configured protected exit or explicit resolution-hold policy" — the controller selects per configuration',
          marketId,
        ),
      ]);
    case "ACCOUNT_STATE_UNKNOWN":
      return deepFreeze([
        recommendation(
          "CANCEL_RESTING_ORDERS",
          failureClass,
          "ACCOUNT",
          '§9.9: "Stop heartbeat, cancel, reconcile, full halt"',
        ),
        recommendation(
          "RECONCILE_ACCOUNT",
          failureClass,
          "ACCOUNT",
          '§9.9: "Stop heartbeat, cancel, reconcile, full halt"',
        ),
        recommendation(
          "FULL_HALT",
          failureClass,
          "ACCOUNT",
          '§9.9: "Stop heartbeat, cancel, reconcile, full halt"',
        ),
      ]);
    case "POSITION_STATE_UNKNOWN":
      return deepFreeze([
        recommendation(
          "CANCEL_RESTING_ORDERS",
          failureClass,
          "MARKET",
          '§6 invariant 12: "cancel and reconciliation before any protected reduction action"',
          marketId,
        ),
        recommendation(
          "RECONCILE_ACCOUNT",
          failureClass,
          "ACCOUNT",
          '§6 invariant 12: "cancel and reconciliation before any protected reduction action"',
        ),
      ]);
    default: {
      // Unreachable at the type level; fail closed to the ladder bottom.
      const exhaustive: never = failureClass;
      return deepFreeze([
        recommendation(
          "FULL_HALT",
          exhaustive as IncidentFailureClass,
          "ACCOUNT",
          "unknown failure class: fail closed to FULL_HALT",
        ),
      ]);
    }
  }
}
