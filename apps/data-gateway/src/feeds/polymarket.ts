/**
 * Polymarket market-feed driver: the gateway's ownership of the WP-070
 * adapter, the gap→snapshot→resync policy included.
 *
 * ## Raw before normalized (acceptance 1)
 *
 * The adapter hands every inbound frame to `onRawFrame` BEFORE parsing it and
 * emits that frame's normalized events synchronously afterwards. This driver
 * records the raw frame to the WAL in `onRawFrame`; every market-data event
 * that follows is dispatched with a `causationId` naming the recorded frame's
 * `(gatewayEpoch, ingestSeq)`. If the WAL REFUSED the frame, the derived
 * market-data events are NOT published — publishing data whose raw evidence
 * was not recorded would break the ordering acceptance 1 exists to protect —
 * and a PAGE incident opens instead (§8.3). Feed-health events are not
 * frame-derived and keep flowing, so the outage is visible in the stream.
 *
 * ## Gap → authoritative snapshot → resync (acceptance 3; WP-070 follow-ups)
 *
 * Recovery keys off `feed.openGap`, never off "a reconnect happened"
 * (`openGap === undefined` after an empty reconnect is normal and needs
 * nothing). On a gap: fetch REST book snapshots for the subscribed tokens at
 * the gap's own generation, publish them, then acknowledge exactly that
 * generation with `markResynchronized`. The rejection branch is handled
 * (WP-070 round-2 known risk 1): `GENERATION_MISMATCH` means a newer gap
 * opened mid-recovery, so recovery re-runs for the gap that is actually open;
 * `NO_OPEN_GAP` means it was already closed. A failed fetch leaves the gap
 * open, opens an incident, and retries after a delay — a gap is never
 * abandoned silently, and `FeedResynchronized` is never published without a
 * snapshot having been fetched and applied, because only this driver calls
 * `markResynchronized` and it does so only after `fetchSnapshots` resolved.
 *
 * ## One socket message is dispatched as one frame (`THROUGHPUT-1c` r6, R6-H1)
 *
 * The trader may read a market-channel frame's events as evidence that the
 * delivery path is whole (ADR-023). So a frame that loses an event in the
 * gateway must say so BEFORE any of its events: the adapter already reports
 * its own normalization problems first (`connection.ts` `#onMessage`, r1
 * X8), and this driver hands the dispatcher each inbound message's
 * market-data events as ONE frame ({@link GatewayDispatcher.dispatchFrame}),
 * which validates every envelope before it submits any and opens
 * `GATEWAY_ENVELOPE_REJECTED` ahead of the frame when one is refused. The
 * frame's bounds come from the socket itself: the adapter handles one
 * message synchronously inside the socket's `onMessage` (raw frame, problems,
 * events, all in that call; the publisher's frame-atomic runs rely on the
 * same fact), so {@link PolymarketFeedDriver.frameBoundedSocketFactory} wraps
 * that callback in a begin/end pair and the events emitted between them are
 * buffered and dispatched together when it returns, or when anything that is
 * not one of the frame's events (a feed-health event, the next raw frame)
 * arrives first, so the stream's order is unchanged. Nothing waits on a
 * timer or a later message. When every envelope is valid, the published
 * stream is byte-identical to dispatching each event as it arrived. REST
 * recovery snapshots carry no session (ADR-023 D2 rule 2), are fetched
 * outside any socket message, and are dispatched one by one, as before.
 *
 * ## Transport observations are not market-data incidents
 *
 * `PRE_SUBSCRIPTION_FRAME` and `STALE_CONNECTION_FRAME` are statements about
 * the socket, not the venue's data (WP-070 round-3 follow-up 1). Both are
 * counted, and their raw frames were already recorded via `onRawFrame`;
 * neither opens an incident. Every OTHER problem is routed to
 * `DataQualityIncidentOpened` through the adapter's own
 * `dataQualityIncidentFromProblem`, with dedup and id minting from the
 * gateway's incident registry.
 */

