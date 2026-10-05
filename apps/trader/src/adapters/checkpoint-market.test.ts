/**
 * `ROLLOVER-1` (the user's ruling Q2): a `strategy.state_checkpoints` row
 * NAMES ITS WINDOW. One run spans many windows, each with its own runtime, so
 * the checkpoint's `market_id` — NULL until now, when one run held one market —
 * is the market of the decision it follows (ADR-027 D3: the same run,
 * instance and sequence). No migration: the nullable foreign key was there
 * from `0004`.
 *
 * Both write paths are pinned on the SQL the store binds (a capturing
 * `pg.Pool` double, as `test/unit/trader/risk-events-binding.test.ts` does):
 * the per-row `persistDecisionWithCheckpoint` and the group commit.
 */

import { createDatabase, type PostgresPool } from "@polymarket-bot/storage-postgres";
import type { DecisionRecord, StrategyStateCheckpoint } from "@polymarket-bot/strategy-runtime";
import { describe, expect, it } from "vitest";

import { PostgresTraderStore } from "./postgres-store.js";

const RUN = "018f3a5c-0000-7000-8000-0000000000b1";
const INSTANCE = "018f3a5c-0000-7000-8000-0000000000b2";
const WINDOW_1 = "019db1a2-1c20-7000-8000-0000000000b3";
const WINDOW_2 = "019db1a2-2a30-7000-8000-0000000000b4";
const EPOCH = "018f3a5c-0000-7000-8000-0000000000b5";

function capturing(): { readonly statements: { sql: string; parameters: readonly unknown[] }[]; readonly store: PostgresTraderStore } {
  const statements: { sql: string; parameters: readonly unknown[] }[] = [];
  const client = {
    query: (sql: string, parameters: readonly unknown[] = []) => {
      statements.push({ sql, parameters: [...parameters] });
      return Promise.resolve({ command: "INSERT", rowCount: 1, rows: [] });
    },
    release: () => undefined,
  };
  const pool = { connect: () => Promise.resolve(client), end: () => Promise.resolve(undefined) };
  // The `pg.Pool` test double the trader's binding tests use.
  const store = new PostgresTraderStore({ db: createDatabase(pool as unknown as PostgresPool), decisionContractVersion: 1 });
  return { statements, store };
}

function decision(seq: number, marketId: string): DecisionRecord {
  return {
    decisionContractVersion: 1,
    runId: RUN,
    instanceId: INSTANCE,
    marketId,
    evaluationSeq: seq,
    callback: "onFeatures",
    attribution: "STRATEGY",
    evaluatedAt: "2026-10-04T22:29:01.000Z",
    sourceEvent: { eventId: "018f3a5c-0000-7000-8000-0000000000b6", gatewayEpoch: EPOCH, ingestSeq: String(100 + seq) },
    decision: { decisionType: "hold", reasonCodes: ["SB.ARMED"], featureSnapshotRef: "snap", intents: [] },
  } as unknown as DecisionRecord;
}

function checkpoint(seq: number): StrategyStateCheckpoint {
  return { runId: RUN, instanceId: INSTANCE, checkpointSeq: seq, stateSchemaVersion: 1, stateJson: "{}" } as unknown as StrategyStateCheckpoint;
}

/** The `market_id` each `state_checkpoints` row of `sql` binds, in row order. */
function checkpointMarkets(statement: { sql: string; parameters: readonly unknown[] }): readonly unknown[] {
  const match = /insert into "strategy"\."state_checkpoints" \(([^)]*)\) values ((?:\([^)]*\)(?:, )?)+)/u.exec(statement.sql);
  if (match === null) throw new Error(`no checkpoint insert in: ${statement.sql}`);
  const columns = (match[1] ?? "").split(", ").map((quoted) => quoted.replaceAll('"', ""));
  const at = columns.indexOf("market_id");
  expect(at, "market_id is a bound column").toBeGreaterThanOrEqual(0);
  const rows = [...(match[2] ?? "").matchAll(/\(([^)]*)\)/gu)].map((row) => (row[1] ?? "").split(", "));
  return rows.map((row) => {
    const placeholder = row[at] ?? "";
    return placeholder.startsWith("$") ? statement.parameters[Number(placeholder.slice(1)) - 1] : placeholder;
  });
}

describe("a checkpoint row names its window (ROLLOVER-1, ruling Q2)", () => {
  it("the per-row path binds the market of the decision the checkpoint is written with", async () => {
    const { statements, store } = capturing();
    const written = await store.persistDecisionWithCheckpoint(
      decision(7, WINDOW_2),
      { evaluationDurationUs: null },
      checkpoint(7),
      "2026-10-04T22:29:01.000Z",
    );
    expect(written.ok).toBe(true);
    const insert = statements.find((statement) => statement.sql.includes('"strategy"."state_checkpoints"'));
    if (insert === undefined) throw new Error("no checkpoint statement");
    expect(checkpointMarkets(insert)).toEqual([WINDOW_2]);
  });

  it("the group commit binds each checkpoint the market of ITS decision — two windows in one staging", async () => {
    const { statements, store } = capturing();
    const staged = store.groupCommit.stage({
      decisions: [
        { record: decision(0, WINDOW_1), telemetry: { evaluationDurationUs: null } },
        { record: decision(1, WINDOW_2), telemetry: { evaluationDurationUs: null } },
        { record: decision(2, WINDOW_1), telemetry: { evaluationDurationUs: null } },
      ],
      checkpoints: [
        { checkpoint: checkpoint(1), capturedAt: "2026-10-04T22:29:01.000Z" },
        { checkpoint: checkpoint(2), capturedAt: "2026-10-04T22:29:01.000Z" },
      ],
      riskRefusals: [],
    });
    expect(staged.ok).toBe(true);
    expect((await store.groupCommit.commit()).ok).toBe(true);
    const insert = statements.find((statement) => statement.sql.includes('"strategy"."state_checkpoints"'));
    if (insert === undefined) throw new Error("no checkpoint statement");
    expect(checkpointMarkets(insert)).toEqual([WINDOW_2, WINDOW_1]);
  });

  it("a staging whose checkpoint has no decision beside it keeps the pre-ROLLOVER-1 NULL rather than invent a market", async () => {
    const { statements, store } = capturing();
    store.groupCommit.stage({ decisions: [], checkpoints: [{ checkpoint: checkpoint(3), capturedAt: "2026-10-04T22:29:01.000Z" }], riskRefusals: [] });
    expect((await store.groupCommit.commit()).ok).toBe(true);
    const insert = statements.find((statement) => statement.sql.includes('"strategy"."state_checkpoints"'));
    if (insert === undefined) throw new Error("no checkpoint statement");
    expect(checkpointMarkets(insert)).toEqual([null]);
  });
});
