/**
 * Coinbase venue facts, each one cited to a current official Coinbase page.
 *
 * AUTHORITY. `AGENTS.md` gives current official venue documentation control over
 * volatile venue facts and forbids inventing venue behavior. Every constant in
 * this file therefore carries a citation in {@link COINBASE_DOC_CITATIONS};
 * anything the documentation does not state is listed in
 * {@link COINBASE_UNVERIFIED_ITEMS} and handled conservatively rather than
 * guessed. `docs/handoffs/WP-090.md` and `packages/coinbase-adapter/VENUE.md`
 * carry the same list in prose.
 *
 * WHICH SURFACE, AND WHY. Coinbase publishes several market-data products. This
 * adapter uses the **Advanced Trade Market Data WebSocket**
 * (`wss://advanced-trade-ws.coinbase.com`) because its documentation states
 * plainly that the public endpoint needs no credential — "A JWT is not
 * required" — and marks `heartbeats`, `ticker`, and `market_trades` as
 * `Requires Authentication: No` in a per-channel table. The alternative,
 * Coinbase Exchange market data (`wss://ws-feed.exchange.coinbase.com`), is also
 * documented as available without authentication, but its published sequence
 * semantics are stated only in prose, while Advanced Trade additionally ships a
 * machine-readable AsyncAPI 3.0.0 document that pins the frame shapes this
 * adapter parses. The repository's rule is that a credential is never required
 * anywhere, so the surface with the clearest unauthenticated guarantee and the
 * strongest schema evidence wins. See `VENUE.md` for the full comparison.
 *
 * NO CREDENTIAL. Nothing in this package reads, holds, or transmits a
 * credential. The subscribe frames this module builds carry no `jwt` field; the
 * documented public form omits it entirely.
 *
 * SNAPSHOT, NOT A GUARANTEE. Handoff §1.2 makes venue facts volatile and
 * requires re-verification each phase. `COINBASE_FACTS_VERIFIED_AT` is the date
 * these were read; it is data, not a claim about today.
 */

import { encodePlainJson, PLAIN_JSON_REFUSAL_KINDS } from "@polymarket-bot/risk/plain-json";
import type { PlainJsonRefusalKind } from "@polymarket-bot/risk/plain-json";

import { CoinbaseConfigurationError } from "./errors.js";

/**
 * The date every citation below was fetched and read (ISO date, UTC).
 *
 * Re-verify on the schedule handoff §1.2 requires. A stale date is a signal to
 * re-read the pages, not a reason to distrust the parser: the wire schemas are
 * permissive about unknown keys and classify unknown vocabulary as UNKNOWN
 * rather than assuming this snapshot is exhaustive.
 */
export const COINBASE_FACTS_VERIFIED_AT = "2026-08-27" as const;

/** One cited claim: what is asserted, where it says so, and when that was read. */
export type CoinbaseDocCitation = {
  /** Stable handle used by doc comments and tests to refer to the claim. */
  readonly id: string;
  /** The claim, stated as the documentation states it. */
  readonly claim: string;
  /** Official Coinbase URL the claim was read from. */
  readonly url: string;
  /** ISO date the URL was fetched. */
  readonly accessedAt: string;
};

/**
 * Every load-bearing Coinbase claim this package relies on.
 *
 * A claim that is not in this list may not be relied on by code in this
 * package. A test asserts that the channel names, endpoint, and vocabulary the
 * implementation uses all appear here.
 */
