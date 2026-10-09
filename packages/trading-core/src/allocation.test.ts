/**
 * The §9.7 allocator seam, unit-tested in isolation.
 *
 * The integration suite drives the gate through the assembled system; this file
 * pins the contracts that suite cannot reach cheaply — the FIFO cost basis, the
 * re-application of a held reservation against a changed account, the shadow
 * book, and the leg derivation for intent shapes the Static Bracket never emits.
 */

import { parseAllocatorCaps } from "@polymarket-bot/capital-allocator";
import type { Intent } from "@polymarket-bot/domain";
import { Ledger } from "@polymarket-bot/ledger";
import { parseRiskPolicy } from "@polymarket-bot/risk";
import { describe, expect, it } from "vitest";

import { projectionOf } from "./accounting.js";
import {
  AllocatorGate,
  CostBasisBook,
  intentLegs,
  requestFor,
  type AllocationMarket,
  type OrderViewOf,
} from "./allocation.js";
import type { MarketConfig } from "./config.js";
import { MarketState } from "./market-state.js";
import { buildRiskEvaluationInput, runRiskCheck } from "./pipeline.js";

const MARKET = "018f4a7e-1111-7abc-8def-0123456789ab";
const INSTANCE = "a18f4a7e-2222-7abc-8def-0123456789ab";
const OTHER = "b18f4a7e-3333-7abc-8def-0123456789ab";

const SCOPE: AllocationMarket = {
  marketId: MARKET,
  seriesKey: "btc-15m-updown",
  underlyingKey: "BTC",
  resolutionWindowKey: "w2026-03-04T12.15",
};

const EMPTY_PROJECTION = projectionOf(Ledger.empty("PAPER"));

/** `CAP-1` r1: a venue that shows no order (every commitment is judged as before). */
const NO_VIEW: OrderViewOf = () => undefined;

function gate(caps: Record<string, unknown> = {}): AllocatorGate {
  const parsed = parseAllocatorCaps({
    globalAccountCap: "1000",
    perStrategyCap: "1000",
    ...caps,
  });
  if (!parsed.ok) throw new Error(`caps refused: ${parsed.refusals[0]?.code ?? "?"}`);
  return new AllocatorGate({
    caps: parsed.value,
    markets: new Map([[MARKET, SCOPE]]),
    tokenAssetIds: new Map([
      [`${MARKET}|YES`, "token:111"],
      [`${MARKET}|NO`, "token:222"],
    ]),
  });
}

function buyIntent(shares = "50", price = "0.35"): Intent {
  return {
    type: "POSITION",
    intentId: "sb-entry-0",
    marketId: MARKET,
    direction: "YES",
    targetMode: "DELTA",
    targetShares: shares,
    maximumBuyPrice: price,
    urgency: "IMMEDIATE",
    liquidityPreference: "TAKER_OK",
    partialFillPolicy: "ACCEPT_ANY",
    validUntil: "2026-03-04T12:00:30Z",
    tags: [],
  } as unknown as Intent;
}

/** A §7.7 `QUOTE`: levels with prices, and no outcome token anywhere. */
function quoteIntent(): Intent {
  return {
    type: "QUOTE",
    intentId: "q-0",
    marketId: MARKET,
    bids: [{ price: "0.3", shares: "10" }],
    asks: [],
    postOnly: true,
    quoteLifetimeMs: 1000,
    replaceThresholdTicks: 1,
    maximumInventory: "100",
    tags: [],
  } as unknown as Intent;
}

function evaluate(
  subject: AllocatorGate,
  intent: Intent,
  overrides: {
    readonly owners?: readonly { readonly marketId: string; readonly strategyInstanceId: string }[];
    readonly cash?: string;
    readonly accountingMode?: "LIVE" | "SHADOW";
    readonly held?: string;
    readonly viewOf?: OrderViewOf;
  } = {},
): ReturnType<AllocatorGate["evaluate"]> {
  return subject.evaluate({
    intent,
    instanceId: INSTANCE,
    accountingMode: overrides.accountingMode ?? "LIVE",
    liveOwners: overrides.owners ?? [{ marketId: MARKET, strategyInstanceId: INSTANCE }],
    projection: EMPTY_PROJECTION,
    availableCollateral: overrides.cash ?? "1000",
    approvedIntentId: "018f4a7e-7000-7abc-8def-000000000001",
    heldShares: () => overrides.held ?? "0",
    viewOf: overrides.viewOf ?? NO_VIEW,
  });
}

describe("the FIFO cost-basis book", () => {
  it("answers the EXACT remaining cost, with no division anywhere", () => {
    const book = new CostBasisBook();
    book.observe(INSTANCE, {
      marketId: MARKET,
      side: "YES",
      action: "BUY",
      price: "0.3",
      shares: "10",
    });
    book.observe(INSTANCE, {
      marketId: MARKET,
      side: "YES",
      action: "BUY",
      price: "0.4",
      shares: "10",
    });
    expect(book.costBasis(INSTANCE, MARKET, "YES")).toBe("7");

    // FIFO: the 0.3 lot goes first, then half of the 0.4 lot.
    book.observe(INSTANCE, {
      marketId: MARKET,
      side: "YES",
      action: "SELL",
      price: "0.9",
      shares: "15",
    });
    expect(book.costBasis(INSTANCE, MARKET, "YES")).toBe("2");
    expect(book.total()).toBe("2");
  });

  it("is INSTANCE- and SIDE-scoped: one instance never reads another's lots", () => {
    const book = new CostBasisBook();
    book.observe(INSTANCE, {
      marketId: MARKET,
      side: "YES",
      action: "BUY",
      price: "0.5",
      shares: "10",
    });
    expect(book.costBasis(OTHER, MARKET, "YES")).toBe("0");
    expect(book.costBasis(INSTANCE, MARKET, "NO")).toBe("0");
    expect(book.costBasis(INSTANCE, MARKET, "YES")).toBe("5");
  });

  it("an oversell empties the book rather than making it NEGATIVE", () => {
    const book = new CostBasisBook();
    book.observe(INSTANCE, {
      marketId: MARKET,
      side: "YES",
      action: "BUY",
      price: "0.5",
      shares: "10",
    });
    book.observe(INSTANCE, {
      marketId: MARKET,
      side: "YES",
      action: "SELL",
      price: "0.5",
      shares: "40",
    });
    expect(book.costBasis(INSTANCE, MARKET, "YES")).toBe("0");
  });
});

