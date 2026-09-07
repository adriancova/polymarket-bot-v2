/**
 * Allocator unit tests (WP-180).
 *
 * Acceptance 1 (workplan): "Open orders and positions both consume limits."
 * The two named probes live here at the reservation gate and are repeated at
 * the intent gate in `test/unit/risk/acceptance.test.ts`.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  AllocatorCapsSchema,
  LIVE_MICRO_CAP_FIELDS,
  LIVE_MICRO_CAP_FLOOR,
  parseAllocatorCaps,
  type AllocatorCaps,
} from "./caps.js";
import {
  EXPOSURE_ZERO,
  exposureSnapshot,
  exposureSnapshotCovering,
  shadowExposureSnapshot,
} from "./exposure.js";
import {
  CAPITAL_REFUSAL_CODES,
  CAPITAL_REFUSAL_CODES_ARE_EXHAUSTIVE,
  CAPITAL_REFUSAL_CODE_COUNT,
  isCapitalRefusalCode,
} from "./refusals.js";
import {
  applyReservation,
  evaluateReservation,
  releaseReservation,
  type ReservationRequest,
} from "./reserve.js";
import { createAllocatorState, withLiveOwner, type AllocatorState } from "./state.js";

const MARKET_A = "01890000-0000-7000-8000-000000000001";
const MARKET_B = "01890000-0000-7000-8000-000000000002";
/**
 * MINTED, `0`-LEADING UUIDv7s (`ALLOC-1`, ADR-021's 2026-09-06 amendment).
 *
 * These were `"strat-a"` and `"strat-b"` until this round, because
 * `strategyInstanceId` was typed `CodeStringSchema` at the four doors
 * `reserve.ts:69` and `state.ts:68,:81,:92`. ADR-021 ruled that a mis-typing:
 * the field is a minted IDENTITY, and `CodeStringSchema`'s leading-letter rule
 * refused every UUIDv7 an honest generator produces before ~2527. The whole
 * suite therefore now runs on exactly the population the old typing refused —
 * the strongest available spelling, since a letter-leading UUIDv7 would have
 * passed both grammars and left the widening unexercised here.
 * `adr-021-instance-identity.test.ts` holds the door-by-door transcript.
 */
const INSTANCE = "018f4a7e-2222-7abc-8def-0123456789ab";
const OTHER_INSTANCE = "018f4a7e-3333-7abc-8def-0123456789ab";

function caps(overrides: Partial<AllocatorCaps> = {}): AllocatorCaps {
  const parsed = parseAllocatorCaps({
    globalAccountCap: "1000",
    perStrategyCap: "1000",
    ...overrides,
  });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.refusals));
  return parsed.value;
}

interface StateOverrides {
  accountEquity?: string;
  availableCollateral?: string;
  positions?: readonly unknown[];
  openOrders?: readonly unknown[];
  liveOwners?: readonly unknown[];
}

function state(overrides: StateOverrides = {}): AllocatorState {
  const created = createAllocatorState({
    accountEquity: "1000",
    availableCollateral: "1000",
    positions: [],
    openOrders: [],
    liveOwners: [{ marketId: MARKET_A, strategyInstanceId: INSTANCE }],
    ...overrides,
  });
  if (!created.ok) throw new Error(JSON.stringify(created.refusals));
  return created.value;
}

function request(overrides: Partial<ReservationRequest> = {}): ReservationRequest {
  return {
    reservationId: "res-1",
    strategyInstanceId: INSTANCE,
    runMode: "PAPER",
    accountingMode: "LIVE",
    marketId: MARKET_A,
    side: "YES",
    action: "BUY",
    price: "0.5",
    shares: "100",
    ...overrides,
  };
}

function refusalCodes(verdict: { permitted: boolean; refusals: readonly { code: string }[] }) {
  return verdict.refusals.map((refusal) => refusal.code);
}

describe("parseAllocatorCaps", () => {
  it("defaults BOTH live-micro caps to exactly '0' (AGENTS.md safety defaults)", () => {
    const parsed = parseAllocatorCaps({ globalAccountCap: "10", perStrategyCap: "5" });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.liveMicroMaxOrderNotional).toBe("0");
    expect(parsed.value.liveMicroMaxAccountExposure).toBe("0");
  });

  it("requires the user-defined global and per-strategy caps (§9.7: no hardcoded example defaults)", () => {
    const parsed = parseAllocatorCaps({});
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.refusals[0]?.code).toBe("CAPITAL_INPUT_INVALID");
  });

  it("refuses a float where a decimal string is required (§6 invariant 1)", () => {
    const parsed = parseAllocatorCaps({ globalAccountCap: 1000, perStrategyCap: "5" });
    expect(parsed.ok).toBe(false);
  });

  it("refuses a non-canonical decimal spelling", () => {
    const parsed = parseAllocatorCaps({ globalAccountCap: "1e3", perStrategyCap: "5" });
    expect(parsed.ok).toBe(false);
  });
});

/**
 * REVIEW ROUND 1, HIGH — the live-micro caps DEFAULTED to `"0"` but accepted
 * any caller-supplied value, so this package was a weakening vector for the
 * `AGENTS.md` non-weakenable safety defaults
 * (`LIVE_MICRO_MAX_ORDER_NOTIONAL=0`, `LIVE_MICRO_MAX_ACCOUNT_EXPOSURE=0`).
 * A nonzero live-micro cap is now refused OUTRIGHT, at three layers. Enabling
 * live-micro capacity is a separate, explicitly authorized, fenced later-phase
 * work package — never a caller argument to this one.
 */
