/**
 * Bypass reproductions for the WP-040 round-1 review findings (HIGH-1..HIGH-4).
 *
 * Every test in this file is written as the *attacker's* sequence, not as the
 * repository's happy path: each one writes through `context.pool` with plain
 * SQL, because the finding in each case was that the invariant held only for a
 * writer that went through this package's repositories. An invariant that a
 * second connection can step around is not a database invariant, and §10.7
 * asks for database constraints.
 *
 * These tests failed before the round-1 remediation — that is what made them
 * worth writing — and each one names the constraint that now rejects the
 * sequence.
 */

import type { TestContext } from "@polymarket-bot/storage-postgres/testing";
import { createTradingChain } from "@polymarket-bot/storage-postgres/testing";
import {
  NegativeAvailableBalanceError,
  NonRealModeFencingLeaseError,
  ReservedAmountMismatchError,
  mapPostgresError,
  uuidV7,
} from "@polymarket-bot/storage-postgres";
import { beforeAll, describe, expect, it } from "vitest";

import { captureRejection, useMigratedDatabase } from "./context.js";

const getContext = useMigratedDatabase("authority_bypass");

const RESERVATION_ACCOUNT = "bypass-reservation-account";
const RACE_ACCOUNT = "bypass-race-account";
const ORDER_ACCOUNT = "bypass-live-account";
const BACKDATE_ACCOUNT = "bypass-backdate-account";
const RELEASE_ACCOUNT = "bypass-release-account";
const LEASE_ACCOUNT = "bypass-lease-account";

let context: TestContext;
let paperChain: Awaited<ReturnType<typeof createTradingChain>>;
let liveChain: Awaited<ReturnType<typeof createTradingChain>>;
let backdateChain: Awaited<ReturnType<typeof createTradingChain>>;
let releaseChain: Awaited<ReturnType<typeof createTradingChain>>;

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string }).code;
}

function sqlState(error: unknown): string | undefined {
  const direct = (error as { sqlState?: string }).sqlState;
  return direct ?? (error as { code?: string }).code;
}

async function insertReservation(
  client: { query: (text: string, values?: unknown[]) => Promise<unknown> },
  accountRef: string,
  amount: string,
): Promise<unknown> {
  return client.query(
    `insert into accounting.inventory_reservations
       (inventory_reservation_id, account_ref, environment, asset_id, asset_kind, amount)
     values ($1, $2, 'PAPER', 'pUSD', 'COLLATERAL', $3)`,
    [uuidV7(), accountRef, amount],
  );
}

beforeAll(async () => {
  context = getContext();

  paperChain = await createTradingChain(context, {
    label: "bypass_paper",
    environment: "PAPER",
    accountRef: "bypass-paper-account",
  });
  liveChain = await createTradingChain(context, {
    label: "bypass_live",
    environment: "LIVE",
    accountRef: ORDER_ACCOUNT,
  });
  backdateChain = await createTradingChain(context, {
    label: "bypass_backdate",
    environment: "LIVE",
    accountRef: BACKDATE_ACCOUNT,
  });
  releaseChain = await createTradingChain(context, {
    label: "bypass_release",
    environment: "LIVE",
    accountRef: RELEASE_ACCOUNT,
  });
});

