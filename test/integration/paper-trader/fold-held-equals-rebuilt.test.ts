/**
 * `FOLD-1` — the assembled trader's HELD accounting state equals its rebuild
 * from zero (§6 invariant 8; ADR-006 §1 "A rebuild from zero must equal the
 * incremental state").
 *
 * The loop no longer folds its ledger view and PnL state from zero on every
 * event: it holds them and advances them with only what each posting adds
 * (`apps/trader/src/folds.ts`). This fixture runs with the test cadence —
 * `EVERY_FILL_ACCOUNTING_CHECKS`, passed in code by `support/fixture.ts`
 * (orchestrator call O1) — so the loop compared both with their rebuilds after
 * every fill. This file does not rely on the loop's own comparison alone: it
 * rebuilds both HERE, independently, from the ledger and the record stream
 * the loop exposes, and compares bytes and the ledger view's Map order.
 *
 * `FOLD1-R1-3` adds the REAL-CORE BACKTEST half: the committed replay fixture
 * (`test/replay-golden/backtest/static-bracket/`, read only) driven through
 * `apps/backtest-cli`'s `runBacktest` over the real core, at the PAPER cadence
 * a real backtest keeps — handed ONLY the driver's `coreLoop`, with no
 * finalizer anywhere in the call. The run must still end with the core's
 * held==rebuilt check: the driver binds it, and `runBacktest` runs it. The
 * composition is the replay-golden suite's own
 * (`test/unit/simulation/backtest-replay-support.ts`), imported rather than
 * restated.
 */

import { projectLedger, serializeProjection } from "@polymarket-bot/ledger";
import { foldPnlRecords, serializePnlState } from "@polymarket-bot/pnl";
import { PAPER_ACCOUNTING_CHECKS } from "@polymarket-bot/trader";
import { describe, expect, it } from "vitest";

import {
  normalizedEnvelopeNormalizer,
  replayDrivenCoreLoop,
  runBacktest,
  sha256Hex,
} from "../../../apps/backtest-cli/src/index.js";
import {
  FIXTURE_DIRECTORY,
  assembleSharedCore,
  loadFixture,
  paperEnvironment,
  replayThroughShippedRoot,
} from "../../unit/simulation/backtest-replay-support.js";
import { INSTANCE_ID, MARKET_ID, RUN_ID } from "./support/fixture.js";
import { driveRecordedRun } from "./support/run.js";

describe("FOLD-1 — the assembled trader's held ledger view and PnL state equal their rebuilds from zero", () => {
  it("after the recorded run: bytes and Map order equal; every posted fill was checked, and every check matched", async () => {
    const run = await driveRecordedRun();
    const loop = run.trader.loop;
    const health = loop.health();
    expect(health.halts).toEqual([]);

    // The run really booked something, so the comparisons below are not of two empties.
    expect(loop.ledger().length).toBeGreaterThan(0);
    expect(loop.pnlRecords(INSTANCE_ID).length).toBeGreaterThan(0);

    // The ledger view: the loop's held projection against a rebuild HERE.
    const held = loop.ledgerView();
    const rebuilt = projectLedger(loop.ledger());
    expect(serializeProjection(held)).toBe(serializeProjection(rebuilt));
    expect([...held.balances.keys()]).toEqual([...rebuilt.balances.keys()]);
    expect([...held.virtualPositions.keys()]).toEqual([...rebuilt.virtualPositions.keys()]);
    expect(held.transactionCount).toBe(loop.ledger().length);

    // The PnL state: the loop's held stream against `foldPnlRecords` HERE.
    const heldPnl = loop.pnlState(INSTANCE_ID);
    expect(heldPnl).toBeDefined();
    const rebuiltPnl = foldPnlRecords(
      {
        scope: "VIRTUAL_STRATEGY",
        environment: "PAPER",
        accountRef: "paper-account",
        instanceId: INSTANCE_ID,
        runId: RUN_ID,
        marketId: MARKET_ID,
      },
      loop.pnlRecords(INSTANCE_ID),
    );
    expect(rebuiltPnl.ok).toBe(true);
    if (heldPnl === undefined || !rebuiltPnl.ok) return;
    expect(serializePnlState(heldPnl)).toBe(serializePnlState(rebuiltPnl.value));

    // The loop's own checks: one per posted fill, ledger and PnL, none differing.
    const folds = health.seams.folds;
    expect(folds.fillsPosted).toBeGreaterThan(0);
    expect(folds).toMatchObject({
      checkEveryFills: 1,
      pnlCheck: true,
      ledgerChecks: folds.fillsPosted,
      pnlChecks: folds.fillsPosted,
      fillsAtLastCheck: folds.fillsPosted,
      ledgerMismatches: 0,
      pnlMismatches: 0,
      pnlRefusals: {},
    });

    // And the end-of-run check agrees, over the one held stream.
    expect(loop.checkAccountingRebuild("END_OF_RUN")).toEqual({ matched: true, pnlStreamsChecked: 1 });
    expect(loop.health().halts).toEqual([]);
  });
});

