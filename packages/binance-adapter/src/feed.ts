/**
 * `BinanceReferenceFeed` — the connection and reconnect manager (WP-080).
 *
 * WHAT IT IS. A state machine over (socket events, receipt stamps) that emits
 * normalized domain events and feed-status events, and *returns* what the caller
 * should do next. It owns no socket, no timer, and no clock; see
 * `./connection.ts` for why.
 *
 * SUBSCRIPTION GENERATIONS (§7.1, ADR-002 §2.4). Every successful open
 * increments nothing on the first connection and increments the generation on
 * every subsequent one: "A resubscription creates a new `subscriptionGeneration`;
 * a restart or a detected gap requires a new authoritative snapshot before
 * affected markets resume." The generation rides on every emission, so a
 * consumer can tell frames from different subscriptions apart.
 *
 * RECONNECT IS NEVER A SILENT RESUMPTION. On every open this feed emits
 * `FeedConnected` **and** a `FeedGapDetected` whose
 * `requiresAuthoritativeSnapshot` is the contract's literal `true`, plus a
 * `DataQualityIncidentOpened`. It never emits `FeedResynchronized`, because it
 * cannot apply an authoritative snapshot: the venue documentation defines no
 * replay, resume, or backfill for `<symbol>@trade` or `<symbol>@bookTicker`.
 * ADR-002 §2.4 describes exactly this state — "a feed that reconnected but has
 * not yet applied a snapshot is recorded as `FeedConnected` alongside the
 * still-open gap and data-quality incident".
 *
 * The gap is emitted on the FIRST connection too, with its own reason code. §7.1
 * lists "a restart **or** detected gap" as triggering the snapshot obligation,
 * and a process that has just started has by definition observed nothing before
 * its first frame. Emitting it can only make a consumer wait for a snapshot it
 * was already required to have; omitting it would let a fresh subscription look
 * like a continuous one.
 *
 * NOTHING IS DROPPED SILENTLY (§8.3). Every frame produces a
 * {@link FrameOutcome} carrying the decoded frame, a classification, and any
 * emissions. A duplicate, a stale update, an unknown event type, and a malformed
 * frame are all classifications with counters and (except for duplicates, which
 * are the normal, expected case) a data-quality incident — never an early
 * `return` with nothing recorded.
 *
 * NO CONFIGURATION IS READ (WP-080 acceptance 3). This module reads no
 * environment variable, no file, and no strategy configuration; every knob is a
 * constructor argument supplied by the composition root. There is not even an
 * import of `@polymarket-bot/config`, which the contract test asserts by
 * scanning the package source.
 */

import type { IncidentSeverity } from "@polymarket-bot/domain";

import {
  assertReconnectPolicy,
  nextReconnectDelayMs,
  DEFAULT_RECONNECT_POLICY,
  NO_DIRECTIVE,
  type BinanceSocketEvent,
  type ConnectionDirective,
  type FeedConnectionState,
  type ReconnectPolicy,
} from "./connection.js";
import type { AdapterEmission, EmissionProvenance } from "./emission.js";
import { BinanceConfigurationError, BinanceStateError } from "./errors.js";
import { decodeFrame, rawExcerpt, type DecodedFrame } from "./frames.js";
import {
  BINANCE_REASON_CODES,
  dataQualityIncidentOpened,
  feedConnected,
  feedDisconnected,
  feedGapDetected,
  feedStale,
  type FeedStatusContext,
} from "./incidents.js";
import {
  computeFeedMetrics,
  type BinanceConnectionCounters,
  type BinanceFeedMetrics,
  type BinanceFrameCounters,
} from "./metrics.js";
import {
  ReferenceTopOfBookChangedContract,
  ReferenceTradeObservedContract,
  normalizeBookTicker,
  normalizeTrade,
  TAKER_SIDE_CONVENTIONS,
  type TakerSideConvention,
} from "./normalize.js";
import { buildEmission } from "./emission.js";
import {
  bookTickerIdentity,
  SequenceTracker,
  tradeIdentity,
  type SequenceObservation,
} from "./sequence.js";
import {
  buildCombinedStreamUrl,
  type BinanceStreamSubscription,
  type BuiltStreamUrl,
} from "./streams.js";
import { elapsedMsBetween, venueToReceiptLagMs, type ReceiptStamp } from "./time.js";
import { BINANCE_LIMITS, type BinanceTimeUnit } from "./venue.js";

