/**
 * WP-310: every venue fact the budget acts on is cited, and its quote appears
 * verbatim in its source: the dated report (whitespace-normalized), or the
 * installed pinned SDK's type declarations (JSDoc `*` prefixes removed).
 */

import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { PINNED_SDK, RATE_LIMIT_VENUE_FACTS } from "./venue-facts.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const normalize = (text: string): string => text.replace(/\s+/gu, " ");

function pinnedSdkDeclarations(): { readonly version: string; readonly text: string } {
  const entry = createRequire(import.meta.url).resolve("@polymarket/client");
  const dist = path.dirname(entry);
  const manifest = JSON.parse(readFileSync(path.join(dist, "..", "package.json"), "utf8")) as { name: string; version: string };
  const text = readdirSync(dist)
    .filter((name) => name.endsWith(".d.ts"))
    .map((name) => readFileSync(path.join(dist, name), "utf8"))
    .join("\n")
    .replace(/^\s*\*\s?/gmu, " ");
  return { version: `${manifest.name}@${manifest.version}`, text: normalize(text) };
}

describe("cited rate-limit venue facts", () => {
  const sdk = pinnedSdkDeclarations();

  it("the SDK the facts cite is the one this package pins", () => {
    expect(sdk.version).toBe(PINNED_SDK);
    const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, "packages", "polymarket-secure", "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(`@polymarket/client@${manifest.dependencies["@polymarket/client"] ?? ""}`).toBe(PINNED_SDK);
  });

  for (const fact of Object.values(RATE_LIMIT_VENUE_FACTS)) {
    it(`${fact.id} is quoted verbatim from ${fact.source} ${fact.section}`, () => {
      if (fact.sourceKind === "REPORT") {
        expect(fact.source).toMatch(/^docs\/venue\/verified-\d{4}-\d{2}-\d{2}\.md$/u);
        expect(normalize(readFileSync(path.join(REPO_ROOT, fact.source), "utf8"))).toContain(normalize(fact.quote));
      } else {
        expect(fact.source).toBe(PINNED_SDK);
        expect(sdk.text).toContain(normalize(fact.quote));
      }
    });
  }

  it("NON-VACUOUS: a quote that is not in its source is caught", () => {
    expect(normalize(readFileSync(path.join(REPO_ROOT, "docs/venue/verified-2026-09-16.md"), "utf8"))).not.toContain("Retry-After on 200");
    expect(sdk.text).not.toContain("Unix timestamp, in milliseconds, when the current rate-limit wait period ends.");
  });
});
