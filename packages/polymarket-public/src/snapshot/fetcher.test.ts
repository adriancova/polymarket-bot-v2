import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

  it("accepts a book whose two absence-tolerant fields are null or empty", async () => {
    // `timestamp` and `last_trade_price` are the only two the SDK declares
    // nullish; the official OpenAPI lists all ten under `required`, and
    // round-1 finding M1 restored the other eight (`../venue/order-book.ts`).
    const { subject } = fetcher(() => ({
      status: 200,
      body: JSON.stringify(bookBody({ timestamp: null, last_trade_price: "" })),
    }));
    const result = await subject.fetchSnapshot(MARKET.yesTokenId);
    expect(result.problems).toEqual([]);
    expect(result.events[0]?.provenance).not.toHaveProperty("venueTimestamp");
  });

  it("refuses a book missing a field the REST contract requires", async () => {
    // A snapshot is the authority a gap recovery rebuilds from; a body that
    // does not match the published contract fails loudly instead of becoming a
    // half-populated authoritative document.
    for (const field of ["hash", "min_order_size", "tick_size", "neg_risk"]) {
      const body = bookBody() as Record<string, unknown>;
      delete body[field];
      const { subject } = fetcher(() => ({ status: 200, body: JSON.stringify(body) }));
      await expect(subject.fetchSnapshot(MARKET.yesTokenId), field).rejects.toBeInstanceOf(
        PublicMarketSnapshotInvalidError,
      );
    }
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

// ---------------------------------------------------------------------------
// Polymarket Protocol V2 (`V2-2`, plan row A10)
// ---------------------------------------------------------------------------

describe("Protocol V2: books are seeded by the V2 position id (A10)", () => {
  // `VENUE-4`'s capture of `GET /book?token_id=<V2 position id>` (S-L03,
  // `docs/venue/verified-2026-10-05.md` O.2): the response body, byte for byte.
  const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
  const BOOK_V2_BODY = readFileSync(resolve(REPO_ROOT, "test/fixtures/venue/protocol-v2/book-v2.jsonc"), "utf8");
  const BOOK_V2_PROVENANCE = JSON.parse(
    readFileSync(resolve(REPO_ROOT, "test/fixtures/venue/protocol-v2/book-v2.provenance.jsonc"), "utf8"),
  ) as { readonly url: string; readonly http_status: string; readonly redactions: readonly unknown[] };
  const V2_YES = "663574927012476832975694178961957910328055987427402067619466963999000625152";
  const V2_NO = "663574927012476832975694178961957910328055987427402067619466963999000625153";
  const V2_MARKET = {
    internalMarketId: "0199f0a0-0000-7000-8000-000000000002",
    // Gamma's documented 31-byte width (F-43); the book names the 32-byte form.
    conditionId: "0x017791f201d5a788e0039e511fc1900e5f0000000000000000000000000000",
    yesTokenId: V2_YES,
    noTokenId: V2_NO,
  };

  function v2Fetcher(respond: Parameters<typeof stubHttpClient>[0]) {
    const http = stubHttpClient(respond);
    return {
      http,
      subject: new PublicBookSnapshotFetcher({
        http: http.client,
        directory: staticMarketDirectory({ known: [V2_MARKET] }),
      }),
    };
  }

  it("GETs the documented single-book endpoint with the 75-digit id unchanged, and normalizes the V2 body", async () => {
    const { http, subject } = v2Fetcher(() => ({ status: 200, body: BOOK_V2_BODY }));
    const result = await subject.fetchSnapshot(V2_YES, { subscriptionGeneration: 3 });
    expect(http.exchanges.map((exchange) => exchange.request)).toEqual([
      { method: "GET", url: `https://clob.polymarket.com/book?token_id=${V2_YES}` },
    ]);
    // It is the very URL `VENUE-4` fetched (its provenance sidecar), which answered 200 with this body, unredacted.
    expect(http.exchanges[0]?.request.url).toBe(BOOK_V2_PROVENANCE.url);
    expect(BOOK_V2_PROVENANCE.http_status).toBe("200");
    expect(BOOK_V2_PROVENANCE.redactions).toEqual([]);
    expect(BOOK_V2_BODY).toContain(`"asset_id":"${V2_YES}"`);
    expect(BOOK_V2_BODY).toContain(`"version":"v2"`);
    expect(result.problems).toEqual([]);
    expect(result.events.map((event) => event.payload)).toEqual([
      {
        internalMarketId: V2_MARKET.internalMarketId,
        tokenId: V2_YES,
        bids: [],
        asks: [],
        venueBookHash: "fc3846cab0c35a0977b6e5f605a4e5ff0d0b2277",
      },
    ]);
    expect(result.events[0]?.provenance).toMatchObject({
      sourceChannel: "polymarket:clob-book-rest",
      subscriptionGeneration: 3,
      venueTimestamp: "2026-10-05T22:20:58.575Z",
    });
  });

  it("POSTs both V2 ids to /books in the documented body; the venue's answer to that is unverified (U-42)", async () => {
    // `POST /books` with V2 ids was not tried by `VENUE-4` (U-42). This pins
    // only what this client sends and that a V2-shaped batch body normalizes;
    // it is not evidence of the venue's behaviour.
    const { http, subject } = v2Fetcher(() => ({ status: 200, body: `[${BOOK_V2_BODY}]` }));
    const result = await subject.fetchSnapshots([V2_YES, V2_NO]);
    expect(http.exchanges.map((exchange) => exchange.request)).toEqual([
      {
        method: "POST",
        url: "https://clob.polymarket.com/books",
        jsonBody: [{ token_id: V2_YES }, { token_id: V2_NO }],
      },
    ]);
    expect(result.problems).toEqual([]);
    expect(result.events.map((event) => [event.eventType, (event.payload as { tokenId: string }).tokenId])).toEqual([
      ["BookSnapshot", V2_YES],
    ]);
  });
});
