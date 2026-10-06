/**
 * `V2-3` item 7 (ADR-030 Amendment 2 rule 1, note of 2026-10-06, the
 * orchestrator's interim ruling for PAPER and BACKTEST; `V2-1`'s known risk
 * V21-FABLE-03): the judge's `NOT_YET_ADMISSIBLE`.
 *
 * - A `"v2"` window whose ACCEPTED `version` selects a `positionIds` that is
 *   absent or `null` — and that matches in every other respect — is neither
 *   admitted nor refused: the verdict names the cause a final refusal would,
 *   and the window's scheduled open (the gateway refuses it finally at or
 *   after that open; the gateway suite pins that part).
 * - Every other refusal reason stays a `REFUSE`, including beside missing ids.
 * - The hold is narrowed to `"v2"` (the orchestrator's interim ruling,
 *   2026-10-06; `V2-3` r3, I-1). A `"v1"` window's `clobTokenIds` read as
 *   `null` — absent, `null` or another type, which the series-window door
 *   reads alike — is a `REFUSE` at once, and the refusal names the narrowing.
 * - The ids, once filled, are judged in full: the admission is the one a
 *   window with its ids at first sight gets.
 *
 * Each `it` on a not-yet verdict fails at the base `51c0213`, whose judge
 * refuses all of these; the `"v1"` pin fails at `d2d0441`, which held it, and
 * at `15bcb4f`, whose refusal did not name the narrowing.
 */

import { describe, expect, it } from "vitest";

import {
  judgeSeriesWindow,
  parseReviewedSeries,
  selectTradingIds,
  windowInternalMarketId,
  type ClobMarketInfoReading,
  type GammaWindowEventReading,
  type GammaWindowMarketReading,
  type SeriesWindowVerdict,
} from "./series-admission.js";
import {
  PROTOCOL_V2_SAMPLES,
  protocolV2ClobOverrides,
  protocolV2WindowMarketOverrides,
  RECORDED_WINDOW,
  recordedClobReading,
  recordedWindowEventReading,
  recordedWindowMarketReading,
  reviewedBtc15mSeriesDocument,
} from "./testing/series-admission.js";

const [CANARY_UP, CANARY_DOWN] = PROTOCOL_V2_SAMPLES.canaryPositionIds;
const OPEN_MS = Date.parse(RECORDED_WINDOW.eventStartTime);

function reviewed(accepted: readonly string[]) {
  const document = reviewedBtc15mSeriesDocument();
  const parsed = parseReviewedSeries({ ...document, parameters: { ...(document["parameters"] as Record<string, unknown>), acceptedProtocolVersions: accepted } });
  if (!parsed.ok) throw new Error(parsed.issues.join("; "));
  return parsed;
}

function judgeV2(
  market: Partial<GammaWindowMarketReading> = {},
  clob: Partial<ClobMarketInfoReading> | null = {},
  accepted: readonly string[] = ["v1", "v2"],
  event: Partial<GammaWindowEventReading> = {},
): SeriesWindowVerdict {
  const { series, configHash } = reviewed(accepted);
  return judgeSeriesWindow(
    series,
    configHash,
    recordedWindowEventReading(event, protocolV2WindowMarketOverrides(market)),
    clob === null ? undefined : recordedClobReading(protocolV2ClobOverrides(clob)),
  );
}

function judgeV1(market: Partial<GammaWindowMarketReading> = {}, clob: Partial<ClobMarketInfoReading> | null = {}): SeriesWindowVerdict {
  const { series, configHash } = reviewed(["v1", "v2"]);
  return judgeSeriesWindow(series, configHash, recordedWindowEventReading({}, market), clob === null ? undefined : recordedClobReading(clob));
}

function refusal(verdict: SeriesWindowVerdict): string {
  expect(verdict.verdict).toBe("REFUSE");
  return verdict.verdict === "REFUSE" ? verdict.mismatches.join(" | ") : "";
}

