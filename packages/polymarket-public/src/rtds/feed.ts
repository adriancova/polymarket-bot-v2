/**
 * The RTDS Chainlink TWAP feed: connection lifecycle, heartbeat, staleness,
 * reconnect, and the stream-gap bookkeeping RTDS forces on a direct client.
 *
 * Everything stateful in the RTDS subtree lives here, and everything it depends
 * on is injected — clock, timers, socket factory, connection-id factory. There
 * is no module-level mutable state, no `Date.now()`, no `Math.random()`, and no
 * `setTimeout` reached directly, so a whole connection lifetime (connect,
 * subscribe, heartbeat, go quiet, drop, back off, reconnect, resubscribe) runs
 * in a unit test in microseconds with no network.
 *
 * ## What it emits
 *
 * | Transition | Event |
 * | --- | --- |
 * | socket opened, subscription sent | `FeedConnected` |
 * | opened again after a previous connection | `FeedConnected` **and** `FeedGapDetected` |
 * | a TWAP update normalized | `ReferenceTwapObserved` (+ its `quality`) |
 * | no update for `updateStalenessMs` | `FeedStale`, once per episode |
 * | socket closed, for any reason | `FeedDisconnected` |
 *
 * `FeedResynchronized` is NOT in that table and cannot be: it pins
 * `authoritativeSnapshotApplied: true`, and RTDS publishes no snapshot to apply
 * ("There is no snapshot, history, or replay after a disconnect"). The gap this
 * feed opens is real and unrecoverable from the venue, which is exactly what
 * ADR-009 §6 means when it requires a TWAP-dependent strategy to HALT on an RTDS
 * gap rather than interpolate or backfill.
 * {@link RtdsTwapFeed.acknowledgeUnobservedInterval} lets a caller clear the
 * adapter's gap state after it has decided what to do; it publishes nothing,
 * because nothing was recovered.
 *
 * ## No missing history is fabricated (`WP-100` acceptance 2)
 *
 * Three mechanisms, none of which invents a value:
 *
 * 1. a reconnect opens a `FeedGapDetected` naming the generation whose stream
 *    ended and the generation that replaced it;
 * 2. the first update of each series after a (re)connect carries
 *    `quality.firstObservationOnSubscription`, and — when this feed had seen
 *    that series before — a MEASURED `quality.unobservedInterval` between the
 *    last update it received and this one;
 * 3. nothing is ever interpolated, back-filled, replayed, or carried forward:
 *    an interval with no observation simply has no event.
 *
 * ## Staleness is data quality (`WP-100` acceptance 3)
 *
 * `FeedStale` is a domain event, `quality` rides on every observation, and
 * {@link RtdsTwapFeed.metrics} exposes the same facts as typed values. No
 * logger, no metrics client, no observability package is imported here.
 *
 * ## Six invariants inherited from the sibling feeds' review history
 *
 * These are not speculative; each is a defect an adversarial review found in a
 * feed of this shape, and each is designed out here from the start.
 *
 * 1. **Every callback is bound to the socket session that installed it.** A
 *    transport can deliver a frame, an open, an error or a close for a socket
 *    this feed has already abandoned. Each closure captures an immutable
 *    {@link RtdsSocketSession} and does nothing unless that token is still the
 *    live one. A stale MESSAGE is still recorded and reported — under the stale
 *    session's own identity — because §8.3 forbids dropping it silently.
 * 2. **No socket-dependent action is dropped because the handle has not
 *    arrived.** A transport may call `onOpen` synchronously from inside the
 *    factory call, before `#connect()` has anything to send on. Every such
 *    action is queued on the attempt's session and run the instant the handle is
 *    assigned, so the subscription really is written before `FeedConnected` is
 *    published.
 * 3. **A frame is subscription data only once that session's subscription has
 *    been written.** Anything earlier is refused as `RTDS_PRE_SUBSCRIPTION_FRAME`
 *    with the payload attached: no subscription existed under that generation,
 *    so the frame has no subscription provenance to publish it with.
 * 4. **Every gap opens under a generation the same transition advanced.** The
 *    subscription set is non-empty by construction (RTDS documents no dynamic
 *    change, so it is fixed at configuration time and validated there), so every
 *    (re)connect writes a subscribe frame and advances the generation in the
 *    same step. Gap generations are therefore unique and strictly increasing,
 *    which is what makes the generation a sufficient acknowledgement identity.
 * 5. **At most one session is ever live, and a connection attempt stands the
 *    pending reconnect down.** `#connect()` cancels any armed reconnect, the
 *    reconnect timer stands down unless the feed is still `idle` with no
 *    session, and `#connect()` retires, closes and reports any session that is
 *    somehow still live rather than overwriting it.
 * 6. **An observation reserves its identity only after it is published.** The
 *    series tracker is consulted before the domain boundary and updated after
 *    it, so a refused update does not suppress a corrected restatement.
 *
 * ## Credentials
 *
 * There are none. RTDS relays Chainlink TWAP updates without credentials; no
 * header, key, signature, or wallet is representable anywhere on this path.
 */

