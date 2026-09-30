#!/usr/bin/env python3
"""Markdown tables for the HOST-BENCH results file, from the tools' JSON outputs.

    python3 report_tables.py recording SUMMARY.json      # the recorder's summary.json
    python3 report_tables.py host HOST-SUMMARY.json      # host_sampler.py summarize output
    python3 report_tables.py trim SUMMARY.json > OUT     # summary.json without the per-window list

Standard library only. Every number is printed as the tools computed it; GB
here means 10^9 bytes.
"""

from __future__ import annotations

import json
import sys
from typing import Any


def _n(value: Any, digits: int = 1) -> str:
    if value is None:
        return "-"
    if isinstance(value, float):
        return f"{value:,.{digits}f}"
    if isinstance(value, int):
        return f"{value:,}"
    return str(value)


def _gb(value: Any) -> str:
    return "-" if value is None else f"{value / 1e9:,.2f}"


def recording(summary: dict[str, Any]) -> str:
    failures = summary.get("failures") or []
    out = [
        f"Recording: {summary['startedAt']} to {summary['endedAt']} "
        f"({summary['durationSeconds'] / 3600:.2f} h); final={summary.get('final')}; "
        f"outcome={summary.get('outcome')}; failures={len(failures)}.",
    ]
    for failure in failures:
        out.append(f"- FAILURE at {failure.get('at')}: task {failure.get('task')}: {failure.get('error')}")
    out += [
        "",
        "| series | GB/day | frames/s | events/s | envelopes/s (est.) | p95 10 s env/s (whole) | opens | p95 10 s env/s at opens | peak 10 s env/s at opens | peak 1 s env/s | windows |",
        "|---|---|---|---|---|---|---|---|---|---|---|",
    ]
    for name, s in summary["perSeries"].items():
        o = s["atWindowOpens"]
        out.append(
            f"| {name} | {_gb(s['bytesPerDay'])} | {_n(s['framesPerSecond'])} | {_n(s['eventsPerSecond'])} | "
            f"{_n(s['envelopesPerSecond'])} | {_n(s['whole']['p95_10sEnvelopesPerSecond'])} | {o['opens']} | "
            f"{_n(o['p95_10sEnvelopesPerSecond'])} | {_n(o['peak10sEnvelopesPerSecond'])} | "
            f"{_n(s['peak1sEnvelopesPerSecond'])} | {s['windowsSeen']} |"
        )
    out += [
        "",
        "| asset | series | GB/day | envelopes/s (est.) | p95 10 s env/s at opens | peak 10 s env/s at opens |",
        "|---|---|---|---|---|---|",
    ]
    for name, a in summary["perAsset"].items():
        o = a["atWindowOpens"]
        out.append(
            f"| {name} | {', '.join(a['series'])} | {_gb(a['bytesPerDay'])} | {_n(a['envelopesPerSecond'])} | "
            f"{_n(o['p95_10sEnvelopesPerSecond'])} | {_n(o['peak10sEnvelopesPerSecond'])} |"
        )
    total = summary["all"]
    aligned = total["atAlignedOpens"]
    anyo = total["atAnyOpen"]
    out += [
        "",
        "| all series | value |",
        "|---|---|",
        f"| GB/day (text payload) | {_gb(total['bytesPerDay'])} |",
        f"| bytes recorded | {_n(total['bytes'])} |",
        f"| envelopes/s (est.), mean | {_n(total['envelopesPerSecond'])} |",
        f"| p95 / peak 10 s env/s, whole recording | {_n(total['whole']['p95_10sEnvelopesPerSecond'])} / {_n(total['whole']['peak10sEnvelopesPerSecond'])} |",
        f"| aligned opens (quarter hours) counted | {aligned['opens']} |",
        f"| p95 / peak 10 s env/s at aligned opens | {_n(aligned['p95_10sEnvelopesPerSecond'])} / {_n(aligned['peak10sEnvelopesPerSecond'])} |",
        f"| p95 / peak 10 s bytes/s at aligned opens | {_n(aligned['p95_10sBytesPerSecond'], 0)} / {_n(aligned['peak10sBytesPerSecond'], 0)} |",
        f"| p95 / peak 10 s env/s at any open | {_n(anyo['p95_10sEnvelopesPerSecond'])} / {_n(anyo['peak10sEnvelopesPerSecond'])} |",
    ]
    raw = summary.get("rawFrames")
    if raw:
        ratio = raw["rawTextBytes"] / raw["gzipFileBytes"] if raw.get("gzipFileBytes") else None
        out.append(f"| raw text / gzip-{raw['gzipLevel']} files | {_gb(raw['rawTextBytes'])} GB / {_gb(raw['gzipFileBytes'])} GB ({_n(ratio, 2)}x) |")
    out += ["", "| connection | connects | disconnects | stale closes | subscribe / unsubscribe updates | connected s / wanted s | close reasons |", "|---|---|---|---|---|---|---|"]
    for name, c in summary.get("connections", {}).items():
        out.append(
            f"| {name} | {c['connects']} | {c['disconnects']} | {c['staleCloses']} | {c['subscribeUpdates']} / {c['unsubscribeUpdates']} | "
            f"{_n(c['connectedSeconds'], 0)} / {_n(c['wantedSeconds'], 0)} | {json.dumps(c['closeReasons'])} |"
        )
    gamma = summary.get("gamma", {})
    control = summary.get("control", {})
    out += [
        "",
        f"Gamma polls {gamma.get('polls')}, failures {gamma.get('failures')} {json.dumps(gamma.get('failureKinds', {}))}, "
        f"most in a row {gamma.get('maxConsecutiveFailures')}, truncated polls {gamma.get('truncatedPolls')}, "
        f"last OK {gamma.get('lastOk')} ({gamma.get('secondsSinceLastOk')} s before this summary), "
        f"skipped markets {len(gamma.get('skipped', {}))}. "
        f"PONG frames {control.get('pongFrames')}, unparsable frames {control.get('unparsableFrames')}, "
        f"unattributed events {control.get('unattributedEvents')}.",
    ]
    return "\n".join(out) + "\n"


