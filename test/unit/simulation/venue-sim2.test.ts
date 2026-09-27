/**
 * SIM-2 — `SimulatedVenue` BOUNDED (LOOPMEM-SIM part 2), pinned at the venue.
 *
 * - (1) A NON-destructive fill cursor over an ABSOLUTE sequence
 *   (`fillsSince`); a cursor older than the retained window is REFUSED
 *   (`SIMULATED_VENUE_HISTORY_EVICTED`), never answered short.
 * - (2) LIVE orders in a live index; terminal orders in a bounded, counted
 *   retention log that every lookup falls back to; `runReplay` refuses a run
 *   whose history was evicted.
 * - (3) The duplicate-`plannedOrderId` guard after an order left the live
 *   index — through the retained log, then through bounded, counted
 *   tombstones.
 * - (5) Tier 0 keeps ONE last instant per (market, side), not every trade;
 *   Tier 1 keeps its list (queued `SIM2-TIER1-TRADES`), with the evidence pin
 *   for why it is not trimmed to the earliest live `restingFromNs`.
 * - (6) `restingBands()` is LIVE; `bandHistory()` is what `runReplay`
 *   serializes.
 * - (7) DELAYED resolution and the expiry sweep run over LIVE state.
 * - (8) `retention()`: live sizes, retained / maximum / evicted, tombstones.
 *
 * PAPER/BACKTEST only: no network, credential, signer or real order.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_VENUE_RETENTION,
  SimulatedVenue,
  createReplayClock,
  deriveStreams,
  readDatasetManifestText,
  runReplay,
  simulationOk,
  tier0Model,
  tier1Model,
  unmodeledRateLimits,
  type CancelPlanView,
  type ExecutionPolicy,
  type FeeScheduleSnapshot,
  type LatencyModel,
  type PlacementPlanView,
  type PlannedOrderView,
  type QueueModelParameters,
  type RecordedEventIdentity,
  type ReplayClock,
  type SimulatedVenueOptions,
} from "../../../packages/simulation/src/index.js";

import { OUT_OF_ORDER_VENUE_FRAMES, buildDataset, runPins, sha256Hex, venueTimestampNormalizer } from "./fixtures.js";

const FEES: FeeScheduleSnapshot = {
  snapshotVersion: "fees/2026-08-24",
  takerFeeRate: "0.07",
  makerFeeRate: "0",
  roundingDecimalPlaces: 5,
  roundingMode: "HALF_UP",
  minimumChargedFee: "0.00001",
  feeCurrency: "USDC",
};

const MARKET_A = "0190a3e0-0000-7000-8000-00000000000a";
const MARKET_B = "0190a3e0-0000-7000-8000-00000000000b";
const START_NS = 1_000_000_000n;
const SECOND_NS = 1_000_000_000n;

function event(ingestSeq: number): RecordedEventIdentity {
  return {
    gatewayEpoch: "0190a3e0-0000-7000-8000-000000000001",
    ingestSeq: String(ingestSeq),
    receivedAt: `2026-01-01T00:00:${String(ingestSeq % 60).padStart(2, "0")}.000Z`,
    datasetRowOrdinal: ingestSeq,
  };
}

const QUEUE: QueueModelParameters = {
  queueModelVersion: "sim/queue/v1",
  cancellationRatio: { OPTIMISTIC: "0.5", BASE: "0.1", CONSERVATIVE: "0" },
  cancelEffectiveAfterMs: { OPTIMISTIC: 10, BASE: 50, CONSERVATIVE: 250 },
  placedBehindSameInstantAdditions: { OPTIMISTIC: false, BASE: false, CONSERVATIVE: true },
  basis: "ASSUMED_NOT_MEASURED_NO_PROBE_DATA_EXISTS",
};

const LATENCY: LatencyModel = {
  latencyModelVersion: "sim/latency/v1",
  decision: { samples: [{ milliseconds: 0, weight: 1 }] },
  signing: { samples: [{ milliseconds: 0, weight: 1 }] },
  network: { samples: [{ milliseconds: 0, weight: 1 }] },
  venue: { samples: [{ milliseconds: 0, weight: 1 }] },
  basis: "ASSUMED_NOT_MEASURED_NO_PROBE_DATA_EXISTS",
};

function replayClock(): ReplayClock {
  const built = createReplayClock({
    receivedAt: "2026-01-01T00:00:00.000Z",
    receivedMonotonicNs: START_NS.toString(),
  });
  if (!built.ok) throw new Error("clock refused");
  return built.value;
}

/** Moves the clock to `START_NS + seconds`. */
function advance(clock: ReplayClock, seconds: number): void {
  const moved = clock.advanceTo({
    receivedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString(),
    receivedMonotonicNs: (START_NS + BigInt(seconds) * SECOND_NS).toString(),
  });
  if (!moved.ok) throw new Error(`the clock refused: ${moved.refusal.message}`);
}

