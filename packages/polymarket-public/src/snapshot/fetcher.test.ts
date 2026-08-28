import { describe, expect, it } from "vitest";

import {
  PublicMarketConfigurationError,
  PublicMarketSnapshotInvalidError,
  PublicMarketSnapshotUnavailableError,
} from "../errors.js";
import {
  staticMarketDirectory,
  stubHttpClient,
  testMarket,
} from "../testing/index.js";
import { PublicBookSnapshotFetcher } from "./fetcher.js";

const MARKET = testMarket(1);

function bookBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    market: MARKET.conditionId,
    asset_id: MARKET.yesTokenId,
    timestamp: "1782753357257",
    hash: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    // The venue documents ascending bids and descending asks.
    bids: [
      { price: "0.01", size: "2151131.59" },
      { price: "0.02", size: "139963.89" },
    ],
    asks: [
      { price: "0.99", size: "218442.27" },
      { price: "0.98", size: "13229.55" },
    ],
    min_order_size: "5",
    tick_size: "0.01",
    neg_risk: false,
    last_trade_price: "0.090",
    ...overrides,
  };
}

function fetcher(
  respond: Parameters<typeof stubHttpClient>[0],
  options: { readonly known?: boolean } = {},
) {
  const http = stubHttpClient(respond);
  const directory = staticMarketDirectory(
    options.known === false ? {} : { known: [MARKET] },
  );
  return {
    http,
    subject: new PublicBookSnapshotFetcher({ http: http.client, directory }),
  };
}

describe("fetchSnapshot", () => {
  it("calls the documented single-book endpoint", async () => {
    const { http, subject } = fetcher(() => ({ status: 200, body: JSON.stringify(bookBody()) }));
    await subject.fetchSnapshot(MARKET.yesTokenId);

    expect(http.exchanges).toHaveLength(1);
    expect(http.exchanges[0]?.request).toMatchObject({
      method: "GET",
      url: `https://clob.polymarket.com/book?token_id=${MARKET.yesTokenId}`,
    });
    expect(http.exchanges[0]?.request.jsonBody).toBeUndefined();
  });

  it("normalizes into the same BookSnapshot the WebSocket path produces", async () => {
    const { subject } = fetcher(() => ({ status: 200, body: JSON.stringify(bookBody()) }));
    const result = await subject.fetchSnapshot(MARKET.yesTokenId, {
      subscriptionGeneration: 4,
    });

    expect(result.problems).toEqual([]);
    expect(result.events).toHaveLength(1);
    const [event] = result.events;
    expect(event?.eventType).toBe("BookSnapshot");
    expect(event?.payload).toEqual({
      internalMarketId: MARKET.internalMarketId,
      tokenId: MARKET.yesTokenId,
      // Reordered into the domain's convention regardless of the wire order.
      bids: [
        { price: "0.02", size: "139963.89" },
        { price: "0.01", size: "2151131.59" },
      ],
      asks: [
        { price: "0.98", size: "13229.55" },
        { price: "0.99", size: "218442.27" },
      ],
      venueBookHash: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    });
    expect(event?.provenance).toMatchObject({
      source: "polymarket",
      sourceChannel: "polymarket:clob-book-rest",
      subscriptionGeneration: 4,
      venueTimestamp: "2026-06-29T17:15:57.257Z",
    });
  });

  it("accepts the 64-character hash the venue's own API example prints", async () => {
    // The SDK narrows the hash to 40 hex characters; the documentation's API tab
    // prints 64 for the same field. Pinning either would reject a documented
    // response, so the hash is carried opaquely.
    const hash = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
    const { subject } = fetcher(() => ({
      status: 200,
      body: JSON.stringify(bookBody({ hash })),
    }));
    const result = await subject.fetchSnapshot(MARKET.yesTokenId);
    expect(result.events[0]?.payload).toMatchObject({ venueBookHash: hash });
  });

  it("accepts a book whose optional fields are null or empty", async () => {
    const { subject } = fetcher(() => ({
      status: 200,
      body: JSON.stringify(
        bookBody({
          hash: null,
          timestamp: null,
          min_order_size: "",
          tick_size: null,
          neg_risk: null,
          last_trade_price: "",
        }),
      ),
    }));
    const result = await subject.fetchSnapshot(MARKET.yesTokenId);
    expect(result.problems).toEqual([]);
    expect(result.events[0]?.payload).not.toHaveProperty("venueBookHash");
    expect(result.events[0]?.provenance).not.toHaveProperty("venueTimestamp");
  });

  it("reports an unknown market as a problem, not as a thrown error", async () => {
    const { subject } = fetcher(
      () => ({ status: 200, body: JSON.stringify(bookBody()) }),
      { known: false },
    );
    const result = await subject.fetchSnapshot(MARKET.yesTokenId);
    expect(result.events).toEqual([]);
    expect(result.problems[0]?.code).toBe("UNRESOLVED_MARKET");
  });
});