describe("HIGH-1: reservations cannot exceed the actual balance", () => {
  it("REJECTS a direct write that lowers reserved_amount below the reservation facts", async () => {
    await context.repositories.balances.setActualBalance(
      { accountRef: RESERVATION_ACCOUNT, environment: "PAPER", assetId: "pUSD" },
      "COLLATERAL",
      "100",
    );
    await context.repositories.balances.reserve({
      accountRef: RESERVATION_ACCOUNT,
      environment: "PAPER",
      assetId: "pUSD",
      assetKind: "COLLATERAL",
      amount: "100",
    });

    // The bypass: rewrite the projection so the CHECK compares against a value
    // the reservations do not support, then reserve the same funds again.
    const error = await captureRejection(async () =>
      context.pool.query(
        `update accounting.balance_projection set reserved_amount = '0'
         where account_ref = $1 and environment = 'PAPER' and asset_id = 'pUSD'`,
        [RESERVATION_ACCOUNT],
      ),
    );
    expect(errorCode(error)).toBe("PMB08");

    const balance = await context.repositories.balances.findBalance({
      accountRef: RESERVATION_ACCOUNT,
      environment: "PAPER",
      assetId: "pUSD",
    });
    expect(balance?.reservedAmount).toBe("100");
    expect(balance?.availableAmount).toBe("0");
  });

  it("REJECTS the second reservation the bypass was trying to buy", async () => {
    const error = await captureRejection(async () =>
      context.repositories.balances.reserve({
        accountRef: RESERVATION_ACCOUNT,
        environment: "PAPER",
        assetId: "pUSD",
        assetKind: "COLLATERAL",
        amount: "100",
      }),
    );

    expect(error).toBeInstanceOf(NegativeAvailableBalanceError);
  });

  it("REJECTS deleting a balance row that active reservations depend on", async () => {
    const error = await captureRejection(async () =>
      context.pool.query(
        `delete from accounting.balance_projection
         where account_ref = $1 and environment = 'PAPER' and asset_id = 'pUSD'`,
        [RESERVATION_ACCOUNT],
      ),
    );

    expect(errorCode(error)).toBe("PMB08");
  });

  it("REJECTS an upsert that restates reserved_amount", async () => {
    // Re-establishing the row is the other half of the same bypass.
    const error = await captureRejection(async () =>
      context.pool.query(
        `insert into accounting.balance_projection
           (account_ref, environment, asset_id, asset_kind, actual_amount, reserved_amount)
         values ($1, 'PAPER', 'pUSD', 'COLLATERAL', '100', '0')
         on conflict (account_ref, environment, asset_id) do update
           set reserved_amount = '0'`,
        [RESERVATION_ACCOUNT],
      ),
    );

    expect(errorCode(error)).toBe("PMB08");
  });

  it("corrects, rather than trusts, a reserved_amount supplied on insert", async () => {
    // A fresh row cannot contradict anything, so the facts are written in. The
    // value below is ignored, not honoured — an INSERT is not a way to declare
    // a reservation total.
    await context.pool.query(
      `insert into accounting.balance_projection
         (account_ref, environment, asset_id, asset_kind, actual_amount, reserved_amount)
       values ($1, 'PAPER', 'insert-coercion', 'COLLATERAL', '100', '99')`,
      [RESERVATION_ACCOUNT],
    );

    const balance = await context.repositories.balances.findBalance({
      accountRef: RESERVATION_ACCOUNT,
      environment: "PAPER",
      assetId: "insert-coercion",
    });
    expect(balance?.reservedAmount).toBe("0");
    expect(balance?.availableAmount).toBe("100");
  });

  it("maps PMB08 to a typed error through the repository", async () => {
    // The raw-SQL assertions above prove the database rejects the bypass; this
    // one proves a caller of this package gets a type rather than a SQLSTATE.
    const error = await captureRejection(async () =>
      context.db
        .updateTable("accounting.balance_projection")
        // Only reachable with a cast: `reserved_amount` is not writable in the
        // typed schema, which is the point of the cast being needed here.
        .set({ actual_amount: "100", reserved_amount: "0" } as never)
        .where("account_ref", "=", RESERVATION_ACCOUNT)
        .where("environment", "=", "PAPER")
        .where("asset_id", "=", "pUSD")
        .execute()
        .catch((cause: unknown) => {
          throw mapPostgresError(cause);
        }),
    );

    expect(error).toBeInstanceOf(ReservedAmountMismatchError);
    expect(sqlState(error)).toBe("PMB08");
  });

  it("REJECTS truncating either table, which no row-level guard would see", async () => {
    for (const table of [
      "accounting.balance_projection",
      "accounting.inventory_reservations",
    ]) {
      const error = await captureRejection(async () =>
        context.pool.query(`truncate table ${table}`),
      );
      expect(errorCode(error), table).toBe("PMB01");
    }
  });

  it("cannot be oversubscribed by two concurrent sessions", async () => {
    await context.repositories.balances.setActualBalance(
      { accountRef: RACE_ACCOUNT, environment: "PAPER", assetId: "pUSD" },
      "COLLATERAL",
      "100",
    );

    const first = await context.pool.connect();
    const second = await context.pool.connect();
    try {
      await first.query("begin");
      await second.query("begin");

      await insertReservation(first, RACE_ACCOUNT, "60");

      // Blocks on the balance row until the first session commits.
      const secondOutcome = insertReservation(second, RACE_ACCOUNT, "60")
        .then(() => "accepted")
        .catch((error: unknown) => errorCode(error) ?? "unknown");

      await first.query("commit");

      expect(await secondOutcome).toBe("23514");
      await second.query("rollback");
    } finally {
      first.release();
      second.release();
    }

    const balance = await context.repositories.balances.findBalance({
      accountRef: RACE_ACCOUNT,
      environment: "PAPER",
      assetId: "pUSD",
    });
    expect(balance?.reservedAmount).toBe("60");
    expect(balance?.availableAmount).toBe("40");
  });
});

