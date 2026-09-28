/**
 * `@polymarket-bot/backtest-cli` — WP-210's composition root.
 *
 * A layer-3 application (`docs/contracts/dependency-direction.md` §2): it is the
 * one place where the layer-1 simulation package meets layer-2 adapters
 * (`@polymarket-bot/storage-parquet` for the archived rows,
 * `@polymarket-bot/polymarket-public` for the venue normalizer) and Node
 * built-ins (`node:fs`, `node:crypto`).
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

export { endOfRunBoundTo, replayDrivenCoreLoop } from "./core-loop.js";
export type {
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
