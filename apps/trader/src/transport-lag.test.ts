/**
 * `THROUGHPUT-1a` — the transport-lag computation and the sampler's contract,
 * without a server: the positions a metrics read implies, the section's
 * absent-versus-zero rule, the event-time lag against the wall clock, and the
 * sampler's cadence rules (bounded, never two in flight, a failed sample
 * counted and never thrown, `stop()` not waiting on an in-flight read).
 *
 * The Redis-backed half — lag RISING while the trader is paused and FALLING
 * once it catches up, through the real subscription — is
 * `test/integration/paper-trader/transport-lag-postgres-redis.test.ts`.
 */

import type { ConsumerMetrics } from "@polymarket-bot/event-bus";
import { HealthState, unattachedTransportHealth } from "@polymarket-bot/trading-core";
import { describe, expect, it } from "vitest";

import {
  TRANSPORT_SAMPLE_INTERVAL_MS,
  TransportLagSampler,
  sampleFromMetrics,
  transportHealthOf,
  type TransportMetricsReader,
} from "./transport-lag.js";

function metrics(overrides: {
  readonly publishedTotal: number;
  readonly consumerLag: number;
  readonly uncheckpointedCount: number;
  readonly maximumDepth?: number;
}): ConsumerMetrics {
  return {
    stream: "s",
    consumerId: "c",
    queue: {
      stream: "s",
      currentDepth: 0,
      maximumDepth: overrides.maximumDepth ?? 100_000,
      oldestMessageAgeMs: 0,
      messagesDropped: 0,
      producerBlockedTimeMs: 0,
      publishQueueDepth: 0,
      publishQueueMaxDepth: 1024,
      oldestQueuedPublishAgeMs: 0,
      consumerLag: [],
      publishedTotal: overrides.publishedTotal,
      publishFailures: 0,
      retentionTrimFailures: 0,
      unreadableCheckpoints: 0,
    },
    consumerLag: overrides.consumerLag,
    uncheckpointedCount: overrides.uncheckpointedCount,
    deliveredTotal: 0,
    hardResyncTotal: 0,
    missedEventsTotal: 0,
    nonMonotonicDeliveries: 0,
    unreadableEntriesTotal: 0,
    receiveWaitTimeMs: 0,
    resyncPending: false,
  };
}

/** A reader whose answers the test releases one at a time. */
class GatedReader implements TransportMetricsReader {
  calls = 0;
  readonly #pending: { resolve: (value: ConsumerMetrics) => void; reject: (cause: Error) => void }[] = [];

  async metrics(): Promise<ConsumerMetrics> {
    this.calls += 1;
    return await new Promise<ConsumerMetrics>((resolve, reject) => {
      this.#pending.push({ resolve, reject });
    });
  }

  answer(value: ConsumerMetrics): void {
    this.#pending.shift()?.resolve(value);
  }

