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
 * NOTHING IS EVER DROPPED IN SILENCE. Every frame produces either normalized
 * events, or anomalies, or both. The one thing that never happens is a frame
 * going in and nothing coming out (§8.3, ADR-002 §2.5).
 *
 * NO CONFIGURATION, NO ENVIRONMENT, NO CLOCK OF ITS OWN. Every parameter arrives
 * as a constructor argument and every impure capability arrives as a port. This
 * package imports no configuration module and reads no environment variable —
 * which is the work plan's acceptance criterion "Adapter never reads strategy
 * configuration directly", enforced by a test that scans this source tree.
 */

import {
  CodeStringSchema,
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
  lastVenueTimestamp?: string;
  lastFrameNs?: bigint;
};

type MutableCounters = {
  framesReceived: number;
  framesRejected: number;
  framesUnknownChannel: number;
  tradesNormalized: number;
  tradesDuplicateSuppressed: number;
  topOfBookNormalized: number;
  topOfBookUnchangedSuppressed: number;
  heartbeatsReceived: number;
  sequenceGaps: number;
  sequenceRegressions: number;
  heartbeatGaps: number;
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
    tradesNormalized: 0,
    tradesDuplicateSuppressed: 0,
    topOfBookNormalized: 0,
    topOfBookUnchangedSuppressed: 0,
    heartbeatsReceived: 0,
    sequenceGaps: 0,
    sequenceRegressions: 0,
    heartbeatGaps: 0,
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
   */
  ingestFrame(raw: CoinbaseRawFrame): CoinbaseIngestResult {
    const receivedAt = this.#wallClock.nowIso();
    const receivedNs = this.#monotonicClock.nowNs();
    this.#counters.framesReceived += 1;
    this.#lastFrameNs = receivedNs;
    this.#lastFrameAt = receivedAt;
    this.#staleReported = false;

    const classified = classifyFrame(raw);
    const normalized: CoinbaseNormalizedEvent[] = [];
    const feedEvents: CoinbaseFeedEvent[] = [];
    const anomalies: CoinbaseAnomaly[] = [];

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
    this.#recordChannel(channel, receivedAt, timestamp, receivedNs);
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
        this.#ingestTrades(classified, receivedAt, receivedNs, normalized, anomalies);
        break;
      case "TICKER":
        this.#ingestTicker(classified, receivedAt, receivedNs, normalized, anomalies);
        break;
    }

    this.#maybeResynchronize(receivedAt, feedEvents);
    return this.#finish(classified.kind, normalized, feedEvents, anomalies);
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

  #recordChannel(channel: string, receivedAt: string, venueTimestamp: string, ns: bigint): void {
    const state = this.#channelState.get(channel) ?? { framesReceived: 0 };
    state.framesReceived += 1;
    state.lastMessageAt = receivedAt;
    state.lastVenueTimestamp = venueTimestamp;
    state.lastFrameNs = ns;
    this.#channelState.set(channel, state);
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
      if (observation.kind !== "GAP") {
        continue;
      }
      this.#counters.heartbeatGaps += 1;
      anomalies.push(
        this.#anomaly(
          "COINBASE_HEARTBEAT_GAP",
          `heartbeat_counter jumped from ${String(observation.expected - 1)} to ${String(observation.received)}; the venue publishes this counter precisely so ${String(observation.missing)} missed message(s) are detectable`,
          {
            receivedAt,
            channel: COINBASE_CHANNELS.heartbeats,
            sequenceNum: classified.frame.sequence_num,
            rawFrame: classified.text,
          },
        ),
      );
      this.#openGap(
        receivedAt,
        "COINBASE_HEARTBEAT_GAP",
        `heartbeat_counter skipped ${String(observation.missing)} heartbeat(s)`,
        feedEvents,
      );
    }
  }

  #ingestTrades(
    classified: Extract<CoinbaseClassifiedFrame, { kind: "MARKET_TRADES" }>,
    receivedAt: string,
    receivedNs: bigint,
    normalized: CoinbaseNormalizedEvent[],
    anomalies: CoinbaseAnomaly[],
  ): void {
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
      if (event.type === "snapshot") {
        this.#snapshotSeen.add(COINBASE_CHANNELS.marketTrades);
      }

      const context = this.#context(classified.frame.timestamp, event.type, classified.frame.sequence_num, receivedAt, receivedNs);
      for (const trade of event.trades) {
        if (!this.#trades.observe(trade.product_id, trade.trade_id)) {
          this.#counters.tradesDuplicateSuppressed += 1;
          anomalies.push(
            this.#anomaly(
              "COINBASE_DUPLICATE_TRADE",
              `trade ${trade.trade_id} on ${trade.product_id} was already normalized on this feed; it is suppressed rather than emitted twice, and counted here`,
              {
                receivedAt,
                channel: COINBASE_CHANNELS.marketTrades,
                symbol: trade.product_id,
                sequenceNum: classified.frame.sequence_num,
                rawFrame: classified.text,
              },
            ),
          );
          continue;
        }

        const outcome = normalizeTrade(trade, context);
        for (const note of outcome.notes) {
          anomalies.push(
            this.#anomaly(note.code, note.detail, {
              receivedAt,
              channel: COINBASE_CHANNELS.marketTrades,
              ...(note.symbol === undefined ? {} : { symbol: note.symbol }),
              sequenceNum: classified.frame.sequence_num,
              rawFrame: classified.text,
            }),
          );
        }
        if (!outcome.ok) {
          anomalies.push(
            this.#anomaly(outcome.code, outcome.detail, {
              receivedAt,
              channel: COINBASE_CHANNELS.marketTrades,
              ...(outcome.symbol === undefined ? {} : { symbol: outcome.symbol }),
              sequenceNum: classified.frame.sequence_num,
              rawFrame: classified.text,
            }),
          );
          continue;
        }
        this.#counters.tradesNormalized += 1;
        normalized.push(outcome.value);
      }
    }
  }

  #ingestTicker(
    classified: Extract<CoinbaseClassifiedFrame, { kind: "TICKER" }>,
    receivedAt: string,
    receivedNs: bigint,
    normalized: CoinbaseNormalizedEvent[],
    anomalies: CoinbaseAnomaly[],
  ): void {
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
      if (event.type === "snapshot") {
        this.#snapshotSeen.add(COINBASE_CHANNELS.ticker);
      }

      const context = this.#context(classified.frame.timestamp, event.type, classified.frame.sequence_num, receivedAt, receivedNs);
      for (const ticker of event.tickers) {
        const outcome = normalizeTopOfBook(ticker, context);
        if (!outcome.ok) {
          anomalies.push(
            this.#anomaly(outcome.code, outcome.detail, {
              receivedAt,
              channel: COINBASE_CHANNELS.ticker,
              ...(outcome.symbol === undefined ? {} : { symbol: outcome.symbol }),
              sequenceNum: classified.frame.sequence_num,
              rawFrame: classified.text,
            }),
          );
          continue;
        }
        if (this.#topOfBook.observe(ticker.product_id, outcome.value.payload) === "UNCHANGED") {
          this.#counters.topOfBookUnchangedSuppressed += 1;
          anomalies.push(
            this.#anomaly(
              "COINBASE_TOP_OF_BOOK_UNCHANGED",
              `ticker for ${ticker.product_id} restated the same best bid and ask; no ReferenceTopOfBookChanged is emitted because nothing changed, and the suppression is counted here`,
              {
                receivedAt,
                channel: COINBASE_CHANNELS.ticker,
                symbol: ticker.product_id,
                sequenceNum: classified.frame.sequence_num,
              },
            ),
          );
          continue;
        }
        this.#counters.topOfBookNormalized += 1;
        normalized.push(outcome.value);
      }
    }
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
   * Closes an open gap once every declared channel has delivered a snapshot on
   * the current generation.
   *
   * `FeedResynchronized.authoritativeSnapshotApplied` is pinned to `true` by the
   * contract precisely so this event cannot assert a recovery that did not
   * happen (ADR-002 §2.4). It is therefore emitted only when the venue's own
   * `snapshot` events have arrived — never merely because a socket reopened.
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