/**
 * What the cap check counts for the instance (`AllocatorGate.countedExposure`,
 * the read the `CAP-1` pins use; until C1-RISK it rode on every `evaluate`).
 */
function counted(subject: AllocatorGate, viewOf: OrderViewOf): string {
  const snapshot = subject.countedExposure({
    liveOwners: [{ marketId: MARKET, strategyInstanceId: INSTANCE }],
    projection: EMPTY_PROJECTION,
    availableCollateral: "1000",
    viewOf,
  });
  if (snapshot === undefined) return "unbuildable";
  return Object.hasOwn(snapshot.byStrategyInstance, INSTANCE)
    ? (snapshot.byStrategyInstance[INSTANCE]?.combined ?? "missing")
    : "0";
}

describe("the allocator gate", () => {
  it("PERMITS a commitment inside the caps, and the verdict carries no refusals", () => {
    const outcome = evaluate(gate(), buyIntent());
    expect(outcome.verdict?.permitted).toBe(true);
    expect(outcome.verdict?.refusals).toEqual([]);
    expect(outcome.requests).toHaveLength(1);
    expect(outcome.requests[0]?.action).toBe("BUY");
    expect(outcome.requests[0]?.shares).toBe("50");
    expect(outcome.requests[0]?.price).toBe("0.35");
  });

  it("REFUSES with the allocator's own codes when a cap binds", () => {
    const outcome = evaluate(gate({ globalAccountCap: "1" }), buyIntent());
    expect(outcome.verdict?.permitted).toBe(false);
    expect(outcome.verdict?.refusals.map((refusal) => refusal.code)).toContain(
      "CAPITAL_GLOBAL_CAP_EXCEEDED",
    );
  });

  it("C1-RISK: a multi-leg intent is judged on the SUM of its legs, not leg by leg", () => {
    // The capital allocator is the only exposure-cap authority (the user's
    // ruling, 2026-10-08). Each leg here costs 17.5 and fits the 30 caps on its
    // own; together they commit 35, which exceeds both. Judging each leg
    // against the same base state, as `evaluate` did before C1-RISK, permits
    // this intent, and only the plan-time `applyForPlan` refused it.
    const basket = {
      type: "BASKET",
      intentId: "basket-0",
      legs: [
        { marketId: MARKET, direction: "YES", targetShares: "50", maximumBuyPrice: "0.35" },
        { marketId: MARKET, direction: "NO", targetShares: "50", maximumBuyPrice: "0.35" },
      ],
      maximumCombinedCost: "35",
      minimumLockedEdge: "0",
      legRiskLimit: "35",
      failurePolicy: "ABANDON",
      validUntil: "2026-03-04T12:00:30Z",
    } as unknown as Intent;
    const outcome = evaluate(gate({ globalAccountCap: "30", perMarketCap: "30" }), basket);
    expect(outcome.requests).toHaveLength(2);
    expect(outcome.verdict?.permitted).toBe(false);
    const codes = outcome.verdict?.refusals.map((refusal) => refusal.code) ?? [];
    expect(codes).toContain("CAPITAL_MARKET_CAP_EXCEEDED");
    expect(codes).toContain("CAPITAL_GLOBAL_CAP_EXCEEDED");

    // Each leg alone fits: the refusal above is the sum's, not one leg's.
    for (const direction of ["YES", "NO"] as const) {
      const single = evaluate(gate({ globalAccountCap: "30", perMarketCap: "30" }), {
        ...buyIntent(),
        direction,
      } as unknown as Intent);
      expect(single.verdict?.permitted).toBe(true);
    }
    // And the sum at the caps' edge (17.5 + 12.5 = 30) is admitted.
    const atEdge = evaluate(gate({ globalAccountCap: "30", perMarketCap: "30" }), {
      ...basket,
      legs: [
        { marketId: MARKET, direction: "YES", targetShares: "50", maximumBuyPrice: "0.35" },
        { marketId: MARKET, direction: "NO", targetShares: "50", maximumBuyPrice: "0.25" },
      ],
    } as unknown as Intent);
    expect(atEdge.verdict?.permitted).toBe(true);
  });

  it("C1-RISK r1: perResolutionWindowCap binds on the market's resolution window, at its edge", () => {
    // Risk's copy of this cap (check 15) was deleted by C1-RISK; this is now
    // its only pin. The BUY commits 50 x 0.35 = 17.5 in SCOPE's window.
    const atCap = evaluate(gate({ perResolutionWindowCap: "17.5" }), buyIntent());
    expect(atCap.verdict?.permitted).toBe(true);
    const over = evaluate(gate({ perResolutionWindowCap: "17.49" }), buyIntent());
    expect(over.verdict?.permitted).toBe(false);
    expect(over.verdict?.refusals.map((refusal) => refusal.code)).toEqual([
      "CAPITAL_RESOLUTION_WINDOW_CAP_EXCEEDED",
    ]);
  });

  it("REFUSES a LIVE commitment on a market with no recorded owner (ADR-011)", () => {
    const outcome = evaluate(gate(), buyIntent(), { owners: [] });
    expect(outcome.verdict?.permitted).toBe(false);
    expect(outcome.verdict?.refusals.map((refusal) => refusal.code)).toContain(
      "CAPITAL_LIVE_OWNERSHIP_MISSING",
    );
  });

  it("answers NO VERDICT for an intent that commits nothing", () => {
    const cancel = { type: "CANCEL", marketId: MARKET, reason: "operator" } as unknown as Intent;
    const outcome = evaluate(gate(), cancel);
    expect(outcome.verdict).toBeUndefined();
    expect(outcome.requests).toEqual([]);
  });

  it("the SHADOW arm is the package's, and the TRADER never asks for it", () => {
    // What the arm DOES: no live owner is needed, and the caps are compared
    // against the instance's own shadow book instead of the account.
    const outcome = evaluate(gate(), buyIntent(), {
      accountingMode: "SHADOW",
      owners: [],
    });
    expect(outcome.verdict?.permitted).toBe(true);
    expect(outcome.requests[0]?.accountingMode).toBe("SHADOW");

    // WHY THAT IS DANGEROUS FOR THIS PROCESS, and why `loop.ts` passes a
    // constant `LIVE` (review round 2, HIGH-1). The same commitment on the LIVE
    // arm — the one every order that reaches the shared venue, cash balance and
    // ledger must be judged on — is REFUSED, by name, for want of an owner.
    const live = evaluate(gate(), buyIntent(), { accountingMode: "LIVE", owners: [] });
    expect(live.verdict?.permitted).toBe(false);
    expect(live.verdict?.refusals.map((refusal) => refusal.code)).toContain(
      "CAPITAL_LIVE_OWNERSHIP_MISSING",
    );
    // The shadow arm never even asks the question: that is the whole gap.
    expect(outcome.verdict?.refusals).toEqual([]);
  });

  it("an APPLIED reservation is visible to the next evaluation, and RELEASING returns it", () => {
    const subject = gate();
    const request = requestFor({
      reservationId: "018f4a7e-7000-7abc-8def-000000000009",
      instanceId: INSTANCE,
      accountingMode: "LIVE",
      leg: { marketId: MARKET, side: "YES", action: "BUY", price: "0.35", shares: "50" },
      market: SCOPE,
    });
    const applied = subject.applyForPlan({
      entries: [{ plannedOrderId: "planned-1", request }],
      liveOwners: [{ marketId: MARKET, strategyInstanceId: INSTANCE }],
      projection: EMPTY_PROJECTION,
      availableCollateral: "20",
      viewOf: NO_VIEW,
    });
    expect(applied.ok).toBe(true);
    expect(subject.metrics().open).toBe(1);
    expect(subject.metrics().reservedCollateral).toBe("17.5");

    // 20 available, 17.5 already reserved: a second identical commitment cannot
    // be funded, and the allocator says so by name.
    const second = evaluate(subject, buyIntent(), { cash: "20" });
    expect(second.verdict?.permitted).toBe(false);
    expect(second.verdict?.refusals.map((refusal) => refusal.code)).toContain(
      "CAPITAL_COLLATERAL_INSUFFICIENT",
    );

    expect(subject.release("planned-1")).toBe(true);
    expect(subject.release("planned-1")).toBe(false);
    expect(subject.metrics().open).toBe(0);
    expect(subject.metrics().released).toBe(1);
    expect(evaluate(subject, buyIntent(), { cash: "20" }).verdict?.permitted).toBe(true);
  });

  it("a plan is reserved ALL OR NONE: a refused leg applies nothing", () => {
    const subject = gate();
    const affordable = requestFor({
      reservationId: "018f4a7e-7000-7abc-8def-00000000000a",
      instanceId: INSTANCE,
      accountingMode: "LIVE",
      leg: { marketId: MARKET, side: "YES", action: "BUY", price: "0.35", shares: "50" },
      market: SCOPE,
    });
    const unaffordable = requestFor({
      reservationId: "018f4a7e-7000-7abc-8def-00000000000b",
      instanceId: INSTANCE,
      accountingMode: "LIVE",
      leg: { marketId: MARKET, side: "YES", action: "BUY", price: "0.35", shares: "500" },
      market: SCOPE,
    });
    const applied = subject.applyForPlan({
      entries: [
        { plannedOrderId: "planned-1", request: affordable },
        { plannedOrderId: "planned-2", request: unaffordable },
      ],
      liveOwners: [{ marketId: MARKET, strategyInstanceId: INSTANCE }],
      projection: EMPTY_PROJECTION,
      availableCollateral: "20",
      viewOf: NO_VIEW,
    });
    expect(applied.ok).toBe(false);
    expect(subject.metrics().open).toBe(0);
    expect(subject.metrics().applied).toBe(0);
    // The refusal is COUNTED under the allocator's own vocabulary.
    expect(Object.keys(subject.metrics().refusalsByCode)).toContain(
      "CAPITAL_COLLATERAL_INSUFFICIENT",
    );
  });

  it("a HAND-BUILT caps object that weakens the AGENTS.md floor is refused at the gate", () => {
    // `parseAllocatorCaps` cannot produce these caps — the live-micro fence
    // refuses them at the door — so this is the second fence layer:
    // `evaluateReservation` re-applies it at the ENFORCEMENT site, and the
    // trader's answer is a REFUSED verdict rather than an absent one. A missing
    // verdict would read to §9.8 check 14 as "no allocator ran".
    type Caps = ConstructorParameters<typeof AllocatorGate>[0]["caps"];
    const weakened = {
      globalAccountCap: "1000",
      perStrategyCap: "1000",
      liveMicroMaxOrderNotional: "5",
      liveMicroMaxAccountExposure: "5",
    } as unknown as Caps;
    const subject = new AllocatorGate({
      caps: weakened,
      markets: new Map([[MARKET, SCOPE]]),
      tokenAssetIds: new Map(),
    });
    const outcome = evaluate(subject, buyIntent());
    expect(outcome.verdict?.permitted).toBe(false);
    expect(outcome.verdict?.refusals.map((refusal) => refusal.code)).toContain(
      "CAPITAL_LIVE_MICRO_CAP_NOT_PERMITTED",
    );
  });
});

