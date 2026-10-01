/**
 * Durable evidence holds (`STORAGE-1` rounds 3 and 4, L1, M1-M3): what an
 * unclassified window's rows have shown, and a classified window's whole pin
 * extent while its pin is not settled, is remembered, durably, until the
 * window is settled; a state that does not read, or cannot be written, is a
 * failure the planner keeps every segment for.
 */

import { constants as fsConstants } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { WindowClassification } from "./classify.js";
import type { EvidenceHoldState, EvidenceHoldsFileOperations, EvidenceHoldsFileSystem, EvidencePass } from "./evidence-holds.js";
import {
  EVIDENCE_HOLDS_FILE_NAME,
  accumulateEvidenceHolds,
  emptyEvidenceHolds,
  encodeEvidenceHolds,
  evidenceHoldsFileSystem,
  mergeSpans,
  nodeEvidenceHoldsFileOperations,
  nodeEvidenceHoldsFileSystem,
  persistEvidenceHolds,
  pinExtent,
  readEvidenceHolds,
  recordedWindowIds,
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

/** The pin extent of `classified(…, "fill")` unless one is given. */
const EXTENT = { fromMs: 0, toMs: 10_000 };
const classified = (windowId: string, pinClass: "fill" | null, extent: { fromMs: number; toMs: number } = EXTENT): WindowClassification => ({
  windowId,
  state: "classified",
  pinClass,
  pinFromMs: pinClass === null ? null : extent.fromMs,
  pinToMs: pinClass === null ? null : extent.toMs,
  keepUntilMs: null,
  sourceEvents: [],
  evidenceCounts: { fills: pinClass === null ? 0 : 1, intents: 0, refusals: 0, halts: 0 },
});
/** A cycle that settles `settled`; a recheck in which `recorded` have a pin record holding their extent. */
const cycle = (...settled: string[]): EvidencePass => ({ kind: "cycle", settled: new Set(settled) });
const recheck = (...recorded: string[]): EvidencePass => ({ kind: "recheck", recorded: new Set(recorded) });

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
      pass: recheck(),
      registeredWindowIds: registered,
    });
    expect(after.windows.get("w1")).toStrictEqual(entry([{ fromMs: 1_000, toMs: 3_000 }], false));
    // Unreadable: nothing learned, nothing forgotten (it stays settled), and the failure is remembered.
    expect(after.windows.get("w2")).toStrictEqual(entry([], true, true));
    // An unclassified window whose rows read, holding nothing more, is not settled either.
    const blocked = rememberEvidence({ state: before, classifications: [unclassified("w2", [])], pass: recheck(), registeredWindowIds: registered });
    expect(blocked.windows.has("w2")).toBe(false);
  });

  it("remembers a failed read of an unsettled window until a read succeeds, whatever the registry says", () => {
    const failed = rememberEvidence({ state: emptyEvidenceHolds(), classifications: [unclassified("w1", [], "ECONNREFUSED")], pass: recheck(), registeredWindowIds: registered });
    expect(failed.windows.get("w1")).toStrictEqual(entry([], false, true));
    // It leaves the registry: still remembered.
    const gone = rememberEvidence({ state: failed, classifications: [], pass: cycle(), registeredWindowIds: new Set() });
    expect(gone.windows.get("w1")).toStrictEqual(entry([], false, true));
    // A read that succeeds clears it, in a cycle or a recheck.
    expect(rememberEvidence({ state: failed, classifications: [unclassified("w1", [])], pass: recheck(), registeredWindowIds: registered }).windows.has("w1")).toBe(false);
    expect(rememberEvidence({ state: failed, classifications: [classified("w1", null)], pass: recheck(), registeredWindowIds: registered }).windows.has("w1")).toBe(false);
    // Classified with evidence: the mark clears, and the window holds its pin extent until its pin is settled (round 4, M1).
    expect(rememberEvidence({ state: failed, classifications: [classified("w1", "fill")], pass: recheck(), registeredWindowIds: registered }).windows.get("w1")).toStrictEqual(
      entry([EXTENT], false),
    );
  });

  it("releases a settled window's holds; an unsettled classified window adds its whole pin extent to what it held", () => {
    const before = state([["w1", { holds: [HELD], settled: false }], ["w2", { holds: [{ fromMs: 20_000, toMs: 30_000 }], settled: false }]]);
    const after = rememberEvidence({
      state: before,
      classifications: [classified("w1", "fill"), classified("w2", "fill")],
      pass: cycle("w1"),
      registeredWindowIds: registered,
    });
    expect(after.windows.get("w1")).toStrictEqual(entry([], true));
    expect(after.windows.get("w2")).toStrictEqual(entry([EXTENT, { fromMs: 20_000, toMs: 30_000 }], false));
  });

  describe("round 4, M1: a classified window whose pin is not settled holds its whole pin extent, durably, whatever the registry says", () => {
    it.each([
      ["a cycle that does not settle it (its pin waits, or its extraction failed)", cycle()],
      ["a recheck with no pin record holding its extent (a classification the recheck first learns)", recheck()],
    ])("in %s, a window first seen classified holds its extent, and keeps it once it leaves the registry", (_name, pass) => {
      const after = rememberEvidence({ state: emptyEvidenceHolds(), classifications: [classified("w1", "fill")], pass, registeredWindowIds: registered });
      expect(after.windows.get("w1")).toStrictEqual(entry([EXTENT], false));
      const gone = rememberEvidence({ state: after, classifications: [], pass: cycle(), registeredWindowIds: new Set() });
      expect(gone.windows.get("w1")).toStrictEqual(entry([EXTENT], false));
    });

    it("unsettles a window settled before whose extent a cycle does not settle, or a recheck finds no record for", () => {
      const before = state([["w1", { holds: [], settled: true }]]);
      for (const pass of [cycle(), recheck()]) {
        expect(rememberEvidence({ state: before, classifications: [classified("w1", "fill")], pass, registeredWindowIds: registered }).windows.get("w1")).toStrictEqual(
          entry([EXTENT], false),
        );
      }
      // A window settled before with no evidence that a recheck finds classified with a fill: no longer settled.
      expect(rememberEvidence({ state: before, classifications: [classified("w1", "fill", { fromMs: 5, toMs: 6 })], pass: recheck(), registeredWindowIds: registered }).windows.get("w1")).toStrictEqual(
        entry([{ fromMs: 5, toMs: 6 }], false),
      );
    });

    it("a recheck settles and releases nothing: a window whose pin record holds its extent is unchanged, held or settled", () => {
      const before = state([["w1", { holds: [], settled: true }], ["w2", { holds: [HELD], settled: false }]]);
      const after = rememberEvidence({
        state: before,
        classifications: [classified("w1", "fill"), classified("w2", "fill")],
        pass: recheck("w1", "w2"),
        registeredWindowIds: registered,
      });
      expect(after.windows.get("w1")).toStrictEqual(entry([], true));
      expect(after.windows.get("w2")).toStrictEqual(entry([HELD], false));
      // A classified window with no evidence gains nothing in a recheck: it keeps what it held, and stays settled.
      const none = rememberEvidence({ state: before, classifications: [classified("w1", null), classified("w2", null)], pass: recheck(), registeredWindowIds: registered });
      expect(none.windows.get("w1")).toStrictEqual(entry([], true));
      expect(none.windows.get("w2")).toStrictEqual(entry([HELD], false));
    });

    it("a cycle's classified window with no evidence that it does not settle keeps what it held, and gains nothing", () => {
      const before = state([["w1", { holds: [HELD], settled: false }]]);
      expect(rememberEvidence({ state: before, classifications: [classified("w1", null)], pass: cycle(), registeredWindowIds: registered }).windows.get("w1")).toStrictEqual(
        entry([HELD], false),
      );
    });

    it("pinExtent is the classified window's pin range, and nothing for no evidence or an unclassified window", () => {
      expect(pinExtent(classified("w1", "fill", { fromMs: 3, toMs: 9 }))).toStrictEqual([{ fromMs: 3, toMs: 9 }]);
      expect(pinExtent(classified("w1", null))).toStrictEqual([]);
      expect(pinExtent(unclassified("w1", [HELD]))).toStrictEqual([]);
    });
  });

  it("keeps a hold whatever the registry says, and forgets settlement for a window no longer registered", () => {
    const before = state([["gone-held", { holds: [HELD], settled: false }], ["gone-settled", { holds: [], settled: true }], ["w1", { holds: [], settled: true }]]);
    const after = rememberEvidence({ state: before, classifications: [], pass: cycle(), registeredWindowIds: registered });
    expect([...after.windows.keys()].sort()).toStrictEqual(["gone-held", "w1"]);
    // The failure of the state it came from is carried.
    expect(rememberEvidence({ state: state([], "bad"), classifications: [], pass: recheck(), registeredWindowIds: registered }).failure).toBe("bad");
  });
});

