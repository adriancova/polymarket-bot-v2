"""The DuckDB dataset-validation job.

It answers one question: **does this Parquet dataset actually match the manifest
that claims to describe it?** Handoff §0.1 promises "replayable, checksummed
datasets" and `WP-130`'s acceptance criteria are "record counts and hashes
reconcile" and "manifest pins incident exclusions and schema versions". Those
are checkable statements, and this is what checks them — from outside the
TypeScript that produced the artifact.

The checks, and what each one would catch:

1. **Object presence, length and SHA-256.** Bit rot, a truncated upload, or a
   manifest pinning an object that was never written.
2. **Layout.** Column names, order, and DuckDB's inferred types against the
   pinned column list. Catches a writer that changed the schema without bumping
   ``parquetLayoutVersion``.
3. **Row counts, per object and in total**, against ``recordCounts`` and each
   object's ``rowCount``. Catches a dropped page or a mis-stated count.
4. **Ordinal integrity.** ``datasetRowOrdinal`` is unique and forms the dense
   range ``0 .. written-1``. This is what makes ``ORDER BY datasetRowOrdinal``
   a faithful reconstruction of dispatch order (§8.4) rather than a hope.
5. **Row integrity.** ``ingestSeq`` matches the canonical unsigned-integer
   grammar of ``wal-format.md`` §5 (up to **40 digits** — which is why no
   check here ever casts it to a bounded integer type; see below), and every
   row's ``replayEligible``/``exclusionReason`` pair has a legal shape.
6. **Deduplication, with provenance.** Exactly one replay-eligible row per
   ``(gatewayEpoch, ingestSeq)``; and every row *marked* ``duplicate:<n>``
   really is one — the row at ordinal ``n`` exists, comes earlier, shares the
   key, and is byte-identical (same ``frameLineSha256``). A mislabeled
   "duplicate" would silently drop a genuine record from replay.
7. **Incident exclusion, bidirectionally.** Every replay-eligible row inside a
   pinned window is an error; every row *labeled* ``incident:<id>`` must lie
   inside that window's declared range; the per-window counts match; and the
   window's ``excludedSegmentIds`` reconcile with the segments the labeled
   rows actually came from. One direction alone accepts false provenance.
8. **Payload digests.** ``payloadSha256`` recomputed over ``payloadUtf8`` for
   every row, in DuckDB. This is the end-to-end byte-exactness check: if a
   payload lost a byte anywhere between the venue frame and this query, the
   digest the gateway computed no longer matches.
9. **Segment coverage and the retention receipt.** Every pinned segment's
   ``recordCount`` equals the rows its object holds, no unpinned segment
   appears in the data, and — when a retention receipt exists — every segment
   it claims was deleted is pinned and its object is present.

``ingestSeq`` ordering is decided on **canonical decimal strings** — compare
lengths first, then lexicographically — never by casting: the grammar admits
40 digits and even DuckDB's ``HUGEINT`` (INT128) cannot represent that domain.
A finding is returned, not raised: a validation job that stops at the first
problem tells an operator one thing about a dataset when they need all of them.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import duckdb

from research.compaction.manifest import (
    DatasetManifest,
    ManifestError,
    PARQUET_LAYOUT_ID,
    PARQUET_LAYOUT_VERSION,
    RETENTION_RECEIPT_FORMAT_ID,
    RETENTION_RECEIPT_OBJECT_NAME,
    RETENTION_RECEIPT_VERSION,
    load_manifest,
)

#: ``wal-format.md`` §5: canonical unsigned decimal, no leading zeros, ≤ 40
#: digits. Enforced by the row-integrity check, which is what entitles the
#: range comparisons below to compare by (length, lexicographic) instead of
#: casting — no bounded integer type (INT64 *or* INT128) can hold 40 digits.
_CANONICAL_UNSIGNED = re.compile(r"^(0|[1-9][0-9]*)$")
_MAX_SEQ_DIGITS = 40

#: DuckDB's SQL type for each physical type the layout pins.
_DUCKDB_TYPE_BY_PHYSICAL_TYPE = {
    "BYTE_ARRAY_UTF8": "VARCHAR",
    "INT64": "BIGINT",
    "BOOLEAN": "BOOLEAN",
}

_SEVERITIES = ("error", "warning")


@dataclass(frozen=True)
class ValidationFinding:
    """One thing that is wrong, or worth an operator's attention."""

    check: str
    severity: str
    message: str
    details: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.severity not in _SEVERITIES:
            raise ValueError(f"severity must be one of {_SEVERITIES}")


