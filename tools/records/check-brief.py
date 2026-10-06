#!/usr/bin/env python3
"""Check the brief's budget and the measurable parts of the writing standard (LOGS-1).

Usage: python3 tools/records/check-brief.py --base <rev> [--cut <rev>] [--repo .] [--root .]

--base is the file the budget (K1) and K13's archived rows are measured against.
--cut is the commit the brief's citations and carried facts are pinned to: K31-K34 and K36
read their evidence there. It defaults to the archive's cut, the base= of the archive files'
verbatim-begin markers (one value), which is the commit the brief's "as of" pins name. The two
differ when the brief is measured against the first cut (`f43efe6`) while the archive and the
brief's pins are at the re-cut (`8fde4df`) (RECORDS-W3).

K1  budget: IMPLEMENTATION_STATUS.md is at most 15% of the base file, in bytes and in lines.
K2  the sections an agent needs before acting exist, and the safety state is verbatim.
K3  the intro does not promise "one line per item" (bullets can have sub-items).
K4  no bare runbook or handoff line cite: a ":NNN" cite names the commit it is valid at.
K5  every closeout-blocker and residual row has an owner cell that is not "—".
K6  if an owner begins "row:", the residual intro says what that means.
K7  a closeout-blocker state cell has at most 90 words (run detail goes under Human items).
K8  "PARTLY DONE" appears only as the archived state cell's wording.
K9  the residual table lists open rows only: no residual cell begins with "Complete".
K10 SER-0 is described as complete, not merged (9a44167 is a governance record commit).
K11 AGENTS.md and CLAUDE.md both say the archive is frozen.
K12 the handoff README and INDEX say "add or update" a handoff's single INDEX row.
K13 every "Authorized now" bullet names the green GitHub CI run when its archived row's gate does.
K14 the archive README and REWRITES.md do not claim the proof shows rewrites are complete; both
    say that fidelity is a review question; neither claims C8 proves every declared kind true.
K15 no "gate is open": main uses "gate is OPEN" for a passed gate, so say met or unmet.
K16 a ruling states what was ruled: no bare "Ruled by the user <date>.".
K17 state the fact, do not narrate the record: no "the row (also) records that".
K18 REWRITES.md's coverage heading reads "Coverage: base lines not included in a rewrite pair".
K19 the Wave 3 authorization intro is at most 24 words, names the date and `WP-260`, says the
    orchestrator "may start" (a permission, as the base row grants), and is followed by exactly
    two condition bullets.
K20 the brief's Archive intro does not claim the text "below" was moved: it lists files.
K21 REWRITES.md's intro names every check that concerns it (C6, C8-C15)
    and does not use the old Facts wording "and what it does not carry and where that lives".
K22 AGENTS.md's archive sentence has no nested aside ("verbatim, and frozen,").
K23 no sentence in the brief runs over 45 words (README rule 3), except the closed-id lists.
K24 the SER-3 bullet of the Complete-row residual subsection writes "SER-3's N4": GOV-2B's
    `test:replay` N4 is a different item.
K25 every brief section that cites a file line (`name.ext:NNN`) states the commit its citations
    are valid at ("as of `<sha>`" or "at `<sha>`"), in the section or on the citing line.
K26 the Complete-row residual intro sends a reader to the handoff linked from the package's row
    for an owner a bullet does not name, and every package with a bullet there has an INDEX.md row
    that links its handoff. Re-anchored (RECORDS-W3B): Complete rows left the Work packages table,
    so the package's row is its INDEX.md row.
K27 the brief does not list the `catalog.settlement_specs.payoff_model NOT NULL` divergence as
    owed: `WP-210`'s migration 0009 resolved it.
K28 in "Obligations in completion records", a sentence whose subject is a package that is not
    Complete states an obligation ("must", "owes", "owed"), not a present fact. Complete means the
    package's INDEX.md row reads "Complete". Re-anchored (RECORDS-W3B): the brief's table no longer
    lists Complete packages.
K29 no line of REWRITES.md's intro and coverage prose (before the first declaration block), and no
    line of the archive README, runs over 80 words: split dense paragraphs into lists or tables.
K30 no verbless fragment where r4 had one: the WP-210 bullet's "landing: contract owner
    recording." and the UNIV-1 bullet's bare "LOW-2 drifts (two unpinned), LOW-3 ..." list.
K31 closed before the cut (r6-r8): regression checks for a fixed list of specific closures that
    review found (CLOSED_BEFORE_CUT). It is not a detector: an item closed before the cut that no
    rule names passes. Each rule names the brief wording and the evidence, read from the
    repository AT THE CUT (`git show <cut>:<path>`); if the evidence is not there, the rule fails
    too, so it cannot outlive its reason.
K32 the WP-240 bullet names every fidelity panel still pending at the cut: each `panel:` of
    `PENDING_PRODUCER_PANELS` (packages/observability/src/control/dashboards.ts at the cut) maps to
    a phrase the brief uses; an unmapped panel fails until it is added here and to the brief.
K33 every file:line citation in the brief (`name.ext:NNN` or a bare `:NNN`) lies inside a literal
    of CITATIONS, and each literal's needle is on the cited lines of that file AT THE CUT. A
    "quote" entry is a stale citation a row quotes from another file: its needle must be in that
    file at the cut. This makes "File:line citations are as of `<cut>`" a checked sentence, so
    K33 also requires every "as of `<sha>`" pin in the brief to name the cut (RECORDS-W3).
K34 every id in `BINANCE_UNVERIFIED` (packages/binance-adapter/src/venue.ts at the cut) is named
    in the brief in backticks.
K35 the archive README describes K31 as regression checks for exactly len(CLOSED_BEFORE_CUT)
    specific closures and says it is not a detector.
K36 carried qualifiers (r8): each CARRIED_FACTS rule names a brief row or bullet (by its line prefix),
    the words it must hold, and the source text that states the fact AT THE CUT; if the source text
    is gone, the rule fails too. Like K31, it is a fixed list, not a detector. A rule whose fact
    changed after the cut reads its source in the checked tree instead (TREE), and says why.
K37 re-cut consistency (LOGS-1-RECUT r1): in a section whose intro says its citations are "as of
    `<sha>`", no line that cites a file line pins another commit ("at `<other>`") unless it says the
    file is "unchanged" there; and RECUT_REFUSED, a fixed list of wordings review refused at the
    re-cut (brief or REWRITES.md), does not come back.
K38 no Work packages row's status starts "Complete": a completed package's row leaves the brief,
    and its INDEX.md row carries it (docs/handoffs/README.md rules 1 and 10; RECORDS-W3B). Every
    data line of the table counts, whatever its id cell looks like (plain, bold or backticked).
K39 every package the brief names as Complete has an INDEX.md row (RECORDS-W3B). Outside the Work
    packages table, a completion is "complete" or "completed" (any case) after "is", "are", "was" or
    "were" (up to two words between, none of them a hedge such as "not" or "almost"), after "has been",
    or after a colon ("`ID`: Complete"). The ids it names are the list of ids just before that verb
    (its subject, unless "when", "once", "until" and the like introduce it), and, after "complete:"
    (with or without a verb), every id to the sentence's end; after "complete (", the ids in that
    parenthesis, and in "Label (...): X is complete", the ids in the label's parenthesis (a
    completion's record, such as CLOSEOUT-3's). An id is in backticks, or plain with a
    prefix of two or more characters ("WP-150/WP-170"); "ADR-" numbers are not packages. Each
    Complete-row residual bullet's package is named too. Where the brief gives an id's merge SHA
    ("`ID` (`sha`"), the INDEX.md row names that SHA for that id. An "also" id's SHA is its own
    "merged `sha`", not its host row's. Other wordings ("merged", "done", "closed") are not read; K40
    guards the INDEX.md rows themselves.
K40 INDEX.md keeps a row for every completed package: each handoff file in docs/handoffs/ is linked from
    an INDEX.md row, and each INDEX.md link to a handoff file resolves. README.md, INDEX.md and names
    starting "_" are exempt, as in check-preservation's C7, and so is a draft: the handoff of a package
    whose Work packages row links no handoff yet (written before its INDEX.md row; WP-140's row links its
    handoff, so WP-140.md is not a draft). Each package whose row in the frozen
    archived Work packages tables reads Complete has an INDEX.md row. This covers `DEPS-1`, which has
    no handoff, and the "also" id WP-080-FU1 (RECORDS-W3B r1).
K41 an INDEX.md row whose package has no Work packages row in the brief says the package is complete
    ("complete" in its Outcome cell, any case, not after "not"): that row is its only status row.
    Operational and Session rows are exempt (RECORDS-W3B r1).
An INDEX.md row stands for the package its "Package or round" cell starts with, and for any package it
names as "also `<id>`" (WP-080's row also carries WP-080-FU1).
K2 also requires the "Residuals recorded in Complete package rows" and "Obligations in completion
records" subsections. K21 also requires C16, refuses the claim "so a partial carry fails" in
REWRITES.md and the archive README, and requires both to say reviewers check the rest of a clause.
K24 also requires the ALLOC-1 bullet to write "ALLOC-1's review N1/N2", "its N3" and "its N4" (either
case). K30 also refuses the r6 clause chains "its N3, unparsed" and "; its N4, the" (r7, D2),
"Two more fidelity panels", which had no referent (r7, D5), the WP-180-FU3 fragment chain
"r1 N1, ...; r1 N2, the ...; r1 N4, the ..." (r8, CX-R8-03) and the phrase "a fixed depth 2 levels more" (r8, R8-02).

Rules are re-checked, not dropped silently: a rule whose source text is gone is re-anchored to
current evidence or retired, with a one-line reason at the rule (RECORDS-W3: K33's `:906`, and
K36's LOGS-1, H1R1 and Wave 3 rules; RECORDS-W3B: K26 and K28, re-anchored to INDEX.md; RECORDS-W3B
r1: K38 and K39 widened, each with its reason at the rule).

Exit 0 when every rule holds, 1 otherwise. Stdlib only, no network.
"""

