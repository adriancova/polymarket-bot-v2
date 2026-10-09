/**
 * `ROLLOVER-1` r7 — one series-bound strategy instance, several live windows:
 * what §9.8 and §9.7 judge is the INSTANCE, not the window. PAPER only; the
 * real trader composition (allocator, risk engine, planner, simulated venue,
 * ledger) over a synthetic `SeriesStream` of the recorded windows.
 *
 * 1. **R7-FABLE-01 (check 16, the PRIMARY limit).** W1 holds 50 @ 0.34 (cost
 *    17) to its resolution; W2 opens and its entry bounds 50 @ 0.35 (17.5).
 *    The instance's worst-case contractual loss is 17 + 17.5 = 34.5, and that
 *    is what `maxWorstCaseContractualLoss` is compared with: W2 is refused
 *    under a limit of 34.49 and admitted under 34.5, exactly. At `95a0b76`
 *    W2's evaluation saw W2 alone (17.5) and was admitted under a limit of 20
 *    (the verifier's P3).
 * 2. **R7-FABLE-01 (check 17, scenario loss).** Every live window is marked
 *    from its OWN book: under `spot.down` (−0.1) W1 is marked 0 (its bid 0.1)
 *    and W2 0.22 (its bid 0.32), so the instance's loss is 17 + 17.5 − 11 =
 *    23.5; W2 is refused at 23.49 and admitted at 23.5. At `95a0b76` it was
 *    measured on W2 alone, 6.5.
 * 3. **A missing mark is valued at 0** (C1-RISK; ADR-030 Rule 8 item 2, note
 *    of 2026-10-08). A held window whose YES book has no bid cannot be
 *    marked, so it counts at its whole committed cost: the floor check 16
 *    uses. Until C1-RISK another window's entry was refused
 *    `RISK_SCENARIO_MARKS_INCOMPLETE`; now it is judged on that floor, so it
 *    is admitted under the shipped limit and refused by a limit the floor
 *    exceeds.
 * 4. **R7-FABLE-03.** A commitment that never closes — W1's entry was booked
 *    by a venue that answered it refused (`TRDR-4`'s defensive path), so its
 *    fill is booked UNATTRIBUTED and the allocator keeps its capital for the
 *    rest of the run — holds W1 past its resolution (`teardownsBlocked`), and
 *    W1's market keeps its live owner. At `95a0b76` W1 was torn down
 *    `RESOLVED_UNHANDLED`, its market lost its live owner, and every later
 *    allocator question was refused `CAPITAL_LIVE_OWNERSHIP_MISSING` (W2's
 *    entry here). Today that refusal sits BEHIND check 1: W1's
 *    `UNATTRIBUTED_ACTIVITY` halt is latched for the run (`halt.ts`; it is
 *    re-latched from the ledger's history at every read), and any latched
 *    halt refuses every intent but a CANCEL `RISK_RUN_STATE_BLOCKS`. So the
 *    pin reads the window's teardown, its owner and the ALLOCATOR's own
 *    answer, not a fill: at `95a0b76` W2's entry was refused by the halt AND
 *    by the allocator. The allocator-level mechanism, with a positive control
 *    for a protective REDUCE that holds inventory, is pinned in
 *    `packages/trading-core/src/allocation-windows.test.ts`.
 */

import type { AdmissionNotice, TraderVenue } from "@polymarket-bot/trader";
import type { SimulatedVenue } from "@polymarket-bot/simulation";
import { describe, expect, it } from "vitest";

import { assembleOrThrow } from "./support/run.js";
import { DEAD_QUOTE, ENTRY_QUOTE, STOP_QUOTE, SeriesStream } from "./support/series-stream.js";
import { seriesConfig, W1, W2 } from "./support/series-windows.js";

/** Hold the position through the close, to its resolution (no protective exit before it). */
const HOLD_TO_RESOLUTION = { final_policy: "HOLD_TO_RESOLUTION", allow_resolution_hold: true, maximum_holding_seconds: 7200 } as const;

