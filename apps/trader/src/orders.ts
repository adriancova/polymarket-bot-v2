/**
 * The order-view seam — `WP-220` composition-root obligations 4, 5 (first half)
 * and 7.
 *
 * > "4. **The ladder reads the order views it was handed, once, at adoption.**
 * > An order the instance has already adopted (it holds the venue's `orderId`)
 * > is not re-matched against `ctx.orders()` on later evaluations; its state
 * > moves only through `onOrderUpdate` and `onFill`. **A root that stops
 * > delivering `onOrderUpdate` for an adopted order, or that delivers views
 * > only through `ctx.orders()`, leaves that order's tracked state frozen.**"
 *
 * > "5. … **Order views are idempotent and repeat-safe.** … **Roots may
 * > redeliver views freely.**"
 *
 * > "7. **`StrategyOrderView.filledShares` is read as EVIDENCE, never as
 * > allocation.** … A root that reports filled sizes on views it never backs
 * > with a fill will leave an instance waiting."
 *   — `packages/strategies/static-bracket/README.md`
 *
 * ## What this module does, in one sentence
 *
 * It turns the venue's order state into `StrategyOrderView`s and delivers EVERY
 * change — and every repeat of a terminal state — through `onOrderUpdate`, while
 * also keeping `ctx.orders()` populated, so neither half of obligation 4's
 * failure mode is reachable.
 *
 * ## The three rules, and why each is not merely a preference
 *
 * 1. **Deliver through `onOrderUpdate`, always.** The strategy's sub-machine
 *    moves on the callback, not on the context view. `ctx.orders()` exists so a
 *    strategy can see its working orders; it is not a delivery channel, and a
 *    root that used it as one would freeze every adopted order's tracked state.
 *    The effect is fail-safe (a frozen live order blocks new entries) but it is
 *    still a wiring fault, and it is one nothing would report.
 * 2. **Repeats are ordinary traffic, and this seam emits them on purpose.** The
 *    strategy absorbs a repeated terminal view and absorbs an `OPEN` view during
 *    a cancel race (its round-3 self-edge). Suppressing repeats here would make
 *    the trader depend on a de-duplication the strategy explicitly does not need
 *    — and would hide exactly the redelivery the strategy was hardened for. So
 *    `deliverable()` emits a view whenever the venue's order state was READ,
 *    including when nothing about it changed, and the emission is counted.
 * 3. **`filledShares` is the venue's confirmed quantity and nothing else.** It
 *    is never the requested size and never a projection of one; when the venue
 *    reports a Tier-1 resting BAND rather than a point, `filledShares` carries
 *    the point-precise quantity actually booked (`"0"` for such an order), which
 *    is what `SimulatedOrder.fillEstimateKind` exists to disclose. A root that
 *    reported a band member here would put an unbacked filled size in front of
 *    obligation 7's awaiting-fill posture.
 */

import type { SimulatedOrder } from "@polymarket-bot/simulation";
import type { StrategyOrderStatus, StrategyOrderView } from "@polymarket-bot/strategy-sdk";

/**
 * The venue's order states mapped onto the SDK's six.
 *
 * `packages/strategy-sdk`'s `StrategyOrderStatus` has no `CANCEL_PENDING`
 * member — the strategy's README says so explicitly and builds its cancel-race
 * self-edge on the fact — so a cancel in flight is reported as `OPEN`, which is
 * "the ONLY status a root can report for an order whose cancel is in flight".
 *
 * `DELAYED` is the simulator's latency state: the order exists and is not
 * working yet. It maps to `OPEN` for the same reason — the strategy's ladder
 * reads `OPEN` as `OBSERVED_WORKING`, and an order in flight is exactly the
 * thing §6 invariant 6 forbids treating as a rejection.
 */
const STATUS_FOR: Readonly<Record<SimulatedOrder["state"], StrategyOrderStatus>> = Object.freeze({
  ACCEPTED: "OPEN",
  DELAYED: "OPEN",
  RESTING: "OPEN",
  PARTIALLY_FILLED: "PARTIALLY_FILLED",
  FILLED: "FILLED",
  CANCELLED: "CANCELED",
  EXPIRED: "EXPIRED",
  REJECTED: "REJECTED",
});

/** The SDK's terminal set. No edge leaves one (the strategy's own order machine). */
export const TERMINAL_STATUSES: readonly StrategyOrderStatus[] = Object.freeze([
  "FILLED",
  "CANCELED",
  "REJECTED",
  "EXPIRED",
]);

export interface OrderViewDelivery {
  readonly instanceId: string;
  readonly view: StrategyOrderView;
  /**
   * `true` when this exact `(orderId, status, filledShares)` was delivered
   * before.
   *
   * Carried rather than suppressed: obligation 5 makes a repeat ordinary
   * traffic, and a seam that hid repeats would be hiding the very case the
   * strategy's absorb path exists for. It is counted on the health surface.
   */
  readonly repeat: boolean;
}

/**
 * Builds the SDK view of one venue order.
 *
 * `placedAt` is supplied by the caller because a `SimulatedOrder` is anchored to
 * a RECORDED EVENT (`atEvent`), not to a wall clock, and the strict-UTC instant
 * the strategy must see is the one the loop normalised for that event (§6
 * invariant 15: replay "must not use future venue timestamps unavailable to the
 * live process").
 */
export function toStrategyOrderView(
  order: SimulatedOrder,
  input: { readonly marketId: string; readonly placedAt: string },
): StrategyOrderView {
  return Object.freeze({
    orderId: order.simulatedOrderId,
    marketId: input.marketId,
    outcome: order.side,
    side: order.action,
    price: order.limitPrice,
    requestedShares: order.requestedShares,
    // §6 invariant 10 and obligation 7: the CONFIRMED quantity. For a Tier-1
    // resting order this is the point-precise quantity actually booked, which
    // is `"0"`; the band is the estimate and lives on the execution result.
    filledShares: order.filledShares,
    status: STATUS_FOR[order.state],
    placedAt: input.placedAt,
  });
}

/** The obligation-4/5a counters, named so the health surface can carry them. */
export interface OrderViewMetrics {
  readonly emitted: number;
  readonly repeats: number;
  readonly tracked: number;
}

/**
 * Tracks what has been delivered so a repeat can be LABELLED (never dropped).
 *
 * The tracker is deliberately not a filter. Its only output is the `repeat`
 * flag and the counters behind it; every view it is shown is deliverable.
 */
export class OrderViewTracker {
  /** orderId -> the last `(status, filledShares)` delivered for it. */
  readonly #delivered = new Map<string, string>();
  #emitted = 0;
  #repeats = 0;

  /**
   * Marks one view for delivery.
   *
   * ALWAYS returns a delivery. Obligation 4's failure mode is a root that stops
   * delivering; this method has no path that declines to.
   */
  deliverable(instanceId: string, view: StrategyOrderView): OrderViewDelivery {
    const signature = `${view.status}|${view.filledShares}|${view.price}|${view.requestedShares}`;
    const repeat = this.#delivered.get(view.orderId) === signature;
    this.#delivered.set(view.orderId, signature);
    this.#emitted += 1;
    if (repeat) this.#repeats += 1;
    return Object.freeze({ instanceId, view, repeat });
  }

  metrics(): OrderViewMetrics {
    return Object.freeze({
      emitted: this.#emitted,
      repeats: this.#repeats,
      tracked: this.#delivered.size,
    });
  }
}

/** True for the four states the strategy's order machine treats as terminal. */
export function isTerminalStatus(status: StrategyOrderStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}