import argparse
import os
import re
import subprocess
import sys

sys.dont_write_bytecode = True  # keep tools/records free of __pycache__
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import status_sections as S  # noqa: E402

SAFETY = [
    "- `MAX_RUN_MODE=PAPER`",
    "- `ALLOW_REAL_ORDERS=false`",
    "- `LIVE_MICRO_MAX_ORDER_NOTIONAL=0`",
    "- `LIVE_MICRO_MAX_ACCOUNT_EXPOSURE=0`",
    "- Production signer configured: **No**",
    "- Real venue credentials required: **No**",
    "- Human live-micro approval: **Not granted**",
]
SECTIONS = ["## Safety state", "## Current phase", "## Authorized now", "## Work packages", "## Open blockers",
            "### Closeout blockers", "### Residual queue", "### Residuals recorded in Complete package rows",
            "### Obligations in completion records", "## Human items", "### Wave 3 authorization (conditional)",
            "## Pending external evidence", "## Human and operational gates"]


def read(root, rel):
    with open(os.path.join(root, rel), encoding="utf-8") as fh:
        return fh.read()


INDEX = "docs/handoffs/INDEX.md"


def index_rows(root):
    """INDEX.md's rows: [{ids, lead, link, links, kind, outcome, merge, merges, package, line}]. ids: the
    package the "Package or round" cell starts with (lead), and each it names as "also `<id>`". link:
    the Handoff cell's link target when the cell is one link, else None; links: every link target in
    it. merges: {id: its SHAs}: the lead's are the Merge cell's; an "also" id's are the "merged `sha`"
    in its own parenthesis (RECORDS-W3B r1: not its host row's)."""
    out = []
    for n, l in enumerate(read(root, INDEX).split("\n"), 1):
        if not re.match(r"^\| \d{4}-\d{2}-\d{2} \|", l):
            continue
        c = [x.strip() for x in re.split(r"(?<!\\)\|", l)[1:-1]]
        if len(c) < 7:
            continue
        lead = re.match(r"^`([^`]+)`", c[2])
        link = re.match(r"^\[[^\]]+\]\(([^)]+)\)$", c[1])
        merges = {lead.group(1): re.findall(r"`([0-9a-f]{7,40})`", c[5])} if lead else {}
        also = []
        for m in re.finditer(r"\balso `([^`]+)`(?:\s*\(((?:[^()]|\([^()]*\))*)\))?", c[2]):
            also.append(m.group(1))
            merges.setdefault(m.group(1), re.findall(r"\bmerged `([0-9a-f]{7,40})`", m.group(2) or ""))
        out.append({"ids": ([lead.group(1)] if lead else []) + also, "lead": lead.group(1) if lead else None,
                    "link": link.group(1) if link else None, "links": re.findall(r"\]\(([^)]+)\)", c[1]),
                    "kind": c[3], "outcome": c[4], "merge": c[5], "merges": merges, "package": c[2], "line": n})
    return out


def index_by_id(rows):
    """{package id: its first INDEX.md row}."""
    by = {}
    for r in rows:
        for pid in r["ids"]:
            by.setdefault(pid, r)
    return by


def table_rows(lines, h3_prefix):
    """[(cells)] of the table under the ### heading that starts with h3_prefix."""
    out, on = [], False
    for line in lines:
        if line.startswith("#"):
            on = line.startswith(h3_prefix)
            continue
        if on and re.match(r"^\| `", line):
            cells = [c.strip() for c in re.split(r"(?<!\\)\|", line)[1:-1]]
            out.append(cells)
    return out


def cells_of(line):
    """A table line's cells; a line that does not end with "|" (a row continued below) keeps its last."""
    cells = [c.strip() for c in re.split(r"(?<!\\)\|", line)[1:]]
    return cells[:-1] if line.rstrip().endswith("|") else cells


SEPARATOR = re.compile(r"^\|\s*:?-{3,}")


