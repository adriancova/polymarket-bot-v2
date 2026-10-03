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
 * same key. Since `SNAP-1` r1 (`SNAP1-R1`), a LATER harvest at an instant
 * whose row the process already inserted REPLACES that row
 * (`PostgresTraderStore.replacePnlSnapshot`, one UPDATE on the key), so the
 * instant's one row holds the state after its last fill however many harvests
 * booked fills there.
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
 * (`0.34 x 30`, `0.35 x 300`) — F3, committed. Three tests: the event-time
 * clock with one event per pump (so the in-memory state right after the
 * `12:00:02` event can be captured); the process's own `SystemPaperClock`
 * with ONE pump over the whole stream; and (`SNAP-1` r1) the SHARED-INSTANT
 * shape — see below.
 *
 * **Dated correction (`CO2-N1`, ADR-031, 2026-10-03).** The trader's clock
 * now gates admission: an entry whose event is older than the features bound
 * at the clock's reading, or whose reading is inside the entry cutoff, is
 * refused. The one-pump test's `SystemPaperClock`, as-is, reads 2026-10
 * against these 2026-03-04 events and refused every entry; it now runs the
 * same host clock RE-BASED to the scenario's first event
 * (`support/host-clock.ts`): read live, advancing in real time, so the guard
 * measures the one pump's real processing delay and admits.
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
 * ## The shared-instant shape (`SNAP-1` r1, `SNAP1-R1`)
 *
 * Two HARVESTS at one instant, through the real path: the two-level
 * scenario's first ten events, with the take-profit's public trade (event 10)
 * received at `12:03:41.000Z` — bracket 2's entry instant — and the run
 * ENDING there (event 11 dropped), so no later event could carry a pending
 * row (the terminal case). Event 9's harvest inserts the `12:03:41` row
 * (capital `16.5`, realized `−1.2`, worst `−17.7`); the take-profit, placed
 * from that entry's `onFill`, fills from event 10's trade (the event-time
 * clock stamps both at the same nanosecond, and a resting order matches a
 * trade at or after its rest start); event 10's harvest REPLACES the row. At
 * the end there are THREE rows, and the `12:03:41` one — the same
 * `pnl_snapshot_id` and `computed_at` as after event 9 — holds the state after
 * the take-profit's fill: capital `0`, realized = gross = core net = worst
 * `7.3`, midpoint `0`, equal column for column to the in-memory held state's
 * row at that instant; the TRDR-3 book reads `7.3`. With the candidate
 * `de867f6`'s `loop.ts` this test FAILS with no halt: the row is still the
 * entry's (`capital_committed` `16.5`, measured). The same run holds the REAL
 * database's refusal of a replacement whose identity has no row against the
 * double's answer.
 *
 * ## What it does NOT prove (disclosed)
 *
 * Simulated execution (Tier-0 `SimulatedVenue`, fills
 * `SIMULATED_NOT_REAL_EVIDENCE`) over real PostgreSQL and Redis; envelopes this
 * suite builds, not the gateway's normalisation; not `startup()` itself; the
 * durable execution chain is still absent (`RECON2-DURABLE`). Instants that
 * go BACKWARDS are pinned in memory only (`apps/trader/src/loop-folds.test.ts`,
 * `SNAP-1` blocks): a resting take-profit cannot fill from a trade stamped
 * before its rest start, so this scenario cannot place one there. Not a soak,
 * not live evidence; §7 item 1 is graded by a fresh closeout.
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
import { MISSING_PNL_SNAPSHOT_DETAIL, ManualClock, MemoryTraderStore } from "@polymarket-bot/trader/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { RedisMarketEventFeed } from "../../../apps/trader/src/adapters/redis-feed.js";
import { assembleDurableTrader } from "../../../apps/trader/src/main.js";
import { pump } from "../../../apps/trader/src/pump.js";
import { safeEnvironment } from "./support/fixture.js";
import { RebasedSystemPaperClock } from "./support/host-clock.js";
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

/**
 * `SNAP-1` r1 (`SNAP1-R1`): bracket 2's entry instant, which the
 * shared-instant shape ALSO stamps on the take-profit's public trade — so two
 * harvests book fills of one instance at one instant — and the price of the
 * last fill there (the take-profit's).
 */
