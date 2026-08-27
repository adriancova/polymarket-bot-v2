/**
 * Connection and reconnect manager.
 *
 * Owns exactly the three impure things the stream processor refuses to own: the
 * socket, the backoff timer, and the staleness timer. Everything it learns it
 * hands to the processor, and everything the processor produces it hands to one
 * sink callback. There is no second path out of this class.
 *
 * RECONNECT IS NEVER SILENT (ADR-002 §2.4). A replaced connection produces, in
 * order: `FeedDisconnected`, then `FeedConnected` on a NEW
 * `subscriptionGeneration`, then `FeedGapDetected` with
 * `requiresAuthoritativeSnapshot`, then a `DataQualityIncidentOpened` recording
 * that the trades missed while the socket was down are unrecoverable, and only
 * once the venue's own `snapshot` events have arrived on every declared channel,
 * `FeedResynchronized`. A consumer that watched only the socket would see a
 * reopened connection; a consumer that watches these events sees exactly what
 * was lost and exactly when it was safe to resume.
 *
 * A DETECTED GAP FORCES A NEW CONNECTION, NOT A RE-SUBSCRIBE. ADR-002 §2.4
 * requires a new authoritative snapshot after a gap, and the only *documented*
 * way to obtain one from this venue is a fresh subscription, whose first message
 * for a channel is a `snapshot` (`market-trades-shape`, `ticker-shape`). What a
 * second `subscribe` for an already-subscribed channel does on a live socket is
 * not documented, so this manager does not rely on it: it closes and reconnects.
 * `CoinbaseStreamProcessor.resubscribed()` exists for a caller that has its own
 * evidence and wants the cheaper path.
 *
 * BACKOFF IS DETERMINISTIC. No jitter, because jitter is unseeded randomness and
 * §12.4 makes runs reproducible; a fleet that needs jitter can supply a
 * {@link Timer} that adds it, which keeps the randomness at the composition
 * root. The default initial delay respects the documented limit of 8 connections
 * per second per IP (`rate-limits`) with a wide margin.
 *
 * NO CREDENTIAL. The only frames this manager sends are the documented public
 * subscribe frames, which carry no `jwt`.
 */

import type { CoinbaseAnomaly } from "./anomalies.js";
import { CoinbaseConfigurationError } from "./errors.js";
import type { CoinbaseFeedMetrics } from "./metrics.js";
import type {
  CoinbaseRawFrame,
  CoinbaseSocket,
  CoinbaseSocketFactory,
  MonotonicClock,
  Timer,
  TimerHandle,
  WallClock,
} from "./ports.js";
import {
  CoinbaseStreamProcessor,
  type CoinbaseFeedEvent,
  type CoinbaseProcessorOutput,
} from "./stream-processor.js";
import {
  buildSubscribeFrame,
  COINBASE_CHANNELS,
  COINBASE_MARKET_DATA_CHANNELS,
  COINBASE_PUBLIC_MARKET_DATA_ENDPOINT,
  type CoinbaseChannel,
} from "./venue-facts.js";
import type { CoinbaseNormalizedEvent } from "./normalize.js";

/** Deterministic exponential backoff bounds. */
export type CoinbaseBackoff = {
  /** Delay before the first reconnect attempt. */
  readonly initialDelayMs: number;
  /** Upper bound the delay never exceeds. */
  readonly maxDelayMs: number;
  /** Multiplier applied per consecutive failure. */
  readonly multiplier: number;
};

/**
 * Default backoff.
 *
 * 1000 ms initial is two orders of magnitude inside the documented
 * 8-connections-per-second-per-IP limit (`rate-limits`), so a reconnect storm
 * cannot turn a venue outage into a rate-limit ban.
 */
export const DEFAULT_COINBASE_BACKOFF: CoinbaseBackoff = {
  initialDelayMs: 1_000,
  maxDelayMs: 30_000,
  multiplier: 2,
};

