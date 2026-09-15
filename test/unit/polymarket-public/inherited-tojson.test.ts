/**
 * THE BYTES `polymarket-public` SENDS DO NOT DEPEND ON AN INHERITED `toJSON` (`SER-3`).
 *
 * MEASURED AT `main` `d6e05bf` (`SER-0`, reproduced independently): the three
 * outbound sites — `rtds/feed.ts`'s subscribe frame, `feed/connection.ts`'s
 * `#sendFrames` (initial subscription, dynamic subscribe, unsubscribe) and
 * `runtime.ts`'s `POST /books` body — were `JSON.stringify` of a container the
 * package itself builds, and `JSON.stringify` resolves `toJSON` through the
 * prototype chain. Under an inherited `Object.prototype.toJSON` every frame
 * and the body left as the bare injected string; under `Array.prototype` the
 * `subscriptions` / `assets_ids` array and the body's root array did. The feed
 * published `FeedConnected` with an advanced generation over a subscription to
 * nothing, on every connect AND reconnect, and nothing refused.
 *
 * Each `it` below runs its scenario clean and then under ALL SIX contexts
 * ({`Object.prototype`, `Array.prototype`, `BigInt.prototype`} × {enumerable
 * assignment, non-enumerable `defineProperty`}) and requires every byte string
 * the fake socket / fake `fetch` captured to be identical to the clean one,
 * the decision (FeedConnected published, the request issued) unchanged, and
 * the injected `toJSON` invoked ZERO times — so it fails at the base commit
 * and passes once the sites encode from own data (`src/outbound-json.ts` over
 * `@polymarket-bot/risk/plain-json`). The harness and its protocol (install,
 * call, capture a string, restore in a `finally`, assert afterwards; never
 * `JSON.stringify` inside the window) are `test/unit/ledger/inherited-tojson.ts`'s.
 *
 * ONE KNOWN, UNRELATED, PRE-EXISTING REFUSAL. Under the ENUMERABLE
 * `Object.prototype` context the frozen domain contract refuses every Feed*
 * PAYLOAD the feeds publish (`FeedConnected`, `FeedGapDetected`,
 * `FeedDisconnected`): its strict schema sees the inherited enumerable key.
 * `SER-0` recorded it ("only the enumerable-Object context is refused, AFTER
 * the bytes left, for an unrelated reason"); it is the domain's, at base and
 * at tip alike, and not this round's. The frames are written BEFORE each
 * publish, so the BYTES are demanded in that context too; the decision is
 * demanded unchanged in the other five, and pinned AS the domain refusal in
 * that one so a future change there is visible.
 *
 * NON-VACUITY: the clean bytes are also compared with `JSON.stringify` of the
 * same frame computed OUTSIDE any window, so the pin says "the bytes sent are
 * the clean-process bytes", not merely "the bytes did not move".
 */

import { describe, expect, it } from "vitest";

import { PublicMarketFeed } from "../../../packages/polymarket-public/src/feed/connection.js";
import { PolymarketPublicError, PublicMarketConfigurationError } from "../../../packages/polymarket-public/src/errors.js";
import { encodeOutboundJson } from "../../../packages/polymarket-public/src/outbound-json.js";
import type { PublicHttpClient } from "../../../packages/polymarket-public/src/ports.js";
import { RtdsTwapFeed } from "../../../packages/polymarket-public/src/rtds/feed.js";
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
import { renderDivergences, sweepInheritedToJson, TOJSON_CONTEXTS, withInheritedToJson } from "../ledger/inherited-tojson.js";

const MARKET = testMarket(1);
const OTHER = testMarket(2);

/** The context in which the domain contract independently refuses the Feed* payloads. */
const DOMAIN_REFUSES_INHERITED_ENUMERABLE_KEY = "Object.prototype/enumerable";

// ---------------------------------------------------------------------------
// Renderers (no JSON.stringify anywhere below this line until the clean-process
// comparisons, which run OUTSIDE every window)
// ---------------------------------------------------------------------------

/** Joins captured byte strings with a separator no JSON text contains unescaped. */
function joinBytes(sent: readonly string[]): string {
  return sent.join("");
}

