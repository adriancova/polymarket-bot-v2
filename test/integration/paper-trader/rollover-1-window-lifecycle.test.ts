/**
 * `ROLLOVER-1` r1 — a series window's LIFE in the trader, on synthetic
 * streams placed instant by instant (`support/series-stream.ts`), through the
 * REAL trader composition root. The remediation pins of round 1:
 *
 * 1. **R1-01** — a window admitted after startup is known to the §9.7
 *    allocator: its booked position is inventory its exit may sell (a
 *    completed buy and stop-loss sell), and exposure every cap counts (the next
 *    window's entry is refused at the global cap).
 * 2. **R1-05** — the health surface's realized PnL of a series-bound instance
 *    is the SUM of its windows' streams, not the latest window's.
 * 3. **R1-FABLE-01 / N3** — a RESOLVED window that still holds a working order
 *    is not torn down until the order is terminal (`teardownsBlocked`), so the
 *    order's fill still reaches the window's strategy.
 * 4. **R1-FABLE-01 / N4** — a FLAT, idle window still unresolved its reviewed
 *    bound after its close is torn down `UNRESOLVED_AFTER_CLOSE`.
 * 5. **R1-04** — a window still unresolved past that bound that HOLDS
 *    inventory is kept (ADR-030 Decision 4.4, "after its resolution is
 *    handled"): reported once (`HELD_UNRESOLVED`), its runtime the position's
 *    owner, so a later `MarketResolved` reaches the strategy and only then is
 *    it torn down.
 * 6. **R1-03** — an admission whose event time is at or past the window's
 *    close is refused `WINDOW_CLOSED`.
 * 7. **R1-FABLE-07** — a catalog conflict refuses THAT window only
 *    (`CATALOG_CONFLICT`); nothing halts and the next window is admitted.
 * 8. **R2-ASTRA-01** (`ROLLOVER-1` r2) — a HELD window KEEPS its cap slot
 *    (ADR-030 Decision 1.8), as at the gateway: the next window is refused
 *    `CAP_REACHED` until the HELD window's resolution is handled, so a run
 *    never holds more windows — each a runtime evaluated at its cadence — than
 *    the reviewed cap. r1 excluded HELD windows from the cap, and the
 *    verifiers' probe held three funded windows at a cap of 1.
 */

import { RealizedPnlBook, observeRealizedPnl, type AdmissionNotice } from "@polymarket-bot/trader";
import { describe, expect, it } from "vitest";

import { assembleOrThrow } from "./support/run.js";
import { DEAD_QUOTE, ENTRY_QUOTE, STOP_QUOTE, SeriesStream, sampleReviewHash } from "./support/series-stream.js";
import { SERIES_INSTANCE_ID, review, seriesConfig, W1, W2, W3 } from "./support/series-windows.js";

/** The series configuration with the strategy's `exit` block and the §9.7 caps overridden. */
function configWith(
  options: { readonly exit?: Record<string, unknown>; readonly caps?: Record<string, unknown>; readonly series?: Record<string, unknown> } = {},
): Record<string, unknown> {
  const base = seriesConfig(options.series);
  const instance = (base["seriesInstances"] as Record<string, unknown>[])[0] as Record<string, unknown>;
  const params = instance["params"] as Record<string, unknown>;
  return {
    ...base,
    allocatorCaps: { ...(base["allocatorCaps"] as Record<string, unknown>), ...options.caps },
    seriesInstances: [{ ...instance, params: { ...params, exit: { ...(params["exit"] as Record<string, unknown>), ...options.exit } } }],
  };
}

/** Hold the position through the close, to its resolution (no protective exit before it). */
const HOLD_TO_RESOLUTION = { final_policy: "HOLD_TO_RESOLUTION", allow_resolution_hold: true, maximum_holding_seconds: 7200 } as const;

