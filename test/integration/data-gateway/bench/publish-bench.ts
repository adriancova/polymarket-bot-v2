/**
 * The gateway publish benchmark (`THROUGHPUT-1b` item 1): the library half.
 *
 * WHAT IT DRIVES. The REAL `GatewayPublisher` over the REAL
 * `RedisStreamsEventTransport`, against a real Redis, with the publisher's
 * DEFAULT admission bounds unless a caller overrides them. Nothing is mocked:
 * the envelopes go through the publisher's admission (the byte bound's
 * encode), its pump, the transport's envelope door, and the server-side
 * publish script, exactly as they do in `apps/data-gateway/src/main.ts`.
 *
 * WHAT IT DOES NOT DRIVE. The rest of the gateway: no socket, no frame
 * parsing, no WAL, no `completeEnvelope`. Those share the gateway's event loop
 * with the publisher in production, so a live gateway has LESS time per
 * second for publication than this harness does; a rate measured here is a
 * ceiling for the publish path, not a claim about the whole process.
 *
 * THE INPUT. Recorded normalized envelopes (one JSON document per line, as
 * the H1 run's stream held them), re-stamped with ONE epoch and strictly
 * increasing `ingestSeq` (1, 2, 3, ...), so each run is a fresh, well-formed
 * epoch whatever the recording's own identities were. Every other field is
 * carried byte for byte, in its recorded key order.
 *
 * HOW LOAD IS OFFERED.
 * - A fixed offered rate R: envelope `i` becomes due `i / R` seconds after the
 *   start. The driver admits everything due, in order, synchronously (as the
 *   dispatcher does), then yields to the event loop for about a millisecond.
 *   So arrivals come in small bursts, which is how venue frames arrive.
 * - `"saturate"`: the unthrottled ceiling. With the default bounds an
 *   unthrottled producer overflows the admission queue by construction (1,025
 *   envelopes admitted in one turn), which measures nothing. The ceiling is
 *   therefore closed-loop: the driver keeps the admission queue topped up to
 *   half its depth bound and yields with `setImmediate`, so the publisher is
 *   never idle and never overflows. The rate it sustains is the most the
 *   publish path can drain.
 *
 * Offering stops at the first halt: every later envelope would be suppressed
 * anyway, and the halt is the result.
 *
 * WHICH CLOCK A SCHEDULE RUNS ON (`FLAKES-1`). By default a numeric rate is
 * scheduled on the wall clock, as above. A caller may instead ask for the
 * `runnable` clock ({@link ScheduleClock}): the wall clock minus the time the
 * driving thread spent waiting for a CPU. The command-line benchmark never
 * asks for it, so its reports are unchanged.
 */

import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

import type { EventEnvelope } from "@polymarket-bot/domain";
import type { GatewayClock, GatewayPublisherMetrics, PublicationHalt } from "@polymarket-bot/data-gateway";
import { GatewayPublisher } from "@polymarket-bot/data-gateway";
import type { MarketEventTransport } from "@polymarket-bot/event-bus";

/** An offered load: events per second, or the closed-loop ceiling. */
export type OfferedRate = number | "saturate";

/**
 * How a numeric offered rate is spread over time.
 *
 * - `uniform`: envelope `i` is due `i / R` seconds after the start.
 * - `recorded`: envelope `i` is due at its RECORDED receipt instant
 *   (`receivedMonotonicNs`, relative to the first), with the whole timeline
 *   scaled so the mean rate is R. At the recording's own mean rate this
 *   replays the burst as the gateway received it — its busiest second, its
 *   busiest 250 ms — and a higher R compresses the same shape.
 */
export type Pacing = "uniform" | "recorded";

