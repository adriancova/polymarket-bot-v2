/**
 * The research-tier replay source (`APPROX-REPLAY-1`; ADR-029 Decisions 1, 4
 * and 5).
 *
 * It turns one or more research-tier datasets of ONE gateway epoch into the
 * ordered list of release frames an approximate replay consumes. It reads the
 * research tier only through `@polymarket-bot/storage-parquet`'s published
 * surface, and it decides nothing about what a sample MEANS: that is the
 * translation's job (`translate.ts`).
 *
 * ## Only a verified dataset is read
 *
 * Each manifest is verified first by the published verifier,
 * `verifyResearchTierDataset`: the manifest must hash to its digest sidecar,
 * parse as a version 2 `approximate` manifest, and every object it pins must
 * be in the store with the pinned length and digest. A dataset that does not
 * verify is refused (`APPROX_REPLAY_DATASET_UNVERIFIED`) and nothing of it is
 * replayed. Each table object is then read ONCE more, its bytes are digested
 * here and compared with the verified pin before they are decoded, so the
 * rows replayed are the rows of the bytes that matched — never a second read
 * that could differ from the one the verifier checked.
 *
 * ## The order (ADR-029 Decision 5.3) — never by instant
 *
 * Samples are consumed in the dispatch order of their release frames: by
 * `releaseIngestSeq`, within one gateway epoch. Samples released at one frame
 * are consumed in the downsampling version's fixed tie order. The writer
 * assigned `sampleOrdinal` in exactly that order, so this source consumes the
 * samples in `sampleOrdinal` order and CHECKS that order against both rules
 * independently:
 *
 * - the release `ingestSeq` never goes backwards (compared as unsigned
 *   integers, never as instants);
 * - inside one release frame, each sample's tie key (below) is not less than
 *   the previous one's.
 *
 * A dataset that disagrees is refused (`APPROX_REPLAY_RELEASE_ORDER_VIOLATED`).
 * No comparator in this file reads `availableAt`, `spanStartMs` or a venue
 * timestamp to ORDER anything; `availableAt` is read only to check the span
 * release rule and is carried as the sample's event time.
 *
 * Only the tie order of `polymarket-bot/research-downsampling/v1` version 1 is
 * known to this build (`apps/research-worker/src/research-tier/sampler.ts`,
 * stated in every manifest's `downsampling.tieOrder`). A dataset of any other
 * downsampling version is refused (`APPROX_REPLAY_DOWNSAMPLING_UNSUPPORTED`):
 * its tie order cannot be checked.
 *
 * ## Span samples (ADR-029 Decision 5.1)
 *
 * A span sample is released at the first frame, in dispatch order, whose
 * receipt instant is at or after its boundary, and it holds only frames
 * dispatched before that release frame. The reader cannot see frames, only
 * samples. It enforces what samples can show of that rule, and refuses
 * (`APPROX_REPLAY_RELEASE_ORDER_VIOLATED`) a dataset that breaks it:
 *
 * 1. a span sample's release instant is at or after its boundary — a sample
 *    released before its span ended would summarize a span that was still
 *    open, whose later frames reach it out of dispatch order;
 * 2. one release frame closes at most ONE span of each length (1 s, 60 s), as
 *    one frame can close only the span open when it arrives;
 * 3. per span length, boundaries strictly increase with release order: a span
 *    is closed once, and never after a later one;
 * 4. a span has the version's length (`spanMs`, `fullBookSpanMs`) and starts
 *    on a multiple of it.
 *
 * So the bar that F1 (`ingestSeq` 1, 10,000 ms) released for [9,000, 10,000)
 * is replayed at F1, before anything F2 (`ingestSeq` 2, 9,999 ms) carries;
 * F2's contribution reaches the replay only in the bar of [10,000, 11,000),
 * released at a later frame. A dataset that instead binned F2 into the first
 * bar by its instant would have to release that bar at or after F2, together
 * with the next one — two 1 s boundaries at one frame — and is refused (rule
 * 2), or release it at F2 (9,999 ms, before its boundary) — and is refused
 * (rule 1).
 *
 * ## One gateway epoch (wal-format.md §12.1; ADR-029 Decision 5.4)
 *
 * `gatewayEpoch` is identity, not chronology: nothing recorded orders one
 * epoch against another. A replay given datasets of more than one epoch STOPS
 * AND ASKS (`APPROX_REPLAY_CROSS_EPOCH`) before any sample is read. Several
 * datasets of one epoch are replayed only as one unbroken chain: each after
 * the first names its predecessor as its sampler `stateIn`, with that
 * predecessor's end-state digest (the extractor's own link), and its first
 * release frame comes after its predecessor's last.
 */

