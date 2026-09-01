"""The validator finds what it claims to find, and passes what it should pass."""

from __future__ import annotations

import errno as errno_module
import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from research.compaction import ManifestError, validate_dataset
from research.compaction.manifest import load_manifest, parse_manifest
from research.compaction.validate import main

from .build_dataset import (
    EPOCH,
    Row,
    build_dataset,
    default_rows,
    frame_line,
    incident_window,
    rewrite_manifest,
)


def checks(report) -> set[str]:
    return {finding.check for finding in report.findings}


def require_read_denial(tmp_path: Path) -> None:
    """Skip when ``chmod 000`` does not actually deny reads (e.g. as root).

    The permission-based tests below need the operating system to enforce the
    mode bits; a root user (or some container filesystems) reads a mode-000
    file anyway, which would make the probe meaningless rather than failing.
    """
    probe = tmp_path / "read-denial-probe"
    probe.write_text("x", encoding="utf-8")
    probe.chmod(0)
    try:
        probe.read_bytes()
    except PermissionError:
        return
    finally:
        probe.chmod(0o600)
        probe.unlink()
    pytest.skip("chmod 000 does not deny reads in this environment (running as root?)")


def test_a_well_formed_dataset_validates(tmp_path: Path) -> None:
    manifest_path = build_dataset(tmp_path)
    report = validate_dataset(manifest_path)
    assert report.ok, [f.message for f in report.findings]
    assert report.rows_checked == 5
    assert report.objects_checked == 2


def test_object_root_is_inferred_from_the_manifest_location(tmp_path: Path) -> None:
    manifest_path = build_dataset(tmp_path)
    inferred = validate_dataset(manifest_path)
    explicit = validate_dataset(manifest_path, tmp_path)
    assert inferred.object_root == explicit.object_root
    assert inferred.ok and explicit.ok


def test_a_missing_object_is_an_error(tmp_path: Path) -> None:
    manifest_path = build_dataset(tmp_path)
    manifest = load_manifest(manifest_path)
    (tmp_path / manifest.objects[0].object_key).unlink()
    report = validate_dataset(manifest_path)
    assert not report.ok
    assert "object-present" in checks(report)


