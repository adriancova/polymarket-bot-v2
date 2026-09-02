import { describe, expect, it } from "vitest";

import type { BookIngestMeta } from "./ingest.js";
import { OutcomeTokenBook } from "./book.js";
import { OrderBookConfigurationError } from "./errors.js";

const MARKET_ID = "0192aaaa-bbbb-7ccc-8ddd-eeeeffff0001";
const TOKEN_ID = "123";
const OTHER_TOKEN_ID = "456";
const EPOCH_A = "018f0000-0000-7000-8000-00000000000a";
const EPOCH_B = "018f0000-0000-7000-8000-00000000000b";

type MetaOverrides = { readonly [K in keyof BookIngestMeta]?: BookIngestMeta[K] | undefined };

/** An explicit `undefined` override REMOVES the field (e.g. no generation). */
function meta(overrides: MetaOverrides = {}): BookIngestMeta {
  const merged: MetaOverrides = {
    gatewayEpoch: EPOCH_A,
    ingestSeq: "10",
    subscriptionGeneration: 1,
    receivedAt: "2026-09-02T12:00:00.000Z",
    ...overrides,
  };
  return Object.fromEntries(
    Object.entries(merged).filter(([, value]) => value !== undefined),
  ) as unknown as BookIngestMeta;
}

function snapshotPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    internalMarketId: MARKET_ID,
    tokenId: TOKEN_ID,
    bids: [
      { price: "0.07", size: "5000" },
      { price: "0.08", size: "33343.4" },
    ],
    asks: [
      { price: "0.09", size: "163939.58" },
      { price: "0.1", size: "7500.25" },
    ],
    venueBookHash: "0x0000000000000000000000000000000000000000000000000000000000abc123",
    ...overrides,
  };
}

function levelChangePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    internalMarketId: MARKET_ID,
    tokenId: TOKEN_ID,
    side: "BID",
    price: "0.08",
    size: "5",
    ...overrides,
  };
}

function seededBook(): OutcomeTokenBook {
  const book = new OutcomeTokenBook({ internalMarketId: MARKET_ID, tokenId: TOKEN_ID });
  const outcome = book.applySnapshot({ payload: snapshotPayload(), meta: meta() });
  expect(outcome.applied).toBe(true);
  return book;
}

describe("OutcomeTokenBook construction", () => {
  it("refuses a non-canonical internalMarketId with a typed error", () => {
    expect(
      () => new OutcomeTokenBook({ internalMarketId: "not-a-uuid", tokenId: TOKEN_ID }),
    ).toThrowError(OrderBookConfigurationError);
    try {
      new OutcomeTokenBook({ internalMarketId: MARKET_ID.toUpperCase(), tokenId: TOKEN_ID });
      expect.unreachable("uppercase UUID must be refused, never case-folded (ADR-016)");
    } catch (error) {
      expect((error as OrderBookConfigurationError).code).toBe("ORDER_BOOK_BAD_MARKET_ID");
    }
  });

  it("refuses a non-canonical tokenId with a typed error", () => {
    try {
      new OutcomeTokenBook({ internalMarketId: MARKET_ID, tokenId: "0123" });
      expect.unreachable("leading-zero token id must be refused");
    } catch (error) {
      expect((error as OrderBookConfigurationError).code).toBe("ORDER_BOOK_BAD_TOKEN_ID");
    }
  });
});

