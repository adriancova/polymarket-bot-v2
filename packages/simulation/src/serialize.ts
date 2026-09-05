/**
 * Canonical serialization of a replay run (§12.4).
 *
 * §12.4: "A fixed dataset, code commit, config, feature version, model version,
 * simulator version, and seed must produce **byte-identical** decisions,
 * intents, risk results, execution plans, simulated order events, fills, ledger
 * events, and PnL outputs." A determinism claim needs a canonical form to be
 * claimed ABOUT, and this is it for the parts this package owns: simulated order
 * events and fills.
 *
 * ## The rules that make it byte-identical
 *
 * - **Fixed line grammar, fixed field order.** Nothing is emitted from object
 *   key order, so a refactor cannot silently change the bytes (the same rule
 *   `WP-130`'s `encodeDatasetManifest` and `WP-150`'s `serializeBook` follow).
 * - **Every economic value is its canonical decimal string**, verbatim. No
 *   formatting, no locale, no rounding at the boundary.
 * - **Collections are ordered by a total, value-derived key** — never by
 *   insertion order into a `Map`, which depends on construction order and is
 *   exactly what `test/unit/simulation/determinism.test.ts` shuffles.
 * - **No timestamp is generated.** Every instant printed is a RECORDED one.
 *
 * The format id is versioned; a change to the grammar is a change to it.
 */

import type { ReplayClockObservations } from "./clock.js";
import type { SimulatedFill } from "./fill-model.js";
import type { DatasetLoadReport, EventSourceReport } from "./event-source.js";
import type { ReplayRunPins } from "./manifest.js";
import type { ReplayPathEconomics } from "./markout.js";
import type { SimulatedOrder } from "./ports.js";
import type { RestingFillBand, RestingScenarioOutcome, SameInstantAdditions } from "./queue.js";

/**
 * The serialization format id. A grammar change changes this string.
 *
 * `v2`: the round-1 review moved the venue-timestamp diagnostic onto the
 * delivery line where the normalized envelopes are (the `counts` line's old
 * `venueTimestampInversions=` measured recorded ARRIVAL order), added the
 * order's `fillEstimateKind`, and gave the `band` line the identity of the
 * resting order it is about. Those are grammar changes, so this is a new id.
 *
 * `v3`: the round-2 review (L4) replaced the band's same-instant-additions
 * input — a bare `"0"` that could not distinguish "looked and saw nothing" from
 * "did not look" — with a tagged {@link ../queue.js#SameInstantAdditions}, and
 * the `band` line now prints it. A run whose conservative arm rests on an
 * unmeasured quantity says so in its own bytes.
 */
export const SIMULATION_RUN_SERIALIZATION_VERSION = "polymarket-bot/simulation-run/v3";

/** What the delivery path observed, as the serialization records it. */
export type SerializableDelivery = Pick<
  EventSourceReport,
  "envelopesDelivered" | "venueTimestampInversions" | "envelopesWithoutVenueTimestamp"
>;

/** Everything a serialized run contains. */
export interface SerializableRun {
  readonly pins: ReplayRunPins;
  readonly load: DatasetLoadReport;
  readonly delivery: SerializableDelivery;
  readonly clock: ReplayClockObservations;
  readonly orders: readonly SimulatedOrder[];
  readonly fills: readonly SimulatedFill[];
  readonly economics: ReplayPathEconomics;
  readonly bands: readonly RestingFillBand[];
}

function field(name: string, value: string | number | boolean): string {
  return `${name}=${String(value)}`;
}