/**
 * `sourceChannel` for events that describe the CONNECTION rather than one
 * stream.
 *
 * §7.1 requires a non-empty `sourceChannel` on every envelope, and a feed-status
 * event belongs to the socket, not to `btcusdt@trade`. A single documented
 * constant is better than picking one subscribed stream arbitrarily and better
 * than joining them all into a string that would exceed the field's bound.
 */
export const BINANCE_CONNECTION_CHANNEL = "binance:stream-connection" as const;

/** Maximum accepted length of a caller-supplied connection id. */
const MAX_CONNECTION_ID_LENGTH = 100;

/** How one received frame was handled. */
export type FrameClassification =
  /** Normalized into a domain reference event. */
  | "NORMALIZED"
  /** The venue repeated an id with identical content; not re-emitted. */
  | "DUPLICATE_SUPPRESSED"
  /** A top-of-book update older than one already applied; not emitted. */
  | "STALE_SUPPRESSED"
  /** The venue repeated an id with different content; not emitted, incident opened. */
  | "CONFLICTING_DUPLICATE"
  /** An economic value could not cross the domain boundary. */
  | "UNREPRESENTABLE"
  /** A documented control response or control error. */
  | "CONTROL"
  /** The documented `serverShutdown` lifecycle notice. */
  | "SERVER_SHUTDOWN"
  /** Parsed, but matched no documented in-scope shape (ADR-002 §7). */
  | "UNKNOWN"
  /** Not JSON, or did not satisfy a documented payload shape. */
  | "MALFORMED";

/** Result of a lifecycle transition. */
export type FeedOutcome = {
  readonly emissions: readonly AdapterEmission[];
  readonly directive: ConnectionDirective;
};

/** Result of handling one received frame. */
export type FrameOutcome = FeedOutcome & {
  readonly decoded: DecodedFrame;
  readonly classification: FrameClassification;
  /** Sequence classification, when the frame carried a venue id. */
  readonly sequence: SequenceObservation | undefined;
  /**
   * A venue instruction this package will not act on by itself.
   *
   * `ESTABLISH_NEW_CONNECTION` is the documented response to `serverShutdown`:
   * "Please establish a new connection as soon as possible to prevent
   * interruption." Acting on it means running two sockets at once, which is a
   * gateway-level decision, so it is surfaced rather than performed.
   */
  readonly advisory: "ESTABLISH_NEW_CONNECTION" | undefined;
};

/** Constructor options. Everything is explicit; nothing is read from anywhere. */
export type BinanceReferenceFeedOptions = {
  /** Stable feed identifier; must satisfy the domain's `CodeStringSchema`. */
  readonly feedId: string;
  readonly subscriptions: readonly BinanceStreamSubscription[];
  /**
   * Milliseconds of silence after which the feed reports `FeedStale`.
   *
   * REQUIRED, with no default. Binance documents no maximum interval between two
   * market-data messages — a quiet symbol is legitimately quiet — so any default
   * this package chose would be an invented venue fact dressed up as a constant.
   * The caller states its own tolerance and owns it.
   */
  readonly stalenessThresholdMs: number;
  readonly endpoint?: string;
  /** Nothing in a frame states its unit; the connection does. */
  readonly timeUnit?: BinanceTimeUnit;
  readonly reconnect?: ReconnectPolicy;
  /** Defaults to `OMIT`; see {@link TakerSideConvention} and `BNC-U5`. */
  readonly takerSideConvention?: TakerSideConvention;
  /** Bound on per-stream sequence state; see `SequenceTracker`. */
  readonly maxTrackedStreams?: number;
};

type MutableFrameCounters = { -readonly [K in keyof BinanceFrameCounters]: number };
type MutableConnectionCounters = { -readonly [K in keyof BinanceConnectionCounters]: number };

export class BinanceReferenceFeed {
  readonly #feedId: string;
  readonly #built: BuiltStreamUrl;
  readonly #stalenessThresholdMs: number;
  readonly #reconnect: ReconnectPolicy;
  readonly #takerSideConvention: TakerSideConvention;
  readonly #sequences: SequenceTracker;

  #state: FeedConnectionState = "IDLE";
  #connectionId: string | undefined;
  #subscriptionGeneration = 0;
  #openedGenerations = 0;
  #reconnectAttempt = 0;
  #connectedAt: ReceiptStamp | undefined;
  #lastFrameAt: ReceiptStamp | undefined;
  #lastVenueTimestamp: string | undefined;
  #lastVenueToReceiptLagMs: number | undefined;
  #maxVenueToReceiptLagMs: number | undefined;
  #staleReported = false;
  #incidentOrdinal = 0;
  readonly #openIncidents = new Set<string>();