/** Everything the manager produces, in the order the processor produced it. */
export type CoinbaseFeedOutput = {
  readonly normalized: readonly CoinbaseNormalizedEvent[];
  readonly feedEvents: readonly CoinbaseFeedEvent[];
  readonly anomalies: readonly CoinbaseAnomaly[];
};

export type CoinbaseConnectionManagerOptions = {
  readonly feedId: string;
  /** Venue-native product ids, for example `BTC-USD`. Passed through opaquely. */
  readonly productIds: readonly string[];
  /** Market-data channels to subscribe to. Defaults to `market_trades` and `ticker`. */
  readonly channels?: readonly CoinbaseChannel[];
  /**
   * Whether to also subscribe to `heartbeats`. Defaults to `true`.
   *
   * Strongly recommended and on by default: most channels close within 60-90
   * seconds without updates (`idle-close`), so an illiquid product's
   * subscription dies without it, and `heartbeat_counter` is the only signal
   * that detects loss during a quiet period.
   */
  readonly subscribeHeartbeats?: boolean;
  readonly endpoint?: string;
  readonly socketFactory: CoinbaseSocketFactory;
  readonly timer: Timer;
  readonly wallClock: WallClock;
  readonly monotonicClock: MonotonicClock;
  readonly backoff?: CoinbaseBackoff;
  readonly stalenessThresholdMs?: number;
  readonly tradeDedupeCapacity?: number;
  /** How often staleness is evaluated. Defaults to 1000 ms. */
  readonly stalenessPollIntervalMs?: number;
  /** Receives everything the processor produced. Called synchronously. */
  readonly onOutput: (output: CoinbaseFeedOutput) => void;
};

/** Default staleness evaluation interval, matching the 1-second heartbeat cadence. */
export const DEFAULT_STALENESS_POLL_INTERVAL_MS = 1_000;

type ManagerState = "IDLE" | "CONNECTING" | "OPEN" | "WAITING" | "STOPPED";

/** Owns the socket and the timers; delegates every judgement to the processor. */
export class CoinbaseConnectionManager {
  readonly #options: CoinbaseConnectionManagerOptions;
  readonly #processor: CoinbaseStreamProcessor;
  readonly #endpoint: string;
  readonly #channels: readonly CoinbaseChannel[];
  readonly #subscribeHeartbeats: boolean;
  readonly #backoff: CoinbaseBackoff;
  readonly #pollIntervalMs: number;

  #state: ManagerState = "IDLE";
  #socket: CoinbaseSocket | undefined;
  #reconnectTimer: TimerHandle | undefined;
  #pollTimer: TimerHandle | undefined;
  #connectionOrdinal = 0;
  #consecutiveFailures = 0;
  /** The most recent transport error, folded into the next close's detail. */
  #lastError: unknown;

  constructor(options: CoinbaseConnectionManagerOptions) {
    const backoff = options.backoff ?? DEFAULT_COINBASE_BACKOFF;
    assertBackoff(backoff);
    const pollIntervalMs = options.stalenessPollIntervalMs ?? DEFAULT_STALENESS_POLL_INTERVAL_MS;
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs <= 0) {
      throw new CoinbaseConfigurationError(
        "stalenessPollIntervalMs must be a positive safe integer of milliseconds",
        { stalenessPollIntervalMs: pollIntervalMs },
      );
    }
    const channels = options.channels ?? COINBASE_MARKET_DATA_CHANNELS;
    if (channels.length === 0) {
      throw new CoinbaseConfigurationError("at least one market-data channel is required", {});
    }
    if (options.productIds.length === 0) {
      throw new CoinbaseConfigurationError(
        "at least one product id is required; a market-data subscription with no products receives nothing",
        {},
      );
    }

