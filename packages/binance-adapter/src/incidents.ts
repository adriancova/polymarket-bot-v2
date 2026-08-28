/**
 * Reason codes and feed-status/incident emission builders.
 *
 * WHY THIS FILE EXISTS SEPARATELY. The feed-status contracts in
 * `@polymarket-bot/domain` are deliberately unforgiving — `FeedGapDetected`
 * pins `requiresAuthoritativeSnapshot` to the literal `true`, `FeedResynchronized`
 * pins `authoritativeSnapshotApplied` to the literal `true`, every reason code
 * must match `CodeStringSchema`, and every incident needs an id. Putting the
 * construction of those documents in one place means the rules are read once,
 * in context, instead of being re-derived at five call sites.
 *
 * WHY THIS PACKAGE NEVER EMITS `FeedResynchronized`. ADR-002 §2.4: "A feed that
 * reconnected but has not yet applied a snapshot is recorded as `FeedConnected`
 * alongside the still-open gap and data-quality incident, **not** as a
 * `FeedResynchronized`." Binance publishes no authoritative snapshot on these
 * two streams — `web-socket-streams.md` (accessed 2026-08-27) documents no
 * resume, replay, or backfill parameter for `<symbol>@trade` or
 * `<symbol>@bookTicker`, and the only documented recovery procedure in the whole
 * page is the REST-snapshot-plus-buffer routine for `<symbol>@depth`, which is a
 * different stream and out of this package's scope. So a reconnect here can
 * never truthfully assert that a snapshot was applied, and the contract's
 * literal `true` is exactly what stops it from pretending otherwise. The
 * obligation is emitted and left open for the gateway.
 *
 * NOTE ON THE ABSENCE CLAIM. "The documentation defines no replay mechanism" is
 * a statement about the document, which is checkable. It is deliberately NOT the
 * stronger claim "the venue definitely drops data across a disconnect", which
 * the documentation does not make.
 */

import {
  DataQualityIncidentOpenedContract,
  FeedConnectedContract,
  FeedDisconnectedContract,
  FeedGapDetectedContract,
  FeedStaleContract,
  type DataQualityIncidentOpenedPayload,
  type FeedConnectedPayload,
  type FeedDisconnectedPayload,
  type FeedGapDetectedPayload,
  type FeedStalePayload,
  type IncidentSeverity,
} from "@polymarket-bot/domain";

import { buildEmission, type AdapterEmission, type EmissionProvenance } from "./emission.js";
import type { ReceiptStamp } from "./time.js";

/**
 * Every reason code this package can emit.
 *
 * All of them satisfy the domain's `CodeStringSchema`
 * (`^[A-Za-z][A-Za-z0-9_.:-]*$`, at most 64 characters), which is asserted in
 * the colocated test rather than trusted.
 */
export const BINANCE_REASON_CODES = {
  /** A first subscription starts mid-stream: nothing before it was observed. */
  subscriptionStart: "BINANCE_SUBSCRIPTION_START_NO_REPLAY",
  /** A resubscription: the documentation defines no replay across the gap. */
  reconnect: "BINANCE_RECONNECT_NO_REPLAY",
  /** The socket closed for a reason the transport reported. */
  socketClosed: "BINANCE_SOCKET_CLOSED",
  /** The transport reported an error on the socket. */
  socketError: "BINANCE_SOCKET_ERROR",
  /** The caller closed the feed deliberately. */
  clientShutdown: "BINANCE_CLIENT_SHUTDOWN",
  /** The venue announced a shutdown with the documented `serverShutdown` event. */
  serverShutdownNotice: "BINANCE_SERVER_SHUTDOWN_NOTICE",
  /** A frame was not JSON, or did not satisfy a documented payload shape. */
  frameMalformed: "BINANCE_FRAME_MALFORMED",
  /** A frame parsed but matched no documented in-scope shape (ADR-002 §7 UNKNOWN). */
  frameUnknown: "BINANCE_FRAME_UNKNOWN",
  /** A frame carried keys this package's schemas do not model: venue schema drift. */
  frameUnknownFields: "BINANCE_FRAME_UNKNOWN_FIELDS",
  /** The venue repeated an id with different content (see `SequenceOutcome`). */
  sequenceConflict: "BINANCE_SEQUENCE_CONFLICT",
  /** An economic value could not be represented at the domain boundary. */
  valueUnrepresentable: "BINANCE_VALUE_UNREPRESENTABLE",
  /**
   * One side of a `bookTicker` frame could not cross the boundary.
   *
   * A distinct code from `valueUnrepresentable`, at a lower severity, because
   * the venue does not document how it spells an empty book side (`BNC-U4`) and
   * an illiquid symbol may legitimately have one. A bad *trade* price is a
   * different kind of event and must not be diluted into the same bucket.
   */
  bookSideUnrepresentable: "BINANCE_BOOK_SIDE_UNREPRESENTABLE",
  /** The venue answered a control message with the documented error shape. */
  controlError: "BINANCE_CONTROL_ERROR",
  /**
   * A socket that is no longer the live one delivered an event.
   *
   * A superseded or already-closed socket can still fire a buffered message, an
   * error, or its close event. Applying any of them to the live connection would
   * label another socket's traffic with this connection's identity and
   * generation, or let a dead socket's close tear down a healthy feed, so they
   * are refused — and refusing without recording would be the silent drop §8.3
   * forbids (round-1 review, H1).
   */
  retiredConnectionEvent: "BINANCE_RETIRED_CONNECTION_EVENT",
  /**
   * A frame arrived while no socket was live.
   *
   * A transport delivers messages only between OPEN and CLOSE, so this is a
   * transport contract violation. It is classified rather than thrown: a throw
   * inside a socket callback is an unhandled rejection in the driver, and it
   * would destroy the frame instead of recording it.
   */
  frameWithoutConnection: "BINANCE_FRAME_WITHOUT_CONNECTION",
} as const;

