/**
 * Window classification, pin classes and lifetimes, and the pin budget
 * (`STORAGE-1`; ADR-028 Decisions 2.3, 3.1, 3.5, 3.6, 3.7).
 *
 * Acceptance lines pinned here:
 *
 * - "A window a trader is responsible for (configured or admitted) is
 *   classified only once that trader's rows for it are durable; a window only
 *   the gateway records is classified at its close."
 * - "A fill pin is never evicted or reduced; a budget overrun only alarms."
 */

import { describe, expect, it } from "vitest";

import type { MarketEvidence } from "./classify.js";
import { NON_FILL_PIN_RETENTION_MS, classifyWindow, pinRetentionMs, staticEvidenceSource } from "./classify.js";
import { pinBudget, storageMetrics } from "./metrics.js";
import type { PinRecord } from "./pins.js";
import { parseOperatorPins, parseWindowRegistry } from "./windows.js";
import type { MarketWindow } from "./windows.js";

const START = Date.parse("2026-01-01T10:30:00.000Z");
const END = Date.parse("2026-01-01T10:45:00.000Z");
const LEAD_IN = 15 * 60 * 1000;

const WINDOW: MarketWindow = {
  windowId: "w",
  marketId: "m",
  conditionId: "0xc",
  tokenIds: ["t"],
  windowStartMs: START,
  windowEndMs: END,
  responsibleFromMs: START,
  responsibility: { kind: "trader", instanceIds: ["a", "b"] },
};

const NONE: MarketEvidence = { fillsAtMs: [], intents: [], refusalsAtMs: [], haltsAtMs: [] };

async function classify(input: {
  nowMs?: number;
  durable?: Record<string, number>;
  evidence?: MarketEvidence;
  window?: MarketWindow;
}) {
  return await classifyWindow(input.window ?? WINDOW, {
    nowMs: input.nowMs ?? END + 10 * 60 * 1000,
    leadInMs: LEAD_IN,
    durabilityGraceMs: 60_000,
    evidence: staticEvidenceSource({
      durableThroughMs: new Map(Object.entries(input.durable ?? {})),
      evidence: new Map([["m", input.evidence ?? NONE]]),
    }),
  });
}

describe("a trader-responsible window is classified only once the trader's rows are durable", () => {
  it("is unclassified before it closes", async () => {
    expect(await classify({ nowMs: END - 1, durable: { a: END * 2, b: END * 2 } })).toMatchObject({ state: "unclassified" });
  });

  it("is unclassified until EVERY responsible instance's frontier passes the end plus the grace", async () => {
    expect(await classify({ durable: { a: END + 60_000, b: END + 59_999 } })).toMatchObject({ state: "unclassified" });
    expect(await classify({ durable: { a: END + 60_000 } })).toMatchObject({ state: "unclassified" });
    expect(await classify({ durable: { a: END + 60_000, b: END + 60_000 } })).toMatchObject({ state: "classified", pinClass: null });
  });

  it("is classified at its close when only the gateway records it", async () => {
    const gatewayOnly = { ...WINDOW, responsibility: { kind: "gateway-only" as const } };
    expect(await classify({ window: gatewayOnly, nowMs: END - 1 })).toMatchObject({ state: "unclassified" });
    expect(await classify({ window: gatewayOnly, nowMs: END })).toMatchObject({ state: "classified", pinClass: null });
  });
});

