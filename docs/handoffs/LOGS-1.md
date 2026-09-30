# LOGS-1 — `IMPLEMENTATION_STATUS.md` becomes a brief; history archived verbatim

**Status:** Complete (2026-09-30). Merged `7ac7985`, PR #28, CI run `36715658683`.
**Requested by the user:** "an audit on this files and your recommendation and implementation of said recommendation". Design: the orchestrator's recommendation.
**Reviewers:** Opus and Codex gpt-6-astra, independently, reconciling divided items (the user's request). Joint ACCEPT in round 9 at `99391d3`. The merge-time re-cut onto `8fde4df` got a joint ACCEPT at `51feb09`.
**Loops:** `wf_88bf67c2-719` (audit and rounds 1-9), `wf_3bb4c23c-259` (re-cut). The audit report: `~/pmb-rounds/logs-1/audit.md`.

## Result
- The brief went from 699 KB to 84 KB (12%). The old file's every line sits in `docs/status-archive/` in 11 hash-marked regions, with `MOVE-MAP.md` and `REWRITES.md`.
- The proofs are in `tools/records/`: A (byte-exact regions), B (line multiset), C (ids, links, dispositions), and a mutation self-test. They are not wired into CI; they are run at each re-cut.
- `docs/handoffs/INDEX.md` has one line per handoff. `docs/handoffs/README.md` is the writing standard.
- `AGENTS.md` and `CLAUDE.md` each gained one sentence.

## Round outcomes
| Round | Candidate | Joint verdict | Agreed findings (severity) |
|---|---|---|---|
| 1 | `2a7cca6` | CHANGES REQUIRED | HIGH, HIGH, MEDIUM, MEDIUM, MEDIUM, LOW, LOW, LOW, LOW, LOW, LOW, LOW, INFO |
| 2 | `f4fa27c` | CHANGES REQUIRED | HIGH, MEDIUM, LOW, LOW, LOW, LOW, LOW |
| 3 | `3b722da` | CHANGES REQUIRED | HIGH, LOW, LOW, LOW, LOW, LOW, INFO, INFO |
| 4 | `a897675` | CHANGES REQUIRED | HIGH, HIGH, LOW, LOW, LOW, INFO |
| 5 | `ed9e595` | CHANGES REQUIRED | MEDIUM, MEDIUM, MEDIUM, LOW, LOW, LOW, LOW, LOW |
| 6 | `5b1ee34` | CHANGES REQUIRED | MEDIUM, MEDIUM, MEDIUM, MEDIUM, LOW, LOW, INFO |
| 7 | `5218954` | CHANGES REQUIRED | MEDIUM, LOW, LOW, LOW, LOW, INFO, INFO |
| 8 | `3873ecb` | CHANGES REQUIRED | MEDIUM, MEDIUM, LOW, LOW, LOW, INFO, INFO |
| 9 | `99391d3` | ACCEPT | LOW, LOW, INFO, INFO |
| re-cut 1 | `b3140d7` | CHANGES REQUIRED | HIGH, LOW, LOW, LOW, LOW, LOW |
| re-cut 2 | `51feb09` | ACCEPT | LOW, INFO |

The findings shrank each round, and none was HIGH after round 4. The full reports are in `~/pmb-rounds/logs-1/`.

## Final implementer handoff (verbatim)

### summary

I fixed all five findings in round 8 and argued none. The work is one commit on top of 3873ecb: `99391d349ea4c3bc8886a53408f9e8ea17335595`, on branch logs-1, not pushed. Each fix has a pin that fails on 3873ecb's data and passes on the new commit. The files were restored afterwards; they are byte-identical.

| Finding | Severity | Fix | Pin |
| --- | --- | --- | --- |
| CX-R8-01 | MEDIUM | The N3 row now says the composed entries (`buildExecutionPlan`, `sealExecutionPlan`) are total (`WP-190` R1-L1). RW-75 and RW-106 are synced, and RW-106 gains a drop line. | New K36 rule |
| CX-R8-02 | MEDIUM | The WP-250 bullet now names the replay panel's owner: a future `packages/simulation` or `apps/backtest-cli` grant. It also says why WP-250 could not add the producer. RW-110 and RW-111 are synced. | K36 |
| CX-R8-03 | LOW | The WP-180-FU3 bullet is rewritten as full sentences. RW-112's keep phrase is split into two base-text phrases. | K30, extended |
| R8-01 | LOW | GATE1-R3 moves to the closed list: `CI-1` discharged H2 before the cut (`docs/handoffs/CI-1.md:101-106`). RW-74 becomes a closed entry. RW-126 and the GATE-1 declaration are updated, the archive README now counts 17 closures, and the move map is regenerated. | New K31 rule; K35 through the README |
| R8-02 | LOW | TRDR4-CITES now reads "two levels deeper, to a fixed depth". | K30, extended |
| R8-03 | INFO | No change. The brief cites no line numbers in prose. | — |
| R8-04 | INFO | Recorded as a merge obligation. | — |

K36 (`CARRIED_FACTS`) is new: a named brief line must hold the listed words, and the source text must still exist at the cut. Like K31, it is a fixed list, not a detector.

Sizes:
- Base `f43efe6`: 694,497 B / 2,940 lines.
- r7: 83,103 B / 395 lines.
- r8: 83,191 B / 394 lines, which is 12.0% / 13.4% of the base. The budget is 104,174 B / 441 lines.

The handoff is at `/tmp/claude-1000/-home-adriancova-proyects-tradeBot-polymarket-bot/083749fa-1d4c-4735-b241-48f81129d71c/scratchpad/logs-1/handoff-r8.md`, mirrored to `~/pmb-rounds/logs-1/handoff-r8.md`.

### files_changed

[
 "/home/adriancova/proyects/tradeBot/polymarket-bot-logs-1/IMPLEMENTATION_STATUS.md",
 "/home/adriancova/proyects/tradeBot/polymarket-bot-logs-1/docs/status-archive/MOVE-MAP.md",
 "/home/adriancova/proyects/tradeBot/polymarket-bot-logs-1/docs/status-archive/README.md",
 "/home/adriancova/proyects/tradeBot/polymarket-bot-logs-1/docs/status-archive/REWRITES.md",
 "/home/adriancova/proyects/tradeBot/polymarket-bot-logs-1/tools/records/check-brief.py",
 "/home/adriancova/proyects/tradeBot/polymarket-bot-logs-1/tools/records/selftest-preservation.py"
]

### tests_run

Logs are in `…/scratchpad/logs-1/r8/`, mirrored to `~/pmb-rounds/logs-1/r8/`.

**Preservation check** (`check-preservation.py --base f43efe6`): exit 0.
- Proof A passed: 11 regions, 2,940 lines, 694,497 B.
- Proof B passed: 2,704 non-blank lines, 0 missing.
- Proof C passed: 142 entries, 101 old blocks, 66 open or live rows paired, 492 keep phrases, 146 dispositions (80 record items), 332 residual clauses, 121 carried-clause tokens, 145 drop lines.

**Brief check** (`check-brief.py --base f43efe6`): exit 0. The brief is 12.0% / 13.4% of the base, with 4 closeout rows and 57 residual rows.

**Self-test** (`selftest-preservation.py`): passed, 112 ok and 0 unexpected (r7 had 107). This includes both synthetic re-cuts.

**Pins against 3873ecb** (`r8/pins.sh`, output in `r8/pins.log`):
- Brief restored: check-preservation exits 1 (C6 ×5, C10, C5). check-brief exits 1 (K31, K30 ×2, K36 ×2).
- REWRITES.md restored: check-preservation exits 1 (C6 ×6, C5, C10 ×3).
- MOVE-MAP.md restored: check-preservation exits 1 (C5).
- Archive README restored: check-brief exits 1 (K35).
- All four restored: check-brief exits 1 (K31, K30 ×2, K35, K36 ×2). check-preservation exits 0, because 3873ecb's files are consistent with each other.
- Control run on the r8 files: both exit 0. The restore was byte-identical.

**Gates** (with `pnpm_config_verify_deps_before_run=false`, run before the commit with no later edits):
- `pnpm run lint`: exit 0.
- `pnpm run check:deps`: exit 0 (PASS; 35 packages, 90 declared workspace edges).
- `pnpm run test`: exit 0; 366/366 files and 7,786/7,786 tests.

### assumptions

- **GATE1-R3 is fully closed.** The row's only open point was the first real CI run's fresh install. `CI-1`'s PR #1 run `36282501033` was that run: all three jobs passed, and the handoff says "(`H2` DISCHARGED)". CI installs from the lockfile, which pins `js-yaml@4.3.2` at the cut. I did not open the GitHub run log; I relied on `CI-1.md` and the base status file.
- **The F2 owner wording** comes from `PENDING_PRODUCER_PANELS` at the cut, in `dashboards.ts:162-164`.
- **"The `lots.ts:151` sort sentence is owed"** restates the handoff's owner line, "next risk round (one doc sentence)".

### deviations

- **CX-R8-01 wording:** I wrote "The composed entries (`buildExecutionPlan`, `sealExecutionPlan`) are total (`WP-190` R1-L1)" instead of the suggested "remain total". It is closer to the base text and names its source; the fact is the same.
- **CX-R8-02 wording:** I kept the base's keep phrases and took the reason from the code's owner string. The fact is the same as the suggested sentence.
- **New rule:** K36 is a new fixed-list rule in `check-brief.py`, because no existing rule could pin a dropped qualifier.

### known_risks

- **K31 and K36 are fixed lists.** A fact dropped from some other row still passes the tools, and C15 checks only that a clause has a marker. Review has to find the rest. This round's two MEDIUM findings are that kind of loss.
- **K33 checks only the `:NNN` citation form.** Prose "line N" citations are not checked (R8-03).
- **At merge, K31, K33 and K36 read their evidence at the new cut** (the `--base` commit). If records or code have moved, those rules fail until they are re-pinned.
- **Known flake:** timeouts in canonical-order.test.ts or boundary-surface.test.ts are possible under high machine load. None happened this round.

### follow_up

- **Merge obligation (R8-04):**
  - Re-cut against `main` at `8fde4df` or later, using steps 1-6 in `docs/status-archive/README.md`.
  - Then re-check the K33, K31 and K36 evidence at the new cut.
  - Re-apply THROUGHPUT-2 (`7d59fd3`) and ADR-024 from `main`.
- **Optional:** extend K33 to cover prose "line N" citations.
- **Stale citations in historical files, not edited as the packet requires:**
  - `docs/handoffs/RISK-2.md:123`.
  - `docs/handoffs/BOOT-1.md:69`.
  - The archived residual rows in `open-blockers-2026-09.md`, including the GATE1-R3 row, which still reads as open. RW-74 records its closure.

### commit_sha

99391d349ea4c3bc8886a53408f9e8ea17335595

## Re-cut handoff (verbatim)

### summary

LOGS-1-RECUT r1: all six findings in the joint report are fixed in one commit, 51feb09, on top of b3140d7 (branch logs-1, not pushed).

- CX-RECUT-01 (HIGH): the LOGS-1 gate names its reviewer again: "a Fable review of the preservation, and a green CI run on GitHub". RW-145's new block matches, it gains the keep phrase "Fable review", and its Facts quote the base gate "Fable review (preservation) + green CI".
- CX-RECUT-02: RW-01's Facts now say the re-cut is for "LOGS-1's pending merge".
- L1: the H1R1-FRAME-ATOMICITY closed-list entry now states that ADR-024 is accepted provisionally, pending the user's ratification. It also states the D2 exception: a stream prefix truncated inside a frame is evaluated once, half-applied, and the trader then halts. RW-19's Facts record both.
- L2: TRDR4-CITES is re-pinned to 8fde4df. RW-34's Facts note that health-door.ts is unchanged there.
- L3: three sentences reworded. The Next line reads "THROUGHPUT-2 is Complete (7d59fd3), but it missed its throughput targets". The Wave 3 bullet now says the open condition is that the fresh closeout audit "must grade Wave 2 CLOSED". V3-E15's imperative is restored: "Check whether any current code calls v1."
- L4: the THROUGHPUT-2 bullet points to TP2-R2-L1 and TP2-R2-L2, and RW-143's Facts say so.

Pins, all in check-brief.py:
- Five new K36 entries.
- A new rule K37 with two halves. The first is generic: a section whose intro says "as of <sha>" may not pin a file:line citation to another commit unless the line says the file is unchanged. The second, RECUT_REFUSED, is a fixed list of six wordings the review refused.
- Four new selftest mutations, and a K37 bullet in the archive README.

Finding-to-pin table:
| Finding | Status | Pin |
| --- | --- | --- |
| CX-RECUT-01 | fixed | K36 "LOGS-1's gate names its reviewer, Fable"; two K37 RECUT_REFUSED entries (the brief and RW-145's Facts); selftest mutation |
| CX-RECUT-02 | fixed | K37 RECUT_REFUSED "when LOGS-1 merged"; selftest mutation |
| L1 | fixed | K36 "H1R1-FRAME-ATOMICITY's closure carries ADR-024's qualifiers" |
| L2 | fixed | the generic K37 section-pin check; selftest mutation |
| L3 | fixed | two K36 entries (Wave 3 CLOSED grade, V3-E15 imperative); three K37 RECUT_REFUSED entries |
| L4 | fixed | K36 "the THROUGHPUT-2 bullet points to the review's two LOWs"; selftest mutation |

Handoff: /tmp/claude-1000/-home-adriancova-proyects-tradeBot-polymarket-bot/083749fa-1d4c-4735-b241-48f81129d71c/scratchpad/logs-1-recut/handoff-r1.md, mirrored to /home/adriancova/pmb-rounds/logs-1-recut/handoff-r1.md.

### deviations

- The packet names the candidate's branch logs-1-recut, but this worktree has no such branch. b3140d7 is the tip of logs-1, so I committed 51feb09 on logs-1, directly on top of b3140d7, with no amend and no rebase.
- The pins live in the committed tools/records checks (check-brief.py: K36 entries plus the new K37; selftest-preservation.py mutations), not in a vitest file. That is this package's existing pin mechanism.

### known_risks

- K37's RECUT_REFUSED is a fixed list, not a detector, like K31 and K36.
- K37's section-pin check only looks at lines that cite a file line in a section whose intro says "as of <sha>". The Human items runbook cites ("`:509` at `f43efe6`") pass because that section names no "as of" commit.
- The new K36 rules read their source text from IMPLEMENTATION_STATUS.md, ADR-024 and THROUGHPUT-2.md at the cut. If a later re-cut's base rewrites those phrases, the rules fail loudly, which is by design.

### commit_sha

51feb09f25bb8a79be5e0c7acf84b2d86afcb6f0
