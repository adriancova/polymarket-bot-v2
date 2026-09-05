/**
 * The dataset event source (handoff §8.4, §12.1, §12.5).
 *
 * §8.4, verbatim: "Replay consumes the same normalized event envelopes in the
 * **exact recorded dispatch order**. It must not sort solely by venue
 * timestamp." §6 invariant 15 states the same rule from the other side: replay
 * "must not use future venue timestamps unavailable to the live process."
 *
 * ## What "dispatch order" is here, and why nothing else is consulted
 *
 * The archive records a dense `datasetRowOrdinal` per row — "dense dispatch-order
 * ordinal across the whole dataset (§8.4)" (`WP-130` `parquet-layout.ts`). That
 * ordinal, and only that ordinal, orders this source. There is no comparator in
 * this file that reads `venueTimestamp`, `receivedAt`, or any epoch identifier;
 * `test/unit/simulation/dispatch-order.test.ts` replays a fixture where venue
 * time and dispatch order DISAGREE and pins that the two orders differ, so the
 * choice is load-bearing rather than incidental.
 *
 * The one ordering invariant this source ENFORCES is the one the recording
 * guarantees: within a gateway epoch, `ingestSeq` is monotonic (§7.1), so among
 * REPLAY-ELIGIBLE rows in ordinal order it must be strictly increasing.
 * (Duplicate rows repeat an earlier `ingestSeq` by construction — that is what
 * makes them duplicates — so the invariant is stated over eligible rows.)
 *
 * ## Cross-epoch chronology
 *
 * `docs/contracts/wal-format.md` §12.1, ruled 2026-09-02 by `GOV-1C` item 5:
 * **epochs are identity, not chronology.** A compaction batch is single-epoch;
 * epoch-id bits, lexical order, wall clocks, and file listings may NOT be used
 * as chronology. This source therefore refuses a dataset naming more than one
 * epoch ({@link ./manifest.js}) rather than deriving an order across them, and
 * refuses a row whose epoch is not the dataset's.
 *
 * ## Nothing is skipped in silence
 *
 * §8.3: "Dropping trading or raw market events silently is forbidden." So every
 * row this source does not deliver must be JUSTIFIED by the manifest:
 *
 * - a missing ordinal is `REPLAY_ORDINAL_GAP`, never a shorter stream;
 * - an ineligible row whose `exclusionReason` is not backed by a manifest-declared
 *   incident window or duplicate is `REPLAY_EXCLUSION_UNDECLARED`;
 * - the delivered/excluded/duplicate totals must reconcile against the
 *   manifest's own `recordCounts`, which is an INDEPENDENT oracle: the counts
 *   were computed by the compactor, not by this source.
 *
 * ## Integrity
 *
 * Before a segment's rows are trusted, the bytes they were decoded from are
 * digested and compared with the manifest's pin (§8.4 "all segment checksums").
 * Per record, `payloadSha256` is re-derived from `payloadUtf8` with this
 * package's own strict UTF-8 encoder, so a single corrupted payload is caught
 * even inside an object whose overall digest matched.
 */

import {
  isCanonicalUuid,
  isIsoTimestamp,
  isNonEmptyString,
  isNonNegativeInteger,
  isRecord,
  isSha256Hex,
  isUnsignedIntegerString,
  isoToEpochMilliseconds,
  readField,
} from "./grammar.js";
import { createReplayClock, type ReplayClock } from "./clock.js";
import { materializeInput, ownFrozenTree, readOwnPlainInput } from "./plain.js";
import type { ReplayDataset } from "./manifest.js";
import type { EventEnvelope, MarketEventSource, RecordedEventIdentity } from "./ports.js";
import {
  describeForRefusal,
  simulationFailure,
  simulationOk,
  totally,
  type SimulationRefusal,
  type SimulationResult,
} from "./refusals.js";
import { encodeUtf8Strict } from "./strict-json.js";

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/**
 * SHA-256 over bytes, supplied by the composition root.
 *
 * `packages/simulation` is layer 1 and is NOT on
 * `docs/contracts/dependency-direction.md` §2.2's enumerated layer-0/1 Node
 * built-in allowlist, so it may not import `node:crypto` and may not add itself
 * to a contract it does not own. A hand-rolled FIPS 180-4 implementation in
 * production code is the alternative `WP-160`'s review explicitly ruled a
 * correctness liability. So the digest is a PORT: `apps/backtest-cli` supplies
 * `createHash("sha256")`, and a test supplies the same.
 */
export type Sha256HexDigest = (bytes: Uint8Array) => string;

/** One archived object, as the composition root read and decoded it. */
export interface ArchivedObject {
  readonly objectKey: string;
  /** Exactly the bytes the manifest's `objects[].sha256` pins. */
  readonly bytes: Uint8Array;
  /** Rows decoded from EXACTLY those bytes, by the caller's format reader. */
  readonly rows: readonly unknown[];
}

/**
 * Reads one archived object.
 *
 * The reader does NOT verify anything: verification is this source's job, so a
 * reader cannot be the thing that decides a corrupted object is fine.
 */
export interface DatasetArchiveReader {
  readObject(objectKey: string): Promise<ArchivedObject>;
}

/** A recorded raw frame, exactly as the archive holds it (`WP-130`). */
export interface RecordedFrame {
  readonly gatewayEpoch: string;
  readonly ingestSeq: string;
  readonly source: string;
  readonly endpoint: string;
  readonly connectionId: string;
  readonly subscriptionGeneration: number;
  readonly receivedAt: string;
  readonly receivedMonotonicNs: string;
  readonly payloadUtf8: string;
  readonly payloadSha256: string;
}

/**
 * A DETERMINISTIC UUIDv7 for an envelope produced by replaying a recorded frame.
 *
 * §12.4 requires byte-identical output for a fixed dataset, config and seed, so
 * a replay may not mint a random `eventId`: the id has to be a function of the
 * recording. It also may not be a fabricated instant — §6 invariant 15 — so the
 * 48-bit UUIDv7 timestamp is the frame's OWN recorded `receivedAt` in epoch
 * milliseconds, and the remaining bits come from a digest of the recorded
 * identity `(gatewayEpoch, ingestSeq, index)`.
 *
 * The result is therefore a genuine UUIDv7: time-ordered by real arrival time,
 * unique per (frame, index), and identical on every replay of the same dataset.
 *
 * @param digest the SHA-256 port; see {@link Sha256HexDigest}.
 */