describe("HIGH-2: market ownership cannot mislabel its environment", () => {
  let firstLiveInstanceId: string;
  let secondLiveInstanceId: string;

  beforeAll(async () => {
    firstLiveInstanceId = await context.repositories.strategy.createInstance({
      instanceName: "bypass-live-owner-a",
      definitionId: liveChain.definitionId,
      configId: liveChain.configId,
      environment: "LIVE",
      seriesId: liveChain.seriesId,
      accountRef: ORDER_ACCOUNT,
      defaultOwnershipMode: "LIVE_OWNER",
    });
    secondLiveInstanceId = await context.repositories.strategy.createInstance({
      instanceName: "bypass-live-owner-b",
      definitionId: liveChain.definitionId,
      configId: liveChain.configId,
      environment: "LIVE",
      seriesId: liveChain.seriesId,
      accountRef: ORDER_ACCOUNT,
      defaultOwnershipMode: "LIVE_OWNER",
    });
  });

  it("lets the first LIVE instance take live ownership", async () => {
    const ownershipId = await context.repositories.ownership.acquireOwnership({
      marketId: liveChain.marketId,
      instanceId: firstLiveInstanceId,
      ownershipMode: "LIVE_OWNER",
    });
    expect(ownershipId).toMatch(/^[0-9a-f]{8}-/u);
  });

  it("REJECTS a second LIVE instance that claims the market as PAPER", async () => {
    // The bypass: `environment` used to be caller-supplied and untied to the
    // instance, so two LIVE instances could own one market by labelling one of
    // the rows with a simulated realm.
    const error = await captureRejection(async () =>
      context.pool.query(
        `insert into strategy.market_ownership
           (market_ownership_id, market_id, instance_id, environment, ownership_mode)
         values ($1, $2, $3, 'PAPER', 'LIVE_OWNER')`,
        [uuidV7(), liveChain.marketId, secondLiveInstanceId],
      ),
    );

    expect(errorCode(error)).toBe("23503");
  });

  it("REJECTS a second LIVE instance claiming the market truthfully", async () => {
    const error = await captureRejection(async () =>
      context.repositories.ownership.acquireOwnership({
        marketId: liveChain.marketId,
        instanceId: secondLiveInstanceId,
        ownershipMode: "LIVE_OWNER",
      }),
    );

    expect(errorCode(error)).toBe("UNIQUE_VIOLATION");
    expect((error as { constraintName?: string }).constraintName).toBe(
      "market_ownership_one_active_live_owner",
    );
  });
});

