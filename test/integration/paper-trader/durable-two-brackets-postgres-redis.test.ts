/**
 * `BRACKET-1c` — one whole TWO-BRACKET round trip through real infrastructure:
 * the REAL composition root, a REAL PostgreSQL and a REAL Redis stream (§7
 * checklist item 1, ruling R1; `GOV-2B`'s reason for NOT MET was "what works
 * end to end is the all-doubles harness").
 *
 * ## What runs
 *
 * - The operator's registration act through `WP-040`'s repositories
 *   (`support/registration.ts`, exactly as `BOOT-1` does; no
 *   `createTradingChain`), with the params the run uses.
 * - `assembleDurableTrader` — the process's own steps 3b and 4: the
 *   `PostgresTraderStore` on a Testcontainers PostgreSQL, the registration
 *   check, the `SimulatedVenue`, `createPaperTrader`, the realized-PnL
 *   observer (`TRDR-3`).
 * - Every event travels through a Testcontainers Redis stream: published by a
 *   `RedisStreamsEventTransport` (the gateway's publisher binding, as the
 *   `UNIV-4` file uses it) and consumed by the process's own
 *   `RedisMarketEventFeed` over its own subscription, driven by the process's
 *   own `pump`, then the SHUTDOWN rebuild check (`startup()` step 5b).
 * - The scenario is `BRACKET-1b`'s shape (`support/two-brackets.ts`): bracket 1
 *   closed by a NON-cutoff protective reduce (the holding timeout), `SB.REARMED`
 *   after the cooldown, bracket 2 closed by its onFill take-profit FILLED as a
 *   MAKER by a public trade, then `SB.REFUSED_MAXIMUM_ENTRIES`.
 *
 * ## The clock, exactly — and why it is not what makes time pass
 *
 * The packet asked for a controllable clock advanced to each event's time
 * before the loop reads it, on the premise that the 180 s holding timeout and
 * the 30 s cooldown "cannot be waited out in real time". The first half is
 * done; the premise is corrected, because the code says otherwise:
 *
 * - The loop's instant is the ENVELOPE's recorded `receivedAt`
 *   (`apps/trader/src/loop.ts`, `#processEvent`: `#lastInstant` is
 *   `normalizeToStrictUtc(envelope.receivedAt)`), and that instant is what the
 *   strategy's holding timeout and cooldown are measured in. It travels through
 *   Redis inside the envelope. Nothing waits in real time.
 * - The §12.1 `Clock` supplies only the instant before the first event
 *   (`clock.now()`, once, at construction) and MONOTONIC nanoseconds: the
 *   runtime watchdog, and the simulated venue's rest-start stamp and
 *   observed-trade stamp — a resting order fills from a trade only when the
 *   trade's stamp is not EARLIER than its rest start (`packages/simulation`
 *   `venue.ts`, `monotonicNs < record.restingFromNs`).
 *
 * So the main test positions a `ManualClock` at each delivered event's
 * `receivedAt` (monotonic = its epoch milliseconds × 10^6) inside a feed
 * wrapper, as `pump` receives the event and BEFORE `drain` processes it — the
 * events are published one at a time and pumped until idle, and the wrapper
 * REFUSES a batch of more than one, so "before the loop reads it" holds per
 * event. The contrast test runs the process's own `SystemPaperClock`, publishes
 * all eleven events first and pumps ONCE over the whole batch, as `startup()`
 * would: the durable run is identical. The pins that the reduce is caused by
 * `SB.HOLDING_TIMEOUT` at `12:03:06`, the cancel at `12:03:05` and
 * `SB.REARMED` at `12:03:40` are therefore pins on RECORDED time as it came
 * through Redis.
 *
 * Non-vacuity, measured by temporary edits restored byte for byte (the
 * `BRACKET-1c` handoff has the commands and outputs):
 *
 * - one event (the `12:03:05` book) published to ANOTHER stream: both
 *   Redis-path tests fail (the per-event run observes 2 fills, not 4; the
 *   one-pump run ingests 10 events, not 11);
 * - the clock NEVER advanced: all three tests still PASS — the clock does not
 *   carry strategy time (above);
 * - a clock whose monotonic time runs BACKWARDS: both event-time tests fail
 *   (3 fills, not 4 — by the venue rule above, bracket 2's take-profit rests
 *   from a later stamp than the trade's); the `SystemPaperClock` test passes;
 * - the `12:03:05` book's `receivedAt` moved to `12:03:01` (inside the 180 s
 *   window): all three tests fail, the system-clock one included;
 * - `accounting.pnl_snapshots.realized_pnl` renamed after bracket 1 closes:
 *   the trader GLOBAL-halts `STORE_UNAVAILABLE` at bracket 2's entry fill
 *   (`column "realized_pnl" of relation "pnl_snapshots" does not exist`) and
 *   the test fails on `halts` — a B1-class writer defect past the first fill is
 *   caught here.
 *
 * ## Hand derivation (written before the first run)
 *
 * Fixture schedule: taker and maker fee rate `0`. Sizes 50 shares.
 *
 * | Step | Instant | What | Cash (instance) |
 * | --- | --- | --- | ---: |
 * | arm | 12:00:01 | `SB.ARMED` | |
 * | entry 1 | 12:00:02 | BUY 50 @ 0.34 (TAKER, first ask level `0.34 x 200`); TP SELL 50 @ 0.5 placed from onFill | −17 |
 * | timeout | 12:03:05 | 183 s ≥ 180 s after the fill: TP withdrawn (`SB.HOLDING_TIMEOUT`, `SB.SAFETY_CANCEL`) | |
 * | reduce | 12:03:06 | `SB.PROTECTED_REDUCE` SELL 50 @ 0.32 (first bid level `0.32 x 200`) → `SB.EXIT_FILLED`, `SB.CLOSED` | +16 |
 * | rearm | 12:03:40 | 34 s ≥ 30 s after the close: `SB.REARMED` | |
 * | entry 2 | 12:03:41 | BUY 50 @ 0.33 (first ask level `0.33 x 200`); TP placed from onFill (no source event) | −16.5 |
 * | TP fill | 12:04:00 | public trade `0.5 x 60` fills the TP as MAKER, fee 0 → `SB.EXIT_FILLED`, `SB.CLOSED` | +25 |
 * | end | 12:04:10 | `SB.REFUSED_MAXIMUM_ENTRIES` | |
 *
 * - Realized PnL per snapshot (one per fill, in fill order):
 *   `0`, `16 − 17 = −1`, `−1`, `−1 + (25 − 16.5) = 7.5`.
 * - Fees paid: `0` throughout; so net = realized = `7.5`, and the instance's
 *   durable `pUSD` entries sum to `−17 + 16 − 16.5 + 25 = 7.5` (`−1` at the
 *   bracket boundary), its YES-token entries to `0` (flat) at both.
 * - The other §9.16 columns per snapshot (added by `SNAP-1`, the
 *   `BR1C-R1-L1` ride-along; re-derived, and pinned below). Each row is
 *   marked at its own fill's price, so an open lot's midpoint PnL is
 *   `50 × price − cost = 0`:
 *   capital committed (the open cost basis) `17, 0, 16.5, 0`; gross trading
 *   PnL (realized + midpoint) `0, −1, −1, 7.5`; core net PnL (gross − fees)
 *   `0, −1, −1, 7.5`; worst-case resolution PnL (realized − open basis)
 *   `0 − 17 = −17`, `−1`, `−1 − 16.5 = −17.5`, `7.5`.
 * - Ledger transactions: `TRADE_PRINCIPAL` + an outcome-token movement per
 *   fill, and NO `PLATFORM_FEE` (none is posted for a zero fee):
 *   2 + 2 + 2 + 2 = **8**, not `BRACKET-1b`'s 11.
 *
 * The e2e-fee variant (a disclosed SECOND delta: taker `0.0195`, maker `0`,
 * 3 places HALF_UP; fee = shares × rate × p × (1 − p)):
 * entry 1 `50 × 0.0195 × 0.34 × 0.66 = 0.21879 → 0.219`; reduce
 * `50 × 0.0195 × 0.32 × 0.68 = 0.21216 → 0.212`; entry 2
 * `50 × 0.0195 × 0.33 × 0.67 = 0.2155725 → 0.216`; TP (maker) `0`. Fees paid
 * `0.219, 0.431, 0.647, 0.647`; realized unchanged (`0, −1, −1, 7.5`); net
 * `7.5 − 0.647 = 6.853` (`−1.431` at the boundary); ledger
 * 3 + 3 + 3 + 2 = **11** — `BRACKET-1b`'s numbers, since the prices and sizes
 * are 1b's. Per snapshot: core net `−0.219, −1.431, −1.647, 6.853`; capital
 * committed, gross and worst case as on the fixture schedule (fees enter
 * neither).
 *
 * ## What this file proves
 *
 * Every durable write the trader makes PAST its first fill — the exit fill's
 * postings, the realized-PnL snapshots, the CLOSED and REARMED checkpoints, the
 * second bracket's decisions and postings, the fee postings (variant) — lands
 * in PostgreSQL and READS BACK equal to the in-memory run, to the `BRACKET-1b`
 * golden's decision shape and to the hand derivation above, with no halt.
 * Every durable claim below is a SELECT, not a read of the loop's memory.
 *
 * ## What it does NOT prove (disclosed)
 *
 * - No live venue, no live data: the venue is `packages/simulation`'s
 *   `SimulatedVenue` at Tier 0 (fills `SIMULATED_NOT_REAL_EVIDENCE`), and the
 *   events are envelopes this suite builds. The gateway's normalisation is NOT
 *   exercised here (`univ-4-gateway-opens-trader-redis.test.ts` exercises it
 *   for `MarketOpened` and books); the publisher is the gateway's transport,
 *   not the gateway.
 * - Test-owned pieces remain in the path: the `ManualClock` (main test; the
 *   contrast uses the process's own clock) and the feed wrapper that positions
 *   it and records deliveries. Not `startup()` itself: no config-file read,
 *   no `REDIS_URL`/`DATABASE_URL`, and `pump` is called per event (main) or
 *   once until idle (contrast) rather than until a halt.
 * - §6 invariant 4's DURABLE execution chain is still absent
 *   (`RECON2-DURABLE`): no `execution.*` row is written, and every durable
 *   ledger transaction's `fill_id`/`order_id` is NULL — pinned below with the
 *   same meaning as `durable-trader-first-fill-postgres.test.ts`'s pair.
 * - Each entry fills in ONE level by construction (`BRACKET1-TPRACE` is
 *   unreachable), so two fills of one instance at one recorded instant never
 *   occur here. When they did, the durable path FAILED, measured and REPORTED
 *   by `BRACKET-1c` (`BRACKET1C-SNAPKEY`), not fixed here (it lay in
 *   `apps/**`/`db/**`, outside this round's grant): `loop.ts` wrote one PnL
 *   snapshot per fill at the event's instant, and `accounting.pnl_snapshots`
 *   is unique on `(scope, environment, account_ref, instance_id, market_id,
 *   as_of)`. So an entry that walked two ask levels — the ORIGINAL paper-e2e
 *   golden's shape — halted on its second fill: `STORE_UNAVAILABLE … duplicate
 *   key value violates unique constraint "pnl_snapshots_scope_unique"`, and
 *   the in-memory store, enforcing no such key, masked it.
 *   **Dated correction (`SNAP-1`, 2026-09-28): fixed.** Under the user's
 *   ruling "one snapshot per instance per instant" the loop computes the row
 *   at every fill as before and writes, once per harvest, the row of each
 *   instance's LAST fill at that instant (a later harvest at an instant
 *   already written REPLACES that row, `SNAP-1` r1); `MemoryTraderStore`
 *   now enforces the same key. The two-level entry is a committed test in
 *   `durable-two-level-entry-postgres-redis.test.ts` (this file's scenario
 *   with bracket 1's first ask thinned to `0.34 x 30`: no halt, ONE durable
 *   row at `12:00:02`; and a variant with two harvests at `12:03:41`). This
 *   file's assertions are unchanged by it — one fill per instant, so one row
 *   per fill is still one row per instant.
 * - It is not a soak and not live evidence, and it does not close §7 item 1:
 *   a fresh read-only closeout grades that.
 *
 * ## Docker
 *
 * Testcontainers, as the other container files: this file's own `beforeAll`
 * starts one PostgreSQL and one Redis; no `globalSetup`; no skip when Docker is
 * absent. Throwaway credentials that live only for the run (§0.2, ADR-010);
 * `environment` is `PAPER` throughout; no venue, no signer, no real order.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { addDecimal } from "@polymarket-bot/decimal";
import { RedisStreamsEventTransport } from "@polymarket-bot/event-bus";
import { startRedisContainer, uniqueStreamName } from "@polymarket-bot/event-bus/testing";
import { startPostgresContainer } from "@polymarket-bot/storage-postgres/testing";
import { canonicalJsonStringify } from "@polymarket-bot/strategy-runtime";
import {
  normalizeToStrictUtc,
  parseTraderConfig,
  type Clock,
  type IngestedEvent,
  type LoopHealthSnapshot,
  type MarketEventFeed,
  type PumpResult,
} from "@polymarket-bot/trader";
import { ManualClock } from "@polymarket-bot/trader/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { RedisMarketEventFeed } from "../../../apps/trader/src/adapters/redis-feed.js";
import { assembleDurableTrader, SystemPaperClock } from "../../../apps/trader/src/main.js";
import { pump } from "../../../apps/trader/src/pump.js";
import { T_OPEN, safeEnvironment } from "./support/fixture.js";
import {
  ACCOUNT,
  CONDITION_ID,
  registerThroughTheRepositories,
  withFreshDatabase,
} from "./support/registration.js";
import {
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

// ---------------------------------------------------------------------------
// The BRACKET-1b golden, READ (never written) for its decision shape
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const GOLDEN_PATH = resolve(here, "../../replay-golden/paper-e2e/two-brackets-run.json");
/** The e2e scenario's market open; every golden instant is this plus an offset. */
const GOLDEN_T_OPEN = "2026-05-01T09:00:00.000Z";

