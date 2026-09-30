/**
 * `@polymarket-bot/backtest-cli` — WP-210's composition root.
 *
 * A layer-3 application (`docs/contracts/dependency-direction.md` §2): it is the
 * one place where the layer-1 simulation package meets layer-2 adapters
 * (`@polymarket-bot/storage-parquet` for the archived rows,
 * `@polymarket-bot/polymarket-public` for the venue normalizer) and Node
 * built-ins (`node:fs`, `node:crypto`). Since `BACKTEST-2` it also depends on
 * the layer-1 shared trading core (`@polymarket-bot/trading-core`, ADR-022)
 * and builds it itself (`assembly.ts`), so its `run` command backtests the
 * core the paper trader runs.
 *
 * SAFETY (§11, §6 invariant 17, ADR-010, `AGENTS.md`): `BACKTEST` mode,
 * simulated venue, no credentials, no venue connection, no signer, no order.
 * `MAX_RUN_MODE`, `ALLOW_REAL_ORDERS` and both live-micro caps are treated as a
 * FLOOR by {@link ./safety.js}, which refuses to start under a raised one or in
 * an environment carrying anything that looks like a key.
 */

export {
  BACKTEST_RUN_MODE,
  CREDENTIAL_NAME_PATTERNS,
  checkBacktestSafety,
} from "./safety.js";
export type { SafetyOutcome, SafetyViolation } from "./safety.js";

export {
  fileSystemArchiveReader,
  fileSystemWalSegmentReader,
  readManifestBytes,
  resolveWithinRoot,
  sha256Hex,
} from "./archive.js";

export {
  NORMALIZED_ENVELOPE_NORMALIZER_VERSION,
  POLYMARKET_MARKET_NORMALIZER_VERSION,
  RECORDED_FRAME_NORMALIZER_VERSION,
  normalizedEnvelopeNormalizer,
  polymarketMarketNormalizer,
  recordedFrameNormalizer,
} from "./normalizer.js";
export type { PolymarketNormalizerOptions } from "./normalizer.js";

export { endOfRunBoundTo, recordFraming, replayDrivenCoreLoop } from "./core-loop.js";
export type {
  ReplayFraming,
  ReplayDriverHalts,
  ReplayDriverObservations,
  ReplayDrivenCoreLoop,
  ReplayDrivenCoreLoopOptions,
  ReplayDrivenLoop,
  ReplayIngestedEvent,
} from "./core-loop.js";

export {
  DATASET_MANIFEST_OBJECT_NAME,
  renderBacktestOutcome,
  runBacktest,
} from "./run.js";
export type { BacktestOutcome, BacktestRunOptions } from "./run.js";

export {
  BACKTEST_CORE_RUN_MODE,
  assembleBacktestCore,
  checkBacktestCoreSafety,
  defaultIdNamespace,
  reconcileRunPinsWithCoreConfig,
  runBacktestCore,
} from "./assembly.js";
export type {
  BacktestCore,
  BacktestCoreAssembly,
  BacktestCoreOptions,
  BacktestCoreRun,
  BacktestCoreRunOptions,
  BacktestCoreRunResult,
  BacktestRefusal,
} from "./assembly.js";

export { BACKTEST_ARTIFACT_FORMAT_ID, renderBacktestArtifact } from "./artifact.js";
export type { BacktestArtifact, BacktestArtifactInput } from "./artifact.js";