/**
 * The clock a numeric offered rate's schedule runs on (`FLAKES-1`).
 *
 * - `wall` (the default): envelope `i` is offered once its due time has passed
 *   on the wall clock, measured from the start.
 * - `runnable`: the same, minus the time this thread spent RUNNABLE BUT NOT
 *   RUNNING, waiting on the host's run queue for a CPU. Linux counts that per
 *   thread as `run_delay`, the second field of `/proc/thread-self/schedstat`
 *   ({@link threadRunQueueWaitMs}).
 *
 * Why `runnable` exists. The driver and the publisher share ONE thread. On a
 * host saturated by other work, that thread can wait tens of milliseconds for
 * a CPU. Neither can run in that gap, yet the wall-clock schedule keeps
 * advancing. When the thread runs again, the driver admits the whole gap's
 * envelopes in one synchronous turn: measured at 20 busy processes on a
 * 24-thread host, single turns of 666 envelopes and a queue high-water of 969
 * of 1,024. That burst measures the host, not the publish path.
 *
 * What `runnable` does not excuse. The run-queue wait is time the thread
 * could not run at all, so nothing the publisher does can create it on a host
 * with a free CPU. The thread's own work still counts in full: CPU time spent
 * encoding or parsing, a garbage-collection pause, a synchronous call that
 * blocks the thread. So does every wait for Redis or the network. On a host
 * with headroom the wait stays near zero (0.2-1.7 ms over a 450 ms replay,
 * measured) and the two clocks agree. Where the host does not report the wait,
 * `runnable` falls back to `wall`, the stricter clock, and the result says so
 * ({@link PublishBenchResult.scheduleClock}).
 */
export type ScheduleClock = "wall" | "runnable";

/** Linux's per-thread scheduler statistics: on-CPU ns, run-queue wait ns, timeslices. */
const THREAD_SCHEDSTAT = "/proc/thread-self/schedstat";

/**
 * This thread's cumulative run-queue wait in ms (`run_delay`, see
 * {@link ScheduleClock}), or `undefined` where the host does not report it.
 */
export function threadRunQueueWaitMs(): number | undefined {
  let text: string;
  try {
    text = readFileSync(THREAD_SCHEDSTAT, "utf8");
  } catch {
    return undefined;
  }
  const field = text.trim().split(/\s+/u)[1];
  if (field === undefined || !/^[0-9]{1,18}$/u.test(field)) return undefined;
  return Number(field) / 1e6;
}

export interface PublishBenchOptions {
  readonly transport: MarketEventTransport;
  readonly stream: string;
  /** Already re-stamped (see {@link restampEnvelopes}). */
  readonly envelopes: readonly EventEnvelope<unknown>[];
  readonly offeredRate: OfferedRate;
  /** Ignored for `"saturate"`. Defaults to `uniform`. */
  readonly pacing?: Pacing;
  /** Ignored for `"saturate"`. Defaults to `wall` (see {@link ScheduleClock}). */
  readonly scheduleClock?: ScheduleClock;
  /** Omitted: the publisher's default bound, which is what the benchmark is for. */
  readonly maxQueueDepth?: number;
  /** Omitted: the publisher's default bound. */
  readonly maxQueueBytes?: number;
  /**
   * Called once, synchronously, right after envelope `index` was admitted.
   * The stall tests use it to take the transport away at a known point.
   */
  readonly afterAdmit?: (index: number) => void;
  /**
   * Called once, synchronously, when publication halts: the publisher's own
   * `onPublicationHalted`. The stall test brings its frozen hop back here, so
   * the run the hop holds cannot complete before the halt (`WALCAP-1`).
   */
  readonly onPublicationHalted?: (halt: PublicationHalt) => void;
}

