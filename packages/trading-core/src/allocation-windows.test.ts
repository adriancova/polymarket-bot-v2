/**
 * `ROLLOVER-1` r1 (R1-01): `AllocatorGate.registerMarketAssets` — a market
 * admitted after the gate was built (a series window) becomes known to its
 * position projection. The trader-level behaviour (a window's exit is
 * approved; its exposure counts toward the global cap) is pinned in
 * `test/integration/paper-trader/rollover-1-window-lifecycle.test.ts`.
 */

import { parseAllocatorCaps } from "@polymarket-bot/capital-allocator";
import { describe, expect, it } from "vitest";

import { AllocatorGate } from "./allocation.js";

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
