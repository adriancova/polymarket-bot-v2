/**
 * THE OUTBOUND ENCODERS ACCEPT A CALLER'S ARRAY SUBCLASS, BECAUSE NO CALLER'S
 * CONTAINER TYPE REACHES THEM (`SER-3` review round 1, finding M2).
 *
 * THE DEFECT, as the reviewer measured it. `rtds/frames.ts`'s
 * `buildSubscribeFrame` built the outbound `subscriptions` member with
 * `subscriptions.map(buildSubscriptionEntry)`, and `Array.prototype.map`
 * PRESERVES THE SPECIES of the array it is called on (ECMA-262
 * `ArraySpeciesCreate`). `RtdsTwapFeedOptions.subscriptions` is
 * `readonly RtdsTwapWindowSubscription[]`, which an `Array` SUBCLASS satisfies
 * with no cast; `resolveRtdsTwapFeedOptions` carries the caller's array through
 * by object spread and `validateSubscriptions` accepts it. So the frame's
 * `subscriptions` member WAS the subclass, and the own-data encoder — which
 * refuses a container whose prototype is neither `Array.prototype` nor `null` —
 * refused the whole frame at CONSTRUCTION:
 *
 * ```text
 * tip  {"stage":"construct","code":"PUBLIC_MARKET_CONFIGURATION","kind":"NON_PLAIN","path":"value.subscriptions"}
 * base constructed, opened, and sent
 *      {"action":"subscribe","subscriptions":[{"topic":"crypto_prices_twap_thirty","type":"update","filters":"{\\"symbol\\":\\"btc/usd\\"}"}]}
 * ```
 *
 * An acceptance regression on this package's PUBLIC adapter API: valid,
 * in-type, cast-free input that base serialized and the round refused. The fix
 * is on the PRODUCER side — the encoder's non-plain refusal is kept exactly as
 * it is — and the rule it establishes is the one this file pins across the
 * round's sites:
 *
 *   EVERY CONTAINER AN OUTBOUND FRAME OR BODY CARRIES IS BUILT HERE, ORDINARY,
 *   INDEPENDENT OF THE SPECIES OF WHATEVER THE CALLER PASSED.
 *
 * The first block is the regression pin and carries the reviewer's exact
 * fixture shape; it FAILS at the candidate `1e4f8e8` (the constructor throws)
 * and passes at the tip. The rest are the M2 SWEEP: sites that already satisfy
 * the rule — by an array-literal spread, or by rebuilding through a `Set` —
 * pinned so that swapping any of those spellings for a species-preserving
 * `map`/`slice` is a failing test rather than a silent refusal. Each of those
 * was checked by mutation (see the work-package handoff), not merely asserted.
 *
 * Every expectation is BASE'S BYTES: `JSON.stringify` of the same frame built
 * from an ORDINARY array, computed in this clean process. No inherited `toJSON`
 * is installed anywhere in this file — that is
 * `./inherited-tojson.test.ts`'s subject, and this one is about the container
 * TYPE a caller supplies.
 */

import { describe, expect, it } from "vitest";

import { PublicMarketFeed } from "../../../packages/polymarket-public/src/feed/connection.js";
import { PublicMarketSnapshotInvalidError } from "../../../packages/polymarket-public/src/errors.js";
import { PublicBookSnapshotFetcher } from "../../../packages/polymarket-public/src/snapshot/fetcher.js";
import { RtdsTwapFeed } from "../../../packages/polymarket-public/src/rtds/feed.js";
import type {
  RtdsTwapFeedOptions,
  RtdsTwapWindowSubscription,
} from "../../../packages/polymarket-public/src/rtds/config.js";
import { buildSubscribeFrame } from "../../../packages/polymarket-public/src/rtds/frames.js";
import { globalHttpClient } from "../../../packages/polymarket-public/src/runtime.js";
import {
  fakeWebSocketFactory,
  ManualScheduler,
  sequentialConnectionIds,
  staticMarketDirectory,
  testMarket,
} from "../../../packages/polymarket-public/src/testing/index.js";
import {
  buildMarketSubscribeFrame,
  buildMarketSubscribeUpdateFrame,
  buildMarketUnsubscribeUpdateFrame,
} from "../../../packages/polymarket-public/src/venue/frames.js";

const MARKET = testMarket(1);
const OTHER = testMarket(2);

/** The reviewer's fixture: an ordinary `Array` subclass of valid subscriptions. */
class Subscriptions extends Array<RtdsTwapWindowSubscription> {}

