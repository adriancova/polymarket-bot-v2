/**
 * Acceptance criterion 1: **all sanitized official fixtures parse.**
 *
 * Every example in every `test/fixtures/venue/market-ws/*.json` file is driven
 * through the real entry points — the wire parser and then the normalizer —
 * and must produce a domain event, not a problem. The suite additionally
 * asserts that the fixture catalogue still covers all seven modelled event
 * types, so "all fixtures parse" cannot become true by the fixtures shrinking.
 *
 * The last section (`V2-2`) drives `VENUE-4`'s Polymarket Protocol V2
 * captures under `test/fixtures/venue/protocol-v2/` through the same entry
 * points: the V2 REST book, the V2 `book` frame with its undocumented
 * `"version":"v2"`, and the whole 60 s market-channel session on a V2
 * position id, through the feed and its raw-frame hand-off.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  decodeInboundFrame,
  normalizeMarketEvents,
  normalizeOrderBooks,
  parseMarketEvent,
  parseVenueOrderBook,
  PublicMarketFeed,
  type NormalizedPublicEventAny,
  type PublicMarketProblem,
  type RawMarketFrame,
} from "@polymarket-bot/polymarket-public";
import {
  fakeWebSocketFactory,
  ManualScheduler,
  sequentialConnectionIds,
  staticMarketDirectory,
  type StaticMarketDirectory,
  type TestMarketDefinition,
} from "@polymarket-bot/polymarket-public/testing";
import { describe, expect, it } from "vitest";

import {
  loadAllMarketWsExamples,
  loadMarketWsFixture,
  MARKET_WS_FIXTURE_FILES,
} from "./fixtures.js";

/** The identifiers the frozen fixtures actually use. */
const FIXTURE_MARKET: TestMarketDefinition = {
  internalMarketId: "0199f0a0-0000-7000-8000-000000000001",
  conditionId: "0x747dc809fb79e1b05be09c42d6179459a58de2ef3e40f02484a4e1260f741f75",
  yesTokenId:
    "107505882767731489358349912513945399560393482969656700824895970500493757150417",
  noTokenId:
    "7305630249804085635496399869905769372294302716159034447326228509068694952392",
};

function directory(options: { readonly registrable?: boolean } = {}): StaticMarketDirectory {
  return staticMarketDirectory({
    known: [FIXTURE_MARKET],
    ...(options.registrable === false ? {} : { registrable: [FIXTURE_MARKET] }),
  });
}

const examples = loadAllMarketWsExamples();

describe("every sanitized official market-WebSocket fixture", () => {
  it("is loaded, and there is something to check", () => {
    expect(examples.length).toBeGreaterThanOrEqual(8);
  });

  it.each(examples.map((example) => [`${example.file}/${example.name}`, example] as const))(
    "%s parses at the wire layer",
    (_name, example) => {
      const parsed = parseMarketEvent(example.payload);
      expect(parsed.status, JSON.stringify(parsed)).toBe("parsed");
    },
  );

  it.each(examples.map((example) => [`${example.file}/${example.name}`, example] as const))(
    "%s normalizes into a domain event with no problem",
    (_name, example) => {
      const { events, problems } = normalizeMarketEvents([example.payload], {
        directory: directory(),
      });
      expect(problems, JSON.stringify(problems)).toEqual([]);
      expect(events).toHaveLength(1);
    },
  );

  it("covers all seven modelled event types, so the criterion cannot go vacuous", () => {
    const covered = new Set(
      examples.map((example) => (example.payload as { event_type: string }).event_type),
    );
    expect([...covered].sort()).toEqual([
      "best_bid_ask",
      "book",
      "last_trade_price",
      "market_resolved",
      "new_market",
      "price_change",
      "tick_size_change",
    ]);
  });

  it("still has every fixture file WP-000 froze", () => {
    for (const file of MARKET_WS_FIXTURE_FILES) {
      const fixture = loadMarketWsFixture(file);
      expect(fixture.sanitized).toBe(true);
      expect(fixture.source).toContain("polymarket.com");
      expect(fixture.examples.length).toBeGreaterThan(0);
    }
  });
});

