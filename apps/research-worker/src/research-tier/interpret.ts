/**
 * Reading one raw WAL frame into the facts the research tier keeps.
 *
 * Every venue interpretation here goes through the **shipped, venue-verified
 * adapter doors** — never a parser written for this module:
 *
 * | Source | Door |
 * | --- | --- |
 * | Polymarket market channel | `decodeInboundFrame` + `parseMarketEvent` (`WP-070`, ADR-013: a `price_change` size is the absolute new size) |
 * | Gamma market polls | `readGammaMarketBody` (`UNIV-4`; the six documented state fields only) |
 * | RTDS Chainlink TWAP | `decodeInboundRtdsFrame` + `normalizeRtdsFrame` (`WP-100`) |
 * | Binance | `decodeFrame` (`WP-080`) |
 * | Coinbase | `classifyFrame` (`WP-090`) |
 *
 * so the research tier cannot read a venue differently from the trader. Every
 * decimal is canonicalised by `@polymarket-bot/decimal`; a value that does not
 * canonicalise is a problem, never a guess.
 *
 * A frame the research tier does not keep (a heartbeat, a Binance
 * `bookTicker`, a Coinbase ticker) is **uninterpreted by design**, and counted
 * by category; the raw frame itself is in the WAL, and in a pin when one
 * covers it. The research tier is approximate (ADR-029).
 */

import { BINANCE_EVENT_SOURCE, decodeFrame } from "@polymarket-bot/binance-adapter";
import { classifyFrame } from "@polymarket-bot/coinbase-adapter";
import { tryNormalizeDecimalString } from "@polymarket-bot/decimal";
import { decodeInboundFrame, parseMarketEvent } from "@polymarket-bot/polymarket-public";
import { readGammaMarketBody } from "@polymarket-bot/polymarket-public/market-state";
import {
  DEFAULT_RTDS_TWAP_FEED_OPTIONS,
  RTDS_TWAP_TOPIC_BY_WINDOW,
  TwapObservationTracker,
  decodeInboundRtdsFrame,
  normalizeRtdsFrame,
} from "@polymarket-bot/polymarket-public/rtds";
import type { RawFrameRecord } from "@polymarket-bot/storage-parquet";

import { GAMMA_MARKET_ENDPOINT_PREFIX, POLYMARKET_MARKET_ENDPOINT_PREFIX } from "./identity.js";

/** A book level as canonical decimal strings. */
export type Level = readonly [price: string, size: string];

/** One fact a frame carries, in the order the frame carries it. */
export type Observation =
  | {
      readonly kind: "pm-book";
      readonly entryIndex: number;
      readonly conditionId: string;
      readonly tokenId: string;
      readonly bids: readonly Level[];
      readonly asks: readonly Level[];
    }
  | {
      readonly kind: "pm-level";
      readonly entryIndex: number;
      readonly conditionId: string;
      readonly tokenId: string;
      readonly side: "BID" | "ASK";
      readonly price: string;
      readonly size: string;
    }
  | {
      /** A level that could not be read: the token's book can no longer be trusted. */
      readonly kind: "pm-book-invalid";
      readonly entryIndex: number;
      readonly tokenId: string;
    }
  | {
      readonly kind: "pm-trade";
      readonly entryIndex: number;
      readonly conditionId: string;
      readonly tokenId: string;
      readonly price: string;
      readonly size: string | null;
      readonly side: string;
      readonly feeRateBps: string | null;
      readonly venueTimestamp: string | null;
      readonly transactionHash: string | null;
    }
  | {
      readonly kind: "pm-lifecycle";
      readonly entryIndex: number;
      readonly eventType: "gamma-market" | "tick_size_change" | "new_market" | "market_resolved";
      readonly conditionId: string | null;
      readonly tokenId: string | null;
      readonly active: boolean | null;
      readonly closed: boolean | null;
      readonly acceptingOrders: boolean | null;
      readonly archived: boolean | null;
      readonly restricted: boolean | null;
      readonly detailJson: string | null;
    }
  | {
      readonly kind: "ref-trade";
      readonly entryIndex: number;
      readonly source: "binance" | "coinbase";
      readonly instrument: string;
      readonly tradeId: string;
      readonly price: string;
      readonly size: string;
    }
  | {
      readonly kind: "chainlink";
      readonly entryIndex: number;
      readonly topic: string;
      readonly symbol: string;
      readonly value: string;
      readonly observedAt: string | null;
    };

