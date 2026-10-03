/**
 * BACKTEST-1 — Static Bracket runs in BACKTEST replay THROUGH THE SHIPPED
 * ROOT (GOV-2B B3; handoff §7 checklist item 4, replay half; runbook :509's
 * replay half).
 *
 * At base `1aa2238` the shipped replay root verified and drove a dataset and
 * produced NO decision, NO order and NO fill: `coreLoop` was declared in
 * `apps/backtest-cli/src/run.ts`, consumed in `packages/simulation/src/replay.ts`,
 * and supplied nowhere. The measured base output over a two-frame dataset was
 * `events_delivered=2`, `economics … fills=0`, and no line of any other kind —
 * the control arm below reproduces exactly that shape over THIS fixture.
 *
 * What this suite proves, each as its own test:
 *
 * 1. the committed Parquet object is the derivation of `frames.json`, so the
 *    binary fixture and its readable source cannot drift;
 * 2. the control arm — `runBacktest` as base could run it — yields no decision;
 * 3. through the shipped `runBacktest` + `replayDrivenCoreLoop` +
 *    `normalizedEnvelopeNormalizer`, the SAME `createPaperTrader` core the
 *    paper trader runs produces decisions from Static Bracket, completes an
 *    entry → exit round trip, and books a realized PnL — the numbers being the
 *    ones `RISK-2` derived by hand for its golden (`docs/handoffs/RISK-2.md`:
 *    realized `16 − 17.2 = −1.2`, fees `0.131 + 0.089 + 0.212 = 0.432`,
 *    `coreNetPnl −1.632`), reached here by a different driver over a recorded
 *    dataset. Since `BACKTEST-2` the core is built by the backtest
 *    EXECUTABLE's own assembly (`apps/backtest-cli/src/assembly.ts`
 *    `runBacktestCore`, what the `run` command runs) — no test harness builds
 *    it — and the artefact is the CLI's own (`artifact.ts`);
 * 4. the artefact is BYTE-IDENTICAL across two runs, and equal to the
 *    committed golden (`expected-artifact.txt`), so a perturbation of either
 *    the run or the golden fails here by name;
 * 5. the run is SENSITIVE: a one-byte change to the archived object is REFUSED
 *    by checksum, never replayed;
 * 6. `RISK-2` residual 5 was OBSERVED and pinned here (the instance's own
 *    protective reduction filled, the strategy could not name the fill, and it
 *    ended PAUSED — with the ledger clean), and the pin is now CONVERTED to its
 *    resolution by `BRACKET-1a`: the reduction's own fill closes the bracket
 *    through the replay root too, nothing pauses, and the ledger is still
 *    clean.
 *
 * The `run` command itself — argv in, artifact file out — is pinned to the
 * same golden bytes by `apps/backtest-cli/src/run-command.test.ts`, in the
 * root unit suite, so this file list did not grow (`BACKTEST-2`).
 *
 * Wired into `pnpm test:replay` (root `package.json`), which `GATE-1` made a
 * real CI gate. That script is a POSITIONAL FILE LIST, and `GATE-1`'s residual
 * M1 stands: the list can silently shrink. This file's presence in it is
 * asserted nowhere mechanically; a reader checking the gate must read the
 * script line.
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { renderBacktestOutcome } from "../../../apps/backtest-cli/src/index.js";
import { writeParquetObject } from "../../../packages/storage-parquet/src/index.js";
import {
  REPRODUCES,
  ARTIFACT_FORMAT_ID,
  EXPECTED_ARTIFACT_FILE,
  FIXTURE_DIRECTORY,
  MANIFEST_FILE,
  PARQUET_OBJECT_FILE,
  RUN_PINS_FILE,
  TRADER_CONFIG_FILE,
  datasetRowsOf,
  loadFixture,
  renderArtifact,
  replayThroughShippedRoot,
  venueRecords,
} from "./backtest-replay-support.js";

function expectedArtifact(): string {
  return readFileSync(join(FIXTURE_DIRECTORY, EXPECTED_ARTIFACT_FILE), "utf8");
}

describe("the committed fixture", () => {
  it("is complete, and its Parquet object is exactly the derivation of frames.json", () => {
    for (const file of [
      "frames.json",
      PARQUET_OBJECT_FILE,
      MANIFEST_FILE,
      RUN_PINS_FILE,
      TRADER_CONFIG_FILE,
      EXPECTED_ARTIFACT_FILE,
      "README.md",
    ]) {
      expect(existsSync(join(FIXTURE_DIRECTORY, file)), `${file} is missing`).toBe(true);
    }
    const fixture = loadFixture();
    expect(fixture.frames.frames.length).toBe(8);
    // The binary cannot drift from its readable source: WP-130's own writer,
    // over the rows frames.json denotes, must reproduce the committed bytes.
    const rewritten = writeParquetObject({ rows: datasetRowsOf(fixture.frames) });
    expect(Buffer.from(rewritten.bytes).equals(Buffer.from(fixture.parquetBytes))).toBe(true);
  });

  it("records the normalized §7.4 stream the paper core consumes, and says so in its pins", () => {
    const fixture = loadFixture();
    expect(fixture.runPins.normalizerVersion).toBe("backtest-cli/normalized-envelope/v1");
    expect(fixture.frames.frames.map((frame) => frame.envelope.eventType)).toEqual([
      "ReferenceTradeObserved",
      "ReferenceTradeObserved",
      "MarketOpened",
      "BookSnapshot",
      "BookSnapshot",
      "BookLevelChanged",
      "BookSnapshot",
      "MarketClosing",
    ]);
  });
});

describe("the control arm — the shipped root as base 1aa2238 could run it", () => {
  it("replays every frame and produces no decision, no order and no fill", async () => {
    const run = await replayThroughShippedRoot({ withCore: false });
    expect(run.outcome.ok, JSON.stringify(run.outcome)).toBe(true);
    if (!run.outcome.ok) return;
    expect(run.outcome.result.eventsDelivered).toBe(8);
    expect(run.outcome.result.orders).toEqual([]);
    expect(run.outcome.result.fills).toEqual([]);
    expect(run.outcome.result.serialization).toContain("fills=0");
    expect(run.outcome.result.serialization).not.toMatch(/^order /mu);
    expect(run.core).toBeUndefined();
  });
});

describe("through the shipped root, the shared core runs Static Bracket (checklist item 4, replay half)", () => {
  it("produces decisions from Static Bracket and completes an entry → exit round trip", async () => {
    const run = await replayThroughShippedRoot({ withCore: true });
    expect(run.outcome.ok, renderBacktestOutcome(run.outcome)).toBe(true);
    if (!run.outcome.ok || run.core === undefined) return;

    // Every recorded frame reached the core, and every one was drained.
    expect(run.outcome.result.eventsDelivered).toBe(8);
    expect(run.driver).toEqual({ eventsIngested: 8, drains: 8 });

    // DECISIONS, from the strategy, through the runtime, persisted to the store
    // port — §6 invariant 3's one persisted decision per callback.
    const decisions = run.core.trader.loop.decisions();
    expect(decisions.length).toBeGreaterThan(0);
    expect(run.core.store.decisions.length).toBe(decisions.length);
    const types = decisions.map((decision) => decision.decisionType);
    expect(types).toContain("enter");
    expect(types).toContain("exit");
    expect(types).toContain("reduce");
    const codes = decisions.flatMap((decision) => decision.reasonCodes);
    expect(codes).toContain("SB.ENTRY_INTENT_EMITTED");
    expect(codes).toContain("SB.TAKE_PROFIT_INTENT");
    expect(codes).toContain("SB.FINAL_PROTECTED_REDUCE");

    // The round trip: the entry walks both ask levels (30 @ 0.34, 20 @ 0.35)
    // and the cutoff reduction sells all 50 into the 0.32 bid.
    const { orders, fills } = venueRecords(run);
    expect(fills.map((fill) => `${fill.action} ${fill.shares}@${fill.price} fee=${fill.feeAmount}`)).toEqual([
      "BUY 30@0.34 fee=0.131",
      "BUY 20@0.35 fee=0.089",
      "SELL 50@0.32 fee=0.212",
    ]);
    expect(orders.length).toBe(3);
    // …and the §12.4 serialization the shipped root emitted carries them as
    // bytes, not as this test's claim.
    expect(run.outcome.result.fills.length).toBe(3);
    expect(run.outcome.result.serialization).toContain(
      "economics basis=REALIZED_IN_REPLAY_PATH buy=17.2 sell=16 fees=0.432 net=-1.632 sharesBought=50 sharesSold=50 fills=3",
    );

    // The realized PnL RISK-2 derived by hand, reached here by replay.
    const last = run.core.store.pnlSnapshots.at(-1);
    expect(last?.realizedPnl).toBe("-1.2");
    expect(last?.feesPaid).toBe("0.432");
    expect(last?.coreNetPnl).toBe("-1.632");
    expect(last?.capitalCommitted).toBe("0");

    // The risk seam approved every intent — RISK-2's B2 fix, observed through
    // the replay root: no refused exit anywhere.
    const health = run.core.trader.loop.health();
    expect(health.risk.approvals).toBe(4);
    expect(health.risk.refusals).toBe(0);
    expect(health.risk.refusedExits).toBe(0);
    expect(health.halts).toEqual([]);
    expect(health.healthy).toBe(true);
  });

  it("is byte-identical across two runs, and equal to the committed golden", async () => {
    const first = renderArtifact(await replayThroughShippedRoot({ withCore: true }));
    const second = renderArtifact(await replayThroughShippedRoot({ withCore: true }));
    expect(second).toBe(first);
    expect(first.startsWith(`${ARTIFACT_FORMAT_ID}\n`)).toBe(true);
    // The golden is a CAPTURE of this derivation, committed beside the fixture;
    // a perturbation of the run or of the golden fails here by name.
    expect(first).toBe(expectedArtifact());
  });

  it("is SENSITIVE: a one-byte change to the archived object is refused by checksum, never replayed", async () => {
    const fixture = loadFixture();
    const directory = mkdtempSync(join(tmpdir(), "backtest-1-tamper-"));
    for (const file of [MANIFEST_FILE, RUN_PINS_FILE, TRADER_CONFIG_FILE]) {
      writeFileSync(join(directory, file), readFileSync(join(FIXTURE_DIRECTORY, file)));
    }
    const tampered = Buffer.from(fixture.parquetBytes);
    // Flip one byte in the row data, well past the Parquet header.
    const index = Math.floor(tampered.length / 2);
    tampered[index] = (tampered[index] ?? 0) ^ 0x01;
    writeFileSync(join(directory, PARQUET_OBJECT_FILE), tampered);

    const run = await replayThroughShippedRoot({ withCore: true, datasetDirectory: directory });
    expect(run.outcome.ok).toBe(false);
    if (run.outcome.ok || !("refusal" in run.outcome)) return;
    expect(["REPLAY_OBJECT_CHECKSUM_MISMATCH", "REPLAY_ARCHIVE_UNREADABLE"]).toContain(
      run.outcome.refusal.code,
    );
    // Nothing reached the core: a refused dataset makes no decision.
    expect(run.core?.trader.loop.decisions()).toEqual([]);
  });
});

/**
 * Residual 5 (`docs/handoffs/RISK-2.md`) — observed through the replay root by
 * `BACKTEST-1` and pinned so it would fail the day it was fixed; RESOLVED by
 * `BRACKET-1a`, and the rows now pin the resolution.
 *
 * WAS: `planProtectedReduce` created no order track, so when the cutoff
 * reduction FILLED the strategy could not name the fill:
 * `SB.UNATTRIBUTED_FILL` → `SB.POSITION_MISMATCH` → `SB.NO_BLIND_FLATTEN` →
 * `SB.PAUSED`, and `onMarketClosing` resumed and paused again. The pause was
 * the STRATEGY's own state (its reason codes), the runtime's
 * `instanceStatus()` stayed `ACTIVE`, and the ledger was clean.
 *
 * NOW: the reduction is tracked, its fill closes the bracket
 * (`SB.EXIT_FILLED`, `SB.CLOSED`), and `onMarketClosing` answers the fixture's
 * reentry limit of 1 (`SB.REFUSED_MAXIMUM_ENTRIES`). The same run through the
 * shipped replay root cannot show a SECOND bracket (the limit is 1, and a
 * cutoff reduction is always after the entry cutoff); that is not what this
 * fixture is for, and §7 checklist item 1 is not closed by it.
 */
