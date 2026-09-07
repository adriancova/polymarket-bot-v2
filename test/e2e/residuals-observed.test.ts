/**
 * The KNOWN RESIDUALS, OBSERVED.
 *
 * `WP-250`'s packet names four residuals the suite must observe and must not
 * fight. Nothing in this file weakens a policy, re-tags an intent, bypasses a
 * door or works around a refusal. Each test pins the residual's OBSERVABLE
 * CONSEQUENCE so that the day it is fixed, this file fails and says which
 * residual moved.
 *
 * THAT HAPPENED. Residual 1 is RESOLVED, and this file is how it was noticed:
 * the row that pinned the startup refusal failed on the very commit that
 * relaxed the door, naming the residual that moved. Its two rows below now pin
 * the RESOLUTION — the mechanism is unchanged, only its subject is.
 *
 * | Residual | Owner of the fix | Observed here as |
 * | --- | --- | --- |
 * | `strategyInstanceId` must satisfy two conflicting doors — **RESOLVED 2026-09-06** (ADR-021: risk `8c14b47`, allocator `d9f70a6`, trader `TRDR-1`) | the contract owner — ruled and executed | a minted `0`-leading UUIDv7 now STARTS, the letter-leading one still does, and the startup refusal that replaced the conflict names the field without the conflict text |
 * | a protective reduction is typed `ENTRY` at the risk seam | the risk-side follow-up (`WP-220` accepted residual) | `risk.refusedExits` / `refusedExitsByCode`, and the strategy state that follows from it |
 * | `SHADOW` is observe-only in this process | a design, not a setting (ADR-011 §5) | `execution.observeOnlyIntents`, with the shadow instance's decisions still persisted |
 * | the interim §9.8 operator inputs are required and undefaulted | `packages/universe` + `packages/settlement` wiring | each omission is a startup refusal naming the field |
 *
 * ## What this file does NOT claim
 *
 * The `SHARED_BOOK_ACCOUNTING_MODE = "LIVE"` backstop is `loop.ts`-private and
 * is not exported, so this suite cannot import it and does not pretend to
 * assert it. What it CAN observe — and does — is the primary remedy: a `SHADOW`
 * instance's intents are never routed. The backstop is the second layer behind
 * that one, and the verification report records it as read, not as executed.
 */

import { describe, expect, it } from "vitest";

import { RISK_SEAM_CAVEAT } from "@polymarket-bot/trader";

import { assemble, driveScenario } from "./support/harness.js";
import {
  INSTANCE_ID,
  SHADOW_INSTANCE_ID,
  paperEnvironment,
  traderConfig,
} from "./support/scenario.js";

/** Deep-copies the scenario document so a mutation cannot leak between tests. */
function document(options: { readonly withShadow?: boolean } = {}): Record<string, unknown> {
  return JSON.parse(JSON.stringify(traderConfig(options))) as Record<string, unknown>;
}

function refusalOf(config: Record<string, unknown>): { code: string; issues: string } {
  const { result } = assemble({ config, env: paperEnvironment() });
  if (result.ok) throw new Error("the composition root accepted a configuration it should refuse");
  return {
    code: result.refusal.code,
    issues: [result.refusal.detail, ...result.refusal.issues].join("\n"),
  };
}

/**
 * Residual 1, RESOLVED — the rows now pin the resolution.
 *
 * ADR-021 ruled `strategyInstanceId` an IDENTITY and `CodeStringSchema` the
 * mis-typing; `packages/risk` (`8c14b47`) and `packages/capital-allocator`
 * (`d9f70a6`) were re-typed, and `TRDR-1` then deleted `apps/trader`'s interim
 * intersection grammar in favour of `packages/domain`'s `Uuidv7Schema`. Two
 * rows, as before: the scenario's own id still starts (compatibility), and the
 * id that used to be refused now starts while a genuinely malformed one does
 * not (the resolution, and the refusal that replaced the conflict).
 */
