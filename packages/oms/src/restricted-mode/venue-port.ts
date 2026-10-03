/**
 * Wiring the detector into the OMS (WP-310 deliverable 3: "Mode detection
 * feeds the OMS's venue-mode snapshot").
 *
 * - {@link venueModeSource}: the OMS's `venueMode` dependency, read from the
 *   detector at the injected clock's instant. A clock that throws or answers
 *   anything but epoch milliseconds reads as `TRADING_UNAVAILABLE` (fail
 *   closed), like everything the OMS cannot read.
 * - {@link withModeDetection}: the OMS's venue port, unchanged, except that
 *   every placement and cancel answer is also shown to the detector, with
 *   the instant its request was SENT (read from the clock just before the
 *   call): only an answer to a request sent after the last restart rejection
 *   shows the engine is back. The answer itself is returned untouched (the
 *   same object), a throw from the port is rethrown untouched, and nothing
 *   the detector does can make a venue call fail.
 *
 * The clock is injected by the composition (layer 1 reads none).
 */

import type { CancelOutcome, LimitOrderRequest, OmsVenuePort, PlacementOutcome, SignOutcome, SignedOrderHandle, VenueMode } from "../ports.js";

import type { VenueModeDetector } from "./detector.js";
import { conditionOfCancelOutcome, conditionOfPlacementOutcome, conditionsOfBatchOutcome, type VenueCondition, type VenueOperation } from "./signals.js";

function instant(clock: () => number): number | undefined {
  try {
    const value = clock();
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The OMS's `venueMode` dependency, bound to a detector and a clock. */
export function venueModeSource(detector: VenueModeDetector, clock: () => number): () => VenueMode {
  return (): VenueMode => {
    const now = instant(clock);
    if (now === undefined) return "TRADING_UNAVAILABLE";
    try {
      return detector.omsVenueMode(now);
    } catch {
      return "TRADING_UNAVAILABLE";
    }
  };
}

/** Show one condition to the detector, with its request's send instant when the clock gave a usable one; never throws. */
function show(detector: VenueModeDetector, clock: () => number, operation: VenueOperation, condition: VenueCondition, sentAtMs: number | undefined): void {
  const now = instant(clock);
  if (now === undefined) return;
  try {
    // A send instant after the answer's (a clock that ran backwards) proves nothing: it is left out.
    detector.observe(sentAtMs === undefined || sentAtMs > now ? { operation, condition } : { operation, condition, sentAtMs }, now);
  } catch {
    // The detector never throws on input; this only guards the venue call against a defect in it.
  }
}

/** The venue port, with every placement and cancel answer also shown to `detector`. */
export function withModeDetection(venue: OmsVenuePort, detector: VenueModeDetector, clock: () => number): OmsVenuePort {
  return Object.freeze({
    createLimitOrder(request: LimitOrderRequest): Promise<SignOutcome> {
      return venue.createLimitOrder(request);
    },
    async postOrder(order: SignedOrderHandle): Promise<PlacementOutcome> {
      const sentAtMs = instant(clock);
      const outcome = await venue.postOrder(order);
      show(detector, clock, "PLACEMENT", conditionOfPlacementOutcome(outcome), sentAtMs);
      return outcome;
    },
    async postOrders(orders: readonly SignedOrderHandle[]): Promise<readonly PlacementOutcome[]> {
      const sentAtMs = instant(clock);
      const outcomes = await venue.postOrders(orders);
      let inputs = 0;
      try {
        inputs = orders.length;
      } catch {
        inputs = 0;
      }
      for (const condition of conditionsOfBatchOutcome(outcomes, inputs)) show(detector, clock, "PLACEMENT", condition, sentAtMs);
      return outcomes;
    },
    async cancelOrder(orderId: string): Promise<CancelOutcome> {
      const sentAtMs = instant(clock);
      const outcome = await venue.cancelOrder(orderId);
      show(detector, clock, "CANCEL", conditionOfCancelOutcome(outcome), sentAtMs);
      return outcome;
    },
  });
}
