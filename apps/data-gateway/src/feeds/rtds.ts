/**
 * RTDS TWAP feed driver: the gateway's ownership of the WP-100 adapter.
 *
 * ## The gap is unrecoverable, so the feed HALTS — really halts
 *
 * `feed.openGap.recoverableFromVenue === false` is a type-level fact: RTDS
 * publishes no replay and Chainlink's own report endpoint needs credentials
 * this platform may not hold. On such a gap this driver:
 *
 * 1. opens a PAGE `DataQualityIncidentOpened` naming `RTDS_UNRECOVERABLE_GAP`;
 * 2. clears the adapter's gap state with `acknowledgeUnobservedInterval` —
 *    THE ACKNOWLEDGEMENT IS NEVER AN AUTHORITATIVE RESYNC (WP-100 review
 *    condition DV1): no `FeedResynchronized` exists on this feed, none is
 *    synthesized here, and the incident stays open in the registry;
 * 3. **TERMINALLY HALTS NORMALIZED PUBLICATION FOR THIS FEED AND EPOCH.**
 *
 * Step 3 was missing in round 1 (review finding H4): the driver said "halt",
 * opened the incident, cleared the gap — and then kept publishing
 * `ReferenceTwapObserved` as if nothing had happened. A downstream TWAP
 * consumer is required to halt (ADR-009 §6), but a consumer that missed the
 * incident and watched only the data stream saw an unbroken series across a
 * permanently unobserved interval. Post-gap observations are now counted and
 * suppressed instead.
 *
 * What KEEPS flowing after the halt, deliberately:
 *
 * - **raw WAL recording**, untouched — the evidence is the point of the
 *   recorder, and the frames are still real venue bytes (§9.1);
 * - **feed-health events and incidents**, so the halt is visible in the very
 *   stream an operator reads to diagnose it.
 *
 * The halt is for the epoch, like the publication halt in `publisher.ts`, and
 * for the same reason: resuming mid-epoch would hand consumers a series whose
 * continuity they cannot check. A restart mints a new epoch and a new
 * first-observation mark, which is the §7.1 path.
 *
 * ## Both interval fields mean "coverage broke here"
 *
 * `quality.unobservedInterval` (measured) and
 * `quality.unobservedIntervalUnavailable` (real but unmeasurable yet) are the
 * same fact at different levels of knowledge (WP-100 round-1 known risk 2 /
 * follow-up 2). EITHER opens a coverage-break incident; the absence of a
 * measured interval is never read as the absence of a gap.
 *
 * ## Freshness fails a 1970 window
 *
 * A seconds-spelled venue timestamp produces a visibly-wrong 1970 window
 * (WP-100 round-1 known risk 1). Freshness is judged on
 * `quality.observationAgeMs` against the configured bound: a stale — or
 * absurdly ancient — observation is still published (it is real venue data,
 * flagged `outOfOrder` by the adapter and recorded raw), but it FAILS
 * freshness, is counted, opens an incident, and does not advance the driver's
 * fresh-data mark.
 *
 * ## Symbol filtering is planned, counted, and never silent
 *
 * A multi-symbol subscription receives every symbol; the venue's own guidance
 * is to filter on `payload.symbol` in the application, and WP-100 assigns the
 * filter to this package. Updates outside the planned set are counted and not
 * published; their raw frames are in the WAL like every other frame.
 */

import type {
  NormalizedRtdsEventAny,
  RtdsProblem,
  RtdsTwapFeed,
} from "@polymarket-bot/polymarket-public/rtds";
import { rtdsDataQualityIncidentFromProblem } from "@polymarket-bot/polymarket-public/rtds";
import type { RawRtdsFrame } from "@polymarket-bot/polymarket-public/rtds";

import type { GatewayDispatcher } from "../dispatcher.js";
import type { GatewayJournal } from "../journal.js";
import type { GatewayClock } from "../ports.js";
import { isoFromMs, takeReceipt } from "../ports.js";

/** RTDS problem codes that are transport observations, not data incidents. */
const TRANSPORT_OBSERVATION_CODES: ReadonlySet<string> = new Set([
  "RTDS_STALE_CONNECTION_FRAME",
  "RTDS_PRE_SUBSCRIPTION_FRAME",
  "RTDS_UNDOCUMENTED_HEARTBEAT_TEXT",
]);

