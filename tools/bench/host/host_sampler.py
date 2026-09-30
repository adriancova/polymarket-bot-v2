#!/usr/bin/env python3
"""HOST-BENCH host sampler: CPU, memory, disk, network and free space, once a minute.

Standard library only. Reads /proc and statvfs inside WSL; with --windows it
also asks Windows (through WSL interop, `powershell.exe`) for the CPU
performance percentage and frequency, thermal zones, free memory, the WSL VM's
working set, the power source and the network adapters' byte counters. Every
Windows query uses a WMI/CIM class name or a cmdlet, never a performance
counter path, because counter paths are translated on a non-English Windows.

    python3 host_sampler.py sample --out-dir DIR [--interval 60] [--duration-hours 24]
                                   [--path / --path-label wsl-root] [--windows [--windows-per-cpu]]
                                   [--raw-commands]
    python3 host_sampler.py summarize DIR/host-samples.jsonl > host-summary.json

`sample` appends one JSON line per interval to DIR/host-samples.jsonl. With
--raw-commands it also appends the text of `vmstat`, `iostat`, `free` and `df`
to DIR/host-raw.log each interval, for a human reader.

No sample records a host name, a user name, an IP address or a home path:
file-system paths are reported under the label given with --path-label, or
by their position, and host-raw.log has the host name and the home
directory replaced (`redact`).
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

WHOLE_DISK = re.compile(r"^(sd[a-z]+|vd[a-z]+|nvme\d+n\d+|xvd[a-z]+)$")
PROCESS_NAMES = ("node", "postgres", "redis-server", "python3", "dockerd", "containerd")

# One PowerShell script, run with -EncodedCommand. Class names are not localized.
WINDOWS_SCRIPT = r"""
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
$cpu = Get-CimInstance -ClassName Win32_PerfFormattedData_Counters_ProcessorInformation -Filter "Name='_Total'" |
  Select-Object PercentProcessorPerformance, ProcessorFrequency, PercentProcessorUtility, PercentProcessorTime
$thermal = @(Get-CimInstance -ClassName Win32_PerfFormattedData_Counters_ThermalZoneInformation |
  Select-Object Name, Temperature, HighPrecisionTemperature, PercentPassiveLimit, ThrottleReasons)
$os = Get-CimInstance -ClassName Win32_OperatingSystem | Select-Object FreePhysicalMemory, TotalVisibleMemorySize
$vm = @(Get-Process -Name vmmemWSL, vmmem | Select-Object Name, WorkingSet64)
$battery = @(Get-CimInstance -ClassName Win32_Battery | Select-Object BatteryStatus, EstimatedChargeRemaining)
$net = @(Get-NetAdapterStatistics | Select-Object Name, ReceivedBytes, SentBytes)
$lp = $null
if ($PerLogicalProcessor) {
  $lp = @(Get-CimInstance -ClassName Win32_PerfFormattedData_Counters_ProcessorInformation |
    Where-Object { $_.Name -notlike '*_Total' } |
    Select-Object Name, PercentProcessorTime, PercentProcessorPerformance)
}
[pscustomobject]@{ cpu = $cpu; thermal = $thermal; os = $os; vmmem = $vm; battery = $battery; net = $net; lp = $lp } |
  ConvertTo-Json -Depth 4 -Compress
