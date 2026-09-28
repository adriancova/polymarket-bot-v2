/**
 * `SNAP-1` — an entry that walks TWO ask levels in one instant, through the
 * REAL composition root, a REAL PostgreSQL and a REAL Redis stream: the shape
 * the durable trader used to GLOBAL-halt on (`BRACKET1C-SNAPKEY`).
 *
 * ## The finding this file closes
 *
 * `BRACKET-1c` (probe F3) measured it: with bracket 1's first YES ask level
 * thinned to `0.34 x 30`, the 50-share entry fills `30 @ 0.34` + `20 @ 0.35`
 * at `12:00:02`, and the trader halted there — `STORE_UNAVAILABLE … duplicate
 * key value violates unique constraint "pnl_snapshots_scope_unique"` — because
 * `apps/trader/src/loop.ts` wrote one PnL snapshot PER FILL and
 * `accounting.pnl_snapshots` admits one per (scope, environment, account_ref,
 * instance_id, market_id, as_of). The in-memory store accepted the duplicate,
 * which is how every all-doubles harness masked it. The user ruled "one
 * snapshot per instance per instant" (2026-09-28): the loop now computes the
 * row at every fill exactly as before and writes, once per harvest, the row of
 * each instance's LAST fill at that instant; `MemoryTraderStore` enforces the
 * same key.
 *
 * ## What runs
 *
 * `BRACKET-1c`'s path, unchanged: registration through `WP-040`'s
 * repositories (`support/registration.ts`), `assembleDurableTrader` (the
 * `PostgresTraderStore` on a Testcontainers PostgreSQL, the realized-PnL
 * observer), every event published with `RedisStreamsEventTransport` onto a
 * Testcontainers Redis stream and consumed by the process's own
 * `RedisMarketEventFeed` and `pump`, then the SHUTDOWN rebuild check. The
 * scenario is `BRACKET-1c`'s eleven events (`support/two-brackets.ts`) with ONE
 * delta: bracket 1's YES asks are {@link TWO_LEVEL_BRACKET_1_YES_ASKS}
 * (`0.34 x 30`, `0.35 x 300`) — F3, committed. Two tests: the event-time
 * clock with one event per pump (so the in-memory state right after the
 * `12:00:02` event can be captured), and the process's own
 * `SystemPaperClock` with ONE pump over the whole stream.
 *
 * ## Hand derivation (written before the first run)
 *
 * Fixture fee schedule: zero (taker and maker). Sizes 50 shares.
 *
 * | Step | Instant | What | Instance cash |
 * | --- | --- | --- | ---: |
 * | entry 1 | 12:00:02 | BUY 50 = `30 @ 0.34` (10.2) + `20 @ 0.35` (7), both TAKER, ONE event | −17.2 |
 * | reduce | 12:03:05 or 12:03:06 | the holding timeout; `SB.PROTECTED_REDUCE` SELL 50 @ 0.32 → `SB.CLOSED` | +16 |
 * | entry 2 | 12:03:41 | BUY 50 @ 0.33 (one level, as `BRACKET-1c`) | −16.5 |
 * | TP fill | 12:04:00 | public trade `0.5 x 60` fills the take-profit as MAKER → `SB.CLOSED` | +25 |
 * | end | 12:04:10 | `SB.REFUSED_MAXIMUM_ENTRIES` | |
 *
 * The reduce instant is not pinned in advance: bracket 1's take-profit is now
 * sized from the first fill and must follow the second, and whether one is
 * still resting at `12:03:05` (withdrawn first, §6 invariant 13, then the
 * reduce at `12:03:06`) is the strategy's business, not this round's. The
 * economics do not depend on it.
 *
 * - Fills: 5. Ledger transactions: 2 per fill (no `PLATFORM_FEE` for a zero
 *   fee) = **10**; the instance's `TRADE_PRINCIPAL` pUSD legs at `12:00:02` are
 *   `−10.2` and `−7` — BOTH fills booked.
 * - PnL snapshots, ONE per instant with fills — **4**, where base (one per
 *   fill) would have written 5 and the database refused the second:
 *
 * | as_of | capital_committed | realized | unrealized_midpoint | gross | core_net | worst_case |
 * | --- | ---: | ---: | ---: | ---: | ---: | ---: |
 * | 12:00:02 (after the SECOND fill; mark `0.35`) | 17.2 | 0 | `50 × 0.35 − 17.2 = 0.3` | 0.3 | 0.3 | `0 − 17.2 = −17.2` |
 * | reduce | 0 | `16 − 17.2 = −1.2` | 0 | −1.2 | −1.2 | −1.2 |
 * | 12:03:41 (mark `0.33`) | 16.5 | −1.2 | 0 | −1.2 | −1.2 | `−1.2 − 16.5 = −17.7` |
 * | 12:04:00 | 0 | `−1.2 + 25 − 16.5 = 7.3` | 0 | 7.3 | 7.3 | 7.3 |
 *
 *   The row base wrote FIRST at `12:00:02` — after `30 @ 0.34` alone:
 *   capital `10.2`, midpoint `30 × 0.34 − 10.2 = 0`, worst `−10.2` — must NOT
 *   exist.
 * - The instance's durable pUSD entries: `−1.2` at the bracket boundary,
 *   `7.3` at the end; its token entries `0` at both.
 * - The TRDR-3 realized-PnL book: `7.3`, the last durable row.
 *
 * **Observed on the first run** (matched every derived value above; not
 * derived beforehand, and pinned from then on): the reduce is at `12:03:06`.
 * The take-profit placed from the FIRST fill's `onFill` (`SB.TAKE_PROFIT_INTENT`)
 * was still resting when the second fill's `onFill` answered
 * `SB.EXIT_ORDER_WORKING, SB.AWAITING_CANCEL_CONFIRMATION`, so at `12:03:05`
 * the holding timeout withdrew it (`SB.HOLDING_TIMEOUT, SB.SAFETY_CANCEL`) and
 * the reduce followed at `12:03:06` — 20 decisions in all, none paused.
 *
 * ## What else is pinned
 *
 * The `12:00:02` durable row equals, column for column, the §9.16 row of the
 * trader's IN-MEMORY held PnL state captured right after that event (marked
 * at the second fill's price) — so the one row kept is the state after the
 * last fill. And on this real PostgreSQL, a second write of that row through
 * the assembled store answers EXACTLY what `MemoryTraderStore` answers for
 * the same duplicate (`test/unit/trader/memory-store-pnl-snapshot-key.test.ts`
 * holds the double against the adapter with a stand-in handle; this holds it
 * against the database).
 *
 * Non-vacuity (the `SNAP-1` handoff has the command and output): with base's
 * `apps/trader/src/loop.ts` restored, the event-time test halts at `12:00:02`
 * with `STORE_UNAVAILABLE … pnl_snapshots_scope_unique`.
 *
 * ## What it does NOT prove (disclosed)
 *
 * Simulated execution (Tier-0 `SimulatedVenue`, fills
 * `SIMULATED_NOT_REAL_EVIDENCE`) over real PostgreSQL and Redis; envelopes this
 * suite builds, not the gateway's normalisation; not `startup()` itself; the
 * durable execution chain is still absent (`RECON2-DURABLE`). Two EVENTS at
 * one instant (the loop's owed-row path) are pinned in memory
 * (`apps/trader/src/loop-folds.test.ts`, `SNAP-1` blocks), not here. Not a
 * soak, not live evidence; §7 item 1 is graded by a fresh closeout.
 *
 * ## Docker
 *
 * Testcontainers, as the other container files: this file's own `beforeAll`
 * starts one PostgreSQL and one Redis; no `globalSetup`; no skip when Docker
 * is absent. Throwaway credentials that live only for the run (§0.2,
 * ADR-010); `environment` is `PAPER` throughout; no venue, no signer, no real
 * order.
 */

