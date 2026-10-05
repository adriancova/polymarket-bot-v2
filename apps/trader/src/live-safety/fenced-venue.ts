/**
 * The submission fence in front of the venue port (WP-320; handoff §6
 * invariant 16: "Only the holder of the current account fencing token may
 * submit"; ADR-008 §2 and §8).
 *
 * The database refuses a live submission attempt naming a lease that is not
 * ACTIVE and unexpired at its own clock (migration 0008's validity trigger),
 * but the attempt row is written BEFORE the order is sent (§9.11 steps 3–5),
 * so a lease can expire between the write and the send: "a lease expires
 * mid-submission". And a kill switch can be engaged, and observed, between an
 * order's decision and its transmission. This wrapper closes both gaps in the
 * process: before every signing and before EVERY transmission it asks the
 * live gate (`entry-gate.ts`) the order's OWN question — its intent
 * (`NEW_ENTRY` or `REDUCTION`), its market and its strategy instance — so a
 * GLOBAL/ACCOUNT switch, a MARKET or STRATEGY_INSTANCE switch on its scope,
 * an entry-only switch for an opening order, the fence, the health lease,
 * the explicit stops and, for an opening order, the heartbeat, eligibility and
 * reconciliation halts are all judged at the last moment (r1, finding I2).
 * This covers the OMS's later `transmitSigned` and
 * `retransmitSameSignedOrder` too: they transmit through this port.
 *
 * ## Where an order's scope comes from: the injected classifier
 *
 * The composition, which made the decision, supplies a
 * {@link PlacementClassifier}:
 *
 * - `request(request)` classifies a signing request (the decision it carries
 *   out); the scope is REMEMBERED for the signed order the venue returns
 *   (`signedOrder(outcome)`), by object identity, so every transmission of
 *   that order is judged with the scope of the decision that produced it;
 * - `order(order)` classifies an order this port did not sign (one restored
 *   from the store after a restart).
 *
 * An order with no readable scope is REFUSED (`PLACEMENT_UNCLASSIFIED`): it
 * is never sent unjudged.
 *
 * ## When the answer is no
 *
 * The venue is NOT CALLED for that order, and the OMS is told so in its own
 * vocabulary:
 *
 * - signing: a `FAILED` sign outcome ("a FAILED sign outcome means NO ORDER
 *   EXISTS", WP-270), from `refusals.signRefused`;
 * - a placement: a `NOT_SENT` outcome whose error effect is `NOT_SENT`
 *   ("nothing left the process"), from `refusals.placementRefused`;
 * - a batch: EACH MEMBER is judged on its own, and if any member is refused
 *   the WHOLE batch is refused — every member `NOT_SENT` (a refused member
 *   with its own reasons, the others with `BATCH_MEMBER_REFUSED`) and nothing
 *   sent. WP-270 reads a batch answer that mixes `NOT_SENT` with anything
 *   else as unknown for every member (`classifyBatch`,
 *   `BATCH_MIXED_NOT_SENT`), so sending the permitted subset would turn the
 *   refused members — and the sent ones — into unknown submissions; an
 *   all-`NOT_SENT` answer is read as `BATCH_REFUSED`: nothing left the
 *   process, and the OMS may submit the permitted orders again.
 *
 * ## Every placement handed to the venue is tracked until it settles (r2, X3)
 *
 * A placement the gate permitted is reported to the injected
 * {@link PlacementTracker} (the composition's) with its scope(s) just before
 * the venue is called, and again when the call settles — answered, rejected
 * or thrown. The live-safety composition uses it to keep a kill switch's
 * cancel obligation open while a placement that was already in flight when
 * the switch was observed is still pending, and to cancel again once it
 * lands (`live-safety.ts`). A tracker that throws on `started` refuses the
 * placement (`PLACEMENT_UNTRACKED`): an order is never sent untracked.
 *
 * Cancels pass through unfenced: a cancel is a safety action (§6 invariant
 * 13), and a process that lost the fence must still be able to withdraw its
 * own orders. The port's types are the OMS's (`OmsVenuePort`), carried as type
 * parameters because `apps/trader` declares no dependency on
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

/** The decision an order carries out: whether it opens or reduces, and where. */
export interface PlacementScope {
  readonly intent: "NEW_ENTRY" | "REDUCTION";
  readonly marketId: string;
  readonly instanceId: string;
}

/** The composition's knowledge of each order's decision (module header). */
export interface PlacementClassifier<TRequest, TSign, TOrder> {
  /** The decision a signing request carries out; `null` refuses the signing. */
  request(request: TRequest): PlacementScope | null;
  /** The signed order a sign outcome carries (its scope is remembered for its transmissions); `undefined` when none. */
  signedOrder(outcome: TSign): TOrder | undefined;
  /** The decision of an order this port did not sign (restored after a restart); `null` refuses its transmission. */
  order(order: TOrder): PlacementScope | null;
}

/**
 * Told about every placement this port hands to the venue (module header, r2 X3): `started` just before the venue is
 * called, with the scope of each order in it; `settled` with the handle `started` returned, once the call settles.
 */