/**
 * `CAP-1` (`CAP-OVERSHOOT`): one planned order's commitment is CONVERTED as
 * its fills are booked, SETTLED to exactly its unused remainder once its final
 * size is confirmed, and CLOSED only when every share of that size is booked.
 * `loop-capital.test.ts` drives the same through the real core loop; these
 * pin each transition's exact numbers at the gate.
 */
describe("CAP-1: a commitment is converted, never released, as its fills are seen", () => {
  const PLANNED = "planned-cap1";

  /** A gate holding one applied BUY of 50 at a 0.35 limit: 17.5 pUSD. */
  function holding(caps: Record<string, unknown> = {}): AllocatorGate {
    const subject = gate(caps);
    const request = requestFor({
      reservationId: "018f4a7e-7000-7abc-8def-0000000000c1",
      instanceId: INSTANCE,
      accountingMode: "LIVE",
      leg: { marketId: MARKET, side: "YES", action: "BUY", price: "0.35", shares: "50" },
      market: SCOPE,
    });
    const applied = subject.applyForPlan({
      entries: [{ plannedOrderId: PLANNED, request }],
      liveOwners: [{ marketId: MARKET, strategyInstanceId: INSTANCE }],
      projection: EMPTY_PROJECTION,
      availableCollateral: "1000",
      viewOf: NO_VIEW,
    });
    if (!applied.ok) throw new Error("the fixture reservation was refused");
    return subject;
  }

  function fill(
    id: string,
    shares: string,
    price: string,
  ): { simulatedFillId: string; marketId: string; side: "YES" | "NO"; action: "BUY" | "SELL"; price: string; shares: string } {
    return { simulatedFillId: id, marketId: MARKET, side: "YES", action: "BUY", price, shares };
  }

  /** What the cap check counts for the instance — the commitment alone (the projection is empty). */
  function countedFor(subject: AllocatorGate): string {
    return counted(subject, NO_VIEW);
  }

  it("a BOOKED fill converts its shares: the commitment holds the reservation less the fill's debit, its better price still reserved", () => {
    const subject = holding();
    expect(countedFor(subject)).toBe("17.5");
    subject.observeFill(INSTANCE, fill("f-1", "20", "0.34"), PLANNED);
    // 30 × 0.35 still reserved + 20 × (0.35 − 0.34) unused: 17.5 − 6.8.
    expect(subject.metrics()).toMatchObject({ open: 1, released: 0, reservedCollateral: "10.7" });
    expect(countedFor(subject)).toBe("10.7");
    // The position carries the debit: the cost basis the cap check counts.
    expect(subject.costBasisOf(INSTANCE, MARKET, "YES")).toBe("6.8");
  });

  it("SETTLE releases EXACTLY the unused remainder and keeps an unbooked fill at its own price until it is booked; then the commitment CLOSES", () => {
    const subject = holding();
    subject.observeFill(INSTANCE, fill("f-1", "20", "0.34"), PLANNED);
    // Final size 30: 20 booked, 10 filled at 0.33 and not booked yet.
    expect(subject.settle(PLANNED, { filledShares: "30", unbookedFills: [fill("f-2", "10", "0.33")] })).toBe(false);
    // Released: 17.5 − 6.8 − 3.3 = 7.4. Kept: the unbooked fill's 3.3.
    expect(subject.metrics()).toMatchObject({ open: 1, released: 0, reservedCollateral: "3.3" });
    expect(countedFor(subject)).toBe("3.3");
    subject.observeFill(INSTANCE, fill("f-2", "10", "0.33"), PLANNED);
    expect(subject.metrics()).toMatchObject({ open: 0, released: 1, reservedCollateral: "0" });
    expect(subject.costBasisOf(INSTANCE, MARKET, "YES")).toBe("10.1");
  });

  it("a share of the final size whose fill was not seen is held at the order's LIMIT — never less than its debit", () => {
    const subject = holding();
    subject.observeFill(INSTANCE, fill("f-1", "20", "0.34"), PLANNED);
    subject.settle(PLANNED, { filledShares: "30", unbookedFills: undefined });
    expect(subject.metrics()).toMatchObject({ open: 1, reservedCollateral: "3.5" });
    // A later settle that SEES it replaces the limit with the fill's own price.
    subject.settle(PLANNED, { filledShares: "30", unbookedFills: [fill("f-2", "10", "0.33")] });
    expect(subject.metrics()).toMatchObject({ open: 1, reservedCollateral: "3.3" });
  });

  it("a final size fully booked CLOSES at once; a second settle releases nothing more", () => {
    const subject = holding();
    subject.observeFill(INSTANCE, fill("f-1", "50", "0.34"), PLANNED);
    expect(subject.metrics()).toMatchObject({ open: 1, reservedCollateral: "0.5" });
    expect(subject.settle(PLANNED, { filledShares: "50", unbookedFills: [] })).toBe(true);
    expect(subject.metrics()).toMatchObject({ open: 0, applied: 1, released: 1, reservedCollateral: "0" });
    expect(subject.settle(PLANNED, { filledShares: "50", unbookedFills: [] })).toBe(false);
    expect(subject.metrics().released).toBe(1);
  });

  it("a cancel with nothing filled closes the whole commitment (final size 0)", () => {
    const subject = holding();
    expect(subject.settle(PLANNED, { filledShares: "0", unbookedFills: [] })).toBe(true);
    expect(subject.metrics()).toMatchObject({ open: 0, released: 1, reservedCollateral: "0" });
  });

  it("RELEASE (a planned order the venue never booked) closes it whole", () => {
    const subject = holding();
    expect(subject.release(PLANNED)).toBe(true);
    expect(subject.release(PLANNED)).toBe(false);
    expect(subject.metrics()).toMatchObject({ open: 0, released: 1, reservedCollateral: "0" });
  });

  it("a fill booked UNATTRIBUTED keeps its debit in the commitment for good: no position will carry it", () => {
    const subject = holding();
    subject.observeUnattributedFill(fill("f-u", "20", "0.34"), PLANNED);
    // Before the final size: still the whole reservation.
    expect(subject.metrics()).toMatchObject({ open: 1, reservedCollateral: "17.5" });
    expect(subject.settle(PLANNED, { filledShares: "20", unbookedFills: [fill("f-u", "20", "0.34")] })).toBe(false);
    expect(subject.metrics()).toMatchObject({ open: 1, released: 0, reservedCollateral: "6.8" });
    expect(subject.costBasisOf(INSTANCE, MARKET, "YES")).toBe("0");
  });

  it("a fill that is not this commitment's — another market, side, direction or instance — converts nothing", () => {
    const subject = holding();
    subject.observeFill(INSTANCE, { ...fill("f-x", "20", "0.34"), side: "NO" }, PLANNED);
    subject.observeFill(INSTANCE, { ...fill("f-y", "20", "0.34"), action: "SELL" }, PLANNED);
    subject.observeFill(OTHER, fill("f-z", "20", "0.34"), PLANNED);
    subject.observeFill(INSTANCE, fill("f-w", "20", "0.34"), "planned-unknown");
    subject.observeFill(INSTANCE, fill("f-v", "20", "0.34"));
    expect(subject.metrics()).toMatchObject({ open: 1, reservedCollateral: "17.5" });
  });

  it("a fill is converted ONCE: observing it again converts nothing more", () => {
    const subject = holding();
    subject.observeFill(INSTANCE, fill("f-1", "20", "0.34"), PLANNED);
    subject.observeFill(INSTANCE, fill("f-1", "20", "0.34"), PLANNED);
    expect(subject.metrics()).toMatchObject({ open: 1, reservedCollateral: "10.7" });
  });

  it("a fill the commitment already converted, offered again as UNBOOKED at settle (a carried harvest booked it ahead of the cursor), is not counted twice", () => {
    const subject = holding();
    subject.observeFill(INSTANCE, fill("f-ahead", "20", "0.34"), PLANNED);
    // The venue's page past the cursor still lists the booked-ahead fill.
    expect(
      subject.settle(PLANNED, { filledShares: "30", unbookedFills: [fill("f-ahead", "20", "0.34"), fill("f-2", "10", "0.33")] }),
    ).toBe(false);
    // Only the truly unbooked fill is kept: 3.3, not 3.3 + 6.8.
    expect(subject.metrics()).toMatchObject({ open: 1, reservedCollateral: "3.3" });
  });

  it("a final size that is not an exact decimal settles nothing: the whole reservation stays", () => {
    const subject = holding();
    expect(subject.settle(PLANNED, { filledShares: "1e1", unbookedFills: [] })).toBe(false);
    expect(subject.metrics()).toMatchObject({ open: 1, reservedCollateral: "17.5" });
  });
});

