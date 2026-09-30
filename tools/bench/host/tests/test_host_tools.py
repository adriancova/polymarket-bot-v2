"""Offline checks of the host sampler's /proc parsers and summary, and of bench_table.

Run: python3 -m unittest discover -s tools/bench/host/tests -v
The /proc texts below are synthetic, in the documented proc(5) layouts.
"""

from __future__ import annotations

import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import bench_table  # noqa: E402
import host_sampler as hs  # noqa: E402

STAT_A = """cpu  100 0 100 800 0 0 0 0 0 0
cpu0 50 0 50 400 0 0 0 0 0 0
cpu1 50 0 50 400 0 0 0 0 0 0
intr 1 2 3
"""
STAT_B = """cpu  200 0 200 1400 100 0 0 100 0 0
cpu0 150 0 50 400 0 0 0 0 0 0
cpu1 50 0 150 1000 100 0 0 100 0 0
"""
MEMINFO = """MemTotal:       11534336 kB
MemFree:         1048576 kB
MemAvailable:    8388608 kB
Buffers:          102400 kB
Cached:          4194304 kB
SwapTotal:       4194304 kB
SwapFree:        3145728 kB
Dirty:              2048 kB
Shmem:             10240 kB
"""
PRESSURE = """some avg10=1.50 avg60=0.75 avg300=0.10 total=123
full avg10=0.00 avg60=0.25 avg300=0.00 total=4
"""
DISKSTATS = """   8       0 sda 10 0 2048 5 20 0 4096 10 0 100 15 0 0 0 0 0 0
   8       1 sda1 10 0 2048 5 20 0 4096 10 0 100 15 0 0 0 0 0 0
   8      48 sdd 100 0 1000 5 200 0 8000 10 0 2500 15 0 0 0 0 0 0
   7       0 loop0 1 0 2 0 0 0 0 0 0 0 0 0 0 0 0 0 0
"""
NET_DEV = """Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 999 1 0 0 0 0 0 0 999 1 0 0 0 0 0 0
  eth0: 5000 10 0 0 0 0 0 0 700 5 0 0 0 0 0 0
"""


class ProcParsers(unittest.TestCase):
    def test_cpu_usage(self) -> None:
        usage = hs.cpu_usage(hs.parse_proc_stat(STAT_A), hs.parse_proc_stat(STAT_B))
        # delta: user 100, system 100, idle 600, iowait 100, steal 100 -> total 1000; busy is
        # everything but idle and iowait (steal included, and also reported on its own) = 300.
        self.assertEqual(usage["busyPct"], 30.0)
        self.assertEqual(usage["iowaitPct"], 10.0)
        self.assertEqual(usage["stealPct"], 10.0)
        # cpu1: system 100, idle 600, iowait 100, steal 100 -> busy 200 of 900.
        self.assertEqual(usage["perCpuBusyPct"], [100.0, 22.2])

    def test_meminfo(self) -> None:
        mem = hs.parse_meminfo(MEMINFO)
        self.assertEqual(mem["MemTotalMiB"], 11264)
        self.assertEqual(mem["MemAvailableMiB"], 8192)
        self.assertEqual(mem["SwapUsedMiB"], 1024)

    def test_pressure(self) -> None:
        self.assertEqual(hs.parse_pressure(PRESSURE), {"someAvg10": 1.5, "someAvg60": 0.75, "fullAvg10": 0.0, "fullAvg60": 0.25})

    def test_diskstats_whole_disks_only(self) -> None:
        self.assertEqual(hs.parse_diskstats(DISKSTATS), {"sda": [2048, 4096, 100], "sdd": [1000, 8000, 2500]})

    def test_net_dev_without_loopback(self) -> None:
        self.assertEqual(hs.parse_net_dev(NET_DEV), {"eth0": [5000, 700]})

    def test_redact(self) -> None:
        import os
        import socket

        text = f"Linux x ({socket.gethostname()}) {os.path.expanduser('~')}/pmb-host-bench"
        redacted = hs.redact(text)
        self.assertNotIn(socket.gethostname(), redacted)
        self.assertIn("<host>", redacted)
        self.assertIn("~/pmb-host-bench", redacted)


