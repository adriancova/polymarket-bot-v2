/**
 * `THROUGHPUT-1a` — the transport-lag sampler: the health surface's
 * `transport` section (`TransportHealth`, `packages/trading-core/src/health.ts`)
 * for a process that reads a real event stream.
 *
 * ## What H1 run 1 could not see
 *
 * The trader ran three minutes behind a live market and its health read
 * `consumerLag 0` — the INGEST queue's lag, which a pump that drains every
 * batch keeps at zero however far behind the STREAM it is. Retention then
 * removed events it had not read, and it halted `TRANSPORT_RESYNC_REQUIRED`
 * with nothing having warned anyone. This module measures the stream side.
 *
 * ## How, and what it costs
 *
 * It reads the subscription's own §8.3 metric set (`EventSubscription.metrics`,
 * `packages/event-bus`): the stream's publication total (the HEAD), this
 * consumer's lag behind it (delivered position), its uncheckpointed count
 * (committed position) and the retention bound. No new transport surface, no
 * checkpoint token parsed.
 *
 * - **Cadence: bounded, not per event.** One sample every `intervalMs`
 *   ({@link TRANSPORT_SAMPLE_INTERVAL_MS}, 1 s, by default), on an `unref`'d
 *   timer, and never two in flight. One sample is the subscription's metrics
 *   read: three Redis round trips on the transport's COMMAND connection (the
 *   stream-state script, the stored-positions hash, one position judgement per
 *   stored consumer) — never the blocking-read connection the pump receives
 *   on.
 * - **Off the pump's path.** Nothing here is awaited by `poll`, `drain` or
 *   `commit`, so a slow or failing sample cannot slow the loop or change when
 *   a halt latches. A failed sample is COUNTED (`sampleFailures`), never a
 *   halt: the pump's own reads and commits decide §4.2's halts exactly as
 *   before. `stop()` does not wait for an in-flight sample either, so a
 *   shutdown during a Redis outage is not lengthened by it (`OUTAGE-1`'s 3T
 *   exit bound); the abandoned read settles against the closing connection
 *   and its answer is dropped.
 * - **Timer-driven, not poll-driven**, so the numbers keep moving while the
 *   process is far behind — which is exactly when they matter. The timer
 *   fires whenever the process yields to I/O: a drain's evaluations are one
 *   microtask chain, so at the latest between two receive batches (a batch is
 *   bounded by `receiveBatchSize`), and at every read or commit it awaits.
 *
 * The event-time lag is computed when the section is READ: the wall clock now
 * minus the `receivedAt` of the last event the loop processed (the loop's own
 * fact, handed in by `HealthState`). The core reads its `Clock` port at
 * admission (ADR-031: an entry is refused once the trader lags its stream past
 * the features bound, or reaches the entry cutoff), and under ADR-023's
 * `CONNECTION_CONFIRMED` for book freshness (D7). This module is still the
 * only place the process's wall clock enters the health surface.
 */

import type { ConsumerMetrics } from "@polymarket-bot/event-bus";
import type { TransportHealth, TransportHealthSource } from "@polymarket-bot/trading-core";

/** The default sampling cadence, in milliseconds. */
export const TRANSPORT_SAMPLE_INTERVAL_MS = 1_000;

/** The accepted cadence range: at most ten samples a second, at least one a minute. */
export const TRANSPORT_SAMPLE_INTERVAL_RANGE = Object.freeze({ minimumMs: 100, maximumMs: 60_000 });

/** The one subscription method the sampler reads. */
export interface TransportMetricsReader {
  metrics(): Promise<ConsumerMetrics>;
}

export interface TransportLagSamplerOptions {
  readonly subscription: TransportMetricsReader;
  /** Sampling cadence in ms; {@link TRANSPORT_SAMPLE_INTERVAL_MS} when omitted. */
  readonly intervalMs?: number;
  /** The wall clock, epoch milliseconds; `Date.now` when omitted. */
  readonly nowMs?: () => number;
}

/** One successful sample, as read. */
interface Sample {
  readonly atMs: number;
  readonly headPosition: number;
  readonly consumerPosition: number;
  readonly committedPosition: number;
  readonly entriesBehindHead: number;
  readonly retentionMaxEvents: number;
}

/**
 * The pure computation: one metrics read → the positions it implies.
 *
 * `consumerLag` is `publishedTotal − delivered` and `uncheckpointedCount` is
 * `delivered − committed` (`packages/event-bus` `metrics.ts`), so both
 * positions follow without arithmetic on anything but those counts.
 */
