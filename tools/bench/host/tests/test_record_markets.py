"""Offline checks of record_markets.py: the command line, the Gamma query and
its failure handling, the raw writer, the connection loop (reconnect, stale
PONG, re-subscribe, rollover) and the supervised run.

`websockets` is imported only when no stand-in `connect` is given, so these
run on the standard library alone. No network is used: the Gamma fetch is
stubbed and the WebSocket is `FakeSocket`.
"""

from __future__ import annotations

import argparse
import asyncio
import gzip
import http.client
import json
import os
import signal
import sys
import tempfile
import threading
import time
import unittest
import urllib.parse
from pathlib import Path
from types import SimpleNamespace
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
            events, truncated = rm.fetch_events(now, 2400, 30)
        self.assertEqual(len(events), rm.GAMMA_PAGE_LIMIT + 1)
        self.assertFalse(truncated)
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
                "order": "id",
                "ascending": "true",
                "limit": str(rm.GAMMA_PAGE_LIMIT),
                "offset": str(rm.GAMMA_PAGE_LIMIT),
            },
        )

    def test_the_page_cap_is_reported_as_truncation(self) -> None:
        full = [{"id": str(i)} for i in range(rm.GAMMA_PAGE_LIMIT)]
        with mock.patch.object(rm, "_get_json", return_value=full) as get:
            events, truncated = rm.fetch_events(0.0, 60, 0)
        self.assertTrue(truncated)
        self.assertEqual(get.call_count, rm.GAMMA_MAX_PAGES)
        self.assertEqual(len(events), rm.GAMMA_MAX_PAGES * rm.GAMMA_PAGE_LIMIT)

    def test_a_non_array_page_is_an_error(self) -> None:
        with mock.patch.object(rm, "_get_json", return_value={"error": "x"}), self.assertRaises(ValueError):
            rm.fetch_events(0.0, 60, 0)


# ---------------------------------------------------------------------------
# Live-loop checks on stand-ins: a fake WebSocket and a stubbed Gamma fetch.
# ---------------------------------------------------------------------------

SERIES = "btc-up-or-down-5m"
CONDITION = "0x" + "ab" * 32
TOKENS = ("1001", "1002")


def synthetic_events(now: float) -> list[dict]:
    """A current and a next 5-minute window of one series, around `now`, in the
    documented /events shape (clobTokenIds as a JSON-encoded string). Each
    market carries `"version": "v1"`, as every V1 market the venue serves does
    (V2-2: the recorder chooses the id field by it, and refuses a market
    without it)."""
    start = now - 60

    def market(condition: str, begin: float, tokens: tuple[str, str]) -> dict:
        return {
            "id": condition[-6:],
            "conditionId": condition,
            "eventStartTime": core.iso(begin),
            "endDate": core.iso(begin + 300),
            "clobTokenIds": json.dumps(list(tokens)),
            "outcomes": json.dumps(["Up", "Down"]),
            "closed": False,
            "version": "v1",
        }

    return [
        {"seriesSlug": SERIES, "slug": "btc-updown-5m-a", "markets": [market(CONDITION, start, TOKENS)]},
        {"seriesSlug": SERIES, "slug": "btc-updown-5m-b", "markets": [market("0x" + "cd" * 32, start + 300, ("2001", "2002"))]},
    ]


class FakeSocket:
    """Async-iterable like a websockets connection. Answers PING with PONG when
    `answer_ping`; after the first subscribe frame it emits a price_change
    frame for CONDITION every 50 ms until closed."""

    def __init__(self, answer_ping: bool = True) -> None:
        self.answer_ping = answer_ping
        self.sent: list[str] = []
        self.queue: asyncio.Queue = asyncio.Queue()
        self.closed = False
        self._emitter: asyncio.Task | None = None

    async def send(self, text: str) -> None:
        self.sent.append(text)
        if text == "PING":
            if self.answer_ping:
                self.queue.put_nowait("PONG")
        elif self._emitter is None:
            self._emitter = asyncio.create_task(self._emit())

    async def _emit(self) -> None:
        body = json.dumps({"event_type": "price_change", "market": CONDITION, "price_changes": [{}, {}]})
        while not self.closed:
            self.queue.put_nowait(body)
            await asyncio.sleep(0.05)

    async def close(self) -> None:
        if not self.closed:
            self.closed = True
            self.queue.put_nowait(None)
        if self._emitter is not None:
            self._emitter.cancel()

    def __aiter__(self) -> "FakeSocket":
        return self

    async def __anext__(self) -> str:
        item = await self.queue.get()
        if item is None:
            raise StopAsyncIteration
        return item


