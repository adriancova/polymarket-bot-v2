/**
 * `THROUGHPUT-1c` review round 1, finding X8 — a partially malformed venue
 * frame must not vouch for a stale book, gateway to trader.
 *
 * ADR-023 lets a market-channel frame on a delivery session vouch for every
 * book delivered on that session. A frame the gateway could only PARTLY
 * normalize lost part of what the venue sent, and the gateway reports that
 * loss as a `DataQualityIncidentOpened` naming no market, which taints the
 * gateway epoch in the trader (ADR-023 D2 rule 4). The candidate at `f341d5f`
 * published that incident AFTER the frame's accepted sibling events, so the
 * sibling closed its own evaluation with the stale book still vouched for:
 * two orders were approved on a YES book 3.1 s old against 2 s bounds, where
 * the last-change rule approved none.
 *
 * This file drives the REAL gateway composition (the data-gateway suite's
 * in-memory harness: the real WebSocket adapter, normalizer, driver,
 * dispatcher, incident registry and sequencer) and feeds EVERYTHING it
 * published, unchanged and in its order, to the REAL assembled paper trader
 * (`UNIV-4`'s pattern, `univ-4-gateway-opens-trader.test.ts`). The ONE
 * hand-written input is the reference feed: two `ReferenceTradeObserved`
 * envelopes in the fixture's own shape, ingested first. The gateway runs
 * WITHOUT its Binance feed on purpose: the Binance adapter reports every
 * subscription start as a `BINANCE_SUBSCRIPTION_START_NO_REPLAY` incident
 * naming no market, which taints the whole gateway epoch (ADR-023 D2 rule 4)
 * and would make both scenarios fall back to the last change for a reason
 * that has nothing to do with the frame under test (see the r1 handoff's
 * known risks). Only the second venue frame differs between the two
 * scenarios:
 *
 * - WELL-FORMED: `[NO book]` — the NO snapshot's frame vouches for the quiet
 *   YES book on the same session, so under `CONNECTION_CONFIRMED` the entry
 *   passes both freshness gates (the control: the timeline really does admit
 *   an entry when nothing is lost);
 * - PARTLY MALFORMED: `[a YES price_change with an unknown side, NO book]` —
 *   the gateway now reports the frame's problem FIRST, so the incident is
 *   sequenced ahead of the NO snapshot, the epoch is tainted before any
 *   evaluation, and the YES book is judged by its own last change (3.1 s):
 *   nothing is admitted, under either basis.
 *
 * Review round 6, finding R6-H1, is the same loss through the GATEWAY'S OWN
 * door: a YES `price_change` the adapter accepts (its `timestamp` lies inside
 * the adapter's epoch range) but whose completed envelope the gateway's
 * frozen contract refuses, because the ISO form of that instant has a
 * five-digit year. `253402300800000` (year 10000 in milliseconds) and the
 * frame's own instant sent in MICROSECONDS both do it. At `74e17ca` the
 * dispatcher refused the event after the frame's NO snapshot was already
 * submitted, so `[NO book, odd YES change]` approved two orders under
 * `CONNECTION_CONFIRMED`. The gateway now validates every event of a frame
 * before it publishes any, and opens `GATEWAY_ENVELOPE_REJECTED` ahead of
 * the frame (`dispatcher.ts` `dispatchFrame`, `feeds/polymarket.ts`): nothing
 * is admitted, under either basis, in either order.
 *
 * PAPER only. No network, no credential, no signer, no real order.
 */

import { IsoTimestampSchema, type EventEnvelope } from "@polymarket-bot/domain";
import type { PublicHttpRequest, PublicHttpResponse } from "@polymarket-bot/polymarket-public";
import { describe, expect, it } from "vitest";

import { buildHarness } from "../data-gateway/support/harness.js";
import {
  adr024Reproduction,
  CONDITION_ID,
  MARKET_ID,
  NO_TOKEN,
  T_CLOSE,
  T_OPEN,
  YES_TOKEN,
  ingested,
  resetEventIds,
  riskPolicy,
  strategyParams,
  traderConfig,
} from "./support/fixture.js";
import { assembleOrThrow } from "./support/run.js";

const GAMMA_BASE = "http://gamma.stub";
const BOOK_AGE_KEY = "quality.input_feed_ages@polymarket.book";

const GATEWAY_MARKET = {
  internalMarketId: MARKET_ID,
  conditionId: CONDITION_ID,
  yesTokenId: YES_TOKEN,
  noTokenId: NO_TOKEN,
  gammaMarketId: "900001",
  parameters: {
    tickSize: "0.01",
    minimumOrderSize: "5",
    negRisk: false,
    tradingDelaySeconds: 0,
    status: "OPEN",
    openTime: T_OPEN,
    closeTime: T_CLOSE,
  },
  observedAt: "2026-03-04T11:00:00.000Z",
} as const;

