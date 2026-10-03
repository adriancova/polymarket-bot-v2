/**
 * TEST SUPPORT ONLY (imported by `*.test.ts`; never by `main.ts` or
 * `index.ts`): research-tier datasets written by the REAL published writer,
 * `@polymarket-bot/storage-parquet`'s `writeResearchTierDataset`, into a
 * directory object store — the layout `STORAGE-1`'s extractor writes
 * (`research/<gatewayEpoch>/<datasetId>/…`).
 *
 * The rows are stated by hand, as downsampling v1 would emit them for the
 * frames each test names (`apps/research-worker/src/research-tier/sampler.ts`
 * is an app this app may not import). The writer still refuses what it
 * refuses (dense ordinals, release order, one epoch); the tamper helpers below
 * forge what it would refuse, and re-seal the manifest's digest sidecar, so
 * the reader's own checks are what a test exercises.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  RESEARCH_SOURCE_VERIFICATION,
  fileSystemObjectStore,
  researchTableSpec,
  writeResearchTableObject,
  writeResearchTierDataset,
  type ResearchDownsampling,
  type ResearchRow,
  type ResearchStateObject,
  type ResearchTableName,
  type ResearchTierManifest,
} from "@polymarket-bot/storage-parquet";

/** The fixtures' gateway epoch. */
export const EPOCH = "019c0000-0000-7000-8000-0000000000e1";
/** A second epoch, for the cross-epoch tests. */
export const OTHER_EPOCH = "019c0000-0000-7000-8000-0000000000e2";

/** Downsampling v1 as `sampler.ts` pins it (`RESEARCH_DOWNSAMPLING`), restated. */
export const DOWNSAMPLING_V1: ResearchDownsampling = {
  downsamplingId: "polymarket-bot/research-downsampling/v1",
  downsamplingVersion: 1,
  parameters: { spanMs: 1_000, fullBookSpanMs: 60_000, depthLevels: 5, referenceTradeDedupeWindow: 512 },
  tieOrder:
    "release frame ingestSeq; then span samples by span boundary, at one boundary by kind " +
    "(pm_top_of_book, pm_depth, pm_full_book, ref_trade_bars) and within a kind by token id or " +
    "source|instrument; then the release frame's own feed_events, then its trades, lifecycle " +
    "events and ticks in frame order",
};

/** One sample to write: its table and its row (every column of the table). */
export interface FixtureSample {
  readonly table: ResearchTableName;
  readonly row: ResearchRow;
}

/** A sample's release: its ordinal, release frame `ingestSeq` and receipt instant. */
export interface Release {
  readonly ordinal: number;
  readonly seq: string;
  /** Epoch milliseconds of the release frame's receipt instant. */
  readonly atMs: number;
  readonly epoch?: string;
  readonly segment?: string;
}

/** The ISO instant of epoch milliseconds, as the WAL records it. */
export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function base(release: Release): Record<string, string | number> {
  const epoch = release.epoch ?? EPOCH;
  return {
    sampleOrdinal: release.ordinal,
    gatewayEpoch: epoch,
    releaseIngestSeq: release.seq,
    availableAt: iso(release.atMs),
    releaseSegmentId: release.segment ?? `${epoch}-000000`,
  };
}

/** Every column of the table, `null` where the sample states nothing. */
function complete(table: ResearchTableName, fields: Readonly<Record<string, string | number | boolean | null>>): ResearchRow {
  const row: Record<string, string | number | boolean | null> = {};
  for (const column of researchTableSpec(table).columns) row[column.name] = fields[column.name] ?? null;
  return row;
}

/** A 1 s reference-trade bar. */
export function bar(
  release: Release,
  fields: {
    readonly spanStartMs: number;
    readonly close: string;
    readonly open?: string;
    readonly volume?: string;
    readonly tradeCount?: number;
    readonly source?: string;
    readonly instrument?: string;
  },
): FixtureSample {
  return {
    table: "ref_trade_bars",
    row: complete("ref_trade_bars", {
      ...base(release),
      spanStartMs: fields.spanStartMs,
      spanEndMs: fields.spanStartMs + 1_000,
      source: fields.source ?? "binance",
      instrument: fields.instrument ?? "BTCUSDT",
      open: fields.open ?? fields.close,
      high: fields.close,
      low: fields.open ?? fields.close,
      close: fields.close,
      volume: fields.volume ?? "1",
      tradeCount: fields.tradeCount ?? 1,
    }),
  };
}

type Level = readonly [price: string, size: string];

/** A 1 s five-level depth sample. */
export function depth(
  release: Release,
  fields: { readonly spanStartMs: number; readonly conditionId: string; readonly tokenId: string; readonly bids: readonly Level[]; readonly asks: readonly Level[] },
): FixtureSample {
  const levels: Record<string, string | null> = {};
  for (let level = 1; level <= 5; level += 1) {
    levels[`bid${String(level)}Price`] = fields.bids[level - 1]?.[0] ?? null;
    levels[`bid${String(level)}Size`] = fields.bids[level - 1]?.[1] ?? null;
    levels[`ask${String(level)}Price`] = fields.asks[level - 1]?.[0] ?? null;
    levels[`ask${String(level)}Size`] = fields.asks[level - 1]?.[1] ?? null;
  }
  return {
    table: "pm_depth",
    row: complete("pm_depth", {
      ...base(release),
      spanStartMs: fields.spanStartMs,
      spanEndMs: fields.spanStartMs + 1_000,
      conditionId: fields.conditionId,
      tokenId: fields.tokenId,
      ...levels,
    }),
  };
}

