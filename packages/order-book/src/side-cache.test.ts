/**
 * `THROUGHPUT-1a` — the book's per-side caches (sorted ladder, share sum, best
 * price, brought forward one level change at a time) answer exactly what a
 * fresh recomputation answers. The oracle is a SECOND book fed the same
 * updates and queried only once at the end of each step, so its answers come
 * from the full recomputation; the book under test is queried after every
 * update, so it walks the incremental path. A seeded random walk of level
 * changes (sets, replacements, removals — including of absent levels — on both
 * sides) with interleaved snapshots.
 */

import { describe, expect, it } from "vitest";

import { OutcomeTokenBook } from "./book.js";
import type { BookIngestMeta } from "./ingest.js";

const MARKET_ID = "0192aaaa-bbbb-7ccc-8ddd-eeeeffff0001";
const TOKEN_ID = "123";
const EPOCH = "018f0000-0000-7000-8000-00000000000a";

function meta(seq: number): BookIngestMeta {
  return {
    gatewayEpoch: EPOCH,
    ingestSeq: String(seq),
    subscriptionGeneration: 1,
    receivedAt: "2026-09-02T12:00:00.000Z",
  } as unknown as BookIngestMeta;
}

function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Op =
  | { readonly kind: "snapshot"; readonly bids: readonly [string, string][]; readonly asks: readonly [string, string][] }
  | { readonly kind: "level"; readonly side: "BID" | "ASK"; readonly price: string; readonly size: string };

function apply(book: OutcomeTokenBook, op: Op, seq: number): void {
  const outcome =
    op.kind === "snapshot"
      ? book.applySnapshot({
          payload: {
            internalMarketId: MARKET_ID,
            tokenId: TOKEN_ID,
            bids: op.bids.map(([price, size]) => ({ price, size })),
            asks: op.asks.map(([price, size]) => ({ price, size })),
          },
          meta: meta(seq),
        })
      : book.applyLevelChange({
          payload: { internalMarketId: MARKET_ID, tokenId: TOKEN_ID, side: op.side, price: op.price, size: op.size },
          meta: meta(seq),
        });
  expect(outcome.applied).toBe(true);
}

function observe(book: OutcomeTokenBook): unknown {
  return {
    bids: book.levels("BID"),
    asks: book.levels("ASK"),
    depth: book.depth(),
    top: book.topOfBook(),
  };
}

describe("OutcomeTokenBook side caches (THROUGHPUT-1a)", () => {
  it("answer, after every update, what a fresh recomputation answers", () => {
    const random = prng(20260929);
    const price = () => (random() < 0.05 ? (random() < 0.5 ? "0" : "1") : `0.${String(1 + Math.floor(random() * 98)).padStart(2, "0")}`.replace(/0$/u, ""));
    const size = () => (random() < 0.25 ? "0" : `${String(1 + Math.floor(random() * 5000))}${random() < 0.5 ? "" : `.${String(1 + Math.floor(random() * 9))}`}`);
    const ops: Op[] = [
      { kind: "snapshot", bids: [["0.4", "100"], ["0.39", "5.5"]], asks: [["0.41", "7"], ["0.6", "1"]] },
    ];
    for (let index = 0; index < 300; index += 1) {
      if (random() < 0.01) {
        ops.push({ kind: "snapshot", bids: [["0.3", "10"]], asks: [["0.7", "20"], ["0.71", "1.5"]] });
      } else {
        ops.push({ kind: "level", side: random() < 0.5 ? "BID" : "ASK", price: price(), size: size() });
      }
    }

    const incremental = new OutcomeTokenBook({ internalMarketId: MARKET_ID, tokenId: TOKEN_ID });
    let seq = 0;
    for (const op of ops) {
      seq += 1;
      apply(incremental, op, seq);
      // The oracle: a new book, the same updates, queried once.
      const oracle = new OutcomeTokenBook({ internalMarketId: MARKET_ID, tokenId: TOKEN_ID });
      let oracleSeq = 0;
      for (const replay of ops.slice(0, seq)) {
        oracleSeq += 1;
        apply(oracle, replay, oracleSeq);
      }
      expect(observe(incremental), `after update ${String(seq)}`).toEqual(observe(oracle));
    }
  });

  it("hands out fresh ladder objects: a caller mutating one does not reach the book", () => {
    const book = new OutcomeTokenBook({ internalMarketId: MARKET_ID, tokenId: TOKEN_ID });
    apply(book, { kind: "snapshot", bids: [["0.4", "100"]], asks: [["0.5", "1"]] }, 1);
    const first = book.levels("BID") as { price: string; size: string }[];
    first[0] = { price: "0.99", size: "1" };
    first.push({ price: "0.01", size: "1" });
    expect(book.levels("BID")).toEqual([{ price: "0.4", size: "100" }]);
    expect(book.depth().bidShares).toBe("100");
  });
});
