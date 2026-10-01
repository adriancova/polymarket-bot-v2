/**
 * Durable evidence holds (`STORAGE-1` rounds 3 and 4, L1 and M1; ADR-028
 * Decisions 2.3, 3.4, 3.5 and 6).
 *
 * Whatever a trader window's durable rows have shown to be chain evidence is
 * HELD until the window's pin holds it:
 *
 * - while the window is unclassified, the range its rows already show
 *   (`classify.ts`, `holdRanges`) — above all, the segment of every source
 *   event already located;
 * - once it is classified with evidence, its WHOLE pin extent (the window,
 *   widened to every evidence instant and every located source's segment,
 *   then the lead-in) for as long as that pin is not extracted, verified and
 *   trace-complete: while it waits on the extraction batch or the pin
 *   catalog, after a failed pin write, or when a recheck first learns it
 *   (round 4, M1).
 *
 * A hold seen in one cycle must still hold in every later one until the
 * window's pin holds that evidence: a later cycle may not be able to read the
 * trader's rows at all (a database restart, a refused connection, a timeout),
 * or may no longer have the window in its registry. So the holds live in the
 * state directory, one small file:
 *
 * - **Every cycle unions what it learns into the file, durably, before it
 *   plans** (and each recheck before its deletion). A hold is never shrunk.
 * - **A hold is released only when the window is settled**: classified, and
 *   its pin — extracted, its manifests verified, every source event of its
 *   chain inside — covers every held range and its own extent (or it is
 *   classified with no evidence and nothing was ever held). A recheck
 *   releases nothing.
 * - **A window whose rows cannot be read and that is not settled keeps EVERY
 *   segment** (`evidence-unreadable`, `plan.ts`): what it holds is unknown,
 *   and a chain source can lie in any earlier segment. That includes the very
 *   first failed read, when no hold was ever recorded. A settled window's
 *   evidence is final (its rows were durable when it classified) and its pin
 *   is a durable fact, so a later read failure hides nothing. The failure is
 *   remembered too (`unreadable`, cleared by the next read that succeeds): a
 *   window that leaves the registry while its rows could not be read still
 *   keeps every segment, since nothing will ever read them again.
 * - **A file that does not read keeps every segment and is never
 *   overwritten**; a cycle that cannot write it keeps every segment.
 *
 * Settlement is remembered only for windows still in the registry: a window
 * that leaves it is never read again. Holds are remembered whatever the
 * registry says.
 *
 * Removing the file releases every hold without verifying anything: that is a
 * deliberate operator decision, never automatic.
 */

import { constants as fsConstants } from "node:fs";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";

import { parseStrictJsonBytes, sha256Hex } from "@polymarket-bot/storage-parquet";

import type { WindowClassification } from "./classify.js";
import type { PinOutcome, PinRecord, PinSpec } from "./pins.js";
import type { Span } from "./wal-index.js";

/** The holds file in the state directory. */
export const EVIDENCE_HOLDS_FILE_NAME = "evidence-holds.json";

/** The version of the holds file. */
export const EVIDENCE_HOLDS_VERSION = 1;

/** What is durably known of one window's chain evidence. */
export type WindowEvidenceState = {
  /**
   * Ranges its rows have shown to hold chain evidence, merged: what it held
   * while unclassified, and its whole pin extent while classified and not
   * settled. Kept until it is settled.
   */
  readonly holds: readonly Span[];
  /** Classified, and its pin holds its evidence (or it has none): a later read failure hides nothing. */
  readonly settled: boolean;
  /** The last attempt to read its rows failed, and none has succeeded since. */
  readonly unreadable: boolean;
};

/** The durable holds, as this cycle knows them. */
export type EvidenceHoldState = {
  /** By window id. A window absent here holds nothing and is not settled. */
  readonly windows: ReadonlyMap<string, WindowEvidenceState>;
  /**
   * Set when the holds are not durably known (the file does not read, or this
   * cycle could not write it): the planner keeps every segment.
   */
  readonly failure: string | null;
};

/** No holds, nothing settled. */
export function emptyEvidenceHolds(): EvidenceHoldState {
  return { windows: new Map(), failure: null };
}

/** The holds file's path. */
export function evidenceHoldsPath(stateDirectory: string): string {
  return join(stateDirectory, EVIDENCE_HOLDS_FILE_NAME);
}

/**
 * Merge ranges into the fewest that cover the same instants: two ranges that
 * overlap become one. A segment overlaps the result exactly when it overlaps
 * one of the inputs.
 */
export function mergeSpans(spans: readonly Span[]): readonly Span[] {
  const sorted = [...spans].sort((left, right) => left.fromMs - right.fromMs || left.toMs - right.toMs);
  const merged: { fromMs: number; toMs: number }[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && span.fromMs <= last.toMs) {
      if (span.toMs > last.toMs) last.toMs = span.toMs;
    } else {
      merged.push({ fromMs: span.fromMs, toMs: span.toMs });
    }
  }
  return merged;
}

