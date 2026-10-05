/**
 * `ROLLOVER-1` r1 (R1-01): `AllocatorGate.registerMarketAssets` — a market
 * admitted after the gate was built (a series window) becomes known to its
 * position projection. The trader-level behaviour (a window's exit is
 * approved; its exposure counts toward the global cap) is pinned in
 * `test/integration/paper-trader/rollover-1-window-lifecycle.test.ts`.
 *
 * `ROLLOVER-1` r7 (R7-FABLE-03): `AllocatorGate.holdsCommitmentIn` — the read
 * the loop's teardown consults (`#windowHoldsWork`), and the mechanism it
 * guards against: a commitment that outlives its market's live owner refuses
 * EVERY later question, a protective REDUCE that holds inventory included.
 * The trader-level pin is
 * `test/integration/paper-trader/rollover-1-instance-portfolio.test.ts`.
 */

import { parseAllocatorCaps } from "@polymarket-bot/capital-allocator";
import type { Intent } from "@polymarket-bot/domain";
import { Ledger } from "@polymarket-bot/ledger";
import { describe, expect, it } from "vitest";

import { projectionOf } from "./accounting.js";
import { AllocatorGate, requestFor, type AllocationMarket, type OrderViewOf } from "./allocation.js";

function gate(): AllocatorGate {
  const caps = parseAllocatorCaps({
    globalAccountCap: "20",
    perStrategyCap: "20",
    liveMicroMaxOrderNotional: "0",
    liveMicroMaxAccountExposure: "0",
  });
  if (!caps.ok) throw new Error("caps refused");
  return new AllocatorGate({
    caps: caps.value,
    markets: new Map(),
    tokenAssetIds: new Map([
      ["m-configured|YES", "token:1"],
      ["m-configured|NO", "token:2"],
    ]),
  });
}

describe("AllocatorGate.registerMarketAssets (R1-01)", () => {
  it("maps a window's two assets, idempotently", () => {
    const subject = gate();
    expect(subject.registerMarketAssets("w-1", "token:11", "token:12")).toBe(true);
    expect(subject.registerMarketAssets("w-1", "token:11", "token:12")).toBe(true);
  });

  it("refuses, changing nothing, an asset mapped to another market or side, or one asset for both sides", () => {
    const subject = gate();
    expect(subject.registerMarketAssets("w-1", "token:1", "token:12")).toBe(false);
    expect(subject.registerMarketAssets("w-1", "token:12", "token:12")).toBe(false);
    expect(subject.registerMarketAssets("w-1", "token:11", "token:12")).toBe(true);
    expect(subject.registerMarketAssets("w-1", "token:12", "token:11")).toBe(false);
    expect(subject.registerMarketAssets("w-2", "token:11", "token:13")).toBe(false);
    // The refused registrations left nothing behind: token:13 is still free.
    expect(subject.registerMarketAssets("w-2", "token:13", "token:14")).toBe(true);
  });
});

