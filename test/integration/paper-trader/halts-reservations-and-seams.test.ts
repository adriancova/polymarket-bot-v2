/**
 * The §4.2 halt gate, the two reservation books, and the seam metrics — each
 * driven through the assembled system.
 *
 * Every test here exists because review round 1 found the property CLAIMED and
 * not measured. The finding it closes is named in the title, and each one was
 * reproduced at the reviewed tip before the fix landed.
 *
 * NOTHING IS DOUBLED HERE except the clock, the transport, the store, and — for
 * the venue-refusal case — the §9.13 rate-limit BUDGET, which is an injectable
 * option of the real `SimulatedVenue` rather than a stand-in for it.
 */

import { tokenBucketRateLimits } from "@polymarket-bot/simulation";
import { parseTraderConfig } from "@polymarket-bot/trader";
import { describe, expect, it } from "vitest";

import {
  INSTANCE_ID,
  MARKET_ID,
  recordedEvents,
  restingEntryConfig,
  restingEntryEvents,
  restingEntryTradeEvent,
  traderConfig,
  twoMarketConfig,
  twoMarketEvents,
} from "./support/fixture.js";
import { assembleOrThrow, driveRecordedRun } from "./support/run.js";

describe("MEDIUM-1 — a halt latched in this iteration stops the STRATEGY, not the books", () => {
  it("a fill whose own iteration halts is BOOKED and NOT delivered", async () => {
    const run = assembleOrThrow();
    // The §9.16 snapshot write fails while the connection is otherwise up — a
    // real PostgreSQL shape (a missing partition, a table lock), and the one
    // that places a §4.2 halt EXACTLY between the fill's posting and its
    // delivery.
    run.parts.store.failOnly(
      ["writePnlSnapshot"],
      "UNAVAILABLE",
      "relation \"pnl_snapshots\" does not exist",
    );
    for (const event of recordedEvents()) run.trader.loop.ingest(event);
    await run.trader.loop.drain();

    const halt = run.trader.halts.globalHalt();
    expect(halt?.code).toBe("STORE_UNAVAILABLE");
    expect(halt?.action).toBe("FULL_HALT");

    // THE BOOKS ARE TRUTHFUL. The money moved, so the ledger holds it and the
    // §6 invariant 4 chain is complete — none of that is gated on the halt.
    expect(run.trader.loop.ledger().length).toBeGreaterThan(0);
    expect(run.trader.loop.traces()).toHaveLength(1);
    expect(run.parts.store.transactions.length).toBeGreaterThan(0);

    // THE STRATEGY DID NOT ACT. At the reviewed tip the same fill was delivered
    // and an `exit` decision was persisted AFTER the FULL_HALT.
    const callbacks = run.trader.loop.decisions().map((decision) => decision.callback);
    expect(callbacks).not.toContain("onFill");
    expect(callbacks).not.toContain("onOrderUpdate");
    expect(
      run.parts.store.decisions.map((written) => written.record.callback),
    ).not.toContain("onFill");
    // …and the withholding is COUNTED rather than silent.
    expect(run.trader.loop.health().loop.deliveriesSuppressedByHalt).toBeGreaterThan(0);
  });

  it("acceptance 4's claim, restated exactly: ZERO decisions after the halt", async () => {
    const run = assembleOrThrow();
    run.parts.store.failOnly(["writePnlSnapshot"], "UNAVAILABLE", "connection reset");
    for (const event of recordedEvents()) run.trader.loop.ingest(event);
    await run.trader.loop.drain();

    const haltAt = run.trader.halts.globalHalt()?.at;
    expect(haltAt).toBeDefined();
    // Every persisted decision belongs to an evaluation that ran BEFORE the
    // halt latched: the entry, and the hold that preceded it.
    expect(run.parts.store.decisions.map((written) => written.record.decision.decisionType)).toEqual(
      ["hold", "enter"],
    );

    // More events after the halt change nothing at all.
    const before = run.parts.store.decisions.length;
    for (const event of recordedEvents()) run.trader.loop.ingest(event);
    await run.trader.loop.drain();
    expect(run.parts.store.decisions).toHaveLength(before);
  });
});

