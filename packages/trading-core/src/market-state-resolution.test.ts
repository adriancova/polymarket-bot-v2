/**
 * `ROLLOVER-1` r4 (R4-ASTRA-02): a market's resolution is TERMINAL in
 * `MarketState`. A `MarketOpened`/`MarketClosing` applied after it changes
 * nothing (`markLifecycle` answers `false`), and a repeated resolution changes
 * nothing either (`markResolved` answers `false`; the first resolution, its
 * outcome and its instant, stands). Until r4 `markLifecycle` overwrote
 * `RESOLVED`, which re-armed `onMarketResolved` for a repeat and hid the
 * resolution from the window teardown (`loop.ts`). The loop-level pins are in
 * `test/integration/paper-trader/rollover-1-window-lifecycle.test.ts`.
 */

import { describe, expect, it } from "vitest";

import type { MarketConfig } from "./config.js";
import { MarketState } from "./market-state.js";

const config = {
  marketId: "018f4a7e-1111-7abc-8def-0123456789ab",
  conditionId: "0xcondition",
  yesTokenId: "111",
  noTokenId: "222",
  tickSize: "0.01",
  minimumOrderSize: "5",
  makerFeeRate: "0",
  takerFeeRate: "0",
  openTime: "2026-03-04T12:00:00.000Z",
  closeTime: "2026-03-04T12:15:00.000Z",
  parametersVersion: 1,
  settlementReadiness: { modelDependentActivationAllowed: false },
  seriesKey: "s",
  underlyingKey: "BTC",
  resolutionWindowKey: "w",
} as MarketConfig;

function fresh(): MarketState {
  return new MarketState({ config, tradeWindowMs: 60_000, maximumTrades: 10 });
}

describe("ROLLOVER-1 r4 (R4-ASTRA-02): a resolution is terminal in MarketState", () => {
  it("control: before a resolution, the lifecycle moves as the events say", () => {
    const market = fresh();
    expect(market.lifecycle).toBe("PENDING");
    market.markLifecycle("OPEN");
    expect(market.lifecycle).toBe("OPEN");
    market.markLifecycle("CLOSING");
    expect(market.lifecycle).toBe("CLOSING");
  });

  it("R4-ASTRA-02: after the resolution, a late OPEN or CLOSING changes nothing (and answers false)", () => {
    const market = fresh();
    market.markLifecycle("OPEN");
    const applied = market.markResolved("YES_WIN", "2026-03-04T12:16:00.000Z");
    for (const late of ["OPEN", "CLOSING", "PENDING"] as const) {
      const moved = market.markLifecycle(late);
      expect(market.lifecycle).toBe("RESOLVED");
      expect(moved).toBe(false);
    }
    expect(market.resolvedOutcome).toBe("YES_WIN");
    expect(market.resolvedAt).toBe("2026-03-04T12:16:00.000Z");
    expect(applied).toBe(true);
  });

  it("R4-ASTRA-02: a repeated resolution — after a late lifecycle event too — changes nothing (and answers false); the first stands", () => {
    const market = fresh();
    const first = market.markResolved("YES_WIN", "2026-03-04T12:16:00.000Z");
    market.markLifecycle("CLOSING");
    const second = market.markResolved("NO_WIN", "2026-03-04T12:17:00.000Z");
    expect(market.resolvedOutcome).toBe("YES_WIN");
    expect(market.resolvedAt).toBe("2026-03-04T12:16:00.000Z");
    expect(market.lifecycle).toBe("RESOLVED");
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it("the answers: a lifecycle move and a first resolution answer true", () => {
    const market = fresh();
    expect(market.markLifecycle("OPEN")).toBe(true);
    expect(market.markResolved("NO_WIN", "2026-03-04T12:16:00.000Z")).toBe(true);
  });
});