const SHARED_INSTANT = "2026-03-04T12:03:41Z";
const SHARED_INSTANT_LAST_FILL_PRICE = "0.5";
/** Indices of bracket 2's entry (the `12:03:41` NO book) and of the take-profit's trade. */
const BRACKET_2_ENTRY_INDEX = 8;
const TAKE_PROFIT_TRADE_INDEX = 9;

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

/** The same event, received at `receivedAt` (envelope and recorded identity alike). */
function restamped(event: IngestedEvent, receivedAt: string): IngestedEvent {
  return {
    envelope: { ...event.envelope, receivedAt },
    identity: { ...event.identity, receivedAt },
  };
}

/**
 * `SNAP-1` r1: the shared-instant shape — the two-level scenario's first ten
 * events, with the take-profit's trade (event 10) received at bracket 2's
 * entry instant (event 9's `12:03:41.000Z`) instead of `12:04:00`, and the run
 * ENDING there (event 11 dropped): the terminal case, where no later event
 * could carry a pending row.
 */
function sharedInstantEvents(events: readonly IngestedEvent[]): readonly IngestedEvent[] {
  const entry = events[BRACKET_2_ENTRY_INDEX];
  const trade = events[TAKE_PROFIT_TRADE_INDEX];
  if (entry === undefined || trade === undefined || trade.envelope.eventType !== "PublicTradeObserved") {
    throw new Error("the scenario lost bracket 2's entry or its take-profit trade");
  }
  return Object.freeze([
    ...events.slice(0, TAKE_PROFIT_TRADE_INDEX),
    restamped(trade, entry.envelope.receivedAt),
  ]);
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
  /**
   * `SNAP-1` r1, the shared-instant shape only: the durable `12:03:41` row
   * right after bracket 2's entry (its id and economics), the §9.16 row of the
   * in-memory held state right after the take-profit's fill at that same
   * instant, and a replacement of an identity with NO row through the
   * assembled store (the real database's answer, and the double's).
   */
  readonly sharedInstant:
    | {
        readonly rowAfterEntry: Readonly<Record<string, unknown>> | undefined;
        readonly rowAfterTakeProfit: PnlSnapshot | undefined;
        readonly missing: { readonly database: PortResult<null>; readonly double: PortResult<null> } | undefined;
      }
    | undefined;
}