describe("the live-micro cap fence (AGENTS.md safety defaults are not caller arguments)", () => {
  for (const field of LIVE_MICRO_CAP_FIELDS) {
    it(`parseAllocatorCaps REFUSES a nonzero ${field}`, () => {
      const parsed = parseAllocatorCaps({
        globalAccountCap: "1000",
        perStrategyCap: "1000",
        [field]: "1000000",
      });
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.refusals.map((r) => r.code)).toEqual([
        "CAPITAL_LIVE_MICRO_CAP_NOT_PERMITTED",
      ]);
      expect(parsed.refusals[0]?.details["field"]).toBe(field);
      expect(parsed.refusals[0]?.details["supplied"]).toBe("1000000");
      expect(parsed.refusals[0]?.details["permitted"]).toBe(LIVE_MICRO_CAP_FLOOR);
    });

    it(`parseAllocatorCaps refuses even the smallest raise of ${field}`, () => {
      const parsed = parseAllocatorCaps({
        globalAccountCap: "1000",
        perStrategyCap: "1000",
        [field]: "0.000001",
      });
      expect(parsed.ok).toBe(false);
    });
  }

  it("refuses both fields at once, naming both", () => {
    const parsed = parseAllocatorCaps({
      globalAccountCap: "1000",
      perStrategyCap: "1000",
      liveMicroMaxOrderNotional: "1",
      liveMicroMaxAccountExposure: "1",
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.refusals.map((r) => r.details["field"])).toEqual([...LIVE_MICRO_CAP_FIELDS]);
  });

  it("accepts the exact floor, explicitly supplied", () => {
    const parsed = parseAllocatorCaps({
      globalAccountCap: "1000",
      perStrategyCap: "1000",
      liveMicroMaxOrderNotional: "0",
      liveMicroMaxAccountExposure: "0",
    });
    expect(parsed.ok).toBe(true);
  });

  it("the schema itself carries the fence, so parsing directly cannot bypass it", () => {
    const direct = AllocatorCapsSchema.safeParse({
      globalAccountCap: "1000",
      perStrategyCap: "1000",
      liveMicroMaxOrderNotional: "5",
    });
    expect(direct.success).toBe(false);
  });

  it("the reservation gate refuses a HAND-BUILT caps object that raised a floor", () => {
    // Bypasses `parseAllocatorCaps` and the schema entirely: the second fence
    // layer lives at the enforcement site for exactly this caller.
    const raised = {
      ...caps(),
      liveMicroMaxOrderNotional: "1000",
      liveMicroMaxAccountExposure: "1000",
    } as AllocatorCaps;
    const verdict = evaluateReservation(state(), raised, request({ runMode: "LIVE_MICRO" }));
    expect(verdict.permitted).toBe(false);
    expect(refusalCodes(verdict)).toContain("CAPITAL_LIVE_MICRO_CAP_NOT_PERMITTED");
  });

  it("a raised floor makes the caps unusable in EVERY run mode, PAPER included", () => {
    const raised = { ...caps(), liveMicroMaxOrderNotional: "1000" } as AllocatorCaps;
    for (const runMode of ["PAPER", "BACKTEST", "EXECUTION_PROBE", "LIVE_MICRO", "LIVE"] as const) {
      const verdict = evaluateReservation(state(), raised, request({ runMode }));
      expect(verdict.permitted).toBe(false);
      expect(refusalCodes(verdict)).toContain("CAPITAL_LIVE_MICRO_CAP_NOT_PERMITTED");
    }
  });

  it("applyReservation cannot slip past it either", () => {
    const raised = { ...caps(), liveMicroMaxAccountExposure: "1000" } as AllocatorCaps;
    const applied = applyReservation(state(), raised, request());
    expect(applied.ok).toBe(false);
    if (applied.ok) return;
    expect(applied.refusals.map((r) => r.code)).toContain("CAPITAL_LIVE_MICRO_CAP_NOT_PERMITTED");
  });

  it("a non-canonical or unparseable value also refuses (fail closed, never throws)", () => {
    for (const bogus of ["0.0", "00", "-0", "", "abc"]) {
      const raised = { ...caps(), liveMicroMaxOrderNotional: bogus } as AllocatorCaps;
      const verdict = evaluateReservation(state(), raised, request());
      expect(verdict.permitted).toBe(false);
      expect(refusalCodes(verdict)).toContain("CAPITAL_LIVE_MICRO_CAP_NOT_PERMITTED");
    }
  });
});

