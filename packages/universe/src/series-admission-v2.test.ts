/**
 * `V2-1` (ADR-030 Amendment 2, rules 1-3; `docs/venue/protocol-v2-migration-plan.md`
 * package `V2-1`, rows A1, A2, A4-A7, D4): the judge under Polymarket
 * Protocol V2.
 *
 * - **Selection (acceptance 1):** a window's trading ids come from the field
 *   its Gamma `Market.version` selects — `positionIds` for `"v2"`, the decoded
 *   `clobTokenIds` for `"v1"` — "even when both fields are present" (F-38,
 *   F-40). The other field is never read as an id.
 * - **Refusals by name (acceptance 2):** each case below asserts the judge
 *   refuses AND names the cause.
 * - **The review (acceptance 4):** `parameters.acceptedProtocolVersions` is
 *   required, reviewed and hashed; a window whose version it does not list is
 *   refused.
 * - **The condition width (acceptance 5):** `paddedConditionId` pads a 31-byte
 *   id, keeps a 32-byte one, and refuses any other; the judge refuses such an
 *   id by name. Gamma's text stays the identity.
 * - **CLOB `v` (acceptance 8):** a refusal-only cross-check — present and
 *   equal admits, present and different refuses, absent refuses nothing.
 *
 * The V2 window is the recorded window (`./testing/series-admission.ts`) in
 * the documented example's shape with the canary's observed ids
 * (`PROTOCOL_V2_SAMPLES`): no V2 market of our series has been observed on
 * Gamma (U-36).
 */

import { describe, expect, it } from "vitest";