/** One driven scenario: the bytes every socket received, and the decisions as a string. */
interface FeedRun {
  readonly sent: string;
  readonly decisions: string;
}

/** Runs one driving step, recording a throw as a decision rather than aborting the scenario. */
function step(decisions: string[], run: () => void): void {
  try {
    run();
  } catch (error) {
    decisions.push(`threw:${error instanceof Error ? error.message : "non-error"}`);
  }
}

/** Opens an RTDS feed, lets the socket open, then reconnects once. */
function rtdsRun(): FeedRun {
  const scheduler = new ManualScheduler();
  const sockets = fakeWebSocketFactory();
  const decisions: string[] = [];
  const feed = new RtdsTwapFeed(
    {
      clock: scheduler.clock,
      timers: scheduler.timers,
      webSocketFactory: sockets.factory,
      connectionId: sequentialConnectionIds(),
    },
    { onEvent: (event) => decisions.push(event.eventType), onProblem: () => undefined },
    { subscriptions: [{ windowSeconds: 30, symbols: ["btc/usd"] }, { windowSeconds: 60 }] },
  );
  feed.start();
  step(decisions, () => sockets.latest().emitOpen());
  // A reconnect re-sends the frame: the server drops the socket, the backoff fires.
  step(decisions, () => sockets.latest().emitClose({ code: 1006, reason: "gone" }));
  step(decisions, () => scheduler.advance(60_000));
  step(decisions, () => sockets.latest().emitOpen());
  const sent = joinBytes(sockets.sockets.flatMap((socket) => socket.sent));
  step(decisions, () => feed.stop());
  return { sent, decisions: decisions.join(",") };
}

/** Drives a market feed through the initial frame, a dynamic subscribe and an unsubscribe. */
function marketRun(): FeedRun {
  const scheduler = new ManualScheduler();
  const sockets = fakeWebSocketFactory();
  const decisions: string[] = [];
  const feed = new PublicMarketFeed(
    {
      clock: scheduler.clock,
      timers: scheduler.timers,
      webSocketFactory: sockets.factory,
      directory: staticMarketDirectory({ known: [MARKET, OTHER] }),
      connectionId: sequentialConnectionIds(),
      randomFraction: () => 1,
    },
    { onEvent: (event) => decisions.push(event.eventType), onProblem: () => undefined },
    {},
  );
  feed.subscribe([MARKET.yesTokenId]);
  feed.start();
  step(decisions, () => sockets.latest().emitOpen());
  step(decisions, () => feed.subscribe([OTHER.yesTokenId, OTHER.noTokenId]));
  step(decisions, () => feed.unsubscribe([MARKET.yesTokenId]));
  const sent = joinBytes(sockets.latest().sent);
  step(decisions, () => feed.stop());
  return { sent, decisions: decisions.join(",") };
}

/** A `fetch` double that captures the request body and answers 200 `{}`. */
function captureFetch(): { readonly bodies: string[]; readonly calls: number[]; install(): () => void } {
  const bodies: string[] = [];
  const calls: number[] = [];
  const fake = (_input: unknown, init?: { readonly body?: unknown }): Promise<unknown> => {
    calls.push(1);
    bodies.push(typeof init?.body === "string" ? init.body : `non-string body: ${typeof init?.body}`);
    return Promise.resolve({ status: 200, text: () => Promise.resolve("{}") });
  };
  return {
    bodies,
    calls,
    install: () => {
      const previous = globalThis.fetch;
      globalThis.fetch = fake as unknown as typeof fetch;
      return () => {
        globalThis.fetch = previous;
      };
    },
  };
}

const BOOKS_BODY = [{ token_id: MARKET.yesTokenId }, { token_id: OTHER.noTokenId }];

/** Issues the fetcher's POST through the real global client against the fake `fetch`. */
function booksRequestBody(): string {
  const capture = captureFetch();
  const restore = capture.install();
  let pending: Promise<unknown>;
  try {
    const client: PublicHttpClient = globalHttpClient();
    // The body is encoded before the first `await`, so it is captured synchronously.
    pending = client({ url: "https://clob.example.invalid/books", method: "POST", jsonBody: BOOKS_BODY });
  } finally {
    restore();
  }
  void pending.catch(() => undefined);
  return `${String(capture.calls.length)}|${joinBytes(capture.bodies)}`;
}

