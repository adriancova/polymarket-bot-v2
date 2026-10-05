/**
 * The live-safety composition bound to the OMS that PLACES the orders (r3,
 * finding J4), for the kill-switch cancel-obligation faults.
 *
 * `liveProcess()` binds the composition's `SafetyOms` to WP-290's process OMS
 * (`p.oms`). A test that places orders through a SEPARATE `OrderManager`
 * (WP-270's unit harness, whose fake venue can hold a placement in flight)
 * then has the composition read an OMS that never saw them, so "the OMS shows
 * nothing resting" is vacuous (Opus R3-L3, agreed LOW). Here the composition's
 * `SafetyOms` is a view of the placing manager itself, the manager is opened
 * over the composition's fenced venue (`safety.fenceVenue`) and its timed
 * persistence ports (`omsProgress.dependencies`), as a live root does, and
 * {@link cancelThroughOms} is a cancel binding that goes through that same
 * manager (`requestCancel`, by venue order id), so the OMS's view is the venue
 * evidence the obligation reads.
 *
 * Fakes only: WP-270's scripted venue, WP-290's simulated universe, the
 * heartbeat transport fake. Nothing reaches a network, a database or a venue.
 */

import type { CancelDirective, PlacementClassifier, SafetyOms } from "../../../../apps/trader/src/live-safety/index.js";
import type { LimitOrderRequest, OrderManager, PlacementOutcome, SignedOrderHandle, SignOutcome } from "../../../../packages/oms/src/index.js";
import { openHarness, reopen, type Harness } from "../../../unit/oms/support/harness.js";

import { liveProcess, type LiveProcess, type LiveProcessOptions } from "./live-process.js";

/** The fenced venue's refusals, in WP-270's vocabulary (`fenced-venue.ts`). */
export const REFUSALS = Object.freeze({
  signRefused: (reasons: readonly string[]): SignOutcome => ({ kind: "FAILED", error: { kind: reasons[0] ?? "GATE_REFUSED", effect: "NOT_SENT", retryAfterSeconds: null } }),
  placementRefused: (reasons: readonly string[]): PlacementOutcome => ({ kind: "NOT_SENT", error: { kind: reasons[0] ?? "GATE_REFUSED", effect: "NOT_SENT", retryAfterSeconds: null } }),
});

/** Every order the OMS may cancel by venue order id (`OrderManager.requestCancel`). */
const CANCELLABLE = Object.freeze(["ACKNOWLEDGED", "LIVE", "DELAYED", "PARTIALLY_FILLED", "RECONCILING"]);

export interface PlacingProcess {
  readonly live: LiveProcess;
  readonly h: Harness;
  /** The placing `OrderManager`, which the composition's `SafetyOms` reads. */
  manager(): OrderManager;
}

/** A live process whose composition reads the OMS that places the orders, opened over its fenced venue. */
export async function placingProcess(
  classifier: PlacementClassifier<LimitOrderRequest, SignOutcome, SignedOrderHandle>,
  options: LiveProcessOptions = {},
): Promise<PlacingProcess> {
  const h = await openHarness();
  let manager = h.manager;
  const oms: SafetyOms = {
    get faulted(): boolean {
      return manager.faulted;
    },
    orders: () => manager.orders(),
    requestOrderReconciliation: (orderId: string) => manager.requestOrderReconciliation(orderId),
  };
  const live = await liveProcess({ ...options, safety: { ...options.safety, oms } });
  manager = (await reopen(h, live.omsProgress.dependencies({ ...h.deps, venue: live.safety.fenceVenue(h.venue, REFUSALS, classifier) }))).manager;
  return { live, h, manager: () => manager };
}

/**
 * A kill-switch cancel binding through the OMS: every order in the directive's scope that the OMS can cancel by venue
 * order id is cancelled with `requestCancel`; `true` when each request was accepted. `instanceOf` is the composition's
 * own order → instance record (WP-270's order view carries none).
 */
export async function cancelThroughOms(manager: OrderManager, directive: CancelDirective, instanceOf: (orderId: string) => string | null): Promise<boolean> {
  let accepted = true;
  for (const order of manager.orders()) {
    if (!CANCELLABLE.includes(order.state) || order.venueOrderId === null) continue;
    const inScope =
      directive.scope === "ACCOUNT" ||
      (directive.scope === "MARKET" && order.marketId === directive.marketId) ||
      (directive.scope === "STRATEGY_INSTANCE" && instanceOf(order.orderId) === directive.instanceId);
    if (!inScope) continue;
    if (!(await manager.requestCancel(order.orderId)).ok) accepted = false;
  }
  return accepted;
}