describe("residual 1 — the strategyInstanceId contract conflict, RESOLVED", () => {
  it("the letter-leading UUIDv7 this scenario was written around STILL works", async () => {
    const run = await driveScenario();
    // Not because a letter lead is required — it no longer is — but because
    // ADR-021's Consequences promise that "existing letter-leading UUIDv7
    // configurations remain valid". This scenario IS one of them, so the row
    // is a compatibility statement and the regex is what makes it non-vacuous.
    expect(INSTANCE_ID).toMatch(/^[a-f][0-9a-f]{7}-[0-9a-f]{4}-7/u);
    expect(run.trader.manifest.map((row) => row.instanceId)).toContain(INSTANCE_ID);
  });

  it("a timestamp-shaped UUIDv7 now STARTS, and a wrong-version one is refused instead", () => {
    const started = document();
    const startedInstances = started["instances"] as Record<string, unknown>[];
    const startedInstance = startedInstances[0];
    if (startedInstance === undefined) throw new Error("the scenario lost its instance");
    // A real UUIDv7 minted from a 2026 timestamp begins with '0'. This exact
    // document was refused at startup until TRDR-1; it is the population every
    // honest generator produces, and the composition root now accepts it.
    startedInstance["instanceId"] = "018f5c20-2000-7a20-8b00-000000000002";
    const { result } = assemble({ config: started, env: paperEnvironment() });
    expect(result.ok).toBe(true);

    // The relaxation is not a widening only. The interim grammar was version-
    // and variant-BLIND, so this v4 — letter lead, canonical shape — used to
    // pass STARTUP and be refused mid-run by the risk door. It is refused here
    // now, and the refusal no longer narrates a conflict that is resolved.
    const refused = document();
    const refusedInstances = refused["instances"] as Record<string, unknown>[];
    const refusedInstance = refusedInstances[0];
    if (refusedInstance === undefined) throw new Error("the scenario lost its instance");
    refusedInstance["instanceId"] = "e18f5c20-2000-4a20-8b00-000000000002";
    const refusal = refusalOf(refused);
    expect(refusal.code).toBe("TRADER_CONFIG_REFUSED");
    expect(refusal.issues).toContain("instanceId");
    expect(refusal.issues).toContain("UUIDv7");
    expect(refusal.issues).not.toContain("CodeStringSchema");
    expect(refusal.issues).not.toContain("cross-package conflict");
  });
});

describe("residual 2 — a protective reduction is typed ENTRY at the risk seam", () => {
  it("the refusal is COUNTED, by code, on the health surface", async () => {
    const run = await driveScenario();
    const health = run.trader.loop.health();
    expect(health.risk.refusedExits).toBe(1);
    expect(health.risk.refusedExitsByCode).toEqual({ RISK_EDGE_INPUTS_MISSING: 1 });
    // The refused-exit count is a SUBSET of the total refusal count, per code.
    for (const [code, count] of Object.entries(health.risk.refusedExitsByCode)) {
      expect(health.risk.refusalsByCode[code] ?? 0).toBeGreaterThanOrEqual(count);
    }
    expect(health.risk.refusals).toBeGreaterThanOrEqual(health.risk.refusedExits);
  });

  it("the caveat travels with the snapshot, and is the trader's own constant", async () => {
    const run = await driveScenario();
    // Pinned BY IDENTITY against the exported constant, not by copying its
    // text: a wording improvement upstream must not read as a failure here.
    expect(run.trader.loop.health().riskSeamCaveat).toBe(RISK_SEAM_CAVEAT);
    expect(RISK_SEAM_CAVEAT).toContain("WP-220 accepted residual");
  });

  it("fail-closed: a refused exit is a refused exit, never a re-tagged order", async () => {
    const run = await driveScenario();
    const health = run.trader.loop.health();
    // ONE plan, ONE submission, TWO fills — all of them the ENTRY. Nothing was
    // planned or submitted for the refused take-profit.
    expect(health.execution.plansBuilt).toBe(1);
    expect(health.execution.submissionsAccepted).toBe(1);
    expect(run.orders).toHaveLength(1);
    expect(run.orders[0]?.action).toBe("BUY");
    expect(run.fills.every((fill) => fill.action === "BUY")).toBe(true);
  });

  it("the CONSEQUENCE is visible too: the instance ends holding what it cannot exit", async () => {
    const run = await driveScenario();
    const decisions = run.trader.loop.decisions();
    // The strategy emitted its take-profit, the seam refused it, and the
    // strategy's own state machine then waits for a cancel confirmation that no
    // order will ever produce. That is the residual's blast radius, and it is
    // recorded rather than papered over.
    expect(decisions.some((decision) => decision.decisionType === "exit")).toBe(true);
    const last = decisions.at(-1);
    expect(last?.decisionType).toBe("hold");
    expect(
      decisions.some((decision) =>
        decision.reasonCodes.includes("SB.AWAITING_CANCEL_CONFIRMATION"),
      ),
    ).toBe(true);
    // The position is still open at the end of the run.
    expect(run.trader.loop.costBasisOf(INSTANCE_ID, run.trader.config.markets[0]?.marketId ?? "", "YES")).not.toBe("0");
  });
});