describe("pin classes and lifetimes (ADR-028 Decision 3)", () => {
  const durable = { a: END * 2, b: END * 2 };

  it("pins a window with a fill forever, and with an intent, a refusal or a halt for 30 days", async () => {
    const fill = await classify({ durable, evidence: { ...NONE, fillsAtMs: [START + 1] } });
    expect(fill).toMatchObject({ state: "classified", pinClass: "fill", keepUntilMs: null });
    for (const [evidence, pinClass] of [
      [{ ...NONE, intents: [{ evaluatedAtMs: START + 1, sourceEventId: null, gatewayEpoch: null, ingestSeq: null }] }, "intent"],
      [{ ...NONE, refusalsAtMs: [START + 1] }, "refusal"],
      [{ ...NONE, haltsAtMs: [START + 1] }, "halt"],
    ] as const) {
      expect(await classify({ durable, evidence })).toMatchObject({
        state: "classified",
        pinClass,
        keepUntilMs: END + NON_FILL_PIN_RETENTION_MS,
      });
    }
    expect(pinRetentionMs("fill")).toBeNull();
    expect(pinRetentionMs("intent")).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it("holds the whole window plus the lead-in, widened to every evidence instant", async () => {
    const early = START - 20 * 60 * 1000;
    const late = END + 5 * 60 * 1000;
    const classification = await classify({
      durable: { a: late * 2, b: late * 2 },
      nowMs: late + 60 * 60 * 1000,
      evidence: {
        ...NONE,
        fillsAtMs: [START + 5],
        intents: [
          { evaluatedAtMs: early, sourceEventId: null, gatewayEpoch: null, ingestSeq: null },
          { evaluatedAtMs: late, sourceEventId: null, gatewayEpoch: null, ingestSeq: null },
        ],
      },
    });
    expect(classification).toMatchObject({ pinFromMs: early - LEAD_IN, pinToMs: late });
  });
});

describe("the pin budget only alarms (ADR-028 Decision 3.6, 3.7)", () => {
  const day = "2026-01-01";
  const record = (pinId: string, bytes: number, pinClass: PinRecord["pinClass"]): PinRecord => ({
    pinRecordVersion: 1,
    pinId,
    origin: "window",
    pinClass,
    windowId: pinId,
    from: `${day}T00:00:00.000Z`,
    to: `${day}T00:30:00.000Z`,
    keepUntil: pinClass === "fill" ? null : "2026-01-31T00:30:00.000Z",
    reason: "test",
    datasets: [{ gatewayEpoch: "e", datasetId: pinId, manifestObjectKey: `pins/${pinId}/e/manifest.json`, manifestSha256: "0".repeat(64), segmentIds: ["s"], objectBytes: bytes }],
    sourceEventsInside: true,
    sourceEventsOutside: [],
    createdAt: `${day}T12:00:00.000Z`,
  });

  it("raises the alarm above the daily budget and changes no pin", () => {
    const records = [record("fill-1", 2_000, "fill"), record("intent-1", 2_000, "intent")];
    const frozen = JSON.stringify(records);
    const budget = pinBudget(records, Date.parse(`${day}T23:00:00.000Z`), 3_000);
    expect(budget).toStrictEqual({ day, bytesPinnedToday: 4_000, budgetBytesPerDay: 3_000, exceeded: true });
    // Nothing is evicted or reduced: the records are untouched.
    expect(JSON.stringify(records)).toBe(frozen);
    const metrics = storageMetrics({
      nowMs: Date.parse(`${day}T23:00:00.000Z`),
      decisions: [],
      walSegmentsUnreadable: 0,
      walBytesSealed: 0,
      disk: null,
      walMaxTotalBytes: 100,
      pinRecords: records,
      pinBudgetBytesPerDay: 3_000,
      expiryStuckAfterMs: 1,
      expiryPlansWithoutReceipt: 0,
    });
    expect(metrics.pinBudget.exceeded).toBe(true);
    expect(metrics.pinsTotal).toBe(2);
    expect(metrics.pinBytesTotal).toBe(4_000);
  });

  it("counts only pins recorded today, and stays quiet under budget", () => {
    const budget = pinBudget([record("old", 9_999, "fill")], Date.parse("2026-01-02T01:00:00.000Z"), 3_000);
    expect(budget).toMatchObject({ bytesPinnedToday: 0, exceeded: false });
  });
});

describe("expiry lag and the stuck alarm", () => {
  it("reports how long the oldest past-retention segment has been kept", () => {
    const decision = (ageEligibleAtMs: number | null) =>
      ({
        segment: { walDirectoryPath: "/w", segmentId: "s", gatewayEpoch: "e", segmentIndex: 0, byteSize: 1, closedAt: "x" },
        eligible: false,
        reasons: ["pin-not-extracted: p"],
        maxReceivedAt: null,
        ageEligibleAtMs,
        request: null,
      }) as const;
    const metrics = storageMetrics({
      nowMs: 10_000,
      decisions: [decision(1_000), decision(4_000), decision(20_000), decision(null)],
      walSegmentsUnreadable: 0,
      walBytesSealed: 95,
      disk: null,
      walMaxTotalBytes: 100,
      pinRecords: [],
      pinBudgetBytesPerDay: 1,
      expiryStuckAfterMs: 5_000,
      expiryPlansWithoutReceipt: 1,
    });
    expect(metrics.expiryLagMs).toBe(9_000);
    expect(metrics.expiryStuck).toBe(true);
    expect(metrics.segmentsKeptByReason).toStrictEqual({ "pin-not-extracted": 4 });
    expect(metrics.walCapacity).toStrictEqual({ maxTotalBytes: 100, usedBytes: 95, headroomBytes: 5, alarm: true });
  });
});

describe("the operator's files", () => {
  it("parses a window registry, refusing unsafe ids and inverted windows", () => {
    const valid = {
      windowRegistryVersion: 1,
      windows: [
        {
          windowId: "btc-updown-15m-1",
          marketId: "m",
          conditionId: "0xc",
          tokenIds: ["t"],
          windowStart: "2026-01-01T10:30:00Z",
          windowEnd: "2026-01-01T10:45:00Z",
          responsibility: { kind: "trader", instanceIds: ["i"] },
        },
      ],
    };
    expect(parseWindowRegistry(valid)[0]).toMatchObject({ windowStartMs: START, responsibleFromMs: START });
    expect(() => parseWindowRegistry({ ...valid, windows: [{ ...valid.windows[0], windowId: "../escape" }] })).toThrow(/short identifier/u);
    expect(() =>
      parseWindowRegistry({ ...valid, windows: [{ ...valid.windows[0], windowEnd: "2026-01-01T10:00:00Z" }] }),
    ).toThrow(/ends before it starts/u);
    expect(() => parseWindowRegistry({ windowRegistryVersion: 2, windows: [] })).toThrow(/windowRegistryVersion 1/u);
  });

  it("parses operator pins", () => {
    expect(
      parseOperatorPins({ operatorPinVersion: 1, pins: [{ pinId: "p1", from: "2026-01-01T00:00:00Z", to: "2026-01-01T01:00:00Z", reason: "r" }] }),
    ).toHaveLength(1);
    expect(() => parseOperatorPins({ operatorPinVersion: 1, pins: [{ pinId: "p1", from: "x", to: "y", reason: "r" }] })).toThrow();
  });
});
