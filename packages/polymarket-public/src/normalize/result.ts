/**
 * What this adapter hands to the gateway: normalized events, and problems.
 *
 * ## Events are payloads, not envelopes
 *
 * The gateway (`WP-120`) assigns `eventId`, `gatewayEpoch`, `ingestSeq`,
 * `receivedAt`, `receivedMonotonicNs`, and the raw-record back-references
 * (§7.1, §9.1, ADR-002 §1). An adapter that minted any of those would be
 * inventing an ordering position it has no authority over. So a normalized
 * event here is `(eventType, schemaVersion, payload)` plus the provenance
 * fields the *venue* supplies, and nothing else.
 *
 * ## No invented venue sequence number
 *
 * Handoff §9.4 and ADR-002 §2.3 forbid it outright. There is no sequence field
 * on {@link PublicMarketEventProvenance}: ordering comes from
 * `(gatewayEpoch, ingestSeq)`, and the venue timestamp and venue-provided
 * hashes carried here are validation aids, not ordering keys. `observedIndex`
 * and {@link PublicMarketEventProvenance.entryIndex} exist only to keep one
 * inbound frame's outcomes in the order they appeared *inside that frame* —
 * they are scoped to a single `normalize*` call, are not comparable across
 * frames, and are never persisted as an ordinal.
 *
 * ## Problems are data, not exceptions
 *
 * §8.3: "dropping trading or raw market events silently is forbidden". Every
 * element of every inbound frame is accounted for in
 * {@link PublicMarketNormalization.events} and
 * {@link PublicMarketNormalization.problems}, and the contract suite asserts
 * that accounting. The unit is **the venue's own accounting unit**, which is
 * not always the frame element (round-1 finding L1):
 *
 * - an element that asserts one fact — a `book`, a trade, a tick-size change, a
 *   lifecycle event — produces exactly one event or exactly one problem;
 * - an element that batches N facts — a `price_change` with N entries in
 *   `price_changes` — produces exactly N outcomes, one per entry, each carrying
 *   the same `observedIndex` and its own `entryIndex`;
 * - an element that asserts nothing (an empty `price_changes`) produces exactly
 *   one problem, because a batch asserting no change is itself worth reporting.
 *
 * A problem carries the raw value so the caller can open a
 * `DataQualityIncidentOpened` with the evidence attached.
 */

import type {
  BestBidAskChangedPayload,
  BookLevelChangedPayload,
  BookSnapshotPayload,
  DataQualityIncidentOpenedPayload,
  FeedConnectedPayload,
  FeedDisconnectedPayload,
  FeedGapDetectedPayload,
  FeedResynchronizedPayload,
  FeedStalePayload,
  MarketDiscoveredPayload,
  MarketResolvedPayload,
  PublicTradeObservedPayload,
  SchemaVersion,
  TradingParametersChangedPayload,
} from "@polymarket-bot/domain";

/** Bound on the human-readable text carried by a problem (`MAX_DETAIL_LENGTH`). */
const MAX_DETAIL_LENGTH = 2000;

/**
 * The venue-supplied provenance of one normalized event.
 *
 * `source` is pinned to `polymarket` because this adapter reads exactly one
 * venue; the gateway copies it onto the envelope, where it is authoritative
 * (ADR-002 §5).
 */
export interface PublicMarketEventProvenance {
  readonly source: "polymarket";
  /** Which venue surface produced it — a WebSocket channel or a REST read. */
  readonly sourceChannel: string;
  /** The venue's own timestamp, when it supplies one. Data, never an order. */
  readonly venueTimestamp?: string;
  /** Identifies the connection this arrived on, for the §7.1 provenance chain. */
  readonly connectionId?: string;
  /** Bumped on every (re)subscription, per §7.1 / ADR-002 §2.4. */
  readonly subscriptionGeneration?: number;
  /** Position of the ELEMENT within the single frame being normalized. Not an ordinal. */
  readonly observedIndex: number;
  /**
   * Position within a batching element, when the element carries a batch.
   *
   * A `price_change` element carries `price_changes: [...]`, and each entry is
   * its own book-level change. Those outcomes share an `observedIndex` — they
   * came from one frame element — so this is what totally orders them:
   * `(observedIndex, entryIndex ?? 0)` orders every outcome of one frame.
   * Absent for an element that is not a batch. Like `observedIndex`, scoped to
   * one `normalize*` call and never persisted as an ordinal.
   */
  readonly entryIndex?: number;
}

/** One normalized domain event, ready for the gateway to envelope. */
export interface NormalizedPublicEvent<TType extends string, TPayload> {
  readonly eventType: TType;
  readonly schemaVersion: SchemaVersion;
  readonly payload: TPayload;
  readonly provenance: PublicMarketEventProvenance;
}

/** Every domain event this adapter can emit. */
export type NormalizedPublicMarketEvent =
  | NormalizedPublicEvent<"BookSnapshot", BookSnapshotPayload>
  | NormalizedPublicEvent<"BookLevelChanged", BookLevelChangedPayload>
  | NormalizedPublicEvent<"BestBidAskChanged", BestBidAskChangedPayload>
  | NormalizedPublicEvent<"PublicTradeObserved", PublicTradeObservedPayload>
  | NormalizedPublicEvent<"TradingParametersChanged", TradingParametersChangedPayload>
  | NormalizedPublicEvent<"MarketDiscovered", MarketDiscoveredPayload>
  | NormalizedPublicEvent<"MarketResolved", MarketResolvedPayload>;

