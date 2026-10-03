import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { listSegmentManifests, nodeWalFileSystem } from "@polymarket-bot/storage-wal";
import type { WalFileSystem } from "@polymarket-bot/storage-wal";
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

/**
 * `WALCAP-1` (ADR-028 D5, `STORAGE1-MAXBYTES`): the journal opens its writer
 * with the WAL ROOT as the capacity root, so `maxTotalBytes` bounds every
 * epoch under it, and expiry's deletions give room back on the next tick.
 */
describe("GatewayJournal — maxTotalBytes over the WAL root (WALCAP-1)", () => {
  function segmentBytesUnder(fileSystem: ReturnType<typeof createMemoryFileSystem>, root: string): number {
    let total = 0;
    for (const [path, bytes] of fileSystem.files) {
      if (path.startsWith(`${root}/`) && path.endsWith(".wal.jsonl")) total += bytes.length;
    }
    return total;
  }

  async function capped(
    fileSystem: ReturnType<typeof createMemoryFileSystem>,
    epoch: string,
    reliefs: { relievedBytes: number }[],
    failures: { reason: string }[],
  ) {
    const clock = new ManualGatewayClock();
    const journal = await GatewayJournal.open({
      walRootPath: "/wal",
      fileSystem,
      clock,
      sequencer: new IngestSequencer(epoch),
      maxTotalBytes: 6_000,
      maxSegmentBytes: 1_500,
      onRecordingFailure: (failure) => failures.push(failure),
      onCapacityRelieved: (relief) => reliefs.push(relief),
    });
    return { clock, journal };
  }

  async function recordUntilRefused(
    journal: GatewayJournal,
    clock: ManualGatewayClock,
  ): Promise<number> {
    for (let index = 0; index < 100; index += 1) {
      const outcome = journal.record(frameInput(clock, `{"n":${String(index)}}`));
      await journal.settle();
      if (!outcome.recorded) {
        expect(outcome.reason).toBe("capacity-exceeded");
        return index;
      }
    }
    throw new Error("the cap never refused");
  }

  it("a new epoch counts the earlier epoch's segments: one cap for the whole root", async () => {
    const fileSystem = createMemoryFileSystem();
    const reliefs: { relievedBytes: number }[] = [];
    const failures: { reason: string }[] = [];
    const first = await capped(fileSystem, EPOCH, reliefs, failures);
    expect(await recordUntilRefused(first.journal, first.clock)).toBeGreaterThan(3);
    await first.journal.close();

    const second = await capped(fileSystem, OTHER_EPOCH, reliefs, failures);
    const outcome = second.journal.record(frameInput(second.clock, "{}"));
    expect(outcome.recorded).toBe(false);
    expect(segmentBytesUnder(fileSystem, "/wal")).toBeLessThanOrEqual(6_000);
    expect(second.journal.metrics().totalSegmentBytes).toBe(segmentBytesUnder(fileSystem, "/wal"));
    await second.journal.close();
  });

  it("reports relief once per capacity refusal, after expiry deletes a sealed segment and a tick re-derives", async () => {
    const fileSystem = createMemoryFileSystem();
    const reliefs: { relievedBytes: number }[] = [];
    const failures: { reason: string }[] = [];
    const { clock, journal } = await capped(fileSystem, EPOCH, reliefs, failures);
    await recordUntilRefused(journal, clock);
    expect(failures.at(-1)?.reason).toBe("capacity-exceeded");

    // A tick with nothing deleted gives nothing back and reports nothing.
    await journal.tick();
    expect(reliefs).toHaveLength(0);

    const sealed = [...fileSystem.files.keys()]
      .filter((path) => path.endsWith(".wal.manifest.json"))
      .sort()[0];
    if (sealed === undefined) throw new Error("no sealed segment");
    const segment = sealed.replace(/\.wal\.manifest\.json$/u, ".wal.jsonl");
    const freed = fileSystem.peek(segment)?.length ?? 0;
    fileSystem.files.delete(segment);
    fileSystem.files.delete(sealed);

    await journal.tick();
    expect(reliefs).toStrictEqual([{ relievedBytes: freed, countedBytes: segmentBytesUnder(fileSystem, "/wal") }]);
    expect(journal.record(frameInput(clock, "{}")).recorded).toBe(true);
    await journal.settle();
    // A second tick, with nothing more freed, reports nothing more; nor does
    // a second deletion with no refusal in between: one report per refusal.
    await journal.tick();
    expect(reliefs).toHaveLength(1);
    const another = [...fileSystem.files.keys()].filter((path) => path.endsWith(".wal.manifest.json")).sort()[0];
    if (another === undefined) throw new Error("no second sealed segment");
    fileSystem.files.delete(another.replace(/\.wal\.manifest\.json$/u, ".wal.jsonl"));
    await journal.tick();
    expect(journal.metrics().capacityRelievedBytes).toBeGreaterThan(freed);
    expect(reliefs).toHaveLength(1);
    expect(journal.faulted).toBe(false);
    expect(segmentBytesUnder(fileSystem, "/wal")).toBeLessThanOrEqual(6_000);
    await journal.close();
  });

  it("re-derives on the one operation chain: never alongside a drain, even with the tick's fsync held", async () => {
    const clock = new ManualGatewayClock();
    const fileSystem = createObservingWalFileSystem();
    const journal = await GatewayJournal.open({
      walRootPath: "/wal",
      fileSystem,
      clock,
      sequencer: new IngestSequencer(EPOCH),
      maxTotalBytes: 1_000_000,
      fsyncByteThreshold: 1_000_000,
    });
    journal.record(frameInput(clock, "{\"first\":1}"));
    await journal.settle();
    clock.advance(2_000);
    fileSystem.holdSyncs();
    const tick = journal.tick();
    await microturns(20);
    for (let index = 0; index < 5; index += 1) {
      journal.record(frameInput(clock, `{"during":${String(index)}}`));
      await microturns(5);
    }
    fileSystem.releaseSyncs();
    await tick;
    await journal.settle();
    await journal.tick();
    expect(journal.metrics().capacityRescans).toBeGreaterThanOrEqual(2);
    expect(fileSystem.observations.maxConcurrentOperations).toBe(1);
    expect(journal.faulted).toBe(false);
    await journal.close();
  });

  it("a relief with no capacity refusal before it reports nothing", async () => {
    const fileSystem = createMemoryFileSystem();
    const reliefs: { relievedBytes: number }[] = [];
    const failures: { reason: string }[] = [];
    const { clock, journal } = await capped(fileSystem, EPOCH, reliefs, failures);
    for (let index = 0; index < 4; index += 1) {
      journal.record(frameInput(clock, `{"n":${String(index)}}`));
      await journal.settle();
    }
    const sealed = [...fileSystem.files.keys()].find((path) => path.endsWith(".wal.manifest.json"));
    if (sealed === undefined) throw new Error("no sealed segment");
    fileSystem.files.delete(sealed.replace(/\.wal\.manifest\.json$/u, ".wal.jsonl"));
    await journal.tick();
    expect(journal.metrics().capacityRelievedBytes).toBeGreaterThan(0);
    expect(reliefs).toHaveLength(0);
    await journal.close();
  });
});

