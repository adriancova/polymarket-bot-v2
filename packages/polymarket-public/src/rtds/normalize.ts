/**
 * RTDS frame → `ReferenceTwapObserved`.
 *
 * One inbound frame in, one outcome per envelope out: an event or a problem,
 * never nothing (§8.3). Nothing here throws — a throw in a message loop is how
 * an event gets dropped — and every problem carries the raw envelope so an
 * incident carries its evidence.
 *
 * ## Symbol and window are explicit on every event (`WP-100` acceptance 1)
 *
 * `symbol` comes from the payload, unmodified. `windowSeconds` comes from
 * `payload.window_s` AND is cross-checked against the window its own topic
 * publishes; a disagreement is a contradiction the adapter refuses rather than
 * resolving by preferring one side. Neither is ever inferred from update
 * frequency, which the venue page explicitly forbids ("never infer the window
 * from update frequency").
 *
 * ## The two instants, and the two clocks
 *
 * | Fact | Wire field | Where it lands |
 * | --- | --- | --- |
 * | Chainlink observation time | `payload.timestamp` | `windowEndAt` (and the window arithmetic) |
 * | Publisher submission to RTDS | envelope `timestamp` | `provenance.venueTimestamp` |
 * | Receipt by this process | this host's clock | the raw record, and `quality.observationAgeMs` |
 *
 * Verbatim: "Use payload.timestamp as the Chainlink observation time; the outer
 * timestamp is when the publisher submitted the update to RTDS." The three are
 * kept distinct and none is substituted for another.
 *
 * They are also read with DIFFERENT strictness, on purpose. The observation time
 * is load-bearing — it becomes `windowEndAt`, anchors `windowStartAt`, and is
 * the identity duplicates and ordering are decided on — so it is parsed as Unix
 * epoch milliseconds and nothing else (`normalizeRtdsObservationInstant`; the
 * frozen report §10.3 writes the field as `timestamp (unix ms)`). The publisher
 * timestamp is provenance nothing is computed from, and its documented type
 * already allows it to be absent, so it keeps the package's generic epoch-like
 * reading (`normalizeRtdsPublisherInstant`). Swapping the two would put a
 * seconds-versus-milliseconds heuristic on the one field that cannot survive
 * one.
 *
 * ## Where the window's start comes from — a documented derivation, not a fact
 *
 * `ReferenceTwapObserved` requires `windowStartAt` and `windowEndAt`. RTDS
 * publishes neither: it publishes one instant and a window length. This adapter
 * therefore reports the DOCUMENTED LOOKBACK INTERVAL anchored at the observation
 * time — `windowEndAt = payload.timestamp`, `windowStartAt = windowEndAt −
 * window_s seconds` — because "a time-weighted average price (TWAP) represents
 * an asset's price across a lookback window" and the window is a lookback, not a
 * forward or centred interval.
 *
 * That is a derivation, and it is registered as **RTDS-U5** rather than
 * presented as a venue fact: the same page states that "Chainlink does not
 * currently publish the custom feed's sampling boundaries, weighting, rounding,
 * or missing-input behavior". The observation instant itself is published and is
 * carried unmodified as `windowEndAt`; only the start is derived, and only by
 * subtracting the published window length.
 */

import { ReferenceTwapObservedContract } from "@polymarket-bot/domain";
import type { ReferenceTwapObservedPayload } from "@polymarket-bot/domain";

import { boundDetail } from "../normalize/result.js";
import {
  RTDS_TWAP_WINDOW_BY_TOPIC,
  RTDS_UPDATE_TYPE,
  isTwapTopic,
  rtdsTopicChannel,
} from "./config.js";
import type { ObservationFacts, TwapObservationTracker } from "./observations.js";
import type {
  NormalizedTwapObservation,
  RtdsEventProvenance,
  RtdsNormalization,
  RtdsProblem,
  RtdsProblemCode,
} from "./result.js";
import {
  normalizeFullAccuracyValue,
  normalizeRtdsObservationInstant,
  normalizeRtdsPublisherInstant,
  shiftInstant,
} from "./values.js";
import { RtdsEnvelopeSchema, RtdsTwapUpdatePayloadSchema } from "./venue.js";

/** The domain's bound on identifier-like strings, which `symbol` is one of. */
const MAX_SYMBOL_LENGTH = 200;

/** Everything normalization needs that is not in the frame. */
export interface RtdsNormalizationContext {
  /** Channel used for problems that never got as far as naming a topic. */
  readonly sourceChannel: string;
  readonly connectionId: string;
  readonly subscriptionGeneration: number;
  /** Topics the current subscription actually asked for. */
  readonly subscribedTopics: ReadonlySet<string>;
  /** This host's receipt time, for the age diagnostic. Never a venue fact. */
  readonly receivedEpochMs: number;
  /** Series history. Consulted before the domain boundary, updated after it. */
  readonly tracker: TwapObservationTracker;
}

