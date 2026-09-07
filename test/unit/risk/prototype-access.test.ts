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
 * compound assignment, `delete`, spread, `Object.assign`, DESTRUCTURING,
 * `for…in`, `Reflect.*`, `Object.entries`/`values`/`keys`,
 * `Object.getOwnPropertyNames` and `structuredClone` in both packages, and this
 * test requires each one to be either
 *
 * - an OWN-PROPERTY PRIMITIVE (the body of `ownEntry` / `ownFlag`), or
 * - an EXPLICITLY REGISTERED exception carrying a REASON,
 *
 * with the number of matching sites pinned, so a new site — or one more copy of
 * an already-registered one — fails by name. A registration that no longer
 * matches anything fails too, so the table cannot rot into fiction.
 *
 * WHAT THIS DOES NOT COVER, STATED SO IT IS NOT A FIFTH ABSOLUTE. Round 6 named
 * ONE excluded form (the dotted read). Review round 7 measured the detector and
 * found four more silent — destructuring, `Reflect.get`, `for…in` and
 * `structuredClone` — so the primary build mechanism would have accepted any of
 * them as a future regression without classifying it. Those four are detected
 * now, and the COMPLETE exclusion list is stated in the `prototype-access-scan
 * .ts` module header, items 1–7, with the mechanism that covers each instead.
 * The negative probes at the bottom of this file exercise that list, so it is
 * checked rather than merely written. Two boundaries of this file itself:
 *
 * - a DOTTED read is excluded (item 1) and is covered behaviourally, by
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
  ACCESS_KINDS,
  censusOfPrototypeAccess,
  censusOfSourceText,
  diagnosticsOfSourceText,
  scannedFiles,
  schemaParseSites,
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

/** `Reflect.ownKeys` / `Object.getOwnPropertyNames` — the safe enumeration. */
const OWN_ENUMERATION_PRIMITIVE =
  "own-only and accessor-free: it reports OWN property NAMES and invokes no getter, which is exactly why this review chain prescribes it over `Object.entries`/`for…in`. Enumerated by the census for TOTALITY, not because the site is risky (review round 7)";

/** `Object.entries` over a table this package built itself. */
const ENTRIES_OF_OUR_TABLE =
  "`Object.entries` is own-only but INVOKES every own getter, so it may run only on a value this package built. This table is constructed in this module from validated data, with `setOwn`, and never holds an accessor";

/** `Object.entries` over a value a door already materialized. */
const ENTRIES_OF_MATERIALIZED =
  "`Object.entries` is own-only but INVOKES every own getter, so it may run only on a value this package materialized. This one is a validated policy's own limits object, which came out of `readPlainData` as prototype-free own data with no accessor anywhere in it";

/** `Object.create(null)` / `Object.setPrototypeOf(x, null)` — the chain REMOVED. */
const PROTOTYPE_REMOVED =
  "the argument is the literal `null`: this is the primitive that REMOVES the prototype chain rather than installing one, and it is how every container this package builds — a materialized record, a descriptor, the arena's assembly target — stops being able to answer a read from `Object.prototype` (review rounds 6 and 8)";

/** `Object.getPrototypeOf` used to REFUSE rather than to trust. */
const PROTOTYPE_READ_TO_REFUSE =
  "reads the chain in order to REFUSE: the answer is compared against `Object.prototype` / `Array.prototype` / `null` and anything else is rejected as a non-plain prototype, so the read decides to say NO — it never makes an inherited value usable. Wrapped, so a throwing read is a refusal at a named path";

/** `Object.getPrototypeOf` used to CLASSIFY a library-owned definition slot. */
const PROTOTYPE_READ_TO_CLASSIFY =
  "reads the chain to classify one slot of the schema library's own definition object: an ordinary object may be a container of schemas and is copied, anything else is carried through untouched. The value is the library's, built at module load from this repository's own declarations, and the read decides only whether to DESCEND";