describe("accumulateEvidenceHolds (round 5, N2): what a dry run makes durable — everything held or learned, nothing released", () => {
  const OTHER = { fromMs: 5_000, toMs: 6_000 };

  it("records what a dry run learned for a window the file does not name: its holds, and a failed read", () => {
    const learned = state([
      ["w1", { holds: [HELD], settled: false }],
      ["w2", { holds: [], settled: false, unreadable: true }],
    ]);
    const after = accumulateEvidenceHolds(emptyEvidenceHolds(), learned);
    expect(after.windows.get("w1")).toStrictEqual(entry([HELD], false));
    expect(after.windows.get("w2")).toStrictEqual(entry([], false, true));
  });

  it("never settles a window: one the dry run settled is not recorded, and one the file holds stays held", () => {
    // New to the file and settled by the dry run (its pin extracted): nothing to record.
    expect(accumulateEvidenceHolds(emptyEvidenceHolds(), state([["w1", { holds: [], settled: true }]])).windows.has("w1")).toBe(false);
    // Held in the file; the dry run would release it: still held, not settled.
    const durable = state([["w1", { holds: [HELD], settled: false }]]);
    expect(accumulateEvidenceHolds(durable, state([["w1", { holds: [], settled: true }]])).windows.get("w1")).toStrictEqual(entry([HELD], false));
  });

  it("never shrinks a hold: the union of what the file holds and what the dry run learned", () => {
    const durable = state([["w1", { holds: [HELD], settled: false }]]);
    expect(accumulateEvidenceHolds(durable, state([["w1", { holds: [OTHER], settled: false }]])).windows.get("w1")).toStrictEqual(entry([HELD, OTHER], false));
    expect(accumulateEvidenceHolds(durable, state([["w1", { holds: [], settled: false }]])).windows.get("w1")).toStrictEqual(entry([HELD], false));
  });

  it("never clears a failed read, and marks one the dry run saw", () => {
    const marked = state([["w1", { holds: [], settled: false, unreadable: true }]]);
    expect(accumulateEvidenceHolds(marked, state([["w1", { holds: [OTHER], settled: false }]])).windows.get("w1")).toStrictEqual(entry([OTHER], false, true));
    const settled = state([["w1", { holds: [], settled: true }]]);
    expect(accumulateEvidenceHolds(settled, state([["w1", { holds: [], settled: true, unreadable: true }]])).windows.get("w1")).toStrictEqual(entry([], true, true));
  });

  it("unsettles a settled window the dry run found holding more, and keeps a settled one it found settled", () => {
    const settled = state([["w1", { holds: [], settled: true }]]);
    expect(accumulateEvidenceHolds(settled, state([["w1", { holds: [OTHER], settled: false }]])).windows.get("w1")).toStrictEqual(entry([OTHER], false));
    expect(accumulateEvidenceHolds(settled, state([["w1", { holds: [], settled: true }]])).windows.get("w1")).toStrictEqual(entry([], true));
  });

  it("forgets nothing: a window the dry run dropped (it left the registry) is kept as the file has it, and so is the file's failure", () => {
    const durable = state([
      ["gone-held", { holds: [HELD], settled: false }],
      ["gone-settled", { holds: [], settled: true }],
      ["gone-unreadable", { holds: [], settled: false, unreadable: true }],
    ]);
    const after = accumulateEvidenceHolds(durable, emptyEvidenceHolds());
    expect(sameEvidenceHolds(after, durable)).toBe(true);
    expect(accumulateEvidenceHolds(state([], "bad"), emptyEvidenceHolds()).failure).toBe("bad");
  });
});

