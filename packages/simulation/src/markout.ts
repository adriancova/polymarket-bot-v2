/**
 * Markouts — DIAGNOSTICS, and the one rule that makes them safe (§12.3).
 *
 * §12.3, verbatim:
 *
 * > Markouts are diagnostics and calibration inputs. **Do not subtract an
 * > additional markout penalty from a replay path that already includes the
 * > subsequent adverse price movement.** Produce separate stress scenarios when
 * > desired.
 *
 * ADR-012 §3 restates it and names the harm: double-counting "makes a strategy
 * look worse in a way that is not real". Work-plan `WP-210` acceptance 3 is
 * exactly this sentence.
 *
 * ## How this module makes double-counting hard rather than merely forbidden
 *
 * 1. {@link replayPathEconomics} — the ONLY function here that produces a
 *    monetary result for the replay path — takes fills and nothing else. It has
 *    no markout parameter, so there is no argument position through which a
 *    penalty could arrive. {@link REPLAY_PATH_ECONOMICS_KEYS} is exported and
 *    pinned by a test, so adding one is a visible contract change.
 * 2. {@link computeMarkouts} returns a record whose `role` is
 *    `"DIAGNOSTIC_ONLY"` and whose `appliedToReplayEconomics` is the literal
 *    `false`. It contains no money the replay path consumes.
 * 3. A penalty is available only through {@link markoutStressScenario}, whose
 *    result is a SEPARATE, differently-typed record labelled
 *    `basis: "STRESS_SCENARIO"` and carrying the replay economics it was derived
 *    from, unchanged, alongside the stressed number. Presenting the stressed
 *    figure as the replay result therefore requires deliberately reading the
 *    wrong field of a record that says so.
 *
 * ## Required horizons
 *
 * §12.3 and ADR-012 §3 fix them: 100 ms, 500 ms, 1 s, 5 s, 30 s, 300 s, and
 * resolution. A horizon the recorded path does not reach is REFUSED
 * (`MARKOUT_HORIZON_UNOBSERVED`), never silently reported as zero — a zero
 * markout and an unobservable one are different facts.
 */

import { addDecimal, compareDecimal, isCanonicalDecimalString, mulDecimal, subDecimal } from "@polymarket-bot/decimal";

import { ownFrozenTree, readOwnPlainInput } from "./plain.js";
import type { RecordedEventIdentity } from "./ports.js";
import type { SimulatedFill } from "./fill-model.js";
import { simulationFailure, simulationOk, totally, type SimulationResult } from "./refusals.js";

/** One §12.3 horizon. `milliseconds` is `null` for the resolution horizon. */
export interface MarkoutHorizon {
  readonly label: string;
  readonly milliseconds: number | null;
}

/** The §12.3 horizons, in order. Exhaustive: §12.3 lists exactly these seven. */
export const MARKOUT_HORIZONS: readonly MarkoutHorizon[] = Object.freeze([
  Object.freeze({ label: "100ms", milliseconds: 100 }),
  Object.freeze({ label: "500ms", milliseconds: 500 }),
  Object.freeze({ label: "1s", milliseconds: 1_000 }),
  Object.freeze({ label: "5s", milliseconds: 5_000 }),
  Object.freeze({ label: "30s", milliseconds: 30_000 }),
  Object.freeze({ label: "300s", milliseconds: 300_000 }),
  Object.freeze({ label: "resolution", milliseconds: null }),
]);

/** The recorded mid price at a recorded monotonic instant. */
export interface MidTimeline {
  midAt(input: {
    readonly marketId: string;
    readonly tokenId: string;
    readonly monotonicNs: bigint;
  }): { readonly mid: string; readonly atEvent: RecordedEventIdentity } | undefined;
}

/** One horizon's markout for one fill. */
export interface MarkoutObservation {
  readonly horizon: string;
  readonly referencePrice: string;
  /** Signed per share: positive means the price moved in the fill's favour. */
  readonly perShare: string;
  readonly total: string;
  readonly atEvent: RecordedEventIdentity | null;
}

/**
 * Markout diagnostics for one fill.
 *
 * DIAGNOSTIC ONLY. Nothing in this record is money the replay path spends or
 * earns; see the module header for why that is structural rather than a
 * convention.
 */
