/**
 * `ROLLOVER-1` (ADR-030 Decision 4.2; the user's ruling Q4): BOOT-1 pins a
 * series-bound instance's REVIEWED SERIES through its registered config.
 *
 * `registeredParametersOf` names the document `strategy.configs.parameters`
 * must hold — `{ strategy, series }` for a series-bound instance, the bare
 * params for a market-bound one — and `compareRegisteredParameters`
 * (unchanged) names every field where the registered row and that document
 * disagree, so a changed review refuses the run by the field's name.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseTraderConfig, type TraderConfig } from "@polymarket-bot/trading-core";
import { reviewedSeriesDocument } from "@polymarket-bot/trading-core/testing";
import { describe, expect, it } from "vitest";

import { admissionLine } from "../main.js";
import { canonicalSeriesParameters } from "../register/template.js";
import { compareRegisteredParameters, registeredParametersOf } from "./postgres-registration.js";

const SERIES_INSTANCE_ID = "b18f4a7e-5555-7abc-8def-0123456789ab";

function config(series: Record<string, unknown> = reviewedSeriesDocument()): TraderConfig {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
  const example = JSON.parse(
    readFileSync(path.join(repoRoot, "infra/compose/trader/trader.config.example.json"), "utf8"),
  ) as Record<string, unknown> & { instances: Record<string, unknown>[] };
  const instance = example.instances[0] ?? {};
  const rest = Object.fromEntries(Object.entries(instance).filter(([key]) => key !== "marketId"));
  const parsed = parseTraderConfig({
    ...example,
    series: [series],
    seriesInstances: [
      {
        ...rest,
        instanceId: SERIES_INSTANCE_ID,
        runId: "018f4a7e-6666-7abc-8def-0123456789ab",
        configId: "018f4a7e-7777-7abc-8def-0123456789ab",
        seriesId: "btc-15m-updown",
        evaluationPriority: 1,
      },
    ],
  });
  if (!parsed.ok) throw new Error(`${parsed.refusal.detail}: ${parsed.refusal.issues.join("; ")}`);
  return parsed.config;
}

/** What REGISTER-1 `--series` stores in `strategy.configs.parameters`, read back as JSON. */
function registeredRow(document: TraderConfig): unknown {
  const instance = document.seriesInstances?.[0];
  const series = document.series?.[0];
  const rendered = canonicalSeriesParameters(instance?.params, series);
  if (!rendered.ok) throw new Error(rendered.problems.join("; "));
  return JSON.parse(rendered.text) as unknown;
}

describe("registeredParametersOf — the run record's pin of the series (ruling Q4)", () => {
  it("a series-bound instance's document is { strategy, series }; a market-bound one's, its bare params", () => {
    const document = config();
    const pinned = registeredParametersOf(document, SERIES_INSTANCE_ID) as { strategy: unknown; series: unknown };
    expect(Object.keys(pinned)).toEqual(["strategy", "series"]);
    expect(pinned.strategy).toBe(document.seriesInstances?.[0]?.params);
    expect(pinned.series).toBe(document.series?.[0]);
    const marketBound = document.instances[0];
    expect(registeredParametersOf(document, marketBound?.instanceId ?? "")).toBe(marketBound?.params);
    expect(registeredParametersOf(document, "018f4a7e-0000-7abc-8def-0123456789ab")).toBeUndefined();
  });

  it("the row REGISTER-1 --series writes agrees with the configuration, field for field", () => {
    const document = config();
    expect(compareRegisteredParameters(registeredRow(document), registeredParametersOf(document, SERIES_INSTANCE_ID))).toEqual([]);
  });

  it("a changed review refuses the run BY NAME: the registered row pinned another series document", () => {
    const registered = registeredRow(config());
    const changed = config({ ...reviewedSeriesDocument(), maximumConcurrentWindows: 3 });
    const differences = compareRegisteredParameters(registered, registeredParametersOf(changed, SERIES_INSTANCE_ID));
    expect(differences).toEqual([expect.stringMatching(/^\/series\/maximumConcurrentWindows: /u)]);
    const parameters = reviewedSeriesDocument()["parameters"] as Record<string, unknown>;
    const fee = config({ ...reviewedSeriesDocument(), parameters: { ...parameters, minimumOrderSize: "10" } });
    expect(compareRegisteredParameters(registered, registeredParametersOf(fee, SERIES_INSTANCE_ID))).toEqual([
      expect.stringMatching(/^\/series\/parameters\/minimumOrderSize: /u),
    ]);
  });

  it("a row registered with the bare params (no series pinned) is refused for a series-bound instance", () => {
    const document = config();
    const differences = compareRegisteredParameters(
      JSON.parse(JSON.stringify(document.seriesInstances?.[0]?.params)) as unknown,
      registeredParametersOf(document, SERIES_INSTANCE_ID),
    );
    expect(differences.some((line) => line.startsWith("/series: "))).toBe(true);
    expect(differences.some((line) => line.startsWith("/strategy: "))).toBe(true);
  });
});

describe("admissionLine — one operator line per admission notice", () => {
  it("names the window, the refusal code, or the teardown reason", () => {
    expect(admissionLine({ kind: "REFUSED", code: "CAP_REACHED", detail: "two live", marketId: undefined })).toBe(
      "[admission] REFUSED CAP_REACHED window (unidentified): two live",
    );
  });
});
