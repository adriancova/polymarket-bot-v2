/**
 * The acceptance criterion "Adapter never reads strategy configuration
 * directly", and the safety rule that no credential exists anywhere in this
 * package.
 *
 * Both are properties of the SOURCE, not of a run, so they are checked by
 * reading the source tree. A behavioural test cannot prove the absence of an
 * environment read on a path it did not happen to take.
 *
 * The forbidden tokens are assembled from pieces so this file does not match its
 * own patterns; the scan covers `packages/coinbase-adapter/src/**`, which is
 * every line of the package.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const packageRoot = join(repoRoot, "packages/coinbase-adapter");
const sourceRoot = join(packageRoot, "src");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(full);
    }
    return entry.isFile() && entry.name.endsWith(".ts") ? [full] : [];
  });
}

/** Every `.ts` file in the package, colocated tests included. */
const FILES = sourceFiles(sourceRoot).sort();

/**
 * The files that actually ship.
 *
 * Two checks below are about what the *adapter* may do, not about what a test
 * may assert: a colocated test naturally names the endpoint it is asserting on,
 * and a test double naturally stands in for a global. The environment,
 * credential, dependency, and I/O checks stay over every file, because none of
 * those is ever legitimate here.
 */
const IMPLEMENTATION_FILES = FILES.filter((file) => !file.endsWith(".test.ts"));

function read(file: string): string {
  return readFileSync(file, "utf8");
}

describe("the package source", () => {
  it("has files to scan", () => {
    expect(FILES.length).toBeGreaterThan(8);
    expect(IMPLEMENTATION_FILES.length).toBeGreaterThan(8);
    expect(IMPLEMENTATION_FILES.length).toBeLessThan(FILES.length);
  });

  it("reads no environment variable", () => {
    const env = ["process", "env"].join(".");
    const envAlt = ["process", '["env"]'].join("");
    for (const file of FILES) {
      const text = read(file);
      expect(text.includes(env), relative(repoRoot, file)).toBe(false);
      expect(text.includes(envAlt), relative(repoRoot, file)).toBe(false);
      expect(text.includes("import.meta.env"), relative(repoRoot, file)).toBe(false);
    }
  });

  it("imports no configuration or strategy package", () => {
    const forbidden = [
      "@polymarket-bot/config",
      "@polymarket-bot/strategy-sdk",
      "@polymarket-bot/strategy-runtime",
      "@polymarket-bot/strategies",
      "@polymarket-bot/observability",
      "@polymarket-bot/event-bus",
      "@polymarket-bot/storage-postgres",
      "@polymarket-bot/storage-wal",
      "dotenv",
    ];
    for (const file of FILES) {
      const text = read(file);
      for (const specifier of forbidden) {
        expect(text.includes(`"${specifier}`), `${relative(repoRoot, file)} imports ${specifier}`).toBe(
          false,
        );
      }
    }
  });

  it("declares only downward workspace dependencies", () => {
    const manifest = JSON.parse(read(join(packageRoot, "package.json"))) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const workspaceDeps = Object.entries({
      ...manifest.dependencies,
      ...manifest.devDependencies,
    })
      .filter(([, version]) => version.startsWith("workspace:"))
      .map(([name]) => name)
      .sort();
    // Layer 0 only: `docs/contracts/dependency-direction.md` §2 puts this
    // package at layer 2 and permits no same-layer edge that is not enumerated.
    expect(workspaceDeps).toEqual(["@polymarket-bot/decimal", "@polymarket-bot/domain"]);
  });

  it("holds no credential, signer, or authentication material", () => {
    const forbidden = [
      "jwt",
      "apiKey",
      "api_key",
      "secretKey",
      "passphrase",
      "privateKey",
      "signature",
      "Authorization",
      "advanced-trade-ws-user",
    ];
    for (const file of FILES) {
      const text = read(file);
      for (const token of forbidden) {
        // `jwt` appears only inside a quoted documentation sentence that states
        // the public endpoint does not need one, so the check is on code shape:
        // no assignment, no property, no template interpolation of the token.
        expect(
          new RegExp(`${token}\\s*[:=]`, "u").test(text),
          `${relative(repoRoot, file)} mentions ${token} in a code position`,
        ).toBe(false);
      }
    }
  });

  it("names a venue endpoint in exactly one file", () => {
    // Endpoints are constants in `venue-facts.ts`, next to the citation that
    // establishes them. A URL literal anywhere else would be an endpoint with no
    // provenance, which is how an undocumented — or authenticated — host gets
    // dialled by accident.
    // `wss://` followed by a host character. The bare scheme prefix, which
    // `node-runtime.ts` uses to refuse a plaintext endpoint, is not a host.
    const filesWithUrls = IMPLEMENTATION_FILES.filter((file) =>
      /wss:\/\/[A-Za-z0-9]/u.test(read(file)),
    ).map((file) => relative(packageRoot, file).replaceAll("\\", "/"));
    expect(filesWithUrls).toEqual(["src/venue-facts.ts"]);
  });

  it("has exactly one endpoint constant, and it is the documented public one", () => {
    const text = read(join(sourceRoot, "venue-facts.ts"));
    const literals = [...text.matchAll(/"(wss:\/\/[A-Za-z0-9./-]+)"/gu)].map((match) => match[1]);
    expect(literals).toEqual(["wss://advanced-trade-ws.coinbase.com"]);
    // The Coinbase Exchange alternative is discussed in prose so the choice is
    // reviewable, but it is not a string literal anything could dial, and the
    // authenticated user endpoint is not mentioned at all.
    expect(text).not.toContain("advanced-trade-ws-user");
  });

  it("touches a global in exactly one file", () => {
    const impure = IMPLEMENTATION_FILES.filter((file) => {
      const text = read(file);
      return (
        /\bnew WebSocket\(/u.test(text) ||
        /\bprocess\.hrtime\b/u.test(text) ||
        /\bsetTimeout\(/u.test(text)
      );
    }).map((file) => relative(packageRoot, file).replaceAll("\\", "/"));
    expect(impure).toEqual(["src/node-runtime.ts"]);
  });

  it("performs no I/O outside the socket port", () => {
    for (const file of FILES) {
      const text = read(file);
      for (const builtin of ["node:fs", "node:http", "node:https", "node:net", "node:child_process"]) {
        expect(text.includes(builtin), `${relative(repoRoot, file)} imports ${builtin}`).toBe(false);
      }
      expect(/\bfetch\(/u.test(text), relative(repoRoot, file)).toBe(false);
    }
  });
});
