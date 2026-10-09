/**
 * THE MECHANISM, PART 3 — every public export is classified, and the
 * classification is exercised.
 *
 * WHY. Round 5 wrote, without qualification, that "no public function of either
 * package throws for any input". Review round 6 falsified it with a five-line
 * matrix: `assessWorstCase`, `riskRefusal`, `exposureSnapshot`,
 * `nonFloorLiveMicroCapFields` and `validateEvaluationInput` all threw. The
 * functions round 5 had WRAPPED were total; the exported SURFACE was not,
 * because the surface was never enumerated.
 *
 * So it is enumerated here, from the module namespace rather than from memory.
 * Every export of both index modules must appear in the table below with a
 * classification, and every table entry must still be an export:
 *
 * - `total` — hand it a hostile value and it returns a typed answer. The probe
 *   is run and must not throw;
 * - `propagates` — it has TYPED parameters and a result type that cannot
 *   express a refusal, so containment would mean INVENTING a measurement, which
 *   is fail-open. The probe is run and must throw, so the classification is a
 *   measurement rather than an aspiration, and the reason must say where the
 *   in-repository call site's containment is;
 * - `schema` / `value` — not a function of ours.
 *
 * THE CHOICE BETWEEN THE TWO IS ARGUED PER ENTRY, and the argument is always
 * the same shape: what would a contained failure have to RETURN? Where the
 * answer is "a refusal the caller already handles" (every `unknown` door, the
 * refusal constructors, the live-micro fence), containment is right and is
 * implemented. Where the answer would have to be a NUMBER — a worst-case loss,
 * an exposure total — containment would have to invent one, and `"0"` is the
 * most dangerous number in this package. Those propagate, and every
 * in-repository caller runs inside a containment guard.
 */

import { describe, expect, it } from "vitest";

import * as allocator from "../../../packages/capital-allocator/src/index.js";
import * as risk from "../../../packages/risk/src/index.js";
import { INSTANCE, MARKET_A, entryInput, riskPolicy } from "./fixtures.js";

/** A handler whose every trap throws — the reviewer's probe shape. */
function hostileProxy(label: string): ProxyHandler<object> {
  const boom = (trap: string) => (): never => {
    throw new Error(`${label}-${trap}-trap`);
  };
  return {
    get: boom("get"),
    has: boom("has"),
    ownKeys: boom("keys"),
    getOwnPropertyDescriptor: boom("descriptor"),
    getPrototypeOf: boom("prototype"),
  };
}

const HOSTILE_OBJECT = (): object => new Proxy({}, hostileProxy("object"));
const HOSTILE_ARRAY = (): object => new Proxy([], hostileProxy("array"));

type Classification = "total" | "propagates" | "schema" | "value";

interface SurfaceEntry {
  readonly name: string;
  readonly classification: Classification;
  /** The hostile call. Required for `total` and `propagates`. */
  readonly probe?: () => unknown;
  readonly reason: string;
}

const CONTAINED_DOOR =
  "a public `unknown` door: it returns a typed refusal for any input, and a caller that received an exception here would have no defined behaviour";
const NOT_A_MEASUREMENT =
  "typed parameters and a result type that cannot express a refusal: containing here would mean INVENTING a measurement (a worst-case loss, an exposure total), and an invented `\"0\"` is fail-open. Every in-repository call site runs inside `contained` (engine.ts / reserve.ts), so no public ANSWER of either package becomes an exception";
const PURE_PREDICATE =
  "a total pure function of primitives: there is no value of its declared parameter type for which it throws, and no caller code to run";

