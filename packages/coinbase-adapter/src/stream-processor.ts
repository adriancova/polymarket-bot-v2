/**
 * The Coinbase stream processor: frames in, domain events out.
 *
 * This class holds every stateful decision the adapter makes — sequence
 * continuity, duplicate suppression, snapshot-based resynchronization, staleness
 * — and it holds NO socket, NO timer, and NO network. Its entire input surface
 * is "here is a frame" and "the connection opened / closed", and its entire
 * output surface is a value. That is what makes the contract suite in
 * `test/contract/coinbase` run offline against documented fixtures, and it is
 * why the reconnect behaviour can be tested without a reconnect.
 *
 * WHAT IT PRODUCES, AND WHAT IT REFUSES TO PRODUCE. It produces normalized
 * reference events with an envelope DRAFT — `source`, `sourceChannel`, the two
 * kinds of timestamp, `connectionId`, `subscriptionGeneration` — and stops
 * there. `eventId`, `gatewayEpoch`, and `ingestSeq` belong to the gateway
 * (ADR-002 §2.1, handoff §9.1); minting them here would be inventing a position
 * in a total order this package cannot see.
 *
 * NOTHING IS EVER DROPPED IN SILENCE. Every frame is accounted for: it is
 * counted, and — unless it was refused before any state could be touched — it
 * advances the sequence and per-channel state that the metrics expose. Every
 * non-conforming or suppressed market-data path additionally yields a typed
 * anomaly carrying the frame. A frame can legitimately produce neither a
 * normalized event nor an anomaly — a heartbeat and a `subscriptions`
 * acknowledgement carry no market data and both are conforming — but no frame
 * ever passes through without being accounted for (§8.3, ADR-002 §2.5).
 *
 * OLD-CONNECTION DATA IS NEVER RELABELLED AS CURRENT. A frame carries the
 * `connectionId` and `subscriptionGeneration` it was received under, which is
 * exactly the provenance ADR-002 §2.4 makes the generation carry. A caller that
 * can tell which socket delivered a frame passes that identity to
 * {@link CoinbaseStreamProcessor.ingestFrame}; a frame from a socket that is no
 * longer current is refused and reported rather than drafted onto the current
 * connection's generation.
 *
 * NO CONFIGURATION, NO ENVIRONMENT, NO CLOCK OF ITS OWN. Every parameter arrives
 * as a constructor argument and every impure capability arrives as a port. This
 * package imports no configuration module and reads no environment variable —
 * which is the work plan's acceptance criterion "Adapter never reads strategy
 * configuration directly", enforced by a test that scans this source tree.
 */

import {
  CodeStringSchema,
  IsoTimestampSchema,
  type DataQualityIncidentOpenedPayload,
  type FeedConnectedPayload,
  type FeedDisconnectedPayload,
  type FeedGapDetectedPayload,
  type FeedResynchronizedPayload,
  type FeedStalePayload,
  type IncidentSeverity,
} from "@polymarket-bot/domain";

import {
  COINBASE_ANOMALY_SEVERITY,
  type CoinbaseAnomaly,
  type CoinbaseAnomalyCode,
} from "./anomalies.js";
import {
  CoinbaseTopOfBookTracker,
  CoinbaseTradeDeduplicator,
  DEFAULT_TRADE_DEDUPE_CAPACITY,
} from "./dedupe.js";
import { CoinbaseConfigurationError } from "./errors.js";
import { classifyFrame, type CoinbaseClassifiedFrame } from "./frames.js";
import { elapsedMs, type CoinbaseChannelStaleness, type CoinbaseFeedMetrics } from "./metrics.js";
import {
  normalizeTopOfBook,
  normalizeTrade,
  noteUnknownEventType,
  type CoinbaseEnvelopeDraft,
  type CoinbaseNormalizationContext,
  type CoinbaseNormalizedEvent,
} from "./normalize.js";
import type { CoinbaseRawFrame, MonotonicClock, WallClock } from "./ports.js";
import { CoinbaseCounterTracker } from "./sequence.js";
import {
  COINBASE_CHANNELS,
  COINBASE_MARKET_DATA_CHANNELS,
  COINBASE_PUBLIC_MARKET_DATA_ENDPOINT,
  type CoinbaseChannel,
} from "./venue-facts.js";
import type { CoinbaseMarketTrade, CoinbaseTicker } from "./wire.js";

/**
 * `sourceChannel` for an event about the connection rather than about a channel.
 *
 * A feed-status event is the adapter's own observation, so attributing it to
 * `ticker` or `market_trades` would misreport where it came from.
 */
export const COINBASE_CONNECTION_CHANNEL = "coinbase.connection" as const;

/** Default staleness bound. */
export const DEFAULT_STALENESS_THRESHOLD_MS = 10_000;

/** A feed-health or data-quality event, with the envelope fields the adapter knows. */
export type CoinbaseFeedEvent =
  | { readonly eventType: "FeedConnected"; readonly envelope: CoinbaseEnvelopeDraft; readonly payload: FeedConnectedPayload }
  | { readonly eventType: "FeedDisconnected"; readonly envelope: CoinbaseEnvelopeDraft; readonly payload: FeedDisconnectedPayload }
  | { readonly eventType: "FeedStale"; readonly envelope: CoinbaseEnvelopeDraft; readonly payload: FeedStalePayload }
  | { readonly eventType: "FeedGapDetected"; readonly envelope: CoinbaseEnvelopeDraft; readonly payload: FeedGapDetectedPayload }
  | { readonly eventType: "FeedResynchronized"; readonly envelope: CoinbaseEnvelopeDraft; readonly payload: FeedResynchronizedPayload }
  | {
      readonly eventType: "DataQualityIncidentOpened";
      readonly envelope: CoinbaseEnvelopeDraft;
      readonly payload: DataQualityIncidentOpenedPayload;
    };

/** Everything one processor call produced. */
export type CoinbaseProcessorOutput = {
  readonly normalized: readonly CoinbaseNormalizedEvent[];
  readonly feedEvents: readonly CoinbaseFeedEvent[];
  readonly anomalies: readonly CoinbaseAnomaly[];
  /**
   * The processor believes a fresh subscription is required.
   *
   * Set when a gap was detected and no authoritative snapshot can arrive without
   * resubscribing (ADR-002 §2.4). The connection manager acts on it; a caller
   * driving the processor directly may ignore it, in which case the gap simply
   * stays open and is visible in {@link CoinbaseFeedMetrics.gapOpen}.
   */
  readonly requiresResubscription: boolean;
};

