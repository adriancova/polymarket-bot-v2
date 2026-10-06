"""Protocol V2 position ids in the research-tier manifest reader (``V2-2``;
migration plan row A16, acceptance 5).

``docs/venue/protocol-v2-migration-plan.md`` row A16 names this reader,
``python/research/compaction/manifest.py`` (``polymarket_token_ids``), which
reads ids "as opaque decimal strings": "V2 ids are decimal strings of 75
digits (F-44), which these readers already accept (INF). Prove with a V2
fixture". This module is that proof for the Python reader. It changes nothing
in the reader.

The ids are ``VENUE-4``'s captures (``test/fixtures/venue/protocol-v2/``,
facts in ``docs/venue/verified-2026-10-05.md``):

- ``clob-markets-v2.jsonc``: the CLOB record of one V2 market (S-L01). Its two
  position ids have 75 digits, which is every V2 id observed (F-44);
- ``clob-markets-v1.jsonc``: the CLOB record of one V1 ``btc-15m-updown``
  window (S-L10). Its token ids have 77 and 78 digits (F-44 cites the same
  pair from Gamma, S-G04).

A V2 position id is 32 bytes whose FIRST byte names the owning module and
whose last byte is the outcome (S-D11 lines 122-126, quoted under F-42). The
observed module is ``1``, which gives 75 digits; other module bytes give 76,
77 or 78 digits. Those lengths are not observed, so the ids that carry them
below are SYNTHETIC: the observed id with only its module byte replaced.

The manifest lists ids sorted by UTF-16 code unit, as the TypeScript writer
emits them (JavaScript's default string order). For ASCII digits that is
string order, not numeric order: the 78-digit V1 id ``1116…`` sorts FIRST and
the 75-digit V2 ids ``6635…`` sort LAST. A reader that compared the ids as
numbers, or assumed V1's width, would refuse a mixed V1 and V2 segment that
the writer produced. Unsorted lists are still refused, exactly as before.
"""

from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path

import pytest

from research.compaction import validate_dataset
from research.compaction.manifest import (
    ManifestError,
    ResearchTierManifest,
    _identity_list,
    _market_identities,
    parse_any_manifest,
)

REPOSITORY_ROOT = Path(__file__).resolve().parents[4]
PROTOCOL_V2 = REPOSITORY_ROOT / "test" / "fixtures" / "venue" / "protocol-v2"
FIXTURE_ROOT = Path(__file__).resolve().parent.parent / "testdata"
RESEARCH = next((FIXTURE_ROOT / "research").rglob("manifest.json"), None)
WHERE = "sourceSegment.marketIdentities"


def _capture(stem: str) -> dict:
    """A ``VENUE-4`` capture, read as strict JSON (the fixtures' README).

    ``V2-9`` plans to rename these captures from ``.jsonc`` to ``.json``, so
    either name is read. A missing capture fails: it never skips.
    """
    for suffix in (".jsonc", ".json"):
        path = PROTOCOL_V2 / f"{stem}{suffix}"
        if path.is_file():
            return json.loads(path.read_text(encoding="utf-8"))
    raise AssertionError(f"the VENUE-4 capture {stem!r} is missing under {PROTOCOL_V2}")


V2_MARKET = _capture("clob-markets-v2")
V1_MARKET = _capture("clob-markets-v1")
V2_YES, V2_NO = (entry["t"] for entry in V2_MARKET["t"])
V1_YES, V1_NO = (entry["t"] for entry in V1_MARKET["t"])

#: The four captured ids in the writer's order, spelled out rather than
#: computed: V1 "Down" (78 digits), V1 "Up" (77), V2 "Up" (75), V2 "Down" (75).
CAPTURED_SORTED = [V1_NO, V1_YES, V2_YES, V2_NO]


def _with_module(position_id: str, module: int) -> str:
    """SYNTHETIC: ``position_id`` with its first byte (the module) replaced."""
    low_bits = int(position_id) & ((1 << 248) - 1)
    return str((module << 248) | low_bits)


#: SYNTHETIC ids of every V2 length, one per module byte: 1 (the observed
#: module), 4, 32 and 255. Each keeps the observed id's low 31 bytes.
SYNTHETIC_BY_LENGTH = {
    75: _with_module(V2_YES, 1),
    76: _with_module(V2_YES, 4),
    77: _with_module(V2_YES, 32),
    78: _with_module(V2_YES, 255),
}


def _inventory(token_ids: list[str]) -> dict:
    return {
        "polymarketTokenIds": token_ids,
        "conditionIds": [],
        "gammaMarketIds": [],
        "unidentifiedFrames": 0,
    }


class TestTheCaptures:
    """Non-vacuity: the ids below are the ones the facts describe."""

    def test_the_v2_ids_are_75_digit_decimals_and_the_v1_ids_77_and_78(self) -> None:
        assert V2_MARKET["v"] == "v2" and V1_MARKET["v"] == "v1"
        for position_id in (V2_YES, V2_NO):
            assert position_id.isascii() and position_id.isdecimal()
            assert len(position_id) == 75
        assert (len(V1_YES), len(V1_NO)) == (77, 78)

    def test_the_writers_order_is_string_order_and_not_numeric_order(self) -> None:
        assert sorted(CAPTURED_SORTED) == CAPTURED_SORTED
        assert [len(position_id) for position_id in CAPTURED_SORTED] == [78, 77, 75, 75]
        # Numerically, the 75-digit V2 ids are the smallest: the order is reversed.
        assert sorted(CAPTURED_SORTED, key=int) == [V2_YES, V2_NO, V1_YES, V1_NO]

    def test_the_synthetic_ids_span_75_to_78_digits_and_keep_the_layout(self) -> None:
        assert SYNTHETIC_BY_LENGTH[75] == V2_YES
        for length, position_id in SYNTHETIC_BY_LENGTH.items():
            assert len(position_id) == length
            assert int(position_id) < 1 << 256
            # The outcome byte is untouched: 0, the YES outcome (F-42).
            assert int(position_id) & 0xFF == 0


