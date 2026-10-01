/**
 * The research-tier extractor: sealed WAL segments in, verified research-tier
 * datasets out (`STORAGE-1`; ADR-028 Decisions 1.3, 2.2 and 2.6; ADR-029).
 *
 * For each gateway epoch, in segment order, it takes the sealed segments that
 * have no research tier yet and:
 *
 * 1. verifies each one before reading it — `validateSegment` and the
 *    compactor's reader over one in-memory read (`segment-verify.ts`). A
 *    segment that fails is **not extracted**, so it can never expire;
 * 2. feeds the verified frames, in dispatch order, through the venue doors
 *    (`interpret.ts`) and the downsampler (`sampler.ts`);
 * 3. writes one research-tier dataset per run of consecutive verified
 *    segments, reading every byte back (`writeResearchTierDataset`). Its
 *    manifest lists each source segment with both digests, computed from the
 *    verified bytes;
 * 4. only then writes one small **pointer** per segment, naming the verified
 *    dataset. The pointer is an index for the planner, never proof: the
 *    planner and the deletion guard re-verify the dataset itself, and every
 *    fact the expiry decision relies on — the digests, the receipt span and
 *    the markets the segment names — is read from the verified manifest, not
 *    from the pointer.
 *
 * Each segment's market inventory (`identity.ts`) is taken from every frame,
 * independently of what the downsampler keeps, and bound into the manifest's
 * source-segment entry (`marketIdentities`).
 *
 * A span still open at the end of a dataset travels in its sampler end state
 * to the next dataset of the epoch. A refused segment, or a gap in segment
 * ordinals, breaks the chain: the next dataset starts fresh and says so
 * (`samplerState.stateIn: null`), rather than joining spans across frames it
 * never read.
 *
 * Nothing here deletes anything. It writes only to the object store.
 */

import type {
  CompactionClock,
  CompactionFileSystem,
  ObjectStore,
  ResearchMarketIdentities,
  ResearchSourceSegment,
  ResearchStateObject,
} from "@polymarket-bot/storage-parquet";
import {
  DATASET_MANIFEST_OBJECT_NAME,
  ObjectVerificationError,
  RESEARCH_SOURCE_VERIFICATION,
  parseStrictJsonBytes,
  sha256Hex,
  verifyResearchTierDataset,
  writeResearchTierDataset,
} from "@polymarket-bot/storage-parquet";

import { MarketIdentityInventory } from "./identity.js";
import { FrameInterpreter } from "./interpret.js";
import type { InventoriedSegment } from "./inventory.js";
import {
  RESEARCH_DOWNSAMPLING,
  ResearchSampler,
  decodeSamplerState,
  encodeSamplerState,
} from "./sampler.js";
import type { SamplerState } from "./sampler.js";
import { verifySegmentForExtraction } from "./segment-verify.js";
import type { RefusedSegment, VerifiedSegment } from "./segment-verify.js";

/** The object-key root of the research tier. */
export const RESEARCH_KEY_PREFIX = "research";

/** The version of {@link ResearchPointer}. */
export const RESEARCH_POINTER_VERSION = 1;

/**
 * One segment's index entry: which verified research-tier dataset holds it.
 *
 * An INDEX, never proof. It carries no market names: the expiry decision reads
 * those from the verified manifest's `marketIdentities`, so rewriting a
 * pointer cannot remove a market from the decision.
 */
export type ResearchPointer = {
  readonly pointerVersion: number;
  readonly segmentId: string;
  readonly gatewayEpoch: string;
  readonly segmentIndex: number;
  readonly segmentSha256: string;
  readonly segmentFileSha256: string;
  readonly byteSize: number;
  readonly recordCount: number;
  readonly minReceivedAt: string | null;
  readonly maxReceivedAt: string | null;
  /** Smallest and largest `ingestSeq` over the segment's frames. */
  readonly minIngestSeq: string | null;
  readonly maxIngestSeq: string | null;
  readonly datasetId: string;
  readonly manifestObjectKey: string;
  readonly manifestSha256: string;
};

const POINTER_KEYS: readonly (keyof ResearchPointer)[] = [
  "pointerVersion",
  "segmentId",
  "gatewayEpoch",
  "segmentIndex",
  "segmentSha256",
  "segmentFileSha256",
  "byteSize",
  "recordCount",
  "minReceivedAt",
  "maxReceivedAt",
  "minIngestSeq",
  "maxIngestSeq",
  "datasetId",
  "manifestObjectKey",
  "manifestSha256",
];

const POINTER_SHA256 = /^[0-9a-f]{64}$/u;
const POINTER_UINT = /^(0|[1-9][0-9]*)$/u;
const POINTER_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/u;

