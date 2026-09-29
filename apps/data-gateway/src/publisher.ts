/**
 * The gateway's publication side of the WP-060 transport.
 *
 * ## Submission order is assignment order
 *
 * The transport enforces strictly increasing `ingestSeq` per epoch at publish
 * (WP-060: a non-advancing pair is refused before anything is appended), so
 * the gateway must SUBMIT in assignment order. `enqueue()` is called
 * synchronously in assignment order by the dispatcher and appends to ONE
 * FIFO admission queue; a single pump drains that queue serially, so
 * submission order is admission order is assignment order across every feed's
 * async callbacks. Gaps are fine — the rule is monotonic, not contiguous.
 *
 * ## The admission queue is BOUNDED, synchronously (round-1 review H2)
 *
 * Round 1 used a Promise chain as its queue. A chain has no depth: a single
 * `transport.publish()` that never resolved admitted 999 further envelopes
 * with `halted === false` and no metric that could show it. That defeats
 * §8.3's "every queue is bounded" and WP-060's bounded producer queue — with
 * one transport call in flight the transport's OWN queue may never fill, so
 * `EVENT_BUS_PUBLISH_QUEUE_FULL` may never raise, `settle()` can wedge
 * forever, and memory grows without bound.
 *
 * Admission is therefore decided SYNCHRONOUSLY against two bounds, depth and
 * bytes ({@link DEFAULT_PUBLISH_QUEUE_MAX_DEPTH},
 * {@link DEFAULT_PUBLISH_QUEUE_MAX_BYTES}, both configurable). Crossing either
 * one is not a drop and not a silent wait: it is a TERMINAL HALT through the
 * same machinery a confirmed outage uses, so an operator reads one story —
 * "publication halted, recording continues, restart the process" — whichever
 * bound was hit. Depth, byte, and oldest-age gauges are published in
 * {@link GatewayPublisherMetrics}; round 1 claimed they existed and they did
 * not.
 *
 * ## Publish-once (dedup identity, WP-050/WP-060 obligation)
 *
 * `(gatewayEpoch, ingestSeq)` is the deduplication identity. The publisher
 * refuses to admit an identity at or below its high-water mark, with a counter
 * and an observer callback — never silently. Within one process this makes a
 * double-publish of one identity unrepresentable; consumers still deduplicate
 * on the same key for the cross-restart at-least-once cases the upstream
 * handoffs document.
 *
 * ## Every unsuccessful submission halts (round-1 review H3)
 *
 * Round 1 halted only on `EventBusUnavailableError` and let every OTHER
 * transport rejection increment a counter while publication carried on. That
 * is an undetectable hole: seq 1 rejected, seq 2 published, `halted === false`
 * — a consumer sees a contiguous-looking stream that is missing an event.
 * There is no third option here that is both safe and terminating: retrying a
 * permanently-invalid envelope in place would loop forever, and skipping it
 * loses an event. So EVERY unsuccessful submission — outage, queue-full,
 * envelope refusal, ordering refusal, anything — halts publication terminally
 * for the epoch and opens a PAGE incident. No later identity publishes after
 * an unrecovered rejection.
 *
 * ## Outage semantics (§4.2, acceptance 4; WP-060 `follow_up` 2)
 *
 * `EventBusUnavailableError` — INCLUDING its `EVENT_BUS_PUBLISH_QUEUE_FULL`
 * subclass, which is a halt signal and not a drop signal — halts publication
 * TERMINALLY for this epoch. Recording is not touched: the WAL path does not
 * run through this module, which is exactly the §4.2 boundary ("a Redis
 * outage stops publication … but the recorder continues writing WAL").
 * Publication does not resume mid-epoch: events assigned during the outage
 * were never in the stream, so a mid-epoch resume would hand consumers a
 * silent gap the transport cannot detect (its resync arithmetic watches its
 * own publication ordinals, not `ingestSeq`). A restart mints a new epoch and
 * a fresh snapshot obligation, which is the §7.1 recovery path; the operator
 * procedure is written down in `infra/compose/data-gateway/README.md`.
 *
 * A halt is TOTAL and IMMEDIATE: entries already admitted but not yet
 * submitted are resolved as suppressed rather than published, so there is
 * exactly one boundary in the stream instead of a trickle after the halt.
 *
 * ## Batched submission (`THROUGHPUT-1b`)
 *
 * H1 run 1 halted `GATEWAY_PUBLISH_ADMISSION_OVERFLOW` at a window open. The
 * pump submitted ONE envelope per transport round trip, so it drained at
 * most one envelope per event-loop turn, and a burst of admissions in a few
 * turns outran it (`tools/bench/gateway/README.md` has the measurements).
 *
 * When the transport offers `publishBatch` ({@link BatchPublishCapability};
 * the Redis Streams transport does), the pump now takes the CONSECUTIVE run of
 * entries at the head of the queue — at most
 * {@link DEFAULT_PUBLISH_BATCH_MAX_ENVELOPES} envelopes and
 * {@link DEFAULT_PUBLISH_BATCH_MAX_BYTES} bytes — and submits them in one
 * call. Nothing about publication changes:
 *
 * - the run is the FIFO's head, in admission order, so submission order is
 *   still assignment order; the transport checks every envelope's door and
 *   ordering exactly as `publish` does and writes the same stream entries;
 * - admission — the depth and byte bounds, their defaults, the duplicate
 *   refusal — is untouched and still synchronous; a run leaves the queue when
 *   it is SUBMITTED, as a single envelope did (the depth gauge still counts
 *   "admitted and not yet submitted"), and at most one run is in flight;
 * - the transport reports the published prefix and the first envelope that
 *   was NOT published. That envelope's failure halts publication exactly as a
 *   failed single publish did (same causes, same PAGE incident), and every
 *   envelope after it in the run is suppressed, never submitted: nothing is
 *   appended after a refusal;
 * - a halt that happens WHILE a run is in flight (an admission overflow
 *   behind a stalled transport) cannot unsend it, exactly as it could not
 *   unsend the one envelope in flight before: that run is the last thing in
 *   the stream.
 *
 * A transport without `publishBatch` (the in-memory doubles that opt out, the
 * startup-outage transport) gets batches of one and the per-envelope code
 * path, unchanged.
 */

