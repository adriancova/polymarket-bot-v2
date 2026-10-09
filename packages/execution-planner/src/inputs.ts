/**
 * Planning inputs — everything the planner is TOLD, never something it looks
 * up. No I/O, no clock: the book, the versioned trading parameters (§6
 * invariant 9), the ACTUAL confirmed inventory (§6 invariant 10), the
 * available collateral, and the planning policy all arrive as caller data and
 * are validated behind the same materialize-first boundary as every other
 * input.
 *
 * INVENTORY IS "ACTUAL": `held` is confirmed allocation and `reserved` is
 * what open commitments already claim (the allocator's accounting, §9.7);
 * the planner sizes sell legs against `held − reserved` and NOTHING else —
 * workplan acceptance 1. An input where `reserved > held` describes an
 * account that oversold, which is not a state to plan in (fail closed).
 *
 * FEES ARE SUPPLIED, NEVER GUESSED (WP-190 binding constraint 7): the fee
 * rates come from the caller's versioned trading parameters. This package
 * invents no venue fact.
 *
 * The CANCEL door ({@link readCancelPlanningInputs}) plucks only
 * `executionPlanId`, `plannedAt` and `policy.cancelDeadlineMs` — a cancel
 * needs no book, no inventory, no collateral, no fees, and §6 invariant 13
 * forbids letting a hostile value in any of those trap it.
 */

import { compareDecimal } from "@polymarket-bot/decimal";

import { InternalMarketIdDoor, IsoTimestampDoor } from "./doors.js";
import { TIME_IN_FORCE_VALUES, type TimeInForce } from "./plan.js";
import { isOnTick } from "./tick.js";
import { pluck } from "./pluck.js";
import {
  plannerFailure,
  plannerRefusal,
  readInputAsData,
  type PlannerResult,
} from "./refusals.js";
import {
  asArray,
  asDecimal,
  asIdentifier,
  asMember,
  asNonNegativeInteger,
  asOpenUnitPrice,
  asPositiveInteger,
  asRecord,
  problem,
  requireKnownKeys,
  type Problem,
} from "./validate.js";

export interface SideInventory {
  /** Confirmed actual holdings of this outcome token (§6 invariant 10). */
  readonly held: string;
  /** Shares already claimed by open commitments (allocator accounting, §9.7). */
  readonly reserved: string;
}

export interface MarketBookInputs {
  readonly yesBestBid?: string;
  readonly yesBestAsk?: string;
  readonly noBestBid?: string;
  readonly noBestAsk?: string;
}

export interface MarketPlanningInput {
  readonly marketId: string;
  /** Versioned venue trading parameters (§6 invariant 9), caller-supplied. */
  readonly tickSize: string;
  readonly minimumOrderSize: string;
  readonly makerFeeRate: string;
  readonly takerFeeRate: string;
  /** Best levels when known; an absent side limits what can be planned. */
  readonly book?: MarketBookInputs;
  readonly inventory: { readonly yes: SideInventory; readonly no: SideInventory };
}

export interface PlanningPolicy {
  readonly maxSliceShares: string;
  readonly marketableSlippageTicks: number;
  readonly replaceThresholdTicks: number;
  readonly minimumReplaceIntervalMs: number;
  readonly cancelDeadlineMs: number;
  readonly maxPlanLifetimeMs: number;
}

export interface ScopeAttribution {
  readonly seriesKey?: string;
  readonly underlyingKey?: string;
  readonly resolutionWindowKey?: string;
}

export interface PlanningInputs {
  readonly executionPlanId: string;
  readonly plannedAt: string;
  readonly accountingMode: "LIVE" | "SHADOW";
  /** Unreserved pUSD (the allocator's `availableCollateral`). */
  readonly availableCollateral: string;
  readonly markets: readonly MarketPlanningInput[];
  readonly policy: PlanningPolicy;
  /**
   * ADR-034 D3.1: the time-in-force every order of this plan carries. The
   * caller resolves it (the intent's tag, else the instance's configuration);
   * the planner never defaults it, so a placement input without one is
   * refused. A cancel plan does not read it.
   */
  readonly timeInForce: TimeInForce;
  readonly scope?: ScopeAttribution;
}