@dataclass(frozen=True)
class ValidationReport:
    """Everything the job learned."""

    dataset_id: str
    manifest_path: str
    object_root: str
    objects_checked: int
    rows_checked: int
    findings: tuple[ValidationFinding, ...]

    @property
    def errors(self) -> tuple[ValidationFinding, ...]:
        return tuple(f for f in self.findings if f.severity == "error")

    @property
    def ok(self) -> bool:
        """True when nothing at ``error`` severity was found."""
        return not self.errors

    def to_dict(self) -> dict[str, Any]:
        return {
            "datasetId": self.dataset_id,
            "manifestPath": self.manifest_path,
            "objectRoot": self.object_root,
            "objectsChecked": self.objects_checked,
            "rowsChecked": self.rows_checked,
            "ok": self.ok,
            "findings": [
                {
                    "check": f.check,
                    "severity": f.severity,
                    "message": f.message,
                    "details": f.details,
                }
                for f in self.findings
            ],
        }


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _object_path(object_root: Path, object_key: str) -> Path:
    # Object keys are store-relative and never absolute or traversing; the
    # compactor enforces that when it writes them. Re-checking here keeps a
    # hand-edited manifest from reading an arbitrary file.
    if object_key.startswith("/") or ".." in Path(object_key).parts:
        raise ManifestError(f"object key {object_key!r} is not store-relative")
    return object_root / object_key


def _check_objects(
    manifest: DatasetManifest, object_root: Path, findings: list[ValidationFinding]
) -> list[Path]:
    """Check 1: every pinned object exists with the pinned length and digest."""
    present: list[Path] = []
    for entry in manifest.objects:
        path = _object_path(object_root, entry.object_key)
        if not path.is_file():
            findings.append(
                ValidationFinding(
                    check="object-present",
                    severity="error",
                    message=f"pinned object is missing: {entry.object_key}",
                    details={"objectKey": entry.object_key, "path": str(path)},
                )
            )
            continue
        byte_length = path.stat().st_size
        if byte_length != entry.byte_length:
            findings.append(
                ValidationFinding(
                    check="object-length",
                    severity="error",
                    message=f"object length differs from the manifest: {entry.object_key}",
                    details={"expected": entry.byte_length, "observed": byte_length},
                )
            )
        digest = _sha256_file(path)
        if digest != entry.sha256:
            findings.append(
                ValidationFinding(
                    check="object-checksum",
                    severity="error",
                    message=f"object SHA-256 differs from the manifest: {entry.object_key}",
                    details={"expected": entry.sha256, "observed": digest},
                )
            )
        present.append(path)
    return present


def _check_layout(
    connection: duckdb.DuckDBPyConnection,
    manifest: DatasetManifest,
    paths: Sequence[Path],
    findings: list[ValidationFinding],
) -> None:
    """Check 2: the file's columns are the pinned ones, in the pinned order."""
    if manifest.parquet_layout_id != PARQUET_LAYOUT_ID:
        findings.append(
            ValidationFinding(
                check="layout-id",
                severity="error",
                message=(
                    "manifest pins a Parquet layout this validator does not implement: "
                    f"{manifest.parquet_layout_id}"
                ),
                details={"supported": PARQUET_LAYOUT_ID},
            )
        )
        return
    if manifest.parquet_layout_version != PARQUET_LAYOUT_VERSION:
        findings.append(
            ValidationFinding(
                check="layout-version",
                severity="error",
                message=(
                    f"manifest pins layout version {manifest.parquet_layout_version}; "
                    f"this validator implements {PARQUET_LAYOUT_VERSION}"
                ),
            )
        )
        return

    described = connection.execute(
        "describe select * from read_parquet($paths)", {"paths": [str(p) for p in paths]}
    ).fetchall()
    observed = [(row[0], row[1]) for row in described]
    expected = [
        (name, _DUCKDB_TYPE_BY_PHYSICAL_TYPE[physical_type])
        for name, physical_type, _nullable in manifest.columns
    ]
    if observed != expected:
        findings.append(
            ValidationFinding(
                check="layout-columns",
                severity="error",
                message="parquet columns do not match the pinned layout",
                details={"expected": expected, "observed": observed},
            )
        )


