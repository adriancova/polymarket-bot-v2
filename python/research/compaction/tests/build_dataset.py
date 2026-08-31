"""A synthetic dataset builder for the validator's own tests.

It writes Parquet with **DuckDB**, not with the TypeScript compactor, for the
same reason the validator uses DuckDB to read: a test whose fixture and whose
subject share an implementation can only prove self-consistency. Building the
file here lets each failure mode be constructed exactly — a wrong count, a
missing exclusion, a doctored digest — which is impossible to do through the
real compactor, since the compactor refuses to produce those states.

The committed fixture under ``testdata/`` covers the other half: it is written
by the real compactor, and proves DuckDB reads what that writer produces.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

import duckdb

_COLUMNS = [
    ("datasetRowOrdinal", "INT64", False),
    ("segmentId", "BYTE_ARRAY_UTF8", False),
    ("segmentIndex", "INT64", False),
    ("segmentRecordIndex", "INT64", False),
    ("gatewayEpoch", "BYTE_ARRAY_UTF8", False),
    ("ingestSeq", "BYTE_ARRAY_UTF8", False),
    ("source", "BYTE_ARRAY_UTF8", False),
    ("endpoint", "BYTE_ARRAY_UTF8", False),
    ("connectionId", "BYTE_ARRAY_UTF8", False),
    ("subscriptionGeneration", "INT64", False),
    ("receivedAt", "BYTE_ARRAY_UTF8", False),
    ("receivedMonotonicNs", "BYTE_ARRAY_UTF8", False),
    ("payloadUtf8", "BYTE_ARRAY_UTF8", False),
    ("payloadSha256", "BYTE_ARRAY_UTF8", False),
    ("frameLineByteOffset", "INT64", False),
    ("frameLineByteLength", "INT64", False),
    ("frameLineSha256", "BYTE_ARRAY_UTF8", False),
    ("replayEligible", "BOOLEAN", False),
    ("exclusionReason", "BYTE_ARRAY_UTF8", True),
]

EPOCH = "0190a3e0-0000-7000-8000-000000000001"


@dataclass
class Row:
    ordinal: int
    segment_id: str
    segment_index: int
    segment_record_index: int
    ingest_seq: str
    payload: str
    replay_eligible: bool = True
    exclusion_reason: str | None = None
    payload_sha256: str | None = None

    def to_tuple(self) -> tuple[Any, ...]:
        payload_digest = self.payload_sha256 or hashlib.sha256(
            self.payload.encode("utf-8")
        ).hexdigest()
        line_digest = hashlib.sha256(
            f"{self.segment_id}/{self.ingest_seq}".encode("utf-8")
        ).hexdigest()
        return (
            self.ordinal,
            self.segment_id,
            self.segment_index,
            self.segment_record_index,
            EPOCH,
            self.ingest_seq,
            "polymarket",
            "wss://ws-subscriptions-clob.polymarket.com/ws/market",
            "conn-1",
            0,
            "2026-01-01T00:00:00.000Z",
            "1000000",
            self.payload,
            payload_digest,
            100 + self.ordinal,
            420,
            line_digest,
            self.replay_eligible,
            self.exclusion_reason,
        )


def write_object(path: Path, rows: list[Row]) -> tuple[int, str]:
    """Write rows to a Parquet object; return its byte length and SHA-256."""
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = duckdb.connect()
    try:
        connection.execute(
            "create table dataset ("
            + ", ".join(
                f"{name} "
                + {
                    "INT64": "BIGINT",
                    "BYTE_ARRAY_UTF8": "VARCHAR",
                    "BOOLEAN": "BOOLEAN",
                }[physical]
                for name, physical, _nullable in _COLUMNS
            )
            + ")"
        )
        if rows:
            placeholders = ", ".join(["?"] * len(_COLUMNS))
            connection.executemany(
                f"insert into dataset values ({placeholders})", [row.to_tuple() for row in rows]
            )
        connection.execute(
            "copy (select * from dataset order by datasetRowOrdinal) to ? (format parquet)",
            [str(path)],
        )
    finally:
        connection.close()
    data = path.read_bytes()
    return len(data), hashlib.sha256(data).hexdigest()


def build_manifest(
    *,
    dataset_id: str,
    objects: list[tuple[str, list[Row], int, str]],
    incident_windows: list[dict[str, Any]] | None = None,
    excluded_segments: list[dict[str, Any]] | None = None,
    duplicate_record_count: int | None = None,
    retention_policy: str = "retain",
) -> dict[str, Any]:
    """Build a manifest that truthfully describes the objects it is given."""
    all_rows = [row for _key, rows, _length, _digest in objects for row in rows]
    written = len(all_rows)
    excluded_by_incident = sum(
        1
        for row in all_rows
        if row.exclusion_reason is not None and row.exclusion_reason.startswith("incident:")
    )
    excluded_as_duplicate = sum(
        1
        for row in all_rows
        if row.exclusion_reason is not None and row.exclusion_reason.startswith("duplicate:")
    )
    replay_eligible = sum(1 for row in all_rows if row.replay_eligible)

    segment_rows: dict[str, list[Row]] = {}
    for row in all_rows:
        segment_rows.setdefault(row.segment_id, []).append(row)

    object_key_by_segment = {
        row.segment_id: key for key, rows, _length, _digest in objects for row in rows
    }

    return {
        "datasetManifestFormatId": "polymarket-bot/dataset-manifest/v1",
        "datasetManifestVersion": 1,
        "datasetId": dataset_id,
        "createdAt": "2026-01-01T00:00:00.000Z",
        "schemaVersions": {
            "walFormatId": "polymarket-bot/wal/v1",
            "walSchemaVersion": 1,
            "walManifestVersion": 1,
            "parquetLayoutId": "polymarket-bot/parquet-raw-frames/v1",
            "parquetLayoutVersion": 1,
            "datasetManifestFormatId": "polymarket-bot/dataset-manifest/v1",
            "datasetManifestVersion": 1,
        },
        "writer": {
            "library": "duckdb-test-builder",
            "libraryVersion": "0",
            "codec": "UNCOMPRESSED",
            "rowGroupSize": 10000,
        },
        "columns": [
            {"name": name, "physicalType": physical, "nullable": nullable}
            for name, physical, nullable in _COLUMNS
        ],
        "replayPins": {
            "normalizerVersion": None,
            "featureSetVersion": None,
            "runSeed": None,
            "fillModelVersion": None,
            "latencyModelVersion": None,
            "feeSnapshotVersion": None,
            "rewardSnapshotVersion": None,
            "settlementSpecVersions": [],
            "note": "test fixture",
        },
        "gatewayEpochs": [EPOCH],
        "eventRange": {
            "first": None
            if not all_rows
            else {
                "gatewayEpoch": EPOCH,
                "ingestSeq": all_rows[0].ingest_seq,
                "receivedAt": "2026-01-01T00:00:00.000Z",
                "datasetRowOrdinal": all_rows[0].ordinal,
            },
            "last": None
            if not all_rows
            else {
                "gatewayEpoch": EPOCH,
                "ingestSeq": all_rows[-1].ingest_seq,
                "receivedAt": "2026-01-01T00:00:00.000Z",
                "datasetRowOrdinal": all_rows[-1].ordinal,
            },
        },
        "recordCounts": {
            "segmentDeclared": written,
            "segmentRead": written,
            "written": written,
            "replayEligible": replay_eligible,
            "excludedByIncident": excluded_by_incident,
            "excludedAsDuplicate": excluded_as_duplicate,
        },
        "deduplication": {
            "policy": "first-wins-in-dispatch-order",
            "duplicateRecordCount": duplicate_record_count
            if duplicate_record_count is not None
            else excluded_as_duplicate,
            "duplicateKeys": [],
            "duplicateKeysTruncated": False,
        },
        "segments": [
            {
                "segmentId": segment_id,
                "gatewayEpoch": EPOCH,
                "segmentIndex": rows[0].segment_index,
                "segmentSha256": hashlib.sha256(segment_id.encode("utf-8")).hexdigest(),
                "checksummedByteLength": 1000,
                "byteSize": 1400,
                "recordCount": len(rows),
                "firstIngestSeq": rows[0].ingest_seq,
                "lastIngestSeq": rows[-1].ingest_seq,
                "firstReceivedAt": "2026-01-01T00:00:00.000Z",
                "lastReceivedAt": "2026-01-01T00:00:00.000Z",
                "closeReason": "shutdown",
                "footerPresent": True,
                "truncatedTailBytes": 0,
                "objectKey": object_key_by_segment[segment_id],
                "firstDatasetRowOrdinal": rows[0].ordinal,
                "lastDatasetRowOrdinal": rows[-1].ordinal,
                "walSegmentDeleted": retention_policy != "retain",
            }
            for segment_id, rows in segment_rows.items()
        ],
        "objects": [
            {
                "objectKey": key,
                "byteLength": length,
                "sha256": digest,
                "rowCount": len(rows),
                "replayEligibleRowCount": sum(1 for row in rows if row.replay_eligible),
                "firstDatasetRowOrdinal": rows[0].ordinal if rows else None,
                "lastDatasetRowOrdinal": rows[-1].ordinal if rows else None,
                "segmentIds": sorted({row.segment_id for row in rows}),
            }
            for key, rows, length, digest in objects
        ],
        "excludedSegments": excluded_segments or [],
        "excludedIncidentWindows": incident_windows or [],
        "walRetentionPolicy": retention_policy,
    }


def default_rows() -> list[Row]:
    """Five rows across two segments, with one incident exclusion."""
    segment_a = f"{EPOCH}-000000"
    segment_b = f"{EPOCH}-000001"
    return [
        Row(0, segment_a, 0, 0, "1", '{"event_type":"book"}'),
        Row(
            1,
            segment_a,
            0,
            1,
            "2",
            "PING",
            replay_eligible=False,
            exclusion_reason="incident:inc-1",
        ),
        Row(2, segment_b, 1, 0, "3", '{"price":"0.100"}'),
        Row(3, segment_b, 1, 1, "4", "PONG"),
        Row(4, segment_b, 1, 2, "5", '{"price":"1.0"}'),
    ]


def incident_window(excluded_record_count: int = 1) -> dict[str, Any]:
    return {
        "window": {
            "incidentId": "inc-1",
            "kind": "gap",
            "gatewayEpoch": EPOCH,
            "fromIngestSeq": "2",
            "toIngestSeq": "2",
            "openedAt": "2026-01-01T00:00:05.000Z",
            "closedAt": "2026-01-01T00:00:06.000Z",
            "reason": "market channel gap",
        },
        "excludedRecordCount": excluded_record_count,
        "excludedSegmentIds": [f"{EPOCH}-000000"],
    }


def build_dataset(
    root: Path,
    *,
    rows: list[Row] | None = None,
    dataset_id: str = "ds-test",
    incident_windows: list[dict[str, Any]] | None = None,
    retention_policy: str = "retain",
) -> Path:
    """Write a complete, valid dataset under ``root`` and return the manifest path."""
    rows = rows if rows is not None else default_rows()
    prefix = f"datasets/{dataset_id}"
    by_segment: dict[str, list[Row]] = {}
    for row in rows:
        by_segment.setdefault(row.segment_id, []).append(row)

    objects: list[tuple[str, list[Row], int, str]] = []
    for segment_id, segment_rows in by_segment.items():
        key = f"{prefix}/{segment_id}.parquet"
        length, digest = write_object(root / key, segment_rows)
        objects.append((key, segment_rows, length, digest))

    manifest = build_manifest(
        dataset_id=dataset_id,
        objects=objects,
        incident_windows=incident_windows
        if incident_windows is not None
        else [incident_window()],
        retention_policy=retention_policy,
    )
    manifest_path = root / prefix / "manifest.json"
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest_path


def rewrite_manifest(manifest_path: Path, mutate: Any) -> None:
    """Apply a mutation to a written manifest, for negative tests."""
    document = json.loads(manifest_path.read_text(encoding="utf-8"))
    mutate(document)
    manifest_path.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")


__all__ = [
    "EPOCH",
    "Row",
    "build_dataset",
    "build_manifest",
    "default_rows",
    "incident_window",
    "replace",
    "rewrite_manifest",
    "write_object",
]