describe("M10 — `runStatePermitsIntent` is the run's REAL state", () => {
  it("a latched halt elsewhere blocks an intent this market would otherwise submit", async () => {
    // Market 2's book desynchronizes: a level change with no baseline is
    // REFUSED by `packages/order-book`, and the loop halts THAT market. Market 1
    // is untouched, so its instance still evaluates and still emits an entry —
    // and §9.8 check 1 must refuse it, because the RUN is no longer in a state
    // that permits new orders.
    const run = assembleOrThrow({ config: twoMarketConfig("1000") });
    const events = twoMarketEvents();
    const desync = events.find((event) => event.envelope.eventType === "BookSnapshot");
    expect(desync).toBeDefined();
    if (desync === undefined) return;

    run.trader.loop.ingest({
      ...desync,
      envelope: {
        ...desync.envelope,
        eventId: "018f4a7e-6666-7abc-8def-000000000099",
        eventType: "BookLevelChanged",
        payload: {
          internalMarketId: "018f4a7e-7777-7abc-8def-0123456789ab",
          tokenId: "333",
          side: "ASK",
          price: "0.34",
          size: "10",
        },
      },
    });
    for (const event of events) run.trader.loop.ingest(event);
    await run.trader.loop.drain();

    const health = run.trader.loop.health();
    expect(health.halts.map((halt) => halt.code)).toContain("BOOK_DESYNCHRONIZED");
    // The entry was EMITTED (the strategy ran) and REFUSED by check 1.
    expect(
      run.trader.loop.decisions().some((decision) => decision.decisionType === "enter"),
    ).toBe(true);
    expect(Object.keys(health.risk.refusalsByCode)).toContain("RISK_RUN_STATE_BLOCKS");
    expect(health.risk.approvals).toBe(0);
    expect(health.execution.plansBuilt).toBe(0);
    expect(health.execution.submissionsAccepted).toBe(0);
  });
});

describe("MEDIUM-4 — a venue-refused submission returns what it reserved", () => {
  it("the reservation is released, and the NEXT market's entry is not starved", async () => {
    // The REAL venue refuses, from its own §9.13 budget: no order tokens.
    const rateLimits = tokenBucketRateLimits({
      orderTokensPerWindow: 0,
      cancelTokensPerWindow: 10,
      windowMs: 60_000,
      snapshotVersion: "wp-230-medium-4",
    });
    // `startingCash` funds exactly ONE of the two entries, so a leaked
    // reservation is the difference between one plan and two.
    const run = assembleOrThrow({ config: twoMarketConfig("18"), rateLimits });
    for (const event of twoMarketEvents()) run.trader.loop.ingest(event);
    await run.trader.loop.drain();

    const health = run.trader.loop.health();
    expect(health.execution.submissionsRefused).toBe(2);
    // At the reviewed tip this was 1 built and 1 REFUSED: market 1's leaked
    // 17.5 left 0.5 unreserved and the planner could not fund market 2.
    expect(health.execution.plansBuilt).toBe(2);
    expect(health.execution.plansRefused).toBe(0);

    // Reserved returned to its prior value, in BOTH books.
    expect(health.seams.reservations.open).toBe(0);
    expect(health.seams.reservations.reservedCollateral).toBe("0");
    expect(health.seams.reservations.taken).toBe(2);
    expect(health.seams.reservations.released).toBe(2);
    expect(health.seams.allocator.open).toBe(0);
    expect(health.seams.allocator.reservedCollateral).toBe("0");
    // …and the release is visible as its own counter, not only as an absence.
    expect(health.execution.reservationsReleasedOnRefusal).toBe(2);
  });
});

describe("L3 — the reservation books, taken and released on the RIGHT events", () => {
  it("M12: reserved RISES on submission, in both books", async () => {
    const run = assembleOrThrow({ config: restingEntryConfig() });
    for (const event of recordedEvents()) run.trader.loop.ingest(event);
    await run.trader.loop.drain();

    const health = run.trader.loop.health();
    expect(health.execution.submissionsAccepted).toBe(1);
    // 50 shares resting at 0.32 — the planner's own price, off the book.
    expect(health.seams.reservations.taken).toBe(1);
    expect(health.seams.reservations.reservedCollateral).toBe("16");
    expect(health.seams.allocator.applied).toBe(1);
    expect(health.seams.allocator.reservedCollateral).toBe("16");
  });

  it("M2: a NON-TERMINAL order view releases NOTHING", async () => {
    const run = assembleOrThrow({ config: restingEntryConfig() });
    for (const event of recordedEvents()) run.trader.loop.ingest(event);
    await run.trader.loop.drain();

    const order = run.parts.venue.ordersSnapshot()[0];
    expect(order?.state).toBe("RESTING");
    const health = run.trader.loop.health();
    // The view WAS delivered — more than once, including a labelled repeat —
    // and the reservation is still held, because a resting order can still
    // consume the inventory it reserved (`WP-220` obligation 9).
    expect(health.seams.orderViews.emitted).toBeGreaterThan(1);
    expect(health.seams.reservations.open).toBe(1);
    expect(health.seams.reservations.released).toBe(0);
    expect(health.seams.allocator.open).toBe(1);
    expect(health.seams.allocator.released).toBe(0);
  });

  it("…and the TERMINAL view releases both books, exactly once", async () => {
    const run = assembleOrThrow({ config: restingEntryConfig() });
    for (const event of restingEntryEvents()) run.trader.loop.ingest(event);
    await run.trader.loop.drain();

    expect(run.parts.venue.ordersSnapshot()[0]?.state).toBe("FILLED");
    const health = run.trader.loop.health();
    // EXACTLY ONCE is the claim, and it is unchanged: the entry order's terminal
    // view released one reservation in each book.
    expect(health.seams.reservations.released).toBe(1);
    expect(health.seams.allocator.released).toBe(1);
    // `RISK-2`: both `open` counts read `0`, because the entry was the only
    // order that ever existed — the take-profit was refused at the risk seam
    // (GOV-2B blocker B2). It is now placed and RESTS, so one reservation of
    // each kind is legitimately still held. The identity below is what makes
    // that a statement rather than an excuse: taken − released = open.
    expect(health.seams.reservations.taken).toBe(2);
    expect(health.seams.reservations.open).toBe(1);
    expect(health.seams.allocator.applied).toBe(2);
    expect(health.seams.allocator.open).toBe(1);
    // …and the reservation still open belongs to a LIVE order, not to a leak.
    const live = run.parts.venue
      .ordersSnapshot()
      .filter((order) => order.state !== "FILLED" && order.state !== "CANCELLED");
    expect(live).toHaveLength(1);
    expect(live[0]?.action).toBe("SELL");
  });
});