export interface PlacementTracker {
  started(scopes: readonly PlacementScope[]): unknown;
  settled(handle: unknown): void;
}

const UNCLASSIFIED = Object.freeze(["PLACEMENT_UNCLASSIFIED"]);
const UNTRACKED = Object.freeze(["PLACEMENT_UNTRACKED"]);
const BATCH_MEMBER_REFUSED = Object.freeze(["BATCH_MEMBER_REFUSED"]);

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200;
}

/** Read a classifier's answer as exactly a scope, or `null`. */
function readScope(value: unknown): PlacementScope | null {
  if (typeof value !== "object" || value === null) return null;
  const field = (name: string): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
  };
  const intent = field("intent");
  const marketId = field("marketId");
  const instanceId = field("instanceId");
  if ((intent !== "NEW_ENTRY" && intent !== "REDUCTION") || !isIdentifier(marketId) || !isIdentifier(instanceId)) return null;
  return Object.freeze({ intent, marketId, instanceId });
}

/**
 * The fenced port: the same shape, with signing and every transmission judged per order, and every placement handed
 * to the venue reported to `tracker` (the live-safety composition always passes its own; module header).
 */
export function fenceVenuePort<TRequest, TSign, TOrder, TPlacement, TCancel>(
  venue: PlacementVenuePort<TRequest, TSign, TOrder, TPlacement, TCancel>,
  decideFor: (scope: PlacementScope) => GateDecision,
  refusals: FenceRefusals<TSign, TPlacement>,
  classifier: PlacementClassifier<TRequest, TSign, TOrder>,
  tracker?: PlacementTracker,
): PlacementVenuePort<TRequest, TSign, TOrder, TPlacement, TCancel> {
  /** Scopes of the orders signed through this port, by object identity. */
  const remembered = new WeakMap<object, PlacementScope>();

  const decide = (scope: PlacementScope | null): GateDecision => {
    if (scope === null) return Object.freeze({ permitted: false, reasons: UNCLASSIFIED });
    try {
      return decideFor(scope);
    } catch {
      return Object.freeze({ permitted: false, reasons: Object.freeze(["GATE_THREW"]) });
    }
  };
  const scopeOfRequest = (request: TRequest): PlacementScope | null => {
    try {
      return readScope(classifier.request(request));
    } catch {
      return null;
    }
  };
  const scopeOfOrder = (order: TOrder): PlacementScope | null => {
    if (typeof order === "object" && order !== null) {
      const known = remembered.get(order);
      if (known !== undefined) return known;
    }
    try {
      return readScope(classifier.order(order));
    } catch {
      return null;
    }
  };

  /** Hand `send` to the venue as a tracked placement of `scopes`; refused unsent when it cannot be tracked. */
  const tracked = async <T>(scopes: readonly PlacementScope[], send: () => Promise<T>, refused: () => T): Promise<T> => {
    if (tracker === undefined) return send();
    let handle: unknown;
    try {
      handle = tracker.started(Object.freeze([...scopes]));
    } catch {
      return refused();
    }
    try {
      return await send();
    } finally {
      try {
        tracker.settled(handle);
      } catch {
        // The tracker's failure is its own; the venue's answer stands.
      }
    }
  };

  return Object.freeze({
    async createLimitOrder(request: TRequest): Promise<TSign> {
      const scope = scopeOfRequest(request);
      const decision = decide(scope);
      if (!decision.permitted || scope === null) return refusals.signRefused(decision.reasons);
      const outcome = await venue.createLimitOrder(request);
      let signed: TOrder | undefined;
      try {
        signed = classifier.signedOrder(outcome);
      } catch {
        signed = undefined;
      }
      if (typeof signed === "object" && signed !== null) remembered.set(signed, scope);
      return outcome;
    },
    async postOrder(order: TOrder): Promise<TPlacement> {
      // Asked at the last moment before the call: a lease that lapsed, or a switch observed, since the decision refuses here.
      const scope = scopeOfOrder(order);
      const decision = decide(scope);
      if (!decision.permitted || scope === null) return refusals.placementRefused(decision.reasons);
      return tracked(
        [scope],
        async () => venue.postOrder(order),
        () => refusals.placementRefused(UNTRACKED),
      );
    },
    async postOrders(orders: readonly TOrder[]): Promise<readonly TPlacement[]> {
      // Every member is judged; one refusal refuses the whole batch (module header), and nothing is sent.
      const scopes = orders.map((order) => scopeOfOrder(order));
      const decisions = scopes.map((scope) => decide(scope));
      const permitted: PlacementScope[] = [];
      for (const scope of scopes) if (scope !== null) permitted.push(scope);
      if (decisions.every((decision) => decision.permitted) && permitted.length === orders.length) {
        return tracked(
          permitted,
          async () => venue.postOrders(orders),
          () => Object.freeze(orders.map(() => refusals.placementRefused(UNTRACKED))),
        );
      }
      return Object.freeze(decisions.map((decision) => refusals.placementRefused(decision.permitted ? BATCH_MEMBER_REFUSED : decision.reasons)));
    },
    async cancelOrder(orderId: string): Promise<TCancel> {
      return venue.cancelOrder(orderId);
    },
  });
}
