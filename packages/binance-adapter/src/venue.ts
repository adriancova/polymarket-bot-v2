/**
 * Binance venue facts, each carrying its citation (WP-080).
 *
 * AUTHORITY. `AGENTS.md`: "Current official … documentation controls volatile
 * venue facts" and "Report conflicts or missing information; never silently
 * invent venue behavior." Every constant below is quoted from the official
 * Binance Spot API documentation and is tagged with the exact source and access
 * date. Anything the documentation does not state is recorded in
 * {@link BINANCE_UNVERIFIED} rather than assumed, and an item an outside
 * authority later settles moves to {@link BINANCE_RESOLVED} rather than
 * disappearing.
 *
 * SOURCES (accessed 2026-08-27):
 *
 * - `WS_STREAMS` — "WebSocket Streams for Binance",
 *   <https://github.com/binance/binance-spot-api-docs/blob/master/web-socket-streams.md>
 *   (raw markdown fetched from
 *   <https://raw.githubusercontent.com/binance/binance-spot-api-docs/master/web-socket-streams.md>;
 *   the same page is published at
 *   <https://developers.binance.com/docs/binance-spot-api-docs/web-socket-streams>).
 * - `SBE_STREAMS` — "SBE Market Data Streams",
 *   <https://github.com/binance/binance-spot-api-docs/blob/master/sbe-market-data-streams.md>.
 * - `REST` — "Binance Spot REST API",
 *   <https://github.com/binance/binance-spot-api-docs/blob/master/rest-api.md>.
 * - `WS_API` — "Binance Spot WebSocket API",
 *   <https://github.com/binance/binance-spot-api-docs/blob/master/web-socket-api.md>.
 *
 * SNAPSHOT DISCIPLINE. Handoff §1.2 treats venue facts as volatile and requires
 * re-verification each phase. {@link BINANCE_FACTS_VERIFIED_AT} is the date this
 * file was checked against the sources above; a later phase re-reads the pages
 * and updates it rather than trusting this module indefinitely.
 *
 * NO CREDENTIALS. Every endpoint named here is public market data. The one
 * Binance market-data surface that requires an API key (SBE, see
 * {@link BINANCE_SBE_ENDPOINT_HOST}) is deliberately excluded and is rejected by
 * {@link assertPublicMarketDataEndpoint}.
 */

/** The date the facts in this module were read from the official sources. */
export const BINANCE_FACTS_VERIFIED_AT = "2026-08-27" as const;

/**
 * Public JSON market-data WebSocket endpoints.
 *
 * `WS_STREAMS` "General WSS information": "The base endpoint is:
 * **wss://stream.binance.com:9443** or **wss://stream.binance.com:443**" and
 * "The base endpoint **wss://data-stream.binance.vision** can be subscribed to
 * receive **only** market data messages. User data stream is **NOT** available
 * from this URL."
 *
 * `data-stream.binance.vision` is this package's default precisely because of
 * that second sentence: an endpoint that structurally cannot carry user data is
 * the right default for a process whose maximum run mode is `PAPER` and which
 * holds no credential (ADR-010).
 */
export const BINANCE_PUBLIC_STREAM_ENDPOINTS = [
  "wss://data-stream.binance.vision",
  "wss://stream.binance.com:9443",
  "wss://stream.binance.com:443",
] as const;

export type BinancePublicStreamEndpoint = (typeof BINANCE_PUBLIC_STREAM_ENDPOINTS)[number];

/** Market-data-only endpoint (`WS_STREAMS`, "General WSS information"). */
export const BINANCE_DEFAULT_ENDPOINT: BinancePublicStreamEndpoint =
  "wss://data-stream.binance.vision";

/**
 * The SBE market-data host, named here only so it can be refused.
 *
 * `SBE_STREAMS` "General Information": "The base endpoint is
 * **stream-sbe.binance.com** …", "**An API Key is necessary for access**", and
 * "You will receive market data events in SBE in WebSocket **binary frames**".
 * A credential is forbidden repository-wide (`AGENTS.md`), and ADR-004 §1 states
 * that a binary payload cannot be held by the WAL's `payloadUtf8`, so this
 * package never uses it. See {@link BINANCE_FRAMING_RULING}.
 */
