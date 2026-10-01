/**
 * The research-tier downsampler (`STORAGE-1`; ADR-029 Decision 5;
 * `docs/handoffs/LEAN-1.md` §4).
 *
 * It consumes raw frames **in recorded dispatch order**, one gateway epoch at
 * a time, and emits samples. Every sample carries its **release frame** — the
 * recorded frame at which a live process would hold all of the sample's
 * information — and the samples are consumed in the dispatch order of their
 * release frames, with a fixed tie order. Nothing here ever sorts by instant.
 *
 * ## The two classes of sample (ADR-029 Decision 5.1)
 *
 * - **On-change samples** (every Polymarket trade, a lifecycle change, a
 *   Chainlink tick, a feed event) are released at the frame that carries
 *   them: their last contributing frame.
 * - **Span samples** summarize a span up to a boundary: a 1 s top of book, a
 *   1 s five-level depth, a 1 s reference-trade bar, and a 60 s full book.
 *   A span is released at the **first frame, in dispatch order, whose receipt
 *   instant is at or after its boundary**.
 *
 * ## Span membership follows dispatch order (Decision 5.1)
 *
 * A span stays open until its release frame. Every frame dispatched while it
 * is open belongs to it, **whatever its receipt instant**; the release frame
 * and everything after it belong to a later span, even if their instant lies
 * before the boundary. The instant decides only when a span closes. So F1
 * (`ingestSeq` 1, 10,000 ms) releases the [9,000, 10,000) bar and F2
 * (`ingestSeq` 2, 9,999 ms) lands in the [10,000, 11,000) bar.
 *
 * Mechanically: a span summary is taken **before** the release frame's own
 * content is applied, so it holds only frames dispatched before it. One frame
 * can close a span after a gap in the data; the empty spans in between hold no
 * frame and produce no sample, and the frame belongs to the span open after
 * them. A span with no release frame in its epoch is never released (5.1).
 *
 * ## The fixed tie order (Decision 5.3)
 *
 * Samples released at one frame are consumed in this order, which this
 * downsampling version defines:
 *
 * 1. span samples, by span boundary; at one boundary by kind —
 *    `pm_top_of_book`, `pm_depth`, `pm_full_book`, `ref_trade_bars` — and
 *    within a kind by token id or by `source|instrument`, as strings;
 * 2. then the frame's own on-change samples: its `feed_events` first, then
 *    its trades, lifecycle events and ticks in the order the frame carries
 *    them.
 *
 * `sampleOrdinal` is assigned in exactly that order, so it is the consumption
 * order.
 *
 * ## What is downsampled, and how (LEAN-1 §4)
 *
 * - top of book, with sizes: at most one per token per 1 s span, emitted when
 *   it differs from the last one emitted for the token;
 * - five levels a side: at most one per token per 1 s span, when it differs;
 * - the full book: one per token per 60 s span that held at least one frame;
 * - every Polymarket trade; every lifecycle event, a Gamma poll only when its
 *   documented state changed;
 * - per reference instrument, a 1 s OHLCV bar of its trades (Binance trades,
 *   Coinbase `update` trades; a Coinbase `snapshot` is history and is
 *   excluded and counted);
 * - every Chainlink tick.
 *
 * A Polymarket book is reconstructed from `book` snapshots and `price_change`
 * absolute sizes (ADR-013); until a token's first snapshot — and again after a
 * reconnect, a resubscription or an unreadable level — the token has no book
 * and emits no book sample. Missing is stated by absence, never guessed.
 *
 * Every value is a canonical decimal string; sums use exact decimal
 * arithmetic (ADR-001).
 */

import { addDecimal, compareDecimal } from "@polymarket-bot/decimal";
import type {
  RawFrameRecord,
  ResearchDownsampling,
  ResearchRow,
  ResearchTableName,
} from "@polymarket-bot/storage-parquet";
import { compareUnsignedIntegerStrings, RESEARCH_DEPTH_LEVELS } from "@polymarket-bot/storage-parquet";

import type { Interpretation, Level, Observation } from "./interpret.js";
import { isPolymarketMarketChannel } from "./interpret.js";

