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
#: The newest dataset-manifest version (``STORAGE-1``, ADR-029 Decision 1).
#: The format id is the coarse discriminator and does not move with it.
DATASET_MANIFEST_VERSION = 2
#: Every version this reader accepts (ADR-029 Consequences: every reader
#: accepts version 1 and version 2 before any version 2 manifest is written).
READABLE_DATASET_MANIFEST_VERSIONS = (1, 2)
#: ADR-029 Decision 1.1: every version 2 manifest states one of these.
DATASET_FIDELITIES = ("exact", "approximate")
PARQUET_LAYOUT_ID = "polymarket-bot/parquet-raw-frames/v1"
PARQUET_LAYOUT_VERSION = 1
#: The research-tier layout an approximate manifest pins (``STORAGE-1``).
RESEARCH_TIER_LAYOUT_ID = "polymarket-bot/research-tier/v1"
RESEARCH_TIER_LAYOUT_VERSION = 1
RETENTION_RECEIPT_FORMAT_ID = "polymarket-bot/retention-receipt/v1"
#: The newest retention-receipt version (ADR-028 Decision 4.3). Version 1 is
#: still read; its entries carry no ``basis`` and read as ``verified-upload``.
RETENTION_RECEIPT_VERSION = 2
READABLE_RETENTION_RECEIPT_VERSIONS = (1, 2)
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
    """The parsed **exact** manifest, with the fields validation actually uses.

    ``version`` is 1 or 2 and ``fidelity`` is always ``"exact"``: a version 1
    document has no ``fidelity`` field and reads as exact (ADR-029 Decision
    1.3); a version 2 document states it.
    """

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
    version: int = 1
    fidelity: str = "exact"


@dataclass(frozen=True)
class ResearchSourceSegment:
    """One WAL segment a research-tier dataset was built from (ADR-029 1.5)."""

    segment_id: str
    gateway_epoch: str
    segment_index: int
    segment_sha256: str
    segment_file_sha256: str
    checksummed_byte_length: int
    byte_size: int
    record_count: int
    min_received_at: str | None
    max_received_at: str | None


@dataclass(frozen=True)
class ResearchObjectEntry:
    """One research-tier table object."""

    object_key: str
    table: str
    byte_length: int
    sha256: str
    row_count: int
    first_sample_ordinal: int | None
    last_sample_ordinal: int | None


@dataclass(frozen=True)
class ResearchTableEntry:
    """One research-tier table and its pinned columns."""

    table: str
    sample_class: str
    columns: tuple[tuple[str, str, bool], ...]


@dataclass(frozen=True)
class ResearchStateObject:
    """A pinned sampler-state object."""

    object_key: str
    byte_length: int
    sha256: str


@dataclass(frozen=True)
class ResearchTierManifest:
    """A parsed version 2 **approximate** (research-tier) manifest.

    ADR-029: it pins research-tier objects and the downsampling version, and
    lists every source segment with both digests. It is never admissible as
    determinism, calibration, promotion or soak evidence (Decision 2), which
    is why ``fidelity`` is carried as data and never inferred.
    """

    dataset_id: str
    created_at: str
    version: int
    fidelity: str
    admissibility: str
    layout_id: str
    layout_version: int
    downsampling_id: str
    downsampling_version: int
    gateway_epoch: str
    tables: tuple[ResearchTableEntry, ...]
    source_segments: tuple[ResearchSourceSegment, ...]
    objects: tuple[ResearchObjectEntry, ...]
    sampler_state_out: ResearchStateObject
    samples_written: int
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


