/**
 * The KNOWN RESIDUALS, OBSERVED.
 *
 * `WP-250`'s packet names four residuals the suite must observe and must not
 * fight. Nothing in this file weakens a policy, re-tags an intent, bypasses a
 * door or works around a refusal. Each test pins the residual's OBSERVABLE
 * CONSEQUENCE so that the day it is fixed, this file fails and says which
 * residual moved.
 *
 * THAT HAPPENED — THREE TIMES. Residuals 1, 2 and 5 are RESOLVED, and this
 * file is how each was noticed: the row that pinned the behaviour failed on the
 * very commit that changed it, naming the residual that moved. Their rows below
 * now pin the RESOLUTION — the mechanism is unchanged, only its subject is.
 *
 * | Residual | Owner of the fix | Observed here as |
 * | --- | --- | --- |
 * | `strategyInstanceId` must satisfy two conflicting doors — **RESOLVED 2026-09-06** (ADR-021: risk `8c14b47`, allocator `d9f70a6`, trader `TRDR-1`) | the contract owner — ruled and executed | a minted `0`-leading UUIDv7 now STARTS, the letter-leading one still does, and the startup refusal that replaced the conflict names the field without the conflict text |
 * | a protective reduction is typed `ENTRY` at the risk seam — **RESOLVED 2026-09-15** (GOV-2B blocker B2, `RISK-2`) | the risk-side follow-up, executed | `risk.refusedExits` is `0`, the exits are planned and submitted, and the instance ends FLAT instead of trapped |
 * | (residual 5) a protective reduction created no order track, so its own fill read `SB.UNATTRIBUTED_FILL` and paused the instance — **RESOLVED by `BRACKET-1a`** (the reduction is tracked; rulings R1–R3) | `packages/strategies/static-bracket`'s state machine — executed | the reduction's own fill closes the bracket (`SB.EXIT_FILLED`, `SB.CLOSED`), no decision pauses or fails to name a fill, and the run ends `SB.REFUSED_MAXIMUM_ENTRIES` (the scenario's reentry limit is 1) — against a ledger that is still clean |
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

import { captureArtifact } from "./support/artifact.js";
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

/**
 * Residual 2, RESOLVED — the rows now pin the resolution.
 *
 * GOV-2B blocker B2: `static-bracket` emits its protective exits as §7.7
 * `POSITION`s, `packages/risk` classified every `POSITION` as an `ENTRY`, and
 * the entry-only positive-net-edge gate then refused the exit for an
 * `expectedNetEdge` an exit can never declare. No realized round trip was
 * reachable in the merged paper core. `RISK-2` fixed it CONSUMER-SIDE: the
 * disposition of a `POSITION` is derived from its effect on the supplied
 * portfolio, so a sell fully covered by the confirmed holding is an `EXIT`. No
 * tag is read, and the strategy still emits `POSITION`.
 *
 * Each row below is the same assertion as before with its expectation moved,
 * so the diff shows exactly what the fix changed on the health surface.
 */
