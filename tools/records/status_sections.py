"""Shared definitions for the LOGS-1 status-archive tools (Python 3 stdlib only).

The archive is a pure function of (the base IMPLEMENTATION_STATUS.md, SECTIONS).
Each section starts at the first line that matches its rule, searched in order,
so the sections are contiguous and partition the base file exactly. Rules key on
headings and row ids, never on line numbers, so a later base (with rows added on
main) splits the same way.
"""

import hashlib
import re
import subprocess

STATUS = "IMPLEMENTATION_STATUS.md"
ARCHIVE = "docs/status-archive"

# (archive file, title, rule kind, rule text, one-line description)
# kind: "first" = the file's first line; "eq" = the whole line; "prefix" = line prefix.
SECTIONS = [
    ("header-and-phase.md", "Header, current phase and safety state", "first", "",
     "the old title block, including the long current-phase sentence, and the safety state"),
    ("work-packages-waves-0-2.md", "Work packages: Waves 0-2 rows", "eq", "## Work packages",
     "the work-package table header and the full rows `WP-000` to `WP-250`"),
    ("work-packages-rounds.md", "Work packages: rounds since 2026-09-06", "prefix", "| `WP-180-FU3`",
     "the full rows `WP-180-FU3` to `VENUE-3`, `WP-260`, \"All other packages\" and the authorization vocabulary"),
    ("completion-records-wave-1.md", "Completion records: Wave 1 and Wave 2 batch 2A", "prefix", "### WP-170 completion record",
     "completion records `WP-170` to `WP-100` and the Wave 1 batch 1B phase-gate record"),
    ("wave-1-batch-1b-in-flight.md", "Wave 1 batch 1B in-flight records", "prefix", "### Wave 1 batch 1B in-flight records",
     "the batch 1B in-flight records (2026-08-27)"),
    ("completion-records-wave-0.md", "Completion records: Wave 0", "prefix", "### WP-060 completion record",
     "completion records `WP-060` (with its review history) to `WP-010`"),
    ("wave-0-closeout-and-reviews.md", "Wave 0 closeout, review history and accepted evidence", "prefix", "## Wave 0 closeout",
     "the Wave 0 closeout, the Wave 0 review history, the `WP-000` in-flight record and the accepted evidence"),
    ("wave-2-qualification.md", "Wave 2 qualification and superseded header sentences", "prefix", "## Wave 2 qualification",
     "the superseded header sentences and what \"Wave 2 COMPLETE\" means"),
    ("open-blockers-2026-09.md", "Open blockers: closeout blockers and the full residual queue", "eq", "## Open blockers",
     "the open-blockers intro, the closeout blockers and every residual-queue row, open and closed, in full"),
    ("cross-package-schema-risk.md", "Cross-package schema-boundary record", "prefix", "### The cross-package record below, reconciled",
     "the 2026-09-15 reconciliation and the 2026-09-03 cross-package risk record"),
    ("deviations-evidence-gates.md", "Deviations, evidence and gates", "eq", "## Deviations from specification",
     "the full deviation bullets, pending and resolved evidence, and the human and operational gates"),
]

BEGIN_RE = re.compile(
    r"^<!-- verbatim-begin source=(?P<source>\S+) base=(?P<base>[0-9a-f]{40}) "
    r"lines=(?P<a>\d+)-(?P<b>\d+) sha256=(?P<sha>[0-9a-f]{64}) -->$"
)
END_LINE = "<!-- verbatim-end -->"


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def git(repo: str, *args: str) -> bytes:
    return subprocess.run(["git", "-C", repo, *args], check=True, capture_output=True).stdout


def resolve(repo: str, rev: str) -> str:
    return git(repo, "rev-parse", "--verify", rev + "^{commit}").decode().strip()


def base_text(repo: str, sha: str) -> str:
    return git(repo, "show", f"{sha}:{STATUS}").decode("utf-8")


def split_lines(text: str) -> list:
    """Lines with their terminators, so that ''.join(result) == text."""
    return text.splitlines(keepends=True)


def section_starts(lines: list) -> list:
    """0-based start index of each SECTIONS entry; raises on a missing or out-of-order rule."""
    starts = []
    pos = 0
    for name, _title, kind, rule, _desc in SECTIONS:
        if kind == "first":
            idx = 0
        else:
            idx = None
            for i in range(pos, len(lines)):
                line = lines[i].rstrip("\n")
                if (kind == "eq" and line == rule) or (kind == "prefix" and line.startswith(rule)):
                    idx = i
                    break
            if idx is None:
                raise SystemExit(f"split rule for {name} ({kind} {rule!r}) matched nothing after line {pos + 1}")
        if starts and idx <= starts[-1]:
            raise SystemExit(f"split rule for {name} is out of order")
        starts.append(idx)
        pos = idx + 1
    return starts


def extract_region(path: str):
    """Return (attrs, region_text) for one archive file, or raise ValueError."""
    with open(path, encoding="utf-8") as fh:
        text = fh.read()
    lines = split_lines(text)
    begins = [i for i, l in enumerate(lines) if l.startswith("<!-- verbatim-begin")]
    ends = [i for i, l in enumerate(lines) if l.rstrip("\n") == END_LINE]
    if len(begins) != 1 or len(ends) < 1:
        raise ValueError(f"{path}: expected one verbatim-begin and a verbatim-end marker")
    m = BEGIN_RE.match(lines[begins[0]].rstrip("\n"))
    if not m:
        raise ValueError(f"{path}: malformed verbatim-begin marker")
    end = ends[-1]
    if end <= begins[0]:
        raise ValueError(f"{path}: verbatim-end precedes verbatim-begin")
    outside = [l for l in lines[:begins[0]] + lines[end + 1:] if l.strip()]
    if len(outside) > 2:
        raise ValueError(f"{path}: more than a title and a provenance note outside the markers")
    return m.groupdict(), "".join(lines[begins[0] + 1:end])
