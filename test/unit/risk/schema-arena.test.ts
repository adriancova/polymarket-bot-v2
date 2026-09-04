/**
 * THE MECHANISM, PART 4 — the parsing arena is the library's verdict, and
 * nothing else (review round 8).
 *
 * `schema-arena.ts` makes each door parse through a COPY of its schema whose
 * assembly containers and parse context have no prototype. That fixes the
 * round-8 BLOCKER — a throwing inherited setter trapped a valid `CANCEL` while
 * the library assembled an output the door discards — but it introduces an
 * obligation that has to be machine-checked rather than argued:
 *
 * 1. **THE COPY'S VERDICT IS THE ORIGINAL'S VERDICT.** Not one validation rule
 *    is reimplemented in the arena; every node is built by the library from the
 *    library's own definition. This file asserts that DIFFERENTIALLY — same
 *    `success`, same issue paths and codes — over every door schema of both
 *    packages and a corpus of valid and deliberately broken values.
 * 2. **THE ORIGINALS ARE UNTOUCHED.** The frozen domain contracts are cloned,
 *    never mutated: a process-wide monkey-patch of `IntentSchema` would be a
 *    worse defect than the one being fixed. Asserted by showing that the
 *    ORIGINAL schema still has the library's behaviour under pollution while the
 *    copy does not.
 * 3. **THE WALK IS CLOSED.** `ARENA_NODE_TYPES` must be exactly the set of node
 *    types the door schemas contain — in both directions — and a schema
 *    carrying anything else must fail the build rather than parse unprotected.
 *
 * The behavioural property itself ("an inherited setter changes no answer") is
 * enforced door by door in `inherited-state.test.ts`; this file is about the
 * mechanism that makes it true.
 */

import { describe, expect, it } from "vitest";

import { AllocatorCapsSchema } from "../../../packages/capital-allocator/src/caps.js";
import { ReservationRequestSchema } from "../../../packages/capital-allocator/src/reserve.js";
import { AllocatorStateInputSchema } from "../../../packages/capital-allocator/src/state.js";
import {
  ApprovedIntentRecordSchema,
  ResizeRequestSchema,
} from "../../../packages/risk/src/approved-intent.js";
import { RiskEvaluationInputSchema } from "../../../packages/risk/src/inputs.js";
import { readPlainData } from "../../../packages/risk/src/plain-data.js";
import { RiskPolicySchema } from "../../../packages/risk/src/policy.js";
import {
  ARENA_NODE_TYPES,
  SCHEMA_ARENA_ERROR,
  prototypeFreeParser,
} from "../../../packages/risk/src/schema-arena.js";
import { prototypeFreeParser as allocatorParser } from "../../../packages/capital-allocator/src/schema-arena.js";
import { validateEvaluationInput } from "../../../packages/risk/src/index.js";
import { cancelIntent, entryInput, positionIntent, riskPolicy } from "./fixtures.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** A schema, as much of one as this file needs to talk about. */
interface Parseable {
  safeParse(value: unknown): { success: boolean; error?: { issues: readonly Issue[] } };
}

interface Issue {
  readonly path: readonly PropertyKey[];
  readonly code: string;
}

/** `success` plus every issue's path and code — the whole verdict, ordered. */
function verdictOf(schema: Parseable, value: unknown): string {
  const parsed = schema.safeParse(value);
  const issues = parsed.error?.issues ?? [];
  return JSON.stringify({
    success: parsed.success,
    issues: issues.map((issue) => `${issue.path.map(String).join(".")}:${issue.code}`),
  });
}

/** The tree a door would actually hand a schema: own data, no prototype. */
function materialized(value: unknown): unknown {
  const read = readPlainData(value, "probe");
  if (!read.ok) throw new Error(`the probe fixture is not plain data: ${JSON.stringify(read.problems)}`);
  return read.value;
}

