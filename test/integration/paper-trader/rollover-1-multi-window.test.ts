/**
 * `ROLLOVER-1` — one PAPER run trades a SERIES across its windows (ADR-030
 * Decisions 1-5; the user's rulings A5, Q1-Q4), end to end and in memory:
 * the REAL gateway composition (on the data-gateway suite's harness, with
 * VENUE-SETL-1's recorded Gamma keyset page and CLOB market-info bodies on
 * its HTTP port) admits the windows, and the REAL trader composition root
 * consumes exactly what the gateway published, in the gateway's order.
 *
 * What is proven, by name:
 *
 * 1. **Admission in the trader** — the trader admits each window the gateway
 *    admitted, after re-judging it against its OWN copy of the review, and
 *    writes the window's catalog row before anything names it.
 * 2. **One run, one sequence** (ruling Q2) — every decision of the run, over
 *    every window, carries a distinct `evaluationSeq`, in order, with no
 *    reuse: the per-window runtimes share the run's sequence.
 * 3. **Teardown and the cap** — the resolved, idle window is torn down
 *    (released from the books, the registry and the cadence; its ledger rows
 *    stay), which frees the cap for the next window; the trader enforces the
 *    cap itself, whatever arrives.
 * 4. **Replay** (acceptance 3) — the recorded envelopes, fed to a fresh
 *    trader with no gateway and no venue, reproduce every admission, every
 *    teardown and every decision, byte for byte.
 * 5. **Exact match in the trader** — a trader whose run pins another review
 *    admits nothing (`REVIEW_MISMATCH`), and a catalog write that fails halts
 *    the trader rather than trade a window without its row.
 */

import type { EventEnvelope } from "@polymarket-bot/domain";
import type { AdmissionNotice } from "@polymarket-bot/trader";
import { describe, expect, it } from "vitest";

import { assembleOrThrow } from "./support/run.js";
import { ingestedOf, review, SERIES_RUN_ID, seriesConfig, seriesStream, W1, W2, W3 } from "./support/series-windows.js";

const stream = seriesStream;

async function trade(envelopes: readonly EventEnvelope<unknown>[], options: { readonly series?: Record<string, unknown> } = {}) {
  const notices: AdmissionNotice[] = [];
  const run = assembleOrThrow({
    config: seriesConfig(options.series),
    idNamespace: "rollover-1",
    onAdmission: (notice) => notices.push(notice),
  });
  for (const event of ingestedOf(envelopes)) run.trader.loop.ingest(event);
  await run.trader.loop.drain();
  return { run, notices };
}

function noticeLine(notice: AdmissionNotice): string {
  switch (notice.kind) {
    case "ADMITTED":
      return `ADMITTED ${notice.window.marketId}`;
    case "REFUSED":
      return `REFUSED ${notice.code} ${notice.marketId ?? "-"}`;
    case "TORN_DOWN":
      return `TORN_DOWN ${notice.window.marketId} ${notice.reason}`;
  }
}

