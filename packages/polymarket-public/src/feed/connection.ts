/**
 * The public market feed: connection lifecycle, heartbeat, staleness, reconnect.
 *
 * Everything stateful in this package lives here, and everything it depends on
 * is injected — clock, timers, socket factory, connection-id factory, and the
 * market catalogue. There is no module-level mutable state, no `Date.now()`, no
 * `Math.random()`, and no `setTimeout` reached directly, so a whole connection
 * lifetime (connect, subscribe, heartbeat, go stale, drop, back off, reconnect,
 * resubscribe) runs in a unit test in microseconds with no network.
 *
 * ## What it emits, and why each one is an event rather than a log line
 *
 * | Transition | Event |
 * | --- | --- |
 * | socket opened, subscription sent | `FeedConnected` |
 * | opened again after a previous connection, with tokens subscribed | `FeedConnected` **and** `FeedGapDetected` |
 * | opened again with NOTHING subscribed | `FeedConnected` only — nothing was missed |
 * | no `PONG` within the window | `FeedStale`, then a disconnect if configured |
 * | socket closed, for any reason | `FeedDisconnected` |
 * | tokens ADDED to the subscription of a live connection | `FeedGapDetected` |
 * | caller acknowledged the gap's exact generation | `FeedResynchronized` |
 *
 * A gap is emitted on reconnect and on a subscription addition because in both
 * cases the server-side subscription state was replaced and anything published
 * meanwhile was not received. §7.1 makes the consequence unconditional: a new
 * authoritative snapshot is required before affected markets resume — which is
 * why a reconnect with NOTHING subscribed emits none: it replaced no
 * subscription and has no affected market to recover (invariant 4). This
 * adapter never emits `FeedResynchronized` on its own — reopening a socket is
 * not a recovery, and only the caller knows whether it applied a snapshot.
 *
 * ## Four invariants the reviews added, and what they mean here
 *
 * 1. **Every callback is bound to the socket session that installed it.** A
 *    transport can deliver a frame, an open, an error or a close for a socket
 *    this feed has already abandoned. Before the fix, such a callback was
 *    processed as if it belonged to the *current* connection: a frame from a
 *    dead socket was published stamped with the live `connectionId` and the live
 *    `subscriptionGeneration`, a stale `onOpen` advanced the generation and
 *    emitted a second `FeedConnected`, and a stale `onError` rewrote the live
 *    connection's disconnect reason. Every closure now captures an immutable
 *    {@link FeedSocketSession} token and does nothing unless that token is still
 *    the live one. A stale *message* is still recorded and reported — with the
 *    stale session's own identity — because §8.3 forbids dropping it silently.
 * 2. **A gap is closed only by an acknowledgement naming its exact
 *    generation.** `markResynchronized` used to emit `FeedResynchronized`
 *    unconditionally, so it could be called twice, called with no gap open at
 *    all, or called late — closing a NEWER generation's gap with a snapshot
 *    taken for an OLDER one. It now takes the acknowledged generation, matches
 *    it against the open gap, and returns a typed rejection instead of
 *    publishing a recovery that did not happen.
 * 3. **No socket-dependent action is dropped because the handle has not
 *    arrived.** A transport may call `onOpen` — or `onError`, or `onClose` —
 *    synchronously, from inside the factory call, before `#connect()` has
 *    anything to send on. Every such action is queued on the attempt's session
 *    and run the instant the handle is assigned, so the subscription really is
 *    written before `FeedConnected` is published, a `stop()` issued from inside
 *    a synchronous callback still closes the socket it could not yet see, and an
 *    overtaken attempt's socket is still closed rather than leaked (round-2
 *    finding H1: the synchronous case published `FeedConnected` having sent
 *    nothing).
 * 4. **Every gap this feed opens advances the generation in the same step, so
 *    gap generations are unique and strictly increasing.** That is what makes
 *    the generation a sufficient acknowledgement identity. The two gap-opening
 *    transitions are an addition pushed to a live connection and a full
 *    (re)subscription of a NON-EMPTY set; a reconnect with nothing subscribed
 *    resubscribes nothing, advances nothing, and therefore opens no gap
 *    (round-2 finding H2: it used to open one at the unchanged generation,
 *    which an acknowledgement written for the PREVIOUS gap then closed).
 *    The converse is deliberately not claimed: the generation may advance with
 *    no gap — on the first connection, and on a change made while disconnected
 *    — because in those cases nothing was missed.
 *
 * ## Credentials
 *
 * There are none. The market channel is public and unauthenticated; no header,
 * key, signature, or wallet is representable anywhere on this path.
 */

