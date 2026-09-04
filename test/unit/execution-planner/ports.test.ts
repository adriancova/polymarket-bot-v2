/**
 * The WP-180 → WP-190 STRUCTURAL PORTS, pinned against the real packages.
 *
 * `packages/risk`, `packages/capital-allocator` and this package are all
 * layer 1 with no §2.1 same-layer edge (F13), so the planner consumes the
 * approved-intent record and emits the allocator's reservation-request shape
 * BY STRUCTURE. A structural port rots silently, so — exactly like
 * `test/unit/risk/ports.test.ts`, whose arrangement this file copies — it is
 * pinned three ways:
 *
 * 1. compile-time: `satisfies` key lists tie this package's
 *    `ReservationRequirement` to the allocator's own inferred
 *    `ReservationRequest` type, so a rename on either side fails
 *    `pnpm typecheck`, not just this suite;
 * 2. runtime: every reservation a REAL plan emits is evaluated and APPLIED
 *    through the REAL allocator, and the allocator's own arithmetic then
 *    serves as an independent oracle for acceptance 1 (a hand-doubled
 *    reservation the plan would never emit is refused for inventory);
 * 3. independence: neither manifest declares the other — importing both here
 *    creates no workspace edge, which is the property the whole arrangement
 *    rests on.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  applyReservation,
  createAllocatorState,
  evaluateReservation,
  parseAllocatorCaps,
  type ReservationRequest,
} from "../../../packages/capital-allocator/src/index.js";
import {
  APPROVED_INTENT_RECORD_KEYS,
  buildExecutionPlan,
  readApprovedIntentRecord,
  type ReservationRequirement,
} from "../../../packages/execution-planner/src/index.js";
import {
  INSTANCE,
  MARKET_A,
  approvedPosition,
  approvedReduction,
  marketInput,
  planningInputs,
} from "./fixtures.js";
import { packageSourceFiles, readSource, repoRoot } from "./source-scan.js";

// --- 1. compile-time pins ---------------------------------------------------

/** Every field this package emits, checked against the allocator's own type. */
const EMITTED_RESERVATION_KEYS = [
  "reservationId",
  "strategyInstanceId",
  "runMode",
  "accountingMode",
  "marketId",
  "side",
  "action",
  "price",
  "shares",
  "scope",
] as const satisfies readonly (keyof ReservationRequest)[];

/** …and the reverse: every emitted key is one the planner's type carries. */
const MIRROR_KEYS = EMITTED_RESERVATION_KEYS satisfies readonly (keyof ReservationRequirement)[];

// --- fixtures ---------------------------------------------------------------

function allocator(positions: Array<Record<string, unknown>> = []) {
  const caps = parseAllocatorCaps({ globalAccountCap: "1000", perStrategyCap: "1000" });
  if (!caps.ok) throw new Error(`caps fixture failed: ${JSON.stringify(caps.refusals)}`);
  const state = createAllocatorState({
    accountEquity: "1000",
    availableCollateral: "1000",
    positions,
    openOrders: [],
    liveOwners: [{ marketId: MARKET_A, strategyInstanceId: INSTANCE }],
  });
  if (!state.ok) throw new Error(JSON.stringify(state.refusals));
  return { caps: caps.value, state: state.value };
}

function reservationsOf(record: unknown, inputs: unknown): readonly ReservationRequirement[] {
  const result = buildExecutionPlan(record, inputs);
  if (!result.ok) throw new Error(JSON.stringify(result.refusals, null, 2));
  if (result.value.planKind === "CANCEL") throw new Error("expected a placement");
  return result.value.reservations;
}