/** Pollutes `Object.prototype` for one call, and reports invocation counts. */
function withPollution<T>(
  name: string,
  mode: "accepting-setter" | "throwing-setter",
  body: () => T,
): { readonly result: T | string; readonly threw: boolean; readonly setterCalls: number } {
  let setterCalls = 0;
  Object.defineProperty(Object.prototype, name, {
    configurable: true,
    enumerable: false,
    get(): unknown {
      return "INHERITED";
    },
    set(): void {
      setterCalls += 1;
      if (mode === "throwing-setter") throw new TypeError("inherited-setter");
    },
  });
  try {
    return { result: body(), threw: false, setterCalls };
  } catch (error) {
    return { result: `THREW ${String(error)}`, threw: true, setterCalls };
  } finally {
    delete (Object.prototype as Record<string, unknown>)[name];
  }
}

// ---------------------------------------------------------------------------
// the corpus: every door schema, with values that pass and values that do not
// ---------------------------------------------------------------------------

function cancelInput(): Record<string, unknown> {
  const input = entryInput() as unknown as Record<string, unknown>;
  input["intent"] = cancelIntent();
  return input;
}

const CAPS_VALUE = { globalAccountCap: "1000", perStrategyCap: "1000" };

const STATE_VALUE = {
  accountEquity: "1000",
  availableCollateral: "1000",
  positions: [],
  openOrders: [],
  liveOwners: [],
};

const RESERVATION_VALUE = {
  reservationId: "res-1",
  strategyInstanceId: "strat-a",
  runMode: "PAPER",
  accountingMode: "LIVE",
  marketId: "01890000-0000-7000-8000-000000000001",
  side: "YES",
  action: "BUY",
  price: "0.5",
  shares: "100",
};

const POLICY_VALUE = {
  freshness: { venueBookMaxAgeMs: 1000, referenceFeedMaxAgeMs: 2000, featuresMaxAgeMs: 2000 },
  limits: { maxWorstCaseContractualLoss: "10000" },
  scenario: { maxScenarioLoss: "10000" },
  economics: {},
  participation: {},
  rateLimit: { safetyReserveRequests: 5 },
  timeToClose: { entryCutoffSeconds: 60 },
};

const RESIZE_VALUE = {
  approvedIntentId: "approved-2",
  resizedAt: "2026-09-02T12:00:00.000Z",
  newTargetShares: "50",
  reason: "risk resize",
};

/**
 * One door schema with the values the differential test parses through it.
 *
 * Every group carries a value that PASSES and several that do not, each broken
 * in a different way — a wrong scalar type, a missing required field, an extra
 * field a strict object must refuse, a malformed decimal, a non-canonical UUID
 * and a deep violation inside a nested array. A copy that quietly accepted any
 * of those would be a fail-open the round-8 fix introduced, so the corpus is
 * where this file spends its assertions.
 */