const READY_MARKET = {
  conditionId: CONDITION_ID,
  question: "Synthetic market (stub)",
  active: true,
  closed: false,
  archived: false,
  acceptingOrders: true,
  restricted: false,
  enableOrderBook: true,
  negRisk: false,
  startDate: "2026-03-04T12:00:00Z",
  endDate: "2026-03-04T12:15:00Z",
  closedTime: null,
  gameStartTime: null,
};

function bookEntry(tokenId: string, bids: readonly [string, string][], asks: readonly [string, string][]): unknown {
  return {
    event_type: "book",
    market: CONDITION_ID,
    asset_id: tokenId,
    bids: bids.map(([price, size]) => ({ price, size })),
    asks: asks.map(([price, size]) => ({ price, size })),
    hash: `hash-${tokenId}`,
    timestamp: "1772625600000",
  };
}

/** A `price_change` for the YES token whose one change has an undocumented side. */
function malformedYesChange(atMs: number): unknown {
  return {
    event_type: "price_change",
    market: CONDITION_ID,
    timestamp: String(atMs),
    price_changes: [{ asset_id: YES_TOKEN, price: "0.34", size: "0", side: "SIDEWAYS", hash: "h-bad" }],
  };
}

type Basis = "LAST_CHANGE" | "CONNECTION_CONFIRMED";

/** The fixture document with both freshness gates at 2 000 ms and the given basis. */
function config(basis: Basis): Record<string, unknown> {
  const params = strategyParams() as { data_quality: Record<string, unknown> } & Record<string, unknown>;
  const policy = riskPolicy() as { freshness: Record<string, unknown> } & Record<string, unknown>;
  const document = traderConfig({
    riskPolicy: { ...policy, freshness: { ...policy.freshness, venueBookMaxAgeMs: 2_000 } },
    bookFreshness:
      basis === "CONNECTION_CONFIRMED"
        ? { basis, maximumLastChangeAgeMs: 30_000 }
        : { basis },
  });
  const instances = document["instances"] as Record<string, unknown>[];
  const instance = instances[0] as Record<string, unknown>;
  instance["params"] = {
    ...params,
    version: 2,
    data_quality: { ...params.data_quality, maximum_book_age_ms: 2_000, book_age_feature_key: BOOK_AGE_KEY },
  };
  return document;
}

/**
 * The gateway timeline: the lifecycle's `MarketOpened` at the open; the YES book (asks under the 0.35 trigger) at +1.000 s; then
 * nothing for the YES token, and the second frame at +4.100 s.
 *
 * Review round 8 (R8-H1): the trader now takes a frame's session
 * confirmations only once a LATER event of the same gateway epoch proves the
 * frame whole, so a frame that ends the stream never vouches. A test whose
 * outcome turns on the second frame therefore passes a `successor`: one more
 * socket message, 100 ms later, which proves the second frame whole. Then
 * the frame is proven, and only the taint (or its absence) decides.
 */
async function gatewayStream(
  secondFrame: readonly unknown[],
  successor?: readonly unknown[],
): Promise<readonly EventEnvelope<unknown>[]> {
  const route = (request: PublicHttpRequest): PublicHttpResponse => {
    if (request.url.startsWith(`${GAMMA_BASE}/markets/`)) {
      return { status: 200, body: JSON.stringify(READY_MARKET) };
    }
    throw new Error(`unexpected request ${request.url}`);
  };
  const gateway = await buildHarness({
    config: {
      markets: [GATEWAY_MARKET],
      polymarket: { feedId: "polymarket-market" },
      lifecycle: { feedId: "polymarket-lifecycle", baseUrl: GAMMA_BASE, pollIntervalMs: 10_000 },
    },
    http: route,
  });
  gateway.timers.advance(Date.parse(T_OPEN) - gateway.clock.nowMs());
  gateway.gateway.start();
  await gateway.settle();
  const socket = gateway.polymarketSockets.current;
  socket.open();
  await gateway.settle();
  gateway.timers.advance(1_000);
  socket.message(JSON.stringify([bookEntry(YES_TOKEN, [["0.32", "200"], ["0.31", "300"]], [["0.34", "200"], ["0.35", "300"]])]));
  await gateway.settle();
  gateway.timers.advance(3_100);
  socket.message(JSON.stringify(secondFrame));
  await gateway.settle();
  if (successor !== undefined) {
    gateway.timers.advance(100);
    socket.message(JSON.stringify(successor));
    await gateway.settle();
  }
  await gateway.gateway.stop();
  return gateway.published();
}