class SamplerSummary(unittest.TestCase):
    def records(self) -> list[dict]:
        base = {
            "load": [1.0, 1.0, 1.0],
            "mem": {"MemTotalMiB": 11264, "MemAvailableMiB": 8000, "SwapUsedMiB": 0},
            "fs": {"root": {"totalGiB": 1000.0, "freeGiB": 600.0}},
            "processes": {"node": {"count": 1, "rssMiB": 300}},
        }
        out = [{"t": 0, "at": "2026-10-01T00:00:00Z", **base, "windows": {"error": "x"}}]
        for i in range(1, 5):
            record = json.loads(json.dumps(base))
            record.update(
                {
                    "t": 60 * i,
                    "at": f"2026-10-01T00:0{i}:00Z",
                    "intervalSeconds": 60.0 if i != 3 else 400.0,
                    "cpu": {"busyPct": 10.0 * i, "iowaitPct": 0.0, "stealPct": 0.0},
                    "disk": {"sdd": {"readBytesPerSecond": 0, "writeBytesPerSecond": 1000, "utilPct": 1.0}},
                    "net": {"eth0": {"rxBytes": 6000, "txBytes": 100, "rxBytesPerSecond": 100}},
                    "windows": {
                        "cpu": {"PercentProcessorPerformance": 120 - i, "ProcessorFrequency": 2700},
                        "thermal": {"Name": "tz", "HighPrecisionTemperature": 3300 + i, "PercentPassiveLimit": 100},
                        "battery": [{"BatteryStatus": 2}],
                        "vmmem": [{"Name": "vmmemWSL", "WorkingSet64": 2**33}],
                        "net": [{"Name": "Ethernet", "ReceivedBytes": 1000 * i, "SentBytes": 10 * i}],
                        "lp": [
                            {"Name": "0,10", "PercentProcessorTime": 90, "PercentProcessorPerformance": 190},
                            {"Name": "0,2", "PercentProcessorTime": 5 * i, "PercentProcessorPerformance": 120},
                        ],
                    },
                }
            )
            record["fs"]["root"]["freeGiB"] = 600.0 - i
            out.append(record)
        return out

    def test_summary(self) -> None:
        summary = hs.summarize(self.records())
        self.assertEqual(summary["samples"], 5)
        self.assertEqual(summary["medianIntervalSeconds"], 60.0)
        self.assertEqual(summary["gaps"], [{"at": "2026-10-01T00:03:00Z", "intervalSeconds": 400.0}])
        self.assertEqual(summary["cpuBusyPct"]["max"], 40.0)
        self.assertEqual(summary["net"]["eth0"]["rxBytesTotal"], 24000)
        self.assertEqual(summary["disk"]["sdd"]["writtenBytesTotal"], 1000 * (60 + 60 + 400 + 60))
        self.assertEqual(summary["fs"]["root"]["freeGiBStart"], 600.0)
        self.assertEqual(summary["fs"]["root"]["freeGiBEnd"], 596.0)
        self.assertEqual(summary["windows"]["errors"], 1)
        self.assertEqual(summary["windows"]["percentProcessorPerformance"]["min"], 116)
        self.assertEqual(summary["windows"]["thermalKelvin"]["max"], 330.4)
        self.assertEqual(summary["windows"]["batteryStatusCounts"], {"2": 4})
        self.assertEqual(summary["windows"]["adapterBytes"]["Ethernet"], {"receivedDelta": 3000, "sentDelta": 30})
        self.assertEqual(summary["processesRssMiB"]["node"]["max"], 300)
        lps = summary["windows"]["perLogicalProcessor"]
        self.assertEqual(list(lps), ["0,2", "0,10"])  # numeric order
        self.assertEqual(lps["0,10"]["busyPct"]["mean"], 90.0)
        self.assertEqual(lps["0,2"]["busyPct"]["max"], 20)

    def test_windows_script_flag(self) -> None:
        self.assertTrue(hs.windows_script(True).startswith("$PerLogicalProcessor = $true\n"))
        self.assertTrue(hs.windows_script(False).startswith("$PerLogicalProcessor = $false\n"))

    def test_empty(self) -> None:
        summary = hs.summarize([])
        self.assertEqual(summary["samples"], 0)
        self.assertIsNone(summary["cpuBusyPct"])


