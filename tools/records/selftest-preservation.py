#!/usr/bin/env python3
"""Show that check-preservation.py is not vacuous (LOGS-1).

Usage: python3 tools/records/selftest-preservation.py [--base <rev>] [--repo .]

Builds a scratch copy of the brief, the archive and the handoff index (everything
else is symlinked), confirms the unmodified copy passes, then applies one
mutation at a time and confirms the named proof FAILS. It also runs
check-brief.py mutations, and a synthetic re-cut: a commit (in a shared scratch
clone) that inserts a line above a rewritten region, re-split and re-mapped,
must PASS once its new line is declared, and FAIL without the declaration. The
repository itself is never modified. Exit 0 when every expectation holds.
Stdlib only, no network.
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
BRIEF = os.path.join(HERE, "check-brief.py")
SPLIT = os.path.join(HERE, "split-status.py")
MOVEMAP = os.path.join(HERE, "move-map.py")
ARCH = "docs/status-archive"


def shadow(repo, dst):
    """A tree under dst: copies of the files the mutations touch, symlinks for the rest."""
    copied_top = {"IMPLEMENTATION_STATUS.md", "docs", "AGENTS.md", "CLAUDE.md"}
    for name in os.listdir(repo):
        if name == ".git" or name in copied_top:
            continue
        os.symlink(os.path.join(repo, name), os.path.join(dst, name))
    for name in ("IMPLEMENTATION_STATUS.md", "AGENTS.md", "CLAUDE.md"):
        shutil.copy(os.path.join(repo, name), dst)
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


def drop_entry(heading):
    """Delete one whole REWRITES.md entry (from its ## heading to the next)."""
    def fn(text):
        i = text.index(f"\n## {heading}")
        j = text.index("\n## ", i + 1)
        return text[:i] + text[j:]
    return fn


def entry_range(text, heading):
    """The first old block's line range of an entry, as 'a-b'."""
    i = text.index(f"\n## {heading}")
    return re.search(r"~~~old lines=(\d+-\d+)", text[i:]).group(1)


def drop_entry_and_declare(heading, kind):
    """Delete an entry and declare its old range unpaired, with the given kind."""
    def fn(text):
        rng = entry_range(text, heading)
        text = drop_entry(heading)(text)
        return text.replace("~~~unpaired\n", f"~~~unpaired\n{rng} {kind}\n", 1)
    return fn


def same_facts(a, b):
    """Give entry b the Facts account of entry a (boilerplate)."""
    def fn(text):
        facts = re.findall(r"^\*\*Facts\.\*\*.*$", text, flags=re.M)
        fa = next(f for f in facts if text.index(f) > text.index(f"\n## {a}"))
        fb = next(f for f in facts if text.index(f) > text.index(f"\n## {b}"))
        return text.replace(fb, fa, 1)
    return fn


def cut_after_region(text):
    """Remove the generated link note after the verbatim-end marker."""
    end = "<!-- verbatim-end -->\n"
    return text[:text.index(end) + len(end)]


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
    ("delete a whole REWRITES entry (an open residual)", f"{ARCH}/REWRITES.md",
     drop_entry("RW-67: Residual `BRACKET1B-RECON`"), "C", "C8:"),
    ("delete that entry and declare its row history", f"{ARCH}/REWRITES.md",
     drop_entry_and_declare("RW-67: Residual `BRACKET1B-RECON`", "history open-blockers-2026-09.md"), "C", "C8:"),
    ("delete that entry and declare its row closed", f"{ARCH}/REWRITES.md",
     drop_entry_and_declare("RW-67: Residual `BRACKET1B-RECON`", "closed-row `BRACKET1B-RECON`"), "C", "C8:"),
    ("give two entries one Facts account", f"{ARCH}/REWRITES.md",
     same_facts("RW-66:", "RW-67:"), "C", "C9:"),
    ("drop a restored condition from the brief", "IMPLEMENTATION_STATUS.md",
     lambda t: t.replace(" covers the first two round trips if it lands as specified;", " covers the first two round trips;", 1), "C", "C10:"),
    ("remove the rewrites-base pin", f"{ARCH}/REWRITES.md",
     lambda t: re.sub(r"<!-- rewrites-base: [0-9a-f]{40} -->\n", "", t, count=1), "C", "C6:"),
    ("drop the link note after an archived region", f"{ARCH}/cross-package-schema-risk.md",
     cut_after_region, "C", "C4:"),
    ("send the discharged CI bullet back to Pending", f"{ARCH}/MOVE-MAP.md",
     lambda t: t.replace("| Resolved evidence items (discharged; not repeated under Pending external evidence) |",
                         "| Pending external evidence |", 1), "C", "C5:"),
]

