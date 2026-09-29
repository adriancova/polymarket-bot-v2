import { describe, expect, expectTypeOf, it } from "vitest";

import type { EventEnvelope } from "@polymarket-bot/domain";
import type { MarketEventTransport, RedisStreamsEventTransport } from "@polymarket-bot/event-bus";

import { GatewayPublisher } from "./publisher.js";
import type { BatchPublishCapability, PublicationHalt, PublishOutcome } from "./publisher.js";
import { ManualGatewayClock } from "./testing/index.js";
import { MemoryEventTransport } from "./testing/memory-transport.js";

const EPOCH = "00000000-0000-4000-8000-000000000001";

function envelopeAt(ingestSeq: string): EventEnvelope<unknown> {
  return {
    eventId: "01900000-0000-7000-8000-000000000001",
    eventType: "FeedStale",
    schemaVersion: 1,
    source: "binance",
    sourceChannel: "binance:stream-connection",
    receivedAt: "2026-08-30T12:00:00.000Z",
    receivedMonotonicNs: "1",
    gatewayEpoch: EPOCH,
    ingestSeq,
    payload: {
      feedId: "binance-reference",
      detectedAt: "2026-08-30T12:00:00.000Z",
      stalenessMs: 45_000,
    },
  };
}

function build(
  options: {
    maxQueueDepth?: number;
    maxQueueBytes?: number;
    maxBatchEnvelopes?: number;
    maxBatchBytes?: number;
    onPublicationHalted?: (halt: PublicationHalt) => void;
    onDuplicateRefused?: (identity: { gatewayEpoch: string; ingestSeq: string }) => void;
    onPublishRejected?: (rejection: { ingestSeq: string; detail: string }) => void;
  } = {},
) {
  const clock = new ManualGatewayClock();
  const transport = new MemoryEventTransport();
  const publisher = new GatewayPublisher({
    transport,
    stream: "market",
    clock,
    ...options,
  });
  return { clock, transport, publisher };
}

