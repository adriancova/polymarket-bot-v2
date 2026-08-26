/**
 * Valid sample values for every contract in this package.
 *
 * TEST-ONLY SUPPORT MODULE. It is deliberately not re-exported from
 * `src/index.ts` so that WP-020 does not publish an API beyond the frozen
 * contracts. Its purpose is to let the tests assert acceptance criteria
 * generically — in particular "no economic schema accepts a JavaScript number"
 * across every event, rather than on a hand-picked subset.
 */

import type { DomainEventType } from "../events/index.js";

export const SAMPLE_EVENT_ID = "018f3a5c-9b7e-7c3d-8f21-6b0f9a2c4d1f";
export const SAMPLE_GATEWAY_EPOCH = "018f3a5c-9b7e-7c3d-8f21-6b0f9a2c4d1e";
export const SAMPLE_MARKET_ID = "018f3a5c-1111-7000-8000-000000000001";
export const SAMPLE_OTHER_MARKET_ID = "018f3a5c-1111-7000-8000-000000000002";
export const SAMPLE_INTENT_ID = "018f3a5c-2222-7000-8000-000000000001";
export const SAMPLE_CONDITION_ID =
  "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
export const SAMPLE_YES_TOKEN_ID = "71321045679252212594626385532706912750332728571942532289631379312455583992563";
export const SAMPLE_NO_TOKEN_ID = "52114319501245915516055106046884209969926127482827954674443846427813813222426";
export const SAMPLE_TIMESTAMP = "2026-08-26T12:00:00.000Z";

/** Envelope fields shared by every sample, excluding `eventType`/`schemaVersion`/`payload`. */
export const SAMPLE_ENVELOPE_BASE = {
  eventId: SAMPLE_EVENT_ID,
  source: "polymarket",
  sourceChannel: "market",
  receivedAt: SAMPLE_TIMESTAMP,
  receivedMonotonicNs: "123456789012345",
  gatewayEpoch: SAMPLE_GATEWAY_EPOCH,
  ingestSeq: "42",
} as const;

/** Builds a valid envelope object for a contract. */
export function sampleEnvelope(
  eventType: string,
  schemaVersion: number,
  payload: unknown,
): Record<string, unknown> {
  return { ...SAMPLE_ENVELOPE_BASE, eventType, schemaVersion, payload };
}

export interface EventSample {
  readonly eventType: DomainEventType;
  readonly payload: Record<string, unknown>;
  /** Top-level payload keys that carry an economic (decimal string) value. */
  readonly economicFields: readonly string[];
  /** Keys present in the sample that the schema declares optional. */
  readonly optionalFields: readonly string[];
}

const marketReference = {
  internalMarketId: SAMPLE_MARKET_ID,
  conditionId: SAMPLE_CONDITION_ID,
} as const;

