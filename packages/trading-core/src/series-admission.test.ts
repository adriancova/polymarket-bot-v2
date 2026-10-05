/**
 * `ROLLOVER-1` (ADR-030; the user's rulings A5, Q1-Q4) — the trader's own copy
 * of the reviewed series and its RE-JUDGE of every `SeriesWindowAdmitted@1`.
 *
 * Each refusal code is pinned by name: removing any guard in
 * `series-admission.ts` makes the test that names it fail (the round's
 * mutation table). The windows are recorded venue data (`testing/series.ts`).
 */

import { describe, expect, it } from "vitest";

import type { ConfiguredSeries } from "./config.js";
import {
  admissionRunModeProblem,
  canonicalSeriesJson,
  deriveWindowSchedule,
  ReviewedSeriesSchema,
  seriesConfigHash,
  windowInternalMarketId,
} from "./series.js";
import { SeriesWindowAdmissions, type AdmittedWindow } from "./series-admission.js";
import { RECORDED_SERIES_WINDOWS, reviewedSeriesDocument, seriesWindowPayloads } from "./testing/series.js";

const [W1, W2, W3] = RECORDED_SERIES_WINDOWS;

function configured(document: Record<string, unknown> = reviewedSeriesDocument()): ConfiguredSeries {
  const series = ReviewedSeriesSchema.parse(document);
  const hash = seriesConfigHash(series);
  if (!hash.ok) throw new Error(hash.problem);
  return { series, configHash: hash.hash };
}

const SERIES = configured();

function admissions(
  options: {
    readonly series?: readonly ConfiguredSeries[];
    readonly known?: (marketId: string, conditionId: string, tokens: readonly string[]) => boolean;
    readonly attach?: (window: AdmittedWindow) => { readonly ok: true } | { readonly ok: false; readonly detail: string };
  } = {},
) {
  const attached: string[] = [];
  const detached: string[] = [];
  const subject = new SeriesWindowAdmissions({
    series: options.series ?? [SERIES],
    isKnownMarket: options.known ?? (() => false),
    attachment: {
      attach: (window) => {
        const answer = options.attach?.(window) ?? { ok: true };
        if (answer.ok) attached.push(window.marketId);
        return answer;
      },
      detach: (window) => {
        detached.push(window.marketId);
      },
    },
  });
  return { subject, attached, detached };
}

/** Observes the window's discovery, then judges its admission (with `change` applied). */
function judged(
  subject: SeriesWindowAdmissions,
  window = W1,
  change: (payload: Record<string, unknown>) => void = () => undefined,
  hash = SERIES.configHash,
) {
  const payloads = seriesWindowPayloads(window, hash);
  subject.observeDiscovered(payloads.discovered);
  const admitted = { ...payloads.admitted };
  change(admitted);
  return subject.judge(admitted);
}

function codeOf(verdict: ReturnType<SeriesWindowAdmissions["judge"]>): string {
  return verdict.kind === "REFUSE" ? verdict.code : verdict.kind;
}

