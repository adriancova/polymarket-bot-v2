/**
 * What the RTDS adapter hands to the gateway: normalized events, problems, and
 * the data-quality facts that make a TWAP observation interpretable.
 *
 * ## Events are payloads, not envelopes
 *
 * The gateway (`WP-120`) assigns `eventId`, `gatewayEpoch`, `ingestSeq`,
 * `receivedAt`, `receivedMonotonicNs`, and the raw-record back-references (§7.1,
 * §9.1, ADR-002 §1). A normalized event here is `(eventType, schemaVersion,
 * payload)` plus the provenance the VENUE supplies, and nothing else — the same
 * shape the market adapter emits, for the same reason.
 *
 * ## No invented sequence number, and no invented history
 *
 * RTDS publishes no sequence number and this adapter invents none (§9.4,
 * ADR-002 §2.3). It also publishes no history: verbatim, "Subscriptions start
 * with the next update. There is no snapshot, history, or replay after a
 * disconnect." So the honest thing an adapter can say about a reconnect is what
 * it observed and what it did not, and {@link RtdsObservationQuality} is that
 * statement in typed, queryable form — not a log line, and not an inference
 * about how many updates were missed (the publication cadence is undocumented,
 * and the page explicitly forbids inferring it).
 *
 * ## Problems are data, not exceptions
 *
 * §8.3: "dropping trading or raw market events silently is forbidden". Every
 * envelope in every inbound frame produces exactly one outcome — one event or
 * one problem — and every problem carries the raw value so an incident carries
 * its evidence.
 */

import type {
  DataQualityIncidentOpenedPayload,
  FeedConnectedPayload,
  FeedDisconnectedPayload,
  FeedGapDetectedPayload,
  FeedStalePayload,
  ReferenceTwapObservedPayload,
  SchemaVersion,
} from "@polymarket-bot/domain";

/**
 * Venue-supplied provenance of one normalized RTDS event.
 *
 * `source` is pinned to `rtds`, which is the §7.1 envelope vocabulary's own
 * token for "Chainlink TWAP through Polymarket RTDS" and the same token
 * `ReferenceTwapObserved.venue` restates. The gateway copies it onto the
 * envelope, where it is authoritative (ADR-002 §5).
 */
export interface RtdsEventProvenance {
  readonly source: "rtds";
  /** The RTDS surface: the socket, or the specific topic once one is known. */
  readonly sourceChannel: string;
  /**
   * The PUBLISHER's timestamp — "when the publisher submitted the update to
   * RTDS" — not the Chainlink observation time, which is a payload field.
   * Absent when the envelope carried none, which its documented type allows.
   */
  readonly venueTimestamp?: string;
  /** Identifies the connection this arrived on, for the §7.1 provenance chain. */
  readonly connectionId?: string;
  /** Bumped on every (re)subscription, per §7.1 / ADR-002 §2.4. */
  readonly subscriptionGeneration?: number;
  /** Position of the envelope within the single frame being normalized. Not an ordinal. */
  readonly observedIndex: number;
}

/**
 * Everything the adapter can say about the completeness of one observation.
 *
 * This is the acceptance criterion "staleness is surfaced as data quality" in
 * concrete form: typed values a consumer can branch on and a dashboard can
 * aggregate, with no dependency on an observability package and no free text to
 * parse.
 *
 * What it deliberately does NOT contain is a count of missed updates. The
 * publication cadence is undocumented and the page says "never infer the window
 * from update frequency"; a `missedUpdates` field could only ever be a guess, so
 * the unobserved INTERVAL is reported instead — that one is measured, not
 * inferred.
 */
