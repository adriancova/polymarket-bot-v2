/**
 * `WP-050` acceptance 3: "Queue overflow is observable and never silently drops
 * frames" (handoff §8.3; ADR-004 §4).
 *
 * The invariant asserted throughout: **offered = accepted + refused**, and
 * **recorded = accepted**. A frame the writer accepted is on disk; a frame it
 * refused is still the caller's, was reported, and was never counted as
 * dropped unless the caller itself said it dropped it.
 */

import { describe, expect, it } from "vitest";

import { encodeFrameLine } from "@polymarket-bot/storage-wal";
import type { RawFrameRecord, WalOverflowEvent } from "@polymarket-bot/storage-wal";
import { createTestFrames } from "@polymarket-bot/storage-wal/testing";

import { createFaultHarness, recordedIngestSeqs } from "./support/harness.js";

describe("a full queue", () => {
  it("refuses without dropping, and reports every refusal", async () => {
    const overflows: WalOverflowEvent[] = [];
    const harness = createFaultHarness();
    const writer = await harness.open({
      queueCapacity: 4,
      observer: { onOverflow: (event) => overflows.push(event) },
    });

    const offered = createTestFrames(20);
    const accepted: RawFrameRecord[] = [];
    const refused: RawFrameRecord[] = [];
    for (const frame of offered) {
      const result = writer.enqueue(frame);
      if (result.accepted) {
        accepted.push(frame);
      } else {
        expect(result.reason).toBe("queue-overflow");
        expect(result.queueDepth).toBe(4);
        refused.push(frame);
      }
    }

    expect(accepted.length + refused.length).toBe(offered.length);
    expect(accepted).toHaveLength(4);
    expect(refused).toHaveLength(16);
    expect(overflows).toHaveLength(16);
    expect(overflows.map((event) => event.record.ingestSeq)).toEqual(
      refused.map((frame) => frame.ingestSeq),
    );
    expect(overflows.every((event) => event.queueCapacity === 4)).toBe(true);

    const metrics = writer.metrics();
    expect(metrics.overflowSignals).toBe(16);
    expect(metrics.queue.overflowSignals).toBe(16);
    expect(metrics.queue.messagesDropped).toBe(0);
    expect(metrics.framesAccepted).toBe(4);

    await writer.close();
    expect(await recordedIngestSeqs(harness.fileSystem)).toEqual(
      accepted.map((frame) => frame.ingestSeq),
    );
  });

  it("accepts again once the queue is drained", async () => {
    const harness = createFaultHarness();
    const writer = await harness.open({ queueCapacity: 2 });
    const frames = createTestFrames(6);
    const recorded: string[] = [];
    for (const frame of frames) {
      let result = writer.enqueue(frame);
      if (!result.accepted) {
        // The caller's decision: drain and retry, rather than lose the frame.
        await writer.drain();
        result = writer.enqueue(frame);
      }
      expect(result.accepted).toBe(true);
      recorded.push(frame.ingestSeq);
    }
    await writer.close();

    expect(await recordedIngestSeqs(harness.fileSystem)).toEqual(recorded);
    expect(writer.metrics().queue.messagesDropped).toBe(0);
  });

  it("bounds memory by bytes as well as by frame count", async () => {
    const harness = createFaultHarness();
    const payload = "x".repeat(4_000);
    const frameBytes = encodeFrameLine(createTestFrames(1, { payloadUtf8: payload })[0] ?? fail())
      .length;
    const writer = await harness.open({
      queueCapacity: 1_000,
      queueMaxBytes: frameBytes * 3,
    });

    let accepted = 0;
    for (const frame of createTestFrames(10, { payloadUtf8: payload })) {
      if (writer.enqueue(frame).accepted) {
        accepted += 1;
      }
    }
    expect(accepted).toBe(3);
    expect(writer.metrics().queue.currentByteDepth).toBeLessThanOrEqual(frameBytes * 3);
    expect(writer.metrics().queue.messagesDropped).toBe(0);
    await writer.close();
  });

  it("counts a drop only when the caller admits to it", async () => {
    const harness = createFaultHarness();
    const writer = await harness.open({ queueCapacity: 1 });
    writer.enqueue(createTestFrames(1)[0] ?? fail());

    const refusedFrames = createTestFrames(3, {}, 2);
    for (const frame of refusedFrames) {
      expect(writer.enqueue(frame).accepted).toBe(false);
    }
    expect(writer.metrics().queue.messagesDropped).toBe(0);

    writer.recordCallerDrop(refusedFrames.length, "wal-queue-overflow-incident");
    const metrics = writer.metrics();
    expect(metrics.queue.messagesDropped).toBe(3);
    expect(metrics.queue.messagesDroppedByReason).toEqual({
      "wal-queue-overflow-incident": 3,
    });
    await writer.close();
  });

  it("keeps the oldest-message age visible while the queue is backed up", async () => {
    const harness = createFaultHarness();
    const writer = await harness.open({ queueCapacity: 8 });
    writer.enqueue(createTestFrames(1)[0] ?? fail());
    harness.clock.advance(2_500);
    writer.enqueue(createTestFrames(1, {}, 2)[0] ?? fail());

    const metrics = writer.metrics();
    expect(metrics.queue.oldestMessageAgeMs).toBe(2_500);
    expect(metrics.queue.currentDepth).toBe(2);
    expect(metrics.queue.consumerLag).toBe(2);

    await writer.drain();
    expect(writer.metrics().queue.oldestMessageAgeMs).toBe(0);
    expect(writer.metrics().queue.consumerLag).toBe(0);
    await writer.close();
  });
});

function fail(): never {
  throw new Error("expected a generated frame");
}
