/**
 * Feed-health signals for the RTDS TWAP feed.
 *
 * Connection state is DATA, not logging (§8.3), so every transition below
 * becomes a domain event on the same stream as the TWAP observations.
 *
 * The reason-code vocabularies are IMPORTED from the market feed's signals
 * module rather than restated: a gateway that aggregates `FeedDisconnected` by
 * `reasonCode` should see one vocabulary across this repository's feeds, and two
 * hand-maintained copies would drift. Only the builders differ, and they differ
 * for one reason: provenance. A market event's envelope `source` is
 * `polymarket`; a Chainlink-TWAP-through-RTDS event's is `rtds`, which is the
 * §7.1 token `ReferenceTwapObserved.venue` restates and the token
 * `assertEnvelopePayloadProvenance` will compare against.
 *
 * ## What this feed can honestly say about a gap
 *
 * RTDS publishes no sequence number, so a missed message is undetectable. What
 * IS detectable — and what the invariant turns on — is that the subscription was
 * replaced: "Direct clients must reconnect and resubscribe after a disconnect",
 * and "Subscriptions start with the next update. There is no snapshot, history,
 * or replay after a disconnect." Everything published while the socket was down
 * was therefore not received and cannot be retrieved.
 *
 * `FeedGapDetected.requiresAuthoritativeSnapshot` is pinned to `true` in the
 * contract, and for this feed that obligation can never be discharged from the
 * venue: there is no authoritative TWAP snapshot to fetch. That is not a defect
 * in the contract — it is the correct reading of ADR-009 §6, which requires a
 * TWAP-dependent strategy to **halt** on an RTDS gap rather than interpolate or
 * backfill. Accordingly this module has no `feedResynchronized` builder at all:
 * that event pins `authoritativeSnapshotApplied: true`, and this adapter can
 * never truthfully assert it.
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
  FeedStaleContract,
  type FeedStalePayload,
  type IncidentSeverity,
} from "@polymarket-bot/domain";
import type { z } from "zod";

import { PublicMarketConfigurationError } from "../errors.js";
import { boundDetail } from "../normalize/result.js";
import { RTDS_CHANNEL } from "./config.js";
import type { NormalizedRtdsFeedEvent, RtdsProblem } from "./result.js";

export {
  FEED_DISCONNECT_REASONS,
  FEED_GAP_REASONS,
  type FeedDisconnectReason,
  type FeedGapReason,
} from "../feed/signals.js";

/**
 * Builds a feed event, validating it against its own domain contract first.
 *
 * A failure THROWS rather than becoming a problem, because unlike a venue frame
 * this is not data the venue sent: it is a defect in this process's own
 * configuration (an empty injected connection id, say), and it surfaces
 * synchronously at the composition root that started the feed.
 */
function rtdsFeedEvent<TType extends NormalizedRtdsFeedEvent["eventType"], TPayload>(
  contract: { readonly schemaVersion: number; readonly payloadSchema: z.ZodType },
  eventType: TType,
  payload: TPayload,
): NormalizedRtdsFeedEvent {
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
      source: "rtds",
      sourceChannel: RTDS_CHANNEL,
      observedIndex: 0,
    },
  } as NormalizedRtdsFeedEvent;
}

export interface RtdsFeedConnectedInput {
  readonly feedId: string;
  readonly connectionId: string;
  /** Public endpoint identifier. Never carries a credential — none exists here. */
  readonly endpoint: string;
  readonly subscriptionGeneration: number;
  readonly connectedAt: string;
}

export function rtdsFeedConnected(input: RtdsFeedConnectedInput): NormalizedRtdsFeedEvent {
  const payload: FeedConnectedPayload = {
    feedId: input.feedId,
    connectionId: input.connectionId,
    endpoint: input.endpoint,
    subscriptionGeneration: input.subscriptionGeneration,
    connectedAt: input.connectedAt,
  };
  return rtdsFeedEvent(FeedConnectedContract, "FeedConnected", payload);
}

export interface RtdsFeedDisconnectedInput {
  readonly feedId: string;
  readonly connectionId?: string;
  readonly disconnectedAt: string;
  readonly reasonCode: string;
  readonly detail?: string;
}

