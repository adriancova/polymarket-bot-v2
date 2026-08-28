/**
 * Feed-health signals.
 *
 * Connection state is DATA, not logging. §8.3 forbids silently dropping a
 * market event, and a feed that reconnected without saying so is the same
 * failure one level up: every consumer would keep trading on a book it stopped
 * receiving updates for. So each transition below becomes a domain event on the
 * same stream as the market data.
 *
 * ## Gaps, and what this adapter can honestly detect
 *
 * The market channel carries no sequence number, and this adapter invents none
 * (§9.4). It therefore cannot detect a *missed message*. What it can detect —
 * and what the invariant actually turns on — is that its view of the book is no
 * longer authoritative:
 *
 * - the connection dropped and was re-established, so anything published in
 *   between was not received;
 * - the subscription was replaced, so the server-side state changed underneath;
 * - no `PONG` arrived within the configured window, so the connection is not
 *   demonstrably alive.
 *
 * Each of those is a gap in exactly the sense §7.1 means: "a restart or
 * detected gap requires a new authoritative snapshot before affected markets
 * resume". `FeedGapDetected.requiresAuthoritativeSnapshot` is pinned to `true`
 * in the contract, so this adapter cannot emit a gap that waives the
 * obligation, and it emits `FeedResynchronized` only when the caller confirms
 * an authoritative snapshot was actually applied — never merely because a
 * socket reopened.
 */

import {
  DataQualityIncidentOpenedContract,
  type DataQualityIncidentOpenedPayload,
  FeedConnectedContract,
  type FeedConnectedPayload,
  FeedDisconnectedContract,
  type FeedDisconnectedPayload,
  FeedGapDetectedContract,
  type FeedGapDetectedPayload,
  FeedResynchronizedContract,
  type FeedResynchronizedPayload,
  FeedStaleContract,
  type FeedStalePayload,
  type IncidentSeverity,
} from "@polymarket-bot/domain";

import type { z } from "zod";

import { MARKET_WEBSOCKET_CHANNEL } from "../config.js";
import { PublicMarketConfigurationError } from "../errors.js";
import { boundDetail, type NormalizedPublicFeedEvent, type PublicMarketProblem } from "../normalize/result.js";

/** Why a feed disconnected. Stable `CodeString` values (§14.3). */
export const FEED_DISCONNECT_REASONS = {
  /** The socket closed, for any reason the transport reported. */
  transportClosed: "TRANSPORT_CLOSED",
  /** The transport raised an error. */
  transportError: "TRANSPORT_ERROR",
  /** The caller stopped the feed deliberately. */
  clientStopped: "CLIENT_STOPPED",
  /** The staleness watchdog closed a connection that stopped answering. */
  staleConnection: "STALE_CONNECTION",
  /**
   * A new connection attempt began while this session was still live.
   *
   * A guard, not a transition the public API can reach today: `start()`
   * connects only from `idle`, and the reconnect timer stands down unless the
   * feed is still `idle` with no session, so nothing displaces a live one. It
   * exists because the alternative — overwriting `#session` — left the replaced
   * connection open, subscribed, and never named by a `FeedDisconnected` again
   * (round-3 finding H1). If either guard is ever weakened, the consumer is
   * told the connection ended instead of the provenance chain simply stopping.
   */
  connectionSuperseded: "CONNECTION_SUPERSEDED",
} as const;

/** Why a gap was declared. */
export const FEED_GAP_REASONS = {
  /** The connection was re-established, so the interval was not received. */
  reconnected: "FEED_RECONNECTED",
  /** The subscription set changed, so server-side state was replaced. */
  subscriptionReplaced: "SUBSCRIPTION_REPLACED",
  /** No heartbeat reply within the configured window. */
  staleConnection: "STALE_CONNECTION",
} as const;

export type FeedDisconnectReason =
  (typeof FEED_DISCONNECT_REASONS)[keyof typeof FEED_DISCONNECT_REASONS];
