/**
 * `ROLLOVER-1` (ADR-030 Decisions 1-2, acceptance 1-2): the reviewed series,
 * the exact-match judge, the run-mode guard and the admitted window's identity.
 *
 * Every refusal row removes or changes ONE fact of the recorded window
 * (`./testing/series-admission.ts`, S-G03 / S-K03a) and asserts the judge
 * refuses it, naming that fact — "each kind of mismatch" (ADR-030 Decision 5.2).
 */

import { Uuidv7Schema } from "@polymarket-bot/domain";
import { describe, expect, it } from "vitest";

import {
  admissionRunModeProblem,
  canonicalSeriesJson,
  judgeSeriesWindow,
  parseReviewedSeries,
  seriesConfigHash,
  windowInternalMarketId,
  type ClobMarketInfoReading,
  type GammaWindowEventReading,
  type GammaWindowMarketReading,
  type ReviewedSeries,
  type SeriesWindowVerdict,
} from "./series-admission.js";
import {
  BTC_15M_RULES_TEXT,
  RECORDED_WINDOW,
  recordedClobReading,
  recordedWindowEventReading,
  reviewedBtc15mSeriesDocument,
} from "./testing/series-admission.js";

function reviewed(): { readonly series: ReviewedSeries; readonly hash: string } {
  const parsed = parseReviewedSeries(reviewedBtc15mSeriesDocument());
  if (!parsed.ok) throw new Error(parsed.issues.join("; "));
  return { series: parsed.series, hash: parsed.configHash };
}

function judge(
  event: Partial<GammaWindowEventReading> = {},
  market: Partial<GammaWindowMarketReading> = {},
  clob: Partial<ClobMarketInfoReading> | null = {},
): SeriesWindowVerdict {
  const { series, hash } = reviewed();
  return judgeSeriesWindow(series, hash, recordedWindowEventReading(event, market), clob === null ? undefined : recordedClobReading(clob));
}

function refusedFor(verdict: SeriesWindowVerdict, pattern: RegExp): void {
  expect(verdict.verdict).toBe("REFUSE");
  if (verdict.verdict === "REFUSE") {
    expect(verdict.mismatches.join(" | ")).toMatch(pattern);
  }
}

describe("judgeSeriesWindow — a window that matches exactly is ADMITTED", () => {
  it("admits the recorded window with its per-window facts, YES first by Gamma's index pairing (F-01)", () => {
    const verdict = judge();
    expect(verdict.verdict).toBe("ADMIT");
    if (verdict.verdict !== "ADMIT") return;
    const { window } = verdict;
    expect(window.seriesId).toBe("btc-15m-updown");
    expect(window.seriesConfigHash).toBe(reviewed().hash);
    expect(window.conditionId).toBe(RECORDED_WINDOW.conditionId);
    expect(window.gammaEventId).toBe(RECORDED_WINDOW.eventId);
    expect(window.gammaMarketId).toBe(RECORDED_WINDOW.marketId);
    expect(window.yesTokenId).toBe(RECORDED_WINDOW.yesTokenId);
    expect(window.noTokenId).toBe(RECORDED_WINDOW.noTokenId);
    expect(window.scheduledOpenAt).toBe(RECORDED_WINDOW.openAt);
    expect(window.scheduledCloseAt).toBe(RECORDED_WINDOW.closeAt);
    expect(window.tickSize).toBe("0.001");
    expect(window.windowTitle).toBe(RECORDED_WINDOW.title);
    expect(window.internalMarketId).toBe(windowInternalMarketId(RECORDED_WINDOW.conditionId, Date.parse(RECORDED_WINDOW.openAt)));
  });

  it("admits the other recorded tick size (0.01) — tick size is per-window data inside the reviewed set (Q3)", () => {
    expect(judge({}, { orderPriceMinTickSize: { kind: "VALUE", value: "0.01" } }, { minimumTickSize: { kind: "VALUE", value: "0.01" } }).verdict).toBe("ADMIT");
  });

  it("reads an absent CLOB itode as false, as the venue documents (\"omitted when false\")", () => {
    const { series, hash } = reviewed();
    const noDelay: ReviewedSeries = {
      ...series,
      parameters: { ...series.parameters, tradingDelay: { ...series.parameters.tradingDelay, takerOrderDelayEnabled: false } },
    };
    const verdict = judgeSeriesWindow(noDelay, hash, recordedWindowEventReading(), recordedClobReading({ takerOrderDelayEnabled: "ABSENT" }));
    expect(verdict.verdict).toBe("ADMIT");
  });
});