export interface RtdsFeedDriverOptions {
  readonly feedId: string;
  readonly endpoint: string;
  readonly journal: GatewayJournal;
  readonly dispatcher: GatewayDispatcher;
  readonly clock: GatewayClock;
  /** Lowercase symbols the gateway publishes (`btc/usd`). */
  readonly plannedSymbols: ReadonlySet<string>;
  /** Freshness bound on `quality.observationAgeMs`. */
  readonly maxObservationAgeMs: number;
}

export interface RtdsFeedDriverMetrics {
  readonly framesRecorded: number;
  readonly framesRefusedByWal: number;
  readonly observationsDispatched: number;
  readonly unplannedSymbolObservations: number;
  readonly freshnessFailures: number;
  readonly coverageBreaks: number;
  readonly firstObservations: number;
  readonly outOfOrderObservations: number;
  readonly unrecoverableGapsAcknowledged: number;
  readonly gapAcknowledgementRejections: number;
  readonly transportObservations: number;
  readonly problemsRouted: number;
  readonly stallsObserved: number;
  /** True once an unrecoverable gap halted normalized publication (H4). */
  readonly halted: boolean;
  /** Observations recorded raw but NOT published, because the feed is halted. */
  readonly observationsSuppressedAfterGap: number;
}

interface CurrentRawFrame {
  readonly ingestSeq: string;
  readonly recorded: boolean;
}

export class RtdsFeedDriver {
  readonly #options: RtdsFeedDriverOptions;
  #feed: RtdsTwapFeed | undefined;
  #currentRaw: CurrentRawFrame | undefined;

  #framesRecorded = 0;
  #framesRefusedByWal = 0;
  #observationsDispatched = 0;
  #unplannedSymbolObservations = 0;
  #freshnessFailures = 0;
  #coverageBreaks = 0;
  #firstObservations = 0;
  #outOfOrderObservations = 0;
  #gapsAcknowledged = 0;
  #gapAckRejections = 0;
  #transportObservations = 0;
  #problemsRouted = 0;
  #stallsObserved = 0;
  #halted = false;
  #observationsSuppressedAfterGap = 0;

  constructor(options: RtdsFeedDriverOptions) {
    this.#options = options;
  }

  bind(feed: RtdsTwapFeed): void {
    this.#feed = feed;
  }

  /** True once an unrecoverable gap terminally halted normalized publication. */
  get halted(): boolean {
    return this.#halted;
  }