const RISK_SURFACE: readonly SurfaceEntry[] = [
  // --- doors and constructors that are TOTAL --------------------------------
  {
    name: "validateEvaluationInput",
    classification: "total",
    probe: () => risk.validateEvaluationInput(HOSTILE_OBJECT()),
    reason: `${CONTAINED_DOOR}. Review round 6 made this non-negotiable: it already returned a typed validation union, and it threw on an inherited getter`,
  },
  {
    name: "parseRiskPolicy",
    classification: "total",
    probe: () => risk.parseRiskPolicy(HOSTILE_OBJECT()),
    reason: CONTAINED_DOOR,
  },
  {
    name: "evaluateIntent",
    classification: "total",
    probe: () => risk.evaluateIntent(HOSTILE_OBJECT() as never, HOSTILE_OBJECT()),
    reason: CONTAINED_DOOR,
  },
  {
    name: "riskRefusal",
    classification: "total",
    probe: () => risk.riskRefusal("RISK_INPUT_INVALID", "m", HOSTILE_OBJECT() as never),
    reason:
      "the way this package says NO. A refusal constructor that can throw turns a refusal into a crash; round 6's probe did exactly that through the `{ ...details }` spread",
  },
  {
    name: "riskOk",
    classification: "total",
    probe: () => risk.riskOk(HOSTILE_OBJECT()),
    reason: "it wraps a value without reading it",
  },
  {
    name: "riskFailure",
    classification: "total",
    probe: () => risk.riskFailure(risk.riskRefusal("RISK_INPUT_INVALID", "m")),
    reason: "it copies an array of refusals this package built",
  },
  {
    name: "isRiskReasonCode",
    classification: "total",
    probe: () => risk.isRiskReasonCode("nope"),
    reason: PURE_PREDICATE,
  },
  {
    name: "isPrimaryRiskReasonCode",
    classification: "total",
    probe: () => risk.isPrimaryRiskReasonCode("nope"),
    reason: PURE_PREDICATE,
  },
  {
    name: "instantMilliseconds",
    classification: "total",
    probe: () => risk.instantMilliseconds("not-a-time"),
    reason: PURE_PREDICATE,
  },
  {
    name: "isExpired",
    classification: "total",
    probe: () => risk.isExpired("not-a-time", "not-a-time"),
    reason: PURE_PREDICATE,
  },
  {
    name: "blocksAsStale",
    classification: "total",
    probe: () => risk.blocksAsStale({ status: "UNKNOWN" } as never),
    reason: PURE_PREDICATE,
  },

  // --- typed helpers that PROPAGATE, deliberately ---------------------------
  {
    name: "assessWorstCase",
    classification: "propagates",
    probe: () => risk.assessWorstCase(HOSTILE_ARRAY() as never),
    reason: `${NOT_A_MEASUREMENT}. Named in the round-6 matrix; the engine calls it inside \`contained\``,
  },
  {
    name: "settlementValueUnderOutcome",
    classification: "propagates",
    probe: () => risk.settlementValueUnderOutcome("x" as never, "0" as never, "YES_WIN"),
    reason: `${NOT_A_MEASUREMENT}. Exact-decimal arithmetic on a non-decimal string throws by the decimal package's own contract, which is the fail-closed answer`,
  },
  {
    name: "buildWorstCaseLots",
    classification: "propagates",
    probe: () => risk.buildWorstCaseLots(HOSTILE_OBJECT() as never, HOSTILE_ARRAY() as never),
    reason: NOT_A_MEASUREMENT,
  },
  {
    name: "assessScenarios",
    classification: "propagates",
    probe: () =>
      risk.assessScenarios(HOSTILE_ARRAY() as never, HOSTILE_ARRAY() as never, HOSTILE_OBJECT() as never),
    reason: NOT_A_MEASUREMENT,
  },
  {
    name: "assessFreshness",
    classification: "propagates",
    probe: () => risk.assessFreshness(HOSTILE_ARRAY() as never, HOSTILE_OBJECT() as never, "m"),
    reason: NOT_A_MEASUREMENT,
  },
  {
    name: "buildIntentView",
    classification: "propagates",
    probe: () => risk.buildIntentView(HOSTILE_OBJECT() as never, HOSTILE_ARRAY() as never),
    reason: NOT_A_MEASUREMENT,
  },
  {
    name: "heldShares",
    classification: "propagates",
    probe: () => risk.heldShares(HOSTILE_ARRAY() as never, "m", "YES"),
    reason: NOT_A_MEASUREMENT,
  },
  {
    name: "recommendIncidentActions",
    classification: "propagates",
    probe: () => risk.recommendIncidentActions(HOSTILE_OBJECT() as never),
    reason: NOT_A_MEASUREMENT,
  },

  // --- schemas and constants ------------------------------------------------
  ...(
    [
      "RiskPolicySchema",
      "FreshnessObservationSchema",
      "FreshnessPolicySchema",
      "AllocationVerdictViewSchema",
      "MarketContextSchema",
      "PortfolioOpenOrderSchema",
      "PortfolioPositionSchema",
      "PortfolioViewSchema",
      "RiskEvaluationInputSchema",
      "ScenarioViewSchema",
      "ScopeAttributionSchema",
    ] as const
  ).map((name) => ({
    name,
    classification: "schema" as const,
    reason:
      "a `zod` schema: `parse` throws and `safeParse` does not, by `zod`'s contract rather than this package's. Every use of it INSIDE this package goes through a door that materializes first",
  })),
  ...(
    [
      "PRIMARY_RISK_REASON_CODES",
      "RISK_REASON_CODES",
      "RISK_REASON_CODE_COUNT",
      "SCENARIO_KINDS",
      "FRESHNESS_FEEDS",
      "CANCELLED_OUTCOME_TREATMENT",
      "LOSING_TOKEN_PAYOUT_PER_SHARE",
      "SPLIT_50_50_PAYOUT_PER_SHARE",
      "VERIFIED_TERMINAL_OUTCOMES",
      "WINNING_TOKEN_PAYOUT_PER_SHARE",
      "INCIDENT_ACTION_LADDER",
      "INCIDENT_FAILURE_CLASSES",
    ] as const
  ).map((name) => ({
    name,
    classification: "value" as const,
    reason: "a frozen constant, not a function: there is no call to contain",
  })),
];

