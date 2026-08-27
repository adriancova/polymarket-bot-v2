/**
 * WP-040 acceptance 3: "Ledger transaction must balance per asset."
 *
 * §10.7 / §9.15: "Every ledger transaction balances to zero **per asset** using
 * explicit external-clearing accounts."
 * ADR-006 §7: assets include pUSD **and each outcome token id**; there is no
 * implicit "cash" asset, and USDC and pUSD are not interchangeable.
 */

import type { TestContext } from "@polymarket-bot/storage-postgres/testing";
import { createTradingChain, fixtureTimestamp } from "@polymarket-bot/storage-postgres/testing";
import { LedgerImbalanceError, uuidV7 } from "@polymarket-bot/storage-postgres";
import { beforeAll, describe, expect, it } from "vitest";

import { captureRejection, useMigratedDatabase } from "./context.js";

const getContext = useMigratedDatabase("ledger");

let context: TestContext;
let chain: Awaited<ReturnType<typeof createTradingChain>>;

const ACCOUNT = "test-account";

beforeAll(async () => {
  context = getContext();
  chain = await createTradingChain(context, { label: "ledger" });
});

describe("ledger balance per asset", () => {
  it("accepts a transaction that balances for one asset", async () => {
    const id = await context.repositories.ledger.postTransaction({
      eventType: "TRADE_PRINCIPAL",
      environment: "PAPER",
      accountRef: ACCOUNT,
      source: "internal",
      occurredAt: fixtureTimestamp(),
      entries: [
        {
          scope: "ACTUAL_ACCOUNT",
          accountRef: ACCOUNT,
          assetId: "pUSD",
          assetKind: "COLLATERAL",
          amount: "-42.5",
        },
        {
          scope: "EXTERNAL_CLEARING",
          accountRef: ACCOUNT,
          assetId: "pUSD",
          assetKind: "COLLATERAL",
          amount: "42.5",
        },
      ],
    });

    const stored = await context.repositories.ledger.findTransaction(id);
    expect(stored?.entries).toHaveLength(2);
    expect(stored?.entries.map((entry) => entry.amount)).toEqual(["-42.5", "42.5"]);
  });

  it("accepts a multi-asset transaction where every asset balances (a buy)", async () => {
    const tokenAsset = `token:${chain.tokenId}`;
    const id = await context.repositories.ledger.postTransaction({
      eventType: "TRADE_PRINCIPAL",
      environment: "PAPER",
      accountRef: ACCOUNT,
      source: "internal",
      occurredAt: fixtureTimestamp(),
      marketId: chain.marketId,
      entries: [
        {
          scope: "ACTUAL_ACCOUNT",
          accountRef: ACCOUNT,
          assetId: "pUSD",
          assetKind: "COLLATERAL",
          amount: "-4.2",
        },
        {
          scope: "EXTERNAL_CLEARING",
          accountRef: ACCOUNT,
          assetId: "pUSD",
          assetKind: "COLLATERAL",
          amount: "4.2",
        },
        {
          scope: "ACTUAL_ACCOUNT",
          accountRef: ACCOUNT,
          assetId: tokenAsset,
          assetKind: "OUTCOME_TOKEN",
          amount: "10",
          marketId: chain.marketId,
        },
        {
          scope: "EXTERNAL_CLEARING",
          accountRef: ACCOUNT,
          assetId: tokenAsset,
          assetKind: "OUTCOME_TOKEN",
          amount: "-10",
          marketId: chain.marketId,
        },
      ],
    });

    const stored = await context.repositories.ledger.findTransaction(id);
    expect(stored?.entries).toHaveLength(4);
  });

  it("REJECTS a one-sided transaction", async () => {
    const error = await captureRejection(async () =>
      context.repositories.ledger.postTransaction({
        eventType: "DEPOSIT_OBSERVED",
        environment: "PAPER",
        accountRef: ACCOUNT,
        source: "internal",
        occurredAt: fixtureTimestamp(),
        entries: [
          {
            scope: "ACTUAL_ACCOUNT",
            accountRef: ACCOUNT,
            assetId: "pUSD",
            assetKind: "COLLATERAL",
            amount: "100",
          },
        ],
      }),
    );

    expect(error).toBeInstanceOf(LedgerImbalanceError);
    expect((error as LedgerImbalanceError).sqlState).toBe("PMB05");
  });

  it("REJECTS a transaction that balances overall but not per asset", async () => {
    const error = await captureRejection(async () =>
      context.repositories.ledger.postTransaction({
        eventType: "SPLIT",
        environment: "PAPER",
        accountRef: ACCOUNT,
        source: "internal",
        occurredAt: fixtureTimestamp(),
        entries: [
          {
            scope: "ACTUAL_ACCOUNT",
            accountRef: ACCOUNT,
            assetId: "pUSD",
            assetKind: "COLLATERAL",
            amount: "-10",
          },
          {
            scope: "ACTUAL_ACCOUNT",
            accountRef: ACCOUNT,
            assetId: `token:${chain.tokenId}`,
            assetKind: "OUTCOME_TOKEN",
            amount: "10",
            marketId: chain.marketId,
          },
        ],
      }),
    );

    expect(error).toBeInstanceOf(LedgerImbalanceError);
    expect((error as LedgerImbalanceError).message).toMatch(/does not balance for asset/u);
  });

  it("REJECTS USDC balancing pUSD — they are not interchangeable (ADR-006 §7)", async () => {
    const error = await captureRejection(async () =>
      context.repositories.ledger.postTransaction({
        eventType: "PLATFORM_FEE",
        environment: "PAPER",
        accountRef: ACCOUNT,
        source: "internal",
        occurredAt: fixtureTimestamp(),
        entries: [
          {
            scope: "FEE_EXPENSE",
            accountRef: ACCOUNT,
            assetId: "USDC",
            assetKind: "COLLATERAL",
            amount: "0.00007",
          },
          {
            scope: "ACTUAL_ACCOUNT",
            accountRef: ACCOUNT,
            assetId: "pUSD",
            assetKind: "COLLATERAL",
            amount: "-0.00007",
          },
        ],
      }),
    );

    expect(error).toBeInstanceOf(LedgerImbalanceError);
  });

  it("REJECTS a transaction with no entries", async () => {
    const error = await captureRejection(async () =>
      context.repositories.ledger.postTransaction({
        eventType: "MANUAL_ADJUSTMENT",
        environment: "PAPER",
        accountRef: ACCOUNT,
        source: "internal",
        occurredAt: fixtureTimestamp(),
        entries: [],
      }),
    );

    expect(error).toBeInstanceOf(LedgerImbalanceError);
    expect((error as LedgerImbalanceError).message).toMatch(/has no entries/u);
  });

  it("REJECTS a zero-amount entry", async () => {
    const error = await captureRejection(async () =>
      context.repositories.ledger.postTransaction({
        eventType: "MANUAL_ADJUSTMENT",
        environment: "PAPER",
        accountRef: ACCOUNT,
        source: "internal",
        occurredAt: fixtureTimestamp(),
        entries: [
          {
            scope: "ACTUAL_ACCOUNT",
            accountRef: ACCOUNT,
            assetId: "pUSD",
            assetKind: "COLLATERAL",
            amount: "0",
          },
          {
            scope: "EXTERNAL_CLEARING",
            accountRef: ACCOUNT,
            assetId: "pUSD",
            assetKind: "COLLATERAL",
            amount: "0",
          },
        ],
      }),
    );

    expect((error as { sqlState?: string }).sqlState).toBe("23514");
  });

  it("balances exactly at fractions no float could represent", async () => {
    const id = await context.repositories.ledger.postTransaction({
      eventType: "PLATFORM_FEE",
      environment: "PAPER",
      accountRef: ACCOUNT,
      source: "internal",
      occurredAt: fixtureTimestamp(),
      entries: [
        {
          scope: "FEE_EXPENSE",
          accountRef: ACCOUNT,
          assetId: "pUSD",
          assetKind: "COLLATERAL",
          amount: "0.1",
        },
        {
          scope: "FEE_EXPENSE",
          accountRef: ACCOUNT,
          assetId: "pUSD",
          assetKind: "COLLATERAL",
          amount: "0.2",
        },
        {
          scope: "ACTUAL_ACCOUNT",
          accountRef: ACCOUNT,
          assetId: "pUSD",
          assetKind: "COLLATERAL",
          amount: "-0.3",
        },
      ],
    });

    const stored = await context.repositories.ledger.findTransaction(id);
    expect(stored?.entries).toHaveLength(3);
  });

  it("records a compensating reversal instead of editing history (ADR-006 §5.2)", async () => {
    const original = await context.repositories.ledger.postTransaction({
      eventType: "TRADE_PRINCIPAL",
      environment: "PAPER",
      accountRef: ACCOUNT,
      source: "internal",
      occurredAt: fixtureTimestamp(),
      settlementState: "MATCHED",
      entries: [
        {
          scope: "ACTUAL_ACCOUNT",
          accountRef: ACCOUNT,
          assetId: "pUSD",
          assetKind: "COLLATERAL",
          amount: "-1",
        },
        {
          scope: "EXTERNAL_CLEARING",
          accountRef: ACCOUNT,
          assetId: "pUSD",
          assetKind: "COLLATERAL",
          amount: "1",
        },
      ],
    });

    const reversal = await context.repositories.ledger.postTransaction({
      eventType: "RECONCILIATION_CORRECTION",
      environment: "PAPER",
      accountRef: ACCOUNT,
      source: "internal",
      occurredAt: fixtureTimestamp(1),
      settlementState: "FAILED",
      reversesLedgerTransactionId: original,
      entries: [
        {
          scope: "ACTUAL_ACCOUNT",
          accountRef: ACCOUNT,
          assetId: "pUSD",
          assetKind: "COLLATERAL",
          amount: "1",
        },
        {
          scope: "EXTERNAL_CLEARING",
          accountRef: ACCOUNT,
          assetId: "pUSD",
          assetKind: "COLLATERAL",
          amount: "-1",
        },
      ],
    });

    const stored = await context.repositories.ledger.findTransaction(reversal);
    expect(stored?.transaction.reverses_ledger_transaction_id).toBe(original);

    const originalStillThere = await context.repositories.ledger.findTransaction(original);
    expect(originalStillThere?.entries).toHaveLength(2);
  });

  it("rejects a transaction that claims to reverse itself", async () => {
    const id = uuidV7();
    const error = await captureRejection(async () =>
      context.pool.query(
        `insert into accounting.ledger_transactions
           (ledger_transaction_id, event_type, environment, account_ref, source, occurred_at,
            reverses_ledger_transaction_id)
         values ($1, 'MANUAL_ADJUSTMENT', 'PAPER', $2, 'internal', now(), $1)`,
        [id, ACCOUNT],
      ),
    );
    expect((error as { code?: string }).code).toBe("23514");
  });

  it("reports net movement per asset as exact decimal strings", async () => {
    const net = await context.repositories.ledger.netByAsset(ACCOUNT, "PAPER");
    const byAsset = new Map(net.map((row) => [row.asset_id, row.net_amount]));

    // Every transaction posted above balanced *and* put both of its legs in this
    // one account, so every per-asset net is zero. That is a fact about these
    // fixtures, not a property of the ledger: a transaction balances per asset
    // across all of its legs, which for a transfer means across two accounts.
    // The transfer suite below is the case where the two readings differ.
    for (const [asset, amount] of byAsset) {
      expect(Number(amount), `asset ${asset}`).toBe(0);
      expect(typeof amount).toBe("string");
    }
  });
});