export function sampleFromMetrics(metrics: ConsumerMetrics, atMs: number): Sample {
  const headPosition = metrics.queue.publishedTotal;
  const consumerPosition = Math.max(0, headPosition - metrics.consumerLag);
  return {
    atMs,
    headPosition,
    consumerPosition,
    committedPosition: Math.max(0, consumerPosition - metrics.uncheckpointedCount),
    entriesBehindHead: metrics.consumerLag,
    retentionMaxEvents: metrics.queue.maximumDepth,
  };
}

/**
 * The section, from the latest sample (if any), the loop's last event instant
 * and the wall clock now. Pure. Ages are clamped at zero: a wall clock that
 * reads behind an event's `receivedAt` (a gateway on another host) is
 * reported as no lag, never as a negative one.
 */
export function transportHealthOf(input: {
  readonly intervalMs: number;
  readonly samples: number;
  readonly sampleFailures: number;
  readonly latest: Sample | undefined;
  readonly lastEventAt: string | null;
  readonly nowMs: number;
}): TransportHealth {
  const { latest } = input;
  const lastEventMs = input.lastEventAt === null ? Number.NaN : Date.parse(input.lastEventAt);
  return Object.freeze({
    attached: true,
    sampleIntervalMs: input.intervalMs,
    samples: input.samples,
    sampleFailures: input.sampleFailures,
    sampledAt: latest === undefined ? null : new Date(latest.atMs).toISOString(),
    sampleAgeMs: latest === undefined ? null : Math.max(0, input.nowMs - latest.atMs),
    headPosition: latest?.headPosition ?? null,
    consumerPosition: latest?.consumerPosition ?? null,
    committedPosition: latest?.committedPosition ?? null,
    entriesBehindHead: latest?.entriesBehindHead ?? null,
    retentionMaxEvents: latest?.retentionMaxEvents ?? null,
    lastEventAt: input.lastEventAt,
    eventTimeLagMs: Number.isFinite(lastEventMs) ? Math.max(0, input.nowMs - lastEventMs) : null,
  });
}

export class TransportLagSampler implements TransportHealthSource {
  readonly intervalMs: number;
  readonly #subscription: TransportMetricsReader;
  readonly #nowMs: () => number;
  #timer: ReturnType<typeof setInterval> | undefined;
  #inFlight = false;
  #stopped = false;
  #samples = 0;
  #failures = 0;
  #latest: Sample | undefined;

  constructor(options: TransportLagSamplerOptions) {
    const intervalMs = options.intervalMs ?? TRANSPORT_SAMPLE_INTERVAL_MS;
    const { minimumMs, maximumMs } = TRANSPORT_SAMPLE_INTERVAL_RANGE;
    if (!Number.isSafeInteger(intervalMs) || intervalMs < minimumMs || intervalMs > maximumMs) {
      throw new RangeError(
        `the transport sample interval must be an integer number of ms in [${String(minimumMs)}, ` +
          `${String(maximumMs)}], received ${String(intervalMs)}`,
      );
    }
    this.intervalMs = intervalMs;
    this.#subscription = options.subscription;
    this.#nowMs = options.nowMs ?? Date.now;
  }

  /** Starts sampling: one sample now, then one per interval. Idempotent. */
  start(): void {
    if (this.#timer !== undefined || this.#stopped) return;
    this.#trigger();
    this.#timer = setInterval(() => {
      this.#trigger();
    }, this.intervalMs);
    this.#timer.unref();
  }

  /**
   * Stops sampling. Does NOT wait for an in-flight sample (see the module
   * header); its answer, if one ever arrives, is dropped.
   */
  stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** Takes one sample now and resolves when it settled. For tests and the first read. Never rejects. */
  async sampleNow(): Promise<void> {
    if (this.#stopped) return;
    let metrics: ConsumerMetrics;
    try {
      metrics = await this.#subscription.metrics();
    } catch {
      if (!this.#stopped) this.#failures += 1;
      return;
    }
    if (this.#stopped) return;
    this.#latest = sampleFromMetrics(metrics, this.#nowMs());
    this.#samples += 1;
  }

  transportHealth(lastEventAt: string | null): TransportHealth {
    return transportHealthOf({
      intervalMs: this.intervalMs,
      samples: this.#samples,
      sampleFailures: this.#failures,
      latest: this.#latest,
      lastEventAt,
      nowMs: this.#nowMs(),
    });
  }

  #trigger(): void {
    if (this.#inFlight || this.#stopped) return;
    this.#inFlight = true;
    void this.sampleNow().finally(() => {
      this.#inFlight = false;
    });
  }
}
