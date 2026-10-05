/**
 * The reconciliation suite's simulated venue (WP-290). It holds the GROUND
 * TRUTH the OMS and the coordinator never see directly: which signed orders
 * (by salt) the venue holds, their matched sizes, the account's trades, its
 * token positions and its collateral. It reaches no network and holds no key:
 * a "signature" is a synthetic string (`fake-venue.ts`), used only to prove it
 * never reaches the store in clear.
 *
 * It gives each OMS incarnation a venue port (sign, post, cancel) and gives
 * the coordinator an `AccountReadPort` in the normalized shapes of
 * `packages/oms/src/reconciliation/ports.ts`. Every read can be overridden by
 * a FAULT (a throw, a malformed or incomplete answer, a v1 route, a
 * conflicting or regressing view) to construct the ambiguity cases.
 *
 * Transmissions arrive at once, except `LATE_ARRIVAL`: the order reaches the
 * venue `lateMs` after it was sent while the OMS sees a timeout. That is the
 * case the quiescence horizon exists for.
 */

import { addDecimal, compareDecimal, mulDecimal, subDecimal } from "../../../../packages/decimal/src/index.js";
import type {
  AccountReadPort,
  CancelOutcome,
  LimitOrderRequest,
  OmsVenuePort,
  PlacementOutcome,
  SignOutcome,
  SignedOrderHandle,
} from "../../../../packages/oms/src/index.js";
import { FakeSignedOrder, MAKER, SIGNER, accepted, signatureFor, venueError, venueIdFor } from "../../../unit/oms/support/fake-venue.js";

export type Transmission =
  | "ACCEPT_LIVE"
  /** The order reaches the venue; the answer is lost (a socket failure). */
  | "UNKNOWN_EXISTS"
  /** The order never reaches the venue; the answer is lost. */
  | "UNKNOWN_ABSENT"
  /** A 425 restart: never reaches the venue (`ENGINE_RESTARTING`, the retransmission path). */
  | "UNKNOWN_425_ABSENT"
  /** The order reaches the venue `lateMs` after it was sent; the OMS sees a timeout. */
  | "LATE_ARRIVAL"
  | "NOT_SENT"
  | "REJECT";

export interface VenueOrder {
  readonly salt: string;
  readonly venueOrderId: string;
  readonly tokenId: string;
  readonly side: "BUY" | "SELL";
  readonly price: string;
  readonly original: string;
  matched: string;
  status: "LIVE" | "CANCELED";
  readonly foreign: boolean;
}

export interface VenueTrade {
  readonly venueTradeId: string;
  readonly venueOrderId: string;
  readonly tokenId: string;
  readonly side: "BUY" | "SELL";
  readonly shares: string;
  readonly price: string;
  readonly role: "MAKER" | "TAKER";
  feeAmount: string | null;
  readonly feeAssetId: string | null;
  readonly matchedAt: string;
  status: string;
  readonly transactionHash: string;
}

/** A read override: given the default answer, return another, or throw (a missing read). */
export type ReadFault = (answer: () => unknown) => unknown;

export interface ReadFaults {
  listOpenOrders?: ReadFault;
  readOrder?: (venueOrderId: string, answer: () => unknown) => unknown;
  listTrades?: ReadFault;
  readPositions?: ReadFault;
  readCollateral?: ReadFault;
  readApprovals?: ReadFault;
  readWalletMember?: (member: { readonly kind: string; readonly value: string }, answer: () => unknown) => unknown;
  /** Called before every read, with its name (e.g. to advance the clock). */
  onRead?: (name: string) => void;
}

export const EXCHANGE = "0xE111180000d2663C0091e4f400237545B87B996B";

export class ReconWorld {
  readonly orders = new Map<string, VenueOrder>();
  readonly trades: VenueTrade[] = [];
  readonly positions = new Map<string, string>();
  collateral: string;
  readonly receipts: string[] = [];
  readonly violations: string[] = [];
  readonly approvals = new Map<string, boolean>([[EXCHANGE, true]]);
  readonly walletMembers = new Map<string, { state: string; transactionHash: string | null; credited: string | null }>();
  /** Signed facts by salt. */
  readonly signed = new Map<string, { readonly tokenId: string; readonly side: "BUY" | "SELL"; readonly price: string; readonly size: string }>();
  readonly pending: { readonly salt: string; readonly atMs: number }[] = [];
  nextTransmission: () => Transmission = () => "ACCEPT_LIVE";
  lateMs = 1000;
  faults: ReadFaults = {};
  readonly #now: () => number;
  readonly #collateralAsset: string;
  #salt = 7000;
  #trade = 0;
  #foreign = 0;

