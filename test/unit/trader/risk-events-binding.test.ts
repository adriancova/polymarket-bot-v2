/**
 * `PROVENANCE-1` — the SQL `PostgresTraderStore` emits for a refused intent
 * (`ops.risk_events`), on the per-row path and inside the group commit.
 *
 * The companion of the PostgreSQL files that read the rows back
 * (`test/integration/paper-trader/durable-halts-and-refusals-postgres-redis.test.ts`):
 * this one pins WHICH STATEMENT is sent, without Docker, through the REAL
 * `createDatabase` (the repository's own Kysely and dialect) over a pool
 * stand-in that records `(sql, parameters)` — the `TRDR-2` precedent
 * (`pnl-snapshot-column-binding.test.ts`).
 *
 * It also pins that a group-commit batch WITHOUT a refusal emits exactly the
 * statement it emitted before this round (the `THROUGHPUT-1a` single
 * statement), so the hot path is unchanged.
 */

import { describe, expect, it } from "vitest";

import {
  PRE_TRADE_RISK_CHECK_CODE,
  PostgresTraderStore,
  boundedDetail,
  riskEventRows,
} from "../../../apps/trader/src/adapters/postgres-store.js";
import { createDatabase } from "../../../packages/storage-postgres/src/database.js";
import type { PostgresPool } from "../../../packages/storage-postgres/src/pool.js";
import type { DecisionRecord } from "../../../packages/strategy-runtime/src/index.js";
import type { RiskRefusalRecord } from "../../../packages/trading-core/src/index.js";

interface Captured {
  readonly statements: { readonly sql: string; readonly parameters: readonly unknown[] }[];
  readonly pool: PostgresPool;
}

function capturingPool(): Captured {
  const statements: { sql: string; parameters: readonly unknown[] }[] = [];
  const client = {
    query: (sql: string, parameters: readonly unknown[] = []) => {
      statements.push({ sql, parameters: [...parameters] });
      return Promise.resolve({ command: "INSERT", rowCount: 1, rows: [] });
    },
    release: () => undefined,
  };
  const pool = { connect: () => Promise.resolve(client), end: () => Promise.resolve(undefined) };
  // The `pg.Pool` test double, exactly as `pnl-snapshot-column-binding.test.ts` makes it.
  return { statements, pool: pool as unknown as PostgresPool };
}

const RUN = "018f3a5c-0000-7000-8000-0000000000a1";
const INSTANCE = "018f3a5c-0000-7000-8000-0000000000a2";
const MARKET = "018f3a5c-0000-7000-8000-0000000000a3";
const EPOCH = "018f3a5c-0000-7000-8000-0000000000a4";

function refusal(overrides: Partial<RiskRefusalRecord> = {}): RiskRefusalRecord {
  return {
    runId: RUN,
    instanceId: INSTANCE,
    marketId: MARKET,
    evaluationSeq: 12,
    intentId: "sb-entry-0-x",
    protectiveExit: false,
    occurredAt: "2026-03-04T12:00:01.000Z",
    refusals: [
      { code: "RISK_WORST_CASE_LOSS_EXCEEDED", message: "worst-case loss 17 exceeds 1" },
      { code: "RISK_TIME_TO_CLOSE_ENTRY_BLOCKED", message: "inside the entry cutoff" },
    ],
    sourceEvent: { eventId: "018f3a5c-0000-7000-8000-0000000000a5", gatewayEpoch: EPOCH, ingestSeq: "4041" },
    ...overrides,
  };
}

