/**
 * Shared setup for the compaction integration suite.
 *
 * The one thing worth stating: **segments are written by the real `WP-050`
 * writer**, through the real Node filesystem, and are never constructed by hand
 * here. The unit suite in `packages/storage-parquet/src` builds segments from a
 * second reading of `docs/contracts/wal-format.md`, which is fast and lets it
 * construct adversarial corruption — but two implementations of one document
 * can share a misunderstanding. This suite closes that gap.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RawFrameRecord, WalSegmentManifest } from "@polymarket-bot/storage-wal";
import {
  buildRawFrameRecord,
  nodeWalFileSystem,
  openWalWriter,
} from "@polymarket-bot/storage-wal";
import { createManualClock } from "@polymarket-bot/storage-wal/testing";

export const GATEWAY_EPOCH = "0190a3e0-0000-7000-8000-000000000001";

export type TemporaryWorkspace = {
  readonly root: string;
  readonly walDirectoryPath: string;
  readonly objectStoreRoot: string;
  readonly cleanup: () => Promise<void>;
};

/** Create an isolated temporary workspace with a WAL directory and a store. */
export async function createWorkspace(): Promise<TemporaryWorkspace> {
  const root = await mkdtemp(join(tmpdir(), "polymarket-bot-wp130-"));
  return {
    root,
    walDirectoryPath: join(root, "wal"),
    objectStoreRoot: join(root, "objects"),
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** Build a `RawFrameRecord` through the WAL's own builder. */
export function frame(input: {
  readonly ingestSeq: string | number;
  readonly payloadUtf8: string;
  readonly gatewayEpoch?: string;
  readonly receivedAt?: string;
  readonly connectionId?: string;
  readonly subscriptionGeneration?: number;
}): RawFrameRecord {
  const ingestSeq = String(input.ingestSeq);
  return buildRawFrameRecord({
    gatewayEpoch: input.gatewayEpoch ?? GATEWAY_EPOCH,
    ingestSeq,
    source: "polymarket",
    endpoint: "wss://ws-subscriptions-clob.polymarket.com/ws/market",
    connectionId: input.connectionId ?? "conn-1",
    subscriptionGeneration: input.subscriptionGeneration ?? 0,
    receivedAt: input.receivedAt ?? "2026-01-01T00:00:00.000Z",
    receivedMonotonicNs: String(BigInt(ingestSeq) * 1_000_000n),
    payloadUtf8: input.payloadUtf8,
  });
}

export type WrittenWal = {
  readonly manifests: readonly WalSegmentManifest[];
  readonly frames: readonly RawFrameRecord[];
};

/**
 * Record frames through the real WAL writer, rotating on a size bound so the
 * dataset spans several segments.
 */
export async function recordFrames(
  walDirectoryPath: string,
  frames: readonly RawFrameRecord[],
  options: { readonly maxSegmentBytes?: number } = {},
): Promise<WrittenWal> {
  const clock = createManualClock();
  const manifests: WalSegmentManifest[] = [];
  const writer = await openWalWriter({
    directoryPath: walDirectoryPath,
    gatewayEpoch: GATEWAY_EPOCH,
    fileSystem: nodeWalFileSystem(),
    clock,
    ...(options.maxSegmentBytes === undefined
      ? {}
      : { maxSegmentBytes: options.maxSegmentBytes }),
    observer: {
      onSegmentFinalized: (manifest) => {
        manifests.push(manifest);
      },
    },
  });

  for (const record of frames) {
    const result = writer.enqueue(record);
    if (!result.accepted) {
      throw new Error(`WAL writer refused a frame: ${result.reason}`);
    }
    await writer.drain();
    clock.advance(10);
  }
  await writer.close();

  return { manifests, frames };
}