describe("fetchSnapshot failure modes", () => {
  it("throws when the transport fails: a failed snapshot is not a recovery", async () => {
    const { subject } = fetcher(() => {
      throw new Error("connection refused");
    });
    await expect(subject.fetchSnapshot(MARKET.yesTokenId)).rejects.toBeInstanceOf(
      PublicMarketSnapshotUnavailableError,
    );
  });

  it("throws on a non-2xx status", async () => {
    const { subject } = fetcher(() => ({ status: 503, body: "" }));
    await expect(subject.fetchSnapshot(MARKET.yesTokenId)).rejects.toBeInstanceOf(
      PublicMarketSnapshotUnavailableError,
    );
  });

  it("throws when the body is not JSON", async () => {
    const { subject } = fetcher(() => ({ status: 200, body: "<html/>" }));
    await expect(subject.fetchSnapshot(MARKET.yesTokenId)).rejects.toBeInstanceOf(
      PublicMarketSnapshotInvalidError,
    );
  });

  it("throws when the body does not match the documented shape", async () => {
    const { subject } = fetcher(() => ({ status: 200, body: JSON.stringify({ nope: true }) }));
    await expect(subject.fetchSnapshot(MARKET.yesTokenId)).rejects.toBeInstanceOf(
      PublicMarketSnapshotInvalidError,
    );
  });
});

describe("fetchSnapshots", () => {
  it("calls the documented batch endpoint with the documented body", async () => {
    const { http, subject } = fetcher(() => ({
      status: 200,
      body: JSON.stringify([bookBody()]),
    }));
    await subject.fetchSnapshots([MARKET.yesTokenId]);

    expect(http.exchanges[0]?.request).toMatchObject({
      method: "POST",
      url: "https://clob.polymarket.com/books",
      jsonBody: [{ token_id: MARKET.yesTokenId }],
    });
  });

  it("deduplicates and skips empty token ids", async () => {
    const { http, subject } = fetcher(() => ({
      status: 200,
      body: JSON.stringify([bookBody()]),
    }));
    await subject.fetchSnapshots([MARKET.yesTokenId, MARKET.yesTokenId, ""]);
    expect(http.exchanges[0]?.request.jsonBody).toEqual([{ token_id: MARKET.yesTokenId }]);
  });

  it("issues no request at all for an empty token list", async () => {
    const { http, subject } = fetcher(() => ({ status: 200, body: "[]" }));
    const result = await subject.fetchSnapshots([]);
    expect(http.exchanges).toEqual([]);
    expect(result).toEqual({ events: [], problems: [] });
  });

  it("chunks at the client-side batch bound", async () => {
    const http = stubHttpClient(() => ({ status: 200, body: "[]" }));
    const subject = new PublicBookSnapshotFetcher({
      http: http.client,
      directory: staticMarketDirectory({ known: [MARKET] }),
      maximumBooksPerRequest: 2,
    });
    await subject.fetchSnapshots(["1", "2", "3", "4", "5"]);
    expect(http.exchanges).toHaveLength(3);
    expect(http.exchanges[2]?.request.jsonBody).toEqual([{ token_id: "5" }]);
  });

  it("refuses a batch size above the documented venue maximum", () => {
    const http = stubHttpClient(() => ({ status: 200, body: "[]" }));
    expect(
      () =>
        new PublicBookSnapshotFetcher({
          http: http.client,
          directory: staticMarketDirectory(),
          maximumBooksPerRequest: 501,
        }),
    ).toThrow(PublicMarketConfigurationError);
  });
});
