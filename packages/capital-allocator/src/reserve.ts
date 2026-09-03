/**
 * Reservation lifecycle — handoff §9.7, §9.10 ("Reserve collateral/inventory
 * before submission"), §9.14 ("Prevent double reservation").
 *
 * `evaluateReservation` answers "may this commitment be made" without changing
 * anything; `applyReservation` re-evaluates and returns a NEW frozen state;
 * `releaseReservation` returns the capacity. Every negative answer is a typed
 * refusal carrying evidence.
 *
 * V1 policy (§9.7): opposing strategy intents are NOT netted. A LIVE
 * commitment requires this instance to be the recorded live owner of the
 * market (ADR-011); a conflicting owner — or no owner at all — is a refusal,
 * never a silent claim. SHADOW commitments are accounted in the instance's own
 * independent shadow book and never touch live collateral or inventory.
 *
 * Real-order run modes (handoff §11: `EXECUTION_PROBE`, `LIVE_MICRO`, `LIVE`)
 * are additionally checked against the live-micro caps, which are FENCED at
 * exactly `"0"` (`AGENTS.md` non-weakenable safety defaults). A
 * real-order-mode commitment with any positive notional is therefore refused,
 * and this package grants no real-order capacity at all.
 *
 * Corrected 2026-09-02 (remediation round 1): this header previously said the
 * caps merely "default to" `"0"` and could be raised by "a later, gated phase"
 * configuring them. Adversarial review round 1 (HIGH) ruled that a weakening
 * vector — a caller argument cannot raise a floor this package has no
 * authority over. `caps.ts` now REFUSES any live-micro value other than the
 * exact floor, and {@link evaluateReservation} re-applies that fence at the
 * enforcement site for every run mode, so a hand-built caps object is unusable.
 * Enabling live-micro capacity is a separate authorized work package.
 */

import { addDecimal, compareDecimal, mulDecimal, subDecimal } from "@polymarket-bot/decimal";
import {
  CodeStringSchema,
  InternalMarketIdSchema,
  NonEmptyStringSchema,
  OutcomeSideSchema,
  PositiveDecimalStringSchema,
  PriceStringSchema,
  RUN_MODE_PLACES_REAL_ORDERS,
  RunModeSchema,
} from "@polymarket-bot/domain";
import { z } from "zod";

import { liveMicroCapRefusals, type AllocatorCaps } from "./caps.js";
import { exposureSnapshot, shadowExposureSnapshot, type ExposureSnapshot } from "./exposure.js";
import { deepFreeze, ownEntry, ownFlag, uuidShapedNotCanonical } from "./guards.js";
import { hardenParsed } from "./plain-data.js";
import {
  capitalFailure,
  capitalOk,
  capitalRefusal,
  contained,
  readInputAsData,
  type CapitalRefusal,
  type CapitalResult,
} from "./refusals.js";
import {
  heldSharesByKey,
  inventoryKey,
  reservedSharesByKey,
  ScopeAttributionSchema,
  type AllocatorState,
  type AppliedReservation,
} from "./state.js";

export const ReservationRequestSchema = z.strictObject({
  reservationId: NonEmptyStringSchema,
  strategyInstanceId: CodeStringSchema,
  runMode: RunModeSchema,
  accountingMode: z.enum(["LIVE", "SHADOW"]),
  marketId: InternalMarketIdSchema,
  side: OutcomeSideSchema,
  action: z.enum(["BUY", "SELL"]),
  price: PriceStringSchema,
  shares: PositiveDecimalStringSchema,
  scope: ScopeAttributionSchema.optional(),
});
export type ReservationRequest = z.infer<typeof ReservationRequestSchema>;

/**
 * The verdict, shaped for structural consumption by the risk engine (which
 * has no package edge here). The permitted arm's `refusals` is the empty
 * tuple at the TYPE level (WP-110 round-2 L1 precedent) so a "permitted with
 * refusals" value is unrepresentable.
 */
export type ReservationVerdict =
  | {
      readonly permitted: true;
      readonly reservation: AppliedReservation;
      readonly refusals: readonly [];
    }
  | { readonly permitted: false; readonly refusals: readonly CapitalRefusal[] };

function refuseVerdict(refusals: readonly CapitalRefusal[]): ReservationVerdict {
  return deepFreeze({ permitted: false, refusals: [...refusals] });
}