import type { EventEnvelope } from "@polymarket-bot/domain";
import type {
  EventStreamName,
  MarketEventTransport,
  PublishReceipt,
} from "@polymarket-bot/event-bus";
import { EventBusPublishQueueFullError, EventBusUnavailableError } from "@polymarket-bot/event-bus";
import { encodePlainJson } from "@polymarket-bot/risk/plain-json";

import type { GatewayClock } from "./ports.js";

/**
 * Default admission depth.
 *
 * Sized as "roughly a second of a very busy gateway": enough to absorb an
 * ordinary transport hiccup without refusing, small enough that a stalled
 * transport is a halt in seconds rather than an out-of-memory hours later.
 * It is a SAFETY bound, not a throughput tuning knob (ADR-003's framing of
 * retention applies here too) — raising it buys tolerance for a longer stall
 * and costs memory and a longer window of events that exist only in the WAL.
 */
export const DEFAULT_PUBLISH_QUEUE_MAX_DEPTH = 1_024;

/**
 * Default admission size, in bytes of serialized envelope.
 *
 * A depth bound alone is not a memory bound: one book snapshot is orders of
 * magnitude larger than one `FeedStale`. 8 MiB is the same order as the WAL's
 * own queue byte bound and is reached long before a Node heap is in danger.
 */
export const DEFAULT_PUBLISH_QUEUE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Most envelopes one batched submission carries (`THROUGHPUT-1b`).
 *
 * Not an admission bound: it caps how much is IN FLIGHT at once, on top of
 * the admission queue, so a stalled transport holds at most this many
 * submitted-but-unsettled envelopes plus a full queue. The pump submits what
 * is queued when the previous submission settles, so batches are as large as
 * the arrivals during one round trip; this cap is reached only when the
 * transport falls well behind.
 */
export const DEFAULT_PUBLISH_BATCH_MAX_ENVELOPES = 256;

/**
 * Most serialized bytes one batched submission carries. A single envelope
 * larger than this still goes, alone.
 */
export const DEFAULT_PUBLISH_BATCH_MAX_BYTES = 1024 * 1024;