import {
  RESEARCH_TABLES,
  compareUnsignedIntegerStrings,
  readResearchTableObject,
  verifyResearchTierDataset,
  type ObjectStore,
  type ResearchDownsampling,
  type ResearchRow,
  type ResearchTableName,
  type ResearchTableSpec,
  type ResearchTierManifest,
} from "@polymarket-bot/storage-parquet";
import { isoToEpochMilliseconds, type Sha256HexDigest } from "@polymarket-bot/simulation";

/** The one downsampling version whose tie order this build checks and replays. */
export const SUPPORTED_DOWNSAMPLING_ID = "polymarket-bot/research-downsampling/v1";
/** Its version. */
export const SUPPORTED_DOWNSAMPLING_VERSION = 1;
/** The v1 span lengths (`sampler.ts`, `SPAN_MS` and `FULL_BOOK_SPAN_MS`), as the manifest pins them. */
const V1_SPAN_MS = 1_000;
const V1_FULL_BOOK_SPAN_MS = 60_000;

/** Why a research-tier replay source could not be built. */
export type ResearchSourceRefusalCode =
  /** No manifest key was given, or a key twice. */
  | "APPROX_REPLAY_INPUT_INVALID"
  /** The published verifier refused the dataset; nothing of it is read. */
  | "APPROX_REPLAY_DATASET_UNVERIFIED"
  /** The datasets name more than one gateway epoch: stop and ask (wal-format.md §12.1). */
  | "APPROX_REPLAY_CROSS_EPOCH"
  /** Several datasets of one epoch do not form one unbroken chain. */
  | "APPROX_REPLAY_CHAIN_BROKEN"
  /** The downsampling version's tie order is not one this build knows. */
  | "APPROX_REPLAY_DOWNSAMPLING_UNSUPPORTED"
  /** An object read for replay is not the object the verifier checked. */
  | "APPROX_REPLAY_OBJECT_MISMATCH"
  /** The rows do not reconcile with the manifest's own numbers. */
  | "APPROX_REPLAY_ROWS_UNRECONCILED"
  /** Release order, tie order or the span release rule is broken. */
  | "APPROX_REPLAY_RELEASE_ORDER_VIOLATED";

/** A refusal: what stopped the source, and the facts that show it. */
export interface ResearchSourceRefusal {
  readonly code: ResearchSourceRefusalCode;
  readonly detail: string;
  readonly details: Readonly<Record<string, string | number>>;
}

/** One verified research-tier dataset of the replay, in chain order. */
export interface VerifiedResearchDataset {
  readonly manifestObjectKey: string;
  /** SHA-256 of the manifest bytes, equal to its digest sidecar. */
  readonly manifestSha256: string;
  readonly manifest: ResearchTierManifest;
}

/** One research-tier sample, as the replay consumes it. */
export interface ResearchSample {
  readonly table: ResearchTableName;
  readonly datasetId: string;
  readonly sampleOrdinal: number;
  readonly row: ResearchRow;
}

/**
 * Every sample released at one recorded frame, in the version's tie order.
 * The frame's identity is the sample's release identity (ADR-029 Decision 5.2).
 */