export const BINANCE_SBE_ENDPOINT_HOST = "stream-sbe.binance.com" as const;

/**
 * Path prefixes (`WS_STREAMS`, "General WSS information").
 *
 * "Raw streams are accessed at `/ws/<streamName>`"; "Combined streams are
 * accessed at `/stream?streams=<streamName1>/<streamName2>/…`"; "Combined
 * stream events are wrapped as follows: `{"stream":"<streamName>","data":<rawPayload>}`".
 * (The venue page bolds those path fragments; the bold markers are dropped here
 * because a literal `**` before a `/` would end this comment block.)
 */
export const BINANCE_RAW_STREAM_PATH = "/ws" as const;
export const BINANCE_COMBINED_STREAM_PATH = "/stream" as const;

/**
 * The two stream suffixes this package normalizes.
 *
 * The work plan scopes `WP-080` to "required Binance trades and top-of-book
 * streams", so exactly two streams are in scope. Full depth management
 * (`@depth`) is deliberately NOT implemented: it needs a REST snapshot and the
 * documented buffer/replay procedure (`WS_STREAMS`, "How to manage a local order
 * book correctly"), which is a different work package's problem.
 */
export const BINANCE_TRADE_STREAM_SUFFIX = "trade" as const;
export const BINANCE_BOOK_TICKER_STREAM_SUFFIX = "bookTicker" as const;

export const BINANCE_STREAM_SUFFIXES = [
  BINANCE_TRADE_STREAM_SUFFIX,
  BINANCE_BOOK_TICKER_STREAM_SUFFIX,
] as const;

export type BinanceStreamSuffix = (typeof BINANCE_STREAM_SUFFIXES)[number];

/**
 * Documented event-type discriminators carried in the `e` field.
 *
 * `<symbol>@trade` payloads carry `"e": "trade"` (`WS_STREAMS`, "Trade
 * Streams"). `<symbol>@bookTicker` payloads carry **no `e` field at all**
 * (`WS_STREAMS`, "Individual Symbol Book Ticker Streams" — the documented
 * payload is exactly `u`, `s`, `b`, `B`, `a`, `A`), which is why the frame
 * decoder cannot route on `e` alone. `"serverShutdown"` is the documented
 * lifecycle notice (`WS_STREAMS`, "Server Shutdown").
 */
export const BINANCE_TRADE_EVENT_TYPE = "trade" as const;
export const BINANCE_SERVER_SHUTDOWN_EVENT_TYPE = "serverShutdown" as const;

/**
 * Documented connection limits (`WS_STREAMS`, "General WSS information" and
 * "WebSocket Limits").
 *
 * They are exported as data so a subscription planner (`WP-120`) can respect
 * them without re-reading the venue page, and so a test can assert that this
 * package never plans a subscription set that exceeds one.
 */
export const BINANCE_LIMITS = {
  /** "A single connection can listen to a maximum of 1024 streams." */
  maxStreamsPerConnection: 1024,
  /** "WebSocket connections have a limit of 5 incoming messages per second." */
  maxClientMessagesPerSecond: 5,
  /** "There is a limit of **300 connections per attempt every 5 minutes per IP**." */
  maxConnectionAttemptsPer5Minutes: 300,
  /**
   * "A single connection to **stream.binance.com** is only valid for 24 hours;
   * expect to be disconnected at the 24 hour mark."
   */
  connectionLifetimeMs: 24 * 60 * 60 * 1000,
  /**
   * "The WebSocket server will send a `ping frame` every 20 seconds." … "If the
   * WebSocket server does not receive a `pong frame` back from the connection
   * within a minute the connection will be disconnected."
   *
   * These are RFC 6455 control frames, not application text frames: unlike the
   * Polymarket CLOB channels, whose `PING`/`PONG` are *text* frames the WAL
   * stores verbatim (ADR-004 §1), a Binance heartbeat never reaches application
   * code. Replying is the transport's obligation (RFC 6455 §5.5.2 requires an
   * endpoint to answer a Ping with a Pong), which is why the socket contract in
   * `./connection.ts` states it explicitly.
   */
  serverPingIntervalMs: 20_000,
  serverPongDeadlineMs: 60_000,
} as const;