/** Bid 0.4 × 100; asks 0.5 × 30 then 0.6 × 20. */
function sidedBook(marketId: string) {
  return {
    internalMarketId: marketId,
    tokenId: marketId === MARKET_A ? "1234" : "5678",
    top: () => ({}),
    ladder: (side: "BID" | "ASK") =>
      side === "ASK"
        ? [
            { price: "0.5", size: "30" },
            { price: "0.6", size: "20" },
          ]
        : [{ price: "0.4", size: "100" }],
  };
}

function policy(overrides: Partial<ExecutionPolicy> = {}): ExecutionPolicy {
  return {
    timeInForceFor: () => "GTC",
    statedExpiryNsFor: () => undefined,
    sameInstantAdditionsFor: () => ({ observedShares: "0" }),
    ...overrides,
  };
}

interface Built {
  readonly venue: SimulatedVenue;
  readonly clock: ReplayClock;
}

/** A Tier-0 venue with books for both markets, positioned at event 1. */
function tier0(overrides: Partial<SimulatedVenueOptions> = {}): Built {
  const clock = replayClock();
  const venue = new SimulatedVenue({
    clock,
    runMode: "BACKTEST",
    model: tier0Model({ fillModelVersion: "sim/tier0/v1", fillModelParametersHash: "0".repeat(64) }),
    feeSnapshot: FEES,
    rateLimits: unmodeledRateLimits("no venue budget model is wired in this test"),
    policy: policy(),
    startingCash: "100000",
    books: { book: ({ marketId }) => sidedBook(marketId) },
    ...overrides,
  });
  venue.observe(event(1));
  return { venue, clock };
}

/** A Tier-1 venue over MARKET_A's fixed book, positioned at event 1. */
function tier1(secondsDelay: number, overrides: Partial<SimulatedVenueOptions> = {}): Built {
  const clock = replayClock();
  const venue = new SimulatedVenue({
    clock,
    runMode: "BACKTEST",
    model: tier1Model({ fillModelVersion: "sim/tier1/v1", fillModelParametersHash: "0".repeat(64) }),
    feeSnapshot: FEES,
    rateLimits: unmodeledRateLimits("no venue budget model is wired in this test"),
    policy: policy(),
    startingCash: "100000",
    timeline: { bookAt: () => ({ book: sidedBook(MARKET_A), atEvent: event(1) }) },
    latencyModel: LATENCY,
    streams: deriveStreams("42"),
    marketParameters: () => ({
      marketId: MARKET_A,
      tickSize: "0.01",
      minimumOrderSize: "1",
      secondsDelay,
      parametersVersion: 1,
    }),
    queueParameters: QUEUE,
    ...overrides,
  });
  venue.observe(event(1));
  return { venue, clock };
}

function order(id: string, overrides: Partial<PlannedOrderView> = {}): PlannedOrderView {
  return {
    plannedOrderId: id,
    marketId: MARKET_A,
    side: "YES",
    action: "BUY",
    limitPrice: "0.5",
    shares: "1",
    postOnly: false,
    executionStyle: "MARKETABLE_LIMIT",
    reservationId: `res-${id}`,
    ...overrides,
  };
}

/** A resting BUY at 0.45 (crosses nothing: the best ask is 0.5). */
function resting(id: string, overrides: Partial<PlannedOrderView> = {}): PlannedOrderView {
  return order(id, { executionStyle: "REST", limitPrice: "0.45", shares: "10", ...overrides });
}

function plan(orders: readonly PlannedOrderView[], executionPlanId = "plan-1"): PlacementPlanView {
  const groups: { executionGroupId: string; marketId: string; tickSize: string; minimumOrderSize: string; orders: PlannedOrderView[] }[] = [];
  for (const planned of orders) {
    const last = groups[groups.length - 1];
    if (last !== undefined && last.marketId === planned.marketId) {
      last.orders.push(planned);
      continue;
    }
    groups.push({
      executionGroupId: `group-${String(groups.length)}`,
      marketId: planned.marketId,
      tickSize: "0.01",
      minimumOrderSize: "1",
      orders: [planned],
    });
  }
  return {
    executionPlanId,
    strategyInstanceId: "instance-1",
    runMode: "BACKTEST",
    plannedAt: "2026-01-01T00:00:00.000Z",
    deadline: "2026-01-01T00:00:10.000Z",
    planKind: "POSITION",
    priority: "PLACEMENT",
    priceProtection: { mode: "CAPPED_LIMIT_ORDERS_ONLY" },
    escalation: { atDeadline: "CANCEL_REMAINING" },
    partialFill: { policy: "ACCEPT_ANY" },
    groups,
  };
}