describe("CADENCE-1 (ADR-026): the evaluation cadence the replay runs is recorded, and pinned", () => {
  it("the golden is a DECLARED reproduction of the per-frame cadence its pins state", () => {
    const fixture = loadFixture();
    expect([fixture.runPins.evaluationIntervalMs, fixture.runPins.evaluationHeartbeatMs]).toEqual([0, 0]);
    const lines = expectedArtifact().split("\n");
    expect(lines[0]).toBe("polymarket-bot/backtest-static-bracket-replay/v2");
    expect(lines[lines.indexOf("--- cadence ---") + 1]).toBe(
      `cadence evaluationIntervalMs=0 evaluationHeartbeatMs=0 reproduction=true reproduces=${REPRODUCES}`,
    );
  });

  it("the same data replayed as a NEW run — the PAPER cadence, nothing declared — decides exactly what the golden holds", async () => {
    // The fixture's eight recorded frames are each at least a second apart for
    // the one market, so the cadence coalesces nothing: the decisions, orders,
    // fills, ledger and PnL are the golden's.
    const run = await replayThroughShippedRoot({ withCore: true, paperCadence: true });
    const health = run.core?.trader.loop.health();
    expect(health?.loop.evaluationsCoalesced).toBe(0);
    expect(health?.loop.cadenceForwardJumpAlarms).toBe(0);
    const paper = renderArtifact(run).split("\n");
    const golden = expectedArtifact().split("\n");
    const cadenceAt = golden.indexOf("--- cadence ---") + 1;
    expect(paper[cadenceAt]).toBe("cadence evaluationIntervalMs=1000 evaluationHeartbeatMs=5000 reproduction=false");
    // `CADENCE-1` r1 (J2): one more snapshot ATTEMPT, and nothing else. The two
    // reference trades (frames 1-2) owe the market an evaluation before any
    // book has arrived, so no runtime is asked: that is no evaluation, and the
    // market stays owed (ADR-026 D2.3, D2.6). The `MarketOpened` close (frame
    // 3) owes it no `onFeatures`, so its carried pass tries it again — still no
    // book: `snapshotsUnavailable` 4, where the per-frame cadence, which
    // carries nothing, counts 3. No decision moves.
    const healthAt = golden.indexOf("--- health ---") + 1;
    expect(golden[healthAt]).toContain(" snapshotsUnavailable=3 ");
    expect(paper[healthAt]).toBe(golden[healthAt]?.replace(" snapshotsUnavailable=3 ", " snapshotsUnavailable=4 "));
    const rest = (lines: readonly string[]) => lines.filter((_, index) => index !== cadenceAt && index !== healthAt);
    expect(rest(paper)).toEqual(rest(golden));
  });
});