const CORPUS: readonly {
  readonly name: string;
  readonly schema: Parseable;
  readonly copy: Parseable;
  readonly values: readonly unknown[];
}[] = [
  {
    name: "RiskEvaluationInputSchema",
    schema: RiskEvaluationInputSchema as unknown as Parseable,
    copy: prototypeFreeParser(RiskEvaluationInputSchema) as unknown as Parseable,
    values: [
      entryInput(),
      cancelInput(),
      { ...entryInput(), evaluatedAt: "not-a-timestamp" },
      { ...entryInput(), evaluatedAt: 7 },
      { ...entryInput(), extraField: "surplus" },
      { ...entryInput(), intent: positionIntent({ marketId: "not-a-uuid" }) },
      { ...entryInput(), intent: positionIntent({ maximumBuyPrice: "1.5" }) },
      { ...entryInput(), intent: positionIntent({ targetShares: undefined }) },
      { ...entryInput(), markets: [{ marketId: "01890000-0000-7000-8000-000000000001" }] },
      { ...entryInput(), portfolio: { positions: [{ marketId: "x" }], openOrders: [] } },
      { ...entryInput(), scenarios: [{ scenarioId: "s", kind: "NOT_A_KIND", marks: [] }] },
      { ...entryInput(), guards: { recentIntentIds: [7] } },
      {},
      null,
      "a string",
      [],
    ],
  },
  {
    name: "RiskPolicySchema",
    schema: RiskPolicySchema as unknown as Parseable,
    copy: prototypeFreeParser(RiskPolicySchema) as unknown as Parseable,
    values: [
      POLICY_VALUE,
      { ...POLICY_VALUE, limits: {} },
      { ...POLICY_VALUE, maxRunMode: "LIVE_FULL" },
      { ...POLICY_VALUE, maxRunMode: "NOT_A_MODE" },
      { ...POLICY_VALUE, scenario: { maxScenarioLoss: "-1" } },
      { ...POLICY_VALUE, unexpected: true },
      {},
    ],
  },
  {
    name: "ResizeRequestSchema",
    schema: ResizeRequestSchema as unknown as Parseable,
    copy: prototypeFreeParser(ResizeRequestSchema) as unknown as Parseable,
    values: [
      RESIZE_VALUE,
      { ...RESIZE_VALUE, newTargetShares: "abc" },
      { ...RESIZE_VALUE, resizedAt: "yesterday" },
      { ...RESIZE_VALUE, extra: 1 },
      {},
    ],
  },
  {
    name: "ApprovedIntentRecordSchema",
    schema: ApprovedIntentRecordSchema as unknown as Parseable,
    copy: prototypeFreeParser(ApprovedIntentRecordSchema) as unknown as Parseable,
    values: [
      {
        approvedIntentId: "approved-1",
        lineage: "ORIGINAL",
        rootApprovedIntentId: "approved-1",
        intent: cancelIntent(),
        approvedAt: "2026-09-02T12:00:00.000Z",
        runMode: "PAPER",
        strategyInstanceId: "strat-a",
        reasons: ["RISK_APPROVED"],
        worstCase: {
          committedCost: "0",
          perMarket: [],
          maximumContractualLoss: "0",
          worstCaseResolutionLoss: "0",
          cancelledOutcomeTreatment: "ZERO_REDEMPTION_FLOOR_UNVERIFIED_U10",
        },
        worstCaseBasis: "EVALUATED",
        recommendations: [],
      },
      { approvedIntentId: "approved-1" },
      {},
    ],
  },
  {
    name: "AllocatorStateInputSchema",
    schema: AllocatorStateInputSchema as unknown as Parseable,
    copy: allocatorParser(AllocatorStateInputSchema) as unknown as Parseable,
    values: [
      STATE_VALUE,
      { ...STATE_VALUE, accountEquity: "-1" },
      { ...STATE_VALUE, positions: [{ positionId: "p" }] },
      { ...STATE_VALUE, surplus: true },
      {},
    ],
  },
  {
    name: "ReservationRequestSchema",
    schema: ReservationRequestSchema as unknown as Parseable,
    copy: allocatorParser(ReservationRequestSchema) as unknown as Parseable,
    values: [
      RESERVATION_VALUE,
      { ...RESERVATION_VALUE, price: "2" },
      { ...RESERVATION_VALUE, accountingMode: "NEITHER" },
      { ...RESERVATION_VALUE, marketId: "01890000-0000-7000-8000-00000000000X" },
      {},
    ],
  },
  {
    name: "AllocatorCapsSchema (grammar + the live-micro fence)",
    schema: AllocatorCapsSchema as unknown as Parseable,
    copy: allocatorParser(AllocatorCapsSchema) as unknown as Parseable,
    values: [
      CAPS_VALUE,
      { ...CAPS_VALUE, liveMicroMaxOrderNotional: "0" },
      // The `AGENTS.md` floor, raised: the fence must refuse it in BOTH.
      { ...CAPS_VALUE, liveMicroMaxOrderNotional: "1" },
      { ...CAPS_VALUE, liveMicroMaxAccountExposure: "0.01" },
      { ...CAPS_VALUE, globalAccountCap: "not-a-number" },
      {},
    ],
  },
];

