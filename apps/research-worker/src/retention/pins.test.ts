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
import { buildSegmentFixture, memoryObjectStore } from "@polymarket-bot/storage-parquet/testing";

import type { ResearchPointer } from "../research-tier/extract.js";
import { readResearchPointer } from "../research-tier/extract.js";
import type { WalInventory } from "../research-tier/inventory.js";
import { EPOCH, HOUR, storageFixture, tradeFrame } from "../testing/storage-fixture.js";
import type { StorageFixture } from "../testing/storage-fixture.js";
import { bindWindowPins, extractPin, parsePinRecord, readExtractedPins, readPinRecord } from "./pins.js";
import type { PinRecord, PinSpec } from "./pins.js";
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
    wal: await fixture.walIndex(inventory),
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

  it("waits while the range ends exactly at the newest frame: only a frame AFTER the range closes it (J16, M5)", async () => {
    fixture = await storageFixture({
      nowMs: NOW,
      segments: [[tradeFrame({ ingestSeq: "1", atMs: T })], [tradeFrame({ ingestSeq: "2", atMs: T + 120_000 })]],
    });
    const inventory = await fixture.extract();
    // A frame stamped T + 120 s exists, but none after it.
    const atEdge = await extractPin(spec(T, T + 120_000), await context(inventory));
    expect(atEdge).toMatchObject({ status: "waiting", reason: expect.stringMatching(/not yet moved past/u) });
    expect(await readPinRecord(fixture.objectStore, "operator-test")).toBeNull();
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
      durabilityGraceMs: 0,
      inventory: all,
      objectStore: fixture.objectStore,
      windows: [],
      classifications: new Map(),
      operatorPins: [],
      pinSpecs: [windowSpec],
      pinRecords: new Map([[windowSpec.pinId, outcome.record]]),
      extractedPins: await readExtractedPins(fixture.objectStore),
    });
    const late = decisions.find((decision) => decision.segment.segmentId === stepBack.segmentId);
    expect(late?.reasons).toStrictEqual([`pin-does-not-hold-segment: ${windowSpec.pinId}`]);
    // The pinned segment itself is eligible, with the pin named in its proof.
    const held = decisions.find((decision) => decision.segment.segmentIndex === 0);
    expect(held?.eligible).toBe(true);
    expect(held?.request?.pins.map((pin) => pin.pinId)).toStrictEqual([windowSpec.pinId]);
  });
});

describe("every extracted pin is enumerated from the store (round 2, K3)", () => {
  it("lists every pin record, skips a pin directory with no record, and reports one that does not read", async () => {
    fixture = await storageFixture({
      nowMs: NOW,
      segments: [[tradeFrame({ ingestSeq: "1", atMs: T })], [tradeFrame({ ingestSeq: "2", atMs: T + 120_000 })]],
    });
    const inventory = await fixture.extract();
    expect(await readExtractedPins(fixture.objectStore)).toStrictEqual({ records: [], unreadable: [] });
    const outcome = await extractPin(spec(T, T + 60_000), await context(inventory));
    if (outcome.status !== "extracted") throw new Error("expected extracted");
    // An extraction that never finished: datasets without a record.
    await fixture.objectStore.put("pins/window-w-unfinished/e/manifest.json", Buffer.from("{}"));
    expect(await readExtractedPins(fixture.objectStore)).toStrictEqual({ records: [outcome.record], unreadable: [] });
    // A record that exists but does not read: its range is unknown.
    await fixture.objectStore.put("pins/window-w-broken/pin.json", Buffer.from("{"));
    const withBroken = await readExtractedPins(fixture.objectStore);
    expect(withBroken.records).toStrictEqual([outcome.record]);
    expect(withBroken.unreadable).toMatchObject([{ pinId: "window-w-broken", detail: expect.stringMatching(/not one this build reads/u) }]);
  });

  it("reports a store that cannot list, or a listing that fails, as one unreadable entry", async () => {
    const store = { put: async () => undefined, head: async () => null, get: async () => new Uint8Array() };
    expect(await readExtractedPins(store)).toMatchObject({ records: [], unreadable: [{ detail: /cannot list/u }] });
    const failing = {
      ...store,
      list: async (): Promise<readonly string[]> => {
        throw new Error("EIO");
      },
    };
    expect(await readExtractedPins(failing)).toMatchObject({ records: [], unreadable: [{ detail: /EIO/u }] });
  });

  it("lists the names directly under a prefix in the memory store too", async () => {
    const store = memoryObjectStore();
    expect(await store.list?.("pins")).toStrictEqual([]);
    await store.put("pins/b/pin.json", Buffer.from("x"));
    await store.put("pins/a/e/manifest.json", Buffer.from("x"));
    await store.put("pinsx/c/pin.json", Buffer.from("x"));
    expect(await store.list?.("pins")).toStrictEqual(["a", "b"]);
  });
});