export const COINBASE_DOC_CITATIONS: readonly CoinbaseDocCitation[] = [
  {
    id: "public-endpoint",
    claim:
      "Advanced Trade public market-data WebSocket URL is wss://advanced-trade-ws.coinbase.com, " +
      'and for that endpoint "A JWT is not required."',
    url: "https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/websocket/websocket-endpoints",
    accessedAt: "2026-08-27",
  },
  {
    id: "public-channels-unauthenticated",
    claim:
      "The channel table marks heartbeats, candles, status, ticker, ticker_batch, level2 and " +
      'market_trades as "Requires Authentication: No"; only user and futures_balance_summary ' +
      "require authentication.",
    url: "https://docs.cdp.coinbase.com/coinbase-business/advanced-trade-apis/websocket/websocket-channels",
    accessedAt: "2026-08-27",
  },
  {
    id: "subscribe-without-keys",
    claim:
      'The "Sending Messages without API Keys" section subscribes with ' +
      '{"type":"subscribe","product_ids":[...],"channel":"..."} and no jwt field.',
    url: "https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/websocket/websocket-overview",
    accessedAt: "2026-08-27",
  },
  {
    id: "subscribe-within-5s",
    claim:
      "A subscribe message is mandatory: the server disconnects a client that has not sent one " +
      "within 5 seconds. One channel per subscription message.",
    url: "https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/websocket/websocket-overview",
    accessedAt: "2026-08-27",
  },
  {
    id: "json-frames",
    claim:
      "The WebSocket feed encodes all messages as JSON objects, and every message has a type " +
      "attribute. New message types can be added at any time.",
    url: "https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/websocket/websocket-overview",
    accessedAt: "2026-08-27",
  },
  {
    id: "envelope-base",
    claim:
      "Every streamed message carries channel (the channel that produced it), timestamp (server " +
      "time the message was sent, RFC 3339) and sequence_num, described in the AsyncAPI document " +
      'as a "Per-connection message sequence number; use it to detect dropped or out-of-order ' +
      'messages."',
    url: "https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/advanced-trade-asyncapi.json",
    accessedAt: "2026-08-27",
  },
  {
    id: "sequence-gap-meaning",
    claim:
      "Sequence numbers increase by exactly one per message. A jump greater than one indicates a " +
      "dropped message; a number lower than the previous one may be ignored or represents an " +
      "out-of-order arrival. A consumer must be designed to handle gaps and out-of-order messages.",
    url: "https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/websocket/websocket-overview",
    accessedAt: "2026-08-27",
  },
  {
    id: "market-trades-shape",
    claim:
      "market_trades messages carry events[].type of snapshot or update and events[].trades[] of " +
      "{trade_id, product_id, price, size, side, time}; price and size are strings, time is RFC " +
      "3339, and side is enumerated BUY or SELL.",
    url: "https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/websocket/market-trades",
    accessedAt: "2026-08-27",
  },
  {
    id: "market-trades-maker-side",
    claim:
      'The market_trades side field "refers to the makers side, and can be of type BUY, or SELL", ' +
      'and the AsyncAPI describes it as "The maker\'s side of the trade." Updates are collected ' +
      "over the last 250 ms, so one update may contain one or many trades.",
    url: "https://docs.cdp.coinbase.com/coinbase-business/advanced-trade-apis/websocket/websocket-channels",
    accessedAt: "2026-08-27",
  },
  {
    id: "ticker-shape",
    claim:
      "ticker messages carry events[].tickers[] with product_id, price, and the top-of-book " +
      "fields best_bid, best_ask, best_bid_quantity and best_ask_quantity, all typed as strings. " +
      "The channel emits on every match and batches during cascading matches.",
    url: "https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/websocket/ticker",
    accessedAt: "2026-08-27",
  },
  {
    id: "ticker-batch-no-top-of-book",
    claim:
      "ticker_batch has the same schema as ticker except that channel is ticker_batch and it " +
      "currently does not provide best bid or best ask fields.",
    url: "https://docs.cdp.coinbase.com/coinbase-business/advanced-trade-apis/websocket/websocket-channels",
    accessedAt: "2026-08-27",
  },
  {
    id: "heartbeats",
    claim:
      "The heartbeats channel sends a message every second carrying heartbeat_counter, which " +
      "verifies that no messages were missed; it needs no products and no authentication.",
    url: "https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/websocket/heartbeats",
    accessedAt: "2026-08-27",
  },
  {
    id: "idle-close",
    claim:
      "Most channels close within 60-90 seconds when no updates arrive; subscribing to heartbeats " +
      "keeps all subscriptions open.",
    url: "https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/websocket/websocket-endpoints",
    accessedAt: "2026-08-27",
  },
  {
    id: "subscriptions-ack",
    claim:
      "The server answers a subscribe or unsubscribe with a subscriptions message.",
    url: "https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/websocket/websocket-overview",
    accessedAt: "2026-08-27",
  },
  {
    id: "rate-limits",
    claim:
      "WebSocket connections and unauthenticated messages are each limited to 8 per second per IP.",
    url: "https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/websocket/websocket-rate-limits",
    accessedAt: "2026-08-27",
  },
] as const;

/** A fact the documentation does not settle, and how this package behaves instead. */
export type CoinbaseUnverifiedItem = {
  readonly id: string;
  /** What could not be established from official documentation. */
  readonly question: string;
  /** What was checked. */
  readonly checked: string;
  /** The conservative behavior chosen, which never invents venue semantics. */
  readonly conservativeHandling: string;
};

/**
 * Facts this package needed and the documentation does not settle.
 *
 * Listed as data so a reviewer can diff them, and so no doc comment can quietly
 * upgrade one to "verified" without editing this list.
 */
