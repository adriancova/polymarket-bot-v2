/**
 * A simulated venue world and an INDEPENDENT salt oracle, shared by the seeded
 * interleaving property (`salt-gate.property.test.ts`) and the
 * fault-injection suite (`test/fault-injection/oms/`).
 *
 * THE WORLD holds the ground truth the OMS can never see directly: which
 * signed orders (by salt) the venue holds, their status and matched size, and
 * which transmissions are still travelling (a "hang", or a transmission whose
 * sender crashed). A hang may already have ARRIVED (`HANG_ARRIVED`, r3): the
 * venue holds and can match the order while its answer still travels, so a
 * fill or an observation can reach the OMS before the placement answer
 * (WP270-R3-01). Each OMS incarnation gets its own port wrappers; a crash
 * kills the wrappers (every later call throws), so a dead process can neither
 * write nor send, while the world carries on.
 *
 * THE ORACLE knows nothing of the OMS's state machine or gate. It records
 * only what the harness itself caused or delivered, and decides from that:
 *
 *   closed(A) holds for an earlier attempt A (by salt) of a group when no
 *   transmission of A can still ARRIVE (create the order) and
 *   - E1: the venue never received A and no transmission of A is travelling;
 *   - E2: every transmission of A came back to the OMS as a definitive
 *         non-placement (REJECTED, a documented REFUSED, NOT_SENT) and none
 *         is travelling; transmissions an accepted, fresh ABSENT (E3) already
 *         accounted for are not counted again;
 *   - E3: the OMS ACCEPTED an ABSENT answer for A whose read was FRESH: made
 *         after A's last transmission started, while none was travelling; or
 *   - E4: the OMS ACCEPTED a fresh PRESENT answer showing A's order terminal
 *         (CANCELED, or fully matched), or accepted fills summing to A's size.
 *
 * It asserts, as the harness drives the OMS:
 *   S1  when the venue is asked to sign a NEW salt for a group, every earlier
 *       attempt of that group is closed(A) (work-plan acceptance 2);
 *   S2  ground truth agrees: no earlier attempt of the group is live at the
 *       venue or travelling (never two live orders for one slot);
 *   S3  an attempt is never transmitted after a newer salt was signed for its
 *       group (a superseded signed order is never resent);
 *   S4  at the end, every salt the venue ever received is known to the
 *       current OMS (never forgotten);
 *   S5  a salt reaches the venue a second time only after the OMS accepted a
 *       fresh ABSENT for it since its last transmission (the same signed order
 *       is resent only on the documented path, never blindly);
 *   S6  when the OMS ABANDONS an attempt (closes it without a placement, which
 *       opens its group's gate), the attempt is closed(A) at that moment: the
 *       harness reports every abandonment the OMS accepted, whatever it asked
 *       for (r1: the generator also asks to abandon ineligible attempts);
 *   S7  venue evidence for our own orders is never lost (r3, WP270-R3-01): a
 *       fill or an observation for an order the venue holds for one of our
 *       salts is never refused as an unknown venue order (the harness reports
 *       every such refusal, and does NOT deliver a retained fill again within
 *       the incarnation that retained it), and at the end every such order's
 *       recorded fills sum exactly to what the venue matched.
 * A travelling transmission that has already ARRIVED (`HANG_ARRIVED`: the
 * venue holds its order; only the answer is in transit) can create nothing
 * more, since one salt is one venue order: it does not hold an attempt open,
 * and its answer settling resets nothing (r3). For every other behaviour,
 * "can still arrive" and "travelling" are the same, as before.
 * Answers the OMS REFUSED never count as evidence; answers it accepted count
 * only if fresh, so a stale answer the OMS wrongly accepts is caught by S1.
 * An answer delivered into a call that died inside a store transaction may
 * have been applied durably (an ambiguous commit); the harness counts it as
 * accepted, again only if fresh.
 */

import type {
  CancelOutcome,
  LimitOrderRequest,
  OmsVenuePort,
  PlacementOutcome,
  ReconciliationRequest,
  SignOutcome,
  SignedOrderHandle,
} from "../../../../packages/oms/src/index.js";

import { FakeSignedOrder, MAKER, SIGNER, accepted, limitOrderAmounts, signatureFor, venueError, venueIdFor } from "./fake-venue.js";

export type Behavior =
  | "ACCEPT_LIVE"
  | "ACCEPT_DELAYED"
  | "REJECT"
  | "REFUSE_POST_ONLY"
  | "NOT_SENT"
  | "UNKNOWN_TIMEOUT"
  | "UNKNOWN_SOCKET"
  | "UNKNOWN_401"
  | "UNKNOWN_425"
  | "UNKNOWN_429"
  | "UNKNOWN_UNMATCHED"
  | "THROW"
  | "HANG"
  | "HANG_ARRIVED";

