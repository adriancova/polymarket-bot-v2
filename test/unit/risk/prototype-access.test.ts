/**
 * THE MECHANISM, PART 1 — every prototype-consulting construct in both
 * packages is classified, or the build fails naming it.
 *
 * WHY THIS TEST EXISTS RATHER THAN ANOTHER SWEEP. Four consecutive review
 * rounds falsified a hand-made list here (round 3's identity fields, round 4's
 * `Object.entries` walk, round 5's "every table now uses `ownEntry`" claim,
 * round 6's discovery that round 5 had missed `reserve.ts`'s three sites, the
 * `exposure.ts` global lookup and the `in` operator entirely — one of which was
 * a FAIL-OPEN on the live-ownership gate). Every one of those was "I looked and
 * fixed what I found".
 *
 * So the site list is no longer produced by looking. `prototype-access-scan.ts`
 * asks the TypeScript compiler for every element access, `in`, computed
 * compound assignment, `delete`, spread and `Object.assign` in both packages,
 * and this test requires each one to be either
 *
 * - an OWN-PROPERTY PRIMITIVE (the body of `ownEntry` / `ownFlag`), or
 * - an EXPLICITLY REGISTERED exception carrying a REASON,
 *
 * with the number of matching sites pinned, so a new site — or one more copy of
 * an already-registered one — fails by name. A registration that no longer
 * matches anything fails too, so the table cannot rot into fiction.
 *
 * WHAT THIS DOES NOT COVER, STATED SO IT IS NOT A FIFTH ABSOLUTE:
 *
 * - a DOTTED read (`caps.liveMicroMaxOrderNotional`) also consults the
 *   prototype. Every field read in both packages is one, so a syntactic rule
 *   over them would be noise. That class is covered behaviourally instead, by
 *   `inherited-state.test.ts`, which augments `Object.prototype` with the names
 *   these packages actually use and requires every public answer to be
 *   unchanged. It is what caught the live-micro caps hole, which no syntactic
 *   rule would have flagged;
 * - `test/unit/risk/*.test.ts` is not scanned. `fixtures.ts` IS, because review
 *   round 5 found this defect class in it and a fixture that silently measures
 *   nothing makes every test above it vacuous. The suite files themselves are
 *   assertions, not product, and are covered by the weaker per-file budget
 *   below for the colocated `packages/**` test file the census does reach.
 */

import { describe, expect, it } from "vitest";

import {
  censusOfPrototypeAccess,
  censusOfSourceText,
  scannedFiles,
  type AccessKind,
  type AccessSite,
} from "./prototype-access-scan.js";

/** The own-property primitives themselves. */
const OWN_PRIMITIVE =
  "the own-property primitive itself: the read is guarded by `Object.hasOwn` on the line above, and every table read in the package goes through this function";

/** A spread of an object literal built in the same expression. */
const OWN_LITERAL =
  "a conditional spread of an object literal built in this expression (`{}` or a one-field literal); no caller-derived object is read";

/** A spread that copies own enumerable properties of a value we materialized. */
const OWN_COPY_OF_MATERIALIZED =
  "an own-only copy of a value this package MATERIALIZED (`readPlainData` / `readRecordData`), whose objects carry no prototype at all since review round 6";

/** A spread of a package-built table whose reads are all own-property reads. */
const OWN_COPY_OF_OUR_TABLE =
  "an own-only copy of a table this package built; every read of the result goes through `ownEntry` and every write through `setOwn`, so the copy's `Object.prototype` is not reachable by any lookup";

/** A spread of a state this package built and froze. */
const OWN_COPY_OF_OUR_STATE =
  "an own-only copy of a state this package built and deep-froze; the copy's keyed tables are only ever read through `ownEntry`";

/** `{ [k]: v }` — CreateDataProperty, which consults no setter. */
const CREATE_DATA_PROPERTY =
  "a computed key in an object literal is `CreateDataProperty`: it defines an OWN property and consults no inherited setter (unlike `o[k] = v`)";

/** A fixture builder's override spread. */
const FIXTURE_OVERRIDES =
  "a fixture builder's override spread over its own literal; the fixture tree is handed to a public door, which materializes it before anything reads it";

interface Registration {
  readonly file: string;
  readonly enclosing: string;
  readonly kind: AccessKind;
  readonly text: string;
  /** How many sites match exactly this key. Pinned so a copy cannot hide. */
  readonly count: number;
  readonly reason: string;
}

