/**
 * The research-tier dataset manifest: a version 2 dataset manifest whose
 * `fidelity` is `approximate` (ADR-029 Decision 1.4).
 *
 * It shares the dataset manifest's document family
 * (`polymarket-bot/dataset-manifest/v1`, version 2) with the exact manifest
 * `dataset-manifest.ts` defines, and its body differs where an approximate
 * dataset differs:
 *
 * - it pins the **research-tier objects** and their digests, the research-tier
 *   layout, and the **downsampling version** (ADR-029 Decision 1.4) — an
 *   approximate replay reads these, never raw segments;
 * - it lists **every source segment** the research tier was built from, with
 *   both digests, `segmentSha256` and `segmentFileSha256` (Decision 1.5). That
 *   is provenance, and it is the deletion-time identity ADR-028 Decision 2.6
 *   needs: the expiry guard requires the file it is about to delete to hash to
 *   these two pins (`expiry-proof.ts`). Both digests were computed by the
 *   extractor from the bytes `validateSegment` verified. Each entry also
 *   inventories the Polymarket markets the segment names
 *   (`marketIdentities`), which the expiry decision checks against the
 *   window registry: an identity the decision relies on is checksummed here,
 *   never read from an unverified index;
 * - it states its admissibility in the document itself (ADR-029 Decision 4.2:
 *   "The label is carried in the run's manifest, not inferred from a file
 *   name").
 *
 * Like every manifest it is immutable, written with a digest sidecar, and
 * carries no deletion state (ADR-017 §4, ADR-028 Decision 4.6).
 */

import { encodePlainJson } from "@polymarket-bot/risk/plain-json";

import {
  DATASET_MANIFEST_FORMAT_ID,
  DATASET_MANIFEST_VERSION,
  SUPPORTED_WAL_MANIFEST_VERSION,
  SUPPORTED_WAL_SCHEMA_VERSION,
  WAL_FORMAT_ID,
} from "./constants.js";
import type { DatasetColumnPin, DatasetManifest, DatasetWriterInfo } from "./dataset-manifest.js";
import { parseDatasetManifest, readDatasetManifestFidelity } from "./dataset-manifest.js";
import { DatasetManifestError } from "./errors.js";
import {
  RESEARCH_TABLE_NAMES,
  RESEARCH_TIER_LAYOUT_ID,
  RESEARCH_TIER_LAYOUT_VERSION,
} from "./research-tier-layout.js";
import type { ResearchSampleClass, ResearchTableName } from "./research-tier-layout.js";
import { sha256Hex } from "./wal-format.js";

/** The admissibility statement every research-tier manifest carries. */
export const APPROXIMATE_ADMISSIBILITY_NOTE =
  "approximate: a research-tier dataset, downsampled from raw WAL. It cannot show queue " +
  "position or moves inside one second (ADR-028 Decision 7). It is never admissible as " +
  "determinism, calibration, promotion or soak evidence, and any result computed from it " +
  "ranks below every ADR-012 tier (ADR-029 Decisions 2 and 3).";

/** How each source segment was verified before the research tier read it. */
export const RESEARCH_SOURCE_VERIFICATION =
  "storage-wal.validateSegment+storage-parquet.readWalSegment over one in-memory read";

/** The release identity of one sample (ADR-029 Decision 5.2). */
export type ResearchReleaseIdentity = {
  readonly gatewayEpoch: string;
  readonly ingestSeq: string;
  readonly availableAt: string;
  readonly sampleOrdinal: number;
};

/** One source segment the research tier was built from (ADR-029 Decision 1.5). */
export type ResearchSourceSegment = {
  readonly segmentId: string;
  readonly gatewayEpoch: string;
  readonly segmentIndex: number;
  /** WAL-chain identity, re-verified by `validateSegment` (ADR-017 §1). */
  readonly segmentSha256: string;
  /** Deletion-time identity: SHA-256 over the whole file, from the verified bytes. */
  readonly segmentFileSha256: string;
  readonly checksummedByteLength: number;
  readonly byteSize: number;
  readonly recordCount: number;
  readonly firstIngestSeq: string | null;
  readonly lastIngestSeq: string | null;
  /** Smallest `receivedAt` over the segment's verified frames. */
  readonly minReceivedAt: string | null;
  /**
   * Newest `receivedAt` over **all** of the segment's verified frames — the
   * maximum, not the last frame's stamp (ADR-028 Decision 2.1). This is the
   * value the 72-hour age is taken from.
   */
  readonly maxReceivedAt: string | null;
  readonly verification: string;
  /**
   * Every Polymarket market the segment's frames name, inventoried from the
   * verified frames independently of what the downsampler keeps (ADR-028
   * Decision 2.3: a window is classified only if it is known). Bound here, in
   * the checksummed manifest, because the expiry decision relies on it.
   */
  readonly marketIdentities: ResearchMarketIdentities;
};