describe("HIGH-3: fencing cannot be bypassed by discriminator or clock", () => {
  it("REJECTS an order that claims a simulated environment on a LIVE plan", async () => {
    // The bypass: the CHECK reads the order's own discriminator, so an order
    // that named a LIVE plan but claimed PAPER skipped fencing entirely.
    //
    // `PLANNED`, so the mislabelled discriminator is the only thing wrong with
    // the row: a submitted state would additionally need the attempt that signed
    // it (round 2), and the CHECK would report before the foreign key does.
    const error = await captureRejection(async () =>
      context.pool.query(
        `insert into execution.orders
           (order_id, plan_id, market_id, token_id, environment, account_ref,
            side, limit_price, original_shares, state)
         values ($1, $2, $3, $4, 'PAPER', $5, 'BUY', '0.42', '1', 'PLANNED')`,
        [uuidV7(), liveChain.planId, liveChain.marketId, liveChain.tokenId, ORDER_ACCOUNT],
      ),
    );

    expect(errorCode(error)).toBe("23503");
  });

  it("REJECTS a submission attempt that claims a simulated environment on a LIVE plan", async () => {
    const error = await captureRejection(async () =>
      context.pool.query(
        `insert into execution.submission_attempts
           (submission_attempt_id, execution_group_id, plan_id, environment, account_ref,
            signed_payload, salt)
         values ($1, $2, $3, 'PAPER', $4, '{}'::jsonb, 'bypass-salt')`,
        [uuidV7(), liveChain.executionGroupId, liveChain.planId, ORDER_ACCOUNT],
      ),
    );

    expect(errorCode(error)).toBe("23503");
  });

  it("REJECTS an order that claims another account than its plan", async () => {
    // A simulated plan, so the live-order fencing CHECK (which fires first, and
    // would reject this row for the other, correct reason) is out of the way and
    // the account binding is what is actually under test.
    const error = await captureRejection(async () =>
      context.pool.query(
        `insert into execution.orders
           (order_id, plan_id, market_id, token_id, environment, account_ref,
            side, limit_price, original_shares, state)
         values ($1, $2, $3, $4, 'PAPER', 'some-other-account', 'BUY', '0.42', '1', 'PLANNED')`,
        [uuidV7(), paperChain.planId, paperChain.marketId, paperChain.tokenId],
      ),
    );

    expect(errorCode(error)).toBe("23503");
    expect((error as { constraint?: string }).constraint).toBe("orders_plan_account_fk");
  });

  it("REJECTS a live order authorized by an expired lease through a backdated timestamp", async () => {
    // The bypass: lease validity was checked against the caller's own
    // `submitted_at`, so an expired-but-ACTIVE lease authorized any write that
    // claimed to have happened before the expiry.
    const expiredLeaseId = uuidV7();
    await context.pool.query(
      `insert into ops.fencing_leases
         (fencing_lease_id, account_ref, environment, fencing_token, holder_id,
          status, acquired_at, expires_at)
       values ($1, $2, 'LIVE', 1, 'stale-holder', 'ACTIVE',
               now() - interval '2 hours', now() - interval '1 hour')`,
      [expiredLeaseId, BACKDATE_ACCOUNT],
    );

    const error = await captureRejection(async () =>
      context.pool.query(
        `insert into execution.orders
           (order_id, plan_id, market_id, token_id, environment, account_ref,
            side, limit_price, original_shares, state,
            fencing_lease_id, fencing_token, submitted_at)
         values ($1, $2, $3, $4, 'LIVE', $5, 'BUY', '0.42', '1', 'LIVE',
                 $6, 1, now() - interval '90 minutes')`,
        [
          uuidV7(),
          backdateChain.planId,
          backdateChain.marketId,
          backdateChain.tokenId,
          BACKDATE_ACCOUNT,
          expiredLeaseId,
        ],
      ),
    );

    expect(errorCode(error)).toBe("PMB06");
    expect((error as { message: string }).message).toMatch(/expired at/u);
  });

  it("serializes a live order insert against a concurrent lease release", async () => {
    const lease = await context.repositories.fencing.acquireLease({
      accountRef: RELEASE_ACCOUNT,
      environment: "LIVE",
      holderId: "release-race-holder",
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    });

    const releasing = await context.pool.connect();
    const inserting = await context.pool.connect();
    try {
      await releasing.query("begin");
      await releasing.query(
        `update ops.fencing_leases
            set status = 'RELEASED', released_at = now(), revoked_reason = 'race'
          where fencing_lease_id = $1`,
        [lease.fencingLeaseId],
      );

      // The bypass: without a row lock the trigger read the pre-release version
      // of the lease and authorized the order anyway.
      const insertOutcome = inserting
        .query(
          `insert into execution.orders
             (order_id, plan_id, market_id, token_id, environment, account_ref,
              side, limit_price, original_shares, state, fencing_lease_id, fencing_token)
           values ($1, $2, $3, $4, 'LIVE', $5, 'BUY', '0.42', '1', 'LIVE', $6, $7)`,
          [
            uuidV7(),
            releaseChain.planId,
            releaseChain.marketId,
            releaseChain.tokenId,
            RELEASE_ACCOUNT,
            lease.fencingLeaseId,
            lease.fencingToken,
          ],
        )
        .then(() => "accepted")
        .catch((error: unknown) => errorCode(error) ?? "unknown");

      await releasing.query("commit");

      expect(await insertOutcome).toBe("PMB06");
    } finally {
      releasing.release();
      inserting.release();
    }
  });

  it("still accepts a live order under a valid ACTIVE lease", async () => {
    const lease = await context.repositories.fencing.acquireLease({
      accountRef: ORDER_ACCOUNT,
      environment: "LIVE",
      holderId: "legitimate-holder",
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    });
    const fencing = {
      fencingLeaseId: lease.fencingLeaseId,
      fencingToken: lease.fencingToken,
    };

    const submissionAttemptId = await context.repositories.orders.recordSubmissionAttempt({
      executionGroupId: liveChain.executionGroupId,
      planId: liveChain.planId,
      signedPayload: { price: "0.42", size: "1" },
      salt: "legitimate-salt",
      fencing,
    });

    const orderId = await context.repositories.orders.insertOrder({
      planId: liveChain.planId,
      executionGroupId: liveChain.executionGroupId,
      submissionAttemptId,
      marketId: liveChain.marketId,
      tokenId: liveChain.tokenId,
      side: "BUY",
      limitPrice: "0.42",
      originalShares: "1",
      state: "LIVE",
      fencing,
    });

    const order = await context.repositories.orders.findOrder(orderId);
    expect(order?.environment).toBe("LIVE");
    expect(order?.account_ref).toBe(ORDER_ACCOUNT);
  });

  it("still accepts a simulated order with no fencing reference", async () => {
    const orderId = await context.repositories.orders.insertOrder({
      planId: paperChain.planId,
      executionGroupId: paperChain.executionGroupId,
      submissionAttemptId: paperChain.submissionAttemptId,
      marketId: paperChain.marketId,
      tokenId: paperChain.tokenId,
      side: "BUY",
      limitPrice: "0.42",
      originalShares: "1",
      state: "LIVE",
    });

    const order = await context.repositories.orders.findOrder(orderId);
    expect(order?.environment).toBe("PAPER");
    expect(order?.fencing_lease_id).toBeNull();
  });
});

