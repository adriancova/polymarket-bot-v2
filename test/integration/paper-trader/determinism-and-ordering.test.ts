/**
 * §12.4 determinism and §8.2 / §8.4 ordering, through the assembled loop.
 *
 * > "A fixed dataset, code commit, config, feature version, model version,
 * > simulator version, and seed must produce byte-identical: decisions,
 * > intents, risk results, execution plans, simulated order events, fills,
 * > ledger events, PnL outputs."
 *   — handoff §12.4
 *
 * The claim tested here is the packet's own phrasing of it: **the same recorded
 * fixture through the trader's core loop twice produces byte-identical decision
 * and ledger chains.** "Byte-identical" is taken literally — the two runs are
 * serialized with a canonical JSON stringifier (sorted keys, so key order cannot
 * silently differ) and compared as STRINGS, not with a structural matcher that
 * would tolerate a difference a byte comparison would not.
 *
 * Two things make the claim non-vacuous, and both are asserted:
 *
 * 1. the run is not empty — it decides, plans, fills and books;
 * 2. a DIFFERENT id namespace produces DIFFERENT bytes, so the comparison is
 *    measuring something rather than comparing two constants.
 */

import { describe, expect, it } from "vitest";

import { INSTANCE_ID, MARKET_ID, recordedEvents } from "./support/fixture.js";
import { assembleOrThrow, driveRecordedRun } from "./support/run.js";

/** Canonical JSON: sorted keys, so two equal values have one spelling. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

/** The artefacts §12.4 names, as one byte string. */
function runBytes(run: Awaited<ReturnType<typeof driveRecordedRun>>): string {
  return canonical({
    decisions: run.trader.loop.decisions(),
    traces: run.trader.loop.traces(),
    ledger: run.trader.loop
      .ledger()
      .transactions()
      .map((appended) => ({ sequence: appended.sequence, transaction: appended.transaction })),
    pnl: run.trader.loop.pnlRecords(INSTANCE_ID),
    orders: run.parts.venue.ordersSnapshot(),
    fills: run.parts.venue.fills,
    persistedDecisions: run.parts.store.decisions.map((written) => written.record),
    persistedCheckpoints: run.parts.store.checkpoints,
    persistedTransactions: run.parts.store.transactions,
    persistedPnl: run.parts.store.pnlSnapshots,
    health: {
      loop: run.trader.loop.health().loop,
      risk: run.trader.loop.health().risk,
      execution: run.trader.loop.health().execution,
      accounting: run.trader.loop.health().accounting,
    },
  });
}

describe("§12.4 determinism", () => {
  it("the run is not vacuous: it decides, plans, fills and books", async () => {
    const run = await driveRecordedRun();
    const health = run.trader.loop.health();
    expect(health.loop.decisionsPersisted).toBeGreaterThan(0);
    expect(health.execution.plansBuilt).toBeGreaterThan(0);
    expect(health.execution.fillsObserved).toBeGreaterThan(0);
    expect(health.accounting.ledgerTransactions).toBeGreaterThan(0);
    expect(run.trader.loop.traces()).toHaveLength(1);
  });

  it("the SAME fixture through the loop TWICE produces BYTE-IDENTICAL chains", async () => {
    const first = await driveRecordedRun({ idNamespace: "determinism" });
    const second = await driveRecordedRun({ idNamespace: "determinism" });
    const left = runBytes(first);
    const right = runBytes(second);
    expect(left.length).toBeGreaterThan(1000);
    expect(right).toBe(left);
  });

  it("the comparison MEASURES something: a different id namespace changes the bytes", async () => {
    const first = await driveRecordedRun({ idNamespace: "determinism" });
    const other = await driveRecordedRun({ idNamespace: "a-different-run" });
    expect(runBytes(other)).not.toBe(runBytes(first));
    // …and it differs in the IDENTIFIERS, not in the economics: the decision
    // stream is identical because the strategy saw identical inputs.
    expect(canonical(other.trader.loop.decisions())).toBe(
      canonical(first.trader.loop.decisions()),
    );
  });

  it("no wall clock is read: two runs at different host instants agree", async () => {
    const first = await driveRecordedRun({ idNamespace: "determinism" });
    // A deliberate pause between runs. A loop that read `Date.now()` anywhere
    // would produce different instants in its records; this one does not.
    await new Promise((resolve) => setTimeout(resolve, 25));
    const second = await driveRecordedRun({ idNamespace: "determinism" });
    expect(runBytes(second)).toBe(runBytes(first));
  });
});