describe("the parsing arena answers exactly what the library answers", () => {
  for (const group of CORPUS) {
    it(`${group.name}: same verdict for every value in the corpus`, () => {
      const divergences: string[] = [];
      for (const value of group.values) {
        const tree = value === null || typeof value !== "object" ? value : materialized(value);
        const original = verdictOf(group.schema, tree);
        const copy = verdictOf(group.copy, tree);
        if (original !== copy) divergences.push(`${JSON.stringify(value)}\n  ${original}\n  ${copy}`);
      }
      expect(divergences).toEqual([]);
    });

    it(`${group.name}: the corpus really exercises both answers`, () => {
      const results = group.values.map((value) => {
        const tree = value === null || typeof value !== "object" ? value : materialized(value);
        return group.copy.safeParse(tree).success;
      });
      // Non-vacuity: a corpus of only-failures (or only-passes) would make the
      // differential assertion above true without saying anything.
      expect(results).toContain(true);
      expect(results).toContain(false);
    });
  }
});

describe("the arena is a COPY: the library's own schemas are never mutated", () => {
  it("the copy is a different object graph", () => {
    const copy = prototypeFreeParser(RiskEvaluationInputSchema);
    expect(copy).not.toBe(RiskEvaluationInputSchema);
  });

  it("the ORIGINAL still behaves as the library does under a throwing setter", () => {
    const tree = materialized(cancelInput());
    const original = withPollution("reason", "throwing-setter", () =>
      (RiskEvaluationInputSchema as unknown as Parseable).safeParse(tree).success,
    );
    // This is the defect, still present in the untouched library schema — which
    // is exactly how it should be: the fix is a copy, not a monkey-patch.
    expect(original.threw).toBe(true);
    expect(original.setterCalls).toBe(1);
  });

  it("the COPY answers, byte for byte, with ZERO setter invocations", () => {
    const tree = materialized(cancelInput());
    const copy = prototypeFreeParser(RiskEvaluationInputSchema) as unknown as Parseable;
    const clean = verdictOf(copy, tree);
    for (const mode of ["accepting-setter", "throwing-setter"] as const) {
      for (const key of ["reason", "marketId", "type", "intent", "evaluatedAt", "identifiers"]) {
        const polluted = withPollution(key, mode, () => verdictOf(copy, tree));
        expect(polluted.threw, `${mode} on ${key}`).toBe(false);
        expect(polluted.result, `${mode} on ${key}`).toBe(clean);
        expect(polluted.setterCalls, `${mode} on ${key}`).toBe(0);
      }
    }
  });
});

describe("the arena's walk is closed, and fails the build rather than parsing unprotected", () => {
  /** Every node type the door schemas actually contain, read from the schemas. */
  function nodeTypesOf(schemas: readonly unknown[]): string[] {
    const found = new Set<string>();
    const seen = new WeakSet<object>();
    const walk = (node: unknown): void => {
      if (node === null || typeof node !== "object") return;
      if (seen.has(node)) return;
      seen.add(node);
      const internals = (node as { _zod?: { def?: Record<string, unknown> } })._zod;
      if (internals?.def !== undefined) {
        const type = internals.def["type"];
        if (typeof type === "string") found.add(type);
        for (const name of Object.keys(internals.def)) walk(internals.def[name]);
        return;
      }
      if (Array.isArray(node)) {
        for (const item of node as readonly unknown[]) walk(item);
        return;
      }
      if (Object.getPrototypeOf(node) !== Object.prototype) return;
      for (const name of Object.keys(node as Record<string, unknown>)) {
        walk((node as Record<string, unknown>)[name]);
      }
    };
    for (const schema of schemas) walk(schema);
    return [...found].sort();
  }

  it("ARENA_NODE_TYPES is exactly what the door schemas contain, in both directions", () => {
    const present = nodeTypesOf([
      RiskEvaluationInputSchema,
      RiskPolicySchema,
      ApprovedIntentRecordSchema,
      ResizeRequestSchema,
      AllocatorStateInputSchema,
      ReservationRequestSchema,
      AllocatorCapsSchema,
    ]);
    expect(present.length).toBeGreaterThan(8);
    expect([...ARENA_NODE_TYPES].sort()).toEqual(present);
  });

  it("a node type the arena cannot copy is a BUILD failure, not a silent parse", () => {
    // `.transform()` is the shape round 7 pinned as value-producing and round 8
    // cannot protect: it is a `pipe` of a `transform`, neither of which the
    // arena knows how to copy.
    const transformed = ResizeRequestSchema.transform((value) => value);
    expect(() => prototypeFreeParser(transformed)).toThrowError(
      new RegExp(`${SCHEMA_ARENA_ERROR}.*(pipe|transform)`, "u"),
    );
  });

  it("a value that is not a schema at all is refused by name", () => {
    expect(() => prototypeFreeParser({ not: "a schema" })).toThrowError(
      new RegExp(`${SCHEMA_ARENA_ERROR}.*not a schema node`, "u"),
    );
  });
});