/** What one frame turned out to be. */
export type Interpretation = {
  /** A stable label for counting: what kind of frame this was. */
  readonly category: string;
  /** True when the frame carried something the research tier keeps. */
  readonly interpreted: boolean;
  readonly observations: readonly Observation[];
  /** Bounded descriptions of what could not be read. */
  readonly problems: readonly string[];
  /** Coinbase `snapshot` trades, which are history and are excluded from bars. */
  readonly snapshotTradesExcluded: number;
};

const MAX_PROBLEMS = 8;
const MAX_PROBLEM_LENGTH = 200;


/** Whether a raw record is the Polymarket market channel. */
export function isPolymarketMarketChannel(record: RawFrameRecord): boolean {
  return record.source === "polymarket" && record.endpoint.startsWith(POLYMARKET_MARKET_ENDPOINT_PREFIX);
}

function canonical(value: unknown): string | null {
  const outcome = tryNormalizeDecimalString(value);
  return outcome.ok ? outcome.value : null;
}

function bounded(text: string): string {
  return text.length <= MAX_PROBLEM_LENGTH ? text : `${text.slice(0, MAX_PROBLEM_LENGTH)}…`;
}

function result(
  category: string,
  observations: readonly Observation[],
  problems: readonly string[],
  snapshotTradesExcluded = 0,
): Interpretation {
  return {
    category,
    interpreted: observations.length > 0,
    observations,
    problems: problems.slice(0, MAX_PROBLEMS).map(bounded),
    snapshotTradesExcluded,
  };
}