const REGISTERED: readonly Registration[] = [
  // --- the own-property primitives ------------------------------------------
  {
    file: "packages/risk/src/guards.ts",
    enclosing: "ownEntry",
    kind: "element-read",
    text: "table[key]",
    count: 1,
    reason: OWN_PRIMITIVE,
  },
  {
    file: "packages/risk/src/guards.ts",
    enclosing: "ownFlag",
    kind: "element-read",
    text: "(flags as Record<string, unknown>)[key]",
    count: 1,
    reason: OWN_PRIMITIVE,
  },
  {
    file: "packages/capital-allocator/src/guards.ts",
    enclosing: "ownEntry",
    kind: "element-read",
    text: "table[key]",
    count: 1,
    reason: OWN_PRIMITIVE,
  },
  {
    file: "packages/capital-allocator/src/guards.ts",
    enclosing: "ownFlag",
    kind: "element-read",
    text: "(flags as Record<string, unknown>)[key]",
    count: 1,
    reason: OWN_PRIMITIVE,
  },

  // --- risk -----------------------------------------------------------------
  {
    file: "packages/risk/src/approved-intent.ts",
    enclosing: "resizeApprovedIntentInner",
    kind: "object-spread",
    text: "...inherited.intent",
    count: 2,
    reason: OWN_COPY_OF_MATERIALIZED,
  },
  {
    file: "packages/risk/src/approved-intent.ts",
    enclosing: "resizeApprovedIntentInner",
    kind: "object-spread",
    text: "...(inherited.sourceIntentId === undefined ? {} : { sourceIntentId: inherited.sourceIntentId })",
    count: 1,
    reason: OWN_LITERAL,
  },
  {
    file: "packages/risk/src/engine.ts",
    enclosing: "evaluateIntentInner",
    kind: "object-spread",
    text: "...(view.intentId === undefined ? {} : { sourceIntentId: view.intentId })",
    count: 2,
    reason: OWN_LITERAL,
  },
  {
    file: "packages/risk/src/recommendations.ts",
    enclosing: "recommendation",
    kind: "object-spread",
    text: "...(marketId === undefined ? {} : { marketId })",
    count: 1,
    reason: OWN_LITERAL,
  },

  // --- capital-allocator ----------------------------------------------------
  {
    file: "packages/capital-allocator/src/exposure.ts",
    enclosing: "withExplicitZeros",
    kind: "object-spread",
    text: "...table",
    count: 1,
    reason: OWN_COPY_OF_OUR_TABLE,
  },
  {
    file: "packages/capital-allocator/src/reserve.ts",
    enclosing: "evaluateReservationInner",
    kind: "object-spread",
    text: "...(req.scope === undefined ? {} : { scope: req.scope })",
    count: 1,
    reason: OWN_LITERAL,
  },
  {
    file: "packages/capital-allocator/src/reserve.ts",
    enclosing: "applyReservationInner",
    kind: "object-spread",
    text: "...state",
    count: 2,
    reason: OWN_COPY_OF_OUR_STATE,
  },
  {
    file: "packages/capital-allocator/src/reserve.ts",
    enclosing: "releaseReservationInner",
    kind: "object-spread",
    text: "...state",
    count: 2,
    reason: OWN_COPY_OF_OUR_STATE,
  },
  {
    file: "packages/capital-allocator/src/state.ts",
    enclosing: "check",
    kind: "computed-key",
    text: "[label]",
    count: 1,
    reason: CREATE_DATA_PROPERTY,
  },
  {
    file: "packages/capital-allocator/src/state.ts",
    enclosing: "withLiveOwnerInner",
    kind: "object-spread",
    text: "...state",
    count: 1,
    reason: OWN_COPY_OF_OUR_STATE,
  },
  {
    file: "packages/capital-allocator/src/state.ts",
    enclosing: "withLiveOwnerInner",
    kind: "object-spread",
    text: "...state.liveOwners",
    count: 1,
    reason: OWN_COPY_OF_OUR_TABLE,
  },
  {
    file: "packages/capital-allocator/src/state.ts",
    enclosing: "withLiveOwnerInner",
    kind: "computed-key",
    text: "[marketId]",
    count: 1,
    reason: CREATE_DATA_PROPERTY,
  },

  // --- the shared fixture module --------------------------------------------
  ...(
    [
      "riskPolicy",
      "market",
      "positionIntent",
      "reduceIntent",
      "cancelIntent",
      "position",
      "openOrder",
    ] as const
  ).map((enclosing) => ({
    file: "test/unit/risk/fixtures.ts",
    enclosing,
    kind: "object-spread" as const,
    text: "...overrides",
    count: 1,
    reason: FIXTURE_OVERRIDES,
  })),
  {
    file: "test/unit/risk/fixtures.ts",
    enclosing: "zeroFilled",
    kind: "object-spread",
    text: "...table",
    count: 1,
    reason:
      "the round-5 fix in the fixture: an own-only copy, then `Object.hasOwn` + `defineProperty` for every measured key, so a coverage key of `\"constructor\"` cannot read as already present",
  },
];