/**
 * The market identities one source segment names (`STORAGE-1`).
 *
 * `unidentifiedFrames` counts frames that could carry Polymarket market
 * content but name no market the inventory can read: a market-channel frame
 * that does not parse or has an entry naming nothing, a Polymarket endpoint
 * the inventory does not know with no identity in its query or body, a frame
 * from an unknown source. A segment with any is never expired: its windows
 * cannot be classified.
 */
export type ResearchMarketIdentities = {
  /** Outcome token ids, sorted, unique. */
  readonly polymarketTokenIds: readonly string[];
  /** Condition ids, sorted, unique. */
  readonly conditionIds: readonly string[];
  /** Gamma market ids the lifecycle polls name by endpoint, sorted, unique. */
  readonly gammaMarketIds: readonly string[];
  readonly unidentifiedFrames: number;
};

/** One research-tier object. */
export type ResearchObjectEntry = {
  readonly objectKey: string;
  readonly table: ResearchTableName;
  readonly byteLength: number;
  /** SHA-256 of the object AS READ BACK from the store. */
  readonly sha256: string;
  readonly rowCount: number;
  readonly firstSampleOrdinal: number | null;
  readonly lastSampleOrdinal: number | null;
};

/** One table's pinned columns. */
export type ResearchTableEntry = {
  readonly table: ResearchTableName;
  readonly sampleClass: ResearchSampleClass;
  readonly columns: readonly DatasetColumnPin[];
};

/** The downsampling version and its parameters (ADR-029 Decision 1.4). */
export type ResearchDownsampling = {
  readonly downsamplingId: string;
  readonly downsamplingVersion: number;
  readonly parameters: Readonly<Record<string, string | number>>;
  /** The fixed tie order of Decision 5.3, stated in words. */
  readonly tieOrder: string;
};

/** A pinned sampler-state object. */
export type ResearchStateObject = {
  readonly objectKey: string;
  readonly byteLength: number;
  readonly sha256: string;
};

/**
 * The downsampler's state at the dataset's boundaries.
 *
 * A span that is still open at the end of a dataset is released by a frame in
 * a later segment, so its contributions travel in `stateOut` to the next
 * dataset of the same epoch, whose `stateIn` names it. `stateIn: null` means
 * the dataset started fresh: the epoch's first segment, or a discontinuity
 * (stated, never silent).
 */
export type ResearchSamplerState = {
  readonly stateIn: (ResearchStateObject & { readonly datasetId: string }) | null;
  readonly stateOut: ResearchStateObject;
};

/** Counts a reader can reconcile. */
export type ResearchRecordCounts = {
  readonly segmentDeclared: number;
  readonly framesRead: number;
  readonly framesInterpreted: number;
  readonly framesUninterpreted: number;
  readonly samplesWritten: number;
};

/** The research-tier (approximate) dataset manifest. */
export type ResearchTierManifest = {
  readonly datasetManifestFormatId: string;
  readonly datasetManifestVersion: number;
  readonly fidelity: "approximate";
  readonly datasetId: string;
  readonly createdAt: string;
  readonly admissibility: string;
  readonly schemaVersions: {
    readonly walFormatId: string;
    readonly walSchemaVersion: number;
    readonly walManifestVersion: number;
    readonly researchTierLayoutId: string;
    readonly researchTierLayoutVersion: number;
    readonly datasetManifestFormatId: string;
    readonly datasetManifestVersion: number;
  };
  readonly downsampling: ResearchDownsampling;
  readonly writer: DatasetWriterInfo;
  readonly tables: readonly ResearchTableEntry[];
  /** Exactly one epoch (ADR-029 Decision 5.4). */
  readonly gatewayEpochs: readonly string[];
  readonly releaseRange: {
    readonly first: ResearchReleaseIdentity | null;
    readonly last: ResearchReleaseIdentity | null;
  };
  readonly recordCounts: ResearchRecordCounts;
  readonly samplerState: ResearchSamplerState;
  readonly sourceSegments: readonly ResearchSourceSegment[];
  readonly objects: readonly ResearchObjectEntry[];
};