export interface MarkoutDiagnostics {
  readonly simulatedFillId: string;
  readonly role: "DIAGNOSTIC_ONLY";
  readonly appliedToReplayEconomics: false;
  readonly observations: readonly MarkoutObservation[];
  /** Restates §12.3 on the value, for a report that prints it. */
  readonly note: string;
}

const DIAGNOSTIC_NOTE =
  "Handoff §12.3: markouts are diagnostics and calibration inputs. The replay path " +
  "already contains the subsequent adverse price movement, so no additional markout " +
  "penalty is subtracted from it. A stress scenario that applies one is produced " +
  "separately and labelled as stress.";

/**
 * Computes the §12.3 horizons for one fill from the recorded mid path.
 *
 * `resolutionValuePerShare` is the settled value of one share, supplied by the
 * caller (§9.3 settlement, not this package's decision). When it is absent the
 * resolution horizon is refused rather than reported.
 */
export function computeMarkouts(input: {
  readonly fill: SimulatedFill;
  readonly filledAtNs: bigint;
  readonly midTimeline: MidTimeline;
  readonly resolutionValuePerShare?: string;
  readonly horizons?: readonly MarkoutHorizon[];
}): SimulationResult<MarkoutDiagnostics> {
  return totally("computing markouts", () => computeMarkoutsInner(input));
}

function computeMarkoutsInner(input: {
  readonly fill: SimulatedFill;
  readonly filledAtNs: bigint;
  readonly midTimeline: MidTimeline;
  readonly resolutionValuePerShare?: string;
  readonly horizons?: readonly MarkoutHorizon[];
}): SimulationResult<MarkoutDiagnostics> {
  // D1 + one read per field (round-3 review, MEDIUM-1). `fill` is a CALLER
  // RECORD whose `price`, `shares`, `marketId`, `tokenId`, `action` and
  // `simulatedFillId` are each read repeatedly below and again inside
  // `observationAt`. `midTimeline` is a PORT — its contract is `midAt` — so it
  // is read once and called, never materialized.
  const { fill: offeredFill, filledAtNs, midTimeline } = input;
  const { resolutionValuePerShare, horizons: offeredHorizons } = input;

  const read = readOwnPlainInput<SimulatedFill>(offeredFill, "the fill");
  if (!read.ok) return read;
  const fill = read.value;
  if (fill === null || typeof fill !== "object") {
    return simulationFailure("SIMULATION_INPUT_INVALID", "a markout is computed about one fill");
  }
  if (!isCanonicalDecimalString(fill.price) || !isCanonicalDecimalString(fill.shares)) {
    return simulationFailure(
      "SIMULATION_INPUT_INVALID",
      "the fill carries a non-canonical decimal (§6 invariant 1)",
      { price: String(fill.price), shares: String(fill.shares) },
    );
  }
  if (typeof filledAtNs !== "bigint") {
    return simulationFailure(
      "SIMULATION_INPUT_INVALID",
      "a markout is anchored to the recorded monotonic instant of the fill (§7.1)",
    );
  }
  if (midTimeline === null || typeof midTimeline !== "object" || typeof midTimeline.midAt !== "function") {
    return simulationFailure(
      "SIMULATION_INPUT_INVALID",
      "a markout reads the recorded mid path through a MidTimeline port",
    );
  }
  const readHorizons = readOwnPlainInput<readonly MarkoutHorizon[]>(
    offeredHorizons ?? MARKOUT_HORIZONS,
    "the markout horizons",
  );
  if (!readHorizons.ok) return readHorizons;
  const horizons = readHorizons.value;
  if (!Array.isArray(horizons)) {
    return simulationFailure(
      "SIMULATION_INPUT_INVALID",
      "the §12.3 horizons are an array of `{ label, milliseconds }` records",
    );
  }
  const direction = fill.action === "BUY" ? 1 : -1;
  const observations: MarkoutObservation[] = [];

  for (const horizon of horizons) {
    if (horizon === null || typeof horizon !== "object" || typeof horizon.label !== "string") {
      return simulationFailure(
        "SIMULATION_INPUT_INVALID",
        "a markout horizon carries a label and its milliseconds (`null` for resolution)",
      );
    }
    if (horizon.milliseconds === null) {
      const settled = resolutionValuePerShare;
      if (settled === undefined) {
        return simulationFailure(
          "MARKOUT_HORIZON_UNOBSERVED",
          "the resolution horizon needs the settled value of one share, and none was supplied; a zero markout and an unobservable one are different facts",
          { horizon: horizon.label, simulatedFillId: fill.simulatedFillId },
        );
      }
      if (!isCanonicalDecimalString(settled)) {
        return simulationFailure(
          "SIMULATION_INPUT_INVALID",
          "resolutionValuePerShare must be a canonical decimal string",
        );
      }
      observations.push(observationAt(horizon.label, settled, fill, direction, null));
      continue;
    }
    if (!Number.isSafeInteger(horizon.milliseconds)) {
      return simulationFailure(
        "SIMULATION_INPUT_INVALID",
        "a markout horizon's milliseconds is a safe integer, or `null` for the resolution horizon",
        { horizon: horizon.label },
      );
    }
    const atNs = filledAtNs + BigInt(horizon.milliseconds) * 1_000_000n;
    const observed = midTimeline.midAt({
      marketId: fill.marketId,
      tokenId: fill.tokenId,
      monotonicNs: atNs,
    });
    if (observed === undefined) {
      return simulationFailure(
        "MARKOUT_HORIZON_UNOBSERVED",
        `the recorded path does not reach the ${horizon.label} horizon for this fill; reporting it as zero would state an observation that was never made`,
        { horizon: horizon.label, simulatedFillId: fill.simulatedFillId },
      );
    }
    // The port's ANSWER is data, and it is read once, here.
    const readObserved = readOwnPlainInput<{
      readonly mid: string;
      readonly atEvent: RecordedEventIdentity;
    }>(observed, "the observed mid");
    if (!readObserved.ok) return readObserved;
    const mid = readObserved.value;
    if (mid === null || typeof mid !== "object" || !isCanonicalDecimalString(mid.mid)) {
      return simulationFailure(
        "SIMULATION_INPUT_INVALID",
        "the mid timeline returned a non-canonical decimal",
        { horizon: horizon.label },
      );
    }
    observations.push(observationAt(horizon.label, mid.mid, fill, direction, mid.atEvent));
  }

  return simulationOk(
    ownFrozenTree<MarkoutDiagnostics>({
      simulatedFillId: fill.simulatedFillId,
      role: "DIAGNOSTIC_ONLY",
      appliedToReplayEconomics: false,
      observations,
      note: DIAGNOSTIC_NOTE,
    }),
  );
}

