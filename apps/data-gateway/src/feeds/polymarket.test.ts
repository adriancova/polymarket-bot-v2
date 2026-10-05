/**
 * `THROUGHPUT-1c` r6 (R6-H1): the driver's frame bracket, the parts the real
 * adapter cannot reach. The data-gateway integration suite pins the bracket
 * end to end (`throughput-1c-frame-loss-first.test.ts`); this file pins its
 * edges with hand-made adapter output: what a throw inside the socket
 * callback, a non-frame event inside it, and an event outside it do.
 *
 * `ROLLOVER-1` r4 (R4-FABLE-02(a)): a `MarketResolved` inside a frame is
 * handed to the admission feed with ITS OWN entry's publication outcome
 * (`#flushFrame`, `outcomes[index]`), whatever its siblings' outcomes are —
 * so a refused resolution is never discharged by a published sibling, and a
 * published one is never held owed by a refused sibling (R3-ASTRA-01's class).
 */

import type {
  NormalizedPublicEventAny,
  PublicBookSnapshotFetcher,
  PublicWebSocketFactory,
  PublicWebSocketHandlers,
} from "@polymarket-bot/polymarket-public";
import { describe, expect, it } from "vitest";

import { GatewayDispatcher } from "../dispatcher.js";
import { IncidentRegistry } from "../incidents.js";
import type { GatewayJournal } from "../journal.js";
import { GatewayPublisher } from "../publisher.js";
import { IngestSequencer } from "../sequencer.js";
import { deterministicIdSource, ManualGatewayClock, ManualGatewayTimers } from "../testing/index.js";
import { MemoryEventTransport } from "../testing/memory-transport.js";
import { PolymarketFeedDriver, type DispatchedResolution } from "./polymarket.js";

const EPOCH = "00000000-0000-4000-8000-0000000000c6";
const MARKET_ID = "01990000-0000-7000-8000-000000000001";

function build(onMarketResolved?: (resolution: DispatchedResolution) => void) {
  const clock = new ManualGatewayClock();
  const sequencer = new IngestSequencer(EPOCH);
  const transport = new MemoryEventTransport();
  const publisher = new GatewayPublisher({ transport, stream: "market", clock });
  const dispatcher = new GatewayDispatcher({
    clock,
    ids: deterministicIdSource(),
    sequencer,
    publisher,
    incidents: new IncidentRegistry(),
  });
  // Only `record` is reached: every raw frame is recorded.
  const journal = {
    record: () => ({ recorded: true, ingestSeq: sequencer.next() }),
  } as unknown as GatewayJournal;
  const driver = new PolymarketFeedDriver({
    feedId: "polymarket-market",
    endpoint: "wss://example.invalid/ws/market",
    journal,
    dispatcher,
    clock,
    timers: new ManualGatewayTimers(clock),
    snapshotFetcher: {} as unknown as PublicBookSnapshotFetcher,
    ...(onMarketResolved === undefined ? {} : { onMarketResolved }),
  });
  let socketHandlers: PublicWebSocketHandlers | undefined;
  const inner: PublicWebSocketFactory = (_url, handlers) => {
    socketHandlers = handlers;
    return { send: () => undefined, close: () => undefined };
  };
  /** Opens a bracketed socket whose `onMessage` runs `adapter` (the adapter's part of one message). */
  const socket = (adapter: (data: string) => void) => {
    driver.frameBoundedSocketFactory(inner)("wss://example.invalid/ws/market", {
      onOpen: () => undefined,
      onMessage: adapter,
      onClose: () => undefined,
      onError: () => undefined,
    });
    if (socketHandlers === undefined) throw new Error("the socket was not opened");
    return socketHandlers;
  };
  return { transport, publisher, dispatcher, driver, socket };
}

const provenance = {
  source: "polymarket",
  sourceChannel: "polymarket:market-ws",
  venueTimestamp: "2026-03-04T12:00:00.000Z",
  connectionId: "polymarket-market-a1",
  subscriptionGeneration: 1,
} as const;

