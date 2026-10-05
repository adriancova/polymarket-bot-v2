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
import { SERIES_ADMISSION_CONTRACTS } from "./series-admission.js";

export * from "./book.js";
export * from "./event-contract.js";
export * from "./feed.js";
export * from "./market-lifecycle.js";
export * from "./reference.js";
export * from "./series-admission.js";

/**
 * Every normalized market event contract: the §7.4 minimum list, plus
 * `SeriesWindowAdmitted@1` (ADR-030; the user's ruling Q1 of 2026-10-04,
 * `ROLLOVER-1`), registered after it so no existing entry moves.
 */
export const DOMAIN_EVENT_CONTRACTS: readonly EventContractLike[] = [
  ...MARKET_LIFECYCLE_CONTRACTS,
  ...BOOK_CONTRACTS,
  ...REFERENCE_CONTRACTS,
  ...FEED_CONTRACTS,
  ...SERIES_ADMISSION_CONTRACTS,
];

/**
 * The registered event-type names: the §7.4 list in specification order, then
 * the one contract added since (ADR-030, ruling Q1).
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

  // ADR-030 (series auto-admission, PAPER only); the user's ruling Q1.
  "SeriesWindowAdmitted",
] as const;

export type DomainEventType = (typeof DOMAIN_EVENT_TYPES)[number];
