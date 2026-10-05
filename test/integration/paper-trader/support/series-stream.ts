/**
 * `ROLLOVER-1` r1 support: a SYNTHETIC series stream for the trader, built
 * envelope by envelope with the paper fixture's own `ingested`, so a test can
 * place each admission, open, book, fill-driving quote and resolution of a
 * window at the instant it needs — no gateway in between.
 *
 * The windows are `RECORDED_SERIES_WINDOWS` (recorded venue data); the review
 * is the paper suite's sample (`series-windows.ts` `review()`), and every
 * admission carries its hash, as the gateway's would. The book prices follow
 * the paper fixture's Static Bracket numbers (`fixture.ts`): the YES ask ladder
 * `0.34 × 200` puts the executable BUY price for 50 shares under the `0.35`
 * trigger; a YES bid of `0.27` meets the stop.
 */

import { ReviewedSeriesSchema, seriesConfigHash, type IngestedEvent } from "@polymarket-bot/trader";
import { seriesWindowPayloads, type RecordedSeriesWindow } from "@polymarket-bot/trader/testing";

import { ingested, resetEventIds } from "./fixture.js";
import { review } from "./series-windows.js";

/** The review hash every admission of the sample review carries. */
export function sampleReviewHash(document: Record<string, unknown> = review()): string {
  const hashed = seriesConfigHash(ReviewedSeriesSchema.parse(document));
  if (!hashed.ok) throw new Error(hashed.problem);
  return hashed.hash;
}

type Level = readonly [price: string, size: string];

/** A trader-side event script, in delivery order (each event its own frame). */
export class SeriesStream {
  readonly #events: IngestedEvent[] = [];
  readonly #hash: string;
  #seq = 0;

  constructor(hash: string = sampleReviewHash()) {
    resetEventIds();
    this.#hash = hash;
  }

  get events(): readonly IngestedEvent[] {
    return this.#events;
  }

  #push(eventType: string, payload: unknown, at: string, source?: "binance"): this {
    this.#seq += 1;
    this.#events.push(ingested(eventType, payload, { receivedAt: at, ingestSeq: this.#seq, ...(source === undefined ? {} : { source }) }));
    return this;
  }

  /** `MarketDiscovered@1` then `SeriesWindowAdmitted@1`, as the gateway publishes them. */
  admit(window: RecordedSeriesWindow, at: string): this {
    const payloads = seriesWindowPayloads(window, this.#hash);
    return this.#push("MarketDiscovered", payloads.discovered, at).#push("SeriesWindowAdmitted", payloads.admitted, at);
  }

  open(window: RecordedSeriesWindow, at: string): this {
    return this.#push("MarketOpened", { internalMarketId: window.marketId, conditionId: window.conditionId, openedAt: window.openAt }, at);
  }

  /** Both tokens' books: the YES ladder given, the NO ladder its complement-ish fixture levels. */
  book(window: RecordedSeriesWindow, at: string, yes: { readonly bids: readonly Level[]; readonly asks: readonly Level[] }): this {
    const levels = (side: readonly Level[]) => side.map(([price, size]) => ({ price, size }));
    this.#push("BookSnapshot", { internalMarketId: window.marketId, tokenId: window.yesTokenId, bids: levels(yes.bids), asks: levels(yes.asks) }, at);
    const atMs = Date.parse(at) + 1;
    return this.#push(
      "BookSnapshot",
      { internalMarketId: window.marketId, tokenId: window.noTokenId, bids: [{ price: "0.65", size: "200" }], asks: [{ price: "0.66", size: "200" }] },
      new Date(atMs).toISOString(),
    );
  }

  /** A reference print: moves event time, names no market. */
  tick(at: string, price = "100000"): this {
    return this.#push("ReferenceTradeObserved", { venue: "binance", symbol: "BTCUSDT", price, size: "0.1" }, at, "binance");
  }

  /** A public trade on the window's YES token: at Tier 0 it fills a resting order it touches (`fixture.ts`). */
  trade(window: RecordedSeriesWindow, at: string, price: string, size = "100"): this {
    return this.#push("PublicTradeObserved", { internalMarketId: window.marketId, tokenId: window.yesTokenId, price, size }, at);
  }

  resolve(window: RecordedSeriesWindow, at: string, outcome: "YES_WIN" | "NO_WIN" = "YES_WIN"): this {
    return this.#push("MarketResolved", { internalMarketId: window.marketId, conditionId: window.conditionId, outcome, resolvedAt: at }, at);
  }
}

/** The entry quote: the executable BUY for 50 shares is 0.34 (under the 0.35 trigger). */
export const ENTRY_QUOTE = { bids: [["0.32", "200"], ["0.31", "300"]], asks: [["0.34", "200"], ["0.35", "300"]] } as const;
/** The stop quote: the YES bid at 0.27 meets the stop (`trigger_price_lte` 0.27). */
export const STOP_QUOTE = { bids: [["0.27", "200"], ["0.26", "300"]], asks: [["0.29", "200"]] } as const;
/** A quote no exit can sell into (every bid under the stop's 0.26 floor) and no entry buys. */
export const DEAD_QUOTE = { bids: [["0.1", "200"]], asks: [["0.9", "200"]] } as const;