describe("the fixtures normalize into the expected domain events", () => {
  function normalizeExample(file: (typeof MARKET_WS_FIXTURE_FILES)[number], name: string) {
    const example = loadMarketWsFixture(file).examples.find((entry) => entry.name === name);
    expect(example, `fixture ${file}/${name} is missing`).toBeDefined();
    return normalizeMarketEvents([example?.payload], { directory: directory() });
  }

  it("book-snapshot → BookSnapshot, reordered for the domain contract", () => {
    const { events } = normalizeExample("book-snapshot", "book-snapshot");
    expect(events[0]?.eventType).toBe("BookSnapshot");
    expect(events[0]?.payload).toEqual({
      internalMarketId: FIXTURE_MARKET.internalMarketId,
      tokenId: FIXTURE_MARKET.yesTokenId,
      bids: [
        { price: "0.08", size: "33343.4" },
        { price: "0.07", size: "5000" },
      ],
      asks: [
        { price: "0.09", size: "163939.58" },
        { price: "0.1", size: "7500.25" },
      ],
      venueBookHash:
        "0x0000000000000000000000000000000000000000000000000000000000abc123",
    });
    expect(events[0]?.provenance.venueTimestamp).toBe("2026-06-29T17:15:57.257Z");
  });

  it("price-change/level-updated → BookLevelChanged with the absolute level size", () => {
    const { events } = normalizeExample("price-change", "level-updated");
    expect(events[0]?.eventType).toBe("BookLevelChanged");
    expect(events[0]?.payload).toEqual({
      internalMarketId: FIXTURE_MARKET.internalMarketId,
      tokenId: FIXTURE_MARKET.yesTokenId,
      side: "BID",
      price: "0.08",
      size: "33343.4",
    });
  });

  it("price-change/level-removed → size '0', carried through unchanged", () => {
    // The fixture's own name still carries the `UNVERIFIED` marker WP-000 gave
    // it. The semantics were confirmed against the current official reference
    // on 2026-08-27 — `size` is the "New aggregate size (0 means level
    // removed)" — and this adapter carries the value through with no delta
    // arithmetic either way. Renaming the frozen fixture is not this package's
    // to do; see `docs/handoffs/WP-070.md`.
    const { events, problems } = normalizeExample(
      "price-change",
      "level-removed-absolute-zero-UNVERIFIED",
    );
    expect(problems).toEqual([]);
    expect(events[0]?.payload).toMatchObject({ price: "0.08", size: "0", side: "BID" });
  });

  it("tick-size-change → exactly one TradingParametersChanged naming only tick_size", () => {
    const { events } = normalizeExample("tick-size-change", "tick-size-change");
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("TradingParametersChanged");
    expect(events[0]?.payload).toMatchObject({
      changedParameters: ["tick_size"],
      tickSize: "0.001",
    });
  });

  it("last-trade-price → PublicTradeObserved with the taker side", () => {
    const { events } = normalizeExample("last-trade-price", "last-trade-price");
    expect(events[0]?.eventType).toBe("PublicTradeObserved");
    expect(events[0]?.payload).toEqual({
      internalMarketId: FIXTURE_MARKET.internalMarketId,
      tokenId: FIXTURE_MARKET.yesTokenId,
      price: "0.08",
      size: "219.217767",
      takerSide: "ASK",
    });
  });

  it("best-bid-ask → BestBidAskChanged with prices and no invented sizes", () => {
    const { events } = normalizeExample("best-bid-ask", "best-bid-ask");
    expect(events[0]?.eventType).toBe("BestBidAskChanged");
    expect(events[0]?.payload).toEqual({
      internalMarketId: FIXTURE_MARKET.internalMarketId,
      tokenId: FIXTURE_MARKET.yesTokenId,
      bestBidPrice: "0.08",
      bestAskPrice: "0.09",
    });
  });

  it("lifecycle/new-market → MarketDiscovered from the catalogue's registration", () => {
    const { events } = normalizeExample("lifecycle", "new-market");
    expect(events[0]?.eventType).toBe("MarketDiscovered");
    expect(events[0]?.payload).toMatchObject({
      internalMarketId: FIXTURE_MARKET.internalMarketId,
      conditionId: FIXTURE_MARKET.conditionId,
      yesTokenId: FIXTURE_MARKET.yesTokenId,
      noTokenId: FIXTURE_MARKET.noTokenId,
    });
  });

  it("lifecycle/market-resolved → MarketResolved decided by the winning token", () => {
    const { events } = normalizeExample("lifecycle", "market-resolved");
    expect(events[0]?.eventType).toBe("MarketResolved");
    expect(events[0]?.payload).toEqual({
      internalMarketId: FIXTURE_MARKET.internalMarketId,
      conditionId: FIXTURE_MARKET.conditionId,
      outcome: "YES_WIN",
      resolvedAt: "2026-06-29T17:15:57.257Z",
    });
  });
});

