/**
 * The dataset-manifest door, and the §12.5 run pin set.
 *
 * ADR-004 §5, quoted by `WP-130`: "**Replay consumes the manifest, not a
 * directory listing.**" Handoff §8.4: "Dataset manifests include all segment
 * checksums, gateway epochs, event ranges, and excluded data-quality windows."
 * §12.5 then lists what "every replay run pins", which is a strictly larger set
 * than a compactor can know — the manifest's own `replayPins` section marks the
 * run-scoped entries `null` with a stated owner (ADR-017; `WP-130`).
 *
 * This module is that door. It is a WIRE-DATA boundary in the ADR-020 §4 sense:
 * the bytes come from an archive, not from a caller in the same function. So:
 *
 * - the bytes are read under the ADR-017 §3 strict-JSON profile by
 *   {@link ./strict-json.js}, which builds a prototype-free tree as it parses
 *   (D1 — there is no library output to adopt from, and no `JSON.parse` result
 *   whose `__proto__` member could reach anything);
 * - every field is validated by the hand-written total predicates in
 *   {@link ./grammar.js} (no runtime schema library, so there is no
 *   `skipChecks` / `optin` / `optout` / `when` slot to inherit — ADR-020 §1);
 * - every value is taken from the materialized tree (D3 by construction);
 * - the emitted `ReplayDataset` is prototype-free and deep-frozen (D4).
 *
 * The manifest is read STRICTLY: an unknown key is refused rather than ignored.
 * That is safe precisely because the format is versioned — `datasetManifestVersion`
 * is pinned below, so a future field arrives with a version this build refuses
 * by name instead of silently ignoring.
 */

import {
  isCanonicalUuid,
  isCodeString,
  isIsoTimestamp,
  isNonEmptyString,
  isNonNegativeInteger,
  isSha256Hex,
  isUnsignedIntegerString,
  isRecord,
  readField,
  recordKeys,
} from "./grammar.js";
import { ownFrozenTree } from "./plain.js";
import {
  simulationFailure,
  simulationOk,
  totally,
  type SimulationResult,
} from "./refusals.js";
import { parseStrictJsonBytes, parseStrictJsonText } from "./strict-json.js";

/** The dataset-manifest format this build replays (`WP-130` `constants.ts`). */
export const SUPPORTED_DATASET_MANIFEST_FORMAT_ID = "polymarket-bot/dataset-manifest/v1";
/** The dataset-manifest version this build replays. */
export const SUPPORTED_DATASET_MANIFEST_VERSION = 1;
/** The Parquet row layout this build's decoders read. */
export const SUPPORTED_PARQUET_LAYOUT_ID = "polymarket-bot/parquet-raw-frames/v1";
/** The WAL format whose frames the archived rows carry. */
export const SUPPORTED_WAL_FORMAT_ID = "polymarket-bot/wal/v1";

// ---------------------------------------------------------------------------
// The narrow view replay consumes
// ---------------------------------------------------------------------------

/** §12.5 "start/end event identity". */
export interface ReplayEventIdentity {
  readonly gatewayEpoch: string;
  readonly ingestSeq: string;
  readonly receivedAt: string;
  readonly datasetRowOrdinal: number;
}

/** One WAL segment the dataset pins (§8.4 "all segment checksums"). */
export interface ReplaySegmentPin {
  readonly segmentId: string;
  readonly gatewayEpoch: string;
  readonly segmentIndex: number;
  /** WAL-chain digest of the checksummed span (ADR-017 §1). */
  readonly segmentSha256: string;
  /** Whole-file digest, footer included (ADR-017 §1). */
  readonly segmentFileSha256: string;
  readonly byteSize: number;
  readonly recordCount: number;
  readonly firstIngestSeq: string | null;
  readonly lastIngestSeq: string | null;
  readonly objectKey: string;
  readonly firstDatasetRowOrdinal: number | null;
  readonly lastDatasetRowOrdinal: number | null;
}

/** One archived object the dataset pins. */
export interface ReplayObjectPin {
  readonly objectKey: string;
  readonly byteLength: number;
  /** SHA-256 of the object AS READ BACK from the store (`WP-130`). */
  readonly sha256: string;
  readonly rowCount: number;
  readonly replayEligibleRowCount: number;
  readonly firstDatasetRowOrdinal: number | null;
  readonly lastDatasetRowOrdinal: number | null;
  readonly segmentIds: readonly string[];
}