/** The schema versions a research-tier manifest pins. */
export function researchTierSchemaVersions(): ResearchTierManifest["schemaVersions"] {
  return {
    walFormatId: WAL_FORMAT_ID,
    walSchemaVersion: SUPPORTED_WAL_SCHEMA_VERSION,
    walManifestVersion: SUPPORTED_WAL_MANIFEST_VERSION,
    researchTierLayoutId: RESEARCH_TIER_LAYOUT_ID,
    researchTierLayoutVersion: RESEARCH_TIER_LAYOUT_VERSION,
    datasetManifestFormatId: DATASET_MANIFEST_FORMAT_ID,
    datasetManifestVersion: DATASET_MANIFEST_VERSION,
  };
}

function orderedIdentity(identity: ResearchReleaseIdentity | null): Record<string, unknown> | null {
  return identity === null
    ? null
    : {
        gatewayEpoch: identity.gatewayEpoch,
        ingestSeq: identity.ingestSeq,
        availableAt: identity.availableAt,
        sampleOrdinal: identity.sampleOrdinal,
      };
}

function orderedState(state: ResearchStateObject): Record<string, unknown> {
  return { objectKey: state.objectKey, byteLength: state.byteLength, sha256: state.sha256 };
}

/** Serialize a research-tier manifest canonically (fixed key order). */
export function encodeResearchTierManifest(manifest: ResearchTierManifest): Uint8Array {
  if (manifest.fidelity !== "approximate" || manifest.datasetManifestVersion !== DATASET_MANIFEST_VERSION) {
    throw new DatasetManifestError("a research-tier manifest is a version 2 approximate manifest", {
      fidelity: String(manifest.fidelity),
      version: manifest.datasetManifestVersion,
    });
  }
  const ordered = {
    datasetManifestFormatId: manifest.datasetManifestFormatId,
    datasetManifestVersion: manifest.datasetManifestVersion,
    fidelity: manifest.fidelity,
    datasetId: manifest.datasetId,
    createdAt: manifest.createdAt,
    admissibility: manifest.admissibility,
    schemaVersions: {
      walFormatId: manifest.schemaVersions.walFormatId,
      walSchemaVersion: manifest.schemaVersions.walSchemaVersion,
      walManifestVersion: manifest.schemaVersions.walManifestVersion,
      researchTierLayoutId: manifest.schemaVersions.researchTierLayoutId,
      researchTierLayoutVersion: manifest.schemaVersions.researchTierLayoutVersion,
      datasetManifestFormatId: manifest.schemaVersions.datasetManifestFormatId,
      datasetManifestVersion: manifest.schemaVersions.datasetManifestVersion,
    },
    downsampling: {
      downsamplingId: manifest.downsampling.downsamplingId,
      downsamplingVersion: manifest.downsampling.downsamplingVersion,
      parameters: Object.fromEntries(
        Object.entries(manifest.downsampling.parameters).sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0,
        ),
      ),
      tieOrder: manifest.downsampling.tieOrder,
    },
    writer: {
      library: manifest.writer.library,
      libraryVersion: manifest.writer.libraryVersion,
      codec: manifest.writer.codec,
      rowGroupSize: manifest.writer.rowGroupSize,
    },
    tables: manifest.tables.map((table) => ({
      table: table.table,
      sampleClass: table.sampleClass,
      columns: table.columns.map((column) => ({
        name: column.name,
        physicalType: column.physicalType,
        nullable: column.nullable,
      })),
    })),
    gatewayEpochs: [...manifest.gatewayEpochs],
    releaseRange: {
      first: orderedIdentity(manifest.releaseRange.first),
      last: orderedIdentity(manifest.releaseRange.last),
    },
    recordCounts: {
      segmentDeclared: manifest.recordCounts.segmentDeclared,
      framesRead: manifest.recordCounts.framesRead,
      framesInterpreted: manifest.recordCounts.framesInterpreted,
      framesUninterpreted: manifest.recordCounts.framesUninterpreted,
      samplesWritten: manifest.recordCounts.samplesWritten,
    },
    samplerState: {
      stateIn:
        manifest.samplerState.stateIn === null
          ? null
          : {
              datasetId: manifest.samplerState.stateIn.datasetId,
              ...orderedState(manifest.samplerState.stateIn),
            },
      stateOut: orderedState(manifest.samplerState.stateOut),
    },
    sourceSegments: manifest.sourceSegments.map((segment) => ({
      segmentId: segment.segmentId,
      gatewayEpoch: segment.gatewayEpoch,
      segmentIndex: segment.segmentIndex,
      segmentSha256: segment.segmentSha256,
      segmentFileSha256: segment.segmentFileSha256,
      checksummedByteLength: segment.checksummedByteLength,
      byteSize: segment.byteSize,
      recordCount: segment.recordCount,
      firstIngestSeq: segment.firstIngestSeq,
      lastIngestSeq: segment.lastIngestSeq,
      minReceivedAt: segment.minReceivedAt,
      maxReceivedAt: segment.maxReceivedAt,
      verification: segment.verification,
      marketIdentities: {
        polymarketTokenIds: [...segment.marketIdentities.polymarketTokenIds],
        conditionIds: [...segment.marketIdentities.conditionIds],
        gammaMarketIds: [...segment.marketIdentities.gammaMarketIds],
        unidentifiedFrames: segment.marketIdentities.unidentifiedFrames,
      },
    })),
    objects: manifest.objects.map((object) => ({
      objectKey: object.objectKey,
      table: object.table,
      byteLength: object.byteLength,
      sha256: object.sha256,
      rowCount: object.rowCount,
      firstSampleOrdinal: object.firstSampleOrdinal,
      lastSampleOrdinal: object.lastSampleOrdinal,
    })),
  };
  return Buffer.from(`${encodePlainJson(ordered, { indent: 2 })}\n`, "utf8");
}