/** Parse a pointer document field by field (strict JSON; every field typed; no other key). */
export function parseResearchPointer(bytes: Uint8Array, key: string): ResearchPointer {
  const fail = (what: string): never => {
    throw new Error(`research pointer ${key} is not one this build reads: ${what}`);
  };
  let value: unknown;
  try {
    value = parseStrictJsonBytes(bytes);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fail("not a JSON object");
  const source = value as Record<string, unknown>;
  for (const name of Object.keys(source)) {
    if (!(POINTER_KEYS as readonly string[]).includes(name)) fail(`an unknown field ${name}`);
  }
  const text = (name: string, pattern?: RegExp): string => {
    const field = source[name];
    if (typeof field !== "string" || field.length === 0 || (pattern !== undefined && !pattern.test(field))) {
      return fail(`${name} is malformed`);
    }
    return field;
  };
  const nullableText = (name: string, pattern: RegExp): string | null => (source[name] === null ? null : text(name, pattern));
  const count = (name: string): number => {
    const field = source[name];
    if (typeof field !== "number" || !Number.isSafeInteger(field) || field < 0) return fail(`${name} is malformed`);
    return field;
  };
  return {
    pointerVersion: count("pointerVersion"),
    segmentId: text("segmentId"),
    gatewayEpoch: text("gatewayEpoch"),
    segmentIndex: count("segmentIndex"),
    segmentSha256: text("segmentSha256", POINTER_SHA256),
    segmentFileSha256: text("segmentFileSha256", POINTER_SHA256),
    byteSize: count("byteSize"),
    recordCount: count("recordCount"),
    minReceivedAt: nullableText("minReceivedAt", POINTER_ISO),
    maxReceivedAt: nullableText("maxReceivedAt", POINTER_ISO),
    minIngestSeq: nullableText("minIngestSeq", POINTER_UINT),
    maxIngestSeq: nullableText("maxIngestSeq", POINTER_UINT),
    datasetId: text("datasetId"),
    manifestObjectKey: text("manifestObjectKey"),
    manifestSha256: text("manifestSha256", POINTER_SHA256),
  };
}

/** The key of a segment's research pointer. */
export function researchPointerKey(gatewayEpoch: string, segmentId: string): string {
  return `${RESEARCH_KEY_PREFIX}/${gatewayEpoch}/segments/${segmentId}.json`;
}

function encodePointer(pointer: ResearchPointer): Uint8Array {
  return Buffer.from(`${JSON.stringify(pointer, null, 2)}\n`, "utf8");
}

/** Read a segment's research pointer, or `null` when it has none. */
export async function readResearchPointer(
  objectStore: ObjectStore,
  gatewayEpoch: string,
  segmentId: string,
): Promise<ResearchPointer | null> {
  const key = researchPointerKey(gatewayEpoch, segmentId);
  if ((await objectStore.head(key)) === null) return null;
  const value = parseResearchPointer(await objectStore.get(key), key);
  if (value.pointerVersion !== RESEARCH_POINTER_VERSION || value.segmentId !== segmentId || value.gatewayEpoch !== gatewayEpoch) {
    throw new Error(`research pointer ${key} is not one this build reads`);
  }
  return value;
}

const UNREADABLE = Symbol("unreadable research pointer");

async function pointerOrUnreadable(
  objectStore: ObjectStore,
  gatewayEpoch: string,
  segmentId: string,
): Promise<ResearchPointer | null | typeof UNREADABLE> {
  try {
    return await readResearchPointer(objectStore, gatewayEpoch, segmentId);
  } catch {
    return UNREADABLE;
  }
}

/** What one extraction run did. */
export type ExtractionResult = {
  readonly datasets: readonly {
    readonly datasetId: string;
    readonly manifestObjectKey: string;
    readonly manifestSha256: string;
    readonly segmentIds: readonly string[];
    readonly samples: number;
    readonly objectBytes: number;
    readonly freshStart: boolean;
  }[];
  readonly refused: readonly RefusedSegment[];
  readonly segmentsExtracted: number;
  readonly framesRead: number;
  readonly uninterpretedByCategory: ReadonlyMap<string, number>;
};

export type ExtractionOptions = {
  readonly fileSystem: CompactionFileSystem;
  readonly objectStore: ObjectStore;
  readonly clock: CompactionClock;
  /** Every sealed segment of every epoch, in segment order per epoch. */
  readonly byEpoch: ReadonlyMap<string, readonly InventoriedSegment[]>;
  /** Close a dataset after this many segments (it chains to the next). Default 64. */
  readonly maxSegmentsPerDataset?: number;
  readonly maxSegmentBytes?: number;
  /**
   * Batching. An epoch's pending segments are extracted together once the
   * oldest of them closed at least this long ago (or once a full dataset's
   * worth is pending, or once a later epoch exists). Every research-tier
   * dataset carries a manifest and a sampler state, so one dataset per sealed
   * segment would cost more than the samples themselves. Default 0: extract
   * at once. Bounded far below the 72 h retention by the caller.
   */
  readonly batchDelayMs?: number;
};

type Batch = {
  readonly gatewayEpoch: string;
  readonly sampler: ResearchSampler;
  readonly interpreter: FrameInterpreter;
  readonly stateIn: (ResearchStateObject & { readonly datasetId: string }) | null;
  readonly segments: VerifiedSegment[];
  /** Each segment's market inventory, taken from every frame (`identity.ts`). */
  readonly identities: Map<string, ResearchMarketIdentities>;
  framesRead: number;
  segmentDeclared: number;
};

function datasetIdFor(gatewayEpoch: string, segments: readonly VerifiedSegment[]): string {
  const first = segments[0]?.manifest.segmentIndex ?? 0;
  const last = segments[segments.length - 1]?.manifest.segmentIndex ?? first;
  return `research-${gatewayEpoch}-${String(first).padStart(6, "0")}-${String(last).padStart(6, "0")}`;
}

async function loadState(
  objectStore: ObjectStore,
  pointer: ResearchPointer,
): Promise<{ state: SamplerState; link: ResearchStateObject & { datasetId: string } } | null> {
  const verified = await verifyResearchTierDataset(objectStore, pointer.manifestObjectKey);
  const lastSource = verified.manifest.sourceSegments[verified.manifest.sourceSegments.length - 1];
  // The end state describes the end of the dataset: it continues only from its last segment.
  if (lastSource === undefined || lastSource.segmentId !== pointer.segmentId) return null;
  const stateOut = verified.manifest.samplerState.stateOut;
  const bytes = await objectStore.get(stateOut.objectKey);
  if (sha256Hex(bytes) !== stateOut.sha256) {
    throw new ObjectVerificationError("a sampler end state does not match its pin", { objectKey: stateOut.objectKey });
  }
  return {
    state: decodeSamplerState(bytes),
    link: { datasetId: verified.manifest.datasetId, ...stateOut },
  };
}

/**
 * Extract every sealed, unextracted segment into the research tier. Never
 * throws for a bad segment (it is refused and reported); throws for a failure
 * of the run itself (an object store that does not keep what it was given).
 */
export async function extractResearchTier(options: ExtractionOptions): Promise<ExtractionResult> {
  const maxSegmentsPerDataset = options.maxSegmentsPerDataset ?? 64;
  const datasets: ExtractionResult["datasets"][number][] = [];
  const refused: RefusedSegment[] = [];
  const uninterpreted = new Map<string, number>();
  let segmentsExtracted = 0;
  let framesRead = 0;

  const batchDelayMs = options.batchDelayMs ?? 0;
  const nowMs = options.clock.nowMs();
  const epochs = [...options.byEpoch.keys()];
  for (const [gatewayEpoch, segments] of options.byEpoch) {
    if (batchDelayMs > 0) {
      const pendingClosedAt: number[] = [];
      for (const segment of segments) {
        if ((await pointerOrUnreadable(options.objectStore, gatewayEpoch, segment.segmentId)) === null) {
          pendingClosedAt.push(Date.parse(segment.closedAt));
        }
      }
      // Batching only saves cost. With more than one epoch on disk the WAL
      // defines no order to tell which is current (wal-format.md §12.1), so
      // every epoch is extracted promptly rather than guessed about.
      const ended = epochs.length > 1;
      const due =
        pendingClosedAt.length >= maxSegmentsPerDataset ||
        ended ||
        (pendingClosedAt.length > 0 && Math.min(...pendingClosedAt) <= nowMs - batchDelayMs);
      if (!due) continue;
    }
    let batch: Batch | null = null;
    let previous: { segmentIndex: number; pointer: ResearchPointer | null; chainable: boolean } | null = null;

    const closeBatch = async (): Promise<void> => {
      if (batch === null || batch.segments.length === 0) {
        batch = null;
        return;
      }
      const closing: Batch = batch;
      batch = null;
      const written = await writeBatch(options, closing);
      datasets.push(written);
      segmentsExtracted += closing.segments.length;
      framesRead += closing.framesRead;
      for (const [category, count] of closing.sampler.counts.uninterpretedByCategory) {
        uninterpreted.set(category, (uninterpreted.get(category) ?? 0) + count);
      }
      // The next batch of this epoch chains from this one's end state.
      const lastSegment = closing.segments[closing.segments.length - 1];
      if (lastSegment !== undefined) {
        previous = {
          segmentIndex: lastSegment.manifest.segmentIndex,
          pointer: await readResearchPointer(options.objectStore, gatewayEpoch, lastSegment.segmentId),
          chainable: true,
        };
      }
    };

    for (const segment of segments) {
      const existing = await pointerOrUnreadable(options.objectStore, gatewayEpoch, segment.segmentId);
      if (existing === UNREADABLE) {
        // A pointer that does not read is never written over (objects are
        // immutable) and never trusted: the segment is refused, so it never
        // expires, and the chain restarts after it. The other segments go on.
        await closeBatch();
        refused.push({
          status: "refused",
          segmentId: segment.segmentId,
          walDirectoryPath: segment.walDirectoryPath,
          reasons: ["RESEARCH_POINTER_UNREADABLE: its research pointer exists and does not read"],
        });
        previous = { segmentIndex: segment.segmentIndex, pointer: null, chainable: false };
        continue;
      }
      if (existing !== null) {
        await closeBatch();
        previous = { segmentIndex: segment.segmentIndex, pointer: existing, chainable: true };
        continue;
      }
      const verified = await verifySegmentForExtraction({
        fileSystem: options.fileSystem,
        walDirectoryPath: segment.walDirectoryPath,
        segmentId: segment.segmentId,
        ...(options.maxSegmentBytes === undefined ? {} : { maxSegmentBytes: options.maxSegmentBytes }),
      });
      if (verified.status === "refused") {
        await closeBatch();
        refused.push(verified);
        previous = { segmentIndex: segment.segmentIndex, pointer: null, chainable: false };
        continue;
      }

      const contiguous: boolean = previous !== null && previous.chainable && previous.segmentIndex + 1 === segment.segmentIndex;
      const currentBatch: Batch | null = batch;
      if (currentBatch === null || !contiguous) {
        await closeBatch();
        let stateIn: Batch["stateIn"] = null;
        let state: SamplerState | null = null;
        const head: { segmentIndex: number; pointer: ResearchPointer | null; chainable: boolean } | null = previous;
        if (contiguous && head !== null && head.pointer !== null) {
          const loaded = await loadState(options.objectStore, head.pointer);
          if (loaded !== null) {
            state = loaded.state;
            stateIn = loaded.link;
          }
        }
        batch = {
          gatewayEpoch,
          sampler: new ResearchSampler({ gatewayEpoch, state }),
          interpreter: new FrameInterpreter(),
          stateIn,
          segments: [],
          identities: new Map(),
          framesRead: 0,
          segmentDeclared: 0,
        };
      }
      const active = batch as Batch | null;
      if (active === null) throw new Error("unreachable: no extraction batch is open");
      // The market inventory is taken from EVERY frame, whatever the sampler
      // keeps: an event it discards (best_bid_ask), one the door does not
      // know, or one it finds invalid still names its market.
      const inventory = new MarketIdentityInventory();
      for (const entry of verified.records) {
        inventory.add(entry.record);
        const interpretation = active.interpreter.interpret(entry.record);
        active.sampler.consume({ record: entry.record, segmentId: verified.segmentId, interpretation });
      }
      active.identities.set(verified.segmentId, inventory.result());
      active.framesRead += verified.records.length;
      active.segmentDeclared += verified.manifest.recordCount;
      // Keep the digests and ranges; drop the records.
      active.segments.push({ ...verified, records: [] });
      previous = { segmentIndex: segment.segmentIndex, pointer: null, chainable: true };
      if (active.segments.length >= maxSegmentsPerDataset) await closeBatch();
    }
    await closeBatch();
  }

  return { datasets, refused, segmentsExtracted, framesRead, uninterpretedByCategory: uninterpreted };
}

function sourceSegmentOf(segment: VerifiedSegment, marketIdentities: ResearchMarketIdentities): ResearchSourceSegment {
  return {
    segmentId: segment.segmentId,
    gatewayEpoch: segment.manifest.gatewayEpoch,
    segmentIndex: segment.manifest.segmentIndex,
    segmentSha256: segment.segmentSha256,
    segmentFileSha256: segment.segmentFileSha256,
    checksummedByteLength: segment.manifest.checksummedByteLength,
    byteSize: segment.byteSize,
    recordCount: segment.manifest.recordCount,
    firstIngestSeq: segment.manifest.firstIngestSeq,
    lastIngestSeq: segment.manifest.lastIngestSeq,
    minReceivedAt: segment.minReceivedAt,
    maxReceivedAt: segment.maxReceivedAt,
    verification: RESEARCH_SOURCE_VERIFICATION,
    marketIdentities,
  };
}

async function writeBatch(options: ExtractionOptions, batch: Batch): Promise<ExtractionResult["datasets"][number]> {
  const datasetId = datasetIdFor(batch.gatewayEpoch, batch.segments);
  const prefix = `${RESEARCH_KEY_PREFIX}/${batch.gatewayEpoch}/${datasetId}`;
  const manifestObjectKey = `${prefix}/${DATASET_MANIFEST_OBJECT_NAME}`;
  const sourceSegments = batch.segments.map((segment) => {
    const identities = batch.identities.get(segment.segmentId);
    if (identities === undefined) throw new Error(`unreachable: segment ${segment.segmentId} has no market inventory`);
    return sourceSegmentOf(segment, identities);
  });

  let manifestSha256: string;
  let samples: number;
  let objectBytes = 0;
  if ((await options.objectStore.head(manifestObjectKey)) !== null) {
    // A previous run wrote this dataset and stopped before its pointers.
    // Adopt it only if it is verified and describes exactly these segments.
    const existing = await verifyResearchTierDataset(options.objectStore, manifestObjectKey);
    const same =
      existing.manifest.sourceSegments.length === sourceSegments.length &&
      existing.manifest.sourceSegments.every(
        (entry, index) =>
          entry.segmentId === sourceSegments[index]?.segmentId &&
          entry.segmentSha256 === sourceSegments[index]?.segmentSha256 &&
          entry.segmentFileSha256 === sourceSegments[index]?.segmentFileSha256 &&
          JSON.stringify(entry.marketIdentities) === JSON.stringify(sourceSegments[index]?.marketIdentities),
      );
    if (!same) {
      throw new ObjectVerificationError("a research-tier dataset already exists under this key with other sources", {
        manifestObjectKey,
      });
    }
    manifestSha256 = existing.manifestSha256;
    samples = existing.manifest.recordCounts.samplesWritten;
  } else {
    const counts = batch.sampler.counts;
    const written = await writeResearchTierDataset({
      datasetId,
      objectKeyPrefix: prefix,
      objectStore: options.objectStore,
      clock: options.clock,
      gatewayEpoch: batch.gatewayEpoch,
      downsampling: RESEARCH_DOWNSAMPLING,
      rowsByTable: batch.sampler.rows(),
      sourceSegments,
      recordCounts: {
        segmentDeclared: batch.segmentDeclared,
        framesRead: batch.framesRead,
        framesInterpreted: counts.framesInterpreted,
        framesUninterpreted: counts.framesUninterpreted + counts.framesSkippedNotAdvancing,
      },
      samplerStateIn: batch.stateIn,
      samplerStateOut: encodeSamplerState(batch.sampler.exportState()),
    });
    // ADR-028 Decision 2.2: verified means read back from the store and
    // checked against its manifest digest — re-done from the store alone.
    const verified = await verifyResearchTierDataset(options.objectStore, written.manifestObjectKey);
    if (verified.manifestSha256 !== written.manifestSha256) {
      throw new ObjectVerificationError("the research-tier manifest did not verify after writing", { manifestObjectKey });
    }
    manifestSha256 = written.manifestSha256;
    samples = written.manifest.recordCounts.samplesWritten;
    objectBytes = written.objectBytesWritten;
  }

  for (const segment of batch.segments) {
    const pointer: ResearchPointer = {
      pointerVersion: RESEARCH_POINTER_VERSION,
      segmentId: segment.segmentId,
      gatewayEpoch: batch.gatewayEpoch,
      segmentIndex: segment.manifest.segmentIndex,
      segmentSha256: segment.segmentSha256,
      segmentFileSha256: segment.segmentFileSha256,
      byteSize: segment.byteSize,
      recordCount: segment.manifest.recordCount,
      minReceivedAt: segment.minReceivedAt,
      maxReceivedAt: segment.maxReceivedAt,
      minIngestSeq: segment.minIngestSeq,
      maxIngestSeq: segment.maxIngestSeq,
      datasetId,
      manifestObjectKey,
      manifestSha256,
    };
    await options.objectStore.put(researchPointerKey(batch.gatewayEpoch, segment.segmentId), encodePointer(pointer));
  }

  return {
    datasetId,
    manifestObjectKey,
    manifestSha256,
    segmentIds: batch.segments.map((segment) => segment.segmentId),
    samples,
    objectBytes,
    freshStart: batch.stateIn === null,
  };
}
