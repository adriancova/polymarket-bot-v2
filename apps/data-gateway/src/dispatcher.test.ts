import { describe, expect, it } from "vitest";

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
