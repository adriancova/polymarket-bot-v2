#!/usr/bin/env python3
"""Prove that nothing in the base IMPLEMENTATION_STATUS.md was lost (LOGS-1).

Usage:
  python3 tools/records/check-preservation.py --base <rev> [--repo .] [--root .] [--only A,B,C] [--max-report N]

Proof A (strict partition): every docs/status-archive/*.md verbatim region equals
  lines a..b of the base file and matches its sha256 marker; the regions are
  disjoint, cover every line, and concatenate to the base file byte for byte.
Proof B (line multiset): every non-blank base line, counted with multiplicity,
  appears in an archive verbatim region or verbatim in the brief. REWRITES.md
  quotations are counted but not credited (see proof_b).
Proof C (facts and navigation):
  C1 every base work-package row id has a one-line row in the brief, and every
     SHA in that row's Merge cell occurs in the base row;
  C2 every closeout-blocker and residual-queue id is named in the brief's Open
     blockers or Human items section;
  C3 every backticked 7-40 hex token in the brief occurs in the base file or is
     a git object;
  C4 every relative link in the brief, the archive notes, the handoff INDEX and
     README, and the archive files' generated link notes resolves (same-file
     anchors included); every relative link inside an archived region (written
     relative to the repository root) resolves from the root and has a working
     counterpart in that file's link note;
  C5 MOVE-MAP.md names every base heading, package row id and blocker/residual
     id, and sends a bullet marked DISCHARGED to the section it names;
  C6 every REWRITES.md "old" block equals the lines it cites in ITS base (the
     file's pinned rewrites-base unless the block names another), and every
     "new" line occurs in the brief;
  C7 docs/handoffs/INDEX.md has exactly one line per handoff file (untracked
     files named "_*" are skipped);
  C8 REWRITES.md coverage: every non-blank line of the rewrites-base is inside
     an old block or an "unpaired" declaration, and each declaration's kind is
     checked against both texts. verbatim: the line is in the brief.
     complete-row: the range is exactly that package row, whose base status
     cell begins "Complete" or "Superseded", and the brief lists it so.
     closed-row: the range is exactly that row, the brief's closed lists name
     it, and the BASE row is closed (see base_row_closed). history: the range
     holds no package or blocker row start.
     Every open id in the brief's closeout and residual tables, and every live
     package row, is paired. After a re-cut, every line inserted or changed
     since the rewrites-base must be covered the same way at the cut;
  C9 no two REWRITES.md entries share one Facts account (no boilerplate);
  C11 an archive file named in an entry's Facts account holds at least one of
     that entry's old lines (so "history in X.md" points where the text is);
  C10 every "keep" phrase of an entry occurs in that entry's old text and in
     the brief (case, whitespace and Markdown emphasis ignored); every entry
     that pairs an open row carries at least one keep phrase.

C6 and C10 authenticate what REWRITES.md says; they cannot judge whether a
rewrite kept every fact. That remains a review question.

Exit 0 when every selected proof passes, 1 otherwise. Stdlib only, no network.
"""

import argparse
import collections
import difflib
import os
import re
import subprocess
import sys

sys.dont_write_bytecode = True  # keep tools/records free of __pycache__
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import status_sections as S  # noqa: E402

NOTES = ["README.md", "MOVE-MAP.md", "REWRITES.md"]
LINKED = [S.STATUS, "docs/handoffs/INDEX.md", "docs/handoffs/README.md"] + [f"{S.ARCHIVE}/{n}" for n in NOTES]


def read(root, rel):
    with open(os.path.join(root, rel), encoding="utf-8") as fh:
        return fh.read()


def section(lines, start_pred, stop_pred):
    """Lines from the first line matching start_pred up to (not including) the next stop_pred line."""
    out, on = [], False
    for i, line in enumerate(lines):
        if not on and start_pred(line):
            on = True
            out.append((i + 1, line))
            continue
        if on:
            if stop_pred(line):
                break
            out.append((i + 1, line))
    return out


ROW_ID = re.compile(r"^\| (?:\(superseded row\) )?`([A-Za-z0-9-]+)`")
BOLD_ID = re.compile(r"^\| \*\*(.+?)\*\* \|")


