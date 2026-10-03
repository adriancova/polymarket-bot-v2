/**
 * The parameter schema against handoff §13.2 — read from the handoff, not
 * copied into this file.
 *
 * Three things are proved here:
 *
 * 1. every §13.2 key is a key of the shipped grammar, with §13.2's own value
 *    accepted unchanged (fidelity);
 * 2. §13.2's block ALONE is REFUSED, naming the first field it does not state
 *    (the required-versus-defaulted rule: no field is defaulted, so the
 *    example is not a runnable config);
 * 3. the fixture configuration the rest of the suite uses is exactly §13.2's
 *    block plus the additions `params.ts` discloses — no silent third set.
 */

import { describe, expect, it } from "vitest";

import {
  BOOK_AGE_FEATURE_KEY,
  STATIC_BRACKET_CONFIG_VERSION,
  STATIC_BRACKET_CONFIG_VERSION_2,
  STATIC_BRACKET_CONFIG_VERSIONS,
  staticBracketParamsSchema,
  validateStaticBracketParams,
} from "../../../../packages/strategies/static-bracket/src/index.js";
import { fencedBlocks, flatten, handoffSection, parseSimpleYaml } from "./handoff.js";
import { DELETE, baseConfig, clone, configWith } from "./helpers.js";

function handoffConfig(): Record<string, unknown> {
  const section = handoffSection("13.2 Configuration");
  const blocks = fencedBlocks(section).filter((block) => block.info === "yaml");
  expect(blocks).toHaveLength(1);
  return parseSimpleYaml((blocks[0] as { body: string }).body) as Record<string, unknown>;
}

/** The keys this package adds beyond §13.2, each disclosed in `params.ts`. */
const DISCLOSED_ADDITIONS = [
  "entry.trigger_feature_key",
  "entry.economic_leg_policy",
  "entry.execution.submission_unknown_after_ms",
  "entry.execution.order_validity_ms",
  "entry.economics.entry_fee_per_share",
  "entry.economics.exit_fee_per_share",
  "entry.economics.minimum_expected_net_edge",
  "exit.stop.enabled",
  "exit.stop.trigger_feature_key",
  "data_quality.maximum_book_age_ms",
  "data_quality.incident_feature_key",
  "data_quality.on_stale_book",
  "data_quality.on_incident",
];

describe("§13.2 configuration grammar", () => {
  it("reads the §13.2 block out of the handoff as a nested mapping", () => {
    const config = handoffConfig();
    expect(config["strategy"]).toBe("static-bracket");
    expect(config["version"]).toBe(STATIC_BRACKET_CONFIG_VERSION);
    // A spot check that the reader did not flatten or coerce: a quoted decimal
    // stays a string, an unquoted integer stays a number, a bool stays a bool.
    const flat = flatten(config as never);
    expect(flat.get("entry.trigger_price_lte")).toBe("0.35");
    expect(flat.get("exit.maximum_holding_seconds")).toBe(180);
    expect(flat.get("exit.allow_resolution_hold")).toBe(false);
  });

  it("models every §13.2 field: the fixture config carries each one with §13.2's value", () => {
    const specified = flatten(handoffConfig() as never);
    const fixture = flatten(baseConfig() as never);
    for (const [path, value] of specified) {
      expect(fixture.has(path), `§13.2 field ${path} is missing from the grammar`).toBe(true);
      expect(fixture.get(path), `§13.2 field ${path} was modeled with a different value`).toEqual(
        value,
      );
    }
  });

  it("adds exactly the disclosed fields and nothing else", () => {
    const specified = new Set(flatten(handoffConfig() as never).keys());
    const fixture = [...flatten(baseConfig() as never).keys()];
    const added = fixture.filter((path) => !specified.has(path)).sort();
    expect(added).toEqual([...DISCLOSED_ADDITIONS].sort());
  });

  it("REFUSES §13.2's block on its own — no field is defaulted", () => {
    const result = validateStaticBracketParams(handoffConfig());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The refusal names a path, and it names a MISSING key rather than
    // complaining about a value §13.2 states.
    expect(result.problem).toMatch(/is required and absent/u);
    expect(result.problem).toMatch(/this grammar has no defaults/u);
  });

  it("accepts the §13.2 block once the disclosed fields are supplied", () => {
    const result = validateStaticBracketParams(baseConfig());
    expect(result.ok).toBe(true);
  });

  it("every single field is required: removing any one of them refuses by path", () => {
    const paths = [...flatten(baseConfig() as never).keys()];
    expect(paths.length).toBeGreaterThan(35);
    const survivors: string[] = [];
    for (const path of paths) {
      const result = validateStaticBracketParams(configWith({ [path]: DELETE }));
      if (result.ok) {
        survivors.push(path);
        continue;
      }
      expect(result.problem, `removing ${path} must name it`).toContain(
        path.split(".").slice(-1)[0] as string,
      );
    }
    expect(survivors, "these fields were accepted while absent").toEqual([]);
  });

  it("validation is IDEMPOTENT: the parsed value validates to itself", () => {
    const once = staticBracketParamsSchema.safeParse(baseConfig());
    expect(once.success).toBe(true);
    if (!once.success) return;
    const twice = staticBracketParamsSchema.safeParse(once.data);
    expect(twice.success).toBe(true);
    if (!twice.success) return;
    expect(JSON.stringify(twice.data)).toBe(JSON.stringify(once.data));
  });

  it("emits a prototype-free, frozen, total tree", () => {
    const parsed = validateStaticBracketParams(baseConfig());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const value = parsed.value as unknown as Record<string, unknown>;
    expect(Object.getPrototypeOf(value)).toBeNull();
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.getPrototypeOf(value["entry"] as object)).toBeNull();
    expect(Object.isFrozen(value["entry"] as object)).toBe(true);
    expect(
      Object.getPrototypeOf((value["entry"] as Record<string, unknown>)["execution"] as object),
    ).toBeNull();
  });

  it("refuses a configuration for another strategy rather than reinterpreting it", () => {
    const result = validateStaticBracketParams(configWith({ strategy: "momentum" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem).toContain("static-bracket");
  });

  it("refuses an unknown configuration key rather than ignoring it", () => {
    const config = clone(baseConfig());
    (config as Record<string, unknown>)["extra"] = 1;
    const result = validateStaticBracketParams(config);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem).toContain("params.extra");
  });

  // `THROUGHPUT-1c` (ADR-023 D6): this pinned `version: 2` as unimplemented
  // until grammar version 2 existed. The refusal of an UNIMPLEMENTED version
  // is unchanged; it now names the set this build implements.
  it("refuses a version this build does not implement", () => {
    for (const version of [0, 3, 4]) {
      const result = validateStaticBracketParams(configWith({ version }));
      expect(result.ok, `version ${String(version)}`).toBe(false);
      if (result.ok) continue;
      expect(result.problem).toContain("params.version");
    }
    const three = validateStaticBracketParams(configWith({ version: 3 }));
    expect(three.ok).toBe(false);
    if (three.ok) return;
    expect(three.problem).toContain("must be one of 1, 2");
    expect(three.problem).toContain("exactly these configuration grammar versions");
  });
});

