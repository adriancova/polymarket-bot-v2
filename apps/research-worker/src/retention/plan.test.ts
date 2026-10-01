/**
 * The expiry decision (`STORAGE-1`; ADR-028 Decision 2), pinned case by case.
 *
 * Acceptance lines pinned here:
 *
 * - "A segment is never deleted unless it is 72 h old, its research tier is
 *   verified, its windows are classified, and every overlapping pin is
 *   verified."
 * - "The 72 h age is taken from the maximum receivedAt over the segment's
 *   verified frames, not from its last frame. A test pins that a segment
 *   whose frames, in dispatch order, are 71 h then 73 h old is kept."
 * - "A pinned or unclassified segment is never deleted."
 * - "Every source event in a fill's chain lies inside its pin."
 */

import { afterEach, describe, expect, it } from "vitest";

import { nodeCompactionFileSystem } from "@polymarket-bot/storage-parquet";

import { readResearchPointer, researchPointerKey } from "../research-tier/extract.js";
import type { WalInventory } from "../research-tier/inventory.js";
import { EPOCH, HOUR, bookFrame, storageFixture, tradeFrame } from "../testing/storage-fixture.js";
import type { StorageFixture } from "../testing/storage-fixture.js";
import type { MarketEvidence, WindowClassification } from "./classify.js";
import { classifyWindow, staticEvidenceSource } from "./classify.js";
import { extractPin, pinSpecs, readPinRecord, windowPinId } from "./pins.js";
import type { PinRecord } from "./pins.js";
import { RAW_RETENTION_MS, planExpiry } from "./plan.js";
import type { SegmentDecision } from "./plan.js";
import type { MarketWindow, OperatorPin } from "./windows.js";

const NOW = Date.parse("2026-01-10T00:00:00.000Z");
const LEAD_IN = 15 * 60 * 1000;
const OLD = NOW - 80 * HOUR;

const WINDOW: MarketWindow = {
  windowId: "w1",
  marketId: "m1",
  conditionId: "0xc1",
  gammaMarketId: "5121169",
  tokenIds: ["tokA"],
  windowStartMs: OLD + 30 * 60 * 1000,
  windowEndMs: OLD + 45 * 60 * 1000,
  responsibleFromMs: OLD + 30 * 60 * 1000,
  responsibility: { kind: "trader", instanceIds: ["inst-1"] },
};

const NO_EVIDENCE: MarketEvidence = { fillsAtMs: [], intents: [], refusalsAtMs: [], haltsAtMs: [] };

let fixture: StorageFixture | null = null;

afterEach(async () => {
  await fixture?.cleanup();
  fixture = null;
});

/**
 * Three segments:
 * 0. old (80 h), Polymarket frames for the window's token and trades;
 * 1. the 71 h / 73 h case: dispatched 71 h old THEN 73 h old (reference only);
 * 2. young (2 h old).
 */
async function threeSegments(extraFrames: Parameters<typeof bookFrame>[0][] = []): Promise<{ inventory: WalInventory }> {
  fixture = await storageFixture({
    nowMs: NOW,
    segments: [
      [
        tradeFrame({ ingestSeq: "1", atMs: OLD + 20 * 60 * 1000 }),
        bookFrame({ ingestSeq: "2", atMs: OLD + 35 * 60 * 1000, tokenId: "tokA", conditionId: "0xc1" }),
        ...extraFrames.map((frame) => bookFrame(frame)),
        tradeFrame({ ingestSeq: "9", atMs: OLD + 50 * 60 * 1000 }),
      ],
      [
        tradeFrame({ ingestSeq: "10", atMs: NOW - 71 * HOUR }),
        tradeFrame({ ingestSeq: "11", atMs: NOW - 73 * HOUR }),
      ],
      [tradeFrame({ ingestSeq: "12", atMs: NOW - 2 * HOUR })],
    ],
  });
  return { inventory: await fixture.extract() };
}

async function classifyWith(
  window: MarketWindow,
  durableThroughMs: number | null,
  evidence: MarketEvidence = NO_EVIDENCE,
): Promise<Map<string, WindowClassification>> {
  const source = staticEvidenceSource({
    durableThroughMs: durableThroughMs === null ? new Map() : new Map([["inst-1", durableThroughMs]]),
    evidence: new Map([[window.marketId, evidence]]),
  });
  const classification = await classifyWindow(window, { nowMs: NOW, leadInMs: LEAD_IN, durabilityGraceMs: 60_000, evidence: source });
  return new Map([[window.windowId, classification]]);
}

