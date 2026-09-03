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
} as const;

export type ReservedRuntimeReasonCode =
  (typeof RUNTIME_REASON_CODES)[keyof typeof RUNTIME_REASON_CODES];

/** True when a reason code is reserved for runtime attribution. */
export function isReservedRuntimeReasonCode(code: string): boolean {
  return code.startsWith(RESERVED_RUNTIME_REASON_CODE_PREFIX);
}
