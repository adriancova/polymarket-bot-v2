/**
 * Deterministic samples for tests.
 *
 * Exported as a subpath (`@polymarket-bot/universe/testing`) so this package's
 * tests and a composition root's tests build the same shapes. Every identifier
 * is a fixed literal: nothing here generates a UUID, reads a clock, or depends
 * on ordering between test files.
 *
 * NOTHING HERE IS A VENUE FACT. The condition id, token ids, slug, and title are
 * invented sample values.
 */

import type { MarketIdentity } from "../identity.js";
import type { ParameterObservation } from "../parameters.js";
import type { SeriesDefinition } from "../series.js";
import type {
  SettlementActivationView,
  UnvalidatedSettlementActivationView,
} from "../settlement-binding.js";

export const SAMPLE_MARKET_ID = "01936f00-0000-7000-8000-00000000d001";
export const SAMPLE_SERIES_ID = "01936f00-0000-7000-8000-00000000a001";
export const SAMPLE_RULES_VERSION_ID = "01936f00-0000-7000-8000-00000000b001";
export const SAMPLE_SETTLEMENT_SPEC_ID = "01936f00-0000-7000-8000-00000000c001";

/** A sample market identity. */
export function marketIdentitySample(): MarketIdentity {
  return {
    internalMarketId: SAMPLE_MARKET_ID,
    conditionId: "0x00000000000000000000000000000000000000000000000000000000000000a1",
    venueEventId: "event-btc-15m-updown",
    venueMarketSlug: "btc-15m-updown-2026-08-28-1200",
    yesTokenId: "1000000001",
    noTokenId: "1000000002",
    questionTitle: "Will BTC be up at the close of this 15-minute window?",
  };
}

/** A sample first parameter observation. */
export function parameterObservationSample(): ParameterObservation {
  return {
    parameters: {
      tickSize: "0.01",
      minimumOrderSize: "5",
      negRisk: false,
      tradingDelaySeconds: 0,
      feeScheduleRef: "fee-schedule-2026-08-28",
      openTime: "2026-08-28T12:00:00Z",
      closeTime: "2026-08-28T12:15:00Z",
      status: "DISCOVERED",
    },
    observedAt: "2026-08-28T11:59:00Z",
    source: "polymarket",
  };
}

/** A sample series, unapproved by default (§9.2). */
export function seriesDefinitionSample(): SeriesDefinition {
  return {
    seriesId: SAMPLE_SERIES_ID,
    seriesKey: "btc-15m-updown",
    displayName: "BTC 15-minute up/down (example)",
    underlyingSymbol: "btc.usd",
    cadence: "PT15M",
    description: "Example rolling series; membership and settlement are unreviewed.",
    binding: { approved: false },
    activeSettlementSpecId: SAMPLE_SETTLEMENT_SPEC_ID,
    active: true,
  };
}

/**
 * A settlement verdict that permits activation.
 *
 * The cast is DELIBERATE and test-only: adversarial tests use `overrides` to
 * build verdicts a compliant producer could never emit (an inconsistent flag,
 * a blocked status with permitted fields), which is exactly what the runtime
 * checks must refuse.
 */
export function permittingSettlementView(
  overrides: Partial<UnvalidatedSettlementActivationView> = {},
): SettlementActivationView {
  return {
    status: "REVIEWED_MODEL_BACKED",
    modelDependentActivationAllowed: true,
    settlementSpecId: SAMPLE_SETTLEMENT_SPEC_ID,
    seriesId: SAMPLE_SERIES_ID,
    rulesVersionId: SAMPLE_RULES_VERSION_ID,
    payoffModel: "ReferenceOpenUpDownModel",
    refusals: [],
    ...overrides,
  } as SettlementActivationView;
}

/** A settlement verdict that blocks activation because nobody reviewed the spec. */
export function unverifiedSettlementView(): SettlementActivationView {
  return {
    status: "SPEC_UNVERIFIED",
    modelDependentActivationAllowed: false,
    settlementSpecId: SAMPLE_SETTLEMENT_SPEC_ID,
    seriesId: SAMPLE_SERIES_ID,
    refusals: [
      {
        code: "SETTLEMENT_SPEC_UNVERIFIED",
        message: "the settlement spec carries no verified_by/verified_at",
      },
    ],
  };
}

export {
  BTC_15M_RULES_SHA256,
  BTC_15M_RULES_TEXT,
  PROTOCOL_V2_SAMPLES,
  protocolV2ClobOverrides,
  protocolV2WindowMarketOverrides,
  RECORDED_WINDOW,
  recordedClobReading,
  recordedWindowEventReading,
  recordedWindowMarketReading,
  reviewedBtc15mSeriesDocument,
} from "./series-admission.js";
