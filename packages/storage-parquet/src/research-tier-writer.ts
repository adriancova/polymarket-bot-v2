/**
 * Writing a research-tier dataset, and verifying one from the store.
 *
 * The order is the compactor's (`compactor.ts`), for the compactor's reasons:
 *
 * 1. encode every table object and **read it back** — the digest that goes
 *    into the manifest is the one computed from the bytes the store returned,
 *    and every row is decoded and compared with the row that was written;
 * 2. write the downsampler's end state (a span still open at the end of the
 *    dataset is released in a later one) and read it back;
 * 3. write the manifest and its digest sidecar and read both back.
 *
 * Only then is the dataset **verified** in ADR-028 Decision 2.2's sense: "read
 * back from the store and checked against its manifest digest". Nothing here
 * deletes anything. {@link verifyResearchTierDataset} is the re-check the
 * expiry guard runs, from the store alone, immediately before a deletion.
 */

import { DATASET_MANIFEST_DIGEST_OBJECT_NAME, DATASET_MANIFEST_FORMAT_ID, DATASET_MANIFEST_OBJECT_NAME, DATASET_MANIFEST_VERSION, DEFAULT_ROW_GROUP_SIZE, PARQUET_OBJECT_SUFFIX } from "./constants.js";
import { PARQUET_WRITER_LIBRARY, PARQUET_WRITER_LIBRARY_VERSION } from "./compactor.js";
import { DatasetManifestError, ObjectVerificationError } from "./errors.js";
import type { DatasetCodec } from "./parquet-object.js";
import type { CompactionClock, ObjectStore } from "./ports.js";
import { RESEARCH_TABLES } from "./research-tier-layout.js";
import type { ResearchRow, ResearchTableName } from "./research-tier-layout.js";
import {
  APPROXIMATE_ADMISSIBILITY_NOTE,
  encodeResearchTierManifest,
  parseResearchTierManifest,
  researchTierManifestDigest,
  researchTierSchemaVersions,
} from "./research-tier-manifest.js";
import type {
  ResearchDownsampling,
  ResearchObjectEntry,
  ResearchRecordCounts,
  ResearchReleaseIdentity,
  ResearchSourceSegment,
  ResearchStateObject,
  ResearchTierManifest,
} from "./research-tier-manifest.js";
import { readResearchTableObject, writeResearchTableObject } from "./research-tier-object.js";
import { compareUnsignedIntegerStrings, sha256Hex } from "./wal-format.js";

/** Object name of the downsampler's end state, next to the manifest. */
export const RESEARCH_SAMPLER_STATE_OBJECT_NAME = "sampler-state-out.json";

export type ResearchTierWriteOptions = {
  readonly datasetId: string;
  readonly objectKeyPrefix: string;
  readonly objectStore: ObjectStore;
  readonly clock: CompactionClock;
  readonly gatewayEpoch: string;
  readonly downsampling: ResearchDownsampling;
  /** Every table's rows. A table absent from the map, or empty, writes no object. */
  readonly rowsByTable: ReadonlyMap<ResearchTableName, readonly ResearchRow[]>;
  readonly sourceSegments: readonly ResearchSourceSegment[];
  readonly recordCounts: Omit<ResearchRecordCounts, "samplesWritten">;
  readonly samplerStateIn: (ResearchStateObject & { readonly datasetId: string }) | null;
  /** The downsampler's end state, already encoded. */
  readonly samplerStateOut: Uint8Array;
  readonly codec?: DatasetCodec;
  readonly rowGroupSize?: number;
};

export type ResearchTierWriteResult = {
  readonly manifest: ResearchTierManifest;
  readonly manifestObjectKey: string;
  readonly manifestSha256: string;
  readonly objectBytesWritten: number;
};

function digestSidecarKey(manifestKey: string): string {
  if (manifestKey === DATASET_MANIFEST_OBJECT_NAME) return DATASET_MANIFEST_DIGEST_OBJECT_NAME;
  if (!manifestKey.endsWith(`/${DATASET_MANIFEST_OBJECT_NAME}`)) {
    throw new DatasetManifestError("a dataset manifest key must end in manifest.json", { manifestKey });
  }
  return `${manifestKey.slice(0, manifestKey.length - DATASET_MANIFEST_OBJECT_NAME.length)}${DATASET_MANIFEST_DIGEST_OBJECT_NAME}`;
}

