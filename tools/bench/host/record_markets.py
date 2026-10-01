#!/usr/bin/env python3
"""HOST-BENCH multi-market recorder: public Polymarket market data only.

Discovers the current and next window of each wanted up/down series through
Gamma `GET /events`, subscribes to their tokens on the public market
WebSocket (one connection per series), rolls to each new window as it opens,
and counts frames, events and bytes per market per second. It never sends a
credential, and it never touches an order, wallet or account endpoint.

Every venue fact it relies on is cited in `recorder_core.py`'s docstring.

    python3 record_markets.py --out-dir DIR [--duration-hours 24] [--raw]
    python3 record_markets.py --list-series

Outputs in DIR (see README.md):
    summary.json            the final summary (summary.partial.json while running)
    per-second.jsonl.gz     one line per second: {"t": epoch, "s": {series: [frames, events, envelopes, bytes]}}
    windows.jsonl           every window the recorder subscribed, when it was added and removed
    recorder.log            connections, rollovers, Gamma polls, errors
    raw/<series>/<hour>.jsonl.gz   with --raw: every inbound text frame, {"t", "p"}

Exit status: 0 when the recording ran to its end or was interrupted (SIGINT,
SIGTERM); 2 when Gamma never answered or listed no wanted window at the start;
3 when a recorder task died or the main loop failed. `summary.json` then says
`"outcome": "failed"` and lists `failures`; the recording stops at once, so a
failure is never hidden behind a quiet 24 hours.
"""

from __future__ import annotations

import argparse
import asyncio
import gzip
import json
import os
import random
import signal
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

import recorder_core as core  # noqa: E402

USER_AGENT = "pmb-host-bench-recorder/1"
GAMMA_PAGE_LIMIT = 100
GAMMA_MAX_PAGES = 10
MAX_FRAME_BYTES = 32 * 1024 * 1024


class Log:
    def __init__(self, path: Path | None, echo: bool = True) -> None:
        self._file = open(path, "a", encoding="utf-8") if path is not None else None
        self._echo = echo

    def __call__(self, message: str) -> None:
        line = f"{core.iso(time.time())} {message}"
        if self._echo:
            print(line, file=sys.stderr, flush=True)
        if self._file is not None:
            self._file.write(line + "\n")
            self._file.flush()

    def close(self) -> None:
        if self._file is not None:
            self._file.close()


# ---------------------------------------------------------------------------
# Gamma
# ---------------------------------------------------------------------------


def _get_json(url: str, timeout_s: float = 15.0) -> Any:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout_s) as response:  # noqa: S310 (fixed https base URL)
        return json.load(response)


def fetch_events(now: float, horizon_s: float, linger_s: float) -> tuple[list[Any], bool]:
    """Open events whose end lies in [now - linger, now + horizon], all pages.

    Returns (events, truncated). Pages are ordered by event `id`, ascending
    (the documented `order` and `ascending` parameters), so offset paging is
    stable while new events are listed. `truncated` is True when the last page
    allowed (GAMMA_MAX_PAGES) was full, so more events may exist: the caller
    logs and counts it. On 2026-09-30 the 40-minute horizon held about 110
    events, two pages."""
    events: list[Any] = []
    for page in range(GAMMA_MAX_PAGES):
        query = urllib.parse.urlencode(
            {
                "closed": "false",
                "end_date_min": core.gamma_time(now - linger_s),
                "end_date_max": core.gamma_time(now + horizon_s),
                "order": "id",
                "ascending": "true",
                "limit": GAMMA_PAGE_LIMIT,
                "offset": page * GAMMA_PAGE_LIMIT,
            }
        )
        batch = _get_json(f"{core.GAMMA_BASE_URL}/events?{query}")
        if not isinstance(batch, list):
            raise ValueError("the /events response is not a JSON array")
        events.extend(batch)
        if len(batch) < GAMMA_PAGE_LIMIT:
            return events, False
    return events, True


# ---------------------------------------------------------------------------
# Raw frame writer
# ---------------------------------------------------------------------------


