/**
 * `WP-080` acceptance 3: the adapter never reads strategy configuration
 * directly.
 *
 * A prose promise is not a check, so this file reads the package's own source
 * and asserts the property mechanically. It is deliberately a source scan rather
 * than a runtime assertion: a runtime test only proves that the paths it happens
 * to execute read nothing, while the scan covers every line in the package.
 *
 * WHAT IS FORBIDDEN, and why each entry is here:
 *
 * - `process.env` / `import.meta.env` — an environment read is configuration by
 *   another name, and it is invisible to a caller that thinks it passed every
 *   option in. The composition root reads the environment; an adapter does not.
 * - `@polymarket-bot/config` — the configuration package (layer 1). Importing it
 *   would also be an upward workspace edge (F12).
 * - any workspace package other than `@polymarket-bot/domain` and
 *   `@polymarket-bot/decimal` — the layer-2 rule in
 *   `docs/contracts/dependency-direction.md` §2.
 * - filesystem built-ins — a file read is a configuration read with extra steps.
 *
 * WHAT IS ALLOWED, stated so the boundary is not accidentally tightened later:
 * `process.hrtime.bigint()` in `time.ts` is a CLOCK, not configuration, and it
 * lives in the one injectable `Clock` implementation.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "../../../packages/binance-adapter");
const SOURCE_ROOT = join(PACKAGE_ROOT, "src");

function collectSourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectSourceFiles(full));
      continue;
    }
    if (entry.name.endsWith(".ts")) {
      found.push(full);
    }
  }
  return found.sort();
}

const SOURCE_FILES = collectSourceFiles(SOURCE_ROOT);
const PRODUCTION_FILES = SOURCE_FILES.filter((file) => !file.endsWith(".test.ts"));

function read(file: string): string {
  return readFileSync(file, "utf8");
}

/** Strips comments so a rule cannot be tripped by prose that merely mentions it. */
function code(file: string): string {
  return read(file)
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/(^|[^:])\/\/.*$/gmu, "$1");
}

describe("the adapter reads no configuration", () => {
  it("has source files to scan", () => {
    expect(PRODUCTION_FILES.length).toBeGreaterThan(8);
  });

  it("never reads an environment variable", () => {
    for (const file of SOURCE_FILES) {
      expect(code(file), file).not.toMatch(/process\s*\.\s*env/u);
      expect(code(file), file).not.toMatch(/import\s*\.\s*meta\s*\.\s*env/u);
      expect(code(file), file).not.toMatch(/getEnv|readEnv|dotenv/u);
    }
  });

  it("never imports the configuration package", () => {
    // `code()` strips comments first: this file's own prose, and the package's,
    // name the forbidden import in order to explain the rule.
    for (const file of SOURCE_FILES) {
      expect(code(file), file).not.toContain("@polymarket-bot/config");
    }
  });

  it("never reads a file or a command line", () => {
    for (const file of SOURCE_FILES) {
      const source = code(file);
      expect(source, file).not.toMatch(/from\s+["']node:fs["']/u);
      expect(source, file).not.toMatch(/from\s+["']node:fs\/promises["']/u);
      expect(source, file).not.toMatch(/process\s*\.\s*argv/u);
    }
  });

  it("uses `process` only for the monotonic clock, in the one injectable Clock", () => {
    const users = PRODUCTION_FILES.filter((file) => /\bprocess\s*\./u.test(code(file)));
    expect(users.map((file) => file.replace(`${SOURCE_ROOT}/`, ""))).toEqual(["time.ts"]);
    expect(code(join(SOURCE_ROOT, "time.ts"))).toContain("process.hrtime.bigint()");
  });
});

describe("dependency direction", () => {
  it("declares only downward workspace edges", () => {
    const manifest = JSON.parse(read(join(PACKAGE_ROOT, "package.json"))) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const workspaceEdges = Object.entries({
      ...manifest.dependencies,
      ...manifest.devDependencies,
    })
      .filter(([, specifier]) => specifier.startsWith("workspace:"))
      .map(([name]) => name)
      .sort();

    expect(workspaceEdges).toEqual(["@polymarket-bot/decimal", "@polymarket-bot/domain"]);
  });

  it("imports no workspace package other than domain and decimal", () => {
    const permitted = new Set(["@polymarket-bot/domain", "@polymarket-bot/decimal"]);
    for (const file of PRODUCTION_FILES) {
      for (const match of code(file).matchAll(/from\s+["'](@polymarket-bot\/[^"']+)["']/gu)) {
        expect(permitted.has(match[1] ?? ""), `${file} imports ${String(match[1])}`).toBe(true);
      }
    }
  });

  it("imports no venue SDK, database client, or transport client", () => {
    const forbidden = [
      "@polymarket/",
      "ioredis",
      "redis",
      "\"pg\"",
      "ccxt",
      "binance-api-node",
      "ethers",
      "viem",
      "axios",
      "node-fetch",
      "undici",
    ];
    for (const file of SOURCE_FILES) {
      const imports = [...code(file).matchAll(/from\s+["']([^"']+)["']/gu)].map(
        (match) => match[1] ?? "",
      );
      for (const specifier of imports) {
        for (const pattern of forbidden) {
          expect(
            specifier.includes(pattern.replaceAll('"', "")),
            `${file} imports ${specifier}`,
          ).toBe(false);
        }
      }
    }
  });
});

describe("no credentials anywhere", () => {
  it("names no authentication material", () => {
    for (const file of PRODUCTION_FILES) {
      const source = code(file);
      expect(source, file).not.toMatch(/X-MBX-APIKEY/iu);
      expect(source, file).not.toMatch(/\bapiSecret\b|\bprivateKey\b|\bsignature\b/u);
      expect(source, file).not.toMatch(/\bhmac\b|\bsignRequest\b/iu);
    }
  });

  it("refers to the credential-gated SBE host only to refuse it", () => {
    const venue = read(join(SOURCE_ROOT, "venue.ts"));
    expect(venue).toContain("stream-sbe.binance.com");
    expect(venue).toContain("requires an API key");
    // …and nothing else in the package mentions it.
    for (const file of PRODUCTION_FILES) {
      if (file.endsWith("venue.ts")) {
        continue;
      }
      expect(code(file), file).not.toContain("stream-sbe");
    }
  });
});