export interface PublishBenchResult {
  readonly offeredRate: OfferedRate;
  readonly pacing: Pacing;
  /**
   * The clock the schedule really ran on: `wall` for `"saturate"`, for a
   * caller that did not ask for `runnable`, and where the host does not
   * report run-queue waits.
   */
  readonly scheduleClock: ScheduleClock;
  /**
   * How far the `runnable` schedule fell behind the wall clock: the driving
   * thread's run-queue wait between the first and the last offer, in ms.
   * Always 0 on the `wall` clock.
   */
  readonly runQueueWaitMs: number;
  readonly envelopes: number;
  /** `enqueue()` calls made; less than `envelopes` when publication halted. */
  readonly offered: number;
  readonly published: number;
  /** Envelopes whose outcome was anything but published. */
  readonly notPublished: number;
  readonly overflowed: boolean;
  readonly halt: PublicationHalt | undefined;
  /** First admission to the last settled outcome. */
  readonly elapsedMs: number;
  /** First admission to the last admission. */
  readonly offerElapsedMs: number;
  /** `offered` over `offerElapsedMs`: the load the driver really offered. */
  readonly achievedOfferRate: number;
  /** `published` over `elapsedMs`: what the publish path sustained. */
  readonly sustainedPublishRate: number;
  readonly queueMaxDepthObserved: number;
  readonly queueMaxDepth: number;
  readonly queueMaxBytesObserved: number;
  readonly queueMaxBytes: number;
  /**
   * Transport round trips the publisher made, when its metrics report them
   * (`submissions`); `undefined` for a publisher that does not.
   */
  readonly submissions: number | undefined;
  readonly metrics: GatewayPublisherMetrics;
}

/** Parses one JSON envelope per non-empty line. */
export function parseEnvelopeLines(text: string): EventEnvelope<unknown>[] {
  const envelopes: EventEnvelope<unknown>[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    envelopes.push(JSON.parse(line) as EventEnvelope<unknown>);
  }
  return envelopes;
}

/**
 * One epoch, `ingestSeq` 1..n, every other field and its key order untouched.
 *
 * The spread keeps `gatewayEpoch` and `ingestSeq` in their recorded positions
 * (overwriting an existing key does not move it), so two runs that re-stamp
 * the same input with the same epoch produce the same bytes.
 */
export function restampEnvelopes(
  envelopes: readonly EventEnvelope<unknown>[],
  gatewayEpoch: string,
): EventEnvelope<unknown>[] {
  return envelopes.map((envelope, index) => ({
    ...envelope,
    gatewayEpoch,
    ingestSeq: String(index + 1),
  }));
}

/** The host's real clock, as the gateway's `systemGatewayClock()` provides it. */
export function benchClock(): GatewayClock {
  return {
    nowMs: () => Date.now(),
    monotonicNs: () => process.hrtime.bigint(),
  };
}

/**
 * Each envelope's due time in ms after the start, for a numeric offered rate.
 *
 * Recorded pacing needs strictly usable receipt stamps; a fixture without them
 * is refused rather than silently replayed uniformly.
 */
export function dueTimesMs(
  envelopes: readonly EventEnvelope<unknown>[],
  rate: number,
  pacing: Pacing,
): Float64Array {
  const due = new Float64Array(envelopes.length);
  if (pacing === "uniform") {
    for (let index = 0; index < envelopes.length; index += 1) due[index] = (index / rate) * 1000;
    return due;
  }
  const first = envelopes[0];
  const last = envelopes[envelopes.length - 1];
  if (first === undefined || last === undefined) return due;
  const origin = BigInt(first.receivedMonotonicNs);
  const spanMs = Number(BigInt(last.receivedMonotonicNs) - origin) / 1e6;
  if (!(spanMs > 0)) {
    throw new Error("recorded pacing needs receipt instants that span a positive interval");
  }
  // Scale the recorded timeline so its mean rate becomes `rate`.
  const recordedRate = ((envelopes.length - 1) / spanMs) * 1000;
  const scale = recordedRate / rate;
  let previous = 0;
  for (let index = 0; index < envelopes.length; index += 1) {
    const envelope = envelopes[index];
    if (envelope === undefined) continue;
    const atMs = (Number(BigInt(envelope.receivedMonotonicNs) - origin) / 1e6) * scale;
    if (atMs < previous) {
      throw new Error(`recorded pacing needs non-decreasing receipt instants (index ${String(index)})`);
    }
    due[index] = atMs;
    previous = atMs;
  }
  return due;
}