def test_a_flipped_byte_is_caught_by_the_object_checksum(tmp_path: Path) -> None:
    manifest_path = build_dataset(tmp_path)
    manifest = load_manifest(manifest_path)
    target = tmp_path / manifest.objects[0].object_key
    data = bytearray(target.read_bytes())
    # Flip a byte inside the data pages, away from the magic footer, so the
    # file still parses and only the digest can tell.
    data[len(data) // 2] ^= 0xFF
    target.write_bytes(bytes(data))
    report = validate_dataset(manifest_path)
    assert not report.ok
    assert "object-checksum" in checks(report)


def test_a_wrong_object_length_is_an_error(tmp_path: Path) -> None:
    manifest_path = build_dataset(tmp_path)
    rewrite_manifest(manifest_path, lambda doc: doc["objects"][0].update({"byteLength": 1}))
    report = validate_dataset(manifest_path)
    assert not report.ok
    assert "object-length" in checks(report)


def test_a_wrong_row_count_is_an_error(tmp_path: Path) -> None:
    manifest_path = build_dataset(tmp_path)
    rewrite_manifest(manifest_path, lambda doc: doc["objects"][0].update({"rowCount": 99}))
    report = validate_dataset(manifest_path)
    assert not report.ok
    assert "object-row-count" in checks(report)


def test_a_wrong_total_count_is_an_error(tmp_path: Path) -> None:
    manifest_path = build_dataset(tmp_path)
    rewrite_manifest(manifest_path, lambda doc: doc["recordCounts"].update({"written": 99}))
    report = validate_dataset(manifest_path)
    assert not report.ok
    assert "dataset-row-count" in checks(report)


def test_declared_and_read_counts_must_agree(tmp_path: Path) -> None:
    manifest_path = build_dataset(tmp_path)
    rewrite_manifest(
        manifest_path, lambda doc: doc["recordCounts"].update({"segmentDeclared": 6})
    )
    report = validate_dataset(manifest_path)
    assert not report.ok
    assert "records-declared-vs-read" in checks(report)


def test_dropping_a_record_instead_of_marking_it_is_an_error(tmp_path: Path) -> None:
    # The exclusion rule this package is built on: a record is marked, never
    # dropped, because the object may outlive the WAL segment.
    manifest_path = build_dataset(tmp_path)
    rewrite_manifest(manifest_path, lambda doc: doc["recordCounts"].update({"segmentRead": 6}))
    report = validate_dataset(manifest_path)
    assert not report.ok
    assert "records-declared-vs-read" in checks(report)
    assert "records-read-vs-written" in checks(report)


def test_replay_eligible_arithmetic_must_hold(tmp_path: Path) -> None:
    manifest_path = build_dataset(tmp_path)
    rewrite_manifest(
        manifest_path, lambda doc: doc["recordCounts"].update({"replayEligible": 5})
    )
    report = validate_dataset(manifest_path)
    assert not report.ok
    assert "replay-eligible-arithmetic" in checks(report)


def test_non_dense_ordinals_are_an_error(tmp_path: Path) -> None:
    rows = default_rows()
    rows[4] = Row(99, rows[4].segment_id, 1, 2, "5", '{"price":"1.0"}')
    manifest_path = build_dataset(tmp_path, rows=rows)
    report = validate_dataset(manifest_path)
    assert not report.ok
    assert "ordinal-density" in checks(report)


def test_duplicate_ordinals_are_an_error(tmp_path: Path) -> None:
    rows = default_rows()
    rows[4] = Row(3, rows[4].segment_id, 1, 2, "5", '{"price":"1.0"}')
    manifest_path = build_dataset(tmp_path, rows=rows)
    report = validate_dataset(manifest_path)
    assert not report.ok
    assert "ordinal-uniqueness" in checks(report)


def test_two_eligible_rows_under_one_key_are_an_error(tmp_path: Path) -> None:
    # Deduplication on (gatewayEpoch, ingestSeq) is a binding obligation on
    # every consumer of this WAL.
    rows = default_rows()
    rows[3] = Row(3, rows[3].segment_id, 1, 1, "3", "PONG")
    manifest_path = build_dataset(tmp_path, rows=rows)
    report = validate_dataset(manifest_path)
    assert not report.ok
    assert "deduplication" in checks(report)


def test_a_correctly_marked_duplicate_validates(tmp_path: Path) -> None:
    rows = default_rows()
    rows[3] = Row(
        3,
        rows[3].segment_id,
        1,
        1,
        "3",
        '{"price":"0.100"}',
        replay_eligible=False,
        exclusion_reason="duplicate:2",
    )
    manifest_path = build_dataset(tmp_path, rows=rows)
    report = validate_dataset(manifest_path)
    assert report.ok, [f.message for f in report.findings]


def test_a_pinned_incident_window_that_was_not_applied_is_an_error(tmp_path: Path) -> None:
    # The failure mode that matters most: a manifest that claims an exclusion
    # over a dataset where nothing is marked.
    rows = default_rows()
    rows[1] = Row(1, rows[1].segment_id, 0, 1, "2", "PING")
    manifest_path = build_dataset(tmp_path, rows=rows, incident_windows=[incident_window(0)])
    report = validate_dataset(manifest_path)
    assert not report.ok
    assert "incident-exclusion-applied" in checks(report)


def test_a_wrong_incident_exclusion_count_is_an_error(tmp_path: Path) -> None:
    manifest_path = build_dataset(tmp_path, incident_windows=[incident_window(7)])
    report = validate_dataset(manifest_path)
    assert not report.ok
    assert "incident-exclusion-count" in checks(report)


def test_an_unpinned_incident_exclusion_is_an_error(tmp_path: Path) -> None:
    manifest_path = build_dataset(tmp_path, incident_windows=[])
    report = validate_dataset(manifest_path)
    assert not report.ok
    assert "incident-exclusion-pinned" in checks(report)


def test_an_incident_window_beyond_int64_is_evaluated_exactly(tmp_path: Path) -> None:
    huge = "9" * 30
    rows = [
        Row(0, f"{EPOCH}-000000", 0, 0, huge, "x", False, "incident:inc-1"),
        Row(1, f"{EPOCH}-000000", 0, 1, "1" + "0" * 30, "y"),
    ]
    window = incident_window(1)
    window["window"]["fromIngestSeq"] = huge
    window["window"]["toIngestSeq"] = huge
    manifest_path = build_dataset(tmp_path, rows=rows, incident_windows=[window])
    report = validate_dataset(manifest_path)
    assert report.ok, [f.message for f in report.findings]


def test_a_forty_digit_ingest_seq_is_compared_exactly_not_cast(tmp_path: Path) -> None:
    # Reviewer probe (M2): wal-format.md §5 admits up to 40 digits, which
    # exceeds even DuckDB's HUGEINT (INT128); the pre-remediation cast raised
    # an uncaught ConversionException on this input, contradicting the
    # module's "a finding is returned, not raised" contract. Comparison is now
    # on canonical decimal strings — length first, then lexicographic.
    forty = "9" * 40
    just_below = "9" * 39 + "8"
    rows = [
        Row(0, f"{EPOCH}-000000", 0, 0, just_below, "x"),
        Row(1, f"{EPOCH}-000000", 0, 1, forty, "y", False, "incident:inc-1"),
    ]
    window = incident_window(1)
    window["window"]["fromIngestSeq"] = forty
    window["window"]["toIngestSeq"] = forty
    manifest_path = build_dataset(tmp_path, rows=rows, incident_windows=[window])
    report = validate_dataset(manifest_path)  # must not raise
    assert report.ok, [f.message for f in report.findings]


def test_string_order_is_numeric_order_for_canonical_sequences(tmp_path: Path) -> None:
    # "9" < "10" numerically although "9" > "10" lexically: the length-first
    # rule must place ingestSeq "9" inside a [2, 10] window.
    rows = [
        Row(0, f"{EPOCH}-000000", 0, 0, "9", "x", False, "incident:inc-1"),
        Row(1, f"{EPOCH}-000000", 0, 1, "11", "y"),
    ]
    window = incident_window(1)
    window["window"]["fromIngestSeq"] = "2"
    window["window"]["toIngestSeq"] = "10"
    manifest_path = build_dataset(tmp_path, rows=rows, incident_windows=[window])
    report = validate_dataset(manifest_path)
    assert report.ok, [f.message for f in report.findings]


def test_false_exclusion_provenance_is_an_error(tmp_path: Path) -> None:
    # Reviewer probe (M2): an in-window row mislabeled duplicate:0 (row 0 is
    # neither the same key nor byte-identical) plus an out-of-window row
    # labeled incident:inc-1. Both previously validated with ok=True.
    seg = f"{EPOCH}-000000"
    rows = [
        Row(0, seg, 0, 0, "1", "a"),
        Row(1, seg, 0, 1, "2", "b", replay_eligible=False, exclusion_reason="duplicate:0"),
        Row(2, seg, 0, 2, "9", "c", replay_eligible=False, exclusion_reason="incident:inc-1"),
    ]
    manifest_path = build_dataset(tmp_path, rows=rows, incident_windows=[incident_window(1)])
    report = validate_dataset(manifest_path)
    assert not report.ok
    assert "duplicate-provenance" in checks(report)
    assert "incident-exclusion-range" in checks(report)


def test_a_duplicate_mark_must_point_at_a_byte_identical_copy(tmp_path: Path) -> None:
    # Same key, same segment, but the mark points at an earlier row of a
    # DIFFERENT key: the claimed first copy must share (gatewayEpoch,
    # ingestSeq) and frameLineSha256.
    seg = f"{EPOCH}-000000"
    rows = [
        Row(0, seg, 0, 0, "1", "a"),
        Row(1, seg, 0, 1, "2", "b"),
        Row(2, seg, 0, 2, "2", "b", replay_eligible=False, exclusion_reason="duplicate:0"),
    ]
    manifest_path = build_dataset(tmp_path, rows=rows, incident_windows=[])
    report = validate_dataset(manifest_path)
    assert not report.ok
    assert "duplicate-provenance" in checks(report)


def test_a_forged_duplicate_of_a_different_payload_is_detected(tmp_path: Path) -> None:
    # Reviewer probe (round 2, M-A), verbatim: row 0 (ingestSeq 7, payload
    # "first payload") and row 1 (same key, payload "DIFFERENT payload",
    # marked duplicate:0), BOTH carrying the same claimed frameLineSha256.
    # The pre-remediation validator compared the two STORED strings and
    # returned {'ok': True, 'findings': []} — a genuine frame silently
    # excluded from replay. The digests must be recomputed from the archived
    # columns, and provenance decided on the verified bytes.
    seg = f"{EPOCH}-000000"
    first = Row(0, seg, 0, 0, "7", "first payload")
    forged_digest = hashlib.sha256(frame_line(first)).hexdigest()
    rows = [
        first,
        Row(
            1,
            seg,
            0,
            1,
            "7",
            "DIFFERENT payload",
            replay_eligible=False,
            exclusion_reason="duplicate:0",
            frame_line_sha256=forged_digest,
        ),
    ]
    manifest_path = build_dataset(tmp_path, rows=rows, incident_windows=[])
    report = validate_dataset(manifest_path)
    assert not report.ok
    # The stamped digest does not match row 1's reconstructed bytes...
    assert "frame-line-digest" in checks(report)
    # ...and the verified bytes of the two rows differ, so the mark is false.
    assert "duplicate-provenance" in checks(report)


def test_a_tampered_frame_line_digest_is_detected_on_any_row(tmp_path: Path) -> None:
    # The digest-mismatch finding class is general row integrity, not only
    # duplicate provenance: a stored frameLineSha256 that the reconstructed
    # line does not hash to is an error wherever it appears.
    rows = default_rows()
    rows[0] = Row(
        0,
        rows[0].segment_id,
        0,
        0,
        "1",
        '{"event_type":"book"}',
        frame_line_sha256="0" * 64,
    )
    manifest_path = build_dataset(tmp_path, rows=rows)
    report = validate_dataset(manifest_path)
    assert not report.ok
    assert "frame-line-digest" in checks(report)


def test_incident_excluded_segment_ids_must_reconcile(tmp_path: Path) -> None:
    # The window pins excludedSegmentIds; rows carrying its label from another
    # segment falsify the pin.
    seg_a = f"{EPOCH}-000000"
    seg_b = f"{EPOCH}-000001"
    rows = [
        Row(0, seg_a, 0, 0, "1", "a"),
        Row(1, seg_b, 1, 0, "2", "b", replay_eligible=False, exclusion_reason="incident:inc-1"),
    ]
    # incident_window() pins excludedSegmentIds = [seg_a]; the labeled row is
    # in seg_b.
    manifest_path = build_dataset(tmp_path, rows=rows, incident_windows=[incident_window(1)])
    report = validate_dataset(manifest_path)
    assert not report.ok
    assert "incident-exclusion-segments" in checks(report)


def test_non_canonical_ingest_seq_is_a_finding_not_a_crash(tmp_path: Path) -> None:
    rows = default_rows()
    rows[4] = Row(4, rows[4].segment_id, 1, 2, "007", '{"price":"1.0"}')
    manifest_path = build_dataset(tmp_path, rows=rows)
    report = validate_dataset(manifest_path)
    assert not report.ok
    assert "ingest-seq-grammar" in checks(report)


def test_an_ineligible_row_with_no_reason_is_an_error(tmp_path: Path) -> None:
    rows = default_rows()
    rows[4] = Row(4, rows[4].segment_id, 1, 2, "5", '{"price":"1.0"}', replay_eligible=False)
    manifest_path = build_dataset(tmp_path, rows=rows)
    report = validate_dataset(manifest_path)
    assert not report.ok
    assert "exclusion-reason-shape" in checks(report)


def test_a_broken_payload_digest_is_an_error(tmp_path: Path) -> None:
    rows = default_rows()
    rows[0] = Row(
        0,
        rows[0].segment_id,
        0,
        0,
        "1",
        '{"event_type":"book"}',
        payload_sha256=hashlib.sha256(b"something else").hexdigest(),
    )
    manifest_path = build_dataset(tmp_path, rows=rows)
    report = validate_dataset(manifest_path)
    assert not report.ok
    assert "payload-digest" in checks(report)


def test_an_unpinned_segment_in_the_data_is_an_error(tmp_path: Path) -> None:
    manifest_path = build_dataset(tmp_path)
    rewrite_manifest(manifest_path, lambda doc: doc["segments"].pop())
    report = validate_dataset(manifest_path)
    assert not report.ok
    assert "segment-pinned" in checks(report)


def test_a_wrong_segment_record_count_is_an_error(tmp_path: Path) -> None:
    manifest_path = build_dataset(tmp_path)
    rewrite_manifest(manifest_path, lambda doc: doc["segments"][0].update({"recordCount": 42}))
    report = validate_dataset(manifest_path)
    assert not report.ok
    assert "segment-row-count" in checks(report)


def test_an_excluded_segment_must_not_contribute_rows(tmp_path: Path) -> None:
    manifest_path = build_dataset(tmp_path)
    manifest = load_manifest(manifest_path)
    victim = manifest.segments[0].segment_id
    rewrite_manifest(
        manifest_path,
        lambda doc: doc["excludedSegments"].append({"segmentId": victim, "issues": []}),
    )
    report = validate_dataset(manifest_path)
    assert not report.ok
    assert "excluded-segment-absent" in checks(report)


def test_a_deleted_segment_with_no_object_is_an_error(tmp_path: Path) -> None:
    # ADR-004 §5's guarantee, checked from the outside: a WAL segment may be
    # gone only because a verified object holds its records. Deletions are
    # read from the retention receipt, not from the manifest.
    manifest_path = build_dataset(tmp_path, retention_policy="delete-after-verified-upload")
    manifest = load_manifest(manifest_path)
    (tmp_path / manifest.segments[0].object_key).unlink()
    report = validate_dataset(manifest_path)
    assert not report.ok
    assert "deleted-segment-object" in checks(report)


def test_a_valid_retention_receipt_validates(tmp_path: Path) -> None:
    manifest_path = build_dataset(tmp_path, retention_policy="delete-after-verified-upload")
    report = validate_dataset(manifest_path)
    assert report.ok, [f.message for f in report.findings]


def test_a_receipt_pinning_a_stale_manifest_digest_is_an_error(tmp_path: Path) -> None:
    # The receipt states which manifest's verification licensed the deletions;
    # a manifest that changed afterwards falsifies that statement.
    manifest_path = build_dataset(tmp_path, retention_policy="delete-after-verified-upload")
    rewrite_manifest(manifest_path, lambda doc: doc.update({"createdAt": "2027-01-01T00:00:00Z"}))
    report = validate_dataset(manifest_path)
    assert not report.ok
    assert "retention-receipt" in checks(report)


def test_a_receipt_claiming_an_unpinned_segment_is_an_error(tmp_path: Path) -> None:
    manifest_path = build_dataset(tmp_path, retention_policy="delete-after-verified-upload")
    receipt_path = manifest_path.parent / "retention-receipt.json"
    document = json.loads(receipt_path.read_text(encoding="utf-8"))
    document["deletedSegments"].append(
        {
            "segmentId": "not-a-pinned-segment",
            "verifiedObjectKey": "nowhere.parquet",
            "verifiedObjectSha256": "0" * 64,
        }
    )
    receipt_path.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
    report = validate_dataset(manifest_path)
    assert not report.ok
    assert "retention-receipt" in checks(report)


def test_a_missing_receipt_under_a_deleting_policy_is_a_warning(tmp_path: Path) -> None:
    manifest_path = build_dataset(tmp_path, retention_policy="delete-after-verified-upload")
    (manifest_path.parent / "retention-receipt.json").unlink()
    report = validate_dataset(manifest_path)
    # A warning, not an error: deletions may simply not have happened yet.
    assert report.ok
    assert "retention-receipt-absent" in {f.check for f in report.findings}


def test_a_changed_column_layout_is_an_error(tmp_path: Path) -> None:
    manifest_path = build_dataset(tmp_path)
    rewrite_manifest(
        manifest_path,
        lambda doc: doc["columns"].__setitem__(
            5, {"name": "ingestSeq", "physicalType": "INT64", "nullable": False}
        ),
    )
    report = validate_dataset(manifest_path)
    assert not report.ok
    assert "layout-columns" in checks(report)


def test_an_unknown_layout_id_is_refused_rather_than_guessed(tmp_path: Path) -> None:
    manifest_path = build_dataset(tmp_path)
    rewrite_manifest(
        manifest_path,
        lambda doc: doc["schemaVersions"].update({"parquetLayoutId": "someone-else/v9"}),
    )
    report = validate_dataset(manifest_path)
    assert not report.ok
    assert "layout-id" in checks(report)


def test_a_future_layout_version_is_refused(tmp_path: Path) -> None:
    manifest_path = build_dataset(tmp_path)
    rewrite_manifest(
        manifest_path, lambda doc: doc["schemaVersions"].update({"parquetLayoutVersion": 2})
    )
    report = validate_dataset(manifest_path)
    assert not report.ok
    assert "layout-version" in checks(report)


def test_an_unknown_pinned_column_type_is_a_finding_not_a_crash(tmp_path: Path) -> None:
    # Reviewer probe (round 2, M-B, 1): physicalType "BOGUS" previously
    # escaped as KeyError('BOGUS') from the dictionary lookup, including
    # through main() — contradicting the findings-not-raises contract.
    manifest_path = build_dataset(tmp_path)
    rewrite_manifest(
        manifest_path,
        lambda doc: doc["columns"][0].update({"physicalType": "BOGUS"}),
    )
    report = validate_dataset(manifest_path)  # must not raise
    assert not report.ok
    assert "layout-column-type" in checks(report)


def test_an_unknown_pinned_column_type_fails_the_cli_cleanly(tmp_path: Path, capsys) -> None:
    manifest_path = build_dataset(tmp_path)
    rewrite_manifest(
        manifest_path,
        lambda doc: doc["columns"][0].update({"physicalType": "BOGUS"}),
    )
    assert main(["--manifest", str(manifest_path)]) == 1  # must not raise
    assert "layout-column-type" in capsys.readouterr().out


def _pin_non_parquet_bytes(tmp_path: Path) -> Path:
    """A manifest and checksum consistently pinning arbitrary NON-Parquet bytes."""
    manifest_path = build_dataset(tmp_path)
    document = json.loads(manifest_path.read_text(encoding="utf-8"))
    victim_key = document["objects"][0]["objectKey"]
    junk = b"these are not parquet bytes at all"
    (tmp_path / victim_key).write_bytes(junk)
    document["objects"][0]["byteLength"] = len(junk)
    document["objects"][0]["sha256"] = hashlib.sha256(junk).hexdigest()
    manifest_path.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
    return manifest_path


def test_consistently_pinned_non_parquet_bytes_are_a_finding_not_a_crash(
    tmp_path: Path,
) -> None:
    # Reviewer probe (round 2, M-B, 2): presence, length, and checksum all
    # pass — a manifest and its sidecar can pin ANY bytes — and the
    # pre-remediation validator escaped with DuckDB's InvalidInputException
    # ("No magic bytes found at end of file"), including through main().
    manifest_path = _pin_non_parquet_bytes(tmp_path)
    report = validate_dataset(manifest_path)  # must not raise
    assert not report.ok
    assert "object-parquet" in checks(report)
    finding = next(f for f in report.findings if f.check == "object-parquet")
    assert finding.details["objectKey"]  # the finding names the object


def test_non_parquet_bytes_fail_the_cli_cleanly(tmp_path: Path, capsys) -> None:
    manifest_path = _pin_non_parquet_bytes(tmp_path)
    assert main(["--manifest", str(manifest_path)]) == 1  # must not raise
    assert "object-parquet" in capsys.readouterr().out


def test_a_receipt_with_falsified_object_provenance_is_an_error(tmp_path: Path) -> None:
    # Reviewer probe (round 2, L-1): each receipt deletion entry states which
    # verified object licensed it; falsifying BOTH fields on a pinned segment
    # previously validated with ok=True. Reporting, not proof — but a report
    # that contradicts the manifest it pins is a broken report.
    manifest_path = build_dataset(tmp_path, retention_policy="delete-after-verified-upload")
    receipt_path = manifest_path.parent / "retention-receipt.json"
    document = json.loads(receipt_path.read_text(encoding="utf-8"))
    document["deletedSegments"][0]["verifiedObjectKey"] = "somewhere/else.parquet"
    document["deletedSegments"][0]["verifiedObjectSha256"] = "f" * 64
    receipt_path.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
    report = validate_dataset(manifest_path)
    assert not report.ok
    assert "retention-receipt" in checks(report)


def test_a_receipt_with_a_falsified_object_digest_alone_is_an_error(tmp_path: Path) -> None:
    manifest_path = build_dataset(tmp_path, retention_policy="delete-after-verified-upload")
    receipt_path = manifest_path.parent / "retention-receipt.json"
    document = json.loads(receipt_path.read_text(encoding="utf-8"))
    document["deletedSegments"][0]["verifiedObjectSha256"] = "f" * 64
    receipt_path.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
    report = validate_dataset(manifest_path)
    assert not report.ok
    assert "retention-receipt" in checks(report)


def _make_object_unreadable(tmp_path: Path) -> tuple[Path, Path]:
    """Build a dataset and chmod 000 its first pinned object."""
    manifest_path = build_dataset(tmp_path)
    manifest = load_manifest(manifest_path)
    victim = tmp_path / manifest.objects[0].object_key
    victim.chmod(0)
    return manifest_path, victim


def test_an_unreadable_pinned_object_is_a_finding_not_a_crash(tmp_path: Path) -> None:
    # Reviewer probe (round 3, M-1), direct API: chmod 000 a pinned object.
    # The pre-remediation validator hashed objects before any guard layer and
    # escaped with a raw PermissionError — through validate_dataset() and
    # main() alike — contradicting the findings-not-raises contract.
    require_read_denial(tmp_path)
    manifest_path, victim = _make_object_unreadable(tmp_path)
    try:
        report = validate_dataset(manifest_path)  # must not raise
    finally:
        victim.chmod(0o600)
    assert not report.ok
    finding = next(f for f in report.findings if f.check == "object-read")
    # The finding names the object and the errno, per the required contract.
    assert finding.details["objectKey"] == load_manifest(manifest_path).objects[0].object_key
    assert finding.details["errno"] == errno_module.EACCES
    # The unreadable object is excluded from the DuckDB checks: no misleading
    # object-parquet finding, and no arithmetic noise burying the real story.
    assert "object-parquet" not in checks(report)
    assert {f.check for f in report.errors} == {"object-read"}


def test_an_unreadable_pinned_object_fails_the_cli_cleanly(tmp_path: Path, capsys) -> None:
    # The same probe through the CLI: `uv run python -m research.compaction
    # --manifest …` previously exited 1 with a full PermissionError traceback.
    require_read_denial(tmp_path)
    manifest_path, victim = _make_object_unreadable(tmp_path)
    try:
        assert main(["--manifest", str(manifest_path)]) == 1  # must not raise
    finally:
        victim.chmod(0o600)
    assert "object-read" in capsys.readouterr().out


def test_an_unreadable_manifest_is_a_manifest_error(tmp_path: Path, capsys) -> None:
    # Sibling sweep (round 3, M-1): a manifest file the process cannot read
    # cannot even name the dataset — the documented ManifestError refusal
    # (typed raise at the API, exit 2 at the CLI), never a traceback.
    require_read_denial(tmp_path)
    manifest_path = build_dataset(tmp_path)
    manifest_path.chmod(0)
    try:
        with pytest.raises(ManifestError, match="could not be read"):
            validate_dataset(manifest_path)
        assert main(["--manifest", str(manifest_path)]) == 2
    finally:
        manifest_path.chmod(0o600)
    assert "manifest error" in capsys.readouterr().err


def test_an_unreadable_dataset_directory_is_a_manifest_error(tmp_path: Path, capsys) -> None:
    # Sibling sweep (round 3, M-1): an unreadable dataset directory makes the
    # manifest unreadable, which is the same documented refusal.
    require_read_denial(tmp_path)
    manifest_path = build_dataset(tmp_path)
    dataset_dir = manifest_path.parent
    dataset_dir.chmod(0)
    try:
        with pytest.raises(ManifestError, match="could not be read"):
            validate_dataset(manifest_path)
        assert main(["--manifest", str(manifest_path)]) == 2
    finally:
        dataset_dir.chmod(0o700)
    assert "manifest error" in capsys.readouterr().err


def test_an_unreadable_retention_receipt_is_a_finding(tmp_path: Path, capsys) -> None:
    # Sibling sweep (round 3, M-1): past a parseable manifest, everything is
    # findings — including a receipt the process cannot open.
    require_read_denial(tmp_path)
    manifest_path = build_dataset(tmp_path, retention_policy="delete-after-verified-upload")
    receipt_path = manifest_path.parent / "retention-receipt.json"
    receipt_path.chmod(0)
    try:
        report = validate_dataset(manifest_path)  # must not raise
        assert not report.ok
        assert "retention-receipt" in checks(report)
        assert main(["--manifest", str(manifest_path)]) == 1
    finally:
        receipt_path.chmod(0o600)
    assert "retention-receipt" in capsys.readouterr().out


def test_an_unreadable_manifest_digest_sidecar_is_a_finding(tmp_path: Path, capsys) -> None:
    # Reviewer probe (round 3, M-2): an unreadable manifest.sha256 previously
    # returned ok=True because the validator never opened the sidecar at all.
    require_read_denial(tmp_path)
    manifest_path = build_dataset(tmp_path)
    sidecar = manifest_path.parent / "manifest.sha256"
    sidecar.chmod(0)
    try:
        report = validate_dataset(manifest_path)  # must not raise
        assert not report.ok
        assert "manifest-digest-unreadable" in checks(report)
        assert main(["--manifest", str(manifest_path)]) == 1
    finally:
        sidecar.chmod(0o600)
    assert "manifest-digest-unreadable" in capsys.readouterr().out


def test_an_unexpected_exception_is_a_structured_cli_error(
    tmp_path: Path, capsys, monkeypatch
) -> None:
    # Round-3 M-1's defensive boundary: an exception NO specific finding class
    # anticipated must leave the CLI as one structured line and exit code 3 —
    # never a traceback. Injected by patching validate_dataset itself, since
    # every known failure class now has a specific finding and cannot be used
    # to reach this path.
    import research.compaction.validate as validate_module

    def explode(*args, **kwargs):
        raise RuntimeError("wired to fail")

    monkeypatch.setattr(validate_module, "validate_dataset", explode)
    manifest_path = build_dataset(tmp_path)
    assert validate_module.main(["--manifest", str(manifest_path)]) == 3  # must not raise
    err = capsys.readouterr().err
    assert "unexpected error (RuntimeError): wired to fail" in err
    assert "Traceback" not in err


def test_a_forged_segment_file_digest_is_a_finding(tmp_path: Path) -> None:
    # Reviewer probe (round 3, M-2), verbatim: segmentFileSha256 forged to
    # "xyz" previously returned ok=True — the Python side silently ignored the
    # round-2 whole-file pin. A pin no SHA-256 can ever equal licenses
    # nothing; grammar (64 lowercase hex) is a finding. The VALUE is not
    # re-verifiable store-side (the WAL file is deleted post-retention) and is
    # carried, per the documented boundary.
    manifest_path = build_dataset(tmp_path)
    rewrite_manifest(
        manifest_path,
        lambda doc: doc["segments"][0].update({"segmentFileSha256": "xyz"}),
    )
    report = validate_dataset(manifest_path)
    assert not report.ok
    assert "segment-file-digest-grammar" in checks(report)
    finding = next(f for f in report.findings if f.check == "segment-file-digest-grammar")
    assert finding.details["segmentId"]  # the finding names the segment


@pytest.mark.parametrize(
    "forged",
    [
        pytest.param("A" * 64, id="uppercase-hex"),
        pytest.param("0" * 63, id="too-short"),
        pytest.param("0" * 64 + "0", id="too-long"),
        pytest.param("", id="empty"),
    ],
)
def test_every_malformed_segment_file_digest_grammar_is_a_finding(
    tmp_path: Path, forged: str
) -> None:
    manifest_path = build_dataset(tmp_path)
    rewrite_manifest(
        manifest_path,
        lambda doc: doc["segments"][0].update({"segmentFileSha256": forged}),
    )
    report = validate_dataset(manifest_path)
    assert not report.ok
    assert "segment-file-digest-grammar" in checks(report)


def test_a_forged_segment_file_digest_fails_the_cli_cleanly(tmp_path: Path, capsys) -> None:
    manifest_path = build_dataset(tmp_path)
    rewrite_manifest(
        manifest_path,
        lambda doc: doc["segments"][0].update({"segmentFileSha256": "xyz"}),
    )
    assert main(["--manifest", str(manifest_path)]) == 1
    assert "segment-file-digest-grammar" in capsys.readouterr().out


def test_a_missing_segment_file_digest_is_refused(tmp_path: Path, capsys) -> None:
    # Reviewer probe (round 3, M-2), verbatim: a manifest with the field
    # removed previously returned ok=True. It is now REQUIRED by the parser —
    # a missing pin is a shape this build cannot read, the same ManifestError
    # contract as every other required field (typed raise / exit 2).
    manifest_path = build_dataset(tmp_path)
    rewrite_manifest(
        manifest_path,
        lambda doc: doc["segments"][0].pop("segmentFileSha256"),
    )
    with pytest.raises(ManifestError, match="segmentFileSha256"):
        validate_dataset(manifest_path)
    assert main(["--manifest", str(manifest_path)]) == 2
    assert "manifest error" in capsys.readouterr().err


def test_a_non_string_segment_file_digest_is_refused(tmp_path: Path) -> None:
    manifest_path = build_dataset(tmp_path)
    rewrite_manifest(
        manifest_path,
        lambda doc: doc["segments"][0].update({"segmentFileSha256": 5}),
    )
    with pytest.raises(ManifestError, match="expected a string"):
        validate_dataset(manifest_path)


def test_an_absent_manifest_digest_sidecar_is_a_finding(tmp_path: Path, capsys) -> None:
    # Round 3, M-2: the compactor writes and read-back-verifies the sidecar
    # before any deletion, so a dataset without one is broken, not new.
    manifest_path = build_dataset(tmp_path)
    (manifest_path.parent / "manifest.sha256").unlink()
    report = validate_dataset(manifest_path)
    assert not report.ok
    assert "manifest-digest-absent" in checks(report)
    assert main(["--manifest", str(manifest_path)]) == 1
    assert "manifest-digest-absent" in capsys.readouterr().out


def test_a_malformed_manifest_digest_sidecar_is_a_finding(tmp_path: Path, capsys) -> None:
    manifest_path = build_dataset(tmp_path)
    (manifest_path.parent / "manifest.sha256").write_text(
        "not a digest at all\n", encoding="utf-8"
    )
    report = validate_dataset(manifest_path)
    assert not report.ok
    assert "manifest-digest-malformed" in checks(report)
    assert main(["--manifest", str(manifest_path)]) == 1
    assert "manifest-digest-malformed" in capsys.readouterr().out


def test_a_contradicting_manifest_digest_sidecar_is_a_finding(tmp_path: Path, capsys) -> None:
    # Reviewer probe (round 3, M-2), verbatim: a well-formed sidecar of 64
    # zeroes contradicting the manifest bytes previously returned ok=True.
    manifest_path = build_dataset(tmp_path)
    (manifest_path.parent / "manifest.sha256").write_text("0" * 64 + "\n", encoding="utf-8")
    report = validate_dataset(manifest_path)
    assert not report.ok
    assert "manifest-digest-mismatch" in checks(report)
    finding = next(f for f in report.findings if f.check == "manifest-digest-mismatch")
    assert finding.details["pinned"] == "0" * 64
    assert main(["--manifest", str(manifest_path)]) == 1
    assert "manifest-digest-mismatch" in capsys.readouterr().out


def test_an_empty_dataset_validates(tmp_path: Path) -> None:
    manifest_path = build_dataset(tmp_path, rows=[], incident_windows=[])
    report = validate_dataset(manifest_path)
    assert report.ok, [f.message for f in report.findings]
    assert report.rows_checked == 0


class TestManifestParsing:
    def test_an_unknown_format_is_refused(self) -> None:
        with pytest.raises(ManifestError, match="unknown dataset manifest format"):
            parse_manifest({"datasetManifestFormatId": "other/v1", "datasetManifestVersion": 1})

    def test_a_future_version_is_refused(self) -> None:
        with pytest.raises(ManifestError, match="not readable by this build"):
            parse_manifest(
                {
                    "datasetManifestFormatId": "polymarket-bot/dataset-manifest/v1",
                    "datasetManifestVersion": 99,
                }
            )

    def test_a_missing_field_is_refused(self) -> None:
        with pytest.raises(ManifestError, match="missing required field"):
            parse_manifest(
                {
                    "datasetManifestFormatId": "polymarket-bot/dataset-manifest/v1",
                    "datasetManifestVersion": 1,
                }
            )

    def test_a_missing_file_is_refused(self, tmp_path: Path) -> None:
        with pytest.raises(ManifestError, match="could not be read"):
            load_manifest(tmp_path / "absent.json")

    def test_invalid_json_is_refused(self, tmp_path: Path) -> None:
        path = tmp_path / "manifest.json"
        path.write_text("{ not json", encoding="utf-8")
        with pytest.raises(ManifestError, match="not valid JSON"):
            load_manifest(path)

    def test_a_traversing_object_key_is_refused(self, tmp_path: Path) -> None:
        manifest_path = build_dataset(tmp_path)
        rewrite_manifest(
            manifest_path,
            lambda doc: doc["objects"][0].update({"objectKey": "../../etc/passwd"}),
        )
        with pytest.raises(ManifestError, match="store-relative"):
            validate_dataset(manifest_path)

    @pytest.mark.parametrize(
        ("label", "mutate"),
        [
            ("segments is not a list", lambda doc: doc.update({"segments": {}})),
            ("a segment entry is a string", lambda doc: doc["segments"].__setitem__(0, "x")),
            (
                "a count is a string",
                lambda doc: doc["recordCounts"].update({"written": "5"}),
            ),
            (
                "a count is a boolean",
                lambda doc: doc["recordCounts"].update({"written": True}),
            ),
            ("recordCounts is missing", lambda doc: doc.pop("recordCounts")),
            ("a column has no name", lambda doc: doc["columns"][0].pop("name")),
            (
                "an object rowCount is a string",
                lambda doc: doc["objects"][0].update({"rowCount": "many"}),
            ),
            (
                "an incident entry is a list",
                lambda doc: doc.update({"excludedIncidentWindows": [[]]}),
            ),
            (
                "schemaVersions is a string",
                lambda doc: doc.update({"schemaVersions": "v1"}),
            ),
        ],
    )
    def test_every_malformed_shape_is_a_manifest_error_not_a_traceback(
        self, tmp_path: Path, label: str, mutate
    ) -> None:
        # Round-2 M-B sweep: the manifest parser must refuse every
        # malformed-input shape with the typed ManifestError — never a
        # KeyError, TypeError, or AttributeError that escapes main() as a
        # traceback. (ManifestError is the one documented refusal: a manifest
        # this broken cannot even name the dataset being described.)
        manifest_path = build_dataset(tmp_path)
        rewrite_manifest(manifest_path, mutate)
        with pytest.raises(ManifestError):
            validate_dataset(manifest_path)

    def test_a_malformed_shape_exits_two_at_the_cli(self, tmp_path: Path, capsys) -> None:
        manifest_path = build_dataset(tmp_path)
        rewrite_manifest(
            manifest_path, lambda doc: doc["recordCounts"].update({"written": "5"})
        )
        assert main(["--manifest", str(manifest_path)]) == 2  # structured, no traceback
        assert "manifest error" in capsys.readouterr().err


# ---------------------------------------------------------------------------
# Round-4 remediation: nullability pins (M-A), path-hostile keys and
# encoding-safe rendering (M-B), object-state classification (L-A).
# ---------------------------------------------------------------------------

#: The committed fixture, written by the real TypeScript compactor: eighteen
#: REQUIRED columns and one OPTIONAL (`exclusionReason`) — the ground truth
#: for the REQUIRED direction of the nullability reconciliation, which the
#: DuckDB-writing synthetic builder cannot produce (it emits every column
#: OPTIONAL, NOT NULL constraints notwithstanding).
FIXTURE_MANIFEST = (
    Path(__file__).resolve().parent.parent
    / "testdata"
    / "datasets"
    / "ds-fixture"
    / "manifest.json"
)

#: The directory `python -m research.compaction` resolves from.
PYTHON_ROOT = Path(__file__).resolve().parents[3]

requires_fixture = pytest.mark.skipif(
    not FIXTURE_MANIFEST.is_file(),
    reason=(
        "committed fixture is absent; regenerate it with "
        "`pnpm --filter @polymarket-bot/research-worker fixture:python`"
    ),
)


def copy_fixture(tmp_path: Path) -> Path:
    """A mutable copy of the committed fixture; returns its manifest path."""
    target = tmp_path / "datasets" / "ds-fixture"
    shutil.copytree(FIXTURE_MANIFEST.parent, target)
    return target / "manifest.json"


def run_real_cli(manifest_path: Path) -> subprocess.CompletedProcess[str]:
    """The genuine subprocess CLI, not a StringIO capture.

    Round-4 M-B only reproduced through a real process: a StringIO capture
    never encodes, so an output-encoding detonation is invisible to `main()`
    tests. `PYTHONIOENCODING=utf-8` pins the strict-UTF-8 stream the reviewer
    hit, so this test means the same thing on any machine.
    """
    return subprocess.run(  # noqa: S603 - fixed argv, our own module
        [sys.executable, "-m", "research.compaction", "--manifest", str(manifest_path)],
        capture_output=True,
        text=True,
        errors="backslashreplace",
        cwd=PYTHON_ROOT,
        env={**os.environ, "PYTHONIOENCODING": "utf-8"},
        timeout=120,
    )


@requires_fixture
def test_a_nullability_pin_of_true_over_a_required_column_is_a_finding(
    tmp_path: Path,
) -> None:
    # Reviewer probe (round 4, M-A), the flip direction the real compactor's
    # output can witness: the fixture pins segmentId nullable:false and its
    # objects declare the column REQUIRED; a manifest claiming nullable:true
    # (refreshed sidecar and all) previously validated ok=True because only
    # name and physical type were compared.
    manifest_path = copy_fixture(tmp_path)
    rewrite_manifest(
        manifest_path,
        lambda doc: doc["columns"][1].update({"nullable": True}),
    )
    report = validate_dataset(manifest_path)
    assert not report.ok
    finding = next(f for f in report.findings if f.check == "layout-column-nullability")
    assert finding.details["objectKey"]
    [mismatch] = finding.details["mismatches"]
    assert mismatch["column"] == "segmentId"
    assert mismatch["pinnedNullable"] is True
    assert mismatch["observedRepetition"] == "REQUIRED"


@requires_fixture
def test_a_nullability_pin_of_false_over_an_optional_column_is_a_finding(
    tmp_path: Path,
) -> None:
    # The other direction, on the same real-writer object: exclusionReason is
    # genuinely OPTIONAL, and a pin of false must not validate over it.
    manifest_path = copy_fixture(tmp_path)
    rewrite_manifest(
        manifest_path,
        lambda doc: doc["columns"][18].update({"nullable": False}),
    )
    report = validate_dataset(manifest_path)
    assert not report.ok
    finding = next(f for f in report.findings if f.check == "layout-column-nullability")
    [mismatch] = finding.details["mismatches"]
    assert mismatch["column"] == "exclusionReason"
    assert mismatch["pinnedNullable"] is False
    assert mismatch["observedRepetition"] == "OPTIONAL"


def test_a_nullability_pin_of_false_over_a_duckdb_written_object_is_a_finding(
    tmp_path: Path,
) -> None:
    # The synthetic builder's objects are OPTIONAL throughout (DuckDB's
    # writer), so its manifests honestly pin nullable:true; forging false must
    # be caught without the committed fixture in the loop.
    manifest_path = build_dataset(tmp_path)
    rewrite_manifest(
        manifest_path,
        lambda doc: doc["columns"][1].update({"nullable": False}),
    )
    report = validate_dataset(manifest_path)
    assert not report.ok
    assert "layout-column-nullability" in checks(report)


def test_a_nullability_flip_fails_the_cli_cleanly(tmp_path: Path, capsys) -> None:
    manifest_path = build_dataset(tmp_path)
    rewrite_manifest(
        manifest_path,
        lambda doc: doc["columns"][1].update({"nullable": False}),
    )
    assert main(["--manifest", str(manifest_path)]) == 1
    assert "layout-column-nullability" in capsys.readouterr().out


@pytest.mark.parametrize(
    "forged",
    [
        pytest.param("false", id="string-false"),
        pytest.param({"bizarre": True}, id="bizarre-object"),
        pytest.param(1, id="integer-one"),
        pytest.param(None, id="null"),
    ],
)
def test_a_non_boolean_nullable_pin_is_refused(tmp_path: Path, forged) -> None:
    # Reviewer probes (round 4, M-A): nullable "false" (string) and
    # {"bizarre": true} previously validated green through bool(...) coercion.
    # The parser's contract is shape (the round-3 segmentFileSha256 choice):
    # a non-boolean is a ManifestError, never a truthiness guess.
    manifest_path = build_dataset(tmp_path)
    rewrite_manifest(
        manifest_path,
        lambda doc: doc["columns"][1].update({"nullable": forged}),
    )
    with pytest.raises(ManifestError, match="expected a boolean"):
        validate_dataset(manifest_path)


def test_a_non_boolean_nullable_pin_exits_two_at_the_cli(tmp_path: Path, capsys) -> None:
    manifest_path = build_dataset(tmp_path)
    rewrite_manifest(
        manifest_path,
        lambda doc: doc["columns"][1].update({"nullable": "false"}),
    )
    assert main(["--manifest", str(manifest_path)]) == 2
    assert "manifest error" in capsys.readouterr().err


def test_a_surrogate_object_key_is_refused(tmp_path: Path, capsys) -> None:
    # Reviewer probe (round 4, M-B): an object key parsed from an escaped
    # unpaired surrogate ("\ud800" in the manifest JSON) previously became an
    # object-present finding and then detonated the real CLI's output encoder
    # (exit 3, UnicodeEncodeError). Such a key cannot be encoded to UTF-8, so
    # no store — and no TypeScript writer — can ever hold the object it
    # names: it is a manifest shape, refused as ManifestError.
    manifest_path = build_dataset(tmp_path)
    rewrite_manifest(
        manifest_path,
        lambda doc: doc["objects"][0].update({"objectKey": "datasets/ds-test/\ud800.parquet"}),
    )
    with pytest.raises(ManifestError, match="unpaired surrogate"):
        validate_dataset(manifest_path)
    assert main(["--manifest", str(manifest_path)]) == 2
    assert "manifest error" in capsys.readouterr().err


def test_a_surrogate_object_key_exits_two_through_the_real_cli(tmp_path: Path) -> None:
    # The probe's own reproduction path, pinned: StringIO capture showed exit
    # 1 while the real subprocess died with exit 3 — so this asserts through
    # a genuine subprocess, where the output encoder actually runs.
    manifest_path = build_dataset(tmp_path)
    rewrite_manifest(
        manifest_path,
        lambda doc: doc["objects"][0].update({"objectKey": "datasets/ds-test/\ud800.parquet"}),
    )
    result = run_real_cli(manifest_path)
    assert result.returncode == 2, result.stderr
    assert "manifest error" in result.stderr
    assert "unexpected error" not in result.stderr


@pytest.mark.parametrize(
    ("label", "mutate"),
    [
        (
            "segmentId",
            lambda doc: doc["segments"][0].update({"segmentId": "seg-\ud800"}),
        ),
        (
            "gatewayEpoch",
            lambda doc: doc["segments"][0].update({"gatewayEpoch": "\ud800" + EPOCH[1:]}),
        ),
        (
            "incidentId",
            lambda doc: doc["excludedIncidentWindows"][0]["window"].update(
                {"incidentId": "inc-\udfff"}
            ),
        ),
        (
            "datasetId",
            lambda doc: doc.update({"datasetId": "ds-\ud800"}),
        ),
        (
            "incident reason",
            lambda doc: doc["excludedIncidentWindows"][0]["window"].update(
                {"reason": "gap \ud800 gap"}
            ),
        ),
    ],
)
def test_every_hostile_manifest_string_field_is_refused(
    tmp_path: Path, label: str, mutate
) -> None:
    # M-B sibling sweep: every string the manifest parser accepts flows into
    # finding messages, details, or paths, so the unpaired-surrogate refusal
    # holds for all of them, not only object keys.
    manifest_path = build_dataset(tmp_path)
    rewrite_manifest(manifest_path, mutate)
    with pytest.raises(ManifestError, match="unpaired surrogate"):
        validate_dataset(manifest_path)


def test_an_object_key_with_a_nul_byte_is_refused(tmp_path: Path) -> None:
    manifest_path = build_dataset(tmp_path)
    rewrite_manifest(
        manifest_path,
        lambda doc: doc["objects"][0].update({"objectKey": "datasets/ds\x00test/x.parquet"}),
    )
    with pytest.raises(ManifestError, match="NUL"):
        validate_dataset(manifest_path)


def test_a_hostile_receipt_field_renders_as_a_finding_through_the_real_cli(
    tmp_path: Path,
) -> None:
    # M-B half (b), pinned where it matters: the retention receipt is NOT
    # parsed by the manifest parser (malformed receipts are findings, not
    # refusals), so a hostile receipt field is content a finding must carry.
    # Rendering is encoding-safe (backslashreplace), so the real CLI reports
    # the specific finding at exit 1 — never the exit-3 backstop.
    manifest_path = build_dataset(tmp_path, retention_policy="delete-after-verified-upload")
    receipt_path = manifest_path.parent / "retention-receipt.json"
    document = json.loads(receipt_path.read_text(encoding="utf-8"))
    document["deletedSegments"][0]["segmentId"] = "seg-\ud800-hostile"
    receipt_path.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
    result = run_real_cli(manifest_path)
    assert result.returncode == 1, result.stderr
    assert "unexpected error" not in result.stderr
    assert "retention-receipt" in result.stdout
    # The hostile character is carried as its escape, not dropped.
    assert "\\ud800" in result.stdout


def test_render_safe_escapes_what_no_stream_can_encode() -> None:
    from research.compaction.validate import _render_safe

    assert _render_safe("plain ascii") == "plain ascii"
    assert _render_safe("x\ud800y") == "x\\ud800y"
    # Ordinary non-ASCII text is passed through untouched.
    assert _render_safe("emoji \U0001f600") == "emoji \U0001f600"


def _chmod_after_hash(validate_module, victim: Path):
    """A `_sha256_file` wrapper that drops the object's permissions post-hash."""
    real_sha = validate_module._sha256_file

    def wrapper(path: Path) -> str:
        digest = real_sha(path)
        if path == victim:
            path.chmod(0)
        return digest

    return wrapper


def test_an_object_unreadable_at_decode_time_is_object_read_not_object_parquet(
    tmp_path: Path, monkeypatch
) -> None:
    # Reviewer probe (round 4, L-A): chmod 000 AFTER check 1 hashed the object
    # but before the DuckDB decode. DuckDB reported "Permission denied" and
    # the pre-remediation validator classified it object-parquet — a decode
    # verdict about a file the OS never let it read. A permission failure is
    # object-read wherever it is observed.
    require_read_denial(tmp_path)
    import research.compaction.validate as validate_module

    manifest_path = build_dataset(tmp_path)
    victim = tmp_path / load_manifest(manifest_path).objects[0].object_key
    monkeypatch.setattr(
        validate_module, "_sha256_file", _chmod_after_hash(validate_module, victim)
    )
    try:
        report = validate_dataset(manifest_path)  # must not raise
    finally:
        victim.chmod(0o600)
    assert not report.ok
    assert "object-parquet" not in checks(report)
    finding = next(f for f in report.findings if f.check == "object-read")
    assert finding.details["errno"] == errno_module.EACCES
    # Degraded: the specific finding is the story, not partial-total noise.
    assert {f.check for f in report.errors} == {"object-read"}


def test_a_directory_at_a_pinned_object_path_is_a_distinct_finding(tmp_path: Path) -> None:
    # Reviewer probe (round 4, L-A): a directory at the pinned path was
    # reported as "missing" (object-present) and buried under SIX derivative
    # count/ordinal/incident findings, because non-file objects never entered
    # the degraded comparison.
    manifest_path = build_dataset(tmp_path)
    victim = tmp_path / load_manifest(manifest_path).objects[0].object_key
    victim.unlink()
    victim.mkdir()
    report = validate_dataset(manifest_path)
    assert not report.ok
    finding = next(f for f in report.findings if f.check == "object-not-a-file")
    assert finding.details["observed"] == "directory"
    # The derivative noise is suppressed; the classification is the story.
    assert {f.check for f in report.errors} == {"object-not-a-file"}


def test_a_dangling_symlink_at_a_pinned_object_path_is_a_distinct_finding(
    tmp_path: Path,
) -> None:
    manifest_path = build_dataset(tmp_path)
    victim = tmp_path / load_manifest(manifest_path).objects[0].object_key
    victim.unlink()
    victim.symlink_to(tmp_path / "nowhere")
    report = validate_dataset(manifest_path)
    assert not report.ok
    finding = next(f for f in report.findings if f.check == "object-not-a-file")
    assert finding.details["observed"] == "dangling-symlink"
    assert {f.check for f in report.errors} == {"object-not-a-file"}


def test_a_missing_object_suppresses_the_derivative_findings(tmp_path: Path) -> None:
    # L-A's third leg: a genuinely missing object keeps its object-present
    # class but must set the degraded state like every other unavailable
    # object — previously the totals ran against the partial dataset and
    # buried the finding under arithmetic noise.
    manifest_path = build_dataset(tmp_path)
    (tmp_path / load_manifest(manifest_path).objects[0].object_key).unlink()
    report = validate_dataset(manifest_path)
    assert not report.ok
    assert {f.check for f in report.errors} == {"object-present"}


class TestCli:
    def test_it_exits_zero_for_a_valid_dataset(self, tmp_path: Path, capsys) -> None:
        manifest_path = build_dataset(tmp_path)
        assert main(["--manifest", str(manifest_path)]) == 0
        assert "OK" in capsys.readouterr().out

    def test_it_exits_one_for_an_invalid_dataset(self, tmp_path: Path, capsys) -> None:
        manifest_path = build_dataset(tmp_path)
        rewrite_manifest(manifest_path, lambda doc: doc["recordCounts"].update({"written": 99}))
        assert main(["--manifest", str(manifest_path)]) == 1
        assert "error" in capsys.readouterr().out

    def test_it_exits_two_for_an_unreadable_manifest(self, tmp_path: Path, capsys) -> None:
        assert main(["--manifest", str(tmp_path / "absent.json")]) == 2
        assert "manifest error" in capsys.readouterr().err

    def test_json_output_is_machine_readable(self, tmp_path: Path, capsys) -> None:
        manifest_path = build_dataset(tmp_path)
        assert main(["--manifest", str(manifest_path), "--json"]) == 0
        payload = json.loads(capsys.readouterr().out)
        assert payload["ok"] is True
        assert payload["rowsChecked"] == 5