describe("§8.2 stable strategy order and §6 invariant 11", () => {
  it("the run manifest records the evaluation order, and it is the order the loop uses", () => {
    const run = assembleOrThrow();
    const manifest = run.trader.manifest;
    expect(manifest).toHaveLength(1);
    expect(manifest[0]?.instanceId).toBe(INSTANCE_ID);
    expect(manifest[0]?.ownership).toBe("OWNER");
    expect(manifest[0]?.position).toBe(0);
    // The manifest is produced FROM the evaluation order, so it cannot describe
    // an order the loop does not walk.
    expect(run.trader.registry.evaluationOrder().map((instance) => instance.instanceId)).toEqual(
      manifest.map((row) => row.instanceId),
    );
  });

  it("a SECOND live owner of one market is refused at startup (§6 invariant 11, ADR-011)", () => {
    const run = assembleOrThrow();
    const first = run.trader.registry.evaluationOrder()[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    const conflict = run.trader.registry.register({
      ...first,
      instanceId: "b18f4a7e-9999-7abc-8def-0123456789ab",
    });
    expect(conflict.ok).toBe(false);
    if (conflict.ok) return;
    expect(conflict.code).toBe("MARKET_ALREADY_OWNED");
    expect(conflict.detail).toContain("exactly one live owner per market");
  });

  it("the owner sorts before a shadow, then priority, then instance id", () => {
    const run = assembleOrThrow();
    const base = run.trader.registry.evaluationOrder()[0];
    expect(base).toBeDefined();
    if (base === undefined) return;
    run.trader.registry.register({
      ...base,
      instanceId: "c18f4a7e-0000-7abc-8def-0123456789ab",
      ownership: "SHADOW",
      evaluationPriority: 0,
    });
    run.trader.registry.register({
      ...base,
      instanceId: "b18f4a7e-0000-7abc-8def-0123456789ab",
      ownership: "SHADOW",
      evaluationPriority: 0,
    });
    const order = run.trader.registry.evaluationOrder().map((instance) => instance.instanceId);
    // OWNER first; the two shadows then break their priority tie by id.
    expect(order[0]).toBe(INSTANCE_ID);
    expect(order.slice(1)).toEqual([
      "b18f4a7e-0000-7abc-8def-0123456789ab",
      "c18f4a7e-0000-7abc-8def-0123456789ab",
    ]);
  });
});

describe("§8.4 replay ordering", () => {
  it("the loop processes events in DELIVERY order and never sorts by venue timestamp", async () => {
    const run = assembleOrThrow();
    // The fixture's events carry ASCENDING `ingestSeq` and the loop consumes
    // them in the order handed to it. A loop that sorted would produce the same
    // answer here, so the discriminating check is the NEXT one.
    for (const event of recordedEvents()) run.trader.loop.ingest(event);
    await run.trader.loop.drain();
    expect(run.trader.loop.health().loop.eventsProcessed).toBe(recordedEvents().length);
  });

  it("a book update delivered OUT of ingest order is refused by the book, not silently reordered", async () => {
    const run = assembleOrThrow();
    const events = [...recordedEvents()];
    for (const event of events) run.trader.loop.ingest(event);
    await run.trader.loop.drain();

    // A level change carrying an ingestSeq the book has already passed is
    // REFUSED by `packages/order-book`'s epoch/sequence gating, and the loop
    // turns that refusal into a market halt rather than applying it out of
    // order (§8.4: replay follows information arrival order).
    const { ingested } = await import("./support/fixture.js");
    run.trader.loop.ingest(
      ingested(
        "BookLevelChanged",
        {
          internalMarketId: MARKET_ID,
          tokenId: "111",
          side: "ASK",
          price: "0.34",
          size: "999",
        },
        { receivedAt: "2026-03-04T12:00:04.000Z", ingestSeq: 1 },
      ),
    );
    await run.trader.loop.drain();
    expect(run.trader.halts.isMarketHalted(MARKET_ID)).toBe(true);
    const halt = run.trader.halts
      .records()
      .find((record) => record.code === "BOOK_DESYNCHRONIZED");
    expect(halt).toBeDefined();
    expect(halt?.action).toBe("CANCEL_RESTING_ORDERS");
  });
});