  readonly #frames: MutableFrameCounters = {
    framesReceived: 0,
    eventsEmitted: 0,
    tradesNormalized: 0,
    topOfBookNormalized: 0,
    partialTopOfBook: 0,
    duplicatesSuppressed: 0,
    lateTradesEmitted: 0,
    staleUpdatesSuppressed: 0,
    conflictingDuplicates: 0,
    unrepresentableValues: 0,
    unknownFrames: 0,
    malformedFrames: 0,
    framesWithUnknownFields: 0,
    controlResponses: 0,
    controlErrors: 0,
    serverShutdownNotices: 0,
  };

  readonly #connections: MutableConnectionCounters = {
    connectionAttempts: 0,
    connectionsOpened: 0,
    disconnects: 0,
    socketErrors: 0,
    staleEpisodes: 0,
    incidentsOpened: 0,
  };

  public constructor(options: BinanceReferenceFeedOptions) {
    if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/u.test(options.feedId)) {
      throw new BinanceConfigurationError(
        "feedId must satisfy the domain CodeString grammar (^[A-Za-z][A-Za-z0-9_.:-]*$, at most 64 characters)",
        { feedId: options.feedId },
      );
    }
    if (
      !Number.isSafeInteger(options.stalenessThresholdMs) ||
      options.stalenessThresholdMs <= 0
    ) {
      throw new BinanceConfigurationError(
        `stalenessThresholdMs must be a positive safe integer, received ${String(options.stalenessThresholdMs)}`,
      );
    }
    const convention = options.takerSideConvention ?? "OMIT";
    const conventions: readonly string[] = TAKER_SIDE_CONVENTIONS;
    if (!conventions.includes(convention)) {
      throw new BinanceConfigurationError(
        `takerSideConvention must be one of ${TAKER_SIDE_CONVENTIONS.join(", ")}`,
        { takerSideConvention: convention },
      );
    }
    const reconnect = options.reconnect ?? DEFAULT_RECONNECT_POLICY;
    assertReconnectPolicy(reconnect);

    this.#feedId = options.feedId;
    this.#built = buildCombinedStreamUrl({
      ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
      subscriptions: options.subscriptions,
      ...(options.timeUnit === undefined ? {} : { timeUnit: options.timeUnit }),
    });
    this.#stalenessThresholdMs = options.stalenessThresholdMs;
    this.#reconnect = reconnect;
    this.#takerSideConvention = convention;
    this.#sequences = new SequenceTracker(options.maxTrackedStreams);
  }

  /** The connection URL, including the documented `?streams=` query. */
  public get url(): string {
    return this.#built.url;
  }

  /** The query-free endpoint identifier recorded on `FeedConnected`. */
  public get endpointIdentifier(): string {
    return this.#built.endpointIdentifier;
  }

  public get state(): FeedConnectionState {
    return this.#state;
  }

  public get subscriptionGeneration(): number {
    return this.#subscriptionGeneration;
  }

  public get feedId(): string {
    return this.#feedId;
  }

  /** The resolved stream names, in the order they appear in the URL. */
  public get streamNames(): readonly string[] {
    return this.#built.subscriptions.map((subscription) => subscription.streamName);
  }

  /**
   * Records that the caller is about to open a connection.
   *
   * Returns the URL to open, so the caller never has to assemble one itself and
   * cannot accidentally connect to a different endpoint than the one recorded on
   * `FeedConnected`.
   */
  public connecting(): { readonly url: string; readonly attempt: number } {
    if (this.#state === "CLOSED") {
      throw new BinanceStateError("a closed feed cannot open a new connection", {
        feedId: this.#feedId,
      });
    }
    this.#state = "CONNECTING";
    this.#connections.connectionAttempts += 1;
    return { url: this.#built.url, attempt: this.#connections.connectionAttempts };
  }

  /** The single entry point a transport driver uses. */
  public handleSocketEvent(event: BinanceSocketEvent, receipt: ReceiptStamp): FrameOutcome | FeedOutcome {
    switch (event.type) {
      case "OPEN":
        return this.onOpen(event.connectionId, receipt);
      case "MESSAGE":
        return this.onFrame(event.data, receipt);
      case "ERROR":
        return this.onSocketError(receipt, {
          ...(event.reasonCode === undefined ? {} : { reasonCode: event.reasonCode }),
          ...(event.detail === undefined ? {} : { detail: event.detail }),
        });
      case "CLOSE":
        return this.onClose(receipt, {
          ...(event.code === undefined ? {} : { code: event.code }),
          ...(event.reason === undefined ? {} : { reason: event.reason }),
        });
    }
  }

  /**
   * The socket opened.
   *
   * `connectionId` is supplied by the caller because this package reads no
   * unseeded randomness: a UUID generated here would make a replay diverge from
   * the run it replays (§12.4).
   */
  public onOpen(connectionId: string, receipt: ReceiptStamp): FeedOutcome {
    if (this.#state === "CLOSED") {
      throw new BinanceStateError("a closed feed cannot report a new connection", {
        feedId: this.#feedId,
      });
    }
    if (connectionId.length === 0 || connectionId.length > MAX_CONNECTION_ID_LENGTH) {
      throw new BinanceConfigurationError(
        `connectionId must be 1..${String(MAX_CONNECTION_ID_LENGTH)} characters`,
        { length: connectionId.length },
      );
    }

    // §7.1: a resubscription creates a NEW generation. The first connection is
    // generation 0, so the counter advances only from the second open onward.
    if (this.#openedGenerations > 0) {
      this.#subscriptionGeneration += 1;
    }
    this.#openedGenerations += 1;
    this.#connections.connectionsOpened += 1;
    this.#reconnectAttempt = 0;
    this.#state = "OPEN";
    this.#connectionId = connectionId;
    this.#connectedAt = receipt;
    this.#lastFrameAt = undefined;
    this.#staleReported = false;
    // A new connection is a new context for incident suppression: a condition
    // still true on the new socket deserves its own incident.
    this.#openIncidents.clear();

    const context = this.#contextFor(receipt, BINANCE_CONNECTION_CHANNEL);
    const isReconnect = this.#openedGenerations > 1;
    const reasonCode = isReconnect
      ? BINANCE_REASON_CODES.reconnect
      : BINANCE_REASON_CODES.subscriptionStart;
    const detail = isReconnect
      ? "resubscribed after a disconnect; the Binance stream documentation defines no replay, resume, or backfill for <symbol>@trade or <symbol>@bookTicker, so updates between the two connections were not observed"
      : "first subscription of this process; the stream begins with the next update and no history is available";

    const emissions: AdapterEmission[] = [
      feedConnected(context, this.#built.endpointIdentifier),
      feedGapDetected(context, { reasonCode, detail }),
    ];
    const incident = this.#openIncident(context, {
      reasonCode,
      severity: "NOTIFY",
      detail,
    });
    if (incident !== undefined) {
      emissions.push(incident);
    }
    return { emissions, directive: NO_DIRECTIVE };
  }

  /** The transport reported an error on the socket. */
  public onSocketError(
    receipt: ReceiptStamp,
    input: { readonly reasonCode?: string; readonly detail?: string } = {},
  ): FeedOutcome {
    this.#connections.socketErrors += 1;
    const context = this.#contextFor(receipt, BINANCE_CONNECTION_CHANNEL);
    const incident = this.#openIncident(context, {
      reasonCode: input.reasonCode ?? BINANCE_REASON_CODES.socketError,
      severity: "NOTIFY",
      ...(input.detail === undefined ? {} : { detail: input.detail }),
    });
    return {
      emissions: incident === undefined ? [] : [incident],
      directive: NO_DIRECTIVE,
    };
  }

  /**
   * The socket closed.
   *
   * Emits `FeedDisconnected` and directs a reconnect. A close is never treated
   * as an end of data unless the caller asked for one with {@link close}.
   */
  public onClose(
    receipt: ReceiptStamp,
    input: { readonly code?: number; readonly reason?: string } = {},
  ): FeedOutcome {
    if (this.#state === "CLOSED") {
      return { emissions: [], directive: { kind: "STOP", reason: "CLOSED_BY_CALLER" } };
    }
    this.#connections.disconnects += 1;
    const context = this.#contextFor(receipt, BINANCE_CONNECTION_CHANNEL);
    const detailParts: string[] = [];
    if (input.code !== undefined) {
      detailParts.push(`close code ${String(input.code)}`);
    }
    if (input.reason !== undefined && input.reason.length > 0) {
      detailParts.push(input.reason);
    }
    const emissions: AdapterEmission[] = [
      feedDisconnected(context, {
        reasonCode: BINANCE_REASON_CODES.socketClosed,
        ...(detailParts.length === 0 ? {} : { detail: detailParts.join("; ") }),
      }),
    ];

    this.#state = "IDLE";
    this.#connectedAt = undefined;

    this.#reconnectAttempt += 1;
    const maxAttempts = this.#reconnect.maxAttempts;
    if (maxAttempts !== undefined && this.#reconnectAttempt > maxAttempts) {
      return {
        emissions,
        directive: { kind: "STOP", reason: "RECONNECT_ATTEMPTS_EXHAUSTED" },
      };
    }
    return {
      emissions,
      directive: {
        kind: "RECONNECT_AFTER",
        delayMs: nextReconnectDelayMs(this.#reconnectAttempt, this.#reconnect),
        attempt: this.#reconnectAttempt,
      },
    };
  }

  /** The caller is shutting the feed down deliberately. */
  public close(receipt: ReceiptStamp, detail?: string): FeedOutcome {
    if (this.#state === "CLOSED") {
      return { emissions: [], directive: { kind: "STOP", reason: "CLOSED_BY_CALLER" } };
    }
    const wasConnected = this.#state === "OPEN";
    const context = this.#contextFor(receipt, BINANCE_CONNECTION_CHANNEL);
    this.#state = "CLOSED";
    this.#connectedAt = undefined;
    const emissions: AdapterEmission[] = wasConnected
      ? [
          feedDisconnected(context, {
            reasonCode: BINANCE_REASON_CODES.clientShutdown,
            ...(detail === undefined ? {} : { detail }),
          }),
        ]
      : [];
    return { emissions, directive: { kind: "STOP", reason: "CLOSED_BY_CALLER" } };
  }

  /**
   * Reports `FeedStale` when the socket has been silent past the caller's
   * threshold.
   *
   * Driven by the caller, on the caller's cadence, with the caller's stamp — the
   * feed owns no timer. Emitted at most once per silence episode and re-armed by
   * the next frame, so a long outage produces one event rather than one per poll;
   * `staleEpisodes` counts the episodes.
   */
  public checkStaleness(receipt: ReceiptStamp): FeedOutcome {
    if (this.#state !== "OPEN") {
      return { emissions: [], directive: NO_DIRECTIVE };
    }
    const baseline = this.#lastFrameAt ?? this.#connectedAt;
    if (baseline === undefined) {
      return { emissions: [], directive: NO_DIRECTIVE };
    }
    const stalenessMs = elapsedMsBetween(baseline, receipt);
    if (stalenessMs < this.#stalenessThresholdMs || this.#staleReported) {
      return { emissions: [], directive: NO_DIRECTIVE };
    }
    this.#staleReported = true;
    this.#connections.staleEpisodes += 1;
    const context = this.#contextFor(receipt, BINANCE_CONNECTION_CHANNEL);
    return {
      emissions: [
        feedStale(context, {
          stalenessMs,
          ...(this.#lastFrameAt === undefined
            ? {}
            : { lastMessageAt: this.#lastFrameAt.receivedAt }),
        }),
      ],
      directive: NO_DIRECTIVE,
    };
  }

  /** Handles one received frame. Total: every input produces an outcome. */
  public onFrame(raw: string, receipt: ReceiptStamp): FrameOutcome {
    if (this.#state !== "OPEN") {
      throw new BinanceStateError(
        `a frame arrived while the feed was ${this.#state}; a transport must deliver messages only between OPEN and CLOSE`,
        { feedId: this.#feedId, state: this.#state },
      );
    }

    // Any frame proves the socket is alive, so staleness is re-armed even for a
    // control response or a frame this package cannot use.
    this.#frames.framesReceived += 1;
    this.#lastFrameAt = receipt;
    this.#staleReported = false;

    const decoded = decodeFrame(raw);
    const channel = decoded.streamName ?? BINANCE_CONNECTION_CHANNEL;
    const context = this.#contextFor(receipt, channel);
    const emissions: AdapterEmission[] = [];

    if (decoded.unknownFields.length > 0) {
      this.#frames.framesWithUnknownFields += 1;
      this.#pushIncident(emissions, context, {
        reasonCode: BINANCE_REASON_CODES.frameUnknownFields,
        severity: "LOG",
        detail: `frame carried fields this package does not model: ${decoded.unknownFields.slice(0, 20).join(", ")}; the venue may have extended the payload`,
      });
    }

    switch (decoded.kind) {
      case "TRADE":
        return this.#handleTrade(decoded, receipt, context, emissions);
      case "BOOK_TICKER":
        return this.#handleBookTicker(decoded, receipt, context, emissions);
      case "SERVER_SHUTDOWN": {
        this.#frames.serverShutdownNotices += 1;
        this.#pushIncident(emissions, context, {
          reasonCode: BINANCE_REASON_CODES.serverShutdownNotice,
          severity: "NOTIFY",
          detail:
            "the venue announced a server shutdown; its documentation instructs establishing a new connection as soon as possible",
        });
        return {
          emissions,
          directive: NO_DIRECTIVE,
          decoded,
          classification: "SERVER_SHUTDOWN",
          sequence: undefined,
          advisory: "ESTABLISH_NEW_CONNECTION",
        };
      }
      case "CONTROL_RESPONSE": {
        this.#frames.controlResponses += 1;
        return {
          emissions,
          directive: NO_DIRECTIVE,
          decoded,
          classification: "CONTROL",
          sequence: undefined,
          advisory: undefined,
        };
      }
      case "CONTROL_ERROR": {
        this.#frames.controlErrors += 1;
        this.#pushIncident(emissions, context, {
          reasonCode: BINANCE_REASON_CODES.controlError,
          severity: "NOTIFY",
          detail: `venue control error ${String(decoded.venueCode)}: ${decoded.message}`,
        });
        return {
          emissions,
          directive: NO_DIRECTIVE,
          decoded,
          classification: "CONTROL",
          sequence: undefined,
          advisory: undefined,
        };
      }
      case "UNKNOWN": {
        this.#frames.unknownFrames += 1;
        this.#pushIncident(emissions, context, {
          reasonCode: BINANCE_REASON_CODES.frameUnknown,
          severity: "NOTIFY",
          detail: `${decoded.detail} — raw: ${rawExcerpt(decoded.raw)}`,
        });
        return {
          emissions,
          directive: NO_DIRECTIVE,
          decoded,
          classification: "UNKNOWN",
          sequence: undefined,
          advisory: undefined,
        };
      }
      case "MALFORMED": {
        this.#frames.malformedFrames += 1;
        this.#pushIncident(emissions, context, {
          reasonCode: BINANCE_REASON_CODES.frameMalformed,
          severity: "NOTIFY",
          detail: `${decoded.reason}: ${decoded.detail} — raw: ${rawExcerpt(decoded.raw)}`,
        });
        return {
          emissions,
          directive: NO_DIRECTIVE,
          decoded,
          classification: "MALFORMED",
          sequence: undefined,
          advisory: undefined,
        };
      }
    }
  }

  /** The queryable metric surface, computed against the caller's stamp. */
  public metrics(now: ReceiptStamp): BinanceFeedMetrics {
    const baseline = this.#lastFrameAt ?? this.#connectedAt;
    return computeFeedMetrics({
      feedId: this.#feedId,
      endpoint: this.#built.endpointIdentifier,
      state: this.#state,
      connectionId: this.#state === "OPEN" ? this.#connectionId : undefined,
      subscriptionGeneration: this.#subscriptionGeneration,
      subscribedStreams: this.streamNames,
      stalenessMs: baseline === undefined ? 0 : elapsedMsBetween(baseline, now),
      stalenessThresholdMs: this.#stalenessThresholdMs,
      lastFrameAt: this.#lastFrameAt?.receivedAt,
      lastVenueTimestamp: this.#lastVenueTimestamp,
      lastVenueToReceiptLagMs: this.#lastVenueToReceiptLagMs,
      maxVenueToReceiptLagMs: this.#maxVenueToReceiptLagMs,
      connectionAgeMs:
        this.#connectedAt === undefined ? undefined : elapsedMsBetween(this.#connectedAt, now),
      connectionLifetimeMs: BINANCE_LIMITS.connectionLifetimeMs,
      frames: { ...this.#frames },
      connections: { ...this.#connections },
      openIncidentReasonCodes: [...this.#openIncidents].sort(),
      sequences: this.#sequences.snapshot(),
      trackedStreams: this.#sequences.trackedKeys,
      maxTrackedStreams: this.#sequences.maxKeys,
      untrackedSequenceObservations: this.#sequences.untrackedObservations,
    });
  }

  // -------------------------------------------------------------------------
  // Frame handlers
  // -------------------------------------------------------------------------

  #handleTrade(
    decoded: Extract<DecodedFrame, { kind: "TRADE" }>,
    receipt: ReceiptStamp,
    context: FeedStatusContext,
    emissions: AdapterEmission[],
  ): FrameOutcome {
    const key = decoded.streamName ?? `${decoded.symbol.toLowerCase()}@trade`;
    const sequence = this.#sequences.observe(key, decoded.tradeId, tradeIdentity(decoded));

    if (sequence.outcome === "DUPLICATE") {
      this.#frames.duplicatesSuppressed += 1;
      return {
        emissions,
        directive: NO_DIRECTIVE,
        decoded,
        classification: "DUPLICATE_SUPPRESSED",
        sequence,
        advisory: undefined,
      };
    }
    if (sequence.outcome === "CONFLICTING_DUPLICATE") {
      this.#frames.conflictingDuplicates += 1;
      this.#pushIncident(emissions, context, {
        reasonCode: BINANCE_REASON_CODES.sequenceConflict,
        severity: "NOTIFY",
        detail: `trade id ${String(decoded.tradeId)} on ${key} repeated with different content — raw: ${rawExcerpt(decoded.raw)}`,
      });
      return {
        emissions,
        directive: NO_DIRECTIVE,
        decoded,
        classification: "CONFLICTING_DUPLICATE",
        sequence,
        advisory: undefined,
      };
    }

    const normalized = normalizeTrade(decoded, {
      timeUnit: this.#built.timeUnit,
      takerSideConvention: this.#takerSideConvention,
    });
    if (!normalized.ok) {
      this.#frames.unrepresentableValues += 1;
      this.#pushIncident(emissions, context, {
        reasonCode: BINANCE_REASON_CODES.valueUnrepresentable,
        severity: "NOTIFY",
        detail: `trade on ${key} could not cross the domain boundary: ${normalized.failures.map((failure) => `${failure.field}=${failure.rawValue} (${failure.detail})`).join("; ")}`,
      });
      return {
        emissions,
        directive: NO_DIRECTIVE,
        decoded,
        classification: "UNREPRESENTABLE",
        sequence,
        advisory: undefined,
      };
    }

    if (sequence.outcome === "REGRESSED") {
      // A trade is a point observation, not versioned state: a late one is still
      // a trade that happened, and ADR-002 §2.2 already forbids reordering by
      // venue time, so publishing it costs nothing and dropping it would lose a
      // real event (§8.3).
      this.#frames.lateTradesEmitted += 1;
    }

    this.#recordVenueLag(normalized.venueTimestamp, receipt);
    emissions.push(
      buildEmission({
        contract: ReferenceTradeObservedContract,
        sourceChannel: key,
        venueTimestamp: normalized.venueTimestamp,
        receipt,
        provenance: context.provenance,
        payload: normalized.payload,
      }),
    );
    this.#frames.tradesNormalized += 1;
    this.#frames.eventsEmitted += 1;

    return {
      emissions,
      directive: NO_DIRECTIVE,
      decoded,
      classification: "NORMALIZED",
      sequence,
      advisory: undefined,
    };
  }

  #handleBookTicker(
    decoded: Extract<DecodedFrame, { kind: "BOOK_TICKER" }>,
    receipt: ReceiptStamp,
    context: FeedStatusContext,
    emissions: AdapterEmission[],
  ): FrameOutcome {
    const key = decoded.streamName ?? `${decoded.symbol.toLowerCase()}@bookTicker`;
    const sequence = this.#sequences.observe(key, decoded.updateId, bookTickerIdentity(decoded));

    if (sequence.outcome === "DUPLICATE") {
      this.#frames.duplicatesSuppressed += 1;
      return {
        emissions,
        directive: NO_DIRECTIVE,
        decoded,
        classification: "DUPLICATE_SUPPRESSED",
        sequence,
        advisory: undefined,
      };
    }
    if (sequence.outcome === "CONFLICTING_DUPLICATE") {
      this.#frames.conflictingDuplicates += 1;
      this.#pushIncident(emissions, context, {
        reasonCode: BINANCE_REASON_CODES.sequenceConflict,
        severity: "NOTIFY",
        detail: `book updateId ${String(decoded.updateId)} on ${key} repeated with different best bid/ask — raw: ${rawExcerpt(decoded.raw)}`,
      });
      return {
        emissions,
        directive: NO_DIRECTIVE,
        decoded,
        classification: "CONFLICTING_DUPLICATE",
        sequence,
        advisory: undefined,
      };
    }
    if (sequence.outcome === "REGRESSED") {
      // Top of book is versioned state. Applying an older version would replace
      // newer state with older state, which is what the venue's own local-book
      // procedure says to avoid ("If the event last update ID (`u`) is less than
      // the update ID of your local order book, ignore the event"). It is
      // suppressed, counted, and returned — never quietly discarded.
      this.#frames.staleUpdatesSuppressed += 1;
      return {
        emissions,
        directive: NO_DIRECTIVE,
        decoded,
        classification: "STALE_SUPPRESSED",
        sequence,
        advisory: undefined,
      };
    }

    const normalized = normalizeBookTicker(decoded);
    if (!normalized.ok) {
      this.#frames.unrepresentableValues += 1;
      this.#pushIncident(emissions, context, {
        reasonCode: BINANCE_REASON_CODES.bookSideUnrepresentable,
        severity: "LOG",
        detail: `neither book side on ${key} could cross the domain boundary: ${normalized.failures.map((failure) => `${failure.field}=${failure.rawValue} (${failure.detail})`).join("; ")}`,
      });
      return {
        emissions,
        directive: NO_DIRECTIVE,
        decoded,
        classification: "UNREPRESENTABLE",
        sequence,
        advisory: undefined,
      };
    }

    if (normalized.omittedSides.length > 0) {
      this.#frames.partialTopOfBook += 1;
      this.#pushIncident(emissions, context, {
        reasonCode: BINANCE_REASON_CODES.bookSideUnrepresentable,
        severity: "LOG",
        detail: `partial top of book on ${key}; omitted ${normalized.omittedSides.map((failure) => `${failure.field}=${failure.rawValue}`).join("; ")}`,
      });
    }

    emissions.push(
      buildEmission({
        contract: ReferenceTopOfBookChangedContract,
        sourceChannel: key,
        // Deliberately absent: `bookTicker` carries no venue timestamp, and the
        // receipt stamp is not a substitute for one.
        receipt,
        provenance: context.provenance,
        payload: normalized.payload,
      }),
    );
    this.#frames.topOfBookNormalized += 1;
    this.#frames.eventsEmitted += 1;

    return {
      emissions,
      directive: NO_DIRECTIVE,
      decoded,
      classification: "NORMALIZED",
      sequence,
      advisory: undefined,
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  #contextFor(receipt: ReceiptStamp, sourceChannel: string): FeedStatusContext {
    const provenance: EmissionProvenance = {
      connectionId: this.#connectionId ?? `${this.#feedId}:unconnected`,
      subscriptionGeneration: this.#subscriptionGeneration,
    };
    return { feedId: this.#feedId, sourceChannel, receipt, provenance };
  }

  #recordVenueLag(venueTimestamp: string, receipt: ReceiptStamp): void {
    this.#lastVenueTimestamp = venueTimestamp;
    const lag = venueToReceiptLagMs(venueTimestamp, receipt.receivedAt);
    this.#lastVenueToReceiptLagMs = lag;
    this.#maxVenueToReceiptLagMs =
      this.#maxVenueToReceiptLagMs === undefined
        ? lag
        : Math.max(this.#maxVenueToReceiptLagMs, lag);
  }

  /**
   * Opens one incident per reason code per connection.
   *
   * Suppressing the repeat is not a silent drop: the occurrence is already
   * counted in the frame counters and returned to the caller on the
   * {@link FrameOutcome}. What it prevents is a malformed-frame storm turning
   * into an incident storm, which would bury the first (and most useful) report.
   * This package never emits `DataQualityIncidentClosed` — it does not know when
   * a condition has been resolved, and asserting a resolution it did not observe
   * would be the mirror of the `FeedResynchronized` mistake ADR-002 §2.4 forbids.
   */
  #openIncident(
    context: FeedStatusContext,
    input: {
      readonly reasonCode: string;
      readonly severity: IncidentSeverity;
      readonly detail?: string;
    },
  ): AdapterEmission | undefined {
    if (this.#openIncidents.has(input.reasonCode)) {
      return undefined;
    }
    this.#openIncidents.add(input.reasonCode);
    this.#incidentOrdinal += 1;
    this.#connections.incidentsOpened += 1;
    return dataQualityIncidentOpened(context, {
      incidentId: `${this.#feedId}:${context.provenance.connectionId}:${String(this.#incidentOrdinal)}`,
      reasonCode: input.reasonCode,
      severity: input.severity,
      ...(input.detail === undefined ? {} : { detail: truncateDetail(input.detail) }),
    });
  }

  #pushIncident(
    emissions: AdapterEmission[],
    context: FeedStatusContext,
    input: {
      readonly reasonCode: string;
      readonly severity: IncidentSeverity;
      readonly detail?: string;
    },
  ): void {
    const incident = this.#openIncident(context, input);
    if (incident !== undefined) {
      emissions.push(incident);
    }
  }
}

/** The domain's `DetailStringSchema` bound (§7.4 boundary hygiene). */
const MAX_DETAIL_LENGTH = 2000;

function truncateDetail(detail: string): string {
  return detail.length <= MAX_DETAIL_LENGTH ? detail : `${detail.slice(0, MAX_DETAIL_LENGTH - 1)}…`;
}
