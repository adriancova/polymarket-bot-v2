/**
 * Per-scope exposure limits — handoff §9.8 check 15 ("Per-order, per-market,
 * per-instance, per-series, per-underlying, and global limits pass").
 *
 * WORKPLAN ACCEPTANCE 1 ON THE RISK SIDE: open orders and positions BOTH
 * consume every limit. The allocator publishes each exposure entry as two
 * separate components; this module RECOMPUTES their sum rather than reading the
 * `combined` field the allocator also publishes. That is deliberate: the
 * derived field is convenient, but a limit check that trusted a peer's
 * arithmetic would pass a snapshot whose `combined` had drifted from its parts.
 *
 * FAIL CLOSED, three times over:
 *
 * - a configured cap with NO exposure snapshot supplied blocks
 *   (`RISK_EXPOSURE_SNAPSHOT_MISSING`) — an unmeasured limit is not a passed
 *   limit;
 * - a configured cap whose queried scope is ABSENT from the supplied snapshot
 *   blocks (`RISK_EXPOSURE_ENTRY_MISSING`) — see the next paragraph;
 * - a configured SCOPE cap (series, underlying, resolution window) for a market
 *   with no such attribution blocks (`RISK_SCOPE_KEY_MISSING`) — an
 *   unattributable request cannot be proven within the cap. This mirrors the
 *   allocator's `CAPITAL_SCOPE_KEY_MISSING`.
 *
 * AN ABSENT ENTRY IS UNKNOWN, NOT ZERO (review round 1, BLOCKER 2). This module
 * previously substituted `"0"` for a scope the supplied snapshot did not
 * mention, so a configured cap silently passed against unmeasured exposure —
 * a fail-open limit bypass. The peer's snapshot is not this package's data and
 * its gaps are not measurements of zero. A caller that means "this scope holds
 * nothing" must SAY so with an explicit zero entry; the allocator's
 * `exposureSnapshotCovering` builds exactly that snapshot for a declared key
 * set. Nothing here substitutes a permissive value for unknown peer data.
 */

import { addDecimal, compareDecimal } from "@polymarket-bot/decimal";
import type { MoneyString } from "@polymarket-bot/domain";

import type { ExposureEntryView, ExposureSnapshotView, ScopeAttribution } from "./inputs.js";
import type { RiskPolicy } from "./policy.js";
import type { RiskReasonCode } from "./reasons.js";
import { riskRefusal, type RiskRefusal } from "./result.js";

export interface ExposureProbe {
  readonly strategyInstanceId: string;
  /** Exact pUSD this intent adds, per market. */
  readonly perMarketContribution: ReadonlyMap<string, MoneyString>;
  /** Each touched market's §9.7 scope attribution, when the caller supplied one. */
  readonly scopeByMarket: ReadonlyMap<string, ScopeAttribution | undefined>;
  /** Σ of `perMarketContribution`. */
  readonly totalContribution: MoneyString;
}

type ScopeDimension = "bySeries" | "byUnderlying" | "byResolutionWindow";
type ScopeKeyField = keyof ScopeAttribution;

/**
 * Sum of an entry's two components. Never reads the peer's `combined`.
 *
 * TOTAL ON A PRESENT ENTRY ONLY. There is deliberately no `undefined` arm: the
 * absence of an entry is handled by {@link entryMissing} at each call site, so
 * this function cannot be the place a missing measurement becomes a zero.
 */
function committed(entry: ExposureEntryView): MoneyString {
  return addDecimal(entry.openOrderCommitted, entry.positionCommitted);
}

/**
 * The refusal for a configured cap whose queried scope the supplied snapshot
 * does not contain. An absent entry is UNKNOWN exposure, never zero exposure.
 */
function entryMissing(
  dimension: string,
  key: string | undefined,
  cap: MoneyString,
): RiskRefusal {
  return riskRefusal(
    "RISK_EXPOSURE_ENTRY_MISSING",
    `a ${dimension} exposure limit is configured but the supplied allocator snapshot carries no entry for this scope; an absent entry is unknown exposure, not zero exposure, so the cap cannot be shown to hold (fail closed — supply an explicit zero entry for every queried scope)`,
    { dimension, key, cap },
  );
}

function breach(
  code: RiskReasonCode,
  dimension: string,
  key: string | undefined,
  current: MoneyString,
  contribution: MoneyString,
  cap: MoneyString,
): RiskRefusal | undefined {
  const projected = addDecimal(current, contribution);
  if (compareDecimal(projected, cap) <= 0) return undefined;
  return riskRefusal(
    code,
    `projected committed exposure exceeds the ${dimension} limit (open orders and positions both consume it)`,
    { dimension, key, current, contribution, projected, cap },
  );
}

/**
 * Evaluates every configured limit in `limits` against `exposures`.
 *
 * Returns every breach, not the first: an operator reading a rejection wants
 * the full picture, and short-circuiting would hide a second limit that also
 * has to be raised before the intent could pass.
 */
