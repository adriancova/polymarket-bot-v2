/**
 * `BACKTEST-2` — the ONE simulated-venue builder (ADR-022 D5).
 *
 * What the builder fixes and what it takes are pinned here against the REAL
 * `packages/simulation` venue: the fee door's refusal is the builder's; the
 * book and the time-in-force are answered THROUGH the holder the caller fills
 * (never by the venue, never by a default); the venue's run mode is the core's
 * PAPER; the unmodelled rate-limit disclosure is `main.ts`'s; and each
 * parameter a caller may pass (`rateLimits`, `retention`, `log`) reaches the
 * venue. The whole-system paths are the e2e suite, the paper-trader suite and
 * the backtest replay, which all build their venue here.
 *
 * NO DOCKER, NO NETWORK, NO CREDENTIAL.
 */

import { tokenBucketRateLimits, type SimulatedVenue } from "@polymarket-bot/simulation";
import { describe, expect, it } from "vitest";

import type { PaperTrader } from "./trader.js";
import {
  UNMODELED_VENUE_RATE_LIMITS_DISCLOSURE,
  buildSimulatedVenue,
  type SimulatedVenueSettings,
} from "./venue-builder.js";

const MARKET = "018f4a7e-1111-7abc-8def-0123456789ab";
const EPOCH = "018f4a7e-5555-7abc-8def-0123456789ab";
const AT = "2026-03-04T12:00:01.000Z";
const CLOCK = { now: () => AT, monotonicNs: () => 0n };

function settings(overrides: Partial<SimulatedVenueSettings> = {}): SimulatedVenueSettings {
  return {
    fillModelVersion: "tier0.builder-test",
    fillModelParametersHash: "c".repeat(64),
    feeSchedule: {
      snapshotVersion: "builder-test.2026-03-04",
      takerFeeRate: "0",
      makerFeeRate: "0",
      roundingDecimalPlaces: 6,
      roundingMode: "HALF_UP",
      minimumChargedFee: "0",
      feeCurrency: "pUSD",
    },
    ...overrides,
  };
}

/** A trader as far as the holder is read: one market's book (`C1-TIF`: the time-in-force is on the plan). */
function traderStub(): PaperTrader {
  const book = {
    topOfBook: () => ({ bestAskPrice: "0.34", bestAskSize: "200" }),
    levels: (side: string) => (side === "ASK" || side === "asks" ? [{ price: "0.34", size: "200" }] : []),
  };
  return {
    markets: new Map([[MARKET, { config: { yesTokenId: "111", noTokenId: "222" }, bookFor: () => book }]]),
  } as unknown as PaperTrader;
}

async function submitOne(venue: SimulatedVenue, runMode = "PAPER", timeInForce?: string) {
  venue.observe({ gatewayEpoch: EPOCH, ingestSeq: "1", receivedAt: AT, datasetRowOrdinal: 1 });
  return await venue.submit({
    executionPlanId: "018f4a7e-6666-7abc-8def-000000000001",
    planKind: "PLACE",
    runMode,
    accountingMode: "LIVE",
    groups: [
      {
        marketId: MARKET,
        orders: [
          {
            plannedOrderId: "planned-1",
            tokenId: "111",
            side: "YES",
            action: "BUY",
            limitPrice: "0.34",
            shares: "10",
            executionStyle: "MARKETABLE_LIMIT",
            postOnly: false,
            ...(timeInForce === undefined ? {} : { timeInForce }),
          },
        ],
      },
    ],
    reservations: [],
  } as unknown as Parameters<SimulatedVenue["submit"]>[0]);
}

