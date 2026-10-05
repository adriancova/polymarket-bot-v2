/**
 * WP-320: the live gate and the submission fence. Kill switches outrank
 * everything (ADR-008 §8); the fence, the health lease and the explicit stops
 * gate every order; the heartbeat, eligibility and reconciliation halts gate
 * new entries.
 */

import { describe, expect, it } from "vitest";

import { evaluateLiveGate, type GateInputs, type GateRequest } from "./entry-gate.js";
import { engageRow } from "./fakes.test-support.js";
import { fenceVenuePort } from "./fenced-venue.js";
import { foldKillSwitchRows, killSwitchEffects, type KillSwitchSnapshot } from "./kill-switch.js";

const MARKET = "0190a3e0-0000-7000-8000-00000000000c";
const OTHER_MARKET = "0190a3e0-0000-7000-8000-00000000000d";
const INSTANCE = "0190a3e0-0000-7000-8000-00000000000a";

function known(rows: readonly unknown[] = []): KillSwitchSnapshot {
  return { known: true, effects: killSwitchEffects(foldKillSwitchRows(rows), "acct-1"), readStartedAtMs: 0 };
}

function inputs(overrides: Partial<GateInputs> = {}): GateInputs {
  return {
    killSwitch: () => known(),
    fence: () => ({ held: true, fence: { fencingLeaseId: "l", fencingToken: "1" }, remainingMs: 10_000 }),
    health: () => ({ healthy: true, failures: [], reasons: [], atMs: 0 }),
    explicitStops: () => [],
    heartbeatLapsed: () => false,
    recoveryBlocksEntries: () => false,
    eligibility: () => ({ newEntriesPermitted: true, reasons: [], geoblockTier: "NOT_BLOCKED" }),
    reconciliationHalts: () => ({ account: false, markets: new Set<string>() }),
    ...overrides,
  };
}

const ENTRY: GateRequest = { kind: "NEW_ENTRY", marketId: MARKET, instanceId: INSTANCE };
const REDUCTION: GateRequest = { kind: "REDUCTION", marketId: MARKET, instanceId: INSTANCE };
const TRANSMISSION: GateRequest = { kind: "TRANSMISSION" };

describe("the live gate", () => {
  it("permits everything when every input holds", () => {
    for (const request of [ENTRY, REDUCTION, TRANSMISSION]) expect(evaluateLiveGate(inputs(), request)).toEqual({ permitted: true, reasons: [] });
  });

  it("unknown kill-switch state blocks EVERYTHING (a process that cannot read it cannot prove it may trade)", () => {
    const gate = inputs({ killSwitch: () => ({ known: false, reason: "READ_FAILED" }) });
    for (const request of [ENTRY, REDUCTION, TRANSMISSION]) expect(evaluateLiveGate(gate, request)).toEqual({ permitted: false, reasons: ["KILL_SWITCH_UNKNOWN_READ_FAILED"] });
  });

  it("a GLOBAL HALT_NEW_ENTRIES blocks entries only; a GLOBAL FULL_HALT blocks every order", () => {
    const halt = inputs({ killSwitch: () => known([engageRow({ id: "e", scope: "GLOBAL", scopeRef: null, action: "HALT_NEW_ENTRIES" })]) });
    expect(evaluateLiveGate(halt, ENTRY).reasons).toEqual(["KILL_SWITCH_ACCOUNT_ENGAGED"]);
    expect(evaluateLiveGate(halt, REDUCTION).permitted).toBe(true);
    const full = inputs({ killSwitch: () => known([engageRow({ id: "e", scope: "GLOBAL", scopeRef: null, action: "FULL_HALT" })]) });
    for (const request of [ENTRY, REDUCTION, TRANSMISSION]) expect(evaluateLiveGate(full, request).permitted).toBe(false);
  });

  it("a MARKET switch blocks that market only; MANAGE_POSITIONS_ONLY leaves its reductions", () => {
    const gate = inputs({ killSwitch: () => known([engageRow({ id: "m", scope: "MARKET", scopeRef: MARKET, action: "MANAGE_POSITIONS_ONLY" })]) });
    expect(evaluateLiveGate(gate, ENTRY).reasons).toEqual(["KILL_SWITCH_MARKET_ENGAGED"]);
    expect(evaluateLiveGate(gate, { ...ENTRY, marketId: OTHER_MARKET }).permitted).toBe(true);
    expect(evaluateLiveGate(gate, REDUCTION).permitted).toBe(true);
    expect(evaluateLiveGate(gate, TRANSMISSION).permitted).toBe(true);
  });

  it("a STRATEGY_INSTANCE CANCEL_ALL blocks that instance's entries and reductions", () => {
    const gate = inputs({ killSwitch: () => known([engageRow({ id: "i", scope: "STRATEGY_INSTANCE", scopeRef: INSTANCE, action: "CANCEL_ALL" })]) });
    expect(evaluateLiveGate(gate, ENTRY).reasons).toEqual(["KILL_SWITCH_INSTANCE_ENGAGED"]);
    expect(evaluateLiveGate(gate, REDUCTION).reasons).toEqual(["KILL_SWITCH_INSTANCE_ENDS_TRADING"]);
  });

  it("the fence, the health lease and an explicit stop gate every order", () => {
    const fence = inputs({ fence: () => ({ held: false, reason: "EXPIRED" }) });
    for (const request of [ENTRY, REDUCTION, TRANSMISSION]) expect(evaluateLiveGate(fence, request).reasons).toEqual(["FENCE_EXPIRED"]);
    const health = inputs({ health: () => ({ healthy: false, failures: [{ input: "OMS", reason: "FAULTED" }], reasons: ["HEALTH_OMS_FAULTED"], atMs: 0 }) });
    for (const request of [ENTRY, REDUCTION, TRANSMISSION]) expect(evaluateLiveGate(health, request).reasons).toEqual(["HEALTH_LEASE_FAILED", "HEALTH_OMS_FAULTED"]);
    const stop = inputs({ explicitStops: () => ["INCIDENT_CONTROLLER"] });
    for (const request of [ENTRY, REDUCTION, TRANSMISSION]) expect(evaluateLiveGate(stop, request).reasons).toEqual(["STOPPED_INCIDENT_CONTROLLER"]);
  });

  it("the heartbeat lapse, the D6 latch, eligibility and reconciliation halts gate NEW entries only", () => {
    const gate = inputs({
      heartbeatLapsed: () => true,
      recoveryBlocksEntries: () => true,
      eligibility: () => ({ newEntriesPermitted: false, reasons: ["GEOBLOCK_AMBIGUOUS_NOT_THE_DOCUMENTED_SHAPE"], geoblockTier: "UNKNOWN" }),
      reconciliationHalts: () => ({ account: true, markets: new Set([MARKET]) }),
    });
    expect(evaluateLiveGate(gate, ENTRY).reasons).toEqual([
      "HEARTBEAT_LAPSED",
      "HEARTBEAT_RECOVERY_PENDING",
      "GEOBLOCK_AMBIGUOUS_NOT_THE_DOCUMENTED_SHAPE",
      "RECONCILIATION_ACCOUNT_HALT",
      "RECONCILIATION_MARKET_HALT",
    ]);
    expect(evaluateLiveGate(gate, REDUCTION).permitted).toBe(true);
    expect(evaluateLiveGate(gate, TRANSMISSION).permitted).toBe(true);
  });

  it("an input that throws blocks, and names itself; a malformed request is refused", () => {
    const gate = inputs({
      heartbeatLapsed: () => {
        throw new Error("x");
      },
    });
    expect(evaluateLiveGate(gate, ENTRY).reasons).toEqual(["HEARTBEAT_UNREADABLE", "HEARTBEAT_LAPSED"]);
    expect(evaluateLiveGate(inputs(), { kind: "NEW_ENTRY", marketId: "", instanceId: INSTANCE }).reasons).toEqual(["REQUEST_UNREADABLE"]);
    expect(evaluateLiveGate(inputs(), { kind: "SOMETHING" } as never).reasons).toEqual(["REQUEST_UNREADABLE"]);
  });
});

