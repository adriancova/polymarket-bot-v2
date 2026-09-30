/**
 * Contract: every venue fact `packages/inventory/src/venue-facts.ts` encodes
 * is present, verbatim, in the dated verification reports it cites. If a later
 * report changes an address or a fact, this suite is where the drift shows.
 * Offline: reads repository files only.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  APPROVAL_SPENDER_ROLES,
  DOCUMENTED_VENUE_CONTRACTS,
  PUSD_DECIMALS,
  VENUE_FACTS_SOURCE,
} from "../../../packages/inventory/src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const report = readFileSync(resolve(repo, VENUE_FACTS_SOURCE.report), "utf8");
const baseline = readFileSync(resolve(repo, VENUE_FACTS_SOURCE.baseline), "utf8");
/** The report with line wrapping collapsed, for quoted-sentence checks. */
const reportText = report.replace(/\s+/g, " ");
const baselineText = baseline.replace(/\s+/g, " ");

describe("documented venue contracts", () => {
  it("each address appears verbatim in the 2026-09-30 report or its 2026-09-16 baseline", () => {
    for (const contract of DOCUMENTED_VENUE_CONTRACTS) {
      expect(report.includes(contract.address) || baseline.includes(contract.address), contract.role).toBe(true);
    }
  });

  it("the phase-3 report itself re-confirms the exchange, onramp, offramp and pUSD addresses (§W.8)", () => {
    const w8 = report.slice(report.indexOf("### W.8"), report.indexOf("### W.9"));
    for (const role of ["CTF_EXCHANGE", "NEG_RISK_CTF_EXCHANGE", "COLLATERAL_ONRAMP", "COLLATERAL_OFFRAMP", "PUSD_COLLATERAL_TOKEN"]) {
      const contract = DOCUMENTED_VENUE_CONTRACTS.find((c) => c.role === role);
      expect(contract, role).toBeDefined();
      expect(w8.includes(contract?.address ?? "<none>"), role).toBe(true);
    }
  });

  it("addresses are unique and approval spenders exclude the token contracts", () => {
    const lower = DOCUMENTED_VENUE_CONTRACTS.map((c) => c.address.toLowerCase());
    expect(new Set(lower).size).toBe(lower.length);
    for (const role of ["PUSD_COLLATERAL_TOKEN", "USDC_E", "CONDITIONAL_TOKENS"] as const) {
      expect(APPROVAL_SPENDER_ROLES).not.toContain(role);
    }
  });
});

describe("documented facts", () => {
  it("pUSD decimals are 6 (S-D35, quoted in the baseline's D-15)", () => {
    expect(PUSD_DECIMALS).toBe(6);
    expect(baselineText).toContain("`Decimals 6`");
  });

  it("the wrap input is USDC.e only", () => {
    expect(baselineText).toContain('`_asset` "Must be USDC.e."');
  });

  it("the approval → CLOB allowance sync → trading order is documented (S-D48)", () => {
    expect(reportText).toContain("GET /balance-allowance/update");
    expect(reportText).toContain("Refresh the conditional-token allowance for each token before its first sell order.");
  });

  it("U-10 (cancellation/void payout) is still undocumented, so the CANCELLED redeem refusal stands", () => {
    expect(report).toMatch(/\*\*U-10\*\* \| Cancellation\/void payout \| \*\*Still undocumented\*\*/);
  });

  it("split/merge/redeem is UNCHANGED at the phase-3 gate", () => {
    expect(report).toContain("### 10.2 Split / merge / redeem — verdict **UNCHANGED**");
  });
});
