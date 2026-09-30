/**
 * `THROUGHPUT-1a` — GROUP COMMIT in the core loop, and the pump's pipelined
 * durability, against the REAL assembled trader (the paper fixture's recorded
 * run: reference prints, the market opening, books, an entry, a fill) with an
 * in-memory store that offers group commit.
 *
 * What is pinned:
 *
 * 1. IDENTITY — every decision, checkpoint (and its instant), ledger
 *    transaction and PnL snapshot the group-committing trader makes durable is
 *    exactly what the per-row trader writes, in the same order.
 * 2. ORDER — when a ledger posting or a PnL snapshot is written, nothing is
 *    staged: every earlier decision is already durable.
 * 3. FAILURE — a failed commit latches GLOBAL `STORE_UNAVAILABLE`, no commit
 *    ever runs after it, and no evaluation happens after the halt; a row the
 *    store cannot stage halts at that event.
 * 4. BOUNDS — a non-waiting drain returns with the commit still in flight;
 *    `durabilityMark()` resolves only once it settled; a waiting drain (the
 *    default) returns only once everything staged is durable; and with the
 *    database stalled, the loop stops evaluating once
 *    `GROUP_COMMIT_MAX_EVENTS` events are staged (the hard bound).
 * 5. THE PUMP — a batch's position is recorded only after that batch's
 *    decisions are durable; a failed commit ends the pump HALTED with the
 *    batch's position NOT recorded.
 */

import type { GroupCommit, MarketEventFeed, StagedEvaluations, TraderStore } from "@polymarket-bot/trader";
import { portFailed, portOk } from "@polymarket-bot/trader";
import type { MemoryTraderStore } from "@polymarket-bot/trader/testing";
import { describe, expect, it } from "vitest";

import { pump } from "../../../apps/trader/src/pump.js";
import { GROUP_COMMIT_EARLY_START_EVENTS, GROUP_COMMIT_MAX_EVENTS } from "../../../packages/trading-core/src/loop.js";
import { assemble, GATEWAY_EPOCH, ingested, MARKET_ID, recordedEvents, YES_TOKEN } from "./support/fixture.js";

/** A group commit over the fixture's in-memory store: a commit writes its batch through the per-row methods. */
class MemoryGroupCommit implements GroupCommit {
  staged: StagedEvaluations[] = [];
  readonly batches: number[] = [];
  readonly log: string[];
  failCommits = false;
  failStage = false;
  /** When set, `commit` waits for this before it writes. */
  gate: Promise<void> | undefined;
  readonly #store: MemoryTraderStore;

  constructor(store: MemoryTraderStore, log: string[]) {
    this.#store = store;
    this.log = log;
  }

  get stagedEvents(): number {
    return this.staged.length;
  }

  stage(evaluations: StagedEvaluations) {
    if (this.failStage) return portFailed<null>("UNAVAILABLE", "the fixture refuses to stage");
    this.staged.push(evaluations);
    this.log.push("stage");
    return portOk(null);
  }

  async commit() {
    const batch = this.staged;
    this.staged = [];
    if (this.gate !== undefined) await this.gate;
    this.log.push(`commit ${String(batch.length)}`);
    if (this.failCommits) return portFailed<{ decisions: number; checkpoints: number }>("UNAVAILABLE", "the fixture's store is down");
    let decisions = 0;
    let checkpoints = 0;
    for (const event of batch) {
      for (const entry of event.decisions) {
        await this.#store.persistDecision(entry.record, entry.telemetry);
        decisions += 1;
      }
      for (const entry of event.checkpoints) {
        await this.#store.saveCheckpoint(entry.checkpoint, entry.capturedAt);
        checkpoints += 1;
      }
    }
    this.batches.push(batch.length);
    return portOk({ decisions, checkpoints });
  }
}

interface GroupCommitRun {
  readonly store: MemoryTraderStore;
  readonly group: MemoryGroupCommit;
  readonly log: string[];
  readonly violations: string[];
  readonly trader: NonNullable<ReturnType<typeof assemble>["parts"]>["trader"];
}