import type {
  NormalizedPublicEventAny,
  PublicBookSnapshotFetcher,
  PublicMarketFeed,
  PublicMarketProblem,
  PublicWebSocketFactory,
  RawMarketFrame,
} from "@polymarket-bot/polymarket-public";
import { dataQualityIncidentFromProblem } from "@polymarket-bot/polymarket-public";
import type { IncidentSeverity } from "@polymarket-bot/domain";

import type { DispatchContext, FrameDispatchEntry, GatewayDispatcher } from "../dispatcher.js";
import type { EnvelopeDraft } from "../envelope.js";
import type { GatewayJournal } from "../journal.js";
import type { CancelScheduled, GatewayClock, GatewayTimers } from "../ports.js";
import { isoFromMs, takeReceipt } from "../ports.js";
import type { PublishOutcome } from "../publisher.js";

/** Problem codes that are transport observations, not data incidents. */
const TRANSPORT_OBSERVATION_CODES: ReadonlySet<string> = new Set([
  "PRE_SUBSCRIPTION_FRAME",
  "STALE_CONNECTION_FRAME",
]);

/** Problem codes about the catalogue's own scope, routed at LOG severity. */
const LOG_SEVERITY_CODES: ReadonlySet<string> = new Set([
  "UNRESOLVED_MARKET",
  "UNREGISTERED_MARKET",
  "UNKNOWN_EVENT_TYPE",
]);

const MARKET_DATA_EVENT_TYPES: ReadonlySet<string> = new Set([
  "BookSnapshot",
  "BookLevelChanged",
  "BestBidAskChanged",
  "PublicTradeObserved",
  "TradingParametersChanged",
  "MarketDiscovered",
  "MarketResolved",
]);

export interface PolymarketFeedDriverOptions {
  readonly feedId: string;
  readonly endpoint: string;
  readonly journal: GatewayJournal;
  readonly dispatcher: GatewayDispatcher;
  readonly clock: GatewayClock;
  readonly timers: GatewayTimers;
  readonly snapshotFetcher: PublicBookSnapshotFetcher;
  /** Delay before re-attempting a failed snapshot fetch. */
  readonly snapshotRetryDelayMs?: number;
  /**
   * `ROLLOVER-1`: told of every `MarketResolved` this driver dispatches, WITH
   * its publication's outcome, so the series-admission feed can keep a
   * resolved window's resolution as an obligation until it is PUBLISHED, and
   * only then tear the window down (ADR-030 Decision 4.4; `ROLLOVER-1` r3,
   * R3-ASTRA-01: r2 was told at dispatch, so a resolution a publication halt
   * swallowed still retired its window). It only RECORDS the facts: the
   * teardown runs on the admission feed's own cycle, never inside a socket
   * callback.
   */
  readonly onMarketResolved?: (resolution: DispatchedResolution) => void;
}

/** `ROLLOVER-1` r3 (R3-ASTRA-01): one `MarketResolved` this driver dispatched. */
export interface DispatchedResolution {
  /** The normalized `MarketResolved` payload, exactly as dispatched. */
  readonly payload: unknown;
  /** The venue's timestamp on the frame, when it carried one. */
  readonly venueTimestamp: string | undefined;
  /** The gateway's receipt instant of the event. */
  readonly receivedAt: string;
  /** The WAL ingest sequence of the recorded raw frame it derives from. */
  readonly rawFrameIngestSeq: string | undefined;
  /** The publisher's verdict: published, or not (a halt, a refusal). Never rejects. */
  readonly published: Promise<PublishOutcome>;
}

/** A buffered frame's resolution, waiting for its publication promise. */
type PendingResolution = Omit<DispatchedResolution, "published">;

export interface PolymarketFeedDriverMetrics {
  readonly framesRecorded: number;
  readonly framesRefusedByWal: number;
  readonly eventsDispatched: number;
  readonly marketEventsSuppressedUnrecorded: number;
  readonly transportObservations: number;
  readonly problemsRouted: number;
  readonly stallsObserved: number;
  readonly snapshotRecoveries: number;
  readonly snapshotFetchFailures: number;
  readonly resyncRejections: number;
}

interface CurrentRawFrame {
  readonly ingestSeq: string;
  readonly recorded: boolean;
}

