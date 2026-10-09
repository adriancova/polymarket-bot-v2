#!/usr/bin/env python3
"""Check the brief, the residual list and the handoff index for the few things that go wrong in practice.

Usage: python3 tools/records/check-brief.py [--root .]

K1  IMPLEMENTATION_STATUS.md is at most 30 KB (30,000 bytes).
K2  the brief has the sections an agent needs before acting, its safety state is verbatim, and
    docs/handoffs/RESIDUALS.md has its two tables: "Affects PAPER" and "Before any live mode".
K5  every closeout-blocker row in the brief, and every RESIDUALS.md row, has an owner cell that is not "—".
K38 no Work packages row's status starts "Complete": a completed package's row leaves the brief, and its
    INDEX.md row carries it (docs/handoffs/README.md rules 1 and 10).
K39 every package the brief names as Complete has an INDEX.md row. A completion is "complete" or
    "completed" (any case) after "is", "are", "was" or "were" (up to two words between, none of them a
    hedge such as "not"), after "has been", or after a colon ("`ID`: Complete"). The ids named are the
    list just before that verb (unless "when", "once", "until" and the like introduce it); after
    "complete:", every id to the sentence's end; after "complete (", the ids in that parenthesis; and in
    "Label (...): X is complete", the ids in the label's parenthesis. "ADR-" numbers are not packages.
K40 each handoff file in docs/handoffs/ is linked from an INDEX.md row, and each INDEX.md link to a
    handoff file resolves. README.md, INDEX.md, RESIDUALS.md and names starting "_" are exempt, and so
    is a draft: the handoff of a package whose Work packages row links no handoff yet. Each package
    whose row in the frozen archived Work packages tables reads Complete has an INDEX.md row.
K41 an INDEX.md row whose package has no Work packages row in the brief says the package is complete
    ("complete" in its Outcome cell, not after "not"). Operational and Session rows are exempt.

An INDEX.md row stands for the package its "Package or round" cell starts with, and for any package it
names as "also `<id>`". Rule ids are kept from the LOGS-1 checker; COMPLEXITY-1 retired the rest
(K3, K4, K6-K37), which pinned wordings and evidence at the 2026-09 archive cut.

Exit 0 when every rule holds, 1 otherwise. Stdlib only, no network.
"""

import argparse
import os
import re
import sys

STATUS = "IMPLEMENTATION_STATUS.md"
RESIDUALS = "docs/handoffs/RESIDUALS.md"
INDEX = "docs/handoffs/INDEX.md"
ARCHIVE = "docs/status-archive"
BUDGET = 30_000
SAFETY = [
    "- `MAX_RUN_MODE=PAPER`",
    "- `ALLOW_REAL_ORDERS=false`",
    "- `LIVE_MICRO_MAX_ORDER_NOTIONAL=0`",
    "- `LIVE_MICRO_MAX_ACCOUNT_EXPOSURE=0`",
    "- Production signer configured: **No**",
    "- Real venue credentials required: **No**",
    "- Human live-micro approval: **Not granted**",
]
RUN_MODE = "Maximum permitted run mode: `PAPER`"
SECTIONS = ["## Safety state", "## Current phase", "## Authorized now", "## Work packages", "## Open blockers",
            "### Closeout blockers", "## Human items"]
RESIDUAL_TABLES = ["## Affects PAPER", "## Before any live mode"]
SEPARATOR = re.compile(r"^\|\s*:?-{3,}")


def read(root, rel):
    with open(os.path.join(root, rel), encoding="utf-8") as fh:
        return fh.read()


def cells_of(line):
    """A table line's cells; a line that does not end with "|" (a row continued below) keeps its last."""
    cells = [c.strip() for c in re.split(r"(?<!\\)\|", line)[1:]]
    return cells[:-1] if line.rstrip().endswith("|") else cells


def data_lines(lines, heading):
    """[(line number, line)]: every table line under the heading (h2 or h3) that starts with `heading`,
    except separator lines and the header line above each separator."""
    on, rows = False, []
    for n, l in enumerate(lines, 1):
        if l.startswith("#"):
            on = l.startswith(heading)
            continue
        if on and l.startswith("|"):
            rows.append((n, l))
    return [(n, l) for k, (n, l) in enumerate(rows)
            if not SEPARATOR.match(l) and not (k + 1 < len(rows) and SEPARATOR.match(rows[k + 1][1]))]


def row_id(cells):
    """The package id a row's first cell starts with (backticked, bold or plain), else the cell."""
    m = re.match(r"^(?:\*\*)?`?([^`*|\s]+)", cells[0]) if cells else None
    return m.group(1) if m else (cells[0] if cells else "")