class RawWriter:
    """Hourly gzip JSONL files per series; counts raw and compressed bytes."""

    def __init__(self, root: Path | None, level: int) -> None:
        self.root = root
        self.level = level
        self._open: dict[str, tuple[str, Any, Path]] = {}
        self.raw_bytes = 0
        self.closed_compressed_bytes = 0

    def write(self, t: float, series: str, text: str) -> None:
        if self.root is None:
            return
        hour = time.strftime("%Y%m%dT%H", time.gmtime(t))
        current = self._open.get(series)
        if current is None or current[0] != hour:
            if current is not None:
                self._close(series)
            directory = self.root / series
            directory.mkdir(parents=True, exist_ok=True)
            path = directory / f"{hour}.jsonl.gz"
            self._open[series] = (hour, gzip.open(path, "at", encoding="utf-8", compresslevel=self.level), path)
        line = json.dumps({"t": round(t, 6), "p": text}, separators=(",", ":")) + "\n"
        self.raw_bytes += len(text.encode("utf-8"))
        self._open[series][1].write(line)

    def _close(self, series: str) -> None:
        _, handle, path = self._open.pop(series)
        handle.close()
        self.closed_compressed_bytes += path.stat().st_size

    def close(self) -> None:
        for series in list(self._open):
            self._close(series)

    def report(self) -> dict[str, Any] | None:
        if self.root is None:
            return None
        total = 0
        for path in self.root.rglob("*.jsonl.gz"):
            total += path.stat().st_size
        return {
            "rawTextBytes": self.raw_bytes,
            "gzipFileBytes": total,
            "gzipLevel": self.level,
            "note": "gzip of JSONL lines that wrap each frame with its receive time; see README for zstd",
        }


# ---------------------------------------------------------------------------
# One market WebSocket connection per series
# ---------------------------------------------------------------------------


