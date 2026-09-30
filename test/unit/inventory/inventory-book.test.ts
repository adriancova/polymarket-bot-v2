/**
 * WP-300: the inventory book — available/reserved/pending arithmetic,
 * single-use ids, one active reservation per holder and asset, partial-fill
 * release, pending settlement, and seeding from ledger balance lines.
 */

import { describe, expect, it } from "vitest";

import type { BalanceLine } from "../../../packages/ledger/src/index.js";
import { AssetRegistry, InventoryBook } from "../../../packages/inventory/src/index.js";
import { ACCOUNT, NO, PUSD, USDC_E, YES, registry, seededBook } from "./helpers.js";

describe("asset registry (ADR-006 §7)", () => {
  it("refuses pUSD and USDC.e sharing one asset id", () => {
    const result = AssetRegistry.create({ pusdAssetId: "same", usdcEAssetId: "same" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe("INVENTORY_ASSET_CONFLICT");
  });

  it("refuses an outcome token id that reuses a collateral id or another condition's token", () => {
    const reg = registry();
    const clash = reg.registerOutcomePair({ conditionId: "c2", yesAssetId: PUSD, noAssetId: "n2" });
    expect(clash.ok).toBe(false);
    const clash2 = reg.registerOutcomePair({ conditionId: "c3", yesAssetId: YES, noAssetId: "n3" });
    expect(clash2.ok).toBe(false);
    expect(reg.lookup(USDC_E)?.role).toBe("USDC_E");
    expect(reg.lookup(YES)).toMatchObject({ role: "OUTCOME_TOKEN", side: "YES", assetKind: "OUTCOME_TOKEN" });
  });
});

describe("inventory lines", () => {
  it("available = actual − reserved − pendingOut; pendingIn is never available", () => {
    const book = seededBook({ [PUSD]: "100" });
    expect(book.reserve({ reservationId: "r1", holderRef: "o1", accountRef: ACCOUNT, assetId: PUSD, amount: "30" }).ok).toBe(true);
    expect(book.consume({ reservationId: "r1", amount: "10", pendingId: "fill-1" }).ok).toBe(true);
    expect(book.expectInflow({ pendingId: "in-1", accountRef: ACCOUNT, assetId: PUSD, amount: "50" }).ok).toBe(true);
    expect(book.line(ACCOUNT, PUSD)).toMatchObject({
      actual: "100",
      reserved: "20",
      pendingOut: "10",
      pendingIn: "50",
      available: "70",
      blocked: null,
    });
    expect(book.checkInvariants()).toEqual([]);
  });

  it("uses exact decimals (no float drift)", () => {
    const book = seededBook({ [PUSD]: "0.3" });
    expect(book.reserve({ reservationId: "r1", holderRef: "o1", accountRef: ACCOUNT, assetId: PUSD, amount: "0.1" }).ok).toBe(true);
    expect(book.reserve({ reservationId: "r2", holderRef: "o2", accountRef: ACCOUNT, assetId: PUSD, amount: "0.2" }).ok).toBe(true);
    expect(book.available(ACCOUNT, PUSD)).toBe("0");
    const third = book.reserve({ reservationId: "r3", holderRef: "o3", accountRef: ACCOUNT, assetId: PUSD, amount: "0.000001" });
    expect(third.ok).toBe(false);
  });

  it("refuses non-canonical, negative, zero or number amounts", () => {
    const book = seededBook({ [PUSD]: "100" });
    for (const amount of ["0", "-1", "1.50", "01", "1e2", 5 as unknown as string, " 1"]) {
      const result = book.reserve({ reservationId: `r-${String(amount)}`, holderRef: "o", accountRef: ACCOUNT, assetId: PUSD, amount });
      expect(result.ok, String(amount)).toBe(false);
    }
  });

  it("reads own data only: an inherited amount is absent", () => {
    const book = seededBook({ [PUSD]: "100" });
    const request = Object.assign(Object.create({ amount: "1" }) as object, {
      reservationId: "r1",
      holderRef: "o1",
      accountRef: ACCOUNT,
      assetId: PUSD,
    });
    const result = book.reserve(request as never);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe("INVENTORY_INVALID_INPUT");
  });

  it("refuses an unregistered asset", () => {
    const book = seededBook({ [PUSD]: "100" });
    const result = book.reserve({ reservationId: "r1", holderRef: "o1", accountRef: ACCOUNT, assetId: "mystery", amount: "1" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe("INVENTORY_UNKNOWN_ASSET");
  });
});

describe("double reservation (§9.14; WP-040 inventory_reservations_no_double_reservation)", () => {
  it("a reservation id is single-use, even after release", () => {
    const book = seededBook({ [PUSD]: "100" });
    expect(book.reserve({ reservationId: "r1", holderRef: "o1", accountRef: ACCOUNT, assetId: PUSD, amount: "10" }).ok).toBe(true);
    expect(book.release({ reservationId: "r1" }).ok).toBe(true);
    const again = book.reserve({ reservationId: "r1", holderRef: "o9", accountRef: ACCOUNT, assetId: PUSD, amount: "10" });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.refusal.code).toBe("INVENTORY_DUPLICATE_RESERVATION_ID");
  });

  it("one holder holds at most one ACTIVE reservation per asset (a second one is a bug, not a top-up)", () => {
    const book = seededBook({ [PUSD]: "100" });
    expect(book.reserve({ reservationId: "r1", holderRef: "order-1", accountRef: ACCOUNT, assetId: PUSD, amount: "10" }).ok).toBe(true);
    const second = book.reserve({ reservationId: "r2", holderRef: "order-1", accountRef: ACCOUNT, assetId: PUSD, amount: "10" });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.refusal.code).toBe("INVENTORY_DOUBLE_RESERVATION");
    expect(book.line(ACCOUNT, PUSD)?.reserved).toBe("10");
    // After the first is released, the holder may reserve again under a new id.
    expect(book.release({ reservationId: "r1" }).ok).toBe(true);
    expect(book.reserve({ reservationId: "r3", holderRef: "order-1", accountRef: ACCOUNT, assetId: PUSD, amount: "10" }).ok).toBe(true);
  });

  it("two holders cannot reserve the same unit: the sum never exceeds actual", () => {
    const book = seededBook({ [YES]: "5" });
    expect(book.reserve({ reservationId: "a", holderRef: "sell-a", accountRef: ACCOUNT, assetId: YES, amount: "5" }).ok).toBe(true);
    const b = book.reserve({ reservationId: "b", holderRef: "sell-b", accountRef: ACCOUNT, assetId: YES, amount: "0.01" });
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.refusal.code).toBe("INVENTORY_INSUFFICIENT_AVAILABLE");
  });
});

describe("partial fills release only the unused part", () => {
  it("reserve 100, fill 40, release → 60 freed, 40 still in flight until settled", () => {
    const book = seededBook({ [PUSD]: "100" });
    expect(book.reserve({ reservationId: "r1", holderRef: "o1", accountRef: ACCOUNT, assetId: PUSD, amount: "100" }).ok).toBe(true);
    expect(book.consume({ reservationId: "r1", amount: "40", pendingId: "fill-1" }).ok).toBe(true);
    const released = book.release({ reservationId: "r1" });
    expect(released.ok).toBe(true);
    if (released.ok) {
      expect(released.value).toMatchObject({ status: "RELEASED", consumed: "40", released: "60", remaining: "0" });
    }
    expect(book.line(ACCOUNT, PUSD)).toMatchObject({ actual: "100", reserved: "0", pendingOut: "40", available: "60" });
    expect(book.settlePending({ pendingId: "fill-1", settlement: "APPLIED" }).ok).toBe(true);
    expect(book.line(ACCOUNT, PUSD)).toMatchObject({ actual: "60", reserved: "0", pendingOut: "0", available: "60" });
    expect(book.checkInvariants()).toEqual([]);
  });

  it("a fully consumed reservation is CONSUMED and cannot be released or over-consumed", () => {
    const book = seededBook({ [PUSD]: "10" });
    expect(book.reserve({ reservationId: "r1", holderRef: "o1", accountRef: ACCOUNT, assetId: PUSD, amount: "10" }).ok).toBe(true);
    const over = book.consume({ reservationId: "r1", amount: "10.01", pendingId: "f0" });
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.refusal.code).toBe("INVENTORY_OVER_CONSUMPTION");
    expect(book.consume({ reservationId: "r1", amount: "10", pendingId: "f1" }).ok).toBe(true);
    expect(book.reservation("r1")?.status).toBe("CONSUMED");
    expect(book.release({ reservationId: "r1" }).ok).toBe(false);
    expect(book.consume({ reservationId: "r1", amount: "1", pendingId: "f2" }).ok).toBe(false);
  });

  it("a FAILED settlement voids the debit and the amount becomes available again", () => {
    const book = seededBook({ [PUSD]: "10" });
    expect(book.reserve({ reservationId: "r1", holderRef: "o1", accountRef: ACCOUNT, assetId: PUSD, amount: "10" }).ok).toBe(true);
    expect(book.consume({ reservationId: "r1", amount: "10", pendingId: "f1" }).ok).toBe(true);
    expect(book.available(ACCOUNT, PUSD)).toBe("0");
    expect(book.settlePending({ pendingId: "f1", settlement: "VOIDED" }).ok).toBe(true);
    expect(book.line(ACCOUNT, PUSD)).toMatchObject({ actual: "10", available: "10" });
  });

  it("pending ids are single-use and an unknown pending id is refused", () => {
    const book = seededBook({ [PUSD]: "10" });
    expect(book.reserve({ reservationId: "r1", holderRef: "o1", accountRef: ACCOUNT, assetId: PUSD, amount: "10" }).ok).toBe(true);
    expect(book.consume({ reservationId: "r1", amount: "1", pendingId: "p" }).ok).toBe(true);
    expect(book.consume({ reservationId: "r1", amount: "1", pendingId: "p" }).ok).toBe(false);
    expect(book.settlePending({ pendingId: "nope", settlement: "APPLIED" }).ok).toBe(false);
  });
});