export class PolymarketFeedDriver {
  readonly #options: PolymarketFeedDriverOptions;
  readonly #retryDelayMs: number;
  #feed: PublicMarketFeed | undefined;
  #currentRaw: CurrentRawFrame | undefined;
  #recovering = false;
  #retryTimer: CancelScheduled | undefined;
  #stopped = false;
  /**
   * The market-data events of the socket message being handled, not yet
   * dispatched; `undefined` outside a message (r6, R6-H1; module header).
   */
  #frame: FrameDispatchEntry[] | undefined;
  /** `ROLLOVER-1` r3: the buffered frame's `MarketResolved` entries, by their index in it. */
  #frameResolutions = new Map<number, PendingResolution>();
  /** How many socket callbacks are open (more than one only if a socket re-enters). */
  #frameDepth = 0;

  #framesRecorded = 0;
  #framesRefusedByWal = 0;
  #eventsDispatched = 0;
  #suppressedUnrecorded = 0;
  #transportObservations = 0;
  #problemsRouted = 0;
  #stallsObserved = 0;
  #snapshotRecoveries = 0;
  #snapshotFetchFailures = 0;
  #resyncRejections = 0;

  constructor(options: PolymarketFeedDriverOptions) {
    this.#options = options;
    this.#retryDelayMs = options.snapshotRetryDelayMs ?? 5_000;
  }

  /**
   * Binds the driver to its feed. Separate from the constructor because the
   * feed's handlers (this driver) must exist before the feed is constructed.
   */
  bind(feed: PublicMarketFeed): void {
    this.#feed = feed;
  }

  /**
   * The socket factory to hand the adapter: `inner`, with every inbound
   * message's handling bracketed as one frame (module header, "One socket
   * message is dispatched as one frame"). Every other callback passes
   * through untouched. The bracket closes in a `finally`, so a throw from the
   * adapter still dispatches what the frame had emitted, as it always was.
   */
  frameBoundedSocketFactory(inner: PublicWebSocketFactory): PublicWebSocketFactory {
    return (url, handlers) =>
      inner(url, {
        onOpen: () => {
          handlers.onOpen();
        },
        onMessage: (data) => {
          this.#beginFrame();
          try {
            handlers.onMessage(data);
          } finally {
            this.#endFrame();
          }
        },
        onClose: (info) => {
          handlers.onClose(info);
        },
        onError: (error) => {
          handlers.onError(error);
        },
      });
  }