function levels(raw: readonly { readonly price: string; readonly size: string }[]): Level[] | null {
  const out: Level[] = [];
  for (const level of raw) {
    const price = canonical(level.price);
    const size = canonical(level.size);
    if (price === null || size === null) return null;
    out.push([price, size]);
  }
  return out;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function interpretPolymarketMarket(payload: string): Interpretation {
  const decoded = decodeInboundFrame(payload);
  if (decoded.kind === "pong") return result("polymarket-pong", [], []);
  if (decoded.kind === "unparsable") return result("polymarket-unparsable", [], [decoded.reason]);
  const observations: Observation[] = [];
  const problems: string[] = [];
  decoded.values.forEach((value, entryIndex) => {
    const parsed = parseMarketEvent(value);
    if (parsed.status === "unknown-event-type") {
      problems.push(`unknown market event type ${parsed.eventType}`);
      return;
    }
    if (parsed.status !== "parsed") {
      problems.push(
        parsed.status === "invalid" ? `invalid ${parsed.eventType}: ${parsed.issues.join("; ")}` : "unrecognized market event",
      );
      return;
    }
    const event = parsed.event;
    switch (event.event_type) {
      case "book": {
        const bids = levels(event.bids);
        const asks = levels(event.asks);
        if (bids === null || asks === null) {
          problems.push("a book snapshot level is not a canonical decimal");
          observations.push({ kind: "pm-book-invalid", entryIndex, tokenId: event.asset_id });
          return;
        }
        observations.push({
          kind: "pm-book",
          entryIndex,
          conditionId: event.market,
          tokenId: event.asset_id,
          bids,
          asks,
        });
        return;
      }
      case "price_change": {
        for (const change of event.price_changes) {
          const price = canonical(change.price);
          const size = canonical(change.size);
          const side = change.side === "BUY" ? "BID" : change.side === "SELL" ? "ASK" : null;
          if (price === null || size === null || side === null) {
            problems.push(`a price_change entry for ${change.asset_id} could not be read`);
            observations.push({ kind: "pm-book-invalid", entryIndex, tokenId: change.asset_id });
            continue;
          }
          observations.push({
            kind: "pm-level",
            entryIndex,
            conditionId: event.market,
            tokenId: change.asset_id,
            side,
            price,
            size,
          });
        }
        return;
      }
      case "last_trade_price": {
        const price = canonical(event.price);
        if (price === null) {
          problems.push("a last_trade_price price is not a canonical decimal");
          return;
        }
        const size = event.size === null || event.size === undefined ? null : canonical(event.size);
        const fee =
          event.fee_rate_bps === null || event.fee_rate_bps === undefined ? null : canonical(event.fee_rate_bps);
        observations.push({
          kind: "pm-trade",
          entryIndex,
          conditionId: event.market,
          tokenId: event.asset_id,
          price,
          size,
          side: event.side,
          feeRateBps: fee,
          venueTimestamp:
            event.timestamp === null || event.timestamp === undefined ? null : String(event.timestamp),
          transactionHash: stringOrNull(event.transaction_hash),
        });
        return;
      }
      case "tick_size_change":
        observations.push({
          kind: "pm-lifecycle",
          entryIndex,
          eventType: "tick_size_change",
          conditionId: event.market,
          tokenId: event.asset_id,
          active: null,
          closed: null,
          acceptingOrders: null,
          archived: null,
          restricted: null,
          detailJson: JSON.stringify({
            newTickSize: event.new_tick_size,
            oldTickSize: event.old_tick_size ?? null,
          }),
        });
        return;
      case "new_market":
        observations.push({
          kind: "pm-lifecycle",
          entryIndex,
          eventType: "new_market",
          conditionId: event.market,
          tokenId: null,
          active: event.active ?? null,
          closed: null,
          acceptingOrders: null,
          archived: null,
          restricted: null,
          detailJson: JSON.stringify({ id: event.id, assetIds: event.assets_ids ?? null }),
        });
        return;
      case "market_resolved":
        observations.push({
          kind: "pm-lifecycle",
          entryIndex,
          eventType: "market_resolved",
          conditionId: event.market,
          tokenId: null,
          active: null,
          closed: null,
          acceptingOrders: null,
          archived: null,
          restricted: null,
          detailJson: JSON.stringify({
            id: event.id,
            winningAssetId: event.winning_asset_id ?? null,
            winningOutcome: event.winning_outcome ?? null,
          }),
        });
        return;
      case "best_bid_ask":
        // The research tier derives top of book from the book itself.
        return;
    }
  });
  return result("polymarket-market", observations, problems);
}

function interpretGamma(payload: string): Interpretation {
  const verdict = readGammaMarketBody(payload);
  if (verdict.status !== "ok") return result("gamma-invalid", [], [verdict.issues.join("; ")]);
  return result(
    "gamma-market",
    [
      {
        kind: "pm-lifecycle",
        entryIndex: 0,
        eventType: "gamma-market",
        // The poll is identified by its endpoint (kept in the row), not by a
        // body scalar the door does not interpret.
        conditionId: null,
        tokenId: null,
        active: verdict.state.active,
        closed: verdict.state.closed,
        acceptingOrders: verdict.state.acceptingOrders,
        archived: verdict.state.archived,
        restricted: verdict.state.restricted,
        detailJson:
          verdict.state.gameStartTime === null ? null : JSON.stringify({ gameStartTime: verdict.state.gameStartTime }),
      },
    ],
    [],
  );
}

function interpretBinance(payload: string): Interpretation {
  const decoded = decodeFrame(payload);
  if (decoded.kind === "TRADE") {
    const price = canonical(decoded.priceRaw);
    const size = canonical(decoded.quantityRaw);
    if (price === null || size === null) return result("binance-trade", [], ["a trade price or quantity is not a canonical decimal"]);
    return result(
      "binance-trade",
      [
        {
          kind: "ref-trade",
          entryIndex: 0,
          source: BINANCE_EVENT_SOURCE,
          instrument: decoded.symbol,
          tradeId: String(decoded.tradeId),
          price,
          size,
        },
      ],
      [],
    );
  }
  if (decoded.kind === "BOOK_TICKER") return result("binance-book-ticker", [], []);
  if (decoded.kind === "MALFORMED") {
    return result("binance-malformed", [], [`${decoded.reason}: ${decoded.detail}`]);
  }
  return result(`binance-${decoded.kind.toLowerCase()}`, [], []);
}

function interpretCoinbase(payload: string): Interpretation {
  const classified = classifyFrame(payload);
  if (classified.kind === "REJECTED") return result("coinbase-rejected", [], [classified.detail]);
  if (classified.kind !== "MARKET_TRADES") return result(`coinbase-${classified.kind.toLowerCase()}`, [], []);
  const observations: Observation[] = [];
  const problems: string[] = [];
  let snapshotTradesExcluded = 0;
  let entryIndex = 0;
  for (const event of classified.frame.events) {
    if (event.type !== "update") {
      // A `snapshot` lists recent trades from BEFORE the subscription: history,
      // not trades that arrived in this span. Excluded, and counted.
      snapshotTradesExcluded += event.trades.length;
      entryIndex += event.trades.length;
      continue;
    }
    for (const trade of event.trades) {
      const price = canonical(trade.price);
      const size = canonical(trade.size);
      if (price === null || size === null) {
        problems.push(`trade ${trade.trade_id} has a non-canonical price or size`);
      } else {
        observations.push({
          kind: "ref-trade",
          entryIndex,
          source: "coinbase",
          instrument: trade.product_id,
          tradeId: trade.trade_id,
          price,
          size,
        });
      }
      entryIndex += 1;
    }
  }
  return result("coinbase-market-trades", observations, problems, snapshotTradesExcluded);
}

const TWAP_TOPICS: ReadonlySet<string> = new Set(Object.values(RTDS_TWAP_TOPIC_BY_WINDOW));

/**
 * Stateful only where a door is: the RTDS normalizer keeps a per-connection
 * duplicate tracker. It starts fresh with each extraction; the tracker only
 * flags duplicates, so a fresh one can at worst keep a duplicate tick.
 */
export class FrameInterpreter {
  readonly #rtdsTrackers = new Map<string, TwapObservationTracker>();

  interpret(record: RawFrameRecord): Interpretation {
    if (record.source === "polymarket") {
      if (record.endpoint.startsWith(POLYMARKET_MARKET_ENDPOINT_PREFIX)) {
        return interpretPolymarketMarket(record.payloadUtf8);
      }
      if (record.endpoint.startsWith(GAMMA_MARKET_ENDPOINT_PREFIX)) {
        return interpretGamma(record.payloadUtf8);
      }
      return result("polymarket-other", [], []);
    }
    if (record.source === "binance") return interpretBinance(record.payloadUtf8);
    if (record.source === "coinbase") return interpretCoinbase(record.payloadUtf8);
    if (record.source === "rtds") return this.#interpretRtds(record);
    return result(`other-${record.source.slice(0, 32)}`, [], []);
  }

  #interpretRtds(record: RawFrameRecord): Interpretation {
    const decoded = decodeInboundRtdsFrame(record.payloadUtf8);
    if (decoded.kind === "heartbeat-text") return result("rtds-heartbeat", [], []);
    if (decoded.kind === "unparsable") return result("rtds-unparsable", [], [decoded.reason]);
    let tracker = this.#rtdsTrackers.get(record.connectionId);
    if (tracker === undefined) {
      tracker = new TwapObservationTracker({
        duplicateWindow: DEFAULT_RTDS_TWAP_FEED_OPTIONS.duplicateWindowPerSeries,
        maxTrackedSeries: DEFAULT_RTDS_TWAP_FEED_OPTIONS.maxTrackedSeries,
      });
      this.#rtdsTrackers.set(record.connectionId, tracker);
    }
    const normalized = normalizeRtdsFrame(decoded.values, {
      sourceChannel: record.endpoint,
      connectionId: record.connectionId,
      subscriptionGeneration: record.subscriptionGeneration,
      subscribedTopics: TWAP_TOPICS,
      receivedEpochMs: Date.parse(record.receivedAt),
      tracker,
    });
    const observations: Observation[] = normalized.events.map((event) => ({
      kind: "chainlink",
      entryIndex: event.provenance.observedIndex,
      topic: event.provenance.sourceChannel,
      symbol: event.payload.symbol,
      value: event.payload.value,
      observedAt: event.payload.windowEndAt,
    }));
    return result(
      "rtds-twap",
      observations,
      normalized.problems.map((problem) => `${problem.code}: ${problem.detail}`),
    );
  }
}