describe("V2-3 item 7: ids not yet available are NOT YET ADMISSIBLE — not admitted, not refused", () => {
  for (const [name, positionIds] of [
    ["absent", { kind: "ABSENT" }],
    ["null", { kind: "NULL" }],
  ] as const) {
    it(`"v2" with positionIds ${name}: the verdict names the cause and carries the window's scheduled open`, () => {
      const verdict = judgeV2({ positionIds });
      expect(verdict).toEqual({
        verdict: "NOT_YET_ADMISSIBLE",
        mismatches: [
          `fact: Market.positionIds, the field Market.version "v2" selects, is ${name}: the window's ids are not yet available (F-40)`,
          `pairing: CLOB t[] is ${JSON.stringify([
            { tokenId: CANARY_UP, outcome: "Up" },
            { tokenId: CANARY_DOWN, outcome: "Down" },
          ])}, not Gamma's index pairing ${JSON.stringify([
            { tokenId: null, outcome: "Up" },
            { tokenId: null, outcome: "Down" },
          ])} (F-01, F-03)`,
        ],
        conditionId: PROTOCOL_V2_SAMPLES.canaryConditionId31,
        scheduledOpenAt: RECORDED_WINDOW.openAt,
        scheduledOpenEpochMs: OPEN_MS,
      });
    });
  }

  it('"v2" with positionIds null BESIDE a populated clobTokenIds: still not yet admissible — the other field never stands in', () => {
    const verdict = judgeV2({ positionIds: { kind: "NULL" }, clobTokenIds: JSON.stringify([RECORDED_WINDOW.yesTokenId, RECORDED_WINDOW.noTokenId]) });
    expect(verdict.verdict).toBe("NOT_YET_ADMISSIBLE");
    expect(JSON.stringify(verdict)).not.toContain(RECORDED_WINDOW.yesTokenId);
  });

  it('I-1 (the hold narrowed to "v2", 2026-10-06): "v1" with clobTokenIds read as null — absent, null OR another type — is REFUSED at once and for good, never held, and the refusal names the narrowing', () => {
    const verdict = judgeV1({ clobTokenIds: null, positionIds: { kind: "VALUE", value: [CANARY_UP, CANARY_DOWN] } });
    expect(verdict.verdict).toBe("REFUSE");
    expect(refusal(verdict)).toMatch(
      /Market\.clobTokenIds, the field Market\.version "v1" selects, is absent, null or not a string: the window's ids are not yet available \(F-40\) or unreadable; a "v1" window is refused at once and for good: the hold for ids not yet available is narrowed to "v2" \(ADR-030 Decision 1\.5; Amendment 2 rule 1, note of 2026-10-06, as narrowed by the orchestrator's interim ruling of 2026-10-06\)/u,
    );
    expect(JSON.stringify(verdict)).not.toContain(CANARY_UP);
  });

  it("selectTradingIds says when the ids are not yet available — and only then", () => {
    const v2 = (positionIds: GammaWindowMarketReading["positionIds"]) =>
      selectTradingIds(recordedWindowMarketReading(protocolV2WindowMarketOverrides({ positionIds })));
    expect(v2({ kind: "ABSENT" })).toMatchObject({ ok: false, version: "v2", idsNotYetAvailable: true });
    expect(v2({ kind: "NULL" })).toMatchObject({ ok: false, version: "v2", idsNotYetAvailable: true });
    for (const failed of [
      // I-1: the hold is narrowed to "v2"; "v1"'s null reading is never held.
      selectTradingIds(recordedWindowMarketReading({ clobTokenIds: null })),
      v2({ kind: "UNREADABLE", detail: "a string" }),
      v2({ kind: "VALUE", value: [CANARY_UP] }),
      v2({ kind: "VALUE", value: [CANARY_UP, CANARY_UP] }),
      v2({ kind: "VALUE", value: [`+${CANARY_UP}`, CANARY_DOWN] }),
      selectTradingIds(recordedWindowMarketReading({ clobTokenIds: '["1"]' })),
      selectTradingIds(recordedWindowMarketReading({ version: { kind: "NULL" } })),
      selectTradingIds(recordedWindowMarketReading({ version: { kind: "VALUE", value: "v3" } })),
    ]) {
      expect(failed).toMatchObject({ ok: false, idsNotYetAvailable: false });
    }
  });
});

