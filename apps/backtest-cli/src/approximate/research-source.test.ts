/**
 * `APPROX-REPLAY-1` — the research-tier replay source: it reads only verified
 * datasets, consumes samples in the dispatch order of their release frames
 * with downsampling v1's tie order (never by instant), enforces the span
 * release rule, and covers one gateway epoch.
 *
 * Every dataset here is written by the REAL published writer
 * (`writeResearchTierDataset`) into a fresh temporary directory; forgeries
 * re-seal the manifest's digest sidecar so the published verifier accepts
 * them and the reader's own checks are what is exercised.
 *
 * NO DOCKER. NO NETWORK. NO CREDENTIAL.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fileSystemObjectStore, type ObjectStore } from "@polymarket-bot/storage-parquet";
import { afterAll, describe, expect, it } from "vitest";

import { sha256Hex } from "../archive.js";
import { readResearchTierReplaySource, v1TieKey, type ResearchSourceResult } from "./research-source.js";
import {
  EPOCH,
  OTHER_EPOCH,
  bar,
  depth,
  feedEvent,
  forgeTable,
  gammaPoll,
  resealManifest,
  top,
  trade,
  writeResearchDataset,
  type FixtureSample,
} from "./test-support.js";

const scratch = mkdtempSync(join(tmpdir(), "approx-replay-source-"));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});
let counter = 0;
function freshRoot(): string {
  counter += 1;
  return join(scratch, `store-${String(counter)}`);
}

const CONDITION = "0xfixturecondition";
const YES = "9101";

async function sourceOf(root: string, keys: readonly string[], store?: Pick<ObjectStore, "head" | "get">): Promise<ResearchSourceResult> {
  return await readResearchTierReplaySource({
    objectStore: store ?? fileSystemObjectStore(root),
    manifestObjectKeys: keys,
    digestSha256: sha256Hex,
  });
}

function framesOf(result: ResearchSourceResult): { seq: string; tables: string[]; at: string }[] {
  if (!result.ok) throw new Error(`refused: ${result.refusal.code}: ${result.refusal.detail}`);
  return result.source.releaseFrames.map((frame) => ({
    seq: frame.releaseIngestSeq,
    tables: frame.samples.map((sample) => sample.table),
    at: frame.availableAt,
  }));
}

describe("acceptance 1: samples replay in release dispatch order, never by instant", () => {
  it("a sample released at ingestSeq 1 with instant 10,000 ms replays before one released at ingestSeq 2 with instant 9,999 ms", async () => {
    const root = freshRoot();
    // Ordinal 0: a trade released at F1 (seq 1, 10,000 ms). Ordinal 1: a Gamma
    // poll released at F2 (seq 2, 9,999 ms). The poll's table comes BEFORE the
    // trade's in the research tier's kind order, and its instant is EARLIER: a
    // reader that ordered by table or by instant would replay it first.
    // Ordinals 2 and 3 are released at seq 9 and seq 10: as strings "10" < "9".
    const samples: FixtureSample[] = [
      trade({ ordinal: 0, seq: "1", atMs: 10_000 }, { conditionId: CONDITION, tokenId: YES, price: "0.5", size: "10" }),
      gammaPoll({ ordinal: 1, seq: "2", atMs: 9_999 }, { gammaMarketId: "1", active: true, closed: false, acceptingOrders: true }),
      feedEvent({ ordinal: 2, seq: "9", atMs: 9_000 }, { eventKind: "connection-observed" }),
      trade({ ordinal: 3, seq: "10", atMs: 8_000 }, { conditionId: CONDITION, tokenId: YES, price: "0.6", size: "10" }),
    ];
    const written = await writeResearchDataset({ root, datasetId: "order", samples });
    const frames = framesOf(await sourceOf(root, [written.manifestObjectKey]));
    expect(frames.map((frame) => frame.seq)).toEqual(["1", "2", "9", "10"]);
    expect(frames[0]).toEqual({ seq: "1", tables: ["pm_trades"], at: "1970-01-01T00:00:10.000Z" });
    expect(frames[1]).toEqual({ seq: "2", tables: ["pm_lifecycle"], at: "1970-01-01T00:00:09.999Z" });
  });

  it("refuses a dataset whose release ingestSeq goes backwards in sample order", async () => {
    const root = freshRoot();
    const written = await writeResearchDataset({
      root,
      datasetId: "backwards",
      samples: [
        trade({ ordinal: 0, seq: "5", atMs: 10_000 }, { conditionId: CONDITION, tokenId: YES, price: "0.5", size: "10" }),
        trade({ ordinal: 1, seq: "6", atMs: 10_001 }, { conditionId: CONDITION, tokenId: YES, price: "0.5", size: "10" }),
      ],
    });
    // The writer refuses backwards release order, so it is forged afterwards.
    forgeTable(root, written.manifestObjectKey, "pm_trades", [
      { ...trade({ ordinal: 0, seq: "6", atMs: 10_000 }, { conditionId: CONDITION, tokenId: YES, price: "0.5", size: "10" }).row },
      { ...trade({ ordinal: 1, seq: "5", atMs: 10_001 }, { conditionId: CONDITION, tokenId: YES, price: "0.5", size: "10" }).row },
    ]);
    resealManifest(root, written.manifestObjectKey, (manifest) => {
      const range = manifest["releaseRange"] as Record<string, Record<string, unknown>>;
      (range["first"] as Record<string, unknown>)["ingestSeq"] = "6";
      (range["last"] as Record<string, unknown>)["ingestSeq"] = "5";
    });
    const result = await sourceOf(root, [written.manifestObjectKey]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe("APPROX_REPLAY_RELEASE_ORDER_VIOLATED");
  });

  it("checks the fixed v1 tie order inside one release frame, and refuses a dataset that breaks it", async () => {
    const at = { seq: "100", atMs: 10_050 };
    const good = [
      top({ ordinal: 0, ...at }, { spanStartMs: 9_000, conditionId: CONDITION, tokenId: YES, bid: ["0.4", "10"], ask: ["0.5", "10"] }),
      depth({ ordinal: 1, ...at }, { spanStartMs: 9_000, conditionId: CONDITION, tokenId: YES, bids: [["0.4", "10"]], asks: [["0.5", "10"]] }),
      bar({ ordinal: 2, ...at }, { spanStartMs: 9_000, close: "100" }),
      feedEvent({ ordinal: 3, ...at }, { eventKind: "connection-changed" }),
      trade({ ordinal: 4, ...at }, { conditionId: CONDITION, tokenId: YES, price: "0.5", size: "1", entryIndex: 0 }),
    ];
    const root = freshRoot();
    const ok = await writeResearchDataset({ root, datasetId: "tie-good", samples: good });
    expect(framesOf(await sourceOf(root, [ok.manifestObjectKey]))[0]?.tables).toEqual([
      "pm_top_of_book",
      "pm_depth",
      "ref_trade_bars",
      "feed_events",
      "pm_trades",
    ]);

    // The same samples with the depth ordered BEFORE the top of book.
    const bad = [
      depth({ ordinal: 0, ...at }, { spanStartMs: 9_000, conditionId: CONDITION, tokenId: YES, bids: [["0.4", "10"]], asks: [["0.5", "10"]] }),
      top({ ordinal: 1, ...at }, { spanStartMs: 9_000, conditionId: CONDITION, tokenId: YES, bid: ["0.4", "10"], ask: ["0.5", "10"] }),
    ];
    const badRoot = freshRoot();
    const refused = await writeResearchDataset({ root: badRoot, datasetId: "tie-bad", samples: bad });
    const result = await sourceOf(badRoot, [refused.manifestObjectKey]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal.code).toBe("APPROX_REPLAY_RELEASE_ORDER_VIOLATED");
      expect(result.refusal.detail).toContain("tie order");
    }
  });

  it("pins the v1 tie key: spans by boundary, kind and subject; then feed events; then frame order", () => {
    const at = { ordinal: 0, seq: "1", atMs: 61_000 };
    expect(v1TieKey("pm_depth", depth(at, { spanStartMs: 60_000, conditionId: CONDITION, tokenId: "7", bids: [], asks: [] }).row)).toEqual([0, 61_000, 1, "7"]);
    expect(v1TieKey("ref_trade_bars", bar(at, { spanStartMs: 60_000, close: "1", source: "coinbase", instrument: "BTC-USD" }).row)).toEqual([
      0,
      61_000,
      3,
      "coinbase|BTC-USD",
    ]);
    expect(v1TieKey("feed_events", feedEvent(at, { eventKind: "uninterpretable" }).row)).toEqual([1, 0, 1, ""]);
    expect(v1TieKey("pm_trades", trade(at, { conditionId: CONDITION, tokenId: YES, price: "0.5", size: "1", entryIndex: 3 }).row)).toEqual([1, 1, 3, ""]);
  });
});

describe("acceptance 2: no replayed span sample holds a frame dispatched at or after its release frame", () => {
  // The frames of ADR-029 Decision 5.1's example, with one frame before and one after:
  //   F0: ingestSeq 10, 9,500 ms, a Binance trade at 100       → in [9,000, 10,000)
  //   F1: ingestSeq 11, 10,000 ms, a Binance trade at 101      → releases [9,000, 10,000); itself in [10,000, 11,000)
  //   F2: ingestSeq 12, 9,999 ms, a Binance trade at 102       → dispatched after F1: in [10,000, 11,000)
  //   F3: ingestSeq 13, 11,000 ms                              → releases [10,000, 11,000)
  // The example's ingestSeq 1 and 2 are F1 and F2 here; any increasing numbers keep the argument
  // (the core-level test in approx-run.test.ts uses 1 and 2 exactly).
  const F1 = { seq: "11", atMs: 10_000 };
  const F2 = { seq: "12", atMs: 9_999 };
  const F3 = { seq: "13", atMs: 11_000 };

  it("replays the [9,000, 10,000) bar at F1, holding F0 alone; F2's trade reaches the replay only in the bar released at F3", async () => {
    const root = freshRoot();
    const written = await writeResearchDataset({
      root,
      datasetId: "membership",
      samples: [
        bar({ ordinal: 0, ...F1 }, { spanStartMs: 9_000, close: "100", tradeCount: 1, volume: "1" }),
        // F2 releases nothing of its own here except an on-change Polymarket trade, to show its position.
        trade({ ordinal: 1, ...F2 }, { conditionId: CONDITION, tokenId: YES, price: "0.5", size: "1" }),
        bar({ ordinal: 2, ...F3 }, { spanStartMs: 10_000, open: "101", close: "102", tradeCount: 2, volume: "2" }),
      ],
    });
    const result = await sourceOf(root, [written.manifestObjectKey]);
    if (!result.ok) throw new Error(result.refusal.detail);
    const frames = result.source.releaseFrames;
    expect(frames.map((frame) => frame.releaseIngestSeq)).toEqual(["11", "12", "13"]);
    const first = frames[0]?.samples[0]?.row;
    expect(first?.["spanEndMs"]).toBe(10_000);
    expect(first?.["close"]).toBe("100");
    expect(first?.["tradeCount"]).toBe(1);
    // Nothing F2 carried is replayed before F2; its reference trade is in the later bar, after F2.
    const later = frames[2]?.samples[0]?.row;
    expect(later?.["spanStartMs"]).toBe(10_000);
    expect(later?.["close"]).toBe("102");
    expect(BigInt(frames[2]?.releaseIngestSeq ?? "0")).toBeGreaterThan(BigInt(F2.seq));
  });

  it("refuses the instant-binned variant: F2 counted into [9,000, 10,000), that bar released with the next at F3 (two 1 s boundaries at one frame)", async () => {
    const root = freshRoot();
    const written = await writeResearchDataset({
      root,
      datasetId: "instant-binned",
      samples: [
        bar({ ordinal: 0, ...F3 }, { spanStartMs: 9_000, open: "100", close: "102", tradeCount: 2, volume: "2" }),
        bar({ ordinal: 1, ...F3 }, { spanStartMs: 10_000, close: "101", tradeCount: 1, volume: "1", instrument: "BTCUSDT2" }),
      ],
    });
    const result = await sourceOf(root, [written.manifestObjectKey]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal.code).toBe("APPROX_REPLAY_RELEASE_ORDER_VIOLATED");
      expect(result.refusal.detail).toContain("closes two spans of one length");
    }
  });

  it("refuses a [9,000, 10,000) bar released at F2 (9,999 ms): a frame before the boundary cannot close the span", async () => {
    const root = freshRoot();
    const written = await writeResearchDataset({
      root,
      datasetId: "released-early",
      samples: [bar({ ordinal: 0, ...F2 }, { spanStartMs: 9_000, open: "100", close: "102", tradeCount: 2, volume: "2" })],
    });
    const result = await sourceOf(root, [written.manifestObjectKey]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal.code).toBe("APPROX_REPLAY_RELEASE_ORDER_VIOLATED");
      expect(result.refusal.detail).toContain("before its span's boundary");
    }
  });

  it("refuses a span released after a later span of the same length", async () => {
    const root = freshRoot();
    const written = await writeResearchDataset({
      root,
      datasetId: "spans-backwards",
      samples: [
        bar({ ordinal: 0, ...F3 }, { spanStartMs: 10_000, close: "102" }),
        bar({ ordinal: 1, seq: "14", atMs: 11_500 }, { spanStartMs: 9_000, close: "100" }),
      ],
    });
    const result = await sourceOf(root, [written.manifestObjectKey]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.detail).toContain("after a later or equal span");
  });

  it("refuses a span sample whose span is not one aligned span of its version's length", async () => {
    const root = freshRoot();
    const written = await writeResearchDataset({
      root,
      datasetId: "misaligned",
      samples: [bar({ ordinal: 0, ...F3 }, { spanStartMs: 9_500, close: "100" })],
    });
    const result = await sourceOf(root, [written.manifestObjectKey]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.detail).toContain("aligned span");
  });
});

describe("acceptance 3: a replay covers one gateway epoch; across epochs it stops and asks", () => {
  it("two datasets of two epochs: APPROX_REPLAY_CROSS_EPOCH, and no sample is read", async () => {
    const root = freshRoot();
    const one = await writeResearchDataset({
      root,
      datasetId: "epoch-one",
      samples: [trade({ ordinal: 0, seq: "1", atMs: 1_000 }, { conditionId: CONDITION, tokenId: YES, price: "0.5", size: "1" })],
    });
    const two = await writeResearchDataset({
      root,
      epoch: OTHER_EPOCH,
      datasetId: "epoch-two",
      samples: [trade({ ordinal: 0, seq: "1", atMs: 2_000, epoch: OTHER_EPOCH }, { conditionId: CONDITION, tokenId: YES, price: "0.5", size: "1" })],
    });
    let objectReads = 0;
    const store = fileSystemObjectStore(root);
    const counting: Pick<ObjectStore, "head" | "get"> = {
      head: async (key) => await store.head(key),
      get: async (key) => {
        if (key.endsWith(".parquet")) objectReads += 1;
        return await store.get(key);
      },
    };
    const before = objectReads;
    const result = await sourceOf(root, [one.manifestObjectKey, two.manifestObjectKey], counting);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe("APPROX_REPLAY_CROSS_EPOCH");
    expect(result.refusal.detail).toContain("wal-format.md §12.1");
    expect(result.refusal.detail).toContain("ADR-004 amendment");
    expect(result.fidelity).toBe("approximate");
    // The verifier read each object once; the replay read none after the epoch check.
    expect(objectReads - before).toBe(2);
  });

  it("a dataset whose rows name another epoch than its manifest is refused (re-sealed forgery)", async () => {
    const root = freshRoot();
    const written = await writeResearchDataset({
      root,
      epoch: OTHER_EPOCH,
      datasetId: "row-epoch",
      samples: [trade({ ordinal: 0, seq: "1", atMs: 1_000, epoch: OTHER_EPOCH, segment: `${EPOCH}-000000` }, { conditionId: CONDITION, tokenId: YES, price: "0.5", size: "1" })],
    });
    resealManifest(root, written.manifestObjectKey, (manifest) => {
      manifest["gatewayEpochs"] = [EPOCH];
      for (const segment of manifest["sourceSegments"] as Record<string, unknown>[]) {
        segment["gatewayEpoch"] = EPOCH;
        segment["segmentId"] = `${EPOCH}-000000`;
      }
    });
    const result = await sourceOf(root, [written.manifestObjectKey]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal.code).toBe("APPROX_REPLAY_ROWS_UNRECONCILED");
      expect(result.refusal.detail).toContain("a gateway epoch other than its dataset");
    }
  });
});

describe("only a verified dataset is read", () => {
  it("a tampered object is refused by the published verifier", async () => {
    const root = freshRoot();
    const written = await writeResearchDataset({
      root,
      datasetId: "tampered",
      samples: [trade({ ordinal: 0, seq: "1", atMs: 1_000 }, { conditionId: CONDITION, tokenId: YES, price: "0.5", size: "1" })],
    });
    const object = written.manifest.objects[0];
    if (object === undefined) throw new Error("no object");
    writeFileSync(join(root, object.objectKey), new Uint8Array(object.byteLength));
    const result = await sourceOf(root, [written.manifestObjectKey]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal.code).toBe("APPROX_REPLAY_DATASET_UNVERIFIED");
      expect(result.fidelity).toBeUndefined();
    }
  });

  it("a manifest that does not match its digest sidecar is refused", async () => {
    const root = freshRoot();
    const written = await writeResearchDataset({
      root,
      datasetId: "sidecar",
      samples: [trade({ ordinal: 0, seq: "1", atMs: 1_000 }, { conditionId: CONDITION, tokenId: YES, price: "0.5", size: "1" })],
    });
    writeFileSync(join(root, written.manifestObjectKey.replace(/manifest\.json$/u, "manifest.sha256")), `${"0".repeat(64)}\n`);
    const result = await sourceOf(root, [written.manifestObjectKey]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe("APPROX_REPLAY_DATASET_UNVERIFIED");
  });

  it("bytes that change between the verifier's read and the replay's are refused (the replay digests what it decodes)", async () => {
    const root = freshRoot();
    const written = await writeResearchDataset({
      root,
      datasetId: "toctou",
      samples: [trade({ ordinal: 0, seq: "1", atMs: 1_000 }, { conditionId: CONDITION, tokenId: YES, price: "0.5", size: "1" })],
    });
    const store = fileSystemObjectStore(root);
    const reads = new Map<string, number>();
    const flipping: Pick<ObjectStore, "head" | "get"> = {
      head: async (key) => await store.head(key),
      get: async (key) => {
        const bytes = await store.get(key);
        const count = (reads.get(key) ?? 0) + 1;
        reads.set(key, count);
        if (key.endsWith(".parquet") && count > 1) {
          const changed = new Uint8Array(bytes);
          changed[changed.length - 10] = (changed[changed.length - 10] ?? 0) ^ 0xff;
          return changed;
        }
        return bytes;
      },
    };
    const result = await sourceOf(root, [written.manifestObjectKey], flipping);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe("APPROX_REPLAY_OBJECT_MISMATCH");
  });

  it("a downsampling version whose tie order this build does not know is refused", async () => {
    const root = freshRoot();
    const written = await writeResearchDataset({
      root,
      datasetId: "downsampling-v2",
      downsampling: {
        downsamplingId: "polymarket-bot/research-downsampling/v2",
        downsamplingVersion: 2,
        parameters: { spanMs: 1_000, fullBookSpanMs: 60_000 },
        tieOrder: "some other order",
      },
      samples: [trade({ ordinal: 0, seq: "1", atMs: 1_000 }, { conditionId: CONDITION, tokenId: YES, price: "0.5", size: "1" })],
    });
    const result = await sourceOf(root, [written.manifestObjectKey]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe("APPROX_REPLAY_DOWNSAMPLING_UNSUPPORTED");
  });

  it("the source never writes: a put through it is refused", async () => {
    const root = freshRoot();
    const written = await writeResearchDataset({
      root,
      datasetId: "read-only",
      samples: [trade({ ordinal: 0, seq: "1", atMs: 1_000 }, { conditionId: CONDITION, tokenId: YES, price: "0.5", size: "1" })],
    });
    const store = fileSystemObjectStore(root);
    const puts: string[] = [];
    const watched = {
      head: async (key: string) => await store.head(key),
      get: async (key: string) => await store.get(key),
      put: async (key: string) => {
        await Promise.resolve();
        puts.push(key);
      },
    };
    const result = await sourceOf(root, [written.manifestObjectKey], watched);
    expect(result.ok).toBe(true);
    expect(puts).toEqual([]);
  });
});

describe("several datasets of one epoch form one unbroken chain", () => {
  it("replays a chained pair in order, and refuses a pair whose link is missing", async () => {
    const root = freshRoot();
    const first = await writeResearchDataset({
      root,
      datasetId: "chain-a",
      samples: [trade({ ordinal: 0, seq: "1", atMs: 1_000 }, { conditionId: CONDITION, tokenId: YES, price: "0.5", size: "1" })],
    });
    const second = await writeResearchDataset({
      root,
      datasetId: "chain-b",
      segmentIndex: 1,
      stateIn: first.stateOut,
      samples: [trade({ ordinal: 0, seq: "2", atMs: 2_000, segment: `${EPOCH}-000001` }, { conditionId: CONDITION, tokenId: YES, price: "0.6", size: "1" })],
    });
    const chained = await sourceOf(root, [first.manifestObjectKey, second.manifestObjectKey]);
    expect(framesOf(chained).map((frame) => frame.seq)).toEqual(["1", "2"]);
    if (chained.ok) expect(chained.source.chainStart).toBe("fresh");

    const reversed = await sourceOf(root, [second.manifestObjectKey, first.manifestObjectKey]);
    expect(reversed.ok).toBe(false);
    if (!reversed.ok) expect(reversed.refusal.code).toBe("APPROX_REPLAY_CHAIN_BROKEN");

    const alone = await sourceOf(root, [second.manifestObjectKey]);
    if (alone.ok) expect(alone.source.chainStart).toBe("continued");

    const unlinked = await writeResearchDataset({
      root,
      datasetId: "chain-c",
      segmentIndex: 1,
      samples: [trade({ ordinal: 0, seq: "3", atMs: 3_000, segment: `${EPOCH}-000001` }, { conditionId: CONDITION, tokenId: YES, price: "0.6", size: "1" })],
    });
    const broken = await sourceOf(root, [first.manifestObjectKey, unlinked.manifestObjectKey]);
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.refusal.code).toBe("APPROX_REPLAY_CHAIN_BROKEN");
  });

  it("refuses a chain whose second dataset releases before the first ended", async () => {
    const root = freshRoot();
    const first = await writeResearchDataset({
      root,
      datasetId: "late-a",
      samples: [trade({ ordinal: 0, seq: "5", atMs: 1_000 }, { conditionId: CONDITION, tokenId: YES, price: "0.5", size: "1" })],
    });
    const second = await writeResearchDataset({
      root,
      datasetId: "late-b",
      segmentIndex: 1,
      stateIn: first.stateOut,
      samples: [trade({ ordinal: 0, seq: "4", atMs: 2_000, segment: `${EPOCH}-000001` }, { conditionId: CONDITION, tokenId: YES, price: "0.6", size: "1" })],
    });
    const result = await sourceOf(root, [first.manifestObjectKey, second.manifestObjectKey]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe("APPROX_REPLAY_RELEASE_ORDER_VIOLATED");
  });

  it("refuses no input and a key named twice", async () => {
    expect((await sourceOf(freshRoot(), [])).ok).toBe(false);
    const root = freshRoot();
    const written = await writeResearchDataset({
      root,
      datasetId: "twice",
      samples: [trade({ ordinal: 0, seq: "1", atMs: 1_000 }, { conditionId: CONDITION, tokenId: YES, price: "0.5", size: "1" })],
    });
    const result = await sourceOf(root, [written.manifestObjectKey, written.manifestObjectKey]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe("APPROX_REPLAY_INPUT_INVALID");
  });
});
