/**
 * The §12.1 `ExecutionPolicy` a composition root gives the simulated venue:
 * the `VenueWiring` holder and `createExecutionPolicy`.
 *
 * Moved by `CORE-MOVE` (ADR-022 D8) out of `apps/trader/src/main.ts`, where it
 * was lines 155-217 at `ac0b12f`; `main.ts` imports both names from this
 * package and re-exports them. Since `C1-TIF` (ADR-034 D3.1 item 2) the policy
 * reads the time-in-force from the planned order itself, so it no longer reads
 * the holder: only the venue's book provider does (`venue-builder.ts`).
 */

import { TIME_IN_FORCE_VALUES } from "@polymarket-bot/execution-planner";
import type { Clock, PlannedOrderView, TimeInForce } from "@polymarket-bot/simulation";

import type { PaperTrader } from "./trader.js";

/** The holder the venue's book provider reads. See `venue-builder.ts`. */
export interface VenueWiring {
  trader: PaperTrader | undefined;
}

/**
 * What the policy reads of a planned order beyond {@link PlannedOrderView}: the
 * planner's `PlannedOrder.timeInForce` and, for GTD, `expirationUnixSeconds`
 * (ADR-034 D3.1 item 2). Read defensively: the venue hands the policy its own
 * materialized copy of the plan.
 */
type PlannedOrderWithTimeInForce = PlannedOrderView & {
  readonly timeInForce?: unknown;
  readonly expirationUnixSeconds?: unknown;
};

/**
 * The §12.1 `ExecutionPolicy` this process gives the simulated venue.
 *
 * ADR-034 D3.1 item 2: the time-in-force is carried ON THE PLAN, so the policy
 * reads the planned order and nothing else. An order that carries none (or an
 * unknown value) is refused, never defaulted — "a silently assumed FAK would
 * change every unfilled remainder's fate" is the seam's own rule.
 *
 * THE THROW STAYS, AND IT IS CONTAINED. `timeInForceFor` must answer a
 * `TimeInForce`; there is no refusal channel and no safe value. The
 * containment is `SimulatedVenue.submit`'s: it runs the policy inside
 * `totallyResult`, so a throw becomes a REFUSED `ExecutionResult` carrying a
 * `SIMULATION_*` code, which the loop counts as `submissionsRefused`. The
 * process LOGS the order first, so a refusal an operator sees on the venue seam
 * has a line naming the planned order that caused it.
 *
 * A GTD order's stated expiry is its `expirationUnixSeconds`, converted to the
 * clock's recorded monotonic nanoseconds at the instant the venue asks (the
 * submission instant): `monotonicNs() + (expiration − now())`. The venue then
 * expires it 60 s early, at the plan's deadline (ADR-034 D3.3).
 */
export function createExecutionPolicy(
  clock: Clock,
  log: (line: string) => void,
): {
  timeInForceFor: (order: PlannedOrderWithTimeInForce) => TimeInForce;
  statedExpiryNsFor: (order: PlannedOrderWithTimeInForce) => bigint | undefined;
  sameInstantAdditionsFor: () => "NOT_OBSERVED";
} {
  const refuse = (order: PlannedOrderView, what: string): never => {
    log(
      `SUBMISSION REFUSED: planned order ${order.plannedOrderId} ${what}. The composition root ` +
        "refuses to assume one (§12.1 ExecutionPolicy); the venue contains this into a refused " +
        "ExecutionResult and nothing was submitted.",
    );
    throw new Error(
      `planned order ${order.plannedOrderId} ${what}; the composition root refuses to assume one (§12.1 ExecutionPolicy)`,
    );
  };
  return {
    timeInForceFor(order: PlannedOrderWithTimeInForce): TimeInForce {
      if (!(TIME_IN_FORCE_VALUES as readonly unknown[]).includes(order.timeInForce)) {
        return refuse(order, "carries no time-in-force the venue knows");
      }
      return order.timeInForce as TimeInForce;
    },
    statedExpiryNsFor(order: PlannedOrderWithTimeInForce): bigint | undefined {
      if (order.timeInForce !== "GTD") return undefined;
      const expiration = order.expirationUnixSeconds;
      const nowMs = Date.parse(clock.now());
      if (typeof expiration !== "number" || !Number.isSafeInteger(expiration) || !Number.isFinite(nowMs)) {
        return refuse(order, "is GTD without a readable expiration");
      }
      return clock.monotonicNs() + BigInt(expiration * 1000 - nowMs) * 1_000_000n;
    },
    sameInstantAdditionsFor() {
      // §12.2's CONSERVATIVE queue arm assumes we sit behind size added at our
      // price in the same recorded instant. This process does not observe that
      // — a book snapshot is an aggregate per level — so it says NOT_OBSERVED
      // rather than claiming a zero it did not measure.
      return "NOT_OBSERVED";
    },
  };
}