export interface RtdsObservationQuality {
  /** Nothing was ever observed for this series before, on any connection. */
  readonly firstObservationEver: boolean;
  /**
   * The first observation for this series since the current subscription began.
   *
   * True on the first update after connect AND after every reconnect, because
   * RTDS starts a subscription "with the next update" — there is no snapshot to
   * anchor to and nothing before it was received on this subscription.
   */
  readonly firstObservationOnSubscription: boolean;
  /** Chainlink observation time of the previous observation, on any connection. */
  readonly previousObservationAt?: string;
  /** Exact interval between the previous observation's venue time and this one. */
  readonly sincePreviousObservationMs?: number;
  /**
   * The interval this feed did NOT observe, when the previous observation came
   * from an earlier subscription.
   *
   * Present on the first observation of a subscription when a previous one is
   * known AND this one is NEWER than it — which is the ordinary case, because a
   * TWAP stream that resumes publishes forward. When the first observation after
   * the break is NOT newer (a regressed or replayed instant), the interval
   * cannot be measured from it: its two bounds would cross. The obligation is
   * then not discharged and not dropped either — it stays outstanding on the
   * series, {@link RtdsObservationQuality.unobservedIntervalUnavailable} says so
   * in typed form, and the interval is attached to the first later observation
   * that IS newer than the last pre-break one, whichever subscription that
   * arrives on (round-1 review finding M2).
   *
   * Exactly one of `unobservedInterval` and `unobservedIntervalUnavailable` is
   * ever present on one quality block; a series with no outstanding gap carries
   * neither.
   *
   * It is a measured interval between two real observations; how many updates
   * fell inside it is unknown and is not stated. A consumer must treat the
   * interval as unrecoverable — RTDS offers no replay — which is why ADR-009 §6
   * requires a TWAP-dependent strategy to HALT on an RTDS gap rather than
   * interpolate or backfill.
   */
  readonly unobservedInterval?: RtdsUnobservedInterval;
  /**
   * An unobserved interval that EXISTS but cannot be measured yet.
   *
   * Emitted on every observation of a series that has an outstanding
   * subscription break whose end bound has not been observed: the first
   * observation after the break was not newer than the last one before it, so no
   * two real observations bound the gap. The gap is still real, and this field
   * is the honest statement of it — the alternative, silently reporting no
   * interval, is exactly the defect round-1 review finding M2 records.
   *
   * A consumer must treat this the same way it treats
   * {@link RtdsObservationQuality.unobservedInterval}: as an unrecoverable break
   * in TWAP coverage. Its extent is a lower bound only — the gap started at
   * `fromAt` and has not been closed by any observation yet.
   */
  readonly unobservedIntervalUnavailable?: RtdsUnobservedIntervalUnavailable;
  /**
   * The Chainlink observation time is not newer than the newest already seen for
   * this series.
   *
   * The event is still published — it is a real observation, and ordering is the
   * gateway's business via `(gatewayEpoch, ingestSeq)` — but a consumer keeping
   * a "latest TWAP" must not let it overwrite a newer value.
   */
  readonly outOfOrder: boolean;
  /**
   * Receipt time minus the Chainlink observation time, in milliseconds.
   *
   * Two different clocks (this host's and the venue's), so it is a diagnostic,
   * not a precise measurement, and it can legitimately be negative when the
   * local clock lags. Reported because it is the only end-to-end freshness
   * signal available for a feed whose cadence is undocumented.
   */
  readonly observationAgeMs: number;
}

/** A measured interval of TWAP observations this feed did not receive. */
export interface RtdsUnobservedInterval {
  /** Chainlink observation time of the last update received before the break. */
  readonly fromAt: string;
  /**
   * Chainlink observation time of the first update received after it that is
   * newer than `fromAt` — which is the first update of the new subscription
   * unless that one regressed (see
   * {@link RtdsObservationQuality.unobservedIntervalUnavailable}).
   */
  readonly toAt: string;
  /** Strictly positive by construction: `toAt` is newer than `fromAt`. */
  readonly durationMs: number;
  /** Stable `CodeString`: RTDS provides no snapshot, history or replay. */
  readonly reasonCode: "RTDS_NO_REPLAY_AFTER_DISCONNECT";
  /** The subscription generation the last pre-break observation arrived under. */
  readonly previousSubscriptionGeneration: number;
}

