/**
 * WP-040 acceptance 5: "Live orders require a fencing token reference."
 *
 * §10.7: "Every live order references a valid fencing token."
 * §9.18: "Redis is not sufficient as the only fence. Use a PostgreSQL advisory
 * lock or lease with a monotonic fencing token persisted with every live
 * submission."
 * ADR-008 §1: monotonic means monotonic — never reused, never decremented.
 *
 * "Valid" is tested in all four ways it can fail: absent, unknown, mismatched,
 * and stale. A foreign key alone would only catch the second.
 */

import type { TestContext } from "@polymarket-bot/storage-postgres/testing";
import { createTradingChain, fixtureTimestamp } from "@polymarket-bot/storage-postgres/testing";
import {
  ConstraintViolationError,
  FencingReferenceInvalidError,
  ForeignKeyViolationError,
  UniqueViolationError,
  uuidV7,
} from "@polymarket-bot/storage-postgres";
import { beforeAll, describe, expect, it } from "vitest";

import { captureRejection, useMigratedDatabase } from "./context.js";

const getContext = useMigratedDatabase("fencing");

const LIVE_ACCOUNT = "live-account";

let context: TestContext;
let paperChain: Awaited<ReturnType<typeof createTradingChain>>;
let liveChain: Awaited<ReturnType<typeof createTradingChain>>;