/** A 1 s top-of-book sample. */
export function top(
  release: Release,
  fields: { readonly spanStartMs: number; readonly conditionId: string; readonly tokenId: string; readonly bid: Level | null; readonly ask: Level | null },
): FixtureSample {
  return {
    table: "pm_top_of_book",
    row: complete("pm_top_of_book", {
      ...base(release),
      spanStartMs: fields.spanStartMs,
      spanEndMs: fields.spanStartMs + 1_000,
      conditionId: fields.conditionId,
      tokenId: fields.tokenId,
      bestBidPrice: fields.bid?.[0] ?? null,
      bestBidSize: fields.bid?.[1] ?? null,
      bestAskPrice: fields.ask?.[0] ?? null,
      bestAskSize: fields.ask?.[1] ?? null,
    }),
  };
}

/** A 60 s full-book sample. */
export function fullBook(
  release: Release,
  fields: { readonly spanStartMs: number; readonly conditionId: string; readonly tokenId: string; readonly bids: readonly Level[]; readonly asks: readonly Level[] },
): FixtureSample {
  return {
    table: "pm_full_book",
    row: complete("pm_full_book", {
      ...base(release),
      spanStartMs: fields.spanStartMs,
      spanEndMs: fields.spanStartMs + 60_000,
      conditionId: fields.conditionId,
      tokenId: fields.tokenId,
      bidLevelCount: fields.bids.length,
      askLevelCount: fields.asks.length,
      bidsJson: JSON.stringify(fields.bids),
      asksJson: JSON.stringify(fields.asks),
    }),
  };
}

/** A Polymarket trade (on-change). */
export function trade(
  release: Release,
  fields: {
    readonly conditionId: string;
    readonly tokenId: string;
    readonly price: string;
    readonly size: string | null;
    readonly side?: string;
    readonly entryIndex?: number;
  },
): FixtureSample {
  return {
    table: "pm_trades",
    row: complete("pm_trades", {
      ...base(release),
      conditionId: fields.conditionId,
      tokenId: fields.tokenId,
      entryIndex: fields.entryIndex ?? 0,
      price: fields.price,
      size: fields.size,
      side: fields.side ?? "BUY",
      feeRateBps: "0",
      venueTimestamp: String(release.atMs),
      transactionHash: null,
    }),
  };
}

/** A Gamma market poll (on-change), attributed by its endpoint. */
export function gammaPoll(
  release: Release,
  fields: {
    readonly gammaMarketId: string;
    readonly active: boolean | null;
    readonly closed: boolean | null;
    readonly acceptingOrders: boolean | null;
    readonly archived?: boolean | null;
  },
): FixtureSample {
  return {
    table: "pm_lifecycle",
    row: complete("pm_lifecycle", {
      ...base(release),
      source: "polymarket",
      endpoint: `https://gamma-api.polymarket.com/markets/${fields.gammaMarketId}`,
      eventType: "gamma-market",
      entryIndex: 0,
      conditionId: null,
      tokenId: null,
      active: fields.active,
      closed: fields.closed,
      acceptingOrders: fields.acceptingOrders,
      archived: fields.archived ?? false,
      restricted: false,
      detailJson: null,
      payloadSha256: "c".repeat(64),
    }),
  };
}

/** A market-channel lifecycle event (on-change): `market_resolved`, `tick_size_change` or `new_market`. */
export function marketEvent(
  release: Release,
  fields: { readonly eventType: "market_resolved" | "tick_size_change" | "new_market"; readonly conditionId: string; readonly entryIndex?: number },
): FixtureSample {
  return {
    table: "pm_lifecycle",
    row: complete("pm_lifecycle", {
      ...base(release),
      source: "polymarket",
      endpoint: "wss://ws-subscriptions-clob.polymarket.com/ws/market",
      eventType: fields.eventType,
      entryIndex: fields.entryIndex ?? 0,
      conditionId: fields.conditionId,
      detailJson: "{}",
      payloadSha256: "d".repeat(64),
    }),
  };
}

/** A feed event (on-change). */
export function feedEvent(
  release: Release,
  fields: { readonly eventKind: "connection-observed" | "connection-changed" | "uninterpretable" | "snapshot-trades-excluded" },
): FixtureSample {
  return {
    table: "feed_events",
    row: complete("feed_events", {
      ...base(release),
      source: "polymarket",
      endpoint: "wss://ws-subscriptions-clob.polymarket.com/ws/market",
      connectionId: "fixture-connection",
      subscriptionGeneration: 1,
      eventKind: fields.eventKind,
      detail: "fixture",
      payloadSha256: "e".repeat(64),
    }),
  };
}

