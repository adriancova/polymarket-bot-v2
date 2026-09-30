"""Offline checks of record_markets.py's command line, Gamma query and raw writer.

`websockets` is imported only inside the connection loop, so these run on the
standard library alone. No network is used: the Gamma fetch is stubbed.
"""

from __future__ import annotations

import gzip
import json
import sys
import tempfile
import unittest
import urllib.parse
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import record_markets as rm  # noqa: E402
import recorder_core as core  # noqa: E402


class CommandLine(unittest.TestCase):
    def test_defaults(self) -> None:
        args = rm.parse_arguments(["--out-dir", "x"])
        self.assertEqual(args.series, list(core.DEFAULT_SERIES))
        self.assertEqual(args.duration_seconds, 86400.0)
        self.assertEqual(args.gamma_poll_seconds, 60.0)
        self.assertFalse(args.raw)

    def test_overrides(self) -> None:
        args = rm.parse_arguments(["--out-dir", "x", "--series", "a-up-or-down-5m, b", "--duration-hours", "0.5", "--raw"])
        self.assertEqual(args.series, ["a-up-or-down-5m", "b"])
        self.assertEqual(args.duration_seconds, 1800.0)
        self.assertTrue(args.raw)

    def test_refuses_a_fast_gamma_poll(self) -> None:
        with mock.patch("sys.stderr"), self.assertRaises(SystemExit):
            rm.parse_arguments(["--out-dir", "x", "--gamma-poll-seconds", "1"])

    def test_requires_an_out_dir(self) -> None:
        with mock.patch("sys.stderr"), self.assertRaises(SystemExit):
            rm.parse_arguments([])


class GammaQuery(unittest.TestCase):
    def test_documented_parameters_and_pagination(self) -> None:
        urls: list[str] = []
        pages = [[{"id": str(i)} for i in range(rm.GAMMA_PAGE_LIMIT)], [{"id": "last"}]]

        def fake_get(url: str, timeout_s: float = 15.0):
            urls.append(url)
            return pages[len(urls) - 1]

        now = core.parse_iso("2026-09-30T11:30:00Z")
        with mock.patch.object(rm, "_get_json", side_effect=fake_get):
            events = rm.fetch_events(now, 2400, 30)
        self.assertEqual(len(events), rm.GAMMA_PAGE_LIMIT + 1)
        self.assertEqual(len(urls), 2)
        parsed = urllib.parse.urlparse(urls[1])
        self.assertEqual(f"{parsed.scheme}://{parsed.netloc}{parsed.path}", "https://gamma-api.polymarket.com/events")
        query = dict(urllib.parse.parse_qsl(parsed.query))
        self.assertEqual(
            query,
            {
                "closed": "false",
                "end_date_min": "2026-09-30T11:29:30Z",
                "end_date_max": "2026-09-30T12:10:00Z",
                "limit": str(rm.GAMMA_PAGE_LIMIT),
                "offset": str(rm.GAMMA_PAGE_LIMIT),
            },
        )

    def test_a_non_array_page_is_an_error(self) -> None:
        with mock.patch.object(rm, "_get_json", return_value={"error": "x"}), self.assertRaises(ValueError):
            rm.fetch_events(0.0, 60, 0)


class RawFrames(unittest.TestCase):
    def test_hourly_gzip_files_round_trip(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            writer = rm.RawWriter(Path(tmp), level=6)
            t0 = core.parse_iso("2026-09-30T11:59:59Z")
            writer.write(t0, "btc-up-or-down-15m", '{"event_type":"book"}')
            writer.write(t0 + 2, "btc-up-or-down-15m", "PONG")
            writer.close()
            files = sorted(p.name for p in (Path(tmp) / "btc-up-or-down-15m").iterdir())
            self.assertEqual(files, ["20260930T11.jsonl.gz", "20260930T12.jsonl.gz"])
            with gzip.open(Path(tmp) / "btc-up-or-down-15m" / "20260930T12.jsonl.gz", "rt", encoding="utf-8") as handle:
                self.assertEqual(json.loads(handle.readline()), {"t": t0 + 2, "p": "PONG"})
            report = writer.report()
            self.assertEqual(report["rawTextBytes"], len('{"event_type":"book"}') + 4)
            self.assertGreater(report["gzipFileBytes"], 0)

    def test_disabled_writer_writes_nothing(self) -> None:
        writer = rm.RawWriter(None, level=6)
        writer.write(0.0, "s", "PONG")
        writer.close()
        self.assertIsNone(writer.report())


if __name__ == "__main__":
    unittest.main()