/** An excluded data-quality window (§8.4), in `(epoch, ingestSeq)` identity. */
export interface ReplayExcludedWindow {
  readonly incidentId: string;
  readonly kind: string;
  readonly gatewayEpoch: string;
  readonly fromIngestSeq: string;
  readonly toIngestSeq: string;
  /** Wall-clock bounds, "for an operator" (`WP-130`); never used for membership. */
  readonly openedAt: string;
  readonly closedAt: string | null;
  readonly excludedRecordCount: number;
  readonly excludedSegmentIds: readonly string[];
  readonly reason: string;
}

/** The manifest's own reconciliation counts. */
export interface ReplayRecordCounts {
  readonly segmentDeclared: number;
  readonly segmentRead: number;
  readonly written: number;
  readonly replayEligible: number;
  readonly excludedByIncident: number;
  readonly excludedAsDuplicate: number;
}

/** The manifest's run-scoped §12.5 pins; `null` means "not pinned yet". */
export interface ReplayManifestPins {
  readonly normalizerVersion: string | null;
  readonly featureSetVersion: string | null;
  readonly runSeed: string | null;
  readonly fillModelVersion: string | null;
  readonly latencyModelVersion: string | null;
  readonly feeSnapshotVersion: string | null;
  readonly rewardSnapshotVersion: string | null;
  readonly settlementSpecVersions: readonly string[];
}

/** The part of a `WP-130` dataset manifest a replay reads. Prototype-free. */
export interface ReplayDataset {
  readonly datasetId: string;
  readonly datasetManifestFormatId: string;
  readonly datasetManifestVersion: number;
  readonly walFormatId: string;
  readonly parquetLayoutId: string;
  readonly parquetLayoutVersion: number;
  /**
   * Exactly ONE epoch.
   *
   * `docs/contracts/wal-format.md` §12.1 (GOV-1C item 5) rules that epochs are
   * identity, not chronology; a compaction batch is single-epoch and the
   * shipped `CrossEpochOrderError` refusal is ratified. A dataset naming two
   * epochs would need a cross-epoch order this repository does not define, so
   * it is refused here rather than ordered by guesswork.
   */
  readonly gatewayEpoch: string;
  readonly firstEvent: ReplayEventIdentity | null;
  readonly lastEvent: ReplayEventIdentity | null;
  readonly recordCounts: ReplayRecordCounts;
  readonly duplicatePolicy: string;
  readonly duplicateRecordCount: number;
  readonly segments: readonly ReplaySegmentPin[];
  readonly objects: readonly ReplayObjectPin[];
  readonly excludedWindows: readonly ReplayExcludedWindow[];
  readonly excludedSegmentIds: readonly string[];
  readonly pins: ReplayManifestPins;
  readonly walRetentionPolicy: string;
}

// ---------------------------------------------------------------------------
// The door
// ---------------------------------------------------------------------------

const MANIFEST_KEYS: readonly string[] = [
  "datasetManifestFormatId",
  "datasetManifestVersion",
  "datasetId",
  "createdAt",
  "schemaVersions",
  "writer",
  "columns",
  "replayPins",
  "gatewayEpochs",
  "eventRange",
  "recordCounts",
  "deduplication",
  "segments",
  "objects",
  "excludedSegments",
  "excludedIncidentWindows",
  "walRetentionPolicy",
];

function invalid(message: string, details?: Readonly<Record<string, unknown>>): SimulationResult<never> {
  return simulationFailure("REPLAY_MANIFEST_INVALID", message, details);
}

function requireStrictKeys(
  tree: unknown,
  what: string,
  expected: readonly string[],
): SimulationResult<null> {
  if (!isRecord(tree)) return invalid(`${what} must be a JSON object`);
  const observed = recordKeys(tree);
  for (const key of observed) {
    if (!expected.includes(key)) {
      return invalid(
        `${what} carries an unknown key ${JSON.stringify(key)}; a checksummed artifact is read strictly, and a new field is a manifest-version change`,
        { key, what },
      );
    }
  }
  for (const key of expected) {
    if (!observed.includes(key)) {
      return invalid(`${what} is missing ${JSON.stringify(key)}`, { key, what });
    }
  }
  return simulationOk(null);
}

/** Parses dataset-manifest BYTES. The primary entry: replay reads bytes. */
export function readDatasetManifestBytes(bytes: Uint8Array): SimulationResult<ReplayDataset> {
  return totally("reading the dataset manifest", () => {
    const parsed = parseStrictJsonBytes(bytes);
    if (!parsed.ok) {
      return simulationFailure(
        "REPLAY_MANIFEST_NOT_STRICT_JSON",
        `the dataset manifest is not in the ADR-017 §3 strict-JSON profile: ${parsed.problem.problem}`,
        { at: parsed.problem.at },
      );
    }
    return validateDatasetManifest(parsed.value);
  });
}

