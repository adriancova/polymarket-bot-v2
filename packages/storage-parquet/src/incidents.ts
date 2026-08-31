/**
 * Data-quality incident windows and how a dataset excludes them.
 *
 * Handoff §8.4: "Dataset manifests include all segment checksums, gateway
 * epochs, event ranges, and **excluded data-quality windows**." §12.5 repeats
 * "excluded incident windows" in the replay pin list, and §10.2 gives the
 * windows a home in `data.data_quality_incidents`. This module is the shape a
 * compaction run consumes and pins.
 *
 * ## Exclusion marks; it does not delete
 *
 * A record inside an excluded window is **written to the dataset** with
 * `replayEligible = false` and an `exclusionReason`, not dropped.
 *
 * That is not a stylistic preference. Once a compacted object is verified, a
 * retention policy may delete the WAL segment it came from (ADR-004 §5), and
 * from that moment the Parquet dataset is the only copy of those bytes. A
 * compactor that dropped incident-window records would therefore *destroy the
 * evidence of the incident* — the exact thing §16.6's fault scenarios and
 * §10.2's incident table exist to preserve. Marking keeps the archive complete
 * and still gives replay a single, cheap predicate: `WHERE replayEligible`.
 *
 * The manifest carries both numbers, so a reader never has to infer which
 * happened: `recordCounts.written` is everything in the dataset, and
 * `recordCounts.replayEligible` is what a replay will consume.
 */

import { compareUnsignedIntegerStrings } from "./wal-format.js";
import type { RawFrameRecord } from "./wal-format.js";

/** Classification of a data-quality incident (§10.2). */
export type IncidentKind =
  | "gap"
  | "staleness"
  | "corruption"
  | "resync"
  | "queue-overflow"
  | "capacity-exceeded"
  | "other";

/**
 * A half-open-free, **inclusive** range of `ingestSeq` within one gateway epoch.
 *
 * The range is expressed in `(gatewayEpoch, ingestSeq)` rather than in wall
 * time because that is the identity replay orders by (§8.4) and the only one
 * that survives a clock step. `receivedAt` bounds are carried for an operator's
 * benefit and are never used to decide membership.
 */
export type IncidentWindow = {
  /** Stable identifier, matching `data.data_quality_incidents` (§10.2). */
  readonly incidentId: string;
  readonly kind: IncidentKind;
  readonly gatewayEpoch: string;
  /** Inclusive lower bound, canonical unsigned integer string. */
  readonly fromIngestSeq: string;
  /** Inclusive upper bound, canonical unsigned integer string. */
  readonly toIngestSeq: string;
  /** Wall-clock bounds, for an operator. Not used for membership. */
  readonly openedAt: string;
  readonly closedAt: string | null;
  /** Why the window exists, in words. */
  readonly reason: string;
};

/** Does a record fall inside a window? */
export function windowContains(window: IncidentWindow, record: RawFrameRecord): boolean {
  if (record.gatewayEpoch !== window.gatewayEpoch) {
    return false;
  }
  return (
    compareUnsignedIntegerStrings(record.ingestSeq, window.fromIngestSeq) >= 0 &&
    compareUnsignedIntegerStrings(record.ingestSeq, window.toIngestSeq) <= 0
  );
}

/** The first window a record falls into, or `null`. */
export function findContainingWindow(
  windows: readonly IncidentWindow[],
  record: RawFrameRecord,
): IncidentWindow | null {
  for (const window of windows) {
    if (windowContains(window, record)) {
      return window;
    }
  }
  return null;
}

/** Validation failure for a caller-supplied window. */
export type IncidentWindowProblem = {
  readonly incidentId: string;
  readonly problem: string;
};

const CANONICAL_UNSIGNED_INTEGER = /^(0|[1-9][0-9]*)$/u;

/**
 * Check windows before a run consumes them.
 *
 * A malformed window is a caller bug that would silently exclude nothing (or
 * everything), so it is surfaced rather than tolerated. Two windows may
 * overlap: incidents genuinely do, and the first match wins deterministically
 * because {@link findContainingWindow} scans in the caller's order.
 */
export function validateIncidentWindows(
  windows: readonly IncidentWindow[],
): readonly IncidentWindowProblem[] {
  const problems: IncidentWindowProblem[] = [];
  const seen = new Set<string>();
  for (const window of windows) {
    if (window.incidentId.length === 0) {
      problems.push({ incidentId: window.incidentId, problem: "incidentId must not be empty" });
      continue;
    }
    if (seen.has(window.incidentId)) {
      problems.push({ incidentId: window.incidentId, problem: "duplicate incidentId" });
    }
    seen.add(window.incidentId);
    if (window.gatewayEpoch.length === 0) {
      problems.push({ incidentId: window.incidentId, problem: "gatewayEpoch must not be empty" });
    }
    if (!CANONICAL_UNSIGNED_INTEGER.test(window.fromIngestSeq)) {
      problems.push({
        incidentId: window.incidentId,
        problem: "fromIngestSeq must be a canonical unsigned integer string",
      });
    }
    if (!CANONICAL_UNSIGNED_INTEGER.test(window.toIngestSeq)) {
      problems.push({
        incidentId: window.incidentId,
        problem: "toIngestSeq must be a canonical unsigned integer string",
      });
    }
    if (
      CANONICAL_UNSIGNED_INTEGER.test(window.fromIngestSeq) &&
      CANONICAL_UNSIGNED_INTEGER.test(window.toIngestSeq) &&
      compareUnsignedIntegerStrings(window.fromIngestSeq, window.toIngestSeq) > 0
    ) {
      problems.push({
        incidentId: window.incidentId,
        problem: "fromIngestSeq must not be greater than toIngestSeq",
      });
    }
  }
  return problems;
}
