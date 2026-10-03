/**
 * The approximate backtest run (`APPROX-REPLAY-1`; ADR-029): a research-tier
 * replay through the SAME shared core the exact `run` command builds.
 *
 * What is the same as the exact run, by construction:
 *
 * - the core: `assembleBacktestCore` (`../assembly.ts`), the one assembly of
 *   `createPaperTrader` over the core's one simulated-venue builder, with the
 *   run pins reconciled against the configuration (BT1-R2);
 * - the driver: the shipped `replayDrivenCoreLoop` with its record framing,
 *   bound to the core's clock and halt latch, so the core evaluates once per
 *   release frame (ADR-024) and a latched halt stops the replay where the
 *   live pump returns `HALTED` (BT1-R3);
 * - the venue is positioned at each delivered event before the core sees it,
 *   as `packages/simulation`'s `runReplay` does, and a venue that evicted
 *   history refuses the run (`SIMULATED_VENUE_HISTORY_EVICTED`).
 *
 * What differs, and why:
 *
 * - the event source is {@link readResearchTierReplaySource}: verified
 *   research-tier samples in the dispatch order of their release frames, one
 *   gateway epoch only — never `runReplay`, whose door refuses an approximate
 *   manifest (`REPLAY_MANIFEST_APPROXIMATE`) and must keep doing so;
 * - the samples become envelopes through {@link ResearchSampleTranslator},
 *   whose version the run pins pin as their `normalizerVersion`;
 * - the result is labelled `approximate` from the manifests, everywhere it is
 *   printed or written ({@link ./serialize.js}); so is every line the core's
 *   venue logs through {@link ApproximateRunOptions.log} (r1, APPROX-R1-H1);
 * - the core is marked as an approximate run's (`markApproximateCore`) right
 *   after its assembly, so the exact artifact renderer refuses whatever it
 *   produced, whatever result it is handed with (r1, APPROX-R1-H2).
 *
 * ## The clock is positioned at every sample (ADR-031 R7)
 *
 * The driver advances the replay clock to the release frame's recorded
 * receipt instant BEFORE each envelope is ingested, and every envelope's
 * `receivedAt` is that same instant. So whenever the core reads its clock
 * while processing a sample, `processNow` equals the event instant and the
 * process-lag guard (ADR-023 D7; ADR-031 R2) reads a lag of 0. A sample that
 * yields no envelope (a connection note, say) reaches no core and moves no
 * clock, exactly as a recorded frame that normalizes to nothing does in the
 * exact replay.
 *
 * SAFETY: `BACKTEST` root, PAPER core, simulated venue; no credential, no
 * venue connection, no signer, no order. The research tier is only read.
 */

import {
  readRunPins,
  replayPathEconomics,
  type EventEnvelope,
  type RecordedEventIdentity,
  type ReplayClockObservations,
  type ReplayCoreLoop,
  type ReplayNormalizer,
  type ReplayRecord,
  type ReplayRunPins,
  type RestingFillBand,
  type SimulatedFill,
  type SimulatedOrder,
  type SimulatedVenue,
  type SimulationRefusal,
  type ReplayPathEconomics,
} from "@polymarket-bot/simulation";
import { parseTraderConfig, type AccountingChecks } from "@polymarket-bot/trading-core";
import type { ObjectStore } from "@polymarket-bot/storage-parquet";

import { sha256Hex } from "../archive.js";
import { markApproximateCore } from "../artifact.js";
import {
  assembleBacktestCore,
  checkBacktestCoreSafety,
  type BacktestCore,
  type BacktestRefusal,
} from "../assembly.js";
import type { ReplayDriverObservations, ReplayFraming } from "../core-loop.js";
import { BACKTEST_RUN_MODE } from "../safety.js";
import { labelledLog } from "./label.js";
import {
  readResearchTierReplaySource,
  type ReleaseFrame,
  type ResearchSourceRefusalCode,
  type ResearchTierReplaySource,
} from "./research-source.js";
import {
  APPROXIMATE_TRANSLATION_VERSION,
  ResearchSampleTranslator,
  approximateMarketsOf,
  type LifecycleOutcome,
  type TranslationCounts,
} from "./translate.js";