/**
 * `CAP-1` r0 (the ruling on §9.8 checks 16 and 17): the SEPARATE risk input,
 * `unbookedExposure`, is derived from the same commitments the cap check
 * counts, so the two never disagree about which fill is unbooked or what it
 * cost. `loop-capital.test.ts` drives it through the real core loop.
 *
 * `CAP-1` r1: the commitment knows the fills the loop has SEEN
 * (`observeVenueFill`), and the input is asked with the venue's view
 * (`viewOf`) and the open orders' presentation at their UNFILLED remainder
 * (`presentedOpen`: planned id -> the filled shares it leaves out).
 */
describe("CAP-1 r0: the filled-but-unbooked risk input comes from the cap check's own commitments", () => {
  const PLANNED = "planned-cap1-r0";
  const NOTHING_PRESENTED: ReadonlyMap<string, string> = new Map();

  /** A projection in which the instance holds 50 YES (the inventory a covered SELL reserves). */
  const HOLDING_50_YES = {
    ...EMPTY_PROJECTION,
    virtualPositions: new Map([
      ["v-1", { instanceId: INSTANCE, assetId: "token:111", assetKind: "OUTCOME_TOKEN", marketId: MARKET, balance: "50" }],
    ]),
  } as unknown as typeof EMPTY_PROJECTION;

  /** A gate holding one applied BUY (default: 50 YES at a 0.35 limit) — or SELL, against 50 YES held. */
  function holding(leg: Partial<{ side: "YES" | "NO"; action: "BUY" | "SELL"; price: string; shares: string }> = {}): AllocatorGate {
    const subject = gate();
    const request = requestFor({
      reservationId: "018f4a7e-7000-7abc-8def-0000000000d1",
      instanceId: INSTANCE,
      accountingMode: "LIVE",
      leg: { marketId: MARKET, side: "YES", action: "BUY", price: "0.35", shares: "50", ...leg },
      market: SCOPE,
    });
    const applied = subject.applyForPlan({
      entries: [{ plannedOrderId: PLANNED, request }],
      liveOwners: [{ marketId: MARKET, strategyInstanceId: INSTANCE }],
      projection: leg.action === "SELL" ? HOLDING_50_YES : EMPTY_PROJECTION,
      availableCollateral: "1000",
      viewOf: NO_VIEW,
    });
    if (!applied.ok) throw new Error(`the fixture reservation was refused: ${applied.refusals.map((refusal) => refusal.code).join(", ")}`);
    return subject;
  }

  function fill(id: string, shares: string, price: string, side: "YES" | "NO" = "YES"): { simulatedFillId: string; marketId: string; side: "YES" | "NO"; action: "BUY" | "SELL"; price: string; shares: string } {
    return { simulatedFillId: id, marketId: MARKET, side, action: "BUY", price, shares };
  }

  function unbooked(
    subject: AllocatorGate,
    options: { presented?: ReadonlyMap<string, string>; view?: OrderViewOf; instanceId?: string; marketId?: string } = {},
  ): readonly unknown[] {
    return subject.unbookedExposure({
      instanceId: options.instanceId ?? INSTANCE,
      marketId: options.marketId ?? MARKET,
      presentedOpen: options.presented ?? NOTHING_PRESENTED,
      viewOf: options.view ?? NO_VIEW,
    });
  }

  it("SETTLED: exactly the fills the allocator keeps — the same shares and the same debit the cap check counts — until they are booked", () => {
    const subject = holding();
    subject.observeFill(INSTANCE, fill("f-1", "20", "0.34"), PLANNED);
    subject.settle(PLANNED, { filledShares: "30", unbookedFills: [fill("f-2", "10", "0.33")] });
    expect(unbooked(subject)).toEqual([{ marketId: MARKET, side: "YES", shares: "10", debit: "3.3" }]);
    // The cap check holds exactly that debit for it.
    expect(subject.metrics().reservedCollateral).toBe("3.3");
    // Booked: the position carries it now, and the risk input states nothing.
    subject.observeFill(INSTANCE, fill("f-2", "10", "0.33"), PLANNED);
    expect(unbooked(subject)).toEqual([]);
  });

  it("SETTLED with a share whose fill was not seen: that share at the LIMIT, as the allocator keeps it", () => {
    const subject = holding();
    subject.observeFill(INSTANCE, fill("f-1", "20", "0.34"), PLANNED);
    subject.settle(PLANNED, { filledShares: "30", unbookedFills: undefined });
    expect(unbooked(subject)).toEqual([{ marketId: MARKET, side: "YES", shares: "10", debit: "3.5" }]);
    expect(subject.metrics().reservedCollateral).toBe("3.5");
  });

  it("r1 (CAP1-ASTRA-R1-02): an order PRESENTED as open at its unfilled remainder states here its FILLED shares no position carries yet — never its booked ones (the position's) and never its unfilled ones (the open order's)", () => {
    const subject = holding();
    subject.observeFill(INSTANCE, fill("f-1", "20", "0.34"), PLANNED);
    // Presented at 50 − 20: every filled share is booked, so nothing here.
    expect(unbooked(subject, { presented: new Map([[PLANNED, "20"]]) })).toEqual([]);
    // Presented at 50 − 30: 10 filled and not booked, no answer seen: at the limit.
    expect(unbooked(subject, { presented: new Map([[PLANNED, "30"]]) })).toEqual([{ marketId: MARKET, side: "YES", shares: "10", debit: "3.5" }]);
    // Seen in a venue answer: at its own price.
    subject.observeVenueFill(fill("f-2", "10", "0.33"), PLANNED);
    expect(unbooked(subject, { presented: new Map([[PLANNED, "30"]]) })).toEqual([{ marketId: MARKET, side: "YES", shares: "10", debit: "3.3" }]);
    // The presented order is not looked up.
    expect(unbooked(subject, { presented: new Map([[PLANNED, "30"]]), view: () => { throw new Error("a presented order is not looked up"); } })).toHaveLength(1);
  });

  it("r1 (CAP1-ASTRA-R1-03): NOT settled, its order TERMINAL in the view: only its FILLED unbooked shares — at the price a venue answer carried, at the limit only when none did — and the read moves nothing", () => {
    const subject = holding();
    subject.observeFill(INSTANCE, fill("f-1", "20", "0.34"), PLANNED);
    const before = subject.metrics();
    const terminal30: OrderViewOf = () => ({ terminal: true, filledShares: "30" });
    // A terminal order with nothing filled beyond its booked shares: nothing.
    expect(unbooked(subject, { view: () => ({ terminal: true, filledShares: "20" }) })).toEqual([]);
    expect(unbooked(holding(), { view: () => ({ terminal: true, filledShares: "0" }) })).toEqual([]);
    expect(unbooked(subject, { view: terminal30 })).toEqual([{ marketId: MARKET, side: "YES", shares: "10", debit: "3.5" }]);
    subject.observeVenueFill(fill("f-2", "10", "0.33"), PLANNED);
    expect(unbooked(subject, { view: terminal30 })).toEqual([{ marketId: MARKET, side: "YES", shares: "10", debit: "3.3" }]);
    // The commitment itself is untouched: seeing a fill and reading a view settle nothing.
    expect(subject.metrics()).toEqual(before);
  });

  it("NOT settled and NOT presented: WORKING in the view (an order no instance owns), its unbooked fills plus its unfilled shares at the limit; the venue showing NO order, its whole unconverted reservation at the limit", () => {
    const subject = holding();
    subject.observeFill(INSTANCE, fill("f-1", "20", "0.34"), PLANNED);
    expect(unbooked(subject)).toEqual([{ marketId: MARKET, side: "YES", shares: "30", debit: "10.5" }]);
    expect(unbooked(subject, { view: () => ({ terminal: false, filledShares: "30" }) })).toEqual([
      { marketId: MARKET, side: "YES", shares: "30", debit: "10.5" },
    ]);
    subject.observeVenueFill(fill("f-2", "10", "0.33"), PLANNED);
    // 10 seen at 0.33 + 20 unfilled at 0.35.
    expect(unbooked(subject, { view: () => ({ terminal: false, filledShares: "30" }) })).toEqual([
      { marketId: MARKET, side: "YES", shares: "30", debit: "10.3" },
    ]);
    // A size that is not an exact decimal: the whole unconverted reservation.
    expect(unbooked(subject, { view: () => ({ terminal: true, filledShares: "3e1" }) })).toEqual([
      { marketId: MARKET, side: "YES", shares: "30", debit: "10.5" },
    ]);
  });

  it("a fill booked UNATTRIBUTED is kept at its own price, as the allocator keeps it", () => {
    const subject = holding();
    subject.observeUnattributedFill(fill("f-u", "20", "0.34"), PLANNED);
    subject.settle(PLANNED, { filledShares: "20", unbookedFills: [fill("f-u", "20", "0.34")] });
    expect(unbooked(subject)).toEqual([{ marketId: MARKET, side: "YES", shares: "20", debit: "6.8" }]);
    expect(subject.metrics().reservedCollateral).toBe("6.8");
  });

  it("per strategy, per market, per token: another instance or market sees nothing; a NO commitment is stated on NO; a SELL states nothing (see the open item on unbooked SELLs)", () => {
    const subject = holding();
    expect(unbooked(subject, { instanceId: OTHER })).toEqual([]);
    expect(unbooked(subject, { marketId: "018f4a7e-1111-7abc-8def-0123456789ac" })).toEqual([]);
    const no = holding({ side: "NO", price: "0.6", shares: "10" });
    no.settle(PLANNED, { filledShares: "10", unbookedFills: [fill("f-n", "10", "0.58", "NO")] });
    expect(unbooked(no)).toEqual([{ marketId: MARKET, side: "NO", shares: "10", debit: "5.8" }]);
    const sell = holding({ action: "SELL", price: "0.32", shares: "50" });
    expect(sell.metrics()).toMatchObject({ open: 1 });
    expect(unbooked(sell)).toEqual([]);
    expect(unbooked(sell, { view: () => ({ terminal: true, filledShares: "50" }) })).toEqual([]);
  });
});

