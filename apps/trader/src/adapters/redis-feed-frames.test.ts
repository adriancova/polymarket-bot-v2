/**
 * `THROUGHPUT-2` (ADR-024) — the Redis feed hands out FRAME-ALIGNED batches.
 *
 * The core loop treats the end of a batch as the end of a venue frame, so a
 * batch must never end inside one. The feed's rule (module header of
 * `redis-feed.ts`): a SHORT read reached the stream's end, and by the
 * gateway's frame-atomic publication every frame in it is whole; a FULL read
 * may have cut its last frame, whose trailing run is carried to the next poll.
 * These pin the rule against a scripted subscription whose `receive` honours
 * `maxEvents` exactly as `XREAD COUNT` does.
 */
import { describe, expect, it } from "vitest";

import type { EventSubscription, StreamCheckpoint } from "@polymarket-bot/event-bus";
import type { EventEnvelope } from "@polymarket-bot/domain";

import { RedisMarketEventFeed } from "./redis-feed.js";

const EPOCH = "00000000-0000-4000-8000-000000000001";

function envelope(seq: number, frame: string | undefined): EventEnvelope<unknown> {
  return {
    eventId: `01900000-0000-7000-8000-${String(seq).padStart(12, "0")}`,
    eventType: "BookLevelChanged",
    schemaVersion: 1,
    source: "polymarket",
    sourceChannel: "polymarket:market-ws",
    receivedAt: "2026-09-29T21:00:00.000Z",
    receivedMonotonicNs: String(seq),
    gatewayEpoch: EPOCH,
    ingestSeq: String(seq),
    ...(frame === undefined ? {} : { causationId: `raw:${EPOCH}:${frame}` }),
    payload: {},
  };
}

/** A stream in memory; `receive` returns at most `maxEvents` entries after the read position. */
class ScriptedSubscription {
  readonly entries: EventEnvelope<unknown>[] = [];
  readonly reads: number[] = [];
  readonly checkpoints: string[] = [];
  #position = 0;

  /** A subscription resuming after a recorded checkpoint (`cp:<ingestSeq>`), as a restart does. */
  static resumingAfter(entries: readonly EventEnvelope<unknown>[], checkpoint: string): ScriptedSubscription {
    const resumed = new ScriptedSubscription();
    resumed.append(...entries);
    resumed.#position = entries.findIndex((entry) => `cp:${entry.ingestSeq}` === checkpoint) + 1;
    return resumed;
  }

  append(...envelopes: EventEnvelope<unknown>[]): void {
    this.entries.push(...envelopes);
  }