export function deriveReplayEventId(
  digest: Sha256HexDigest,
  offered: {
    readonly gatewayEpoch: string;
    readonly ingestSeq: string;
    readonly receivedAt: string;
    readonly index: number;
  },
): SimulationResult<string> {
  // D1 (round-3 review, MEDIUM-1): the identity is a CALLER RECORD, and every
  // field is read twice below — once to validate and once to build the seed the
  // event id is derived FROM. `digest` is a PORT (a function), so it is not
  // data and is not materialized.
  const read = readOwnPlainInput<{
    readonly gatewayEpoch: string;
    readonly ingestSeq: string;
    readonly receivedAt: string;
    readonly index: number;
  }>(offered, "the recorded identity");
  if (!read.ok) return read;
  const input = read.value;
  if (input === null || typeof input !== "object") {
    return simulationFailure(
      "SIMULATION_INPUT_INVALID",
      "an event id is derived from a recorded identity record (§7.1)",
    );
  }
  if (typeof digest !== "function") {
    return simulationFailure(
      "SIMULATION_INPUT_INVALID",
      "the SHA-256 port is supplied by the composition root; this package imports no Node built-in",
    );
  }
  if (
    !isNonEmptyString(input.gatewayEpoch) ||
    !isNonEmptyString(input.ingestSeq) ||
    !isNonNegativeInteger(input.index)
  ) {
    return simulationFailure(
      "SIMULATION_INPUT_INVALID",
      "an event id is derived from (gatewayEpoch, ingestSeq, index); each is required",
    );
  }
  const epochMs = isoToEpochMilliseconds(input.receivedAt);
  if (epochMs === undefined || epochMs < 0 || epochMs > 0xffff_ffff_ffff) {
    return simulationFailure(
      "SIMULATION_INPUT_INVALID",
      "receivedAt is not an instant a UUIDv7 timestamp field can carry",
      { receivedAt: describeForRefusal(input.receivedAt) },
    );
  }
  // Unit separators, so two different identities cannot concatenate to one seed.
  const seed = `${input.gatewayEpoch}\u001f${input.ingestSeq}\u001f${String(input.index)}`;
  const encoded = encodeUtf8Strict(seed);
  /* c8 ignore next 3 -- the seed is built from validated ASCII-safe fields. */
  if (!encoded.ok) {
    return simulationFailure("SIMULATION_INPUT_INVALID", "the event-id seed does not encode to UTF-8");
  }
  const hex = digest(encoded.bytes);
  if (!isSha256Hex(hex)) {
    return simulationFailure(
      "SIMULATION_INPUT_INVALID",
      "the supplied SHA-256 port did not return 64 lowercase hex characters",
    );
  }
  const timestamp = epochMs.toString(16).padStart(12, "0");
  const randA = hex.slice(0, 3);
  // Variant bits `10` in the top two bits of the 9th byte: 0x8..0xb.
  const variantNibble = "89ab"[parseInt(hex.charAt(3), 16) & 0b11] ?? "8";
  const randB = `${variantNibble}${hex.slice(4, 7)}${hex.slice(7, 19)}`;
  return simulationOk(
    `${timestamp.slice(0, 8)}-${timestamp.slice(8, 12)}-7${randA}-${randB.slice(0, 4)}-${randB.slice(4, 16)}`,
  );
}

/** One replay-eligible record, with the provenance a fill can be traced by. */
export interface ReplayRecord {
  readonly datasetRowOrdinal: number;
  readonly segmentId: string;
  readonly segmentRecordIndex: number;
  readonly frameLineSha256: string;
  readonly frame: RecordedFrame;
}

/** A normalizer's answer for one recorded frame. */
export type NormalizeOutcome =
  | { readonly ok: true; readonly envelopes: readonly EventEnvelope<unknown>[] }
  | { readonly ok: false; readonly reason: string };

/**
 * Turns a recorded frame into normalized §7.1 envelopes.
 *
 * Supplied by the composition root, because normalization belongs to the venue
 * adapters (layer 2) and this package may not import them. `normalizerVersion`
 * is checked against the manifest pin (§12.5, §6 invariant 9): a run that
 * normalizes with a different version is producing a different dataset.
 */
export interface ReplayNormalizer {
  readonly normalizerVersion: string;
  normalize(record: ReplayRecord): NormalizeOutcome;
}

// ---------------------------------------------------------------------------
// Loading: verify, reconcile, order
// ---------------------------------------------------------------------------

/** What loading a dataset observed. Diagnostics; never used to order anything. */
export interface DatasetLoadReport {
  readonly datasetId: string;
  readonly gatewayEpoch: string;
  readonly objectsVerified: number;
  readonly rowsRead: number;
  readonly rowsDelivered: number;
  readonly rowsExcludedByIncident: number;
  readonly rowsExcludedAsDuplicate: number;
  /**
   * How many replay-eligible ROWS carry a recorded arrival wall clock
   * (`receivedAt`) EARLIER than one already ordered ahead of them.
   *
   * Observed and reported; never used to reorder anything. It is named for what
   * it measures: a dataset row carries no venue timestamp — that field belongs
   * to the normalized §7.1 envelope — so the venue-time disagreement is counted
   * on the delivery path instead ({@link EventSourceReport}). Compared on EPOCH
   * MILLISECONDS, because two ISO-8601 instants with different UTC offsets do
   * not compare correctly as strings (`clock.ts`'s own rule; the lexical form
   * this used to use was the GOV-1C-deprecated one).
   */
  readonly receivedAtInversions: number;
  readonly walSegmentVerification: "VERIFIED" | "NOT_AVAILABLE_ARCHIVED_ONLY";
}

/** A verified, ordered dataset ready to be replayed. */
export interface LoadedDataset {
  readonly dataset: ReplayDataset;
  readonly records: readonly ReplayRecord[];
  readonly report: DatasetLoadReport;
}

