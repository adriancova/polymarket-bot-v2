/**
 * The §12.1 `ExecutionPolicy` a composition root gives the simulated venue:
 * the `VenueWiring` holder and `createExecutionPolicy`.
 *
 * Moved by `CORE-MOVE` (ADR-022 D8) out of `apps/trader/src/main.ts`, where it
 * was lines 155-217 at `ac0b12f`. Everything below the imports is those lines,
 * byte for byte, comments included. So "the module header" the first comment
 * points at is `apps/trader/src/main.ts`'s, which explains why the venue is
 * built against a holder that the trader fills right after construction.
 * `main.ts` imports both names from this package and re-exports them.
 */

import type { PlannedOrderView, TimeInForce } from "@polymarket-bot/simulation";

import type { PaperTrader } from "./trader.js";

/** The holder the venue's policy reads. See the module header. */
export interface VenueWiring {
  trader: PaperTrader | undefined;
}

/**
 * The §12.1 `ExecutionPolicy` this process gives the simulated venue.
 *
 * Extracted and exported so its ONE unresolvable case can be driven directly
 * (review round 1, MEDIUM-3): the reviewed tip left a bare `throw` here under a
 * `startup()` docstring that says "Never throws", with a comment asserting the
 * branch was unreachable and nothing exercising it either way.
 *
 * THE THROW STAYS, AND IT IS CONTAINED. `timeInForceFor` must answer a
 * `TimeInForce`; there is no refusal channel and no safe value — "a silently
 * assumed FAK would change every unfilled remainder's fate" is the seam's own
 * rule. The containment is `SimulatedVenue.submit`'s: it runs the policy inside
 * `totallyResult`, so a throw becomes a REFUSED `ExecutionResult` carrying a
 * `SIMULATION_*` code, which the loop counts as `submissionsRefused`. It never
 * reaches `startup`, and `apps/trader/src/main.test.ts` drives exactly that
 * path through a real `SimulatedVenue` rather than asserting it.
 *
 * What was genuinely missing is now here too: the process LOGS the unresolved
 * order, so a refusal an operator sees on the venue seam has a line naming the
 * planned order that caused it.
 */
export function createExecutionPolicy(
  wiring: VenueWiring,
  log: (line: string) => void,
): {
  timeInForceFor: (order: PlannedOrderView) => TimeInForce;
  statedExpiryNsFor: () => bigint | undefined;
  sameInstantAdditionsFor: () => "NOT_OBSERVED";
} {
  return {
    timeInForceFor(order: PlannedOrderView): TimeInForce {
      const resolved = wiring.trader?.loop.timeInForceFor(order.plannedOrderId);
      if (resolved === undefined) {
        log(
          `SUBMISSION REFUSED: no time-in-force was recorded for planned order ` +
            `${order.plannedOrderId}. The composition root refuses to assume one (§12.1 ` +
            "ExecutionPolicy); the venue contains this into a refused ExecutionResult and " +
            "nothing was submitted.",
        );
        throw new Error(
          `no time-in-force was recorded for planned order ${order.plannedOrderId}; the ` +
            "composition root refuses to assume one (§12.1 ExecutionPolicy)",
        );
      }
      return resolved;
    },
    statedExpiryNsFor(): bigint | undefined {
      return undefined;
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
