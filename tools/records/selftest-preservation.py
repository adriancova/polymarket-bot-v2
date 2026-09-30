#!/usr/bin/env python3
"""Show that check-preservation.py is not vacuous (LOGS-1).

Usage: python3 tools/records/selftest-preservation.py [--base <rev>] [--repo .]

Builds a scratch copy of the brief, the archive and the handoff index (everything
else is symlinked), confirms the unmodified copy passes, then applies one
mutation at a time and confirms the named proof FAILS. The repository itself is
never modified. Exit 0 when every expectation holds. Stdlib only, no network.
"""

import argparse
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
CHECK = os.path.join(HERE, "check-preservation.py")
ARCH = "docs/status-archive"


def shadow(repo, dst):
    """A tree under dst: copies of the files the mutations touch, symlinks for the rest."""
    copied_top = {"IMPLEMENTATION_STATUS.md", "docs"}
    for name in os.listdir(repo):
        if name == ".git" or name in copied_top:
            continue
        os.symlink(os.path.join(repo, name), os.path.join(dst, name))
    shutil.copy(os.path.join(repo, "IMPLEMENTATION_STATUS.md"), dst)
    os.mkdir(os.path.join(dst, "docs"))
    for name in os.listdir(os.path.join(repo, "docs")):
        if name in ("status-archive", "handoffs"):
            continue
        os.symlink(os.path.join(repo, "docs", name), os.path.join(dst, "docs", name))
    shutil.copytree(os.path.join(repo, ARCH), os.path.join(dst, ARCH))
    os.mkdir(os.path.join(dst, "docs/handoffs"))
    for name in os.listdir(os.path.join(repo, "docs/handoffs")):
        src = os.path.join(repo, "docs/handoffs", name)
        if name in ("INDEX.md", "README.md"):
            shutil.copy(src, os.path.join(dst, "docs/handoffs", name))
        else:
            os.symlink(src, os.path.join(dst, "docs/handoffs", name))


def edit(path, fn):
    with open(path, encoding="utf-8") as fh:
        text = fh.read()
    new = fn(text)
    if new == text:
        raise SystemExit(f"mutation did not change {path}")
    with open(path, "w", encoding="utf-8", newline="") as fh:
        fh.write(new)


def drop_line(pattern, nth=0):
    """Delete the nth line matching pattern (a regex)."""
    def fn(text):
        lines = text.split("\n")
        hits = [i for i, l in enumerate(lines) if re.search(pattern, l)]
        del lines[hits[nth]]
        return "\n".join(lines)
    return fn


def region_line(text, pattern, nth=0):
    """Index of the nth line matching pattern inside the verbatim region."""
    lines = text.split("\n")
    begin = next(i for i, l in enumerate(lines) if l.startswith("<!-- verbatim-begin"))
    hits = [i for i, l in enumerate(lines) if i > begin and re.search(pattern, l) and not l.startswith("<!--")]
    return lines, hits[nth]


def archive_drop(pattern, nth=0):
    def fn(text):
        lines, i = region_line(text, pattern, nth)
        del lines[i]
        return "\n".join(lines)
    return fn


def archive_flip_char(pattern):
    def fn(text):
        lines, i = region_line(text, pattern)
        line = lines[i]
        j = next(k for k, c in enumerate(line) if c.isalpha())
        lines[i] = line[:j] + ("X" if line[j] != "X" else "Y") + line[j + 1:]
        return "\n".join(lines)
    return fn