describe("judgeSeriesWindow — every other window is REFUSED, naming what differs (acceptance 1)", () => {
  it("the pattern: another series id, another slug, two markets, a question that is not the title", () => {
    refusedFor(judge({ eventSeriesIds: ["10193"] }), /Event\.series\[\]\.id/u);
    refusedFor(judge({ eventSeriesIds: [] }), /reviewed series id/u);
    refusedFor(judge({ eventSeriesSlug: "eth-up-or-down-15m" }), /seriesSlug/u);
    refusedFor(judge({ eventSeriesSlug: null }), /seriesSlug/u);
    refusedFor(judge({ marketCount: 2 }), /exactly one market/u);
    refusedFor(judge({ marketCount: 0, market: null }), /exactly one market/u);
    refusedFor(judge({}, { question: "Bitcoin Up or Down - October 4, 6:30PM-6:45PM ET" }), /Market\.question/u);
  });

  it("the schedule: a title of another series, an ambiguous DST title, locators that disagree", () => {
    refusedFor(judge({ eventTitle: "Ethereum Up or Down - October 4, 6:15PM-6:30PM ET" }, { question: "Ethereum Up or Down - October 4, 6:15PM-6:30PM ET" }), /prefix/u);
    const dst = "Bitcoin Up or Down - November 1, 1:15AM-1:30AM ET";
    const ambiguous = judge({ eventTitle: dst }, { question: dst, eventStartTime: "2026-11-01T05:15:00Z", endDate: "2026-11-01T05:30:00Z" });
    refusedFor(ambiguous, /2 UTC intervals/u);
    if (ambiguous.verdict === "REFUSE") expect(ambiguous.scheduleAmbiguous).toBe(true);
    refusedFor(judge({}, { eventStartTime: "2026-10-04T22:16:00Z" }), /disagree/u);
    refusedFor(judge({}, { endDate: null }), /endDate/u);
  });

  it("the rules: another rules text, another resolution source, no rules text", () => {
    refusedFor(judge({}, { description: `${BTC_15M_RULES_TEXT} ` }), /sha256\(Market\.description\)/u);
    refusedFor(judge({}, { description: null }), /Market\.description is absent/u);
    refusedFor(judge({}, { resolutionSource: "https://data.chain.link/streams/btc-usd" }), /resolutionSource/u);
  });

  it("the outcomes: swapped, renamed, three, unreadable", () => {
    refusedFor(judge({}, { outcomes: '["Down", "Up"]' }), /Market\.outcomes/u);
    refusedFor(judge({}, { outcomes: '["Yes", "No"]' }), /Market\.outcomes/u);
    refusedFor(judge({}, { outcomes: '["Up", "Down", "Flat"]' }), /Market\.outcomes/u);
    refusedFor(judge({}, { outcomes: "Up,Down" }), /Market\.outcomes/u);
  });

  it("the tokens: one, three, duplicated, non-canonical, and a CLOB pairing that disagrees with Gamma's index pairing", () => {
    refusedFor(judge({}, { clobTokenIds: JSON.stringify([RECORDED_WINDOW.yesTokenId]) }), /exactly two/u);
    refusedFor(judge({}, { clobTokenIds: JSON.stringify([RECORDED_WINDOW.yesTokenId, RECORDED_WINDOW.yesTokenId]) }), /same token/u);
    refusedFor(judge({}, { clobTokenIds: JSON.stringify(["0123", RECORDED_WINDOW.noTokenId]) }), /canonical token id/u);
    refusedFor(judge({}, { clobTokenIds: null }), /clobTokenIds/u);
    refusedFor(
      judge({}, {}, {
        tokens: [
          { tokenId: RECORDED_WINDOW.noTokenId, outcome: "Up" },
          { tokenId: RECORDED_WINDOW.yesTokenId, outcome: "Down" },
        ],
      }),
      /pairing/u,
    );
    refusedFor(judge({}, {}, { tokens: null }), /pairing/u);
    refusedFor(judge({}, {}, null), /no CLOB market-info read/u);
  });

  it("the tick size: outside the reviewed set, absent, null, unreadable, or not what the CLOB states", () => {
    refusedFor(judge({}, { orderPriceMinTickSize: { kind: "VALUE", value: "0.0001" } }, { minimumTickSize: { kind: "VALUE", value: "0.0001" } }), /orderPriceMinTickSize/u);
    refusedFor(judge({}, { orderPriceMinTickSize: { kind: "ABSENT" } }), /orderPriceMinTickSize/u);
    refusedFor(judge({}, { orderPriceMinTickSize: { kind: "NULL" } }), /orderPriceMinTickSize/u);
    refusedFor(judge({}, { orderPriceMinTickSize: { kind: "UNREADABLE", detail: "1e-3" } }), /orderPriceMinTickSize/u);
    refusedFor(judge({}, {}, { minimumTickSize: { kind: "VALUE", value: "0.01" } }), /CLOB mts/u);
  });

  it("the minimum size, negRisk and fees, on both venue surfaces", () => {
    refusedFor(judge({}, { orderMinSize: { kind: "VALUE", value: "10" } }), /orderMinSize/u);
    refusedFor(judge({}, {}, { minimumOrderSize: { kind: "VALUE", value: "1" } }), /CLOB mos/u);
    refusedFor(judge({ eventNegRisk: true }), /negRisk/u);
    refusedFor(judge({ eventNegRisk: "ABSENT" }), /negRisk/u);
    refusedFor(judge({}, { feesEnabled: false }), /feesEnabled/u);
    refusedFor(judge({}, { feeSchedule: null }), /feeSchedule is absent/u);
    const schedule = recordedWindowEventReading().market?.feeSchedule;
    if (schedule === undefined || schedule === null) throw new Error("fixture");
    refusedFor(judge({}, { feeSchedule: { ...schedule, rate: { kind: "VALUE", value: "0.0625" } } }), /feeSchedule\.rate/u);
    refusedFor(judge({}, { feeSchedule: { ...schedule, exponent: { kind: "VALUE", value: "2" } } }), /feeSchedule\.exponent/u);
    refusedFor(judge({}, { feeSchedule: { ...schedule, takerOnly: false } }), /feeSchedule\.takerOnly/u);
    refusedFor(judge({}, { feeSchedule: { ...schedule, rebateRate: { kind: "VALUE", value: "0.25" } } }), /feeSchedule\.rebateRate/u);
    refusedFor(judge({}, { makerBaseFee: { kind: "VALUE", value: "0" } }), /Gamma makerBaseFee/u);
    refusedFor(judge({}, { takerBaseFee: { kind: "ABSENT" } }), /Gamma takerBaseFee/u);
    refusedFor(judge({}, {}, { makerBaseFee: { kind: "VALUE", value: "0" } }), /CLOB mbf/u);
    refusedFor(judge({}, {}, { takerBaseFee: { kind: "VALUE", value: "0" } }), /CLOB tbf/u);
    refusedFor(judge({}, {}, { fees: null }), /CLOB fd is absent/u);
    refusedFor(judge({}, {}, { fees: { rate: { kind: "VALUE", value: "0.07" }, exponent: { kind: "VALUE", value: "1" }, takerOnly: false } }), /fd\.to/u);
  });

  it("the trading delay: itode off, and a Gamma secondsDelay that is stated (C-16: never assume a length)", () => {
    refusedFor(judge({}, {}, { takerOrderDelayEnabled: false }), /itode/u);
    refusedFor(judge({}, {}, { takerOrderDelayEnabled: "ABSENT" }), /itode/u);
    refusedFor(judge({}, {}, { takerOrderDelayEnabled: "UNREADABLE" }), /itode/u);
    refusedFor(judge({}, { secondsDelay: { kind: "VALUE", value: "0" } }), /secondsDelay/u);
    refusedFor(judge({}, { secondsDelay: { kind: "VALUE", value: "1" } }), /secondsDelay/u);
    expect(judge({}, { secondsDelay: { kind: "NULL" } }).verdict).toBe("ADMIT");
  });

  it("the per-window facts, for presence and form only: the condition id, the Gamma market id, the event id", () => {
    refusedFor(judge({}, { conditionId: null }), /conditionId/u);
    refusedFor(judge({}, { conditionId: "" }), /conditionId/u);
    refusedFor(judge({}, { marketId: "abc" }), /Market\.id/u);
    refusedFor(judge({}, { marketId: null }), /Market\.id/u);
    refusedFor(judge({ eventId: null }), /event has no id/u);
  });

  it("names EVERY mismatch at once", () => {
    const verdict = judge({ eventSeriesSlug: "x", eventNegRisk: true }, { orderMinSize: { kind: "VALUE", value: "1" } });
    expect(verdict.verdict).toBe("REFUSE");
    if (verdict.verdict === "REFUSE") expect(verdict.mismatches.length).toBeGreaterThanOrEqual(3);
  });
});