import { computeReconnectDelayMs } from "../feed/connection.js";
import { PublicMarketConfigurationError, PublicMarketStateError } from "../errors.js";
import { boundDetail } from "../normalize/result.js";
import type {
  CancelScheduled,
  PublicMarketClock,
  PublicMarketTimers,
  PublicWebSocket,
  PublicWebSocketCloseInfo,
  PublicWebSocketFactory,
} from "../ports.js";
import {
  RTDS_CHANNEL,
  RTDS_HEARTBEAT_REQUEST,
  RTDS_TWAP_TOPIC_BY_WINDOW,
  type RtdsTwapFeedOptions,
  resolveRtdsTwapFeedOptions,
} from "./config.js";
import { buildSubscribeFrame, decodeInboundRtdsFrame } from "./frames.js";
import { normalizeRtdsFrame } from "./normalize.js";
import { TwapObservationTracker } from "./observations.js";
import type { NormalizedRtdsEventAny, RtdsProblem } from "./result.js";
import {
  FEED_DISCONNECT_REASONS,
  FEED_GAP_REASONS,
  type FeedDisconnectReason,
  type FeedGapReason,
  rtdsFeedConnected,
  rtdsFeedDisconnected,
  rtdsFeedGapDetected,
  rtdsFeedStale,
} from "./signals.js";

/**
 * One inbound frame exactly as received.
 *
 * §9.1 requires raw frames to be preserved, and §8.3 forbids dropping them
 * silently. The feed hands every frame to the caller BEFORE parsing it, so a
 * frame that fails to parse is still recorded.
 */
export interface RawRtdsFrame {
  readonly receivedAt: string;
  readonly connectionId: string;
  readonly subscriptionGeneration: number;
  readonly sourceChannel: string;
  /** The frame text, untouched. */
  readonly payload: string;
}

/** Where the feed delivers its output. */
export interface RtdsTwapFeedHandlers {
  /** A normalized domain event: a TWAP observation or feed health. */
  onEvent(event: NormalizedRtdsEventAny): void;
  /** An inbound value that did not become an event. Never a silent drop. */
  onProblem(problem: RtdsProblem): void;
  /** Every inbound frame, before parsing, for the raw recorder. */
  onRawFrame?(frame: RawRtdsFrame): void;
}

/** Everything the feed needs from the outside world. */
export interface RtdsTwapFeedDependencies {
  readonly clock: PublicMarketClock;
  readonly timers: PublicMarketTimers;
  readonly webSocketFactory: PublicWebSocketFactory;
  /**
   * Mints the `connectionId` carried by the §7.1 provenance chain.
   *
   * Injected because generating one needs randomness, and a package that
   * reached for `crypto.randomUUID()` internally could not be replayed.
   */
  readonly connectionId: () => string;
  /**
   * Jitter source for the reconnect backoff, in `[0, 1)`.
   *
   * Defaults to a deterministic `1` — full delay, no jitter — so a caller that
   * supplies no randomness gets predictable behaviour instead of an implicit
   * `Math.random()`.
   */
  readonly randomFraction?: () => number;
}

type FeedStatus = "idle" | "connecting" | "open" | "stopped";

/** Something that can only be done once a session's socket handle exists. */
type SocketAction = (socket: PublicWebSocket) => void;

/**
 * One socket's whole life, as an identity every callback closure captures.
 *
 * See invariant 1 in this module's header.
 */
interface RtdsSocketSession {
  /** Minted once, before the socket exists. Never reassigned. */
  readonly connectionId: string;
  /** The socket this session owns; assigned immediately after the factory call. */
  socket: PublicWebSocket | undefined;
  /** Socket-dependent work requested before the factory returned the handle. */
  readonly deferred: SocketAction[];
  /**
   * The subscription generation this session is serving.
   *
   * Before the open is processed this is the generation the feed held when the
   * attempt began, and NO subscription was written under it — which makes it
   * honest as a raw record's label and useless as event provenance.
   */
  generation: number;
  /** Whether this session's subscribe frame has been written. */
  subscribed: boolean;
  /** Whether a bare heartbeat text frame has already been reported for it. */
  heartbeatTextReported: boolean;
  /** Set when the feed stops treating this session as the live one. */
  retired: boolean;
}

