/**
 * Wiring the detector into the OMS (WP-310 deliverable 3: "Mode detection
 * feeds the OMS's venue-mode snapshot").
 *
 * - {@link venueModeSource}: the OMS's `venueMode` dependency, read from the
 *   detector at the injected clock's instant. A clock that throws or answers
 *   anything but epoch milliseconds reads as `TRADING_UNAVAILABLE` (fail
 *   closed), like everything the OMS cannot read.
 * - {@link withModeDetection}: the OMS's venue port, unchanged, except that
 *   every placement and cancel answer is also shown to the detector. The
 *   answer itself is returned untouched (the same object), a throw from the
 *   port is rethrown untouched, and nothing the detector does can make a
 *   venue call fail.
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

/** Show one condition to the detector; never throws. */
function show(detector: VenueModeDetector, clock: () => number, operation: VenueOperation, condition: VenueCondition): void {
  const now = instant(clock);
  if (now === undefined) return;
  try {
    detector.observe({ operation, condition }, now);
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
      const outcome = await venue.postOrder(order);
      show(detector, clock, "PLACEMENT", conditionOfPlacementOutcome(outcome));
      return outcome;
    },
    async postOrders(orders: readonly SignedOrderHandle[]): Promise<readonly PlacementOutcome[]> {
      const outcomes = await venue.postOrders(orders);
      let inputs = 0;
      try {
        inputs = orders.length;
      } catch {
        inputs = 0;
      }
      for (const condition of conditionsOfBatchOutcome(outcomes, inputs)) show(detector, clock, "PLACEMENT", condition);
      return outcomes;
    },
    async cancelOrder(orderId: string): Promise<CancelOutcome> {
      const outcome = await venue.cancelOrder(orderId);
      show(detector, clock, "CANCEL", conditionOfCancelOutcome(outcome));
      return outcome;
    },
  });
}
