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
import { COMPUTED_SPECIFIER, moduleSpecifiersIn } from "./support/module-specifiers.js";
import { paperEnvironment } from "./support/scenario.js";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The module specifiers this package's files may name. Relative specifiers
 * (`./`, `../`) are this package's own files and are always permitted.
 */
const PERMITTED_MODULES: ReadonlySet<string> = new Set([
  "node:fs",
  "node:path",
  "node:url",
  "vitest",
  "@polymarket-bot/decimal",
  "@polymarket-bot/domain",
  // `RECON-1` r1: `reconciliation-attribution.test.ts` folds synthetic fills
  // through the REAL PnL engine to establish the value the reconciler must
  // agree with. A layer-1 accounting package — no I/O, signer, order path or
  // network surface — already aliased by this suite's runner and tsconfig.
  // `support/reconcile.ts` itself must never import it.
  "@polymarket-bot/pnl",
  "@polymarket-bot/simulation",
  "@polymarket-bot/trader",
  "@polymarket-bot/trader/testing",
  // `RECON-1` r2, `RECON-2`: `support/module-specifiers.ts` reads imports from
  // a PARSED source, as `test/contract/coinbase/isolation.test.ts` does. The
  // compiler (a root devDependency) is used only to parse text — no network,
  // signer or order path — and a line regex let a trailing comment hide an
  // import.
  "typescript",
  "vitest/config",
]);

/** The specifiers in `names` that are neither relative nor permitted. */
function notPermitted(names: readonly string[]): readonly string[] {
  return names.filter(
    (name) => !name.startsWith("./") && !name.startsWith("../") && !PERMITTED_MODULES.has(name),
  );
}

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
    // scanner passes by finding itself. Only what an import actually names is
    // checked — read from each file's PARSED syntax tree by the helper
    // `reconciliation-attribution.test.ts`'s independence pin also uses
    // (`RECON-2`, closing `RECON1-SCAN`) — and the permitted set is enumerated:
    // a NEW dependency in this tree fails here even if it is not on any deny
    // list.
    const hits: string[] = [];
    let found = 0;
    for (const path of ownedFiles()) {
      if (!path.endsWith(".ts")) continue;
      const names = moduleSpecifiersIn(readFileSync(path, "utf8"), path);
      found += names.length;
      hits.push(...notPermitted(names).map((name) => `${path}: ${name}`));
    }
    expect(hits).toEqual([]);
    // A scan that found nothing would pass the assertion above while proving
    // nothing at all.
    expect(found).toBeGreaterThanOrEqual(20);
  });

  /**
   * `RECON1-SCAN`. The scan above used to match LINES, anchored at end of line,
   * so a trailing comment hid an import: the `RECON-1` r2 review planted the
   * first shape below in an e2e file and this suite passed. Every shape the
   * grammar allows is now a node the parse reports, wherever it sits, and a
   * MENTION — in a comment, in string data — is inert.
   */
  it("the scan reads the parse: every import shape is caught, and a mention is not an import", () => {
    const plants = [
      `import { strict as reviewAssert } from "node:assert"; // review plant`,
      `import "node:assert";`,
      `import type { AssertionError } from "node:assert";`,
      `export { strict } from "node:assert";`,
      `export * from "node:assert";`,
      `import assertion = require("node:assert");`,
      `const assertion = await import("node:assert");`,
      `type Assertion = typeof import("node:assert");`,
      `const assertion = require("node:assert");`,
    ];
    for (const plant of plants) {
      expect(notPermitted(moduleSpecifiersIn(`${plant}\n`)), plant).toEqual(["node:assert"]);
    }
    // A specifier the parse cannot read is a violation, not a pass.
    expect(
      notPermitted(moduleSpecifiersIn(`const where = "node:assert";\nawait import(where);\n`)),
    ).toEqual([COMPUTED_SPECIFIER]);
    expect(
      notPermitted(moduleSpecifiersIn(`const assertion = require("node:" + "assert");\n`)),
    ).toEqual([COMPUTED_SPECIFIER]);
    // Comments, strings and prose that runs "from" into a quoted word name
    // nothing.
    const mentions = [
      `// import { strict } from "node:assert";`,
      `/* const assertion = require("node:assert"); */`,
      `const note = 'import "node:assert"';`,
      "const prose = `read from \"node:assert\" at run time`;",
      `/**\n * The helper is imported from\n * "node:assert" in prose only.\n */`,
    ];
    for (const mention of mentions) {
      expect(moduleSpecifiersIn(`${mention}\n`), mention).toEqual([]);
    }
    // …and a permitted specifier is not reported, trailing comment or not.
    expect(
      notPermitted(moduleSpecifiersIn(`import { readFileSync } from "node:fs"; // permitted\n`)),
    ).toEqual([]);
  });

  it("both of this tree's import scans run on the ONE shared parse helper", () => {
    // The allowlist scan here and the oracle-independence pin in
    // `reconciliation-attribution.test.ts` import the same module, read from
    // their own parsed sources, so the two cannot drift back into two readers.
    for (const file of ["safety-posture.test.ts", "reconciliation-attribution.test.ts"]) {
      const names = moduleSpecifiersIn(readFileSync(join(here, file), "utf8"), file);
      expect(names, file).toContain("./support/module-specifiers.js");
      // …and neither parses on its own: the compiler is imported by the
      // helper alone.
      expect(names, file).not.toContain("typescript");
    }
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
