/**
 * Per-market eligibility and readiness — handoff §9.2.
 *
 * §9.2 gives the Universe Service two duties this module implements:
 *
 * > Reject model-dependent strategy activation on unverified settlement specs.
 * > Perform per-market eligibility and readiness checks.
 *
 * TWO ANSWERS, NOT ONE. `observationReady` says whether this market's data is
 * worth consuming at all; `modelDependentActivationAllowed` says whether a
 * strategy whose PnL depends on a payoff model may run on it. They are separate
 * because the safe default differs: watching an unreviewed market is harmless
 * and often necessary (you cannot review what you cannot see), while trading it
 * on an unverified payoff model produces "confident, wrong PnL" (ADR-009).
 *
 * EVERY refusal is returned, not the first, and each carries a stable code so an
 * operator sees the full list and a metric can label on it (§14.3).
 *
 * PURE: the "as of" instant is an argument. This module reads no clock, so the
 * same market and the same instant always produce the same verdict — the
 * property a replay depends on (§12.4).
 */

import type { IsoTimestamp } from "@polymarket-bot/domain";

import { universeRefusal, type UniverseRefusal } from "./errors.js";
import {
  effectiveCloseInstant,
  effectiveLifecycleState,
  type MarketProjection,
} from "./lifecycle.js";
import type { MarketLifecycleState } from "./lifecycle-state.js";
import { currentParameterVersion } from "./parameters.js";
import { isApprovedSeriesBinding, type SeriesDefinition } from "./series.js";
import { ownProjectionField } from "./state-door.js";
import {
  ACTIVATION_PERMITTED_STATUS,
  isConsistentSettlementActivation,
  permittedSettlementActivationProblems,
  type SettlementActivationView,
} from "./settlement-binding.js";
import { instantMilliseconds } from "./time.js";

/** Caller-owned thresholds. Everything here is optional and off by default. */
export interface MarketReadinessPolicy {
  /**
   * Refuse activation when fewer than this many seconds remain before the
   * scheduled close.
   *
   * A CALLER's number, not this package's: §13.2 puts entry and exit cutoffs in
   * strategy configuration, and a universal default here would silently
   * override it.
   */
  readonly minimumSecondsToClose?: number;
}

export interface MarketReadinessInput {
  /** The instant the question is asked "as of". Data, never a clock read. */
  readonly asOf: IsoTimestamp;
  /** The settlement layer's verdict for this market's series (see the port). */
  readonly settlement: SettlementActivationView;
  /** The series definition the market is bound to, when the caller resolved it. */
  readonly series?: SeriesDefinition | undefined;
  readonly policy?: MarketReadinessPolicy | undefined;
}

export interface MarketReadiness {
  readonly internalMarketId: string;
  /** Whether consuming this market's data is meaningful right now. */
  readonly observationReady: boolean;
  /** Whether a model-dependent strategy may be activated on it (§9.2). */
  readonly modelDependentActivationAllowed: boolean;
  readonly effectiveLifecycleState: MarketLifecycleState;
  /** Every reason activation is refused, in a stable order. */
  readonly refusals: readonly UniverseRefusal[];
}

/**
 * Evaluates one market's readiness.
 *
 * The result is deliberately conservative: activation requires EVERY condition
 * to hold, and any unparseable or missing input becomes a refusal rather than a
 * silently skipped check.
 */