describe("applySnapshot", () => {
  it("baselines the book: levels, hash, baseline identity, last update", () => {
    const book = seededBook();
    expect(book.levels("BID")).toEqual([
      { price: "0.08", size: "33343.4" },
      { price: "0.07", size: "5000" },
    ]);
    expect(book.levels("ASK")).toEqual([
      { price: "0.09", size: "163939.58" },
      { price: "0.1", size: "7500.25" },
    ]);
    expect(book.venueBookHash()).toBe(
      "0x0000000000000000000000000000000000000000000000000000000000abc123",
    );
    expect(book.baseline()).toEqual({ gatewayEpoch: EPOCH_A, subscriptionGeneration: 1 });
    expect(book.lastUpdate()).toMatchObject({
      kind: "SNAPSHOT",
      gatewayEpoch: EPOCH_A,
      ingestSeq: "10",
      subscriptionGeneration: 1,
    });
    expect(book.updatesApplied()).toBe(1);
  });

  it("refuses a payload that fails the frozen domain contract", () => {
    const book = new OutcomeTokenBook({ internalMarketId: MARKET_ID, tokenId: TOKEN_ID });
    const outcome = book.applySnapshot({
      payload: snapshotPayload({ bids: [{ price: 0.07, size: "5000" }] }),
      meta: meta(),
    });
    expect(outcome.applied).toBe(false);
    if (!outcome.applied) {
      expect(outcome.refusal.code).toBe("ORDER_BOOK_INPUT_INVALID");
    }
  });

  it('refuses a non-canonical decimal spelling ("0.10") via the domain contract — the grammar decision is fail-closed', () => {
    const book = new OutcomeTokenBook({ internalMarketId: MARKET_ID, tokenId: TOKEN_ID });
    const outcome = book.applySnapshot({
      payload: snapshotPayload({ bids: [{ price: "0.10", size: "5000" }] }),
      meta: meta(),
    });
    expect(outcome.applied).toBe(false);
    if (!outcome.applied) {
      expect(outcome.refusal.code).toBe("ORDER_BOOK_INPUT_INVALID");
    }
  });

  it("refuses a snapshot for another market or token (books are never mixed)", () => {
    const book = seededBook();
    const outcome = book.applySnapshot({
      payload: snapshotPayload({ tokenId: OTHER_TOKEN_ID }),
      meta: meta({ ingestSeq: "11" }),
    });
    expect(outcome.applied).toBe(false);
    if (!outcome.applied) {
      expect(outcome.refusal.code).toBe("ORDER_BOOK_IDENTITY_MISMATCH");
      expect(outcome.refusal.evidence).toMatchObject({
        payloadTokenId: OTHER_TOKEN_ID,
        bookTokenId: TOKEN_ID,
      });
    }
  });

  it("refuses an UNSTAMPED snapshot — the shape the generic REST fetcher produces today when its caller omits the generation — so the WP-120 composition root MUST stamp gap-closing snapshots via the fetcher context", () => {
    // Producer reality (remediation round 1, finding M1): the generic REST
    // fetcher takes `subscriptionGeneration` as an OPTIONAL context field
    // (`polymarket-public/src/snapshot/fetcher.ts`), and the normalizer then
    // omits it from provenance (`polymarket-public/src/normalize/snapshot.ts`).
    // A BookSnapshot with no generation is therefore a PRESENT capability of
    // the shipped producer, not a hypothetical. This refusal is the intended
    // integration failure mode at the WP-120 boundary: typed and visible,
    // never silent adoption of an unattributable baseline.
    const book = new OutcomeTokenBook({ internalMarketId: MARKET_ID, tokenId: TOKEN_ID });
    const outcome = book.applySnapshot({
      payload: snapshotPayload(),
      meta: meta({ subscriptionGeneration: undefined }),
    });
    expect(outcome.applied).toBe(false);
    if (!outcome.applied) {
      expect(outcome.refusal.code).toBe("ORDER_BOOK_MISSING_SUBSCRIPTION_GENERATION");
      expect(outcome.refusal.evidence).toEqual({ gatewayEpoch: EPOCH_A, ingestSeq: "10" });
    }
    // Nothing was adopted: the refused snapshot left no baseline behind.
    expect(book.baseline()).toBeUndefined();
    expect(book.updatesApplied()).toBe(0);
  });

  it("acceptance 2: a stale subscription generation is rejected, carrying both generations", () => {
    const book = new OutcomeTokenBook({ internalMarketId: MARKET_ID, tokenId: TOKEN_ID });
    expect(
      book.applySnapshot({
        payload: snapshotPayload(),
        meta: meta({ subscriptionGeneration: 3 }),
      }).applied,
    ).toBe(true);

    const staleSnapshot = book.applySnapshot({
      payload: snapshotPayload(),
      meta: meta({ ingestSeq: "11", subscriptionGeneration: 2 }),
    });
    expect(staleSnapshot.applied).toBe(false);
    if (!staleSnapshot.applied) {
      expect(staleSnapshot.refusal.code).toBe("ORDER_BOOK_STALE_SUBSCRIPTION_GENERATION");
      expect(staleSnapshot.refusal.evidence).toEqual({
        incomingGeneration: 2,
        currentGeneration: 3,
      });
    }

    const staleChange = book.applyLevelChange({
      payload: levelChangePayload(),
      meta: meta({ ingestSeq: "12", subscriptionGeneration: 2 }),
    });
    expect(staleChange.applied).toBe(false);
    if (!staleChange.applied) {
      expect(staleChange.refusal.code).toBe("ORDER_BOOK_STALE_SUBSCRIPTION_GENERATION");
      expect(staleChange.refusal.evidence).toEqual({
        incomingGeneration: 2,
        currentGeneration: 3,
      });
    }

    // The stale updates changed nothing.
    expect(book.baseline()).toEqual({ gatewayEpoch: EPOCH_A, subscriptionGeneration: 3 });
    expect(book.levels("BID")).toEqual([
      { price: "0.08", size: "33343.4" },
      { price: "0.07", size: "5000" },
    ]);
  });

  it("a snapshot with a NEWER generation re-baselines (gap recovery)", () => {
    const book = seededBook();
    const outcome = book.applySnapshot({
      payload: snapshotPayload({ bids: [{ price: "0.05", size: "10" }], asks: [] }),
      meta: meta({ ingestSeq: "20", subscriptionGeneration: 2 }),
    });
    expect(outcome.applied).toBe(true);
    expect(book.baseline()).toEqual({ gatewayEpoch: EPOCH_A, subscriptionGeneration: 2 });
    expect(book.levels("BID")).toEqual([{ price: "0.05", size: "10" }]);
    expect(book.levels("ASK")).toEqual([]);
    // The snapshot carried no hash, so no stale hash is retained.
    const rebaselined = book.applySnapshot({
      payload: snapshotPayload({ venueBookHash: undefined }),
      meta: meta({ ingestSeq: "21", subscriptionGeneration: 2 }),
    });
    expect(rebaselined.applied).toBe(true);
    expect(book.venueBookHash()).toBeUndefined();
  });

  it("a snapshot from a DIFFERENT epoch re-baselines onto the new epoch", () => {
    const book = seededBook();
    const outcome = book.applySnapshot({
      payload: snapshotPayload(),
      // A new epoch restarts ingestSeq; "1" here is legal because ordering is
      // per-epoch only (wal-format §12.1).
      meta: meta({ gatewayEpoch: EPOCH_B, ingestSeq: "1", subscriptionGeneration: 1 }),
    });
    expect(outcome.applied).toBe(true);
    expect(book.baseline()).toEqual({ gatewayEpoch: EPOCH_B, subscriptionGeneration: 1 });
  });

  it("a NEW-epoch snapshot carrying a LOWER generation than the baseline re-baselines — epochs are identity, not chronology (wal-format §12.1); generations are per-feed counters that reset with a new feed instance", () => {
    const book = new OutcomeTokenBook({ internalMarketId: MARKET_ID, tokenId: TOKEN_ID });
    expect(
      book.applySnapshot({
        payload: snapshotPayload(),
        meta: meta({ subscriptionGeneration: 5 }),
      }).applied,
    ).toBe(true);
    expect(book.baseline()).toEqual({ gatewayEpoch: EPOCH_A, subscriptionGeneration: 5 });

    // A restarted gateway (new epoch) runs a restarted feed whose generation
    // counter began again at 1, so "2" being numerically lower than "5" says
    // nothing about time. This snapshot is the §7.1 "new authoritative
    // snapshot" a restart requires, and it re-baselines wholesale.
    const outcome = book.applySnapshot({
      payload: snapshotPayload({ bids: [{ price: "0.05", size: "10" }], asks: [] }),
      meta: meta({ gatewayEpoch: EPOCH_B, ingestSeq: "1", subscriptionGeneration: 2 }),
    });
    expect(outcome.applied).toBe(true);
    expect(book.baseline()).toEqual({ gatewayEpoch: EPOCH_B, subscriptionGeneration: 2 });
    expect(book.levels("BID")).toEqual([{ price: "0.05", size: "10" }]);
    expect(book.levels("ASK")).toEqual([]);

    // Generation comparisons now run against the NEW baseline only. The old
    // epoch's higher number is AHEAD here — refused pending a snapshot, not
    // treated as "newer in time".
    const oldEpochsNumber = book.applyLevelChange({
      payload: levelChangePayload({ price: "0.05", size: "1" }),
      meta: meta({ gatewayEpoch: EPOCH_B, ingestSeq: "2", subscriptionGeneration: 5 }),
    });
    expect(oldEpochsNumber.applied).toBe(false);
    if (!oldEpochsNumber.applied) {
      expect(oldEpochsNumber.refusal.code).toBe("ORDER_BOOK_GENERATION_AHEAD_REQUIRES_SNAPSHOT");
      expect(oldEpochsNumber.refusal.evidence).toEqual({
        incomingGeneration: 5,
        currentGeneration: 2,
      });
    }

    // A delta matching the new baseline applies.
    const matching = book.applyLevelChange({
      payload: levelChangePayload({ price: "0.05", size: "7" }),
      meta: meta({ gatewayEpoch: EPOCH_B, ingestSeq: "3", subscriptionGeneration: 2 }),
    });
    expect(matching.applied).toBe(true);
    expect(book.levels("BID")).toEqual([{ price: "0.05", size: "7" }]);
  });

  it("refuses a replayed or reordered snapshot within one epoch (ingestSeq must strictly increase)", () => {
    const book = seededBook();
    const outcome = book.applySnapshot({
      payload: snapshotPayload(),
      meta: meta({ ingestSeq: "10" }),
    });
    expect(outcome.applied).toBe(false);
    if (!outcome.applied) {
      expect(outcome.refusal.code).toBe("ORDER_BOOK_OUT_OF_ORDER_INGEST");
      expect(outcome.refusal.evidence).toEqual({ incomingIngestSeq: "10", lastIngestSeq: "10" });
    }
  });

  it("refuses a snapshot side carrying the same price twice (depth ambiguous)", () => {
    const book = new OutcomeTokenBook({ internalMarketId: MARKET_ID, tokenId: TOKEN_ID });
    const outcome = book.applySnapshot({
      payload: snapshotPayload({
        bids: [
          { price: "0.07", size: "1" },
          { price: "0.07", size: "2" },
        ],
      }),
      meta: meta(),
    });
    expect(outcome.applied).toBe(false);
    if (!outcome.applied) {
      expect(outcome.refusal.code).toBe("ORDER_BOOK_DUPLICATE_SNAPSHOT_LEVEL");
    }
    expect(book.baseline()).toBeUndefined();
  });

  it("drops a zero-size snapshot level (ADR-013: zero asserts absence)", () => {
    const book = new OutcomeTokenBook({ internalMarketId: MARKET_ID, tokenId: TOKEN_ID });
    const outcome = book.applySnapshot({
      payload: snapshotPayload({
        bids: [
          { price: "0.07", size: "0" },
          { price: "0.06", size: "5" },
        ],
      }),
      meta: meta(),
    });
    expect(outcome.applied).toBe(true);
    expect(book.levels("BID")).toEqual([{ price: "0.06", size: "5" }]);
  });

  it("refuses a UUID-shaped but non-lowercase gatewayEpoch, carrying the raw value (ADR-016)", () => {
    const book = new OutcomeTokenBook({ internalMarketId: MARKET_ID, tokenId: TOKEN_ID });
    const rawEpoch = EPOCH_A.toUpperCase();
    const outcome = book.applySnapshot({
      payload: snapshotPayload(),
      meta: meta({ gatewayEpoch: rawEpoch }),
    });
    expect(outcome.applied).toBe(false);
    if (!outcome.applied) {
      expect(outcome.refusal.code).toBe("ORDER_BOOK_UUID_NOT_CANONICAL");
      expect(outcome.refusal.evidence).toEqual({ gatewayEpoch: rawEpoch });
    }
  });
});