/**
 * Timestamp units (`WS_STREAMS`, "General WSS information").
 *
 * "All time and timestamp related fields are **milliseconds by default**. To
 * receive the information in microseconds, please add the parameter
 * `timeUnit=MICROSECOND or timeUnit=microsecond` in the URL."
 *
 * The unit is therefore a property of the CONNECTION, not of the frame: nothing
 * in a frame says which unit it is in. It is modeled as an explicit, required
 * part of the stream configuration so a caller cannot silently read microseconds
 * as milliseconds (a 1000x error in every timestamp).
 */
export const BINANCE_TIME_UNITS = ["MILLISECOND", "MICROSECOND"] as const;
export type BinanceTimeUnit = (typeof BINANCE_TIME_UNITS)[number];
export const BINANCE_DEFAULT_TIME_UNIT: BinanceTimeUnit = "MILLISECOND";

/** The URL query parameter that selects the non-default unit. */
export const BINANCE_TIME_UNIT_QUERY_PARAM = "timeUnit" as const;

/**
 * What the official documentation does and does not say about framing —
 * the `WP-030` open item ADR-004 §1 assigned to this package.
 *
 * ADR-004 §1 records that `docs/venue/verified-2026-08-24.md` "verifies **no**
 * Binance or Coinbase fact at all, framing included", marks Binance frame
 * encoding "to verify" in `WP-080`, and warns that a binary payload would break
 * `payloadUtf8`. This is the answer, stated in three parts so the verified and
 * the unverified halves stay separable.
 */
export const BINANCE_FRAMING_RULING = {
  /**
   * VERIFIED. Market-data events on the JSON stream endpoints are JSON
   * documents. `WS_STREAMS` publishes a JSON "Payload:" block for every stream,
   * defines the combined-stream wrapper as JSON, and reports a malformed client
   * message as `{"code":3,"msg":"Invalid JSON: expected value at line %s column
   * %s"}`. `SBE_STREAMS` reinforces the split from the other side: "To retrieve
   * market data in **JSON** format, please refer to [web-socket-streams.md]".
   */
  jsonPayloadsOnStreamEndpoint: true,
  /**
   * VERIFIED. A binary Binance market-data path exists, and it is a different
   * host that requires a credential: `SBE_STREAMS` states "The base endpoint is
   * **stream-sbe.binance.com**", "**An API Key is necessary for access**", and
   * "You will receive market data events in SBE in WebSocket **binary frames**".
   * This package refuses that host (`assertPublicMarketDataEndpoint`), so no
   * binary payload can reach the WAL through it and ADR-004 needs no amendment
   * **for this adapter**.
   */
  binaryPathIsCredentialGatedAndExcluded: true,
  /**
   * UNVERIFIED. `WS_STREAMS` never states the WebSocket *opcode* of a
   * market-data event on `stream.binance.com` / `data-stream.binance.vision`.
   * It is documented as JSON, and `SBE_STREAMS` says the JSON control traffic on
   * the SBE host travels "in JSON in WebSocket **text frames**" while only the
   * SBE market data is binary — strong, but it is a statement about the *other*
   * host. This package therefore does not assert "text frame": the socket
   * contract accepts the frame payload as a string and the transport is required
   * to decode a binary frame as UTF-8 and report if it cannot (see
   * `./connection.ts`).
   */
  opcodeOnJsonEndpointDocumented: false,
} as const;