describe("the refusal-code vocabulary", () => {
  /**
   * WHAT THIS BINDS (corrected in remediation round 2 — review round 2, LOW):
   * `CAPITAL_REFUSAL_CODES`, `CAPITAL_REFUSAL_CODE_COUNT`, the compile-time
   * exhaustiveness proof, and — in the README test below — `README.md` §5. The
   * previous title also claimed `docs/handoffs/WP-180.md`, which neither test
   * reads. The handoff is an append-only historical record; binding a package
   * suite to it would oblige future packages to edit a closed package's
   * governance record, so the living README is what is machine-bound and the
   * handoff's number stays prose verified at review time. Same reasoning, same
   * wording, as `test/unit/risk/engine.test.ts`.
   */
  it("matches its documented cardinality exactly (list, constant, exhaustiveness)", () => {
    expect(CAPITAL_REFUSAL_CODES.length).toBe(CAPITAL_REFUSAL_CODE_COUNT);
    expect(CAPITAL_REFUSAL_CODE_COUNT).toBe(19);
    expect(CAPITAL_REFUSAL_CODES_ARE_EXHAUSTIVE).toBe(true);
  });

  it("declares each code exactly once and recognises each one", () => {
    expect(new Set(CAPITAL_REFUSAL_CODES).size).toBe(CAPITAL_REFUSAL_CODES.length);
    for (const code of CAPITAL_REFUSAL_CODES) {
      expect(isCapitalRefusalCode(code)).toBe(true);
    }
    expect(isCapitalRefusalCode("CAPITAL_NOT_A_REAL_CODE")).toBe(false);
  });

  it("every code fits the frozen CodeString grammar (§14.3 metric labels)", () => {
    for (const code of CAPITAL_REFUSAL_CODES) {
      expect(code).toMatch(/^[A-Za-z][A-Za-z0-9_.:-]*$/u);
      expect(code.length).toBeLessThanOrEqual(64);
    }
  });

  it("the README documents every declared code, and declares every documented one", () => {
    const readme = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "../README.md"),
      "utf8",
    );
    const documented = new Set(
      [...readme.matchAll(/`(CAPITAL_[A-Z0-9_]+)`/gu)].map((match) => match[1] as string),
    );
    // Exported identifiers that share the code prefix but are not codes.
    documented.delete("CAPITAL_REFUSAL_CODES");
    documented.delete("CAPITAL_REFUSAL_CODE_COUNT");
    documented.delete("CAPITAL_REFUSAL_CODES_ARE_EXHAUSTIVE");
    expect(CAPITAL_REFUSAL_CODES.filter((code) => !documented.has(code))).toEqual([]);
    expect([...documented].filter((code) => !isCapitalRefusalCode(code))).toEqual([]);
    expect(documented.size).toBe(CAPITAL_REFUSAL_CODE_COUNT);
  });
});

/**
 * REVIEW ROUND 1, BLOCKER 2 — the consumer side must not read an absent entry
 * as zero, so the snapshot must be able to ANSWER for every scope a consumer
 * will query. `exposureSnapshotCovering` is how a composition root says which
 * scopes those are.
 */
describe("exposureSnapshotCovering — explicit zeros for every queried scope", () => {
  it("adds an explicit zero entry for a scope the state does not mention", () => {
    const snapshot = exposureSnapshotCovering(state(), {
      strategyInstanceIds: [INSTANCE],
      marketIds: [MARKET_A, MARKET_B],
      seriesKeys: ["btc-15m"],
      underlyingKeys: ["BTC"],
      resolutionWindowKeys: ["w1"],
    });
    expect(snapshot.byStrategyInstance[INSTANCE]).toEqual(EXPOSURE_ZERO);
    expect(snapshot.byMarket[MARKET_A]).toEqual(EXPOSURE_ZERO);
    expect(snapshot.byMarket[MARKET_B]).toEqual(EXPOSURE_ZERO);
    expect(snapshot.bySeries["btc-15m"]).toEqual(EXPOSURE_ZERO);
    expect(snapshot.byUnderlying["BTC"]).toEqual(EXPOSURE_ZERO);
    expect(snapshot.byResolutionWindow["w1"]).toEqual(EXPOSURE_ZERO);
  });

  it("never overwrites a real measurement with a zero", () => {
    const withExposure = state({
      positions: [
        {
          positionId: "p-1",
          marketId: MARKET_A,
          strategyInstanceId: INSTANCE,
          side: "YES",
          shares: "100",
          costBasis: "40",
        },
      ],
    });
    const snapshot = exposureSnapshotCovering(withExposure, {
      marketIds: [MARKET_A, MARKET_B],
    });
    expect(snapshot.byMarket[MARKET_A]?.combined).toBe("40");
    expect(snapshot.byMarket[MARKET_B]).toEqual(EXPOSURE_ZERO);
  });

  it("declares nothing when the coverage is empty, and stays frozen", () => {
    const snapshot = exposureSnapshotCovering(state(), {});
    expect(Object.keys(snapshot.byMarket)).toEqual([]);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });
});