/** Why an approximate run did not start, or stopped. */
export interface ApproximateRunRefusal {
  readonly code:
    | ResearchSourceRefusalCode
    | BacktestRefusal["code"]
    | "APPROX_RUN_PINS_REFUSED"
    | "APPROX_RUN_LIFECYCLE_UNATTRIBUTED"
    | "APPROX_RUN_NOTHING_TO_REPLAY";
  readonly detail: string;
  readonly issues: readonly string[];
  /** `approximate` once a manifest verified and said so; absent before. */
  readonly fidelity?: "approximate";
}

/** What the replay produced, labelled from the manifests. */
export interface ApproximateReplayResult {
  /** From the manifests (ADR-029 Decision 4.2). */
  readonly fidelity: "approximate";
  readonly runMode: typeof BACKTEST_RUN_MODE;
  readonly pins: ReplayRunPins;
  readonly source: ResearchTierReplaySource;
  readonly translation: TranslationCounts;
  readonly lifecycles: readonly LifecycleOutcome[];
  readonly releaseFramesDelivered: number;
  readonly envelopesDelivered: number;
  readonly envelopesByType: ReadonlyMap<string, number>;
  readonly clock: ReplayClockObservations;
  readonly orders: readonly SimulatedOrder[];
  readonly fills: readonly SimulatedFill[];
  readonly economics: ReplayPathEconomics;
  readonly bands: readonly RestingFillBand[];
}

/** A run that started: completed, or stopped part-way, with the core it ran. */
export interface ApproximateRun {
  readonly fidelity: "approximate";
  readonly outcome:
    | { readonly ok: true; readonly result: ApproximateReplayResult }
    | { readonly ok: false; readonly refusal: SimulationRefusal | ApproximateStop };
  readonly source: ResearchTierReplaySource;
  readonly core: BacktestCore;
  readonly driver: ReplayDriverObservations;
}

/** A stop that is the translation's, not the core's. */
export interface ApproximateStop {
  readonly code: "APPROX_TRANSLATION_REFUSED" | "APPROX_RUN_INTERNAL";
  readonly message: string;
  readonly details: Readonly<Record<string, string | number>>;
}

export type ApproximateRunResult =
  | { readonly ok: true; readonly run: ApproximateRun }
  | { readonly ok: false; readonly refusal: ApproximateRunRefusal };

/** Inputs to {@link runApproximateBacktest}. */
export interface ApproximateRunOptions {
  readonly environment: Readonly<Record<string, string | undefined>>;
  /** The operator configuration document, unparsed (the trader's own). */
  readonly traderConfig: unknown;
  /** The §12.5 run pins; `normalizerVersion` must name the translation. */
  readonly runPins: unknown;
  /** The research tier's object store. Read only. */
  readonly objectStore: Pick<ObjectStore, "head" | "get">;
  /** The datasets' manifest keys, in chain order, one gateway epoch. */
  readonly manifestObjectKeys: readonly string[];
  /** Each configured market's Gamma market id (`internalMarketId` → id). */
  readonly gammaMarketIds: ReadonlyMap<string, string>;
  readonly idNamespace?: string;
  readonly accountingChecks?: AccountingChecks;
  /**
   * Where the core's venue logs (an unresolvable time-in-force). Every line
   * it receives is labelled with the manifests' fidelity and is one physical
   * line (`./label.ts`): the venue only logs once a manifest has verified.
   */
  readonly log?: (line: string) => void;
}

function refuse(
  code: ApproximateRunRefusal["code"],
  detail: string,
  issues: readonly string[] = [],
  fidelity?: "approximate",
): { readonly ok: false; readonly refusal: ApproximateRunRefusal } {
  return { ok: false, refusal: { code, detail, issues, ...(fidelity === undefined ? {} : { fidelity }) } };
}

const NS_PER_MS = 1_000_000n;

