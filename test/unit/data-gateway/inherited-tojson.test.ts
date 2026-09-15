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
import { completeEnvelope } from "../../../apps/data-gateway/src/envelope.js";
import { GatewayPublisher } from "../../../apps/data-gateway/src/publisher.js";
import type { PublicationHalt, PublishOutcome } from "../../../apps/data-gateway/src/publisher.js";
import { ManualGatewayClock } from "../../../apps/data-gateway/src/testing/index.js";
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
 *    of levels and a deep or non-plain one is REFUSED BEFORE assignment.
 * 2. THE NESTED-DOOR BOUND. Should such an envelope reach `enqueue` anyway
 *    (the class is exported), every value this admission encoder refuses is a
 *    value the transport's own door refuses: `encodeWireJson`
 *    (`packages/event-bus/src/envelope-door.ts:199`) IS `encodePlainJson` at
 *    `maxDepth: 16`, and `validateEnvelope` materializes through
 *    `readOwnWireValue` at the same bound, both tighter than the default 64
 *    used here. So the terminal verdict is the one base reached — a
 *    `GATEWAY_PUBLISH_REJECTED` halt — and only the step and the detail text
 *    differ. The looser bound is deliberate: measuring at 16 would move the
 *    transport's depth refusal earlier, and `JSON.parse` accepts far deeper
 *    trees than any door here, so the ceiling is never the place to fix this.
 */
describe("the admission byte bound may not refuse where base encoded (SER-2 cross-round rule)", () => {
  /** A payload nested `levels` deep: `{ nest: { nest: … } }`. */
  function deepPayload(levels: number): Record<string, unknown> {
    let node: Record<string, unknown> = { feedId: "binance-reference", stalenessMs: 1 };
    for (let index = 0; index < levels; index += 1) node = { nest: node };
    return node;
  }

  it("BOUND 1: the domain contract refuses a payload past the bound before it can be assigned a sequence", () => {
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
