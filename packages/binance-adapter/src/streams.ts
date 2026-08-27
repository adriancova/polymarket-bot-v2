/**
 * Stream names and connection URLs, built exactly as the venue documents them.
 *
 * Citations (all `web-socket-streams.md`, "General WSS information", accessed
 * 2026-08-27):
 *
 * - "Raw streams are accessed at `/ws/<streamName>`"
 * - "Combined streams are accessed at
 *   `/stream?streams=<streamName1>/<streamName2>/<streamName3>`"
 * - "Combined stream events are wrapped as follows:
 *   `{"stream":"<streamName>","data":<rawPayload>}`"
 * - "All symbols for streams are **lowercase**"
 * - "A single connection can listen to a maximum of 1024 streams."
 *
 * (The venue page bolds the path fragments; the bold markers are dropped in the
 * first three quotations because a literal `**` before a `/` would end this
 * comment block.)
 *
 * WHY THIS PACKAGE ALWAYS BUILDS A COMBINED URL. A `<symbol>@bookTicker` payload
 * carries no event-type field at all — the documented payload is exactly `u`,
 * `s`, `b`, `B`, `a`, `A` — so on a raw multi-stream connection the originating
 * stream can only be *inferred* from the payload's shape. The combined wrapper
 * states it, which is what `sourceChannel` (§7.1) records and what makes routing
 * a fact rather than a guess. The decoder still accepts unwrapped frames (a
 * caller may point it at a raw endpoint), and reconstructs the channel name from
 * the documented `s` field; that reconstruction is stated, not hidden.
 *
 * SYMBOL VALIDATION IS HYGIENE, NOT A VENUE CLAIM. The venue does not publish a
 * symbol grammar, and it explicitly contemplates non-ASCII symbols ("If your
 * request contains a symbol name containing non-ASCII characters, then the
 * stream events may contain non-ASCII characters encoded in UTF-8"). So the
 * check here rejects only what would break the URL or the stream-name grammar
 * itself — separators, whitespace, control characters — and bounds the length.
 * Narrowing further would refuse symbols the venue may legitimately list.
 */

import { BinanceConfigurationError } from "./errors.js";
import {
  BINANCE_COMBINED_STREAM_PATH,
  BINANCE_DEFAULT_ENDPOINT,
  BINANCE_DEFAULT_TIME_UNIT,
  BINANCE_LIMITS,
  BINANCE_RAW_STREAM_PATH,
  BINANCE_STREAM_SUFFIXES,
  BINANCE_TIME_UNIT_QUERY_PARAM,
  explainNonPublicEndpoint,
  type BinanceStreamSuffix,
  type BinanceTimeUnit,
} from "./venue.js";

/** Upper bound on a symbol, matching the domain's identifier bound (§7.2 hygiene). */
export const MAX_SYMBOL_LENGTH = 64;

/**
 * Characters that would break the URL or the stream-name grammar.
 *
 * Structural characters, whitespace, and the Unicode control category. A
 * hyphen, a digit, or a non-ASCII letter is deliberately absent: none of them
 * breaks a stream name or a query value, and refusing one would refuse a symbol
 * the venue may legitimately list — the venue explicitly contemplates non-ASCII
 * symbol names.
 */
