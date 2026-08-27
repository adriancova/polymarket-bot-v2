/**
 * Shared setup for the WAL fault-injection suite.
 */

import {
  openWalWriter,
  readSegmentRecords,
  segmentFileName,
  validateWalDirectory,
} from "@polymarket-bot/storage-wal";
import type {
  RawFrameRecord,
  WalFileSystem,
  WalSegmentManifest,
  WalWriter,
  WalWriterOptions,
} from "@polymarket-bot/storage-wal";
import {
  createManualClock,
  createMemoryFileSystem,
  TEST_GATEWAY_EPOCH,
} from "@polymarket-bot/storage-wal/testing";
import type { ManualClock, MemoryFileSystem } from "@polymarket-bot/storage-wal/testing";

import { createFaultyFileSystem } from "./faulty-file-system.js";
import type { FaultyFileSystem, FaultyFileSystemOptions } from "./faulty-file-system.js";

export const WAL_DIRECTORY = "/wal";

export type FaultHarness = {
  readonly base: MemoryFileSystem;
  readonly fileSystem: FaultyFileSystem;
  readonly clock: ManualClock;
  open(overrides?: Partial<WalWriterOptions>): Promise<WalWriter>;
};

export function createFaultHarness(faults: FaultyFileSystemOptions = {}): FaultHarness {
  const base = createMemoryFileSystem();
  const fileSystem = createFaultyFileSystem(base, faults);
  const clock = createManualClock();
  return {
    base,
    fileSystem,
    clock,
    async open(overrides: Partial<WalWriterOptions> = {}): Promise<WalWriter> {
      return openWalWriter({
        directoryPath: WAL_DIRECTORY,
        gatewayEpoch: TEST_GATEWAY_EPOCH,
        fileSystem,
        clock,
        ...overrides,
      });
    },
  };
}

export type ReadOptions = {
  /**
   * Skip segments that fail validation instead of throwing. Only for the tests
   * that deliberately leave a corrupt segment on disk — a data-quality incident
   * excludes that range from dataset manifests (ADR-004 §3, handoff §12.5).
   */
  readonly skipInvalid?: boolean;
  readonly directoryPath?: string;
};

/** Every frame recorded in the directory, in segment then record order. */
export async function recordedFrames(
  fileSystem: WalFileSystem,
  options: ReadOptions = {},
): Promise<readonly RawFrameRecord[]> {
  const directoryPath = options.directoryPath ?? WAL_DIRECTORY;
  const reports = await validateWalDirectory(fileSystem, directoryPath);
  const frames: RawFrameRecord[] = [];
  for (const report of reports) {
    if (options.skipInvalid === true && !report.valid) {
      continue;
    }
    const { records } = await readSegmentRecords(fileSystem, report.path);
    frames.push(...records);
  }
  return frames;
}

/** Ingest sequence numbers of every recorded frame, in order. */
export async function recordedIngestSeqs(
  fileSystem: WalFileSystem,
  options: ReadOptions = {},
): Promise<readonly string[]> {
  return (await recordedFrames(fileSystem, options)).map((record) => record.ingestSeq);
}

export function segmentPath(manifest: WalSegmentManifest): string {
  return `${WAL_DIRECTORY}/${segmentFileName(manifest.segmentId)}`;
}