describe("createAllocatorState", () => {
  it("derives reserved pUSD from open BUY orders (§9.7 'reserved pUSD')", () => {
    const s = state({
      openOrders: [
        {
          orderId: "o-1",
          marketId: MARKET_A,
          strategyInstanceId: INSTANCE,
          side: "YES",
          action: "BUY",
          price: "0.25",
          shares: "100",
        },
      ],
    });
    expect(s.reservedCollateral).toBe("25");
  });

  it("refuses a UUID-shaped, non-lowercase orderId (ADR-016 §2: refuse, never case-fold)", () => {
    const created = createAllocatorState({
      accountEquity: "1000",
      availableCollateral: "1000",
      positions: [],
      openOrders: [
        {
          orderId: "01890000-0000-7000-8000-0000000000AB",
          marketId: MARKET_A,
          strategyInstanceId: INSTANCE,
          side: "YES",
          action: "BUY",
          price: "0.25",
          shares: "100",
        },
      ],
      liveOwners: [],
    });
    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.refusals.map((r) => r.code)).toContain("CAPITAL_UUID_NOT_CANONICAL");
  });

  it("refuses two live owners for one market (ADR-011)", () => {
    const created = createAllocatorState({
      accountEquity: "1000",
      availableCollateral: "1000",
      positions: [],
      openOrders: [],
      liveOwners: [
        { marketId: MARKET_A, strategyInstanceId: INSTANCE },
        { marketId: MARKET_A, strategyInstanceId: OTHER_INSTANCE },
      ],
    });
    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.refusals.map((r) => r.code)).toContain("CAPITAL_LIVE_OWNERSHIP_CONFLICT");
  });

  it("refuses sell orders reserving more than the instance holds (§9.14: no double reservation)", () => {
    const created = createAllocatorState({
      accountEquity: "1000",
      availableCollateral: "1000",
      positions: [
        {
          positionId: "p-1",
          marketId: MARKET_A,
          strategyInstanceId: INSTANCE,
          side: "YES",
          shares: "50",
          costBasis: "25",
        },
      ],
      openOrders: [
        {
          orderId: "o-1",
          marketId: MARKET_A,
          strategyInstanceId: INSTANCE,
          side: "YES",
          action: "SELL",
          price: "0.6",
          shares: "80",
        },
      ],
      liveOwners: [],
    });
    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.refusals.map((r) => r.code)).toContain("CAPITAL_OVERSELL_UNBACKED");
  });

  it("refuses duplicate position and order ids", () => {
    const position = {
      positionId: "p-1",
      marketId: MARKET_A,
      strategyInstanceId: INSTANCE,
      side: "YES",
      shares: "1",
      costBasis: "0.5",
    };
    const created = createAllocatorState({
      accountEquity: "1000",
      availableCollateral: "1000",
      positions: [position, position],
      openOrders: [],
      liveOwners: [],
    });
    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.refusals.map((r) => r.code)).toContain("CAPITAL_DUPLICATE_IDENTIFIER");
  });

  it("returns a deeply frozen state (in-place edits throw)", () => {
    const s = state({
      positions: [
        {
          positionId: "p-1",
          marketId: MARKET_A,
          strategyInstanceId: INSTANCE,
          side: "YES",
          shares: "50",
          costBasis: "25",
        },
      ],
    });
    expect(Object.isFrozen(s)).toBe(true);
    expect(() => {
      (s.positions[0] as { shares: string }).shares = "999999";
    }).toThrow(TypeError);
    expect(s.positions[0]?.shares).toBe("50");
  });
});

describe("withLiveOwner", () => {
  it("rejects a conflicting live claim and preserves the original owner (ADR-011)", () => {
    const s = state();
    const claimed = withLiveOwner(s, MARKET_A, OTHER_INSTANCE);
    expect(claimed.ok).toBe(false);
    if (claimed.ok) return;
    expect(claimed.refusals[0]?.code).toBe("CAPITAL_LIVE_OWNERSHIP_CONFLICT");
    expect(s.liveOwners[MARKET_A]).toBe(INSTANCE);
  });

  it("is idempotent for the same owner and returns a NEW state for a new claim", () => {
    const s = state({ liveOwners: [] });
    const first = withLiveOwner(s, MARKET_B, INSTANCE);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value).not.toBe(s);
    expect(s.liveOwners[MARKET_B]).toBeUndefined();
    const again = withLiveOwner(first.value, MARKET_B, INSTANCE);
    expect(again.ok).toBe(true);
  });
});

describe("exposureSnapshot — open orders and positions BOTH consume (acceptance 1 accounting)", () => {
  it("sums position costBasis and open BUY order notional per scope", () => {
    const s = state({
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
        {
          orderId: "o-2",
          marketId: MARKET_A,
          strategyInstanceId: INSTANCE,
          side: "YES",
          action: "SELL",
          price: "0.9",
          shares: "10",
        },
      ],
    });
    const snap = exposureSnapshot(s);
    expect(snap.global.positionCommitted).toBe("40");
    expect(snap.global.openOrderCommitted).toBe("60");
    expect(snap.global.combined).toBe("100");
    expect(snap.byMarket[MARKET_A]?.combined).toBe("100");
    expect(snap.bySeries["btc-15m"]?.combined).toBe("100");
    expect(snap.byUnderlying["BTC"]?.combined).toBe("100");
    expect(snap.byResolutionWindow["w1"]?.combined).toBe("100");
    expect(snap.byStrategyInstance[INSTANCE]?.combined).toBe("100");
  });

  it("a SELL order contributes no pUSD exposure (it reserves tokens instead)", () => {
    const s = state({
      positions: [
        {
          positionId: "p-1",
          marketId: MARKET_A,
          strategyInstanceId: INSTANCE,
          side: "YES",
          shares: "10",
          costBasis: "5",
        },
      ],
      openOrders: [
        {
          orderId: "o-1",
          marketId: MARKET_A,
          strategyInstanceId: INSTANCE,
          side: "YES",
          action: "SELL",
          price: "0.9",
          shares: "10",
        },
      ],
    });
    expect(exposureSnapshot(s).global.openOrderCommitted).toBe("0");
  });
});