  #beginFrame(): void {
    // A message handled inside another (never seen; a re-entrant socket)
    // first releases the outer one's events, so order is kept.
    this.#flushFrame();
    this.#frameDepth += 1;
    this.#frame = [];
  }

  #endFrame(): void {
    this.#flushFrame();
    this.#frameDepth -= 1;
    // Back inside an outer callback, its later events are still buffered.
    this.#frame = this.#frameDepth > 0 ? [] : undefined;
  }

  /** Dispatches the buffered frame, if any, as ONE frame. */
  #flushFrame(): void {
    const frame = this.#frame;
    if (frame === undefined || frame.length === 0) return;
    const resolutions = this.#frameResolutions;
    this.#frame = [];
    this.#frameResolutions = new Map();
    this.#eventsDispatched += frame.length;
    const outcomes = this.#options.dispatcher.dispatchFrame(frame);
    // `ROLLOVER-1` r3 (R3-ASTRA-01): each resolution with ITS entry's outcome.
    for (const [index, resolution] of resolutions) {
      this.#noteResolved(resolution, outcomes[index]);
    }
  }

  /** The feed's `onRawFrame` handler: WAL first, always. */
  onRawFrame(frame: RawMarketFrame): void {
    // A new raw frame's WAL record draws a sequence, so any earlier frame's
    // buffered events go first, exactly as they did when dispatched at once.
    this.#flushFrame();
    const receipt = takeReceipt(this.#options.clock);
    const outcome = this.#options.journal.record({
      source: "polymarket",
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
      detail: `the WAL refused a raw frame (${outcome.reason}): ${outcome.detail}; derived market data will not be published`,
      feedId: this.#options.feedId,
    });
  }

  /** The feed's `onEvent` handler. */
  onEvent(event: NormalizedPublicEventAny): void {
    const receipt = takeReceipt(this.#options.clock);
    const isMarketData = MARKET_DATA_EVENT_TYPES.has(event.eventType);
    const raw = isMarketData ? this.#currentRaw : undefined;
    if (isMarketData && raw !== undefined && !raw.recorded) {
      // Acceptance 1: the raw frame was refused, so its normalized events do
      // not enter the stream. Counted, and the PAGE incident is already open.
      this.#suppressedUnrecorded += 1;
      return;
    }
    const draft: EnvelopeDraft = {
      eventType: event.eventType,
      schemaVersion: event.schemaVersion,
      source: event.provenance.source,
      sourceChannel: event.provenance.sourceChannel,
      venueTimestamp: event.provenance.venueTimestamp,
      connectionId: event.provenance.connectionId,
      subscriptionGeneration: event.provenance.subscriptionGeneration,
      payload: event.payload,
    };
    const context: DispatchContext = {
      receipt,
      ...(raw !== undefined && raw.recorded ? { rawFrameIngestSeq: raw.ingestSeq } : {}),
    };
    const resolution: PendingResolution | undefined =
      event.eventType === "MarketResolved"
        ? {
            payload: event.payload,
            venueTimestamp: event.provenance.venueTimestamp,
            receivedAt: receipt.receivedAt,
            rawFrameIngestSeq: context.rawFrameIngestSeq,
          }
        : undefined;
    if (isMarketData && this.#frame !== undefined) {
      // One of the socket message's own events: dispatched with its frame.
      if (resolution !== undefined) this.#frameResolutions.set(this.#frame.length, resolution);
      this.#frame.push({ draft, context });
      return;
    }
    // Anything else keeps its place in the stream behind what was buffered.
    this.#flushFrame();
    const outcome = this.#options.dispatcher.dispatch(draft, context);
    this.#eventsDispatched += 1;
    if (resolution !== undefined) this.#noteResolved(resolution, outcome);

    if (event.eventType === "FeedStale") {
      // A silent socket stall: the connection is open and the venue's PONG
      // never arrived. The adapter reports the condition; escalating it to a
      // data-quality incident is the gateway's (§8.3, §9.9 — a stale feed is
      // an operational condition, not a log line).
      this.#stallsObserved += 1;
      this.#options.dispatcher.openIncident({
        scope: this.#options.feedId,
        reasonCode: "GATEWAY_FEED_STALL",
        severity: "NOTIFY",
        detail: `the market feed went silent past its heartbeat tolerance (${JSON.stringify(event.payload)})`,
        feedId: this.#options.feedId,
      });
    }

    if (event.eventType === "FeedConnected") {
      // A new connection ends the previous stall episode, so a later stall
      // opens a fresh incident rather than being deduped against a stale one.
      this.#options.dispatcher.markIncidentClosed(this.#options.feedId, "GATEWAY_FEED_STALL");
    }

    if (event.eventType === "FeedGapDetected") {
      // Recovery keys off the feed's own gap state, never off the event alone.
      this.#scheduleRecovery();
    }
  }

  /**
   * `ROLLOVER-1`: hands a DISPATCHED resolution, with its publication's
   * outcome, to the admission feed (r3, R3-ASTRA-01: never before dispatch).
   */
  #noteResolved(resolution: PendingResolution, published: Promise<PublishOutcome> | undefined): void {
    if (this.#options.onMarketResolved === undefined) return;
    this.#options.onMarketResolved({
      ...resolution,
      published:
        published ??
        Promise.resolve({ published: false, reason: "transport-rejected", detail: "the dispatcher answered no outcome for the resolution" }),
    });
  }

  /** The feed's `onProblem` handler. */
  onProblem(problem: PublicMarketProblem): void {
    if (TRANSPORT_OBSERVATION_CODES.has(problem.code)) {
      this.#transportObservations += 1;
      return;
    }
    this.#routeProblemIncident(problem);
  }

  /** Kicks the recovery loop; safe to call redundantly. */
  #scheduleRecovery(): void {
    if (this.#recovering || this.#stopped) return;
    this.#recovering = true;
    void this.#recover().finally(() => {
      this.#recovering = false;
    });
  }

  async #recover(): Promise<void> {
    const feed = this.#feed;
    if (feed === undefined || this.#stopped) return;
    const gap = feed.openGap;
    if (gap === undefined) {
      // Normal after an empty reconnect (WP-070 round-2 follow-up 1).
      return;
    }
    let snapshots;
    try {
      snapshots = await this.#options.snapshotFetcher.fetchSnapshots([...feed.assets], {
        subscriptionGeneration: gap.subscriptionGeneration,
      });
    } catch (error) {
      this.#snapshotFetchFailures += 1;
      this.#options.dispatcher.openIncident({
        scope: this.#options.feedId,
        reasonCode: "GATEWAY_SNAPSHOT_FETCH_FAILED",
        severity: "NOTIFY",
        detail: `authoritative snapshot fetch failed; the gap stays open and will be retried: ${
          error instanceof Error ? error.message : String(error)
        }`,
        feedId: this.#options.feedId,
      });
      this.#retryTimer = this.#options.timers.setTimeout(() => {
        this.#retryTimer = undefined;
        this.#scheduleRecovery();
      }, this.#retryDelayMs);
      return;
    }

    // Publish the authoritative books, then their normalization problems.
    for (const event of snapshots.events) {
      this.#currentRaw = undefined; // REST-derived; no raw socket frame to cite.
      this.onEvent(event);
    }
    for (const problem of snapshots.problems) {
      this.onProblem(problem);
    }

    const outcome = feed.markResynchronized({
      subscriptionGeneration: gap.subscriptionGeneration,
    });
    if (outcome.status === "accepted") {
      this.#snapshotRecoveries += 1;
      this.#options.dispatcher.markIncidentClosed(
        this.#options.feedId,
        "GATEWAY_SNAPSHOT_FETCH_FAILED",
      );
      return;
    }
    this.#resyncRejections += 1;
    if (outcome.reasonCode === "GENERATION_MISMATCH") {
      // A newer gap opened while this snapshot was in flight: recover the gap
      // that is actually open. The recursion terminates because generations
      // are strictly increasing and each pass fetches for the newest one.
      this.#scheduleRecoveryAgain();
      return;
    }
    // NO_OPEN_GAP: the gap was already closed; nothing is owed.
  }

  #scheduleRecoveryAgain(): void {
    // Direct recursion would re-enter #recover while #recovering is true.
    this.#retryTimer = this.#options.timers.setTimeout(() => {
      this.#retryTimer = undefined;
      this.#scheduleRecovery();
    }, 0);
  }

  #routeProblemIncident(problem: PublicMarketProblem): void {
    this.#problemsRouted += 1;
    const severity: IncidentSeverity = LOG_SEVERITY_CODES.has(problem.code) ? "LOG" : "NOTIFY";
    // WP-070 obligation: the incident payload is built by the adapter's own
    // helper, so the reason vocabulary is the adapter's problem codes — but it
    // still goes through the dispatcher's single funnel, which dedups repeats
    // and notifies the observer.
    this.#options.dispatcher.openIncident(
      {
        scope: this.#options.feedId,
        reasonCode: problem.code,
        severity,
        detail: problem.detail,
        feedId: this.#options.feedId,
      },
      (incidentId) => {
        const incident = dataQualityIncidentFromProblem(problem, {
          incidentId,
          openedAt: isoFromMs(this.#options.clock.nowMs()),
          severity,
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

  stop(): void {
    this.#flushFrame();
    this.#stopped = true;
    this.#retryTimer?.();
    this.#retryTimer = undefined;
  }

  metrics(): PolymarketFeedDriverMetrics {
    return {
      framesRecorded: this.#framesRecorded,
      framesRefusedByWal: this.#framesRefusedByWal,
      eventsDispatched: this.#eventsDispatched,
      marketEventsSuppressedUnrecorded: this.#suppressedUnrecorded,
      transportObservations: this.#transportObservations,
      problemsRouted: this.#problemsRouted,
      stallsObserved: this.#stallsObserved,
      snapshotRecoveries: this.#snapshotRecoveries,
      snapshotFetchFailures: this.#snapshotFetchFailures,
      resyncRejections: this.#resyncRejections,
    };
  }
}