export const COINBASE_UNVERIFIED_ITEMS: readonly CoinbaseUnverifiedItem[] = [
  {
    id: "U-CB-1",
    question:
      "Is a decimal field ever sent as the empty string, or as null, when the value is absent " +
      "(as the Polymarket CLOB does for optional decimals)?",
    checked:
      "The AsyncAPI document types every price/size field as a plain string with no nullability " +
      "and no empty-string convention, and no Coinbase page documents one.",
    conservativeHandling:
      "An ABSENT key is treated as absent (ticker_batch is documented as omitting best bid/ask). " +
      "A key that is PRESENT but empty or null is a typed field error surfaced to the caller as " +
      "an anomaly with the raw frame preserved — never silently mapped to absent, and never " +
      "invented as zero. Absence and emptiness are different facts.",
  },
  {
    id: "U-CB-2",
    question: "Does the server replay or backfill messages missed while a client was disconnected?",
    checked:
      "No Coinbase page documents any replay, history, or catch-up for the Advanced Trade market " +
      "data streams; the documentation only tells a consumer to detect gaps from sequence_num.",
    conservativeHandling:
      "A reconnect is treated as an unbounded gap: FeedGapDetected is emitted with " +
      "requiresAuthoritativeSnapshot, and the adapter additionally opens a data-quality incident " +
      "recording that trades missed during the outage are NOT recovered by the venue's snapshot.",
  },
  {
    id: "U-CB-3",
    question: "Does market_trades.side really report the MAKER side of a trade?",
    checked:
      "Two official pages say it does, in words: the channel page says the side \"refers to the " +
      "makers side\" and the AsyncAPI describes it as \"The maker's side of the trade.\" Nothing " +
      "official contradicts it, and it cannot be confirmed from public market data alone, since " +
      "a public trade print carries no counterparty roles.",
    conservativeHandling:
      "The documented reading is followed — takerSide is the inverse of the reported maker side — " +
      "and the raw venue value is carried alongside on every normalized trade so a correction is " +
      "a one-line change and no information is lost.",
  },
  {
    id: "U-CB-4",
    question: "What is the maximum number of product_ids in one subscription message?",
    checked:
      "The rate-limit page bounds connections and messages per second per IP and says nothing " +
      "about subscription width; no other page states a limit.",
    conservativeHandling:
      "No limit is assumed and none is enforced. Subscription planning is the gateway's problem " +
      "(WP-120); this package accepts the product list it is given.",
  },
  {
    id: "U-CB-5",
    question:
      "What is the exact payload shape of the subscriptions acknowledgement on Advanced Trade?",
    checked:
      "The overview documents that the message is sent but shows no Advanced Trade example, and " +
      "the AsyncAPI document defines no subscriptions message.",
    conservativeHandling:
      "The message is recognized by its channel name and classified as a control frame. No field " +
      "of it is parsed, relied on, or asserted; it advances the sequence counter like any other " +
      "message because it carries sequence_num.",
  },
] as const;

/** A fact established by live observation rather than by documentation. */
export type CoinbaseObservation = {
  readonly id: string;
  readonly observation: string;
  /** How it was observed. Never in tests: tests are offline. */
  readonly method: string;
  readonly observedAt: string;
};

/**
 * Facts established by a single read-only observation of the public feed.
 *
 * These are NOT documentation. They are recorded because two of them settle
 * open repository items (`ADR-004` §1 left Coinbase framing "to verify", and the
 * documentation contradicts itself about the scope of `sequence_num`), and
 * because the honest alternative would have been to guess. A single observation
 * is weak evidence: nothing in this package *depends* on an observation alone —
 * each one either agrees with a citation above or is handled conservatively.
 *
 * The observation was a public, unauthenticated, read-only subscription. No
 * credential was sent, no order was placed, and no observed byte became a
 * fixture: every fixture in `test/contract/coinbase/fixtures` derives from a
 * documented example.
 */