/** The 1 s span of LEAN-1 §4. */
export const SPAN_MS = 1_000;
/** The full-book span of LEAN-1 §4. */
export const FULL_BOOK_SPAN_MS = 60_000;
/** Recent trade ids remembered per reference instrument, for de-duplication. */
export const REFERENCE_TRADE_DEDUPE_WINDOW = 512;

/** The downsampling version every research-tier manifest pins (ADR-029 1.4). */
export const RESEARCH_DOWNSAMPLING: ResearchDownsampling = {
  downsamplingId: "polymarket-bot/research-downsampling/v1",
  downsamplingVersion: 1,
  parameters: {
    spanMs: SPAN_MS,
    fullBookSpanMs: FULL_BOOK_SPAN_MS,
    depthLevels: RESEARCH_DEPTH_LEVELS,
    referenceTradeDedupeWindow: REFERENCE_TRADE_DEDUPE_WINDOW,
  },
  tieOrder:
    "release frame ingestSeq; then span samples by span boundary, at one boundary by kind " +
    "(pm_top_of_book, pm_depth, pm_full_book, ref_trade_bars) and within a kind by token id or " +
    "source|instrument; then the release frame's own feed_events, then its trades, lifecycle " +
    "events and ticks in frame order",
};

/** The version of the serialized {@link SamplerState}. */
export const SAMPLER_STATE_VERSION = 1;

type Book = {
  conditionId: string;
  initialized: boolean;
  bids: Map<string, string>;
  asks: Map<string, string>;
};

type Bar = { open: string; high: string; low: string; close: string; volume: string; count: number };

type SpanClock = { openStartMs: number | null; frameCount: number };

/** The downsampler's state, serializable, carried from one dataset to the next. */
export type SamplerState = {
  readonly stateVersion: number;
  readonly downsamplingId: string;
  readonly gatewayEpoch: string;
  readonly lastIngestSeq: string | null;
  readonly lastSegmentId: string | null;
  readonly span: SpanClock;
  readonly fullBookSpan: SpanClock;
  readonly books: Readonly<
    Record<string, { conditionId: string; initialized: boolean; bids: Level[]; asks: Level[] }>
  >;
  readonly lastTopOfBook: Readonly<Record<string, string>>;
  readonly lastDepth: Readonly<Record<string, string>>;
  readonly bars: Readonly<Record<string, Bar>>;
  readonly recentTradeIds: Readonly<Record<string, string[]>>;
  readonly connections: Readonly<Record<string, string>>;
  readonly lastLifecycle: Readonly<Record<string, string>>;
};

const CANONICAL_NON_NEGATIVE = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/u;

/** Exact comparison of two canonical decimals, with a fast path for plain non-negatives. */
export function compareCanonical(left: string, right: string): number {
  if (left === right) return 0;
  if (CANONICAL_NON_NEGATIVE.test(left) && CANONICAL_NON_NEGATIVE.test(right)) {
    const [leftInt = "", leftFrac = ""] = left.split(".");
    const [rightInt = "", rightFrac = ""] = right.split(".");
    if (leftInt.length !== rightInt.length) return leftInt.length < rightInt.length ? -1 : 1;
    if (leftInt !== rightInt) return leftInt < rightInt ? -1 : 1;
    const width = Math.max(leftFrac.length, rightFrac.length);
    const a = leftFrac.padEnd(width, "0");
    const b = rightFrac.padEnd(width, "0");
    return a === b ? 0 : a < b ? -1 : 1;
  }
  return compareDecimal(left, right);
}

const ISO = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/u;

/**
 * Epoch milliseconds of a recorded receipt instant, truncated to the
 * millisecond. Refuses anything that is not the WAL's ISO-8601 grammar.
 */
export function epochMsOf(instant: string): number {
  const match = ISO.exec(instant);
  if (match === null) throw new Error(`not an ISO-8601 instant: ${JSON.stringify(instant)}`);
  const fraction = (match[2] ?? "").padEnd(3, "0").slice(0, 3);
  const value = Date.parse(`${match[1] ?? ""}.${fraction}${match[3] ?? ""}`);
  if (!Number.isFinite(value)) throw new Error(`not a valid instant: ${JSON.stringify(instant)}`);
  return value;
}

