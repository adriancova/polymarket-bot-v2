/**
 * `ROLLOVER-1`: the `seriesAdmission` configuration door, the admission ledger
 * and the run-mode reader.
 */

import { createMemoryFileSystem } from "@polymarket-bot/storage-wal/testing";
import { reviewedBtc15mSeriesDocument } from "@polymarket-bot/universe/testing";
import { describe, expect, it } from "vitest";

import { ADMISSION_LEDGER_FILE_NAME, AdmissionLedger, boundedMismatches, type AdmissionLedgerRecord } from "./admission-ledger.js";
import { parseGatewayConfig, reviewedSeriesOf } from "./config.js";
import { GatewayConfigurationError, GatewayStateError } from "./errors.js";
import { gatewayRunMode } from "./run-mode.js";

function config(overrides: Record<string, unknown> = {}, block: Record<string, unknown> = {}): unknown {
  return {
    streamName: "market-events",
    wal: { rootPath: "/wal" },
    markets: [],
    polymarket: { feedId: "polymarket-market", customFeatureEnabled: true },
    lifecycle: { baseUrl: "http://gamma.stub", pollIntervalMs: 10_000 },
    seriesAdmission: { admissionLeadSeconds: 900, series: [reviewedBtc15mSeriesDocument()], ...block },
    ...overrides,
  };
}

