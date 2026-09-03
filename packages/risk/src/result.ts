/**
 * Typed results and refusals (handoff §21: "Errors are typed and observable").
 *
 * A refusal is DATA (repository pattern: `@polymarket-bot/settlement`,
 * `@polymarket-bot/universe`, `@polymarket-bot/order-book`,
 * `@polymarket-bot/capital-allocator`): the engine answers "no" by returning
 * every reason with its evidence. Nothing here logs or throws for a
 * recoverable condition.
 */

import { describeValue } from "./plain-data.js";
import type { RiskReasonCode } from "./reasons.js";

export type RiskRefusalDetails = Readonly<Record<string, unknown>>;

/** One refusal, with its machine-readable code and evidence. */
export interface RiskRefusal {
  readonly code: RiskReasonCode;
  /** Bounded human-readable text; never parsed. */
  readonly message: string;
  readonly details: RiskRefusalDetails;
}

export function riskRefusal(
  code: RiskReasonCode,
  message: string,
  details: RiskRefusalDetails = {},
): RiskRefusal {
  return Object.freeze({ code, message, details: Object.freeze({ ...details }) });
}

/** A successful result, or the refusals that prevented it. */
export type RiskResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusals: readonly RiskRefusal[] };

export function riskOk<T>(value: T): RiskResult<T> {
  return { ok: true, value };
}

export function riskFailure<T>(...refusals: readonly RiskRefusal[]): RiskResult<T> {
  return { ok: false, refusals: Object.freeze([...refusals]) };
}

/**
 * THE OUTER CONTAINMENT GUARD (review round 5).
 *
 * Every public entry point of this package promises a typed result. Review
 * rounds 4 and 5 each found one way an exception got out anyway — a getter
 * `Object.entries` invoked, then a `@@toPrimitive` invoked while BUILDING a
 * refusal, then a getter invoked by `zod` while parsing a caller's object. Each
 * was fixed at its site, and each was found by a reviewer rather than by us.
 *
 * So totality no longer rests on having found every site. It is a property of
 * the entry points themselves: whatever happens inside, the caller gets a
 * refusal. `onThrow` supplies the shape of that refusal, because the two public
 * result types in this package (`RiskResult` and `RiskEvaluation`) differ.
 *
 * WHAT THIS COSTS, STATED PLAINLY. A genuine implementation bug inside this
 * package now becomes a typed refusal rather than a crash, which is a real loss
 * of signal. It is accepted because the alternative is worse in the direction
 * that matters here: this engine's answers gate order placement, and a caller
 * that receives an exception where the contract promises a refusal has no
 * defined behaviour at all. The refusal carries only the THROWN VALUE'S TYPE —
 * never its message, and never a coercion of it, because reading `.message` or
 * `.name` off a caller-supplied thrown object is one more place caller code can
 * run.
 */
export function contained<T>(body: () => T, onThrow: (thrown: string) => T): T {
  try {
    return body();
  } catch (error) {
    return onThrow(describeValue(error));
  }
}