/** The series configuration with risk limits, allocator caps and the strategy's `exit` block overridden. */
function configWith(
  options: {
    readonly limits?: Record<string, unknown>;
    readonly scenario?: Record<string, unknown>;
    readonly caps?: Record<string, unknown>;
    readonly exit?: Record<string, unknown>;
  } = {},
): Record<string, unknown> {
  const base = seriesConfig();
  const instance = (base["seriesInstances"] as Record<string, unknown>[])[0] as Record<string, unknown>;
  const params = instance["params"] as Record<string, unknown>;
  const policy = base["riskPolicy"] as Record<string, unknown>;
  return {
    ...base,
    riskPolicy: {
      ...policy,
      limits: { ...(policy["limits"] as Record<string, unknown>), ...options.limits },
      scenario: { ...(policy["scenario"] as Record<string, unknown>), ...options.scenario },
    },
    allocatorCaps: { ...(base["allocatorCaps"] as Record<string, unknown>), ...options.caps },
    seriesInstances: [{ ...instance, params: { ...params, exit: { ...(params["exit"] as Record<string, unknown>), ...options.exit } } }],
  };
}

function label(marketId: string): string {
  return marketId === W1.marketId ? "W1" : marketId === W2.marketId ? "W2" : marketId;
}

function noticeLine(notice: AdmissionNotice): string {
  switch (notice.kind) {
    case "ADMITTED":
      return `ADMITTED ${label(notice.window.marketId)}`;
    case "REFUSED":
      return `REFUSED ${notice.code} ${notice.marketId === undefined ? "-" : label(notice.marketId)}`;
    case "TORN_DOWN":
      return `TORN_DOWN ${label(notice.window.marketId)} ${notice.reason}`;
    case "HELD_UNRESOLVED":
      return `HELD_UNRESOLVED ${label(notice.window.marketId)}`;
  }
}

async function drive(
  config: Record<string, unknown>,
  stream: SeriesStream,
  options: { readonly wrapVenue?: (venue: SimulatedVenue) => TraderVenue } = {},
) {
  const notices: AdmissionNotice[] = [];
  const run = assembleOrThrow({
    config,
    idNamespace: "rollover-1-r7",
    onAdmission: (notice) => notices.push(notice),
    ...(options.wrapVenue === undefined ? {} : { wrapVenue: options.wrapVenue }),
  });
  for (const event of stream.events) run.trader.loop.ingest(event);
  await run.trader.loop.drain();
  const health = run.trader.loop.health();
  return {
    run,
    health,
    notices: notices.map(noticeLine),
    fills: run.parts.venue.fills.map((fill) => `${label(fill.marketId)} ${fill.action} ${fill.shares}@${fill.price}`),
    refusals: run.parts.store.riskRefusals.map((refusal) => `${label(refusal.marketId)} ${refusal.refusals.map((entry) => entry.code).join("+")}`),
  };
}

/**
 * W2 admitted ahead; W1 admitted, opened and quoted under the trigger at 22:16
 * (the bracket buys 50 at 0.34), then quoted where no exit sells and no entry
 * buys (`w1Hold`); W2 opens at 22:30 and is quoted under the trigger.
 */
function twoWindows(w1Hold: { readonly bids: readonly (readonly [string, string])[]; readonly asks: readonly (readonly [string, string])[] } = DEAD_QUOTE): SeriesStream {
  return new SeriesStream()
    .admit(W2, "2026-10-04T22:15:59.000Z")
    .tick("2026-10-04T22:16:00.000Z")
    .admit(W1, "2026-10-04T22:16:01.000Z")
    .open(W1, "2026-10-04T22:16:02.000Z")
    .book(W1, "2026-10-04T22:16:03.000Z", ENTRY_QUOTE)
    .tick("2026-10-04T22:16:05.000Z")
    .book(W1, "2026-10-04T22:16:10.000Z", w1Hold)
    .tick("2026-10-04T22:29:50.000Z")
    .open(W2, "2026-10-04T22:30:00.000Z")
    .book(W2, "2026-10-04T22:30:03.000Z", ENTRY_QUOTE)
    .tick("2026-10-04T22:30:05.000Z");
}

