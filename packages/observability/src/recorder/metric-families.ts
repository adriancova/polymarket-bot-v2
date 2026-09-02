/**
 * The canonical recorder metric-family table (`WP-140`).
 *
 * Single source of truth for every metric the recorder exporter can emit.
 * The renderers in `render.ts` refuse to emit a sample whose family is not
 * listed here, the dashboard-consistency test asserts every Grafana panel and
 * Prometheus alert expression binds only to names in this table, and the
 * acceptance-1 check ("queue depth, lag, gaps, fsync, compaction, and upload
 * status") is evaluated over the `category` column — so acceptance 1 is
 * machine-checked, not eyeballed.
 *
 * Naming: Prometheus conventions — `snake_case`, unit suffixes (`_ms`,
 * `_bytes`), monotonic counters end in `_total`. Everything is prefixed
 * `recorder_` (§14.3's "recorder" family).
 */

export type RecorderMetricType = "gauge" | "counter";

/**
 * Signal categories. The first six are the acceptance-1 set, verbatim from
 * the work plan: "Dashboard exposes queue depth, lag, gaps, fsync,
 * compaction, and upload status."
 */
export type RecorderMetricCategory =
  | "queue-depth"
  | "lag"
  | "gaps"
  | "fsync"
  | "compaction"
  | "upload"
  | "wal"
  | "publication"
  | "feeds"
  | "incidents"
  | "directory"
  | "validation"
  | "soak";

/** The acceptance-1 categories, in the work plan's order. */
export const ACCEPTANCE_1_CATEGORIES: readonly RecorderMetricCategory[] = [
  "queue-depth",
  "lag",
  "gaps",
  "fsync",
  "compaction",
  "upload",
];

export interface RecorderMetricFamily {
  readonly name: string;
  readonly type: RecorderMetricType;
  readonly category: RecorderMetricCategory;
  readonly help: string;
  /** Label keys this family may carry; the renderer refuses others. */
  readonly labels?: readonly string[];
}

const family = (
  name: string,
  type: RecorderMetricType,
  category: RecorderMetricCategory,
  help: string,
  labels?: readonly string[],
): RecorderMetricFamily =>
  labels === undefined ? { name, type, category, help } : { name, type, category, help, labels };

/**
 * Every family the exporter can emit. Order here is render order.
 */