describe("the whole fixture catalogue as one batched frame", () => {
  it("accounts for every event, in order, with nothing dropped", () => {
    // The venue may batch several events into one text frame; the SDK's own
    // market socket branches on `Array.isArray(message)`.
    const payloads = examples.map((example) => example.payload);
    const { events, problems } = normalizeMarketEvents(payloads, { directory: directory() });
    expect(problems).toEqual([]);
    expect(events).toHaveLength(payloads.length);
    expect(events.map((event) => event.provenance.observedIndex)).toEqual(
      payloads.map((_payload, index) => index),
    );
    // Only the batching element type carries an entry index — a `price_change`
    // is a batch even when it batches one entry — and every other element
    // carries none. The batching case is the next describe block.
    for (const [index, event] of events.entries()) {
      const isBatched =
        (examples[index]?.payload as { event_type?: string } | undefined)?.event_type ===
        "price_change";
      expect(event.provenance.entryIndex, `${String(index)}`).toBe(isBatched ? 0 : undefined);
    }
  });
});

describe("the accounting unit is the venue's, not the frame element (L1)", () => {
  const BATCHED_PRICE_CHANGE = {
    event_type: "price_change",
    market: FIXTURE_MARKET.conditionId,
    timestamp: "1782753357257",
    price_changes: [
      { asset_id: FIXTURE_MARKET.yesTokenId, price: "0.08", size: "1", side: "BUY" },
      { asset_id: FIXTURE_MARKET.yesTokenId, price: "0.09", size: "0", side: "SELL" },
      // A side the venue does not document: one problem, not a lost element.
      { asset_id: FIXTURE_MARKET.yesTokenId, price: "0.1", size: "2", side: "MIDDLE" },
    ],
  };

  it("one element carrying N entries produces exactly N outcomes", () => {
    // Round-1 finding L1: the claim used to be "exactly one outcome per frame
    // element", which this case never satisfied — three outcomes came out of
    // one element and nothing said so.
    const { events, problems } = normalizeMarketEvents([BATCHED_PRICE_CHANGE], {
      directory: directory(),
    });
    expect(events).toHaveLength(2);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.code).toBe("UNKNOWN_SIDE");
  });

  it("(observedIndex, entryIndex) totally orders the outcomes of one frame", () => {
    const { events, problems } = normalizeMarketEvents(
      [loadMarketWsFixture("book-snapshot").examples[0]?.payload, BATCHED_PRICE_CHANGE],
      { directory: directory() },
    );
    const ordered = [
      ...events.map((event) => ({
        observedIndex: event.provenance.observedIndex,
        entryIndex: event.provenance.entryIndex,
      })),
      ...problems.map((problem) => ({
        observedIndex: problem.observedIndex,
        entryIndex: problem.entryIndex,
      })),
    ].sort(
      (left, right) =>
        left.observedIndex - right.observedIndex ||
        (left.entryIndex ?? 0) - (right.entryIndex ?? 0),
    );

    expect(ordered).toEqual([
      // The single-fact element: no entry index.
      { observedIndex: 0, entryIndex: undefined },
      { observedIndex: 1, entryIndex: 0 },
      { observedIndex: 1, entryIndex: 1 },
      { observedIndex: 1, entryIndex: 2 },
    ]);
    // No two outcomes of the frame share a position.
    const positions = ordered.map(
      (entry) => `${String(entry.observedIndex)}:${String(entry.entryIndex ?? 0)}`,
    );
    expect(new Set(positions).size).toBe(positions.length);
  });

  it("an element that asserts nothing is still reported exactly once", () => {
    const { events, problems } = normalizeMarketEvents(
      [
        {
          event_type: "price_change",
          market: FIXTURE_MARKET.conditionId,
          timestamp: "1782753357257",
          price_changes: [],
        },
      ],
      { directory: directory() },
    );
    expect(events).toEqual([]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ code: "INVALID_EVENT_PAYLOAD", observedIndex: 0 });
    expect(problems[0]).not.toHaveProperty("entryIndex");
  });
});