def data_lines(lines, heading):
    """[(line number, line)]: every table line under the heading (h2 or h3) that starts with `heading`,
    except separator lines and the header line above each separator, whatever its id cell looks like."""
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


# K39: what names a package as Complete (see the docstring).
_ID = (r"(?:`[A-Z][A-Z0-9]*(?:-[A-Za-z0-9]+)+`"
       r"|(?<![\w`.-])(?!ADR-)[A-Z][A-Z0-9]+(?:-[A-Za-z0-9]+)+(?![\w`-]|\.\w))")
_ITEM = rf"(?:\*\*)?{_ID}(?:\*\*)?(?:\s*\([^()]*\))?(?:\*\*)?"
_SEP = r"(?:\s*,\s*(?:and\s+)?|\s+and\s+(?:(?:its|their|the)\s+(?:\w+\s+){0,2})?|\s*/\s*|\s+&\s+)"
K39_SUBJECT = re.compile(rf"{_ITEM}(?:{_SEP}{_ITEM})*\s*$")
K39_ID = re.compile(r"`(?P<bt>[A-Z][A-Z0-9]*(?:-[A-Za-z0-9]+)+)`"
                    r"|(?<![\w`.-])(?P<plain>(?!ADR-)[A-Z][A-Z0-9]+(?:-[A-Za-z0-9]+)+)(?![\w`-]|\.\w)")
K39_SHA = re.compile(r"(?:\*\*)?\s*\(`(?P<sha>[0-9a-f]{7,40})`")
K39_COMPLETE = re.compile(r"(?<![\w-])completed?(?![\w-])", re.I)
K39_VERB = re.compile(r"(?:\b(?:is|are|was|were)|\b(?:has|have|had)(?:\s+\w+)?\s+been|:)(?P<adv>(?:\s+\w+){0,2}?)\s*(?:\*\*)?\s*$",
                      re.I)
K39_AFTER = re.compile(r"(?:\s+with\s+qualifications?)?(?:\*\*)?\s*(?::|\((?P<paren>[^()]*)\))", re.I)
K39_HEDGES = {"not", "never", "no", "almost", "nearly", "partly", "partially", "mostly", "largely", "yet", "only",
              "half", "barely", "hardly", "incompletely"}
K39_SUBORDINATE = {"when", "once", "until", "till", "if", "unless", "after", "before", "whether", "while"}
# The brief's sentences, as K23 splits them, except after "i.e." and "e.g." (the historical
# "COMPLETE: batches 2A-2G, i.e. WP-150/..." line continues past them).
K39_SENTENCE = re.compile(r"(?<=[.!?])(?<!\bi\.e\.)(?<!\be\.g\.)\s+(?=[A-Z(`*\[])")


def ids_in(text):
    """[(id, the merge SHA given right after it, or None)] for each package id in text."""
    out = []
    for m in K39_ID.finditer(text):
        sha = K39_SHA.match(text, m.end())
        out.append((m.group("bt") or m.group("plain"), sha.group("sha") if sha else None))
    return out


def named_complete(sentence):
    """[(id, merge SHA or None, how)]: the packages one sentence names as Complete (K39)."""
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
                out += [(pid, sha, "its subject") for pid, sha in ids_in(lst.group(0))]
            label = re.search(r"\(([^()]*)\)(?:\*\*)?\s*:[^:]*$", subject)  # "The closeout (`ID`, ...): X is complete"
            if label:
                out += [(pid, sha, "the record cited for the completion") for pid, sha in ids_in(label.group(1))]
        comp = K39_AFTER.match(after)
        if comp and comp.group("paren") is not None:
            out += [(pid, sha, "the record cited for the completion") for pid, sha in ids_in(comp.group("paren"))]
        elif comp:
            out += [(pid, sha, "listed after 'complete:'") for pid, sha in ids_in(after[comp.end():])]
    return out


