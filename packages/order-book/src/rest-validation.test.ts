import { describe, expect, it } from "vitest";

import type { BookIngestMeta } from "./ingest.js";
import { OutcomeTokenBook } from "./book.js";
import { compareAgainstRestSnapshot } from "./rest-validation.js";

const MARKET_ID = "0192aaaa-bbbb-7ccc-8ddd-eeeeffff0001";
const TOKEN_ID = "123";
const EPOCH = "018f0000-0000-7000-8000-00000000000a";

const META: BookIngestMeta = {
  gatewayEpoch: EPOCH,
  ingestSeq: "1",
  subscriptionGeneration: 1,
};

const BIDS = [
  { price: "0.07", size: "5000" },
  { price: "0.08", size: "33343.4" },
];
const ASKS = [
  { price: "0.09", size: "163939.58" },
  { price: "0.1", size: "7500.25" },
];

function reconstructedBook(): OutcomeTokenBook {
  const book = new OutcomeTokenBook({ internalMarketId: MARKET_ID, tokenId: TOKEN_ID });
  const outcome = book.applySnapshot({
    payload: {
      internalMarketId: MARKET_ID,
      tokenId: TOKEN_ID,
      bids: BIDS,
      asks: ASKS,
      venueBookHash: "wshash",
    },
    meta: META,
  });
  expect(outcome.applied).toBe(true);
  return book;
}

describe("compareAgainstRestSnapshot", () => {
  it("agrees with a matching snapshot regardless of level array order (the venue promises no order — verified-2026-09-02 §6)", () => {
    const book = reconstructedBook();
    // The two published, mutually contradictory orders, plus a shuffled one:
    const orderings = [
      // OpenAPI: bids descending, asks ascending.
      { bids: [...BIDS].reverse(), asks: [...ASKS] },
      // Prose page: bids ascending, asks descending.
      { bids: [...BIDS], asks: [...ASKS].reverse() },
      // No order at all.
      { bids: [BIDS[1]!, BIDS[0]!], asks: [ASKS[1]!, ASKS[0]!] },
    ];
    for (const ordering of orderings) {
      const report = compareAgainstRestSnapshot(book, {
        internalMarketId: MARKET_ID,
        tokenId: TOKEN_ID,
        bids: ordering.bids,
        asks: ordering.asks,
        venueBookHash: "resthash",
      });
      expect(report.ok).toBe(true);
      expect(report.divergences).toEqual([]);
      expect(report.levelsAgreed).toBe(4);
    }
  });

  it("names a level the book lacks, a level the snapshot lacks, and a size mismatch", () => {
    const book = reconstructedBook();
    const report = compareAgainstRestSnapshot(book, {
      bids: [
        { price: "0.07", size: "5000" },
        { price: "0.06", size: "9" }, // book lacks this
      ],
      asks: [
        { price: "0.09", size: "163939.59" }, // size differs in the last byte
        // book's 0.1 level missing from the snapshot
      ],
    });
    expect(report.ok).toBe(false);
    expect(report.levelsAgreed).toBe(1);
    expect(report.divergences).toEqual([
      {
        kind: "LEVEL_MISSING_FROM_BOOK",
        side: "BID",
        price: "0.06",
        snapshotSize: "9",
        detail: expect.any(String),
      },
      {
        kind: "LEVEL_NOT_IN_SNAPSHOT",
        side: "BID",
        price: "0.08",
        bookSize: "33343.4",
        detail: expect.any(String),
      },
      {
        kind: "LEVEL_SIZE_MISMATCH",
        side: "ASK",
        price: "0.09",
        bookSize: "163939.58",
        snapshotSize: "163939.59",
        detail: expect.any(String),
      },
      {
        kind: "LEVEL_NOT_IN_SNAPSHOT",
        side: "ASK",
        price: "0.1",
        bookSize: "7500.25",
        detail: expect.any(String),
      },
    ]);
  });

  it("compares canonical forms byte-exactly: a non-canonical snapshot spelling is a named finding, never normalized here", () => {
    const book = reconstructedBook();
    const report = compareAgainstRestSnapshot(book, {
      bids: [
        { price: "0.070", size: "5000" }, // non-canonical spelling of the same value
        { price: "0.08", size: "33343.4" },
      ],
      asks: ASKS,
    });
    expect(report.ok).toBe(false);
    expect(report.divergences).toContainEqual(
      expect.objectContaining({ kind: "SNAPSHOT_LEVEL_NOT_CANONICAL", side: "BID", price: "0.070" }),
    );
    // The 0.07 book level is then reported as absent from the snapshot: the
    // comparison fails closed rather than guessing that "0.070" meant it.
    expect(report.divergences).toContainEqual(
      expect.objectContaining({ kind: "LEVEL_NOT_IN_SNAPSHOT", side: "BID", price: "0.07" }),
    );
  });

  it("treats a zero-size snapshot level as an empty level (ADR-013 zero-removal reading)", () => {
    const book = reconstructedBook();
    const report = compareAgainstRestSnapshot(book, {
      bids: [...BIDS, { price: "0.05", size: "0" }],
      asks: ASKS,
    });
    expect(report.ok).toBe(true);
  });

  it("names a duplicate snapshot level", () => {
    const book = reconstructedBook();
    const report = compareAgainstRestSnapshot(book, {
      bids: [...BIDS, { price: "0.07", size: "1" }],
      asks: ASKS,
    });
    expect(report.ok).toBe(false);
    expect(report.divergences).toContainEqual(
      expect.objectContaining({ kind: "SNAPSHOT_DUPLICATE_LEVEL", side: "BID", price: "0.07" }),
    );
  });

  it("refuses to compare a snapshot naming a different market/token", () => {
    const book = reconstructedBook();
    const report = compareAgainstRestSnapshot(book, {
      internalMarketId: MARKET_ID,
      tokenId: "456",
      bids: BIDS,
      asks: ASKS,
    });
    expect(report.ok).toBe(false);
    expect(report.divergences).toEqual([
      expect.objectContaining({ kind: "SNAPSHOT_IDENTITY_MISMATCH" }),
    ]);
    expect(report.levelsAgreed).toBe(0);
  });

  it("reports both venue hashes and never judges cross-surface equality", () => {
    const book = reconstructedBook();
    const report = compareAgainstRestSnapshot(book, {
      bids: BIDS,
      asks: ASKS,
      venueBookHash: "resthash",
    });
    expect(report.bookVenueBookHash).toBe("wshash");
    expect(report.snapshotVenueBookHash).toBe("resthash");
    expect(report.hashesComparableAcrossSurfaces).toBe(false);
    // Different hash strings did NOT produce a divergence: the verdict rests
    // on levels alone.
    expect(report.ok).toBe(true);
  });
});