def read_fidelity(document: Any) -> tuple[int, str]:
    """The ``(version, fidelity)`` a manifest document declares.

    ADR-029 Decision 1: version 1 has no ``fidelity`` field and reads as
    ``exact`` (1.3) — a version 1 document that carries one is refused, as a
    shape this build cannot read; version 2 requires it (1.6) and it must be
    ``exact`` or ``approximate``. Any other format id or version is refused.
    """
    root = _require_dict(document, "manifest")
    format_id = _require_str(_require(root, "datasetManifestFormatId", "manifest"), "format id")
    if format_id != DATASET_MANIFEST_FORMAT_ID:
        raise ManifestError(f"unknown dataset manifest format: {format_id!r}")
    version = _require_int(
        _require(root, "datasetManifestVersion", "manifest"), "manifest version"
    )
    if version not in READABLE_DATASET_MANIFEST_VERSIONS:
        raise ManifestError(
            f"dataset manifest version {version} is not readable by this build "
            f"(supported: {list(READABLE_DATASET_MANIFEST_VERSIONS)})"
        )
    if version == 1:
        if "fidelity" in root:
            raise ManifestError(
                "a version 1 dataset manifest has no fidelity field; one that carries it is refused"
            )
        return version, "exact"
    if "fidelity" not in root:
        raise ManifestError(
            "a version 2 dataset manifest must state its fidelity (ADR-029 Decision 1.6)"
        )
    fidelity = _require_str(root["fidelity"], "fidelity")
    if fidelity not in DATASET_FIDELITIES:
        raise ManifestError(f"unknown dataset fidelity: {fidelity!r}")
    return version, fidelity


def parse_any_manifest(document: Any) -> DatasetManifest | ResearchTierManifest:
    """Parse either class of dataset manifest (version 1, version 2 exact,
    version 2 approximate)."""
    _version, fidelity = read_fidelity(document)
    if fidelity == "approximate":
        return parse_research_tier_manifest(document)
    return parse_manifest(document)