/** The digest sidecar key that belongs to a manifest key. */
export function manifestDigestSidecarKey(manifestKey: string): string {
  return digestSidecarKey(manifestKey);
}

async function putAndVerify(objectStore: ObjectStore, key: string, bytes: Uint8Array): Promise<string> {
  await objectStore.put(key, bytes);
  const head = await objectStore.head(key);
  if (head === null || head.byteLength !== bytes.byteLength) {
    throw new ObjectVerificationError("object is absent or of a different length after a successful put", {
      objectKey: key,
      expected: bytes.byteLength,
      observed: head?.byteLength ?? null,
    });
  }
  const stored = await objectStore.get(key);
  const expected = sha256Hex(bytes);
  const observed = sha256Hex(stored);
  if (observed !== expected) {
    throw new ObjectVerificationError("object read back with a different digest", { objectKey: key, expected, observed });
  }
  return observed;
}

function rowsEqual(left: ResearchRow, right: ResearchRow): boolean {
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every((key) => (left[key] ?? null) === (right[key] ?? null));
}

/**
 * Check the release order of the rows before anything is written: every row
 * carries the dataset's epoch, the ordinals are dense and unique, and, read in
 * ordinal order, the release frames never go backwards in dispatch order
 * (ADR-029 Decision 5.3: samples replay in the dispatch order of their release
 * frames). A downsampler that broke any of these would write a dataset that
 * replays out of arrival order, so it is refused here, not described.
 */
function checkReleaseOrder(
  gatewayEpoch: string,
  rowsByTable: ReadonlyMap<ResearchTableName, readonly ResearchRow[]>,
): { first: ResearchReleaseIdentity | null; last: ResearchReleaseIdentity | null; total: number } {
  const byOrdinal: { ordinal: number; row: ResearchRow }[] = [];
  for (const rows of rowsByTable.values()) {
    for (const row of rows) {
      const ordinal = row["sampleOrdinal"];
      if (typeof ordinal !== "number" || !Number.isSafeInteger(ordinal) || ordinal < 0) {
        throw new DatasetManifestError("a research-tier row has no valid sampleOrdinal");
      }
      if (row["gatewayEpoch"] !== gatewayEpoch) {
        throw new DatasetManifestError("a research-tier row belongs to another gateway epoch", {
          expected: gatewayEpoch,
          observed: String(row["gatewayEpoch"]),
        });
      }
      byOrdinal.push({ ordinal, row });
    }
  }
  byOrdinal.sort((left, right) => left.ordinal - right.ordinal);
  let previous: string | null = null;
  byOrdinal.forEach((entry, index) => {
    if (entry.ordinal !== index) {
      throw new DatasetManifestError("research-tier sample ordinals are not dense and unique", {
        expected: index,
        observed: entry.ordinal,
      });
    }
    const seq = entry.row["releaseIngestSeq"];
    if (typeof seq !== "string" || !/^(0|[1-9][0-9]*)$/u.test(seq)) {
      throw new DatasetManifestError("a research-tier row has no canonical releaseIngestSeq", { sampleOrdinal: index });
    }
    if (previous !== null && compareUnsignedIntegerStrings(seq, previous) < 0) {
      throw new DatasetManifestError(
        "research-tier samples would replay out of release order (ADR-029 Decision 5.3)",
        { sampleOrdinal: index, releaseIngestSeq: seq, previous },
      );
    }
    previous = seq;
  });
  const identity = (entry: { ordinal: number; row: ResearchRow } | undefined): ResearchReleaseIdentity | null =>
    entry === undefined
      ? null
      : {
          gatewayEpoch,
          ingestSeq: String(entry.row["releaseIngestSeq"]),
          availableAt: String(entry.row["availableAt"]),
          sampleOrdinal: entry.ordinal,
        };
  return { first: identity(byOrdinal[0]), last: identity(byOrdinal[byOrdinal.length - 1]), total: byOrdinal.length };
}