function observationAt(
  horizon: string,
  referencePrice: string,
  fill: SimulatedFill,
  direction: 1 | -1,
  atEvent: RecordedEventIdentity | null,
): MarkoutObservation {
  const raw = subDecimal(referencePrice, fill.price);
  const perShare = direction === 1 ? raw : subDecimal("0", raw);
  return {
    horizon,
    referencePrice,
    perShare,
    total: mulDecimal(perShare, fill.shares),
    atEvent,
  };
}

// ---------------------------------------------------------------------------
// The replay path's own economics
// ---------------------------------------------------------------------------

/**
 * The keys {@link replayPathEconomics} produces.
 *
 * Exported and pinned by `test/unit/simulation/markout.test.ts` so that adding a
 * markout term to the replay path is a visible contract change rather than an
 * edit nobody notices.
 */
export const REPLAY_PATH_ECONOMICS_KEYS: readonly string[] = Object.freeze([
  "basis",
  "buyNotional",
  "sellNotional",
  "fees",
  "netCashFlow",
  "sharesBought",
  "sharesSold",
  "fillCount",
  "markoutPenaltyApplied",
]);

/**
 * The realized economics of a replay path.
 *
 * Cash only: what was paid, what was received, and the fees charged — all from
 * the fills the replay actually produced. `markoutPenaltyApplied` is the literal
 * `false` and there is no code path that sets it otherwise, because §12.3 makes
 * a markout penalty on this path a double count of a move the path already
 * contains.
 */
export interface ReplayPathEconomics {
  readonly basis: "REALIZED_IN_REPLAY_PATH";
  readonly buyNotional: string;
  readonly sellNotional: string;
  readonly fees: string;
  /** `sellNotional − buyNotional − fees`, exactly. */
  readonly netCashFlow: string;
  readonly sharesBought: string;
  readonly sharesSold: string;
  readonly fillCount: number;
  readonly markoutPenaltyApplied: false;
}

