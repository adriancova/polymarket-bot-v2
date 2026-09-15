/**
 * THE PUBLISHER'S ADMISSION BYTE BOUND DOES NOT DEPEND ON AN INHERITED `toJSON` (`SER-3`).
 *
 * MEASURED AT `main` `d6e05bf` (`SER-0`, reproduced independently):
 * `apps/data-gateway/src/publisher.ts`'s `envelopeByteSize` was
 * `utf8ByteLength(JSON.stringify(envelope))`, and `JSON.stringify` resolves
 * `toJSON` through the prototype chain. This number is a DECISION — §8.3's
 * bounded admission queue — and under an inherited `Object.prototype` /
 * `Array.prototype` `toJSON` every envelope measured as the bytes of the
 * injected string: a queue that clean refuses at the byte bound was ADMITTED
 * (shrink), a `queueBytes` gauge that clean reports in the hundreds read ten,
 * and nothing refused.
 *
 * The scenario below is the existing byte-bound test's shape: a stalled
 * transport, one envelope in flight, one queued, a third at the bound. It
 * runs clean and under ALL SIX contexts, and the rendered admission decision,
 * halt cause and `queueBytes` gauge must be identical to the clean ones with
 * the injected `toJSON` invoked ZERO times — so it fails at the base commit
 * (the third envelope is admitted; the gauge reads the injected string's
 * length) and passes once the bound is measured over own data
 * (`@polymarket-bot/risk/plain-json`). Harness: `test/unit/ledger/inherited-tojson.ts`.
 *
 * The second block pins what the round ADDED: an envelope with no own-data
 * JSON text is refused at admission with the same terminal halt the
 * transport's own refusal produces, and `enqueue` never throws — at base a
 * bigint's `TypeError` escaped synchronously into the caller.
 */

import { describe, expect, it } from "vitest";

import type { EventEnvelope } from "../../../packages/domain/src/index.js";

import { encodeEnvelope } from "../../../packages/event-bus/src/index.js";
import { GatewayDispatcher } from "../../../apps/data-gateway/src/dispatcher.js";
import { completeEnvelope } from "../../../apps/data-gateway/src/envelope.js";
import type { EnvelopeDraft } from "../../../apps/data-gateway/src/envelope.js";
import { IncidentRegistry } from "../../../apps/data-gateway/src/incidents.js";
import { GatewayPublisher } from "../../../apps/data-gateway/src/publisher.js";
import type { PublicationHalt, PublishOutcome } from "../../../apps/data-gateway/src/publisher.js";
import { IngestSequencer } from "../../../apps/data-gateway/src/sequencer.js";
import { deterministicIdSource, ManualGatewayClock } from "../../../apps/data-gateway/src/testing/index.js";
import { MemoryEventTransport } from "../../../apps/data-gateway/src/testing/memory-transport.js";
import { renderDivergences, sweepInheritedToJson, TOJSON_CONTEXTS } from "../ledger/inherited-tojson.js";

const EPOCH = "00000000-0000-4000-8000-000000000001";

function envelopeAt(ingestSeq: string, payload: unknown = undefined): EventEnvelope<unknown> {
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
    payload: payload ?? {
      feedId: "binance-reference",
      detectedAt: "2026-08-30T12:00:00.000Z",
      stalenessMs: 45_000,
    },
  };
}

/** Computed OUTSIDE every window: the clean-process byte count of one envelope. */
const ONE_ENVELOPE_BYTES = Buffer.byteLength(JSON.stringify(envelopeAt("1")), "utf8");

interface AdmissionRun {
  readonly transport: MemoryEventTransport;
  readonly pending: readonly Promise<PublishOutcome>[];
  readonly rendered: string;
}

/**
 * One envelope in flight (dequeued into the stalled publish), one queued, a
 * third at the byte bound. Renders the gauge after the second admission, the
 * third decision, and the halt cause, as a string — no `JSON.stringify`.
 */