const noBook = (): unknown => bookEntry(NO_TOKEN, [["0.65", "200"]], [["0.66", "200"]]);
/** r8: the successor frame, a NO book 100 ms after the second frame (see `gatewayStream`). */
const SUCCESSOR: readonly unknown[] = [bookEntry(NO_TOKEN, [["0.64", "200"]], [["0.66", "200"]])];

interface Outcome {
  readonly orders: number;
  readonly approvals: number;
  readonly staleBookPauses: number;
}

async function trade(published: readonly EventEnvelope<unknown>[], basis: Basis): Promise<Outcome> {
  // `CADENCE-1` (ADR-026 D1.6): this file pins book freshness at EACH
  // evaluation of a timeline written for ADR-024's per-frame cadence (an entry
  // needs the book evaluations 100 ms apart), so it REPRODUCES that cadence.
  const run = assembleOrThrow({
    config: config(basis),
    evaluationCadence: adr024Reproduction("test/integration/paper-trader/throughput-1c-partial-frame-taint.test.ts"),
  });
  resetEventIds();
  // The reference feed (hand-written, see the header), just before the open.
  run.trader.loop.ingest(
    ingested(
      "ReferenceTradeObserved",
      { venue: "binance", symbol: "BTCUSDT", price: "100000", size: "0.5" },
      { receivedAt: "2026-03-04T11:59:58.000Z", ingestSeq: 1, source: "binance" },
    ),
  );
  run.trader.loop.ingest(
    ingested(
      "ReferenceTradeObserved",
      { venue: "binance", symbol: "BTCUSDT", price: "100100", size: "0.25" },
      { receivedAt: "2026-03-04T11:59:59.000Z", ingestSeq: 2, source: "binance" },
    ),
  );
  for (const [index, envelope] of published.entries()) {
    run.trader.loop.ingest({
      envelope,
      identity: {
        gatewayEpoch: envelope.gatewayEpoch,
        ingestSeq: envelope.ingestSeq,
        receivedAt: envelope.receivedAt,
        datasetRowOrdinal: index + 1,
      },
    });
  }
  await run.trader.loop.drain();
  const health = run.trader.loop.health();
  expect(health.halts).toEqual([]);
  expect(run.trader.markets.get(MARKET_ID)?.lifecycle).toBe("OPEN");
  return {
    orders: run.trader.loop.orderProvenance().length,
    approvals: health.risk.approvals,
    staleBookPauses: run.parts.store.decisions.filter((recorded) =>
      recorded.record.decision.reasonCodes.includes("SB.STALE_BOOK"),
    ).length,
  };
}

describe("THROUGHPUT-1c r1 (X8) — a partly malformed frame cannot vouch for a stale book, gateway to trader", () => {
  it("control: a well-formed sibling frame vouches for the quiet YES book under CONNECTION_CONFIRMED only", async () => {
    // r8: followed by a successor frame, which proves the sibling frame whole.
    const published = await gatewayStream([noBook()], SUCCESSOR);
    expect(published.filter((envelope) => envelope.eventType === "DataQualityIncidentOpened")).toHaveLength(0);
    const confirmed = await trade(published, "CONNECTION_CONFIRMED");
    expect(confirmed.approvals).toBeGreaterThan(0);
    expect(confirmed.orders).toBeGreaterThan(0);
    const lastChange = await trade(published, "LAST_CHANGE");
    expect(lastChange.orders).toBe(0);
    expect(lastChange.staleBookPauses).toBeGreaterThan(0);
  });

  it("the frame's incident is sequenced BEFORE its accepted sibling events", async () => {
    const published = await gatewayStream([malformedYesChange(Date.parse(T_OPEN) + 4_100), noBook()]);
    const types = published.map((envelope) => envelope.eventType);
    const incident = types.indexOf("DataQualityIncidentOpened");
    const lastSnapshot = types.lastIndexOf("BookSnapshot");
    expect(incident).toBeGreaterThan(-1);
    expect(lastSnapshot).toBeGreaterThan(-1);
    // The NO snapshot is the frame's sibling; the incident precedes it.
    expect(incident).toBeLessThan(lastSnapshot);
    const payload = published[incident]?.payload as { reasonCode?: unknown; affectedMarketIds?: unknown };
    expect(payload.reasonCode).toBe("UNKNOWN_SIDE");
    expect(payload.affectedMarketIds).toBeUndefined();
  });

  it("no order is admitted after a frame loses a YES update, under either basis", async () => {
    // r8: with a successor, the frame is proven whole, so the taint decides.
    const published = await gatewayStream([malformedYesChange(Date.parse(T_OPEN) + 4_100), noBook()], SUCCESSOR);
    const confirmed = await trade(published, "CONNECTION_CONFIRMED");
    const lastChange = await trade(published, "LAST_CHANGE");
    expect([confirmed.orders, lastChange.orders], "orders after a frame lost a YES update").toEqual([0, 0]);
    expect([confirmed.approvals, lastChange.approvals]).toEqual([0, 0]);
    // Refused for the right reason: the YES book is judged by its own 3.1 s.
    expect(confirmed.staleBookPauses).toBeGreaterThan(0);
  });
});