const ROW_KEYS: readonly string[] = [
  "datasetRowOrdinal",
  "segmentId",
  "segmentIndex",
  "segmentRecordIndex",
  "record",
  "frameLineByteOffset",
  "frameLineByteLength",
  "frameLineSha256",
  "replayEligible",
  "exclusionReason",
];

const FRAME_KEYS: readonly string[] = [
  "gatewayEpoch",
  "ingestSeq",
  "source",
  "endpoint",
  "connectionId",
  "subscriptionGeneration",
  "receivedAt",
  "receivedMonotonicNs",
  "payloadUtf8",
  "payloadSha256",
];

interface ValidatedRow {
  readonly datasetRowOrdinal: number;
  readonly segmentId: string;
  readonly segmentRecordIndex: number;
  readonly frameLineSha256: string;
  readonly replayEligible: boolean;
  readonly exclusionReason: string | null;
  readonly frame: RecordedFrame;
}

function rowInvalid(
  message: string,
  details?: Readonly<Record<string, unknown>>,
): SimulationResult<never> {
  return simulationFailure("REPLAY_ROW_INVALID", message, details);
}

function validateRow(value: unknown, at: string, digest: Sha256HexDigest): SimulationResult<ValidatedRow> {
  const materialized = materializeInput(value, at);
  if (!materialized.ok) {
    return simulationFailure(
      "SIMULATION_INPUT_NOT_DATA",
      `${at} could not be read as plain data`,
      {
        firstProblemPath: materialized.problems[0]?.path ?? at,
        firstProblem: materialized.problems[0]?.problem ?? "unknown",
        problems: materialized.problems.length,
      },
    );
  }
  const tree = materialized.value;
  if (!isRecord(tree)) return rowInvalid(`${at} must be a record`);
  for (const key of Object.keys(tree)) {
    if (!ROW_KEYS.includes(key)) {
      return rowInvalid(`${at} carries an unknown key ${JSON.stringify(key)}`, { key });
    }
  }
  for (const key of ROW_KEYS) {
    if (!Object.hasOwn(tree, key)) return rowInvalid(`${at} is missing ${JSON.stringify(key)}`, { key });
  }

  const datasetRowOrdinal = readField(tree, "datasetRowOrdinal");
  if (!isNonNegativeInteger(datasetRowOrdinal)) {
    return rowInvalid(`${at}.datasetRowOrdinal must be a non-negative integer`);
  }
  const segmentId = readField(tree, "segmentId");
  if (!isNonEmptyString(segmentId)) return rowInvalid(`${at}.segmentId must be a string`);
  const segmentRecordIndex = readField(tree, "segmentRecordIndex");
  if (!isNonNegativeInteger(segmentRecordIndex)) {
    return rowInvalid(`${at}.segmentRecordIndex must be a non-negative integer`);
  }
  const frameLineSha256 = readField(tree, "frameLineSha256");
  if (!isSha256Hex(frameLineSha256)) return rowInvalid(`${at}.frameLineSha256 must be 64 lowercase hex`);
  const replayEligible = readField(tree, "replayEligible");
  if (typeof replayEligible !== "boolean") return rowInvalid(`${at}.replayEligible must be a boolean`);
  const exclusionReasonRaw = readField(tree, "exclusionReason");
  if (exclusionReasonRaw !== null && typeof exclusionReasonRaw !== "string") {
    return rowInvalid(`${at}.exclusionReason must be a string or null`);
  }
  const exclusionReason = exclusionReasonRaw === null ? null : exclusionReasonRaw;
  if (replayEligible !== (exclusionReason === null)) {
    return rowInvalid(
      `${at} contradicts itself: replayEligible and exclusionReason must be exact complements`,
      { datasetRowOrdinal, replayEligible, hasExclusionReason: exclusionReason !== null },
    );
  }

  const record = readField(tree, "record");
  if (!isRecord(record)) return rowInvalid(`${at}.record must be a record`);
  for (const key of Object.keys(record)) {
    if (!FRAME_KEYS.includes(key)) {
      return rowInvalid(`${at}.record carries an unknown key ${JSON.stringify(key)}`, { key });
    }
  }
  for (const key of FRAME_KEYS) {
    if (!Object.hasOwn(record, key)) {
      return rowInvalid(`${at}.record is missing ${JSON.stringify(key)}`, { key });
    }
  }
  const gatewayEpoch = readField(record, "gatewayEpoch");
  if (!isCanonicalUuid(gatewayEpoch)) return rowInvalid(`${at}.record.gatewayEpoch must be a UUID`);
  const ingestSeq = readField(record, "ingestSeq");
  if (!isUnsignedIntegerString(ingestSeq)) {
    return rowInvalid(`${at}.record.ingestSeq must be a canonical unsigned integer string`);
  }
  const source = readField(record, "source");
  if (!isNonEmptyString(source)) return rowInvalid(`${at}.record.source must be a string`);
  const endpoint = readField(record, "endpoint");
  if (typeof endpoint !== "string") return rowInvalid(`${at}.record.endpoint must be a string`);
  const connectionId = readField(record, "connectionId");
  if (typeof connectionId !== "string") return rowInvalid(`${at}.record.connectionId must be a string`);
  const subscriptionGeneration = readField(record, "subscriptionGeneration");
  if (!isNonNegativeInteger(subscriptionGeneration)) {
    return rowInvalid(`${at}.record.subscriptionGeneration must be a non-negative integer`);
  }
  const receivedAt = readField(record, "receivedAt");
  if (!isIsoTimestamp(receivedAt)) return rowInvalid(`${at}.record.receivedAt must be ISO-8601`);
  const receivedMonotonicNs = readField(record, "receivedMonotonicNs");
  if (!isUnsignedIntegerString(receivedMonotonicNs)) {
    return rowInvalid(`${at}.record.receivedMonotonicNs must be a canonical unsigned integer string`);
  }
  const payloadUtf8 = readField(record, "payloadUtf8");
  if (typeof payloadUtf8 !== "string") return rowInvalid(`${at}.record.payloadUtf8 must be a string`);
  const payloadSha256 = readField(record, "payloadSha256");
  if (!isSha256Hex(payloadSha256)) return rowInvalid(`${at}.record.payloadSha256 must be 64 lowercase hex`);

  const encoded = encodeUtf8Strict(payloadUtf8);
  if (!encoded.ok) {
    return rowInvalid(
      `${at}.record.payloadUtf8 contains an unpaired surrogate and does not re-encode to UTF-8`,
      { datasetRowOrdinal, at: encoded.at },
    );
  }
  const observedDigest = digest(encoded.bytes);
  if (observedDigest !== payloadSha256) {
    return simulationFailure(
      "REPLAY_SEGMENT_CHECKSUM_MISMATCH",
      `${at}.record.payloadUtf8 does not hash to its recorded payloadSha256; the record is corrupted and is refused rather than replayed`,
      { datasetRowOrdinal, recorded: payloadSha256, observed: observedDigest },
    );
  }

  return simulationOk({
    datasetRowOrdinal,
    segmentId,
    segmentRecordIndex,
    frameLineSha256,
    replayEligible,
    exclusionReason,
    frame: {
      gatewayEpoch,
      ingestSeq,
      source,
      endpoint,
      connectionId,
      subscriptionGeneration,
      receivedAt,
      receivedMonotonicNs,
      payloadUtf8,
      payloadSha256,
    },
  });
}