const STRUCTURAL_CHARACTERS = /[\s\p{Cc}"'<>{}|^\\/?#@&=%[\]`]/u;

/** One subscribed stream: a venue symbol and one of the two in-scope suffixes. */
export type BinanceStreamSubscription = {
  /** Venue-native symbol as the caller knows it, in any case (`BTCUSDT`, `btcusdt`). */
  readonly symbol: string;
  readonly suffix: BinanceStreamSuffix;
};

/** A subscription plus its documented lowercase stream name. */
export type ResolvedStreamSubscription = BinanceStreamSubscription & {
  /** `"<lowercase symbol>@<suffix>"`, the exact form the venue documents. */
  readonly streamName: string;
};

/** Rejects a symbol that cannot appear in a stream name or a URL. */
export function assertValidSymbol(symbol: string): void {
  if (symbol.length === 0) {
    throw new BinanceConfigurationError("symbol must not be empty", { symbol });
  }
  if (symbol.length > MAX_SYMBOL_LENGTH) {
    throw new BinanceConfigurationError(
      `symbol must be at most ${String(MAX_SYMBOL_LENGTH)} characters (boundary hygiene, not a venue rule)`,
      { symbol, length: symbol.length },
    );
  }
  if (STRUCTURAL_CHARACTERS.test(symbol)) {
    throw new BinanceConfigurationError(
      "symbol must not contain whitespace, a URL separator, or a control character",
      { symbol },
    );
  }
}

/**
 * Builds the documented stream name.
 *
 * The symbol is lowercased because the venue requires it in the *stream name*.
 * It is NOT lowercased anywhere else: the `s` field of a frame is the venue's
 * own spelling of the symbol and is carried into the domain payload verbatim,
 * because §1.2 makes the symbol a volatile venue fact this repository keeps
 * opaque.
 */
export function streamNameFor(subscription: BinanceStreamSubscription): string {
  assertValidSymbol(subscription.symbol);
  const suffixes: readonly string[] = BINANCE_STREAM_SUFFIXES;
  if (!suffixes.includes(subscription.suffix)) {
    throw new BinanceConfigurationError(
      `stream suffix must be one of ${BINANCE_STREAM_SUFFIXES.join(", ")}`,
      { suffix: subscription.suffix },
    );
  }
  return `${subscription.symbol.toLowerCase()}@${subscription.suffix}`;
}

/** Resolves and de-duplicates a subscription set, enforcing the documented limit. */
export function resolveSubscriptions(
  subscriptions: readonly BinanceStreamSubscription[],
): readonly ResolvedStreamSubscription[] {
  if (subscriptions.length === 0) {
    throw new BinanceConfigurationError("at least one stream subscription is required");
  }
  if (subscriptions.length > BINANCE_LIMITS.maxStreamsPerConnection) {
    throw new BinanceConfigurationError(
      `a single connection may listen to at most ${String(BINANCE_LIMITS.maxStreamsPerConnection)} streams`,
      { requested: subscriptions.length },
    );
  }

  const seen = new Set<string>();
  const resolved: ResolvedStreamSubscription[] = [];
  for (const subscription of subscriptions) {
    const streamName = streamNameFor(subscription);
    if (seen.has(streamName)) {
      throw new BinanceConfigurationError(
        `stream ${streamName} is subscribed twice; a duplicate subscription would double-count every frame`,
        { streamName },
      );
    }
    seen.add(streamName);
    resolved.push({ ...subscription, streamName });
  }
  return resolved;
}

/** Inputs to {@link buildCombinedStreamUrl}. */
export type StreamUrlOptions = {
  /** One of the documented public market-data endpoints. */
  readonly endpoint?: string;
  readonly subscriptions: readonly BinanceStreamSubscription[];
  /** Explicit, because nothing in a frame states its unit. */
  readonly timeUnit?: BinanceTimeUnit;
};

/** A built connection URL and the subscription set it encodes. */
export type BuiltStreamUrl = {
  readonly url: string;
  /**
   * The endpoint without the query, for `FeedConnected.endpoint`.
   *
   * The full URL can exceed the domain's 200-character identifier bound with a
   * realistic subscription set, and the subscription set is already recorded as
   * `sourceChannel` per event. This form is also trivially credential-free.
   */
  readonly endpointIdentifier: string;
  readonly subscriptions: readonly ResolvedStreamSubscription[];
  readonly timeUnit: BinanceTimeUnit;
};

/**
 * Builds the combined-stream URL for a subscription set.
 *
 * The `streams` query value is assembled by hand rather than through
 * `URLSearchParams` because the venue documents the literal form
 * `?streams=btcusdt@trade/btcusdt@bookTicker`, and `URLSearchParams` would
 * percent-encode `@` and `/` into a spelling the documentation never shows.
 */
export function buildCombinedStreamUrl(options: StreamUrlOptions): BuiltStreamUrl {
  const endpoint = options.endpoint ?? BINANCE_DEFAULT_ENDPOINT;
  const refusal = explainNonPublicEndpoint(endpoint);
  if (refusal !== null) {
    throw new BinanceConfigurationError(`refusing endpoint ${endpoint}: ${refusal}`, { endpoint });
  }

  const subscriptions = resolveSubscriptions(options.subscriptions);
  const timeUnit = options.timeUnit ?? BINANCE_DEFAULT_TIME_UNIT;
  const names = subscriptions.map((subscription) => subscription.streamName).join("/");
  const endpointIdentifier = `${endpoint}${BINANCE_COMBINED_STREAM_PATH}`;
  const timeUnitQuery =
    timeUnit === "MILLISECOND" ? "" : `&${BINANCE_TIME_UNIT_QUERY_PARAM}=${timeUnit}`;

  return {
    url: `${endpointIdentifier}?streams=${names}${timeUnitQuery}`,
    endpointIdentifier,
    subscriptions,
    timeUnit,
  };
}

/**
 * Builds a raw single-stream URL.
 *
 * Provided because the venue documents it and a caller may want one connection
 * per stream, but it is not what {@link buildCombinedStreamUrl} produces: a raw
 * connection delivers unwrapped payloads, and for `bookTicker` that means the
 * originating stream is reconstructed from the payload rather than stated.
 */
export function buildRawStreamUrl(
  subscription: BinanceStreamSubscription,
  options: { readonly endpoint?: string; readonly timeUnit?: BinanceTimeUnit } = {},
): BuiltStreamUrl {
  const endpoint = options.endpoint ?? BINANCE_DEFAULT_ENDPOINT;
  const refusal = explainNonPublicEndpoint(endpoint);
  if (refusal !== null) {
    throw new BinanceConfigurationError(`refusing endpoint ${endpoint}: ${refusal}`, { endpoint });
  }
  const streamName = streamNameFor(subscription);
  const timeUnit = options.timeUnit ?? BINANCE_DEFAULT_TIME_UNIT;
  const endpointIdentifier = `${endpoint}${BINANCE_RAW_STREAM_PATH}/${streamName}`;
  const timeUnitQuery =
    timeUnit === "MILLISECOND" ? "" : `?${BINANCE_TIME_UNIT_QUERY_PARAM}=${timeUnit}`;

  return {
    url: `${endpointIdentifier}${timeUnitQuery}`,
    endpointIdentifier,
    subscriptions: [{ ...subscription, streamName }],
    timeUnit,
  };
}