/** SHA-256 of a research-tier manifest's canonical bytes. */
export function researchTierManifestDigest(manifest: ResearchTierManifest): string {
  return sha256Hex(encodeResearchTierManifest(manifest));
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const SHA256 = /^[0-9a-f]{64}$/u;
const UINT = /^(0|[1-9][0-9]*)$/u;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/u;

function bad(message: string, details: Readonly<Record<string, unknown>> = {}): never {
  throw new DatasetManifestError(`research-tier manifest: ${message}`, details);
}

function obj(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) bad(`${what} must be a JSON object`);
  return value as Record<string, unknown>;
}

function arr(value: unknown, what: string): readonly unknown[] {
  if (!Array.isArray(value)) bad(`${what} must be an array`);
  return value;
}

function str(value: unknown, what: string): string {
  if (typeof value !== "string" || value.length === 0) bad(`${what} must be a non-empty string`);
  return value;
}

function nullableStr(value: unknown, what: string, pattern?: RegExp): string | null {
  if (value === null) return null;
  const text = str(value, what);
  if (pattern !== undefined && !pattern.test(text)) bad(`${what} is malformed`, { value: text });
  return text;
}

function count(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    bad(`${what} must be a non-negative integer`);
  }
  return value;
}

function nullableCount(value: unknown, what: string): number | null {
  return value === null ? null : count(value, what);
}

function digest(value: unknown, what: string): string {
  const text = str(value, what);
  if (!SHA256.test(text)) bad(`${what} must be 64 lowercase hex`, { value: text });
  return text;
}

function identityList(value: unknown, what: string): readonly string[] {
  const list = arr(value, what).map((entry, index) => str(entry, `${what}[${String(index)}]`));
  for (let index = 1; index < list.length; index += 1) {
    if ((list[index - 1] as string) >= (list[index] as string)) bad(`${what} must be sorted and unique`);
  }
  return list;
}

