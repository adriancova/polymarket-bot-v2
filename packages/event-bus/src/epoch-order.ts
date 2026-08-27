/**
 * Per-gateway-epoch ordering (ADR-002 §2, ADR-003 §2).
 *
 * `(gatewayEpoch, ingestSeq)` is the only ordering authority in this system.
 * `gatewayEpoch` is a UUID assigned at gateway startup and `ingestSeq` is
 * monotonic within that epoch, so an event's position is defined only relative
 * to other events of the *same* epoch. Two epochs are two sequences, and
 * merging them into one apparent sequence is exactly what ADR-003 §2 forbids —
 * which is why this tracker keeps one cursor per epoch and never compares
 * across epochs.
 *
 * `ingestSeq` is a bigint serialized as a string (§7.1) and is compared with
 * `BigInt`. It is never coerced to a JavaScript `number`: two `ingestSeq`
 * values above `Number.MAX_SAFE_INTEGER` can differ while their `Number`
 * conversions are equal, which would silently turn a real ordering violation
 * into "no change".
 */

import { EventBusConfigurationError, EventBusEnvelopeError } from "./errors.js";

/**
 * Default cap on tracked epochs.
 *
 * A gateway process has one epoch, so this bound is never reached in normal
 * operation; it exists so a long-lived publisher that sees many epochs cannot
 * grow without limit. Eviction only weakens a defensive check for the evicted
 * epoch — it can never reorder, drop, or duplicate an event.
 */
export const DEFAULT_MAX_TRACKED_EPOCHS = 64;

export type EpochOrderObservation = {
  /** True when `ingestSeq` advanced strictly beyond the last one seen for the epoch. */
  readonly advanced: boolean;
  /** The last `ingestSeq` seen for this epoch, absent when this is the first. */
  readonly previousIngestSeq?: bigint;
  readonly ingestSeq: bigint;
};

export type EpochOrderTrackerOptions = {
  readonly maxTrackedEpochs?: number;
};

/**
 * Tracks the highest `ingestSeq` seen per gateway epoch.
 *
 * Two callers use it for different purposes:
 *
 * - the publisher **refuses** a non-advancing pair, because an event whose
 *   `(gatewayEpoch, ingestSeq)` does not advance has no defined position in the
 *   stream it is being appended to;
 * - a subscription **counts** non-advancing deliveries instead of refusing
 *   them, because at-least-once redelivery after an ambiguous publish is a
 *   legitimate duplicate and stopping a trader on one would be worse than
 *   reporting it.
 */
export class EpochOrderTracker {
  readonly #maxTrackedEpochs: number;
  readonly #lastByEpoch = new Map<string, bigint>();

  constructor(options: EpochOrderTrackerOptions = {}) {
    const max = options.maxTrackedEpochs ?? DEFAULT_MAX_TRACKED_EPOCHS;
    assertMaxTrackedEpochs(max);
    this.#maxTrackedEpochs = max;
  }

  get trackedEpochCount(): number {
    return this.#lastByEpoch.size;
  }

  /** The highest `ingestSeq` recorded for an epoch, if it is still tracked. */
  lastIngestSeq(gatewayEpoch: string): bigint | undefined {
    return this.#lastByEpoch.get(gatewayEpoch);
  }

  /**
   * Records an event's position.
   *
   * State advances only when `ingestSeq` strictly increases, so a caller that
   * treats `advanced: false` as a failure and retries with the same values gets
   * the same answer rather than a moving target.
   */
  observe(gatewayEpoch: string, ingestSeq: string): EpochOrderObservation {
    const parsed = parseIngestSeq(ingestSeq);
    const previous = this.#lastByEpoch.get(gatewayEpoch);
    if (previous !== undefined && parsed <= previous) {
      return { advanced: false, previousIngestSeq: previous, ingestSeq: parsed };
    }
    // Re-inserting moves the epoch to the end of the Map's insertion order,
    // which makes the eviction below least-recently-used rather than
    // first-ever-seen.
    this.#lastByEpoch.delete(gatewayEpoch);
    this.#lastByEpoch.set(gatewayEpoch, parsed);
    this.#evictIfNeeded();
    return previous === undefined
      ? { advanced: true, ingestSeq: parsed }
      : { advanced: true, previousIngestSeq: previous, ingestSeq: parsed };
  }

  /** Forgets every epoch. Used when a subscription repositions after a hard resync. */
  reset(): void {
    this.#lastByEpoch.clear();
  }

  #evictIfNeeded(): void {
    while (this.#lastByEpoch.size > this.#maxTrackedEpochs) {
      const oldest = this.#lastByEpoch.keys().next();
      if (oldest.done === true) {
        return;
      }
      this.#lastByEpoch.delete(oldest.value);
    }
  }
}

/** Validates an epoch-tracking bound, so a bad one fails at connect time. */
export function assertMaxTrackedEpochs(maxTrackedEpochs: number): void {
  if (!Number.isSafeInteger(maxTrackedEpochs) || maxTrackedEpochs < 1) {
    throw new EventBusConfigurationError(
      `maxTrackedEpochs must be a positive safe integer, received ${String(maxTrackedEpochs)}`,
      { maxTrackedEpochs },
    );
  }
}

/** Parses a §7.1 `ingestSeq` as a bigint, never as a `number`. */
export function parseIngestSeq(ingestSeq: string): bigint {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(ingestSeq)) {
    throw new EventBusEnvelopeError(
      "ingestSeq must be a canonical unsigned integer string (§7.1)",
      { ingestSeq },
    );
  }
  return BigInt(ingestSeq);
}
