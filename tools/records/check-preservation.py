#!/usr/bin/env python3
"""Prove that nothing in the base IMPLEMENTATION_STATUS.md was lost (LOGS-1).

Usage:
  python3 tools/records/check-preservation.py --base <rev> [--repo .] [--root .] [--only A,B,C]

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
  C4 every relative link in the brief, the archive notes and the handoff INDEX
     and README resolves (same-file anchors included);
  C5 MOVE-MAP.md names every base heading, package row id and blocker/residual id;
  C6 every REWRITES.md "old" block equals the base lines it cites, and every
     "new" line occurs in the brief;
  C7 docs/handoffs/INDEX.md has exactly one line per handoff file (untracked
     files named "_*" are skipped).

Exit 0 when every selected proof passes, 1 otherwise. Stdlib only, no network.
"""

import argparse
import collections
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


def rewrites_blocks(text):
    """[(kind, a, b, [lines])] for ~~~old lines=a-b and ~~~new blocks."""
    blocks, cur = [], None
    for line in text.split("\n"):
        if cur is None:
            m = re.match(r"^~~~old lines=(\d+)-(\d+)$", line)
            if m:
                cur = ["old", int(m.group(1)), int(m.group(2)), []]
            elif line == "~~~new":
                cur = ["new", 0, 0, []]
        elif line == "~~~":
            blocks.append(tuple(cur))
            cur = None
        else:
            cur[3].append(line)
    if cur is not None:
        raise ValueError("REWRITES.md: unterminated block")
    return blocks


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
    for kind, _a, _b, blines in rewrites_blocks(read(root, f"{S.ARCHIVE}/REWRITES.md")):
        if kind == "old":
            rw.update(blines)
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


def proof_c(root, repo, base, report):
    fails = []
    base_lines = base.split("\n")
    brief = read(root, S.STATUS)
    brief_lines = brief.split("\n")

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
    # C6
    blocks = rewrites_blocks(read(root, f"{S.ARCHIVE}/REWRITES.md"))
    brief_set = set(brief_lines)
    for kind, a, b, blines in blocks:
        if kind == "old":
            if blines != base_lines[a - 1:b]:
                fails.append(f"C6: REWRITES old block lines={a}-{b} is not verbatim base text")
        else:
            for line in blines:
                if line.strip() and line not in brief_set:
                    fails.append(f"C6: REWRITES new line is not in the brief: {line[:100]!r}")
    # C7
    index = read(root, "docs/handoffs/INDEX.md")
    listed = set(re.findall(r"^\| [^|]* \| \[([^\]]+\.md)\]\(", index, flags=re.M))
    present = {f for f in os.listdir(os.path.join(root, "docs/handoffs"))
               if f.endswith(".md") and f not in ("INDEX.md", "README.md") and not f.startswith("_")}
    for f in sorted(present - listed):
        fails.append(f"C7: docs/handoffs/INDEX.md has no line for {f}")
    for f in sorted(listed - present):
        fails.append(f"C7: docs/handoffs/INDEX.md lists {f}, which does not exist")
    report.append(f"Proof C: {'FAIL' if fails else 'PASS'} ({len(rows)} package rows, {len(ids)} blocker/residual ids, "
                  f"{len(hexes)} hex tokens, {nlinks} links, {len(present)} handoffs indexed, {sum(1 for k in blocks if k[0] == 'old')} REWRITES old blocks)")
    report.extend("  " + f for f in fails[:40])
    if len(fails) > 40:
        report.append(f"  ... and {len(fails) - 40} more")
    return not fails


def main() -> int:
    ap = argparse.ArgumentParser(description="LOGS-1 preservation proof")
    ap.add_argument("--base", required=True)
    ap.add_argument("--repo", default=".")
    ap.add_argument("--root", default=None, help="the tree holding the brief and the archive (default: --repo)")
    ap.add_argument("--only", default="A,B,C")
    args = ap.parse_args()
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
        ok &= proof_c(root, args.repo, base, report)
    print("\n".join(report))
    print("RESULT: " + ("PASS" if ok else "FAIL"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