/**
 * `CAP-1` r1 (`CAP1-ASTRA-R1-01`): the cap check judges a commitment whose
 * order the venue shows TERMINAL at that final size — the exact unused
 * remainder released — at the FIRST question that can see it, not at the
 * next harvest's settlement. `loop-capital.test.ts` drives the same through
 * the real loop.
 */
describe("CAP-1 r1: the final size is judged where the evaluation can see it", () => {
  const PLANNED = "planned-cap1-r1";

  function holding(caps: Record<string, unknown> = {}): AllocatorGate {
    const subject = gate(caps);
    const request = requestFor({
      reservationId: "018f4a7e-7000-7abc-8def-0000000000e1",
      instanceId: INSTANCE,
      accountingMode: "LIVE",
      leg: { marketId: MARKET, side: "YES", action: "BUY", price: "0.35", shares: "10" },
      market: SCOPE,
    });
    const applied = subject.applyForPlan({
      entries: [{ plannedOrderId: PLANNED, request }],
      liveOwners: [{ marketId: MARKET, strategyInstanceId: INSTANCE }],
      projection: EMPTY_PROJECTION,
      availableCollateral: "1000",
      viewOf: NO_VIEW,
    });
    if (!applied.ok) throw new Error("the fixture reservation was refused");
    return subject;
  }

  const seenFill = { simulatedFillId: "f-r1", marketId: MARKET, side: "YES" as const, action: "BUY" as const, price: "0.34", shares: "5" };

  function countedFor(subject: AllocatorGate, viewOf: OrderViewOf): string {
    return counted(subject, viewOf);
  }

  it("an UNSETTLED commitment whose order the view shows TERMINAL is counted at its final size — 5 seen at 0.34 = 1.70, its 1.80 unused remainder released — and the question moves nothing", () => {
    const subject = holding();
    subject.observeVenueFill(seenFill, PLANNED);
    const before = subject.metrics();
    expect(countedFor(subject, () => ({ terminal: true, filledShares: "5" }))).toBe("1.7");
    // Still WORKING in the view: the whole reservation, as before.
    expect(countedFor(subject, () => ({ terminal: false, filledShares: "5" }))).toBe("3.5");
    // No view, or a size that is not an exact decimal: the whole reservation (fail closed).
    expect(countedFor(subject, NO_VIEW)).toBe("3.5");
    expect(countedFor(subject, () => ({ terminal: true, filledShares: "5.0" }))).toBe("3.5");
    // The question changed nothing: the commitment is settled at its own site.
    expect(subject.metrics()).toEqual(before);
  });

  it("a filled share no venue answer carried is held at the LIMIT (never below its debit); a terminal order with nothing filled counts nothing", () => {
    const subject = holding();
    expect(countedFor(subject, () => ({ terminal: true, filledShares: "5" }))).toBe("1.75");
    expect(countedFor(subject, () => ({ terminal: true, filledShares: "0" }))).toBe("0");
  });

  it("the cap is judged on that account: at a per-strategy cap of 5.20, a 3.50 BUY is ADMITTED against the terminal order's 1.70 (base: 3.50 + 3.50, refused) — by evaluate AND applyForPlan, which see the same view", () => {
    const subject = holding({ perStrategyCap: "5.2" });
    subject.observeVenueFill(seenFill, PLANNED);
    const view: OrderViewOf = (plannedOrderId) => (plannedOrderId === PLANNED ? { terminal: true, filledShares: "5" } : undefined);
    expect(evaluate(subject, buyIntent("10", "0.35"), { viewOf: view }).verdict).toMatchObject({ permitted: true });
    expect(evaluate(subject, buyIntent("10", "0.35")).verdict).toMatchObject({ permitted: false });
    const second = requestFor({
      reservationId: "018f4a7e-7000-7abc-8def-0000000000e2",
      instanceId: INSTANCE,
      accountingMode: "LIVE",
      leg: { marketId: MARKET, side: "YES", action: "BUY", price: "0.35", shares: "10" },
      market: SCOPE,
    });
    const apply = (viewOf: OrderViewOf): boolean =>
      subject.applyForPlan({
        entries: [{ plannedOrderId: "planned-cap1-r1-second", request: second }],
        liveOwners: [{ marketId: MARKET, strategyInstanceId: INSTANCE }],
        projection: EMPTY_PROJECTION,
        availableCollateral: "1000",
        viewOf,
      }).ok;
    expect(apply(NO_VIEW)).toBe(false);
    expect(apply(view)).toBe(true);
  });

  it("a SETTLED commitment is never looked up again; settle records its page as SEEN, adding to what was seen before", () => {
    const subject = holding();
    subject.observeVenueFill(seenFill, PLANNED);
    subject.settle(PLANNED, { filledShares: "10", unbookedFills: [{ simulatedFillId: "f-r1b", price: "0.33", shares: "5" }] });
    // 5 × 0.34 (seen earlier) + 5 × 0.33 (the page).
    expect(subject.metrics().reservedCollateral).toBe("3.35");
    expect(countedFor(subject, () => { throw new Error("a settled commitment is not looked up"); })).toBe("3.35");
  });

  it("a fill that is not the commitment's (another side or direction) or not exact is not evidence: its share stays at the limit", () => {
    const subject = holding();
    subject.observeVenueFill({ ...seenFill, side: "NO" }, PLANNED);
    subject.observeVenueFill({ ...seenFill, action: "SELL" }, PLANNED);
    subject.observeVenueFill({ ...seenFill, marketId: "018f4a7e-1111-7abc-8def-0123456789ac" }, PLANNED);
    subject.observeVenueFill({ ...seenFill, price: "3.4e-1" }, PLANNED);
    subject.observeVenueFill(seenFill, "planned-unknown");
    subject.observeVenueFill(seenFill, undefined);
    expect(countedFor(subject, () => ({ terminal: true, filledShares: "5" }))).toBe("1.75");
  });
});

