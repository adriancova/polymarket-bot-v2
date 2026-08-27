/**
 * Bypass reproductions for the WP-040 review **round 3** findings.
 *
 * Two residuals, both of the same shape as their round: a constraint that is
 * correct about the value it checks, and silent about the value being absent.
 *
 *   * **F10 residual (HIGH).** Round 2 bound a ledger transaction's
 *     `environment`, `account_ref`, and `market_id` to the order and fill it
 *     books. `market_id` is itself nullable and the keys are MATCH SIMPLE, so a
 *     transaction that books a LIVE order or fill with a truthful environment
 *     and account could simply *omit* the market: the market binding skipped,
 *     the row committed, and the money left every market-scoped ledger query
 *     while remaining append-only and permanent.
 *   * **SIGNED without its attempt (MEDIUM).** Round 2 exempted `SIGNED` from
 *     `orders_submission_requires_attempt`, on the reading that it "precedes the
 *     attempt". §9.11's idempotent submission protocol says the opposite: the
 *     attempt id is created at step 1, the order is signed at step 2, the signed
 *     payload is persisted at step 3, and only then is `SIGNED` committed at
 *     step 4. The durable signed payload lives in `submission_attempts`, so an
 *     attemptless `SIGNED` order claims a signature with nothing on record —
 *     which is precisely what §6 invariant 6 reconciles a lost response against.
 *
 * Both sequences were **reproduced first** against the reviewed schema
 * (`8be5e5c`), where both were accepted, and both are written here as the
 * attacker's plain SQL through `context.pool`: an invariant a second connection
 * can step around is not a database invariant.
 */

import type { TestContext } from "@polymarket-bot/storage-postgres/testing";
import { createTradingChain, fixtureTimestamp } from "@polymarket-bot/storage-postgres/testing";
import type { PostLedgerTransactionInput } from "@polymarket-bot/storage-postgres";
import { ConstraintViolationError, uuidV7 } from "@polymarket-bot/storage-postgres";
import { beforeAll, describe, expect, it } from "vitest";

import { captureRejection, useMigratedDatabase } from "./context.js";

const getContext = useMigratedDatabase("authority_bypass_round3");

const LIVE_ACCOUNT = "round3-live-account";

let context: TestContext;
let paperChain: Awaited<ReturnType<typeof createTradingChain>>;
let otherChain: Awaited<ReturnType<typeof createTradingChain>>;
let liveChain: Awaited<ReturnType<typeof createTradingChain>>;
let liveOrderId: string;
let liveFillId: string;

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
    label: "round3_paper",
    environment: "PAPER",
    accountRef: "round3-paper-account",
  });
  // A second market, so "the wrong market" can be a market that exists.
  otherChain = await createTradingChain(context, {
    label: "round3_other",
    environment: "PAPER",
    accountRef: "round3-paper-account",
  });
  liveChain = await createTradingChain(context, {
    label: "round3_live",
    environment: "LIVE",
    accountRef: LIVE_ACCOUNT,
  });

  const lease = await context.repositories.fencing.acquireLease({
    accountRef: LIVE_ACCOUNT,
    environment: "LIVE",
    holderId: "round3-live-holder",
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
    salt: "round3-live-salt",
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
    venueTradeId: "round3-live-trade",
    venueOrderId: "round3-live-venue-order",
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
});

