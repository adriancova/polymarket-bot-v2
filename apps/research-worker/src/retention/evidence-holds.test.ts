/**
 * Durable evidence holds (`STORAGE-1` round 3, L1): what an unclassified
 * window's rows have shown is remembered, durably, until the window is
 * settled; a state that does not read, or cannot be written, is a failure the
 * planner keeps every segment for.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { WindowClassification } from "./classify.js";
import type { EvidenceHoldState, EvidenceHoldsFileSystem } from "./evidence-holds.js";
import {
  EVIDENCE_HOLDS_FILE_NAME,
  emptyEvidenceHolds,
  encodeEvidenceHolds,
  mergeSpans,
  nodeEvidenceHoldsFileSystem,
  persistEvidenceHolds,
  readEvidenceHolds,
  rememberEvidence,
  sameEvidenceHolds,
  settledWindowIds,
} from "./evidence-holds.js";
import type { PinOutcome, PinRecord, PinSpec } from "./pins.js";

const HELD = { fromMs: 1_000, toMs: 2_000 };

const unclassified = (windowId: string, holdRanges: readonly { fromMs: number; toMs: number }[], evidenceUnreadable?: string): WindowClassification => ({
  windowId,
  state: "unclassified",
  reason: "r",
  holdRanges,
  ...(evidenceUnreadable === undefined ? {} : { evidenceUnreadable }),
});

const classified = (windowId: string, pinClass: "fill" | null): WindowClassification => ({
  windowId,
  state: "classified",
  pinClass,
  pinFromMs: pinClass === null ? null : 0,
  pinToMs: pinClass === null ? null : 10_000,
  keepUntilMs: null,
  sourceEvents: [],
  evidenceCounts: { fills: pinClass === null ? 0 : 1, intents: 0, refusals: 0, halts: 0 },
});

type Entry = { holds: { fromMs: number; toMs: number }[]; settled: boolean; unreadable?: boolean };
const state = (entries: [string, Entry][], failure: string | null = null): EvidenceHoldState => ({
  windows: new Map(entries.map(([windowId, entry]) => [windowId, { unreadable: false, ...entry }])),
  failure,
});
const entry = (holds: { fromMs: number; toMs: number }[], settled: boolean, unreadable = false) => ({ holds, settled, unreadable });

let directories: string[] = [];
afterEach(async () => {
  for (const directory of directories) await rm(directory, { recursive: true, force: true });
  directories = [];
});
async function stateDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "storage1-holds-"));
  directories.push(directory);
  return directory;
}

describe("mergeSpans", () => {
  it("merges overlapping ranges and keeps disjoint ones: the same instants, fewer ranges", () => {
    expect(mergeSpans([{ fromMs: 5, toMs: 9 }, { fromMs: 1, toMs: 3 }, { fromMs: 3, toMs: 4 }, { fromMs: 8, toMs: 12 }, { fromMs: 20, toMs: 21 }])).toStrictEqual([
      { fromMs: 1, toMs: 4 },
      { fromMs: 5, toMs: 12 },
      { fromMs: 20, toMs: 21 },
    ]);
    expect(mergeSpans([])).toStrictEqual([]);
  });
});

describe("rememberEvidence", () => {
  const registered = new Set(["w1", "w2"]);

  it("adds an unclassified window's holds and unsettles it; a window whose rows did not read keeps everything and is marked", () => {
    const before = state([["w1", { holds: [HELD], settled: false }], ["w2", { holds: [], settled: true }]]);
    const after = rememberEvidence({
      state: before,
      classifications: [unclassified("w1", [{ fromMs: 1_500, toMs: 3_000 }]), unclassified("w2", [], "ECONNREFUSED")],
      settled: null,
      registeredWindowIds: registered,
    });
    expect(after.windows.get("w1")).toStrictEqual(entry([{ fromMs: 1_000, toMs: 3_000 }], false));
    // Unreadable: nothing learned, nothing forgotten (it stays settled), and the failure is remembered.
    expect(after.windows.get("w2")).toStrictEqual(entry([], true, true));
    // An unclassified window whose rows read, holding nothing more, is not settled either.
    const blocked = rememberEvidence({ state: before, classifications: [unclassified("w2", [])], settled: null, registeredWindowIds: registered });
    expect(blocked.windows.has("w2")).toBe(false);
  });

  it("remembers a failed read of an unsettled window until a read succeeds, whatever the registry says", () => {
    const failed = rememberEvidence({ state: emptyEvidenceHolds(), classifications: [unclassified("w1", [], "ECONNREFUSED")], settled: null, registeredWindowIds: registered });
    expect(failed.windows.get("w1")).toStrictEqual(entry([], false, true));
    // It leaves the registry: still remembered.
    const gone = rememberEvidence({ state: failed, classifications: [], settled: new Set(), registeredWindowIds: new Set() });
    expect(gone.windows.get("w1")).toStrictEqual(entry([], false, true));
    // A read that succeeds clears it, in a cycle or a recheck.
    expect(rememberEvidence({ state: failed, classifications: [unclassified("w1", [])], settled: null, registeredWindowIds: registered }).windows.has("w1")).toBe(false);
    expect(rememberEvidence({ state: failed, classifications: [classified("w1", "fill")], settled: null, registeredWindowIds: registered }).windows.has("w1")).toBe(false);
  });

  it("releases a settled window's holds, keeps an unsettled classified window's, and changes no classified window in a recheck", () => {
    const before = state([["w1", { holds: [HELD], settled: false }], ["w2", { holds: [HELD], settled: false }]]);
    const after = rememberEvidence({
      state: before,
      classifications: [classified("w1", "fill"), classified("w2", "fill")],
      settled: new Set(["w1"]),
      registeredWindowIds: registered,
    });
    expect(after.windows.get("w1")).toStrictEqual(entry([], true));
    expect(after.windows.get("w2")).toStrictEqual(entry([HELD], false));
    const recheck = rememberEvidence({ state: before, classifications: [classified("w1", "fill")], settled: null, registeredWindowIds: registered });
    expect(recheck.windows.get("w1")).toStrictEqual(entry([HELD], false));
  });

  it("keeps a hold whatever the registry says, and forgets settlement for a window no longer registered", () => {
    const before = state([["gone-held", { holds: [HELD], settled: false }], ["gone-settled", { holds: [], settled: true }], ["w1", { holds: [], settled: true }]]);
    const after = rememberEvidence({ state: before, classifications: [], settled: new Set(), registeredWindowIds: registered });
    expect([...after.windows.keys()].sort()).toStrictEqual(["gone-held", "w1"]);
    // The failure of the state it came from is carried.
    expect(rememberEvidence({ state: state([], "bad"), classifications: [], settled: null, registeredWindowIds: registered }).failure).toBe("bad");
  });
});

describe("settledWindowIds", () => {
  const record = (input: Partial<PinRecord>): PinRecord => ({
    pinRecordVersion: 1,
    pinId: "window-w1-p",
    origin: "window",
    pinClass: "fill",
    windowId: "w1",
    from: new Date(0).toISOString(),
    to: new Date(10_000).toISOString(),
    keepUntil: null,
    reason: "r",
    datasets: [],
    sourceEvents: [],
    sourceEventsInside: true,
    sourceEventsOutside: [],
    createdAt: new Date(0).toISOString(),
    ...input,
  });
  const spec: PinSpec = {
    pinId: "window-w1-p",
    origin: "window",
    pinClass: "fill",
    windowId: "w1",
    fromMs: 0,
    toMs: 10_000,
    keepUntilMs: null,
    sourceEvents: [],
    reason: "r",
  };
  const settledWith = (outcome: PinOutcome | null, held: { fromMs: number; toMs: number }[] = [HELD]) =>
    settledWindowIds({
      classifications: [classified("w1", "fill")],
      specs: [spec],
      outcomes: outcome === null ? [] : [outcome],
      state: state([["w1", { holds: held, settled: false }]]),
    }).has("w1");

  it("settles a window whose pin is extracted, complete, and covers every held range; nothing less", () => {
    expect(settledWith({ pinId: "window-w1-p", status: "extracted", record: record({}) })).toBe(true);
    expect(settledWith({ pinId: "window-w1-p", status: "already-extracted", record: record({}) })).toBe(true);
    expect(settledWith(null)).toBe(false);
    expect(settledWith({ pinId: "window-w1-p", status: "waiting", reason: "r" })).toBe(false);
    expect(
      settledWith({ pinId: "window-w1-p", status: "extracted", record: record({ sourceEventsInside: false, sourceEventsOutside: [{ evaluatedAtMs: 1, sourceEventId: null, gatewayEpoch: null, ingestSeq: null }] }) }),
    ).toBe(false);
    // A held range the pin does not cover.
    expect(settledWith({ pinId: "window-w1-p", status: "extracted", record: record({}) }, [{ fromMs: -1, toMs: 5 }])).toBe(false);
  });

  it("settles a window classified with no evidence only while it holds nothing", () => {
    const withHolds = (holds: { fromMs: number; toMs: number }[]) =>
      settledWindowIds({ classifications: [classified("w1", null)], specs: [], outcomes: [], state: state([["w1", { holds, settled: false }]]) }).has("w1");
    expect(withHolds([])).toBe(true);
    expect(withHolds([HELD])).toBe(false);
    // An unclassified window is never settled.
    expect(settledWindowIds({ classifications: [unclassified("w1", [])], specs: [], outcomes: [], state: emptyEvidenceHolds() }).size).toBe(0);
  });
});

describe("reading and writing the holds", () => {
  const sample = state([["w1", { holds: [HELD], settled: false }], ["w0", { holds: [], settled: true }]]);

  it("round-trips durably, in a canonical order", async () => {
    const directory = await stateDirectory();
    expect(await readEvidenceHolds(directory)).toStrictEqual(emptyEvidenceHolds());
    expect(await persistEvidenceHolds(directory, sample)).toBe(sample);
    const read = await readEvidenceHolds(directory);
    expect(read.failure).toBeNull();
    expect(sameEvidenceHolds(read, sample)).toBe(true);
    expect(JSON.parse(await readFile(join(directory, EVIDENCE_HOLDS_FILE_NAME), "utf8"))).toStrictEqual({
      evidenceHoldsVersion: 1,
      windows: [
        { windowId: "w0", settled: true, unreadable: false, holds: [] },
        { windowId: "w1", settled: false, unreadable: false, holds: [HELD] },
      ],
    });
    // No state directory (a dry run): nothing durable, nothing settled, no failure.
    expect(await readEvidenceHolds(null)).toStrictEqual(emptyEvidenceHolds());
    expect(await persistEvidenceHolds(null, sample)).toBe(sample);
  });

  it.each([
    ["not JSON", "{"],
    ["a duplicate key", '{"evidenceHoldsVersion":1,"windows":[],"windows":[]}'],
    ["another version", '{"evidenceHoldsVersion":2,"windows":[]}'],
    ["a window listed twice", '{"evidenceHoldsVersion":1,"windows":[{"windowId":"w","settled":false,"unreadable":false,"holds":[]},{"windowId":"w","settled":true,"unreadable":false,"holds":[]}]}'],
    ["an inverted range", '{"evidenceHoldsVersion":1,"windows":[{"windowId":"w","settled":false,"unreadable":false,"holds":[{"fromMs":2,"toMs":1}]}]}'],
    ["a fractional instant", '{"evidenceHoldsVersion":1,"windows":[{"windowId":"w","settled":false,"unreadable":false,"holds":[{"fromMs":1.5,"toMs":2}]}]}'],
    ["no settled flag", '{"evidenceHoldsVersion":1,"windows":[{"windowId":"w","unreadable":false,"holds":[]}]}'],
    ["no unreadable flag", '{"evidenceHoldsVersion":1,"windows":[{"windowId":"w","settled":false,"holds":[]}]}'],
  ])("reads a file holding %s as a failure, and never overwrites it", async (_name, text) => {
    const directory = await stateDirectory();
    await writeFile(join(directory, EVIDENCE_HOLDS_FILE_NAME), text);
    const read = await readEvidenceHolds(directory);
    expect(read.failure).toMatch(/not ones this build reads/u);
    const remembered = rememberEvidence({ state: read, classifications: [unclassified("w9", [HELD])], settled: null, registeredWindowIds: new Set() });
    expect((await persistEvidenceHolds(directory, remembered)).failure).toBe(read.failure);
    expect(await readFile(join(directory, EVIDENCE_HOLDS_FILE_NAME), "utf8")).toBe(text);
  });

  it("reports a write that fails, or does not read back, as a failure", async () => {
    const directory = await stateDirectory();
    const failing: EvidenceHoldsFileSystem = {
      writeDurably: async () => {
        throw new Error("ENOSPC: no space left on device");
      },
      readFile: nodeEvidenceHoldsFileSystem.readFile,
    };
    expect((await persistEvidenceHolds(directory, sample, failing)).failure).toMatch(/could not be made durable: ENOSPC/u);
    const lying: EvidenceHoldsFileSystem = {
      writeDurably: nodeEvidenceHoldsFileSystem.writeDurably,
      readFile: async () => encodeEvidenceHolds(emptyEvidenceHolds()),
    };
    expect((await persistEvidenceHolds(directory, sample, lying)).failure).toMatch(/did not read back as written/u);
  });
});
