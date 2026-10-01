/**
 * Window classification, pin classes and lifetimes, and the pin budget
 * (`STORAGE-1`; ADR-028 Decisions 2.3, 3.1, 3.4, 3.5, 3.6, 3.7).
 *
 * Acceptance lines pinned here:
 *
 * - "A window a trader is responsible for (configured or admitted) is
 *   classified only once that trader's rows for it are durable; a window only
 *   the gateway records is classified at its close." Durable is established
 *   in DISPATCH order (round 1, J5): a receipt instant can step backwards.
 * - "A fill pin is never evicted or reduced; a budget overrun only alarms."
 * - "Every source event in a fill's chain lies inside its pin" (J8: a source
 *   named by its dispatch identity widens the pin to its segment).
 */

import { describe, expect, it } from "vitest";

import type { InventoriedSegment } from "../research-tier/inventory.js";
import type { DispatchFrontier, MarketEvidence } from "./classify.js";
import {
  NON_FILL_PIN_RETENTION_MS,
  classifyWindow,
  dispatchFrontier,
  pinRetentionMs,
  potentialRange,
  staticEvidenceSource,
} from "./classify.js";
import { pinBudget, storageMetrics } from "./metrics.js";
import type { PinRecord } from "./pins.js";
import type { IndexedSegment, WalIndex } from "./wal-index.js";
import { UNVERIFIED_ENVELOPE_MARGIN_MS, dispatchRequirements, locateSourceEvent } from "./wal-index.js";
import { parseOperatorPins, parseWindowRegistry } from "./windows.js";
import type { MarketWindow } from "./windows.js";

const START = Date.parse("2026-01-01T10:30:00.000Z");
const END = Date.parse("2026-01-01T10:45:00.000Z");
const MIN = 60 * 1000;
const LEAD_IN = 15 * MIN;
const GRACE = 60_000;
const E = "epoch-1";

const WINDOW: MarketWindow = {
  windowId: "w",
  marketId: "m",
  conditionId: "0xc",
  gammaMarketId: null,
  tokenIds: ["t"],
  windowStartMs: START,
  windowEndMs: END,
  responsibleFromMs: START,
  responsibility: { kind: "trader", instanceIds: ["a", "b"] },
};

const NONE: MarketEvidence = { fillsAtMs: [], intents: [], refusalsAtMs: [], haltsAtMs: [] };

/** A sealed segment in the index: verified unless said otherwise. */
function seg(input: {
  readonly index: number;
  readonly first: string;
  readonly last: string;
  readonly fromMs: number;
  readonly toMs: number;
  readonly epoch?: string;
  readonly closeReason?: string;
  readonly verified?: boolean;
  readonly refused?: boolean;
}): IndexedSegment {
  const epoch = input.epoch ?? E;
  const segment: InventoriedSegment = {
    walDirectoryPath: "/wal",
    segmentId: `${epoch}-${String(input.index).padStart(6, "0")}`,
    gatewayEpoch: epoch,
    segmentIndex: input.index,
    byteSize: 1,
    createdAt: new Date(input.fromMs).toISOString(),
    closedAt: new Date(input.toMs).toISOString(),
    closeReason: input.closeReason ?? "size-rotation",
    firstIngestSeq: input.first,
    lastIngestSeq: input.last,
    firstReceivedAt: new Date(input.fromMs).toISOString(),
    lastReceivedAt: new Date(input.toMs).toISOString(),
  };
  const verified = input.verified ?? true;
  // As `buildWalIndex` does: an unverified segment's span is its sidecar's, widened.
  const margin = verified ? 0 : UNVERIFIED_ENVELOPE_MARGIN_MS;
  return {
    segment,
    verified,
    refused: input.refused ?? false,
    firstIngestSeq: input.first,
    lastIngestSeq: input.last,
    span: { fromMs: input.fromMs - margin, toMs: input.toMs + margin },
  };
}

function wal(segments: readonly IndexedSegment[], unreadable = 0): WalIndex {
  const byEpoch = new Map<string, IndexedSegment[]>();
  for (const entry of segments) {
    const list = byEpoch.get(entry.segment.gatewayEpoch) ?? [];
    list.push(entry);
    byEpoch.set(entry.segment.gatewayEpoch, list);
  }
  return { byEpoch, unreadable };
}

/**
 * The usual WAL: one segment before and through the window, one past its
 * end, and one sealed after the window's range (it closes the range).
 */