export const COINBASE_LIVE_OBSERVATIONS: readonly CoinbaseObservation[] = [
  {
    id: "O-CB-1",
    observation:
      "All 338 frames received were UTF-8 text carrying JSON objects. No binary frame and no " +
      "bare non-JSON text frame (no PING/PONG payload) was observed; the heartbeat is an ordinary " +
      "JSON message on the heartbeats channel. This settles the ADR-004 §1 open item for the " +
      "Coinbase side in the direction the WAL format already assumes.",
    method:
      "One 25-second read-only subscription to heartbeats, market_trades and ticker for BTC-USD " +
      "and ETH-USD on wss://advanced-trade-ws.coinbase.com, with no credential.",
    observedAt: "2026-08-27",
  },
  {
    id: "O-CB-2",
    observation:
      "sequence_num advanced by exactly one across ALL channels and products on the single " +
      "connection (0,1,2,... with heartbeats, ticker, market_trades and subscriptions frames " +
      "interleaved). This matches the AsyncAPI wording (per-connection) and contradicts the " +
      "overview prose (\"for each product\"). Recorded as conflict C-CB-1.",
    method: "Same observation as O-CB-1; the first frame observed carried sequence_num 0.",
    observedAt: "2026-08-27",
  },
  {
    id: "O-CB-3",
    observation:
      "Every observed frame's top-level key set was exactly {channel, timestamp, sequence_num, " +
      "events}, and timestamp was RFC 3339 with nanosecond precision, which the repository's " +
      "IsoTimestampSchema accepts unchanged.",
    method: "Same observation as O-CB-1.",
    observedAt: "2026-08-27",
  },
] as const;

/**
 * The public market-data endpoint. Contains no credential and no query string.
 *
 * Cited by `public-endpoint`.
 */
export const COINBASE_PUBLIC_MARKET_DATA_ENDPOINT = "wss://advanced-trade-ws.coinbase.com" as const;

/**
 * Channel names this adapter subscribes to or recognizes.
 *
 * `market_trades` supplies `ReferenceTradeObserved`; `ticker` supplies
 * `ReferenceTopOfBookChanged`; `heartbeats` exists because most channels close
 * within 60-90 seconds without updates (`idle-close`) and because
 * `heartbeat_counter` is a second, independent gap signal; `subscriptions` is
 * the acknowledgement the server sends back (`subscriptions-ack`).
 */
export const COINBASE_CHANNELS = {
  marketTrades: "market_trades",
  ticker: "ticker",
  heartbeats: "heartbeats",
  subscriptions: "subscriptions",
} as const;

/** A channel this adapter recognizes. Any other value is classified UNKNOWN. */
export type CoinbaseChannel = (typeof COINBASE_CHANNELS)[keyof typeof COINBASE_CHANNELS];

/** The market-data channels this adapter normalizes into domain events. */
export const COINBASE_MARKET_DATA_CHANNELS = [
  COINBASE_CHANNELS.marketTrades,
  COINBASE_CHANNELS.ticker,
] as const satisfies readonly CoinbaseChannel[];

/**
 * The documented maker-side vocabulary of `market_trades.side`.
 *
 * Enumerated by the AsyncAPI (`market-trades-shape`), but NOT treated as
 * exhaustive: ADR-002 §7 requires a runtime parser to treat an unrecognized
 * value as first-class UNKNOWN rather than assuming an enumeration is closed,
 * and the overview warns that new message types appear at any time.
 */
export const COINBASE_TRADE_SIDES = ["BUY", "SELL"] as const;
export type CoinbaseTradeSide = (typeof COINBASE_TRADE_SIDES)[number];

/**
 * The documented `events[].type` vocabulary. Also not treated as exhaustive.
 *
 * `snapshot` is load-bearing for reconnect handling: it is the venue's own
 * authoritative statement of current state on a fresh subscription, which is
 * what ADR-002 §2.4 requires before affected markets resume.
 */
export const COINBASE_EVENT_TYPES = ["snapshot", "update"] as const;
export type CoinbaseEventType = (typeof COINBASE_EVENT_TYPES)[number];

/**
 * Builds the documented public subscribe frame.
 *
 * Deliberately has no way to attach a credential: there is no `jwt` parameter
 * and no code path that adds one. Cited by `subscribe-without-keys`.
 *
 * One channel per message, per `subscribe-within-5s`.
 *
 * @throws {CoinbaseConfigurationError} when the frame is not plain JSON data
 *   (see {@link encodeFrame}).
 */
export function buildSubscribeFrame(
  channel: CoinbaseChannel,
  productIds: readonly string[],
): string {
  // The heartbeats channel takes no products (`heartbeats`), and sending an
  // empty array where the documented example omits the key would be inventing a
  // form the venue never documented.
  const frame =
    productIds.length === 0
      ? { type: "subscribe", channel }
      : { type: "subscribe", channel, product_ids: [...productIds] };
  return encodeFrame(frame, "subscribe");
}

/**
 * Builds the documented public unsubscribe frame — same structure as subscribe.
 *
 * Cited by `subscribe-without-keys`.
 *
 * @throws {CoinbaseConfigurationError} when the frame is not plain JSON data
 *   (see {@link encodeFrame}).
 */