describe("ROLLOVER-1 r7 (R7-FABLE-03): a commitment that outlives its window's live owner refuses every question — so a window is never torn down while one names its market", () => {
  const W1 = "018f4a7e-1111-7abc-8def-0000000000a1";
  const W2 = "018f4a7e-1111-7abc-8def-0000000000a2";
  const INSTANCE = "a18f4a7e-2222-7abc-8def-0123456789ab";
  const NO_VIEW: OrderViewOf = () => undefined;
  const scope = (marketId: string): AllocationMarket => ({
    marketId,
    seriesKey: "btc-15m-updown",
    underlyingKey: "BTC",
    resolutionWindowKey: marketId === W1 ? "w1" : "w2",
  });
  /** The instance holds 10 YES of W2 (the inventory W2's protective REDUCE sells). */
  const HOLDING_10_W2_YES = {
    ...projectionOf(Ledger.empty("PAPER")),
    virtualPositions: new Map([
      ["v-w2", { instanceId: INSTANCE, assetId: "token:21", assetKind: "OUTCOME_TOKEN", marketId: W2, balance: "10" }],
    ]),
  } as unknown as ReturnType<typeof projectionOf>;
  const BOTH_OWNED = [
    { marketId: W1, strategyInstanceId: INSTANCE },
    { marketId: W2, strategyInstanceId: INSTANCE },
  ];
  /** What `#liveOwners` answers once W1's registrations are retired (its teardown). */
  const W1_TORN_DOWN = [{ marketId: W2, strategyInstanceId: INSTANCE }];

  /** W1's entry, 50 YES at ≤ 0.34, applied; then its one fill booked UNATTRIBUTED and its final size settled — the commitment never closes. */
  function unattributedW1(): AllocatorGate {
    const caps = parseAllocatorCaps({ globalAccountCap: "1000", perStrategyCap: "1000", liveMicroMaxOrderNotional: "0", liveMicroMaxAccountExposure: "0" });
    if (!caps.ok) throw new Error("caps refused");
    const subject = new AllocatorGate({ caps: caps.value, markets: new Map([[W1, scope(W1)], [W2, scope(W2)]]), tokenAssetIds: new Map() });
    expect(subject.registerMarketAssets(W1, "token:11", "token:12")).toBe(true);
    expect(subject.registerMarketAssets(W2, "token:21", "token:22")).toBe(true);
    const applied = subject.applyForPlan({
      entries: [
        {
          plannedOrderId: "w1-entry",
          request: requestFor({
            reservationId: "018f4a7e-7000-7abc-8def-0000000000e1",
            instanceId: INSTANCE,
            accountingMode: "LIVE",
            leg: { marketId: W1, side: "YES", action: "BUY", price: "0.34", shares: "50" },
            market: scope(W1),
          }),
        },
      ],
      liveOwners: BOTH_OWNED,
      projection: HOLDING_10_W2_YES,
      availableCollateral: "1000",
      viewOf: NO_VIEW,
    });
    expect(applied.ok).toBe(true);
    subject.observeUnattributedFill({ simulatedFillId: "f-w1", marketId: W1, side: "YES", action: "BUY", price: "0.34", shares: "50" }, "w1-entry");
    expect(subject.settle("w1-entry", { filledShares: "50", unbookedFills: undefined })).toBe(false);
    return subject;
  }

  const sellW2 = {
    type: "REDUCE_POSITION",
    intentId: "sb-exit-0",
    marketId: W2,
    targetShares: "0",
    minimumSellPrice: "0.26",
    urgency: "IMMEDIATE",
    liquidityPreference: "TAKER_OK",
    partialFillPolicy: "ACCEPT_ANY",
    validUntil: "2026-10-04T22:31:00Z",
    tags: [],
  } as unknown as Intent;
  const buyW2 = {
    type: "POSITION",
    intentId: "sb-entry-0",
    marketId: W2,
    direction: "YES",
    targetMode: "DELTA",
    targetShares: "10",
    maximumBuyPrice: "0.35",
    urgency: "IMMEDIATE",
    liquidityPreference: "TAKER_OK",
    partialFillPolicy: "ACCEPT_ANY",
    validUntil: "2026-10-04T22:31:00Z",
    tags: [],
  } as unknown as Intent;

  function ask(subject: AllocatorGate, intent: Intent, owners: readonly { readonly marketId: string; readonly strategyInstanceId: string }[], held: string): { readonly permitted: boolean | undefined; readonly codes: readonly string[] } {
    const outcome = subject.evaluate({
      intent,
      instanceId: INSTANCE,
      accountingMode: "LIVE",
      liveOwners: owners,
      projection: HOLDING_10_W2_YES,
      availableCollateral: "1000",
      approvedIntentId: "018f4a7e-7000-7abc-8def-0000000000e9",
      heldShares: (marketId, side) => (marketId === W2 && side === "YES" ? held : "0"),
      viewOf: NO_VIEW,
    });
    return { permitted: outcome.verdict?.permitted, codes: outcome.verdict?.refusals.map((refusal) => refusal.code) ?? [] };
  }

  it("holdsCommitmentIn answers TRUE for W1 while its never-closing commitment is kept, and FALSE for W2, which none names", () => {
    const subject = unattributedW1();
    expect(subject.metrics()).toMatchObject({ open: 1, reservedCollateral: "17" });
    expect(subject.holdsCommitmentIn(W1)).toBe(true);
    expect(subject.holdsCommitmentIn(W2)).toBe(false);
  });

  it("control: a commitment that CLOSES (its fill booked to the instance, its final size settled) no longer names W1", () => {
    const subject = unattributedW1();
    const caps = parseAllocatorCaps({ globalAccountCap: "1000", perStrategyCap: "1000", liveMicroMaxOrderNotional: "0", liveMicroMaxAccountExposure: "0" });
    if (!caps.ok) throw new Error("caps refused");
    const booked = new AllocatorGate({ caps: caps.value, markets: new Map([[W1, scope(W1)]]), tokenAssetIds: new Map() });
    expect(booked.registerMarketAssets(W1, "token:11", "token:12")).toBe(true);
    const applied = booked.applyForPlan({
      entries: [
        {
          plannedOrderId: "w1-entry",
          request: requestFor({
            reservationId: "018f4a7e-7000-7abc-8def-0000000000e1",
            instanceId: INSTANCE,
            accountingMode: "LIVE",
            leg: { marketId: W1, side: "YES", action: "BUY", price: "0.34", shares: "50" },
            market: scope(W1),
          }),
        },
      ],
      liveOwners: [{ marketId: W1, strategyInstanceId: INSTANCE }],
      projection: projectionOf(Ledger.empty("PAPER")),
      availableCollateral: "1000",
      viewOf: NO_VIEW,
    });
    expect(applied.ok).toBe(true);
    expect(booked.holdsCommitmentIn(W1)).toBe(true);
    booked.observeFill(INSTANCE, { simulatedFillId: "f-w1", marketId: W1, side: "YES", action: "BUY", price: "0.34", shares: "50" }, "w1-entry");
    expect(booked.settle("w1-entry", { filledShares: "50", unbookedFills: undefined })).toBe(true);
    expect(booked.holdsCommitmentIn(W1)).toBe(false);
    // The unattributed one never closes.
    expect(subject.holdsCommitmentIn(W1)).toBe(true);
  });

  it("the mechanism, with a POSITIVE control: while W1 is owned, W2's protective REDUCE of its 10 held shares and W2's entry are both PERMITTED; with W1's owner gone (a teardown), BOTH are refused CAPITAL_LIVE_OWNERSHIP_MISSING", () => {
    const subject = unattributedW1();
    expect(ask(subject, sellW2, BOTH_OWNED, "10")).toEqual({ permitted: true, codes: [] });
    expect(ask(subject, buyW2, BOTH_OWNED, "10")).toEqual({ permitted: true, codes: [] });
    const reduce = ask(subject, sellW2, W1_TORN_DOWN, "10");
    expect(reduce.permitted).toBe(false);
    expect(reduce.codes).toContain("CAPITAL_LIVE_OWNERSHIP_MISSING");
    const entry = ask(subject, buyW2, W1_TORN_DOWN, "10");
    expect(entry.permitted).toBe(false);
    expect(entry.codes).toContain("CAPITAL_LIVE_OWNERSHIP_MISSING");
  });
});