describe("the trader's copy of the reviewed series", () => {
  it("parses the sample review strictly and hashes its canonical text", () => {
    expect(SERIES.configHash).toMatch(/^[0-9a-f]{64}$/u);
    const reordered = Object.fromEntries(Object.entries(reviewedSeriesDocument()).reverse());
    expect(configured(reordered).configHash).toBe(SERIES.configHash);
    const text = canonicalSeriesJson({ b: 1, a: [true, "x"] });
    expect(text).toEqual({ ok: true, text: '{"a":[true,"x"],"b":1}' });
    expect(canonicalSeriesJson({ a: 0.5 }).ok).toBe(false);
    expect(canonicalSeriesJson({ a: null }).ok).toBe(false);
  });

  it("refuses a document with an unknown key, a third outcome or a non-canonical decimal", () => {
    expect(ReviewedSeriesSchema.safeParse({ ...reviewedSeriesDocument(), approved: true }).success).toBe(false);
    expect(ReviewedSeriesSchema.safeParse({ ...reviewedSeriesDocument(), outcomes: ["Up", "Down", "Flat"] }).success).toBe(false);
    const parameters = reviewedSeriesDocument()["parameters"] as Record<string, unknown>;
    expect(
      ReviewedSeriesSchema.safeParse({ ...reviewedSeriesDocument(), parameters: { ...parameters, minimumOrderSize: "5.0" } }).success,
    ).toBe(false);
  });

  it("admission runs only in PAPER or BACKTEST, verbatim (ADR-030 Decision 2.1)", () => {
    expect(admissionRunModeProblem("PAPER")).toBeUndefined();
    expect(admissionRunModeProblem("BACKTEST")).toBeUndefined();
    for (const mode of ["LIVE", "LIVE_MICRO", "SHADOW", "EXECUTION_PROBE", "paper", "", undefined, null]) {
      expect(admissionRunModeProblem(mode), String(mode)).toContain("refuses to start");
    }
  });

  it("derives a window's id as a UUIDv7 whose timestamp is its scheduled open", () => {
    const id = windowInternalMarketId(W1.conditionId, Date.parse(W1.openAt));
    expect(id).toBe(W1.marketId);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(Number.parseInt((id ?? "").replaceAll("-", "").slice(0, 12), 16)).toBe(Date.parse(W1.openAt));
    expect(windowInternalMarketId(W2.conditionId, Date.parse(W1.openAt))).not.toBe(id);
    expect(windowInternalMarketId(W1.conditionId, -1)).toBeUndefined();
  });

  it("reads the schedule from the title in America/New_York, confirmed by the locators", () => {
    const shape = { titlePrefix: "Bitcoin Up or Down - ", durationSeconds: 900 };
    expect(deriveWindowSchedule(W1.title, shape, W1.openAt, W1.closeAt)).toEqual({
      ok: true,
      openAt: "2026-10-04T22:15:00.000Z",
      closeAt: "2026-10-04T22:30:00.000Z",
      openEpochMs: Date.parse(W1.openAt),
      closeEpochMs: Date.parse(W1.closeAt),
    });
    // The locators locate; they do not decide: a title that disagrees is refused.
    expect(deriveWindowSchedule(W1.title, shape, W2.openAt, W2.closeAt).ok).toBe(false);
    // The daylight-saving repeat (U-34): 1:00AM-1:15AM ET on 2026-11-01 is two intervals.
    const repeat = deriveWindowSchedule(
      "Bitcoin Up or Down - November 1, 1:00AM-1:15AM ET",
      shape,
      "2026-11-01T05:00:00Z",
      "2026-11-01T05:15:00Z",
    );
    expect(repeat).toMatchObject({ ok: false, ambiguous: true });
    expect(deriveWindowSchedule("Ethereum Up or Down - October 4, 6:15PM-6:30PM ET", shape, W1.openAt, W1.closeAt).ok).toBe(false);
    expect(deriveWindowSchedule("Bitcoin Up or Down - October 4, 6:15PM-6:45PM ET", shape, W1.openAt, "2026-10-04T22:45:00Z").ok).toBe(false);
  });
});

