import { describe, expect, it } from "vitest";

import { createMemoryFileSystem } from "@polymarket-bot/storage-wal/testing";

import { GatewayStateError } from "./errors.js";
import { GatewayJournal } from "./journal.js";
import { takeReceipt } from "./ports.js";
import { IngestSequencer } from "./sequencer.js";
import { ManualGatewayClock } from "./testing/index.js";
import type { ObservingWalFileSystem } from "./testing/observing-file-system.js";
import { createObservingWalFileSystem } from "./testing/observing-file-system.js";

const EPOCH = "00000000-0000-4000-8000-0000000000aa";
const OTHER_EPOCH = "00000000-0000-4000-8000-0000000000bb";

/** Yields the microtask queue `turns` times, so queued continuations run. */
async function microturns(turns: number): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await Promise.resolve();
  }
}

/**
 * The `ingestSeq` of every frame in a segment a manifest names.
 *
 * `wal-format.md` §2: a segment with no manifest is UNVERIFIED and a compactor
 * must not consume it, so "recorded" means "in a segment that has a manifest".
 */
function manifestedIngestSeqs(fileSystem: ObservingWalFileSystem): readonly string[] {
  const snapshot = fileSystem.snapshot();
  const found: string[] = [];
  for (const [path, contents] of Object.entries(snapshot)) {
    if (!path.endsWith(".wal.jsonl")) continue;
    const manifestPath = `${path.slice(0, -".wal.jsonl".length)}.wal.manifest.json`;
    if (snapshot[manifestPath] === undefined) continue;
    for (const line of contents.split("\n")) {
      if (line === "") continue;
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null || "record" in parsed) continue;
      found.push((parsed as { ingestSeq: string }).ingestSeq);
    }
  }
  return found;
}

async function openJournal(overrides: { queueCapacity?: number } = {}) {
  const clock = new ManualGatewayClock();
  const fileSystem = createMemoryFileSystem();
  const sequencer = new IngestSequencer(EPOCH);
  const failures: { reason: string; detail: string }[] = [];
  const journal = await GatewayJournal.open({
    walRootPath: "/wal",
    fileSystem,
    clock,
    sequencer,
    ...(overrides.queueCapacity === undefined
      ? {}
      : { queueCapacity: overrides.queueCapacity }),
    onRecordingFailure: (failure) => failures.push(failure),
  });
  return { clock, fileSystem, sequencer, journal, failures };
}

function frameInput(clock: ManualGatewayClock, payload: string) {
  return {
    source: "binance",
    endpoint: "wss://example.test/stream",
    connectionId: "feed-a1",
    subscriptionGeneration: 1,
    receipt: takeReceipt(clock),
    payloadUtf8: payload,
  };
}

