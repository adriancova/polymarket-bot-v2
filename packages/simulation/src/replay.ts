/**
 * The replay run driver.
 *
 * This is the shared core's seam in one function: it verifies and orders a
 * dataset ({@link ./event-source.js}), positions the replay clock
 * ({@link ./clock.js}) and the simulated venue ({@link ./venue.js}) at each
 * recorded event, hands the event to a caller-supplied core-loop hook, and
 * produces a canonically serialized result ({@link ./serialize.js}).
 *
 * §12.1: "Everything between event input and the `ExecutionVenue` interface is
 * shared with the live path." The hook below is where that shared core plugs in.
 * `WP-230` assembles books, features, strategy runtime, risk, allocator, planner
 * and ledger into it; this package deliberately does not, because those are
 * same-layer packages with no §2.1 edge, and because a replay driver that also
 * owned the trading loop would make the loop untestable without a dataset.
 *
 * WHAT IS GUARANTEED HERE:
 *
 * - the clock advances only from recorded events, in recorded dispatch order;
 * - the venue is positioned at the same recorded event before the hook runs, so
 *   anything it produces is anchored to an event that actually happened;
 * - a refusal anywhere stops the run and is returned — a short run is never
 *   silently reported as a complete one (§8.3);
 * - the result's serialization is byte-identical for a fixed dataset, config and
 *   seed (§12.4), which `test/unit/simulation/determinism.test.ts` measures
 *   across runs AND across construction orders.
 */

import type { ReplayClockObservations } from "./clock.js";
import {
  DatasetEventSource,
  loadDataset,
  type DatasetArchiveReader,
  type DatasetLoadReport,
  type ReplayNormalizer,
  type ReplayRecord,
  type Sha256HexDigest,
} from "./event-source.js";
import type { SimulatedFill } from "./fill-model.js";
import {
  readRunPins,
  reconcileRunPins,
  type ReplayDataset,
  type ReplayRunPins,
} from "./manifest.js";
import { replayPathEconomics, type ReplayPathEconomics } from "./markout.js";
import { ownFrozenTree } from "./plain.js";
import type { EventEnvelope, RecordedEventIdentity, SimulatedOrder } from "./ports.js";
import type { RestingFillBand } from "./queue.js";
import {
  simulationFailure,
  simulationOk,
  totallyAsync,
  type SimulationResult,
} from "./refusals.js";
import { serializeRun, type SerializableDelivery } from "./serialize.js";
import type { SimulatedVenue } from "./venue.js";

/** What the core-loop hook is given for one delivered envelope. */
export interface ReplayEventContext {
  readonly envelope: EventEnvelope<unknown>;
  readonly record: ReplayRecord;
  readonly identity: RecordedEventIdentity;
  /** Recorded monotonic nanoseconds of this event. */
  readonly monotonicNs: bigint;
}

/**
 * The shared core loop, as far as this driver is concerned.
 *
 * Returning a refusal stops the run. A hook that throws is contained by
 * {@link runReplay}'s totality guard and becomes `SIMULATION_INTERNAL`.
 */
export type ReplayCoreLoop = (
  context: ReplayEventContext,
) => SimulationResult<null> | Promise<SimulationResult<null>>;

/** Inputs to a replay run. */
export interface ReplayRunOptions {
  readonly dataset: ReplayDataset;
  readonly archive: DatasetArchiveReader;
  readonly digestSha256: Sha256HexDigest;
  readonly normalizer: ReplayNormalizer;
  readonly runPins: ReplayRunPins;
  /** Optional: the shared core loop. Absent means "verify and drive only". */
  readonly coreLoop?: ReplayCoreLoop;
  /** Optional: the simulated venue to position at each recorded event. */
  readonly venue?: SimulatedVenue;
  /** Optional: Tier-1 resting bands produced during the run, for the report. */
  readonly bands?: readonly RestingFillBand[];
  readonly walSegments?: { read(segmentId: string): Promise<Uint8Array> };
}

/** What a replay run produced. */
export interface ReplayRunResult {
  readonly pins: ReplayRunPins;
  readonly load: DatasetLoadReport;
  /** What the delivery path observed, including the §8.4 venue-time disagreement. */
  readonly delivery: SerializableDelivery;
  readonly clock: ReplayClockObservations;
  readonly eventsDelivered: number;
  readonly orders: readonly SimulatedOrder[];
  readonly fills: readonly SimulatedFill[];
  readonly economics: ReplayPathEconomics;
  /**
   * Every Tier-1 resting BAND the run produced.
   *
   * Taken from the venue when one is driving the run, so a band reaches the
   * report through the same §12.1 seam a live adapter would sit behind, rather
   * than through a caller that happened to pass one in.
   */
  readonly bands: readonly RestingFillBand[];
  /** The §12.4 canonical form. Byte-identical for a fixed dataset/config/seed. */
  readonly serialization: string;
}

/**
 * Runs a replay. Total: every failure is a typed refusal.
 *
 * TOTAL INCLUDES THE PROMISE (round-4 review, MEDIUM-1's class). `runReplay`
 * used to REJECT on a hostile options bag — `Cannot read properties of null
 * (reading 'runPins')` — which the whole-surface battery had not caught because
 * it swallowed rejections instead of awaiting them. It now awaits, and this door
 * answers through {@link ./refusals.js#totallyAsync}.
 */