describe("SeriesWindowAdmissions — the re-judge admits only an exact match", () => {
  it("admits a recorded window, discovered first, with the review's parameters and the window's own facts", () => {
    const { subject, attached } = admissions();
    const verdict = judged(subject);
    expect(verdict.kind).toBe("ADMIT");
    if (verdict.kind !== "ADMIT") return;
    expect(verdict.window.market).toMatchObject({
      marketId: W1.marketId,
      conditionId: W1.conditionId,
      yesTokenId: W1.yesTokenId,
      noTokenId: W1.noTokenId,
      tickSize: "0.001",
      minimumOrderSize: "5",
      openTime: W1.openAt,
      closeTime: W1.closeAt,
      parametersVersion: 1,
      settlementReadiness: { modelDependentActivationAllowed: false },
      seriesKey: "btc-15m-updown",
    });
    expect(verdict.window.catalog).toEqual({ yesLabel: "Up", noLabel: "Down", negRisk: false, tradingDelaySeconds: 0 });
    expect(subject.attach(verdict.window)).toEqual({ ok: true });
    expect(attached).toEqual([W1.marketId]);
    expect(subject.isLive(W1.marketId)).toBe(true);
    expect(subject.metrics()).toMatchObject({ admitted: 1, live: 1, refusals: {} });
  });

  it.each([
    ["MALFORMED", (payload: Record<string, unknown>) => void delete payload["windowTitle"]],
    ["UNKNOWN_SERIES", (payload: Record<string, unknown>) => void (payload["seriesId"] = "eth-15m-updown")],
    ["REVIEW_MISMATCH", (payload: Record<string, unknown>) => void (payload["seriesConfigHash"] = "0".repeat(64))],
    ["SCHEDULE", (payload: Record<string, unknown>) => void (payload["windowTitle"] = W2.title)],
    ["TICK_SIZE", (payload: Record<string, unknown>) => void (payload["tickSize"] = "0.0001")],
  ])("refuses %s", (code, change) => {
    const { subject, attached } = admissions();
    expect(codeOf(judged(subject, W1, change))).toBe(code);
    expect(attached).toEqual([]);
    expect(subject.metrics().refusals).toEqual({ [code]: 1 });
  });

  it("refuses DISCOVERY_MISSING without a MarketDiscovered@1 first, and DISCOVERY_DISAGREES when they differ", () => {
    const { subject } = admissions();
    expect(codeOf(subject.judge(seriesWindowPayloads(W1, SERIES.configHash).admitted))).toBe("DISCOVERY_MISSING");
    const payloads = seriesWindowPayloads(W1, SERIES.configHash);
    subject.observeDiscovered({ ...payloads.discovered, yesTokenId: W1.noTokenId, noTokenId: W1.yesTokenId });
    expect(codeOf(subject.judge(payloads.admitted))).toBe("DISCOVERY_DISAGREES");
  });

  it("refuses MALFORMED tokens (presence and form only) and IDENTITY_NOT_DERIVED for an id that is not the window's", () => {
    const tokens = admissions();
    const payloads = seriesWindowPayloads(W1, SERIES.configHash);
    tokens.subject.observeDiscovered({ ...payloads.discovered, noTokenId: W1.yesTokenId });
    expect(codeOf(tokens.subject.judge({ ...payloads.admitted, noTokenId: W1.yesTokenId }))).toBe("MALFORMED");

    const identity = admissions();
    const foreign = "018f4a7e-1111-7abc-8def-0123456789ab";
    identity.subject.observeDiscovered({ ...payloads.discovered, internalMarketId: foreign });
    expect(codeOf(identity.subject.judge({ ...payloads.admitted, internalMarketId: foreign }))).toBe("IDENTITY_NOT_DERIVED");
  });

  it("refuses SHADOWS_KNOWN_MARKET for a window over a market this trader already runs", () => {
    const { subject } = admissions({ known: (_id, conditionId) => conditionId === W1.conditionId });
    expect(codeOf(judged(subject))).toBe("SHADOWS_KNOWN_MARKET");
  });

  it("enforces the reviewed cap itself (CAP_REACHED), and a torn-down window frees its place", () => {
    const { subject, detached } = admissions();
    for (const window of [W1, W2]) {
      const verdict = judged(subject, window);
      if (verdict.kind !== "ADMIT") throw new Error(codeOf(verdict));
      subject.attach(verdict.window);
    }
    expect(codeOf(judged(subject, W3))).toBe("CAP_REACHED");
    expect(subject.detach(W1.marketId, "RESOLVED")?.marketId).toBe(W1.marketId);
    expect(detached).toEqual([W1.marketId]);
    const third = judged(subject, W3);
    expect(third.kind).toBe("ADMIT");
    expect(subject.metrics()).toMatchObject({ tornDownResolved: 1, live: 1, refusals: { CAP_REACHED: 1 } });
  });

  it("an identical admission seen again is a DUPLICATE (a replayed stream); different facts under the id are refused", () => {
    const { subject } = admissions();
    const verdict = judged(subject);
    if (verdict.kind !== "ADMIT") throw new Error(codeOf(verdict));
    subject.attach(verdict.window);
    expect(codeOf(judged(subject))).toBe("DUPLICATE");
    expect(codeOf(judged(subject, W1, (payload) => void (payload["tickSize"] = "0.01")))).toBe("DUPLICATE_DISAGREES");
    // Even after teardown, the run remembers what it admitted.
    subject.detach(W1.marketId, "UNRESOLVED_AFTER_CLOSE");
    expect(codeOf(judged(subject))).toBe("DUPLICATE");
    expect(subject.metrics()).toMatchObject({ duplicates: 2, tornDownUnresolved: 1 });
  });

  it("a refused attachment leaves the window not live, and is counted ATTACH_FAILED", () => {
    const { subject } = admissions({ attach: () => ({ ok: false, detail: "no runtime" }) });
    const verdict = judged(subject);
    if (verdict.kind !== "ADMIT") throw new Error(codeOf(verdict));
    expect(subject.attach(verdict.window)).toEqual({ ok: false, detail: "no runtime" });
    expect(subject.isLive(W1.marketId)).toBe(false);
    expect(subject.metrics().refusals).toEqual({ ATTACH_FAILED: 1 });
  });

  it("ignores a MarketDiscovered@1 of a series it does not review, and keeps a bounded refusal log", () => {
    const { subject } = admissions();
    subject.observeDiscovered({ ...seriesWindowPayloads(W1, SERIES.configHash).discovered, seriesId: "eth-15m-updown" });
    expect(codeOf(subject.judge(seriesWindowPayloads(W1, SERIES.configHash).admitted))).toBe("DISCOVERY_MISSING");
    for (let index = 0; index < 40; index += 1) subject.judge({});
    expect(subject.metrics().lastRefusals).toHaveLength(32);
  });
});