/**
 * The first envelope of a batch the transport did NOT publish, and why.
 * Mirrors the Redis Streams transport's `PublishBatchFailure`.
 */
export interface BatchPublishFailure {
  readonly index: number;
  readonly error: unknown;
}

/**
 * The batch capability the pump uses when the transport offers it.
 *
 * Not part of `MarketEventTransport` (whose interface this package does not
 * own); `RedisStreamsEventTransport.publishBatch` satisfies it, which
 * `main.ts` checks at compile time where it wires that transport. The
 * contract the pump relies on: the result's receipts are the published
 * PREFIX of the batch, `failure.index === receipts.length` when anything was
 * not published, nothing after `failure.index` was attempted, and the call
 * never rejects (a rejection is nevertheless treated as a failure at index
 * 0, and an inconsistent result as a failure at the first unaccounted
 * envelope — both halt).
 */
export interface BatchPublishCapability {
  publishBatch(
    stream: EventStreamName,
    envelopes: readonly EventEnvelope<unknown>[],
  ): Promise<{
    readonly receipts: readonly PublishReceipt[];
    readonly failure: BatchPublishFailure | undefined;
  }>;
}

/** The transport's batch capability, bound to it, or `undefined`. */
function batchCapabilityOf(transport: MarketEventTransport): BatchPublishCapability | undefined {
  const candidate = (transport as MarketEventTransport & Partial<BatchPublishCapability>)
    .publishBatch;
  if (typeof candidate !== "function") return undefined;
  return {
    publishBatch: async (stream, envelopes) => await candidate.call(transport, stream, envelopes),
  };
}

export type PublishOutcome =
  | { readonly published: true; readonly sequence: number }
  | {
      readonly published: false;
      readonly reason:
        | "duplicate-identity"
        | "publication-halted"
        | "transport-unavailable"
        | "transport-rejected"
        | "admission-queue-full";
      readonly detail: string;
    };

/**
 * Why publication stopped.
 *
 * Every cause is terminal for the epoch and every one opens a PAGE incident;
 * the distinction exists so an operator can tell an infrastructure outage from
 * a gateway-side defect without reading a log.
 */
export type PublicationHaltCause =
  /** WP-060's producer queue is saturated: a halt signal, never a drop signal. */
  | "EVENT_BUS_PUBLISH_QUEUE_FULL"
  /** The transport is unreachable — including at process startup (§4.2). */
  | "EVENT_BUS_UNAVAILABLE"
  /** THIS publisher's admission queue is full: the transport is not draining. */
  | "GATEWAY_PUBLISH_ADMISSION_OVERFLOW"
  /** A non-outage refusal (bad envelope, ordering refusal, transport bug). */
  | "GATEWAY_PUBLISH_REJECTED";

export interface PublicationHalt {
  readonly cause: PublicationHaltCause;
  readonly detail: string;
  /** The identity publication stopped at; `"0"` when it stopped before any. */
  readonly haltedAtIngestSeq: string;
}

export interface GatewayPublisherOptions {
  readonly transport: MarketEventTransport;
  readonly stream: EventStreamName;
  /** Drives the oldest-queued-age gauge; injected like every other clock. */
  readonly clock: GatewayClock;
  /** Admission depth bound. Defaults to {@link DEFAULT_PUBLISH_QUEUE_MAX_DEPTH}. */
  readonly maxQueueDepth?: number;
  /** Admission byte bound. Defaults to {@link DEFAULT_PUBLISH_QUEUE_MAX_BYTES}. */
  readonly maxQueueBytes?: number;
  /**
   * Envelopes per batched submission. Defaults to
   * {@link DEFAULT_PUBLISH_BATCH_MAX_ENVELOPES}; ignored (always 1) when the
   * transport has no `publishBatch`.
   */
  readonly maxBatchEnvelopes?: number;
  /** Bytes per batched submission. Defaults to {@link DEFAULT_PUBLISH_BATCH_MAX_BYTES}. */
  readonly maxBatchBytes?: number;
  /** Called exactly once, when publication halts. */
  readonly onPublicationHalted?: (halt: PublicationHalt) => void;
  /** Called for every refused duplicate identity (observable, never silent). */
  readonly onDuplicateRefused?: (identity: {
    readonly gatewayEpoch: string;
    readonly ingestSeq: string;
  }) => void;
  /**
   * Called when the transport refuses an envelope for a non-outage reason.
   *
   * Informational: the halt that follows is what an operator acts on, and it
   * arrives through `onPublicationHalted` and the PAGE incident.
   */
  readonly onPublishRejected?: (rejection: {
    readonly ingestSeq: string;
    readonly detail: string;
  }) => void;
}