interface CapProbe {
  readonly cap: string | undefined;
  readonly current: string;
  readonly code:
    | "CAPITAL_GLOBAL_CAP_EXCEEDED"
    | "CAPITAL_STRATEGY_CAP_EXCEEDED"
    | "CAPITAL_MARKET_CAP_EXCEEDED"
    | "CAPITAL_SERIES_CAP_EXCEEDED"
    | "CAPITAL_UNDERLYING_CAP_EXCEEDED"
    | "CAPITAL_RESOLUTION_WINDOW_CAP_EXCEEDED";
  readonly dimension: string;
  readonly key: string | undefined;
  /** True when the cap is configured but the request has no key for it. */
  readonly keyMissing: boolean;
}

function capRefusals(probes: readonly CapProbe[], contribution: string): CapitalRefusal[] {
  const refusals: CapitalRefusal[] = [];
  for (const probe of probes) {
    if (probe.cap === undefined) continue;
    if (probe.keyMissing) {
      refusals.push(
        capitalRefusal(
          "CAPITAL_SCOPE_KEY_MISSING",
          `a ${probe.dimension} cap is configured but the request carries no ${probe.dimension} attribution (fail closed)`,
          { dimension: probe.dimension, cap: probe.cap },
        ),
      );
      continue;
    }
    const projected = addDecimal(probe.current, contribution);
    if (compareDecimal(projected, probe.cap) > 0) {
      refusals.push(
        capitalRefusal(
          probe.code,
          `projected committed exposure exceeds the ${probe.dimension} cap (open orders and positions both consume the limit)`,
          {
            dimension: probe.dimension,
            key: probe.key,
            current: probe.current,
            contribution,
            projected,
            cap: probe.cap,
          },
        ),
      );
    }
  }
  return refusals;
}

function entryOf(snapshot: ExposureSnapshot, dimension: keyof ExposureSnapshot, key?: string): string {
  if (dimension === "global") return snapshot.global.combined;
  // OWN lookup TWICE (review rounds 5 and 6): once for the DIMENSION — the
  // snapshot is a value a caller can hand us, so a dimension the snapshot does
  // not own must not be answered by its prototype — and once for the KEY, which
  // is a bounded scope string, where `table["__proto__"]` would answer
  // `Object.prototype` and compare a cap against nothing.
  const table = ownEntry(
    snapshot as unknown as Readonly<Record<string, Readonly<Record<string, { readonly combined: string }>>>>,
    dimension,
  );
  return key === undefined ? "0" : (ownEntry(table, key)?.combined ?? "0");
}

/**
 * Evaluates a reservation without changing anything.
 *
 * READ AS DATA BEFORE IT IS PARSED, and CONTAINED (review round 5, BLOCKER 3 —
 * the class reported against `parseAllocatorCaps`, swept across this package's
 * public `unknown` surfaces). A contained failure is a REFUSED verdict, never a
 * permitted one, and the live-micro fence below is unaffected: it runs on
 * `caps`, after the request is known to be data.
 */
export function evaluateReservation(
  state: AllocatorState,
  caps: AllocatorCaps,
  request: unknown,
): ReservationVerdict {
  return contained(
    () => evaluateReservationInner(state, caps, request),
    (thrown) =>
      refuseVerdict([
        capitalRefusal(
          "CAPITAL_INPUT_INVALID",
          "evaluating the reservation failed unexpectedly; a reservation that cannot be evaluated is not permitted (fail closed)",
          { thrown },
        ),
      ]),
  );
}