function admissionAtTheByteBound(): AdmissionRun {
  const halts: PublicationHalt[] = [];
  const transport = new MemoryEventTransport();
  const publisher = new GatewayPublisher({
    transport,
    stream: "market",
    clock: new ManualGatewayClock(),
    maxQueueDepth: 1_000,
    // Room for exactly one queued envelope behind the one in flight.
    maxQueueBytes: ONE_ENVELOPE_BYTES + 10,
    onPublicationHalted: (halt) => halts.push(halt),
  });
  transport.stallPublishes();
  const first = publisher.enqueue(envelopeAt("1"));
  const second = publisher.enqueue(envelopeAt("2"));
  const queueBytes = publisher.metrics().queueBytes;
  const third = publisher.enqueue(envelopeAt("3"));
  // `third` resolved synchronously if refused; its outcome is read from the
  // publisher's own state rather than awaited, to stay inside the window.
  const metrics = publisher.metrics();
  const rendered = [
    `queueBytes=${String(queueBytes)}`,
    `admissionRefusals=${String(metrics.admissionRefusals)}`,
    `halted=${String(metrics.halted)}`,
    `halt=${halts.map((halt) => halt.cause).join("+")}`,
    `queueMaxBytesObserved=${String(metrics.queueMaxBytesObserved)}`,
  ].join("|");
  return { transport, pending: [first, second, third], rendered };
}

describe("the admission byte bound under an inherited toJSON (SER-3)", () => {
  it("measures every envelope as its clean-process bytes, so the bound refuses exactly where clean refuses", async () => {
    const runs: AdmissionRun[] = [];
    const sweep = sweepInheritedToJson([
      {
        name: "admission-at-the-byte-bound",
        render: () => {
          const run = admissionAtTheByteBound();
          runs.push(run);
          return run.rendered;
        },
      },
    ]);
    // Let every stalled transport drain before asserting, so no publish is
    // left dangling across tests.
    for (const run of runs) run.transport.resumePublishes();
    await Promise.all(runs.flatMap((run) => run.pending));

    expect(renderDivergences(sweep.divergences)).toEqual([]);
    expect(runs).toHaveLength(1 + TOJSON_CONTEXTS.length);
    expect(sweep.clean.get("admission-at-the-byte-bound")).toBe(
      `ok:queueBytes=${String(ONE_ENVELOPE_BYTES)}|admissionRefusals=1|halted=true|halt=GATEWAY_PUBLISH_ADMISSION_OVERFLOW|queueMaxBytesObserved=${String(ONE_ENVELOPE_BYTES)}`,
    );
    // The bound is real: one envelope is in the hundreds of bytes, far above
    // the injected string's ten.
    expect(ONE_ENVELOPE_BYTES).toBeGreaterThan(100);
  });
});

describe("an envelope with no own-data JSON text is refused at admission, never thrown into the caller", () => {
  it.each([
    ["a bigint in the payload", { feedId: "x", stalenessMs: 1n }],
    ["a Date in the payload", { feedId: "x", detectedAt: new Date(0) }],
    ["a function in the payload", { feedId: "x", f: () => undefined }],
  ])("%s halts publication with GATEWAY_PUBLISH_REJECTED and resolves the outcome", async (_label, payload) => {
    const halts: PublicationHalt[] = [];
    const rejections: string[] = [];
    const transport = new MemoryEventTransport();
    const publisher = new GatewayPublisher({
      transport,
      stream: "market",
      clock: new ManualGatewayClock(),
      onPublicationHalted: (halt) => halts.push(halt),
      onPublishRejected: (rejection) => rejections.push(rejection.ingestSeq),
    });
    let outcome: PublishOutcome | undefined;
    // The promise never rejects and `enqueue` never throws.
    expect(() => {
      void publisher.enqueue(envelopeAt("1", payload)).then((resolved) => {
        outcome = resolved;
      });
    }).not.toThrow();
    await publisher.settle();
    expect(outcome).toBeDefined();
    if (outcome === undefined || outcome.published) throw new Error("expected a refusal");
    expect(outcome.reason).toBe("transport-rejected");
    expect(halts.map((halt) => halt.cause)).toEqual(["GATEWAY_PUBLISH_REJECTED"]);
    expect(halts[0]?.detail).toContain("the envelope has no own-data JSON text and was refused before submission (1)");
    expect(halts[0]?.haltedAtIngestSeq).toBe("1");
    expect(rejections).toEqual(["1"]);
    // Nothing reached the transport, and nothing publishes afterwards.
    expect(transport.publishCalls).toBe(0);
    const after = await publisher.enqueue(envelopeAt("2"));
    expect(after.published).toBe(false);
    if (!after.published) expect(after.reason).toBe("publication-halted");
    expect(publisher.metrics().rejectedByTransport).toBe(1);
  });
});