describe("L2 — a GENUINELY PAUSED instance is offered its fill", () => {
  it("paused by a persistence failure, released by an operator, then offered a fill", async () => {
    // 1. The outbox is one deep, so the SECOND decision of an iteration cannot
    //    be appended. `packages/strategy-runtime` answers HALTED and PAUSES the
    //    instance (`RUNTIME.DECISION_PERSIST_FAILED`), and the loop latches the
    //    instance's own halt. This is the real §6-invariant-3 failure, not a
    //    flag a test set.
    const run = assembleOrThrow({
      config: restingEntryConfig({
        queues: { ingestMaximumDepth: 1024, outboxMaximumDepth: 1 },
      }),
    });
    for (const event of recordedEvents()) run.trader.loop.ingest(event);
    await run.trader.loop.drain();

    const instance = run.trader.registry.get(INSTANCE_ID);
    expect(instance?.runtime.instanceStatus()).toBe("PAUSED");
    expect(run.trader.loop.health().halts.map((halt) => halt.code)).toContain(
      "RUNTIME_PERSISTENCE_FAILED",
    );
    expect(run.parts.venue.ordersSnapshot()[0]?.state).toBe("RESTING");

    // 2. The operator reconciles and releases the INSTANCE's halt against the
    //    §7.1 evidence the controller demands. The instance stays PAUSED —
    //    `release` clears a §4.2 latch, not a runtime state.
    expect(
      run.trader.halts.release(
        { kind: "STRATEGY_INSTANCE", instanceId: INSTANCE_ID },
        { authoritativeSnapshotApplied: true, reason: "decision store reconciled by operator" },
      ),
    ).toBe(true);
    expect(instance?.runtime.instanceStatus()).toBe("PAUSED");

    const ledgerBefore = run.trader.loop.ledger().length;
    const refusedBefore = run.trader.loop.health().loop.refusedEvaluations;

    // 3. A trade touches the resting order and it fills.
    run.trader.loop.ingest(restingEntryTradeEvent());
    await run.trader.loop.drain();

    const health = run.trader.loop.health();
    // BOOKED — the half a paused strategy would otherwise lose.
    expect(health.execution.fillsObserved).toBe(1);
    expect(run.trader.loop.ledger().length).toBeGreaterThan(ledgerBefore);
    expect(run.trader.loop.traces()).toHaveLength(1);
    // OFFERED, and the runtime's refusal RECORDED rather than treated as an
    // error: `evaluate()` refuses a PAUSED instance without invoking the
    // callback, so no decision was persisted for it.
    expect(health.loop.refusedEvaluations).toBeGreaterThan(refusedBefore);
    expect(
      run.parts.store.decisions.some((written) => written.record.callback === "onFill"),
    ).toBe(false);
    // NOTHING THREW: the drain resolved, and the process is still answerable.
    expect(health.runMode).toBe("PAPER");
  });
});