/**
 * A real unobserved interval whose end bound has not been observed yet.
 *
 * Deliberately carries no `toAt` and no `durationMs`: there is no second real
 * observation to measure against, and inventing one is the thing this whole
 * adapter refuses to do. It names the bound it DOES have, and why the other is
 * missing.
 */
export interface RtdsUnobservedIntervalUnavailable {
  /** Chainlink observation time of the last update received before the break. */
  readonly fromAt: string;
  /**
   * Stable `CodeString`: no observation newer than `fromAt` has been received
   * since the break, so the interval has no measurable end bound yet. The
   * observation carrying this field is itself older than or equal to `fromAt`,
   * which is also why it is flagged `outOfOrder`.
   */
  readonly reasonCode: "RTDS_NO_OBSERVATION_NEWER_THAN_GAP";
  /** The subscription generation the last pre-break observation arrived under. */
  readonly previousSubscriptionGeneration: number;
}

/** One normalized domain event, ready for the gateway to envelope. */
export interface NormalizedRtdsEvent<TType extends string, TPayload> {
  readonly eventType: TType;
  readonly schemaVersion: SchemaVersion;
  readonly payload: TPayload;
  readonly provenance: RtdsEventProvenance;
}

/**
 * A normalized TWAP observation, with its data-quality facts attached.
 *
 * `quality` rides alongside the payload rather than inside it because
 * `ReferenceTwapObservedPayloadSchema` is frozen and strict: an adapter cannot
 * add fields to it, and should not want to — completeness is a fact about this
 * feed's reception, not about the venue's observation.
 */
export interface NormalizedTwapObservation
  extends NormalizedRtdsEvent<"ReferenceTwapObserved", ReferenceTwapObservedPayload> {
  readonly quality: RtdsObservationQuality;
}

/** Every feed-health event this adapter can emit. */
export type NormalizedRtdsFeedEvent =
  | NormalizedRtdsEvent<"FeedConnected", FeedConnectedPayload>
  | NormalizedRtdsEvent<"FeedDisconnected", FeedDisconnectedPayload>
  | NormalizedRtdsEvent<"FeedStale", FeedStalePayload>
  | NormalizedRtdsEvent<"FeedGapDetected", FeedGapDetectedPayload>
  | NormalizedRtdsEvent<"DataQualityIncidentOpened", DataQualityIncidentOpenedPayload>;

/**
 * Anything this adapter emits.
 *
 * `FeedResynchronized` is absent, and its absence is the design. That event
 * pins `authoritativeSnapshotApplied: true`, and no authoritative TWAP snapshot
 * exists to apply: RTDS publishes none, and Chainlink's own `getLatestReport`
 * needs credentials this package may not hold. An adapter that emitted it would
 * be asserting a recovery that cannot happen. See
 * `RtdsTwapFeed.acknowledgeUnobservedInterval`, which lets a caller clear the
 * adapter's gap state without publishing a recovery claim.
 */
export type NormalizedRtdsEventAny = NormalizedTwapObservation | NormalizedRtdsFeedEvent;

/**
 * Why an inbound value did not become an event.
 *
 * Each is a stable `CodeString` (§14.3 labels metrics by reason code), so a
 * caller branches and a dashboard aggregates on the code rather than the text.
 */