// ---------------------------------------------------------------------------
// Polymarket Protocol V2 (`V2-2`: plan rows A9-A12; acceptance 1 and 2)
// ---------------------------------------------------------------------------
//
// The captures are `VENUE-4`'s (`test/fixtures/venue/protocol-v2/README.md`;
// facts in `docs/venue/verified-2026-10-05.md`):
//
// - `book-v2.jsonc`: `GET /book` for a V2 position id (S-L03, O.2);
// - `ws-market-v2-session.jsonl`: 60 s on the public market channel,
//   subscribed to that id (S-W01, F-62). Its `data` is each frame's text
//   exactly as received, so the first inbound frame keeps its trailing
//   newline;
// - `clob-markets-v2.jsonc`: the CLOB record of the same market (S-L01), which
//   gives the outcome pair: `t[0]` "Up" and `t[1]` "Down"; index 0 is YES
//   (F-40).
//
// Both book shapes carry an undocumented `"version":"v2"` (C-21). It is never
// an authority: the decoders project their declared fields only (D3), so it
// is stripped, and every V2 event below must equal the event of the same
// input without it, which is the V1 shape (a V1 book has no such key: O.2,
// F-62, and the frozen `market-ws/book-snapshot.json`).

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const PROTOCOL_V2 = resolve(repoRoot, "test/fixtures/venue/protocol-v2");

function protocolV2Json(name: string): unknown {
  // The README: "`.jsonc` files are strict JSON (RFC 8259) ... Read them with `JSON.parse`."
  return JSON.parse(readFileSync(resolve(PROTOCOL_V2, name), "utf8")) as unknown;
}

interface SessionRecord {
  readonly t: string;
  readonly dir: string;
  readonly data: unknown;
}

const V2_SESSION: readonly SessionRecord[] = readFileSync(
  resolve(PROTOCOL_V2, "ws-market-v2-session.jsonl"),
  "utf8",
)
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line) as SessionRecord);

/** Every inbound frame of the session, as the text the socket delivered. */
const V2_INBOUND: readonly string[] = V2_SESSION.filter((record) => record.dir === "recv").map(
  (record) => record.data as string,
);

const V2_CANARY = protocolV2Json("clob-markets-v2.jsonc") as {
  readonly c: string;
  readonly t: readonly { readonly t: string; readonly o: string }[];
};

/**
 * The V2 market as the catalogue would hold it once admission selects
 * `positionIds` (A1; `V2-1`). Its condition id is Gamma's documented 31-byte
 * form (F-40, F-43) while every frame and book below names the 32-byte form,
 * so these tests also pin that identity is resolved by `asset_id` alone
 * (A12): the wire's `market` width never decides which market a book is.
 */
const V2_MARKET: TestMarketDefinition = {
  internalMarketId: "0199f0a0-0000-7000-8000-000000000002",
  conditionId: V2_CANARY.c.slice(0, -2),
  yesTokenId: V2_CANARY.t[0]?.t ?? "",
  noTokenId: V2_CANARY.t[1]?.t ?? "",
};

function v2Directory(): StaticMarketDirectory {
  return staticMarketDirectory({ known: [V2_MARKET] });
}

/** The `BookSnapshot` payload both V2 book shapes must produce. */
const V2_BOOK_PAYLOAD = {
  internalMarketId: V2_MARKET.internalMarketId,
  tokenId: V2_MARKET.yesTokenId,
  bids: [],
  asks: [],
  venueBookHash: "fc3846cab0c35a0977b6e5f605a4e5ff0d0b2277",
};

function withoutVersion(value: unknown): Record<string, unknown> {
  const copy = { ...(value as Record<string, unknown>) };
  delete copy["version"];
  return copy;
}

function v2BookFrameValue(): Record<string, unknown> {
  const decoded = decodeInboundFrame(V2_INBOUND[0] ?? "");
  if (decoded.kind !== "values" || decoded.values.length !== 1) {
    throw new Error("the session's first inbound frame is not the one-element book array VENUE-4 recorded");
  }
  return decoded.values[0] as Record<string, unknown>;
}