describe("the parse CONTEXT is prototype-free too (a live fail-open, closed)", () => {
  /**
   * ROUND 8'S SECOND FINDING, WHICH NO REVIEWER REPORTED.
   *
   * The library reads optional switches off its parse context — an ordinary
   * `{ async: false }` — so `ctx.skipChecks` was answered by `Object.prototype`.
   * One non-enumerable data property therefore turned every FORMAT CHECK in
   * every door into a no-op: an ISO timestamp of `"definitely-not-a-timestamp"`
   * and a market id of `"not-a-uuid"` both VALIDATED at the round-7 tip.
   */
  function withData<T>(name: string, value: unknown, body: () => T): T {
    Object.defineProperty(Object.prototype, name, {
      configurable: true,
      enumerable: false,
      writable: true,
      value,
    });
    try {
      return body();
    } finally {
      delete (Object.prototype as Record<string, unknown>)[name];
    }
  }

  const badTimestamp = (): Record<string, unknown> => {
    const input = cancelInput();
    input["evaluatedAt"] = "definitely-not-a-timestamp";
    return input;
  };

  it("an inherited `skipChecks` no longer turns the format checks off", () => {
    expect(validateEvaluationInput(badTimestamp()).ok).toBe(false);
    expect(withData("skipChecks", true, () => validateEvaluationInput(badTimestamp()).ok)).toBe(
      false,
    );
  });

  it("non-vacuity: the RAW schema is still fooled by it, so the test is measuring the fix", () => {
    const tree = materialized(badTimestamp());
    expect((RiskEvaluationInputSchema as unknown as Parseable).safeParse(tree).success).toBe(false);
    expect(
      withData(
        "skipChecks",
        true,
        () => (RiskEvaluationInputSchema as unknown as Parseable).safeParse(tree).success,
      ),
    ).toBe(true);
  });

  it("an inherited `direction` or `jitless` changes no answer either", () => {
    const clean = validateEvaluationInput(badTimestamp()).ok;
    for (const [name, value] of [
      ["direction", "backward"],
      ["jitless", true],
      ["async", true],
    ] as const) {
      expect(withData(name, value, () => validateEvaluationInput(badTimestamp()).ok), name).toBe(
        clean,
      );
    }
  });

  it("a valid policy still parses under all three", () => {
    for (const [name, value] of [
      ["skipChecks", true],
      ["direction", "backward"],
      ["jitless", true],
    ] as const) {
      const parsed = withData(name, value, () => riskPolicy());
      expect(parsed.maxRunMode, name).toBe("PAPER");
    }
  });
});

