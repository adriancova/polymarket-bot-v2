/**
 * Fee arithmetic from a PINNED historical snapshot (§6 invariant 9, §12.5).
 *
 * §6 invariant 9: "Market rules, settlement specs, fee schedules, tick sizes,
 * minimum sizes, and delays are versioned. **Historical runs use historical
 * parameters.**" §9.13 forbids hardcoding them. §12.5 requires the fee snapshot
 * VERSION to be pinned per run. So this module contains **no rate**: every
 * parameter arrives in a {@link FeeScheduleSnapshot} the caller resolved for the
 * instant being replayed, and a run without one is refused.
 *
 * ## The formula
 *
 * ADR-012 §5.4, citing `docs/venue/verified-2026-08-24.md` §6:
 *
 * ```text
 * fee = C × feeRate × p × (1 − p)
 * ```
 *
 * with `C` = shares and `p` = price, charged in USDC, symmetric around
 * `p = 0.5`, **rounded to 5 decimal places**, minimum charged fee `0.00001`,
 * and **makers pay no fees** (`maker_fee_rate: "0"` in the frozen
 * `test/fixtures/venue/fees/fee-reward-parameters.json` snapshot).
 *
 * ## The rounding direction is NOT a documented venue fact
 *
 * The venue documentation says "rounded to 5 decimal places" and does not state
 * a direction or a tie rule. `AGENTS.md` forbids inventing venue behaviour, so
 * this module does not choose: {@link FeeScheduleSnapshot} carries a REQUIRED
 * `roundingMode`, the caller states it, and the choice travels into the run's
 * pinned parameters where a reader can see it. `packages/simulation/README.md`
 * §5 item 1 carries this as a disclosed limit and a follow-up for the next venue
 * verification round.
 *
 * Every value here is an exact decimal string. No JavaScript `number` touches a
 * fee (§6 invariant 1).
 */

import {
  addDecimal,
  compareDecimal,
  isCanonicalDecimalString,
  mulDecimal,
  subDecimal,
} from "@polymarket-bot/decimal";

import { isNonNegativeInteger, isNonEmptyString } from "./grammar.js";
import { ownFrozenTree } from "./plain.js";
import {
  describeForRefusal,
  simulationFailure,
  simulationOk,
  totally,
  type SimulationResult,
} from "./refusals.js";

/** How the venue's stated "rounded to 5 decimal places" is applied. */
export type FeeRoundingMode = "HALF_UP" | "HALF_EVEN" | "UP" | "DOWN";

/** Every rounding mode this module implements. */
export const FEE_ROUNDING_MODES: readonly FeeRoundingMode[] = [
  "HALF_UP",
  "HALF_EVEN",
  "UP",
  "DOWN",
];

/**
 * A pinned historical fee schedule.
 *
 * `snapshotVersion` is the §12.5 pin. Nothing in this module has a default.
 */
export interface FeeScheduleSnapshot {
  readonly snapshotVersion: string;
  /** Taker fee rate for the market's category, as a canonical decimal string. */
  readonly takerFeeRate: string;
  /** Maker fee rate. The 2026-08-24 snapshot records `"0"`. */
  readonly makerFeeRate: string;
  readonly roundingDecimalPlaces: number;
  readonly roundingMode: FeeRoundingMode;
  /** Minimum charged fee once a fee is charged at all. */
  readonly minimumChargedFee: string;
  /** The currency the fee is charged in, recorded rather than assumed. */
  readonly feeCurrency: string;
}

/** Validates a fee snapshot. A run without a valid one cannot charge a fee. */
export function readFeeScheduleSnapshot(
  value: FeeScheduleSnapshot,
): SimulationResult<FeeScheduleSnapshot> {
  return totally("reading the fee schedule snapshot", () => readFeeScheduleSnapshotInner(value));
}