function cancelPlan(scope: CancelPlanView["scope"], executionPlanId = "plan-cancel"): CancelPlanView {
  return {
    executionPlanId,
    strategyInstanceId: "instance-1",
    runMode: "BACKTEST",
    plannedAt: "2026-01-01T00:00:00.000Z",
    deadline: "2026-01-01T00:00:10.000Z",
    planKind: "CANCEL",
    priority: "SAFETY_CANCEL",
    priceProtection: { mode: "NO_NEW_ORDERS" },
    escalation: { atDeadline: "ESCALATE_TO_RECONCILIATION" },
    scope,
    reason: "kill switch",
  };
}

/** Books `count` one-share marketable BUYs, each FILLED on arrival (one fill each). */
async function fillMany(venue: SimulatedVenue, prefix: string, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const id = `${prefix}${String(index).padStart(4, "0")}`;
    const result = await venue.submit(plan([order(id)], `plan-${id}`));
    if (!result.accepted) throw new Error(`${id} refused: ${String(result.refusalCode)}`);
  }
}

function states(venue: SimulatedVenue): string[] {
  return venue.ordersSnapshot().map((entry) => `${entry.simulatedOrderId} ${entry.state}`);
}

// ---------------------------------------------------------------------------
// (1) the fill cursor
// ---------------------------------------------------------------------------

describe("SIM-2 (1): fillsSince is a NON-destructive cursor over an absolute sequence", () => {
  it("answers the fills at or after a sequence, and the next one, as often as asked", async () => {
    const { venue } = tier0();
    // 40 shares against asks 0.5 × 30 then 0.6 × 20: two fills (30 @ 0.5, 10 @ 0.6).
    const result = await venue.submit(plan([order("two", { limitPrice: "0.6", shares: "40" })]));
    expect(result.accepted).toBe(true);
    const all = venue.fillsSince(0);
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    expect(all.value.next).toBe(2);
    expect(all.value.fills.map((fill) => `${fill.shares}@${fill.price}`)).toEqual(["30@0.5", "10@0.6"]);
    // Non-destructive: the same question gets the same answer.
    expect(venue.fillsSince(0)).toEqual(all);
    const tail = venue.fillsSince(1);
    expect(tail.ok && tail.value.fills.map((fill) => fill.simulatedFillId)).toEqual([all.value.fills[1]?.simulatedFillId]);
    expect(venue.fillsSince(2)).toEqual({ ok: true, value: { fills: [], next: 2 } });
    // The answer is this package's own frozen, prototype-free tree.
    expect(Object.isFrozen(all.value)).toBe(true);
    expect(Object.getPrototypeOf(all.value)).toBeNull();
    // …and the history accessor still answers every fill, in production order.
    expect(venue.fills.map((fill) => fill.simulatedFillId)).toEqual(all.value.fills.map((fill) => fill.simulatedFillId));
  });

  it("REFUSES a cursor older than the retained window — loudly, never by skipping", async () => {
    const { venue } = tier0({ retention: { fills: 3 } });
    await fillMany(venue, "f", 5);
    // Five fills produced (sequences 0-4); the newest three (2-4) are retained.
    expect(venue.retention().fills).toEqual({
      retained: 3,
      maximumRetained: 3,
      evicted: 2,
      firstRetainedSequence: 2,
      nextSequence: 5,
    });
    for (const behind of [0, 1]) {
      const refused = venue.fillsSince(behind);
      expect(refused.ok).toBe(false);
      if (refused.ok) continue;
      expect(refused.refusal.code).toBe("SIMULATED_VENUE_HISTORY_EVICTED");
      expect(refused.refusal.message).toContain(`sequence ${String(behind)} to 1 were EVICTED`);
    }
    const kept = venue.fillsSince(2);
    expect(kept.ok && kept.value.fills.map((fill) => fill.simulatedOrderId)).toEqual(["f0002", "f0003", "f0004"]);
    expect(kept.ok && kept.value.next).toBe(5);
    expect(venue.fills.map((fill) => fill.simulatedOrderId)).toEqual(["f0002", "f0003", "f0004"]);
  });

  it("refuses every cursor that is not a non-negative safe integer at or before `next`, and never throws", async () => {
    const { venue } = tier0();
    await fillMany(venue, "f", 1);
    const hostile: unknown[] = [
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      2 ** 53,
      "0",
      null,
      undefined,
      Symbol("cursor"),
      10n,
      {},
      new Proxy({}, { get: () => { throw new Error("trap"); } }),
      2, // one past `next` (1): names a fill that does not exist
    ];
    for (const cursor of hostile) {
      const answered = venue.fillsSince(cursor as number);
      expect(answered.ok, String(typeof cursor)).toBe(false);
      if (answered.ok) continue;
      expect(answered.refusal.code).toBe("SIMULATION_INPUT_INVALID");
    }
  });
});

