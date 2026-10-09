/**
 * ADR-034 D2.4: Static Bracket's configuration door refuses an off-grid
 * `size_shares`, or any other configured share quantity, at load. An operator
 * cannot configure a size the venue cannot execute ("Size decimals" is 2 for
 * every tick size: `docs/venue/verified-2026-10-06.md` F-99, F-101), and the
 * configuration is never rounded.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { isOnSizeGrid, sizeGridFor } from "../../../../packages/execution-planner/src/index.js";

import { validateStaticBracketParams } from "../../../../packages/strategies/static-bracket/src/index.js";
import { SHARE_QUANTITY_DECIMALS } from "../../../../packages/strategies/static-bracket/src/params.js";

import { configWith } from "./helpers.js";

/** Every configured SHARE quantity of the grammar (§13.2). */
const SHARE_FIELDS = ["entry.size_shares", "entry.execution.minimum_fill_shares", "risk.maximum_position_shares"] as const;

describe("the configuration door refuses an off-grid share quantity at load (ADR-034 D2.4)", () => {
  it("the grid is the venue's 2 decimals", () => {
    expect(SHARE_QUANTITY_DECIMALS).toBe(2);
  });

  for (const field of SHARE_FIELDS) {
    // Kept within the configuration's coherence rules: minimum_fill ≤ size ≤ maximum_position.
    const offGrid = field === "risk.maximum_position_shares" ? "50.005" : field === "entry.size_shares" ? "49.995" : "9.999";
    const onGrid = field === "risk.maximum_position_shares" ? "50.01" : field === "entry.size_shares" ? "49.99" : "9.99";

    it(`${field}: ${offGrid} is refused, naming the field and the grid; never rounded`, () => {
      const result = validateStaticBracketParams(configWith({ [field]: offGrid }));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.problem).toContain(field.split(".").at(-1) ?? field);
      expect(result.problem).toMatch(/off the venue's 0\.01 share grid/u);
    });

    it(`${field}: ${onGrid} is accepted as written`, () => {
      const result = validateStaticBracketParams(configWith({ [field]: onGrid }));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      let cursor: unknown = result.value;
      for (const segment of field.split(".")) cursor = (cursor as Record<string, unknown>)[segment];
      expect(cursor).toBe(onGrid);
    });

    it(`${field}: redundant trailing zeros are not a grid violation ("${onGrid}000" normalizes to ${onGrid})`, () => {
      const result = validateStaticBracketParams(configWith({ [field]: `${onGrid}000` }));
      expect(result.ok).toBe(true);
    });
  }

  it.each(["50.001", "50.0001", "50.000001", "50.123456789"])("entry.size_shares %s is refused", (value) => {
    const result = validateStaticBracketParams(configWith({ "entry.size_shares": value, "risk.maximum_position_shares": "100" }));
    expect(result.ok).toBe(false);
  });

  it("a zero minimum_fill_shares stays admissible (it is on the grid)", () => {
    expect(validateStaticBracketParams(configWith({ "entry.execution.minimum_fill_shares": "0" })).ok).toBe(true);
  });

  it("the test baseline (size 50) is on the grid", () => {
    expect(validateStaticBracketParams(configWith({})).ok).toBe(true);
  });
});

describe("no shipped configuration is off the grid (ADR-034 D2: a latent PAPER change, with no golden change)", () => {
  const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "..");
  for (const relative of [
    "infra/compose/trader/trader.config.example.json",
    "test/replay-golden/backtest/static-bracket/trader-config.json",
    "test/fixtures/trader-throughput/template.json",
  ]) {
    it(`${relative}: every instance's params load; every market's tick is in the venue's table; maxSliceShares is on its grid`, () => {
      const config = JSON.parse(readFileSync(resolve(REPO_ROOT, relative), "utf8")) as {
        readonly instances: readonly { readonly params: unknown }[];
        readonly markets: readonly { readonly tickSize: string }[];
        readonly planning: { readonly maxSliceShares: string };
      };
      expect(config.instances.length).toBeGreaterThan(0);
      for (const instance of config.instances) expect(validateStaticBracketParams(instance.params).ok).toBe(true);
      for (const market of config.markets) {
        expect(sizeGridFor(market.tickSize), market.tickSize).toBe("0.01");
        expect(isOnSizeGrid(config.planning.maxSliceShares, market.tickSize)).toBe(true);
      }
    });
  }
});
