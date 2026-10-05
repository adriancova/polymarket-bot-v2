/**
 * The submission fence in front of the venue port (WP-320; handoff §6
 * invariant 16: "Only the holder of the current account fencing token may
 * submit"; ADR-008 §2).
 *
 * The database refuses a live submission attempt naming a lease that is not
 * ACTIVE and unexpired at its own clock (migration 0008's validity trigger),
 * but the attempt row is written BEFORE the order is sent (§9.11 steps 3–5),
 * so a lease can expire between the write and the send: "a lease expires
 * mid-submission". This wrapper closes that gap in the process: before every
 * signing and every transmission it asks the live gate's `TRANSMISSION`
 * question (the fence held with its transmit margin, kill-switch state known
 * and not ending trading, the health lease holding, no explicit stop), and
 * when the answer is no, the venue is NOT CALLED and the OMS is told so in its
 * own vocabulary:
 *
 * - signing: a `FAILED` sign outcome ("a FAILED sign outcome means NO ORDER
 *   EXISTS", WP-270), from `refusals.signRefused`;
 * - a placement or a batch: a `NOT_SENT` outcome per order whose error effect
 *   is `NOT_SENT` ("nothing left the process"), from
 *   `refusals.placementRefused`.
 *
 * Cancels pass through unfenced: a cancel is a safety action (§6 invariant
 * 13), and a process that lost the fence must still be able to withdraw its
 * own orders. The port's types are the OMS's (`OmsVenuePort`), carried as
 * type parameters because `apps/trader` declares no dependency on
 * `@polymarket-bot/oms`; `port-conformance.test.ts` instantiates them with the
 * real ones.
 */

import type { GateDecision } from "./entry-gate.js";

export interface PlacementVenuePort<TRequest, TSign, TOrder, TPlacement, TCancel> {
  createLimitOrder(request: TRequest): Promise<TSign>;
  postOrder(order: TOrder): Promise<TPlacement>;
  postOrders(orders: readonly TOrder[]): Promise<readonly TPlacement[]>;
  cancelOrder(orderId: string): Promise<TCancel>;
}

export interface FenceRefusals<TSign, TPlacement> {
  /** A `FAILED` sign outcome whose error names the reasons (no order exists). */
  signRefused(reasons: readonly string[]): TSign;
  /** A `NOT_SENT` placement outcome whose error effect is `NOT_SENT` (nothing left the process). */
  placementRefused(reasons: readonly string[]): TPlacement;
}

/** The fenced port: the same shape, with signing and every transmission behind `transmission()`. */
export function fenceVenuePort<TRequest, TSign, TOrder, TPlacement, TCancel>(
  venue: PlacementVenuePort<TRequest, TSign, TOrder, TPlacement, TCancel>,
  transmission: () => GateDecision,
  refusals: FenceRefusals<TSign, TPlacement>,
): PlacementVenuePort<TRequest, TSign, TOrder, TPlacement, TCancel> {
  const decide = (): GateDecision => {
    try {
      return transmission();
    } catch {
      return Object.freeze({ permitted: false, reasons: Object.freeze(["GATE_THREW"]) });
    }
  };
  return Object.freeze({
    async createLimitOrder(request: TRequest): Promise<TSign> {
      const decision = decide();
      if (!decision.permitted) return refusals.signRefused(decision.reasons);
      return venue.createLimitOrder(request);
    },
    async postOrder(order: TOrder): Promise<TPlacement> {
      // Asked at the last moment before the call: a lease that lapsed since the attempt was written refuses here.
      const decision = decide();
      if (!decision.permitted) return refusals.placementRefused(decision.reasons);
      return venue.postOrder(order);
    },
    async postOrders(orders: readonly TOrder[]): Promise<readonly TPlacement[]> {
      const decision = decide();
      if (!decision.permitted) return Object.freeze(orders.map(() => refusals.placementRefused(decision.reasons)));
      return venue.postOrders(orders);
    },
    async cancelOrder(orderId: string): Promise<TCancel> {
      return venue.cancelOrder(orderId);
    },
  });
}
