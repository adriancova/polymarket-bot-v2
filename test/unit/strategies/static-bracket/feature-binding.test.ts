/**
 * The trigger bindings against the REAL feature registry.
 *
 * `packages/features` is layer 1, like this package, and no §2.1 same-layer
 * edge permits importing it (F13), so the v1 id list ships here as a COPY. A
 * copy is only as good as its binding, so this file binds it twice:
 *
 * 1. against the shipped `FEATURE_IDS_V1` of `packages/features` (imported
 *    relatively in the root test tree, which creates no workspace edge — the
 *    `ports.test.ts` precedent);
 * 2. against the registry table in `docs/contracts/features-v1.md`, expanded
 *    from the document's own brace templates.
 *
 * And it binds the §13.2 basis vocabulary to the registry's own semantics: the
 * `executable_ask` basis must map to the feature the CONTRACT describes as
 * walking the asks.
 */

import { describe, expect, it } from "vitest";

import { FEATURE_IDS_V1 as REGISTRY_IDS } from "../../../../packages/features/src/index.js";
import {
  BASIS_FEATURE_ID,
  FEATURE_IDS_V1,
  INCIDENT_FEATURE_ID,
  TRIGGER_BASES,
  isFeatureIdV1,
  parseFeatureKey,
} from "../../../../packages/strategies/static-bracket/src/index.js";
import { readRepoFile } from "./handoff.js";

/** Expands `a.{x,y}.b` into every concrete id it denotes. */
function expandBraces(token: string): string[] {
  const match = /\{([^}]*)\}/u.exec(token);
  if (match === null) return [token];
  const options = (match[1] ?? "").split(",");
  const expanded: string[] = [];
  for (const option of options) {
    expanded.push(
      ...expandBraces(
        token.slice(0, match.index) + option.trim() + token.slice(match.index + match[0].length),
      ),
    );
  }
  return expanded;
}

function documentedIds(): Set<string> {
  const contract = readRepoFile("docs/contracts/features-v1.md");
  const ids = new Set<string>();
  const pattern = /`([a-z][a-z0-9_.{},]*\.[a-z0-9_.{},]+)`/gu;
  let match = pattern.exec(contract);
  while (match !== null) {
    for (const id of expandBraces(match[1] ?? "")) {
      ids.add(id);
    }
    match = pattern.exec(contract);
  }
  return ids;
}

describe("the v1 feature-id copy is bound to the real registry", () => {
  it("is exactly the shipped registry of `packages/features`", () => {
    expect([...FEATURE_IDS_V1]).toEqual([...REGISTRY_IDS]);
  });

  it("has the 33 members the contract says feature set v1 has", () => {
    const contract = readRepoFile("docs/contracts/features-v1.md");
    const heading = /## 7\. The v1 registry \((\d+) features\)/u.exec(contract);
    expect(heading, "the registry heading moved").not.toBeNull();
    expect(FEATURE_IDS_V1).toHaveLength(Number(heading?.[1]));
    expect(FEATURE_IDS_V1).toHaveLength(33);
  });

  it("names only ids the contract document itself lists", () => {
    const documented = documentedIds();
    for (const id of FEATURE_IDS_V1) {
      expect(documented.has(id), `${id} is not documented in features-v1.md`).toBe(true);
    }
  });

  it("is sorted and free of duplicates, like the registry it copies", () => {
    expect([...FEATURE_IDS_V1]).toEqual([...FEATURE_IDS_V1].sort());
    expect(new Set(FEATURE_IDS_V1).size).toBe(FEATURE_IDS_V1.length);
  });
});

describe("§13.2 trigger bases bind to the features the engine computes", () => {
  it("maps every basis to a real registry id", () => {
    for (const basis of TRIGGER_BASES) {
      const id = BASIS_FEATURE_ID[basis];
      expect(isFeatureIdV1(id), `${basis} -> ${id}`).toBe(true);
      expect(REGISTRY_IDS).toContain(id);
    }
  });

  it("maps executable_ask to the feature the CONTRACT says walks the asks", () => {
    const contract = readRepoFile("docs/contracts/features-v1.md");
    const buyRow = contract
      .split("\n")
      .find((line) => line.includes("`polymarket.executable_buy_price`"));
    const sellRow = contract
      .split("\n")
      .find((line) => line.includes("`polymarket.executable_sell_price`"));
    expect(buyRow, "the executable_buy_price row moved").toBeDefined();
    expect(sellRow, "the executable_sell_price row moved").toBeDefined();
    expect(buyRow).toContain("walking asks");
    expect(sellRow).toContain("walking bids");
    expect(BASIS_FEATURE_ID.executable_ask).toBe("polymarket.executable_buy_price");
    expect(BASIS_FEATURE_ID.executable_bid).toBe("polymarket.executable_sell_price");
  });

  it("binds the incident flag to the registry's own quality feature", () => {
    expect(isFeatureIdV1(INCIDENT_FEATURE_ID)).toBe(true);
    expect(INCIDENT_FEATURE_ID).toBe("quality.active_incidents");
  });
});

describe("the feature-key grammar", () => {
  const accepted = [
    "polymarket.executable_buy_price",
    "polymarket.executable_buy_price@50",
    "polymarket.executable_buy_price@quantity-50",
    "polymarket.executable_buy_price@50.5",
  ];

  for (const key of accepted) {
    it(`accepts ${key}`, () => {
      const parsed = parseFeatureKey(key, "entry.trigger_feature_key", null);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.value.featureId).toBe("polymarket.executable_buy_price");
      expect(parsed.value.key).toBe(key);
    });
  }

  const refused: { key: unknown; expected: RegExp }[] = [
    { key: "", expected: /non-empty feature key/u },
    { key: 42, expected: /non-empty feature key/u },
    { key: null, expected: /non-empty feature key/u },
    { key: "polymarket.made_up", expected: /not a member of feature set v1/u },
    { key: "POLYMARKET.EXECUTABLE_BUY_PRICE", expected: /not a member of feature set v1/u },
    { key: "polymarket.executable_buy_price@", expected: /unusable projection selector/u },
    { key: "polymarket.executable_buy_price@a b", expected: /unusable projection selector/u },
    { key: `polymarket.executable_buy_price@${"x".repeat(33)}`, expected: /unusable projection selector/u },
    { key: `polymarket.executable_buy_price${"@x".repeat(60)}`, expected: /at most 96 characters/u },
  ];

  for (const testCase of refused) {
    it(`refuses ${JSON.stringify(testCase.key)}`, () => {
      const parsed = parseFeatureKey(testCase.key, "entry.trigger_feature_key", null);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.problem).toMatch(testCase.expected);
    });
  }

  it("refuses a key whose id contradicts the expected basis", () => {
    const parsed = parseFeatureKey(
      "polymarket.midpoint@x",
      "entry.trigger_feature_key",
      "polymarket.executable_buy_price",
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.problem).toMatch(/may not disagree/u);
  });
});