/** Parses a dataset-manifest DOCUMENT already decoded to text. */
export function readDatasetManifestText(text: string): SimulationResult<ReplayDataset> {
  return totally("reading the dataset manifest", () => {
    const parsed = parseStrictJsonText(text);
    if (!parsed.ok) {
      return simulationFailure(
        "REPLAY_MANIFEST_NOT_STRICT_JSON",
        `the dataset manifest is not in the ADR-017 §3 strict-JSON profile: ${parsed.problem.problem}`,
        { at: parsed.problem.at },
      );
    }
    return validateDatasetManifest(parsed.value);
  });
}

function validateDatasetManifest(tree: unknown): SimulationResult<ReplayDataset> {
  const keys = requireStrictKeys(tree, "the dataset manifest", MANIFEST_KEYS);
  if (!keys.ok) return keys;

  const formatId = readField(tree, "datasetManifestFormatId");
  const version = readField(tree, "datasetManifestVersion");
  if (formatId !== SUPPORTED_DATASET_MANIFEST_FORMAT_ID || version !== SUPPORTED_DATASET_MANIFEST_VERSION) {
    return simulationFailure(
      "REPLAY_MANIFEST_UNSUPPORTED",
      "the dataset manifest names a format this build does not replay",
      {
        observedFormatId: typeof formatId === "string" ? formatId : "(not a string)",
        observedVersion: typeof version === "number" ? version : -1,
        supportedFormatId: SUPPORTED_DATASET_MANIFEST_FORMAT_ID,
        supportedVersion: SUPPORTED_DATASET_MANIFEST_VERSION,
      },
    );
  }

  const datasetId = readField(tree, "datasetId");
  if (!isNonEmptyString(datasetId)) return invalid("datasetId must be a bounded non-empty string");

  const createdAt = readField(tree, "createdAt");
  if (!isIsoTimestamp(createdAt)) return invalid("createdAt must be an ISO-8601 timestamp");

  const schema = readField(tree, "schemaVersions");
  if (!isRecord(schema)) return invalid("schemaVersions must be a JSON object");
  const walFormatId = readField(schema, "walFormatId");
  const parquetLayoutId = readField(schema, "parquetLayoutId");
  const parquetLayoutVersion = readField(schema, "parquetLayoutVersion");
  if (walFormatId !== SUPPORTED_WAL_FORMAT_ID) {
    return simulationFailure(
      "REPLAY_MANIFEST_UNSUPPORTED",
      "the dataset pins a WAL format this build does not read",
      { observed: typeof walFormatId === "string" ? walFormatId : "(not a string)" },
    );
  }
  if (parquetLayoutId !== SUPPORTED_PARQUET_LAYOUT_ID || parquetLayoutVersion !== 1) {
    return simulationFailure(
      "REPLAY_MANIFEST_UNSUPPORTED",
      "the dataset pins a Parquet row layout this build does not read",
      {
        observedId: typeof parquetLayoutId === "string" ? parquetLayoutId : "(not a string)",
        observedVersion: typeof parquetLayoutVersion === "number" ? parquetLayoutVersion : -1,
      },
    );
  }

  const epochs = readField(tree, "gatewayEpochs");
  if (!Array.isArray(epochs)) return invalid("gatewayEpochs must be an array");
  if (epochs.length !== 1) {
    return simulationFailure(
      "REPLAY_CROSS_EPOCH_CHRONOLOGY_UNDEFINED",
      "the dataset names " +
        (epochs.length === 0 ? "no gateway epoch" : `${String(epochs.length)} gateway epochs`) +
        "; docs/contracts/wal-format.md §12.1 rules that epochs are identity, not chronology, " +
        "so replay has no defined order across them and refuses rather than inventing one",
      { gatewayEpochCount: epochs.length },
    );
  }
  const gatewayEpoch = epochs[0];
  if (!isCanonicalUuid(gatewayEpoch)) {
    return invalid("gatewayEpochs[0] must be a canonical lowercase UUID (§7.1)");
  }

  const eventRange = readField(tree, "eventRange");
  if (!isRecord(eventRange)) return invalid("eventRange must be a JSON object");
  const first = readIdentity(readField(eventRange, "first"), "eventRange.first");
  if (!first.ok) return first;
  const last = readIdentity(readField(eventRange, "last"), "eventRange.last");
  if (!last.ok) return last;

  const counts = readCounts(readField(tree, "recordCounts"));
  if (!counts.ok) return counts;

  const dedup = readField(tree, "deduplication");
  if (!isRecord(dedup)) return invalid("deduplication must be a JSON object");
  const duplicatePolicy = readField(dedup, "policy");
  if (!isNonEmptyString(duplicatePolicy)) return invalid("deduplication.policy must be a string");
  const duplicateRecordCount = readField(dedup, "duplicateRecordCount");
  if (!isNonNegativeInteger(duplicateRecordCount)) {
    return invalid("deduplication.duplicateRecordCount must be a non-negative integer");
  }

  const segments = readSegments(readField(tree, "segments"), gatewayEpoch);
  if (!segments.ok) return segments;

  const objects = readObjects(readField(tree, "objects"));
  if (!objects.ok) return objects;

  const windows = readWindows(readField(tree, "excludedIncidentWindows"));
  if (!windows.ok) return windows;

  const excludedSegments = readField(tree, "excludedSegments");
  if (!Array.isArray(excludedSegments)) return invalid("excludedSegments must be an array");
  const excludedSegmentIds: string[] = [];
  for (const entry of excludedSegments) {
    const segmentId = readField(entry, "segmentId");
    if (!isNonEmptyString(segmentId)) return invalid("excludedSegments[].segmentId must be a string");
    excludedSegmentIds.push(segmentId);
  }

  const pins = readPins(readField(tree, "replayPins"));
  if (!pins.ok) return pins;

  const retention = readField(tree, "walRetentionPolicy");
  if (!isNonEmptyString(retention)) return invalid("walRetentionPolicy must be a string");

  return simulationOk(
    ownFrozenTree<ReplayDataset>({
      datasetId,
      datasetManifestFormatId: SUPPORTED_DATASET_MANIFEST_FORMAT_ID,
      datasetManifestVersion: SUPPORTED_DATASET_MANIFEST_VERSION,
      walFormatId: SUPPORTED_WAL_FORMAT_ID,
      parquetLayoutId: SUPPORTED_PARQUET_LAYOUT_ID,
      parquetLayoutVersion: 1,
      gatewayEpoch,
      firstEvent: first.value,
      lastEvent: last.value,
      recordCounts: counts.value,
      duplicatePolicy,
      duplicateRecordCount,
      segments: segments.value,
      objects: objects.value,
      excludedWindows: windows.value,
      excludedSegmentIds,
      pins: pins.value,
      walRetentionPolicy: retention,
    }),
  );
}