  constructor(options: { readonly now: () => number; readonly collateral: string; readonly collateralAssetId: string }) {
    this.#now = options.now;
    this.collateral = options.collateral;
    this.#collateralAsset = options.collateralAssetId;
  }

  fail(message: string): void {
    this.violations.push(message);
  }

  /** Orders whose late transmission has arrived by now are created. */
  settleArrivals(): void {
    const now = this.#now();
    for (let index = 0; index < this.pending.length; ) {
      const entry = this.pending[index] as { salt: string; atMs: number };
      if (entry.atMs <= now) {
        this.pending.splice(index, 1);
        this.#create(entry.salt);
      } else {
        index += 1;
      }
    }
  }

  isPending(salt: string): boolean {
    return this.pending.some((entry) => entry.salt === salt);
  }

  /** A venue port bound to one OMS incarnation; `alive()` false makes every call throw. */
  venuePort(alive: () => boolean): OmsVenuePort {
    const guard = (): void => {
      if (!alive()) throw new Error("dead incarnation");
      this.settleArrivals();
    };
    return {
      createLimitOrder: async (request: LimitOrderRequest): Promise<SignOutcome> => {
        guard();
        return this.#sign(request);
      },
      postOrder: async (order: SignedOrderHandle): Promise<PlacementOutcome> => {
        guard();
        return this.#transmit(order, this.nextTransmission());
      },
      postOrders: async (orders: readonly SignedOrderHandle[]): Promise<readonly PlacementOutcome[]> => {
        guard();
        return orders.map((order) => this.#transmit(order, this.nextTransmission()));
      },
      cancelOrder: async (venueOrderId: string): Promise<CancelOutcome> => {
        guard();
        return this.cancel(venueOrderId);
      },
    };
  }

  #sign(request: LimitOrderRequest): SignOutcome {
    // Never two live orders for one slot (one token is one group in this suite).
    for (const [salt, facts] of this.signed) {
      if (facts.tokenId !== request.assetId || facts.side !== request.side) continue;
      const order = this.orders.get(salt);
      if ((order !== undefined && order.status === "LIVE" && compareDecimal(order.matched, order.original) < 0) || this.isPending(salt)) {
        this.fail(`S2: a new salt for ${request.assetId} while salt ${salt} is live at the venue or may still arrive`);
      }
    }
    this.#salt += 1;
    const salt = String(this.#salt);
    this.signed.set(salt, { tokenId: request.assetId, side: request.side, price: request.price, size: request.size });
    const payload = {
      builder: `0x${"0".repeat(64)}`,
      expiration: request.expirationUnixSeconds ?? 0,
      maker: MAKER,
      makerAmount: "1000000",
      metadata: `0x${"0".repeat(64)}`,
      orderType: request.expirationUnixSeconds === undefined ? "GTC" : "GTD",
      postOnly: request.postOnly === true,
      salt,
      side: request.side,
      signature: signatureFor(salt),
      signatureType: 3,
      signer: SIGNER,
      takerAmount: "2000000",
      timestamp: "1790000000000",
      tokenId: request.assetId,
    };
    return Object.freeze({ kind: "SIGNED", order: new FakeSignedOrder(payload) });
  }

  #transmit(order: SignedOrderHandle, behavior: Transmission): PlacementOutcome {
    const salt = order.identity.salt;
    this.receipts.push(salt);
    switch (behavior) {
      case "ACCEPT_LIVE":
        this.#create(salt);
        return accepted(venueIdFor(salt), "LIVE");
      case "UNKNOWN_EXISTS":
        this.#create(salt);
        return { kind: "UNKNOWN", reason: "ERROR", error: venueError("TRANSPORT_FAILURE", "UNKNOWN", null) };
      case "UNKNOWN_ABSENT":
        return { kind: "UNKNOWN", reason: "ERROR", error: venueError("TRANSPORT_FAILURE", "UNKNOWN", null) };
      case "UNKNOWN_425_ABSENT":
        return { kind: "UNKNOWN", reason: "ERROR", error: venueError("ENGINE_RESTARTING", "UNKNOWN", 1) };
      case "LATE_ARRIVAL":
        this.pending.push({ salt, atMs: this.#now() + this.lateMs });
        return { kind: "UNKNOWN", reason: "ERROR", error: venueError("TIMEOUT", "UNKNOWN", null) };
      case "NOT_SENT":
        return { kind: "NOT_SENT", error: venueError("INVALID_REQUEST", "NOT_SENT") };
      case "REJECT":
        if (this.orders.has(salt)) return accepted(venueIdFor(salt), "LIVE");
        return { kind: "REJECTED", reason: "INSUFFICIENT_BALANCE_OR_ALLOWANCE" };
    }
  }

  #create(salt: string): void {
    if (this.orders.has(salt)) return;
    const facts = this.signed.get(salt);
    if (facts === undefined) throw new Error("an unsigned salt reached the venue");
    this.orders.set(salt, {
      salt,
      venueOrderId: venueIdFor(salt),
      tokenId: facts.tokenId,
      side: facts.side,
      price: facts.price,
      original: facts.size,
      matched: "0",
      status: "LIVE",
      foreign: false,
    });
  }

  cancel(venueOrderId: string): CancelOutcome {
    this.settleArrivals();
    const order = [...this.orders.values()].find((candidate) => candidate.venueOrderId === venueOrderId);
    if (order === undefined || order.status !== "LIVE" || compareDecimal(order.matched, order.original) >= 0) {
      return { kind: "COMPLETED", canceled: [], notCanceled: [{ orderId: venueOrderId, reason: "Order not found or already canceled" }] };
    }
    order.status = "CANCELED";
    return { kind: "COMPLETED", canceled: [venueOrderId], notCanceled: [] };
  }

  /** An order of the account placed outside the OMS (a manual order, another tool): unmatched activity. */
  placeForeign(facts: { readonly tokenId: string; readonly side: "BUY" | "SELL"; readonly price: string; readonly size: string }): VenueOrder {
    this.#foreign += 1;
    const salt = `foreign-${String(this.#foreign)}`;
    const order: VenueOrder = {
      salt,
      venueOrderId: `venue-${salt}`,
      tokenId: facts.tokenId,
      side: facts.side,
      price: facts.price,
      original: facts.size,
      matched: "0",
      status: "LIVE",
      foreign: true,
    };
    this.orders.set(salt, order);
    return order;
  }

  /**
   * The venue matches `shares` of a live order (a maker fill at the order's price, fee 0, settled). A fee charged
   * in the collateral (`feeAssetId`, r4) leaves the collateral too.
   */
  match(
    salt: string,
    shares: string,
    options: { readonly status?: string; readonly feeAmount?: string | null; readonly feeAssetId?: string } = {},
  ): VenueTrade | undefined {
    this.settleArrivals();
    const order = this.orders.get(salt);
    if (order === undefined || order.status !== "LIVE") return undefined;
    const left = subDecimal(order.original, order.matched);
    const take = compareDecimal(shares, left) > 0 ? left : shares;
    if (compareDecimal(take, "0") <= 0) return undefined;
    order.matched = addDecimal(order.matched, take);
    this.#trade += 1;
    const trade: VenueTrade = {
      venueTradeId: `trade-${String(this.#trade)}`,
      venueOrderId: order.venueOrderId,
      tokenId: order.tokenId,
      side: order.side,
      shares: take,
      price: order.price,
      role: "MAKER",
      feeAmount: options.feeAmount === undefined ? "0" : options.feeAmount,
      feeAssetId: options.feeAssetId ?? null,
      matchedAt: "2026-10-03T00:00:00Z",
      status: options.status ?? "CONFIRMED",
      transactionHash: `0x${String(this.#trade).padStart(64, "0")}`,
    };
    this.trades.push(trade);
    const notional = mulDecimal(take, order.price);
    const position = this.positions.get(order.tokenId) ?? "0";
    if (order.side === "BUY") {
      this.positions.set(order.tokenId, addDecimal(position, take));
      this.collateral = subDecimal(this.collateral, notional);
    } else {
      this.positions.set(order.tokenId, subDecimal(position, take));
      this.collateral = addDecimal(this.collateral, notional);
    }
    if (trade.feeAssetId === this.#collateralAsset && trade.feeAmount !== null) this.collateral = subDecimal(this.collateral, trade.feeAmount);
    return trade;
  }

  /**
   * The trade's settlement FAILS (r4): a FAILED settlement never moved the chain (ADR-006 §5), so every holding
   * its match moved here (the token, the collateral, a collateral fee) moves back. The status is the REST
   * spelling's plain form, as `match` writes it.
   */
  failTrade(trade: VenueTrade): void {
    trade.status = "FAILED";
    const notional = mulDecimal(trade.shares, trade.price);
    const position = this.positions.get(trade.tokenId) ?? "0";
    if (trade.side === "BUY") {
      this.positions.set(trade.tokenId, subDecimal(position, trade.shares));
      this.collateral = addDecimal(this.collateral, notional);
    } else {
      this.positions.set(trade.tokenId, addDecimal(position, trade.shares));
      this.collateral = subDecimal(this.collateral, notional);
    }
    if (trade.feeAssetId === this.#collateralAsset && trade.feeAmount !== null) this.collateral = addDecimal(this.collateral, trade.feeAmount);
  }

  /** A holding change no activity explains (tokens sent to the wallet, a deposit). */
  adjustPosition(tokenId: string, delta: string): void {
    this.positions.set(tokenId, addDecimal(this.positions.get(tokenId) ?? "0", delta));
  }

  adjustCollateral(delta: string): void {
    this.collateral = addDecimal(this.collateral, delta);
  }

  orderView(order: VenueOrder): Record<string, unknown> {
    const full = compareDecimal(order.matched, order.original) === 0;
    return {
      venueOrderId: order.venueOrderId,
      tokenId: order.tokenId,
      side: order.side,
      price: order.price,
      originalSize: order.original,
      sizeMatched: order.matched,
      status: order.status === "CANCELED" ? "CANCELED" : full ? "MATCHED" : "LIVE",
    };
  }

  tradeView(trade: VenueTrade): Record<string, unknown> {
    return {
      venueTradeId: trade.venueTradeId,
      status: trade.status,
      transactionHash: trade.transactionHash,
      ownershipUndetermined: false,
      ownLegs: [
        {
          venueOrderId: trade.venueOrderId,
          role: trade.role,
          tokenId: trade.tokenId,
          side: trade.side,
          shares: trade.shares,
          price: trade.price,
          feeAmount: trade.feeAmount,
          feeAssetId: trade.feeAssetId,
          matchedAt: trade.matchedAt,
        },
      ],
    };
  }

  /** The authoritative reads, in the normalized shapes (`ports.ts`), with the configured faults applied. */
  readPort(): AccountReadPort {
    const read = <T>(name: string, fault: ReadFault | undefined, answer: () => T): Promise<unknown> => {
      this.settleArrivals();
      this.faults.onRead?.(name);
      return Promise.resolve(fault === undefined ? answer() : fault(answer));
    };
    return {
      listOpenOrders: () =>
        read("listOpenOrders", this.faults.listOpenOrders, () => ({
          route: "/data/orders",
          complete: true,
          orders: [...this.orders.values()]
            .filter((order) => order.status === "LIVE" && compareDecimal(order.matched, order.original) < 0)
            .map((order) => this.orderView(order)),
        })),
      readOrder: (venueOrderId: string) => {
        const answer = (): unknown => {
          const order = [...this.orders.values()].find((candidate) => candidate.venueOrderId === venueOrderId);
          return order === undefined ? { route: "/data/order", found: false } : { route: "/data/order", found: true, order: this.orderView(order) };
        };
        const fault = this.faults.readOrder;
        return read("readOrder", fault === undefined ? undefined : (inner) => fault(venueOrderId, inner), answer);
      },
      listTrades: () =>
        read("listTrades", this.faults.listTrades, () => ({ route: "/data/trades", complete: true, trades: this.trades.map((trade) => this.tradeView(trade)) })),
      readPositions: () =>
        read("readPositions", this.faults.readPositions, () => ({
          route: "/v2/positions",
          complete: true,
          positions: [...this.positions].filter(([, size]) => compareDecimal(size, "0") !== 0).map(([tokenId, size]) => ({ tokenId, size })),
        })),
      readCollateral: () =>
        read("readCollateral", this.faults.readCollateral, () => ({ source: "ONCHAIN_ERC20_BALANCE", assetId: this.#collateralAsset, balance: this.collateral })),
      readApprovals: () =>
        read("readApprovals", this.faults.readApprovals, () => ({
          route: "/v2/approvals",
          approvals: [...this.approvals].map(([spender, approved]) => ({ spender, approved })),
        })),
      readWalletMember: (member) => {
        const answer = (): unknown => {
          const key = `${member.kind === "HASH" ? "hash" : "id"}:${member.value}`;
          return this.walletMembers.get(key) ?? { state: "NOT_FOUND", transactionHash: null, credited: null };
        };
        const fault = this.faults.readWalletMember;
        return read("readWalletMember", fault === undefined ? undefined : (inner) => fault(member, inner), answer);
      },
    };
  }
}
