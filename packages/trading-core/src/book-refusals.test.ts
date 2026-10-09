/**
 * `C1-HALTS` (BOOK-WAITS): the class of every order-book refusal code, as a
 * table. The loop's behaviour per class is pinned in `book-freshness.test.ts`
 * (the `C1-HALTS BOOK-WAITS` block); this pins WHICH codes are in which class,
 * including the FAULT codes the loop cannot reach today (the event door or the
 * book's own routing refuses them first), so a change to the table is a
 * visible test change.
 */

import type { OrderBookRefusalCode } from "@polymarket-bot/order-book";
import { describe, expect, it } from "vitest";

import { classifyBookRefusal, type BookRefusalClass } from "./book-refusals.js";

const TABLE: Readonly<Record<OrderBookRefusalCode, BookRefusalClass>> = {
  ORDER_BOOK_STALE_SUBSCRIPTION_GENERATION: "BENIGN",
  ORDER_BOOK_OUT_OF_ORDER_INGEST: "BENIGN",
  ORDER_BOOK_NO_BASELINE_SNAPSHOT: "DIVERGENCE",
  ORDER_BOOK_GENERATION_AHEAD_REQUIRES_SNAPSHOT: "DIVERGENCE",
  ORDER_BOOK_EPOCH_MISMATCH: "DIVERGENCE",
  ORDER_BOOK_MISSING_SUBSCRIPTION_GENERATION: "DIVERGENCE",
  ORDER_BOOK_DUPLICATE_SNAPSHOT_LEVEL: "DIVERGENCE",
  ORDER_BOOK_INPUT_INVALID: "FAULT",
  ORDER_BOOK_UUID_NOT_CANONICAL: "FAULT",
  ORDER_BOOK_NONCANONICAL_DECIMAL: "FAULT",
  ORDER_BOOK_INGEST_META_INVALID: "FAULT",
  ORDER_BOOK_IDENTITY_MISMATCH: "FAULT",
  ORDER_BOOK_UNKNOWN_TOKEN: "FAULT",
  ORDER_BOOK_PARAMETERS_VERSION_REGRESSION: "FAULT",
  ORDER_BOOK_PARAMETERS_VERSION_CONTRADICTION: "FAULT",
  ORDER_BOOK_TICK_SIZE_INVALID: "FAULT",
  ORDER_BOOK_INVALID_QUANTITY: "FAULT",
  ORDER_BOOK_INSUFFICIENT_DEPTH: "FAULT",
  ORDER_BOOK_NO_TICK_SIZE: "FAULT",
  ORDER_BOOK_PRICE_HELPER_INVALIDATED: "FAULT",
};

describe("classifyBookRefusal (C1-HALTS)", () => {
  it("classifies every order-book refusal code as the table says", () => {
    for (const [code, expected] of Object.entries(TABLE) as [OrderBookRefusalCode, BookRefusalClass][]) {
      expect(classifyBookRefusal(code), code).toBe(expected);
    }
  });
});