describe("buildSimulatedVenue — the one place the simulated venue is constructed", () => {
  it("refuses a fee snapshot the simulator's own door refuses, and builds nothing", () => {
    const built = buildSimulatedVenue({
      clock: CLOCK,
      startingCash: "1000",
      settings: settings({ feeSchedule: { ...settings().feeSchedule, takerFeeRate: "-0.01" } }),
    });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.refusal.code).toBe("FILL_MODEL_FEE_SNAPSHOT_MISSING");
  });

  it("the venue opens with the startingCash it is handed (the configuration's accounting.startingCash)", async () => {
    const built = buildSimulatedVenue({ clock: CLOCK, settings: settings(), startingCash: "777.5" });
    if (!built.ok) throw new Error(built.refusal.code);
    expect((await built.venue.queryAccountState()).cashBalance).toBe("777.5");
  });

  it("an order that carries no time-in-force: the policy refuses to assume one, logs the order, and the venue contains it", async () => {
    const lines: string[] = [];
    const built = buildSimulatedVenue({ clock: CLOCK, settings: settings(), startingCash: "1000", log: (line) => lines.push(line) });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.wiring.trader).toBeUndefined();
    const result = await submitOne(built.venue);
    expect(result.accepted).toBe(false);
    expect(result.fills).toEqual([]);
    expect(lines.join("\n")).toContain("SUBMISSION REFUSED");
    expect(lines.join("\n")).toContain("planned-1");
    // The unmodelled budget, with the disclosure main.ts has always carried.
    expect(result.rateLimitModel).toBe("NOT_MODELED");
    expect(result.rateLimitDisclosure).toBe(UNMODELED_VENUE_RATE_LIMITS_DISCLOSURE);
  });

  it("a FILLED holder: the book is read through the trader, the time-in-force from the plan, and the order fills at its ask", async () => {
    const built = buildSimulatedVenue({ clock: CLOCK, settings: settings(), startingCash: "1000" });
    if (!built.ok) throw new Error(built.refusal.code);
    built.wiring.trader = traderStub();
    const result = await submitOne(built.venue, "PAPER", "FAK");
    expect(result.accepted, JSON.stringify(result)).toBe(true);
    expect(result.fills.map((fill) => `${fill.action} ${fill.shares}@${fill.price}`)).toEqual(["BUY 10@0.34"]);
    // The fill carries the settings' fill model and the venue's evidence class.
    expect(result.fills[0]?.fillModelVersion).toBe("tier0.builder-test");
    expect(result.fills[0]?.evidenceClass).toBe("SIMULATED_NOT_REAL_EVIDENCE");
  });

  it("the venue runs in the core's run mode, PAPER: a plan naming BACKTEST is refused", async () => {
    const built = buildSimulatedVenue({ clock: CLOCK, settings: settings(), startingCash: "1000" });
    if (!built.ok) throw new Error(built.refusal.code);
    built.wiring.trader = traderStub();
    const result = await submitOne(built.venue, "BACKTEST", "FAK");
    expect(result.accepted).toBe(false);
    expect(result.fills).toEqual([]);
    expect(result.refusalMessage).toContain("this venue serves PAPER and the plan names BACKTEST");
  });

  it("the caller's parameters reach the venue: rateLimits replaces the default budget, retention its bounds", async () => {
    const built = buildSimulatedVenue({
      clock: CLOCK,
      settings: settings(),
      startingCash: "1000",
      rateLimits: tokenBucketRateLimits({
        orderTokensPerWindow: 0,
        cancelTokensPerWindow: 10,
        windowMs: 1_000,
        snapshotVersion: "builder-test/rate-limits/v1",
      }),
      retention: { orders: 7 },
    });
    if (!built.ok) throw new Error(built.refusal.code);
    built.wiring.trader = traderStub();
    const result = await submitOne(built.venue, "PAPER", "FAK");
    // A budget with no order token: the REAL venue refuses the placement.
    expect(result.accepted).toBe(false);
    expect(result.refusalCode).toBe("SIMULATED_VENUE_RATE_LIMITED");
    expect(result.rateLimitModel).toBe("MODELED");
    expect(result.rateLimitDisclosure).toContain("builder-test/rate-limits/v1");
    expect(built.venue.retention().orders.maximumRetained).toBe(7);
    // A bound the venue refuses is the venue constructor's own RangeError, unchanged.
    expect(() => buildSimulatedVenue({ clock: CLOCK, settings: settings(), startingCash: "1000", retention: { orders: 0 } })).toThrow(
      RangeError,
    );
  });
});
