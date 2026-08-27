/**
 * ADR-004 §1 and §6: `payloadUtf8` is the frame **exactly as received**, and
 * every received frame is recorded — including the non-JSON `PING`/`PONG`
 * heartbeats the CLOB and RTDS channels use (venue report §3, §4, §10.3).
 *
 * These tests put adversarial payloads through the whole path — enqueue, append,
 * crash, recovery, read — and require the bytes back unchanged, with their
 * digests still matching.
 */

import { describe, expect, it } from "vitest";

import { assertPayloadDigest, payloadDigest } from "@polymarket-bot/storage-wal";
import { createTestFrame } from "@polymarket-bot/storage-wal/testing";

import { createFaultHarness, recordedFrames } from "./support/harness.js";

const PAYLOADS: readonly string[] = [
  "PING",
  "PONG",
  "",
  " ",
  '{"event_type":"book","asset_id":"71321045679252212594626385532706912750332728571942532289631379312455583992563"}',
  '[{"event_type":"price_change","changes":[{"price":"0.45","size":"0"}]}]',
  "not json at all",
  "line one\nline two\nline three",
  "carriage\r\nreturn",
  "tab\tseparated",
  '{"record":"footer","segmentSha256":"deadbeef"}',
  '{"record":"header","walSchemaVersion":1}',
  '{"gatewayEpoch":"spoofed","ingestSeq":"1"}',
  "unicode: 円 € ✓ ñ",
  "emoji: 🚀🧊👀",
  "\ud83d", // lone high surrogate
  "\u0000control\u0001chars\u001f", // control characters, including NUL
  "backslash \\ and quote \" inside",
  "x".repeat(100_000),
];

describe("payload fidelity", () => {
  it("round-trips every payload verbatim through a clean close", async () => {
    const harness = createFaultHarness();
    const writer = await harness.open({ maxSegmentBytes: 20_000 });
    PAYLOADS.forEach((payload, index) => {
      const result = writer.enqueue(
        createTestFrame({ ingestSeq: index + 1, payloadUtf8: payload }),
      );
      expect(result.accepted, `payload ${index} was refused`).toBe(true);
    });
    await writer.close();

    const records = await recordedFrames(harness.fileSystem);
    expect(records).toHaveLength(PAYLOADS.length);
    records.forEach((record, index) => {
      expect(record.payloadUtf8).toBe(PAYLOADS[index]);
      expect(record.payloadSha256).toBe(payloadDigest(PAYLOADS[index] ?? ""));
      expect(() => assertPayloadDigest(record)).not.toThrow();
    });
  });

  it("keeps a payload that impersonates a header or footer line as data", async () => {
    const harness = createFaultHarness();
    const writer = await harness.open();
    const impostor = '{"record":"footer","recordCount":0,"segmentSha256":"' + "0".repeat(64) + '"}';
    writer.enqueue(createTestFrame({ ingestSeq: 1, payloadUtf8: impostor }));
    writer.enqueue(createTestFrame({ ingestSeq: 2, payloadUtf8: "PING" }));
    const manifest = await writer.close();

    // The impostor is one JSON *string* inside a frame line, so it cannot end
    // the segment early: both records are still there and the segment validates.
    expect(manifest?.recordCount).toBe(2);
    const records = await recordedFrames(harness.fileSystem);
    expect(records.map((record) => record.payloadUtf8)).toEqual([impostor, "PING"]);
  });

  it("survives a crash: recorded payloads are unchanged after recovery", async () => {
    const harness = createFaultHarness({
      onAppend: (call, _path, bytes) =>
        call === 3
          ? { writeBytes: Math.floor(bytes.length / 2), error: new Error("SIGKILL") }
          : undefined,
    });
    const writer = await harness.open();
    // First batch lands (append 2); the second batch is torn (append 3).
    writer.enqueue(createTestFrame({ ingestSeq: 1, payloadUtf8: "PING" }));
    writer.enqueue(createTestFrame({ ingestSeq: 2, payloadUtf8: "unicode: 円 ✓" }));
    await writer.drain();
    writer.enqueue(createTestFrame({ ingestSeq: 3, payloadUtf8: "🚀".repeat(50) }));
    writer.enqueue(createTestFrame({ ingestSeq: 4, payloadUtf8: "PONG" }));
    await expect(writer.drain()).rejects.toThrow();

    const reopened = await harness.open();
    const records = await recordedFrames(harness.fileSystem);
    expect(records.length).toBeGreaterThanOrEqual(2);
    expect(records[0]?.payloadUtf8).toBe("PING");
    expect(records[1]?.payloadUtf8).toBe("unicode: 円 ✓");
    for (const record of records) {
      expect(() => assertPayloadDigest(record)).not.toThrow();
    }
    await reopened.close();
  });

  it("records a heartbeat frame like any other frame", async () => {
    const harness = createFaultHarness();
    const writer = await harness.open();
    // Ten seconds of CLOB heartbeats and nothing else: a segment made entirely
    // of protocol frames is legitimate, and is the evidence that distinguishes
    // "the venue sent nothing" from "the connection was dead".
    for (let index = 0; index < 6; index += 1) {
      writer.enqueue(
        createTestFrame({
          ingestSeq: index + 1,
          payloadUtf8: index % 2 === 0 ? "PING" : "PONG",
          receivedAt: `2026-01-01T00:00:${String(index * 10).padStart(2, "0")}.000Z`,
        }),
      );
    }
    const manifest = await writer.close();
    expect(manifest?.recordCount).toBe(6);
    const records = await recordedFrames(harness.fileSystem);
    expect(records.map((record) => record.payloadUtf8)).toEqual([
      "PING",
      "PONG",
      "PING",
      "PONG",
      "PING",
      "PONG",
    ]);
    expect(manifest?.firstReceivedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(manifest?.lastReceivedAt).toBe("2026-01-01T00:00:50.000Z");
  });
});