/** What a CANCEL plan needs — nothing else is read (§6 invariant 13). */
export interface CancelPlanningInputs {
  readonly executionPlanId: string;
  readonly plannedAt: string;
  readonly cancelDeadlineMs: number;
}

const INPUT_KEYS: ReadonlySet<string> = new Set([
  "executionPlanId",
  "plannedAt",
  "accountingMode",
  "availableCollateral",
  "markets",
  "policy",
  "timeInForce",
  "scope",
]);
const MARKET_KEYS: ReadonlySet<string> = new Set([
  "marketId",
  "tickSize",
  "minimumOrderSize",
  "makerFeeRate",
  "takerFeeRate",
  "book",
  "inventory",
]);
const BOOK_KEYS: ReadonlySet<string> = new Set([
  "yesBestBid",
  "yesBestAsk",
  "noBestBid",
  "noBestAsk",
]);
const POLICY_KEYS: ReadonlySet<string> = new Set([
  "maxSliceShares",
  "marketableSlippageTicks",
  "replaceThresholdTicks",
  "minimumReplaceIntervalMs",
  "cancelDeadlineMs",
  "maxPlanLifetimeMs",
]);
const SCOPE_KEYS: ReadonlySet<string> = new Set([
  "seriesKey",
  "underlyingKey",
  "resolutionWindowKey",
]);
const SIDE_KEYS: ReadonlySet<string> = new Set(["held", "reserved"]);

/**
 * The executionPlanId length bound is TIGHTER than the repository's 200-char
 * identifier bound: derived ids (`<planId>:g0:o0`, `<planId>:r12`) must
 * themselves stay within 200 characters, so the base id leaves room.
 */
export const MAX_EXECUTION_PLAN_ID_LENGTH = 180;

function refuseProblems(problems: readonly Problem[]): PlannerResult<never> {
  return plannerFailure(
    plannerRefusal("PLAN_INPUT_INVALID", "the planning inputs failed validation (fail closed)", {
      issues: problems.map((entry) => `${entry.path}: ${entry.problem}`),
    }),
  );
}

function sideInventory(
  value: unknown,
  path: string,
  problems: Problem[],
): SideInventory | undefined {
  const data = asRecord(value, path, problems);
  if (data === undefined) return undefined;
  requireKnownKeys(data, path, SIDE_KEYS, problems);
  const held = asDecimal(data["held"], `${path}.held`, problems, "NON_NEGATIVE");
  const reserved = asDecimal(data["reserved"], `${path}.reserved`, problems, "NON_NEGATIVE");
  if (held === undefined || reserved === undefined) return undefined;
  if (compareDecimal(reserved, held) > 0) {
    return problem(
      problems,
      path,
      `reserved shares ("${reserved}") exceed held shares ("${held}"); an oversold account state is not a state to plan in (§9.14, fail closed)`,
    );
  }
  return { held, reserved };
}

function bookPrice(
  value: unknown,
  path: string,
  tickSize: string | undefined,
  problems: Problem[],
): string | undefined {
  if (value === undefined) return undefined;
  const price = asOpenUnitPrice(value, path, problems);
  if (price === undefined) return undefined;
  if (tickSize !== undefined && !isOnTick(price, tickSize)) {
    return problem(
      problems,
      path,
      `a book price must lie on the market's tick grid ("${tickSize}"); received "${price}" (PLAN_BOOK_INVALID)`,
    );
  }
  return price;
}