import type {
  MarketNormalizationContext} from "../normalize/market-events.js";
import {
  normalizeMarketEvents,
} from "../normalize/market-events.js";
import type {
  NormalizedPublicEventAny,
  PublicMarketProblem,
} from "../normalize/result.js";
import { boundDetail } from "../normalize/result.js";
import {
  MARKET_HEARTBEAT_REQUEST,
  MARKET_WEBSOCKET_CHANNEL,
  type PublicMarketFeedOptions,
  resolvePublicMarketFeedOptions,
} from "../config.js";
import { PublicMarketConfigurationError, PublicMarketStateError } from "../errors.js";
import type {
  CancelScheduled,
  PublicMarketClock,
  PublicMarketDirectory,
  PublicMarketTimers,
  PublicWebSocket,
  PublicWebSocketCloseInfo,
  PublicWebSocketFactory,
} from "../ports.js";
import { decodeInboundFrame } from "../venue/frames.js";
import {
  FEED_DISCONNECT_REASONS,
  FEED_GAP_REASONS,
  type FeedDisconnectReason,
  type FeedGapReason,
  feedConnected,
  feedDisconnected,
  feedGapDetected,
  feedResynchronized,
  feedStale,
} from "./signals.js";
import { MarketSubscriptionManager } from "./subscriptions.js";

/**
 * One inbound frame exactly as received.
 *
 * §9.1 requires raw frames to be preserved, and §8.3 forbids dropping them
 * silently. The feed hands every frame to the caller BEFORE parsing it, so a
 * frame that fails to parse is still recorded.
 */
export interface RawMarketFrame {
  readonly receivedAt: string;
  readonly connectionId: string;
  readonly subscriptionGeneration: number;
  readonly sourceChannel: string;
  /** The frame text, untouched. */
  readonly payload: string;
}

/** Where the feed delivers its output. */
export interface PublicMarketFeedHandlers {
  /** A normalized domain event: market data or feed health. */
  onEvent(event: NormalizedPublicEventAny): void;
  /** An inbound value that did not become an event. Never a silent drop. */
  onProblem(problem: PublicMarketProblem): void;
  /** Every inbound frame, before parsing, for the raw recorder. */
  onRawFrame?(frame: RawMarketFrame): void;
}

/** Everything the feed needs from the outside world. */
export interface PublicMarketFeedDependencies {
  readonly clock: PublicMarketClock;
  readonly timers: PublicMarketTimers;
  readonly webSocketFactory: PublicWebSocketFactory;
  readonly directory: PublicMarketDirectory;
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
   * `Math.random()`. `./runtime.ts` supplies the real one.
   */
  readonly randomFraction?: () => number;
}

/**
 * Reconnect backoff: full jitter over a capped exponential.
 *
 * `randomFraction() * min(base * 2 ** attempt, max)`, which is the official
 * SDK's own `reconnectDelay` at the pinned commit. The defaults for `base`
 * (250 ms) and `max` (30 s) are its constants too. Exported because a backoff
 * that cannot be tested is a backoff nobody has checked.
 */
export function computeReconnectDelayMs(
  attempt: number,
  options: { readonly baseMs: number; readonly maximumMs: number },
  randomFraction: number,
): number {
  const capped = Math.min(options.baseMs * 2 ** Math.max(0, attempt), options.maximumMs);
  const fraction = Number.isFinite(randomFraction)
    ? Math.min(Math.max(randomFraction, 0), 1)
    : 1;
  return Math.max(0, Math.round(fraction * capped));
}