function readFeeScheduleSnapshotInner(
  value: FeeScheduleSnapshot,
): SimulationResult<FeeScheduleSnapshot> {
  if (value === null || typeof value !== "object") {
    return simulationFailure(
      "FILL_MODEL_FEE_SNAPSHOT_MISSING",
      "a fee schedule snapshot is required and none was supplied (§6 invariant 9, §12.5)",
    );
  }
  if (!isNonEmptyString(value.snapshotVersion)) {
    return simulationFailure(
      "FILL_MODEL_FEE_SNAPSHOT_MISSING",
      "the fee schedule snapshot must name its version; §12.5 pins the fee snapshot version per run",
    );
  }
  for (const [name, rate] of [
    ["takerFeeRate", value.takerFeeRate],
    ["makerFeeRate", value.makerFeeRate],
    ["minimumChargedFee", value.minimumChargedFee],
  ] as const) {
    if (!isCanonicalDecimalString(rate)) {
      return simulationFailure(
        "FILL_MODEL_FEE_SNAPSHOT_MISSING",
        `the fee schedule snapshot's ${name} must be a canonical decimal string (§6 invariant 1)`,
        { field: name },
      );
    }
    if (compareDecimal(rate, "0") < 0) {
      return simulationFailure(
        "FILL_MODEL_FEE_SNAPSHOT_MISSING",
        `the fee schedule snapshot's ${name} is negative`,
        { field: name },
      );
    }
  }
  if (!isNonNegativeInteger(value.roundingDecimalPlaces) || value.roundingDecimalPlaces > 18) {
    return simulationFailure(
      "FILL_MODEL_FEE_SNAPSHOT_MISSING",
      "roundingDecimalPlaces must be an integer in [0, 18]",
    );
  }
  const rounding = readRoundingMode(value.roundingMode);
  if (!rounding.ok) {
    return simulationFailure(
      "FILL_MODEL_FEE_SNAPSHOT_MISSING",
      "roundingMode must be stated explicitly; the venue documentation records the number of decimal places but not the direction, and this simulator does not choose one for the operator",
      { offered: describeForRefusal(value.roundingMode) },
    );
  }
  if (!isNonEmptyString(value.feeCurrency)) {
    return simulationFailure(
      "FILL_MODEL_FEE_SNAPSHOT_MISSING",
      "feeCurrency must be recorded, not assumed",
    );
  }
  return simulationOk(ownFrozenTree(value));
}

/** One fee computation, with its inputs, so a reader can re-derive it. */
export interface FeeComputation {
  readonly feeAmount: string;
  readonly liquidityRole: "MAKER" | "TAKER";
  readonly feeRate: string;
  readonly unroundedFee: string;
  readonly snapshotVersion: string;
  readonly roundingMode: FeeRoundingMode;
  readonly minimumApplied: boolean;
}

/**
 * `fee = C × feeRate × p × (1 − p)`, rounded and floored per the snapshot.
 *
 * A MAKER fill charges the snapshot's maker rate, which the 2026-08-24 snapshot
 * records as `"0"`; the code does not special-case it, so a future snapshot with
 * a nonzero maker rate is simulated correctly without an edit here.
 *
 * The minimum charged fee applies only when a fee is charged at all: a zero rate
 * yields a zero fee, not a minimum. ADR-006 §6 / ADR-012 §5.5 additionally
 * forbid crediting a rebate to a simulated fill, and nothing here does.
 */
export function computeFee(input: {
  readonly shares: string;
  readonly price: string;
  readonly liquidityRole: "MAKER" | "TAKER";
  readonly snapshot: FeeScheduleSnapshot;
}): SimulationResult<FeeComputation> {
  return totally("computing a fee", () => computeFeeInner(input));
}

