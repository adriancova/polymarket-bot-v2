/**
 * Pure Prometheus text-exposition renderers for the recorder (`WP-140`).
 *
 * No network server lives here: these functions map the producers' exported
 * metric snapshots (see `metric-shapes.ts`) to exposition-format text
 * (version 0.0.4: `# HELP` / `# TYPE` headers plus samples). Serving the text
 * is a composition-root concern — the process that owns a `DataGateway` or a
 * research worker calls its `metrics()` and hands the snapshot here; tests
 * call these functions directly. Wiring an HTTP listener into
 * `apps/data-gateway` / `apps/research-worker` is outside this package's
 * layer and this work package's paths, and is recorded as a follow-up in
 * `docs/handoffs/WP-140.md`.
 *
 * Invariant, enforced at render time and pinned by tests: every emitted
 * sample belongs to a family in `RECORDER_METRIC_FAMILIES`, and carries only
 * that family's declared label keys. A renderer that drifted from the table
 * would otherwise quietly emit metrics no dashboard or alert is checked
 * against.
 */

import {
  RECORDER_METRIC_FAMILIES,
  recorderMetricFamily,
  type RecorderMetricFamily,
} from "./metric-families.js";
import type {
  RecorderCompactionMetricsInput,
  RecorderGatewayMetricsInput,
} from "./metric-shapes.js";
import type { SoakEvaluation } from "./soak-evidence.js";
import type { ValidationMetricsInput } from "./validation-findings.js";

export type MetricLabels = Readonly<Record<string, string>>;

export interface MetricSample {
  readonly name: string;
  readonly value: number;
  readonly labels?: MetricLabels | undefined;
}

function escapeHelp(text: string): string {
  return text.replaceAll("\\", "\\\\").replaceAll("\n", "\\n");
}

function escapeLabelValue(text: string): string {
  return text.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");
}

function formatValue(value: number): string {
  if (Number.isNaN(value)) {
    // A NaN sample is a rendering bug, never a fact about the recorder.
    throw new Error("metric value is NaN");
  }
  if (value === Number.POSITIVE_INFINITY) {
    return "+Inf";
  }
  if (value === Number.NEGATIVE_INFINITY) {
    return "-Inf";
  }
  return String(value);
}

function renderSampleLine(family: RecorderMetricFamily, sample: MetricSample): string {
  const labels = sample.labels ?? {};
  const keys = Object.keys(labels);
  const declared = family.labels ?? [];
  for (const key of keys) {
    if (!declared.includes(key)) {
      throw new Error(
        `metric ${family.name} does not declare label "${key}" in RECORDER_METRIC_FAMILIES`,
      );
    }
  }
  if (keys.length === 0) {
    return `${family.name} ${formatValue(sample.value)}`;
  }
  const rendered = keys
    .map((key) => `${key}="${escapeLabelValue(labels[key] ?? "")}"`)
    .join(",");
  return `${family.name}{${rendered}} ${formatValue(sample.value)}`;
}

/**
 * Render samples as exposition text, in table order, with HELP/TYPE headers.
 *
 * Families with no samples are omitted entirely; a sample whose name is not
 * in the table throws — see the module-header invariant.
 */