/** Options for {@link loadDataset}. */
export interface LoadDatasetOptions {
  readonly dataset: ReplayDataset;
  readonly archive: DatasetArchiveReader;
  readonly digestSha256: Sha256HexDigest;
  /**
   * Optional WAL-segment reader.
   *
   * When supplied, each manifest segment's bytes are digested and compared with
   * `segmentFileSha256` (ADR-017 §1's whole-file role). When absent, the WAL
   * segments have typically been deleted under retention — the manifest is the
   * proof — and the load report says so rather than implying a check happened.
   */
  readonly walSegments?: { read(segmentId: string): Promise<Uint8Array> };
}

/**
 * Verifies and orders a dataset. Total: every failure is a typed refusal.
 */
export async function loadDataset(
  options: LoadDatasetOptions,
): Promise<SimulationResult<LoadedDataset>> {
  const { dataset, archive, digestSha256 } = options;

  const byOrdinal = new Map<number, ValidatedRow>();
  let objectsVerified = 0;

  for (const pin of dataset.objects) {
    let object: ArchivedObject;
    try {
      object = await archive.readObject(pin.objectKey);
    } catch (cause) {
      return simulationFailure(
        "REPLAY_ARCHIVE_UNREADABLE",
        `the manifest pins object ${JSON.stringify(pin.objectKey)} and it could not be read; a replay consumes the manifest, not whatever happens to be on disk (ADR-004 §5)`,
        { objectKey: pin.objectKey, failure: cause instanceof Error ? cause.name : typeof cause },
      );
    }
    if (object.objectKey !== pin.objectKey) {
      return simulationFailure(
        "REPLAY_ARCHIVE_UNREADABLE",
        "the archive returned an object under a different key than the one requested",
        { requested: pin.objectKey, returned: object.objectKey },
      );
    }
    if (object.bytes.length !== pin.byteLength) {
      return simulationFailure(
        "REPLAY_OBJECT_CHECKSUM_MISMATCH",
        `object ${JSON.stringify(pin.objectKey)} is ${String(object.bytes.length)} bytes and the manifest pins ${String(pin.byteLength)}`,
        { objectKey: pin.objectKey, pinned: pin.byteLength, observed: object.bytes.length },
      );
    }
    const observed = digestSha256(object.bytes);
    if (observed !== pin.sha256) {
      return simulationFailure(
        "REPLAY_OBJECT_CHECKSUM_MISMATCH",
        `object ${JSON.stringify(pin.objectKey)} does not hash to the manifest's pin; §8.4 makes the manifest's checksums the trust boundary, so the bytes are refused`,
        { objectKey: pin.objectKey, pinned: pin.sha256, observed },
      );
    }
    objectsVerified += 1;

    if (object.rows.length !== pin.rowCount) {
      return simulationFailure(
        "REPLAY_COUNTS_UNRECONCILED",
        `object ${JSON.stringify(pin.objectKey)} decoded ${String(object.rows.length)} rows and the manifest pins ${String(pin.rowCount)}`,
        { objectKey: pin.objectKey, pinned: pin.rowCount, observed: object.rows.length },
      );
    }

    let eligibleInObject = 0;
    for (let index = 0; index < object.rows.length; index += 1) {
      const validated = validateRow(
        object.rows[index],
        `${pin.objectKey}[${String(index)}]`,
        digestSha256,
      );
      if (!validated.ok) return validated;
      const row = validated.value;
      if (row.frame.gatewayEpoch !== dataset.gatewayEpoch) {
        return simulationFailure(
          "REPLAY_CROSS_EPOCH_CHRONOLOGY_UNDEFINED",
          "a row carries a gateway epoch the dataset does not name; wal-format.md §12.1 defines no cross-epoch order, so the row cannot be placed",
          {
            datasetEpoch: dataset.gatewayEpoch,
            rowEpoch: row.frame.gatewayEpoch,
            datasetRowOrdinal: row.datasetRowOrdinal,
          },
        );
      }
      if (byOrdinal.has(row.datasetRowOrdinal)) {
        return simulationFailure(
          "REPLAY_DISPATCH_ORDER_INCONSISTENT",
          "two rows carry the same datasetRowOrdinal; the ordinal is the dispatch order and must be unique",
          { datasetRowOrdinal: row.datasetRowOrdinal },
        );
      }
      if (!pin.segmentIds.includes(row.segmentId)) {
        return simulationFailure(
          "REPLAY_COUNTS_UNRECONCILED",
          `object ${JSON.stringify(pin.objectKey)} carries a row from a segment it does not declare`,
          { objectKey: pin.objectKey, segmentId: row.segmentId },
        );
      }
      byOrdinal.set(row.datasetRowOrdinal, row);
      if (row.replayEligible) eligibleInObject += 1;
    }
    if (eligibleInObject !== pin.replayEligibleRowCount) {
      return simulationFailure(
        "REPLAY_COUNTS_UNRECONCILED",
        `object ${JSON.stringify(pin.objectKey)} carries ${String(eligibleInObject)} replay-eligible rows and the manifest pins ${String(pin.replayEligibleRowCount)}`,
        { objectKey: pin.objectKey, pinned: pin.replayEligibleRowCount, observed: eligibleInObject },
      );
    }
  }

  // ---- WAL segment checksums, when the segments still exist ---------------
  let walSegmentVerification: "VERIFIED" | "NOT_AVAILABLE_ARCHIVED_ONLY" =
    "NOT_AVAILABLE_ARCHIVED_ONLY";
  const walReader = options.walSegments;
  if (walReader !== undefined) {
    for (const segment of dataset.segments) {
      let bytes: Uint8Array;
      try {
        bytes = await walReader.read(segment.segmentId);
      } catch (cause) {
        return simulationFailure(
          "REPLAY_ARCHIVE_UNREADABLE",
          `WAL segment ${JSON.stringify(segment.segmentId)} was offered for verification and could not be read`,
          { segmentId: segment.segmentId, failure: cause instanceof Error ? cause.name : typeof cause },
        );
      }
      const observed = digestSha256(bytes);
      if (observed !== segment.segmentFileSha256) {
        return simulationFailure(
          "REPLAY_SEGMENT_CHECKSUM_MISMATCH",
          `WAL segment ${JSON.stringify(segment.segmentId)} does not hash to the manifest's whole-file pin (ADR-017 §1)`,
          { segmentId: segment.segmentId, pinned: segment.segmentFileSha256, observed },
        );
      }
    }
    walSegmentVerification = "VERIFIED";
  }

  // ---- Global reconciliation ---------------------------------------------
  const counts = dataset.recordCounts;
  if (byOrdinal.size !== counts.written) {
    return simulationFailure(
      "REPLAY_COUNTS_UNRECONCILED",
      `the archive delivered ${String(byOrdinal.size)} rows and the manifest pins written=${String(counts.written)}`,
      { observed: byOrdinal.size, written: counts.written },
    );
  }
  for (let ordinal = 0; ordinal < counts.written; ordinal += 1) {
    if (!byOrdinal.has(ordinal)) {
      return simulationFailure(
        "REPLAY_ORDINAL_GAP",
        `dispatch ordinal ${String(ordinal)} is missing; §8.3 forbids dropping a recorded event silently, so a gap is refused rather than skipped`,
        { datasetRowOrdinal: ordinal, written: counts.written },
      );
    }
  }

  const perSegment = new Map<string, { count: number; first: number; last: number; firstSeq: string; lastSeq: string }>();
  const records: ReplayRecord[] = [];
  let excludedByIncident = 0;
  let excludedAsDuplicate = 0;
  let previousEligibleSeq: bigint | undefined;

  for (let ordinal = 0; ordinal < counts.written; ordinal += 1) {
    const row = byOrdinal.get(ordinal);
    /* c8 ignore next */
    if (row === undefined) continue; // unreachable: the gap scan above returned.

    const bucket = perSegment.get(row.segmentId);
    if (bucket === undefined) {
      perSegment.set(row.segmentId, {
        count: 1,
        first: ordinal,
        last: ordinal,
        firstSeq: row.frame.ingestSeq,
        lastSeq: row.frame.ingestSeq,
      });
    } else {
      bucket.count += 1;
      bucket.last = ordinal;
      bucket.lastSeq = row.frame.ingestSeq;
    }

    if (row.replayEligible) {
      const seq = BigInt(row.frame.ingestSeq);
      if (previousEligibleSeq !== undefined && seq <= previousEligibleSeq) {
        return simulationFailure(
          "REPLAY_DISPATCH_ORDER_INCONSISTENT",
          "replay-eligible rows are not strictly increasing in ingestSeq under the recorded dispatch order; " +
            "within one gateway epoch ingestSeq is monotonic (§7.1), so the archive's dispatch order and its own sequence disagree",
          {
            datasetRowOrdinal: ordinal,
            previousIngestSeq: previousEligibleSeq.toString(),
            ingestSeq: row.frame.ingestSeq,
          },
        );
      }
      previousEligibleSeq = seq;
      records.push(
        ownFrozenTree<ReplayRecord>({
          datasetRowOrdinal: ordinal,
          segmentId: row.segmentId,
          segmentRecordIndex: row.segmentRecordIndex,
          frameLineSha256: row.frameLineSha256,
          frame: row.frame,
        }),
      );
      continue;
    }

    const justified = justifyExclusion(dataset, row);
    if (!justified.ok) return justified;
    if (justified.value === "INCIDENT") excludedByIncident += 1;
    else excludedAsDuplicate += 1;
  }

  if (records.length !== counts.replayEligible) {
    return simulationFailure(
      "REPLAY_COUNTS_UNRECONCILED",
      `${String(records.length)} rows are replay-eligible and the manifest pins replayEligible=${String(counts.replayEligible)}`,
      { observed: records.length, pinned: counts.replayEligible },
    );
  }
  if (excludedByIncident !== counts.excludedByIncident) {
    return simulationFailure(
      "REPLAY_COUNTS_UNRECONCILED",
      `${String(excludedByIncident)} rows were excluded by an incident window and the manifest pins ${String(counts.excludedByIncident)}`,
      { observed: excludedByIncident, pinned: counts.excludedByIncident },
    );
  }
  if (excludedAsDuplicate !== counts.excludedAsDuplicate) {
    return simulationFailure(
      "REPLAY_COUNTS_UNRECONCILED",
      `${String(excludedAsDuplicate)} rows were excluded as duplicates and the manifest pins ${String(counts.excludedAsDuplicate)}`,
      { observed: excludedAsDuplicate, pinned: counts.excludedAsDuplicate },
    );
  }
  if (excludedAsDuplicate !== dataset.duplicateRecordCount) {
    return simulationFailure(
      "REPLAY_COUNTS_UNRECONCILED",
      "the manifest's deduplication summary and its recordCounts disagree about how many rows are duplicates",
      { deduplication: dataset.duplicateRecordCount, recordCounts: excludedAsDuplicate },
    );
  }

  for (const segment of dataset.segments) {
    const observed = perSegment.get(segment.segmentId);
    if (observed === undefined) {
      if (segment.recordCount === 0) continue;
      return simulationFailure(
        "REPLAY_COUNTS_UNRECONCILED",
        `the manifest pins segment ${JSON.stringify(segment.segmentId)} with ${String(segment.recordCount)} records and the archive delivered none`,
        { segmentId: segment.segmentId, pinned: segment.recordCount },
      );
    }
    if (observed.count !== segment.recordCount) {
      return simulationFailure(
        "REPLAY_COUNTS_UNRECONCILED",
        `segment ${JSON.stringify(segment.segmentId)} delivered ${String(observed.count)} rows and the manifest pins ${String(segment.recordCount)}`,
        { segmentId: segment.segmentId, pinned: segment.recordCount, observed: observed.count },
      );
    }
    if (segment.firstDatasetRowOrdinal !== null && segment.firstDatasetRowOrdinal !== observed.first) {
      return simulationFailure(
        "REPLAY_DISPATCH_ORDER_INCONSISTENT",
        `segment ${JSON.stringify(segment.segmentId)} starts at ordinal ${String(observed.first)} and the manifest pins ${String(segment.firstDatasetRowOrdinal)}`,
        { segmentId: segment.segmentId },
      );
    }
    if (segment.lastDatasetRowOrdinal !== null && segment.lastDatasetRowOrdinal !== observed.last) {
      return simulationFailure(
        "REPLAY_DISPATCH_ORDER_INCONSISTENT",
        `segment ${JSON.stringify(segment.segmentId)} ends at ordinal ${String(observed.last)} and the manifest pins ${String(segment.lastDatasetRowOrdinal)}`,
        { segmentId: segment.segmentId },
      );
    }
    if (segment.firstIngestSeq !== null && segment.firstIngestSeq !== observed.firstSeq) {
      return simulationFailure(
        "REPLAY_COUNTS_UNRECONCILED",
        `segment ${JSON.stringify(segment.segmentId)} begins at ingestSeq ${observed.firstSeq} and the manifest pins ${segment.firstIngestSeq}`,
        { segmentId: segment.segmentId },
      );
    }
    if (segment.lastIngestSeq !== null && segment.lastIngestSeq !== observed.lastSeq) {
      return simulationFailure(
        "REPLAY_COUNTS_UNRECONCILED",
        `segment ${JSON.stringify(segment.segmentId)} ends at ingestSeq ${observed.lastSeq} and the manifest pins ${segment.lastIngestSeq}`,
        { segmentId: segment.segmentId },
      );
    }
  }

  const first = records[0];
  const last = records[records.length - 1];
  if (dataset.firstEvent !== null && first !== undefined) {
    const mismatch = identityMismatch(dataset.firstEvent, first, "eventRange.first");
    if (mismatch !== undefined) return { ok: false, refusal: mismatch };
  }
  if (dataset.lastEvent !== null && last !== undefined) {
    const mismatch = identityMismatch(dataset.lastEvent, last, "eventRange.last");
    if (mismatch !== undefined) return { ok: false, refusal: mismatch };
  }

  const inversions = countReceivedAtInversions(records);

  return simulationOk({
    dataset,
    records,
    report: ownFrozenTree<DatasetLoadReport>({
      datasetId: dataset.datasetId,
      gatewayEpoch: dataset.gatewayEpoch,
      objectsVerified,
      rowsRead: byOrdinal.size,
      rowsDelivered: records.length,
      rowsExcludedByIncident: excludedByIncident,
      rowsExcludedAsDuplicate: excludedAsDuplicate,
      receivedAtInversions: inversions,
      walSegmentVerification,
    }),
  });
}