class SeriesConnection:
    """One public market WebSocket for one series.

    `connect` is `websockets.asyncio.client.connect` unless a test passes a
    stand-in with the same call shape (an async context manager yielding a
    socket with `send`, `close` and async iteration)."""

    def __init__(self, series: str, recorder: "Recorder", connect: Any = None) -> None:
        self.series = series
        self.recorder = recorder
        self._connect = connect
        self.ping_interval_s = core.PING_INTERVAL_S
        self.pong_timeout_s = core.PONG_TIMEOUT_S
        self.desired: set[str] = set()
        self.subscribed: set[str] = set()
        self.ws: Any = None
        self.connects = 0
        self.disconnects = 0
        self.stale_closes = 0
        self.subscribe_updates = 0
        self.unsubscribe_updates = 0
        self.close_reasons: dict[str, int] = {}
        self.connected_since: float | None = None
        self.connected_seconds = 0.0
        self.wanted_seconds = 0.0
        self.last_pong = 0.0
        self.changed = asyncio.Event()

    def set_desired(self, tokens: set[str]) -> None:
        if tokens != self.desired:
            self.desired = set(tokens)
            self.changed.set()

    def report(self, now: float) -> dict[str, Any]:
        connected = self.connected_seconds + (now - self.connected_since if self.connected_since else 0.0)
        return {
            "connects": self.connects,
            "disconnects": self.disconnects,
            "staleCloses": self.stale_closes,
            "subscribeUpdates": self.subscribe_updates,
            "unsubscribeUpdates": self.unsubscribe_updates,
            "closeReasons": dict(sorted(self.close_reasons.items())),
            "connectedSeconds": round(connected, 3),
            "wantedSeconds": round(self.wanted_seconds, 3),
            "tokensSubscribedNow": len(self.subscribed),
        }

    async def run(self, stop: asyncio.Event) -> None:
        connect = self._connect
        if connect is None:
            from websockets.asyncio.client import connect  # imported here: the core stays stdlib-only

        log = self.recorder.log
        attempt = 0
        while not stop.is_set():
            if not self.desired:
                self.changed.clear()
                await _wait_any(stop, self.changed, timeout=1.0)
                continue
            started = time.monotonic()
            reason = "closed"
            try:
                async with connect(
                    core.MARKET_WS_URL,
                    compression=None,
                    ping_interval=None,
                    open_timeout=20,
                    close_timeout=5,
                    max_size=MAX_FRAME_BYTES,
                    max_queue=None,
                    user_agent_header=USER_AGENT,
                ) as ws:
                    self.ws = ws
                    self.connects += 1
                    self.connected_since = time.time()
                    self.last_pong = time.monotonic()
                    tokens = set(self.desired)
                    await ws.send(json.dumps(core.subscribe_frame(tokens)))
                    self.subscribed = tokens
                    log(f"{self.series}: connected; subscribed {len(tokens)} tokens")
                    reason = await self._session(ws, stop)
            except asyncio.CancelledError:
                raise
            except Exception as error:  # noqa: BLE001 (every failure reconnects)
                reason = f"{type(error).__name__}: {error}"[:200]
            finally:
                if self.connected_since is not None:
                    self.connected_seconds += time.time() - self.connected_since
                    self.connected_since = None
                self.ws = None
                self.subscribed = set()
            if stop.is_set():
                break
            self.disconnects += 1
            key = reason.split(":", 1)[0]
            self.close_reasons[key] = self.close_reasons.get(key, 0) + 1
            if time.monotonic() - started > 60:
                attempt = 0
            delay = core.backoff_delay(attempt, random.random())
            attempt += 1
            log(f"{self.series}: disconnected ({reason}); reconnecting in {delay:.2f} s")
            await _wait_any(stop, None, timeout=delay)

    async def _session(self, ws: Any, stop: asyncio.Event) -> str:
        receiver = asyncio.create_task(self._receive(ws))
        pinger = asyncio.create_task(self._ping(ws))
        stopper = asyncio.create_task(stop.wait())
        try:
            while True:
                # Clear BEFORE applying: a change made while a frame is being
                # sent sets the event again, so it is never lost.
                self.changed.clear()
                if not self.desired:
                    await ws.close()
                    return "no windows wanted"
                await self._apply_changes(ws)
                changed = asyncio.create_task(self.changed.wait())
                done, _ = await asyncio.wait(
                    {receiver, pinger, stopper, changed}, return_when=asyncio.FIRST_COMPLETED
                )
                if changed not in done:
                    changed.cancel()
                if stopper in done:
                    await ws.close()
                    return "stopped"
                for task in (receiver, pinger):
                    if task in done:
                        error = task.exception()
                        return f"{type(error).__name__}: {error}" if error else "closed by peer"
        finally:
            for task in (receiver, pinger, stopper):
                task.cancel()

    async def _apply_changes(self, ws: Any) -> None:
        add, remove = core.plan_subscription_change(self.subscribed, self.desired)
        target = set(self.desired)
        if add:
            await ws.send(json.dumps(core.update_frame("subscribe", add)))
            self.subscribe_updates += 1
        if remove:
            await ws.send(json.dumps(core.update_frame("unsubscribe", remove)))
            self.unsubscribe_updates += 1
        if add or remove:
            self.subscribed = target
            self.recorder.log(f"{self.series}: +{len(add)} -{len(remove)} tokens (now {len(self.subscribed)})")

    async def _receive(self, ws: Any) -> None:
        async for message in ws:
            t = time.time()
            text = message if isinstance(message, str) else message.decode("utf-8", "replace")
            decoded = self.recorder.stats.record_frame(t, self.series, text, self.recorder.registry)
            if decoded.kind == "pong":
                self.last_pong = time.monotonic()
            self.recorder.raw.write(t, self.series, text)

    async def _ping(self, ws: Any) -> None:
        while True:
            await asyncio.sleep(self.ping_interval_s)
            if time.monotonic() - self.last_pong > self.pong_timeout_s:
                self.stale_closes += 1
                raise TimeoutError(f"no PONG for {self.pong_timeout_s:g} s")
            await ws.send("PING")


