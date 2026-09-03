/**
 * Reserved runtime-attributed reason codes (ADR-005 §3).
 *
 * When the runtime contains a failed evaluation (throw, watchdog timeout,
 * invalid decision, invalid state patch), it persists exactly one decision
 * record "attributed to the runtime rather than to the strategy, carrying a
 * `skip` decision type, a reserved reason code, and no intents". These are the
 * reserved codes. Every value satisfies the frozen `CodeString` grammar
 * (`docs/contracts/domain.md` §7: `^[A-Za-z][A-Za-z0-9_.:-]*$`, ≤ 64 chars).
 *
 * The `RUNTIME.` prefix is reserved in BOTH directions: a strategy-returned
 * `DecisionResult` whose `reasonCodes` use it is refused as an invalid
 * decision, because ADR-005 §3 forbids attributing a runtime action to the
 * strategy — and the mirror (a strategy impersonating the runtime) would make
 * decision analytics (§14.3) lie the same way.
 */

export const RESERVED_RUNTIME_REASON_CODE_PREFIX = "RUNTIME.";

export const RUNTIME_REASON_CODES = {
  /** The callback threw before returning a decision. */
  callbackThrew: "RUNTIME.CALLBACK_THREW",
  /** The callback exceeded the evaluation-time watchdog budget (§9.6). */
  watchdogTimeout: "RUNTIME.WATCHDOG_TIMEOUT",
  /** The returned value is not a valid §7.5 `DecisionResult` for this evaluation. */
  decisionInvalid: "RUNTIME.DECISION_INVALID",
  /** The returned `statePatch` is not checkpointable JSON. */
  statePatchInvalid: "RUNTIME.STATE_PATCH_INVALID",
  /**
   * The injected `MonotonicClock` failed AFTER the callback had run, so the
   * elapsed time — and therefore whether the watchdog budget was met — is
   * unknown (remediation round 3). The evaluation happened, so §6 invariant 3
   * binds and exactly one record is persisted; it is attributed to the RUNTIME
   * because the failure is the host's, not the strategy's.
   */
  clockInvalid: "RUNTIME.CLOCK_INVALID",
} as const;

export type ReservedRuntimeReasonCode =
  (typeof RUNTIME_REASON_CODES)[keyof typeof RUNTIME_REASON_CODES];

/**
 * True when a reason code is reserved for runtime attribution.
 *
 * The `string` parameter is a type, not a guarantee: this is a public export
 * and JavaScript callers exist. A non-string is not a reserved code, and
 * answering `false` is honest — `code.startsWith` on a non-string would throw
 * out of a predicate (remediation round 3, the P2 sweep).
 */
export function isReservedRuntimeReasonCode(code: string): boolean {
  return typeof code === "string" && code.startsWith(RESERVED_RUNTIME_REASON_CODE_PREFIX);
}
