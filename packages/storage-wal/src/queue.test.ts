import { describe, expect, it } from "vitest";

import { BoundedRawFrameQueue } from "./queue.js";
import { encodeFrameLine } from "./segment-format.js";
import { createTestFrame, createTestFrames } from "./testing/frames.js";

function newQueue(capacity = 3, maxBytes = 1_000_000): BoundedRawFrameQueue {
  return new BoundedRawFrameQueue({ capacity, maxBytes });
}

describe("bounded raw-frame queue", () => {
  it("accepts frames up to its capacity and then refuses", () => {
    const queue = newQueue(2);
    expect(queue.offer(createTestFrame({ ingestSeq: 1 }), 0).accepted).toBe(true);
    expect(queue.offer(createTestFrame({ ingestSeq: 2 }), 0).accepted).toBe(true);
    const refused = queue.offer(createTestFrame({ ingestSeq: 3 }), 0);
    expect(refused.accepted).toBe(false);
    if (refused.accepted) {
      throw new Error("expected a refusal");
    }
    expect(refused.reason).toBe("queue-overflow");
    expect(refused.detail).toContain("capacity of 2 frames");
  });

  it("refuses on the byte bound before the frame bound", () => {
    const frame = createTestFrame();
    const frameBytes = encodeFrameLine(frame).length;
    const queue = newQueue(1000, frameBytes + 1);
    expect(queue.offer(frame, 0).accepted).toBe(true);
    const refused = queue.offer(createTestFrame({ ingestSeq: 2 }), 0);
    expect(refused.accepted).toBe(false);
    if (refused.accepted) {
      throw new Error("expected a refusal");
    }
    expect(refused.detail).toContain("byte capacity");
  });

  it("never drops an accepted frame: everything offered comes back out in order", () => {
    const queue = newQueue(10);
    const frames = createTestFrames(10);
    for (const frame of frames) {
      expect(queue.offer(frame, 0).accepted).toBe(true);
    }
    const taken = queue.takeAll();
    expect(taken.map((item) => item.record.ingestSeq)).toEqual(
      frames.map((frame) => frame.ingestSeq),
    );
    expect(queue.depth).toBe(0);
    expect(queue.byteDepth).toBe(0);
  });

  it("counts an overflow as a signal, not as a drop", () => {
    const queue = newQueue(1);
    queue.offer(createTestFrame({ ingestSeq: 1 }), 0);
    queue.offer(createTestFrame({ ingestSeq: 2 }), 0);
    queue.offer(createTestFrame({ ingestSeq: 3 }), 0);
    const metrics = queue.metrics(0);
    expect(metrics.overflowSignals).toBe(2);
    expect(metrics.messagesDropped).toBe(0);
    expect(metrics.messagesDroppedByReason).toEqual({});
    // The refused frames were never retained, so the queue still holds exactly
    // the one frame it accepted.
    expect(metrics.currentDepth).toBe(1);
    expect(queue.takeAll()).toHaveLength(1);
  });

  it("moves messagesDropped only when a caller acknowledges a drop", () => {
    const queue = newQueue(1);
    queue.offer(createTestFrame({ ingestSeq: 1 }), 0);
    queue.offer(createTestFrame({ ingestSeq: 2 }), 0);
    expect(queue.metrics(0).messagesDropped).toBe(0);
    queue.recordCallerDrop(1, "incident-shed");
    queue.recordCallerDrop(2, "incident-shed");
    queue.recordCallerDrop(1, "operator-command");
    const metrics = queue.metrics(0);
    expect(metrics.messagesDropped).toBe(4);
    expect(metrics.messagesDroppedByReason).toEqual({
      "incident-shed": 3,
      "operator-command": 1,
    });
  });

  it("rejects an unusable caller-drop record", () => {
    const queue = newQueue();
    expect(() => queue.recordCallerDrop(-1, "x")).toThrow(RangeError);
    expect(() => queue.recordCallerDrop(1.5, "x")).toThrow(RangeError);
    expect(() => queue.recordCallerDrop(1, "")).toThrow(RangeError);
  });

  it("exposes the §8.3 metric family", () => {
    const queue = newQueue(4, 5_000);
    queue.offer(createTestFrame({ ingestSeq: 1 }), 1_000);
    queue.offer(createTestFrame({ ingestSeq: 2 }), 1_500);
    const metrics = queue.metrics(3_000);
    expect(metrics.currentDepth).toBe(2);
    expect(metrics.maximumDepth).toBe(4);
    expect(metrics.highWaterDepth).toBe(2);
    expect(metrics.oldestMessageAgeMs).toBe(2_000);
    expect(metrics.messagesDropped).toBe(0);
    expect(metrics.producerBlockedTimeMs).toBe(0);
    expect(metrics.consumerLag).toBe(2);
    expect(metrics.maximumByteDepth).toBe(5_000);
    expect(metrics.currentByteDepth).toBeGreaterThan(0);
  });

  it("reports zero oldest-message age when empty", () => {
    const queue = newQueue();
    expect(queue.metrics(10_000).oldestMessageAgeMs).toBe(0);
    queue.offer(createTestFrame(), 10_000);
    queue.takeAll();
    expect(queue.metrics(20_000).oldestMessageAgeMs).toBe(0);
  });

  it("keeps the high-water depth after draining", () => {
    const queue = newQueue(5);
    for (const frame of createTestFrames(4)) {
      queue.offer(frame, 0);
    }
    queue.takeAll();
    expect(queue.metrics(0).highWaterDepth).toBe(4);
    expect(queue.metrics(0).currentDepth).toBe(0);
  });

  it("takes a bounded prefix in FIFO order", () => {
    const queue = newQueue(10);
    for (const frame of createTestFrames(5)) {
      queue.offer(frame, 0);
    }
    expect(queue.take(2).map((item) => item.record.ingestSeq)).toEqual(["1", "2"]);
    expect(queue.depth).toBe(3);
    expect(queue.take(10).map((item) => item.record.ingestSeq)).toEqual(["3", "4", "5"]);
    expect(queue.depth).toBe(0);
  });

  it("requeues frames at the head without losing order or byte accounting", () => {
    const queue = newQueue(10);
    for (const frame of createTestFrames(3)) {
      queue.offer(frame, 0);
    }
    const taken = queue.take(2);
    queue.requeueFront(taken);
    expect(queue.depth).toBe(3);
    expect(queue.takeAll().map((item) => item.record.ingestSeq)).toEqual(["1", "2", "3"]);
    expect(queue.byteDepth).toBe(0);
    expect(queue.metrics(0).consumerLag).toBe(0);
  });

  it("frees capacity as frames are taken", () => {
    const queue = newQueue(2);
    queue.offer(createTestFrame({ ingestSeq: 1 }), 0);
    queue.offer(createTestFrame({ ingestSeq: 2 }), 0);
    expect(queue.offer(createTestFrame({ ingestSeq: 3 }), 0).accepted).toBe(false);
    queue.take(1);
    expect(queue.offer(createTestFrame({ ingestSeq: 3 }), 0).accepted).toBe(true);
  });
});