function identityMismatch(
  pinned: { readonly gatewayEpoch: string; readonly ingestSeq: string; readonly receivedAt: string; readonly datasetRowOrdinal: number },
  observed: ReplayRecord,
  what: string,
): SimulationRefusal | undefined {
  if (
    pinned.gatewayEpoch === observed.frame.gatewayEpoch &&
    pinned.ingestSeq === observed.frame.ingestSeq &&
    pinned.receivedAt === observed.frame.receivedAt &&
    pinned.datasetRowOrdinal === observed.datasetRowOrdinal
  ) {
    return undefined;
  }
  const failure = simulationFailure(
    "REPLAY_DISPATCH_ORDER_INCONSISTENT",
    `${what} names an event identity the ordered stream does not put there; §12.5 pins the start/end event identity and it must be the one replay reaches`,
    {
      pinnedOrdinal: pinned.datasetRowOrdinal,
      observedOrdinal: observed.datasetRowOrdinal,
      pinnedIngestSeq: pinned.ingestSeq,
      observedIngestSeq: observed.frame.ingestSeq,
    },
  );
  return failure.ok ? undefined : failure.refusal;
}

function justifyExclusion(
  dataset: ReplayDataset,
  row: ValidatedRow,
): SimulationResult<"INCIDENT" | "DUPLICATE"> {
  const reason = row.exclusionReason ?? "";
  if (reason.startsWith("duplicate:")) {
    const ordinal = reason.slice("duplicate:".length);
    if (!/^(?:0|[1-9][0-9]*)$/u.test(ordinal)) {
      return simulationFailure(
        "REPLAY_EXCLUSION_UNDECLARED",
        "a duplicate exclusion does not name the ordinal of the copy that won",
        { datasetRowOrdinal: row.datasetRowOrdinal, exclusionReason: reason },
      );
    }
    if (Number(ordinal) >= row.datasetRowOrdinal) {
      return simulationFailure(
        "REPLAY_EXCLUSION_UNDECLARED",
        "a duplicate exclusion names a winning copy at or after itself; first-wins-in-dispatch-order means the winner is earlier",
        { datasetRowOrdinal: row.datasetRowOrdinal, exclusionReason: reason },
      );
    }
    return simulationOk("DUPLICATE");
  }
  if (reason.startsWith("incident:")) {
    const incidentId = reason.slice("incident:".length);
    const window = dataset.excludedWindows.find((entry) => entry.incidentId === incidentId);
    if (window === undefined) {
      return simulationFailure(
        "REPLAY_EXCLUSION_UNDECLARED",
        `a row is excluded for incident ${JSON.stringify(incidentId)} and the manifest declares no such window; §8.3 forbids dropping a recorded event without a declared reason`,
        { datasetRowOrdinal: row.datasetRowOrdinal, incidentId },
      );
    }
    if (window.gatewayEpoch !== row.frame.gatewayEpoch) {
      return simulationFailure(
        "REPLAY_EXCLUSION_UNDECLARED",
        "a row is excluded by an incident window declared for a different gateway epoch",
        { datasetRowOrdinal: row.datasetRowOrdinal, incidentId },
      );
    }
    const seq = BigInt(row.frame.ingestSeq);
    if (seq < BigInt(window.fromIngestSeq) || seq > BigInt(window.toIngestSeq)) {
      return simulationFailure(
        "REPLAY_EXCLUSION_UNDECLARED",
        "a row is excluded by an incident window whose (gatewayEpoch, ingestSeq) range does not contain it",
        {
          datasetRowOrdinal: row.datasetRowOrdinal,
          incidentId,
          ingestSeq: row.frame.ingestSeq,
          fromIngestSeq: window.fromIngestSeq,
          toIngestSeq: window.toIngestSeq,
        },
      );
    }
    return simulationOk("INCIDENT");
  }
  return simulationFailure(
    "REPLAY_EXCLUSION_UNDECLARED",
    "a row is excluded for a reason outside the declared vocabulary (`incident:<id>` or `duplicate:<ordinal>`)",
    { datasetRowOrdinal: row.datasetRowOrdinal, exclusionReason: reason },
  );
}