function computeFeeInner(input: {
  readonly shares: string;
  readonly price: string;
  readonly liquidityRole: "MAKER" | "TAKER";
  readonly snapshot: FeeScheduleSnapshot;
}): SimulationResult<FeeComputation> {
  const { shares, price, liquidityRole } = input;
  if (liquidityRole !== "MAKER" && liquidityRole !== "TAKER") {
    return simulationFailure(
      "SIMULATION_INPUT_INVALID",
      "a fill is a MAKER or a TAKER fill; the role is recorded, never assumed (ADR-012 §5.4)",
      { offered: describeForRefusal(liquidityRole) },
    );
  }
  // The SNAPSHOT is validated here, at the door, and not merely trusted from a
  // caller that may or may not have read it. Two failures this closes, both
  // found by the round-1 review: a non-canonical rate reached `mulDecimal` and
  // THREW out of a function that documents typed refusals; and a `roundingMode`
  // outside the closed set fell through `shouldRoundUp`'s `default` and rounded
  // DOWN silently — the venue documents the number of decimal places but not the
  // direction, so choosing one on the operator's behalf is exactly what
  // `readFeeScheduleSnapshot` exists to refuse.
  const read = readFeeScheduleSnapshot(input.snapshot);
  if (!read.ok) return read;
  const snapshot = read.value;
  if (!isCanonicalDecimalString(shares) || !isCanonicalDecimalString(price)) {
    return simulationFailure(
      "SIMULATION_INPUT_INVALID",
      "fee inputs must be canonical decimal strings (§6 invariant 1)",
    );
  }
  const feeRate = liquidityRole === "MAKER" ? snapshot.makerFeeRate : snapshot.takerFeeRate;
  const complement = subDecimal("1", price);
  const unrounded = mulDecimal(mulDecimal(mulDecimal(shares, feeRate), price), complement);
  const rounded = roundDecimal(unrounded, snapshot.roundingDecimalPlaces, snapshot.roundingMode);
  if (!rounded.ok) return rounded;
  let feeAmount = rounded.value;
  let minimumApplied = false;
  if (compareDecimal(unrounded, "0") > 0 && compareDecimal(feeAmount, snapshot.minimumChargedFee) < 0) {
    feeAmount = snapshot.minimumChargedFee;
    minimumApplied = true;
  }
  return simulationOk(
    ownFrozenTree<FeeComputation>({
      feeAmount,
      liquidityRole,
      feeRate,
      unroundedFee: unrounded,
      snapshotVersion: snapshot.snapshotVersion,
      roundingMode: snapshot.roundingMode,
      minimumApplied,
    }),
  );
}

/**
 * Rounds a canonical decimal string to `places`, exactly.
 *
 * Implemented on the digit string rather than through a float: the whole point
 * of §6 invariant 1 is that no economic value passes through binary floating
 * point, and "just for the rounding" is exactly how that happens.
 *
 * TOTAL, and it returns a RESULT rather than a string, for one reason found by
 * the round-1 review: the previous version's rounding switch had a `default`
 * branch that returned "do not round up", so an unrecognised mode silently
 * rounded DOWN. The venue documents "rounded to 5 decimal places" and states no
 * direction (`docs/venue/verified-2026-08-24.md` §6), so a direction this module
 * was never told is a REFUSAL — never a quiet choice made for the operator.
 */
export function roundDecimal(
  value: string,
  places: number,
  mode: FeeRoundingMode,
): SimulationResult<string> {
  if (!isCanonicalDecimalString(value)) {
    return simulationFailure(
      "SIMULATION_INPUT_INVALID",
      "roundDecimal takes a canonical decimal string (§6 invariant 1)",
      { offered: describeForRefusal(value) },
    );
  }
  if (!isNonNegativeInteger(places) || places > 18) {
    return simulationFailure(
      "SIMULATION_INPUT_INVALID",
      "roundDecimal takes an integer number of decimal places in [0, 18]",
      { offered: describeForRefusal(places) },
    );
  }
  const rounding = readRoundingMode(mode);
  if (!rounding.ok) return rounding;

  const negative = value.startsWith("-");
  const magnitude = negative ? value.slice(1) : value;
  const dot = magnitude.indexOf(".");
  const integerPart = dot < 0 ? magnitude : magnitude.slice(0, dot);
  const fractionPart = dot < 0 ? "" : magnitude.slice(dot + 1);
  if (fractionPart.length <= places) {
    return simulationOk(canonical(negative, integerPart, fractionPart));
  }
  const kept = fractionPart.slice(0, places);
  const dropped = fractionPart.slice(places);
  const roundUp = shouldRoundUp(kept, dropped, rounding.value);
  if (!roundUp) return simulationOk(canonical(negative, integerPart, kept));
  const bumped = incrementDigits(`${integerPart}${kept}`);
  const integerLength = bumped.length - kept.length;
  return simulationOk(
    canonical(negative, bumped.slice(0, integerLength), bumped.slice(integerLength)),
  );
}