/**
 * THE ENCODER MAY NOT REFUSE WHERE BASE ENCODED — the `SER-2` review's HIGH,
 * audited here (the payload measured is PARSED VENUE DATA, so "built from this
 * repository's primitives" would be exactly the claim that failed there).
 *
 * The rule: no input a real producer can supply may make a production encoder
 * refuse where base `JSON.stringify` (no depth bound, silent coercions)
 * succeeded. `envelopeByteSize` is a DECISION, so a refusal that base did not
 * make would be an availability regression worse than the byte hijack it
 * closes. Two independent bounds make that unreachable, and both are pinned:
 *
 * 1. THE PRODUCER'S BOUND. The only caller of `GatewayPublisher.enqueue` is
 *    `GatewayDispatcher.dispatch` (`apps/data-gateway/src/dispatcher.ts:145`),
 *    which submits `completeEnvelope(...)`'s output — and `completeEnvelope`
 *    (`apps/data-gateway/src/envelope.ts:104`) returns only what
 *    `DOMAIN_EVENT_REGISTRY.safeParseEnvelope` accepted. Every registered
 *    contract's payload schema is a FIXED shape: `packages/domain/src/events/**`
 *    contains no `z.unknown()`, `z.any()`, `z.record(`, `z.lazy(` or
 *    `.passthrough()` (the domain's only `z.unknown()` is
 *    `UnknownPayloadEventEnvelopeSchema`, `envelope.ts:175`, which the gateway
 *    does not use for completion), so the deepest venue payload is a handful
 *    of levels and a deep or non-plain one is REFUSED BEFORE PUBLICATION.
 *
 *    NOT before the sequence is assigned (`SER-3` review round 1, L1: this
 *    file claimed that, and it is false). `dispatch` evaluates
 *    `ingestSeq: this.#sequencer.next()` as an ARGUMENT to `completeEnvelope`
 *    (`dispatcher.ts:118`), so the refused draft CONSUMES its sequence and the
 *    incident publishes at the next one — which `dispatcher.ts`'s own comment
 *    states ("A validation failure between the assignment and the submission
 *    consumes the sequence and publishes nothing") and which the test below
 *    now measures by driving the REAL dispatcher rather than asserting it in
 *    prose: `{outcome: "transport-rejected", sequences: ["2"], rejections: 1}`
 *    — the reviewer's measurement at the revisions it ran, and this file's at
 *    this tip. Nothing in this round touches `dispatcher.ts`, so the ordering
 *    is the same before and after it.
 * 2. THE NESTED-DOOR BOUND. Should such an envelope reach `enqueue` anyway
 *    (the class is exported), every value this admission encoder refuses is a
 *    value the transport's own door refuses: `encodeWireJson`
 *    (`packages/event-bus/src/envelope-door.ts:199`) IS `encodePlainJson` at
 *    `maxDepth: 16`, and `validateEnvelope` materializes through
 *    `readOwnWireValue` at the same bound, both tighter than the default 64
 *    used here. So WHERE BASE'S SERIALIZATION COMPLETED AND THE TRANSPORT THEN
 *    APPLIED ITS WIRE DOOR, the terminal verdict is the one base reached — a
 *    `GATEWAY_PUBLISH_REJECTED` halt — and only the step and the detail text
 *    differ. The looser bound is deliberate: measuring at 16 would move the
 *    transport's depth refusal earlier, and `JSON.parse` accepts far deeper
 *    trees than any door here, so the ceiling is never the place to fix this.
 *
 *    THE SCOPE OF THAT EQUIVALENCE, measured by the review (round 1, L1) and
 *    pinned below: it is an equivalence only while base could serialize at all.
 *    `JSON.stringify` has no depth bound but it does have the JS STACK, and an
 *    envelope admitted DIRECTLY at 5,000 levels made base's `envelopeByteSize`
 *    throw a native `RangeError: Maximum call stack size exceeded`
 *    SYNCHRONOUSLY out of `enqueue`, into whatever callback called it — no
 *    outcome, no halt, no incident. At this tip the same envelope refuses at
 *    the encoder's bound and halts terminally with an outcome. That is a
 *    genuine DIFFERENCE, and a better one; it is not an equivalence, and this
 *    file does not claim it is.
 */
