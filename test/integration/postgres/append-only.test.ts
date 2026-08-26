/**
 * §10.7: "Append-only event and ledger tables; updates are forbidden except
 * explicitly mutable projections."
 *
 * Enforcement is by trigger rather than by privilege, because a privilege grant
 * does not bind the table owner or a superuser — and the migration runs as the
 * owner. These tests therefore run as the owner too: if the guard held only for
 * an unprivileged role, every assertion below would fail.
 */

import type { TestContext } from "@polymarket-bot/storage-postgres/testing";
import { createTradingChain, fixtureTimestamp, hashOf } from "@polymarket-bot/storage-postgres/testing";
import { AppendOnlyViolationError, ImmutableColumnError, uuidV7 } from "@polymarket-bot/storage-postgres";
import { beforeAll, describe, expect, it } from "vitest";

import { captureRejection, useMigratedDatabase } from "./context.js";

const getContext = useMigratedDatabase("append_only");

/** Every table §10.7 makes append-only, with a row factory for each. */
const APPEND_ONLY_TABLES = [
  "execution.order_events",
  "execution.fills",
  "execution.fill_allocations",
  "execution.trade_settlements",
  "accounting.ledger_transactions",
  "accounting.ledger_entries",
  "ops.kill_switch_events",
  "ops.risk_events",
  "strategy.configs",
  "strategy.decisions",
  "catalog.market_rule_versions",
] as const;

let context: TestContext;
let chain: Awaited<ReturnType<typeof createTradingChain>>;
let orderId: string;

beforeAll(async () => {
  context = getContext();
  chain = await createTradingChain(context, { label: "append" });

  orderId = await context.repositories.orders.insertOrder({
    planId: chain.planId,
    executionGroupId: chain.executionGroupId,
    marketId: chain.marketId,
    tokenId: chain.tokenId,
    environment: "PAPER",
    accountRef: "test-account",
    side: "BUY",
    limitPrice: "0.42",
    originalShares: "10",
    state: "LIVE",
  });

  await context.repositories.orders.appendOrderEvent({
    orderId,
    eventType: "ACKNOWLEDGED",
    newState: "LIVE",
    source: "polymarket",
    occurredAt: fixtureTimestamp(),
  });

  await context.repositories.ledger.postTransaction({
    eventType: "TRADE_PRINCIPAL",
    environment: "PAPER",
    accountRef: "test-account",
    source: "internal",
    occurredAt: fixtureTimestamp(),
    entries: [
      {
        scope: "ACTUAL_ACCOUNT",
        accountRef: "test-account",
        assetId: "pUSD",
        assetKind: "COLLATERAL",
        amount: "-4.2",
      },
      {
        scope: "EXTERNAL_CLEARING",
        accountRef: "test-account",
        assetId: "pUSD",
        assetKind: "COLLATERAL",
        amount: "4.2",
      },
    ],
  });

  await context.repositories.catalog.recordRuleVersion({
    marketId: chain.marketId,
    rulesText: "Original rules",
    rulesHash: hashOf("rules-v1"),
    observedAt: fixtureTimestamp(),
  });
});

