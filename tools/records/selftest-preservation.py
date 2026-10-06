#!/usr/bin/env python3
"""Show that check-preservation.py is not vacuous (LOGS-1).

Usage: python3 tools/records/selftest-preservation.py [--base <rev>] [--repo .] [--brief-only]

Builds a scratch copy of the brief, the archive and the handoff index (everything
else is symlinked), confirms the unmodified copy passes, then applies one
mutation at a time and confirms the named proof FAILS. It also runs
check-brief.py mutations, and a synthetic re-cut: a commit (in a shared scratch
clone) that inserts a line above a rewritten region, re-split and re-mapped,
must PASS once its new line is declared, and FAIL without the declaration. The
repository itself is never modified. Exit 0 when every expectation holds.
--brief-only runs only the check-brief.py half: the unmodified copy, BRIEF_MUTATIONS and
BRIEF_ARG_CASES. It is the records round's test of check-brief.py on its own (RECORDS-W3): the
preservation half compares the brief with REWRITES.md as of the cut, so it fails on any brief
edited on main since, until the archive is re-cut.
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
        if name == "adr":  # copied: K36 reads ADR-024 from the checked tree, and a mutation edits it
            shutil.copytree(os.path.join(repo, "docs", name), os.path.join(dst, "docs", name))
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


def declare_at(rng, kind):
    """Declare base lines rng ('a-b') unpaired with the given kind (in the first unpaired block)."""
    def fn(text):
        return text.replace("~~~unpaired\n", f"~~~unpaired\n{rng} {kind}\n", 1)
    return fn


def chain(*fns):
    def fn(text):
        for f in fns:
            text = f(text)
        return text
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


def apply(root, rel, fn):
    """Apply one mutation; rel may instead be a list of (file, mutation) pairs, with fn None."""
    for r, f in (rel if isinstance(rel, list) else [(rel, fn)]):
        edit(os.path.join(root, r), f)


# (name, file or [(file, mutation)], mutation, proof selection, the report line that must say FAIL)
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
    # r2: C8 checks a declared kind against the BASE row, not only the brief
    ("re-declare a live residual closed (SIM2-FILTER out of the table, into the closed list, its entry dropped)",
     [("IMPLEMENTATION_STATUS.md", chain(drop_line(r"^\| `SIM2-FILTER` \|"),
                                         lambda t: t.replace("`SIM2-E2E-MSG`, ", "`SIM2-E2E-MSG`, `SIM2-FILTER`, ", 1))),
      (f"{ARCH}/REWRITES.md", chain(drop_entry("RW-63: Residual `SIM2-FILTER`"), declare_at("2521-2521", "closed-row `SIM2-FILTER`")))],
     None, "C", "the base row does not record it closed"),
    ("re-declare a live package complete (WP-140 flipped to Complete in the brief, its entry dropped)",
     [("IMPLEMENTATION_STATUS.md", lambda t: t.replace(
         "| Implementation complete; automated checks complete; the evidence gate is unmet until the ≥24h soak (H4) |",
         "| Complete (2026-09-01) |", 1)),
      (f"{ARCH}/REWRITES.md", chain(drop_entry("RW-05: Work packages: `WP-140`"), declare_at("39-39", "complete-row `WP-140`")))],
     None, "C", "is not Complete or Superseded in the base row"),
    ("point RW-10's Facts at the wrong archive file", f"{ARCH}/REWRITES.md",
     lambda t: t.replace("which is history in `work-packages-rounds.md`.", "which is history in `work-packages-waves-0-2.md`.", 1),
     "C", "C11:"),
    ("drop a restored VENUE-2 residual (the ops-cli validator pins) from the brief", "IMPLEMENTATION_STATUS.md",
     drop_line(r"^- The offline gate does not consume the phase-2 report"), "C", "C10:"),
    ("drop N3's second reason from the brief", "IMPLEMENTATION_STATUS.md",
     lambda t: t.replace(", and `packages/execution-planner` has no open package entry to carry it.", ".", 1), "C", "C10:"),
    # r3: C12 dispositions, excerpt entries, C13 cross-references
    ("declare SER-2 complete-row with no disposition (the r2 form)", f"{ARCH}/REWRITES.md",
     lambda t: t.replace("73-73 complete-row `SER-2` — carried RW-123\n", "73-73 complete-row `SER-2`\n", 1),
     "C", "C12: complete-row 'SER-2' mentions a residual"),
    ("dispose of SER-3's owned residuals with 'none' alone", f"{ARCH}/REWRITES.md",
     lambda t: t.replace("74-74 complete-row `SER-3` — carried RW-124; closed-by `GOV-2C` (N4)\n",
                         "74-74 complete-row `SER-3` — none: accepted with reasons\n", 1),
     "C", "'none' alone is not a disposition"),
    ("queue a BOOT-1 residual under an id the brief does not name", f"{ARCH}/REWRITES.md",
     lambda t: t.replace("`BOOT1-R6`, `BOOT1-R11`; listed", "`BOOT1-R99`, `BOOT1-R11`; listed", 1), "C", "C12: BOOT-1: queued 'BOOT1-R99'"),
    ("close REGISTER-1's residual by a package that is not Complete", f"{ARCH}/REWRITES.md",
     lambda t: t.replace("complete-row `REGISTER-1` — closed-by `OUTAGE-2`", "complete-row `REGISTER-1` — closed-by `THROUGHPUT-1c`", 1),
     "C", "not a Complete package in the brief"),
    ("point SER-2's disposition at an entry with no excerpt of its row", f"{ARCH}/REWRITES.md",
     lambda t: t.replace("73-73 complete-row `SER-2` — carried RW-123\n", "73-73 complete-row `SER-2` — carried RW-124\n", 1),
     "C", "C12: SER-2: RW-124 has no excerpt block inside base lines 73-73"),
    ("drop SER-2's gatewayEpoch residual from the brief", "IMPLEMENTATION_STATUS.md",
     lambda t: t.replace("`excludedSegments[].gatewayEpoch` stays unbounded (pre-existing, size only, never a refusal). Owner: a later `storage-parquet` round. ", "", 1),
     "C", "C10: RW-123"),
    ("drop SER-3's TraderHealthSource residual from the brief", "IMPLEMENTATION_STATUS.md",
     lambda t: t.replace(" (2) `TraderHealthSource`: a foreign source skipping the door yields 500 where base answered 200. The closure is a brand in `observability`: brand `TraderHealthReportInput` (`metric-shapes.ts:196`), outside SER-3's paths.", "", 1),
     "C", "C10: RW-124"),
    ("alter one character of an excerpt", f"{ARCH}/REWRITES.md",
     lambda t: t.replace("`excludedSegments[].gatewayEpoch` stays unbounded (pre-existing", "`excludedSegments[].gatewayEpoch` stays unbounded (pre-exist1ng", 1),
     "C", "C6: REWRITES excerpt lines=73-73"),
    ("cite 'Venue drift carried forward (RW-11)' again", f"{ARCH}/REWRITES.md",
     lambda t: t.replace("under Venue drift carried forward (RW-10)", "under Venue drift carried forward (RW-11)", 1), "C", "C13:"),
    # r4: J-01 record items (C14) and J-02 clause accounting (C15)
    ("declare GOV-1C's carried follow-ups history again (the r3 form)", f"{ARCH}/REWRITES.md",
     lambda t: t.replace("937-945 record-item — carried RW-128; closed-by `WP-220`, `WP-210`, `WP-230`\n",
                         "937-945 history completion-records-wave-1.md\n", 1),
     "C", "C14: history 937-945 holds the record item 937-945"),
    ("dispose of WP-140's human-review residual with 'none' alone", f"{ARCH}/REWRITES.md",
     lambda t: t.replace("1019-1021 record-item — carried RW-129\n", "1019-1021 record-item — none: a LOW residual\n", 1),
     "C", "C14: record-item 1019-1021 names carried items or obligations"),
    ("a record-item range that is not one bullet", f"{ARCH}/REWRITES.md",
     lambda t: t.replace("802-805 record-item — carried RW-99\n", "802-806 record-item — carried RW-99\n", 1),
     "C", "C14: record-item 802-806 is not exactly one bullet"),
    ("drop WP-300's U-10 refusal from the brief (a live obligation r3 archived as history)", "IMPLEMENTATION_STATUS.md",
     lambda t: t.replace(" `WP-300` must keep the U-10 CANCELLED refusal.", "", 1), "C", "C10: RW-128"),
    ("drop WP-240's uuidV7 known risk from the brief", "IMPLEMENTATION_STATUS.md",
     lambda t: t.replace(" It mints ids with `randomUUID()` (v4), which conflicts with the `internal.uuid_v7` domain (documented in code), so durable composition must use `uuidV7()` (`apps/control-api/src/main.ts:80-90`).", "", 1),
     "C", "C10: RW-110"),
    ("a partial carry: RW-100 without its QuoteIntent keep phrases (the r3 form)", f"{ARCH}/REWRITES.md",
     lambda t: t.replace("\nQuoteIntent has no expected-edge field\nevery quote intent is refused with RISK_EDGE_INPUTS_MISSING\n", "\n", 1),
     "C", "C15: complete-row WP-180 (43-43): a residual clause is not accounted for"),
    ("a partial carry: RW-121 without its epoch-cursor keep phrase (the r3 form)", f"{ARCH}/REWRITES.md",
     lambda t: t.replace("\nkeys the epoch cursor on the caller's object (no live route)\n", "\n", 1),
     "C", "C15: complete-row WP-060-FU1 (70-70)"),
    ("delete one drop line", f"{ARCH}/REWRITES.md",
     drop_line(r"^R8-2 dotted-write syntactic gate => "), "C", "C15: complete-row WP-180 (43-43)"),
    ("a drop closed by a package that is not Complete", f"{ARCH}/REWRITES.md",
     lambda t: t.replace("R6-1 layer-1 `node:util` import (open, non-blocking) => closed-by `GOV-2A`",
                         "R6-1 layer-1 `node:util` import (open, non-blocking) => closed-by `WP-260`", 1),
     "C", "closed-by 'WP-260', which is not a Complete package"),
    ("a drop that names a heading the brief lacks", f"{ARCH}/REWRITES.md",
     lambda t: t.replace("R8-2 dotted-write syntactic gate => brief: Residual queue", "R8-2 dotted-write syntactic gate => brief: Residual queues", 1),
     "C", "is not a heading of the brief"),
    ("alter one character of a drop fragment", f"{ARCH}/REWRITES.md",
     lambda t: t.replace("R8-2 dotted-write syntactic gate => ", "R8-2 dotted-write syntactik gate => ", 1),
     "C", "C6: REWRITES drop fragment lines=43-43"),
    # r5: CX-R5-01 carried-clause tokens (C16), CX-R5-03 the move map (C5)
    ("the r4 WP-020-FU1 carry without the 248ns cause (CX-R5-01)",
     [("IMPLEMENTATION_STATUS.md", lambda t: t.replace(' (the remaining 248ns is the one sound `getOwnPropertyNames(Object.prototype)`)', "", 1)),
      (f"{ARCH}/REWRITES.md", lambda t: t.replace(' (the remaining 248ns is the one sound `getOwnPropertyNames(Object.prototype)`)', "", 1)
       .replace("\nremaining 248ns is the one sound getOwnPropertyNames(Object.prototype)\n", "\n", 1))], None,
     "C", "C16: complete-row WP-020-FU1 (54-54): the carried clause loses '248ns'"),
    ("the r4 WP-230 carry without seams.reservations.open (CX-R5-01)",
     [("IMPLEMENTATION_STATUS.md", lambda t: t.replace(", now visible via `seams.reservations.open`.", ".", 1)),
      (f"{ARCH}/REWRITES.md", lambda t: t.replace(", now visible via `seams.reservations.open`.", ".", 1)
       .replace("\nnow VISIBLE via seams.reservations.open\n", "\n", 1))], None,
     "C", "C16: complete-row WP-230 (55-55): the carried clause loses 'seams.reservations.open'"),
    ("delete the drop line that names SER-1's handoff path", f"{ARCH}/REWRITES.md",
     drop_line(r"^Residuals \(owned, `docs/handoffs/SER-1.md`\) => "), "C", "C16: complete-row SER-1 (72-72)"),
    ("the WP-110 completion record back to 'archive only' in the move map (CX-R5-03)", f"{ARCH}/MOVE-MAP.md",
     lambda t: re.sub(r"(\| ### WP-110 completion record \(2026-08-31\) \| 1151 \| \[[^]]+\]\([^)]+\) \| )[^\n]*",
                      lambda m: m.group(1) + "archive only |", t, count=1),
     "C", "C5: MOVE-MAP.md's line for the heading at line 1151 does not name RW-132"),
    ("the ALLOC-1 row without its brief entry in the move map (CX-R5-03)", f"{ARCH}/MOVE-MAP.md",
     lambda t: t.replace("| Work packages (own row); Open blockers > Residuals recorded in Complete package rows (RW-115) |",
                         "| Work packages (own row) |", 1),
     "C", "C5: MOVE-MAP.md is not the output of move-map.py"),
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
    # RECORDS-W3: THROUGHPUT-1c's Authorized-now bullet moved to its handoff; an authorized bullet for it
    # that omits its archived gate's green CI run is still refused.
    ("an Authorized-now bullet without its gate's green CI run (THROUGHPUT-1c)", "IMPLEMENTATION_STATUS.md",
     lambda t: t.replace("- **`HOST-BENCH`**: Ready;", "- **`THROUGHPUT-1c`**: Ready (authorized).\n- **`HOST-BENCH`**: Ready;", 1), "K13:"),
    ("AGENTS.md without 'frozen'", "AGENTS.md",
     lambda t: t.replace("archived, verbatim and frozen, under", "archived verbatim under", 1), "K11:"),
    ("README rule 10 back to 'add one line'", "docs/handoffs/README.md",
     lambda t: t.replace("add or update the handoff's single row in", "add one line to", 1), "K12:"),
    ("the archive README claims complete rewrites", f"{ARCH}/README.md",
     lambda t: t.replace("C authenticates what `REWRITES.md` says. It cannot tell whether a rewrite kept every fact, or whether a drop reason is true; that is a review question.",
                         "the move map and rewrites are complete and verbatim.", 1), "K14:"),
    ("the archive README claims every kind is true", f"{ARCH}/README.md",
     lambda t: t.replace("every base line is paired or declared, and each declaration's kind",
                         "every base line is paired or declared, with a true kind; each declaration's kind", 1), "K14:"),
    ("WP-140 back to 'the gate is open'", "IMPLEMENTATION_STATUS.md",
     lambda t: t.replace("the evidence gate is unmet until the ≥24h soak (H4) |",
                         "evidence pending: the ≥24h soak (H4); the gate is open |", 1), "K15:"),
    ("a ruling that does not say what it ruled", "IMPLEMENTATION_STATUS.md",
     lambda t: t.replace("- **H5**: ruled 2026-09-28: one demonstrated run.",
                         "- **H5**: Ruled by the user 2026-09-28.", 1), "K16:"),
    # RECORDS-W3: B5 is closed; the narration check runs on the H3 line, which carries B5's qualification.
    ("H3 narrates the record", "IMPLEMENTATION_STATUS.md",
     lambda t: t.replace("No real Grafana has rendered a non-empty Fills or PnL panel.",
                         "The row also records that no real Grafana has rendered a non-empty Fills or PnL panel.", 1), "K17:"),
    ("the old coverage heading", f"{ARCH}/REWRITES.md",
     lambda t: t.replace("## Coverage: base lines not included in a rewrite pair\n", "## Coverage: lines no entry pairs\n", 1), "K18:"),
    ("the old Wave 3 intro", "IMPLEMENTATION_STATUS.md",
     lambda t: t.replace("The user authorized Wave 3 on 2026-09-30. The orchestrator may start `WP-260` first, "
                         "then the work-plan chain, only when both hold:\n",
                         "The user authorized Wave 3 on 2026-09-30, on a condition. The orchestrator may\n"
                         "start Wave 3 packages (`WP-260` first, then the work-plan chain) only when both\nhold:\n", 1), "K19:"),
    # r3
    ("drop the Complete-row residuals subsection heading", "IMPLEMENTATION_STATUS.md",
     lambda t: t.replace("### Residuals recorded in Complete package rows\n", "", 1), "K2:"),
    ("the Wave 3 intro says 'starts' (a commitment) instead of 'may start'", "IMPLEMENTATION_STATUS.md",
     lambda t: t.replace("The orchestrator may start `WP-260` first,", "The orchestrator starts `WP-260` first,", 1), "K19:"),
    ("the Archive intro back to 'Everything below was moved verbatim'", "IMPLEMENTATION_STATUS.md",
     lambda t: t.replace("The whole file at `8fde4df` is archived verbatim in [",
                         "Everything below was moved verbatim from this file at `8fde4df`. See [", 1), "K20:"),
    ("REWRITES.md's intro without C11", f"{ARCH}/REWRITES.md",
     lambda t: t.replace("- each archive file named in a Facts account holds at least one of that entry's old or excerpt lines (C11);\n", "", 1), "K21:"),
    ("REWRITES.md's intro without C14 and C15", f"{ARCH}/REWRITES.md",
     lambda t: t.replace(" with a disposition (C14);", " with a disposition;", 1).replace(" or a drop fragment (C15);", " or a drop fragment;", 1), "K21:"),
    ("REWRITES.md's Facts bullet back to the old wording", f"{ARCH}/REWRITES.md",
     lambda t: t.replace("- a **Facts** account. It identifies the facts the new text keeps, and locates each omitted fact in another brief section or the archive.",
                         "- a **Facts** account: what the new text keeps, and what it does not carry and where that lives.", 1), "K21:"),
    ("AGENTS.md's sentence back to the nested aside", "AGENTS.md",
     lambda t: t.replace("its history is archived, verbatim and frozen, under `docs/status-archive/`; per-package",
                         "its history is archived verbatim, and frozen, under `docs/status-archive/`, and per-package", 1), "K22:"),
    # r4
    ("drop the completion-record obligations subsection heading", "IMPLEMENTATION_STATUS.md",
     lambda t: t.replace("### Obligations in completion records\n", "", 1), "K2:"),
    ("the BRACKET1B-RECON clause chain again (a 70-word sentence)", "IMPLEMENTATION_STATUS.md",
     lambda t: t.replace("each loud rather than silent where it matters. Fee records are not individually tied to their fills (fee totals are compared through fills and snapshots). The single-bracket path",
                         "each loud rather than silent where it matters: fee records are not individually tied to their fills (fee totals are compared through fills and snapshots); the single-bracket path", 1)
                        .replace("(no single-bracket row reads it). Same-event fill ties keep the fill-id convention. There is no per-bracket engine checkpoint in the artifact. Two internal",
                                 "(no single-bracket row reads it); same-event fill ties keep the fill-id convention; there is no per-bracket engine checkpoint in the artifact; two internal", 1), "K23:"),
    ("the SER-3 bullet writes a bare N4 again", "IMPLEMENTATION_STATUS.md",
     lambda t: t.replace("SER-3's N4, the one sentence owed", "**N4**, the one sentence owed", 1), "K24:"),
    ("the Complete-row subsection intro without its citation pin", "IMPLEMENTATION_STATUS.md",
     lambda t: t.replace("under Work packages. File:line citations are as of `8fde4df`. The disposition", "under Work packages. The disposition", 1), "K25:"),
    # r5
    ("the WP-110 bullet lists the payoff_model divergence as owed again (CX-R5-02)", "IMPLEMENTATION_STATUS.md",
     lambda t: t.replace(" A `MarketClosed`-equivalent venue signal remains unconfirmed.",
                         " The `catalog.settlement_specs.payoff_model NOT NULL` divergence is owned by the migration owner."
                         " A `MarketClosed`-equivalent venue signal remains unconfirmed.", 1), "K27:"),
    ("REWRITES.md claims a partial carry fails again (CX-R5-04)", f"{ARCH}/REWRITES.md",
     lambda t: t.replace("Reviewers must check the rest of each clause.", "So a partial carry fails.", 1), "K21:"),
    ("the archive README claims a partial carry fails again (CX-R5-04)", f"{ARCH}/README.md",
     lambda t: t.replace("so reviewers must check the rest of each clause", "so a partial carry fails", 1), "K21:"),
    ("REWRITES.md's coverage prose as one dense line again (CX-R5-04)", f"{ARCH}/REWRITES.md",
     lambda t: t.replace("\n\n**Dispositions.** ", " **Dispositions.** ", 1).replace("\n\n**Closed in the base.** ", " **Closed in the base.** ", 1)
     .replace("\n\nA row that is closed in part", " A row that is closed in part", 1), "K29:"),
    # RECORDS-W3: `WP-320` is Complete since 2026-10-05, so R5-01's sentence no longer reaches K28; a
    # present-tense sentence about a package that is not Complete (`WP-360`) still fails.
    ("an obligation of a package that is not Complete reads as a fact (R5-01's rule)", "IMPLEMENTATION_STATUS.md",
     lambda t: t.replace("- `WP-060`: the 5 ms p99", "- `WP-060`: `WP-360` calibrates the fill model. The 5 ms p99", 1), "K28:"),
    ("the Complete-row intro promises every owner again (R5-02)", "IMPLEMENTATION_STATUS.md",
     lambda t: t.replace("Each bullet states them as the row does. Where a bullet names no owner, the owner is in the handoff linked from the package's row under Work packages.",
                         "Each bullet states them as the row does, with the owner the row or its handoff names.", 1), "K26:"),
    ("the ALLOC-1 bullet writes bare N1/N2 again (R5-03)", "IMPLEMENTATION_STATUS.md",
     lambda t: t.replace("ALLOC-1's review N1/N2 report", "N1/N2 report", 1), "K24:"),
    ("the WP-210 bullet's verbless fragment again (R5-04)", "IMPLEMENTATION_STATUS.md",
     lambda t: t.replace("The migration owner owns the segmentFileSha256 + compacted-object registration.",
                         "The migration owner owns the segmentFileSha256 + compacted-object registration."
                         " The §12.1 port-interface landing: contract owner recording.", 1), "K30:"),
    # r6
    ("the GOV-2A bullet carries the reciprocal note and the probe sources as owed again (I1)", "IMPLEMENTATION_STATUS.md",
     lambda t: t.replace("- `WP-160`: R1-L1,",
                         "- `GOV-2A`: review NOTEs. The F17 id collision was ruled acceptable with a cross-reference (reciprocal note owed)."
                         " The probe sources are not committed (inline them).\n- `WP-160`: R1-L1,", 1), "K31:"),
    ("the WP-180-FU2 bullet carries the §1 staleness again (I2)", "IMPLEMENTATION_STATUS.md",
     lambda t: t.replace("- `WP-220`:", "- `WP-180-FU2`: the schema-boundary §1 staleness (outside its grant; the next governance ride).\n- `WP-220`:", 1), "K31:"),
    ("the SETL-1 bullet carries the three zod facts again (I3)", "IMPLEMENTATION_STATUS.md",
     lambda t: t.replace("(fail-closed availability; D2/ADR-020); the reviewer's method gap",
                         "(fail-closed availability; D2/ADR-020); three measured zod facts for the §2 class table; the reviewer's method gap", 1), "K31:"),
    ("the WP-160 bullet presents R1-L2 as unresolved again (I4)", "IMPLEMENTATION_STATUS.md",
     lambda t: t.replace("R1-L2's wording is corrected: `GOV-2C` scoped exported `validateFeatureInput`'s \"never throws\" to a materialized tree",
                         "R1-L2: exported `validateFeatureInput`'s \"never throws\" is unenforced on non-materialized trees", 1), "K31:"),
    ("the WP-230 bullet carries the §2 error-construction row again", "IMPLEMENTATION_STATUS.md",
     lambda t: t.replace("Also: live-owner attribution for history-loaded positions.",
                         "Also: live-owner attribution for history-loaded positions, and the arena-error-construction schema-boundary §2 candidate row.", 1), "K31:"),
    ("the GATE-1 bullet carries the fail-fast chain again", "IMPLEMENTATION_STATUS.md",
     lambda t: t.replace("- `GATE-1`: both gate homes", "- `GATE-1`: the `node` job remains one fail-fast chain. Both gate homes", 1), "K31:"),
    ("the TRDR-2 bullet carries the main.ts:292 cast again", "IMPLEMENTATION_STATUS.md",
     lambda t: t.replace("- `TRDR-2`: DB domain", "- `TRDR-2`: `main.ts:292`'s cast; DB domain", 1), "K31:"),
    ("the WP-240 bullet without the two other pending panels (I6)", "IMPLEMENTATION_STATUS.md",
     lambda t: t.replace("Two fidelity panels stay pending, each with a named owner, machine-checked against `PENDING_PRODUCER_PANELS`:"
                         " predicted-vs-actual (WP-290/phase-4) and markout (a future simulation/research grant). ", "", 1), "K32:"),
    # r7
    ("the FOLD-PNL2TOKEN cite back at loop.ts about :2607-2612 (D3)", "IMPLEMENTATION_STATUS.md",
     lambda t: t.replace("(`packages/trading-core/src/loop.ts:3118-3122`, in `#stagePnlSnapshot`)", "(`loop.ts` about :2607-2612)", 1), "K33:"),
    ("the N2 cite back at book.ts:191 and :265 (D3)", "IMPLEMENTATION_STATUS.md",
     lambda t: t.replace("`book.ts:284` and `:361`", "`book.ts:191` and `:265`", 1), "K33:"),
    ("an unregistered file:line citation (D3)", "IMPLEMENTATION_STATUS.md",
     lambda t: t.replace("the next `apps/data-gateway` round |", "the next `apps/data-gateway` round (`feed.ts:12`) |", 1), "K33:"),
    ("the RISK2-R1 row carried as open again (D3, closed by BOOT-1)", "IMPLEMENTATION_STATUS.md",
     lambda t: t.replace("| `BOOT1-R6` |", "| `RISK2-R1` | `packages/trading-core/src/pipeline.ts:100-104`'s premise is superseded. | the next round |\n| `BOOT1-R6` |", 1), "K31:"),
    ("the TRDR2-R8 row carried as open again (closed by BOOT-1)", "IMPLEMENTATION_STATUS.md",
     lambda t: t.replace("| `BOOT1-R6` |", "| `TRDR2-R8` | A parenthesized type alias evades the census. | the next round touching `test/unit/trader/**` |\n| `BOOT1-R6` |", 1), "K31:"),
    ("TRDR4-CITES says the claim still holds again", "IMPLEMENTATION_STATUS.md",
     lambda t: t.replace("(documentation only) |", "The claim itself still holds. (documentation only) |", 1), "K31:"),
    ("the brief without the WP-080 UNVERIFIED register bullet (D1)", "IMPLEMENTATION_STATUS.md",
     drop_line(r"^- `WP-080`: the Binance UNVERIFIED register"), "K34:"),
    ("the ALLOC-1 bullet's r6 clause chain (D2)", "IMPLEMENTATION_STATUS.md",
     lambda t: t.replace("Its N3 reports unparsed `withLiveOwner` surfaces, which have zero non-test callers.",
                         "Its N3 reports these; its N3, unparsed withLiveOwner surfaces (zero non-test callers).", 1), "K30:"),
    ("the WP-240 bullet's 'Two more fidelity panels' (D5)", "IMPLEMENTATION_STATUS.md",
     lambda t: t.replace("Two fidelity panels stay pending", "Two more fidelity panels stay pending", 1), "K30:"),
    ("the archive README's r6 K31 overclaim (D4)", f"{ARCH}/README.md",
     lambda t: t.replace("  - K31 is a set of regression checks for 17 specific closures that review found.",
                         "  - It also refuses an item the brief carries as owed when a record, contract or code comment at the cut already closed it (K31).", 1), "K35:"),
    ("the archive README's proof bullet as one dense line again (I5)", f"{ARCH}/README.md",
     lambda t: t.replace(" runs three proofs:\n  - A:", " runs three proofs: A:", 1).replace("exactly.\n  - B:", "exactly. B:", 1)
     .replace("multiplicity.\n  - C:", "multiplicity. C:", 1).replace("complete.\n  - C also", "complete. C also", 1)
     .replace("lists each check.\n  - A declared", "lists each check. A declared", 1), "K29:"),
    # r8
    ("the N3 row without WP-190 R1-L1's composed-entries qualifier (CX-R8-01)", "IMPLEMENTATION_STATUS.md",
     lambda t: t.replace(" The composed entries (`buildExecutionPlan`, `sealExecutionPlan`) are total (`WP-190` R1-L1).", "", 1), "K36:"),
    ("the WP-250 bullet without the replay-determinism panel's owner (CX-R8-02)", "IMPLEMENTATION_STATUS.md",
     lambda t: t.replace(": a future `packages/simulation` or `apps/backtest-cli` grant.", " (hard-forbidden paths).", 1), "K36:"),
    ("the WP-180-FU3 fragment chain again (CX-R8-03)", "IMPLEMENTATION_STATUS.md",
     lambda t: t.replace("review r1 left three items open. In r1 N1, the ownEntry guard is untested (pre-existing).",
                         "r1 N1, the ownEntry guard untested (pre-existing); r1 N2, the sort sentence.", 1), "K30:"),
    ("TRDR4-CITES's 'a fixed depth 2 levels more' again (R8-02)", "IMPLEMENTATION_STATUS.md",
     lambda t: t.replace("nests records two levels deeper, to a fixed depth.", "nests records, a fixed depth 2 levels more.", 1), "K30:"),
    ("the GATE1-R3 row carried as open again (R8-01, closed by CI-1)", "IMPLEMENTATION_STATUS.md",
     lambda t: t.replace("| `N3` |", "| `GATE1-R3` | The remaining unknown was the first real CI run's fresh install. | H2 |\n| `N3` |", 1), "K31:"),
    ("TRDR4-CITES pinned to another commit than its section (L2, LOGS-1-RECUT r1)", "IMPLEMENTATION_STATUS.md",
     lambda t: t.replace("At `8fde4df` they are `:301`", "At `f43efe6` they are `:301`", 1), "K37:"),
    # RECORDS-W3: K36's LOGS-1 rule is retired (the bullet left the brief at LOGS-1's completion); the
    # reviewer-less gate wording is still refused by K37.
    ("LOGS-1's gate without its Fable reviewer comes back (CX-RECUT-01)", "IMPLEMENTATION_STATUS.md",
     lambda t: t.replace("- **`HOST-BENCH`**: Ready;", "  - Gate: a review of the preservation, and a green CI run on GitHub.\n- **`HOST-BENCH`**: Ready;", 1), "K37:"),
    ("RW-01 says LOGS-1 merged (CX-RECUT-02)", "docs/status-archive/REWRITES.md",
     lambda t: t.replace("re-cut at `8fde4df` for LOGS-1's pending merge.", "re-cut at `8fde4df` when LOGS-1 merged.", 1), "K37:"),
    ("the THROUGHPUT-2 bullet without the review's LOWs (L4)", "IMPLEMENTATION_STATUS.md",
     lambda t: t.replace(", and so are the review's two LOWs, `TP2-R2-L1` and `TP2-R2-L2`.", ".", 1), "K36:"),
    ("exceed the 15% budget", "IMPLEMENTATION_STATUS.md",
     lambda t: t + ("filler " * 9000) + "\n", "K1:"),
    # RECORDS-W3: one pin per changed rule
    ("exceed the line budget alone (K1 counts lines too)", "IMPLEMENTATION_STATUS.md",
     lambda t: t + "\n" * 60, "K1:"),
    ("a section pins its citations as of another commit than the cut (K33)", "IMPLEMENTATION_STATUS.md",
     lambda t: t.replace("File:line citations are as of `8fde4df`.", "File:line citations are as of `f43efe6`.", 1), "K33:"),
    ("an unregistered file:line citation comes back (K33; `:906` is retired)", "IMPLEMENTATION_STATUS.md",
     lambda t: t.replace("- **H6**, the authorization rows", "- **H6** (runbook §10, `:906` at `f43efe6`), the authorization rows", 1), "K33:"),
    ("H1R1's closure says ADR-024 is accepted without the ratification (K36, re-anchored)", "IMPLEMENTATION_STATUS.md",
     lambda t: t.replace("ADR-024 is accepted (ratified by the user 2026-09-30)", "ADR-024 is accepted (2026-09-30)", 1), "K36:"),
    ("ADR-024 loses its ratification in the tree (K36 reads the checked tree)", "docs/adr/ADR-024-evaluate-once-per-venue-frame.md",
     lambda t: t.replace("Ratified by the user on 2026-09-30", "Pending the user's ratification", 1), "K36:"),
    ("Wave 3's first condition no longer names the CLOSED grade (K36, re-anchored)", "IMPLEMENTATION_STATUS.md",
     lambda t: t.replace("- the fresh Wave 2 closeout audit grades Wave 2 CLOSED:", "- the fresh Wave 2 closeout audit has run:", 1), "K36:"),
]

# check-brief.py runs with other arguments: (name, extra arguments, the report line that must appear)
BRIEF_ARG_CASES = [
    # RECORDS-W3: K31-K36 read their evidence at the archive's cut, not at --base.
    ("the unmodified copy, with the evidence read at the first cut instead of the archive's", ["--cut", "f43efe6"], "K33:"),
]


def run(repo, root, base, only, tool=CHECK, extra=()):
    cmd = [sys.executable, tool, "--base", base, "--repo", repo, "--root", root, *extra]
    if tool == CHECK:
        cmd += ["--only", only]
    r = subprocess.run(cmd, capture_output=True, text=True)
    return r.returncode, r.stdout + r.stderr


def git(repo, *args, env=None, stdin=None):
    return subprocess.run(["git", "-C", repo, *args], check=True, capture_output=True, text=True,
                          env=env, input=stdin).stdout.strip()


def rebase_blocks(text, old_cut, new_cut, at=5):
    """Move the blocks that name the current cut to the synthetic cut, one line lower from line `at` on.

    This is what a maintainer does at a real re-cut for blocks that name an earlier
    re-cut (README, "Re-cutting after edits on `main`"): only the rewrites-base
    blocks keep their numbers.
    """
    shift = lambda n: n + 1 if n >= at else n  # noqa: E731
    out, in_decl = [], False
    for line in text.split("\n"):
        m = re.match(r"^~~~(old|excerpt|drop|unpaired) base=" + old_cut + r"(?: lines=(\d+)-(\d+))?$", line)
        if m:
            line = f"~~~{m.group(1)} base={new_cut}"
            if m.group(2):
                line += f" lines={shift(int(m.group(2)))}-{shift(int(m.group(3)))}"
            in_decl = m.group(1) == "unpaired"
        elif in_decl and line == "~~~":
            in_decl = False
        elif in_decl:
            d = re.match(r"^(\d+)-(\d+)( .*)$", line)
            if d:
                line = f"{shift(int(d.group(1)))}-{shift(int(d.group(2)))}{d.group(3)}"
        out.append(line)
    return "\n".join(out)


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
    full = git(clone, "rev-parse", base)
    if f"base={full}" in open(os.path.join(root, ARCH, "REWRITES.md"), encoding="utf-8").read():
        edit(os.path.join(root, ARCH, "REWRITES.md"), lambda t: rebase_blocks(t, full, cut))
    subprocess.run([sys.executable, MOVEMAP, "--base", cut, "--repo", clone, "--root", root], check=True, capture_output=True)
    if declare:
        edit(os.path.join(root, ARCH, "REWRITES.md"),
             lambda t: t.replace("~~~unpaired\n", f"~~~unpaired base={cut}\n5-5 history header-and-phase.md\n~~~\n\n~~~unpaired\n", 1))
    return run(clone, root, cut, "A,B,C")


def main() -> int:
    ap = argparse.ArgumentParser(description="non-vacuity self-test for check-preservation.py")
    ap.add_argument("--base", default=None, help="default: the cut recorded in the archive markers")
    ap.add_argument("--repo", default=".")
    ap.add_argument("--brief-only", action="store_true", help="run only the check-brief.py half")
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
        if not args.brief_only:
            code, out = run(repo, clean, base, "A,B,C")
            print(f"[{'ok' if code == 0 else 'UNEXPECTED'}] unmodified copy passes (exit {code})")
            ok &= code == 0
        for k, (name, rel, fn, only, expect) in enumerate([] if args.brief_only else MUTATIONS, 1):
            root = os.path.join(tmp, f"m{k}")
            os.mkdir(root)
            shadow(repo, root)
            apply(root, rel, fn)
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
            apply(root, rel, fn)
            code, out = run(repo, root, base, "", tool=BRIEF)
            hit = code == 1 and expect in out
            ok &= hit
            detail = next((l.strip() for l in out.split("\n") if expect in l), "no matching line")
            print(f"[{'ok' if hit else 'UNEXPECTED'}] check-brief: {name}: exit {code}; {detail[:150]}")
        for name, extra, expect in BRIEF_ARG_CASES:
            code, out = run(repo, clean, base, "", tool=BRIEF, extra=extra)
            hit = code == 1 and expect in out
            ok &= hit
            detail = next((l.strip() for l in out.split("\n") if expect in l), "no matching line")
            print(f"[{'ok' if hit else 'UNEXPECTED'}] check-brief {' '.join(extra)}: {name}: exit {code}; {detail[:150]}")
        if args.brief_only:
            print("SELFTEST (check-brief.py only): " + ("PASS" if ok else "FAIL"))
            return 0 if ok else 1
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