/**
 * Counts ordered records whose recorded frame arrival wall clock is out of order.
 *
 * DIAGNOSTIC ONLY. This function's answer is reported and never consulted by
 * any ordering decision; it exists so an operator can see *how much* dispatch
 * order and wall-clock order disagree for a dataset.
 *
 * Compared on EPOCH MILLISECONDS. `"2026-01-01T00:00:10.000+01:00"` is earlier
 * than `"2026-01-01T00:00:00.000Z"` and sorts after it as a string, so a lexical
 * comparison of §7.1 timestamps answers a different question than the one asked.
 * A timestamp that cannot be converted arithmetically is COUNTED as unreadable
 * rather than silently treated as ordered — but it cannot occur here, because
 * the clock validated every one of them before this point.
 */
function countReceivedAtInversions(records: readonly ReplayRecord[]): number {
  let inversions = 0;
  let highWater: number | undefined;
  for (const record of records) {
    const at = isoToEpochMilliseconds(record.frame.receivedAt);
    /* c8 ignore next -- the manifest door validated every recorded instant. */
    if (at === undefined) continue;
    if (highWater !== undefined && at < highWater) inversions += 1;
    if (highWater === undefined || at > highWater) highWater = at;
  }
  return inversions;
}

// ---------------------------------------------------------------------------
// The §12.1 MarketEventSource
// ---------------------------------------------------------------------------

