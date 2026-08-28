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
 * ONE SOCKET IS LIVE, AND ONLY THAT SOCKET IS HEARD. Every socket event carries
 * the identity of the socket that produced it (`./connection.ts`), and this feed
 * accepts an event only from the socket it is currently listening to. A
 * superseded or already-closed socket can still deliver a buffered message, an
 * error, or its close event; applying those to the current connection would
 * stamp another socket's traffic with this connection's id and generation, and
 * would let a dead socket's close disconnect a healthy feed and trigger a
 * spurious reconnect. Such an event is refused, classified, counted, and
 * reported as a data-quality incident — it changes no connection state
 * (round-1 review, finding H1).
 *
 * A REPLACEMENT ATTEMPT DOES NOT SILENCE THE SOCKET THAT IS STILL LIVE. The
 * attempt in flight and the socket being listened to are two different facts, so
 * they are two different fields: {@link BinanceReferenceFeed.pendingConnectionId}
 * and {@link BinanceReferenceFeed.liveConnectionId}. `CONNECTING` therefore means
 * "an attempt is in flight AND no socket is live"; registering a replacement
 * while a socket is still delivering data leaves the feed `OPEN`, so that
 * socket's frames are still normalized and its staleness clock still runs for the
 * whole make-before-break interval — including after a refused pre-open failure
 * of the replacement. Before this fix {@link BinanceReferenceFeed.connecting}
 * moved the feed to `CONNECTING` unconditionally, and the live socket's own
 * market data was then refused as "a frame with no live socket" and its silence
 * went unreported (round-3 review, finding R3-M1). The other half of the same
 * handover is what happens when the live socket loses the race and closes first:
 * the replacement the caller authorized is still in flight, so the feed keeps it,
 * becomes `CONNECTING`, and directs NOTHING — a driver told to reconnect there
 * would register a third identity, retire the replacement it had already opened,
 * and spend a second reconnect attempt on one outage (round-4 review, R4-M1).
 *
 * AN IDENTITY IS AUTHORIZED BEFORE IT IS BELIEVED. Being unrecognised is not a
 * licence: an identity the feed never authorized may not open a connection,
 * disconnect one, or record an error against one. {@link
 * BinanceReferenceFeed.connecting} registers the identity the caller is about to
 * open, and that ONE identity is the pending attempt. `OPEN` is accepted only for
 * it; a pre-open `ERROR`/`CLOSE` is accepted only for it and only while no socket
 * is live (that is a connection attempt reporting its own failure, which must
 * still produce the reconnect directive the driver needs). Every other identity —
 * on a fresh `IDLE` feed, during a replacement's connecting interval, after the
 * caller shut the feed down, or from a socket retired past the bounded memory
 * below — is refused for all four event types, counted, and reported. Without
 * this, "no socket is live" was itself the authorization, and any well-formed
 * string could disconnect a feed or open a subscription generation (round-2
 * review, finding R2-M1).
 *
 * NOTHING IS DROPPED SILENTLY (§8.3). Every frame produces a
 * {@link FrameOutcome} carrying the decoded frame, a classification, and any
 * emissions. A duplicate, a stale update, an unknown event type, a malformed
 * frame, and a frame from a retired socket are all classifications with counters
 * and (except for duplicates, which are the normal, expected case) a
 * data-quality incident — never an early `return` with nothing recorded.
 *
 * NO SOCKET EVENT PATH THROWS. `onOpen`, `onFrame`, `onSocketError`, and
 * `onClose` are transport callbacks: a throw inside one surfaces in the driver's
 * event loop, where it destroys the frame rather than recording it. Every
 * misuse a transport can commit — a frame while nothing is open, an event from a
 * retired or unauthorized socket, an open on a closed feed — is therefore a
 * classified outcome. Direct caller mistakes that are not socket events
 * (constructing with a bad option, calling
 * {@link BinanceReferenceFeed.connecting} on a closed feed or with an identity
 * this feed already listened to, retired, or authorized) still throw, because
 * those are programming errors on a path the caller controls.
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
  isWellFormedConnectionId,
  nextReconnectDelayMs,
  DEFAULT_RECONNECT_POLICY,
  MAX_CONNECTION_ID_LENGTH,
  NO_DIRECTIVE,
  type BinanceSocketEvent,
  type ConnectionDirective,
  type ConnectionIdentityRelation,
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

