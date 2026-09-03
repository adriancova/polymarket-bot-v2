/**
 * Transaction input validation: what is wrong about ONE transaction, before
 * any accounting rule runs.
 *
 * Two rules here carry weight beyond schema hygiene:
 *
 * - ADR-016 §2 (2026-09-02 amendment) — a UUID-shaped but non-canonical
 *   identifier is REFUSED carrying the raw value, never case-folded into
 *   acceptance;
 * - WP-040 obligation F16 — a transaction that books an order or a fill must
 *   name its market, because both execution rows carry a NOT NULL market and a
 *   marketless posting would balance correctly while vanishing from every
 *   market-scoped query.
 */

import { describe, expect, it } from "vitest";

import {
  ACCOUNT,
  INSTANCE_A,
  MARKET_A,
  VENUE_CLEARING,
  collateral,
  fillId,
  transaction,
  tx,
} from "./testing/scenarios.js";
import { validateTransactionInput } from "./transaction.js";

const balancedEntries = [
  collateral("ACTUAL_ACCOUNT", ACCOUNT, "5"),
  collateral("EXTERNAL_CLEARING", VENUE_CLEARING, "-5"),
];

function codesOf(input: unknown): readonly string[] {
  const result = validateTransactionInput(input);
  return result.ok ? [] : result.refusals.map((refusal) => refusal.code);
}