describe("residual 5 — RESOLVED: the instance's own exit fill closes the bracket through the replay root", () => {
  it("the reduction fills, the strategy names the fill, and the bracket closes", async () => {
    const run = await replayThroughShippedRoot({ withCore: true });
    expect(run.outcome.ok).toBe(true);
    if (!run.outcome.ok || run.core === undefined) return;
    const decisions = run.core.trader.loop.decisions();
    const codes = decisions.flatMap((decision) => decision.reasonCodes);
    expect(codes).toContain("SB.FINAL_PROTECTED_REDUCE");
    expect(venueRecords(run).fills.some((fill) => fill.action === "SELL")).toBe(true);
    // WAS: each of these four was present.
    expect(codes).not.toContain("SB.UNATTRIBUTED_FILL");
    expect(codes).not.toContain("SB.POSITION_MISMATCH");
    expect(codes).not.toContain("SB.NO_BLIND_FLATTEN");
    expect(codes).not.toContain("SB.PAUSED");
    // The reduction's own onFill — the decision that used to pause.
    const reduceAt = decisions.findIndex((decision) => decision.decisionType === "reduce");
    expect(reduceAt).toBeGreaterThanOrEqual(0);
    const reductionFill = decisions.slice(reduceAt + 1).find((decision) => decision.callback === "onFill");
    expect(reductionFill?.reasonCodes).toEqual(["SB.EXIT_FILLED", "SB.CLOSED"]);
    // The LAST decision the strategy itself reasoned about (the onMarketClosing
    // callback; `TRDR-4`: a terminal view is delivered until one delivery is
    // evaluated, so nothing trails it). WAS: `SB.RESUMED, …, SB.PAUSED`.
    const closing = decisions.find((decision) => decision.callback === "onMarketClosing");
    expect(closing?.reasonCodes).toEqual(["SB.REFUSED_MAXIMUM_ENTRIES"]);
    // The runtime-level status is ACTIVE, as it was: it never tracked the
    // strategy's own pause, and there is no pause now either.
    const instanceId = decisions[0]?.instanceId ?? "";
    expect(run.core.trader.registry.get(instanceId)?.runtime.instanceStatus()).toBe("ACTIVE");
  });

  it("but the books are right: the position is closed and nothing is unattributed where it would matter", async () => {
    const run = await replayThroughShippedRoot({ withCore: true });
    expect(run.outcome.ok).toBe(true);
    if (!run.outcome.ok || run.core === undefined) return;
    const artifact = renderArtifact(run);
    expect(artifact).toContain("ledger transactions=9 unattributedActivity=0 unexplainedMovements=0");
    expect(artifact).not.toContain("kind=OUTCOME_TOKEN");
    expect(artifact).toContain("health healthy=true halts= ");
  });
});
