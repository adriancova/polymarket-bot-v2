/**
 * Durable evidence holds (`STORAGE-1` round 3, L1; ADR-028 Decisions 2.3,
 * 3.4 and 6).
 *
 * While a trader window is unclassified, the range its durable rows already
 * show to hold chain evidence — above all, the segment of every source event
 * already located — is HELD (`classify.ts`, `holdRanges`). A hold seen in one
 * cycle must still hold in every later one until the window's pin holds that
 * evidence: a later cycle may not be able to read the trader's rows at all (a
 * database restart, a refused connection, a timeout), or may no longer have
 * the window in its registry. So the holds live in the state directory, one
 * small file:
 *
 * - **Every cycle unions what it learns into the file, durably, before it
 *   plans** (and each recheck before its deletion). A hold is never shrunk.
 * - **A hold is released only when the window is settled**: classified, and
 *   its pin — extracted, its manifests verified, every source event of its
 *   chain inside — covers every held range (or it is classified with no
 *   evidence and nothing was ever held).
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
import type { PinOutcome, PinSpec } from "./pins.js";
import type { Span } from "./wal-index.js";

/** The holds file in the state directory. */
export const EVIDENCE_HOLDS_FILE_NAME = "evidence-holds.json";

/** The version of the holds file. */
export const EVIDENCE_HOLDS_VERSION = 1;

/** What is durably known of one window's chain evidence. */
export type WindowEvidenceState = {
  /** Ranges its rows have shown to hold chain evidence, merged; kept until it is settled. */
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
 * and nothing is settled. No file yet: none. A file that does not read: its
 * `failure` keeps every segment, and it is never overwritten.
 */
export async function readEvidenceHolds(stateDirectory: string | null): Promise<EvidenceHoldState> {
  if (stateDirectory === null) return emptyEvidenceHolds();
  const path = evidenceHoldsPath(stateDirectory);
  let bytes: Uint8Array;
  try {
    bytes = await readFile(path);
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

/** The file operations the holds need; a test substitutes them to prove each one matters. */
export type EvidenceHoldsFileSystem = {
  /** Write a file durably: temporary file, fsync, atomic rename, fsync of the directory. */
  writeDurably(path: string, bytes: Uint8Array): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
};

/** The real filesystem. */
export const nodeEvidenceHoldsFileSystem: EvidenceHoldsFileSystem = {
  async writeDurably(path, bytes) {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid.toString(36)}.tmp`;
    const handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC, 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    const directory = await open(dirname(path), fsConstants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  },
  async readFile(path) {
    return await readFile(path);
  },
};

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
 * The windows this cycle settles: classified, and either its pin — this
 * cycle's outcome for the window's (bound) spec, extracted or already
 * extracted, so its manifests verified — has a complete trace and a range
 * covering every range the window holds, or it is classified with no evidence
 * and holds nothing.
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
    const held = input.state.windows.get(classification.windowId)?.holds ?? [];
    if (classification.pinClass === null) {
      // Classified with no evidence. A window that once held evidence and now
      // shows none is not settled: the hold stays (rows only ever grow).
      if (held.length === 0) settled.add(classification.windowId);
      continue;
    }
    const spec = input.specs.find((candidate) => candidate.origin === "window" && candidate.windowId === classification.windowId);
    if (spec === undefined) continue;
    const outcome = input.outcomes.find((candidate) => candidate.pinId === spec.pinId);
    if (outcome === undefined || outcome.status === "waiting" || !outcome.record.sourceEventsInside) continue;
    const fromMs = Date.parse(outcome.record.from);
    const toMs = Date.parse(outcome.record.to);
    if (held.every((span) => fromMs <= span.fromMs && span.toMs <= toMs)) settled.add(classification.windowId);
  }
  return settled;
}

/**
 * The holds after this cycle's classifications.
 *
 * - An unclassified window whose rows read adds its `holdRanges` and is not
 *   settled; one whose rows did not read keeps its holds and settlement and is
 *   marked `unreadable` (nothing is learned). Any read that succeeds clears
 *   `unreadable`.
 * - A classified window is settled exactly when `settled` names it, and a
 *   settled window's holds are released. `settled` `null` (a recheck, which
 *   extracts no pin) changes no classified window's holds or settlement.
 * - Settlement is forgotten for a window no longer in the registry; holds,
 *   and a failed read of an unsettled window, are kept whatever the registry
 *   says.
 */
export function rememberEvidence(input: {
  readonly state: EvidenceHoldState;
  readonly classifications: Iterable<WindowClassification>;
  readonly settled: ReadonlySet<string> | null;
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
    } else if (input.settled !== null) {
      next.set(
        classification.windowId,
        input.settled.has(classification.windowId)
          ? { holds: [], settled: true, unreadable: false }
          : { holds: previous.holds, settled: false, unreadable: false },
      );
    } else {
      next.set(classification.windowId, { ...previous, unreadable: false });
    }
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