export interface ReleaseFrame {
  /** Dense position of this release frame in the replay, from 0. */
  readonly releaseOrdinal: number;
  readonly gatewayEpoch: string;
  readonly releaseIngestSeq: string;
  /** The release frame's receipt instant: the samples' event time. Never an ordering key. */
  readonly availableAt: string;
  readonly availableAtEpochMs: number;
  readonly releaseSegmentId: string;
  readonly samples: readonly ResearchSample[];
}

/** What the source established. */
export interface ResearchTierReplaySource {
  /** From the manifests (all `approximate`; ADR-029 Decision 4.2). */
  readonly fidelity: ResearchTierManifest["fidelity"];
  /** Every distinct admissibility statement the manifests carry, as they carry it. */
  readonly admissibility: readonly string[];
  readonly gatewayEpoch: string;
  readonly downsampling: ResearchDownsampling;
  readonly datasets: readonly VerifiedResearchDataset[];
  /** `fresh` when the first dataset starts its epoch or a stated discontinuity; else `continued`. */
  readonly chainStart: "fresh" | "continued";
  readonly samplesRead: number;
  readonly releaseFrames: readonly ReleaseFrame[];
}

export type ResearchSourceResult =
  | { readonly ok: true; readonly source: ResearchTierReplaySource }
  | { readonly ok: false; readonly refusal: ResearchSourceRefusal; readonly fidelity?: "approximate" };

/** Inputs to {@link readResearchTierReplaySource}. */
export interface ResearchSourceOptions {
  /**
   * Where the research tier lives. Only `head` and `get` are called: the
   * source never writes to a research tier.
   */
  readonly objectStore: Pick<ObjectStore, "head" | "get">;
  /** The datasets' manifest keys, in chain order. */
  readonly manifestObjectKeys: readonly string[];
  readonly digestSha256: Sha256HexDigest;
}

function refused(
  code: ResearchSourceRefusalCode,
  detail: string,
  details: Readonly<Record<string, string | number>> = {},
  fidelity?: "approximate",
): ResearchSourceResult {
  return { ok: false, refusal: { code, detail, details }, ...(fidelity === undefined ? {} : { fidelity }) };
}

/** A store that can only be read: `verifyResearchTierDataset` takes the full port. */
function readOnly(store: Pick<ObjectStore, "head" | "get">): ObjectStore {
  return {
    async put(key: string): Promise<void> {
      await Promise.resolve();
      throw new Error(`the approximate replay never writes to a research tier (refused a put of ${key})`);
    },
    head: async (key) => await store.head(key),
    get: async (key) => await store.get(key),
  };
}

const KIND_RANK: Readonly<Record<string, number>> = {
  pm_top_of_book: 0,
  pm_depth: 1,
  pm_full_book: 2,
  ref_trade_bars: 3,
};

const SPAN_TABLES = new Set<string>(["pm_top_of_book", "pm_depth", "pm_full_book", "ref_trade_bars"]);

/** `feed_events` inside one frame: the connection note, then uninterpretable, then excluded trades (sampler v1). */
const FEED_EVENT_RANK: Readonly<Record<string, number>> = {
  "connection-observed": 0,
  "connection-changed": 0,
  uninterpretable: 1,
  "snapshot-trades-excluded": 2,
};

/** Whether a table's samples summarize a span (ADR-029 Decision 5.1). */
export function isSpanTable(table: string): boolean {
  return SPAN_TABLES.has(table);
}

function text(row: ResearchRow, column: string): string {
  const value = row[column];
  return typeof value === "string" ? value : "";
}

function integer(row: ResearchRow, column: string): number {
  const value = row[column];
  return typeof value === "number" ? value : Number.NaN;
}

