/**
 * Value-level integrity at the storage boundary (WP-040 review round 1,
 * MEDIUM-2, MEDIUM-3, MEDIUM-4, LOW-a).
 *
 * Four properties that a schema either has or quietly does not:
 *
 *   * a venue identity deduplicates even when the account is not yet known;
 *   * an identifier the client calls invalid is not storable;
 *   * a controlled vocabulary does not admit an unlabelled element;
 *   * a document that may carry an economic value cannot carry a JavaScript
 *     number.
 */

import type { TestContext } from "@polymarket-bot/storage-postgres/testing";
import {
  createTradingChain,
  fixtureTimestamp,
  hashOf,
} from "@polymarket-bot/storage-postgres/testing";
import { DecimalSafeJsonError, uuidV7 } from "@polymarket-bot/storage-postgres";
import { beforeAll, describe, expect, it } from "vitest";

import { captureRejection, useMigratedDatabase } from "./context.js";

const getContext = useMigratedDatabase("value_integrity");

let context: TestContext;
let chain: Awaited<ReturnType<typeof createTradingChain>>;
/** A chain whose instance, plan, and order genuinely name no account. */
let accountlessChain: Awaited<ReturnType<typeof createTradingChain>>;
let orderId: string;
let accountlessOrderId: string;

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string }).code;
}

beforeAll(async () => {
  context = getContext();
  chain = await createTradingChain(context, { label: "value_integrity" });
  accountlessChain = await createTradingChain(context, {
    label: "value_integrity_accountless",
    accountRef: null,
  });

  orderId = await context.repositories.orders.insertOrder({
    planId: chain.planId,
    executionGroupId: chain.executionGroupId,
    submissionAttemptId: chain.submissionAttemptId,
    marketId: chain.marketId,
    tokenId: chain.tokenId,
    side: "BUY",
    limitPrice: "0.42",
    originalShares: "100",
    state: "LIVE",
  });

  accountlessOrderId = await context.repositories.orders.insertOrder({
    planId: accountlessChain.planId,
    executionGroupId: accountlessChain.executionGroupId,
    submissionAttemptId: accountlessChain.submissionAttemptId,
    marketId: accountlessChain.marketId,
    tokenId: accountlessChain.tokenId,
    side: "BUY",
    limitPrice: "0.42",
    originalShares: "100",
    state: "LIVE",
  });
});

