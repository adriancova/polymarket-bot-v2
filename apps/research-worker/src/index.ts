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

// --- STORAGE-1: research tier, pins, verified raw expiry (ADR-028, ADR-029) ---
export {
  FrameInterpreter,
  isPolymarketMarketChannel,
  type Interpretation,
  type Level,
  type Observation,
} from "./research-tier/interpret.js";
export {
  FULL_BOOK_SPAN_MS,
  REFERENCE_TRADE_DEDUPE_WINDOW,
  RESEARCH_DOWNSAMPLING,
  ResearchSampler,
  SAMPLER_STATE_VERSION,
  SPAN_MS,
  compareCanonical,
  decodeSamplerState,
  encodeSamplerState,
  epochMsOf,
  type SamplerCounts,
  type SamplerState,
} from "./research-tier/sampler.js";
export {
  verifySegmentForExtraction,
  type RefusedSegment,
  type VerifiedSegment,
} from "./research-tier/segment-verify.js";
export {
  SAFE_IDENTIFIER,
  inventoryWalRoot,
  type InventoriedSegment,
  type UnreadableSegment,
  type WalInventory,
} from "./research-tier/inventory.js";
export {
  RESEARCH_KEY_PREFIX,
  RESEARCH_POINTER_VERSION,
  extractResearchTier,
  readResearchPointer,
  researchPointerKey,
  type ExtractionOptions,
  type ExtractionResult,
  type ResearchPointer,
} from "./research-tier/extract.js";
export {
  OPERATOR_PIN_VERSION,
  WINDOW_REGISTRY_VERSION,
  WindowRegistryError,
  loadOperatorPins,
  loadWindowRegistry,
  parseOperatorPins,
  parseWindowRegistry,
  type MarketWindow,
  type OperatorPin,
  type WindowResponsibility,
} from "./retention/windows.js";
export {
  NON_FILL_PIN_RETENTION_MS,
  classifyWindow,
  pinRetentionMs,
  potentialRange,
  staticEvidenceSource,
  type ClassifyOptions,
  type IntentEvidence,
  type MarketEvidence,
  type PinClass,
  type TraderEvidenceSource,
  type WindowClassification,
} from "./retention/classify.js";
export { postgresTraderEvidence } from "./retention/evidence-postgres.js";
export {
  PIN_KEY_PREFIX,
  PIN_RECORD_VERSION,
  extractPin,
  overlaps,
  pinRecordKey,
  pinSpecs,
  pointerSpan,
  readPinRecord,
  verifyPinManifests,
  windowPinId,
  type PinDataset,
  type PinExtractionContext,
  type PinOutcome,
  type PinRecord,
  type PinSpec,
} from "./retention/pins.js";
export {
  RAW_RETENTION_MS,
  planExpiry,
  reasonClass,
  type ExpiryPlanningInput,
  type SegmentDecision,
} from "./retention/plan.js";
export {
  EXPIRY_PLAN_DIRECTORY,
  EXPIRY_PLAN_VERSION,
  buildExpiryPlan,
  encodeExpiryPlan,
  executeExpiryPlan,
  expiryReceiptKey,
  listExpiryPlanIds,
  persistExpiryPlan,
  type ExpiryPlan,
  type ExpiryRunResult,
} from "./retention/execute.js";
export {
  DEFAULT_PIN_BUDGET_BYTES_PER_DAY,
  DISK_ALARM_FRACTION,
  WAL_CAPACITY_ALARM_FRACTION,
  diskMetrics,
  expiryLagMs,
  pinBudget,
  storageMetrics,
  type DiskMetrics,
  type StorageMetrics,
} from "./retention/metrics.js";
export {
  runStorageCycle,
  type ExpiryMode,
  type StorageCycleDependencies,
  type StorageCycleReport,
  type StorageSettings,
} from "./retention/cycle.js";
export { loadStorageConfig, type StorageConfig } from "./storage-config.js";
export { storageMain, summarizeStorageReport } from "./storage-main.js";
