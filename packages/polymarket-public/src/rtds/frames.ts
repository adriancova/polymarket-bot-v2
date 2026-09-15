/**
 * Outbound RTDS frames and inbound frame decoding.
 *
 * Frame shapes, verbatim from https://docs.polymarket.com/market-data/chainlink-twap
 * (accessed 2026-08-28):
 *
 * ```json
 * {
 *   "action": "subscribe",
 *   "subscriptions": [
 *     { "topic": "crypto_prices_twap_thirty", "type": "update", "filters": "{\"symbol\":\"btc/usd\"}" },
 *     { "topic": "crypto_prices_twap_sixty",  "type": "update", "filters": "{\"symbol\":\"btc/usd\"}" }
 *   ]
 * }
 * ```
 *
 * and the heartbeat: "Send the text frame PING every 5 seconds."
 *
 * ## `filters` is OPTIONAL, and this is the corrected rule
 *
 * An earlier revision of the verification skeleton required `filters`. That was
 * wrong and was corrected in `WP-000` round 4; the correction is binding
 * (`docs/venue/verified-2026-08-24.md` §10.3 and §17,
 * `docs/adr/ADR-009-settlement-spec-and-payoff-model-selection.md` §6). The
 * current page states it in two places: "Omit it to receive every available
 * symbol", and "If you need several symbols for one window, omit filters and
 * filter updates by payload.symbol in your application."
 *
 * So the key is either ABSENT or the compact JSON string. It is never `null` and
 * never an empty string: neither form is documented, and §17 records `null`
 * being rejected rather than "assumed benign" for exactly this field. Nothing in
 * this module can emit either one.
 */

import {
  RTDS_SUBSCRIBE_ACTION,
  RTDS_TWAP_TOPIC_BY_WINDOW,
  RTDS_UPDATE_TYPE,
  type RtdsTwapWindowSubscription,
} from "./config.js";

/** An outbound frame, ready to be JSON-serialized. */
export type RtdsFrame = Readonly<Record<string, unknown>>;

/** One entry of the `subscriptions` array. */
export type RtdsSubscriptionEntry = Readonly<Record<string, unknown>>;

/**
 * Builds the `filters` value for a single symbol.
 *
 * Serialized by hand rather than with `JSON.stringify({symbol})` so the "exact
 * compact JSON form … with one lowercase symbol and no spaces" is visible at the
 * call site and cannot drift with a serializer's spacing. The two forms agree
 * for this shape, which `frames.test.ts` asserts.
 */
export function buildSymbolFilter(symbol: string): string {
  return `{"symbol":"${symbol}"}`;
}

/**
 * Builds one subscription entry.
 *
 * `filters` is present only for a single-symbol request; see this module's
 * header for why the multi-symbol case omits it.
 */
export function buildSubscriptionEntry(
  subscription: RtdsTwapWindowSubscription,
): RtdsSubscriptionEntry {
  const topic = RTDS_TWAP_TOPIC_BY_WINDOW[subscription.windowSeconds];
  const symbols = subscription.symbols ?? [];
  const filter = symbols.length === 1 ? symbols[0] : undefined;
  return {
    topic,
    type: RTDS_UPDATE_TYPE,
    ...(filter === undefined ? {} : { filters: buildSymbolFilter(filter) }),
  };
}

