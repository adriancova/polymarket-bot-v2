/**
 * Reads recorded Polymarket frames out of a WAL root for the book snapshot
 * comparison job (`WP-140`).
 *
 * The WAL layout is `<walRoot>/<gatewayEpoch>/<segmentId>.wal.jsonl` with
 * one JSON object per line: a `{"record":"header"}` first line, §9.1
 * raw-frame lines, and a `{"record":"footer"}` line on cleanly closed
 * segments (`docs/contracts/wal-format.md`; `packages/storage-wal`).
 *
 * Epochs are processed **independently** — the WAL contract defines no
 * ordering between epochs (which is why the WP-130 compactor refuses
 * mixed-epoch input), and none is needed here: each epoch starts with fresh
 * authoritative snapshots, so book comparison is per-epoch by construction.
 * Within an epoch, frames are ordered by `ingestSeq` under the canonical
 * unsigned-decimal-string ordering (compare lengths, then lexicographically
 * — the WP-130 rule; the grammar admits 40 digits, beyond every bounded
 * integer type).
 *
 * This is harness I/O, deliberately OUTSIDE `packages/observability` (a
 * layer-1 module performs no I/O); the pure comparator it feeds lives there.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { RecordedFrameInput } from "../../../../packages/observability/src/recorder/index.js";

export interface EpochFrames {
  readonly gatewayEpoch: string;
  readonly frames: readonly RecordedFrameInput[];
}

const INGEST_SEQ_GRAMMAR = /^(?:0|[1-9]\d{0,39})$/u;

/** Canonical unsigned-decimal-string ordering (length, then lexicographic). */
export function compareIngestSeq(a: string, b: string): number {
  if (a.length !== b.length) {
    return a.length < b.length ? -1 : 1;
  }
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

interface WalLine {
  readonly record?: unknown;
  readonly source?: unknown;
  readonly ingestSeq?: unknown;
  readonly payloadUtf8?: unknown;
}

/**
 * Collect every recorded frame for `source` under a WAL root, per epoch.
 *
 * Unreadable lines are counted, never silently dropped: the return carries
 * `linesRefused`, and a caller that sees a non-zero count reports it.
 */
export function readRecordedFrames(
  walRoot: string,
  source: string,
): { readonly epochs: readonly EpochFrames[]; readonly linesRefused: number } {
  let linesRefused = 0;
  const epochs: EpochFrames[] = [];
  const epochDirs = readdirSync(walRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const epoch of epochDirs) {
    const epochPath = join(walRoot, epoch);
    const frames: { ingestSeq: string; payloadUtf8: string }[] = [];
    const segmentFiles = readdirSync(epochPath)
      .filter((name) => name.endsWith(".wal.jsonl"))
      .sort();
    for (const segmentFile of segmentFiles) {
      const content = readFileSync(join(epochPath, segmentFile), "utf8");
      for (const line of content.split("\n")) {
        if (line === "") {
          continue;
        }
        let parsed: WalLine;
        try {
          parsed = JSON.parse(line) as WalLine;
        } catch {
          linesRefused += 1;
          continue;
        }
        if (parsed.record === "header" || parsed.record === "footer") {
          continue;
        }
        if (
          typeof parsed.source !== "string" ||
          typeof parsed.ingestSeq !== "string" ||
          typeof parsed.payloadUtf8 !== "string" ||
          !INGEST_SEQ_GRAMMAR.test(parsed.ingestSeq)
        ) {
          linesRefused += 1;
          continue;
        }
        if (parsed.source !== source) {
          continue;
        }
        frames.push({ ingestSeq: parsed.ingestSeq, payloadUtf8: parsed.payloadUtf8 });
      }
    }
    frames.sort((a, b) => compareIngestSeq(a.ingestSeq, b.ingestSeq));
    epochs.push({ gatewayEpoch: epoch, frames });
  }
  return { epochs, linesRefused };
}