describe("the admission byte bound may not refuse where base encoded (SER-2 cross-round rule)", () => {
  /** A payload nested `levels` deep: `{ nest: { nest: … } }`. */
  function deepPayload(levels: number): Record<string, unknown> {
    let node: Record<string, unknown> = { feedId: "binance-reference", stalenessMs: 1 };
    for (let index = 0; index < levels; index += 1) node = { nest: node };
    return node;
  }

  it("BOUND 1: the domain contract refuses a payload past the bound before PUBLICATION (the sequence IS consumed)", () => {
    // 200 levels: past this encoder's default (64) AND past the transport's
    // (16), and well inside what `JSON.parse` would accept off a socket.
    const completed = completeEnvelope(
      {
        eventType: "FeedStale",
        schemaVersion: 1,
        source: "binance",
        sourceChannel: "binance:stream-connection",
        payload: deepPayload(200),
      },
      {
        eventId: "01900000-0000-7000-8000-000000000001",
        gatewayEpoch: EPOCH,
        ingestSeq: "1",
        receipt: { receivedAt: "2026-08-30T12:00:00.000Z", receivedMonotonicNs: "1", nowMs: 0 },
      },
    );
    expect(completed.ok).toBe(false);
    if (completed.ok) return;
    expect(completed.code).toBe("ENVELOPE_CONTRACT_REJECTED");
    // Non-vacuity: the same draft with a shallow payload IS accepted, so the
    // refusal above is the depth, not the fixture.
    const shallow = completeEnvelope(
      {
        eventType: "FeedStale",
        schemaVersion: 1,
        source: "binance",
        sourceChannel: "binance:stream-connection",
        payload: {
          feedId: "binance-reference",
          detectedAt: "2026-08-30T12:00:00.000Z",
          stalenessMs: 45_000,
        },
      },
      {
        eventId: "01900000-0000-7000-8000-000000000001",
        gatewayEpoch: EPOCH,
        ingestSeq: "1",
        receipt: { receivedAt: "2026-08-30T12:00:00.000Z", receivedMonotonicNs: "1", nowMs: 0 },
      },
    );
    expect(shallow.ok).toBe(true);
  });

  it("BOUND 2: an envelope past the bound reaches the SAME terminal verdict the transport gives it at base", async () => {
    const envelope = envelopeAt("1", deepPayload(200));
    // What base did: admission measured a number, the transport's door then
    // refused the envelope, and the publisher halted. The door still refuses
    // it — so the tip's earlier refusal changes the STEP, not the verdict.
    expect(() => encodeEnvelope(envelope)).toThrow();

    const halts: PublicationHalt[] = [];
    const transport = new MemoryEventTransport();
    const publisher = new GatewayPublisher({
      transport,
      stream: "market",
      clock: new ManualGatewayClock(),
      onPublicationHalted: (halt) => halts.push(halt),
    });
    const outcome = await publisher.enqueue(envelope);
    expect(outcome.published).toBe(false);
    if (outcome.published) return;
    expect(outcome.reason).toBe("transport-rejected");
    expect(halts.map((halt) => halt.cause)).toEqual(["GATEWAY_PUBLISH_REJECTED"]);
    expect(publisher.metrics().rejectedByTransport).toBe(1);
  });

  it("a payload at 63 levels — deeper than the transport's bound, inside this one — is still MEASURED, not refused", async () => {
    // The window between the two doors (17…64) behaves exactly as base did:
    // admission measures a byte count and admits; the transport is what
    // refuses. Nothing in this round moved that boundary.
    const envelope = envelopeAt("1", deepPayload(60));
    const transport = new MemoryEventTransport();
    const publisher = new GatewayPublisher({
      transport,
      stream: "market",
      clock: new ManualGatewayClock(),
      maxQueueDepth: 8,
      maxQueueBytes: 1_048_576,
    });
    const outcome = await publisher.enqueue(envelope);
    // The memory transport does not run the wire door, so this publishes here;
    // the point is that ADMISSION measured it rather than refusing.
    expect(outcome.published).toBe(true);
    expect(publisher.metrics().admissionRefusals).toBe(0);
    expect(publisher.metrics().queueMaxBytesObserved).toBeGreaterThan(
      Buffer.byteLength(JSON.stringify(envelopeAt("1")), "utf8"),
    );
    // And the real transport's door is the one that refuses it, as at base.
    expect(() => encodeEnvelope(envelope)).toThrow();
  });
});