describe("ROLLOVER-1 r7 (R7-FABLE-01): §9.8 check 16 — the PRIMARY worst-case limit — judges the strategy INSTANCE across its live windows", () => {
  it("W1 holds 17, W2's entry bounds 17.5: refused RISK_WORST_CASE_LOSS_EXCEEDED under a limit of 20 (the verifier's P3; 95a0b76 admitted both, 34.5 for one instance)", async () => {
    const { fills, refusals, health } = await drive(configWith({ limits: { maxWorstCaseContractualLoss: "20" }, exit: HOLD_TO_RESOLUTION }), twoWindows());
    expect(fills).toEqual(["W1 BUY 50@0.34"]);
    expect(refusals).toEqual(["W2 RISK_WORST_CASE_LOSS_EXCEEDED"]);
    expect(health.seams.allocator.refusalsByCode).toEqual({});
    expect(health.halts).toEqual([]);
  });

  it("the boundary is the instance's EXACT sum, 17 + 17.5 = 34.5: refused at 34.49, admitted at 34.5", async () => {
    const under = await drive(configWith({ limits: { maxWorstCaseContractualLoss: "34.49" }, exit: HOLD_TO_RESOLUTION }), twoWindows());
    expect(under.fills).toEqual(["W1 BUY 50@0.34"]);
    expect(under.refusals).toEqual(["W2 RISK_WORST_CASE_LOSS_EXCEEDED"]);
    const at = await drive(configWith({ limits: { maxWorstCaseContractualLoss: "34.5" }, exit: HOLD_TO_RESOLUTION }), twoWindows());
    expect(at.fills).toEqual(["W1 BUY 50@0.34", "W2 BUY 50@0.34"]);
    expect(at.refusals).toEqual([]);
  });

  it("control: W1's OWN entry is judged on W1 alone (17.5) — refused at 17.49, admitted at 17.5 — so the evaluating window is still in its own portfolio", async () => {
    const under = await drive(configWith({ limits: { maxWorstCaseContractualLoss: "17.49" }, exit: HOLD_TO_RESOLUTION }), twoWindows());
    expect(under.fills).toEqual([]);
    expect(under.refusals.every((line) => line.endsWith("RISK_WORST_CASE_LOSS_EXCEEDED"))).toBe(true);
    expect(under.refusals[0]).toBe("W1 RISK_WORST_CASE_LOSS_EXCEEDED");
    const at = await drive(configWith({ limits: { maxWorstCaseContractualLoss: "17.5" }, exit: HOLD_TO_RESOLUTION }), twoWindows());
    expect(at.fills).toEqual(["W1 BUY 50@0.34"]);
    expect(at.refusals).toEqual(["W2 RISK_WORST_CASE_LOSS_EXCEEDED"]);
  });

  it("control: once W1 has SOLD its position, W1 holds nothing and W2 is judged on its own 17.5 — admitted under 20", async () => {
    const stream = new SeriesStream()
      .admit(W2, "2026-10-04T22:15:59.000Z")
      .tick("2026-10-04T22:16:00.000Z")
      .admit(W1, "2026-10-04T22:16:01.000Z")
      .open(W1, "2026-10-04T22:16:02.000Z")
      .book(W1, "2026-10-04T22:16:03.000Z", ENTRY_QUOTE)
      .tick("2026-10-04T22:16:05.000Z")
      .book(W1, "2026-10-04T22:16:10.000Z", STOP_QUOTE)
      .tick("2026-10-04T22:16:12.000Z")
      .tick("2026-10-04T22:16:14.000Z")
      .book(W1, "2026-10-04T22:16:20.000Z", DEAD_QUOTE)
      .tick("2026-10-04T22:29:50.000Z")
      .open(W2, "2026-10-04T22:30:00.000Z")
      .book(W2, "2026-10-04T22:30:03.000Z", ENTRY_QUOTE)
      .tick("2026-10-04T22:30:05.000Z");
    const { fills, refusals } = await drive(configWith({ limits: { maxWorstCaseContractualLoss: "20" } }), stream);
    expect(fills).toEqual(["W1 BUY 50@0.34", "W1 SELL 50@0.27", "W2 BUY 50@0.34"]);
    expect(refusals).toEqual([]);
  });
});