describe("ROLLOVER-1: one PAPER run trades a series across its windows", () => {
  it("the gateway admits W1 and W2, holds W3 at the cap, and admits it once W1 is resolved and torn down", async () => {
    const published = await stream();
    const admitted = published
      .filter((envelope) => envelope.eventType === "SeriesWindowAdmitted")
      .map((envelope) => (envelope.payload as { internalMarketId: string }).internalMarketId);
    expect(admitted).toEqual([W1.marketId, W2.marketId, W3.marketId]);
    const opened = published
      .filter((envelope) => envelope.eventType === "MarketOpened")
      .map((envelope) => (envelope.payload as { internalMarketId: string }).internalMarketId);
    expect(opened).toEqual(expect.arrayContaining([W1.marketId, W2.marketId]));
    const cap = published.find(
      (envelope) =>
        envelope.eventType === "DataQualityIncidentOpened" &&
        (envelope.payload as { reasonCode: string }).reasonCode === "GATEWAY_SERIES_CAP_REACHED",
    );
    expect((cap?.payload as { affectedMarketIds?: string[] } | undefined)?.affectedMarketIds).toEqual([W3.marketId]);
    // No admission incident is market-less (it would taint every book: ADR-023 D2 rule 4).
    for (const envelope of published.filter((entry) => entry.eventType === "DataQualityIncidentOpened")) {
      const payload = envelope.payload as { feedId?: string; affectedMarketIds?: string[]; reasonCode: string };
      if (payload.feedId === "polymarket-series-admission") expect(payload.affectedMarketIds?.length, payload.reasonCode).toBeGreaterThan(0);
    }
  });

  it("the trader admits each window after its own re-judge, writes its catalog row first, and tears the resolved one down", async () => {
    const { run, notices } = await trade(await stream());
    expect(run.trader.loop.health().halts).toEqual([]);
    expect(notices.map(noticeLine)).toEqual([
      `ADMITTED ${W1.marketId}`,
      `ADMITTED ${W2.marketId}`,
      `TORN_DOWN ${W1.marketId} RESOLVED`,
      `ADMITTED ${W3.marketId}`,
    ]);
    expect(run.parts.store.admittedMarkets.map((market) => [market.marketId, market.conditionId, market.tickSize])).toEqual([
      [W1.marketId, W1.conditionId, "0.001"],
      [W2.marketId, W2.conditionId, "0.01"],
      [W3.marketId, W3.conditionId, "0.01"],
    ]);
    expect(run.parts.store.admittedMarkets[0]).toMatchObject({
      questionTitle: W1.title,
      yesTokenId: W1.yesTokenId,
      yesLabel: "Up",
      noLabel: "Down",
      minimumOrderSize: "5",
      openTime: W1.openAt,
      closeTime: W1.closeAt,
    });
    // W1 is released: no MarketState, no registration; W2 and W3 are live.
    expect(run.trader.markets.has(W1.marketId)).toBe(false);
    expect([...run.trader.markets.keys()]).toEqual([W2.marketId, W3.marketId]);
    expect(new Set(run.trader.registry.evaluationOrder().map((entry) => entry.marketId))).toEqual(new Set([W2.marketId, W3.marketId]));
    expect(run.trader.loop.admissionMetrics()).toMatchObject({ admitted: 3, tornDownResolved: 1, live: 2, refusals: {} });
  });

  it("every decision of the run, over every window, has its own evaluation sequence, in order (ruling Q2)", async () => {
    const { run } = await trade(await stream());
    const decisions = run.parts.store.decisions.map((entry) => entry.record);
    const windows = new Set(decisions.map((record) => record.marketId));
    expect(windows).toEqual(new Set([W1.marketId, W2.marketId, W3.marketId]));
    expect(new Set(decisions.map((record) => record.runId))).toEqual(new Set([SERIES_RUN_ID]));
    expect(decisions.map((record) => record.evaluationSeq)).toEqual(decisions.map((_record, index) => index));
    // W2 traded: an entry was decided, approved, submitted and filled.
    expect(decisions.some((record) => record.marketId === W2.marketId && record.decision.decisionType === "enter")).toBe(true);
    const health = run.trader.loop.health();
    expect(health.execution.fillsObserved).toBeGreaterThanOrEqual(1);
    // W1 was evaluated and held (quoted above the trigger) — and nothing after its teardown names it.
    expect(decisions.filter((record) => record.marketId === W1.marketId).every((record) => record.decision.decisionType !== "enter")).toBe(true);
    // Each window's checkpoints follow its own decisions, on the run's one sequence.
    const sequences = run.parts.store.checkpoints.map((checkpoint) => checkpoint.checkpointSeq);
    expect(new Set(sequences).size).toBe(sequences.length);
  });

  it("replay: the recorded envelopes reproduce every admission, teardown and decision, with no gateway and no venue", async () => {
    const envelopes = await stream();
    const first = await trade(envelopes);
    const second = await trade(envelopes);
    // The replay reproduces the run itself — not merely an empty one twice.
    expect(first.notices.map(noticeLine)).toEqual([
      `ADMITTED ${W1.marketId}`,
      `ADMITTED ${W2.marketId}`,
      `TORN_DOWN ${W1.marketId} RESOLVED`,
      `ADMITTED ${W3.marketId}`,
    ]);
    expect(first.run.parts.store.decisions.length).toBeGreaterThan(0);
    expect(second.notices.map(noticeLine)).toEqual(first.notices.map(noticeLine));
    expect(second.run.parts.store.admittedMarkets).toEqual(first.run.parts.store.admittedMarkets);
    expect(second.run.parts.store.decisions).toEqual(first.run.parts.store.decisions);
    expect(second.run.parts.store.checkpoints).toEqual(first.run.parts.store.checkpoints);
    expect(second.run.trader.loop.traces()).toEqual(first.run.trader.loop.traces());
  });

  it("a trader whose run pins ANOTHER review admits nothing: REVIEW_MISMATCH, and no window is traded", async () => {
    const { run, notices } = await trade(await stream(), { series: { ...review(), maximumConcurrentWindows: 3 } });
    expect(notices.map((notice) => (notice.kind === "REFUSED" ? notice.code : "-"))).toEqual([
      "REVIEW_MISMATCH",
      "REVIEW_MISMATCH",
      "REVIEW_MISMATCH",
    ]);
    expect(run.parts.store.admittedMarkets).toEqual([]);
    expect(run.parts.store.decisions).toEqual([]);
    expect(run.trader.markets.size).toBe(0);
  });

  it("the trader enforces the cap itself: a third admission while two windows are live is CAP_REACHED", async () => {
    // The stream with W1's resolution removed: W3's admission arrives while W1 and W2 are live.
    const envelopes = (await stream()).filter((envelope) => envelope.eventType !== "MarketResolved");
    const { run, notices } = await trade(envelopes);
    expect(notices.map(noticeLine)).toEqual([
      `ADMITTED ${W1.marketId}`,
      `ADMITTED ${W2.marketId}`,
      `REFUSED CAP_REACHED ${W3.marketId}`,
    ]);
    expect(run.parts.store.admittedMarkets.map((market) => market.marketId)).toEqual([W1.marketId, W2.marketId]);
    expect(run.parts.store.decisions.some((entry) => entry.record.marketId === W3.marketId)).toBe(false);
  });

  it("a catalog row that cannot be written HALTS the trader, and the window is not attached", async () => {
    const notices: AdmissionNotice[] = [];
    const run = assembleOrThrow({ config: seriesConfig(), idNamespace: "rollover-1", onAdmission: (notice) => notices.push(notice) });
    run.parts.store.failOnly(["registerAdmittedMarket"], "UNAVAILABLE", "relation catalog.markets is locked");
    for (const event of ingestedOf(await stream())) run.trader.loop.ingest(event);
    await run.trader.loop.drain();
    expect(notices[0]).toMatchObject({ kind: "REFUSED", code: "STORE_UNAVAILABLE", marketId: W1.marketId });
    // No window is EVER attached without its row: every notice is that refusal.
    expect(notices.every((notice) => notice.kind === "REFUSED" && notice.code === "STORE_UNAVAILABLE")).toBe(true);
    expect(run.trader.loop.admissionMetrics()?.admitted).toBe(0);
    expect(run.trader.loop.health().halts.map((halt) => halt.code)).toContain("STORE_UNAVAILABLE");
    expect(run.trader.markets.has(W1.marketId)).toBe(false);
    expect(run.parts.store.decisions.some((entry) => entry.record.marketId === W1.marketId)).toBe(false);
  });
});
