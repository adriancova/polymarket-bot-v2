/**
 * Typed results and refusals (handoff §21: "Errors are typed and observable").
 *
 * A refusal is DATA (repository pattern: `@polymarket-bot/settlement`,
 * `@polymarket-bot/universe`, `@polymarket-bot/order-book`,
 * `@polymarket-bot/capital-allocator`): the engine answers "no" by returning
 * every reason with its evidence. Nothing here logs or throws for a
 * recoverable condition.
 */

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