describe("the submission fence in front of the venue port", () => {
  function fakeVenue(): {
    calls: string[];
    venue: {
      createLimitOrder(request: string): Promise<string>;
      postOrder(order: string): Promise<string>;
      postOrders(orders: readonly string[]): Promise<readonly string[]>;
      cancelOrder(orderId: string): Promise<string>;
    };
  } {
    const calls: string[] = [];
    return {
      calls,
      venue: {
        createLimitOrder: async (request) => {
          calls.push(`sign:${request}`);
          return "SIGNED";
        },
        postOrder: async (order) => {
          calls.push(`post:${order}`);
          return "ACCEPTED";
        },
        postOrders: async (orders) => {
          calls.push(`batch:${orders.join(",")}`);
          return orders.map(() => "ACCEPTED");
        },
        cancelOrder: async (orderId) => {
          calls.push(`cancel:${orderId}`);
          return "CANCELED";
        },
      },
    };
  }
  const refusals = { signRefused: (reasons: readonly string[]) => `FAILED(${reasons.join(",")})`, placementRefused: (reasons: readonly string[]) => `NOT_SENT(${reasons.join(",")})` };

  it("passes everything through while the gate permits", async () => {
    const { calls, venue } = fakeVenue();
    const fenced = fenceVenuePort(venue, () => ({ permitted: true, reasons: [] }), refusals);
    expect(await fenced.createLimitOrder("r")).toBe("SIGNED");
    expect(await fenced.postOrder("o")).toBe("ACCEPTED");
    expect(await fenced.postOrders(["a", "b"])).toEqual(["ACCEPTED", "ACCEPTED"]);
    expect(calls).toEqual(["sign:r", "post:o", "batch:a,b"]);
  });

  it("refuses signing and every transmission WITHOUT calling the venue; cancels still pass", async () => {
    const { calls, venue } = fakeVenue();
    const fenced = fenceVenuePort(venue, () => ({ permitted: false, reasons: ["FENCE_EXPIRED"] }), refusals);
    expect(await fenced.createLimitOrder("r")).toBe("FAILED(FENCE_EXPIRED)");
    expect(await fenced.postOrder("o")).toBe("NOT_SENT(FENCE_EXPIRED)");
    expect(await fenced.postOrders(["a", "b"])).toEqual(["NOT_SENT(FENCE_EXPIRED)", "NOT_SENT(FENCE_EXPIRED)"]);
    expect(await fenced.cancelOrder("v")).toBe("CANCELED");
    expect(calls).toEqual(["cancel:v"]);
  });

  it("a gate that throws refuses", async () => {
    const { calls, venue } = fakeVenue();
    const fenced = fenceVenuePort(
      venue,
      () => {
        throw new Error("x");
      },
      refusals,
    );
    expect(await fenced.postOrder("o")).toBe("NOT_SENT(GATE_THREW)");
    expect(calls).toEqual([]);
  });
});
