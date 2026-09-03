/**
 * Allocator account state — handoff §9.7.
 *
 * "Tracks commitments from both positions and open orders": account equity,
 * available pUSD, reserved pUSD, outcome-token inventory, reserved outcome
 * tokens, per-instance allocation, per-market/series/underlying/
 * resolution-window exposure. The state is a VALUE: construction validates and
 * derives, transitions return new deeply-frozen states, and nothing mutates.
 *
 * Boundary semantics, stated so a caller cannot mis-wire them:
 *
 * - `availableCollateral` is the pUSD committed NOWHERE — the caller's number
 *   must already exclude funds held against the supplied open orders. This
 *   package derives `reservedCollateral` (the §9.7 "reserved pUSD") from the
 *   open BUY orders plus applied live BUY reservations, and derives reserved
 *   outcome tokens from open SELL orders plus applied live SELL reservations.
 * - A state whose sell orders reserve more tokens than the owning instance
 *   holds is REFUSED at construction (`CAPITAL_OVERSELL_UNBACKED`; §9.14
 *   "Prevent double reservation").
 * - Positions and orders carry a per-instance attribution (§6 invariant 7:
 *   actual account state versus virtual strategy attribution stay separate;
 *   inventory checks are instance-scoped so one strategy cannot spend
 *   another's tokens).
 */

import { addDecimal, compareDecimal, mulDecimal } from "@polymarket-bot/decimal";
import {
  CodeStringSchema,
  InternalMarketIdSchema,
  NonEmptyStringSchema,
  NonNegativeMoneyStringSchema,
  NonNegativeSharesStringSchema,
  OutcomeSideSchema,
  PositiveDecimalStringSchema,
  PriceStringSchema,
  type MoneyString,
  // Referenced only as `typeof RunModeSchema` below; the runtime validation of
  // a run mode happens in `reserve.ts`, where the schema is a value.
  type RunModeSchema,
  type SharesString,
} from "@polymarket-bot/domain";
import { z } from "zod";

import { deepFreeze, ownEntry, setOwn, uuidShapedNotCanonical } from "./guards.js";
import {
  capitalFailure,
  capitalOk,
  capitalRefusal,
  contained,
  readInputAsData,
  type CapitalRefusal,
  type CapitalResult,
} from "./refusals.js";

/** Optional scope attribution for the §9.7 exposure dimensions. */
export const ScopeAttributionSchema = z.strictObject({
  seriesKey: CodeStringSchema.optional(),
  underlyingKey: CodeStringSchema.optional(),
  resolutionWindowKey: CodeStringSchema.optional(),
});
export type ScopeAttribution = z.infer<typeof ScopeAttributionSchema>;

/** One outcome-token holding attributed to a strategy instance. */
export const PositionHoldingSchema = z.strictObject({
  positionId: NonEmptyStringSchema,
  marketId: InternalMarketIdSchema,
  strategyInstanceId: CodeStringSchema,
  side: OutcomeSideSchema,
  shares: NonNegativeSharesStringSchema,
  /** Exact pUSD paid for the holding (the committed capital it represents). */
  costBasis: NonNegativeMoneyStringSchema,
  scope: ScopeAttributionSchema.optional(),
});
export type PositionHolding = z.infer<typeof PositionHoldingSchema>;

/** One open order commitment. BUY commits pUSD; SELL reserves tokens. */
export const OpenOrderCommitmentSchema = z.strictObject({
  orderId: NonEmptyStringSchema,
  marketId: InternalMarketIdSchema,
  strategyInstanceId: CodeStringSchema,
  side: OutcomeSideSchema,
  action: z.enum(["BUY", "SELL"]),
  price: PriceStringSchema,
  shares: PositiveDecimalStringSchema,
  scope: ScopeAttributionSchema.optional(),
});
export type OpenOrderCommitment = z.infer<typeof OpenOrderCommitmentSchema>;

export const LiveOwnerSchema = z.strictObject({
  marketId: InternalMarketIdSchema,
  strategyInstanceId: CodeStringSchema,
});
export type LiveOwner = z.infer<typeof LiveOwnerSchema>;