    this.#options = options;
    this.#endpoint = options.endpoint ?? COINBASE_PUBLIC_MARKET_DATA_ENDPOINT;
    this.#channels = [...channels];
    this.#subscribeHeartbeats = options.subscribeHeartbeats ?? true;
    this.#backoff = backoff;
    this.#pollIntervalMs = pollIntervalMs;
    this.#processor = new CoinbaseStreamProcessor({
      feedId: options.feedId,
      endpoint: this.#endpoint,
      channels: this.#channels,
      ...(options.stalenessThresholdMs === undefined
        ? {}
        : { stalenessThresholdMs: options.stalenessThresholdMs }),
      ...(options.tradeDedupeCapacity === undefined
        ? {}
        : { tradeDedupeCapacity: options.tradeDedupeCapacity }),
      wallClock: options.wallClock,
      monotonicClock: options.monotonicClock,
    });
  }

  /** Health and staleness, as typed values. */
  metrics(): CoinbaseFeedMetrics {
    return this.#processor.metrics();
  }

  /** Consecutive failed connection attempts; resets when a connection opens. */
  get consecutiveFailures(): number {
    return this.#consecutiveFailures;
  }

  /** Opens the first connection and starts the staleness timer. */
  start(): void {
    if (this.#state !== "IDLE") {
      return;
    }
    this.#connect();
    this.#schedulePoll();
  }

  /** Stops permanently: no further reconnect is attempted. */
  stop(): void {
    this.#state = "STOPPED";
    this.#reconnectTimer?.cancel();
    this.#reconnectTimer = undefined;
    this.#pollTimer?.cancel();
    this.#pollTimer = undefined;
    const socket = this.#socket;
    this.#socket = undefined;
    socket?.close();
  }

  #connect(): void {
    if (this.#state === "STOPPED") {
      return;
    }
    this.#state = "CONNECTING";
    this.#connectionOrdinal += 1;
    const connectionId = `${this.#options.feedId}-c${String(this.#connectionOrdinal)}`;

    this.#socket = this.#options.socketFactory.connect(this.#endpoint, {
      onOpen: () => {
        if (this.#state === "STOPPED") {
          return;
        }
        this.#state = "OPEN";
        this.#consecutiveFailures = 0;
        // The generation is established before any frame can arrive, so every
        // event carries the generation it was actually received under.
        this.#emit(this.#processor.connectionOpened(connectionId));
        this.#sendSubscriptions();
      },
      onFrame: (frame: CoinbaseRawFrame) => {
        if (this.#state === "STOPPED") {
          return;
        }
        const result = this.#processor.ingestFrame(frame);
        this.#emit(result);
        if (result.requiresResubscription) {
          // A gap is open and no snapshot can arrive on this subscription.
          // Closing takes the normal disconnect path, which records the
          // disconnection and opens a new generation with fresh snapshots.
          this.#dropConnection();
        }
      },
      onError: (error: unknown) => {
        if (this.#state === "STOPPED") {
          return;
        }
        // The transport is expected to close after an error. The error is
        // recorded on the close, where it becomes the reason code's detail,
        // rather than emitted twice.
        this.#lastError = error;
      },
      onClose: (info) => {
        if (this.#state === "STOPPED") {
          return;
        }
        this.#socket = undefined;
        const detail = describeClose(info, this.#lastError);
        this.#lastError = undefined;
        if (this.#state === "CONNECTING") {
          // Never opened: there is no connection to report as disconnected, and
          // reporting one would put a `FeedDisconnected` in the record for a
          // connection that produced no `FeedConnected`.
          this.#consecutiveFailures += 1;
        } else {
          this.#emit(
            this.#processor.connectionClosed({
              reasonCode: "COINBASE_SOCKET_CLOSED",
              ...(detail === undefined ? {} : { detail }),
            }),
          );
          this.#consecutiveFailures += 1;
        }
        this.#scheduleReconnect();
      },
    });
  }

  #sendSubscriptions(): void {
    const socket = this.#socket;
    if (socket === undefined) {
      return;
    }
    // One channel per subscription message (`subscribe-within-5s`), and the
    // heartbeats channel takes no products (`heartbeats`).
    if (this.#subscribeHeartbeats) {
      socket.send(buildSubscribeFrame(COINBASE_CHANNELS.heartbeats, []));
    }
    for (const channel of this.#channels) {
      socket.send(buildSubscribeFrame(channel, this.#options.productIds));
    }
  }

  #dropConnection(): void {
    const socket = this.#socket;
    this.#socket = undefined;
    socket?.close();
  }

  #scheduleReconnect(): void {
    if (this.#state === "STOPPED") {
      return;
    }
    this.#state = "WAITING";
    const delay = backoffDelayMs(this.#backoff, this.#consecutiveFailures);
    this.#reconnectTimer?.cancel();
    this.#reconnectTimer = this.#options.timer.schedule(delay, () => {
      this.#reconnectTimer = undefined;
      this.#connect();
    });
  }

  #schedulePoll(): void {
    if (this.#state === "STOPPED") {
      return;
    }
    this.#pollTimer = this.#options.timer.schedule(this.#pollIntervalMs, () => {
      this.#pollTimer = undefined;
      if (this.#state === "STOPPED") {
        return;
      }
      const output = this.#processor.pollStaleness();
      this.#emit(output);
      if (output.feedEvents.length > 0 && this.#state === "OPEN") {
        // A stall the socket never reported. Coinbase closes idle channels
        // within 60-90 seconds (`idle-close`), so a connection that has gone
        // quiet past the bound is not a quiet market — it is a dead socket that
        // has not said so. Closing turns a silent stall into the recorded
        // disconnect/gap/resync sequence.
        this.#dropConnection();
      }
      this.#schedulePoll();
    });
  }

  #emit(output: CoinbaseProcessorOutput): void {
    if (
      output.normalized.length === 0 &&
      output.feedEvents.length === 0 &&
      output.anomalies.length === 0
    ) {
      return;
    }
    this.#options.onOutput({
      normalized: output.normalized,
      feedEvents: output.feedEvents,
      anomalies: output.anomalies,
    });
  }
}