async function runTwoLevelEntry(options: {
  readonly label: string;
  readonly delivery: "per-event" | "one-pump";
  /** `SNAP-1` r1: `shared-instant` re-stamps the take-profit's trade at 12:03:41 and ends the run there. */
  readonly shape?: "two-level" | "shared-instant";
}): Promise<Run> {
  return await withFreshDatabase(postgres.getConnectionUri(), options.label, async ({ connectionString, context }) => {
    const registered = await registerThroughTheRepositories(context, options.label, {
      params: twoBracketsStrategyParams(),
    });
    const stream = uniqueStreamName(options.label);
    const document = twoBracketsDocument(registered, options.label, { eventStream: stream });
    const parsed = parseTraderConfig(document);
    if (!parsed.ok) throw new Error(`${parsed.refusal.code}: ${parsed.refusal.issues.join("; ")}`);
    const twoLevel = twoBracketsEvents(registered.marketId, `${CONDITION_ID}-${options.label}`, {
      bracket1Asks: TWO_LEVEL_BRACKET_1_YES_ASKS,
    });
    const shared = options.shape === "shared-instant";
    const events = shared ? sharedInstantEvents(twoLevel) : twoLevel;
    const first = events[0];
    if (first === undefined) throw new Error("the scenario lost its events");

    const manual =
      options.delivery === "per-event" ? new ManualClock(recordedInstant(first.envelope.receivedAt).instant) : undefined;
    // `CO2-N1` (ADR-031): the host's clock, re-based to the first event.
    const clock: Clock = manual ?? new RebasedSystemPaperClock(first.envelope.receivedAt);

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
    let sharedRowAfterEntry: Readonly<Record<string, unknown>> | undefined;
    let rowAfterTakeProfit: PnlSnapshot | undefined;
    /** The instance's one traded token, read from its open lot at the entry (a flat state has no lot). */
    let tradedToken: string | undefined;
    /** The §9.16 row of the held state right now, at `asOf`, marked at `price`. */
    const heldRow = (asOf: string, price: string): PnlSnapshot | undefined => {
      const state = trader.loop.pnlState(instanceId);
      if (state === undefined) throw new Error("no held PnL state");
      const tokens = [...state.lots.keys()];
      if (tradedToken === undefined) {
        expect(tokens).toHaveLength(1);
        tradedToken = tokens[0];
      }
      expect(tokens.filter((token) => token !== tradedToken)).toEqual([]);
      const rows = computePnlSnapshot(state, { asOf, marks: { [tradedToken ?? ""]: { midpoint: price } } });
      if (!rows.ok) throw new Error("the in-memory state did not compute a row");
      expect(rows.value).toHaveLength(1);
      return rows.value[0];
    };
    try {
      if (options.delivery === "per-event") {
        for (const [index, event] of events.entries()) {
          await publisher.publish(stream, event.envelope);
          pumps.push(await pump({ loop: trader.loop, feed, halts: trader.halts, maxPolls: 4, untilIdle: true }));
          if (index === ENTRY_EVENT_INDEX) {
            tracesAfterEntry = trader.loop.traces().length;
            // The held state right after the entry's event: the §9.16 row it
            // makes at that instant, marked at the SECOND fill's price.
            rowAfterEntry = heldRow(ENTRY_INSTANT, ENTRY_LAST_FILL_PRICE);
          }
          if (shared && index === BRACKET_2_ENTRY_INDEX) {
            // The DURABLE row at 12:03:41 right after bracket 2's entry: a SELECT.
            const rows = await context.db
              .selectFrom("accounting.pnl_snapshots")
              .selectAll()
              .where("run_id", "=", registered.runId)
              .where("as_of", "=", SHARED_INSTANT)
              .execute();
            expect(rows).toHaveLength(1);
            sharedRowAfterEntry = rows[0] === undefined ? undefined : { ...rows[0] };
          }
          if (shared && index === TAKE_PROFIT_TRADE_INDEX) {
            // The held state right after the take-profit's fill, at the SAME instant.
            rowAfterTakeProfit = heldRow(SHARED_INSTANT, SHARED_INSTANT_LAST_FILL_PRICE);
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

      // `SNAP-1` r1: the real database's answer to a replacement of an
      // identity with NO row (an instant the run never reached), and the
      // double's.
      let missing: { database: PortResult<null>; double: PortResult<null> } | undefined;
      if (shared && rowAfterTakeProfit !== undefined) {
        const nowhere = { ...rowAfterTakeProfit, asOf: "2026-03-04T12:05:00Z" };
        missing = {
          database: await store.replacePnlSnapshot(nowhere),
          double: await new MemoryTraderStore().replacePnlSnapshot(nowhere),
        };
        const after = await context.db
          .selectFrom("accounting.pnl_snapshots")
          .select("as_of")
          .where("run_id", "=", registered.runId)
          .execute();
        // Refused, and nothing was inserted in its place.
        expect(after).toHaveLength(snapshots.length);
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
        sharedInstant: shared ? { rowAfterEntry: sharedRowAfterEntry, rowAfterTakeProfit, missing } : undefined,
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

  it("SNAP1-R1: TWO harvests at one instant — bracket 2's entry and its take-profit's fill, both at 12:03:41, the run ending there — leave ONE durable row at 12:03:41 holding the state after the LAST fill, replaced in place; the TRDR-3 book reads it", async () => {
    const run = await runTwoLevelEntry({ label: "snap1-shared-instant", delivery: "per-event", shape: "shared-instant" });
    expect(run.health.halts).toEqual([]);
    expect(run.health.healthy).toBe(true);
    expect(run.pumps).toEqual(run.events.map(() => ({ polls: 2, ingested: 1, stopped: "IDLE" })));
    expect(run.events).toHaveLength(10);
    expect(run.events.at(-1)?.envelope.eventType).toBe("PublicTradeObserved");
    expect(run.events.at(-1)?.envelope.receivedAt).toBe(run.events.at(-2)?.envelope.receivedAt);
    expect(run.rebuildMatched).toBe(true);
    expect(run.health.loop.eventsProcessed).toBe(10);
    // Every fill booked — the take-profit's included — and nothing refused.
    expect(run.health.execution.fillsObserved).toBe(5);
    expect(run.db.transactions).toHaveLength(10);
    expect(run.health.accounting.ledgerRefusals).toBe(0);

    // Right after bracket 2's entry, the durable 12:03:41 row held the entry's state…
    const before = run.sharedInstant?.rowAfterEntry ?? {};
    for (const [column, value] of Object.entries(EXPECTED_ROWS[2] ?? {})) {
      expect({ column, value: before[column] }).toEqual({ column, value });
    }
    // …and at the end of the run the SAME row (same id, same computed_at: an UPDATE, not a
    // second row) holds the state after the take-profit's fill — the last fill at 12:03:41.
    const asOf = run.db.snapshots.map((row) => row["as_of"]);
    expect(asOf).toEqual([ENTRY_INSTANT, "2026-03-04T12:03:06Z", SHARED_INSTANT]);
    const kept = run.db.snapshots[2] ?? {};
    expect(kept["pnl_snapshot_id"]).toBe(before["pnl_snapshot_id"]);
    expect(kept["computed_at"]).toEqual(before["computed_at"]);
    for (const [column, value] of Object.entries(EXPECTED_ROWS[3] ?? {})) {
      expect({ column, value: kept[column] }).toEqual({ column, value });
    }
    const memory = run.sharedInstant?.rowAfterTakeProfit;
    expect(memory).toBeDefined();
    if (memory === undefined) return;
    for (const [column, field] of COLUMNS) {
      expect({ column, value: kept[column] }).toEqual({ column, value: memory[field] });
    }
    expect(kept["as_of"]).toBe(memory.asOf);
    // The two rows before it are the two-level run's own, unchanged.
    run.db.snapshots.slice(0, 2).forEach((row, index) => {
      for (const [column, value] of Object.entries(EXPECTED_ROWS[index] ?? {})) {
        expect({ index, column, value: row[column] }).toEqual({ index, column, value });
      }
    });

    // TRDR-3: the realized-PnL book is the replaced row's, not the entry's -1.2.
    expect(run.health.accounting.realizedPnl).toEqual({ byInstance: { [run.instanceId]: "7.3" }, account: "7.3" });

    // The round trip still completes: bracket 2 closes on the take-profit's onFill AT 12:03:41.
    const closes = run.db.decisions.filter((row) => row.reasonCodes.includes("SB.CLOSED"));
    expect(closes.map((row) => [row.callback, row.evaluatedAt])).toEqual([
      ["onFill", "2026-03-04T12:03:06Z"],
      ["onFill", SHARED_INSTANT],
    ]);
    expect(run.db.decisions.map((row) => row.reasonCodes)).toEqual(run.memory.reasonCodes);
    const finalState = isRecord(run.db.finalState) ? run.db.finalState : {};
    expect({ instanceState: finalState["instanceState"], entriesExecuted: finalState["entriesExecuted"] }).toEqual({
      instanceState: "CLOSED",
      entriesExecuted: 2,
    });

    // The real database refuses a replacement of an identity with NO row — and the
    // in-memory double answers the SAME port data.
    const missing = run.sharedInstant?.missing;
    expect(missing).toBeDefined();
    expect(missing?.database).toEqual({ ok: false, failure: { kind: "UNAVAILABLE", detail: MISSING_PNL_SNAPSHOT_DETAIL } });
    expect(missing?.double).toEqual(missing?.database);
  }, 180_000);

  it("the process's own SystemPaperClock (re-based to the first event, ADR-031) and ONE pump over the whole stream give the same durable run", async () => {
    const run = await runTwoLevelEntry({ label: "snap1-two-level-one-pump", delivery: "one-pump" });
    expect(run.health.halts).toEqual([]);
    expect(run.pumps).toEqual([{ polls: 2, ingested: run.events.length, stopped: "IDLE" }]);
    assertTwoLevelRoundTrip(run);
  }, 180_000);
});
