/**
 * Order reservations — what a planned order must hold before it is submitted
 * (§9.10 "Reserve collateral/inventory before submission"; ADR-006 §7 "Buying
 * consumes pUSD; selling requires outcome-token inventory", venue report
 * §10.2).
 *
 * - A BUY holds pUSD: `price × size`, plus any caller-declared
 *   `additionalCollateral` (fee headroom; fees are not modelled here, and the
 *   fee rounding direction is still undocumented, U-16). The collateral is
 *   always the registry's pUSD id: USDC.e is never trading collateral.
 * - A SELL holds the outcome token itself: `size` of it. A sell whose token is
 *   not available is REFUSED (work plan WP-300 acceptance "Sell plan requires
 *   available outcome-token inventory"). There is no short sale and no
 *   borrowing.
 *
 * The builder is pure; the book (or the service) enforces availability and
 * the single-reservation-per-holder rule.
 */

import { addDecimal, compareDecimal, isCanonicalDecimalString, mulDecimal, type DecimalString } from "@polymarket-bot/decimal";

import type { AssetRegistry } from "./assets.js";
import { ownData, ownNonEmptyString, ownNonNegativeAmount, ownPositiveAmount } from "./guards.js";
import type { InventoryBook, ReservationView, ReserveRequest } from "./inventory-book.js";
import { ok, refuse, type InventoryResult } from "./refusals.js";

export type OrderSide = "BUY" | "SELL";

export interface OrderReservationRequest {
  readonly reservationId: string;
  /** The order (or plan) the reservation is held for. */
  readonly orderRef: string;
  readonly accountRef: string;
  readonly side: OrderSide;
  /** The outcome token being bought or sold. */
  readonly tokenAssetId: string;
  /** Limit price in (0, 1]. */
  readonly price: DecimalString;
  /** Shares. */
  readonly size: DecimalString;
  /** BUY only: extra pUSD to hold (for example fee headroom). Default `"0"`. */
  readonly additionalCollateral?: DecimalString;
}

export function buildOrderReservation(
  registry: AssetRegistry,
  request: OrderReservationRequest,
): InventoryResult<ReserveRequest> {
  const reservationId = ownNonEmptyString(request, "reservationId");
  const orderRef = ownNonEmptyString(request, "orderRef");
  const accountRef = ownNonEmptyString(request, "accountRef");
  const side = ownData(request, "side");
  const tokenAssetId = ownNonEmptyString(request, "tokenAssetId");
  const price = ownData(request, "price");
  const size = ownPositiveAmount(request, "size");
  const extraRaw = ownData(request, "additionalCollateral");
  const additional = extraRaw === undefined ? "0" : ownNonNegativeAmount(request, "additionalCollateral");
  if (
    reservationId === undefined ||
    orderRef === undefined ||
    accountRef === undefined ||
    (side !== "BUY" && side !== "SELL") ||
    tokenAssetId === undefined ||
    size === undefined ||
    additional === undefined ||
    !isCanonicalDecimalString(price, { range: "UNIT_INTERVAL" }) ||
    compareDecimal(price, "0") <= 0
  ) {
    return refuse(
      "INVENTORY_INVALID_INPUT",
      "order reservation needs reservationId, orderRef, accountRef, side BUY|SELL, tokenAssetId, price in (0,1], positive size and a non-negative additionalCollateral",
    );
  }
  const token = registry.lookup(tokenAssetId);
  if (token === undefined) {
    return refuse("INVENTORY_UNKNOWN_ASSET", "the order's token is not registered", { assetId: tokenAssetId });
  }
  if (token.role !== "OUTCOME_TOKEN") {
    return refuse("INVENTORY_ASSET_ROLE_MISMATCH", "an order trades an outcome token, not collateral", {
      assetId: tokenAssetId,
      role: token.role,
    });
  }
  if (side === "SELL") {
    if (extraRaw !== undefined && compareDecimal(additional, "0") !== 0) {
      return refuse("INVENTORY_INVALID_INPUT", "additionalCollateral applies to BUY orders only");
    }
    return ok(Object.freeze({ reservationId, holderRef: orderRef, accountRef, assetId: tokenAssetId, amount: size }));
  }
  const amount = addDecimal(mulDecimal(price, size), additional);
  return ok(
    Object.freeze({ reservationId, holderRef: orderRef, accountRef, assetId: registry.pusdAssetId, amount }),
  );
}

/** Build and apply an order reservation on a book in one synchronous step. */
export function reserveForOrder(
  book: InventoryBook,
  request: OrderReservationRequest,
): InventoryResult<ReservationView> {
  const built = buildOrderReservation(book.registry, request);
  return built.ok ? book.reserve(built.value) : built;
}
