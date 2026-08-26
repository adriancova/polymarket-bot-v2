/**
 * Balance and reservation repository (§9.14, §10.5, §10.7, ADR-006 §9).
 *
 * §10.7: "No negative available balance after reservations."
 *
 * The invariant is a CHECK on a `GENERATED ALWAYS` column, and `reserved_amount`
 * is a projection of `accounting.inventory_reservations` that a trigger
 * recomputes from those rows — so the invariant holds for any writer, not only
 * for one that remembers to update both tables, and a writer that tries to
 * restate the projection directly is rejected with `PMB08`
 * ({@link ReservedAmountMismatchError}). This repository never computes a
 * balance in JavaScript: it sends canonical decimal strings and lets PostgreSQL
 * do exact `numeric` arithmetic.
 *
 * ADR-006 §9: "Reservations constrain availability but are not spends." A
 * reservation is released on every terminal order path; the release is what
 * returns the availability, and a reservation that stopped constraining earlier
 * would be a hole in the capital allocator.
 */

import type { DecimalString } from "@polymarket-bot/domain";
import { sql } from "kysely";

import type { PolymarketBotDatabase } from "../database.js";
import { inTransaction } from "../database.js";
import { withMappedErrors } from "../errors.js";
import { uuidV7 } from "../ids.js";
import type { Detail, Identifier, UuidV7Column } from "../schema/columns.js";
import type { AssetKindValue, ReservationStatusValue, RunModeValue } from "../schema/enums.js";

export type BalanceKey = {
  readonly accountRef: Identifier;
  readonly environment: RunModeValue;
  readonly assetId: Identifier;
};

export type ReserveInput = BalanceKey & {
  readonly assetKind: AssetKindValue;
  readonly amount: DecimalString;
  readonly planId?: UuidV7Column | null;
  readonly orderId?: UuidV7Column | null;
  readonly instanceId?: UuidV7Column | null;
};

export type BalanceRow = {
  readonly accountRef: Identifier;
  readonly environment: RunModeValue;
  readonly assetId: Identifier;
  readonly assetKind: AssetKindValue;
  readonly actualAmount: DecimalString;
  readonly reservedAmount: DecimalString;
  readonly availableAmount: DecimalString;
};

export type BalanceRepository = ReturnType<typeof createBalanceRepository>;

export function createBalanceRepository(db: PolymarketBotDatabase) {
  return {
    /**
     * Sets the actual balance of an asset from a ledger rebuild.
     *
     * The projection is not the source of truth (§6 invariant 8) — the ledger
     * is — so this is deliberately a *set*, not an increment: it is how a
     * rebuild reasserts the projection, and a rebuild that lowers a balance
     * below what is reserved is rejected by the CHECK rather than silently
     * producing negative availability.
     */
    async setActualBalance(
      key: BalanceKey,
      assetKind: AssetKindValue,
      actualAmount: DecimalString,
      lastLedgerTransactionId?: UuidV7Column | null,
    ): Promise<void> {
      await withMappedErrors(async () =>
        db
          .insertInto("accounting.balance_projection")
          .values({
            account_ref: key.accountRef,
            environment: key.environment,
            asset_id: key.assetId,
            asset_kind: assetKind,
            actual_amount: actualAmount,
            // `reserved_amount` is deliberately absent: it is trigger-maintained
            // from the reservation rows and is not writable through this API.
            last_ledger_transaction_id: lastLedgerTransactionId ?? null,
          })
          .onConflict((conflict) =>
            conflict.columns(["account_ref", "environment", "asset_id"]).doUpdateSet({
              actual_amount: actualAmount,
              last_ledger_transaction_id: lastLedgerTransactionId ?? null,
              updated_at: sql<string>`now()`,
            }),
          )
          .execute(),
      );
    },

    /**
     * Reserves funds or tokens for a plan or order.
     *
     * @throws {NegativeAvailableBalanceError} when the reservation would drive
     *   available below zero.
     * @throws {UnknownBalanceError} when no balance row exists for the asset.
     * @throws {UniqueViolationError} when the order already holds an active
     *   reservation for that asset (§9.14 "Prevent double reservation").
     */
    async reserve(input: ReserveInput): Promise<UuidV7Column> {
      const inventoryReservationId = uuidV7();

      await inTransaction(db, async (trx) => {
        await trx
          .insertInto("accounting.inventory_reservations")
          .values({
            inventory_reservation_id: inventoryReservationId,
            account_ref: input.accountRef,
            environment: input.environment,
            asset_id: input.assetId,
            asset_kind: input.assetKind,
            plan_id: input.planId ?? null,
            order_id: input.orderId ?? null,
            instance_id: input.instanceId ?? null,
            amount: input.amount,
            status: "ACTIVE",
          })
          .execute();
      });

      return inventoryReservationId;
    },

    /**
     * Releases or consumes a reservation, returning the availability.
     *
     * `CONSUMED` and `RELEASED` both stop constraining; they differ only in what
     * the operator learns from the record.
     */
    async closeReservation(
      inventoryReservationId: UuidV7Column,
      status: Exclude<ReservationStatusValue, "ACTIVE">,
      reason: Detail = "released",
    ): Promise<boolean> {
      const result = await withMappedErrors(async () =>
        db
          .updateTable("accounting.inventory_reservations")
          .set({
            status,
            released_at: sql<string>`now()`,
            release_reason: reason,
          })
          .where("inventory_reservation_id", "=", inventoryReservationId)
          .where("status", "=", "ACTIVE")
          .executeTakeFirst(),
      );

      return (result.numUpdatedRows ?? 0n) > 0n;
    },

    /** Reads one balance projection row. */
    async findBalance(key: BalanceKey): Promise<BalanceRow | undefined> {
      const row = await withMappedErrors(async () =>
        db
          .selectFrom("accounting.balance_projection")
          .selectAll()
          .where("account_ref", "=", key.accountRef)
          .where("environment", "=", key.environment)
          .where("asset_id", "=", key.assetId)
          .executeTakeFirst(),
      );

      if (row === undefined) {
        return undefined;
      }

      return {
        accountRef: row.account_ref,
        environment: row.environment,
        assetId: row.asset_id,
        assetKind: row.asset_kind,
        actualAmount: row.actual_amount,
        reservedAmount: row.reserved_amount,
        availableAmount: row.available_amount,
      };
    },

    /** Active reservations for an account, newest first. */
    async listActiveReservations(accountRef: Identifier, environment: RunModeValue) {
      return withMappedErrors(async () =>
        db
          .selectFrom("accounting.inventory_reservations")
          .selectAll()
          .where("account_ref", "=", accountRef)
          .where("environment", "=", environment)
          .where("status", "=", "ACTIVE")
          .orderBy("reserved_at", "desc")
          .execute(),
      );
    },
  };
}
