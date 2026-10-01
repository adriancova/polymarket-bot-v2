/**
 * The window classifier's read-only PostgreSQL adapter, against a real
 * PostgreSQL migrated with the `WP-040` migrations (`STORAGE-1`).
 *
 * The only file in this suite that starts a container (Testcontainers, a
 * throwaway PostgreSQL; no real credential). It pins the column bindings the
 * compiler cannot: that the adapter's queries run against the real tables and
 * read the trader's durable frontier and evidence rows back.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createIsolatedDatabase,
  createMigratedContext,
  createTradingChain,
  fixtureTimestamp,
  startPostgresContainer,
} from "@polymarket-bot/storage-postgres/testing";
import type { TestContext, TradingChain } from "@polymarket-bot/storage-postgres/testing";
import { postgresTraderEvidence } from "@polymarket-bot/research-worker";
import type { MarketWindow } from "@polymarket-bot/research-worker";

type Started = Awaited<ReturnType<typeof startPostgresContainer>>;

let container: Started;
let context: TestContext;
let first: TradingChain;
let second: TradingChain;

beforeAll(async () => {
  container = await startPostgresContainer();
  const { connectionString } = await createIsolatedDatabase(container.getConnectionUri(), "storage1");
  context = await createMigratedContext(connectionString);
  first = await createTradingChain(context, { label: "first" });
  second = await createTradingChain(context, { label: "second" });
}, 180_000);

afterAll(async () => {
  await context?.close();
  await container?.stop();
}, 120_000);

function windowFor(chain: TradingChain): MarketWindow {
  return {
    windowId: "w",
    marketId: chain.marketId,
    conditionId: "condition",
    tokenIds: [chain.tokenId],
    windowStartMs: Date.parse(fixtureTimestamp(-600)),
    windowEndMs: Date.parse(fixtureTimestamp(600)),
    responsibleFromMs: Date.parse(fixtureTimestamp(-600)),
    responsibility: { kind: "trader", instanceIds: [chain.instanceId] },
  };
}

describe("postgresTraderEvidence (read-only)", () => {
  it("reads each instance's durable frontier, and the minimum across instances", async () => {
    const evidence = postgresTraderEvidence(context.db, { environment: "PAPER" });
    const at = Date.parse(fixtureTimestamp());
    expect(await evidence.durableThroughMs([first.instanceId])).toBe(at);
    expect(await evidence.durableThroughMs([first.instanceId, second.instanceId])).toBe(at);
    // An instance with no durable decision holds the window unclassified.
    expect(await evidence.durableThroughMs([first.instanceId, "0190a3e0-0000-7000-8000-00000000dead"])).toBeNull();
    expect(await evidence.durableThroughMs([])).toBeNull();
  });

  it("reads a decision with intents as intent evidence, with its source-event columns", async () => {
    const evidence = postgresTraderEvidence(context.db, { environment: "PAPER" });
    const read = await evidence.marketEvidence(windowFor(first), [first.instanceId]);
    expect(read.intents).toStrictEqual([
      { evaluatedAtMs: Date.parse(fixtureTimestamp()), sourceEventId: null, gatewayEpoch: null, ingestSeq: null },
    ]);
    expect(read.fillsAtMs).toStrictEqual([]);
    // Another instance's decisions are not this window's evidence.
    expect((await evidence.marketEvidence(windowFor(first), [second.instanceId])).intents).toStrictEqual([]);
  });

  it("reads refusals and halts from the ops tables when they are written", async () => {
    await context.db
      .insertInto("ops.risk_events")
      .values({
        environment: "PAPER",
        run_id: first.runId,
        instance_id: first.instanceId,
        market_id: first.marketId,
        check_code: "TEST",
        outcome: "VETOED",
        reason_code: "TEST",
        occurred_at: fixtureTimestamp(5),
      })
      .execute();
    await context.db
      .insertInto("ops.incidents")
      .values({
        incident_key: "TEST_HALT",
        environment: "PAPER",
        severity: "PAGE",
        failure_class: "TEST",
        action: "HALT_NEW_ENTRIES",
        market_id: first.marketId,
        detail: "a halt for the classifier",
        opened_at: fixtureTimestamp(10),
      })
      .execute();
    const evidence = postgresTraderEvidence(context.db, { environment: "PAPER" });
    const read = await evidence.marketEvidence(windowFor(first), [first.instanceId]);
    expect(read.refusalsAtMs).toStrictEqual([Date.parse(fixtureTimestamp(5))]);
    expect(read.haltsAtMs).toStrictEqual([Date.parse(fixtureTimestamp(10))]);
  });
});
