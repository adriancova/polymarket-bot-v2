#!/usr/bin/env python3
"""Check the brief's budget and the measurable parts of the writing standard (LOGS-1).

Usage: python3 tools/records/check-brief.py --base <rev> [--repo .] [--root .]

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
K2 also requires the "Residuals recorded in Complete package rows" and "Obligations in completion
records" subsections.

Exit 0 when every rule holds, 1 otherwise. Stdlib only, no network.
"""

import argparse
import os
import re
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


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--base", required=True)
    ap.add_argument("--repo", default=".")
    ap.add_argument("--root", default=None)
    args = ap.parse_args()
    root = args.root or args.repo
    sha = S.resolve(args.repo, args.base)
    base = S.base_text(args.repo, sha)
    brief = read(root, S.STATUS)
    lines = brief.split("\n")
    fails = []

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
    missing = [c for c in ("C6", "C8", "C9", "C10", "C11", "C12", "C13", "C14", "C15") if f"({c}" not in intro and f" {c})" not in intro and f"{c}," not in intro]
    if missing:
        fails.append(f"K21: REWRITES.md's intro does not name {', '.join(missing)}")
    if "and what it does not carry and where that lives" in intro:
        fails.append("K21: REWRITES.md's Facts bullet uses the old wording")
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

    print(f"brief {nb} B / {nl} lines = {100 * nb / bb:.1f}% / {100 * nl / bl:.1f}% of the base ({bb} B / {bl} lines at {sha[:12]})")
    print(f"closeout rows {len(close)}, residual rows {len(resid)}, authorized bullets {len(auth)}")
    for f in fails:
        print("  " + f)
    print("RESULT: " + ("FAIL" if fails else "PASS"))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