describe("the reservation port — the REAL allocator accepts what real plans emit", () => {
  it("pins the emitted key set at compile time (see the satisfies clauses above)", () => {
    expect(MIRROR_KEYS.length).toBe(10);
  });

  it("BUY reservations evaluate permitted and apply, draining exact collateral", () => {
    const reservations = reservationsOf(approvedPosition(), planningInputs());
    const { caps, state } = allocator();
    let current = state;
    for (const reservation of reservations) {
      const verdict = evaluateReservation(current, caps, reservation);
      expect(verdict.permitted, JSON.stringify(verdict)).toBe(true);
      const applied = applyReservation(current, caps, reservation);
      if (!applied.ok) throw new Error(JSON.stringify(applied.refusals));
      current = applied.value.state;
    }
    // 100 shares at limit 0.48 → exactly 48 pUSD reserved, by the
    // ALLOCATOR's arithmetic, not this package's.
    expect(current.availableCollateral).toBe("952");
    expect(current.reservedCollateral).toBe("48");
  });

  it("SELL reservations apply against real holdings — and the allocator independently refuses beyond them (acceptance 1's second oracle)", () => {
    const inputs = planningInputs({
      markets: [
        marketInput({
          inventory: { yes: { held: "100", reserved: "0" }, no: { held: "0", reserved: "0" } },
        }),
      ],
    });
    const reservations = reservationsOf(approvedReduction(), inputs);
    const { caps, state } = allocator([
      {
        positionId: "pos-1",
        marketId: MARKET_A,
        strategyInstanceId: INSTANCE,
        side: "YES",
        shares: "100",
        costBasis: "40",
      },
    ]);
    let current = state;
    for (const reservation of reservations) {
      const applied = applyReservation(current, caps, reservation);
      if (!applied.ok) throw new Error(JSON.stringify(applied.refusals));
      current = applied.value.state;
    }
    // The plan consumed the holdings exactly; one MORE sell of the same shape
    // (which the planner refuses to plan — its own suite proves that) is now
    // refused by the ALLOCATOR too: two independent implementations of
    // "respect actual inventory" agree.
    const oversell = evaluateReservation(current, caps, {
      ...reservations[0],
      reservationId: "oversell-probe",
    });
    expect(oversell.permitted).toBe(false);
    expect(
      oversell.permitted ? [] : oversell.refusals.map((refusal) => refusal.code),
    ).toContain("CAPITAL_INVENTORY_INSUFFICIENT");
  });

  it("emits reservations for PAPER runs only in this suite (no real-order surface anywhere)", () => {
    const reservations = reservationsOf(approvedPosition(), planningInputs());
    for (const reservation of reservations) {
      expect(reservation.runMode).toBe("PAPER");
    }
  });
});

describe("the record port — WP-180's records as they are actually shaped at 98a6cc1", () => {
  it("a real record's own keys are exactly a subset of the pinned key set, and it reads clean", () => {
    const record = approvedPosition();
    for (const key of Object.keys(record)) {
      expect(APPROVED_INTENT_RECORD_KEYS.has(key), `unpinned record key ${key}`).toBe(true);
    }
    const view = readApprovedIntentRecord(record);
    expect(view.ok).toBe(true);
  });

  it("a real record arrives with a null prototype and frozen — and the door accepts that shape", () => {
    const record = approvedPosition();
    expect(Object.getPrototypeOf(record)).toBeNull();
    expect(Object.isFrozen(record)).toBe(true);
  });
});

/**
 * INDEPENDENCE, AS IT STANDS AFTER THE MIRROR COLLAPSE.
 *
 * This describe used to be "no workspace edge exists in any direction" and
 * asserted that none of the three manifests declared any of the others.
 * `GOV-2A` ruled that shape out on 2026-09-04 and wrote
 * `docs/contracts/dependency-direction.md` §2.1 rows **S3** and **S4**: both
 * this package and `packages/capital-allocator` now declare
 * `@polymarket-bot/risk`, and the reason is a security mechanism that may not
 * be maintained in three places.
 *
 * The independence that still holds — and that these tests now assert
 * positively rather than by a blanket "no edge" — is:
 *
 * - **direction**: `packages/risk` declares NEITHER consumer, so the graph is
 *   acyclic (F9) and the ports below stay structural in the direction that
 *   matters;
 * - **surface**: the edge carries the prototype-free parse door and nothing
 *   else, which is the ruling's own constraint ("No rule, policy, or
 *   evaluation logic may travel this edge"). The record port and the
 *   reservation port above are STILL structural: this package neither imports
 *   `packages/risk`'s engine nor `packages/capital-allocator` at all.
 */