export function checkExposureLimits(
  limits: RiskPolicy["limits"],
  exposures: ExposureSnapshotView | undefined,
  probe: ExposureProbe,
): readonly RiskRefusal[] {
  const configured = [
    limits.globalExposureCap,
    limits.perInstanceExposureCap,
    limits.perMarketExposureCap,
    limits.perSeriesExposureCap,
    limits.perUnderlyingExposureCap,
    limits.perResolutionWindowExposureCap,
  ].some((cap) => cap !== undefined);

  if (!configured) return [];

  if (exposures === undefined) {
    return [
      riskRefusal(
        "RISK_EXPOSURE_SNAPSHOT_MISSING",
        "an exposure limit is configured but no allocator exposure snapshot was supplied; an unmeasured limit is not a passed limit (fail closed)",
        {
          configuredLimits: Object.entries(limits)
            .filter(([, value]) => value !== undefined)
            .map(([name]) => name),
        },
      ),
    ];
  }

  const refusals: RiskRefusal[] = [];
  const push = (refusal: RiskRefusal | undefined): void => {
    if (refusal !== undefined) refusals.push(refusal);
  };

  // `global` is a REQUIRED field of `ExposureSnapshotViewSchema`, so a snapshot
  // that reached this point always carries it; there is no absent-global case
  // to substitute a zero for.
  if (limits.globalExposureCap !== undefined) {
    push(
      breach(
        "RISK_GLOBAL_EXPOSURE_EXCEEDED",
        "global",
        undefined,
        committed(exposures.global),
        probe.totalContribution,
        limits.globalExposureCap,
      ),
    );
  }

  if (limits.perInstanceExposureCap !== undefined) {
    const entry = exposures.byStrategyInstance[probe.strategyInstanceId];
    if (entry === undefined) {
      refusals.push(
        entryMissing(
          "strategy-instance",
          probe.strategyInstanceId,
          limits.perInstanceExposureCap,
        ),
      );
    } else {
      push(
        breach(
          "RISK_INSTANCE_EXPOSURE_EXCEEDED",
          "strategy-instance",
          probe.strategyInstanceId,
          committed(entry),
          probe.totalContribution,
          limits.perInstanceExposureCap,
        ),
      );
    }
  }

  if (limits.perMarketExposureCap !== undefined) {
    for (const [marketId, contribution] of probe.perMarketContribution) {
      const entry = exposures.byMarket[marketId];
      if (entry === undefined) {
        refusals.push(entryMissing("market", marketId, limits.perMarketExposureCap));
        continue;
      }
      push(
        breach(
          "RISK_MARKET_EXPOSURE_EXCEEDED",
          "market",
          marketId,
          committed(entry),
          contribution,
          limits.perMarketExposureCap,
        ),
      );
    }
  }

  const scopeChecks: readonly {
    readonly cap: MoneyString | undefined;
    readonly dimension: ScopeDimension;
    readonly field: ScopeKeyField;
    readonly label: string;
    readonly code: RiskReasonCode;
  }[] = [
    {
      cap: limits.perSeriesExposureCap,
      dimension: "bySeries",
      field: "seriesKey",
      label: "series",
      code: "RISK_SERIES_EXPOSURE_EXCEEDED",
    },
    {
      cap: limits.perUnderlyingExposureCap,
      dimension: "byUnderlying",
      field: "underlyingKey",
      label: "underlying",
      code: "RISK_UNDERLYING_EXPOSURE_EXCEEDED",
    },
    {
      cap: limits.perResolutionWindowExposureCap,
      dimension: "byResolutionWindow",
      field: "resolutionWindowKey",
      label: "resolution-window",
      code: "RISK_RESOLUTION_WINDOW_EXPOSURE_EXCEEDED",
    },
  ];

  for (const check of scopeChecks) {
    const cap = check.cap;
    if (cap === undefined) continue;
    // One intent may touch several markets in the same scope; their
    // contributions aggregate before the comparison.
    const contributionByKey = new Map<string, MoneyString>();
    for (const [marketId, contribution] of probe.perMarketContribution) {
      const key = probe.scopeByMarket.get(marketId)?.[check.field];
      if (key === undefined) {
        refusals.push(
          riskRefusal(
            "RISK_SCOPE_KEY_MISSING",
            `a ${check.label} exposure limit is configured but market ${marketId} carries no ${check.label} attribution (fail closed)`,
            { dimension: check.label, marketId, cap },
          ),
        );
        continue;
      }
      contributionByKey.set(key, addDecimal(contributionByKey.get(key) ?? "0", contribution));
    }
    const table = exposures[check.dimension];
    for (const [key, contribution] of contributionByKey) {
      const entry = table[key];
      if (entry === undefined) {
        refusals.push(entryMissing(check.label, key, cap));
        continue;
      }
      push(breach(check.code, check.label, key, committed(entry), contribution, cap));
    }
  }

  return refusals;
}
