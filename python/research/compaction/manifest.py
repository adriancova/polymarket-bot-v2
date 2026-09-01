"""Reading a dataset manifest.

The manifest is the authority on what a dataset contains (ADR-004 §5: "Replay
consumes the manifest, not a directory listing"), so this reader is strict: an
unknown format id or an unreadable version is a refusal, never a best-effort
parse. A validator that guessed at a manifest it did not understand would
produce a green result about a dataset nobody can characterise.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

DATASET_MANIFEST_FORMAT_ID = "polymarket-bot/dataset-manifest/v1"
DATASET_MANIFEST_VERSION = 1
PARQUET_LAYOUT_ID = "polymarket-bot/parquet-raw-frames/v1"
PARQUET_LAYOUT_VERSION = 1
RETENTION_RECEIPT_FORMAT_ID = "polymarket-bot/retention-receipt/v1"
RETENTION_RECEIPT_VERSION = 1
RETENTION_RECEIPT_OBJECT_NAME = "retention-receipt.json"
#: The digest sidecar the compactor writes next to ``manifest.json``: the
#: manifest bytes' SHA-256 as 64 lowercase hex characters plus one ``LF``
#: (``DATASET_MANIFEST_DIGEST_OBJECT_NAME`` in the TypeScript constants).
DATASET_MANIFEST_DIGEST_OBJECT_NAME = "manifest.sha256"


class ManifestError(Exception):
    """The manifest is absent, malformed, or of a version this build cannot read."""


@dataclass(frozen=True)
class SegmentEntry:
    """One WAL segment pinned by the dataset (handoff §8.4).

    Deletion state is deliberately absent: the manifest is persisted before
    retention may delete anything, so what was deleted is reported in the
    separate retention receipt object (``retention-receipt.json``), which the
    validator reconciles when it is present.

    Two distinct digests are pinned per segment. ``segment_sha256`` is the
    WAL-chain identity: the digest over ``0..checksummedByteLength`` that the
    WAL's own manifest chain defines. ``segment_file_sha256`` is the
    deletion-time identity: the round-2 whole-file pin over the segment file's
    entire bytes, footer included, which is what the TypeScript retention
    guard requires before an unlink. Both are **required**: a manifest
    omitting either (or pinning a non-string) is refused with
    ``ManifestError``, exactly like every other required field — the parser's
    contract is shape, and a missing pin is a shape this build cannot read.
    Whether a *present* digest's value is well-formed (64 lowercase hex) is
    the validator's business, reported as a finding, matching how the
    validator treats every other manifest-pinned value it can evaluate.
    """

    segment_id: str
    gateway_epoch: str
    segment_index: int
    segment_sha256: str
    segment_file_sha256: str
    record_count: int
    first_ingest_seq: str | None
    last_ingest_seq: str | None
    object_key: str


@dataclass(frozen=True)
class ObjectEntry:
    """One compacted Parquet object pinned by the dataset."""

    object_key: str
    byte_length: int
    sha256: str
    row_count: int
    replay_eligible_row_count: int
    first_dataset_row_ordinal: int | None
    last_dataset_row_ordinal: int | None
    segment_ids: tuple[str, ...]


@dataclass(frozen=True)
class IncidentWindowEntry:
    """An excluded data-quality window and what it actually excluded."""

    incident_id: str
    kind: str
    gateway_epoch: str
    from_ingest_seq: str
    to_ingest_seq: str
    reason: str
    excluded_record_count: int
    excluded_segment_ids: tuple[str, ...]


@dataclass(frozen=True)
class RecordCounts:
    """Every count a reconciliation needs."""

    segment_declared: int
    segment_read: int
    written: int
    replay_eligible: int
    excluded_by_incident: int
    excluded_as_duplicate: int


@dataclass(frozen=True)
class DatasetManifest:
    """The parsed manifest, with the fields validation actually uses."""

    dataset_id: str
    created_at: str
    wal_format_id: str
    wal_schema_version: int
    parquet_layout_id: str
    parquet_layout_version: int
    columns: tuple[tuple[str, str, bool], ...]
    record_counts: RecordCounts
    segments: tuple[SegmentEntry, ...]
    objects: tuple[ObjectEntry, ...]
    excluded_incident_windows: tuple[IncidentWindowEntry, ...]
    excluded_segment_ids: tuple[str, ...]
    duplicate_record_count: int
    wal_retention_policy: str
    raw: dict[str, Any]


def _require(source: dict[str, Any], key: str, where: str) -> Any:
    if key not in source:
        raise ManifestError(f"{where}: missing required field {key!r}")
    return source[key]


def _require_dict(value: Any, where: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ManifestError(f"{where}: expected a JSON object")
    return value


def _require_list(value: Any, where: str) -> list[Any]:
    if not isinstance(value, list):
        raise ManifestError(f"{where}: expected a JSON array")
    return value


def _require_int(value: Any, where: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise ManifestError(f"{where}: expected an integer")
    return value


def _require_bool(value: Any, where: str) -> bool:
    # An actual JSON boolean — not a string "false", not an object, not 0/1.
    # The parser's contract is shape (round 3's segmentFileSha256 choice):
    # a truthiness coercion here let `"false"` and `{"bizarre": true}` pins
    # validate green in round 4's review, which is a shape this build must
    # refuse, not reinterpret.
    if not isinstance(value, bool):
        raise ManifestError(f"{where}: expected a boolean")
    return value


def _require_str(value: Any, where: str) -> str:
    if not isinstance(value, str):
        raise ManifestError(f"{where}: expected a string")
    # A parsed JSON string can carry an unpaired surrogate (an escaped
    # "\ud800" in the document), which cannot be encoded back to UTF-8: it
    # detonates any path operation or output stream that touches it. The
    # TypeScript writer can never produce such a string — every manifest
    # string is built from filesystem/config text Node decodes with U+FFFD
    # replacement (see the round-4 handoff citation) — so it is a shape this
    # build refuses, like every other malformed required field.
    try:
        value.encode("utf-8")
    except UnicodeEncodeError as error:
        raise ManifestError(
            f"{where}: string contains an unpaired surrogate and cannot be "
            "encoded to UTF-8"
        ) from error
    return value


def _optional_str(value: Any, where: str) -> str | None:
    if value is None:
        return None
    return _require_str(value, where)


def _optional_int(value: Any, where: str) -> int | None:
    if value is None:
        return None
    return _require_int(value, where)


def parse_manifest(document: Any) -> DatasetManifest:
    """Parse a manifest document, refusing anything this build cannot read."""
    root = _require_dict(document, "manifest")

    format_id = _require_str(_require(root, "datasetManifestFormatId", "manifest"), "format id")
    if format_id != DATASET_MANIFEST_FORMAT_ID:
        raise ManifestError(f"unknown dataset manifest format: {format_id!r}")

    version = _require_int(
        _require(root, "datasetManifestVersion", "manifest"), "manifest version"
    )
    if version != DATASET_MANIFEST_VERSION:
        raise ManifestError(
            f"dataset manifest version {version} is not readable by this build "
            f"(supported: {DATASET_MANIFEST_VERSION})"
        )

    schema_versions = _require_dict(
        _require(root, "schemaVersions", "manifest"), "schemaVersions"
    )
    counts = _require_dict(_require(root, "recordCounts", "manifest"), "recordCounts")
    dedup = _require_dict(_require(root, "deduplication", "manifest"), "deduplication")

    def _column(raw_column: Any) -> tuple[str, str, bool]:
        column = _require_dict(raw_column, "column")
        return (
            _require_str(_require(column, "name", "column"), "name"),
            _require_str(_require(column, "physicalType", "column"), "physicalType"),
            _require_bool(_require(column, "nullable", "column"), "nullable"),
        )

    columns = tuple(
        _column(entry)
        for entry in _require_list(_require(root, "columns", "manifest"), "columns")
    )

    segments = tuple(
        SegmentEntry(
            segment_id=_require_str(_require(_require_dict(e, "segment"), "segmentId", "segment"), "segmentId"),
            gateway_epoch=_require_str(_require(e, "gatewayEpoch", "segment"), "gatewayEpoch"),
            segment_index=_require_int(_require(e, "segmentIndex", "segment"), "segmentIndex"),
            segment_sha256=_require_str(_require(e, "segmentSha256", "segment"), "segmentSha256"),
            segment_file_sha256=_require_str(
                _require(e, "segmentFileSha256", "segment"), "segmentFileSha256"
            ),
            record_count=_require_int(_require(e, "recordCount", "segment"), "recordCount"),
            first_ingest_seq=_optional_str(e.get("firstIngestSeq"), "firstIngestSeq"),
            last_ingest_seq=_optional_str(e.get("lastIngestSeq"), "lastIngestSeq"),
            object_key=_require_str(_require(e, "objectKey", "segment"), "objectKey"),
        )
        for e in _require_list(_require(root, "segments", "manifest"), "segments")
    )

    objects = tuple(
        ObjectEntry(
            object_key=_require_str(_require(_require_dict(e, "object"), "objectKey", "object"), "objectKey"),
            byte_length=_require_int(_require(e, "byteLength", "object"), "byteLength"),
            sha256=_require_str(_require(e, "sha256", "object"), "sha256"),
            row_count=_require_int(_require(e, "rowCount", "object"), "rowCount"),
            replay_eligible_row_count=_require_int(
                _require(e, "replayEligibleRowCount", "object"), "replayEligibleRowCount"
            ),
            first_dataset_row_ordinal=_optional_int(
                e.get("firstDatasetRowOrdinal"), "firstDatasetRowOrdinal"
            ),
            last_dataset_row_ordinal=_optional_int(
                e.get("lastDatasetRowOrdinal"), "lastDatasetRowOrdinal"
            ),
            segment_ids=tuple(
                _require_str(s, "segmentIds entry")
                for s in _require_list(_require(e, "segmentIds", "object"), "segmentIds")
            ),
        )
        for e in _require_list(_require(root, "objects", "manifest"), "objects")
    )

    def _incident_entry(raw_entry: Any) -> IncidentWindowEntry:
        entry = _require_dict(raw_entry, "excludedIncidentWindows entry")
        window = _require_dict(_require(entry, "window", "incident entry"), "window")
        return IncidentWindowEntry(
            incident_id=_require_str(_require(window, "incidentId", "window"), "incidentId"),
            kind=_require_str(_require(window, "kind", "window"), "kind"),
            gateway_epoch=_require_str(
                _require(window, "gatewayEpoch", "window"), "gatewayEpoch"
            ),
            from_ingest_seq=_require_str(
                _require(window, "fromIngestSeq", "window"), "fromIngestSeq"
            ),
            to_ingest_seq=_require_str(_require(window, "toIngestSeq", "window"), "toIngestSeq"),
            reason=_require_str(_require(window, "reason", "window"), "reason"),
            excluded_record_count=_require_int(
                _require(entry, "excludedRecordCount", "incident entry"), "excludedRecordCount"
            ),
            excluded_segment_ids=tuple(
                _require_str(segment_id, "excludedSegmentIds entry")
                for segment_id in _require_list(
                    _require(entry, "excludedSegmentIds", "incident entry"),
                    "excludedSegmentIds",
                )
            ),
        )

    windows = tuple(
        _incident_entry(entry)
        for entry in _require_list(
            _require(root, "excludedIncidentWindows", "manifest"), "excludedIncidentWindows"
        )
    )

    excluded_segment_ids = tuple(
        _require_str(_require(_require_dict(e, "excludedSegment"), "segmentId", "excludedSegment"), "segmentId")
        for e in _require_list(
            _require(root, "excludedSegments", "manifest"), "excludedSegments"
        )
    )

    return DatasetManifest(
        dataset_id=_require_str(_require(root, "datasetId", "manifest"), "datasetId"),
        created_at=_require_str(_require(root, "createdAt", "manifest"), "createdAt"),
        wal_format_id=_require_str(
            _require(schema_versions, "walFormatId", "schemaVersions"), "walFormatId"
        ),
        wal_schema_version=_require_int(
            _require(schema_versions, "walSchemaVersion", "schemaVersions"), "walSchemaVersion"
        ),
        parquet_layout_id=_require_str(
            _require(schema_versions, "parquetLayoutId", "schemaVersions"), "parquetLayoutId"
        ),
        parquet_layout_version=_require_int(
            _require(schema_versions, "parquetLayoutVersion", "schemaVersions"),
            "parquetLayoutVersion",
        ),
        columns=columns,
        record_counts=RecordCounts(
            segment_declared=_require_int(
                _require(counts, "segmentDeclared", "recordCounts"), "segmentDeclared"
            ),
            segment_read=_require_int(
                _require(counts, "segmentRead", "recordCounts"), "segmentRead"
            ),
            written=_require_int(_require(counts, "written", "recordCounts"), "written"),
            replay_eligible=_require_int(
                _require(counts, "replayEligible", "recordCounts"), "replayEligible"
            ),
            excluded_by_incident=_require_int(
                _require(counts, "excludedByIncident", "recordCounts"), "excludedByIncident"
            ),
            excluded_as_duplicate=_require_int(
                _require(counts, "excludedAsDuplicate", "recordCounts"), "excludedAsDuplicate"
            ),
        ),
        segments=segments,
        objects=objects,
        excluded_incident_windows=windows,
        excluded_segment_ids=excluded_segment_ids,
        duplicate_record_count=_require_int(
            _require(dedup, "duplicateRecordCount", "deduplication"), "duplicateRecordCount"
        ),
        wal_retention_policy=_require_str(
            _require(root, "walRetentionPolicy", "manifest"), "walRetentionPolicy"
        ),
        raw=root,
    )


def load_manifest(path: str | Path) -> DatasetManifest:
    """Read and parse a manifest file."""
    manifest_path = Path(path)
    try:
        text = manifest_path.read_text(encoding="utf-8")
    except OSError as error:
        raise ManifestError(f"manifest {manifest_path} could not be read: {error}") from error
    try:
        document = json.loads(text)
    except json.JSONDecodeError as error:
        raise ManifestError(f"manifest {manifest_path} is not valid JSON: {error}") from error
    return parse_manifest(document)