export const AllocatorStateInputSchema = z.strictObject({
  accountEquity: NonNegativeMoneyStringSchema,
  /** pUSD committed nowhere (see module header). */
  availableCollateral: NonNegativeMoneyStringSchema,
  positions: z.array(PositionHoldingSchema).readonly(),
  openOrders: z.array(OpenOrderCommitmentSchema).readonly(),
  /** ADR-011: at most one live owner per market. */
  liveOwners: z.array(LiveOwnerSchema).readonly(),
});
export type AllocatorStateInput = z.infer<typeof AllocatorStateInputSchema>;

/** An applied reservation (see `reserve.ts`). */
export interface AppliedReservation {
  readonly reservationId: string;
  readonly strategyInstanceId: string;
  readonly runMode: z.infer<typeof RunModeSchema>;
  readonly accountingMode: "LIVE" | "SHADOW";
  readonly marketId: string;
  readonly side: z.infer<typeof OutcomeSideSchema>;
  readonly action: "BUY" | "SELL";
  readonly price: string;
  readonly shares: SharesString;
  /** BUY: exact `price × shares`; SELL: `"0"` (a sell commits no new pUSD). */
  readonly cost: MoneyString;
  /** SELL: `shares` (reserved outcome tokens); BUY: `"0"`. */
  readonly reservedShares: SharesString;
  readonly scope?: ScopeAttribution;
}

/** The validated, derived, deeply-frozen allocator state. */
export interface AllocatorState {
  readonly accountEquity: MoneyString;
  readonly availableCollateral: MoneyString;
  /** Derived §9.7 "reserved pUSD": open BUY orders + applied live BUY reservations. */
  readonly reservedCollateral: MoneyString;
  readonly positions: readonly PositionHolding[];
  readonly openOrders: readonly OpenOrderCommitment[];
  readonly liveOwners: Readonly<Record<string, string>>;
  /** Applied LIVE reservations (consume collateral/inventory and exposure). */
  readonly reservations: readonly AppliedReservation[];
  /** Applied SHADOW reservations (independent shadow accounting, §9.7). */
  readonly shadowReservations: readonly AppliedReservation[];
}

/** Instance-scoped inventory key. `|` appears in no id grammar used here. */
export function inventoryKey(strategyInstanceId: string, marketId: string, side: string): string {
  return `${strategyInstanceId}|${marketId}|${side}`;
}

/** Held shares per instance-scoped inventory key. */
export function heldSharesByKey(state: {
  readonly positions: readonly PositionHolding[];
}): Readonly<Record<string, SharesString>> {
  const held: Record<string, SharesString> = {};
  for (const position of state.positions) {
    const key = inventoryKey(position.strategyInstanceId, position.marketId, position.side);
    // OWN read, OWN write (review round 5, the BLOCKER-1 sweep). An
    // `inventoryKey` always contains `|`, so it can never spell `"__proto__"`
    // and this site was never live — but the discipline is applied everywhere a
    // caller-derived key meets a table, so that the invariant is a property of
    // the code rather than of an argument about the key grammar.
    setOwn(held, key, addDecimal(ownEntry(held, key) ?? "0", position.shares));
  }
  return held;
}

/** Reserved shares per inventory key (open SELL orders + live SELL reservations). */
export function reservedSharesByKey(state: {
  readonly openOrders: readonly OpenOrderCommitment[];
  readonly reservations: readonly AppliedReservation[];
}): Readonly<Record<string, SharesString>> {
  const reserved: Record<string, SharesString> = {};
  for (const order of state.openOrders) {
    if (order.action !== "SELL") continue;
    const key = inventoryKey(order.strategyInstanceId, order.marketId, order.side);
    setOwn(reserved, key, addDecimal(ownEntry(reserved, key) ?? "0", order.shares));
  }
  for (const reservation of state.reservations) {
    if (reservation.action !== "SELL") continue;
    const key = inventoryKey(
      reservation.strategyInstanceId,
      reservation.marketId,
      reservation.side,
    );
    setOwn(reserved, key, addDecimal(ownEntry(reserved, key) ?? "0", reservation.shares));
  }
  return reserved;
}