def index_rows(root):
    """INDEX.md's rows: [{ids, lead, links, kind, outcome, line}]. ids: the package the "Package or round"
    cell starts with (lead), and each it names as "also `<id>`"."""
    out = []
    for n, l in enumerate(read(root, INDEX).split("\n"), 1):
        if not re.match(r"^\| \d{4}-\d{2}-\d{2} \|", l):
            continue
        c = [x.strip() for x in re.split(r"(?<!\\)\|", l)[1:-1]]
        if len(c) < 7:
            continue
        lead = re.match(r"^`([^`]+)`", c[2])
        also = re.findall(r"\balso `([^`]+)`", c[2])
        out.append({"ids": ([lead.group(1)] if lead else []) + also, "lead": lead.group(1) if lead else None,
                    "links": re.findall(r"\]\(([^)]+)\)", c[1]), "kind": c[3], "outcome": c[4], "line": n})
    return out


# K39: what names a package as Complete (see the docstring).
_ID = (r"(?:`[A-Z][A-Z0-9]*(?:-[A-Za-z0-9]+)+`"
       r"|(?<![\w`.-])(?!ADR-)[A-Z][A-Z0-9]+(?:-[A-Za-z0-9]+)+(?![\w`-]|\.\w))")
_ITEM = rf"(?:\*\*)?{_ID}(?:\*\*)?(?:\s*\([^()]*\))?(?:\*\*)?"
_SEP = r"(?:\s*,\s*(?:and\s+)?|\s+and\s+(?:(?:its|their|the)\s+(?:\w+\s+){0,2})?|\s*/\s*|\s+&\s+)"
K39_SUBJECT = re.compile(rf"{_ITEM}(?:{_SEP}{_ITEM})*\s*$")
K39_ID = re.compile(r"`(?P<bt>[A-Z][A-Z0-9]*(?:-[A-Za-z0-9]+)+)`"
                    r"|(?<![\w`.-])(?P<plain>(?!ADR-)[A-Z][A-Z0-9]+(?:-[A-Za-z0-9]+)+)(?![\w`-]|\.\w)")
K39_COMPLETE = re.compile(r"(?<![\w-])completed?(?![\w-])", re.I)
K39_VERB = re.compile(r"(?:\b(?:is|are|was|were)|\b(?:has|have|had)(?:\s+\w+)?\s+been|:)(?P<adv>(?:\s+\w+){0,2}?)\s*(?:\*\*)?\s*$",
                      re.I)
K39_AFTER = re.compile(r"(?:\s+with\s+qualifications?)?(?:\*\*)?\s*(?::|\((?P<paren>[^()]*)\))", re.I)
K39_HEDGES = {"not", "never", "no", "almost", "nearly", "partly", "partially", "mostly", "largely", "yet", "only",
              "half", "barely", "hardly", "incompletely"}
K39_SUBORDINATE = {"when", "once", "until", "till", "if", "unless", "after", "before", "whether", "while"}
K39_SENTENCE = re.compile(r"(?<=[.!?])(?<!\bi\.e\.)(?<!\be\.g\.)\s+(?=[A-Z(`*\[])")


def ids_in(text):
    return [m.group("bt") or m.group("plain") for m in K39_ID.finditer(text)]


