/**
 * Determinism and purity — same inputs, identical plan BYTES; no wall clock,
 * no randomness, no I/O.
 *
 * Two mechanisms: behavioural (independent builds from independently
 * constructed but equal fixtures produce byte-identical JSON) and mechanical
 * (a source scan proves the impure primitives never appear in the package —
 * the same style of pin `packages/strategy-runtime`'s suite uses, applied
 * from the test tree so the package cannot drift under it silently).
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { buildExecutionPlan } from "../../../packages/execution-planner/src/index.js";
import {
  approvedBasket,
  approvedCancel,
  approvedPosition,
  planningInputs,
} from "./fixtures.js";

const packageSrc = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../packages/execution-planner/src",
);

describe("determinism (§12.4 by analogy)", () => {
  it("builds byte-identical plans from independently built equal fixtures", () => {
    for (const mint of [approvedPosition, approvedBasket, approvedCancel]) {
      const first = buildExecutionPlan(mint(), planningInputs());
      const second = buildExecutionPlan(mint(), planningInputs());
      if (!first.ok || !second.ok) throw new Error("expected both builds to succeed");
      expect(JSON.stringify(second.value)).toBe(JSON.stringify(first.value));
    }
  });

  it("builds byte-identical refusals too (refusal evidence is data, not wall-clock text)", () => {
    const first = buildExecutionPlan(approvedPosition(), planningInputs({ markets: [] }));
    const second = buildExecutionPlan(approvedPosition(), planningInputs({ markets: [] }));
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("is insulated from later caller mutation of the input documents", () => {
    const record = JSON.parse(JSON.stringify(approvedPosition())) as Record<string, unknown>;
    const inputs = planningInputs();
    const built = buildExecutionPlan(record, inputs);
    if (!built.ok) throw new Error("expected the build to succeed");
    const before = JSON.stringify(built.value);
    // Mutate everything the caller still holds.
    (record["intent"] as Record<string, unknown>)["targetShares"] = "999999";
    (inputs.markets[0] as Record<string, unknown>)["tickSize"] = "0.5";
    inputs.availableCollateral = "0";
    expect(JSON.stringify(built.value)).toBe(before);
  });
});

describe("purity — the impure primitives do not appear in the package source", () => {
  /** Comments stripped: module headers legitimately NAME the primitives they forswear. */
  function stripComments(text: string): string {
    return text.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/[^\n]*/gu, "");
  }
  const sources = readdirSync(packageSrc)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => ({ name, text: stripComments(readFileSync(join(packageSrc, name), "utf8")) }));

  it("scans a non-empty source tree (the pin cannot pass vacuously)", () => {
    expect(sources.length).toBeGreaterThan(10);
  });

  it("never reads a clock or entropy and never performs I/O", () => {
    // Call-shaped primitives only; MODULE access is pinned by the
    // import-specifier test below (a mirrored comment legitimately QUOTES
    // the F15 allowlist's `node:crypto`, so a raw text match would misfire).
    const forbidden = [
      /Date\.now/u,
      /new Date\(\)/u, // zero-argument only; new Date(number) is pure
      /Math\.random/u,
      /process\./u,
      /setTimeout|setInterval/u,
      /\bfetch\s*\(/u,
      /require\s*\(/u,
    ];
    for (const source of sources) {
      for (const pattern of forbidden) {
        expect(pattern.test(source.text), `${source.name} matches ${String(pattern)}`).toBe(false);
      }
    }
  });

  it("imports only the declared downward edges, node:util, and its own modules — and NEVER zod", () => {
    const importPattern = /from\s+"([^"]+)"/gu;
    const allowed = new Set(["@polymarket-bot/decimal", "@polymarket-bot/domain", "node:util"]);
    for (const source of sources) {
      for (const match of source.text.matchAll(importPattern)) {
        const specifier = match[1] ?? "";
        const ok = allowed.has(specifier) || specifier.startsWith("./");
        expect(ok, `${source.name} imports "${specifier}"`).toBe(true);
        expect(specifier).not.toBe("zod");
      }
    }
  });
});
