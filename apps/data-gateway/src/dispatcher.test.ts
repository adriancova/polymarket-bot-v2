import { describe, expect, it } from "vitest";

import type { EventEnvelope } from "@polymarket-bot/domain";
import type { MarketEventTransport } from "@polymarket-bot/event-bus";

import { GatewayDispatcher } from "./dispatcher.js";
import type { EnvelopeDraft } from "./envelope.js";
import { IncidentRegistry } from "./incidents.js";
import { GatewayPublisher } from "./publisher.js";
import { IngestSequencer } from "./sequencer.js";
import { deterministicIdSource, ManualGatewayClock } from "./testing/index.js";
import { MemoryEventTransport } from "./testing/memory-transport.js";

const EPOCH = "00000000-0000-4000-8000-000000000001";

function build(observer: ConstructorParameters<typeof GatewayDispatcher>[0]["observer"] = {}) {
  const clock = new ManualGatewayClock();
  const transport = new MemoryEventTransport();
  const publisher = new GatewayPublisher({ transport, stream: "market", clock });
  const dispatcher = new GatewayDispatcher({
    clock,
    ids: deterministicIdSource(),
    sequencer: new IngestSequencer(EPOCH),
    publisher,
    incidents: new IncidentRegistry(),
    observer,
  });
  return { clock, transport, publisher, dispatcher };
}

const validDraft: EnvelopeDraft = {
  eventType: "FeedStale",
  schemaVersion: 1,
  source: "binance",
  sourceChannel: "binance:stream-connection",
  payload: {
    feedId: "binance-reference",
    detectedAt: "2026-08-30T12:00:00.000Z",
    stalenessMs: 45_000,
  },
};

