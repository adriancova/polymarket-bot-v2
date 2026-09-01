/**
 * `@polymarket-bot/research-worker` — the process that compacts WAL segments
 * into checksummed Parquet and immutable dataset manifests (`WP-130`).
 *
 * Handoff §4.1 gives this process its job: "Compacts WAL segments, creates
 * Parquet manifests, computes offline metrics, and runs Python research jobs."
 * `WP-130` delivers the first two. The offline metrics and the Python research
 * jobs arrive with their own work packages and attach to this loop.
 *
 * Layer 3 (composition root). It wires `@polymarket-bot/storage-parquet` to a
 * filesystem object store, a clock, and a retention policy. It holds no
 * credential, opens no socket, and places no order.
 *
 * Run it with `pnpm --filter @polymarket-bot/research-worker start`, which
 * requires at minimum:
 *
 * ```text
 * RESEARCH_WORKER_WAL_DIR=/var/lib/polymarket-bot/wal
 * RESEARCH_WORKER_OBJECT_STORE_ROOT=/var/lib/polymarket-bot/objects
 * ```
 */

export {
  loadResearchWorkerConfig,
  ResearchWorkerConfigurationError,
  type ResearchWorkerConfig,
  type RetentionPolicyName,
} from "./config.js";

export {
  IncidentWindowFileError,
  loadIncidentWindows,
  parseIncidentWindowDocument,
} from "./incident-windows.js";

export {
  MetricsRecorder,
  type ObjectUploadStatus,
  type ResearchWorkerMetrics,
} from "./metrics.js";

export {
  abortableSleep,
  datasetIdForCycle,
  runCompactionCycle,
  runResearchWorker,
  type CycleOutcome,
  type ResearchWorkerDependencies,
  type ResearchWorkerRunResult,
} from "./worker.js";

export { main } from "./main.js";