function inSeconds(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

beforeAll(async () => {
  context = getContext();
  paperChain = await createTradingChain(context, { label: "fence_paper", environment: "PAPER" });
  liveChain = await createTradingChain(context, {
    label: "fence_live",
    environment: "LIVE_MICRO",
    accountRef: LIVE_ACCOUNT,
  });
});

describe("fencing leases", () => {
  it("issues token 1 for a new account and marks the lease active", async () => {
    const lease = await context.repositories.fencing.acquireLease({
      accountRef: LIVE_ACCOUNT,
      environment: "LIVE_MICRO",
      holderId: "trader-a",
      expiresAt: inSeconds(300),
    });

    expect(lease.fencingToken).toBe("1");
    expect(lease.status).toBe("ACTIVE");
  });

  it("REJECTS a second holder while the lease is live (§2 one fenced writer)", async () => {
    const error = await captureRejection(async () =>
      context.repositories.fencing.acquireLease({
        accountRef: LIVE_ACCOUNT,
        environment: "LIVE_MICRO",
        holderId: "trader-b",
        expiresAt: inSeconds(300),
      }),
    );

    expect((error as { code?: string }).code).toBe("FENCING_LEASE_HELD");
  });

  it("REJECTS a reused or decremented token (ADR-008 §1)", async () => {
    const error = await captureRejection(async () =>
      context.pool.query(
        `insert into ops.fencing_leases
           (fencing_lease_id, account_ref, environment, fencing_token, holder_id, expires_at)
         values ($1, $2, 'LIVE_MICRO', 1, 'trader-c', now() + interval '5 minutes')`,
        [uuidV7(), LIVE_ACCOUNT],
      ),
    );
    expect((error as { code?: string }).code).toBe("PMB07");
  });

  it("refuses to rewrite the token of an issued lease", async () => {
    const error = await captureRejection(async () =>
      context.pool.query(
        `update ops.fencing_leases set fencing_token = 99 where account_ref = $1`,
        [LIVE_ACCOUNT],
      ),
    );
    expect((error as { code?: string }).code).toBe("PMB02");
  });
});

describe("live orders require a valid fencing token", () => {
  it("accepts a live order that names the current lease", async () => {
    const lease = await context.repositories.fencing.findActiveLease(LIVE_ACCOUNT, "LIVE_MICRO");
    expect(lease).toBeDefined();

    const orderId = await context.repositories.orders.insertOrder({
      planId: liveChain.planId,
      executionGroupId: liveChain.executionGroupId,
      marketId: liveChain.marketId,
      tokenId: liveChain.tokenId,
      environment: "LIVE_MICRO",
      accountRef: LIVE_ACCOUNT,
      side: "BUY",
      limitPrice: "0.42",
      originalShares: "1",
      state: "LIVE",
      fencing: {
        fencingLeaseId: lease?.fencingLeaseId ?? "",
        fencingToken: lease?.fencingToken ?? "",
      },
      submittedAt: fixtureTimestamp(),
    });

    const order = await context.repositories.orders.findOrder(orderId);
    expect(order?.fencing_token).toBe("1");
  });

  it("REJECTS a live order with NO fencing reference", async () => {
    const error = await captureRejection(async () =>
      context.repositories.orders.insertOrder({
        planId: liveChain.planId,
        executionGroupId: liveChain.executionGroupId,
        marketId: liveChain.marketId,
        tokenId: liveChain.tokenId,
        environment: "LIVE_MICRO",
        accountRef: LIVE_ACCOUNT,
        side: "BUY",
        limitPrice: "0.42",
        originalShares: "1",
        state: "LIVE",
      }),
    );

    expect(error).toBeInstanceOf(ConstraintViolationError);
    expect((error as ConstraintViolationError).constraintName).toBe(
      "orders_live_requires_fencing_token",
    );
  });

  it("REJECTS a live order naming a lease that does not exist", async () => {
    // The validity trigger fires before the composite foreign key, so this
    // surfaces as PMB06 rather than 23503. Both constraints exist — the foreign
    // key is asserted in migrations.test.ts — and the trigger is the stricter
    // of the two, so it is the one that reports.
    const error = await captureRejection(async () =>
      context.repositories.orders.insertOrder({
        planId: liveChain.planId,
        executionGroupId: liveChain.executionGroupId,
        marketId: liveChain.marketId,
        tokenId: liveChain.tokenId,
        environment: "LIVE_MICRO",
        accountRef: LIVE_ACCOUNT,
        side: "BUY",
        limitPrice: "0.42",
        originalShares: "1",
        state: "LIVE",
        fencing: { fencingLeaseId: uuidV7(), fencingToken: "1" },
      }),
    );

    expect(error).toBeInstanceOf(FencingReferenceInvalidError);
    expect((error as FencingReferenceInvalidError).message).toMatch(/does not hold token/u);
  });

  it("has a composite foreign key as the backstop for the validity trigger", async () => {
    // Written with the trigger disabled to prove the foreign key is not
    // decorative: without it, a deleted or fabricated lease reference would
    // survive any path that bypassed the trigger.
    await context.pool.query(`alter table execution.orders disable trigger orders_valid_fencing_reference`);
    try {
      const error = await captureRejection(async () =>
        context.repositories.orders.insertOrder({
          planId: liveChain.planId,
          executionGroupId: liveChain.executionGroupId,
          marketId: liveChain.marketId,
          tokenId: liveChain.tokenId,
          environment: "LIVE_MICRO",
          accountRef: LIVE_ACCOUNT,
          side: "BUY",
          limitPrice: "0.42",
          originalShares: "1",
          state: "LIVE",
          fencing: { fencingLeaseId: uuidV7(), fencingToken: "1" },
        }),
      );
      expect(error).toBeInstanceOf(ForeignKeyViolationError);
      expect((error as ForeignKeyViolationError).constraintName).toBe("orders_fencing_lease_fk");
    } finally {
      await context.pool.query(`alter table execution.orders enable trigger orders_valid_fencing_reference`);
    }
  });

  it("REJECTS a live order naming the right lease with the wrong token", async () => {
    const lease = await context.repositories.fencing.findActiveLease(LIVE_ACCOUNT, "LIVE_MICRO");

    const error = await captureRejection(async () =>
      context.repositories.orders.insertOrder({
        planId: liveChain.planId,
        executionGroupId: liveChain.executionGroupId,
        marketId: liveChain.marketId,
        tokenId: liveChain.tokenId,
        environment: "LIVE_MICRO",
        accountRef: LIVE_ACCOUNT,
        side: "BUY",
        limitPrice: "0.42",
        originalShares: "1",
        state: "LIVE",
        fencing: { fencingLeaseId: lease?.fencingLeaseId ?? "", fencingToken: "2" },
      }),
    );

    expect(error).toBeInstanceOf(FencingReferenceInvalidError);
    expect((error as FencingReferenceInvalidError).sqlState).toBe("PMB06");
  });

  it("REJECTS a live order fenced by a lease for another environment (ADR-010)", async () => {
    const paperLease = await context.repositories.fencing.acquireLease({
      accountRef: LIVE_ACCOUNT,
      environment: "PAPER",
      holderId: "paper-trader",
      expiresAt: inSeconds(300),
    });

    const error = await captureRejection(async () =>
      context.repositories.orders.insertOrder({
        planId: liveChain.planId,
        executionGroupId: liveChain.executionGroupId,
        marketId: liveChain.marketId,
        tokenId: liveChain.tokenId,
        environment: "LIVE_MICRO",
        accountRef: LIVE_ACCOUNT,
        side: "BUY",
        limitPrice: "0.42",
        originalShares: "1",
        state: "LIVE",
        fencing: {
          fencingLeaseId: paperLease.fencingLeaseId,
          fencingToken: paperLease.fencingToken,
        },
      }),
    );

    expect(error).toBeInstanceOf(FencingReferenceInvalidError);
    expect((error as FencingReferenceInvalidError).message).toMatch(/fences environment PAPER/u);
  });

  it("REJECTS a live order fenced by a released lease", async () => {
    const lease = await context.repositories.fencing.findActiveLease(LIVE_ACCOUNT, "LIVE_MICRO");
    await context.repositories.fencing.releaseLease(
      lease?.fencingLeaseId ?? "",
      "test: holder stepped down",
    );

    const error = await captureRejection(async () =>
      context.repositories.orders.insertOrder({
        planId: liveChain.planId,
        executionGroupId: liveChain.executionGroupId,
        marketId: liveChain.marketId,
        tokenId: liveChain.tokenId,
        environment: "LIVE_MICRO",
        accountRef: LIVE_ACCOUNT,
        side: "BUY",
        limitPrice: "0.42",
        originalShares: "1",
        state: "LIVE",
        fencing: {
          fencingLeaseId: lease?.fencingLeaseId ?? "",
          fencingToken: lease?.fencingToken ?? "",
        },
      }),
    );

    expect(error).toBeInstanceOf(FencingReferenceInvalidError);
    expect((error as FencingReferenceInvalidError).message).toMatch(/is RELEASED, not ACTIVE/u);
  });

  it("REJECTS a live order fenced by an expired lease", async () => {
    // Written directly rather than through the repository: `acquired_at` is
    // immutable and `expires_at > acquired_at` is a CHECK, so a lease cannot be
    // aged after the fact — which is the point. The row below is exactly what a
    // lease looks like once its holder stopped heartbeating.
    const expiredLeaseId = uuidV7();
    await context.pool.query(
      `insert into ops.fencing_leases
         (fencing_lease_id, account_ref, environment, fencing_token, holder_id,
          status, acquired_at, expires_at)
       values ($1, $2, 'LIVE_MICRO', 2, 'trader-d', 'ACTIVE',
               now() - interval '10 minutes', now() - interval '5 minutes')`,
      [expiredLeaseId, LIVE_ACCOUNT],
    );

    const error = await captureRejection(async () =>
      context.repositories.orders.insertOrder({
        planId: liveChain.planId,
        executionGroupId: liveChain.executionGroupId,
        marketId: liveChain.marketId,
        tokenId: liveChain.tokenId,
        environment: "LIVE_MICRO",
        accountRef: LIVE_ACCOUNT,
        side: "BUY",
        limitPrice: "0.42",
        originalShares: "1",
        state: "LIVE",
        fencing: { fencingLeaseId: expiredLeaseId, fencingToken: "2" },
      }),
    );

    expect(error).toBeInstanceOf(FencingReferenceInvalidError);
    expect((error as FencingReferenceInvalidError).message).toMatch(/expired at/u);
  });

  it("allows a failover to take over an EXPIRED lease with a higher token", async () => {
    const lease = await context.repositories.fencing.acquireLease({
      accountRef: LIVE_ACCOUNT,
      environment: "LIVE_MICRO",
      holderId: "trader-e",
      expiresAt: inSeconds(300),
    });

    expect(lease.fencingToken).toBe("3");
    expect(lease.holderId).toBe("trader-e");
  });

  it("persists the fencing token with a live submission attempt (§9.18)", async () => {
    const lease = await context.repositories.fencing.findActiveLease(LIVE_ACCOUNT, "LIVE_MICRO");

    const attemptId = await context.repositories.orders.recordSubmissionAttempt({
      executionGroupId: liveChain.executionGroupId,
      planId: liveChain.planId,
      environment: "LIVE_MICRO",
      accountRef: LIVE_ACCOUNT,
      signedPayload: { salt: "abc", maker: "0x0" },
      salt: "abc",
      expectedOrderHash: "0xexpected",
      fencing: {
        fencingLeaseId: lease?.fencingLeaseId ?? "",
        fencingToken: lease?.fencingToken ?? "",
      },
    });

    const attempt = await context.db
      .selectFrom("execution.submission_attempts")
      .selectAll()
      .where("submission_attempt_id", "=", attemptId)
      .executeTakeFirst();

    expect(attempt?.fencing_token).toBe("3");
    expect(attempt?.state).toBe("SIGNED");
  });

  it("REJECTS a live submission attempt with no fencing reference", async () => {
    const error = await captureRejection(async () =>
      context.repositories.orders.recordSubmissionAttempt({
        executionGroupId: liveChain.executionGroupId,
        planId: liveChain.planId,
        environment: "LIVE_MICRO",
        accountRef: LIVE_ACCOUNT,
        attemptOrdinal: 2,
        signedPayload: { salt: "def" },
        salt: "def",
      }),
    );

    expect(error).toBeInstanceOf(ConstraintViolationError);
    expect((error as ConstraintViolationError).constraintName).toBe(
      "submission_attempts_live_requires_fencing_token",
    );
  });

  it("keeps expected_order_hash unique where known (§10.7)", async () => {
    const lease = await context.repositories.fencing.findActiveLease(LIVE_ACCOUNT, "LIVE_MICRO");

    const error = await captureRejection(async () =>
      context.repositories.orders.recordSubmissionAttempt({
        executionGroupId: liveChain.executionGroupId,
        planId: liveChain.planId,
        environment: "LIVE_MICRO",
        accountRef: LIVE_ACCOUNT,
        attemptOrdinal: 3,
        signedPayload: { salt: "ghi" },
        salt: "ghi",
        expectedOrderHash: "0xexpected",
        fencing: {
          fencingLeaseId: lease?.fencingLeaseId ?? "",
          fencingToken: lease?.fencingToken ?? "",
        },
      }),
    );

    expect(error).toBeInstanceOf(UniqueViolationError);
    expect((error as UniqueViolationError).constraintName).toBe(
      "submission_attempts_expected_order_hash_unique",
    );
  });

  it("allows many attempts whose venue identity is not yet known (§6 invariant 6)", async () => {
    const lease = await context.repositories.fencing.findActiveLease(LIVE_ACCOUNT, "LIVE_MICRO");
    const fencing = {
      fencingLeaseId: lease?.fencingLeaseId ?? "",
      fencingToken: lease?.fencingToken ?? "",
    };

    for (const ordinal of [4, 5]) {
      const attemptId = await context.repositories.orders.recordSubmissionAttempt({
        executionGroupId: liveChain.executionGroupId,
        planId: liveChain.planId,
        environment: "LIVE_MICRO",
        accountRef: LIVE_ACCOUNT,
        attemptOrdinal: ordinal,
        signedPayload: { salt: `salt-${ordinal}` },
        salt: `salt-${ordinal}`,
        fencing,
      });
      expect(attemptId).toMatch(/^[0-9a-f]{8}-/u);
    }
  });

  it("does NOT require a fencing reference in a simulated run mode", async () => {
    const orderId = await context.repositories.orders.insertOrder({
      planId: paperChain.planId,
      executionGroupId: paperChain.executionGroupId,
      marketId: paperChain.marketId,
      tokenId: paperChain.tokenId,
      environment: "PAPER",
      accountRef: "test-account",
      side: "BUY",
      limitPrice: "0.42",
      originalShares: "1",
      state: "LIVE",
    });

    const order = await context.repositories.orders.findOrder(orderId);
    expect(order?.fencing_lease_id).toBeNull();
  });

  it("records the rotating venue heartbeat id on the lease (ADR-008 §4)", async () => {
    const lease = await context.repositories.fencing.findActiveLease(LIVE_ACCOUNT, "LIVE_MICRO");

    const accepted = await context.repositories.fencing.recordHeartbeat({
      fencingLeaseId: lease?.fencingLeaseId ?? "",
      holderId: "trader-e",
      heartbeatId: "hb-2",
      expiresAt: inSeconds(300),
    });
    expect(accepted).toBe(true);

    const refreshed = await context.repositories.fencing.findActiveLease(
      LIVE_ACCOUNT,
      "LIVE_MICRO",
    );
    expect(refreshed?.heartbeatId).toBe("hb-2");
  });

  it("refuses a heartbeat from a process that is not the holder (§6 invariant 16)", async () => {
    const lease = await context.repositories.fencing.findActiveLease(LIVE_ACCOUNT, "LIVE_MICRO");

    const accepted = await context.repositories.fencing.recordHeartbeat({
      fencingLeaseId: lease?.fencingLeaseId ?? "",
      holderId: "trader-impostor",
      heartbeatId: "hb-3",
      expiresAt: inSeconds(300),
    });

    expect(accepted).toBe(false);
  });
});
