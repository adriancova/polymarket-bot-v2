/**
 * Test doubles for the WAL, published on the `./testing` subpath.
 *
 * Nothing here is re-exported from the package barrel: a production composition
 * root cannot reach an in-memory filesystem or a hand-driven clock by importing
 * `@polymarket-bot/storage-wal`.
 */

export {
  createMemoryFileSystem,
  type MemoryFileSystem,
  type MemoryFileSystemStats,
} from "./memory-file-system.js";
export {
  createManualClock,
  DEFAULT_TEST_EPOCH_MS,
  type ManualClock,
  type ManualClockOptions,
} from "./manual-clock.js";
export {
  createTestFrame,
  createTestFrames,
  TEST_GATEWAY_EPOCH,
  type TestFrameOverrides,
} from "./frames.js";