describe("ROLLOVER-1 r7 (R7-FABLE-01): §9.8 check 17 — scenario loss — marks EVERY live window of the instance from its own book", () => {
  it("spot.down marks W1 at 0 (bid 0.1) and W2 at 0.22 (bid 0.32): the instance's loss is 34.5 − 11 = 23.5 — W2 refused RISK_SCENARIO_LOSS_EXCEEDED at 23.49 (95a0b76: 6.5, admitted), admitted at 23.5", async () => {
    const under = await drive(configWith({ scenario: { maxScenarioLoss: "23.49" }, exit: HOLD_TO_RESOLUTION }), twoWindows());
    expect(under.fills).toEqual(["W1 BUY 50@0.34"]);
    expect(under.refusals).toEqual(["W2 RISK_SCENARIO_LOSS_EXCEEDED"]);
    const at = await drive(configWith({ scenario: { maxScenarioLoss: "23.5" }, exit: HOLD_TO_RESOLUTION }), twoWindows());
    expect(at.fills).toEqual(["W1 BUY 50@0.34", "W2 BUY 50@0.34"]);
    expect(at.refusals).toEqual([]);
  });

  it("C1-RISK: a held W1 whose YES book has NO bid is valued at 0 — its full cost 17 — so W2 is admitted under the shipped limit, refused RISK_SCENARIO_LOSS_EXCEEDED at 23.49 and admitted at 23.5", async () => {
    const noBid = { bids: [], asks: [["0.9", "200"]] } as const;
    // The shipped limit: W2 is admitted (until C1-RISK: refused MARKS_INCOMPLETE).
    const shipped = await drive(configWith({ exit: HOLD_TO_RESOLUTION }), twoWindows(noBid));
    expect(shipped.fills).toEqual(["W1 BUY 50@0.34", "W2 BUY 50@0.34"]);
    expect(shipped.refusals).toEqual([]);
    // spot.down: W1 unmarked → 17 counted in full; W2 marked 0.22 → 17.5 − 11.
    // 17 + 6.5 = 23.5. Valuing W1 at anything above 0 would admit at 23.49.
    const under = await drive(configWith({ scenario: { maxScenarioLoss: "23.49" }, exit: HOLD_TO_RESOLUTION }), twoWindows(noBid));
    expect(under.fills).toEqual(["W1 BUY 50@0.34"]);
    expect(under.refusals).toEqual(["W2 RISK_SCENARIO_LOSS_EXCEEDED"]);
    const at = await drive(configWith({ scenario: { maxScenarioLoss: "23.5" }, exit: HOLD_TO_RESOLUTION }), twoWindows(noBid));
    expect(at.fills).toEqual(["W1 BUY 50@0.34", "W2 BUY 50@0.34"]);
    expect(at.refusals).toEqual([]);
  });
});

/**
 * `TRDR-4`'s DEFENSIVE path, for W1's FIRST placement only: the plan's first
 * order is booked at the REAL venue (it fills at once against W1's ask) and
 * the loop is answered as if the whole plan had been refused, nothing listed
 * as booked. No instance owns the order; its fill is booked UNATTRIBUTED, the
 * allocator keeps its capital (`CAP-1`: the commitment never closes), and
 * W1's market is halted `UNATTRIBUTED_ACTIVITY`. Every other placement is the
 * real venue's own answer.
 */
function refusesW1EntryWhileHolding(inner: SimulatedVenue): TraderVenue {
  let doubled = false;
  return {
    observe: (identity) => inner.observe(identity),
    observeTrade: (input) => inner.observeTrade(input),
    submit: async (plan) => {
      const offered = plan as { readonly groups?: readonly { readonly orders: readonly { readonly marketId: string }[] }[] };
      const group = offered.groups?.[0];
      const first = group?.orders[0];
      if (doubled || group === undefined || first === undefined || first.marketId !== W1.marketId) {
        return inner.submit(plan as Parameters<SimulatedVenue["submit"]>[0]);
      }
      doubled = true;
      const booked = await inner.submit({ ...(plan as object), groups: [{ ...group, orders: [first] }] } as unknown as Parameters<SimulatedVenue["submit"]>[0]);
      if (!booked.accepted) throw new Error(`the double's first order was refused: ${String(booked.refusalCode)}`);
      return {
        ...booked,
        accepted: false,
        outcome: "REFUSED",
        orders: [],
        fills: [],
        bands: [],
        notPlaced: [],
        refusalCode: "SIMULATED_VENUE_RATE_LIMITED",
        refusalMessage: "the venue refused the plan (test double: it still holds the plan's first order)",
      };
    },
    fillsSince: (sequence) => inner.fillsSince(sequence),
    orderById: (venueOrderId) => inner.orderById(venueOrderId),
    orderByPlannedId: (plannedOrderId) => inner.orderByPlannedId(plannedOrderId),
    acknowledgeTerminal: (venueOrderId) => inner.acknowledgeTerminal(venueOrderId),
  } as TraderVenue;
}