/**
 * Round-4 MEDIUM: `netByAsset` must read the account of the **entry**, not the
 * account on the transaction header.
 *
 * A transfer is one transaction with a header account (who initiated it) and two
 * legs in two different accounts (where the value went) — assumption 9 of the
 * handoff, and the reason `ledger_entries.account_ref` is deliberately unbound
 * to the header. Summing every leg of the transactions whose *header* names A
 * therefore answered a question nobody asked: it netted A's own transfer to zero
 * and reported nothing whatsoever for B.
 *
 * Reproduced on the reviewed schema before it was changed: header-filtered,
 * `A -10 / B +10` returned `pUSD = 0` for A and an empty result for B.
 */
describe("net movement follows the entry account, not the header (a transfer)", () => {
  const SENDER = "transfer-sender";
  const RECEIVER = "transfer-receiver";

  it("reports -10 for the sender and +10 for the receiver", async () => {
    // The header names the initiating account only. Both legs are the money.
    await context.repositories.ledger.postTransaction({
      eventType: "MANUAL_ADJUSTMENT",
      environment: "PAPER",
      accountRef: SENDER,
      source: "internal",
      occurredAt: fixtureTimestamp(),
      entries: [
        {
          scope: "ACTUAL_ACCOUNT",
          accountRef: SENDER,
          assetId: "pUSD",
          assetKind: "COLLATERAL",
          amount: "-10",
        },
        {
          scope: "ACTUAL_ACCOUNT",
          accountRef: RECEIVER,
          assetId: "pUSD",
          assetKind: "COLLATERAL",
          amount: "10",
        },
      ],
    });

    const sender = await context.repositories.ledger.netByAsset(SENDER, "PAPER");
    expect(sender).toEqual([{ asset_id: "pUSD", net_amount: "-10" }]);

    // The receiver initiated nothing, so a header-filtered query saw nothing of
    // this at all — which is the half of the defect that loses money rather than
    // merely mis-stating it.
    const receiver = await context.repositories.ledger.netByAsset(RECEIVER, "PAPER");
    expect(receiver).toEqual([{ asset_id: "pUSD", net_amount: "10" }]);
  });

  it("keeps the transaction balanced per asset across the two accounts", async () => {
    // The §10.7 invariant is per transaction and per asset, deliberately not per
    // account: this transfer balances across the pair, and that is what makes it
    // a transfer rather than two unexplained movements.
    const legs = await context.pool.query<{ net: string }>(
      `select sum(e.amount::numeric)::text as net
         from accounting.ledger_entries e
         join accounting.ledger_transactions t
           on t.ledger_transaction_id = e.ledger_transaction_id
        where t.account_ref = $1 and e.asset_id = 'pUSD'`,
      [SENDER],
    );
    expect(legs.rows[0]?.net).toBe("0");
  });

  it("still scopes by environment, which only the transaction carries", async () => {
    // `ledger_entries` has no environment column — the environment is a property
    // of the event — so the join stays for that reason alone, and a query in
    // another run mode still sees nothing (§10.8).
    const otherEnvironment = await context.repositories.ledger.netByAsset(SENDER, "BACKTEST");
    expect(otherEnvironment).toEqual([]);
  });
});