export const RECORDER_METRIC_FAMILIES: readonly RecorderMetricFamily[] = [
  // --- WAL queue (§8.3 / §14.3 "WAL queue depth") -------------------------
  family("recorder_wal_queue_depth", "gauge", "queue-depth", "WAL queue current depth (frames accepted, not yet handed to the segment writer)."),
  family("recorder_wal_queue_max_depth", "gauge", "queue-depth", "Configured WAL queue depth bound."),
  family("recorder_wal_queue_high_water_depth", "gauge", "queue-depth", "Greatest WAL queue depth observed since start."),
  family("recorder_wal_queue_byte_depth", "gauge", "queue-depth", "WAL queue current byte depth."),
  family("recorder_wal_queue_max_byte_depth", "gauge", "queue-depth", "Configured WAL queue byte bound."),
  family("recorder_wal_queue_oldest_message_age_ms", "gauge", "lag", "Age of the oldest queued WAL frame, in milliseconds (0 when empty)."),
  family("recorder_wal_queue_consumer_lag", "gauge", "lag", "WAL frames accepted but not yet handed to the segment writer."),
  family("recorder_wal_queue_messages_dropped_total", "counter", "gaps", "Frames the WAL queue refused AND the caller acknowledged discarding. Must stay 0; any increase is recorded data loss."),
  family("recorder_wal_queue_overflow_signals_total", "counter", "queue-depth", "WAL queue overflow signals (refusals at the bound; a halt signal, never a drop)."),

  // --- WAL writer (§14.3 recorder family) ---------------------------------
  family("recorder_wal_faulted", "gauge", "wal", "1 when the WAL writer is in the faulted state, else 0."),
  family("recorder_wal_closed", "gauge", "wal", "1 when the WAL writer is closed, else 0."),
  family("recorder_wal_active_segment_age_ms", "gauge", "lag", "Age of the active WAL segment in milliseconds (§14.3 segment age). Absent when no segment is open."),
  family("recorder_wal_active_segment_records", "gauge", "wal", "Records in the active WAL segment."),
  family("recorder_wal_active_segment_bytes", "gauge", "wal", "Bytes in the active WAL segment."),
  family("recorder_wal_segments_opened_total", "counter", "wal", "WAL segments opened."),
  family("recorder_wal_segments_finalized_total", "counter", "wal", "WAL segments finalized (footer + manifest written)."),
  family("recorder_wal_rotations_total", "counter", "wal", "WAL segment rotations."),
  family("recorder_wal_frames_accepted_total", "counter", "wal", "Frames accepted into the WAL path."),
  family("recorder_wal_frames_written_total", "counter", "wal", "Frames appended to a segment."),
  family("recorder_wal_frames_durable_total", "counter", "fsync", "Frames proven durable by an fsync."),
  family("recorder_wal_bytes_written_total", "counter", "wal", "Bytes written to WAL segments (§14.3 bytes written)."),
  family("recorder_wal_bytes_unsynced", "gauge", "fsync", "Bytes appended but not yet covered by an fsync."),
  family("recorder_wal_records_unsynced", "gauge", "fsync", "Records appended but not yet covered by an fsync."),
  family("recorder_wal_fsync_total", "counter", "fsync", "Number of fsyncs performed."),
  family("recorder_wal_fsync_last_duration_ms", "gauge", "fsync", "Duration of the last fsync in milliseconds (§14.3 fsync latency). Absent before the first fsync."),
  family("recorder_wal_fsync_total_duration_ms", "counter", "fsync", "Cumulative fsync time in milliseconds."),
  family("recorder_wal_ms_since_last_fsync", "gauge", "fsync", "Milliseconds since the last fsync. Absent before the first fsync."),
  family("recorder_wal_data_loss_bound_ms", "gauge", "fsync", "The configured fsync interval, restated as what it is: the data-loss bound (ADR-004 §3)."),
  family("recorder_wal_unproven_frame_count", "gauge", "fsync", "Frames in the active segment whose durability no fsync has proven yet — what a power loss would cost right now."),
  family("recorder_wal_retained_record_count", "gauge", "wal", "Records of the active segment no manifest names yet (the writer is still answerable for them)."),
  family("recorder_wal_unmanifested_faulted_segments", "gauge", "gaps", "Segments the writer faulted on and could not prove durable. Each one is a data-quality incident until recovery finalizes it."),
  family("recorder_wal_total_segment_bytes", "gauge", "wal", "Total bytes of WAL segments on disk."),
  family("recorder_wal_capacity_bytes", "gauge", "wal", "Configured WAL capacity in bytes. Absent when unbounded."),
  family("recorder_wal_capacity_remaining_bytes", "gauge", "wal", "Frame bytes still admissible under the WAL capacity. Absent when unbounded."),
  family("recorder_wal_capacity_refusals_total", "counter", "gaps", "Frames refused because WAL capacity was exhausted."),
  family("recorder_wal_closed_refusals_total", "counter", "gaps", "Frames refused because the writer was closed."),
  family("recorder_wal_faulted_refusals_total", "counter", "gaps", "Frames refused because the writer was faulted."),
  family("recorder_wal_validation_rejections_total", "counter", "gaps", "Frames rejected by WAL record validation."),
  family("recorder_wal_write_faults_total", "counter", "gaps", "WAL write faults."),
  family("recorder_wal_pending_frame_count", "gauge", "wal", "Frames a fault handed back and recovery has not yet resolved."),

  // --- Publisher (§14.3 queue metrics; WP-120 round-1 obligations) --------
  family("recorder_publisher_published_total", "counter", "publication", "Envelopes published to the event transport."),
  family("recorder_publisher_duplicates_refused_total", "counter", "publication", "Duplicate identities refused by the publisher."),
  family("recorder_publisher_suppressed_while_halted_total", "counter", "publication", "Envelopes suppressed because publication is halted (recording continues)."),
  family("recorder_publisher_rejected_by_transport_total", "counter", "publication", "Envelopes the transport refused for a non-outage reason."),
  family("recorder_publisher_admission_refusals_total", "counter", "queue-depth", "Envelopes refused at admission because the publish queue was full. Any increase precedes/accompanies a terminal halt."),
  family("recorder_publisher_halted", "gauge", "publication", "1 when publication is halted (terminal for the epoch), else 0."),
  family("recorder_publisher_halt_info", "gauge", "publication", "1, labeled with the halt cause, while publication is halted.", ["cause"]),
  family("recorder_publisher_queue_depth", "gauge", "queue-depth", "Publish admission queue depth: envelopes admitted and not yet submitted (§14.3)."),
  family("recorder_publisher_queue_max_depth_observed", "gauge", "queue-depth", "High-water mark of the publish queue depth."),
  family("recorder_publisher_queue_max_depth", "gauge", "queue-depth", "Configured publish queue depth bound — crossing it is a terminal halt."),
  family("recorder_publisher_queue_bytes", "gauge", "queue-depth", "Publish admission queue bytes."),
  family("recorder_publisher_queue_max_bytes_observed", "gauge", "queue-depth", "High-water mark of the publish queue bytes."),
  family("recorder_publisher_queue_max_bytes", "gauge", "queue-depth", "Configured publish queue byte bound — crossing it is a terminal halt."),
  family("recorder_publisher_oldest_queued_age_ms", "gauge", "lag", "How long the publish-queue head has waited, in milliseconds. Alarm on this BEFORE the depth/byte bound is reached: the bound is a halt."),

  // --- Dispatcher ----------------------------------------------------------
  family("recorder_dispatcher_dispatched_total", "counter", "publication", "Events dispatched by the gateway dispatcher."),
  family("recorder_dispatcher_envelope_rejections_total", "counter", "publication", "Envelope assignments rejected by the dispatcher."),

  // --- Incidents (data-quality; §14.3 "data-quality incidents") ------------
  family("recorder_incidents_opened_total", "counter", "incidents", "Data-quality incidents opened."),
  family("recorder_incidents_repeats_suppressed_total", "counter", "incidents", "Incident repeats suppressed by the registry."),
  family("recorder_incidents_tracked_keys", "gauge", "incidents", "Incident keys currently tracked."),
  family("recorder_incidents_evicted_keys_total", "counter", "incidents", "Incident keys evicted by the registry bound."),

  // --- Universe directory --------------------------------------------------
  family("recorder_directory_known_markets", "gauge", "directory", "Markets known to the reviewed universe directory."),
  family("recorder_directory_declined_registrations_total", "counter", "directory", "Announced-but-unreviewed market registrations declined."),
  family("recorder_directory_declined_registrations_retained", "gauge", "directory", "Declined registrations still readable by an operator."),
  family("recorder_directory_declined_registrations_evicted_total", "counter", "directory", "Declined registrations dropped by the bounded memory."),
  family("recorder_directory_declined_registrations_capacity", "gauge", "directory", "The declined-registration retention bound."),
  family("recorder_directory_parameter_versions_assigned_total", "counter", "directory", "Market parameter versions assigned."),
  family("recorder_directory_parameter_assignments_declined_total", "counter", "directory", "Market parameter assignments declined."),

  // --- Feeds (labeled by feed where the shape is shared) -------------------
  family("recorder_feed_frames_recorded_total", "counter", "feeds", "Raw frames recorded to the WAL, per feed.", ["feed"]),
  family("recorder_feed_frames_refused_by_wal_total", "counter", "gaps", "Raw frames the WAL refused, per feed. Any increase means the raw record is incomplete.", ["feed"]),
  family("recorder_feed_dispatched_total", "counter", "feeds", "Normalized events/observations/emissions dispatched, per feed.", ["feed"]),
  family("recorder_feed_suppressed_unrecorded_total", "counter", "gaps", "Normalized events suppressed because their raw frame was not recorded (raw-before-publish), per feed.", ["feed"]),
  family("recorder_feed_stalls_observed_total", "counter", "gaps", "Per-connection staleness detections, per feed (§14.3 staleness).", ["feed"]),
  family("recorder_feed_problems_routed_total", "counter", "feeds", "Feed problems routed to the incident path, per feed.", ["feed"]),
  family("recorder_feed_pending_connection_info", "gauge", "feeds", "1, labeled with the connection id, while a feed waits on an in-flight connection attempt.", ["feed", "connection_id"]),
  // Polymarket-specific gap machinery (§7.1 gap -> authoritative snapshot).
  family("recorder_polymarket_snapshot_recoveries_total", "counter", "gaps", "Gap recoveries completed via authoritative snapshot (Polymarket)."),
  family("recorder_polymarket_snapshot_fetch_failures_total", "counter", "gaps", "Authoritative snapshot fetch failures (Polymarket)."),
  family("recorder_polymarket_resync_rejections_total", "counter", "gaps", "Stale-generation resync rejections (Polymarket)."),
  // RTDS-specific (ADR-009: an unrecoverable gap halts normalized publication).
  family("recorder_rtds_halted", "gauge", "gaps", "1 once an unrecoverable RTDS gap halted normalized TWAP publication for the epoch, else 0."),
  family("recorder_rtds_observations_suppressed_after_gap_total", "counter", "gaps", "RTDS observations recorded raw but NOT published because the feed is halted."),
  family("recorder_rtds_coverage_breaks_total", "counter", "gaps", "RTDS coverage breaks."),
  family("recorder_rtds_freshness_failures_total", "counter", "gaps", "RTDS freshness failures (§14.3 staleness)."),
  family("recorder_rtds_out_of_order_observations_total", "counter", "gaps", "RTDS out-of-order observations."),
  family("recorder_rtds_unrecoverable_gaps_acknowledged_total", "counter", "gaps", "RTDS unrecoverable gaps acknowledged."),
  family("recorder_rtds_gap_acknowledgement_rejections_total", "counter", "gaps", "RTDS gap acknowledgements rejected."),
  family("recorder_rtds_first_observations_total", "counter", "feeds", "RTDS first observations per symbol."),
  family("recorder_rtds_unplanned_symbol_observations_total", "counter", "feeds", "RTDS observations for symbols outside the subscription plan."),
  // Binance-specific.
  family("recorder_binance_reconnects_scheduled_total", "counter", "gaps", "Binance reconnects scheduled (§14.3 reconnects)."),
  family("recorder_binance_rejected_socket_events_total", "counter", "feeds", "Binance socket events rejected."),
  family("recorder_binance_unauthorized_socket_events_total", "counter", "feeds", "Binance socket events from an unauthorized connection."),
  family("recorder_binance_pending_close_failures_total", "counter", "feeds", "Binance pending-socket close failures."),
  family("recorder_binance_directive_stops_total", "counter", "feeds", "Binance stops commanded by directive."),
  family("recorder_binance_waited_on_outstanding_attempt_total", "counter", "feeds", "Times the Binance driver waited on an outstanding connection attempt."),
  // Coinbase-specific.
  family("recorder_coinbase_binary_frames_unrecorded_total", "counter", "gaps", "Coinbase binary frames that could not be recorded as UTF-8."),
  family("recorder_coinbase_frames_without_established_provenance_total", "counter", "feeds", "Coinbase frames recorded before their socket was adopted (placeholder generation 0)."),
  family("recorder_coinbase_anomalies_routed_total", "counter", "feeds", "Coinbase anomalies routed to the incident path."),
  family("recorder_coinbase_snapshot_escalations_total", "counter", "gaps", "Coinbase snapshot-failure escalations."),
  family("recorder_coinbase_reconnect_loop_escalations_total", "counter", "gaps", "Coinbase reconnect-loop escalations."),

  // --- Compaction (§14.3 "compaction lag"; WP-130 metrics) -----------------
  family("recorder_compaction_cycles_started_total", "counter", "compaction", "Compaction cycles started."),
  family("recorder_compaction_cycles_succeeded_total", "counter", "compaction", "Compaction cycles that completed without throwing."),
  family("recorder_compaction_cycles_failed_total", "counter", "compaction", "Compaction cycles that threw. The WAL is untouched by a failed cycle."),
  family("recorder_compaction_lag_ms", "gauge", "lag", "Age of the oldest segment the last cycle left behind (§14.3 compaction lag). Absent when the last cycle left nothing behind — which is not the same as zero. Combine with recorder_wal_active_segment_age_ms for the whole picture (WP-130 known risk 3)."),
  family("recorder_compaction_last_cycle_segments_compacted", "gauge", "compaction", "Segments verified and compacted by the last cycle."),
  family("recorder_compaction_last_cycle_segments_refused", "gauge", "compaction", "Segments the last cycle refused (and therefore excluded)."),
  family("recorder_compaction_last_cycle_rows_written", "gauge", "compaction", "Rows written by the last cycle."),
  family("recorder_compaction_last_cycle_object_bytes", "gauge", "compaction", "Object bytes uploaded and verified by the last cycle."),
  family("recorder_compaction_last_cycle_segments_deleted", "gauge", "compaction", "WAL segments deleted by the last cycle after verification."),
  family("recorder_compaction_last_cycle_retention_failures", "gauge", "compaction", "Segment deletions that failed in the last cycle (a disk-space problem, not a data one)."),
  family("recorder_compaction_last_cycle_duration_ms", "gauge", "compaction", "Duration of the last compaction cycle in milliseconds."),
  family("recorder_compaction_segments_compacted_total", "counter", "compaction", "Segments compacted over the process lifetime."),
  family("recorder_compaction_rows_written_total", "counter", "compaction", "Rows written over the process lifetime."),
  family("recorder_compaction_object_bytes_total", "counter", "compaction", "Object bytes uploaded over the process lifetime."),
  family("recorder_compaction_segments_deleted_total", "counter", "compaction", "WAL segments deleted over the process lifetime."),

  // --- Upload status (§14.3 "object upload status") ------------------------
  family("recorder_upload_status", "gauge", "upload", "One-hot object upload status of the last completed cycle: exactly one of idle/succeeded/failed is 1.", ["status"]),
  family("recorder_upload_failed", "gauge", "upload", "1 when the last completed compaction cycle failed to upload, else 0. Alert on this."),

  // --- Dataset validation (WP-130 validator finding classes) ---------------
  family("recorder_validation_ok", "gauge", "validation", "1 when the last dataset validation reported no error findings, else 0.", ["job"]),
  family("recorder_validation_findings", "gauge", "validation", "Findings by class from the last validation run (the WP-130 validator's classes plus the book-comparison classes).", ["job", "class", "severity"]),

  // --- Soak evidence (external-evidence gate; honesty machinery) -----------
  family("recorder_soak_status_info", "gauge", "soak", "One-hot soak evidence status: PENDING until real elapsed evidence meets the threshold; QUALIFYING_WINDOW_FOUND when a structurally qualifying CANDIDATE window exists (provenance unverified — completing the external-evidence gate is a governance act recorded in IMPLEMENTATION_STATUS.md, never a value of this metric); INVALID if any evidence record fails validation.", ["status"]),
  family("recorder_soak_longest_window_ms", "gauge", "soak", "Longest claimed contiguous recording window in the evidence set, in milliseconds (recorded by the harness, internally cross-checked; provenance unverified)."),
  family("recorder_soak_threshold_ms", "gauge", "soak", "The real-elapsed threshold a candidate window must meet to reach QUALIFYING_WINDOW_FOUND."),
  family("recorder_soak_windows_total", "counter", "soak", "Valid evidence windows recorded."),
];

const familiesByName = new Map<string, RecorderMetricFamily>(
  RECORDER_METRIC_FAMILIES.map((entry) => [entry.name, entry]),
);

if (familiesByName.size !== RECORDER_METRIC_FAMILIES.length) {
  // A duplicate family name would make the table ambiguous as a contract.
  // This is a programming error in this module, so it fails at load, loudly.
  throw new Error("RECORDER_METRIC_FAMILIES contains a duplicate metric name");
}

/** Look up a family by name; `undefined` when the name is not in the table. */
export function recorderMetricFamily(name: string): RecorderMetricFamily | undefined {
  return familiesByName.get(name);
}

/** Every metric name in the table, in render order. */
export function recorderMetricNames(): readonly string[] {
  return RECORDER_METRIC_FAMILIES.map((entry) => entry.name);
}

/** Every metric name in the given category. */
export function recorderMetricNamesByCategory(
  category: RecorderMetricCategory,
): readonly string[] {
  return RECORDER_METRIC_FAMILIES.filter((entry) => entry.category === category).map(
    (entry) => entry.name,
  );
}
