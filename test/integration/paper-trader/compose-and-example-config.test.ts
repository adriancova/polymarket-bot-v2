/**
 * `infra/compose/trader/**` — the paper-only local-operation wiring.
 *
 * Two claims, both checkable without Docker (which is absent from this
 * environment; see the suite's disclosure in `README.md`):
 *
 * 1. **the shipped example configuration is a REAL configuration** — it parses
 *    through the trader's own door, which is the only definition of "valid"
 *    this repository has. An example that did not parse would be a document an
 *    operator copies and then debugs;
 * 2. **the compose fragment is paper-only** — no production secret name, no
 *    live venue endpoint, no signer, and every published port bound to
 *    loopback (§15: "No public network exposure for PostgreSQL, Redis, or
 *    internal metrics endpoints").
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  BUILDER_ATTRIBUTION_NAMES,
  PRODUCTION_ACCOUNT_NAMES,
  PRODUCTION_SECRET_NAMES,
  parseTraderConfig,
} from "@polymarket-bot/trader";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const COMPOSE = resolve(REPO_ROOT, "infra/compose/trader/compose.yaml");
const EXAMPLE = resolve(REPO_ROOT, "infra/compose/trader/trader.config.example.json");

describe("infra/compose/trader — the example configuration", () => {
  it("PARSES through the trader's own door", () => {
    const document = JSON.parse(readFileSync(EXAMPLE, "utf8")) as unknown;
    const parsed = parseTraderConfig(document);
    expect(
      parsed.ok,
      parsed.ok ? "" : `${parsed.refusal.detail}\n${parsed.refusal.issues.join("\n")}`,
    ).toBe(true);
  });

  it("is PAPER, with both live-micro caps at the fenced zero", () => {
    const document = JSON.parse(readFileSync(EXAMPLE, "utf8")) as Record<string, unknown>;
    expect(document["environment"]).toBe("PAPER");
    const caps = document["allocatorCaps"] as Record<string, unknown>;
    expect(caps["liveMicroMaxOrderNotional"]).toBe("0");
    expect(caps["liveMicroMaxAccountExposure"]).toBe("0");
  });

  it("states settlement readiness as TRUE for btc-15m-updown — the owner's PAPER-only operator assertion (TRADER-SIGNALS), not a review", () => {
    // Changed on purpose by `TRADER-SIGNALS` (2026-10-05). This test used to
    // pin `false`: the series has no recorded settlement review, so §9.8
    // check 6 refused every entry, and no paper fill was possible. The owner
    // then ruled that PAPER configurations may set `true` for this series
    // (`docs/settlement/btc-15m-updown-review-checklist.md`). That is an
    // operator assertion, not a recorded review: the spec stays `UNVERIFIED`
    // and gaps G-1 to G-10 still prevent recording one. So this pins the new
    // value for the one series the ruling names, and the next test pins that
    // the example is PAPER whenever the flag is true.
    const document = JSON.parse(readFileSync(EXAMPLE, "utf8")) as Record<string, unknown>;
    const markets = document["markets"] as Record<string, unknown>[];
    expect(markets.length).toBeGreaterThan(0);
    for (const market of markets) {
      expect(market["seriesKey"]).toBe("btc-15m-updown");
      const readiness = market["settlementReadiness"] as Record<string, unknown>;
      expect(readiness["modelDependentActivationAllowed"]).toBe(true);
    }
  });

  it("sets modelDependentActivationAllowed TRUE only in a PAPER document (the ruling is PAPER-only; a live configuration must not copy it)", () => {
    const document = JSON.parse(readFileSync(EXAMPLE, "utf8")) as Record<string, unknown>;
    const markets = document["markets"] as Record<string, unknown>[];
    const assertsReadiness = markets.some(
      (market) => (market["settlementReadiness"] as Record<string, unknown>)["modelDependentActivationAllowed"] === true,
    );
    expect(assertsReadiness).toBe(true);
    if (assertsReadiness) expect(document["environment"]).toBe("PAPER");
    // And the READMEs an operator reads say what the value is and is not.
    for (const readme of ["infra/compose/trader/README.md", "apps/trader/README.md"]) {
      const text = readFileSync(resolve(REPO_ROOT, readme), "utf8");
      expect(text, readme).toContain("PAPER-only operator assertion");
      expect(text, readme).toContain("not a recorded settlement review");
      expect(text, readme).toContain("A live configuration must not copy it");
      expect(text, readme).toContain("G-1 to G-10");
      expect(text, readme).toContain("docs/settlement/btc-15m-updown-review-checklist.md");
    }
  });

  it("carries NO production secret name anywhere in the document", () => {
    const text = readFileSync(EXAMPLE, "utf8").toUpperCase();
    for (const name of [
      ...PRODUCTION_SECRET_NAMES,
      ...PRODUCTION_ACCOUNT_NAMES,
      ...BUILDER_ATTRIBUTION_NAMES,
    ]) {
      expect(text, name).not.toContain(name);
    }
  });
});

describe("infra/compose/trader — the compose fragment", () => {
  const compose = readFileSync(COMPOSE, "utf8");

  it("publishes every port on LOOPBACK only (§15: no public network exposure)", () => {
    const published = [...compose.matchAll(/^\s*-\s*"([^"]+:\d+)"/gmu)].map(
      (match) => match[1] ?? "",
    );
    expect(published.length).toBeGreaterThan(0);
    for (const mapping of published) {
      expect(mapping, mapping).toMatch(/^127\.0\.0\.1:/u);
    }
  });

  it("declares BOTH §4.2 boundaries and NO other service", () => {
    // Services are the top-level keys under `services:`; the check reads THOSE
    // rather than the whole file, because the file's comments legitimately use
    // the words "signer" and "live" to say the process has neither.
    const servicesBlock = compose.slice(
      compose.indexOf("\nservices:"),
      compose.indexOf("\nvolumes:"),
    );
    const services = [...servicesBlock.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gmu)].map(
      (match) => match[1] ?? "",
    );
    expect(services.sort()).toEqual(["postgres", "redis"]);

    // No venue endpoint anywhere: the trader has no live execution path and the
    // fragment must not imply one. `image:` and `command:` lines are where an
    // endpoint would appear.
    const directives = compose
      .split("\n")
      .filter((line) => /^\s*(image|command|environment|entrypoint):/u.test(line))
      .join("\n")
      .toLowerCase();
    expect(directives).not.toContain("polymarket");
    expect(directives).not.toContain("clob");
    expect(directives).not.toContain("signer");
    expect(directives).not.toContain("https://");
  });

  it("carries NO production secret name", () => {
    const upper = compose.toUpperCase();
    for (const name of [
      ...PRODUCTION_SECRET_NAMES,
      ...PRODUCTION_ACCOUNT_NAMES,
      ...BUILDER_ATTRIBUTION_NAMES,
    ]) {
      expect(upper, name).not.toContain(name);
    }
  });

  it("states the four AGENTS.md defaults where an operator will read them", () => {
    const readme = readFileSync(
      resolve(REPO_ROOT, "infra/compose/trader/README.md"),
      "utf8",
    );
    for (const line of [
      "MAX_RUN_MODE=PAPER",
      "ALLOW_REAL_ORDERS=false",
      "LIVE_MICRO_MAX_ORDER_NOTIONAL=0",
      "LIVE_MICRO_MAX_ACCOUNT_EXPOSURE=0",
    ]) {
      expect(readme, line).toContain(line);
    }
  });
});