/**
 * THE ORDERING THE REFUSAL ACTUALLY HAS, exercised on the REAL dispatcher
 * (`SER-3` review round 1, L1).
 *
 * The claim this file used to make in prose — "refused before it can be
 * assigned a sequence" — was false, and prose is exactly where it could stay
 * false. `GatewayDispatcher.dispatch` takes a sequence FIRST
 * (`dispatcher.ts:118`, an argument expression) and completes the envelope
 * afterwards, so a refused draft consumes its number and the incident it opens
 * publishes at the next one. That is the gateway's documented behaviour and it
 * is independent of `SER-3`, which changes no line of `dispatcher.ts`: the
 * reviewer measured this shape at the revisions it ran, and the test below
 * measures it here.
 */
describe("the refusal's real ordering through the dispatcher (SER-3 review L1)", () => {
  const EPOCH_2 = "00000000-0000-4000-8000-000000000002";

  function dispatcherHarness(): {
    readonly transport: MemoryEventTransport;
    readonly dispatcher: GatewayDispatcher;
    readonly publisher: GatewayPublisher;
    readonly rejections: string[];
  } {
    const clock = new ManualGatewayClock();
    const transport = new MemoryEventTransport();
    const publisher = new GatewayPublisher({ transport, stream: "market", clock });
    const rejections: string[] = [];
    const dispatcher = new GatewayDispatcher({
      clock,
      ids: deterministicIdSource(),
      sequencer: new IngestSequencer(EPOCH_2),
      publisher,
      incidents: new IncidentRegistry(),
      observer: { onEnvelopeRejected: () => rejections.push("envelope-rejected") },
    });
    return { transport, dispatcher, publisher, rejections };
  }

  function draftWith(payload: unknown): EnvelopeDraft {
    return {
      eventType: "FeedStale",
      schemaVersion: 1,
      source: "binance",
      sourceChannel: "binance:stream-connection",
      payload,
    };
  }

  it("a payload past the bound consumes sequence 1 and publishes only the incident, at 2", async () => {
    const { transport, dispatcher, publisher, rejections } = dispatcherHarness();
    let node: Record<string, unknown> = { feedId: "binance-reference", stalenessMs: 1 };
    for (let index = 0; index < 200; index += 1) node = { nest: node };

    const outcome = await dispatcher.dispatch(draftWith(node));
    await publisher.settle();

    expect(outcome.published).toBe(false);
    if (outcome.published) return;
    expect(outcome.reason).toBe("transport-rejected");
    // The reviewer's measurement, verbatim:
    // {"outcome":"transport-rejected","sequences":["2"],"rejections":1}
    expect(transport.published("market").map((envelope) => envelope.ingestSeq)).toEqual(["2"]);
    expect(rejections).toHaveLength(1);
    // Nothing carrying the refused payload reached the transport; what did is
    // the incident the dispatcher opened for it.
    expect(transport.published("market").map((envelope) => envelope.eventType)).not.toContain(
      "FeedStale",
    );
    expect(dispatcher.metrics().envelopeRejections).toBe(1);
  });

  it("the accepted draft that follows takes 3, so the consumed number is really gone", async () => {
    const { transport, dispatcher, publisher } = dispatcherHarness();
    await dispatcher.dispatch(draftWith({ feedId: "x" }));
    const accepted = await dispatcher.dispatch(
      draftWith({
        feedId: "binance-reference",
        detectedAt: "2026-08-30T12:00:00.000Z",
        stalenessMs: 45_000,
      }),
    );
    await publisher.settle();
    expect(accepted.published).toBe(true);
    expect(transport.published("market").map((envelope) => envelope.ingestSeq)).toEqual(["2", "3"]);
  });
});