const ALLOCATOR_SURFACE: readonly SurfaceEntry[] = [
  {
    name: "parseAllocatorCaps",
    classification: "total",
    probe: () => allocator.parseAllocatorCaps(HOSTILE_OBJECT()),
    reason: CONTAINED_DOOR,
  },
  {
    name: "createAllocatorState",
    classification: "total",
    probe: () => allocator.createAllocatorState(HOSTILE_OBJECT()),
    reason: CONTAINED_DOOR,
  },
  {
    name: "evaluateReservation",
    classification: "total",
    probe: () =>
      allocator.evaluateReservation(HOSTILE_OBJECT() as never, HOSTILE_OBJECT() as never, HOSTILE_OBJECT()),
    reason: CONTAINED_DOOR,
  },
  {
    name: "applyReservation",
    classification: "total",
    probe: () =>
      allocator.applyReservation(HOSTILE_OBJECT() as never, HOSTILE_OBJECT() as never, HOSTILE_OBJECT()),
    reason: CONTAINED_DOOR,
  },
  {
    name: "releaseReservation",
    classification: "total",
    probe: () => allocator.releaseReservation(HOSTILE_OBJECT() as never, "res"),
    reason: CONTAINED_DOOR,
  },
  {
    name: "withLiveOwner",
    classification: "total",
    probe: () => allocator.withLiveOwner(HOSTILE_OBJECT() as never, "m", "s"),
    reason:
      "it answers with a `CapitalResult`, and an ownership question that cannot be answered must be a refusal rather than a crash",
  },
  {
    name: "nonFloorLiveMicroCapFields",
    classification: "total",
    probe: () => allocator.nonFloorLiveMicroCapFields(HOSTILE_OBJECT() as never),
    reason:
      "the `AGENTS.md` live-micro fence. Total AND fail-closed: what cannot be read as an own data value at the exact floor is reported as NON-floor, so an unreadable caps object refuses rather than passing. Named in the round-6 matrix",
  },
  {
    name: "liveMicroCapRefusals",
    classification: "total",
    probe: () => allocator.liveMicroCapRefusals(HOSTILE_OBJECT() as never),
    reason: "the same fence expressed as typed refusals, and total for the same reason",
  },
  {
    name: "capitalRefusal",
    classification: "total",
    probe: () => allocator.capitalRefusal("CAPITAL_INPUT_INVALID", "m", HOSTILE_OBJECT() as never),
    reason: "the way this package says NO — see `riskRefusal`",
  },
  {
    name: "capitalOk",
    classification: "total",
    probe: () => allocator.capitalOk(HOSTILE_OBJECT()),
    reason: "it wraps a value without reading it",
  },
  {
    name: "capitalFailure",
    classification: "total",
    probe: () => allocator.capitalFailure(allocator.capitalRefusal("CAPITAL_INPUT_INVALID", "m")),
    reason: "it copies an array of refusals this package built",
  },
  {
    name: "isCapitalRefusalCode",
    classification: "total",
    probe: () => allocator.isCapitalRefusalCode("nope"),
    reason: PURE_PREDICATE,
  },
  {
    name: "inventoryKey",
    classification: "total",
    probe: () => allocator.inventoryKey("a", "b", "c"),
    reason: PURE_PREDICATE,
  },
  {
    name: "exposureSnapshot",
    classification: "propagates",
    probe: () => allocator.exposureSnapshot(HOSTILE_OBJECT() as never),
    reason: `${NOT_A_MEASUREMENT}. Named in the round-6 matrix. A contained exposure snapshot would have to be an EMPTY one, and an empty snapshot reads as zero committed exposure — the exact fail-open \`RISK_EXPOSURE_ENTRY_MISSING\` exists to prevent`,
  },
  {
    name: "exposureSnapshotCovering",
    classification: "propagates",
    probe: () => allocator.exposureSnapshotCovering(HOSTILE_OBJECT() as never, {}),
    reason: `${NOT_A_MEASUREMENT}. Same argument as \`exposureSnapshot\`, and here an invented answer would additionally be an EXPLICIT ZERO — a measurement claim nobody made`,
  },
  {
    name: "shadowExposureSnapshot",
    classification: "propagates",
    probe: () => allocator.shadowExposureSnapshot(HOSTILE_OBJECT() as never, "s"),
    reason: `${NOT_A_MEASUREMENT}. Same argument as \`exposureSnapshot\``,
  },
  {
    name: "heldSharesByKey",
    classification: "propagates",
    probe: () => allocator.heldSharesByKey(HOSTILE_OBJECT() as never),
    reason: `${NOT_A_MEASUREMENT}. An invented empty inventory table would under-state holdings`,
  },
  {
    name: "reservedSharesByKey",
    classification: "propagates",
    probe: () => allocator.reservedSharesByKey(HOSTILE_OBJECT() as never),
    reason: `${NOT_A_MEASUREMENT}. An invented empty reservation table would UNDER-state what is already reserved, which is the direction that permits an oversell`,
  },
  ...(
    [
      "AllocatorCapsSchema",
      "AllocatorStateInputSchema",
      "LiveOwnerSchema",
      "OpenOrderCommitmentSchema",
      "PositionHoldingSchema",
      "ScopeAttributionSchema",
      "ReservationRequestSchema",
    ] as const
  ).map((name) => ({
    name,
    classification: "schema" as const,
    reason: "a `zod` schema — see the risk package's entry",
  })),
  ...(
    [
      "CAPITAL_REFUSAL_CODES",
      "CAPITAL_REFUSAL_CODES_ARE_EXHAUSTIVE",
      "CAPITAL_REFUSAL_CODE_COUNT",
      "LIVE_MICRO_CAP_FIELDS",
      "LIVE_MICRO_CAP_FLOOR",
      "EXPOSURE_ZERO",
    ] as const
  ).map((name) => ({
    name,
    classification: "value" as const,
    reason: "a frozen constant, not a function: there is no call to contain",
  })),
];

