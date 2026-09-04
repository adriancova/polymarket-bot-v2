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
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

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

describe("independence — no workspace edge exists in any direction", () => {
  it("no manifest among the three declares any of the others", () => {
    const names = [
      "packages/execution-planner",
      "packages/risk",
      "packages/capital-allocator",
    ];
    const manifests = names.map((name) => {
      const parsed = JSON.parse(readFileSync(resolve(repoRoot, name, "package.json"), "utf8")) as {
        name: string;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      return parsed;
    });
    const workspaceNames = new Set(manifests.map((manifest) => manifest.name));
    for (const manifest of manifests) {
      for (const dependency of Object.keys({
        ...manifest.dependencies,
        ...manifest.devDependencies,
      })) {
        expect(workspaceNames.has(dependency), `${manifest.name} declares ${dependency}`).toBe(false);
      }
    }
  });

  it("the planner's dependency list is exactly the two downward edges", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(repoRoot, "packages/execution-planner/package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([
      "@polymarket-bot/decimal",
      "@polymarket-bot/domain",
    ]);
  });
});
