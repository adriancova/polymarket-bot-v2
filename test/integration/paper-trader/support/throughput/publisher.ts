/**
 * `THROUGHPUT-1a` — publishing the recorded burst into the stream, through the
 * REAL `packages/event-bus` publish API, one envelope per `publish` call in
 * stream order, as the gateway publishes.
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

/** The one method of the transport this module uses. */
export interface EnvelopePublisher {
  publish(stream: string, envelope: EventEnvelope<unknown>): Promise<PublishReceipt>;
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

  for (let index = 0; index < envelopes.length; index += 1) {
    const envelope = envelopes[index];
    if (envelope === undefined) continue;
    if (mode === "paced" && index >= paceFrom) {
      const target = startedAtMs + (Date.parse(envelope.receivedAt) - baseReceivedMs);
      const wait = target - preciseNowMs();
      if (wait > 1) await sleep(wait);
      const slip = preciseNowMs() - target;
      if (slip > maxScheduleSlipMs) maxScheduleSlipMs = slip;
    }
    const receipt = await transport.publish(stream, envelope);
    lastSequence = receipt.sequence;
    publishedAtMs.push(preciseNowMs());
  }

  return {
    publishedAtMs,
    startedAtMs,
    finishedAtMs: preciseNowMs(),
    maxScheduleSlipMs,
    lastSequence,
  };
}