export type RtdsProblemCode =
  /** The frame was not JSON, or not an object/array carrying an envelope. */
  | "RTDS_UNRECOGNIZED_FRAME"
  /** A bare `PING`/`PONG` text frame, which RTDS does not document (RTDS-U2). */
  | "RTDS_UNDOCUMENTED_HEARTBEAT_TEXT"
  /** The envelope did not carry the documented `topic`/`type`/`payload` shape. */
  | "RTDS_INVALID_ENVELOPE"
  /** A well-formed envelope on a topic this adapter does not model. */
  | "RTDS_UNKNOWN_TOPIC"
  /**
   * A modelled topic this feed never subscribed to.
   *
   * Distinct from an unknown topic: the frame is intelligible, but nothing asked
   * for it, so publishing it would attribute data to a subscription that does
   * not exist. Reported with the raw envelope rather than published or dropped.
   */
  | "RTDS_TOPIC_NOT_SUBSCRIBED"
  /** A well-formed envelope whose `type` is not the documented `update`. */
  | "RTDS_UNKNOWN_MESSAGE_TYPE"
  /** A TWAP update whose payload no longer matches the documented shape. */
  | "RTDS_INVALID_TWAP_PAYLOAD"
  /** `symbol` was empty or exceeded the domain's identifier bound. */
  | "RTDS_INVALID_SYMBOL"
  /** `window_s` disagrees with the window its own topic publishes. */
  | "RTDS_WINDOW_TOPIC_MISMATCH"
  /** `full_accuracy_value` was absent, non-string, or not an exact E18 integer. */
  | "RTDS_INVALID_TWAP_VALUE"
  /** The exact TWAP value is negative, which `ReferenceTwapObserved` forbids. */
  | "RTDS_NEGATIVE_TWAP_VALUE"
  /** The Chainlink observation timestamp was absent or unusable. */
  | "RTDS_INVALID_OBSERVATION_TIMESTAMP"
  /** This exact observation was already published for this series. */
  | "RTDS_DUPLICATE_OBSERVATION"
  /**
   * The same observation instant was restated with a DIFFERENT exact value.
   *
   * A different fact from a duplicate, and worth its own code: a redelivery is
   * benign, a contradiction is not. Neither is published a second time, and both
   * carry the raw value.
   */
  | "RTDS_CONFLICTING_OBSERVATION"
  /** A payload the adapter built was rejected by its own domain contract. */
  | "RTDS_PAYLOAD_CONTRACT_VIOLATION"
  /**
   * A frame arrived on a connection this feed had already retired.
   *
   * Not published as current data — its subscription is gone — and not dropped
   * either (§8.3): the raw frame rides on the problem, labelled with the
   * connection it actually arrived on.
   */
  | "RTDS_STALE_CONNECTION_FRAME"
  /**
   * A frame arrived on a live connection BEFORE its subscription was written.
   *
   * A transport may deliver a frame from inside the socket factory call, after a
   * synchronous `onOpen` and before the handle is returned — before this feed
   * has sent the subscribe frame or advanced the generation. Nothing had been
   * subscribed, so the frame carries no subscription provenance and cannot be
   * published as current data. Reported with the payload attached, and still
   * preserved raw (§9.1).
   */
  | "RTDS_PRE_SUBSCRIPTION_FRAME";

/** One inbound value that did not become an event, with the evidence. */
export interface RtdsProblem {
  readonly code: RtdsProblemCode;
  /** Bounded human-readable text; never parsed. */
  readonly detail: string;
  readonly sourceChannel: string;
  /** The RTDS `topic`, when the frame got far enough to have one. */
  readonly topic?: string;
  /** The wire symbol, unnormalized, when one was in scope. */
  readonly symbol?: string;
  /** Position of the envelope within the frame. */
  readonly observedIndex: number;
  /** The offending value, preserved so an incident carries its evidence. */
  readonly raw: unknown;
}

/**
 * The result of normalizing one inbound frame.
 *
 * Total by construction: every envelope lands in exactly one of the two arrays.
 */
export interface RtdsNormalization {
  readonly events: readonly NormalizedTwapObservation[];
  readonly problems: readonly RtdsProblem[];
  /**
   * How many envelopes carried an unusable PUBLISHER timestamp.
   *
   * The outer `timestamp` is a provenance decoration — the payload's Chainlink
   * observation time is what the event is built from — and its documented type
   * already allows it to be absent (`timestamp: datetime | None`). An unusable
   * one therefore clears `venueTimestamp` instead of rejecting an otherwise
   * complete observation, which would be a far worse failure. It is counted
   * rather than silently tolerated, and the raw frame is preserved regardless.
   */
  readonly invalidPublisherTimestamps: number;
}