export interface GatewayPublisherMetrics {
  readonly published: number;
  readonly duplicatesRefused: number;
  readonly suppressedWhileHalted: number;
  readonly rejectedByTransport: number;
  /** Envelopes refused at admission because the queue was full. */
  readonly admissionRefusals: number;
  readonly halted: boolean;
  readonly halt: PublicationHalt | undefined;
  /** Highest admitted ingestSeq, as a string; "0" before the first. */
  readonly highWaterMark: string;
  /** §14.3 queue depth: envelopes admitted and not yet submitted. */
  readonly queueDepth: number;
  /** High-water mark of {@link queueDepth}. */
  readonly queueMaxDepthObserved: number;
  /** Configured depth bound, so a dashboard can show headroom. */
  readonly queueMaxDepth: number;
  readonly queueBytes: number;
  readonly queueMaxBytesObserved: number;
  readonly queueMaxBytes: number;
  /** §14.3 oldest message age: how long the head has waited, in ms. */
  readonly oldestQueuedAgeMs: number;
  /** Transport calls made: one per batch, or one per envelope without batching. */
  readonly submissions: number;
  /** Envelopes submitted and not yet settled (at most one batch). */
  readonly inFlight: number;
  /** The most envelopes one submission carried. */
  readonly largestSubmission: number;
}

interface QueuedPublication {
  readonly envelope: EventEnvelope<unknown>;
  readonly bytes: number;
  readonly admittedAtMs: number;
  readonly resolve: (outcome: PublishOutcome) => void;
}

/**
 * Exact UTF-8 byte length of a string, computed rather than measured.
 *
 * `Buffer.byteLength` would need a runtime global in a module that has no
 * other reason to touch one (`ports.ts`: every impure capability arrives
 * through a port), and the arithmetic is small and total. A lone surrogate
 * counts as 3 bytes, which is what it serializes to.
 */
function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
      continue;
    }
    if (code < 0x800) {
      bytes += 2;
      continue;
    }
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
        continue;
      }
    }
    bytes += 3;
  }
  return bytes;
}

/**
 * Serialized size of one envelope, for the admission byte bound.
 *
 * Costs one serialization pass per admitted envelope. That is the price of a
 * REAL byte bound rather than a guessed one; the transport serializes the same
 * envelope moments later, so the work is duplicated but not asymptotically
 * different, and an unbounded queue is the failure this is here to prevent.
 *
 * The bytes are the envelope's OWN DATA (`SER-3`, 2026-09-15). This is a
 * DECISION site — the number gates admission — and at base it was
 * `JSON.stringify`, which resolves `toJSON` through the prototype chain.
 * Measured at `main` `d6e05bf` and reproduced independently
 * (`docs/handoffs/SER-0-sweep.md`, `publisher-admission-byte-bound`): under an
 * inherited `Object.prototype`/`Array.prototype` `toJSON` every envelope
 * measured as the bytes of the injected string, so a queue of book snapshots
 * was ADMITTED past the byte bound (shrink) or a queue of `FeedStale`s was
 * HALTED under it (grow); only the transport's own-data door, one step later,
 * still refused over-deep envelopes. `encodePlainJson` is the same encoder the
 * transport's `encodeWireJson` is an adapter over (`packages/event-bus/src/
 * envelope-door.ts`), so the count here is the count of the bytes the
 * transport will write for every envelope it accepts. The depth bound here is
 * the encoder's default (64), looser than the transport's 16, so every
 * refusal here is one the transport would also make, and the transport's
 * tighter depth check still runs one step later exactly as it did at base.
 *
 * A refusal (a bigint, a function, an accessor, a `Date`, a cycle) throws:
 * the envelope has no own-data JSON text, exactly as `JSON.stringify` threw a
 * `TypeError` for a bigint or a cycle at base. `enqueue` contains it.
 */
