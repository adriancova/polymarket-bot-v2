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
import {
  ACTIVATION_PERMITTED_STATUS,
  isConsistentSettlementActivation,
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
  const lifecycle = effectiveLifecycleState(projection, input.asOf);
  const internalMarketId = projection.identity.internalMarketId;

  // --- lifecycle ----------------------------------------------------------
  switch (lifecycle) {
    case "DISCOVERED":
      refusals.push(
        universeRefusal("UNIVERSE_MARKET_NOT_OPEN", "the market has not opened", {
          internalMarketId,
          lifecycleState: lifecycle,
        }),
      );
      break;
    case "CLOSED":
      refusals.push(
        universeRefusal("UNIVERSE_MARKET_CLOSED", "the market's trading window has ended", {
          internalMarketId,
          closeInstant: effectiveCloseInstant(projection),
          asOf: input.asOf,
        }),
      );
      break;
    case "RESOLVED":
      refusals.push(
        universeRefusal("UNIVERSE_MARKET_RESOLVED", "the market has resolved", {
          internalMarketId,
          outcomeState: projection.outcomeState,
        }),
      );
      break;
    default:
      break;
  }
  const observationReady = lifecycle === "OPEN" || lifecycle === "CLOSING";

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
  const minimumSecondsToClose = input.policy?.minimumSecondsToClose;
  if (minimumSecondsToClose !== undefined) {
    const closeInstant = effectiveCloseInstant(projection);
    const closeMs = closeInstant === undefined ? undefined : instantMilliseconds(closeInstant);
    const asOfMs = instantMilliseconds(input.asOf);
    if (asOfMs === undefined) {
      refusals.push(
        universeRefusal("UNIVERSE_TIMESTAMP_INVALID", "`asOf` is not a parseable instant", {
          internalMarketId,
          asOf: input.asOf,
        }),
      );
    } else if (closeMs === undefined) {
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
  } else if (
    settlement.rulesVersionId !== undefined &&
    projection.rulesVersionId !== undefined &&
    settlement.rulesVersionId !== projection.rulesVersionId
  ) {
    // §6 invariant 9: a review of superseded rules is not a review of what is
    // trading now. This is the check that catches a rules change arriving after
    // a spec was signed.
    refusals.push(
      universeRefusal(
        "UNIVERSE_SETTLEMENT_RULES_VERSION_DRIFT",
        "the reviewed settlement spec names a different market rules version than the market is trading under",
        {
          internalMarketId,
          marketRulesVersionId: projection.rulesVersionId,
          specRulesVersionId: settlement.rulesVersionId,
        },
      ),
    );
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
