/**
 * `DURABLE-1` (closeout blocker X1) — the durable variant: a REAL PostgreSQL
 * refuses the intent-bearing decision, and no `accounting` row exists without
 * its decision row, nothing is submitted and nothing is filled.
 *
 * `execution.*` (r1, LOW-2): the trader writes NO `execution.*` table at all —
 * `PostgresTraderStore` writes `strategy.*` and `accounting.*` only — so an
 * "empty execution tables" assertion under the refusal proves nothing. It is
 * kept instead as a PREMISE in the control (the tables are empty even when the
 * run books its fill): the day the trader starts writing them, the control
 * fails here and the refused case must assert them.
 *
 * The failure is injected INSIDE the database, exactly at that decision: a
 * test-only `BEFORE INSERT` trigger on `strategy.decisions` raises for a row
 * whose `intent_count` is above zero. The statement that carries the entry's
 * decision fails in PostgreSQL itself — a per-row insert, or the whole
 * group-commit transaction it is part of — and the trader receives the
 * adapter's own `UNAVAILABLE` failure, as it would for any database error.
 * Nothing in the trader is doubled; the trigger lives only in this file's
 * throwaway databases (no migration is touched).
 *
 * Two arms:
 *
 * - GROUP COMMIT — the process's own assembly (`assembleDurableTrader`: the
 *   real `PostgresTraderStore` with its group commit, the `BOOT-1`
 *   registration check, the simulated venue, `createPaperTrader`);
 * - PER-ROW — the same `PostgresTraderStore`, handed to the trader without its
 *   group commit, so every decision is its own insert.
 *
 * And a control, without the trigger: the same run books its fill, so the
 * zero rows below are the refusal's doing, not an empty fixture.
 *
 * Docker: Testcontainers, its own `beforeAll`, as the other container files
 * of this suite. Throwaway credentials; PAPER only; no venue, no signer.
 */

import { createDatabase, createPostgresPool } from "@polymarket-bot/storage-postgres";
import { startPostgresContainer, type TestContext } from "@polymarket-bot/storage-postgres/testing";
import { parseTraderConfig, type TraderStore } from "@polymarket-bot/trader";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PostgresTraderStore } from "../../../apps/trader/src/adapters/postgres-store.js";
import { assembleDurableTrader, SystemPaperClock } from "../../../apps/trader/src/main.js";
import { assemble, recordedEvents, safeEnvironment } from "./support/fixture.js";
import {
  CONDITION_ID,
  documentFor,
  registerThroughTheRepositories,
  withFreshDatabase,
} from "./support/registration.js";

let container: Awaited<ReturnType<typeof startPostgresContainer>>;

beforeAll(async () => {
  container = await startPostgresContainer();
}, 300_000);

afterAll(async () => {
  await container?.stop();
});

const EXECUTION_TABLES = [
  "plans",
  "groups",
  "submission_attempts",
  "orders",
  "order_events",
  "intent_order_links",
  "fills",
  "fill_allocations",
  "trade_settlements",
] as const;

/** The test-only failure: PostgreSQL refuses the first intent-bearing decision it is asked to insert. */
async function refuseIntentBearingDecisions(context: TestContext): Promise<void> {
  await context.pool.query(
    `create function public.durable1_refuse_intent_decision() returns trigger
       language plpgsql as $$
     begin
       raise exception 'DURABLE-1: the database refuses the intent-bearing decision (evaluation_seq %)',
         new.evaluation_seq;
     end
     $$`,
  );
  await context.pool.query(
    `create trigger durable1_refuse_intent_decision
       before insert on strategy.decisions
       for each row when (new.intent_count > 0)
       execute function public.durable1_refuse_intent_decision()`,
  );
}

async function count(context: TestContext, table: string, where = "true"): Promise<number> {
  const { rows } = await context.pool.query<{ n: string }>(`select count(*)::text as n from ${table} where ${where}`);
  return Number(rows[0]?.n ?? "0");
}

interface DurableCounts {
  readonly decisions: number;
  readonly intentDecisions: number;
  readonly ledgerTransactions: number;
  readonly ledgerEntries: number;
  readonly pnlSnapshots: number;
  readonly execution: Readonly<Record<string, number>>;
}

async function durableCounts(context: TestContext): Promise<DurableCounts> {
  const execution: Record<string, number> = {};
  for (const table of EXECUTION_TABLES) execution[table] = await count(context, `execution.${table}`);
  return {
    decisions: await count(context, "strategy.decisions"),
    intentDecisions: await count(context, "strategy.decisions", "intent_count > 0"),
    ledgerTransactions: await count(context, "accounting.ledger_transactions"),
    ledgerEntries: await count(context, "accounting.ledger_entries"),
    pnlSnapshots: await count(context, "accounting.pnl_snapshots"),
    execution,
  };
}

const NO_EXECUTION_ROWS = Object.fromEntries(EXECUTION_TABLES.map((table) => [table, 0]));