describe("applyLevelChange (ADR-013 semantics)", () => {
  it("REPLACES the size at the named level — never adds, never subtracts", () => {
    // The exact ADR-013 §2 example: a level at "120" receiving size "5"
    // results in "5", never "125" and never "115".
    const book = new OutcomeTokenBook({ internalMarketId: MARKET_ID, tokenId: TOKEN_ID });
    expect(
      book.applySnapshot({
        payload: snapshotPayload({ bids: [{ price: "0.08", size: "120" }], asks: [] }),
        meta: meta(),
      }).applied,
    ).toBe(true);
    const outcome = book.applyLevelChange({
      payload: levelChangePayload({ price: "0.08", size: "5" }),
      meta: meta({ ingestSeq: "11" }),
    });
    expect(outcome.applied).toBe(true);
    expect(book.levels("BID")).toEqual([{ price: "0.08", size: "5" }]);
  });

  it('size "0" REMOVES the level', () => {
    const book = seededBook();
    const outcome = book.applyLevelChange({
      payload: levelChangePayload({ price: "0.08", size: "0" }),
      meta: meta({ ingestSeq: "11" }),
    });
    expect(outcome.applied).toBe(true);
    expect(book.levels("BID")).toEqual([{ price: "0.07", size: "5000" }]);
  });

  it('size "0" for an absent level is an applied no-op (the venue asserts absence; it is absent)', () => {
    const book = seededBook();
    const outcome = book.applyLevelChange({
      payload: levelChangePayload({ price: "0.05", size: "0" }),
      meta: meta({ ingestSeq: "11" }),
    });
    expect(outcome.applied).toBe(true);
    expect(book.levels("BID")).toEqual([
      { price: "0.08", size: "33343.4" },
      { price: "0.07", size: "5000" },
    ]);
  });

  it("inserts a new level on either side", () => {
    const book = seededBook();
    expect(
      book.applyLevelChange({
        payload: levelChangePayload({ side: "ASK", price: "0.11", size: "42.5" }),
        meta: meta({ ingestSeq: "11" }),
      }).applied,
    ).toBe(true);
    expect(book.levels("ASK")).toEqual([
      { price: "0.09", size: "163939.58" },
      { price: "0.1", size: "7500.25" },
      { price: "0.11", size: "42.5" },
    ]);
  });

  it("refuses a level change before any baseline snapshot (§7.1)", () => {
    const book = new OutcomeTokenBook({ internalMarketId: MARKET_ID, tokenId: TOKEN_ID });
    const outcome = book.applyLevelChange({ payload: levelChangePayload(), meta: meta() });
    expect(outcome.applied).toBe(false);
    if (!outcome.applied) {
      expect(outcome.refusal.code).toBe("ORDER_BOOK_NO_BASELINE_SNAPSHOT");
    }
  });

  it("refuses a level change from a different gatewayEpoch (epochs are identity, not chronology)", () => {
    const book = seededBook();
    const outcome = book.applyLevelChange({
      payload: levelChangePayload(),
      meta: meta({ gatewayEpoch: EPOCH_B, ingestSeq: "1" }),
    });
    expect(outcome.applied).toBe(false);
    if (!outcome.applied) {
      expect(outcome.refusal.code).toBe("ORDER_BOOK_EPOCH_MISMATCH");
      expect(outcome.refusal.evidence).toEqual({
        incomingGatewayEpoch: EPOCH_B,
        baselineGatewayEpoch: EPOCH_A,
      });
    }
  });

  it("refuses a level change with a NEWER generation until a snapshot re-baselines (§7.1 gap rule)", () => {
    const book = seededBook();
    const outcome = book.applyLevelChange({
      payload: levelChangePayload(),
      meta: meta({ ingestSeq: "11", subscriptionGeneration: 2 }),
    });
    expect(outcome.applied).toBe(false);
    if (!outcome.applied) {
      expect(outcome.refusal.code).toBe("ORDER_BOOK_GENERATION_AHEAD_REQUIRES_SNAPSHOT");
      expect(outcome.refusal.evidence).toEqual({ incomingGeneration: 2, currentGeneration: 1 });
    }
  });

  it("refuses a level change with no generation (fail closed)", () => {
    const book = seededBook();
    const outcome = book.applyLevelChange({
      payload: levelChangePayload(),
      meta: meta({ ingestSeq: "11", subscriptionGeneration: undefined }),
    });
    expect(outcome.applied).toBe(false);
    if (!outcome.applied) {
      expect(outcome.refusal.code).toBe("ORDER_BOOK_MISSING_SUBSCRIPTION_GENERATION");
    }
  });

  it("refuses a replayed level change (ingestSeq must strictly increase)", () => {
    const book = seededBook();
    expect(
      book.applyLevelChange({
        payload: levelChangePayload(),
        meta: meta({ ingestSeq: "11" }),
      }).applied,
    ).toBe(true);
    const replay = book.applyLevelChange({
      payload: levelChangePayload(),
      meta: meta({ ingestSeq: "11" }),
    });
    expect(replay.applied).toBe(false);
    if (!replay.applied) {
      expect(replay.refusal.code).toBe("ORDER_BOOK_OUT_OF_ORDER_INGEST");
    }
  });

  it("tracks a venue book hash carried on an applied level change", () => {
    const book = seededBook();
    expect(
      book.applyLevelChange({
        payload: levelChangePayload({ venueBookHash: "feedbeef" }),
        meta: meta({ ingestSeq: "11" }),
      }).applied,
    ).toBe(true);
    expect(book.venueBookHash()).toBe("feedbeef");
  });
});