describe("authoritative observations", () => {
  it("are refused while the line has unresolved pending amounts (no double count)", () => {
    const book = seededBook({ [YES]: "0" });
    expect(book.expectInflow({ pendingId: "buy-fill", accountRef: ACCOUNT, assetId: YES, amount: "5" }).ok).toBe(true);
    const observed = book.observeActual({ accountRef: ACCOUNT, assetId: YES, balance: "5" });
    expect(observed.ok).toBe(false);
    if (!observed.ok) expect(observed.refusal.code).toBe("INVENTORY_PENDING_UNRESOLVED");
  });

  it("an observation below the reservations blocks the line until a covering observation", () => {
    const book = seededBook({ [PUSD]: "100" });
    expect(book.reserve({ reservationId: "r1", holderRef: "o1", accountRef: ACCOUNT, assetId: PUSD, amount: "80" }).ok).toBe(true);
    const observed = book.observeActual({ accountRef: ACCOUNT, assetId: PUSD, balance: "50" });
    expect(observed.ok && observed.value.overCommitted).toBe(true);
    expect(book.line(ACCOUNT, PUSD)?.blocked).toBe("OVER_COMMITTED");
    expect(book.release({ reservationId: "r1" }).ok).toBe(true);
    // Still blocked: only a new authoritative read clears it.
    expect(book.reserve({ reservationId: "r2", holderRef: "o2", accountRef: ACCOUNT, assetId: PUSD, amount: "1" }).ok).toBe(false);
    expect(book.observeActual({ accountRef: ACCOUNT, assetId: PUSD, balance: "50" }).ok).toBe(true);
    expect(book.reserve({ reservationId: "r3", holderRef: "o3", accountRef: ACCOUNT, assetId: PUSD, amount: "1" }).ok).toBe(true);
  });
});