describe("residual 3 — SHADOW ownership is observe-only in this process", () => {
  it("a SHADOW instance's intents are COUNTED and never routed", async () => {
    const run = await driveScenario({ config: traderConfig({ withShadow: true }) });
    const health = run.trader.loop.health();
    expect(health.execution.observeOnlyIntents).toBeGreaterThan(0);
    // The shadow instance's DECISIONS are still persisted — ADR-011 §5:
    // shadow instances "evaluate, produce decisions, and write records".
    const shadowDecisions = run.parts.store.decisions.filter(
      (written) => written.record.instanceId === SHADOW_INSTANCE_ID,
    );
    expect(shadowDecisions.length).toBeGreaterThan(0);
    // …and nothing it emitted reached the venue or the books.
    const shadowClaims = run.parts.store.transactions.flatMap((appended) =>
      appended.transaction.entries.filter((entry) => entry.instanceId === SHADOW_INSTANCE_ID),
    );
    expect(shadowClaims).toEqual([]);
    expect(run.trader.loop.pnlRecords(SHADOW_INSTANCE_ID)).toEqual([]);
  });

  it("labelling the second instance SHADOW does not create a second balance", async () => {
    const owned = await driveScenario();
    const shadowed = await driveScenario({ config: traderConfig({ withShadow: true }) });
    // One book, one cash balance: adding an observer changes nothing the owner
    // did. A shadow whose orders executed on the shared book would be a live
    // instance with a shadow label.
    expect(shadowed.fills.map((fill) => `${fill.price}x${fill.shares}`)).toEqual(
      owned.fills.map((fill) => `${fill.price}x${fill.shares}`),
    );
    expect(shadowed.parts.store.transactions).toHaveLength(
      owned.parts.store.transactions.length,
    );
  });
});

describe("residual 4 — the interim §9.8 operator inputs are required and undefaulted", () => {
  const cases: readonly {
    readonly check: string;
    readonly field: string;
    readonly remove: (config: Record<string, unknown>) => void;
  }[] = [
    {
      check: "check 6 — the settlement specification is verified",
      field: "settlementReadiness",
      remove: (config) => {
        const markets = config["markets"] as Record<string, unknown>[];
        delete markets[0]?.["settlementReadiness"];
      },
    },
    {
      check: "check 9 — current trading parameters are known",
      field: "parametersVersion",
      remove: (config) => {
        const markets = config["markets"] as Record<string, unknown>[];
        delete markets[0]?.["parametersVersion"];
      },
    },
    {
      check: "check 17 — the shock scenarios",
      field: "scenarios",
      remove: (config) => {
        delete config["scenarios"];
      },
    },
    {
      check: "check 19 — the request budget",
      field: "requestBudget",
      remove: (config) => {
        delete config["requestBudget"];
      },
    },
  ];

  for (const testCase of cases) {
    it(`${testCase.check}: omitting \`${testCase.field}\` refuses at startup`, () => {
      const config = document();
      testCase.remove(config);
      const refusal = refusalOf(config);
      expect(refusal.code).toBe("TRADER_CONFIG_REFUSED");
      expect(refusal.issues).toContain(testCase.field);
    });
  }

  it("the scenario supplies TRUTHFUL values, not convenient ones", () => {
    const config = document();
    const market = (config["markets"] as Record<string, unknown>[])[0];
    // `settlementReadiness` is `true` about a SIMULATED market this suite
    // specifies end to end — see `support/scenario.ts`. It is deliberately NOT
    // the `btc-15m-updown` series, whose truthful answer in this repository is
    // `false` and whose entries are therefore all refused.
    expect(market?.["seriesKey"]).not.toBe("btc-15m-updown");
    expect(market?.["settlementReadiness"]).toEqual({ modelDependentActivationAllowed: true });
  });
});