// ---------------------------------------------------------------------------
// (2) the live index and the retention log
// ---------------------------------------------------------------------------

describe("SIM-2 (2): live orders in the live index, terminal orders in a bounded retention log", () => {
  it("a terminal order leaves the live index and is still found by lookup and listed by the history", async () => {
    const { venue } = tier0();
    await venue.submit(plan([order("filled"), resting("rest")]));
    // FILLED on arrival goes straight to the history; the resting order is live.
    expect(venue.retention().live).toEqual({ orders: 1, resting: 1, bands: 0, pendingDelayed: 0 });
    expect(venue.retention().orders).toEqual({ retained: 1, maximumRetained: DEFAULT_VENUE_RETENTION.orders, evicted: 0 });
    expect(venue.orderById("filled")?.state).toBe("FILLED");
    expect(venue.orderByPlannedId("filled")?.state).toBe("FILLED");
    expect(venue.orderById("rest")?.state).toBe("RESTING");

    const cancelled = await venue.cancel({ executionPlanId: "c1", reason: "r", scope: { orderIds: ["rest"] }, priority: "SAFETY_CANCEL" });
    expect(cancelled.cancelled).toEqual(["rest"]);
    // The cancelled order LEFT the live index…
    expect(venue.retention().live).toEqual({ orders: 0, resting: 0, bands: 0, pendingDelayed: 0 });
    expect(venue.retention().orders.retained).toBe(2);
    // …and every read that needs it still finds it.
    expect(venue.orderById("rest")?.state).toBe("CANCELLED");
    expect(states(venue)).toEqual(["filled FILLED", "rest CANCELLED"]);
    const again = await venue.cancel({ executionPlanId: "c2", reason: "r", scope: { orderIds: ["rest", "filled"] }, priority: "SAFETY_CANCEL" });
    expect(again.notCancelled).toEqual([
      { simulatedOrderId: "filled", reason: "already FILLED" },
      { simulatedOrderId: "rest", reason: "already CANCELLED" },
    ]);
    // A CANCEL PLAN lists the order it cancelled, found in the history.
    await venue.submit(plan([resting("rest-2")], "plan-2"));
    const asPlan = await venue.submit(cancelPlan({ orderIds: ["rest-2"] }));
    expect(asPlan.accepted).toBe(true);
    expect(asPlan.orders.map((entry) => `${entry.simulatedOrderId} ${entry.state}`)).toEqual(["rest-2 CANCELLED"]);
    // A market-scoped cancel walks the LIVE index only: nothing live, a successful no-op.
    const sweep = await venue.cancel({ executionPlanId: "c3", reason: "r", scope: { marketId: MARKET_A }, priority: "SAFETY_CANCEL" });
    expect(sweep).toMatchObject({ cancelled: [], notCancelled: [] });
    // The account's open orders are the live index.
    expect((await venue.queryAccountState()).openOrders).toEqual([]);
  });

  it("orderByPlannedId answers only an order booked under that planned id", async () => {
    const { venue } = tier0();
    await venue.submit(plan([order("p1")]));
    expect(venue.orderByPlannedId("p1")?.plannedOrderId).toBe("p1");
    expect(venue.orderByPlannedId("never")).toBeUndefined();
    expect(venue.orderById("never")).toBeUndefined();
    expect(venue.orderById(7 as unknown as string)).toBeUndefined();
    expect(venue.orderByPlannedId(null as unknown as string)).toBeUndefined();
  });

  it("EVICTION: the oldest terminal orders are forgotten, oldest first, counted, and tombstoned", async () => {
    const { venue } = tier0({ retention: { orders: 3, tombstones: 10 } });
    await venue.submit(plan([resting("live-0")], "plan-live"));
    await fillMany(venue, "t", 5);
    const retention = venue.retention();
    expect(retention.live.orders).toBe(1);
    expect(retention.orders).toEqual({ retained: 3, maximumRetained: 3, evicted: 2 });
    expect(retention.tombstones).toEqual({ retained: 2, maximumRetained: 10, evicted: 0 });
    expect(retention.historyEvicted).toBe(true);
    // The history accessor answers the WINDOW: the live order plus the newest three.
    expect(states(venue)).toEqual(["live-0 RESTING", "t0002 FILLED", "t0003 FILLED", "t0004 FILLED"]);
    expect(venue.orderById("t0000")).toBeUndefined();
    expect(venue.orderById("t0002")?.state).toBe("FILLED");
    // A cancel naming a FORGOTTEN id is refused as terminal — never as unknown,
    // and never cancelled; an id the venue never saw is still unknown.
    const cancelled = await venue.cancel({ executionPlanId: "c", reason: "r", scope: { orderIds: ["t0000", "never"] }, priority: "SAFETY_CANCEL" });
    expect(cancelled.cancelled).toEqual([]);
    expect(cancelled.notCancelled.map((entry) => entry.simulatedOrderId)).toEqual(["never", "t0000"]);
    expect(cancelled.notCancelled[0]?.reason).toBe("SIMULATED_VENUE_UNKNOWN_ORDER");
    expect(cancelled.notCancelled[1]?.reason).toContain("already terminal");
  });

  it("a live order is never evicted, however small the bound", async () => {
    const { venue } = tier0({ retention: { orders: 1 } });
    await venue.submit(plan([resting("a"), resting("b"), resting("c")]));
    await fillMany(venue, "t", 4);
    expect(venue.retention().live.orders).toBe(3);
    for (const id of ["a", "b", "c"]) expect(venue.orderById(id)?.state).toBe("RESTING");
    expect(venue.retention().orders).toEqual({ retained: 1, maximumRetained: 1, evicted: 3 });
  });

  it("the constructor refuses a bound that is not a positive safe integer, naming it", () => {
    for (const [name, bound] of [
      ["orders", 0],
      ["fills", -1],
      ["bands", 1.5],
      ["tombstones", Number.NaN],
    ] as const) {
      expect(() => tier0({ retention: { [name]: bound } })).toThrow(new RegExp(`retention\\.${name}`, "u"));
    }
  });

  it("DEFAULTS are far above every fixture and golden in the repository (none of them evicts)", () => {
    expect(DEFAULT_VENUE_RETENTION).toEqual({ orders: 50_000, fills: 50_000, bands: 10_000, tombstones: 100_000 });
    const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const paper = JSON.parse(readFileSync(join(root, "test/replay-golden/paper-e2e/paper-e2e-run.json"), "utf8")) as {
      orders: unknown[];
      fills: unknown[];
    };
    const backtest = readFileSync(join(root, "test/replay-golden/backtest/static-bracket/expected-artifact.txt"), "utf8");
    const simulation = JSON.parse(readFileSync(join(root, "test/replay-golden/simulation/golden-replay.json"), "utf8")) as {
      expected: { serialization: string[] };
    };
    const lines = (text: string, prefix: string): number => text.split("\n").filter((line) => line.startsWith(prefix)).length;
    const census = {
      paperOrders: paper.orders.length,
      paperFills: paper.fills.length,
      backtestOrders: lines(backtest, "order "),
      backtestFills: lines(backtest, "fill "),
      simulationOrders: simulation.expected.serialization.filter((line) => line.startsWith("order ")).length,
      simulationFills: simulation.expected.serialization.filter((line) => line.startsWith("fill ")).length,
      simulationBands: simulation.expected.serialization.filter((line) => line.startsWith("band ")).length,
    };
    // Non-vacuous: every golden really carries orders and fills.
    expect(Object.values(census).every((count) => count > 0)).toBe(true);
    const largest = Math.max(...Object.values(census));
    expect(largest).toBeLessThan(10);
    expect(DEFAULT_VENUE_RETENTION.bands).toBeGreaterThanOrEqual(1_000 * largest);
    expect(DEFAULT_VENUE_RETENTION.orders).toBeGreaterThanOrEqual(10_000 * largest);
    expect(DEFAULT_VENUE_RETENTION.fills).toBeGreaterThanOrEqual(10_000 * largest);
  });
});