/**
 * Per-file budgets for the colocated SUITE files the census reaches.
 *
 * A test's `snapshot.byMarket[MARKET_A]` is an assertion against a table the
 * test itself built: an inherited answer there weakens an assertion, it does not
 * make the product unsafe. They are counted rather than individually justified,
 * and the count is pinned so that adding one is a deliberate act with a visible
 * diff.
 */
const TEST_FILE_BUDGET: readonly { readonly file: string; readonly sites: number }[] = [
  { file: "packages/capital-allocator/src/allocator.test.ts", sites: 46 },
];

function keyOf(site: { file: string; enclosing: string; kind: string; text: string }): string {
  return `${site.file}::${site.enclosing}::${site.kind}::${site.text}`;
}

function isTestFile(file: string): boolean {
  return file.endsWith(".test.ts");
}

describe("THE MECHANISM: every prototype-consulting construct is classified", () => {
  const census = censusOfPrototypeAccess();

  it("the census is non-vacuous: it loaded both packages and sees known sites", () => {
    const files = scannedFiles();
    expect(files.length).toBeGreaterThan(20);
    expect(files.some((file) => file.endsWith("/risk/src/plain-data.ts"))).toBe(true);
    expect(files.some((file) => file.endsWith("/capital-allocator/src/reserve.ts"))).toBe(true);
    expect(files.some((file) => file.endsWith("/test/unit/risk/fixtures.ts"))).toBe(true);
    // The own-property primitive is a site, in both copies. If the census
    // stopped seeing element accesses at all, this is what would say so.
    expect(
      census.filter((site) => site.enclosing === "ownEntry" && site.kind === "element-read"),
    ).toHaveLength(2);
    expect(census.length).toBeGreaterThan(50);
  });

  it("every site in the product sources and the fixtures is registered, with its count", () => {
    const groups = new Map<string, AccessSite[]>();
    for (const site of census) {
      if (isTestFile(site.file)) continue;
      const key = keyOf(site);
      const group = groups.get(key);
      if (group === undefined) groups.set(key, [site]);
      else group.push(site);
    }

    const registrations = new Map(REGISTERED.map((entry) => [keyOf(entry), entry]));
    const failures: string[] = [];

    for (const [key, sites] of groups) {
      const first = sites[0];
      if (first === undefined) continue;
      const where = sites.map((site) => `${site.file}:${String(site.line)}`).join(", ");
      const registration = registrations.get(key);
      if (registration === undefined) {
        failures.push(
          `UNREGISTERED [${first.kind}] in ${first.enclosing} at ${where} :: ${first.text}` +
            " — it must become an own-property read (`ownEntry`/`ownFlag`/`ownProperty`), an own" +
            " definition (`setOwn`/`Object.defineProperty`), or a registration in this file with a reason",
        );
        continue;
      }
      if (registration.count !== sites.length) {
        failures.push(
          `COUNT CHANGED for ${key}: registered ${String(registration.count)}, found ${String(sites.length)} at ${where}`,
        );
      }
    }

    for (const [key, registration] of registrations) {
      if (!groups.has(key)) {
        failures.push(
          `STALE REGISTRATION (nothing matches it any more): ${key} — reason on file: ${registration.reason}`,
        );
      }
    }

    expect(failures).toEqual([]);
  });

  it("every registration carries a substantive reason", () => {
    for (const registration of REGISTERED) {
      expect(registration.reason.length, keyOf(registration)).toBeGreaterThan(40);
    }
  });

  it("the colocated suite files stay within their pinned site budgets", () => {
    const counted = new Map<string, number>();
    for (const site of census) {
      if (!isTestFile(site.file)) continue;
      counted.set(site.file, (counted.get(site.file) ?? 0) + 1);
    }
    const budgets = new Map(TEST_FILE_BUDGET.map((entry) => [entry.file, entry.sites]));
    const failures: string[] = [];
    for (const [file, sites] of counted) {
      const budget = budgets.get(file);
      if (budget === undefined) {
        failures.push(`UNBUDGETED test file in the census: ${file} (${String(sites)} sites)`);
      } else if (budget !== sites) {
        failures.push(
          `BUDGET CHANGED for ${file}: pinned ${String(budget)}, found ${String(sites)} — ` +
            census
              .filter((site) => site.file === file)
              .map((site) => `${String(site.line)}:${site.kind}`)
              .join(" "),
        );
      }
    }
    for (const [file] of budgets) {
      if (!counted.has(file)) failures.push(`STALE BUDGET: ${file} has no sites at all`);
    }
    expect(failures).toEqual([]);
  });
});