function nonCanonicalIdRefusals(input: AllocatorStateInput): CapitalRefusal[] {
  const refusals: CapitalRefusal[] = [];
  const check = (label: string, value: string): void => {
    if (uuidShapedNotCanonical(value)) {
      refusals.push(
        capitalRefusal(
          "CAPITAL_UUID_NOT_CANONICAL",
          `${label} is UUID-shaped but not canonical lowercase (ADR-016 §2: refuse, never case-fold)`,
          { [label]: value },
        ),
      );
    }
  };
  for (const position of input.positions) check("positionId", position.positionId);
  for (const order of input.openOrders) check("orderId", order.orderId);
  return refusals;
}

/**
 * Validates and derives a frozen allocator state.
 *
 * Refuses (never repairs): schema failures, non-canonical UUID-shaped ids
 * (ADR-016), duplicate identifiers, more than one live owner per market
 * (ADR-011), and sell orders reserving more than the owning instance holds.
 *
 * READ AS DATA BEFORE IT IS PARSED, and CONTAINED (review round 5, BLOCKER 3 —
 * the same class the reviewer reported against `parseAllocatorCaps`, found by
 * the sweep across this package's public `unknown` surfaces). `safeParse` reads
 * properties, so a caller's getter runs inside it; `readInputAsData`
 * materializes the value first and the schema sees only that.
 */
export function createAllocatorState(input: unknown): CapitalResult<AllocatorState> {
  return contained(
    () => createAllocatorStateInner(input),
    (thrown) =>
      capitalFailure(
        capitalRefusal(
          "CAPITAL_INPUT_INVALID",
          "constructing the allocator state failed unexpectedly; a state that cannot be validated cannot be shown to conserve collateral or inventory (fail closed)",
          { thrown },
        ),
      ),
  );
}

function createAllocatorStateInner(input: unknown): CapitalResult<AllocatorState> {
  const read = readInputAsData(input, "state", "allocator state input");
  if (!read.ok) return capitalFailure(read.refusal);
  const parsed = AllocatorStateInputSchema.safeParse(read.value);
  if (!parsed.success) {
    return capitalFailure(
      capitalRefusal("CAPITAL_INPUT_INVALID", "allocator state input failed validation", {
        issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
      }),
    );
  }
  // THE VALIDATED STATE IS THE MATERIALIZED TREE (review round 7): the parse
  // answered the QUESTION, and its output object is not read. An absent optional
  // field of a position or an order — `scope`, and every key under it — stays
  // absent because `read.value` has no prototype, so no holding is attributed to
  // a scope nobody supplied; and a position or an open order can no longer
  // vanish in an output assembly that an inherited get-only accessor defeats,
  // which would have under-stated the very commitments this state exists to
  // conserve. `AllocatorStateInputSchema` contributes no value of its own
  // (pinned by `test/unit/risk/schema-output.test.ts`).
  const data = read.value as AllocatorStateInput;

  const refusals: CapitalRefusal[] = nonCanonicalIdRefusals(data);

  const positionIds = new Set<string>();
  for (const position of data.positions) {
    if (positionIds.has(position.positionId)) {
      refusals.push(
        capitalRefusal("CAPITAL_DUPLICATE_IDENTIFIER", "duplicate positionId", {
          positionId: position.positionId,
        }),
      );
    }
    positionIds.add(position.positionId);
  }
  const orderIds = new Set<string>();
  for (const order of data.openOrders) {
    if (orderIds.has(order.orderId)) {
      refusals.push(
        capitalRefusal("CAPITAL_DUPLICATE_IDENTIFIER", "duplicate orderId", {
          orderId: order.orderId,
        }),
      );
    }
    orderIds.add(order.orderId);
  }

  const liveOwners: Record<string, string> = {};
  for (const owner of data.liveOwners) {
    // OWN read / OWN write (review round 5, the BLOCKER-1 sweep): an inherited
    // member must never read as an existing live owner, and no caller-derived
    // key may reach an inherited setter. `marketId` is UUID-constrained here, so
    // this site was not live; the discipline is uniform anyway.
    const existing = ownEntry(liveOwners, owner.marketId);
    if (existing !== undefined && existing !== owner.strategyInstanceId) {
      refusals.push(
        capitalRefusal(
          "CAPITAL_LIVE_OWNERSHIP_CONFLICT",
          "two live owners declared for one market (ADR-011: one active live strategy owns a market)",
          { marketId: owner.marketId, owners: [existing, owner.strategyInstanceId] },
        ),
      );
      continue;
    }
    setOwn(liveOwners, owner.marketId, owner.strategyInstanceId);
  }

  const skeleton = {
    positions: data.positions,
    openOrders: data.openOrders,
    reservations: [] as readonly AppliedReservation[],
  };
  const held = heldSharesByKey(skeleton);
  const reserved = reservedSharesByKey(skeleton);
  for (const [key, reservedShares] of Object.entries(reserved)) {
    const heldShares = ownEntry(held, key) ?? "0";
    if (compareDecimal(reservedShares, heldShares) > 0) {
      refusals.push(
        capitalRefusal(
          "CAPITAL_OVERSELL_UNBACKED",
          "open sell orders reserve more outcome tokens than the instance holds (§9.14: prevent double reservation)",
          { inventoryKey: key, reservedShares, heldShares },
        ),
      );
    }
  }

  if (refusals.length > 0) {
    return capitalFailure(...refusals);
  }

  let reservedCollateral: MoneyString = "0";
  for (const order of data.openOrders) {
    if (order.action === "BUY") {
      reservedCollateral = addDecimal(reservedCollateral, mulDecimal(order.price, order.shares));
    }
  }

  return capitalOk(
    deepFreeze({
      accountEquity: data.accountEquity,
      availableCollateral: data.availableCollateral,
      reservedCollateral,
      positions: data.positions,
      openOrders: data.openOrders,
      liveOwners,
      reservations: [],
      shadowReservations: [],
    }),
  );
}