export function rtdsFeedDisconnected(
  input: RtdsFeedDisconnectedInput,
): NormalizedRtdsFeedEvent {
  const payload: FeedDisconnectedPayload = {
    feedId: input.feedId,
    ...(input.connectionId === undefined ? {} : { connectionId: input.connectionId }),
    disconnectedAt: input.disconnectedAt,
    reasonCode: input.reasonCode,
    ...(input.detail === undefined ? {} : { detail: boundDetail(input.detail) }),
  };
  return rtdsFeedEvent(FeedDisconnectedContract, "FeedDisconnected", payload);
}

export interface RtdsFeedStaleInput {
  readonly feedId: string;
  readonly connectionId?: string;
  readonly detectedAt: string;
  /**
   * When the last TWAP update was received.
   *
   * DATA staleness, not transport staleness: this feed measures how long it has
   * been since an update was published, because RTDS documents no server
   * heartbeat reply to measure the socket against (RTDS-U2). Transport liveness
   * is separately queryable as `metrics().lastFrameAt`.
   */
  readonly lastMessageAt?: string;
  readonly stalenessMs: number;
}

export function rtdsFeedStale(input: RtdsFeedStaleInput): NormalizedRtdsFeedEvent {
  const payload: FeedStalePayload = {
    feedId: input.feedId,
    ...(input.connectionId === undefined ? {} : { connectionId: input.connectionId }),
    detectedAt: input.detectedAt,
    ...(input.lastMessageAt === undefined ? {} : { lastMessageAt: input.lastMessageAt }),
    stalenessMs: Math.max(0, Math.round(input.stalenessMs)),
  };
  return rtdsFeedEvent(FeedStaleContract, "FeedStale", payload);
}

export interface RtdsFeedGapDetectedInput {
  readonly feedId: string;
  readonly connectionId?: string;
  readonly detectedAt: string;
  readonly reasonCode: string;
  readonly detail?: string;
}

/**
 * A detected gap.
 *
 * `requiresAuthoritativeSnapshot` is the contract's pinned literal `true`,
 * written out rather than defaulted so a reader of this call site sees that the
 * obligation is unconditional (`docs/contracts/domain.md` §6.1) — and, for this
 * feed, that it cannot be discharged from the venue at all (see the module
 * header, and ADR-009 §6).
 */
export function rtdsFeedGapDetected(
  input: RtdsFeedGapDetectedInput,
): NormalizedRtdsFeedEvent {
  const payload: FeedGapDetectedPayload = {
    feedId: input.feedId,
    ...(input.connectionId === undefined ? {} : { connectionId: input.connectionId }),
    detectedAt: input.detectedAt,
    reasonCode: input.reasonCode,
    ...(input.detail === undefined ? {} : { detail: boundDetail(input.detail) }),
    requiresAuthoritativeSnapshot: true,
  };
  return rtdsFeedEvent(FeedGapDetectedContract, "FeedGapDetected", payload);
}

export interface RtdsDataQualityIncidentInput {
  /** Minted by the caller: incident identity outlives any one adapter instance. */
  readonly incidentId: string;
  readonly openedAt: string;
  readonly severity: IncidentSeverity;
  readonly feedId?: string;
}

/**
 * Turns an RTDS problem into a `DataQualityIncidentOpened`.
 *
 * ADR-002's Consequences require it: the gateway must "catch the typed failure,
 * emit `DataQualityIncidentOpened`, increment a metric, and preserve the raw
 * frame. A rejected envelope that becomes a silent drop violates §8.3." The
 * problem's own code becomes the incident's `reasonCode`, so incidents aggregate
 * on the same vocabulary the adapter reports.
 */
export function rtdsDataQualityIncidentFromProblem(
  problem: RtdsProblem,
  input: RtdsDataQualityIncidentInput,
): NormalizedRtdsFeedEvent {
  const payload: DataQualityIncidentOpenedPayload = {
    incidentId: input.incidentId,
    openedAt: input.openedAt,
    reasonCode: problem.code,
    severity: input.severity,
    detail: boundDetail(
      `${problem.sourceChannel}${problem.topic === undefined ? "" : ` ${problem.topic}`}: ${problem.detail}`,
    ),
    ...(input.feedId === undefined ? {} : { feedId: input.feedId }),
  };
  return rtdsFeedEvent(
    DataQualityIncidentOpenedContract,
    "DataQualityIncidentOpened",
    payload,
  );
}