function noticeLine(notice: AdmissionNotice): string {
  switch (notice.kind) {
    case "ADMITTED":
      return `ADMITTED ${notice.window.marketId}`;
    case "REFUSED":
      return `REFUSED ${notice.code} ${notice.marketId ?? "-"}`;
    case "TORN_DOWN":
      return `TORN_DOWN ${notice.window.marketId} ${notice.reason}`;
    case "HELD_UNRESOLVED":
      return `HELD_UNRESOLVED ${notice.window.marketId}`;
  }
}

async function drive(
  config: Record<string, unknown>,
  stream: SeriesStream,
  options: { readonly book?: RealizedPnlBook; readonly onNotice?: (notice: AdmissionNotice, run: ReturnType<typeof assembleOrThrow>) => void; readonly before?: (run: ReturnType<typeof assembleOrThrow>) => void } = {},
) {
  const notices: AdmissionNotice[] = [];
  const holder: { current?: ReturnType<typeof assembleOrThrow> } = {};
  const run = assembleOrThrow({
    config,
    idNamespace: "rollover-1-r1",
    onAdmission: (notice) => {
      notices.push(notice);
      if (holder.current !== undefined) options.onNotice?.(notice, holder.current);
    },
    ...(options.book === undefined ? {} : { wrapStore: (store) => observeRealizedPnl(store, options.book as RealizedPnlBook) }),
  });
  holder.current = run;
  if (options.book !== undefined) run.trader.health.attachRealizedPnl(options.book);
  options.before?.(run);
  for (const event of stream.events) run.trader.loop.ingest(event);
  await run.trader.loop.drain();
  const fills = run.parts.venue.fills.map((fill) => `${fill.marketId === W1.marketId ? "W1" : fill.marketId === W2.marketId ? "W2" : fill.marketId} ${fill.action} ${fill.shares}@${fill.price}`);
  return { run, notices: notices.map(noticeLine), fills };
}

/** W1 admitted, opened and quoted UNDER the entry trigger at 22:16: the bracket buys 50 at 0.34. */
function w1Entry(stream: SeriesStream = new SeriesStream()): SeriesStream {
  return stream
    .tick("2026-10-04T22:16:00.000Z")
    .admit(W1, "2026-10-04T22:16:01.000Z")
    .open(W1, "2026-10-04T22:16:02.000Z")
    .book(W1, "2026-10-04T22:16:03.000Z", ENTRY_QUOTE)
    .tick("2026-10-04T22:16:05.000Z");
}

describe("ROLLOVER-1 r1 (R1-01): an admitted window's assets are known to the allocator", () => {
  it("a window's booked position is inventory its exit may sell: the buy and the stop-loss sell both complete", async () => {
    const stream = w1Entry()
      .book(W1, "2026-10-04T22:16:10.000Z", STOP_QUOTE)
      .tick("2026-10-04T22:16:12.000Z")
      .tick("2026-10-04T22:16:14.000Z");
    const { run, fills } = await drive(configWith(), stream);
    expect(fills).toEqual(["W1 BUY 50@0.34", "W1 SELL 50@0.27"]);
    const health = run.trader.loop.health();
    expect(health.halts).toEqual([]);
    expect(health.seams.allocator.refusalsByCode).toEqual({});
    expect(health.risk).toMatchObject({ refusals: 0, refusedExits: 0 });
    // The take-profit the bracket rests after its entry was approved too (it was
    // refused CAPITAL_INVENTORY_INSUFFICIENT when the allocator could not see W1).
    expect(run.parts.store.decisions.map((entry) => entry.record.decision.decisionType)).toEqual(
      expect.arrayContaining(["enter", "exit", "cancel", "reduce"]),
    );
  });

  it("a window's booked position counts toward the global cap: the next window's entry is refused CAPITAL_GLOBAL_CAP_EXCEEDED", async () => {
    // W1 holds 50 shares (cost 17) to its resolution; W2 opens at 22:30 and
    // quotes under the trigger. Global cap 20: 17 held + 17.5 asked > 20.
    const stream = w1Entry(new SeriesStream().admit(W2, "2026-10-04T22:15:59.000Z"))
      .book(W1, "2026-10-04T22:16:10.000Z", DEAD_QUOTE)
      .tick("2026-10-04T22:29:50.000Z")
      .open(W2, "2026-10-04T22:30:00.000Z")
      .book(W2, "2026-10-04T22:30:03.000Z", ENTRY_QUOTE)
      .tick("2026-10-04T22:30:05.000Z");
    const { run, fills, notices } = await drive(configWith({ exit: HOLD_TO_RESOLUTION, caps: { globalAccountCap: "20" } }), stream);
    expect(notices).toEqual([`ADMITTED ${W2.marketId}`, `ADMITTED ${W1.marketId}`]);
    expect(fills).toEqual(["W1 BUY 50@0.34"]);
    expect(run.parts.store.decisions.some((entry) => entry.record.marketId === W2.marketId && entry.record.decision.decisionType === "enter")).toBe(true);
    expect(run.trader.loop.health().seams.allocator.refusalsByCode).toEqual({ CAPITAL_GLOBAL_CAP_EXCEEDED: 1 });
  });
});

