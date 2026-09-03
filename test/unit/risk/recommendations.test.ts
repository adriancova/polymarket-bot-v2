/**
 * Incident action RECOMMENDATIONS — never actions (handoff §9.9).
 *
 * "The Incident Controller—not the ordinary risk gate—originates operational
 * safety actions." This package emits typed data for that controller and
 * executes nothing, so the tests assert both halves: the §9.9 default-action
 * table is reproduced row for row, and every emitted value is branded as a
 * recommendation with no execution surface attached.
 */

import { describe, expect, it } from "vitest";

import {
  INCIDENT_ACTION_LADDER,
  INCIDENT_FAILURE_CLASSES,
  recommendIncidentActions,
} from "../../../packages/risk/src/index.js";
import { MARKET_A } from "./fixtures.js";

describe("the §9.9 action ladder", () => {
  it("is reproduced verbatim and in order", () => {
    expect([...INCIDENT_ACTION_LADDER]).toEqual([
      "HALT_NEW_ENTRIES",
      "CANCEL_RESTING_ORDERS",
      "RECONCILE_ACCOUNT",
      "MANAGE_KNOWN_POSITIONS_ONLY",
      "PROTECTED_REDUCE",
      "HOLD_TO_RESOLUTION",
      "FULL_HALT",
    ]);
  });
});

describe("the §9.9 failure → default action table", () => {
  const expected: Record<string, readonly string[]> = {
    // "External reference feed stale, Polymarket healthy | Cancel
    //  signal-dependent quotes; halt new entries"
    REFERENCE_FEED_STALE_VENUE_HEALTHY: ["CANCEL_RESTING_ORDERS", "HALT_NEW_ENTRIES"],
    // "Polymarket book stale | Cancel resting orders; no blind aggressive orders"
    VENUE_BOOK_STALE: ["CANCEL_RESTING_ORDERS"],
    // "User stream lost, REST healthy | Pause submissions; reconcile through REST"
    USER_STREAM_LOST_REST_HEALTHY: ["HALT_NEW_ENTRIES", "RECONCILE_ACCOUNT"],
    // "Submission response lost | Reconcile using persisted signed order/order hash"
    SUBMISSION_RESPONSE_LOST: ["RECONCILE_ACCOUNT"],
    // "Position known near close | Apply configured protected exit or explicit
    //  resolution-hold policy"
    POSITION_KNOWN_NEAR_CLOSE: ["PROTECTED_REDUCE", "HOLD_TO_RESOLUTION"],
    // "Account state unknown | Stop heartbeat, cancel, reconcile, full halt"
    ACCOUNT_STATE_UNKNOWN: ["CANCEL_RESTING_ORDERS", "RECONCILE_ACCOUNT", "FULL_HALT"],
    // §6 invariant 12: "cancel and reconciliation before any protected reduction"
    POSITION_STATE_UNKNOWN: ["CANCEL_RESTING_ORDERS", "RECONCILE_ACCOUNT"],
  };

  for (const failureClass of INCIDENT_FAILURE_CLASSES) {
    it(`${failureClass} maps to its handoff row`, () => {
      const recommendations = recommendIncidentActions(failureClass, MARKET_A);
      expect(recommendations.map((r) => r.action)).toEqual(expected[failureClass]);
      expect(recommendations.every((r) => r.failureClass === failureClass)).toBe(true);
    });
  }

  it("covers every declared failure class", () => {
    expect(Object.keys(expected).sort()).toEqual([...INCIDENT_FAILURE_CLASSES].sort());
  });

  it("never recommends a blind reduction for a stale book", () => {
    const actions = recommendIncidentActions("VENUE_BOOK_STALE", MARKET_A).map((r) => r.action);
    expect(actions).not.toContain("PROTECTED_REDUCE");
    expect(actions).not.toContain("HOLD_TO_RESOLUTION");
  });
});

describe("a recommendation is data, not an action", () => {
  it("is branded, frozen, and carries only descriptive fields", () => {
    const recommendations = recommendIncidentActions("ACCOUNT_STATE_UNKNOWN");
    expect(recommendations.length).toBeGreaterThan(0);
    for (const recommendation of recommendations) {
      expect(recommendation.kind).toBe("RECOMMENDATION");
      expect(Object.isFrozen(recommendation)).toBe(true);
      // No callable surface: nothing here can be invoked to perform the action.
      for (const value of Object.values(recommendation)) {
        expect(typeof value).not.toBe("function");
      }
    }
  });

  it("omits marketId when the recommendation is account-scoped", () => {
    const accountScoped = recommendIncidentActions("ACCOUNT_STATE_UNKNOWN", MARKET_A);
    expect(accountScoped.every((r) => r.ordersScope === "ACCOUNT")).toBe(true);
    expect(accountScoped.every((r) => r.marketId === undefined)).toBe(true);
  });

  it("quotes the handoff row it reproduces", () => {
    const [first] = recommendIncidentActions("SUBMISSION_RESPONSE_LOST");
    expect(first?.rationale).toContain("§9.9");
  });
});