describe("HIGH-4: one real writer per account, and none in a simulated mode", () => {
  it("issues a LIVE lease for a fresh account", async () => {
    const lease = await context.repositories.fencing.acquireLease({
      accountRef: LEASE_ACCOUNT,
      environment: "LIVE",
      holderId: "holder-live",
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    });
    expect(lease.fencingToken).toBe("1");
  });

  it("REJECTS a simultaneous LIVE_MICRO lease for the same account", async () => {
    // The bypass: the one-active-holder index was keyed by environment, so
    // LIVE, LIVE_MICRO, and EXECUTION_PROBE could each hold a live lease on one
    // account at the same time — three real writers, not one.
    const error = await captureRejection(async () =>
      context.pool.query(
        `insert into ops.fencing_leases
           (fencing_lease_id, account_ref, environment, fencing_token, holder_id, expires_at)
         values ($1, $2, 'LIVE_MICRO', 2, 'holder-micro', now() + interval '5 minutes')`,
        [uuidV7(), LEASE_ACCOUNT],
      ),
    );

    expect(errorCode(error)).toBe("23505");
    expect((error as { constraint?: string }).constraint).toBe(
      "fencing_leases_one_active_holder",
    );
  });

  it("REJECTS a LIVE_MICRO lease through the repository as well", async () => {
    const error = await captureRejection(async () =>
      context.repositories.fencing.acquireLease({
        accountRef: LEASE_ACCOUNT,
        environment: "LIVE_MICRO",
        holderId: "holder-micro",
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      }),
    );

    expect(errorCode(error)).toBe("FENCING_LEASE_HELD");
  });

  it("REJECTS acquiring a live fencing lease in PAPER (ADR-008 §2, ADR-010)", async () => {
    const error = await captureRejection(async () =>
      context.repositories.fencing.acquireLease({
        accountRef: "paper-fence-account",
        environment: "PAPER",
        holderId: "paper-holder",
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      }),
    );

    expect(error).toBeInstanceOf(NonRealModeFencingLeaseError);
  });

  it("REJECTS a PAPER lease written directly, not only through the repository", async () => {
    const error = await captureRejection(async () =>
      context.pool.query(
        `insert into ops.fencing_leases
           (fencing_lease_id, account_ref, environment, fencing_token, holder_id, expires_at)
         values ($1, 'paper-fence-account', 'PAPER', 1, 'paper-holder', now() + interval '5 minutes')`,
        [uuidV7()],
      ),
    );

    expect(errorCode(error)).toBe("23514");
    expect((error as { constraint?: string }).constraint).toBe("fencing_leases_real_modes_only");
  });

  it("still lets a single live holder release and a successor acquire", async () => {
    const lease = await context.repositories.fencing.findActiveLease(LEASE_ACCOUNT, "LIVE");
    await context.repositories.fencing.releaseLease(lease?.fencingLeaseId ?? "", "handover");

    const successor = await context.repositories.fencing.acquireLease({
      accountRef: LEASE_ACCOUNT,
      environment: "LIVE_MICRO",
      holderId: "holder-successor",
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    });

    // Monotonic across the whole real realm, not restarted per run mode.
    expect(successor.fencingToken).toBe("2");
  });
});