/**
 * Folds fills into the replay path's realized economics. Exact throughout.
 *
 * TOTAL, and it returns a RESULT: the round-1 review found that a fill carrying
 * a type-valid but non-canonical decimal reached `mulDecimal` and THREW out of a
 * function that the run driver, the CLI and the stress-scenario builder all call
 * (ADR-020 §6 — no throw escapes a door).
 */
export function replayPathEconomics(
  fills: readonly SimulatedFill[],
): SimulationResult<ReplayPathEconomics> {
  return totally("folding the replay path's economics", () => replayPathEconomicsInner(fills));
}

function replayPathEconomicsInner(
  offered: readonly SimulatedFill[],
): SimulationResult<ReplayPathEconomics> {
  // D1 (round-3 review, MEDIUM-1): a fill is a CALLER RECORD here — this door is
  // exported, and the run driver, the CLI and the stress-scenario builder all
  // call it — and each fill's `price`, `shares`, `feeAmount` and `action` are
  // read twice: once to validate and once to fold. At `b0aeb28` an accessor
  // `price` was ACCEPTED with the getter invoked, so the money folded was not
  // the money checked.
  const read = readOwnPlainInput<readonly SimulatedFill[]>(
    offered,
    "the replay path's fills",
  );
  if (!read.ok) return read;
  const fills = read.value;
  if (!Array.isArray(fills)) {
    return simulationFailure(
      "SIMULATION_INPUT_INVALID",
      "the replay path's economics are folded from an array of fills",
    );
  }
  let buyNotional = "0";
  let sellNotional = "0";
  let fees = "0";
  let sharesBought = "0";
  let sharesSold = "0";
  for (let index = 0; index < fills.length; index += 1) {
    const fill = fills[index];
    if (fill === null || fill === undefined || typeof fill !== "object") {
      return simulationFailure("SIMULATION_INPUT_INVALID", "a fill is not a record", { index });
    }
    if (
      !isCanonicalDecimalString(fill.price) ||
      !isCanonicalDecimalString(fill.shares) ||
      !isCanonicalDecimalString(fill.feeAmount)
    ) {
      return simulationFailure(
        "SIMULATION_INPUT_INVALID",
        "a fill carries a non-canonical decimal; the replay path's economics are exact (§6 invariant 1)",
        {
          index,
          price: String(fill.price),
          shares: String(fill.shares),
          feeAmount: String(fill.feeAmount),
        },
      );
    }
    if (fill.action !== "BUY" && fill.action !== "SELL") {
      return simulationFailure("SIMULATION_INPUT_INVALID", "a fill's action is BUY or SELL", {
        index,
        offered: String(fill.action),
      });
    }
    const notional = mulDecimal(fill.price, fill.shares);
    if (fill.action === "BUY") {
      buyNotional = addDecimal(buyNotional, notional);
      sharesBought = addDecimal(sharesBought, fill.shares);
    } else {
      sellNotional = addDecimal(sellNotional, notional);
      sharesSold = addDecimal(sharesSold, fill.shares);
    }
    fees = addDecimal(fees, fill.feeAmount);
  }
  return simulationOk(
    ownFrozenTree<ReplayPathEconomics>({
      basis: "REALIZED_IN_REPLAY_PATH",
      buyNotional,
      sellNotional,
      fees,
      netCashFlow: subDecimal(subDecimal(sellNotional, buyNotional), fees),
      sharesBought,
      sharesSold,
      fillCount: fills.length,
      markoutPenaltyApplied: false,
    }),
  );
}

// ---------------------------------------------------------------------------
// Stress scenarios — separate, and labelled
// ---------------------------------------------------------------------------

/**
 * A stress scenario built from markouts.
 *
 * §12.3: "Produce separate stress scenarios when desired." This record is the
 * separate thing. It carries the untouched replay economics next to the stressed
 * figure, so a reader can always see both, and its `basis` says what it is.
 */