function readIdentity(
  value: unknown,
  what: string,
): SimulationResult<ReplayEventIdentity | null> {
  if (value === null) return simulationOk(null);
  if (!isRecord(value)) return invalid(`${what} must be a JSON object or null`);
  const gatewayEpoch = readField(value, "gatewayEpoch");
  const ingestSeq = readField(value, "ingestSeq");
  const receivedAt = readField(value, "receivedAt");
  const datasetRowOrdinal = readField(value, "datasetRowOrdinal");
  if (!isCanonicalUuid(gatewayEpoch)) return invalid(`${what}.gatewayEpoch must be a UUID`);
  if (!isUnsignedIntegerString(ingestSeq)) {
    return invalid(`${what}.ingestSeq must be a canonical unsigned integer string`);
  }
  if (!isIsoTimestamp(receivedAt)) return invalid(`${what}.receivedAt must be an ISO-8601 timestamp`);
  if (!isNonNegativeInteger(datasetRowOrdinal)) {
    return invalid(`${what}.datasetRowOrdinal must be a non-negative integer`);
  }
  return simulationOk({ gatewayEpoch, ingestSeq, receivedAt, datasetRowOrdinal });
}

function readCounts(value: unknown): SimulationResult<ReplayRecordCounts> {
  if (!isRecord(value)) return invalid("recordCounts must be a JSON object");
  const names = [
    "segmentDeclared",
    "segmentRead",
    "written",
    "replayEligible",
    "excludedByIncident",
    "excludedAsDuplicate",
  ] as const;
  const out: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const name of names) {
    const member = readField(value, name);
    if (!isNonNegativeInteger(member)) {
      return invalid(`recordCounts.${name} must be a non-negative integer`);
    }
    out[name] = member;
  }
  const counts = out as unknown as ReplayRecordCounts;
  // The manifest's own arithmetic, checked here so a corrupted manifest is
  // refused before it is used as a reconciliation oracle.
  if (
    counts.replayEligible + counts.excludedByIncident + counts.excludedAsDuplicate !==
    counts.written
  ) {
    return invalid(
      "recordCounts do not balance: replayEligible + excludedByIncident + excludedAsDuplicate must equal written",
      {
        written: counts.written,
        replayEligible: counts.replayEligible,
        excludedByIncident: counts.excludedByIncident,
        excludedAsDuplicate: counts.excludedAsDuplicate,
      },
    );
  }
  return simulationOk(counts);
}