/** A Chainlink tick (on-change). */
export function tick(release: Release, fields: { readonly value: string; readonly entryIndex?: number }): FixtureSample {
  return {
    table: "chainlink_ticks",
    row: complete("chainlink_ticks", {
      ...base(release),
      topic: "crypto_prices_chainlink",
      symbol: "btc/usd",
      entryIndex: fields.entryIndex ?? 0,
      value: fields.value,
      observedAt: null,
    }),
  };
}

/** What {@link writeResearchDataset} wrote. */
export interface WrittenDataset {
  readonly manifestObjectKey: string;
  readonly manifest: ResearchTierManifest;
  readonly stateOut: ResearchStateObject & { readonly datasetId: string };
}

/** Writes one research-tier dataset through the published writer. */
export async function writeResearchDataset(options: {
  readonly root: string;
  readonly datasetId: string;
  readonly samples: readonly FixtureSample[];
  readonly epoch?: string;
  readonly segmentIndex?: number;
  readonly stateIn?: (ResearchStateObject & { readonly datasetId: string }) | null;
  readonly downsampling?: ResearchDownsampling;
}): Promise<WrittenDataset> {
  const epoch = options.epoch ?? EPOCH;
  const segmentIndex = options.segmentIndex ?? 0;
  const rowsByTable = new Map<ResearchTableName, ResearchRow[]>();
  for (const sample of options.samples) {
    const rows = rowsByTable.get(sample.table) ?? [];
    rows.push(sample.row);
    rowsByTable.set(sample.table, rows);
  }
  const prefix = `research/${epoch}/${options.datasetId}`;
  const written = await writeResearchTierDataset({
    datasetId: options.datasetId,
    objectKeyPrefix: prefix,
    objectStore: fileSystemObjectStore(options.root),
    clock: { nowMs: () => Date.UTC(2026, 9, 2, 12, 0, 0), monotonicMs: () => 0 },
    gatewayEpoch: epoch,
    downsampling: options.downsampling ?? DOWNSAMPLING_V1,
    rowsByTable,
    sourceSegments: [
      {
        segmentId: `${epoch}-${String(segmentIndex).padStart(6, "0")}`,
        gatewayEpoch: epoch,
        segmentIndex,
        segmentSha256: "a".repeat(64),
        segmentFileSha256: "b".repeat(64),
        checksummedByteLength: 100,
        byteSize: 200,
        recordCount: options.samples.length,
        firstIngestSeq: "1",
        lastIngestSeq: "999999999",
        minReceivedAt: "2026-05-01T08:00:00.000Z",
        maxReceivedAt: "2026-05-01T10:00:00.000Z",
        verification: RESEARCH_SOURCE_VERIFICATION,
        marketIdentities: { polymarketTokenIds: [], conditionIds: [], gammaMarketIds: [], unidentifiedFrames: 0 },
      },
    ],
    recordCounts: {
      segmentDeclared: options.samples.length,
      framesRead: options.samples.length,
      framesInterpreted: options.samples.length,
      framesUninterpreted: 0,
    },
    samplerStateIn: options.stateIn ?? null,
    samplerStateOut: new TextEncoder().encode(`{"fixture":"${options.datasetId}"}\n`),
  });
  return {
    manifestObjectKey: written.manifestObjectKey,
    manifest: written.manifest,
    stateOut: { datasetId: options.datasetId, ...written.manifest.samplerState.stateOut },
  };
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Rewrites a manifest and RE-SEALS its digest sidecar, so the published
 * verifier accepts the forgery and only the reader's own checks remain.
 */
export function resealManifest(root: string, manifestObjectKey: string, mutate: (manifest: Record<string, unknown>) => void): void {
  const path = join(root, manifestObjectKey);
  const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  mutate(manifest);
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(path, text);
  writeFileSync(join(root, manifestObjectKey.replace(/manifest\.json$/u, "manifest.sha256")), `${sha256(text)}\n`);
}

/**
 * Replaces one table object with forged rows (written by the published table
 * writer) and re-seals the manifest's pin for it: the verifier then accepts
 * rows the dataset writer would have refused.
 */
export function forgeTable(root: string, manifestObjectKey: string, table: ResearchTableName, rows: readonly ResearchRow[]): void {
  const objectKey = `${manifestObjectKey.replace(/manifest\.json$/u, "")}${table}.parquet`;
  const encoded = writeResearchTableObject({ table: researchTableSpec(table), rows, codec: "SNAPPY" });
  writeFileSync(join(root, objectKey), encoded.bytes);
  resealManifest(root, manifestObjectKey, (manifest) => {
    const objects = manifest["objects"] as Record<string, unknown>[];
    const entry = objects.find((object) => object["objectKey"] === objectKey);
    if (entry === undefined) throw new Error(`no pinned object ${objectKey}`);
    entry["sha256"] = encoded.sha256;
    entry["byteLength"] = encoded.bytes.byteLength;
    entry["rowCount"] = rows.length;
  });
}
