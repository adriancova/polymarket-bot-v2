/**
 * `C1-TIF` (ADR-034 D3.1 item 2): the §12.1 `ExecutionPolicy` reads the
 * time-in-force the PLANNED ORDER carries, and a GTD order's stated expiry is
 * the plan's `expirationUnixSeconds` on the clock's recorded monotonic scale.
 * There is no side table and no default.
 */

import type { PlannedOrderView } from "@polymarket-bot/simulation";
import { describe, expect, it } from "vitest";

import { ManualClock } from "./testing/index.js";
import { createExecutionPolicy } from "./venue-policy.js";

function order(fields: Record<string, unknown>): PlannedOrderView {
  return { plannedOrderId: "planned-1", ...fields } as unknown as PlannedOrderView;
}

describe("C1-TIF — the execution policy reads the plan", () => {
  it("answers each of the four values the order carries", () => {
    const policy = createExecutionPolicy(new ManualClock("2026-05-01T09:00:00.000Z"), () => undefined);
    for (const timeInForce of ["GTC", "GTD", "FAK", "FOK"]) {
      expect(policy.timeInForceFor(order({ timeInForce }))).toBe(timeInForce);
    }
  });

  it("refuses, logged, an order that carries none or an unknown one", () => {
    const lines: string[] = [];
    const policy = createExecutionPolicy(new ManualClock("2026-05-01T09:00:00.000Z"), (line) => lines.push(line));
    expect(() => policy.timeInForceFor(order({}))).toThrow(/refuses to assume one/u);
    expect(() => policy.timeInForceFor(order({ timeInForce: "IOC" }))).toThrow(/refuses to assume one/u);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("planned-1");
  });

  it("a GTD order's stated expiry: the clock's monotonic reading plus (expiration − now)", () => {
    // 09:01:32 is 1777626092 Unix seconds: 92 s after the clock's 09:00:00.
    const clock = new ManualClock("2026-05-01T09:00:00.000Z", 5_000n);
    const policy = createExecutionPolicy(clock, () => undefined);
    const gtd = order({ timeInForce: "GTD", expirationUnixSeconds: 1_777_626_092 });
    expect(policy.statedExpiryNsFor(gtd)).toBe(5_000n + 92_000_000_000n);
    // Read at the submission instant: a later clock gives the same absolute expiry.
    clock.positionAt("2026-05-01T09:00:10.500Z", 10_500_005_000n);
    expect(policy.statedExpiryNsFor(gtd)).toBe(5_000n + 92_000_000_000n);
  });

  it("states no expiry for GTC, FAK or FOK, whatever else the order carries", () => {
    const policy = createExecutionPolicy(new ManualClock("2026-05-01T09:00:00.000Z"), () => undefined);
    for (const timeInForce of ["GTC", "FAK", "FOK"]) {
      expect(policy.statedExpiryNsFor(order({ timeInForce, expirationUnixSeconds: 1_777_626_092 }))).toBeUndefined();
    }
  });

  it("refuses, logged, a GTD order without a readable expiration", () => {
    const lines: string[] = [];
    const policy = createExecutionPolicy(new ManualClock("2026-05-01T09:00:00.000Z"), (line) => lines.push(line));
    for (const expirationUnixSeconds of [undefined, "1777626092", 1.5]) {
      expect(() => policy.statedExpiryNsFor(order({ timeInForce: "GTD", expirationUnixSeconds }))).toThrow(
        /refuses to assume one/u,
      );
    }
    expect(lines).toHaveLength(3);
  });
});