const pinRecord = (input: Partial<PinRecord>): PinRecord => ({
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
const windowSpec = (windowId: string, pinId: string): PinSpec => ({
  pinId,
  origin: "window",
  pinClass: "fill",
  windowId,
  fromMs: 0,
  toMs: 10_000,
  keepUntilMs: null,
  sourceEvents: [],
  reason: "r",
});
const INCOMPLETE = { sourceEventsInside: false, sourceEventsOutside: [{ evaluatedAtMs: 1, sourceEventId: null, gatewayEpoch: null, ingestSeq: null }] };

describe("settledWindowIds", () => {
  const record = pinRecord;
  const spec = windowSpec("w1", "window-w1-p");
  const settledWith = (outcome: PinOutcome | null, held: { fromMs: number; toMs: number }[] = [HELD], extent = EXTENT) =>
    settledWindowIds({
      classifications: [classified("w1", "fill", extent)],
      specs: [spec],
      outcomes: outcome === null ? [] : [outcome],
      state: state([["w1", { holds: held, settled: false }]]),
    }).has("w1");

  it("settles a window whose pin is extracted, complete, and covers every held range; nothing less", () => {
    expect(settledWith({ pinId: "window-w1-p", status: "extracted", record: record({}) })).toBe(true);
    expect(settledWith({ pinId: "window-w1-p", status: "already-extracted", record: record({}) })).toBe(true);
    expect(settledWith(null)).toBe(false);
    expect(settledWith({ pinId: "window-w1-p", status: "waiting", reason: "r" })).toBe(false);
    expect(settledWith({ pinId: "window-w1-p", status: "extracted", record: record(INCOMPLETE) })).toBe(false);
    // A held range the pin does not cover.
    expect(settledWith({ pinId: "window-w1-p", status: "extracted", record: record({}) }, [{ fromMs: -1, toMs: 5 }])).toBe(false);
  });

  it("does not settle a classified window with evidence for which this cycle derived no spec", () => {
    expect(
      settledWindowIds({
        classifications: [classified("w1", "fill")],
        specs: [],
        outcomes: [{ pinId: "window-w1-p", status: "extracted", record: record({}) }],
        state: emptyEvidenceHolds(),
      }).size,
    ).toBe(0);
  });

  it("(round 4, M3) does not settle a window whose held range ends after its pin, though it starts inside it", () => {
    expect(settledWith({ pinId: "window-w1-p", status: "extracted", record: record({}) }, [{ fromMs: 5_000, toMs: 10_001 }])).toBe(false);
    expect(settledWith({ pinId: "window-w1-p", status: "extracted", record: record({}) }, [{ fromMs: 5_000, toMs: 10_000 }])).toBe(true);
  });

  it("(round 4, M1) does not settle a window whose own pin extent the pin does not cover, whatever it held before", () => {
    const extracted: PinOutcome = { pinId: "window-w1-p", status: "extracted", record: record({}) };
    expect(settledWith(extracted, [], { fromMs: 0, toMs: 10_001 })).toBe(false);
    expect(settledWith(extracted, [], { fromMs: -1, toMs: 10_000 })).toBe(false);
    expect(settledWith(extracted, [], EXTENT)).toBe(true);
  });

  it("(round 4, M3) settles each window only by its OWN pin: another window's extracted pin settles nothing", () => {
    // w2's spec comes first, and its pin is extracted; w1's own pin waits.
    const settled = settledWindowIds({
      classifications: [classified("w1", "fill"), classified("w2", "fill")],
      specs: [windowSpec("w2", "window-w2-p"), windowSpec("w1", "window-w1-p")],
      outcomes: [
        { pinId: "window-w2-p", status: "extracted", record: record({ pinId: "window-w2-p", windowId: "w2" }) },
        { pinId: "window-w1-p", status: "waiting", reason: "1 sealed segment(s) are not extracted yet" },
      ],
      state: state([["w1", { holds: [HELD], settled: false }]]),
    });
    expect([...settled]).toStrictEqual(["w2"]);
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

describe("recordedWindowIds (round 4, M1): in a recheck, the classified windows a pin record already in the store holds", () => {
  const recorded = (records: readonly PinRecord[], extent = EXTENT, specs = [windowSpec("w1", "window-w1-p")]) =>
    recordedWindowIds({ classifications: [classified("w1", "fill", extent)], specs, records }).has("w1");

  it("names a window whose (bound) spec's record is in the store, complete, and covers its whole extent; nothing less", () => {
    expect(recorded([pinRecord({})])).toBe(true);
    expect(recorded([])).toBe(false);
    expect(recorded([pinRecord(INCOMPLETE)])).toBe(false);
    expect(recorded([pinRecord({})], { fromMs: -1, toMs: 10_000 })).toBe(false);
    expect(recorded([pinRecord({})], { fromMs: 0, toMs: 10_001 })).toBe(false);
    // The record of another pin of the same window does not stand for the spec's.
    expect(recorded([pinRecord({ pinId: "window-w1-other" })])).toBe(false);
    // No spec for the window (none derived this recheck): nothing names it.
    expect(recorded([pinRecord({})], EXTENT, [])).toBe(false);
  });

  it("takes each window's OWN spec: another window's recorded pin names nothing", () => {
    const names = recordedWindowIds({
      classifications: [classified("w1", "fill"), classified("w2", "fill")],
      specs: [windowSpec("w2", "window-w2-p"), windowSpec("w1", "window-w1-p")],
      records: [pinRecord({ pinId: "window-w2-p", windowId: "w2" })],
    });
    expect([...names]).toStrictEqual(["w2"]);
  });

  it("names no window classified with no evidence, and no unclassified one", () => {
    expect(recordedWindowIds({ classifications: [classified("w1", null), unclassified("w2", [HELD])], specs: [], records: [pinRecord({})] }).size).toBe(0);
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
    const remembered = rememberEvidence({ state: read, classifications: [unclassified("w9", [HELD])], pass: recheck(), registeredWindowIds: new Set() });
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

/**
 * The REAL writer (`evidenceHoldsFileSystem`) over the real `node:fs/promises`
 * calls, each one recorded, and any one failed on demand (round 4, M2).
 */
type Step =
  | "mkdir"
  | "open-file"
  | "write"
  | "file-sync"
  | "file-close"
  | "rename"
  | "open-directory"
  | "directory-sync"
  | "directory-close"
  | "read";
function recordingOperations(steps: Step[], fault: Step | null = null): EvidenceHoldsFileOperations {
  const real = nodeEvidenceHoldsFileOperations;
  const step = async <T>(name: Step, work: () => Promise<T>): Promise<T> => {
    steps.push(name);
    if (name === fault) throw Object.assign(new Error(`EIO: i/o error, ${name}`), { code: "EIO" });
    return await work();
  };
  return {
    mkdir: (path) => step("mkdir", () => real.mkdir(path)),
    async open(path, flags, mode) {
      const directory = flags === fsConstants.O_RDONLY;
      const handle = await step(directory ? "open-directory" : "open-file", () => real.open(path, flags, mode));
      return {
        writeFile: (bytes) => step("write", () => handle.writeFile(bytes)),
        sync: () => step(directory ? "directory-sync" : "file-sync", () => handle.sync()),
        close: () => step(directory ? "directory-close" : "file-close", () => handle.close()),
      };
    },
    rename: (oldPath, newPath) => step("rename", () => real.rename(oldPath, newPath)),
    readFile: (path) => step("read", () => real.readFile(path)),
  };
}

describe("round 4, M2: the real holds writer and reader, operation by operation", () => {
  const sample = state([["w1", { holds: [HELD], settled: false }]]);
  const earlier = state([["w0", { holds: [{ fromMs: 7, toMs: 8 }], settled: false }]]);

  it("writes the file, fsyncs it, closes it, renames it, fsyncs the directory, and only then reads it back", async () => {
    const directory = await stateDirectory();
    const steps: Step[] = [];
    expect(await persistEvidenceHolds(directory, sample, evidenceHoldsFileSystem(recordingOperations(steps)))).toBe(sample);
    expect(steps).toStrictEqual(["mkdir", "open-file", "write", "file-sync", "file-close", "rename", "open-directory", "directory-sync", "directory-close", "read"]);
    expect(sameEvidenceHolds(await readEvidenceHolds(directory), sample)).toBe(true);
  });

  it("truncates a longer temporary file an interrupted write left behind: the holds read back exactly", async () => {
    const directory = await stateDirectory();
    const temporary = `${join(directory, EVIDENCE_HOLDS_FILE_NAME)}.${process.pid.toString(36)}.tmp`;
    await writeFile(temporary, "x".repeat(encodeEvidenceHolds(sample).length * 4));
    expect(await persistEvidenceHolds(directory, sample, evidenceHoldsFileSystem(recordingOperations([])))).toBe(sample);
    expect(Buffer.from(await readFile(join(directory, EVIDENCE_HOLDS_FILE_NAME))).equals(Buffer.from(encodeEvidenceHolds(sample)))).toBe(true);
  });

  it("reports a failed file fsync as a failure, before the new bytes take the file's name", async () => {
    const directory = await stateDirectory();
    await persistEvidenceHolds(directory, earlier);
    const before = await readFile(join(directory, EVIDENCE_HOLDS_FILE_NAME));
    const steps: Step[] = [];
    const result = await persistEvidenceHolds(directory, sample, evidenceHoldsFileSystem(recordingOperations(steps, "file-sync")));
    expect(result.failure).toMatch(/could not be made durable: EIO: i\/o error, file-sync/u);
    expect(steps).toStrictEqual(["mkdir", "open-file", "write", "file-sync", "file-close"]);
    expect(await readFile(join(directory, EVIDENCE_HOLDS_FILE_NAME))).toStrictEqual(before);
  });

  it("reports a failed directory fsync as a failure: the new name is not known to be durable", async () => {
    const directory = await stateDirectory();
    const steps: Step[] = [];
    const result = await persistEvidenceHolds(directory, sample, evidenceHoldsFileSystem(recordingOperations(steps, "directory-sync")));
    expect(result.failure).toMatch(/could not be made durable: EIO: i\/o error, directory-sync/u);
    expect(steps).toStrictEqual(["mkdir", "open-file", "write", "file-sync", "file-close", "rename", "open-directory", "directory-sync", "directory-close"]);
  });

  it("reads a file that exists but cannot be read (EIO) as a failure, and never overwrites it", async () => {
    const directory = await stateDirectory();
    await persistEvidenceHolds(directory, earlier);
    const before = await readFile(join(directory, EVIDENCE_HOLDS_FILE_NAME));
    const read = await readEvidenceHolds(directory, evidenceHoldsFileSystem(recordingOperations([], "read")));
    expect(read.failure).toMatch(/could not be read: EIO/u);
    expect(read.windows.size).toBe(0);
    // What the cycle then does: remember onto it, and try to persist it.
    const remembered = rememberEvidence({ state: read, classifications: [unclassified("w9", [HELD])], pass: cycle(), registeredWindowIds: new Set() });
    expect((await persistEvidenceHolds(directory, remembered)).failure).toBe(read.failure);
    expect(await readFile(join(directory, EVIDENCE_HOLDS_FILE_NAME))).toStrictEqual(before);
  });

  it("reads a path that is not a file (EISDIR) as a failure; only a file that does not exist (ENOENT) is none", async () => {
    const directory = await stateDirectory();
    expect(await readEvidenceHolds(directory)).toStrictEqual(emptyEvidenceHolds());
    await mkdir(join(directory, EVIDENCE_HOLDS_FILE_NAME));
    const read = await readEvidenceHolds(directory);
    expect(read.failure).toMatch(/could not be read: EISDIR/u);
  });
});