describe("riskEventRows: one ops.risk_events row per refusal (PROVENANCE-1)", () => {
  it("binds each refusal as a VETOED pre-trade event of the decision's run, instance and market, with no intent foreign key", () => {
    const rows = riskEventRows(refusal(), "paper-account");
    expect(rows).toHaveLength(2);
    const [first, second] = rows;
    expect(first).toMatchObject({
      environment: "PAPER",
      account_ref: "paper-account",
      run_id: RUN,
      instance_id: INSTANCE,
      market_id: MARKET,
      intent_id: null,
      check_code: PRE_TRADE_RISK_CHECK_CODE,
      outcome: "VETOED",
      reason_code: "RISK_WORST_CASE_LOSS_EXCEEDED",
      detail: "worst-case loss 17 exceeds 1",
      occurred_at: "2026-03-04T12:00:01.000Z",
    });
    expect(second?.reason_code).toBe("RISK_TIME_TO_CLOSE_ENTRY_BLOCKED");
    // `measures` is TEXT (the SER-2 rule), the same document on every row of the refusal.
    expect(typeof first?.measures).toBe("string");
    expect(second?.measures).toBe(first?.measures);
    expect(JSON.parse(String(first?.measures))).toStrictEqual({
      evaluationSeq: "12",
      gatewayEpoch: EPOCH,
      ingestSeq: "4041",
      intentId: "sb-entry-0-x",
      protectiveExit: false,
      reasonCodes: ["RISK_WORST_CASE_LOSS_EXCEEDED", "RISK_TIME_TO_CLOSE_ENTRY_BLOCKED"],
      sourceEventId: "018f3a5c-0000-7000-8000-0000000000a5",
    });
  });

  it("a loop-originated decision's refusal carries null positions; an absent account is NULL", () => {
    const [row] = riskEventRows(refusal({ sourceEvent: null, protectiveExit: true }), null);
    expect(row?.account_ref).toBeNull();
    expect(JSON.parse(String(row?.measures))).toMatchObject({
      sourceEventId: null,
      gatewayEpoch: null,
      ingestSeq: null,
      protectiveExit: true,
    });
  });

  it("bounds a long message to internal.detail's 2000 characters, saying it was cut", () => {
    const long = "x".repeat(5000);
    const [row] = riskEventRows(refusal({ refusals: [{ code: "RISK_INPUT_INVALID", message: long }] }), null);
    expect(Array.from(row?.detail ?? "")).toHaveLength(2000);
    expect(row?.detail).toMatch(/\[5000 characters; truncated to fit internal\.detail\]$/u);
    expect(boundedDetail("short")).toBe("short");
    // Counted in code points, as PostgreSQL counts characters.
    const astral = "😀".repeat(2001);
    expect(Array.from(boundedDetail(astral))).toHaveLength(2000);
    expect(Array.from(boundedDetail("😀".repeat(2000)))).toHaveLength(2000);
  });
});