/**
 * `WALCAP-1` round 1, finding A-01: the journal enqueues from socket
 * callbacks, synchronously, while a drain on its chain is suspended in the
 * filesystem. The frames that drain took are neither queued nor counted yet,
 * and admission must still charge them, or the disk goes past `maxTotalBytes`
 * (a 6,000-byte cap ended at 8,010 before the fix). Each case holds a REAL
 * fsync of the drain — a new segment's header, then an fsync after an append
 * — and keeps recording until the cap refuses.
 */
describe("GatewayJournal — frames in flight count against maxTotalBytes (WALCAP-1 r1, A-01)", () => {
  const CAP = 12_000;

  function segmentBytesUnder(fileSystem: ObservingWalFileSystem): number {
    let total = 0;
    for (const [path, bytes] of fileSystem.files) {
      if (path.startsWith("/wal/") && path.endsWith(".wal.jsonl")) total += bytes.length;
    }
    return total;
  }

  const cases = [
    { name: "a new segment's header fsync", fsyncByteThreshold: undefined, primed: false },
    { name: "an fsync after an append, mid-drain", fsyncByteThreshold: 1, primed: true },
  ] as const;

  for (const testCase of cases) {
    it(`a drain held in ${testCase.name}: recording continues, and stops at the cap, never past it`, async () => {
      const clock = new ManualGatewayClock();
      const fileSystem = createObservingWalFileSystem();
      const failures: { reason: string }[] = [];
      const journal = await GatewayJournal.open({
        walRootPath: "/wal",
        fileSystem,
        clock,
        sequencer: new IngestSequencer(EPOCH),
        maxTotalBytes: CAP,
        maxSegmentBytes: 2_000,
        ...(testCase.fsyncByteThreshold === undefined ? {} : { fsyncByteThreshold: testCase.fsyncByteThreshold }),
        onRecordingFailure: (failure) => failures.push(failure),
      });
      if (testCase.primed) {
        expect(journal.record(frameInput(clock, "{\"primed\":1}")).recorded).toBe(true);
        await journal.settle();
      }

      fileSystem.holdSyncs();
      // A burst in one turn: the first scheduled drain takes all of it.
      for (let index = 0; index < 10; index += 1) {
        expect(journal.record(frameInput(clock, `{"burst":${String(index)}}`)).recorded).toBe(true);
      }
      await microturns(30);
      expect(fileSystem.observations.concurrentOperations, "the drain is held in an fsync").toBe(1);
      expect(journal.metrics().queue.currentDepth, "the drain took the burst").toBe(0);

      // Frames keep arriving while the drain waits.
      let admitted = 0;
      for (let index = 0; index < 100; index += 1) {
        const outcome = journal.record(frameInput(clock, `{"during":${String(index)}}`));
        await microturns(2);
        if (!outcome.recorded) {
          expect(outcome.reason).toBe("capacity-exceeded");
          break;
        }
        admitted += 1;
      }
      expect(admitted, "the cap still had room while the drain was held").toBeGreaterThan(0);
      expect(failures.at(-1)?.reason).toBe("capacity-exceeded");

      fileSystem.releaseSyncs();
      await journal.settle();
      expect(journal.faulted).toBe(false);
      expect(segmentBytesUnder(fileSystem)).toBeLessThanOrEqual(CAP);
      expect(journal.metrics().framesWritten).toBe(journal.metrics().framesAccepted);
      expect(journal.metrics().totalSegmentBytes).toBe(segmentBytesUnder(fileSystem));
      expect(fileSystem.observations.maxConcurrentOperations).toBe(1);
      await journal.close();
      expect(segmentBytesUnder(fileSystem)).toBeLessThanOrEqual(CAP);
    });
  }
});

