/**
 * The recorder's validation finding classes, as operational signals (`WP-140`).
 *
 * `WP-130`'s DuckDB validation job (`python/research/compaction/validate.py`)
 * answers "does this Parquet dataset actually match the manifest that claims
 * to describe it?" and reports **structured findings, never raises** — each
 * with a `check` class naming what broke. `WP-140` adds the book snapshot
 * comparison (`book-comparison.ts`), which reports its own classes in the
 * same shape. This module pins the union of both class sets so that:
 *
 * - the `recorder_validation_findings{class=...}` metric has a documented
 *   domain (unknown classes still render — the list documents, it does not
 *   filter — but an unknown class in a report means either a new validator
 *   version or a bug, and the consistency test below catches the former);
 * - the runbook's operational table (`docs/runbooks/recorder.md`) and this
 *   list cannot drift apart silently: a colocated test reads the validator's
 *   source and asserts every class it can emit appears here.
 *
 * The Python classes are MIRRORED here, not imported (a TS module cannot
 * import Python). `validation-findings.test.ts` greps the Python source for
 * `check="..."` literals and the dynamic `manifest-digest-*` family and fails
 * if this list is missing any of them.
 */

/** Classes the WP-130 DuckDB validator emits (mirrored; see module header). */
export const DATASET_VALIDATION_FINDING_CLASSES: readonly string[] = [
  "dataset-row-count",
  "deduplication",
  "deleted-segment-object",
  "duplicate-count",
  "duplicate-provenance",
  "excluded-segment-absent",
  "exclusion-reason-shape",
  "frame-line-digest",
  "incident-exclusion-applied",
  "incident-exclusion-count",
  "incident-exclusion-pinned",
  "incident-exclusion-range",
  "incident-exclusion-segments",
  "incident-exclusion-total",
  "incident-window-grammar",
  "ingest-seq-grammar",
  "layout-column-nullability",
  "layout-column-type",
  "layout-columns",
  "layout-id",
  "layout-version",
  "manifest-digest-absent",
  "manifest-digest-unreadable",
  "manifest-digest-malformed",
  "manifest-digest-mismatch",
  "object-checksum",
  "object-length",
  "object-not-a-file",
  "object-parquet",
  "object-present",
  "object-read",
  "object-replay-eligible-count",
  "object-row-count",
  "ordinal-density",
  "ordinal-uniqueness",
  "payload-digest",
  "records-declared-vs-read",
  "records-read-vs-written",
  "replay-eligible-arithmetic",
  "retention-receipt",
  "retention-receipt-absent",
  "segment-file-digest-grammar",
  "segment-pinned",
  "segment-row-count",
  "validator-query",
];

/** Classes the WP-140 book snapshot comparison emits (`book-comparison.ts`). */
export const BOOK_COMPARISON_FINDING_CLASSES: readonly string[] = [
  "book-divergence",
  "book-frame-unparseable",
  "book-level-grammar",
  "book-delta-before-snapshot",
  "book-crossed-reconstruction",
];

/** The union: every class a recorder validation job can report today. */
export const KNOWN_VALIDATION_FINDING_CLASSES: readonly string[] = [
  ...DATASET_VALIDATION_FINDING_CLASSES,
  ...BOOK_COMPARISON_FINDING_CLASSES,
];

export interface ValidationFindingInput {
  /** The finding class (the validator's `check`). */
  readonly check: string;
  /** The validator's severity string (e.g. "error", "warning", "info"). */
  readonly severity: string;
}

/** One validation run's outcome, ready for metric rendering. */
export interface ValidationMetricsInput {
  /** Which job produced this: e.g. "dataset-validation", "book-comparison". */
  readonly job: string;
  /** True when the run reported no error findings. */
  readonly ok: boolean;
  readonly findings: readonly ValidationFindingInput[];
}