export type FeedGapReason = (typeof FEED_GAP_REASONS)[keyof typeof FEED_GAP_REASONS];

/**
 * Builds a feed event, validating it against its own domain contract first.
 *
 * The inputs to these builders are caller-supplied (`feedId`, `connectionId`,
 * an incident id) or clock-derived, so nothing here parses untrusted wire data
 * — but "nothing here" is exactly the assumption that stops being true when
 * someone injects a connection-id factory that returns `""`. Publishing an
 * invalid `FeedConnected` would be the same failure the market-event path
 * guards against, so the check is the same.
 *
 * A failure THROWS rather than becoming a problem, because unlike a venue
 * frame this is not data the venue sent: it is a defect in this process's own
 * configuration, and it surfaces synchronously at the composition root that
 * started the feed.
 */
function feedEvent<TType extends NormalizedPublicFeedEvent["eventType"], TPayload>(
  contract: { readonly schemaVersion: number; readonly payloadSchema: z.ZodType },
  eventType: TType,
  payload: TPayload,
  observedIndex: number,
): NormalizedPublicFeedEvent {
  const validated = contract.payloadSchema.safeParse(payload);
  if (!validated.success) {
    throw new PublicMarketConfigurationError(
      `${eventType} payload was rejected by its own domain contract`,
      {
        eventType,
        issues: validated.error.issues.map(
          (issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`,
        ),
      },
    );
  }
  return {
    eventType,
    schemaVersion: contract.schemaVersion,
    payload,
    provenance: {
      source: "polymarket",
      sourceChannel: MARKET_WEBSOCKET_CHANNEL,
      observedIndex,
    },
  } as NormalizedPublicFeedEvent;
}

export interface FeedConnectedInput {
  readonly feedId: string;
  readonly connectionId: string;
  /** Public endpoint identifier. Never carries a credential — none exists here. */
  readonly endpoint: string;
  readonly subscriptionGeneration: number;
  readonly connectedAt: string;
}

export function feedConnected(input: FeedConnectedInput): NormalizedPublicFeedEvent {
  const payload: FeedConnectedPayload = {
    feedId: input.feedId,
    connectionId: input.connectionId,
    endpoint: input.endpoint,
    subscriptionGeneration: input.subscriptionGeneration,
    connectedAt: input.connectedAt,
  };
  return feedEvent(FeedConnectedContract, "FeedConnected", payload, 0);
}

export interface FeedDisconnectedInput {
  readonly feedId: string;
  readonly connectionId?: string;
  readonly disconnectedAt: string;
  readonly reasonCode: FeedDisconnectReason;
  readonly detail?: string;
}

export function feedDisconnected(input: FeedDisconnectedInput): NormalizedPublicFeedEvent {
  const payload: FeedDisconnectedPayload = {
    feedId: input.feedId,
    ...(input.connectionId === undefined ? {} : { connectionId: input.connectionId }),
    disconnectedAt: input.disconnectedAt,
    reasonCode: input.reasonCode,
    ...(input.detail === undefined ? {} : { detail: boundDetail(input.detail) }),
  };
  return feedEvent(FeedDisconnectedContract, "FeedDisconnected", payload, 0);
}

export interface FeedStaleInput {
  readonly feedId: string;
  readonly connectionId?: string;
  readonly detectedAt: string;
  readonly lastMessageAt?: string;
  /** How long the feed has been without a heartbeat reply, in milliseconds. */
  readonly stalenessMs: number;
}

export function feedStale(input: FeedStaleInput): NormalizedPublicFeedEvent {
  const payload: FeedStalePayload = {
    feedId: input.feedId,
    ...(input.connectionId === undefined ? {} : { connectionId: input.connectionId }),
    detectedAt: input.detectedAt,
    ...(input.lastMessageAt === undefined ? {} : { lastMessageAt: input.lastMessageAt }),
    stalenessMs: Math.max(0, Math.round(input.stalenessMs)),
  };
  return feedEvent(FeedStaleContract, "FeedStale", payload, 0);
}

export interface FeedGapDetectedInput {
  readonly feedId: string;
  readonly connectionId?: string;
  readonly detectedAt: string;
  readonly reasonCode: FeedGapReason;
  readonly detail?: string;
}

/**
 * A detected gap.
 *
 * `requiresAuthoritativeSnapshot` is the contract's pinned literal `true`; it
 * is written out here rather than defaulted so a reader of this call site sees
 * that the obligation is unconditional (§6.1 of `docs/contracts/domain.md`).
 */
export function feedGapDetected(input: FeedGapDetectedInput): NormalizedPublicFeedEvent {
  const payload: FeedGapDetectedPayload = {
    feedId: input.feedId,
    ...(input.connectionId === undefined ? {} : { connectionId: input.connectionId }),
    detectedAt: input.detectedAt,
    reasonCode: input.reasonCode,
    ...(input.detail === undefined ? {} : { detail: boundDetail(input.detail) }),
    requiresAuthoritativeSnapshot: true,
  };
  return feedEvent(FeedGapDetectedContract, "FeedGapDetected", payload, 0);
}

export interface FeedResynchronizedInput {
  readonly feedId: string;
  readonly connectionId?: string;
  readonly resynchronizedAt: string;
  readonly subscriptionGeneration: number;
}

/**
 * A completed resynchronization.
 *
 * Only the caller can emit this, and only after it has applied an authoritative
 * snapshot: a feed that reconnected but has not yet applied one is still in the
 * gap state, and is recorded as `FeedConnected` alongside the still-open gap
 * (`docs/contracts/domain.md` §6.1). The pinned
 * `authoritativeSnapshotApplied: true` means this event cannot assert a
 * recovery that did not happen.
 */
export function feedResynchronized(input: FeedResynchronizedInput): NormalizedPublicFeedEvent {
  const payload: FeedResynchronizedPayload = {
    feedId: input.feedId,
    ...(input.connectionId === undefined ? {} : { connectionId: input.connectionId }),
    resynchronizedAt: input.resynchronizedAt,
    subscriptionGeneration: input.subscriptionGeneration,
    authoritativeSnapshotApplied: true,
  };
  return feedEvent(FeedResynchronizedContract, "FeedResynchronized", payload, 0);
}

export interface DataQualityIncidentInput {
  /** Minted by the caller: incident identity outlives any one adapter instance. */
  readonly incidentId: string;
  readonly openedAt: string;
  readonly severity: IncidentSeverity;
  readonly feedId?: string;
}

/**
 * Turns a normalization problem into a `DataQualityIncidentOpened`.
 *
 * ADR-002's Consequences require it: "a mislabeled or malformed frame now fails
 * to parse. The gateway work package must catch the typed failure, emit
 * `DataQualityIncidentOpened`, increment a metric, and preserve the raw frame.
 * A rejected envelope that becomes a silent drop violates §8.3." The problem's
 * own code becomes the incident's `reasonCode`, so the incident aggregates on
 * the same vocabulary the adapter reports.
 *
 * The incident id and the timestamp come from the caller. Minting an id here
 * would need randomness this package deliberately does not have, and an
 * incident's identity belongs to the process that tracks it to closure.
 */
export function dataQualityIncidentFromProblem(
  problem: PublicMarketProblem,
  input: DataQualityIncidentInput,
): NormalizedPublicFeedEvent {
  const payload: DataQualityIncidentOpenedPayload = {
    incidentId: input.incidentId,
    openedAt: input.openedAt,
    reasonCode: problem.code,
    severity: input.severity,
    detail: boundDetail(
      `${problem.sourceChannel}${
        problem.venueEventType === undefined ? "" : ` ${problem.venueEventType}`
      }: ${problem.detail}`,
    ),
    ...(input.feedId === undefined ? {} : { feedId: input.feedId }),
  };
  return feedEvent(
    DataQualityIncidentOpenedContract,
    "DataQualityIncidentOpened",
    payload,
    problem.observedIndex,
  );
}