describe("the copies' INSTANCE-SLOT containers are prototype-free too (review round 9)", () => {
  /**
   * ROUND 9'S BLOCKER, AND ITS CLASS. The library keeps per-node state in
   * `inst._zod` — an ordinary object literal — and the parse path reads
   * OPTIONAL fields off it. `el._zod.optin` and `el._zod.optout` decide whether
   * a MISSING REQUIRED KEY is refused; on an ordinary container both reads
   * walked the chain, and the PAIR on `Object.prototype` waived every required
   * key in every door (measured at the round-8 tip: an entry missing
   * `evaluatedAt` VALIDATED). Either name alone does not flip —
   * `handlePropertyResult` needs both — which is measured below rather than
   * assumed. The fix severs every copy's `_zod` container
   * (`severOrdinaryChain`), so an absent slot answers `undefined` exactly as a
   * clean process does.
   */
  function withData<T>(entries: readonly (readonly [string, unknown])[], body: () => T): T {
    for (const [name, value] of entries) {
      Object.defineProperty(Object.prototype, name, {
        configurable: true,
        enumerable: false,
        writable: true,
        value,
      });
    }
    try {
      return body();
    } finally {
      for (const [name] of entries) {
        delete (Object.prototype as Record<string, unknown>)[name];
      }
    }
  }

  const OPT_PAIR = [
    ["optin", "optional"],
    ["optout", "optional"],
  ] as const;

  const missingRequiredKey = (): Record<string, unknown> => {
    const input = entryInput() as unknown as Record<string, unknown>;
    delete input["evaluatedAt"];
    return input;
  };

  it("an inherited optin/optout pair no longer waives a required key", () => {
    const clean = JSON.stringify(validateEvaluationInput(missingRequiredKey()));
    expect(clean).toContain('"ok":false');
    const polluted = withData(OPT_PAIR, () =>
      JSON.stringify(validateEvaluationInput(missingRequiredKey())),
    );
    expect(polluted).toBe(clean);
  });

  /**
   * The raw probes force the INTERPRETED parser (`jitless: true` — a documented
   * per-parse option), which is the code path every arena copy runs: the
   * COMPILED fastpass bakes `optin`/`optout` in at compile time, so once any
   * clean parse in this worker has compiled it, the raw schema's compiled
   * route stops being foolable — an order-dependence, not a defense. On a cold
   * process the door itself flipped (transcript in `docs/handoffs/WP-180.md`,
   * round 9).
   */
  interface JitlessParseable {
    safeParse(value: unknown, ctx: { jitless: boolean }): { success: boolean };
  }

  it("non-vacuity: the RAW schema is still fooled by the pair, so the test measures the fix", () => {
    const tree = materialized(missingRequiredKey());
    const raw = RiskEvaluationInputSchema as unknown as JitlessParseable;
    expect(raw.safeParse(tree, { jitless: true }).success).toBe(false);
    expect(withData(OPT_PAIR, () => raw.safeParse(tree, { jitless: true }).success)).toBe(true);
  });

  it("measured precondition: either name ALONE flips nothing, even on the raw schema", () => {
    const tree = materialized(missingRequiredKey());
    const raw = RiskEvaluationInputSchema as unknown as JitlessParseable;
    expect(
      withData([["optin", "optional"]], () => raw.safeParse(tree, { jitless: true }).success),
    ).toBe(false);
    expect(
      withData([["optout", "optional"]], () => raw.safeParse(tree, { jitless: true }).success),
    ).toBe(false);
  });

  /**
   * THE SAME CLASS, ON A CHECK. `runChecks` reads `ch._zod.def.when` before
   * running a check; a shared check's def is an ordinary library literal, so
   * one inherited `when: () => false` skipped every check that does not carry
   * its own `when` — and the door schemas carry `custom` refinements that do
   * not. Measured at the round-8 tip: `strategyInstanceId: "has whitespace"`
   * VALIDATED under the pollution and was refused clean. The fix COPIES check
   * instances with prototype-free definitions (`arenaCheck`).
   */
  const customCheckViolation = (): Record<string, unknown> => {
    const input = cancelInput();
    const context = input["context"] as Record<string, unknown>;
    context["strategyInstanceId"] = "has whitespace";
    return input;
  };

  it("an inherited `when` no longer skips a door's custom check", () => {
    const clean = JSON.stringify(validateEvaluationInput(customCheckViolation()));
    expect(clean).toContain('"ok":false');
    const polluted = withData([["when", () => false]], () =>
      JSON.stringify(validateEvaluationInput(customCheckViolation())),
    );
    expect(polluted).toBe(clean);
  });

  it("non-vacuity: the RAW schema skips its custom check under inherited `when`", () => {
    const tree = materialized(customCheckViolation());
    const raw = RiskEvaluationInputSchema as unknown as Parseable;
    expect(raw.safeParse(tree).success).toBe(false);
    expect(withData([["when", () => false]], () => raw.safeParse(tree).success)).toBe(true);
  });

  it("the severed containers are structurally what the fix claims", () => {
    const copy = prototypeFreeParser(RiskEvaluationInputSchema) as unknown as {
      _zod: { def: Record<string, unknown> };
    };
    expect(Object.getPrototypeOf(copy._zod)).toBeNull();
    // the rebuilt spread-literal shape was severed after warming
    expect(Object.getPrototypeOf(copy._zod.def["shape"] as object)).toBeNull();
  });
});