interface GoldenDecision {
  readonly callback: string;
  readonly decisionType: string;
  readonly reasonCodes: readonly string[];
  readonly evaluatedAt: string;
  readonly sourceEventId: string | null;
}

interface Golden {
  readonly decisions: readonly GoldenDecision[];
  readonly pnlSnapshots: readonly Readonly<Record<string, unknown>>[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads the golden through a narrow door, so a reshaped file fails loudly here. */
function readGolden(): Golden {
  const parsed: unknown = JSON.parse(readFileSync(GOLDEN_PATH, "utf8"));
  if (!isRecord(parsed) || !Array.isArray(parsed["decisions"]) || !Array.isArray(parsed["pnlSnapshots"])) {
    throw new Error(`${GOLDEN_PATH}: no decisions/pnlSnapshots arrays`);
  }
  const decisions = parsed["decisions"].map((entry: unknown, index): GoldenDecision => {
    if (
      !isRecord(entry) ||
      typeof entry["callback"] !== "string" ||
      typeof entry["decisionType"] !== "string" ||
      !Array.isArray(entry["reasonCodes"]) ||
      !entry["reasonCodes"].every((code: unknown) => typeof code === "string") ||
      typeof entry["evaluatedAt"] !== "string" ||
      !(entry["sourceEventId"] === null || typeof entry["sourceEventId"] === "string")
    ) {
      throw new Error(`${GOLDEN_PATH}: decisions[${String(index)}] is not a decision`);
    }
    return {
      callback: entry["callback"],
      decisionType: entry["decisionType"],
      reasonCodes: entry["reasonCodes"] as readonly string[],
      evaluatedAt: entry["evaluatedAt"],
      sourceEventId: entry["sourceEventId"],
    };
  });
  const pnlSnapshots = parsed["pnlSnapshots"].map((entry: unknown, index) => {
    if (!isRecord(entry)) throw new Error(`${GOLDEN_PATH}: pnlSnapshots[${String(index)}]`);
    return entry;
  });
  return { decisions, pnlSnapshots };
}

/** Milliseconds from a market's open. Instants only — never an economic value. */
function offsetMs(instant: string, open: string): number {
  return Date.parse(instant) - Date.parse(open);
}

// ---------------------------------------------------------------------------
// The clock, and the feed wrapper that positions it
// ---------------------------------------------------------------------------

/** The strict-UTC instant and its epoch milliseconds, as the loop itself reads `receivedAt`. */
function recordedInstant(receivedAt: string): { readonly instant: string; readonly epochMs: number } {
  const normalized = normalizeToStrictUtc(receivedAt);
  if (!normalized.ok) throw new Error(`unreadable receivedAt ${receivedAt}: ${normalized.problem}`);
  return { instant: normalized.instant, epochMs: normalized.epochMs };
}

/** Positions a `ManualClock` at a recorded instant; monotonic = epoch ms × 10^6. */
function positionAt(clock: ManualClock, receivedAt: string): string {
  const { instant, epochMs } = recordedInstant(receivedAt);
  clock.positionAt(instant, BigInt(epochMs) * 1_000_000n);
  return instant;
}

/**
 * The process's own feed, wrapped: records what it delivered and, when given
 * an event-time clock, positions it at each delivered event BEFORE `pump`
 * hands the batch to the loop. A batch of more than one event cannot be
 * positioned per event, so it is REFUSED loudly rather than stamped with one
 * instant.
 */
function observedFeed(
  feed: RedisMarketEventFeed,
  clock: ManualClock | undefined,
): { readonly feed: MarketEventFeed; readonly delivered: IngestedEvent[]; readonly positions: string[] } {
  const delivered: IngestedEvent[] = [];
  const positions: string[] = [];
  return {
    delivered,
    positions,
    feed: {
      poll: async () => {
        const result = await feed.poll();
        if (!result.ok) return result;
        if (clock !== undefined && result.value.length > 1) {
          throw new Error(
            `the event-time clock positions at ONE event per poll; the feed delivered ` +
              `${String(result.value.length)} — publish one event, then pump`,
          );
        }
        for (const event of result.value) {
          if (clock !== undefined) positions.push(positionAt(clock, event.envelope.receivedAt));
          delivered.push(event);
        }
        return result;
      },
      commit: () => feed.commit(),
      close: () => feed.close(),
    },
  };
}

// ---------------------------------------------------------------------------
// One durable run, and everything it left in PostgreSQL
// ---------------------------------------------------------------------------

interface RunOptions {
  readonly label: string;
  /** `event-time`: a ManualClock positioned per event; `system`: the process's own clock. */
  readonly clock: "event-time" | "system";
  /** `per-event`: publish one, pump until idle, repeat; `one-pump`: publish all, pump once. */
  readonly delivery: "per-event" | "one-pump";
  readonly feeSchedule: "fixture" | "e2e";
}

interface DurableRun {
  readonly marketId: string;
  readonly instanceId: string;
  readonly runId: string;
  readonly events: readonly IngestedEvent[];
  readonly delivered: readonly IngestedEvent[];
  readonly positions: readonly string[];
  readonly pumps: readonly PumpResult[];
  readonly rebuildMatched: boolean;
  readonly health: LoopHealthSnapshot;
  readonly memory: {
    readonly reasonCodes: readonly (readonly string[])[];
    readonly sourceEventIds: readonly (string | null)[];
    readonly ledgerTransactionsPerFill: readonly number[];
    /** In-memory realized PnL right after the event that closed each bracket (per-event runs only). */
    readonly realizedAfterBracket1: string | undefined;
    readonly realizedAfterBracket2: string | undefined;
  };
  readonly db: {
    readonly decisions: readonly {
      readonly evaluationSeq: string;
      readonly callback: string;
      readonly decisionType: string;
      readonly reasonCodes: readonly string[];
      readonly sourceEventId: string | null;
      readonly evaluatedAt: string;
      readonly instanceId: string;
      readonly marketId: string | null;
    }[];
    readonly checkpoints: readonly {
      readonly checkpointSeq: string;
      readonly capturedAt: string;
      readonly stateHash: string;
      readonly state: unknown;
      readonly instanceId: string;
    }[];
    readonly transactions: readonly {
      readonly id: string;
      readonly eventType: string;
      readonly environment: string;
      readonly accountRef: string;
      readonly marketId: string | null;
      readonly fillId: string | null;
      readonly orderId: string | null;
      readonly occurredAt: string;
    }[];
    readonly allTransactionCount: number;
    readonly entries: readonly {
      readonly transactionId: string;
      readonly scope: string;
      readonly accountRef: string;
      readonly assetId: string;
      readonly assetKind: string;
      readonly amount: unknown;
      readonly instanceId: string | null;
      readonly runId: string | null;
      readonly marketId: string | null;
    }[];
    readonly snapshots: readonly Readonly<Record<string, unknown>>[];
    readonly executionFills: number;
    /** The registered `strategy.configs` row's parameters, as stored. */
    readonly configParameters: unknown;
  };
}

/** The instance's in-memory realized trading PnL in `pUSD`, from the loop's held PnL state. */
function realizedInMemory(
  trader: { readonly loop: { pnlState(instanceId: string): { readonly realizedTrading: ReadonlyMap<string, string> } | undefined } },
  instanceId: string,
): string | undefined {
  return trader.loop.pnlState(instanceId)?.realizedTrading.get("pUSD");
}

async function runDurableTwoBrackets(options: RunOptions): Promise<DurableRun> {
  return await withFreshDatabase(postgres.getConnectionUri(), options.label, async ({ connectionString, context }) => {
    const registered = await registerThroughTheRepositories(context, options.label, {
      params: twoBracketsStrategyParams(),
    });
    const stream = uniqueStreamName(options.label);
    const document = twoBracketsDocument(registered, options.label, {
      eventStream: stream,
      feeSchedule: options.feeSchedule,
    });
    const parsed = parseTraderConfig(document);
    if (!parsed.ok) throw new Error(`${parsed.refusal.code}: ${parsed.refusal.issues.join("; ")}`);
    const events = twoBracketsEvents(registered.marketId, `${CONDITION_ID}-${options.label}`);
    const first = events[0];
    if (first === undefined) throw new Error("the scenario lost its events");

    const manual =
      options.clock === "event-time" ? new ManualClock(recordedInstant(first.envelope.receivedAt).instant) : undefined;
    if (manual !== undefined) positionAt(manual, first.envelope.receivedAt);
    const clock: Clock = manual ?? new SystemPaperClock();

    // --- the process's steps 3b + 4 against the registered database ---------
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

    // --- the gateway's publisher binding, and the process's own feed --------
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
    const observed = observedFeed(
      new RedisMarketEventFeed({ subscription, maxEvents: parsed.config.infrastructure.receiveBatchSize }),
      manual,
    );

    const pumps: PumpResult[] = [];
    let realizedAfterBracket1: string | undefined;
    let realizedAfterBracket2: string | undefined;
    try {
      if (options.delivery === "per-event") {
        for (const [index, event] of events.entries()) {
          await publisher.publish(stream, event.envelope);
          pumps.push(
            await pump({ loop: trader.loop, feed: observed.feed, halts: trader.halts, maxPolls: 4, untilIdle: true }),
          );
          // Event 7 (12:03:06) closes bracket 1; event 10 (12:04:00) closes bracket 2.
          if (index === 6) realizedAfterBracket1 = realizedInMemory(trader, instanceId);
          if (index === 9) realizedAfterBracket2 = realizedInMemory(trader, instanceId);
        }
      } else {
        for (const event of events) await publisher.publish(stream, event.envelope);
        pumps.push(
          await pump({ loop: trader.loop, feed: observed.feed, halts: trader.halts, maxPolls: 50, untilIdle: true }),
        );
      }
      // `startup()` step 5b: the SHUTDOWN rebuild check once the pump stops.
      const rebuild = trader.loop.checkAccountingRebuild("SHUTDOWN");
      const health = trader.loop.health();
      const memoryDecisions = trader.loop.decisions();

      // --- READ BACK: everything below is a SELECT ---------------------------
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
      const allTransactions = await context.db.selectFrom("accounting.ledger_transactions").selectAll().execute();
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
      const executionFills = await context.db.selectFrom("execution.fills").selectAll().execute();
      const config = await context.db
        .selectFrom("strategy.configs")
        .select("parameters")
        .where("config_id", "=", registered.configId)
        .executeTakeFirstOrThrow();

      return {
        marketId: registered.marketId,
        instanceId,
        runId: registered.runId,
        events,
        delivered: observed.delivered,
        positions: observed.positions,
        pumps,
        rebuildMatched: rebuild.matched,
        health,
        memory: {
          reasonCodes: memoryDecisions.map((decision) => [...decision.reasonCodes]),
          sourceEventIds: memoryDecisions.map((decision) =>
            decision.sourceEventId === "" ? null : decision.sourceEventId,
          ),
          ledgerTransactionsPerFill: trader.loop.traces().map((trace) => trace.ledgerTransactionIds.length),
          realizedAfterBracket1,
          realizedAfterBracket2,
        },
        db: {
          decisions: decisions.map((row) => ({
            evaluationSeq: String(row.evaluation_seq),
            callback: row.callback,
            decisionType: row.decision_type,
            reasonCodes: [...row.reason_codes],
            sourceEventId: row.source_event_id,
            evaluatedAt: row.evaluated_at,
            instanceId: row.instance_id,
            marketId: row.market_id,
          })),
          checkpoints: checkpoints.map((row) => ({
            checkpointSeq: String(row.checkpoint_seq),
            capturedAt: row.captured_at,
            stateHash: row.state_hash,
            state: row.state as unknown,
            instanceId: row.instance_id,
          })),
          transactions: transactions.map((row) => ({
            id: row.ledger_transaction_id,
            eventType: row.event_type,
            environment: row.environment,
            accountRef: row.account_ref,
            marketId: row.market_id,
            fillId: row.fill_id,
            orderId: row.order_id,
            occurredAt: row.occurred_at,
          })),
          allTransactionCount: allTransactions.length,
          entries: entries.map((row) => ({
            transactionId: row.ledger_transaction_id,
            scope: row.scope,
            accountRef: row.account_ref,
            assetId: row.asset_id,
            assetKind: row.asset_kind,
            amount: row.amount as unknown,
            instanceId: row.instance_id,
            runId: row.run_id,
            marketId: row.market_id,
          })),
          snapshots: snapshots.map((row) => ({ ...row })),
          executionFills: executionFills.length,
          configParameters: config.parameters as unknown,
        },
      };
    } finally {
      await observed.feed.close();
      await store.close();
      await traderTransport.close();
      await publisher.close();
    }
  });
}

// ---------------------------------------------------------------------------
// The expectations: the hand derivation above, as data
// ---------------------------------------------------------------------------

interface Economics {
  readonly ledgerTransactionsPerFill: readonly number[];
  readonly eventTypes: Readonly<Record<string, number>>;
  readonly realizedPerSnapshot: readonly string[];
  readonly feesPaidPerSnapshot: readonly string[];
  /** `SNAP-1` (`BR1C-R1-L1`): the other §9.16 columns per snapshot, derived in the header. */
  readonly coreNetPerSnapshot: readonly string[];
  readonly grossTradingPerSnapshot: readonly string[];
  readonly capitalCommittedPerSnapshot: readonly string[];
  readonly worstCasePerSnapshot: readonly string[];
  /** The instance's durable `pUSD` entries summed at the bracket boundary and at the end. */
  readonly cashAtBoundary: string;
  readonly cashAtEnd: string;
}

const FIXTURE_ECONOMICS: Economics = {
  ledgerTransactionsPerFill: [2, 2, 2, 2],
  eventTypes: { TRADE_PRINCIPAL: 4, OUTCOME_TOKEN_RECEIPT: 2, OUTCOME_TOKEN_DELIVERY: 2 },
  realizedPerSnapshot: ["0", "-1", "-1", "7.5"],
  feesPaidPerSnapshot: ["0", "0", "0", "0"],
  coreNetPerSnapshot: ["0", "-1", "-1", "7.5"],
  grossTradingPerSnapshot: ["0", "-1", "-1", "7.5"],
  capitalCommittedPerSnapshot: ["17", "0", "16.5", "0"],
  worstCasePerSnapshot: ["-17", "-1", "-17.5", "7.5"],
  cashAtBoundary: "-1",
  cashAtEnd: "7.5",
};

const E2E_FEE_ECONOMICS: Economics = {
  ledgerTransactionsPerFill: [3, 3, 3, 2],
  eventTypes: { TRADE_PRINCIPAL: 4, OUTCOME_TOKEN_RECEIPT: 2, OUTCOME_TOKEN_DELIVERY: 2, PLATFORM_FEE: 3 },
  realizedPerSnapshot: ["0", "-1", "-1", "7.5"],
  feesPaidPerSnapshot: ["0.219", "0.431", "0.647", "0.647"],
  coreNetPerSnapshot: ["-0.219", "-1.431", "-1.647", "6.853"],
  grossTradingPerSnapshot: ["0", "-1", "-1", "7.5"],
  capitalCommittedPerSnapshot: ["17", "0", "16.5", "0"],
  worstCasePerSnapshot: ["-17", "-1", "-17.5", "7.5"],
  cashAtBoundary: "-1.431",
  cashAtEnd: "6.853",
};

/** The instants the fills happen at, in fill order (hand-derived above). */
const FILL_INSTANTS = [
  "2026-03-04T12:00:02Z",
  "2026-03-04T12:03:06Z",
  "2026-03-04T12:03:41Z",
  "2026-03-04T12:04:00Z",
] as const;
/** The bracket boundary: bracket 1's closing fill. */
const BOUNDARY = "2026-03-04T12:03:06Z";

/** Codes that would mean the instance lost track of its own orders or stopped. */
const FORBIDDEN_CODES = ["SB.PAUSED", "SB.UNATTRIBUTED_FILL", "SB.ILLEGAL_TRANSITION", "SB.POSITION_MISMATCH"];

function sumDecimals(values: readonly unknown[]): string {
  let total = "0";
  for (const value of values) {
    if (typeof value !== "string") throw new Error(`a durable amount is not a string: ${typeof value}`);
    total = addDecimal(total, value);
  }
  return total;
}

/** The strategy state a checkpoint row stores, narrowed to the two fields asserted. */
function bracketState(state: unknown): { readonly instanceState: unknown; readonly entriesExecuted: unknown } {
  if (!isRecord(state)) throw new Error("a checkpoint's state is not an object");
  return { instanceState: state["instanceState"], entriesExecuted: state["entriesExecuted"] };
}

/**
 * Every C2 assertion over one durable run. Each `run.db.*` value is a row
 * PostgreSQL returned; `run.memory`/`run.health` are the in-memory side they
 * are held against.
 */
function assertDurableRoundTrip(run: DurableRun, economics: Economics): void {
  const golden = readGolden();

  // --- registration: the config row records the params the run used --------
  // (`decimalSafe` stores every number as its decimal string, `support/registration.ts`.)
  const reentry = isRecord(run.db.configParameters) ? run.db.configParameters["reentry"] : undefined;
  expect(reentry).toEqual({ maximum_entries_per_market: "2", cooldown_seconds: "30" });

  // --- health: no halt, healthy, nothing unattributed ------------------------
  expect(run.health.halts).toEqual([]);
  expect(run.health.healthy).toBe(true);
  expect(run.health.accounting.unattributedActivity).toBe(0);
  expect(run.health.accounting.unexplainedMovements).toBe(0);
  expect(run.health.accounting.ledgerRefusals).toBe(0);
  expect(run.health.execution.fillsObserved).toBe(4);
  expect(run.rebuildMatched).toBe(true);
  // Every event came through the stream, in publication order.
  expect(run.delivered.map((event) => event.envelope.eventId)).toEqual(
    run.events.map((event) => event.envelope.eventId),
  );
  expect(run.health.loop.eventsProcessed).toBe(run.events.length);

  // --- strategy.decisions: one row per in-memory decision, in order ----------
  const durableCodes = run.db.decisions.map((row) => row.reasonCodes);
  expect(run.db.decisions).toHaveLength(run.memory.reasonCodes.length);
  expect(run.db.decisions.map((row) => row.evaluationSeq)).toEqual(
    run.db.decisions.map((_, index) => String(index)),
  );
  expect(durableCodes).toEqual(run.memory.reasonCodes);
  expect(run.db.decisions.map((row) => row.sourceEventId)).toEqual(run.memory.sourceEventIds);
  expect(run.health.loop.decisionsPersisted).toBe(run.db.decisions.length);
  // …equal to the BRACKET-1b golden's shape, READ from the golden file.
  expect(durableCodes).toEqual(golden.decisions.map((decision) => [...decision.reasonCodes]));
  expect(run.db.decisions.map((row) => row.decisionType)).toEqual(
    golden.decisions.map((decision) => decision.decisionType),
  );
  expect(run.db.decisions.map((row) => row.callback)).toEqual(golden.decisions.map((decision) => decision.callback));
  // Recorded time, as it came through Redis: every durable decision sits at the
  // golden's offset from its market's open (the fixture opens 3 h later on
  // another day; the offsets are identical).
  expect(run.db.decisions.map((row) => offsetMs(row.evaluatedAt, T_OPEN))).toEqual(
    golden.decisions.map((decision) => offsetMs(decision.evaluatedAt, GOLDEN_T_OPEN)),
  );
  // The same EVENT caused each decision: a golden event id's ordinal is its
  // ingestSeq, and so is this run's; loop-originated evaluations name none.
  expect(run.db.decisions.map((row) => row.sourceEventId)).toEqual(
    golden.decisions.map((decision) => {
      if (decision.sourceEventId === null) return null;
      const ordinal = Number.parseInt(decision.sourceEventId.slice(-12), 10);
      return run.events[ordinal - 1]?.envelope.eventId ?? `no event ${String(ordinal)}`;
    }),
  );
  for (const row of run.db.decisions) {
    expect(row.instanceId).toBe(run.instanceId);
    expect(row.marketId).toBe(run.marketId);
    for (const code of FORBIDDEN_CODES) expect(row.reasonCodes).not.toContain(code);
  }
  // The pins that the holding timeout — recorded time — caused the reduce.
  const byType = (type: string) => run.db.decisions.filter((row) => row.decisionType === type);
  expect(byType("cancel").map((row) => [row.evaluatedAt, row.reasonCodes])).toEqual([
    ["2026-03-04T12:03:05Z", ["SB.HOLDING_TIMEOUT", "SB.SAFETY_CANCEL"]],
  ]);
  expect(byType("reduce").map((row) => [row.evaluatedAt, row.reasonCodes])).toEqual([
    ["2026-03-04T12:03:06Z", ["SB.HOLDING_TIMEOUT", "SB.EXIT_SIZED_TO_ALLOCATION", "SB.PROTECTED_REDUCE"]],
  ]);
  const closes = run.db.decisions.filter((row) => row.reasonCodes.includes("SB.CLOSED"));
  expect(closes.map((row) => [row.evaluatedAt, row.callback, row.reasonCodes])).toEqual([
    ["2026-03-04T12:03:06Z", "onFill", ["SB.EXIT_FILLED", "SB.CLOSED"]],
    ["2026-03-04T12:04:00Z", "onFill", ["SB.EXIT_FILLED", "SB.CLOSED"]],
  ]);
  const rearmed = run.db.decisions.filter((row) => row.reasonCodes.includes("SB.REARMED"));
  expect(rearmed.map((row) => row.evaluatedAt)).toEqual(["2026-03-04T12:03:40Z"]);
  expect(byType("enter").map((row) => row.evaluatedAt)).toEqual(["2026-03-04T12:00:02Z", "2026-03-04T12:03:41Z"]);
  expect(run.db.decisions.at(-1)?.reasonCodes).toEqual(["SB.REFUSED_MAXIMUM_ENTRIES"]);

  // --- strategy.state_checkpoints: after every decision, with valid hashes ---
  expect(run.db.checkpoints.map((row) => row.checkpointSeq)).toEqual(
    run.db.decisions.map((row) => row.evaluationSeq),
  );
  run.db.checkpoints.forEach((row, index) => {
    expect(row.instanceId).toBe(run.instanceId);
    expect(row.capturedAt).toBe(run.db.decisions[index]?.evaluatedAt);
    // The hash names the state the row stores: SHA-256 of its canonical bytes.
    expect(row.stateHash).toBe(
      createHash("sha256").update(canonicalJsonStringify(row.state), "utf8").digest("hex"),
    );
  });
  const states = run.db.checkpoints.map((row) => bracketState(row.state));
  for (const state of states) expect(state.instanceState).not.toBe("PAUSED");
  const seqOf = (codes: readonly string[], at: string) =>
    run.db.decisions.findIndex(
      (row) => row.evaluatedAt === at && codes.every((code) => row.reasonCodes.includes(code)),
    );
  const firstClose = seqOf(["SB.CLOSED"], "2026-03-04T12:03:06Z");
  const rearm = seqOf(["SB.REARMED"], "2026-03-04T12:03:40Z");
  const secondClose = seqOf(["SB.CLOSED"], "2026-03-04T12:04:00Z");
  expect([firstClose, rearm, secondClose].every((seq) => seq >= 0)).toBe(true);
  // After each close the stored state is CLOSED; the checkpoint just before
  // REARMED is CLOSED and REARMED's own is ARMED — the CLOSED→ARMED transition,
  // named in the rows.
  expect(states[firstClose]).toEqual({ instanceState: "CLOSED", entriesExecuted: 1 });
  expect(states[rearm - 1]).toEqual({ instanceState: "CLOSED", entriesExecuted: 1 });
  expect(states[rearm]).toEqual({ instanceState: "ARMED", entriesExecuted: 1 });
  expect(states[secondClose]).toEqual({ instanceState: "CLOSED", entriesExecuted: 2 });
  expect(states.at(-1)).toEqual({ instanceState: "CLOSED", entriesExecuted: 2 });

  // --- accounting.ledger_transactions + ledger_entries -----------------------
  expect(run.memory.ledgerTransactionsPerFill).toEqual(economics.ledgerTransactionsPerFill);
  const perFill = economics.ledgerTransactionsPerFill.reduce((total, count) => total + count, 0);
  expect(run.db.transactions).toHaveLength(perFill);
  expect(run.db.transactions).toHaveLength(run.health.accounting.ledgerTransactions);
  expect(run.db.allTransactionCount).toBe(run.db.transactions.length);
  const eventTypes: Record<string, number> = {};
  for (const row of run.db.transactions) eventTypes[row.eventType] = (eventTypes[row.eventType] ?? 0) + 1;
  expect(eventTypes).toEqual(economics.eventTypes);
  // Each fill's postings, grouped by the instant they occurred at, in fill order.
  expect(
    FILL_INSTANTS.map((at) => run.db.transactions.filter((row) => Date.parse(row.occurredAt) === Date.parse(at)).length),
  ).toEqual(economics.ledgerTransactionsPerFill);
  for (const row of run.db.transactions) {
    expect(row.environment).toBe("PAPER");
    expect(row.accountRef).toBe(ACCOUNT);
    expect(row.marketId).toBe(run.marketId);
    // DISCLOSED (`RECON2-DURABLE`), the same pair as the BOOT-1 file: the
    // adapter binds the execution link NULL…
    expect(row.fillId).toBeNull();
    expect(row.orderId).toBeNull();
  }
  // …and the execution chain is absent: four fills observed, zero persisted.
  expect(run.db.executionFills).toBe(0);
  for (const entry of run.db.entries) expect(typeof entry.amount).toBe("string");
  const virtual = run.db.entries.filter((entry) => entry.scope === "VIRTUAL_STRATEGY");
  for (const entry of virtual) {
    expect(entry.instanceId).toBe(run.instanceId);
    expect(entry.runId).toBe(run.runId);
    expect(entry.marketId).toBe(run.marketId);
    expect(entry.accountRef).toBe(ACCOUNT);
  }
  const occurred = new Map(run.db.transactions.map((row) => [row.id, Date.parse(row.occurredAt)]));
  const upTo = (at: string) =>
    virtual.filter((entry) => (occurred.get(entry.transactionId) ?? Number.POSITIVE_INFINITY) <= Date.parse(at));
  const cash = (entries: typeof virtual) => sumDecimals(entries.filter((entry) => entry.assetId === "pUSD").map((entry) => entry.amount));
  const tokens = (entries: typeof virtual) =>
    sumDecimals(entries.filter((entry) => entry.assetId !== "pUSD").map((entry) => entry.amount));
  // The durable ledger, summed exactly: flat at the boundary and at the end,
  // and the instance's cash is the hand-derived net.
  expect(cash(upTo(BOUNDARY))).toBe(economics.cashAtBoundary);
  expect(tokens(upTo(BOUNDARY))).toBe("0");
  expect(cash(virtual)).toBe(economics.cashAtEnd);
  expect(tokens(virtual)).toBe("0");

  // --- accounting.pnl_snapshots: one per fill, exact ------------------------
  // (Each instant here has ONE fill, so one per fill is also one per instance
  // per instant — the `pnl_snapshots_scope_unique` key `SNAP-1` enforces.)
  expect(run.db.snapshots).toHaveLength(run.health.execution.fillsObserved);
  expect(run.db.snapshots.map((row) => row["as_of"])).toEqual([...FILL_INSTANTS]);
  expect(run.db.snapshots.map((row) => row["realized_pnl"])).toEqual(economics.realizedPerSnapshot);
  expect(run.db.snapshots.map((row) => row["fees_paid"])).toEqual(economics.feesPaidPerSnapshot);
  // `SNAP-1` (`BR1C-R1-L1`): the rest of the economics, each column exact.
  expect(run.db.snapshots.map((row) => row["core_net_pnl"])).toEqual(economics.coreNetPerSnapshot);
  expect(run.db.snapshots.map((row) => row["gross_trading_pnl"])).toEqual(economics.grossTradingPerSnapshot);
  expect(run.db.snapshots.map((row) => row["capital_committed"])).toEqual(economics.capitalCommittedPerSnapshot);
  expect(run.db.snapshots.map((row) => row["worst_case_resolution_pnl"])).toEqual(economics.worstCasePerSnapshot);
  for (const row of run.db.snapshots) {
    expect(row["scope"]).toBe("VIRTUAL_STRATEGY");
    expect(row["environment"]).toBe("PAPER");
    expect(row["account_ref"]).toBe(ACCOUNT);
    expect(row["instance_id"]).toBe(run.instanceId);
    expect(row["run_id"]).toBe(run.runId);
    expect(row["market_id"]).toBe(run.marketId);
  }
  // The realized-PnL health book (`TRDR-3`) agrees with the LAST durable row.
  const last = run.db.snapshots.at(-1)?.["realized_pnl"];
  expect(last).toBe(economics.realizedPerSnapshot.at(-1));
  expect(run.health.accounting.realizedPnl).toEqual({
    byInstance: { [run.instanceId]: last },
    account: last,
  });
}

// ---------------------------------------------------------------------------
// The tests
// ---------------------------------------------------------------------------

describe("BRACKET-1c: a durable two-bracket round trip through PostgreSQL, Redis and the composition root", () => {
  it("drives both brackets through the Redis stream and pump on the event-time clock; every durable write past the first fill reads back", async () => {
    const run = await runDurableTwoBrackets({
      label: "b1c-main",
      clock: "event-time",
      delivery: "per-event",
      feeSchedule: "fixture",
    });
    assertDurableRoundTrip(run, FIXTURE_ECONOMICS);

    // One event per publication, each pumped to idle: the clock was positioned
    // at every event's recorded instant, in order, before the loop drained it.
    expect(run.pumps).toEqual(run.events.map(() => ({ polls: 2, ingested: 1, stopped: "IDLE" })));
    expect(run.positions).toEqual(run.events.map((event) => recordedInstant(event.envelope.receivedAt).instant));

    // The in-memory PnL state right after each close equals the durable row
    // written at that close, and the hand derivation.
    expect(run.memory.realizedAfterBracket1).toBe("-1");
    expect(run.db.snapshots[1]?.["realized_pnl"]).toBe(run.memory.realizedAfterBracket1);
    expect(run.memory.realizedAfterBracket2).toBe("7.5");
    expect(run.db.snapshots[3]?.["realized_pnl"]).toBe(run.memory.realizedAfterBracket2);
  }, 180_000);

  it("the process's own SystemPaperClock and ONE pump over the whole stream give the same durable run — strategy time is the envelope's receivedAt", async () => {
    const run = await runDurableTwoBrackets({
      label: "b1c-system-clock",
      clock: "system",
      delivery: "one-pump",
      feeSchedule: "fixture",
    });
    // The whole stream in one batch, as `startup()` would read it.
    expect(run.pumps).toEqual([{ polls: 2, ingested: run.events.length, stopped: "IDLE" }]);
    expect(run.positions).toEqual([]);
    assertDurableRoundTrip(run, FIXTURE_ECONOMICS);
  }, 180_000);

  it("on the e2e scenario's fee schedule the durable fee postings land: 3+3+3+2 transactions, and the snapshots equal the BRACKET-1b golden's", async () => {
    const run = await runDurableTwoBrackets({
      label: "b1c-e2e-fees",
      clock: "event-time",
      delivery: "per-event",
      feeSchedule: "e2e",
    });
    assertDurableRoundTrip(run, E2E_FEE_ECONOMICS);
    expect(run.memory.realizedAfterBracket1).toBe("-1");
    expect(run.db.snapshots[1]?.["realized_pnl"]).toBe(run.memory.realizedAfterBracket1);
    expect(run.memory.realizedAfterBracket2).toBe("7.5");
    expect(run.db.snapshots[3]?.["realized_pnl"]).toBe(run.memory.realizedAfterBracket2);
    // The three charged fees, as the durable fee postings carry them: the
    // instance's VIRTUAL_STRATEGY leg of each `PLATFORM_FEE` transaction.
    const feeTransactions = new Set(
      run.db.transactions.filter((row) => row.eventType === "PLATFORM_FEE").map((row) => row.id),
    );
    expect(
      run.db.entries
        .filter(
          (entry) =>
            feeTransactions.has(entry.transactionId) &&
            entry.scope === "VIRTUAL_STRATEGY" &&
            entry.assetId === "pUSD",
        )
        .map((entry) => entry.amount)
        .sort(),
    ).toEqual(["-0.212", "-0.216", "-0.219"]);

    // Every economic column of every durable snapshot equals the in-memory
    // golden's snapshot at the same position: same prices, sizes and fees.
    const golden = readGolden();
    const columns: readonly (readonly [string, string])[] = [
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
    expect(run.db.snapshots).toHaveLength(golden.pnlSnapshots.length);
    run.db.snapshots.forEach((row, index) => {
      const expected = golden.pnlSnapshots[index];
      for (const [column, field] of columns) {
        expect({ index, column, value: row[column] }).toEqual({ index, column, value: expected?.[field] });
      }
    });
    expect(run.db.snapshots.at(-1)?.["core_net_pnl"]).toBe("6.853");
  }, 180_000);
});