type FeedStatus = "idle" | "connecting" | "open" | "stopped";

/**
 * One socket's whole life, as an identity every callback closure captures.
 *
 * The feed's *current* connection id and generation are mutable fields; a
 * callback that read them would attribute whatever it was handed to whichever
 * connection happens to be live at the moment it fires. This object is created
 * once per {@link PublicMarketFeed} connect attempt and handed to that attempt's
 * four callbacks, so each one can ask "am I still the live session?" and, when
 * the answer is no, report itself rather than mutate somebody else's state.
 */
interface FeedSocketSession {
  /** Minted once, before the socket exists. Never reassigned. */
  readonly connectionId: string;
  /** The socket this session owns; assigned immediately after the factory call. */
  socket: PublicWebSocket | undefined;
  /**
   * Socket-dependent work requested before the factory returned the handle.
   *
   * A transport that is already connected — a pooled or pre-opened socket, or a
   * test double — may call `onOpen` (or `onError`, or `onClose`) DURING the
   * factory call, while `socket` is still `undefined`. Anything that needs the
   * socket is queued here and run, in request order, the moment the handle is
   * assigned (round-2 finding H1). Empty for a transport that opens
   * asynchronously, which is every real one.
   */
  readonly deferred: SocketAction[];
  /**
   * The subscription generation this session is serving.
   *
   * Updated only while the session is live, and frozen at its last value the
   * moment the session is retired, so a late callback reports the generation it
   * actually arrived under rather than the one that replaced it.
   */
  generation: number;
  /** Set when the feed stops treating this session as the live one. */
  retired: boolean;
}

/** Something that can only be done once a session's socket handle exists. */
type SocketAction = (socket: PublicWebSocket) => void;

/** A gap that is open and still owed an authoritative snapshot. */
export interface OpenFeedGap {
  readonly reasonCode: FeedGapReason;
  /**
   * The generation the gap was opened under.
   *
   * This is the gap's identity, and it is unambiguous because every gap this
   * feed opens is opened by a transition that advances the generation in the
   * same step — an addition pushed to a live connection, or a full
   * (re)subscription of a non-empty set. Gap generations are therefore unique
   * and strictly increasing, so an acknowledgement naming a different one is
   * either stale or invented. A reconnect with nothing subscribed resubscribes
   * nothing and opens no gap, which is what keeps that true (round-2 H2).
   */
  readonly subscriptionGeneration: number;
  readonly connectionId: string | undefined;
  readonly detectedAt: string;
}

/**
 * The caller's assertion that it applied an authoritative snapshot.
 *
 * The generation is required and is checked: the adapter cannot observe that a
 * snapshot was applied, but it CAN observe that the snapshot the caller is
 * acknowledging was taken for a subscription that has since been replaced. It
 * carries no snapshot identifier because `FeedResynchronized` has no field to
 * publish one in, and accepting evidence it would then discard would be
 * theatre.
 */
export interface FeedResynchronizationAcknowledgement {
  readonly subscriptionGeneration: number;
}

/** Why an acknowledgement was refused. Stable `CodeString` values (§14.3). */
export const RESYNCHRONIZATION_REJECTIONS = {
  /** Nothing is owed: no gap is open, or one was already acknowledged. */
  noOpenGap: "NO_OPEN_GAP",
  /** The acknowledged generation is not the open gap's. */
  generationMismatch: "GENERATION_MISMATCH",
} as const;

export type ResynchronizationRejectionReason =
  (typeof RESYNCHRONIZATION_REJECTIONS)[keyof typeof RESYNCHRONIZATION_REJECTIONS];

/** What {@link PublicMarketFeed.markResynchronized} did. */
export type FeedResynchronizationOutcome =
  | {
      readonly status: "accepted";
      /** The generation the published `FeedResynchronized` recovers. */
      readonly subscriptionGeneration: number;
    }
  | {
      readonly status: "rejected";
      readonly reasonCode: ResynchronizationRejectionReason;
      readonly detail: string;
      /** The generation an acceptable acknowledgement would have named. */
      readonly expectedSubscriptionGeneration?: number;
    };