  /** The feed's `onRawFrame` handler: WAL first, always. */
  onRawFrame(frame: RawRtdsFrame): void {
    const receipt = takeReceipt(this.#options.clock);
    const outcome = this.#options.journal.record({
      source: "rtds",
      endpoint: this.#options.endpoint,
      connectionId: frame.connectionId,
      subscriptionGeneration: frame.subscriptionGeneration,
      receipt,
      payloadUtf8: frame.payload,
    });
    if (outcome.recorded) {
      this.#framesRecorded += 1;
      this.#currentRaw = { ingestSeq: outcome.ingestSeq, recorded: true };
      return;
    }
    this.#framesRefusedByWal += 1;
    this.#currentRaw = { ingestSeq: outcome.ingestSeq, recorded: false };
    this.#options.dispatcher.openIncident({
      scope: this.#options.feedId,
      reasonCode: "GATEWAY_WAL_FRAME_REFUSED",
      severity: "PAGE",
      detail: `the WAL refused a raw RTDS frame (${outcome.reason}): ${outcome.detail}; derived observations will not be published`,
      feedId: this.#options.feedId,
    });
  }

  /** The feed's `onEvent` handler. */
  onEvent(event: NormalizedRtdsEventAny): void {
    const receipt = takeReceipt(this.#options.clock);
    if (event.eventType === "ReferenceTwapObserved") {
      const raw = this.#currentRaw;
      if (raw !== undefined && !raw.recorded) {
        // Acceptance 1: unrecorded raw evidence, no publication. The PAGE
        // incident is already open; the suppression is counted there.
        return;
      }
      // Quality judgement runs even while halted: coverage breaks, freshness
      // failures, and the first-observation signals are DIAGNOSTICS, and an
      // operator diagnosing a halted feed needs them more, not less.
      this.#handleObservationQuality(event);
      if (this.#halted) {
        // Review H4: the feed is halted on a permanently unobserved interval.
        // The frame is already in the WAL (replay keeps every byte) and the
        // diagnostics above still fire; what must NOT happen is a normalized
        // TWAP series that looks continuous across a gap no venue can fill.
        this.#observationsSuppressedAfterGap += 1;
        return;
      }
      const symbol = event.payload.symbol.toLowerCase();
      if (!this.#options.plannedSymbols.has(symbol)) {
        // The venue delivers every symbol on a multi-symbol subscription; the
        // plan says which ones this deployment publishes (WP-100 follow-up).
        this.#unplannedSymbolObservations += 1;
        return;
      }
      this.#observationsDispatched += 1;
      void this.#options.dispatcher.dispatch(
        {
          eventType: event.eventType,
          schemaVersion: event.schemaVersion,
          source: event.provenance.source,
          sourceChannel: event.provenance.sourceChannel,
          venueTimestamp: event.provenance.venueTimestamp,
          connectionId: event.provenance.connectionId,
          subscriptionGeneration: event.provenance.subscriptionGeneration,
          payload: event.payload,
        },
        {
          receipt,
          ...(raw !== undefined && raw.recorded ? { rawFrameIngestSeq: raw.ingestSeq } : {}),
        },
      );
      return;
    }

    // Feed-health events pass through as-is.
    void this.#options.dispatcher.dispatch(
      {
        eventType: event.eventType,
        schemaVersion: event.schemaVersion,
        source: event.provenance.source,
        sourceChannel: event.provenance.sourceChannel,
        venueTimestamp: event.provenance.venueTimestamp,
        connectionId: event.provenance.connectionId,
        subscriptionGeneration: event.provenance.subscriptionGeneration,
        payload: event.payload,
      },
      { receipt },
    );

    if (event.eventType === "FeedStale") {
      // A silent stall on a feed whose publication cadence is undocumented
      // (RTDS-U1): the adapter reports staleness against the operator's own
      // threshold, and the gateway escalates it to an incident (§8.3, §9.9).
      this.#stallsObserved += 1;
      this.#options.dispatcher.openIncident({
        scope: this.#options.feedId,
        reasonCode: "GATEWAY_FEED_STALL",
        severity: "NOTIFY",
        detail: `the RTDS feed published no TWAP update past its freshness threshold (${JSON.stringify(event.payload)})`,
        feedId: this.#options.feedId,
      });
    }

    if (event.eventType === "FeedConnected") {
      this.#options.dispatcher.markIncidentClosed(this.#options.feedId, "GATEWAY_FEED_STALL");
    }

    if (event.eventType === "FeedGapDetected") {
      this.#handleUnrecoverableGap();
    }
  }

  /** The feed's `onProblem` handler. */
  onProblem(problem: RtdsProblem): void {
    if (TRANSPORT_OBSERVATION_CODES.has(problem.code)) {
      this.#transportObservations += 1;
      return;
    }
    this.#problemsRouted += 1;
    this.#options.dispatcher.openIncident(
      {
        scope: this.#options.feedId,
        reasonCode: problem.code,
        severity: "NOTIFY",
        detail: problem.detail,
        feedId: this.#options.feedId,
      },
      (incidentId) => {
        const incident = rtdsDataQualityIncidentFromProblem(problem, {
          incidentId,
          openedAt: isoFromMs(this.#options.clock.nowMs()),
          severity: "NOTIFY",
          feedId: this.#options.feedId,
        });
        return {
          eventType: incident.eventType,
          schemaVersion: incident.schemaVersion,
          source: incident.provenance.source,
          sourceChannel: incident.provenance.sourceChannel,
          venueTimestamp: incident.provenance.venueTimestamp,
          connectionId: incident.provenance.connectionId,
          subscriptionGeneration: incident.provenance.subscriptionGeneration,
          payload: incident.payload,
        };
      },
    );
  }

  #handleObservationQuality(
    event: Extract<NormalizedRtdsEventAny, { eventType: "ReferenceTwapObserved" }>,
  ): void {
    const quality = event.quality;
    if (quality.firstObservationEver) {
      // Includes a reappearing evicted series (WP-100 known risk 4): "first"
      // is a statement about this adapter instance, not about the venue.
      this.#firstObservations += 1;
    }
    if (quality.outOfOrder) {
      this.#outOfOrderObservations += 1;
    }
    if (
      quality.unobservedInterval !== undefined ||
      quality.unobservedIntervalUnavailable !== undefined
    ) {
      // EITHER field is a real break in TWAP coverage; the absence of a
      // measured interval is not the absence of a gap (WP-100 follow-up 2).
      this.#coverageBreaks += 1;
      const detail =
        quality.unobservedInterval !== undefined
          ? `unobserved interval ${quality.unobservedInterval.fromAt} → ${quality.unobservedInterval.toAt} (${String(quality.unobservedInterval.durationMs)} ms; ${quality.unobservedInterval.reasonCode})`
          : `unobserved interval since ${quality.unobservedIntervalUnavailable?.fromAt ?? "?"} with no measurable end bound yet (${quality.unobservedIntervalUnavailable?.reasonCode ?? ""})`;
      this.#options.dispatcher.openIncident({
        scope: `${this.#options.feedId}:${event.payload.symbol.toLowerCase()}`,
        reasonCode: "RTDS_TWAP_COVERAGE_BROKEN",
        severity: "PAGE",
        detail: `${event.payload.symbol}: ${detail}; RTDS offers no replay — TWAP-dependent consumers must halt (ADR-009 §6)`,
        feedId: this.#options.feedId,
      });
    } else {
      // Coverage restored for the series: allow the next break to open fresh.
      this.#options.dispatcher.markIncidentClosed(
        `${this.#options.feedId}:${event.payload.symbol.toLowerCase()}`,
        "RTDS_TWAP_COVERAGE_BROKEN",
      );
    }
    if (quality.observationAgeMs > this.#options.maxObservationAgeMs) {
      // Fails a genuinely stale observation AND the visibly-wrong 1970 window
      // a seconds-spelled venue timestamp produces (WP-100 round-1 risk 1).
      this.#freshnessFailures += 1;
      this.#options.dispatcher.openIncident({
        scope: this.#options.feedId,
        reasonCode: "RTDS_OBSERVATION_FRESHNESS_FAILED",
        severity: "NOTIFY",
        detail: `${event.payload.symbol}: observation age ${String(quality.observationAgeMs)} ms exceeds the ${String(this.#options.maxObservationAgeMs)} ms bound (windowEndAt ${event.payload.windowEndAt})`,
        feedId: this.#options.feedId,
      });
    }
  }

  #handleUnrecoverableGap(): void {
    const feed = this.#feed;
    if (feed === undefined) return;
    const gap = feed.openGap;
    if (gap === undefined) return;
    // The type pins `recoverableFromVenue: false`; assert it anyway so a
    // future adapter change cannot silently turn this into a wait-for-snapshot
    // path (WP-120 must NOT wait for a snapshot that will never exist).
    if ((gap.recoverableFromVenue as boolean) !== false) {
      return;
    }
    // TERMINAL, and set BEFORE anything else: the incident's own dispatch and
    // the acknowledgement both run through code that could deliver another
    // observation, and none of them may find the feed still publishing.
    this.#halted = true;
    this.#options.dispatcher.openIncident({
      scope: this.#options.feedId,
      reasonCode: "RTDS_UNRECOVERABLE_GAP",
      severity: "PAGE",
      detail: `TWAP stream gap at generation ${String(gap.subscriptionGeneration)} (${gap.unrecoverableReason}); no venue-side recovery exists — the interval is permanently unobserved, this gateway has HALTED normalized RTDS publication for the rest of this epoch (raw recording continues), and TWAP-dependent consumers must halt (ADR-009 §6). Recovery is a process restart, which mints a new epoch.`,
      feedId: this.#options.feedId,
    });
    // Clears the adapter's gap state. NOT a resynchronization: no
    // FeedResynchronized exists on this feed and none is synthesized —
    // acknowledgement is never an authoritative resync (WP-100 DV1).
    const outcome = feed.acknowledgeUnobservedInterval({
      subscriptionGeneration: gap.subscriptionGeneration,
    });
    if (outcome.status === "accepted") {
      this.#gapsAcknowledged += 1;
    } else {
      this.#gapAckRejections += 1;
    }
  }

  metrics(): RtdsFeedDriverMetrics {
    return {
      framesRecorded: this.#framesRecorded,
      framesRefusedByWal: this.#framesRefusedByWal,
      observationsDispatched: this.#observationsDispatched,
      unplannedSymbolObservations: this.#unplannedSymbolObservations,
      freshnessFailures: this.#freshnessFailures,
      coverageBreaks: this.#coverageBreaks,
      firstObservations: this.#firstObservations,
      outOfOrderObservations: this.#outOfOrderObservations,
      unrecoverableGapsAcknowledged: this.#gapsAcknowledged,
      gapAcknowledgementRejections: this.#gapAckRejections,
      transportObservations: this.#transportObservations,
      problemsRouted: this.#problemsRouted,
      stallsObserved: this.#stallsObserved,
      halted: this.#halted,
      observationsSuppressedAfterGap: this.#observationsSuppressedAfterGap,
    };
  }
}
