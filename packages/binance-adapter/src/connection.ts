/**
 * The socket contract this adapter is driven by, and the reconnect policy.
 *
 * THE ADAPTER OWNS NO TIMER AND NO SOCKET. `BinanceReferenceFeed` is a state
 * machine over (socket events, receipt stamps): the caller creates the socket,
 * feeds events in, and is told — as a returned value — when to reconnect. Two
 * reasons, both structural rather than stylistic:
 *
 * 1. **Determinism.** Handoff §12.4 and §6 invariant 15 require a recorded run
 *    to be replayable in the order information actually arrived. A component
 *    that schedules its own reconnect with `setTimeout` and stamps its own
 *    frames with `Date.now()` cannot be replayed; one that is *driven* can be
 *    replayed by feeding it the recorded events and the recorded stamps.
 * 2. **One place owns scheduling.** The gateway (`WP-120`) owns bounded queues
 *    and the process lifecycle. Two independent schedulers — one in the gateway,
 *    one hidden in each adapter — is how a shutdown ends up racing a reconnect.
 *
 * WHAT THE TRANSPORT MUST DO, stated here because this package cannot enforce it:
 *
 * - **Answer the venue's heartbeat.** "The WebSocket server will send a `ping
 *   frame` every 20 seconds… If the WebSocket server does not receive a `pong
 *   frame` back from the connection within a minute the connection will be
 *   disconnected" (`web-socket-streams.md`, accessed 2026-08-27). These are
 *   RFC 6455 control frames, and §5.5.2 of that RFC already requires an endpoint
 *   to answer a Ping with a Pong, so every conforming client library does it
 *   automatically and application code never sees them. That is the *difference*
 *   from the Polymarket CLOB channels, whose `PING`/`PONG` are application text
 *   frames the WAL stores verbatim (ADR-004 §1).
 * - **Stamp every event with the identity of the socket that produced it**, taken
 *   from the {@link BinanceSocketRequest} that created that socket and never
 *   from any later state. A transport that reports a retired socket's close
 *   without its identity makes that close indistinguishable from the live
 *   socket's, and the feed would then tear down a healthy connection.
 * - **Deliver each message as one string.** The frame opcode on the JSON stream
 *   endpoint is not documented (`BNC-U1`), so a transport that receives a binary
 *   frame must decode it as UTF-8 and deliver the string; if it cannot decode
 *   it, it must report an `ERROR` event rather than deliver a mangled frame.
 * - **Carry no credential.** Every endpoint this package accepts is public
 *   market data (`./venue.ts`). A transport must not add an `X-MBX-APIKEY`
 *   header, a signature, or any other authentication material.
 */

import { BinanceConfigurationError } from "./errors.js";
import { BINANCE_LIMITS } from "./venue.js";

/** Lifecycle of one feed. */
export type FeedConnectionState =
  /** Constructed; no connection attempted yet. */
  | "IDLE"
  /** A connection attempt is in flight. */
  | "CONNECTING"
  /** The socket is open and frames may arrive. */
  | "OPEN"
  /** Deliberately closed by the caller; no further reconnect is directed. */
  | "CLOSED";

/** Maximum accepted length of a caller-supplied connection id. */
export const MAX_CONNECTION_ID_LENGTH = 100;

/**
 * Whether a value can serve as a socket identity.
 *
 * Bounded because the identity is copied onto `FeedConnected.connectionId` and
 * into derived incident ids, both of which the frozen domain contract bounds.
 */
export function isWellFormedConnectionId(value: string): boolean {
  return value.length > 0 && value.length <= MAX_CONNECTION_ID_LENGTH;
}

/**
 * Events the transport reports to the feed.
 *
 * EVERY EVENT CARRIES THE IDENTITY OF THE SOCKET THAT PRODUCED IT, and the
 * identity is the one fixed when that socket was requested — never "whichever
 * connection is current now". A socket that has been superseded or closed can
 * still deliver a buffered message, an error, or its close event *after* its
 * replacement is live; without an immutable identity on the event itself, the
 * feed would relabel that traffic as the new connection's (recording a trade
 * under a generation it never belonged to) and would let a dead socket's close
 * tear down the live one. Identity therefore travels with the event, and
 * `BinanceReferenceFeed` rejects anything that did not come from the socket it
 * is currently listening to (WP-080 round-1 review, finding H1).
 */
export type BinanceSocketEvent =
  | { readonly type: "OPEN"; readonly connectionId: string }
  | { readonly type: "MESSAGE"; readonly connectionId: string; readonly data: string }
  | {
      readonly type: "ERROR";
      readonly connectionId: string;
      readonly reasonCode?: string;
      readonly detail?: string;
    }
  | {
      readonly type: "CLOSE";
      readonly connectionId: string;
      readonly code?: number;
      readonly reason?: string;
    };

/**
 * How a socket identity relates to what the feed is currently listening to.
 *
 * Deliberately a statement about KNOWLEDGE rather than about intent: the feed
 * knows which socket is live and which identities it has retired, and nothing
 * else. `UNKNOWN` is not an error by itself — a connection attempt that fails
 * before it ever opens reports its error and close under an identity the feed
 * has never seen live — so the acceptance rule combines the relation with the
 * event type (see `BinanceReferenceFeed`).
 */