export const BEHAVIORS: readonly Behavior[] = [
  "ACCEPT_LIVE",
  "ACCEPT_DELAYED",
  "REJECT",
  "REFUSE_POST_ONLY",
  "NOT_SENT",
  "UNKNOWN_TIMEOUT",
  "UNKNOWN_SOCKET",
  "UNKNOWN_401",
  "UNKNOWN_425",
  "UNKNOWN_429",
  "UNKNOWN_UNMATCHED",
  "THROW",
  "HANG",
  "HANG_ARRIVED",
];

interface VenueOrder {
  readonly salt: string;
  readonly venueOrderId: string;
  status: "LIVE" | "CANCELED";
  /** Hundredths of a share. */
  matched: number;
  readonly original: number;
}

interface SaltLedger {
  readonly salt: string;
  readonly group: string;
  readonly signTick: number;
  received: number;
  travelling: number;
  /** Travelling transmissions that have not arrived yet: each may still create the order. */
  pending: number;
  lastSendTick: number;
  definitiveOnly: boolean;
  closedBy: string | null;
}

export interface ReadAnswer {
  readonly request: ReconciliationRequest;
  readonly readTick: number;
  readonly fresh: boolean;
  readonly answer: Record<string, unknown>;
  readonly terminal: boolean;
  readonly absent: boolean;
}

/**
 * A transmission still travelling: one `postOrder`, or one whole `postOrders`
 * batch (a batch is ONE HTTP request in the adapter, so its entries travel and
 * settle together).
 */
export interface Hang {
  readonly salts: readonly string[];
  readonly resolve: (outcomes: readonly PlacementOutcome[]) => void;
  /** False once its incarnation died: the answer then reaches no one, but the world still decides arrival. */
  live: boolean;
  /** `HANG_ARRIVED`: the orders reached the venue when sent; only the answers travel. */
  readonly arrivedAtSend: boolean;
}

export class OracleViolation extends Error {}

/** Exact hundredths → decimal string. */
export function centi(n: number): string {
  const whole = Math.floor(n / 100);
  const frac = n % 100;
  if (frac === 0) return String(whole);
  return `${String(whole)}.${String(frac).padStart(2, "0")}`.replace(/0$/u, "");
}

export class SimWorld {
  tick = 0;
  readonly orders = new Map<string, VenueOrder>();
  readonly ledger = new Map<string, SaltLedger>();
  readonly receipts: string[] = [];
  readonly hangs: Hang[] = [];
  readonly violations: string[] = [];
  /** The token id that names each group (one token per group, so a sign request identifies its group). */
  readonly groupOfToken = new Map<string, string>();
  /** Supplies the behavior of the next transmission. */
  nextBehavior: () => Behavior = () => "ACCEPT_LIVE";
  /** For UNKNOWN outcomes and hang arrivals: does the order come to exist? */
  existsOnUnknown: () => boolean = () => true;
  #salt = 5000;

  fail(message: string): void {
    this.violations.push(message);
  }

  /** A port bound to one OMS incarnation; `alive()` false makes every call throw. */
  venuePort(alive: () => boolean): OmsVenuePort {
    const guard = (): void => {
      if (!alive()) throw new Error("dead incarnation");
    };
    return {
      createLimitOrder: async (request: LimitOrderRequest): Promise<SignOutcome> => {
        guard();
        return this.#sign(request);
      },
      postOrder: async (order: SignedOrderHandle): Promise<PlacementOutcome> => {
        guard();
        const [outcome] = await this.#transmit([order], alive, false);
        return outcome as PlacementOutcome;
      },
      postOrders: async (orders: readonly SignedOrderHandle[]): Promise<readonly PlacementOutcome[]> => {
        guard();
        return this.#transmit(orders, alive, true);
      },
      cancelOrder: async (orderId: string): Promise<CancelOutcome> => {
        guard();
        return this.#cancel(orderId);
      },
    };
  }