function marketInput(
  value: unknown,
  path: string,
  problems: Problem[],
): MarketPlanningInput | undefined {
  const data = asRecord(value, path, problems);
  if (data === undefined) return undefined;
  requireKnownKeys(data, path, MARKET_KEYS, problems);

  const marketIdValue = data["marketId"];
  let marketId: string | undefined;
  if (typeof marketIdValue !== "string" || !InternalMarketIdDoor.safeParse(marketIdValue).success) {
    problem(problems, `${path}.marketId`, "expected a canonical lowercase UUIDv7 (§7.2)");
  } else {
    marketId = marketIdValue;
  }

  const tickSize = asDecimal(data["tickSize"], `${path}.tickSize`, problems, "POSITIVE");
  if (tickSize !== undefined && compareDecimal(tickSize, "1") >= 0) {
    problem(problems, `${path}.tickSize`, `a price tick must be smaller than 1; received "${tickSize}"`);
  }
  const minimumOrderSize = asDecimal(
    data["minimumOrderSize"],
    `${path}.minimumOrderSize`,
    problems,
    "POSITIVE",
  );
  const makerFeeRate = asDecimal(data["makerFeeRate"], `${path}.makerFeeRate`, problems, "NON_NEGATIVE");
  const takerFeeRate = asDecimal(data["takerFeeRate"], `${path}.takerFeeRate`, problems, "NON_NEGATIVE");
  for (const [name, rate] of [
    ["makerFeeRate", makerFeeRate],
    ["takerFeeRate", takerFeeRate],
  ] as const) {
    if (rate !== undefined && compareDecimal(rate, "1") >= 0) {
      problem(problems, `${path}.${name}`, `a fee rate is a fraction of notional and must be below 1; received "${rate}"`);
    }
  }

  let book: MarketBookInputs | undefined;
  if (data["book"] !== undefined) {
    const bookData = asRecord(data["book"], `${path}.book`, problems);
    if (bookData !== undefined) {
      requireKnownKeys(bookData, `${path}.book`, BOOK_KEYS, problems);
      const yesBestBid = bookPrice(bookData["yesBestBid"], `${path}.book.yesBestBid`, tickSize, problems);
      const yesBestAsk = bookPrice(bookData["yesBestAsk"], `${path}.book.yesBestAsk`, tickSize, problems);
      const noBestBid = bookPrice(bookData["noBestBid"], `${path}.book.noBestBid`, tickSize, problems);
      const noBestAsk = bookPrice(bookData["noBestAsk"], `${path}.book.noBestAsk`, tickSize, problems);
      for (const [bidName, bid, ask] of [
        ["yes", yesBestBid, yesBestAsk],
        ["no", noBestBid, noBestAsk],
      ] as const) {
        if (bid !== undefined && ask !== undefined && compareDecimal(bid, ask) >= 0) {
          problem(
            problems,
            `${path}.book`,
            `the ${bidName} book is crossed (bid "${bid}" ≥ ask "${ask}"); a crossed snapshot is a data-quality incident, not a planning input (PLAN_BOOK_INVALID)`,
          );
        }
      }
      book = {
        ...(yesBestBid === undefined ? {} : { yesBestBid }),
        ...(yesBestAsk === undefined ? {} : { yesBestAsk }),
        ...(noBestBid === undefined ? {} : { noBestBid }),
        ...(noBestAsk === undefined ? {} : { noBestAsk }),
      };
    }
  }

  const inventoryData = asRecord(data["inventory"], `${path}.inventory`, problems);
  let inventory: MarketPlanningInput["inventory"] | undefined;
  if (inventoryData !== undefined) {
    requireKnownKeys(inventoryData, `${path}.inventory`, new Set(["yes", "no"]), problems);
    const yes = sideInventory(inventoryData["yes"], `${path}.inventory.yes`, problems);
    const no = sideInventory(inventoryData["no"], `${path}.inventory.no`, problems);
    if (yes !== undefined && no !== undefined) inventory = { yes, no };
  }

  if (
    marketId === undefined ||
    tickSize === undefined ||
    minimumOrderSize === undefined ||
    makerFeeRate === undefined ||
    takerFeeRate === undefined ||
    inventory === undefined ||
    problems.length > 0
  ) {
    return undefined;
  }
  return {
    marketId,
    tickSize,
    minimumOrderSize,
    makerFeeRate,
    takerFeeRate,
    ...(book === undefined ? {} : { book }),
    inventory,
  };
}