/**
 * How many retired connection identities the feed remembers.
 *
 * Bounded for the same reason the sequence tracker is: the identities come from
 * the caller and the set would otherwise grow for the life of the process.
 *
 * EVICTION CHANGES NO ACCEPTANCE DECISION. Authorization comes from the
 * registered pending attempt and the live socket, never from the absence of a
 * memory: `OPEN` requires the pending identity, `MESSAGE` requires the live one,
 * and `ERROR`/`CLOSE` require the live one or the pending one while nothing is
 * live. An identity evicted from this FIFO is therefore described as `UNKNOWN`
 * rather than `RETIRED` and is refused exactly as a `RETIRED` one would be, for
 * all four event types (round-2 review, R2-M1; before that fix an evicted
 * identity could open a connection and supersede the live socket).
 *
 * What eviction does cost is a caller-contract CHECK: {@link
 * BinanceReferenceFeed.connecting} refuses to register an identity it remembers
 * retiring, and after this many retirements it can no longer catch a caller that
 * reuses an ancient id. That is a violation of the caller's own documented
 * obligation — one connection id identifies exactly one connection — and it
 * grants no socket any authority the caller did not deliberately hand it.
 */
const MAX_REMEMBERED_RETIRED_CONNECTIONS = 256;

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
  | "MALFORMED"
  /**
   * The frame did not come from the socket this feed is listening to.
   *
   * Decoded and returned so nothing is lost, but applied to nothing: it is not
   * this connection's data and must not be recorded as if it were.
   */
  | "STALE_CONNECTION";

/**
 * A socket event the feed refused because of the socket it came from.
 *
 * Returned as data rather than thrown, so a driver can log or count it without
 * a `try`/`catch` around its own event loop.
 */
export type RejectedSocketEvent = {
  readonly eventType: BinanceSocketEvent["type"];
  /** The identity the event carried, exactly as received. */
  readonly connectionId: string;
  readonly relation: ConnectionIdentityRelation;
  /** The identity the feed is listening to, if any. */
  readonly liveConnectionId: string | undefined;
  /**
   * The identity the caller registered for the attempt in flight, if any.
   *
   * Reported beside `liveConnectionId` because together they are the whole
   * authorization state: a refusal is explained by what the feed was listening
   * to and what it had authorized, not by what the event claimed.
   */
  readonly pendingConnectionId: string | undefined;
  readonly detail: string;
};