describe("ROLLOVER-1 r5 (R5-ASTRA-01): negative-risk membership is judged on the MARKET (S-D23 lines 305, 313-315)", () => {
  /** The recorded review with `negRisk` set to `value`, parsed so its hash is its own. */
  function reviewedWith(value: boolean): { readonly series: ReviewedSeries; readonly hash: string } {
    const document = reviewedBtc15mSeriesDocument();
    const parameters = document["parameters"] as Record<string, unknown>;
    const parsed = parseReviewedSeries({ ...document, parameters: { ...parameters, negRisk: value } });
    if (!parsed.ok) throw new Error(parsed.issues.join("; "));
    return { series: parsed.series, hash: parsed.configHash };
  }

  function judgeUnder(
    reviewedNegRisk: boolean,
    eventNegRisk: GammaWindowEventReading["eventNegRisk"],
    marketNegRisk: GammaWindowMarketReading["negRisk"],
  ): SeriesWindowVerdict {
    const { series, hash } = reviewedWith(reviewedNegRisk);
    return judgeSeriesWindow(series, hash, recordedWindowEventReading({ eventNegRisk }, { negRisk: marketNegRisk }), recordedClobReading());
  }

  it("control: the recorded window (market false, event false, reviewed false) is ADMITTED", () => {
    expect(judgeUnder(false, false, false).verdict).toBe("ADMIT");
  });

  it("control: a review that accepts negRisk true admits a window whose market AND event both state true", () => {
    expect(judgeUnder(true, true, true).verdict).toBe("ADMIT");
  });

  it("a market whose OWN flag is true is REFUSED, although its event's flag matches the reviewed false", () => {
    const verdict = judgeUnder(false, false, true);
    refusedFor(verdict, /Gamma Market\.negRisk is true, not the reviewed false/u);
    if (verdict.verdict === "REFUSE") expect(verdict.mismatches.join(" | ")).not.toMatch(/Event\.negRisk/u);
  });

  it("a market flag that is absent, null or not a boolean is REFUSED: never defaulted, never filled from the event or the review", () => {
    refusedFor(judgeUnder(false, false, "ABSENT"), /Gamma Market\.negRisk is absent, not the reviewed false/u);
    refusedFor(judgeUnder(false, false, null), /Gamma Market\.negRisk is null, not the reviewed false/u);
    refusedFor(judgeUnder(false, false, "UNREADABLE"), /Gamma Market\.negRisk is unreadable, not the reviewed false/u);
    // Under a review of true, an event of true never vouches for a missing market flag.
    refusedFor(judgeUnder(true, true, "ABSENT"), /Gamma Market\.negRisk is absent, not the reviewed true/u);
    refusedFor(judgeUnder(true, true, null), /Gamma Market\.negRisk is null, not the reviewed true/u);
  });

  it("an event that contradicts its market is REFUSED, whichever of the two matches the review", () => {
    // The event differs from the review; the market matches it.
    refusedFor(judgeUnder(false, true, false), /Gamma Event\.negRisk is true, not the reviewed false/u);
    refusedFor(judgeUnder(true, false, true), /Gamma Event\.negRisk is false, not the reviewed true/u);
    // The market differs from the review; the event matches it.
    refusedFor(judgeUnder(false, false, true), /Gamma Market\.negRisk is true, not the reviewed false/u);
    refusedFor(judgeUnder(true, true, false), /Gamma Market\.negRisk is false, not the reviewed true/u);
  });

  it("a market AND event that agree with each other but not with the review are REFUSED, each named", () => {
    const verdict = judgeUnder(false, true, true);
    refusedFor(verdict, /Gamma Market\.negRisk is true/u);
    refusedFor(verdict, /Gamma Event\.negRisk is true/u);
  });
});