function scopeAttribution(
  value: unknown,
  path: string,
  problems: Problem[],
): ScopeAttribution | undefined {
  const data = asRecord(value, path, problems);
  if (data === undefined) return undefined;
  requireKnownKeys(data, path, SCOPE_KEYS, problems);
  const out: Record<string, string> = {};
  for (const key of ["seriesKey", "underlyingKey", "resolutionWindowKey"] as const) {
    if (data[key] === undefined) continue;
    const entry = asIdentifier(data[key], `${path}.${key}`, problems);
    if (entry !== undefined) out[key] = entry;
  }
  return out as ScopeAttribution;
}

function planningPolicy(value: unknown, path: string, problems: Problem[]): PlanningPolicy | undefined {
  const data = asRecord(value, path, problems);
  if (data === undefined) return undefined;
  requireKnownKeys(data, path, POLICY_KEYS, problems);
  const maxSliceShares = asDecimal(data["maxSliceShares"], `${path}.maxSliceShares`, problems, "POSITIVE");
  const marketableSlippageTicks = asNonNegativeInteger(
    data["marketableSlippageTicks"],
    `${path}.marketableSlippageTicks`,
    problems,
  );
  const replaceThresholdTicks = asNonNegativeInteger(
    data["replaceThresholdTicks"],
    `${path}.replaceThresholdTicks`,
    problems,
  );
  const minimumReplaceIntervalMs = asPositiveInteger(
    data["minimumReplaceIntervalMs"],
    `${path}.minimumReplaceIntervalMs`,
    problems,
  );
  const cancelDeadlineMs = asPositiveInteger(data["cancelDeadlineMs"], `${path}.cancelDeadlineMs`, problems);
  const maxPlanLifetimeMs = asPositiveInteger(data["maxPlanLifetimeMs"], `${path}.maxPlanLifetimeMs`, problems);
  if (
    maxSliceShares === undefined ||
    marketableSlippageTicks === undefined ||
    replaceThresholdTicks === undefined ||
    minimumReplaceIntervalMs === undefined ||
    cancelDeadlineMs === undefined ||
    maxPlanLifetimeMs === undefined
  ) {
    return undefined;
  }
  return {
    maxSliceShares,
    marketableSlippageTicks,
    replaceThresholdTicks,
    minimumReplaceIntervalMs,
    cancelDeadlineMs,
    maxPlanLifetimeMs,
  };
}

function planIdAndInstant(
  planIdValue: unknown,
  plannedAtValue: unknown,
  problems: Problem[],
): { readonly executionPlanId: string; readonly plannedAt: string } | undefined {
  const executionPlanId = asIdentifier(
    planIdValue,
    "inputs.executionPlanId",
    problems,
    MAX_EXECUTION_PLAN_ID_LENGTH,
  );
  let plannedAt: string | undefined;
  if (typeof plannedAtValue !== "string" || !IsoTimestampDoor.safeParse(plannedAtValue).success) {
    problem(problems, "inputs.plannedAt", "expected an ISO-8601 instant with explicit offset");
  } else {
    plannedAt = plannedAtValue;
  }
  if (executionPlanId === undefined || plannedAt === undefined) return undefined;
  return { executionPlanId, plannedAt };
}

