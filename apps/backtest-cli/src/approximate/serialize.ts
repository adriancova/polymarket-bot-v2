/**
 * Every output of an approximate run, labelled from its manifests
 * (`APPROX-REPLAY-1`; ADR-029 Decision 4).
 *
 * ADR-029 Decision 4: "Every report, run record and export from an
 * approximate dataset says 'approximate'. The label is carried in the run's
 * manifest, not inferred from a file name." So the label printed here is the
 * manifests' own `fidelity` value, read through the verifier
 * (`ApproximateReplayResult.fidelity`, set from `ResearchTierManifest.fidelity`),
 * and the admissibility statement is the manifests' own text, verbatim.
 *
 * The label is on EVERY LINE, not only in a header: each line of the run
 * serialization after its format id, and each line of the artifact after its
 * format id, begins with the fidelity token. A line copied out of an
 * approximate result still says what it is, and no line of it is a line an
 * exact artifact could contain (an exact artifact's lines never begin with
 * `approximate `). The format ids are their own:
 *
 * - {@link APPROXIMATE_RUN_SERIALIZATION_VERSION}, never the exact
 *   `polymarket-bot/simulation-run/v3`;
 * - {@link APPROXIMATE_ARTIFACT_FORMAT_ID}, never the exact
 *   `polymarket-bot/backtest-static-bracket-replay/v1`.
 *
 * What the core produced is rendered by the exact artifact's own
 * `renderCoreSections`, so the two artifacts can never describe the core
 * differently; only the label and the run section differ.
 *
 * Determinism inside the class (ADR-029 Decision 6): the same research tier,
 * code, configuration, pins and seed give the same bytes. That shows the
 * replay is repeatable; it is not evidence about exact data.
 */

import { serializeBand } from "@polymarket-bot/simulation";

import { renderCoreSections, type BacktestArtifact, type CoreSectionsInput } from "../artifact.js";
import type { ApproximateReplayResult } from "./run.js";

/** The approximate run serialization's format id. A grammar change changes it. */
export const APPROXIMATE_RUN_SERIALIZATION_VERSION = "polymarket-bot/approximate-run/v1";

/** The approximate artifact's format id. */
export const APPROXIMATE_ARTIFACT_FORMAT_ID = "polymarket-bot/approximate-backtest-replay/v1";

/**
 * The evidence class every approximate output states: never determinism,
 * calibration, promotion or soak evidence (ADR-029 Decision 2), ranked below
 * every ADR-012 tier (Decision 3).
 */
export const APPROXIMATE_EVIDENCE_CLASS = "APPROXIMATE_NOT_EVIDENCE";
/** ADR-029 Decision 3. */
export const APPROXIMATE_RANK = "BELOW_EVERY_ADR012_TIER";
/** How the replay clock's monotonic reading was obtained (the research tier records none). */
export const APPROXIMATE_MONOTONIC_BASIS = "DERIVED_FROM_AVAILABLE_AT_MILLISECONDS_NON_DECREASING";

function field(name: string, value: string | number | boolean): string {
  return `${name}=${String(value)}`;
}