function evaluateReservationInner(
  state: AllocatorState,
  caps: AllocatorCaps,
  request: unknown,
): ReservationVerdict {
  const read = readInputAsData(request, "request", "reservation request");
  if (!read.ok) return refuseVerdict([read.refusal]);
  const parsed = ReservationRequestSchema.safeParse(read.value);
  if (!parsed.success) {
    return refuseVerdict([
      capitalRefusal("CAPITAL_INPUT_INVALID", "reservation request failed validation", {
        issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
      }),
    ]);
  }
  // THE PARSE OUTPUT IS RE-HARDENED (review round 6). `zod` builds its result
  // with `{}`, so an ABSENT OPTIONAL FIELD of the parsed request —
  // `req.scope`, `req.scope?.seriesKey` — would have been answered by
  // `Object.prototype`, attributing a commitment to a scope nobody supplied.
  // The same call refuses an output SMALLER than what was read: a request whose
  // `scope` vanished would skip `CAPITAL_SCOPE_KEY_MISSING` on a configured
  // scope cap.
  const hardened = hardenParsed(read.value, parsed.data, "request");
  if (!hardened.ok) {
    return refuseVerdict([
      capitalRefusal(
        "CAPITAL_INPUT_INVALID",
        "the validated reservation request lost fields between validation and use, so what would be committed is not what was requested (fail closed)",
        { lost: [...hardened.lost] },
      ),
    ]);
  }
  const req = hardened.value as ReservationRequest;

  const refusals: CapitalRefusal[] = [];

  // --- the live-micro fence, second layer (review round 1, HIGH) -----------
  // `parseAllocatorCaps` refuses a raised live-micro floor, but `caps` is a
  // plain value and a caller can hand-build one. Re-checked HERE, at the
  // enforcement site, for EVERY run mode and accounting mode: a caps object
  // that weakens an `AGENTS.md` safety default is not usable at all, so no
  // reservation is evaluated against it.
  refusals.push(...liveMicroCapRefusals(caps));

  if (uuidShapedNotCanonical(req.reservationId)) {
    refusals.push(
      capitalRefusal(
        "CAPITAL_UUID_NOT_CANONICAL",
        "reservationId is UUID-shaped but not canonical lowercase (ADR-016 §2: refuse, never case-fold)",
        { reservationId: req.reservationId },
      ),
    );
  }

  const duplicate =
    state.reservations.some((r) => r.reservationId === req.reservationId) ||
    state.shadowReservations.some((r) => r.reservationId === req.reservationId);
  if (duplicate) {
    refusals.push(
      capitalRefusal("CAPITAL_DUPLICATE_IDENTIFIER", "reservationId already applied", {
        reservationId: req.reservationId,
      }),
    );
  }

  const cost = req.action === "BUY" ? mulDecimal(req.price, req.shares) : "0";

  if (req.accountingMode === "LIVE") {
    // --- one live owner per market (ADR-011; §9.7 v1) ----------------------
    // OWN lookup (review round 6, BLOCKER 1 — THE MOST SERIOUS DEFECT IN THIS
    // PACKAGE'S HISTORY: a FAIL-OPEN on the live-ownership gate). `state
    // .liveOwners[req.marketId]` is `Get`, which walks the prototype chain, so
    // an INHERITED owner authorized a LIVE commitment where
    // `CAPITAL_LIVE_OWNERSHIP_MISSING` was owed — reproduced twice, once with a
    // caller-built `liveOwners` and once, more seriously, with a state THIS
    // LIBRARY built and a single non-enumerable `Object.prototype` property
    // spelled as the market's UUID. Ownership is a fact the state OWNS or does
    // not have.
    const owner = ownEntry(state.liveOwners, req.marketId);
    if (owner === undefined) {
      refusals.push(
        capitalRefusal(
          "CAPITAL_LIVE_OWNERSHIP_MISSING",
          "no live owner is recorded for this market; a live commitment requires explicit ownership (ADR-011)",
          { marketId: req.marketId, strategyInstanceId: req.strategyInstanceId },
        ),
      );
    } else if (owner !== req.strategyInstanceId) {
      refusals.push(
        capitalRefusal(
          "CAPITAL_LIVE_OWNERSHIP_CONFLICT",
          "another strategy instance is the live owner of this market; v1 does not net opposing strategy intents (§9.7)",
          { marketId: req.marketId, owner, requestedBy: req.strategyInstanceId },
        ),
      );
    }

    // --- real-order modes: live-micro caps (defaults "0") ------------------
    // OWN read of the frozen domain table (review round 6): a run mode the
    // table does not own is not a real-order mode because something on
    // `Object.prototype` says so.
    if (ownFlag(RUN_MODE_PLACES_REAL_ORDERS, req.runMode)) {
      if (compareDecimal(cost, caps.liveMicroMaxOrderNotional) > 0) {
        refusals.push(
          capitalRefusal(
            "CAPITAL_LIVE_MICRO_ORDER_NOTIONAL_EXCEEDED",
            "real-order-mode commitment exceeds the live-micro per-order notional cap",
            { runMode: req.runMode, cost, cap: caps.liveMicroMaxOrderNotional },
          ),
        );
      }
      const projectedExposure = addDecimal(exposureSnapshot(state).global.combined, cost);
      if (compareDecimal(projectedExposure, caps.liveMicroMaxAccountExposure) > 0) {
        refusals.push(
          capitalRefusal(
            "CAPITAL_LIVE_MICRO_EXPOSURE_EXCEEDED",
            "real-order-mode commitment exceeds the live-micro account exposure cap",
            { runMode: req.runMode, projectedExposure, cap: caps.liveMicroMaxAccountExposure },
          ),
        );
      }
    }

    // --- collateral / inventory sufficiency --------------------------------
    if (req.action === "BUY" && compareDecimal(cost, state.availableCollateral) > 0) {
      refusals.push(
        capitalRefusal(
          "CAPITAL_COLLATERAL_INSUFFICIENT",
          "buy commitment exceeds available (unreserved) pUSD",
          { cost, availableCollateral: state.availableCollateral },
        ),
      );
    }
    if (req.action === "SELL") {
      const key = inventoryKey(req.strategyInstanceId, req.marketId, req.side);
      // OWN lookups (review round 6, BLOCKER 1). These two tables are built
      // fresh by this package, and that did NOT make them safe: they are
      // ordinary objects, so `table[key]` for a key the table does not own was
      // answered by `Object.prototype`. The reviewer's probe put a TWO-ANSWER
      // GETTER on the composite inventory key and a SELL with ZERO holdings saw
      // `held=1000, reserved=0` and was permitted. Inventory is what the state
      // OWNS.
      const held = ownEntry(heldSharesByKey(state), key) ?? "0";
      const reserved = ownEntry(reservedSharesByKey(state), key) ?? "0";
      const free = subDecimal(held, reserved);
      if (compareDecimal(req.shares, free) > 0) {
        refusals.push(
          capitalRefusal(
            "CAPITAL_INVENTORY_INSUFFICIENT",
            "sell reservation exceeds the instance's unreserved holdings (§6 invariant 10: exits are based on confirmed actual allocation)",
            { inventoryKey: key, requestedShares: req.shares, heldShares: held, reservedShares: reserved },
          ),
        );
      }
    }
  }

  // --- caps ----------------------------------------------------------------
  // LIVE requests are checked against the live snapshot; SHADOW requests
  // against the instance's own shadow book (independent shadow accounting).
  const snapshot =
    req.accountingMode === "LIVE"
      ? exposureSnapshot(state)
      : shadowExposureSnapshot(state, req.strategyInstanceId);
  const probes: CapProbe[] = [
    {
      cap: caps.globalAccountCap,
      current: entryOf(snapshot, "global"),
      code: "CAPITAL_GLOBAL_CAP_EXCEEDED",
      dimension: "global",
      key: undefined,
      keyMissing: false,
    },
    {
      cap: caps.perStrategyCap,
      current: entryOf(snapshot, "byStrategyInstance", req.strategyInstanceId),
      code: "CAPITAL_STRATEGY_CAP_EXCEEDED",
      dimension: "strategy",
      key: req.strategyInstanceId,
      keyMissing: false,
    },
    {
      cap: caps.perMarketCap,
      current: entryOf(snapshot, "byMarket", req.marketId),
      code: "CAPITAL_MARKET_CAP_EXCEEDED",
      dimension: "market",
      key: req.marketId,
      keyMissing: false,
    },
    {
      cap: caps.perSeriesCap,
      current: entryOf(snapshot, "bySeries", req.scope?.seriesKey),
      code: "CAPITAL_SERIES_CAP_EXCEEDED",
      dimension: "series",
      key: req.scope?.seriesKey,
      keyMissing: req.scope?.seriesKey === undefined,
    },
    {
      cap: caps.perUnderlyingCap,
      current: entryOf(snapshot, "byUnderlying", req.scope?.underlyingKey),
      code: "CAPITAL_UNDERLYING_CAP_EXCEEDED",
      dimension: "underlying",
      key: req.scope?.underlyingKey,
      keyMissing: req.scope?.underlyingKey === undefined,
    },
    {
      cap: caps.perResolutionWindowCap,
      current: entryOf(snapshot, "byResolutionWindow", req.scope?.resolutionWindowKey),
      code: "CAPITAL_RESOLUTION_WINDOW_CAP_EXCEEDED",
      dimension: "resolution-window",
      key: req.scope?.resolutionWindowKey,
      keyMissing: req.scope?.resolutionWindowKey === undefined,
    },
  ];
  refusals.push(...capRefusals(probes, cost));

  if (refusals.length > 0) {
    return refuseVerdict(refusals);
  }

  const reservation: AppliedReservation = {
    reservationId: req.reservationId,
    strategyInstanceId: req.strategyInstanceId,
    runMode: req.runMode,
    accountingMode: req.accountingMode,
    marketId: req.marketId,
    side: req.side,
    action: req.action,
    price: req.price,
    shares: req.shares,
    cost,
    reservedShares: req.action === "SELL" ? req.shares : "0",
    ...(req.scope === undefined ? {} : { scope: req.scope }),
  };
  return deepFreeze({ permitted: true, reservation, refusals: [] as const });
}