function sortedLevels(side: Map<string, string>, descending: boolean): Level[] {
  const levels: Level[] = [...side.entries()].map(([price, size]) => [price, size] as const);
  levels.sort((left, right) => (descending ? -1 : 1) * compareCanonical(left[0], right[0]));
  return levels;
}

function freshClock(): SpanClock {
  return { openStartMs: null, frameCount: 0 };
}

/** Counts a reader can reconcile. */
export type SamplerCounts = {
  framesConsumed: number;
  framesInterpreted: number;
  framesUninterpreted: number;
  /** Frames skipped because their ingestSeq did not advance (a duplicate copy). */
  framesSkippedNotAdvancing: number;
  readonly uninterpretedByCategory: Map<string, number>;
};

/**
 * The downsampler. One instance per extraction: it starts from a fresh state
 * (an epoch's first segment, or a stated discontinuity) or from the previous
 * dataset's end state, and its {@link exportState} is the next one's start.
 */
export class ResearchSampler {
  readonly #gatewayEpoch: string;
  readonly #rows = new Map<ResearchTableName, ResearchRow[]>();
  #nextOrdinal = 0;
  #lastIngestSeq: string | null;
  #lastSegmentId: string | null;
  readonly #span: SpanClock;
  readonly #fullBookSpan: SpanClock;
  readonly #books = new Map<string, Book>();
  readonly #lastTopOfBook = new Map<string, string>();
  readonly #lastDepth = new Map<string, string>();
  readonly #bars = new Map<string, Bar>();
  readonly #recentTradeIds = new Map<string, string[]>();
  readonly #recentTradeIdSets = new Map<string, Set<string>>();
  readonly #connections = new Map<string, string>();
  readonly #lastLifecycle = new Map<string, string>();
  readonly counts: SamplerCounts = {
    framesConsumed: 0,
    framesInterpreted: 0,
    framesUninterpreted: 0,
    framesSkippedNotAdvancing: 0,
    uninterpretedByCategory: new Map(),
  };

