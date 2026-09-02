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