/** `WALCAP-1` round 1, finding O-M1: a count it could not read bounds nothing. */
describe("GatewayJournal — the capacity count at open fails closed (WALCAP-1 r1, O-M1)", () => {
  it("does not open when the WAL root cannot be listed, and opens once it can", async () => {
    const base = createMemoryFileSystem();
    const first = await GatewayJournal.open({
      walRootPath: "/wal",
      fileSystem: base,
      clock: new ManualGatewayClock(),
      sequencer: new IngestSequencer(EPOCH),
      maxTotalBytes: 6_000,
    });
    first.record(frameInput(new ManualGatewayClock(), "{\"earlier\":1}"));
    await first.close();
    const before = base.snapshot();

    let failNext = true;
    const fileSystem: typeof base = {
      ...base,
      listDirectoryNames: async (directory) => {
        if (failNext && directory === "/wal") {
          failNext = false;
          throw new Error("EIO (injected root listing)");
        }
        return (await base.listDirectoryNames?.(directory)) ?? [];
      },
    };
    const open = async () =>
      GatewayJournal.open({
        walRootPath: "/wal",
        fileSystem,
        clock: new ManualGatewayClock(),
        sequencer: new IngestSequencer(OTHER_EPOCH),
        maxTotalBytes: 6_000,
      });
    await expect(open()).rejects.toThrow("EIO (injected root listing)");
    expect(base.snapshot()).toStrictEqual(before);
    const journal = await open();
    let earlier = 0;
    for (const [path, bytes] of base.files) if (path.endsWith(".wal.jsonl")) earlier += bytes.length;
    expect(earlier).toBeGreaterThan(0);
    expect(journal.metrics().totalSegmentBytes).toBe(earlier);
    await journal.close();
  });
});