/** Serializes a run to its canonical line form. */
export function serializeRun(run: SerializableRun): string {
  const lines: string[] = [SIMULATION_RUN_SERIALIZATION_VERSION];

  lines.push(
    [
      "run",
      field("simulator", run.pins.simulatorVersion),
      field("seed", run.pins.runSeed),
      field("fillModel", run.pins.fillModelVersion),
      field("fillModelParams", run.pins.fillModelParametersHash),
      field("latencyModel", run.pins.latencyModelVersion),
      field("latencyModelParams", run.pins.latencyModelParametersHash),
    ].join(" "),
  );
  lines.push(
    [
      "pins",
      field("normalizer", run.pins.normalizerVersion),
      field("featureSet", run.pins.featureSetVersion),
      field("fee", run.pins.feeSnapshotVersion),
      field("reward", run.pins.rewardSnapshotVersion),
      field("settlement", [...run.pins.settlementSpecVersions].sort().join(",")),
    ].join(" "),
  );
  lines.push(
    [
      "dataset",
      field("id", run.load.datasetId),
      field("epoch", run.load.gatewayEpoch),
      field("objects", run.load.objectsVerified),
      field("walSegments", run.load.walSegmentVerification),
    ].join(" "),
  );
  lines.push(
    [
      "counts",
      field("read", run.load.rowsRead),
      field("delivered", run.load.rowsDelivered),
      field("excludedIncident", run.load.rowsExcludedByIncident),
      field("excludedDuplicate", run.load.rowsExcludedAsDuplicate),
      field("receivedAtInversions", run.load.receivedAtInversions),
    ].join(" "),
  );
  lines.push(
    [
      "delivery",
      field("envelopes", run.delivery.envelopesDelivered),
      field("venueTimestampInversions", run.delivery.venueTimestampInversions),
      field("withoutVenueTimestamp", run.delivery.envelopesWithoutVenueTimestamp),
    ].join(" "),
  );
  lines.push(
    [
      "clock",
      field("start", run.clock.startedAt),
      field("end", run.clock.currentAt),
      field("startNs", run.clock.startedMonotonicNs),
      field("endNs", run.clock.currentMonotonicNs),
      field("advances", run.clock.advances),
      field("wallClockRegressions", run.clock.wallClockRegressions),
    ].join(" "),
  );

  for (const order of [...run.orders].sort((a, b) => compareStrings(a.simulatedOrderId, b.simulatedOrderId))) {
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

  for (const fill of [...run.fills].sort((a, b) => compareStrings(a.simulatedFillId, b.simulatedFillId))) {
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

  lines.push(
    [
      "economics",
      field("basis", run.economics.basis),
      field("buy", run.economics.buyNotional),
      field("sell", run.economics.sellNotional),
      field("fees", run.economics.fees),
      field("net", run.economics.netCashFlow),
      field("sharesBought", run.economics.sharesBought),
      field("sharesSold", run.economics.sharesSold),
      field("fills", run.economics.fillCount),
      field("markoutPenaltyApplied", run.economics.markoutPenaltyApplied),
    ].join(" "),
  );

  // Ordered by the band's OWN serialized line, which is a total, value-derived
  // key: two bands that print the same line are the same bytes, and every other
  // pair has a strict order. The previous key was the order id of whichever fill
  // happened to sort first in the optimistic scenario — absent for a band with
  // no fills, and identical for every band of one order, so reversing the input
  // changed the bytes (round-1 review L2, probe T2).
  const bandLines = run.bands.map((band) => serializeBand(band)).sort(compareStrings);
  for (const line of bandLines) lines.push(line);

  lines.push("end");
  return lines.join("\n");
}

/**
 * Serializes one Tier-1 resting band.
 *
 * All three members are on ONE line, so a band cannot be printed with a member
 * missing (§12.2 "Report a result band, not one falsely precise fill result").
 */
export function serializeBand(band: RestingFillBand): string {
  return [
    "band",
    field("order", band.simulatedOrderId),
    field("market", band.marketId),
    field("price", band.restingPrice),
    field("queueModel", band.queueModelVersion),
    field("fillModel", band.model.fillModelVersion),
    field("basis", band.bandBasis),
    field("sameInstantAdditions", renderSameInstantAdditions(band.sameInstantAdditions)),
    scenarioField("optimistic", band.optimistic),
    scenarioField("base", band.base),
    scenarioField("conservative", band.conservative),
  ].join(" ");
}

/**
 * Prints the band's same-instant-additions input (round-2 review, L4).
 *
 * `NOT_OBSERVED` and `OBSERVED:0` are different bytes because they are different
 * facts: the second says a root looked and saw nothing added at our price, and
 * the first says nobody looked — which is what the CONSERVATIVE scenario's queue
 * ahead would otherwise silently rest on.
 */
function renderSameInstantAdditions(additions: SameInstantAdditions): string {
  return additions === "NOT_OBSERVED" ? "NOT_OBSERVED" : `OBSERVED:${additions.observedShares}`;
}

function scenarioField(name: string, outcome: RestingScenarioOutcome): string {
  return [
    `${name}[`,
    field("filled", outcome.filledShares),
    field("remaining", outcome.remainingShares),
    field("queueAhead", outcome.queueAheadAtPlacement),
    field("queueLeft", outcome.queueAheadRemaining),
    field("postCancelFills", outcome.fillsAfterCancelRequest),
    field("fills", outcome.fills.length),
    "]",
  ].join(" ");
}

/**
 * A total, locale-independent string comparison.
 *
 * `localeCompare` depends on the host's ICU data, which is exactly the kind of
 * environment dependence a byte-identical claim must not have.
 */
function compareStrings(left: string, right: string): -1 | 0 | 1 {
  return left < right ? -1 : left > right ? 1 : 0;
}
