/**
 * Bypass reproductions for the WP-040 review **round 4** findings.
 *
 *   * **Wallet-operation ledger rows are market-unbound (HIGH).** Round 2 bound
 *     a ledger transaction's `environment` and `account_ref` to the wallet
 *     operation it books; round 3 bound the *market* for the order and fill
 *     links and left the wallet link where it was. So a REDEEM of market M1
 *     could be booked by a transaction naming **no** market — invisible to every
 *     market-scoped ledger query — or naming market **M2**, filed under a market
 *     it has nothing to do with, while still naming the right operation, the
 *     right account and the right environment, and still balancing. Worse,
 *     `wallet_operations_immutable_identity` omitted `market_id`, so an
 *     operation could be repointed at another market *after* its transactions
 *     were committed. `accounting.ledger_transactions` is append-only, so every
 *     one of those is permanent.
 *
 * The fix is **conditional** equality, not a composite key: when the operation
 * has a market the transaction names that market; when the operation genuinely
 * has none (`APPROVE_ERC20`, `APPROVE_ERC1155`, a collateral `TRANSFER`) the
 * transaction's own market is its own affair, exactly as for a transaction that
 * books no operation at all. A `(wallet_operation_id, market_id)` foreign key
 * cannot express that — MATCH SIMPLE skips a NULL child market, MATCH FULL
 * forbids booking a marketless operation at all, and either would additionally
 * forbid naming a market the operation merely did not record.
 *
 * Every sequence below was **reproduced first** against the reviewed schema
 * (`43dbe04`), where all three were accepted, and is written here as the
 * attacker's plain SQL through `context.pool`: an invariant a second connection
 * can step around is not a database invariant.
 */

import type { TestContext } from "@polymarket-bot/storage-postgres/testing";
import { createTradingChain, fixtureTimestamp } from "@polymarket-bot/storage-postgres/testing";
import {
  ImmutableColumnError,
  WalletOperationMarketMismatchError,
  mapPostgresError,
  uuidV7,
} from "@polymarket-bot/storage-postgres";
import { beforeAll, describe, expect, it } from "vitest";

import { captureRejection, useMigratedDatabase } from "./context.js";

const getContext = useMigratedDatabase("authority_bypass_round4");

const ACCOUNT = "round4-account";

let context: TestContext;
/** The market the wallet operation really belongs to. */
let chain: Awaited<ReturnType<typeof createTradingChain>>;
/** A second market, so "the wrong market" is a market that exists. */
let otherChain: Awaited<ReturnType<typeof createTradingChain>>;

/** A REDEEM of `chain.marketId` — an operation that HAS a market. */
const REDEEM_OPERATION = uuidV7();
/** An ERC-20 approval — an operation that genuinely has none. */
const APPROVAL_OPERATION = uuidV7();

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string }).code;
}

/** Two balanced legs, so nothing fails for the unrelated reason of imbalance. */
const BALANCED_ENTRIES = [
  {
    scope: "ACTUAL_ACCOUNT",
    accountRef: ACCOUNT,
    assetId: "pUSD",
    assetKind: "COLLATERAL",
    amount: "10",
  },
  {
    scope: "EXTERNAL_CLEARING",
    accountRef: ACCOUNT,
    assetId: "pUSD",
    assetKind: "COLLATERAL",
    amount: "-10",
  },
] as const;

beforeAll(async () => {
  context = getContext();

  chain = await createTradingChain(context, {
    label: "round4_main",
    environment: "PAPER",
    accountRef: ACCOUNT,
  });
  otherChain = await createTradingChain(context, {
    label: "round4_other",
    environment: "PAPER",
    accountRef: ACCOUNT,
  });

  await context.db
    .insertInto("accounting.wallet_operations")
    .values([
      {
        wallet_operation_id: REDEEM_OPERATION,
        environment: "PAPER",
        account_ref: ACCOUNT,
        operation_type: "REDEEM",
        market_id: chain.marketId,
        condition_id: "condition-round4_main",
        amount: "10",
      },
      {
        wallet_operation_id: APPROVAL_OPERATION,
        environment: "PAPER",
        account_ref: ACCOUNT,
        operation_type: "APPROVE_ERC20",
        market_id: null,
        amount: "0",
      },
    ])
    .execute();
});