def package_rows(lines):
    """[(id, text of the row including continuation lines)] from the base's work-package table."""
    sec = section(lines, lambda l: l == "## Work packages", lambda l: l.startswith("#"))
    rows = []
    for _n, line in sec:
        m = ROW_ID.match(line)
        if m:
            rows.append([m.group(1), line])
        elif rows:
            rows[-1][1] += "\n" + line
    return rows


def blocker_ids(lines):
    """Normalized ids of the base's closeout-blocker and residual-queue rows."""
    sec = section(lines, lambda l: l == "## Open blockers",
                  lambda l: l.startswith("## ") or l.startswith("### The cross-package") or l.startswith("### Cross-package"))
    ids = []
    for _n, line in sec:
        m = BOLD_ID.match(line)
        if m:
            raw = m.group(1).replace("**", "")
            ids.append(re.sub(r" \(.*\)$", "", raw).strip())
    return ids


def headings(lines):
    return [l for l in lines if re.match(r"^#{1,6} ", l)]


def strip_fences(text):
    """Drop fenced blocks (``` or ~~~): quoted text there is not navigation."""
    out, fence = [], None
    for line in text.split("\n"):
        mark = line[:3]
        if fence is None and mark in ("```", "~~~"):
            fence = mark
            continue
        if fence is not None:
            if line.startswith(fence) and not line[3:].strip():
                fence = None
            continue
        out.append(line)
    return "\n".join(out)


def slug(heading_text):
    s = heading_text.strip().lower()
    s = re.sub(r"[^\w\- ]", "", s)
    return s.replace(" ", "-")


def parse_rewrites(text):
    """Parse REWRITES.md.

    Returns (rewrites_base, blocks, entries). A block is a dict with kind
    ("old", "new", "keep" or "unpaired"), base (None means the pinned
    rewrites-base), a and b (the cited lines of an old block), its lines, and
    the RW entry it sits in. entries maps "RW-NN" to its Facts lines.
    """
    m = re.search(r"^<!-- rewrites-base: ([0-9a-f]{40}) -->$", text, flags=re.M)
    rwbase = m.group(1) if m else None
    blocks, entries, cur, entry, facts = [], collections.OrderedDict(), None, None, None
    for line in text.split("\n"):
        if cur is None:
            h = re.match(r"^## (RW-\d+):", line)
            if h:
                entry, facts = h.group(1), None
                entries[entry] = []
                continue
            if line.startswith("## "):
                entry = facts = None
                continue
            mo = re.match(r"^~~~(old|unpaired)(?: base=([0-9a-f]{40}))?(?: lines=(\d+)-(\d+))?$", line)
            if mo:
                if mo.group(1) == "old" and not mo.group(3):
                    raise ValueError(f"REWRITES.md: an old block needs lines=a-b: {line!r}")
                cur = {"kind": mo.group(1), "base": mo.group(2), "a": int(mo.group(3) or 0),
                       "b": int(mo.group(4) or 0), "lines": [], "entry": entry}
                facts = None
                continue
            if line in ("~~~new", "~~~keep"):
                cur = {"kind": line[3:], "base": None, "a": 0, "b": 0, "lines": [], "entry": entry}
                facts = None
                continue
            if line.startswith("~~~"):
                raise ValueError(f"REWRITES.md: unknown block {line!r}")
            if entry and line.startswith("**Facts.**"):
                facts = entries[entry]
            if facts is not None:
                facts.append(line)
        elif line == "~~~":
            blocks.append(cur)
            cur = None
        else:
            cur["lines"].append(line)
    if cur is not None:
        raise ValueError("REWRITES.md: unterminated block")
    return rwbase, blocks, entries


def norm(text):
    """Case, whitespace and Markdown emphasis ignored, for keep phrases."""
    text = text.replace("\\|", "|")
    text = re.sub(r"[`*]", "", text)
    return re.sub(r"\s+", " ", text).strip().lower()