/**
 * Each release frame's DERIVED monotonic reading: its receipt instant in
 * milliseconds, as nanoseconds, never below the previous frame's. The
 * research tier records no `receivedMonotonicNs` (its rows carry the release
 * frame's receipt instant only), and the replay clock refuses a regression.
 */
export function derivedMonotonicNs(frames: readonly ReleaseFrame[]): readonly string[] {
  const readings: string[] = [];
  let previous = -1n;
  for (const frame of frames) {
    const ns = BigInt(frame.availableAtEpochMs) * NS_PER_MS;
    previous = ns > previous ? ns : previous;
    readings.push(previous.toString());
  }
  return readings;
}

/**
 * The release frame as a replay record, for the shipped driver. The research
 * tier holds a release frame's epoch, `ingestSeq`, receipt instant and
 * segment; its source, endpoint, connection and payload are not held and are
 * left empty, and its monotonic reading is the derived one. The driver reads
 * only the epoch, the `ingestSeq`, the instant and the monotonic reading
 * (`core-loop.ts`).
 */
export function releaseRecord(frame: ReleaseFrame, receivedMonotonicNs: string): ReplayRecord {
  return {
    datasetRowOrdinal: frame.releaseOrdinal,
    segmentId: frame.releaseSegmentId,
    segmentRecordIndex: -1,
    frameLineSha256: "",
    frame: {
      gatewayEpoch: frame.gatewayEpoch,
      ingestSeq: frame.releaseIngestSeq,
      source: "",
      endpoint: "",
      connectionId: "",
      subscriptionGeneration: 0,
      receivedAt: frame.availableAt,
      receivedMonotonicNs,
      payloadUtf8: "",
      payloadSha256: "",
    },
  };
}

/** What {@link deliverReleaseFrames} delivered, and why it stopped, if it did. */
export interface DeliveryOutcome {
  readonly releaseFramesDelivered: number;
  readonly envelopesDelivered: number;
  readonly envelopesByType: ReadonlyMap<string, number>;
  readonly stop: SimulationRefusal | ApproximateStop | undefined;
}

/** Inputs to {@link deliverReleaseFrames}. */
export interface DeliveryOptions {
  readonly frames: readonly ReleaseFrame[];
  /** Each frame's derived monotonic reading ({@link derivedMonotonicNs}). */
  readonly monotonic: readonly string[];
  readonly translator: Pick<ResearchSampleTranslator, "translate">;
  /** The driver's record framing (`assembly.ts`). */
  readonly framing: ReplayFraming;
  /** The shipped driver's hook, `replayDrivenCoreLoop(...).coreLoop`. */
  readonly coreLoop: ReplayCoreLoop;
  /** The simulated venue, positioned at each event before the core sees it. */
  readonly venue: Pick<SimulatedVenue, "observe">;
}

/**
 * Delivers the release frames, in order, through the shipped driver: per
 * frame, translate its samples; register the frame's envelopes with the
 * framing (so the driver drains once, after the last); then, per envelope,
 * position the venue and hand the envelope to the driver, which advances the
 * replay clock to the frame's receipt instant BEFORE it ingests (ADR-031 R7).
 * The first refusal stops the delivery; nothing after it is delivered.
 */
