/**
 * The capital-allocator → risk STRUCTURAL PORT, pinned.
 *
 * `packages/capital-allocator` and `packages/risk` are both layer 1 and
 * `docs/contracts/dependency-direction.md` §2.1 lists no same-layer edge
 * between them (F13), so the risk engine consumes the allocator's exposure
 * snapshot and reservation verdict STRUCTURALLY — by shape, not by import.
 *
 * A structural port rots silently, so this file pins it three ways:
 *
 * 1. `tsc`-checked field names (`satisfies readonly (keyof …)[]`): renaming a
 *    field on the allocator side fails `pnpm typecheck`, not just this suite;
 * 2. a RUNTIME parse of real allocator output against the risk schemas;
 * 3. an END-TO-END pass: the allocator's own snapshot driving a risk refusal.
 *
 * A test tree is not a workspace package, so importing both here declares no
 * dependency edge — and the last test asserts that neither manifest declares
 * the other, which is the property the whole arrangement rests on.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  applyReservation,
  createAllocatorState,
  evaluateReservation,
  exposureSnapshot,
  exposureSnapshotCovering,
  parseAllocatorCaps,
  type ExposureEntry,
  type ReservationVerdict,
} from "../../../packages/capital-allocator/src/index.js";
import {
  AllocationVerdictViewSchema,
  ExposureSnapshotViewSchema,
  evaluateIntent,
} from "../../../packages/risk/src/index.js";
import {
  INSTANCE,
  MARKET_A,
  MARKET_B,
  allScenarios,
  codesOf,
  entryInput,
  freshObservations,
  market,
  positionIntent,
  riskPolicy,
} from "./fixtures.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * COMPILE-TIME PIN. The risk engine reads exactly these two components of an
 * exposure entry and recomputes their sum; `satisfies` makes a rename on the
 * allocator side a type error here.
 */
const EXPOSURE_COMPONENTS = [
  "openOrderCommitted",
  "positionCommitted",
] as const satisfies readonly (keyof ExposureEntry)[];

/** COMPILE-TIME PIN. The risk engine reads these fields of a verdict. */
const VERDICT_FIELDS = ["permitted", "refusals"] as const satisfies readonly (keyof ReservationVerdict)[];

function allocatorFixture() {
  const caps = parseAllocatorCaps({ globalAccountCap: "1000", perStrategyCap: "1000" });
  if (!caps.ok) throw new Error(JSON.stringify(caps.refusals));
  const state = createAllocatorState({
    accountEquity: "1000",
    availableCollateral: "1000",
    positions: [
      {
        positionId: "p-1",
        marketId: MARKET_A,
        strategyInstanceId: INSTANCE,
        side: "YES",
        shares: "100",
        costBasis: "40",
        scope: { seriesKey: "btc-15m", underlyingKey: "BTC", resolutionWindowKey: "w1" },
      },
    ],
    openOrders: [
      {
        orderId: "o-1",
        marketId: MARKET_A,
        strategyInstanceId: INSTANCE,
        side: "NO",
        action: "BUY",
        price: "0.3",
        shares: "200",
        scope: { seriesKey: "btc-15m", underlyingKey: "BTC", resolutionWindowKey: "w1" },
      },
    ],
    liveOwners: [{ marketId: MARKET_A, strategyInstanceId: INSTANCE }],
  });
  if (!state.ok) throw new Error(JSON.stringify(state.refusals));
  return { caps: caps.value, state: state.value };
}

describe("compile-time field pin", () => {
  it("names the two exposure components the risk side recomputes from", () => {
    expect([...EXPOSURE_COMPONENTS]).toEqual(["openOrderCommitted", "positionCommitted"]);
  });

  it("names the verdict fields the risk side reads", () => {
    expect([...VERDICT_FIELDS]).toEqual(["permitted", "refusals"]);
  });
});

