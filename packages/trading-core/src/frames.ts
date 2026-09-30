/**
 * `THROUGHPUT-2` (ADR-024) — what a VENUE FRAME is, as the core loop sees it.
 *
 * The venue delivers market data in frames: one Polymarket market-channel
 * WebSocket message is one frame, and a `price_change` message batches the
 * level changes of BOTH tokens of a pair into one `price_changes[]` array
 * (`docs/venue/verified-2026-09-16.md` §3: "`price_change` (`price_changes[]`
 * of `asset_id`, `price`, `size`, …)"). The adapter emits one
 * `BookLevelChanged` per entry, so one frame becomes several events, and the
 * book state between two of them never existed at the venue.
 *
 * The loop evaluates ONCE PER FRAME, after the frame's last event (ADR-024).
 * This module is the one definition of "the same frame", shared by every path
 * that feeds the loop — the live Redis feed, the backtest driver and every test
 * harness — so the loop groups identically whoever delivered the events.
 *
 * ## The frame key
 *
 * - `causationId`, when the envelope carries one. The gateway stamps every
 *   market-data event derived from a recorded raw frame with
 *   `raw:<gatewayEpoch>:<ingestSeq of the raw frame>`
 *   (`apps/data-gateway/src/envelope.ts` `rawFrameCausationId`), so the events
 *   of one raw frame share it and events of different frames never do.
 * - Otherwise the §7.1 dispatch identity `(gatewayEpoch, ingestSeq)`. A live
 *   gateway assigns every envelope its own `ingestSeq`, so a live event without
 *   a `causationId` is a frame of one; a REPLAY of recorded raw frames stamps
 *   every envelope a normalizer derives from one record with that record's
 *   identity (`apps/backtest-cli/src/normalizer.ts`), so they group exactly as
 *   the live gateway's `causationId` grouped them.
 *
 * Two events are in the same frame iff they are CONSECUTIVE in delivery order
 * and their keys are equal. The key is read from the event's own data
 * properties only (never a getter, never the prototype chain): it decides
 * grouping, not validity — the event door still judges every event.
 */

/** A frame key, or `undefined` when the event names neither a causation nor a dispatch identity. */
export type FrameKey = string;

function ownDataString(record: unknown, key: string): string | undefined {
  if (typeof record !== "object" || record === null) return undefined;
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(record, key);
  } catch {
    return undefined;
  }
  if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) return undefined;
  const value: unknown = descriptor.value;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The frame key of one envelope (see the module header), or `undefined` when it
 * carries neither — such an event is always a frame of its own.
 */
export function frameKeyOf(envelope: unknown): FrameKey | undefined {
  const causation = ownDataString(envelope, "causationId");
  if (causation !== undefined) return `causation:${causation}`;
  const epoch = ownDataString(envelope, "gatewayEpoch");
  const seq = ownDataString(envelope, "ingestSeq");
  if (epoch === undefined || seq === undefined) return undefined;
  return `dispatch:${epoch}:${seq}`;
}

/** Do two consecutive envelopes belong to one frame? `false` when either has no key. */
export function sameFrame(left: unknown, right: unknown): boolean {
  const leftKey = frameKeyOf(left);
  return leftKey !== undefined && leftKey === frameKeyOf(right);
}