import { addDecimal } from "@polymarket-bot/decimal";
import { RedisStreamsEventTransport } from "@polymarket-bot/event-bus";
import { startRedisContainer, uniqueStreamName } from "@polymarket-bot/event-bus/testing";
import { computePnlSnapshot, type PnlSnapshot } from "@polymarket-bot/pnl";
import { startPostgresContainer } from "@polymarket-bot/storage-postgres/testing";
import {
  normalizeToStrictUtc,
  parseTraderConfig,
  type Clock,
  type IngestedEvent,
  type LoopHealthSnapshot,
  type MarketEventFeed,
  type PortResult,
  type PumpResult,
} from "@polymarket-bot/trader";
import { ManualClock, MemoryTraderStore } from "@polymarket-bot/trader/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { RedisMarketEventFeed } from "../../../apps/trader/src/adapters/redis-feed.js";
import { assembleDurableTrader, SystemPaperClock } from "../../../apps/trader/src/main.js";
import { pump } from "../../../apps/trader/src/pump.js";
import { safeEnvironment } from "./support/fixture.js";
import {
  ACCOUNT,
  CONDITION_ID,
  registerThroughTheRepositories,
  withFreshDatabase,
} from "./support/registration.js";
import {
  TWO_LEVEL_BRACKET_1_YES_ASKS,
  twoBracketsDocument,
  twoBracketsEvents,
  twoBracketsStrategyParams,
} from "./support/two-brackets.js";