async function decide(input: {
  readonly inventory: WalInventory;
  readonly windows?: readonly MarketWindow[];
  readonly classifications: Map<string, WindowClassification>;
  readonly operatorPins?: readonly OperatorPin[];
  readonly extractPins?: boolean;
}): Promise<readonly SegmentDecision[]> {
  if (fixture === null) throw new Error("no fixture");
  const operatorPins = input.operatorPins ?? [];
  const specs = pinSpecs([...input.classifications.values()], operatorPins);
  const records = new Map<string, PinRecord | null>();
  for (const spec of specs) {
    if (input.extractPins === true) {
      await extractPin(spec, {
        objectStore: fixture.objectStore,
        fileSystem: nodeCompactionFileSystem(),
        clock: fixture.clock,
        segments: [...input.inventory.byEpoch.values()].flat(),
        pointers: await pointersOf(input.inventory),
        refusedSegmentIds: new Set(),
      });
    }
    records.set(spec.pinId, await readPinRecord(fixture.objectStore, spec.pinId));
  }
  return await planExpiry({
    nowMs: NOW,
    retentionMs: RAW_RETENTION_MS,
    leadInMs: LEAD_IN,
    inventory: input.inventory,
    objectStore: fixture.objectStore,
    windows: input.windows ?? [WINDOW],
    classifications: input.classifications,
    operatorPins,
    pinSpecs: specs,
    pinRecords: records,
  });
}

async function pointersOf(inventory: WalInventory) {
  if (fixture === null) throw new Error("no fixture");
  const pointers = new Map();
  for (const segment of [...inventory.byEpoch.values()].flat()) {
    const pointer = await readResearchPointer(fixture.objectStore, EPOCH, segment.segmentId);
    if (pointer !== null) pointers.set(segment.segmentId, pointer);
  }
  return pointers;
}

function bySegmentIndex(decisions: readonly SegmentDecision[], index: number): SegmentDecision {
  const decision = decisions.find((candidate) => candidate.segment.segmentIndex === index);
  if (decision === undefined) throw new Error(`no decision for segment ${String(index)}`);
  return decision;
}

describe("the 72 h age is the maximum over every frame (ADR-028 Decision 2.1)", () => {
  it("keeps a segment whose frames, in dispatch order, are 71 h then 73 h old", async () => {
    const { inventory } = await threeSegments();
    const decisions = await decide({ inventory, classifications: await classifyWith(WINDOW, NOW) });
    const seventyOne = bySegmentIndex(decisions, 1);
    expect(seventyOne.eligible).toBe(false);
    expect(seventyOne.maxReceivedAt).toBe(new Date(NOW - 71 * HOUR).toISOString());
    expect(seventyOne.reasons.some((reason) => reason.startsWith("younger-than-retention"))).toBe(true);
    // It becomes eligible once its NEWEST frame is 72 h old, not before.
    expect(seventyOne.ageEligibleAtMs).toBe(NOW - 71 * HOUR + RAW_RETENTION_MS);
    expect(bySegmentIndex(decisions, 2).reasons.some((reason) => reason.startsWith("younger-than-retention"))).toBe(true);
  });
});

