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
 * **Epoch identity must AGREE four ways** (remediation round 1, M-2): the
 * directory the segment sits in, the segment header's `gatewayEpoch`, every
 * frame's `gatewayEpoch`, and the footer's `gatewayEpoch` when one exists.
 * Directory placement alone is a NAME, and the WAL contract is explicit that
 * identity is what the header says, never what a name implies — so a
 * disagreement is refused input, counted (`linesRefused`, plus the dedicated
 * `epochIdentityRefusals`), never adjudicated: this reader does not pick a
 * winner between a directory and a header. A segment whose header identity
 * cannot be established (missing, unparseable, or mismatched header) is
 * refused whole, because every frame under it would inherit an unproven
 * identity.
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
  readonly gatewayEpoch?: unknown;
  readonly source?: unknown;
  readonly ingestSeq?: unknown;
  readonly payloadUtf8?: unknown;
}

export interface ReadRecordedFramesResult {
  readonly epochs: readonly EpochFrames[];
  /** Every refused line, for any reason (includes the identity refusals). */
  readonly linesRefused: number;
  /**
   * Of `linesRefused`, those refused because directory, header, frame, and
   * footer epoch identities did not all agree (M-2). Any non-zero value
   * means the WAL root's placement and its contents disagree — an input
   * integrity problem to resolve BEFORE trusting any comparison over it.
   */
  readonly epochIdentityRefusals: number;
}

/**
 * Collect every recorded frame for `source` under a WAL root, per epoch.
 *
 * Refused lines are counted, never silently dropped: the return carries
 * `linesRefused` (and the identity subset `epochIdentityRefusals`), and a
 * caller that sees a non-zero count reports it and fails.
 */
export function readRecordedFrames(
  walRoot: string,
  source: string,
): ReadRecordedFramesResult {
  let linesRefused = 0;
  let epochIdentityRefusals = 0;
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
      const lines = content.split("\n").filter((line) => line !== "");

      // The header is the segment's identity (WAL contract: identity is what
      // the header says, never what a name implies). It must exist, parse,
      // and AGREE with the directory the segment sits in — otherwise every
      // line of the segment is refused: its identity is unproven.
      let headerAgrees = false;
      const firstLine = lines[0];
      if (firstLine !== undefined) {
        try {
          const header = JSON.parse(firstLine) as WalLine;
          headerAgrees = header.record === "header" && header.gatewayEpoch === epoch;
        } catch {
          headerAgrees = false;
        }
      }
      if (!headerAgrees) {
        linesRefused += lines.length;
        epochIdentityRefusals += lines.length;
        continue;
      }

      for (const line of lines.slice(1)) {
        let parsed: WalLine;
        try {
          parsed = JSON.parse(line) as WalLine;
        } catch {
          linesRefused += 1;
          continue;
        }
        if (parsed.record === "header" || parsed.record === "footer") {
          // A second header, or the footer: its identity must agree too.
          if (parsed.gatewayEpoch !== epoch) {
            linesRefused += 1;
            epochIdentityRefusals += 1;
          }
          continue;
        }
        // A frame's own declared epoch must agree with the directory AND the
        // header (which already agree with each other at this point).
        if (parsed.gatewayEpoch !== epoch) {
          linesRefused += 1;
          epochIdentityRefusals += 1;
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
  return { epochs, linesRefused, epochIdentityRefusals };
}
