/**
 * Structural input shapes for the recorder metrics exporter (`WP-140`).
 *
 * ## Why these are declared here instead of imported
 *
 * `packages/observability` is a **layer-1 application module**
 * (`docs/contracts/dependency-direction.md` §2). The metric producers live
 * above it: `DataGateway.metrics()` in `apps/data-gateway` (layer 3 — nothing
 * may depend on an app, F10) and `ResearchWorkerMetrics` in
 * `apps/research-worker` (layer 3). An import edge from here to either would
 * be forbidden, so this module declares the **subset it reads** as structural
 * types and relies on TypeScript's structural assignability: the real
 * `GatewayMetrics` and `ResearchWorkerMetrics` objects are assignable to
 * these inputs as-is, and the soak harness pins that assignability at
 * compile time against the real exported types
 * (`test/soak/recorder/src/type-compat.ts`), so drift in either direction
 * fails a typecheck rather than silently zeroing a dashboard.
 *
 * Every field here mirrors a field the producers export today:
 * - `apps/data-gateway/src/gateway.ts` (`GatewayMetrics`) and its parts
 *   (`WalWriterMetrics`/`WalQueueMetrics` from `packages/storage-wal`,
 *   `GatewayPublisherMetrics`, `DispatcherMetrics`, `IncidentRegistryMetrics`,
 *   `UniverseDirectoryMetrics`, the four feed-driver metrics).
 * - `apps/research-worker/src/metrics.ts` (`ResearchWorkerMetrics`).
 *
 * This module performs no I/O and imports nothing.
 */

/** Mirror of `WalQueueMetrics` (packages/storage-wal, §8.3 queue counters). */
export interface RecorderWalQueueMetricsInput {
  readonly currentDepth: number;
  readonly maximumDepth: number;
  readonly highWaterDepth: number;
  readonly oldestMessageAgeMs: number;
  readonly messagesDropped: number;
  readonly consumerLag: number;
  readonly overflowSignals: number;
  readonly currentByteDepth: number;
  readonly maximumByteDepth: number;
}

/** Mirror of the `WalWriterMetrics` fields the exporter reads. */
export interface RecorderWalMetricsInput {
  readonly state: "open" | "faulted" | "closed";
  readonly queue: RecorderWalQueueMetricsInput;
  readonly activeSegmentRecordCount: number;
  readonly activeSegmentByteLength: number;
  /** §14.3 "segment age". `null` when no segment is open. */
  readonly activeSegmentAgeMs: number | null;
  readonly segmentsOpened: number;
  readonly segmentsFinalized: number;
  readonly rotations: number;
  readonly framesAccepted: number;
  readonly framesWritten: number;
  readonly framesDurable: number;
  /** §14.3 "bytes written". */
  readonly bytesWritten: number;
  readonly bytesUnsynced: number;
  readonly recordsUnsynced: number;
  readonly fsyncCount: number;
  /** §14.3 "fsync latency". `null` before the first fsync. */
  readonly lastFsyncDurationMs: number | null;
  readonly totalFsyncDurationMs: number;
  readonly msSinceLastFsync: number | null;
  /** The configured fsync interval, restated as the data-loss bound (ADR-004 §3). */
  readonly dataLossBoundMs: number;
  readonly totalSegmentBytes: number;
  readonly capacityBytes: number | null;
  readonly capacityRemainingBytes: number | null;
  readonly unprovenFrameCount: number;
  readonly retainedRecordCount: number;
  readonly unmanifestedFaultedSegments: number;
  readonly overflowSignals: number;
  readonly capacityRefusals: number;
  readonly closedRefusals: number;
  readonly faultedRefusals: number;
  readonly validationRejections: number;
  readonly writeFaults: number;
  readonly pendingFrameCount: number;
}

/** Mirror of `PublicationHalt` (apps/data-gateway/src/publisher.ts). */
export interface RecorderPublicationHaltInput {
  readonly cause: string;
  readonly detail: string;
  readonly haltedAtIngestSeq: string;
}

/** Mirror of `GatewayPublisherMetrics`. */
export interface RecorderPublisherMetricsInput {
  readonly published: number;
  readonly duplicatesRefused: number;
  readonly suppressedWhileHalted: number;
  readonly rejectedByTransport: number;
  readonly admissionRefusals: number;
  readonly halted: boolean;
  readonly halt?: RecorderPublicationHaltInput | undefined;
  readonly queueDepth: number;
  readonly queueMaxDepthObserved: number;
  readonly queueMaxDepth: number;
  readonly queueBytes: number;
  readonly queueMaxBytesObserved: number;
  readonly queueMaxBytes: number;
  readonly oldestQueuedAgeMs: number;
}

/** Mirror of `DispatcherMetrics`. */
export interface RecorderDispatcherMetricsInput {
  readonly dispatched: number;
  readonly envelopeRejections: number;
}

/** Mirror of `IncidentRegistryMetrics`. */
export interface RecorderIncidentMetricsInput {
  readonly incidentsOpened: number;
  readonly repeatsSuppressed: number;
  readonly trackedKeys: number;
  readonly evictedKeys: number;
}