describe("GatewayPublisher", () => {
  it("publishes in submission order and reports receipts", async () => {
    const { transport, publisher } = build();
    const outcomes = await Promise.all([
      publisher.enqueue(envelopeAt("1")),
      publisher.enqueue(envelopeAt("2")),
      publisher.enqueue(envelopeAt("3")),
    ]);
    expect(outcomes.every((outcome) => outcome.published)).toBe(true);
    expect(transport.published("market").map((envelope) => envelope.ingestSeq)).toEqual([
      "1",
      "2",
      "3",
    ]);
  });

  // Obligation 1: (gatewayEpoch, ingestSeq) is the dedup identity — a repeated
  // identity must not double-publish, and the refusal is observable.
  it("refuses to publish the same (gatewayEpoch, ingestSeq) twice, with a counter", async () => {
    const refused: string[] = [];
    const { transport, publisher } = build({
      onDuplicateRefused: (identity) => refused.push(identity.ingestSeq),
    });
    await publisher.enqueue(envelopeAt("1"));
    await publisher.enqueue(envelopeAt("2"));
    const duplicate = await publisher.enqueue(envelopeAt("2"));
    expect(duplicate.published).toBe(false);
    if (duplicate.published) return;
    expect(duplicate.reason).toBe("duplicate-identity");
    expect(refused).toEqual(["2"]);
    expect(transport.published("market")).toHaveLength(2);
    expect(publisher.metrics().duplicatesRefused).toBe(1);
  });

  // Obligation 6 / acceptance 4 shape: EVENT_BUS_PUBLISH_QUEUE_FULL is a HALT
  // signal, not a drop signal — publication stops loudly.
  it("halts terminally on EVENT_BUS_PUBLISH_QUEUE_FULL with an observable halt", async () => {
    const halts: PublicationHalt[] = [];
    const { transport, publisher } = build({
      onPublicationHalted: (halt) => halts.push(halt),
    });
    await publisher.enqueue(envelopeAt("1"));
    transport.failNextPublishWithQueueFull();
    const failed = await publisher.enqueue(envelopeAt("2"));
    expect(failed.published).toBe(false);
    expect(publisher.halted).toBe(true);
    expect(halts).toHaveLength(1);
    expect(halts[0]?.cause).toBe("EVENT_BUS_PUBLISH_QUEUE_FULL");
    expect(halts[0]?.haltedAtIngestSeq).toBe("2");

    // The halt is terminal for the epoch: later events are suppressed with a
    // counter, never quietly retried into a stream with a silent gap.
    const suppressed = await publisher.enqueue(envelopeAt("3"));
    expect(suppressed.published).toBe(false);
    if (suppressed.published) return;
    expect(suppressed.reason).toBe("publication-halted");
    expect(publisher.metrics().suppressedWhileHalted).toBe(2);
    expect(transport.published("market")).toHaveLength(1);
  });

  it("halts terminally on EVENT_BUS_UNAVAILABLE and never rejects the caller's promise", async () => {
    const { transport, publisher } = build();
    transport.setUnavailable(true);
    const outcome = await publisher.enqueue(envelopeAt("1"));
    expect(outcome.published).toBe(false);
    if (outcome.published) return;
    expect(outcome.reason).toBe("transport-unavailable");
    expect(publisher.halted).toBe(true);
    expect(publisher.metrics().halt?.cause).toBe("EVENT_BUS_UNAVAILABLE");

    // Restoring the transport does NOT resume publication mid-epoch: events
    // assigned during the outage were never in the stream, and a mid-epoch
    // resume would hand consumers a gap the transport cannot detect.
    transport.setUnavailable(false);
    const after = await publisher.enqueue(envelopeAt("2"));
    expect(after.published).toBe(false);
    expect(transport.published("market")).toHaveLength(0);
  });

  it("halts terminally when asked to, with no submission attempted (startup outage)", async () => {
    const halts: PublicationHalt[] = [];
    const { transport, publisher } = build({
      onPublicationHalted: (halt) => halts.push(halt),
    });
    publisher.haltPublication("EVENT_BUS_UNAVAILABLE", "the transport was unreachable at startup");
    expect(publisher.halted).toBe(true);
    expect(halts).toHaveLength(1);
    expect(halts[0]?.haltedAtIngestSeq).toBe("0");
    const outcome = await publisher.enqueue(envelopeAt("1"));
    expect(outcome.published).toBe(false);
    expect(transport.publishCalls).toBe(0);
    // Halting twice does not re-notify: the first halt is the story.
    publisher.haltPublication("EVENT_BUS_UNAVAILABLE", "again");
    expect(halts).toHaveLength(1);
  });
});

/**
 * ROUND-1 REVIEW FINDING H3 — a non-outage rejection used to lose an event.
 *
 * The round-1 publisher halted only on `EventBusUnavailableError`; every other
 * transport refusal incremented a counter and publication carried on. The
 * probe: seq 1 refused, seq 2 published, `halted === false` — a stream with an
 * undetectable hole, which is exactly what the terminal halt exists to
 * prevent. A round-1 unit test PINNED that behaviour ("counts a non-outage
 * transport rejection without halting"); it was wrong and is replaced.
 */