function compareStrings(left: string, right: string): -1 | 0 | 1 {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** The label line: the manifests' fidelity, the evidence class, the rank. */
export function fidelityLine(fidelity: string): string {
  return [field("fidelity", fidelity), field("evidence", APPROXIMATE_EVIDENCE_CLASS), field("rank", APPROXIMATE_RANK)].join(" ");
}

/** The run section, unlabelled, beginning with its format id. */
function runBody(result: ApproximateReplayResult): string[] {
  const source = result.source;
  const pins = result.pins;
  const lines: string[] = [APPROXIMATE_RUN_SERIALIZATION_VERSION, `label ${fidelityLine(result.fidelity)}`];
  for (const statement of source.admissibility) lines.push(`admissibility ${statement}`);
  lines.push(
    [
      "run",
      field("simulator", pins.simulatorVersion),
      field("seed", pins.runSeed),
      field("fillModel", pins.fillModelVersion),
      field("fillModelParams", pins.fillModelParametersHash),
      field("latencyModel", pins.latencyModelVersion),
      field("latencyModelParams", pins.latencyModelParametersHash),
    ].join(" "),
  );
  lines.push(
    [
      "pins",
      field("translation", pins.normalizerVersion),
      field("featureSet", pins.featureSetVersion),
      field("fee", pins.feeSnapshotVersion),
      field("reward", pins.rewardSnapshotVersion),
      field("settlement", [...pins.settlementSpecVersions].sort().join(",")),
    ].join(" "),
  );
  lines.push(
    [
      "research",
      field("epoch", source.gatewayEpoch),
      field("datasets", source.datasets.length),
      field("chainStart", source.chainStart),
      field("downsampling", `${source.downsampling.downsamplingId}@${String(source.downsampling.downsamplingVersion)}`),
      field("samplesRead", source.samplesRead),
      field("releaseFrames", source.releaseFrames.length),
    ].join(" "),
  );
  for (const dataset of source.datasets) {
    const manifest = dataset.manifest;
    lines.push(
      [
        "dataset",
        field("id", manifest.datasetId),
        field("fidelity", manifest.fidelity),
        field("manifest", dataset.manifestObjectKey),
        field("manifestSha256", dataset.manifestSha256),
        field("layout", `${manifest.schemaVersions.researchTierLayoutId}@${String(manifest.schemaVersions.researchTierLayoutVersion)}`),
        field("samples", manifest.recordCounts.samplesWritten),
        field("stateIn", manifest.samplerState.stateIn === null ? "none" : manifest.samplerState.stateIn.datasetId),
        field("sourceSegments", manifest.sourceSegments.length),
      ].join(" "),
    );
    for (const object of [...manifest.objects].sort((a, b) => compareStrings(a.objectKey, b.objectKey))) {
      lines.push(
        [
          "object",
          field("table", object.table),
          field("key", object.objectKey),
          field("rows", object.rowCount),
          field("sha256", object.sha256),
        ].join(" "),
      );
    }
  }
  const counts = result.translation;
  lines.push(
    [
      "translation",
      field("version", pins.normalizerVersion),
      field("samples", counts.samples),
      field("bookSnapshots", counts.bookSnapshots),
      field("bookSamplesSuperseded", counts.bookSamplesSuperseded),
      field("publicTrades", counts.publicTrades),
      field("tradesNotReplayed", counts.tradesNotReplayed),
      field("referenceBars", counts.referenceBars),
      field("referenceBarsNotReplayed", counts.referenceBarsNotReplayed),
      field("lifecycleEnvelopes", counts.lifecycleEnvelopes),
      field("gammaPollsAttributed", counts.gammaPollsAttributed),
      field("gammaPollsUnattributed", counts.gammaPollsUnattributed),
      field("lifecycleRowsNotReplayed", counts.lifecycleRowsNotReplayed),
      field("feedEventsNotReplayed", counts.feedEventsNotReplayed),
      field("chainlinkTicksNotReplayed", counts.chainlinkTicksNotReplayed),
      field("unconfiguredMarketSamples", counts.unconfiguredMarketSamples),
    ].join(" "),
  );
  for (const lifecycle of result.lifecycles) {
    lines.push(
      [
        "lifecycle",
        field("market", lifecycle.marketId),
        field("gammaMarketId", lifecycle.gammaMarketId),
        field("phase", lifecycle.phase),
        field("openedAtFrame", lifecycle.openedAtFrame ?? "none"),
        field("scheduledClosingAtFrame", lifecycle.scheduledClosingAtFrame ?? "none"),
        field("observedClosingAtFrame", lifecycle.observedClosingAtFrame ?? "none"),
        field("contradictedBeforeOpen", lifecycle.contradictedBeforeOpen),
        field("readinessLostWhileOpen", lifecycle.readinessLostWhileOpen),
      ].join(" "),
    );
  }
  lines.push(
    [
      "delivery",
      field("releaseFrames", result.releaseFramesDelivered),
      field("envelopes", result.envelopesDelivered),
      field(
        "byType",
        [...result.envelopesByType.entries()]
          .sort(([left], [right]) => compareStrings(left, right))
          .map(([type, count]) => `${type}:${String(count)}`)
          .join(","),
      ),
    ].join(" "),
  );
  const clock = result.clock;
  lines.push(
    [
      "clock",
      field("start", clock.startedAt),
      field("end", clock.currentAt),
      field("startNs", clock.startedMonotonicNs),
      field("endNs", clock.currentMonotonicNs),
      field("advances", clock.advances),
      field("wallClockRegressions", clock.wallClockRegressions),
      field("monotonicBasis", APPROXIMATE_MONOTONIC_BASIS),
    ].join(" "),
  );
  for (const order of [...result.orders].sort((a, b) => compareStrings(a.simulatedOrderId, b.simulatedOrderId))) {
    lines.push(
      [
        "order",
        order.simulatedOrderId,
        order.executionPlanId,
        order.marketId,
        order.tokenId,
        order.side,
        order.action,
        order.limitPrice,
        order.requestedShares,
        order.filledShares,
        order.state,
        order.executionStyle,
        order.fillEstimateKind,
        String(order.postOnly),
        order.atEvent.gatewayEpoch,
        order.atEvent.ingestSeq,
        String(order.atEvent.datasetRowOrdinal),
      ].join(" "),
    );
  }
  for (const fill of [...result.fills].sort((a, b) => compareStrings(a.simulatedFillId, b.simulatedFillId))) {
    lines.push(
      [
        "fill",
        fill.simulatedFillId,
        fill.simulatedOrderId,
        fill.marketId,
        fill.tokenId,
        fill.side,
        fill.action,
        fill.price,
        fill.shares,
        fill.feeAmount,
        fill.liquidityRole,
        fill.model.tier,
        fill.fillModelVersion,
        fill.evidenceClass,
        fill.planningDepthAwareness,
        fill.atEvent.gatewayEpoch,
        fill.atEvent.ingestSeq,
        String(fill.atEvent.datasetRowOrdinal),
      ].join(" "),
    );
  }
  const economics = result.economics;
  lines.push(
    [
      "economics",
      field("basis", economics.basis),
      field("buy", economics.buyNotional),
      field("sell", economics.sellNotional),
      field("fees", economics.fees),
      field("net", economics.netCashFlow),
      field("sharesBought", economics.sharesBought),
      field("sharesSold", economics.sharesSold),
      field("fills", economics.fillCount),
      field("markoutPenaltyApplied", economics.markoutPenaltyApplied),
    ].join(" "),
  );
  for (const line of result.bands.map((band) => serializeBand(band)).sort(compareStrings)) lines.push(line);
  lines.push("end");
  return lines;
}

/** Prefixes every line with the manifests' fidelity token. */
function labelled(fidelity: string, lines: readonly string[]): string[] {
  return lines.map((line) => `${fidelity} ${line}`);
}

/**
 * The run's canonical serialization: its format id, then every line labelled
 * with the manifests' fidelity. Byte-identical for a fixed research tier,
 * code, configuration, pins and seed (ADR-029 Decision 6).
 */
export function serializeApproximateRun(result: ApproximateReplayResult): string {
  const body = runBody(result);
  return [body[0] as string, ...labelled(result.fidelity, body.slice(1))].join("\n");
}

/** What an approximate artifact is rendered from: a completed run and the core that ran. */
export interface ApproximateArtifactInput extends CoreSectionsInput {
  readonly result: ApproximateReplayResult;
}

/**
 * The approximate artifact: its format id, then every line labelled — the
 * label line, the run section, and what the core produced (the exact
 * artifact's own sections). A truncated core log is refused, as the exact
 * artifact refuses it.
 */
export function renderApproximateArtifact(input: ApproximateArtifactInput): BacktestArtifact {
  const sections = renderCoreSections(input);
  if (!sections.ok) return sections;
  const fidelity = input.result.fidelity;
  const lines = [
    APPROXIMATE_ARTIFACT_FORMAT_ID,
    ...labelled(fidelity, [
      `label ${fidelityLine(fidelity)}`,
      "--- approximate-run ---",
      ...runBody(input.result),
      ...sections.lines,
    ]),
  ];
  return { ok: true, text: `${lines.join("\n")}\n` };
}