describe("MEDIUM-2: venue identity deduplicates with an unknown account", () => {
  async function insertOrderWithVenueId(venueOrderId: string): Promise<unknown> {
    return context.pool.query(
      `insert into execution.orders
         (order_id, submission_attempt_id, plan_id, market_id, token_id, environment,
          account_ref, side, limit_price, original_shares, state, venue_order_id)
       values ($1, $2, $3, $4, $5, 'PAPER', null, 'BUY', '0.42', '1', 'LIVE', $6)`,
      [
        uuidV7(),
        chain.submissionAttemptId,
        chain.planId,
        chain.marketId,
        chain.tokenId,
        venueOrderId,
      ],
    );
  }

  it("REJECTS a second NULL-account order with the same venue order id", async () => {
    await insertOrderWithVenueId("venue-order-null-account");

    const error = await captureRejection(async () =>
      insertOrderWithVenueId("venue-order-null-account"),
    );

    expect(errorCode(error)).toBe("23505");
    expect((error as { constraint?: string }).constraint).toBe("orders_venue_order_id_unique");
  });

  /**
   * Records a fill directly, with whatever account the caller names.
   *
   * The repository reads the account from the order, so a NULL has to be
   * written by hand — which is the point: the constraint has to hold for the
   * writer that does not go through this package.
   */
  async function insertFillWithoutAccount(
    targetOrderId: string,
    marketId: string,
    tokenId: string,
    venueTradeId: string,
  ): Promise<string> {
    const fillId = uuidV7();
    const client = await context.pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `insert into execution.fills
           (fill_id, order_id, market_id, token_id, environment, account_ref,
            venue_trade_id, venue_order_id, side, shares, price, notional,
            liquidity_role, matched_at)
         values ($1, $2, $3, $4, 'PAPER', null, $5, 'venue-order-1', 'BUY', '1', '0.42',
                 '0.42', 'TAKER', now())`,
        [fillId, targetOrderId, marketId, tokenId, venueTradeId],
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

  it("REJECTS a NULL-account fill of an order that HAS an account", async () => {
    // CORRECTED EXPECTATION (round-2 HIGH-3). This test previously asserted that
    // such a fill is *accepted* — it was written to demonstrate that the venue
    // identity still deduplicates when the account is NULL, and in doing so it
    // encoded the defect: `fills_order_account_fk` was MATCH SIMPLE, so a NULL
    // child account skipped the binding to the order's account entirely, and the
    // fill left account-scoped exposure and reconciliation while remaining a fill
    // of that order. The deduplication property it was really about is asserted
    // below, on an order that genuinely has no account.
    const error = await captureRejection(async () =>
      insertFillWithoutAccount(
        orderId,
        chain.marketId,
        chain.tokenId,
        "venue-trade-null-account",
      ),
    );

    expect(errorCode(error)).toBe("23503");
    expect((error as { constraint?: string }).constraint).toBe("fills_order_account_fk");
  });

  it("REJECTS a second NULL-account fill with the same venue identity", async () => {
    // The accountless chain: the instance, the plan, and the order name no
    // account, so neither does the fill — and two of them with one venue
    // identity must still be one fill, which is what NULLS NOT DISTINCT buys.
    await insertFillWithoutAccount(
      accountlessOrderId,
      accountlessChain.marketId,
      accountlessChain.tokenId,
      "venue-trade-null-account",
    );

    const error = await captureRejection(async () =>
      insertFillWithoutAccount(
        accountlessOrderId,
        accountlessChain.marketId,
        accountlessChain.tokenId,
        "venue-trade-null-account",
      ),
    );

    expect(errorCode(error)).toBe("23505");
    expect((error as { constraint?: string }).constraint).toBe("fills_venue_identity_unique");
  });
});

describe("MEDIUM-3: the uuid_v7 domain checks both RFC 9562 nibbles", () => {
  it("REJECTS a UUID whose variant nibble is not 8, 9, a, or b", async () => {
    const error = await captureRejection(async () =>
      context.pool.query(`select '00000000-0000-7000-0000-000000000000'::internal.uuid_v7`),
    );

    expect(errorCode(error)).toBe("23514");
    expect((error as { constraint?: string }).constraint).toBe("uuid_v7_variant");
  });

  it("REJECTS a non-v7 version nibble, as before", async () => {
    const error = await captureRejection(async () =>
      context.pool.query(`select '00000000-0000-4000-8000-000000000000'::internal.uuid_v7`),
    );

    expect((error as { constraint?: string }).constraint).toBe("uuid_v7_version");
  });

  it("accepts what the client generator produces", async () => {
    const accepted = await context.pool.query<{ value: string }>(
      `select $1::internal.uuid_v7::text as value`,
      [uuidV7()],
    );
    expect(accepted.rows[0]?.value).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
  });
});

describe("LOW-a: a controlled-vocabulary array admits no NULL element", () => {
  it("REJECTS a NULL reason code", async () => {
    const error = await captureRejection(async () =>
      context.pool.query(
        `insert into strategy.decisions
           (decision_id, run_id, instance_id, market_id, evaluation_seq, callback,
            decision_type, decision_contract_version, reason_codes,
            feature_snapshot_ref, intent_count, evaluated_at)
         values ($1, $2, $3, $4, 9001, 'onFeatures', 'hold', 1,
                 array['ok', null]::text[], 'snap', 0, now())`,
        [uuidV7(), chain.runId, chain.instanceId, chain.marketId],
      ),
    );

    expect(errorCode(error)).toBe("23514");
    expect((error as { message: string }).message).toMatch(/must not contain a NULL element/u);
  });

  it("still accepts a well-formed vocabulary array", async () => {
    const inserted = await context.pool.query(
      `insert into strategy.decisions
         (decision_id, run_id, instance_id, market_id, evaluation_seq, callback,
          decision_type, decision_contract_version, reason_codes,
          feature_snapshot_ref, intent_count, evaluated_at)
       values ($1, $2, $3, $4, 9002, 'onFeatures', 'hold', 1,
               array['spread_too_wide', 'no_edge']::text[], 'snap', 0, now())`,
      [uuidV7(), chain.runId, chain.instanceId, chain.marketId],
    );
    expect(inserted.rowCount).toBe(1);
  });
});

describe("MEDIUM-4: economics-bearing JSON admits no number", () => {
  it("REJECTS a number in a signed payload", async () => {
    const error = await captureRejection(async () =>
      context.repositories.orders.recordSubmissionAttempt({
        executionGroupId: chain.executionGroupId,
        planId: chain.planId,
        attemptOrdinal: 90,
        signedPayload: { price: 0.42 } as never,
        salt: "number-salt",
      }),
    );

    expect(error).toBeInstanceOf(DecimalSafeJsonError);
    expect(errorCode(error)).toBe("ECONOMIC_JSON_NUMBER");
    expect((error as DecimalSafeJsonError).path).toBe(".price");
  });

  it("REJECTS a number nested inside a signed payload", async () => {
    const error = await captureRejection(async () =>
      context.repositories.orders.recordSubmissionAttempt({
        executionGroupId: chain.executionGroupId,
        planId: chain.planId,
        attemptOrdinal: 91,
        signedPayload: { order: { maker: "0x0", legs: [{ size: 10 }] } } as never,
        salt: "nested-salt",
      }),
    );

    expect(errorCode(error)).toBe("ECONOMIC_JSON_NUMBER");
    expect((error as DecimalSafeJsonError).path).toBe(".order.legs[0].size");
  });

  it("REJECTS a number smuggled in as pre-serialized JSON", async () => {
    const error = await captureRejection(async () =>
      context.repositories.orders.recordSubmissionAttempt({
        executionGroupId: chain.executionGroupId,
        planId: chain.planId,
        attemptOrdinal: 92,
        signedPayload: JSON.stringify({ price: 0.42 }),
        salt: "serialized-salt",
      }),
    );

    expect(errorCode(error)).toBe("ECONOMIC_JSON_NUMBER");
  });

  it("REJECTS a number in an order-event payload", async () => {
    const error = await captureRejection(async () =>
      context.repositories.orders.appendOrderEvent({
        orderId,
        eventType: "venue_update",
        newState: "PARTIALLY_FILLED",
        source: "polymarket",
        occurredAt: fixtureTimestamp(),
        payload: { filled: 1.5 } as never,
      }),
    );

    expect(errorCode(error)).toBe("ECONOMIC_JSON_NUMBER");
  });

  it("REJECTS a number in strategy parameters", async () => {
    const error = await captureRejection(async () =>
      context.repositories.strategy.createConfig({
        definitionId: chain.definitionId,
        parameters: { entryOffsetTicks: 2 } as never,
        parametersHash: hashOf("numeric-config"),
        validatedAt: fixtureTimestamp(),
        createdBy: "value-integrity-test",
      }),
    );

    expect(errorCode(error)).toBe("ECONOMIC_JSON_NUMBER");
  });

  it("accepts the same values as canonical decimal strings", async () => {
    const attemptId = await context.repositories.orders.recordSubmissionAttempt({
      executionGroupId: chain.executionGroupId,
      planId: chain.planId,
      attemptOrdinal: 93,
      signedPayload: { price: "0.42", size: "10", legs: [{ size: "10" }], negRisk: false },
      salt: "decimal-salt",
    });

    const stored = await context.db
      .selectFrom("execution.submission_attempts")
      .select(["signed_payload"])
      .where("submission_attempt_id", "=", attemptId)
      .executeTakeFirst();

    expect(stored?.signed_payload).toEqual({
      price: "0.42",
      size: "10",
      legs: [{ size: "10" }],
      negRisk: false,
    });
  });

  it("REJECTS a number in a decision's model outputs (round-2 correction)", async () => {
    // `model_outputs` used to be on the documented allowlist as "model scores,
    // not money". The frozen contract disagrees: §7.5 and ADR-005 type a model
    // output as `DecimalString | string | boolean | null`, and an edge or a
    // probability is what sizing and the risk thresholds are computed from — a
    // double there is a rounding error with an order attached.
    const error = await captureRejection(async () =>
      context.pool.query(
        `insert into strategy.decisions
           (decision_id, run_id, instance_id, market_id, evaluation_seq, callback,
            decision_type, decision_contract_version, reason_codes, feature_snapshot_ref,
            model_outputs, intent_count, evaluated_at)
         values ($1, $2, $3, $4, 9101, 'onFeatures', 'enter', 1,
                 array['edge']::text[], 'snap', $5::jsonb, 0, now())`,
        [
          uuidV7(),
          chain.runId,
          chain.instanceId,
          chain.marketId,
          JSON.stringify({ edge: 0.012, probability: 0.5 }),
        ],
      ),
    );

    expect(errorCode(error)).toBe("23514");
    expect((error as { constraint?: string }).constraint).toBe(
      "decisions_model_outputs_decimal_safe",
    );
  });

  it("REJECTS a number nested deep inside model outputs", async () => {
    const error = await captureRejection(async () =>
      context.pool.query(
        `insert into strategy.decisions
           (decision_id, run_id, instance_id, market_id, evaluation_seq, callback,
            decision_type, decision_contract_version, reason_codes, feature_snapshot_ref,
            model_outputs, intent_count, evaluated_at)
         values ($1, $2, $3, $4, 9102, 'onFeatures', 'enter', 1,
                 array['edge']::text[], 'snap', $5::jsonb, 0, now())`,
        [
          uuidV7(),
          chain.runId,
          chain.instanceId,
          chain.marketId,
          JSON.stringify({ features: { ladder: [{ fair: 0.51 }] } }),
        ],
      ),
    );

    expect(errorCode(error)).toBe("23514");
  });

  it("accepts model outputs written as canonical decimal strings", async () => {
    const inserted = await context.pool.query(
      `insert into strategy.decisions
         (decision_id, run_id, instance_id, market_id, evaluation_seq, callback,
          decision_type, decision_contract_version, reason_codes, feature_snapshot_ref,
          model_outputs, intent_count, evaluated_at)
       values ($1, $2, $3, $4, 9103, 'onFeatures', 'enter', 1,
               array['edge']::text[], 'snap', $5::jsonb, 0, now())`,
      [
        uuidV7(),
        chain.runId,
        chain.instanceId,
        chain.marketId,
        JSON.stringify({ edge: "0.012", stale: false, note: null }),
      ],
    );

    expect(inserted.rowCount).toBe(1);
  });

  it("still allows numbers where they are schema keywords, not economics", async () => {
    // `params_schema` is a JSON Schema: `maximum` is a keyword, and the
    // parameters it validates are guarded separately. Documented allowlist.
    const definitionId = await context.repositories.strategy.createDefinition({
      strategyName: "schema-with-numbers",
      codeVersion: "0.1.0",
      paramsSchema: { type: "object", properties: { ticks: { type: "string", maxLength: 8 } } },
      stateSchemaVersion: 1,
      decisionContractVersion: 1,
    });

    expect(definitionId).toMatch(/^[0-9a-f]{8}-/u);
  });
});
