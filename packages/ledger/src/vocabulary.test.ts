/**
 * The §9.15 vocabulary, pinned.
 *
 * These constants are re-declared from the handoff rather than imported from
 * `packages/storage-postgres` (layer 2 — importing it would invert the
 * dependency direction, F12). Re-declaration means the two can DRIFT, so the
 * spellings are pinned here against the handoff's lists literally. A change
 * to either side without the other is a defect these assertions catch, and
 * the fix is to correct the divergent side, never to relax the assertion.
 *
 * The database enums these must equal, token for token, are
 * `internal.ledger_scope`, `internal.ledger_event_type`, and
 * `internal.asset_kind` in `db/migrations/0001_foundation.up.sql`.
 */

import { describe, expect, it } from "vitest";

import {
  ASSET_KINDS,
  ATTRIBUTION_SCOPES,
  LEDGER_EVENT_TYPES,
  LEDGER_SCOPES,
  LedgerEventTypeSchema,
  LedgerScopeSchema,
  REWARD_PROGRAM_TYPES,
  TRADE_SETTLEMENT_STATES,
} from "./vocabulary.js";

describe("§9.15 scopes", () => {
  it("is exactly the handoff's list, in order", () => {
    expect(LEDGER_SCOPES).toEqual([
      "ACTUAL_ACCOUNT",
      "VIRTUAL_STRATEGY",
      "UNATTRIBUTED",
      "EXTERNAL_CLEARING",
      "FEE_EXPENSE",
      "REWARD_INCOME",
    ]);
  });

  it("names the two attribution scopes ADR-006 §2 partitions a holding into", () => {
    expect(ATTRIBUTION_SCOPES).toEqual(["VIRTUAL_STRATEGY", "UNATTRIBUTED"]);
    for (const scope of ATTRIBUTION_SCOPES) {
      expect(LEDGER_SCOPES).toContain(scope);
    }
  });

  it("refuses a scope outside the list", () => {
    expect(LedgerScopeSchema.safeParse("PETTY_CASH").success).toBe(false);
    expect(LedgerScopeSchema.safeParse("actual_account").success).toBe(false);
  });
});

describe("§9.15 events", () => {
  it("is exactly the handoff's list, one spelling per event", () => {
    expect(LEDGER_EVENT_TYPES).toEqual([
      "ORDER_RESERVATION",
      "RESERVATION_RELEASE",
      "TRADE_PRINCIPAL",
      "OUTCOME_TOKEN_RECEIPT",
      "OUTCOME_TOKEN_DELIVERY",
      "PLATFORM_FEE",
      "MAKER_REBATE_PAYOUT",
      "TAKER_REBATE_PAYOUT",
      "LIQUIDITY_REWARD",
      "SPLIT",
      "MERGE",
      "REDEEM",
      "DEPOSIT_OBSERVED",
      "WITHDRAWAL_OBSERVED",
      "MANUAL_ADJUSTMENT",
      "RECONCILIATION_CORRECTION",
      "RESOLUTION",
    ]);
  });

  it("has 17 event types and no duplicates", () => {
    expect(LEDGER_EVENT_TYPES).toHaveLength(17);
    expect(new Set(LEDGER_EVENT_TYPES).size).toBe(17);
  });

  it("refuses an event type outside the list", () => {
    expect(LedgerEventTypeSchema.safeParse("REBATE").success).toBe(false);
  });
});

describe("assets and programs", () => {
  it("has exactly two asset kinds and no implicit cash asset (ADR-006 §7)", () => {
    expect(ASSET_KINDS).toEqual(["COLLATERAL", "OUTCOME_TOKEN"]);
    expect(ASSET_KINDS).not.toContain("CASH");
  });

  it("names the three incentive programs, none attributable to a single fill", () => {
    expect(REWARD_PROGRAM_TYPES).toEqual([
      "MAKER_REBATE",
      "TAKER_REBATE",
      "LIQUIDITY_REWARD",
    ]);
  });

  it("keeps settlement state separate from order state (§6 invariant 5)", () => {
    expect(TRADE_SETTLEMENT_STATES).toEqual([
      "MATCHED_NOT_BROADCASTED",
      "MATCHED",
      "MINED",
      "CONFIRMED",
      "RETRYING",
      "FAILED",
    ]);
  });
});