describe("GatewayJournal", () => {
  // Obligation 11 / wal-format §2: one epoch per WAL directory — the journal
  // opens the writer on <walRoot>/<gatewayEpoch>, so the WP-130 compactor can
  // never meet a mixed-epoch directory this gateway wrote.
  it("opens the writer on a per-epoch subdirectory", async () => {
    const { clock, fileSystem, journal } = await openJournal();
    const outcome = journal.record(frameInput(clock, "{\"hello\":1}"));
    expect(outcome.recorded).toBe(true);
    await journal.settle();
    const names = await fileSystem.listFileNames(`/wal/${EPOCH}`);
    expect(names.some((name) => name.endsWith(".wal.jsonl"))).toBe(true);
  });

  it("assigns each frame the next ingestSeq and records it verbatim", async () => {
    const { clock, journal } = await openJournal();
    const first = journal.record(frameInput(clock, "first"));
    const second = journal.record(frameInput(clock, "second"));
    expect(first.recorded && first.ingestSeq === "1").toBe(true);
    expect(second.recorded && second.ingestSeq === "2").toBe(true);
    await journal.settle();
    expect(journal.metrics().framesAccepted).toBe(2);
  });

  // §8.3 / WP-050 follow-up 4: a refused frame is a caller-owned halt signal,
  // not a drop. The refusal surfaces through the outcome AND the callback.
  it("surfaces a queue-overflow refusal instead of dropping", async () => {
    const { clock, journal, failures } = await openJournal({ queueCapacity: 1 });
    // Fill the queue without letting the scheduled drain run yet: enqueue two
    // synchronously in one microtask.
    const first = journal.record(frameInput(clock, "a"));
    const second = journal.record(frameInput(clock, "b"));
    expect(first.recorded).toBe(true);
    expect(second.recorded).toBe(false);
    if (second.recorded) return;
    expect(second.reason).toBe("queue-overflow");
    expect(failures).toHaveLength(1);
    expect(failures[0]?.reason).toBe("queue-overflow");
    await journal.settle();
  });

  // Obligation 1 (dedup identity): a re-enqueued pending frame keeps its
  // ORIGINAL (gatewayEpoch, ingestSeq); duplicates on the fault path stay
  // detectable by that key rather than becoming two facts.
  it("re-enqueues pending frames under their original identity", async () => {
    const { clock, journal } = await openJournal();
    const outcome = journal.record(frameInput(clock, "payload"));
    expect(outcome.recorded).toBe(true);
    if (!outcome.recorded) return;
    await journal.settle();

    const replayed = {
      gatewayEpoch: EPOCH,
      ingestSeq: outcome.ingestSeq,
      source: "binance",
      endpoint: "wss://example.test/stream",
      connectionId: "feed-a1",
      subscriptionGeneration: 1,
      receivedAt: "2026-08-30T12:00:00.000Z",
      receivedMonotonicNs: "1",
      payloadUtf8: "payload",
      payloadSha256: "239f59ed55e737c77147cf55ad0c1b030b6d7ee748a7426952f9b852d5a935e5",
    };
    const outcomes = journal.reenqueuePending([replayed]);
    expect(outcomes[0]?.recorded).toBe(true);
    expect(outcomes[0]?.ingestSeq).toBe(outcome.ingestSeq);
    await journal.settle();
  });

  it("refuses to re-enqueue a frame whose identity this epoch never assigned", async () => {
    const { clock, journal } = await openJournal();
    journal.record(frameInput(clock, "payload"));
    await journal.settle();
    expect(() =>
      journal.reenqueuePending([
        {
          gatewayEpoch: EPOCH,
          ingestSeq: "999",
          source: "binance",
          endpoint: "wss://example.test/stream",
          connectionId: "feed-a1",
          subscriptionGeneration: 1,
          receivedAt: "2026-08-30T12:00:00.000Z",
          receivedMonotonicNs: "1",
          payloadUtf8: "payload",
          payloadSha256:
            "239f59ed55e737c77147cf55ad0c1b030b6d7ee748a7426952f9b852d5a935e5",
        },
      ]),
    ).toThrow(GatewayStateError);
  });

  // wal-format §2: a frame from another epoch belongs to that epoch's own
  // directory; adopting it here would mint a second identity for one fact and
  // hand the compactor a mixed-epoch lineage.
  it("refuses to re-enqueue a frame from another epoch", async () => {
    const { journal } = await openJournal();
    expect(() =>
      journal.reenqueuePending([
        {
          gatewayEpoch: OTHER_EPOCH,
          ingestSeq: "1",
          source: "binance",
          endpoint: "wss://example.test/stream",
          connectionId: "feed-a1",
          subscriptionGeneration: 1,
          receivedAt: "2026-08-30T12:00:00.000Z",
          receivedMonotonicNs: "1",
          payloadUtf8: "payload",
          payloadSha256:
            "239f59ed55e737c77147cf55ad0c1b030b6d7ee748a7426952f9b852d5a935e5",
        },
      ]),
    ).toThrow(GatewayStateError);
  });

  it("closes cleanly, writing the final segment manifest", async () => {
    const { clock, fileSystem, journal } = await openJournal();
    journal.record(frameInput(clock, "x"));
    await journal.close();
    const names = await fileSystem.listFileNames(`/wal/${EPOCH}`);
    expect(names.some((name) => name.endsWith(".wal.manifest.json"))).toBe(true);
  });
});

/**
 * ROUND-1 REVIEW FINDING H1 — the journal's operation chain.
 *
 * `tick()` used to await the drain chain and then call `writer.tick()` OUTSIDE
 * it, so a frame that arrived while an fsync or a time-rotation was in flight
 * started a SECOND, concurrent writer operation. The WP-050 writer guards
 * `drain()` against `drain()` and nothing else, so the two overlapping
 * operations corrupted the writer's accountability state: the reviewer's probe
 * saw `framesDurable` above `framesAccepted`, and — during a rotation — a
 * frame that was BOTH named by a manifest and handed back in
 * `pendingFrames()`, which `wal-format.md` forbids (exactly one, always).
 *
 * Both probes are kept as permanent tests. Each drives a frame into the middle
 * of a slow writer operation and asserts two things: the filesystem never saw
 * two operations at once, and every accepted frame ends in exactly one of
 * manifest or pending.
 */
