/**
 * `ROLLOVER-1` — the trader's copy of the reviewed-series rules AGREES with
 * the gateway's.
 *
 * The gateway judges a window with `@polymarket-bot/universe`
 * (`series-admission.ts`, `series-window-schedule.ts`); the trader re-judges
 * it with `@polymarket-bot/trading-core` `series.ts`, a MIRROR, because the
 * core may not depend on `packages/universe` without a lockfile change this
 * round may not make (no new dependency). A mirror can drift; this file is
 * what makes drift a failing test rather than a silent disagreement:
 *
 * - the two sample review documents are the same document;
 * - the two schemas accept and refuse the same corpus;
 * - the two configuration hashes are equal — the value `SeriesWindowAdmitted@1`
 *   carries and the trader compares (`REVIEW_MISMATCH`);
 * - the two schedule derivations agree on a corpus that includes the
 *   daylight-saving repeat (U-34), a midnight crossing and a locator mismatch;
 * - the two window-id derivations and run-mode guards agree.
 */

import {
  admissionRunModeProblem as coreRunModeProblem,
  canonicalSeriesJson as coreCanonicalJson,
  configuredSeries,
  deriveWindowSchedule as coreSchedule,
  parseTraderConfig,
  ReviewedSeriesSchema as CoreSchema,
  seriesConfigHash as coreHash,
  windowInternalMarketId as coreWindowId,
} from "@polymarket-bot/trader";
import { RECORDED_SERIES_WINDOWS, reviewedSeriesDocument as coreDocument } from "@polymarket-bot/trader/testing";
import {
  admissionRunModeProblem as universeRunModeProblem,
  canonicalSeriesJson as universeCanonicalJson,
  deriveWindowSchedule as universeSchedule,
  parseReviewedSeries,
  seriesConfigHash as universeHash,
  windowInternalMarketId as universeWindowId,
} from "@polymarket-bot/universe";
import { reviewedBtc15mSeriesDocument as universeDocument } from "@polymarket-bot/universe/testing";
import { describe, expect, it } from "vitest";

import { traderConfig } from "./support/fixture.js";

type Mutation = readonly [string, (document: Record<string, Record<string, unknown>>) => void];