describe("grammar version 2 (THROUGHPUT-1c, ADR-023 D6)", () => {
  const V2_KEY = "quality.input_feed_ages@polymarket.book";

  it("exports the implemented versions, oldest first", () => {
    expect(STATIC_BRACKET_CONFIG_VERSIONS).toEqual([1, 2]);
    expect(STATIC_BRACKET_CONFIG_VERSION).toBe(1);
    expect(STATIC_BRACKET_CONFIG_VERSION_2).toBe(2);
    expect(BOOK_AGE_FEATURE_KEY).toBe(V2_KEY);
  });

  it("a version-1 document loads unchanged and carries no book_age_feature_key", () => {
    const result = validateStaticBracketParams(baseConfig());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.version).toBe(1);
    expect(Object.hasOwn(result.value.data_quality, "book_age_feature_key")).toBe(false);
  });

  it("refuses book_age_feature_key in a version-1 document (an unknown key)", () => {
    const result = validateStaticBracketParams(
      configWith({ "data_quality.book_age_feature_key": V2_KEY }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem).toContain("book_age_feature_key");
  });

  it("requires book_age_feature_key in a version-2 document", () => {
    const result = validateStaticBracketParams(configWith({ version: 2 }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem).toContain("params.data_quality.book_age_feature_key");
  });

  it("accepts a version-2 document naming the one defined key, idempotently", () => {
    const result = validateStaticBracketParams(
      configWith({ version: 2, "data_quality.book_age_feature_key": V2_KEY }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.version).toBe(2);
    expect(result.value.data_quality.book_age_feature_key).toBe(V2_KEY);
    const again = validateStaticBracketParams(result.value);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value).toEqual(result.value);
  });

  it("refuses any other feature key as a book age", () => {
    for (const key of [
      "quality.input_feed_ages@reference.binance",
      "quality.input_feed_ages",
      "quality.active_incidents@any",
      "polymarket.best_ask",
      "not.a.feature@polymarket.book",
    ]) {
      const result = validateStaticBracketParams(
        configWith({ version: 2, "data_quality.book_age_feature_key": key }),
      );
      expect(result.ok, key).toBe(false);
    }
  });
});

describe("cross-field coherence", () => {
  const cases: { name: string; edits: Record<string, unknown>; expect: RegExp }[] = [
    {
      name: "a passive price above the buy cap",
      edits: { "entry.execution.passive_price": "0.4" },
      expect: /breach its own price cap/u,
    },
    {
      name: "a risk cap below the configured size",
      edits: { "risk.maximum_position_shares": "10" },
      expect: /could ever pass its own risk cap/u,
    },
    {
      name: "a minimum fill above the configured size",
      edits: { "entry.execution.minimum_fill_shares": "60" },
      expect: /exceeds entry.size_shares/u,
    },
    {
      name: "an entry cutoff earlier than the exit cutoff",
      edits: { "exit.entry_cutoff_before_close_seconds": 10 },
      expect: /open a position after the moment it is required to close one/u,
    },
    {
      name: "HOLD_TO_RESOLUTION with resolution holds disallowed",
      edits: { "exit.final_policy": "HOLD_TO_RESOLUTION" },
      expect: /may not contradict each other/u,
    },
    {
      name: "a stop floor above its own trigger",
      edits: { "exit.stop.minimum_sell_price": "0.3" },
      expect: /could never fill at its own floor/u,
    },
    {
      name: "post-only with a taker liquidity preference",
      edits: { "exit.take_profit.liquidity_preference": "TAKER_OK" },
      expect: /post-only applies only to resting limit orders/u,
    },
    {
      name: "a participation cap of zero",
      edits: { "risk.maximum_book_participation": "0" },
      expect: /can never trade/u,
    },
  ];

  for (const testCase of cases) {
    it(`refuses ${testCase.name}`, () => {
      const result = validateStaticBracketParams(configWith(testCase.edits));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.problem).toMatch(testCase.expect);
    });
  }
});
