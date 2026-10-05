/**
 * WP-320: the live gate and the submission fence. Kill switches outrank
 * everything (ADR-008 §8); the fence, the health lease and the explicit stops
 * gate every order; the heartbeat, eligibility and reconciliation halts gate
 * new entries. The fence asks each order's OWN question at the last moment,
 * batch members one by one (r1 I2).
 */

import { describe, expect, it } from "vitest";

import { evaluateLiveGate, type GateInputs, type GateRequest } from "./entry-gate.js";
import { engageRow } from "./fakes.test-support.js";
import { fenceVenuePort, type PlacementClassifier, type PlacementScope } from "./fenced-venue.js";
import { foldKillSwitchRows, killSwitchEffects, type KillSwitchSnapshot } from "./kill-switch.js";

const MARKET = "0190a3e0-0000-7000-8000-00000000000c";
const OTHER_MARKET = "0190a3e0-0000-7000-8000-00000000000d";
const INSTANCE = "0190a3e0-0000-7000-8000-00000000000a";

function known(rows: readonly unknown[] = []): KillSwitchSnapshot {
  return { known: true, effects: killSwitchEffects(foldKillSwitchRows(rows, () => true, () => true), "acct-1"), readStartedAtMs: 0 };
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

describe("the live gate", () => {
  it("permits everything when every input holds", () => {
    for (const request of [ENTRY, REDUCTION]) expect(evaluateLiveGate(inputs(), request)).toEqual({ permitted: true, reasons: [] });
  });

  it("unknown kill-switch state blocks EVERYTHING (a process that cannot read it cannot prove it may trade)", () => {
    const gate = inputs({ killSwitch: () => ({ known: false, reason: "READ_FAILED" }) });
    for (const request of [ENTRY, REDUCTION]) expect(evaluateLiveGate(gate, request)).toEqual({ permitted: false, reasons: ["KILL_SWITCH_UNKNOWN_READ_FAILED"] });
  });

  it("a GLOBAL HALT_NEW_ENTRIES blocks entries only; a GLOBAL FULL_HALT blocks every order", () => {
    const halt = inputs({ killSwitch: () => known([engageRow({ id: "e", scope: "GLOBAL", scopeRef: null, action: "HALT_NEW_ENTRIES" })]) });
    expect(evaluateLiveGate(halt, ENTRY).reasons).toEqual(["KILL_SWITCH_ACCOUNT_ENGAGED"]);
    expect(evaluateLiveGate(halt, REDUCTION).permitted).toBe(true);
    const full = inputs({ killSwitch: () => known([engageRow({ id: "e", scope: "GLOBAL", scopeRef: null, action: "FULL_HALT" })]) });
    for (const request of [ENTRY, REDUCTION]) expect(evaluateLiveGate(full, request).permitted).toBe(false);
  });

  it("a MARKET switch blocks that market only; MANAGE_POSITIONS_ONLY leaves its reductions", () => {
    const gate = inputs({ killSwitch: () => known([engageRow({ id: "m", scope: "MARKET", scopeRef: MARKET, action: "MANAGE_POSITIONS_ONLY" })]) });
    expect(evaluateLiveGate(gate, ENTRY).reasons).toEqual(["KILL_SWITCH_MARKET_ENGAGED"]);
    expect(evaluateLiveGate(gate, { ...ENTRY, marketId: OTHER_MARKET }).permitted).toBe(true);
    expect(evaluateLiveGate(gate, REDUCTION).permitted).toBe(true);
  });

  it("a STRATEGY_INSTANCE CANCEL_ALL blocks that instance's entries and reductions", () => {
    const gate = inputs({ killSwitch: () => known([engageRow({ id: "i", scope: "STRATEGY_INSTANCE", scopeRef: INSTANCE, action: "CANCEL_ALL" })]) });
    expect(evaluateLiveGate(gate, ENTRY).reasons).toEqual(["KILL_SWITCH_INSTANCE_ENGAGED"]);
    expect(evaluateLiveGate(gate, REDUCTION).reasons).toEqual(["KILL_SWITCH_INSTANCE_ENDS_TRADING"]);
  });

  it("r4 R4-L1: a MARKET or STRATEGY_INSTANCE switch engaged under another spelling of the id blocks that id's orders (Opus N4), and so does a request carrying another spelling; an ACCOUNT switch spelt in upper case blocks too", () => {
    const market = inputs({ killSwitch: () => known([engageRow({ id: "m", scope: "MARKET", scopeRef: MARKET.toUpperCase(), action: "FULL_HALT" })]) });
    // On 04be84d: permitted, no reasons.
    expect(evaluateLiveGate(market, REDUCTION).reasons).toEqual(["KILL_SWITCH_MARKET_ENDS_TRADING"]);
    expect(evaluateLiveGate(market, ENTRY).reasons).toEqual(["KILL_SWITCH_MARKET_ENGAGED"]);
    expect(evaluateLiveGate(market, { ...REDUCTION, marketId: OTHER_MARKET }).permitted).toBe(true);
    const instance = inputs({ killSwitch: () => known([engageRow({ id: "i", scope: "STRATEGY_INSTANCE", scopeRef: `{${INSTANCE}}`, action: "FULL_HALT" })]) });
    expect(evaluateLiveGate(instance, REDUCTION).reasons).toEqual(["KILL_SWITCH_INSTANCE_ENDS_TRADING"]);
    const canonical = inputs({ killSwitch: () => known([engageRow({ id: "m", scope: "MARKET", scopeRef: MARKET, action: "FULL_HALT" })]) });
    expect(evaluateLiveGate(canonical, { ...REDUCTION, marketId: MARKET.toUpperCase() }).reasons).toEqual(["KILL_SWITCH_MARKET_ENDS_TRADING"]);
    const canonicalInstance = inputs({ killSwitch: () => known([engageRow({ id: "i", scope: "STRATEGY_INSTANCE", scopeRef: INSTANCE, action: "FULL_HALT" })]) });
    expect(evaluateLiveGate(canonicalInstance, { ...ENTRY, instanceId: INSTANCE.toUpperCase() }).reasons).toEqual(["KILL_SWITCH_INSTANCE_ENGAGED"]);
    const account = inputs({ killSwitch: () => known([engageRow({ id: "a", scope: "ACCOUNT", scopeRef: "ACCT-1", action: "FULL_HALT" })]) });
    expect(evaluateLiveGate(account, REDUCTION).reasons).toEqual(["KILL_SWITCH_ACCOUNT_ENDS_TRADING"]);
  });

  it("the fence, the health lease and an explicit stop gate every order", () => {
    const fence = inputs({ fence: () => ({ held: false, reason: "EXPIRED" }) });
    for (const request of [ENTRY, REDUCTION]) expect(evaluateLiveGate(fence, request).reasons).toEqual(["FENCE_EXPIRED"]);
    const health = inputs({ health: () => ({ healthy: false, failures: [{ input: "OMS", reason: "FAULTED" }], reasons: ["HEALTH_OMS_FAULTED"], atMs: 0 }) });
    for (const request of [ENTRY, REDUCTION]) expect(evaluateLiveGate(health, request).reasons).toEqual(["HEALTH_LEASE_FAILED", "HEALTH_OMS_FAULTED"]);
    const stop = inputs({ explicitStops: () => ["INCIDENT_CONTROLLER"] });
    for (const request of [ENTRY, REDUCTION]) expect(evaluateLiveGate(stop, request).reasons).toEqual(["STOPPED_INCIDENT_CONTROLLER"]);
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
    // r1 I2: there is no unscoped question any more.
    expect(evaluateLiveGate(inputs(), { kind: "TRANSMISSION" } as never).reasons).toEqual(["REQUEST_UNREADABLE"]);
  });
});

describe("the submission fence in front of the venue port", () => {
  function fakeVenue(): {
    calls: string[];
    venue: {
      createLimitOrder(request: string): Promise<string>;
      postOrder(order: { id: string }): Promise<string>;
      postOrders(orders: readonly { id: string }[]): Promise<readonly string[]>;
      cancelOrder(orderId: string): Promise<string>;
    };
  } {
    const calls: string[] = [];
    return {
      calls,
      venue: {
        createLimitOrder: async (request) => {
          calls.push(`sign:${request}`);
          return `SIGNED:${request}`;
        },
        postOrder: async (order) => {
          calls.push(`post:${order.id}`);
          return `ACCEPTED:${order.id}`;
        },
        postOrders: async (orders) => {
          calls.push(`batch:${orders.map((order) => order.id).join(",")}`);
          return orders.map((order) => `ACCEPTED:${order.id}`);
        },
        cancelOrder: async (orderId) => {
          calls.push(`cancel:${orderId}`);
          return "CANCELED";
        },
      },
    };
  }
  const refusals = { signRefused: (reasons: readonly string[]) => `FAILED(${reasons.join(",")})`, placementRefused: (reasons: readonly string[]) => `NOT_SENT(${reasons.join(",")})` };
  const OTHER_INSTANCE = "0190a3e0-0000-7000-8000-0000000000ee";
  const SCOPES: Record<string, PlacementScope> = {
    entry: { intent: "NEW_ENTRY", marketId: MARKET, instanceId: INSTANCE },
    reduce: { intent: "REDUCTION", marketId: MARKET, instanceId: INSTANCE },
    elsewhere: { intent: "NEW_ENTRY", marketId: OTHER_MARKET, instanceId: OTHER_INSTANCE },
    reduceElsewhere: { intent: "REDUCTION", marketId: OTHER_MARKET, instanceId: OTHER_INSTANCE },
  };
  /** Requests and orders are classified by name; a signed order is `{ id: <request> }`. */
  const classifier: PlacementClassifier<string, string, { id: string }> = {
    request: (request) => SCOPES[request] ?? null,
    signedOrder: () => undefined,
    order: (order) => SCOPES[order.id.split("#")[0] ?? ""] ?? null,
  };
  /** The live gate over a kill-switch state, judged per scope. */
  const gateWith = (rows: readonly unknown[]) => (scope: PlacementScope) => evaluateLiveGate(inputs({ killSwitch: () => known(rows) }), { kind: scope.intent, marketId: scope.marketId, instanceId: scope.instanceId });

  it("passes everything through while the gate permits", async () => {
    const { calls, venue } = fakeVenue();
    const fenced = fenceVenuePort(venue, () => ({ permitted: true, reasons: [] }), refusals, classifier);
    expect(await fenced.createLimitOrder("entry")).toBe("SIGNED:entry");
    expect(await fenced.postOrder({ id: "entry" })).toBe("ACCEPTED:entry");
    expect(await fenced.postOrders([{ id: "entry#1" }, { id: "reduce#2" }])).toEqual(["ACCEPTED:entry#1", "ACCEPTED:reduce#2"]);
    expect(calls).toEqual(["sign:entry", "post:entry", "batch:entry#1,reduce#2"]);
  });

  it("refuses signing and every transmission WITHOUT calling the venue; cancels still pass", async () => {
    const { calls, venue } = fakeVenue();
    const fenced = fenceVenuePort(venue, () => ({ permitted: false, reasons: ["FENCE_EXPIRED"] }), refusals, classifier);
    expect(await fenced.createLimitOrder("entry")).toBe("FAILED(FENCE_EXPIRED)");
    expect(await fenced.postOrder({ id: "entry" })).toBe("NOT_SENT(FENCE_EXPIRED)");
    expect(await fenced.postOrders([{ id: "entry#1" }, { id: "reduce#2" }])).toEqual(["NOT_SENT(FENCE_EXPIRED)", "NOT_SENT(FENCE_EXPIRED)"]);
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
      classifier,
    );
    expect(await fenced.postOrder({ id: "entry" })).toBe("NOT_SENT(GATE_THREW)");
    expect(calls).toEqual([]);
  });

  it("r1 I2: an order with no readable scope is never sent (PLACEMENT_UNCLASSIFIED), whatever the gate would say", async () => {
    const { calls, venue } = fakeVenue();
    const fenced = fenceVenuePort(venue, () => ({ permitted: true, reasons: [] }), refusals, {
      ...classifier,
      order: (order) => {
        if (order.id === "throws") throw new Error("x");
        return order.id === "odd" ? ({ intent: "OPEN", marketId: MARKET, instanceId: INSTANCE } as never) : null;
      },
    });
    expect(await fenced.createLimitOrder("unknown")).toBe("FAILED(PLACEMENT_UNCLASSIFIED)");
    expect(await fenced.postOrder({ id: "unknown" })).toBe("NOT_SENT(PLACEMENT_UNCLASSIFIED)");
    expect(await fenced.postOrder({ id: "throws" })).toBe("NOT_SENT(PLACEMENT_UNCLASSIFIED)");
    expect(await fenced.postOrder({ id: "odd" })).toBe("NOT_SENT(PLACEMENT_UNCLASSIFIED)");
    expect(calls).toEqual([]);
  });

  for (const [name, rows, refusedScopes, reason] of [
    ["a MARKET FULL_HALT", [engageRow({ id: "m", scope: "MARKET", scopeRef: MARKET, action: "FULL_HALT" })], ["entry", "reduce"], "KILL_SWITCH_MARKET"],
    ["a STRATEGY_INSTANCE FULL_HALT", [engageRow({ id: "i", scope: "STRATEGY_INSTANCE", scopeRef: INSTANCE, action: "FULL_HALT" })], ["entry", "reduce"], "KILL_SWITCH_INSTANCE"],
    ["a GLOBAL HALT_NEW_ENTRIES", [engageRow({ id: "g", scope: "GLOBAL", scopeRef: null, action: "HALT_NEW_ENTRIES" })], ["entry", "elsewhere"], "KILL_SWITCH_ACCOUNT_ENGAGED"],
    ["an own-ACCOUNT MANAGE_POSITIONS_ONLY", [engageRow({ id: "a", scope: "ACCOUNT", scopeRef: "acct-1", action: "MANAGE_POSITIONS_ONLY" })], ["entry", "elsewhere"], "KILL_SWITCH_ACCOUNT_ENGAGED"],
  ] as const) {
    it(`r1 I2: ${name} observed after the decision refuses exactly the orders it covers, at transmission and per batch member`, async () => {
      const { calls, venue } = fakeVenue();
      const fenced = fenceVenuePort(venue, gateWith(rows), refusals, classifier);
      for (const scope of Object.keys(SCOPES)) {
        const refused = (refusedScopes as readonly string[]).includes(scope);
        const answer = await fenced.postOrder({ id: scope });
        expect(answer.startsWith("NOT_SENT("), `${scope}`).toBe(refused);
        if (refused) expect(answer).toContain(reason);
      }
      // A batch with a covered member is refused WHOLE (WP-270 reads a mixed answer as unknown for every member):
      // each covered member names its own reasons, the others BATCH_MEMBER_REFUSED, and nothing is sent.
      const batch = await fenced.postOrders(Object.keys(SCOPES).map((scope) => ({ id: `${scope}#b` })));
      expect(batch.every((answer) => answer.startsWith("NOT_SENT("))).toBe(true);
      for (const [index, scope] of Object.keys(SCOPES).entries()) {
        if ((refusedScopes as readonly string[]).includes(scope)) expect(batch[index]).toContain(reason);
        else expect(batch[index]).toBe("NOT_SENT(BATCH_MEMBER_REFUSED)");
      }
      // A batch of uncovered members only is sent, in one call.
      const sent = Object.keys(SCOPES).filter((scope) => !(refusedScopes as readonly string[]).includes(scope));
      expect(await fenced.postOrders(sent.map((scope) => ({ id: `${scope}#c` })))).toEqual(sent.map((scope) => `ACCEPTED:${scope}#c`));
      expect(calls.filter((call) => call.startsWith("batch:"))).toEqual([`batch:${sent.map((scope) => `${scope}#c`).join(",")}`]);
      expect(calls.filter((call) => call.startsWith("post:"))).toEqual(sent.map((scope) => `post:${scope}`));
    });
  }

  it("r1 I2: an order signed through the port is judged with the scope of the request that produced it (remembered), not the fallback", async () => {
    const { calls, venue } = fakeVenue();
    const signed = { id: "anonymous" };
    let switches: readonly unknown[] = [];
    const fenced = fenceVenuePort(
      {
        ...venue,
        createLimitOrder: async (request: string) => {
          calls.push(`sign:${request}`);
          return `SIGNED:${request}`;
        },
      },
      (scope) => gateWith(switches)(scope),
      refusals,
      { request: (request) => SCOPES[request] ?? null, signedOrder: () => signed, order: () => null },
    );
    expect(await fenced.createLimitOrder("entry")).toBe("SIGNED:entry");
    // Decided and signed; THEN a MARKET switch is observed: the retransmission of the same signed order is refused.
    switches = [engageRow({ id: "m", scope: "MARKET", scopeRef: MARKET, action: "HALT_NEW_ENTRIES" })];
    expect(await fenced.postOrder(signed)).toBe("NOT_SENT(KILL_SWITCH_MARKET_ENGAGED)");
    expect(await fenced.postOrder(signed)).toBe("NOT_SENT(KILL_SWITCH_MARKET_ENGAGED)");
    switches = [];
    expect(await fenced.postOrder(signed)).toBe("ACCEPTED:anonymous");
    expect(calls).toEqual(["sign:entry", "post:anonymous"]);
  });

  it("a batch of permitted members is passed through unchanged, whatever the venue answers", async () => {
    const { venue } = fakeVenue();
    const fenced = fenceVenuePort({ ...venue, postOrders: async () => ["ONLY_ONE", "EXTRA", "MORE"] }, () => ({ permitted: true, reasons: [] }), refusals, classifier);
    expect(await fenced.postOrders([{ id: "entry#1" }, { id: "elsewhere#2" }])).toEqual(["ONLY_ONE", "EXTRA", "MORE"]);
  });

  it("r2 X3: every placement handed to the venue is reported to the tracker with its scope(s) before the call, and settled after it — answered, rejected or thrown; a refused one is never reported", async () => {
    const { venue } = fakeVenue();
    const events: string[] = [];
    let next = 0;
    const tracker = {
      started: (scopes: readonly PlacementScope[]): unknown => {
        next += 1;
        events.push(`started#${String(next)}:${scopes.map((scope) => scope.instanceId === INSTANCE ? "mine" : "other").join(",")}`);
        return next;
      },
      settled: (handle: unknown): void => {
        events.push(`settled#${String(handle)}`);
      },
    };
    let failing = false;
    const fenced = fenceVenuePort(
      {
        ...venue,
        postOrder: async (order) => {
          events.push(`post:${order.id}`);
          if (failing) throw new Error("socket hang up (synthetic)");
          return `ACCEPTED:${order.id}`;
        },
      },
      (scope) => ({ permitted: scope.marketId === MARKET, reasons: scope.marketId === MARKET ? [] : ["REFUSED"] }),
      refusals,
      classifier,
      tracker,
    );
    expect(await fenced.postOrder({ id: "entry#1" })).toBe("ACCEPTED:entry#1");
    expect(await fenced.postOrder({ id: "elsewhere#2" })).toBe("NOT_SENT(REFUSED)");
    failing = true;
    await expect(fenced.postOrder({ id: "reduce#3" })).rejects.toThrow("socket hang up");
    expect(await fenced.postOrders([{ id: "entry#4" }, { id: "reduce#5" }])).toEqual(["ACCEPTED:entry#4", "ACCEPTED:reduce#5"]);
    expect(events).toEqual(["started#1:mine", "post:entry#1", "settled#1", "started#2:mine", "post:reduce#3", "settled#2", "started#3:mine,mine", "settled#3"]);
  });

  it("r2 X3: a placement the tracker cannot track is never sent (PLACEMENT_UNTRACKED), a batch neither", async () => {
    const { calls, venue } = fakeVenue();
    const throwing = {
      started: (): unknown => {
        throw new Error("tracker broken");
      },
      settled: (): void => undefined,
    };
    const fenced = fenceVenuePort(venue, () => ({ permitted: true, reasons: [] }), refusals, classifier, throwing);
    expect(await fenced.postOrder({ id: "entry#1" })).toBe("NOT_SENT(PLACEMENT_UNTRACKED)");
    expect(await fenced.postOrders([{ id: "entry#1" }, { id: "reduce#2" }])).toEqual(["NOT_SENT(PLACEMENT_UNTRACKED)", "NOT_SENT(PLACEMENT_UNTRACKED)"]);
    expect(calls).toEqual([]);
  });
});