/** Normalizes every envelope in one decoded frame. */
export function normalizeRtdsFrame(
  values: readonly unknown[],
  context: RtdsNormalizationContext,
): RtdsNormalization {
  const events: NormalizedTwapObservation[] = [];
  const problems: RtdsProblem[] = [];
  let invalidPublisherTimestamps = 0;

  for (const [observedIndex, value] of values.entries()) {
    const outcome = normalizeEnvelope(value, observedIndex, context);
    if (outcome.kind === "problem") {
      problems.push(outcome.problem);
      continue;
    }
    if (outcome.invalidPublisherTimestamp) invalidPublisherTimestamps += 1;
    events.push(outcome.event);
  }

  return { events, problems, invalidPublisherTimestamps };
}

type EnvelopeOutcome =
  | { readonly kind: "problem"; readonly problem: RtdsProblem }
  | {
      readonly kind: "event";
      readonly event: NormalizedTwapObservation;
      readonly invalidPublisherTimestamp: boolean;
    };

/**
 * Judges one envelope.
 *
 * Deliberately one linear refusal chain, in the order a frame becomes
 * trustworthy: shape, topic, subscription, message type, payload shape, symbol,
 * window agreement, observation instant, exact value, sign, window arithmetic,
 * series history, domain contract. Splitting it would hide that order, and the
 * order is what a review needs to read.
 */