export function evaluateMarketReadiness(
  projection: MarketProjection,
  input: MarketReadinessInput,
): MarketReadiness {
  const refusals: UniverseRefusal[] = [];
  const internalMarketId = projection.identity.internalMarketId;

  // --- the "as of" instant, validated FIRST (round-1 review, M2) ----------
  // Every downstream answer — the derived lifecycle state, the close cutoff —
  // is a function of this instant. An unparseable instant must not fall
  // through to the stored state (failing open); it makes the whole question
  // unanswerable, so the answer is a refusal with nothing else evaluated.
  const asOfMs = instantMilliseconds(input.asOf);
  if (asOfMs === undefined) {
    return Object.freeze({
      internalMarketId,
      observationReady: false,
      modelDependentActivationAllowed: false,
      effectiveLifecycleState: projection.lifecycleState,
      refusals: Object.freeze([
        universeRefusal(
          "UNIVERSE_TIMESTAMP_INVALID",
          "`asOf` is not a parseable instant; readiness cannot be evaluated",
          { internalMarketId, asOf: input.asOf },
        ),
      ]),
    });
  }

  const lifecycle = effectiveLifecycleState(projection, input.asOf);

  // --- lifecycle ----------------------------------------------------------
  if (lifecycle === "RESOLVED") {
    refusals.push(
      universeRefusal("UNIVERSE_MARKET_RESOLVED", "the market has resolved", {
        internalMarketId,
        outcomeState: projection.outcomeState,
      }),
    );
  } else {
    if (projection.lifecycleState === "DISCOVERED") {
      refusals.push(
        universeRefusal("UNIVERSE_MARKET_NOT_OPEN", "the market has not opened", {
          internalMarketId,
          lifecycleState: projection.lifecycleState,
        }),
      );
    }
    if (lifecycle === "CLOSED") {
      // Derived from the SCHEDULE, not observed from the venue (round-1
      // review, M3): no event asserts "trading has ended", so this refuses
      // NEW activation without claiming the market is closed as a fact.
      refusals.push(
        universeRefusal(
          "UNIVERSE_SCHEDULED_CLOSE_ELAPSED",
          "the market's scheduled close instant has elapsed; new activation is refused, but closure is not venue-confirmed",
          {
            internalMarketId,
            closeInstant: effectiveCloseInstant(projection),
            asOf: input.asOf,
          },
        ),
      );
    }
  }
  // Observability follows the EVENT-DRIVEN state, not the schedule (round-1
  // review, M3): a market the venue opened and has not resolved is still
  // producing data worth consuming even past its scheduled close — that is
  // precisely when a market holding an open position most needs watching.
  // The venue documents that trading stops at RESOLUTION; nothing observed
  // asserts it stopped at the schedule.
  const observationReady =
    projection.lifecycleState === "OPEN" || projection.lifecycleState === "CLOSING";

  // --- settlement state ---------------------------------------------------
  if (projection.outcomeState !== "PENDING") {
    // `PENDING_CLARIFICATION` and `DISPUTED` both mean the settlement question
    // is in motion. Neither determines a payoff, and the venue's clarification
    // path exists precisely to change how a market resolves after trading has
    // begun (resolution documentation, verified 2026-08-28), so a
    // model-dependent strategy must stop until a human re-reviews.
    refusals.push(
      universeRefusal(
        "UNIVERSE_OUTCOME_STATE_NOT_PENDING",
        `the market's settlement state is ${projection.outcomeState}`,
        {
          internalMarketId,
          outcomeState: projection.outcomeState,
          clarificationsAfterOpen: projection.clarifications.filter(
            (record) => record.afterOpen,
          ).length,
        },
      ),
    );
  }

  // --- series binding is configuration (§9.2) -----------------------------
  const binding = projection.seriesBinding;
  if (binding.kind === "UNBOUND") {
    refusals.push(
      universeRefusal(
        "UNIVERSE_SERIES_UNBOUND",
        "the market belongs to no series, so no reviewed settlement spec applies to it",
        { internalMarketId },
      ),
    );
  } else if (binding.kind === "SUGGESTED") {
    refusals.push(
      universeRefusal(
        "UNIVERSE_SERIES_BINDING_NOT_APPROVED",
        "the market's series binding is a suggestion; §9.2 forbids auto-approving a new market pattern for live trading",
        { internalMarketId, suggestedSeriesId: binding.seriesId, reasons: binding.reasons },
      ),
    );
  } else if (input.series !== undefined) {
    if (input.series.seriesId !== binding.seriesId) {
      refusals.push(
        universeRefusal(
          "UNIVERSE_SERIES_UNKNOWN",
          "the supplied series is not the one this market is bound to",
          {
            internalMarketId,
            boundSeriesId: binding.seriesId,
            suppliedSeriesId: input.series.seriesId,
          },
        ),
      );
    } else if (!input.series.active) {
      refusals.push(
        universeRefusal("UNIVERSE_SERIES_INACTIVE", "the series is not active", {
          internalMarketId,
          seriesId: input.series.seriesId,
        }),
      );
    } else if (!input.series.binding.approved) {
      refusals.push(
        universeRefusal(
          "UNIVERSE_SERIES_BINDING_NOT_APPROVED",
          "the series' own binding approval has been withdrawn",
          { internalMarketId, seriesId: input.series.seriesId },
        ),
      );
    }
  }

  // --- parameters ---------------------------------------------------------
  if (projection.parameters.versions.length === 0) {
    /* c8 ignore next 7 -- unreachable: registration always creates version 1. */
    refusals.push(
      universeRefusal("UNIVERSE_PARAMETERS_MISSING", "the market has no recorded parameters", {
        internalMarketId,
      }),
    );
  }

  // --- close cutoff -------------------------------------------------------
  // `asOf` was validated at the top of this function; `asOfMs` is defined.
  const minimumSecondsToClose = input.policy?.minimumSecondsToClose;
  if (minimumSecondsToClose !== undefined) {
    const closeInstant = effectiveCloseInstant(projection);
    const closeMs = closeInstant === undefined ? undefined : instantMilliseconds(closeInstant);
    if (closeMs === undefined) {
      // A cutoff policy with no close instant to measure against cannot be
      // evaluated; refusing is the safe direction.
      refusals.push(
        universeRefusal(
          "UNIVERSE_CLOSE_CUTOFF",
          "a minimum-time-to-close policy was supplied but the market announces no close instant",
          { internalMarketId, minimumSecondsToClose },
        ),
      );
    } else if (closeMs - asOfMs < minimumSecondsToClose * 1000) {
      refusals.push(
        universeRefusal(
          "UNIVERSE_CLOSE_CUTOFF",
          "too little time remains before the scheduled close",
          {
            internalMarketId,
            minimumSecondsToClose,
            secondsToClose: (closeMs - asOfMs) / 1000,
          },
        ),
      );
    }
  }

  // --- settlement activation (§9.2, acceptance 3) -------------------------
  // A verdict that claims to permit activation is CORRELATED, not believed
  // (round-1 review, H2): it must be internally consistent, complete, and
  // must name the SAME series, settlement spec, and rules version that this
  // market's own records name. Any missing or mismatched identity refuses.
  const settlement = input.settlement;
  if (!isConsistentSettlementActivation(settlement)) {
    refusals.push(
      universeRefusal(
        "UNIVERSE_SETTLEMENT_VERDICT_INCONSISTENT",
        "the settlement verdict's status and permission flag disagree; it is not trusted",
        {
          internalMarketId,
          status: settlement.status,
          modelDependentActivationAllowed: settlement.modelDependentActivationAllowed,
        },
      ),
    );
  } else if (settlement.status !== ACTIVATION_PERMITTED_STATUS) {
    refusals.push(
      universeRefusal(
        "UNIVERSE_SETTLEMENT_ACTIVATION_BLOCKED",
        `the settlement layer refused model-dependent activation: ${settlement.status}`,
        {
          internalMarketId,
          status: settlement.status,
          settlementSpecId: settlement.settlementSpecId,
          settlementRefusals: (settlement.refusals ?? []).map((refusal) => refusal.code),
        },
      ),
    );
  } else {
    const problems = permittedSettlementActivationProblems(settlement);
    if (problems.length > 0) {
      refusals.push(
        universeRefusal(
          "UNIVERSE_SETTLEMENT_VERDICT_INCOMPLETE",
          `the verdict claims to permit activation but cannot be correlated: ${problems
            .map((problem) => `${problem.field} — ${problem.problem}`)
            .join("; ")}`,
          { internalMarketId, problems },
        ),
      );
    } else {
      // The verdict is complete; now every identity it names must match the
      // market's own records.
      if (
        binding.kind === "APPROVED" &&
        settlement.seriesId !== binding.seriesId
      ) {
        refusals.push(
          universeRefusal(
            "UNIVERSE_SETTLEMENT_SERIES_MISMATCH",
            "the settlement verdict names a different series than the one this market is bound to",
            {
              internalMarketId,
              boundSeriesId: binding.seriesId,
              verdictSeriesId: settlement.seriesId,
            },
          ),
        );
      }
      if (input.series === undefined) {
        // Correlating the verdict's spec against the series' ACTIVE spec
        // requires the approved series definition; without it, the
        // correlation would be silently skipped, which is exactly the
        // fail-open H2 exploited.
        refusals.push(
          universeRefusal(
            "UNIVERSE_SERIES_DEFINITION_REQUIRED",
            "a permitted settlement verdict requires the approved series definition to correlate against; none was supplied",
            { internalMarketId, verdictSeriesId: settlement.seriesId },
          ),
        );
      } else {
        if (settlement.seriesId !== input.series.seriesId) {
          refusals.push(
            universeRefusal(
              "UNIVERSE_SETTLEMENT_SERIES_MISMATCH",
              "the settlement verdict names a different series than the supplied series definition",
              {
                internalMarketId,
                suppliedSeriesId: input.series.seriesId,
                verdictSeriesId: settlement.seriesId,
              },
            ),
          );
        } else if (input.series.activeSettlementSpecId === undefined) {
          refusals.push(
            universeRefusal(
              "UNIVERSE_SETTLEMENT_SPEC_MISMATCH",
              "the series binds no active settlement spec, so no verdict can be its review",
              { internalMarketId, seriesId: input.series.seriesId },
            ),
          );
        } else if (settlement.settlementSpecId !== input.series.activeSettlementSpecId) {
          refusals.push(
            universeRefusal(
              "UNIVERSE_SETTLEMENT_SPEC_MISMATCH",
              "the settlement verdict is for a different spec than the series' active settlement spec",
              {
                internalMarketId,
                activeSettlementSpecId: input.series.activeSettlementSpecId,
                verdictSettlementSpecId: settlement.settlementSpecId,
              },
            ),
          );
        }
      }
      // §6 invariant 9: a review of superseded rules is not a review of what
      // is trading now. Both sides are REQUIRED: an unknown market rules
      // version cannot confirm the review applies, so it fails closed.
      // An OWN read (`./state-door.ts`, `UNIV-3`). This is the SHARPEST cell of
      // the projection-side class: at base, in BOTH pollution variants, an
      // inherited `rulesVersionId` equal to the reviewed spec's turned
      // `modelDependentActivationAllowed: false` plus this very refusal into
      // `true` with NO refusals at all — §9.2's model-dependent activation
      // gate, opened by a value the projection never recorded.
      const marketRulesVersionId = ownProjectionField(projection, "rulesVersionId");
      if (marketRulesVersionId === undefined) {
        refusals.push(
          universeRefusal(
            "UNIVERSE_SETTLEMENT_RULES_VERSION_DRIFT",
            "the market's trading rules version is unknown, so the reviewed rules version cannot be confirmed to apply",
            { internalMarketId, specRulesVersionId: settlement.rulesVersionId },
          ),
        );
      } else if (settlement.rulesVersionId !== marketRulesVersionId) {
        refusals.push(
          universeRefusal(
            "UNIVERSE_SETTLEMENT_RULES_VERSION_DRIFT",
            "the reviewed settlement spec names a different market rules version than the market is trading under",
            {
              internalMarketId,
              marketRulesVersionId,
              specRulesVersionId: settlement.rulesVersionId,
            },
          ),
        );
      }
    }
  }

  return Object.freeze({
    internalMarketId,
    observationReady,
    modelDependentActivationAllowed: refusals.length === 0,
    effectiveLifecycleState: lifecycle,
    refusals: Object.freeze(refusals),
  });
}

/** The tick size and minimum order size in force, for a caller sizing an order. */
export function currentTradingParameters(
  projection: MarketProjection,
): { readonly tickSize: string; readonly minimumOrderSize: string } {
  const current = currentParameterVersion(projection.parameters);
  return {
    tickSize: current.parameters.tickSize,
    minimumOrderSize: current.parameters.minimumOrderSize,
  };
}

/** Whether the market is bound to a series a human approved. */
export function hasApprovedSeriesBinding(projection: MarketProjection): boolean {
  return isApprovedSeriesBinding(projection.seriesBinding);
}