/**
 * Re-evaluates and applies a reservation, returning a NEW frozen state.
 * Re-evaluation makes a stale verdict harmless: capacity is checked against
 * THIS state, not the one the verdict was computed on.
 */
export function applyReservation(
  state: AllocatorState,
  caps: AllocatorCaps,
  request: unknown,
): CapitalResult<{ readonly state: AllocatorState; readonly reservation: AppliedReservation }> {
  return contained(
    () => applyReservationInner(state, caps, request),
    (thrown) =>
      capitalFailure(
        capitalRefusal(
          "CAPITAL_INPUT_INVALID",
          "applying the reservation failed unexpectedly; no reservation is applied and the state is unchanged (fail closed)",
          { thrown },
        ),
      ),
  );
}

function applyReservationInner(
  state: AllocatorState,
  caps: AllocatorCaps,
  request: unknown,
): CapitalResult<{ readonly state: AllocatorState; readonly reservation: AppliedReservation }> {
  const verdict = evaluateReservation(state, caps, request);
  if (!verdict.permitted) {
    return capitalFailure(...verdict.refusals);
  }
  const reservation = verdict.reservation;
  if (reservation.accountingMode === "SHADOW") {
    const next = deepFreeze({
      ...state,
      shadowReservations: [...state.shadowReservations, reservation],
    });
    return capitalOk({ state: next, reservation });
  }
  const next = deepFreeze({
    ...state,
    availableCollateral: subDecimal(state.availableCollateral, reservation.cost),
    reservedCollateral: addDecimal(state.reservedCollateral, reservation.cost),
    reservations: [...state.reservations, reservation],
  });
  return capitalOk({ state: next, reservation });
}