const SURFACES = [
  { label: "@polymarket-bot/risk", module: risk as Record<string, unknown>, table: RISK_SURFACE },
  {
    label: "@polymarket-bot/capital-allocator",
    module: allocator as Record<string, unknown>,
    table: ALLOCATOR_SURFACE,
  },
] as const;

describe("THE MECHANISM: the public surface is enumerated and classified", () => {
  for (const surface of SURFACES) {
    it(`${surface.label}: every export is classified, and every classification is an export`, () => {
      const exported = Object.keys(surface.module).sort();
      const classified = surface.table.map((entry) => entry.name).sort();
      const missing = exported.filter((name) => !classified.includes(name));
      const stale = classified.filter((name) => !exported.includes(name));
      expect({ missing, stale }).toEqual({ missing: [], stale: [] });
      expect(new Set(classified).size).toBe(classified.length);
    });

    it(`${surface.label}: every classification carries a reason`, () => {
      for (const entry of surface.table) {
        expect(entry.reason.length, entry.name).toBeGreaterThan(30);
      }
    });

    it(`${surface.label}: every TOTAL export answers a hostile value instead of throwing`, () => {
      const failures: string[] = [];
      for (const entry of surface.table) {
        if (entry.classification !== "total") continue;
        const probe = entry.probe;
        if (probe === undefined) {
          failures.push(`${entry.name}: classified total with no probe`);
          continue;
        }
        try {
          probe();
        } catch (error) {
          failures.push(
            `${entry.name}: THREW ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      expect(failures).toEqual([]);
    });

    it(`${surface.label}: every PROPAGATING export really does propagate (the classification is measured)`, () => {
      const failures: string[] = [];
      for (const entry of surface.table) {
        if (entry.classification !== "propagates") continue;
        const probe = entry.probe;
        if (probe === undefined) {
          failures.push(`${entry.name}: classified propagates with no probe`);
          continue;
        }
        let threw = false;
        try {
          probe();
        } catch {
          threw = true;
        }
        if (!threw) {
          failures.push(
            `${entry.name}: did NOT throw — it may now be total, in which case reclassify it (and say so in the README)`,
          );
        }
      }
      expect(failures).toEqual([]);
    });

    it(`${surface.label}: the classification vocabulary is closed`, () => {
      for (const entry of surface.table) {
        expect(["total", "propagates", "schema", "value"]).toContain(entry.classification);
        if (entry.classification === "schema" || entry.classification === "value") {
          expect(entry.probe, entry.name).toBeUndefined();
        }
      }
    });
  }

  it("a PROPAGATING export is contained at every in-repository call site", () => {
    // The claim's other half: the surface propagates, the PACKAGE does not. The
    // engine and the reservation gate are the only in-repository callers, and
    // both answer with a typed refusal when a propagating helper throws.
    const evaluation = risk.evaluateIntent(
      { limits: {} } as never,
      { intent: { get type(): never { throw new Error("engine-getter"); } } },
    );
    expect(evaluation.approved).toBe(false);

    const verdict = allocator.evaluateReservation(
      { get positions(): never { throw new Error("state-getter"); } } as never,
      { globalAccountCap: "1", perStrategyCap: "1" } as never,
      { reservationId: "r" },
    );
    expect(verdict.permitted).toBe(false);
  });
});

/**
 * THE EXPORTED RECORD'S CONSUMER-VISIBLE SHAPE — README §6.1 (review round 7).
 *
 * An emitted record has a `null` prototype. That is a real change to a public
 * value and the reviewer asked for consumer-facing guidance rather than a
 * handoff footnote, so `packages/risk/README.md` §6.1 states it for WP-190 and
 * WP-230. A documented behaviour nothing measures is a claim, so every row of
 * that table is asserted here — including the two that RESTORE `Object.prototype`
 * and are therefore the ones a consumer can get wrong.
 */
describe("the emitted record: what a consumer sees (README §6.1)", () => {
  const evaluation = risk.evaluateIntent(riskPolicy(), entryInput());
  if (!evaluation.approved) throw new Error("the fixture must approve");
  const record = evaluation.record as unknown as Record<string, unknown>;

  it("has NO prototype, so the inherited object methods are absent", () => {
    expect(Object.getPrototypeOf(record)).toBeNull();
    expect(record instanceof Object).toBe(false);
    expect((record as { hasOwnProperty?: unknown }).hasOwnProperty).toBeUndefined();
    expect((record as { toString?: unknown }).toString).toBeUndefined();
    expect((record as { valueOf?: unknown }).valueOf).toBeUndefined();
    // …at every depth, not only at the root
    expect(Object.getPrototypeOf(record["intent"] as object)).toBeNull();
  });

  it("answers every ordinary read: hasOwn, `in`, dotted, destructuring, keys, JSON", () => {
    expect(Object.hasOwn(record, "approvedIntentId")).toBe(true);
    expect("approvedIntentId" in record).toBe(true);
    expect(record["approvedIntentId"]).toBe("approved-1");
    const { approvedIntentId } = record as { approvedIntentId: string };
    expect(approvedIntentId).toBe("approved-1");
    expect(Object.keys(record).length).toBeGreaterThan(5);
    expect(JSON.parse(JSON.stringify(record))).toEqual(record);
    expect(Object.isFrozen(record)).toBe(true);
  });

  it("a spread, a clone and a JSON round trip all RESTORE Object.prototype", () => {
    // The consequence the README tells a consumer to re-harden after: the copy
    // is an ordinary object again, so an absent optional field read off it can
    // once more be answered by whatever sits on `Object.prototype`.
    expect(Object.getPrototypeOf({ ...record })).toBe(Object.prototype);
    expect(Object.getPrototypeOf(structuredClone(record))).toBe(Object.prototype);
    expect(Object.getPrototypeOf(JSON.parse(JSON.stringify(record)) as object)).toBe(
      Object.prototype,
    );
  });

  it("the allocator's state is MIXED, and the README says which parts are which", () => {
    const state = allocator.createAllocatorState({
      accountEquity: "1000",
      availableCollateral: "1000",
      positions: [
        {
          positionId: "p-1",
          marketId: MARKET_A,
          strategyInstanceId: INSTANCE,
          side: "YES",
          shares: "1",
          costBasis: "1",
        },
      ],
      openOrders: [],
      liveOwners: [],
    });
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    // the container is this package's own literal…
    expect(Object.getPrototypeOf(state.value)).toBe(Object.prototype);
    // …and every member that came from the caller is materialized, so prototype-free
    expect(Object.getPrototypeOf(state.value.positions[0] as object)).toBeNull();
  });
});

/*
 * RETIRED 2026-09-04 (`WP-180-FU2`), WITH ITS REASON RECORDED.
 *
 * A `describe("the duplicated data-record boundary cannot drift (review round
 * 6, LOW C)")` block stood here with four tests. They bound
 * `packages/capital-allocator/src/{plain-data,schema-arena}.ts` to the risk
 * originals: byte-identical below the marker, each with its own
 * `DUPLICATED, NOT SHARED` header. Round 6 added them because round 5 had
 * verified the duplication BY HAND and nothing held it.
 *
 * `GOV-2A` then ruled the duplication itself out
 * (`docs/contracts/dependency-direction.md` §2.1, mirror-collapse subsection):
 * a drift guard proves the copies are identical but cannot make a fix to them
 * atomic, and this is the repository's only prototype-free parse door. The
 * copies are deleted; `packages/capital-allocator` imports the canonical
 * modules across the §2.1 **S3** edge. The four tests are therefore not
 * weakened, they are UNSATISFIABLE — their subject does not exist — and
 * deleting them here is not a coverage loss:
 *
 * - the drift they guarded is now impossible by construction (one copy cannot
 *   drift from itself), and
 * - the failure that replaced it — a FOURTH copy appearing instead of an edge
 *   being added — is guarded by `test/unit/execution-planner/mirrors.test.ts`,
 *   repurposed in the same change from a drift guard into a DELETION guard
 *   that scans every workspace package's `src` tree by content fingerprint.
 *
 * Nothing else in this file changed: every behavioural assertion about the
 * public surface above is the one `WP-180` shipped.
 */