describe("classification holds every segment it could overlap (ADR-028 Decision 2.3)", () => {
  it("keeps an old segment while its trader's rows are not durable past the window", async () => {
    const { inventory } = await threeSegments();
    const decisions = await decide({ inventory, classifications: await classifyWith(WINDOW, WINDOW.windowEndMs) });
    const old = bySegmentIndex(decisions, 0);
    expect(old.eligible).toBe(false);
    expect(old.reasons).toContainEqual(expect.stringMatching(/^unclassified-window: w1/u));
  });

  it("keeps it while the trader has no durable rows at all (stopped)", async () => {
    const { inventory } = await threeSegments();
    const decisions = await decide({ inventory, classifications: await classifyWith(WINDOW, null) });
    expect(bySegmentIndex(decisions, 0).reasons).toContainEqual(expect.stringMatching(/^unclassified-window/u));
  });

  it("lets it expire once the window is classified unpinned and the research tier verifies", async () => {
    const { inventory } = await threeSegments();
    const decisions = await decide({ inventory, classifications: await classifyWith(WINDOW, NOW) });
    const old = bySegmentIndex(decisions, 0);
    expect(old.reasons).toStrictEqual([]);
    expect(old.eligible).toBe(true);
    expect(old.request?.pins).toStrictEqual([]);
    expect(old.request?.segmentFileSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("keeps a segment whose frames name a market no window registers (unclassified by definition)", async () => {
    const { inventory } = await threeSegments([{ ingestSeq: "3", atMs: OLD + 36 * 60 * 1000, tokenId: "tokZ", conditionId: "0xcZ" }]);
    const decisions = await decide({ inventory, classifications: await classifyWith(WINDOW, NOW) });
    expect(bySegmentIndex(decisions, 0).reasons).toContainEqual(expect.stringMatching(/^unknown-market: token tokZ/u));
  });

  it("identifies a Gamma poll by its endpoint: a registered id is known, another is unclassified", async () => {
    const gammaPoll = (ingestSeq: string, id: string) => ({
      ingestSeq,
      receivedAt: new Date(OLD + 37 * 60 * 1000).toISOString(),
      source: "polymarket",
      endpoint: `https://gamma-api.polymarket.com/markets/${id}`,
      // A body naming another condition: the body is never read for identity.
      payloadUtf8: JSON.stringify({ id, conditionId: "0xNOT-REGISTERED", active: true, closed: false, acceptingOrders: true }),
    });
    fixture = await storageFixture({
      nowMs: NOW,
      segments: [
        [tradeFrame({ ingestSeq: "1", atMs: OLD }), gammaPoll("2", "5121169")],
        [tradeFrame({ ingestSeq: "3", atMs: OLD + 50 * 60 * 1000 }), gammaPoll("4", "999")],
        [tradeFrame({ ingestSeq: "5", atMs: NOW - HOUR })],
      ],
    });
    const inventory = await fixture.extract();
    const decisions = await decide({ inventory, classifications: await classifyWith(WINDOW, NOW) });
    expect(bySegmentIndex(decisions, 0).reasons).toStrictEqual([]);
    expect(bySegmentIndex(decisions, 1).reasons).toStrictEqual(["unknown-market: Gamma market 999 belongs to no registered window"]);
  });

  it("keeps everything Polymarket names when no registry is configured", async () => {
    const { inventory } = await threeSegments();
    const decisions = await decide({ inventory, windows: [], classifications: new Map() });
    expect(bySegmentIndex(decisions, 0).reasons).toContainEqual(expect.stringMatching(/^unknown-market/u));
  });
});

describe("the research tier must be written and verified (ADR-028 Decision 2.2)", () => {
  it("keeps a segment with no research tier", async () => {
    const { inventory } = await threeSegments();
    if (fixture === null) throw new Error("no fixture");
    const segment = bySegmentIndex(await decide({ inventory, classifications: await classifyWith(WINDOW, NOW) }), 0).segment;
    const { rm } = await import("node:fs/promises");
    const { join } = await import("node:path");
    await rm(join(fixture.root, "objects", researchPointerKey(EPOCH, segment.segmentId)));
    const decisions = await decide({ inventory, classifications: await classifyWith(WINDOW, NOW) });
    expect(bySegmentIndex(decisions, 0).reasons).toContainEqual(expect.stringMatching(/^not-extracted/u));
  });

  it("keeps a segment whose research tier no longer verifies", async () => {
    const { inventory } = await threeSegments();
    if (fixture === null) throw new Error("no fixture");
    const pointer = await readResearchPointer(fixture.objectStore, EPOCH, bySegmentIndex(await decide({ inventory, classifications: await classifyWith(WINDOW, NOW) }), 0).segment.segmentId);
    const { writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    await writeFile(join(fixture.root, "objects", (pointer?.manifestObjectKey ?? "").replace("manifest.json", "ref_trade_bars.parquet")), "rot");
    const decisions = await decide({ inventory, classifications: await classifyWith(WINDOW, NOW) });
    expect(bySegmentIndex(decisions, 0).reasons).toContainEqual(expect.stringMatching(/^research-tier-not-verified/u));
  });
});

describe("pins: every overlapping pin extracted and verified; operator pins keep the raw segment", () => {
  const intent = (atMs: number, ingestSeq: string | null = null) => ({
    evaluatedAtMs: atMs,
    sourceEventId: null,
    gatewayEpoch: ingestSeq === null ? null : EPOCH,
    ingestSeq,
  });

  it("keeps an old segment while the window's pin is not extracted, and lets it go once it is", async () => {
    const { inventory } = await threeSegments();
    const evidence: MarketEvidence = { ...NO_EVIDENCE, fillsAtMs: [OLD + 40 * 60 * 1000], intents: [intent(OLD + 35 * 60 * 1000)] };
    const classifications = await classifyWith(WINDOW, NOW, evidence);
    const before = await decide({ inventory, classifications });
    expect(bySegmentIndex(before, 0).reasons).toContainEqual(expect.stringMatching(/^pin-not-extracted: window-w1-[0-9a-f]{12}$/u));
    const after = await decide({ inventory, classifications, extractPins: true });
    const old = bySegmentIndex(after, 0);
    expect(old.reasons).toStrictEqual([]);
    expect(old.request?.pins.map((pin) => pin.pinId)).toStrictEqual([expect.stringMatching(/^window-w1-[0-9a-f]{12}$/u)]);
  });

  it("a fill pin is kept forever; it holds every chain source event, the window and the lead-in", async () => {
    const { inventory } = await threeSegments();
    const evidence: MarketEvidence = { ...NO_EVIDENCE, fillsAtMs: [OLD + 40 * 60 * 1000], intents: [intent(OLD + 21 * 60 * 1000)] };
    const classifications = await classifyWith(WINDOW, NOW, evidence);
    const classification = classifications.get("w1");
    if (classification?.state !== "classified") throw new Error("expected classified");
    expect(classification.pinClass).toBe("fill");
    expect(classification.keepUntilMs).toBeNull();
    // Widened to the decision before the window, then the lead-in before that.
    expect(classification.pinFromMs).toBe(OLD + 21 * 60 * 1000 - LEAD_IN);
    expect(classification.pinToMs).toBe(WINDOW.windowEndMs);
    await decide({ inventory, classifications, extractPins: true });
    if (fixture === null) throw new Error("no fixture");
    const record = await readPinRecord(
      fixture.objectStore,
      windowPinId("w1", "fill", classification.pinFromMs ?? 0, classification.pinToMs ?? 0),
    );
    expect(record?.sourceEventsInside).toBe(true);
    expect(record?.keepUntil).toBeNull();
  });

  it("keeps a segment whose overlapping pin does not hold a chain source event", async () => {
    const { inventory } = await threeSegments();
    // The decision's source frame is in the YOUNG segment, outside the pinned range.
    const evidence: MarketEvidence = { ...NO_EVIDENCE, fillsAtMs: [OLD + 40 * 60 * 1000], intents: [intent(OLD + 35 * 60 * 1000, "12")] };
    const classifications = await classifyWith(WINDOW, NOW, evidence);
    const decisions = await decide({ inventory, classifications, extractPins: true });
    expect(bySegmentIndex(decisions, 0).reasons).toContainEqual(expect.stringMatching(/^pin-trace-incomplete: window-w1/u));
  });

  it("an operator pin keeps every segment it covers, extracted or not", async () => {
    const { inventory } = await threeSegments();
    const operatorPins: OperatorPin[] = [{ pinId: "keep-me", fromMs: OLD, toMs: OLD + 60 * 60 * 1000, reason: "review" }];
    const decisions = await decide({ inventory, classifications: await classifyWith(WINDOW, NOW), operatorPins, extractPins: true });
    expect(bySegmentIndex(decisions, 0).reasons).toStrictEqual(["operator-pin: operator-keep-me"]);
  });

  it("a gateway-only window is classified at its close and pins nothing", async () => {
    const { inventory } = await threeSegments();
    const gatewayOnly: MarketWindow = { ...WINDOW, responsibility: { kind: "gateway-only" } };
    const classification = await classifyWindow(gatewayOnly, {
      nowMs: NOW,
      leadInMs: LEAD_IN,
      durabilityGraceMs: 60_000,
      evidence: staticEvidenceSource({ durableThroughMs: new Map(), evidence: new Map() }),
    });
    expect(classification).toMatchObject({ state: "classified", pinClass: null });
    const decisions = await decide({ inventory, windows: [gatewayOnly], classifications: new Map([["w1", classification]]) });
    expect(bySegmentIndex(decisions, 0).eligible).toBe(true);
  });
});