describe("evaluateReservation — acceptance 1 probes at the reservation gate", () => {
  it("PROBE A: a cap fully consumed by OPEN ORDERS blocks a new commitment with ZERO positions", () => {
    const s = state({
      positions: [],
      openOrders: [
        {
          orderId: "o-1",
          marketId: MARKET_A,
          strategyInstanceId: INSTANCE,
          side: "YES",
          action: "BUY",
          price: "0.5",
          shares: "2000", // notional 1000 == globalAccountCap
        },
      ],
    });
    const verdict = evaluateReservation(s, caps(), request({ price: "0.5", shares: "1" }));
    expect(verdict.permitted).toBe(false);
    expect(refusalCodes(verdict)).toContain("CAPITAL_GLOBAL_CAP_EXCEEDED");
  });

  it("PROBE B: a cap fully consumed by POSITIONS blocks a new commitment with ZERO open orders", () => {
    const s = state({
      positions: [
        {
          positionId: "p-1",
          marketId: MARKET_A,
          strategyInstanceId: INSTANCE,
          side: "YES",
          shares: "2000",
          costBasis: "1000", // == globalAccountCap
        },
      ],
      openOrders: [],
      accountEquity: "5000",
      availableCollateral: "4000",
    });
    const verdict = evaluateReservation(s, caps(), request({ price: "0.5", shares: "1" }));
    expect(verdict.permitted).toBe(false);
    expect(refusalCodes(verdict)).toContain("CAPITAL_GLOBAL_CAP_EXCEEDED");
  });

  it("permits the same commitment when neither component consumes the cap", () => {
    const verdict = evaluateReservation(state(), caps(), request());
    expect(verdict.permitted).toBe(true);
    if (!verdict.permitted) return;
    expect(verdict.reservation.cost).toBe("50");
    expect(verdict.refusals).toEqual([]);
  });

  it("the per-strategy cap also sums both components", () => {
    const s = state({
      positions: [
        {
          positionId: "p-1",
          marketId: MARKET_A,
          strategyInstanceId: INSTANCE,
          side: "YES",
          shares: "100",
          costBasis: "300",
        },
      ],
      openOrders: [
        {
          orderId: "o-1",
          marketId: MARKET_A,
          strategyInstanceId: INSTANCE,
          side: "NO",
          action: "BUY",
          price: "0.5",
          shares: "400", // notional 200 → combined 500
        },
      ],
    });
    const capsHalf = caps({ perStrategyCap: "500" });
    const verdict = evaluateReservation(s, capsHalf, request({ price: "0.5", shares: "1" }));
    expect(verdict.permitted).toBe(false);
    expect(refusalCodes(verdict)).toContain("CAPITAL_STRATEGY_CAP_EXCEEDED");
  });
});

describe("evaluateReservation — refusals", () => {
  it("refuses a live commitment with NO recorded live owner (fail closed, ADR-011)", () => {
    const s = state({ liveOwners: [] });
    const verdict = evaluateReservation(s, caps(), request());
    expect(verdict.permitted).toBe(false);
    expect(refusalCodes(verdict)).toContain("CAPITAL_LIVE_OWNERSHIP_MISSING");
  });

  it("refuses a live commitment when ANOTHER instance owns the market (§9.7: no netting)", () => {
    const s = state({
      liveOwners: [{ marketId: MARKET_A, strategyInstanceId: OTHER_INSTANCE }],
    });
    const verdict = evaluateReservation(s, caps(), request());
    expect(verdict.permitted).toBe(false);
    expect(refusalCodes(verdict)).toContain("CAPITAL_LIVE_OWNERSHIP_CONFLICT");
  });

  it("refuses a buy exceeding available pUSD", () => {
    const s = state({ availableCollateral: "49" });
    const verdict = evaluateReservation(s, caps(), request({ price: "0.5", shares: "100" }));
    expect(verdict.permitted).toBe(false);
    expect(refusalCodes(verdict)).toContain("CAPITAL_COLLATERAL_INSUFFICIENT");
  });

  it("refuses a sell exceeding the instance's unreserved holdings", () => {
    const s = state({
      positions: [
        {
          positionId: "p-1",
          marketId: MARKET_A,
          strategyInstanceId: INSTANCE,
          side: "YES",
          shares: "50",
          costBasis: "25",
        },
      ],
    });
    const verdict = evaluateReservation(
      s,
      caps(),
      request({ action: "SELL", side: "YES", shares: "51", price: "0.9" }),
    );
    expect(verdict.permitted).toBe(false);
    expect(refusalCodes(verdict)).toContain("CAPITAL_INVENTORY_INSUFFICIENT");
  });

  it("a sell may not spend ANOTHER instance's holdings (§6 invariant 7)", () => {
    const s = state({
      positions: [
        {
          positionId: "p-1",
          marketId: MARKET_A,
          strategyInstanceId: OTHER_INSTANCE,
          side: "YES",
          shares: "50",
          costBasis: "25",
        },
      ],
    });
    const verdict = evaluateReservation(
      s,
      caps(),
      request({ action: "SELL", side: "YES", shares: "10", price: "0.9" }),
    );
    expect(verdict.permitted).toBe(false);
    expect(refusalCodes(verdict)).toContain("CAPITAL_INVENTORY_INSUFFICIENT");
  });

  it("fails closed when a series cap is configured and the request has no series key", () => {
    const verdict = evaluateReservation(state(), caps({ perSeriesCap: "100" }), request());
    expect(verdict.permitted).toBe(false);
    expect(refusalCodes(verdict)).toContain("CAPITAL_SCOPE_KEY_MISSING");
  });

  it("refuses a UUID-shaped non-lowercase reservationId (ADR-016)", () => {
    const verdict = evaluateReservation(
      state(),
      caps(),
      request({ reservationId: "01890000-0000-7000-8000-0000000000AB" }),
    );
    expect(verdict.permitted).toBe(false);
    expect(refusalCodes(verdict)).toContain("CAPITAL_UUID_NOT_CANONICAL");
  });

  it("refuses a malformed request without repairing it", () => {
    const verdict = evaluateReservation(state(), caps(), {
      ...request(),
      price: 0.5,
    });
    expect(verdict.permitted).toBe(false);
    expect(refusalCodes(verdict)).toContain("CAPITAL_INPUT_INVALID");
  });
});

