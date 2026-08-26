/**
 * Fill repository (§10.4, §10.7, ADR-006 §4).
 *
 * Two §10.7 constraints shape this API:
 *
 *   * "Every fill allocation sum equals the actual fill quantity" — an immediate
 *     trigger rejects over-allocation, and a deferred trigger requires the total
 *     to equal the fill at COMMIT. A fill written without its allocations would
 *     therefore fail at commit, so this repository has no `insertFill` that
 *     takes no allocations: the fact and its attribution are one write.
 *   * "fills(venue_trade_id, venue_order_id, allocation discriminator) unique" —
 *     recording the same venue trade twice is rejected, which is what makes
 *     "deduplicated fill facts" true rather than aspirational. The key is
 *     `NULLS NOT DISTINCT`, so a fill whose account is not yet known cannot be
 *     recorded twice either.
 *
 * `environment` and `account_ref` are read from the order in the statement that
 * writes the fill, and bound to it by composite foreign key. A fill is a fact
 * about one order and cannot claim a different environment or account than the
 * order it fills.
 *
 * §6 invariant 7 is what makes the equality always satisfiable: an unattributable
 * share is allocated to `UNATTRIBUTED` (and halts the market), never left
 * unassigned.
 */

import type { DecimalString, IsoTimestamp, TokenId } from "@polymarket-bot/domain";
import { sql } from "kysely";

import type { PolymarketBotDatabase } from "../database.js";
import { inTransaction } from "../database.js";
import { withMappedErrors } from "../errors.js";
import { uuidV7 } from "../ids.js";
import type { Identifier, UuidV7Column } from "../schema/columns.js";
import type {
  LedgerScopeValue,
  LiquidityRoleValue,
  OrderSideValue,
  RunModeValue,
} from "../schema/enums.js";

/** One share of a fill, owned by a strategy instance or by `UNATTRIBUTED`. */
export type FillAllocationInput = {
  /** `VIRTUAL_STRATEGY` (with an instance) or `UNATTRIBUTED` (without). */
  readonly scope: Extract<LedgerScopeValue, "VIRTUAL_STRATEGY" | "UNATTRIBUTED">;
  readonly instanceId?: UuidV7Column | null;
  readonly runId?: UuidV7Column | null;
  readonly allocatedShares: DecimalString;
  readonly allocatedNotional?: DecimalString | null;
  readonly allocatedFee?: DecimalString | null;
};

export type RecordFillInput = {
  readonly orderId: UuidV7Column;
  readonly marketId: UuidV7Column;
  readonly tokenId: TokenId;
  readonly venueTradeId: Identifier;
  readonly venueOrderId: Identifier;
  readonly allocationDiscriminator?: Identifier;
  readonly side: OrderSideValue;
  readonly shares: DecimalString;
  readonly price: DecimalString;
  readonly notional: DecimalString;
  readonly feeAmount?: DecimalString;
  readonly feeAsset?: Identifier | null;
  readonly liquidityRole: LiquidityRoleValue;
  readonly matchedAt: IsoTimestamp;
  /** Must sum to exactly `shares`; enforced by the database at COMMIT. */
  readonly allocations: readonly FillAllocationInput[];
};

export type FillRepository = ReturnType<typeof createFillRepository>;

export function createFillRepository(db: PolymarketBotDatabase) {
  return {
    /**
     * Records a fill together with its complete allocation, atomically.
     *
     * @throws {FillAllocationExceedsFillError} when the allocations exceed the
     *   fill quantity.
     * @throws {FillAllocationIncompleteError} at COMMIT when they do not sum to
     *   the fill quantity.
     * @throws {UniqueViolationError} when the venue trade was already recorded.
     */
    async recordFill(input: RecordFillInput): Promise<UuidV7Column> {
      const fillId = uuidV7();

      await inTransaction(db, async (trx) => {
        await trx
          .insertInto("execution.fills")
          .values({
            fill_id: fillId,
            order_id: input.orderId,
            market_id: input.marketId,
            token_id: input.tokenId,
            // Read from the order in the same statement, and bound to it by
            // composite foreign key: a fill of a LIVE order that claimed PAPER
            // would drop out of every live exposure and reconciliation query.
            environment: sql<RunModeValue>`(
              select o.environment from execution.orders as o
              where o.order_id = ${input.orderId}
            )`,
            account_ref: sql<Identifier | null>`(
              select o.account_ref from execution.orders as o
              where o.order_id = ${input.orderId}
            )`,
            venue_trade_id: input.venueTradeId,
            venue_order_id: input.venueOrderId,
            allocation_discriminator: input.allocationDiscriminator ?? "0",
            side: input.side,
            shares: input.shares,
            price: input.price,
            notional: input.notional,
            fee_amount: input.feeAmount ?? "0",
            fee_asset: input.feeAsset ?? null,
            liquidity_role: input.liquidityRole,
            matched_at: input.matchedAt,
          })
          .execute();

        if (input.allocations.length > 0) {
          await trx
            .insertInto("execution.fill_allocations")
            .values(
              input.allocations.map((allocation) => ({
                fill_allocation_id: uuidV7(),
                fill_id: fillId,
                scope: allocation.scope,
                instance_id: allocation.instanceId ?? null,
                run_id: allocation.runId ?? null,
                allocated_shares: allocation.allocatedShares,
                allocated_notional: allocation.allocatedNotional ?? null,
                allocated_fee: allocation.allocatedFee ?? null,
              })),
            )
            .execute();
        }
      });

      return fillId;
    },

    /**
     * Appends further allocations to an existing fill.
     *
     * Exists for the reconciliation path, which may learn about a fill before it
     * can attribute all of it. The deferred equality check still applies to the
     * transaction that records the fill, so this can only ever redistribute
     * within a total that already balances — it cannot "top up" a short fill
     * from a previous transaction.
     */
    async appendAllocations(
      fillId: UuidV7Column,
      allocations: readonly FillAllocationInput[],
    ): Promise<void> {
      if (allocations.length === 0) {
        return;
      }

      await inTransaction(db, async (trx) => {
        await trx
          .insertInto("execution.fill_allocations")
          .values(
            allocations.map((allocation) => ({
              fill_allocation_id: uuidV7(),
              fill_id: fillId,
              scope: allocation.scope,
              instance_id: allocation.instanceId ?? null,
              run_id: allocation.runId ?? null,
              allocated_shares: allocation.allocatedShares,
              allocated_notional: allocation.allocatedNotional ?? null,
              allocated_fee: allocation.allocatedFee ?? null,
            })),
          )
          .execute();
      });
    },

    /** Reads a fill with its allocations. */
    async findFill(fillId: UuidV7Column) {
      return withMappedErrors(async () => {
        const fill = await db
          .selectFrom("execution.fills")
          .selectAll()
          .where("fill_id", "=", fillId)
          .executeTakeFirst();

        if (fill === undefined) {
          return undefined;
        }

        const allocations = await db
          .selectFrom("execution.fill_allocations")
          .selectAll()
          .where("fill_id", "=", fillId)
          .orderBy("fill_allocation_id", "asc")
          .execute();

        return { fill, allocations };
      });
    },
  };
}