# check-brief.py mutations: (name, file, mutation, the report line that must appear)
BRIEF_MUTATIONS = [
    ("promise one line per item", "IMPLEMENTATION_STATUS.md",
     lambda t: t.replace("one entry per item", "one line per item", 1), "K3:"),
    ("a bare runbook line cite", "IMPLEMENTATION_STATUS.md",
     lambda t: t.replace("(`:509` at `f43efe6`)", "(runbook :509)", 1), "K4:"),
    ("a residual row with no owner", "IMPLEMENTATION_STATUS.md",
     lambda t: t.replace("| a tooling round |", "| — |", 1), "K5:"),
    ("a completed track in the residual table", "IMPLEMENTATION_STATUS.md",
     lambda t: t.replace("| `§5 item 6` |", "| `H8 track` | Complete (B3 closed). | the user |\n| `§5 item 6` |", 1), "K9:"),
    ("drop the green CI gate from VENUE-3", "IMPLEMENTATION_STATUS.md",
     lambda t: t.replace("  - Gate: the Fable adversarial review (re-fetch) and a green CI run on GitHub.\n", "", 1), "K13:"),
    ("AGENTS.md without 'frozen'", "AGENTS.md",
     lambda t: t.replace("archived verbatim, and frozen, under", "archived verbatim under", 1), "K11:"),
    ("README rule 10 back to 'add one line'", "docs/handoffs/README.md",
     lambda t: t.replace("add or update the handoff's single row in", "add one line to", 1), "K12:"),
    ("the archive README claims complete rewrites", f"{ARCH}/README.md",
     lambda t: t.replace("C authenticates what `REWRITES.md` says. It cannot tell whether a rewrite kept every fact; that is a review question.",
                         "the move map and rewrites are complete and verbatim.", 1), "K14:"),
    ("exceed the 15% budget", "IMPLEMENTATION_STATUS.md",
     lambda t: t + ("filler " * 9000) + "\n", "K1:"),
]


def run(repo, root, base, only, tool=CHECK):
    cmd = [sys.executable, tool, "--base", base, "--repo", repo, "--root", root]
    if tool == CHECK:
        cmd += ["--only", only]
    r = subprocess.run(cmd, capture_output=True, text=True)
    return r.returncode, r.stdout + r.stderr


def git(repo, *args, env=None, stdin=None):
    return subprocess.run(["git", "-C", repo, *args], check=True, capture_output=True, text=True,
                          env=env, input=stdin).stdout.strip()


def recut(repo, tmp, base, declare):
    """A synthetic re-cut: insert one line above the first rewritten region, then re-split and re-map.

    Returns (exit code, output) of check-preservation.py at the new cut. With
    declare=True the inserted line is declared in an unpaired block that names
    the cut; existing REWRITES.md blocks are NOT renumbered.
    """
    clone = os.path.join(tmp, f"clone-{declare}")
    subprocess.run(["git", "clone", "--quiet", "--shared", "--no-checkout", repo, clone], check=True)
    old = git(clone, "show", f"{base}:IMPLEMENTATION_STATUS.md") + "\n"
    lines = old.split("\n")
    new = "\n".join(lines[:4] + ["Inserted by the self-test: a synthetic re-cut."] + lines[4:])
    env = dict(os.environ, GIT_INDEX_FILE=os.path.join(tmp, f"index-{declare}"),
               GIT_AUTHOR_NAME="selftest", GIT_AUTHOR_EMAIL="selftest@invalid", GIT_AUTHOR_DATE="2026-01-01T00:00:00Z",
               GIT_COMMITTER_NAME="selftest", GIT_COMMITTER_EMAIL="selftest@invalid", GIT_COMMITTER_DATE="2026-01-01T00:00:00Z")
    blob = git(clone, "hash-object", "-w", "--stdin", stdin=new)
    git(clone, "read-tree", base, env=env)
    git(clone, "update-index", "--cacheinfo", f"100644,{blob},IMPLEMENTATION_STATUS.md", env=env)
    tree = git(clone, "write-tree", env=env)
    cut = git(clone, "commit-tree", tree, "-p", base, "-m", "selftest re-cut", env=env)
    root = os.path.join(tmp, f"recut-{declare}")
    os.mkdir(root)
    shadow(repo, root)
    subprocess.run([sys.executable, SPLIT, "--base", cut, "--repo", clone, "--out", os.path.join(root, ARCH)],
                   check=True, capture_output=True)
    subprocess.run([sys.executable, MOVEMAP, "--base", cut, "--repo", clone, "--root", root], check=True, capture_output=True)
    if declare:
        edit(os.path.join(root, ARCH, "REWRITES.md"),
             lambda t: t.replace("~~~unpaired\n", f"~~~unpaired base={cut}\n5-5 history header-and-phase.md\n~~~\n\n~~~unpaired\n", 1))
    return run(clone, root, cut, "A,B,C")


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
        code, out = run(repo, clean, base, "", tool=BRIEF)
        print(f"[{'ok' if code == 0 else 'UNEXPECTED'}] unmodified copy passes check-brief.py (exit {code})")
        ok &= code == 0
        for k, (name, rel, fn, expect) in enumerate(BRIEF_MUTATIONS, 1):
            root = os.path.join(tmp, f"k{k}")
            os.mkdir(root)
            shadow(repo, root)
            edit(os.path.join(root, rel), fn)
            code, out = run(repo, root, base, "", tool=BRIEF)
            hit = code == 1 and expect in out
            ok &= hit
            detail = next((l.strip() for l in out.split("\n") if expect in l), "no matching line")
            print(f"[{'ok' if hit else 'UNEXPECTED'}] check-brief: {name}: exit {code}; {detail[:150]}")
        code, out = recut(repo, tmp, base, declare=True)
        hit = code == 0 and "C6:" not in out
        ok &= hit
        print(f"[{'ok' if hit else 'UNEXPECTED'}] re-cut with a line inserted above a rewritten region, declared: exit {code}; "
              + next((l.strip() for l in out.split("\n") if l.startswith("Proof C")), "")[:150])
        if not hit:
            print(out)
        code, out = recut(repo, tmp, base, declare=False)
        hit = code == 1 and "C8:" in out and "C6:" not in out
        ok &= hit
        detail = next((l.strip() for l in out.split("\n") if "C8:" in l), "no matching line")
        print(f"[{'ok' if hit else 'UNEXPECTED'}] the same re-cut without declaring the new line: exit {code}; {detail[:150]}")
    print("SELFTEST: " + ("PASS" if ok else "FAIL"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