/** Mirror of `UniverseDirectoryMetrics`. */
export interface RecorderDirectoryMetricsInput {
  readonly knownMarkets: number;
  readonly declinedRegistrations: number;
  readonly declinedRegistrationsRetained: number;
  readonly declinedRegistrationsEvicted: number;
  readonly declinedRegistrationsCapacity: number;
  readonly parameterVersionsAssigned: number;
  readonly parameterAssignmentsDeclined: number;
}

/** Mirror of `PolymarketFeedDriverMetrics`. */
export interface RecorderPolymarketFeedMetricsInput {
  readonly framesRecorded: number;
  readonly framesRefusedByWal: number;
  readonly eventsDispatched: number;
  readonly marketEventsSuppressedUnrecorded: number;
  readonly transportObservations: number;
  readonly problemsRouted: number;
  readonly stallsObserved: number;
  readonly snapshotRecoveries: number;
  readonly snapshotFetchFailures: number;
  readonly resyncRejections: number;
}

/** Mirror of `RtdsFeedDriverMetrics`. */
export interface RecorderRtdsFeedMetricsInput {
  readonly framesRecorded: number;
  readonly framesRefusedByWal: number;
  readonly observationsDispatched: number;
  readonly unplannedSymbolObservations: number;
  readonly freshnessFailures: number;
  readonly coverageBreaks: number;
  readonly firstObservations: number;
  readonly outOfOrderObservations: number;
  readonly unrecoverableGapsAcknowledged: number;
  readonly gapAcknowledgementRejections: number;
  readonly transportObservations: number;
  readonly problemsRouted: number;
  readonly stallsObserved: number;
  readonly halted: boolean;
  readonly observationsSuppressedAfterGap: number;
}

/** Mirror of `BinanceFeedDriverMetrics`. */
export interface RecorderBinanceFeedMetricsInput {
  readonly framesRecorded: number;
  readonly framesRefusedByWal: number;
  readonly emissionsDispatched: number;
  readonly emissionsSuppressedUnrecorded: number;
  readonly rejectedSocketEvents: number;
  readonly unauthorizedSocketEvents: number;
  readonly stallsObserved: number;
  readonly pendingCloseFailures: number;
  readonly reconnectsScheduled: number;
  readonly waitedOnOutstandingAttempt: number;
  readonly directiveStops: number;
  /** The in-flight attempt the feed is waiting on (dashboards read this). */
  readonly pendingConnectionId?: string | undefined;
}

/** Mirror of `CoinbaseFeedDriverMetrics`. */
export interface RecorderCoinbaseFeedMetricsInput {
  readonly framesRecorded: number;
  readonly framesRefusedByWal: number;
  readonly binaryFramesUnrecorded: number;
  readonly framesWithoutEstablishedProvenance: number;
  readonly eventsDispatched: number;
  readonly eventsSuppressedUnrecorded: number;
  readonly anomaliesRouted: number;
  readonly snapshotEscalations: number;
  readonly reconnectLoopEscalations: number;
}

/** Mirror of `GatewayMetrics` (apps/data-gateway). */
export interface RecorderGatewayMetricsInput {
  readonly gatewayEpoch: string;
  readonly wal: RecorderWalMetricsInput;
  readonly publisher: RecorderPublisherMetricsInput;
  readonly dispatcher: RecorderDispatcherMetricsInput;
  readonly incidents: RecorderIncidentMetricsInput;
  readonly directory?: RecorderDirectoryMetricsInput | undefined;
  readonly polymarket?: RecorderPolymarketFeedMetricsInput | undefined;
  readonly rtds?: RecorderRtdsFeedMetricsInput | undefined;
  readonly binance?: RecorderBinanceFeedMetricsInput | undefined;
  readonly coinbase?: RecorderCoinbaseFeedMetricsInput | undefined;
}

/** Mirror of `ObjectUploadStatus` (apps/research-worker). */
export type RecorderUploadStatusInput = "idle" | "succeeded" | "failed";

/** Mirror of `ResearchWorkerMetrics` (apps/research-worker). */
export interface RecorderCompactionMetricsInput {
  readonly cyclesStarted: number;
  readonly cyclesSucceeded: number;
  readonly cyclesFailed: number;
  /** §14.3 "object upload status" for the most recent completed cycle. */
  readonly objectUploadStatus: RecorderUploadStatusInput;
  readonly lastFailureReason: string | null;
  /** §14.3 "compaction lag". `null` when the last cycle left nothing behind. */
  readonly compactionLagMs: number | null;
  readonly lastCycleSegmentsCompacted: number;
  readonly lastCycleSegmentsRefused: number;
  readonly lastCycleRowsWritten: number;
  readonly lastCycleObjectBytes: number;
  readonly lastCycleSegmentsDeleted: number;
  readonly lastCycleRetentionFailures: number;
  readonly lastCycleDurationMs: number;
  readonly totalSegmentsCompacted: number;
  readonly totalRowsWritten: number;
  readonly totalObjectBytes: number;
  readonly totalSegmentsDeleted: number;
}
