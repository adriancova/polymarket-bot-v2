/**
 * A complete, hand-computed valid v1 input for the PACKAGE-INTERNAL tests.
 *
 * Every summary line of the book text is derived BY HAND from the ladders
 * (350 = 100 + 50 + 200; 200 = 80 + 120; 0.04 = 0.52 - 0.48), so this
 * fixture is an oracle for the reader, not an echo of it. The root
 * acceptance tests (`test/unit/features/`) keep their own fixtures and drive
 * the real `serializeBook` for the writer/reader binding.
 *
 * Fresh objects on every call: tests mutate copies freely.
 */

export const FIXTURE_MARKET = "018f4d2e-0000-7000-8000-000000000001";
export const FIXTURE_TOKEN = "123456";
export const FIXTURE_EPOCH = "018f4d2e-0000-7000-8000-0000000000aa";

export function fixtureBookText(): string {
  return [
    "polymarket-bot/order-book/v1",
    `market ${FIXTURE_MARKET}`,
    `token ${FIXTURE_TOKEN}`,
    `epoch ${FIXTURE_EPOCH}`,
    "generation 3",
    "lastIngestSeq 42",
    "venueBookHash abc123",
    "tickSize 0.01",
    "bestBid 0.48 100",
    "bestAsk 0.52 80",
    "spread 0.04",
    "depth bids 3 350 asks 2 200",
    "bids 3",
    "0.48 100",
    "0.47 50",
    "0.45 200",
    "asks 2",
    "0.52 80",
    "0.53 120",
  ].join("\n");
}

/** The full valid input: every optional section present. */
export function fixtureInput(): Record<string, unknown> {
  return {
    subject: { internalMarketId: FIXTURE_MARKET, tokenId: FIXTURE_TOKEN },
    asOf: "2026-09-03T12:00:00Z",
    trigger: { gatewayEpoch: FIXTURE_EPOCH, ingestSeq: "42" },
    config: {
      depthLevels: [1, 2, 5],
      executableShares: ["50", "150", "1000"],
      tradeWindowMs: 60_000,
      ewmaLambda: "0.94",
      primaryReferenceVenue: "binance",
    },
    book: {
      serializedBook: fixtureBookText(),
      lastEventAt: "2026-09-03T11:59:59.500Z",
    },
    trades: {
      lastEventAt: "2026-09-03T11:59:58Z",
      window: [
        { price: "0.49", size: "99", takerSide: "BID", observedAt: "2026-09-03T11:58:30Z" },
        { price: "0.5", size: "10", takerSide: "BID", observedAt: "2026-09-03T11:59:10Z" },
        { price: "0.51", size: "5", takerSide: "ASK", observedAt: "2026-09-03T11:59:30Z" },
        { price: "0.52", size: "2", observedAt: "2026-09-03T11:59:40Z" },
      ],
    },
    reference: {
      binance: {
        symbol: "BTCUSDT",
        lastEventAt: "2026-09-03T11:59:59.900Z",
        trades: [
          { price: "100000", observedAt: "2026-09-03T11:59:20Z" },
          { price: "100500", observedAt: "2026-09-03T11:59:29.700Z" },
          { price: "100250", observedAt: "2026-09-03T11:59:54.900Z" },
          { price: "100750", observedAt: "2026-09-03T11:59:59.800Z" },
        ],
        topOfBook: { bidPrice: "100700", bidSize: "2", askPrice: "100800", askSize: "1.5" },
      },
      coinbase: {
        symbol: "BTC-USD",
        lastEventAt: "2026-09-03T11:59:59Z",
        trades: [
          { price: "100100", observedAt: "2026-09-03T11:59:25Z" },
          { price: "100600", observedAt: "2026-09-03T11:59:58Z" },
        ],
        topOfBook: { bidPrice: "100600", bidSize: "3", askPrice: "100800", askSize: "0.7" },
      },
      chainlink: {
        lastEventAt: "2026-09-03T11:59:30Z",
        twaps: [
          { feedId: "btc.usd", value: "100400", windowSeconds: 30, windowEndAt: "2026-09-03T11:59:30Z" },
          { feedId: "btc.usd", value: "100100", windowSeconds: 30, windowEndAt: "2026-09-03T11:59:00Z" },
          { feedId: "btc.usd", value: "100300", windowSeconds: 60, windowEndAt: "2026-09-03T11:59:00Z" },
        ],
      },
    },
    lifecycle: {
      openedAt: "2026-09-03T11:45:00Z",
      closesAt: "2026-09-03T12:15:00Z",
      referenceOpenPrice: "100200",
    },
    quality: {
      activeIncidents: [
        { incidentId: "inc-2", reasonCode: "FEED_GAP", severity: "PAGE", feedId: "reference.binance" },
        { incidentId: "inc-1", reasonCode: "STALE_FEED", severity: "NOTIFY" },
      ],
    },
  };
}
