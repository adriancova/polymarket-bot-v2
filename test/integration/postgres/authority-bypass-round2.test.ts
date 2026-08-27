/**
 * Bypass reproductions for the WP-040 review **round 2** findings.
 *
 * Round 1 closed four ways of writing an unauthorized row. Round 2 found that
 * three of them had a second door — not a different invariant, the *same*
 * invariant reached from another statement:
 *
 *   * HIGH-1 the reservation guard judged the key the row would have, so a
 *     balance could be moved to another key instead of rewritten;
 *   * HIGH-3 the account binding was MATCH SIMPLE, so a fill could opt out of it
 *     by naming no account at all;
 *   * HIGH-4 the grant was immutable but the *lifecycle* was not, so a released
 *     lease could be reactivated with its original token, and the token sequence
 *     was derived from lease rows that could be deleted.
 *
 * Plus two findings about what a row may claim rather than what it may do: a
 * ledger transaction whose discriminators disagree with the order or fill it
 * books (F10), and an order that reaches a submitted state with no persisted
 * signed payload behind it (§9.11 lineage).
 *
 * Every sequence below was **reproduced first** against the reviewed schema
 * (`c287413`) — each one succeeded there — and each is written as the attacker's
 * plain SQL through `context.pool`, because an invariant a second connection can
 * step around is not a database invariant.
 */

import type { TestContext } from "@polymarket-bot/storage-postgres/testing";
import { createTradingChain, fixtureTimestamp } from "@polymarket-bot/storage-postgres/testing";
import {
  FencingLeaseNotForwardOnlyError,
  ImmutableColumnError,
  MissingSubmissionAttemptError,
  mapPostgresError,
  uuidV7,
} from "@polymarket-bot/storage-postgres";
import { beforeAll, describe, expect, it } from "vitest";

import { captureRejection, useMigratedDatabase } from "./context.js";

const getContext = useMigratedDatabase("authority_bypass_round2");

const LIVE_ACCOUNT = "round2-live-account";
const BALANCE_ACCOUNT = "round2-balance-account";
const FENCE_ACCOUNT = "round2-fence-account";
const ERASURE_ACCOUNT = "round2-erasure-account";

let context: TestContext;
let paperChain: Awaited<ReturnType<typeof createTradingChain>>;
let accountlessChain: Awaited<ReturnType<typeof createTradingChain>>;
let liveChain: Awaited<ReturnType<typeof createTradingChain>>;
let liveOrderId: string;
let liveFillId: string;
let secondLiveFillId: string;
let paperOrderId: string;

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string }).code;
}

function constraintOf(error: unknown): string | undefined {
  return (error as { constraint?: string }).constraint;
}

