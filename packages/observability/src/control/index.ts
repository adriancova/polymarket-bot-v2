/**
 * Control-plane observability (`WP-240`): the platform metric-family table, the
 * producer→sample mapping, a family-table-generic Prometheus renderer, the
 * append-only control audit surface, the Grafana dashboard contract, and the
 * shared PAPER safety vocabulary.
 *
 * Pure layer-1 application-module code (`docs/contracts/dependency-direction.md`
 * §2): no I/O, no clock, no Node built-in in production source (F17), no
 * workspace dependency. Producers hand snapshots in; exposition text, audit
 * records and refusals come out.
 *
 * The composition root that binds this to a process — an HTTP surface, a
 * PostgreSQL audit sink, a trader health source — is `apps/control-api`.
 */

export {
  PLATFORM_METRIC_FAMILIES,
  platformMetricFamily,
  platformMetricNames,
  platformMetricNamesByCategory,
} from "./metric-families.js";
export type {
  PlatformMetricCategory,
  PlatformMetricFamily,
  PlatformMetricType,
} from "./metric-families.js";

export { renderExpositionFor } from "./exposition.js";
/**
 * Aliased on export. `./recorder` already exports `MetricLabels` and
 * `MetricSample` (structurally identical shapes, `WP-140`), and the package
 * entry re-exports both subtrees; two exports of one name would be ambiguous.
 * Renaming `WP-140`'s is not available to this package — its suites stay
 * untouched — so the newer surface takes the qualified names.
 */
export type {
  MetricFamilyLike,
  MetricLabels as PlatformMetricLabels,
  MetricSample as PlatformMetricSample,
} from "./exposition.js";

export { controlPlaneSamples, traderHealthSamples } from "./samples.js";

export type {
  ControlPlaneMetricsInput,
  TraderAccountingHealthInput,
  TraderExecutionHealthInput,
  TraderHaltInput,
  TraderHealthReportInput,
  TraderLoopHealthInput,
  TraderQueueMetricsInput,
  TraderRiskHealthInput,
  TraderSeamHealthInput,
  TraderTransportHealthInput,
} from "./metric-shapes.js";

export {
  CONTROL_ACTOR_KINDS,
  CONTROL_AUDIT_ACTIONS,
  CONTROL_AUDIT_OUTCOMES,
  InMemoryControlAuditLog,
} from "./audit.js";
export type {
  AuditAppendResult,
  AuditRefusalCode,
  AuditStateDocument,
  ControlActorKind,
  ControlAuditAction,
  ControlAuditOutcome,
  ControlAuditRecord,
  ControlAuditSink,
} from "./audit.js";

export {
  CONTROL_DASHBOARDS,
  PENDING_PRODUCER_MARKER,
  PENDING_PRODUCER_OWNER_MARKER,
  PENDING_PRODUCER_PANELS,
} from "./dashboards.js";
export type { ControlDashboardId, ControlDashboardSpec } from "./dashboards.js";

export {
  ALL_PRODUCTION_NAMES,
  BUILDER_ATTRIBUTION_NAMES,
  CREDENTIAL_NAME_PATTERNS,
  LIVE_MODE_CONTROL_TOKENS,
  PRODUCTION_ACCOUNT_NAMES,
  PRODUCTION_SECRET_NAMES,
  productionNamesInText,
  scanEnvironmentForProductionNames,
} from "./paper-safety.js";
export type { PaperSafetyFinding, PaperSafetyFindingCode } from "./paper-safety.js";