"""


# ---------------------------------------------------------------------------
# /proc readers (pure functions of file text, so the tests can feed them)
# ---------------------------------------------------------------------------


def parse_proc_stat(text: str) -> dict[str, list[int]]:
    """cpu lines of /proc/stat: name -> jiffies [user, nice, system, idle, iowait, irq, softirq, steal]."""
    result = {}
    for line in text.splitlines():
        if line.startswith("cpu"):
            parts = line.split()
            result[parts[0]] = [int(v) for v in parts[1:9]] + [0] * max(0, 8 - len(parts[1:9]))
    return result


def cpu_usage(before: dict[str, list[int]], after: dict[str, list[int]]) -> dict[str, Any]:
    """Busy, iowait and steal percentages between two /proc/stat readings."""

    def pct(name: str) -> tuple[float, float, float] | None:
        if name not in before or name not in after:
            return None
        delta = [a - b for a, b in zip(after[name], before[name])]
        total = sum(delta)
        if total <= 0:
            return (0.0, 0.0, 0.0)
        idle = delta[3] + delta[4]
        return (100.0 * (total - idle) / total, 100.0 * delta[4] / total, 100.0 * delta[7] / total)

    overall = pct("cpu")
    per_cpu = [pct(name) for name in sorted((n for n in after if n != "cpu"), key=lambda n: int(n[3:]))]
    return {
        "busyPct": None if overall is None else round(overall[0], 2),
        "iowaitPct": None if overall is None else round(overall[1], 2),
        "stealPct": None if overall is None else round(overall[2], 2),
        "perCpuBusyPct": [None if p is None else round(p[0], 1) for p in per_cpu],
    }


def parse_meminfo(text: str) -> dict[str, int]:
    """/proc/meminfo in MiB for the fields this sampler reports."""
    wanted = {"MemTotal", "MemAvailable", "MemFree", "Buffers", "Cached", "SwapTotal", "SwapFree", "Dirty", "Shmem"}
    result = {}
    for line in text.splitlines():
        key, _, rest = line.partition(":")
        if key in wanted:
            result[key + "MiB"] = int(rest.split()[0]) // 1024
    if "SwapTotalMiB" in result and "SwapFreeMiB" in result:
        result["SwapUsedMiB"] = result["SwapTotalMiB"] - result["SwapFreeMiB"]
    return result


def parse_pressure(text: str) -> dict[str, float]:
    """One /proc/pressure/<x> file: {"someAvg60": .., "fullAvg60": ..}."""
    result = {}
    for line in text.splitlines():
        parts = line.split()
        if not parts:
            continue
        for item in parts[1:]:
            key, _, value = item.partition("=")
            if key in ("avg10", "avg60"):
                result[parts[0] + key.capitalize()] = float(value)
    return result


def parse_diskstats(text: str) -> dict[str, list[int]]:
    """Whole disks from /proc/diskstats: name -> [sectors read, sectors written, io ms]."""
    result = {}
    for line in text.splitlines():
        parts = line.split()
        if len(parts) >= 13 and WHOLE_DISK.match(parts[2]):
            result[parts[2]] = [int(parts[5]), int(parts[9]), int(parts[12])]
    return result


def parse_net_dev(text: str) -> dict[str, list[int]]:
    """/proc/net/dev: interface -> [rx bytes, tx bytes], loopback excluded."""
    result = {}
    for line in text.splitlines()[2:]:
        name, _, rest = line.partition(":")
        name = name.strip()
        parts = rest.split()
        if name and name != "lo" and len(parts) >= 9:
            result[name] = [int(parts[0]), int(parts[8])]
    return result


def _read(path: str) -> str | None:
    try:
        with open(path, encoding="utf-8") as handle:
            return handle.read()
    except OSError:
        return None


def process_rss() -> dict[str, dict[str, int]]:
    """Resident memory (MiB) and process count by command name, for PROCESS_NAMES."""
    page_kib = os.sysconf("SC_PAGE_SIZE") // 1024
    totals: dict[str, dict[str, int]] = {}
    for entry in os.scandir("/proc"):
        if not entry.name.isdigit():
            continue
        comm = (_read(f"/proc/{entry.name}/comm") or "").strip()
        if comm not in PROCESS_NAMES:
            continue
        statm = _read(f"/proc/{entry.name}/statm")
        if statm is None:
            continue
        rss_kib = int(statm.split()[1]) * page_kib
        slot = totals.setdefault(comm, {"count": 0, "rssMiB": 0})
        slot["count"] += 1
        slot["rssMiB"] += rss_kib // 1024
    return dict(sorted(totals.items()))


def windows_script(per_logical_processor: bool) -> str:
    flag = "$true" if per_logical_processor else "$false"
    return f"$PerLogicalProcessor = {flag}\n" + WINDOWS_SCRIPT


def windows_sample(timeout_s: float, per_logical_processor: bool = False) -> dict[str, Any]:
    """Windows-side readings through WSL interop; an {"error": ...} object when unavailable."""
    exe = shutil.which("powershell.exe")
    if exe is None:
        return {"error": "powershell.exe not found (WSL interop off?)"}
    encoded = base64.b64encode(windows_script(per_logical_processor).encode("utf-16-le")).decode("ascii")
    try:
        done = subprocess.run(
            [exe, "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
            capture_output=True,
            timeout=timeout_s,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        return {"error": f"{type(error).__name__}"}
    for line in done.stdout.decode("utf-8", "replace").splitlines():
        line = line.strip()
        if line.startswith("{"):
            try:
                return json.loads(line)
            except ValueError:
                break
    return {"error": f"no JSON from powershell.exe (exit {done.returncode})"}


def redact(text: str) -> str:
    """Replaces the host name and the home directory, which iostat and df print."""
    host = socket.gethostname()
    home = os.path.expanduser("~")
    if host:
        text = text.replace(host, "<host>")
    if home and home != "/":
        text = text.replace(home, "~")
    return text


def raw_commands(log_path: Path, paths: list[str]) -> None:
    """Appends vmstat/iostat/free/df text to the human log; missing tools are noted."""
    commands = [
        ["vmstat", "-w", "1", "2"],
        ["iostat", "-dxk", "1", "2"],
        ["free", "-m"],
        ["df", "-h", "--output=target,size,used,avail,pcent", *paths],
    ]
    with open(log_path, "a", encoding="utf-8") as log:
        log.write(f"===== {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}\n")
        for command in commands:
            log.write(f"$ {' '.join(command[:2])} ...\n")
            try:
                done = subprocess.run(command, capture_output=True, timeout=20, check=False)
                log.write(redact(done.stdout.decode("utf-8", "replace")))
            except (OSError, subprocess.TimeoutExpired) as error:
                log.write(f"({type(error).__name__})\n")


# ---------------------------------------------------------------------------
# Sampling loop
# ---------------------------------------------------------------------------


class Sampler:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.paths = [os.path.expanduser(p) for p in args.path]
        self.labels = args.path_label or [f"path{i}" for i in range(len(self.paths))]
        if len(self.labels) != len(self.paths):
            raise SystemExit("give one --path-label per --path")
        self.previous: dict[str, Any] | None = None

    def snapshot(self) -> dict[str, Any]:
        return {
            "mono": time.monotonic(),
            "stat": parse_proc_stat(_read("/proc/stat") or ""),
            "disk": parse_diskstats(_read("/proc/diskstats") or ""),
            "net": parse_net_dev(_read("/proc/net/dev") or ""),
        }

    def sample(self) -> dict[str, Any]:
        now = self.snapshot()
        record: dict[str, Any] = {"t": time.time(), "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
        if self.previous is not None:
            elapsed = now["mono"] - self.previous["mono"]
            record["intervalSeconds"] = round(elapsed, 3)
            record["cpu"] = cpu_usage(self.previous["stat"], now["stat"])
            disks = {}
            for name, values in now["disk"].items():
                old = self.previous["disk"].get(name)
                if old is None or elapsed <= 0:
                    continue
                disks[name] = {
                    "readBytesPerSecond": round((values[0] - old[0]) * 512 / elapsed),
                    "writeBytesPerSecond": round((values[1] - old[1]) * 512 / elapsed),
                    "utilPct": round(min(100.0, (values[2] - old[2]) / (elapsed * 10)), 2),
                }
            record["disk"] = disks
            nets = {}
            for name, values in now["net"].items():
                old = self.previous["net"].get(name)
                if old is None or elapsed <= 0:
                    continue
                nets[name] = {
                    "rxBytes": values[0] - old[0],
                    "txBytes": values[1] - old[1],
                    "rxBytesPerSecond": round((values[0] - old[0]) / elapsed),
                }
            record["net"] = nets
        record["netCumulative"] = {name: {"rxBytes": v[0], "txBytes": v[1]} for name, v in now["net"].items()}
        record["load"] = [float(v) for v in (_read("/proc/loadavg") or "0 0 0").split()[:3]]
        record["mem"] = parse_meminfo(_read("/proc/meminfo") or "")
        pressure = {}
        for kind in ("cpu", "memory", "io"):
            text = _read(f"/proc/pressure/{kind}")
            if text is not None:
                pressure[kind] = parse_pressure(text)
        record["pressure"] = pressure
        space = {}
        for label, path in zip(self.labels, self.paths):
            try:
                stats = os.statvfs(path)
            except OSError:
                continue
            space[label] = {
                "totalGiB": round(stats.f_blocks * stats.f_frsize / 2**30, 2),
                "freeGiB": round(stats.f_bavail * stats.f_frsize / 2**30, 2),
            }
        record["fs"] = space
        record["processes"] = process_rss()
        if self.args.windows:
            record["windows"] = windows_sample(self.args.windows_timeout, self.args.windows_per_cpu)
        self.previous = now
        return record

    def run(self) -> int:
        out = Path(self.args.out_dir)
        out.mkdir(parents=True, exist_ok=True)
        stop = {"flag": False}

        def request_stop(signum: int, frame: Any) -> None:
            stop["flag"] = True

        signal.signal(signal.SIGINT, request_stop)
        signal.signal(signal.SIGTERM, request_stop)
        deadline = time.monotonic() + self.args.duration_seconds
        self.previous = self.snapshot()
        next_at = time.monotonic() + self.args.interval
        with open(out / "host-samples.jsonl", "a", encoding="utf-8") as handle:
            while not stop["flag"] and time.monotonic() < deadline:
                while not stop["flag"] and time.monotonic() < next_at:
                    time.sleep(min(1.0, max(0.0, next_at - time.monotonic())))
                if stop["flag"]:
                    break
                next_at += self.args.interval
                record = self.sample()
                handle.write(json.dumps(record, separators=(",", ":")) + "\n")
                handle.flush()
                if self.args.raw_commands:
                    raw_commands(out / "host-raw.log", self.paths)
        return 0


# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------


def _stats(values: list[float]) -> dict[str, Any] | None:
    if not values:
        return None
    ordered = sorted(values)
    p95 = ordered[max(0, -(-95 * len(ordered) // 100) - 1)]
    return {
        "min": ordered[0],
        "mean": round(sum(ordered) / len(ordered), 3),
        "p95": p95,
        "max": ordered[-1],
    }


def summarize(records: list[dict[str, Any]], interval_s: float | None = None) -> dict[str, Any]:
    """Min/mean/p95/max of every reading, totals of disk and network bytes, and sampling gaps."""
    measured = [r for r in records if "cpu" in r]
    if interval_s is None:
        gaps_seen = sorted(r["intervalSeconds"] for r in measured)
        interval_s = gaps_seen[len(gaps_seen) // 2] if gaps_seen else 60.0
    pick = lambda path: [v for v in (_dig(r, path) for r in records) if isinstance(v, (int, float))]  # noqa: E731
    disks = sorted({name for r in measured for name in r.get("disk", {})})
    nets = sorted({name for r in measured for name in r.get("net", {})})
    labels = sorted({name for r in records for name in r.get("fs", {})})
    procs = sorted({name for r in records for name in r.get("processes", {})})
    adapters = sorted({a.get("Name") for r in records for a in _as_list(_dig(r, ("windows", "net"))) if isinstance(a, dict) and a.get("Name")})
    gaps = [
        {"at": r["at"], "intervalSeconds": r["intervalSeconds"]}
        for r in measured
        if r["intervalSeconds"] > 2 * interval_s
    ]
    thermal_k = [
        z.get("HighPrecisionTemperature") / 10 if z.get("HighPrecisionTemperature") else z.get("Temperature")
        for r in records
        for z in _as_list(_dig(r, ("windows", "thermal")))
        if isinstance(z, dict)
    ]
    passive = [
        z.get("PercentPassiveLimit")
        for r in records
        for z in _as_list(_dig(r, ("windows", "thermal")))
        if isinstance(z, dict) and isinstance(z.get("PercentPassiveLimit"), (int, float))
    ]
    battery = {}
    for r in records:
        for b in _as_list(_dig(r, ("windows", "battery"))):
            if isinstance(b, dict):
                key = str(b.get("BatteryStatus"))
                battery[key] = battery.get(key, 0) + 1
    windows_errors = sum(1 for r in records if isinstance(_dig(r, ("windows", "error")), str))

    def adapter_delta(name: str, field: str) -> int | None:
        values = [
            a.get(field)
            for r in records
            for a in _as_list(_dig(r, ("windows", "net")))
            if isinstance(a, dict) and a.get("Name") == name and isinstance(a.get(field), (int, float))
        ]
        return (values[-1] - values[0]) if len(values) >= 2 else None

    return {
        "samples": len(records),
        "from": records[0]["at"] if records else None,
        "to": records[-1]["at"] if records else None,
        "medianIntervalSeconds": interval_s,
        "gaps": gaps,
        "cpuBusyPct": _stats(pick(("cpu", "busyPct"))),
        "cpuIowaitPct": _stats(pick(("cpu", "iowaitPct"))),
        "cpuStealPct": _stats(pick(("cpu", "stealPct"))),
        "load1": _stats([r["load"][0] for r in records if r.get("load")]),
        "memTotalMiB": _stats(pick(("mem", "MemTotalMiB"))),
        "memAvailableMiB": _stats(pick(("mem", "MemAvailableMiB"))),
        "swapUsedMiB": _stats(pick(("mem", "SwapUsedMiB"))),
        "pressure": {
            kind: {
                "someAvg60": _stats(pick(("pressure", kind, "someAvg60"))),
                "fullAvg60": _stats(pick(("pressure", kind, "fullAvg60"))),
            }
            for kind in ("cpu", "memory", "io")
        },
        "disk": {
            name: {
                "readBytesPerSecond": _stats(pick(("disk", name, "readBytesPerSecond"))),
                "writeBytesPerSecond": _stats(pick(("disk", name, "writeBytesPerSecond"))),
                "utilPct": _stats(pick(("disk", name, "utilPct"))),
                "writtenBytesTotal": round(
                    sum(r["disk"][name]["writeBytesPerSecond"] * r["intervalSeconds"] for r in measured if name in r.get("disk", {}))
                ),
            }
            for name in disks
        },
        "net": {
            name: {
                "rxBytesTotal": sum(r["net"][name]["rxBytes"] for r in measured if name in r.get("net", {})),
                "txBytesTotal": sum(r["net"][name]["txBytes"] for r in measured if name in r.get("net", {})),
                "rxBytesPerSecond": _stats(pick(("net", name, "rxBytesPerSecond"))),
            }
            for name in nets
        },
        "fs": {
            label: {
                "freeGiBStart": _dig(next((r for r in records if label in r.get("fs", {})), {}), ("fs", label, "freeGiB")),
                "freeGiBEnd": _dig(next((r for r in reversed(records) if label in r.get("fs", {})), {}), ("fs", label, "freeGiB")),
                "freeGiB": _stats(pick(("fs", label, "freeGiB"))),
                "totalGiB": _dig(next((r for r in records if label in r.get("fs", {})), {}), ("fs", label, "totalGiB")),
            }
            for label in labels
        },
        "processesRssMiB": {name: _stats(pick(("processes", name, "rssMiB"))) for name in procs},
        "windows": {
            "errors": windows_errors,
            "percentProcessorPerformance": _stats(pick(("windows", "cpu", "PercentProcessorPerformance"))),
            "processorFrequencyMHz": _stats(pick(("windows", "cpu", "ProcessorFrequency"))),
            "percentProcessorUtility": _stats(pick(("windows", "cpu", "PercentProcessorUtility"))),
            "freePhysicalMemoryKiB": _stats(pick(("windows", "os", "FreePhysicalMemory"))),
            "vmmemWorkingSetBytes": _stats(
                [v.get("WorkingSet64") for r in records for v in _as_list(_dig(r, ("windows", "vmmem"))) if isinstance(v, dict) and isinstance(v.get("WorkingSet64"), (int, float))]
            ),
            "thermalKelvin": _stats([v for v in thermal_k if isinstance(v, (int, float))]),
            "thermalPercentPassiveLimit": _stats(passive),
            "batteryStatusCounts": battery,
            "perLogicalProcessor": {
                name: {
                    "busyPct": _stats([lp.get("PercentProcessorTime") for r in records for lp in _as_list(_dig(r, ("windows", "lp"))) if isinstance(lp, dict) and lp.get("Name") == name and isinstance(lp.get("PercentProcessorTime"), (int, float))]),
                    "performancePct": _stats([lp.get("PercentProcessorPerformance") for r in records for lp in _as_list(_dig(r, ("windows", "lp"))) if isinstance(lp, dict) and lp.get("Name") == name and isinstance(lp.get("PercentProcessorPerformance"), (int, float))]),
                }
                for name in sorted(
                    {lp.get("Name") for r in records for lp in _as_list(_dig(r, ("windows", "lp"))) if isinstance(lp, dict) and isinstance(lp.get("Name"), str)},
                    key=lambda n: [int(x) if x.isdigit() else x for x in n.split(",")],
                )
            },
            "adapterBytes": {
                name: {"receivedDelta": adapter_delta(name, "ReceivedBytes"), "sentDelta": adapter_delta(name, "SentBytes")}
                for name in adapters
            },
        },
    }


def _as_list(value: Any) -> list[Any]:
    if value is None:
        return []
    return value if isinstance(value, list) else [value]


def _dig(record: Any, path: tuple[str, ...]) -> Any:
    for key in path:
        if not isinstance(record, dict):
            return None
        record = record.get(key)
    return record


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    sample = sub.add_parser("sample")
    sample.add_argument("--out-dir", required=True)
    sample.add_argument("--interval", type=float, default=60.0)
    duration = sample.add_mutually_exclusive_group()
    duration.add_argument("--duration-hours", type=float)
    duration.add_argument("--duration-seconds", type=float)
    sample.add_argument("--path", action="append", default=None, help="file system to report free space for (repeatable)")
    sample.add_argument("--path-label", action="append", default=None, help="label for each --path, in order")
    sample.add_argument("--windows", action="store_true", help="also query Windows through powershell.exe")
    sample.add_argument("--windows-per-cpu", action="store_true", help="with --windows: busy % and performance % per Windows logical processor")
    sample.add_argument("--windows-timeout", type=float, default=40.0)
    sample.add_argument("--raw-commands", action="store_true", help="also log vmstat/iostat/free/df text")
    summary = sub.add_parser("summarize")
    summary.add_argument("samples")
    args = parser.parse_args(argv)
    if args.command == "summarize":
        records = [json.loads(line) for line in Path(args.samples).read_text(encoding="utf-8").splitlines() if line.strip()]
        print(json.dumps(summarize(records), indent=2))
        return 0
    if args.path is None:
        args.path = ["/"]
    if args.interval < 5:
        parser.error("--interval must be at least 5 s")
    if args.duration_hours is not None:
        args.duration_seconds = args.duration_hours * 3600
    if args.duration_seconds is None:
        args.duration_seconds = 24 * 3600.0
    return Sampler(args).run()


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