/**
 * Facts this package needs but the official documentation does not state.
 *
 * Recorded as data (rather than as prose in a comment) so a test can assert the
 * list is non-empty and the handoff can enumerate it without drifting. Each
 * entry names the conservative behavior chosen instead of an assumption.
 *
 * An entry leaves this list only when an authority OUTSIDE this package settles
 * it; it then moves to {@link BINANCE_RESOLVED} with what closed it, so a
 * closure is auditable and an id that once appeared in this package's output can
 * still be looked up. Nothing here may close its own open item by deciding the
 * behavior it already chose is fine.
 */
export const BINANCE_UNVERIFIED = [
  {
    id: "BNC-U1",
    subject: "WebSocket opcode of market-data events on the JSON stream endpoint",
    documented: "Payloads are documented as JSON; the frame opcode is never stated.",
    conservativeBehavior:
      "The socket contract takes a string; the transport decodes a binary frame as UTF-8 and surfaces a typed failure if it cannot. Nothing here claims the frames are text.",
  },
  {
    id: "BNC-U2",
    subject: "Contiguity of `<symbol>@trade` trade ids (`t`)",
    documented:
      "`t` is documented as the Trade ID and `GET /api/v3/historicalTrades` pages from a `fromId` (`REST`), so ids are per-symbol ordinals; the documentation never states that consecutive trades receive consecutive ids.",
    conservativeBehavior:
      "A jump in `t` is NEVER reported as a feed gap. Only equality (a repeat of an already-seen trade) is treated as a duplicate; a non-consecutive step is counted as an observation and nothing more.",
  },
  {
    id: "BNC-U3",
    subject: "Monotonicity of `<symbol>@bookTicker` update ids (`u`)",
    documented:
      "`u` is documented as the 'order book updateId'. The local-order-book procedure for `<symbol>@depth` states that an event whose `u` is below the local book's update id must be ignored, which fixes the meaning of a LOWER id as stale — but that procedure is written for the depth stream, not for `bookTicker`.",
    conservativeBehavior:
      "A lower `u` is classified `REGRESSED` and is not emitted as a fresh top of book (it would overwrite newer state with older state); it is counted and returned to the caller, never silently discarded. No gap is inferred from a jump, because consecutive `bookTicker` updates are not documented to carry consecutive ids.",
  },
  {
    id: "BNC-U4",
    subject: "How `<symbol>@bookTicker` represents an empty book side",
    documented: "The documentation shows only populated best bid/ask examples.",
    conservativeBehavior:
      "A non-positive best price is not representable as the domain's positive `bidPrice`/`askPrice`, and mapping it to 'absent' would be an invention of the ADR-001 §8.1 kind ('an absent best bid is not a zero best bid'). The two cases are kept apart. ONE unusable side: that side is OMITTED from the event with its raw value recorded and a data-quality incident opened, and the other side is still published — the frame is `NORMALIZED` and counted as a partial top of book, because suppressing a real best ask on account of an unrepresentable best bid would discard an observation the venue did make. BOTH sides unusable: the frame is classified `UNREPRESENTABLE`, an incident is opened, and no event is emitted, because there would be nothing left to say.",
  },
  {
    id: "BNC-U6",
    subject: "Precision of integer JSON fields (`t`, `u`, `E`, `T`)",
    documented:
      "They are documented as JSON numbers (`REST` types the trade id as LONG); the documentation does not bound them below 2^53.",
    conservativeBehavior:
      "A parsed integer that is not a JavaScript safe integer is rejected with a typed error instead of being carried as a silently rounded value.",
  },
] as const;

/**
 * Register entries that were open and are now CLOSED, each with its authority.
 *
 * The counterpart of {@link BINANCE_UNVERIFIED}. Closing an item by deleting it
 * would erase both the question and the answer: an operator reading a recorded
 * event, or a reviewer reading a past handoff, still meets these ids. So the
 * entry stays, states WHO closed it, WHEN, and WHAT CHANGED in this package as a
 * result.
 *
 * The one entry here is not a venue fact that later became documented — Binance
 * documents `m` exactly as it always did. `BNC-U5` was a question about the
 * FROZEN DOMAIN CONTRACT's vocabulary, and only the contract owner could answer
 * it. It did, in ADR-014.
 */
