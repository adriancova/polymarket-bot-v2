/**
 * The rate-limit budget seam (§9.13, §6 invariant 13, ADR-012 §5.6).
 *
 * ADR-012 §5.6: "Rate-limit budgets bound achievable action rates … A simulator
 * that ignores them **overstates** achievable cancel/replace rates and therefore
 * maker performance. The simulated venue must apply the same budget model as
 * live (§9.13), including that safety cancellation outranks new order placement
 * (§6 invariant 13)."
 *
 * The budget model itself belongs to `packages/polymarket-secure/src/rate-limit/**`
 * (work plan), which does not exist yet. This module is therefore the SEAM, not
 * the model: the simulated venue takes a {@link RateLimitBudget} and applies it,
 * and the composition root supplies whichever implementation it has.
 *
 * ## Absence is explicit, never a silent "unlimited"
 *
 * There is no default budget. A run that has no model must pass
 * {@link unmodeledRateLimits} with a stated disclosure, and every venue result
 * then carries `rateLimitModel: "NOT_MODELED"`. That is the difference between
 * "we checked and it fit" and "nobody checked" — and ADR-012 §5.6 says which of
 * those a maker result depends on.
 */

import { ownFrozenTree } from "./plain.js";
import type { PlanPriority } from "./ports.js";

/** One action the venue wants to take. */
export interface RateLimitRequest {
  readonly kind: "PLACE" | "CANCEL";
  /** §6 invariant 13: `SAFETY_CANCEL` outranks `PLACEMENT`. */
  readonly priority: PlanPriority;
  readonly count: number;
  /** Recorded monotonic instant. The budget reads no clock of its own. */
  readonly atNs: bigint;
}

/** A budget's answer. A refusal must say why. */
export interface RateLimitDecision {
  readonly admitted: boolean;
  readonly reason?: string;
}

/** The budget seam. */
export interface RateLimitBudget {
  readonly modelKind: "MODELED" | "NOT_MODELED";
  /** Why, when `NOT_MODELED`. Travels onto every venue result. */
  readonly disclosure: string;
  admit(request: RateLimitRequest): RateLimitDecision;
}

/**
 * A budget that admits everything and says so.
 *
 * Used when no venue budget model is wired. The disclosure is REQUIRED so the
 * run report states what was not modelled rather than implying it was.
 */
export function unmodeledRateLimits(disclosure: string): RateLimitBudget {
  const budget = {
    modelKind: "NOT_MODELED" as const,
    disclosure,
    admit(): RateLimitDecision {
      return { admitted: true };
    },
  };
  return Object.freeze(budget);
}

/**
 * A simple per-window token budget over recorded monotonic instants.
 *
 * The CAPACITIES ARE CALLER-SUPPLIED: the venue's published per-signer buckets
 * are volatile program parameters (venue report §8, snapshot dated 2026-08-24)
 * and §9.13 forbids hardcoding them, so this function invents no number. What it
 * contributes is the ORDERING rule §6 invariant 13 requires: a `SAFETY_CANCEL`
 * is admitted from the cancel bucket and is never blocked by placement traffic,
 * because the two buckets are separate — which is also how the venue documents
 * them ("separate order and cancel buckets").
 */
export function tokenBucketRateLimits(input: {
  readonly orderTokensPerWindow: number;
  readonly cancelTokensPerWindow: number;
  readonly windowMs: number;
  readonly snapshotVersion: string;
}): RateLimitBudget {
  const windowNs = BigInt(input.windowMs) * 1_000_000n;
  let orderWindowStart: bigint | undefined;
  let cancelWindowStart: bigint | undefined;
  let orderSpent = 0;
  let cancelSpent = 0;

  const budget = {
    modelKind: "MODELED" as const,
    disclosure: `token buckets from snapshot ${input.snapshotVersion}`,
    admit(request: RateLimitRequest): RateLimitDecision {
      if (request.kind === "CANCEL") {
        if (cancelWindowStart === undefined || request.atNs - cancelWindowStart >= windowNs) {
          cancelWindowStart = request.atNs;
          cancelSpent = 0;
        }
        if (cancelSpent + request.count > input.cancelTokensPerWindow) {
          return ownFrozenTree<RateLimitDecision>({
            admitted: false,
            reason: `cancel budget exhausted (${String(input.cancelTokensPerWindow)} per ${String(input.windowMs)}ms, snapshot ${input.snapshotVersion})`,
          });
        }
        cancelSpent += request.count;
        return ownFrozenTree<RateLimitDecision>({ admitted: true });
      }
      if (orderWindowStart === undefined || request.atNs - orderWindowStart >= windowNs) {
        orderWindowStart = request.atNs;
        orderSpent = 0;
      }
      if (orderSpent + request.count > input.orderTokensPerWindow) {
        return ownFrozenTree<RateLimitDecision>({
          admitted: false,
          reason: `order budget exhausted (${String(input.orderTokensPerWindow)} per ${String(input.windowMs)}ms, snapshot ${input.snapshotVersion})`,
        });
      }
      orderSpent += request.count;
      return ownFrozenTree<RateLimitDecision>({ admitted: true });
    },
  };
  return Object.freeze(budget);
}
