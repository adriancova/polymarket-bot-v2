/**
 * `@polymarket-bot/storage-wal` — the append-only write-ahead log for exact raw
 * market-data frames (`WP-050`).
 *
 * Authority: handoff §8.3 (backpressure), §9.1 (gateway and recorder
 * requirements, the `RawFrameRecord` shape), §4.2 (failure boundaries), and
 * ADR-004 (format, durability, recovery, compaction). The on-disk format is
 * specified in `docs/contracts/wal-format.md`; this package implements it.
 *
 * Layer: adapters/infrastructure (`docs/contracts/dependency-direction.md` §2,
 * layer 2). It imports Node built-ins and nothing from this workspace — in
 * particular not `packages/domain`, which is frozen and holds no storage type
 * (ADR-004 §1).
 *
 * Typical use from a composition root:
 *
 * ```ts
 * const writer = await openWalWriter({
 *   directoryPath: "/var/lib/polymarket-bot/wal",
 *   gatewayEpoch,
 *   fileSystem: nodeWalFileSystem(),
 *   clock: systemWalClock(),
 * });
 * const result = writer.enqueue(record); // returns a refusal; never drops
 * await writer.drain();                  // append + rotate + periodic fsync
 * await writer.tick();                   // time-driven fsync and rotation
 * await writer.close();                  // footer + sidecar manifest
 * ```
 */

export {
  WalError,
  WalConfigurationError,
  WalManifestError,
  WalRecordValidationError,
  WalSegmentIntegrityError,
  WalWriteFaultError,
  WalWriterStateError,
  type WalErrorCode,
  type WalErrorDetails,
} from "./errors.js";

export {
  DEFAULT_FSYNC_BYTE_THRESHOLD,
  DEFAULT_FSYNC_INTERVAL_MS,
  DEFAULT_MAX_RECORD_BYTES,
  DEFAULT_MAX_SEGMENT_AGE_MS,
  DEFAULT_MAX_SEGMENT_BYTES,
  DEFAULT_QUEUE_CAPACITY,
  DEFAULT_QUEUE_MAX_BYTES,
  DEFAULT_READ_CHUNK_BYTES,
  MANIFEST_FILE_SUFFIX,
  MAX_PAYLOAD_BYTES,
  SEGMENT_FILE_SUFFIX,
  WAL_FORMAT_ID,
  WAL_MANIFEST_VERSION,
  WAL_SCHEMA_VERSION,
} from "./constants.js";

export {
  assertPayloadDigest,
  buildRawFrameRecord,
  compareIngestSeq,
  parseRawFrameRecord,
  payloadDigest,
  sha256Hex,
  RAW_FRAME_RECORD_KEYS,
  type RawFrameRecord,
  type RawFrameRecordInput,
} from "./raw-frame.js";

export {
  buildSegmentHeader,
  classifySegmentLine,
  encodeFooterLine,
  encodeFrameLine,
  encodeHeaderLine,
  parseSegmentFooter,
  parseSegmentHeader,
  type WalSegmentFooter,
  type WalSegmentHeader,
  type WalSegmentLine,
} from "./segment-format.js";

export {
  defaultSegmentIdFactory,
  encodeSegmentManifest,
  isSegmentFileName,
  listSegmentManifests,
  manifestFileName,
  parseSegmentManifest,
  readSegmentManifest,
  segmentFileName,
  segmentIdFromFileName,
  writeSegmentManifest,
  type WalSegmentManifest,
} from "./manifest.js";

export {
  BoundedRawFrameQueue,
  type BoundedRawFrameQueueOptions,
  type CallerDropReason,
  type QueuedFrame,
  type QueueOfferResult,
  type WalQueueMetrics,
} from "./queue.js";

export {
  iterateSegmentRecords,
  readSegmentRecords,
  scanSegment,
  validateSegment,
  validateWalDirectory,
  type IncompleteFinalRecord,
  type SegmentIssue,
  type SegmentIssueCode,
  type SegmentReadResult,
  type SegmentRecordEntry,
  type SegmentScanOptions,
  type SegmentScanReport,
  type SegmentValidationReport,
} from "./reader.js";

export {
  recoverSegment,
  recoverWalDirectory,
  type SegmentRecoveryOutcome,
  type SegmentRecoveryReport,
  type WalRecoveryOptions,
  type WalRecoveryReport,
} from "./recovery.js";

export { ActiveSegment } from "./segment-writer.js";

export {
  openWalWriter,
  WalWriter,
  type WalDrainResult,
  type WalWriterMetrics,
  type WalWriterOptions,
  type WalWriterState,
} from "./writer.js";

export { isoFromEpochMs, systemWalClock } from "./clock.js";
export { nodeWalFileSystem } from "./node-file-system.js";

export type {
  SegmentIdContext,
  SegmentIdFactory,
  WalAppendHandle,
  WalClock,
  WalCloseReason,
  WalEnqueueResult,
  WalFileSystem,
  WalFsyncEvent,
  WalIngestSeqAnomalyEvent,
  WalOverflowEvent,
  WalReadHandle,
  WalRefusalReason,
  WalSegmentOpenedEvent,
  WalWriteFaultEvent,
  WalWriterObserver,
} from "./ports.js";