describe("residual 2 — a protective reduction at the risk seam, RESOLVED", () => {
  it("the refusal is COUNTED, by code, on the health surface", async () => {
    const run = await driveScenario();
    const health = run.trader.loop.health();
    // WAS: `refusedExits 1`, `{ RISK_EDGE_INPUTS_MISSING: 1 }`. The seam no
    // longer refuses a protective exit, so the counter that measured the
    // residual reads ZERO — and the counter itself is unchanged and still
    // wired, which is what the rest of this row proves.
    expect(health.risk.refusedExits).toBe(0);
    expect(health.risk.refusedExitsByCode).toEqual({});
    expect(health.risk.refusals).toBe(0);
    // The mechanism is still live: the refused-exit count remains a SUBSET of
    // the total refusal count, per code, and both are still counted.
    for (const [code, count] of Object.entries(health.risk.refusedExitsByCode)) {
      expect(health.risk.refusalsByCode[code] ?? 0).toBeGreaterThanOrEqual(count);
    }
    expect(health.risk.refusals).toBeGreaterThanOrEqual(health.risk.refusedExits);
    // …and the exits it used to refuse were EVALUATED and APPROVED instead.
    expect(health.risk.evaluations).toBe(4);
    expect(health.risk.approvals).toBe(4);
  });

  it("the caveat travels with the snapshot, and is the trader's own constant", async () => {
    const run = await driveScenario();
    // Pinned BY IDENTITY against the exported constant, not by copying its
    // text: a wording improvement upstream must not read as a failure here.
    expect(run.trader.loop.health().riskSeamCaveat).toBe(RISK_SEAM_CAVEAT);
    // `BOOT-1` corrected the constant's TEXT (`RISK-2` residual R2). This pin
    // used to read `expect(RISK_SEAM_CAVEAT).toContain("WP-220 accepted
    // residual")` with a note that the wording was stale; the caveat now says
    // what is true — the seam no longer classifies a covered sell as ENTRY —
    // and QUOTES the superseded text rather than deleting it, which is why the
    // old phrase is still found.
    expect(RISK_SEAM_CAVEAT).toContain("SUPERSEDED (RISK-2, 133eac1)");
    expect(RISK_SEAM_CAVEAT).toContain('used to read "WP-220 accepted residual');
    expect(RISK_SEAM_CAVEAT).toContain("never from a tag");
    expect(RISK_SEAM_CAVEAT).not.toMatch(/^WP-220 accepted residual/u);
    // `BRACKET-1a` corrected it AGAIN. These pins used to read
    // `toContain("residual 5")` and `toContain("ends PAUSED")`, when the caveat
    // named residual 5 as "THE CAVEAT NOW". Kept as they were they would pass
    // VACUOUSLY on the quotation below — the RISK2-R2 class, a false caveat no
    // test notices — so they now assert the closure marker, the quotation, and
    // the ABSENCE of the present-tense claim.
    expect(RISK_SEAM_CAVEAT).toContain("SUPERSEDED (BRACKET-1a)");
    expect(RISK_SEAM_CAVEAT).not.toMatch(/THE CAVEAT NOW/u);
    // "residual 5" and "ends PAUSED" are still found — INSIDE the quotation of
    // the superseded text, and only there…
    const [, quoted = ""] = RISK_SEAM_CAVEAT.split('SUPERSEDED (BRACKET-1a): it then read "');
    const [quotation = "", presentTense = ""] = quoted.split('" — that is no longer true either:');
    expect(quotation.startsWith("RISK-2 residual 5")).toBe(true);
    expect(quotation).toContain("ends PAUSED");
    // …and what the caveat says AFTER it, its present tense, names the closing
    // codes and no pause.
    expect(presentTense).toContain("SB.CLOSED");
    expect(presentTense).not.toMatch(/PAUSED/u);
  });

  it("the exit is EXECUTED, and it is the intent the strategy emitted — not a re-tag", async () => {
    const run = await driveScenario();
    const health = run.trader.loop.health();
    // WAS: ONE plan, ONE submission, one BUY order, every fill a BUY — because
    // nothing was ever planned for the refused take-profit. Now the exits are
    // planned and submitted like any other intent.
    expect(health.execution.plansBuilt).toBe(4);
    expect(health.execution.submissionsAccepted).toBe(4);
    expect(run.orders).toHaveLength(3);
    expect(run.orders.map((order) => order.action)).toEqual(["BUY", "SELL", "SELL"]);
    expect(run.fills.map((fill) => fill.action)).toEqual(["BUY", "BUY", "SELL"]);

    // THE FAIL-CLOSED PROPERTY THE OLD ROW GUARDED IS STILL GUARDED. The exit
    // reached the venue because `packages/risk` APPROVED it, not because the
    // composition root re-derived a disposition from its tags. The intents the
    // strategy emitted are still §7.7 `POSITION`s, still carrying their
    // protective tags — the very tags a re-tagging fix would have had to change.
    const artifact = captureArtifact(run);
    const exitIntents = artifact.decisions
      .filter((decision) => decision.decisionType === "exit" || decision.decisionType === "reduce")
      .flatMap((decision) => decision.intents);
    expect(exitIntents.length).toBeGreaterThan(0);
    for (const intent of exitIntents) {
      expect(intent.type).toBe("POSITION");
      // Still wearing the protective tags a re-tagging fix would have removed.
      expect(intent.tags?.some((tag) => tag.startsWith("sb."))).toBe(true);
    }
  });

  it("the CONSEQUENCE is gone too: the instance ends FLAT, not trapped", async () => {
    const run = await driveScenario();
    const decisions = run.trader.loop.decisions();
    // WAS: "the instance ends holding what it cannot exit" — the strategy
    // emitted its take-profit, the seam refused it, and the state machine then
    // waited forever for a cancel confirmation no order would ever produce.
    // It now reaches its §13.3 `final_policy: PROTECTED_REDUCE` and closes.
    expect(decisions.some((decision) => decision.decisionType === "exit")).toBe(true);
    expect(decisions.some((decision) => decision.decisionType === "reduce")).toBe(true);
    expect(
      decisions.some((decision) =>
        decision.reasonCodes.includes("SB.FINAL_PROTECTED_REDUCE"),
      ),
    ).toBe(true);
    // The position is CLOSED at the end of the run — the fact the whole of B2
    // made unreachable.
    expect(
      run.trader.loop.costBasisOf(
        INSTANCE_ID,
        run.trader.config.markets[0]?.marketId ?? "",
        "YES",
      ),
    ).toBe("0");
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

/**
 * Residual 5, RESOLVED by `BRACKET-1a` — the rows now pin the resolution.
 *
 * WAS (reachable only once `RISK-2` fixed B2): `planProtectedReduce` created NO
 * order track — its stated reason was "there is no venue order id to track
 * until the OMS answers" — so when the protective reduction FILLED, the
 * strategy's own state machine found no order of its own the fill belonged to,
 * called it `SB.UNATTRIBUTED_FILL`, and reconciled — `SB.POSITION_MISMATCH`,
 * `SB.NO_BLIND_FLATTEN`, `SB.PAUSED`. The run ended PAUSED rather than cleanly
 * closed, and an instance paused on its own exit opens no second bracket. It
 * was never §6 invariant 7's unattributed ACTIVITY (the ledger attributed the
 * fill; the second row below pinned that then and pins it now), and it was
 * fail-closed.
 *
 * NOW: the reduction is tracked exactly as the take-profit is (PENDING and
 * id-less until a live view or its first fill names it), held while it is live,
 * and its fill folds through the ordinary exit edge into `CLOSED`. Nothing
 * outside `packages/strategies/static-bracket` changed to do it — the loop
 * already routed the fill to its owner by venue order id. The first row below
 * is the same observation with its expectation moved; the second is unchanged.
 *
 * WHAT THIS DOES NOT SHOW. This scenario cannot show a SECOND bracket (its
 * reentry limit is 1, and a cutoff reduction is always after the entry cutoff)
 * or a FILLED take-profit (it has no trade print) — `BRACKET-1b`'s scenario, by
 * the user's ruling R1. Repeated brackets closed by a stop or a holding-timeout
 * reduction are pinned at unit level
 * (`test/unit/strategies/static-bracket/bracket-1a-reduce-track.test.ts`).
 */
describe("residual 5 — a protective reduction's own fill, RESOLVED: it closes the bracket", () => {
  it("the reduction's own fill closes the bracket; nothing pauses, and the run ends at its reentry limit", async () => {
    const run = await driveScenario();
    const artifact = captureArtifact(run);
    const codes = artifact.decisions.flatMap((decision) => decision.reasonCodes);
    // The reduction was emitted and it FILLED — otherwise this row would be
    // vacuous.
    expect(codes).toContain("SB.FINAL_PROTECTED_REDUCE");
    expect(run.fills.some((fill) => fill.action === "SELL")).toBe(true);
    // WAS: `SB.UNATTRIBUTED_FILL, SB.POSITION_MISMATCH, SB.NO_BLIND_FLATTEN,
    // SB.PAUSED` on the reduction's own onFill. Now the strategy names the fill
    // it caused, and it closes the bracket.
    const reduceAt = artifact.decisions.findIndex((decision) => decision.decisionType === "reduce");
    expect(reduceAt).toBeGreaterThanOrEqual(0);
    const reductionFill = artifact.decisions
      .slice(reduceAt + 1)
      .find((decision) => decision.callback === "onFill");
    expect(reductionFill?.reasonCodes).toEqual(["SB.EXIT_FILLED", "SB.CLOSED"]);
    // No decision in the run fails to name a fill, and none pauses.
    expect(codes).not.toContain("SB.UNATTRIBUTED_FILL");
    expect(codes).not.toContain("SB.PAUSED");
    // WAS: onMarketClosing `SB.RESUMED, …, SB.PAUSED` — resumed and paused
    // again. Now the CLOSED bracket answers the scenario's reentry limit of 1.
    const closing = artifact.decisions.filter((decision) => decision.callback === "onMarketClosing");
    expect(closing).toHaveLength(1);
    expect(closing[0]?.reasonCodes).toEqual(["SB.REFUSED_MAXIMUM_ENTRIES"]);
  });

  it("but the BOOKS are right: nothing is unattributed where it would matter", async () => {
    const run = await driveScenario();
    const artifact = captureArtifact(run);
    // §6 invariant 7 is about the LEDGER, and the ledger is clean.
    expect(artifact.ledgerProjection.unattributedActivity).toBe(0);
    expect(artifact.ledgerProjection.unexplainedMovements).toBe(0);
    for (const record of artifact.pnlRecords) expect(record.scope).toBe("VIRTUAL_STRATEGY");
    // No market halted, and the process is still answerable.
    expect(artifact.health.halts).toEqual([]);
    expect(artifact.health.healthy).toBe(true);
    // The position really did close, which is the fact that matters most here:
    // the pause happens AFTER the exit is complete, not instead of it.
    expect(
      artifact.ledgerProjection.virtualPositions.some(
        (line) => line.assetKind === "OUTCOME_TOKEN",
      ),
    ).toBe(false);
  });
});