def row_starts(lines):
    """{id: 1-based start line} of package rows and blocker/residual rows in a base text."""
    out, where = {}, ""
    for n, line in enumerate(lines, 1):
        if line.startswith("## "):
            where = line
        if where == "## Work packages":
            m = ROW_ID.match(line)
            if m:
                out.setdefault(("pkg", m.group(1)), n)
        elif where == "## Open blockers":
            if line.startswith("### The cross-package") or line.startswith("### Cross-package"):
                where = ""
                continue
            m = BOLD_ID.match(line)
            if m:
                raw = m.group(1).replace("**", "")
                out.setdefault(("row", re.sub(r" \(.*\)$", "", raw).strip()), n)
    return out


CLOSURE = r"(?:CLOSED|COMPLETE|DONE|RULED|DISCHARGED|MOOT|RATIFIED|SUPERSEDED)\b"


def base_status_complete(line):
    """True when a base package row's status cell begins Complete or Superseded."""
    cells = line.split(" | ")
    status = re.sub(r"[*`]", "", cells[1]).strip() if len(cells) > 1 else ""
    return status.startswith(("Complete", "Superseded"))


def base_row_closed(lines, a, b, ident, starts):
    """True when base lines a..b (one residual or blocker row) record the row as closed.

    A one-line row: its last cell begins with a bold closure word. A multi-line
    row: it holds a bold phrase that begins with one. Either way, a queued
    package row also counts as closed when that package's own row is Complete
    or Superseded in the base. A partly closed row whose last cell still begins
    with such a word (e.g. RULED but in flight) passes; that is a review
    question, disclosed in REWRITES.md.
    """
    text = lines[a - 1:b]
    if len(text) == 1:
        row = text[0].rstrip()
        row = row[:-1].rstrip() if row.endswith("|") else row
        if re.match(r"^\*\*" + CLOSURE, row.split(" | ")[-1].strip()):
            return True
    elif re.search(r"\*\*" + CLOSURE, "\n".join(text)):
        return True
    pkg = starts.get(("pkg", ident))
    return pkg is not None and base_status_complete(lines[pkg - 1])


def archive_ranges(root):
    """{archive file name: (a, b)} of each file's region, in the cut's line numbers."""
    out = {}
    adir = os.path.join(root, S.ARCHIVE)
    for name in sorted(os.listdir(adir)):
        if not name.endswith(".md") or name in NOTES:
            continue
        with open(os.path.join(adir, name), encoding="utf-8") as fh:
            m = re.search(r"^<!-- verbatim-begin .*? lines=(\d+)-(\d+) ", fh.read(), flags=re.M)
        if m:
            out[name] = (int(m.group(1)), int(m.group(2)))
    return out


def proof_a(root, sha, base, report):
    base_lines = S.split_lines(base)
    regions, fails = [], []
    adir = os.path.join(root, S.ARCHIVE)
    for name in sorted(os.listdir(adir)):
        if not name.endswith(".md") or name in NOTES:
            continue
        path = os.path.join(adir, name)
        try:
            attrs, region = S.extract_region(path)
        except ValueError as e:
            fails.append(str(e))
            continue
        a, b = int(attrs["a"]), int(attrs["b"])
        if attrs["source"] != S.STATUS:
            fails.append(f"{name}: source is {attrs['source']}")
        if attrs["base"] != sha:
            fails.append(f"{name}: cut at {attrs['base'][:12]}, not at the base {sha[:12]}")
        if S.sha256(region.encode("utf-8")) != attrs["sha"]:
            fails.append(f"{name}: region sha256 differs from its marker")
        if region != "".join(base_lines[a - 1:b]):
            fails.append(f"{name}: region differs from base lines {a}-{b}")
        regions.append((a, b, name, region))
    expected = {s[0] for s in S.SECTIONS}
    found = {r[2] for r in regions}
    if found != expected:
        fails.append(f"archive files differ from SECTIONS: missing {sorted(expected - found)}, extra {sorted(found - expected)}")
    regions.sort()
    nxt = 1
    for a, b, name, _r in regions:
        if a != nxt:
            fails.append(f"{name}: starts at line {a}, expected {nxt} (gap or overlap)")
        nxt = b + 1
    if nxt != len(base_lines) + 1:
        fails.append(f"regions end at line {nxt - 1}; the base has {len(base_lines)} lines")
    joined = "".join(r[3] for r in regions)
    if S.sha256(joined.encode("utf-8")) != S.sha256(base.encode("utf-8")):
        fails.append("the concatenated regions do not reproduce the base file")
    report.append(f"Proof A: {'FAIL' if fails else 'PASS'} ({len(regions)} regions; base {len(base_lines)} lines, "
                  f"{len(base.encode('utf-8'))} B, sha256 {S.sha256(base.encode('utf-8'))[:16]}...)")
    report.extend("  A: " + f for f in fails)
    return not fails, regions