describe("GatewayPublisher — every unsuccessful submission halts (H3)", () => {
  it("halts on a non-outage transport rejection and publishes no later identity", async () => {
    const rejections: string[] = [];
    const halts: PublicationHalt[] = [];
    const { transport, publisher } = build({
      onPublishRejected: (rejection) => rejections.push(rejection.ingestSeq),
      onPublicationHalted: (halt) => halts.push(halt),
    });
    // Sabotage the envelope so the transport's schema validation refuses it —
    // an ordinary rejection, not an outage.
    const bad = { ...envelopeAt("1"), receivedAt: "not-a-timestamp" };
    const outcome = await publisher.enqueue(bad);
    expect(outcome.published).toBe(false);
    if (outcome.published) return;
    expect(outcome.reason).toBe("transport-rejected");
    expect(rejections).toEqual(["1"]);

    // THE FIX: publication is halted, loudly, with its own cause.
    expect(publisher.halted).toBe(true);
    expect(halts).toHaveLength(1);
    expect(halts[0]?.cause).toBe("GATEWAY_PUBLISH_REJECTED");
    expect(halts[0]?.haltedAtIngestSeq).toBe("1");

    // And no LATER identity reaches the stream behind the hole.
    const later = await publisher.enqueue(envelopeAt("2"));
    expect(later.published).toBe(false);
    if (later.published) return;
    expect(later.reason).toBe("publication-halted");
    expect(transport.published("market")).toEqual([]);
    expect(publisher.metrics().rejectedByTransport).toBe(1);
  });

  it("suppresses an already-admitted entry rather than publishing it after a halt", async () => {
    const { transport, publisher } = build();
    transport.stallPublishes();
    const first = publisher.enqueue({ ...envelopeAt("1"), receivedAt: "not-a-timestamp" });
    const second = publisher.enqueue(envelopeAt("2"));
    const third = publisher.enqueue(envelopeAt("3"));
    transport.resumePublishes();
    const outcomes = await Promise.all([first, second, third]);

    expect(outcomes.map((outcome) => outcome.published)).toEqual([false, false, false]);
    // Exactly one boundary in the stream: nothing published after the halt.
    expect(transport.published("market")).toEqual([]);
    expect(publisher.metrics().halt?.cause).toBe("GATEWAY_PUBLISH_REJECTED");
  });
});

/**
 * ROUND-1 REVIEW FINDING H2 — the admission queue is bounded, synchronously.
 *
 * The round-1 Promise chain was an unbounded hidden queue: one stalled
 * `transport.publish()` admitted 999 further envelopes with
 * `transportPublishCalls === 1`, `halted === false`, and no metric that could
 * show it. These tests hold a publish open and assert the bound refuses,
 * halts, and reports depth, bytes, and age.
 */