/** Result of a lifecycle transition. */
export type FeedOutcome = {
  readonly emissions: readonly AdapterEmission[];
  readonly directive: ConnectionDirective;
  /**
   * Present when the event was refused because of its socket identity.
   *
   * Absent on every accepted transition, so `rejected === undefined` is the
   * check for "this event was applied".
   */
  readonly rejected?: RejectedSocketEvent;
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
  /**
   * Bound on each stream's duplicate window; see `SequenceTracker`.
   *
   * Raise it for a venue path that reorders further than the default covers;
   * an id evicted from the window can no longer be recognised as a repeat.
   */
  readonly maxRecentIdsPerStream?: number;
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
  /** The channels this connection subscribed to; a frame claiming another is refused. */
  readonly #expectedStreams: ReadonlySet<string>;

  /**
   * What the feed's OWN socket is doing — never what an attempt is doing.
   *
   * `CONNECTING` means "no socket is live and an attempt is in flight". A
   * replacement attempt registered while a socket is still live leaves this
   * `OPEN`, because the live socket is still open: the attempt is tracked by
   * {@link BinanceReferenceFeed.pendingConnectionId} instead (R3-M1).
   */
  #state: FeedConnectionState = "IDLE";
  /**
   * Identity of the socket the feed is listening to, or `undefined` when none
   * is live. Only this socket's events are applied.
   */
  #liveConnectionId: string | undefined;
  /**
   * Identity of the most recent connection, kept after it closes so that the
   * `FeedDisconnected` it produces still names the socket it belongs to.
   */
  #connectionId: string | undefined;
  /**
   * Identity the caller registered for the connection attempt in flight.
   *
   * The authorization for the next `OPEN`, and — while nothing is live — for a
   * pre-open `ERROR`/`CLOSE`. Cleared when the ATTEMPT resolves (it opened, its
   * own close was applied, the caller registered another attempt, or the caller
   * shut the feed down), so an attempt authorizes exactly one connection.
   * ANOTHER socket's close does not resolve it: when the live socket closes
   * mid-handover the attempt is still in flight and stays authorized, and the
   * feed becomes `CONNECTING` around it (round-4 review, R4-M1).
   */
  #pendingConnectionId: string | undefined;
  /** Identities that were live or pending and no longer are; bounded, FIFO. */
  readonly #retiredConnectionIds = new Set<string>();
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
    framesNotFromLiveConnection: 0,
  };

  readonly #connections: MutableConnectionCounters = {
    connectionAttempts: 0,
    connectionsOpened: 0,
    disconnects: 0,
    socketErrors: 0,
    staleEpisodes: 0,
    incidentsOpened: 0,
    lifecycleEventsNotFromLiveConnection: 0,
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
    this.#sequences = new SequenceTracker(
      options.maxTrackedStreams,
      options.maxRecentIdsPerStream,
    );
    this.#expectedStreams = new Set(
      this.#built.subscriptions.map((subscription) => subscription.streamName),
    );
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

  /** Identity of the socket the feed is listening to, if any. */
  public get liveConnectionId(): string | undefined {
    return this.#liveConnectionId;
  }

  /**
   * Identity registered for the connection attempt in flight, if any.
   *
   * Exposed because it is half of the answer to "why was that event refused?",
   * and a driver that has lost track of its own attempt should be able to see
   * what the feed authorized.
   */
  public get pendingConnectionId(): string | undefined {
    return this.#pendingConnectionId;
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
   * Registers the connection attempt the caller is about to make.
   *
   * `connectionId` is REQUIRED and is the authorization for that attempt: it is
   * the only identity whose `OPEN` this feed will accept, and — while no socket
   * is live — the only one whose pre-open `ERROR`/`CLOSE` it will apply. Passing
   * it here rather than discovering it on the `OPEN` event is what makes "the
   * feed has never heard of this socket" a refusal instead of a licence
   * (round-2 review, R2-M1). The same value must be given to the transport on
   * the {@link BinanceSocketRequest}.
   *
   * Returns the URL to open, so the caller never has to assemble one itself and
   * cannot accidentally connect to a different endpoint than the one recorded on
   * `FeedConnected`.
   *
   * REGISTERING AN ATTEMPT CHANGES NOTHING ABOUT A LIVE SOCKET. If one is live,
   * the feed stays `OPEN` and keeps normalizing that socket's frames and running
   * its staleness clock; only a feed with no live socket becomes `CONNECTING`.
   * That is what make-before-break means, and it holds for the whole interval —
   * through the replacement's own pre-open failure, which is refused as data
   * (R2-M1 assumption 3) and leaves the live connection untouched (round-3
   * review, R3-M1).
   *
   * THROWS, unlike the socket-event paths. Registering an attempt is a direct
   * caller action, not a transport callback, so a mistake here is a programming
   * error and a silent value would hide it: a closed feed opens nothing, an
   * identity must be well formed, and an identity this feed already listened to,
   * retired, or authorized cannot be registered again — one connection id
   * identifies exactly one connection.
   */
  public connecting(connectionId: string): {
    readonly url: string;
    readonly attempt: number;
    readonly connectionId: string;
  } {
    if (this.#state === "CLOSED") {
      throw new BinanceStateError("a closed feed cannot open a new connection", {
        feedId: this.#feedId,
      });
    }
    const relation = this.#relationOf(connectionId);
    if (relation === "INVALID") {
      throw new BinanceConfigurationError(
        `connectionId must be 1..${String(MAX_CONNECTION_ID_LENGTH)} characters`,
        { feedId: this.#feedId, length: connectionId.length },
      );
    }
    if (relation !== "UNKNOWN") {
      throw new BinanceStateError(
        `connectionId ${excerptIdentity(connectionId)} is already this feed's ${relation} connection; a connection id identifies exactly one connection`,
        { feedId: this.#feedId, relation },
      );
    }

    // An attempt the caller replaced without resolving is over: it can never
    // open, and its late events are another socket's, so it joins the retired
    // identities rather than staying authorized.
    this.#abandonPendingAttempt();

    // REGISTERING AN ATTEMPT NEVER DISABLES A SOCKET THAT IS STILL LIVE.
    // `CONNECTING` describes the feed's own socket — "none is live, and one is
    // being opened" — so only a feed with nothing live enters it. A replacement
    // registered while a socket is still delivering data is a make-before-break
    // reconnect: the feed stays `OPEN`, that socket's frames stay this
    // connection's data, and its staleness clock keeps running until the
    // replacement actually opens (or the live socket closes). Setting
    // `CONNECTING` here unconditionally is what made the live socket's own
    // frames `STALE_CONNECTION` — reported, wrongly, as arriving with no live
    // socket — and disabled `checkStaleness` for the entire replacement
    // interval, including after a refused pre-open failure (round-3 review,
    // R3-M1).
    if (this.#liveConnectionId === undefined) {
      this.#state = "CONNECTING";
    }
    this.#pendingConnectionId = connectionId;
    this.#connections.connectionAttempts += 1;
    return {
      url: this.#built.url,
      attempt: this.#connections.connectionAttempts,
      connectionId,
    };
  }

  /** The single entry point a transport driver uses. */
  public handleSocketEvent(event: BinanceSocketEvent, receipt: ReceiptStamp): FrameOutcome | FeedOutcome {
    switch (event.type) {
      case "OPEN":
        return this.onOpen(event.connectionId, receipt);
      case "MESSAGE":
        return this.onFrame(event.connectionId, event.data, receipt);
      case "ERROR":
        return this.onSocketError(event.connectionId, receipt, {
          ...(event.reasonCode === undefined ? {} : { reasonCode: event.reasonCode }),
          ...(event.detail === undefined ? {} : { detail: event.detail }),
        });
      case "CLOSE":
        return this.onClose(event.connectionId, receipt, {
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
   *
   * An OPEN is accepted ONLY for the identity the caller registered with
   * {@link connecting}. Nothing else opens a connection here: not a live
   * identity re-announcing itself (a transport bug — ids are documented as
   * unique per connection), not a retired one (reviving it would resurrect a
   * socket this feed has already accounted for), and above all not an identity
   * the feed never authorized, whose OPEN would otherwise create a subscription
   * generation for a socket nothing asked for and supersede the live connection
   * (round-2 review, R2-M1, probe 4).
   *
   * An OPEN for the registered identity while another socket is live IS accepted
   * — that is a make-before-break reconnect, which the caller authorized by
   * registering the attempt — and it retires the previous socket, whose later
   * events are then refused rather than mixed into the new connection.
   */
  public onOpen(connectionId: string, receipt: ReceiptStamp): FeedOutcome {
    if (this.#state === "CLOSED") {
      return this.#reject("OPEN", connectionId, receipt, {
        relation: this.#relationOf(connectionId),
        detail: "the feed was closed by its caller; it opens no further connections",
        directive: { kind: "STOP", reason: "CLOSED_BY_CALLER" },
      });
    }
    const relation = this.#relationOf(connectionId);
    if (relation !== "PENDING") {
      return this.#reject("OPEN", connectionId, receipt, {
        relation,
        detail:
          relation === "INVALID"
            ? `connectionId must be 1..${String(MAX_CONNECTION_ID_LENGTH)} characters`
            : relation === "LIVE"
              ? "this connection is already open; a connection id must identify exactly one connection"
              : relation === "RETIRED"
                ? "this connection id was already used and retired; a retired socket is never revived"
                : "no connection attempt was registered for this identity; only the identity passed to connecting() may open a connection",
      });
    }

    // The attempt resolved: it authorized this connection and no other.
    this.#pendingConnectionId = undefined;
    // A make-before-break open supersedes the socket that was live.
    this.#retire(this.#liveConnectionId);

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
    this.#liveConnectionId = connectionId;
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

  /**
   * The transport reported an error on the socket.
   *
   * Accepted from the live socket, and from the REGISTERED pending attempt while
   * none is live — that second case is a connection attempt that failed before
   * it ever opened, which is exactly when an error matters most. An error under
   * any other identity is refused: it is another socket's, or nobody's, and
   * counting it as this feed's would report a connection problem the feed's own
   * sockets never had (round-2 review, R2-M1, probes 1 and 3).
   */
  public onSocketError(
    connectionId: string,
    receipt: ReceiptStamp,
    input: { readonly reasonCode?: string; readonly detail?: string } = {},
  ): FeedOutcome {
    const relation = this.#relationOf(connectionId);
    if (!this.#acceptsLifecycleEvent(relation)) {
      return this.#reject("ERROR", connectionId, receipt, {
        relation,
        detail:
          relation === "PENDING"
            ? "this is the registered attempt's own error, but another socket is live and only that socket describes this feed's connection; it is reported to the driver rather than recorded against the live connection"
            : "an error from a socket this feed is neither listening to nor authorized changes nothing here",
        ...(this.#state === "CLOSED"
          ? { directive: { kind: "STOP", reason: "CLOSED_BY_CALLER" } as const }
          : {}),
      });
    }
    this.#connections.socketErrors += 1;
    const context = this.#contextFor(receipt, BINANCE_CONNECTION_CHANNEL, connectionId);
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
   *
   * A RECONNECT IS DIRECTED ONLY WHEN NO ATTEMPT IS ALREADY IN FLIGHT. If the
   * live socket closes while the caller's registered replacement is still
   * pending, that authorization survives the close: the feed becomes
   * `CONNECTING` (nothing live, one attempt outstanding — exactly what the state
   * means), keeps the pending identity, and returns `NONE`, because the caller
   * has already opened that socket. Directing a `RECONNECT_AFTER` here made the
   * driver register a third identity, which retires the replacement it had
   * authorized and opens a redundant socket, while `state` reported `IDLE` for a
   * feed that was connecting; it also charged the caller's `maxAttempts` budget
   * for an attempt that had not failed (round-4 review, R4-M1). The
   * `FeedDisconnected` for the socket that actually closed is emitted either
   * way: the handover is a real interruption, whatever happens next.
   *
   * A close is accepted from the live socket, or — when none is live — from the
   * REGISTERED pending attempt, so a connection attempt that failed before it
   * opened still produces the reconnect directive the driver needs. Every other
   * close is refused: from an already-retired socket, because acting on it would
   * disconnect a healthy connection and start a reconnect nothing asked for
   * (round-1 review, H1); from an identity the feed never authorized, because
   * "nothing is live" is not a licence to disconnect a feed on any well-formed
   * string that arrives — on a fresh `IDLE` feed, or during a replacement's
   * connecting interval, that forged close used to emit `FeedDisconnected` and
   * spend a reconnect attempt (round-2 review, R2-M1, probes 1 and 2).
   */
  public onClose(
    connectionId: string,
    receipt: ReceiptStamp,
    input: { readonly code?: number; readonly reason?: string } = {},
  ): FeedOutcome {
    const relation = this.#relationOf(connectionId);
    if (this.#state === "CLOSED") {
      // The caller shut the feed down and retired its socket; that socket's own
      // close is the expected epilogue and is not an anomaly. Any OTHER identity
      // closing a feed that is already closed is refused as data, so a forged
      // close after shutdown is visible rather than absorbed.
      if (relation === "RETIRED" || relation === "LIVE") {
        return { emissions: [], directive: { kind: "STOP", reason: "CLOSED_BY_CALLER" } };
      }
      return this.#reject("CLOSE", connectionId, receipt, {
        relation,
        detail:
          "the feed was closed by its caller; a close from an identity it never listened to changes nothing",
        directive: { kind: "STOP", reason: "CLOSED_BY_CALLER" },
      });
    }
    if (!this.#acceptsLifecycleEvent(relation)) {
      return this.#reject("CLOSE", connectionId, receipt, {
        relation,
        detail:
          relation === "PENDING"
            ? "this registered attempt failed before it opened while another socket is still live; it disconnects nothing and directs no reconnect, and the live connection carries on"
            : "a close from a socket this feed is neither listening to nor authorized disconnects nothing and directs no reconnect",
      });
    }
    // The attempt resolved by failing; it authorizes nothing further.
    if (relation === "PENDING") {
      this.#pendingConnectionId = undefined;
    }
    this.#connections.disconnects += 1;
    const context = this.#contextFor(receipt, BINANCE_CONNECTION_CHANNEL, connectionId);
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

    this.#connectedAt = undefined;
    // The socket that closed is done: a further event carrying its identity is
    // a retired socket talking, not this feed's connection.
    this.#retire(connectionId);

    // A REPLACEMENT THE CALLER ALREADY AUTHORIZED IS STILL AN ATTEMPT IN
    // FLIGHT. When the live socket closes mid-handover the feed has exactly the
    // shape `CONNECTING` describes — nothing live, one attempt outstanding — and
    // the caller has already opened that socket, so there is nothing to direct:
    // `NONE` is documented as "one is already in flight". Directing a reconnect
    // here told the driver to register a THIRD identity, which retires the
    // authorized replacement mid-flight (its later `OPEN` would then be refused
    // as `RETIRED`), opens a redundant socket, and reports `IDLE` for a feed
    // that is connecting. It also spent a reconnect attempt on an outage the
    // pending attempt has not failed yet, so one logical outage consumed two
    // slots of the caller's `maxAttempts` budget (round-4 review, R4-M1). The
    // attempt is charged when the attempt itself fails — the branch below, on
    // the pending socket's own close.
    if (this.#pendingConnectionId !== undefined) {
      this.#state = "CONNECTING";
      return { emissions, directive: NO_DIRECTIVE };
    }

    this.#state = "IDLE";
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
    this.#retire(this.#liveConnectionId);
    // A shutdown revokes the outstanding authorization too: an attempt the
    // caller registered and then shut down may not open, error, or close its way
    // back into this feed.
    this.#abandonPendingAttempt();
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

  /**
   * Handles one received frame. Total: every input produces an outcome, and no
   * input throws.
   *
   * The frame is applied only when it came from the live socket. A frame from a
   * retired socket, or one arriving while no socket is live, is still decoded
   * (so the raw text and its shape survive) but touches no sequence state, no
   * staleness state, and no counter other than its own — it is another
   * connection's data, or no connection's.
   */
  public onFrame(connectionId: string, raw: string, receipt: ReceiptStamp): FrameOutcome {
    this.#frames.framesReceived += 1;

    const relation = this.#relationOf(connectionId);
    if (relation !== "LIVE" || this.#state !== "OPEN") {
      return this.#rejectFrame(connectionId, relation, raw, receipt);
    }

    // Any frame proves the socket is alive, so staleness is re-armed even for a
    // control response or a frame this package cannot use.
    this.#lastFrameAt = receipt;
    this.#staleReported = false;

    const decoded = decodeFrame(raw, { expectedStreams: this.#expectedStreams });
    const context = this.#contextFor(receipt, channelOf(decoded));
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
      connectionId: this.#liveConnectionId,
      pendingConnectionId: this.#pendingConnectionId,
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
      maxRecentIdsPerStream: this.#sequences.maxRecentIdsPerKey,
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
  // Socket identity
  // -------------------------------------------------------------------------

  /**
   * How an identity relates to the connections this feed authorized.
   *
   * Ordered from the most specific claim to the least: what it is listening to,
   * what it authorized, what it has finished with, and finally "nothing at all".
   * The three named relations are mutually exclusive by construction —
   * {@link connecting} registers only an identity that is `UNKNOWN` — so the
   * order is documentation rather than a tie-break.
   */
  #relationOf(connectionId: string): ConnectionIdentityRelation {
    if (!isWellFormedConnectionId(connectionId)) {
      return "INVALID";
    }
    if (connectionId === this.#liveConnectionId) {
      return "LIVE";
    }
    if (connectionId === this.#pendingConnectionId) {
      return "PENDING";
    }
    if (this.#retiredConnectionIds.has(connectionId)) {
      return "RETIRED";
    }
    return "UNKNOWN";
  }

  /**
   * Whether an ERROR or CLOSE may be applied.
   *
   * The live socket always may. The registered pending attempt may only while
   * nothing is live: that is a connection attempt reporting its own failure, and
   * refusing it would strand the driver with no reconnect directive. While a
   * socket IS live, only that socket describes the feed's connection state — a
   * replacement attempt failing must not emit `FeedDisconnected` for a feed that
   * is not disconnected, so its close is refused as data and the driver, which
   * holds the identity it registered, sees its own attempt fail in the returned
   * {@link RejectedSocketEvent}.
   *
   * Every other identity is refused unconditionally. Before the round-2 fix this
   * returned `true` for any `UNKNOWN` identity whenever nothing was live, which
   * made "no socket is live" the authorization and let a forged close disconnect
   * an `IDLE` feed and spend a reconnect attempt (R2-M1).
   */
  #acceptsLifecycleEvent(relation: ConnectionIdentityRelation): boolean {
    if (relation === "LIVE") {
      return true;
    }
    return relation === "PENDING" && this.#liveConnectionId === undefined;
  }

  /** Retires the registered attempt, if any, so it authorizes nothing further. */
  #abandonPendingAttempt(): void {
    const pending = this.#pendingConnectionId;
    this.#pendingConnectionId = undefined;
    this.#retire(pending);
  }

  /** Retires an identity, evicting the oldest when the bounded set is full. */
  #retire(connectionId: string | undefined): void {
    if (connectionId === undefined) {
      return;
    }
    if (connectionId === this.#liveConnectionId) {
      this.#liveConnectionId = undefined;
    }
    if (this.#retiredConnectionIds.has(connectionId)) {
      return;
    }
    if (this.#retiredConnectionIds.size >= MAX_REMEMBERED_RETIRED_CONNECTIONS) {
      const oldest = this.#retiredConnectionIds.values().next();
      if (!oldest.done) {
        this.#retiredConnectionIds.delete(oldest.value);
      }
    }
    this.#retiredConnectionIds.add(connectionId);
  }

  /** Refuses a lifecycle event, recording it as data rather than acting on it. */
  #reject(
    eventType: BinanceSocketEvent["type"],
    connectionId: string,
    receipt: ReceiptStamp,
    input: {
      readonly relation: ConnectionIdentityRelation;
      readonly detail: string;
      readonly directive?: ConnectionDirective;
    },
  ): FeedOutcome {
    this.#connections.lifecycleEventsNotFromLiveConnection += 1;
    const context = this.#contextFor(receipt, BINANCE_CONNECTION_CHANNEL);
    const incident = this.#openIncident(context, {
      reasonCode: refusalReasonCode(input.relation),
      severity: "NOTIFY",
      detail: `${eventType} from connection ${excerptIdentity(connectionId)} (${input.relation}; live connection ${this.#liveConnectionId ?? "none"}; registered attempt ${this.#pendingConnectionId ?? "none"}): ${input.detail}`,
    });
    return {
      emissions: incident === undefined ? [] : [incident],
      directive: input.directive ?? NO_DIRECTIVE,
      rejected: {
        eventType,
        connectionId,
        relation: input.relation,
        liveConnectionId: this.#liveConnectionId,
        pendingConnectionId: this.#pendingConnectionId,
        detail: input.detail,
      },
    };
  }

  /**
   * Refuses a frame that did not come from the live socket.
   *
   * It is still decoded, so the caller receives the same `FrameOutcome` shape as
   * for any other frame and the raw text is preserved (§8.3) — but nothing about
   * it is applied: not the sequence state (its ids belong to another
   * connection's stream), not the staleness clock (a dead socket's message is no
   * evidence that the live one is alive), and no domain event.
   */
  #rejectFrame(
    connectionId: string,
    relation: ConnectionIdentityRelation,
    raw: string,
    receipt: ReceiptStamp,
  ): FrameOutcome {
    this.#frames.framesNotFromLiveConnection += 1;
    const decoded = decodeFrame(raw, { expectedStreams: this.#expectedStreams });
    const context = this.#contextFor(receipt, BINANCE_CONNECTION_CHANNEL);
    const emissions: AdapterEmission[] = [];
    const noLiveSocket = this.#liveConnectionId === undefined || this.#state !== "OPEN";
    this.#pushIncident(emissions, context, {
      reasonCode: noLiveSocket
        ? BINANCE_REASON_CODES.frameWithoutConnection
        : refusalReasonCode(relation),
      severity: "NOTIFY",
      detail: noLiveSocket
        ? `a frame arrived from connection ${excerptIdentity(connectionId)} while the feed was ${this.#state} with no live socket; a transport delivers messages only between OPEN and CLOSE — raw: ${rawExcerpt(raw)}`
        : `a frame arrived from connection ${excerptIdentity(connectionId)} (${relation}) while ${excerptIdentity(this.#liveConnectionId ?? "")} is live; it is not this connection's data and is applied to nothing — raw: ${rawExcerpt(raw)}`,
    });
    return {
      emissions,
      directive: NO_DIRECTIVE,
      decoded,
      classification: "STALE_CONNECTION",
      sequence: undefined,
      advisory: undefined,
      rejected: {
        eventType: "MESSAGE",
        connectionId,
        relation,
        liveConnectionId: this.#liveConnectionId,
        pendingConnectionId: this.#pendingConnectionId,
        detail: noLiveSocket ? "no socket was live" : "the frame came from another socket",
      },
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  #contextFor(
    receipt: ReceiptStamp,
    sourceChannel: string,
    connectionId?: string,
  ): FeedStatusContext {
    const named =
      connectionId !== undefined && isWellFormedConnectionId(connectionId)
        ? connectionId
        : undefined;
    const provenance: EmissionProvenance = {
      connectionId: named ?? this.#connectionId ?? `${this.#feedId}:unconnected`,
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

/**
 * The `sourceChannel` a decoded frame may be recorded under.
 *
 * A stream name is used only when it was DERIVED from the payload or VERIFIED
 * against it. A wrapper name that nothing could check — the documented
 * `!serverShutdown` envelope, or a wrapper around a control response — is kept
 * on the decoded frame as data but never becomes an event's provenance: §7.1's
 * `sourceChannel` is a claim about where an event came from, and an unverified
 * claim from the wire is not one this package will repeat (round-1 review, M1).
 */
function channelOf(decoded: DecodedFrame): string {
  if (
    decoded.streamName !== undefined &&
    (decoded.channelSource === "WRAPPER" || decoded.channelSource === "RECONSTRUCTED")
  ) {
    return decoded.streamName;
  }
  return BINANCE_CONNECTION_CHANNEL;
}

/**
 * Which incident a refusal opens, by what the identity actually was.
 *
 * Three cases, because they are three different operator questions and one
 * bucket would answer none of them:
 *
 * - `LIVE` or `RETIRED` — a socket that IS or WAS this feed's: a duplicate open,
 *   or a superseded socket still talking. A transport-lifecycle problem.
 * - `PENDING` — the attempt the caller registered, reporting something the feed
 *   may not act on yet (its pre-open failure, or a frame before its `OPEN`,
 *   while another socket is live). The identity is authorized; the event is
 *   inadmissible in this state. Reporting it as unauthorized said the feed had
 *   "never authorized" an identity the caller had just registered (round-3
 *   review, R3-L1).
 * - anything else (`UNKNOWN`, `INVALID`) — traffic from a socket this feed has
 *   no relationship with: who opened it, and why is it calling back in here?
 */
function refusalReasonCode(relation: ConnectionIdentityRelation): string {
  if (relation === "LIVE" || relation === "RETIRED") {
    return BINANCE_REASON_CODES.retiredConnectionEvent;
  }
  if (relation === "PENDING") {
    return BINANCE_REASON_CODES.pendingAttemptEventInadmissible;
  }
  return BINANCE_REASON_CODES.unauthorizedConnectionEvent;
}

/** A bounded rendering of a connection id for an incident `detail`. */
function excerptIdentity(connectionId: string): string {
  const collapsed = connectionId.replace(/\s+/gu, " ").trim();
  if (collapsed.length === 0) {
    return "(empty id)";
  }
  return collapsed.length <= MAX_CONNECTION_ID_LENGTH
    ? JSON.stringify(collapsed)
    : `${JSON.stringify(collapsed.slice(0, MAX_CONNECTION_ID_LENGTH))}…(truncated)`;
}