describe("independence — the only workspace edges are the cited §2.1 door edges", () => {
  interface Manifest {
    readonly name: string;
    readonly dependencies?: Record<string, string>;
    readonly devDependencies?: Record<string, string>;
  }

  const DOOR_SUBPATHS = ["@polymarket-bot/risk/plain-data", "@polymarket-bot/risk/schema-arena"];

  function manifestOf(dir: string): Manifest {
    return JSON.parse(readFileSync(resolve(repoRoot, dir, "package.json"), "utf8")) as Manifest;
  }

  function peersOf(manifest: Manifest): string[] {
    return Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })
      .filter((dependency) => dependency.startsWith("@polymarket-bot/"))
      .sort();
  }

  it("among the three, the only declared edges are S3 and S4 — both INTO packages/risk", () => {
    const planner = manifestOf("packages/execution-planner");
    const risk = manifestOf("packages/risk");
    const allocator = manifestOf("packages/capital-allocator");
    const theThree = new Set([planner.name, risk.name, allocator.name]);

    // S4 and S3: each consumer declares the canonical package, and only it.
    for (const consumer of [planner, allocator]) {
      const amongTheThree = peersOf(consumer).filter((dependency) => theThree.has(dependency));
      expect(amongTheThree, `${consumer.name}'s edges among the three`).toEqual([risk.name]);
    }
    // The reverse direction stays empty: risk declares neither consumer (F9).
    expect(peersOf(risk).filter((dependency) => theThree.has(dependency))).toEqual([]);
    // And the two consumers still do not know about each other.
    expect(peersOf(planner)).not.toContain(allocator.name);
    expect(peersOf(allocator)).not.toContain(planner.name);
  });

  it("the planner's dependency list is the two downward edges plus the S4 door edge", () => {
    const manifest = manifestOf("packages/execution-planner");
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([
      "@polymarket-bot/decimal",
      "@polymarket-bot/domain",
      "@polymarket-bot/risk",
    ]);
  });

  /**
   * The scan is `source-scan.ts`'s RECURSIVE walker (review round 1, finding
   * M7). It used to be `readdirSync(src)`, one level deep, and a file at
   * `packages/execution-planner/src/nested/sneak.ts` importing the risk ENGINE
   * from the package root passed this test, `determinism.test.ts`,
   * `check:deps`, `typecheck` and `lint` — the collapse is what made that
   * import RESOLVE, so the depth of this scan is now load-bearing.
   */
  it("the S4 edge carries the parse door and NOTHING ELSE — not the package root", () => {
    const files = packageSourceFiles("packages/execution-planner");
    const specifiers: string[] = [];
    for (const file of files) {
      for (const match of readSource(file).matchAll(
        /(?:from|import\()\s*"(@polymarket-bot\/risk[^"]*)"/gu,
      )) {
        specifiers.push(match[1] ?? "");
      }
    }
    // Non-vacuity: the scan found the tree, and the planner really does consume
    // the door.
    expect(files.length).toBeGreaterThan(10);
    expect(specifiers.length).toBeGreaterThan(0);
    expect([...new Set(specifiers)].sort()).toEqual(DOOR_SUBPATHS);
  });

  it("the record and reservation ports stay STRUCTURAL: no import of the engine or the allocator", () => {
    const files = packageSourceFiles("packages/execution-planner");
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      for (const match of readSource(file).matchAll(/(?:from|import\()\s*"([^"]+)"/gu)) {
        const specifier = match[1] ?? "";
        expect(specifier, `${file} imports the allocator`).not.toMatch(
          /^@polymarket-bot\/capital-allocator(?:\/|$)/u,
        );
        // The package ROOT of `packages/risk` is where the engine, the policy
        // and the recommendations live. Only the door subpaths may be imported.
        if (specifier.startsWith("@polymarket-bot/risk")) {
          expect(DOOR_SUBPATHS, `${file} imports ${specifier}`).toContain(specifier);
        }
      }
    }
  });
});