/**
 * Runs a feed scenario clean and under each context: the BYTES must be the
 * clean bytes everywhere; the decisions must be the clean decisions with the
 * injected `toJSON` never run, except in the one context where the domain
 * contract refuses the payloads (its error-path formatting runs
 * `JSON.stringify`, so a whole-window zero count cannot be demanded there),
 * where the decisions are pinned as that refusal.
 */
function pinFeedRun(run: () => FeedRun, refused: FeedRun): FeedRun {
  const clean = run();
  for (const context of TOJSON_CONTEXTS) {
    const polluted = withInheritedToJson(context, run);
    if (context.name === DOMAIN_REFUSES_INHERITED_ENUMERABLE_KEY) {
      // The refusal cascade can cut the scenario short (an RTDS reconnect is
      // never armed once the disconnect publish threw), so the bytes pinned
      // here are the frames the scenario still reached — every one of them
      // the clean-process frame.
      expect(polluted.result.sent, `${context.name}: bytes`).toBe(refused.sent);
      expect(polluted.result.decisions, context.name).toBe(refused.decisions);
    } else {
      expect(polluted.result.sent, `${context.name}: bytes`).toBe(clean.sent);
      expect(polluted.result.decisions, context.name).toBe(clean.decisions);
      expect(polluted.calls, context.name).toBe(0);
    }
  }
  return clean;
}

const REFUSED = (eventType: string): string => `threw:${eventType} payload was rejected by its own domain contract`;

// ---------------------------------------------------------------------------
// The pins
// ---------------------------------------------------------------------------

describe("polymarket-public outbound bytes under an inherited toJSON (SER-3)", () => {
  it("RTDS: the subscribe frame sent on open and on reconnect is the clean-process frame, and FeedConnected still publishes", () => {
    // Outside every window: the clean bytes ARE JSON.stringify's, twice (open, reconnect).
    const expected = JSON.stringify(
      buildSubscribeFrame([{ windowSeconds: 30, symbols: ["btc/usd"] }, { windowSeconds: 60 }]),
    );
    expect(expected).toContain('"filters":"{\\"symbol\\":\\"btc/usd\\"}"');
    const clean = pinFeedRun(rtdsRun, {
      // The domain refuses FeedConnected, then FeedDisconnected on the drop; no
      // reconnect is armed after that, so one frame — the clean one — was sent.
      sent: expected,
      decisions: [REFUSED("FeedConnected"), REFUSED("FeedDisconnected")].join(","),
    });
    expect(clean.sent).toBe(joinBytes([expected, expected]));
    expect(clean.decisions).toBe("FeedConnected,FeedDisconnected,FeedConnected,FeedGapDetected,FeedDisconnected");
  });

  it("market feed: the initial subscription, the dynamic subscribe and the unsubscribe are the clean-process frames", () => {
    const expected = [
      JSON.stringify(
        buildMarketSubscribeFrame({ assetsIds: [MARKET.yesTokenId], customFeatureEnabled: false, initialDump: true }),
      ),
      JSON.stringify(buildMarketSubscribeUpdateFrame([OTHER.yesTokenId, OTHER.noTokenId], false)),
      JSON.stringify(buildMarketUnsubscribeUpdateFrame([MARKET.yesTokenId])),
    ];
    expect(expected[0]).toContain(`"assets_ids":["${MARKET.yesTokenId}"]`);
    const clean = pinFeedRun(marketRun, {
      // Every frame is written before the publish the domain refuses, so all
      // three — the clean ones — were sent.
      sent: joinBytes(expected),
      decisions: [REFUSED("FeedConnected"), REFUSED("FeedGapDetected"), REFUSED("FeedDisconnected")].join(","),
    });
    expect(clean.sent).toBe(joinBytes(expected));
    expect(clean.decisions).toBe("FeedConnected,FeedGapDetected,FeedDisconnected");
  });

  it("REST: the POST /books body handed to fetch is the clean-process body, and the request is still issued", () => {
    const sweep = sweepInheritedToJson([{ name: "books-body", render: booksRequestBody }]);
    expect(renderDivergences(sweep.divergences)).toEqual([]);
    expect(sweep.clean.get("books-body")).toBe(`ok:1|${JSON.stringify(BOOKS_BODY)}`);
  });

  it("the injected toJSON never ran on any path, in any context (a control that the windows were live)", () => {
    // The `calls` accounting the pins above rely on: the same windows DO see a
    // `JSON.stringify` of an object, so a zero count is evidence rather than
    // an idle counter.
    for (const context of TOJSON_CONTEXTS) {
      const probe = withInheritedToJson(context, () => JSON.stringify({ a: [true] }));
      const hijacked = context.target === BigInt.prototype ? 0 : 1;
      expect(probe.calls, context.name).toBe(hijacked);
    }
  });
});

