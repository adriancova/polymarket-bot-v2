/**
 * Market-ownership repository (§6 invariant 11, ADR-011).
 *
 * "One active live strategy owns a market in v1. Other strategies may observe or
 * run in shadow mode."
 *
 * The constraint is the partial unique index
 * `market_ownership_one_active_live_owner`, not this code. ADR-011 §1 puts the
 * database first in a three-layer enforcement precisely so a bug in an
 * application layer cannot create real exposure; a repository that "checked
 * first" and then inserted would still race.
 */

import { sql } from "kysely";

import type { PolymarketBotDatabase } from "../database.js";
import { UniqueViolationError, withMappedErrors } from "../errors.js";
import { uuidV7 } from "../ids.js";
import type { Detail, UuidV7Column } from "../schema/columns.js";
import type { OwnershipModeValue, RunModeValue } from "../schema/enums.js";

export type AcquireOwnershipInput = {
  readonly marketId: UuidV7Column;
  readonly instanceId: UuidV7Column;
  readonly environment: RunModeValue;
  readonly ownershipMode: OwnershipModeValue;
};

export type MarketOwnershipRepository = ReturnType<typeof createMarketOwnershipRepository>;

export function createMarketOwnershipRepository(db: PolymarketBotDatabase) {
  return {
    /**
     * Claims ownership of a market.
     *
     * @throws {UniqueViolationError} when a live owner already holds the market
     *   in the same execution realm. The caller must treat this as a rejection,
     *   never as a reason to retry with a different instance (§9.7: conflicting
     *   live ownership is rejected, not merged).
     */
    async acquireOwnership(input: AcquireOwnershipInput): Promise<UuidV7Column> {
      const marketOwnershipId = uuidV7();

      await withMappedErrors(async () =>
        db
          .insertInto("strategy.market_ownership")
          .values({
            market_ownership_id: marketOwnershipId,
            market_id: input.marketId,
            instance_id: input.instanceId,
            environment: input.environment,
            ownership_mode: input.ownershipMode,
            status: "ACTIVE",
          })
          .execute(),
      );

      return marketOwnershipId;
    },

    /** Releases ownership so another instance may claim the market. */
    async releaseOwnership(
      marketOwnershipId: UuidV7Column,
      reason: Detail = "released",
    ): Promise<boolean> {
      const result = await withMappedErrors(async () =>
        db
          .updateTable("strategy.market_ownership")
          .set({
            status: "RELEASED",
            released_at: sql<string>`now()`,
            released_reason: reason,
          })
          .where("market_ownership_id", "=", marketOwnershipId)
          .where("status", "=", "ACTIVE")
          .executeTakeFirst(),
      );

      return (result.numUpdatedRows ?? 0n) > 0n;
    },

    /** The active live owner of a market in one environment, if any. */
    async findActiveLiveOwner(marketId: UuidV7Column, environment: RunModeValue) {
      return withMappedErrors(async () =>
        db
          .selectFrom("strategy.market_ownership")
          .selectAll()
          .where("market_id", "=", marketId)
          .where("environment", "=", environment)
          .where("ownership_mode", "=", "LIVE_OWNER")
          .where("status", "=", "ACTIVE")
          .executeTakeFirst(),
      );
    },
  };
}

export { UniqueViolationError };
