/**
 * §8.3 bounded queues.
 *
 * > "Every queue is bounded and exposes: current depth, maximum depth, oldest
 * > message age, messages dropped, producer blocked time, consumer lag.
 * > **Dropping trading or raw market events silently is forbidden.**"
 *
 * The claim this file makes is structural, not statistical: there is NO code
 * path in `BoundedQueue` that discards a message. `offer` either accepts or
 * REFUSES, and `messagesDropped` is reported as `0` because nothing can move
 * it.
 */

import { describe, expect, it } from "vitest";

import { BoundedQueue } from "./queue.js";

describe("BoundedQueue", () => {
  it("refuses a non-positive bound at construction — §8.3 bounds every queue", () => {
    for (const depth of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new BoundedQueue<number>({ name: "q", maximumDepth: depth })).toThrow(
        RangeError,
      );
    }
  });

  it("accepts up to the bound and REFUSES beyond it — never evicts, never overwrites", () => {
    const queue = new BoundedQueue<number>({ name: "ingest", maximumDepth: 2 });
    expect(queue.offer(1, 0).accepted).toBe(true);
    expect(queue.offer(2, 0).accepted).toBe(true);
    const refused = queue.offer(3, 0);
    expect(refused.accepted).toBe(false);
    if (refused.accepted) return;
    expect(refused.reason).toBe("QUEUE_FULL");
    expect(refused.detail).toContain("§8.3 forbids dropping the event");

    // The two accepted messages are still there, in order, and the refused one
    // never displaced either.
    expect(queue.take()).toBe(1);
    expect(queue.take()).toBe(2);
    expect(queue.take()).toBeUndefined();
  });

  it("reports the §8.3 metric set, and messagesDropped is ALWAYS zero", () => {
    const queue = new BoundedQueue<string>({ name: "ingest", maximumDepth: 4 });
    queue.offer("a", 1_000);
    queue.offer("b", 1_500);
    const metrics = queue.metrics(2_000);
    expect(metrics.name).toBe("ingest");
    expect(metrics.currentDepth).toBe(2);
    expect(metrics.maximumDepth).toBe(4);
    expect(metrics.oldestMessageAgeMs).toBe(1_000);
    expect(metrics.messagesDropped).toBe(0);
    expect(metrics.consumerLag).toBe(2);
    expect(metrics.accepted).toBe(2);
    expect(metrics.consumed).toBe(0);

    queue.take();
    const after = queue.metrics(2_000);
    expect(after.consumerLag).toBe(1);
    expect(after.consumed).toBe(1);
    expect(after.oldestMessageAgeMs).toBe(500);
  });

  it("an EMPTY queue has NO oldest message age — `null`, not `0`", () => {
    const queue = new BoundedQueue<number>({ name: "ingest", maximumDepth: 2 });
    expect(queue.metrics(1_000).oldestMessageAgeMs).toBeNull();
    queue.offer(1, 1_000);
    // A message enqueued at this instant is zero old, which is a DIFFERENT fact
    // from "there is no message".
    expect(queue.metrics(1_000).oldestMessageAgeMs).toBe(0);
  });

  it("accumulates producer-blocked time across consecutive refusals", () => {
    const queue = new BoundedQueue<number>({ name: "ingest", maximumDepth: 1 });
    queue.offer(1, 0);
    queue.offer(2, 100);
    queue.offer(3, 400);
    queue.offer(4, 900);
    // The measured span is between refusals: 100→400→900 is 800ms blocked.
    expect(queue.metrics(1_000).producerBlockedMs).toBe(800);
  });

  it("is FIFO and `peek` does not consume", () => {
    const queue = new BoundedQueue<string>({ name: "q", maximumDepth: 8 });
    for (const value of ["a", "b", "c"]) queue.offer(value, 0);
    expect(queue.peek()).toBe("a");
    expect(queue.depth).toBe(3);
    expect([queue.take(), queue.take(), queue.take()]).toEqual(["a", "b", "c"]);
  });

  it("recovers: after a drain, the queue accepts again", () => {
    const queue = new BoundedQueue<number>({ name: "q", maximumDepth: 1 });
    expect(queue.offer(1, 0).accepted).toBe(true);
    expect(queue.offer(2, 0).accepted).toBe(false);
    queue.take();
    expect(queue.offer(2, 0).accepted).toBe(true);
  });
});