export type BinanceReasonCode =
  (typeof BINANCE_REASON_CODES)[keyof typeof BINANCE_REASON_CODES];

/** Inputs shared by every feed-status emission. */
export type FeedStatusContext = {
  readonly feedId: string;
  readonly sourceChannel: string;
  readonly receipt: ReceiptStamp;
  readonly provenance: EmissionProvenance;
};

/**
 * `FeedConnected` (§7.4).
 *
 * `endpoint` is the endpoint identifier without the `?streams=…` query: the full
 * URL can exceed the domain's 200-character bound with a realistic subscription
 * set, the subscription set is already recorded per event as `sourceChannel`,
 * and a query-free endpoint is trivially credential-free — which matters because
 * the contract says of this field "Never contains credentials".
 */
export function feedConnected(
  context: FeedStatusContext,
  endpointIdentifier: string,
): AdapterEmission<FeedConnectedPayload> {
  const payload: FeedConnectedPayload = {
    feedId: context.feedId,
    connectionId: context.provenance.connectionId,
    endpoint: endpointIdentifier,
    subscriptionGeneration: context.provenance.subscriptionGeneration,
    connectedAt: context.receipt.receivedAt,
  };
  return buildEmission({
    contract: FeedConnectedContract,
    sourceChannel: context.sourceChannel,
    receipt: context.receipt,
    provenance: context.provenance,
    payload,
  });
}

/** `FeedDisconnected` (§7.4). */
export function feedDisconnected(
  context: FeedStatusContext,
  input: { readonly reasonCode: string; readonly detail?: string | undefined },
): AdapterEmission<FeedDisconnectedPayload> {
  const payload: FeedDisconnectedPayload = {
    feedId: context.feedId,
    connectionId: context.provenance.connectionId,
    disconnectedAt: context.receipt.receivedAt,
    reasonCode: input.reasonCode,
    ...(input.detail === undefined ? {} : { detail: input.detail }),
  };
  return buildEmission({
    contract: FeedDisconnectedContract,
    sourceChannel: context.sourceChannel,
    receipt: context.receipt,
    provenance: context.provenance,
    payload,
  });
}

/**
 * `FeedGapDetected` (§7.4).
 *
 * `requiresAuthoritativeSnapshot` is the contract's literal `true`; it is
 * repeated here only because the type demands it. `affectedMarketIds` is omitted
 * deliberately: that field holds `InternalMarketId` values (UUIDv7 per §7.2), and
 * a Binance symbol is not one. Coercing a symbol into that field would put a
 * value in a typed slot where it does not belong.
 */
export function feedGapDetected(
  context: FeedStatusContext,
  input: { readonly reasonCode: string; readonly detail?: string | undefined },
): AdapterEmission<FeedGapDetectedPayload> {
  const payload: FeedGapDetectedPayload = {
    feedId: context.feedId,
    connectionId: context.provenance.connectionId,
    detectedAt: context.receipt.receivedAt,
    reasonCode: input.reasonCode,
    ...(input.detail === undefined ? {} : { detail: input.detail }),
    requiresAuthoritativeSnapshot: true,
  };
  return buildEmission({
    contract: FeedGapDetectedContract,
    sourceChannel: context.sourceChannel,
    receipt: context.receipt,
    provenance: context.provenance,
    payload,
  });
}

/** `FeedStale` (§7.4, §8.3). */
export function feedStale(
  context: FeedStatusContext,
  input: { readonly stalenessMs: number; readonly lastMessageAt?: string | undefined },
): AdapterEmission<FeedStalePayload> {
  const payload: FeedStalePayload = {
    feedId: context.feedId,
    connectionId: context.provenance.connectionId,
    detectedAt: context.receipt.receivedAt,
    ...(input.lastMessageAt === undefined ? {} : { lastMessageAt: input.lastMessageAt }),
    stalenessMs: input.stalenessMs,
  };
  return buildEmission({
    contract: FeedStaleContract,
    sourceChannel: context.sourceChannel,
    receipt: context.receipt,
    provenance: context.provenance,
    payload,
  });
}

/**
 * `DataQualityIncidentOpened` (§7.4, §8.3).
 *
 * The id is derived from the feed, the connection, and a per-feed ordinal rather
 * than from randomness: this package reads no unseeded entropy, so a replayed
 * run produces the same ids as the live one it replays. `connectionId` is caller
 * supplied and unique per connection, which is what makes the derived id unique.
 */
export function dataQualityIncidentOpened(
  context: FeedStatusContext,
  input: {
    readonly incidentId: string;
    readonly reasonCode: string;
    readonly severity: IncidentSeverity;
    readonly detail?: string | undefined;
  },
): AdapterEmission<DataQualityIncidentOpenedPayload> {
  const payload: DataQualityIncidentOpenedPayload = {
    incidentId: input.incidentId,
    openedAt: context.receipt.receivedAt,
    reasonCode: input.reasonCode,
    severity: input.severity,
    ...(input.detail === undefined ? {} : { detail: input.detail }),
    feedId: context.feedId,
  };
  return buildEmission({
    contract: DataQualityIncidentOpenedContract,
    sourceChannel: context.sourceChannel,
    receipt: context.receipt,
    provenance: context.provenance,
    payload,
  });
}