# (name, file, mutation, proof selection, the report line that must say FAIL)
MUTATIONS = [
    ("delete one residual row from the archive", f"{ARCH}/open-blockers-2026-09.md",
     archive_drop(r"^\| \*\*SIM2-FILTER\*\*"), "A", "Proof A: FAIL"),
    ("the same deletion, Proof B alone (the row is also quoted in REWRITES.md)", f"{ARCH}/open-blockers-2026-09.md",
     archive_drop(r"^\| \*\*SIM2-FILTER\*\*"), "B", "Proof B: FAIL"),
    ("delete ONE of the many duplicate '**Scope:**' lines, Proof B alone", f"{ARCH}/work-packages-rounds.md",
     archive_drop(r"^\*\*Scope:\*\*$", 3), "B", "Proof B: FAIL"),
    ("alter one character inside an archive region", f"{ARCH}/deviations-evidence-gates.md",
     archive_flip_char(r"^- \*\*N9"), "A", "Proof A: FAIL"),
    ("drop a package row from the brief", "IMPLEMENTATION_STATUS.md",
     drop_line(r"^\| `WP-110` \|"), "C", "C1:"),
    ("drop an open residual from the brief", "IMPLEMENTATION_STATUS.md",
     drop_line(r"^\| `SIM2-FILTER` \|"), "C", "C2:"),
    ("drop a closed id from the brief's closed list", "IMPLEMENTATION_STATUS.md",
     lambda t: t.replace("`RISK2-R4`, `RECON1-SCAN`, `RECON1-ORIGIN`, ", "`RISK2-R4`, `RECON1-SCAN`, ", 1), "C", "C2:"),
    ("put an unknown SHA into the brief", "IMPLEMENTATION_STATUS.md",
     lambda t: t.replace("| `WP-110` |", "| `WP-110` (see `abcdef0`) |", 1), "C", "C3:"),
    ("break a link in the brief", "IMPLEMENTATION_STATUS.md",
     lambda t: t.replace("(docs/handoffs/WP-110.md)", "(docs/handoffs/WP-111.md)", 1), "C", "C4:"),
    ("remove a heading from the move map", f"{ARCH}/MOVE-MAP.md",
     drop_line(r"^\| ## Deviations from specification \|"), "C", "C5:"),
    ("alter one old line in REWRITES.md", f"{ARCH}/REWRITES.md",
     lambda t: t.replace("~~~old lines=3-3\nLast updated: 2026-09-15", "~~~old lines=3-3\nLast updated: 2026-09-16", 1),
     "C", "C6:"),
    ("drop a handoff from the index", "docs/handoffs/INDEX.md",
     drop_line(r"\[H1-RUN-1\.md\]"), "C", "C7:"),
]


def run(repo, root, base, only):
    r = subprocess.run([sys.executable, CHECK, "--base", base, "--repo", repo, "--root", root, "--only", only],
                       capture_output=True, text=True)
    return r.returncode, r.stdout + r.stderr


def main() -> int:
    ap = argparse.ArgumentParser(description="non-vacuity self-test for check-preservation.py")
    ap.add_argument("--base", default=None, help="default: the cut recorded in the archive markers")
    ap.add_argument("--repo", default=".")
    args = ap.parse_args()
    repo = os.path.abspath(args.repo)
    base = args.base
    if base is None:
        with open(os.path.join(repo, ARCH, "header-and-phase.md"), encoding="utf-8") as fh:
            base = re.search(r"base=([0-9a-f]{40})", fh.read()).group(1)
    ok = True
    with tempfile.TemporaryDirectory() as tmp:
        clean = os.path.join(tmp, "clean")
        os.mkdir(clean)
        shadow(repo, clean)
        code, out = run(repo, clean, base, "A,B,C")
        print(f"[{'ok' if code == 0 else 'UNEXPECTED'}] unmodified copy passes (exit {code})")
        ok &= code == 0
        for k, (name, rel, fn, only, expect) in enumerate(MUTATIONS, 1):
            root = os.path.join(tmp, f"m{k}")
            os.mkdir(root)
            shadow(repo, root)
            edit(os.path.join(root, rel), fn)
            code, out = run(repo, root, base, only)
            hit = code == 1 and expect in out
            ok &= hit
            detail = next((l.strip() for l in out.split("\n") if expect in l), "no matching line")
            print(f"[{'ok' if hit else 'UNEXPECTED'}] {name}: exit {code}; {detail[:150]}")
    print("SELFTEST: " + ("PASS" if ok else "FAIL"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