def parse_research_tier_manifest(document: Any) -> ResearchTierManifest:
    """Parse a version 2 approximate (research-tier) manifest."""
    version, fidelity = read_fidelity(document)
    if fidelity != "approximate":
        raise ManifestError("the document is an exact manifest, not a research-tier one")
    root = _require_dict(document, "manifest")
    schema = _require_dict(_require(root, "schemaVersions", "manifest"), "schemaVersions")
    downsampling = _require_dict(_require(root, "downsampling", "manifest"), "downsampling")
    epochs = [
        _require_str(epoch, "gatewayEpochs entry")
        for epoch in _require_list(_require(root, "gatewayEpochs", "manifest"), "gatewayEpochs")
    ]
    if len(epochs) != 1:
        raise ManifestError(
            "a research-tier dataset covers exactly one gateway epoch (ADR-029 Decision 5.4)"
        )
    counts = _require_dict(_require(root, "recordCounts", "manifest"), "recordCounts")
    sampler = _require_dict(_require(root, "samplerState", "manifest"), "samplerState")
    state_out = _require_dict(_require(sampler, "stateOut", "samplerState"), "stateOut")

    def _column(raw_column: Any) -> tuple[str, str, bool]:
        column = _require_dict(raw_column, "column")
        return (
            _require_str(_require(column, "name", "column"), "name"),
            _require_str(_require(column, "physicalType", "column"), "physicalType"),
            _require_bool(_require(column, "nullable", "column"), "nullable"),
        )

    tables = tuple(
        ResearchTableEntry(
            table=_require_str(_require(_require_dict(t, "table"), "table", "table"), "table"),
            sample_class=_require_str(_require(t, "sampleClass", "table"), "sampleClass"),
            columns=tuple(
                _column(c) for c in _require_list(_require(t, "columns", "table"), "columns")
            ),
        )
        for t in _require_list(_require(root, "tables", "manifest"), "tables")
    )
    source_segments = tuple(
        ResearchSourceSegment(
            segment_id=_require_str(
                _require(_require_dict(e, "sourceSegment"), "segmentId", "sourceSegment"),
                "segmentId",
            ),
            gateway_epoch=_require_str(_require(e, "gatewayEpoch", "sourceSegment"), "gatewayEpoch"),
            segment_index=_require_int(_require(e, "segmentIndex", "sourceSegment"), "segmentIndex"),
            segment_sha256=_require_str(
                _require(e, "segmentSha256", "sourceSegment"), "segmentSha256"
            ),
            segment_file_sha256=_require_str(
                _require(e, "segmentFileSha256", "sourceSegment"), "segmentFileSha256"
            ),
            checksummed_byte_length=_require_int(
                _require(e, "checksummedByteLength", "sourceSegment"), "checksummedByteLength"
            ),
            byte_size=_require_int(_require(e, "byteSize", "sourceSegment"), "byteSize"),
            record_count=_require_int(_require(e, "recordCount", "sourceSegment"), "recordCount"),
            min_received_at=_optional_str(e.get("minReceivedAt"), "minReceivedAt"),
            max_received_at=_optional_str(e.get("maxReceivedAt"), "maxReceivedAt"),
        )
        for e in _require_list(_require(root, "sourceSegments", "manifest"), "sourceSegments")
    )
    objects = tuple(
        ResearchObjectEntry(
            object_key=_require_str(
                _require(_require_dict(e, "object"), "objectKey", "object"), "objectKey"
            ),
            table=_require_str(_require(e, "table", "object"), "table"),
            byte_length=_require_int(_require(e, "byteLength", "object"), "byteLength"),
            sha256=_require_str(_require(e, "sha256", "object"), "sha256"),
            row_count=_require_int(_require(e, "rowCount", "object"), "rowCount"),
            first_sample_ordinal=_optional_int(e.get("firstSampleOrdinal"), "firstSampleOrdinal"),
            last_sample_ordinal=_optional_int(e.get("lastSampleOrdinal"), "lastSampleOrdinal"),
        )
        for e in _require_list(_require(root, "objects", "manifest"), "objects")
    )
    return ResearchTierManifest(
        dataset_id=_require_str(_require(root, "datasetId", "manifest"), "datasetId"),
        created_at=_require_str(_require(root, "createdAt", "manifest"), "createdAt"),
        version=version,
        fidelity=fidelity,
        admissibility=_require_str(_require(root, "admissibility", "manifest"), "admissibility"),
        layout_id=_require_str(
            _require(schema, "researchTierLayoutId", "schemaVersions"), "researchTierLayoutId"
        ),
        layout_version=_require_int(
            _require(schema, "researchTierLayoutVersion", "schemaVersions"),
            "researchTierLayoutVersion",
        ),
        downsampling_id=_require_str(
            _require(downsampling, "downsamplingId", "downsampling"), "downsamplingId"
        ),
        downsampling_version=_require_int(
            _require(downsampling, "downsamplingVersion", "downsampling"), "downsamplingVersion"
        ),
        gateway_epoch=epochs[0],
        tables=tables,
        source_segments=source_segments,
        objects=objects,
        sampler_state_out=ResearchStateObject(
            object_key=_require_str(_require(state_out, "objectKey", "stateOut"), "objectKey"),
            byte_length=_require_int(_require(state_out, "byteLength", "stateOut"), "byteLength"),
            sha256=_require_str(_require(state_out, "sha256", "stateOut"), "sha256"),
        ),
        samples_written=_require_int(
            _require(counts, "samplesWritten", "recordCounts"), "samplesWritten"
        ),
        raw=root,
    )


def parse_manifest(document: Any) -> DatasetManifest:
    """Parse an **exact** manifest document (version 1 or version 2),
    refusing anything this build cannot read and refusing an approximate
    (research-tier) manifest: every caller of this function reconciles a
    lossless raw-frame dataset, which an approximate one is not."""
    version, fidelity = read_fidelity(document)
    if fidelity != "exact":
        raise ManifestError(
            "an approximate (research-tier) dataset manifest is not an exact dataset; "
            "read it with parse_any_manifest"
        )
    root = _require_dict(document, "manifest")

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
        version=version,
        fidelity=fidelity,
    )


def decode_utf8(data: bytes, what: str) -> str:
    """The document's bytes as text, or ``ManifestError`` naming the bad byte.

    The TypeScript writer emits every JSON document as UTF-8
    (``Buffer.from(JSON.stringify(...), "utf8")``), so bytes that do not
    decode are corruption or forgery — a classifiable shape of the document
    itself. Round-5 review put a raw ``0xFF`` byte in a manifest and the
    ``UnicodeDecodeError`` out of ``read_text`` (not an ``OSError``) escaped
    to the CLI's exit-3 backstop, which never substitutes for a known class.
    """
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError as error:
        raise ManifestError(
            f"{what} is not valid UTF-8: {error.reason} at byte offset {error.start}"
        ) from error