export class PublicMarketFeed {
  readonly #options: PublicMarketFeedOptions;
  readonly #deps: PublicMarketFeedDependencies;
  readonly #handlers: PublicMarketFeedHandlers;
  readonly #subscriptions: MarketSubscriptionManager;

  #status: FeedStatus = "idle";
  /** The live session, or `undefined` between connections. */
  #session: FeedSocketSession | undefined;
  #cancelHeartbeat: CancelScheduled | undefined;
  #cancelWatchdog: CancelScheduled | undefined;
  #cancelReconnect: CancelScheduled | undefined;
  #reconnectAttempt = 0;
  #hasConnectedBefore = false;
  #lastPongMonotonicMs = 0;
  #lastMessageAtIso: string | undefined;
  #staleReported = false;
  #gap: OpenFeedGap | undefined;
  #closeReason: FeedDisconnectReason | undefined;
  #closeDetail: string | undefined;

  constructor(
    dependencies: PublicMarketFeedDependencies,
    handlers: PublicMarketFeedHandlers,
    options: Partial<PublicMarketFeedOptions> = {},
  ) {
    this.#deps = dependencies;
    this.#handlers = handlers;
    this.#options = resolvePublicMarketFeedOptions(options);
    this.#subscriptions = new MarketSubscriptionManager({
      customFeatureEnabled: this.#options.customFeatureEnabled,
      initialDump: this.#options.initialDump,
      ...(this.#options.maximumAssetsPerSubscriptionFrame === undefined
        ? {}
        : { maximumAssetsPerFrame: this.#options.maximumAssetsPerSubscriptionFrame }),
    });
  }

  /** Tokens currently desired. */
  get assets(): readonly string[] {
    return this.#subscriptions.assets;
  }

  /** The current `subscriptionGeneration`. */
  get subscriptionGeneration(): number {
    return this.#subscriptions.generation;
  }

  /** Whether a gap is open and still awaiting an authoritative snapshot. */
  get isAwaitingSnapshot(): boolean {
    return this.#gap !== undefined;
  }

  /**
   * The open gap, when there is one.
   *
   * Exposed because a caller cannot acknowledge a gap it cannot name: the
   * acknowledgement is checked against
   * {@link OpenFeedGap.subscriptionGeneration}, so the caller reads it here,
   * fetches the snapshot, and acknowledges that generation.
   */
  get openGap(): OpenFeedGap | undefined {
    return this.#gap;
  }

  /** The connection id events are currently stamped with, if connected. */
  get connectionId(): string | undefined {
    return this.#session?.connectionId;
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
   * Adds tokens to the subscription.
   *
   * On a live connection this sends a dynamic `subscribe` frame and opens a
   * gap: the server-side asset set changed, so the caller owes an authoritative
   * snapshot for the affected markets before treating their books as current.
   */
  subscribe(tokenIds: readonly string[]): void {
    this.#requireRunning();
    const delta = this.#subscriptions.add(tokenIds);
    if (delta.added.length === 0) return;
    const session = this.#session;
    if (this.#status === "open" && session !== undefined) {
      this.#noteGeneration(delta.generation);
      this.#sendFrames(session, delta.frames);
      this.#openGapAt(
        FEED_GAP_REASONS.subscriptionReplaced,
        delta.generation,
        `subscribed ${String(delta.added.length)} token(s); generation ${String(delta.generation)}`,
      );
    }
  }

