/**
 * Recorder observability (`WP-140`): metrics export, validation-finding
 * classes, the book snapshot comparison, and soak-evidence evaluation.
 *
 * Pure application-module code (layer 1, `docs/contracts/dependency-direction.md`
 * §2): no I/O, no network listener, no workspace dependency. Producers hand
 * their exported metric snapshots in; exposition text and reports come out.
 *
 * NOTE: `packages/observability/src/index.ts` (the package entry point) is a
 * `WP-010` scaffold outside `WP-140`'s allowed paths, so this module is not
 * re-exported from it yet. Consumers inside the repository (the soak harness)
 * import it by path alias; wiring `export * from "./recorder/index.js"` into
 * the package entry is recorded as a follow-up in `docs/handoffs/WP-140.md`.
 */

export type {
  RecorderBinanceFeedMetricsInput,
  RecorderCoinbaseFeedMetricsInput,
  RecorderCompactionMetricsInput,
  RecorderDirectoryMetricsInput,
  RecorderDispatcherMetricsInput,
  RecorderGatewayMetricsInput,
  RecorderIncidentMetricsInput,
  RecorderPolymarketFeedMetricsInput,
  RecorderPublicationHaltInput,
  RecorderPublisherMetricsInput,
  RecorderRtdsFeedMetricsInput,
  RecorderUploadStatusInput,
  RecorderWalMetricsInput,
  RecorderWalQueueMetricsInput,
} from "./metric-shapes.js";

export {
  ACCEPTANCE_1_CATEGORIES,
  RECORDER_METRIC_FAMILIES,
  recorderMetricFamily,
  recorderMetricNames,
  recorderMetricNamesByCategory,
} from "./metric-families.js";
export type {
  RecorderMetricCategory,
  RecorderMetricFamily,
  RecorderMetricType,
} from "./metric-families.js";

export {
  compactionMetricSamples,
  gatewayMetricSamples,
  renderExposition,
  renderRecorderMetrics,
  soakMetricSamples,
  validationMetricSamples,
} from "./render.js";
export type { MetricLabels, MetricSample, RecorderMetricsSnapshot } from "./render.js";

export {
  BOOK_COMPARISON_FINDING_CLASSES,
  DATASET_VALIDATION_FINDING_CLASSES,
  KNOWN_VALIDATION_FINDING_CLASSES,
} from "./validation-findings.js";
export type {
  ValidationFindingInput,
  ValidationMetricsInput,
} from "./validation-findings.js";

export { canonicalDecimal, compareRecordedBooks } from "./book-comparison.js";
export type {
  BookComparisonFinding,
  BookComparisonReport,
  RecordedFrameInput,
} from "./book-comparison.js";

export {
  SOAK_ELAPSED_EVIDENCE_THRESHOLD_MS,
  SOAK_ELAPSED_TOLERANCE_MS,
  SOAK_EVIDENCE_KIND,
  SOAK_EVIDENCE_SCHEMA_VERSION,
  SOAK_FUTURE_SKEW_TOLERANCE_MS,
  disqualifyingReason,
  evaluateSoakEvidence,
  parseSoakWindowEvidence,
} from "./soak-evidence.js";
export type {
  SoakEvaluation,
  SoakExitEvidence,
  SoakObservedEvidence,
  SoakStatus,
  SoakWalEvidence,
  SoakWindowEvidence,
} from "./soak-evidence.js";