export function renderExposition(samples: readonly MetricSample[]): string {
  const byName = new Map<string, MetricSample[]>();
  for (const sample of samples) {
    const familyEntry = recorderMetricFamily(sample.name);
    if (familyEntry === undefined) {
      throw new Error(`metric ${sample.name} is not declared in RECORDER_METRIC_FAMILIES`);
    }
    const bucket = byName.get(sample.name);
    if (bucket === undefined) {
      byName.set(sample.name, [sample]);
    } else {
      bucket.push(sample);
    }
  }
  const lines: string[] = [];
  for (const familyEntry of RECORDER_METRIC_FAMILIES) {
    const bucket = byName.get(familyEntry.name);
    if (bucket === undefined) {
      continue;
    }
    lines.push(`# HELP ${familyEntry.name} ${escapeHelp(familyEntry.help)}`);
    lines.push(`# TYPE ${familyEntry.name} ${familyEntry.type}`);
    for (const sample of bucket) {
      lines.push(renderSampleLine(familyEntry, sample));
    }
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

const bool = (value: boolean): number => (value ? 1 : 0);

/** Samples for a `DataGateway.metrics()` snapshot. */
export function gatewayMetricSamples(
  snapshot: RecorderGatewayMetricsInput,
): readonly MetricSample[] {
  const samples: MetricSample[] = [];
  const add = (name: string, value: number | null, labels?: MetricLabels): void => {
    // `null` mirrors the producers' "absent, and absent is not zero" fields
    // (fsync latency before the first fsync, segment age with no open
    // segment, compaction lag with nothing left behind). Rendering 0 for
    // them would tell a dashboard a lie, so the sample is omitted instead.
    if (value === null) {
      return;
    }
    samples.push(labels === undefined ? { name, value } : { name, value, labels });
  };

  const wal = snapshot.wal;
  add("recorder_wal_queue_depth", wal.queue.currentDepth);
  add("recorder_wal_queue_max_depth", wal.queue.maximumDepth);
  add("recorder_wal_queue_high_water_depth", wal.queue.highWaterDepth);
  add("recorder_wal_queue_byte_depth", wal.queue.currentByteDepth);
  add("recorder_wal_queue_max_byte_depth", wal.queue.maximumByteDepth);
  add("recorder_wal_queue_oldest_message_age_ms", wal.queue.oldestMessageAgeMs);
  add("recorder_wal_queue_consumer_lag", wal.queue.consumerLag);
  add("recorder_wal_queue_messages_dropped_total", wal.queue.messagesDropped);
  add("recorder_wal_queue_overflow_signals_total", wal.queue.overflowSignals);

  add("recorder_wal_faulted", bool(wal.state === "faulted"));
  add("recorder_wal_closed", bool(wal.state === "closed"));
  add("recorder_wal_active_segment_age_ms", wal.activeSegmentAgeMs);
  add("recorder_wal_active_segment_records", wal.activeSegmentRecordCount);
  add("recorder_wal_active_segment_bytes", wal.activeSegmentByteLength);
  add("recorder_wal_segments_opened_total", wal.segmentsOpened);
  add("recorder_wal_segments_finalized_total", wal.segmentsFinalized);
  add("recorder_wal_rotations_total", wal.rotations);
  add("recorder_wal_frames_accepted_total", wal.framesAccepted);
  add("recorder_wal_frames_written_total", wal.framesWritten);
  add("recorder_wal_frames_durable_total", wal.framesDurable);
  add("recorder_wal_bytes_written_total", wal.bytesWritten);
  add("recorder_wal_bytes_unsynced", wal.bytesUnsynced);
  add("recorder_wal_records_unsynced", wal.recordsUnsynced);
  add("recorder_wal_fsync_total", wal.fsyncCount);
  add("recorder_wal_fsync_last_duration_ms", wal.lastFsyncDurationMs);
  add("recorder_wal_fsync_total_duration_ms", wal.totalFsyncDurationMs);
  add("recorder_wal_ms_since_last_fsync", wal.msSinceLastFsync);
  add("recorder_wal_data_loss_bound_ms", wal.dataLossBoundMs);
  add("recorder_wal_unproven_frame_count", wal.unprovenFrameCount);
  add("recorder_wal_retained_record_count", wal.retainedRecordCount);
  add("recorder_wal_unmanifested_faulted_segments", wal.unmanifestedFaultedSegments);
  add("recorder_wal_total_segment_bytes", wal.totalSegmentBytes);
  add("recorder_wal_capacity_bytes", wal.capacityBytes);
  add("recorder_wal_capacity_remaining_bytes", wal.capacityRemainingBytes);
  add("recorder_wal_capacity_refusals_total", wal.capacityRefusals);
  add("recorder_wal_closed_refusals_total", wal.closedRefusals);
  add("recorder_wal_faulted_refusals_total", wal.faultedRefusals);
  add("recorder_wal_validation_rejections_total", wal.validationRejections);
  add("recorder_wal_write_faults_total", wal.writeFaults);
  add("recorder_wal_pending_frame_count", wal.pendingFrameCount);

  const publisher = snapshot.publisher;
  add("recorder_publisher_published_total", publisher.published);
  add("recorder_publisher_duplicates_refused_total", publisher.duplicatesRefused);
  add("recorder_publisher_suppressed_while_halted_total", publisher.suppressedWhileHalted);
  add("recorder_publisher_rejected_by_transport_total", publisher.rejectedByTransport);
  add("recorder_publisher_admission_refusals_total", publisher.admissionRefusals);
  add("recorder_publisher_halted", bool(publisher.halted));
  if (publisher.halt !== undefined) {
    add("recorder_publisher_halt_info", 1, { cause: publisher.halt.cause });
  }
  add("recorder_publisher_queue_depth", publisher.queueDepth);
  add("recorder_publisher_queue_max_depth_observed", publisher.queueMaxDepthObserved);
  add("recorder_publisher_queue_max_depth", publisher.queueMaxDepth);
  add("recorder_publisher_queue_bytes", publisher.queueBytes);
  add("recorder_publisher_queue_max_bytes_observed", publisher.queueMaxBytesObserved);
  add("recorder_publisher_queue_max_bytes", publisher.queueMaxBytes);
  add("recorder_publisher_oldest_queued_age_ms", publisher.oldestQueuedAgeMs);

  add("recorder_dispatcher_dispatched_total", snapshot.dispatcher.dispatched);
  add("recorder_dispatcher_envelope_rejections_total", snapshot.dispatcher.envelopeRejections);

  add("recorder_incidents_opened_total", snapshot.incidents.incidentsOpened);
  add("recorder_incidents_repeats_suppressed_total", snapshot.incidents.repeatsSuppressed);
  add("recorder_incidents_tracked_keys", snapshot.incidents.trackedKeys);
  add("recorder_incidents_evicted_keys_total", snapshot.incidents.evictedKeys);

  const directory = snapshot.directory;
  if (directory !== undefined) {
    add("recorder_directory_known_markets", directory.knownMarkets);
    add("recorder_directory_declined_registrations_total", directory.declinedRegistrations);
    add(
      "recorder_directory_declined_registrations_retained",
      directory.declinedRegistrationsRetained,
    );
    add(
      "recorder_directory_declined_registrations_evicted_total",
      directory.declinedRegistrationsEvicted,
    );
    add(
      "recorder_directory_declined_registrations_capacity",
      directory.declinedRegistrationsCapacity,
    );
    add(
      "recorder_directory_parameter_versions_assigned_total",
      directory.parameterVersionsAssigned,
    );
    add(
      "recorder_directory_parameter_assignments_declined_total",
      directory.parameterAssignmentsDeclined,
    );
  }

  const polymarket = snapshot.polymarket;
  if (polymarket !== undefined) {
    const feed = { feed: "polymarket" };
    add("recorder_feed_frames_recorded_total", polymarket.framesRecorded, feed);
    add("recorder_feed_frames_refused_by_wal_total", polymarket.framesRefusedByWal, feed);
    add("recorder_feed_dispatched_total", polymarket.eventsDispatched, feed);
    add(
      "recorder_feed_suppressed_unrecorded_total",
      polymarket.marketEventsSuppressedUnrecorded,
      feed,
    );
    add("recorder_feed_stalls_observed_total", polymarket.stallsObserved, feed);
    add("recorder_feed_problems_routed_total", polymarket.problemsRouted, feed);
    add("recorder_polymarket_snapshot_recoveries_total", polymarket.snapshotRecoveries);
    add("recorder_polymarket_snapshot_fetch_failures_total", polymarket.snapshotFetchFailures);
    add("recorder_polymarket_resync_rejections_total", polymarket.resyncRejections);
  }

  const rtds = snapshot.rtds;
  if (rtds !== undefined) {
    const feed = { feed: "rtds" };
    add("recorder_feed_frames_recorded_total", rtds.framesRecorded, feed);
    add("recorder_feed_frames_refused_by_wal_total", rtds.framesRefusedByWal, feed);
    add("recorder_feed_dispatched_total", rtds.observationsDispatched, feed);
    add(
      "recorder_feed_suppressed_unrecorded_total",
      rtds.observationsSuppressedAfterGap,
      feed,
    );
    add("recorder_feed_stalls_observed_total", rtds.stallsObserved, feed);
    add("recorder_feed_problems_routed_total", rtds.problemsRouted, feed);
    add("recorder_rtds_halted", bool(rtds.halted));
    add(
      "recorder_rtds_observations_suppressed_after_gap_total",
      rtds.observationsSuppressedAfterGap,
    );
    add("recorder_rtds_coverage_breaks_total", rtds.coverageBreaks);
    add("recorder_rtds_freshness_failures_total", rtds.freshnessFailures);
    add("recorder_rtds_out_of_order_observations_total", rtds.outOfOrderObservations);
    add(
      "recorder_rtds_unrecoverable_gaps_acknowledged_total",
      rtds.unrecoverableGapsAcknowledged,
    );
    add(
      "recorder_rtds_gap_acknowledgement_rejections_total",
      rtds.gapAcknowledgementRejections,
    );
    add("recorder_rtds_first_observations_total", rtds.firstObservations);
    add("recorder_rtds_unplanned_symbol_observations_total", rtds.unplannedSymbolObservations);
  }

  const binance = snapshot.binance;
  if (binance !== undefined) {
    const feed = { feed: "binance" };
    add("recorder_feed_frames_recorded_total", binance.framesRecorded, feed);
    add("recorder_feed_frames_refused_by_wal_total", binance.framesRefusedByWal, feed);
    add("recorder_feed_dispatched_total", binance.emissionsDispatched, feed);
    add(
      "recorder_feed_suppressed_unrecorded_total",
      binance.emissionsSuppressedUnrecorded,
      feed,
    );
    add("recorder_feed_stalls_observed_total", binance.stallsObserved, feed);
    if (binance.pendingConnectionId !== undefined) {
      add("recorder_feed_pending_connection_info", 1, {
        feed: "binance",
        connection_id: binance.pendingConnectionId,
      });
    }
    add("recorder_binance_reconnects_scheduled_total", binance.reconnectsScheduled);
    add("recorder_binance_rejected_socket_events_total", binance.rejectedSocketEvents);
    add("recorder_binance_unauthorized_socket_events_total", binance.unauthorizedSocketEvents);
    add("recorder_binance_pending_close_failures_total", binance.pendingCloseFailures);
    add("recorder_binance_directive_stops_total", binance.directiveStops);
    add(
      "recorder_binance_waited_on_outstanding_attempt_total",
      binance.waitedOnOutstandingAttempt,
    );
  }

  const coinbase = snapshot.coinbase;
  if (coinbase !== undefined) {
    const feed = { feed: "coinbase" };
    add("recorder_feed_frames_recorded_total", coinbase.framesRecorded, feed);
    add("recorder_feed_frames_refused_by_wal_total", coinbase.framesRefusedByWal, feed);
    add("recorder_feed_dispatched_total", coinbase.eventsDispatched, feed);
    add("recorder_feed_suppressed_unrecorded_total", coinbase.eventsSuppressedUnrecorded, feed);
    add("recorder_coinbase_binary_frames_unrecorded_total", coinbase.binaryFramesUnrecorded);
    add(
      "recorder_coinbase_frames_without_established_provenance_total",
      coinbase.framesWithoutEstablishedProvenance,
    );
    add("recorder_coinbase_anomalies_routed_total", coinbase.anomaliesRouted);
    add("recorder_coinbase_snapshot_escalations_total", coinbase.snapshotEscalations);
    add(
      "recorder_coinbase_reconnect_loop_escalations_total",
      coinbase.reconnectLoopEscalations,
    );
  }

  return samples;
}

/** Samples for a `ResearchWorkerMetrics` snapshot. */
export function compactionMetricSamples(
  snapshot: RecorderCompactionMetricsInput,
): readonly MetricSample[] {
  const samples: MetricSample[] = [];
  const add = (name: string, value: number | null, labels?: MetricLabels): void => {
    if (value === null) {
      return;
    }
    samples.push(labels === undefined ? { name, value } : { name, value, labels });
  };
  add("recorder_compaction_cycles_started_total", snapshot.cyclesStarted);
  add("recorder_compaction_cycles_succeeded_total", snapshot.cyclesSucceeded);
  add("recorder_compaction_cycles_failed_total", snapshot.cyclesFailed);
  add("recorder_compaction_lag_ms", snapshot.compactionLagMs);
  add("recorder_compaction_last_cycle_segments_compacted", snapshot.lastCycleSegmentsCompacted);
  add("recorder_compaction_last_cycle_segments_refused", snapshot.lastCycleSegmentsRefused);
  add("recorder_compaction_last_cycle_rows_written", snapshot.lastCycleRowsWritten);
  add("recorder_compaction_last_cycle_object_bytes", snapshot.lastCycleObjectBytes);
  add("recorder_compaction_last_cycle_segments_deleted", snapshot.lastCycleSegmentsDeleted);
  add("recorder_compaction_last_cycle_retention_failures", snapshot.lastCycleRetentionFailures);
  add("recorder_compaction_last_cycle_duration_ms", snapshot.lastCycleDurationMs);
  add("recorder_compaction_segments_compacted_total", snapshot.totalSegmentsCompacted);
  add("recorder_compaction_rows_written_total", snapshot.totalRowsWritten);
  add("recorder_compaction_object_bytes_total", snapshot.totalObjectBytes);
  add("recorder_compaction_segments_deleted_total", snapshot.totalSegmentsDeleted);
  for (const status of ["idle", "succeeded", "failed"] as const) {
    add("recorder_upload_status", bool(snapshot.objectUploadStatus === status), { status });
  }
  add("recorder_upload_failed", bool(snapshot.objectUploadStatus === "failed"));
  return samples;
}

/** Samples for a dataset-validation outcome (see `validation-findings.ts`). */
export function validationMetricSamples(
  input: ValidationMetricsInput,
): readonly MetricSample[] {
  const samples: MetricSample[] = [];
  samples.push({
    name: "recorder_validation_ok",
    value: bool(input.ok),
    labels: { job: input.job },
  });
  const counts = new Map<string, number>();
  for (const finding of input.findings) {
    const key = `${finding.check}\u0000${finding.severity}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const [key, count] of counts) {
    const [check = "", severity = ""] = key.split("\u0000");
    samples.push({
      name: "recorder_validation_findings",
      value: count,
      labels: { job: input.job, class: check, severity },
    });
  }
  return samples;
}

/** Samples for a soak-evidence evaluation (see `soak-evidence.ts`). */
export function soakMetricSamples(evaluation: SoakEvaluation): readonly MetricSample[] {
  const samples: MetricSample[] = [];
  for (const status of ["PENDING", "QUALIFYING_WINDOW_FOUND", "INVALID"] as const) {
    samples.push({
      name: "recorder_soak_status_info",
      value: bool(evaluation.status === status),
      labels: { status },
    });
  }
  samples.push({ name: "recorder_soak_longest_window_ms", value: evaluation.longestWindowMs });
  samples.push({ name: "recorder_soak_threshold_ms", value: evaluation.thresholdMs });
  samples.push({ name: "recorder_soak_windows_total", value: evaluation.validWindows });
  return samples;
}

export interface RecorderMetricsSnapshot {
  readonly gateway?: RecorderGatewayMetricsInput | undefined;
  readonly compaction?: RecorderCompactionMetricsInput | undefined;
  readonly validation?: readonly ValidationMetricsInput[] | undefined;
  readonly soak?: SoakEvaluation | undefined;
}

/** Render everything available into one exposition document. */
export function renderRecorderMetrics(snapshot: RecorderMetricsSnapshot): string {
  const samples: MetricSample[] = [];
  if (snapshot.gateway !== undefined) {
    samples.push(...gatewayMetricSamples(snapshot.gateway));
  }
  if (snapshot.compaction !== undefined) {
    samples.push(...compactionMetricSamples(snapshot.compaction));
  }
  for (const validation of snapshot.validation ?? []) {
    samples.push(...validationMetricSamples(validation));
  }
  if (snapshot.soak !== undefined) {
    samples.push(...soakMetricSamples(snapshot.soak));
  }
  return renderExposition(samples);
}