describe("GatewayPublisher — bounded admission (H2)", () => {
  it("refuses admission and halts once the depth bound is reached behind a stalled publish", async () => {
    const halts: PublicationHalt[] = [];
    const { clock, transport, publisher } = build({
      maxQueueDepth: 4,
      onPublicationHalted: (halt) => halts.push(halt),
    });
    transport.stallPublishes();

    // The first envelope is dequeued immediately and left in flight; the next
    // four fill the queue exactly.
    const outcomes: Promise<unknown>[] = [];
    for (let index = 1; index <= 5; index += 1) {
      outcomes.push(publisher.enqueue(envelopeAt(String(index))));
    }
    expect(transport.publishCalls).toBe(1);
    expect(publisher.queueDepth).toBe(4);
    expect(publisher.metrics().queueMaxDepthObserved).toBe(4);
    expect(publisher.halted).toBe(false);

    // The oldest entry's age is real, and it is measured off the injected clock.
    clock.advance(250);
    expect(publisher.metrics().oldestQueuedAgeMs).toBe(250);

    // One more crosses the bound. It is refused LOUDLY and terminally.
    const refused = await publisher.enqueue(envelopeAt("6"));
    expect(refused.published).toBe(false);
    if (refused.published) return;
    expect(refused.reason).toBe("admission-queue-full");
    expect(refused.detail).toContain("admission queue is full");
    expect(publisher.halted).toBe(true);
    expect(halts).toHaveLength(1);
    expect(halts[0]?.cause).toBe("GATEWAY_PUBLISH_ADMISSION_OVERFLOW");
    expect(publisher.metrics().admissionRefusals).toBe(1);

    // Nothing beyond the bound was ever admitted: this is the number the
    // round-1 probe found at 999.
    const admittedBeyondTheStall = publisher.metrics().queueMaxDepthObserved;
    expect(admittedBeyondTheStall).toBe(4);

    transport.resumePublishes();
    await Promise.all(outcomes);
    await publisher.settle();
    // The halt is total for everything still QUEUED. The one submission
    // already handed to the transport cannot be unsent, so the stream ends at
    // exactly that identity and nothing follows it.
    expect(transport.published("market").map((envelope) => envelope.ingestSeq)).toEqual(["1"]);
    expect(publisher.metrics().suppressedWhileHalted).toBe(4);
  });

  it("refuses admission on the BYTE bound even when the depth bound is far away", async () => {
    const oneEnvelopeBytes = JSON.stringify(envelopeAt("1")).length;
    const { transport, publisher } = build({
      maxQueueDepth: 1_000,
      // Room for exactly one queued envelope behind the one in flight.
      maxQueueBytes: oneEnvelopeBytes + 10,
    });
    transport.stallPublishes();
    // The first is dequeued into the stalled publish, so it leaves the queue.
    const first = publisher.enqueue(envelopeAt("1"));
    expect(transport.publishCalls).toBe(1);
    const second = publisher.enqueue(envelopeAt("2"));
    expect(publisher.queueDepth).toBe(1);

    const refused = await publisher.enqueue(envelopeAt("3"));
    expect(refused.published).toBe(false);
    if (refused.published) return;
    expect(refused.reason).toBe("admission-queue-full");
    expect(refused.detail).toContain("bytes");
    // Depth was nowhere near its bound: the BYTE bound is what refused.
    expect(publisher.metrics().queueMaxDepthObserved).toBeLessThan(1_000);
    expect(publisher.metrics().halt?.cause).toBe("GATEWAY_PUBLISH_ADMISSION_OVERFLOW");
    transport.resumePublishes();
    await Promise.all([first, second]);
    await publisher.settle();
  });

  it("reports queue depth, bytes, and configured bounds while draining normally", async () => {
    const { transport, publisher } = build({ maxQueueDepth: 8, maxQueueBytes: 65_536 });
    transport.stallPublishes();
    const pending = [
      publisher.enqueue(envelopeAt("1")),
      publisher.enqueue(envelopeAt("2")),
      publisher.enqueue(envelopeAt("3")),
    ];
    const busy = publisher.metrics();
    expect(busy.queueDepth).toBe(2);
    expect(busy.queueBytes).toBeGreaterThan(0);
    expect(busy.queueMaxDepth).toBe(8);
    expect(busy.queueMaxBytes).toBe(65_536);
    expect(busy.queueMaxBytesObserved).toBe(busy.queueBytes);

    transport.resumePublishes();
    await Promise.all(pending);
    await publisher.settle();

    const idle = publisher.metrics();
    expect(idle.queueDepth).toBe(0);
    expect(idle.queueBytes).toBe(0);
    expect(idle.oldestQueuedAgeMs).toBe(0);
    expect(idle.published).toBe(3);
    // The high-water marks are retained: they are what a dashboard alerts on.
    expect(idle.queueMaxDepthObserved).toBe(2);
  });
});

/**
 * `THROUGHPUT-1b` — batched submission.
 *
 * The pump submits the consecutive run at the head of the queue in one call
 * when the transport offers `publishBatch`. These tests hold a submission
 * open with the memory double's stall gate so a run really accumulates, and
 * assert that batching changes the number of transport calls and NOTHING
 * about what is published, in what order, or when publication halts.
 */