describe("a COLD copy is immune to ENUMERABLE inherited data (review round 9, H-1)", () => {
  /**
   * ROUND 9'S HIGH. On the FIRST parse the library rebuilds an object schema's
   * `shape` as an ordinary spread literal and walks it with `for…in` to compute
   * `propValues` and the discriminated-union `disc` map. `for…in` on an
   * ordinary object ENUMERATES inherited enumerable names, so ONE enumerable
   * data property (`zzUnrelated: 1`) made a cold first parse THROW
   * (`TypeError … reading 'values'`), the containment guard converted that into
   * an input refusal, and a valid CANCEL was trapped (§6 invariant 13).
   * Measured worse at the round-8 tip: the half-computed lazy is POISONED, so
   * every LATER parse of that copy failed too — clean or polluted.
   *
   * The copies here are COLD BY CONSTRUCTION — each `prototypeFreeParser` call
   * builds a fresh graph with fresh lazies — so this test does not depend on
   * worker isolation. The door-level cold-process scenario (a whole process
   * whose first door parse happens under pollution) lives in
   * `cold-first-parse.test.ts`, which must be the only parser in its worker.
   */
  function withEnumerableData<T>(name: string, value: unknown, body: () => T): T {
    Object.defineProperty(Object.prototype, name, {
      configurable: true,
      enumerable: true,
      writable: true,
      value,
    });
    try {
      return body();
    } finally {
      delete (Object.prototype as Record<string, unknown>)[name];
    }
  }

  const validCancel = (): unknown => materialized(cancelInput());
  const malformedCancel = (): unknown => {
    const input = cancelInput();
    input["evaluatedAt"] = "definitely-not-a-timestamp";
    return materialized(input);
  };

  it("a fresh copy's FIRST parse under enumerable pollution answers byte-identically", () => {
    const clean = prototypeFreeParser(RiskEvaluationInputSchema) as unknown as Parseable;
    const cleanValid = verdictOf(clean, validCancel());
    const cleanMalformed = verdictOf(clean, malformedCancel());
    expect(cleanValid).toContain('"success":true');
    expect(cleanMalformed).toContain('"success":false');

    // a SECOND fresh copy whose first-ever parse happens under the pollution
    const cold = prototypeFreeParser(RiskEvaluationInputSchema) as unknown as Parseable;
    const polluted = withEnumerableData("zzUnrelated", 1, () => ({
      valid: verdictOf(cold, validCancel()),
      malformed: verdictOf(cold, malformedCancel()),
    }));
    expect(polluted.valid).toBe(cleanValid);
    expect(polluted.malformed).toBe(cleanMalformed);

    // and the copy is not poisoned afterwards either
    expect(verdictOf(cold, validCancel())).toBe(cleanValid);
  });

  it("a shape-key-named enumerable data property changes nothing either", () => {
    // `type` is the discriminator: at the round-8 tip a cold `propValues` walk
    // could meet it as an inherited entry. Post-fix the walk happened at build
    // time, on a clean process, and the rebuilt containers are severed.
    const cold = prototypeFreeParser(RiskEvaluationInputSchema) as unknown as Parseable;
    const clean = prototypeFreeParser(RiskEvaluationInputSchema) as unknown as Parseable;
    const expected = verdictOf(clean, validCancel());
    const polluted = withEnumerableData("type", "1000", () => verdictOf(cold, validCancel()));
    expect(polluted).toBe(expected);
  });
});