function snapshot(tokenId: string): NormalizedPublicEventAny {
  return {
    eventType: "BookSnapshot",
    schemaVersion: 1,
    payload: { internalMarketId: MARKET_ID, tokenId, bids: [], asks: [{ price: "0.55", size: "10" }] },
    provenance,
  } as unknown as NormalizedPublicEventAny;
}

function feedStale(): NormalizedPublicEventAny {
  return {
    eventType: "FeedStale",
    schemaVersion: 1,
    payload: { feedId: "polymarket-market", detectedAt: "2026-03-04T12:00:00.000Z", stalenessMs: 30_000 },
    provenance: { ...provenance, venueTimestamp: undefined },
  } as unknown as NormalizedPublicEventAny;
}

const rawFrame = (payload: string) => ({
  receivedAt: "2026-03-04T12:00:00.000Z",
  connectionId: "polymarket-market-a1",
  subscriptionGeneration: 1,
  sourceChannel: "polymarket:market-ws",
  payload,
});

function labels(transport: MemoryEventTransport): string[] {
  return transport.published("market").map((envelope) => {
    const payload = envelope.payload as { tokenId?: unknown; reasonCode?: unknown };
    if (envelope.eventType === "BookSnapshot") return `BookSnapshot(${String(payload.tokenId)})`;
    if (envelope.eventType === "DataQualityIncidentOpened") return `Incident(${String(payload.reasonCode)})`;
    return envelope.eventType;
  });
}

describe("PolymarketFeedDriver frame bracket (THROUGHPUT-1c r6, R6-H1)", () => {
  it("a frame's events wait for the end of the socket callback, then go out together", () => {
    const { driver, dispatcher, socket } = build();
    const seenInside: number[] = [];
    socket((data) => {
      driver.onRawFrame(rawFrame(data));
      driver.onEvent(snapshot("1"));
      driver.onEvent(snapshot("2"));
      seenInside.push(dispatcher.metrics().dispatched);
    }).onMessage("[]");
    expect(seenInside).toEqual([0]);
    expect(dispatcher.metrics().dispatched).toBe(2);
    expect(driver.metrics().eventsDispatched).toBe(2);
  });

  it("a throw inside the socket callback still dispatches what the frame emitted, and propagates", async () => {
    const { driver, transport, publisher, socket } = build();
    const handlers = socket((data) => {
      driver.onRawFrame(rawFrame(data));
      driver.onEvent(snapshot("1"));
      throw new Error("adapter fault");
    });
    expect(() => {
      handlers.onMessage("[]");
    }).toThrow("adapter fault");
    await publisher.settle();
    expect(labels(transport)).toEqual(["BookSnapshot(1)"]);
  });

  it("a non-frame event inside the callback first releases the buffered frame: stream order is kept", async () => {
    const { driver, transport, publisher, socket } = build();
    socket((data) => {
      driver.onRawFrame(rawFrame(data));
      driver.onEvent(snapshot("1"));
      driver.onEvent(feedStale());
      driver.onEvent(snapshot("2"));
    }).onMessage("[]");
    await publisher.settle();
    expect(labels(transport)).toEqual([
      "BookSnapshot(1)",
      "FeedStale",
      "Incident(GATEWAY_FEED_STALL)",
      "BookSnapshot(2)",
    ]);
  });

  it("a second raw frame inside one callback first releases the first frame's events", async () => {
    const { driver, transport, publisher, socket } = build();
    socket((data) => {
      driver.onRawFrame(rawFrame(data));
      driver.onEvent(snapshot("1"));
      driver.onRawFrame(rawFrame(data));
      driver.onEvent(snapshot("2"));
    }).onMessage("[]");
    await publisher.settle();
    const published = transport.published("market");
    expect(published.map((envelope) => envelope.causationId)).toEqual([`raw:${EPOCH}:1`, `raw:${EPOCH}:3`]);
    expect(published.map((envelope) => envelope.ingestSeq)).toEqual(["2", "4"]);
  });

  it("a message handled inside another (a re-entrant socket) keeps every event in order and the outer bracket open", async () => {
    const { driver, dispatcher, transport, publisher, socket } = build();
    let depth = 0;
    const handlers = socket((data) => {
      depth += 1;
      driver.onRawFrame(rawFrame(data));
      driver.onEvent(snapshot(depth === 1 ? "1" : "2"));
      if (depth === 1) {
        handlers.onMessage("[]");
        const afterInner = dispatcher.metrics().dispatched;
        driver.onEvent(snapshot("3"));
        // Still bracketed: the outer callback's later event waits for its end.
        expect(dispatcher.metrics().dispatched).toBe(afterInner);
      }
    });
    handlers.onMessage("[]");
    await publisher.settle();
    expect(labels(transport)).toEqual(["BookSnapshot(1)", "BookSnapshot(2)", "BookSnapshot(3)"]);
  });

  it("outside a socket callback (REST recovery) every event is dispatched at once, one by one", () => {
    const { driver, dispatcher } = build();
    driver.onEvent(snapshot("1"));
    expect(dispatcher.metrics().dispatched).toBe(1);
    driver.onEvent(snapshot("2"));
    expect(dispatcher.metrics().dispatched).toBe(2);
  });
});