/** The file operations the holds need; a test substitutes them to prove each one matters. */
export type EvidenceHoldsFileSystem = {
  /** Write a file durably: temporary file, fsync, atomic rename, fsync of the directory. */
  writeDurably(path: string, bytes: Uint8Array): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
};

/** An open file, as the durable writer uses it. */
export type EvidenceHoldsFileHandle = {
  writeFile(bytes: Uint8Array): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
};

/**
 * The `node:fs/promises` calls the holds file is written and read with, and
 * nothing more. A test wraps them to record, and to fail, each step of the
 * REAL writer (`evidenceHoldsFileSystem`), as `execute.test.ts` does for the
 * expiry plan (round 4, M2).
 */
export type EvidenceHoldsFileOperations = {
  mkdir(path: string): Promise<void>;
  open(path: string, flags: number, mode?: number): Promise<EvidenceHoldsFileHandle>;
  rename(oldPath: string, newPath: string): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
};

/** The real calls. */
export const nodeEvidenceHoldsFileOperations: EvidenceHoldsFileOperations = {
  async mkdir(path) {
    await mkdir(path, { recursive: true });
  },
  open: async (path, flags, mode) => await open(path, flags, mode),
  rename: async (oldPath, newPath) => {
    await rename(oldPath, newPath);
  },
  readFile: async (path) => await readFile(path),
};

/**
 * The holds file's reader and durable writer over `operations`: the bytes
 * reach the disk (`fsync`) before the temporary file takes the name, and the
 * new name reaches the disk (`fsync` of the directory) before the write
 * returns. Every failure propagates: the caller then keeps every segment.
 */