describe("ROLLOVER-1 r1 (R1-05): health's realized PnL sums an instance's windows", () => {
  it("W1 takes profit (+8) and W2 stops out (-3.5): the instance and the account read 4.5, not the last window's -3.5", async () => {
    const stream = w1Entry()
      .trade(W1, "2026-10-04T22:17:00.000Z", "0.5")
      .tick("2026-10-04T22:17:02.000Z")
      .admit(W2, "2026-10-04T22:29:00.000Z")
      .open(W2, "2026-10-04T22:30:00.000Z")
      .book(W2, "2026-10-04T22:30:03.000Z", ENTRY_QUOTE)
      .tick("2026-10-04T22:30:05.000Z")
      .book(W2, "2026-10-04T22:30:10.000Z", STOP_QUOTE)
      .tick("2026-10-04T22:30:12.000Z")
      .tick("2026-10-04T22:30:14.000Z");
    const book = new RealizedPnlBook();
    const { run, fills } = await drive(configWith(), stream, { book });
    expect(fills).toEqual(["W1 BUY 50@0.34", "W1 SELL 50@0.5", "W2 BUY 50@0.34", "W2 SELL 50@0.27"]);
    const snapshots = run.parts.store.pnlSnapshots.map((snapshot) => [snapshot.marketId, snapshot.realizedPnl]);
    expect(snapshots).toEqual(expect.arrayContaining([[W1.marketId, "8"], [W2.marketId, "-3.5"]]));
    const realized = run.trader.loop.health().accounting.realizedPnl;
    expect(realized).toEqual({ byInstance: { [SERIES_INSTANCE_ID]: "4.5" }, account: "4.5" });
  });
});