export type ConnectionIdentityRelation =
  /** The identity of the socket the feed is currently listening to. */
  | "LIVE"
  /** An identity that was live and has since been superseded or closed. */
  | "RETIRED"
  /** An identity the feed has never seen live: a pending or foreign socket. */
  | "UNKNOWN"
  /** Not a well-formed connection id at all. */
  | "INVALID";

/** The minimal handle the feed needs on a live socket. */
export type BinanceSocket = {
  close(code?: number, reason?: string): void;
};

/**
 * What a transport is asked to open.
 *
 * `connectionId` is supplied by the caller rather than minted by the transport
 * so that identity comes from one place — the composition root that also records
 * it — and so no part of this package reads unseeded randomness (§12.4).
 */
export type BinanceSocketRequest = {
  readonly url: string;
  readonly connectionId: string;
  readonly onEvent: (event: BinanceSocketEvent) => void;
};

/** Opens a socket for a URL and routes its events to the feed. */
export type BinanceSocketFactory = (request: BinanceSocketRequest) => BinanceSocket;

/**
 * Deterministic exponential backoff.
 *
 * NO JITTER, DELIBERATELY. Jitter needs randomness, and an adapter that reads
 * unseeded entropy stops being replayable (§12.4). A caller that wants jitter
 * adds it from its own seeded source, where the seed is recorded in the run
 * manifest. The trade is stated rather than hidden: several feeds reconnecting
 * from the same process will retry in lockstep.
 */
export type ReconnectPolicy = {
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly multiplier: number;
  /** `undefined` means retry indefinitely. */
  readonly maxAttempts?: number;
};

/**
 * The default policy, with the one number that is a venue fact called out.
 *
 * `initialDelayMs` is 1000 because "There is a limit of **300 connections per
 * attempt every 5 minutes per IP**" (`web-socket-streams.md`) — 300 attempts in
 * 300 seconds is one per second, so a one-second floor keeps a single feed inside
 * the documented budget even in a tight reconnect loop. The growth factor and the
 * 60-second ceiling are ordinary engineering choices, not venue facts.
 */
export const DEFAULT_RECONNECT_POLICY: ReconnectPolicy = {
  initialDelayMs: 1_000,
  maxDelayMs: 60_000,
  multiplier: 2,
};

/** The documented connection budget, expressed as a minimum average spacing. */
export const MIN_AVERAGE_RECONNECT_SPACING_MS = Math.ceil(
  (5 * 60 * 1000) / BINANCE_LIMITS.maxConnectionAttemptsPer5Minutes,
);

/** Validates a policy, failing closed on anything that could produce a hot loop. */
export function assertReconnectPolicy(policy: ReconnectPolicy): void {
  if (!Number.isSafeInteger(policy.initialDelayMs) || policy.initialDelayMs < 0) {
    throw new BinanceConfigurationError(
      `reconnect initialDelayMs must be a non-negative safe integer, received ${String(policy.initialDelayMs)}`,
    );
  }
  if (!Number.isSafeInteger(policy.maxDelayMs) || policy.maxDelayMs < policy.initialDelayMs) {
    throw new BinanceConfigurationError(
      "reconnect maxDelayMs must be a safe integer no smaller than initialDelayMs",
      { initialDelayMs: policy.initialDelayMs, maxDelayMs: policy.maxDelayMs },
    );
  }
  if (!Number.isFinite(policy.multiplier) || policy.multiplier < 1) {
    throw new BinanceConfigurationError(
      `reconnect multiplier must be a finite number of at least 1, received ${String(policy.multiplier)}`,
    );
  }
  if (
    policy.maxAttempts !== undefined &&
    (!Number.isSafeInteger(policy.maxAttempts) || policy.maxAttempts < 1)
  ) {
    throw new BinanceConfigurationError(
      `reconnect maxAttempts must be a positive safe integer when set, received ${String(policy.maxAttempts)}`,
    );
  }
}

/**
 * Delay before reconnect attempt `attempt` (1-based).
 *
 * Pure, so the backoff curve is unit-tested without a clock.
 */
export function nextReconnectDelayMs(attempt: number, policy: ReconnectPolicy): number {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new BinanceConfigurationError(
      `attempt must be a positive safe integer, received ${String(attempt)}`,
    );
  }
  const raw = policy.initialDelayMs * Math.pow(policy.multiplier, attempt - 1);
  if (!Number.isFinite(raw)) {
    return policy.maxDelayMs;
  }
  return Math.min(policy.maxDelayMs, Math.round(raw));
}

/**
 * What the caller should do next with the socket.
 *
 * Returned rather than acted upon — see the module header.
 */
export type ConnectionDirective =
  /** Nothing to do: the connection is fine, or one is already in flight. */
  | { readonly kind: "NONE" }
  /** Open a new connection after the delay; `attempt` is 1-based. */
  | { readonly kind: "RECONNECT_AFTER"; readonly delayMs: number; readonly attempt: number }
  /**
   * Stop. Either the caller closed the feed, or `maxAttempts` was exhausted.
   *
   * `reason` distinguishes those two, because "the operator stopped it" and "the
   * venue is unreachable and we gave up" need different operator responses.
   */
  | { readonly kind: "STOP"; readonly reason: "CLOSED_BY_CALLER" | "RECONNECT_ATTEMPTS_EXHAUSTED" };

export const NO_DIRECTIVE: ConnectionDirective = { kind: "NONE" };
