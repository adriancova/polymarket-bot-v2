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
 * It turns the venue's order state into `StrategyOrderView`s and delivers every
 * WORKING order's view, and a TERMINAL order's view until one delivery of it
 * has been evaluated, through `onOrderUpdate`, while also keeping
 * `ctx.orders()` populated with the same orders, so neither half of
 * obligation 4's failure mode is reachable.
 *
 * ## The three rules, and why each is not merely a preference
 *
 * 1. **Deliver through `onOrderUpdate`, always.** The strategy's sub-machine
 *    moves on the callback, not on the context view. `ctx.orders()` exists so a
 *    strategy can see its working orders; it is not a delivery channel, and a
 *    root that used it as one would freeze every adopted order's tracked state.
 *    The effect is fail-safe (a frozen live order blocks new entries) but it is
 *    still a wiring fault, and it is one nothing would report.
 * 2. **A working order is re-delivered on every harvest; a terminal one until it
 *    has been EVALUATED once, then it is RETIRED** (`TRDR-4`, the user's ruling
 *    R1 of 2026-09-26). This module's rule used to be "repeats are ordinary
 *    traffic, and this seam emits them on purpose": every order the process had
 *    ever placed was re-delivered on every harvest, terminal ones included,
 *    forever — so per-event evaluations, persisted decisions and checkpoints
 *    grew with every order ever placed, and `ctx.orders()` carried the whole
 *    history. The strategy's README PERMITS that ("Roots may redeliver views
 *    freely") but does not require it, and R1 stops it for terminal orders:
 *    - a WORKING view is still re-delivered on every harvest, so an `OPEN`
 *      view during a cancel race still reaches the strategy's round-3
 *      self-edge, and repeats of it are still labelled and counted here;
 *    - a TERMINAL view is delivered until ONE delivery was actually EVALUATED
 *      by the strategy (the runtime answered `DECIDED`). A delivery the §4.2
 *      halt gate suppressed, or one the runtime refused because the instance
 *      is PAUSED, is not an evaluation and does not count — obligation 4's
 *      "a root that stops delivering … leaves that order's tracked state
 *      frozen" is exactly the failure a premature retirement would cause;
 *    - after that the order is RETIRED: no further `onOrderUpdate`, and it
 *      leaves `ctx.orders()`, which then holds the instance's working orders
 *      plus its terminal-not-yet-retired ones. That matches the SDK contract
 *      ("one of this instance's own working orders") and closes the latent
 *      stale-adoption path in which a new bracket's unadopted track could bind
 *      to an earlier cycle's terminal order (the scoping's
 *      `decide.ts` adoptOrder / attributeOrder reading).
 *    An IMMEDIATE order that is already terminal before any tick still reaches
 *    the strategy — through that first evaluated delivery, which is where the
 *    strategy adopts it.
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
   * Since `TRDR-4` (R1) a repeat is a WORKING order's view re-delivered on a
   * later harvest, or a terminal view whose earlier delivery was not evaluated
   * (a halt suppressed it, or a PAUSED runtime refused it); a terminal view is
   * never delivered again once one delivery of it was evaluated.
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
 * WHICH views are shown to it is the loop's R1 rule (module header, rule 2):
 * a retired order is never shown again, and when the loop SETTLES an order it
 * {@link OrderViewTracker.forget}s it, so `tracked` counts orders the loop
 * still delivers rather than every order ever placed.
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

  /**
   * Drops one SETTLED order's last-delivered signature (`TRDR-4`).
   *
   * Only the loop's settlement calls this, and only after the order was
   * retired — so no later delivery of it exists that could be mislabelled as
   * a non-repeat. Answers whether an entry was held.
   */
  forget(orderId: string): boolean {
    return this.#delivered.delete(orderId);
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