describe("runtime parse pin", () => {
  it("a real allocator exposure snapshot satisfies the risk view schema", () => {
    const { state } = allocatorFixture();
    const snapshot = exposureSnapshot(state);
    const parsed = ExposureSnapshotViewSchema.safeParse(snapshot);
    expect(parsed.success).toBe(true);
    // Both components survive the port, separately (acceptance 1).
    expect(snapshot.global.openOrderCommitted).toBe("60");
    expect(snapshot.global.positionCommitted).toBe("40");
    expect(snapshot.global.combined).toBe("100");
  });

  it("a real allocator reservation verdict satisfies the risk view schema", () => {
    const { caps, state } = allocatorFixture();
    const permitted = evaluateReservation(state, caps, {
      reservationId: "res-1",
      strategyInstanceId: INSTANCE,
      runMode: "PAPER",
      accountingMode: "LIVE",
      marketId: MARKET_A,
      side: "YES",
      action: "BUY",
      price: "0.5",
      shares: "10",
    });
    expect(AllocationVerdictViewSchema.safeParse(permitted).success).toBe(true);
    expect(permitted.permitted).toBe(true);

    const refused = evaluateReservation(state, caps, {
      reservationId: "res-2",
      strategyInstanceId: "someone-else",
      runMode: "PAPER",
      accountingMode: "LIVE",
      marketId: MARKET_A,
      side: "YES",
      action: "BUY",
      price: "0.5",
      shares: "10",
    });
    const parsedRefused = AllocationVerdictViewSchema.safeParse(refused);
    expect(parsedRefused.success).toBe(true);
    expect(refused.permitted).toBe(false);
  });
});