function readSegments(
  value: unknown,
  gatewayEpoch: string,
): SimulationResult<readonly ReplaySegmentPin[]> {
  if (!Array.isArray(value)) return invalid("segments must be an array");
  const out: ReplaySegmentPin[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    const at = `segments[${String(index)}]`;
    if (!isRecord(entry)) return invalid(`${at} must be a JSON object`);
    const segmentId = readField(entry, "segmentId");
    if (!isNonEmptyString(segmentId)) return invalid(`${at}.segmentId must be a string`);
    if (seen.has(segmentId)) return invalid(`${at}.segmentId is listed twice`, { segmentId });
    seen.add(segmentId);
    const entryEpoch = readField(entry, "gatewayEpoch");
    if (entryEpoch !== gatewayEpoch) {
      return simulationFailure(
        "REPLAY_CROSS_EPOCH_CHRONOLOGY_UNDEFINED",
        `${at}.gatewayEpoch differs from the dataset's single epoch; wal-format.md §12.1 defines no cross-epoch order`,
        { segmentId },
      );
    }
    const segmentIndex = readField(entry, "segmentIndex");
    if (!isNonNegativeInteger(segmentIndex)) return invalid(`${at}.segmentIndex must be an integer`);
    const segmentSha256 = readField(entry, "segmentSha256");
    if (!isSha256Hex(segmentSha256)) return invalid(`${at}.segmentSha256 must be 64 lowercase hex`);
    const segmentFileSha256 = readField(entry, "segmentFileSha256");
    if (!isSha256Hex(segmentFileSha256)) {
      return invalid(`${at}.segmentFileSha256 must be 64 lowercase hex`);
    }
    const byteSize = readField(entry, "byteSize");
    if (!isNonNegativeInteger(byteSize)) return invalid(`${at}.byteSize must be an integer`);
    const recordCount = readField(entry, "recordCount");
    if (!isNonNegativeInteger(recordCount)) return invalid(`${at}.recordCount must be an integer`);
    const firstIngestSeq = readNullableUnsignedInteger(entry, "firstIngestSeq");
    if (firstIngestSeq === undefined) return invalid(`${at}.firstIngestSeq must be a uint string or null`);
    const lastIngestSeq = readNullableUnsignedInteger(entry, "lastIngestSeq");
    if (lastIngestSeq === undefined) return invalid(`${at}.lastIngestSeq must be a uint string or null`);
    const objectKey = readField(entry, "objectKey");
    if (!isNonEmptyString(objectKey)) return invalid(`${at}.objectKey must be a string`);
    const firstOrdinal = readNullableOrdinal(entry, "firstDatasetRowOrdinal");
    if (firstOrdinal === undefined) return invalid(`${at}.firstDatasetRowOrdinal must be an integer or null`);
    const lastOrdinal = readNullableOrdinal(entry, "lastDatasetRowOrdinal");
    if (lastOrdinal === undefined) return invalid(`${at}.lastDatasetRowOrdinal must be an integer or null`);
    out.push({
      segmentId,
      gatewayEpoch,
      segmentIndex,
      segmentSha256,
      segmentFileSha256,
      byteSize,
      recordCount,
      firstIngestSeq,
      lastIngestSeq,
      objectKey,
      firstDatasetRowOrdinal: firstOrdinal,
      lastDatasetRowOrdinal: lastOrdinal,
    });
  }
  return simulationOk(out);
}

function readNullableUnsignedInteger(entry: unknown, key: string): string | null | undefined {
  const value = readField(entry, key);
  if (value === null) return null;
  return isUnsignedIntegerString(value) ? value : undefined;
}

function readNullableOrdinal(entry: unknown, key: string): number | null | undefined {
  const value = readField(entry, key);
  if (value === null) return null;
  return isNonNegativeInteger(value) ? value : undefined;
}