def proof_b(root, base, regions, report):
    """Strict: base lines must be covered by the archive regions plus the brief.

    REWRITES.md "old" text is reported but NOT credited: it quotes lines that are
    also archived, so crediting it would let a deleted archive line hide behind
    its quotation. The packet's exception list is therefore unused.
    """
    need = collections.Counter(l for l in base.split("\n") if l.strip())
    brief = collections.Counter(read(root, S.STATUS).split("\n"))
    arch = collections.Counter()
    for _a, _b, _n, region in regions:
        arch.update(region.split("\n"))
    rw = collections.Counter()
    for blk in parse_rewrites(read(root, f"{S.ARCHIVE}/REWRITES.md"))[1]:
        if blk["kind"] == "old":
            rw.update(blk["lines"])
    total = sum(need.values())
    in_arch = in_brief = quoted = 0
    missing = []
    for line, n in need.items():
        a = min(n, arch[line])
        in_arch += a
        in_brief += min(n, brief[line])
        quoted += min(n, rw[line])
        rest = n - a - min(n - a, brief[line])
        if rest > 0:
            missing.append((rest, line))
    report.append(f"Proof B: {'FAIL' if missing else 'PASS'} ({total} non-blank base lines, {len(need)} distinct; "
                  f"{in_arch} found in the archive regions, {in_brief} also verbatim in the brief, "
                  f"{quoted} also quoted in REWRITES.md (not credited), {sum(k for k, _ in missing)} missing)")
    for k, line in missing[:20]:
        report.append(f"  B: missing x{k}: {line[:120]!r}")
    return not missing


def brief_tables(brief_lines):
    """Ids in the brief's closeout and residual tables, and its package rows [(id, status)]."""
    open_ids, pkgs, h2, h3 = [], [], "", ""
    for line in brief_lines:
        if line.startswith("## "):
            h2, h3 = line, ""
        elif line.startswith("### "):
            h3 = line
        m = re.match(r"^\| `([^`]+)` \|", line)
        if not m:
            continue
        if h2 == "## Open blockers" and (h3.startswith("### Closeout blockers") or h3 == "### Residual queue"):
            open_ids.append(m.group(1))
        elif h2 == "## Work packages":
            cells = [c.strip() for c in line.split(" | ")]
            pkgs.append((m.group(1), cells[2] if len(cells) > 2 else ""))
    return open_ids, pkgs


def closed_text(brief_lines):
    """The brief's two closed lists (closeout blockers and residual rows)."""
    out, on = [], False
    for line in brief_lines:
        if line.startswith("Closed: `") or line.startswith("Closed, done or ruled"):
            on = True
        if on and not line.strip():
            on = False
        if on:
            out.append(line)
    return "\n".join(out)