# K31: (label, brief pattern, evidence path, evidence text, evidence present?)
CLOSED_BEFORE_CUT = [
    ("GOV-2A NOTE-1: the reciprocal F17 note (I1)", r"reciprocal note owed",
     "docs/contracts/dependency-direction.md", "id namespace:** this F17 is a §3 forbidden-edge id", True),
    ("GOV-2A NOTE-2: the probe sources (I1)", r"probe sources are not committed|\(inline them\)",
     "docs/handoffs/GOV-2A.md", "| **NOTE-2** — commit the probe sources | **ADOPTED", True),
    ("WP-180-FU2: the schema-boundary §1 staleness (I2)", r"schema-boundary §1 staleness",
     "docs/contracts/schema-boundary.md", "(Corrected 2026-09-05: the pair was", True),
    ("SETL-1: the three zod facts for the §2 class table (I3)", r"zod facts for the §2 class table",
     "docs/contracts/schema-boundary.md", "| Waiver reach + durability; the `status` trigger *(measured by `SETL-1`", True),
    ("WP-160 R1-L2: the \"never throws\" wording (I4)", r"\"never throws\" is unenforced",
     "packages/features/src/inputs.ts", "Corrected 2026-09-15 by `GOV-2C` (comment only)", True),
    ("WP-230: the §2 error-construction row", r"arena-error-construction schema-boundary §2 candidate row",
     "docs/contracts/schema-boundary.md", "| Error construction *(measured by `WP-230` review r1", True),
    ("WP-170-FU1: the ARENA_NODE_TYPES widening", r"queued risk `ARENA_NODE_TYPES` widening",
     "docs/contracts/schema-boundary.md", "grew `ARENA_NODE_TYPES` with `\"null\"`", True),
    ("WP-210 follow_up 6: the §12.1 recording", r"§12\.1 port-interface landing",
     "docs/contracts/dependency-direction.md", "the handoff §12.1 port interfaces `Clock`, `MarketEventSource` and `ExecutionVenue`", True),
    ("TRDR-1: the phase-2 R1 addendum", r"phase-2 report R1 narrative addendum",
     "docs/experiments/phase-2-verification.md", "## Addendum (2026-09-07): §2 R1 is RESOLVED", True),
    ("TRDR-1: the ADR README row", r"docs/adr/README\.md:102",
     "docs/adr/README.md", "stays until it lands", False),
    ("TRDR-2: the main.ts:292 cast", r"main\.ts:292`?'s cast",
     "apps/trader/src/main.ts", "`venue` is handed over UNCAST (`BOOT-1`)", True),
    ("GATE-1: the fail-fast chain (GATE1-R4)", r"one fail-fast chain",
     ".github/workflows/ci.yml", "if: ${{ !cancelled() && steps.install.outcome == 'success' }}", True),
    ("GATE-1: 'neither self-checking' (CI-2 pins part of ci.yml)", r"neither self-check",
     "test/unit/tooling/ci-step-split.test.ts", "expect(scriptGates.map(({ script }) => script)).toEqual([", True),
    # r7
    ("RISK2-R1: the pipeline.ts premise (BOOT-1 7263c13)", r"^\| `RISK2-R1` \|",
     "packages/trading-core/src/pipeline.ts", "superseding this sentence's earlier premise", True),
    ("TRDR2-R8: the parenthesized alias (BOOT-1)", r"^\| `TRDR2-R8` \|",
     "test/unit/trader/query-boundary-cast-scan.test.ts", "(`TRDR-2` R8, closed by `BOOT-1`)", True),
    ("TRDR4-CITES: 'the claim itself still holds' (FOLD-1 found it stale)", r"claim itself still holds",
     "docs/handoffs/FOLD-1.md", "It now has nested records: a fixed depth, 2 levels more.", True),
    # r8
    ("GATE1-R3: the first real CI run's fresh install (CI-1 discharged H2)", r"^\| `GATE1-R3` \|",
     "docs/handoffs/CI-1.md", "(`H2` DISCHARGED)", True),
]
# TREE as a K36 rule's evidence revision: read the source from the checked tree (--root), not the cut.
TREE = "tree"
# K36: (label, brief line prefix, words the line must hold, source path, source text (one, or a tuple)
# at the cut[, evidence revision: TREE])
CARRIED_FACTS = [
    ("WP-190 R1-L1: the composed entries are total (CX-R8-01)", "| `N3` |",
     ["`buildExecutionPlan`", "`sealExecutionPlan`", "are total"],
     "docs/handoffs/WP-190.md", "The composed entries (`buildExecutionPlan`, `sealExecutionPlan`)"),
    ("WP-250 F2: the replay-determinism panel's named owner (CX-R8-02)", "- `WP-250`:",
     ["`packages/simulation`", "`apps/backtest-cli`"],
     "packages/observability/src/control/dashboards.ts", "a future packages/simulation or apps/backtest-cli grant"),
    # LOGS-1-RECUT r1
    # Retired (RECORDS-W3): "LOGS-1's gate names its reviewer, Fable (CX-RECUT-01)". LOGS-1 is Complete
    # (`7ac7985`), and governance `ae1180b` removed its Authorized-now bullet, gate included; the archived
    # row keeps the gate, and K37's RECUT_REFUSED still refuses the reviewer-less wording.
    # Re-anchored (RECORDS-W3): the user ratified ADR-024 on 2026-09-30 (`68e2fc2`), after the cut, so
    # "accepted provisionally" is history. The rule now reads the ratified ADR in the checked tree.
    ("H1R1-FRAME-ATOMICITY's closure carries ADR-024's qualifiers (L1)", "Closed, done or ruled",
     ["ratified by the user", "D2 exception", "half-applied"],
     "docs/adr/ADR-024-evaluate-once-per-venue-frame.md",
     ("Ratified by the user on 2026-09-30", "evaluated once, half-applied"), TREE),
    # Re-anchored (RECORDS-W3): once both conditions were met, the "- Wave 3 is authorized" bullet says so;
    # the condition's wording is the first bullet of the brief's Wave 3 authorization section.
    ("Wave 3's closeout condition is the CLOSED grade, not the audit (L3)",
     "- the fresh Wave 2 closeout audit grades Wave 2 CLOSED",
     ["grades Wave 2 CLOSED"],
     "IMPLEMENTATION_STATUS.md", "grades Wave 2 CLOSED"),
    ("V3-E15 keeps the imperative check (L3)", "| `V3-E15-DATA-API-V1-SUNSET` |",
     ["Check whether any current code calls v1."],
     "IMPLEMENTATION_STATUS.md", "Check whether any current code calls v1"),
    ("the THROUGHPUT-2 bullet points to the review's two LOWs (L4)", "- `THROUGHPUT-2`:",
     ["`TP2-R2-L1`", "`TP2-R2-L2`"],
     "docs/handoffs/THROUGHPUT-2.md", "TP2-R2-L2"),
]
# K37: (label, path, refused wording)
RECUT_REFUSED = [
    ("LOGS-1's gate without its reviewer (CX-RECUT-01)", "IMPLEMENTATION_STATUS.md", "Gate: a review of the preservation"),
    ("RW-145's Facts without the reviewer (CX-RECUT-01)", "docs/status-archive/REWRITES.md", "the gate (a preservation review and a green CI run)"),
    ("RW-01 says LOGS-1 merged while it is in merge (CX-RECUT-02)", "docs/status-archive/REWRITES.md", "when LOGS-1 merged"),
    ("'has merged ..., below its throughput targets' (L3)", "IMPLEMENTATION_STATUS.md", "below its throughput targets"),
    ("V3-E15 as a status claim (L3)", "IMPLEMENTATION_STATUS.md", "calls v1 is not yet checked"),
    ("the audit, not its grade, as Wave 3's condition (L3)", "IMPLEMENTATION_STATUS.md", "closeout audit is the other"),
]
# K33: every file:line citation in the brief, checked at the cut.
# (literal as it occurs in the brief, [(path, first line, last line, needle)]); first line None = a
# "quote": the needle (a stale cite) must be somewhere in that file at the cut.
CITATIONS = [
    ("`packages/trading-core/src/loop.ts:3118-3122`",
     [("packages/trading-core/src/loop.ts", 3118, 3122, "marks: { [tokenAssetId]: { midpoint: fill.price } }")]),
    ("cites stale lines `health-door.ts:181` and `:77`",
     [("test/unit/control-api/response-encoder-bound.test.ts", None, None, "(`apps/control-api/src/health-door.ts:181`)"),
      ("test/unit/control-api/response-encoder-bound.test.ts", None, None, "(`health-door.ts:77`)")]),
    ("`:301` (`readTraderHealthReport`)",
     [("apps/control-api/src/health-door.ts", 301, 301, "export function readTraderHealthReport(")]),
    ("`:83` (the first `z.record(`)",
     [("apps/control-api/src/health-door.ts", 83, 83, "z.record(")]),
    ("`test/integration/control-api/trader-health-shape.test.ts:353`",
     [("test/integration/control-api/trader-health-shape.test.ts", 353, 353, 'toContain("WP-220 accepted residual")')]),
    ("`apps/trader/README.md:144-160`",
     [("apps/trader/README.md", 144, 160, "`WP-220`'s accepted residual")]),
    ("`apps/control-api/src/health-door.ts:238`",
     [("apps/control-api/src/health-door.ts", 238, 238, "Bounded: at most 4096 instances")]),
    ("`apps/data-gateway/src/publisher.ts:633`",
     [("apps/data-gateway/src/publisher.ts", 633, 633, "the event remains in the WAL")]),
    ("`packages/execution-planner/src/refusals.ts:178-187`",
     [("packages/execution-planner/src/refusals.ts", 178, 187, "Every public entry point of this package promises a typed result")]),
    ("`book.ts:284` and `:361`",
     [("packages/order-book/src/book.ts", 284, 284, "safeParse(input.payload)"),
      ("packages/order-book/src/book.ts", 361, 361, "safeParse(input.payload)")]),
    ("`checks.ts:69`",
     [("apps/ops-cli/src/verify-venue/checks.ts", 69, 69, 'VERIFICATION_REPORT_PATH = "docs/venue/verified-2026-08-24.md"')]),
    ("`checks.ts:249-252`",
     [("apps/ops-cli/src/verify-venue/checks.ts", 249, 252, 'enum: ["2026-08-24"]')]),
    ("`packages/features/src/inputs.ts:744-765`",
     [("packages/features/src/inputs.ts", 744, 765, "Corrected 2026-09-15 by `GOV-2C` (comment only)")]),
    ("`build.ts:707-712`",
     [("packages/execution-planner/src/build.ts", 707, 712, 'case "CANCEL":')]),
    ("`apps/control-api/src/main.ts:80-90`",
     [("apps/control-api/src/main.ts", 80, 90, "nextAuditRecordId: () => randomUUID()")]),
    ("`lots.ts:151`",
     [("packages/risk/src/lots.ts", 151, 151, "built.sort(")]),
    ("`dataset-manifest.ts:457`",
     [("packages/storage-parquet/src/dataset-manifest.ts", 457, 457, "as unknown as DatasetManifest")]),
    ("`metric-shapes.ts:196`",
     [("packages/observability/src/control/metric-shapes.ts", 196, 196, "export interface TraderHealthReportInput")]),
    ("`control-plane.ts:440`",
     [("apps/control-api/src/control-plane.ts", 440, 440, "`[...keys]`, NOT `keys.map(...)`")]),
    ("`packages/binance-adapter/src/venue.ts:236`",
     [("packages/binance-adapter/src/venue.ts", 236, 236, "export const BINANCE_UNVERIFIED = [")]),
    ("(`:509` at `f43efe6`)",
     [("docs/spec/polymarket-bot-agent-orchestration-runbook.md", 509, 509,
       "Static Bracket runs in replay and live-data paper mode through the same code")]),
    ("(`:514` at `f43efe6`)",
     [("docs/spec/polymarket-bot-agent-orchestration-runbook.md", 514, 514, "accumulating meaningful live-data paper evidence")]),
    # Retired (RECORDS-W3): "`:906` at `f43efe6`". Governance `ae1180b` rewrote the human item that cited
    # the runbook's old §14 there, once CLOSEOUT-2 had run; the brief no longer cites it.
]
# K32: panel name in PENDING_PRODUCER_PANELS -> the phrase the brief uses for it
PENDING_PANEL_PHRASES = {
    "Replay determinism": "replay-determinism panel",
    "Predicted versus actual fills": "predicted-vs-actual",
    "Markout": "markout",
}


