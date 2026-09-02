/**
 * Typed errors, thrown only for structurally impossible configuration —
 * a caller constructing a book with an invalid identity. Everything
 * recoverable is a returned refusal (`refusals.ts`), never a throw.
 */

export type OrderBookConfigurationErrorCode =
  /** `internalMarketId` is not a canonical lowercase UUIDv7. */
  | "ORDER_BOOK_BAD_MARKET_ID"
  /** `tokenId` is not a canonical unsigned integer string. */
  | "ORDER_BOOK_BAD_TOKEN_ID"
  /** The two outcome tokens of one market must be distinct. */
  | "ORDER_BOOK_DUPLICATE_OUTCOME_TOKEN";

export class OrderBookConfigurationError extends Error {
  readonly code: OrderBookConfigurationErrorCode;

  constructor(code: OrderBookConfigurationErrorCode, message: string) {
    super(message);
    this.name = "OrderBookConfigurationError";
    this.code = code;
  }
}