/**
 * THE ENCODER MAY NOT REFUSE WHERE BASE ENCODED — the `SER-2` review's HIGH,
 * audited for this package's three outbound sites.
 *
 * The rule: no input a real producer can supply may make a production encoder
 * refuse where base `JSON.stringify` succeeded. Every container encoded here is
 * built BY THE SITE — but "built from primitives" is exactly the claim that
 * failed in `SER-2`, so the producers are traced rather than asserted:
 *
 * - the RTDS frame's contents are `resolveRtdsTwapFeedOptions`' output, which
 *   refuses a `windowSeconds` that is not 30 or 60 and a symbol that does not
 *   match `OUTBOUND_SYMBOL_PATTERN` (`src/rtds/config.ts`, `validateSubscriptions`)
 *   BEFORE the constructor encodes — so the frame is three levels deep with
 *   string leaves, always;
 * - the market frames' `assets_ids` are the token ids
 *   `MarketSubscriptionManager` holds, typed `readonly string[]`, supplied in
 *   the gateway from the config door's `markets[].{yes,no}TokenId`
 *   (`apps/data-gateway/src/config.ts:98`, `z.string().min(1).max(200)` over a
 *   materialized tree) — two levels, string leaves;
 * - the REST body is `chunk.map((tokenId) => ({ token_id: tokenId }))` over the
 *   same ids — three levels, string leaves.
 *
 * Depth is therefore CONSTANT in the input, and SIZE is not a refusal cause
 * anywhere: `encodePlainJson` has no length bound, exactly as `JSON.stringify`
 * has none. The tests below make that executable at a scale no venue
 * subscription reaches.
 */
describe("the outbound encoders may not refuse where base encoded (SER-2 cross-round rule)", () => {
  it("a 5,000-token subscription encodes, chunked, byte-identically to the clean process", () => {
    const scheduler = new ManualScheduler();
    const sockets = fakeWebSocketFactory();
    const tokenIds = Array.from({ length: 5_000 }, (_, index) => `${String(index)}${"0".repeat(40)}`);
    const feed = new PublicMarketFeed(
      {
        clock: scheduler.clock,
        timers: scheduler.timers,
        webSocketFactory: sockets.factory,
        directory: staticMarketDirectory({ known: [MARKET] }),
        connectionId: sequentialConnectionIds(),
        randomFraction: () => 1,
      },
      { onEvent: () => undefined, onProblem: () => undefined },
      { maximumAssetsPerSubscriptionFrame: 500 },
    );
    feed.subscribe(tokenIds);
    feed.start();
    sockets.latest().emitOpen();
    const sent = sockets.latest().sent;
    expect(sent).toHaveLength(10);
    expect(joinBytes(sent)).toBe(
      joinBytes([
        JSON.stringify(
          buildMarketSubscribeFrame({
            assetsIds: tokenIds.slice(0, 500),
            customFeatureEnabled: false,
            initialDump: true,
          }),
        ),
        ...Array.from({ length: 9 }, (_, index) =>
          JSON.stringify(
            buildMarketSubscribeUpdateFrame(tokenIds.slice((index + 1) * 500, (index + 2) * 500), false),
          ),
        ),
      ]),
    );
    // Non-vacuity: this is a quarter of a megabyte of frames, and none of it
    // made the encoder refuse.
    expect(sent.join("").length).toBeGreaterThan(200_000);
    feed.stop();
  });

  it("a 2,000-token snapshot body encodes at constant depth", () => {
    const tokenIds = Array.from({ length: 2_000 }, (_, index) => `${String(index)}${"0".repeat(40)}`);
    const body = tokenIds.map((tokenId) => ({ token_id: tokenId }));
    expect(encodeOutboundJson(body, "REST request body")).toBe(JSON.stringify(body));
  });
});

