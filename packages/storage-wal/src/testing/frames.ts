/**
 * Frame builders for tests.
 *
 * The defaults describe a plausible Polymarket market-channel frame, but no test
 * here asserts a venue fact: the payloads are illustrative, and the only
 * payload shapes that matter to this package are "a string" and "the exact
 * bytes handed in".
 */

import { buildRawFrameRecord } from "../raw-frame.js";
import type { RawFrameRecord } from "../raw-frame.js";

export const TEST_GATEWAY_EPOCH = "0190a3e0-0000-7000-8000-000000000001";

export type TestFrameOverrides = {
  readonly gatewayEpoch?: string;
  readonly ingestSeq?: string | number | bigint;
  readonly source?: string;
  readonly endpoint?: string;
  readonly connectionId?: string;
  readonly subscriptionGeneration?: number;
  readonly receivedAt?: string;
  readonly receivedMonotonicNs?: string | bigint;
  readonly payloadUtf8?: string;
};

/** Build a valid {@link RawFrameRecord}, computing the payload digest. */
export function createTestFrame(overrides: TestFrameOverrides = {}): RawFrameRecord {
  const ingestSeq = overrides.ingestSeq ?? 1;
  const monotonic = overrides.receivedMonotonicNs ?? BigInt(ingestSeq) * 1_000_000n;
  return buildRawFrameRecord({
    gatewayEpoch: overrides.gatewayEpoch ?? TEST_GATEWAY_EPOCH,
    ingestSeq: String(ingestSeq),
    source: overrides.source ?? "polymarket",
    endpoint: overrides.endpoint ?? "wss://ws-subscriptions-clob.polymarket.com/ws/market",
    connectionId: overrides.connectionId ?? "conn-1",
    subscriptionGeneration: overrides.subscriptionGeneration ?? 0,
    receivedAt: overrides.receivedAt ?? "2026-01-01T00:00:00.000Z",
    receivedMonotonicNs: String(monotonic),
    payloadUtf8: overrides.payloadUtf8 ?? '{"event_type":"book","asset_id":"1"}',
  });
}

/** Build `count` frames with consecutive ingest sequence numbers. */
export function createTestFrames(
  count: number,
  overrides: TestFrameOverrides = {},
  startIngestSeq = 1,
): readonly RawFrameRecord[] {
  const frames: RawFrameRecord[] = [];
  for (let index = 0; index < count; index += 1) {
    frames.push(createTestFrame({ ...overrides, ingestSeq: startIngestSeq + index }));
  }
  return frames;
}