export async function deliverReleaseFrames(options: DeliveryOptions): Promise<DeliveryOutcome> {
  // The framing learns each release frame's last envelope through the
  // normalizer it wraps, so the driver drains once per release frame.
  let pending: readonly EventEnvelope<unknown>[] = [];
  const framed: ReplayNormalizer = options.framing.wrap({
    normalizerVersion: APPROXIMATE_TRANSLATION_VERSION,
    normalize: () => ({ ok: true, envelopes: pending }),
  });
  let releaseFramesDelivered = 0;
  let envelopesDelivered = 0;
  const envelopesByType = new Map<string, number>();
  let stop: SimulationRefusal | ApproximateStop | undefined;

  try {
    for (let index = 0; index < options.frames.length && stop === undefined; index += 1) {
      const frame = options.frames[index] as ReleaseFrame;
      const reading = options.monotonic[index];
      if (reading === undefined) {
        stop = { code: "APPROX_RUN_INTERNAL", message: "a release frame has no derived monotonic reading", details: {} };
        break;
      }
      const translated = options.translator.translate(frame, reading);
      if (!translated.ok) {
        stop = { code: translated.refusal.code, message: translated.refusal.detail, details: translated.refusal.details };
        break;
      }
      if (translated.envelopes.length === 0) continue;
      const record = releaseRecord(frame, reading);
      pending = translated.envelopes;
      const normalized = framed.normalize(record);
      if (!normalized.ok) {
        stop = { code: "APPROX_RUN_INTERNAL", message: normalized.reason, details: {} };
        break;
      }
      const identity: RecordedEventIdentity = {
        gatewayEpoch: frame.gatewayEpoch,
        ingestSeq: frame.releaseIngestSeq,
        receivedAt: frame.availableAt,
        datasetRowOrdinal: frame.releaseOrdinal,
      };
      releaseFramesDelivered += 1;
      for (const envelope of normalized.envelopes) {
        // As `runReplay`: the venue is positioned at the event before the core sees it.
        const positioned = options.venue.observe(identity);
        if (!positioned.ok) {
          stop = positioned.refusal;
          break;
        }
        envelopesDelivered += 1;
        envelopesByType.set(envelope.eventType, (envelopesByType.get(envelope.eventType) ?? 0) + 1);
        const outcome = await options.coreLoop({ envelope, record, identity, monotonicNs: BigInt(reading) });
        if (!outcome.ok) {
          stop = outcome.refusal;
          break;
        }
      }
    }
  } catch (error) {
    stop = {
      code: "APPROX_RUN_INTERNAL",
      message: `the approximate replay threw (${error instanceof Error ? error.message : String(error)}); it is stopped, not reported as complete`,
      details: {},
    };
  }
  return { releaseFramesDelivered, envelopesDelivered, envelopesByType, stop };
}

/**
 * The whole approximate backtest. A refusal means no core was driven; a run
 * that started answers `ok: true` with its outcome, which may itself be a
 * stop part-way (a halted core, an untranslatable frame), and the core.
 */