describe("GatewayPublisher — batched submission (THROUGHPUT-1b)", () => {
  function accumulate(
    publisher: GatewayPublisher,
    transport: MemoryEventTransport,
    envelopes: readonly EventEnvelope<unknown>[],
  ): Promise<PublishOutcome[]> {
    // The first envelope is submitted alone and held; the rest queue behind it.
    transport.stallPublishes();
    const outcomes = envelopes.map((envelope) => publisher.enqueue(envelope));
    transport.resumePublishes();
    return Promise.all(outcomes);
  }

  it("submits the queued run in one call, in admission order, and publishes the same envelopes", async () => {
    const { transport, publisher } = build();
    const envelopes = ["1", "2", "3", "4", "5", "6"].map(envelopeAt);
    const outcomes = await accumulate(publisher, transport, envelopes);

    expect(outcomes.map((outcome) => outcome.published)).toEqual([true, true, true, true, true, true]);
    expect(outcomes.map((outcome) => (outcome.published ? outcome.sequence : 0))).toEqual([1, 2, 3, 4, 5, 6]);
    expect(transport.published("market").map((envelope) => envelope.ingestSeq)).toEqual([
      "1", "2", "3", "4", "5", "6",
    ]);
    // Two calls: the held first envelope, then the run of five behind it.
    expect(transport.batchCalls).toBe(2);
    const metrics = publisher.metrics();
    expect(metrics.submissions).toBe(2);
    expect(metrics.largestSubmission).toBe(5);
    expect(metrics.published).toBe(6);
    expect(metrics.inFlight).toBe(0);
  });

  it("bounds a run by envelopes and by bytes; a single oversized envelope still goes alone", async () => {
    const oneEnvelopeBytes = JSON.stringify(envelopeAt("1")).length;
    const byCount = build({ maxBatchEnvelopes: 2 });
    await accumulate(byCount.publisher, byCount.transport, ["1", "2", "3", "4", "5"].map(envelopeAt));
    // [1], then [2,3], [4,5].
    expect(byCount.transport.batchCalls).toBe(3);
    expect(byCount.publisher.metrics().largestSubmission).toBe(2);

    const byBytes = build({ maxBatchBytes: oneEnvelopeBytes * 2 + 1 });
    await accumulate(byBytes.publisher, byBytes.transport, ["1", "2", "3", "4", "5"].map(envelopeAt));
    expect(byBytes.publisher.metrics().largestSubmission).toBe(2);

    const tiny = build({ maxBatchBytes: 1 });
    await accumulate(tiny.publisher, tiny.transport, ["1", "2", "3"].map(envelopeAt));
    expect(tiny.publisher.metrics().largestSubmission).toBe(1);
    expect(tiny.transport.published("market")).toHaveLength(3);
  });

  it("reports the held run as in flight, not as queued: the depth gauge still means admitted-and-not-submitted", async () => {
    const { transport, publisher } = build();
    transport.stallPublishes();
    const first = publisher.enqueue(envelopeAt("1"));
    const rest = ["2", "3", "4"].map((seq) => publisher.enqueue(envelopeAt(seq)));
    expect(publisher.metrics()).toMatchObject({ queueDepth: 3, inFlight: 1 });
    transport.resumePublishes();
    await first;
    // The run of three is now the submission in flight (the stall is over, so
    // it settles on the next turns).
    await Promise.all(rest);
    await publisher.settle();
    expect(publisher.metrics()).toMatchObject({ queueDepth: 0, inFlight: 0, published: 4 });
  });

  it("an envelope refused INSIDE a run: the prefix publishes, the refusal halts, NOTHING after it is published", async () => {
    const halts: PublicationHalt[] = [];
    const rejections: string[] = [];
    const { transport, publisher } = build({
      onPublicationHalted: (halt) => halts.push(halt),
      onPublishRejected: (rejection) => rejections.push(rejection.ingestSeq),
    });
    const envelopes = ["1", "2", "3", "4", "5", "6"].map(envelopeAt);
    envelopes[3] = { ...envelopeAt("4"), receivedAt: "not-a-timestamp" };
    const outcomes = await accumulate(publisher, transport, envelopes);

    // Non-vacuous: the refused envelope really was inside a multi-envelope run.
    expect(publisher.metrics().largestSubmission).toBe(5);
    expect(outcomes.map((outcome) => (outcome.published ? "published" : outcome.reason))).toEqual([
      "published",
      "published",
      "published",
      "transport-rejected",
      "publication-halted",
      "publication-halted",
    ]);
    expect(transport.published("market").map((envelope) => envelope.ingestSeq)).toEqual(["1", "2", "3"]);
    expect(halts).toHaveLength(1);
    expect(halts[0]).toMatchObject({ cause: "GATEWAY_PUBLISH_REJECTED", haltedAtIngestSeq: "4" });
    expect(rejections).toEqual(["4"]);
    expect(publisher.metrics()).toMatchObject({
      published: 3,
      rejectedByTransport: 1,
      suppressedWhileHalted: 2,
      halted: true,
    });
    // And nothing later publishes: the halt is terminal.
    const later = await publisher.enqueue(envelopeAt("7"));
    expect(later.published).toBe(false);
    expect(transport.published("market")).toHaveLength(3);
  });

  it("an outage striking a run publishes none of it: the halt is at its first envelope", async () => {
    const halts: PublicationHalt[] = [];
    const { transport, publisher } = build({ onPublicationHalted: (halt) => halts.push(halt) });
    transport.stallPublishes();
    const outcomes = ["1", "2", "3", "4"].map((seq) => publisher.enqueue(envelopeAt(seq)));
    transport.resumePublishes();
    await outcomes[0];
    // The run [2,3,4] is next; the transport goes away before it is submitted.
    transport.setUnavailable(true);
    const settled = await Promise.all(outcomes);
    expect(settled.map((outcome) => (outcome.published ? "published" : outcome.reason))).toEqual([
      "published",
      "transport-unavailable",
      "publication-halted",
      "publication-halted",
    ]);
    expect(halts[0]).toMatchObject({ cause: "EVENT_BUS_UNAVAILABLE", haltedAtIngestSeq: "2" });
    expect(transport.published("market").map((envelope) => envelope.ingestSeq)).toEqual(["1"]);
    // Every one of the run is accounted for; none counted as published.
    expect(publisher.metrics()).toMatchObject({ published: 1, suppressedWhileHalted: 3 });
  });

  it("a transport whose result does not account for every envelope halts at the first unaccounted one", async () => {
    const memory = new MemoryEventTransport();
    const halts: PublicationHalt[] = [];
    let held: (() => void) | undefined;
    // Claims success for a run but hands back fewer receipts than envelopes.
    const lying = Object.assign(Object.create(memory) as MemoryEventTransport, {
      publishBatch: async (stream: string, envelopes: readonly EventEnvelope<unknown>[]) => {
        if (held === undefined) {
          await new Promise<void>((resolve) => {
            held = resolve;
          });
        }
        const result = await memory.publishBatch(stream, envelopes);
        return { receipts: result.receipts.slice(0, 2), failure: undefined };
      },
    });
    const publisher = new GatewayPublisher({
      transport: lying,
      stream: "market",
      clock: new ManualGatewayClock(),
      onPublicationHalted: (halt) => halts.push(halt),
    });
    const outcomes = ["1", "2", "3", "4", "5"].map((seq) => publisher.enqueue(envelopeAt(seq)));
    held?.();
    const settled = await Promise.all(outcomes);
    expect(settled.map((outcome) => outcome.published)).toEqual([true, true, true, false, false]);
    expect(halts[0]?.cause).toBe("GATEWAY_PUBLISH_REJECTED");
    expect(halts[0]?.haltedAtIngestSeq).toBe("4");
    expect(halts[0]?.detail).toContain("accounted for 2 of 4 envelopes");
    expect(publisher.metrics().published).toBe(3);
  });

  it("a publishBatch that rejects is a failure at the run's first envelope", async () => {
    const memory = new MemoryEventTransport();
    const halts: PublicationHalt[] = [];
    const rejecting = Object.assign(Object.create(memory) as MemoryEventTransport, {
      publishBatch: () => Promise.reject(new Error("the batch call itself blew up")),
    });
    const publisher = new GatewayPublisher({
      transport: rejecting,
      stream: "market",
      clock: new ManualGatewayClock(),
      onPublicationHalted: (halt) => halts.push(halt),
    });
    const outcome = await publisher.enqueue(envelopeAt("1"));
    expect(outcome.published).toBe(false);
    expect(halts[0]).toMatchObject({ cause: "GATEWAY_PUBLISH_REJECTED", haltedAtIngestSeq: "1" });
    expect(memory.published("market")).toEqual([]);
  });

  it("refuses a batch bound that is not a positive integer", () => {
    expect(() => build({ maxBatchEnvelopes: 0 })).toThrow(RangeError);
    expect(() => build({ maxBatchBytes: 1.5 })).toThrow(RangeError);
  });

  it("the Redis Streams transport offers the capability the pump detects (compile-time)", () => {
    expectTypeOf<RedisStreamsEventTransport>().toMatchTypeOf<BatchPublishCapability>();
  });
});