def host(summary: dict[str, Any]) -> str:
    def st(block: Any, key: str = "mean") -> str:
        return "-" if not block else _n(block.get(key))

    out = [
        f"Host samples: {summary['samples']} from {summary['from']} to {summary['to']}, "
        f"median interval {summary['medianIntervalSeconds']} s; gaps over twice the interval: {len(summary['gaps'])}.",
        "",
        "| reading | min | mean | p95 | max |",
        "|---|---|---|---|---|",
    ]

    def row(label: str, block: Any) -> None:
        out.append(f"| {label} | {st(block, 'min')} | {st(block, 'mean')} | {st(block, 'p95')} | {st(block, 'max')} |")

    row("WSL CPU busy %", summary.get("cpuBusyPct"))
    row("WSL CPU iowait %", summary.get("cpuIowaitPct"))
    row("WSL CPU steal %", summary.get("cpuStealPct"))
    row("load average (1 min)", summary.get("load1"))
    row("WSL MemTotal MiB (the .wslconfig limit)", summary.get("memTotalMiB"))
    row("WSL MemAvailable MiB", summary.get("memAvailableMiB"))
    row("WSL swap used MiB", summary.get("swapUsedMiB"))
    for kind, block in summary.get("pressure", {}).items():
        row(f"PSI {kind} some avg60 %", block.get("someAvg60"))
    for name, block in summary.get("disk", {}).items():
        row(f"disk {name} write B/s", block.get("writeBytesPerSecond"))
        row(f"disk {name} util %", block.get("utilPct"))
    for name, block in summary.get("net", {}).items():
        row(f"net {name} rx B/s", block.get("rxBytesPerSecond"))
    for label, block in summary.get("fs", {}).items():
        row(f"free GiB, {label}", block.get("freeGiB"))
    for name, block in summary.get("processesRssMiB", {}).items():
        row(f"RSS MiB, {name}", block)
    for name, block in summary.get("processesCpuPct", {}).items():
        row(f"CPU % of one vCPU, {name}", block)
    windows = summary.get("windows", {})
    row("Windows % processor performance", windows.get("percentProcessorPerformance"))
    row("Windows processor frequency MHz", windows.get("processorFrequencyMHz"))
    row("Windows free physical memory KiB", windows.get("freePhysicalMemoryKiB"))
    row("vmmemWSL working set bytes", windows.get("vmmemWorkingSetBytes"))
    row("thermal zone K", windows.get("thermalKelvin"))
    row("thermal passive limit %", windows.get("thermalPercentPassiveLimit"))
    out += ["", "| totals | value |", "|---|---|"]
    for name, block in summary.get("disk", {}).items():
        out.append(f"| disk {name} bytes written | {_n(block.get('writtenBytesTotal'))} |")
    for name, block in summary.get("net", {}).items():
        out.append(f"| net {name} rx / tx bytes (WSL) | {_n(block.get('rxBytesTotal'))} / {_n(block.get('txBytesTotal'))} |")
    for name, block in windows.get("adapterBytes", {}).items():
        out.append(f"| Windows {name} received / sent bytes | {_n(block.get('receivedDelta'))} / {_n(block.get('sentDelta'))} |")
    for label, block in summary.get("fs", {}).items():
        out.append(f"| free GiB {label}, start / end (of {_n(block.get('totalGiB'))}) | {_n(block.get('freeGiBStart'))} / {_n(block.get('freeGiBEnd'))} |")
    out.append(f"| battery status counts (2 = on AC) | {json.dumps(windows.get('batteryStatusCounts', {}))} |")
    out.append(f"| Windows query errors | {windows.get('errors')} |")
    if summary["gaps"]:
        out += ["", "Gaps: " + ", ".join(f"{g['at']} ({g['intervalSeconds']} s)" for g in summary["gaps"])]
    lps = windows.get("perLogicalProcessor") or {}
    if lps:
        out += ["", "| Windows logical processor | busy % mean / max | performance % max |", "|---|---|---|"]
        for name, block in lps.items():
            out.append(f"| {name} | {st(block.get('busyPct'), 'mean')} / {st(block.get('busyPct'), 'max')} | {st(block.get('performancePct'), 'max')} |")
    return "\n".join(out) + "\n"


def trim(summary: dict[str, Any]) -> dict[str, Any]:
    trimmed = dict(summary)
    windows = trimmed.pop("windows", [])
    trimmed["windowsCount"] = len(windows)
    return trimmed


def main(argv: list[str]) -> int:
    if len(argv) != 2 or argv[0] not in ("recording", "host", "trim"):
        print(__doc__, file=sys.stderr)
        return 64
    with open(argv[1], encoding="utf-8") as handle:
        document = json.load(handle)
    if argv[0] == "recording":
        sys.stdout.write(recording(document))
    elif argv[0] == "host":
        sys.stdout.write(host(document))
    else:
        print(json.dumps(trim(document), indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