/** {@link CoinbaseProcessorOutput} plus what the frame turned out to be. */
export type CoinbaseIngestResult = CoinbaseProcessorOutput & {
  readonly classification: CoinbaseClassifiedFrame["kind"];
};

/**
 * Which connection a frame or a callback came from, as the transport owner saw
 * it.
 *
 * Keyed on `connectionId` alone, not on the generation: a `connectionId` is
 * minted once per connection attempt and never reused, while a generation can
 * advance on a live socket (`resubscribed`), so frames that arrive after a
 * resubscription on the same socket are legitimately current.
 *
 * OPTIONAL, AND THAT IS DELIBERATE. A caller driving the processor by hand — a
 * replay, a test — has exactly one connection in view and can omit it; when it
 * is omitted the processor cannot check, and says so by not checking rather than
 * by guessing. The bundled {@link CoinbaseConnectionManager} always supplies it.
 */
export type CoinbaseFrameOrigin = {
  readonly connectionId: string;
};

/** What a socket callback that arrived from a superseded connection was. */
export type CoinbaseStaleCallback = "onOpen" | "onClose" | "onError";

/**
 * Whether a `snapshot` event arrived on a channel, and whether it was applied.
 *
 * `FeedResynchronized.authoritativeSnapshotApplied` is pinned to the literal
 * `true` by the frozen contract (ADR-002 §2.4), so a channel may only be
 * recorded as resynchronized once the venue's snapshot for it was applied in
 * full. "Applied" means every entry either crossed the domain boundary or was
 * knowingly suppressed as state the consumer already holds — a duplicate trade,
 * or a top of book identical to the one already emitted. An entry the adapter
 * REFUSED is not applied, and one refused entry is enough: the snapshot is the
 * venue's statement of current state, and a partial statement does not establish
 * it.
 */
type CoinbaseSnapshotApplication = {
  /** A `snapshot`-typed event for this channel arrived in this frame. */
  seen: boolean;
  /** Every entry inside those snapshot events was applied. */
  fullyApplied: boolean;
};

/** Everything an individual entry's ingestion needs beyond the entry itself. */
type CoinbaseEntryContext = {
  readonly context: CoinbaseNormalizationContext;
  readonly receivedAt: string;
  readonly sequenceNum: number;
  readonly rawFrame: string;
};

/** The documented `events[].type` that states current state (`market-trades-shape`). */
const COINBASE_SNAPSHOT_EVENT_TYPE = "snapshot";

export type CoinbaseStreamProcessorOptions = {
  /** Stable feed identifier, supplied by the caller. Must be a `CodeString`. */
  readonly feedId: string;
  /** Endpoint recorded on `FeedConnected`. Defaults to the public market-data URL. */
  readonly endpoint?: string;
  /**
   * The market-data channels the caller subscribes to.
   *
   * Used for one decision only: a gap is closed when every one of these has
   * delivered a `snapshot` on the current subscription generation. A caller that
   * subscribes to fewer channels than it declares here would never resynchronize.
   */
  readonly channels?: readonly CoinbaseChannel[];
  readonly stalenessThresholdMs?: number;
  readonly tradeDedupeCapacity?: number;
  readonly wallClock: WallClock;
  readonly monotonicClock: MonotonicClock;
};

type ChannelState = {
  framesReceived: number;
  lastMessageAt?: string;
  /**
   * The venue `timestamp` on the last frame, or `undefined` when that frame's
   * timestamp did not validate. Explicitly `| undefined` rather than optional,
   * because clearing it is a meaningful assignment: "the last frame carried no
   * usable venue time".
   */
  lastVenueTimestamp: string | undefined;
  lastFrameNs?: bigint;
};

type MutableCounters = {
  framesReceived: number;
  framesRejected: number;
  framesUnknownChannel: number;
  framesFromStaleConnection: number;
  staleConnectionCallbacks: number;
  tradesNormalized: number;
  tradesDuplicateSuppressed: number;
  topOfBookNormalized: number;
  topOfBookUnchangedSuppressed: number;
  heartbeatsReceived: number;
  sequenceGaps: number;
  sequenceRegressions: number;
  heartbeatGaps: number;
  heartbeatRegressions: number;
  snapshotsNotApplied: number;
  connectionsOpened: number;
  disconnections: number;
  resynchronizations: number;
  anomalies: number;
};

/** Frames in, domain events out. Holds no socket and no timer. */
export class CoinbaseStreamProcessor {
  readonly #feedId: string;
  readonly #endpoint: string;
  readonly #channels: readonly CoinbaseChannel[];
  readonly #stalenessThresholdMs: number;
  readonly #wallClock: WallClock;
  readonly #monotonicClock: MonotonicClock;

  readonly #sequence = new CoinbaseCounterTracker();
  readonly #heartbeat = new CoinbaseCounterTracker();
  readonly #trades: CoinbaseTradeDeduplicator;
  readonly #topOfBook = new CoinbaseTopOfBookTracker();
  readonly #channelState = new Map<string, ChannelState>();
  readonly #anomaliesByCode = new Map<CoinbaseAnomalyCode, number>();
  #snapshotSeen = new Set<string>();

  #connectionId = "";
  #generation = -1;
  #connected = false;
  #gapOpen = false;
  #staleReported = false;
  #incidentOrdinal = 0;
  #lastFrameNs: bigint | undefined;
  #lastFrameAt: string | undefined;
  #referenceNs: bigint;

