/**
 * `CO2-N1` (ADR-031, option (a): an entry guard on the process clock, through
 * existing inputs, entries only) — on the paper-trader fixture: the REAL
 * assembled trader, the Static Bracket strategy, the fixture's recorded
 * events, its permissive risk policy, and its `ManualClock`.
 *
 * - **T1, the closeout's probe** (`CLOSEOUT-2` N1, auditor finding E-02): the
 *   fixture's events, the clock at `12:30:00.000Z`, the market closing at
 *   `12:15:00`, the last event at `12:00:03`. On `8fde4df` and `9ce53a1` the
 *   entry was approved and FILLED. Now both criteria refuse it.
 * - **T2**, the close criterion alone, at its exact boundary pair.
 * - **T3**, a lagging trader: the clock positioned at each event plus L.
 * - **T6** (the in-repository half): the clock positioned at each event (lag
 *   0, as replay positions it) decides exactly what the fixture's own clock
 *   decides, byte for byte. The base-commit half and `test:replay` are in the
 *   `CO2-N1` handoff.
 * - **T10**, durability held across a bound: the entry decision's group
 *   commit is held open while the clock moves; the read sees where it moved.
 *
 * The exact risk inputs (R2-R6), T5, T7, T8, T9 and T11 are pinned at the
 * loop, in `packages/trading-core/src/loop-admission-clock.test.ts`; T4, the
 * shipped `SystemPaperClock`, in `admission-host-clock-postgres.test.ts`.
 *
 * In-memory, as the rest of this suite outside its container files. PAPER
 * only; no network, venue, credential, signer or real order.
 */

import type { GroupCommit, IngestedEvent, StagedEvaluations, TraderStore } from "@polymarket-bot/trader";
import { portOk } from "@polymarket-bot/trader";
import type { MemoryTraderStore } from "@polymarket-bot/trader/testing";
import { describe, expect, it } from "vitest";

import {
  assemble,
  recordedEvents,
  riskPolicy,
  T_CLOSE,
  traderConfig,
  type Assembled,
} from "./support/fixture.js";
import { FIXTURE_FIRST_EVENT_AT } from "./support/host-clock.js";

/** The fixture's configuration with its features bound replaced (ms). */
function withFeaturesBound(featuresMaxAgeMs: number): Record<string, unknown> {
  const policy = riskPolicy();
  return traderConfig({
    riskPolicy: { ...policy, freshness: { ...(policy["freshness"] as Record<string, unknown>), featuresMaxAgeMs } },
  });
}

function assembled(options: Parameters<typeof assemble>[0] = {}): Assembled {
  const { result, parts } = assemble(options);
  if (!result.ok || parts === undefined) throw new Error("the fixture refused to assemble");
  return parts;
}

/** Ingests every event at once and drains, as a pump hands a batch to the loop. */
async function runBatch(parts: Assembled, events: readonly IngestedEvent[]): Promise<void> {
  for (const event of events) expect(parts.trader.loop.ingest(event)).toBe(true);
  await parts.trader.loop.drain();
}

/** One event per drain, the clock positioned by `readingFor` before each (monotonic time unchanged, as the fixture keeps it). */
async function runPositioned(
  parts: Assembled,
  events: readonly IngestedEvent[],
  readingFor: (receivedAtMs: number) => string,
): Promise<void> {
  for (const event of events) {
    parts.clock.positionAt(readingFor(Date.parse(event.envelope.receivedAt)), 0n);
    expect(parts.trader.loop.ingest(event)).toBe(true);
    await parts.trader.loop.drain();
  }
}

function plus(lagMs: number): (receivedAtMs: number) => string {
  return (receivedAtMs) => new Date(receivedAtMs + lagMs).toISOString();
}

/** Every refusal's codes, from the durable `ops.risk_events` evidence (`PROVENANCE-1`). */
function durableRefusalCodes(store: MemoryTraderStore): readonly (readonly string[])[] {
  return store.riskRefusals.map((refusal) => refusal.refusals.map((entry) => entry.code));
}