/** One valid payload per §7.4 event type. */
export const EVENT_SAMPLES: readonly EventSample[] = [
  {
    eventType: "MarketDiscovered",
    payload: {
      ...marketReference,
      yesTokenId: SAMPLE_YES_TOKEN_ID,
      noTokenId: SAMPLE_NO_TOKEN_ID,
      seriesId: "btc-15m-updown",
      metadataVersion: 1,
    },
    economicFields: [],
    optionalFields: ["seriesId"],
  },
  {
    eventType: "MarketMetadataChanged",
    payload: { ...marketReference, metadataVersion: 2, changedFields: ["title"] },
    economicFields: [],
    optionalFields: [],
  },
  {
    eventType: "MarketRulesChanged",
    payload: {
      ...marketReference,
      rulesVersionId: "rules-2",
      previousRulesVersionId: "rules-1",
      changedFields: ["resolution_source"],
    },
    economicFields: [],
    optionalFields: ["previousRulesVersionId"],
  },
  {
    eventType: "MarketOpened",
    payload: { ...marketReference, openedAt: SAMPLE_TIMESTAMP },
    economicFields: [],
    optionalFields: [],
  },
  {
    eventType: "MarketClosing",
    payload: { ...marketReference, closesAt: SAMPLE_TIMESTAMP },
    economicFields: [],
    optionalFields: [],
  },
  {
    eventType: "MarketResolved",
    payload: { ...marketReference, outcome: "YES_WIN", resolvedAt: SAMPLE_TIMESTAMP },
    economicFields: [],
    optionalFields: [],
  },
  {
    eventType: "MarketClarificationObserved",
    payload: {
      ...marketReference,
      clarificationId: "clarification-1",
      observedAt: SAMPLE_TIMESTAMP,
    },
    economicFields: [],
    optionalFields: [],
  },
  {
    eventType: "TradingParametersChanged",
    payload: {
      ...marketReference,
      parametersVersion: 3,
      tickSize: "0.01",
      minimumOrderSize: "5",
    },
    economicFields: ["tickSize", "minimumOrderSize"],
    optionalFields: [],
  },
  {
    eventType: "BookSnapshot",
    payload: {
      internalMarketId: SAMPLE_MARKET_ID,
      tokenId: SAMPLE_YES_TOKEN_ID,
      bids: [{ price: "0.52", size: "100" }],
      asks: [{ price: "0.54", size: "250" }],
      venueBookHash: "0xabc",
    },
    economicFields: [],
    optionalFields: ["venueBookHash"],
  },
  {
    eventType: "BookLevelChanged",
    payload: {
      internalMarketId: SAMPLE_MARKET_ID,
      tokenId: SAMPLE_YES_TOKEN_ID,
      side: "BID",
      price: "0.52",
      size: "0",
    },
    economicFields: ["price", "size"],
    optionalFields: [],
  },
  {
    eventType: "BestBidAskChanged",
    payload: {
      internalMarketId: SAMPLE_MARKET_ID,
      tokenId: SAMPLE_YES_TOKEN_ID,
      bestBidPrice: "0.52",
      bestBidSize: "100",
      bestAskPrice: "0.54",
      bestAskSize: "250",
    },
    economicFields: ["bestBidPrice", "bestBidSize", "bestAskPrice", "bestAskSize"],
    optionalFields: ["bestBidPrice", "bestBidSize", "bestAskPrice", "bestAskSize"],
  },
  {
    eventType: "PublicTradeObserved",
    payload: {
      internalMarketId: SAMPLE_MARKET_ID,
      tokenId: SAMPLE_YES_TOKEN_ID,
      price: "0.53",
      size: "10",
      takerSide: "ASK",
    },
    economicFields: ["price", "size"],
    optionalFields: ["takerSide"],
  },
  {
    eventType: "ReferenceTradeObserved",
    payload: { venue: "binance", symbol: "BTCUSDT", price: "64250.15", size: "0.005" },
    economicFields: ["price", "size"],
    optionalFields: [],
  },
  {
    eventType: "ReferenceTopOfBookChanged",
    payload: {
      venue: "coinbase",
      symbol: "BTC-USD",
      bidPrice: "64250.15",
      bidSize: "0.5",
      askPrice: "64251.2",
      askSize: "0.75",
    },
    economicFields: ["bidPrice", "bidSize", "askPrice", "askSize"],
    optionalFields: ["bidPrice", "bidSize", "askPrice", "askSize"],
  },
  {
    eventType: "ReferenceTwapObserved",
    payload: {
      venue: "rtds",
      symbol: "BTC-USD",
      feedId: "chainlink-btc-usd",
      value: "64250.15",
      windowSeconds: 900,
      windowStartAt: SAMPLE_TIMESTAMP,
      windowEndAt: SAMPLE_TIMESTAMP,
    },
    economicFields: ["value"],
    optionalFields: [],
  },
  {
    eventType: "FeedConnected",
    payload: {
      feedId: "polymarket-market",
      connectionId: "conn-1",
      endpoint: "wss://example.invalid/ws",
      subscriptionGeneration: 0,
      connectedAt: SAMPLE_TIMESTAMP,
    },
    economicFields: [],
    optionalFields: [],
  },
  {
    eventType: "FeedDisconnected",
    payload: {
      feedId: "polymarket-market",
      connectionId: "conn-1",
      disconnectedAt: SAMPLE_TIMESTAMP,
      reasonCode: "SOCKET_CLOSED",
    },
    economicFields: [],
    optionalFields: ["connectionId"],
  },
  {
    eventType: "FeedStale",
    payload: {
      feedId: "polymarket-market",
      detectedAt: SAMPLE_TIMESTAMP,
      lastMessageAt: SAMPLE_TIMESTAMP,
      stalenessMs: 5000,
    },
    economicFields: [],
    optionalFields: ["lastMessageAt"],
  },
  {
    eventType: "FeedGapDetected",
    payload: {
      feedId: "polymarket-market",
      detectedAt: SAMPLE_TIMESTAMP,
      reasonCode: "SEQUENCE_GAP",
      requiresAuthoritativeSnapshot: true,
      affectedMarketIds: [SAMPLE_MARKET_ID],
    },
    economicFields: [],
    optionalFields: ["affectedMarketIds"],
  },
  {
    eventType: "FeedResynchronized",
    payload: {
      feedId: "polymarket-market",
      connectionId: "conn-2",
      resynchronizedAt: SAMPLE_TIMESTAMP,
      subscriptionGeneration: 1,
      authoritativeSnapshotApplied: true,
    },
    economicFields: [],
    optionalFields: ["connectionId"],
  },
  {
    eventType: "DataQualityIncidentOpened",
    payload: {
      incidentId: "incident-1",
      openedAt: SAMPLE_TIMESTAMP,
      reasonCode: "BOOK_DIVERGENCE",
      severity: "PAGE",
      detail: "reconstructed book diverged from the REST snapshot",
      feedId: "polymarket-market",
    },
    economicFields: [],
    optionalFields: ["detail", "feedId"],
  },
  {
    eventType: "DataQualityIncidentClosed",
    payload: {
      incidentId: "incident-1",
      closedAt: SAMPLE_TIMESTAMP,
      resolutionCode: "RESYNCHRONIZED",
    },
    economicFields: [],
    optionalFields: [],
  },
];