class FakeConnect:
    """Stands in for websockets' `connect`: records each call's URL and options."""

    def __init__(self, answer_ping=(True,), fail: BaseException | None = None) -> None:
        self.answer_ping = list(answer_ping)
        self.fail = fail
        self.calls: list[tuple[str, dict]] = []
        self.sockets: list[FakeSocket] = []

    def __call__(self, url: str, **options):
        self.calls.append((url, options))
        if self.fail is not None:
            raise self.fail
        index = len(self.sockets)
        socket = FakeSocket(self.answer_ping[min(index, len(self.answer_ping) - 1)])
        self.sockets.append(socket)
        return _Context(socket)


class _Context:
    def __init__(self, socket: FakeSocket) -> None:
        self.socket = socket

    async def __aenter__(self) -> FakeSocket:
        return self.socket

    async def __aexit__(self, *exc) -> bool:
        await self.socket.close()
        return False


async def wait_for(predicate, timeout_s: float = 5.0) -> None:
    deadline = time.monotonic() + timeout_s
    while not predicate():
        if time.monotonic() > deadline:
            raise AssertionError("condition not reached in time")
        await asyncio.sleep(0.01)


def fake_recorder() -> SimpleNamespace:
    return SimpleNamespace(log=lambda message: None, stats=core.Stats(), registry={}, raw=rm.RawWriter(None, 6))


class ConnectionLoop(unittest.TestCase):
    def test_stale_pong_closes_reconnects_resubscribes_and_rolls(self) -> None:
        connect = FakeConnect(answer_ping=(False, True))
        recorder = fake_recorder()
        connection = rm.SeriesConnection(SERIES, recorder, connect)
        connection.ping_interval_s = 0.02
        connection.pong_timeout_s = 0.1

        async def scenario() -> None:
            stop = asyncio.Event()
            connection.set_desired({"a", "b"})
            task = asyncio.create_task(connection.run(stop))
            await wait_for(lambda: len(connect.sockets) == 2 and connect.sockets[1].sent)
            # A rollover on the live connection: one subscribe and one unsubscribe frame.
            connection.set_desired({"b", "c"})
            await wait_for(lambda: connection.unsubscribe_updates == 1)
            await wait_for(lambda: recorder.stats.control.get(SERIES, [0])[0] >= 1)
            stop.set()
            await asyncio.wait_for(task, 5)

        with mock.patch.object(rm.core, "backoff_delay", return_value=0.01):
            asyncio.run(scenario())
        self.assertEqual(connection.stale_closes, 1)
        self.assertEqual(connection.disconnects, 1)
        self.assertEqual(connection.close_reasons, {"TimeoutError": 1})
        self.assertEqual(connection.connects, 2)
        url, options = connect.calls[0]
        self.assertEqual(url, "wss://ws-subscriptions-clob.polymarket.com/ws/market")
        self.assertIsNone(options["compression"])
        self.assertIsNone(options["ping_interval"])
        subscribe = json.dumps(core.subscribe_frame({"a", "b"}))
        for socket in connect.sockets:
            self.assertEqual(socket.sent[0], subscribe)  # the full set again after the reconnect
            self.assertIn("PING", socket.sent)
        second = connect.sockets[1].sent
        self.assertIn(json.dumps(core.update_frame("subscribe", ["c"])), second)
        self.assertIn(json.dumps(core.update_frame("unsubscribe", ["a"])), second)
        self.assertEqual(connection.subscribed, set())  # cleared once the connection ended
        self.assertGreater(recorder.stats.markets[CONDITION].counts[core.EVENTS], 0)

    def test_failed_connects_back_off_with_a_growing_attempt(self) -> None:
        connect = FakeConnect(fail=OSError("unreachable"))
        connection = rm.SeriesConnection(SERIES, fake_recorder(), connect)

        async def scenario() -> None:
            stop = asyncio.Event()
            connection.set_desired({"a"})
            task = asyncio.create_task(connection.run(stop))
            await wait_for(lambda: len(connect.calls) >= 4)
            stop.set()
            await asyncio.wait_for(task, 5)

        with mock.patch.object(rm.core, "backoff_delay", return_value=0.001) as backoff:
            asyncio.run(scenario())
        attempts = [call.args[0] for call in backoff.call_args_list]
        self.assertEqual(attempts[:4], [0, 1, 2, 3])
        self.assertEqual(connection.connects, 0)
        self.assertGreaterEqual(connection.close_reasons["OSError"], 3)