// ---------------------------------------------------------------------------
// (2) runReplay refuses an evicted history
// ---------------------------------------------------------------------------

describe("SIM-2 (2): runReplay REFUSES to serialize a run whose venue evicted history", () => {
  async function replayWith(retention: SimulatedVenueOptions["retention"], tier: "TIER_0" | "TIER_1" = "TIER_0") {
    const fixture = buildDataset({ frames: OUT_OF_ORDER_VENUE_FRAMES });
    const dataset = readDatasetManifestText(fixture.manifestText);
    if (!dataset.ok) throw new Error(dataset.refusal.message);
    let atIso = "2026-01-01T00:00:00.000Z";
    let atNs = 0n;
    const clock = { now: () => atIso, monotonicNs: () => atNs };
    const common = {
      clock,
      runMode: "BACKTEST" as const,
      feeSnapshot: FEES,
      rateLimits: unmodeledRateLimits("no venue budget model is wired in this test"),
      policy: policy(),
      startingCash: "100000",
      ...(retention === undefined ? {} : { retention }),
    };
    const venue =
      tier === "TIER_0"
        ? new SimulatedVenue({
            ...common,
            model: tier0Model({ fillModelVersion: "sim/tier0/v1", fillModelParametersHash: "0".repeat(64) }),
            books: { book: ({ marketId }) => sidedBook(marketId) },
          })
        : new SimulatedVenue({
            ...common,
            model: tier1Model({ fillModelVersion: "sim/tier1/v1", fillModelParametersHash: "0".repeat(64) }),
            timeline: { bookAt: () => ({ book: sidedBook(MARKET_A), atEvent: event(1) }) },
            latencyModel: LATENCY,
            streams: deriveStreams("42"),
            marketParameters: () => ({ marketId: MARKET_A, tickSize: "0.01", minimumOrderSize: "1", secondsDelay: 0, parametersVersion: 1 }),
            queueParameters: QUEUE,
          });
    let seen = 0;
    return await runReplay({
      dataset: dataset.value,
      archive: fixture.archive,
      digestSha256: sha256Hex,
      normalizer: venueTimestampNormalizer(),
      runPins: runPins(),
      venue,
      coreLoop: async (context) => {
        atIso = context.record.frame.receivedAt;
        atNs = context.monotonicNs;
        seen += 1;
        // Tier 0: one FILLED order (one fill) per event. Tier 1: one resting
        // band order per event, cancelled at once (its band enters history).
        if (tier === "TIER_0") {
          const booked = await venue.submit(plan([order(`o${String(seen)}`)], `p${String(seen)}`));
          if (!booked.accepted) throw new Error(String(booked.refusalCode));
          return simulationOk(null);
        }
        const id = `r${String(seen)}`;
        const booked = await venue.submit(plan([resting(id)], `p${String(seen)}`));
        if (!booked.accepted) throw new Error(String(booked.refusalCode));
        await venue.cancel({ executionPlanId: `c${String(seen)}`, reason: "r", scope: { orderIds: [id] }, priority: "SAFETY_CANCEL" });
        return simulationOk(null);
      },
    });
  }

  it("serializes the whole run while nothing was evicted", async () => {
    const whole = await replayWith(undefined);
    expect(whole.ok, whole.ok ? "" : whole.refusal.message).toBe(true);
    if (!whole.ok) return;
    expect(whole.value.orders).toHaveLength(3);
    expect(whole.value.fills).toHaveLength(3);
    // A bound equal to the run's size evicts nothing and changes no byte.
    const exact = await replayWith({ orders: 3, fills: 3 });
    expect(exact.ok && exact.value.serialization).toBe(whole.value.serialization);
  });

  it.each([
    ["orders", { orders: 2 }, "TIER_0"],
    ["fills", { fills: 2 }, "TIER_0"],
    ["bands", { bands: 2 }, "TIER_1"],
  ] as const)("refuses when %s were evicted", async (what, retention, tier) => {
    const refused = await replayWith(retention, tier);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.refusal.code).toBe("SIMULATED_VENUE_HISTORY_EVICTED");
    expect(refused.refusal.details[`${what}Evicted`]).toBe(1);
  });

  it("a Tier-1 run with every band retained serializes the band HISTORY (cancelled orders' last bands included)", async () => {
    const whole = await replayWith(undefined, "TIER_1");
    expect(whole.ok, whole.ok ? "" : whole.refusal.message).toBe(true);
    if (!whole.ok) return;
    expect(whole.value.bands.map((band) => band.simulatedOrderId)).toEqual(["r1", "r2", "r3"]);
    expect(whole.value.serialization.split("\n").filter((line) => line.startsWith("band "))).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// (3) the duplicate-plannedOrderId guard (§6 invariant 6)
// ---------------------------------------------------------------------------

describe("SIM-2 (3): a reused plannedOrderId is refused after its order left the live index", () => {
  it("refused through the retained history, then through a tombstone, and accepted — COUNTED — only once both forgot it", async () => {
    const { venue } = tier0({ retention: { orders: 1, tombstones: 1 } });
    await venue.submit(plan([order("dup")], "plan-dup-1"));
    expect(venue.retention().live.orders).toBe(0);
    const viaHistory = await venue.submit(plan([order("dup")], "plan-dup-2"));
    expect(viaHistory).toMatchObject({ accepted: false, outcome: "REFUSED", refusalCode: "SIMULATED_VENUE_DUPLICATE_ORDER" });

    // One more terminal order: "dup" leaves the retained history for a tombstone.
    await venue.submit(plan([order("next-1")], "plan-next-1"));
    expect(venue.orderById("dup")).toBeUndefined();
    expect(venue.retention().tombstones).toEqual({ retained: 1, maximumRetained: 1, evicted: 0 });
    const viaTombstone = await venue.submit(plan([order("dup")], "plan-dup-3"));
    expect(viaTombstone).toMatchObject({ accepted: false, refusalCode: "SIMULATED_VENUE_DUPLICATE_ORDER" });

    // Another: "dup"'s tombstone is evicted, and the eviction is COUNTED.
    await venue.submit(plan([order("next-2")], "plan-next-2"));
    expect(venue.retention().tombstones).toEqual({ retained: 1, maximumRetained: 1, evicted: 1 });
    const forgotten = await venue.submit(plan([order("dup")], "plan-dup-4"));
    expect(forgotten.accepted).toBe(true);
  });

  it("with the default bounds a reused id is refused however many orders ended since", async () => {
    const { venue } = tier0();
    await venue.submit(plan([order("dup")], "plan-dup-1"));
    await fillMany(venue, "t", 200);
    const reused = await venue.submit(plan([order("dup")], "plan-dup-2"));
    expect(reused).toMatchObject({ accepted: false, refusalCode: "SIMULATED_VENUE_DUPLICATE_ORDER" });
    expect(venue.retention().orders.evicted).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// (5) #trades
// ---------------------------------------------------------------------------

describe("SIM-2 (5): observed trades", () => {
  it("Tier 0 holds ONE instant per (market, side) — not the trades — and still refuses an earlier trade", async () => {
    const { venue } = tier0();
    for (let index = 0; index < 500; index += 1) {
      for (const [marketId, side] of [
        [MARKET_A, "YES"],
        [MARKET_A, "NO"],
        [MARKET_B, "YES"],
      ] as const) {
        const traded = venue.observeTrade({ marketId, side, price: "0.3", shares: "1", monotonicNs: START_NS + BigInt(index), atEvent: event(2) });
        expect(traded.ok).toBe(true);
      }
    }
    expect(venue.retention().trades).toEqual({ tier: "TIER_0", keys: 3, retained: 0 });
    const earlier = venue.observeTrade({ marketId: MARKET_A, side: "YES", price: "0.3", shares: "1", monotonicNs: START_NS + 10n, atEvent: event(3) });
    expect(earlier.ok).toBe(false);
    if (earlier.ok) return;
    expect(earlier.refusal.code).toBe("REPLAY_CLOCK_NOT_MONOTONE");
    expect(earlier.refusal.details["previousMonotonicNs"]).toBe((START_NS + 499n).toString());
    // An EQUAL instant is still accepted.
    const equal = venue.observeTrade({ marketId: MARKET_A, side: "YES", price: "0.3", shares: "1", monotonicNs: START_NS + 499n, atEvent: event(3) });
    expect(equal.ok).toBe(true);
    // …and the resting path is unchanged: a trade through a resting BUY fills
    // the whole remaining size as a MAKER at its limit, and the order leaves
    // the live index.
    const { venue: second } = tier0();
    await second.submit(plan([resting("rest")]));
    const through = second.observeTrade({ marketId: MARKET_A, side: "YES", price: "0.4", shares: "1", monotonicNs: START_NS, atEvent: event(2) });
    expect(through.ok && through.value.fills.map((fill) => `${fill.shares}@${fill.price} ${fill.liquidityRole}`)).toEqual(["10@0.45 MAKER"]);
    expect(second.orderById("rest")?.state).toBe("FILLED");
    expect(second.retention().live).toEqual({ orders: 0, resting: 0, bands: 0, pendingDelayed: 0 });
  });

  it("Tier 1 keeps every trade it may still need for a band (NOT bounded, queued SIM2-TIER1-TRADES)", () => {
    const { venue } = tier1(0);
    for (let index = 0; index < 50; index += 1) {
      venue.observeTrade({ marketId: MARKET_A, side: "YES", price: "0.3", shares: "1", monotonicNs: START_NS + BigInt(index), atEvent: event(2) });
    }
    expect(venue.retention().trades).toEqual({ tier: "TIER_1", keys: 1, retained: 50 });
  });

  it("EVIDENCE for not trimming Tier 1 to the earliest live restingFromNs: an order placed LATER rests at a trade the venue already holds", async () => {
    // No order is resting when the trade prints, so "the earliest live
    // restingFromNs" is undefined and a trim keyed on it keeps nothing.
    // A later order, placed at the same recorded instant with zero latency,
    // rests AT that instant — and its band is computed from the trade the
    // venue already holds. A trim would have changed the band.
    const { venue } = tier1(0);
    const traded = venue.observeTrade({ marketId: MARKET_A, side: "YES", price: "0.45", shares: "40", monotonicNs: START_NS, atEvent: event(2) });
    expect(traded.ok).toBe(true);
    const placed = await venue.submit(plan([resting("late")]));
    expect(placed.accepted).toBe(true);
    // Queue ahead at 0.45 is 0 (the book shows no bid at 0.45), so the trade
    // at the order's price fills it whole in every scenario: 10 of 10.
    expect(placed.bands.map((band) => `${band.optimistic.filledShares} ${band.base.filledShares} ${band.conservative.filledShares}`)).toEqual(["10 10 10"]);
    expect(venue.restingBands()[0]?.base.fills.map((fill) => fill.simulatedFillId)).toEqual(["late/t1q/BASE/0"]);
  });
});

// ---------------------------------------------------------------------------
// (6) restingBands() is LIVE; bandHistory() is what runReplay serializes
// ---------------------------------------------------------------------------

describe("SIM-2 (6): restingBands() is live; bandHistory() is the run's history", () => {
  it("a cancelled or expired Tier-1 order's band leaves restingBands() for bandHistory()", async () => {
    const { venue, clock } = tier1(0, {
      policy: policy({
        timeInForceFor: (planned) => (planned.plannedOrderId === "gtd" ? "GTD" : "GTC"),
        statedExpiryNsFor: (planned) => (planned.plannedOrderId === "gtd" ? START_NS + 120n * SECOND_NS : undefined),
      }),
    });
    await venue.submit(plan([resting("gtc"), resting("gtd"), resting("stays")]));
    expect(venue.restingBands().map((band) => band.simulatedOrderId)).toEqual(["gtc", "gtd", "stays"]);
    expect(venue.bandHistory()).toEqual(venue.restingBands());

    await venue.cancel({ executionPlanId: "c", reason: "r", scope: { orderIds: ["gtc"] }, priority: "SAFETY_CANCEL" });
    // GTD: stated 120 s, effective 60 s (ADR-012 §5.2); expired by the next event past it.
    advance(clock, 61);
    venue.observe(event(3));
    expect(venue.orderById("gtd")?.state).toBe("EXPIRED");

    expect(venue.restingBands().map((band) => band.simulatedOrderId)).toEqual(["stays"]);
    expect(venue.bandHistory().map((band) => band.simulatedOrderId)).toEqual(["gtc", "gtd", "stays"]);
    expect(venue.retention().live.bands).toBe(1);
    expect(venue.retention().bands).toEqual({ retained: 2, maximumRetained: DEFAULT_VENUE_RETENTION.bands, evicted: 0 });
    // A later trade updates the LIVE band only; a terminal order's last band is kept as it was.
    const before = venue.bandHistory().find((band) => band.simulatedOrderId === "gtc");
    const traded = venue.observeTrade({ marketId: MARKET_A, side: "YES", price: "0.45", shares: "5", monotonicNs: START_NS + 62n * SECOND_NS, atEvent: event(4) });
    expect(traded.ok && traded.value.bands.map((band) => band.simulatedOrderId)).toEqual(["stays"]);
    expect(venue.bandHistory().find((band) => band.simulatedOrderId === "gtc")).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// (7) DELAYED and the expiry sweep run over LIVE state
// ---------------------------------------------------------------------------

describe("SIM-2 (7): the DELAYED sweep and the expiry sweep read LIVE state only", () => {
  it("a DELAYED order resolves at matchableAtNs with the history full and evicting; pending and resting drain to zero", async () => {
    const { venue, clock } = tier1(5, { retention: { orders: 2, tombstones: 4 } });
    // Fill the retained history past its bound first (terminal orders only).
    const booked = await venue.submit(plan([order("fak-1", { shares: "1" })], "plan-f1"));
    expect(booked.orders[0]?.state).toBe("DELAYED");
    expect(venue.retention().live).toMatchObject({ orders: 1, pendingDelayed: 1 });
    // Three more DELAYED orders; resolve all four at the window's end.
    for (const id of ["fak-2", "fak-3", "fak-4"]) await venue.submit(plan([order(id)], `plan-${id}`));
    expect(venue.retention().live.pendingDelayed).toBe(4);
    advance(clock, 5);
    const positioned = venue.observe(event(2));
    expect(positioned.ok).toBe(true);
    const retention = venue.retention();
    expect(retention.live).toEqual({ orders: 0, resting: 0, bands: 0, pendingDelayed: 0 });
    // Four terminal orders against a bound of two: two retained, two tombstoned.
    expect(retention.orders).toEqual({ retained: 2, maximumRetained: 2, evicted: 2 });
    expect(retention.tombstones.retained).toBe(2);
    expect(venue.orderById("fak-4")?.state).toBe("FILLED");
    expect(venue.fills.map((fill) => fill.simulatedOrderId)).toEqual(["fak-1", "fak-2", "fak-3", "fak-4"]);
  });
});