def _check_counts(
    connection: duckdb.DuckDBPyConnection,
    manifest: DatasetManifest,
    object_root: Path,
    findings: list[ValidationFinding],
) -> int:
    """Check 3: per-object and total row counts reconcile."""
    total = 0
    for entry in manifest.objects:
        path = _object_path(object_root, entry.object_key)
        if not path.is_file():
            continue
        row_count = connection.execute(
            "select count(*) from read_parquet($path)", {"path": str(path)}
        ).fetchone()[0]
        total += row_count
        if row_count != entry.row_count:
            findings.append(
                ValidationFinding(
                    check="object-row-count",
                    severity="error",
                    message=f"object row count differs from the manifest: {entry.object_key}",
                    details={"expected": entry.row_count, "observed": row_count},
                )
            )
        eligible = connection.execute(
            "select count(*) from read_parquet($path) where replayEligible",
            {"path": str(path)},
        ).fetchone()[0]
        if eligible != entry.replay_eligible_row_count:
            findings.append(
                ValidationFinding(
                    check="object-replay-eligible-count",
                    severity="error",
                    message=(
                        "object replay-eligible row count differs from the manifest: "
                        f"{entry.object_key}"
                    ),
                    details={"expected": entry.replay_eligible_row_count, "observed": eligible},
                )
            )

    counts = manifest.record_counts
    if total != counts.written:
        findings.append(
            ValidationFinding(
                check="dataset-row-count",
                severity="error",
                message="total rows differ from recordCounts.written",
                details={"expected": counts.written, "observed": total},
            )
        )
    if counts.segment_read != counts.written:
        findings.append(
            ValidationFinding(
                check="records-read-vs-written",
                severity="error",
                message=(
                    "every record read from a verified segment must be written: "
                    "exclusion marks rows, it never drops them"
                ),
                details={"read": counts.segment_read, "written": counts.written},
            )
        )
    if counts.segment_declared != counts.segment_read:
        findings.append(
            ValidationFinding(
                check="records-declared-vs-read",
                severity="error",
                message="segment manifests declared a different record count than was read",
                details={"declared": counts.segment_declared, "read": counts.segment_read},
            )
        )
    expected_eligible = counts.written - counts.excluded_by_incident - counts.excluded_as_duplicate
    if counts.replay_eligible != expected_eligible:
        findings.append(
            ValidationFinding(
                check="replay-eligible-arithmetic",
                severity="error",
                message="replayEligible does not equal written minus the exclusions",
                details={"expected": expected_eligible, "declared": counts.replay_eligible},
            )
        )
    return total


def _check_ordinals(
    connection: duckdb.DuckDBPyConnection,
    manifest: DatasetManifest,
    paths: Sequence[Path],
    findings: list[ValidationFinding],
) -> None:
    """Check 4: dispatch order is recoverable — dense, unique ordinals."""
    if not paths:
        return
    row = connection.execute(
        """
        select
            count(*) as rows,
            count(distinct datasetRowOrdinal) as distinct_ordinals,
            min(datasetRowOrdinal) as min_ordinal,
            max(datasetRowOrdinal) as max_ordinal
        from read_parquet($paths)
        """,
        {"paths": [str(p) for p in paths]},
    ).fetchone()
    rows, distinct_ordinals, min_ordinal, max_ordinal = row
    if rows == 0:
        return
    if distinct_ordinals != rows:
        findings.append(
            ValidationFinding(
                check="ordinal-uniqueness",
                severity="error",
                message="datasetRowOrdinal is not unique across the dataset",
                details={"rows": rows, "distinct": distinct_ordinals},
            )
        )
    if min_ordinal != 0 or max_ordinal != rows - 1:
        findings.append(
            ValidationFinding(
                check="ordinal-density",
                severity="error",
                message="datasetRowOrdinal is not the dense range 0..rows-1",
                details={"rows": rows, "min": min_ordinal, "max": max_ordinal},
            )
        )


