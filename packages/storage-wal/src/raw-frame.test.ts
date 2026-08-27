import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { WalRecordValidationError } from "./errors.js";
import {
  assertPayloadDigest,
  buildRawFrameRecord,
  compareIngestSeq,
  parseRawFrameRecord,
  payloadDigest,
  RAW_FRAME_RECORD_KEYS,
} from "./raw-frame.js";
import type { RawFrameRecord } from "./raw-frame.js";
import { createTestFrame } from "./testing/frames.js";

const validFrame = createTestFrame();

function mutate(overrides: Record<string, unknown>): Record<string, unknown> {
  return { ...validFrame, ...overrides };
}

describe("RawFrameRecord shape", () => {
  it("declares exactly the handoff §9.1 fields, in order", () => {
    expect(RAW_FRAME_RECORD_KEYS).toEqual([
      "gatewayEpoch",
      "ingestSeq",
      "source",
      "endpoint",
      "connectionId",
      "subscriptionGeneration",
      "receivedAt",
      "receivedMonotonicNs",
      "payloadUtf8",
      "payloadSha256",
    ]);
  });

  it("round-trips a valid record with keys in canonical order", () => {
    const parsed = parseRawFrameRecord(validFrame);
    expect(Object.keys(parsed)).toEqual([...RAW_FRAME_RECORD_KEYS]);
    expect(parsed).toEqual(validFrame);
  });
});

describe("payload digest", () => {
  it("is SHA-256 over the exact UTF-8 payload bytes", () => {
    const payload = '{"event_type":"book"}';
    const expected = createHash("sha256").update(Buffer.from(payload, "utf8")).digest("hex");
    expect(payloadDigest(payload)).toBe(expected);
  });

  it("digests non-JSON text frames such as the PING heartbeat", () => {
    // ADR-004 §6 / venue report §3, §4, §10.3: PING and PONG are text frames
    // that are not JSON, and they are recorded like any other frame.
    expect(payloadDigest("PING")).toBe(
      createHash("sha256").update(Buffer.from("PING", "utf8")).digest("hex"),
    );
    const frame = createTestFrame({ payloadUtf8: "PING" });
    expect(() => assertPayloadDigest(frame)).not.toThrow();
  });

  it("digests the empty payload without special-casing it", () => {
    const frame = createTestFrame({ payloadUtf8: "" });
    expect(frame.payloadSha256).toBe(
      createHash("sha256").update(Buffer.alloc(0)).digest("hex"),
    );
  });

  it("rejects a record whose declared digest does not match its payload", () => {
    const tampered: RawFrameRecord = { ...validFrame, payloadUtf8: "PONG" };
    expect(() => assertPayloadDigest(tampered)).toThrow(WalRecordValidationError);
    try {
      assertPayloadDigest(tampered);
    } catch (error) {
      expect(error).toBeInstanceOf(WalRecordValidationError);
      expect((error as WalRecordValidationError).code).toBe("WAL_RECORD_INVALID");
    }
  });

  it("computes the digest when building a record", () => {
    const built = buildRawFrameRecord({
      gatewayEpoch: validFrame.gatewayEpoch,
      ingestSeq: "7",
      source: "rtds",
      endpoint: "wss://ws-live-data.polymarket.com",
      connectionId: "conn-2",
      subscriptionGeneration: 3,
      receivedAt: "2026-01-01T00:00:01.500Z",
      receivedMonotonicNs: "1500000000",
      payloadUtf8: "PONG",
    });
    expect(built.payloadSha256).toBe(payloadDigest("PONG"));
    expect(() => assertPayloadDigest(built)).not.toThrow();
  });

  it("refuses to build a record from a non-string payload", () => {
    expect(() =>
      buildRawFrameRecord({ ...validFrame, payloadUtf8: 42 } as unknown as Parameters<
        typeof buildRawFrameRecord
      >[0]),
    ).toThrow(WalRecordValidationError);
  });
});

describe("parseRawFrameRecord rejections", () => {
  const rejections: readonly (readonly [string, unknown])[] = [
    ["null", null],
    ["an array", []],
    ["a string", "frame"],
    ["a number", 1],
    ["an unknown key", mutate({ extra: true })],
    ["a missing key", (() => {
      const copy: Record<string, unknown> = { ...validFrame };
      delete copy["connectionId"];
      return copy;
    })()],
    ["an empty gatewayEpoch", mutate({ gatewayEpoch: "" })],
    ["a numeric gatewayEpoch", mutate({ gatewayEpoch: 1 })],
    ["a negative subscriptionGeneration", mutate({ subscriptionGeneration: -1 })],
    ["a fractional subscriptionGeneration", mutate({ subscriptionGeneration: 1.5 })],
    ["a string subscriptionGeneration", mutate({ subscriptionGeneration: "0" })],
    ["a numeric ingestSeq", mutate({ ingestSeq: 1 })],
    ["a signed ingestSeq", mutate({ ingestSeq: "-1" })],
    ["a zero-padded ingestSeq", mutate({ ingestSeq: "007" })],
    ["a decimal ingestSeq", mutate({ ingestSeq: "1.5" })],
    ["an empty ingestSeq", mutate({ ingestSeq: "" })],
    ["a hexadecimal ingestSeq", mutate({ ingestSeq: "0x1f" })],
    ["a non-canonical receivedMonotonicNs", mutate({ receivedMonotonicNs: "1e9" })],
    ["a receivedAt without an offset", mutate({ receivedAt: "2026-01-01T00:00:00" })],
    ["a receivedAt that is not a date", mutate({ receivedAt: "2026-13-45T99:99:99Z" })],
    ["a non-hex payloadSha256", mutate({ payloadSha256: "z".repeat(64) })],
    ["an uppercase payloadSha256", mutate({ payloadSha256: "A".repeat(64) })],
    ["a short payloadSha256", mutate({ payloadSha256: "abc" })],
    ["a non-string payloadUtf8", mutate({ payloadUtf8: 5 })],
    ["a null payloadUtf8", mutate({ payloadUtf8: null })],
  ];

  it.each(rejections)("rejects %s", (_label, value) => {
    expect(() => parseRawFrameRecord(value)).toThrow(WalRecordValidationError);
  });

  it("accepts ingestSeq beyond Number.MAX_SAFE_INTEGER as a string", () => {
    const huge = "9007199254740993000";
    const frame = createTestFrame({ ingestSeq: huge });
    expect(parseRawFrameRecord(frame).ingestSeq).toBe(huge);
  });

  it("accepts a receivedAt with a numeric offset", () => {
    const frame = createTestFrame({ receivedAt: "2026-01-01T00:00:00.123+02:00" });
    expect(parseRawFrameRecord(frame).receivedAt).toBe("2026-01-01T00:00:00.123+02:00");
  });
});

describe("compareIngestSeq", () => {
  it("orders by numeric value, not lexicographically", () => {
    expect(compareIngestSeq("9", "10")).toBeLessThan(0);
    expect(compareIngestSeq("10", "9")).toBeGreaterThan(0);
    expect(compareIngestSeq("10", "10")).toBe(0);
    expect(compareIngestSeq("99999999999999999999", "100000000000000000000")).toBeLessThan(0);
  });
});