/** Each mutation is applied to a fresh copy of the sample review. */
const SCHEMA_CORPUS: readonly Mutation[] = [
  ["the sample itself", () => undefined],
  ["an unknown top-level key", (d) => void (d["approved"] = true as never)],
  ["an unknown nested key", (d) => void (d["window"] = { ...d["window"], hourly: true })],
  ["a missing key", (d) => void delete d["rules"]],
  ["three outcomes", (d) => void (d["outcomes"] = ["Up", "Down", "Flat"] as never)],
  ["one outcome", (d) => void (d["outcomes"] = ["Up"] as never)],
  ["an empty outcome", (d) => void (d["outcomes"] = ["Up", ""] as never)],
  ["a non-canonical tick size", (d) => void (d["parameters"] = { ...d["parameters"], allowedTickSizes: ["0.010"] })],
  ["a zero tick size", (d) => void (d["parameters"] = { ...d["parameters"], allowedTickSizes: ["0"] })],
  ["no tick size", (d) => void (d["parameters"] = { ...d["parameters"], allowedTickSizes: [] })],
  ["nine tick sizes", (d) => void (d["parameters"] = { ...d["parameters"], allowedTickSizes: Array.from({ length: 9 }, (_, i) => `0.0${String(i + 1)}`) })],
  ["a negative minimum size", (d) => void (d["parameters"] = { ...d["parameters"], minimumOrderSize: "-5" })],
  ["a fractional base fee", (d) => void (d["parameters"] = { ...d["parameters"], fees: { ...(d["parameters"]?.["fees"] as object), makerBaseFee: "1000.5" } })],
  ["a leading-zero base fee", (d) => void (d["parameters"] = { ...d["parameters"], fees: { ...(d["parameters"]?.["fees"] as object), takerBaseFee: "01000" } })],
  ["a stated delay", (d) => void (d["parameters"] = { ...d["parameters"], tradingDelay: { takerOrderDelayEnabled: true, gammaSecondsDelay: "3" } })],
  ["a delay of the wrong form", (d) => void (d["parameters"] = { ...d["parameters"], tradingDelay: { takerOrderDelayEnabled: true, gammaSecondsDelay: 3 } })],
  ["a 59 s window", (d) => void (d["window"] = { ...d["window"], durationSeconds: 59 })],
  ["a fractional window length", (d) => void (d["window"] = { ...d["window"], durationSeconds: 900.5 })],
  ["another time zone", (d) => void (d["window"] = { ...d["window"], titleTimeZone: "UTC" })],
  ["a leading-zero Gamma series id", (d) => void (d["venue"] = { ...d["venue"], gammaSeriesId: "010192" })],
  ["an upper-case rules digest", (d) => void (d["rules"] = { ...d["rules"], descriptionSha256: "A".repeat(64) })],
  ["a review instant without an offset", (d) => void (d["review"] = { ...d["review"], reviewedAt: "2026-10-04T23:00:00" })],
  ["a 64-character series id", (d) => void (d["seriesId"] = `s${"x".repeat(63)}` as never)],
  ["a 65-character series id", (d) => void (d["seriesId"] = `s${"x".repeat(64)}` as never)],
  ["a series id with a space", (d) => void (d["seriesId"] = "btc 15m" as never)],
  ["a 200-character reviewer", (d) => void (d["review"] = { ...d["review"], reviewedBy: "r".repeat(200) })],
  ["a 201-character reviewer", (d) => void (d["review"] = { ...d["review"], reviewedBy: "r".repeat(201) })],
  ["a cap of 0", (d) => void (d["maximumConcurrentWindows"] = 0 as never)],
  ["a cap of 64", (d) => void (d["maximumConcurrentWindows"] = 64 as never)],
  ["a cap of 65", (d) => void (d["maximumConcurrentWindows"] = 65 as never)],
  ["a teardown bound of 299 s", (d) => void (d["unresolvedTeardownSeconds"] = 299 as never)],
  ["a teardown bound of 7 days", (d) => void (d["unresolvedTeardownSeconds"] = 604_800 as never)],
  ["a teardown bound over 7 days", (d) => void (d["unresolvedTeardownSeconds"] = 604_801 as never)],
  ["a non-boolean negRisk", (d) => void (d["parameters"] = { ...d["parameters"], negRisk: "false" })],
  ["negRisk true (r7, R6-FABLE-01: refused on both sides)", (d) => void (d["parameters"] = { ...d["parameters"], negRisk: true })],
];

function mutated(mutation: Mutation[1]): Record<string, Record<string, unknown>> {
  const document = structuredClone(universeDocument()) as Record<string, Record<string, unknown>>;
  mutation(document);
  return document;
}