  #sign(request: LimitOrderRequest): SignOutcome {
    this.tick += 1;
    const group = this.groupOfToken.get(request.assetId);
    if (group === undefined) throw new Error("unknown token");
    // S1 and S2, checked BEFORE the new salt exists.
    for (const entry of this.ledger.values()) {
      if (entry.group !== group) continue;
      if (!this.#closed(entry)) this.fail(`S1: a new salt for group ${group} while salt ${entry.salt} is not authoritatively closed`);
      const order = this.orders.get(entry.salt);
      if ((order !== undefined && order.status === "LIVE" && order.matched < order.original) || entry.pending > 0) {
        this.fail(`S2: a new salt for group ${group} while salt ${entry.salt} is live at the venue or may still arrive there`);
      }
    }
    this.#salt += 1;
    const salt = String(this.#salt);
    this.ledger.set(salt, { salt, group, signTick: this.tick, received: 0, travelling: 0, pending: 0, lastSendTick: -1, definitiveOnly: true, closedBy: null });
    const payload = {
      builder: `0x${"0".repeat(64)}`,
      expiration: request.expirationUnixSeconds ?? 0,
      maker: MAKER,
      ...limitOrderAmounts(request.side, request.price, request.size),
      metadata: `0x${"0".repeat(64)}`,
      orderType: request.expirationUnixSeconds === undefined ? "GTC" : "GTD",
      postOnly: request.postOnly === true,
      salt,
      side: request.side,
      signature: signatureFor(salt),
      signatureType: 3,
      signer: SIGNER,
      timestamp: "1790000000000",
      tokenId: request.assetId,
    };
    return Object.freeze({ kind: "SIGNED", order: new FakeSignedOrder(payload) });
  }

  #closed(entry: SaltLedger): boolean {
    // A transmission that may still arrive may yet create the order: nothing closes the attempt meanwhile.
    if (entry.pending > 0) return false;
    if (entry.received === 0) return true;
    if (entry.definitiveOnly) return true;
    return entry.closedBy !== null;
  }

