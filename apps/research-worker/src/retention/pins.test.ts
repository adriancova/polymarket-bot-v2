/**
 * Pin extraction (`STORAGE-1`; ADR-028 Decisions 2.4, 2.6, 3.3, 3.4).
 *
 * - A pin waits until every sealed segment is extracted and the WAL has moved
 *   past its range; it never pins a partial range.
 * - A pin holds whole segments, each with the same two digests the research
 *   tier pinned (Decision 2.6); a segment whose bytes differ from what the
 *   research tier verified is refused, not pinned.
 * - A segment that overlaps a pin's range but is not held by it is kept.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { nodeCompactionFileSystem } from "@polymarket-bot/storage-parquet";
import { buildSegmentFixture } from "@polymarket-bot/storage-parquet/testing";

import type { ResearchPointer } from "../research-tier/extract.js";
import { readResearchPointer } from "../research-tier/extract.js";
import type { WalInventory } from "../research-tier/inventory.js";
import { EPOCH, HOUR, storageFixture, tradeFrame } from "../testing/storage-fixture.js";
import type { StorageFixture } from "../testing/storage-fixture.js";
import { extractPin, readPinRecord } from "./pins.js";
import type { PinSpec } from "./pins.js";
import { RAW_RETENTION_MS, planExpiry } from "./plan.js";

const NOW = Date.parse("2026-01-10T00:00:00.000Z");
const T = NOW - 80 * HOUR;

let fixture: StorageFixture | null = null;

afterEach(async () => {
  await fixture?.cleanup();
  fixture = null;
});

function spec(fromMs: number, toMs: number): PinSpec {
  return {
    pinId: "operator-test",
    origin: "operator",
    pinClass: "operator",
    windowId: null,
    fromMs,
    toMs,
    keepUntilMs: null,
    sourceEvents: [],
    reason: "test",
  };
}

async function context(inventory: WalInventory) {
  if (fixture === null) throw new Error("no fixture");
  const pointers = new Map<string, ResearchPointer>();
  for (const segment of [...inventory.byEpoch.values()].flat()) {
    const pointer = await readResearchPointer(fixture.objectStore, EPOCH, segment.segmentId);
    if (pointer !== null) pointers.set(segment.segmentId, pointer);
  }
  return {
    objectStore: fixture.objectStore,
    fileSystem: nodeCompactionFileSystem(),
    clock: fixture.clock,
    segments: [...inventory.byEpoch.values()].flat(),
    pointers,
    refusedSegmentIds: new Set<string>(),
  };
}

describe("a pin waits for a complete range", () => {
  it("waits while the WAL has not moved past the range, then pins every overlapping segment whole", async () => {
    fixture = await storageFixture({
      nowMs: NOW,
      segments: [
        [tradeFrame({ ingestSeq: "1", atMs: T }), tradeFrame({ ingestSeq: "2", atMs: T + 60_000 })],
        [tradeFrame({ ingestSeq: "3", atMs: T + 120_000 })],
      ],
    });
    const inventory = await fixture.extract();
    // The range ends after every recorded frame: nothing has closed it.
    const waiting = await extractPin(spec(T, T + 10 * 60_000), await context(inventory));
    expect(waiting).toMatchObject({ status: "waiting", reason: expect.stringMatching(/not yet moved past/u) });
    // A range the WAL has moved past is pinned with whole segments.
    const extracted = await extractPin(spec(T + 30_000, T + 90_000), await context(inventory));
    if (extracted.status !== "extracted") throw new Error(`expected extracted, got ${extracted.status}`);
    expect(extracted.record.datasets.flatMap((dataset) => dataset.segmentIds)).toStrictEqual([fixture.segments[0]?.segmentId]);
    const again = await extractPin(spec(T + 30_000, T + 90_000), await context(inventory));
    expect(again.status).toBe("already-extracted");
  });

  it("waits while a sealed segment is not yet extracted", async () => {
    fixture = await storageFixture({
      nowMs: NOW,
      segments: [[tradeFrame({ ingestSeq: "1", atMs: T })], [tradeFrame({ ingestSeq: "2", atMs: T + 120_000 })]],
    });
    const inventory = await fixture.extract();
    const late = buildSegmentFixture({ gatewayEpoch: EPOCH, segmentIndex: 2, frames: [tradeFrame({ ingestSeq: "3", atMs: T + 200_000 })] });
    await writeFile(join(fixture.walDir, late.segmentFileName), late.segmentBytes);
    await writeFile(join(fixture.walDir, late.manifestFileName), late.manifestBytes);
    const { inventoryWalRoot } = await import("../research-tier/inventory.js");
    const withLate = await inventoryWalRoot(nodeCompactionFileSystem(), fixture.walRoot);
    const outcome = await extractPin(spec(T, T + 60_000), await context(withLate));
    expect(outcome).toMatchObject({ status: "waiting", reason: expect.stringMatching(/not extracted yet/u) });
    expect(inventory.byEpoch.get(EPOCH)).toHaveLength(2);
  });
});

describe("a pin holds the bytes the research tier verified (ADR-028 Decision 2.6)", () => {
  it("refuses to pin a segment replaced since its research tier was written", async () => {
    fixture = await storageFixture({
      nowMs: NOW,
      segments: [[tradeFrame({ ingestSeq: "1", atMs: T })], [tradeFrame({ ingestSeq: "2", atMs: T + 120_000 })]],
    });
    const inventory = await fixture.extract();
    // A different, self-consistent segment under the same id: both readers
    // accept it, and its digests are not the ones the research tier holds.
    const replacement = buildSegmentFixture({ gatewayEpoch: EPOCH, segmentIndex: 0, frames: [tradeFrame({ ingestSeq: "1", atMs: T, id: 999 })] });
    await writeFile(join(fixture.walDir, replacement.segmentFileName), replacement.segmentBytes);
    await writeFile(join(fixture.walDir, replacement.manifestFileName), replacement.manifestBytes);
    await expect(extractPin(spec(T, T + 60_000), await context(inventory))).rejects.toThrow(
      /not pinned with the digests the research tier holds/u,
    );
    expect(await readPinRecord(fixture.objectStore, "operator-test")).toBeNull();
  });

  it("keeps a later segment that overlaps a pinned range the pin does not hold", async () => {
    fixture = await storageFixture({
      nowMs: NOW,
      segments: [
        [tradeFrame({ ingestSeq: "1", atMs: T }), tradeFrame({ ingestSeq: "2", atMs: T + 50_000 })],
        [tradeFrame({ ingestSeq: "3", atMs: T + 120_000 })],
      ],
    });
    const inventory = await fixture.extract();
    const windowSpec: PinSpec = { ...spec(T, T + 60_000), pinId: "window-w-000000000000", origin: "window", pinClass: "intent", windowId: "w" };
    const outcome = await extractPin(windowSpec, await context(inventory));
    if (outcome.status !== "extracted") throw new Error("expected extracted");
    // A segment sealed later holds a frame stamped back inside the pinned range.
    const stepBack = buildSegmentFixture({
      gatewayEpoch: EPOCH,
      segmentIndex: 2,
      frames: [tradeFrame({ ingestSeq: "4", atMs: T + 59_000 }), tradeFrame({ ingestSeq: "5", atMs: T + 180_000 })],
    });
    await writeFile(join(fixture.walDir, stepBack.segmentFileName), stepBack.segmentBytes);
    await writeFile(join(fixture.walDir, stepBack.manifestFileName), stepBack.manifestBytes);
    const all = await fixture.extract();
    const decisions = await planExpiry({
      nowMs: NOW,
      retentionMs: RAW_RETENTION_MS,
      leadInMs: 0,
      inventory: all,
      objectStore: fixture.objectStore,
      windows: [],
      classifications: new Map(),
      operatorPins: [],
      pinSpecs: [windowSpec],
      pinRecords: new Map([[windowSpec.pinId, outcome.record]]),
    });
    const late = decisions.find((decision) => decision.segment.segmentId === stepBack.segmentId);
    expect(late?.reasons).toStrictEqual([`pin-does-not-hold-segment: ${windowSpec.pinId}`]);
    // The pinned segment itself is eligible, with the pin named in its proof.
    const held = decisions.find((decision) => decision.segment.segmentIndex === 0);
    expect(held?.eligible).toBe(true);
    expect(held?.request?.pins.map((pin) => pin.pinId)).toStrictEqual([windowSpec.pinId]);
  });
});
