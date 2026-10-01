/**
 * The window classifier's read-only PostgreSQL adapter, against a real
 * PostgreSQL migrated with the `WP-040` migrations (`STORAGE-1`).
 *
 * The only file in this suite that starts a container (Testcontainers, a
 * throwaway PostgreSQL; no real credential). It pins the column bindings the
 * compiler cannot: that the adapter's queries run against the real tables and
 * read the trader's durable dispatch frontier and evidence rows back.
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
    gammaMarketId: null,
    tokenIds: [chain.tokenId],
    windowStartMs: Date.parse(fixtureTimestamp(-600)),
    windowEndMs: Date.parse(fixtureTimestamp(600)),
    responsibleFromMs: Date.parse(fixtureTimestamp(-600)),
    responsibility: { kind: "trader", instanceIds: [chain.instanceId] },
  };
}

describe("postgresTraderEvidence (read-only)", () => {
  const EPOCH_A = "0190a3e0-0000-7000-8000-0000000000aa";
  const EPOCH_B = "0190a3e0-0000-7000-8000-0000000000bb";

  it("reads each instance's durable DISPATCH frontier, in integer order, and the epochs a run moved past", async () => {
    const evidence = postgresTraderEvidence(context.db, { environment: "PAPER" });
    // The fixture's decision carries no dispatch position (as H1's do today):
    // no frontier, so the trader's windows cannot be classified.
    expect(await evidence.dispatchFrontiers([first.instanceId])).toStrictEqual(new Map());
    const decision = (evaluationSeq: string, gatewayEpoch: string, ingestSeq: string) => ({
      run_id: first.runId,
      instance_id: first.instanceId,
      market_id: first.marketId,
      evaluation_seq: evaluationSeq,
      callback: "onFeatures" as const,
      decision_type: "enter" as const,
      decision_contract_version: 1,
      reason_codes: ["fixture"],
      feature_snapshot_ref: `snapshot-${evaluationSeq}`,
      intent_count: 0,
      evaluated_at: fixtureTimestamp(Number(evaluationSeq)),
      gateway_epoch: gatewayEpoch,
      ingest_seq: ingestSeq,
    });
    await context.db
      .insertInto("strategy.decisions")
      .values([decision("1", EPOCH_A, "9"), decision("2", EPOCH_A, "10"), decision("3", EPOCH_B, "5")])
      .execute();
    const frontiers = await evidence.dispatchFrontiers([first.instanceId, second.instanceId, "0190a3e0-0000-7000-8000-00000000dead"]);
    // "10" is past "9" as an integer (as text it would not be).
    expect(frontiers.get(first.instanceId)).toStrictEqual({
      byEpoch: new Map([
        [EPOCH_A, "10"],
        [EPOCH_B, "5"],
      ]),
      completedEpochs: new Set([EPOCH_A]),
    });
    // An instance with no decision carrying a dispatch position has no frontier.
    expect(frontiers.has(second.instanceId)).toBe(false);
    expect(frontiers.size).toBe(1);
    expect(await evidence.dispatchFrontiers([])).toStrictEqual(new Map());
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