export async function runReplay(
  options: ReplayRunOptions,
): Promise<SimulationResult<ReplayRunResult>> {
  return await totallyAsync("running a replay", async () => await runReplayInner(options));
}

async function runReplayInner(
  options: ReplayRunOptions,
): Promise<SimulationResult<ReplayRunResult>> {
  if (options === null || typeof options !== "object") {
    return simulationFailure(
      "SIMULATION_INPUT_INVALID",
      "a replay run takes an options record naming its dataset, archive, digest, normalizer and run pins",
    );
  }
  // Validated BEFORE anything is read: ADR-012 §4 — "A result whose fill-model
  // parameters are not pinned is not reproducible and is not evidence of
  // anything." A run that cannot be cited is refused rather than produced.
  const validated = readRunPins(options.runPins);
  if (!validated.ok) return validated;
  const pins = reconcileRunPins(options.dataset, validated.value);
  if (!pins.ok) return pins;

  const loaded = await loadDataset({
    dataset: options.dataset,
    archive: options.archive,
    digestSha256: options.digestSha256,
    ...(options.walSegments === undefined ? {} : { walSegments: options.walSegments }),
  });
  if (!loaded.ok) return loaded;

  const created = DatasetEventSource.create(loaded.value, options.normalizer);
  if (!created.ok) return created;
  const source = created.value;

  // `(gatewayEpoch, ingestSeq)` is the recorded dispatch identity (§7.1), and
  // the dataset is single-epoch (wal-format.md §12.1), so `ingestSeq` is unique
  // among replay-eligible records and identifies the record an envelope came
  // from. A normalizer may emit several envelopes for one frame, so counting
  // envelopes would NOT identify it.
  const byIngestSeq = new Map<string, ReplayRecord>();
  for (const record of loaded.value.records) byIngestSeq.set(record.frame.ingestSeq, record);

  let eventsDelivered = 0;
  let hookRefusal: SimulationResult<null> | undefined;

  const drive = async (): Promise<SimulationResult<null>> => {
    for await (const envelope of source.events()) {
      const record = byIngestSeq.get(envelope.ingestSeq);
      /* c8 ignore next 3 -- the source refuses an envelope whose provenance differs. */
      if (record === undefined) {
        return simulationOk(null);
      }
      eventsDelivered += 1;
      const identity = DatasetEventSource.identityOf(record);
      // `observe` ANSWERS now (round-4 review, MEDIUM-1): it materializes the
      // identity it will stamp on every order, fill and snapshot, so it can
      // refuse one. A refusal STOPS the run — a venue positioned at nothing is
      // not a venue whose output is anchored to a recorded event (§6 invariant
      // 15), and continuing would produce results anchored to the PREVIOUS one.
      const positioned = options.venue?.observe(identity);
      if (positioned !== undefined && !positioned.ok) return positioned;
      const hook = options.coreLoop;
      if (hook !== undefined) {
        const outcome = await hook({
          envelope,
          record,
          identity,
          monotonicNs: BigInt(record.frame.receivedMonotonicNs),
        });
        if (!outcome.ok) {
          hookRefusal = outcome;
          return outcome;
        }
      }
    }
    return simulationOk(null);
  };

  const driven = await totallyAsync("driving the replay", drive);
  if (!driven.ok) return driven;
  if (hookRefusal !== undefined && !hookRefusal.ok) return hookRefusal;
  const sourceRefusal = source.refusal;
  if (sourceRefusal !== undefined) {
    return { ok: false, refusal: sourceRefusal } as SimulationResult<ReplayRunResult>;
  }

  const fills = options.venue?.fills ?? [];
  const orders = collectOrders(options.venue);
  const folded = replayPathEconomics(fills);
  if (!folded.ok) return folded;
  const economics = folded.value;
  const clock = source.clock.observations();
  // The venue's own bands when a venue drove the run: acceptance 4's band is
  // produced behind the §12.1 seam, not handed in beside it. `options.bands`
  // remains for a caller that computed bands without a venue.
  const bands = options.venue?.restingBands() ?? options.bands ?? [];
  const report = source.report();
  const delivery: SerializableDelivery = {
    envelopesDelivered: report.envelopesDelivered,
    venueTimestampInversions: report.venueTimestampInversions,
    envelopesWithoutVenueTimestamp: report.envelopesWithoutVenueTimestamp,
  };

  const serialization = serializeRun({
    pins: pins.value,
    load: loaded.value.report,
    delivery,
    clock,
    orders,
    fills,
    economics,
    bands,
  });

  return simulationOk(
    ownFrozenTree<ReplayRunResult>({
      pins: pins.value,
      load: loaded.value.report,
      delivery,
      clock,
      eventsDelivered,
      orders,
      fills,
      economics,
      bands,
      serialization,
    }),
  );
}

function collectOrders(venue: SimulatedVenue | undefined): readonly SimulatedOrder[] {
  return venue === undefined ? [] : venue.ordersSnapshot();
}