/** The live-micro fence's deliberate chain walk. */
const PROTOTYPE_READ_FENCE =
  "the live-micro fence walks the chain ON PURPOSE (review round 6, BLOCKER 1): the enforcement site reads `caps.liveMicroMaxOrderNotional` with a dotted read, which WOULD find an inherited value, so `absent` here has to mean UNREACHABLE rather than `undefined`. Every failure answers TRUE — `it might be there` is the fail-closed direction for an `AGENTS.md` floor";

/** The arena's read of one slot of the library's own schema definition. */
const READ_OF_LIBRARY_DEF =
  "a plain read of one OWN slot of the schema library's definition object, by a name taken from `Object.getOwnPropertyNames` on the calling line. A descriptor read would be wrong here: an object schema stores its `shape` behind a memoizing GETTER, and the arena needs the shape. Nothing caller-supplied is reachable — these definitions are built at module load from this repository's own schema declarations (review round 8)";

/** Destructuring a record this module built one expression earlier. */
const DESTRUCTURE_OF_OUR_RECORD =
  "destructuring is one `Get` per name — the prototype chain, and any getter — so it may run only on a value this package built. These are the `{ field, value }` records `internalIdentityFields` constructs as object literals in this same module (review round 7)";

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

  // --- the own-only enumeration primitives (review round 7) -----------------
  ...(
    [
      { file: "packages/risk/src/guards.ts", enclosing: "freezeRecursive", text: "Reflect.ownKeys(value)" },
      { file: "packages/risk/src/plain-data.ts", enclosing: "ownStringKeys", text: "Reflect.ownKeys(container)" },
      { file: "packages/risk/src/plain-data.ts", enclosing: "copyPlainData", text: "Object.getOwnPropertyNames(value)" },
      { file: "packages/risk/src/plain-data.ts", enclosing: "ownDataDetails", text: "Object.getOwnPropertyNames(details)" },
      { file: "packages/capital-allocator/src/guards.ts", enclosing: "freezeRecursive", text: "Reflect.ownKeys(value)" },
    ] as const
  ).map((site) => ({ ...site, kind: "own-enumeration" as const, count: 1, reason: OWN_ENUMERATION_PRIMITIVE })),

  // --- the round-8 parsing arena ---------------------------------------------
  // Registered once, not twice: `WP-180-FU2` collapsed the mirrored copy in
  // `packages/capital-allocator` into this one on 2026-09-04, and the allocator
  // now imports it across the §2.1 S3 edge. Every site below is unchanged — the
  // module's body was not edited by the collapse, only its duplication removed.
  // `test/unit/execution-planner/mirrors.test.ts` fails if a copy reappears, so
  // a second package's sites cannot return unregistered.
  ...(["risk"] as const).flatMap((packageName) => {
    const file = `packages/${packageName}/src/schema-arena.ts`;
    return [
      {
        file,
        enclosing: "readSlot",
        kind: "element-read" as const,
        text: "source[name]",
        count: 1,
        reason: READ_OF_LIBRARY_DEF,
      },
      ...(
        [
          { enclosing: "isFreshOrdinaryContainer", text: "Object.getOwnPropertyNames(value)" },
          { enclosing: "isFreshOrdinaryContainer", text: "Object.getOwnPropertySymbols(value)" },
          { enclosing: "arenaContext", text: "Object.getOwnPropertyNames(given)" },
          {
            enclosing: "arenaSlot",
            text: "Object.getOwnPropertyNames(value as Record<string, unknown>)",
          },
          { enclosing: "arenaNode", text: "Object.getOwnPropertyNames(def)" },
          // round 9: the check copy walks the check's definition and the
          // original's instance slots by OWN names, both at build time
          { enclosing: "arenaCheck", text: "Object.getOwnPropertyNames(def)" },
          { enclosing: "arenaCheck", text: "Object.getOwnPropertyNames(originalSlots)" },
        ] as const
      ).map((site) => ({
        ...site,
        file,
        kind: "own-enumeration" as const,
        count: 1,
        reason: OWN_ENUMERATION_PRIMITIVE,
      })),
      // --- round 9: the class fix — sever the library's own state containers -
      {
        file,
        enclosing: "severOrdinaryChain",
        kind: "prototype-read" as const,
        text: "Object.getPrototypeOf(container)",
        count: 1,
        reason:
          `${PROTOTYPE_READ_TO_CLASSIFY} — the question here is which of three states the` +
          " library's state container is in: ordinary (sever it), already prototype-free" +
          " (done), or something the arena has never measured (REFUSE the build, loudly —" +
          " review round 9, where an ordinary `_zod` container answered `optin`/`optout`" +
          " from `Object.prototype` and waived required keys)",
      },
      {
        file,
        enclosing: "severOrdinaryChain",
        kind: "prototype-write" as const,
        text: "Object.setPrototypeOf(container, null)",
        count: 1,
        reason:
          `${PROTOTYPE_REMOVED} — review round 9's class fix: the library keeps per-node` +
          " state in ordinary literals (`_zod`, its `bag`, the rebuilt `shape`, the" +
          " `propValues` table) and its parse path reads OPTIONAL fields off them, so the" +
          " chain those reads walked is removed at build time rather than the two caught" +
          " names being pinned",
      },
      {
        file,
        enclosing: "arenaSlot",
        kind: "prototype-read" as const,
        text: "Object.getPrototypeOf(value)",
        count: 1,
        reason: PROTOTYPE_READ_TO_CLASSIFY,
      },
      {
        file,
        enclosing: "isFreshOrdinaryContainer",
        kind: "prototype-read" as const,
        text: "Object.getPrototypeOf(value)",
        count: 2,
        reason: `${PROTOTYPE_READ_TO_CLASSIFY} — here the question is narrower still: is this the FRESH, EMPTY ordinary container the library assigns when it starts assembling? Anything else, including a value that is already prototype-free, is left exactly as it is`,
      },
      {
        file,
        enclosing: "emptySlots",
        kind: "prototype-write" as const,
        text: "Object.create(null)",
        count: 1,
        reason: PROTOTYPE_REMOVED,
      },
      {
        file,
        enclosing: "prototypeFreeContainer",
        kind: "prototype-write" as const,
        text: "Object.setPrototypeOf(items, null)",
        count: 1,
        reason: `${PROTOTYPE_REMOVED} — the array case: an array with no prototype is still an array exotic object, so \`length\` and \`Array.isArray\` still work and \`items[i] = …\` has no chain to walk`,
      },
    ];
  }),

  // --- the prototype primitives in the data-record boundary -----------------
  // Registered once for the same reason as the arena above (`WP-180-FU2`).
  ...(["risk"] as const).flatMap((packageName) => {
    const file = `packages/${packageName}/src/plain-data.ts`;
    return [
      {
        file,
        enclosing: "readInto",
        kind: "prototype-read" as const,
        text: "Object.getPrototypeOf(container)",
        count: 1,
        reason: PROTOTYPE_READ_TO_REFUSE,
      },
      ...(["emptyRecord", "ownDataDescriptor", "ownAccessorDescriptor"] as const).map(
        (enclosing) => ({
          file,
          enclosing,
          kind: "prototype-write" as const,
          text: "Object.create(null)",
          count: 1,
          reason: PROTOTYPE_REMOVED,
        }),
      ),
    ];
  }),
  {
    file: "packages/capital-allocator/src/caps.ts",
    enclosing: "reachableThroughPrototype",
    kind: "prototype-read",
    text: "Object.getPrototypeOf(current)",
    count: 1,
    reason: PROTOTYPE_READ_FENCE,
  },

  // --- `Object.entries`, which INVOKES own getters (review round 7) ---------
  {
    file: "packages/risk/src/exposure-limits.ts",
    enclosing: "checkExposureLimits",
    kind: "object-entries",
    text: "Object.entries(limits)",
    count: 1,
    reason: ENTRIES_OF_MATERIALIZED,
  },
  {
    file: "packages/capital-allocator/src/exposure.ts",
    enclosing: "finalize",
    kind: "object-entries",
    text: "Object.entries(table)",
    count: 1,
    reason: ENTRIES_OF_OUR_TABLE,
  },
  {
    file: "packages/capital-allocator/src/state.ts",
    enclosing: "createAllocatorStateInner",
    kind: "object-entries",
    text: "Object.entries(reserved)",
    count: 1,
    reason: `${ENTRIES_OF_OUR_TABLE} — \`reservedSharesByKey\` builds it with \`setOwn\` from the validated state`,
  },

  // --- destructuring, which is one `Get` per name (review round 7) ----------
  {
    file: "packages/risk/src/inputs.ts",
    enclosing: "identityRefusals",
    kind: "object-destructure",
    text: "{ field, value }",
    count: 1,
    reason: DESTRUCTURE_OF_OUR_RECORD,
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
  // 46 at round 6; 53 once round 7's detector also saw this file's
  // `Reflect.get`/`has`/`ownKeys`/`getOwnPropertyDescriptor` (the hostile-proxy
  // handler) and its `Object.keys` assertions; 54 once round 8's detector also
  // sees its one `Object.getPrototypeOf` assertion (line 1130).
  { file: "packages/capital-allocator/src/allocator.test.ts", sites: 54 },
  // `WP-180-FU3`: the `"null"` node measurement, colocated with the module
  // because `zod` is a dependency of the PACKAGE and is deliberately not
  // resolvable from the shared test tree (the file's own header records why).
  // Its ten sites are the measurement ITSELF — `Object.getOwnPropertyNames` and
  // `Object.getPrototypeOf` over `z.null()._zod` and its `def`, plus the
  // pollution-name table and one `def["type"]` read. A file whose subject is
  // "what does this node own" cannot avoid asking what it owns; the count is
  // pinned so that adding an eleventh is a deliberate act with a visible diff.
  { file: "packages/risk/src/schema-arena-null.test.ts", sites: 10 },
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

/**
 * THE ROUND-8 PIN — every door asks a PARSING COPY, never the raw schema.
 *
 * The round-8 BLOCKER is fixed by `schema-arena.ts`: a door parses through a
 * copy whose assembly containers and parse context have no prototype. "Every
 * door does that" must not be a thing a reviewer checks by reading, so it is
 * resolved from the syntax tree here: every `.safeParse(…)` / `.parse(…)` call
 * in either package's product sources must name a registered arena parser.
 */
const ARENA_PARSERS: readonly { readonly file: string; readonly receiver: string }[] = [
  { file: "packages/risk/src/inputs.ts", receiver: "RiskEvaluationInputParser" },
  { file: "packages/risk/src/policy.ts", receiver: "RiskPolicyParser" },
  { file: "packages/risk/src/approved-intent.ts", receiver: "ApprovedIntentRecordParser" },
  { file: "packages/risk/src/approved-intent.ts", receiver: "ResizeRequestParser" },
  { file: "packages/capital-allocator/src/state.ts", receiver: "AllocatorStateInputParser" },
  { file: "packages/capital-allocator/src/reserve.ts", receiver: "ReservationRequestParser" },
  { file: "packages/capital-allocator/src/caps.ts", receiver: "AllocatorCapsShapeParser" },
];

/** The one non-schema `parse` in either package, named so it cannot hide. */
const NON_SCHEMA_PARSE = { file: "packages/risk/src/time.ts", receiver: "Date" } as const;

describe("THE MECHANISM: every door parses through the prototype-free arena (round 8)", () => {
  const sites = schemaParseSites();

  it("is non-vacuous: it found the doors", () => {
    expect(sites.length).toBeGreaterThanOrEqual(ARENA_PARSERS.length);
    expect(sites.some((site) => site.file.endsWith("/inputs.ts"))).toBe(true);
  });

  it("every parse call names an arena parser (or the one audited exception)", () => {
    const allowed = new Set(
      [...ARENA_PARSERS, NON_SCHEMA_PARSE].map((entry) => `${entry.file}::${entry.receiver}`),
    );
    const failures = sites
      .filter((site) => !allowed.has(`${site.file}::${site.receiver}`))
      .map(
        (site) =>
          `RAW SCHEMA PARSE at ${site.file}:${String(site.line)} in ${site.enclosing} :: ` +
          `${site.receiver}.safeParse(…) — a door must ask a copy built by ` +
          "`prototypeFreeParser`, so the library's output assembly cannot reach `Object.prototype`",
      );
    expect(failures).toEqual([]);
  });

  it("every registered arena parser is actually used, so the list cannot rot", () => {
    const used = new Set(sites.map((site) => `${site.file}::${site.receiver}`));
    const stale = ARENA_PARSERS.filter((entry) => !used.has(`${entry.file}::${entry.receiver}`));
    expect(stale).toEqual([]);
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

  /**
   * THE REVIEWER'S ROUND-7 MATRIX, AS THE DETECTOR'S OWN TEST.
   *
   * Review round 7 ran `censusOfSourceText` over ten shapes and found four of
   * them SILENT and UNDISCLOSED: destructuring, `Reflect.get`, `for…in` and
   * `structuredClone`. No registered exception covered them, so a future
   * regression through any of them would have entered the build UNCLASSIFIED.
   * Each is now a kind, and each row below is one cell of that matrix.
   */
  const ROUND_7_MATRIX: readonly {
    readonly shape: string;
    readonly source: string;
    readonly kind: AccessKind;
  }[] = [
    {
      shape: "const { value } = obj — one `Get` per name, chain and getters",
      source: "function f(o: { value: number }) { const { value } = o; return value; }",
      kind: "object-destructure",
    },
    {
      shape: "function f({ value }) — the same, in a parameter",
      source: "function f({ value }: { value: number }) { return value; }",
      kind: "object-destructure",
    },
    {
      shape: "({ value } = obj) — destructuring ASSIGNMENT, which has no binding pattern",
      source: "function f(o: { value: number }) { let value = 0; ({ value } = o); return value; }",
      kind: "object-destructure",
    },
    {
      shape: "Reflect.get(obj, key) — the prototype chain by construction",
      source: "function f(o: object, k: string) { return Reflect.get(o, k); }",
      kind: "reflect-chain",
    },
    {
      shape: "Reflect.has(obj, key) — the chain, like `in`",
      source: "function f(o: object, k: string) { return Reflect.has(o, k); }",
      kind: "reflect-chain",
    },
    {
      shape: "an UNRECOGNIZED Reflect member fails closed to the chain-walking kind",
      // Parsed as TEXT by `censusOfSourceText`, never type-checked: the point is
      // that a member the table does not name is classified anyway.
      source: "function f(o: object) { return Reflect.futureMember(o); }",
      kind: "reflect-chain",
    },
    {
      shape: "for (const key in obj) — ENUMERATES inherited names",
      source: "function f(o: object) { const out: string[] = []; for (const key in o) out.push(key); return out; }",
      kind: "for-in",
    },
    {
      shape: "Object.entries(obj) — own-only, but it INVOKES every own getter",
      source: "function f(o: object) { return Object.entries(o); }",
      kind: "object-entries",
    },
    {
      shape: "Object.values(obj) — the same invocation",
      source: "function f(o: object) { return Object.values(o); }",
      kind: "object-entries",
    },
    {
      shape: "structuredClone(obj) — invokes own getters, clone inherits Object.prototype",
      source: "function f(o: object) { return structuredClone(o); }",
      kind: "structured-clone",
    },
    {
      shape: "Object.keys(obj) — own names, no getter: benign, but ENUMERATED",
      source: "function f(o: object) { return Object.keys(o); }",
      kind: "own-enumeration",
    },
    {
      shape: "Object.getOwnPropertyNames(obj) — the same, including non-enumerable",
      source: "function f(o: object) { return Object.getOwnPropertyNames(o); }",
      kind: "own-enumeration",
    },
    {
      shape: "Reflect.ownKeys(obj) — own names, symbols included",
      source: "function f(o: object) { return Reflect.ownKeys(o); }",
      kind: "own-enumeration",
    },
    {
      shape: "obj?.[key] — an optional element read is still an element read",
      source: "function f(o: Record<string, unknown> | undefined, k: string) { return o?.[k]; }",
      kind: "element-read",
    },
  ];

  for (const row of ROUND_7_MATRIX) {
    it(`round 7 — detects: ${row.shape}`, () => {
      expect(censusOfSourceText(row.source).map((site) => site.kind)).toContain(row.kind);
    });
  }

  /**
   * THE REVIEWER'S ROUND-8 MATRIX — the `Object.*` members the detector could
   * not see, and the fail-closed default that makes the class finite.
   *
   * Review round 8 probed the detector directly and got NO SITES for
   * `Object.getPrototypeOf`, `Object.setPrototypeOf` and `Object.fromEntries`,
   * and demonstrated the consequence with a mutation: exported
   * `getPrototypeOf`/`setPrototypeOf` calls added to a PRODUCT source passed
   * both package typechecking and the census's "every site is registered" test.
   * The cause was not three missing names — it was that `callKind` answered
   * `undefined` for any `Object` member it did not recognize, so the detector
   * failed OPEN. The last row is the fix; the first three are the symptoms.
   */
  const ROUND_8_MATRIX: readonly {
    readonly shape: string;
    readonly source: string;
    readonly kind: AccessKind;
  }[] = [
    {
      shape: "Object.getPrototypeOf(obj) — READS the chain",
      source: "function f(o: object) { return Object.getPrototypeOf(o); }",
      kind: "prototype-read",
    },
    {
      shape: "Object.setPrototypeOf(obj, p) — INSTALLS a chain",
      source: "function f(o: object, p: object) { return Object.setPrototypeOf(o, p); }",
      kind: "prototype-write",
    },
    {
      shape: "Object.create(p) — the same, at construction",
      source: "function f(p: object) { return Object.create(p); }",
      kind: "prototype-write",
    },
    {
      shape: "Object.create(null) — the SAME KIND, reported so the argument is visible",
      source: "function f() { return Object.create(null); }",
      kind: "prototype-write",
    },
    {
      shape: "Object.fromEntries(xs) — the result is an ORDINARY object",
      source: "function f(xs: readonly [string, number][]) { return Object.fromEntries(xs); }",
      kind: "object-from-entries",
    },
    {
      shape: "an UNRECOGNIZED Object member FAILS CLOSED to a named finding",
      // Parsed as TEXT, never type-checked: the point is that a member the
      // tables do not name is reported rather than silently dropped.
      source: "function f(o: object) { return Object.futureMember(o); }",
      kind: "object-unclassified",
    },
    {
      shape: "Object.groupBy — a real member neither table names today",
      source: "function f(xs: readonly number[]) { return Object.groupBy(xs, (x) => String(x)); }",
      kind: "object-unclassified",
    },
    {
      shape: "Object.getOwnPropertySymbols(obj) — own names, no getter",
      source: "function f(o: object) { return Object.getOwnPropertySymbols(o); }",
      kind: "own-enumeration",
    },
  ];

  for (const row of ROUND_8_MATRIX) {
    it(`round 8 — detects: ${row.shape}`, () => {
      expect(censusOfSourceText(row.source).map((site) => site.kind)).toContain(row.kind);
    });
  }

  it("round 8 — the SILENT Object members really are silent, and are the whole list", () => {
    // Item 2 of the scope list, exercised member by member. If one of these
    // starts being reported, the exclusion list and the detector have drifted.
    const silent = [
      "Object.hasOwn(o, k)",
      "Object.getOwnPropertyDescriptor(o, k)",
      "Object.getOwnPropertyDescriptors(o)",
      "Object.defineProperty(o, k, d)",
      "Object.defineProperties(o, ds)",
      "Object.freeze(o)",
      "Object.isFrozen(o)",
      "Object.seal(o)",
      "Object.isSealed(o)",
      "Object.preventExtensions(o)",
      "Object.isExtensible(o)",
      "Object.is(o, o)",
    ];
    for (const call of silent) {
      expect(
        censusOfSourceText(`function f(o: object, k: string, d: unknown, ds: unknown) { ${call}; }`),
        call,
      ).toEqual([]);
    }
  });

  it("every kind in the vocabulary is exercised by a probe in this file", () => {
    const probed = new Set<AccessKind>([
      ...ROUND_7_MATRIX.map((row) => row.kind),
      ...ROUND_8_MATRIX.map((row) => row.kind),
      ...HISTORICAL.map((probe) => probe.kind),
      "delete-element",
      "object-assign",
      "computed-key",
      "object-spread",
      "with-statement",
    ]);
    expect([...ACCESS_KINDS].filter((kind) => !probed.has(kind))).toEqual([]);
  });

  /**
   * THE EXCLUDED FORMS, EXERCISED.
   *
   * Items 1–7 of the scope list in `prototype-access-scan.ts`. A census whose
   * boundary is only prose is the round-6 failure repeated: each excluded form
   * is asserted SILENT here, so the list cannot drift away from the detector in
   * either direction — a form that starts being reported fails this test and
   * must be registered and documented.
   */
  const EXCLUDED: readonly { readonly item: string; readonly source: string }[] = [
    { item: "1 — a dotted read", source: "function f(o: { a: number }) { return o.a; }" },
    {
      item: "2 — Object.hasOwn / getOwnPropertyDescriptor / defineProperty",
      source:
        'function f(o: object, k: string) { if (Object.hasOwn(o, k)) { const d = Object.getOwnPropertyDescriptor(o, k); Object.defineProperty(o, k, { value: d }); } }',
    },
    {
      item: "3 — the iteration protocol: for…of, array destructuring, array spread",
      source:
        "function f(xs: readonly number[]) { let t = 0; for (const x of xs) t += x; const [a] = xs; return [t, a, ...xs]; }",
    },
    {
      item: "5 — implicit coercion: String(), a template, JSON.stringify",
      source: "function f(o: object) { return `${String(o)}${JSON.stringify(o)}`; }",
    },
    {
      // Round 8 NARROWED this item: `Object.create` was excluded here and is
      // now `prototype-write` (see the round-8 matrix), so only the class-syntax
      // forms remain excluded.
      item: "7 — class syntax: instanceof and super",
      source:
        "function f(o: object) { return o instanceof Map; }\n" +
        "const g = { toString() { return super.toString(); } };\n",
    },
    {
      // Round 9: the reviewer measured both of these passing the census, and
      // the boundary is now STATED (scope item 8) instead of undocumented. The
      // alias binds a classifiable member without a call; the cast hides the
      // `Object` identifier from `staticMemberCall`. The census guards against
      // accident, not against an author writing indirection to defeat it —
      // typecheck, lint and review carry those forms.
      item: "8 — alias capture of a classified member (round 9: stated, exercised)",
      source: "export const zz = Object.getPrototypeOf;",
    },
    {
      item: "8 — a cast in the callee defeats the member match (round 9: stated, exercised)",
      source:
        "function f(xs: readonly number[]) {\n" +
        "  return (Object as unknown as { groupBy(a: unknown, b: unknown): unknown })" +
        ".groupBy(xs, (x: number) => String(x));\n" +
        "}",
    },
  ];

  for (const excluded of EXCLUDED) {
    it(`the documented boundary holds — item ${excluded.item} is NOT reported`, () => {
      expect(censusOfSourceText(excluded.source)).toEqual([]);
    });
  }

  it("item 4 — a helper is flagged at ITSELF, and its call sites are not reasoned about", () => {
    // The limitation, stated as a measurement: the read is reported once, in the
    // helper, and calling it adds nothing. No site is ever exonerated by an
    // argument about who calls it.
    const sites = censusOfSourceText(
      "function h(o: Record<string, unknown>, k: string) { return o[k]; }\n" +
        "function caller(o: Record<string, unknown>) { return h(o, 'a'); }\n",
    );
    expect(sites.map((site) => `${site.enclosing}:${site.kind}`)).toEqual(["h:element-read"]);
  });

  /**
   * `with`, and the gate that makes classifying it unnecessary.
   *
   * Review round 8 noted that `with (o) { … }` resolves every bare identifier in
   * its body against `o`'s prototype chain, that the detector does not report
   * it, and that the claimed-complete exclusion list did not mention it. It is
   * now a DETECTED KIND (the scope list's `with` clause; "item 8" is the
   * round-9 indirection boundary), and the measurements behind the layering are
   * below — including round 9's, which reversed round 8's ordering of them.
   */
  it("round 8 — `with (o) { … }` is DETECTED, not argued about", () => {
    const sites = censusOfSourceText(
      "export function f(o: Record<string, unknown>): unknown {\n" +
        "  with (o) { return value; }\n" +
        "}\n",
    );
    expect(sites.map((site) => site.kind)).toContain("with-statement");
    expect(sites.find((site) => site.kind === "with-statement")?.enclosing).toBe("f");
  });

  it("round 8 — and TypeScript rejects it independently, with the codes MEASURED", () => {
    const diagnostics = diagnosticsOfSourceText(
      "export function f(o: Record<string, unknown>): unknown {\n" +
        "  with (o) { return value; }\n" +
        "}\n",
    );
    // 1101 "`with` statements are not allowed in strict mode" and 2410 are both
    // SEMANTIC, not syntactic — which matters, because `censusOfPrototypeAccess`
    // only refuses on SYNTACTIC diagnostics. So the second gate is `pnpm
    // typecheck`, not the census's own guard, and the census detects the
    // construct itself rather than relying on either.
    expect(diagnostics.semantic).toContain(1101);
    expect(diagnostics.semantic).toContain(2410);
    expect(diagnostics.syntactic).toEqual([]);
  });

  it("round 9 — a suppression comment defeats the TYPE gate, and the DETECTOR survives", () => {
    // The reviewer measured round 8's framing backwards in one direction:
    // `// @ts-expect-error` swallows BOTH `with` diagnostics (1101 and 2410),
    // so `pnpm typecheck` exits clean — and eslint stays clean too. The layer
    // that survives the suppression comment is the census's own
    // `with-statement` detector, which still fails closed naming the site.
    // (`object`, not `Record`: the probe harness runs `noLib`, where `Record`
    // itself is a 2304 that would muddy the measurement.)
    const suppressed =
      "export function f(o: object): unknown {\n" +
      "  // @ts-expect-error deliberately suppressed for the round-9 measurement\n" +
      "  with (o) { return 0; }\n" +
      "}\n";
    const diagnostics = diagnosticsOfSourceText(suppressed);
    expect(diagnostics.semantic).toEqual([]);
    expect(diagnostics.syntactic).toEqual([]);
    const sites = censusOfSourceText(suppressed);
    expect(sites.map((site) => site.kind)).toContain("with-statement");
  });

  it("round 8 — the census's own guard: a SYNTACTIC diagnostic is what it refuses on", () => {
    // `censusOfPrototypeAccess` throws when a scanned file cannot be parsed.
    // Exercised here on the same machinery with a deliberately broken text,
    // rather than by editing a product file.
    expect(diagnosticsOfSourceText("export function f( {").syntactic.length).toBeGreaterThan(0);
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