describe("ROLLOVER-1 r1 (R1-FABLE-01): every teardown path, by name", () => {
  it("N3: a RESOLVED window that still holds a working order waits until the order is terminal — its fill reaches the strategy", async () => {
    // The take-profit (a post-only SELL at 0.50) rests when W1 resolves; a
    // public trade at 0.50 then fills it (Tier 0: a touch fills a resting order).
    const stream = w1Entry()
      .resolve(W1, "2026-10-04T22:20:00.000Z")
      .tick("2026-10-04T22:20:01.000Z")
      .trade(W1, "2026-10-04T22:20:02.000Z", "0.5")
      .tick("2026-10-04T22:20:04.000Z")
      .tick("2026-10-04T22:20:05.000Z");
    const fillsAtTeardown: number[] = [];
    const { run, notices, fills } = await drive(configWith(), stream, {
      onNotice: (notice, holder) => {
        if (notice.kind === "TORN_DOWN") fillsAtTeardown.push(holder.parts.venue.fills.length);
      },
    });
    expect(fills).toEqual(["W1 BUY 50@0.34", "W1 SELL 50@0.5"]);
    expect(notices).toEqual([`ADMITTED ${W1.marketId}`, `TORN_DOWN ${W1.marketId} RESOLVED`]);
    // Torn down only AFTER the working order's fill — never while it worked.
    expect(fillsAtTeardown).toEqual([2]);
    expect(run.trader.loop.admissionMetrics()).toMatchObject({ teardownsBlocked: 2, tornDownResolved: 1, live: 0 });
    // The fill reached the window's own strategy, after its resolution.
    const callbacks = run.parts.store.decisions.map((entry) => entry.record.callback);
    expect(callbacks.lastIndexOf("onFill")).toBeGreaterThan(callbacks.indexOf("onMarketResolved"));
    expect(run.trader.loop.health().halts).toEqual([]);
  });

  it("N4: a FLAT, idle window still unresolved its reviewed bound (3,600 s) after its close is torn down UNRESOLVED_AFTER_CLOSE", async () => {
    const stream = new SeriesStream()
      .tick("2026-10-04T22:16:00.000Z")
      .admit(W1, "2026-10-04T22:16:01.000Z")
      .open(W1, "2026-10-04T22:16:02.000Z")
      .book(W1, "2026-10-04T22:16:03.000Z", DEAD_QUOTE)
      .tick("2026-10-04T23:29:59.999Z")
      .tick("2026-10-04T23:30:00.000Z")
      .tick("2026-10-04T23:30:01.000Z");
    const { run, notices } = await drive(configWith(), stream);
    expect(run.parts.venue.fills).toEqual([]);
    expect(notices).toEqual([`ADMITTED ${W1.marketId}`, `TORN_DOWN ${W1.marketId} UNRESOLVED_AFTER_CLOSE`]);
    expect(run.trader.markets.has(W1.marketId)).toBe(false);
    expect(run.trader.registry.evaluationOrder()).toEqual([]);
    expect(run.trader.loop.admissionMetrics()).toMatchObject({ tornDownUnresolved: 1, heldUnresolved: 0, live: 0 });
  });
});

describe("ROLLOVER-1 r1 (R1-04): a window that holds inventory is never torn down unresolved", () => {
  it("past its bound it is HELD (reported once), its runtime still the owner; its resolution reaches the strategy, then it is torn down RESOLVED", async () => {
    const stream = w1Entry()
      .book(W1, "2026-10-04T22:16:10.000Z", DEAD_QUOTE)
      .tick("2026-10-04T22:29:50.000Z")
      .tick("2026-10-04T23:30:01.000Z")
      .tick("2026-10-04T23:30:02.000Z")
      .resolve(W1, "2026-10-04T23:31:00.000Z")
      .tick("2026-10-04T23:31:01.000Z");
    const live: boolean[] = [];
    const { run, notices, fills } = await drive(configWith({ exit: HOLD_TO_RESOLUTION }), stream, {
      onNotice: (notice, holder) => {
        if (notice.kind === "HELD_UNRESOLVED") live.push(holder.trader.markets.has(W1.marketId), holder.trader.registry.evaluationOrder().length === 1);
      },
    });
    expect(fills).toEqual(["W1 BUY 50@0.34"]);
    expect(notices).toEqual([`ADMITTED ${W1.marketId}`, `HELD_UNRESOLVED ${W1.marketId}`, `TORN_DOWN ${W1.marketId} RESOLVED`]);
    expect(live).toEqual([true, true]);
    // The resolution reached the window's own strategy before its teardown.
    expect(run.parts.store.decisions.some((entry) => entry.record.marketId === W1.marketId && entry.record.callback === "onMarketResolved")).toBe(true);
    expect(run.trader.loop.admissionMetrics()).toMatchObject({ tornDownResolved: 1, tornDownUnresolved: 0, heldUnresolved: 0, live: 0 });
    expect(run.trader.loop.health().halts).toEqual([]);
  });

});