def recorder_args(out_dir: str, **overrides) -> argparse.Namespace:
    values = {
        "out_dir": out_dir,
        "series": [SERIES],
        "next_windows": 1,
        "linger_seconds": 30.0,
        "gamma_poll_seconds": 0.3,
        "horizon_seconds": 2400.0,
        "summary_every_seconds": 1.0,
        "duration_seconds": 2.5,
        "raw": False,
        "raw_gzip_level": 6,
        "quiet": True,
        "connect": FakeConnect(),
    }
    values.update(overrides)
    return argparse.Namespace(**values)


def close_files(recorder: rm.Recorder) -> None:
    recorder.per_second.close()
    recorder.windows_log.close()
    recorder.log.close()


def per_second_rows(out: Path) -> list[dict]:
    with gzip.open(out / "per-second.jsonl.gz", "rt", encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


class GammaPolling(unittest.TestCase):
    def test_every_failure_kind_is_counted_and_discovery_goes_on(self) -> None:
        now = time.time()
        failures = [
            http.client.IncompleteRead(b"partial"),
            json.JSONDecodeError("Expecting value", "", 0),
            RuntimeError("anything else"),
        ]
        with tempfile.TemporaryDirectory() as tmp:
            recorder = rm.Recorder(recorder_args(tmp))
            try:
                with mock.patch.object(rm, "fetch_events", side_effect=[*failures, (synthetic_events(now), False)]):
                    results = [asyncio.run(recorder.poll_gamma()) for _ in range(4)]
                self.assertEqual(results, [False, False, False, True])
                self.assertEqual(recorder.gamma_failures, 3)
                self.assertEqual(recorder.gamma_failure_kinds, {"IncompleteRead": 1, "JSONDecodeError": 1, "RuntimeError": 1})
                self.assertEqual(recorder.gamma_max_consecutive_failures, 3)
                self.assertEqual(recorder.gamma_consecutive_failures, 0)
                self.assertIn(CONDITION, recorder.known)
                summary = recorder.summary(time.time(), final=False)["gamma"]
                self.assertEqual(summary["failures"], 3)
                self.assertEqual(summary["maxConsecutiveFailures"], 3)
                self.assertIsNotNone(summary["secondsSinceLastOk"])
            finally:
                close_files(recorder)

    def test_a_truncated_poll_is_counted_and_logged(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            recorder = rm.Recorder(recorder_args(tmp))
            try:
                with mock.patch.object(rm, "fetch_events", return_value=(synthetic_events(time.time()), True)):
                    self.assertTrue(asyncio.run(recorder.poll_gamma()))
                self.assertEqual(recorder.gamma_truncated_polls, 1)
            finally:
                close_files(recorder)
            self.assertIn("gamma: TRUNCATED", (Path(tmp) / "recorder.log").read_text(encoding="utf-8"))


class RecorderRun(unittest.TestCase):
    def run_recorder(self, tmp: str, fetch, **overrides) -> tuple[int, dict, float]:
        recorder = rm.Recorder(recorder_args(tmp, **overrides))
        started = time.monotonic()
        with mock.patch.object(rm, "fetch_events", side_effect=fetch):
            status = asyncio.run(recorder.run())
        elapsed = time.monotonic() - started
        summary = json.loads((Path(tmp) / "summary.json").read_text(encoding="utf-8"))
        return status, summary, elapsed

    def test_a_clean_run_completes_and_the_per_second_file_reconciles(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            status, summary, _ = self.run_recorder(tmp, lambda *a: (synthetic_events(time.time()), False))
            self.assertEqual(status, 0)
            self.assertTrue(summary["final"])
            self.assertEqual(summary["outcome"], "complete")
            self.assertEqual(summary["failures"], [])
            self.assertGreaterEqual(summary["gamma"]["polls"], 2)
            self.assertEqual(summary["connections"][SERIES]["connects"], 1)
            rows = per_second_rows(Path(tmp))
            # Partial summaries ran every second; not one row may be missing or split.
            seconds = [row["t"] for row in rows]
            self.assertEqual(len(seconds), len(set(seconds)))
            self.assertEqual(sum(row["s"][SERIES][core.EVENTS] for row in rows), summary["all"]["events"])
            self.assertGreater(summary["all"]["events"], 10)
            peak = max(row["s"][SERIES][core.ENVELOPES] for row in rows)
            self.assertEqual(summary["perSeries"][SERIES]["peak1sEnvelopesPerSecond"], peak)

    def test_gamma_failures_mid_run_are_counted_and_do_not_end_discovery(self) -> None:
        polls = {"n": 0}

        def fetch(*args):
            polls["n"] += 1
            if polls["n"] == 1:
                return synthetic_events(time.time()), False
            raise http.client.IncompleteRead(b"cut")

        with tempfile.TemporaryDirectory() as tmp:
            status, summary, _ = self.run_recorder(tmp, fetch)
            self.assertEqual(status, 0)
            self.assertEqual(summary["outcome"], "complete")
            self.assertGreaterEqual(summary["gamma"]["failures"], 2)  # the loop kept polling
            self.assertEqual(set(summary["gamma"]["failureKinds"]), {"IncompleteRead"})
            self.assertEqual(summary["gamma"]["consecutiveFailuresNow"], summary["gamma"]["failures"])

    def test_a_dead_task_fails_the_run_at_once(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.object(rm.core, "backoff_delay", side_effect=OverflowError("int too large to convert to float")):
                status, summary, elapsed = self.run_recorder(
                    tmp,
                    lambda *a: (synthetic_events(time.time()), False),
                    connect=FakeConnect(fail=OSError("unreachable")),
                    duration_seconds=60.0,
                )
            self.assertEqual(status, 3)
            self.assertLess(elapsed, 30.0)  # stopped at once, not at the 60 s deadline
            self.assertTrue(summary["final"])
            self.assertEqual(summary["outcome"], "failed")
            self.assertEqual([f["task"] for f in summary["failures"]], [f"connection {SERIES}"])
            self.assertTrue(summary["failures"][0]["error"].startswith("OverflowError"))
            self.assertIn("FAILED", (Path(tmp) / "recorder.log").read_text(encoding="utf-8"))

    def test_sigterm_ends_the_run_as_interrupted(self) -> None:
        timer = threading.Timer(1.5, os.kill, (os.getpid(), signal.SIGTERM))
        with tempfile.TemporaryDirectory() as tmp:
            timer.start()
            try:
                status, summary, elapsed = self.run_recorder(
                    tmp, lambda *a: (synthetic_events(time.time()), False), duration_seconds=60.0
                )
            finally:
                timer.cancel()
            self.assertEqual(status, 0)
            self.assertLess(elapsed, 30.0)
            self.assertEqual(summary["outcome"], "interrupted")


class FlushThreshold(unittest.TestCase):
    def test_flush_writes_only_seconds_two_behind_now(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            recorder = rm.Recorder(recorder_args(tmp))
            for second in (1002, 1003, 1004, 1005):
                recorder.stats.record_frame(second + 0.5, SERIES, '{"event_type":"book","market":"m"}', {})
            recorder.flush_seconds(1005.3)
            self.assertEqual(sorted(recorder.stats.seconds), [1003, 1004, 1005])
            close_files(recorder)
            self.assertEqual([row["t"] for row in per_second_rows(Path(tmp))], [1002])


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


# ---------------------------------------------------------------------------
# Polymarket Protocol V2 (V2-2: plan row A15), end to end on stand-ins.
# ---------------------------------------------------------------------------

PROTOCOL_V2 = HERE.parents[3] / "test" / "fixtures" / "venue" / "protocol-v2"


def v2_session_inbound() -> list[str]:
    """Every inbound frame of VENUE-4's market-channel session on a V2 position
    id (S-W01), as the text the socket delivered: the `book` frame (an array,
    with its trailing newline), five `PONG`s and one `new_market`."""
    lines = (PROTOCOL_V2 / "ws-market-v2-session.jsonl").read_text(encoding="utf-8").splitlines()
    return [record["data"] for record in map(json.loads, filter(str.strip, lines)) if record["dir"] == "recv"]


def v2_canary() -> tuple[str, tuple[str, str]]:
    """The V2 canary's condition id in its 31-byte form, and its position ids
    (S-L01: `t[0]` Up, `t[1]` Down; index 0 is YES, F-40)."""
    record = json.loads((PROTOCOL_V2 / "clob-markets-v2.jsonc").read_text(encoding="utf-8"))
    assert record["c"].endswith("00")
    return record["c"][:-2], (record["t"][0]["t"], record["t"][1]["t"])


def v2_events(now: float) -> list[dict]:
    """A current V2 window of SERIES in the documented V2 Gamma shape (F-40):
    `version` "v2", `clobTokenIds` null, `positionIds` an array, the condition
    id in its 31-byte form. Gamma lists no canary market (O.1), so this record
    is SYNTHETIC apart from the canary's ids."""
    condition, ids = v2_canary()
    return [
        {
            "seriesSlug": SERIES,
            "slug": "btc-updown-5m-v2-canary",
            "markets": [
                {
                    "id": "v2-canary",
                    "version": "v2",
                    "conditionId": condition,
                    "eventStartTime": core.iso(now - 60),
                    "endDate": core.iso(now + 240),
                    "outcomes": json.dumps(["Up", "Down"]),
                    "clobTokenIds": None,
                    "positionIds": list(ids),
                    "closed": False,
                }
            ],
        }
    ]


class ReplaySocket:
    """Delivers a fixed list of inbound frames once, after the first frame the
    recorder sends (its subscription), then stays silent until closed."""

    def __init__(self, frames: list[str]) -> None:
        self.frames = list(frames)
        self.sent: list[str] = []
        self.queue: asyncio.Queue = asyncio.Queue()
        self.closed = False

    async def send(self, text: str) -> None:
        self.sent.append(text)
        if len(self.sent) == 1:
            for frame in self.frames:
                self.queue.put_nowait(frame)

    async def close(self) -> None:
        if not self.closed:
            self.closed = True
            self.queue.put_nowait(None)

    def __aiter__(self) -> "ReplaySocket":
        return self

    async def __anext__(self) -> str:
        item = await self.queue.get()
        if item is None:
            raise StopAsyncIteration
        return item


class ReplayConnect:
    def __init__(self, frames: list[str]) -> None:
        self.frames = frames
        self.sockets: list[ReplaySocket] = []

    def __call__(self, url: str, **options):
        socket = ReplaySocket(self.frames)
        self.sockets.append(socket)
        return _Context(socket)


def raw_frames(directory: Path) -> list[str]:
    texts: list[str] = []
    for path in sorted(directory.glob("*.jsonl.gz")):
        with gzip.open(path, "rt", encoding="utf-8") as handle:
            texts.extend(json.loads(line)["p"] for line in handle if line.strip())
    return texts


class ProtocolV2Recording(unittest.TestCase):
    def test_a_v2_window_is_subscribed_by_its_position_ids_and_its_frames_journaled_verbatim(self) -> None:
        inbound = v2_session_inbound()
        self.assertEqual(len(inbound), 7)
        self.assertTrue(inbound[0].endswith("]\n"))  # the frame text exactly as received, newline included
        condition, ids = v2_canary()
        connect = ReplayConnect(inbound)
        with tempfile.TemporaryDirectory() as tmp:
            recorder = rm.Recorder(recorder_args(tmp, raw=True, connect=connect, duration_seconds=1.5))
            with mock.patch.object(rm, "fetch_events", side_effect=lambda *a: (v2_events(time.time()), False)):
                status = asyncio.run(recorder.run())
            # 2 would mean "Gamma lists no window of the wanted series": the V2 window was skipped.
            self.assertEqual(status, 0)
            out = Path(tmp)
            summary = json.loads((out / "summary.json").read_text(encoding="utf-8"))
            journaled = raw_frames(out / "raw" / SERIES)
            added = [json.loads(line) for line in (out / "windows.jsonl").read_text(encoding="utf-8").splitlines()]

        self.assertEqual(summary["outcome"], "complete")
        self.assertEqual(summary["gamma"]["skipped"], {})
        # Subscribed by the ids `version` selects: the V2 position ids (F-38).
        self.assertEqual(len(connect.sockets), 1)
        self.assertEqual(json.loads(connect.sockets[0].sent[0]), core.subscribe_frame(ids))
        self.assertEqual(added[0]["tokenIds"], list(ids))
        self.assertEqual(added[0]["conditionId"], condition)
        # Journaled verbatim: every inbound frame, in order, character for character.
        self.assertEqual(journaled, inbound)
        self.assertEqual(summary["rawFrames"]["rawTextBytes"], sum(len(text.encode("utf-8")) for text in inbound))
        # Counted against the window, though the frame names the 32-byte form of its condition (F-43, F-62).
        rows = {row["conditionId"]: row for row in summary["windows"]}
        self.assertEqual(rows[condition]["eventTypes"], {"book": 1})
        self.assertEqual(summary["control"]["pongFrames"], 5)
        self.assertEqual(summary["control"]["unparsableFrames"], 0)


if __name__ == "__main__":
    unittest.main()
