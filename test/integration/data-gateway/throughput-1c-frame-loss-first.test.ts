/**
 * `THROUGHPUT-1c` review round 6, finding R6-H1 — the gateway publishes a
 * market-channel frame's loss BEFORE any of the frame's events.
 *
 * ADR-023 lets a market-channel frame on a delivery session vouch for every
 * book on that session, so a frame that lost one of its events must say so
 * before its accepted siblings can close an evaluation in the trader. The
 * adapter reports its own normalization problems first (r1, X8). This file
 * pins the gateway's own door: an event the adapter ACCEPTS but whose
 * completed envelope the frozen contract REFUSES. A venue `timestamp` of
 * `253402300800000` is inside the adapter's epoch range, and its ISO form
 * (`+010000-01-01T00:00:00.000Z`) is refused by `IsoTimestampSchema`. At
 * `74e17ca` the dispatcher refused that event only when it reached it, after
 * the frame's earlier siblings were submitted, so the incident followed them.
 *
 * The REAL gateway composition (the suite's in-memory harness: the real
 * adapter, the socket-bracketing feed driver, the dispatcher, the registry,
 * the sequencer and the publisher) drives every case.
 *
 * PAPER only. No network, no credential, no signer, no real order.
 */

import type { EventEnvelope } from "@polymarket-bot/domain";
import { describe, expect, it } from "vitest";

import { buildHarness, MARKET, type Harness } from "./support/harness.js";

/** Inside the adapter's epoch range; its ISO form has a five-digit year. */
const REFUSED_TIMESTAMP = "253402300800000";

function book(tokenId: string, ask: string): unknown {
  return {
    event_type: "book",
    market: MARKET.conditionId,
    asset_id: tokenId,
    bids: [{ price: "0.30", size: "100" }],
    asks: [{ price: ask, size: "80" }],
    hash: `bookhash-${tokenId}`,
    timestamp: "1772400000000",
  };
}

/** A well-formed `price_change` whose only oddity is its `timestamp`. */
function yesChange(timestamp: string): unknown {
  return {
    event_type: "price_change",
    market: MARKET.conditionId,
    timestamp,
    price_changes: [{ asset_id: MARKET.yesTokenId, price: "0.55", size: "0", side: "SELL", hash: "h-odd" }],
  };
}

async function started(): Promise<Harness> {
  const harness = await buildHarness({ config: { polymarket: { feedId: "polymarket-market" } } });
  harness.gateway.start();
  harness.polymarketSockets.current.open();
  await harness.settle();
  return harness;
}

function isEnvelopeRejection(envelope: EventEnvelope<unknown>): boolean {
  return (
    envelope.eventType === "DataQualityIncidentOpened" &&
    (envelope.payload as { reasonCode?: unknown }).reasonCode === "GATEWAY_ENVELOPE_REJECTED"
  );
}

/** The published stream from the frame's first event on (everything before it is the connection's). */
function afterConnect(harness: Harness): readonly EventEnvelope<unknown>[] {
  const published = harness.published();
  const first = published.findIndex(
    (envelope) => envelope.eventType === "BookSnapshot" || isEnvelopeRejection(envelope),
  );
  return first === -1 ? [] : published.slice(first);
}

function label(envelope: EventEnvelope<unknown>): string {
  const payload = envelope.payload as { tokenId?: unknown; reasonCode?: unknown };
  if (envelope.eventType === "BookSnapshot") return `BookSnapshot(${String(payload.tokenId)})`;
  if (envelope.eventType === "DataQualityIncidentOpened") return `Incident(${String(payload.reasonCode)})`;
  return envelope.eventType;
}