describe("GatewayDispatcher", () => {
  it("assigns, completes, validates, and publishes an event", async () => {
    const { transport, dispatcher } = build();
    const outcome = await dispatcher.dispatch(validDraft);
    expect(outcome.published).toBe(true);
    const published = transport.published("market");
    expect(published).toHaveLength(1);
    expect(published[0]?.gatewayEpoch).toBe(EPOCH);
    expect(published[0]?.ingestSeq).toBe("1");
    expect(published[0]?.eventType).toBe("FeedStale");
  });

  it("keeps submission order equal to assignment order across many dispatches", async () => {
    const { transport, dispatcher } = build();
    const outcomes = [];
    for (let index = 0; index < 10; index += 1) {
      outcomes.push(dispatcher.dispatch(validDraft));
    }
    await Promise.all(outcomes);
    const sequences = transport.published("market").map((envelope) => envelope.ingestSeq);
    expect(sequences).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
  });

  // ADR-002 Consequences: a rejected envelope is routed to an incident with
  // the draft preserved, never swallowed.
  it("routes a rejected envelope to an incident and the observer", async () => {
    const rejections: string[] = [];
    const incidents: string[] = [];
    const { transport, dispatcher } = build({
      onEnvelopeRejected: (rejection) => rejections.push(rejection.detail),
      onIncident: (incident) => incidents.push(incident.reasonCode),
    });
    const badDraft: EnvelopeDraft = { ...validDraft, payload: { nonsense: true } };
    const outcome = await dispatcher.dispatch(badDraft);
    expect(outcome.published).toBe(false);
    expect(rejections).toHaveLength(1);
    expect(incidents).toEqual(["GATEWAY_ENVELOPE_REJECTED"]);
    // The incident's own envelope IS published (it is valid).
    const published = transport.published("market");
    expect(published).toHaveLength(1);
    expect(published[0]?.eventType).toBe("DataQualityIncidentOpened");
    expect(dispatcher.metrics().envelopeRejections).toBe(1);
  });

  it("terminates the rejection→incident recursion through the registry's dedup", async () => {
    const incidents: string[] = [];
    const { dispatcher } = build({
      onIncident: (incident) => incidents.push(incident.reasonCode),
    });
    const badDraft: EnvelopeDraft = { ...validDraft, payload: { nonsense: true } };
    await dispatcher.dispatch(badDraft);
    await dispatcher.dispatch(badDraft);
    await dispatcher.dispatch(badDraft);
    // One genuine incident; repeats suppressed by the open-key dedup.
    expect(incidents).toEqual(["GATEWAY_ENVELOPE_REJECTED"]);
    expect(dispatcher.incidents.metrics().repeatsSuppressed).toBe(2);
  });

  // Regression: an incident opened with an adapter-supplied payload builder
  // must still reach the observer. The observer is the delivery that survives
  // a transport outage, so an incident that skipped it would be invisible
  // exactly when it matters most.
  it("notifies the observer for an incident opened with an adapter-supplied draft", async () => {
    const incidents: string[] = [];
    const { transport, publisher, dispatcher } = build({
      onIncident: (incident) => incidents.push(incident.reasonCode),
    });
    dispatcher.openIncident(
      {
        scope: "coinbase-reference",
        reasonCode: "COINBASE_FEED_STALE",
        severity: "NOTIFY",
        detail: "no frame for 30000ms",
        feedId: "coinbase-reference",
      },
      (incidentId) => ({
        eventType: "DataQualityIncidentOpened",
        schemaVersion: 1,
        source: "coinbase",
        sourceChannel: "coinbase:market-data-ws",
        payload: {
          incidentId,
          openedAt: "2026-08-30T12:00:00.000Z",
          reasonCode: "COINBASE_FEED_STALE",
          severity: "NOTIFY",
          detail: "no frame for 30000ms",
          feedId: "coinbase-reference",
        },
      }),
    );
    await publisher.settle();
    expect(incidents).toEqual(["COINBASE_FEED_STALE"]);
    // The published envelope carries the ADAPTER's provenance, not `internal`.
    const published = transport.published("market");
    expect(published).toHaveLength(1);
    expect(published[0]?.source).toBe("coinbase");
  });

  // ROUND-1 REVIEW L1: "assign and submit in one step" was not literally true
  // — validation sits between the two, so a rejected draft consumes a
  // sequence and publishes nothing. This pins the guarantee that IS made
  // (strictly increasing submission order) and the one that is NOT
  // (contiguity), so the code comment and the behaviour cannot drift apart.
  it("consumes a sequence for a rejected draft, leaving a gap that is counted and incident-observable", async () => {
    const incidents: string[] = [];
    const { transport, dispatcher } = build({
      onIncident: (incident) => incidents.push(incident.reasonCode),
    });
    const badDraft: EnvelopeDraft = { ...validDraft, payload: { nonsense: true } };

    // Sequence 1 is assigned to the bad draft and never published; the
    // incident opened for it takes sequence 2; the good drafts take 3 and 4.
    await dispatcher.dispatch(badDraft);
    await dispatcher.dispatch(validDraft);
    await dispatcher.dispatch(validDraft);

    const sequences = transport.published("market").map((envelope) => envelope.ingestSeq);
    expect(sequences).not.toContain("1");
    // NOT contiguous — and that is the documented, correct outcome, because
    // raw WAL frames draw from this same counter.
    expect(sequences).toEqual(["2", "3", "4"]);
    // STRICTLY INCREASING — the guarantee the transport actually needs.
    for (let index = 1; index < sequences.length; index += 1) {
      expect(BigInt(sequences[index] ?? "0") > BigInt(sequences[index - 1] ?? "0")).toBe(true);
    }
    // The hole is never silent.
    expect(dispatcher.metrics().envelopeRejections).toBe(1);
    expect(incidents).toEqual(["GATEWAY_ENVELOPE_REJECTED"]);
  });

  it("openIncident dispatches a valid internal DataQualityIncidentOpened envelope", async () => {
    const { transport, publisher, dispatcher } = build();
    dispatcher.openIncident({
      scope: "wal",
      reasonCode: "GATEWAY_WAL_WRITE_FAULT",
      severity: "PAGE",
      detail: "fsync failed",
    });
    await publisher.settle();
    const published = transport.published("market");
    expect(published).toHaveLength(1);
    expect(published[0]?.source).toBe("internal");
    const payload = published[0]?.payload as { reasonCode: string; severity: string };
    expect(payload.reasonCode).toBe("GATEWAY_WAL_WRITE_FAULT");
    expect(payload.severity).toBe("PAGE");
  });
});

