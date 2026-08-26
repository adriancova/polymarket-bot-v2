/**
 * The complete §7.4 minimum normalized event list.
 *
 * Every entry is a versioned event contract. The registry in `../registry.ts`
 * indexes these by `(eventType, schemaVersion)`.
 */

import { BOOK_CONTRACTS } from "./book.js";
import type { EventContractLike } from "./event-contract.js";
import { FEED_CONTRACTS } from "./feed.js";
import { MARKET_LIFECYCLE_CONTRACTS } from "./market-lifecycle.js";
import { REFERENCE_CONTRACTS } from "./reference.js";

export * from "./book.js";
export * from "./event-contract.js";
export * from "./feed.js";
export * from "./market-lifecycle.js";
export * from "./reference.js";

/** Every normalized market event contract required by §7.4. */
export const DOMAIN_EVENT_CONTRACTS: readonly EventContractLike[] = [
  ...MARKET_LIFECYCLE_CONTRACTS,
  ...BOOK_CONTRACTS,
  ...REFERENCE_CONTRACTS,
  ...FEED_CONTRACTS,
];

/**
 * The §7.4 event-type names, in specification order.
 *
 * Exported as a literal tuple so a consumer can exhaustively switch on the
 * union without duplicating the list.
 */
export const DOMAIN_EVENT_TYPES = [
  "MarketDiscovered",
  "MarketMetadataChanged",
  "MarketRulesChanged",
  "MarketOpened",
  "MarketClosing",
  "MarketResolved",
  "MarketClarificationObserved",
  "TradingParametersChanged",

  "BookSnapshot",
  "BookLevelChanged",
  "BestBidAskChanged",
  "PublicTradeObserved",

  "ReferenceTradeObserved",
  "ReferenceTopOfBookChanged",
  "ReferenceTwapObserved",

  "FeedConnected",
  "FeedDisconnected",
  "FeedStale",
  "FeedGapDetected",
  "FeedResynchronized",
  "DataQualityIncidentOpened",
  "DataQualityIncidentClosed",
] as const;

export type DomainEventType = (typeof DOMAIN_EVENT_TYPES)[number];