/**
 * The v1 tie key of one sample inside its release frame (`sampler.ts`, "The
 * fixed tie order"), as a tuple compared element by element:
 *
 * - span samples first: by boundary, then kind (`pm_top_of_book`, `pm_depth`,
 *   `pm_full_book`, `ref_trade_bars`), then token id or `source|instrument`
 *   as a string;
 * - then the frame's own on-change samples: its `feed_events` (connection
 *   note, uninterpretable, excluded trades), then its trades, lifecycle events
 *   and ticks by their position in the frame.
 *
 * Exported for the tests that pin it.
 */
export function v1TieKey(table: ResearchTableName, row: ResearchRow): readonly (number | string)[] {
  if (isSpanTable(table)) {
    const subject = table === "ref_trade_bars" ? `${text(row, "source")}|${text(row, "instrument")}` : text(row, "tokenId");
    return [0, integer(row, "spanEndMs"), KIND_RANK[table] ?? 9, subject];
  }
  if (table === "feed_events") {
    return [1, 0, FEED_EVENT_RANK[text(row, "eventKind")] ?? 9, ""];
  }
  return [1, 1, integer(row, "entryIndex"), ""];
}

function compareTieKeys(left: readonly (number | string)[], right: readonly (number | string)[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === b) continue;
    if (typeof a === "number" && typeof b === "number") return a < b ? -1 : 1;
    // Strings compare by UTF-16 code unit, as the sampler's own sort does.
    return String(a) < String(b) ? -1 : 1;
  }
  return 0;
}

function sameColumns(manifest: ResearchTierManifest, spec: ResearchTableSpec): boolean {
  const pinned = manifest.tables.find((entry) => entry.table === spec.name);
  if (pinned === undefined || pinned.sampleClass !== spec.sampleClass) return false;
  if (pinned.columns.length !== spec.columns.length) return false;
  return pinned.columns.every((column, index) => {
    const expected = spec.columns[index];
    return (
      expected !== undefined &&
      column.name === expected.name &&
      column.physicalType === expected.physicalType &&
      column.nullable === expected.nullable
    );
  });
}

interface DatasetRows {
  readonly dataset: VerifiedResearchDataset;
  /** Every sample, indexed by its dense ordinal. */
  readonly byOrdinal: readonly ResearchSample[];
}

