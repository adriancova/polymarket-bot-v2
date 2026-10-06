/**
 * `ROLLOVER-1` test samples for the trader's series admissions: a reviewed
 * `btc-15m-updown` series document and three windows of it, with the two
 * admission payloads the gateway publishes for each.
 *
 * The WINDOWS are recorded venue data: the first three events of VENUE-SETL-1's
 * S-G03 keyset page (`docs/venue/verified-2026-10-04.md`;
 * `test/contract/polymarket-public/fixtures/series-window.json`) — titles,
 * condition ids, token ids in Gamma's outcome order (index 0 "Up"), and the
 * tick sizes the CLOB reported (S-K03a 0.001, S-K04a 0.01; the 22:45 window's
 * 0.01 is the Gamma value of the same page).
 *
 * The DOCUMENT is the same sample review `@polymarket-bot/universe/testing`'s
 * `reviewedBtc15mSeriesDocument()` states — the paper-trader suite's
 * `rollover-1-series-mirror.test.ts` holds the two deep-equal — and is sample
 * configuration, not a venue fact.
 */

import { windowInternalMarketId } from "../series.js";

/** The recorded rules text's sha256 (F-22; `@polymarket-bot/universe/testing` `BTC_15M_RULES_SHA256`). */
const BTC_15M_RULES_SHA256 = "485ceb1dabc4aa12fb42c76184563b7378f01e5de9ded73df049c0d191cd5ad1";

/** One recorded window of the series, as its admission states it. */
export interface RecordedSeriesWindow {
  readonly title: string;
  readonly conditionId: string;
  readonly yesTokenId: string;
  readonly noTokenId: string;
  readonly openAt: string;
  readonly closeAt: string;
  readonly tickSize: string;
  /** The derived internal id (`windowInternalMarketId`). */
  readonly marketId: string;
}

function recorded(window: Omit<RecordedSeriesWindow, "marketId">): RecordedSeriesWindow {
  const marketId = windowInternalMarketId(window.conditionId, Date.parse(window.openAt));
  if (marketId === undefined) throw new Error(`the sample window ${window.title} has no derived id`);
  return Object.freeze({ ...window, marketId });
}

/** The first three windows of the S-G03 page, in schedule order. */
export const RECORDED_SERIES_WINDOWS: readonly [RecordedSeriesWindow, RecordedSeriesWindow, RecordedSeriesWindow] = [
  recorded({
    title: "Bitcoin Up or Down - October 4, 6:15PM-6:30PM ET",
    conditionId: "0x5e196ca7c84c54fb1482ca206df477bba1fb3d8c813580c3838186cedde32b29",
    yesTokenId: "82133233861314798028087473521332912369939570267929634486524845895982963276831",
    noTokenId: "77032538501070316350656311299825606177844598103814694895686056289307323150761",
    openAt: "2026-10-04T22:15:00.000Z",
    closeAt: "2026-10-04T22:30:00.000Z",
    tickSize: "0.001",
  }),
  recorded({
    title: "Bitcoin Up or Down - October 4, 6:30PM-6:45PM ET",
    conditionId: "0xf59bf1fe624a6f54cc4c8bcb08d077558a241a6a8050e2b729cfaa350a7c7bdc",
    yesTokenId: "28102873104420659727719004083961103866333312520675837829099603614881599190203",
    noTokenId: "12231147712917489193781763889175813105415311804974034851807200316222295637108",
    openAt: "2026-10-04T22:30:00.000Z",
    closeAt: "2026-10-04T22:45:00.000Z",
    tickSize: "0.01",
  }),
  recorded({
    title: "Bitcoin Up or Down - October 4, 6:45PM-7:00PM ET",
    conditionId: "0x80aa9fdda035d5f116a980bff5078e6c574537cdf8c7426ab39ad9365c161a16",
    yesTokenId: "56231418432754284794387971021174711527554994494635197869274245457644906431518",
    noTokenId: "28178481876484501258595930824830290197604587066109160511736258613937803625049",
    openAt: "2026-10-04T22:45:00.000Z",
    closeAt: "2026-10-04T23:00:00.000Z",
    tickSize: "0.01",
  }),
];

/** A reviewed `btc-15m-updown` series document, as configuration states it (sample review). */
export function reviewedSeriesDocument(): Record<string, unknown> {
  return {
    seriesId: "btc-15m-updown",
    review: {
      reviewedBy: "sample-reviewer",
      reviewedAt: "2026-10-04T23:00:00Z",
      reference: "docs/venue/verified-2026-10-04.md",
    },
    venue: { gammaSeriesId: "10192", seriesSlug: "btc-up-or-down-15m" },
    window: {
      titlePrefix: "Bitcoin Up or Down - ",
      titleTimeZone: "America/New_York",
      titleZoneLabel: "ET",
      durationSeconds: 900,
    },
    rules: {
      descriptionSha256: BTC_15M_RULES_SHA256,
      resolutionSource: "https://data.chain.link/streams/btc-usd-twap-60s-streams",
    },
    outcomes: ["Up", "Down"],
    parameters: {
      // ADR-030 Amendment 2 rule 2: V1 windows only, as the gateway's sample
      // review (`@polymarket-bot/universe/testing`) states it.
      acceptedProtocolVersions: ["v1"],
      allowedTickSizes: ["0.01", "0.001"],
      minimumOrderSize: "5",
      negRisk: false,
      fees: {
        feesEnabled: true,
        rate: "0.07",
        exponent: "1",
        takerOnly: true,
        rebateRate: "0.2",
        makerBaseFee: "1000",
        takerBaseFee: "1000",
      },
      tradingDelay: { takerOrderDelayEnabled: true, gammaSecondsDelay: "NOT_STATED" },
      catalogTradingDelaySeconds: 0,
    },
    settlement: { specRef: "btc-15m-updown", modelDependentActivationAllowed: false },
    trading: {
      makerFeeRate: "0",
      takerFeeRate: "0",
      seriesKey: "btc-15m-updown",
      underlyingKey: "btc.usd",
      resolutionWindowKey: "btc-15m-window",
    },
    maximumConcurrentWindows: 2,
    unresolvedTeardownSeconds: 3600,
  };
}

/**
 * The `MarketDiscovered@1` and `SeriesWindowAdmitted@1` payloads the gateway
 * publishes for `window` (`apps/data-gateway` `admissionPayloads`), under the
 * review hash `seriesConfigHash`.
 */
export function seriesWindowPayloads(
  window: RecordedSeriesWindow,
  seriesConfigHash: string,
  seriesId = "btc-15m-updown",
): { readonly discovered: Record<string, unknown>; readonly admitted: Record<string, unknown> } {
  return {
    discovered: {
      internalMarketId: window.marketId,
      conditionId: window.conditionId,
      yesTokenId: window.yesTokenId,
      noTokenId: window.noTokenId,
      seriesId,
      metadataVersion: 1,
    },
    admitted: {
      internalMarketId: window.marketId,
      conditionId: window.conditionId,
      seriesId,
      seriesConfigHash,
      yesTokenId: window.yesTokenId,
      noTokenId: window.noTokenId,
      scheduledOpenAt: window.openAt,
      scheduledCloseAt: window.closeAt,
      tickSize: window.tickSize,
      windowTitle: window.title,
    },
  };
}