function readObjects(value: unknown): SimulationResult<readonly ReplayObjectPin[]> {
  if (!Array.isArray(value)) return invalid("objects must be an array");
  const out: ReplayObjectPin[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    const at = `objects[${String(index)}]`;
    if (!isRecord(entry)) return invalid(`${at} must be a JSON object`);
    const objectKey = readField(entry, "objectKey");
    if (!isNonEmptyString(objectKey)) return invalid(`${at}.objectKey must be a string`);
    if (seen.has(objectKey)) return invalid(`${at}.objectKey is listed twice`, { objectKey });
    seen.add(objectKey);
    const byteLength = readField(entry, "byteLength");
    if (!isNonNegativeInteger(byteLength)) return invalid(`${at}.byteLength must be an integer`);
    const sha256 = readField(entry, "sha256");
    if (!isSha256Hex(sha256)) return invalid(`${at}.sha256 must be 64 lowercase hex`);
    const rowCount = readField(entry, "rowCount");
    if (!isNonNegativeInteger(rowCount)) return invalid(`${at}.rowCount must be an integer`);
    const replayEligibleRowCount = readField(entry, "replayEligibleRowCount");
    if (!isNonNegativeInteger(replayEligibleRowCount)) {
      return invalid(`${at}.replayEligibleRowCount must be an integer`);
    }
    if (replayEligibleRowCount > rowCount) {
      return invalid(`${at}.replayEligibleRowCount exceeds its own rowCount`, { objectKey });
    }
    const firstOrdinal = readNullableOrdinal(entry, "firstDatasetRowOrdinal");
    if (firstOrdinal === undefined) return invalid(`${at}.firstDatasetRowOrdinal must be an integer or null`);
    const lastOrdinal = readNullableOrdinal(entry, "lastDatasetRowOrdinal");
    if (lastOrdinal === undefined) return invalid(`${at}.lastDatasetRowOrdinal must be an integer or null`);
    const segmentIds = readField(entry, "segmentIds");
    if (!Array.isArray(segmentIds)) return invalid(`${at}.segmentIds must be an array`);
    const ids: string[] = [];
    for (const id of segmentIds) {
      if (!isNonEmptyString(id)) return invalid(`${at}.segmentIds[] must be strings`);
      ids.push(id);
    }
    out.push({
      objectKey,
      byteLength,
      sha256,
      rowCount,
      replayEligibleRowCount,
      firstDatasetRowOrdinal: firstOrdinal,
      lastDatasetRowOrdinal: lastOrdinal,
      segmentIds: ids,
    });
  }
  return simulationOk(out);
}

function readWindows(value: unknown): SimulationResult<readonly ReplayExcludedWindow[]> {
  if (!Array.isArray(value)) return invalid("excludedIncidentWindows must be an array");
  const out: ReplayExcludedWindow[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    const at = `excludedIncidentWindows[${String(index)}]`;
    if (!isRecord(entry)) return invalid(`${at} must be a JSON object`);
    const window = readField(entry, "window");
    if (!isRecord(window)) return invalid(`${at}.window must be a JSON object`);
    const incidentId = readField(window, "incidentId");
    if (!isNonEmptyString(incidentId)) return invalid(`${at}.window.incidentId must be a string`);
    const kind = readField(window, "kind");
    if (!isNonEmptyString(kind)) return invalid(`${at}.window.kind must be a string`);
    const windowEpoch = readField(window, "gatewayEpoch");
    if (!isCanonicalUuid(windowEpoch)) return invalid(`${at}.window.gatewayEpoch must be a UUID`);
    const fromIngestSeq = readField(window, "fromIngestSeq");
    const toIngestSeq = readField(window, "toIngestSeq");
    if (!isUnsignedIntegerString(fromIngestSeq) || !isUnsignedIntegerString(toIngestSeq)) {
      return invalid(`${at}.window bounds must be canonical unsigned integer strings`);
    }
    if (BigInt(fromIngestSeq) > BigInt(toIngestSeq)) {
      return invalid(`${at}.window is inverted`, { incidentId });
    }
    const openedAt = readField(window, "openedAt");
    if (!isIsoTimestamp(openedAt)) return invalid(`${at}.window.openedAt must be ISO-8601`);
    const closedAtRaw = readField(window, "closedAt");
    if (closedAtRaw !== null && !isIsoTimestamp(closedAtRaw)) {
      return invalid(`${at}.window.closedAt must be ISO-8601 or null`);
    }
    const closedAt = closedAtRaw === null ? null : (closedAtRaw as string);
    const reason = readField(window, "reason");
    if (typeof reason !== "string") {
      return invalid(`${at}.window.reason must be a string`);
    }
    const excludedRecordCount = readField(entry, "excludedRecordCount");
    if (!isNonNegativeInteger(excludedRecordCount)) {
      return invalid(`${at}.excludedRecordCount must be a non-negative integer`);
    }
    const excludedSegmentIds = readField(entry, "excludedSegmentIds");
    if (!Array.isArray(excludedSegmentIds)) return invalid(`${at}.excludedSegmentIds must be an array`);
    const ids: string[] = [];
    for (const id of excludedSegmentIds) {
      if (!isNonEmptyString(id)) return invalid(`${at}.excludedSegmentIds[] must be strings`);
      ids.push(id);
    }
    out.push({
      incidentId,
      kind,
      gatewayEpoch: windowEpoch,
      fromIngestSeq,
      toIngestSeq,
      openedAt,
      closedAt,
      excludedRecordCount,
      excludedSegmentIds: ids,
      reason,
    });
  }
  return simulationOk(out);
}

