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
 * | opened again after a previous connection | `FeedConnected` **and** `FeedGapDetected` |
 * | no `PONG` within the window | `FeedStale`, then a disconnect if configured |
 * | socket closed, for any reason | `FeedDisconnected` |
 * | desired token set changed on a live connection | `FeedGapDetected` |
 * | caller applied an authoritative snapshot | `FeedResynchronized` (caller-driven) |
 *
 * A gap is emitted on reconnect and on a subscription change because in both
 * cases the server-side subscription state was replaced and anything published
 * meanwhile was not received. §7.1 makes the consequence unconditional: a new
 * authoritative snapshot is required before affected markets resume. This
 * adapter never emits `FeedResynchronized` on its own — reopening a socket is
 * not a recovery, and only the caller knows whether it applied a snapshot.
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

export class PublicMarketFeed {
  readonly #options: PublicMarketFeedOptions;
  readonly #deps: PublicMarketFeedDependencies;
  readonly #handlers: PublicMarketFeedHandlers;
  readonly #subscriptions: MarketSubscriptionManager;

  #status: FeedStatus = "idle";
  #socket: PublicWebSocket | undefined;
  #connectionId: string | undefined;
  #cancelHeartbeat: CancelScheduled | undefined;
  #cancelWatchdog: CancelScheduled | undefined;
  #cancelReconnect: CancelScheduled | undefined;
  #reconnectAttempt = 0;
  #hasConnectedBefore = false;
  #lastPongMonotonicMs = 0;
  #lastMessageAtIso: string | undefined;
  #staleReported = false;
  #gapOpen = false;
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
    return this.#gapOpen;
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
    if (this.#status === "open") {
      this.#sendFrames(delta.frames);
      this.#openGap(
        FEED_GAP_REASONS.subscriptionReplaced,
        `subscribed ${String(delta.added.length)} token(s); generation ${String(delta.generation)}`,
      );
    }
  }

  /** Removes tokens from the subscription. */
  unsubscribe(tokenIds: readonly string[]): void {
    this.#requireRunning();
    const delta = this.#subscriptions.remove(tokenIds);
    if (delta.removed.length === 0) return;
    if (this.#status === "open") {
      this.#sendFrames(delta.frames);
    }
  }

  /**
   * Records that the caller applied an authoritative snapshot.
   *
   * The caller asserts the recovery; this adapter cannot observe it. Calling
   * this without having applied a snapshot would publish a
   * `FeedResynchronized` that claims a recovery that did not happen, which the
   * contract's pinned `authoritativeSnapshotApplied: true` exists to prevent.
   */
  markResynchronized(): void {
    this.#requireRunning();
    this.#gapOpen = false;
    this.#handlers.onEvent(
      feedResynchronized({
        feedId: this.#options.feedId,
        ...(this.#connectionId === undefined ? {} : { connectionId: this.#connectionId }),
        resynchronizedAt: this.#nowIso(),
        subscriptionGeneration: this.#subscriptions.generation,
      }),
    );
  }

  /** Closes the feed for good. A stopped feed cannot be restarted. */
  stop(): void {
    if (this.#status === "stopped") return;
    const wasConnected = this.#status === "open" || this.#status === "connecting";
    this.#status = "stopped";
    this.#cancelReconnect?.();
    this.#cancelReconnect = undefined;
    this.#stopTimers();
    const socket = this.#socket;
    this.#socket = undefined;
    if (socket !== undefined) {
      socket.close();
    }
    if (wasConnected) {
      this.#emitDisconnected(FEED_DISCONNECT_REASONS.clientStopped, undefined);
    }
    this.#connectionId = undefined;
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
    this.#connectionId = connectionId;
    this.#closeReason = undefined;
    this.#closeDetail = undefined;
    this.#socket = this.#deps.webSocketFactory(this.#options.url, {
      onOpen: () => {
        this.#onOpen();
      },
      onMessage: (data) => {
        this.#onMessage(data);
      },
      onClose: (info) => {
        this.#onClose(info);
      },
      onError: (error) => {
        this.#onError(error);
      },
    });
  }

  #onOpen(): void {
    if (this.#status === "stopped") return;
    this.#status = "open";
    this.#reconnectAttempt = 0;
    this.#staleReported = false;
    this.#lastPongMonotonicMs = this.#deps.clock.monotonicMs();

    const subscription = this.#subscriptions.planFullSubscription();
    this.#sendFrames(subscription.frames);

    this.#handlers.onEvent(
      feedConnected({
        feedId: this.#options.feedId,
        connectionId: this.#connectionId ?? "unknown",
        endpoint: this.#options.url,
        subscriptionGeneration: subscription.generation,
        connectedAt: this.#nowIso(),
      }),
    );

    if (this.#hasConnectedBefore) {
      // A reconnection replaced the server-side subscription state, so whatever
      // was published while the socket was down was not received. The feed is
      // connected AND in the gap state until the caller applies a snapshot.
      this.#openGap(
        FEED_GAP_REASONS.reconnected,
        `reconnected as generation ${String(subscription.generation)}`,
      );
    }
    this.#hasConnectedBefore = true;
    this.#startTimers();
  }

  #onMessage(data: string): void {
    if (this.#status === "stopped") return;
    const receivedAt = this.#nowIso();
    this.#lastMessageAtIso = receivedAt;

    this.#handlers.onRawFrame?.({
      receivedAt,
      connectionId: this.#connectionId ?? "unknown",
      subscriptionGeneration: this.#subscriptions.generation,
      sourceChannel: MARKET_WEBSOCKET_CHANNEL,
      payload: data,
    });

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
      ...(this.#connectionId === undefined ? {} : { connectionId: this.#connectionId }),
      subscriptionGeneration: this.#subscriptions.generation,
    };
    const normalized = normalizeMarketEvents(frame.values, context);
    for (const event of normalized.events) {
      this.#handlers.onEvent(event);
    }
    for (const problem of normalized.problems) {
      this.#handlers.onProblem(problem);
    }
  }

  #onError(error: unknown): void {
    // The transport contract requires `onClose` after `onError`, so the
    // disconnect is emitted once, on close, with this reason attached. Emitting
    // here as well would double-report one failure.
    this.#closeReason = FEED_DISCONNECT_REASONS.transportError;
    this.#closeDetail = error instanceof Error ? error.message : String(error);
  }

  #onClose(info: PublicWebSocketCloseInfo): void {
    if (this.#status === "stopped") return;
    this.#stopTimers();
    this.#socket = undefined;
    const reason = this.#closeReason ?? FEED_DISCONNECT_REASONS.transportClosed;
    const detail =
      this.#closeDetail ??
      describeClose(info);
    this.#emitDisconnected(reason, detail);
    this.#status = "idle";
    this.#scheduleReconnect();
  }

  #emitDisconnected(reason: FeedDisconnectReason, detail: string | undefined): void {
    this.#handlers.onEvent(
      feedDisconnected({
        feedId: this.#options.feedId,
        ...(this.#connectionId === undefined ? {} : { connectionId: this.#connectionId }),
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
      this.#socket?.send(MARKET_HEARTBEAT_REQUEST);
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
    if (!this.#staleReported) {
      this.#staleReported = true;
      this.#handlers.onEvent(
        feedStale({
          feedId: this.#options.feedId,
          ...(this.#connectionId === undefined ? {} : { connectionId: this.#connectionId }),
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
    const socket = this.#socket;
    this.#stopTimers();
    // Close and let the normal close path emit the disconnect and reconnect.
    socket?.close();
  }

  // ---- helpers -------------------------------------------------------------

  #openGap(reason: (typeof FEED_GAP_REASONS)[keyof typeof FEED_GAP_REASONS], detail: string): void {
    this.#gapOpen = true;
    this.#handlers.onEvent(
      feedGapDetected({
        feedId: this.#options.feedId,
        ...(this.#connectionId === undefined ? {} : { connectionId: this.#connectionId }),
        detectedAt: this.#nowIso(),
        reasonCode: reason,
        detail,
      }),
    );
  }

  #sendFrames(frames: readonly Readonly<Record<string, unknown>>[]): void {
    const socket = this.#socket;
    if (socket === undefined) return;
    for (const frame of frames) {
      socket.send(JSON.stringify(frame));
    }
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