describe("end-to-end: the allocator's own numbers drive the risk limit", () => {
  it("a per-market cap breach is detected from a real allocator snapshot", () => {
    const { state } = allocatorFixture();
    const input = entryInput();
    input.exposures = exposureSnapshot(state) as unknown as Record<string, unknown>;

    const policy = riskPolicy({
      limits: { maxWorstCaseContractualLoss: "10000", perMarketExposureCap: "100" },
    });
    const result = evaluateIntent(policy, input);

    expect(result.approved).toBe(false);
    expect(codesOf(result)).toContain("RISK_MARKET_EXPOSURE_EXCEEDED");
  });

  it("a real allocator REFUSAL is carried through as RISK_ALLOCATION_REFUSED with its codes", () => {
    const { caps, state } = allocatorFixture();
    const refused = evaluateReservation(state, caps, {
      reservationId: "res-3",
      strategyInstanceId: INSTANCE,
      runMode: "PAPER",
      accountingMode: "LIVE",
      marketId: MARKET_A,
      side: "YES",
      action: "SELL",
      price: "0.9",
      shares: "9999",
    });
    expect(refused.permitted).toBe(false);

    const input = entryInput();
    input.allocation = refused as unknown as Record<string, unknown>;
    const result = evaluateIntent(riskPolicy(), input);

    expect(result.approved).toBe(false);
    const refusal = result.refusals.find((r) => r.code === "RISK_ALLOCATION_REFUSED");
    expect(refusal).toBeDefined();
    expect(refusal?.details["allocatorCodes"]).toContain("CAPITAL_INVENTORY_INSUFFICIENT");
  });

  /**
   * REVIEW ROUND 1, BLOCKER 2 — the two sides of the fix, end to end.
   *
   * `exposureSnapshot` is sparse: a market with no commitments has no row. The
   * risk side now REFUSES that gap instead of reading it as zero, and
   * `exposureSnapshotCovering` is how a composition root closes it honestly.
   */
  it("a sparse allocator snapshot blocks a cap on an unmentioned market", () => {
    const { state } = allocatorFixture();
    const input = entryInput();
    // MARKET_B has no commitments, so the sparse snapshot has no row for it.
    input.intent = { ...positionIntent(), marketId: MARKET_B };
    input.markets = [market({ marketId: MARKET_B })];
    input.freshness = freshObservations(MARKET_B);
    input.scenarios = allScenarios("0.4", [MARKET_B]);
    input.exposures = exposureSnapshot(state) as unknown as Record<string, unknown>;

    const policy = riskPolicy({
      // Roomy: if the absent row really meant zero, this would pass.
      limits: { maxWorstCaseContractualLoss: "10000", perMarketExposureCap: "10000" },
    });
    const result = evaluateIntent(policy, input);

    expect(result.approved).toBe(false);
    expect(codesOf(result)).toContain("RISK_EXPOSURE_ENTRY_MISSING");
  });

  it("the SAME evaluation passes once the allocator covers the queried scope", () => {
    const { state } = allocatorFixture();
    const input = entryInput();
    input.intent = { ...positionIntent(), marketId: MARKET_B };
    input.markets = [market({ marketId: MARKET_B })];
    input.freshness = freshObservations(MARKET_B);
    input.scenarios = allScenarios("0.4", [MARKET_B]);
    const covering = exposureSnapshotCovering(state, { marketIds: [MARKET_B] });
    input.exposures = covering as unknown as Record<string, unknown>;

    // The covering snapshot is still a valid structural port.
    expect(ExposureSnapshotViewSchema.safeParse(covering).success).toBe(true);
    expect(covering.byMarket[MARKET_B]?.combined).toBe("0");

    const policy = riskPolicy({
      limits: { maxWorstCaseContractualLoss: "10000", perMarketExposureCap: "10000" },
    });
    const result = evaluateIntent(policy, input);

    expect(codesOf(result)).toEqual([]);
    expect(result.approved).toBe(true);
  });

  it("an applied reservation raises the allocator exposure the risk engine then sees", () => {
    const { caps, state } = allocatorFixture();
    const applied = applyReservation(state, caps, {
      reservationId: "res-4",
      strategyInstanceId: INSTANCE,
      runMode: "PAPER",
      accountingMode: "LIVE",
      marketId: MARKET_A,
      side: "YES",
      action: "BUY",
      price: "0.5",
      shares: "100",
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const before = exposureSnapshot(state).global.combined;
    const after = exposureSnapshot(applied.value.state).global.combined;
    expect(before).toBe("100");
    expect(after).toBe("150");
  });
});

describe("no workspace edge exists between the two packages", () => {
  function manifest(name: string): Record<string, Record<string, string> | undefined> {
    return JSON.parse(
      readFileSync(resolve(repoRoot, "packages", name, "package.json"), "utf8"),
    ) as Record<string, Record<string, string> | undefined>;
  }

  it("neither manifest declares the other (dependency-direction F13)", () => {
    for (const [self, other] of [
      ["risk", "@polymarket-bot/capital-allocator"],
      ["capital-allocator", "@polymarket-bot/risk"],
    ] as const) {
      const declared = {
        ...(manifest(self)["dependencies"] ?? {}),
        ...(manifest(self)["devDependencies"] ?? {}),
      };
      expect(Object.keys(declared)).not.toContain(other);
    }
  });

  it("neither package declares any other layer-1 workspace peer", () => {
    // The only workspace dependencies either package may hold are the two
    // layer-0 contracts; anything else would be a same-layer edge needing a
    // cited §2.1 row.
    for (const name of ["risk", "capital-allocator"] as const) {
      const declared = Object.keys({
        ...(manifest(name)["dependencies"] ?? {}),
        ...(manifest(name)["devDependencies"] ?? {}),
      }).filter((dependency) => dependency.startsWith("@polymarket-bot/"));
      expect(declared.sort()).toEqual(["@polymarket-bot/decimal", "@polymarket-bot/domain"]);
    }
  });

  it("neither package's source IMPORTS the other, or any other layer-1 peer", () => {
    // Prose references to a peer package are expected — the mirrored modules
    // cite where they were mirrored from. What must not appear is an import
    // SPECIFIER, so the assertion is on `from "<name>"`, not on the name.
    const forbiddenPeers = [
      "@polymarket-bot/capital-allocator",
      "@polymarket-bot/risk",
      "@polymarket-bot/settlement",
      "@polymarket-bot/universe",
      "@polymarket-bot/order-book",
      "@polymarket-bot/features",
    ];
    for (const name of ["risk", "capital-allocator"] as const) {
      const directory = resolve(repoRoot, "packages", name, "src");
      for (const entry of readdirSync(directory)) {
        if (!entry.endsWith(".ts")) continue;
        const text = readFileSync(resolve(directory, entry), "utf8");
        for (const peer of forbiddenPeers) {
          if (peer === `@polymarket-bot/${name}`) continue;
          expect(text, `${name}/src/${entry} imports ${peer}`).not.toContain(`from "${peer}"`);
          expect(text, `${name}/src/${entry} imports ${peer}`).not.toContain(`import("${peer}")`);
        }
      }
    }
  });
});