def _refuse_json_constant(token: str) -> Any:
    # Python's json accepts NaN/Infinity/-Infinity as an extension, parsing
    # them into floats. RFC 8259 JSON has no such literals and the writer's
    # JSON.stringify can never emit them (it serializes non-finite numbers as
    # null), so they are refused at parse — deterministically, rather than
    # left to surface as a confusing per-field "expected an integer" or to
    # slip through a position no shape gate consumes.
    raise ValueError(f"JSON has no literal {token}")


def _refuse_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    # Python's json — like JavaScript's JSON.parse — silently keeps the LAST
    # value of a duplicated key. JSON.stringify of a JS object can never emit
    # a duplicate key, and a document pinning two values under one name is
    # not a coherent authority: whichever copy a reader adopts, the other
    # pinned value vanishes without a finding (round-5 probe: a duplicated
    # walRetentionPolicy flipped the effective policy and validated ok=True).
    # An ambiguous shape, refused like every other shape this build cannot
    # read.
    document: dict[str, Any] = {}
    for key, value in pairs:
        if key in document:
            raise ValueError(f"duplicate key {key!r} in a JSON object")
        document[key] = value
    return document


def parse_strict_json(text: str, what: str) -> Any:
    """``json.loads`` where every parse-level failure is ``ManifestError``.

    Round-5 review reached the CLI's exit-3 backstop with documents the old
    ``except json.JSONDecodeError`` did not classify: a JSON integer with
    more digits than Python's int-conversion limit raises a plain
    ``ValueError``, and pathological nesting raises ``RecursionError``. An
    unparseable document is a *known* class — the caller's documented
    refusal or finding — so **any** exception during the parse becomes
    ``ManifestError`` carrying the parser's own message. Two non-standard
    shapes Python's parser would otherwise accept are refused explicitly:
    NaN/Infinity literals and duplicate object keys (rationales at the
    hooks).
    """
    try:
        return json.loads(
            text,
            parse_constant=_refuse_json_constant,
            object_pairs_hook=_refuse_duplicate_keys,
        )
    except Exception as error:  # noqa: BLE001 — every parse failure is the document's
        raise ManifestError(
            f"{what} is not valid JSON ({type(error).__name__}): {error}"
        ) from error


def _load_document(path: str | Path) -> Any:
    manifest_path = Path(path)
    try:
        raw = manifest_path.read_bytes()
    except OSError as error:
        raise ManifestError(f"manifest {manifest_path} could not be read: {error}") from error
    text = decode_utf8(raw, f"manifest {manifest_path}")
    return parse_strict_json(text, f"manifest {manifest_path}")


def load_any_manifest(path: str | Path) -> DatasetManifest | ResearchTierManifest:
    """Read and parse a manifest file of either class (see
    :func:`load_manifest` for the failure classification)."""
    return parse_any_manifest(_load_document(path))


def load_manifest(path: str | Path) -> DatasetManifest:
    """Read and parse a manifest file.

    Every failure of the manifest file *itself* — an unreadable file, bytes
    that are not UTF-8, text that is not strict JSON — is ``ManifestError``,
    the one documented refusal (exit 2 at the CLI). The read is explicit
    bytes-then-decode-then-parse so that each boundary's failure is
    classified where it happens, and none can fall through to the exit-3
    backstop (round-5 findings F-1 and F-2).
    """
    manifest_path = Path(path)
    try:
        raw = manifest_path.read_bytes()
    except OSError as error:
        raise ManifestError(f"manifest {manifest_path} could not be read: {error}") from error
    text = decode_utf8(raw, f"manifest {manifest_path}")
    document = parse_strict_json(text, f"manifest {manifest_path}")
    return parse_manifest(document)
