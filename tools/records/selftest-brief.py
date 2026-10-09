#!/usr/bin/env python3
"""Show that check-brief.py is not vacuous.

Usage: python3 tools/records/selftest-brief.py [--repo .]

Builds a scratch tree: copies of the files the mutations edit, symlinks for the rest. It confirms the
unmodified copy passes, then applies one mutation at a time and confirms the named rule FAILS
(MUTATIONS), and that some edits still PASS (PASSES). The repository itself is never modified: a
mutation that would write through a symlink is refused. Exit 0 when every expectation holds.
Stdlib only, no network.
"""

import argparse
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
BRIEF = os.path.join(HERE, "check-brief.py")
STATUS = "IMPLEMENTATION_STATUS.md"
RESIDUALS = "docs/handoffs/RESIDUALS.md"
INDEX = "docs/handoffs/INDEX.md"
COPIED = {"docs/handoffs/INDEX.md", "docs/handoffs/README.md", "docs/handoffs/RESIDUALS.md"}


def shadow(repo, dst):
    """A tree under dst: a copy of the brief and of COPIED, symlinks for everything else."""
    for name in os.listdir(repo):
        if name not in (".git", STATUS, "docs"):
            os.symlink(os.path.join(repo, name), os.path.join(dst, name))
    shutil.copy(os.path.join(repo, STATUS), dst)
    os.mkdir(os.path.join(dst, "docs"))
    for name in os.listdir(os.path.join(repo, "docs")):
        if name != "handoffs":
            os.symlink(os.path.join(repo, "docs", name), os.path.join(dst, "docs", name))
    os.mkdir(os.path.join(dst, "docs/handoffs"))
    for name in os.listdir(os.path.join(repo, "docs/handoffs")):
        src, rel = os.path.join(repo, "docs/handoffs", name), f"docs/handoffs/{name}"
        if rel in COPIED:
            shutil.copy(src, os.path.join(dst, rel))
        else:
            os.symlink(src, os.path.join(dst, rel))


def edit(path, fn):
    if os.path.islink(path):
        raise SystemExit(f"refusing to write through a symlink: {path}")
    text = open(path, encoding="utf-8").read() if os.path.exists(path) else ""
    new = fn(text)
    if new == text:
        raise SystemExit(f"mutation did not change {path}")
    with open(path, "w", encoding="utf-8", newline="") as fh:
        fh.write(new)


def replace(old, new):
    def fn(text):
        if old not in text:
            raise SystemExit(f"mutation anchor not found: {old[:60]!r}")
        return text.replace(old, new, 1)
    return fn


def drop_line(needle):
    """Delete the first table line that contains needle."""
    def fn(text):
        lines = text.split("\n")
        i = next(k for k, l in enumerate(lines) if l.startswith("|") and needle in l)
        del lines[i]
        return "\n".join(lines)
    return fn


def new_file(content):
    def fn(text):
        if text:
            raise SystemExit("new_file: the file already exists")
        return content
    return fn


SWEEP = "- **The inherited-`toJSON` sweep is complete:**"


def before_sweep(line):
    """Insert a brief line above the Current phase bullet that says the toJSON sweep is complete."""
    return replace(SWEEP, line + "\n" + SWEEP)


def before_catch_all(row):
    """Insert a Work packages row above the catch-all row."""
    return replace("| All other packages not in", row + "\n| All other packages not in")


def residual_owner_dash(text):
    """Blank the owner cell of RESIDUALS.md's first table row."""
    lines = text.split("\n")
    i = next(k for k, l in enumerate(lines) if l.startswith("| `"))
    cells = lines[i].split(" | ")
    cells[2] = "—"
    lines[i] = " | ".join(cells)
    return "\n".join(lines)