describe("Protocol V2: the captures are the ones the facts describe (non-vacuity)", () => {
  it("the market's position ids are the 75-digit decimal strings F-44 reports, YES at index 0", () => {
    expect(V2_CANARY.t.map((entry) => entry.o)).toEqual(["Up", "Down"]);
    expect(V2_MARKET.yesTokenId).toMatch(/^[1-9][0-9]{74}$/u);
    expect(V2_MARKET.noTokenId).toMatch(/^[1-9][0-9]{74}$/u);
    expect(V2_MARKET.conditionId).toMatch(/^0x[0-9a-f]{62}$/u);
  });

  it("the session holds one book frame for the V2 id with version v2, five PONGs and one unrelated new_market", () => {
    expect(V2_INBOUND).toHaveLength(7);
    expect(V2_INBOUND[0]?.endsWith("]\n")).toBe(true);
    expect(V2_INBOUND.filter((text) => text === "PONG")).toHaveLength(5);
    const book = v2BookFrameValue();
    expect(book).toMatchObject({ event_type: "book", asset_id: V2_MARKET.yesTokenId, version: "v2" });
    expect(book["market"]).toBe(V2_CANARY.c);
    const restBook = protocolV2Json("book-v2.jsonc") as Record<string, unknown>;
    expect(restBook).toMatchObject({ asset_id: V2_MARKET.yesTokenId, market: V2_CANARY.c, version: "v2" });
  });

  it("a V1 book carries no version key, REST or WebSocket (O.2, F-62)", () => {
    expect(Object.hasOwn(protocolV2Json("book-v1.jsonc") as object, "version")).toBe(false);
    expect(Object.hasOwn(loadMarketWsFixture("book-snapshot").examples[0]?.payload as object, "version")).toBe(false);
  });
});

describe("Protocol V2: both book shapes normalize to the V1 shape's events (acceptance 1; A10, A11, A12)", () => {
  const expectedWsEvent = {
    eventType: "BookSnapshot",
    schemaVersion: 1,
    payload: V2_BOOK_PAYLOAD,
    provenance: {
      source: "polymarket",
      sourceChannel: "polymarket:market-ws",
      venueTimestamp: "2026-10-05T22:20:58.575Z",
      observedIndex: 0,
    },
  };

  it("the V2 `book` frame, exactly as received, is one BookSnapshot and no problem", () => {
    const decoded = decodeInboundFrame(V2_INBOUND[0] ?? "");
    expect(decoded.kind).toBe("values");
    const values = decoded.kind === "values" ? decoded.values : [];
    const parsed = parseMarketEvent(values[0]);
    expect(parsed.status).toBe("parsed");
    // D3: the decoder's output holds its declared fields only.
    expect(parsed.status === "parsed" && Object.hasOwn(parsed.event, "version")).toBe(false);
    const { events, problems } = normalizeMarketEvents(values, { directory: v2Directory() });
    expect(problems).toEqual([]);
    expect(events).toEqual([expectedWsEvent]);
  });

  it.each([
    ["absent: the V1 shape", undefined],
    ['"v1"', "v1"],
    ['"v3"', "v3"],
    ["null", null],
    ["a number", 2],
    ["an object", { v: "v2" }],
  ] as const)("with `version` %s the frame gives the identical events: the key is never read (C-21)", (_label, version) => {
    const value = version === undefined ? withoutVersion(v2BookFrameValue()) : { ...v2BookFrameValue(), version };
    const asV2 = normalizeMarketEvents([v2BookFrameValue()], { directory: v2Directory() });
    const asOther = normalizeMarketEvents([value], { directory: v2Directory() });
    expect(asOther).toEqual(asV2);
    expect(asOther.events).toEqual([expectedWsEvent]);
  });

  it("the V2 REST book decodes without its `version` and normalizes to the same payload as the frame", () => {
    const body = protocolV2Json("book-v2.jsonc");
    const parsed = parseVenueOrderBook(body);
    expect(parsed.status).toBe("parsed");
    if (parsed.status !== "parsed") return;
    expect(Object.hasOwn(parsed.book, "version")).toBe(false);
    // `last_trade_price: ""` is the wire's spelling of absence, never "0" (ADR-001 §8.1).
    expect(parsed.book.last_trade_price).toBeNull();
    const rest = normalizeOrderBooks([parsed.book], { directory: v2Directory() });
    expect(rest.problems).toEqual([]);
    expect(rest.events).toEqual([
      {
        eventType: "BookSnapshot",
        schemaVersion: 1,
        payload: V2_BOOK_PAYLOAD,
        provenance: {
          source: "polymarket",
          sourceChannel: "polymarket:clob-book-rest",
          venueTimestamp: "2026-10-05T22:20:58.575Z",
          observedIndex: 0,
        },
      },
    ]);
    // The REST snapshot and the pushed snapshot are comparable value for value.
    expect(rest.events[0]?.payload).toEqual(expectedWsEvent.payload);
  });

  it("the V2 REST book without `version` (its V1 shape) decodes and normalizes identically", () => {
    const body = protocolV2Json("book-v2.jsonc");
    const asV2 = parseVenueOrderBook(body);
    const asV1 = parseVenueOrderBook(withoutVersion(body));
    expect(asV1).toEqual(asV2);
    if (asV1.status !== "parsed" || asV2.status !== "parsed") throw new Error("unreachable");
    expect(normalizeOrderBooks([asV1.book], { directory: v2Directory() })).toEqual(
      normalizeOrderBooks([asV2.book], { directory: v2Directory() }),
    );
  });

  it("the V1 REST capture of the same round still decodes and normalizes (no V1 change)", () => {
    const body = protocolV2Json("book-v1.jsonc") as { asset_id: string; market: string };
    const v1Market: TestMarketDefinition = {
      internalMarketId: "0199f0a0-0000-7000-8000-000000000003",
      conditionId: body.market,
      yesTokenId: body.asset_id,
      noTokenId: "111614563957165270026378011809694313565736745512637881727398424401624030147043",
    };
    const parsed = parseVenueOrderBook(body);
    expect(parsed.status).toBe("parsed");
    if (parsed.status !== "parsed") return;
    const { events, problems } = normalizeOrderBooks([parsed.book], {
      directory: staticMarketDirectory({ known: [v1Market] }),
    });
    expect(problems).toEqual([]);
    expect(events.map((event) => event.eventType)).toEqual(["BookSnapshot"]);
    const payload = events[0]?.payload as { readonly tokenId: string; readonly bids: readonly unknown[] } | undefined;
    expect(payload?.tokenId).toBe(body.asset_id);
    expect(payload?.bids.length).toBeGreaterThan(0);
  });
});