/** Every feed-health event this adapter can emit. */
export type NormalizedPublicFeedEvent =
  | NormalizedPublicEvent<"FeedConnected", FeedConnectedPayload>
  | NormalizedPublicEvent<"FeedDisconnected", FeedDisconnectedPayload>
  | NormalizedPublicEvent<"FeedStale", FeedStalePayload>
  | NormalizedPublicEvent<"FeedGapDetected", FeedGapDetectedPayload>
  | NormalizedPublicEvent<"FeedResynchronized", FeedResynchronizedPayload>
  | NormalizedPublicEvent<"DataQualityIncidentOpened", DataQualityIncidentOpenedPayload>;

/** Anything this adapter emits. */
export type NormalizedPublicEventAny =
  | NormalizedPublicMarketEvent
  | NormalizedPublicFeedEvent;

/**
 * Why an inbound value did not become an event.
 *
 * Each is a stable `CodeString` (§14.3 labels metrics by reason code), so a
 * caller branches and a dashboard aggregates on the code rather than the text.
 */
export type PublicMarketProblemCode =
  /** The frame was not JSON, or not an object carrying a string `event_type`. */
  | "UNRECOGNIZED_FRAME"
  /** A well-formed event whose `event_type` this adapter does not model yet. */
  | "UNKNOWN_EVENT_TYPE"
  /** A modelled event type whose payload no longer matches the wire schema. */
  | "INVALID_EVENT_PAYLOAD"
  /** `side` carried a value outside the documented `BUY`/`SELL` enumeration. */
  | "UNKNOWN_SIDE"
  /** A decimal could not be normalized to the canonical form. */
  | "INVALID_DECIMAL"
  /** A price normalized cleanly but falls outside the `[0, 1]` domain bound. */
  | "PRICE_OUT_OF_RANGE"
  /** A timestamp was not any epoch-like form the SDK accepts. */
  | "INVALID_TIMESTAMP"
  /** A token id is not a canonical unsigned integer string. */
  | "INVALID_TOKEN_ID"
  /** A condition id is empty or exceeds the identifier bound. */
  | "INVALID_CONDITION_ID"
  /** The catalogue does not know this token, so no `InternalMarketId` exists. */
  | "UNRESOLVED_MARKET"
  /** The catalogue declined to register a newly announced market. */
  | "UNREGISTERED_MARKET"
  /** The catalogue supplied no version for an observed parameter change. */
  | "UNASSIGNED_PARAMETER_VERSION"
  /** One side of a snapshot carried the same price twice; depth is ambiguous. */
  | "DUPLICATE_BOOK_LEVEL"
  /** A trade arrived without the size the domain payload requires. */
  | "MISSING_TRADE_SIZE"
  /** A trade size is zero or negative, which `PublicTradeObserved` forbids. */
  | "NON_POSITIVE_TRADE_SIZE"
  /** A resolution named no winning token, so the outcome is undetermined. */
  | "MISSING_WINNING_TOKEN"
  /** The winning token is neither of the market's two outcome tokens. */
  | "UNKNOWN_WINNING_TOKEN"
  /** A payload the adapter built was rejected by its own domain contract. */
  | "PAYLOAD_CONTRACT_VIOLATION"
  /**
   * A frame arrived on a connection this feed had already retired.
   *
   * Not published as current data — its subscription generation is gone — and
   * not dropped either (§8.3): the raw frame rides on the problem, labelled
   * with the connection it actually arrived on.
   */
  | "STALE_CONNECTION_FRAME";

/** One inbound value that did not become an event, with the evidence. */
export interface PublicMarketProblem {
  readonly code: PublicMarketProblemCode;
  /** Bounded human-readable text; never parsed. */
  readonly detail: string;
  readonly sourceChannel: string;
  /** The venue `event_type`, when the frame got far enough to have one. */
  readonly venueEventType?: string;
  /** The raw wire token id, unnormalized, when one was in scope. */
  readonly tokenId?: string;
  /** The raw wire condition id, when one was in scope. */
  readonly conditionId?: string;
  /** Position of the element within the frame, matching {@link PublicMarketEventProvenance}. */
  readonly observedIndex: number;
  /** Position within a batching element, matching {@link PublicMarketEventProvenance.entryIndex}. */
  readonly entryIndex?: number;
  /** The offending value, preserved so an incident carries its evidence. */
  readonly raw: unknown;
}

/**
 * The result of normalizing one inbound frame.
 *
 * Total by construction: every fact an inbound element asserts lands in exactly
 * one of the two arrays — one outcome per element, or one per batched entry for
 * an element that batches (see this module's header).
 */
export interface PublicMarketNormalization {
  readonly events: readonly NormalizedPublicMarketEvent[];
  readonly problems: readonly PublicMarketProblem[];
}

/** Truncates operational text to the domain's `MAX_DETAIL_LENGTH`. */
export function boundDetail(detail: string): string {
  return detail.length <= MAX_DETAIL_LENGTH ? detail : detail.slice(0, MAX_DETAIL_LENGTH);
}
