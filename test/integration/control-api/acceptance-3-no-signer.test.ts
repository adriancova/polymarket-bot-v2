/**
 * WP-240 ACCEPTANCE 3 — "No signer is loaded."
 *
 * Asserted by ABSENCE, over the shipped source of both trees `WP-240` owns,
 * plus the manifests — and, for imports, over the control API's own test
 * suites and `infra/grafana/**` too (`CONTROL-1`, closing `WP-240` r1 N-4). This is the `apps/trader` precedent
 * (`test/integration/paper-trader/compose-and-example-config.test.ts`'s scans),
 * applied to a package whose §4.1 description is literally "never has the
 * signing key".
 *
 * Three independent claims:
 *
 * 1. **No import** of the secure adapter, a venue client, or a signing library.
 * 2. **No identifier** naming a signer, a wallet key or a credential in
 *    production source — and the exceptions are enumerated, not waived: the
 *    words appear only where the code REFUSES them.
 * 3. **No manifest dependency** on `packages/polymarket-secure`, and no
 *    credential-shaped value in the shipped example configuration.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ALL_PRODUCTION_NAMES, CREDENTIAL_NAME_PATTERNS } from "@polymarket-bot/observability";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");

/**
 * Every file a module loader could execute, and JSON. `CONTROL-1` (N-4) widened
 * this from `.ts`/`.json`: the newly scanned trees are allowed to hold a
 * script, and a `.mjs` under `infra/grafana/**` importing a signing library
 * would otherwise be walked past.
 */
const SCANNED_EXTENSIONS = [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs", ".json"] as const;

function walk(directory: string): readonly string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (SCANNED_EXTENSIONS.some((extension) => path.endsWith(extension))) out.push(path);
  }
  return out;
}

const OWNED_TREES = [
  resolve(repoRoot, "apps/control-api/src"),
  resolve(repoRoot, "packages/observability/src/control"),
];

const FILES = OWNED_TREES.flatMap((tree) => walk(tree));
const PRODUCTION_FILES = FILES.filter((path) => !path.endsWith(".test.ts"));

/**
 * `CONTROL-1`, closing `WP-240` r1 N-4: the IMPORT scan also covers the
 * control API's own test suites and the dashboards it feeds. A signing library
 * imported by a test of a process that "never has the signing key" would load
 * one into the very worker that proves it is absent; and a dashboard tree is
 * JSON today, so the scan's job there is to keep it that way. These trees are
 * READ here, never written — `infra/grafana/**` is outside `CONTROL-1`'s grant.
 */
const IMPORT_SCAN_TREES = [
  ...OWNED_TREES,
  resolve(repoRoot, "test/integration/control-api"),
  resolve(repoRoot, "test/unit/control-api"),
  resolve(repoRoot, "infra/grafana"),
];
const IMPORT_SCAN_FILES = IMPORT_SCAN_TREES.flatMap((tree) => walk(tree));

function read(path: string): string {
  return readFileSync(path, "utf8");
}