  readonly #counters: MutableCounters = {
    framesReceived: 0,
    framesRejected: 0,
    framesUnknownChannel: 0,
    framesFromStaleConnection: 0,
    staleConnectionCallbacks: 0,
    tradesNormalized: 0,
    tradesDuplicateSuppressed: 0,
    topOfBookNormalized: 0,
    topOfBookUnchangedSuppressed: 0,
    heartbeatsReceived: 0,
    sequenceGaps: 0,
    sequenceRegressions: 0,
    heartbeatGaps: 0,
    heartbeatRegressions: 0,
    snapshotsNotApplied: 0,
    connectionsOpened: 0,
    disconnections: 0,
    resynchronizations: 0,
    anomalies: 0,
  };

  constructor(options: CoinbaseStreamProcessorOptions) {
    if (!CodeStringSchema.safeParse(options.feedId).success) {
      throw new CoinbaseConfigurationError(
        "feedId must be a domain CodeString (alphanumeric, no whitespace, at most 64 characters)",
        { feedId: options.feedId },
      );
    }
    const endpoint = options.endpoint ?? COINBASE_PUBLIC_MARKET_DATA_ENDPOINT;
    if (endpoint.length === 0 || endpoint.length > 200) {
      throw new CoinbaseConfigurationError("endpoint must be a non-empty string of at most 200 characters", {
        endpoint,
      });
    }
    const threshold = options.stalenessThresholdMs ?? DEFAULT_STALENESS_THRESHOLD_MS;
    if (!Number.isSafeInteger(threshold) || threshold <= 0) {
      throw new CoinbaseConfigurationError(
        "stalenessThresholdMs must be a positive safe integer of milliseconds",
        { stalenessThresholdMs: threshold },
      );
    }
    const channels = options.channels ?? COINBASE_MARKET_DATA_CHANNELS;
    if (channels.length === 0) {
      throw new CoinbaseConfigurationError(
        "at least one market-data channel must be declared, or no gap could ever be closed",
        {},
      );
    }

    this.#feedId = options.feedId;
    this.#endpoint = endpoint;
    this.#channels = [...channels];
    this.#stalenessThresholdMs = threshold;
    this.#wallClock = options.wallClock;
    this.#monotonicClock = options.monotonicClock;
    this.#trades = new CoinbaseTradeDeduplicator(
      options.tradeDedupeCapacity ?? DEFAULT_TRADE_DEDUPE_CAPACITY,
    );
    this.#referenceNs = options.monotonicClock.nowNs();
  }

  /** The current subscription generation, or `-1` before the first connection. */
  get subscriptionGeneration(): number {
    return this.#generation;
  }

  /** True between a detected gap and the snapshot that closes it. */
  get gapOpen(): boolean {
    return this.#gapOpen;
  }

  /**
   * Records that a connection is open and a fresh subscription was sent.
   *
   * Every connection starts a NEW subscription generation (§7.1: "A
   * resubscription creates a new `subscriptionGeneration`"), resets the
   * per-connection sequence baseline, and clears the snapshot expectations.
   *
   * Any connection after the first opens a gap. Nothing in the Coinbase
   * documentation offers replay or backfill (U-CB-2), so the messages that
   * occurred while the socket was down are simply gone, and ADR-002 §2.4
   * requires that fact to be recorded rather than papered over by a silent
   * resumption. The FIRST connection does not open a gap: nothing preceded it,
   * so claiming lost data would be a false report.
   */
  connectionOpened(connectionId: string): CoinbaseProcessorOutput {
    if (connectionId.length === 0 || connectionId.length > 200) {
      throw new CoinbaseConfigurationError(
        "connectionId must be a non-empty string of at most 200 characters",
        { connectionId },
      );
    }
    const isReconnect = this.#counters.connectionsOpened > 0;
    this.#counters.connectionsOpened += 1;
    this.#connectionId = connectionId;
    this.#connected = true;
    this.#staleReported = false;
    this.#lastFrameNs = undefined;
    this.#lastFrameAt = undefined;
    this.#referenceNs = this.#monotonicClock.nowNs();
    this.#sequence.reset();
    this.#heartbeat.reset();
    this.#channelState.clear();
    this.#startGeneration();

    const at = this.#wallClock.nowIso();
    const feedEvents: CoinbaseFeedEvent[] = [
      {
        eventType: "FeedConnected",
        envelope: this.#draft(COINBASE_CONNECTION_CHANNEL, at, undefined),
        payload: {
          feedId: this.#feedId,
          connectionId,
          endpoint: this.#endpoint,
          subscriptionGeneration: this.#generation,
          connectedAt: at,
        },
      },
    ];
    const anomalies: CoinbaseAnomaly[] = [];

    if (isReconnect) {
      this.#gapOpen = true;
      feedEvents.push(this.#gapEvent(at, "COINBASE_RECONNECT_NO_REPLAY", "the connection was replaced; the venue documents no replay or backfill, so messages sent while the socket was down are unrecoverable"));
      anomalies.push(
        this.#anomaly("COINBASE_TRADE_HISTORY_NOT_BACKFILLED", "a reconnect re-establishes current state through the venue's snapshot but does not recover trades that occurred while the socket was down", { receivedAt: at }),
      );
      feedEvents.push(this.#incidentEvent(at, "COINBASE_TRADE_HISTORY_NOT_BACKFILLED", "NOTIFY", "trades that occurred during the disconnection are not recoverable from this feed; the snapshot restores current state only"));
    }

    return {
      normalized: [],
      feedEvents,
      anomalies,
      requiresResubscription: false,
    };
  }

  /**
   * Records that a fresh subscription was sent on the SAME connection.
   *
   * Used after a mid-stream gap: ADR-002 §2.4 requires a new authoritative
   * snapshot before affected markets resume, and the only way to obtain one from
   * this venue is to subscribe again. The generation advances, so every event
   * after it is distinguishable from events before it.
   */
  resubscribed(): CoinbaseProcessorOutput {
    this.#startGeneration();
    return {
      normalized: [],
      feedEvents: [],
      anomalies: [],
      requiresResubscription: false,
    };
  }

  /** Records that the connection closed, for whatever reason. */
  connectionClosed(reason: { readonly reasonCode: string; readonly detail?: string }): CoinbaseProcessorOutput {
    const reasonCode = CodeStringSchema.safeParse(reason.reasonCode).success
      ? reason.reasonCode
      : "COINBASE_CLOSE_REASON_UNREPRESENTABLE";
    this.#connected = false;
    this.#counters.disconnections += 1;
    const at = this.#wallClock.nowIso();
    return {
      normalized: [],
      feedEvents: [
        {
          eventType: "FeedDisconnected",
          envelope: this.#draft(COINBASE_CONNECTION_CHANNEL, at, undefined),
          payload: {
            feedId: this.#feedId,
            ...(this.#connectionId === "" ? {} : { connectionId: this.#connectionId }),
            disconnectedAt: at,
            reasonCode,
            ...(reason.detail === undefined ? {} : { detail: reason.detail.slice(0, 2000) }),
          },
        },
      ],
      anomalies: [],
      requiresResubscription: false,
    };
  }

  /**
   * Ingests one raw frame.
   *
   * Never throws for anything the venue can send; a frame this adapter cannot
   * read becomes anomalies carrying the frame itself.
   *
   * @param from which connection delivered the frame, when the caller knows. A
   * frame from a connection that is no longer current is REFUSED — see
   * {@link CoinbaseFrameOrigin}. Refusing it is the conservative choice: the
   * alternative is to draft it onto the current `connectionId` and
   * `subscriptionGeneration`, which would state that old-generation data was
   * observed on the new subscription, and could let a pre-reconnect snapshot
   * close the very gap the reconnect opened.
   */
  ingestFrame(raw: CoinbaseRawFrame, from?: CoinbaseFrameOrigin): CoinbaseIngestResult {
    const receivedAt = this.#wallClock.nowIso();
    const receivedNs = this.#monotonicClock.nowNs();
    this.#counters.framesReceived += 1;

    const classified = classifyFrame(raw);
    const normalized: CoinbaseNormalizedEvent[] = [];
    const feedEvents: CoinbaseFeedEvent[] = [];
    const anomalies: CoinbaseAnomaly[] = [];

    if (from !== undefined && from.connectionId !== this.#connectionId) {
      this.#counters.framesFromStaleConnection += 1;
      anomalies.push(
        this.#anomaly(
          "COINBASE_STALE_CONNECTION_ACTIVITY",
          `a frame was delivered by connection "${from.connectionId.slice(0, 64)}", which is not the current connection "${this.#connectionId === "" ? "<none>" : this.#connectionId.slice(0, 64)}" at subscription generation ${String(this.#generation)}; it is refused rather than relabelled with the current generation, and its raw bytes are preserved here`,
          {
            receivedAt,
            ...(classified.kind === "REJECTED"
              ? {}
              : { channel: classified.frame.channel, sequenceNum: classified.frame.sequence_num }),
            ...(classified.text === undefined ? {} : { rawFrame: classified.text }),
            ...(classified.kind === "REJECTED" && classified.byteLength !== undefined
              ? { rawFrameByteLength: classified.byteLength }
              : {}),
          },
        ),
      );
      // Deliberately NOT recorded as evidence of liveness: a frame from a dead
      // socket says nothing about whether the current one is alive, and letting
      // it reset the staleness clock would hide exactly the stall the staleness
      // bound exists to catch.
      return this.#finish(classified.kind, normalized, feedEvents, anomalies);
    }

    this.#lastFrameNs = receivedNs;
    this.#lastFrameAt = receivedAt;
    this.#staleReported = false;

    if (classified.kind === "REJECTED") {
      this.#counters.framesRejected += 1;
      anomalies.push(
        this.#anomaly(rejectionCode(classified.rejection), classified.detail, {
          receivedAt,
          ...(classified.text === undefined ? {} : { rawFrame: classified.text }),
          ...(classified.byteLength === undefined ? {} : { rawFrameByteLength: classified.byteLength }),
        }),
      );
      return this.#finish(classified.kind, normalized, feedEvents, anomalies);
    }

    const { channel, timestamp, sequence_num: sequenceNum } = classified.frame;
    // §7.1 types every venue time as an ISO-8601 timestamp and the venue
    // documents this one as RFC 3339 (`envelope-base`). The wire schema requires
    // only a non-empty string, on purpose — rejecting the whole frame would
    // discard market data over a misspelled publication time — so the check
    // happens here, BEFORE the value is recorded as this channel's venue time.
    // An unvalidated string in `lastVenueTimestamp` is a claim the adapter
    // cannot support: the field is typed as the venue's own time, and metrics
    // built on it would be built on something that is not a timestamp.
    const venueTimestamp = IsoTimestampSchema.safeParse(timestamp).success ? timestamp : undefined;
    if (venueTimestamp === undefined) {
      anomalies.push(
        this.#anomaly(
          "COINBASE_TIMESTAMP_INVALID",
          `the ${channel.slice(0, 64)} envelope timestamp "${timestamp.slice(0, 64)}" is not the documented RFC 3339 form; it is NOT recorded as this channel's venue time, and the frame is otherwise processed so its market data is not lost`,
          { receivedAt, channel, sequenceNum, rawFrame: classified.text },
        ),
      );
    }
    this.#recordChannel(channel, receivedAt, venueTimestamp, receivedNs);
    this.#observeSequence(sequenceNum, channel, classified.text, receivedAt, feedEvents, anomalies);

    switch (classified.kind) {
      case "UNKNOWN_CHANNEL":
        this.#counters.framesUnknownChannel += 1;
        anomalies.push(
          this.#anomaly(
            "COINBASE_UNKNOWN_CHANNEL",
            `channel "${channel.slice(0, 64)}" is not one this adapter handles; the frame is reported rather than ignored, because the venue documents that new message types appear at any time`,
            { receivedAt, channel, sequenceNum, rawFrame: classified.text },
          ),
        );
        break;
      case "CONTROL":
        // A `subscriptions` acknowledgement. Its payload shape is UNVERIFIED
        // (U-CB-5), so nothing in it is parsed or relied on; it has already been
        // counted for sequence continuity, which is all it is used for.
        break;
      case "HEARTBEATS":
        this.#counters.heartbeatsReceived += 1;
        this.#ingestHeartbeats(classified, receivedAt, feedEvents, anomalies);
        break;
      case "MARKET_TRADES":
        this.#noteSnapshot(
          COINBASE_CHANNELS.marketTrades,
          this.#ingestTrades(classified, receivedAt, receivedNs, normalized, anomalies),
          { receivedAt, sequenceNum, rawFrame: classified.text },
          anomalies,
        );
        break;
      case "TICKER":
        this.#noteSnapshot(
          COINBASE_CHANNELS.ticker,
          this.#ingestTicker(classified, receivedAt, receivedNs, normalized, anomalies),
          { receivedAt, sequenceNum, rawFrame: classified.text },
          anomalies,
        );
        break;
    }

    this.#maybeResynchronize(receivedAt, feedEvents);
    return this.#finish(classified.kind, normalized, feedEvents, anomalies);
  }

  /**
   * Records a socket callback that arrived from a connection the manager has
   * already replaced.
   *
   * A transport can call back on a socket after that socket has been abandoned —
   * a close that races a reconnect, an error delivered after the replacement
   * opened. Acting on such a callback as though it belonged to the current
   * connection would emit a `FeedDisconnected` for a connection that is still
   * open, or restart a reconnect that is already in flight. Ignoring it silently
   * is not an option either (§8.3), so it becomes a typed anomaly and nothing
   * else: no feed event, no state change.
   */
  staleConnectionActivity(activity: {
    readonly connectionId: string;
    readonly callback: CoinbaseStaleCallback;
    readonly detail?: string;
  }): CoinbaseProcessorOutput {
    const receivedAt = this.#wallClock.nowIso();
    this.#counters.staleConnectionCallbacks += 1;
    const suffix = activity.detail === undefined ? "" : `; ${activity.detail.slice(0, 200)}`;
    return {
      normalized: [],
      feedEvents: [],
      anomalies: [
        this.#anomaly(
          "COINBASE_STALE_CONNECTION_ACTIVITY",
          `${activity.callback} arrived from connection "${activity.connectionId.slice(0, 64)}", which is not the current connection "${this.#connectionId === "" ? "<none>" : this.#connectionId.slice(0, 64)}"; it is recorded and otherwise ignored, because acting on it would describe the current connection with a superseded one's event${suffix}`,
          { receivedAt },
        ),
      ],
      requiresResubscription: this.#gapOpen,
    };
  }

  /**
   * Checks whether the feed has gone quiet, and reports it if so.
   *
   * Called by the connection manager on a timer, or by any caller that wants a
   * staleness decision at a moment of its choosing. Reports at most once per
   * quiet period: a feed that has been stale for an hour is one fact, not one
   * fact per poll.
   *
   * Coinbase closes most channels within 60-90 seconds without updates
   * (`idle-close`) and the heartbeats channel sends every second
   * (`heartbeats`), so on a heartbeat-subscribed connection any quiet period
   * beyond a couple of seconds is already anomalous.
   */
  pollStaleness(): CoinbaseProcessorOutput {
    const nowNs = this.#monotonicClock.nowNs();
    const stalenessMs = elapsedMs(this.#lastFrameNs ?? this.#referenceNs, nowNs);
    if (stalenessMs <= this.#stalenessThresholdMs || this.#staleReported) {
      return { normalized: [], feedEvents: [], anomalies: [], requiresResubscription: false };
    }
    this.#staleReported = true;
    const at = this.#wallClock.nowIso();
    const anomaly = this.#anomaly(
      "COINBASE_FEED_STALE",
      `no frame for ${String(stalenessMs)}ms, beyond the ${String(this.#stalenessThresholdMs)}ms bound`,
      { receivedAt: at },
    );
    return {
      normalized: [],
      feedEvents: [
        {
          eventType: "FeedStale",
          envelope: this.#draft(COINBASE_CONNECTION_CHANNEL, at, undefined),
          payload: {
            feedId: this.#feedId,
            ...(this.#connectionId === "" ? {} : { connectionId: this.#connectionId }),
            detectedAt: at,
            ...(this.#lastFrameAt === undefined ? {} : { lastMessageAt: this.#lastFrameAt }),
            stalenessMs,
          },
        },
      ],
      anomalies: [anomaly],
      requiresResubscription: false,
    };
  }

  /** An immutable snapshot of everything this adapter knows about its health. */
  metrics(): CoinbaseFeedMetrics {
    const nowNs = this.#monotonicClock.nowNs();
    const stalenessMs = elapsedMs(this.#lastFrameNs ?? this.#referenceNs, nowNs);
    const perChannel: CoinbaseChannelStaleness[] = [...this.#channelState.entries()].map(
      ([channel, state]) => ({
        channel,
        ...(state.lastMessageAt === undefined ? {} : { lastMessageAt: state.lastMessageAt }),
        ...(state.lastVenueTimestamp === undefined
          ? {}
          : { lastVenueTimestamp: state.lastVenueTimestamp }),
        stalenessMs: elapsedMs(state.lastFrameNs ?? this.#referenceNs, nowNs),
        framesReceived: state.framesReceived,
      }),
    );
    return {
      feedId: this.#feedId,
      endpoint: this.#endpoint,
      connectionId: this.#connectionId,
      subscriptionGeneration: this.#generation,
      connected: this.#connected,
      gapOpen: this.#gapOpen,
      observedAt: this.#wallClock.nowIso(),
      ...(this.#lastFrameAt === undefined ? {} : { lastMessageAt: this.#lastFrameAt }),
      stalenessMs,
      stalenessThresholdMs: this.#stalenessThresholdMs,
      stale: stalenessMs > this.#stalenessThresholdMs,
      perChannel,
      counters: {
        ...this.#counters,
        subscriptionGenerations: this.#generation + 1,
      },
      anomaliesByCode: Object.fromEntries(this.#anomaliesByCode) as Readonly<
        Partial<Record<CoinbaseAnomalyCode, number>>
      >,
    };
  }

  #startGeneration(): void {
    this.#generation += 1;
    this.#snapshotSeen = new Set<string>();
    this.#topOfBook.newGeneration();
  }

  /**
   * Records that a frame arrived on a channel.
   *
   * `venueTimestamp` is `undefined` when the frame's own timestamp failed
   * validation. It is then cleared rather than left at the previous frame's
   * value: `lastVenueTimestamp` describes the LAST frame on the channel, and
   * carrying an older frame's time forward would answer a question about this
   * frame with an answer about a different one. The receipt time and the frame
   * count still advance, so the frame remains accounted for.
   */
  #recordChannel(
    channel: string,
    receivedAt: string,
    venueTimestamp: string | undefined,
    ns: bigint,
  ): void {
    const state: ChannelState = this.#channelState.get(channel) ?? {
      framesReceived: 0,
      lastVenueTimestamp: undefined,
    };
    state.framesReceived += 1;
    state.lastMessageAt = receivedAt;
    state.lastVenueTimestamp = venueTimestamp;
    state.lastFrameNs = ns;
    this.#channelState.set(channel, state);
  }

  /**
   * Decides whether a channel's snapshot may count towards closing a gap.
   *
   * The whole point of the check: a channel is marked satisfied only after its
   * snapshot has been applied in full. Before this existed, receipt of a
   * `snapshot`-typed event was enough, so a snapshot whose every entry the
   * adapter refused still satisfied its channel and could produce a
   * `FeedResynchronized` carrying `authoritativeSnapshotApplied: true` when no
   * authoritative state had been applied at all.
   */
  #noteSnapshot(
    channel: CoinbaseChannel,
    application: CoinbaseSnapshotApplication,
    where: { readonly receivedAt: string; readonly sequenceNum: number; readonly rawFrame: string },
    anomalies: CoinbaseAnomaly[],
  ): void {
    if (!application.seen) {
      return;
    }
    if (application.fullyApplied) {
      this.#snapshotSeen.add(channel);
      return;
    }
    this.#counters.snapshotsNotApplied += 1;
    anomalies.push(
      this.#anomaly(
        "COINBASE_SNAPSHOT_NOT_APPLIED",
        `the ${channel} snapshot carried at least one entry this adapter had to refuse, so it is not an authoritative statement of current state: ${channel} is NOT recorded as resynchronized on subscription generation ${String(this.#generation)}, and any open gap stays open until a snapshot arrives that applies in full`,
        { receivedAt: where.receivedAt, channel, sequenceNum: where.sequenceNum, rawFrame: where.rawFrame },
      ),
    );
  }

  #observeSequence(
    sequenceNum: number,
    channel: string,
    rawFrame: string,
    receivedAt: string,
    feedEvents: CoinbaseFeedEvent[],
    anomalies: CoinbaseAnomaly[],
  ): void {
    const observation = this.#sequence.observe(sequenceNum);
    if (observation.kind === "GAP") {
      this.#counters.sequenceGaps += 1;
      anomalies.push(
        this.#anomaly(
          "COINBASE_SEQUENCE_GAP",
          `sequence_num jumped from ${String(observation.expected - 1)} to ${String(observation.received)}; the venue documents this as ${String(observation.missing)} dropped message(s)`,
          { receivedAt, channel, sequenceNum, rawFrame },
        ),
      );
      this.#openGap(
        receivedAt,
        "COINBASE_SEQUENCE_GAP",
        `sequence_num skipped ${String(observation.missing)} message(s) on this connection`,
        feedEvents,
      );
    } else if (observation.kind === "REGRESSED") {
      this.#counters.sequenceRegressions += 1;
      anomalies.push(
        this.#anomaly(
          "COINBASE_SEQUENCE_REGRESSED",
          `sequence_num ${String(observation.received)} did not advance past ${String(observation.previous)}; the frame is still processed and duplicate trades are suppressed by identity`,
          { receivedAt, channel, sequenceNum, rawFrame },
        ),
      );
    }
  }

  #ingestHeartbeats(
    classified: Extract<CoinbaseClassifiedFrame, { kind: "HEARTBEATS" }>,
    receivedAt: string,
    feedEvents: CoinbaseFeedEvent[],
    anomalies: CoinbaseAnomaly[],
  ): void {
    for (const event of classified.frame.events) {
      const observation = this.#heartbeat.observe(event.heartbeat_counter);
      const where = {
        receivedAt,
        channel: COINBASE_CHANNELS.heartbeats,
        sequenceNum: classified.frame.sequence_num,
        rawFrame: classified.text,
      };
      // Every arm is decided explicitly. `FIRST` and `IN_ORDER` are the
      // documented once-a-second increment and need no report; the other two do,
      // and a `continue` for "anything that is not a gap" is how a repeated or
      // regressed counter used to pass without one.
      switch (observation.kind) {
        case "FIRST":
        case "IN_ORDER":
          break;
        case "REGRESSED":
          this.#counters.heartbeatRegressions += 1;
          anomalies.push(
            this.#anomaly(
              "COINBASE_HEARTBEAT_REGRESSED",
              `heartbeat_counter ${String(observation.received)} did not advance past ${String(observation.previous)}; the venue documents this counter as increasing once a second, so a repeat or a step backwards is a redelivered or out-of-order heartbeat. Nothing is provably missing, so no gap is claimed, and the baseline is left where it was so a later in-order heartbeat resumes cleanly`,
              where,
            ),
          );
          break;
        case "GAP":
          this.#counters.heartbeatGaps += 1;
          anomalies.push(
            this.#anomaly(
              "COINBASE_HEARTBEAT_GAP",
              `heartbeat_counter jumped from ${String(observation.expected - 1)} to ${String(observation.received)}; the venue publishes this counter precisely so ${String(observation.missing)} missed message(s) are detectable`,
              where,
            ),
          );
          this.#openGap(
            receivedAt,
            "COINBASE_HEARTBEAT_GAP",
            `heartbeat_counter skipped ${String(observation.missing)} heartbeat(s)`,
            feedEvents,
          );
          break;
      }
    }
  }

  #ingestTrades(
    classified: Extract<CoinbaseClassifiedFrame, { kind: "MARKET_TRADES" }>,
    receivedAt: string,
    receivedNs: bigint,
    normalized: CoinbaseNormalizedEvent[],
    anomalies: CoinbaseAnomaly[],
  ): CoinbaseSnapshotApplication {
    const application: CoinbaseSnapshotApplication = { seen: false, fullyApplied: true };
    for (const event of classified.frame.events) {
      const unknownType = noteUnknownEventType(event.type, undefined);
      if (unknownType !== undefined) {
        anomalies.push(
          this.#anomaly(unknownType.code, unknownType.detail, {
            receivedAt,
            channel: COINBASE_CHANNELS.marketTrades,
            sequenceNum: classified.frame.sequence_num,
            rawFrame: classified.text,
          }),
        );
      }
      const isSnapshot = event.type === COINBASE_SNAPSHOT_EVENT_TYPE;
      if (isSnapshot) {
        application.seen = true;
      }

      const where: CoinbaseEntryContext = {
        context: this.#context(classified.frame.timestamp, event.type, classified.frame.sequence_num, receivedAt, receivedNs),
        receivedAt,
        sequenceNum: classified.frame.sequence_num,
        rawFrame: classified.text,
      };
      for (const trade of event.trades) {
        const applied = this.#ingestOneTrade(trade, where, normalized, anomalies);
        if (isSnapshot && !applied) {
          application.fullyApplied = false;
        }
      }
    }
    return application;
  }

  /**
   * Ingests one trade.
   *
   * @returns whether the trade was APPLIED — normalized and emitted, or
   * knowingly suppressed as one this feed already emitted. A trade the adapter
   * refused is not applied.
   */
  #ingestOneTrade(
    trade: CoinbaseMarketTrade,
    where: CoinbaseEntryContext,
    normalized: CoinbaseNormalizedEvent[],
    anomalies: CoinbaseAnomaly[],
  ): boolean {
    if (this.#trades.isKnown(trade.product_id, trade.trade_id)) {
      this.#counters.tradesDuplicateSuppressed += 1;
      anomalies.push(
        this.#anomaly(
          "COINBASE_DUPLICATE_TRADE",
          `trade ${trade.trade_id} on ${trade.product_id} was already normalized on this feed; it is suppressed rather than emitted twice, and counted here`,
          {
            receivedAt: where.receivedAt,
            channel: COINBASE_CHANNELS.marketTrades,
            symbol: trade.product_id,
            sequenceNum: where.sequenceNum,
            rawFrame: where.rawFrame,
          },
        ),
      );
      // Applied: the consumer already holds this trade, so a snapshot that
      // restates it still establishes the state the snapshot describes.
      return true;
    }

    const outcome = normalizeTrade(trade, where.context);
    for (const note of outcome.notes) {
      anomalies.push(
        this.#anomaly(note.code, note.detail, {
          receivedAt: where.receivedAt,
          channel: COINBASE_CHANNELS.marketTrades,
          ...(note.symbol === undefined ? {} : { symbol: note.symbol }),
          sequenceNum: where.sequenceNum,
          rawFrame: where.rawFrame,
        }),
      );
    }
    if (!outcome.ok) {
      anomalies.push(
        this.#anomaly(outcome.code, outcome.detail, {
          receivedAt: where.receivedAt,
          channel: COINBASE_CHANNELS.marketTrades,
          ...(outcome.symbol === undefined ? {} : { symbol: outcome.symbol }),
          sequenceNum: where.sequenceNum,
          rawFrame: where.rawFrame,
        }),
      );
      // The identity is NOT recorded. A refused trade was never emitted, so
      // reserving its identity would make the venue's corrected copy of it look
      // like a duplicate and suppress a trade nobody ever saw.
      return false;
    }
    this.#trades.remember(trade.product_id, trade.trade_id);
    this.#counters.tradesNormalized += 1;
    normalized.push(outcome.value);
    return true;
  }

  #ingestTicker(
    classified: Extract<CoinbaseClassifiedFrame, { kind: "TICKER" }>,
    receivedAt: string,
    receivedNs: bigint,
    normalized: CoinbaseNormalizedEvent[],
    anomalies: CoinbaseAnomaly[],
  ): CoinbaseSnapshotApplication {
    const application: CoinbaseSnapshotApplication = { seen: false, fullyApplied: true };
    for (const event of classified.frame.events) {
      const unknownType = noteUnknownEventType(event.type, undefined);
      if (unknownType !== undefined) {
        anomalies.push(
          this.#anomaly(unknownType.code, unknownType.detail, {
            receivedAt,
            channel: COINBASE_CHANNELS.ticker,
            sequenceNum: classified.frame.sequence_num,
            rawFrame: classified.text,
          }),
        );
      }
      const isSnapshot = event.type === COINBASE_SNAPSHOT_EVENT_TYPE;
      if (isSnapshot) {
        application.seen = true;
      }

      const where: CoinbaseEntryContext = {
        context: this.#context(classified.frame.timestamp, event.type, classified.frame.sequence_num, receivedAt, receivedNs),
        receivedAt,
        sequenceNum: classified.frame.sequence_num,
        rawFrame: classified.text,
      };
      for (const ticker of event.tickers) {
        const applied = this.#ingestOneTicker(ticker, where, normalized, anomalies);
        if (isSnapshot && !applied) {
          application.fullyApplied = false;
        }
      }
    }
    return application;
  }

  /**
   * Ingests one ticker entry.
   *
   * @returns whether the entry was APPLIED — emitted as a change, or knowingly
   * suppressed because it restated the top of book already emitted.
   */
  #ingestOneTicker(
    ticker: CoinbaseTicker,
    where: CoinbaseEntryContext,
    normalized: CoinbaseNormalizedEvent[],
    anomalies: CoinbaseAnomaly[],
  ): boolean {
    const outcome = normalizeTopOfBook(ticker, where.context);
    if (!outcome.ok) {
      anomalies.push(
        this.#anomaly(outcome.code, outcome.detail, {
          receivedAt: where.receivedAt,
          channel: COINBASE_CHANNELS.ticker,
          ...(outcome.symbol === undefined ? {} : { symbol: outcome.symbol }),
          sequenceNum: where.sequenceNum,
          rawFrame: where.rawFrame,
        }),
      );
      return false;
    }
    if (this.#topOfBook.observe(ticker.product_id, outcome.value.payload) === "UNCHANGED") {
      this.#counters.topOfBookUnchangedSuppressed += 1;
      anomalies.push(
        this.#anomaly(
          "COINBASE_TOP_OF_BOOK_UNCHANGED",
          `ticker for ${ticker.product_id} restated the same best bid and ask; no ReferenceTopOfBookChanged is emitted because nothing changed, and the suppression is counted here`,
          {
            receivedAt: where.receivedAt,
            channel: COINBASE_CHANNELS.ticker,
            symbol: ticker.product_id,
            sequenceNum: where.sequenceNum,
          },
        ),
      );
      // Applied: the consumer's top of book for this symbol already equals what
      // the snapshot states.
      return true;
    }
    this.#counters.topOfBookNormalized += 1;
    normalized.push(outcome.value);
    return true;
  }

  #context(
    venueMessageTime: string,
    venueEventType: string,
    sequenceNum: number,
    receivedAt: string,
    receivedNs: bigint,
  ): CoinbaseNormalizationContext {
    return {
      venueMessageTime,
      venueEventType,
      sequenceNum,
      receivedAt,
      receivedMonotonicNs: receivedNs.toString(),
      connectionId: this.#connectionId,
      subscriptionGeneration: this.#generation,
    };
  }

  #openGap(
    at: string,
    reasonCode: string,
    detail: string,
    feedEvents: CoinbaseFeedEvent[],
  ): void {
    this.#gapOpen = true;
    // A gap invalidates the snapshots already applied on this generation: the
    // state they established may have moved during the missing messages.
    this.#snapshotSeen = new Set<string>();
    feedEvents.push(this.#gapEvent(at, reasonCode, detail));
  }

  #gapEvent(at: string, reasonCode: string, detail: string): CoinbaseFeedEvent {
    return {
      eventType: "FeedGapDetected",
      envelope: this.#draft(COINBASE_CONNECTION_CHANNEL, at, undefined),
      payload: {
        feedId: this.#feedId,
        ...(this.#connectionId === "" ? {} : { connectionId: this.#connectionId }),
        detectedAt: at,
        reasonCode,
        detail: detail.slice(0, 2000),
        // Pinned to `true` by the contract, and true in fact: this venue offers
        // no replay, so the only way back to a known state is a fresh snapshot.
        requiresAuthoritativeSnapshot: true,
      },
    };
  }

  #incidentEvent(
    at: string,
    reasonCode: string,
    severity: IncidentSeverity,
    detail: string,
  ): CoinbaseFeedEvent {
    this.#incidentOrdinal += 1;
    return {
      eventType: "DataQualityIncidentOpened",
      envelope: this.#draft(COINBASE_CONNECTION_CHANNEL, at, undefined),
      payload: {
        // Deterministic rather than random: a replayed run must produce the same
        // identifier, so no clock or randomness feeds it (§12.4).
        incidentId: `${this.#feedId}:${this.#connectionId}:${String(this.#incidentOrdinal)}`,
        openedAt: at,
        reasonCode,
        severity,
        detail: detail.slice(0, 2000),
        feedId: this.#feedId,
      },
    };
  }

  /**
   * Closes an open gap once every declared channel has delivered a snapshot
   * that was APPLIED IN FULL on the current generation.
   *
   * `FeedResynchronized.authoritativeSnapshotApplied` is pinned to `true` by the
   * contract precisely so this event cannot assert a recovery that did not
   * happen (ADR-002 §2.4). It is therefore emitted only when the venue's own
   * `snapshot` events have arrived AND every entry in them was applied — never
   * merely because a socket reopened, and never because a snapshot-typed frame
   * was seen. `#noteSnapshot` is what decides "applied"; a snapshot the adapter
   * could not apply reports `COINBASE_SNAPSHOT_NOT_APPLIED` and leaves the gap
   * open for the next one.
   *
   * What it does NOT claim: that missed trades were recovered. They were not,
   * and cannot be (U-CB-2). That fact has its own open incident.
   */
  #maybeResynchronize(at: string, feedEvents: CoinbaseFeedEvent[]): void {
    if (!this.#gapOpen) {
      return;
    }
    if (!this.#channels.every((channel) => this.#snapshotSeen.has(channel))) {
      return;
    }
    this.#gapOpen = false;
    this.#counters.resynchronizations += 1;
    feedEvents.push({
      eventType: "FeedResynchronized",
      envelope: this.#draft(COINBASE_CONNECTION_CHANNEL, at, undefined),
      payload: {
        feedId: this.#feedId,
        ...(this.#connectionId === "" ? {} : { connectionId: this.#connectionId }),
        resynchronizedAt: at,
        subscriptionGeneration: this.#generation,
        authoritativeSnapshotApplied: true,
      },
    });
  }

  #draft(
    sourceChannel: string,
    receivedAt: string,
    venueTimestamp: string | undefined,
  ): CoinbaseEnvelopeDraft {
    return {
      source: "coinbase",
      sourceChannel,
      ...(venueTimestamp === undefined ? {} : { venueTimestamp }),
      receivedAt,
      receivedMonotonicNs: this.#monotonicClock.nowNs().toString(),
      connectionId: this.#connectionId,
      subscriptionGeneration: this.#generation,
    };
  }

  #anomaly(
    code: CoinbaseAnomalyCode,
    detail: string,
    extra: {
      readonly receivedAt: string;
      readonly channel?: string;
      readonly symbol?: string;
      readonly sequenceNum?: number;
      readonly rawFrame?: string;
      readonly rawFrameByteLength?: number;
    },
  ): CoinbaseAnomaly {
    this.#counters.anomalies += 1;
    this.#anomaliesByCode.set(code, (this.#anomaliesByCode.get(code) ?? 0) + 1);
    return {
      code,
      severity: COINBASE_ANOMALY_SEVERITY[code],
      detail: detail.slice(0, 2000),
      connectionId: this.#connectionId,
      subscriptionGeneration: this.#generation,
      ...extra,
    };
  }

  #finish(
    classification: CoinbaseClassifiedFrame["kind"],
    normalized: readonly CoinbaseNormalizedEvent[],
    feedEvents: readonly CoinbaseFeedEvent[],
    anomalies: readonly CoinbaseAnomaly[],
  ): CoinbaseIngestResult {
    return {
      classification,
      normalized,
      feedEvents,
      anomalies,
      requiresResubscription: this.#gapOpen,
    };
  }
}

function rejectionCode(rejection: "NOT_TEXT" | "NOT_JSON" | "SHAPE"): CoinbaseAnomalyCode {
  switch (rejection) {
    case "NOT_TEXT":
      return "COINBASE_FRAME_NOT_TEXT";
    case "NOT_JSON":
      return "COINBASE_FRAME_NOT_JSON";
    case "SHAPE":
      return "COINBASE_FRAME_SHAPE_INVALID";
  }
}