describe("THROUGHPUT-1c r6 (R6-H1) — a frame's envelope loss is published before the frame", () => {
  it("a well-formed frame is published whole, in its order, right behind its raw frame, inside the socket callback", async () => {
    const harness = await started();
    const before = harness.gateway.metrics().dispatcher.dispatched;
    harness.polymarketSockets.current.message(
      JSON.stringify([book(MARKET.yesTokenId, "0.55"), book(MARKET.noTokenId, "0.50")]),
    );
    // Nothing waits on a timer or a later message: both events were handed
    // to the publisher before the socket callback returned.
    expect(harness.gateway.metrics().dispatcher.dispatched - before).toBe(2);
    await harness.settle();
    await harness.gateway.stop();

    const frame = afterConnect(harness).filter((envelope) => envelope.eventType === "BookSnapshot");
    expect(frame.map(label)).toEqual([`BookSnapshot(${MARKET.yesTokenId})`, `BookSnapshot(${MARKET.noTokenId})`]);
    const [yes, no] = frame as [EventEnvelope<unknown>, EventEnvelope<unknown>];
    expect(yes.causationId).toBeDefined();
    expect(no.causationId).toBe(yes.causationId);
    // `raw:<epoch>:<raw seq>`: the two events take the next two sequences.
    const rawSeq = BigInt(String(yes.causationId).split(":").at(-1) ?? "");
    expect([BigInt(yes.ingestSeq), BigInt(no.ingestSeq)]).toEqual([rawSeq + 1n, rawSeq + 2n]);
    expect(harness.gateway.metrics().dispatcher.envelopeRejections).toBe(0);
    // (The harness runs no lifecycle feed, so its startup incident is not the frame's.)
    expect(harness.published().filter(isEnvelopeRejection)).toHaveLength(0);
  });

  it("[NO book, refused YES change]: GATEWAY_ENVELOPE_REJECTED precedes the frame's accepted NO book", async () => {
    const harness = await started();
    harness.polymarketSockets.current.message(
      JSON.stringify([book(MARKET.noTokenId, "0.50"), yesChange(REFUSED_TIMESTAMP)]),
    );
    await harness.settle();
    await harness.gateway.stop();

    const stream = afterConnect(harness);
    expect(stream.slice(0, 2).map(label)).toEqual([
      "Incident(GATEWAY_ENVELOPE_REJECTED)",
      `BookSnapshot(${MARKET.noTokenId})`,
    ]);
    const [incident, noBook] = stream as [EventEnvelope<unknown>, EventEnvelope<unknown>];
    const payload = incident.payload as { affectedMarketIds?: unknown; detail?: unknown };
    expect(payload.affectedMarketIds).toBeUndefined();
    expect(String(payload.detail)).toContain("1 of a frame's 2 events");
    expect(BigInt(incident.ingestSeq) < BigInt(noBook.ingestSeq)).toBe(true);
    expect(Date.parse(incident.receivedAt) <= Date.parse(noBook.receivedAt)).toBe(true);
    // The refused change is not published, and the refusal is counted once.
    expect(harness.publishedOfType("BookLevelChanged")).toHaveLength(0);
    expect(harness.gateway.metrics().dispatcher.envelopeRejections).toBe(1);
    expect(harness.incidents.map((recorded) => recorded.reasonCode)).toContain("GATEWAY_ENVELOPE_REJECTED");
  });

  it("[YES book, NO book, refused YES change]: the incident precedes EVERY accepted event of the frame", async () => {
    const harness = await started();
    harness.polymarketSockets.current.message(
      JSON.stringify([book(MARKET.yesTokenId, "0.55"), book(MARKET.noTokenId, "0.50"), yesChange(REFUSED_TIMESTAMP)]),
    );
    await harness.settle();
    await harness.gateway.stop();

    expect(afterConnect(harness).slice(0, 3).map(label)).toEqual([
      "Incident(GATEWAY_ENVELOPE_REJECTED)",
      `BookSnapshot(${MARKET.yesTokenId})`,
      `BookSnapshot(${MARKET.noTokenId})`,
    ]);
  });

  it("a frame followed at once by a socket close keeps its place: the frame's events precede FeedDisconnected", async () => {
    const harness = await started();
    const socket = harness.polymarketSockets.current;
    socket.message(JSON.stringify([book(MARKET.noTokenId, "0.50"), yesChange(REFUSED_TIMESTAMP)]));
    socket.serverClose();
    await harness.settle();
    await harness.gateway.stop();

    const types = afterConnect(harness).map(label);
    const disconnected = types.indexOf("FeedDisconnected");
    expect(disconnected).toBeGreaterThan(-1);
    expect(types.slice(0, disconnected)).toEqual([
      "Incident(GATEWAY_ENVELOPE_REJECTED)",
      `BookSnapshot(${MARKET.noTokenId})`,
    ]);
  });
});