describe("round-3 F10 residual: an execution-linked ledger transaction cannot omit its market", () => {
  async function postHeader(values: {
    readonly orderId?: string | null;
    readonly fillId?: string | null;
    readonly marketId?: string | null;
  }): Promise<unknown> {
    return context.pool.query(
      `insert into accounting.ledger_transactions
         (ledger_transaction_id, event_type, environment, account_ref, market_id, order_id,
          fill_id, source, occurred_at)
       values ($1, 'TRADE_PRINCIPAL', 'LIVE', $2, $3, $4, $5, 'internal', now())`,
      [
        uuidV7(),
        LIVE_ACCOUNT,
        values.marketId ?? null,
        values.orderId ?? null,
        values.fillId ?? null,
      ],
    );
  }

  it("REJECTS an order-linked transaction whose market_id is NULL", async () => {
    // The bypass, exactly: environment LIVE, the order's own account, the real
    // order id — and no market. `ledger_transactions_order_market_fk` is MATCH
    // SIMPLE, so a NULL on either side skips it silently, and round 2's binding
    // never fires.
    const error = await captureRejection(async () => postHeader({ orderId: liveOrderId }));

    expect(errorCode(error)).toBe("23514");
    expect(constraintOf(error)).toBe("ledger_transactions_execution_link_has_market");
  });

  it("REJECTS a fill-linked transaction whose market_id is NULL", async () => {
    const error = await captureRejection(async () => postHeader({ fillId: liveFillId }));

    expect(errorCode(error)).toBe("23514");
    expect(constraintOf(error)).toBe("ledger_transactions_execution_link_has_market");
  });

  it("REJECTS an order- and fill-linked transaction whose market_id is NULL", async () => {
    const error = await captureRejection(async () =>
      postHeader({ orderId: liveOrderId, fillId: liveFillId }),
    );

    expect(errorCode(error)).toBe("23514");
    expect(constraintOf(error)).toBe("ledger_transactions_execution_link_has_market");
  });

  it("REJECTS a NULL-market transaction posted through the repository as well", async () => {
    // The type forbids this shape, so the runtime path is reached by casting —
    // which is the point: a caller that defeats the compile-time requirement
    // still meets the database one. Both layers exist; neither is decorative.
    const bypass = {
      eventType: "TRADE_PRINCIPAL",
      environment: "LIVE",
      accountRef: LIVE_ACCOUNT,
      orderId: liveOrderId,
      marketId: null,
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
    } as unknown as PostLedgerTransactionInput;

    const error = await captureRejection(async () =>
      context.repositories.ledger.postTransaction(bypass),
    );

    // The repository maps the SQLSTATE to a typed error, so callers branch on a
    // type rather than a message (§21). The SQLSTATE and the constraint name are
    // still carried, and they are the contract.
    expect(error).toBeInstanceOf(ConstraintViolationError);
    expect((error as ConstraintViolationError).sqlState).toBe("23514");
    expect((error as ConstraintViolationError).constraintName).toBe(
      "ledger_transactions_execution_link_has_market",
    );
  });

  it("REJECTS a market that is not the order's, as it did before (the binding still binds)", async () => {
    const error = await captureRejection(async () =>
      postHeader({ orderId: liveOrderId, marketId: otherChain.marketId }),
    );

    expect(errorCode(error)).toBe("23503");
    expect(constraintOf(error)).toBe("ledger_transactions_order_market_fk");
  });

  it("REJECTS a market that is not the fill's either", async () => {
    const error = await captureRejection(async () =>
      postHeader({ fillId: liveFillId, marketId: otherChain.marketId }),
    );

    expect(errorCode(error)).toBe("23503");
    expect(constraintOf(error)).toBe("ledger_transactions_fill_market_fk");
  });

  it("still accepts a truthful execution-linked transaction, and it is market-scoped visible", async () => {
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

    // The consequence the finding was actually about: the transaction is
    // reachable from the market it books. On the reviewed schema the NULL-market
    // rows committed and this count stayed at zero.
    const scoped = await context.pool.query<{ count: string }>(
      `select count(*)::text as count from accounting.ledger_transactions
        where market_id = $1`,
      [liveChain.marketId],
    );
    expect(scoped.rows[0]?.count).toBe("1");

    const stored = await context.repositories.ledger.findTransaction(id);
    expect(stored?.transaction.market_id).toBe(liveChain.marketId);
  });

  it("still accepts a standalone transaction with no order, no fill, and no market", async () => {
    // §9.15: external clearing, deposits, manual adjustments, and resolutions
    // genuinely have no market. The CHECK is scoped to rows that book an
    // execution fact, so it does not fire here.
    const id = await context.repositories.ledger.postTransaction({
      eventType: "MANUAL_ADJUSTMENT",
      environment: "PAPER",
      accountRef: "round3-standalone-account",
      source: "internal",
      occurredAt: fixtureTimestamp(),
      entries: [
        {
          scope: "ACTUAL_ACCOUNT",
          accountRef: "round3-standalone-account",
          assetId: "pUSD",
          assetKind: "COLLATERAL",
          amount: "5",
        },
        {
          scope: "EXTERNAL_CLEARING",
          accountRef: "round3-standalone-account",
          assetId: "pUSD",
          assetKind: "COLLATERAL",
          amount: "-5",
        },
      ],
    });

    const stored = await context.repositories.ledger.findTransaction(id);
    expect(stored?.transaction.market_id).toBeNull();
    expect(stored?.transaction.order_id).toBeNull();
    expect(stored?.entries).toHaveLength(2);
  });

  it("still accepts a standalone transaction that names a market without an execution fact", async () => {
    // A market resolution is about a market and books no order or fill.
    const id = await context.repositories.ledger.postTransaction({
      eventType: "RESOLUTION",
      environment: "PAPER",
      accountRef: "round3-standalone-account",
      marketId: paperChain.marketId,
      source: "internal",
      occurredAt: fixtureTimestamp(),
      entries: [
        {
          scope: "ACTUAL_ACCOUNT",
          accountRef: "round3-standalone-account",
          assetId: "pUSD",
          assetKind: "COLLATERAL",
          amount: "10",
        },
        {
          scope: "EXTERNAL_CLEARING",
          accountRef: "round3-standalone-account",
          assetId: "pUSD",
          assetKind: "COLLATERAL",
          amount: "-10",
        },
      ],
    });

    const stored = await context.repositories.ledger.findTransaction(id);
    expect(stored?.transaction.market_id).toBe(paperChain.marketId);
  });
});

/**
 * The compile-time half of the same rule.
 *
 * The database rejects a NULL-market execution-linked transaction for every
 * writer; the input type makes it unstateable from this package. Each
 * `@ts-expect-error` below is a real assertion: TypeScript reports an *unused*
 * `@ts-expect-error`, so if the type is ever loosened back, `pnpm typecheck`
 * fails on these lines rather than the schema quietly carrying the whole burden.
 *
 * Declared, never called — this is a type-level test, not a runtime one.
 */