describe("a frame or body that is not plain JSON data is refused in this package's vocabulary, never sent", () => {
  it("encodeOutboundJson maps every refusal kind to PUBLIC_MARKET_CONFIGURATION with the path", () => {
    const cases: readonly { readonly value: unknown; readonly kind: string; readonly path: string }[] = [
      { value: { assets_ids: [1n] }, kind: "BIGINT", path: "value.assets_ids[0]" },
      { value: { f: () => undefined }, kind: "EXECUTABLE", path: "value.f" },
      { value: { when: new Date(0) }, kind: "NON_PLAIN", path: "value.when" },
      { value: Object.defineProperty({}, "g", { get: () => 1, enumerable: true }), kind: "ACCESSOR", path: "value.g" },
      { value: undefined, kind: "UNDEFINED_ROOT", path: "value" },
    ];
    for (const item of cases) {
      let caught: unknown;
      try {
        encodeOutboundJson(item.value, "market subscription frame");
      } catch (error) {
        caught = error;
      }
      expect(caught, item.kind).toBeInstanceOf(PublicMarketConfigurationError);
      const error = caught as PublicMarketConfigurationError;
      expect(error.code).toBe("PUBLIC_MARKET_CONFIGURATION");
      expect(error.message).toBe("the market subscription frame is not plain JSON data and was not sent");
      expect(error.details["kind"]).toBe(item.kind);
      expect(error.details["path"]).toBe(item.path);
      expect(typeof error.details["problem"]).toBe("string");
    }
  });

  it("a thrown value that is not the encoder's refusal is re-thrown as itself", () => {
    // A Proxy whose traps throw is the only way to make the encoder throw
    // something that is not its own refusal; the classification must not
    // swallow it.
    const hostile = new Proxy({}, { getPrototypeOf: () => { throw new RangeError("trap"); } });
    expect(() => encodeOutboundJson(hostile, "x")).toThrow(RangeError);
  });

  it("market feed: subscribe() with a token that is not plain data throws, and NOTHING is written to the socket", () => {
    const scheduler = new ManualScheduler();
    const sockets = fakeWebSocketFactory();
    const feed = new PublicMarketFeed(
      {
        clock: scheduler.clock,
        timers: scheduler.timers,
        webSocketFactory: sockets.factory,
        directory: staticMarketDirectory({ known: [MARKET] }),
        connectionId: sequentialConnectionIds(),
        randomFraction: () => 1,
      },
      { onEvent: () => undefined, onProblem: () => undefined },
      {},
    );
    feed.start();
    sockets.latest().emitOpen();
    const before = sockets.latest().sent.length;
    expect(() => feed.subscribe([MARKET.yesTokenId, 7n as unknown as string])).toThrow(
      PublicMarketConfigurationError,
    );
    expect(sockets.latest().sent.length).toBe(before);
    feed.stop();
  });

  it("REST: a body that is not plain data rejects with the typed error BEFORE fetch runs", async () => {
    const capture = captureFetch();
    const restore = capture.install();
    let outcome: unknown;
    try {
      await globalHttpClient()({ url: "https://clob.example.invalid/books", method: "POST", jsonBody: [{ token_id: 1n }] });
    } catch (error) {
      outcome = error;
    } finally {
      restore();
    }
    expect(outcome).toBeInstanceOf(PolymarketPublicError);
    expect((outcome as PolymarketPublicError).code).toBe("PUBLIC_MARKET_CONFIGURATION");
    expect((outcome as PolymarketPublicError).details["what"]).toBe("REST request body");
    expect(capture.calls).toEqual([]);
  });
});