/**
 * A gap that is open, and that the venue cannot close.
 *
 * Unlike an order-book gap, this one has no snapshot to fetch: RTDS publishes
 * no history and Chainlink's own latest-report endpoint needs credentials this
 * package may not hold. The two literal fields say so in a form a consumer can
 * branch on, rather than leaving it to prose.
 */
export interface RtdsOpenGap {
  readonly reasonCode: FeedGapReason;
  /** The generation opened by the transition that detected the gap. */
  readonly subscriptionGeneration: number;
  /** The generation whose stream ended. */
  readonly previousSubscriptionGeneration: number;
  readonly connectionId: string | undefined;
  readonly detectedAt: string;
  /** Always `false`: there is no venue-side recovery for a TWAP stream gap. */
  readonly recoverableFromVenue: false;
  /** Stable `CodeString` naming why. */
  readonly unrecoverableReason: "RTDS_NO_REPLAY_AFTER_DISCONNECT";
}

/** The caller's statement that it has dealt with an unrecoverable gap. */
export interface RtdsGapAcknowledgement {
  readonly subscriptionGeneration: number;
}

/** Why an acknowledgement was refused. Stable `CodeString` values (§14.3). */
export const RTDS_GAP_ACKNOWLEDGEMENT_REJECTIONS = {
  /** Nothing is owed: no gap is open, or one was already acknowledged. */
  noOpenGap: "NO_OPEN_GAP",
  /** The acknowledged generation is not the open gap's. */
  generationMismatch: "GENERATION_MISMATCH",
} as const;

export type RtdsGapAcknowledgementRejection =
  (typeof RTDS_GAP_ACKNOWLEDGEMENT_REJECTIONS)[keyof typeof RTDS_GAP_ACKNOWLEDGEMENT_REJECTIONS];

/** What {@link RtdsTwapFeed.acknowledgeUnobservedInterval} did. */
export type RtdsGapAcknowledgementOutcome =
  | { readonly status: "accepted"; readonly subscriptionGeneration: number }
  | {
      readonly status: "rejected";
      readonly reasonCode: RtdsGapAcknowledgementRejection;
      readonly detail: string;
      readonly expectedSubscriptionGeneration?: number;
    };

/**
 * Everything the feed knows about itself, as typed values.
 *
 * This is the "no observability dependency" half of acceptance 3: a caller that
 * wants a dashboard reads these; nothing here is a log line, and nothing has to
 * be parsed out of text.
 */
export interface RtdsTwapFeedMetrics {
  readonly status: FeedStatus;
  readonly connectionId: string | undefined;
  readonly subscriptionGeneration: number;
  readonly subscribedTopics: readonly string[];
  readonly connections: number;
  readonly reconnectAttempt: number;
  readonly framesReceived: number;
  readonly heartbeatsSent: number;
  /** Bare `PING`/`PONG` text frames received. Undocumented (RTDS-U2). */
  readonly heartbeatTextFramesReceived: number;
  readonly observationsPublished: number;
  readonly problemsReported: number;
  readonly staleEpisodes: number;
  /** Envelopes whose PUBLISHER timestamp was unusable; see `RtdsNormalization`. */
  readonly invalidPublisherTimestamps: number;
  readonly trackedSeries: number;
  readonly evictedSeries: number;
  /** Receipt time of the last frame of any kind: transport liveness. */
  readonly lastFrameAt: string | undefined;
  /** Receipt time of the last published observation: data liveness. */
  readonly lastObservationAt: string | undefined;
  /**
   * Milliseconds since the last published observation, or since the current
   * connection subscribed when there has been none. `undefined` while the feed
   * is not open, because staleness of a disconnected feed is a different fact
   * (`FeedDisconnected` already carries it).
   */
  readonly stalenessMs: number | undefined;
  readonly openGap: RtdsOpenGap | undefined;
  readonly acknowledgedGaps: number;
}

export class RtdsTwapFeed {
  readonly #options: RtdsTwapFeedOptions;
  readonly #deps: RtdsTwapFeedDependencies;
  readonly #handlers: RtdsTwapFeedHandlers;
  readonly #tracker: TwapObservationTracker;
  readonly #subscribedTopics: ReadonlySet<string>;

  #status: FeedStatus = "idle";
  #session: RtdsSocketSession | undefined;
  #generation = 0;
  #cancelHeartbeat: CancelScheduled | undefined;
  #cancelWatchdog: CancelScheduled | undefined;
  #cancelReconnect: CancelScheduled | undefined;
  #reconnectAttempt = 0;
  #hasConnectedBefore = false;
  #dataMarkMonotonicMs = 0;
  #lastFrameAtIso: string | undefined;
  #lastObservationAtIso: string | undefined;
  #staleReported = false;
  #gap: RtdsOpenGap | undefined;
  #closeReason: FeedDisconnectReason | undefined;
  #closeDetail: string | undefined;
  #connections = 0;
  #framesReceived = 0;
  #heartbeatsSent = 0;
  #heartbeatTextFrames = 0;
  #observationsPublished = 0;
  #problemsReported = 0;
  #staleEpisodes = 0;
  #invalidPublisherTimestamps = 0;
  #acknowledgedGaps = 0;