/**
 * Delay before attempt number `consecutiveFailures`.
 *
 * Pure and exported so the schedule is testable without waiting for it.
 */
export function backoffDelayMs(backoff: CoinbaseBackoff, consecutiveFailures: number): number {
  const exponent = Math.max(0, consecutiveFailures - 1);
  const raw = backoff.initialDelayMs * Math.pow(backoff.multiplier, exponent);
  return Math.min(backoff.maxDelayMs, Math.round(raw));
}

function assertBackoff(backoff: CoinbaseBackoff): void {
  if (!Number.isSafeInteger(backoff.initialDelayMs) || backoff.initialDelayMs <= 0) {
    throw new CoinbaseConfigurationError("backoff.initialDelayMs must be a positive safe integer", {
      backoff,
    });
  }
  if (!Number.isSafeInteger(backoff.maxDelayMs) || backoff.maxDelayMs < backoff.initialDelayMs) {
    throw new CoinbaseConfigurationError(
      "backoff.maxDelayMs must be a safe integer not smaller than backoff.initialDelayMs",
      { backoff },
    );
  }
  if (!Number.isFinite(backoff.multiplier) || backoff.multiplier < 1) {
    throw new CoinbaseConfigurationError("backoff.multiplier must be a finite number of at least 1", {
      backoff,
    });
  }
}

function describeClose(
  info: { readonly code?: number; readonly reason?: string },
  lastError: unknown,
): string | undefined {
  const parts: string[] = [];
  if (info.code !== undefined) {
    parts.push(`close code ${String(info.code)}`);
  }
  if (info.reason !== undefined && info.reason.length > 0) {
    parts.push(`reason ${info.reason.slice(0, 200)}`);
  }
  if (lastError !== undefined) {
    parts.push(
      `transport error ${(lastError instanceof Error ? lastError.message : String(lastError)).slice(0, 200)}`,
    );
  }
  return parts.length === 0 ? undefined : parts.join("; ");
}
