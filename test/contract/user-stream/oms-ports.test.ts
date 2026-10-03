/**
 * WP-280 deliverable 2: the normalized events are "normalized into types the
 * OMS's observation and fill ports can take".
 *
 * COMPILE TIME (this suite is type-checked by the package's `test:contract`
 * script): each projected shape is assignable to WP-270's own exported type —
 * `OmsOrderObservation` → `OrderObservation`, `OmsFillReport` → `FillReport`,
 * `OmsSettlementObservation` → `SettlementObservation`.
 *
 * RUN TIME: the projections of the offline fixtures are applied to a REAL
 * `OrderManager` (WP-270's own test harness: every port mocked, no network, no
 * key) holding orders whose venue ids are the fixtures' ids, and the OMS
 * accepts every one: the order lifecycle moves LIVE → (MATCHED observed) →
 * CANCELED; the taker trade records its fill and settles MATCHED → MINED →
 * CONFIRMED; a maker trade's MATCHED event projects its settlement and a
 * shortfall rather than a fill (the maker fee is per market, D-13), and once
 * the fill is known (a stand-in for the reconciler's read) the stream's
 * settlements apply, RETRYING → FAILED, which the OMS raises as its halting
 * SETTLEMENT_FAILED alert. A settlement
 * event that carries no fill facts is refused by the OMS until the fill is
 * known (`OMS_UNKNOWN_FILL`), which is why every stream gap requests
 * reconciliation.
 */

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { FillReport, OrderObservation, SettlementObservation } from "../../../packages/oms/src/index.js";
import { installNetworkTripwire, type NetworkTripwire } from "../../../packages/polymarket-secure/src/testing/network-tripwire.js";
import {
  normalizeUserChannelMessage,
  projectOrderEventForOms,
  projectTradeEventForOms,
  type OmsFillReport,
  type OmsOrderObservation,
  type OmsSettlementObservation,
  type TradeProjection,
} from "../../../packages/polymarket-secure/src/user-stream/index.js";
import { FIXTURE_OWNER } from "../../../packages/polymarket-secure/src/user-stream/testing/harness.js";
import { accepted } from "../../unit/oms/support/fake-venue.js";
import { group, openHarness, ticket, type Harness } from "../../unit/oms/support/harness.js";

// ---------------------------------------------------------------------------
// Compile time: assignable to WP-270's own types (a mismatch fails `tsc`).

const asObservation: (value: OmsOrderObservation) => OrderObservation = (value) => value;
const asFill: (value: OmsFillReport) => FillReport = (value) => value;
const asSettlement: (value: OmsSettlementObservation) => SettlementObservation = (value) => value;

// ---------------------------------------------------------------------------

const FIXTURE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../fixtures/venue/user-ws");
const id = (suffix: string): string => `0x${"0".repeat(56)}${suffix}`;
const OPTIONS = { isAccountOwner: (owner: string) => owner === FIXTURE_OWNER };

interface Example {
  readonly name: string;
  readonly payload: Record<string, unknown>;
}

async function examples(file: string): Promise<ReadonlyMap<string, Record<string, unknown>>> {
  const parsed = JSON.parse(await readFile(resolve(FIXTURE_DIR, file), "utf8")) as { examples: readonly Example[] };
  return new Map(parsed.examples.map((example) => [example.name, example.payload]));
}

function tradeProjection(payload: Record<string, unknown>): TradeProjection {
  const message = normalizeUserChannelMessage(payload, OPTIONS);
  if (message.kind !== "TRADE") throw new Error(message.kind);
  return projectTradeEventForOms(message.event);
}

/** Place one order whose venue id is `venueOrderId`, through the real OMS. */
async function place(h: Harness, n: number, venueOrderId: string, side: "BUY" | "SELL", shares: string, limitPrice: string): Promise<string> {
  h.venue.placement = () => accepted(venueOrderId, "LIVE");
  const g = group(n, { side, plannedShares: shares, limitPrice });
  expect((await h.manager.registerGroup(g)).ok).toBe(true);
  const t = ticket(g, { n, shares, limitPrice });
  const result = await h.manager.submit(t);
  if (!result.ok) throw new Error(result.refusal.code);
  expect(h.manager.order(t.orderId)?.venueOrderId).toBe(venueOrderId);
  return t.orderId;
}

let tripwire: NetworkTripwire;
beforeEach(() => {
  tripwire = installNetworkTripwire();
});
afterEach(() => {
  tripwire.uninstall();
  expect(tripwire.refused()).toEqual([]);
});