function assembleGroupCommitting(): GroupCommitRun {
  const log: string[] = [];
  const violations: string[] = [];
  let group: MemoryGroupCommit | undefined;
  const { result, parts } = assemble({
    wrapStore: (inner): TraderStore => {
      const created = new MemoryGroupCommit(inner, log);
      group = created;
      const guard = (what: string): void => {
        log.push(what);
        if (created.stagedEvents > 0) violations.push(`${what} while ${String(created.stagedEvents)} event(s) staged`);
      };
      return {
        persistDecision: (record, telemetry) => inner.persistDecision(record, telemetry),
        saveCheckpoint: (checkpoint, capturedAt) => inner.saveCheckpoint(checkpoint, capturedAt),
        appendLedgerTransaction: (transaction) => {
          guard("ledger");
          return inner.appendLedgerTransaction(transaction);
        },
        writePnlSnapshot: (snapshot) => {
          guard("pnl");
          return inner.writePnlSnapshot(snapshot);
        },
        replacePnlSnapshot: (snapshot) => {
          guard("pnl-replace");
          return inner.replacePnlSnapshot(snapshot);
        },
        close: () => inner.close(),
        groupCommit: created,
      };
    },
  });
  if (!result.ok || parts === undefined || group === undefined) throw new Error("the fixture refused to assemble");
  return { store: parts.store, group, log, violations, trader: result.trader };
}

function durableContent(store: MemoryTraderStore): string {
  return JSON.stringify(
    {
      decisions: store.decisions.map((entry) => entry.record),
      checkpoints: store.checkpoints,
      instants: store.checkpointInstants,
      transactions: store.transactions,
      snapshots: store.pnlSnapshots,
    },
    (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value),
  );
}