def _check_row_integrity(
    connection: duckdb.DuckDBPyConnection,
    paths: Sequence[Path],
    findings: list[ValidationFinding],
) -> None:
    """Check 5: field grammar and exclusion shape the later checks rely on."""
    if not paths:
        return
    path_strings = [str(p) for p in paths]

    bad_seq = connection.execute(
        r"""
        select datasetRowOrdinal, ingestSeq
        from read_parquet($paths)
        where not regexp_matches(ingestSeq, '^(0|[1-9][0-9]*)$')
           or length(ingestSeq) > 40
        order by datasetRowOrdinal
        limit 20
        """,
        {"paths": path_strings},
    ).fetchall()
    if bad_seq:
        findings.append(
            ValidationFinding(
                check="ingest-seq-grammar",
                severity="error",
                message=(
                    "ingestSeq must be a canonical unsigned decimal string of at most "
                    "40 digits (wal-format.md §5)"
                ),
                details={"sample": [list(row) for row in bad_seq]},
            )
        )

    bad_shape = connection.execute(
        """
        select datasetRowOrdinal, replayEligible, exclusionReason
        from read_parquet($paths)
        where (replayEligible and exclusionReason is not null)
           or (not replayEligible and (exclusionReason is null
               or (exclusionReason not like 'incident:%'
                   and exclusionReason not like 'duplicate:%')))
        order by datasetRowOrdinal
        limit 20
        """,
        {"paths": path_strings},
    ).fetchall()
    if bad_shape:
        findings.append(
            ValidationFinding(
                check="exclusion-reason-shape",
                severity="error",
                message=(
                    "an eligible row must carry no exclusionReason, and an ineligible "
                    "row must carry 'incident:<id>' or 'duplicate:<ordinal>'"
                ),
                details={"sample": [list(row) for row in bad_shape]},
            )
        )


def _check_deduplication(
    connection: duckdb.DuckDBPyConnection,
    manifest: DatasetManifest,
    paths: Sequence[Path],
    findings: list[ValidationFinding],
) -> None:
    """Check 6: one eligible row per key, and duplicate marks carry real provenance."""
    if not paths:
        return
    duplicates = connection.execute(
        """
        select gatewayEpoch, ingestSeq, count(*) as copies
        from read_parquet($paths)
        where replayEligible
        group by gatewayEpoch, ingestSeq
        having count(*) > 1
        order by gatewayEpoch, ingestSeq
        limit 20
        """,
        {"paths": [str(p) for p in paths]},
    ).fetchall()
    if duplicates:
        findings.append(
            ValidationFinding(
                check="deduplication",
                severity="error",
                message=(
                    "more than one replay-eligible row shares a (gatewayEpoch, ingestSeq); "
                    "deduplication on that key is a binding obligation on WAL consumers"
                ),
                details={"sample": [list(row) for row in duplicates]},
            )
        )

    marked = connection.execute(
        """
        select count(*) from read_parquet($paths)
        where not replayEligible and exclusionReason like 'duplicate:%'
        """,
        {"paths": [str(p) for p in paths]},
    ).fetchone()[0]
    if marked != manifest.duplicate_record_count:
        findings.append(
            ValidationFinding(
                check="duplicate-count",
                severity="error",
                message="rows marked as duplicates differ from the manifest's count",
                details={"expected": manifest.duplicate_record_count, "observed": marked},
            )
        )

    # Provenance: counting labels proves nothing about their truth. A row
    # marked `duplicate:<n>` asserts that the row at ordinal `n` is an earlier,
    # byte-identical copy of the same frame — earlier in dispatch order,
    # sharing (gatewayEpoch, ingestSeq), and with the same frameLineSha256
    # (duplicates are re-recordings, so the whole WAL line is identical). A
    # mark whose claim does not hold hides a genuine record from replay.
    false_provenance = connection.execute(
        """
        with data as (select * from read_parquet($paths)),
        marked as (
            select
                datasetRowOrdinal,
                gatewayEpoch,
                ingestSeq,
                frameLineSha256,
                exclusionReason,
                try_cast(substr(exclusionReason, 11) as bigint) as claimed_ordinal
            from data
            where exclusionReason like 'duplicate:%'
        )
        select m.datasetRowOrdinal, m.exclusionReason
        from marked m
        left join data first_copy
            on first_copy.datasetRowOrdinal = m.claimed_ordinal
        where m.claimed_ordinal is null
           or first_copy.datasetRowOrdinal is null
           or first_copy.datasetRowOrdinal >= m.datasetRowOrdinal
           or first_copy.gatewayEpoch != m.gatewayEpoch
           or first_copy.ingestSeq != m.ingestSeq
           or first_copy.frameLineSha256 != m.frameLineSha256
           or first_copy.exclusionReason like 'duplicate:%'
        order by m.datasetRowOrdinal
        limit 20
        """,
        {"paths": [str(p) for p in paths]},
    ).fetchall()
    if false_provenance:
        findings.append(
            ValidationFinding(
                check="duplicate-provenance",
                severity="error",
                message=(
                    "rows are marked as duplicates without an earlier byte-identical "
                    "copy at the ordinal their mark names"
                ),
                details={"sample": [list(row) for row in false_provenance]},
            )
        )