describe("a pin record is read strictly (round 2)", () => {
  async function storedRecord(): Promise<Record<string, unknown>> {
    if (fixture === null) throw new Error("no fixture");
    const inventory = await fixture.extract();
    const windowSpec: PinSpec = {
      ...spec(T, T + 60_000),
      pinId: "window-w-000000000000",
      origin: "window",
      pinClass: "fill",
      windowId: "w",
      sourceEvents: [{ evaluatedAtMs: T + 1, sourceEventId: "s", gatewayEpoch: EPOCH, ingestSeq: "1" }],
    };
    const outcome = await extractPin(windowSpec, await context(inventory));
    if (outcome.status !== "extracted") throw new Error("expected extracted");
    expect(outcome.record.sourceEvents).toStrictEqual(windowSpec.sourceEvents);
    return JSON.parse(JSON.stringify(outcome.record)) as Record<string, unknown>;
  }

  it("records the source events it had to hold, and refuses a record whose instants, events or trace do not read", async () => {
    fixture = await storageFixture({
      nowMs: NOW,
      segments: [[tradeFrame({ ingestSeq: "1", atMs: T })], [tradeFrame({ ingestSeq: "2", atMs: T + 120_000 })]],
    });
    const good = await storedRecord();
    const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
    expect(parsePinRecord(bytes(good), "k")).toStrictEqual(good);
    const cases: [string, Record<string, unknown>][] = [
      ["no sourceEvents", { ...good, sourceEvents: undefined }],
      ["a malformed source event", { ...good, sourceEvents: [{ evaluatedAtMs: "1", sourceEventId: null, gatewayEpoch: null, ingestSeq: null }] }],
      ["a malformed outside event", { ...good, sourceEventsInside: false, sourceEventsOutside: [{ evaluatedAtMs: 1 }] }],
      ["inside contradicting outside", { ...good, sourceEventsInside: false, sourceEventsOutside: [] }],
      ["a non-canonical instant", { ...good, from: "2026-01-06T16:00:00+00:00" }],
      ["an instant that is no date", { ...good, to: "2026-13-45T00:00:00.000Z" }],
      ["a range ending before it starts", { ...good, from: good["to"], to: good["from"] }],
    ];
    for (const [name, value] of cases) {
      expect(() => parsePinRecord(bytes(value), "k"), name).toThrow(/not one this build reads/u);
    }
  });
});

describe("a window is bound to its existing pin when that pin fulfils it (round 2, K4)", () => {
  const event = (ingestSeq: string) => ({ evaluatedAtMs: T + 1, sourceEventId: `s${ingestSeq}`, gatewayEpoch: EPOCH, ingestSeq });
  const record = (input: Partial<PinRecord> & { readonly pinId: string }): PinRecord => ({
    pinRecordVersion: 1,
    origin: "window",
    pinClass: "fill",
    windowId: "w",
    from: new Date(T - HOUR).toISOString(),
    to: new Date(T + HOUR).toISOString(),
    keepUntil: null,
    reason: "r",
    datasets: [],
    sourceEvents: [event("2")],
    sourceEventsInside: true,
    sourceEventsOutside: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    ...input,
  });
  const derived: PinSpec = {
    pinId: "window-w-derived",
    origin: "window",
    pinClass: "fill",
    windowId: "w",
    fromMs: T - 15 * 60_000,
    toMs: T + 10 * 60_000,
    keepUntilMs: null,
    sourceEvents: [event("2")],
    reason: "window w had fill evidence",
  };

  it("binds to the pin that holds everything the derived spec requires", () => {
    const existing = record({ pinId: "window-w-first" });
    expect(bindWindowPins([derived], [existing])).toStrictEqual([
      { ...derived, pinId: "window-w-first", fromMs: T - HOUR, toMs: T + HOUR, sourceEvents: existing.sourceEvents },
    ]);
    // The oldest of two that qualify; and a spec whose own pin exists is left alone.
    const later = record({ pinId: "window-w-a-later", createdAt: "2026-01-02T00:00:00.000Z" });
    expect(bindWindowPins([derived], [later, existing])[0]?.pinId).toBe("window-w-first");
    const own = record({ pinId: "window-w-derived" });
    expect(bindWindowPins([derived], [existing, own])).toStrictEqual([derived]);
  });

  it.each<[string, Partial<PinRecord>]>([
    ["another window", { windowId: "w2" }],
    ["another class", { pinClass: "intent" }],
    ["another lapse", { keepUntil: "2026-02-01T00:00:00.000Z" }],
    ["an incomplete trace", { sourceEventsInside: false, sourceEventsOutside: [event("2")] }],
    ["a range that starts later", { from: new Date(T - 60_000).toISOString() }],
    ["a range that ends earlier", { to: new Date(T + 60_000).toISOString() }],
    ["a source event it was not extracted to hold", { sourceEvents: [event("3")] }],
    ["an operator pin", { origin: "operator", pinClass: "operator", windowId: null }],
  ])("does not bind to %s", (_name, change) => {
    expect(bindWindowPins([derived], [record({ pinId: "window-w-other", ...change })])).toStrictEqual([derived]);
  });
});