const CONDITION_ID = "0x5e196ca7c84c54fb1482ca206df477bba1fb3d8c813580c3838186cedde32b29";

/** A `MarketResolved` as the adapter derives it; `outcome` "MAYBE" fails its frozen contract. */
function resolved(outcome: string): NormalizedPublicEventAny {
  return {
    eventType: "MarketResolved",
    schemaVersion: 1,
    payload: { internalMarketId: MARKET_ID, conditionId: CONDITION_ID, outcome, resolvedAt: "2026-03-04T12:00:00.000Z" },
    provenance,
  } as unknown as NormalizedPublicEventAny;
}

/** A book snapshot whose ask price is not a decimal: it fails its frozen contract. */
function refusedSnapshot(tokenId: string): NormalizedPublicEventAny {
  return {
    eventType: "BookSnapshot",
    schemaVersion: 1,
    payload: { internalMarketId: MARKET_ID, tokenId, bids: [], asks: [{ price: "not-a-price", size: "10" }] },
    provenance,
  } as unknown as NormalizedPublicEventAny;
}

describe("ROLLOVER-1 r4 (R4-FABLE-02(a)): each resolution of a frame carries its OWN publication outcome", () => {
  async function frameOf(events: readonly NormalizedPublicEventAny[]) {
    const resolutions: DispatchedResolution[] = [];
    const { driver, transport, publisher, socket } = build((resolution) => resolutions.push(resolution));
    socket((data) => {
      driver.onRawFrame(rawFrame(data));
      for (const event of events) driver.onEvent(event);
    }).onMessage("[]");
    await publisher.settle();
    expect(resolutions).toHaveLength(1);
    const outcome = await resolutions[0]?.published;
    return { outcome, published: labels(transport) };
  }

  it("R4-FABLE-02(a): a REFUSED sibling ahead of a valid resolution — the resolution is reported PUBLISHED (its own outcome, not entry 0's)", async () => {
    const { outcome, published } = await frameOf([refusedSnapshot("1"), resolved("YES_WIN")]);
    expect(published).toEqual(["Incident(GATEWAY_ENVELOPE_REJECTED)", "MarketResolved"]);
    expect(outcome?.published).toBe(true);
  });

  it("R4-FABLE-02(a): a PUBLISHED sibling ahead of a refused resolution — the resolution is reported NOT published, so it is never discharged", async () => {
    const { outcome, published } = await frameOf([snapshot("1"), resolved("MAYBE")]);
    expect(published).toEqual(["Incident(GATEWAY_ENVELOPE_REJECTED)", "BookSnapshot(1)"]);
    expect(outcome?.published).toBe(false);
  });

  it("control: a frame of two valid events — the resolution is reported published", async () => {
    const { outcome, published } = await frameOf([snapshot("1"), resolved("YES_WIN")]);
    expect(published).toEqual(["BookSnapshot(1)", "MarketResolved"]);
    expect(outcome?.published).toBe(true);
  });
});
