"""Dataset-manifest versions 1 and 2, the approximate class, and receipt
versions 1 and 2 (``STORAGE-1``; ADR-029 Decision 1 and Consequences;
ADR-028 Decision 4.3).

ADR-029 Consequences names this reader: "before any version 2 manifest is
written, it moves every reader to accept both versions:
``python/research/compaction/manifest.py``". The committed fixtures are
written by the **real** TypeScript writers
(``test/integration/parquet/python-fixture.test.ts``):

- ``datasets/ds-fixture`` — version 1, unchanged since ``WP-130``;
- ``datasets/ds-fixture-v2`` — the same frames as version 2 ``exact``;
- ``research/...`` — the same WAL through the research-tier extractor, a
  version 2 ``approximate`` dataset.
"""

from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path

import pytest

from research.compaction import validate_dataset
from research.compaction.manifest import (
    DatasetManifest,
    ManifestError,
    ResearchTierManifest,
    load_any_manifest,
    load_manifest,
    parse_any_manifest,
    parse_manifest,
    read_fidelity,
)

FIXTURE_ROOT = Path(__file__).resolve().parent.parent / "testdata"
V1 = FIXTURE_ROOT / "datasets" / "ds-fixture" / "manifest.json"
V2 = FIXTURE_ROOT / "datasets" / "ds-fixture-v2" / "manifest.json"
RESEARCH = next((FIXTURE_ROOT / "research").rglob("manifest.json"), None)