def proof_c(root, repo, sha, base, report):
    fails = []
    base_lines = base.split("\n")
    brief = read(root, S.STATUS)
    brief_lines = brief.split("\n")
    brief_set = set(brief_lines)

    # C1
    brief_rows = {}
    for line in brief_lines:
        m = re.match(r"^\| `([A-Za-z0-9-]+)` \|", line)
        if m:
            brief_rows.setdefault(m.group(1), []).append(line)
    rows = package_rows(base_lines)
    for pid, text in rows:
        if pid not in brief_rows:
            fails.append(f"C1: package {pid} has no row in the brief")
            continue
        for line in brief_rows[pid]:
            cells = [c.strip() for c in line.split(" | ")]
            merge = cells[3] if len(cells) > 3 else ""
            for h in re.findall(r"`([0-9a-f]{7,40})`", merge):
                if not any(h in t for p, t in rows if p == pid):
                    fails.append(f"C1: {pid}: merge SHA {h} is not in the base row")
    # C2
    ids = blocker_ids(base_lines)
    # Only the brief's Open blockers and Human items sections count: an id that
    # merely appears in a work-package scope cell is not a listed open item.
    scoped, h2 = [], ""
    for line in brief_lines:
        if line.startswith("## "):
            h2 = line
        if h2 in ("## Open blockers", "## Human items"):
            scoped.append(line)
    scoped_text = "\n".join(scoped)
    heads = [l for l in scoped if l.startswith("#")]
    for rid in ids:
        if f"`{rid}`" not in scoped_text and f"**{rid}**" not in scoped_text and not any(rid in h for h in heads):
            fails.append(f"C2: residual/blocker id {rid!r} is not named under Open blockers or Human items")
    # C3
    hexes = sorted(set(re.findall(r"`([0-9a-f]{7,40})`", brief)))
    for h in hexes:
        if h in base:
            continue
        ok = subprocess.run(["git", "-C", repo, "cat-file", "-e", h + "^{object}"], capture_output=True).returncode == 0
        if not ok:
            fails.append(f"C3: {h} is neither in the base file nor a git object")
    # C4
    nlinks = 0
    for rel in LINKED:
        text = strip_fences(read(root, rel))
        slugs = {slug(re.sub(r"^#+ ", "", l)) for l in text.split("\n") if re.match(r"^#{1,6} ", l)}
        for target in re.findall(r"\]\(([^)\s]+)\)", text):
            if re.match(r"^[a-z]+:", target):
                continue
            nlinks += 1
            path, _, anchor = target.partition("#")
            if not path:
                if anchor not in slugs:
                    fails.append(f"C4: {rel}: anchor #{anchor} has no heading")
                continue
            dest = os.path.normpath(os.path.join(root, os.path.dirname(rel), path))
            if not os.path.exists(dest):
                fails.append(f"C4: {rel}: link {target} does not resolve")
    adir = os.path.join(root, S.ARCHIVE)
    narch = 0
    for name in sorted(os.listdir(adir)):
        if not name.endswith(".md") or name in NOTES:
            continue
        rel = f"{S.ARCHIVE}/{name}"
        region, outside = S.split_file(os.path.join(adir, name))
        note_targets = re.findall(r"\]\(([^)\s]+)\)", outside)
        for target in S.region_links(region):
            narch += 1
            path = target.partition("#")[0]
            if not os.path.exists(os.path.normpath(os.path.join(root, path))):
                fails.append(f"C4: {rel}: archived link {target} does not resolve from the repository root")
            fixed = [n for n in note_targets if n.partition("#")[0]
                     and os.path.normpath(os.path.join(adir, n.partition("#")[0])) == os.path.normpath(os.path.join(root, path))]
            if not fixed:
                fails.append(f"C4: {rel}: archived link {target} is broken from {S.ARCHIVE}/ and has no working counterpart in the link note")
        for target in note_targets:
            narch += 1
            path = target.partition("#")[0]
            if path and not os.path.exists(os.path.normpath(os.path.join(adir, path))):
                fails.append(f"C4: {rel}: link-note target {target} does not resolve")
    # C5
    mm = read(root, f"{S.ARCHIVE}/MOVE-MAP.md")
    for h in headings(base_lines):
        if h not in mm:
            fails.append(f"C5: MOVE-MAP.md does not name heading {h[:80]!r}")
    for pid, _t in rows:
        if f"`{pid}`" not in mm:
            fails.append(f"C5: MOVE-MAP.md does not name package {pid}")
    for rid in ids:
        if f"`{rid}`" not in mm:
            fails.append(f"C5: MOVE-MAP.md does not name id {rid!r}")
    for n, line in enumerate(base_lines, 1):
        m = re.search(r"DISCHARGED[^)]*?see `## ([^`]+)`", line) if line.startswith("- ") else None
        if m:
            mrow = [r for r in mm.split("\n") if f" | {n} | [" in r]
            if not mrow or not mrow[0].rstrip(" |").split(" | ")[-1].startswith(m.group(1)):
                fails.append(f"C5: MOVE-MAP.md does not send the DISCHARGED bullet at line {n} to {m.group(1)!r}")

    # REWRITES.md: C6, C8, C9, C10
    try:
        rwbase, blocks, entries = parse_rewrites(read(root, f"{S.ARCHIVE}/REWRITES.md"))
    except ValueError as e:
        fails.append(f"C6: {e}")
        rwbase, blocks, entries = None, [], {}
    cut = sha
    texts = {cut: base_lines}
    if rwbase is None:
        fails.append("C6: REWRITES.md has no '<!-- rewrites-base: <sha> -->' pin")
    else:
        try:
            rwbase = S.resolve(repo, rwbase)
            texts.setdefault(rwbase, S.base_text(repo, rwbase).split("\n"))
        except subprocess.CalledProcessError:
            fails.append(f"C6: rewrites-base {rwbase} is not a commit")
            rwbase = None
    for blk in blocks:
        if blk["base"] is None:
            blk["base"] = rwbase
        elif blk["base"] not in texts:
            fails.append(f"C6: a {blk['kind']} block names base {blk['base'][:12]}, which is neither the rewrites-base nor the cut")
            blk["base"] = None
    # C6
    news_by_entry, olds_by_entry, keeps_by_entry = collections.defaultdict(list), collections.defaultdict(list), collections.defaultdict(list)
    for blk in blocks:
        if blk["kind"] == "old" and blk["base"]:
            if blk["lines"] != texts[blk["base"]][blk["a"] - 1:blk["b"]]:
                fails.append(f"C6: REWRITES old block lines={blk['a']}-{blk['b']} is not verbatim text of {blk['base'][:12]}")
            olds_by_entry[blk["entry"]].append(blk)
        elif blk["kind"] == "new":
            news_by_entry[blk["entry"]].extend(blk["lines"])
            for line in blk["lines"]:
                if line.strip() and line not in brief_set:
                    fails.append(f"C6: REWRITES new line is not in the brief: {line[:100]!r}")
        elif blk["kind"] == "keep":
            keeps_by_entry[blk["entry"]].extend(l for l in blk["lines"] if l.strip())

    # C8
    open_ids, pkgs = brief_tables(brief_lines)
    closed = closed_text(brief_lines)
    pkg_status = collections.defaultdict(list)
    for pid, status in pkgs:
        pkg_status[pid].append(status)

    def coverage(sha, need):
        """Check coverage of the 1-based line numbers `need` of text `sha`; validate its declarations."""
        lines = texts[sha]
        starts = row_starts(lines)
        start_of = {n: key for key, n in starts.items()}
        covered = set()
        for blk in blocks:
            if blk["base"] == sha and blk["kind"] == "old":
                covered.update(range(blk["a"], blk["b"] + 1))
        for blk in blocks:
            if blk["base"] != sha or blk["kind"] != "unpaired":
                continue
            for decl in blk["lines"]:
                if not decl.strip():
                    continue
                m = re.match(r"^(\d+)-(\d+) (verbatim|complete-row|closed-row|history)(?: (.*))?$", decl)
                if not m:
                    fails.append(f"C8: malformed unpaired declaration {decl!r}")
                    continue
                a, b, kind, detail = int(m.group(1)), int(m.group(2)), m.group(3), (m.group(4) or "")
                inside = [start_of[n] for n in range(a, b + 1) if n in start_of]
                if kind == "verbatim":
                    bad = [n for n in range(a, b + 1) if lines[n - 1].strip() and lines[n - 1] not in brief_set]
                    if bad:
                        fails.append(f"C8: unpaired {a}-{b} is declared verbatim, but line {bad[0]} is not in the brief")
                elif kind in ("complete-row", "closed-row"):
                    ident = detail.strip("`")
                    key = ("pkg" if kind == "complete-row" else "row", ident)
                    if starts.get(key) != a or any(k != key for k in inside):
                        fails.append(f"C8: unpaired {a}-{b} is declared {kind} {ident!r}, but it is not exactly that row")
                    elif kind == "complete-row" and not base_status_complete(lines[a - 1]):
                        fails.append(f"C8: unpaired {a}-{b}: package {ident!r} is not Complete or Superseded in the base row")
                    elif kind == "complete-row" and not any(s.startswith(("Complete", "Superseded")) for s in pkg_status.get(ident, [])):
                        fails.append(f"C8: unpaired {a}-{b}: package {ident!r} is not Complete or Superseded in the brief")
                    elif kind == "closed-row" and not base_row_closed(lines, a, b, ident, starts):
                        fails.append(f"C8: unpaired {a}-{b} is declared closed-row {ident!r}, but the base row does not record it closed")
                    elif kind == "closed-row" and f"`{ident}`" not in closed:
                        fails.append(f"C8: unpaired {a}-{b}: {ident!r} is not in the brief's closed lists")
                elif inside:
                    fails.append(f"C8: unpaired {a}-{b} is declared history but holds the row {inside[0][1]!r}")
                covered.update(range(a, b + 1))
        missing = sorted(n for n in need if n not in covered)
        if missing:
            runs, s = [], missing[0]
            for x, y in zip(missing, missing[1:] + [None]):
                if y != x + 1:
                    runs.append(f"{s}-{x}")
                    s = y
            fails.append(f"C8: {len(missing)} line(s) of {sha[:12]} are neither paired nor declared unpaired: {', '.join(runs[:8])}")
        return covered, starts

    npaired = 0
    if rwbase:
        rw_lines = texts[rwbase]
        rw_cov, rw_starts = coverage(rwbase, [n for n, l in enumerate(rw_lines, 1) if l.strip()])
        rw_old = set()
        for blk in blocks:
            if blk["base"] == rwbase and blk["kind"] == "old":
                rw_old.update(range(blk["a"], blk["b"] + 1))
        cut_old = set()
        for blk in blocks:
            if blk["base"] == cut and blk["kind"] == "old":
                cut_old.update(range(blk["a"], blk["b"] + 1))
        # map unchanged cut lines back to the rewrites-base
        to_rw, changed = {}, []
        if cut == rwbase:
            to_rw = {n: n for n in range(1, len(rw_lines) + 1)}
        else:
            sm = difflib.SequenceMatcher(None, rw_lines, base_lines, autojunk=False)
            for tag, i1, i2, j1, j2 in sm.get_opcodes():
                if tag == "equal":
                    for k in range(j2 - j1):
                        to_rw[j1 + k + 1] = i1 + k + 1
                elif tag in ("replace", "insert"):
                    changed.extend(n for n in range(j1 + 1, j2 + 1) if base_lines[n - 1].strip())
            coverage(cut, changed)
        cut_starts = row_starts(base_lines)
        live = [("row", i) for i in open_ids]
        live += [("pkg", p) for p, s in pkgs if not s.startswith(("Complete", "Superseded"))]
        paired_rw_starts = set()
        for key in live:
            n = cut_starts.get(key)
            if n is None:
                fails.append(f"C8: the brief lists {key[1]!r}, which has no row in the base")
                continue
            if n in to_rw and cut != rwbase:
                ok = to_rw[n] in rw_old
                paired_rw_starts.add(to_rw[n])
            elif cut == rwbase:
                ok = n in rw_old
                paired_rw_starts.add(n)
            else:
                ok = n in cut_old
            npaired += ok
            if not ok:
                fails.append(f"C8: the brief lists {key[1]!r} as open or live, but REWRITES.md pairs no old block with its row")
        # C11: an archive file a Facts account names must hold one of the entry's old lines
        to_cut = {v: k for k, v in to_rw.items()}
        ranges = archive_ranges(root)
        for entry, flines in entries.items():
            cited = set(re.findall(r"([a-z0-9-]+\.md)\b", " ".join(flines))) & set(ranges)
            if not cited:
                continue
            at_cut = set()
            for blk in olds_by_entry.get(entry, []):
                for n in range(blk["a"], blk["b"] + 1):
                    if blk["base"] == cut:
                        at_cut.add(n)
                    elif blk["base"] == rwbase and n in to_cut:
                        at_cut.add(to_cut[n])
            if not at_cut:
                continue
            for name in sorted(cited):
                lo, hi = ranges[name]
                if not any(lo <= n <= hi for n in at_cut):
                    holders = sorted(f for f, (x, y) in ranges.items() if any(x <= n <= y for n in at_cut))
                    fails.append(f"C11: {entry}'s Facts names {name}, which holds none of its old lines (they are in {', '.join(holders)})")
        # C10: an entry that pairs an open row needs keep phrases
        for entry, olds in olds_by_entry.items():
            pairs_open = any(b["base"] == rwbase and any(b["a"] <= n <= b["b"] for n in paired_rw_starts) for b in olds)
            if pairs_open and not keeps_by_entry.get(entry):
                fails.append(f"C10: {entry} pairs an open or live row but has no keep phrase")
    # C9
    seen = collections.defaultdict(list)
    for entry, flines in entries.items():
        account = norm(" ".join(flines).replace("**Facts.**", ""))
        if not account:
            fails.append(f"C9: {entry} has no Facts account")
        seen[account].append(entry)
    for account, who in seen.items():
        if account and len(who) > 1:
            fails.append(f"C9: {len(who)} entries share one Facts account ({', '.join(who[:6])}): {account[:80]!r}")
    # C10
    nkeep = 0
    brief_n = norm(brief)
    for entry, phrases in keeps_by_entry.items():
        old_n = norm(" ".join(l for b in olds_by_entry.get(entry, []) for l in b["lines"]))
        new_n = norm(" ".join(news_by_entry.get(entry, [])))
        for ph in phrases:
            nkeep += 1
            p = norm(ph)
            if p not in old_n:
                fails.append(f"C10: {entry}: keep phrase is not in its old text: {ph[:90]!r}")
            if p not in new_n or p not in brief_n:
                fails.append(f"C10: {entry}: keep phrase is not in its new text in the brief: {ph[:90]!r}")

    # C7
    index = read(root, "docs/handoffs/INDEX.md")
    listed = set(re.findall(r"^\| [^|]* \| \[([^\]]+\.md)\]\(", index, flags=re.M))
    present = {f for f in os.listdir(os.path.join(root, "docs/handoffs"))
               if f.endswith(".md") and f not in ("INDEX.md", "README.md") and not f.startswith("_")}
    for f in sorted(present - listed):
        fails.append(f"C7: docs/handoffs/INDEX.md has no line for {f}")
    for f in sorted(listed - present):
        fails.append(f"C7: docs/handoffs/INDEX.md lists {f}, which does not exist")
    nold = sum(1 for b in blocks if b["kind"] == "old")
    report.append(f"Proof C: {'FAIL' if fails else 'PASS'} ({len(rows)} package rows, {len(ids)} blocker/residual ids, "
                  f"{len(hexes)} hex tokens, {nlinks} links + {narch} archive links, {len(present)} handoffs indexed, "
                  f"{len(entries)} REWRITES entries with {nold} old blocks, {npaired} open or live rows paired, "
                  f"{nkeep} keep phrases; rewrites-base {(rwbase or 'none')[:12]}, cut {cut[:12]})")
    report.extend("  " + f for f in fails[:MAX_REPORT[0]])
    if len(fails) > MAX_REPORT[0]:
        report.append(f"  ... and {len(fails) - MAX_REPORT[0]} more")
    return not fails