/**
 * Builds the one subscription frame sent immediately after the socket opens.
 *
 * One frame carrying every window, which is the shape the page demonstrates for
 * a two-window subscription. A reconnect re-sends exactly this frame: "Direct
 * clients must reconnect and resubscribe after a disconnect."
 *
 * EVERY CONTAINER IN THE FRAME IS THIS MODULE'S OWN, AND ORDINARY (`SER-3`
 * review round 1, finding M2). The `subscriptions` member used to be
 * `subscriptions.map(buildSubscriptionEntry)`, and `Array.prototype.map`
 * PRESERVES THE SPECIES of the array it is called on (ECMA-262
 * `ArraySpeciesCreate`). So a caller that passed an `Array` SUBCLASS of
 * perfectly valid subscriptions — which `RtdsTwapFeedOptions.subscriptions`
 * (`readonly RtdsTwapWindowSubscription[]`) accepts with no cast, which
 * `resolveRtdsTwapFeedOptions` carries through by object spread, and which
 * `validateSubscriptions` accepts — got a frame whose `subscriptions` member
 * WAS that subclass. `JSON.stringify` serialized it normally; the own-data
 * encoder refuses a container whose prototype is neither `Array.prototype` nor
 * `null` (`NON_PLAIN`), so the feed REFUSED AT CONSTRUCTION where base
 * connected and subscribed:
 * `{"stage":"construct","code":"PUBLIC_MARKET_CONFIGURATION","kind":"NON_PLAIN","path":"value.subscriptions"}`.
 * The encoder is right to refuse an object whose meaning lives on a prototype;
 * the defect was letting a caller's array TYPE reach it at all.
 *
 * The array is therefore built here, ordinary, by an index walk: no `map`
 * (species), and no `for…of` (a subclass may override `Symbol.iterator`) —
 * which is also how `SerializeJSONArray` itself reads an array, by own
 * `length` then own indices. Each entry is a fresh object literal from
 * {@link buildSubscriptionEntry}, so a subscription that is a class instance or
 * a null-prototype object does not reach the encoder either.
 *
 * ONE OUT-OF-TYPE DIVERGENCE, stated rather than hidden: a HOLE in the input
 * (`[, x]`) was left a hole by `map` and would have serialized as `null`;
 * reading it by index yields `undefined` and {@link buildSubscriptionEntry}
 * throws a `TypeError` on it, as `map` already did for an explicit `undefined`
 * element. Neither form is in the parameter's type, and `validateSubscriptions`
 * (`./config.ts`) throws on both before the feed ever builds a frame.
 */
export function buildSubscribeFrame(
  subscriptions: readonly RtdsTwapWindowSubscription[],
): RtdsFrame {
  const entries: RtdsSubscriptionEntry[] = [];
  const count = subscriptions.length;
  for (let index = 0; index < count; index += 1) {
    entries.push(buildSubscriptionEntry(subscriptions[index] as RtdsTwapWindowSubscription));
  }
  return {
    action: RTDS_SUBSCRIBE_ACTION,
    subscriptions: entries,
  };
}

/** What an inbound text frame turned out to be. */
export type InboundRtdsFrame =
  /**
   * A bare `PING` or `PONG` text frame.
   *
   * UNDOCUMENTED (RTDS-U2): the page documents the client sending `PING` and
   * says nothing about anything coming back. It is classified rather than
   * consumed silently, so the feed can report the first one per connection and
   * count the rest instead of either flooding the incident path or quietly
   * inventing a documented heartbeat reply.
   */
  | { readonly kind: "heartbeat-text"; readonly text: string }
  /** One or more envelope objects. */
  | { readonly kind: "values"; readonly values: readonly unknown[] }
  /** Not JSON, or JSON that is neither an object nor an array. */
  | { readonly kind: "unparsable"; readonly reason: string };

/**
 * Decodes one inbound text frame.
 *
 * A single JSON object is what the page shows. An ARRAY is accepted too and each
 * element is judged on its own merits: batching is not documented either way,
 * and the alternative — refusing the whole frame — would turn N valid
 * observations into one problem. That is defensive handling, not a claim that
 * RTDS batches; `values` is one element long for every documented frame.
 */
export function decodeInboundRtdsFrame(raw: string): InboundRtdsFrame {
  const trimmed = raw.trim();
  if (trimmed === "PING" || trimmed === "PONG") {
    return { kind: "heartbeat-text", text: trimmed };
  }
  if (trimmed === "") {
    return { kind: "unparsable", reason: "empty frame" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    return {
      kind: "unparsable",
      reason: `not JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      return { kind: "unparsable", reason: "JSON array carried no envelope" };
    }
    return { kind: "values", values: parsed as readonly unknown[] };
  }
  if (typeof parsed === "object" && parsed !== null) {
    return { kind: "values", values: [parsed] };
  }
  return { kind: "unparsable", reason: `JSON ${typeof parsed} is not an update envelope` };
}