describe("evaluateReservation — real-order run modes against zero live-micro caps", () => {
  for (const runMode of ["EXECUTION_PROBE", "LIVE_MICRO", "LIVE"] as const) {
    it(`refuses any positive-notional ${runMode} commitment under the default "0" caps`, () => {
      const verdict = evaluateReservation(state(), caps(), request({ runMode }));
      expect(verdict.permitted).toBe(false);
      expect(refusalCodes(verdict)).toContain("CAPITAL_LIVE_MICRO_ORDER_NOTIONAL_EXCEEDED");
    });
  }

  it("PAPER mode is not subject to the live-micro caps", () => {
    const verdict = evaluateReservation(state(), caps(), request({ runMode: "PAPER" }));
    expect(verdict.permitted).toBe(true);
  });
});

describe("apply/release reservation", () => {
  it("applying a live BUY moves collateral available → reserved and consumes exposure", () => {
    const applied = applyReservation(state(), caps(), request());
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.value.state.availableCollateral).toBe("950");
    expect(applied.value.state.reservedCollateral).toBe("50");
    expect(exposureSnapshot(applied.value.state).global.openOrderCommitted).toBe("50");
  });

  it("apply re-evaluates against THIS state, so a stale verdict cannot overspend", () => {
    const s = state({ availableCollateral: "50" });
    const first = applyReservation(s, caps(), request({ reservationId: "res-1" }));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = applyReservation(
      first.value.state,
      caps(),
      request({ reservationId: "res-2" }),
    );
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.refusals.map((r) => r.code)).toContain("CAPITAL_COLLATERAL_INSUFFICIENT");
  });

  it("refuses a duplicate reservationId", () => {
    const first = applyReservation(state(), caps(), request());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const dup = applyReservation(first.value.state, caps(), request({ shares: "1" }));
    expect(dup.ok).toBe(false);
    if (dup.ok) return;
    expect(dup.refusals.map((r) => r.code)).toContain("CAPITAL_DUPLICATE_IDENTIFIER");
  });

  it("release returns the capacity and refuses an unknown id", () => {
    const applied = applyReservation(state(), caps(), request());
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const released = releaseReservation(applied.value.state, "res-1");
    expect(released.ok).toBe(true);
    if (!released.ok) return;
    expect(released.value.availableCollateral).toBe("1000");
    expect(released.value.reservedCollateral).toBe("0");
    const unknown = releaseReservation(released.value, "res-1");
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    expect(unknown.refusals[0]?.code).toBe("CAPITAL_UNKNOWN_RESERVATION");
  });

  it("does not mutate the prior state (value semantics)", () => {
    const s = state();
    const applied = applyReservation(s, caps(), request());
    expect(applied.ok).toBe(true);
    expect(s.availableCollateral).toBe("1000");
    expect(s.reservations).toEqual([]);
  });
});

describe("independent shadow accounting (§9.7)", () => {
  it("a shadow reservation never consumes live collateral or live exposure", () => {
    const applied = applyReservation(
      state({ liveOwners: [] }),
      caps(),
      request({ accountingMode: "SHADOW" }),
    );
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.value.state.availableCollateral).toBe("1000");
    expect(exposureSnapshot(applied.value.state).global.combined).toBe("0");
    expect(
      shadowExposureSnapshot(applied.value.state, INSTANCE).global.openOrderCommitted,
    ).toBe("50");
  });

  it("a shadow reservation needs no live ownership", () => {
    const verdict = evaluateReservation(
      state({ liveOwners: [] }),
      caps(),
      request({ accountingMode: "SHADOW" }),
    );
    expect(verdict.permitted).toBe(true);
  });

  it("shadow books are per-instance: one instance's shadow book is invisible to another's", () => {
    const applied = applyReservation(
      state({ liveOwners: [] }),
      caps(),
      request({ accountingMode: "SHADOW" }),
    );
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(
      shadowExposureSnapshot(applied.value.state, OTHER_INSTANCE).global.combined,
    ).toBe("0");
  });

  it("shadow caps bind against the instance's own shadow book", () => {
    const first = applyReservation(
      state({ liveOwners: [] }),
      caps({ perStrategyCap: "50" }),
      request({ accountingMode: "SHADOW" }), // cost 50, exactly at cap
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = evaluateReservation(
      first.value.state,
      caps({ perStrategyCap: "50" }),
      request({ accountingMode: "SHADOW", reservationId: "res-2", shares: "1" }),
    );
    expect(second.permitted).toBe(false);
    expect(refusalCodes(second)).toContain("CAPITAL_STRATEGY_CAP_EXCEEDED");
  });

  it("a live commitment is not blocked by shadow consumption (independence both ways)", () => {
    const shadow = applyReservation(
      state(),
      caps({ globalAccountCap: "60" }),
      request({ accountingMode: "SHADOW", reservationId: "shadow-1" }),
    );
    expect(shadow.ok).toBe(true);
    if (!shadow.ok) return;
    const live = evaluateReservation(
      shadow.value.state,
      caps({ globalAccountCap: "60" }),
      request({ reservationId: "live-1" }),
    );
    expect(live.permitted).toBe(true);
  });
});