/** Write a research-tier dataset and read every byte of it back. */
export async function writeResearchTierDataset(options: ResearchTierWriteOptions): Promise<ResearchTierWriteResult> {
  if (options.datasetId.length === 0 || options.objectKeyPrefix.length === 0) {
    throw new DatasetManifestError("a research-tier dataset needs a dataset id and an object-key prefix");
  }
  for (const segment of options.sourceSegments) {
    if (segment.gatewayEpoch !== options.gatewayEpoch) {
      throw new DatasetManifestError("a research-tier dataset covers one gateway epoch (ADR-029 Decision 5.4)", {
        segmentId: segment.segmentId,
      });
    }
  }
  const codec: DatasetCodec = options.codec ?? "SNAPPY";
  const rowGroupSize = options.rowGroupSize ?? DEFAULT_ROW_GROUP_SIZE;
  const order = checkReleaseOrder(options.gatewayEpoch, options.rowsByTable);
  const keyFor = (name: string): string => `${options.objectKeyPrefix}/${name}`;

  const objects: ResearchObjectEntry[] = [];
  let objectBytesWritten = 0;
  for (const table of RESEARCH_TABLES) {
    const rows = options.rowsByTable.get(table.name) ?? [];
    if (rows.length === 0) continue;
    const encoded = writeResearchTableObject({
      table,
      rows,
      codec,
      rowGroupSize,
      keyValueMetadata: {
        "polymarket-bot.datasetId": options.datasetId,
        "polymarket-bot.fidelity": "approximate",
        "polymarket-bot.researchTierLayoutId": researchTierSchemaVersions().researchTierLayoutId,
        "polymarket-bot.table": table.name,
      },
    });
    const objectKey = keyFor(`${table.name}${PARQUET_OBJECT_SUFFIX}`);
    const sha256 = await putAndVerify(options.objectStore, objectKey, encoded.bytes);
    const decoded = await readResearchTableObject(table, await options.objectStore.get(objectKey));
    if (decoded.length !== rows.length || decoded.some((row, index) => !rowsEqual(row, rows[index] as ResearchRow))) {
      throw new ObjectVerificationError("a research-tier object does not read back to the rows written", {
        objectKey,
        table: table.name,
      });
    }
    const ordinals = rows.map((row) => row["sampleOrdinal"] as number);
    objects.push({
      objectKey,
      table: table.name,
      byteLength: encoded.bytes.byteLength,
      sha256,
      rowCount: rows.length,
      firstSampleOrdinal: Math.min(...ordinals),
      lastSampleOrdinal: Math.max(...ordinals),
    });
    objectBytesWritten += encoded.bytes.byteLength;
  }

  const stateKey = keyFor(RESEARCH_SAMPLER_STATE_OBJECT_NAME);
  const stateSha256 = await putAndVerify(options.objectStore, stateKey, options.samplerStateOut);
  objectBytesWritten += options.samplerStateOut.byteLength;

  const manifest: ResearchTierManifest = {
    datasetManifestFormatId: DATASET_MANIFEST_FORMAT_ID,
    datasetManifestVersion: DATASET_MANIFEST_VERSION,
    fidelity: "approximate",
    datasetId: options.datasetId,
    createdAt: new Date(options.clock.nowMs()).toISOString(),
    admissibility: APPROXIMATE_ADMISSIBILITY_NOTE,
    schemaVersions: researchTierSchemaVersions(),
    downsampling: options.downsampling,
    writer: {
      library: PARQUET_WRITER_LIBRARY,
      libraryVersion: PARQUET_WRITER_LIBRARY_VERSION,
      codec,
      rowGroupSize,
    },
    tables: RESEARCH_TABLES.map((table) => ({
      table: table.name,
      sampleClass: table.sampleClass,
      columns: table.columns.map((column) => ({
        name: column.name,
        physicalType: column.physicalType,
        nullable: column.nullable,
      })),
    })),
    gatewayEpochs: [options.gatewayEpoch],
    releaseRange: { first: order.first, last: order.last },
    recordCounts: { ...options.recordCounts, samplesWritten: order.total },
    samplerState: {
      stateIn: options.samplerStateIn,
      stateOut: { objectKey: stateKey, byteLength: options.samplerStateOut.byteLength, sha256: stateSha256 },
    },
    sourceSegments: options.sourceSegments,
    objects,
  };

  const manifestObjectKey = keyFor(DATASET_MANIFEST_OBJECT_NAME);
  const manifestBytes = encodeResearchTierManifest(manifest);
  const manifestSha256 = researchTierManifestDigest(manifest);
  await putAndVerify(options.objectStore, manifestObjectKey, manifestBytes);
  const sidecarBytes = Buffer.from(`${manifestSha256}\n`, "utf8");
  await putAndVerify(options.objectStore, digestSidecarKey(manifestObjectKey), sidecarBytes);

  // The written document must read back through the reader every consumer
  // uses, or the dataset is not one this build can prove anything with.
  parseResearchTierManifest(JSON.parse(Buffer.from(manifestBytes).toString("utf8")) as unknown);

  return { manifest, manifestObjectKey, manifestSha256, objectBytesWritten };
}

