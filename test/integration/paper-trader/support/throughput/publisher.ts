/**
 * `THROUGHPUT-1a` — publishing the recorded burst into the stream, through the
 * REAL `packages/event-bus` publish API, in stream order, as the gateway
 * publishes.
 *
 * `THROUGHPUT-2` (ADR-024): the gateway now writes every envelope of one raw
 * frame (one `causationId`) in ONE atomic transport call
 * (`apps/data-gateway/src/publisher.ts`, "Frame-atomic runs"), and the
 * trader's feed relies on it. So does this publisher: a run of consecutive
 * envelopes sharing a `causationId` goes out in one `publishBatch` call when
 * the transport offers it (the Redis transport does), and alone otherwise.
 * A paced frame is scheduled at its FIRST envelope's recorded instant (the
 * gateway dispatches a frame's events in one turn).
 *
 * Two modes:
 *
 * - `catch-up`: every envelope as fast as the transport accepts it. The
 *   benchmark publishes everything BEFORE the trader subscribes, so the trader
 *   then drains a full backlog: the ceiling.
 * - `paced`: envelope `i` is published at `start + (receivedAt[i] −
 *   receivedAt[paceFrom])`, the recorded spacing (136 s for the H1 burst).
 *   Envelopes before `paceFrom` (the prepended `MarketOpened`) go out at once.
 *   If the transport falls behind the schedule, the next envelope goes out as
 *   soon as the previous one landed (never skipped, never reordered).
 *
 * Every publication instant is recorded (`performance.timeOrigin +
 * performance.now()`, epoch milliseconds with sub-millisecond precision), so
 * the benchmark can measure each event's lag from publication to the trader's
 * durable commit on ONE host clock.
 */

import { performance } from "node:perf_hooks";

import type { EventEnvelope } from "@polymarket-bot/domain";
import type { PublishReceipt } from "@polymarket-bot/event-bus";

export type PublishMode = "catch-up" | "paced";

/** The methods of the transport this module uses. */
export interface EnvelopePublisher {
  publish(stream: string, envelope: EventEnvelope<unknown>): Promise<PublishReceipt>;
  /** `THROUGHPUT-2`: one atomic call for one frame (`RedisStreamsEventTransport.publishBatch`). */
  publishBatch?(
    stream: string,
    envelopes: readonly EventEnvelope<unknown>[],
  ): Promise<{ readonly receipts: readonly PublishReceipt[]; readonly failure: { readonly index: number; readonly error: unknown } | undefined }>;
}

/** The index one past the end of the frame that starts at `start` (consecutive envelopes sharing a causationId). */
function frameEnd(envelopes: readonly EventEnvelope<unknown>[], start: number): number {
  const causation = envelopes[start]?.causationId;
  let end = start + 1;
  if (causation === undefined || causation === "") return end;
  while (end < envelopes.length && envelopes[end]?.causationId === causation) end += 1;
  return end;
}

export interface PublishLog {
  /** Epoch ms (sub-ms precision) at which each envelope's `publish` resolved, by index. */
  readonly publishedAtMs: readonly number[];
  readonly startedAtMs: number;
  readonly finishedAtMs: number;
  /** The largest amount by which a paced publication missed its schedule, in ms (0 in catch-up). */
  readonly maxScheduleSlipMs: number;
  /** The transport's publication ordinal of the last envelope. */
  readonly lastSequence: number;
}

/** Epoch milliseconds with sub-millisecond precision, on the host's clock. */
export function preciseNowMs(): number {
  return performance.timeOrigin + performance.now();
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function publishEnvelopes(options: {
  readonly transport: EnvelopePublisher;
  readonly stream: string;
  readonly envelopes: readonly EventEnvelope<unknown>[];
  readonly mode: PublishMode;
  /** Index of the first envelope the pacing is measured from (paced mode). Default 0. */
  readonly paceFrom?: number;
}): Promise<PublishLog> {
  const { transport, stream, envelopes, mode } = options;
  const paceFrom = options.paceFrom ?? 0;
  const baseEnvelope = envelopes[paceFrom];
  const baseReceivedMs = baseEnvelope === undefined ? 0 : Date.parse(baseEnvelope.receivedAt);
  const publishedAtMs: number[] = [];
  const startedAtMs = preciseNowMs();
  let maxScheduleSlipMs = 0;
  let lastSequence = 0;

  for (let index = 0; index < envelopes.length; ) {
    const envelope = envelopes[index];
    if (envelope === undefined) break;
    // A frame never straddles the pacing origin: the prepended envelopes
    // before `paceFrom` are published one by one, at once.
    const end = index < paceFrom ? index + 1 : frameEnd(envelopes, index);
    if (mode === "paced" && index >= paceFrom) {
      const target = startedAtMs + (Date.parse(envelope.receivedAt) - baseReceivedMs);
      const wait = target - preciseNowMs();
      if (wait > 1) await sleep(wait);
      const slip = preciseNowMs() - target;
      if (slip > maxScheduleSlipMs) maxScheduleSlipMs = slip;
    }
    if (end - index > 1 && transport.publishBatch !== undefined) {
      const frame = envelopes.slice(index, end);
      const result = await transport.publishBatch(stream, frame);
      if (result.failure !== undefined || result.receipts.length !== frame.length) {
        throw new Error(
          `publishBatch published ${String(result.receipts.length)} of ${String(frame.length)} envelopes: ` +
            String(result.failure?.error),
        );
      }
      const at = preciseNowMs();
      for (const receipt of result.receipts) {
        lastSequence = receipt.sequence;
        publishedAtMs.push(at);
      }
    } else {
      for (let member = index; member < end; member += 1) {
        const receipt = await transport.publish(stream, envelopes[member] as EventEnvelope<unknown>);
        lastSequence = receipt.sequence;
        publishedAtMs.push(preciseNowMs());
      }
    }
    index = end;
  }

  return {
    publishedAtMs,
    startedAtMs,
    finishedAtMs: preciseNowMs(),
    maxScheduleSlipMs,
    lastSequence,
  };
}
