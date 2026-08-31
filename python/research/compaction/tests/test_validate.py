"""The validator finds what it claims to find, and passes what it should pass."""

from __future__ import annotations

import hashlib
import json
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
    incident_window,
    rewrite_manifest,
)


def checks(report) -> set[str]:
    return {finding.check for finding in report.findings}


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