// `C1-HALTS` (DQ-CLOSE): until then no producer published a close, so a
// consumer's active incident set only ever grew.
describe("GatewayDispatcher.markIncidentClosed publishes the close of an OPEN incident", () => {
  it("closing an open key publishes DataQualityIncidentClosed naming that incident; a repeat close publishes nothing", async () => {
    const { clock, transport, publisher, dispatcher } = build();
    dispatcher.openIncident({
      scope: "polymarket-lifecycle:m-1",
      reasonCode: "GATEWAY_LIFECYCLE_POLL_FAILED",
      severity: "NOTIFY",
      detail: "HTTP 503",
      feedId: "polymarket-lifecycle",
    });
    await publisher.settle();
    const opened = transport.published("market")[0];
    const incidentId = (opened?.payload as { incidentId: string }).incidentId;
    clock.advance(1_500);
    dispatcher.markIncidentClosed("polymarket-lifecycle:m-1", "GATEWAY_LIFECYCLE_POLL_FAILED");
    dispatcher.markIncidentClosed("polymarket-lifecycle:m-1", "GATEWAY_LIFECYCLE_POLL_FAILED");
    await publisher.settle();
    const published = transport.published("market");
    expect(published.map((envelope) => envelope.eventType)).toEqual(["DataQualityIncidentOpened", "DataQualityIncidentClosed"]);
    expect(published[1]?.source).toBe("internal");
    expect(published[1]?.payload).toEqual({
      incidentId,
      closedAt: new Date(clock.nowMs()).toISOString(),
      resolutionCode: "GATEWAY_CONDITION_CLEARED",
      detail: "the GATEWAY_LIFECYCLE_POLL_FAILED condition for polymarket-lifecycle:m-1 cleared",
    });
    // A recurrence opens a FRESH incident, with a new id.
    dispatcher.openIncident({ scope: "polymarket-lifecycle:m-1", reasonCode: "GATEWAY_LIFECYCLE_POLL_FAILED", severity: "NOTIFY", detail: "again" });
    await publisher.settle();
    expect((transport.published("market")[2]?.payload as { incidentId: string }).incidentId).not.toBe(incidentId);
  });

  it("closing a key that was never opened, or is already closed, publishes nothing", async () => {
    const { transport, publisher, dispatcher } = build();
    dispatcher.markIncidentClosed("binance-reference", "GATEWAY_FEED_STALL");
    await publisher.settle();
    expect(transport.published("market")).toEqual([]);
  });
});