/** Releases an applied reservation, returning its capacity. */
export function releaseReservation(
  state: AllocatorState,
  reservationId: string,
): CapitalResult<AllocatorState> {
  return contained(
    () => releaseReservationInner(state, reservationId),
    (thrown) =>
      capitalFailure(
        capitalRefusal(
          "CAPITAL_INPUT_INVALID",
          "releasing the reservation failed unexpectedly; no capacity is returned and the state is unchanged (fail closed)",
          { thrown },
        ),
      ),
  );
}

function releaseReservationInner(
  state: AllocatorState,
  reservationId: string,
): CapitalResult<AllocatorState> {
  const live = state.reservations.find((r) => r.reservationId === reservationId);
  if (live !== undefined) {
    return capitalOk(
      deepFreeze({
        ...state,
        availableCollateral: addDecimal(state.availableCollateral, live.cost),
        reservedCollateral: subDecimal(state.reservedCollateral, live.cost),
        reservations: state.reservations.filter((r) => r.reservationId !== reservationId),
      }),
    );
  }
  const shadow = state.shadowReservations.find((r) => r.reservationId === reservationId);
  if (shadow !== undefined) {
    return capitalOk(
      deepFreeze({
        ...state,
        shadowReservations: state.shadowReservations.filter(
          (r) => r.reservationId !== reservationId,
        ),
      }),
    );
  }
  return capitalFailure(
    capitalRefusal("CAPITAL_UNKNOWN_RESERVATION", "no applied reservation has this id", {
      reservationId,
    }),
  );
}