/** The process's own assembly (group commit), driven over the fixture's six events. */
async function runGroupCommitting(label: string, connectionString: string, context: TestContext) {
  const registered = await registerThroughTheRepositories(context, label);
  const document = documentFor(registered, label);
  const parsed = parseTraderConfig(document);
  if (!parsed.ok) throw new Error(`${parsed.refusal.code}: ${parsed.refusal.issues.join("; ")}`);
  const lines: string[] = [];
  const assembled = await assembleDurableTrader({
    env: safeEnvironment(),
    config: parsed.config,
    document,
    postgresUrl: connectionString,
    clock: new SystemPaperClock(),
    log: (line) => {
      lines.push(line);
    },
  });
  if (!assembled.ok) throw new Error(`the durable trader did not assemble:\n${lines.join("\n")}`);
  expect(assembled.trader.loop.groupCommits).toBe(true);
  for (const event of recordedEvents(registered.marketId, `${CONDITION_ID}-${label}`)) {
    expect(assembled.trader.loop.ingest(event)).toBe(true);
  }
  await assembled.trader.loop.drain();
  await assembled.store.close();
  return { trader: assembled.trader, fills: undefined as number | undefined };
}

/** The same store without its group commit: every decision is its own insert. */
async function runPerRow(label: string, connectionString: string, context: TestContext) {
  const registered = await registerThroughTheRepositories(context, label);
  const store = new PostgresTraderStore({
    db: createDatabase(createPostgresPool({ connectionString })),
    decisionContractVersion: 1,
  });
  const perRow: TraderStore = {
    persistDecision: (record, telemetry) => store.persistDecision(record, telemetry),
    saveCheckpoint: (checkpoint, capturedAt) => store.saveCheckpoint(checkpoint, capturedAt),
    appendLedgerTransaction: (transaction) => store.appendLedgerTransaction(transaction),
    writePnlSnapshot: (snapshot) => store.writePnlSnapshot(snapshot),
    replacePnlSnapshot: (snapshot) => store.replacePnlSnapshot(snapshot),
    close: () => store.close(),
  };
  const { result, parts } = assemble({ config: documentFor(registered, label), wrapStore: () => perRow });
  if (!result.ok || parts === undefined) throw new Error("the per-row trader did not assemble");
  expect(result.trader.loop.groupCommits).toBe(false);
  for (const event of recordedEvents(registered.marketId, `${CONDITION_ID}-${label}`)) {
    expect(result.trader.loop.ingest(event)).toBe(true);
  }
  await result.trader.loop.drain();
  await store.close();
  return { trader: result.trader, fills: parts.venue.fills.length };
}

describe.each([
  { arm: "group commit (the process's own assembly)", run: runGroupCommitting },
  { arm: "per-row inserts", run: runPerRow },
])("a real PostgreSQL refuses the intent-bearing decision — $arm (DURABLE-1)", ({ run }) => {
  it("CONTROL: without the refusal the run books its fill, and every intent-bearing decision is durable", async () => {
    await withFreshDatabase(container.getConnectionUri(), "durable1-control", async ({ connectionString, context }) => {
      const { trader, fills } = await run("control", connectionString, context);
      expect(trader.halts.records()).toEqual([]);
      if (fills !== undefined) expect(fills).toBe(1);
      expect(trader.loop.health().execution.fillsObserved).toBe(1);

      const counts = await durableCounts(context);
      expect(counts.intentDecisions).toBe(2);
      expect(counts.ledgerTransactions).toBeGreaterThan(0);
      expect(counts.ledgerEntries).toBeGreaterThan(0);
      expect(counts.pnlSnapshots).toBeGreaterThan(0);
      // The premise (LOW-2): the trader writes no execution row even when it
      // fills, so the refused case below cannot use these tables as evidence.
      expect(counts.execution).toEqual(NO_EXECUTION_ROWS);
      // The entry's decision row was written by an EARLIER transaction than
      // every ledger row its fill caused.
      const { rows } = await context.pool.query<{ ok: boolean }>(
        `select (select min(xmin::text::bigint) from accounting.ledger_transactions)
              > (select min(xmin::text::bigint) from strategy.decisions where intent_count > 0) as ok`,
      );
      expect(rows[0]?.ok).toBe(true);
    });
  }, 180_000);

  it("REFUSED: zero accounting rows, no intent-bearing decision row, no submission, no fill, a GLOBAL STORE_UNAVAILABLE halt", async () => {
    await withFreshDatabase(container.getConnectionUri(), "durable1-refused", async ({ connectionString, context }) => {
      await refuseIntentBearingDecisions(context);
      const { trader, fills } = await run("refused", connectionString, context);

      // The strategy DID emit the entry: the database is what refused it.
      expect(trader.loop.decisions().some((decision) => decision.intentIds.length > 0)).toBe(true);
      const halts = trader.halts.records();
      expect(halts.map((halt) => [halt.scope.kind, halt.code])).toEqual([["GLOBAL", "STORE_UNAVAILABLE"]]);
      expect(halts[0]?.detail).toContain("DURABLE-1: the database refuses the intent-bearing decision");

      const health = trader.loop.health();
      expect(health.execution.submissionsAccepted).toBe(0);
      expect(health.execution.fillsObserved).toBe(0);
      expect(health.accounting.ledgerTransactions).toBe(0);
      if (fills !== undefined) expect(fills).toBe(0);

      const counts = await durableCounts(context);
      expect(counts.intentDecisions).toBe(0);
      expect(counts.ledgerTransactions).toBe(0);
      expect(counts.ledgerEntries).toBe(0);
      expect(counts.pnlSnapshots).toBe(0);
    });
  }, 180_000);
});
