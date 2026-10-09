/**
 * `C1-TIF` (COMPLEXITY-1; the user's ruling of 2026-10-08): ADR-034 D4, the
 * collateral-targeted FAK and FOK BUY, is parked until the execution probe.
 * Until then an entry is a share-sized GTD order, and a FAK or FOK
 * `immediate_order_type` is refused at validation, by name. The shipped
 * configurations use a GTD entry, bounded by an explicit `order_validity_ms`.
 *
 * `C1-TIF` r1 (finding L2): a GTC entry is refused too, by its own name. The
 * ruling admits GTC only with ADR-034 D3.4's deadline cancel, which is not
 * built.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  IMMEDIATE_ORDER_TYPE_GTC_NEEDS_DEADLINE_CANCEL,
  IMMEDIATE_ORDER_TYPE_PARKED,
  validateStaticBracketParams,
} from "../../../../packages/strategies/static-bracket/src/index.js";
import { configWith } from "./helpers.js";

describe("C1-TIF — FAK and FOK entries are refused until D4 is built after the execution probe", () => {
  it.each(["FAK", "FOK"])("refuses immediate_order_type %s, naming the refusal and why", (value) => {
    const result = validateStaticBracketParams(configWith({ "entry.execution.immediate_order_type": value }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(IMMEDIATE_ORDER_TYPE_PARKED).toBe("SB_IMMEDIATE_ORDER_TYPE_PARKED_UNTIL_EXECUTION_PROBE");
    expect(result.problem.startsWith(`${IMMEDIATE_ORDER_TYPE_PARKED}: `)).toBe(true);
    expect(result.problem).toContain(`params.entry.execution.immediate_order_type ${value} is refused`);
    expect(result.problem).toContain("ADR-034 D4");
    expect(result.problem).toContain("parked until the execution probe");
  });

  it("refuses immediate_order_type GTC by its own name: the ruling's deadline cancel (D3.4) is not built", () => {
    const result = validateStaticBracketParams(configWith({ "entry.execution.immediate_order_type": "GTC" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(IMMEDIATE_ORDER_TYPE_GTC_NEEDS_DEADLINE_CANCEL).toBe("SB_IMMEDIATE_ORDER_TYPE_GTC_NEEDS_DEADLINE_CANCEL");
    expect(result.problem.startsWith(`${IMMEDIATE_ORDER_TYPE_GTC_NEEDS_DEADLINE_CANCEL}: `)).toBe(true);
    expect(result.problem).toContain("params.entry.execution.immediate_order_type GTC is refused");
    expect(result.problem).toContain("ADR-034 D3.4");
    expect(result.problem).not.toContain(IMMEDIATE_ORDER_TYPE_PARKED);
  });

  it("accepts immediate_order_type GTD, and only GTD", () => {
    const result = validateStaticBracketParams(configWith({ "entry.execution.immediate_order_type": "GTD" }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.entry.execution.immediate_order_type).toBe("GTD");
  });

  it("still refuses a value outside the four with the grammar's own message", () => {
    const result = validateStaticBracketParams(configWith({ "entry.execution.immediate_order_type": "IOC" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problem).not.toContain(IMMEDIATE_ORDER_TYPE_PARKED);
      expect(result.problem).not.toContain(IMMEDIATE_ORDER_TYPE_GTC_NEEDS_DEADLINE_CANCEL);
    }
  });
});

describe("C1-TIF — the shipped entry type is GTD, with an explicit order_validity_ms", () => {
  const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "..");
  for (const relative of [
    "infra/compose/trader/trader.config.example.json",
    "test/fixtures/trader-throughput/template.json",
  ]) {
    it(relative, () => {
      const config = JSON.parse(readFileSync(resolve(REPO_ROOT, relative), "utf8")) as {
        readonly instances: readonly { readonly params: { readonly entry: { readonly execution: Record<string, unknown> } } }[];
      };
      expect(config.instances.length).toBeGreaterThan(0);
      for (const instance of config.instances) {
        expect(instance.params.entry.execution["immediate_order_type"]).toBe("GTD");
        expect(instance.params.entry.execution["order_validity_ms"]).toBe(30_000);
        expect(validateStaticBracketParams(instance.params).ok).toBe(true);
      }
    });
  }
});