/**
 * A transport WITHOUT `publishBatch` keeps the per-envelope path: batches of
 * one, one `publish` per envelope, exactly the pre-`THROUGHPUT-1b` pump.
 */
describe("GatewayPublisher — a transport without publishBatch (per-envelope path)", () => {
  function perEnvelope(memory: MemoryEventTransport): MarketEventTransport {
    return {
      transportId: memory.transportId,
      retention: memory.retention,
      publish: (stream, envelope) => memory.publish(stream, envelope),
      subscribe: (options) => memory.subscribe(options),
      streamMetrics: (stream) => memory.streamMetrics(stream),
      close: () => memory.close(),
    };
  }

  function buildPerEnvelope(options: { maxQueueDepth?: number; maxBatchEnvelopes?: number } = {}) {
    const memory = new MemoryEventTransport();
    const halts: PublicationHalt[] = [];
    const publisher = new GatewayPublisher({
      transport: perEnvelope(memory),
      stream: "market",
      clock: new ManualGatewayClock(),
      onPublicationHalted: (halt) => halts.push(halt),
      ...options,
    });
    return { memory, publisher, halts };
  }

  it("submits one envelope per call, in order, whatever the batch bound says", async () => {
    const { memory, publisher } = buildPerEnvelope({ maxBatchEnvelopes: 64 });
    memory.stallPublishes();
    const outcomes = ["1", "2", "3", "4"].map((seq) => publisher.enqueue(envelopeAt(seq)));
    expect(publisher.queueDepth).toBe(3);
    memory.resumePublishes();
    await Promise.all(outcomes);
    expect(memory.batchCalls).toBe(0);
    expect(memory.publishCalls).toBe(4);
    expect(publisher.metrics()).toMatchObject({ submissions: 4, largestSubmission: 1, published: 4 });
    expect(memory.published("market").map((envelope) => envelope.ingestSeq)).toEqual(["1", "2", "3", "4"]);
  });

  it("a refusal halts and no later identity publishes", async () => {
    const { memory, publisher, halts } = buildPerEnvelope();
    memory.stallPublishes();
    const outcomes = [
      publisher.enqueue(envelopeAt("1")),
      publisher.enqueue({ ...envelopeAt("2"), receivedAt: "not-a-timestamp" }),
      publisher.enqueue(envelopeAt("3")),
    ];
    memory.resumePublishes();
    const settled = await Promise.all(outcomes);
    expect(settled.map((outcome) => outcome.published)).toEqual([true, false, false]);
    expect(halts[0]).toMatchObject({ cause: "GATEWAY_PUBLISH_REJECTED", haltedAtIngestSeq: "2" });
    expect(memory.published("market").map((envelope) => envelope.ingestSeq)).toEqual(["1"]);
  });

  it("a stalled publish overflows the admission bound and halts, as before", async () => {
    const { memory, publisher, halts } = buildPerEnvelope({ maxQueueDepth: 4 });
    memory.stallPublishes();
    const outcomes = ["1", "2", "3", "4", "5"].map((seq) => publisher.enqueue(envelopeAt(seq)));
    const refused = await publisher.enqueue(envelopeAt("6"));
    expect(refused.published).toBe(false);
    expect(halts[0]).toMatchObject({ cause: "GATEWAY_PUBLISH_ADMISSION_OVERFLOW", haltedAtIngestSeq: "6" });
    memory.resumePublishes();
    await Promise.all(outcomes);
    await publisher.settle();
    expect(memory.published("market").map((envelope) => envelope.ingestSeq)).toEqual(["1"]);
  });
});