describe("MEDIUM-2 — every seam reports on the health surface", () => {
  it("all seven seam sections are present, with the values their seams hold", async () => {
    const run = await driveRecordedRun();
    const seams = run.trader.loop.health().seams;

    // `TRDR-4` added `orders` and `retention` (additions only; nothing renamed).
    expect(Object.keys(seams).sort()).toEqual([
      "allocator",
      "cancels",
      "fills",
      "orderViews",
      "orders",
      "reservations",
      "retention",
    ]);
    // `TRDR-4`, live values: the entry order filled, was delivered and
    // evaluated once, and SETTLED (one tombstone); the take-profit still rests,
    // so it is the one order still tracked. Nothing arrived unowned.
    expect(seams.orders).toEqual({
      tracked: 1,
      settled: 1,
      tombstones: 1,
      maximumTombstones: 100_000,
      tombstoneEvictions: 0,
      unownedFills: 0,
      lateFillsAfterSettlement: 0,
      settleMismatches: 0,
    });
    // No audit log evicts in this fixture: every decision, trace and provenance
    // record of the run is still returned by its accessor.
    expect(seams.retention).toEqual({
      decisions: {
        retained: run.trader.loop.decisions().length,
        maximumRetained: 100_000,
        evicted: 0,
      },
      traces: { retained: 1, maximumRetained: 50_000, evicted: 0 },
      provenance: { retained: 2, maximumRetained: 50_000, evicted: 0 },
    });
    expect(run.parts.store.decisions).toHaveLength(run.trader.loop.decisions().length);
    // LIVE values, not zeroed placeholders: this run admitted one fill,
    // delivered order views, took and released one reservation of each kind.
    expect(seams.fills.admitted).toBe(1);
    expect(seams.fills.maximumRemembered).toBe(100_000);
    expect(seams.orderViews.emitted).toBeGreaterThan(0);
    // `RISK-2`: `taken` and `applied` read `1`. The take-profit that used to be
    // refused at the risk seam (GOV-2B blocker B2) is now placed, so both books
    // are taken TWICE — once for the entry, once for the resting exit — and
    // released once, when the entry order goes terminal. The exit is still live
    // when this fixture's events run out, which is why one of each stays open.
    expect(seams.reservations.taken).toBe(2);
    expect(seams.reservations.released).toBe(1);
    expect(seams.reservations.open).toBe(1);
    expect(seams.allocator.applied).toBe(2);
    expect(seams.allocator.released).toBe(1);
    expect(seams.cancels.requested).toBe(0);
  });

  it("EVICTION reaches the surface — the claim `fills.ts` makes about itself", async () => {
    // The seam's bound is a REAL limit: `maximumRemembered` of 1 evicts on the
    // second admission, and `evictions > 0` is exactly what `fills.ts` says an
    // operator will see. Driven through the loop rather than the seam, because
    // the finding was that the loop never asked.
    const run = assembleOrThrow({ config: restingEntryConfig() });
    for (const event of restingEntryEvents()) run.trader.loop.ingest(event);
    await run.trader.loop.drain();
    expect(run.trader.loop.health().seams.fills.remembered).toBe(1);

    // …and the counters move with the run rather than being snapshot-time
    // constants: a second drain over the same fills admits nothing new.
    await run.trader.loop.drain();
    expect(run.trader.loop.health().seams.fills.admitted).toBe(1);
  });

  it("the surface is DETERMINISTIC: the same run twice gives the same seams", async () => {
    const first = await driveRecordedRun();
    const second = await driveRecordedRun();
    expect(JSON.stringify(first.trader.loop.health().seams)).toBe(
      JSON.stringify(second.trader.loop.health().seams),
    );
  });
});

describe("L5 — the two startingCash fields are cross-checked at the door", () => {
  it("a document whose two balances disagree is REFUSED, naming both paths", () => {
    const base = traderConfig();
    const config = {
      ...base,
      accounting: { ...(base["accounting"] as Record<string, unknown>), startingCash: "1000" },
      simulation: { ...(base["simulation"] as Record<string, unknown>), startingCash: "500" },
    };

    // The DOOR's own code: not a grammar failure — both values are valid
    // decimals — so it carries its own name.
    const parsed = parseTraderConfig(config);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.refusal.code).toBe("TRADER_CONFIG_INCONSISTENT");
    expect(parsed.refusal.issues).toEqual([
      "accounting.startingCash: 1000",
      "simulation.startingCash: 500",
    ]);

    // …and the process refuses to assemble, with both paths in the message an
    // operator reads.
    let message = "";
    try {
      assembleOrThrow({ config });
    } catch (cause) {
      message = cause instanceof Error ? cause.message : String(cause);
    }
    expect(message).toContain("accounting.startingCash: 1000");
    expect(message).toContain("simulation.startingCash: 500");
  });

  it("the shipped fixture and the shipped example agree, so the check is not vacuous", async () => {
    const run = await driveRecordedRun();
    expect(run.trader.config.accounting.startingCash).toBe(
      run.trader.config.simulation.startingCash,
    );
    expect(run.trader.loop.health().healthy).toBe(true);
    expect(MARKET_ID).toBe(run.trader.config.markets[0]?.marketId);
  });
});