/**
 * WHERE THE ADMISSION ENCODER AND BASE DIVERGE, AND WHERE THEY DO NOT
 * (`SER-3` review round 1, L1's second half, and the M2 container sweep).
 */
describe("the admission encoder against base, measured rather than asserted", () => {
  function envelopeWithPayload(payload: unknown): EventEnvelope<unknown> {
    return envelopeAt("1", payload);
  }

  it("5,000 levels: base threw a native RangeError synchronously; this tip halts terminally with an outcome", async () => {
    let node: unknown = { feedId: "binance-reference", stalenessMs: 1 };
    for (let index = 0; index < 5_000; index += 1) node = { nest: node };
    const envelope = envelopeWithPayload(node);

    // What base's `envelopeByteSize` did, still measurable in this process:
    // `JSON.stringify(envelope)` overflows the stack. At base that `RangeError`
    // escaped `enqueue` synchronously into the caller's socket callback.
    expect(() => JSON.stringify(envelope)).toThrow(RangeError);

    const halts: PublicationHalt[] = [];
    const transport = new MemoryEventTransport();
    const publisher = new GatewayPublisher({
      transport,
      stream: "market",
      clock: new ManualGatewayClock(),
      onPublicationHalted: (halt) => halts.push(halt),
    });
    let outcome: PublishOutcome | undefined;
    expect(() => {
      void publisher.enqueue(envelope).then((resolved) => {
        outcome = resolved;
      });
    }).not.toThrow();
    await publisher.settle();
    expect(outcome?.published).toBe(false);
    expect(halts.map((halt) => halt.cause)).toEqual(["GATEWAY_PUBLISH_REJECTED"]);
    expect(transport.publishCalls).toBe(0);
  });

  it("a payload carrying an Array SUBCLASS reaches the SAME terminal verdict the transport gives it", async () => {
    // The M2 container sweep, at this site: `enqueue` takes the envelope by
    // reference and nothing here rebuilds it, so a caller's container type CAN
    // reach the admission encoder — but the transport's own door refuses the
    // same value, so the verdict base reached is the verdict here, and only
    // the step differs. (Through the dispatcher it is unreachable: the domain
    // registry's parse output is a materialized plain tree.)
    class Prices extends Array<number> {}
    const envelope = envelopeWithPayload({ feedId: "x", stalenessMs: 1, prices: new Prices(1, 2) });
    // Base: `JSON.stringify` serialized it, and the transport's door then
    // refused it — the same terminal halt, one step later.
    expect(() => JSON.stringify(envelope)).not.toThrow();
    expect(() => encodeEnvelope(envelope)).toThrow();

    const halts: PublicationHalt[] = [];
    const publisher = new GatewayPublisher({
      transport: new MemoryEventTransport(),
      stream: "market",
      clock: new ManualGatewayClock(),
      onPublicationHalted: (halt) => halts.push(halt),
    });
    const outcome = await publisher.enqueue(envelope);
    expect(outcome.published).toBe(false);
    expect(halts.map((halt) => halt.cause)).toEqual(["GATEWAY_PUBLISH_REJECTED"]);
  });
});