/**
 * A HOSTILE VALUE AT THIS PACKAGE'S INPUT DOORS — review round 5, BLOCKER 3.
 *
 * The reported site was `parseAllocatorCaps`: a valid-SHAPED object whose
 * `globalAccountCap` was a throwing getter made it THROW rather than refuse,
 * because `zod` reads properties and a getter is caller code. The sweep found
 * the same class at `createAllocatorState` and at both reservation entry
 * points, and found a second, live defect on the way — every scope table in
 * this package was keyed with `[]`, which reads and writes THROUGH the
 * prototype chain, and this package's scope keys are `CodeString`s, so
 * `"constructor"` is admissible input.
 *
 * Fixes: `src/plain-data.ts` (the risk package's data-record boundary,
 * duplicated for the `guards.ts` reason), `readInputAsData` in front of every
 * schema, `contained` around every public entry point, and `ownEntry`/`setOwn`
 * at every table.
 */
describe("a hostile value at the input doors — review round 5", () => {
  function throwingGetter(
    base: Record<string, unknown>,
    key: string,
    counter: { value: number },
  ): Record<string, unknown> {
    const out = { ...base };
    delete out[key];
    Object.defineProperty(out, key, {
      get() {
        counter.value += 1;
        throw new Error(`${key}-getter`);
      },
      enumerable: true,
      configurable: true,
    });
    return out;
  }

  function countingProxy<T extends object>(target: T, counter: { value: number }): T {
    const bump = <R>(compute: () => R): R => {
      counter.value += 1;
      return compute();
    };
    return new Proxy(target, {
      getPrototypeOf: (t) => bump(() => Reflect.getPrototypeOf(t)),
      ownKeys: (t) => bump(() => Reflect.ownKeys(t)),
      getOwnPropertyDescriptor: (t, k) => bump(() => Reflect.getOwnPropertyDescriptor(t, k)),
      get: (t, k, r) => bump(() => Reflect.get(t, k, r) as unknown),
      has: (t, k) => bump(() => Reflect.has(t, k)),
    });
  }

  it("REVIEWER'S PROBE: parseAllocatorCaps REFUSES an accessor-bearing caps object", () => {
    const invoked = { value: 0 };
    const hostile = throwingGetter(
      { globalAccountCap: "1000", perStrategyCap: "1000" },
      "globalAccountCap",
      invoked,
    );

    // Round 5: this call threw `Error("caps-getter")`, getter called once.
    const parsed = parseAllocatorCaps(hostile);

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.refusals.map((r) => r.code)).toContain("CAPITAL_INPUT_INVALID");
    expect(invoked.value).toBe(0);
  });

  it("every public `unknown` door refuses an accessor-bearing input without invoking it", () => {
    const invoked = { value: 0 };

    const hostileState = throwingGetter(
      {
        accountEquity: "1000",
        availableCollateral: "1000",
        positions: [],
        openOrders: [],
        liveOwners: [],
      },
      "availableCollateral",
      invoked,
    );
    expect(createAllocatorState(hostileState).ok).toBe(false);

    const hostileRequest = throwingGetter(
      request() as unknown as Record<string, unknown>,
      "shares",
      invoked,
    );
    expect(evaluateReservation(state(), caps(), hostileRequest).permitted).toBe(false);
    expect(applyReservation(state(), caps(), hostileRequest).ok).toBe(false);

    expect(invoked.value).toBe(0);
  });

  it("every public `unknown` door refuses a Proxy with ZERO trap invocations", () => {
    const traps = { value: 0 };

    expect(
      parseAllocatorCaps(countingProxy({ globalAccountCap: "1", perStrategyCap: "1" }, traps)).ok,
    ).toBe(false);
    expect(
      createAllocatorState(
        countingProxy(
          {
            accountEquity: "1000",
            availableCollateral: "1000",
            positions: [],
            openOrders: [],
            liveOwners: [],
          },
          traps,
        ),
      ).ok,
    ).toBe(false);
    expect(
      evaluateReservation(
        state(),
        caps(),
        countingProxy(request() as unknown as Record<string, unknown>, traps),
      ).permitted,
    ).toBe(false);

    expect(traps.value).toBe(0);

    // Non-vacuity: the same handler answers when someone other than a door asks.
    const witness = countingProxy({ a: 1 }, traps);
    expect(Reflect.ownKeys(witness)).toEqual(["a"]);
    expect(traps.value).toBeGreaterThan(0);
  });

  it("THE LIVE-MICRO FENCE IS UNCHANGED BY THE NEW DOOR", () => {
    // The round-1 HIGH fix, re-verified through the materializing door: only
    // the exact canonical `"0"` is permitted, and a decimally-equal spelling is
    // REFUSED rather than folded. The CODE differs by layer, and deliberately:
    // at this door the grammar runs first (`"0.0"` is not a canonical money
    // string), while the fence's own code is what a grammar-valid raise gets.
    for (const field of LIVE_MICRO_CAP_FIELDS) {
      for (const [value, code] of [
        ["0.0", "CAPITAL_INPUT_INVALID"],
        ["0.00", "CAPITAL_INPUT_INVALID"],
        ["0.01", "CAPITAL_LIVE_MICRO_CAP_NOT_PERMITTED"],
        ["1", "CAPITAL_LIVE_MICRO_CAP_NOT_PERMITTED"],
      ] as const) {
        const parsed = parseAllocatorCaps({
          globalAccountCap: "1000",
          perStrategyCap: "1000",
          [field]: value,
        });
        expect(parsed.ok, `${field}=${value}`).toBe(false);
        if (parsed.ok) continue;
        expect(parsed.refusals.map((r) => r.code), `${field}=${value}`).toContain(code);
      }
      const floor = parseAllocatorCaps({
        globalAccountCap: "1000",
        perStrategyCap: "1000",
        [field]: LIVE_MICRO_CAP_FLOOR,
      });
      expect(floor.ok, `${field}=floor`).toBe(true);
    }

    // Layer 3 — the enforcement site, where a hand-built caps object that never
    // went through the door is re-fenced. `"0.0"` refuses HERE with the fence's
    // own code, and the new containment guard does not swallow it.
    for (const bogus of ["0.0", "0.00"]) {
      const verdict = evaluateReservation(
        state(),
        { ...caps(), liveMicroMaxOrderNotional: bogus } as unknown as AllocatorCaps,
        request(),
      );
      expect(verdict.permitted, bogus).toBe(false);
      expect(refusalCodes(verdict), bogus).toContain("CAPITAL_LIVE_MICRO_CAP_NOT_PERMITTED");
    }
  });

  it("an INHERITED member is never an exposure entry, and never a write target", () => {
    // `seriesKey` is a `CodeString`, so `"constructor"` is admissible. With
    // `table[key] ??= …` the accumulator read the `Object` constructor as an
    // existing entry and then wrote this package's commitment components onto
    // the intrinsic itself.
    //
    // THE VECTOR MOVED FROM `strategyInstanceId` TO `seriesKey` in `ALLOC-1`,
    // and the probe moved with it rather than being deleted. ADR-021 re-typed
    // the instance id to `Uuidv7Schema`, whose grammar admits no
    // `Object.prototype` member name, so that field can no longer carry this
    // input at all. The three SCOPE keys (`state.ts:58-60`) stay
    // `CodeStringSchema` — vocabulary, not identity — so a caller-derived
    // inherited NAME still reaches the same `bump`/`ownEntry`/`setOwn` path in
    // `exposure.ts`, on the same tables, through a live door. The defect class
    // this test was written for is therefore still measured, not merely
    // asserted to be unreachable.
    const built = createAllocatorState({
      accountEquity: "1000",
      availableCollateral: "1000",
      positions: [
        {
          positionId: "pos-1",
          strategyInstanceId: INSTANCE,
          marketId: MARKET_A,
          side: "YES",
          shares: "100",
          costBasis: "40",
          scope: { seriesKey: "constructor" },
        },
      ],
      openOrders: [],
      liveOwners: [],
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const snapshot = exposureSnapshot(built.value);
    expect(Object.hasOwn(snapshot.bySeries, "constructor")).toBe(true);
    expect(snapshot.bySeries["constructor"]?.combined).toBe("40");
    // The intrinsic is clean: no commitment component was written to it.
    expect(Object.hasOwn(Object.prototype, "openOrderCommitted")).toBe(false);
    expect(Object.hasOwn(Object.prototype, "positionCommitted")).toBe(false);
  });

  it("exposureSnapshotCovering writes an EXPLICIT ZERO for an inherited-name scope key", () => {
    // The zero this function exists to guarantee. `out[key] ??= ZERO_ENTRY`
    // found `Object` under `"constructor"` and skipped the write, so the risk
    // side's `RISK_EXPOSURE_ENTRY_MISSING` (round 1, BLOCKER 2) would have read
    // an intrinsic as a measurement instead.
    const covering = exposureSnapshotCovering(state(), {
      strategyInstanceIds: ["constructor", "toString", INSTANCE],
      marketIds: [MARKET_A],
    });
    for (const key of ["constructor", "toString", INSTANCE]) {
      expect(Object.hasOwn(covering.byStrategyInstance, key), key).toBe(true);
      expect(covering.byStrategyInstance[key], key).toEqual(EXPOSURE_ZERO);
    }
  });

  it("withLiveOwner does not read an inherited member as a live owner", () => {
    // `marketId` is an ordinary string PARAMETER here — nothing parses it — so
    // `state.liveOwners["constructor"]` used to answer the `Object` constructor
    // and refuse with a `CAPITAL_LIVE_OWNERSHIP_CONFLICT` naming an intrinsic.
    const owned = withLiveOwner(state({ liveOwners: [] }), "constructor", INSTANCE);
    expect(owned.ok).toBe(true);
    if (!owned.ok) return;
    expect(Object.hasOwn(owned.value.liveOwners, "constructor")).toBe(true);
    expect(owned.value.liveOwners["constructor"]).toBe(INSTANCE);
  });

  it("a `__proto__` field is refused rather than dropped, at every door", () => {
    // Measured, not assumed: `zod`'s `strictObject` is blind to exactly this
    // one key — it reports every other unrecognized name and silently drops
    // this one. `plain-data.ts` refuses it so the "an unexpected field is
    // refused, never dropped" contract has no hole.
    const withProto: Record<string, unknown> = { globalAccountCap: "1000", perStrategyCap: "1000" };
    Object.defineProperty(withProto, "__proto__", {
      value: { globalAccountCap: "999999999" },
      enumerable: true,
      writable: true,
      configurable: true,
    });
    const parsed = parseAllocatorCaps(withProto);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(JSON.stringify(parsed.refusals)).toContain("__proto__");
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });
});