describe("Protocol V2: the feed on the recorded session (acceptance 2; A9, A12)", () => {
  function replaySession() {
    const scheduler = new ManualScheduler();
    const sockets = fakeWebSocketFactory();
    const events: NormalizedPublicEventAny[] = [];
    const problems: PublicMarketProblem[] = [];
    const frames: RawMarketFrame[] = [];
    const feed = new PublicMarketFeed(
      {
        clock: scheduler.clock,
        timers: scheduler.timers,
        webSocketFactory: sockets.factory,
        directory: v2Directory(),
        connectionId: sequentialConnectionIds(),
        randomFraction: () => 1,
      },
      {
        onEvent: (event) => events.push(event),
        onProblem: (problem) => problems.push(problem),
        onRawFrame: (frame) => frames.push(frame),
      },
      // The session subscribed with `custom_feature_enabled: true` (S-W01).
      { customFeatureEnabled: true },
    );
    feed.subscribe([V2_MARKET.yesTokenId]);
    feed.start();
    sockets.latest().emitOpen();
    const sent = [...sockets.latest().sentFrames];
    for (const text of V2_INBOUND) sockets.latest().emitMessage(text);
    return { events, problems, frames, sent };
  }

  it("subscribes the market channel by the V2 position id, as the session did (A9; F-60, F-62)", () => {
    const recorded = V2_SESSION.find((record) => record.dir === "send" && record.data !== "PING");
    const sessionSubscription = JSON.parse(recorded?.data as string) as Record<string, unknown>;
    expect(sessionSubscription["assets_ids"]).toEqual([V2_MARKET.yesTokenId]);
    // The feed sends `initial_dump` explicitly too (`../../../packages/polymarket-public/src/venue/frames.ts`).
    expect(replaySession().sent).toEqual([{ ...sessionSubscription, initial_dump: true }]);
  });

  it("hands every inbound frame to the raw recorder verbatim, in order, PONGs and the trailing newline included", () => {
    const { frames } = replaySession();
    expect(frames.map((frame) => frame.payload)).toEqual(V2_INBOUND);
    for (const frame of frames) {
      expect(frame).toMatchObject({
        connectionId: "conn-1",
        subscriptionGeneration: 2,
        sourceChannel: "polymarket:market-ws",
      });
    }
  });

  it("publishes the V2 book as its BookSnapshot and reports the unrelated market, dropping nothing", () => {
    const { events, problems } = replaySession();
    expect(events.map((event) => event.eventType)).toEqual(["FeedConnected", "BookSnapshot"]);
    expect(events[1]?.payload).toEqual(V2_BOOK_PAYLOAD);
    expect(events[1]?.provenance).toMatchObject({
      sourceChannel: "polymarket:market-ws",
      connectionId: "conn-1",
      subscriptionGeneration: 2,
      venueTimestamp: "2026-10-05T22:20:58.575Z",
    });
    // The `new_market` frame names a market the catalogue did not register: a problem, not a silent drop (§8.3).
    expect(problems.map((problem) => [problem.code, problem.venueEventType])).toEqual([
      ["UNREGISTERED_MARKET", "new_market"],
    ]);
  });
});