def _check_incident_exclusions(
    connection: duckdb.DuckDBPyConnection,
    manifest: DatasetManifest,
    paths: Sequence[Path],
    findings: list[ValidationFinding],
) -> None:
    """Check 7: pinned windows are applied to the data — in both directions.

    One direction ("every in-window row is excluded") accepts false
    provenance: a row could be excluded for the wrong reason, or a row far
    outside the window could carry the window's label and inflate its count.
    So membership and labels are checked against each other: no eligible row
    inside a window, no labeled row outside its window, counts exact, and the
    pinned ``excludedSegmentIds`` reconciled against the segments the labeled
    rows actually came from.
    """
    if not paths:
        return
    path_strings = [str(p) for p in paths]

    # Membership is decided on `(gatewayEpoch, ingestSeq)` exactly as the
    # compactor decides it (`compareUnsignedIntegerStrings`): canonical
    # unsigned decimal strings compare by length first, then lexicographically.
    # Never by casting — the grammar admits 40 digits, and DuckDB's HUGEINT
    # (INT128) cannot represent that domain; the pre-remediation cast raised a
    # ConversionException on a valid 40-digit value. The grammar this relies
    # on (no leading zeros) is enforced by the row-integrity check.
    in_window = """
        gatewayEpoch = $epoch
        and (length(ingestSeq) > length($from_seq)
             or (length(ingestSeq) = length($from_seq) and ingestSeq >= $from_seq))
        and (length(ingestSeq) < length($to_seq)
             or (length(ingestSeq) = length($to_seq) and ingestSeq <= $to_seq))
    """

    for window in manifest.excluded_incident_windows:
        reason = f"incident:{window.incident_id}"
        bad_bounds = [
            bound
            for bound in (window.from_ingest_seq, window.to_ingest_seq)
            if not _CANONICAL_UNSIGNED.match(bound) or len(bound) > _MAX_SEQ_DIGITS
        ]
        if bad_bounds:
            findings.append(
                ValidationFinding(
                    check="incident-window-grammar",
                    severity="error",
                    message=(
                        f"incident window {window.incident_id} pins non-canonical "
                        "ingestSeq bounds; its range cannot be evaluated"
                    ),
                    details={"incidentId": window.incident_id, "bounds": bad_bounds},
                )
            )
            continue

        parameters = {
            "paths": path_strings,
            "epoch": window.gateway_epoch,
            "from_seq": window.from_ingest_seq,
            "to_seq": window.to_ingest_seq,
        }

        eligible_in_window = connection.execute(
            f"select count(*) from read_parquet($paths) where replayEligible and ({in_window})",
            parameters,
        ).fetchone()[0]
        if eligible_in_window:
            findings.append(
                ValidationFinding(
                    check="incident-exclusion-applied",
                    severity="error",
                    message=(
                        f"{eligible_in_window} row(s) inside pinned incident window "
                        f"{window.incident_id} are still replay-eligible"
                    ),
                    details={"incidentId": window.incident_id},
                )
            )

        # The other direction: a row carrying this window's label must lie
        # inside the range the manifest declares for it. This is what catches
        # the round-1 probe — an out-of-window row labeled incident:inc-1
        # previously validated, silently mislabeling which data was excluded.
        labeled_outside = connection.execute(
            f"""
            select count(*) from read_parquet($paths)
            where exclusionReason = $reason and not ({in_window})
            """,
            {**parameters, "reason": reason},
        ).fetchone()[0]
        if labeled_outside:
            findings.append(
                ValidationFinding(
                    check="incident-exclusion-range",
                    severity="error",
                    message=(
                        f"{labeled_outside} row(s) carry the label of incident window "
                        f"{window.incident_id} but lie outside its declared range"
                    ),
                    details={"incidentId": window.incident_id},
                )
            )

        marked = connection.execute(
            "select count(*) from read_parquet($paths) where exclusionReason = $reason",
            {"paths": path_strings, "reason": reason},
        ).fetchone()[0]
        if marked != window.excluded_record_count:
            findings.append(
                ValidationFinding(
                    check="incident-exclusion-count",
                    severity="error",
                    message=(
                        f"rows marked for incident {window.incident_id} differ from the "
                        "count the manifest pins"
                    ),
                    details={"expected": window.excluded_record_count, "observed": marked},
                )
            )

        observed_segments = [
            row[0]
            for row in connection.execute(
                """
                select distinct segmentId from read_parquet($paths)
                where exclusionReason = $reason
                order by segmentId
                """,
                {"paths": path_strings, "reason": reason},
            ).fetchall()
        ]
        pinned_segments = sorted(window.excluded_segment_ids)
        if observed_segments != pinned_segments:
            findings.append(
                ValidationFinding(
                    check="incident-exclusion-segments",
                    severity="error",
                    message=(
                        f"the segments carrying incident {window.incident_id}'s label "
                        "differ from the excludedSegmentIds the manifest pins"
                    ),
                    details={"pinned": pinned_segments, "observed": observed_segments},
                )
            )

    pinned_ids = {f"incident:{w.incident_id}" for w in manifest.excluded_incident_windows}
    orphaned = connection.execute(
        """
        select distinct exclusionReason
        from read_parquet($paths)
        where exclusionReason like 'incident:%'
        """,
        {"paths": path_strings},
    ).fetchall()
    unpinned = sorted({row[0] for row in orphaned} - pinned_ids)
    if unpinned:
        findings.append(
            ValidationFinding(
                check="incident-exclusion-pinned",
                severity="error",
                message="rows are excluded for an incident the manifest does not pin",
                details={"unpinned": unpinned},
            )
        )

    total_incident_rows = connection.execute(
        """
        select count(*) from read_parquet($paths)
        where not replayEligible and exclusionReason like 'incident:%'
        """,
        {"paths": path_strings},
    ).fetchone()[0]
    if total_incident_rows != manifest.record_counts.excluded_by_incident:
        findings.append(
            ValidationFinding(
                check="incident-exclusion-total",
                severity="error",
                message="incident-excluded rows differ from recordCounts.excludedByIncident",
                details={
                    "expected": manifest.record_counts.excluded_by_incident,
                    "observed": total_incident_rows,
                },
            )
        )