describe("seeding from the ledger's ACTUAL_ACCOUNT balance lines (delegation to packages/ledger)", () => {
  const line = (overrides: Partial<BalanceLine>): BalanceLine => ({
    scope: "ACTUAL_ACCOUNT",
    accountRef: ACCOUNT,
    assetId: PUSD,
    assetKind: "COLLATERAL",
    balance: "250",
    ...overrides,
  });

  it("accepts the ledger BalanceLine shape and sets actual balances", () => {
    const book = new InventoryBook(registry());
    const seeded = book.seedFromLedgerBalances([line({}), line({ assetId: YES, assetKind: "OUTCOME_TOKEN", balance: "12.5" })]);
    expect(seeded.ok).toBe(true);
    expect(book.line(ACCOUNT, PUSD)?.actual).toBe("250");
    expect(book.line(ACCOUNT, YES)?.available).toBe("12.5");
    expect(book.line(ACCOUNT, NO)).toBeUndefined();
  });

  it("refuses a virtual/unattributed/clearing line and an asset-kind mismatch, all or nothing", () => {
    const book = new InventoryBook(registry());
    for (const scope of ["VIRTUAL_STRATEGY", "UNATTRIBUTED", "EXTERNAL_CLEARING", "FEE_EXPENSE", "REWARD_INCOME"] as const) {
      expect(book.seedFromLedgerBalances([line({}), line({ scope })]).ok).toBe(false);
    }
    expect(book.seedFromLedgerBalances([line({ assetKind: "OUTCOME_TOKEN" })]).ok).toBe(false);
    expect(book.line(ACCOUNT, PUSD)).toBeUndefined();
  });
});
