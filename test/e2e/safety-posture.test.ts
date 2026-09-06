/**
 * The PAPER safety posture of this run, and of this package's own files.
 *
 * The repository's four non-negotiable floors —
 *
 *     MAX_RUN_MODE=PAPER
 *     ALLOW_REAL_ORDERS=false
 *     LIVE_MICRO_MAX_ORDER_NOTIONAL=0
 *     LIVE_MICRO_MAX_ACCOUNT_EXPOSURE=0
 *
 * — are not weakened anywhere in this tree, and this file proves it two ways:
 * by driving the composition root's own `safety.ts` and observing that it
 * REFUSES rather than clamps, and by scanning every file this package owns for
 * a production secret name, a signer import or a raised mode.
 *
 * NO PRODUCTION WALLET, SIGNER, CREDENTIAL OR REAL ORDER exists anywhere in
 * this package, and none is representable: the only `ExecutionVenue` the
 * harness can hand the trader is `packages/simulation`'s, every fill it
 * produces carries `SIMULATED_NOT_REAL_EVIDENCE`, and every model identity
 * carries `deploymentDecisionUse: "FORBIDDEN"`.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  BUILDER_ATTRIBUTION_NAMES,
  CREDENTIAL_NAME_PATTERNS,
  PRODUCTION_ACCOUNT_NAMES,
  PRODUCTION_SECRET_NAMES,
  REPOSITORY_MAXIMUM_RUN_MODE,
  checkPaperTraderSafety,
} from "@polymarket-bot/trader";

import { assemble, driveScenario } from "./support/harness.js";
import { paperEnvironment } from "./support/scenario.js";

const here = dirname(fileURLToPath(import.meta.url));

/** Every file this package owns: its own tree plus the golden it commits. */
const OWNED_TREES = [here, resolve(here, "../replay-golden/paper-e2e")] as const;

function filesUnder(root: string): readonly string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(path));
    else out.push(path);
  }
  return out.sort();
}

function ownedFiles(): readonly string[] {
  return OWNED_TREES.flatMap((root) => filesUnder(root));
}