  /**
   * Removes tokens from the subscription.
   *
   * This does NOT advance the generation and does NOT open a gap, and the two
   * facts are the same fact: the venue's dynamic `unsubscribe` frame removes
   * the named assets and leaves the rest of the subscription in place, so
   * nothing was missed for anything still subscribed. Advancing the generation
   * without opening a gap — which is what this used to do — published a
   * generation change no consumer could account for; opening a gap instead
   * would demand an authoritative snapshot for markets whose stream never broke
   * (round-1 finding H2).
   */
  unsubscribe(tokenIds: readonly string[]): void {
    this.#requireRunning();
    const delta = this.#subscriptions.remove(tokenIds);
    if (delta.removed.length === 0) return;
    const session = this.#session;
    if (this.#status === "open" && session !== undefined) {
      this.#sendFrames(session, delta.frames);
    }
  }

  /**
   * Records that the caller applied an authoritative snapshot for a named gap.
   *
   * The caller asserts the recovery; this adapter cannot observe it. What it
   * CAN observe is whether anything is owed and whether the snapshot being
   * acknowledged belongs to the subscription that is still open, so both are
   * checked:
   *
   * - no open gap → `NO_OPEN_GAP`, and nothing is published. A second
   *   acknowledgement of the same gap lands here, which is what stops a
   *   duplicate `FeedResynchronized`.
   * - a generation other than the open gap's → `GENERATION_MISMATCH`. This is
   *   the race that matters: a snapshot fetched for generation N arriving after
   *   a reconnect or a subscription change opened generation N+1 would
   *   otherwise close the NEWER gap, publishing an authoritative-recovery
   *   signal for state nobody recovered.
   *
   * A rejection is returned rather than thrown: a late snapshot is a race, not
   * a defect, and the caller's correct response is to fetch a new one for
   * {@link PublicMarketFeed.openGap}.
   */
  markResynchronized(
    acknowledgement: FeedResynchronizationAcknowledgement,
  ): FeedResynchronizationOutcome {
    this.#requireRunning();
    const gap = this.#gap;
    if (gap === undefined) {
      return {
        status: "rejected",
        reasonCode: RESYNCHRONIZATION_REJECTIONS.noOpenGap,
        detail: boundDetail(
          `no gap is open, so there is no authoritative recovery to declare (acknowledged generation ${String(acknowledgement.subscriptionGeneration)})`,
        ),
      };
    }
    if (acknowledgement.subscriptionGeneration !== gap.subscriptionGeneration) {
      return {
        status: "rejected",
        reasonCode: RESYNCHRONIZATION_REJECTIONS.generationMismatch,
        detail: boundDetail(
          `the open gap was detected under subscription generation ${String(gap.subscriptionGeneration)}, not ${String(acknowledgement.subscriptionGeneration)}; a snapshot taken for another generation does not close it`,
        ),
        expectedSubscriptionGeneration: gap.subscriptionGeneration,
      };
    }
    this.#gap = undefined;
    const connectionId = this.#session?.connectionId ?? gap.connectionId;
    this.#handlers.onEvent(
      feedResynchronized({
        feedId: this.#options.feedId,
        ...(connectionId === undefined ? {} : { connectionId }),
        resynchronizedAt: this.#nowIso(),
        subscriptionGeneration: gap.subscriptionGeneration,
      }),
    );
    return { status: "accepted", subscriptionGeneration: gap.subscriptionGeneration };
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
      // socket that stays open after the feed is gone (round-2 H1).
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
    this.#status = "connecting";
    const connectionId = this.#deps.connectionId();
    if (typeof connectionId !== "string" || connectionId === "") {
      // `FeedConnected.connectionId` is required and non-empty, and it is the
      // §7.1 provenance chain's link between an event and the connection it
      // arrived on. An empty one is an injection defect, and it fails here
      // rather than by publishing a `FeedConnected` no consumer can trace.
      throw new PublicMarketConfigurationError(
        "the injected connectionId factory returned no identifier",
        { connectionId },
      );
    }
    this.#closeReason = undefined;
    this.#closeDetail = undefined;
    // The session is created BEFORE the socket, so the four closures below can
    // capture it. Each callback then belongs to exactly one socket for as long
    // as the process runs, whatever the feed does afterwards.
    const session: FeedSocketSession = {
      connectionId,
      socket: undefined,
      deferred: [],
      generation: this.#subscriptions.generation,
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
    // handle. Work queued for a session that has ALREADY been retired still runs,
    // because that is how an abandoned socket gets closed rather than leaked; the
    // queued open — the one action with something to decide — re-checks liveness
    // for itself and closes instead of connecting when it lost the race.
    const deferred = session.deferred.splice(0, session.deferred.length);
    for (const action of deferred) {
      action(socket);
    }
  }

