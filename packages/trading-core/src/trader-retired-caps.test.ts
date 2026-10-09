/**
 * C1-RISK (EXPO-CAPS; the user's ruling, 2026-10-08): the capital allocator is
 * the only exposure-cap authority. `riskPolicy.limits` no longer has the six
 * per-scope `*ExposureCap` fields, and it is strict, so an old configuration
 * that still states one is REFUSED at startup — loudly, never by silently
 * losing the cap — and the refusal names the `allocatorCaps` field that states
 * that cap now.
 *
 * Run on the SHIPPED example configuration, so the example and the door are
 * held together.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseAllocatorCaps } from "@polymarket-bot/capital-allocator";
import { parseRiskPolicy } from "@polymarket-bot/risk";
import { describe, expect, it } from "vitest";

import { ManualClock, MemoryTraderStore } from "./testing/index.js";
import { createPaperTrader } from "./trader.js";

const EXAMPLE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../infra/compose/trader/trader.config.example.json",
);

function example(): Record<string, unknown> {
  return JSON.parse(readFileSync(EXAMPLE, "utf8")) as Record<string, unknown>;
}

function paperEnvironment(): Record<string, string | undefined> {
  return {
    MAX_RUN_MODE: "PAPER",
    RUN_MODE: "PAPER",
    ALLOW_REAL_ORDERS: "false",
    LIVE_MICRO_MAX_ORDER_NOTIONAL: "0",
    LIVE_MICRO_MAX_ACCOUNT_EXPOSURE: "0",
    NODE_ENV: "test",
  };
}

/** `createPaperTrader` on `config`; the refusal under test comes before the venue is touched. */
function create(config: unknown): ReturnType<typeof createPaperTrader> {
  return createPaperTrader({
    env: paperEnvironment(),
    config,
    clock: new ManualClock("2026-10-08T00:00:00.000Z"),
    venue: {} as never,
    store: new MemoryTraderStore(),
    idNamespace: "c1-risk-retired-caps",
  });
}

describe("C1-RISK: the retired risk-side exposure caps", () => {
  it("the shipped example states its caps in allocatorCaps only, and both doors accept it", () => {
    const document = example();
    const limits = (document["riskPolicy"] as Record<string, unknown>)["limits"] as Record<string, unknown>;
    expect(Object.keys(limits).sort()).toEqual(["maxOrderNotional", "maxWorstCaseContractualLoss"]);
    expect(parseRiskPolicy(document["riskPolicy"]).ok).toBe(true);
    const caps = parseAllocatorCaps(document["allocatorCaps"]);
    expect(caps.ok).toBe(true);
    if (!caps.ok) return;
    expect(caps.value.globalAccountCap).toBe("500");
    expect(caps.value.perStrategyCap).toBe("100");
    expect(caps.value.perMarketCap).toBe("100");
  });

  it("an old document that still states one is REFUSED at startup, and the refusal names its allocatorCaps field", () => {
    const pairs = [
      ["globalExposureCap", "globalAccountCap"],
      ["perInstanceExposureCap", "perStrategyCap"],
      ["perMarketExposureCap", "perMarketCap"],
      ["perSeriesExposureCap", "perSeriesCap"],
      ["perUnderlyingExposureCap", "perUnderlyingCap"],
      ["perResolutionWindowExposureCap", "perResolutionWindowCap"],
    ] as const;
    for (const [retired, allocatorField] of pairs) {
      const document = example();
      const policy = document["riskPolicy"] as Record<string, unknown>;
      document["riskPolicy"] = {
        ...policy,
        limits: { ...(policy["limits"] as Record<string, unknown>), [retired]: "100" },
      };
      const result = create(document);
      expect(result.ok, retired).toBe(false);
      if (result.ok) continue;
      expect(result.refusal.code).toBe("TRADER_RISK_POLICY_REFUSED");
      // The hint, first, naming where the cap went …
      expect(result.refusal.issues[0]).toBe(
        `riskPolicy.limits.${retired} is retired: the capital allocator is the only exposure-cap ` +
          `authority (C1-RISK, 2026-10-08), so state this cap as allocatorCaps.${allocatorField} ` +
          `and delete it from riskPolicy.limits`,
      );
      // … and packages/risk's own strict refusal, unchanged.
      expect(result.refusal.issues).toContain(`limits: Unrecognized key: "${retired}"`);
    }
  });

  it("an unrelated policy refusal carries no allocatorCaps hint", () => {
    const document = example();
    document["riskPolicy"] = { ...(document["riskPolicy"] as Record<string, unknown>), limits: {} };
    const result = create(document);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe("TRADER_RISK_POLICY_REFUSED");
    expect(result.refusal.issues.join("\n")).not.toContain("allocatorCaps");
  });
});
