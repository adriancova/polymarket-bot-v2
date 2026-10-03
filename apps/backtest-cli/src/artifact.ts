/**
 * The backtest artifact (`BACKTEST-2`): what the `run` command writes.
 *
 * The format is `BACKTEST-1`'s golden format, moved here from the replay
 * suite's support file (`test/unit/simulation/backtest-replay-support.ts`
 * `renderArtifact`, at `f8aedec`) so the EXECUTABLE writes it rather than a
 * test harness: the §12.4 serialization the shipped root produced, verbatim,
 * followed by what the shared core produced — every persisted decision, every
 * §6 invariant 4 chain, the ledger projection, the §9.16 snapshots, the health
 * counters, the store's write counts and the driver's counters — one line per
 * fact, in production order. Its format id is unchanged
 * ({@link BACKTEST_ARTIFACT_FORMAT_ID}), and the committed golden
 * `test/replay-golden/backtest/static-bracket/expected-artifact.txt` is its
 * byte-for-byte output over that fixture; a change to a line here fails that
 * golden by name.
 *
 * SIMULATED. Every fill line the serialization carries says
 * `SIMULATED_NOT_REAL_EVIDENCE` (the venue's own evidence class, ADR-012 §2),
 * and nothing in the artifact is evidence about real fill quality.
 *
 * Nothing here is read from a clock, an environment or the host:
 * `DecisionTelemetry.evaluationDurationUs` is deliberately not rendered, for
 * the reason `packages/strategy-runtime` gives ("machine-dependent by
 * nature").
 *
 * A TRUNCATED RUN IS NOT RENDERED. The core keeps its decisions and chains in
 * bounded logs (`TRDR-4`); if either evicted anything, the lists below would
 * be a window presented as the whole run, so the renderer refuses instead —
 * the rule `runReplay` applies to the venue's evicted history.
 */

import { SIMULATION_RUN_SERIALIZATION_VERSION } from "@polymarket-bot/simulation";
import {
  projectionOf,
  type DecisionTrace,
  type InMemoryTraderStore,
  type PaperTrader,
  type TraceLink,
} from "@polymarket-bot/trading-core";

import type { ReplayDriverObservations } from "./core-loop.js";
import type { BacktestOutcome } from "./run.js";

/** The format id of the artifact. Frozen by the committed golden; bump = re-derive it. */
export const BACKTEST_ARTIFACT_FORMAT_ID = "polymarket-bot/backtest-static-bracket-replay/v1";

/** What an artifact is rendered from: a completed run and the core that ran. */
export interface BacktestArtifactInput {
  readonly outcome: Extract<BacktestOutcome, { readonly ok: true }>;
  readonly trader: PaperTrader;
  readonly store: Pick<InMemoryTraderStore, "decisions" | "checkpoints" | "transactions" | "pnlSnapshots">;
  readonly driver: ReplayDriverObservations;
}

/** The artifact's bytes, or why it cannot be rendered. */
export type BacktestArtifact =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly problem: string };

function decisionLine(decision: DecisionTrace): string {
  return [
    "decision",
    `seq=${String(decision.evaluationSeq)}`,
    `instance=${decision.instanceId}`,
    `run=${decision.runId}`,
    `callback=${decision.callback}`,
    `type=${decision.decisionType}`,
    `reasons=${decision.reasonCodes.join(",")}`,
    `intents=${decision.intentIds.join(",")}`,
    `snapshot=${decision.featureSnapshotRef}`,
    `sourceEvent=${decision.sourceEventId}`,
  ].join(" ");
}

function traceLine(trace: TraceLink): string {
  return [
    "trace",
    `sourceEvent=${trace.sourceEventId}`,
    `snapshot=${trace.featureSnapshotRef}`,
    `run=${trace.runId}`,
    `evaluationSeq=${String(trace.evaluationSeq)}`,
    `intent=${trace.intentId}`,
    `approved=${trace.approvedIntentId}`,
    `plan=${trace.executionPlanId}`,
    `attempt=${trace.submissionAttemptId}`,
    `order=${trace.venueOrderId}`,
    `fill=${trace.venueFillId}`,
    `ledgerFill=${trace.ledgerFillId}`,
    `transactions=${trace.ledgerTransactionIds.join(",")}`,
  ].join(" ");
}

/** What the core sections are rendered from: the core that ran and the driver that drove it. */
export interface CoreSectionsInput {
  readonly trader: PaperTrader;
  readonly store: Pick<InMemoryTraderStore, "decisions" | "checkpoints" | "transactions" | "pnlSnapshots">;
  readonly driver: ReplayDriverObservations;
}

/**
 * Renders the artifact. Pure: the same inputs give the same bytes.
 *
 * `APPROX-REPLAY-1` (ADR-029 Decision 4.3): this is an EVIDENCE artifact — its
 * golden is a determinism gate — so it refuses an approximate result. Only an
 * exact replay's `ReplayRunResult` renders: a result that states any
 * `fidelity`, or whose serialization is not the exact run's
 * (`polymarket-bot/simulation-run/v3`), is refused by name. An approximate
 * run writes its own artifact (`approximate/serialize.ts`), labelled as such.
 */