describe("GatewayJournal — one operation chain (round-1 review H1)", () => {
  async function openObservedJournal(overrides: {
    fsyncIntervalMs?: number;
    fsyncByteThreshold?: number;
    maxSegmentAgeMs?: number;
  }) {
    const clock = new ManualGatewayClock();
    const fileSystem = createObservingWalFileSystem();
    const sequencer = new IngestSequencer(EPOCH);
    const failures: { reason: string; detail: string }[] = [];
    const journal = await GatewayJournal.open({
      walRootPath: "/wal",
      fileSystem,
      clock,
      sequencer,
      ...overrides,
      onRecordingFailure: (failure) => failures.push(failure),
    });
    return { clock, fileSystem, journal, failures };
  }

  it("does not run a drain concurrently with a DELAYED FSYNC driven by tick()", async () => {
    const { clock, fileSystem, journal, failures } = await openObservedJournal({
      // Large byte threshold: a drain appends without fsyncing, so the tick is
      // the thing that fsyncs — which is the cadence the data-loss bound rests
      // on, and the operation the round-1 race ran into.
      fsyncByteThreshold: 1_000_000,
      fsyncIntervalMs: 1,
    });
    const first = journal.record(frameInput(clock, "first"));
    expect(first.recorded).toBe(true);
    await journal.settle();

    // The disk becomes slow exactly when the interval fsync fires.
    fileSystem.holdSyncs();
    clock.advance(10);
    const ticking = journal.tick();
    await microturns(4);

    // A frame arrives mid-fsync. This is the ordinary case — a live feed does
    // not pause for the recorder's cadence.
    const second = journal.record(frameInput(clock, "second"));
    expect(second.recorded).toBe(true);
    await microturns(4);

    fileSystem.releaseSyncs();
    await ticking;
    await journal.settle();

    // The defect, stated as the invariant it broke: two writer operations were
    // in flight at once, and the filesystem is where that is observable.
    expect(fileSystem.observations.maxConcurrentOperations).toBe(1);
    expect(journal.faulted).toBe(false);
    expect(failures).toEqual([]);

    const metrics = journal.metrics();
    expect(metrics.framesAccepted).toBe(2);
    // Durability can never outrun acceptance.
    expect(metrics.framesDurable).toBeLessThanOrEqual(metrics.framesAccepted);

    await journal.close();
    expect([...manifestedIngestSeqs(fileSystem)].sort()).toEqual(["1", "2"]);
    expect(journal.pendingFrames()).toHaveLength(0);
  });

  it("does not run a drain concurrently with a DELAYED TIME ROTATION", async () => {
    const { clock, fileSystem, journal, failures } = await openObservedJournal({
      fsyncByteThreshold: 1,
      fsyncIntervalMs: 1,
      maxSegmentAgeMs: 50,
    });
    const first = journal.record(frameInput(clock, "first"));
    expect(first.recorded).toBe(true);
    await journal.settle();

    // The segment is now old enough to rotate, and the rotation's fsync is
    // slow: footer append → fsync → manifest write is a multi-step operation.
    clock.advance(100);
    fileSystem.holdSyncs();
    const ticking = journal.tick();
    await microturns(4);

    // An ordinary second frame arrives while the rotation is in flight. In
    // round 1 this faulted the writer and produced a frame that was BOTH
    // manifested and pending.
    const second = journal.record(frameInput(clock, "second"));
    expect(second.recorded).toBe(true);
    await microturns(4);

    fileSystem.releaseSyncs();
    await ticking;
    await journal.settle();

    expect(fileSystem.observations.maxConcurrentOperations).toBe(1);
    expect(journal.faulted).toBe(false);
    expect(failures).toEqual([]);
    expect(journal.metrics().segmentsFinalized).toBe(1);

    await journal.close();

    // `wal-format.md`: every accepted frame is in EXACTLY ONE of manifest or
    // pending — never both, never neither.
    const manifested = manifestedIngestSeqs(fileSystem);
    const pending = journal.pendingFrames().map((frame) => frame.ingestSeq);
    for (const ingestSeq of ["1", "2"]) {
      const places =
        (manifested.includes(ingestSeq) ? 1 : 0) + (pending.includes(ingestSeq) ? 1 : 0);
      expect({ ingestSeq, places }).toEqual({ ingestSeq, places: 1 });
    }
    expect(manifested).toHaveLength(2);
  });

  it("serializes close() behind an in-flight tick rather than racing it", async () => {
    const { clock, fileSystem, journal } = await openObservedJournal({
      fsyncByteThreshold: 1_000_000,
      fsyncIntervalMs: 1,
    });
    journal.record(frameInput(clock, "first"));
    await journal.settle();

    fileSystem.holdSyncs();
    clock.advance(10);
    const ticking = journal.tick();
    await microturns(4);
    const closing = journal.close();
    await microturns(4);
    fileSystem.releaseSyncs();
    await Promise.all([ticking, closing]);

    expect(fileSystem.observations.maxConcurrentOperations).toBe(1);
    expect(journal.pendingFrames()).toHaveLength(0);
    expect(manifestedIngestSeqs(fileSystem)).toEqual(["1"]);
  });
});
