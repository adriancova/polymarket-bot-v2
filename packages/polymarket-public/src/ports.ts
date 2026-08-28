/**
 * Injected ports.
 *
 * Nothing in this package reads a clock, opens a socket, performs an HTTP
 * request, or invents an identifier directly: every one of those arrives
 * through a port (handoff §12.1, §12.4). That is what lets the whole adapter be
 * tested offline, deterministically, with no network — and what keeps the
 * identity and versioning authority where it belongs.
 *
 * `./runtime.ts` holds the only implementations that touch a global, and
 * nothing else in this package imports it.
 */

import type {
  ConditionId,
  InternalMarketId,
  TokenId,
} from "@polymarket-bot/domain";

/**
 * Time source.
 *
 * `nowMs` supplies the wall-clock instants written into event payloads;
 * `monotonicMs` drives every *interval* decision (heartbeat cadence, staleness,
 * reconnect backoff) so that an NTP step cannot make a healthy feed look stale
 * or a stale one look healthy.
 */
export interface PublicMarketClock {
  /** Wall-clock milliseconds since the Unix epoch. */
  nowMs(): number;
  /** Monotonic milliseconds from an arbitrary origin. */
  monotonicMs(): number;
}

/** A scheduled callback, cancellable. */
export type CancelScheduled = () => void;

/**
 * Timer source, separated from the clock so a test can run a feed's whole
 * lifecycle without real time passing.
 */
export interface PublicMarketTimers {
  setTimeout(handler: () => void, delayMs: number): CancelScheduled;
  setInterval(handler: () => void, intervalMs: number): CancelScheduled;
}

/** Why a socket closed, as the transport reports it. */
export interface PublicWebSocketCloseInfo {
  readonly code?: number;
  readonly reason?: string;
}

/** Callbacks a socket implementation drives. */
export interface PublicWebSocketHandlers {
  onOpen(): void;
  /** One inbound text frame, exactly as received. Never pre-parsed. */
  onMessage(data: string): void;
  onClose(info: PublicWebSocketCloseInfo): void;
  onError(error: unknown): void;
}

/** The minimal socket surface this adapter needs. */
export interface PublicWebSocket {
  send(data: string): void;
  close(): void;
}

/**
 * Opens a socket to a public endpoint.
 *
 * The URL is always a public, unauthenticated one; there is no headers or
 * credentials parameter anywhere in this interface, by design.
 */
export type PublicWebSocketFactory = (
  url: string,
  handlers: PublicWebSocketHandlers,
) => PublicWebSocket;

/** A public HTTP response, already read as text. */
export interface PublicHttpResponse {
  readonly status: number;
  readonly body: string;
}

/** A public HTTP request. No authentication header is representable here. */
export interface PublicHttpRequest {
  readonly url: string;
  readonly method: "GET" | "POST";
  readonly jsonBody?: unknown;
  readonly signal?: AbortSignal;
}

/** Minimal HTTP surface for the REST snapshot reads. */
export type PublicHttpClient = (request: PublicHttpRequest) => Promise<PublicHttpResponse>;

/**
 * What the catalogue knows about one market.
 *
 * `InternalMarketId` is a UUIDv7 minted by the Universe Service (`WP-110`,
 * §9.2), never by an adapter: a market's identity outlives any one feed
 * connection, and two adapters minting ids for the same condition id would
 * fork the catalogue.
 */
export interface PublicMarketIdentity {
  readonly internalMarketId: InternalMarketId;
  readonly conditionId: ConditionId;
  /** Both outcome tokens, which §9.2 requires the catalogue to store. */
  readonly yesTokenId: TokenId;
  readonly noTokenId: TokenId;
}

/** A market announcement observed on the wire, before the catalogue judges it. */
export interface ObservedNewMarket {
  /** The venue's own market id (`new_market.id`), unnormalized. */
  readonly venueMarketId: string;
  readonly conditionId: string;
  readonly question?: string;
  readonly slug?: string;
  /** `assets_ids`, normalized to canonical token ids, in wire order. */
  readonly tokenIds: readonly TokenId[];
  /** `outcomes`, in wire order. The adapter does NOT pair these with tokens. */
  readonly outcomes: readonly string[];
  /**
   * The venue's own timestamp, when it sent one.
   *
   * Optional because the SDK types every market-channel `timestamp` as
   * `.nullish()`; an absent one is absent, not an epoch zero.
   */
  readonly observedAt?: string;
}

/**
 * The catalogue's answer to a market announcement.
 *
 * The catalogue decides which token is YES: the venue publishes `assets_ids`
 * and `outcomes` as two arrays and documents no pairing rule between them, so
 * an adapter that matched them by index would be asserting venue behaviour
 * nobody has verified.
 */
export interface DiscoveredMarketRegistration {
  readonly identity: PublicMarketIdentity;
  /** §9.2 versions market metadata on every change; the catalogue owns the counter. */
  readonly metadataVersion: number;
  /** Stable series grouping such as `btc-15m-updown` (§9.2), when the catalogue assigns one. */
  readonly seriesId?: string;
}

/** A tick-size change observed on the wire, with both values as sent. */
export interface ObservedTickSizeChange {
  readonly identity: PublicMarketIdentity;
  readonly tokenId: TokenId;
  /** Canonical decimal, absent when the venue sent none. */
  readonly previousTickSize?: string;
  /** Canonical decimal. Required by the venue schema. */
  readonly tickSize: string;
  /** The venue's own timestamp, when it sent one. */
  readonly observedAt?: string;
}

/**
 * The catalogue's versioning of an observed parameter change.
 *
 * `TradingParametersChanged` carries a monotonic `parametersVersion` and an
 * opaque `parameterVersionRef` addressing the authoritative snapshot (ADR-002
 * §6). Both are catalogue state. An adapter that invented them would publish an
 * ordinal that means nothing and a handle that dereferences to nothing.
 */
export interface TradingParameterVersionAssignment {
  readonly parametersVersion: number;
  readonly previousParametersVersion?: number;
  readonly parameterVersionRef: string;
}

/**
 * The catalogue surface this adapter depends on.
 *
 * Three questions, all of which have exactly one right answer-holder — the
 * Universe Service — and none of which a wire parser may answer for itself.
 * Every method may return `undefined`, which becomes a reported problem rather
 * than a guess.
 */
export interface PublicMarketDirectory {
  /** Resolves a canonical token id to its market, or `undefined` if unknown. */
  identityForToken(tokenId: TokenId): PublicMarketIdentity | undefined;
  /** Registers a newly announced market and returns its assigned identity. */
  registerDiscoveredMarket(
    observation: ObservedNewMarket,
  ): DiscoveredMarketRegistration | undefined;
  /** Versions an observed trading-parameter change. */
  assignTradingParameterVersion(
    change: ObservedTickSizeChange,
  ): TradingParameterVersionAssignment | undefined;
}