describe("parseReviewedSeries — the reviewed series is configuration, pinned by its hash", () => {
  it("parses the reviewed document and hashes its canonical JSON (key order is not a fact)", () => {
    const document = reviewedBtc15mSeriesDocument();
    const parsed = parseReviewedSeries(document);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.configHash).toMatch(/^[0-9a-f]{64}$/u);
    const reordered = Object.fromEntries(Object.entries(document).reverse());
    const again = parseReviewedSeries(reordered);
    expect(again.ok && again.configHash).toBe(parsed.configHash);
    const changed = parseReviewedSeries({ ...document, maximumConcurrentWindows: 3 });
    expect(changed.ok && changed.configHash).not.toBe(parsed.configHash);
    const canonical = canonicalSeriesJson(parsed.series);
    expect(canonical.ok).toBe(true);
    if (canonical.ok) expect(canonical.text.startsWith('{"maximumConcurrentWindows":2,"outcomes":["Up","Down"],')).toBe(true);
    const hashed = seriesConfigHash(parsed.series);
    expect(hashed.ok && hashed.hash).toBe(parsed.configHash);
  });

  it("refuses an unknown key, a missing field, a non-canonical decimal, another time zone", () => {
    const document = reviewedBtc15mSeriesDocument();
    expect(parseReviewedSeries({ ...document, approvedForLive: true }).ok).toBe(false);
    const withoutReview = { ...document };
    delete withoutReview["review"];
    expect(parseReviewedSeries(withoutReview).ok).toBe(false);
    const parameters = document["parameters"] as Record<string, unknown>;
    expect(parseReviewedSeries({ ...document, parameters: { ...parameters, minimumOrderSize: "5.0" } }).ok).toBe(false);
    expect(parseReviewedSeries({ ...document, parameters: { ...parameters, allowedTickSizes: [] } }).ok).toBe(false);
    const window = document["window"] as Record<string, unknown>;
    expect(parseReviewedSeries({ ...document, window: { ...window, titleTimeZone: "UTC" } }).ok).toBe(false);
  });

  it("refuses, and never throws on, a document whose property is a getter", () => {
    const document = reviewedBtc15mSeriesDocument();
    Object.defineProperty(document, "seriesId", {
      enumerable: true,
      get: () => {
        throw new Error("GETTER");
      },
    });
    expect(() => parseReviewedSeries(document)).not.toThrow();
    expect(parseReviewedSeries(document).ok).toBe(false);
  });
});