describe("ACCEPTANCE 3: no signer is loaded", () => {
  it("scans a non-trivial number of files (the scan is not vacuous)", () => {
    expect(FILES.length).toBeGreaterThan(20);
    expect(PRODUCTION_FILES.length).toBeGreaterThan(12);
  });

  it("N-4: the import scan reaches every tree it names (not vacuous per tree)", () => {
    for (const tree of IMPORT_SCAN_TREES) {
      expect(
        IMPORT_SCAN_FILES.filter((path) => path.startsWith(`${tree}/`)).length,
        `${tree} contributes no file to the import scan`,
      ).toBeGreaterThan(0);
    }
    // The suites include THIS file and the dashboards their JSON.
    expect(IMPORT_SCAN_FILES).toContain(resolve(repoRoot, "test/integration/control-api/acceptance-3-no-signer.test.ts"));
    expect(IMPORT_SCAN_FILES).toContain(resolve(repoRoot, "infra/grafana/control/operations-dashboard.json"));
  });

  it("imports NO secure adapter, venue client or signing library, anywhere", () => {
    const forbiddenSpecifiers = [
      "@polymarket-bot/polymarket-secure",
      "@polymarket/client",
      "@polymarket/clob-client",
      "@polymarket/builder-signing-sdk",
      "@polymarket/builder-relayer-client",
      "ethers",
      "viem",
      "web3",
      "@ethersproject",
    ];
    for (const path of IMPORT_SCAN_FILES) {
      const source = read(path);
      for (const specifier of forbiddenSpecifiers) {
        expect(source, `${path} imports ${specifier}`).not.toContain(`from "${specifier}`);
        expect(source, `${path} imports ${specifier}`).not.toContain(`require("${specifier}`);
        expect(source, `${path} imports ${specifier}`).not.toContain(`import("${specifier}`);
        expect(source, `${path} imports ${specifier}`).not.toContain(`import "${specifier}`);
      }
    }
  });

  it("declares NO dependency on packages/polymarket-secure or a signing library", () => {
    const manifest = JSON.parse(read(resolve(repoRoot, "apps/control-api/package.json"))) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const declared = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
    expect(declared).not.toContain("@polymarket-bot/polymarket-secure");
    for (const name of declared) {
      expect(name.toLowerCase(), `${name} looks like a signing dependency`).not.toMatch(
        /ethers|viem|web3|signer|wallet/u,
      );
    }
    // The observability package declares no runtime dependency at all.
    const observability = JSON.parse(
      read(resolve(repoRoot, "packages/observability/package.json")),
    ) as { dependencies?: Record<string, string> };
    expect(Object.keys(observability.dependencies ?? {})).toEqual([]);
  });

  it("CONSTRUCTS no signer: every signer-shaped declaration ASSERTS ABSENCE", () => {
    // Declarations, not mentions. A `const signer =`, a `signer:` field, a
    // `#privateKey` — anything that could HOLD signing material.
    //
    // Exactly one declaration is expected to exist, and it is the one that says
    // there is no signer: `RunStateView.signerLoaded: false`, a literal `false`
    // on the wire. So rather than "the word never appears in a declaration",
    // the assertion is the stronger and truer "every declaration that mentions
    // a signer states its ABSENCE", checked against the declaration's own line.
    const declaration =
      /^.*(?:const|let|var|readonly|private|#)\s*[A-Za-z_$]*(?:signer|privateKey|walletKey|mnemonic|keystore)[A-Za-z_$]*\s*[:=].*$/gimu;
    const found: string[] = [];
    for (const path of PRODUCTION_FILES) {
      if (!path.endsWith(".ts")) continue;
      for (const line of read(path).match(declaration) ?? []) {
        found.push(`${path}: ${line.trim()}`);
        expect(line, `${path} declares ${line.trim()}`).toMatch(/\bfalse\b/u);
      }
    }
    // Non-vacuity: the scan really does reach the one declaration that exists.
    expect(found.filter((entry) => entry.includes("signerLoaded")).length).toBeGreaterThan(0);
  });

  it("mentions signer words ONLY where the code refuses them", () => {
    // The words DO appear — in `vocabulary.ts`'s forbidden-key list, in
    // `safety.ts`'s refusal text, and in comments explaining why there is no
    // signer. Enumerating the files that may contain them turns "the word is
    // absent" into the stronger and truer "the word appears only in refusals".
    const permitted = new Set(
      [
        "apps/control-api/src/vocabulary.ts",
        "apps/control-api/src/safety.ts",
        "apps/control-api/src/auth.ts",
        "apps/control-api/src/api.ts",
        "apps/control-api/src/control-plane.ts",
        "apps/control-api/src/main.ts",
        "apps/control-api/src/index.ts",
        "packages/observability/src/control/paper-safety.ts",
        "packages/observability/src/control/index.ts",
        // Its `MODE_RAISE_ATTEMPT` doc comment describes what the action
        // records: a request that tried to "reference a signer, and was refused
        // by name". The word is in the refusal's own definition.
        "packages/observability/src/control/audit.ts",
        // `control_allow_real_orders`'s and `control_mode_raise_attempts_
        // refused_total`'s HELP text — the metric documentation that says this
        // process has no signer, and the counter of requests that named one.
        "packages/observability/src/control/metric-families.ts",
      ].map((relative) => resolve(repoRoot, relative)),
    );
    for (const path of PRODUCTION_FILES) {
      if (!path.endsWith(".ts")) continue;
      if (permitted.has(path)) continue;
      const source = read(path).toLowerCase();
      for (const word of ["signer", "private key", "privatekey", "mnemonic", "keystore"]) {
        expect(source, `${path} mentions "${word}"`).not.toContain(word);
      }
    }
  });

  it("the shipped example configuration carries no production secret name", () => {
    const example = read(resolve(repoRoot, "apps/control-api/control-api.config.example.json"));
    const upper = example.toUpperCase();
    for (const name of ALL_PRODUCTION_NAMES) {
      expect(upper, `the example references ${name}`).not.toContain(name);
    }
    for (const pattern of CREDENTIAL_NAME_PATTERNS) {
      expect(upper, `the example references ${pattern}`).not.toContain(pattern);
    }
  });

  it("the example's token says, in its own text, that it is not a credential", () => {
    const example = JSON.parse(
      read(resolve(repoRoot, "apps/control-api/control-api.config.example.json")),
    ) as { operators: readonly { token: string }[] };
    for (const operator of example.operators) {
      expect(operator.token.toUpperCase()).toContain("NOT-A-CREDENTIAL");
    }
  });

  it("the run-state surface states signerLoaded: false on the wire", async () => {
    const { serveControlApi } = await import("./support/client.js");
    const { FAKE_OPERATOR_TOKEN } = await import("@polymarket-bot/control-api/testing");
    const api = await serveControlApi({
      operators: [
        { operatorId: "operator-a", token: FAKE_OPERATOR_TOKEN, grants: ["READ"] },
      ],
    });
    try {
      const response = await api.call("GET", "/v1/run-state", { token: FAKE_OPERATOR_TOKEN });
      expect((response.json() as Record<string, unknown>)["signerLoaded"]).toBe(false);
    } finally {
      await api.server.close();
    }
  });
});