describe("the intent leg derivation", () => {
  it("a TARGET-mode position resolves against the held shares", () => {
    const target = {
      ...(buyIntent("50") as unknown as Record<string, unknown>),
      targetMode: "TARGET",
    } as unknown as Intent;
    expect(intentLegs(target, () => "20")[0]?.shares).toBe("30");
    // Already at target: nothing to commit.
    expect(intentLegs(target, () => "50")).toEqual([]);
  });

  it("a NEGATIVE delta is a SELL of its absolute size", () => {
    const exit = {
      ...(buyIntent("-30") as unknown as Record<string, unknown>),
      maximumBuyPrice: undefined,
      minimumSellPrice: "0.5",
    } as unknown as Intent;
    const legs = intentLegs(exit, () => "50");
    expect(legs[0]?.action).toBe("SELL");
    expect(legs[0]?.shares).toBe("30");
    expect(legs[0]?.price).toBe("0.5");
  });

  it("an UNPRICED leg produces NO request — a bound nobody stated is not invented", () => {
    const unpriced = {
      ...(buyIntent("50") as unknown as Record<string, unknown>),
      maximumBuyPrice: undefined,
    } as unknown as Intent;
    expect(intentLegs(unpriced, () => "0")).toEqual([]);
  });

  it("a REDUCE_POSITION sells the excess on each side the portfolio holds", () => {
    const reduce = {
      type: "REDUCE_POSITION",
      marketId: MARKET,
      targetShares: "10",
      urgency: "NORMAL",
      minimumSellPrice: "0.4",
      reason: "protective",
    } as unknown as Intent;
    const legs = intentLegs(reduce, (_marketId, side) => (side === "YES" ? "50" : "0"));
    expect(legs).toHaveLength(1);
    expect(legs[0]?.side).toBe("YES");
    expect(legs[0]?.shares).toBe("40");
  });

  it("a QUOTE names no outcome token, so it produces no request", () => {
    expect(intentLegs(quoteIntent(), () => "0")).toEqual([]);
  });
});