// `THROUGHPUT-1c` r6 (R6-H1): a frame's loss is published BEFORE the frame.
describe("GatewayDispatcher.dispatchFrame", () => {
  const badDraft: EnvelopeDraft = { ...validDraft, payload: { nonsense: true } };
  const draftNumbered = (stalenessMs: number): EnvelopeDraft => ({
    ...validDraft,
    payload: { ...(validDraft.payload as Record<string, unknown>), stalenessMs },
  });
  const receiptAt = (offsetMs: number) => {
    const nowMs = Date.parse("2026-08-30T12:00:00.000Z") + offsetMs;
    return {
      receivedAt: new Date(nowMs).toISOString(),
      receivedMonotonicNs: String(BigInt(nowMs) * 1_000_000n),
      nowMs,
    };
  };

  it("an all-valid frame publishes exactly what one dispatch per event publishes", async () => {
    const entries = [1, 2, 3].map((index) => ({
      draft: draftNumbered(index),
      context: { receipt: receiptAt(index), rawFrameIngestSeq: "7" },
    }));
    const perEvent = build();
    for (const entry of entries) void perEvent.dispatcher.dispatch(entry.draft, entry.context);
    const whole = build();
    const outcomes = await Promise.all(whole.dispatcher.dispatchFrame(entries));
    await perEvent.publisher.settle();
    await whole.publisher.settle();
    expect(outcomes.map((outcome) => outcome.published)).toEqual([true, true, true]);
    expect(whole.transport.published("market")).toEqual(perEvent.transport.published("market"));
    expect(whole.transport.published("market").map((envelope) => envelope.ingestSeq)).toEqual(["1", "2", "3"]);
    expect(whole.dispatcher.metrics()).toEqual(perEvent.dispatcher.metrics());
  });

  it("a refused event is reported BEFORE every accepted event of its frame, at the frame's first receipt", async () => {
    const rejections: string[] = [];
    const incidents: string[] = [];
    const { transport, publisher, dispatcher } = build({
      onEnvelopeRejected: (rejection) => rejections.push(rejection.detail),
      onIncident: (incident) => incidents.push(incident.reasonCode),
    });
    const first = receiptAt(0);
    const third = receiptAt(2);
    const outcomes = await Promise.all(
      dispatcher.dispatchFrame([
        { draft: draftNumbered(1), context: { receipt: first, rawFrameIngestSeq: "7" } },
        { draft: badDraft, context: { receipt: receiptAt(1), rawFrameIngestSeq: "7" } },
        { draft: draftNumbered(3), context: { receipt: third, rawFrameIngestSeq: "7" } },
      ]),
    );
    await publisher.settle();
    expect(outcomes.map((outcome) => outcome.published)).toEqual([true, false, true]);

    const published = transport.published("market");
    expect(published.map((envelope) => envelope.eventType)).toEqual([
      "DataQualityIncidentOpened",
      "FeedStale",
      "FeedStale",
    ]);
    // The first pass's sequences 1-3 are holes; the incident takes 4, the
    // accepted events 5 and 6: strictly increasing, the incident first.
    expect(published.map((envelope) => envelope.ingestSeq)).toEqual(["4", "5", "6"]);
    // The incident is stamped with the frame's first receipt, so receipt
    // instants never run backwards; each accepted event keeps its own.
    expect(published[0]?.receivedAt).toBe(first.receivedAt);
    expect(published[0]?.receivedMonotonicNs).toBe(first.receivedMonotonicNs);
    expect(published.slice(1).map((envelope) => envelope.receivedAt)).toEqual([
      first.receivedAt,
      third.receivedAt,
    ]);
    // The accepted events keep their raw-frame causation; the incident has none.
    expect(published[0]?.causationId).toBeUndefined();
    expect(published[1]?.causationId).toBe(`raw:${EPOCH}:7`);
    expect(published[2]?.causationId).toBe(`raw:${EPOCH}:7`);
    expect(new Set(published.map((envelope) => envelope.eventId)).size).toBe(3);
    const payload = published[0]?.payload as { reasonCode: string; detail: string; affectedMarketIds?: unknown };
    expect(payload.reasonCode).toBe("GATEWAY_ENVELOPE_REJECTED");
    expect(payload.affectedMarketIds).toBeUndefined();
    expect(payload.detail).toContain("1 of a frame's 3 events");
    expect(rejections).toHaveLength(1);
    expect(incidents).toEqual(["GATEWAY_ENVELOPE_REJECTED"]);
    expect(dispatcher.metrics()).toEqual({ dispatched: 3, envelopeRejections: 1 });
  });

  it("a later frame's loss inside the same epoch opens no second incident; its accepted events still publish", async () => {
    const incidents: string[] = [];
    const { transport, publisher, dispatcher } = build({
      onIncident: (incident) => incidents.push(incident.reasonCode),
    });
    void dispatcher.dispatchFrame([{ draft: draftNumbered(1) }, { draft: badDraft }]);
    void dispatcher.dispatchFrame([{ draft: draftNumbered(2) }, { draft: badDraft }]);
    await publisher.settle();
    expect(incidents).toEqual(["GATEWAY_ENVELOPE_REJECTED"]);
    expect(transport.published("market").map((envelope) => envelope.eventType)).toEqual([
      "DataQualityIncidentOpened",
      "FeedStale",
      "FeedStale",
    ]);
    expect(dispatcher.metrics().envelopeRejections).toBe(2);
  });

  it("an empty frame publishes nothing", async () => {
    const { transport, publisher, dispatcher } = build();
    expect(dispatcher.dispatchFrame([])).toEqual([]);
    await publisher.settle();
    expect(transport.published("market")).toHaveLength(0);
  });
});