/**
 * `WALCAP-1` round 2, finding TR: a time rotation that fired with frames
 * still unwritten opened a segment whose framing nobody had reserved. Through
 * the journal, the review's probe ended a 6,000-byte cap at 6,028 bytes before
 * `close()` and 6,408 after, on the memory and the real Node filesystem alike;
 * these tests read 6,173 before `close()` on the round-1 writer. Admission now
 * reserves that segment whenever the open one holds a record, so the rotation
 * happens on time and the cap holds.
 */
describe("GatewayJournal — a time rotation never takes the disk past maxTotalBytes (WALCAP-1 r2, TR)", () => {
  const CAP = 6_000;
  const AGE_MS = 1_000;

  async function burstAtTheBoundary(
    fileSystem: WalFileSystem,
    walRootPath: string,
    aged: "before the burst" | "between the burst and its drain",
    segmentBytes: () => Promise<number>,
  ) {
    const clock = new ManualGatewayClock();
    const failures: { reason: string }[] = [];
    const journal = await GatewayJournal.open({
      walRootPath,
      fileSystem,
      clock,
      sequencer: new IngestSequencer(EPOCH),
      maxTotalBytes: CAP,
      // Segments only time closes.
      maxSegmentBytes: 64_000_000,
      maxSegmentAgeMs: AGE_MS,
      onRecordingFailure: (failure) => failures.push(failure),
    });
    expect(journal.record(frameInput(clock, "{}")).recorded).toBe(true);
    await journal.settle();

    if (aged === "before the burst") clock.advance(AGE_MS);
    // One turn, as a socket delivers a burst: the drain runs after all of it.
    let burst = 0;
    for (let index = 0; index < 100; index += 1) {
      const outcome = journal.record(frameInput(clock, `{"burst":${String(index)}}`));
      if (!outcome.recorded) {
        expect(outcome.reason).toBe("capacity-exceeded");
        break;
      }
      burst += 1;
    }
    expect(burst, "the cap had room for a burst").toBeGreaterThan(0);
    if (aged === "between the burst and its drain") clock.advance(AGE_MS);
    await journal.settle();
    expect(journal.faulted).toBe(false);
    expect(await segmentBytes()).toBeLessThanOrEqual(CAP);
    expect(journal.metrics().framesWritten).toBe(journal.metrics().framesAccepted);
    await journal.close();
    expect(await segmentBytes()).toBeLessThanOrEqual(CAP);
    expect(failures.at(-1)?.reason).toBe("capacity-exceeded");

    // On time: the aged segment closed by age, the burst in the next one.
    const manifests = await listSegmentManifests(fileSystem, fileSystem.joinPath(walRootPath, EPOCH));
    expect(manifests.map((manifest) => [manifest.closeReason, manifest.recordCount])).toEqual([
      ["time-rotation", 1],
      ["shutdown", burst],
    ]);
    expect(journal.metrics().timeRotationsDeferred).toBe(0);
  }

  for (const aged of ["before the burst", "between the burst and its drain"] as const) {
    it(`a segment aged ${aged}: a burst to refusal stays under the cap, before and after close`, async () => {
      const fileSystem = createMemoryFileSystem();
      await burstAtTheBoundary(fileSystem, "/wal", aged, async () => {
        let total = 0;
        for (const [path, bytes] of fileSystem.files) {
          if (path.startsWith("/wal/") && path.endsWith(".wal.jsonl")) total += bytes.length;
        }
        return total;
      });
    });
  }

  it("the same on the real Node filesystem, the segment aged before the burst", async () => {
    const root = await mkdtemp(join(tmpdir(), "walcap-r2-journal-"));
    try {
      await burstAtTheBoundary(nodeWalFileSystem(), root, "before the burst", async () => {
        let total = 0;
        for (const epoch of await readdir(root)) {
          for (const name of await readdir(join(root, epoch))) {
            if (name.endsWith(".wal.jsonl")) total += (await stat(join(root, epoch, name))).size;
          }
        }
        return total;
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