describe("ROLLOVER-1 r7 (R7-FABLE-03): a window whose market a commitment still names is NOT torn down — its market keeps its live owner, so no later allocator question is refused CAPITAL_LIVE_OWNERSHIP_MISSING", () => {
  /**
   * W1's entry is booked unattributed (the double) and W1's market halts; W1
   * resolves at 22:30:30, after its close, and the 22:30:35 cycle is due to
   * tear it down; only THEN does W2 open and quote under its trigger, so W2's
   * entry is the first allocator question after that cycle.
   */
  function unattributedW1(): SeriesStream {
    return new SeriesStream()
      .admit(W2, "2026-10-04T22:15:59.000Z")
      .tick("2026-10-04T22:16:00.000Z")
      .admit(W1, "2026-10-04T22:16:01.000Z")
      .open(W1, "2026-10-04T22:16:02.000Z")
      .book(W1, "2026-10-04T22:16:03.000Z", ENTRY_QUOTE)
      .tick("2026-10-04T22:16:05.000Z")
      .book(W1, "2026-10-04T22:16:10.000Z", DEAD_QUOTE)
      .tick("2026-10-04T22:29:50.000Z")
      .resolve(W1, "2026-10-04T22:30:30.000Z")
      .tick("2026-10-04T22:30:35.000Z")
      .open(W2, "2026-10-04T22:30:40.000Z")
      .book(W2, "2026-10-04T22:30:43.000Z", ENTRY_QUOTE)
      .tick("2026-10-04T22:30:45.000Z")
      .tick("2026-10-04T22:30:50.000Z");
  }

  function refusalLines(run: Awaited<ReturnType<typeof drive>>["run"]): string[] {
    return run.parts.store.riskRefusals.map((refusal) => `${label(refusal.marketId)} ${refusal.occurredAt} ${refusal.refusals.map((entry) => entry.code).join("+")}`);
  }

  it("W1 is HELD past its resolution (teardownsBlocked) while its never-closing commitment names its market; its market keeps its live owner; W2's entry after that cycle is refused by the run-state halt ALONE — the allocator refuses nothing (95a0b76: W1 TORN_DOWN, the owner gone, CAPITAL_LIVE_OWNERSHIP_MISSING)", async () => {
    const { fills, notices, health, run } = await drive(configWith(), unattributedW1(), { wrapVenue: refusesW1EntryWhileHolding });
    // W1's entry filled at the venue but was answered refused: no instance
    // owns it, its fill is booked UNATTRIBUTED, and the allocator keeps its 17.
    expect(fills).toEqual(["W1 BUY 50@0.34"]);
    expect(health.seams.allocator).toMatchObject({ open: 1, released: 0, reservedCollateral: "17" });
    expect(health.halts.map((halt) => `${halt.code} ${halt.scope.kind === "MARKET" ? label(halt.scope.marketId) : halt.scope.kind}`)).toEqual([
      "UNATTRIBUTED_ACTIVITY W1",
    ]);
    // W1 resolved, and a commitment names its market: held, never torn down.
    expect(notices).toEqual(["ADMITTED W2", "ADMITTED W1"]);
    const metrics = run.trader.loop.admissionMetrics();
    expect(metrics).toMatchObject({ live: 2, tornDownResolved: 0, tornDownResolvedUnhandled: 0 });
    expect(metrics?.teardownsBlocked ?? 0).toBeGreaterThan(0);
    expect(run.trader.registry.ownerOf(W1.marketId)).toBeDefined();
    // W2's entry is asked of the allocator after W1's resolution cycle: the
    // account still builds, and only check 1 (the latched halt) refuses.
    expect(refusalLines(run)).toEqual([`W2 2026-10-04T22:30:45Z RISK_RUN_STATE_BLOCKS`]);
    expect(health.seams.allocator.refusalsByCode).toEqual({});
  });

  it("control: with the venue's own answer (no double) the same stream books W1's entry to the instance, nothing halts, W1 is torn down RESOLVED at its resolution, and W2 enters after it", async () => {
    const { fills, notices, health, run } = await drive(configWith(), unattributedW1());
    expect(fills).toEqual(["W1 BUY 50@0.34", "W2 BUY 50@0.34"]);
    expect(notices).toEqual(["ADMITTED W2", "ADMITTED W1", "TORN_DOWN W1 RESOLVED"]);
    expect(health.halts).toEqual([]);
    expect(health.seams.allocator.refusalsByCode).toEqual({});
    expect(refusalLines(run)).toEqual([]);
  });
});