function readPins(value: unknown): SimulationResult<ReplayManifestPins> {
  if (!isRecord(value)) return invalid("replayPins must be a JSON object");
  const scalarNames = [
    "normalizerVersion",
    "featureSetVersion",
    "runSeed",
    "fillModelVersion",
    "latencyModelVersion",
    "feeSnapshotVersion",
    "rewardSnapshotVersion",
  ] as const;
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const name of scalarNames) {
    const member = readField(value, name);
    if (member === null) {
      out[name] = null;
      continue;
    }
    if (!isNonEmptyString(member)) {
      return invalid(`replayPins.${name} must be a bounded non-empty string or null`);
    }
    out[name] = member;
  }
  const settlementSpecVersions = readField(value, "settlementSpecVersions");
  if (!Array.isArray(settlementSpecVersions)) {
    return invalid("replayPins.settlementSpecVersions must be an array");
  }
  const versions: string[] = [];
  for (const version of settlementSpecVersions) {
    if (!isNonEmptyString(version)) {
      return invalid("replayPins.settlementSpecVersions[] must be strings");
    }
    versions.push(version);
  }
  out["settlementSpecVersions"] = versions;
  return simulationOk(out as unknown as ReplayManifestPins);
}

// ---------------------------------------------------------------------------
// The run manifest: the §12.5 pins a compactor cannot know
// ---------------------------------------------------------------------------

/**
 * The run-scoped half of the §12.5 pin list.
 *
 * ADR-012 §4: "A result whose fill-model parameters are not pinned is not
 * reproducible and is not evidence of anything." Every field here is REQUIRED —
 * this record is what makes a replay result citable, so there is no default and
 * no optional member. When the dataset manifest already carries a non-null pin,
 * {@link reconcileRunPins} refuses a run that contradicts it.
 */
export interface ReplayRunPins {
  readonly normalizerVersion: string;
  readonly featureSetVersion: string;
  /** §12.5 "run seed"; a canonical unsigned integer string. */
  readonly runSeed: string;
  readonly fillModelVersion: string;
  /** Content hash of the fill-model parameters, computed by the caller. */
  readonly fillModelParametersHash: string;
  readonly latencyModelVersion: string;
  readonly latencyModelParametersHash: string;
  readonly feeSnapshotVersion: string;
  readonly rewardSnapshotVersion: string;
  readonly settlementSpecVersions: readonly string[];
  /** Identity of the code that produced the run (§12.4 "code commit"). */
  readonly simulatorVersion: string;
}

const RUN_PIN_STRING_FIELDS: readonly (keyof ReplayRunPins)[] = [
  "normalizerVersion",
  "featureSetVersion",
  "fillModelVersion",
  "fillModelParametersHash",
  "latencyModelVersion",
  "latencyModelParametersHash",
  "feeSnapshotVersion",
  "rewardSnapshotVersion",
  "simulatorVersion",
];

/** Every key a §12.5 run pin set may carry. Nothing else crosses this door. */
const RUN_PIN_KEYS: readonly string[] = [...RUN_PIN_STRING_FIELDS, "runSeed", "settlementSpecVersions"];

/**
 * Validates a run pin set, prototype-free in and out.
 *
 * STRICT: an unknown key is refused, not carried. The manifest door two hundred
 * lines above this one already refuses unknown keys, and these pins are the same
 * kind of thing — the §12.5 record a run is cited by. A pin set that quietly
 * carried an extra field would let a caller believe something was pinned that
 * nothing reads (round-1 review L6).
 */