/**
 * Records `strategyInstanceId` as the live owner of `marketId`.
 *
 * ADR-011 / §9.7 v1: conflicting live ownership is rejected, never netted.
 * Idempotent for the same owner. Returns a NEW state; the original is frozen.
 *
 * CONTAINED (review round 6, BLOCKER 3). It answers with a `CapitalResult`, so
 * an ownership question it cannot answer must be a REFUSAL rather than an
 * exception — this is the classification the public-surface matrix in
 * `test/unit/risk/public-surface.test.ts` records for it, and that test runs the
 * hostile call.
 */
export function withLiveOwner(
  state: AllocatorState,
  marketId: string,
  strategyInstanceId: string,
): CapitalResult<AllocatorState> {
  return contained(
    () => withLiveOwnerInner(state, marketId, strategyInstanceId),
    (thrown) =>
      capitalFailure(
        capitalRefusal(
          "CAPITAL_INPUT_INVALID",
          "recording the live owner failed unexpectedly; ownership that cannot be established is not claimed (fail closed)",
          { thrown },
        ),
      ),
  );
}

function withLiveOwnerInner(
  state: AllocatorState,
  marketId: string,
  strategyInstanceId: string,
): CapitalResult<AllocatorState> {
  // OWN read (review round 5, the BLOCKER-1 sweep): `marketId` is a caller
  // argument on this public function, and an inherited member must not read as
  // a live owner. The object literal below writes with a computed key, which is
  // `CreateDataProperty` and therefore already setter-independent.
  const existing = ownEntry(state.liveOwners, marketId);
  if (existing !== undefined && existing !== strategyInstanceId) {
    return capitalFailure(
      capitalRefusal(
        "CAPITAL_LIVE_OWNERSHIP_CONFLICT",
        "another strategy instance is the live owner of this market (ADR-011)",
        { marketId, currentOwner: existing, requestedOwner: strategyInstanceId },
      ),
    );
  }
  if (existing === strategyInstanceId) {
    return capitalOk(state);
  }
  return capitalOk(
    deepFreeze({
      ...state,
      liveOwners: { ...state.liveOwners, [marketId]: strategyInstanceId },
    }),
  );
}