describe("ROLLOVER-1 r2 (R2-ASTRA-01): a HELD window keeps its cap slot (ADR-030 Decision 1.8)", () => {
  const series = { ...review(), maximumConcurrentWindows: 1, unresolvedTeardownSeconds: 300 };

  it("R2-ASTRA-01: with a cap of 1, the next window is refused CAP_REACHED while W1 is HELD; once W1's resolution is handled, the next is admitted", async () => {
    const stream = w1Entry(new SeriesStream(sampleReviewHash(series)))
      .book(W1, "2026-10-04T22:16:10.000Z", DEAD_QUOTE)
      .tick("2026-10-04T22:29:50.000Z")
      .tick("2026-10-04T22:35:01.000Z")
      .admit(W2, "2026-10-04T22:35:02.000Z")
      .tick("2026-10-04T22:35:03.000Z")
      .resolve(W1, "2026-10-04T22:40:00.000Z")
      .tick("2026-10-04T22:40:01.000Z")
      .admit(W3, "2026-10-04T22:44:00.000Z")
      .tick("2026-10-04T22:44:01.000Z");
    const { run, notices, fills } = await drive(configWith({ exit: HOLD_TO_RESOLUTION, series }), stream);
    expect(fills).toEqual(["W1 BUY 50@0.34"]);
    expect(notices).toEqual([
      `ADMITTED ${W1.marketId}`,
      `HELD_UNRESOLVED ${W1.marketId}`,
      `REFUSED CAP_REACHED ${W2.marketId}`,
      `TORN_DOWN ${W1.marketId} RESOLVED`,
      `ADMITTED ${W3.marketId}`,
    ]);
    expect(run.trader.loop.admissionMetrics()?.lastRefusals).toEqual([
      expect.stringMatching(/^CAP_REACHED: series btc-15m-updown has 1 live windows, .*1 of them HELD awaiting their resolution$/u),
    ]);
    expect(run.trader.loop.admissionMetrics()).toMatchObject({ admitted: 2, heldUnresolved: 0, live: 1, refusals: { CAP_REACHED: 1 } });
    expect(run.parts.store.admittedMarkets.map((market) => market.marketId)).toEqual([W1.marketId, W3.marketId]);
    expect(run.parts.store.decisions.some((entry) => entry.record.marketId === W2.marketId)).toBe(false);
    expect(run.trader.loop.health().halts).toEqual([]);
  });

  it("R2-ASTRA-01: cap 1 and three windows each due while the one before it is HELD — one window funded, never more than one live, one runtime (r1 held three)", async () => {
    // The verifiers' probe stream: under r1 every window was admitted, funded
    // and HELD (live 3, three runtimes, each evaluated at the run's cadence).
    const stream = w1Entry(new SeriesStream(sampleReviewHash(series)))
      .book(W1, "2026-10-04T22:16:10.000Z", DEAD_QUOTE)
      .tick("2026-10-04T22:29:50.000Z")
      .tick("2026-10-04T22:35:01.000Z")
      .admit(W2, "2026-10-04T22:35:02.000Z")
      .open(W2, "2026-10-04T22:35:03.000Z")
      .book(W2, "2026-10-04T22:35:04.000Z", ENTRY_QUOTE)
      .tick("2026-10-04T22:35:06.000Z")
      .book(W2, "2026-10-04T22:35:10.000Z", DEAD_QUOTE)
      .tick("2026-10-04T22:44:50.000Z")
      .tick("2026-10-04T22:50:01.000Z")
      .admit(W3, "2026-10-04T22:50:02.000Z")
      .open(W3, "2026-10-04T22:50:03.000Z")
      .book(W3, "2026-10-04T22:50:04.000Z", ENTRY_QUOTE)
      .tick("2026-10-04T22:50:06.000Z")
      .book(W3, "2026-10-04T22:50:10.000Z", DEAD_QUOTE)
      .tick("2026-10-04T22:59:50.000Z")
      .tick("2026-10-04T23:05:01.000Z")
      .tick("2026-10-04T23:05:10.000Z");
    const bound: { live: number; runtimes: number }[] = [];
    const { run, notices, fills } = await drive(configWith({ exit: HOLD_TO_RESOLUTION, series }), stream, {
      onNotice: (_notice, holder) => {
        bound.push({ live: holder.trader.loop.admissionMetrics()?.live ?? -1, runtimes: holder.trader.registry.evaluationOrder().length });
      },
    });
    expect(fills).toEqual(["W1 BUY 50@0.34"]);
    expect(notices).toEqual([
      `ADMITTED ${W1.marketId}`,
      `HELD_UNRESOLVED ${W1.marketId}`,
      `REFUSED CAP_REACHED ${W2.marketId}`,
      `REFUSED CAP_REACHED ${W3.marketId}`,
    ]);
    expect(bound).toHaveLength(4);
    expect(bound.every((entry) => entry.live <= 1 && entry.runtimes <= 1)).toBe(true);
    expect(run.trader.markets.size).toBe(1);
    expect(run.trader.registry.evaluationOrder()).toHaveLength(1);
    expect(run.trader.loop.admissionMetrics()).toMatchObject({ admitted: 1, heldUnresolved: 1, live: 1, refusals: { CAP_REACHED: 2 } });
    // Only the one HELD window is ever evaluated: no decision names W2 or W3.
    expect(new Set(run.parts.store.decisions.map((entry) => entry.record.marketId))).toEqual(new Set([W1.marketId]));
    expect(run.trader.loop.health().halts).toEqual([]);
  });
});

