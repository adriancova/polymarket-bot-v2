/**
 * `BURNIN-PREP`: the two shipped SERIES examples (a PAPER burn-in on the
 * rolling `btc-15m-updown` series) are valid through each process's own door
 * and name the same review, so an operator who copies both gets a pair that
 * boots. Read as ordinary JSON; the doors are the processes' own.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseGatewayConfig } from "../../../apps/data-gateway/src/config.js";
import { readSeriesTemplate } from "../../../apps/trader/src/register/template.js";
import { parseTraderConfig } from "../../../packages/trading-core/src/config.js";
import { parseReviewedSeries } from "../../../packages/universe/src/index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function readJson(relative: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(repoRoot, relative), "utf8")) as Record<string, unknown>;
}

const TRADER_PATH = "infra/compose/trader/trader.series.example.json";
const GATEWAY_PATH = "infra/compose/data-gateway/gateway.series.example.json";

function reviewedOf(document: unknown): { readonly configHash: string; readonly accepted: readonly string[]; readonly seriesId: string } {
  const parsed = parseReviewedSeries(document);
  if (!parsed.ok) throw new Error(`not a reviewed series: ${parsed.issues.join("; ")}`);
  return { configHash: parsed.configHash, accepted: parsed.series.parameters.acceptedProtocolVersions, seriesId: parsed.series.seriesId };
}

describe("the series burn-in examples (infra/compose)", () => {
  const traderJson = readJson(TRADER_PATH);
  const gatewayJson = readJson(GATEWAY_PATH);

  it("each passes its own door", () => {
    const trader = parseTraderConfig(traderJson);
    if (!trader.ok) throw new Error(`${trader.refusal.detail}: ${trader.refusal.issues.join("; ")}`);
    expect(trader.config.environment).toBe("PAPER");
    expect(trader.config.instances).toEqual([]);
    expect(() => parseGatewayConfig(gatewayJson)).not.toThrow();
  });

  it("name the same series with the same review, accepting both protocol versions", () => {
    const trader = reviewedOf((traderJson["series"] as unknown[])[0]);
    const gateway = reviewedOf(((gatewayJson["seriesAdmission"] as { series: unknown[] }).series)[0]);
    expect(trader.configHash).toBe(gateway.configHash);
    expect(trader.seriesId).toBe("btc-15m-updown");
    expect([...trader.accepted]).toEqual(["v1", "v2"]);
    const bound = (traderJson["seriesInstances"] as { seriesId: string }[]).map((instance) => instance.seriesId);
    expect(bound).toEqual([trader.seriesId]);
    expect((gatewayJson["polymarket"] as { feedId: string }).feedId).toBe("polymarket-market");
  });

  it("both reviews assert modelDependentActivationAllowed (PAPER-only), so the risk engine does not refuse every entry", () => {
    const flag = (document: unknown): unknown =>
      ((document as { settlement: { modelDependentActivationAllowed: unknown } }).settlement).modelDependentActivationAllowed;
    expect(flag((traderJson["series"] as unknown[])[0])).toBe(true);
    expect(flag(((gatewayJson["seriesAdmission"] as { series: unknown[] }).series)[0])).toBe(true);
  });

  it("the trader example, with its instance ids removed, passes register --series (readSeriesTemplate)", () => {
    const template = structuredClone(traderJson) as { seriesInstances: Record<string, unknown>[] };
    for (const key of ["instanceId", "runId", "configId"]) delete template.seriesInstances[0]?.[key];
    const safeEnv = {
      MAX_RUN_MODE: "PAPER",
      RUN_MODE: "PAPER",
      ALLOW_REAL_ORDERS: "false",
      LIVE_MICRO_MAX_ORDER_NOTIONAL: "0",
      LIVE_MICRO_MAX_ACCOUNT_EXPOSURE: "0",
    };
    const read = readSeriesTemplate(JSON.stringify(template), safeEnv, () => Date.UTC(2026, 9, 9));
    expect(read.ok ? "ok" : read.refusal).toBe("ok");
  });

  it("the entry is GTD with an explicit order_validity_ms", () => {
    const instance = (traderJson["seriesInstances"] as { params: { entry: { execution: Record<string, unknown> } } }[])[0];
    const execution = instance?.params.entry.execution;
    expect(execution?.["immediate_order_type"]).toBe("GTD");
    expect(typeof execution?.["order_validity_ms"]).toBe("number");
  });

  it("carries no retired field", () => {
    const limits = (traderJson["riskPolicy"] as { limits: Record<string, unknown> }).limits;
    expect(Object.keys(limits).filter((key) => key.endsWith("ExposureCap"))).toEqual([]);
    expect(Object.hasOwn(traderJson["simulation"] as object, "startingCash")).toBe(false);
    expect(Object.hasOwn(traderJson["accounting"] as object, "startingCash")).toBe(true);
    expect(Object.hasOwn(traderJson, "allocatorCaps")).toBe(true);
  });
});