/** The same for token ids, which every market-feed and REST entry point takes. */
class TokenIds extends Array<string> {}

/** A subscription that is a CLASS INSTANCE rather than an object literal. */
class Window30 {
  readonly windowSeconds = 30 as const;
  readonly symbols: readonly string[] = ["btc/usd"];
}

/** A subscription whose prototype is `null`. The cast is `Object.create`'s. */
function nullPrototypeSubscription(): RtdsTwapWindowSubscription {
  const subscription = Object.create(null) as { windowSeconds: 30; symbols: readonly string[] };
  subscription.windowSeconds = 30;
  subscription.symbols = ["btc/usd"];
  return subscription;
}

/** Opens one RTDS feed with `subscriptions` and returns what the socket received. */
function rtdsFramesFor(subscriptions: readonly RtdsTwapWindowSubscription[]): readonly string[] {
  const scheduler = new ManualScheduler();
  const sockets = fakeWebSocketFactory();
  const options: Partial<RtdsTwapFeedOptions> = { subscriptions };
  const feed = new RtdsTwapFeed(
    {
      clock: scheduler.clock,
      timers: scheduler.timers,
      webSocketFactory: sockets.factory,
      connectionId: sequentialConnectionIds(),
    },
    { onEvent: () => undefined, onProblem: () => undefined },
    options,
  );
  feed.start();
  sockets.latest().emitOpen();
  const sent = [...sockets.latest().sent];
  feed.stop();
  return sent;
}

/** Drives a market feed and returns every byte string the socket received. */
function marketFramesFor(
  initial: readonly string[],
  added: readonly string[],
  removed: readonly string[],
): readonly string[] {
  const scheduler = new ManualScheduler();
  const sockets = fakeWebSocketFactory();
  const feed = new PublicMarketFeed(
    {
      clock: scheduler.clock,
      timers: scheduler.timers,
      webSocketFactory: sockets.factory,
      directory: staticMarketDirectory({ known: [MARKET, OTHER] }),
      connectionId: sequentialConnectionIds(),
      randomFraction: () => 1,
    },
    { onEvent: () => undefined, onProblem: () => undefined },
    {},
  );
  feed.subscribe(initial);
  feed.start();
  sockets.latest().emitOpen();
  feed.subscribe(added);
  feed.unsubscribe(removed);
  const sent = [...sockets.latest().sent];
  feed.stop();
  return sent;
}

/** Runs the real batch snapshot read against a captured `fetch`, returning the bodies. */
async function booksBodiesFor(tokenIds: readonly string[]): Promise<readonly string[]> {
  const bodies: string[] = [];
  const previous = globalThis.fetch;
  globalThis.fetch = ((_input: unknown, init?: { readonly body?: unknown }): Promise<unknown> => {
    bodies.push(typeof init?.body === "string" ? init.body : `non-string body: ${typeof init?.body}`);
    // A 200 whose payload is not the documented batch shape: the read fails
    // AFTER the request was built, which is the only part under test here.
    // DELIBERATE, and KEPT at round 2 (N2): this helper's caller passes two
    // token ids under the DEFAULT batch bound, so the fetcher issues exactly
    // ONE request either way, and the refusal is what shows the body was built
    // before the answer could matter. The test that crosses the batch bound
    // must NOT stop after the first chunk, and answers `"[]"` instead — see
    // `booksChunksFor` below.
    return Promise.resolve({ status: 200, text: () => Promise.resolve("{}") });
  }) as unknown as typeof fetch;
  try {
    const fetcher = new PublicBookSnapshotFetcher({
      http: globalHttpClient(),
      directory: staticMarketDirectory({ known: [MARKET, OTHER] }),
      baseUrl: "https://clob.example.invalid",
    });
    await expect(fetcher.fetchSnapshots(tokenIds)).rejects.toBeInstanceOf(
      PublicMarketSnapshotInvalidError,
    );
  } finally {
    globalThis.fetch = previous;
  }
  return bodies;
}

/**
 * Runs the real batch read to COMPLETION across several chunks.
 *
 * Answers every request with the documented EMPTY BATCH (`[]`), which
 * `parseVenueOrderBooks` accepts — so the loop continues to the next chunk
 * instead of throwing after the first. Returns both what LEFT the process (the
 * encoded body strings, captured at the global `fetch`) and what each body was
 * encoded FROM (the `jsonBody` container, captured at the HTTP port, which is
 * where a caller's species would be observable).
 */