function envelopeByteSize(envelope: EventEnvelope<unknown>): number {
  return utf8ByteLength(encodePlainJson(envelope));
}

export class GatewayPublisher {
  readonly #options: GatewayPublisherOptions;
  readonly #maxQueueDepth: number;
  readonly #maxQueueBytes: number;
  /** The transport's batch capability; `undefined` means batches of one. */
  readonly #batch: BatchPublishCapability | undefined;
  readonly #maxBatchEnvelopes: number;
  readonly #maxBatchBytes: number;

  /** FIFO admission queue; `#head` is the cursor, so dequeue is O(1). */
  #queue: QueuedPublication[] = [];
  #head = 0;
  #queueBytes = 0;
  #queueMaxDepthObserved = 0;
  #queueMaxBytesObserved = 0;

  #pumping = false;
  #pump: Promise<void> = Promise.resolve();

  #highWaterMark = 0n;
  #published = 0;
  #duplicatesRefused = 0;
  #suppressedWhileHalted = 0;
  #rejectedByTransport = 0;
  #admissionRefusals = 0;
  #submissions = 0;
  #inFlight = 0;
  #largestSubmission = 0;
  #halt: PublicationHalt | undefined;

  constructor(options: GatewayPublisherOptions) {
    this.#options = options;
    this.#maxQueueDepth = options.maxQueueDepth ?? DEFAULT_PUBLISH_QUEUE_MAX_DEPTH;
    this.#maxQueueBytes = options.maxQueueBytes ?? DEFAULT_PUBLISH_QUEUE_MAX_BYTES;
    this.#batch = batchCapabilityOf(options.transport);
    const maxBatchEnvelopes = options.maxBatchEnvelopes ?? DEFAULT_PUBLISH_BATCH_MAX_ENVELOPES;
    const maxBatchBytes = options.maxBatchBytes ?? DEFAULT_PUBLISH_BATCH_MAX_BYTES;
    if (!Number.isSafeInteger(maxBatchEnvelopes) || maxBatchEnvelopes < 1) {
      throw new RangeError(`maxBatchEnvelopes must be a positive integer, received ${String(maxBatchEnvelopes)}`);
    }
    if (!Number.isSafeInteger(maxBatchBytes) || maxBatchBytes < 1) {
      throw new RangeError(`maxBatchBytes must be a positive integer, received ${String(maxBatchBytes)}`);
    }
    this.#maxBatchEnvelopes = this.#batch === undefined ? 1 : maxBatchEnvelopes;
    this.#maxBatchBytes = maxBatchBytes;
  }

  get halted(): boolean {
    return this.#halt !== undefined;
  }

  get queueDepth(): number {
    return this.#queue.length - this.#head;
  }