  constructor(
    dependencies: RtdsTwapFeedDependencies,
    handlers: RtdsTwapFeedHandlers,
    options: Partial<RtdsTwapFeedOptions> = {},
  ) {
    this.#deps = dependencies;
    this.#handlers = handlers;
    this.#options = resolveRtdsTwapFeedOptions(options);
    this.#tracker = new TwapObservationTracker({
      duplicateWindow: this.#options.duplicateWindowPerSeries,
      maxTrackedSeries: this.#options.maxTrackedSeries,
    });
    this.#subscribedTopics = new Set(
      this.#options.subscriptions.map(
        (subscription) => RTDS_TWAP_TOPIC_BY_WINDOW[subscription.windowSeconds],
      ),
    );
  }

  /** The topics this feed subscribes to on every (re)connect. */
  get subscribedTopics(): readonly string[] {
    return [...this.#subscribedTopics];
  }

  /** The current `subscriptionGeneration`. */
  get subscriptionGeneration(): number {
    return this.#generation;
  }

  /** The connection id events are currently stamped with, if connected. */
  get connectionId(): string | undefined {
    return this.#session?.connectionId;
  }

  /**
   * The open gap, when there is one.
   *
   * A caller cannot acknowledge a gap it cannot name: the acknowledgement is
   * checked against {@link RtdsOpenGap.subscriptionGeneration}.
   */
  get openGap(): RtdsOpenGap | undefined {
    return this.#gap;
  }

  /** Opens the connection. Idempotent while the feed is running. */
  start(): void {
    if (this.#status === "stopped") {
      throw new PublicMarketStateError("a stopped feed cannot be restarted; construct a new one");
    }
    if (this.#status !== "idle") return;
    this.#connect();
  }

  /**
   * Records that the caller has dealt with an unrecoverable gap.
   *
   * This is NOT a resynchronization and deliberately publishes nothing. There is
   * no authoritative TWAP snapshot to apply, so `FeedResynchronized` — which
   * pins `authoritativeSnapshotApplied: true` — would assert something false.
   * What the caller is acknowledging is that it has seen the gap and applied its
   * own policy (ADR-009 §6: halt; then resume from a fresh observation), and
   * what this method does is clear the adapter's gap state so the next gap is
   * distinguishable from this one.
   *
   * The generation is checked for the same reason the sibling feed checks it: a
   * late acknowledgement written for generation N must not clear a gap that a
   * newer reconnect opened under N+1.
   */
  acknowledgeUnobservedInterval(
    acknowledgement: RtdsGapAcknowledgement,
  ): RtdsGapAcknowledgementOutcome {
    this.#requireRunning();
    const gap = this.#gap;
    if (gap === undefined) {
      return {
        status: "rejected",
        reasonCode: RTDS_GAP_ACKNOWLEDGEMENT_REJECTIONS.noOpenGap,
        detail: boundDetail(
          `no gap is open (acknowledged generation ${String(acknowledgement.subscriptionGeneration)})`,
        ),
      };
    }
    if (acknowledgement.subscriptionGeneration !== gap.subscriptionGeneration) {
      return {
        status: "rejected",
        reasonCode: RTDS_GAP_ACKNOWLEDGEMENT_REJECTIONS.generationMismatch,
        detail: boundDetail(
          `the open gap was detected under subscription generation ${String(gap.subscriptionGeneration)}, not ${String(acknowledgement.subscriptionGeneration)}`,
        ),
        expectedSubscriptionGeneration: gap.subscriptionGeneration,
      };
    }
    this.#gap = undefined;
    this.#acknowledgedGaps += 1;
    return { status: "accepted", subscriptionGeneration: gap.subscriptionGeneration };
  }

  /** Everything the feed knows about itself, as typed values. */
  metrics(): RtdsTwapFeedMetrics {
    return {
      status: this.#status,
      connectionId: this.#session?.connectionId,
      subscriptionGeneration: this.#generation,
      subscribedTopics: this.subscribedTopics,
      connections: this.#connections,
      reconnectAttempt: this.#reconnectAttempt,
      framesReceived: this.#framesReceived,
      heartbeatsSent: this.#heartbeatsSent,
      heartbeatTextFramesReceived: this.#heartbeatTextFrames,
      observationsPublished: this.#observationsPublished,
      problemsReported: this.#problemsReported,
      staleEpisodes: this.#staleEpisodes,
      invalidPublisherTimestamps: this.#invalidPublisherTimestamps,
      trackedSeries: this.#tracker.trackedSeries,
      evictedSeries: this.#tracker.evictedSeries,
      lastFrameAt: this.#lastFrameAtIso,
      lastObservationAt: this.#lastObservationAtIso,
      stalenessMs:
        this.#status === "open"
          ? Math.max(0, this.#deps.clock.monotonicMs() - this.#dataMarkMonotonicMs)
          : undefined,
      openGap: this.#gap,
      acknowledgedGaps: this.#acknowledgedGaps,
    };
  }

  /** Closes the feed for good. A stopped feed cannot be restarted. */
  stop(): void {
    if (this.#status === "stopped") return;
    const wasConnected = this.#status === "open" || this.#status === "connecting";
    this.#status = "stopped";
    this.#cancelReconnect?.();
    this.#cancelReconnect = undefined;
    this.#stopTimers();
    const session = this.#retireSession();
    if (session !== undefined) {
      // Deferred when `stop()` was called from inside a synchronous transport
      // callback: the handle does not exist yet, and a socket nobody closes is a
      // socket that stays open after the feed is gone.
      this.#withSocket(session, (socket) => {
        socket.close();
      });
    }
    if (wasConnected && session !== undefined) {
      this.#emitDisconnected(session, FEED_DISCONNECT_REASONS.clientStopped, undefined);
    }
  }

  // ---- connection lifecycle ------------------------------------------------

  #connect(): void {
    // An armed reconnect belongs to the disconnect that armed it, and this
    // attempt supersedes it. A timer left running fires during or after this
    // connection and opens a socket over a live one.
    this.#cancelReconnect?.();
    this.#cancelReconnect = undefined;
    // Set before anything below can call back into the caller, so a `start()`
    // re-entered from a handler sees an attempt already in flight.
    this.#status = "connecting";
    this.#displaceLiveSession();
    // Displacing publishes a `FeedDisconnected`, which is caller code: if that
    // caller stopped the feed in response, this attempt is off.
    if (this.#status !== "connecting") return;
    const connectionId = this.#deps.connectionId();
    if (typeof connectionId !== "string" || connectionId === "") {
      // `FeedConnected.connectionId` is required and non-empty, and it is the
      // §7.1 provenance chain's link between an event and the connection it
      // arrived on. An empty one is an injection defect.
      throw new PublicMarketConfigurationError(
        "the injected connectionId factory returned no identifier",
        { connectionId },
      );
    }
    this.#closeReason = undefined;
    this.#closeDetail = undefined;
    const session: RtdsSocketSession = {
      connectionId,
      socket: undefined,
      deferred: [],
      generation: this.#generation,
      subscribed: false,
      heartbeatTextReported: false,
      retired: false,
    };
    this.#session = session;
    const socket = this.#deps.webSocketFactory(this.#options.url, {
      onOpen: () => {
        this.#onOpen(session);
      },
      onMessage: (data) => {
        this.#onMessage(session, data);
      },
      onClose: (info) => {
        this.#onClose(session, info);
      },
      onError: (error) => {
        this.#onError(session, error);
      },
    });
    session.socket = socket;
    // Whatever the callbacks asked this socket to do while the factory call was
    // still in flight runs now, in the order it was asked, on this attempt's own
    // handle. Work queued for a session that has ALREADY been retired still
    // runs, because that is how an abandoned socket gets closed rather than
    // leaked; the queued open re-checks liveness for itself.
    const deferred = session.deferred.splice(0, session.deferred.length);
    for (const action of deferred) {
      action(socket);
    }
  }

  /** Runs `action` on a session's socket, now or as soon as the handle exists. */
  #withSocket(session: RtdsSocketSession, action: SocketAction): void {
    const socket = session.socket;
    if (socket === undefined) {
      session.deferred.push(action);
      return;
    }
    action(socket);
  }

  /** Whether a callback's session is still the one this feed is driving. */
  #isLive(session: RtdsSocketSession): boolean {
    return this.#status !== "stopped" && !session.retired && this.#session === session;
  }

  /** Detaches the live session so its callbacks stop being authoritative. */
  #retireSession(): RtdsSocketSession | undefined {
    const session = this.#session;
    if (session === undefined) return undefined;
    session.retired = true;
    this.#session = undefined;
    return session;
  }

  /**
   * Refuses to let a new attempt overwrite a session that is still live.
   *
   * Nothing reaches here today: `#connect()` cancels the armed reconnect, and
   * the reconnect timer stands down unless the feed is still `idle` with no
   * session. That is the point — it is the assertion that keeps a leaked,
   * still-subscribed socket impossible rather than merely absent.
   */
  #displaceLiveSession(): void {
    const displaced = this.#retireSession();
    if (displaced === undefined) return;
    this.#stopTimers();
    this.#withSocket(displaced, (socket) => {
      socket.close();
    });
    this.#emitDisconnected(
      displaced,
      FEED_DISCONNECT_REASONS.connectionSuperseded,
      `connection ${displaced.connectionId} was still live when a new connection attempt began`,
    );
  }

  /**
   * The socket opened — possibly before `#connect()` holds the handle.
   *
   * The whole open is deferred as one unit rather than only the send, so the
   * published order is the documented one in both cases: advance the
   * generation, write the subscribe frame, then publish `FeedConnected`.
   */
  #onOpen(session: RtdsSocketSession): void {
    this.#withSocket(session, () => {
      this.#handleOpen(session);
    });
  }

  #handleOpen(session: RtdsSocketSession): void {
    if (!this.#isLive(session)) {
      // A socket this feed abandoned has opened. It is not ours to use and not
      // ours to leave running: closing it is the only state change here.
      this.#withSocket(session, (socket) => {
        socket.close();
      });
      return;
    }
    this.#status = "open";
    this.#reconnectAttempt = 0;
    this.#staleReported = false;
    this.#connections += 1;
    this.#dataMarkMonotonicMs = this.#deps.clock.monotonicMs();

    const previousGeneration = this.#generation;
    this.#generation += 1;
    session.generation = this.#generation;
    this.#withSocket(session, (socket) => {
      socket.send(JSON.stringify(buildSubscribeFrame(this.#options.subscriptions)));
    });
    // From here the session holds a subscription, so a frame arriving on it is
    // subscription data. Before here it was not, whatever the transport chose to
    // deliver.
    session.subscribed = true;

    this.#handlers.onEvent(
      rtdsFeedConnected({
        feedId: this.#options.feedId,
        connectionId: session.connectionId,
        endpoint: this.#options.url,
        subscriptionGeneration: this.#generation,
        connectedAt: this.#nowIso(),
      }),
    );

    if (this.#hasConnectedBefore) {
      // A reconnection replaced the server-side subscription state, and RTDS
      // sends no history: "Subscriptions start with the next update. There is no
      // snapshot, history, or replay after a disconnect." Whatever was published
      // while the socket was down is gone.
      this.#openGapAt(
        FEED_GAP_REASONS.reconnected,
        this.#generation,
        previousGeneration,
        `reconnected and resubscribed as generation ${String(this.#generation)}; RTDS publishes no snapshot, history or replay, so the interval since generation ${String(previousGeneration)} was not received and cannot be recovered`,
      );
    }
    this.#hasConnectedBefore = true;
    this.#startTimers();
  }

  #onMessage(session: RtdsSocketSession, data: string): void {
    // ONE clock read for the whole frame. The raw record's `receivedAt`, the
    // staleness marks and `quality.observationAgeMs` all describe the same
    // moment, and reading the clock twice would let them disagree by a
    // millisecond for no reason.
    const receivedEpochMs = this.#deps.clock.nowMs();
    const receivedAt = new Date(receivedEpochMs).toISOString();
    // The raw record is written for a stale frame too, and with the STALE
    // session's own identity: §9.1 wants the frame preserved, and preserving it
    // under the live connection's id would be a forged provenance chain.
    this.#handlers.onRawFrame?.({
      receivedAt,
      connectionId: session.connectionId,
      subscriptionGeneration: session.generation,
      sourceChannel: RTDS_CHANNEL,
      payload: data,
    });

    if (!this.#isLive(session)) {
      this.#report({
        code: "RTDS_STALE_CONNECTION_FRAME",
        detail: boundDetail(
          `frame arrived on retired connection ${session.connectionId} (generation ${String(session.generation)}); the feed is now ${
            this.#session === undefined
              ? "disconnected"
              : `on connection ${this.#session.connectionId} (generation ${String(this.#generation)})`
          }`,
        ),
        sourceChannel: RTDS_CHANNEL,
        observedIndex: 0,
        raw: data,
      });
      return;
    }
    this.#framesReceived += 1;
    this.#lastFrameAtIso = receivedAt;

    if (!session.subscribed) {
      this.#report({
        code: "RTDS_PRE_SUBSCRIPTION_FRAME",
        detail: boundDetail(
          `frame arrived on connection ${session.connectionId} before its subscribe frame was written (the session still holds generation ${String(session.generation)}); nothing had been subscribed, so this is not subscription data`,
        ),
        sourceChannel: RTDS_CHANNEL,
        observedIndex: 0,
        raw: data,
      });
      return;
    }

    const frame = decodeInboundRtdsFrame(data);
    if (frame.kind === "heartbeat-text") {
      this.#heartbeatTextFrames += 1;
      if (!session.heartbeatTextReported) {
        // Reported ONCE per connection, then counted. RTDS documents the client
        // sending `PING` and nothing coming back (RTDS-U2), so a bare
        // `PING`/`PONG` is an undocumented observation worth surfacing — but a
        // 5-second cadence of incidents would drown the real ones, and silently
        // consuming it would quietly invent a documented reply.
        session.heartbeatTextReported = true;
        this.#report({
          code: "RTDS_UNDOCUMENTED_HEARTBEAT_TEXT",
          detail: boundDetail(
            `connection ${session.connectionId} received the bare text frame "${frame.text}"; RTDS documents the client sending PING every 5 seconds and documents no server reply, so this frame's meaning is unverified. Reported once per connection; the rest are counted in metrics().heartbeatTextFramesReceived`,
          ),
          sourceChannel: RTDS_CHANNEL,
          observedIndex: 0,
          raw: data,
        });
      }
      return;
    }
    if (frame.kind === "unparsable") {
      this.#report({
        code: "RTDS_UNRECOGNIZED_FRAME",
        detail: boundDetail(frame.reason),
        sourceChannel: RTDS_CHANNEL,
        observedIndex: 0,
        raw: data,
      });
      return;
    }

    const normalized = normalizeRtdsFrame(frame.values, {
      sourceChannel: RTDS_CHANNEL,
      connectionId: session.connectionId,
      subscriptionGeneration: session.generation,
      subscribedTopics: this.#subscribedTopics,
      receivedEpochMs,
      tracker: this.#tracker,
    });
    this.#invalidPublisherTimestamps += normalized.invalidPublisherTimestamps;
    if (normalized.events.length > 0) {
      this.#observationsPublished += normalized.events.length;
      this.#lastObservationAtIso = receivedAt;
      this.#dataMarkMonotonicMs = this.#deps.clock.monotonicMs();
      this.#staleReported = false;
    }
    for (const event of normalized.events) {
      this.#handlers.onEvent(event);
    }
    for (const problem of normalized.problems) {
      this.#report(problem);
    }
  }

  #onError(session: RtdsSocketSession, error: unknown): void {
    // A dead socket's error is not the live connection's: attributing it would
    // relabel the next disconnect with a failure that happened on a socket
    // nobody is reading.
    if (!this.#isLive(session)) return;
    // The transport contract requires `onClose` after `onError`, so the
    // disconnect is emitted once, on close, with this reason attached.
    this.#closeReason = FEED_DISCONNECT_REASONS.transportError;
    this.#closeDetail = error instanceof Error ? error.message : String(error);
  }

  #onClose(session: RtdsSocketSession, info: PublicWebSocketCloseInfo): void {
    // A close for a socket this feed already let go reports nothing and
    // schedules nothing. Its disconnect was published when it was retired.
    if (!this.#isLive(session)) return;
    this.#stopTimers();
    this.#retireSession();
    const reason = this.#closeReason ?? FEED_DISCONNECT_REASONS.transportClosed;
    const detail = this.#closeDetail ?? describeClose(info);
    this.#emitDisconnected(session, reason, detail);
    this.#status = "idle";
    this.#scheduleReconnect();
  }

  #emitDisconnected(
    session: RtdsSocketSession,
    reason: FeedDisconnectReason,
    detail: string | undefined,
  ): void {
    this.#handlers.onEvent(
      rtdsFeedDisconnected({
        feedId: this.#options.feedId,
        connectionId: session.connectionId,
        disconnectedAt: this.#nowIso(),
        reasonCode: reason,
        ...(detail === undefined ? {} : { detail }),
      }),
    );
  }

  #scheduleReconnect(): void {
    if (this.#status === "stopped") return;
    if (this.#cancelReconnect !== undefined) return;
    const randomFraction = this.#deps.randomFraction?.() ?? 1;
    const delayMs = computeReconnectDelayMs(
      this.#reconnectAttempt,
      {
        baseMs: this.#options.reconnectBaseDelayMs,
        maximumMs: this.#options.reconnectMaximumDelayMs,
      },
      randomFraction,
    );
    this.#reconnectAttempt += 1;
    this.#cancelReconnect = this.#deps.timers.setTimeout(() => {
      this.#cancelReconnect = undefined;
      // A reconnect is owed only while the feed is still disconnected. A
      // `start()` during the backoff window already replaced it, and connecting
      // anyway would open a second socket over a live one.
      if (this.#status !== "idle" || this.#session !== undefined) return;
      this.#connect();
    }, delayMs);
  }

  // ---- heartbeat and staleness --------------------------------------------

  #startTimers(): void {
    this.#stopTimers();
    this.#cancelHeartbeat = this.#deps.timers.setInterval(() => {
      const session = this.#session;
      if (session === undefined) return;
      this.#heartbeatsSent += 1;
      this.#withSocket(session, (socket) => {
        socket.send(RTDS_HEARTBEAT_REQUEST);
      });
    }, this.#options.heartbeatIntervalMs);
    this.#cancelWatchdog = this.#deps.timers.setInterval(() => {
      this.#checkStaleness();
    }, this.#options.stalenessCheckIntervalMs);
  }

  #stopTimers(): void {
    this.#cancelHeartbeat?.();
    this.#cancelHeartbeat = undefined;
    this.#cancelWatchdog?.();
    this.#cancelWatchdog = undefined;
  }

  /**
   * DATA staleness, on this side only.
   *
   * There is no server heartbeat reply to wait for (RTDS-U2) and no documented
   * publication cadence to compare against (RTDS-U1) — the page says the
   * windows are "lookback windows, not publication cadences" and tells the
   * consumer to "define a freshness threshold" of its own. So this measures the
   * one thing the client can observe: how long it has been since an update was
   * published, against the operator's threshold. `FeedStale` is emitted once per
   * episode, not once per check.
   *
   * By default it does NOT close the socket, because a quiet feed and a dead one
   * are indistinguishable without a cadence, and closing on that evidence would
   * be inferring the cadence the page forbids inferring.
   */
  #checkStaleness(): void {
    if (this.#status !== "open") return;
    const stalenessMs = this.#deps.clock.monotonicMs() - this.#dataMarkMonotonicMs;
    if (stalenessMs <= this.#options.updateStalenessMs) return;
    const session = this.#session;
    if (!this.#staleReported) {
      this.#staleReported = true;
      this.#staleEpisodes += 1;
      this.#handlers.onEvent(
        rtdsFeedStale({
          feedId: this.#options.feedId,
          ...(session === undefined ? {} : { connectionId: session.connectionId }),
          detectedAt: this.#nowIso(),
          ...(this.#lastObservationAtIso === undefined
            ? {}
            : { lastMessageAt: this.#lastObservationAtIso }),
          stalenessMs,
        }),
      );
    }
    if (!this.#options.reconnectWhenStale) return;
    this.#closeReason = FEED_DISCONNECT_REASONS.staleConnection;
    this.#closeDetail = `no TWAP update for ${String(Math.round(stalenessMs))}ms`;
    this.#stopTimers();
    // Close and let the normal close path emit the disconnect and reconnect.
    if (session !== undefined) {
      this.#withSocket(session, (socket) => {
        socket.close();
      });
    }
  }

  // ---- helpers -------------------------------------------------------------

  #report(problem: RtdsProblem): void {
    this.#problemsReported += 1;
    this.#handlers.onProblem(problem);
  }

  /**
   * Opens a gap under a named generation.
   *
   * The generation is passed in rather than read from the field because it is
   * the gap's identity, and it must be the generation the transition that caused
   * the gap produced. A gap opened while one is already open supersedes it.
   */
  #openGapAt(
    reason: FeedGapReason,
    generation: number,
    previousGeneration: number,
    detail: string,
  ): void {
    const superseded = this.#gap;
    const connectionId = this.#session?.connectionId;
    const detectedAt = this.#nowIso();
    this.#gap = {
      reasonCode: reason,
      subscriptionGeneration: generation,
      previousSubscriptionGeneration: previousGeneration,
      connectionId,
      detectedAt,
      recoverableFromVenue: false,
      unrecoverableReason: "RTDS_NO_REPLAY_AFTER_DISCONNECT",
    };
    const supersededNote =
      superseded === undefined
        ? ""
        : `; supersedes the unacknowledged gap opened under generation ${String(superseded.subscriptionGeneration)}`;
    this.#handlers.onEvent(
      rtdsFeedGapDetected({
        feedId: this.#options.feedId,
        ...(connectionId === undefined ? {} : { connectionId }),
        detectedAt,
        reasonCode: reason,
        detail: `${detail}${supersededNote}`,
      }),
    );
  }

  #requireRunning(): void {
    if (this.#status === "stopped") {
      throw new PublicMarketStateError("the feed is stopped");
    }
  }

  #nowIso(): string {
    return new Date(this.#deps.clock.nowMs()).toISOString();
  }
}

function describeClose(info: PublicWebSocketCloseInfo): string | undefined {
  const parts: string[] = [];
  if (info.code !== undefined) parts.push(`code ${String(info.code)}`);
  if (info.reason !== undefined && info.reason !== "") parts.push(info.reason);
  return parts.length === 0 ? undefined : boundDetail(parts.join(": "));
}