/** A valid §7.7 position intent. */
export const SAMPLE_POSITION_INTENT = {
  type: "POSITION",
  intentId: SAMPLE_INTENT_ID,
  marketId: SAMPLE_MARKET_ID,
  direction: "YES",
  targetMode: "ABSOLUTE",
  targetShares: "100",
  maximumBuyPrice: "0.55",
  maximumTotalCost: "55",
  urgency: "NORMAL",
  liquidityPreference: "MAKER_PREFERRED",
  partialFillPolicy: "ACCEPT_MINIMUM",
  minimumFillShares: "10",
  validUntil: SAMPLE_TIMESTAMP,
  expectedProbability: "0.6",
  expectedNetEdge: "1.25",
  tags: ["static-bracket"],
} as const;

/** A valid §7.7 quote intent. */
export const SAMPLE_QUOTE_INTENT = {
  type: "QUOTE",
  intentId: SAMPLE_INTENT_ID,
  marketId: SAMPLE_MARKET_ID,
  bids: [{ price: "0.51", shares: "100" }],
  asks: [{ price: "0.55", shares: "100" }],
  postOnly: true,
  quoteLifetimeMs: 2000,
  replaceThresholdTicks: 1,
  maximumInventory: "500",
  tags: ["maker"],
} as const;

/** A valid §7.7 basket intent. */
export const SAMPLE_BASKET_INTENT = {
  type: "BASKET",
  intentId: SAMPLE_INTENT_ID,
  legs: [
    {
      marketId: SAMPLE_MARKET_ID,
      direction: "YES",
      targetShares: "100",
      maximumBuyPrice: "0.52",
    },
    {
      marketId: SAMPLE_OTHER_MARKET_ID,
      direction: "NO",
      targetShares: "100",
      maximumBuyPrice: "0.47",
    },
  ],
  maximumCombinedCost: "99",
  minimumLockedEdge: "1",
  legRiskLimit: "25",
  failurePolicy: "PROTECTED_UNWIND",
  validUntil: SAMPLE_TIMESTAMP,
} as const;

/** A valid §7.7 cancel intent. */
export const SAMPLE_CANCEL_INTENT = {
  type: "CANCEL",
  marketId: SAMPLE_MARKET_ID,
  orderIds: ["0xorderhash"],
  reason: "incident controller cancelled resting orders",
} as const;

/** A valid §7.7 reduction intent. */
export const SAMPLE_REDUCE_POSITION_INTENT = {
  type: "REDUCE_POSITION",
  marketId: SAMPLE_MARKET_ID,
  targetShares: "0",
  urgency: "AGGRESSIVE",
  minimumSellPrice: "0.4",
  reason: "protected reduction near close",
} as const;

/** A valid §7.5 decision result carrying zero intents. */
export const SAMPLE_HOLD_DECISION = {
  decisionType: "hold",
  reasonCodes: ["NO_EDGE"],
  featureSnapshotRef: "feature-snapshot-1",
  intents: [],
} as const;
