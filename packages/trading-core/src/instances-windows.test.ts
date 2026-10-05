/**
 * `ROLLOVER-1` (ADR-030 Decision 4): the registry holds one registration per
 * WINDOW of a series-bound instance, keyed `<instanceId>|<marketId>`, beside
 * market-bound registrations keyed by their instance id — and it DERIVES the
 * key, so a registration spread from another one never carries a stale key.
 */

import { describe, expect, it } from "vitest";

import { InstanceRegistry, windowRegistrationKey, type InstanceRegistration } from "./instances.js";

function registration(overrides: Partial<InstanceRegistration> = {}): InstanceRegistration {
  return {
    instanceId: "a18f4a7e-0000-7abc-8def-000000000001",
    runId: "018f4a7e-0000-7abc-8def-000000000002",
    configId: "018f4a7e-0000-7abc-8def-000000000003",
    marketId: "018f4a7e-0000-7abc-8def-0000000000aa",
    ownership: "OWNER",
    evaluationPriority: 0,
    runtime: {} as never,
    direction: "YES",
    params: {},
    immediateOrderType: "FAK",
    submissionUnknownAfterMs: 5000,
    ...overrides,
  };
}

const W1 = "019db1a2-1c20-7000-8000-000000000001";
const W2 = "019db1a2-2a30-7000-8000-000000000002";

describe("InstanceRegistry — windows of a series-bound instance (ROLLOVER-1)", () => {
  it("keys a window by instance and market, a market-bound instance by its id", () => {
    const registry = new InstanceRegistry();
    expect(registry.register(registration()).ok).toBe(true);
    expect(registry.register(registration({ instanceId: "b1", marketId: W1, window: true })).ok).toBe(true);
    expect(registry.register(registration({ instanceId: "b1", marketId: W2, window: true })).ok).toBe(true);
    expect(registry.evaluationOrder().map((entry) => entry.key)).toEqual([
      "a18f4a7e-0000-7abc-8def-000000000001",
      windowRegistrationKey("b1", W1),
      windowRegistrationKey("b1", W2),
    ]);
    expect(registry.get(windowRegistrationKey("b1", W2))?.window).toBe(true);
    // The same window twice is a duplicate; a second OWNER of a window is refused.
    expect(registry.register(registration({ instanceId: "b1", marketId: W1, window: true })).ok).toBe(false);
    const second = registry.register(registration({ instanceId: "c1", marketId: W1, window: true }));
    expect(second.ok ? "ok" : second.code).toBe("MARKET_ALREADY_OWNED");
  });

  it("derives the key: a registration spread from a registered one gets its own", () => {
    const registry = new InstanceRegistry();
    registry.register(registration());
    const first = registry.evaluationOrder()[0];
    if (first === undefined) throw new Error("not registered");
    const shadow = registry.register({ ...first, instanceId: "b18f4a7e-9999-7abc-8def-0123456789ab", ownership: "SHADOW" });
    expect(shadow.ok).toBe(true);
    expect(registry.get("b18f4a7e-9999-7abc-8def-0123456789ab")?.key).toBe("b18f4a7e-9999-7abc-8def-0123456789ab");
  });

  it("retires a torn-down window's registrations — never a market-bound one — and keeps their identity", () => {
    const registry = new InstanceRegistry();
    registry.register(registration({ marketId: W1 }));
    registry.register(registration({ instanceId: "b1", marketId: W1, window: true, ownership: "SHADOW" }));
    expect(registry.retireMarket(W1)).toBe(1);
    expect(registry.evaluationOrder().map((entry) => entry.key)).toEqual(["a18f4a7e-0000-7abc-8def-000000000001"]);
    expect(registry.identityOf(windowRegistrationKey("b1", W1))).toEqual({
      key: windowRegistrationKey("b1", W1),
      instanceId: "b1",
      runId: "018f4a7e-0000-7abc-8def-000000000002",
      marketId: W1,
    });
    // A retired window is never registered again under its key.
    expect(registry.register(registration({ instanceId: "b1", marketId: W1, window: true, ownership: "SHADOW" })).ok).toBe(false);
  });

  it("a retired window's owner claim is released", () => {
    const registry = new InstanceRegistry();
    registry.register(registration({ instanceId: "b1", marketId: W1, window: true }));
    expect(registry.ownerOf(W1)).toBe("b1");
    registry.retireMarket(W1);
    expect(registry.ownerOf(W1)).toBeUndefined();
  });
});