/**
 * The other half of "fails closed", MEASURED (review round 2, MEDIUM-1).
 *
 * `intentLegs` returning `[]` for a `QUOTE` is only half a claim: the claim that
 * matters is what the RISK ENGINE then does with the absent verdict. The
 * assertion above measured the first half and asserted the second in prose. This
 * drives both, through the two functions `loop.ts` calls in sequence and with
 * nothing substituted for either — the allocator's own `undefined`, and
 * `packages/risk`'s own answer to it.
 *
 * §9.8 check 14 is fail-closed by construction: an absent allocator verdict on
 * an ENTRY (and `packages/risk` classifies a `QUOTE` as one) is
 * `RISK_ALLOCATION_VERDICT_MISSING` — "the allocator was not asked".
 */
describe("an intent the allocator cannot price is REFUSED downstream", () => {
  const marketConfig: MarketConfig = {
    marketId: MARKET,
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
    settlementReadiness: { modelDependentActivationAllowed: true },
    seriesKey: SCOPE.seriesKey,
    underlyingKey: SCOPE.underlyingKey,
    resolutionWindowKey: SCOPE.resolutionWindowKey,
  } as MarketConfig;

  function refusalCodesFor(intent: Intent): readonly string[] {
    const subject = gate();
    const allocation = subject.evaluate({
      intent,
      instanceId: INSTANCE,
      accountingMode: "LIVE",
      liveOwners: [{ marketId: MARKET, strategyInstanceId: INSTANCE }],
      projection: EMPTY_PROJECTION,
      availableCollateral: "1000",
      approvedIntentId: "018f4a7e-7000-7abc-8def-000000000021",
      heldShares: () => "0",
      viewOf: NO_VIEW,
    });
    const market = new MarketState({ config: marketConfig, tradeWindowMs: 60_000, maximumTrades: 8 });
    market.markLifecycle("OPEN");
    const policy = parseRiskPolicy({
      freshness: { venueBookMaxAgeMs: 600_000, referenceFeedMaxAgeMs: 600_000, featuresMaxAgeMs: 600_000 },
      limits: { maxWorstCaseContractualLoss: "1000" },
      scenario: { maxScenarioLoss: "1000" },
      economics: {},
      participation: {},
      rateLimit: { safetyReserveRequests: 0 },
      timeToClose: { entryCutoffSeconds: 30 },
    });
    if (!policy.ok) throw new Error("the fixture risk policy was refused");
    const evaluation = runRiskCheck(
      policy.value,
      buildRiskEvaluationInput({
        intent,
        evaluatedAt: "2026-03-04T12:00:05.000Z",
        approvedIntentId: "018f4a7e-7000-7abc-8def-000000000021",
        runMode: "PAPER",
        strategyInstanceId: INSTANCE,
        runStatePermitsIntent: true,
        strategyStatePermitsIntent: true,
        market,
        marketConfig,
        secondsToClose: 600,
        bookSynchronized: true,
        venueBookAgeMs: 0,
        featuresAgeMs: 0,
        referenceFeedAgeMs: 0,
        positions: [],
        openOrders: [],
        unbookedFills: [],
        // The allocator's OWN answer, passed through exactly as `loop.ts`
        // passes it. Nothing is fabricated for the absent case.
        allocation: allocation.verdict,
        recentIntentIds: [],
        availableRequests: 100,
        parametersVersion: 1,
        modelDependentActivationAllowed: true,
        scenarios: [],
      }),
    );
    expect(evaluation.approved).toBe(false);
    return evaluation.refusals.map((refusal) => refusal.code);
  }

  it("a QUOTE carries NO verdict, and check 14 refuses it for exactly that reason", () => {
    const subject = gate();
    const outcome = subject.evaluate({
      intent: quoteIntent(),
      instanceId: INSTANCE,
      accountingMode: "LIVE",
      liveOwners: [{ marketId: MARKET, strategyInstanceId: INSTANCE }],
      projection: EMPTY_PROJECTION,
      availableCollateral: "1000",
      approvedIntentId: "018f4a7e-7000-7abc-8def-000000000021",
      heldShares: () => "0",
      viewOf: NO_VIEW,
    });
    // ABSENT, not a permissive verdict. The distinction is the whole check.
    expect(outcome.verdict).toBeUndefined();

    expect(refusalCodesFor(quoteIntent())).toContain("RISK_ALLOCATION_VERDICT_MISSING");
  });

  it("an UNPRICED position fails closed the same way — a leg nobody bounded", () => {
    const unpriced = {
      ...(buyIntent("50") as unknown as Record<string, unknown>),
      maximumBuyPrice: undefined,
    } as unknown as Intent;
    expect(refusalCodesFor(unpriced)).toContain("RISK_ALLOCATION_VERDICT_MISSING");
  });

  it("a PRICED position on the same path is refused as REFUSED, not as MISSING", () => {
    // The control, and the distinction check 14 exists to make: this intent is
    // priced, so a verdict EXISTS — 50000 shares at `0.35` is far over the
    // `1000` global cap, so the verdict says no. `RISK_ALLOCATION_REFUSED` is
    // "the allocator answered and refused"; `RISK_ALLOCATION_VERDICT_MISSING`
    // is "the allocator was never asked". A harness that refused everything
    // would not tell them apart, and this asserts both directions.
    const codes = refusalCodesFor(buyIntent("50000"));
    expect(codes).toContain("RISK_ALLOCATION_REFUSED");
    expect(codes).not.toContain("RISK_ALLOCATION_VERDICT_MISSING");
  });
});