/** What a replay stream produced, for the run report. */
export interface EventSourceReport {
  readonly load: DatasetLoadReport;
  readonly envelopesDelivered: number;
  readonly recordsConsumed: number;
  /**
   * How many DELIVERED envelopes carry a `venueTimestamp` EARLIER than one
   * already delivered.
   *
   * This is the §8.4 disagreement an operator wants to see: replay follows
   * recorded dispatch order and must not sort by venue timestamp, and a nonzero
   * count here is the concrete evidence that the two orders differ for this
   * dataset. It is counted HERE, on the delivery path, because `venueTimestamp`
   * is a field of the normalized §7.1 envelope — a recorded dataset row does not
   * carry one. Compared on EPOCH MILLISECONDS (see
   * {@link DatasetLoadReport.receivedAtInversions}).
   *
   * DIAGNOSTIC ONLY: nothing is reordered by it, ever.
   */
  readonly venueTimestampInversions: number;
  /**
   * Delivered envelopes with no `venueTimestamp` at all, or one that could not
   * be read arithmetically. §7.1 makes the field optional, so its absence is
   * REPORTED rather than counted as ordered.
   */
  readonly envelopesWithoutVenueTimestamp: number;
}

/**
 * §12.1 `MarketEventSource` over a verified dataset.
 *
 * Iterating advances the injected {@link ReplayClock} to each record's recorded
 * instant BEFORE its envelopes are delivered, so a consumer's `clock.now()`
 * during an event is exactly the recorded arrival instant of that event and
 * never an instant the live process did not have (§6 invariant 15).
 */
export class DatasetEventSource implements MarketEventSource {
  readonly #loaded: LoadedDataset;
  readonly #normalizer: ReplayNormalizer;
  readonly #clock: ReplayClock;
  #envelopesDelivered = 0;
  #recordsConsumed = 0;
  #venueTimestampInversions = 0;
  #envelopesWithoutVenueTimestamp = 0;
  #venueTimestampHighWaterMs: number | undefined;
  #refusal: SimulationRefusal | undefined;

  private constructor(loaded: LoadedDataset, normalizer: ReplayNormalizer, clock: ReplayClock) {
    this.#loaded = loaded;
    this.#normalizer = normalizer;
    this.#clock = clock;
  }

  /** The clock this source drives. Positioned at the dataset's first record. */
  get clock(): ReplayClock {
    return this.#clock;
  }

  /** The verified dataset behind this source. */
  get loaded(): LoadedDataset {
    return this.#loaded;
  }

  /**
   * The refusal that ended iteration, if any.
   *
   * `AsyncIterable` cannot carry a typed refusal, and this package does not
   * throw from doors, so a normalizer refusal ENDS the stream and is recorded
   * here. A caller that ignores it gets a short stream, which is why
   * {@link runEventSource} exists and is what the run driver uses.
   */
  get refusal(): SimulationRefusal | undefined {
    return this.#refusal;
  }

  /** What the stream produced so far. */
  report(): EventSourceReport {
    return ownFrozenTree<EventSourceReport>({
      load: this.#loaded.report,
      envelopesDelivered: this.#envelopesDelivered,
      recordsConsumed: this.#recordsConsumed,
      venueTimestampInversions: this.#venueTimestampInversions,
      envelopesWithoutVenueTimestamp: this.#envelopesWithoutVenueTimestamp,
    });
  }

