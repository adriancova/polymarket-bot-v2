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

import { ownFrozenTree } from "./plain.js";
import type { RecordedEventIdentity } from "./ports.js";
import type { SimulatedFill } from "./fill-model.js";
import { simulationFailure, simulationOk, type SimulationResult } from "./refusals.js";

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
  const horizons = input.horizons ?? MARKOUT_HORIZONS;
  const direction = input.fill.action === "BUY" ? 1 : -1;
  const observations: MarkoutObservation[] = [];

  for (const horizon of horizons) {
    if (horizon.milliseconds === null) {
      const settled = input.resolutionValuePerShare;
      if (settled === undefined) {
        return simulationFailure(
          "MARKOUT_HORIZON_UNOBSERVED",
          "the resolution horizon needs the settled value of one share, and none was supplied; a zero markout and an unobservable one are different facts",
          { horizon: horizon.label, simulatedFillId: input.fill.simulatedFillId },
        );
      }
      if (!isCanonicalDecimalString(settled)) {
        return simulationFailure(
          "SIMULATION_INPUT_INVALID",
          "resolutionValuePerShare must be a canonical decimal string",
        );
      }
      observations.push(observationAt(horizon.label, settled, input.fill, direction, null));
      continue;
    }
    const atNs = input.filledAtNs + BigInt(horizon.milliseconds) * 1_000_000n;
    const observed = input.midTimeline.midAt({
      marketId: input.fill.marketId,
      tokenId: input.fill.tokenId,
      monotonicNs: atNs,
    });
    if (observed === undefined) {
      return simulationFailure(
        "MARKOUT_HORIZON_UNOBSERVED",
        `the recorded path does not reach the ${horizon.label} horizon for this fill; reporting it as zero would state an observation that was never made`,
        { horizon: horizon.label, simulatedFillId: input.fill.simulatedFillId },
      );
    }
    if (!isCanonicalDecimalString(observed.mid)) {
      return simulationFailure(
        "SIMULATION_INPUT_INVALID",
        "the mid timeline returned a non-canonical decimal",
        { horizon: horizon.label },
      );
    }
    observations.push(
      observationAt(horizon.label, observed.mid, input.fill, direction, observed.atEvent),
    );
  }

  return simulationOk(
    ownFrozenTree<MarkoutDiagnostics>({
      simulatedFillId: input.fill.simulatedFillId,
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

/** Folds fills into the replay path's realized economics. Exact throughout. */
export function replayPathEconomics(fills: readonly SimulatedFill[]): ReplayPathEconomics {
  let buyNotional = "0";
  let sellNotional = "0";
  let fees = "0";
  let sharesBought = "0";
  let sharesSold = "0";
  for (const fill of fills) {
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
  return ownFrozenTree<ReplayPathEconomics>({
    basis: "REALIZED_IN_REPLAY_PATH",
    buyNotional,
    sellNotional,
    fees,
    netCashFlow: subDecimal(subDecimal(sellNotional, buyNotional), fees),
    sharesBought,
    sharesSold,
    fillCount: fills.length,
    markoutPenaltyApplied: false,
  });
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
  const replay = replayPathEconomics(input.fills);
  let penalty = "0";
  let matched = 0;
  for (const diagnostic of input.diagnostics) {
    const observation = diagnostic.observations.find((entry) => entry.horizon === input.horizon);
    if (observation === undefined) continue;
    matched += 1;
    if (compareDecimal(observation.total, "0") < 0) {
      penalty = addDecimal(penalty, subDecimal("0", observation.total));
    }
  }
  if (matched === 0) {
    return simulationFailure(
      "MARKOUT_HORIZON_UNOBSERVED",
      `no supplied diagnostic carries the ${JSON.stringify(input.horizon)} horizon, so no stress scenario can be built at it`,
      { horizon: input.horizon },
    );
  }
  return simulationOk(
    ownFrozenTree<MarkoutStressScenario>({
      basis: "STRESS_SCENARIO",
      scenarioName: input.scenarioName,
      horizon: input.horizon,
      replay,
      appliedPenalty: penalty,
      stressedNetCashFlow: subDecimal(replay.netCashFlow, penalty),
      note: STRESS_NOTE,
    }),
  );
}
