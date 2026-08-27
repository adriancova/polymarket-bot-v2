/**
 * Typed anomalies — the reason nothing this adapter sees is ever dropped in
 * silence.
 *
 * Handoff §8.3: "dropping trading or raw market events silently is forbidden",
 * and ADR-002 §2.5 extends that to a *rejected* frame: the failure must be
 * routed to `DataQualityIncidentOpened` with the raw frame preserved. This
 * package therefore has exactly one way to react to something it cannot turn
 * into a normalized event — produce a {@link CoinbaseAnomaly} and hand it to the
 * caller alongside the raw frame. There is no branch anywhere in the package
 * that discards a frame without producing one.
 *
 * An anomaly is DATA, not an exception. Throwing out of a socket read loop would
 * lose the frame exactly as effectively as dropping it, and would stop the feed
 * for a single bad message.
 *
 * `severity` uses the §14.4 vocabulary that `DataQualityIncidentOpened` already
 * carries, so an incident routes without a second mapping table.
 */

import type { IncidentSeverity } from "@polymarket-bot/domain";

/**
 * Every way this adapter can fail to produce a normalized event, or can produce
 * one only with a caveat.
 *
 * Each value is a valid `CodeStringSchema` token, so it can be used directly as
 * a `DataQualityIncidentOpened.reasonCode` without a translation table that
 * could drift.
 */
export type CoinbaseAnomalyCode =
  /**
   * The transport delivered a non-text frame.
   *
   * ADR-004 §1 keeps binary frames out of the WAL format and requires an
   * amendment rather than a reinterpretation if a feed ever sends one. This
   * adapter therefore refuses to decode the bytes on a guess; it reports the
   * length and preserves nothing it would have had to invent.
   */
  | "COINBASE_FRAME_NOT_TEXT"
  /** The frame is text but not JSON, which the venue documents it always is. */
  | "COINBASE_FRAME_NOT_JSON"
  /** The frame is JSON but does not match the documented shape for its channel. */
  | "COINBASE_FRAME_SHAPE_INVALID"
  /** A channel this adapter does not recognize. Not an error — an UNKNOWN. */
  | "COINBASE_UNKNOWN_CHANNEL"
  /** An `events[].type` outside the documented `snapshot` / `update` pair. */
  | "COINBASE_UNKNOWN_EVENT_TYPE"
  /** A `market_trades[].side` outside the documented `BUY` / `SELL` pair. */
  | "COINBASE_UNKNOWN_TRADE_SIDE"
  /** A price or size the decimal canonicalizer refused. */
  | "COINBASE_ECONOMIC_FIELD_INVALID"
  /**
   * A venue time that is not the documented RFC 3339 form.
   *
   * Caught here rather than at the gateway because §7.1 types `venueTimestamp`
   * as an ISO-8601 timestamp: an adapter that passed an unparseable string
   * through would make the whole envelope fail validation downstream, where the
   * offending field is much harder to attribute.
   */
  | "COINBASE_TIMESTAMP_INVALID"
  /** A payload the frozen domain contract refused. Never coerced, never clamped. */
  | "COINBASE_DOMAIN_PAYLOAD_REJECTED"
  /** `sequence_num` skipped forward: the venue says messages were dropped. */
  | "COINBASE_SEQUENCE_GAP"
  /** `sequence_num` repeated or moved backwards: duplicate or out-of-order. */
  | "COINBASE_SEQUENCE_REGRESSED"
  /** A trade already normalized on this connection arrived again. */
  | "COINBASE_DUPLICATE_TRADE"
  /** A ticker frame restated a top of book identical to the last one emitted. */
  | "COINBASE_TOP_OF_BOOK_UNCHANGED"
  /** `heartbeat_counter` skipped: messages were missed even though none arrived. */
  | "COINBASE_HEARTBEAT_GAP"
  /** No frame has arrived for longer than the configured staleness bound. */
  | "COINBASE_FEED_STALE"
  /**
   * A reconnect re-established current state but did not, and cannot, recover
   * the trades that occurred while the socket was down (U-CB-2).
   */
  | "COINBASE_TRADE_HISTORY_NOT_BACKFILLED";

/**
 * One thing that happened which the caller must be able to see.
 *
 * `rawFrame` is the frame **exactly as received** whenever the anomaly concerns
 * one, so the caller can hand the same bytes to the WAL and to the incident.
 * It is absent only when the frame was not text, in which case
 * `rawFrameByteLength` records what there was instead — the honest report for a
 * payload the repository's raw-frame format cannot hold.
 */
export type CoinbaseAnomaly = {
  readonly code: CoinbaseAnomalyCode;
  readonly severity: IncidentSeverity;
  /** Human-readable, bounded, and safe to log. Never contains a credential. */
  readonly detail: string;
  readonly receivedAt: string;
  readonly connectionId: string;
  readonly subscriptionGeneration: number;
  readonly channel?: string;
  /** Venue-native product id, when the anomaly is attributable to one. */
  readonly symbol?: string;
  readonly sequenceNum?: number;
  readonly rawFrame?: string;
  readonly rawFrameByteLength?: number;
};

/**
 * Whether an anomaly means data was, or may have been, lost.
 *
 * Used to decide which anomalies open a data-quality incident by default. A
 * duplicate that was suppressed and an unchanged top of book are recorded but
 * lose nothing, so they are `LOG`; everything that could hide missing market
 * data is at least `NOTIFY`.
 */
export const COINBASE_ANOMALY_SEVERITY: Readonly<Record<CoinbaseAnomalyCode, IncidentSeverity>> = {
  COINBASE_FRAME_NOT_TEXT: "PAGE",
  COINBASE_FRAME_NOT_JSON: "NOTIFY",
  COINBASE_FRAME_SHAPE_INVALID: "NOTIFY",
  COINBASE_UNKNOWN_CHANNEL: "NOTIFY",
  COINBASE_UNKNOWN_EVENT_TYPE: "NOTIFY",
  COINBASE_UNKNOWN_TRADE_SIDE: "NOTIFY",
  COINBASE_ECONOMIC_FIELD_INVALID: "NOTIFY",
  COINBASE_TIMESTAMP_INVALID: "NOTIFY",
  COINBASE_DOMAIN_PAYLOAD_REJECTED: "NOTIFY",
  COINBASE_SEQUENCE_GAP: "PAGE",
  COINBASE_SEQUENCE_REGRESSED: "NOTIFY",
  COINBASE_DUPLICATE_TRADE: "LOG",
  COINBASE_TOP_OF_BOOK_UNCHANGED: "LOG",
  COINBASE_HEARTBEAT_GAP: "PAGE",
  COINBASE_FEED_STALE: "NOTIFY",
  COINBASE_TRADE_HISTORY_NOT_BACKFILLED: "NOTIFY",
};