  /**
   * Observes one delivered envelope's VENUE timestamp, for the report.
   *
   * Never consulted by an ordering decision (§8.4, §6 invariant 15, ADR-002 §2:
   * replay follows recorded dispatch order and must not sort by venue time).
   */
  #observeVenueTimestamp(envelope: EventEnvelope<unknown>): void {
    const stated = envelope.venueTimestamp;
    const at = typeof stated === "string" ? isoToEpochMilliseconds(stated) : undefined;
    if (at === undefined) {
      this.#envelopesWithoutVenueTimestamp += 1;
      return;
    }
    const highWater = this.#venueTimestampHighWaterMs;
    if (highWater !== undefined && at < highWater) this.#venueTimestampInversions += 1;
    if (highWater === undefined || at > highWater) this.#venueTimestampHighWaterMs = at;
  }

  async *events(): AsyncIterable<EventEnvelope<unknown>> {
    for (const record of this.#loaded.records) {
      const advanced = this.#clock.advanceTo({
        receivedAt: record.frame.receivedAt,
        receivedMonotonicNs: record.frame.receivedMonotonicNs,
      });
      if (!advanced.ok) {
        this.#refusal = advanced.refusal;
        return;
      }
      const normalized = this.#normalizer.normalize(record);
      if (!normalized.ok) {
        const failure = simulationFailure(
          "REPLAY_NORMALIZER_REFUSED",
          `the normalizer refused a recorded frame at dispatch ordinal ${String(record.datasetRowOrdinal)}; §8.3 forbids dropping it silently, so the stream stops`,
          {
            datasetRowOrdinal: record.datasetRowOrdinal,
            ingestSeq: record.frame.ingestSeq,
            reason: normalized.reason,
          },
        );
        if (!failure.ok) this.#refusal = failure.refusal;
        return;
      }
      this.#recordsConsumed += 1;
      for (const envelope of normalized.envelopes) {
        const provenance = checkProvenance(envelope, record);
        if (provenance !== undefined) {
          this.#refusal = provenance;
          return;
        }
        this.#envelopesDelivered += 1;
        this.#observeVenueTimestamp(envelope);
        yield envelope;
      }
    }
  }

  /** The recorded identity of a record, for anchoring a simulated outcome. */
  static identityOf(record: ReplayRecord): RecordedEventIdentity {
    return ownFrozenTree<RecordedEventIdentity>({
      gatewayEpoch: record.frame.gatewayEpoch,
      ingestSeq: record.frame.ingestSeq,
      receivedAt: record.frame.receivedAt,
      datasetRowOrdinal: record.datasetRowOrdinal,
    });
  }

  /** Builds a source over an already-verified dataset. */
  static create(
    loaded: LoadedDataset,
    normalizer: ReplayNormalizer,
  ): SimulationResult<DatasetEventSource> {
    return totally("creating the dataset event source", () => {
      const pinned = loaded.dataset.pins.normalizerVersion;
      if (pinned !== null && pinned !== normalizer.normalizerVersion) {
        return simulationFailure(
          "REPLAY_MANIFEST_PIN_MISMATCH",
          `the dataset pins normalizerVersion=${JSON.stringify(pinned)} and the run supplies ${JSON.stringify(normalizer.normalizerVersion)}; §6 invariant 9 requires historical runs to use historical parameters`,
          { pinned, offered: normalizer.normalizerVersion },
        );
      }
      const first = loaded.records[0];
      if (first === undefined) {
        // The manifest's `eventRange` carries `receivedAt` but NOT
        // `receivedMonotonicNs` (`WP-130` `EventIdentity`), so an empty dataset
        // offers nothing to position the monotonic half of the clock from.
        // Inventing one would be a time the live process never had (§6
        // invariant 15), so this is a refusal rather than a default.
        return simulationFailure(
          "REPLAY_MANIFEST_INVALID",
          "the dataset has no replay-eligible record, so a replay clock cannot be positioned by anything recorded",
          { datasetId: loaded.dataset.datasetId },
        );
      }
      const clock = createReplayClock({
        receivedAt: first.frame.receivedAt,
        receivedMonotonicNs: first.frame.receivedMonotonicNs,
      });
      if (!clock.ok) return clock;
      return simulationOk(new DatasetEventSource(loaded, normalizer, clock.value));
    });
  }
}

function checkProvenance(
  envelope: EventEnvelope<unknown>,
  record: ReplayRecord,
): SimulationRefusal | undefined {
  const mismatches: string[] = [];
  if (envelope.gatewayEpoch !== record.frame.gatewayEpoch) mismatches.push("gatewayEpoch");
  if (envelope.ingestSeq !== record.frame.ingestSeq) mismatches.push("ingestSeq");
  if (envelope.receivedAt !== record.frame.receivedAt) mismatches.push("receivedAt");
  if (envelope.receivedMonotonicNs !== record.frame.receivedMonotonicNs) {
    mismatches.push("receivedMonotonicNs");
  }
  if (mismatches.length === 0) return undefined;
  const failure = simulationFailure(
    "REPLAY_NORMALIZER_REFUSED",
    `the normalizer emitted an envelope whose provenance differs from the recorded frame (${mismatches.join(", ")}); ` +
      "§7.1 makes (gatewayEpoch, ingestSeq) the recorded dispatch identity and a replay may not restate it",
    { datasetRowOrdinal: record.datasetRowOrdinal, fields: mismatches.join(",") },
  );
  return failure.ok ? undefined : failure.refusal;
}

/**
 * Drains a source, returning either every envelope or the refusal that stopped
 * it. This is the entry a run driver uses, because a short stream must never be
 * mistaken for a complete one.
 */
export async function runEventSource(
  source: DatasetEventSource,
): Promise<SimulationResult<readonly EventEnvelope<unknown>[]>> {
  const out: EventEnvelope<unknown>[] = [];
  for await (const envelope of source.events()) {
    out.push(envelope);
  }
  const refusal = source.refusal;
  if (refusal !== undefined) {
    return { ok: false, refusal } as SimulationResult<readonly EventEnvelope<unknown>[]>;
  }
  return simulationOk(out);
}