import {
  ACCEPTED_PROTOCOL_VERSIONS_REQUIRED,
  isProtocolVersion,
  judgeSeriesWindow,
  paddedConditionId,
  parseReviewedSeries,
  PROTOCOL_VERSIONS,
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

/** The sample review's hash with `["v1"]`, and with `["v1","v2"]` — the trader's mirror pins the same two (`@polymarket-bot/trading-core` `series.test.ts`). */
const SAMPLE_REVIEW_HASH_V1 = "27a746ce86cb3329920762611f47e7557a188a4a545ad991b0594333a7fcb759";
const SAMPLE_REVIEW_HASH_V1_V2 = "f833fbbca4aaf9c15f0025c041f80471f49aabff0b0979224c4e11518d2beb97";

const [CANARY_UP, CANARY_DOWN] = PROTOCOL_V2_SAMPLES.canaryPositionIds;

function reviewDocument(accepted: unknown): Record<string, unknown> {
  const document = reviewedBtc15mSeriesDocument();
  return { ...document, parameters: { ...(document["parameters"] as Record<string, unknown>), acceptedProtocolVersions: accepted } };
}

function reviewed(accepted: readonly string[] = ["v1", "v2"]) {
  const parsed = parseReviewedSeries(reviewDocument(accepted));
  if (!parsed.ok) throw new Error(parsed.issues.join("; "));
  return parsed;
}

/** Judges the V2 window (or the V1 window with `version: "v1"` overrides) under a review accepting `accepted`. */
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

function judgeV1(
  market: Partial<GammaWindowMarketReading> = {},
  clob: Partial<ClobMarketInfoReading> | null = {},
  accepted: readonly string[] = ["v1"],
): SeriesWindowVerdict {
  const { series, configHash } = reviewed(accepted);
  return judgeSeriesWindow(series, configHash, recordedWindowEventReading({}, market), clob === null ? undefined : recordedClobReading(clob));
}

function admitted(verdict: SeriesWindowVerdict) {
  if (verdict.verdict !== "ADMIT") throw new Error(`expected ADMIT, got ${JSON.stringify(verdict)}`);
  return verdict.window;
}

function refusedFor(verdict: SeriesWindowVerdict, pattern: RegExp): void {
  expect(verdict.verdict).toBe("REFUSE");
  if (verdict.verdict === "REFUSE") expect(verdict.mismatches.join(" | ")).toMatch(pattern);
}

/**
 * `V2-3` item 7 (ADR-030 Amendment 2 rule 1, note of 2026-10-06): a window
 * whose ONLY problem is that its selected id field is absent or `null` is not
 * refused but NOT YET ADMISSIBLE — naming the same cause its final refusal
 * would (`./series-admission-not-yet.test.ts` pins the verdict in full).
 */
function notYetFor(verdict: SeriesWindowVerdict, pattern: RegExp): void {
  expect(verdict.verdict).toBe("NOT_YET_ADMISSIBLE");
  if (verdict.verdict === "NOT_YET_ADMISSIBLE") expect(verdict.mismatches.join(" | ")).toMatch(pattern);
}

describe("V2-1 acceptance 1: the trading ids are selected by Market.version (F-38, F-40)", () => {
  it('"v2" selects positionIds: the V2 window is ADMITTED with the position ids, index 0 YES', () => {
    const window = admitted(judgeV2());
    expect(window.yesTokenId).toBe(CANARY_UP);
    expect(window.noTokenId).toBe(CANARY_DOWN);
  });

  it('"v2" selects positionIds EVEN WHEN clobTokenIds is populated: the CTF ids are never admitted, nor read', () => {
    const ctf = JSON.stringify([RECORDED_WINDOW.yesTokenId, RECORDED_WINDOW.noTokenId]);
    const window = admitted(judgeV2({ clobTokenIds: ctf }));
    expect([window.yesTokenId, window.noTokenId]).toEqual([CANARY_UP, CANARY_DOWN]);
    expect(JSON.stringify(window)).not.toContain(RECORDED_WINDOW.yesTokenId);
    // Never read as ids: a malformed clobTokenIds on a V2 market refuses nothing.
    expect(judgeV2({ clobTokenIds: '["x"' }).verdict).toBe("ADMIT");
  });

  it('"v1" selects the DECODED clobTokenIds even when positionIds is populated: the position ids are never admitted, nor read', () => {
    const window = admitted(judgeV1({ positionIds: { kind: "VALUE", value: [CANARY_UP, CANARY_DOWN] } }));
    expect([window.yesTokenId, window.noTokenId]).toEqual([RECORDED_WINDOW.yesTokenId, RECORDED_WINDOW.noTokenId]);
    expect(JSON.stringify(window)).not.toContain(CANARY_UP);
    expect(judgeV1({ positionIds: { kind: "UNREADABLE", detail: "a string" } }).verdict).toBe("ADMIT");
  });

  it("selectTradingIds names the field it read, and the documented example's ids (S-D16) are selected as given", () => {
    const [up, down] = PROTOCOL_V2_SAMPLES.documentedPositionIds;
    const selection = selectTradingIds(
      recordedWindowMarketReading({ version: { kind: "VALUE", value: "v2" }, clobTokenIds: null, positionIds: { kind: "VALUE", value: [up, down] } }),
    );
    expect(selection).toEqual({ ok: true, version: "v2", field: "positionIds", yesTokenId: up, noTokenId: down });
    expect(selectTradingIds(recordedWindowMarketReading())).toEqual({
      ok: true,
      version: "v1",
      field: "clobTokenIds",
      yesTokenId: RECORDED_WINDOW.yesTokenId,
      noTokenId: RECORDED_WINDOW.noTokenId,
    });
  });

  it("the protocol versions are exactly \"v1\" and \"v2\", case and spelling included", () => {
    expect(PROTOCOL_VERSIONS).toEqual(["v1", "v2"]);
    for (const value of ["v1", "v2"]) expect(isProtocolVersion(value)).toBe(true);
    for (const value of ["V1", "V2", "v3", "v0", "1", "2", "", " v2", "v2 ", null, undefined, 2]) expect(isProtocolVersion(value)).toBe(false);
  });
});

describe("V2-1 acceptance 2: each unclear window is REFUSED, by name", () => {
  it("a missing, null or non-string Market.version", () => {
    refusedFor(judgeV2({ version: { kind: "ABSENT" } }), /Market\.version is absent; the trading ids are chosen by the version, and a missing version is refused/u);
    refusedFor(judgeV2({ version: { kind: "NULL" } }), /Market\.version is null; the trading ids are chosen by the version/u);
    refusedFor(judgeV2({ version: { kind: "UNREADABLE", detail: "a number" } }), /Market\.version is not of its documented type \(a number\)/u);
  });

  it('an unsupported version: "v3", "V2", "", " v2", "v0" — never guessed from the fields present', () => {
    for (const value of ["v3", "V2", "", " v2", "v0", "2"]) {
      refusedFor(judgeV2({ version: { kind: "VALUE", value } }), new RegExp(`Market\\.version is ${JSON.stringify(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}, not a supported protocol version`, "u"));
    }
  });

  it('"v2" with positionIds absent or null: "the IDs are not yet available" (F-40) — never a fall-back to clobTokenIds (since V2-3 item 7: not yet admissible, never admitted)', () => {
    const ctf = JSON.stringify([RECORDED_WINDOW.yesTokenId, RECORDED_WINDOW.noTokenId]);
    notYetFor(judgeV2({ positionIds: { kind: "ABSENT" }, clobTokenIds: ctf }), /Market\.positionIds, the field Market\.version "v2" selects, is absent: the window's ids are not yet available \(F-40\)/u);
    notYetFor(judgeV2({ positionIds: { kind: "NULL" }, clobTokenIds: ctf }), /Market\.positionIds, the field Market\.version "v2" selects, is null: the window's ids are not yet available \(F-40\)/u);
  });

  it('"v2" with positionIds that is not an array — a JSON-encoded string, an object', () => {
    refusedFor(judgeV2({ positionIds: { kind: "UNREADABLE", detail: "a string" } }), /Market\.positionIds, the field Market\.version "v2" selects, is not an array of decimal strings \(a string/u);
    refusedFor(judgeV2({ positionIds: { kind: "UNREADABLE", detail: "an object" } }), /is not an array of decimal strings \(an object/u);
  });

  it('"v1" with clobTokenIds absent, null or not a string: not yet available — never a fall-back to positionIds (V2-3: still refused at once and for good — the hold for ids not yet available is narrowed to "v2")', () => {
    refusedFor(
      judgeV1({ clobTokenIds: null, positionIds: { kind: "VALUE", value: [CANARY_UP, CANARY_DOWN] } }),
      /Market\.clobTokenIds, the field Market\.version "v1" selects, is absent, null or not a string: the window's ids are not yet available \(F-40\)/u,
    );
  });

  it("not exactly two ids: none, one, three — for either field", () => {
    for (const ids of [[], [CANARY_UP], [CANARY_UP, CANARY_DOWN, CANARY_DOWN]]) {
      refusedFor(judgeV2({ positionIds: { kind: "VALUE", value: ids } }), /Market\.positionIds is .*, not exactly two position ids/u);
    }
    refusedFor(judgeV1({ clobTokenIds: JSON.stringify([RECORDED_WINDOW.yesTokenId]) }), /not a JSON array of exactly two token ids/u);
    refusedFor(judgeV1({ clobTokenIds: JSON.stringify([RECORDED_WINDOW.yesTokenId, RECORDED_WINDOW.noTokenId, "1"]) }), /not a JSON array of exactly two token ids/u);
  });

  it("an id that is not a canonical decimal string (F-39): a sign, a leading zero, an exponent, a fraction, a space, hex, empty, not a string", () => {
    for (const bad of [`+${CANARY_UP}`, `0${CANARY_UP}`, "1e75", "1.0", ` ${CANARY_UP}`, "0x1f", "", "-1", "abc"]) {
      refusedFor(judgeV2({ positionIds: { kind: "VALUE", value: [bad, CANARY_DOWN] } }), /the index-0 position id .* is not a canonical token id/u);
      refusedFor(judgeV2({ positionIds: { kind: "VALUE", value: [CANARY_UP, bad] } }), /the index-1 position id .* is not a canonical token id/u);
    }
    refusedFor(judgeV2({ positionIds: { kind: "VALUE", value: [null, CANARY_DOWN] } }), /the index-0 position id null is not a canonical token id/u);
    refusedFor(judgeV1({ clobTokenIds: JSON.stringify(["+1", RECORDED_WINDOW.noTokenId]) }), /the index-0 token id "\+1" is not a canonical token id/u);
  });

  it("two equal ids", () => {
    refusedFor(judgeV2({ positionIds: { kind: "VALUE", value: [CANARY_UP, CANARY_UP] } }), /the two position ids are the same id/u);
    refusedFor(judgeV1({ clobTokenIds: JSON.stringify([RECORDED_WINDOW.yesTokenId, RECORDED_WINDOW.yesTokenId]) }), /the two outcome tokens are the same token/u);
  });

  it("outcomes that do not match the reviewed labels and order — the documented example's Yes/No, and swapped", () => {
    refusedFor(judgeV2({ outcomes: '["Yes", "No"]' }), /Market\.outcomes is .*, not the reviewed labels in order \["Up","Down"\]/u);
    refusedFor(judgeV2({ outcomes: '["Down", "Up"]' }), /Market\.outcomes/u);
  });

  it("every refusal fails closed: no window facts, the condition id kept for the incident", () => {
    const verdict = judgeV2({ version: { kind: "ABSENT" } });
    expect(verdict).toMatchObject({ verdict: "REFUSE", conditionId: PROTOCOL_V2_SAMPLES.canaryConditionId31 });
    expect("window" in verdict).toBe(false);
  });
});

describe("V2-1 acceptance 4: acceptedProtocolVersions is a reviewed series parameter (ADR-030 Amendment 2 rule 2)", () => {
  it("a window whose version the review does not accept is REFUSED, naming the reviewed list", () => {
    refusedFor(judgeV2({}, {}, ["v1"]), /parameter: Market\.version is "v2", not one of the reviewed acceptedProtocolVersions \["v1"\]/u);
    refusedFor(judgeV1({}, {}, ["v2"]), /parameter: Market\.version is "v1", not one of the reviewed acceptedProtocolVersions \["v2"\]/u);
    expect(judgeV2({}, {}, ["v2"]).verdict).toBe("ADMIT");
    expect(judgeV1({}, {}, ["v1", "v2"]).verdict).toBe("ADMIT");
    expect(judgeV1({}, {}, ["v2", "v1"]).verdict).toBe("ADMIT");
  });

  it("a review WITHOUT the field is refused at parse, saying what to add — never read as a default", () => {
    const document = reviewedBtc15mSeriesDocument();
    const parameters = { ...(document["parameters"] as Record<string, unknown>) };
    delete parameters["acceptedProtocolVersions"];
    const parsed = parseReviewedSeries({ ...document, parameters });
    expect(parsed).toEqual({ ok: false, issues: [`parameters.acceptedProtocolVersions: ${ACCEPTED_PROTOCOL_VERSIONS_REQUIRED}`] });
    expect(ACCEPTED_PROTOCOL_VERSIONS_REQUIRED).toContain('["v1","v2"]');
  });

  it("the list is non-empty, of distinct values, each exactly \"v1\" or \"v2\"", () => {
    for (const bad of [[], ["v1", "v1"], ["v2", "v2"], ["v3"], ["V1"], ["v1", "v2", "v1"], ["v1", null], "v1", null, ["v1", "v2", "v3"]]) {
      expect(parseReviewedSeries(reviewDocument(bad)).ok, JSON.stringify(bad)).toBe(false);
    }
    const duplicate = parseReviewedSeries(reviewDocument(["v1", "v1"]));
    expect(duplicate.ok === false && duplicate.issues.join(" | ")).toContain("the accepted protocol versions must be distinct");
    for (const good of [["v1"], ["v2"], ["v1", "v2"], ["v2", "v1"]]) expect(parseReviewedSeries(reviewDocument(good)).ok, JSON.stringify(good)).toBe(true);
  });

  it("the list is part of seriesConfigHash: the pinned hashes, the same in the trader's mirror", () => {
    expect(reviewed(["v1"]).configHash).toBe(SAMPLE_REVIEW_HASH_V1);
    expect(parseReviewedSeries(reviewedBtc15mSeriesDocument())).toMatchObject({ ok: true, configHash: SAMPLE_REVIEW_HASH_V1 });
    expect(reviewed(["v1", "v2"]).configHash).toBe(SAMPLE_REVIEW_HASH_V1_V2);
    expect(reviewed(["v2", "v1"]).configHash).not.toBe(SAMPLE_REVIEW_HASH_V1_V2);
  });

  it("the venue moving the series from v1 to v2 changes NO hash: both windows carry the same review hash", () => {
    const v1 = admitted(judgeV1({}, {}, ["v1", "v2"]));
    const v2 = admitted(judgeV2({}, {}, ["v1", "v2"]));
    expect(v1.seriesConfigHash).toBe(SAMPLE_REVIEW_HASH_V1_V2);
    expect(v2.seriesConfigHash).toBe(SAMPLE_REVIEW_HASH_V1_V2);
  });
});

describe("V2-1 acceptance 5: the CLOB read's condition id is the 32-byte form; Gamma's is the identity (rule 3)", () => {
  it("a 31-byte id (62 hex digits) is right-padded with one zero byte; a 32-byte id is unchanged", () => {
    expect(paddedConditionId(PROTOCOL_V2_SAMPLES.canaryConditionId31)).toEqual({
      ok: true,
      conditionId: PROTOCOL_V2_SAMPLES.canaryConditionId32,
      padded: true,
    });
    expect(paddedConditionId(PROTOCOL_V2_SAMPLES.documentedConditionId31)).toEqual({
      ok: true,
      conditionId: `${PROTOCOL_V2_SAMPLES.documentedConditionId31}00`,
      padded: true,
    });
    expect(paddedConditionId(RECORDED_WINDOW.conditionId)).toEqual({ ok: true, conditionId: RECORDED_WINDOW.conditionId, padded: false });
    expect(paddedConditionId(PROTOCOL_V2_SAMPLES.canaryConditionId32)).toEqual({ ok: true, conditionId: PROTOCOL_V2_SAMPLES.canaryConditionId32, padded: false });
  });

  it("any other width or form is refused: 61, 63, 65 and 66 hex digits, no 0x, 0X, a non-hex digit, empty", () => {
    const hex64 = RECORDED_WINDOW.conditionId.slice(2);
    for (const bad of [
      `0x${hex64.slice(0, 61)}`,
      `0x${hex64.slice(0, 63)}`,
      `0x${hex64}0`,
      `0x${hex64}00`,
      hex64,
      `0X${hex64}`,
      `0x${hex64.slice(0, 63)}g`,
      `0x${hex64.slice(0, 61)}g`,
      "0x",
      "",
      `${RECORDED_WINDOW.conditionId}\n`,
    ]) {
      const answer = paddedConditionId(bad);
      expect(answer.ok, JSON.stringify(bad)).toBe(false);
      if (!answer.ok) expect(answer.problem).toMatch(/neither 31 bytes .* nor 32 bytes .* so no CLOB or Data API read is made/u);
    }
  });

  it("the judge REFUSES a window whose condition id has another width, naming rule 3", () => {
    refusedFor(judgeV1({ conditionId: "0xab" }), /fact: Market\.conditionId: the condition id "0xab" is neither 31 bytes/u);
    refusedFor(judgeV2({ conditionId: `${PROTOCOL_V2_SAMPLES.canaryConditionId31}0` }), /is neither 31 bytes \(0x and 62 hex digits\) nor 32 bytes/u);
  });

  it("a 31-byte Gamma id is ADMITTED and stays the identity: the facts carry Gamma's text, and the derived id hashes it", () => {
    const window = admitted(judgeV2());
    expect(window.conditionId).toBe(PROTOCOL_V2_SAMPLES.canaryConditionId31);
    expect(window.internalMarketId).toBe(windowInternalMarketId(PROTOCOL_V2_SAMPLES.canaryConditionId31, Date.parse(RECORDED_WINDOW.openAt)));
    expect(window.internalMarketId).not.toBe(windowInternalMarketId(PROTOCOL_V2_SAMPLES.canaryConditionId32, Date.parse(RECORDED_WINDOW.openAt)));
  });
});

describe("V2-1 acceptance 8: CLOB v is an undocumented, refusal-only cross-check (C-21; rule 1 item 7)", () => {
  it("present and equal: ADMITTED (V2 and V1)", () => {
    expect(judgeV2({}, { undocumentedProtocolVersion: { kind: "VALUE", value: "v2" } }).verdict).toBe("ADMIT");
    expect(judgeV1({}, { undocumentedProtocolVersion: { kind: "VALUE", value: "v1" } }).verdict).toBe("ADMIT");
  });

  it("present and different: REFUSED, naming both — a null or non-string v included", () => {
    refusedFor(judgeV2({}, { undocumentedProtocolVersion: { kind: "VALUE", value: "v1" } }), /cross-check: CLOB v \(undocumented, C-21\) is "v1", but Gamma Market\.version is "v2"/u);
    refusedFor(judgeV1({}, { undocumentedProtocolVersion: { kind: "VALUE", value: "v2" } }, ["v1", "v2"]), /cross-check: CLOB v .* is "v2", but Gamma Market\.version is "v1"/u);
    refusedFor(judgeV2({}, { undocumentedProtocolVersion: { kind: "VALUE", value: "V2" } }), /cross-check/u);
    refusedFor(judgeV2({}, { undocumentedProtocolVersion: { kind: "NULL" } }), /cross-check: CLOB v .* is null/u);
    refusedFor(judgeV2({}, { undocumentedProtocolVersion: { kind: "UNREADABLE", detail: "a number" } }), /cross-check: CLOB v .* is not of its documented type/u);
  });

  it("absent: refuses NOTHING (V2 and V1)", () => {
    expect(judgeV2({}, { undocumentedProtocolVersion: { kind: "ABSENT" } }).verdict).toBe("ADMIT");
    expect(judgeV1({}, { undocumentedProtocolVersion: { kind: "ABSENT" } }).verdict).toBe("ADMIT");
  });

  it("v never ADMITS: it never stands in for a missing Gamma version, nor overrides an unaccepted one", () => {
    const missing = judgeV2({ version: { kind: "ABSENT" } }, { undocumentedProtocolVersion: { kind: "VALUE", value: "v2" } });
    refusedFor(missing, /Market\.version is absent/u);
    refusedFor(missing, /cross-check: CLOB v .* is "v2", but Gamma Market\.version is absent/u);
    refusedFor(judgeV2({}, { undocumentedProtocolVersion: { kind: "VALUE", value: "v2" } }, ["v1"]), /not one of the reviewed acceptedProtocolVersions/u);
  });

  it("no CLOB read: no cross-check message — the window is refused for the missing read only", () => {
    const verdict = judgeV2({}, null);
    refusedFor(verdict, /no CLOB market-info read/u);
    if (verdict.verdict === "REFUSE") expect(verdict.mismatches.join(" | ")).not.toMatch(/cross-check/u);
  });
});

describe("V2-1 acceptance 6 (the reading, unit level): CLOB t[] carries the position ids, paired by index (O.3)", () => {
  it("the canary's t[] pairs with the selected position ids; another pairing is refused", () => {
    expect(judgeV2().verdict).toBe("ADMIT");
    refusedFor(
      judgeV2({}, { tokens: [{ tokenId: CANARY_DOWN, outcome: "Up" }, { tokenId: CANARY_UP, outcome: "Down" }] }),
      /pairing: CLOB t\[\]/u,
    );
    // A CLOB t[] of the CTF ids does not pair with a V2 window's position ids.
    refusedFor(
      judgeV2({ clobTokenIds: JSON.stringify([RECORDED_WINDOW.yesTokenId, RECORDED_WINDOW.noTokenId]) }, {
        tokens: [
          { tokenId: RECORDED_WINDOW.yesTokenId, outcome: "Up" },
          { tokenId: RECORDED_WINDOW.noTokenId, outcome: "Down" },
        ],
      }),
      /pairing: CLOB t\[\]/u,
    );
  });
});