describe("ROLLOVER-1 r1 (R1-03, R1-FABLE-07): two refusals that are about one window only", () => {
  it("an admission whose event time is at the window's close is refused WINDOW_CLOSED and never attached", async () => {
    const stream = new SeriesStream().tick("2026-10-04T22:29:00.000Z").admit(W1, W1.closeAt).tick("2026-10-04T22:30:01.000Z");
    const { run, notices } = await drive(configWith(), stream);
    expect(notices).toEqual([`REFUSED WINDOW_CLOSED ${W1.marketId}`]);
    expect(run.parts.store.admittedMarkets).toEqual([]);
    expect(run.trader.markets.size).toBe(0);
  });

  it("a catalog that already holds the window's condition under another market refuses THAT window (CATALOG_CONFLICT); nothing halts, and the next window is admitted", async () => {
    const stream = new SeriesStream()
      .tick("2026-10-04T22:16:00.000Z")
      .admit(W1, "2026-10-04T22:16:01.000Z")
      .admit(W2, "2026-10-04T22:16:02.000Z")
      .tick("2026-10-04T22:16:03.000Z");
    const { run, notices } = await drive(configWith(), stream, {
      before: (run) => {
        // A market registered for another run under its own id, on W1's condition.
        run.parts.store.admittedMarkets.push({
          marketId: "018f4a7e-0000-7abc-8def-00000000c0de",
          conditionId: W1.conditionId,
          questionTitle: W1.title,
          yesTokenId: "1",
          noTokenId: "2",
          yesLabel: "Up",
          noLabel: "Down",
          tickSize: W1.tickSize,
          minimumOrderSize: "5",
          tradingDelaySeconds: 0,
          negRisk: false,
          openTime: W1.openAt,
          closeTime: W1.closeAt,
          observedAt: W1.openAt,
        });
      },
    });
    expect(notices).toEqual([`REFUSED CATALOG_CONFLICT ${W1.marketId}`, `ADMITTED ${W2.marketId}`]);
    expect(run.trader.loop.health().halts).toEqual([]);
    expect(run.trader.markets.has(W1.marketId)).toBe(false);
    expect(run.trader.loop.admissionMetrics()?.refusals).toEqual({ CATALOG_CONFLICT: 1 });
  });
});
