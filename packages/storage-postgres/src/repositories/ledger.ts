/**
 * Ledger repository (§9.15, §10.7, ADR-006).
 *
 * "Every ledger transaction balances to zero **per asset** using explicit
 * external-clearing accounts."
 *
 * The balance check is a `DEFERRABLE INITIALLY DEFERRED` constraint trigger, so
 * it fires at COMMIT. That has one consequence a caller must understand: an
 * unbalanced transaction is rejected when the transaction commits, not when the
 * offending entry is inserted. `postTransaction` therefore writes the header and
 * every entry inside one transaction and awaits the commit, so the caller sees a
 * typed `LedgerImbalanceError` from this call and not from some later one.
 *
 * Amounts are canonical decimal strings, signed. No arithmetic happens here:
 * the sum is computed by PostgreSQL in `numeric`, which is exact.
 */

import type { DecimalString, IsoTimestamp } from "@polymarket-bot/domain";
import { sql } from "kysely";

import type { PolymarketBotDatabase } from "../database.js";
import { inTransaction } from "../database.js";
import { withMappedErrors } from "../errors.js";
import { uuidV7 } from "../ids.js";
import type { Detail, Identifier, Sha256Hex, UuidV7Column } from "../schema/columns.js";
import type {
  AssetKindValue,
  EventSourceValue,
  LedgerEventTypeValue,
  LedgerScopeValue,
  RunModeValue,
  TradeSettlementStateValue,
} from "../schema/enums.js";

/** One side of a balanced transaction. */
export type LedgerEntryInput = {
  readonly scope: LedgerScopeValue;
  readonly accountRef: Identifier;
  readonly assetId: Identifier;
  readonly assetKind: AssetKindValue;
  /** Signed canonical decimal string. Never zero. */
  readonly amount: DecimalString;
  readonly instanceId?: UuidV7Column | null;
  readonly runId?: UuidV7Column | null;
  readonly marketId?: UuidV7Column | null;
  readonly detail?: Detail | null;
};

/** Everything a ledger transaction carries regardless of what it books. */
type LedgerTransactionFields = {
  readonly eventType: LedgerEventTypeValue;
  readonly environment: RunModeValue;
  readonly accountRef: Identifier;
  readonly source: EventSourceValue;
  readonly occurredAt: IsoTimestamp;
  readonly entries: readonly LedgerEntryInput[];
  readonly walletOperationId?: UuidV7Column | null;
  readonly reconciliationRunId?: UuidV7Column | null;
  readonly settlementState?: TradeSettlementStateValue | null;
  /** ADR-006 §5.2: a failure is a compensating reversal, never an edit. */
  readonly reversesLedgerTransactionId?: UuidV7Column | null;
  readonly referenceHash?: Sha256Hex | null;
  readonly detail?: Detail | null;
};

/**
 * A transaction that may book an order or a fill, and therefore **must** name
 * the market.
 *
 * `execution.orders.market_id` and `execution.fills.market_id` are both NOT
 * NULL, so a caller that has an order or a fill always has its market: there is
 * no such thing as an execution fact whose market is unknown. Omitting it is not
 * a missing value, it is a transaction that has left market-scoped accounting —
 * and because the market foreign keys are MATCH SIMPLE, omitting it also skips
 * the check that the market is the *right* one. The database says the same thing
 * (`ledger_transactions_execution_link_has_market`); this type says it at
 * compile time, so the mistake is not reachable from here at all.
 */
type MarketBoundLedgerTransactionInput = LedgerTransactionFields & {
  readonly marketId: UuidV7Column;
  readonly orderId?: UuidV7Column | null;
  readonly fillId?: UuidV7Column | null;
};

/**
 * A transaction that books no execution fact: external clearing, a deposit or
 * withdrawal, a manual adjustment, a resolution (§9.15).
 *
 * The market stays optional here, because these genuinely may have none.
 */
type StandaloneLedgerTransactionInput = LedgerTransactionFields & {
  readonly marketId?: UuidV7Column | null;
  readonly orderId?: null;
  readonly fillId?: null;
};