export async function runApproximateBacktest(options: ApproximateRunOptions): Promise<ApproximateRunResult> {
  // --- 1. §6 invariant 17, before anything is read ---------------------------
  const safety = checkBacktestCoreSafety(options.environment);
  if (!safety.ok) {
    return refuse(
      "BACKTEST_UNSAFE_ENVIRONMENT",
      "startup safety validation failed (§6 invariant 17, §11, §15, AGENTS.md); nothing was read and no core was built",
      safety.violations,
    );
  }

  // --- 2. the run pins: the translation is the normalizer ------------------
  const pins = readRunPins(options.runPins);
  if (!pins.ok) return refuse("APPROX_RUN_PINS_REFUSED", `${pins.refusal.code}: ${pins.refusal.message}`);
  if (pins.value.normalizerVersion !== APPROXIMATE_TRANSLATION_VERSION) {
    return refuse(
      "APPROX_RUN_PINS_REFUSED",
      `an approximate run turns research-tier samples into envelopes with ${JSON.stringify(APPROXIMATE_TRANSLATION_VERSION)}, ` +
        `and its run pins must say so; they name ${JSON.stringify(pins.value.normalizerVersion)} (§6 invariant 9)`,
    );
  }

  // --- 3. the configuration, and every market's lifecycle attribution -------
  const parsed = parseTraderConfig(options.traderConfig);
  if (!parsed.ok) return refuse("BACKTEST_CONFIG_REFUSED", parsed.refusal.detail, parsed.refusal.issues);
  const markets = approximateMarketsOf(parsed.config, options.gammaMarketIds);
  if (!markets.ok) return refuse("APPROX_RUN_LIFECYCLE_UNATTRIBUTED", markets.problem);

  // --- 4. the research tier: verified, one epoch, ordered -------------------
  const read = await readResearchTierReplaySource({
    objectStore: options.objectStore,
    manifestObjectKeys: options.manifestObjectKeys,
    digestSha256: sha256Hex,
  });
  if (!read.ok) {
    return refuse(
      read.refusal.code,
      read.refusal.detail,
      Object.keys(read.refusal.details)
        .sort()
        .map((key) => `${key}=${String(read.refusal.details[key])}`),
      read.fidelity,
    );
  }
  const source = read.source;
  const frames = source.releaseFrames;
  const first = frames[0];
  if (first === undefined) {
    return refuse("APPROX_RUN_NOTHING_TO_REPLAY", "the research tier holds no sample to replay", [], source.fidelity);
  }
  const monotonic = derivedMonotonicNs(frames);

  // --- 5. the core: the exact run's own assembly ----------------------------
  const assembled = assembleBacktestCore({
    environment: options.environment,
    traderConfig: options.traderConfig,
    runPins: pins.value,
    clockStart: { receivedAt: first.availableAt, receivedMonotonicNs: monotonic[0] ?? "0" },
    ...(options.idNamespace === undefined ? {} : { idNamespace: options.idNamespace }),
    ...(options.accountingChecks === undefined ? {} : { accountingChecks: options.accountingChecks }),
    ...(options.log === undefined ? {} : { log: labelledLog(source.fidelity, options.log) }),
  });
  if (!assembled.ok) {
    return refuse(assembled.refusal.code, assembled.refusal.detail, assembled.refusal.issues, source.fidelity);
  }
  const core = assembled.core;
  // Before the core is driven: nothing it produces renders as an exact artifact.
  markApproximateCore(core);

  // --- 6. drive it, one release frame at a time -----------------------------
  const translator = new ResearchSampleTranslator({ markets: markets.markets, digestSha256: sha256Hex });
  const delivered = await deliverReleaseFrames({
    frames,
    monotonic,
    translator,
    framing: core.framing,
    coreLoop: core.driver.coreLoop,
    venue: core.venue,
  });
  const { releaseFramesDelivered, envelopesDelivered, envelopesByType } = delivered;
  let stop = delivered.stop;

  // `FOLD-1`: the core's end-of-run accounting check, once, completed or not.
  try {
    core.driver.endOfRun();
  } catch (error) {
    stop ??= {
      code: "APPROX_RUN_INTERNAL",
      message: `the core's end-of-run accounting rebuild check threw (${error instanceof Error ? error.name : typeof error})`,
      details: {},
    };
  }

  const driver = core.driver.observations();
  if (stop !== undefined) {
    return { ok: true, run: { fidelity: source.fidelity, outcome: { ok: false, refusal: stop }, source, core, driver } };
  }

  const retention = core.venue.retention();
  if (retention.historyEvicted) {
    const refusal: SimulationRefusal = {
      code: "SIMULATED_VENUE_HISTORY_EVICTED",
      message:
        "the venue evicted part of this run's history; a serialization of what is left would report a truncated " +
        "run as complete, so the run is refused",
      details: {
        ordersEvicted: retention.orders.evicted,
        fillsEvicted: retention.fills.evicted,
        bandsEvicted: retention.bands.evicted,
      },
    };
    return { ok: true, run: { fidelity: source.fidelity, outcome: { ok: false, refusal }, source, core, driver } };
  }
  const fills = core.venue.fills;
  const economics = replayPathEconomics(fills);
  if (!economics.ok) {
    return { ok: true, run: { fidelity: source.fidelity, outcome: { ok: false, refusal: economics.refusal }, source, core, driver } };
  }

  const result: ApproximateReplayResult = {
    fidelity: source.fidelity,
    runMode: BACKTEST_RUN_MODE,
    pins: pins.value,
    source,
    translation: translator.counts(),
    lifecycles: translator.lifecycles(),
    releaseFramesDelivered,
    envelopesDelivered,
    envelopesByType,
    clock: core.clock.observations(),
    orders: core.venue.ordersSnapshot(),
    fills,
    economics: economics.value,
    bands: core.venue.bandHistory(),
  };
  return { ok: true, run: { fidelity: source.fidelity, outcome: { ok: true, result }, source, core, driver } };
}
