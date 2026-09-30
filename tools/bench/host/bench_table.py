#!/usr/bin/env python3
"""Tabulates trader-throughput bench runs (tools/bench/trader-throughput) as Markdown.

    python3 bench_table.py ROOT [--json]

Finds every `report.json` under ROOT (the harness writes one per run, in
`<out-dir>/<stream>/report.json`), and prints one row per run, labelled with
its out-dir's name (for example `catch-up-1`), in label order. Adds a
min/median/max line per group, where a label's group is the label with a
trailing `-<number>` removed (`catch-up-1` .. `catch-up-3` -> `catch-up`).

CPU µs/event is `cpuMs * 1000 / consumed`: the bench process's CPU time over
the measured window, per consumed event (the harness prints the same figure).
Standard library only.
"""

from __future__ import annotations

import argparse
import json
import re
import statistics
import sys
from pathlib import Path
from typing import Any

GROUP = re.compile(r"-\d+$")


def load_runs(root: Path) -> list[dict[str, Any]]:
    runs = []
    for path in sorted(root.rglob("report.json")):
        report = json.loads(path.read_text(encoding="utf-8"))
        # <root>/<label>/<stream>/report.json; a run directly under root is labelled by its stream.
        label = path.parent.parent.name if path.parent.parent.resolve() != root.resolve() else path.parent.name
        runs.append(row(label, report))
    return sorted(runs, key=lambda r: r["label"])


def row(label: str, report: dict[str, Any]) -> dict[str, Any]:
    consumed = report.get("consumed") or 0
    lag = report.get("lag") or {}
    return {
        "label": label,
        "group": GROUP.sub("", label),
        "mode": report.get("mode"),
        "stopped": report.get("stopped"),
        "consumed": consumed,
        "events": report.get("events"),
        "wallSeconds": round((report.get("wallMs") or 0) / 1000, 2),
        "eventsPerSecond": round(report.get("eventsPerSecond") or 0.0, 1),
        "cpuMicrosPerEvent": round((report.get("cpuMs") or 0) * 1000 / consumed) if consumed else None,
        "lagMaxSeconds": round((lag.get("maxMs") or 0) / 1000, 3),
        "lagP99Seconds": round((lag.get("p99Ms") or 0) / 1000, 3),
        "lagP50Seconds": round((lag.get("p50Ms") or 0) / 1000, 3),
        "halts": len(report.get("halts") or []),
        "framesSplit": report.get("framesSplit"),
        "decisions": (report.get("durable") or {}).get("decisions"),
        "normalizedDecisionSha256": ((report.get("durable") or {}).get("normalizedDecisionContentSha256") or "")[:12],
        "profiled": report.get("cpuProfile") is not None,
    }


COLUMNS = [
    ("label", "run"),
    ("mode", "mode"),
    ("stopped", "stopped"),
    ("consumed", "consumed"),
    ("eventsPerSecond", "events/s"),
    ("cpuMicrosPerEvent", "CPU µs/event"),
    ("lagMaxSeconds", "max lag s"),
    ("lagP99Seconds", "p99 lag s"),
    ("lagP50Seconds", "p50 lag s"),
    ("halts", "halts"),
    ("decisions", "decisions"),
    ("normalizedDecisionSha256", "decisions sha256 (norm.)"),
    ("profiled", "profiled"),
]


def markdown(runs: list[dict[str, Any]]) -> str:
    lines = ["| " + " | ".join(title for _, title in COLUMNS) + " |", "|" + "---|" * len(COLUMNS)]
    for run in runs:
        lines.append("| " + " | ".join(str(run[key]) for key, _ in COLUMNS) + " |")
    groups: dict[str, list[dict[str, Any]]] = {}
    for run in runs:
        if not run["profiled"]:
            groups.setdefault(run["group"], []).append(run)
    if groups:
        lines += ["", "| group (unprofiled) | runs | events/s min / median / max | CPU µs/event min / median / max | max lag s min / median / max |", "|---|---|---|---|---|"]
        for name in sorted(groups):
            members = groups[name]

            def spread(key: str) -> str:
                values = [m[key] for m in members if m[key] is not None]
                if not values:
                    return "-"
                return f"{min(values)} / {round(statistics.median(values), 3)} / {max(values)}"

            lines.append(f"| {name} | {len(members)} | {spread('eventsPerSecond')} | {spread('cpuMicrosPerEvent')} | {spread('lagMaxSeconds')} |")
    return "\n".join(lines) + "\n"


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("root")
    parser.add_argument("--json", action="store_true", help="print the rows as JSON instead")
    args = parser.parse_args(argv)
    runs = load_runs(Path(args.root))
    if not runs:
        print(f"no report.json under {args.root}", file=sys.stderr)
        return 1
    if args.json:
        print(json.dumps(runs, indent=2))
    else:
        sys.stdout.write(markdown(runs))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