/** Inserts a balanced transaction header plus its two legs, in one transaction. */
async function postBalancedHeader(values: {
  readonly walletOperationId?: string | null;
  readonly marketId?: string | null;
  readonly eventType?: string;
}): Promise<string> {
  const ledgerTransactionId = uuidV7();
  const client = await context.pool.connect();
  try {
    await client.query("begin");
    await client.query(
      `insert into accounting.ledger_transactions
         (ledger_transaction_id, event_type, environment, account_ref, market_id,
          wallet_operation_id, source, occurred_at)
       values ($1, $2::internal.ledger_event_type, 'PAPER', $3, $4, $5, 'internal', now())`,
      [
        ledgerTransactionId,
        values.eventType ?? "REDEEM",
        ACCOUNT,
        values.marketId ?? null,
        values.walletOperationId ?? null,
      ],
    );
    await client.query(
      `insert into accounting.ledger_entries
         (ledger_transaction_id, entry_ordinal, scope, account_ref, asset_id, asset_kind, amount)
       values ($1, 0, 'ACTUAL_ACCOUNT', $2, 'pUSD', 'COLLATERAL', '10'),
              ($1, 1, 'EXTERNAL_CLEARING', $2, 'pUSD', 'COLLATERAL', '-10')`,
      [ledgerTransactionId, ACCOUNT],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
  return ledgerTransactionId;
}

describe("round-4 HIGH: a ledger transaction books a wallet operation under that operation's market", () => {
  it("REJECTS a wallet-operation-linked transaction whose market_id is NULL", async () => {
    // The bypass, exactly: the right operation, the right account, the right
    // environment, balanced — and no market. Nothing bound the market, so this
    // committed on the reviewed schema and then failed to appear in any query
    // that asked what the ledger says about this market.
    const error = await captureRejection(async () =>
      postBalancedHeader({ walletOperationId: REDEEM_OPERATION, marketId: null }),
    );

    expect(errorCode(error)).toBe("PMB12");
    expect((error as { message: string }).message).toMatch(/names market none/u);
  });

  it("REJECTS a wallet-operation-linked transaction that names ANOTHER market", async () => {
    const error = await captureRejection(async () =>
      postBalancedHeader({
        walletOperationId: REDEEM_OPERATION,
        marketId: otherChain.marketId,
      }),
    );

    expect(errorCode(error)).toBe("PMB12");
    expect((error as { message: string }).message).toContain(otherChain.marketId);
  });

  it("REJECTS both shapes through the repository as well, as a typed error", async () => {
    // The requirement cannot be a compile-time one: whether the operation has a
    // market is a fact about a row, not about the call. So the database is the
    // enforcement, and the repository's job is to surface it as a type (§21).
    for (const marketId of [null, otherChain.marketId]) {
      const error = await captureRejection(async () =>
        context.repositories.ledger.postTransaction({
          eventType: "REDEEM",
          environment: "PAPER",
          accountRef: ACCOUNT,
          walletOperationId: REDEEM_OPERATION,
          marketId,
          source: "internal",
          occurredAt: fixtureTimestamp(),
          entries: [...BALANCED_ENTRIES],
        }),
      );

      expect(error).toBeInstanceOf(WalletOperationMarketMismatchError);
      expect((error as WalletOperationMarketMismatchError).sqlState).toBe("PMB12");
    }
  });

  it("REJECTS changing a wallet operation's market after the fact", async () => {
    // The other half of the same finding. Without this the binding is only as
    // durable as the operation row: book the transaction truthfully, then move
    // the operation to another market, and the committed, append-only,
    // uncorrectable transaction is mis-filed again.
    const error = await captureRejection(async () =>
      context.pool.query(
        `update accounting.wallet_operations set market_id = $2 where wallet_operation_id = $1`,
        [REDEEM_OPERATION, otherChain.marketId],
      ),
    );

    expect(errorCode(error)).toBe("PMB02");
    expect((error as { message: string }).message).toMatch(/market_id is immutable/u);

    // …including "unset it and start again", which is the same move in two steps.
    const unset = await captureRejection(async () =>
      context.pool.query(
        `update accounting.wallet_operations set market_id = null where wallet_operation_id = $1`,
        [REDEEM_OPERATION],
      ),
    );
    expect(errorCode(unset)).toBe("PMB02");

    const stored = await context.db
      .selectFrom("accounting.wallet_operations")
      .select("market_id")
      .where("wallet_operation_id", "=", REDEEM_OPERATION)
      .executeTakeFirst();
    expect(stored?.market_id).toBe(chain.marketId);
  });

  it("REJECTS the mutation through the typed query layer too, as a typed error", async () => {
    const error = await captureRejection(async () =>
      context.db
        .updateTable("accounting.wallet_operations")
        .set({ market_id: otherChain.marketId })
        .where("wallet_operation_id", "=", REDEEM_OPERATION)
        .execute(),
    );

    // The SQLSTATE is the contract (§21), and it maps to exactly one class.
    const mapped = mapPostgresError(error);
    expect(mapped).toBeInstanceOf(ImmutableColumnError);
    expect((mapped as ImmutableColumnError).sqlState).toBe("PMB02");
  });

  it("accepts a transaction that names the operation's own market", async () => {
    const id = await context.repositories.ledger.postTransaction({
      eventType: "REDEEM",
      environment: "PAPER",
      accountRef: ACCOUNT,
      walletOperationId: REDEEM_OPERATION,
      marketId: chain.marketId,
      source: "internal",
      occurredAt: fixtureTimestamp(),
      entries: [...BALANCED_ENTRIES],
    });

    const stored = await context.repositories.ledger.findTransaction(id);
    expect(stored?.transaction.market_id).toBe(chain.marketId);
    expect(stored?.transaction.wallet_operation_id).toBe(REDEEM_OPERATION);

    // The consequence the finding was about: the transaction is reachable from
    // the market whose operation it books. On the reviewed schema the two
    // mis-filed rows committed and this count read zero.
    const scoped = await context.pool.query<{ count: string }>(
      `select count(*)::text as count from accounting.ledger_transactions
        where market_id = $1 and wallet_operation_id = $2`,
      [chain.marketId, REDEEM_OPERATION],
    );
    expect(scoped.rows[0]?.count).toBe("1");
  });

  it("accepts a marketless operation booked by a marketless transaction", async () => {
    // An approval has no market. The rule is equality when there is something to
    // equal, so this is untouched.
    const id = await context.repositories.ledger.postTransaction({
      eventType: "MANUAL_ADJUSTMENT",
      environment: "PAPER",
      accountRef: ACCOUNT,
      walletOperationId: APPROVAL_OPERATION,
      source: "internal",
      occurredAt: fixtureTimestamp(),
      entries: [...BALANCED_ENTRIES],
    });

    const stored = await context.repositories.ledger.findTransaction(id);
    expect(stored?.transaction.market_id).toBeNull();
    expect(stored?.transaction.wallet_operation_id).toBe(APPROVAL_OPERATION);
  });

  it("accepts a marketless operation booked by a transaction that names a market", async () => {
    // Deliberate, and the reason this is a conditional rule rather than
    // `IS NOT DISTINCT FROM`: a NULL on the operation means "no market
    // recorded", not "provably no market anywhere near this". A transaction is
    // already free to name a market while booking no operation at all
    // (a RESOLUTION does), and forbidding it here would also make a transaction
    // that books an execution fact *and* an approval unrepresentable, because
    // `ledger_transactions_execution_link_has_market` requires the market that
    // this rule would forbid.
    const id = await postBalancedHeader({
      walletOperationId: APPROVAL_OPERATION,
      marketId: otherChain.marketId,
      eventType: "MANUAL_ADJUSTMENT",
    });

    const stored = await context.repositories.ledger.findTransaction(id);
    expect(stored?.transaction.market_id).toBe(otherChain.marketId);
  });

  it("accepts the operation and its transaction written in ONE database transaction", async () => {
    // The check reads the operation `FOR SHARE`. A writer that creates the
    // operation and books it in the same transaction must not deadlock against
    // its own uncommitted row.
    const operationId = uuidV7();
    const ledgerTransactionId = uuidV7();

    await context.db.transaction().execute(async (trx) => {
      await trx
        .insertInto("accounting.wallet_operations")
        .values({
          wallet_operation_id: operationId,
          environment: "PAPER",
          account_ref: ACCOUNT,
          operation_type: "SPLIT",
          market_id: otherChain.marketId,
          amount: "5",
        })
        .execute();
      await trx
        .insertInto("accounting.ledger_transactions")
        .values({
          ledger_transaction_id: ledgerTransactionId,
          event_type: "SPLIT",
          environment: "PAPER",
          account_ref: ACCOUNT,
          market_id: otherChain.marketId,
          wallet_operation_id: operationId,
          source: "internal",
          occurred_at: fixtureTimestamp(),
        })
        .execute();
      await trx
        .insertInto("accounting.ledger_entries")
        .values([
          {
            ledger_transaction_id: ledgerTransactionId,
            entry_ordinal: 0,
            scope: "ACTUAL_ACCOUNT",
            account_ref: ACCOUNT,
            asset_id: "pUSD",
            asset_kind: "COLLATERAL",
            amount: "-5",
          },
          {
            ledger_transaction_id: ledgerTransactionId,
            entry_ordinal: 1,
            scope: "EXTERNAL_CLEARING",
            account_ref: ACCOUNT,
            asset_id: "pUSD",
            asset_kind: "COLLATERAL",
            amount: "5",
          },
        ])
        .execute();
    });

    const stored = await context.repositories.ledger.findTransaction(ledgerTransactionId);
    expect(stored?.transaction.wallet_operation_id).toBe(operationId);
  });

  it("still lets the operation's own lifecycle be recorded (only its identity is frozen)", async () => {
    const updated = await context.pool.query(
      `update accounting.wallet_operations
          set state = 'CONFIRMED', confirmed_at = now(), transaction_hash = 'round4-hash'
        where wallet_operation_id = $1`,
      [REDEEM_OPERATION],
    );

    expect((updated as { rowCount: number }).rowCount).toBe(1);
  });

  it("still binds the environment and the account of a wallet-operation transaction", async () => {
    // The round-2 bindings are untouched by the new rule and are re-asserted
    // here, because a fix that quietly replaced them would look identical from
    // the outside for the market case alone.
    const error = await captureRejection(async () =>
      context.pool.query(
        `insert into accounting.ledger_transactions
           (ledger_transaction_id, event_type, environment, account_ref, market_id,
            wallet_operation_id, source, occurred_at)
         values ($1, 'REDEEM', 'LIVE', $2, $3, $4, 'internal', now())`,
        [uuidV7(), ACCOUNT, chain.marketId, REDEEM_OPERATION],
      ),
    );

    expect(errorCode(error)).toBe("23503");
    expect((error as { constraint?: string }).constraint).toBe(
      "ledger_transactions_wallet_operation_environment_fk",
    );
  });
});

describe("round-4: the reconciliation-run link has no market to bind", () => {
  it("confirms ops.reconciliation_runs carries no market column at all", async () => {
    // Stated in the handoff and in the migration; asserted here so it stays a
    // fact rather than a claim. A run examines an account in an environment
    // (§9.17) — those two are already bound by composite foreign key — so there
    // is no third value for a market rule to be about. If a market column is
    // ever added, this test fails and the binding question has to be answered.
    const columns = await context.pool.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'ops' and table_name = 'reconciliation_runs'
          and column_name = 'market_id'`,
    );

    expect(columns.rows).toEqual([]);
  });
});