export const BINANCE_RESOLVED = [
  {
    id: "BNC-U5",
    subject: "Which book side the domain's `takerSide` names",
    closedAt: "2026-08-28",
    remediatedAt: "2026-08-30",
    closedBy:
      "ADR-014 — takerSide names the aggressor order's own side — Accepted 2026-08-28, recorded by the GOV-1B contract-owner governance round. §1: `BID` ⇔ the taker was buying; `ASK` ⇔ the taker was selling. §2, stated separately because the readings are inverses: a buying taker consumes resting asks and is STILL recorded as `BID`. §3's Binance row derives this venue's mapping from the documented `m` ('Is the buyer the market maker?'): '`m = true → ASK` (the buyer was the maker, so the taker was the seller); `m = false → BID`'.",
    wasOpenBecause:
      "Binance documents `m` as 'Is the buyer the market maker?', and the frozen domain contract documented `takerSide` only as 'Taker side when the venue reports it' — which does not say whether `BID`/`ASK` names the side of the book the taker consumed or the direction of the taker's own order. The two readings map `m` to OPPOSITE values, so this package omitted the field rather than guess (ADR-002 §6).",
    whatChanged:
      "Ruled 2026-08-28, remediated in this package 2026-08-30, under ADR-014's mandatory bounded follow-up: (1) `takerSide` is now ALWAYS emitted on `ReferenceTradeObserved`, mapped `m = true → ASK`, `m = false → BID` — the pre-ruling `TAKER_ORDER_DIRECTION` behavior, which ADR-014 §7 verified conformant; (2) the selectable `BOOK_SIDE_CONSUMED` convention was DELETED, because it emits the inverse of the ruled meaning and ADR-014 §4.3 calls that 'a contract violation, not a configuration choice'; (3) the `takerSideConvention` option and its `OMIT` default were removed with it, and passing the removed key now throws `BinanceConfigurationError` instead of being ignored.",
    defaultDecision:
      "ADR-014's §7 follow-up item 3 required this package to decide AND state whether the default becomes the mapping or stays `OMIT`. DECIDED: the mapping, emitted unconditionally. `m` is documented on every `<symbol>@trade` payload, so the aggressor's role is always REPORTED rather than inferred, and ADR-002 §6's 'omit rather than guess' — the rule that justified the old default — no longer applies. No heuristic is used anywhere (ADR-014 §6).",
    preserved:
      "The venue's raw boolean is untouched: `buyerIsMaker` still survives verbatim on the decoded trade frame (`./frames.ts`), so a consumer can read Binance's own spelling without re-deriving it from the mapped side.",
  },
] as const;

/**
 * Rejects any endpoint that is not a documented public market-data endpoint.
 *
 * Fails closed: an unrecognized host is refused rather than allowed, because the
 * one Binance market-data host outside this list requires an API key and speaks
 * binary (see {@link BINANCE_SBE_ENDPOINT_HOST}), and a repository-wide rule
 * forbids credentials entirely.
 *
 * Returns the reason a host was refused, or `null` when it is acceptable. It is
 * a predicate rather than a thrower so the caller decides the error type; the
 * throwing wrapper lives in `./streams.ts`.
 */
export function explainNonPublicEndpoint(endpoint: string): string | null {
  if (endpoint.includes(BINANCE_SBE_ENDPOINT_HOST)) {
    return `\`${BINANCE_SBE_ENDPOINT_HOST}\` requires an API key and delivers binary SBE frames; this package is public-market-data only and holds no credential`;
  }
  const permitted: readonly string[] = BINANCE_PUBLIC_STREAM_ENDPOINTS;
  if (!permitted.includes(endpoint)) {
    return `endpoint must be one of the documented public market-data endpoints (${BINANCE_PUBLIC_STREAM_ENDPOINTS.join(", ")})`;
  }
  return null;
}