describe("ROLLOVER-1: the trader's series rules mirror the gateway's", () => {
  it("the two sample reviews are one document", () => {
    expect(coreDocument()).toEqual(universeDocument());
  });

  it.each(SCHEMA_CORPUS)("the two schemas agree on %s", (_name, mutation) => {
    const document = mutated(mutation);
    const universe = parseReviewedSeries(document).ok;
    const core = CoreSchema.safeParse(document).success;
    expect(core).toBe(universe);
  });

  it("ROLLOVER-1 r7 (R6-FABLE-01): a review stating negRisk TRUE is refused by BOTH sides — the gateway's parse, the trader's schema and the trader's configuration door — because augmented negative risk is neither read nor judged", () => {
    const document = mutated((d) => void (d["parameters"] = { ...d["parameters"], negRisk: true }));
    expect(parseReviewedSeries(document).ok).toBe(false);
    expect(CoreSchema.safeParse(document).success).toBe(false);
    const base = traderConfig();
    const instance = (base["instances"] as Record<string, unknown>[])[0] ?? {};
    const rest = Object.fromEntries(Object.entries(instance).filter(([key]) => key !== "marketId"));
    const config = (series: unknown): ReturnType<typeof parseTraderConfig> =>
      parseTraderConfig({
        ...base,
        markets: [],
        instances: [],
        series: [series],
        seriesInstances: [
          { ...rest, instanceId: "c18f4a7e-1111-7abc-8def-0123456789ab", runId: "018f4a7e-1212-7abc-8def-0123456789ab", seriesId: "btc-15m-updown" },
        ],
      });
    const refused = config(document);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.refusal.issues.join(" | ")).toMatch(/negRisk/u);
    // Control: the recorded review (negRisk false) passes the same door.
    expect(config(coreDocument()).ok).toBe(true);
  });

  it("the corpus exercises both answers", () => {
    const answers = SCHEMA_CORPUS.map(([, mutation]) => parseReviewedSeries(mutated(mutation)).ok);
    expect(answers.filter(Boolean).length).toBeGreaterThanOrEqual(4);
    expect(answers.filter((answer) => !answer).length).toBeGreaterThanOrEqual(20);
  });

  it("the configuration hash is one value: the gateway's, the trader's, and the trader's PARSED configuration's", () => {
    const universe = parseReviewedSeries(universeDocument());
    if (!universe.ok) throw new Error(universe.issues.join("; "));
    const core = coreHash(CoreSchema.parse(coreDocument()));
    expect(core).toEqual({ ok: true, hash: universe.configHash });
    expect(universeHash(universeDocument())).toEqual(core);
    // Through the trader's own configuration door, as the run starts.
    const base = traderConfig();
    const instance = (base["instances"] as Record<string, unknown>[])[0] ?? {};
    const rest = Object.fromEntries(Object.entries(instance).filter(([key]) => key !== "marketId"));
    const parsed = parseTraderConfig({
      ...base,
      series: [coreDocument()],
      seriesInstances: [
        { ...rest, instanceId: "c18f4a7e-1111-7abc-8def-0123456789ab", runId: "018f4a7e-1212-7abc-8def-0123456789ab", seriesId: "btc-15m-updown" },
      ],
    });
    if (!parsed.ok) throw new Error(parsed.refusal.issues.join("; "));
    expect(configuredSeries(parsed.config).map((entry) => entry.configHash)).toEqual([universe.configHash]);
    // And canonical text is byte-identical on a nested, reordered value.
    const value = { z: [1, { b: true, a: "x" }], a: "y" };
    expect(coreCanonicalJson(value)).toEqual(universeCanonicalJson(value));
    expect(coreCanonicalJson({ a: 1.5 }).ok).toBe(universeCanonicalJson({ a: 1.5 }).ok);
  });

  const SHAPE = { titlePrefix: "Bitcoin Up or Down - ", durationSeconds: 900 };
  const IMPOSSIBLE_LOCATORS: readonly (readonly [string, string, string])[] = [
    ["Bitcoin Up or Down - March 2, 5:15PM-5:30PM ET", "2026-02-30T22:15:00Z", "2026-02-30T22:30:00Z"],
    ["Bitcoin Up or Down - March 2, 5:15PM-5:30PM ET", "2026-03-02T22:15:00Z", "2026-02-30T22:30:00Z"],
    ["Bitcoin Up or Down - May 1, 6:15PM-6:30PM ET", "2026-04-31T22:15:00Z", "2026-04-31T22:30:00Z"],
    ["Bitcoin Up or Down - October 4, 7:45PM-8:00PM ET", "2026-10-04T23:45:00Z", "2026-10-04T24:00:00Z"],
  ];
  const SCHEDULE_CORPUS: readonly (readonly [string, string, string])[] = [
    ...RECORDED_SERIES_WINDOWS.map((window) => [window.title, window.openAt, window.closeAt] as const),
    ["Bitcoin Up or Down - October 4, 11:45PM-12:00AM ET", "2026-10-05T03:45:00Z", "2026-10-05T04:00:00Z"],
    ["Bitcoin Up or Down - November 1, 1:00AM-1:15AM ET", "2026-11-01T05:00:00Z", "2026-11-01T05:15:00Z"],
    ["Bitcoin Up or Down - November 1, 1:00AM-1:15AM ET", "2026-11-01T06:00:00Z", "2026-11-01T06:15:00Z"],
    ["Bitcoin Up or Down - November 1, 1:45AM-2:00AM ET", "2026-11-01T06:45:00Z", "2026-11-01T07:00:00Z"],
    ["Bitcoin Up or Down - March 8, 2:00AM-2:15AM ET", "2026-03-08T07:00:00Z", "2026-03-08T07:15:00Z"],
    ["Bitcoin Up or Down - March 8, 3:00AM-3:15AM ET", "2026-03-08T07:00:00Z", "2026-03-08T07:15:00Z"],
    ["Bitcoin Up or Down - October 4, 6:15PM-6:30PM ET", "2026-10-04T22:30:00Z", "2026-10-04T22:45:00Z"],
    ["Bitcoin Up or Down - October 4, 6:15PM-6:45PM ET", "2026-10-04T22:15:00Z", "2026-10-04T22:45:00Z"],
    ["Bitcoin Up or Down - October 4, 6:15PM-6:30PM UTC", "2026-10-04T22:15:00Z", "2026-10-04T22:30:00Z"],
    ["Bitcoin Up or Down - Octember 4, 6:15PM-6:30PM ET", "2026-10-04T22:15:00Z", "2026-10-04T22:30:00Z"],
    ["Bitcoin Up or Down - October 4, 6:15PM-6:30PM ET", "2026-10-04 22:15", "2026-10-04T22:30:00Z"],
    ["Ethereum Up or Down - October 4, 6:15PM-6:30PM ET", "2026-10-04T22:15:00Z", "2026-10-04T22:30:00Z"],
    // `ROLLOVER-1` r1 (R1-02): locators on dates the calendar does not have —
    // `Date.parse` normalizes them into the titled interval (February 30 is
    // March 2, April 31 is May 1, 24:00 is the next day's 00:00).
    ...IMPOSSIBLE_LOCATORS,
  ];

  it.each(SCHEDULE_CORPUS)("the two schedule derivations agree on %j at %s", (title, open, close) => {
    const universe = universeSchedule(title, SHAPE, open, close);
    const core = coreSchedule(title, SHAPE, open, close);
    expect(core.ok).toBe(universe.ok);
    if (core.ok && universe.ok) {
      expect([core.openAt, core.closeAt, core.openEpochMs, core.closeEpochMs]).toEqual([
        universe.openAt,
        universe.closeAt,
        universe.openEpochMs,
        universe.closeEpochMs,
      ]);
    }
    if (!core.ok && !universe.ok) expect(core.ambiguous).toBe(universe.ambiguous);
  });

  it("R1-02: a locator on a date the calendar does not have is refused by BOTH, never normalized into the titled interval", () => {
    for (const [title, open, close] of IMPOSSIBLE_LOCATORS) {
      expect(universeSchedule(title, SHAPE, open, close).ok, `${open} ${close}`).toBe(false);
      expect(coreSchedule(title, SHAPE, open, close).ok, `${open} ${close}`).toBe(false);
    }
  });

  it("the daylight-saving repeat is refused as ambiguous by both (U-34)", () => {
    const [title, open, close] = SCHEDULE_CORPUS[4] ?? ["", "", ""];
    expect(universeSchedule(title, SHAPE, open, close)).toMatchObject({ ok: false, ambiguous: true });
    expect(coreSchedule(title, SHAPE, open, close)).toMatchObject({ ok: false, ambiguous: true });
  });

  it("the window ids and the run-mode guards agree", () => {
    for (const window of RECORDED_SERIES_WINDOWS) {
      const open = Date.parse(window.openAt);
      expect(coreWindowId(window.conditionId, open)).toBe(universeWindowId(window.conditionId, open));
      expect(coreWindowId(window.conditionId, open)).toBe(window.marketId);
    }
    expect(coreWindowId("0x", 2 ** 48)).toBe(universeWindowId("0x", 2 ** 48));
    for (const mode of ["PAPER", "BACKTEST", "LIVE", "LIVE_MICRO", "SHADOW", "EXECUTION_PROBE", "paper", "", undefined]) {
      expect(coreRunModeProblem(mode) === undefined, String(mode)).toBe(universeRunModeProblem(mode) === undefined);
    }
  });
});
