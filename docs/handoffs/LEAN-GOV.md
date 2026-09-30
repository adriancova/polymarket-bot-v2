# LEAN-GOV — ADR-025..030 and work-plan rows for the LEAN-1 rulings

**Status:** Complete (2026-09-30). Merged `78ba39b`, PR #34, CI run `36783483530`.
**Reviewers:** Opus and gpt-6-astra, reconciled. Joint ACCEPT at `15d2640`, after 6 rounds (one round's verifiers were interrupted by a usage limit and resumed). Loop `wf_1c5b65fd-def`.
**Delivered:**
- ADR-025 (the laptop PAPER host profile), ADR-026 (evaluation cadence), ADR-027 (checkpoint-on-change), ADR-028 (raw retention with pins), ADR-029 (the approximate dataset class) and ADR-030 (series auto-admission): all Accepted, from the user's rulings.
- An amendment line in ADR-024.
- Six index rows in the ADR README.
- 11 work-plan entries.

**Note:** ADR-028 treats the pin budget as an alarm only. Cutting a kept window to slices needs a new user ruling ("evidence is never deleted to meet a budget").

## Round outcomes
| Round | Candidate | Joint verdict | Agreed findings |
|---|---|---|---|
| 1 | `5e73dfb` | CHANGES REQUIRED | HIGH B-1, MEDIUM B-3, MEDIUM A-1, MEDIUM D-1, MEDIUM D-2, LOW B-2, LOW L-1, LOW L-2, LOW L-3, LOW L-5, LOW L-6, LOW L-7, LOW L-8, LOW L-11, INFO G-1, INFO L-10, INFO I-1, INFO I-2 |
| 2 | `66f2756` | CHANGES REQUIRED | MEDIUM R2-A1, MEDIUM R2-B1, MEDIUM A-2, MEDIUM D-3, MEDIUM D-4, LOW A-3, LOW B-4, LOW L-12, LOW L-13, LOW E-1, INFO G-2 |
| 3 | `b95f5ee` | CHANGES REQUIRED | MEDIUM M-1, LOW B-5, LOW L-14, INFO G-3, INFO I-1, INFO E-2 |
| 4 | `06bdc57` | CHANGES REQUIRED | HIGH R4-A1, MEDIUM R4-D1, LOW L-15/R4-E1, INFO G-4, INFO I-1, INFO L-10, INFO E-3 |
| 5 | `8d8f900` | CHANGES REQUIRED | MEDIUM AX-A1, LOW OP-A1, LOW R5-D1, INFO R5-I2, INFO E-4, INFO G-5, INFO I-1, INFO L-10 |
| 6 | `15d2640` | ACCEPT | INFO G-6, INFO R5-I2, INFO I-1, INFO L-10, INFO H-1, INFO R6-E1 |

## Final implementer handoff (verbatim)

### summary

LEAN-GOV round 5 fixes the MEDIUM, both LOWs and the cosmetic INFO from reconcile-r5/joint.md. This round changes docs only, in commit 15d2640 on top of 8d8f900.
- AX-A1 (MEDIUM): ADR-028 Decision 2.1 now takes a segment's 72 h age from the newest receivedAt over all of its verified frames, not from its last frame. The reason is that stamps may repeat or step backwards (ADR-026 Context 5). The rule includes the example of frames 71 h then 73 h old; that segment is kept. STORAGE-1 gets a matching acceptance line with a test for that case.
- OP-A1 (LOW): ADR-028 D3.1 now says "a refusal", matching D3.5 and the ruling.
- R5-D1 (LOW): the LEAN-1 header comment in the work plan now names every pair of rounds that share a path and that no depends_on orders. I computed the pairs from the YAML. There are four: CADENCE-1/ROLLOVER-1 and ROLLOVER-1/CKPT-1 (trading-core, trader and paper-trader tests), ROLLOVER-1/REFDIET (data-gateway src and tests), and CADENCE-1/APPROX-REPLAY-1 (apps/backtest-cli).
- E-4 (INFO): ADR-025:6 is now wrapped, and ADR-026 rule 4 is reflowed so no line is over 80 characters.

The remaining findings are left to the orchestrator or carried as before. R5-I2 needs IMPLEMENTATION_STATUS.md, which is outside this package's paths. G-5 is recorded under tests. I-1 and L-10 are carried and disclosed.

The finding table is in the handoff at /tmp/claude-1000/-home-adriancova-proyects-tradeBot-polymarket-bot/083749fa-1d4c-4735-b241-48f81129d71c/scratchpad/lean-gov/handoff-r5.md. It is mirrored to ~/pmb-rounds/lean-gov/.

### files_changed

[
 "/home/adriancova/proyects/tradeBot/polymarket-bot-lean-gov/docs/adr/ADR-025-laptop-paper-host-profile.md",
 "/home/adriancova/proyects/tradeBot/polymarket-bot-lean-gov/docs/adr/ADR-026-evaluation-cadence.md",
 "/home/adriancova/proyects/tradeBot/polymarket-bot-lean-gov/docs/adr/ADR-028-raw-retention-with-pins.md",
 "/home/adriancova/proyects/tradeBot/polymarket-bot-lean-gov/docs/spec/polymarket-bot-workplan.yaml"
]

### tests_run

- `pnpm run lint`: exit 0.
- `pnpm run check:deps`: exit 0, PASS.
- `pnpm run test`: three runs.
  - Run 1, at load 19-25 with other agents' vitest running: exit 1. 4 of 7817 tests failed, in 3 of 368 files. All were 5000 ms timeouts, in the same three files flagged since round 1.
  - The same three files run alone: 48/48 pass.
  - Run 2, at load 31-35: exit 1. 2 of 7817 tests failed with the same timeouts.
  - Run 3, started at load 7.3: exit 0. 368/368 files and 7817/7817 tests passed.
- YAML: PyYAML parses 50 entries with 50 unique ids. The node yaml 2.9.0 package parses the file with uniqueKeys and strict. No repository test parses the work plan.
- Pins (scratch script pins-r5.py, 5 checks): 0/5 with the 4 changed files restored from 8d8f900, exit 1. After a byte-identical restore (checked with sha256sum -c), 5/5, exit 0. The earlier pin scripts still pass on this tree: r1 18/18, r2 16/16, r3 6/6, r4 5/5.

### assumptions

- The assumptions from rounds 0 to 4 still stand.
- "Verified frames" means the frames that validateSegment accepts (Decision 2.6). A segment that fails validation is never extracted, so it never expires.
- For R5-D1, two paths overlap when one glob's prefix contains the other. Pairs already ordered by a depends_on chain, directly or transitively, are not listed.

### deviations

- As in earlier rounds, the pins are a scratch script, not a repository test, because this package may edit only docs.
- E-4 was INFO, but I fixed it anyway because it was cheap and inside the allowed paths.

### known_risks

- G-5: the test gate hits 5000 ms timeouts on this machine when other agents load it. Two runs this round were red from those timeouts only; the run at lower load was green.
- The known risks from rounds 2 to 4 still stand. That includes STORAGE-1 waiting for THROUGHPUT-1c.

### follow_up

- R5-I2: the orchestrator should update IMPLEMENTATION_STATUS.md (:45 and :158) to say STORAGE-1 also waits for THROUGHPUT-1c.
- The four path-sharing pairs listed in the work-plan comment must run one at a time.
- Optional (I-1): add an "amended by ADR-026" note to the ADR-024 row in the ADR README, in a governance commit.
- The follow-ups from earlier rounds still stand.

### commit_sha

15d26403c5992859582f08e46b85271e1a8c2ce7
