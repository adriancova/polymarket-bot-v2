import { describe, expect, it } from "vitest";

import { createMemoryFileSystem } from "@polymarket-bot/storage-wal/testing";

import { GatewayStateError } from "./errors.js";
import { GatewayJournal } from "./journal.js";
import { takeReceipt } from "./ports.js";
import { IngestSequencer } from "./sequencer.js";
import { ManualGatewayClock } from "./testing/index.js";

const EPOCH = "00000000-0000-4000-8000-0000000000aa";
const OTHER_EPOCH = "00000000-0000-4000-8000-0000000000bb";

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