describe("group commit in the core loop (THROUGHPUT-1a)", () => {
  it("makes durable exactly what the per-row path writes, and writes no ledger row while anything is staged", async () => {
    const plain = assemble();
    if (!plain.result.ok || plain.parts === undefined) throw new Error("unassembled");
    for (const event of recordedEvents()) plain.result.trader.loop.ingest(event);
    await plain.result.trader.loop.drain();

    const run = assembleGroupCommitting();
    for (const event of recordedEvents()) run.trader.loop.ingest(event);
    await run.trader.loop.drain();

    expect(plain.parts.store.decisions.length).toBeGreaterThan(3);
    expect(plain.parts.store.transactions.length).toBeGreaterThan(0);
    expect(run.group.stagedEvents).toBe(0);
    expect(durableContent(run.store)).toBe(durableContent(plain.parts.store));
    expect(run.violations).toEqual([]);
    expect(run.log).toContain("ledger");
    expect(run.trader.halts.anyHalt).toBe(plain.result.trader.halts.anyHalt);
  });

  it("a failed commit latches GLOBAL STORE_UNAVAILABLE; nothing is committed or evaluated after it", async () => {
    const run = assembleGroupCommitting();
    const events = recordedEvents();
    run.group.failCommits = true;
    // The first decision is made at the fourth event (the YES book's snapshot).
    for (const event of events.slice(0, 4)) run.trader.loop.ingest(event);
    await run.trader.loop.drain();
    const halts = run.trader.halts.records();
    expect(halts).toHaveLength(1);
    expect(halts[0]?.scope).toEqual({ kind: "GLOBAL" });
    expect(halts[0]?.code).toBe("STORE_UNAVAILABLE");
    expect(halts[0]?.detail).toContain("group commit");
    const commitsSoFar = run.log.filter((line) => line.startsWith("commit")).length;
    const evaluationsSoFar = run.trader.loop.health().loop.evaluations;

    for (const event of events.slice(4)) run.trader.loop.ingest(event);
    await run.trader.loop.drain();
    expect(run.log.filter((line) => line.startsWith("commit")).length).toBe(commitsSoFar);
    expect(run.trader.loop.health().loop.evaluations).toBe(evaluationsSoFar);
    expect(run.store.decisions).toHaveLength(0);
    expect(await run.trader.loop.durabilityMark()).toBe(false);
  });

  it("a row the store cannot stage halts at THAT event", async () => {
    const run = assembleGroupCommitting();
    run.group.failStage = true;
    for (const event of recordedEvents()) run.trader.loop.ingest(event);
    await run.trader.loop.drain();
    const halts = run.trader.halts.records();
    expect(halts.map((halt) => halt.code)).toEqual(["STORE_UNAVAILABLE"]);
    expect(halts[0]?.detail).toContain("could not be staged");
    expect(run.store.decisions).toHaveLength(0);
  });

  it("a non-waiting drain returns with the commit in flight; durabilityMark() resolves once it settled", async () => {
    const run = assembleGroupCommitting();
    let open: () => void = () => undefined;
    run.group.gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    // The first four events decide (a hold) without routing an intent or
    // booking a fill — both of which wait for durability first, by design.
    for (const event of recordedEvents().slice(0, 4)) run.trader.loop.ingest(event);
    await run.trader.loop.drain({ awaitDurable: false });
    expect(run.store.decisions).toHaveLength(0);
    let settled = false;
    const mark = run.trader.loop.durabilityMark().then((durable) => {
      settled = true;
      return durable;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    open();
    expect(await mark).toBe(true);
    expect(run.store.decisions.length).toBeGreaterThan(0);
  });

  it("with the database stalled, stops evaluating at GROUP_COMMIT_MAX_EVENTS staged events; resumes, identical, once it answers", async () => {
    // The market opens with a YES book priced ABOVE the entry trigger, then
    // 300 reference prints: each is an evaluation and a decision, and none
    // routes an intent (an intent waits for durability first, by design).
    const events = (): ReturnType<typeof recordedEvents> => [
      ...recordedEvents().slice(0, 3),
      ingested(
        "BookSnapshot",
        {
          internalMarketId: MARKET_ID,
          tokenId: YES_TOKEN,
          bids: [{ price: "0.58", size: "200" }],
          asks: [{ price: "0.6", size: "200" }],
        },
        { receivedAt: "2026-03-04T12:00:01.000Z", ingestSeq: 4 },
      ),
      ...Array.from({ length: 300 }, (_, index) =>
        ingested(
          "ReferenceTradeObserved",
          { venue: "binance", symbol: "BTCUSDT", price: String(100_000 + index), size: "0.1" },
          {
            receivedAt: new Date(Date.parse("2026-03-04T12:00:01.000Z") + 1 + index).toISOString(),
            ingestSeq: 10 + index,
            source: "binance",
          },
        ),
      ),
    ];
    const plain = assemble();
    if (!plain.result.ok || plain.parts === undefined) throw new Error("unassembled");
    for (const event of events()) plain.result.trader.loop.ingest(event);
    await plain.result.trader.loop.drain();
    expect(plain.parts.store.decisions.length).toBeGreaterThan(2 * GROUP_COMMIT_MAX_EVENTS);

    const run = assembleGroupCommitting();
    let open: () => void = () => undefined;
    run.group.gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    for (const event of events()) run.trader.loop.ingest(event);
    let drained = false;
    const drain = run.trader.loop.drain({ awaitDurable: false }).then(() => {
      drained = true;
    });
    const turns = async (count: number): Promise<void> => {
      for (let turn = 0; turn < count; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    };
    await turns(50);
    // Stalled: one batch committing (taken at the early start), the bound staged, nothing more evaluated.
    expect(drained).toBe(false);
    expect(run.group.stagedEvents).toBe(GROUP_COMMIT_MAX_EVENTS);
    const evaluations = run.trader.loop.health().loop.evaluations;
    await turns(50);
    expect(run.trader.loop.health().loop.evaluations).toBe(evaluations);
    expect(run.group.stagedEvents).toBe(GROUP_COMMIT_MAX_EVENTS);
    expect(run.store.decisions).toHaveLength(0);

    open();
    await drain;
    expect(await run.trader.loop.durabilityMark()).toBe(true);
    expect(run.group.batches[0]).toBe(GROUP_COMMIT_EARLY_START_EVENTS);
    expect(Math.max(...run.group.batches)).toBeLessThanOrEqual(GROUP_COMMIT_MAX_EVENTS);
    expect(durableContent(run.store)).toBe(durableContent(plain.parts.store));
  });

  it("THROUGHPUT-2 r1 (TP2-R1-M2): the bounds count STAGINGS — one per venue frame — so a stall holds 128 FRAMES, not 128 events", async () => {
    // As above, but 600 reference prints arrive as 300 two-trade frames
    // (one `causationId` each). The loop flushes once per frame, so each
    // staging is one frame: the hard bound stops the loop at 128 staged
    // FRAMES — 256 events — and the early start takes 32 frames. What each
    // staging holds in decisions is what one lone event's did: one.
    const events = (): ReturnType<typeof recordedEvents> => [
      ...recordedEvents().slice(0, 3),
      ingested(
        "BookSnapshot",
        {
          internalMarketId: MARKET_ID,
          tokenId: YES_TOKEN,
          bids: [{ price: "0.58", size: "200" }],
          asks: [{ price: "0.6", size: "200" }],
        },
        { receivedAt: "2026-03-04T12:00:01.000Z", ingestSeq: 4 },
      ),
      ...Array.from({ length: 600 }, (_, index) => {
        const event = ingested(
          "ReferenceTradeObserved",
          { venue: "binance", symbol: "BTCUSDT", price: String(100_000 + index), size: "0.1" },
          {
            receivedAt: new Date(Date.parse("2026-03-04T12:00:01.000Z") + 1 + Math.floor(index / 2)).toISOString(),
            ingestSeq: 10 + index,
            source: "binance",
          },
        );
        return {
          envelope: { ...event.envelope, causationId: `raw:${GATEWAY_EPOCH}:${String(1_000 + Math.floor(index / 2))}` },
          identity: event.identity,
        };
      }),
    ];
    const run = assembleGroupCommitting();
    let open: () => void = () => undefined;
    run.group.gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const stream = events();
    for (const event of stream) run.trader.loop.ingest(event);
    const drain = run.trader.loop.drain({ awaitDurable: false });
    for (let turn = 0; turn < 100; turn += 1) await new Promise((resolve) => setImmediate(resolve));

    expect(run.group.stagedEvents).toBe(GROUP_COMMIT_MAX_EVENTS);
    expect(run.group.staged.every((staging) => staging.decisions.length === 1)).toBe(true);
    const processedAtStall = run.trader.loop.health().loop.eventsProcessed;
    expect(run.store.decisions).toHaveLength(0);

    open();
    await drain;
    expect(await run.trader.loop.durabilityMark()).toBe(true);
    // The committing batch was the first 32 stagings: the opening's (those of
    // its 4 events that decided) and the first frames'. Every other staging
    // is one frame of 2 events, so at the stall 4 + 2 × (32 − opening + 128)
    // events had been processed — 2 × 128 = 256 events in the 128 staged
    // frames, twice the bound's number.
    expect(run.group.batches[0]).toBe(GROUP_COMMIT_EARLY_START_EVENTS);
    const openingIds = new Set(stream.slice(0, 4).map((event) => event.envelope.eventId));
    const openingStagings = run.store.decisions.filter((entry) => openingIds.has(entry.record.sourceEvent?.eventId ?? "")).length;
    expect(openingStagings).toBeGreaterThan(0);
    expect(processedAtStall).toBe(
      4 + 2 * (GROUP_COMMIT_EARLY_START_EVENTS - openingStagings + GROUP_COMMIT_MAX_EVENTS),
    );
    expect(Math.max(...run.group.batches)).toBeLessThanOrEqual(GROUP_COMMIT_MAX_EVENTS);
    expect(run.store.decisions).toHaveLength(openingStagings + 300);
  });

  it("the default drain returns only once everything staged is durable", async () => {
    const run = assembleGroupCommitting();
    for (const event of recordedEvents().slice(0, 4)) run.trader.loop.ingest(event);
    await run.trader.loop.drain();
    expect(run.group.stagedEvents).toBe(0);
    expect(run.store.decisions.length).toBeGreaterThan(0);
  });
});

/** A feed over fixed batches that CAN mark positions, recording what the pump records. */
class MarkingFeed implements MarketEventFeed {
  readonly recorded: number[] = [];
  #delivered = 0;
  readonly #batches: ReturnType<typeof recordedEvents>[];
  readonly #marks = new WeakMap<object, number>();
  readonly onCommit: (through: number) => void;

  constructor(batches: ReturnType<typeof recordedEvents>[], onCommit: (through: number) => void) {
    this.#batches = batches;
    this.onCommit = onCommit;
  }

  async poll() {
    const batch = this.#batches.shift() ?? [];
    this.#delivered += batch.length;
    return await Promise.resolve(portOk(batch));
  }

  mark() {
    const mark = { feedMark: true as const };
    this.#marks.set(mark, this.#delivered);
    return mark;
  }

  async commit(upTo?: { readonly feedMark: true }) {
    const through = upTo === undefined ? this.#delivered : (this.#marks.get(upTo) ?? -1);
    this.onCommit(through);
    this.recorded.push(through);
    return await Promise.resolve(portOk(null));
  }

  async close() {
    await Promise.resolve();
  }
}

describe("the pump's pipelined durability (THROUGHPUT-1a)", () => {
  it("records a batch's position only after that batch's decisions are durable, and every batch in the end", async () => {
    const run = assembleGroupCommitting();
    const events = recordedEvents();
    const violations: string[] = [];
    const feed = new MarkingFeed([events.slice(0, 2), events.slice(2, 4), events.slice(4)], (through) => {
      // Everything decided for the events up to `through` must be durable now.
      if (run.group.stagedEvents > 0 && through >= events.length) {
        violations.push(`recorded ${String(through)} with ${String(run.group.stagedEvents)} staged`);
      }
      const durableSources = new Set(run.store.decisions.map((entry) => entry.record.sourceEvent?.eventId));
      for (const event of events.slice(0, through)) {
        const decidedIds = new Set(
          run.trader.loop
            .decisions()
            .filter((decision) => decision.sourceEventId === event.envelope.eventId)
            .map((decision) => decision.sourceEventId),
        );
        for (const id of decidedIds) {
          if (!durableSources.has(id)) violations.push(`recorded ${String(through)} before event ${id} was durable`);
        }
      }
    });
    const result = await pump({ loop: run.trader.loop, feed, halts: run.trader.halts, maxPolls: 10, untilIdle: true });
    expect(result.stopped).toBe("IDLE");
    expect(result.ingested).toBe(events.length);
    expect(violations).toEqual([]);
    expect(feed.recorded.at(-1)).toBe(events.length);
    // Pipelined: a batch's position is recorded after the NEXT batch was drained.
    expect(feed.recorded.length).toBeGreaterThanOrEqual(2);
  });

  it("a failed commit ends the pump HALTED, and the batch's position is not recorded", async () => {
    const run = assembleGroupCommitting();
    run.group.failCommits = true;
    const events = recordedEvents();
    const feed = new MarkingFeed([events.slice(0, 3), events.slice(3)], () => undefined);
    const result = await pump({ loop: run.trader.loop, feed, halts: run.trader.halts, maxPolls: 10, untilIdle: true });
    expect(result.stopped).toBe("HALTED");
    expect(feed.recorded).toEqual([]);
    expect(run.trader.halts.records().map((halt) => halt.code)).toEqual(["STORE_UNAVAILABLE"]);
  });
});