describe("validateTransactionInput", () => {
  it("accepts a well-formed transaction and deep-freezes it", () => {
    const result = validateTransactionInput(transaction({ entries: balancedEntries }));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.entries)).toBe(true);
    expect(Object.isFrozen(result.value.entries[0])).toBe(true);
  });

  it("refuses a non-object with LEDGER_INPUT_INVALID", () => {
    expect(codesOf("not a transaction")).toEqual(["LEDGER_INPUT_INVALID"]);
    expect(codesOf(null)).toEqual(["LEDGER_INPUT_INVALID"]);
  });

  it("refuses an unknown field rather than ignoring it (strict object)", () => {
    expect(
      codesOf({ ...transaction({ entries: balancedEntries }), surpriseField: "hello" }),
    ).toEqual(["LEDGER_INPUT_INVALID"]);
  });

  it("refuses a numeric amount: no economic value passes through a JS number", () => {
    expect(
      codesOf(
        transaction({
          entries: [
            { ...collateral("ACTUAL_ACCOUNT", ACCOUNT, "5"), amount: 5 as unknown as string },
            collateral("EXTERNAL_CLEARING", VENUE_CLEARING, "-5"),
          ],
        }),
      ),
    ).toEqual(["LEDGER_INPUT_INVALID"]);
  });

  it("refuses an empty transaction", () => {
    expect(codesOf(transaction({ entries: [] }))).toEqual(["LEDGER_TRANSACTION_EMPTY"]);
  });

  it("refuses a zero entry amount: it moves nothing and records nothing", () => {
    const result = validateTransactionInput(
      transaction({
        entries: [
          collateral("ACTUAL_ACCOUNT", ACCOUNT, "0"),
          collateral("EXTERNAL_CLEARING", VENUE_CLEARING, "5"),
          collateral("EXTERNAL_CLEARING", VENUE_CLEARING, "-5"),
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.refusals[0]?.code).toBe("LEDGER_ENTRY_AMOUNT_ZERO");
    expect(result.refusals[0]?.details).toMatchObject({ entryIndex: 0 });
  });

  describe("ADR-016 §2: a non-canonical UUID is refused, never normalized", () => {
    const uppercase = tx(1).toUpperCase();

    it("refuses an uppercase transaction id and carries the raw value", () => {
      const result = validateTransactionInput(
        transaction({ ledgerTransactionId: uppercase, entries: balancedEntries }),
      );
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.refusals[0]?.code).toBe("LEDGER_UUID_NOT_CANONICAL");
      expect(result.refusals[0]?.details).toEqual({
        field: "ledgerTransactionId",
        raw: uppercase,
      });
      // The raw value is reported verbatim — not lowercased on the way out.
      expect(result.refusals[0]?.details["raw"]).not.toBe(tx(1));
    });

    it("refuses a non-canonical entry instanceId", () => {
      const result = validateTransactionInput(
        transaction({
          entries: [
            collateral("VIRTUAL_STRATEGY", ACCOUNT, "5", {
              instanceId: INSTANCE_A.toUpperCase(),
            }),
            collateral("EXTERNAL_CLEARING", VENUE_CLEARING, "-5"),
          ],
        }),
      );
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.refusals[0]?.code).toBe("LEDGER_UUID_NOT_CANONICAL");
      expect(result.refusals[0]?.details["field"]).toBe("entries[0].instanceId");
    });

    it("refuses a lowercase v4 in a v7 position, carrying the raw value", () => {
      // ADR-016 §2 pins the version and variant nibbles as PART of the
      // canonical form ("a v4 in that position would break the ordering
      // property the field is there to provide"), and the 2026-09-02
      // amendment covers an "otherwise non-canonical" spelling, not only a
      // mixed-case one. So this is the spelling refusal, with evidence —
      // not a bare schema failure that drops the offending value.
      const v4 = "018f3a5c-4444-4000-8000-000000000001";
      const result = validateTransactionInput(
        transaction({ ledgerTransactionId: v4, entries: balancedEntries }),
      );
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.refusals[0]?.code).toBe("LEDGER_UUID_NOT_CANONICAL");
      expect(result.refusals[0]?.details).toEqual({ field: "ledgerTransactionId", raw: v4 });
    });

    it("refuses a value that is not UUID-shaped at all as a plain schema failure", () => {
      expect(
        codesOf(
          transaction({ ledgerTransactionId: "not-a-uuid", entries: balancedEntries }),
        ),
      ).toEqual(["LEDGER_INPUT_INVALID"]);
    });
  });

  describe("scope discipline (ADR-006 §2)", () => {
    it("refuses a VIRTUAL_STRATEGY entry with no instanceId", () => {
      expect(
        codesOf(
          transaction({
            entries: [
              collateral("VIRTUAL_STRATEGY", ACCOUNT, "5"),
              collateral("EXTERNAL_CLEARING", VENUE_CLEARING, "-5"),
            ],
          }),
        ),
      ).toEqual(["LEDGER_INSTANCE_SCOPE_MISMATCH"]);
    });

    it("refuses a non-VIRTUAL_STRATEGY entry that carries an instanceId", () => {
      expect(
        codesOf(
          transaction({
            entries: [
              collateral("UNATTRIBUTED", ACCOUNT, "5", { instanceId: INSTANCE_A }),
              collateral("EXTERNAL_CLEARING", VENUE_CLEARING, "-5"),
            ],
          }),
        ),
      ).toEqual(["LEDGER_INSTANCE_SCOPE_MISMATCH"]);
    });
  });

  describe("WP-040 obligation F16: an execution-linked posting names its market", () => {
    it("refuses a fill-linked transaction with no market", () => {
      const result = validateTransactionInput(
        transaction({ fillId: fillId(1), entries: balancedEntries }),
      );
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.refusals[0]?.code).toBe("LEDGER_MARKET_REQUIRED");
      expect(result.refusals[0]?.details).toMatchObject({ fillId: fillId(1), orderId: null });
    });

    it("refuses an order-linked transaction with no market", () => {
      expect(codesOf(transaction({ orderId: tx(9), entries: balancedEntries }))).toEqual([
        "LEDGER_MARKET_REQUIRED",
      ]);
    });

    it("accepts a fill-linked transaction that names its market", () => {
      expect(
        validateTransactionInput(
          transaction({ fillId: fillId(1), marketId: MARKET_A, entries: balancedEntries }),
        ).ok,
      ).toBe(true);
    });

    it("still accepts a standalone transaction with no market at all", () => {
      expect(validateTransactionInput(transaction({ entries: balancedEntries })).ok).toBe(true);
    });
  });

  it("refuses one asset id declared with two kinds in one transaction", () => {
    const result = validateTransactionInput(
      transaction({
        entries: [
          { ...collateral("ACTUAL_ACCOUNT", ACCOUNT, "5"), assetKind: "COLLATERAL" },
          { ...collateral("EXTERNAL_CLEARING", VENUE_CLEARING, "-5"), assetKind: "OUTCOME_TOKEN" },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.refusals[0]?.code).toBe("LEDGER_ASSET_KIND_CONFLICT");
    expect(result.refusals[0]?.details).toMatchObject({
      firstKind: "COLLATERAL",
      conflictingKind: "OUTCOME_TOKEN",
    });
  });

  it("reports every structural refusal at once, not just the first", () => {
    const codes = codesOf(
      transaction({
        fillId: fillId(1),
        entries: [collateral("VIRTUAL_STRATEGY", ACCOUNT, "0")],
      }),
    );
    expect(codes).toContain("LEDGER_MARKET_REQUIRED");
    expect(codes).toContain("LEDGER_ENTRY_AMOUNT_ZERO");
    expect(codes).toContain("LEDGER_INSTANCE_SCOPE_MISMATCH");
  });
});