describe("THE MECHANISM: the detector sees each construct this package has been caught by", () => {
  /**
   * THE FOUR HISTORICAL MISSES, AS SYNTAX.
   *
   * Each entry is a construct a previous round shipped and a later round found.
   * They are run through the detector directly, so the mechanism's claim — "a
   * prototype-consulting read cannot be reintroduced silently" — is checked in
   * the suite rather than only in a mutation run recorded in a handoff.
   */
  const HISTORICAL: readonly {
    readonly round: string;
    readonly source: string;
    readonly kind: AccessKind;
  }[] = [
    {
      round: "round 4 — the materializer's assignment (`out[key] = value` runs an inherited SETTER)",
      source: "function f(out: Record<string, unknown>, key: string, value: unknown) { out[key] = value; }",
      kind: "element-write",
    },
    {
      round: "round 5 — the table accumulator (`table[key] ??= …` READS through the chain)",
      source: "function f(table: Record<string, unknown>, key: string) { table[key] ??= {}; }",
      kind: "element-compound",
    },
    {
      round: "round 6 — the live-ownership read (`state.liveOwners[req.marketId]`, a FAIL-OPEN)",
      source: "function f(state: { liveOwners: Record<string, string> }, id: string) { return state.liveOwners[id]; }",
      kind: "element-read",
    },
    {
      round: "round 6 — the `in` operator (`\"intentId\" in intent`, the cancel trap)",
      source: 'function f(intent: object) { return "intentId" in intent; }',
      kind: "in",
    },
    {
      round: "round 6 — the descriptor test (`\"value\" in descriptor`, an accessor read as data)",
      source: 'function f(d: PropertyDescriptor) { return "value" in d; }',
      kind: "in",
    },
    {
      round: "round 6 — the exposure global lookup (`finalize(t)[GLOBAL_KEY]`)",
      source: "function f(t: Record<string, unknown>) { return t[GLOBAL_KEY]; }",
      kind: "element-read",
    },
  ];

  for (const probe of HISTORICAL) {
    it(`detects: ${probe.round}`, () => {
      const sites = censusOfSourceText(probe.source);
      expect(sites.map((site) => site.kind)).toContain(probe.kind);
    });
  }

  it("detects a delete, an Object.assign and a computed key too", () => {
    expect(
      censusOfSourceText("function f(o: Record<string, unknown>, k: string) { delete o[k]; }").map(
        (site) => site.kind,
      ),
    ).toContain("delete-element");
    expect(
      censusOfSourceText(
        "function f(t: object, s: object) { return Object.assign(t, s); }",
      ).map((site) => site.kind),
    ).toContain("object-assign");
    expect(
      censusOfSourceText("function f(k: string, v: unknown) { return { [k]: v }; }").map(
        (site) => site.kind,
      ),
    ).toContain("computed-key");
  });

  it("does not report a plain dotted read, which is the documented boundary of this rule", () => {
    expect(censusOfSourceText("function f(o: { a: number }) { return o.a; }")).toEqual([]);
  });

  it("reports the enclosing function and the line, so a failure names the site", () => {
    const sites = censusOfSourceText(
      "function outer(o: Record<string, unknown>, k: string) {\n  return o[k];\n}\n",
    );
    expect(sites).toHaveLength(1);
    expect(sites[0]?.enclosing).toBe("outer");
    expect(sites[0]?.line).toBe(2);
    expect(sites[0]?.text).toBe("o[k]");
  });
});