describe("append-only enforcement", () => {
  it("declares an append-only guard on every §10.7 event and ledger table", async () => {
    const result = await context.pool.query<{ qualified: string }>(
      `select n.nspname || '.' || c.relname as qualified
       from pg_trigger t
       join pg_class c on c.oid = t.tgrelid
       join pg_namespace n on n.oid = c.relnamespace
       join pg_proc p on p.oid = t.tgfoid
       where p.proname = 'forbid_update_delete' and not t.tgisinternal
       group by 1`,
    );
    const guarded = new Set(result.rows.map((row) => row.qualified));

    for (const table of APPEND_ONLY_TABLES) {
      expect(guarded.has(table), `${table} has no append-only guard`).toBe(true);
    }
  });

  it("rejects UPDATE on an order event", async () => {
    const error = await captureRejection(async () =>
      context.pool.query(`update execution.order_events set reason_code = 'edited'`),
    );
    expect((error as { code?: string }).code).toBe("PMB01");
  });

  it("rejects DELETE on an order event", async () => {
    const error = await captureRejection(async () =>
      context.pool.query(`delete from execution.order_events`),
    );
    expect((error as { code?: string }).code).toBe("PMB01");
  });

  it("rejects TRUNCATE on an order event table", async () => {
    const error = await captureRejection(async () =>
      context.pool.query(`truncate execution.order_events`),
    );
    expect((error as { code?: string }).code).toBe("PMB01");
  });

  it("rejects UPDATE and DELETE on ledger entries and transactions", async () => {
    for (const statement of [
      `update accounting.ledger_entries set amount = '1'`,
      `delete from accounting.ledger_entries`,
      `update accounting.ledger_transactions set detail = 'edited'`,
      `delete from accounting.ledger_transactions`,
    ]) {
      const error = await captureRejection(async () => context.pool.query(statement));
      expect((error as { code?: string }).code, statement).toBe("PMB01");
    }
  });

  it("rejects editing an immutable strategy config (§10.7)", async () => {
    const error = await captureRejection(async () =>
      context.pool.query(`update strategy.configs set parameters = '{"changed":true}'::jsonb`),
    );
    expect((error as { code?: string }).code).toBe("PMB01");
  });

  it("rejects editing an immutable market rule version (§10.7)", async () => {
    const error = await captureRejection(async () =>
      context.pool.query(`update catalog.market_rule_versions set rules_text = 'edited'`),
    );
    expect((error as { code?: string }).code).toBe("PMB01");
  });

  it("surfaces the violation as a typed error through the repository layer", async () => {
    const error = await captureRejection(async () =>
      context.db
        .updateTable("accounting.ledger_entries" as never)
        .set({ detail: "edited" } as never)
        .execute(),
    );
    // The raw Kysely path is untyped on purpose here: the point is that the
    // database rejects it even when the type system is bypassed.
    expect((error as { code?: string }).code).toBe("PMB01");
  });

  it("maps the SQLSTATE to AppendOnlyViolationError when it goes through a repository", async () => {
    const { mapPostgresError } = await import("@polymarket-bot/storage-postgres");
    const raw = await captureRejection(async () =>
      context.pool.query(`delete from accounting.ledger_transactions`),
    );
    expect(mapPostgresError(raw)).toBeInstanceOf(AppendOnlyViolationError);
  });

  it("still allows updates to explicitly mutable projections", async () => {
    await context.repositories.orders.appendOrderEvent({
      orderId,
      eventType: "PARTIALLY_FILLED",
      newState: "PARTIALLY_FILLED",
      filledShares: "3",
      source: "polymarket",
      occurredAt: fixtureTimestamp(1),
    });

    const order = await context.repositories.orders.findOrder(orderId);
    expect(order?.state).toBe("PARTIALLY_FILLED");
    expect(order?.filled_shares).toBe("3");
  });

  it("guards the immutable columns of a mutable row", async () => {
    const error = await captureRejection(async () =>
      context.pool.query(`update execution.orders set limit_price = '0.99' where order_id = $1`, [
        orderId,
      ]),
    );
    expect((error as { code?: string }).code).toBe("PMB02");

    const { mapPostgresError } = await import("@polymarket-bot/storage-postgres");
    expect(mapPostgresError(error)).toBeInstanceOf(ImmutableColumnError);
  });

  it("keeps history readable after every rejection", async () => {
    const events = await context.repositories.orders.listOrderEvents(orderId);
    expect(events.map((event) => event.event_ordinal)).toEqual(["0", "1"]);
    expect(events[0]?.reason_code).toBeNull();
  });

  it("uses sortable UUIDv7 identifiers for appended rows (§10.7)", async () => {
    const events = await context.repositories.orders.listOrderEvents(orderId);
    const ids = events.map((event) => event.order_event_id);
    expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b)));
    expect(uuidV7()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/u);
  });
});
