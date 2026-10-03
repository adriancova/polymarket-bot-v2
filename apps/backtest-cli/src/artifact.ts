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

import { labelLine } from "./approximate/label.js";
import type { ReplayDriverObservations } from "./core-loop.js";
import type { BacktestOutcome } from "./run.js";

/**
 * The format id of the artifact. Frozen by the committed golden; bump = re-derive it.
 *
 * `v2` (`CADENCE-1`): a `--- cadence ---` section after the serialization
 * records the evaluation cadence the core ran with and, for a declared
 * reproduction, what it reproduces (ADR-026 D1.3, D1.6). A grammar change, so
 * a new id; every other line is `v1`'s.
 */
export const BACKTEST_ARTIFACT_FORMAT_ID = "polymarket-bot/backtest-static-bracket-replay/v2";

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
 * `APPROX-REPLAY-1` r1 (APPROX-R1-H2): the cores an approximate run built.
 * `approximate/run.ts` marks each core right after its assembly, before it
 * is driven, so whatever that core produced is never rendered as an exact
 * artifact, whichever outcome it is handed with. The trader, its loop (where
 * the decisions, chains and health are read) and the store are each marked.
 * Marking only ever adds a refusal.
 */
const approximateCores = new WeakSet<object>();

/** Marks a core as one an approximate run built (see {@link approximateCores}). */
export function markApproximateCore(core: Pick<CoreSectionsInput, "trader" | "store">): void {
  approximateCores.add(core.trader);
  approximateCores.add(core.trader.loop);
  approximateCores.add(core.store);
}

function isApproximateCore(input: Pick<CoreSectionsInput, "trader" | "store">): boolean {
  return approximateCores.has(input.trader) || approximateCores.has(input.trader.loop) || approximateCores.has(input.store);
}

/**
 * Renders the artifact. Pure: the same inputs give the same bytes.
 *
 * `APPROX-REPLAY-1` (ADR-029 Decision 4.3): this is an EVIDENCE artifact — its
 * golden is a determinism gate — so it refuses an approximate result. Only an
 * exact replay's `ReplayRunResult` renders: a result that states any
 * `fidelity`, or whose serialization is not the exact run's
 * (`polymarket-bot/simulation-run/v3`), is refused by name; so is a core an
 * approximate run built, even beside an exact result (r1, APPROX-R1-H2). An
 * approximate run writes its own artifact (`approximate/serialize.ts`),
 * labelled as such.
 */
export function renderBacktestArtifact(input: BacktestArtifactInput): BacktestArtifact {
  if (isApproximateCore(input)) {
    return {
      ok: false,
      problem:
        "REPLAY_MANIFEST_APPROXIMATE: this artifact is evidence of an exact replay, and the core offered was built " +
        "and driven by an approximate replay (a research-tier dataset); what it produced is never determinism, " +
        "calibration, promotion or soak evidence (ADR-029 Decisions 2 and 4.3)",
    };
  }
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
  const sections = coreSectionLines(input);
  if (!sections.ok) return sections;
  const lines: string[] = [
    BACKTEST_ARTIFACT_FORMAT_ID,
    "--- simulation-run ---",
    serialization,
    "--- cadence ---",
    cadenceLine(input.trader),
    ...sections.lines,
  ];
  return { ok: true, text: `${lines.join("\n")}\n` };
}

/**
 * `CADENCE-1` (ADR-026 D1.3, D1.6): the evaluation cadence the core RAN with —
 * read from the core, not from the pins it was handed — and, for a declared
 * reproduction, what it reproduces. `reproduces` is 1-256 printable ASCII
 * characters without a space (`evaluationCadenceProblem`), so the line stays
 * one line of `key=value` fields.
 */
function cadenceLine(trader: PaperTrader): string {
  const cadence = trader.loop.evaluationCadence();
  return [
    "cadence",
    `evaluationIntervalMs=${String(cadence.intervalMs)}`,
    `evaluationHeartbeatMs=${String(cadence.heartbeatMs)}`,
    `reproduction=${String(cadence.reproduces !== undefined)}`,
    ...(cadence.reproduces === undefined ? [] : [`reproduces=${cadence.reproduces}`]),
  ].join(" ");
}

/** Core section lines, or why they cannot be rendered. */
export type CoreSections =
  | { readonly ok: true; readonly lines: readonly string[] }
  | { readonly ok: false; readonly problem: string };

/**
 * The core sections of an APPROXIMATE artifact (`approximate/serialize.ts`):
 * the same sections the exact artifact renders, every line labelled with the
 * manifests' fidelity and escaped to one physical line
 * (`approximate/label.ts`). It never returns an unlabelled line: a fidelity
 * other than `approximate` (the only one the research-tier verifier admits)
 * is refused rather than printed as a label.
 *
 * `APPROX-REPLAY-1` r1 (APPROX-R1-H2): the unlabelled builder below is this
 * module's own; the package's public surface (`index.ts`) exports neither.
 */
export function renderApproximateCoreSections(input: CoreSectionsInput, fidelity: "approximate"): CoreSections {
  const stated: unknown = fidelity;
  if (stated !== "approximate") {
    return {
      ok: false,
      problem:
        `an approximate artifact's core sections are labelled with the manifests' fidelity, which is "approximate"; ` +
        `the fidelity offered was ${JSON.stringify(typeof stated === "string" ? stated : String(stated))}, so nothing is rendered`,
    };
  }
  const sections = coreSectionLines(input);
  if (!sections.ok) return sections;
  return { ok: true, lines: sections.lines.map((line) => labelLine(fidelity, line)) };
}

/**
 * The sections the shared core produced — every persisted decision, every §6
 * invariant 4 chain, the ledger projection, the §9.16 snapshots, the health
 * counters, the store's write counts and the driver's counters — ending in
 * `end`. UNLABELLED, so private to this module: the exact artifact above and
 * {@link renderApproximateCoreSections} are its only callers, so the two
 * artifacts can never describe the core differently, and no caller can render
 * an approximate core without its label.
 */
function coreSectionLines(input: CoreSectionsInput): CoreSections {
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