describe("the environment floors are enforced by refusal, never by clamping", () => {
  it("the scenario's environment states all four floors explicitly", () => {
    const env = paperEnvironment();
    expect(env["MAX_RUN_MODE"]).toBe("PAPER");
    expect(env["ALLOW_REAL_ORDERS"]).toBe("false");
    expect(env["LIVE_MICRO_MAX_ORDER_NOTIONAL"]).toBe("0");
    expect(env["LIVE_MICRO_MAX_ACCOUNT_EXPOSURE"]).toBe("0");
    expect(REPOSITORY_MAXIMUM_RUN_MODE).toBe("PAPER");
    const safety = checkPaperTraderSafety(env);
    expect(safety.ok).toBe(true);
  });

  const raised: readonly { readonly what: string; readonly env: Record<string, string> }[] = [
    { what: "a raised ceiling", env: { MAX_RUN_MODE: "LIVE" } },
    { what: "an enabled real-order flag", env: { ALLOW_REAL_ORDERS: "true" } },
    { what: "a non-zero order-notional cap", env: { LIVE_MICRO_MAX_ORDER_NOTIONAL: "1" } },
    { what: "a non-zero account-exposure cap", env: { LIVE_MICRO_MAX_ACCOUNT_EXPOSURE: "1" } },
    { what: "a run mode above the ceiling", env: { RUN_MODE: "LIVE_MICRO" } },
  ];

  for (const testCase of raised) {
    it(`${testCase.what} REFUSES the whole startup`, () => {
      const env = { ...paperEnvironment(), ...testCase.env };
      const safety = checkPaperTraderSafety(env);
      expect(safety.ok).toBe(false);
      const { result } = assemble({ env });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      // REFUSES, and refuses FIRST: the safety gate runs before the
      // configuration door, so a raised mode is never read alongside — or
      // silently corrected against — an operator document.
      expect(result.refusal.code).toBe("TRADER_UNSAFE_ENVIRONMENT");
    });
  }

  it("the ceiling is checked BEFORE the configuration door, not after it", () => {
    // A document that would ALSO be refused, under an environment that is
    // already unsafe. If the config door ran first, the code below would be
    // TRADER_CONFIG_REFUSED and the mode would have been read in a process that
    // should never have started.
    const { result } = assemble({
      env: { ...paperEnvironment(), MAX_RUN_MODE: "LIVE" },
      config: { environment: "PAPER" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe("TRADER_UNSAFE_ENVIRONMENT");
  });

  it("a production secret name in the environment refuses, without echoing a value", () => {
    const secret = PRODUCTION_SECRET_NAMES[0];
    expect(secret).toBeDefined();
    if (secret === undefined) return;
    const safety = checkPaperTraderSafety({ ...paperEnvironment(), [secret]: "unused" });
    expect(safety.ok).toBe(false);
    if (safety.ok) return;
    expect(safety.violations.map((violation) => violation.code)).toContain(
      "PAPER_PRODUCTION_SECRET_NAME_PRESENT",
    );
    for (const violation of safety.violations) {
      expect(violation.detail).not.toContain("unused");
    }
  });
});

describe("the run itself is PAPER all the way down", () => {
  it("run mode, ceiling, bookings and fill evidence all say PAPER or simulated", async () => {
    const run = await driveScenario();
    const health = run.trader.loop.health();
    expect(health.runMode).toBe("PAPER");
    expect(health.maximumRunMode).toBe("PAPER");
    for (const appended of run.parts.store.transactions) {
      expect(appended.transaction.environment).toBe("PAPER");
    }
    for (const snapshot of run.parts.store.pnlSnapshots) {
      expect(snapshot.environment).toBe("PAPER");
    }
    for (const fill of run.fills) {
      expect(fill.evidenceClass).toBe("SIMULATED_NOT_REAL_EVIDENCE");
      // ADR-012 §1: a Tier-0 result may never inform a deployment decision, and
      // the label travels on every fill this run produced.
      expect(fill.model.deploymentDecisionUse).toBe("FORBIDDEN");
      expect(fill.model.permittedUse).toBe("WIRING_AND_REGRESSION_ONLY");
      expect(fill.model.calibration).toBe("UNCALIBRATED_NO_PROBE_DATA_EXISTS");
    }
  });

  it("both live-micro caps in the scenario are the fenced floor", async () => {
    const run = await driveScenario();
    const caps = run.trader.config.allocatorCaps as unknown as Record<string, unknown>;
    expect(caps["liveMicroMaxOrderNotional"]).toBe("0");
    expect(caps["liveMicroMaxAccountExposure"]).toBe("0");
  });
});

describe("this package's own files carry no credential and no signer", () => {
  it("scans a non-trivial number of files, so an empty scan cannot pass", () => {
    const files = ownedFiles();
    expect(files.length).toBeGreaterThanOrEqual(10);
    expect(files.some((path) => path.endsWith(".json"))).toBe(true);
    expect(files.filter((path) => path.endsWith(".ts")).length).toBeGreaterThanOrEqual(8);
  });

  it("no production secret, account or builder-attribution name appears anywhere", () => {
    const names = [
      ...PRODUCTION_SECRET_NAMES,
      ...PRODUCTION_ACCOUNT_NAMES,
      ...BUILDER_ATTRIBUTION_NAMES,
      ...CREDENTIAL_NAME_PATTERNS,
    ];
    const hits: string[] = [];
    for (const path of ownedFiles()) {
      const text = readFileSync(path, "utf8");
      for (const name of names) {
        if (text.includes(name)) hits.push(`${path}: ${name}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("no signing library, wallet library or secure-SDK entry point is imported", () => {
    // MODULE SPECIFIERS, not prose. A scan for the bare word `ethers` would
    // match this test's own list and the sentence explaining it, which is how a
    // scanner passes by finding itself. Only what an `import`/`require`
    // actually resolves is checked, and the permitted set is enumerated: a NEW
    // dependency in this tree fails here even if it is not on any deny list.
    const permitted = new Set([
      "node:fs",
      "node:path",
      "node:url",
      "vitest",
      "@polymarket-bot/decimal",
      "@polymarket-bot/domain",
      "@polymarket-bot/simulation",
      "@polymarket-bot/trader",
      "@polymarket-bot/trader/testing",
      "vitest/config",
    ]);
    // Anchored at END OF LINE, and the specifier may not contain a newline: a
    // loose `from\s*["']` also matches the word "from" in a sentence that runs
    // into a quoted string on a later line, which is how the first version of
    // this scan flagged a doc comment.
    const patterns = [
      /\bfrom\s*["']([^"'\n]+)["']\s*;?\s*$/u,
      /^\s*import\s+["']([^"'\n]+)["']\s*;?\s*$/u,
      /\b(?:require|import)\s*\(\s*["']([^"'\n]+)["']\s*\)/u,
    ];
    const hits: string[] = [];
    let found = 0;
    for (const path of ownedFiles()) {
      if (!path.endsWith(".ts")) continue;
      const text = readFileSync(path, "utf8");
      for (const line of text.split("\n")) {
        for (const pattern of patterns) {
          const name = pattern.exec(line)?.[1];
          if (name === undefined) continue;
          found += 1;
          if (name.startsWith("./") || name.startsWith("../")) continue;
          if (!permitted.has(name)) hits.push(`${path}: ${name}`);
        }
      }
    }
    expect(hits).toEqual([]);
    // A regex that matched nothing would pass the assertion above while proving
    // nothing at all.
    expect(found).toBeGreaterThanOrEqual(20);
  });

  it("no file reads host entropy or a wall clock", () => {
    // CALLS, not mentions — the modules in this tree explain in prose that they
    // use none of these, and a substring scan would flag the explanation. The
    // title of this test is deliberately free of the call spellings for the
    // same reason: a scanner that matched its own name would be finding itself.
    const calls = [/\bMath\s*\.\s*random\s*\(/u, /\brandomUUID\s*\(/u, /\bDate\s*\.\s*now\s*\(/u, /\bnew\s+Date\s*\(\s*\)/u];
    const hits: string[] = [];
    for (const path of ownedFiles()) {
      if (!path.endsWith(".ts")) continue;
      const text = readFileSync(path, "utf8");
      for (const pattern of calls) {
        if (pattern.test(text)) hits.push(`${path}: ${pattern.source}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("no file raises a run mode: the only modes named are PAPER and refusals", () => {
    const hits: string[] = [];
    for (const path of ownedFiles()) {
      const text = readFileSync(path, "utf8");
      for (const line of text.split("\n")) {
        // A raised mode would have to be ASSIGNED somewhere. Every occurrence
        // of a non-PAPER mode in this tree is inside a refusal probe or a
        // comment, and each of those is either quoted as test DATA in
        // `safety-posture.test.ts` / `traceability-chain-negative.test.ts` or
        // is prose. An assignment of one to a configuration field is not.
        if (/(?:environment|runMode|RUN_MODE)"?\s*[:=]\s*"(?:LIVE|LIVE_MICRO|EXECUTION_PROBE)"/u.test(line)) {
          const permitted =
            path.endsWith("safety-posture.test.ts") ||
            path.endsWith("traceability-chain-negative.test.ts");
          if (!permitted) hits.push(`${path}: ${line.trim()}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });
});