def archive_cut(root):
    """The cut the archive records: the one base= of every docs/status-archive verbatim-begin marker."""
    adir = os.path.join(root, S.ARCHIVE)
    bases = set()
    for name in sorted(os.listdir(adir)):
        if name.endswith(".md"):
            with open(os.path.join(adir, name), encoding="utf-8") as fh:
                bases.update(m.group("base") for m in map(S.BEGIN_RE.match, fh.read().split("\n")) if m)
    if len(bases) != 1:
        raise SystemExit(f"the archive's verbatim-begin markers name {len(bases)} cuts, not one: {sorted(bases)}")
    return bases.pop()


def show(repo, sha, path):
    """The text of path at sha, or None when it does not exist there."""
    r = subprocess.run(["git", "-C", repo, "show", f"{sha}:{path}"], capture_output=True, text=True)
    return r.stdout if r.returncode == 0 else None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--base", required=True)
    ap.add_argument("--cut", default=None, help="default: the archive's cut (the verbatim-begin markers' base=)")
    ap.add_argument("--repo", default=".")
    ap.add_argument("--root", default=None)
    args = ap.parse_args()
    root = args.root or args.repo
    sha = S.resolve(args.repo, args.base)
    base = S.base_text(args.repo, sha)
    cut = S.resolve(args.repo, args.cut or archive_cut(root))
    brief = read(root, S.STATUS)
    lines = brief.split("\n")
    fails = []
    irows = index_rows(root)
    index = index_by_id(irows)

    # K1
    bb, bl = len(base.encode("utf-8")), len(S.split_lines(base))
    nb, nl = len(brief.encode("utf-8")), len(S.split_lines(brief))
    if nb > 0.15 * bb or nl > 0.15 * bl:
        fails.append(f"K1: the brief is {nb} B / {nl} lines; the budget is {int(0.15 * bb)} B / {int(0.15 * bl)} lines")
    # K2
    for h in SECTIONS:
        if not any(l.startswith(h) for l in lines):
            fails.append(f"K2: missing section {h!r}")
    for s in SAFETY:
        if s not in lines:
            fails.append(f"K2: the safety state lacks {s!r}")
    # K3
    if "one line per item" in brief:
        fails.append("K3: the intro promises 'one line per item'")
    # K4
    for n, l in enumerate(lines, 1):
        for m in re.finditer(r"\b(?:runbook|handoff)\s*\(?\s*:\d+(?:[-/:]\d+)*(?P<rest>[^;.)]{0,40})", l):
            if not re.search(r"at `[0-9a-f]{7,40}`", m.group("rest")):
                fails.append(f"K4: line {n}: bare line cite {m.group(0).strip()!r}")
    # K5, K7, K9
    close = table_rows(lines, "### Closeout blockers")
    resid = table_rows(lines, "### Residual queue")
    for cells in close + resid:
        if len(cells) < 3 or cells[-1] in ("", "—", "-"):
            fails.append(f"K5: row {cells[0]} has no owner")
    for cells in close:
        words = len(cells[1].split()) if len(cells) > 1 else 0
        if words > 90:
            fails.append(f"K7: closeout blocker {cells[0]}'s state cell has {words} words (max 90)")
    for cells in resid:
        if len(cells) > 1 and cells[1].lower().startswith("complete"):
            fails.append(f"K9: residual row {cells[0]} is complete, not open")
    # K6
    if any(c[-1].startswith("row:") for c in resid + close) and 'beginning "row:"' not in brief:
        fails.append("K6: owners begin with 'row:' but the intro does not say what that means")
    # K8
    for n, l in enumerate(lines, 1):
        for m in re.finditer(r"PARTLY DONE", l):
            if "archived" not in l[max(0, m.start() - 60):m.start()]:
                fails.append(f"K8: line {n}: 'PARTLY DONE' is not attributed to the archived state cell")
    # K10
    for n, l in enumerate(lines, 1):
        if "`SER-0`" in l and l.startswith("- ") and ("merged" in l or "complete" not in l):
            fails.append(f"K10: line {n}: SER-0 must read as complete, not merged")
    # K11
    agents = read(root, "AGENTS.md")
    claude = read(root, "CLAUDE.md")
    for name, text in (("AGENTS.md", agents), ("CLAUDE.md", claude)):
        hit = [l for l in text.split("\n") if "docs/status-archive/" in l]
        if not hit or not any("frozen" in l for l in hit):
            fails.append(f"K11: {name} does not say docs/status-archive/ is frozen")
    # K12
    for rel in ("docs/handoffs/README.md", "docs/handoffs/INDEX.md"):
        text = read(root, rel)
        if re.search(r"add one line (to|here)", text) or "add or update the handoff's single" not in text:
            fails.append(f"K12: {rel} does not say 'add or update the handoff's single' INDEX row")
    # K13
    rows, on, cur = {}, False, None
    for l in base.split("\n"):
        if l == "## Work packages":
            on = True
            continue
        if on and l.startswith("#"):
            break
        m = re.match(r"^\| `([A-Za-z0-9-]+)`", l) if on else None
        if m:
            cur = m.group(1)
            rows[cur] = rows.get(cur, "") + l + "\n"
        elif on and cur:
            rows[cur] += l + "\n"
    auth, on, cur = {}, False, None
    for l in lines:
        if l.startswith("## "):
            on = l == "## Authorized now"
            continue
        if not on:
            continue
        m = re.match(r"^- \*\*`([A-Za-z0-9-]+)`\*\*", l)
        if m:
            cur = m.group(1)
            auth[cur] = l
        elif cur and l.startswith("  "):
            auth[cur] += "\n" + l
    for pid, text in auth.items():
        if "a green CI run on GitHub" in rows.get(pid, "") and "green CI run on GitHub" not in text:
            fails.append(f"K13: 'Authorized now' {pid} omits its gate's green CI run on GitHub")

    # K14
    for rel in (f"{S.ARCHIVE}/README.md", f"{S.ARCHIVE}/REWRITES.md"):
        text = read(root, rel)
        if re.search(r"complete and verbatim", text) or "review question" not in text:
            fails.append(f"K14: {rel} overstates what the proof checks (no 'review question' caveat)")
        if re.search(r"with a true kind|C8 checks each kind\.", text):
            fails.append(f"K14: {rel} claims C8 proves every declared kind true")

    # K15, K16, K17
    for n, l in enumerate(lines, 1):
        if re.search(r"\bgate is open\b", l, flags=re.I):
            fails.append(f"K15: line {n}: 'gate is open' is ambiguous; say met or unmet")
        if re.search(r"\bruled by the user \d{4}-\d{2}-\d{2}\.", l, flags=re.I):
            fails.append(f"K16: line {n}: a ruling without what it ruled")
        if re.search(r"\brow (also )?records that\b", l, flags=re.I):
            fails.append(f"K17: line {n}: narrates the record; state the fact")
    # K18
    rw = read(root, f"{S.ARCHIVE}/REWRITES.md")
    if "\n## Coverage: base lines not included in a rewrite pair\n" not in rw:
        fails.append("K18: REWRITES.md's coverage heading is not 'Coverage: base lines not included in a rewrite pair'")
    # K19
    h = "### Wave 3 authorization (conditional)"
    if h in lines:
        rest = lines[lines.index(h) + 1:]
        para, bullets, i = [], 0, 0
        while i < len(rest) and not rest[i].strip():
            i += 1
        while i < len(rest) and rest[i].strip() and not rest[i].startswith("- "):
            para.append(rest[i])
            i += 1
        while i < len(rest) and not rest[i].strip():
            i += 1
        while i < len(rest) and rest[i].startswith("- "):
            bullets += 1
            i += 1
        intro = " ".join(para)
        words = len(intro.split())
        if words > 24 or "2026-09-30" not in intro or "`WP-260`" not in intro or bullets != 2 or "may start" not in intro:
            fails.append(f"K19: the Wave 3 intro has {words} words (max 24) and {bullets} condition bullets (need 2), "
                         "and must name 2026-09-30 and `WP-260` and say the orchestrator 'may start'")
    # K20
    if "Everything below was moved verbatim" in brief:
        fails.append("K20: the Archive intro says 'Everything below was moved verbatim', but a file list follows")
    # K21
    intro = rw.split("\n## Coverage:", 1)[0]
    missing = [c for c in ("C6", "C8", "C9", "C10", "C11", "C12", "C13", "C14", "C15", "C16") if f"({c}" not in intro and f" {c})" not in intro and f"{c}," not in intro]
    if missing:
        fails.append(f"K21: REWRITES.md's intro does not name {', '.join(missing)}")
    if "and what it does not carry and where that lives" in intro:
        fails.append("K21: REWRITES.md's Facts bullet uses the old wording")
    for rel, text in ((f"{S.ARCHIVE}/REWRITES.md", intro), (f"{S.ARCHIVE}/README.md", read(root, f"{S.ARCHIVE}/README.md"))):
        if "partial carry fails" in text:
            fails.append(f"K21: {rel} claims C15 makes a partial carry fail; it only checks for an accounting marker")
        if not re.search(r"reviewers must check the rest of each clause", text, flags=re.I):
            fails.append(f"K21: {rel} does not say reviewers must check the rest of each clause")
    # K22
    if "verbatim, and frozen," in agents:
        fails.append("K22: AGENTS.md nests 'and frozen,' inside its and-chain; use a colon and a semicolon")

    # K23
    for n, l in enumerate(lines, 1):
        if l.startswith("#") or not l.strip() or l.startswith(("Closed: `", "Closed, done or ruled")):
            continue
        cells = re.split(r"(?<!\\)\|", l)[1:-1] if l.startswith("|") else [l]
        for cell in cells:
            for sent in re.split(r"(?<=[.!?])\s+(?=[A-Z(`*\[])", cell.strip()):
                if len(sent.split()) > 45:
                    fails.append(f"K23: line {n}: a {len(sent.split())}-word sentence (max 45): {sent[:70]!r}")
    # K24
    h = "### Residuals recorded in Complete package rows"
    if h in lines:
        i = lines.index(h) + 1
        while i < len(lines) and not lines[i].startswith("#"):
            if lines[i].startswith("- `SER-3`"):
                hits = list(re.finditer(r"\bN4\b", lines[i]))
                if not hits or any(not lines[i][:m.start()].endswith("SER-3's ") for m in hits):
                    fails.append(f"K24: line {i + 1}: the SER-3 bullet must write \"SER-3's N4\", not a bare N4 "
                                 "(GOV-2B's test:replay N4 is a different item)")
            i += 1
    # K24 (ALLOC-1), K26, K30
    h = "### Residuals recorded in Complete package rows"
    if h in lines:
        i = lines.index(h) + 1
        intro_ok = False
        while i < len(lines) and not lines[i].startswith("#"):
            l = lines[i]
            if l and not l.startswith("- ") and "the handoff linked from the package's row" in l:
                intro_ok = True
            if l.startswith("- `ALLOC-1`"):
                rest = re.sub(r"ALLOC-1's review N1/N2|\b[Ii]ts N3\b|\b[Ii]ts N4\b", "", l)
                if re.search(r"\bN\d\b", rest):
                    fails.append(f"K24: line {i + 1}: the ALLOC-1 bullet must write \"ALLOC-1's review N1/N2\", \"its N3\" "
                                 "and \"its N4\" (GOV-2B's N2-N4 are different items)")
            # Re-anchored (RECORDS-W3B): a Complete package's row is its INDEX.md row, not a Work packages row.
            m = re.match(r"^- `([A-Za-z0-9-]+)`", l)
            if m:
                row = index.get(m.group(1))
                link = row["link"] if row else None
                if not link or "/" in link or not os.path.isfile(os.path.join(root, "docs/handoffs", link)):
                    fails.append(f"K26: line {i + 1}: {m.group(1)} has no INDEX.md row that links its handoff")
            if re.search(r"landing: contract owner recording\.|^- `UNIV-1`: LOW-2 drifts|its N3, unparsed|; its N4, the", l):
                fails.append(f"K30: line {i + 1}: a verbless fragment; write a full sentence")
            i += 1
        if not intro_ok:
            fails.append(f"K26: the '{h}' intro does not say an unnamed owner is in the handoff linked from the package's row")
    # K27
    for n, l in enumerate(lines, 1):
        if "payoff_model NOT NULL" in l:
            fails.append(f"K27: line {n}: the payoff_model NOT NULL divergence is resolved (WP-210, migration 0009)")
    # K28
    h = "### Obligations in completion records"
    if h in lines:
        # Re-anchored (RECORDS-W3B): Complete packages are read from INDEX.md; the brief's table lists open ones.
        complete = {pid for pid, r in index.items() if r["outcome"].startswith("Complete")}
        complete |= {c[0].strip("`") for c in table_rows(lines, "## Work packages") if len(c) > 2 and c[2].startswith("Complete")}
        i = lines.index(h) + 1
        while i < len(lines) and not lines[i].startswith("#"):
            l = lines[i]
            if l.startswith("- "):
                body = re.sub(r"^- (?:`[^`]+`(?:, `[^`]+`)*): ", "", l)
                for sent in re.split(r"(?<=[.!?])\s+(?=[A-Z(`*\[])", body):
                    m = re.match(r"^`?(WP-\d+[A-Za-z0-9-]*)`? ", sent)
                    if m and m.group(1) not in complete and not re.search(r"\bmust\b|\bowes?\b|\bowed\b", sent):
                        fails.append(f"K28: line {i + 1}: {m.group(1)} is not Complete, so state its obligation: {sent[:70]!r}")
            i += 1
    # K29
    for n, l in enumerate(rw.split("~~~unpaired", 1)[0].split("\n"), 1):
        if len(l.split()) > 80:
            fails.append(f"K29: REWRITES.md line {n}: {len(l.split())} words on one line (max 80)")
    for n, l in enumerate(read(root, f"{S.ARCHIVE}/README.md").split("\n"), 1):
        if len(l.split()) > 80:
            fails.append(f"K29: the archive README line {n}: {len(l.split())} words on one line (max 80)")
    # K31
    for label, pat, path, needle, present in CLOSED_BEFORE_CUT:
        ev = show(args.repo, cut, path)
        if ev is None or (needle in ev) != present:
            fails.append(f"K31: {label}: the evidence at {cut[:12]} is gone ({path}); re-check the item before keeping this rule")
        for n, l in enumerate(lines, 1):
            if re.search(pat, l):
                fails.append(f"K31: line {n}: {label} was closed before the cut ({path}); drop it with the evidence")
    # K32
    dash = show(args.repo, cut, "packages/observability/src/control/dashboards.ts") or ""
    block = dash.split("PENDING_PRODUCER_PANELS", 1)[-1]
    panels = re.findall(r'panel: "([^"]+)"', block)
    if not panels:
        fails.append("K32: no PENDING_PRODUCER_PANELS panel found at the cut; re-check the rule")
    low = brief.lower()
    for panel in panels:
        phrase = PENDING_PANEL_PHRASES.get(panel)
        if phrase is None:
            fails.append(f"K32: pending panel {panel!r} has no brief phrase; carry it and add it to PENDING_PANEL_PHRASES")
        elif phrase not in low:
            fails.append(f"K32: pending panel {panel!r} is not carried in the brief (expected {phrase!r})")
    for n, l in enumerate(lines, 1):
        if "Two more fidelity panels" in l:
            fails.append(f"K30: line {n}: 'Two more fidelity panels' has no referent; say 'Two fidelity panels' and name the third")
        if re.search(r"^- `WP-180-FU3`: r1 N1, |; r1 N2, the |; r1 N4, the ", l):
            fails.append(f"K30: line {n}: the WP-180-FU3 fragment chain 'r1 N1, ...; r1 N2, ...'; write full sentences")
        if "a fixed depth 2 levels more" in l:
            fails.append(f"K30: line {n}: 'a fixed depth 2 levels more' is hard to parse; say 'two levels deeper, to a fixed depth'")
    # K33
    spans = []
    for lit, checks in CITATIONS:
        at = [m.start() for m in re.finditer(re.escape(lit), brief)]
        if not at:
            fails.append(f"K33: the citation {lit!r} is registered but not in the brief; update CITATIONS")
        spans += [(s, s + len(lit)) for s in at]
        for path, a, b, needle in checks:
            ev = show(args.repo, cut, path)
            if ev is None:
                fails.append(f"K33: {lit!r}: {path} does not exist at {cut[:12]}")
                continue
            where = ev if a is None else "\n".join(ev.split("\n")[a - 1:b])
            if needle not in where:
                span = "the file" if a is None else f"lines {a}-{b}"
                fails.append(f"K33: {lit!r}: {needle!r} is not on {span} of {path} at {cut[:12]}")
    for m in re.finditer(r"as of `([0-9a-f]{7,40})`", brief):
        if not cut.startswith(m.group(1)):
            n = brief.count("\n", 0, m.start()) + 1
            fails.append(f"K33: line {n}: the brief pins its citations as of `{m.group(1)}`, but they are checked at the cut {cut[:12]}")
    for m in re.finditer(r"(?<![0-9]):\d+", brief):
        if not any(s <= m.start() < e for s, e in spans):
            n = brief.count("\n", 0, m.start()) + 1
            fails.append(f"K33: line {n}: the citation {brief[max(0, m.start() - 40):m.end()]!r} is not registered in CITATIONS")
    # K34
    venue = show(args.repo, cut, "packages/binance-adapter/src/venue.ts") or ""
    unverified = re.findall(r'id: "(BNC-U\d+)"', venue.split("BINANCE_UNVERIFIED = [", 1)[-1].split("] as const", 1)[0])
    if not unverified:
        fails.append("K34: no BINANCE_UNVERIFIED id found at the cut; re-check the rule")
    for bid in unverified:
        if f"`{bid}`" not in brief:
            fails.append(f"K34: {bid} is still in BINANCE_UNVERIFIED at {cut[:12]}, but the brief does not name it")
    # K35
    readme = read(root, f"{S.ARCHIVE}/README.md")
    want = f"regression checks for {len(CLOSED_BEFORE_CUT)} specific closures"
    if want not in readme or "not a detector" not in readme:
        fails.append(f"K35: the archive README must describe K31 as '{want}' and say it is 'not a detector'")
    if "refuses an item the brief carries as owed when" in readme:
        fails.append("K35: the archive README claims K31 refuses any item closed before the cut")
    # K36
    for label, prefix, words, path, needle, *at in CARRIED_FACTS:
        if at and at[0] == TREE:
            where, ev = "the checked tree", (read(root, path) if os.path.isfile(os.path.join(root, path)) else None)
        else:
            where, ev = cut[:12], show(args.repo, cut, path)
        needles = (needle,) if isinstance(needle, str) else needle
        if ev is None or any(n not in ev for n in needles):
            fails.append(f"K36: {label}: the source text is gone at {where} ({path}); re-check the rule")
        hits = [l for l in lines if l.startswith(prefix)]
        if len(hits) != 1:
            fails.append(f"K36: {label}: expected one brief line starting {prefix!r}, found {len(hits)}")
            continue
        missing = [w for w in words if w not in hits[0]]
        if missing:
            fails.append(f"K36: {label}: the brief line {prefix!r} lacks {', '.join(repr(w) for w in missing)}")
    # K37
    cite = re.compile(r"[\w./-]+\.(?:ts|md|yaml|yml|json|sql|py|mjs):\d+|`:\d+`")
    sec, pin = None, None
    for n, l in enumerate(lines, 1):
        if re.match(r"^#{2,3} ", l):
            sec, pin = l, None
            continue
        m = re.search(r"as of `([0-9a-f]{7,40})`", l)
        if m and pin is None:
            pin = m.group(1)
            continue
        if pin and cite.search(l):
            for o in re.findall(r"\b[Aa]t `([0-9a-f]{7,40})`", l):
                if not (o.startswith(pin) or pin.startswith(o)) and "unchanged" not in l:
                    fails.append(f"K37: line {n}: {sec!r} pins its citations as of `{pin}`, but this line pins `{o}`")
    for label, rel, bad in RECUT_REFUSED:
        text = brief if rel == "IMPLEMENTATION_STATUS.md" else read(root, rel)
        if bad in text:
            fails.append(f"K37: {label}: {rel} has {bad!r} again")
    # K38
    # Widened (RECORDS-W3B r1, RW3B-I1): every data line counts; table_rows saw only backticked ids.
    wp_rows = data_lines(lines, "## Work packages")
    wp_ids = {row_id(cells_of(l)) for _n, l in wp_rows}
    # K40's drafts: open rows whose Record cell links no handoff yet.
    wp_drafts = {row_id(cells_of(l)) for _n, l in wp_rows if not re.search(r"\]\(docs/handoffs/", (cells_of(l) or [""])[-1])}
    for n, l in wp_rows:
        cells = cells_of(l)
        if len(cells) > 2 and cells[2].strip("* ").lower().startswith("complete"):
            fails.append(f"K38: line {n}: Work packages row {row_id(cells)} is Complete; move it to {INDEX} (README rules 1 and 10)")
    # K39
    # Widened (RECORDS-W3B r1, RW3B-I2/I3/I4): r0 read only "is/are complete" and took every id in such a
    # sentence; the brief once wrote "is also complete" (27ac802), and "The sweep is complete, and `V2-3`
    # is running." named V2-3. Ids are now bound to the verb, and an "also" id's SHA is its own.
    named, wp, h = [], False, "### Residuals recorded in Complete package rows"
    for n, l in enumerate(lines, 1):
        if l.startswith("#"):
            wp = l.startswith("## Work packages")
            continue
        if wp and l.startswith("|"):
            continue  # K38's
        for cell in (cells_of(l) if l.startswith("|") else [l]):
            for sent in K39_SENTENCE.split(cell.strip()):
                named += [(n, pid, merge, how) for pid, merge, how in named_complete(sent)]
    if h in lines:
        i = lines.index(h) + 1
        while i < len(lines) and not lines[i].startswith("#"):
            m = re.match(r"^- `([A-Za-z0-9-]+)`", lines[i])
            if m:
                named.append((i + 1, m.group(1), None, "a Complete-row residual bullet"))
            i += 1
    for n, pid, merge, how in named:
        row = index.get(pid)
        if row is None:
            fails.append(f"K39: line {n}: the brief names {pid} as Complete ({how}), but {INDEX} has no row for it")
        elif merge and not any(s.startswith(merge) or merge.startswith(s) for s in row["merges"].get(pid, [])):
            fails.append(f"K39: line {n}: the brief gives {pid}'s merge as {merge}, but its {INDEX} row (line {row['line']}) "
                         f"gives {', '.join(row['merges'].get(pid, [])) or 'none'} for {pid}")
    # K40
    hdir = os.path.join(root, "docs/handoffs")
    links = {t for r in irows for t in r["links"]}
    for name in sorted(os.listdir(hdir)):
        if not name.endswith(".md") or name in ("README.md", "INDEX.md") or name.startswith("_"):
            continue
        if name not in links and name[:-3] not in wp_drafts:
            fails.append(f"K40: docs/handoffs/{name} has no {INDEX} row (one row per handoff; README rule 10)")
    for r in irows:
        for t in r["links"]:
            if "/" not in t and not os.path.isfile(os.path.join(hdir, t)):
                fails.append(f"K40: {INDEX} line {r['line']} links {t}, which does not exist")
    archived = {}
    adir = os.path.join(root, S.ARCHIVE)
    for name in sorted(os.listdir(adir)):
        if not name.startswith("work-packages-"):
            continue
        for n, l in enumerate(read(root, f"{S.ARCHIVE}/{name}").split("\n"), 1):
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

    # K25
    sec, sec_lines = None, []
    def k25(sec, sec_lines):
        pinned = any(re.search(r"(?:as of|at) `[0-9a-f]{7,40}`", l) for _n, l in sec_lines)
        for n, l in sec_lines:
            if re.search(r"[\w./-]+\.(?:ts|md|yaml|yml|json|sql|py|mjs):\d+", l) and not pinned:
                fails.append(f"K25: line {n}: a file:line citation in section {sec!r}, which states no commit")
                return
    for n, l in enumerate(lines, 1):
        if re.match(r"^#{2,3} ", l):
            if sec:
                k25(sec, sec_lines)
            sec, sec_lines = l, []
        elif sec:
            sec_lines.append((n, l))
    if sec:
        k25(sec, sec_lines)

    print(f"brief {nb} B / {nl} lines = {100 * nb / bb:.1f}% / {100 * nl / bl:.1f}% of the base ({bb} B / {bl} lines at {sha[:12]}); "
          f"evidence at the cut {cut[:12]}")
    print(f"closeout rows {len(close)}, residual rows {len(resid)}, authorized bullets {len(auth)}, "
          f"work-package rows {len(wp_rows)}, INDEX.md packages {len(index)}, named Complete {len(named)}, "
          f"archived Complete {len(archived)}")
    for f in fails:
        print("  " + f)
    print("RESULT: " + ("FAIL" if fails else "PASS"))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