def _check_payload_digests(
    connection: duckdb.DuckDBPyConnection,
    paths: Sequence[Path],
    findings: list[ValidationFinding],
) -> None:
    """Check 7: every payload still hashes to the digest the gateway recorded."""
    if not paths:
        return
    mismatches = connection.execute(
        """
        select datasetRowOrdinal, segmentId, ingestSeq
        from read_parquet($paths)
        where sha256(payloadUtf8) != payloadSha256
        order by datasetRowOrdinal
        limit 20
        """,
        {"paths": [str(p) for p in paths]},
    ).fetchall()
    if mismatches:
        findings.append(
            ValidationFinding(
                check="payload-digest",
                severity="error",
                message="payloadSha256 does not match the SHA-256 of payloadUtf8",
                details={"sample": [list(row) for row in mismatches]},
            )
        )


def _check_segment_coverage(
    connection: duckdb.DuckDBPyConnection,
    manifest: DatasetManifest,
    paths: Sequence[Path],
    findings: list[ValidationFinding],
) -> None:
    """Check 9a: pinned segments and the rows in the data agree, both ways."""
    if not paths:
        return
    observed = dict(
        connection.execute(
            "select segmentId, count(*) from read_parquet($paths) group by segmentId",
            {"paths": [str(p) for p in paths]},
        ).fetchall()
    )
    pinned = {segment.segment_id: segment.record_count for segment in manifest.segments}

    for segment_id, expected in pinned.items():
        actual = observed.get(segment_id, 0)
        if actual != expected:
            findings.append(
                ValidationFinding(
                    check="segment-row-count",
                    severity="error",
                    message=f"segment {segment_id} contributed a different number of rows",
                    details={"expected": expected, "observed": actual},
                )
            )
    for segment_id in sorted(set(observed) - set(pinned)):
        findings.append(
            ValidationFinding(
                check="segment-pinned",
                severity="error",
                message=f"segment {segment_id} appears in the data but is not pinned",
            )
        )

    excluded = set(manifest.excluded_segment_ids)
    for segment_id in sorted(excluded & set(observed)):
        findings.append(
            ValidationFinding(
                check="excluded-segment-absent",
                severity="error",
                message=f"segment {segment_id} is listed as excluded but contributed rows",
            )
        )


