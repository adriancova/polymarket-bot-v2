/**
 * Envelope fixtures for this package's own tests.
 *
 * Dev-only. These build §7.1 envelopes that the frozen domain schema accepts,
 * so a transport test exercises the real contract rather than a loosened
 * stand-in.
 *
 * `ingestSeq` is produced as a decimal string from a `bigint` counter, which is
 * what lets a test start a sequence above `Number.MAX_SAFE_INTEGER` and prove
 * the transport orders it correctly without ever converting it to a `number`.
 */

import { randomInt, randomUUID } from "node:crypto";

import type { EventEnvelope, EventSource } from "@polymarket-bot/domain";

export type TestEnvelopeOptions = {
  readonly gatewayEpoch?: string;
  readonly ingestSeq?: bigint | string;
  readonly eventType?: string;
  readonly schemaVersion?: number;
  readonly source?: EventSource;
  readonly sourceChannel?: string;
  readonly payload?: unknown;
  readonly receivedAt?: string;
  readonly receivedMonotonicNs?: string;
};

/** A canonical lowercase UUIDv7, as §7.1 requires for `eventId`. */
export function uuidV7(atMs: number = Date.now()): string {
  const timeHex = atMs.toString(16).padStart(12, "0").slice(-12);
  const random = randomBytesHex(9);
  const variant = "89ab".charAt(randomInt(0, 4));
  return (
    `${timeHex.slice(0, 8)}-${timeHex.slice(8, 12)}-7${random.slice(0, 3)}-` +
    `${variant}${random.slice(3, 6)}-${random.slice(6, 18)}`
  );
}

/** Builds one valid §7.1 envelope. */
export function createTestEnvelope(options: TestEnvelopeOptions = {}): EventEnvelope<unknown> {
  const ingestSeq = options.ingestSeq ?? 1n;
  return {
    eventId: uuidV7(),
    eventType: options.eventType ?? "BookSnapshot",
    schemaVersion: options.schemaVersion ?? 1,
    source: options.source ?? "polymarket",
    sourceChannel: options.sourceChannel ?? "market",
    receivedAt: options.receivedAt ?? new Date().toISOString(),
    receivedMonotonicNs: options.receivedMonotonicNs ?? "1000000000",
    gatewayEpoch: options.gatewayEpoch ?? randomUUID(),
    ingestSeq: typeof ingestSeq === "bigint" ? ingestSeq.toString() : ingestSeq,
    payload: options.payload ?? { note: "opaque to the transport" },
  };
}

/**
 * Builds a contiguous run of envelopes for one gateway epoch.
 *
 * The payload carries the position so a test can assert round-trip fidelity
 * and ordering from the delivered value alone.
 */
export function createTestEnvelopeSequence(options: {
  readonly count: number;
  readonly gatewayEpoch?: string;
  readonly startIngestSeq?: bigint;
  readonly label?: string;
}): readonly EventEnvelope<unknown>[] {
  const gatewayEpoch = options.gatewayEpoch ?? randomUUID();
  const start = options.startIngestSeq ?? 1n;
  const label = options.label ?? "e";
  const envelopes: EventEnvelope<unknown>[] = [];
  for (let index = 0; index < options.count; index += 1) {
    const ingestSeq = start + BigInt(index);
    envelopes.push(
      createTestEnvelope({
        gatewayEpoch,
        ingestSeq,
        payload: { label, ingestSeq: ingestSeq.toString(), index },
      }),
    );
  }
  return envelopes;
}

function randomBytesHex(byteLength: number): string {
  let hex = "";
  for (let index = 0; index < byteLength; index += 1) {
    hex += randomInt(0, 256).toString(16).padStart(2, "0");
  }
  return hex;
}