// ---------------------------------------------------------------------------
// T1: the closeout's probe
// ---------------------------------------------------------------------------

describe("ADR-031 T1: the closeout's probe — recorded events through a trader whose clock reads 12:30", () => {
  it("the market closed at 12:15 and the last event is 12:00:03: no approval, no fill; every refusal is RISK_FEATURES_STALE AND RISK_TIME_TO_CLOSE_ENTRY_BLOCKED", async () => {
    const parts = assembled();
    parts.clock.positionAt("2026-03-04T12:30:00.000Z", 0n);
    const events = recordedEvents();
    expect(events.at(-1)?.envelope.receivedAt).toBe("2026-03-04T12:00:03.000Z");
    expect(T_CLOSE).toBe("2026-03-04T12:15:00.000Z");
    await runBatch(parts, events);

    const health = parts.trader.loop.health();
    expect(health.risk.approvals).toBe(0);
    expect(health.risk.refusals).toBeGreaterThanOrEqual(1);
    // The lag (at least 1 797 000 ms against the fixture's 600 000 ms bound)
    // is not on any surface; the codes are. Each counts EVERY refusal.
    expect(health.risk.refusalsByCode).toEqual({
      RISK_FEATURES_STALE: health.risk.refusals,
      RISK_TIME_TO_CLOSE_ENTRY_BLOCKED: health.risk.refusals,
    });
    expect(health.execution.plansBuilt).toBe(0);
    expect(health.execution.fillsObserved).toBe(0);
    expect(parts.venue.fills).toHaveLength(0);
    expect(parts.store.transactions).toHaveLength(0);
    expect(health.halts).toEqual([]);
    // The strategy still decided to enter (strategy time is event time), and
    // the refusal is durable evidence with both codes.
    expect(parts.trader.loop.decisions().some((decision) => decision.decisionType === "enter")).toBe(true);
    expect(durableRefusalCodes(parts.store)).toEqual(
      parts.store.riskRefusals.map(() => ["RISK_FEATURES_STALE", "RISK_TIME_TO_CLOSE_ENTRY_BLOCKED"]),
    );
    expect(parts.store.riskRefusals.length).toBe(health.risk.refusals);
  });

  it("control: the same events with the fixture's own clock (12:00:00, before every entry) approve the entry and fill it", async () => {
    const parts = assembled();
    await runBatch(parts, recordedEvents());
    const health = parts.trader.loop.health();
    expect(health.risk.approvals).toBeGreaterThanOrEqual(1);
    expect(health.risk.refusals).toBe(0);
    expect(parts.venue.fills.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// T2: the close criterion alone
// ---------------------------------------------------------------------------

describe("ADR-031 T2: the close criterion alone — the lag inside its bound, the event instant outside the cutoff", () => {
  // The entry is decided at 12:00:02 (Static Bracket arms on the YES book and
  // enters on the NO book). The cutoff is 30 s before the 12:15:00 close, so
  // the boundary pair is 12:14:30 and 12:14:29. The features bound is raised
  // to 900 000 ms so the 868 s lag there stays inside it: only the close
  // criterion can refuse.
  const config = withFeaturesBound(900_000);

  it("the process instant at exactly close − entryCutoffSeconds (12:14:30): refused, RISK_TIME_TO_CLOSE_ENTRY_BLOCKED only", async () => {
    const parts = assembled({ config });
    parts.clock.positionAt("2026-03-04T12:14:30.000Z", 0n);
    await runBatch(parts, recordedEvents());
    const health = parts.trader.loop.health();
    expect(health.risk.approvals).toBe(0);
    expect(health.risk.refusals).toBeGreaterThanOrEqual(1);
    expect(health.risk.refusalsByCode).toEqual({ RISK_TIME_TO_CLOSE_ENTRY_BLOCKED: health.risk.refusals });
    expect(parts.venue.fills).toHaveLength(0);
  });

  it("one second earlier (12:14:29, close − (entryCutoffSeconds + 1) s): approved, every other check passing, and filled", async () => {
    const parts = assembled({ config });
    parts.clock.positionAt("2026-03-04T12:14:29.000Z", 0n);
    await runBatch(parts, recordedEvents());
    const health = parts.trader.loop.health();
    expect(health.risk.approvals).toBeGreaterThanOrEqual(1);
    expect(health.risk.refusals).toBe(0);
    expect(parts.venue.fills.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// T3: a lagging trader
// ---------------------------------------------------------------------------

describe("ADR-031 T3: a lagging trader — the clock at each event's instant plus L (the fixture's 600 000 ms bound)", () => {
  it("L equal to the bound: approved and filled", async () => {
    const parts = assembled();
    await runPositioned(parts, recordedEvents(), plus(600_000));
    const health = parts.trader.loop.health();
    expect(health.risk.approvals).toBeGreaterThanOrEqual(1);
    expect(health.risk.refusals).toBe(0);
    expect(parts.venue.fills.length).toBeGreaterThanOrEqual(1);
  });

  it("L one millisecond above it: refused, RISK_FEATURES_STALE only, nothing filled", async () => {
    const parts = assembled();
    await runPositioned(parts, recordedEvents(), plus(600_001));
    const health = parts.trader.loop.health();
    expect(health.risk.approvals).toBe(0);
    expect(health.risk.refusals).toBeGreaterThanOrEqual(1);
    expect(health.risk.refusalsByCode).toEqual({ RISK_FEATURES_STALE: health.risk.refusals });
    expect(parts.venue.fills).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// T6: the clock positioned at each event decides what the fixture decides
// ---------------------------------------------------------------------------

/** Everything the run made durable, the venue's fills, and the loop's counters. */
function runContent(parts: Assembled): string {
  return JSON.stringify(
    {
      decisions: parts.store.decisions.map((entry) => entry.record),
      checkpoints: parts.store.checkpoints,
      instants: parts.store.checkpointInstants,
      transactions: parts.store.transactions,
      snapshots: parts.store.pnlSnapshots,
      refusals: parts.store.riskRefusals,
      fills: parts.venue.fills,
      provenance: parts.trader.loop.orderProvenance(),
      risk: parts.trader.loop.health().risk,
      execution: parts.trader.loop.health().execution,
    },
    (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value),
  );
}

describe("ADR-031 T6 (in-repository half): a clock positioned at each event (lag 0, as replay positions it) changes nothing", () => {
  it("the fixture's run with its clock at each event's instant is byte-identical to the run on the fixture's own clock", async () => {
    const own = assembled();
    await runPositioned(own, recordedEvents(), () => "2026-03-04T12:00:00.000Z");
    const positioned = assembled();
    await runPositioned(positioned, recordedEvents(), plus(0));
    expect(own.venue.fills.length).toBeGreaterThanOrEqual(1);
    expect(runContent(positioned)).toBe(runContent(own));
  });
});

// ---------------------------------------------------------------------------
// T10: durability held across a bound
// ---------------------------------------------------------------------------

/** A group commit over the fixture's store that HOLDS the commit carrying an intent-bearing decision until released. */
function holdingGroupCommit(inner: MemoryTraderStore): {
  readonly store: TraderStore;
  readonly held: Promise<void>;
  readonly release: () => void;
} {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reached: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const staged: StagedEvaluations[] = [];
  const group: GroupCommit = {
    stage(evaluations) {
      staged.push(evaluations);
      return portOk(null);
    },
    get stagedEvents() {
      return staged.length;
    },
    async commit() {
      const batch = staged.splice(0, staged.length);
      if (batch.some((evaluation) => evaluation.decisions.some((entry) => entry.record.decision.intents.length > 0))) {
        reached();
        await gate;
      }
      let decisions = 0;
      let checkpoints = 0;
      for (const evaluation of batch) {
        for (const entry of evaluation.decisions) {
          await inner.persistDecision(entry.record, entry.telemetry);
          decisions += 1;
        }
        for (const entry of evaluation.checkpoints) {
          await inner.saveCheckpoint(entry.checkpoint, entry.capturedAt);
          checkpoints += 1;
        }
        for (const refusal of evaluation.riskRefusals) await inner.persistRiskRefusal(refusal);
      }
      return portOk({ decisions, checkpoints });
    },
  };
  return {
    held,
    release,
    store: {
      persistDecision: (record, telemetry) => inner.persistDecision(record, telemetry),
      persistDecisionWithCheckpoint: (record, telemetry, checkpoint, capturedAt) =>
        inner.persistDecisionWithCheckpoint(record, telemetry, checkpoint, capturedAt),
      appendLedgerTransaction: (transaction) => inner.appendLedgerTransaction(transaction),
      writePnlSnapshot: (snapshot) => inner.writePnlSnapshot(snapshot),
      replacePnlSnapshot: (snapshot) => inner.replacePnlSnapshot(snapshot),
      persistRiskRefusal: (refusal) => inner.persistRiskRefusal(refusal),
      close: () => inner.close(),
      groupCommit: group,
    },
  };
}

describe("ADR-031 T10: the entry decision's commit is HELD while the clock moves across a bound", () => {
  async function heldWhileMoving(config: Record<string, unknown> | undefined, movedTo: string): Promise<Assembled> {
    let holding: ReturnType<typeof holdingGroupCommit> | undefined;
    const parts = assembled({
      ...(config === undefined ? {} : { config }),
      wrapStore: (inner) => {
        holding = holdingGroupCommit(inner);
        return holding.store;
      },
    });
    if (holding === undefined) throw new Error("the store was not wrapped");
    expect(parts.trader.loop.groupCommits).toBe(true);
    // The fixture's clock (12:00:00) is before every event: lag 0 until it moves.
    for (const event of recordedEvents()) expect(parts.trader.loop.ingest(event)).toBe(true);
    const drained = parts.trader.loop.drain();
    await holding.held;
    for (let turn = 0; turn < 10; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    // Held at the boundary: nothing was judged yet.
    expect(parts.trader.loop.health().risk.evaluations).toBe(0);
    parts.clock.positionAt(movedTo, 0n);
    holding.release();
    await drained;
    return parts;
  }

  it("from inside the lag bound to beyond it (the 12:00:02 entry, the clock moved to 12:10:02.001): refused RISK_FEATURES_STALE, nothing submitted", async () => {
    const parts = await heldWhileMoving(undefined, "2026-03-04T12:10:02.001Z");
    const health = parts.trader.loop.health();
    expect(health.risk.approvals).toBe(0);
    expect(health.risk.refusalsByCode).toEqual({ RISK_FEATURES_STALE: health.risk.refusals });
    expect(health.execution.plansBuilt).toBe(0);
    expect(parts.venue.fills).toHaveLength(0);
  });

  it("from outside the entry cutoff to inside it (the clock moved to 12:14:30, the lag still inside a 900 000 ms bound): refused RISK_TIME_TO_CLOSE_ENTRY_BLOCKED, nothing submitted", async () => {
    const parts = await heldWhileMoving(withFeaturesBound(900_000), "2026-03-04T12:14:30.000Z");
    const health = parts.trader.loop.health();
    expect(health.risk.approvals).toBe(0);
    expect(health.risk.refusalsByCode).toEqual({ RISK_TIME_TO_CLOSE_ENTRY_BLOCKED: health.risk.refusals });
    expect(health.execution.plansBuilt).toBe(0);
    expect(parts.venue.fills).toHaveLength(0);
  });

  it("control: released without moving the clock, the same held entry is approved and filled", async () => {
    const parts = await heldWhileMoving(undefined, "2026-03-04T12:00:00.000Z");
    expect(parts.trader.loop.health().risk.approvals).toBeGreaterThanOrEqual(1);
    expect(parts.venue.fills.length).toBeGreaterThanOrEqual(1);
  });
});

describe("the migration anchor (`support/host-clock.ts`)", () => {
  it("FIXTURE_FIRST_EVENT_AT is the instant of the fixture's first recorded event", () => {
    expect(recordedEvents()[0]?.envelope.receivedAt).toBe(FIXTURE_FIRST_EVENT_AT);
  });
});