  /**
   * One transmission unit (a single order, or a whole batch). The unit's
   * behavior is drawn once: NOT_SENT, THROW and HANG apply to the whole unit
   * (a refused batch answers a NOT_SENT list whose length need not match:
   * WP-260 I-R2-2); otherwise each entry draws its own answer.
   */
  async #transmit(orders: readonly SignedOrderHandle[], alive: () => boolean, batch: boolean): Promise<readonly PlacementOutcome[]> {
    this.tick += 1;
    const entries = orders.map((order) => {
      const entry = this.ledger.get(order.identity.salt);
      if (entry === undefined) throw new Error("transmission of an unknown salt");
      return entry;
    });
    // S3: a superseded signed order is never resent.
    for (const entry of entries) {
      for (const other of this.ledger.values()) {
        if (other.group === entry.group && other.signTick > entry.signTick) {
          this.fail(`S3: salt ${entry.salt} transmitted after the newer salt ${other.salt} was signed`);
        }
      }
    }
    const unit = this.nextBehavior();
    if (unit === "NOT_SENT") {
      const answer: PlacementOutcome = { kind: "NOT_SENT", error: venueError("INVALID_REQUEST", "NOT_SENT") };
      return new Array<PlacementOutcome>(batch ? 1 + (this.tick % (orders.length + 1)) : 1).fill(answer);
    }
    for (const entry of entries) {
      // S5: the same signed order reaches the venue again only after an accepted, fresh ABSENT (§9.11 step 9).
      if (entry.received > 0 && (entry.closedBy === null || !entry.closedBy.startsWith("E3"))) {
        this.fail(`S5: salt ${entry.salt} resent without an authoritative ABSENT since its last transmission`);
      }
      // That fresh ABSENT accounted for every earlier transmission (none travelling, read after the last one):
      // E2 now concerns only this transmission and later ones. (r1: a definitive rejection of a retransmission
      // after E3 closes the attempt; the oracle had kept the first, unknown, transmission against it.)
      if (entry.closedBy !== null && entry.closedBy.startsWith("E3")) entry.definitiveOnly = true;
      entry.received += 1;
      entry.lastSendTick = this.tick;
      entry.closedBy = null;
      this.receipts.push(entry.salt);
    }
    if (unit === "HANG" || unit === "HANG_ARRIVED") {
      for (const entry of entries) {
        entry.definitiveOnly = false;
        entry.travelling += 1;
        // The venue already holds the order (it can be matched and observed); only the answer still travels.
        if (unit === "HANG_ARRIVED") this.#create(entry.salt);
        else entry.pending += 1;
      }
      return new Promise<readonly PlacementOutcome[]>((resolve) => {
        this.hangs.push({ salts: entries.map((entry) => entry.salt), resolve, live: alive(), arrivedAtSend: unit === "HANG_ARRIVED" });
      });
    }
    if (unit === "THROW") {
      for (const entry of entries) {
        entry.definitiveOnly = false;
        if (this.existsOnUnknown()) this.#create(entry.salt);
      }
      throw new Error("socket hang up");
    }
    return entries.map((entry, index) => {
      const behavior = index === 0 ? unit : this.nextBehavior();
      return this.#answer(entry, behavior === "HANG" || behavior === "HANG_ARRIVED" || behavior === "THROW" || behavior === "NOT_SENT" ? "UNKNOWN_SOCKET" : behavior);
    });
  }

  #create(salt: string): void {
    if (!this.orders.has(salt)) this.orders.set(salt, { salt, venueOrderId: venueIdFor(salt), status: "LIVE", matched: 0, original: 100 });
  }

  #answer(entry: SaltLedger, behavior: Behavior): PlacementOutcome {
    const existing = this.orders.get(entry.salt);
    switch (behavior) {
      case "ACCEPT_LIVE":
      case "ACCEPT_DELAYED":
        entry.definitiveOnly = false;
        this.#create(entry.salt);
        return accepted(venueIdFor(entry.salt), behavior === "ACCEPT_LIVE" || existing !== undefined ? "LIVE" : "DELAYED");
      case "REJECT":
      case "REFUSE_POST_ONLY":
        if (existing !== undefined) {
          // The same signed order is already at the venue: it is that order (no second one).
          entry.definitiveOnly = false;
          return accepted(venueIdFor(entry.salt));
        }
        return behavior === "REJECT"
          ? { kind: "REJECTED", reason: "INSUFFICIENT_BALANCE_OR_ALLOWANCE" }
          : { kind: "REFUSED", error: venueError("POST_ONLY_MODE", "NOT_APPLIED", 79) };
      default: {
        entry.definitiveOnly = false;
        if (this.existsOnUnknown()) this.#create(entry.salt);
        const kind =
          behavior === "UNKNOWN_TIMEOUT"
            ? "TIMEOUT"
            : behavior === "UNKNOWN_SOCKET"
              ? "TRANSPORT_FAILURE"
              : behavior === "UNKNOWN_401"
                ? "AUTHENTICATION_REJECTED"
                : behavior === "UNKNOWN_425"
                  ? "ENGINE_RESTARTING"
                  : behavior === "UNKNOWN_429"
                    ? "RATE_LIMITED"
                    : null;
        return kind === null
          ? { kind: "UNKNOWN", reason: "SDK_UNMATCHED", error: null }
          : { kind: "UNKNOWN", reason: "ERROR", error: venueError(kind, "UNKNOWN", 1) };
      }
    }
  }

  /** Settle a travelling transmission: the world decides whether each entry arrived, then answers (if anyone listens). */
  settleHang(index: number, acceptIfArrived: boolean): void {
    const hang = this.hangs[index];
    if (hang === undefined) return;
    this.hangs.splice(index, 1);
    this.tick += 1;
    const outcomes: PlacementOutcome[] = [];
    for (const salt of hang.salts) {
      const entry = this.ledger.get(salt);
      if (hang.arrivedAtSend) {
        // Arrived when sent: the order is there, and only its answer comes back now; nothing new can happen.
        if (entry !== undefined) entry.travelling -= 1;
        outcomes.push(acceptIfArrived ? accepted(venueIdFor(salt)) : { kind: "UNKNOWN", reason: "ERROR", error: venueError("TIMEOUT", "UNKNOWN") });
        continue;
      }
      const arrived = this.existsOnUnknown();
      if (arrived) this.#create(salt);
      if (entry !== undefined) {
        entry.travelling -= 1;
        entry.pending -= 1;
        entry.lastSendTick = this.tick;
        entry.closedBy = null;
      }
      outcomes.push(arrived && acceptIfArrived ? accepted(venueIdFor(salt)) : { kind: "UNKNOWN", reason: "ERROR", error: venueError("TIMEOUT", "UNKNOWN") });
    }
    hang.resolve(outcomes);
  }

  #cancel(venueOrderId: string): CancelOutcome {
    this.tick += 1;
    const order = [...this.orders.values()].find((candidate) => candidate.venueOrderId === venueOrderId);
    if (order === undefined || order.status !== "LIVE" || order.matched >= order.original) {
      return { kind: "COMPLETED", canceled: [], notCanceled: [{ orderId: venueOrderId, reason: "Order not found or already canceled" }] };
    }
    order.status = "CANCELED";
    return { kind: "COMPLETED", canceled: [venueOrderId], notCanceled: [] };
  }

  /** The venue matches `amount` hundredths of a live order. Returns the fill to deliver, if any. */
  match(salt: string, amount: number): { readonly shares: string; readonly venueOrderId: string } | undefined {
    const order = this.orders.get(salt);
    if (order === undefined || order.status !== "LIVE") return undefined;
    const take = Math.min(amount, order.original - order.matched);
    if (take <= 0) return undefined;
    order.matched += take;
    this.tick += 1;
    return { shares: centi(take), venueOrderId: order.venueOrderId };
  }

  /** A truthful authoritative read, made NOW, for a request. */
  read(request: ReconciliationRequest): ReadAnswer {
    this.tick += 1;
    const entry = this.ledger.get(request.salt);
    // Fresh: made after the last send, while no transmission may still arrive (an arrived one cannot change it).
    const fresh = entry !== undefined && entry.pending === 0 && this.tick > entry.lastSendTick;
    const order = this.orders.get(request.salt);
    if (order === undefined) {
      // The truthful reconciler attests quiescence exactly when nothing of this attempt is travelling and the read follows its last send.
      return {
        request,
        readTick: this.tick,
        fresh,
        terminal: false,
        absent: true,
        answer: { requestId: request.requestId, submissionAttemptId: request.submissionAttemptId, verdict: "ABSENT", transmissionQuiescent: fresh },
      };
    }
    const full = order.matched >= order.original;
    const status = order.status === "CANCELED" ? "CANCELED" : full ? "MATCHED" : "LIVE";
    return {
      request,
      readTick: this.tick,
      fresh,
      terminal: status !== "LIVE",
      absent: false,
      answer: {
        requestId: request.requestId,
        submissionAttemptId: request.submissionAttemptId,
        verdict: "PRESENT",
        order: { venueOrderId: order.venueOrderId, status, sizeMatched: centi(order.matched), originalSize: centi(order.original) },
      },
    };
  }

  /** Record that the OMS ACCEPTED an answer: evidence only if the read was fresh relative to the last send. */
  answerAccepted(read: ReadAnswer): void {
    const entry = this.ledger.get(read.request.salt);
    if (entry === undefined) return;
    const freshNow = read.fresh && read.readTick > entry.lastSendTick;
    if (!freshNow) return;
    if (read.absent) entry.closedBy = `E3@${String(read.readTick)}`;
    else if (read.terminal) entry.closedBy = `E4@${String(read.readTick)}`;
  }

  /** Record that the OMS accepted fills summing to the order's full size. */
  filledAccepted(salt: string): void {
    const entry = this.ledger.get(salt);
    const order = this.orders.get(salt);
    if (entry !== undefined && order !== undefined && order.matched >= order.original) entry.closedBy = "E4:filled";
  }

  /** S6: the OMS accepted an abandonment of this salt's attempt (or may have, inside a killed transaction). */
  abandonAccepted(salt: string): void {
    const entry = this.ledger.get(salt);
    if (entry !== undefined && !this.#closed(entry)) this.fail(`S6: salt ${salt} abandoned while not authoritatively closed`);
  }

  /** The venue's order with this venue order id, if the venue holds one (for S7). */
  orderByVenueId(venueOrderId: string): VenueOrder | undefined {
    return [...this.orders.values()].find((order) => order.venueOrderId === venueOrderId);
  }

  /** S7: the OMS refused evidence (a fill or an observation) for this venue order id as an unknown venue order. */
  evidenceRefusedAsUnknown(venueOrderId: string, what: string): void {
    const order = this.orderByVenueId(venueOrderId);
    if (order !== undefined) this.fail(`S7: ${what} for salt ${order.salt}'s order (which the venue holds) was refused as an unknown venue order`);
  }

  /** S7, at the end: every order the venue holds for our salts has recorded fills summing exactly to what the venue matched. */
  checkFillsKept(omsOrders: readonly { readonly venueOrderId: string | null; readonly filledShares: string }[]): void {
    for (const order of this.orders.values()) {
      const oms = omsOrders.find((candidate) => candidate.venueOrderId === order.venueOrderId);
      if (oms === undefined) this.fail(`S7: the venue holds salt ${order.salt}'s order, but no OMS order holds its venue order id`);
      else if (oms.filledShares !== centi(order.matched)) {
        this.fail(`S7: salt ${order.salt}: the OMS recorded ${oms.filledShares} filled; the venue matched ${centi(order.matched)}`);
      }
    }
  }

  /** S4: every received salt is known to the current OMS. */
  checkNeverForgotten(knownSalts: ReadonlySet<string>): void {
    for (const salt of new Set(this.receipts)) {
      if (!knownSalts.has(salt)) this.fail(`S4: salt ${salt} reached the venue but the OMS has forgotten it`);
    }
  }
}