describe("queries (§9.4 tracked values)", () => {
  it("reports best bid, best ask, and exact spread", () => {
    const book = seededBook();
    expect(book.topOfBook()).toEqual({
      bestBidPrice: "0.08",
      bestBidSize: "33343.4",
      bestAskPrice: "0.09",
      bestAskSize: "163939.58",
      spread: "0.01",
    });
  });

  it("omits a side's fields when it is empty, and the spread with them", () => {
    const book = new OutcomeTokenBook({ internalMarketId: MARKET_ID, tokenId: TOKEN_ID });
    expect(
      book.applySnapshot({
        payload: snapshotPayload({ asks: [] }),
        meta: meta(),
      }).applied,
    ).toBe(true);
    expect(book.topOfBook()).toEqual({ bestBidPrice: "0.08", bestBidSize: "33343.4" });
  });

  it("reports depth with exact per-side sums", () => {
    const book = seededBook();
    expect(book.depth()).toEqual({
      bidLevels: 2,
      askLevels: 2,
      bidShares: "38343.4",
      askShares: "171439.83",
    });
  });

  it("reports staleness against a caller-supplied now, and never reads a clock", () => {
    const book = seededBook();
    const receivedAtMs = Date.parse("2026-09-02T12:00:00.000Z");
    expect(book.stalenessMs(receivedAtMs + 1500)).toEqual({ known: true, stalenessMs: 1500 });
    // A caller clock behind the gateway's yields a negative value, as-is.
    expect(book.stalenessMs(receivedAtMs - 10)).toEqual({ known: true, stalenessMs: -10 });
  });

  it("reports staleness as unknown before any update, and without receivedAt", () => {
    const empty = new OutcomeTokenBook({ internalMarketId: MARKET_ID, tokenId: TOKEN_ID });
    expect(empty.stalenessMs(0)).toEqual({ known: false, reason: "NO_UPDATE" });

    const book = new OutcomeTokenBook({ internalMarketId: MARKET_ID, tokenId: TOKEN_ID });
    expect(
      book.applySnapshot({
        payload: snapshotPayload(),
        meta: meta({ receivedAt: undefined }),
      }).applied,
    ).toBe(true);
    expect(book.stalenessMs(0)).toEqual({ known: false, reason: "NO_RECEIVED_AT" });
  });
});