describe("admissionRunModeProblem — PAPER or BACKTEST only (ADR-030 Decision 2.1; acceptance 2)", () => {
  it("admits PAPER and BACKTEST and refuses every other mode, and anything unreadable", () => {
    expect(admissionRunModeProblem("PAPER")).toBeUndefined();
    expect(admissionRunModeProblem("BACKTEST")).toBeUndefined();
    for (const mode of ["SHADOW", "EXECUTION_PROBE", "LIVE_MICRO", "LIVE", "paper", "", undefined, null, 1, { mode: "PAPER" }]) {
      expect(admissionRunModeProblem(mode), String(mode)).toMatch(/refuses to start/u);
    }
  });
});

describe("windowInternalMarketId — a derived UUIDv7, the same everywhere", () => {
  it("is a valid UUIDv7 whose timestamp is the scheduled open, deterministic per condition id", () => {
    const openMs = Date.parse(RECORDED_WINDOW.openAt);
    const id = windowInternalMarketId(RECORDED_WINDOW.conditionId, openMs);
    expect(id).toBeDefined();
    expect(Uuidv7Schema.safeParse(id).success).toBe(true);
    expect(id).toBe(windowInternalMarketId(RECORDED_WINDOW.conditionId, openMs));
    expect(parseInt((id ?? "").replace(/-/gu, "").slice(0, 12), 16)).toBe(openMs);
    expect(windowInternalMarketId(`${RECORDED_WINDOW.conditionId}0`, openMs)).not.toBe(id);
    expect(windowInternalMarketId(RECORDED_WINDOW.conditionId, -1)).toBeUndefined();
    expect(windowInternalMarketId(RECORDED_WINDOW.conditionId, 2 ** 48)).toBeUndefined();
  });
});