MAX_REPORT = [40]



def main() -> int:
    ap = argparse.ArgumentParser(description="LOGS-1 preservation proof")
    ap.add_argument("--base", required=True)
    ap.add_argument("--repo", default=".")
    ap.add_argument("--root", default=None, help="the tree holding the brief and the archive (default: --repo)")
    ap.add_argument("--only", default="A,B,C")
    ap.add_argument("--max-report", type=int, default=40, help="Proof C failures to print (default 40)")
    args = ap.parse_args()
    MAX_REPORT[0] = args.max_report
    root = args.root or args.repo
    sha = S.resolve(args.repo, args.base)
    base = S.base_text(args.repo, sha)
    only = set(args.only.split(","))
    report = [f"base {sha} ({S.STATUS}); brief {len(read(root, S.STATUS).encode('utf-8'))} B"]
    ok = True
    mark = len(report)
    a_ok, regions = proof_a(root, sha, base, report)
    if "A" in only:
        ok &= a_ok
    else:
        del report[mark:]  # B still needs the regions; A is not reported
    if "B" in only:
        ok &= proof_b(root, base, regions, report)
    if "C" in only:
        ok &= proof_c(root, args.repo, sha, base, report)
    print("\n".join(report))
    print("RESULT: " + ("PASS" if ok else "FAIL"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