function marketIdentities(value: unknown, what: string): ResearchMarketIdentities {
  const source = obj(value, what);
  return {
    polymarketTokenIds: identityList(source["polymarketTokenIds"], `${what}.polymarketTokenIds`),
    conditionIds: identityList(source["conditionIds"], `${what}.conditionIds`),
    gammaMarketIds: identityList(source["gammaMarketIds"], `${what}.gammaMarketIds`),
    unidentifiedFrames: count(source["unidentifiedFrames"], `${what}.unidentifiedFrames`),
  };
}

function stateObject(value: unknown, what: string): ResearchStateObject {
  const source = obj(value, what);
  return {
    objectKey: str(source["objectKey"], `${what}.objectKey`),
    byteLength: count(source["byteLength"], `${what}.byteLength`),
    sha256: digest(source["sha256"], `${what}.sha256`),
  };
}

function identity(value: unknown, what: string): ResearchReleaseIdentity | null {
  if (value === null) return null;
  const source = obj(value, what);
  const ingestSeq = str(source["ingestSeq"], `${what}.ingestSeq`);
  if (!UINT.test(ingestSeq)) bad(`${what}.ingestSeq must be a canonical unsigned integer`);
  const availableAt = str(source["availableAt"], `${what}.availableAt`);
  if (!ISO.test(availableAt)) bad(`${what}.availableAt must be an ISO-8601 instant`);
  return {
    gatewayEpoch: str(source["gatewayEpoch"], `${what}.gatewayEpoch`),
    ingestSeq,
    availableAt,
    sampleOrdinal: count(source["sampleOrdinal"], `${what}.sampleOrdinal`),
  };
}

/**
 * Parse a research-tier manifest, validating every field a deletion proof or a
 * reader relies on. Refuses anything that is not a version 2 approximate
 * dataset manifest.
 */