async def _wait_any(stop: asyncio.Event, other: asyncio.Event | None, timeout: float) -> None:
    waiters = [asyncio.create_task(stop.wait())]
    if other is not None:
        waiters.append(asyncio.create_task(other.wait()))
    try:
        await asyncio.wait(waiters, timeout=timeout, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for waiter in waiters:
            waiter.cancel()


# ---------------------------------------------------------------------------
# The recorder
# ---------------------------------------------------------------------------


class Recorder:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.out = Path(args.out_dir)
        self.out.mkdir(parents=True, exist_ok=True)
        self.log = Log(self.out / "recorder.log", echo=not getattr(args, "quiet", False))
        self.stats = core.Stats(bucket_s=10)
        self.registry: dict[str, core.Window] = {}  # condition id -> window (every window seen)
        self.known: dict[str, core.Window] = {}  # condition id -> window still relevant
        self.active: dict[str, core.Window] = {}  # condition id -> window subscribed now
        self.raw = RawWriter(self.out / "raw" if args.raw else None, args.raw_gzip_level)
        connect = getattr(args, "connect", None)
        self.connections = {series: SeriesConnection(series, self, connect) for series in args.series}
        self.started_at = time.time()
        self.gamma_polls = 0
        self.gamma_failures = 0
        self.gamma_failure_kinds: dict[str, int] = {}
        self.gamma_consecutive_failures = 0
        self.gamma_max_consecutive_failures = 0
        self.gamma_truncated_polls = 0
        self.gamma_problems: dict[str, int] = {}
        self.last_gamma_ok: float | None = None
        self.outcome = "running"
        self.failures: list[dict[str, str]] = []
        self.interrupted = False
        self.per_second = gzip.open(self.out / "per-second.jsonl.gz", "at", encoding="utf-8")
        self.windows_log = open(self.out / "windows.jsonl", "a", encoding="utf-8")

    async def poll_gamma(self) -> bool:
        """One Gamma poll. Every failure is counted and logged, and the loop
        polls again next interval: `http.client.HTTPException` (for example
        `IncompleteRead`), `json.JSONDecodeError`, TLS and socket errors alike.
        Only cancellation propagates."""
        self.gamma_polls += 1
        now = time.time()
        try:
            events, truncated = await asyncio.to_thread(
                fetch_events, now, self.args.horizon_seconds, self.args.linger_seconds
            )
        except Exception as error:  # noqa: BLE001 (a failed poll must never end discovery)
            kind = type(error).__name__
            self.gamma_failures += 1
            self.gamma_failure_kinds[kind] = self.gamma_failure_kinds.get(kind, 0) + 1
            self.gamma_consecutive_failures += 1
            self.gamma_max_consecutive_failures = max(
                self.gamma_max_consecutive_failures, self.gamma_consecutive_failures
            )
            self.log(
                f"gamma: poll failed ({kind}: {error}); {self.gamma_consecutive_failures} in a row; "
                f"keeping {len(self.known)} known windows"
            )
            return False
        self.gamma_consecutive_failures = 0
        if truncated:
            self.gamma_truncated_polls += 1
            self.log(f"gamma: TRUNCATED: {GAMMA_MAX_PAGES} full pages of {GAMMA_PAGE_LIMIT}; later events not read")
        windows, problems = core.parse_gamma_events(events, self.args.series)
        for problem in problems:
            self.gamma_problems[problem] = self.gamma_problems.get(problem, 0) + 1
            self.log(f"gamma: skipped: {problem}")
        for window in windows:
            self.known[window.condition_id] = window
            self.registry[window.condition_id] = window
        horizon = now - 3600
        for condition in [c for c, w in self.known.items() if w.end < horizon]:
            del self.known[condition]
        self.last_gamma_ok = now
        return True

    async def gamma_loop(self, stop: asyncio.Event) -> None:
        """Refreshes the known windows once per poll interval, off the 1 s loop."""
        while not stop.is_set():
            await _wait_any(stop, None, timeout=self.args.gamma_poll_seconds)
            if not stop.is_set():
                await self.poll_gamma()

    def reconcile(self, now: float) -> None:
        chosen = core.select_windows(self.known.values(), now, self.args.next_windows, self.args.linger_seconds)
        wanted = {w.condition_id: w for w in chosen}
        for condition in sorted(set(wanted) - set(self.active)):
            window = wanted[condition]
            self.log(f"{window.series}: add window {window.describe()}")
            self._window_event("add", window, now)
        for condition in sorted(set(self.active) - set(wanted)):
            window = self.active[condition]
            self.log(f"{window.series}: remove window {window.describe()}")
            self._window_event("remove", window, now)
        self.active = wanted
        for series, connection in self.connections.items():
            connection.set_desired(core.tokens_of(w for w in chosen if w.series == series))
            if connection.desired:
                connection.wanted_seconds += 1.0

    def _window_event(self, action: str, window: core.Window, now: float) -> None:
        record = {"action": action, "at": core.iso(now), **window.as_json()}
        self.windows_log.write(json.dumps(record, separators=(",", ":")) + "\n")
        self.windows_log.flush()

    def flush_seconds(self, now: float) -> None:
        for second, row in self.stats.drain_seconds(int(now) - 2):
            self.per_second.write(json.dumps({"t": second, "s": row}, separators=(",", ":")) + "\n")

    def summary(self, now: float, final: bool) -> dict[str, Any]:
        # Every window that overlapped the recording (its open may precede it).
        seen = {c: w for c, w in self.registry.items() if w.end > self.started_at and w.start < now}
        try:
            import websockets

            ws_version = websockets.__version__
        except ImportError:  # pragma: no cover
            ws_version = None
        return core.summarize(
            self.stats,
            seen,
            self.args.series,
            self.started_at,
            now,
            extra={
                "final": final,
                "configuration": {
                    "series": list(self.args.series),
                    "nextWindows": self.args.next_windows,
                    "lingerSeconds": self.args.linger_seconds,
                    "gammaPollSeconds": self.args.gamma_poll_seconds,
                    "gammaHorizonSeconds": self.args.horizon_seconds,
                    "raw": bool(self.args.raw),
                    "marketWebSocket": core.MARKET_WS_URL,
                    "gammaBase": core.GAMMA_BASE_URL,
                    "customFeatureEnabled": False,
                    "initialDump": True,
                    "permessageDeflate": False,
                    "pingIntervalSeconds": core.PING_INTERVAL_S,
                    "pongTimeoutSeconds": core.PONG_TIMEOUT_S,
                },
                "runtime": {
                    "python": sys.version.split()[0],
                    "websockets": ws_version,
                },
                "outcome": self.outcome,
                "failures": list(self.failures),
                "gamma": {
                    "polls": self.gamma_polls,
                    "failures": self.gamma_failures,
                    "failureKinds": dict(sorted(self.gamma_failure_kinds.items())),
                    "consecutiveFailuresNow": self.gamma_consecutive_failures,
                    "maxConsecutiveFailures": self.gamma_max_consecutive_failures,
                    "truncatedPolls": self.gamma_truncated_polls,
                    "lastOk": None if self.last_gamma_ok is None else core.iso(self.last_gamma_ok),
                    "secondsSinceLastOk": None if self.last_gamma_ok is None else round(now - self.last_gamma_ok, 1),
                    "skipped": self.gamma_problems,
                },
                "connections": {s: c.report(now) for s, c in self.connections.items()},
                "rawFrames": self.raw.report(),
            },
        )

    def write_summary(self, now: float, final: bool) -> Path:
        name = "summary.json" if final else "summary.partial.json"
        path = self.out / name
        temporary = self.out / (name + ".tmp")
        temporary.write_text(json.dumps(self.summary(now, final), indent=2) + "\n", encoding="utf-8")
        os.replace(temporary, path)
        return path

    def _fail(self, task: str, error: BaseException | None) -> None:
        detail = f"{type(error).__name__}: {error}"[:300] if error is not None else "ended before the recording did"
        self.failures.append({"at": core.iso(time.time()), "task": task, "error": detail})
        self.outcome = "failed"
        self.log(f"recorder: FAILED: task {task}: {detail}; stopping")

    def _dead_task(self, tasks: dict[str, "asyncio.Task[None]"]) -> bool:
        """Records the first task that ended while the recording still runs.
        Every task loops until `stop` is set, so any ending is a failure."""
        for name, task in tasks.items():
            if task.done():
                self._fail(name, None if task.cancelled() else task.exception())
                return True
        return False

    def _on_signal(self, stop: asyncio.Event) -> None:
        self.interrupted = True
        stop.set()

    async def run(self) -> int:
        stop = asyncio.Event()
        loop = asyncio.get_running_loop()
        for signum in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(signum, self._on_signal, stop)
        self.log(
            f"recorder: series={','.join(self.args.series)} duration={self.args.duration_seconds:.0f}s "
            f"raw={'on' if self.args.raw else 'off'}"
        )
        for attempt in range(5):
            if await self.poll_gamma():
                break
            await asyncio.sleep(5 * (attempt + 1))
        else:
            self.log("recorder: Gamma never answered; stopping")
            return 2
        if not self.known:
            self.log("recorder: Gamma lists no window of the wanted series; check --series with --list-series")
            return 2
        self.reconcile(time.time())
        tasks: dict[str, asyncio.Task[None]] = {
            f"connection {s}": asyncio.create_task(c.run(stop)) for s, c in self.connections.items()
        }
        tasks["gamma"] = asyncio.create_task(self.gamma_loop(stop))
        deadline = time.monotonic() + self.args.duration_seconds
        next_summary = time.monotonic() + self.args.summary_every_seconds
        try:
            while not stop.is_set():
                await _wait_any(stop, None, timeout=1.0 - (time.time() % 1.0))
                now = time.time()
                if stop.is_set():
                    break  # a signal: the tasks are ending on purpose
                if self._dead_task(tasks):
                    break
                if time.monotonic() >= deadline:
                    self.log("recorder: duration reached")
                    break
                self.reconcile(now)
                self.flush_seconds(now)
                if time.monotonic() >= next_summary:
                    next_summary = time.monotonic() + self.args.summary_every_seconds
                    self.write_summary(now, final=False)
                    self.per_second.flush()
        except Exception as error:  # noqa: BLE001 (recorded, then the summary is still written)
            self._fail("main loop", error)
        finally:
            stop.set()
            results = await asyncio.gather(*tasks.values(), return_exceptions=True)
            for name, result in zip(tasks, results):
                if isinstance(result, BaseException) and not isinstance(result, asyncio.CancelledError):
                    if not any(f["task"] == name for f in self.failures):
                        self._fail(name, result)
            if self.outcome == "running":
                self.outcome = "interrupted" if self.interrupted else "complete"
            now = time.time()
            self.flush_seconds(now + 3)
            self.per_second.close()
            self.windows_log.close()
            self.raw.close()
            path = self.write_summary(now, final=True)
            self.log(f"recorder: wrote {path.name}; outcome {self.outcome}")
            self.log.close()
        return 3 if self.outcome == "failed" else 0


def list_series(horizon_s: float) -> int:
    events, truncated = fetch_events(time.time(), horizon_s, 0)
    print(json.dumps(core.count_series(events), indent=2))
    if truncated:
        print(f"TRUNCATED: {GAMMA_MAX_PAGES} full pages; later events not listed", file=sys.stderr)
    return 0


def parse_arguments(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out-dir", help="output directory (created)")
    parser.add_argument("--list-series", action="store_true", help="print the series Gamma lists in the next hour, then exit")
    parser.add_argument("--series", default=",".join(core.DEFAULT_SERIES), help="comma-separated seriesSlug values")
    duration = parser.add_mutually_exclusive_group()
    duration.add_argument("--duration-hours", type=float)
    duration.add_argument("--duration-seconds", type=float)
    parser.add_argument("--next-windows", type=int, default=1, help="upcoming windows to subscribe per series (default 1)")
    parser.add_argument("--linger-seconds", type=float, default=30.0, help="keep a window this long after its end (default 30)")
    parser.add_argument("--gamma-poll-seconds", type=float, default=60.0)
    parser.add_argument("--horizon-seconds", type=float, default=2400.0, help="Gamma end-date horizon (default 40 min)")
    parser.add_argument("--summary-every-seconds", type=float, default=300.0)
    parser.add_argument("--raw", action="store_true", help="also write every inbound frame, gzip-compressed")
    parser.add_argument("--raw-gzip-level", type=int, default=6)
    args = parser.parse_args(argv)
    if args.list_series:
        return args
    if not args.out_dir:
        parser.error("--out-dir is required")
    args.series = [s.strip() for s in args.series.split(",") if s.strip()]
    if not args.series:
        parser.error("--series is empty")
    if args.gamma_poll_seconds < 10:
        parser.error("--gamma-poll-seconds must be at least 10 (stay far below the documented limits)")
    if args.duration_hours is not None:
        args.duration_seconds = args.duration_hours * 3600
    if args.duration_seconds is None:
        args.duration_seconds = 24 * 3600.0
    return args


def main(argv: list[str]) -> int:
    args = parse_arguments(argv)
    if args.list_series:
        return list_series(3600)
    return asyncio.run(Recorder(args).run())


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