export function readRunPins(value: unknown): SimulationResult<ReplayRunPins> {
  return totally("reading the run pins", () => {
    if (!isRecord(value)) {
      return simulationFailure("SIMULATION_INPUT_INVALID", "the run pins must be a record");
    }
    for (const key of recordKeys(value)) {
      if (!RUN_PIN_KEYS.includes(key)) {
        return simulationFailure(
          "REPLAY_MANIFEST_INVALID",
          `the run pins carry an unknown key ${JSON.stringify(key)}; §12.5 fixes what a run pins and this door does not pass anything else through`,
          { key },
        );
      }
    }
    for (const field of RUN_PIN_STRING_FIELDS) {
      const member = readField(value, field);
      if (!isNonEmptyString(member)) {
        return simulationFailure(
          "REPLAY_MANIFEST_PIN_MISSING",
          `the §12.5 run pin ${String(field)} is absent; ADR-012 §4 makes an unpinned result not evidence of anything`,
          { pin: String(field) },
        );
      }
    }
    const runSeed = readField(value, "runSeed");
    if (!isUnsignedIntegerString(runSeed, 40)) {
      return simulationFailure(
        "REPLAY_MANIFEST_PIN_MISSING",
        "the §12.5 run pin runSeed must be a canonical unsigned integer string",
      );
    }
    const settlementSpecVersions = readField(value, "settlementSpecVersions");
    if (!Array.isArray(settlementSpecVersions)) {
      return simulationFailure(
        "REPLAY_MANIFEST_PIN_MISSING",
        "the §12.5 run pin settlementSpecVersions must be an array (possibly empty)",
      );
    }
    for (const version of settlementSpecVersions) {
      if (!isCodeString(version) && !isNonEmptyString(version)) {
        return simulationFailure(
          "REPLAY_MANIFEST_PIN_MISSING",
          "settlementSpecVersions[] must be bounded non-empty strings",
        );
      }
    }
    return simulationOk(ownFrozenTree<ReplayRunPins>(value as unknown as ReplayRunPins));
  });
}

/**
 * Refuses a run whose pins contradict the dataset's own non-null pins.
 *
 * §6 invariant 9: "Historical runs use historical parameters." A dataset that
 * already recorded, say, its normalizer version is authoritative for it; a run
 * that normalizes with a different version is producing a different dataset and
 * says so.
 */
export function reconcileRunPins(
  dataset: ReplayDataset,
  run: ReplayRunPins,
): SimulationResult<ReplayRunPins> {
  if (dataset === null || typeof dataset !== "object" || !isRecord(dataset.pins)) {
    return simulationFailure(
      "REPLAY_MANIFEST_INVALID",
      "run pins are reconciled against a dataset manifest that carries its own pins (§12.5)",
    );
  }
  if (run === null || typeof run !== "object") {
    return simulationFailure(
      "REPLAY_MANIFEST_PIN_MISSING",
      "a run pin set is a record (§12.5)",
    );
  }
  const checks: readonly (readonly [string, string | null, string])[] = [
    ["normalizerVersion", dataset.pins.normalizerVersion, run.normalizerVersion],
    ["featureSetVersion", dataset.pins.featureSetVersion, run.featureSetVersion],
    ["runSeed", dataset.pins.runSeed, run.runSeed],
    ["fillModelVersion", dataset.pins.fillModelVersion, run.fillModelVersion],
    ["latencyModelVersion", dataset.pins.latencyModelVersion, run.latencyModelVersion],
    ["feeSnapshotVersion", dataset.pins.feeSnapshotVersion, run.feeSnapshotVersion],
    ["rewardSnapshotVersion", dataset.pins.rewardSnapshotVersion, run.rewardSnapshotVersion],
  ];
  for (const [name, pinned, offered] of checks) {
    if (pinned !== null && pinned !== offered) {
      return simulationFailure(
        "REPLAY_MANIFEST_PIN_MISMATCH",
        `the dataset pins ${name}=${JSON.stringify(pinned)} and the run offers ${JSON.stringify(offered)}; ` +
          "§6 invariant 9 requires historical runs to use historical parameters",
        { pin: name, pinned, offered },
      );
    }
  }
  if (dataset.pins.settlementSpecVersions.length > 0) {
    const pinned = [...dataset.pins.settlementSpecVersions].sort();
    const offered = [...run.settlementSpecVersions].sort();
    if (pinned.length !== offered.length || pinned.some((value, index) => value !== offered[index])) {
      return simulationFailure(
        "REPLAY_MANIFEST_PIN_MISMATCH",
        "the dataset pins a settlement-spec version set the run does not offer",
        { pinnedCount: pinned.length, offeredCount: offered.length },
      );
    }
  }
  return simulationOk(run);
}
