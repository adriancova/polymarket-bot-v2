import { describe, expect, it } from "vitest";

import { OutcomeTokenBook } from "./book.js";
import { priceGrid } from "./price-helper.js";

const MARKET_ID = "0192aaaa-bbbb-7ccc-8ddd-eeeeffff0001";
const TOKEN_ID = "123";

function bookWithTick(tickSize = "0.01"): OutcomeTokenBook {
  const book = new OutcomeTokenBook({ internalMarketId: MARKET_ID, tokenId: TOKEN_ID });
  expect(book.applyTickSizeChange({ tickSize }).applied).toBe(true);
  return book;
}

describe("priceGrid issuance", () => {
  it("refuses when the book has no tick size yet", () => {
    const book = new OutcomeTokenBook({ internalMarketId: MARKET_ID, tokenId: TOKEN_ID });
    const result = priceGrid(book);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal.code).toBe("ORDER_BOOK_NO_TICK_SIZE");
    }
  });

  it("pins the grid to the current tick size", () => {
    const result = priceGrid(bookWithTick("0.001"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.grid.tickSize).toBe("0.001");
      expect(result.grid.status()).toEqual({ valid: true });
    }
  });
});

describe("grid arithmetic (exact, no floats)", () => {
  it("checks conformance by exact modulo — 0.07 on a 0.01 grid conforms", () => {
    const result = priceGrid(bookWithTick("0.01"));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.grid.isConformant("0.07")).toEqual({ ok: true, value: true });
    expect(result.grid.isConformant("0.075")).toEqual({ ok: true, value: false });
    expect(result.grid.isConformant("0")).toEqual({ ok: true, value: true });
  });

  it("snaps down and up to the grid exactly", () => {
    const result = priceGrid(bookWithTick("0.01"));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.grid.snapDown("0.075")).toEqual({ ok: true, value: "0.07" });
    expect(result.grid.snapUp("0.075")).toEqual({ ok: true, value: "0.08" });
    expect(result.grid.snapDown("0.07")).toEqual({ ok: true, value: "0.07" });
    expect(result.grid.snapUp("0.07")).toEqual({ ok: true, value: "0.07" });
    expect(result.grid.snapDown("0.0999")).toEqual({ ok: true, value: "0.09" });
    expect(result.grid.snapUp("0.0001")).toEqual({ ok: true, value: "0.01" });
    expect(result.grid.snapDown("0.0001")).toEqual({ ok: true, value: "0" });
  });

  it("refuses a non-canonical price rather than normalizing it", () => {
    const result = priceGrid(bookWithTick("0.01"));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const snapped = result.grid.snapDown("0.10");
    expect(snapped.ok).toBe(false);
    if (!snapped.ok) {
      expect(snapped.refusal.code).toBe("ORDER_BOOK_NONCANONICAL_DECIMAL");
    }
  });
});

describe("tick-size changes and helper invalidation", () => {
  it("acceptance 3: a tick-size change invalidates nonconforming price helpers — typed, visible, never silently wrong", () => {
    const book = bookWithTick("0.01");
    const issued = priceGrid(book);
    expect(issued.ok).toBe(true);
    if (!issued.ok) {
      return;
    }
    const grid = issued.grid;
    expect(grid.snapDown("0.075")).toEqual({ ok: true, value: "0.07" });

    // The venue moves the market to a finer grid.
    expect(book.applyTickSizeChange({ tickSize: "0.001" }).applied).toBe(true);

    // Every operation of the previously issued helper now refuses, carrying
    // both tick sizes. On the new 0.001 grid, snapDown("0.075") would be
    // "0.075" itself — the old helper's "0.07" answer would be silently
    // wrong, which is exactly what the invalidation prevents.
    for (const outcome of [grid.snapDown("0.075"), grid.snapUp("0.075"), grid.isConformant("0.075")]) {
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.refusal.code).toBe("ORDER_BOOK_PRICE_HELPER_INVALIDATED");
        expect(outcome.refusal.evidence).toEqual({
          pinnedTickSize: "0.01",
          currentTickSize: "0.001",
        });
      }
    }
    expect(grid.status().valid).toBe(false);

    // A grid issued AFTER the change conforms to the new tick.
    const fresh = priceGrid(book);
    expect(fresh.ok).toBe(true);
    if (fresh.ok) {
      expect(fresh.grid.snapDown("0.075")).toEqual({ ok: true, value: "0.075" });
    }
  });

  it("a restatement of the identical tick size does NOT invalidate (the helper still conforms)", () => {
    const book = bookWithTick("0.01");
    const issued = priceGrid(book);
    expect(issued.ok).toBe(true);
    if (!issued.ok) {
      return;
    }
    expect(book.applyTickSizeChange({ tickSize: "0.01" }).applied).toBe(true);
    expect(issued.grid.status()).toEqual({ valid: true });
    expect(issued.grid.snapDown("0.075")).toEqual({ ok: true, value: "0.07" });
  });

  it("refuses a non-positive or non-canonical tick size", () => {
    const book = new OutcomeTokenBook({ internalMarketId: MARKET_ID, tokenId: TOKEN_ID });
    for (const tickSize of ["0", "-0.01", "0.010", "1e-2", ""]) {
      const outcome = book.applyTickSizeChange({ tickSize });
      expect(outcome.applied).toBe(false);
      if (!outcome.applied) {
        expect(outcome.refusal.code).toBe("ORDER_BOOK_TICK_SIZE_INVALID");
      }
    }
  });

  it("refuses a parametersVersion regression and a same-version contradiction", () => {
    const book = new OutcomeTokenBook({ internalMarketId: MARKET_ID, tokenId: TOKEN_ID });
    expect(book.applyTickSizeChange({ tickSize: "0.01", parametersVersion: 5 }).applied).toBe(true);

    const regression = book.applyTickSizeChange({ tickSize: "0.001", parametersVersion: 4 });
    expect(regression.applied).toBe(false);
    if (!regression.applied) {
      expect(regression.refusal.code).toBe("ORDER_BOOK_PARAMETERS_VERSION_REGRESSION");
    }

    const contradiction = book.applyTickSizeChange({ tickSize: "0.001", parametersVersion: 5 });
    expect(contradiction.applied).toBe(false);
    if (!contradiction.applied) {
      expect(contradiction.refusal.code).toBe("ORDER_BOOK_PARAMETERS_VERSION_CONTRADICTION");
    }

    // The refused changes moved nothing: the grid is still 0.01.
    expect(book.tickSize()).toBe("0.01");
    expect(book.applyTickSizeChange({ tickSize: "0.001", parametersVersion: 6 }).applied).toBe(true);
    expect(book.tickSize()).toBe("0.001");
  });
});