describe("V2-3 item 7: every other refusal stays FINAL — alone, or beside ids not yet available", () => {
  it("other problems with the selected field: not an array, not two ids, not decimal, equal — each a REFUSE", () => {
    expect(refusal(judgeV2({ positionIds: { kind: "UNREADABLE", detail: "a string" } }))).toMatch(/is not an array of decimal strings/u);
    expect(refusal(judgeV2({ positionIds: { kind: "VALUE", value: [CANARY_UP] } }))).toMatch(/not exactly two position ids/u);
    expect(refusal(judgeV2({ positionIds: { kind: "VALUE", value: [`0${CANARY_UP}`, CANARY_DOWN] } }))).toMatch(/is not a canonical token id/u);
    expect(refusal(judgeV2({ positionIds: { kind: "VALUE", value: [CANARY_UP, CANARY_UP] } }))).toMatch(/the same id/u);
    expect(refusal(judgeV1({ clobTokenIds: "[1,2" }))).toMatch(/not a JSON array of exactly two token ids/u);
  });

  it("a missing, null or unknown version is refused, never not-yet-admissible", () => {
    expect(refusal(judgeV2({ version: { kind: "ABSENT" }, positionIds: { kind: "NULL" } }))).toMatch(/Market\.version is absent/u);
    expect(refusal(judgeV2({ version: { kind: "NULL" }, positionIds: { kind: "NULL" } }))).toMatch(/Market\.version is null/u);
    expect(refusal(judgeV2({ version: { kind: "VALUE", value: "v3" }, positionIds: { kind: "NULL" } }))).toMatch(/not a supported protocol version/u);
  });

  it("a version the review does not accept, with its ids missing: REFUSED, naming the reviewed list", () => {
    expect(refusal(judgeV2({ positionIds: { kind: "NULL" } }, {}, ["v1"]))).toMatch(/not one of the reviewed acceptedProtocolVersions \["v1"\]/u);
  });

  for (const [name, market, clob, event, pattern] of [
    ["the outcomes' labels", { outcomes: '["Yes", "No"]' }, {}, {}, /Market\.outcomes/u],
    ["the tick size", { orderPriceMinTickSize: { kind: "VALUE", value: "0.1" } }, {}, {}, /orderPriceMinTickSize/u],
    ["the fee rate", { feeSchedule: { rate: { kind: "VALUE", value: "0.08" }, exponent: { kind: "VALUE", value: "1" }, takerOnly: true, rebateRate: { kind: "VALUE", value: "0.2" } } }, {}, {}, /feeSchedule\.rate/u],
    ["the market's negRisk", { negRisk: true }, {}, {}, /Market\.negRisk/u],
    ["the CLOB t[] labels (swapped)", {}, { tokens: [{ tokenId: CANARY_DOWN, outcome: "Down" }, { tokenId: CANARY_UP, outcome: "Up" }] }, {}, /pairing: CLOB t\[\]/u],
    ["one CLOB t[] entry", {}, { tokens: [{ tokenId: CANARY_UP, outcome: "Up" }] }, {}, /pairing: CLOB t\[\]/u],
    ["the CLOB v cross-check", {}, { undocumentedProtocolVersion: { kind: "VALUE", value: "v1" } }, {}, /cross-check: CLOB v/u],
    ["the CLOB mos", {}, { minimumOrderSize: { kind: "VALUE", value: "10" } }, {}, /CLOB mos/u],
    ["the series id", {}, {}, { eventSeriesIds: ["99"] }, /Event\.series\[\]\.id/u],
    ["the schedule (a title that is not 900 s)", { question: "Bitcoin Up or Down - October 4, 6:15PM-6:45PM ET" }, {}, { eventTitle: "Bitcoin Up or Down - October 4, 6:15PM-6:45PM ET" }, /schedule:/u],
  ] as const) {
    it(`${name} differing beside positionIds null: REFUSED at once, naming both`, () => {
      const text = refusal(judgeV2({ ...market, positionIds: { kind: "NULL" } }, clob, ["v1", "v2"], event));
      expect(text).toMatch(pattern);
      expect(text).toMatch(/the window's ids are not yet available/u);
    });
  }

  it("no CLOB read beside positionIds null: REFUSED (the CLOB facts cannot be judged)", () => {
    expect(refusal(judgeV2({ positionIds: { kind: "NULL" } }, null))).toMatch(/no CLOB market-info read/u);
  });

  it("a condition id of another width beside positionIds null: REFUSED by rule 3", () => {
    expect(refusal(judgeV2({ positionIds: { kind: "NULL" }, conditionId: `${PROTOCOL_V2_SAMPLES.canaryConditionId31}0` }))).toMatch(/neither 31 bytes/u);
  });
});

describe("V2-3 item 7: ids that arrive are judged in full, as at first sight", () => {
  it("the same window with its ids filled is ADMITTED with exactly the facts a first-sight admission has", () => {
    const later = judgeV2();
    expect(later.verdict).toBe("ADMIT");
    if (later.verdict !== "ADMIT") return;
    expect(later.window).toMatchObject({
      internalMarketId: windowInternalMarketId(PROTOCOL_V2_SAMPLES.canaryConditionId31, OPEN_MS),
      conditionId: PROTOCOL_V2_SAMPLES.canaryConditionId31,
      yesTokenId: CANARY_UP,
      noTokenId: CANARY_DOWN,
      scheduledOpenAt: RECORDED_WINDOW.openAt,
      scheduledCloseAt: RECORDED_WINDOW.closeAt,
    });
    // The verdict is a function of the reading alone: no memory of the earlier judgement.
    expect(judgeV2()).toEqual(later);
  });
});