describe("PostgresTraderStore writes refusals in ONE statement (PROVENANCE-1)", () => {
  it("persistRiskRefusal: one multi-row INSERT into ops.risk_events", async () => {
    const capture = capturingPool();
    const store = new PostgresTraderStore({ db: createDatabase(capture.pool), decisionContractVersion: 1, accountRef: "paper-account" });
    const outcome = await store.persistRiskRefusal(refusal());
    expect(outcome.ok).toBe(true);
    expect(capture.statements).toHaveLength(1);
    const statement = capture.statements[0];
    expect(statement?.sql).toMatch(/^insert into "ops"\."risk_events" \("environment", "account_ref", "run_id", "instance_id", "market_id", "intent_id", "check_code", "outcome", "reason_code", "measures", "detail", "occurred_at"\) values \(\$1, /u);
    expect(statement?.parameters).toContain("RISK_WORST_CASE_LOSS_EXCEEDED");
    expect(statement?.parameters).toContain("RISK_TIME_TO_CLOSE_ENTRY_BLOCKED");
    expect(statement?.parameters).toContain("paper-account");
  });

  it("a failed insert is UNAVAILABLE port data, never a throw", async () => {
    const pool = {
      connect: () => Promise.resolve({ query: () => Promise.reject(new Error("relation does not exist")), release: () => undefined }),
      end: () => Promise.resolve(undefined),
    } as unknown as PostgresPool;
    const store = new PostgresTraderStore({ db: createDatabase(pool), decisionContractVersion: 1 });
    const outcome = await store.persistRiskRefusal(refusal());
    expect(outcome).toEqual({
      ok: false,
      failure: { kind: "UNAVAILABLE", detail: "the durable store could not persist a risk refusal: Error: relation does not exist" },
    });
  });
});

function decision(seq: number): DecisionRecord {
  return {
    decisionContractVersion: 1,
    runId: RUN,
    instanceId: INSTANCE,
    marketId: MARKET as DecisionRecord["marketId"],
    evaluationSeq: seq,
    callback: "onFeatures",
    attribution: "STRATEGY",
    evaluatedAt: "2026-03-04T12:00:01.000Z",
    sourceEvent: { eventId: "018f3a5c-0000-7000-8000-0000000000a5", gatewayEpoch: EPOCH, ingestSeq: String(4000 + seq) },
    decision: { decisionType: "hold", reasonCodes: ["SB.ARMED"], featureSnapshotRef: "snap", intents: [] },
  } as unknown as DecisionRecord;
}

function checkpoint(seq: number) {
  return {
    checkpoint: { runId: RUN, instanceId: INSTANCE, checkpointSeq: seq, stateSchemaVersion: 1, stateJson: "{}" },
    capturedAt: "2026-03-04T12:00:01.000Z",
  } as unknown as Parameters<PostgresTraderStore["groupCommit"]["stage"]>[0]["checkpoints"][number];
}

describe("the group commit carries refusals in its one atomic statement (PROVENANCE-1)", () => {
  async function committed(input: { decisions: number[]; checkpoints: number[]; refusals: RiskRefusalRecord[] }) {
    const capture = capturingPool();
    const store = new PostgresTraderStore({ db: createDatabase(capture.pool), decisionContractVersion: 1 });
    const staged = store.groupCommit.stage({
      decisions: input.decisions.map((seq) => ({ record: decision(seq), telemetry: { evaluationDurationUs: null } })),
      checkpoints: input.checkpoints.map(checkpoint),
      riskRefusals: input.refusals,
    });
    expect(staged.ok).toBe(true);
    const outcome = await store.groupCommit.commit();
    expect(outcome.ok).toBe(true);
    return capture.statements.map((statement) => statement.sql);
  }

  it("a batch WITHOUT refusals emits the THROUGHPUT-1a statement, unchanged: decisions in a CTE feeding the checkpoints", async () => {
    const sql = await committed({ decisions: [1], checkpoints: [1], refusals: [] });
    expect(sql).toHaveLength(1);
    expect(sql[0]).toMatch(/^with "staged_decisions" as \(insert into "strategy"\."decisions" .* returning "decision_id"\) insert into "strategy"\."state_checkpoints" /u);
    expect(sql[0]).not.toContain("risk_events");
  });

  it("decisions, checkpoints and refusals: ONE statement, the refusals a data-modifying CTE member", async () => {
    const sql = await committed({ decisions: [1], checkpoints: [1], refusals: [refusal()] });
    expect(sql).toHaveLength(1);
    expect(sql[0]).toMatch(
      /^with "staged_decisions" as \(insert into "strategy"\."decisions" .*\), "staged_risk_events" as \(insert into "ops"\."risk_events" .* returning "risk_event_id"\) insert into "strategy"\."state_checkpoints" /u,
    );
  });

  it("checkpoints and refusals (the usual shape: the decision went at the DURABLE-1 boundary): ONE statement", async () => {
    const sql = await committed({ decisions: [], checkpoints: [1], refusals: [refusal()] });
    expect(sql).toHaveLength(1);
    expect(sql[0]).toMatch(/^with "staged_risk_events" as \(insert into "ops"\."risk_events" .*\) insert into "strategy"\."state_checkpoints" /u);
  });

  it("decisions and refusals: ONE statement; refusals alone: one INSERT", async () => {
    const both = await committed({ decisions: [1], checkpoints: [], refusals: [refusal()] });
    expect(both).toHaveLength(1);
    expect(both[0]).toMatch(/^with "staged_decisions" as \(insert into "strategy"\."decisions" .*\) insert into "ops"\."risk_events" /u);
    const alone = await committed({ decisions: [], checkpoints: [], refusals: [refusal()] });
    expect(alone).toHaveLength(1);
    expect(alone[0]).toMatch(/^insert into "ops"\."risk_events" /u);
  });

  it("a batch past one statement's rows: every table in ONE explicit transaction", async () => {
    const many = Array.from({ length: 600 }, (_, index) => index + 1);
    const sql = await committed({ decisions: many, checkpoints: many, refusals: [refusal()] });
    expect(sql[0]).toBe("begin");
    expect(sql.at(-1)).toBe("commit");
    expect(sql.filter((text) => text.startsWith('insert into "ops"."risk_events"'))).toHaveLength(1);
    expect(sql.filter((text) => text.startsWith('insert into "strategy"."decisions"'))).toHaveLength(1);
    expect(sql.filter((text) => text.startsWith('insert into "strategy"."state_checkpoints"'))).toHaveLength(1);
  });
});