class TestIdentityList:
    """``_identity_list``: the check every ``marketIdentities`` list passes."""

    def test_the_sorted_v1_and_v2_ids_are_accepted_verbatim(self) -> None:
        where = f"{WHERE}.polymarketTokenIds"
        assert _identity_list(CAPTURED_SORTED, where) == tuple(CAPTURED_SORTED)

    def test_the_v2_pair_alone_is_accepted(self) -> None:
        where = f"{WHERE}.polymarketTokenIds"
        assert _identity_list([V2_YES, V2_NO], where) == (V2_YES, V2_NO)

    def test_sorted_ids_of_every_v2_length_are_accepted(self) -> None:
        ids = sorted([*SYNTHETIC_BY_LENGTH.values(), V2_NO, V1_YES, V1_NO])
        assert {len(position_id) for position_id in ids} == {75, 76, 77, 78}
        assert _identity_list(ids, f"{WHERE}.polymarketTokenIds") == tuple(ids)

    @pytest.mark.parametrize(
        "label, ids",
        [
            ("reversed", list(reversed(CAPTURED_SORTED))),
            ("numeric order", sorted(CAPTURED_SORTED, key=int)),
            ("the V2 pair swapped", [V2_NO, V2_YES]),
            ("a V2 id twice", [V1_NO, V2_YES, V2_YES]),
            # Shortest first is numeric order here; string order is the reverse.
            ("every V2 length, shortest first", sorted(SYNTHETIC_BY_LENGTH.values(), key=len)),
        ],
    )
    def test_unsorted_or_repeated_ids_are_refused(self, label: str, ids: list[str]) -> None:
        assert sorted(set(ids)) != ids, label
        with pytest.raises(ManifestError, match=r"polymarketTokenIds: must be sorted and unique"):
            _identity_list(ids, f"{WHERE}.polymarketTokenIds")


class TestMarketIdentities:
    """``_market_identities``: the ``marketIdentities`` object of one segment."""

    def test_it_carries_the_sorted_ids_as_polymarket_token_ids(self) -> None:
        identities = _market_identities(_inventory(CAPTURED_SORTED), WHERE)
        assert identities.polymarket_token_ids == tuple(CAPTURED_SORTED)
        assert identities.unidentified_frames == 0

    def test_it_refuses_them_unsorted_and_names_the_field(self) -> None:
        with pytest.raises(
            ManifestError,
            match=r"^sourceSegment\.marketIdentities\.polymarketTokenIds: must be sorted and unique$",
        ):
            _market_identities(_inventory(list(reversed(CAPTURED_SORTED))), WHERE)


def _document(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _with_inventory(document: dict, token_ids: list[str]) -> dict:
    """The committed research-tier manifest with a V1 and V2 market inventory on every segment."""
    for segment in document["sourceSegments"]:
        segment["marketIdentities"].update(
            {
                "polymarketTokenIds": token_ids,
                # The CLOB's 32-byte forms of both conditions (S-L01, S-L10), in string order.
                "conditionIds": sorted([V2_MARKET["c"], V1_MARKET["c"]]),
            }
        )
    return document


@pytest.mark.skipif(RESEARCH is None, reason="the research-tier fixture is absent")
class TestTheResearchTierManifest:
    """The public path: ``parse_any_manifest`` and ``validate_dataset`` on the
    committed research-tier manifest (``test_storage1_versions.py``'s fixture),
    its inventory replaced by the captured ids."""

    def test_the_committed_inventory_is_empty_so_this_is_not_vacuous(self) -> None:
        assert RESEARCH is not None
        for segment in _document(RESEARCH)["sourceSegments"]:
            assert segment["marketIdentities"]["polymarketTokenIds"] == []

    def test_it_reads_the_v1_and_v2_ids_verbatim(self) -> None:
        assert RESEARCH is not None
        manifest = parse_any_manifest(_with_inventory(_document(RESEARCH), CAPTURED_SORTED))
        assert isinstance(manifest, ResearchTierManifest)
        assert manifest.source_segments
        for segment in manifest.source_segments:
            assert segment.market_identities.polymarket_token_ids == tuple(CAPTURED_SORTED)
            assert segment.market_identities.condition_ids == (V2_MARKET["c"], V1_MARKET["c"])

    def test_it_refuses_them_unsorted(self) -> None:
        assert RESEARCH is not None
        document = _with_inventory(_document(RESEARCH), sorted(CAPTURED_SORTED, key=int))
        with pytest.raises(ManifestError, match="polymarketTokenIds: must be sorted and unique"):
            parse_any_manifest(document)

    def test_the_validator_accepts_the_dataset_end_to_end(self, tmp_path: Path) -> None:
        assert RESEARCH is not None
        root = tmp_path / "testdata"
        shutil.copytree(FIXTURE_ROOT, root)
        manifest_path = root / RESEARCH.relative_to(FIXTURE_ROOT)
        document = _with_inventory(_document(manifest_path), CAPTURED_SORTED)
        data = (json.dumps(document, indent=2) + "\n").encode("utf-8")
        manifest_path.write_bytes(data)
        (manifest_path.parent / "manifest.sha256").write_text(
            hashlib.sha256(data).hexdigest() + "\n", encoding="utf-8"
        )
        report = validate_dataset(manifest_path)
        assert report.ok, [f"{f.check}: {f.message}" for f in report.findings]
        assert report.rows_checked > 0