# (name, [(file, mutation)], the report line that must appear)
MUTATIONS = [
    ("the brief over 30 KB", [(STATUS, lambda t: t + "\n" + "x" * 12_000 + "\n")], "K1:"),
    ("the brief loses its Human items section", [(STATUS, replace("## Human items", "## People items"))],
     "K2: the brief has no section '## Human items'"),
    ("the safety state weakens one default", [(STATUS, replace("- `ALLOW_REAL_ORDERS=false`", "- `ALLOW_REAL_ORDERS=true`"))],
     "K2: the brief's safety state lacks '- `ALLOW_REAL_ORDERS=false`'"),
    ("the run-mode line changes", [(STATUS, replace("Maximum permitted run mode: `PAPER`", "Maximum permitted run mode: `LIVE`"))],
     "K2: the brief lacks"),
    ("RESIDUALS.md loses its live table", [(RESIDUALS, replace("## Before any live mode", "## Later"))],
     "K2: docs/handoffs/RESIDUALS.md has no section '## Before any live mode'"),
    ("a residual row with no owner", [(RESIDUALS, residual_owner_dash)], "K5: docs/handoffs/RESIDUALS.md"),
    ("a closeout blocker with no owner", [(STATUS, replace("| `BOOT-1` ✓; R10 for resume |", "| — |"))],
     "K5: IMPLEMENTATION_STATUS.md"),
    ("a Complete row in the Work packages table",
     [(STATUS, before_catch_all("| `V2-98` | a package | Complete (2026-10-08) | `abcdef0` | — |"))], "K38:"),
    ("the brief names a package with no INDEX.md row as complete",
     [(STATUS, before_sweep("- `V2-99` is complete."))], "K39: line"),
    ("'complete: A, B' names every id after the colon",
     [(STATUS, before_sweep("- The cleanup is complete: `WP-010` and `V2-99`."))], "names V2-99 as Complete"),
    ("INDEX.md loses DEPS-1's row, which has no handoff (K40 reads the archived tables)",
     [(INDEX, drop_line("| `DEPS-1`: CI health"))], "K40: DEPS-1 is Complete in the archive"),
    ("INDEX.md links a handoff file that does not exist",
     [(INDEX, replace("| [WP-010.md](WP-010.md) |", "| [WP-010.md](WP-011.md) |"))], "links WP-011.md, which does not exist"),
    ("INDEX.md loses WP-140's row: its brief row links its handoff, so it is no draft",
     [(INDEX, drop_line("| [WP-140.md](WP-140.md) |"))], "K40: docs/handoffs/WP-140.md has no docs/handoffs/INDEX.md row"),
    ("a new handoff file with no INDEX.md row", [("docs/handoffs/V2-99.md", new_file("# V2-99\n"))],
     "K40: docs/handoffs/V2-99.md has no docs/handoffs/INDEX.md row"),
    ("an INDEX.md row with no brief row whose outcome is not complete",
     [(INDEX, replace("| Complete (2026-08-22) | `12ce0ab` |", "| Running | `12ce0ab` |"))], "K41:"),
]

# Edits that must still PASS.
PASSES = [
    ("'The sweep is complete, and `V2-99` is running.' names no package",
     [(STATUS, before_sweep("- The sweep is complete, and `V2-99` is running."))]),
    ("'`V2-1` is Complete, and `V2-99` runs beside it.' names V2-1 only",
     [(STATUS, before_sweep("- `V2-1` is Complete, and `V2-99` runs beside it."))]),
    ("'`V2-99` runs until `V2-98` is complete.' is a condition, not a completion",
     [(STATUS, before_sweep("- `V2-99` runs until `V2-98` is complete."))]),
    ("'`V2-99` is not complete.' (hedges are skipped)", [(STATUS, before_sweep("- `V2-99` is not complete."))]),
    ("a handoff drafted for a package still open in the brief needs no INDEX.md row yet",
     [(STATUS, before_catch_all("| `V2-98` | a package | **Running** (authorized 2026-10-06) | — | — |")),
      ("docs/handoffs/V2-98.md", new_file("# V2-98\n"))]),
]


def run(root):
    r = subprocess.run([sys.executable, BRIEF, "--root", root], capture_output=True, text=True)
    return r.returncode, r.stdout + r.stderr


def main() -> int:
    ap = argparse.ArgumentParser(description="non-vacuity self-test for check-brief.py")
    ap.add_argument("--repo", default=".")
    repo = os.path.abspath(ap.parse_args().repo)
    ok = True
    with tempfile.TemporaryDirectory() as tmp:
        def tree(name, edits):
            root = os.path.join(tmp, name)
            os.mkdir(root)
            shadow(repo, root)
            for rel, fn in edits:
                edit(os.path.join(root, rel), fn)
            return run(root)

        code, out = tree("clean", [])
        print(f"[{'ok' if code == 0 else 'UNEXPECTED'}] the unmodified copy passes (exit {code})")
        ok &= code == 0
        for k, (name, edits, expect) in enumerate(MUTATIONS, 1):
            code, out = tree(f"m{k}", edits)
            hit = code == 1 and expect in out
            ok &= hit
            detail = next((l.strip() for l in out.split("\n") if expect in l), "no matching line")
            print(f"[{'ok' if hit else 'UNEXPECTED'}] fails: {name}: exit {code}; {detail[:140]}")
        for k, (name, edits) in enumerate(PASSES, 1):
            code, out = tree(f"p{k}", edits)
            ok &= code == 0
            detail = "; ".join(l.strip() for l in out.split("\n") if l.startswith("  K"))
            print(f"[{'ok' if code == 0 else 'UNEXPECTED'}] passes: {name}: exit {code}" + (f"; {detail[:140]}" if detail else ""))
    print("SELFTEST: " + ("PASS" if ok else "FAIL"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