async function booksChunksFor(
  tokenIds: readonly string[],
  maximumBooksPerRequest: number,
): Promise<{ readonly bodies: readonly string[]; readonly containers: readonly unknown[] }> {
  const bodies: string[] = [];
  const containers: unknown[] = [];
  const previous = globalThis.fetch;
  globalThis.fetch = ((_input: unknown, init?: { readonly body?: unknown }): Promise<unknown> => {
    bodies.push(typeof init?.body === "string" ? init.body : `non-string body: ${typeof init?.body}`);
    return Promise.resolve({ status: 200, text: () => Promise.resolve("[]") });
  }) as unknown as typeof fetch;
  const transport = globalHttpClient();
  try {
    const fetcher = new PublicBookSnapshotFetcher({
      http: (request) => {
        containers.push(request.jsonBody);
        return transport(request);
      },
      directory: staticMarketDirectory({ known: [MARKET, OTHER] }),
      baseUrl: "https://clob.example.invalid",
      maximumBooksPerRequest,
    });
    // The read SUCCEEDS: an empty batch is a valid answer, so nothing here
    // depends on a refusal and every chunk is issued.
    const normalization = await fetcher.fetchSnapshots(tokenIds);
    expect(normalization.events).toEqual([]);
    expect(normalization.problems).toEqual([]);
  } finally {
    globalThis.fetch = previous;
  }
  return { bodies, containers };
}

describe("RTDS: a subscription collection that is an Array SUBCLASS is accepted (the M2 regression)", () => {
  it("sends base's bytes for the reviewer's exact fixture, and constructing does not throw", () => {
    // Verbatim from the review, with no cast and no invalid value:
    const options: Partial<RtdsTwapFeedOptions> = {
      subscriptions: new Subscriptions({ windowSeconds: 30, symbols: ["btc/usd"] }),
    };
    // Non-vacuity: the fixture really is a foreign container, which the
    // encoder is right to refuse if it ever reaches it.
    expect(Array.isArray(options.subscriptions)).toBe(true);
    expect(Object.getPrototypeOf(options.subscriptions)).not.toBe(Array.prototype);

    const expected = JSON.stringify(buildSubscribeFrame([{ windowSeconds: 30, symbols: ["btc/usd"] }]));
    expect(expected).toBe(
      '{"action":"subscribe","subscriptions":[{"topic":"crypto_prices_twap_thirty","type":"update","filters":"{\\"symbol\\":\\"btc/usd\\"}"}]}',
    );
    expect(rtdsFramesFor(options.subscriptions ?? [])).toEqual([expected]);
  });

  it("the frame BUILDER answers an ordinary array for a subclass, entry for entry", () => {
    const frame = buildSubscribeFrame(
      new Subscriptions({ windowSeconds: 30, symbols: ["btc/usd"] }, { windowSeconds: 60 }),
    );
    const entries = frame["subscriptions"];
    expect(Array.isArray(entries)).toBe(true);
    expect(Object.getPrototypeOf(entries)).toBe(Array.prototype);
    expect(JSON.stringify(frame)).toBe(
      JSON.stringify(buildSubscribeFrame([{ windowSeconds: 30, symbols: ["btc/usd"] }, { windowSeconds: 60 }])),
    );
  });

  it("a subscription that is a class instance or a null-prototype object is accepted too", () => {
    // The ENTRIES are rebuilt as object literals, so a caller's element
    // prototype never reaches the encoder either.
    const expected = JSON.stringify(buildSubscribeFrame([{ windowSeconds: 30, symbols: ["btc/usd"] }]));
    expect(rtdsFramesFor([new Window30()])).toEqual([expected]);
    expect(rtdsFramesFor([nullPrototypeSubscription()])).toEqual([expected]);
    expect(rtdsFramesFor(new Subscriptions(new Window30()))).toEqual([expected]);
  });

  it("a reconnect re-sends the same bytes, since the frame is encoded once at construction", () => {
    const scheduler = new ManualScheduler();
    const sockets = fakeWebSocketFactory();
    const feed = new RtdsTwapFeed(
      {
        clock: scheduler.clock,
        timers: scheduler.timers,
        webSocketFactory: sockets.factory,
        connectionId: sequentialConnectionIds(),
      },
      { onEvent: () => undefined, onProblem: () => undefined },
      { subscriptions: new Subscriptions({ windowSeconds: 60 }) },
    );
    feed.start();
    sockets.latest().emitOpen();
    sockets.latest().emitClose({ code: 1006, reason: "gone" });
    scheduler.advance(60_000);
    sockets.latest().emitOpen();
    const expected = JSON.stringify(buildSubscribeFrame([{ windowSeconds: 60 }]));
    expect(sockets.sockets.flatMap((socket) => socket.sent)).toEqual([expected, expected]);
    feed.stop();
  });
});