/** The closed rounding vocabulary, as a door. An unknown mode is refused. */
export function readRoundingMode(mode: FeeRoundingMode): SimulationResult<FeeRoundingMode> {
  if (!FEE_ROUNDING_MODES.includes(mode)) {
    return simulationFailure(
      "FILL_MODEL_FEE_SNAPSHOT_MISSING",
      "the rounding mode must be one this module implements; the venue documentation records the number of decimal places but not the direction, and this simulator does not choose one for the operator",
      { offered: describeForRefusal(mode), implemented: FEE_ROUNDING_MODES.join(",") },
    );
  }
  return simulationOk(mode);
}

/** Decides the direction. Every branch is a named member of the closed union. */
function shouldRoundUp(kept: string, dropped: string, mode: FeeRoundingMode): boolean {
  if (/^0*$/u.test(dropped)) return false;
  if (mode === "DOWN") return false;
  if (mode === "UP") return true;
  const first = dropped.charCodeAt(0) - 0x30;
  if (first > 5) return true;
  if (first < 5) return false;
  const restNonZero = !/^0*$/u.test(dropped.slice(1));
  if (restNonZero) return true;
  if (mode === "HALF_UP") return true;
  // HALF_EVEN: round to make the last kept digit even. A negative value rounds
  // the same way on its magnitude, which is what "half to even" means for a
  // symmetric mode.
  const last = kept.length === 0 ? 0 : kept.charCodeAt(kept.length - 1) - 0x30;
  return last % 2 === 1;
}

function incrementDigits(digits: string): string {
  const out = digits.split("");
  let index = out.length - 1;
  for (;;) {
    if (index < 0) {
      out.unshift("1");
      break;
    }
    const digit = (out[index] ?? "0").charCodeAt(0) - 0x30;
    if (digit < 9) {
      out[index] = String(digit + 1);
      break;
    }
    out[index] = "0";
    index -= 1;
  }
  return out.join("");
}

function canonical(negative: boolean, integerPart: string, fractionPart: string): string {
  let integerDigits = integerPart.replace(/^0+(?=\d)/u, "");
  if (integerDigits === "") integerDigits = "0";
  const fractionDigits = fractionPart.replace(/0+$/u, "");
  const magnitude = fractionDigits === "" ? integerDigits : `${integerDigits}.${fractionDigits}`;
  if (magnitude === "0") return "0";
  return negative ? `-${magnitude}` : magnitude;
}

/** Sums fee amounts exactly. Total: a non-canonical amount is refused. */
export function sumFees(amounts: readonly string[]): SimulationResult<string> {
  if (!Array.isArray(amounts)) {
    return simulationFailure("SIMULATION_INPUT_INVALID", "fees are summed over an array of amounts");
  }
  let total = "0";
  for (const amount of amounts) {
    if (!isCanonicalDecimalString(amount)) {
      return simulationFailure(
        "SIMULATION_INPUT_INVALID",
        "a fee amount is not a canonical decimal string (§6 invariant 1)",
        { offered: describeForRefusal(amount) },
      );
    }
    total = addDecimal(total, amount);
  }
  return simulationOk(total);
}