describe("the seriesAdmission configuration door", () => {
  it("accepts a reviewed series with no configured market, applies the declared defaults, and parses the series", () => {
    const parsed = parseGatewayConfig(config());
    expect(parsed.seriesAdmission?.feedId).toBe("polymarket-series-admission");
    expect(parsed.seriesAdmission?.pollIntervalMs).toBe(30_000);
    expect(parsed.seriesAdmission?.pageLimit).toBe(20);
    expect(parsed.seriesAdmission?.maximumPages).toBe(3);
    const series = reviewedSeriesOf(parsed);
    expect(series.map((entry) => entry.series.seriesId)).toEqual(["btc-15m-updown"]);
    expect(series[0]?.configHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("still refuses a polymarket or lifecycle block with no market when there is no seriesAdmission block", () => {
    expect(() => parseGatewayConfig(config({ seriesAdmission: undefined }))).toThrow(GatewayConfigurationError);
  });

  it("requires the polymarket and lifecycle blocks: an admitted window is subscribed and opened through them", () => {
    expect(() => parseGatewayConfig(config({ polymarket: undefined }))).toThrow(/polymarket and lifecycle/u);
    expect(() => parseGatewayConfig(config({ lifecycle: undefined }))).toThrow(/polymarket and lifecycle/u);
  });

  it("R1-FABLE-02: requires polymarket.customFeatureEnabled: true — without it no market_resolved arrives (F-13)", () => {
    for (const polymarket of [{ feedId: "polymarket-market" }, { feedId: "polymarket-market", customFeatureEnabled: false }]) {
      expect(() => parseGatewayConfig(config({ polymarket }))).toThrow(/customFeatureEnabled: true/u);
    }
    expect(() => parseGatewayConfig(config())).not.toThrow();
  });

  it("refuses a series the universe door refuses, and a series named twice", () => {
    expect(() => parseGatewayConfig(config({}, { series: [{ ...reviewedBtc15mSeriesDocument(), approved: true }] }))).toThrow(/not a reviewed series/u);
    expect(() =>
      parseGatewayConfig(config({}, { series: [reviewedBtc15mSeriesDocument(), reviewedBtc15mSeriesDocument()] })),
    ).toThrow(/once/u);
  });

  it("refuses a cadence under the floor and a budget over the venue's documented share", () => {
    expect(() => parseGatewayConfig(config({}, { pollIntervalMs: 4_999 }))).toThrow(/at least 5000/u);
    // 1 series × 10 pages × (10000 / 5000) = 20 keyset requests per 10 s ≤ 25: accepted.
    expect(() => parseGatewayConfig(config({}, { pollIntervalMs: 5_000, maximumPages: 10 }))).not.toThrow();
    // The lifecycle budget counts the series' cap of 2 as polled markets: at a
    // 1 s cadence that is 20 requests per 10 s, over the 15 the feed may use.
    expect(() => parseGatewayConfig(config({ lifecycle: { baseUrl: "http://gamma.stub", pollIntervalMs: 1_000 } }))).toThrow(/2 markets/u);
  });

  it("R3-FABLE-01: accepts operatorRetirements naming each window once, with a reason that says something; refuses anything else", () => {
    const entry = { internalMarketId: "0199b1a2-1c20-7000-8000-000000000001", reason: "gateway down 22:20-23:20; resolution missed" };
    expect(parseGatewayConfig(config({}, { operatorRetirements: [entry] })).seriesAdmission?.operatorRetirements).toEqual([entry]);
    expect(parseGatewayConfig(config()).seriesAdmission?.operatorRetirements).toBeUndefined();
    expect(() => parseGatewayConfig(config({}, { operatorRetirements: [entry, { ...entry, reason: "again" }] }))).toThrow(/each window once/u);
    for (const bad of [{ ...entry, reason: "" }, { ...entry, reason: "   " }, { internalMarketId: entry.internalMarketId }, { ...entry, internalMarketId: "0xaa" }, { ...entry, approved: true }]) {
      expect(() => parseGatewayConfig(config({}, { operatorRetirements: [bad] }))).toThrow(GatewayConfigurationError);
    }
    // Not part of any series' review: the series' hash is unchanged by it.
    const plain = reviewedSeriesOf(parseGatewayConfig(config()))[0]?.configHash;
    expect(reviewedSeriesOf(parseGatewayConfig(config({}, { operatorRetirements: [entry] })))[0]?.configHash).toBe(plain);
  });

  it("requires admissionLeadSeconds: how early a run takes on a window is the operator's choice", () => {
    const document = config() as Record<string, Record<string, unknown>>;
    delete document["seriesAdmission"]?.["admissionLeadSeconds"];
    expect(() => parseGatewayConfig(document)).toThrow(GatewayConfigurationError);
  });
});

describe("gatewayRunMode — the mode admission is judged against", () => {
  it("is RUN_MODE, else MAX_RUN_MODE, else the repository default PAPER, verbatim", () => {
    expect(gatewayRunMode({})).toBe("PAPER");
    expect(gatewayRunMode({ RUN_MODE: "", MAX_RUN_MODE: "" })).toBe("PAPER");
    expect(gatewayRunMode({ MAX_RUN_MODE: "LIVE" })).toBe("LIVE");
    expect(gatewayRunMode({ RUN_MODE: "BACKTEST", MAX_RUN_MODE: "LIVE" })).toBe("BACKTEST");
    expect(gatewayRunMode({ RUN_MODE: "paper" })).toBe("paper");
  });
});

function admitted(key: string, overrides: Partial<AdmissionLedgerRecord> = {}): AdmissionLedgerRecord {
  return {
    key,
    seriesId: "btc-15m-updown",
    seriesConfigHash: "a".repeat(64),
    status: "ADMITTED",
    judgedAt: "2026-10-04T22:20:00.000Z",
    closeAt: "2026-10-04T22:30:00.000Z",
    window: {
      internalMarketId: "0199b1a2-1c20-7000-8000-000000000001",
      conditionId: key,
      gammaEventId: "1127115",
      gammaMarketId: "5255913",
      yesTokenId: "1",
      noTokenId: "2",
      scheduledOpenAt: "2026-10-04T22:15:00.000Z",
      scheduledCloseAt: "2026-10-04T22:30:00.000Z",
      tickSize: "0.001",
      windowTitle: "Bitcoin Up or Down - October 4, 6:15PM-6:30PM ET",
      parameterVersionRef: "ref-1",
      keysetRawIngestSeq: "3",
      clobRawIngestSeq: "4",
    },
    ...overrides,
  };
}

/** `ROLLOVER-1` r3: the resolution the market channel delivered for {@link admitted}'s window. */
function resolutionOf(key: string, publishedAt?: string): NonNullable<AdmissionLedgerRecord["resolution"]> {
  return {
    payload: { internalMarketId: "0199b1a2-1c20-7000-8000-000000000001", conditionId: key, outcome: "YES_WIN", resolvedAt: "2026-10-04T22:31:00.000Z" },
    venueTimestamp: "2026-10-04T22:31:00.000Z",
    observedAt: "2026-10-04T22:31:00.100Z",
    rawFrame: { gatewayEpoch: "0199b1a2-1c20-7000-8000-0000000000e1", ingestSeq: "42" },
    ...(publishedAt === undefined ? {} : { publishedAt }),
  };
}

describe("AdmissionLedger — durable, strict, bounded", () => {
  it("round-trips records through the file and reopens them", async () => {
    const fileSystem = createMemoryFileSystem();
    const ledger = await AdmissionLedger.open({ fileSystem, walRootPath: "/wal" });
    await ledger.put(admitted("0xaa"));
    await ledger.put({ key: "event:9", seriesId: "btc-15m-updown", seriesConfigHash: "a".repeat(64), status: "REFUSED", judgedAt: "2026-10-04T22:20:00.000Z", mismatches: ["x"] });
    const reopened = await AdmissionLedger.open({ fileSystem, walRootPath: "/wal" });
    expect(reopened.records().map((record) => record.key)).toEqual(["0xaa", "event:9"]);
    expect(reopened.liveWindows().map((record) => record.key)).toEqual(["0xaa"]);
    expect(reopened.get("0xaa")?.window?.gammaMarketId).toBe("5255913");
  });

  it("refuses to write, or to open, an inconsistent record", async () => {
    const fileSystem = createMemoryFileSystem();
    const ledger = await AdmissionLedger.open({ fileSystem, walRootPath: "/wal" });
    await expect(ledger.put({ ...admitted("0xaa"), window: undefined })).rejects.toBeInstanceOf(GatewayStateError);
    await expect(ledger.put(admitted("0xaa", { key: "0xbb" }))).rejects.toBeInstanceOf(GatewayStateError);
    await expect(ledger.put(admitted("0xaa", { status: "RETIRED" }))).rejects.toBeInstanceOf(GatewayStateError);
    await fileSystem.writeWholeFile(
      `/wal/${ADMISSION_LEDGER_FILE_NAME}`,
      Buffer.from(JSON.stringify({ schemaVersion: 1, windows: { "0xaa": { ...admitted("0xaa"), status: "MAYBE" } } }), "utf8"),
    );
    await expect(AdmissionLedger.open({ fileSystem, walRootPath: "/wal" })).rejects.toBeInstanceOf(GatewayStateError);
    await fileSystem.writeWholeFile(`/wal/${ADMISSION_LEDGER_FILE_NAME}`, Buffer.from("{", "utf8"));
    await expect(AdmissionLedger.open({ fileSystem, walRootPath: "/wal" })).rejects.toBeInstanceOf(GatewayStateError);
  });

  it("prunes retired and refused records past their retention, never a live one", async () => {
    const fileSystem = createMemoryFileSystem();
    const ledger = await AdmissionLedger.open({ fileSystem, walRootPath: "/wal" });
    await ledger.put(admitted("0xlive"));
    await ledger.put(admitted("0xold", { status: "RETIRED", retiredAt: "2026-10-04T22:31:00.000Z", retiredReason: "RESOLVED", resolution: resolutionOf("0xold", "2026-10-04T22:31:05.000Z") }));
    await ledger.put({ key: "0xref", seriesId: "s", seriesConfigHash: "a".repeat(64), status: "REFUSED", judgedAt: "2026-10-04T22:20:00.000Z", closeAt: "2026-10-04T22:30:00.000Z", mismatches: ["m"] });
    await ledger.put({ key: "0xnoclose", seriesId: "s", seriesConfigHash: "a".repeat(64), status: "REFUSED", judgedAt: "2026-10-04T22:20:00.000Z", mismatches: ["m"] });
    const closeMs = Date.UTC(2026, 9, 4, 22, 30);
    expect(await ledger.prune(closeMs + 1000, 60_000)).toEqual([]);
    const pruned = await ledger.prune(closeMs + 120_000, 60_000);
    expect(pruned.map((record) => record.key).sort()).toEqual(["0xold", "0xref"]);
    expect(ledger.records().map((record) => record.key)).toEqual(["0xlive", "0xnoclose"]);
    expect(ledger.metrics().pruned).toBe(2);
  });

  it("R2-ASTRA-02: only a handled resolution retires a window — a record retired UNRESOLVED_AFTER_CLOSE is refused, on write and at open", async () => {
    const fileSystem = createMemoryFileSystem();
    const ledger = await AdmissionLedger.open({ fileSystem, walRootPath: "/wal" });
    const abandoned = { ...admitted("0xaa"), status: "RETIRED", retiredAt: "2026-10-04T22:50:00.000Z", retiredReason: "UNRESOLVED_AFTER_CLOSE" } as unknown as AdmissionLedgerRecord;
    await expect(ledger.put(abandoned)).rejects.toBeInstanceOf(GatewayStateError);
    expect(ledger.records()).toEqual([]);
    await fileSystem.writeWholeFile(`/wal/${ADMISSION_LEDGER_FILE_NAME}`, Buffer.from(JSON.stringify({ schemaVersion: 1, windows: { "0xaa": abandoned } }), "utf8"));
    await expect(AdmissionLedger.open({ fileSystem, walRootPath: "/wal" })).rejects.toBeInstanceOf(GatewayStateError);
  });

  it("R3-ASTRA-01: a RESOLVED retirement carries its PUBLISHED resolution — refused with none, or with one still owed, on write and at open", async () => {
    const fileSystem = createMemoryFileSystem();
    const ledger = await AdmissionLedger.open({ fileSystem, walRootPath: "/wal" });
    const retired = { status: "RETIRED", retiredAt: "2026-10-04T22:32:00.000Z", retiredReason: "RESOLVED" } as const;
    // The r2 shape — retired on dispatch, with nothing to say the resolution was published.
    await expect(ledger.put(admitted("0xaa", retired))).rejects.toThrow(/no published resolution/u);
    await expect(ledger.put(admitted("0xaa", { ...retired, resolution: resolutionOf("0xaa") }))).rejects.toThrow(/no published resolution/u);
    expect(ledger.records()).toEqual([]);
    await ledger.put(admitted("0xaa", { ...retired, resolution: resolutionOf("0xaa", "2026-10-04T22:31:05.000Z") }));
    const reopened = await AdmissionLedger.open({ fileSystem, walRootPath: "/wal" });
    expect(reopened.get("0xaa")?.resolution?.publishedAt).toBe("2026-10-04T22:31:05.000Z");
    await fileSystem.writeWholeFile(`/wal/${ADMISSION_LEDGER_FILE_NAME}`, Buffer.from(JSON.stringify({ schemaVersion: 1, windows: { "0xaa": admitted("0xaa", retired) } }), "utf8"));
    await expect(AdmissionLedger.open({ fileSystem, walRootPath: "/wal" })).rejects.toBeInstanceOf(GatewayStateError);
  });

  it("R3-ASTRA-01: a live record keeps its window's OWED resolution across a reopen; another window's resolution, or one on a refusal, is refused", async () => {
    const fileSystem = createMemoryFileSystem();
    const ledger = await AdmissionLedger.open({ fileSystem, walRootPath: "/wal" });
    await ledger.put(admitted("0xaa", { admissionConfirmedAt: "2026-10-04T22:20:01.000Z", resolution: resolutionOf("0xaa") }));
    const reopened = await AdmissionLedger.open({ fileSystem, walRootPath: "/wal" });
    expect(reopened.liveWindows().map((record) => record.key)).toEqual(["0xaa"]);
    expect(reopened.get("0xaa")?.resolution).toEqual(resolutionOf("0xaa"));
    const foreign = resolutionOf("0xaa");
    await expect(ledger.put(admitted("0xaa", { resolution: { ...foreign, payload: { ...foreign.payload, internalMarketId: "0199b1a2-1c20-7000-8000-000000000002" } } }))).rejects.toThrow(/not its window's/u);
    await expect(ledger.put(admitted("0xaa", { resolution: { ...foreign, payload: { ...foreign.payload, outcome: "DISPUTED" as "YES_WIN" } } }))).rejects.toBeInstanceOf(GatewayStateError);
    await expect(
      ledger.put({ key: "event:9", seriesId: "s", seriesConfigHash: "a".repeat(64), status: "REFUSED", judgedAt: "2026-10-04T22:20:00.000Z", mismatches: ["m"], resolution: resolutionOf("0xaa") }),
    ).rejects.toThrow(/REFUSED record carries a resolution/u);
  });

  it("R3-FABLE-01: an OPERATOR retirement carries the operator's reason and no resolution; a reason on anything else is refused", async () => {
    const fileSystem = createMemoryFileSystem();
    const ledger = await AdmissionLedger.open({ fileSystem, walRootPath: "/wal" });
    const operator = { status: "RETIRED", retiredAt: "2026-10-04T23:20:00.000Z", retiredReason: "OPERATOR" } as const;
    await expect(ledger.put(admitted("0xaa", operator))).rejects.toThrow(/operatorReason is present exactly/u);
    await expect(ledger.put(admitted("0xaa", { ...operator, operatorReason: "gateway down 22:20-23:20; resolution missed", resolution: resolutionOf("0xaa", "2026-10-04T22:31:05.000Z") }))).rejects.toThrow(/carries a resolution/u);
    await expect(ledger.put(admitted("0xaa", { operatorReason: "not retired" }))).rejects.toThrow(/operatorReason is present exactly/u);
    await expect(ledger.put(admitted("0xaa", { ...operator, operatorReason: "x".repeat(501) }))).rejects.toBeInstanceOf(GatewayStateError);
    await ledger.put(admitted("0xaa", { ...operator, operatorReason: "gateway down 22:20-23:20; resolution missed" }));
    const reopened = await AdmissionLedger.open({ fileSystem, walRootPath: "/wal" });
    expect(reopened.get("0xaa")).toMatchObject({ status: "RETIRED", retiredReason: "OPERATOR", operatorReason: "gateway down 22:20-23:20; resolution missed" });
    expect(reopened.liveWindows()).toEqual([]);
  });

  it("bounds a refusal's mismatch list", () => {
    expect(boundedMismatches([])).toEqual(["(no mismatch recorded)"]);
    expect(boundedMismatches(Array.from({ length: 30 }, (_, index) => String(index)))).toHaveLength(12);
    expect(boundedMismatches(["x".repeat(900)])[0]?.length).toBe(500);
  });
});
