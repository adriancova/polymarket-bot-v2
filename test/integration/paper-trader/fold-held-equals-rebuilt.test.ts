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
 */

import { projectLedger, serializeProjection } from "@polymarket-bot/ledger";
import { foldPnlRecords, serializePnlState } from "@polymarket-bot/pnl";
import { describe, expect, it } from "vitest";

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