/** Reads and validates the full planning-inputs document (every non-cancel path). */
export function readPlanningInputs(inputs: unknown): PlannerResult<PlanningInputs> {
  const read = readInputAsData(inputs, "inputs", "planning inputs");
  if (!read.ok) return plannerFailure(read.refusal);
  const problems: Problem[] = [];
  const data = asRecord(read.value, "inputs", problems);
  if (data === undefined) return refuseProblems(problems);
  requireKnownKeys(data, "inputs", INPUT_KEYS, problems);

  const head = planIdAndInstant(data["executionPlanId"], data["plannedAt"], problems);
  const accountingMode = asMember(
    data["accountingMode"],
    "inputs.accountingMode",
    ["LIVE", "SHADOW"] as const,
    problems,
  );
  const availableCollateral = asDecimal(
    data["availableCollateral"],
    "inputs.availableCollateral",
    problems,
    "NON_NEGATIVE",
  );
  const policy = planningPolicy(data["policy"], "inputs.policy", problems);
  const timeInForce = asMember(data["timeInForce"], "inputs.timeInForce", TIME_IN_FORCE_VALUES, problems);
  const scope = data["scope"] === undefined ? undefined : scopeAttribution(data["scope"], "inputs.scope", problems);

  const marketsValue = asArray(data["markets"], "inputs.markets", problems);
  const markets: MarketPlanningInput[] = [];
  if (marketsValue !== undefined) {
    const seen = new Set<string>();
    for (const [index, entry] of marketsValue.entries()) {
      const market = marketInput(entry, `inputs.markets[${String(index)}]`, problems);
      if (market === undefined) continue;
      if (seen.has(market.marketId)) {
        problem(
          problems,
          `inputs.markets[${String(index)}].marketId`,
          "a market appears twice in the planning inputs",
        );
        continue;
      }
      seen.add(market.marketId);
      markets.push(market);
    }
  }

  if (
    problems.length > 0 ||
    head === undefined ||
    accountingMode === undefined ||
    availableCollateral === undefined ||
    policy === undefined ||
    timeInForce === undefined
  ) {
    return refuseProblems(problems);
  }
  return {
    ok: true,
    value: {
      executionPlanId: head.executionPlanId,
      plannedAt: head.plannedAt,
      accountingMode,
      availableCollateral,
      markets,
      policy,
      timeInForce,
      ...(scope === undefined ? {} : { scope }),
    },
  };
}

/**
 * Reads ONLY what a cancel plan needs (§6 invariant 13): the plan identity,
 * the planning instant, and the cancel deadline policy. A hostile or
 * malformed `markets`, `book`, `availableCollateral` or any other sibling is
 * never touched and therefore can neither throw nor refuse a valid cancel.
 */
export function readCancelPlanningInputs(inputs: unknown): PlannerResult<CancelPlanningInputs> {
  const problems: Problem[] = [];
  const planIdPluck = pluck(inputs, "inputs", ["executionPlanId"]);
  const plannedAtPluck = pluck(inputs, "inputs", ["plannedAt"]);
  const deadlinePluck = pluck(inputs, "inputs", ["policy", "cancelDeadlineMs"]);
  if (!planIdPluck.ok) problem(problems, planIdPluck.problem.path, planIdPluck.problem.problem);
  if (!plannedAtPluck.ok) problem(problems, plannedAtPluck.problem.path, plannedAtPluck.problem.problem);
  if (!deadlinePluck.ok) problem(problems, deadlinePluck.problem.path, deadlinePluck.problem.problem);
  if (!planIdPluck.ok || !plannedAtPluck.ok || !deadlinePluck.ok) {
    return refuseProblems(problems);
  }
  const head = planIdAndInstant(planIdPluck.read.value, plannedAtPluck.read.value, problems);
  const cancelDeadlineMs = asPositiveInteger(
    deadlinePluck.read.value,
    "inputs.policy.cancelDeadlineMs",
    problems,
  );
  if (head === undefined || cancelDeadlineMs === undefined || problems.length > 0) {
    return refuseProblems(problems);
  }
  return {
    ok: true,
    value: { executionPlanId: head.executionPlanId, plannedAt: head.plannedAt, cancelDeadlineMs },
  };
}

/** The per-market input covering `marketId`, or a typed refusal naming it. */
export function marketInputFor(
  inputs: PlanningInputs,
  marketId: string,
): PlannerResult<MarketPlanningInput> {
  const market = inputs.markets.find((entry) => entry.marketId === marketId);
  if (market === undefined) {
    return plannerFailure(
      plannerRefusal(
        "PLAN_MARKET_INPUT_MISSING",
        "no per-market planning input covers a market this intent trades; a plan cannot be priced against a market it knows nothing about (fail closed)",
        { marketId, covered: inputs.markets.map((entry) => entry.marketId) },
      ),
    );
  }
  return { ok: true, value: market };
}