describe("FOLD1-R1-3 — a real-core backtest, handed ONLY the driver's coreLoop, still ends with its held==rebuilt check", () => {
  it("the committed fixture at the PAPER cadence: no cadence check is due, and the END-OF-RUN check ran once and matched", async () => {
    const run = await replayThroughShippedRoot({ withCore: true, accountingChecks: PAPER_ACCOUNTING_CHECKS });
    expect(run.outcome.ok).toBe(true);
    const loop = run.core?.trader.loop;
    expect(loop).toBeDefined();
    if (loop === undefined) return;
    const folds = loop.health().seams.folds;
    // The run booked fills, but fewer than the cadence's 50: only the end of the run checks.
    expect(folds.fillsPosted).toBeGreaterThan(0);
    expect(folds.fillsPosted).toBeLessThan(PAPER_ACCOUNTING_CHECKS.everyFills);
    expect(folds).toMatchObject({
      checkEveryFills: PAPER_ACCOUNTING_CHECKS.everyFills,
      pnlCheck: false,
      ledgerChecks: 1,
      fillsAtLastCheck: folds.fillsPosted,
      ledgerMismatches: 0,
      pnlChecks: 0,
    });
    expect(loop.health().halts).toEqual([]);
    expect(serializeProjection(loop.ledgerView())).toBe(serializeProjection(projectLedger(loop.ledger())));
  });

  it("a held-balance discrepancy injected mid-run is CAUGHT by that end-of-run check: a GLOBAL ACCOUNTING_REBUILD_MISMATCH", async () => {
    const fixture = loadFixture();
    const core = assembleSharedCore(fixture, PAPER_ACCOUNTING_CHECKS);
    const loop = core.trader.loop;
    let corruptedAtFill: number | undefined;
    // The real core, passed through; after the first drain that posted a fill, one held balance is
    // contaminated in place (the container guard's documented bypass, `packages/ledger`'s immutable.ts).
    const driver = replayDrivenCoreLoop({
      loop: {
        ingest: (event) => loop.ingest(event),
        drain: async () => {
          await loop.drain();
          const posted = loop.health().seams.folds.fillsPosted;
          if (corruptedAtFill !== undefined || posted === 0) return;
          const view = loop.ledgerView();
          const [key, line] = [...view.balances.entries()][0] ?? [];
          if (key === undefined || line === undefined) return;
          Map.prototype.set.call(view.balances, key, { ...line, balance: "999" });
          corruptedAtFill = posted;
        },
        checkAccountingRebuild: (trigger) => loop.checkAccountingRebuild(trigger),
      },
      clock: core.clock,
    });
    const outcome = await runBacktest({
      datasetDirectory: FIXTURE_DIRECTORY,
      normalizer: normalizedEnvelopeNormalizer(sha256Hex),
      runPins: fixture.runPins,
      environment: paperEnvironment(),
      coreLoop: driver.coreLoop,
      venue: core.venue,
    });
    expect(outcome.ok).toBe(true);
    expect(corruptedAtFill).toBeDefined();
    const health = loop.health();
    expect(health.halts.map((halt) => [halt.scope.kind, halt.code])).toEqual([
      ["GLOBAL", "ACCOUNTING_REBUILD_MISMATCH"],
    ]);
    expect(health.halts[0]?.detail).toContain("at the end of the run");
    expect(health.seams.folds).toMatchObject({ ledgerChecks: 1, ledgerMismatches: 1 });
    // Replaced by the rebuild: the held view is the ledger's again.
    expect(serializeProjection(loop.ledgerView())).toBe(serializeProjection(projectLedger(loop.ledger())));
  });
});