/**
 * A well-formed YES `price_change` (SELL 0.34 to size 0: it removes the very
 * ask the entry would trade against) whose only oddity is its `timestamp`.
 */
function oddTimestampYesChange(timestamp: string): unknown {
  return {
    event_type: "price_change",
    market: CONDITION_ID,
    timestamp,
    price_changes: [{ asset_id: YES_TOKEN, price: "0.34", size: "0", side: "SELL", hash: "h-odd" }],
  };
}

/** Venue timestamps the adapter accepts and the gateway's envelope contract refuses (R6-H1). */
const ENVELOPE_REFUSED_TIMESTAMPS: readonly (readonly [string, string])[] = [
  ["year 10000 in milliseconds", "253402300800000"],
  ["the frame's instant in microseconds", String((Date.parse(T_OPEN) + 4_100) * 1_000)],
];

const FRAME_ORDERS: readonly (readonly [string, (change: unknown) => readonly unknown[]])[] = [
  ["NO book first", (change) => [noBook(), change]],
  ["YES change first", (change) => [change, noBook()]],
];

function envelopeRejection(published: readonly EventEnvelope<unknown>[]): number {
  return published.findIndex(
    (envelope) =>
      envelope.eventType === "DataQualityIncidentOpened" &&
      (envelope.payload as { reasonCode?: unknown }).reasonCode === "GATEWAY_ENVELOPE_REJECTED",
  );
}

describe("THROUGHPUT-1c r6 (R6-H1) — an event the gateway's envelope contract refuses cannot leave its frame vouching for a stale book", () => {
  it("the trigger: each timestamp's ISO form has a five-digit year, which the frozen contract refuses", () => {
    for (const [, timestamp] of ENVELOPE_REFUSED_TIMESTAMPS) {
      const iso = new Date(Number(timestamp)).toISOString();
      expect(iso.startsWith("+0"), iso).toBe(true);
      expect(IsoTimestampSchema.safeParse(iso).success, iso).toBe(false);
    }
  });

  for (const [label, timestamp] of ENVELOPE_REFUSED_TIMESTAMPS) {
    for (const [order, frame] of FRAME_ORDERS) {
      it(`${label}, ${order}: GATEWAY_ENVELOPE_REJECTED is published BEFORE the frame's accepted NO snapshot`, async () => {
        const published = await gatewayStream(frame(oddTimestampYesChange(timestamp)));
        const incident = envelopeRejection(published);
        const noSnapshot = published.findIndex(
          (envelope) =>
            envelope.eventType === "BookSnapshot" && (envelope.payload as { tokenId?: unknown }).tokenId === NO_TOKEN,
        );
        expect(incident, "the envelope rejection is published").toBeGreaterThan(-1);
        expect(noSnapshot, "the frame's accepted NO snapshot is published").toBeGreaterThan(-1);
        expect(incident, "the loss precedes the frame's accepted event").toBeLessThan(noSnapshot);
        const incidentEnvelope = published[incident] as EventEnvelope<unknown>;
        const snapshotEnvelope = published[noSnapshot] as EventEnvelope<unknown>;
        expect((incidentEnvelope.payload as { affectedMarketIds?: unknown }).affectedMarketIds).toBeUndefined();
        // Stream order: strictly increasing sequence, receipt instants never backwards.
        expect(BigInt(incidentEnvelope.ingestSeq) < BigInt(snapshotEnvelope.ingestSeq)).toBe(true);
        expect(Date.parse(incidentEnvelope.receivedAt) <= Date.parse(snapshotEnvelope.receivedAt)).toBe(true);
        // The refused change itself is not published.
        expect(published.filter((envelope) => envelope.eventType === "BookLevelChanged")).toHaveLength(0);
      });

      it(`${label}, ${order}: no order is admitted under either basis`, async () => {
        // r8: with a successor, the frame is proven whole, so the taint decides.
        const published = await gatewayStream(frame(oddTimestampYesChange(timestamp)), SUCCESSOR);
        const confirmed = await trade(published, "CONNECTION_CONFIRMED");
        const lastChange = await trade(published, "LAST_CHANGE");
        expect([confirmed.orders, lastChange.orders], "orders after the gateway refused a YES update").toEqual([0, 0]);
        expect([confirmed.approvals, lastChange.approvals]).toEqual([0, 0]);
        // Refused for the right reason: the YES book is judged by its own 3.1 s.
        expect(confirmed.staleBookPauses).toBeGreaterThan(0);
        expect(lastChange.staleBookPauses).toBeGreaterThan(0);
      });
    }
  }
});