  fail(): void {
    this.#pending.shift()?.reject(new Error("the transport did not answer"));
  }
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe("sampleFromMetrics — the positions one metrics read implies", () => {
  it("derives the delivered and committed positions from the lag counts alone", () => {
    const sample = sampleFromMetrics(
      metrics({ publishedTotal: 1_000, consumerLag: 250, uncheckpointedCount: 40, maximumDepth: 5_000 }),
      1_700_000_000_000,
    );
    expect(sample).toEqual({
      atMs: 1_700_000_000_000,
      headPosition: 1_000,
      consumerPosition: 750,
      committedPosition: 710,
      entriesBehindHead: 250,
      retentionMaxEvents: 5_000,
    });
  });

  it("never reports a negative position", () => {
    const sample = sampleFromMetrics(metrics({ publishedTotal: 3, consumerLag: 5, uncheckpointedCount: 9 }), 0);
    expect(sample.consumerPosition).toBe(0);
    expect(sample.committedPosition).toBe(0);
  });
});

describe("transportHealthOf — absent is null, never zero", () => {
  const latest = sampleFromMetrics(metrics({ publishedTotal: 10, consumerLag: 4, uncheckpointedCount: 1 }), 5_000);

  it("reports every measured field null before the first sample and the first event", () => {
    const section = transportHealthOf({
      intervalMs: 1_000,
      samples: 0,
      sampleFailures: 2,
      latest: undefined,
      lastEventAt: null,
      nowMs: 9_000,
    });
    expect(section).toEqual({
      attached: true,
      sampleIntervalMs: 1_000,
      samples: 0,
      sampleFailures: 2,
      sampledAt: null,
      sampleAgeMs: null,
      headPosition: null,
      consumerPosition: null,
      committedPosition: null,
      entriesBehindHead: null,
      retentionMaxEvents: null,
      lastEventAt: null,
      eventTimeLagMs: null,
    });
  });

  it("measures the event-time lag against the wall clock at READ time, and the sample's age", () => {
    const at = "2026-09-29T21:02:06.584Z";
    const section = transportHealthOf({
      intervalMs: 1_000,
      samples: 1,
      sampleFailures: 0,
      latest,
      lastEventAt: at,
      nowMs: Date.parse(at) + 3_210,
    });
    expect(section.eventTimeLagMs).toBe(3_210);
    expect(section.sampledAt).toBe(new Date(5_000).toISOString());
    expect(section.sampleAgeMs).toBe(Date.parse(at) + 3_210 - 5_000);
    expect(section.entriesBehindHead).toBe(4);
    expect(section.headPosition).toBe(10);
    expect(section.consumerPosition).toBe(6);
    expect(section.committedPosition).toBe(5);
  });

  it("clamps a wall clock behind the event (another host's clock) to no lag, not a negative one", () => {
    const at = "2026-09-29T21:02:06.584Z";
    const section = transportHealthOf({
      intervalMs: 1_000,
      samples: 1,
      sampleFailures: 0,
      latest,
      lastEventAt: at,
      nowMs: Date.parse(at) - 50,
    });
    expect(section.eventTimeLagMs).toBe(0);
  });
});

describe("TransportLagSampler — bounded, off the pump's path, never throwing", () => {
  it("refuses a cadence outside [100, 60000] ms, and defaults to one second", () => {
    const reader = new GatedReader();
    expect(() => new TransportLagSampler({ subscription: reader, intervalMs: 50 })).toThrow(RangeError);
    expect(() => new TransportLagSampler({ subscription: reader, intervalMs: 60_001 })).toThrow(RangeError);
    expect(new TransportLagSampler({ subscription: reader }).intervalMs).toBe(TRANSPORT_SAMPLE_INTERVAL_MS);
    expect(TRANSPORT_SAMPLE_INTERVAL_MS).toBe(1_000);
  });

  it("takes one sample at start, and never has two in flight", async () => {
    const reader = new GatedReader();
    let now = 1_000;
    const sampler = new TransportLagSampler({ subscription: reader, intervalMs: 100, nowMs: () => now });
    sampler.start();
    expect(reader.calls).toBe(1);
    // The interval elapses while the first read is still unanswered: no second read.
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(reader.calls).toBe(1);
    now = 2_000;
    reader.answer(metrics({ publishedTotal: 50, consumerLag: 20, uncheckpointedCount: 3 }));
    await settle();
    const section = sampler.transportHealth("1970-01-01T00:00:01.500Z");
    expect(section.samples).toBe(1);
    expect(section.entriesBehindHead).toBe(20);
    expect(section.eventTimeLagMs).toBe(500);
    sampler.stop();
  });

  it("counts a failed read and keeps the last good sample; nothing throws", async () => {
    const reader = new GatedReader();
    const sampler = new TransportLagSampler({ subscription: reader, intervalMs: 100, nowMs: () => 10 });
    const first = sampler.sampleNow();
    reader.answer(metrics({ publishedTotal: 9, consumerLag: 2, uncheckpointedCount: 0 }));
    await first;
    const second = sampler.sampleNow();
    reader.fail();
    await expect(second).resolves.toBeUndefined();
    const section = sampler.transportHealth(null);
    expect(section.samples).toBe(1);
    expect(section.sampleFailures).toBe(1);
    expect(section.entriesBehindHead).toBe(2);
  });

  it("stop() does not wait for an in-flight read, and drops its late answer", async () => {
    const reader = new GatedReader();
    const sampler = new TransportLagSampler({ subscription: reader, intervalMs: 100, nowMs: () => 10 });
    sampler.start();
    expect(reader.calls).toBe(1);
    sampler.stop();
    reader.answer(metrics({ publishedTotal: 9, consumerLag: 9, uncheckpointedCount: 0 }));
    await settle();
    const section = sampler.transportHealth(null);
    expect(section.samples).toBe(0);
    expect(section.entriesBehindHead).toBeNull();
    // Stopped: no further reads, ever.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(reader.calls).toBe(1);
  });
});

describe("HealthState — the section on the health surface", () => {
  const state = (): HealthState => new HealthState({ runMode: "PAPER", maximumRunMode: "PAPER" });
  const input = {
    asOf: "2026-09-29T21:02:06.584Z",
    halts: [],
    queues: [],
    seams: {
      fills: { remembered: 0, maximumRemembered: 1, admitted: 0, refused: 0, evictions: 0 },
      reservations: { open: 0, taken: 0, released: 0, reservedCollateral: "0" },
      cancels: { pending: 0, requested: 0, confirmed: 0, rejected: 0, silenceExceeded: 0 },
      orderViews: { emitted: 0, repeats: 0, tracked: 0 },
      allocator: { open: 0, applied: 0, released: 0, reservedCollateral: "0", refusalsByCode: {} },
    },
  } as const;

  it("reports the unattached section — and no last event — before anything is processed", () => {
    expect(state().snapshot(input).transport).toEqual(unattachedTransportHealth(null));
  });

  it("names the loop's instant as the last event once one was processed, attached or not", () => {
    const health = state();
    health.countLoop("eventsProcessed");
    expect(health.snapshot(input).transport).toEqual(unattachedTransportHealth(input.asOf));

    const reader = new GatedReader();
    const sampler = new TransportLagSampler({
      subscription: reader,
      intervalMs: 100,
      nowMs: () => Date.parse(input.asOf) + 750,
    });
    health.attachTransport(sampler);
    const attached = health.snapshot(input).transport;
    expect(attached.attached).toBe(true);
    expect(attached.lastEventAt).toBe(input.asOf);
    expect(attached.eventTimeLagMs).toBe(750);
  });
});