export function renderBacktestArtifact(input: BacktestArtifactInput): BacktestArtifact {
  const result: unknown = input.outcome.result;
  const fidelity =
    typeof result === "object" && result !== null && Object.hasOwn(result, "fidelity")
      ? (result as { readonly fidelity: unknown }).fidelity
      : undefined;
  const serialization =
    typeof result === "object" && result !== null ? (result as { readonly serialization?: unknown }).serialization : undefined;
  if (
    fidelity !== undefined ||
    typeof serialization !== "string" ||
    !serialization.startsWith(`${SIMULATION_RUN_SERIALIZATION_VERSION}\n`)
  ) {
    return {
      ok: false,
      problem:
        `REPLAY_MANIFEST_APPROXIMATE: this artifact is evidence of an exact replay, and the result offered is not one ` +
        `(fidelity ${JSON.stringify(fidelity ?? "unstated")}); an approximate result is never determinism, calibration, ` +
        "promotion or soak evidence (ADR-029 Decisions 2 and 4.3)",
    };
  }
  const sections = renderCoreSections(input);
  if (!sections.ok) return sections;
  const lines: string[] = [BACKTEST_ARTIFACT_FORMAT_ID, "--- simulation-run ---", serialization, ...sections.lines];
  return { ok: true, text: `${lines.join("\n")}\n` };
}

/**
 * The sections the shared core produced — every persisted decision, every §6
 * invariant 4 chain, the ledger projection, the §9.16 snapshots, the health
 * counters, the store's write counts and the driver's counters — ending in
 * `end`. Shared by the exact artifact above and the approximate one, so the
 * two can never describe the core differently.
 */
export function renderCoreSections(
  input: CoreSectionsInput,
): { readonly ok: true; readonly lines: readonly string[] } | { readonly ok: false; readonly problem: string } {
  const loop = input.trader.loop;
  const health = loop.health();
  const retention = health.seams.retention;
  if (retention.decisions.evicted > 0 || retention.traces.evicted > 0) {
    return {
      ok: false,
      problem:
        `the core's bounded logs evicted ${String(retention.decisions.evicted)} decision(s) and ` +
        `${String(retention.traces.evicted)} chain(s) (bounds ${String(retention.decisions.maximumRetained)} / ` +
        `${String(retention.traces.maximumRetained)}); an artifact of what is left would report a truncated ` +
        "run as complete, so none is written",
    };
  }

  const lines: string[] = [];
  lines.push("--- decisions ---");
  for (const decision of loop.decisions()) lines.push(decisionLine(decision));
  lines.push("--- traces ---");
  for (const trace of loop.traces()) lines.push(traceLine(trace));

  const projection = projectionOf(loop.ledger());
  lines.push("--- ledger ---");
  lines.push(
    `ledger transactions=${String(projection.transactionCount)} ` +
      `unattributedActivity=${String(projection.unattributedActivity.length)} ` +
      `unexplainedMovements=${String(projection.unexplainedMovements.length)}`,
  );
  const positionKey = (line: { instanceId: string; marketId: string | null; assetId: string }): string =>
    `${line.instanceId}|${String(line.marketId)}|${line.assetId}`;
  const positions = [...projection.virtualPositions.values()].sort((a, b) =>
    positionKey(a) < positionKey(b) ? -1 : positionKey(a) > positionKey(b) ? 1 : 0,
  );
  for (const line of positions) {
    lines.push(
      `position instance=${line.instanceId} market=${String(line.marketId)} asset=${line.assetId} ` +
        `kind=${line.assetKind} balance=${line.balance}`,
    );
  }

  lines.push("--- pnl ---");
  for (const snapshot of input.store.pnlSnapshots) {
    lines.push(
      [
        "pnl",
        `scope=${snapshot.scope}`,
        `instance=${String(snapshot.instanceId)}`,
        `asOf=${snapshot.asOf}`,
        `realized=${snapshot.realizedPnl}`,
        `unrealizedMidpoint=${snapshot.unrealizedPnlMidpoint}`,
        `fees=${snapshot.feesPaid}`,
        `coreNet=${snapshot.coreNetPnl}`,
        `capitalCommitted=${snapshot.capitalCommitted}`,
      ].join(" "),
    );
  }

  lines.push("--- health ---");
  lines.push(
    [
      "health",
      `healthy=${String(health.healthy)}`,
      `halts=${health.halts.map((halt) => `${halt.code}@${halt.scope.kind}`).join(",")}`,
      `evaluations=${String(health.loop.evaluations)}`,
      `decisionsPersisted=${String(health.loop.decisionsPersisted)}`,
      `snapshotsUnavailable=${String(health.loop.snapshotsUnavailable)}`,
      `riskApprovals=${String(health.risk.approvals)}`,
      `riskRefusals=${String(health.risk.refusals)}`,
      `refusedExits=${String(health.risk.refusedExits)}`,
      `plansBuilt=${String(health.execution.plansBuilt)}`,
      `submissionsAccepted=${String(health.execution.submissionsAccepted)}`,
      `fillsObserved=${String(health.execution.fillsObserved)}`,
      `cancelsConfirmed=${String(health.execution.cancelsConfirmed)}`,
      `ledgerTransactions=${String(health.accounting.ledgerTransactions)}`,
      `pnlRecords=${String(health.accounting.pnlRecords)}`,
    ].join(" "),
  );
  lines.push("--- store ---");
  lines.push(
    `store decisions=${String(input.store.decisions.length)} ` +
      `checkpoints=${String(input.store.checkpoints.length)} ` +
      `ledgerTransactions=${String(input.store.transactions.length)} ` +
      `pnlSnapshots=${String(input.store.pnlSnapshots.length)}`,
  );
  lines.push("--- driver ---");
  lines.push(
    `driver eventsIngested=${String(input.driver.eventsIngested)} drains=${String(input.driver.drains)}`,
  );
  lines.push("end");
  return { ok: true, lines };
}