export function evidenceHoldsFileSystem(operations: EvidenceHoldsFileOperations): EvidenceHoldsFileSystem {
  return {
    async writeDurably(path, bytes) {
      await operations.mkdir(dirname(path));
      const temporary = `${path}.${process.pid.toString(36)}.tmp`;
      const handle = await operations.open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC, 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await operations.rename(temporary, path);
      const directory = await operations.open(dirname(path), fsConstants.O_RDONLY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    },
    async readFile(path) {
      return await operations.readFile(path);
    },
  };
}

/** The real filesystem. */
export const nodeEvidenceHoldsFileSystem: EvidenceHoldsFileSystem = evidenceHoldsFileSystem(nodeEvidenceHoldsFileOperations);

function parseHolds(bytes: Uint8Array, path: string): ReadonlyMap<string, WindowEvidenceState> {
  const fail = (what: string): never => {
    throw new Error(`the evidence holds ${path} are not ones this build reads: ${what}`);
  };
  let value: unknown;
  try {
    value = parseStrictJsonBytes(bytes);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fail("not an object");
  const root = value as Record<string, unknown>;
  if (root["evidenceHoldsVersion"] !== EVIDENCE_HOLDS_VERSION) fail("an unknown evidenceHoldsVersion");
  const windows = root["windows"];
  if (!Array.isArray(windows)) return fail("windows is not an array");
  const out = new Map<string, WindowEvidenceState>();
  for (const [index, raw] of (windows as unknown[]).entries()) {
    const where = `windows[${String(index)}]`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return fail(`${where} is not an object`);
    const entry = raw as Record<string, unknown>;
    const windowId = entry["windowId"];
    if (typeof windowId !== "string" || windowId.length === 0) return fail(`${where}.windowId is malformed`);
    if (out.has(windowId)) fail(`${where}.windowId ${windowId} is listed twice`);
    if (typeof entry["settled"] !== "boolean") fail(`${where}.settled is not a boolean`);
    if (typeof entry["unreadable"] !== "boolean") fail(`${where}.unreadable is not a boolean`);
    const holds = entry["holds"];
    if (!Array.isArray(holds)) return fail(`${where}.holds is not an array`);
    const spans = (holds as unknown[]).map((rawSpan, spanIndex) => {
      const span = rawSpan as Record<string, unknown> | null;
      const fromMs = span?.["fromMs"];
      const toMs = span?.["toMs"];
      if (typeof fromMs !== "number" || typeof toMs !== "number" || !Number.isSafeInteger(fromMs) || !Number.isSafeInteger(toMs) || toMs < fromMs) {
        return fail(`${where}.holds[${String(spanIndex)}] is malformed`);
      }
      return { fromMs, toMs };
    });
    out.set(windowId, { holds: spans, settled: entry["settled"] as boolean, unreadable: entry["unreadable"] as boolean });
  }
  return out;
}

/**
 * Read the durable holds. No state directory (a dry run): nothing is durable,
 * and nothing is settled. No file yet (`ENOENT`, and only that): none. A file
 * that does not read — any other read error, or bytes that do not parse — is
 * a `failure` that keeps every segment, and it is never overwritten.
 */
export async function readEvidenceHolds(
  stateDirectory: string | null,
  fileSystem: EvidenceHoldsFileSystem = nodeEvidenceHoldsFileSystem,
): Promise<EvidenceHoldState> {
  if (stateDirectory === null) return emptyEvidenceHolds();
  const path = evidenceHoldsPath(stateDirectory);
  let bytes: Uint8Array;
  try {
    bytes = await fileSystem.readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyEvidenceHolds();
    return { windows: new Map(), failure: `the evidence holds ${path} could not be read: ${error instanceof Error ? error.message : String(error)}` };
  }
  try {
    return { windows: parseHolds(bytes, path), failure: null };
  } catch (error) {
    return { windows: new Map(), failure: error instanceof Error ? error.message : String(error) };
  }
}

/** The canonical bytes of the holds. */
export function encodeEvidenceHolds(state: EvidenceHoldState): Uint8Array {
  const windows = [...state.windows.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([windowId, entry]) => ({
      windowId,
      settled: entry.settled,
      unreadable: entry.unreadable,
      holds: entry.holds.map((span) => ({ fromMs: span.fromMs, toMs: span.toMs })),
    }));
  return Buffer.from(`${JSON.stringify({ evidenceHoldsVersion: EVIDENCE_HOLDS_VERSION, windows }, null, 2)}\n`, "utf8");
}

/**
 * Make the holds durable and read them back. Never called on a state whose
 * file did not read (it would erase what that file holds). Returns the state
 * to plan with: unchanged when written, or with `failure` set when not.
 */
export async function persistEvidenceHolds(
  stateDirectory: string | null,
  state: EvidenceHoldState,
  fileSystem: EvidenceHoldsFileSystem = nodeEvidenceHoldsFileSystem,
): Promise<EvidenceHoldState> {
  if (stateDirectory === null || state.failure !== null) return state;
  const path = evidenceHoldsPath(stateDirectory);
  const bytes = encodeEvidenceHolds(state);
  try {
    await fileSystem.writeDurably(path, bytes);
    if (sha256Hex(await fileSystem.readFile(path)) !== sha256Hex(bytes)) {
      throw new Error("they did not read back as written");
    }
  } catch (error) {
    return {
      windows: state.windows,
      failure: `the evidence holds ${path} could not be made durable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return state;
}

/**
 * The range a classified window's pin must hold — the window, widened to
 * every evidence instant and every located chain source's segment, then the
 * lead-in (`classify.ts`) — or none, for a window with no evidence or one not
 * classified.
 */
export function pinExtent(classification: WindowClassification): readonly Span[] {
  // A window classified with no evidence has no range (`classify.ts`).
  if (classification.state !== "classified" || classification.pinFromMs === null || classification.pinToMs === null) return [];
  return [{ fromMs: classification.pinFromMs, toMs: classification.pinToMs }];
}

/** Whether a pin record's range covers every range. */
function recordCovers(record: PinRecord, spans: readonly Span[]): boolean {
  const fromMs = Date.parse(record.from);
  const toMs = Date.parse(record.to);
  return spans.every((span) => fromMs <= span.fromMs && span.toMs <= toMs);
}

/** The window pin spec this cycle derives (or binds) for a window. */
function windowSpecOf(specs: readonly PinSpec[], windowId: string): PinSpec | undefined {
  return specs.find((candidate) => candidate.origin === "window" && candidate.windowId === windowId);
}

/**
 * The windows this cycle settles: classified, and either its pin — this
 * cycle's outcome for the window's (bound) spec, extracted or already
 * extracted, so its manifests verified — has a complete trace and a range
 * covering every range the window holds AND its own pin extent, or it is
 * classified with no evidence and holds nothing.
 */
export function settledWindowIds(input: {
  readonly classifications: Iterable<WindowClassification>;
  readonly specs: readonly PinSpec[];
  readonly outcomes: readonly PinOutcome[];
  readonly state: EvidenceHoldState;
}): ReadonlySet<string> {
  const settled = new Set<string>();
  for (const classification of input.classifications) {
    if (classification.state !== "classified") continue;
    const held = [...(input.state.windows.get(classification.windowId)?.holds ?? []), ...pinExtent(classification)];
    if (classification.pinClass === null) {
      // Classified with no evidence. A window that once held evidence and now
      // shows none is not settled: the hold stays (rows only ever grow).
      if (held.length === 0) settled.add(classification.windowId);
      continue;
    }
    const spec = windowSpecOf(input.specs, classification.windowId);
    if (spec === undefined) continue;
    const outcome = input.outcomes.find((candidate) => candidate.pinId === spec.pinId);
    if (outcome === undefined || outcome.status === "waiting" || !outcome.record.sourceEventsInside) continue;
    if (recordCovers(outcome.record, held)) settled.add(classification.windowId);
  }
  return settled;
}

/**
 * For a recheck, which extracts no pin and verifies none: the classified
 * windows whose pin extent a pin record ALREADY in the store holds — the
 * record the window's (bound) spec names, with a complete trace, its range
 * covering the extent. Such a window gains no hold in the recheck: the record
 * is a durable fact the planner obliges every segment it covers to, whatever
 * the registry says. Every other classified window with evidence gains its
 * whole extent as a hold (round 4, M1).
 */
export function recordedWindowIds(input: {
  readonly classifications: Iterable<WindowClassification>;
  readonly specs: readonly PinSpec[];
  readonly records: readonly PinRecord[];
}): ReadonlySet<string> {
  const recorded = new Set<string>();
  for (const classification of input.classifications) {
    // A window with no evidence has no window spec (`pinSpecs`), and so is never named.
    const spec = windowSpecOf(input.specs, classification.windowId);
    if (spec === undefined) continue;
    const extent = pinExtent(classification);
    const record = input.records.find((candidate) => candidate.pinId === spec.pinId);
    if (record === undefined || !record.sourceEventsInside) continue;
    if (recordCovers(record, extent)) recorded.add(classification.windowId);
  }
  return recorded;
}

/**
 * How this pass may change a classified window: a cycle settles the windows
 * `settledWindowIds` names; a recheck settles and releases nothing, and adds
 * no hold for the windows `recordedWindowIds` names.
 */
export type EvidencePass =
  | { readonly kind: "cycle"; readonly settled: ReadonlySet<string> }
  | { readonly kind: "recheck"; readonly recorded: ReadonlySet<string> };

/**
 * The holds after this pass's classifications.
 *
 * - An unclassified window whose rows read adds its `holdRanges` and is not
 *   settled; one whose rows did not read keeps its holds and settlement and is
 *   marked `unreadable` (nothing is learned). Any read that succeeds clears
 *   `unreadable`.
 * - A classified window a cycle settles is settled, and its holds are
 *   released.
 * - Every other classified window with evidence adds its whole pin extent and
 *   is not settled (round 4, M1) — its pin waits on the extraction batch or
 *   the pin catalog, its extraction failed, or a recheck first learned it —
 *   except, in a recheck, one whose pin record already holds that extent,
 *   which is unchanged. A classified window with no evidence that is not
 *   settled keeps what it holds.
 * - Settlement is forgotten for a window no longer in the registry; holds,
 *   and a failed read of an unsettled window, are kept whatever the registry
 *   says.
 */
export function rememberEvidence(input: {
  readonly state: EvidenceHoldState;
  readonly classifications: Iterable<WindowClassification>;
  readonly pass: EvidencePass;
  readonly registeredWindowIds: ReadonlySet<string>;
}): EvidenceHoldState {
  const next = new Map(input.state.windows);
  for (const classification of input.classifications) {
    const previous = next.get(classification.windowId) ?? { holds: [], settled: false, unreadable: false };
    if (classification.state === "unclassified") {
      if (classification.evidenceUnreadable !== undefined) {
        next.set(classification.windowId, { ...previous, unreadable: true });
        continue;
      }
      next.set(classification.windowId, {
        holds: mergeSpans([...previous.holds, ...classification.holdRanges]),
        settled: false,
        unreadable: false,
      });
      continue;
    }
    if (input.pass.kind === "cycle" && input.pass.settled.has(classification.windowId)) {
      next.set(classification.windowId, { holds: [], settled: true, unreadable: false });
      continue;
    }
    const extent = pinExtent(classification);
    if (input.pass.kind === "recheck" && (extent.length === 0 || input.pass.recorded.has(classification.windowId))) {
      next.set(classification.windowId, { ...previous, unreadable: false });
      continue;
    }
    next.set(classification.windowId, {
      holds: mergeSpans([...previous.holds, ...extent]),
      settled: false,
      unreadable: false,
    });
  }
  for (const [windowId, entry] of next) {
    if (entry.holds.length > 0 || (entry.unreadable && !entry.settled)) continue;
    if (!entry.settled || !input.registeredWindowIds.has(windowId)) next.delete(windowId);
  }
  return { windows: next, failure: input.state.failure };
}

/** Whether two states hold and settle the same. */
export function sameEvidenceHolds(left: EvidenceHoldState, right: EvidenceHoldState): boolean {
  return Buffer.from(encodeEvidenceHolds(left)).equals(Buffer.from(encodeEvidenceHolds(right)));
}