def _document(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _rewrite(manifest_path: Path, mutate) -> None:
    document = _document(manifest_path)
    mutate(document)
    data = (json.dumps(document, indent=2) + "\n").encode("utf-8")
    manifest_path.write_bytes(data)
    (manifest_path.parent / "manifest.sha256").write_text(
        hashlib.sha256(data).hexdigest() + "\n", encoding="utf-8"
    )


def _copy_tree(tmp_path: Path) -> Path:
    target = tmp_path / "testdata"
    shutil.copytree(FIXTURE_ROOT, target)
    return target


class TestVersionOneStillReads:
    def test_version_1_reads_as_exact(self) -> None:
        assert read_fidelity(_document(V1)) == (1, "exact")
        manifest = load_manifest(V1)
        assert manifest.version == 1
        assert manifest.fidelity == "exact"

    def test_the_version_1_fixture_still_validates(self) -> None:
        report = validate_dataset(V1)
        assert report.ok, [f"{f.check}: {f.message}" for f in report.findings]

    def test_a_version_1_manifest_with_a_fidelity_field_is_refused(self) -> None:
        document = _document(V1)
        document["fidelity"] = "approximate"
        with pytest.raises(ManifestError, match="version 1 dataset manifest has no fidelity"):
            parse_any_manifest(document)


class TestVersionTwoExact:
    def test_the_compactors_version_2_manifest_states_exact(self) -> None:
        document = _document(V2)
        assert document["datasetManifestVersion"] == 2
        assert document["fidelity"] == "exact"
        manifest = load_any_manifest(V2)
        assert isinstance(manifest, DatasetManifest)
        assert manifest.version == 2

    def test_it_validates_end_to_end(self) -> None:
        report = validate_dataset(V2)
        assert report.ok, [f"{f.check}: {f.message}" for f in report.findings]
        assert report.rows_checked == 7

    def test_a_version_2_manifest_without_fidelity_is_refused(self) -> None:
        document = _document(V2)
        del document["fidelity"]
        with pytest.raises(ManifestError, match="must state its fidelity"):
            parse_any_manifest(document)

    def test_an_unknown_fidelity_or_version_is_refused(self) -> None:
        document = _document(V2)
        document["fidelity"] = "roughly"
        with pytest.raises(ManifestError, match="unknown dataset fidelity"):
            parse_any_manifest(document)
        document = _document(V2)
        document["datasetManifestVersion"] = 3
        with pytest.raises(ManifestError, match="not readable by this build"):
            parse_any_manifest(document)


@pytest.mark.skipif(RESEARCH is None, reason="the research-tier fixture is absent")
class TestVersionTwoApproximate:
    def test_it_reads_as_a_research_tier_manifest(self) -> None:
        assert RESEARCH is not None
        manifest = load_any_manifest(RESEARCH)
        assert isinstance(manifest, ResearchTierManifest)
        assert manifest.fidelity == "approximate"
        assert manifest.admissibility.startswith("approximate")
        assert manifest.source_segments
        for segment in manifest.source_segments:
            assert len(segment.segment_sha256) == 64
            assert len(segment.segment_file_sha256) == 64

    def test_the_exact_reader_refuses_it(self) -> None:
        assert RESEARCH is not None
        with pytest.raises(ManifestError, match="approximate"):
            parse_manifest(_document(RESEARCH))

    def test_it_validates_end_to_end(self) -> None:
        assert RESEARCH is not None
        report = validate_dataset(RESEARCH)
        assert report.ok, [f"{f.check}: {f.message}" for f in report.findings]
        assert report.rows_checked > 0

    def test_a_changed_object_is_a_finding(self, tmp_path: Path) -> None:
        assert RESEARCH is not None
        root = _copy_tree(tmp_path)
        manifest_path = root / RESEARCH.relative_to(FIXTURE_ROOT)
        parquet = next(manifest_path.parent.glob("*.parquet"))
        data = bytearray(parquet.read_bytes())
        data[len(data) // 2] ^= 0xFF
        parquet.write_bytes(bytes(data))
        report = validate_dataset(manifest_path)
        assert not report.ok
        assert "object-checksum" in {finding.check for finding in report.findings}

    def test_a_miscounted_dataset_is_a_finding(self, tmp_path: Path) -> None:
        assert RESEARCH is not None
        root = _copy_tree(tmp_path)
        manifest_path = root / RESEARCH.relative_to(FIXTURE_ROOT)
        _rewrite(manifest_path, lambda doc: doc["recordCounts"].update({"samplesWritten": 999}))
        report = validate_dataset(manifest_path)
        assert "sample-count" in {finding.check for finding in report.findings}

    def test_a_malformed_source_digest_is_a_finding(self, tmp_path: Path) -> None:
        assert RESEARCH is not None
        root = _copy_tree(tmp_path)
        manifest_path = root / RESEARCH.relative_to(FIXTURE_ROOT)
        _rewrite(
            manifest_path,
            lambda doc: doc["sourceSegments"][0].update({"segmentFileSha256": "xyz"}),
        )
        report = validate_dataset(manifest_path)
        assert "source-segment-digest-grammar" in {finding.check for finding in report.findings}

    def test_a_label_that_is_not_approximate_is_a_finding(self, tmp_path: Path) -> None:
        assert RESEARCH is not None
        root = _copy_tree(tmp_path)
        manifest_path = root / RESEARCH.relative_to(FIXTURE_ROOT)
        _rewrite(manifest_path, lambda doc: doc.update({"admissibility": "fine for promotion"}))
        report = validate_dataset(manifest_path)
        assert "fidelity-label" in {finding.check for finding in report.findings}


class TestRetentionReceiptVersions:
    def _receipt(self, version: int, deleted: list) -> dict:
        manifest_bytes = V2.read_bytes()
        receipt = {
            "retentionReceiptFormatId": "polymarket-bot/retention-receipt/v1",
            "retentionReceiptVersion": version,
            "datasetId": _document(V2)["datasetId"],
            "datasetManifestObjectKey": "datasets/ds-fixture-v2/manifest.json",
            "datasetManifestSha256": hashlib.sha256(manifest_bytes).hexdigest(),
        }
        if version == 2:
            receipt.update({"expiryPlanId": None, "expiryPlanSha256": None})
        receipt.update(
            {
                "walRetentionPolicy": "delete-after-verified-upload",
                "completedAt": "2026-01-01T12:00:00.000Z",
                "deletedSegments": deleted,
                "retentionFailures": [],
            }
        )
        return receipt

    def _deleted(self, basis: str | None) -> list:
        segment = _document(V2)["segments"][0]
        obj = next(o for o in _document(V2)["objects"] if o["objectKey"] == segment["objectKey"])
        entry = {
            "segmentId": segment["segmentId"],
            "verifiedObjectKey": segment["objectKey"],
            "verifiedObjectSha256": obj["sha256"],
        }
        if basis is not None:
            entry = {"basis": basis, **entry}
        return [entry]

    @pytest.mark.parametrize("version,basis", [(1, None), (2, "verified-upload")])
    def test_version_1_and_version_2_receipts_read(self, tmp_path: Path, version: int, basis) -> None:
        root = _copy_tree(tmp_path)
        manifest_path = root / "datasets" / "ds-fixture-v2" / "manifest.json"
        _document(manifest_path)
        receipt = self._receipt(version, self._deleted(basis))
        (manifest_path.parent / "retention-receipt.json").write_text(json.dumps(receipt), encoding="utf-8")
        report = validate_dataset(manifest_path)
        assert report.ok, [f"{f.check}: {f.message}" for f in report.findings]

    def test_a_dataset_receipt_cannot_report_an_expired_after_extract_deletion(self, tmp_path: Path) -> None:
        root = _copy_tree(tmp_path)
        manifest_path = root / "datasets" / "ds-fixture-v2" / "manifest.json"
        receipt = self._receipt(2, self._deleted("expired-after-extract"))
        (manifest_path.parent / "retention-receipt.json").write_text(json.dumps(receipt), encoding="utf-8")
        report = validate_dataset(manifest_path)
        assert not report.ok
        assert any("verified-upload deletions only" in finding.message for finding in report.findings)