export interface MarkoutStressScenario {
  readonly basis: "STRESS_SCENARIO";
  readonly scenarioName: string;
  readonly horizon: string;
  /** The replay path's own realized economics, UNCHANGED. */
  readonly replay: ReplayPathEconomics;
  /** The additional penalty this scenario applies, as a positive amount. */
  readonly appliedPenalty: string;
  /** `replay.netCashFlow − appliedPenalty`. NOT the replay result. */
  readonly stressedNetCashFlow: string;
  readonly note: string;
}

const STRESS_NOTE =
  "Handoff §12.3 / ADR-012 §3: this is a SEPARATE stress scenario, not the replay result. " +
  "The replay path already contains the subsequent adverse price movement; `replay` above is " +
  "that path's realized economics and is the number to compare against other replay results.";

/**
 * Builds a stress scenario that applies an ADDITIONAL adverse markout penalty.
 *
 * Only adverse observations contribute: a favourable markout is not turned into
 * a bonus, because a stress scenario that could improve a result is not a stress
 * scenario. The penalty is the sum of the negative totals at the chosen horizon,
 * expressed as a positive amount.
 */
export function markoutStressScenario(input: {
  readonly scenarioName: string;
  readonly horizon: string;
  readonly fills: readonly SimulatedFill[];
  readonly diagnostics: readonly MarkoutDiagnostics[];
}): SimulationResult<MarkoutStressScenario> {
  return totally("building a markout stress scenario", () => markoutStressScenarioInner(input));
}

function markoutStressScenarioInner(input: {
  readonly scenarioName: string;
  readonly horizon: string;
  readonly fills: readonly SimulatedFill[];
  readonly diagnostics: readonly MarkoutDiagnostics[];
}): SimulationResult<MarkoutStressScenario> {
  // D1 + one read per field (round-3 review, MEDIUM-1). `fills` is materialized
  // by `replayPathEconomics`; the DIAGNOSTICS are a second caller array whose
  // `observations[].total` is read to validate and again to accumulate.
  const { scenarioName, horizon, fills, diagnostics: offeredDiagnostics } = input;

  const folded = replayPathEconomics(fills);
  if (!folded.ok) return folded;
  const replay = folded.value;
  const read = readOwnPlainInput<readonly MarkoutDiagnostics[]>(
    offeredDiagnostics,
    "the markout diagnostics",
  );
  if (!read.ok) return read;
  const diagnostics = read.value;
  if (!Array.isArray(diagnostics)) {
    return simulationFailure(
      "SIMULATION_INPUT_INVALID",
      "a stress scenario is built from an array of markout diagnostics",
    );
  }
  if (typeof horizon !== "string" || typeof scenarioName !== "string") {
    return simulationFailure(
      "SIMULATION_INPUT_INVALID",
      "a stress scenario names itself and the §12.3 horizon it applies",
    );
  }
  let penalty = "0";
  let matched = 0;
  for (const diagnostic of diagnostics) {
    if (diagnostic === null || typeof diagnostic !== "object" || !Array.isArray(diagnostic.observations)) {
      return simulationFailure(
        "SIMULATION_INPUT_INVALID",
        "a markout diagnostic must carry its observations",
      );
    }
    const observation = diagnostic.observations.find(
      (entry: MarkoutObservation) => entry !== null && typeof entry === "object" && entry.horizon === horizon,
    );
    if (observation === undefined) continue;
    matched += 1;
    if (!isCanonicalDecimalString(observation.total)) {
      return simulationFailure(
        "SIMULATION_INPUT_INVALID",
        "a markout observation carries a non-canonical total",
        { horizon, offered: String(observation.total) },
      );
    }
    if (compareDecimal(observation.total, "0") < 0) {
      penalty = addDecimal(penalty, subDecimal("0", observation.total));
    }
  }
  if (matched === 0) {
    return simulationFailure(
      "MARKOUT_HORIZON_UNOBSERVED",
      `no supplied diagnostic carries the ${JSON.stringify(horizon)} horizon, so no stress scenario can be built at it`,
      { horizon },
    );
  }
  return simulationOk(
    ownFrozenTree<MarkoutStressScenario>({
      basis: "STRESS_SCENARIO",
      scenarioName,
      horizon,
      replay,
      appliedPenalty: penalty,
      stressedNetCashFlow: subDecimal(replay.netCashFlow, penalty),
      note: STRESS_NOTE,
    }),
  );
}
