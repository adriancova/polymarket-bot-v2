"""DuckDB reads what the TypeScript compactor writes.

The fixture under ``testdata/`` is produced by the **real** compactor
(``test/integration/parquet/python-fixture.test.ts``, regenerated with
``pnpm --filter @polymarket-bot/research-worker fixture:python``). Everything
else in this suite builds its Parquet with DuckDB, which can only demonstrate
that DuckDB agrees with itself. This module is the cross-implementation check,
and it is the regression test for the library-choice risk recorded in
``docs/handoffs/WP-130.md``.

If these tests fail after a dependency bump, the archive format changed. That
is not a test to relax.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import duckdb
import pytest

from research.compaction import validate_dataset
from research.compaction.manifest import load_manifest

FIXTURE_ROOT = Path(__file__).resolve().parent.parent / "testdata"
MANIFEST_PATH = FIXTURE_ROOT / "datasets" / "ds-fixture" / "manifest.json"


pytestmark = pytest.mark.skipif(
    not MANIFEST_PATH.is_file(),
    reason=(
        "committed fixture is absent; regenerate it with "
        "`pnpm --filter @polymarket-bot/research-worker fixture:python`"
    ),
)


def test_the_fixture_validates_end_to_end() -> None:
    report = validate_dataset(MANIFEST_PATH)
    assert report.ok, [f"{f.check}: {f.message}" for f in report.findings]
    assert report.rows_checked == 7
    assert report.objects_checked >= 2


def test_the_manifest_digest_sidecar_matches_the_manifest_bytes() -> None:
    digest = hashlib.sha256(MANIFEST_PATH.read_bytes()).hexdigest()
    sidecar = (MANIFEST_PATH.parent / "manifest.sha256").read_text(encoding="utf-8").strip()
    assert digest == sidecar


def test_duckdb_reads_the_pinned_layout_with_the_expected_types() -> None:
    manifest = load_manifest(MANIFEST_PATH)
    paths = [str(FIXTURE_ROOT / entry.object_key) for entry in manifest.objects]
    connection = duckdb.connect()
    try:
        described = connection.execute(
            "describe select * from read_parquet($paths)", {"paths": paths}
        ).fetchall()
    finally:
        connection.close()

    observed = {row[0]: row[1] for row in described}
    # The encoding decision this package exists to protect: bigint-as-string and
    # every decimal-shaped value are VARCHAR, never DECIMAL and never BIGINT.
    assert observed["ingestSeq"] == "VARCHAR"
    assert observed["receivedMonotonicNs"] == "VARCHAR"
    assert observed["payloadUtf8"] == "VARCHAR"
    assert observed["payloadSha256"] == "VARCHAR"
    assert observed["subscriptionGeneration"] == "BIGINT"
    assert observed["datasetRowOrdinal"] == "BIGINT"
    assert observed["replayEligible"] == "BOOLEAN"


def test_payloads_survive_byte_exactly_including_adversarial_ones() -> None:
    manifest = load_manifest(MANIFEST_PATH)
    paths = [str(FIXTURE_ROOT / entry.object_key) for entry in manifest.objects]
    connection = duckdb.connect()
    try:
        rows = connection.execute(
            """
            select ingestSeq, payloadUtf8
            from read_parquet($paths)
            order by datasetRowOrdinal
            """,
            {"paths": paths},
        ).fetchall()
    finally:
        connection.close()

    payloads = {ingest_seq: payload for ingest_seq, payload in rows}

    # Trailing-zero decimals: exactly what a Parquet DECIMAL column would have
    # normalised away.
    assert payloads["1"] == '{"event_type":"book","bids":[{"price":"0.100","size":"1.0"}]}'
    # A non-JSON heartbeat frame, stored verbatim (ADR-004 §6).
    assert payloads["2"] == "PING"
    # An empty payload is a payload.
    assert payloads["3"] == ""
    # A payload that looks like a footer record cannot be confused for one.
    assert payloads["4"] == '{"record":"footer","formatId":"polymarket-bot/wal/v1"}'
    # Control characters, including NUL and DEL, survive a text column.
    assert payloads["5"] == "control\tchars and\x00\x7fbytes"
    # Astral-plane characters and a literal backslash-n that is not a newline.
    assert payloads["6"] == "emoji \U0001f600 plus a literal backslash-n \\n"
    # An ingestSeq past 2^63, which INT64 could not have represented.
    assert "18446744073709551617" in payloads
    assert payloads["18446744073709551617"] == '{"price":"1.0000000000000000001"}'


def test_the_incident_window_is_pinned_and_applied() -> None:
    manifest = load_manifest(MANIFEST_PATH)
    assert len(manifest.excluded_incident_windows) == 1
    window = manifest.excluded_incident_windows[0]
    assert window.incident_id == "inc-fixture-1"
    assert window.excluded_record_count == 2

    paths = [str(FIXTURE_ROOT / entry.object_key) for entry in manifest.objects]
    connection = duckdb.connect()
    try:
        excluded = connection.execute(
            """
            select ingestSeq, exclusionReason
            from read_parquet($paths)
            where not replayEligible
            order by datasetRowOrdinal
            """,
            {"paths": paths},
        ).fetchall()
    finally:
        connection.close()

    assert excluded == [("4", "incident:inc-fixture-1"), ("5", "incident:inc-fixture-1")]


def test_dispatch_order_is_recoverable_from_the_ordinal_alone() -> None:
    manifest = load_manifest(MANIFEST_PATH)
    paths = [str(FIXTURE_ROOT / entry.object_key) for entry in manifest.objects]
    connection = duckdb.connect()
    try:
        ordered = connection.execute(
            "select ingestSeq from read_parquet($paths) order by datasetRowOrdinal",
            {"paths": paths},
        ).fetchall()
    finally:
        connection.close()
    assert [row[0] for row in ordered] == [
        "1",
        "2",
        "3",
        "4",
        "5",
        "6",
        "18446744073709551617",
    ]


def test_every_segment_the_manifest_pins_declares_a_wal_checksum() -> None:
    manifest = load_manifest(MANIFEST_PATH)
    assert manifest.segments
    for segment in manifest.segments:
        assert len(segment.segment_sha256) == 64
        assert int(segment.segment_sha256, 16) >= 0
        assert not segment.wal_segment_deleted


def test_the_manifest_records_the_schema_versions_it_pins() -> None:
    document = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    versions = document["schemaVersions"]
    assert versions["walFormatId"] == "polymarket-bot/wal/v1"
    assert versions["walSchemaVersion"] == 1
    assert versions["parquetLayoutId"] == "polymarket-bot/parquet-raw-frames/v1"
    assert versions["parquetLayoutVersion"] == 1
    # The run-scoped §12.5 pins are explicitly null, never invented.
    pins = document["replayPins"]
    assert pins["runSeed"] is None
    assert pins["fillModelVersion"] is None
    assert "not pinned yet" in pins["note"]