  /**
   * Admits one envelope for publication.
   *
   * MUST be called synchronously, in assignment order, by the dispatcher.
   * Admission — accept, refuse as duplicate, refuse as queue-full, or suppress
   * because publication already halted — is decided SYNCHRONOUSLY, so a caller
   * cannot keep handing envelopes to a queue that is not draining. The
   * returned promise resolves with the outcome and never rejects, so a feed
   * driver's socket callback cannot be blown up by a transport failure.
   */
  enqueue(envelope: EventEnvelope<unknown>): Promise<PublishOutcome> {
    const seq = BigInt(envelope.ingestSeq);
    if (seq <= this.#highWaterMark) {
      this.#duplicatesRefused += 1;
      this.#options.onDuplicateRefused?.({
        gatewayEpoch: envelope.gatewayEpoch,
        ingestSeq: envelope.ingestSeq,
      });
      return Promise.resolve({
        published: false,
        reason: "duplicate-identity",
        detail: `(${envelope.gatewayEpoch}, ${envelope.ingestSeq}) is at or below the publish high-water mark ${this.#highWaterMark.toString()}`,
      });
    }

    if (this.#halt !== undefined) {
      return Promise.resolve(this.#suppress(this.#halt));
    }

    let bytes: number;
    try {
      bytes = envelopeByteSize(envelope);
    } catch (error) {
      // No own-data JSON text, so there is nothing to submit: the transport's
      // door (`encodeEnvelope`) refuses the same value one step later, and
      // round-1 H3 says every unsuccessful submission halts. Halting HERE keeps
      // this method's promise that the caller's socket callback is never blown
      // up — at base `JSON.stringify`'s `TypeError` for a bigint escaped
      // synchronously through `dispatch()` into the feed driver — and the halt
      // is the one the transport's refusal produces, with the detail stating
      // what happened. Unreachable through the dispatcher today: every
      // envelope it hands here is the frozen domain registry's parse output.
      //
      // "The same verdict base reached" is bounded, and the bound is stated
      // rather than glossed (`SER-3` review round 1, L1): it holds where base's
      // serialization COMPLETED and the transport then applied its own door.
      // Where base could not serialize at all — an envelope admitted directly
      // at 5,000 levels, where `JSON.stringify` overflows the stack — base
      // threw a native `RangeError` synchronously out of this method with no
      // outcome and no halt, and this path halts terminally instead. That is a
      // genuine difference, and a better one; it is not an equivalence.
      // `test/unit/data-gateway/inherited-tojson.test.ts` measures both.
      return Promise.resolve(
        this.#rejectAndHalt(
          envelope,
          error,
          `the envelope has no own-data JSON text and was refused before submission (${envelope.ingestSeq})`,
        ),
      );
    }
    const depth = this.queueDepth;
    if (depth + 1 > this.#maxQueueDepth || this.#queueBytes + bytes > this.#maxQueueBytes) {
      this.#admissionRefusals += 1;
      const detail =
        `the publisher's admission queue is full (depth ${String(depth)}/${String(this.#maxQueueDepth)}, ` +
        `${String(this.#queueBytes)}/${String(this.#maxQueueBytes)} bytes, oldest entry ${String(this.oldestQueuedAgeMs())} ms old): ` +
        `the transport is not draining and the gateway will not hold unpublished events without bound`;
      // Halt BEFORE notifying: the observer callback re-enters this method
      // (the incident's own envelope goes through the same funnel), and it
      // must find the halted state already set so the recursion terminates.
      this.#haltNow({
        cause: "GATEWAY_PUBLISH_ADMISSION_OVERFLOW",
        detail,
        haltedAtIngestSeq: envelope.ingestSeq,
      });
      return Promise.resolve({ published: false, reason: "admission-queue-full", detail });
    }

    this.#highWaterMark = seq;
    let resolve: (outcome: PublishOutcome) => void = () => undefined;
    const settled = new Promise<PublishOutcome>((resolveOutcome) => {
      resolve = resolveOutcome;
    });
    this.#queue.push({
      envelope,
      bytes,
      admittedAtMs: this.#options.clock.nowMs(),
      resolve,
    });
    this.#queueBytes += bytes;
    const newDepth = this.queueDepth;
    if (newDepth > this.#queueMaxDepthObserved) this.#queueMaxDepthObserved = newDepth;
    if (this.#queueBytes > this.#queueMaxBytesObserved) {
      this.#queueMaxBytesObserved = this.#queueBytes;
    }
    this.#startPump();
    return settled;
  }

  /**
   * Halts publication without a submission having been attempted.
   *
   * The startup case (§4.2): the transport was unreachable when the process
   * came up. Recording must still start, so the gateway is built anyway and
   * this puts it in exactly the state a mid-run outage would — terminal halt,
   * PAGE incident, WAL untouched — instead of exiting and recording nothing.
   */
  haltPublication(cause: PublicationHaltCause, detail: string): void {
    if (this.#halt !== undefined) return;
    this.#haltNow({ cause, detail, haltedAtIngestSeq: "0" });
  }

  /** How long the oldest admitted-but-unsubmitted envelope has waited, in ms. */
  oldestQueuedAgeMs(): number {
    const head = this.#queue[this.#head];
    if (head === undefined) return 0;
    return Math.max(0, this.#options.clock.nowMs() - head.admittedAtMs);
  }

  /** Waits for every admitted publication to settle. */
  async settle(): Promise<void> {
    for (;;) {
      const pump = this.#pump;
      await pump;
      if (this.#pump === pump && this.queueDepth === 0) return;
    }
  }

  metrics(): GatewayPublisherMetrics {
    return {
      published: this.#published,
      duplicatesRefused: this.#duplicatesRefused,
      suppressedWhileHalted: this.#suppressedWhileHalted,
      rejectedByTransport: this.#rejectedByTransport,
      admissionRefusals: this.#admissionRefusals,
      halted: this.#halt !== undefined,
      halt: this.#halt,
      highWaterMark: this.#highWaterMark.toString(),
      queueDepth: this.queueDepth,
      queueMaxDepthObserved: this.#queueMaxDepthObserved,
      queueMaxDepth: this.#maxQueueDepth,
      queueBytes: this.#queueBytes,
      queueMaxBytesObserved: this.#queueMaxBytesObserved,
      queueMaxBytes: this.#maxQueueBytes,
      oldestQueuedAgeMs: this.oldestQueuedAgeMs(),
      submissions: this.#submissions,
      inFlight: this.#inFlight,
      largestSubmission: this.#largestSubmission,
    };
  }

  #suppress(halt: PublicationHalt): PublishOutcome {
    this.#suppressedWhileHalted += 1;
    return {
      published: false,
      reason: "publication-halted",
      detail: `publication halted (${halt.cause}); the event remains in the WAL`,
    };
  }

  #haltNow(halt: PublicationHalt): void {
    if (this.#halt !== undefined) return;
    this.#halt = halt;
    this.#options.onPublicationHalted?.(halt);
  }

  /**
   * Starts the pump if it is not already running.
   *
   * `#pumping` is cleared SYNCHRONOUSLY inside {@link #drainQueue}'s `finally`,
   * not in a `.then` on its promise. A caller awaiting the outcome of the last
   * entry resumes on a microtask scheduled before any `.then` here would run,
   * so a `.then` would leave `#pumping` true exactly when that caller enqueues
   * again — and its envelope would sit in the queue with no pump to drain it.
   */
  #startPump(): void {
    if (this.#pumping) return;
    this.#pumping = true;
    this.#pump = this.#drainQueue();
  }

  /**
   * Takes the consecutive run at the head of the queue: at least one entry
   * when any is queued, then more while the batch bounds allow. With no batch
   * capability the envelope bound is 1, so this is the old single dequeue.
   */
  #dequeueRun(): QueuedPublication[] {
    const run: QueuedPublication[] = [];
    let bytes = 0;
    while (run.length < this.#maxBatchEnvelopes) {
      const entry = this.#queue[this.#head];
      if (entry === undefined) break;
      if (run.length > 0 && bytes + entry.bytes > this.#maxBatchBytes) break;
      this.#head += 1;
      this.#queueBytes -= entry.bytes;
      bytes += entry.bytes;
      run.push(entry);
    }
    if (this.#head >= this.#queue.length) {
      this.#queue = [];
      this.#head = 0;
      this.#queueBytes = 0;
    }
    return run;
  }

  async #drainQueue(): Promise<void> {
    try {
      for (;;) {
        const run = this.#dequeueRun();
        if (run.length === 0) return;
        const halt = this.#halt;
        if (halt !== undefined) {
          // A halt is total: an entry admitted before the halt is suppressed
          // rather than published, so the stream has exactly one boundary.
          // (A submission already handed to the transport cannot be unsent;
          // that one entry — or that one batch — completes and is the last
          // thing in the stream.)
          for (const entry of run) entry.resolve(this.#suppress(halt));
          continue;
        }
        this.#submissions += 1;
        if (run.length > this.#largestSubmission) this.#largestSubmission = run.length;
        this.#inFlight = run.length;
        try {
          if (this.#batch === undefined) {
            await this.#submitOne(run[0] as QueuedPublication);
          } else {
            await this.#submitRun(this.#batch, run);
          }
        } finally {
          this.#inFlight = 0;
        }
      }
    } finally {
      this.#pumping = false;
    }
  }

  /** The per-envelope submission: the pre-`THROUGHPUT-1b` path, unchanged. */
  async #submitOne(entry: QueuedPublication): Promise<void> {
    try {
      const receipt = await this.#options.transport.publish(
        this.#options.stream,
        entry.envelope,
      );
      this.#published += 1;
      entry.resolve({ published: true, sequence: receipt.sequence });
    } catch (error) {
      entry.resolve(this.#onSubmissionFailure(entry.envelope, error));
    }
  }

  /**
   * One batched submission, settled in order: the published prefix resolves
   * published, the first unpublished envelope's failure HALTS exactly as a
   * failed single publish does, and every envelope after it is suppressed —
   * it was never attempted, and after the halt it never will be.
   */
  async #submitRun(batch: BatchPublishCapability, run: readonly QueuedPublication[]): Promise<void> {
    let receipts: readonly PublishReceipt[];
    let failure: BatchPublishFailure | undefined;
    try {
      const result = await batch.publishBatch(
        this.#options.stream,
        run.map((entry) => entry.envelope),
      );
      receipts = result.receipts;
      failure = result.failure;
    } catch (error) {
      // The contract says it never rejects; if it does, nothing is known to
      // have been published, so the run fails at its first envelope.
      receipts = [];
      failure = { index: 0, error };
    }

    // Only what the transport ACCOUNTED FOR counts as published: a receipt
    // below the failure index, within the run. Anything else is a failure at
    // the first envelope the result does not account for.
    const accounted = Math.min(receipts.length, run.length, failure?.index ?? run.length);
    for (let index = 0; index < accounted; index += 1) {
      const entry = run[index] as QueuedPublication;
      const receipt = receipts[index] as PublishReceipt;
      this.#published += 1;
      entry.resolve({ published: true, sequence: receipt.sequence });
    }
    if (accounted === run.length) return;

    const failedEntry = run[accounted] as QueuedPublication;
    const error =
      failure !== undefined && failure.index === accounted
        ? failure.error
        : new Error(
            `the transport accounted for ${String(receipts.length)} of ${String(run.length)} envelopes ` +
              `with a failure at ${failure === undefined ? "none" : String(failure.index)}; ` +
              `envelope ${String(accounted)} onward is treated as not published`,
          );
    failedEntry.resolve(this.#onSubmissionFailure(failedEntry.envelope, error));
    // `#onSubmissionFailure` has halted publication, so the rest of the run
    // is suppressed: never submitted, nothing appended after the failure.
    const halt = this.#halt as PublicationHalt;
    for (let index = accounted + 1; index < run.length; index += 1) {
      (run[index] as QueuedPublication).resolve(this.#suppress(halt));
    }
  }

  #onSubmissionFailure(envelope: EventEnvelope<unknown>, error: unknown): PublishOutcome {
    if (error instanceof EventBusUnavailableError) {
      const cause: PublicationHaltCause =
        error instanceof EventBusPublishQueueFullError
          ? "EVENT_BUS_PUBLISH_QUEUE_FULL"
          : "EVENT_BUS_UNAVAILABLE";
      this.#suppressedWhileHalted += 1;
      this.#haltNow({ cause, detail: error.message, haltedAtIngestSeq: envelope.ingestSeq });
      return {
        published: false,
        reason: cause === "EVENT_BUS_PUBLISH_QUEUE_FULL" ? "publication-halted" : "transport-unavailable",
        detail: error.message,
      };
    }
    // Round-1 H3: a non-outage refusal used to be counted and stepped over,
    // which loses the event and resumes mid-epoch. It halts now.
    return this.#rejectAndHalt(envelope, error, `the transport refused (${envelope.ingestSeq})`);
  }

  /**
   * A non-outage refusal of ONE envelope halts publication terminally
   * (round-1 H3) — whether the transport refused it, or the admission
   * encoder refused it before the transport saw it (`SER-3`; the same
   * encoder, so the transport would have). `what` states which, for the
   * operator; the outcome vocabulary and the metric are the closed ones every
   * dashboard already reads, and `GATEWAY_PUBLISH_REJECTED` is documented as
   * exactly this class ("a bad envelope").
   */
  #rejectAndHalt(envelope: EventEnvelope<unknown>, error: unknown, what: string): PublishOutcome {
    this.#rejectedByTransport += 1;
    const detail = error instanceof Error ? error.message : String(error);
    this.#options.onPublishRejected?.({ ingestSeq: envelope.ingestSeq, detail });
    this.#haltNow({
      cause: "GATEWAY_PUBLISH_REJECTED",
      detail: `${what}: ${detail}`,
      haltedAtIngestSeq: envelope.ingestSeq,
    });
    return { published: false, reason: "transport-rejected", detail };
  }
}