export function parseResearchTierManifest(value: unknown): ResearchTierManifest {
  const fidelity = readDatasetManifestFidelity(value);
  if (fidelity !== "approximate") {
    bad("the document is an exact dataset manifest, not a research-tier one", { fidelity });
  }
  const source = obj(value, "manifest");
  const schema = obj(source["schemaVersions"], "schemaVersions");
  if (schema["walFormatId"] !== WAL_FORMAT_ID) {
    bad("it pins a WAL format this build does not read", { walFormatId: schema["walFormatId"] });
  }
  if (
    schema["researchTierLayoutId"] !== RESEARCH_TIER_LAYOUT_ID ||
    schema["researchTierLayoutVersion"] !== RESEARCH_TIER_LAYOUT_VERSION
  ) {
    bad("it pins a research-tier layout this build does not read", {
      layoutId: schema["researchTierLayoutId"],
      layoutVersion: schema["researchTierLayoutVersion"],
    });
  }
  const downsampling = obj(source["downsampling"], "downsampling");
  const parameters = obj(downsampling["parameters"], "downsampling.parameters");
  for (const [key, parameter] of Object.entries(parameters)) {
    if (typeof parameter !== "string" && typeof parameter !== "number") {
      bad("downsampling parameters are strings or numbers", { key });
    }
  }
  const writer = obj(source["writer"], "writer");
  const epochs = arr(source["gatewayEpochs"], "gatewayEpochs").map((epoch, index) =>
    str(epoch, `gatewayEpochs[${String(index)}]`),
  );
  if (epochs.length !== 1) {
    bad("a research-tier dataset covers exactly one gateway epoch (ADR-029 Decision 5.4)", {
      gatewayEpochCount: epochs.length,
    });
  }
  const epoch = epochs[0] as string;
  const range = obj(source["releaseRange"], "releaseRange");
  const counts = obj(source["recordCounts"], "recordCounts");
  const sampler = obj(source["samplerState"], "samplerState");
  const stateInRaw = sampler["stateIn"];
  const stateIn =
    stateInRaw === null
      ? null
      : {
          datasetId: str(obj(stateInRaw, "samplerState.stateIn")["datasetId"], "samplerState.stateIn.datasetId"),
          ...stateObject(stateInRaw, "samplerState.stateIn"),
        };

  const seenSegments = new Set<string>();
  const sourceSegments = arr(source["sourceSegments"], "sourceSegments").map((raw, index) => {
    const at = `sourceSegments[${String(index)}]`;
    const entry = obj(raw, at);
    const segmentId = str(entry["segmentId"], `${at}.segmentId`);
    if (seenSegments.has(segmentId)) bad(`${at}.segmentId is listed twice`, { segmentId });
    seenSegments.add(segmentId);
    const segmentEpoch = str(entry["gatewayEpoch"], `${at}.gatewayEpoch`);
    if (segmentEpoch !== epoch) bad(`${at} belongs to a different gateway epoch`, { segmentId });
    const checksummedByteLength = count(entry["checksummedByteLength"], `${at}.checksummedByteLength`);
    const byteSize = count(entry["byteSize"], `${at}.byteSize`);
    if (checksummedByteLength > byteSize) bad(`${at}.checksummedByteLength exceeds byteSize`, { segmentId });
    return {
      segmentId,
      gatewayEpoch: segmentEpoch,
      segmentIndex: count(entry["segmentIndex"], `${at}.segmentIndex`),
      segmentSha256: digest(entry["segmentSha256"], `${at}.segmentSha256`),
      segmentFileSha256: digest(entry["segmentFileSha256"], `${at}.segmentFileSha256`),
      checksummedByteLength,
      byteSize,
      recordCount: count(entry["recordCount"], `${at}.recordCount`),
      firstIngestSeq: nullableStr(entry["firstIngestSeq"], `${at}.firstIngestSeq`, UINT),
      lastIngestSeq: nullableStr(entry["lastIngestSeq"], `${at}.lastIngestSeq`, UINT),
      minReceivedAt: nullableStr(entry["minReceivedAt"], `${at}.minReceivedAt`, ISO),
      maxReceivedAt: nullableStr(entry["maxReceivedAt"], `${at}.maxReceivedAt`, ISO),
      verification: str(entry["verification"], `${at}.verification`),
      // Required: a manifest that does not inventory its markets cannot be
      // the basis of an expiry (it would read as "names no market").
      marketIdentities: marketIdentities(entry["marketIdentities"], `${at}.marketIdentities`),
    } satisfies ResearchSourceSegment;
  });

  const seenObjects = new Set<string>();
  const objects = arr(source["objects"], "objects").map((raw, index) => {
    const at = `objects[${String(index)}]`;
    const entry = obj(raw, at);
    const objectKey = str(entry["objectKey"], `${at}.objectKey`);
    if (seenObjects.has(objectKey)) bad(`${at}.objectKey is listed twice`, { objectKey });
    seenObjects.add(objectKey);
    const table = str(entry["table"], `${at}.table`);
    if (!(RESEARCH_TABLE_NAMES as readonly string[]).includes(table)) {
      bad(`${at}.table is not a research-tier table`, { table });
    }
    return {
      objectKey,
      table: table as ResearchTableName,
      byteLength: count(entry["byteLength"], `${at}.byteLength`),
      sha256: digest(entry["sha256"], `${at}.sha256`),
      rowCount: count(entry["rowCount"], `${at}.rowCount`),
      firstSampleOrdinal: nullableCount(entry["firstSampleOrdinal"], `${at}.firstSampleOrdinal`),
      lastSampleOrdinal: nullableCount(entry["lastSampleOrdinal"], `${at}.lastSampleOrdinal`),
    } satisfies ResearchObjectEntry;
  });

  const tables = arr(source["tables"], "tables").map((raw, index) => {
    const at = `tables[${String(index)}]`;
    const entry = obj(raw, at);
    const table = str(entry["table"], `${at}.table`);
    if (!(RESEARCH_TABLE_NAMES as readonly string[]).includes(table)) bad(`${at}.table is unknown`, { table });
    const sampleClass = entry["sampleClass"];
    if (sampleClass !== "span" && sampleClass !== "on-change") bad(`${at}.sampleClass is unknown`);
    return {
      table: table as ResearchTableName,
      sampleClass,
      columns: arr(entry["columns"], `${at}.columns`).map((rawColumn, columnIndex) => {
        const columnAt = `${at}.columns[${String(columnIndex)}]`;
        const column = obj(rawColumn, columnAt);
        const nullable = column["nullable"];
        if (typeof nullable !== "boolean") bad(`${columnAt}.nullable must be a boolean`);
        return {
          name: str(column["name"], `${columnAt}.name`),
          physicalType: str(column["physicalType"], `${columnAt}.physicalType`),
          nullable,
        };
      }),
    } satisfies ResearchTableEntry;
  });

  const createdAt = str(source["createdAt"], "createdAt");
  if (!ISO.test(createdAt)) bad("createdAt must be an ISO-8601 instant");
  const codec = str(writer["codec"], "writer.codec");
  if (codec !== "UNCOMPRESSED" && codec !== "SNAPPY") bad("writer.codec is unknown", { codec });

  return {
    datasetManifestFormatId: DATASET_MANIFEST_FORMAT_ID,
    datasetManifestVersion: DATASET_MANIFEST_VERSION,
    fidelity: "approximate",
    datasetId: str(source["datasetId"], "datasetId"),
    createdAt,
    admissibility: str(source["admissibility"], "admissibility"),
    schemaVersions: {
      walFormatId: WAL_FORMAT_ID,
      walSchemaVersion: count(schema["walSchemaVersion"], "schemaVersions.walSchemaVersion"),
      walManifestVersion: count(schema["walManifestVersion"], "schemaVersions.walManifestVersion"),
      researchTierLayoutId: RESEARCH_TIER_LAYOUT_ID,
      researchTierLayoutVersion: RESEARCH_TIER_LAYOUT_VERSION,
      datasetManifestFormatId: str(schema["datasetManifestFormatId"], "schemaVersions.datasetManifestFormatId"),
      datasetManifestVersion: count(schema["datasetManifestVersion"], "schemaVersions.datasetManifestVersion"),
    },
    downsampling: {
      downsamplingId: str(downsampling["downsamplingId"], "downsampling.downsamplingId"),
      downsamplingVersion: count(downsampling["downsamplingVersion"], "downsampling.downsamplingVersion"),
      parameters: parameters as Readonly<Record<string, string | number>>,
      tieOrder: str(downsampling["tieOrder"], "downsampling.tieOrder"),
    },
    writer: {
      library: str(writer["library"], "writer.library"),
      libraryVersion: str(writer["libraryVersion"], "writer.libraryVersion"),
      codec,
      rowGroupSize: count(writer["rowGroupSize"], "writer.rowGroupSize"),
    },
    tables,
    gatewayEpochs: [epoch],
    releaseRange: {
      first: identity(range["first"], "releaseRange.first"),
      last: identity(range["last"], "releaseRange.last"),
    },
    recordCounts: {
      segmentDeclared: count(counts["segmentDeclared"], "recordCounts.segmentDeclared"),
      framesRead: count(counts["framesRead"], "recordCounts.framesRead"),
      framesInterpreted: count(counts["framesInterpreted"], "recordCounts.framesInterpreted"),
      framesUninterpreted: count(counts["framesUninterpreted"], "recordCounts.framesUninterpreted"),
      samplesWritten: count(counts["samplesWritten"], "recordCounts.samplesWritten"),
    },
    samplerState: { stateIn, stateOut: stateObject(sampler["stateOut"], "samplerState.stateOut") },
    sourceSegments,
    objects,
  };
}

/** Either class of dataset manifest, as read. */
export type AnyDatasetManifest =
  | { readonly fidelity: "exact"; readonly manifest: DatasetManifest }
  | { readonly fidelity: "approximate"; readonly manifest: ResearchTierManifest };

/**
 * The storage-parquet dataset-manifest reader for **either** class: version 1
 * (read as exact), version 2 exact, and version 2 approximate (ADR-029
 * Consequences: every reader accepts both versions before any version 2
 * manifest is written). Refuses a version 2 document without `fidelity`, an
 * unknown fidelity, a version 1 document that carries one, and any unknown
 * format or version.
 */
export function parseAnyDatasetManifest(value: unknown): AnyDatasetManifest {
  const fidelity = readDatasetManifestFidelity(value);
  return fidelity === "exact"
    ? { fidelity, manifest: parseDatasetManifest(value) }
    : { fidelity, manifest: parseResearchTierManifest(value) };
}