// `THROUGHPUT-1c` r7 (R7-H1): a frame the publisher cannot submit in ONE
// transport call is preceded by a `GATEWAY_FRAME_SPLIT` incident naming no
// market, so an outage between its calls cannot leave a prefix vouching for
// a stale book (ADR-023 D2.4).
describe("GatewayDispatcher.dispatchFrame — a frame too large for one transport call", () => {
  const draftNumbered = (stalenessMs: number): EnvelopeDraft => ({
    ...validDraft,
    payload: { ...(validDraft.payload as Record<string, unknown>), stalenessMs },
  });
  const receiptAt = (offsetMs: number) => {
    const nowMs = Date.parse("2026-08-30T12:00:00.000Z") + offsetMs;
    return {
      receivedAt: new Date(nowMs).toISOString(),
      receivedMonotonicNs: String(BigInt(nowMs) * 1_000_000n),
      nowMs,
    };
  };
  const frameOf = (count: number, rawFrameIngestSeq: string) =>
    Array.from({ length: count }, (_, index) => ({
      draft: draftNumbered(index + 1),
      context: { receipt: receiptAt(index), rawFrameIngestSeq },
    }));

  function buildWith(
    transport: MarketEventTransport,
    observer: ConstructorParameters<typeof GatewayDispatcher>[0]["observer"] = {},
  ) {
    const clock = new ManualGatewayClock();
    const publisher = new GatewayPublisher({
      transport,
      stream: "market",
      clock,
      maxQueueDepth: 8_192,
      maxQueueBytes: 64 * 1024 * 1024,
    });
    const dispatcher = new GatewayDispatcher({
      clock,
      ids: deterministicIdSource(),
      sequencer: new IngestSequencer(EPOCH),
      publisher,
      incidents: new IncidentRegistry(),
      observer,
    });
    return { publisher, dispatcher };
  }

  const reasonOf = (envelope: EventEnvelope<unknown> | undefined): unknown =>
    (envelope?.payload as { reasonCode?: unknown } | undefined)?.reasonCode;

  it("a frame of one more than the publisher's limit: GATEWAY_FRAME_SPLIT is published FIRST, at the frame's first receipt", async () => {
    const transport = new MemoryEventTransport();
    const incidents: string[] = [];
    const { publisher, dispatcher } = buildWith(transport, {
      onIncident: (incident) => incidents.push(`${incident.severity} ${incident.reasonCode}`),
    });
    const limit = publisher.atomicFrameEnvelopes;
    const entries = frameOf(limit + 1, "7");
    const outcomes = await Promise.all(dispatcher.dispatchFrame(entries));
    await publisher.settle();
    expect(outcomes.every((outcome) => outcome.published)).toBe(true);

    const published = transport.published("market");
    expect(published).toHaveLength(limit + 2);
    const [incident, ...frame] = published as [EventEnvelope<unknown>, ...EventEnvelope<unknown>[]];
    expect(incident.eventType).toBe("DataQualityIncidentOpened");
    expect(reasonOf(incident)).toBe("GATEWAY_FRAME_SPLIT");
    const payload = incident.payload as { severity?: unknown; affectedMarketIds?: unknown; detail?: unknown };
    expect(payload.severity).toBe("LOG");
    expect(payload.affectedMarketIds).toBeUndefined();
    expect(String(payload.detail)).toContain(`a frame of ${String(limit + 1)} events`);
    expect(incident.causationId).toBeUndefined();
    // Sequenced ahead of every event of the frame, receipt instants never backwards.
    expect(incident.ingestSeq).toBe("1");
    expect(frame.map((envelope) => envelope.ingestSeq)).toEqual(
      Array.from({ length: limit + 1 }, (_, index) => String(index + 2)),
    );
    expect(incident.receivedAt).toBe(entries[0]?.context.receipt.receivedAt);
    expect(frame.every((envelope) => envelope.causationId === `raw:${EPOCH}:7`)).toBe(true);
    expect(incidents).toEqual(["LOG GATEWAY_FRAME_SPLIT"]);
  });

  it("a frame of exactly the limit opens nothing and publishes exactly what one dispatch per event publishes", async () => {
    const wholeTransport = new MemoryEventTransport();
    const perEventTransport = new MemoryEventTransport();
    const a = buildWith(wholeTransport);
    const b = buildWith(perEventTransport);
    const entries = frameOf(a.publisher.atomicFrameEnvelopes, "7");
    await Promise.all(a.dispatcher.dispatchFrame(entries));
    await Promise.all(entries.map((entry) => b.dispatcher.dispatch(entry.draft, entry.context)));
    await a.publisher.settle();
    await b.publisher.settle();
    expect(wholeTransport.published("market").some((envelope) => envelope.eventType === "DataQualityIncidentOpened")).toBe(false);
    expect(wholeTransport.published("market")).toEqual(perEventTransport.published("market"));
  });

  it("EVERY frame over the limit gets its own incident, so a consumer that joined late still meets one ahead of the frame", async () => {
    const transport = new MemoryEventTransport();
    const { publisher, dispatcher } = buildWith(transport);
    const limit = publisher.atomicFrameEnvelopes;
    void dispatcher.dispatchFrame(frameOf(limit + 1, "7"));
    void dispatcher.dispatchFrame(frameOf(limit + 1, "9000"));
    await publisher.settle();
    const published = transport.published("market");
    const incidentAt = published
      .map((envelope, index) => (reasonOf(envelope) === "GATEWAY_FRAME_SPLIT" ? index : -1))
      .filter((index) => index >= 0);
    expect(incidentAt).toEqual([0, limit + 2]);
    const ids = incidentAt.map((index) => (published[index]?.payload as { incidentId?: unknown }).incidentId);
    expect(new Set(ids).size).toBe(2);
    expect(published[limit + 3]?.causationId).toBe(`raw:${EPOCH}:9000`);
  });

  it("publication already halted: nothing of the frame can be published, so no incident is opened", async () => {
    const transport = new MemoryEventTransport();
    const incidents: string[] = [];
    const { publisher, dispatcher } = buildWith(transport, {
      onIncident: (incident) => incidents.push(incident.reasonCode),
    });
    publisher.haltPublication("EVENT_BUS_UNAVAILABLE", "test outage");
    const outcomes = await Promise.all(dispatcher.dispatchFrame(frameOf(publisher.atomicFrameEnvelopes + 1, "7")));
    expect(outcomes.some((outcome) => outcome.published)).toBe(false);
    expect(incidents).toEqual([]);
    expect(transport.published("market")).toHaveLength(0);
  });

  it("without the batch capability the limit is 1: a frame of two is preceded by the incident, a frame of one is not", async () => {
    const memory = new MemoryEventTransport();
    const perEnvelope: MarketEventTransport = {
      transportId: memory.transportId,
      retention: memory.retention,
      publish: (stream, envelope) => memory.publish(stream, envelope),
      subscribe: (options) => memory.subscribe(options),
      streamMetrics: (stream) => memory.streamMetrics(stream),
      close: () => memory.close(),
    };
    const { publisher, dispatcher } = buildWith(perEnvelope);
    expect(publisher.atomicFrameEnvelopes).toBe(1);
    void dispatcher.dispatchFrame(frameOf(1, "7"));
    void dispatcher.dispatchFrame(frameOf(2, "8"));
    await publisher.settle();
    expect(memory.published("market").map((envelope) => reasonOf(envelope) ?? envelope.causationId)).toEqual([
      `raw:${EPOCH}:7`,
      "GATEWAY_FRAME_SPLIT",
      `raw:${EPOCH}:8`,
      `raw:${EPOCH}:8`,
    ]);
  });

  it("a frame over the limit that also loses an event: both incidents precede its accepted events", async () => {
    const transport = new MemoryEventTransport();
    const { publisher, dispatcher } = buildWith(transport);
    const limit = publisher.atomicFrameEnvelopes;
    const entries = [
      ...frameOf(limit + 1, "7"),
      { draft: { ...validDraft, payload: { nonsense: true } }, context: { receipt: receiptAt(5_000), rawFrameIngestSeq: "7" } },
    ];
    void dispatcher.dispatchFrame(entries);
    await publisher.settle();
    const published = transport.published("market");
    expect(published.slice(0, 2).map(reasonOf)).toEqual(["GATEWAY_FRAME_SPLIT", "GATEWAY_ENVELOPE_REJECTED"]);
    expect(published.slice(2)).toHaveLength(limit + 1);
    expect(published.slice(2).every((envelope) => envelope.causationId === `raw:${EPOCH}:7`)).toBe(true);
  });
});