describe("the projections are inputs the real OMS takes", () => {
  it("order-lifecycle fixtures → OrderObservation: LIVE, MATCHED (observed), CANCELED", async () => {
    const h = await openHarness();
    const orderId = await place(h, 1, id("feed0001"), "BUY", "100", "0.08");
    const orders = await examples("order-lifecycle.json");
    const states: string[] = [];
    for (const name of ["placement-live", "update-partially-matched", "cancellation"]) {
      const payload = orders.get(name);
      if (payload === undefined) throw new Error(name);
      const message = normalizeUserChannelMessage(payload, OPTIONS);
      if (message.kind !== "ORDER") throw new Error(message.kind);
      const { observation, shortfalls } = projectOrderEventForOms(message.event);
      expect(shortfalls).toEqual([]);
      if (observation === null) throw new Error("no observation");
      const result = await h.manager.applyOrderObservation(asObservation(observation));
      if (!result.ok) throw new Error(result.refusal.code);
      states.push(result.value.state);
    }
    expect(states).toEqual(["LIVE", "LIVE", "CANCELED"]);
    expect(h.manager.order(orderId)?.state).toBe("CANCELED");
  });

  it("trade-settlement fixtures, taker side → FillReport and SettlementObservation: one fill, MATCHED → MINED → CONFIRMED", async () => {
    const h = await openHarness();
    const orderId = await place(h, 2, id("feed0004"), "BUY", "40", "0.08");
    const trades = await examples("trade-settlement.json");
    const settled: string[] = [];
    for (const name of ["matched", "mined", "confirmed-terminal"]) {
      const payload = trades.get(name);
      if (payload === undefined) throw new Error(name);
      const projection = tradeProjection(payload);
      for (const fill of projection.fills) {
        const recorded = await h.manager.recordFill(asFill(fill));
        if (!recorded.ok) throw new Error(recorded.refusal.code);
      }
      for (const settlement of projection.settlements) {
        const applied = await h.manager.applySettlement(asSettlement(settlement));
        if (!applied.ok) throw new Error(applied.refusal.code);
        settled.push(applied.value);
      }
    }
    expect(settled).toEqual(["MATCHED", "MINED", "CONFIRMED"]);
    expect(h.manager.order(orderId)).toMatchObject({ state: "FILLED", filledShares: "40" });
  });

  it("maker side: the MATCHED maker leg is a shortfall (no exact maker fee on the stream, D-13); once the fill is known, the RETRYING and FAILED fixtures settle it, and FAILED halts", async () => {
    const h = await openHarness();
    await place(h, 3, id("feed0007"), "BUY", "10", "0.09");
    const trades = await examples("trade-settlement.json");
    const retrying = trades.get("retrying");
    const failed = trades.get("failed-terminal");
    if (retrying === undefined || failed === undefined) throw new Error("fixture missing");

    // The fixtures carry no MATCHED event for this trade: before the fill is known the OMS refuses the settlement.
    const early = tradeProjection(retrying);
    expect(early.fills).toEqual([]);
    const refused = await h.manager.applySettlement(asSettlement(early.settlements[0] as OmsSettlementObservation));
    expect(refused.ok === false && refused.refusal.code).toBe("OMS_UNKNOWN_FILL");

    // A MATCHED event for the same trade (built from the RETRYING fixture, with the match time a MATCHED event carries):
    // the maker fee depends on the market's `feeSchedule.takerOnly`, which the stream does not carry, so the stream
    // projects the settlement and a shortfall (a reconciliation request), never a fill with a guessed fee.
    const matched = tradeProjection({ ...retrying, status: "MATCHED", match_time: "1782753379" });
    expect(matched.fills).toEqual([]);
    expect(matched.shortfalls).toEqual(["MAKER_FEE_NOT_ON_STREAM"]);
    expect(matched.settlements).toEqual([expect.objectContaining({ venueOrderId: id("feed0007"), status: "MATCHED" })]);

    // The reconciler (WP-290) records the fill from its authoritative read. This stand-in carries only the facts
    // the event fixed (the fee is whatever that read establishes, so none is stated here).
    const fromAuthoritativeRead: FillReport = {
      venueTradeId: "00000000-0000-0000-0000-00000000t002",
      venueOrderId: id("feed0007"),
      shares: "10",
      price: "0.09",
      liquidityRole: "MAKER",
      matchedAt: "2026-06-29T17:16:19.000Z",
    };
    expect((await h.manager.recordFill(fromAuthoritativeRead)).ok).toBe(true);
    const states: string[] = [];
    for (const projection of [matched, early, tradeProjection(failed)]) {
      for (const settlement of projection.settlements) {
        const applied = await h.manager.applySettlement(asSettlement(settlement));
        if (!applied.ok) throw new Error(applied.refusal.code);
        states.push(applied.value);
      }
    }
    expect(states).toEqual(["MATCHED", "RETRYING", "FAILED"]);
    expect(h.manager.alerts().some((alert) => alert.kind === "SETTLEMENT_FAILED" && alert.haltMarket)).toBe(true);
  });
});