def _check_retention_receipt(
    manifest: DatasetManifest,
    manifest_file: Path,
    object_root: Path,
    findings: list[ValidationFinding],
) -> None:
    """Check 9b: the retention receipt, when present, tells a coherent story.

    Deletion state is not in the (persisted-before-deletion, immutable)
    manifest; it lives in the receipt written next to it after retention ran.
    A deleted WAL segment is only safe because its verified object survives,
    so every deletion the receipt claims must name a pinned segment whose
    object is present. A malformed receipt is a finding, never a raise.
    """
    receipt_path = manifest_file.parent / RETENTION_RECEIPT_OBJECT_NAME
    if not receipt_path.is_file():
        if manifest.wal_retention_policy != "retain":
            findings.append(
                ValidationFinding(
                    check="retention-receipt-absent",
                    severity="warning",
                    message=(
                        f"the manifest records retention policy "
                        f"{manifest.wal_retention_policy!r} but no retention receipt "
                        "exists; deletions, if any, are unreported"
                    ),
                    details={"expectedPath": str(receipt_path)},
                )
            )
        return

    def broken(message: str, details: dict[str, Any] | None = None) -> None:
        findings.append(
            ValidationFinding(
                check="retention-receipt",
                severity="error",
                message=message,
                details=details or {},
            )
        )

    try:
        document = json.loads(receipt_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        broken(f"retention receipt could not be read: {error}")
        return
    if not isinstance(document, dict):
        broken("retention receipt is not a JSON object")
        return
    if document.get("retentionReceiptFormatId") != RETENTION_RECEIPT_FORMAT_ID:
        broken(
            "retention receipt declares an unknown format",
            {"formatId": document.get("retentionReceiptFormatId")},
        )
        return
    if document.get("retentionReceiptVersion") != RETENTION_RECEIPT_VERSION:
        broken(
            "retention receipt version is not readable by this build",
            {"version": document.get("retentionReceiptVersion")},
        )
        return
    if document.get("datasetId") != manifest.dataset_id:
        broken(
            "retention receipt names a different dataset",
            {"expected": manifest.dataset_id, "observed": document.get("datasetId")},
        )
    manifest_digest = hashlib.sha256(manifest_file.read_bytes()).hexdigest()
    if document.get("datasetManifestSha256") != manifest_digest:
        broken(
            "retention receipt pins a different manifest digest than the manifest's bytes",
            {
                "pinned": document.get("datasetManifestSha256"),
                "observed": manifest_digest,
            },
        )

    deleted = document.get("deletedSegments")
    if not isinstance(deleted, list):
        broken("retention receipt's deletedSegments is not an array")
        return
    pinned_segments = {segment.segment_id: segment for segment in manifest.segments}
    for entry in deleted:
        if not isinstance(entry, dict) or not isinstance(entry.get("segmentId"), str):
            broken("retention receipt lists a malformed deletion entry", {"entry": str(entry)})
            continue
        segment_id = entry["segmentId"]
        segment = pinned_segments.get(segment_id)
        if segment is None:
            broken(
                f"retention receipt claims deletion of segment {segment_id}, "
                "which the manifest does not pin",
                {"segmentId": segment_id},
            )
            continue
        object_path = _object_path(object_root, segment.object_key)
        if not object_path.is_file():
            findings.append(
                ValidationFinding(
                    check="deleted-segment-object",
                    severity="error",
                    message=(
                        f"segment {segment_id} was deleted from the WAL but its "
                        "compacted object is missing"
                    ),
                    details={"objectKey": segment.object_key},
                )
            )


def _infer_object_root(manifest_file: Path, manifest: DatasetManifest) -> Path:
    """Work out the store root from where the manifest sits.

    The manifest is written at ``<root>/<prefix>/manifest.json`` and every object
    key is ``<prefix>/<name>``, but the prefix is caller-chosen and may have any
    number of path components — so counting two levels up is wrong for
    ``a/b/c``. The prefix is instead read off an object key and stripped from
    the manifest's own directory, which is exact for any prefix depth.

    A dataset with no objects has no prefix to read, and nothing to resolve
    against either, so the manifest's directory is used and the objects list is
    empty by construction.
    """
    if not manifest.objects:
        return manifest_file.parent
    prefix_parts = Path(manifest.objects[0].object_key).parent.parts
    root = manifest_file.parent
    for _ in prefix_parts:
        root = root.parent
    return root


def validate_dataset(
    manifest_path: str | Path, object_root: str | Path | None = None
) -> ValidationReport:
    """Validate a compacted dataset against its manifest.

    ``object_root`` defaults to the directory that would make the manifest's own
    object key resolve to the manifest file — that is, the store root the
    compactor wrote into.
    """
    manifest_file = Path(manifest_path).resolve()
    manifest = load_manifest(manifest_file)

    if object_root is None:
        root = _infer_object_root(manifest_file, manifest)
    else:
        root = Path(object_root).resolve()

    findings: list[ValidationFinding] = []
    present = _check_objects(manifest, root, findings)
    _check_retention_receipt(manifest, manifest_file, root, findings)

    connection = duckdb.connect()
    try:
        if present:
            _check_layout(connection, manifest, present, findings)
        rows = _check_counts(connection, manifest, root, findings)
        # The remaining checks read columns by name, so they are meaningless if
        # the layout check already failed. Running them anyway would bury the
        # real finding under a pile of DuckDB binder errors.
        layout_failed = any(f.check.startswith("layout-") for f in findings)
        if present and not layout_failed:
            _check_ordinals(connection, manifest, present, findings)
            _check_row_integrity(connection, present, findings)
            _check_deduplication(connection, manifest, present, findings)
            _check_incident_exclusions(connection, manifest, present, findings)
            _check_payload_digests(connection, present, findings)
            _check_segment_coverage(connection, manifest, present, findings)
    finally:
        connection.close()

    return ValidationReport(
        dataset_id=manifest.dataset_id,
        manifest_path=str(manifest_file),
        object_root=str(root),
        objects_checked=len(present),
        rows_checked=rows,
        findings=tuple(findings),
    )


def main(argv: Sequence[str] | None = None) -> int:
    """CLI entry point. Exit code 0 means the dataset validated."""
    parser = argparse.ArgumentParser(
        prog="research.compaction",
        description=(
            "Validate a compacted Parquet dataset against its manifest using DuckDB "
            "(handoff §2, §8.4; WP-130 acceptance criteria)."
        ),
    )
    parser.add_argument("--manifest", required=True, help="path to the dataset manifest JSON")
    parser.add_argument(
        "--object-root",
        default=None,
        help="object-store root; defaults to two directories above the manifest",
    )
    parser.add_argument("--json", action="store_true", help="emit the report as JSON")
    arguments = parser.parse_args(argv)

    try:
        report = validate_dataset(arguments.manifest, arguments.object_root)
    except ManifestError as error:
        print(f"manifest error: {error}", file=sys.stderr)
        return 2

    if arguments.json:
        print(json.dumps(report.to_dict(), indent=2, sort_keys=True))
    else:
        print(f"dataset {report.dataset_id}")
        print(f"  objects checked: {report.objects_checked}")
        print(f"  rows checked:    {report.rows_checked}")
        if report.ok:
            print("  result:          OK")
        else:
            print(f"  result:          {len(report.errors)} error(s)")
            for finding in report.findings:
                print(f"    [{finding.severity}] {finding.check}: {finding.message}")
                if finding.details:
                    print(f"      {json.dumps(finding.details, sort_keys=True)}")

    return 0 if report.ok else 1


if __name__ == "__main__":  # pragma: no cover - exercised through __main__.py
    raise SystemExit(main())