  constructor(input: { readonly gatewayEpoch: string; readonly state: SamplerState | null }) {
    this.#gatewayEpoch = input.gatewayEpoch;
    const state = input.state;
    if (state === null) {
      this.#lastIngestSeq = null;
      this.#lastSegmentId = null;
      this.#span = freshClock();
      this.#fullBookSpan = freshClock();
      return;
    }
    if (state.stateVersion !== SAMPLER_STATE_VERSION || state.downsamplingId !== RESEARCH_DOWNSAMPLING.downsamplingId) {
      throw new Error("the sampler state was written by a different downsampling version");
    }
    if (state.gatewayEpoch !== input.gatewayEpoch) {
      throw new Error("a sampler state cannot cross gateway epochs (ADR-029 Decision 5.4)");
    }
    this.#lastIngestSeq = state.lastIngestSeq;
    this.#lastSegmentId = state.lastSegmentId;
    this.#span = { ...state.span };
    this.#fullBookSpan = { ...state.fullBookSpan };
    for (const [tokenId, book] of Object.entries(state.books)) {
      this.#books.set(tokenId, {
        conditionId: book.conditionId,
        initialized: book.initialized,
        bids: new Map(book.bids.map(([price, size]) => [price, size])),
        asks: new Map(book.asks.map(([price, size]) => [price, size])),
      });
    }
    for (const [key, value] of Object.entries(state.lastTopOfBook)) this.#lastTopOfBook.set(key, value);
    for (const [key, value] of Object.entries(state.lastDepth)) this.#lastDepth.set(key, value);
    for (const [key, value] of Object.entries(state.bars)) this.#bars.set(key, { ...value });
    for (const [key, ids] of Object.entries(state.recentTradeIds)) {
      this.#recentTradeIds.set(key, [...ids]);
      this.#recentTradeIdSets.set(key, new Set(ids));
    }
    for (const [key, value] of Object.entries(state.connections)) this.#connections.set(key, value);
    for (const [key, value] of Object.entries(state.lastLifecycle)) this.#lastLifecycle.set(key, value);
  }

  /** The id of the last segment whose frames this sampler consumed. */
  get lastSegmentId(): string | null {
    return this.#lastSegmentId;
  }

  /** Every row emitted so far, by table. */
  rows(): ReadonlyMap<ResearchTableName, readonly ResearchRow[]> {
    return this.#rows;
  }

  /** Samples emitted so far. */
  get samplesEmitted(): number {
    return this.#nextOrdinal;
  }

  /** Consume one frame, in recorded dispatch order. */
  consume(input: {
    readonly record: RawFrameRecord;
    readonly segmentId: string;
    readonly interpretation: Interpretation;
  }): void {
    const { record, segmentId, interpretation } = input;
    if (record.gatewayEpoch !== this.#gatewayEpoch) {
      throw new Error("a frame from another gateway epoch reached the sampler (ADR-029 Decision 5.4)");
    }
    this.#lastSegmentId = segmentId;
    // Within one epoch `ingestSeq` is the dispatch order (§7.1). A frame whose
    // ingestSeq does not advance is a re-recorded copy at a WAL fault boundary
    // (wal-format.md §12): first wins, as in the compactor.
    if (this.#lastIngestSeq !== null && compareUnsignedIntegerStrings(record.ingestSeq, this.#lastIngestSeq) <= 0) {
      this.counts.framesSkippedNotAdvancing += 1;
      return;
    }
    this.#lastIngestSeq = record.ingestSeq;
    this.counts.framesConsumed += 1;
    if (interpretation.interpreted) {
      this.counts.framesInterpreted += 1;
    } else {
      this.counts.framesUninterpreted += 1;
      this.counts.uninterpretedByCategory.set(
        interpretation.category,
        (this.counts.uninterpretedByCategory.get(interpretation.category) ?? 0) + 1,
      );
    }

    const release = {
      gatewayEpoch: record.gatewayEpoch,
      releaseIngestSeq: record.ingestSeq,
      availableAt: record.receivedAt,
      releaseSegmentId: segmentId,
    };
    const atMs = epochMsOf(record.receivedAt);

    // -- 1. Spans this frame closes, released BEFORE its content applies. --
    const oneSecond = this.#advance(this.#span, SPAN_MS, atMs);
    const sixtySeconds = this.#advance(this.#fullBookSpan, FULL_BOOK_SPAN_MS, atMs);
    const boundaries = [...new Set([oneSecond?.endMs, sixtySeconds?.endMs].filter((end) => end !== undefined))].sort(
      (left, right) => left - right,
    );
    for (const boundary of boundaries) {
      if (oneSecond !== null && oneSecond.endMs === boundary) {
        this.#emitTopOfBook(release, oneSecond);
        this.#emitDepth(release, oneSecond);
      }
      if (sixtySeconds !== null && sixtySeconds.endMs === boundary) {
        this.#emitFullBook(release, sixtySeconds);
      }
      if (oneSecond !== null && oneSecond.endMs === boundary) {
        this.#emitBars(release, oneSecond);
      }
    }
    // Every frame, the release frame included, belongs to the span now open.
    this.#span.frameCount += 1;
    this.#fullBookSpan.frameCount += 1;

    // -- 2. The frame's own on-change samples. --------------------------
    this.#noteConnection(record, release);
    if (interpretation.problems.length > 0) {
      this.#emit("feed_events", release, {
        source: record.source,
        endpoint: record.endpoint,
        connectionId: record.connectionId,
        subscriptionGeneration: record.subscriptionGeneration,
        eventKind: "uninterpretable",
        detail: `${interpretation.category}: ${interpretation.problems.join(" | ")}`.slice(0, 1000),
        payloadSha256: record.payloadSha256,
      });
    }
    if (interpretation.snapshotTradesExcluded > 0) {
      this.#emit("feed_events", release, {
        source: record.source,
        endpoint: record.endpoint,
        connectionId: record.connectionId,
        subscriptionGeneration: record.subscriptionGeneration,
        eventKind: "snapshot-trades-excluded",
        detail: `${String(interpretation.snapshotTradesExcluded)} snapshot trade(s) are history and were excluded from bars`,
        payloadSha256: record.payloadSha256,
      });
    }
    for (const observation of interpretation.observations) {
      this.#apply(observation, record, release);
    }
  }

  /** The state a later dataset of this epoch resumes from. */
  exportState(): SamplerState {
    const sortedRecord = <T>(map: Map<string, T>): Record<string, T> =>
      Object.fromEntries([...map.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
    const books = new Map<string, { conditionId: string; initialized: boolean; bids: Level[]; asks: Level[] }>();
    for (const [tokenId, book] of this.#books) {
      books.set(tokenId, {
        conditionId: book.conditionId,
        initialized: book.initialized,
        bids: sortedLevels(book.bids, true),
        asks: sortedLevels(book.asks, false),
      });
    }
    return {
      stateVersion: SAMPLER_STATE_VERSION,
      downsamplingId: RESEARCH_DOWNSAMPLING.downsamplingId,
      gatewayEpoch: this.#gatewayEpoch,
      lastIngestSeq: this.#lastIngestSeq,
      lastSegmentId: this.#lastSegmentId,
      span: { ...this.#span },
      fullBookSpan: { ...this.#fullBookSpan },
      books: sortedRecord(books),
      lastTopOfBook: sortedRecord(this.#lastTopOfBook),
      lastDepth: sortedRecord(this.#lastDepth),
      bars: sortedRecord(new Map([...this.#bars.entries()].map(([key, bar]) => [key, { ...bar }]))),
      recentTradeIds: sortedRecord(new Map([...this.#recentTradeIds.entries()].map(([key, ids]) => [key, [...ids]]))),
      connections: sortedRecord(this.#connections),
      lastLifecycle: sortedRecord(this.#lastLifecycle),
    };
  }

  // -- spans ---------------------------------------------------------------

  /**
   * Advance one span clock to a frame's instant. Returns the span the frame
   * releases, or `null`. A span that held no frame releases nothing.
   */
  #advance(clock: SpanClock, spanMs: number, atMs: number): { startMs: number; endMs: number } | null {
    if (clock.openStartMs === null) {
      clock.openStartMs = Math.floor(atMs / spanMs) * spanMs;
      clock.frameCount = 0;
      return null;
    }
    const boundary = clock.openStartMs + spanMs;
    if (atMs < boundary) return null; // the frame belongs to the open span, whatever its instant
    const closed = clock.frameCount > 0 ? { startMs: clock.openStartMs, endMs: boundary } : null;
    clock.openStartMs = Math.floor(atMs / spanMs) * spanMs;
    clock.frameCount = 0;
    return closed;
  }

  #initializedBooks(): [string, Book][] {
    return [...this.#books.entries()]
      .filter(([, book]) => book.initialized)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  }

  #emitTopOfBook(release: Release, span: { startMs: number; endMs: number }): void {
    for (const [tokenId, book] of this.#initializedBooks()) {
      const bid = sortedLevels(book.bids, true)[0] ?? null;
      const ask = sortedLevels(book.asks, false)[0] ?? null;
      const key = JSON.stringify([bid, ask]);
      if (this.#lastTopOfBook.get(tokenId) === key) continue;
      this.#lastTopOfBook.set(tokenId, key);
      this.#emit("pm_top_of_book", release, {
        spanStartMs: span.startMs,
        spanEndMs: span.endMs,
        conditionId: book.conditionId,
        tokenId,
        bestBidPrice: bid?.[0] ?? null,
        bestBidSize: bid?.[1] ?? null,
        bestAskPrice: ask?.[0] ?? null,
        bestAskSize: ask?.[1] ?? null,
      });
    }
  }

  #emitDepth(release: Release, span: { startMs: number; endMs: number }): void {
    for (const [tokenId, book] of this.#initializedBooks()) {
      const bids = sortedLevels(book.bids, true).slice(0, RESEARCH_DEPTH_LEVELS);
      const asks = sortedLevels(book.asks, false).slice(0, RESEARCH_DEPTH_LEVELS);
      const key = JSON.stringify([bids, asks]);
      if (this.#lastDepth.get(tokenId) === key) continue;
      this.#lastDepth.set(tokenId, key);
      const row: Record<string, string | number | null> = {
        spanStartMs: span.startMs,
        spanEndMs: span.endMs,
        conditionId: book.conditionId,
        tokenId,
      };
      for (let level = 1; level <= RESEARCH_DEPTH_LEVELS; level += 1) {
        row[`bid${String(level)}Price`] = bids[level - 1]?.[0] ?? null;
        row[`bid${String(level)}Size`] = bids[level - 1]?.[1] ?? null;
      }
      for (let level = 1; level <= RESEARCH_DEPTH_LEVELS; level += 1) {
        row[`ask${String(level)}Price`] = asks[level - 1]?.[0] ?? null;
        row[`ask${String(level)}Size`] = asks[level - 1]?.[1] ?? null;
      }
      this.#emit("pm_depth", release, row);
    }
  }

  #emitFullBook(release: Release, span: { startMs: number; endMs: number }): void {
    for (const [tokenId, book] of this.#initializedBooks()) {
      const bids = sortedLevels(book.bids, true);
      const asks = sortedLevels(book.asks, false);
      this.#emit("pm_full_book", release, {
        spanStartMs: span.startMs,
        spanEndMs: span.endMs,
        conditionId: book.conditionId,
        tokenId,
        bidLevelCount: bids.length,
        askLevelCount: asks.length,
        bidsJson: JSON.stringify(bids),
        asksJson: JSON.stringify(asks),
      });
    }
  }

  #emitBars(release: Release, span: { startMs: number; endMs: number }): void {
    const keys = [...this.#bars.keys()].sort();
    for (const key of keys) {
      const bar = this.#bars.get(key);
      if (bar === undefined || bar.count === 0) continue;
      const separator = key.indexOf("|");
      this.#emit("ref_trade_bars", release, {
        spanStartMs: span.startMs,
        spanEndMs: span.endMs,
        source: key.slice(0, separator),
        instrument: key.slice(separator + 1),
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
        tradeCount: bar.count,
      });
    }
    this.#bars.clear();
  }

  // -- on-change -----------------------------------------------------------

  #noteConnection(record: RawFrameRecord, release: Release): void {
    const key = `${record.source}|${record.endpoint}`;
    const identity = `${record.connectionId}#${String(record.subscriptionGeneration)}`;
    const previous = this.#connections.get(key);
    if (previous === identity) return;
    this.#connections.set(key, identity);
    if (isPolymarketMarketChannel(record)) {
      // A new connection or subscription generation re-snapshots every book;
      // until each token's snapshot arrives, its old book is not current.
      for (const book of this.#books.values()) book.initialized = false;
    }
    this.#emit("feed_events", release, {
      source: record.source,
      endpoint: record.endpoint,
      connectionId: record.connectionId,
      subscriptionGeneration: record.subscriptionGeneration,
      eventKind: previous === undefined ? "connection-observed" : "connection-changed",
      detail: previous === undefined ? `first seen as ${identity}` : `${previous} -> ${identity}`,
      payloadSha256: record.payloadSha256,
    });
  }

  #apply(observation: Observation, record: RawFrameRecord, release: Release): void {
    switch (observation.kind) {
      case "pm-book":
        this.#books.set(observation.tokenId, {
          conditionId: observation.conditionId,
          initialized: true,
          bids: new Map(observation.bids.map(([price, size]) => [price, size])),
          asks: new Map(observation.asks.map(([price, size]) => [price, size])),
        });
        return;
      case "pm-level": {
        const book = this.#books.get(observation.tokenId);
        if (book === undefined || !book.initialized) return; // no snapshot yet: nothing to apply a delta to
        const side = observation.side === "BID" ? book.bids : book.asks;
        // ADR-013: a price_change size is the absolute new size; zero removes the level.
        if (compareCanonical(observation.size, "0") === 0) side.delete(observation.price);
        else side.set(observation.price, observation.size);
        return;
      }
      case "pm-book-invalid": {
        const book = this.#books.get(observation.tokenId);
        if (book !== undefined) book.initialized = false;
        return;
      }
      case "pm-trade":
        this.#emit("pm_trades", release, {
          conditionId: observation.conditionId,
          tokenId: observation.tokenId,
          entryIndex: observation.entryIndex,
          price: observation.price,
          size: observation.size,
          side: observation.side,
          feeRateBps: observation.feeRateBps,
          venueTimestamp: observation.venueTimestamp,
          transactionHash: observation.transactionHash,
        });
        return;
      case "pm-lifecycle": {
        const row = {
          source: record.source,
          endpoint: record.endpoint,
          eventType: observation.eventType,
          entryIndex: observation.entryIndex,
          conditionId: observation.conditionId,
          tokenId: observation.tokenId,
          active: observation.active,
          closed: observation.closed,
          acceptingOrders: observation.acceptingOrders,
          archived: observation.archived,
          restricted: observation.restricted,
          detailJson: observation.detailJson,
          payloadSha256: record.payloadSha256,
        };
        if (observation.eventType === "gamma-market") {
          // A poll is a lifecycle sample only when its documented state changed.
          const key = record.endpoint;
          const state = JSON.stringify([
            observation.conditionId,
            observation.active,
            observation.closed,
            observation.acceptingOrders,
            observation.archived,
            observation.restricted,
            observation.detailJson,
          ]);
          if (this.#lastLifecycle.get(key) === state) return;
          this.#lastLifecycle.set(key, state);
        }
        this.#emit("pm_lifecycle", release, row);
        return;
      }
      case "ref-trade": {
        const key = `${observation.source}|${observation.instrument}`;
        if (!this.#rememberTrade(key, observation.tradeId)) return;
        const bar = this.#bars.get(key);
        if (bar === undefined) {
          this.#bars.set(key, {
            open: observation.price,
            high: observation.price,
            low: observation.price,
            close: observation.price,
            volume: observation.size,
            count: 1,
          });
          return;
        }
        if (compareCanonical(observation.price, bar.high) > 0) bar.high = observation.price;
        if (compareCanonical(observation.price, bar.low) < 0) bar.low = observation.price;
        bar.close = observation.price;
        bar.volume = addDecimal(bar.volume, observation.size);
        bar.count += 1;
        return;
      }
      case "chainlink":
        this.#emit("chainlink_ticks", release, {
          topic: observation.topic,
          symbol: observation.symbol,
          entryIndex: observation.entryIndex,
          value: observation.value,
          observedAt: observation.observedAt,
        });
        return;
    }
  }

  /** Remember a trade id; false when it was already seen recently (a duplicate). */
  #rememberTrade(key: string, tradeId: string): boolean {
    let ids = this.#recentTradeIds.get(key);
    let set = this.#recentTradeIdSets.get(key);
    if (ids === undefined || set === undefined) {
      ids = [];
      set = new Set();
      this.#recentTradeIds.set(key, ids);
      this.#recentTradeIdSets.set(key, set);
    }
    if (set.has(tradeId)) return false;
    ids.push(tradeId);
    set.add(tradeId);
    if (ids.length > REFERENCE_TRADE_DEDUPE_WINDOW) {
      const evicted = ids.shift();
      if (evicted !== undefined) set.delete(evicted);
    }
    return true;
  }

  #emit(table: ResearchTableName, release: Release, fields: Readonly<Record<string, string | number | boolean | null>>): void {
    let rows = this.#rows.get(table);
    if (rows === undefined) {
      rows = [];
      this.#rows.set(table, rows);
    }
    rows.push({
      sampleOrdinal: this.#nextOrdinal,
      gatewayEpoch: release.gatewayEpoch,
      releaseIngestSeq: release.releaseIngestSeq,
      availableAt: release.availableAt,
      releaseSegmentId: release.releaseSegmentId,
      ...fields,
    });
    this.#nextOrdinal += 1;
  }
}

type Release = {
  readonly gatewayEpoch: string;
  readonly releaseIngestSeq: string;
  readonly availableAt: string;
  readonly releaseSegmentId: string;
};

/** Encode a sampler state deterministically. */
export function encodeSamplerState(state: SamplerState): Uint8Array {
  return Buffer.from(`${JSON.stringify(state)}\n`, "utf8");
}

/** Decode a sampler state the extractor wrote. The caller verifies its digest first. */
export function decodeSamplerState(bytes: Uint8Array): SamplerState {
  const value = JSON.parse(Buffer.from(bytes).toString("utf8")) as SamplerState;
  if (typeof value !== "object" || value === null || value.stateVersion !== SAMPLER_STATE_VERSION) {
    throw new Error("not a sampler state this build reads");
  }
  return value;
}