class BenchTable(unittest.TestCase):
    def report(self, mode: str, eps: float, cpu_ms: float, profiled: bool = False) -> dict:
        return {
            "mode": mode,
            "events": 99669,
            "consumed": 99669,
            "stopped": "COMPLETE",
            "wallMs": 99669 / eps * 1000,
            "cpuMs": cpu_ms,
            "eventsPerSecond": eps,
            "lag": {"maxMs": 12345.0, "p99Ms": 12000.0, "p50Ms": 5000.0, "count": 99669},
            "halts": [],
            "framesSplit": 0,
            "durable": {"decisions": 46666, "normalizedDecisionContentSha256": "f397f524" + "0" * 56},
            "cpuProfile": "/somewhere/x.cpuprofile" if profiled else None,
        }

    def test_rows_and_groups(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for label, report in (
                ("catch-up-1", self.report("catch-up", 800.0, 129_669.0)),
                ("catch-up-2", self.report("catch-up", 780.0, 130_000.0)),
                ("catch-up-3", self.report("catch-up", 820.0, 129_000.0)),
                ("catch-up-profiled", self.report("catch-up", 700.0, 140_000.0, profiled=True)),
                ("catch-up-4", self.report("catch-up", 600.0, 150_000.0, profiled=True)),
            ):
                directory = root / label / "bench-catch-up-abcd"
                directory.mkdir(parents=True)
                (directory / "report.json").write_text(json.dumps(report), encoding="utf-8")
            runs = bench_table.load_runs(root)
            self.assertEqual([r["label"] for r in runs], ["catch-up-1", "catch-up-2", "catch-up-3", "catch-up-4", "catch-up-profiled"])
            self.assertEqual(runs[0]["cpuMicrosPerEvent"], 1301)
            self.assertEqual(runs[0]["lagMaxSeconds"], 12.345)
            self.assertTrue(runs[3]["profiled"])
            table = bench_table.markdown(runs)
            # catch-up-4 is profiled: listed as a row, left out of its group's spread.
            self.assertIn("| catch-up-4 |", table)
            self.assertIn("| catch-up | 3 | 780.0 / 800.0 / 820.0 |", table)
            self.assertNotIn("/somewhere", table)
            with contextlib.redirect_stdout(io.StringIO()) as printed:
                self.assertEqual(bench_table.main([tmp]), 0)
            self.assertIn("| catch-up-profiled |", printed.getvalue())


if __name__ == "__main__":
    unittest.main()


class ReportTables(unittest.TestCase):
    def test_recording_tables_render_every_series_and_trim_drops_windows(self) -> None:
        import recorder_core as core
        import report_tables

        events = json.loads((HERE / "fixtures" / "gamma-events.json").read_text(encoding="utf-8"))["events"]
        windows, _ = core.parse_gamma_events(events, ["btc-up-or-down-15m", "eth-up-or-down-5m"])
        registry = {w.condition_id: w for w in windows}
        stats = core.Stats()
        condition = next(w.condition_id for w in windows if w.series == "btc-up-or-down-15m")
        start = core.parse_iso("2026-09-30T11:40:00Z")
        for second in range(1200):
            stats.record_frame(start + second, "btc-up-or-down-15m", '{"event_type":"book","market":"%s"}' % condition, registry)
        summary = core.summarize(stats, registry, ["btc-up-or-down-15m", "eth-up-or-down-5m"], start, start + 1200)
        summary["connections"] = {"btc-up-or-down-15m": {"connects": 1, "disconnects": 0, "staleCloses": 0, "subscribeUpdates": 1, "unsubscribeUpdates": 1, "closeReasons": {}, "connectedSeconds": 1200.0, "wantedSeconds": 1200.0}}
        summary["rawFrames"] = {"rawTextBytes": 1000, "gzipFileBytes": 100, "gzipLevel": 6}
        text = report_tables.recording(summary)
        self.assertIn("| btc-up-or-down-15m |", text)
        self.assertIn("| eth-up-or-down-5m |", text)
        self.assertIn("| btc | btc-up-or-down-15m |", text)
        self.assertIn("(10.00x)", text)
        trimmed = report_tables.trim(summary)
        self.assertNotIn("windows", trimmed)
        self.assertEqual(trimmed["windowsCount"], len(summary["windows"]))

    def test_host_tables_render(self) -> None:
        import report_tables

        text = report_tables.host(hs.summarize(SamplerSummary().records()))
        self.assertIn("| WSL CPU busy % |", text)
        self.assertIn('| Windows adapter "Ethernet" received / sent bytes | 3,000 / 30 |', text)
        self.assertIn("| 0,10 |", text)
        self.assertIn("Gaps: 2026-10-01T00:03:00Z (400.0 s)", text)

    def test_usage(self) -> None:
        import report_tables

        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(report_tables.main([]), 64)
