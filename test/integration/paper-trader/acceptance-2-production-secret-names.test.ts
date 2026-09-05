/**
 * `WP-230` ACCEPTANCE CRITERION 2: **production secret names are rejected.**
 *
 * §15: "A paper environment cannot reference production secret names." The
 * names are not this suite's invention and are not the trader's either —
 * ADR-010 §3 enumerates them from `docs/venue/verified-2026-08-24.md` §16, with
 * a per-name official source, and splits them three ways. This suite asserts
 * the whole split:
 *
 * - **§16.1 secret material** → `PAPER_PRODUCTION_SECRET_NAME_PRESENT`;
 * - **§16.2 account-identifying, not secret** → its own code, per ADR-010 §3
 *   rule 1 ("a paper process referencing a real one identifies a real
 *   account");
 * - **§16.3 public builder attribution** → its own code, per ADR-010 §3 rule 2,
 *   which forbids DESCRIBING it as a credential while still refusing it.
 *
 * Two properties beyond the list itself, both load-bearing:
 *
 * 1. **the NAME is the violation, not the value.** §15 says "cannot reference
 *    production secret names", so an exported-but-EMPTY `POLYMARKET_PRIVATE_KEY`
 *    refuses too — that deployment is one edit away from exporting the real one;
 * 2. **no value is ever printed.** A refusal that echoed the secret would defeat
 *    §15's own redaction rule, so every detail is checked to contain the name
 *    and not the value.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  BUILDER_ATTRIBUTION_NAMES,
  PRODUCTION_ACCOUNT_NAMES,
  PRODUCTION_SECRET_NAMES,
  checkPaperTraderSafety,
} from "@polymarket-bot/trader";

import { assemble, safeEnvironment } from "./support/fixture.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SECRET_VALUE = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

function withEnv(overrides: Record<string, string | undefined>): Record<string, string | undefined> {
  return { ...safeEnvironment(), ...overrides };
}

/**
 * The names ADR-010 §3 enumerates, read from the ADR ITSELF.
 *
 * Derived rather than retyped, on the `WP-210` partition precedent: a list a
 * test author copied is a list that drifts, while one read from the authority
 * fails loudly when either side moves. ADR-010 §3 carries the three categories
 * in one table row each, so the names are extracted from those rows.
 */
function adrNames(category: string): readonly string[] {
  const text = readFileSync(
    resolve(REPO_ROOT, "docs/adr/ADR-010-run-mode-enablement-and-production-key-boundary.md"),
    "utf8",
  );
  const row = text
    .split("\n")
    .find((line) => line.includes(category) && line.includes("`"));
  if (row === undefined) throw new Error(`ADR-010 §3 has no row for ${category}`);
  return [...row.matchAll(/`([A-Z][A-Z0-9_]+)`/gu)].map((match) => match[1] ?? "");
}

describe("acceptance 2 — production secret names are rejected", () => {
  it("the deny-lists ARE ADR-010 §3's lists, read from the ADR", () => {
    expect([...PRODUCTION_SECRET_NAMES].sort()).toEqual([...adrNames("Secret material")].sort());
    expect([...PRODUCTION_ACCOUNT_NAMES].sort()).toEqual(
      [...adrNames("Account-identifying, not secret")].sort(),
    );
    expect([...BUILDER_ATTRIBUTION_NAMES].sort()).toEqual(
      [...adrNames("Public builder attribution")].sort(),
    );
  });

  it.each([...PRODUCTION_SECRET_NAMES])(
    "REFUSES STARTUP when %s is present (§16.1 secret material)",
    (name) => {
      const { result } = assemble({ env: withEnv({ [name]: SECRET_VALUE }) });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.refusal.code).toBe("TRADER_UNSAFE_ENVIRONMENT");
      expect(result.refusal.issues.join("\n")).toContain(
        "PAPER_PRODUCTION_SECRET_NAME_PRESENT",
      );
    },
  );

  it.each([...PRODUCTION_ACCOUNT_NAMES])(
    "REFUSES STARTUP when %s is present (§16.2 account-identifying)",
    (name) => {
      const outcome = checkPaperTraderSafety(withEnv({ [name]: "0xwallet" }));
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.violations.map((violation) => violation.code)).toContain(
        "PAPER_PRODUCTION_ACCOUNT_NAME_PRESENT",
      );
    },
  );

  it("REFUSES POLYMARKET_BUILDER_CODE under its own code — and never calls it a credential", () => {
    const outcome = checkPaperTraderSafety(withEnv({ POLYMARKET_BUILDER_CODE: "builder-7" }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    const violation = outcome.violations.find(
      (candidate) => candidate.code === "PAPER_BUILDER_ATTRIBUTION_PRESENT",
    );
    expect(violation).toBeDefined();
    // ADR-010 §3 rule 2: "must not be described as a credential".
    expect(violation?.detail).toContain("not a credential");
  });

  it("the NAME is the violation: an EMPTY production secret name still refuses", () => {
    const outcome = checkPaperTraderSafety(withEnv({ POLYMARKET_PRIVATE_KEY: "" }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.violations.map((violation) => violation.code)).toContain(
      "PAPER_PRODUCTION_SECRET_NAME_PRESENT",
    );
  });

  it("a deployment PREFIX does not evade the check", () => {
    const outcome = checkPaperTraderSafety(
      withEnv({ PROD_EU_POLYMARKET_PRIVATE_KEY: SECRET_VALUE }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.violations.map((violation) => violation.code)).toContain(
      "PAPER_PRODUCTION_SECRET_NAME_PRESENT",
    );
  });

  it("catches a credential-SHAPED name the enumerations do not carry", () => {
    const outcome = checkPaperTraderSafety(withEnv({ ACME_SIGNING_KEY: SECRET_VALUE }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.violations.map((violation) => violation.code)).toContain(
      "PAPER_CREDENTIAL_SHAPED_NAME_PRESENT",
    );
  });

  it("NEVER prints a value — §15's redaction rule applies to the refusal itself", () => {
    const outcome = checkPaperTraderSafety(
      withEnv({ POLYMARKET_PRIVATE_KEY: SECRET_VALUE, POLY_API_KEY: "live-key-42" }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    const printed = JSON.stringify(outcome.violations);
    expect(printed).toContain("POLYMARKET_PRIVATE_KEY");
    expect(printed).not.toContain(SECRET_VALUE);
    expect(printed).not.toContain("live-key-42");
  });

  it("reports EVERY violation, so one start shows the whole list", () => {
    const outcome = checkPaperTraderSafety(
      withEnv({
        POLYMARKET_PRIVATE_KEY: SECRET_VALUE,
        POLYMARKET_WALLET_ADDRESS: "0xabc",
        POLYMARKET_BUILDER_CODE: "builder-7",
      }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    const codes = new Set(outcome.violations.map((violation) => violation.code));
    expect(codes).toContain("PAPER_PRODUCTION_SECRET_NAME_PRESENT");
    expect(codes).toContain("PAPER_PRODUCTION_ACCOUNT_NAME_PRESENT");
    expect(codes).toContain("PAPER_BUILDER_ATTRIBUTION_PRESENT");
  });

  it("the safe fixture environment references none of them", () => {
    expect(checkPaperTraderSafety(safeEnvironment()).ok).toBe(true);
  });
});
