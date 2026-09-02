/**
 * `@polymarket-bot/order-book` — local exact-decimal order books (WP-150,
 * handoff §9.4).
 *
 * A pure layer-1 state-machine library fed by the frozen domain book events:
 * per-outcome-token reconstruction under ADR-013's ratified semantics
 * (absolute sizes, `"0"` removes the level, replace-not-accumulate),
 * subscription-generation and epoch gating, exact-decimal queries
 * (top-of-book, spread, depth, executable price), REST-snapshot validation,
 * and tick-pinned price helpers that are invalidated by tick-size changes.
 *
 * DEPENDENCY DIRECTION (handoff §5.2, `dependency-direction.md` §2): layer 1.
 * This package depends only on `@polymarket-bot/domain` and
 * `@polymarket-bot/decimal` (both layer 0). It owns no connection: no
 * network, no filesystem, no clock read, no randomness, no Node built-in,
 * no credential or signer surface. Every ingested value arrives as a
 * function argument; every refusal is returned as data.
 *
 * SAFETY: nothing here can place an order or touch a venue. Run-mode
 * defaults (`MAX_RUN_MODE=PAPER`, `ALLOW_REAL_ORDERS=false`, zero live-micro
 * caps) are untouched and not representable in this package.
 */

export type {
  BookBaseline,
  BookDepth,
  BookLastUpdate,
  BookLevelView,
  BookStaleness,
  OutcomeTokenBookOptions,
  TopOfBook,
} from "./book.js";
export { OutcomeTokenBook } from "./book.js";
export type { OrderBookConfigurationErrorCode } from "./errors.js";
export { OrderBookConfigurationError } from "./errors.js";
export type { ExecutablePriceQuote, ExecutablePriceRefusal, ExecutablePriceRequest, ExecutablePriceResult } from "./executable-price.js";
export { executablePrice } from "./executable-price.js";
export type { BookIngestMeta, IngestMetaValidation, ValidatedIngestMeta } from "./ingest.js";
export { validateIngestMeta } from "./ingest.js";
export type { MarketBooksOptions } from "./market-books.js";
export { MarketOutcomeBooks } from "./market-books.js";
export type { GridBooleanResult, GridValueResult, PriceGrid, PriceGridResult } from "./price-helper.js";
export { priceGrid } from "./price-helper.js";
export type { ApplyOutcome, Applied, OrderBookRefusal, OrderBookRefusalCode, Refused } from "./refusals.js";
export type {
  RestSnapshotInput,
  RestSnapshotLevel,
  SnapshotComparisonReport,
  SnapshotDivergence,
  SnapshotDivergenceKind,
} from "./rest-validation.js";
export { compareAgainstRestSnapshot } from "./rest-validation.js";
export { BOOK_SERIALIZATION_VERSION, serializeBook } from "./serialize.js";
