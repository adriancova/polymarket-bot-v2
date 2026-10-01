/**
 * A synthetic WAL root, extracted into the research tier, for the retention
 * tests (`STORAGE-1`). Test-only: imported by `*.test.ts` files and never by
 * production code.
 *
 * Every segment is built from the published byte format by
 * `@polymarket-bot/storage-parquet/testing` and written to a temporary
 * directory; the integration suite (`test/integration/parquet`) repeats the
 * important cases with the real `WP-050` writer.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ObjectStore } from "@polymarket-bot/storage-parquet";
import { fileSystemObjectStore, nodeCompactionFileSystem, verifyResearchTierDataset } from "@polymarket-bot/storage-parquet";
import { buildSegmentFixture, manualClock } from "@polymarket-bot/storage-parquet/testing";
import type { FrameInput, ManualClock, SegmentFixture } from "@polymarket-bot/storage-parquet/testing";

import { extractResearchTier } from "../research-tier/extract.js";
import { inventoryWalRoot } from "../research-tier/inventory.js";
import type { WalInventory } from "../research-tier/inventory.js";
import type { BootClock } from "../retention/clock-guard.js";
import type { WalIndex } from "../retention/wal-index.js";
import { buildWalIndex, cachedResearchVerifier } from "../retention/wal-index.js";

export const EPOCH = "0190a3e0-0000-7000-8000-000000000001";
export const MARKET_ENDPOINT = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
export const BINANCE = { source: "binance", endpoint: "wss://data-stream.binance.vision/stream" } as const;
export const HOUR = 60 * 60 * 1000;

/** A Polymarket book snapshot frame for one token. */
export function bookFrame(input: {
  readonly ingestSeq: string;
  readonly atMs: number;
  readonly tokenId: string;
  readonly conditionId: string;
}): FrameInput {
  return {
    ingestSeq: input.ingestSeq,
    receivedAt: new Date(input.atMs).toISOString(),
    source: "polymarket",
    endpoint: MARKET_ENDPOINT,
    payloadUtf8: JSON.stringify([
      {
        event_type: "book",
        market: input.conditionId,
        asset_id: input.tokenId,
        bids: [{ price: "0.40", size: "10" }],
        asks: [{ price: "0.60", size: "5" }],
        timestamp: "1",
      },
    ]),
  };
}

/** A Polymarket market-channel frame with any payload (a raw JSON value, or text). */
export function polymarketFrame(input: {
  readonly ingestSeq: string;
  readonly atMs: number;
  readonly payload: unknown;
  readonly endpoint?: string;
}): FrameInput {
  return {
    ingestSeq: input.ingestSeq,
    receivedAt: new Date(input.atMs).toISOString(),
    source: "polymarket",
    endpoint: input.endpoint ?? MARKET_ENDPOINT,
    payloadUtf8: typeof input.payload === "string" ? input.payload : JSON.stringify(input.payload),
  };
}

/** A boot clock a test moves by hand (`clock-guard.ts`). */
export type ManualBootClock = BootClock & { advance(ms: number): void; reboot(bootId: string): void };

export function manualBootClock(bootId = "boot-1", sinceBootMs = 1_000_000): ManualBootClock {
  let id = bootId;
  let since = sinceBootMs;
  return {
    bootId: async () => id,
    sinceBootMs: async () => since,
    advance(ms: number): void {
      since += ms;
    },
    reboot(next: string): void {
      id = next;
      since = 1_000;
    },
  };
}

/** A Binance trade frame. */
export function tradeFrame(input: { readonly ingestSeq: string; readonly atMs: number; readonly id?: number }): FrameInput {
  return {
    ingestSeq: input.ingestSeq,
    receivedAt: new Date(input.atMs).toISOString(),
    ...BINANCE,
    payloadUtf8: JSON.stringify({
      stream: "btcusdt@trade",
      data: { e: "trade", E: 1, s: "BTCUSDT", t: input.id ?? Number(input.ingestSeq), p: "100", q: "1", T: 1, m: false, M: true },
    }),
  };
}

export type StorageFixture = {
  readonly root: string;
  readonly walRoot: string;
  readonly walDir: string;
  readonly stateDir: string;
  readonly objectStore: ObjectStore;
  readonly clock: ManualClock;
  readonly segments: readonly SegmentFixture[];
  readonly cleanup: () => Promise<void>;
  /** Inventory the WAL root and extract every segment into the research tier. */
  readonly extract: () => Promise<WalInventory>;
  /** The sealed WAL in dispatch order, from the verified research tier (`wal-index.ts`). */
  readonly walIndex: (inventory: WalInventory) => Promise<WalIndex>;
};

/** Write segments (in index order) to a fresh temporary WAL root. */
export async function storageFixture(input: {
  readonly nowMs: number;
  readonly segments: readonly (readonly FrameInput[])[];
}): Promise<StorageFixture> {
  const root = await mkdtemp(join(tmpdir(), "storage1-retention-"));
  const walRoot = join(root, "wal");
  const walDir = join(walRoot, EPOCH);
  const stateDir = join(root, "state");
  await mkdir(walDir, { recursive: true });
  const segments = input.segments.map((frames, index) =>
    buildSegmentFixture({ gatewayEpoch: EPOCH, segmentIndex: index, frames }),
  );
  for (const segment of segments) {
    await writeFile(join(walDir, segment.segmentFileName), segment.segmentBytes);
    await writeFile(join(walDir, segment.manifestFileName), segment.manifestBytes);
  }
  const objectStore = fileSystemObjectStore(join(root, "objects"));
  const clock = manualClock(input.nowMs);
  const fileSystem = nodeCompactionFileSystem();
  return {
    root,
    walRoot,
    walDir,
    stateDir,
    objectStore,
    clock,
    segments,
    cleanup: () => rm(root, { recursive: true, force: true }),
    async extract(): Promise<WalInventory> {
      const before = await inventoryWalRoot(fileSystem, walRoot);
      await extractResearchTier({ fileSystem, objectStore, clock, byEpoch: before.byEpoch });
      return await inventoryWalRoot(fileSystem, walRoot);
    },
    async walIndex(inventory: WalInventory): Promise<WalIndex> {
      return await buildWalIndex({
        objectStore,
        inventory,
        refusedSegmentIds: new Set(),
        verifiedResearch: cachedResearchVerifier((key) => verifyResearchTierDataset(objectStore, key)),
      });
    },
  };
}