describe("the M2 sweep: the market frames and the REST body accept a caller's array subclass", () => {
  it("market feed: the initial subscription, a dynamic subscribe and an unsubscribe are base's bytes", () => {
    // `subscribe`/`unsubscribe` take `readonly string[]`, which the subclass
    // satisfies with no cast. `venue/frames.ts` rebuilds `assets_ids` with an
    // array-literal spread, which is ordinary whatever the species is, and the
    // subscription manager's own `added`/`removed`/`assets` arrays are its own.
    const sent = marketFramesFor(
      new TokenIds(MARKET.yesTokenId),
      new TokenIds(OTHER.yesTokenId, OTHER.noTokenId),
      new TokenIds(MARKET.yesTokenId),
    );
    expect(sent).toEqual([
      JSON.stringify(
        buildMarketSubscribeFrame({
          assetsIds: [MARKET.yesTokenId],
          customFeatureEnabled: false,
          initialDump: true,
        }),
      ),
      JSON.stringify(buildMarketSubscribeUpdateFrame([OTHER.yesTokenId, OTHER.noTokenId], false)),
      JSON.stringify(buildMarketUnsubscribeUpdateFrame([MARKET.yesTokenId])),
    ]);
  });

  it("the market frame BUILDERS answer ordinary containers for a subclass", () => {
    for (const frame of [
      buildMarketSubscribeFrame({
        assetsIds: new TokenIds("a"),
        customFeatureEnabled: false,
        initialDump: true,
      }),
      buildMarketSubscribeUpdateFrame(new TokenIds("a"), false),
      buildMarketUnsubscribeUpdateFrame(new TokenIds("a")),
    ]) {
      expect(Object.getPrototypeOf(frame)).toBe(Object.prototype);
      expect(Object.getPrototypeOf(frame["assets_ids"])).toBe(Array.prototype);
    }
  });

  it("REST: a POST /books body built from a subclass token list is base's body", async () => {
    // `fetchSnapshots` takes `readonly string[]`. `[...new Set(tokenIds)]`
    // severs the species before any `slice`/`map` runs, so the body's ROOT —
    // which is an array — is this package's own.
    const bodies = await booksBodiesFor(new TokenIds(MARKET.yesTokenId, OTHER.noTokenId));
    expect(bodies).toEqual([
      JSON.stringify([{ token_id: MARKET.yesTokenId }, { token_id: OTHER.noTokenId }]),
    ]);
  });

  it("REST: the same holds across the documented batch bound, EVERY chunk", async () => {
    // Round 2 (N2): the first spelling of this test answered `"{}"`, which
    // `parseVenueOrderBooks` refuses — so `fetchSnapshots` threw after the
    // FIRST chunk and the test asserted one body while its name claimed to
    // cross the batch bound. It now answers the documented EMPTY BATCH, the
    // read runs to completion, and every chunk is asserted.
    const tokenIds = new TokenIds(...Array.from({ length: 5 }, (_, index) => `token-${String(index)}`));
    const { bodies, containers } = await booksChunksFor(tokenIds, 2);

    // Base's bytes, chunk for chunk: 5 ids at 2 per request is 2 + 2 + 1.
    expect(bodies).toEqual([
      JSON.stringify([{ token_id: "token-0" }, { token_id: "token-1" }]),
      JSON.stringify([{ token_id: "token-2" }, { token_id: "token-3" }]),
      JSON.stringify([{ token_id: "token-4" }]),
    ]);
    // And the container each body was encoded FROM is this package's own, for
    // EVERY chunk and not merely the first: `[...new Set(tokenIds)]` severs the
    // species once, and `.filter`/`.slice`/`.map` on an ordinary array stay
    // ordinary.
    expect(containers).toHaveLength(3);
    for (const container of containers) {
      expect(Array.isArray(container)).toBe(true);
      expect(Object.getPrototypeOf(container)).toBe(Array.prototype);
    }
  });
});