  receive(options: { readonly maxEvents?: number } = {}): Promise<unknown> {
    const count = options.maxEvents ?? 128;
    this.reads.push(count);
    const slice = this.entries.slice(this.#position, this.#position + count);
    this.#position += slice.length;
    if (slice.length === 0) return Promise.resolve({ status: "idle" });
    return Promise.resolve({
      status: "events",
      events: slice.map((entry) => ({ envelope: entry, checkpoint: `cp:${entry.ingestSeq}` })),
    });
  }

  checkpoint(position: StreamCheckpoint): Promise<void> {
    this.checkpoints.push(position as unknown as string);
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

function feedOver(subscription: ScriptedSubscription, maxEvents: number): RedisMarketEventFeed {
  return new RedisMarketEventFeed({
    subscription: subscription as unknown as EventSubscription<unknown>,
    maxEvents,
  });
}

async function pollSeqs(feed: RedisMarketEventFeed): Promise<string[]> {
  const polled = await feed.poll();
  if (!polled.ok) throw new Error(`poll failed: ${polled.failure.detail}`);
  return polled.value.map((event) => event.envelope.ingestSeq);
}

describe("RedisMarketEventFeed — frame-aligned batches (THROUGHPUT-2)", () => {
  it("a FULL read that cuts a frame carries its tail; the next poll hands the frame out whole", async () => {
    const subscription = new ScriptedSubscription();
    // Frames: [1,2] [3,4] [5,6] — a COUNT of 3 cuts the second frame.
    subscription.append(envelope(1, "a"), envelope(2, "a"), envelope(3, "b"), envelope(4, "b"), envelope(5, "c"), envelope(6, "c"));
    const feed = feedOver(subscription, 3);

    expect(await pollSeqs(feed)).toEqual(["1", "2"]);
    expect(feed.carried).toBe(1);
    // The carry leaves room for 2; that read is full again and cuts [5,6].
    expect(await pollSeqs(feed)).toEqual(["3", "4"]);
    expect(await pollSeqs(feed)).toEqual(["5", "6"]);
    expect(await pollSeqs(feed)).toEqual([]);
    expect(feed.framesSplit).toBe(0);
    // Never more than maxEvents asked for in one read, and never more handed out.
    expect(Math.max(...subscription.reads)).toBeLessThanOrEqual(3);
  });

  it("a SHORT read reached the stream's end: handed out whole, nothing carried, nothing waited for", async () => {
    const subscription = new ScriptedSubscription();
    subscription.append(envelope(1, "a"), envelope(2, "a"), envelope(3, "b"));
    const feed = feedOver(subscription, 8);
    expect(await pollSeqs(feed)).toEqual(["1", "2", "3"]);
    expect(feed.carried).toBe(0);
    expect(subscription.reads).toEqual([8]);
  });

  it("a carried frame is handed out as soon as a read finds the stream's end (a quiet stream does not delay it)", async () => {
    const subscription = new ScriptedSubscription();
    subscription.append(envelope(1, "a"), envelope(2, "b"), envelope(3, "b"));
    const feed = feedOver(subscription, 3);
    // Full read: [1] handed out, [2,3] carried.
    expect(await pollSeqs(feed)).toEqual(["1"]);
    expect(feed.carried).toBe(2);
    // Nothing more was published: the next read is idle, so [2,3] is complete.
    expect(await pollSeqs(feed)).toEqual(["2", "3"]);
    expect(feed.carried).toBe(0);
  });

  it("a full read whose last frame starts at its last entry carries only that entry", async () => {
    const subscription = new ScriptedSubscription();
    subscription.append(envelope(1, "a"), envelope(2, "a"), envelope(3, "a"), envelope(4, "b"));
    const feed = feedOver(subscription, 4);
    expect(await pollSeqs(feed)).toEqual(["1", "2", "3"]);
    expect(feed.carried).toBe(1);
    expect(await pollSeqs(feed)).toEqual(["4"]);
  });

  it("an event without a causationId is a frame of its own (its dispatch identity): never grouped with its neighbours", async () => {
    const subscription = new ScriptedSubscription();
    subscription.append(envelope(1, "a"), envelope(2, "a"), envelope(3, undefined), envelope(4, undefined));
    const feed = feedOver(subscription, 3);
    // Full read [1,2,3]: the trailing run is [3] alone (its key is its own
    // (epoch, seq)), carried conservatively and handed out with the next read.
    expect(await pollSeqs(feed)).toEqual(["1", "2"]);
    expect(await pollSeqs(feed)).toEqual(["3", "4"]);
    expect(feed.framesSplit).toBe(0);
  });

  it("one frame of maxEvents or more cannot be aligned: handed out as it stands, never dropped, and COUNTED", async () => {
    const subscription = new ScriptedSubscription();
    subscription.append(envelope(1, "a"), envelope(2, "a"), envelope(3, "a"), envelope(4, "a"), envelope(5, "b"));
    const feed = feedOver(subscription, 3);
    expect(await pollSeqs(feed)).toEqual(["1", "2", "3"]);
    expect(feed.framesSplit).toBe(1);
    // The next read is short: the rest of the frame and the next one, whole.
    expect(await pollSeqs(feed)).toEqual(["4", "5"]);
  });

  it("positions follow DELIVERY: a mark or commit never names a carried event", async () => {
    const subscription = new ScriptedSubscription();
    subscription.append(envelope(1, "a"), envelope(2, "b"), envelope(3, "b"));
    const feed = feedOver(subscription, 3);
    expect(await pollSeqs(feed)).toEqual(["1"]);
    const mark = feed.mark();
    expect(mark).toBeDefined();
    const committed = await feed.commit(mark);
    expect(committed.ok).toBe(true);
    // Events 2 and 3 were READ but carried: the recorded position is event 1's.
    expect(subscription.checkpoints).toEqual(["cp:1"]);
    expect(await pollSeqs(feed)).toEqual(["2", "3"]);
    expect((await feed.commit()).ok).toBe(true);
    expect(subscription.checkpoints).toEqual(["cp:1", "cp:3"]);
  });

  it("a crash while a partial frame is CARRIED: the recorded position precedes the frame, and a restart reads it whole", async () => {
    const subscription = new ScriptedSubscription();
    const stream = [envelope(1, "a"), envelope(2, "a"), envelope(3, "b"), envelope(4, "b"), envelope(5, "c")];
    subscription.append(...stream);
    const feed = feedOver(subscription, 3);
    // Read [1,2,3]: frame b is cut by the COUNT; [1,2] handed out, 3 carried.
    expect(await pollSeqs(feed)).toEqual(["1", "2"]);
    expect(feed.carried).toBe(1);
    expect((await feed.commit(feed.mark())).ok).toBe(true);
    // The process dies here, mid-frame b (3 read, 4 not yet).
    const recorded = subscription.checkpoints.at(-1);
    expect(recorded).toBe("cp:2");
    // The restarted consumer resumes after the recorded position: frame b whole.
    const restarted = feedOver(ScriptedSubscription.resumingAfter(stream, recorded ?? ""), 3);
    // (A full read of [3,4,5] carries the trailing [5] in turn.)
    expect(await pollSeqs(restarted)).toEqual(["3", "4"]);
    expect(await pollSeqs(restarted)).toEqual(["5"]);
  });

  it("delivery ordinals count handed-out events in stream order, exactly as before", async () => {
    const subscription = new ScriptedSubscription();
    subscription.append(envelope(1, "a"), envelope(2, "b"), envelope(3, "b"), envelope(4, "c"));
    const feed = feedOver(subscription, 3);
    const batches = [await feed.poll(), await feed.poll(), await feed.poll()];
    const ordinals = batches.flatMap((batch) => (batch.ok ? batch.value : [])).map(
      (event) => event.identity.datasetRowOrdinal,
    );
    expect(ordinals).toEqual([1, 2, 3, 4]);
  });
});
