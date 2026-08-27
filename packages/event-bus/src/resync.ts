/**
 * Detecting that retention overtook a consumer (ADR-003 §3.3).
 *
 * ## Why a publication counter exists at all
 *
 * "The consumer's position is older than the oldest retained event" is not by
 * itself evidence of loss: a position can be older than everything retained
 * simply because nothing has been published since. What distinguishes the two
 * cases is *how many* events were published, so the transport keeps a
 * contiguous publication counter per stream — 1 for the first event ever, and
 * one more for each event after it — and stores it with each event.
 *
 * With that counter, loss is exact rather than inferred: the consumer knows
 * which ordinal it consumed last, and the first surviving event announces its
 * own ordinal. If the two are not consecutive, the difference is precisely the
 * number of events retention removed before the consumer read them. That is
 * the number ADR-003 §3.3 needs a consumer to be told, instead of letting it
 * "resume from the oldest surviving entry as though nothing were missing".
 *
 * This module is pure arithmetic so the rule can be tested exhaustively
 * without a container.
 */

import { EventBusConfigurationError } from "./errors.js";

export type SequenceContinuity =
  /** Everything the consumer has not read is still retained. */
  | { readonly kind: "continuous" }
  /** Retention removed `missedEventCount` events the consumer had not read. */
  | { readonly kind: "gap"; readonly missedEventCount: number }
  /**
   * The counters cannot be reconciled: the stream reports fewer publications
   * than the consumer has already consumed. Reported rather than clamped,
   * because a consumer that cannot know what it missed must resynchronize.
   */
  | { readonly kind: "inconsistent"; readonly detail: string };

/**
 * The two moments a gap can first become visible.
 *
 * They are separate cases rather than one set of optional fields because they
 * mean different things. On `delivery` the arriving event *is* the evidence: it
 * is the oldest surviving event after the consumer's position, so anything
 * between the two is gone. On `stream-state` nothing arrived, and the question
 * is whether the silence means "nothing published" or "everything published
 * since has already been removed" — which only the publication total can
 * answer.
 */
export type SequenceContinuityInput =
  | {
      readonly source: "delivery";
      /** Publication ordinal of the last event this consumer read (0 before the first). */
      readonly lastDeliveredSequence: number;
      /** Publication ordinal of the event that just arrived. */
      readonly arrivingSequence: number;
    }
  | {
      readonly source: "stream-state";
      readonly lastDeliveredSequence: number;
      /**
       * Publication ordinal of the oldest event still retained, or `undefined`
       * when the stream retains nothing.
       */
      readonly firstRetainedSequence: number | undefined;
      /** Total events ever published to the stream. */
      readonly publishedTotal: number;
    };

/** Decides whether a consumer at `lastDeliveredSequence` can continue reading. */
export function checkSequenceContinuity(input: SequenceContinuityInput): SequenceContinuity {
  assertNonNegativeInteger(input.lastDeliveredSequence, "lastDeliveredSequence");

  if (input.source === "delivery") {
    assertNonNegativeInteger(input.arrivingSequence, "arrivingSequence");
    if (input.arrivingSequence <= input.lastDeliveredSequence) {
      return {
        kind: "inconsistent",
        detail:
          `an event arrived with publication ordinal ${String(input.arrivingSequence)}, which this ` +
          `consumer already consumed (last was ${String(input.lastDeliveredSequence)}); the stream's ` +
          "publication counter was reset",
      };
    }
    const missed = input.arrivingSequence - input.lastDeliveredSequence - 1;
    return missed > 0 ? { kind: "gap", missedEventCount: missed } : { kind: "continuous" };
  }

  assertNonNegativeInteger(input.publishedTotal, "publishedTotal");
  if (input.firstRetainedSequence !== undefined) {
    assertNonNegativeInteger(input.firstRetainedSequence, "firstRetainedSequence");
  }

  if (input.publishedTotal < input.lastDeliveredSequence) {
    return {
      kind: "inconsistent",
      detail:
        `the stream reports ${String(input.publishedTotal)} published events but this consumer ` +
        `has already consumed ${String(input.lastDeliveredSequence)}; the stream was truncated or reset`,
    };
  }

  if (input.firstRetainedSequence === undefined) {
    const missed = input.publishedTotal - input.lastDeliveredSequence;
    return missed > 0 ? { kind: "gap", missedEventCount: missed } : { kind: "continuous" };
  }

  const missed = input.firstRetainedSequence - input.lastDeliveredSequence - 1;
  return missed > 0 ? { kind: "gap", missedEventCount: missed } : { kind: "continuous" };
}

function assertNonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new EventBusConfigurationError(
      `${field} must be a non-negative safe integer, received ${String(value)}`,
      { field, value },
    );
  }
}