export type PostLedgerTransactionInput =
  | MarketBoundLedgerTransactionInput
  | StandaloneLedgerTransactionInput;

export type LedgerRepository = ReturnType<typeof createLedgerRepository>;

export function createLedgerRepository(db: PolymarketBotDatabase) {
  return {
    /**
     * Posts one balanced ledger transaction.
     *
     * A transaction that names an `orderId` or a `fillId` must name that row's
     * `marketId` too — the input type requires it, and
     * `ledger_transactions_execution_link_has_market` requires it of every other
     * writer as well.
     *
     * @throws {LedgerImbalanceError} at COMMIT when the entries do not sum to
     *   zero for some asset, or when there are no entries at all.
     */
    async postTransaction(input: PostLedgerTransactionInput): Promise<UuidV7Column> {
      const ledgerTransactionId = uuidV7();

      await inTransaction(db, async (trx) => {
        await trx
          .insertInto("accounting.ledger_transactions")
          .values({
            ledger_transaction_id: ledgerTransactionId,
            event_type: input.eventType,
            environment: input.environment,
            account_ref: input.accountRef,
            market_id: input.marketId ?? null,
            order_id: input.orderId ?? null,
            fill_id: input.fillId ?? null,
            wallet_operation_id: input.walletOperationId ?? null,
            reconciliation_run_id: input.reconciliationRunId ?? null,
            settlement_state: input.settlementState ?? null,
            reverses_ledger_transaction_id: input.reversesLedgerTransactionId ?? null,
            source: input.source,
            reference_hash: input.referenceHash ?? null,
            detail: input.detail ?? null,
            occurred_at: input.occurredAt,
          })
          .execute();

        if (input.entries.length > 0) {
          await trx
            .insertInto("accounting.ledger_entries")
            .values(
              input.entries.map((entry, index) => ({
                ledger_entry_id: uuidV7(),
                ledger_transaction_id: ledgerTransactionId,
                entry_ordinal: index,
                scope: entry.scope,
                account_ref: entry.accountRef,
                instance_id: entry.instanceId ?? null,
                run_id: entry.runId ?? null,
                market_id: entry.marketId ?? null,
                asset_id: entry.assetId,
                asset_kind: entry.assetKind,
                amount: entry.amount,
                detail: entry.detail ?? null,
              })),
            )
            .execute();
        }
      });

      return ledgerTransactionId;
    },

    /** Reads a transaction with its entries in ordinal order. */
    async findTransaction(ledgerTransactionId: UuidV7Column) {
      return withMappedErrors(async () => {
        const transaction = await db
          .selectFrom("accounting.ledger_transactions")
          .selectAll()
          .where("ledger_transaction_id", "=", ledgerTransactionId)
          .executeTakeFirst();

        if (transaction === undefined) {
          return undefined;
        }

        const entries = await db
          .selectFrom("accounting.ledger_entries")
          .selectAll()
          .where("ledger_transaction_id", "=", ledgerTransactionId)
          .orderBy("entry_ordinal", "asc")
          .execute();

        return { transaction, entries };
      });
    },

    /**
     * Net movement per asset for an account, computed in the database.
     *
     * Returned as canonical decimal strings: `numeric` sums exactly, and `pg`
     * hands the result back as text, so no economic value passes through a
     * JavaScript number.
     */
    async netByAsset(accountRef: Identifier, environment: RunModeValue) {
      return withMappedErrors(async () =>
        db
          .selectFrom("accounting.ledger_entries as entries")
          .innerJoin(
            "accounting.ledger_transactions as transactions",
            "transactions.ledger_transaction_id",
            "entries.ledger_transaction_id",
          )
          .select([
            "entries.asset_id as asset_id",
            // `numeric` is arbitrary-precision decimal; `pg` returns it as text.
            sql<string>`sum(entries.amount::numeric)`.as("net_amount"),
          ])
          .where("transactions.account_ref", "=", accountRef)
          .where("transactions.environment", "=", environment)
          .groupBy("entries.asset_id")
          .execute(),
      );
    },
  };
}