function yieldToTimers(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 1);
  });
}

function yieldToIo(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/** Runs one offered load through the real publisher and reports what it did. */
export async function runPublishBench(options: PublishBenchOptions): Promise<PublishBenchResult> {
  const publisher = new GatewayPublisher({
    transport: options.transport,
    stream: options.stream,
    clock: benchClock(),
    ...(options.maxQueueDepth === undefined ? {} : { maxQueueDepth: options.maxQueueDepth }),
    ...(options.maxQueueBytes === undefined ? {} : { maxQueueBytes: options.maxQueueBytes }),
    ...(options.onPublicationHalted === undefined ? {} : { onPublicationHalted: options.onPublicationHalted }),
  });
  const envelopes = options.envelopes;
  const total = envelopes.length;
  let published = 0;
  let notPublished = 0;
  const outcomes: Promise<void>[] = [];
  let next = 0;

  const admit = (): void => {
    const index = next;
    next += 1;
    const envelope = envelopes[index];
    if (envelope === undefined) return;
    outcomes.push(
      publisher.enqueue(envelope).then((outcome) => {
        if (outcome.published) published += 1;
        else notPublished += 1;
      }),
    );
    options.afterAdmit?.(index);
  };

  const startedAt = performance.now();
  let scheduleClock: ScheduleClock = "wall";
  let runQueueWaitMs = 0;
  if (options.offeredRate === "saturate") {
    const target = Math.max(1, Math.floor(publisher.metrics().queueMaxDepth / 2));
    while (next < total && !publisher.halted) {
      while (next < total && !publisher.halted && publisher.queueDepth < target) admit();
      await yieldToIo();
    }
  } else {
    const rate = options.offeredRate;
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new Error(`offered rate must be a positive number of events per second, received ${String(rate)}`);
    }
    const due = dueTimesMs(envelopes, rate, options.pacing ?? "uniform");
    const waitAtStart = options.scheduleClock === "runnable" ? threadRunQueueWaitMs() : undefined;
    if (waitAtStart !== undefined) scheduleClock = "runnable";
    while (next < total && !publisher.halted) {
      if (waitAtStart !== undefined) {
        // Monotone: a reading that fails mid-run keeps the last good one.
        const waitedNow = threadRunQueueWaitMs();
        if (waitedNow !== undefined) runQueueWaitMs = Math.max(runQueueWaitMs, waitedNow - waitAtStart);
      }
      const elapsedMs = performance.now() - startedAt - runQueueWaitMs;
      while (next < total && !publisher.halted && (due[next] ?? Infinity) <= elapsedMs) admit();
      await yieldToTimers();
    }
  }
  const offerEndedAt = performance.now();
  await Promise.all(outcomes);
  await publisher.settle();
  const endedAt = performance.now();

  const metrics = publisher.metrics();
  const elapsedMs = endedAt - startedAt;
  const offerElapsedMs = offerEndedAt - startedAt;
  const submissions = (metrics as GatewayPublisherMetrics & { readonly submissions?: number }).submissions;
  return {
    offeredRate: options.offeredRate,
    pacing: options.pacing ?? "uniform",
    scheduleClock,
    runQueueWaitMs,
    envelopes: total,
    offered: next,
    published,
    notPublished,
    overflowed: metrics.halt?.cause === "GATEWAY_PUBLISH_ADMISSION_OVERFLOW",
    halt: metrics.halt,
    elapsedMs,
    offerElapsedMs,
    achievedOfferRate: offerElapsedMs > 0 ? (next / offerElapsedMs) * 1000 : 0,
    sustainedPublishRate: elapsedMs > 0 ? (published / elapsedMs) * 1000 : 0,
    queueMaxDepthObserved: metrics.queueMaxDepthObserved,
    queueMaxDepth: metrics.queueMaxDepth,
    queueMaxBytesObserved: metrics.queueMaxBytesObserved,
    queueMaxBytes: metrics.queueMaxBytes,
    submissions,
    metrics,
  };
}