function ledgerInputTypeRules(id: string): void {
  const common = {
    eventType: "TRADE_PRINCIPAL",
    environment: "LIVE",
    accountRef: LIVE_ACCOUNT,
    source: "internal",
    occurredAt: fixtureTimestamp(),
    entries: [],
  } as const;

  // @ts-expect-error — an order-linked transaction must name the market.
  const orderWithoutMarket: PostLedgerTransactionInput = { ...common, orderId: id };
  // @ts-expect-error — a fill-linked transaction must name the market too.
  const fillWithoutMarket: PostLedgerTransactionInput = { ...common, fillId: id };
  // @ts-expect-error — and an explicit NULL market is not a way around it.
  const orderWithNullMarket: PostLedgerTransactionInput = {
    ...common,
    orderId: id,
    marketId: null,
  };

  // Still expressible, and still checked: linked *with* the market, and
  // standalone with no market at all.
  const linked: PostLedgerTransactionInput = { ...common, orderId: id, marketId: id };
  const standalone: PostLedgerTransactionInput = { ...common };

  void orderWithoutMarket;
  void fillWithoutMarket;
  void orderWithNullMarket;
  void linked;
  void standalone;
}

void ledgerInputTypeRules;

describe("round-3 MEDIUM: a SIGNED order carries the attempt that signed it (§9.11 steps 1-4)", () => {
  async function insertOrderInState(
    state: string,
    extra: { readonly submissionAttemptId?: string | null } = {},
  ): Promise<unknown> {
    return context.pool.query(
      `insert into execution.orders
         (order_id, submission_attempt_id, plan_id, execution_group_id, market_id, token_id,
          environment, account_ref, side, limit_price, original_shares, state)
       values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::text,
               (select p.environment from execution.plans as p where p.plan_id = $3::uuid),
               (select p.account_ref from execution.plans as p where p.plan_id = $3::uuid),
               'BUY', '0.42', '10', $7::internal.order_state)`,
      [
        uuidV7(),
        extra.submissionAttemptId ?? null,
        paperChain.planId,
        paperChain.executionGroupId,
        paperChain.marketId,
        paperChain.tokenId,
        state,
      ],
    );
  }

  it("REJECTS a SIGNED order with no submission attempt", async () => {
    // §9.11 step 1 creates the attempt id, step 2 signs, step 3 persists the
    // signed payload into `submission_attempts`, and step 4 commits `SIGNED`.
    // The attempt therefore exists before the state does. Round 2 read `SIGNED`
    // as preceding the attempt and exempted it; the protocol says the reverse.
    const error = await captureRejection(async () => insertOrderInState("SIGNED"));

    expect(errorCode(error)).toBe("23514");
    expect(constraintOf(error)).toBe("orders_submission_requires_attempt");
  });

  it("accepts a SIGNED order that names the attempt that signed it", async () => {
    const inserted = await insertOrderInState("SIGNED", {
      submissionAttemptId: paperChain.submissionAttemptId,
    });

    expect((inserted as { rowCount: number }).rowCount).toBe(1);
  });

  it("still exempts PLANNED and the pre-transmission terminal states", async () => {
    // `PLANNED` is the state before step 1, and the three terminal states are
    // reachable by abandoning an order before transmission. The evidence
    // conditions (no venue id, no venue hash, no submitted_at, no fills) are
    // what keep the exemption about not having been submitted rather than about
    // the state label; round 2's tests cover those and still pass.
    for (const state of ["PLANNED", "CANCELED", "REJECTED", "EXPIRED"]) {
      const inserted = await insertOrderInState(state);
      expect((inserted as { rowCount: number }).rowCount, state).toBe(1);
    }
  });

  it("REJECTS moving an existing PLANNED order to SIGNED without attaching an attempt", async () => {
    // The CHECK is on the row, not on the INSERT, so the update path is closed
    // by the same constraint — an order cannot be signed into existence *or*
    // signed after the fact without its attempt.
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

    const error = await captureRejection(async () =>
      context.pool.query(`update execution.orders set state = 'SIGNED' where order_id = $1`, [
        plannedOrderId,
      ]),
    );

    expect(errorCode(error)).toBe("23514");
    expect(constraintOf(error)).toBe("orders_submission_requires_attempt");

    // …and the same update *with* the attempt is accepted, so the constraint
    // asks for lineage rather than forbidding the transition.
    const attempt = await context.repositories.orders.recordSubmissionAttempt({
      executionGroupId: paperChain.executionGroupId,
      planId: paperChain.planId,
      attemptOrdinal: 30,
      signedPayload: { price: "0.42", size: "10" },
      salt: "round3-planned-then-signed",
    });
    const updated = await context.pool.query(
      `update execution.orders set state = 'SIGNED', submission_attempt_id = $2
        where order_id = $1`,
      [plannedOrderId, attempt],
    );
    expect((updated as { rowCount: number }).rowCount).toBe(1);
  });
});