function normalizeEnvelope(
  value: unknown,
  observedIndex: number,
  context: RtdsNormalizationContext,
): EnvelopeOutcome {
  const problem = (
    code: RtdsProblemCode,
    detail: string,
    extra: { readonly topic?: string; readonly symbol?: string; readonly channel?: string } = {},
  ): EnvelopeOutcome => ({
    kind: "problem",
    problem: {
      code,
      detail: boundDetail(detail),
      sourceChannel: extra.channel ?? context.sourceChannel,
      ...(extra.topic === undefined ? {} : { topic: extra.topic }),
      ...(extra.symbol === undefined ? {} : { symbol: extra.symbol }),
      observedIndex,
      raw: value,
    },
  });

  const envelope = RtdsEnvelopeSchema.safeParse(value);
  if (!envelope.success) {
    return problem(
      "RTDS_INVALID_ENVELOPE",
      `envelope did not match the documented {topic, type, timestamp, payload} shape: ${describeIssues(envelope.error)}`,
    );
  }
  const { topic, type } = envelope.data;

  if (!isTwapTopic(topic)) {
    // The base channel and a truncated topic: an unknown topic is an untrusted
    // string of unbounded length, and it must not become a metric label or be
    // pasted into a channel name at full length.
    return problem(
      "RTDS_UNKNOWN_TOPIC",
      `topic "${truncate(topic)}" is not one of the two documented TWAP topics; this adapter models no other RTDS channel`,
      { topic: truncate(topic) },
    );
  }
  const channel = rtdsTopicChannel(topic);
  if (!context.subscribedTopics.has(topic)) {
    return problem(
      "RTDS_TOPIC_NOT_SUBSCRIBED",
      `an update arrived on "${topic}", which this feed's subscription did not request`,
      { topic, channel },
    );
  }
  if (type !== RTDS_UPDATE_TYPE) {
    return problem(
      "RTDS_UNKNOWN_MESSAGE_TYPE",
      `type "${truncate(type)}" is not the documented "${RTDS_UPDATE_TYPE}"; no other message type is documented for these topics`,
      { topic, channel },
    );
  }

  const parsed = RtdsTwapUpdatePayloadSchema.safeParse(envelope.data.payload);
  if (!parsed.success) {
    return problem(
      "RTDS_INVALID_TWAP_PAYLOAD",
      `payload did not match the documented {symbol, value, full_accuracy_value, timestamp, window_s} shape: ${describeIssues(parsed.error)}`,
      { topic, channel },
    );
  }
  const payload = parsed.data;

  if (payload.symbol === "" || payload.symbol.length > MAX_SYMBOL_LENGTH) {
    return problem(
      "RTDS_INVALID_SYMBOL",
      `symbol must be a non-empty string of at most ${String(MAX_SYMBOL_LENGTH)} characters, received ${String(payload.symbol.length)}`,
      // Truncated: this is the one branch where the symbol is known NOT to
      // satisfy the domain's bound, and an over-long one must not be copied on.
      { topic, symbol: truncate(payload.symbol), channel },
    );
  }

  const topicWindow = RTDS_TWAP_WINDOW_BY_TOPIC[topic];
  if (payload.window_s !== topicWindow) {
    return problem(
      "RTDS_WINDOW_TOPIC_MISMATCH",
      `payload window_s ${String(payload.window_s)} contradicts topic "${topic}", which publishes a ${String(topicWindow)}-second window; the window is never guessed from one side`,
      { topic, symbol: payload.symbol, channel },
    );
  }

  // Strict Unix epoch milliseconds — NOT the generic epoch-like reading the
  // publisher timestamp gets a few lines below. See
  // `normalizeRtdsObservationInstant`: this value becomes `windowEndAt`, anchors
  // `windowStartAt`, and is the identity duplicates and ordering are decided on.
  const observation = normalizeRtdsObservationInstant(payload.timestamp);
  if (observation.status !== "ok") {
    return problem(
      "RTDS_INVALID_OBSERVATION_TIMESTAMP",
      `payload timestamp (the Chainlink observation time) is unusable: ${
        observation.status === "absent" ? "absent" : observation.reason
      }`,
      { topic, symbol: payload.symbol, channel },
    );
  }

  const exactValue = normalizeFullAccuracyValue(payload.full_accuracy_value);
  if (exactValue.status !== "ok") {
    return problem(
      "RTDS_INVALID_TWAP_VALUE",
      exactValue.status === "absent"
        ? "full_accuracy_value is absent"
        : exactValue.reason,
      { topic, symbol: payload.symbol, channel },
    );
  }
  if (exactValue.value.startsWith("-")) {
    return problem(
      "RTDS_NEGATIVE_TWAP_VALUE",
      `the exact E18 value scales to ${exactValue.value}, and ReferenceTwapObserved.value is a non-negative decimal; a negative TWAP is reported rather than clamped or dropped`,
      { topic, symbol: payload.symbol, channel },
    );
  }

  const windowStart = shiftInstant(observation.value.epochMs, -topicWindow * 1000);
  if (windowStart.status !== "ok") {
    return problem(
      "RTDS_INVALID_OBSERVATION_TIMESTAMP",
      `the ${String(topicWindow)}-second lookback window before ${observation.value.iso} is not a representable instant`,
      { topic, symbol: payload.symbol, channel },
    );
  }

  const facts: ObservationFacts = {
    topic,
    symbol: payload.symbol,
    observationEpochMs: observation.value.epochMs,
    observationIso: observation.value.iso,
    value: exactValue.value,
    subscriptionGeneration: context.subscriptionGeneration,
    receivedEpochMs: context.receivedEpochMs,
  };
  const verdict = context.tracker.judge(facts);
  if (verdict.status === "duplicate") {
    return problem(
      "RTDS_DUPLICATE_OBSERVATION",
      `${payload.symbol} already published an identical observation for ${verdict.previousObservationAt}; republishing it would double-count one TWAP`,
      { topic, symbol: payload.symbol, channel },
    );
  }
  if (verdict.status === "conflict") {
    return problem(
      "RTDS_CONFLICTING_OBSERVATION",
      `${payload.symbol} restated observation ${verdict.previousObservationAt} with ${exactValue.value} after publishing ${verdict.previousValue}; the venue contradicted itself and neither value is silently preferred`,
      { topic, symbol: payload.symbol, channel },
    );
  }

  const domainPayload: ReferenceTwapObservedPayload = {
    venue: "rtds",
    symbol: payload.symbol,
    feedId: topic,
    value: exactValue.value,
    windowSeconds: topicWindow,
    windowStartAt: windowStart.value.iso,
    windowEndAt: observation.value.iso,
  };
  const validated = ReferenceTwapObservedContract.payloadSchema.safeParse(domainPayload);
  if (!validated.success) {
    return problem(
      "RTDS_PAYLOAD_CONTRACT_VIOLATION",
      `the normalized payload was rejected by ReferenceTwapObserved: ${describeIssues(validated.error)}`,
      { topic, symbol: payload.symbol, channel },
    );
  }

  const publisher = normalizeRtdsPublisherInstant(envelope.data.timestamp);
  const provenance: RtdsEventProvenance = {
    source: "rtds",
    sourceChannel: channel,
    ...(publisher.status === "ok" ? { venueTimestamp: publisher.value.iso } : {}),
    connectionId: context.connectionId,
    subscriptionGeneration: context.subscriptionGeneration,
    observedIndex,
  };

  // Only now, past the domain boundary: a refused observation must not reserve
  // its identity, or a corrected restatement would be suppressed as a duplicate
  // of something that was never published.
  context.tracker.remember(facts);

  return {
    kind: "event",
    event: {
      eventType: "ReferenceTwapObserved",
      schemaVersion: ReferenceTwapObservedContract.schemaVersion,
      payload: domainPayload,
      provenance,
      quality: verdict.quality,
    },
    invalidPublisherTimestamp: publisher.status === "invalid",
  };
}

function describeIssues(error: {
  readonly issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[];
}): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ");
}

function truncate(value: string): string {
  return value.length <= 64 ? value : `${value.slice(0, 61)}...`;
}