  /**
   * Runs `action` on a session's socket, now or as soon as the handle exists.
   *
   * Every socket-dependent thing this feed does goes through here. Before
   * round-2 finding H1, `#onOpen` reached for `session.socket` directly: a
   * transport that called `onOpen` synchronously from inside the factory call
   * found it `undefined`, so the subscription frame was dropped — silently,
   * while `FeedConnected` was published anyway, leaving a feed that believed it
   * was subscribed to a socket that had been sent nothing.
   */
  #withSocket(session: FeedSocketSession, action: SocketAction): void {
    const socket = session.socket;
    if (socket === undefined) {
      session.deferred.push(action);
      return;
    }
    action(socket);
  }

  /**
   * Whether a callback's session is still the one this feed is driving.
   *
   * Everything a callback does — publishing an event, advancing a generation,
   * setting a close reason, restarting a timer — is gated on this.
   */
  #isLive(session: FeedSocketSession): boolean {
    return this.#status !== "stopped" && !session.retired && this.#session === session;
  }

  /** Detaches the live session so its callbacks stop being authoritative. */
  #retireSession(): FeedSocketSession | undefined {
    const session = this.#session;
    if (session === undefined) return undefined;
    session.retired = true;
    this.#session = undefined;
    return session;
  }

  /**
   * The socket opened — possibly before `#connect()` holds the handle.
   *
   * The whole open is deferred as one unit rather than only the send, so the
   * published order is the documented one in both cases: plan the subscription,
   * write it to the socket, then publish `FeedConnected`. A consumer therefore
   * never sees "connected" for a socket the subscription has not reached.
   */
  #onOpen(session: FeedSocketSession): void {
    this.#withSocket(session, () => {
      this.#handleOpen(session);
    });
  }

  #handleOpen(session: FeedSocketSession): void {
    if (!this.#isLive(session)) {
      // A socket this feed abandoned has opened. It is not ours to use and not
      // ours to leave running: closing it is the only state change here, and
      // its close callback will be ignored for the same reason this one is.
      // (Liveness is re-checked HERE, after any deferral, because the attempt
      // can be overtaken or stopped between the callback and the handle.)
      this.#withSocket(session, (socket) => {
        socket.close();
      });
      return;
    }
    this.#status = "open";
    this.#reconnectAttempt = 0;
    this.#staleReported = false;
    this.#lastPongMonotonicMs = this.#deps.clock.monotonicMs();

    const subscription = this.#subscriptions.planFullSubscription();
    session.generation = subscription.generation;
    this.#sendFrames(session, subscription.frames);

    this.#handlers.onEvent(
      feedConnected({
        feedId: this.#options.feedId,
        connectionId: session.connectionId,
        endpoint: this.#options.url,
        subscriptionGeneration: subscription.generation,
        connectedAt: this.#nowIso(),
      }),
    );

    if (this.#hasConnectedBefore && subscription.assets.length > 0) {
      // A reconnection replaced the server-side subscription state, so whatever
      // was published while the socket was down was not received. The feed is
      // connected AND in the gap state until the caller applies a snapshot.
      //
      // ...unless nothing is subscribed. Then there are no affected markets,
      // nothing was missed, and `planFullSubscription()` sent no frame and did
      // not advance the generation — so a gap opened here would carry the SAME
      // generation as the previous one, and an acknowledgement written for that
      // older gap would close this newer one (round-2 finding H2). Demanding an
      // authoritative snapshot for an empty subscription would also be the
      // round-1 H2 mistake in another costume.
      this.#openGapAt(
        FEED_GAP_REASONS.reconnected,
        subscription.generation,
        `reconnected as generation ${String(subscription.generation)}`,
      );
    }
    this.#hasConnectedBefore = true;
    this.#startTimers();
  }

  #onMessage(session: FeedSocketSession, data: string): void {
    const receivedAt = this.#nowIso();
    // The raw record is written for a stale frame too, and with the STALE
    // session's own identity: §9.1 wants the frame preserved, and preserving it
    // under the live connection's id would be a forged provenance chain.
    this.#handlers.onRawFrame?.({
      receivedAt,
      connectionId: session.connectionId,
      subscriptionGeneration: session.generation,
      sourceChannel: MARKET_WEBSOCKET_CHANNEL,
      payload: data,
    });

    if (!this.#isLive(session)) {
      // Not dropped (§8.3), not published as current data either: the frame
      // arrived on a subscription this feed no longer holds, so it is reported
      // with the evidence attached and the caller decides.
      this.#handlers.onProblem({
        code: "STALE_CONNECTION_FRAME",
        detail: boundDetail(
          `frame arrived on retired connection ${session.connectionId} (generation ${String(session.generation)}); the feed is now ${
            this.#session === undefined
              ? "disconnected"
              : `on connection ${this.#session.connectionId} (generation ${String(this.#subscriptions.generation)})`
          }`,
        ),
        sourceChannel: MARKET_WEBSOCKET_CHANNEL,
        observedIndex: 0,
        raw: data,
      });
      return;
    }
    this.#lastMessageAtIso = receivedAt;

    const frame = decodeInboundFrame(data);
    if (frame.kind === "pong") {
      this.#lastPongMonotonicMs = this.#deps.clock.monotonicMs();
      this.#staleReported = false;
      return;
    }
    if (frame.kind === "unparsable") {
      this.#handlers.onProblem({
        code: "UNRECOGNIZED_FRAME",
        detail: boundDetail(frame.reason),
        sourceChannel: MARKET_WEBSOCKET_CHANNEL,
        observedIndex: 0,
        raw: data,
      });
      return;
    }

    const context: MarketNormalizationContext = {
      directory: this.#deps.directory,
      sourceChannel: MARKET_WEBSOCKET_CHANNEL,
      connectionId: session.connectionId,
      subscriptionGeneration: session.generation,
    };
    const normalized = normalizeMarketEvents(frame.values, context);
    for (const event of normalized.events) {
      this.#handlers.onEvent(event);
    }
    for (const problem of normalized.problems) {
      this.#handlers.onProblem(problem);
    }
  }

  #onError(session: FeedSocketSession, error: unknown): void {
    // A dead socket's error is not the live connection's: attributing it would
    // relabel the next disconnect with a failure that happened on a socket
    // nobody is reading (round-1 finding H1).
    if (!this.#isLive(session)) return;
    // The transport contract requires `onClose` after `onError`, so the
    // disconnect is emitted once, on close, with this reason attached. Emitting
    // here as well would double-report one failure.
    this.#closeReason = FEED_DISCONNECT_REASONS.transportError;
    this.#closeDetail = error instanceof Error ? error.message : String(error);
  }

  #onClose(session: FeedSocketSession, info: PublicWebSocketCloseInfo): void {
    // A close for a socket this feed already let go — a second close, or the
    // close of a socket superseded by a reconnect — reports nothing and
    // schedules nothing. Its disconnect was published when it was retired.
    if (!this.#isLive(session)) return;
    this.#stopTimers();
    this.#retireSession();
    const reason = this.#closeReason ?? FEED_DISCONNECT_REASONS.transportClosed;
    const detail =
      this.#closeDetail ??
      describeClose(info);
    this.#emitDisconnected(session, reason, detail);
    this.#status = "idle";
    this.#scheduleReconnect();
  }

  #emitDisconnected(
    session: FeedSocketSession,
    reason: FeedDisconnectReason,
    detail: string | undefined,
  ): void {
    this.#handlers.onEvent(
      feedDisconnected({
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
      if (this.#status === "stopped") return;
      this.#connect();
    }, delayMs);
  }

  // ---- heartbeat and staleness --------------------------------------------

  #startTimers(): void {
    this.#stopTimers();
    this.#cancelHeartbeat = this.#deps.timers.setInterval(() => {
      const session = this.#session;
      if (session === undefined) return;
      this.#withSocket(session, (socket) => {
        socket.send(MARKET_HEARTBEAT_REQUEST);
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
   * Client-side staleness only.
   *
   * What the server does when a client misses a `PING` is undocumented (venue
   * item U-2), so nothing here models a server rule. This measures the one
   * thing the client can actually observe — how long it has been since a `PONG`
   * came back — and reports it as data. `FeedStale` is emitted once per
   * episode, not once per check, so a long outage does not flood the stream.
   */
  #checkStaleness(): void {
    if (this.#status !== "open") return;
    const stalenessMs = this.#deps.clock.monotonicMs() - this.#lastPongMonotonicMs;
    if (stalenessMs <= this.#options.pongTimeoutMs) return;
    const session = this.#session;
    if (!this.#staleReported) {
      this.#staleReported = true;
      this.#handlers.onEvent(
        feedStale({
          feedId: this.#options.feedId,
          ...(session === undefined ? {} : { connectionId: session.connectionId }),
          detectedAt: this.#nowIso(),
          ...(this.#lastMessageAtIso === undefined
            ? {}
            : { lastMessageAt: this.#lastMessageAtIso }),
          stalenessMs,
        }),
      );
    }
    if (!this.#options.reconnectWhenStale) return;
    this.#closeReason = FEED_DISCONNECT_REASONS.staleConnection;
    this.#closeDetail = `no PONG for ${String(Math.round(stalenessMs))}ms`;
    this.#stopTimers();
    // Close and let the normal close path emit the disconnect and reconnect.
    if (session !== undefined) {
      this.#withSocket(session, (socket) => {
        socket.close();
      });
    }
  }

  // ---- helpers -------------------------------------------------------------

  /** Records the generation the live session is serving. */
  #noteGeneration(generation: number): void {
    if (this.#session !== undefined) this.#session.generation = generation;
  }

  /**
   * Opens a gap under a named generation.
   *
   * The generation is passed in rather than read from the manager because it is
   * the gap's identity, and it must be the generation the transition that
   * caused the gap produced. A gap opened while one is already open supersedes
   * it: the newer one is what the caller now owes a snapshot for, and an
   * acknowledgement of the older one is refused with `GENERATION_MISMATCH`.
   */
  #openGapAt(reason: FeedGapReason, generation: number, detail: string): void {
    const superseded = this.#gap;
    const connectionId = this.#session?.connectionId;
    const detectedAt = this.#nowIso();
    this.#gap = {
      reasonCode: reason,
      subscriptionGeneration: generation,
      connectionId,
      detectedAt,
    };
    const supersededNote =
      superseded === undefined
        ? ""
        : `; supersedes the gap opened under generation ${String(superseded.subscriptionGeneration)}`;
    this.#handlers.onEvent(
      feedGapDetected({
        feedId: this.#options.feedId,
        ...(connectionId === undefined ? {} : { connectionId }),
        detectedAt,
        reasonCode: reason,
        detail: `${detail}${supersededNote}`,
      }),
    );
  }

  /**
   * Writes frames to a NAMED session's socket, never to "whatever is live".
   *
   * The session is a parameter rather than a read of `#session` for the same
   * reason every callback carries one, and the write goes through
   * {@link PublicMarketFeed.#withSocket} so a frame is never dropped merely
   * because the factory call had not returned the handle yet (round-2 H1).
   */
  #sendFrames(
    session: FeedSocketSession,
    frames: readonly Readonly<Record<string, unknown>>[],
  ): void {
    if (frames.length === 0) return;
    this.#withSocket(session, (socket) => {
      for (const frame of frames) {
        socket.send(JSON.stringify(frame));
      }
    });
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