let postgres: Awaited<ReturnType<typeof startPostgresContainer>>;
let redis: Awaited<ReturnType<typeof startRedisContainer>>;

beforeAll(async () => {
  [postgres, redis] = await Promise.all([startPostgresContainer(), startRedisContainer()]);
}, 300_000);

afterAll(async () => {
  await Promise.all([postgres?.stop(), redis?.stop()]);
});

/** The two-level entry's instant, and the price of its SECOND (last) fill. */
const ENTRY_INSTANT = "2026-03-04T12:00:02Z";
const ENTRY_LAST_FILL_PRICE = "0.35";
/** Index of the `12:00:02` NO book (the entry) in the eleven events. */
const ENTRY_EVENT_INDEX = 4;

/** Codes that would mean the instance lost track of its own orders or stopped. */
const FORBIDDEN_CODES = ["SB.PAUSED", "SB.UNATTRIBUTED_FILL", "SB.ILLEGAL_TRANSITION", "SB.POSITION_MISMATCH"];

/** The §9.16 economic columns, durable name → `PnlSnapshot` field. */
const COLUMNS: readonly (readonly [string, keyof PnlSnapshot])[] = [
  ["gross_trading_pnl", "grossTradingPnl"],
  ["core_net_pnl", "coreNetPnl"],
  ["all_in_pnl", "allInPnl"],
  ["realized_pnl", "realizedPnl"],
  ["unrealized_pnl_midpoint", "unrealizedPnlMidpoint"],
  ["unrealized_pnl_model", "unrealizedPnlModel"],
  ["unrealized_pnl_liquidation", "unrealizedPnlLiquidation"],
  ["worst_case_resolution_pnl", "worstCaseResolutionPnl"],
  ["fees_paid", "feesPaid"],
  ["reward_estimate_total", "rewardEstimateTotal"],
  ["realized_rewards", "realizedRewards"],
  ["capital_committed", "capitalCommitted"],
  ["denomination_asset", "denominationAsset"],
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordedInstant(receivedAt: string): { readonly instant: string; readonly epochMs: number } {
  const normalized = normalizeToStrictUtc(receivedAt);
  if (!normalized.ok) throw new Error(`unreadable receivedAt ${receivedAt}: ${normalized.problem}`);
  return { instant: normalized.instant, epochMs: normalized.epochMs };
}

/** The process's own feed, wrapped to position an event-time clock per delivered event (one per poll). */
function positioningFeed(feed: RedisMarketEventFeed, clock: ManualClock | undefined): MarketEventFeed {
  return {
    poll: async () => {
      const result = await feed.poll();
      if (!result.ok) return result;
      if (clock !== undefined && result.value.length > 1) {
        throw new Error(`the event-time clock positions at ONE event per poll; got ${String(result.value.length)}`);
      }
      for (const event of result.value) {
        const { instant, epochMs } = recordedInstant(event.envelope.receivedAt);
        clock?.positionAt(instant, BigInt(epochMs) * 1_000_000n);
      }
      return result;
    },
    commit: () => feed.commit(),
    close: () => feed.close(),
  };
}

function sumDecimals(values: readonly unknown[]): string {
  let total = "0";
  for (const value of values) {
    if (typeof value !== "string") throw new Error(`a durable amount is not a string: ${typeof value}`);
    total = addDecimal(total, value);
  }
  return total;
}

interface Run {
  readonly instanceId: string;
  readonly runId: string;
  readonly marketId: string;
  readonly events: readonly IngestedEvent[];
  readonly pumps: readonly PumpResult[];
  readonly rebuildMatched: boolean;
  readonly health: LoopHealthSnapshot;
  readonly memory: {
    readonly reasonCodes: readonly (readonly string[])[];
    /** Per-event runs only: the traces (booked fills) and the §9.16 row of the held state right after `12:00:02`. */
    readonly tracesAfterEntry: number | undefined;
    readonly rowAfterEntry: PnlSnapshot | undefined;
  };
  readonly db: {
    readonly decisions: readonly { readonly callback: string; readonly reasonCodes: readonly string[]; readonly evaluatedAt: string }[];
    readonly finalState: unknown;
    readonly transactions: readonly { readonly id: string; readonly eventType: string; readonly occurredAt: string }[];
    readonly entries: readonly {
      readonly transactionId: string;
      readonly scope: string;
      readonly assetId: string;
      readonly amount: unknown;
      readonly instanceId: string | null;
    }[];
    readonly snapshots: readonly Readonly<Record<string, unknown>>[];
  };
  /** A second write of the `12:00:02` row through the assembled store, and the double's answer to the same. */
  readonly duplicate: { readonly database: PortResult<null>; readonly double: PortResult<null> } | undefined;
}

async function runTwoLevelEntry(options: {
  readonly label: string;
  readonly delivery: "per-event" | "one-pump";
}): Promise<Run> {
  return await withFreshDatabase(postgres.getConnectionUri(), options.label, async ({ connectionString, context }) => {
    const registered = await registerThroughTheRepositories(context, options.label, {
      params: twoBracketsStrategyParams(),
    });
    const stream = uniqueStreamName(options.label);
    const document = twoBracketsDocument(registered, options.label, { eventStream: stream });
    const parsed = parseTraderConfig(document);
    if (!parsed.ok) throw new Error(`${parsed.refusal.code}: ${parsed.refusal.issues.join("; ")}`);
    const events = twoBracketsEvents(registered.marketId, `${CONDITION_ID}-${options.label}`, {
      bracket1Asks: TWO_LEVEL_BRACKET_1_YES_ASKS,
    });
    const first = events[0];
    if (first === undefined) throw new Error("the scenario lost its events");

    const manual =
      options.delivery === "per-event" ? new ManualClock(recordedInstant(first.envelope.receivedAt).instant) : undefined;
    const clock: Clock = manual ?? new SystemPaperClock();

    const lines: string[] = [];
    const assembled = await assembleDurableTrader({
      env: safeEnvironment(),
      config: parsed.config,
      document,
      postgresUrl: connectionString,
      clock,
      log: (line) => {
        lines.push(line);
      },
    });
    expect(assembled.ok ? "ok" : lines.join("\n")).toBe("ok");
    if (!assembled.ok) throw new Error("unreachable");
    const { trader, store } = assembled;
    const instanceId = registered.instanceId;

    const publisher = await RedisStreamsEventTransport.connect({
      connection: { url: redis.getConnectionUrl() },
      retention: { maxEvents: 10_000 },
    });
    const traderTransport = await RedisStreamsEventTransport.connect({
      connection: { url: redis.getConnectionUrl() },
      retention: { maxEvents: parsed.config.infrastructure.retentionMaxEvents },
    });
    const subscription = await traderTransport.subscribe({
      stream: parsed.config.infrastructure.eventStream,
      consumerId: parsed.config.infrastructure.consumerId,
    });
    const feed = positioningFeed(
      new RedisMarketEventFeed({ subscription, maxEvents: parsed.config.infrastructure.receiveBatchSize }),
      manual,
    );

    const pumps: PumpResult[] = [];
    let tracesAfterEntry: number | undefined;
    let rowAfterEntry: PnlSnapshot | undefined;
    try {
      if (options.delivery === "per-event") {
        for (const [index, event] of events.entries()) {
          await publisher.publish(stream, event.envelope);
          pumps.push(await pump({ loop: trader.loop, feed, halts: trader.halts, maxPolls: 4, untilIdle: true }));
          if (index === ENTRY_EVENT_INDEX) {
            tracesAfterEntry = trader.loop.traces().length;
            // The held state right after the entry's event: the §9.16 row it
            // makes at that instant, marked at the SECOND fill's price.
            const state = trader.loop.pnlState(instanceId);
            if (state === undefined) throw new Error("no held PnL state after the entry");
            const tokens = [...state.lots.keys()];
            expect(tokens).toHaveLength(1);
            const rows = computePnlSnapshot(state, {
              asOf: ENTRY_INSTANT,
              marks: { [tokens[0] ?? ""]: { midpoint: ENTRY_LAST_FILL_PRICE } },
            });
            if (!rows.ok) throw new Error("the in-memory state did not compute a row");
            expect(rows.value).toHaveLength(1);
            rowAfterEntry = rows.value[0];
          }
        }
      } else {
        for (const event of events) await publisher.publish(stream, event.envelope);
        pumps.push(await pump({ loop: trader.loop, feed, halts: trader.halts, maxPolls: 50, untilIdle: true }));
      }
      const rebuild = trader.loop.checkAccountingRebuild("SHUTDOWN");
      const health = trader.loop.health();

      // --- READ BACK: everything below is a SELECT --------------------------
      const decisions = await context.db
        .selectFrom("strategy.decisions")
        .selectAll()
        .where("run_id", "=", registered.runId)
        .orderBy("evaluation_seq")
        .execute();
      const checkpoints = await context.db
        .selectFrom("strategy.state_checkpoints")
        .selectAll()
        .where("run_id", "=", registered.runId)
        .orderBy("checkpoint_seq")
        .execute();
      const transactions = await context.db
        .selectFrom("accounting.ledger_transactions")
        .selectAll()
        .where("market_id", "=", registered.marketId)
        .orderBy("occurred_at")
        .orderBy("ledger_transaction_id")
        .execute();
      const transactionIds = transactions.map((row) => row.ledger_transaction_id);
      const entries =
        transactionIds.length === 0
          ? []
          : await context.db
              .selectFrom("accounting.ledger_entries")
              .selectAll()
              .where("ledger_transaction_id", "in", transactionIds)
              .execute();
      const snapshots = await context.db
        .selectFrom("accounting.pnl_snapshots")
        .selectAll()
        .where("run_id", "=", registered.runId)
        .orderBy("as_of")
        .execute();

      // The database's own answer to a second row of the kept identity, and the double's.
      let duplicate: Run["duplicate"];
      if (rowAfterEntry !== undefined) {
        const database = await store.writePnlSnapshot(rowAfterEntry);
        const memory = new MemoryTraderStore();
        await memory.writePnlSnapshot(rowAfterEntry);
        duplicate = { database, double: await memory.writePnlSnapshot(rowAfterEntry) };
      }

      return {
        instanceId,
        runId: registered.runId,
        marketId: registered.marketId,
        events,
        pumps,
        rebuildMatched: rebuild.matched,
        health,
        memory: {
          reasonCodes: trader.loop.decisions().map((decision) => [...decision.reasonCodes]),
          tracesAfterEntry,
          rowAfterEntry,
        },
        db: {
          decisions: decisions.map((row) => ({
            callback: row.callback,
            reasonCodes: [...row.reason_codes],
            evaluatedAt: row.evaluated_at,
          })),
          finalState: checkpoints.at(-1)?.state as unknown,
          transactions: transactions.map((row) => ({
            id: row.ledger_transaction_id,
            eventType: row.event_type,
            occurredAt: row.occurred_at,
          })),
          entries: entries.map((row) => ({
            transactionId: row.ledger_transaction_id,
            scope: row.scope,
            assetId: row.asset_id,
            amount: row.amount as unknown,
            instanceId: row.instance_id,
          })),
          snapshots: snapshots.map((row) => ({ ...row })),
        },
        duplicate,
      };
    } finally {
      await feed.close();
      await store.close();
      await traderTransport.close();
      await publisher.close();
    }
  });
}

/** The hand derivation's four rows, in `as_of` order. */
const EXPECTED_ROWS: readonly Readonly<Record<string, string>>[] = [
  { capital_committed: "17.2", realized_pnl: "0", unrealized_pnl_midpoint: "0.3", gross_trading_pnl: "0.3", core_net_pnl: "0.3", worst_case_resolution_pnl: "-17.2", fees_paid: "0" },
  { capital_committed: "0", realized_pnl: "-1.2", unrealized_pnl_midpoint: "0", gross_trading_pnl: "-1.2", core_net_pnl: "-1.2", worst_case_resolution_pnl: "-1.2", fees_paid: "0" },
  { capital_committed: "16.5", realized_pnl: "-1.2", unrealized_pnl_midpoint: "0", gross_trading_pnl: "-1.2", core_net_pnl: "-1.2", worst_case_resolution_pnl: "-17.7", fees_paid: "0" },
  { capital_committed: "0", realized_pnl: "7.3", unrealized_pnl_midpoint: "0", gross_trading_pnl: "7.3", core_net_pnl: "7.3", worst_case_resolution_pnl: "7.3", fees_paid: "0" },
];

/** Every assertion both delivery shapes share. */
function assertTwoLevelRoundTrip(run: Run): void {
  // --- no halt, and every event came through ---------------------------------
  expect(run.health.halts).toEqual([]);
  expect(run.health.healthy).toBe(true);
  expect(run.rebuildMatched).toBe(true);
  expect(run.health.loop.eventsProcessed).toBe(run.events.length);
  expect(run.health.accounting.ledgerRefusals).toBe(0);
  expect(run.health.accounting.unattributedActivity).toBe(0);

  // --- both entry fills booked: five fills, ten durable transactions ---------
  expect(run.health.execution.fillsObserved).toBe(5);
  expect(run.db.transactions).toHaveLength(10);
  expect(run.db.transactions).toHaveLength(run.health.accounting.ledgerTransactions);
  const at = (instant: string) => run.db.transactions.filter((row) => Date.parse(row.occurredAt) === Date.parse(instant));
  const entryTransactions = new Set(at(ENTRY_INSTANT).map((row) => row.id));
  expect(entryTransactions.size).toBe(4);
  const principal = new Set(
    run.db.transactions.filter((row) => row.eventType === "TRADE_PRINCIPAL").map((row) => row.id),
  );
  const virtualCash = run.db.entries.filter(
    (entry) => entry.scope === "VIRTUAL_STRATEGY" && entry.instanceId === run.instanceId && entry.assetId === "pUSD",
  );
  // The instance's principal legs at 12:00:02: one per level walked.
  expect(
    virtualCash
      .filter((entry) => entryTransactions.has(entry.transactionId) && principal.has(entry.transactionId))
      .map((entry) => entry.amount)
      .sort(),
  ).toEqual(["-10.2", "-7"]);
  expect(sumDecimals(virtualCash.map((entry) => entry.amount))).toBe("7.3");
  const virtualTokens = run.db.entries.filter(
    (entry) => entry.scope === "VIRTUAL_STRATEGY" && entry.instanceId === run.instanceId && entry.assetId !== "pUSD",
  );
  expect(sumDecimals(virtualTokens.map((entry) => entry.amount))).toBe("0");

  // --- ONE durable snapshot per instant with fills; exactly one at 12:00:02 --
  const asOf = run.db.snapshots.map((row) => row["as_of"]);
  expect(new Set(asOf).size).toBe(asOf.length);
  expect(run.db.snapshots).toHaveLength(4);
  expect(asOf.filter((instant) => instant === ENTRY_INSTANT)).toHaveLength(1);
  expect(asOf).toEqual([ENTRY_INSTANT, "2026-03-04T12:03:06Z", "2026-03-04T12:03:41Z", "2026-03-04T12:04:00Z"]);
  run.db.snapshots.forEach((row, index) => {
    const expected = EXPECTED_ROWS[index] ?? {};
    for (const [column, value] of Object.entries(expected)) {
      expect({ index, column, value: row[column] }).toEqual({ index, column, value });
    }
    expect(row["scope"]).toBe("VIRTUAL_STRATEGY");
    expect(row["environment"]).toBe("PAPER");
    expect(row["account_ref"]).toBe(ACCOUNT);
    expect(row["instance_id"]).toBe(run.instanceId);
    expect(row["run_id"]).toBe(run.runId);
    expect(row["market_id"]).toBe(run.marketId);
  });
  // Base's FIRST per-fill row at 12:00:02 — the state after `30 @ 0.34` alone — does not exist.
  expect(run.db.snapshots.some((row) => row["capital_committed"] === "10.2")).toBe(false);

  // --- the realized-PnL book (TRDR-3) is the last durable row ---------------
  expect(run.health.accounting.realizedPnl).toEqual({ byInstance: { [run.instanceId]: "7.3" }, account: "7.3" });

  // --- both entry fills were DELIVERED too: two onFill evaluations at 12:00:02
  // (observed on the first run: the take-profit is placed from the first, and
  // the second waits on the resize's cancel).
  expect(
    run.db.decisions
      .filter((row) => row.evaluatedAt === ENTRY_INSTANT && row.callback === "onFill")
      .map((row) => row.reasonCodes),
  ).toEqual([
    ["SB.ALLOCATION_CONFIRMED", "SB.TAKE_PROFIT_INTENT", "SB.EXIT_SIZED_TO_ALLOCATION"],
    ["SB.ALLOCATION_CONFIRMED", "SB.EXIT_ORDER_WORKING", "SB.AWAITING_CANCEL_CONFIRMATION"],
  ]);

  // --- the round trip completes: both brackets closed, then refused ---------
  expect(run.db.decisions.map((row) => row.reasonCodes)).toEqual(run.memory.reasonCodes);
  const closes = run.db.decisions.filter((row) => row.reasonCodes.includes("SB.CLOSED"));
  expect(closes.map((row) => row.callback)).toEqual(["onFill", "onFill"]);
  expect(closes.map((row) => row.evaluatedAt)).toEqual(["2026-03-04T12:03:06Z", "2026-03-04T12:04:00Z"]);
  expect(run.db.decisions).toHaveLength(20);
  expect(run.db.decisions.filter((row) => row.reasonCodes.includes("SB.REARMED")).map((row) => row.evaluatedAt)).toEqual([
    "2026-03-04T12:03:40Z",
  ]);
  expect(run.db.decisions.at(-1)?.reasonCodes).toEqual(["SB.REFUSED_MAXIMUM_ENTRIES"]);
  for (const row of run.db.decisions) {
    for (const code of FORBIDDEN_CODES) expect(row.reasonCodes).not.toContain(code);
  }
  const finalState = isRecord(run.db.finalState) ? run.db.finalState : {};
  expect({ instanceState: finalState["instanceState"], entriesExecuted: finalState["entriesExecuted"] }).toEqual({
    instanceState: "CLOSED",
    entriesExecuted: 2,
  });
}

describe("SNAP-1: an entry that walks two ask levels in one instant, durably, through PostgreSQL, Redis and the composition root", () => {
  it("event-time clock, one event per pump: no halt, both fills booked, ONE durable snapshot at 12:00:02 equal to the in-memory state after the second fill, and the round trip completes", async () => {
    const run = await runTwoLevelEntry({ label: "snap1-two-level", delivery: "per-event" });
    // First, so a regression names its halt (at base: STORE_UNAVAILABLE, pnl_snapshots_scope_unique).
    expect(run.health.halts).toEqual([]);
    expect(run.pumps).toEqual(run.events.map(() => ({ polls: 2, ingested: 1, stopped: "IDLE" })));
    assertTwoLevelRoundTrip(run);

    // Both fills of the entry were booked by the 12:00:02 event itself.
    expect(run.memory.tracesAfterEntry).toBe(2);
    // The one durable row at 12:00:02 IS the in-memory state after the second fill, column for column.
    const kept = run.db.snapshots[0] ?? {};
    const memory = run.memory.rowAfterEntry;
    expect(memory).toBeDefined();
    if (memory === undefined) return;
    for (const [column, field] of COLUMNS) {
      expect({ column, value: kept[column] }).toEqual({ column, value: memory[field] });
    }
    expect(kept["as_of"]).toBe(memory.asOf);

    // On this real PostgreSQL, a second row of that identity is refused — and
    // the in-memory double answers the SAME port data for the same duplicate.
    expect(run.duplicate).toBeDefined();
    expect(run.duplicate?.database.ok).toBe(false);
    expect(run.duplicate?.double).toEqual(run.duplicate?.database);
  }, 180_000);

  it("the process's own SystemPaperClock and ONE pump over the whole stream give the same durable run", async () => {
    const run = await runTwoLevelEntry({ label: "snap1-two-level-one-pump", delivery: "one-pump" });
    expect(run.health.halts).toEqual([]);
    expect(run.pumps).toEqual([{ polls: 2, ingested: run.events.length, stopped: "IDLE" }]);
    assertTwoLevelRoundTrip(run);
  }, 180_000);
});