def named_complete(sentence):
    """The package ids one sentence names as Complete (K39)."""
    out = []
    for m in K39_COMPLETE.finditer(sentence):
        before, after = sentence[:m.start()], sentence[m.end():]
        verb = K39_VERB.search(before)
        words = (verb.group("adv").split() if verb else []) + re.findall(r"(\w+)\W*$", before)[-1:]
        if any(w.lower() in K39_HEDGES for w in words):
            continue
        if verb:
            subject = before[:verb.start()]
            lst = K39_SUBJECT.search(subject)
            lead = re.findall(r"(\w+)\W*$", subject[:lst.start()]) if lst else []
            if lst and not (lead and lead[-1].lower() in K39_SUBORDINATE):
                out += ids_in(lst.group(0))
            label = re.search(r"\(([^()]*)\)(?:\*\*)?\s*:[^:]*$", subject)  # "The closeout (`ID`, ...): X is complete"
            if label:
                out += ids_in(label.group(1))
        comp = K39_AFTER.match(after)
        if comp and comp.group("paren") is not None:
            out += ids_in(comp.group("paren"))
        elif comp:
            out += ids_in(after[comp.end():])
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--root", default=".")
    root = ap.parse_args().root
    brief = read(root, STATUS)
    lines = brief.split("\n")
    rlines = read(root, RESIDUALS).split("\n")
    fails = []
    irows = index_rows(root)
    index = {}
    for r in irows:
        for pid in r["ids"]:
            index.setdefault(pid, r)

    # K1
    size = len(brief.encode("utf-8"))
    if size > BUDGET:
        fails.append(f"K1: the brief is {size} B; the cap is {BUDGET} B")
    # K2
    for h in SECTIONS:
        if not any(l.startswith(h) for l in lines):
            fails.append(f"K2: the brief has no section {h!r}")
    for s in SAFETY:
        if s not in lines:
            fails.append(f"K2: the brief's safety state lacks {s!r}")
    if RUN_MODE not in brief:
        fails.append(f"K2: the brief lacks {RUN_MODE!r}")
    for h in RESIDUAL_TABLES:
        if h not in rlines:
            fails.append(f"K2: {RESIDUALS} has no section {h!r}")
    # K5
    owned = [(STATUS, n, l) for n, l in data_lines(lines, "### Closeout blockers")]
    owned += [(RESIDUALS, n, l) for h in RESIDUAL_TABLES for n, l in data_lines(rlines, h)]
    for rel, n, l in owned:
        cells = cells_of(l)
        owner = cells[2] if len(cells) > 2 else ""
        if owner in ("", "—", "-"):
            fails.append(f"K5: {rel} line {n}: row {cells[0] if cells else '?'} has no owner")
    # K38
    wp_rows = data_lines(lines, "## Work packages")
    wp_ids = {row_id(cells_of(l)) for _n, l in wp_rows}
    wp_drafts = {row_id(cells_of(l)) for _n, l in wp_rows if not re.search(r"\]\(docs/handoffs/", (cells_of(l) or [""])[-1])}
    for n, l in wp_rows:
        cells = cells_of(l)
        if len(cells) > 2 and cells[2].strip("* ").lower().startswith("complete"):
            fails.append(f"K38: line {n}: Work packages row {row_id(cells)} is Complete; move it to {INDEX} (README rules 1 and 10)")
    # K39
    named, wp = [], False
    for n, l in enumerate(lines, 1):
        if l.startswith("#"):
            wp = l.startswith("## Work packages")
            continue
        if wp and l.startswith("|"):
            continue  # K38's
        for cell in (cells_of(l) if l.startswith("|") else [l]):
            for sent in K39_SENTENCE.split(cell.strip()):
                named += [(n, pid) for pid in named_complete(sent)]
    for n, pid in named:
        if pid not in index:
            fails.append(f"K39: line {n}: the brief names {pid} as Complete, but {INDEX} has no row for it")
    # K40
    hdir = os.path.join(root, "docs/handoffs")
    links = {t for r in irows for t in r["links"]}
    for name in sorted(os.listdir(hdir)):
        if not name.endswith(".md") or name in ("README.md", "INDEX.md", "RESIDUALS.md") or name.startswith("_"):
            continue
        if name not in links and name[:-3] not in wp_drafts:
            fails.append(f"K40: docs/handoffs/{name} has no {INDEX} row (one row per handoff; README rule 10)")
    for r in irows:
        for t in r["links"]:
            if "/" not in t and not os.path.isfile(os.path.join(hdir, t)):
                fails.append(f"K40: {INDEX} line {r['line']} links {t}, which does not exist")
    archived = {}
    for name in sorted(os.listdir(os.path.join(root, ARCHIVE))):
        if not name.startswith("work-packages-"):
            continue
        for n, l in enumerate(read(root, f"{ARCHIVE}/{name}").split("\n"), 1):
            m = re.match(r"^\| `([A-Za-z0-9-]+)`", l)
            cells = cells_of(l) if m else []
            if len(cells) > 1 and cells[1].strip("* ").lower().startswith("complete"):
                archived.setdefault(m.group(1), f"{name}:{n}")
    for pid, where in archived.items():
        if pid not in index:
            fails.append(f"K40: {pid} is Complete in the archive ({where}), but {INDEX} has no row for it")
    # K41
    for r in irows:
        if not r["lead"] or r["kind"] in ("Operational", "Session") or r["lead"] in wp_ids:
            continue
        if not re.search(r"(?<!not )\bcomplete\b", r["outcome"], flags=re.I):
            fails.append(f"K41: {INDEX} line {r['line']}: {r['lead']} has no Work packages row, so its row must say it is "
                         f"Complete; its Outcome reads {r['outcome'][:60]!r}")

    print(f"brief {size} B (cap {BUDGET} B); closeout and residual rows {len(owned)}; work-package rows {len(wp_rows)}; "
          f"INDEX.md packages {len(index)}; named Complete {len(named)}; archived Complete {len(archived)}")
    for f in fails:
        print("  " + f)
    print("RESULT: " + ("FAIL" if fails else "PASS"))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