export function buildUnsubscribeFrame(
  channel: CoinbaseChannel,
  productIds: readonly string[],
): string {
  const frame =
    productIds.length === 0
      ? { type: "unsubscribe", channel }
      : { type: "unsubscribe", channel, product_ids: [...productIds] };
  return encodeFrame(frame, "unsubscribe");
}

/**
 * The bytes of one outbound frame, encoded from OWN DATA (`SER-3`, 2026-09-15).
 *
 * `JSON.stringify` resolves `toJSON` through the value's PROTOTYPE CHAIN, so
 * an inherited `toJSON` on `Object.prototype` or `Array.prototype` (plain
 * assignment or a non-enumerable `defineProperty`) replaced the bytes of the
 * frame literal above and of its `product_ids` copy. Measured at `main`
 * `d6e05bf` and reproduced independently (`docs/handoffs/SER-0-sweep.md`,
 * `coinbase-subscribe-unsubscribe-frames`): under `Object.prototype` every
 * frame left as the bare string `"POLLUTED"`; under `Array.prototype` the
 * heartbeats frame (no array) survived, so the connection LOOKED healthy —
 * heartbeats acknowledged — while `market_trades` and `ticker` were
 * subscribed to `"product_ids":"POLLUTED"`, i.e. to nothing. The manager
 * sends these verbatim on every connect and reconnect.
 *
 * `@polymarket-bot/risk/plain-json`'s `encodePlainJson` is the canonical
 * own-data restatement of ECMA-262 25.5.2: byte-identical to a clean
 * `JSON.stringify` for plain data (the contract fixtures under
 * `test/contract/coinbase` pin the bytes), and it never consults `toJSON`. The
 * edge `packages/coinbase-adapter` (layer 2) → `packages/risk` (layer 1) is
 * downward.
 *
 * `[...productIds]` IS LOAD-BEARING, NOT A DEFENSIVE COPY (`SER-3` review
 * round 1, M2 sweep). An array-literal spread always produces an ORDINARY
 * array whatever the argument's species is, where `productIds.map(…)` or
 * `.slice(…)` would have preserved an `Array` SUBCLASS the caller passed
 * (ECMA-262 `ArraySpeciesCreate`) — and this encoder refuses a container whose
 * prototype is neither `Array.prototype` nor `null`, so a caller's array TYPE
 * reaching the frame would be a refusal where `JSON.stringify` serialized.
 * That is the defect the review found in `polymarket-public`'s RTDS frame
 * builder; this spelling already excluded it here, and
 * `test/unit/coinbase-adapter/outbound-container-species.test.ts` pins it with
 * a subclass. The frame itself is an object literal, so its prototype is this
 * module's.
 *
 * A refusal is restated in this package's vocabulary: the frame is a pure
 * function of the channel (closed vocabulary) and the caller's `productIds`
 * option, so a value the encoder cannot represent is a malformed option —
 * `COINBASE_CONFIGURATION` — thrown to the caller with nothing sent, never a
 * frame silently not built. The refusal is classified by an own-data read of
 * its `kind` (never `instanceof`, which walks the thrown value's prototype
 * chain); a thrown value that does not classify is re-thrown as itself.
 */
function encodeFrame(frame: Readonly<Record<string, unknown>>, what: string): string {
  try {
    return encodePlainJson(frame);
  } catch (error) {
    const kind = plainJsonRefusalKind(error);
    if (kind === undefined) throw error;
    throw new CoinbaseConfigurationError(
      `the ${what} frame is not plain JSON data and was not built`,
      { what, kind, path: ownString(error, "path"), problem: ownString(error, "problem") },
    );
  }
}

/** The `kind` of the canonical encoder's refusal, read as OWN DATA; TOTAL. */
function plainJsonRefusalKind(error: unknown): PlainJsonRefusalKind | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, "kind");
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) return undefined;
    const kind: unknown = descriptor.value;
    return typeof kind === "string" && PLAIN_JSON_REFUSAL_KINDS.includes(kind as PlainJsonRefusalKind)
      ? (kind as PlainJsonRefusalKind)
      : undefined;
  } catch {
    return undefined;
  }
}

/** An own string-valued data property of `error`, or `undefined`. */
function ownString(error: unknown, key: string): string | undefined {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, key);
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) return undefined;
    return typeof descriptor.value === "string" ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

/** Looks up a citation by id, for doc comments and tests that assert coverage. */
export function findCitation(id: string): CoinbaseDocCitation | undefined {
  return COINBASE_DOC_CITATIONS.find((citation) => citation.id === id);
}