const USUAL = wal([
  seg({ index: 0, first: "1", last: "10", fromMs: START - 20 * MIN, toMs: START + 5 * MIN }),
  seg({ index: 1, first: "11", last: "20", fromMs: START + 5 * MIN, toMs: END + 30_000 }),
  seg({ index: 2, first: "21", last: "30", fromMs: END + 2 * MIN, toMs: END + 10 * MIN }),
]);

const PASSED = dispatchFrontier({ [E]: "30" });

async function classify(input: {
  nowMs?: number;
  frontiers?: Record<string, DispatchFrontier>;
  evidence?: MarketEvidence;
  window?: MarketWindow;
  wal?: WalIndex;
}) {
  return await classifyWindow(input.window ?? WINDOW, {
    nowMs: input.nowMs ?? END + 10 * MIN,
    leadInMs: LEAD_IN,
    durabilityGraceMs: GRACE,
    evidence: staticEvidenceSource({
      frontiers: new Map(Object.entries(input.frontiers ?? { a: PASSED, b: PASSED })),
      evidence: new Map([["m", input.evidence ?? NONE]]),
    }),
    wal: input.wal ?? USUAL,
  });
}

describe("a trader-responsible window is classified only once the trader's rows are durable, in dispatch order", () => {
  it("is unclassified before it closes, and before the grace after its end", async () => {
    expect(await classify({ nowMs: END - 1 })).toMatchObject({ state: "unclassified", reason: "the window has not closed" });
    expect(await classify({ nowMs: END + GRACE - 1 })).toMatchObject({ state: "unclassified" });
    expect(await classify({ nowMs: END + GRACE })).toMatchObject({ state: "classified", pinClass: null });
  });

  it("requires EVERY responsible instance to have passed the first sealed segment after the window's range", async () => {
    expect(dispatchRequirements(USUAL, potentialRange(WINDOW, LEAD_IN, GRACE))).toStrictEqual({
      ok: true,
      requirements: [{ gatewayEpoch: E, kind: "past-segment", ingestSeq: "30" }],
    });
    expect(await classify({ frontiers: { a: PASSED, b: dispatchFrontier({ [E]: "29" }) } })).toMatchObject({
      state: "unclassified",
      reason: expect.stringMatching(/instance b has not durably processed epoch epoch-1 past ingestSeq 30/u),
    });
    expect(await classify({ frontiers: { a: PASSED } })).toMatchObject({
      state: "unclassified",
      reason: expect.stringMatching(/instance b has no durable decision carrying a dispatch position/u),
    });
    // Integer order, not text order: "100" is past "30".
    expect(await classify({ frontiers: { a: dispatchFrontier({ [E]: "100" }), b: PASSED } })).toMatchObject({ state: "classified" });
    // An instance that moved on to a later epoch within its run has completed this one.
    expect(await classify({ frontiers: { a: dispatchFrontier({ [E]: "5" }, [E]), b: PASSED } })).toMatchObject({ state: "classified" });
  });

  it("is NOT classified by a frontier whose newest stamp is past the window, while an earlier-stamped frame later in dispatch order is unprocessed (J5)", async () => {
    // F1 (ingestSeq 1) is stamped end + 120 s and durable; F2 (ingestSeq 2),
    // later in dispatch order, steps back to end - 1 s and is NOT processed.
    // max(evaluated_at) = end + 120 s would have passed end + grace.
    const steppedBack = wal([
      seg({ index: 0, first: "1", last: "2", fromMs: END - 1000, toMs: END + 120_000 }),
      seg({ index: 1, first: "3", last: "4", fromMs: END + 5 * MIN, toMs: END + 6 * MIN }),
    ]);
    const onlyF1 = dispatchFrontier({ [E]: "1" });
    expect(await classify({ wal: steppedBack, frontiers: { a: onlyF1, b: onlyF1 } })).toMatchObject({
      state: "unclassified",
      reason: expect.stringMatching(/past ingestSeq 4/u),
    });
    // Past F2 but not past the segment sealed after the range: still not enough.
    const throughF2 = dispatchFrontier({ [E]: "3" });
    expect(await classify({ wal: steppedBack, frontiers: { a: throughF2, b: throughF2 } })).toMatchObject({ state: "unclassified" });
    const past = dispatchFrontier({ [E]: "4" });
    expect(await classify({ wal: steppedBack, frontiers: { a: past, b: past } })).toMatchObject({ state: "classified" });
  });

  it("waits until the sealed WAL has moved past the window, and until the epoch has sealed a segment after it", async () => {
    // Nothing sealed after the range: the window's tail may be in the open segment.
    const notPast = wal([seg({ index: 0, first: "1", last: "10", fromMs: START - 20 * MIN, toMs: END })]);
    expect(await classify({ wal: notPast })).toMatchObject({
      state: "unclassified",
      reason: expect.stringMatching(/has not yet moved past the window's range/u),
    });
    // The epoch's last overlapping segment is its newest, and the epoch did not end.
    const newestOverlaps = wal([
      seg({ index: 0, first: "1", last: "10", fromMs: START - 20 * MIN, toMs: END + 30 * MIN }),
      seg({ index: 0, first: "1", last: "3", fromMs: END + 40 * MIN, toMs: END + 50 * MIN, epoch: "epoch-2" }),
    ]);
    expect(await classify({ wal: newestOverlaps })).toMatchObject({
      state: "unclassified",
      reason: expect.stringMatching(/epoch epoch-1 has not sealed a segment after the window's range/u),
    });
    // An epoch that ENDED there needs the trader past its last frame.
    const ended = wal([
      seg({ index: 0, first: "1", last: "10", fromMs: START - 20 * MIN, toMs: END + 30 * MIN, closeReason: "shutdown" }),
      seg({ index: 0, first: "1", last: "3", fromMs: END + 40 * MIN, toMs: END + 50 * MIN, epoch: "epoch-2" }),
    ]);
    const atLast = dispatchFrontier({ [E]: "10" });
    expect(await classify({ wal: ended, frontiers: { a: atLast, b: atLast } })).toMatchObject({ state: "unclassified" });
    const pastLast = dispatchFrontier({ [E]: "11" });
    expect(await classify({ wal: ended, frontiers: { a: pastLast, b: pastLast } })).toMatchObject({ state: "classified" });
  });

  it("is held by an unreadable sealed segment, and by an unverified one it could overlap", async () => {
    expect(await classify({ wal: wal([...USUAL.byEpoch.get(E) ?? []], 1) })).toMatchObject({
      state: "unclassified",
      reason: expect.stringMatching(/unreadable sidecar/u),
    });
    // Segment 2 is not extracted yet: its sidecar envelope (± 1 h) overlaps,
    // so the trader must pass the next one too.
    const unverified = wal([
      ...(USUAL.byEpoch.get(E) ?? []).slice(0, 2),
      seg({ index: 2, first: "21", last: "30", fromMs: END + 2 * MIN, toMs: END + 10 * MIN, verified: false }),
      seg({ index: 3, first: "31", last: "40", fromMs: END + 2 * 60 * MIN, toMs: END + 3 * 60 * MIN }),
    ]);
    expect(await classify({ wal: unverified })).toMatchObject({ state: "unclassified", reason: expect.stringMatching(/past ingestSeq 40/u) });
  });

  it("is classified at its close when only the gateway records it", async () => {
    const gatewayOnly = { ...WINDOW, responsibility: { kind: "gateway-only" as const } };
    expect(await classify({ window: gatewayOnly, nowMs: END - 1 })).toMatchObject({ state: "unclassified" });
    expect(await classify({ window: gatewayOnly, nowMs: END, frontiers: {} })).toMatchObject({ state: "classified", pinClass: null });
  });
});

describe("a fill chain's source event named by its dispatch identity (ADR-028 Decision 3.4; J8)", () => {
  const withEarlySource = wal([
    seg({ index: 0, first: "1", last: "2", fromMs: START - 61 * MIN, toMs: START - 60 * MIN }),
    seg({ index: 1, first: "3", last: "3", fromMs: START - 30 * MIN, toMs: START - 30 * MIN }),
    ...(USUAL.byEpoch.get(E) ?? []).map((entry, position) =>
      seg({
        index: position + 2,
        first: String(Number(entry.firstIngestSeq) + 3),
        last: String(Number(entry.lastIngestSeq) + 3),
        fromMs: entry.span?.fromMs ?? 0,
        toMs: entry.span?.toMs ?? 0,
      }),
    ),
  ]);
  const frontier = dispatchFrontier({ [E]: "33" });
  const evidence = (ingestSeq: string): MarketEvidence => ({
    ...NONE,
    fillsAtMs: [START + 4 * MIN],
    intents: [{ evaluatedAtMs: START + 3 * MIN, sourceEventId: "src", gatewayEpoch: E, ingestSeq }],
  });

  it("widens the pin to the whole span of the segment holding it, then the lead-in", async () => {
    expect(locateSourceEvent(withEarlySource, E, "2")).toMatchObject({ status: "located", segmentId: `${E}-000000` });
    const classification = await classify({ wal: withEarlySource, frontiers: { a: frontier, b: frontier }, evidence: evidence("2") });
    expect(classification).toMatchObject({ state: "classified", pinClass: "fill", pinFromMs: START - 61 * MIN - LEAD_IN, pinToMs: END });
  });

  it("keeps the window unclassified while the source event's segment is not sealed or not verified yet", async () => {
    const pending = await classify({ wal: withEarlySource, frontiers: { a: frontier, b: frontier }, evidence: evidence("99") });
    expect(pending).toMatchObject({ state: "unclassified", reason: expect.stringMatching(/not sealed and verified yet/u) });
    const unextracted = wal([
      seg({ index: 0, first: "1", last: "2", fromMs: START - 61 * MIN, toMs: START - 60 * MIN, verified: false }),
      ...(withEarlySource.byEpoch.get(E) ?? []).slice(1),
    ]);
    expect(locateSourceEvent(unextracted, E, "2")).toMatchObject({ status: "pending" });
  });

  it("classifies a lost source (its segment gone, or refused) without widening: the pin then records it outside", async () => {
    const gone = wal((withEarlySource.byEpoch.get(E) ?? []).slice(1));
    expect(locateSourceEvent(gone, E, "2")).toMatchObject({ status: "lost" });
    const refused = wal([
      seg({ index: 0, first: "1", last: "2", fromMs: START - 61 * MIN, toMs: START - 60 * MIN, verified: false, refused: true }),
      ...(withEarlySource.byEpoch.get(E) ?? []).slice(1),
    ]);
    expect(locateSourceEvent(refused, E, "2")).toMatchObject({ status: "lost" });
    const classification = await classify({ wal: gone, frontiers: { a: frontier, b: frontier }, evidence: evidence("2") });
    expect(classification).toMatchObject({ state: "classified", pinFromMs: START - LEAD_IN });
  });

  it("locates an event dispatched just after a segment's last frame in that segment, and one in a gap as lost", async () => {
    // Events take ingest sequence numbers between raw frames: "6" and "7"
    // were dispatched after segment 0's last frame ("5") and before segment
    // 1's first ("8"), so segment 0 holds the frame they came from.
    const interleaved = wal([
      seg({ index: 0, first: "1", last: "5", fromMs: START - 61 * MIN, toMs: START - 60 * MIN }),
      seg({ index: 1, first: "8", last: "9", fromMs: START, toMs: END + 5 * MIN }),
    ]);
    expect(locateSourceEvent(interleaved, E, "7")).toMatchObject({ status: "located", segmentId: `${E}-000000` });
    expect(locateSourceEvent(interleaved, E, "8")).toMatchObject({ status: "located", segmentId: `${E}-000001` });
    // After the newest sealed segment's last frame: it may still be in the open segment.
    expect(locateSourceEvent(interleaved, E, "10")).toMatchObject({ status: "pending" });
    const gap = wal([
      seg({ index: 0, first: "1", last: "2", fromMs: START - 61 * MIN, toMs: START - 60 * MIN }),
      seg({ index: 2, first: "10", last: "12", fromMs: START, toMs: END + 5 * MIN }),
    ]);
    expect(locateSourceEvent(gap, E, "5")).toMatchObject({ status: "lost" });
  });
});

describe("pin classes and lifetimes (ADR-028 Decision 3)", () => {
  it("pins a window with a fill forever, and with an intent, a refusal or a halt for 30 days", async () => {
    const fill = await classify({ evidence: { ...NONE, fillsAtMs: [START + 1] } });
    expect(fill).toMatchObject({ state: "classified", pinClass: "fill", keepUntilMs: null });
    for (const [evidence, pinClass] of [
      [{ ...NONE, intents: [{ evaluatedAtMs: START + 1, sourceEventId: null, gatewayEpoch: null, ingestSeq: null }] }, "intent"],
      [{ ...NONE, refusalsAtMs: [START + 1] }, "refusal"],
      [{ ...NONE, haltsAtMs: [START + 1] }, "halt"],
    ] as const) {
      expect(await classify({ evidence })).toMatchObject({
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
      walOrphanSidecars: 0,
      walBytesSealed: 0,
      walEpochWrittenBytes: new Map(),
      disk: null,
      walMaxTotalBytes: 100,
      clock: { status: "unchecked", stepMs: 0, skewMs: 0 },
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
  const decision = (retentionDueAtMs: number | null, reason = "pin-not-extracted: p") =>
    ({
      segment: {
        walDirectoryPath: "/w",
        segmentId: "s",
        gatewayEpoch: "e",
        segmentIndex: 0,
        byteSize: 1,
        createdAt: "x",
        closedAt: "x",
        closeReason: "size-rotation",
        firstIngestSeq: null,
        lastIngestSeq: null,
        firstReceivedAt: null,
        lastReceivedAt: null,
      },
      eligible: false,
      reasons: [reason],
      minReceivedAt: null,
      maxReceivedAt: null,
      ageEligibleAtMs: retentionDueAtMs,
      retentionDueAtMs,
      request: null,
    }) as const;

  it("reports how long the oldest past-retention segment has been kept", () => {
    const metrics = storageMetrics({
      nowMs: 10_000,
      decisions: [decision(1_000), decision(4_000), decision(20_000), decision(null)],
      walSegmentsUnreadable: 0,
      walOrphanSidecars: 0,
      walBytesSealed: 95,
      walEpochWrittenBytes: new Map([["e", 95]]),
      disk: null,
      walMaxTotalBytes: 100,
      clock: { status: "unchecked", stepMs: 0, skewMs: 0 },
      pinRecords: [],
      pinBudgetBytesPerDay: 1,
      expiryStuckAfterMs: 5_000,
      expiryPlansWithoutReceipt: 1,
    });
    expect(metrics.expiryLagMs).toBe(9_000);
    expect(metrics.expiryStuck).toBe(true);
    expect(metrics.segmentsKeptByReason).toStrictEqual({ "pin-not-extracted": 4 });
  });

  it("counts a segment the extract path cannot verify, by its sidecar's closedAt (J14)", () => {
    const notExtracted = { ...decision(null, "not-extracted: no verified research tier names this segment"), retentionDueAtMs: 2_000 };
    const metrics = storageMetrics({
      nowMs: 10_000,
      decisions: [notExtracted],
      walSegmentsUnreadable: 0,
      walOrphanSidecars: 0,
      walBytesSealed: 1,
      walEpochWrittenBytes: new Map(),
      disk: null,
      walMaxTotalBytes: null,
      clock: { status: "unchecked", stepMs: 0, skewMs: 0 },
      pinRecords: [],
      pinBudgetBytesPerDay: 1,
      expiryStuckAfterMs: 5_000,
      expiryPlansWithoutReceipt: 0,
    });
    expect(metrics.expiryLagMs).toBe(8_000);
    expect(metrics.expiryStuck).toBe(true);
  });

  it("measures WAL capacity as the writer counts it: the largest epoch's bytes, expired ones included (J10)", () => {
    const metrics = storageMetrics({
      nowMs: 10_000,
      decisions: [],
      walSegmentsUnreadable: 0,
      walOrphanSidecars: 2,
      walBytesSealed: 30,
      // Epoch e: 20 on disk + 75 expired; epoch f: 10 on disk.
      walEpochWrittenBytes: new Map([["e", 95], ["f", 10]]),
      disk: null,
      walMaxTotalBytes: 100,
      clock: { status: "steady", stepMs: 0, skewMs: 0 },
      pinRecords: [],
      pinBudgetBytesPerDay: 1,
      expiryStuckAfterMs: 5_000,
      expiryPlansWithoutReceipt: 0,
    });
    expect(metrics.walCapacity).toStrictEqual({
      maxTotalBytes: 100,
      sealedBytesOnDisk: 30,
      largestEpoch: "e",
      largestEpochWrittenBytes: 95,
      headroomBytes: 5,
      alarm: true,
    });
    expect(metrics.walOrphanSidecars).toBe(2);
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
    expect(() => parseWindowRegistry(valid)).toThrow(/responsibleFrom is required for a trader-responsible window/u);
    const withFrom = { ...valid, windows: [{ ...valid.windows[0], responsibleFrom: "2026-01-01T10:16:00Z" }] };
    expect(parseWindowRegistry(withFrom)[0]).toMatchObject({ windowStartMs: START, responsibleFromMs: Date.parse("2026-01-01T10:16:00Z") });
    const gatewayOnly = { ...valid, windows: [{ ...valid.windows[0], responsibility: { kind: "gateway-only" } }] };
    expect(parseWindowRegistry(gatewayOnly)[0]).toMatchObject({ responsibleFromMs: START });
    // A trader cannot be responsible from AFTER the window opens (J16, M10).
    expect(() => parseWindowRegistry({ ...valid, windows: [{ ...valid.windows[0], responsibleFrom: "2026-01-01T10:31:00Z" }] })).toThrow(
      /responsibleFrom must not be after windowStart/u,
    );
    expect(() => parseWindowRegistry({ ...withFrom, windows: [{ ...withFrom.windows[0], windowId: "../escape" }] })).toThrow(/short identifier/u);
    expect(() =>
      parseWindowRegistry({ ...withFrom, windows: [{ ...withFrom.windows[0], windowEnd: "2026-01-01T10:00:00Z" }] }),
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