function inSeconds(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

beforeAll(async () => {
  context = getContext();

  paperChain = await createTradingChain(context, {
    label: "round2_paper",
    environment: "PAPER",
    accountRef: "round2-paper-account",
  });
  accountlessChain = await createTradingChain(context, {
    label: "round2_accountless",
    environment: "PAPER",
    accountRef: null,
  });
  liveChain = await createTradingChain(context, {
    label: "round2_live",
    environment: "LIVE",
    accountRef: LIVE_ACCOUNT,
  });

  paperOrderId = await context.repositories.orders.insertOrder({
    planId: paperChain.planId,
    executionGroupId: paperChain.executionGroupId,
    submissionAttemptId: paperChain.submissionAttemptId,
    marketId: paperChain.marketId,
    tokenId: paperChain.tokenId,
    side: "BUY",
    limitPrice: "0.42",
    originalShares: "10",
    state: "LIVE",
  });

  // The live chain signs under its own lease: §9.11 is decision → plan →
  // attempt → order → fill, and a live attempt requires a valid fencing token.
  const lease = await context.repositories.fencing.acquireLease({
    accountRef: LIVE_ACCOUNT,
    environment: "LIVE",
    holderId: "round2-live-holder",
    expiresAt: inSeconds(600),
  });
  const fencing = {
    fencingLeaseId: lease.fencingLeaseId,
    fencingToken: lease.fencingToken,
  };

  const liveAttemptId = await context.repositories.orders.recordSubmissionAttempt({
    executionGroupId: liveChain.executionGroupId,
    planId: liveChain.planId,
    signedPayload: { price: "0.42", size: "10" },
    salt: "round2-live-salt",
    fencing,
  });

  liveOrderId = await context.repositories.orders.insertOrder({
    planId: liveChain.planId,
    executionGroupId: liveChain.executionGroupId,
    submissionAttemptId: liveAttemptId,
    marketId: liveChain.marketId,
    tokenId: liveChain.tokenId,
    side: "BUY",
    limitPrice: "0.42",
    originalShares: "10",
    state: "LIVE",
    fencing,
    submittedAt: fixtureTimestamp(),
  });

  liveFillId = await context.repositories.fills.recordFill({
    orderId: liveOrderId,
    marketId: liveChain.marketId,
    tokenId: liveChain.tokenId,
    venueTradeId: "round2-live-trade",
    venueOrderId: "round2-live-venue-order",
    side: "BUY",
    shares: "10",
    price: "0.42",
    notional: "4.2",
    liquidityRole: "TAKER",
    matchedAt: fixtureTimestamp(),
    allocations: [
      {
        scope: "VIRTUAL_STRATEGY",
        instanceId: liveChain.instanceId,
        runId: liveChain.runId,
        allocatedShares: "10",
      },
    ],
  });

  // A second live order and fill on the same chain, so "a fill of a different
  // order" can be tested with everything else — environment, account, market —
  // identical, and only the pairing wrong.
  const secondAttemptId = await context.repositories.orders.recordSubmissionAttempt({
    executionGroupId: liveChain.executionGroupId,
    planId: liveChain.planId,
    attemptOrdinal: 2,
    signedPayload: { price: "0.42", size: "5" },
    salt: "round2-live-salt-2",
    fencing,
  });
  const secondLiveOrderId = await context.repositories.orders.insertOrder({
    planId: liveChain.planId,
    executionGroupId: liveChain.executionGroupId,
    submissionAttemptId: secondAttemptId,
    marketId: liveChain.marketId,
    tokenId: liveChain.tokenId,
    side: "BUY",
    limitPrice: "0.42",
    originalShares: "5",
    state: "LIVE",
    fencing,
    submittedAt: fixtureTimestamp(),
  });
  secondLiveFillId = await context.repositories.fills.recordFill({
    orderId: secondLiveOrderId,
    marketId: liveChain.marketId,
    tokenId: liveChain.tokenId,
    venueTradeId: "round2-live-trade-2",
    venueOrderId: "round2-live-venue-order-2",
    side: "BUY",
    shares: "5",
    price: "0.42",
    notional: "2.1",
    liquidityRole: "TAKER",
    matchedAt: fixtureTimestamp(),
    allocations: [
      {
        scope: "VIRTUAL_STRATEGY",
        instanceId: liveChain.instanceId,
        runId: liveChain.runId,
        allocatedShares: "5",
      },
    ],
  });
});

describe("round-2 HIGH-1: a balance cannot be moved away from its reservations", () => {
  beforeAll(async () => {
    await context.repositories.balances.setActualBalance(
      { accountRef: BALANCE_ACCOUNT, environment: "PAPER", assetId: "pUSD" },
      "COLLATERAL",
      "100",
    );
    await context.repositories.balances.reserve({
      accountRef: BALANCE_ACCOUNT,
      environment: "PAPER",
      assetId: "pUSD",
      assetKind: "COLLATERAL",
      amount: "100",
    });
  });

  it("REJECTS re-keying the balance to an account with no reservations", async () => {
    // The bypass: the reservation guard compares the *new* key against the
    // reservations for that new key. Point the row at an account that has none,
    // and "reserved_amount = '0'" is the truth about the destination — while the
    // original account's 100 of reservations are left with no balance row at
    // all, which is the oversubscription round 1 closed, reached by moving the
    // row instead of rewriting it.
    const error = await captureRejection(async () =>
      context.pool.query(
        `update accounting.balance_projection
            set account_ref = 'round2-elsewhere', reserved_amount = '0'
          where account_ref = $1 and environment = 'PAPER' and asset_id = 'pUSD'`,
        [BALANCE_ACCOUNT],
      ),
    );

    expect(errorCode(error)).toBe("PMB02");
    expect(mapPostgresError(error)).toBeInstanceOf(ImmutableColumnError);
  });

  it("REJECTS re-keying the environment or the asset either", async () => {
    for (const assignment of ["environment = 'SHADOW'", "asset_id = 'USDC'"]) {
      const error = await captureRejection(async () =>
        context.pool.query(
          `update accounting.balance_projection set ${assignment}
            where account_ref = $1 and environment = 'PAPER' and asset_id = 'pUSD'`,
          [BALANCE_ACCOUNT],
        ),
      );
      expect(errorCode(error), assignment).toBe("PMB02");
    }
  });

  it("leaves the reservations and the balance they constrain intact", async () => {
    const balance = await context.repositories.balances.findBalance({
      accountRef: BALANCE_ACCOUNT,
      environment: "PAPER",
      assetId: "pUSD",
    });

    expect(balance?.reservedAmount).toBe("100");
    expect(balance?.availableAmount).toBe("0");

    const orphaned = await context.pool.query<{ count: string }>(
      `select count(*)::text as count
         from accounting.inventory_reservations as r
        where r.status = 'ACTIVE'
          and not exists (
            select 1 from accounting.balance_projection as b
             where b.account_ref = r.account_ref
               and b.environment = r.environment
               and b.asset_id = r.asset_id)`,
    );
    expect(orphaned.rows[0]?.count).toBe("0");
  });

  it("still maintains reserved_amount when a reservation is released", async () => {
    const reservation = await context.pool.query<{ inventory_reservation_id: string }>(
      `select inventory_reservation_id from accounting.inventory_reservations
        where account_ref = $1 and status = 'ACTIVE'`,
      [BALANCE_ACCOUNT],
    );

    await context.repositories.balances.closeReservation(
      reservation.rows[0]?.inventory_reservation_id ?? "",
      "RELEASED",
      "round-2 test",
    );

    const balance = await context.repositories.balances.findBalance({
      accountRef: BALANCE_ACCOUNT,
      environment: "PAPER",
      assetId: "pUSD",
    });
    expect(balance?.reservedAmount).toBe("0");
    expect(balance?.availableAmount).toBe("100");
  });

  it("still accepts an ordinary balance write", async () => {
    await context.repositories.balances.setActualBalance(
      { accountRef: BALANCE_ACCOUNT, environment: "PAPER", assetId: "pUSD" },
      "COLLATERAL",
      "250",
    );

    const balance = await context.repositories.balances.findBalance({
      accountRef: BALANCE_ACCOUNT,
      environment: "PAPER",
      assetId: "pUSD",
    });
    expect(balance?.actualAmount).toBe("250");
  });
});

describe("round-2 HIGH-3: a fill cannot drop the account of the order it fills", () => {
  async function insertFillWithAccount(
    orderId: string,
    marketId: string,
    tokenId: string,
    accountRef: string | null,
    venueTradeId: string,
  ): Promise<string> {
    const client = await context.pool.connect();
    const fillId = uuidV7();
    try {
      await client.query("begin");
      await client.query(
        `insert into execution.fills
           (fill_id, order_id, market_id, token_id, environment, account_ref,
            venue_trade_id, venue_order_id, side, shares, price, notional,
            liquidity_role, matched_at)
         values ($1::uuid, $2::uuid, $3::uuid, $4::text,
                 (select o.environment from execution.orders as o where o.order_id = $2::uuid),
                 $5::text, $6::text, 'round2-venue-order', 'BUY', '1', '0.42', '0.42',
                 'TAKER', now())`,
        [fillId, orderId, marketId, tokenId, accountRef, venueTradeId],
      );
      await client.query(
        `insert into execution.fill_allocations
           (fill_allocation_id, fill_id, scope, allocated_shares)
         values ($1, $2, 'UNATTRIBUTED', '1')`,
        [uuidV7(), fillId],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    return fillId;
  }

  it("REJECTS a NULL-account fill of a LIVE, account-bearing order", async () => {
    // The bypass: `fills_order_account_fk` was MATCH SIMPLE over a nullable
    // column, so a child row with no account skipped the key entirely. The fill
    // stayed a fill of that LIVE order while disappearing from every
    // account-scoped exposure, reconciliation, and ledger query.
    const error = await captureRejection(async () =>
      insertFillWithAccount(
        liveOrderId,
        liveChain.marketId,
        liveChain.tokenId,
        null,
        "round2-live-null-account",
      ),
    );

    expect(errorCode(error)).toBe("23503");
    expect(constraintOf(error)).toBe("fills_order_account_fk");
  });

  it("REJECTS a NULL-account fill of a simulated, account-bearing order", async () => {
    const error = await captureRejection(async () =>
      insertFillWithAccount(
        paperOrderId,
        paperChain.marketId,
        paperChain.tokenId,
        null,
        "round2-paper-null-account",
      ),
    );

    expect(errorCode(error)).toBe("23503");
    expect(constraintOf(error)).toBe("fills_order_account_fk");
  });

  it("REJECTS a fill that names an account its order does not have", async () => {
    const error = await captureRejection(async () =>
      insertFillWithAccount(
        liveOrderId,
        liveChain.marketId,
        liveChain.tokenId,
        "round2-somebody-else",
        "round2-wrong-account",
      ),
    );

    expect(errorCode(error)).toBe("23503");
    expect(constraintOf(error)).toBe("fills_order_account_fk");
  });

  it("still records a fill of an order that genuinely has no account", async () => {
    // "No account" is representable, and it is representable exactly once: when
    // the order has none either. Both sides spell it the same way.
    const accountlessOrderId = await context.repositories.orders.insertOrder({
      planId: accountlessChain.planId,
      executionGroupId: accountlessChain.executionGroupId,
      submissionAttemptId: accountlessChain.submissionAttemptId,
      marketId: accountlessChain.marketId,
      tokenId: accountlessChain.tokenId,
      side: "BUY",
      limitPrice: "0.42",
      originalShares: "10",
      state: "LIVE",
    });

    const fillId = await insertFillWithAccount(
      accountlessOrderId,
      accountlessChain.marketId,
      accountlessChain.tokenId,
      null,
      "round2-accountless",
    );

    const stored = await context.repositories.fills.findFill(fillId);
    expect(stored?.fill.account_ref).toBeNull();
  });

  it("still records a truthful fill of the live order", async () => {
    const stored = await context.repositories.fills.findFill(liveFillId);
    expect(stored?.fill.environment).toBe("LIVE");
    expect(stored?.fill.account_ref).toBe(LIVE_ACCOUNT);
  });
});

describe("round-2 HIGH-4: a lease that ended stays ended, and its token stays spent", () => {
  let releasedLeaseId: string;
  let releasedToken: string;

  beforeAll(async () => {
    const lease = await context.repositories.fencing.acquireLease({
      accountRef: FENCE_ACCOUNT,
      environment: "LIVE",
      holderId: "round2-first-holder",
      expiresAt: inSeconds(600),
    });
    releasedLeaseId = lease.fencingLeaseId;
    releasedToken = lease.fencingToken;
    await context.repositories.fencing.releaseLease(releasedLeaseId, "handover");
  });

  it("REJECTS resurrecting a released lease", async () => {
    // The bypass: the immutable-grant trigger protected the token and the
    // identity but not `status`, `released_at`, or `expires_at`, so one UPDATE
    // gave the previous holder its authority — and its already-spent token —
    // back. ADR-008 §1: a token is never reused.
    const error = await captureRejection(async () =>
      context.pool.query(
        `update ops.fencing_leases
            set status = 'ACTIVE', released_at = null,
                expires_at = clock_timestamp() + interval '5 minutes'
          where fencing_lease_id = $1`,
        [releasedLeaseId],
      ),
    );

    expect(errorCode(error)).toBe("PMB10");
    expect(mapPostgresError(error)).toBeInstanceOf(FencingLeaseNotForwardOnlyError);

    const lease = await context.pool.query<{ status: string }>(
      `select status from ops.fencing_leases where fencing_lease_id = $1`,
      [releasedLeaseId],
    );
    expect(lease.rows[0]?.status).toBe("RELEASED");
  });

  it("REJECTS extending a released lease's expiry, which is the same move", async () => {
    const error = await captureRejection(async () =>
      context.pool.query(
        `update ops.fencing_leases set expires_at = now() + interval '1 hour'
          where fencing_lease_id = $1`,
        [releasedLeaseId],
      ),
    );

    expect(errorCode(error)).toBe("PMB10");
  });

  it("REJECTS deleting lease history", async () => {
    const error = await captureRejection(async () =>
      context.pool.query(`delete from ops.fencing_leases where fencing_lease_id = $1`, [
        releasedLeaseId,
      ]),
    );

    expect(errorCode(error)).toBe("PMB01");
  });

  it("REJECTS truncating the lease table, plainly or by cascade", async () => {
    // A plain TRUNCATE never reaches the trigger: `execution.orders` references
    // the lease table, and PostgreSQL refuses (0A000) before any BEFORE TRUNCATE
    // trigger runs. CASCADE is the statement that would get past that, and it is
    // what the statement-level guard is for.
    const plain = await captureRejection(async () =>
      context.pool.query(`truncate table ops.fencing_leases`),
    );
    expect(errorCode(plain)).toBe("0A000");

    const cascading = await captureRejection(async () =>
      context.pool.query(`truncate table ops.fencing_leases cascade`),
    );
    expect(errorCode(cascading)).toBe("PMB01");
  });

  it("REJECTS re-issuing the released token to a new holder", async () => {
    const error = await captureRejection(async () =>
      context.pool.query(
        `insert into ops.fencing_leases
           (fencing_lease_id, account_ref, environment, fencing_token, holder_id, expires_at)
         values ($1, $2, 'LIVE', $3, 'round2-impostor', now() + interval '5 minutes')`,
        [uuidV7(), FENCE_ACCOUNT, releasedToken],
      ),
    );

    expect(errorCode(error)).toBe("PMB07");
  });

  it("REJECTS a reused token even when the lease history has been erased", async () => {
    // The token sequence no longer depends on the lease rows surviving. Written
    // with the delete guard disabled so the *other* half of the defence is what
    // is under test: without the high-water mark, `max(fencing_token)` over an
    // emptied table is 0, and the next acquisition re-issues token 1 to a new
    // holder while a previous holder's writes still carry it.
    const lease = await context.repositories.fencing.acquireLease({
      accountRef: ERASURE_ACCOUNT,
      environment: "LIVE",
      holderId: "round2-erasure-holder",
      expiresAt: inSeconds(600),
    });
    await context.repositories.fencing.releaseLease(lease.fencingLeaseId, "erasure test");

    await context.pool.query(
      `alter table ops.fencing_leases disable trigger fencing_leases_no_delete`,
    );
    try {
      await context.pool.query(`delete from ops.fencing_leases where account_ref = $1`, [
        ERASURE_ACCOUNT,
      ]);
    } finally {
      await context.pool.query(
        `alter table ops.fencing_leases enable trigger fencing_leases_no_delete`,
      );
    }

    const surviving = await context.pool.query<{ count: string }>(
      `select count(*)::text as count from ops.fencing_leases where account_ref = $1`,
      [ERASURE_ACCOUNT],
    );
    expect(surviving.rows[0]?.count).toBe("0");

    const error = await captureRejection(async () =>
      context.pool.query(
        `insert into ops.fencing_leases
           (fencing_lease_id, account_ref, environment, fencing_token, holder_id, expires_at)
         values ($1, $2, 'LIVE', $3, 'round2-erasure-successor', now() + interval '5 minutes')`,
        [uuidV7(), ERASURE_ACCOUNT, lease.fencingToken],
      ),
    );

    expect(errorCode(error)).toBe("PMB07");
    expect((error as { message: string }).message).toMatch(/not above the highest issued token/u);
  });

  it("REJECTS lowering or deleting the high-water mark itself", async () => {
    // Relative, not absolute: the assertion is "it cannot go down", whatever it
    // currently is.
    const lowering = await captureRejection(async () =>
      context.pool.query(
        `update ops.fencing_token_high_water set highest_token = highest_token - 1
          where account_ref = $1`,
        [FENCE_ACCOUNT],
      ),
    );
    expect(errorCode(lowering)).toBe("PMB07");

    const deleting = await captureRejection(async () =>
      context.pool.query(`delete from ops.fencing_token_high_water where account_ref = $1`, [
        FENCE_ACCOUNT,
      ]),
    );
    expect(errorCode(deleting)).toBe("PMB07");

    const truncating = await captureRejection(async () =>
      context.pool.query(`truncate table ops.fencing_token_high_water`),
    );
    expect(errorCode(truncating)).toBe("PMB01");
  });

  it("still lets a successor acquire the fence with a higher token", async () => {
    const successor = await context.repositories.fencing.acquireLease({
      accountRef: FENCE_ACCOUNT,
      environment: "LIVE_MICRO",
      holderId: "round2-successor",
      expiresAt: inSeconds(600),
    });

    expect(BigInt(successor.fencingToken)).toBe(BigInt(releasedToken) + 1n);
    expect(successor.status).toBe("ACTIVE");
  });

  it("still lets an ACTIVE lease heartbeat and then end", async () => {
    const lease = await context.repositories.fencing.findActiveLease(FENCE_ACCOUNT, "LIVE_MICRO");

    const beat = await context.repositories.fencing.recordHeartbeat({
      fencingLeaseId: lease?.fencingLeaseId ?? "",
      holderId: "round2-successor",
      heartbeatId: "round2-hb",
      expiresAt: inSeconds(600),
    });
    expect(beat).toBe(true);

    await context.repositories.fencing.releaseLease(lease?.fencingLeaseId ?? "", "done");
    const after = await context.repositories.fencing.findActiveLease(FENCE_ACCOUNT, "LIVE_MICRO");
    expect(after).toBeUndefined();
  });
});

describe("round-2 F10: a ledger transaction cannot mislabel the order or fill it books", () => {
  async function postHeader(values: {
    readonly environment: string;
    readonly accountRef: string;
    readonly orderId?: string | null;
    readonly fillId?: string | null;
    readonly marketId?: string | null;
  }): Promise<unknown> {
    return context.pool.query(
      `insert into accounting.ledger_transactions
         (ledger_transaction_id, event_type, environment, account_ref, market_id, order_id,
          fill_id, source, occurred_at)
       values ($1, 'TRADE_PRINCIPAL', $2, $3, $4, $5, $6, 'internal', now())`,
      [
        uuidV7(),
        values.environment,
        values.accountRef,
        values.marketId ?? null,
        values.orderId ?? null,
        values.fillId ?? null,
      ],
    );
  }

  // Each bypass below names the *correct* market, so the environment or the
  // account is the only thing wrong with the row and is therefore what reports.
  // Round 3 added `ledger_transactions_execution_link_has_market`, which rejects
  // an execution-linked transaction that omits the market at all; without the
  // market these rows would now fail that CHECK first and stop being tests of
  // the discriminator binding. Nothing was weakened — the row is strictly more
  // truthful and still rejected.

  it("REJECTS a PAPER-labelled transaction that books a LIVE fill", async () => {
    // The bypass: `environment`, `account_ref`, and `market_id` were independent
    // labels beside a scalar `fill_id`. The ledger is the monetary source of
    // truth (ADR-006 §1) and it is append-only, so a mislabelled transaction is
    // a permanent corruption of what every projection is rebuilt from.
    const error = await captureRejection(async () =>
      postHeader({
        environment: "PAPER",
        accountRef: LIVE_ACCOUNT,
        marketId: liveChain.marketId,
        fillId: liveFillId,
      }),
    );

    expect(errorCode(error)).toBe("23503");
    expect(constraintOf(error)).toBe("ledger_transactions_fill_environment_fk");
  });

  it("REJECTS a PAPER-labelled transaction that books a LIVE order", async () => {
    const error = await captureRejection(async () =>
      postHeader({
        environment: "PAPER",
        accountRef: LIVE_ACCOUNT,
        marketId: liveChain.marketId,
        orderId: liveOrderId,
      }),
    );

    expect(errorCode(error)).toBe("23503");
    expect(constraintOf(error)).toBe("ledger_transactions_order_environment_fk");
  });

  it("REJECTS a transaction that books another account's fill", async () => {
    const error = await captureRejection(async () =>
      postHeader({
        environment: "LIVE",
        accountRef: "round2-not-the-owner",
        marketId: liveChain.marketId,
        fillId: liveFillId,
      }),
    );

    expect(errorCode(error)).toBe("23503");
    expect(constraintOf(error)).toBe("ledger_transactions_fill_account_fk");
  });

  it("REJECTS a transaction whose market is not the order's", async () => {
    const error = await captureRejection(async () =>
      postHeader({
        environment: "LIVE",
        accountRef: LIVE_ACCOUNT,
        orderId: liveOrderId,
        marketId: paperChain.marketId,
      }),
    );

    expect(errorCode(error)).toBe("23503");
    expect(constraintOf(error)).toBe("ledger_transactions_order_market_fk");
  });

  it("REJECTS a transaction that pairs an order with another order's fill", async () => {
    // Same environment, same account, same market: only the pairing is wrong.
    const error = await captureRejection(async () =>
      postHeader({
        environment: "LIVE",
        accountRef: LIVE_ACCOUNT,
        marketId: liveChain.marketId,
        orderId: liveOrderId,
        fillId: secondLiveFillId,
      }),
    );

    expect(errorCode(error)).toBe("23503");
    expect(constraintOf(error)).toBe("ledger_transactions_fill_order_fk");
  });

  it("accepts a truthful order- and fill-linked transaction", async () => {
    const id = await context.repositories.ledger.postTransaction({
      eventType: "TRADE_PRINCIPAL",
      environment: "LIVE",
      accountRef: LIVE_ACCOUNT,
      marketId: liveChain.marketId,
      orderId: liveOrderId,
      fillId: liveFillId,
      source: "internal",
      occurredAt: fixtureTimestamp(),
      entries: [
        {
          scope: "ACTUAL_ACCOUNT",
          accountRef: LIVE_ACCOUNT,
          assetId: "pUSD",
          assetKind: "COLLATERAL",
          amount: "-4.2",
        },
        {
          scope: "EXTERNAL_CLEARING",
          accountRef: LIVE_ACCOUNT,
          assetId: "pUSD",
          assetKind: "COLLATERAL",
          amount: "4.2",
        },
      ],
    });

    const stored = await context.repositories.ledger.findTransaction(id);
    expect(stored?.transaction.fill_id).toBe(liveFillId);
    expect(stored?.transaction.environment).toBe("LIVE");
  });

  it("accepts a standalone transaction that books no order or fill", async () => {
    // §9.15: external clearing, manual adjustments, and resolutions have
    // discriminators of their own. The binding is scoped to rows that reference
    // an execution fact, so it does not fire here.
    const id = await context.repositories.ledger.postTransaction({
      eventType: "MANUAL_ADJUSTMENT",
      environment: "PAPER",
      accountRef: "round2-standalone-account",
      source: "internal",
      occurredAt: fixtureTimestamp(),
      entries: [
        {
          scope: "ACTUAL_ACCOUNT",
          accountRef: "round2-standalone-account",
          assetId: "pUSD",
          assetKind: "COLLATERAL",
          amount: "5",
        },
        {
          scope: "EXTERNAL_CLEARING",
          accountRef: "round2-standalone-account",
          assetId: "pUSD",
          assetKind: "COLLATERAL",
          amount: "-5",
        },
      ],
    });

    const stored = await context.repositories.ledger.findTransaction(id);
    expect(stored?.transaction.order_id).toBeNull();
    expect(stored?.entries).toHaveLength(2);
  });
});

describe("round-2 MEDIUM: a submitted order carries the attempt that signed it", () => {
  async function insertOrderInState(
    state: string,
    extra: { readonly filledShares?: string; readonly venueOrderId?: string | null } = {},
  ): Promise<unknown> {
    return context.pool.query(
      `insert into execution.orders
         (order_id, plan_id, execution_group_id, market_id, token_id, environment, account_ref,
          side, limit_price, original_shares, filled_shares, state, venue_order_id)
       values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::text,
               (select p.environment from execution.plans as p where p.plan_id = $2::uuid),
               (select p.account_ref from execution.plans as p where p.plan_id = $2::uuid),
               'BUY', '0.42', '10', $6::text, $7::internal.order_state, $8::text)`,
      [
        uuidV7(),
        paperChain.planId,
        paperChain.executionGroupId,
        paperChain.marketId,
        paperChain.tokenId,
        extra.filledShares ?? "0",
        state,
        extra.venueOrderId ?? null,
      ],
    );
  }

  it("REJECTS a FILLED order with no submission attempt", async () => {
    const error = await captureRejection(async () =>
      insertOrderInState("FILLED", { filledShares: "10", venueOrderId: "round2-filled" }),
    );

    expect(errorCode(error)).toBe("23514");
    expect(constraintOf(error)).toBe("orders_submission_requires_attempt");
  });

  it("REJECTS a LIVE order with no submission attempt", async () => {
    const error = await captureRejection(async () => insertOrderInState("LIVE"));

    expect(errorCode(error)).toBe("23514");
    expect(constraintOf(error)).toBe("orders_submission_requires_attempt");
  });

  it("REJECTS a CANCELED order that nevertheless reached the venue", async () => {
    // The exemption is not a state label: a terminal state with a venue identity
    // was submitted, and a submitted order has a signed payload behind it.
    const error = await captureRejection(async () =>
      insertOrderInState("CANCELED", { venueOrderId: "round2-canceled-at-venue" }),
    );

    expect(errorCode(error)).toBe("23514");
    expect(constraintOf(error)).toBe("orders_submission_requires_attempt");
  });

  it("still allows the pre-submission states", async () => {
    // `SIGNED` was in this list when round 2 wrote it, and that was a bug the
    // test encoded rather than caught: §9.11 creates the submission attempt at
    // step 1 and commits `SIGNED` at step 4, so an attemptless `SIGNED` order is
    // a signed order with no signed payload on record. Round 3 removed it from
    // the exemption; the rejection is asserted in
    // `authority-bypass-round3.test.ts`.
    for (const state of ["PLANNED", "CANCELED", "EXPIRED"]) {
      const inserted = await insertOrderInState(state);
      expect((inserted as { rowCount: number }).rowCount, state).toBe(1);
    }
  });

  it("REJECTS a fill whose order has no submission attempt", async () => {
    const attemptlessOrderId = await context.repositories.orders.insertOrder({
      planId: paperChain.planId,
      executionGroupId: paperChain.executionGroupId,
      marketId: paperChain.marketId,
      tokenId: paperChain.tokenId,
      side: "BUY",
      limitPrice: "0.42",
      originalShares: "10",
      state: "PLANNED",
    });

    const error = await captureRejection(async () =>
      context.repositories.fills.recordFill({
        orderId: attemptlessOrderId,
        marketId: paperChain.marketId,
        tokenId: paperChain.tokenId,
        venueTradeId: "round2-no-attempt-trade",
        venueOrderId: "round2-no-attempt-order",
        side: "BUY",
        shares: "1",
        price: "0.42",
        notional: "0.42",
        liquidityRole: "TAKER",
        matchedAt: fixtureTimestamp(),
        allocations: [{ scope: "UNATTRIBUTED", allocatedShares: "1" }],
      }),
    );

    expect(error).toBeInstanceOf(MissingSubmissionAttemptError);
    expect((error as MissingSubmissionAttemptError).sqlState).toBe("PMB11");
  });

  it("REJECTS detaching the attempt from an order that already has one", async () => {
    const error = await captureRejection(async () =>
      context.pool.query(
        `update execution.orders set submission_attempt_id = null where order_id = $1`,
        [liveOrderId],
      ),
    );

    expect(errorCode(error)).toBe("PMB02");
  });

  it("still lets an order be signed after it was planned", async () => {
    const plannedOrderId = await context.repositories.orders.insertOrder({
      planId: paperChain.planId,
      executionGroupId: paperChain.executionGroupId,
      marketId: paperChain.marketId,
      tokenId: paperChain.tokenId,
      side: "BUY",
      limitPrice: "0.42",
      originalShares: "10",
      state: "PLANNED",
    });

    const attemptId = await context.repositories.orders.recordSubmissionAttempt({
      executionGroupId: paperChain.executionGroupId,
      planId: paperChain.planId,
      attemptOrdinal: 20,
      signedPayload: { price: "0.42" },
      salt: "round2-late-attach",
    });

    await context.pool.query(
      `update execution.orders set submission_attempt_id = $1, state = 'SENDING' where order_id = $2`,
      [attemptId, plannedOrderId],
    );

    const order = await context.repositories.orders.findOrder(plannedOrderId);
    expect(order?.submission_attempt_id).toBe(attemptId);
  });
});