async function readDatasetRows(
  store: Pick<ObjectStore, "get">,
  dataset: VerifiedResearchDataset,
  digest: Sha256HexDigest,
  epoch: string,
): Promise<{ readonly ok: true; readonly rows: DatasetRows } | { readonly ok: false; readonly result: ResearchSourceResult }> {
  const manifest = dataset.manifest;
  const datasetId = manifest.datasetId;
  const fail = (code: ResearchSourceRefusalCode, detail: string, details: Readonly<Record<string, string | number>>) => ({
    ok: false as const,
    result: refused(code, detail, { datasetId, ...details }, "approximate"),
  });
  const total = manifest.recordCounts.samplesWritten;
  const byOrdinal: (ResearchSample | undefined)[] = new Array<ResearchSample | undefined>(total).fill(undefined);
  const segments = new Map(manifest.sourceSegments.map((segment) => [segment.segmentId, segment]));
  let rowsRead = 0;

  for (const object of manifest.objects) {
    const spec = RESEARCH_TABLES.find((table) => table.name === object.table);
    if (spec === undefined || !sameColumns(manifest, spec)) {
      return fail(
        "APPROX_REPLAY_ROWS_UNRECONCILED",
        "the manifest pins a table, or a column list, that this build's research-tier layout does not define",
        { table: object.table },
      );
    }
    let bytes: Uint8Array;
    try {
      bytes = await store.get(object.objectKey);
    } catch (error) {
      return fail("APPROX_REPLAY_OBJECT_MISMATCH", "a verified research-tier object could no longer be read", {
        objectKey: object.objectKey,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    const observed = digest(bytes);
    if (bytes.byteLength !== object.byteLength || observed !== object.sha256) {
      return fail(
        "APPROX_REPLAY_OBJECT_MISMATCH",
        "the bytes read for replay are not the bytes the verifier checked against the manifest's pin; " +
          "nothing read from them is replayed",
        { objectKey: object.objectKey, pinnedSha256: object.sha256, observedSha256: observed },
      );
    }
    let rows: readonly ResearchRow[];
    try {
      rows = await readResearchTableObject(spec, bytes);
    } catch (error) {
      return fail("APPROX_REPLAY_ROWS_UNRECONCILED", "a research-tier object does not decode as its pinned table", {
        objectKey: object.objectKey,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    if (rows.length !== object.rowCount) {
      return fail("APPROX_REPLAY_ROWS_UNRECONCILED", "an object's row count differs from the manifest's", {
        objectKey: object.objectKey,
        pinned: object.rowCount,
        observed: rows.length,
      });
    }
    for (const row of rows) {
      const ordinal = row["sampleOrdinal"];
      if (typeof ordinal !== "number" || !Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= total) {
        return fail("APPROX_REPLAY_ROWS_UNRECONCILED", "a sample's ordinal is outside the manifest's sample count", {
          table: spec.name,
          sampleOrdinal: String(ordinal),
          samplesWritten: total,
        });
      }
      if (
        (object.firstSampleOrdinal !== null && ordinal < object.firstSampleOrdinal) ||
        (object.lastSampleOrdinal !== null && ordinal > object.lastSampleOrdinal)
      ) {
        return fail("APPROX_REPLAY_ROWS_UNRECONCILED", "a sample's ordinal is outside its object's pinned range", {
          table: spec.name,
          sampleOrdinal: ordinal,
        });
      }
      if (byOrdinal[ordinal] !== undefined) {
        return fail("APPROX_REPLAY_ROWS_UNRECONCILED", "two samples carry one ordinal", { sampleOrdinal: ordinal });
      }
      if (row["gatewayEpoch"] !== epoch) {
        return fail(
          "APPROX_REPLAY_ROWS_UNRECONCILED",
          "a sample names a gateway epoch other than its dataset's; a replay covers one epoch",
          { sampleOrdinal: ordinal, sampleEpoch: text(row, "gatewayEpoch"), datasetEpoch: epoch },
        );
      }
      const segmentId = text(row, "releaseSegmentId");
      const segment = segments.get(segmentId);
      const seq = text(row, "releaseIngestSeq");
      if (
        segment === undefined ||
        segment.firstIngestSeq === null ||
        segment.lastIngestSeq === null ||
        compareUnsignedIntegerStrings(seq, segment.firstIngestSeq) < 0 ||
        compareUnsignedIntegerStrings(seq, segment.lastIngestSeq) > 0
      ) {
        return fail(
          "APPROX_REPLAY_ROWS_UNRECONCILED",
          "a sample's release frame is not inside the source segment it names, as the manifest lists it",
          { sampleOrdinal: ordinal, releaseSegmentId: segmentId, releaseIngestSeq: seq },
        );
      }
      byOrdinal[ordinal] = { table: spec.name, datasetId, sampleOrdinal: ordinal, row };
      rowsRead += 1;
    }
  }
  if (rowsRead !== total || byOrdinal.some((sample) => sample === undefined)) {
    return fail(
      "APPROX_REPLAY_ROWS_UNRECONCILED",
      "the samples read do not reconcile with the manifest's samplesWritten: an ordinal is missing, so the " +
        "replay would have a hole in it (§8.3)",
      { samplesWritten: total, samplesRead: rowsRead },
    );
  }
  return { ok: true, rows: { dataset, byOrdinal: byOrdinal as ResearchSample[] } };
}

/** A release frame being assembled from consecutive samples. */
interface OpenFrame {
  readonly seq: string;
  readonly at: string;
  readonly atMs: number;
  readonly segment: string;
  readonly samples: ResearchSample[];
  /** The previous sample's tie key in this frame. */
  previousKey: readonly (number | string)[] | null;
  /** Span boundary per span length, released at this frame. */
  readonly boundaries: Map<number, number>;
}

/**
 * Groups the samples, in ordinal order, into release frames, CHECKING the
 * order (module header): the release `ingestSeq` never goes backwards; inside
 * a frame the v1 tie key never decreases and every sample shares the frame's
 * instant and segment; and the span release rules 1-4 hold. Nothing here
 * reorders anything: the ordinals ARE the order, and any disagreement refuses.
 */
function orderReleaseFrames(
  all: readonly DatasetRows[],
  epoch: string,
): { readonly ok: true; readonly frames: readonly ReleaseFrame[] } | { readonly ok: false; readonly result: ResearchSourceResult } {
  const frames: ReleaseFrame[] = [];
  const lastBoundary = new Map<number, { readonly boundary: number; readonly seq: string }>();
  let open: OpenFrame | null = null;
  const violated = (detail: string, sample: ResearchSample, extra: Readonly<Record<string, string | number>> = {}) => ({
    ok: false as const,
    result: refused(
      "APPROX_REPLAY_RELEASE_ORDER_VIOLATED",
      detail,
      {
        datasetId: sample.datasetId,
        sampleOrdinal: sample.sampleOrdinal,
        table: sample.table,
        releaseIngestSeq: text(sample.row, "releaseIngestSeq"),
        ...extra,
      },
      "approximate",
    ),
  });
  const close = (frame: OpenFrame): void => {
    frames.push({
      releaseOrdinal: frames.length,
      gatewayEpoch: epoch,
      releaseIngestSeq: frame.seq,
      availableAt: frame.at,
      availableAtEpochMs: frame.atMs,
      releaseSegmentId: frame.segment,
      samples: frame.samples,
    });
  };

  for (const rows of all) {
    for (const sample of rows.byOrdinal) {
      const row = sample.row;
      const seq = text(row, "releaseIngestSeq");
      const at = text(row, "availableAt");
      const atMs = isoToEpochMilliseconds(at);
      if (atMs === undefined) return violated("a sample's availableAt is not an ISO-8601 instant", sample);

      if (open === null || compareUnsignedIntegerStrings(seq, open.seq) !== 0) {
        if (open !== null && compareUnsignedIntegerStrings(seq, open.seq) < 0) {
          return violated(
            "samples would replay out of the dispatch order of their release frames: a release ingestSeq goes " +
              "backwards in sample order (ADR-029 Decision 5.3)",
            sample,
            { previousReleaseIngestSeq: open.seq },
          );
        }
        if (open !== null) close(open);
        open = { seq, at, atMs, segment: text(row, "releaseSegmentId"), samples: [], previousKey: null, boundaries: new Map() };
      } else if (at !== open.at || text(row, "releaseSegmentId") !== open.segment) {
        return violated("samples released at one frame disagree on that frame's receipt instant or segment", sample, {
          availableAt: at,
          frameAvailableAt: open.at,
        });
      }

      const key = v1TieKey(sample.table, row);
      if (open.previousKey !== null && compareTieKeys(open.previousKey, key) > 0) {
        return violated(
          "samples released at one frame are not in the downsampling version's fixed tie order (ADR-029 Decision 5.3)",
          sample,
        );
      }
      open.previousKey = key;

      if (isSpanTable(sample.table)) {
        const length = sample.table === "pm_full_book" ? V1_FULL_BOOK_SPAN_MS : V1_SPAN_MS;
        const start = integer(row, "spanStartMs");
        const end = integer(row, "spanEndMs");
        // Rule 4: one aligned span of the version's length.
        if (!Number.isSafeInteger(start) || end - start !== length || start % length !== 0) {
          return violated("a span sample does not cover one aligned span of its version's length", sample, {
            spanStartMs: String(start),
            spanEndMs: String(end),
          });
        }
        // Rule 1: the release frame is at or after the span's boundary.
        if (atMs < end) {
          return violated(
            "a span sample is released before its span's boundary: its release frame cannot have closed the " +
              "span, so frames dispatched after it could belong to it (ADR-029 Decision 5.1)",
            sample,
            { spanEndMs: end, availableAt: at },
          );
        }
        // Rule 2: one boundary per span length per release frame.
        const atThisFrame = open.boundaries.get(length);
        if (atThisFrame !== undefined && atThisFrame !== end) {
          return violated(
            "one release frame closes two spans of one length; a frame closes only the span open when it " +
              "arrives (ADR-029 Decision 5.1)",
            sample,
            { spanEndMs: end, otherSpanEndMs: atThisFrame },
          );
        }
        open.boundaries.set(length, end);
        // Rule 3: per span length, boundaries strictly increase with release order.
        const before = lastBoundary.get(length);
        if (before !== undefined && before.seq !== seq && end <= before.boundary) {
          return violated(
            "a span is released after a later or equal span of the same length was already released (ADR-029 " +
              "Decision 5.1)",
            sample,
            { spanEndMs: end, previousSpanEndMs: before.boundary },
          );
        }
        lastBoundary.set(length, { boundary: end, seq });
      }
      open.samples.push(sample);
    }
  }
  if (open !== null) close(open);
  return { ok: true, frames };
}

function sameIdentity(
  pinned: ResearchTierManifest["releaseRange"]["first"],
  sample: ResearchSample | undefined,
): boolean {
  if (pinned === null || sample === undefined) return pinned === null && sample === undefined;
  return (
    pinned.ingestSeq === text(sample.row, "releaseIngestSeq") &&
    pinned.availableAt === text(sample.row, "availableAt") &&
    pinned.sampleOrdinal === sample.sampleOrdinal
  );
}

/**
 * Reads, verifies and orders a research-tier replay. TOTAL for every input it
 * can be given: a failure is a refusal, never an exception.
 */
export async function readResearchTierReplaySource(options: ResearchSourceOptions): Promise<ResearchSourceResult> {
  const keys = options.manifestObjectKeys;
  if (keys.length === 0) {
    return refused("APPROX_REPLAY_INPUT_INVALID", "an approximate replay names at least one research-tier manifest");
  }
  if (new Set(keys).size !== keys.length) {
    return refused("APPROX_REPLAY_INPUT_INVALID", "a research-tier manifest is named twice", {});
  }

  // --- 1. the published verifier, for every dataset, before anything else ----
  const store = readOnly(options.objectStore);
  const datasets: VerifiedResearchDataset[] = [];
  for (const key of keys) {
    try {
      const verified = await verifyResearchTierDataset(store, key);
      datasets.push({
        manifestObjectKey: verified.manifestObjectKey,
        manifestSha256: verified.manifestSha256,
        manifest: verified.manifest,
      });
    } catch (error) {
      return refused(
        "APPROX_REPLAY_DATASET_UNVERIFIED",
        "the research-tier dataset did not verify (storage-parquet verifyResearchTierDataset); an unverified " +
          "dataset is never replayed",
        { manifestObjectKey: key, cause: error instanceof Error ? error.message : String(error) },
      );
    }
  }

  // --- 2. one gateway epoch: otherwise stop and ask --------------------------
  const epochs = [...new Set(datasets.flatMap((dataset) => dataset.manifest.gatewayEpochs))];
  const epoch = epochs[0];
  if (epochs.length !== 1 || epoch === undefined) {
    return refused(
      "APPROX_REPLAY_CROSS_EPOCH",
      `the datasets name ${String(epochs.length)} gateway epochs (${epochs.join(", ")}). wal-format.md §12.1 ` +
        "defines no order across gateway epochs: an epoch is identity, not chronology. ADR-029 Decision 5.4: " +
        "an approximate replay covers one epoch, and a replay across epochs needs new recorded evidence and " +
        "an ADR-004 amendment (§12.1 rule 5) first. Nothing was replayed",
      { gatewayEpochs: epochs.join(","), datasets: datasets.length },
      "approximate",
    );
  }

  // --- 3. the downsampling version this build can order -----------------------
  for (const dataset of datasets) {
    const downsampling = dataset.manifest.downsampling;
    const parameters = downsampling.parameters;
    if (
      downsampling.downsamplingId !== SUPPORTED_DOWNSAMPLING_ID ||
      downsampling.downsamplingVersion !== SUPPORTED_DOWNSAMPLING_VERSION ||
      parameters["spanMs"] !== V1_SPAN_MS ||
      parameters["fullBookSpanMs"] !== V1_FULL_BOOK_SPAN_MS
    ) {
      return refused(
        "APPROX_REPLAY_DOWNSAMPLING_UNSUPPORTED",
        `the dataset was downsampled by ${downsampling.downsamplingId} version ${String(downsampling.downsamplingVersion)}; ` +
          `this build knows the fixed tie order of ${SUPPORTED_DOWNSAMPLING_ID} version ` +
          `${String(SUPPORTED_DOWNSAMPLING_VERSION)} with 1 s and 60 s spans only, and does not replay a dataset ` +
          "whose order it cannot check (ADR-029 Decision 5.3)",
        { datasetId: dataset.manifest.datasetId },
        "approximate",
      );
    }
  }

  // --- 4. several datasets of one epoch: one unbroken chain -----------------
  for (let index = 1; index < datasets.length; index += 1) {
    const previous = datasets[index - 1] as VerifiedResearchDataset;
    const current = datasets[index] as VerifiedResearchDataset;
    const link = current.manifest.samplerState.stateIn;
    const end = previous.manifest.samplerState.stateOut;
    if (
      link === null ||
      link.datasetId !== previous.manifest.datasetId ||
      link.objectKey !== end.objectKey ||
      link.sha256 !== end.sha256 ||
      link.byteLength !== end.byteLength
    ) {
      return refused(
        "APPROX_REPLAY_CHAIN_BROKEN",
        "the datasets do not form one unbroken chain: each dataset after the first must name the one before it " +
          "as its sampler stateIn, with that dataset's end-state digest. A replay across a gap would join spans " +
          "across frames no dataset holds (§8.3)",
        {
          datasetId: current.manifest.datasetId,
          expectedPredecessor: previous.manifest.datasetId,
          namedPredecessor: link === null ? "none (a fresh start)" : link.datasetId,
        },
        "approximate",
      );
    }
  }

  // --- 5. every dataset's rows, reconciled with its own manifest -------------
  const all: DatasetRows[] = [];
  for (const dataset of datasets) {
    const read = await readDatasetRows(options.objectStore, dataset, options.digestSha256, epoch);
    if (!read.ok) return read.result;
    const rows = read.rows;
    const range = dataset.manifest.releaseRange;
    if (!sameIdentity(range.first, rows.byOrdinal[0]) || !sameIdentity(range.last, rows.byOrdinal[rows.byOrdinal.length - 1])) {
      return refused(
        "APPROX_REPLAY_ROWS_UNRECONCILED",
        "the first or last sample does not match the manifest's releaseRange",
        { datasetId: dataset.manifest.datasetId },
        "approximate",
      );
    }
    all.push(rows);
  }

  // --- 6. the order: release order, the v1 tie order, the span release rule --
  const ordered = orderReleaseFrames(all, epoch);
  if (!ordered.ok) return ordered.result;
  const frames = ordered.frames;

  const admissibility = [...new Set(datasets.map((dataset) => dataset.manifest.admissibility))];
  const first = datasets[0] as VerifiedResearchDataset;
  return {
    ok: true,
    source: {
      fidelity: first.manifest.fidelity,
      admissibility,
      gatewayEpoch: epoch,
      downsampling: first.manifest.downsampling,
      datasets,
      chainStart: first.manifest.samplerState.stateIn === null ? "fresh" : "continued",
      samplesRead: all.reduce((sum, rows) => sum + rows.byOrdinal.length, 0),
      releaseFrames: frames,
    },
  };
}