/** What {@link verifyResearchTierDataset} established. */
export type VerifiedResearchTierDataset = {
  readonly manifest: ResearchTierManifest;
  readonly manifestObjectKey: string;
  readonly manifestSha256: string;
};

/**
 * Re-verify a research-tier dataset from the store alone (ADR-028 Decision
 * 2.2: "read back from the store and checked against its manifest digest").
 *
 * The manifest must exist, hash to its sidecar, and parse as a research-tier
 * manifest; every object it pins, and its sampler end state, must exist with
 * the pinned length and digest. Throws {@link ObjectVerificationError} or
 * {@link DatasetManifestError} otherwise.
 */
export async function verifyResearchTierDataset(
  objectStore: ObjectStore,
  manifestObjectKey: string,
): Promise<VerifiedResearchTierDataset> {
  if ((await objectStore.head(manifestObjectKey)) === null) {
    throw new ObjectVerificationError("the research-tier manifest is not in the store", { manifestObjectKey });
  }
  const manifestBytes = await objectStore.get(manifestObjectKey);
  const manifestSha256 = sha256Hex(manifestBytes);
  const sidecarKey = digestSidecarKey(manifestObjectKey);
  if ((await objectStore.head(sidecarKey)) === null) {
    throw new ObjectVerificationError("the research-tier manifest's digest sidecar is not in the store", { sidecarKey });
  }
  const sidecar = Buffer.from(await objectStore.get(sidecarKey)).toString("utf8").trim();
  if (sidecar !== manifestSha256) {
    throw new ObjectVerificationError("the research-tier manifest does not match its digest sidecar", {
      manifestObjectKey,
      sidecar,
      observed: manifestSha256,
    });
  }
  let manifest: ResearchTierManifest;
  try {
    manifest = parseResearchTierManifest(JSON.parse(Buffer.from(manifestBytes).toString("utf8")) as unknown);
  } catch (error) {
    throw new DatasetManifestError("the research-tier manifest could not be read", {
      manifestObjectKey,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  const pinned: { objectKey: string; byteLength: number; sha256: string }[] = [
    ...manifest.objects,
    manifest.samplerState.stateOut,
  ];
  for (const object of pinned) {
    const head = await objectStore.head(object.objectKey);
    if (head === null || head.byteLength !== object.byteLength) {
      throw new ObjectVerificationError("a research-tier object is absent or of a different length", {
        objectKey: object.objectKey,
        pinned: object.byteLength,
        observed: head?.byteLength ?? null,
      });
    }
    const observed = sha256Hex(await objectStore.get(object.objectKey));
    if (observed !== object.sha256) {
      throw new ObjectVerificationError("a research-tier object's digest differs from its pin", {
        objectKey: object.objectKey,
        pinned: object.sha256,
        observed,
      });
    }
  }
  return { manifest, manifestObjectKey, manifestSha256 };
}
