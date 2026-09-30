# Status archive: rewrites

<!-- rewrites-base: f43efe61d6501b0e49adc08b037f00b72937d294 -->

Every live sentence of `IMPLEMENTATION_STATUS.md` at `f43efe6` that the brief restates, as old -> new pairs. The old text is also archived verbatim, so preservation does not depend on this file; it lets a reviewer check each rewrite.

Each entry has:

- `old` blocks: base lines, verbatim. Line numbers refer to the pinned `rewrites-base` above, so they stay valid after the archive is re-cut. A block quoting a later cut names it (`~~~old base=<sha> lines=a-b`).
- a `new` block: the brief's lines.
- a `keep` block (for every open or live row): phrases that must occur in both the old and the new text.
- a **Facts** account: what the new text keeps, and what it does not carry and where that lives. "Row" means the archived row; "archive only" means the fact is only in the archive.

What the checks prove, and what they do not: `tools/records/check-preservation.py` checks that each old block is verbatim, each new line is in the brief, each keep phrase is in both texts (C6, C10), every base line is paired or declared below (C8), and no two entries share a Facts account (C9). Whether a rewrite kept every fact is a review question; the checks do not decide it.

## Coverage: lines no entry pairs

Every non-blank base line is either in an entry's old block or declared here. Kinds: `verbatim` (the line is in the brief unchanged), `complete-row` (a Complete or Superseded package row; its one-line brief row is derived as the table-header entry says), `closed-row` (a closed, done or ruled residual or blocker row, named in the brief's closed lists), and `history` (no live content; the range holds no package or blocker row). C8 checks each kind.

~~~unpaired
1-1 verbatim
4-4 verbatim
8-16 verbatim
18-18 verbatim
22-22 complete-row `WP-000`
23-23 complete-row `WP-010`
24-24 complete-row `WP-020`
25-25 complete-row `WP-030`
26-26 complete-row `WP-015`
27-27 complete-row `WP-040`
28-28 complete-row `WP-050`
29-29 complete-row `WP-060`
30-30 complete-row `WP-090`
31-31 complete-row `WP-070`
32-32 complete-row `WP-080`
33-33 complete-row `WP-100`
34-34 complete-row `WP-110`
35-35 complete-row `GOV-1B`
36-36 complete-row `WP-130`
37-37 complete-row `WP-080-FU1`
38-38 complete-row `WP-120`
40-40 complete-row `GOV-1C`
41-41 complete-row `WP-150`
42-42 complete-row `WP-170`
43-43 complete-row `WP-180`
44-44 complete-row `WP-200`
45-45 complete-row `WP-210`
46-46 complete-row `WP-180-FU2`
47-47 complete-row `WP-220`
48-48 complete-row `WP-200-FU1`
49-49 complete-row `GOV-2A`
50-50 complete-row `GOV-1D`
51-51 complete-row `WP-160`
52-53 complete-row `WP-190`
54-54 complete-row `WP-020-FU1`
55-55 complete-row `WP-230`
56-56 complete-row `WP-170-FU1`
57-57 complete-row `WP-240`
58-58 complete-row `WP-250`
59-59 complete-row `WP-180-FU3`
60-60 complete-row `WP-160-FU1`
61-61 complete-row `REC-1`
62-62 complete-row `ALLOC-1`
63-63 complete-row `TRDR-1`
64-64 complete-row `UNIV-1`
65-65 complete-row `SETL-1`
66-66 complete-row `CLOB-1`
67-67 complete-row `UNIV-2`
68-68 complete-row `SETL-2`
69-69 complete-row `UNIV-3`
70-70 complete-row `WP-060-FU1`
71-71 complete-row `WP-200-FU2`
72-72 complete-row `SER-1`
73-73 complete-row `SER-2`
74-74 complete-row `SER-3`
75-75 complete-row `GOV-2B`
76-76 complete-row `TRDR-2`
77-77 complete-row `RISK-2`
78-78 complete-row `GATE-1`
79-79 complete-row `BOOT-1`
80-80 complete-row `BACKTEST-1`
81-81 complete-row `GOV-2C`
83-83 complete-row `UNIV-4`
84-84 complete-row `TRDR-3`
85-85 complete-row `CI-1`
86-86 complete-row `RECON-1`
87-87 complete-row `CI-2`
88-88 complete-row `RECON-2`
89-94 complete-row `LINT-1`
95-126 complete-row `TRDR-4`
127-164 complete-row `SIM-1`
165-190 complete-row `SIM-2`
191-227 complete-row `FOLD-1`
228-290 complete-row `BRACKET-1a`
291-341 complete-row `BRACKET-1b`
342-388 complete-row `BRACKET-1c`
389-418 complete-row `BUNDLE-1`
419-456 complete-row `SNAP-1`
457-496 complete-row `H8-GOV`
497-530 complete-row `DEPCHECK-1`
531-570 complete-row `CORE-MOVE`
571-615 complete-row `BACKTEST-2`
616-627 complete-row `DOCS-1`
628-650 complete-row `OUTAGE-1`
651-672 complete-row `REGISTER-1`
673-705 complete-row `OUTAGE-2`
706-717 complete-row `THROUGHPUT-1a`
718-725 complete-row `THROUGHPUT-1b`
737-737 complete-row `DEPS-1`
772-774 verbatim
776-1257 history completion-records-wave-1.md
1259-1762 history wave-1-batch-1b-in-flight.md
1764-2087 history completion-records-wave-0.md
2089-2318 history wave-0-closeout-and-reviews.md
2322-2354 history wave-2-qualification.md
2366-2399 history wave-2-qualification.md
2488-2488 closed-row `RISK-2 residual 5`
2489-2489 closed-row `RISK2-R6`
2490-2490 closed-row `RISK2-R2`
2492-2492 closed-row `RISK2-R3`
2493-2493 closed-row `RISK2-R4`
2494-2494 closed-row `RECON1-SCAN`
2495-2495 closed-row `RECON1-ORIGIN`
2496-2496 closed-row `RECON1-TEXT`
2497-2497 closed-row `RECON1-EDGE`
2498-2498 closed-row `RECON2-LOOPMEM`
2499-2505 closed-row `LOOPMEM-SIM`
2522-2522 closed-row `SIM2-E2E-MSG`
2536-2536 closed-row `RECON2-EVENTHOP`
2537-2537 closed-row `RECON2-README`
2539-2539 closed-row `N5`
2546-2546 closed-row `N1`
2550-2550 closed-row `GATE1-R4`
2551-2551 closed-row `CI1-L1`
2552-2552 closed-row `CI1-L2`
2554-2554 closed-row `CI1-L3`
2555-2555 closed-row `CI1-L4`
2556-2556 closed-row `CI1-L5`
2557-2557 closed-row `CI2-L5-2`
2558-2558 closed-row `CI2-L5-3`
2560-2560 closed-row `BT1-R1..R4`
2562-2562 closed-row `BOOT1-R7`
2580-2586 closed-row `BRACKET-1b`
2593-2598 closed-row `BRACKET1C-SNAPKEY`
2599-2599 closed-row `M18`
2600-2600 closed-row `BOOT1-CONFIGPARAMS`
2603-2603 closed-row `ADR022-DISCHARGE`
2604-2604 closed-row `DC1-R1-L1`
2613-2613 closed-row `B1-R1-REDIS-UNCAUGHT`
2623-2623 closed-row `BRACKET-1c`
2693-2911 history cross-package-schema-risk.md
2913-2913 verbatim
2924-2924 verbatim
2930-2930 verbatim
2935-2940 verbatim
~~~

- New navigation text with no old counterpart: the brief's intro paragraph, the "Authorized now" intro, the Work packages intro, the Open blockers pointers, the Venue drift intro and the Archive section.

## RW-01: Header: "Last updated"

Old, lines 3-3:

~~~old lines=3-3
Last updated: 2026-09-15  
~~~

New:

~~~new
Last updated: 2026-09-30 (content as of `f43efe6`; restructured by LOGS-1)  
~~~

**Facts.** The date is refreshed to the restructure date, 2026-09-30. The old header date (2026-09-15) was stale: the file holds records dated up to 2026-09-30. "content as of `f43efe6`" names the cut.

## RW-02: Header: current phase (line 5) -> Current phase

Old, lines 5-5:

~~~old lines=5-5
Current phase: `phase-2` — deterministic paper core. **Wave 2 package work COMPLETE** (batches 2A-2G: WP-150/WP-170/WP-200/WP-180, WP-160/WP-190, WP-210, WP-220, WP-230, WP-240, WP-250, all merged and verified as ancestors of `main`; the inherited-`toJSON` sweep `SER-0` `9a44167` and its rounds `SER-1` `c065d63`, `SER-2` `0d8b6a0`, `SER-3` `603a49c` also complete). **Wave 2 is NOT closed out.** The runbook §10 read-only closeout audit WAS run on 2026-09-15 as `GOV-2B` (`b9bacc1`; record `docs/handoffs/GOV-2B-wave-2-closeout.md`), verdict **WAVE 2 IS NOT CLOSED**: every package met its own criteria and three COMPOSITION seams failed. **As of 2026-09-17 (`main` at the `UNIV-4` flip) every AGENT-closable closeout blocker is closed** — B1 (`TRDR-2`), B2 (`RISK-2`), B6/B7 (`GATE-1`), B8 (`GOV-2C`), B9 (`BOOT-1`), B5's code half (`TRDR-3`), G-01 (`VENUE-2`), B10 (`UNIV-4`); B3 is NARROWED (`BACKTEST-1`; needs ruling H8). **What remains is human or a ruling**: B4/H1 the live-data paper run (ATTEMPTED 2026-09-29 as H1 run 1: 34 min on live data, 37,546 decisions, then a fail-closed `TRANSPORT_RESYNC_REQUIRED` halt at the window open because the trader could not keep pace; re-run after `THROUGHPUT-1`, `docs/handoffs/H1-RUN-1.md`), B5's infra half/H3 (PERFORMED 2026-09-29 with H1 run 1: a real Prometheus scraped the control API and a real Grafana imported and rendered the three dashboards; graded by the closeout), H2 a real CI run (DISCHARGED 2026-09-26 by `CI-1`: PR #1 run `36282501033`, all gates green on GitHub), H4 elapsed soak evidence, H5 the runbook :509-vs-:514 ruling, H7 ratifications, H8 the composition-layer ruling, and §5 item 6's owner — enumerated in `## Open blockers` and handed over in `docs/handoffs/WAVE-2-HANDOVER.md`. What "COMPLETE" means and does not mean is stated in `## Wave 2 qualification` below. §7 checklist item 1 stays OPEN until a fresh closeout grades it. The user's 1a/1b/1c track is COMPLETE: `BRACKET-1a` (`11969f3`) makes the instance end CLOSED on its own exit; `BRACKET-1b` (`7252150`) records a two-bracket run with a FILLED take-profit, reconciled per bracket; and `BRACKET-1c` (`6e06c50`) runs the same round trip durably, through real PostgreSQL and Redis and the real composition root. Its two H1 blockers are CLOSED: `SNAP-1` (`fff844d`) writes one PnL snapshot per instance per instant, and `BUNDLE-1` (`fd30e5f`) makes the trader's shipped bundle load. B3 is CLOSED (the H8 track: `BACKTEST-2` `fd12be0`), because the backtest executable builds the same core the trader builds. Items 4 and 5 stay NOT MET on their human halves: the live-data paper run (H1) and the dashboards' infra (H3). WP-260 and the eight remaining phase-3 packages stay deferred to Wave 3. *(This sentence was REWRITTEN 2026-09-17 at the `UNIV-4` flip, replacing rather than appending — per `GOV-2C`'s own residual on this line; the superseded sentence, with its two strikes and two dated notes, is preserved verbatim under `## Wave 2 qualification`, "Superseded header sentences".)*  
~~~

New:

~~~new
`phase-2`: the deterministic paper core.
- **Wave 2 packages:** all merged (batches 2A-2G; each merge is an ancestor of `main`).
- **The inherited-`toJSON` sweep is complete:** `SER-0` (`9a44167`, the measurement) and its rounds `SER-1`, `SER-2` and `SER-3`.
- **Wave 2 is NOT closed out.** The runbook §10 closeout audit `GOV-2B` ran on 2026-09-15 (`main` at `b9bacc1`). Its verdict: every package met its own criteria, but three composition seams failed.
- **Closeout blockers:** every agent-closable blocker is closed; all but B3 were closed by 2026-09-17. B3 closed last, on 2026-09-28 (`BACKTEST-2`, `fd12be0`): the backtest executable now builds the same core as the trader. What remains is human work or a ruling ([Human items](#human-items)).
- **The 1a/1b/1c track is complete.**
  - `BRACKET-1a` (`11969f3`): an instance ends CLOSED after its own exit.
  - `BRACKET-1b` (`7252150`): a recorded two-bracket run with a FILLED take-profit, reconciled per bracket.
  - `BRACKET-1c` (`6e06c50`): the same round trip, durable, through real PostgreSQL and Redis and the real composition root.
  - Its two H1 blockers are closed: `SNAP-1` (`fff844d`) writes one PnL snapshot per instance per instant, and `BUNDLE-1` (`fd30e5f`) makes the trader's shipped bundle load.
- **§7 exit checklist:** item 1 stays OPEN until a fresh closeout grades it. Items 4 and 5 stay NOT MET on their human halves: H1, the live-data paper run, and H3, the dashboards' infrastructure.
- **Next:** `THROUGHPUT-2`, then the H1 re-run, then the fresh read-only closeout audit (after H1 and H3).
- **Deferred:** `WP-260` and the eight remaining phase-3 packages wait for Wave 3 ([Wave 3 authorization](#wave-3-authorization-conditional)).
- Handed over in [`WAVE-2-HANDOVER.md`](docs/handoffs/WAVE-2-HANDOVER.md). What "Complete" means for a Wave 2 row: [Wave 2 qualification](#wave-2-qualification).
~~~

Keep (in both texts):

~~~keep
Wave 2 is NOT closed out
stays OPEN until a fresh closeout grades it
Items 4 and 5 stay NOT MET on their human halves
~~~

**Facts.** Where each part went:
- The batch list (WP-150/WP-170/WP-200/WP-180, WP-160/WP-190, WP-210, WP-220, WP-230, WP-240, WP-250) and the SHAs of `SER-1` (`c065d63`), `SER-2` (`0d8b6a0`) and `SER-3` (`603a49c`): the Work packages table. `SER-0` (`9a44167`) has no row, so it stays in the phase text; the old text said "also complete", and so does the brief ("is complete"), not "merged": `9a44167` is a governance record commit.
- The blocker-to-package list (B1 `TRDR-2`, B2 `RISK-2`, B6/B7 `GATE-1`, B8 `GOV-2C`, B9 `BOOT-1`, B5's code half `TRDR-3`, G-01 `VENUE-2`, B10 `UNIV-4`): the table and the Closed list under Closeout blockers. "As of 2026-09-17" is kept as "all but B3 were closed by 2026-09-17".
- Archive only: "(`main` at the `UNIV-4` flip)", and B3's interim narrowing by `BACKTEST-1` ("NARROWED", "needs ruling H8"); B3 has since closed.
- The H1 run 1 details: Human items > H1 (the `B4` row points there). H3: the `B5` row and Human items. H2 (`CI-1`, PR #1 run `36282501033`), H4, H5, H7, H8 and §5 item 6's owner: Human items.
- "re-run after `THROUGHPUT-1`" (2026-09-29) is superseded inside the base file by the `THROUGHPUT-2` row (2026-09-30: "H1 is re-run afterwards"); the brief says "after `THROUGHPUT-2`".
- Not carried: the italic note on how the sentence was rewritten on 2026-09-17 (process history, in `header-and-phase.md`).

## RW-03: Header: maximum run mode

Old, lines 6-6:

~~~old lines=6-6
Maximum permitted run mode: `PAPER`
~~~

New:

~~~new
Maximum permitted run mode: `PAPER`
~~~

**Facts.** Unchanged; moved up one line.

## RW-04: Work packages: table header

Old, lines 19-21:

~~~old lines=19-21

| Work package           | State    | Dependencies       | Assignment |
| ---------------------- | -------- | ------------------ | ---------- |
~~~

New:

~~~new
| Package | Scope | Status | Merge | Record |
| --- | --- | --- | --- | --- |
~~~

**Facts.** Four columns become five, one physical line per package. Derivation, applied to every row:
- Package: the row id, exact.
- Scope: the parenthetical in the old id cell, verbatim; for a bare `WP-` id, the package title from `docs/spec/polymarket-bot-workplan.yaml`.
- Status: "Complete" with the date the row states; for Wave 0-1 rows that give no date, the merge commit's date from git. Live rows keep their own vocabulary (see the pairs below).
- Merge: the first "merged `<sha>`" in the row, plus the root-wiring SHA where the row names one (`WP-100`, `WP-120`, `WP-130`, `WP-140`, `WP-210`, `WP-230`, `WP-240`, `WP-250`). Proof C1 checks that every SHA in this column occurs in the old row.
- Record: the handoff. `WP-080-FU1`'s is the FU1 section of `WP-080.md`; `GOV-2B`'s is `GOV-2B-wave-2-closeout.md`; `DEPS-1` has no handoff.
- Not carried: Dependencies, Assignment, chains, review rounds, Codex session ids, gate counts, scope, allowed paths. They stay in the archived rows.

## RW-05: Work packages: `WP-140` (live: the H4 gate)

Old, lines 39-39:

~~~old lines=39-39
| `WP-140`               | Implementation complete; automated checks complete; **external time-based evidence PENDING** (gate open) | All ✓ | Merged `735d330` + root wiring `5757ef3` (impl chain `9b9173a`→`860436c`→`4d0d163`→`e7ded4b`→`f947034`, 4 review rounds / 3 remediation rounds; round 4 **ACCEPT** for implementation+checks, Codex `01a061d3-e4a5-76e1-9548-a484ef46076a`). The external-evidence gate closes only via the runbook §7 governance procedure after a real ≥24h soak. See completion record below |
~~~

New:

~~~new
| `WP-140` | Recorder observability and soak harness | Implementation complete; automated checks complete; evidence pending: the ≥24h soak (H4); the gate is open | `735d330` + wiring `5757ef3` | [WP-140](docs/handoffs/WP-140.md) |
- **H4**, elapsed soak evidence: open. It is the `WP-140` gate, which closes only through the runbook §7 governance procedure after a real ≥24h soak.
~~~

Keep (in both texts):

~~~keep
Implementation complete; automated checks complete
runbook §7 governance procedure
after a real ≥24h soak
~~~

**Facts.** Kept: "Implementation complete; automated checks complete", evidence pending with the gate open, and the closing rule (the runbook §7 governance procedure after a real ≥24h soak, now under Human items > H4). Not carried: the implementation chain, the four review and three remediation rounds, and the Codex session id (archive).

## RW-06: Work packages: `THROUGHPUT-1c` (live: authorized, deferred)

Old, lines 726-736:

~~~old lines=726-736
| `THROUGHPUT-1c` (book freshness by feed liveness, not by the last change) | **Authorized 2026-09-29** by the user ("Fold into the round"); **moved OFF the critical path, 2026-09-30 (the user: "Let's go with your recommendation"): runs AFTER the Wave 2 closeout**, alongside the start of Wave 3. Earlier orders: after `THROUGHPUT-2`; originally after `THROUGHPUT-1a`/`-1b`. HARDENING LOOP; verifier: a Fable adversarial-reviewer.

**The finding:** 20,367 of H1 run 1's 37,546 decisions (54%) paused on `SB.STALE_BOOK`. Book age is `now − book.asOf`, the last CHANGE, so a quiet but live book reads stale after 2 s. The risk policy's `venueBookMaxAgeMs` has the same shape.

**Scope:**
  - (1) ADR-023, **Proposed**: a liveness-based freshness rule grounded ONLY in the venue's documented market-channel behaviour (`docs/venue/verified-*.md` and current official docs; never invented). The user ratifies it before merge.
  - (2) Implement it end to end: a gateway liveness signal if one is needed, then features, strategy and risk freshness, with the strategy's parameter and version discipline.
  - (3) Evidence:
    - a quiet but live book is fresh;
    - a silent or disconnected feed is stale within its bound;
    - every golden change is listed and explained. | THROUGHPUT-1a ✓, THROUGHPUT-1b ✓ | set at start from 1a/1b's merged tree: docs/adr/ADR-023-*.md, packages/{features,risk,strategies/static-bracket,trading-core}/**, apps/data-gateway/**, packages/polymarket-public/** (if a liveness signal is needed), test/**. Gate: automated + Fable adversarial review + the user's ADR-023 ratification + a green CI run on GitHub. |
~~~

New:

~~~new
| `THROUGHPUT-1c` | book freshness by feed liveness, not by the last change | Authorized; runs after the Wave 2 closeout | — | — |
- **`THROUGHPUT-1c`** (queued, not startable now): authorized by the user on 2026-09-29. On 2026-09-30 the user moved it off the critical path: it runs after the Wave 2 closeout, alongside the start of Wave 3.
  - The finding: in H1 run 1, 20,367 of 37,546 decisions (54%) paused on `SB.STALE_BOOK`. Book age is `now − book.asOf`, the last change, so a quiet but live book reads stale after 2 s. The risk policy's `venueBookMaxAgeMs` has the same shape.
  - Scope (1): ADR-023, Proposed: a liveness-based freshness rule grounded ONLY in the venue's documented market-channel behaviour (`docs/venue/verified-*.md` and current official docs; never invented). The user ratifies it before merge.
  - Scope (2): end to end: a gateway liveness signal if one is needed, then features, strategy and risk freshness, with the strategy's parameter and version discipline.
  - Evidence (3): a quiet but live book is fresh; a silent or disconnected feed is stale within its bound; every golden change is listed and explained.
  - HARDENING LOOP; verifier: a Fable adversarial-reviewer. Gate: automated checks, the Fable adversarial review, the user's ADR-023 ratification, and a green CI run on GitHub.
~~~

Keep (in both texts):

~~~keep
grounded ONLY in the venue's documented market-channel behaviour
a quiet but live book reads stale after 2 s
with the strategy's parameter and version discipline
a silent or disconnected feed is stale within its bound
every golden change is listed and explained
a green CI run on GitHub
The user ratifies it before merge
~~~

**Facts.** Kept: authorized 2026-09-29 by the user; moved off the critical path 2026-09-30; runs after the Wave 2 closeout, alongside the start of Wave 3; the finding with its numbers and mechanism (`now − book.asOf`, stale after 2 s, `venueBookMaxAgeMs`); scope (1)-(3) with the ONLY-documented-behaviour rule, parameter and version discipline, and all three evidence items; HARDENING LOOP; the Fable verifier; the full gate, including the green CI run on GitHub. Not carried: the user's quoted words, the earlier orders (after `THROUGHPUT-2`; originally after `THROUGHPUT-1a`/`-1b`), the dependencies (`THROUGHPUT-1a`, `THROUGHPUT-1b`, both complete) and the allowed paths (archive).

## RW-07: Work packages: `THROUGHPUT-2` (live: Ready)

Old, lines 738-755:

~~~old lines=738-755
| `THROUGHPUT-2` (evaluate once per venue frame: no half-applied book states; reach the H1 burst rate) | **Ready (authorized) 2026-09-30** by the user ("Yes, round before re-run"). HARDENING LOOP; verifier: a Fable adversarial-reviewer. Base `229d58a`. Runs BEFORE `THROUGHPUT-1c`; H1 is re-run afterwards.

**Why:**
- Every H1 frame produced two `BookLevelChanged` events (one per token), and the trader evaluated after each. So half of all evaluations saw a half-applied book that never existed at the venue (`H1R1-FRAME-ATOMICITY`).
- After `THROUGHPUT-1a`, evaluation is about 82% of CPU.

**Kept:** exactly one persisted decision per callback (handoff §7.5, ADR-005). Every event is still applied and recorded; none is dropped. **Changed:** the callback fires once per frame, after the frame's last event.

**Scope:**
  - (1) **ADR-024**, Proposed; the user ratifies it before merge. It covers frame completeness without waiting on the next event, the per-source frame meaning grounded in `docs/venue/verified-*.md`, replay/backtest parity (ADR-022), crash recovery mid-frame, and determinism.
  - (2) The implementation.
  - (3) Semantics-preserving extras: a static-bracket parameter-validation cache, and an exact incremental EWMA (only if proven bit-identical).
  - (4) Evidence:
    - the targets: catch-up ≥ 943 events/s, paced max lag ≤ 5 s, no halt;
    - a pin that half-applied states are gone;
    - a fixture proof that no event is dropped;
    - a base-vs-candidate decision characterization;
    - every golden change explained. | THROUGHPUT-1a ✓, THROUGHPUT-1b ✓ | docs/adr/ADR-024-*.md (new), packages/trading-core/src/**, apps/trader/src/** (not src/register/**), apps/data-gateway/src/** + packages/domain/src/** + packages/event-bus/src/** (frame marker / envelope / consumer grouping, only as the design needs), packages/strategies/static-bracket/src/** (parameter-validation cache ONLY), packages/features/src/** (EWMA only if proven exact), apps/backtest-cli/src/** (parity), test/** (golden re-baselines, each explained), tools/bench/trader-throughput/**. Forbidden: db/**, docs/** other than the ADR, lockfile, packages/risk/**, strategy decision logic, protected files. Gate: automated + Fable adversarial review + a green CI run on GitHub + the user's ADR-024 ratification. **The user ruled 2026-09-30 ("Merge on reviewer ACCEPT"):** on reviewer ACCEPT it merges, with ADR-024 marked *Accepted provisionally (orchestrator, pending user ratification)*. The user ratifies afterwards, and a rejection is reverted by a follow-up round. |
~~~

New:

~~~new
| `THROUGHPUT-2` | evaluate once per venue frame: no half-applied book states; reach the H1 burst rate | **Ready (authorized)** 2026-09-30 | — | — |
- **`THROUGHPUT-2`**: Ready (authorized) by the user, 2026-09-30.
  - Goal: evaluate once per venue frame, so no half-applied book state is evaluated (`H1R1-FRAME-ATOMICITY`), and reach the H1 burst rate. After `THROUGHPUT-1a`, evaluation is about 82% of CPU.
  - Kept: exactly one persisted decision per callback (handoff §7.5, ADR-005); every event is still applied and recorded, and none is dropped. Changed: the callback fires once per frame, after the frame's last event.
  - Scope (1): ADR-024, Proposed. It covers frame completeness without waiting on the next event, the per-source frame meaning grounded in `docs/venue/verified-*.md`, replay/backtest parity (ADR-022), crash recovery mid-frame, and determinism.
  - Scope (2)-(3): the implementation, plus two semantics-preserving extras only: a static-bracket parameter-validation cache, and an exact incremental EWMA only if proven bit-identical.
  - Evidence (4): catch-up ≥ 943 events/s, paced max lag ≤ 5 s, no halt; a pin that half-applied states are gone; a fixture proof that no event is dropped; a base-vs-candidate decision characterization; every golden change explained.
  - Base `229d58a`. HARDENING LOOP; verifier: a Fable adversarial-reviewer. Runs before `THROUGHPUT-1c`. H1 is re-run afterwards.
  - Gate: automated checks, the Fable adversarial review, a green CI run on GitHub, and the user's ADR-024 ratification.
  - Ratification may follow the merge (user ruling, 2026-09-30): on reviewer ACCEPT the round merges, with ADR-024 marked *Accepted provisionally (orchestrator, pending user ratification)*. The user ratifies afterwards; a rejection is reverted by a follow-up round.
~~~

Keep (in both texts):

~~~keep
about 82% of CPU
frame completeness without waiting on the next event
crash recovery mid-frame
only if proven bit-identical
a fixture proof that no event is dropped
a base-vs-candidate decision characterization
catch-up ≥ 943 events/s
a green CI run on GitHub
Accepted provisionally (orchestrator, pending user ratification)
~~~

**Facts.** Kept: Ready (authorized) 2026-09-30; the goal and both "Why" facts (`H1R1-FRAME-ATOMICITY`; evaluation about 82% of CPU); kept and changed semantics; scope (1)-(4) item by item, with "ONLY" and "only if proven bit-identical"; the targets; base `229d58a`; HARDENING LOOP; the Fable verifier; before `THROUGHPUT-1c`; H1 afterwards; the full gate, including the green CI run on GitHub; the 2026-09-30 merge-on-ACCEPT ruling, which moves only the ratification after the merge. Not carried: the user's quoted words, the dependencies (both complete), and the allowed and forbidden paths (the archived row, which the "Authorized now" intro points to).

## RW-08: Work packages: `VENUE-3` (live: Ready)

Old, lines 756-768:

~~~old lines=756-768
| `VENUE-3` (the phase-3 venue gate: the Wave 3 start re-verification, including the C-4 re-check and a fresh SDK pin check) | **Ready (authorized) 2026-09-30.** The user: "Just in case you end up finishing wave 3 blockers, please proceed with orchestrating wave 3 work itself." It runs in parallel with `THROUGHPUT-2`, because its paths are disjoint. The implementer is the `venue-verifier` agent. HARDENING LOOP; verifier: a Fable adversarial-reviewer that re-fetches every source.

**Scope:** VENUE-2's shape, for phase 3. It is the full handoff §1.2 re-verification against `verified-2026-09-16.md`, with every drift row quoted, sourced, and given a consequence and an owner. The emphasis is on the Wave 3 surfaces:
  - the unified secure SDK: the current commit and version, what changed since `983a10a7…`, and the U-7 / D-02 pin check for `WP-260`;
  - L1/L2 authentication;
  - order placement and cancel, and the error codes (U-4);
  - the user WebSocket channel (`WP-280`);
  - heartbeats (`WP-320`);
  - geoblock, documentary only: the endpoint is NOT called;
  - rate limits and matching-engine modes (`WP-310`);
  - collateral, pUSD and the settlement-contract addresses (U-5, `WP-300`);
  - C-4.
**Documentary only:** unauthenticated GETs of the documentation and the SDK source. No credential, wallet, signer, authenticated endpoint, order or WebSocket. | THROUGHPUT-1a ✓ | docs/venue/verified-<fetch-date>.md (new), test/fixtures/venue/README.md (append-only dated section), docs/contracts/protected-contracts.md (the C-4, U-4, U-5 and U-7 rows' dated annotations only). Forbidden: the frozen report, every earlier `verified-*.md`, packages/**, apps/**, fixture payloads. Gate: Fable adversarial review (re-fetch) + a green CI run on GitHub. |
~~~

New:

~~~new
| `VENUE-3` | the phase-3 venue gate: the Wave 3 start re-verification, including the C-4 re-check and a fresh SDK pin check | **Ready (authorized)** 2026-09-30 | — | — |
- **`VENUE-3`**: Ready (authorized) by the user, 2026-09-30.
  - Goal: the phase-3 venue gate, i.e. the Wave 3 start re-verification. It is `VENUE-2`'s shape for phase 3: the full handoff §1.2 re-verification against `verified-2026-09-16.md`, with every drift row quoted, sourced, and given a consequence and an owner.
  - Emphasis, the Wave 3 surfaces: the unified secure SDK (its current commit and version, what changed since `983a10a7…`, and the U-7 / D-02 pin check for `WP-260`); L1/L2 authentication; order placement, cancel and error codes (U-4); the user WebSocket channel (`WP-280`); heartbeats (`WP-320`); geoblock, documentary only (the endpoint is NOT called); rate limits and matching-engine modes (`WP-310`); collateral, pUSD and the settlement-contract addresses (U-5, `WP-300`); C-4.
  - Documentary only: unauthenticated GETs of the documentation and the SDK source. No credential, wallet, signer, authenticated endpoint, order or WebSocket.
  - Runs in parallel with `THROUGHPUT-2` (disjoint paths). Implementer: the `venue-verifier` agent. HARDENING LOOP; verifier: a Fable adversarial-reviewer that re-fetches every source.
  - Gate: the Fable adversarial review (re-fetch) and a green CI run on GitHub.
~~~

Keep (in both texts):

~~~keep
with every drift row quoted, sourced, and given a consequence and an owner
what changed since 983a10a7…
the endpoint is NOT called
No credential, wallet, signer, authenticated endpoint, order or WebSocket
collateral, pUSD and the settlement-contract addresses
a green CI run on GitHub
~~~

**Facts.** Kept: Ready (authorized) 2026-09-30; `VENUE-2`'s shape; the full §1.2 re-verification against `verified-2026-09-16.md` with every drift row quoted, sourced, and given a consequence and an owner; every Wave 3 surface in the list; the documentary-only rule, including that the geoblock endpoint is not called; parallel with `THROUGHPUT-2`; the `venue-verifier` implementer; the re-fetching Fable verifier; the gate, including the green CI run on GitHub. Not carried: the user's quoted words, the dependency (`THROUGHPUT-1a`, complete), and the allowed and forbidden paths (archive).

## RW-09: Work packages: `WP-260` and "All other packages"

Old, lines 769-770:

~~~old lines=769-770
| `WP-260`               | Dependency-ready; DEFERRED to Wave 3 by wave ordering and signer-boundary safety | All ✓ | — |
| All other packages     | Blocked  | See work plan      | —          |
~~~

New:

~~~new
| `WP-260` | Secure unified-SDK adapter and signer boundary | Dependency-ready; deferred to Wave 3 by wave ordering and signer-boundary safety | — | — |
| All other packages | — | Blocked | — | See work plan |
~~~

Keep (in both texts):

~~~keep
by wave ordering and signer-boundary safety
~~~

**Facts.** Kept in the row: "Dependency-ready", deferred to Wave 3, and the reason (wave ordering and signer-boundary safety). Not carried: the Dependencies cell "All ✓" (every dependency complete) and the empty Assignment cell.

## RW-10: Work packages: `VENUE-2` facts fed to later rounds

Old, lines 82-82:

~~~old lines=82-82
| `VENUE-2` (the phase-2 venue gate — GOV-2B **G-01**) | **Complete (2026-09-17)** — merged `d6aedee` (`--no-ff`; chain `25a0794` → `719455d` → `4038e1d` r1, on base `f8c5065`). Review r0 **ACCEPT** (0 HIGH, 1 MEDIUM, 4 LOW, 4 INFO — the reviewer re-fetched ALL 62 §14 sources, 62/62 SHA-256 matches, and reproduced every drift row's frozen and current quote and every repository `file:line`) → r1 **ACCEPT** (3 INFO). **G-01 CLOSED.** Shipped `docs/venue/verified-2026-09-16.md` (1,100+ lines; **named by fetch date** — the round was authorized 2026-09-15, every fetch was made 2026-09-16 17:18-17:31 UTC, stated in the header and per row; the two prior dated reports follow the same convention): the FULL handoff §1.2 twelve-item re-verification for phase 2 in the frozen report's structure, plus the two pages `verified-2026-09-02.md` §7 queued (`concepts/resolution`, `api-reference/markets/get-market-by-id` — indexed for the first time) and its §7 item 3 discharged explicitly; official `Polymarket/ts-sdk` at NAMED commit `983a10a7…` (2026-09-14) with every relevant file also fetched at the frozen `7fdbed42…` and diffed. Verdicts: 4 UNCHANGED (order types/expiration; heartbeat; geoblock; RTDS), 8 DRIFT, **31 drift rows D-01…D-31**, each with both texts quoted, a source, a repository consequence (`file:line`) and an owner; §11 conflicts C-1…C-4 re-examined, C-5…C-8 new; §12 UNVERIFIED with reasons (nothing SDK-only presented as documentation); §13 safety attestation; §14 source index with UTC timestamp, HTTP status, bytes, redirects and SHA-256 for every fetch. **No fixture payload changed**: no drift touches a wire shape a fixture encodes (the reviewer's per-schema key diff of the SDK at both commits: no key added or removed in any WS event schema; only `market: z.string() → ConditionIdSchema` and `asset_id: TokenIdSchema → ClobAssetIdSchema`, and all 21 fixture `market` values already comply); `test/fixtures/venue/README.md` gained an append-only dated section. Frozen report unedited (`protected-contracts.md` §2). **Documentary only:** unauthenticated GETs to `docs.polymarket.com`, `api.github.com`, `raw.githubusercontent.com`; no credential, wallet, signer, authenticated endpoint, WebSocket, RTDS or order; the geoblock endpoint not called; PAPER-only defaults untouched. **Facts that feed the next rounds:** **D-30** — the venue PUSHES no open/close/closing signal (U-12: the market WebSocket's lifecycle events are exactly `new_market` and `market_resolved`) but DOCUMENTS a polled `MarketState` surface with the readiness predicate `isTradeReady = active && !closed && acceptingOrders`, six fields with documented semantics and thirteen name-only — the basis for **B10** / `UNIV-4` (row below); **D-15** — the register's C-2 reopen condition is MET (the pUSD page: "standard ERC-20 wrapper that represents a USDC claim", wrap/unwrap enforced onchain by `CollateralOnramp`/`CollateralOfframp`, asset "Must be USDC.e"; the bridge and resolution pages agree) — recorded under `## Pending external evidence` for the register/ADR-006 owner; **D-13** per-market `feeSchedule {rate, exponent, takerOnly, rebateRate}` where `packages/simulation/src/fees.ts:16-19` models only `exponent = 1`; **D-17** the minimum-order-size UNIT conflict (market-details "USDC notional" vs place-orders "shares"; `static-bracket/src/decide.ts:771` compares shares) — C-7; **D-02** SDK 0.6.0 → 0.10.0 with breaking changes (`WP-260`); **D-20** the SDK's closed five-value `UmaResolutionStatus` enum (register U-11 owner). The review's one MEDIUM (U-12 omitted the documented polled surface B10 needs) became D-30 in r1; the LOWs corrected a misattributed rename-pin (`test/contract/polymarket-public/market-ws-fixtures.test.ts:144`; the name stays per ADR-013), D-19's owner, an unrecorded `expiration` placement difference (D-31), and cites. Gates at tip and post-merge on main: `pnpm test:contract` **583 / 65 / 158 / 95** (unchanged), the verify-venue vitest 2 files / 375, `pnpm ops:verify-venue` exit 0, `pnpm run test` 328 / 7154 on main, lint 0, typecheck 0. Residuals (owned, `docs/handoffs/VENUE-2.md` follow_up 1-10 and §16.3): the C-2 register amendment (D-15) and U-11 (D-20) for the register owner; `apps/ops-cli`'s validator pins the frozen report only (`checks.ts:69`) and pins `effective_date` to 2026-08-24 (`:249-252`) — the phase-2 report is not consumed by the offline gate (§15 items 1-4); `feeSchedule.exponent ≠ 1` (U-17) and rounding direction (U-16) still undocumented; Protocol V2 documented only in SDK source (U-15); handoff §24 has three redirecting links (D-07, D-11, D-25); the phase-3 start gate owes its own report. *Superseded authorization text follows.* — handoff §1.2 requires, at the START of each implementation phase, a twelve-item re-verification against official sources committed as `docs/venue/verified-YYYY-MM-DD.md`. Every Wave 2 package is `phase: phase-2`, and the gate was never run for it: the only full report is `verified-2026-08-24.md` (phase-0); `verified-2026-09-02.md` (five items) and `verified-2026-09-03.md` (C-2 only) each state in their own scope paragraph that they are "a bounded re-issue, not a full handoff-§1.2 phase-gate re-verification", and `verified-2026-09-02.md` §7 item 3 records the full re-verification as still owed "at the next phase gate". The closeout's completeness critic found it; nothing else did. Scope: the FULL twelve-item §1.2 list (SDK + minimum runtime; order request/response schemas; order types and expiration; market and user WebSocket schemas; heartbeat; fees and rewards; per-market trading parameters; IP and per-signer rate limits; matching-engine restricted modes; geographic restrictions; split/merge/redemption; Chainlink/RTDS symbols, windows and stream behaviour) re-verified against CURRENT official documentation and the official `Polymarket/ts-sdk` at a named commit, written as `docs/venue/verified-2026-09-15.md` in the frozen report's structure, PLUS the two pages the 2026-09-02 re-issue queued for the next full round (the resolution page; the market-by-id surface, source of register rows U-10/U-11). Every difference from the frozen 2026-08-24 baseline is stated AS DRIFT with both texts quoted and its consequence for the repository named (which package, which fixture, which contract test) — never silently adopted; the frozen report is unedited (`protected-contracts.md` §2). Where drift changes a wire shape, the sanitized fixture under `test/fixtures/venue/**` is updated with `retrieved: 2026-09-15` and the contract suites (`pnpm test:contract`, currently 583/65/158/95, and `apps/ops-cli/src/verify-venue/**`'s fixture test) prove it; where drift changes a parameter the repository hard-codes or configures, the site is CITED (file:line) and left for the owning package — this round changes no `packages/**` or `apps/**` source. **Method constraints (AGENTS.md Safety, unchanged):** read-only, unauthenticated GETs of public documentation and the public SDK repository only; no credential, no wallet, no signer, no authenticated endpoint, no order, no WebSocket connection; every fact documentary, with URL, access timestamp, byte count and sha256 as the 2026-09-03 re-issue did. Acceptance: the report covers all twelve items and both queued pages with a per-item verdict (UNCHANGED / DRIFT / UNVERIFIED-with-reason), a §11-style conflicts table against handoff §23, a source index, a safety attestation, and an explicit statement discharging `verified-2026-09-02.md` §7 item 3; `pnpm test:contract` and `pnpm run test` green at tip. Implemented by the project `venue-verifier` agent; independent adversarial review (a different agent re-fetches a sample of the sources and checks every DRIFT claim against both texts) before merge. Paths fully disjoint from BOOT-1, BACKTEST-1 and GOV-2C — dispatched in parallel off `1aa2238`. | GOV-2B ✓ | docs/venue/verified-2026-09-16.md (new; the grant said `-09-15.md`, renamed to the fetch date at review round 1 by the orchestrator's ruling), test/fixtures/venue/**, docs/handoffs/VENUE-2.md. NOT `docs/venue/verified-2026-08-24.md`, NOT `packages/**`, NOT `apps/**`. Gate: automated + adversarial review. |
~~~

New:

~~~new
`verified-2026-09-16.md` fed these to later rounds; they have no row of their own.
- D-13: a per-market `feeSchedule {rate, exponent, takerOnly, rebateRate}`, while `packages/simulation/src/fees.ts` models only `exponent = 1`.
- D-17: the minimum-order-size unit conflict (market details say "USDC notional", place-orders says "shares"; static-bracket `decide.ts` compares shares). Register conflict C-7.
- D-02: SDK 0.6.0 → 0.10.0 with breaking changes (`WP-260`; `VENUE-3` re-checks the pin).
- D-15 and D-20: see [Pending external evidence](#pending-external-evidence). D-30 is B10's basis (closed).
~~~

Keep (in both texts):

~~~keep
models only exponent = 1
the minimum-order-size UNIT conflict
SDK 0.6.0 → 0.10.0 with breaking changes
~~~

**Facts.** `VENUE-2` is a Complete row, but its "Facts that feed the next rounds" name drift with no residual row. The brief carries D-13, D-17 (C-7) and D-02, and points D-15/D-20 at Pending external evidence. Not carried: the rest of the row (the chain, the review, the 31 drift rows, the source index, the gates), which is history in `work-packages-waves-0-2.md`.

## RW-11: Open blockers: intro

Old, lines 2440-2453:

~~~old lines=2440-2453
## Open blockers

*(Corrected 2026-09-15 by `GOV-2C` — `GOV-2B` **B8**. This section previously
read, in full: "None." It was seeded on 2026-08-21 (`58fe7ee`) before any package
had been dispatched and was never revisited, so on 2026-09-15 it sat directly
above a 219-line record whose own closing sentence says "**The record stays
open**: it is discharged as an *audit* and remains open as a *remediation*,
since every finding it names is still live on `main`". The word was true of
nothing; the closeout had to read it as authority; it is quoted here rather
than deleted, per `docs/contracts/protected-contracts.md` §4.)*

What is open is of three kinds — closeout blockers, a residual queue that the
last five rounds left with owners, and the cross-package record's findings
reconciled against what has since merged. Each item names its evidence.
~~~

New:

~~~new
Open items are closeout blockers, residual rows, venue drift carried forward,
and human items ([below](#human-items)). Full rows, evidence and history:
[`open-blockers-2026-09.md`](docs/status-archive/open-blockers-2026-09.md)
(search for the id). The cross-package schema-boundary findings (zod adoption and
loss) are in
[`cross-package-schema-risk.md`](docs/status-archive/cross-package-schema-risk.md);
what is still live from them is listed under
[Schema boundary](#schema-boundary-still-live).
~~~

**Facts.** Reorganized, not copied: the old intro listed closeout blockers, the residual queue and the reconciled cross-package findings; the brief lists closeout blockers, residual rows, carried-forward venue drift and human items, and moves the cross-package findings to the Schema boundary subsection. The correction note (GOV-2C, 2026-09-15: the section once read "None.") is history in `open-blockers-2026-09.md`.

## RW-12: Closeout blockers: table header

Old, lines 2455-2458:

~~~old lines=2455-2458
### Closeout blockers still open (from `GOV-2B`, 2026-09-15)

| Id | What | State on `main` `1aa2238` | Owner |
| --- | --- | --- | --- |
~~~

New:

~~~new
### Closeout blockers (from `GOV-2B`, 2026-09-15)
| Id | State | Owner |
| --- | --- | --- |
~~~

**Facts.** "still open" leaves the heading because the table also lists a ratified item. "What" merges into State. "State on `main` `1aa2238`" was stale; the brief states current state.

## RW-13: Closeout blocker `B4`

Old, lines 2461-2461:

~~~old lines=2461-2461
| **B4** | CHECK-4's live-data half has never been run — `RedisMarketEventFeed` has no test; no database was ever reached from the shipped root | OPEN; every AGENT-closable precondition is now closed — B9 (`BOOT-1`), B10 (`UNIV-4`), the venue gate (`VENUE-2`), the health surface (`TRDR-3`). What remains before the run is attempted is HUMAN or a decision: an operator registers the market/instance/run rows (BOOT-1's two-step registration; no CLI), configures the gateway's `lifecycle` block with a verified `gammaMarketId` (UNIV4-R1: nothing checks it), and accepts that **BOOT1-R7** (a Redis outage HANGS the real process rather than halting it) is unfixed — or authorizes a small `packages/event-bus` round for a receive bound first. `RedisMarketEventFeed` now has real-Redis coverage through UNIV-4 part (c) and BOOT-1's acceptance  **ATTEMPTED 2026-09-29 (H1 run 1, `docs/handoffs/H1-RUN-1.md`):** registered by the REGISTER-1 command, and the gammaMarketId was verified against both venue APIs. The run lasted 34 min on live data: 37,546 decisions and checkpoints, read back clean. It then halted fail-closed (`TRANSPORT_RESYNC_REQUIRED`) at the window open, because the trader could not keep pace (about 35 decisions/s against about 735 events/s). No entry was evaluated. Re-run after `THROUGHPUT-1` (user, 2026-09-29) | human **H1** |
~~~

New:

~~~new
| `B4` | **Open.** CHECK-4's live-data half, i.e. H1. Its preconditions are closed: `B9` (`BOOT-1`), `B10` (`UNIV-4`), the venue gate (`VENUE-2`), the health surface (`TRDR-3`). Run 1 (2026-09-29) halted fail-closed on throughput; details under [Human items](#human-items). Re-run after `THROUGHPUT-2`. | human (H1) |
- **H1**, the live-data paper run. Run 1 (2026-09-29, [`H1-RUN-1.md`](docs/handoffs/H1-RUN-1.md)) was registered with `REGISTER-1`, and its `gammaMarketId` was verified against both venue APIs. It ran 34 min on live data: 37,546 decisions and checkpoints, read back clean. It then halted fail-closed (`TRANSPORT_RESYNC_REQUIRED`) at the window open: the trader could not keep pace (about 35 decisions/s against about 735 events/s). No entry was evaluated. Re-run after `THROUGHPUT-2`.
~~~

Keep (in both texts):

~~~keep
37,546 decisions and checkpoints, read back clean
about 35 decisions/s against about 735 events/s
No entry was evaluated
gammaMarketId was verified against both venue APIs
~~~

**Facts.** The old cell holds two states: the preconditions as of 2026-09-17 (register the rows with no CLI; configure an unchecked `gammaMarketId`; accept `BOOT1-R7` or authorize an event-bus round) and the 2026-09-29 attempt. The brief states the later one; the run details now sit under Human items > H1, and the row points there. Superseded inside the base: registration by `REGISTER-1`, `BOOT1-R7` (closed by `OUTAGE-1`). `UNIV4-R1` stays open in the residual queue. Archive only: "`RedisMarketEventFeed` has no test" and its later real-Redis coverage (UNIV-4 part (c), BOOT-1's acceptance), and "no database was ever reached from the shipped root", both superseded by run 1. "Re-run after `THROUGHPUT-1`" became "after `THROUGHPUT-2`" (see RW-02).

## RW-14: Closeout blocker `B5`

Old, lines 2462-2462:

~~~old lines=2462-2462
| **B5** | Dashboards: "Realized PnL" is a `type: text` panel with an empty targets list; no `trader_*` series has a runtime producer; `apps/trader` serves no HTTP; nothing provisions a Grafana | **CODE HALF (R4) CLOSED 2026-09-17 by `TRDR-3` (`da9c58e`)**: the trader serves `GET /health` (loopback, bounded, own-data), the control API refreshes on every authorized read, realized PnL is an exact-decimal `_info` family with a real `table` panel target, one scrape fragment exists. **INFRA/HUMAN HALF (R5) OPEN**: no real Prometheus has loaded `infra/prometheus/control-api-scrape.yaml`, nothing provisions a Grafana, no real import has happened, no test validates the fragment — **H3** | `TRDR-3` ✓ (R4); human **H3** (R5) |
~~~

New:

~~~new
| `B5` | **Code half (R4) closed** by `TRDR-3` (`da9c58e`). **Infra half (R5), i.e. H3:** performed 2026-09-29 with H1 run 1 (a real Prometheus scraped the control API; a real Grafana imported and rendered the three dashboards). The fresh closeout grades it. The row also records that no test validates the scrape fragment. | human (H3) |
~~~

Keep (in both texts):

~~~keep
CODE HALF (R4) CLOSED
~~~

**Facts.** Kept: the code half closed by `TRDR-3` (`da9c58e`); the infra half is H3; no test validates the fragment. The R5 list ("no real Prometheus has loaded the fragment, nothing provisions a Grafana, no real import has happened") predates H3's performance on 2026-09-29; the brief states the later fact. Archive only: the code-half mechanism (`GET /health`, refresh on read, the `_info` family, the `table` panel target) and the original defect ("Realized PnL" as a text panel).

## RW-15: Closeout blocker `B9`

Old, lines 2463-2463:

~~~old lines=2463-2463
| **B9** | The assembled durable trader halts on its first DECISION: `strategy.decisions.run_id`/`.instance_id` are NOT NULL FKs (`db/migrations/0004_strategy.up.sql:260-261`) to rows nothing in `apps/trader/src` creates; `loop.ts:1663-1674` halts on a failed `persistDecision` (the call at `:1663`, the GLOBAL `STORE_UNAVAILABLE` halt at `:1667`; *corrected in GOV-2C remediation r1, GOV2C-4 — the first version cited `:1645-1656`, inherited from the `BOOT-1`/`TRDR-2` rows, which is where the block sat before `RISK-2` shifted `loop.ts` by 18 lines*). `TRDR-2` closed B1's CAUSE (the column binding) and raised this as B1's SYMPTOM | **CLOSED 2026-09-16 by `BOOT-1` (`0d09eb5`) for a run's FIRST start** — the trader refuses to start unless the rows exist and match, and refuses to resume a run that already holds decisions (restart fails CLOSED at startup, exit 78, instead of at the first decision). Not a resume: the R10 read path is still Wave 3's; the operator remedy after a crash is a NEW run. The `fill_id`/`order_id` NULL binding is a disclosed severing (residual queue) | `BOOT-1` ✓; R10 for resume |
~~~

New:

~~~new
| `B9` | **Closed for a run's first start** by `BOOT-1` (`0d09eb5`): the trader refuses to start unless its rows exist and match, and refuses to resume a run that holds decisions (exit 78). Resume (R10) is Wave 3's; after a crash the operator starts a NEW run. | `BOOT-1` ✓; R10 for resume |
~~~

Keep (in both texts):

~~~keep
refuses to resume a run that
exit 78
a NEW run
~~~

**Facts.** Kept: closed for a run's first start by `BOOT-1` (`0d09eb5`); refuse to start unless the rows exist and match; refuse to resume a run with decisions; exit 78; resume is R10, Wave 3's; after a crash, a NEW run. Archive only: the original defect's file:line cites and the GOV2C-4 correction note. The fill_id/order_id NULL binding is its own residual row (`BOOT1 fill-link severing`).

## RW-16: Closeout blocker `H7`

Old, lines 2466-2487:

~~~old lines=2466-2487
| **H7** | **RATIFIED 2026-09-28 by the user ("Ratify all").** The ratification covers:
  - the Wave 2 handoffs' field format (N6);
  - the four orchestrator root-wiring commits without recorded reviewer sign-off (`5b73461`, `af059d7`, `80126e8`, `da37a0c`);
  - the SER confirming reviews run as Claude reviewers after Codex's content filter refused the packet;
  - `BACKTEST-1`'s one-line touch of the protected root `package.json` (N11);
  - this session's Fable adversarial-reviewer verifiers for container- and spawn-heavy rounds (`BRACKET-1c`, `BUNDLE-1`, `DEPCHECK-1`; the `CI-2` precedent);
  - the orchestrator's `DEPCHECK-1` grant widening (`CI2-L5-2/3`) and its `DOCS-1` authorization.

As recorded before the ruling: Ratification of four process deviations the closeout surfaced: the four handoffs' field format (**recorded here** as a dated deviation with its measured extent and the field-list conflict resolved, `## Deviations` N6 — the ruling on whether the form is sanctioned stays the human's); the lockfile touches (**done here**, N7 — the ten importer-block touches ratified as a pattern, `GATE-1`'s substitution recorded); the four Wave 2 orchestrator root-wiring commits without recorded reviewer sign-off (`5b73461` WP-210, `af059d7` WP-230, `80126e8` WP-240, `da37a0c` WP-250 — each disclosed as an orchestrator step in its row; NOT ratified by this round: outside its packet, and a reviewer-sign-off question is the orchestrator's to answer); the two SER confirming reviews run as Claude reviewers after Codex's content filter refused the packet (disclosed in the `SER-2`/`SER-3` rows and records; NOT ratified by this round — a model-policy decision, not a docs one) | PARTLY DONE | human/orchestrator for the form ruling, the root-wiring sign-off question and the reviewer-model question |

Closed since the audit, so a reader does not re-open them: **B1** cause
(`TRDR-2` `f3da220`), **B2** (`RISK-2` `133eac1`), **B6** and **B7** and
N4 (`GATE-1` `0434c82`), **B8** and N2/N3(features)/N6/N7/N9/N10/G-13
(this round). *(GOV-2C remediation r1, GOV2C-2: this list previously also
named "N5" as closed by `GATE-1`. It is not — `GATE-1` corrected the CI label
to "two of them" and `TRDR-2`, merged forty-five minutes later, made that
wrong again; N5 is in the residual queue below.)*

### Residual queue (owned; recorded here so a reader finds them without opening five handoffs)

| Id | Residual | Evidence | Owner |
| --- | --- | --- | --- |
~~~

New:

~~~new
| `H7` | **Ratified** by the user, 2026-09-28 ("Ratify all"): the N6 field format; four root-wiring commits without recorded reviewer sign-off (`5b73461`, `af059d7`, `80126e8`, `da37a0c`); the SER confirming reviews run by Claude after Codex's content filter refused the packet; N11; the Fable verifiers for container- and spawn-heavy rounds (`BRACKET-1c`, `BUNDLE-1`, `DEPCHECK-1`; the `CI-2` precedent); the `DEPCHECK-1` grant widening (`CI2-L5-2/3`) and the `DOCS-1` authorization. The archived state cell reads "PARTLY DONE"; it predates the ruling. | no open owner: the archived owner (human/orchestrator, for three questions) became historical at ratification |
~~~

Keep (in both texts):

~~~keep
Ratify all
the CI-2 precedent
CI2-L5-2/3
PARTLY DONE
human/orchestrator
~~~

**Facts.** Kept: every ratified item, with the reason for the Claude reviews (Codex's content filter refused the packet) and the `CI-2` precedent. The old owner cell ("human/orchestrator for the form ruling, the root-wiring sign-off question and the reviewer-model question") answered questions the 2026-09-28 ruling settled, so the brief marks it historical instead of repeating it as open work. The old state cell ("PARTLY DONE") predates the ruling; the brief says so. Archive only: the "As recorded before the ruling" paragraph (what GOV-2C did before the ruling).

## RW-17: Closeout blockers `B3`, `B10`, `G-01`, `H5` and the "closed since" list

Old, lines 2459-2459:

~~~old lines=2459-2459
| **B3** | CHECK-4's replay half — *(as found: `apps/backtest-cli/package.json` declared only `polymarket-public`, `simulation`, `storage-parquet`; `coreLoop` was never supplied)* | **NARROWED 2026-09-16 by `BACKTEST-1` (`b462501`)**: the shipped root drives the real paper core to RISK-2's round trip byte-identically over a committed fixture, gated by `test:replay`, WHEN A CALLER SUPPLIES THE CORE; the executable cannot construct it because `createPaperTrader`/`CoreLoop` live in `apps/trader` and §2/F10/F13 forbid an app depending on an app (proven). What remains is a governance decision: move the composition below layer 3, or rule a cited §2.1 exception *(**H8 RULED 2026-09-28 by the user: option A**, extracting the core into a layer-1 package, queued as the H8 track `H8-GOV` → `CORE-MOVE` → `BACKTEST-2`. **Interim state, option C's wording, per the same ruling:** §7 item 4's replay half is MET WITH QUALIFICATION. Static Bracket runs in deterministic replay through the same core code as the paper trader (`createPaperTrader` + `CoreLoop`, driven by the shipped `runBacktest` + `replayDrivenCoreLoop`), byte-identical across two processes, gated by `test:replay` over a committed synthetic Tier-0 fixture. The qualification: the core is assembled by the test harness, not by the backtest executable; the harness's venue wiring is a copy of main.ts's; and no operator-runnable Static Bracket backtest exists. **B3 is ACCEPTED AS QUALIFIED (interim), not CLOSED.** It closes when `BACKTEST-2` lands.)* *(**B3 CLOSED 2026-09-28 by `BACKTEST-2`** (merged `fd12be0`), completing the H8 track: `H8-GOV` `bb58edb` → `DEPCHECK-1` `d7f2906` → `CORE-MOVE` `33b7d0b` → `BACKTEST-2` `fd12be0`. The backtest executable builds the same `createPaperTrader`/`CoreLoop` the trader builds, from `@polymarket-bot/trading-core` (layer 1). Its built bundle reproduces the replay golden byte for byte, and one venue builder serves every root. The interim "accepted as qualified" wording is superseded. §7 item 4's replay half is for the fresh closeout to grade.)* | orchestrator/human (**H8** RULED 2026-09-28; the H8 track) — **CLOSED** |
~~~

Old, lines 2460-2460:

~~~old lines=2460-2460
| **B10** | **A live-data paper run cannot leave `PENDING`.** `MarketOpened`/`MarketClosing` have NO producer anywhere in the repository (found by `BACKTEST-1`, verified by its reviewer: every hit under `apps/*/src`, `packages/*/src`, `packages/strategies/*/src` is a consumer or a comment; `apps/data-gateway/src/feeds/polymarket.ts:71-79`'s `MARKET_DATA_EVENT_TYPES` is `{BookSnapshot, BookLevelChanged, BestBidAskChanged, PublicTradeObserved, TradingParametersChanged, MarketDiscovered, MarketResolved}`; `apps/trader/src/loop.ts:576-600` has no case for `MarketDiscovered`; `pipeline.ts:337-347` maps `PENDING → UNKNOWN` and §9.8 fails closed on UNKNOWN). Every recorded run reaches OPEN only through a fixture's hand-written `MarketOpened`. So H1 is not attemptable until something produces the lifecycle events from the venue's own market facts — a code work package for the gateway/universe owner, sequenced after `VENUE-2` (which re-verifies the per-market parameters and the market-by-id surface those facts come from) | **CLOSED 2026-09-17 by `UNIV-4` (`7c08af7`)** — the gateway produces both events from the venue's documented polled market state for configured markets, with publication (not dispatch) sealing each event in a write-ahead ledger; the trader opened a market from a venue-shaped response for the first time (part (c), real Redis). What a poll cannot tell an operator is disclosed (UNIV4-R1, R5) | `UNIV-4` ✓ |
~~~

Old, lines 2464-2464:

~~~old lines=2464-2464
| **G-01** | The handoff §1.2 twelve-item venue phase gate was never run for phase-2: the only full report is `docs/venue/verified-2026-08-24.md` (phase-0); `verified-2026-09-02.md` §7 item 3 records the full re-verification as owed "at the next phase gate" | **CLOSED 2026-09-17 by `VENUE-2` (`d6aedee`)** — `docs/venue/verified-2026-09-16.md`, the full twelve-item phase-2 re-verification, documentary, with the 2026-09-02 §7 item 3 debt discharged explicitly. What it surfaced is owned: D-15 (C-2 reopen), D-30 (B10's basis), D-13/D-17/D-02/D-20 in the row above | `VENUE-2` ✓ |
~~~

Old, lines 2465-2465:

~~~old lines=2465-2465
| **H5** | The runbook:509-vs-514 ordering tension — whether one demonstrated live-data run discharges :509 or sustained accumulation is the post-closeout activity :514 describes | **RULED 2026-09-28 by the user: one demonstrated run.** One supervised live-data paper session through the real stack (gateway → Redis → trader → PostgreSQL) that produces decisions and reads back clean discharges :509. Sustained accumulation is the post-closeout activity :514 describes | human — **RULED** |
~~~

Old, lines 2476-2482:

~~~old lines=2476-2482
Closed since the audit, so a reader does not re-open them: **B1** cause
(`TRDR-2` `f3da220`), **B2** (`RISK-2` `133eac1`), **B6** and **B7** and
N4 (`GATE-1` `0434c82`), **B8** and N2/N3(features)/N6/N7/N9/N10/G-13
(this round). *(GOV-2C remediation r1, GOV2C-2: this list previously also
named "N5" as closed by `GATE-1`. It is not — `GATE-1` corrected the CI label
to "two of them" and `TRDR-2`, merged forty-five minutes later, made that
wrong again; N5 is in the residual queue below.)*
~~~

New:

~~~new
Closed: `B3` (`BACKTEST-2` `fd12be0`, 2026-09-28), `B10` (`UNIV-4` `7c08af7`),
`G-01` (`VENUE-2` `d6aedee`), `H5` (ruled 2026-09-28: one demonstrated run).
Closed earlier: `B1`'s cause (`TRDR-2` `f3da220`), `B2` (`RISK-2` `133eac1`),
`B6`, `B7` and N4 (`GATE-1` `0434c82`), `B8` with N2 (the contract correction;
the `N2` measurement is open), N3 (features), N6, N7, N9, N10 and G-13
(`GOV-2C`). N5 closed later (`CI-1`).
~~~

**Facts.** All closed or ruled; the brief keeps the id, the closing package and SHA. Archive only: B3's narrowing history and interim "accepted as qualified" wording, B10's defect detail, G-01's source list, and the GOV2C-2 correction note about N5. G-01's surfaced items: D-15 and D-20 are under Pending external evidence, D-13, D-17 and D-02 under Venue drift carried forward (RW-11), D-30 is B10's closed basis. H5's ruling text is under Human items. `B8`'s SHA is in the table (`GOV-2C` `33c36f9`).

## RW-18: Residual queue: heading and table header

Old, lines 2484-2487:

~~~old lines=2484-2487
### Residual queue (owned; recorded here so a reader finds them without opening five handoffs)

| Id | Residual | Evidence | Owner |
| --- | --- | --- | --- |
~~~

New:

~~~new
### Residual queue
Open rows only, one line each. An owner beginning "row:" is quoted from the
archived row and may be stale; the cell says why. File:line citations are as of
`f43efe6`.
| Id | Residual | Owner |
~~~

**Facts.** The heading's parenthetical is dropped. The Evidence column is dropped: each archived row keeps it. New: the "row:" owner convention and the rule that file:line cites are as of `f43efe6`.

## RW-19: Residual `H1R1-FRAME-ATOMICITY`

Old, lines 2607-2607:

~~~old lines=2607-2607
| **H1R1-FRAME-ATOMICITY** | Every venue market-channel frame in the H1 burst produced exactly TWO `BookLevelChanged` events, one per token of the pair (85,547 events from 42,774 frames), and the trader evaluates after EACH. So half of all evaluations see a half-applied frame, a book state that never existed at the venue. Evaluating once per frame (per `causationId`) would be truer and halve the work, but it changes "one decision per event" (WP-170's exactly-one-decision criteria) | `docs/handoffs/H1-RUN-1.md` finding 2 | **RULED 2026-09-30** (the user): `THROUGHPUT-2` evaluates once per frame |
~~~

New:

~~~new
| `H1R1-FRAME-ATOMICITY` | In the H1 burst every venue market-channel frame produced exactly two `BookLevelChanged` events, one per token of the pair (85,547 events from 42,774 frames). The trader evaluates after each, so half the evaluations see a half-applied frame, a book state that never existed at the venue. Evaluating once per frame (per `causationId`) is truer and halves the work, but changes WP-170's exactly-one-decision-per-event criteria. Ruled by the user 2026-09-30. | `THROUGHPUT-2` (evaluate once per frame) |
~~~

Keep (in both texts):

~~~keep
85,547 events from 42,774 frames
a book state that never existed at the venue
per causationId
~~~

**Facts.** Kept: two events per frame, one per token; 85,547 events from 42,774 frames; the half-applied book; once per `causationId`; the WP-170 criterion it changes; the 2026-09-30 ruling. Archive only: the evidence cite (`H1-RUN-1.md` finding 2). Carried as open because the ruled fix is in flight in `THROUGHPUT-2`.

## RW-20: Residual `OUT1-R1-HALT-NOT-DURABLE`

Old, lines 2611-2611:

~~~old lines=2611-2611
| **OUT1-R1-HALT-NOT-DURABLE** | A halt, including OUTAGE-1's `TRANSPORT_UNAVAILABLE`, is not persisted to PostgreSQL. `TraderStore` has no halt write, and no repository or trader code writes `ops.incidents`/`ops.risk_events`. The durable record of an outage is only its consequence (no writes after the halt instant), plus the process log and the exit code | `docs/handoffs/OUTAGE-1.md` (Fable r1 MEDIUM) | a trader/storage round that adds a durable halt record (`ops.incidents`), before sustained live-data paper runs. **Note (OUTAGE-2 reviewer, `OUT2-R1-HALT-RECORD-INTERACTION`):** the outage tests' commit-order check requires that NO row commits after the pre-fault snapshot. The round that adds the durable halt record must update the three outage scenarios to expect exactly that one halt row, and nothing else. |
~~~

New:

~~~new
| `OUT1-R1-HALT-NOT-DURABLE` | A halt, including `OUTAGE-1`'s `TRANSPORT_UNAVAILABLE`, is not persisted to PostgreSQL: `TraderStore` has no halt write, and nothing writes `ops.incidents` or `ops.risk_events`. The durable record of an outage is only its consequence (no writes after the halt instant), plus the process log and the exit code. `OUT2-R1-HALT-RECORD-INTERACTION`: the outage tests require that no row commits after the pre-fault snapshot, so the round that adds the halt record must update the three outage scenarios to expect exactly that one halt row, and nothing else. | a trader/storage round that adds a durable halt record (`ops.incidents`), before sustained live-data paper runs |
~~~

Keep (in both texts):

~~~keep
TraderStore has no halt write
plus the process log and the exit code
expect exactly that one halt row, and nothing else
before sustained live-data paper runs
~~~

**Facts.** Kept: nothing persists a halt; `TraderStore` has no halt write; `ops.incidents`/`ops.risk_events` unwritten; the durable record is only the consequence, the process log and the exit code; the `OUT2-R1-HALT-RECORD-INTERACTION` note in full, with "exactly that one halt row, and nothing else"; the owner with "before sustained live-data paper runs". Archive only: the evidence cite (OUTAGE-1 Fable r1 MEDIUM).

## RW-21: Residual `H1R1-PROVENANCE`

Old, lines 2608-2608:

~~~old lines=2608-2608
| **H1R1-PROVENANCE** | On all 37,546 H1 decisions, `strategy.decisions.gateway_epoch`, `ingest_seq` and `feature_snapshot_id` are NULL (`source_event_id` is filled). A decision cannot be traced to its gateway epoch or ingest sequence, or to an indexed feature snapshot, without joining through the event id | `docs/handoffs/H1-RUN-1.md` finding 7 | a trader/storage round (with `OUT1-R1-HALT-NOT-DURABLE`) |
~~~

New:

~~~new
| `H1R1-PROVENANCE` | On all 37,546 H1 decisions, `strategy.decisions.gateway_epoch`, `ingest_seq` and `feature_snapshot_id` are NULL (`source_event_id` is set). A decision cannot be traced to its gateway epoch, its ingest sequence or an indexed feature snapshot except by joining through the event id. | a trader/storage round (with `OUT1-R1-HALT-NOT-DURABLE`) |
~~~

Keep (in both texts):

~~~keep
joining through the event id
On all 37,546 H1 decisions
~~~

**Facts.** Kept: the three NULL columns on all 37,546 decisions, `source_event_id` set, and the consequence (no trace to epoch, ingest sequence or feature snapshot without joining through the event id). Archive only: the evidence cite (finding 7).

## RW-22: Residual `H1R1-HALT-INVISIBLE`

Old, lines 2609-2609:

~~~old lines=2609-2609
| **H1R1-HALT-INVISIBLE** | A halt that exits the process quickly never reaches Prometheus: the trader exited 75 between two 15 s scrapes, so the dashboards read `halts 0, healthy 1` until "health unavailable". Same root as `OUT1-R1-HALT-NOT-DURABLE`: no durable halt record for the control API to read | `docs/handoffs/H1-RUN-1.md` finding 6 | with `OUT1-R1-HALT-NOT-DURABLE` |
~~~

New:

~~~new
| `H1R1-HALT-INVISIBLE` | A halt that exits the process quickly never reaches Prometheus. In H1 the trader exited 75 between two 15 s scrapes, so the dashboards read `halts 0, healthy 1` until "health unavailable". Same root as `OUT1-R1-HALT-NOT-DURABLE`: there is no durable halt record for the control API to read. | with `OUT1-R1-HALT-NOT-DURABLE` |
~~~

Keep (in both texts):

~~~keep
between two 15 s scrapes
no durable halt record for the control API to read
~~~

**Facts.** Kept: exit 75 between two 15 s scrapes; the dashboards' `halts 0, healthy 1` until "health unavailable"; the shared root and its cause (no durable halt record for the control API). Archive only: the evidence cite (finding 6).

## RW-23: Residual `TRADER-SIGNALS`

Old, lines 2606-2606:

~~~old lines=2606-2606
| **TRADER-SIGNALS** | The trader installs no SIGINT/SIGTERM handler; `main.ts`'s header mentions "the signal handlers", which do not exist. Ending a run with Ctrl-C kills the process: durable writes are already committed per event, but the FOLD-1 SHUTDOWN rebuild check and the orderly close never run. A graceful stop (stop the pump, run the SHUTDOWN check, close, exit 0) would put the shutdown check into H1's evidence | orchestrator, while writing the H1 operator checklist (`apps/trader/src/main.ts` :733-744) | offered to the user as an optional small round before H1 |
~~~

New:

~~~new
| `TRADER-SIGNALS` | The trader installs no SIGINT/SIGTERM handler, although `main.ts`'s header mentions "the signal handlers". Ctrl-C kills the process. Durable writes are already committed per event, but the `FOLD-1` SHUTDOWN rebuild check and the orderly close never run. A graceful stop (stop the pump, run the SHUTDOWN check, close, exit 0) would add the shutdown check to H1's evidence. | offered to the user as an optional small round before H1 |
~~~

Keep (in both texts):

~~~keep
stop the pump, run the SHUTDOWN check, close, exit 0
The trader installs no SIGINT/SIGTERM handler
~~~

**Facts.** Kept: no handler; the false `main.ts` header; what Ctrl-C skips; that durable writes are already committed; the proposed graceful stop ending in exit 0 and its value for H1's evidence; the owner. Archive only: the source (`main.ts` :733-744, found while writing the H1 checklist).

## RW-24: Residual `LOOPMEM-FOLD`

Old, lines 2506-2506:

~~~old lines=2506-2506
| **LOOPMEM-FOLD** | **CPU half CLOSED by `FOLD-1`** (merged `2c0bd21`, 2026-09-27): the ledger view is flat per fill and PnL is linear per fill. Remaining: `FOLD-2` (constant-cost PnL step) and memory bounding (Option 4, behind `RECON2-DURABLE` and an ADR-006 amendment) |
~~~

Old, lines 2531-2534:

~~~old lines=2531-2534
  - `projectLedger` re-folds the ENTIRE in-memory ledger on every evaluation, intent and fill (`packages/ledger/src/projections.ts:432-438`; `loop.ts:882`, `1043`, `1239`, `1419`);
  - `#pnlRecords` is re-folded from zero on every fill (`loop.ts:306-314`, `1541-1551`);
  - the Ledger store is append-only and unbounded.
Over days this could slow each event enough to fill the §8.3 ingest queue, which halts. Replacing folds-from-zero with snapshot + tail must stay byte-identical (§6 invariant 8, §12.4) | `TRDR-4` scoping | an ADR-level ruling, then a ledger/PnL round |
~~~

New:

~~~new
| `LOOPMEM-FOLD` | CPU half closed by `FOLD-1` (`2c0bd21`): the ledger view is flat per fill and PnL is linear per fill. Remaining: `FOLD-2`, and memory bounding (Option 4, behind `RECON2-DURABLE` and an ADR-006 amendment): the Ledger store is append-only and unbounded. Over days this could slow each event enough to fill the §8.3 ingest queue, which halts. Replacing folds-from-zero with snapshot + tail must stay byte-identical (§6 invariant 8, §12.4). | row: an ADR-level ruling, then a ledger/PnL round (written before `FOLD-1` closed the CPU half) |
~~~

Keep (in both texts):

~~~keep
the Ledger store is append-only and unbounded
must stay byte-identical
an ADR-level ruling, then a ledger/PnL round
~~~

**Facts.** The old row is split in the base file: line 2506, and the four orphaned lines 2531-2534 after the `FOLD1-SLOWTEST` row (the original description and owner). Kept: the CPU half closed by `FOLD-1` (`2c0bd21`) with what it did; `FOLD-2` and Option 4 remaining; the unbounded Ledger store; the §8.3 ingest-queue risk; the byte-identical snapshot + tail requirement (§6 invariant 8, §12.4); the owner from line 2534, marked "row:" because it predates `FOLD-1`. Archive only: lines 2531-2532, the two re-folds `FOLD-1` removed.

## RW-25: Residual `FOLD-2`

Old, lines 2523-2526:

~~~old lines=2523-2526
| **FOLD-2** | LOOPMEM-FOLD Option 3, QUEUED by the user (2026-09-27). Change internal representations only, keeping serialized bytes (`pnl-state/v3`, `ledger-projection/v3`), Map insertion order and the public no-mutation guarantees:
  - `packages/pnl`: make one record's update constant-cost by moving the ever-growing ref and trade logs onto an append-only store with a watermark;
  - `packages/ledger`: optionally make a from-zero rebuild fold into mutable maps and freeze once.
It makes a runtime PnL rebuild check affordable (about 6 s instead of about 890 s at 100k records, ESTIMATED, not prototyped — measure first) | `FOLD-1` scoping (`wf_b527845c-ad5`) | when backtests with thousands of fills per instance, or a cheap runtime PnL check, justify it; needs a `packages/pnl` (and optionally `packages/ledger`) grant |
~~~

New:

~~~new
| `FOLD-2` | LOOPMEM-FOLD Option 3, queued by the user 2026-09-27; runs after `BACKTEST-2` (user, 2026-09-28). It changes internal representations only; serialized bytes (`pnl-state/v3`, `ledger-projection/v3`), Map insertion order and the public no-mutation guarantees stay. `packages/pnl`: one record's update becomes constant-cost (the ever-growing ref and trade logs move to an append-only store with a watermark). `packages/ledger`, optionally: a from-zero rebuild folds into mutable maps and freezes once. A runtime PnL rebuild check becomes affordable: about 6 s instead of about 890 s at 100k records (estimated, not prototyped; measure first). | when backtests with thousands of fills per instance, or a cheap runtime PnL check, justify it; needs a `packages/pnl` (and optionally `packages/ledger`) grant |
~~~

Keep (in both texts):

~~~keep
pnl-state/v3
append-only store with a watermark
freeze
thousands of fills per instance
(and optionally packages/ledger)
measure first
~~~

**Facts.** Kept: queued 2026-09-27; after `BACKTEST-2` (from the H8 rulings); the format versions `pnl-state/v3` and `ledger-projection/v3`; Map order and no-mutation guarantees; the `packages/pnl` append-only store with a watermark; the optional `packages/ledger` change; the estimate with "not prototyped; measure first"; the owner's trigger ("thousands of fills per instance", "cheap") and the optional `packages/ledger` grant. Archive only: the scoping workflow id.

## RW-26: Residual `FOLD-RELATCH`

Old, lines 2527-2527:

~~~old lines=2527-2527
| **FOLD-RELATCH** | LATENT: a released MARKET `UNATTRIBUTED_ACTIVITY` halt is re-latched by the NEXT fill in ANY market, because `haltOnLedgerProjection` re-reads the whole unattributed history. REPRODUCED by calling `release` directly. Unreachable today: nothing in production calls the trader's `HaltController.release` (control-plane.ts says so) | `FOLD-1` scoping | the round that wires a halt-release seam into a running trader |
~~~

New:

~~~new
| `FOLD-RELATCH` | Latent: a released MARKET `UNATTRIBUTED_ACTIVITY` halt is re-latched by the next fill in any market, because `haltOnLedgerProjection` re-reads the whole unattributed history (reproduced by calling `release` directly). Unreachable today: nothing in production calls the trader's `HaltController.release`. | the round that wires a halt-release seam into a running trader |
~~~

Keep (in both texts):

~~~keep
re-reads the whole unattributed history
nothing in production calls
into a running trader
~~~

**Facts.** Kept: latent; re-latch by the next fill in any market; the cause (`haltOnLedgerProjection` re-reads the whole unattributed history); reproduced via `release`; unreachable because nothing in production calls `HaltController.release`; the owner "into a running trader". Archive only: the `control-plane.ts` remark.

## RW-27: Residual `FOLD-PNL2TOKEN`

Old, lines 2528-2528:

~~~old lines=2528-2528
| **FOLD-PNL2TOKEN** | A silent PnL gap: when an instance holds BOTH tokens of a market, only the filled token is marked (`loop.ts` about :2607-2612) | `FOLD-1` scoping | a PnL correctness round (unreachable with a single-token Static Bracket) |
~~~

New:

~~~new
| `FOLD-PNL2TOKEN` | A silent PnL gap: when an instance holds both tokens of a market, only the filled token is marked (`loop.ts` about :2607-2612). | a PnL correctness round (unreachable with a single-token Static Bracket) |
~~~

Keep (in both texts):

~~~keep
only the filled token is marked
unreachable with a single-token Static Bracket
~~~

**Facts.** Kept verbatim in substance, including the approximate `loop.ts` cite and the single-token unreachability in the owner cell. Archive only: the evidence cite (FOLD-1 scoping).

## RW-28: Residual `FOLD-OVERSELL`

Old, lines 2529-2529:

~~~old lines=2529-2529
| **FOLD-OVERSELL** | After a restart (a new run with an empty in-memory ledger), a SELL of shares bought in the previous run would be an oversell in the PnL fold (`PNL_OVERSELL`). This is tied to restart semantics and `RECON2-DURABLE` | `FOLD-1` scoping | the restart/resume design (with `RECON2-DURABLE`) |
~~~

New:

~~~new
| `FOLD-OVERSELL` | After a restart (a new run with an empty in-memory ledger), a SELL of shares bought in the previous run is an oversell in the PnL fold (`PNL_OVERSELL`). It is tied to restart semantics and `RECON2-DURABLE`. | the restart/resume design (with `RECON2-DURABLE`) |
~~~

Keep (in both texts):

~~~keep
empty in-memory ledger
oversell in the PnL fold
~~~

**Facts.** Kept: a restart is a new run with an empty in-memory ledger; the SELL is an oversell in the PnL fold (`PNL_OVERSELL`); tied to restart semantics and `RECON2-DURABLE`; the owner. Archive only: the evidence cite.

## RW-29: Residual `FOLD1-SLOWTEST`

Old, lines 2530-2530:

~~~old lines=2530-2530
| **FOLD1-SLOWTEST** | `apps/trader/src/loop-folds.test.ts`'s 1,000-fill held==rebuilt pin runs a FULL ledger rebuild after every fill, which is quadratic by design: about 68 s locally. It took the CI unit step from about 102 s to 187 s. It yields after every step, so the CI-1 RPC timeout cannot fire, but it is the slowest file by far | `docs/handoffs/FOLD-1.md` | the next round granted `apps/trader/src/**`: keep the property with far less work (every-fill checks for the first ~200 fills, then every 10th; or 1,000 fills with checks sampled) |
~~~

New:

~~~new
| `FOLD1-SLOWTEST` | `apps/trader/src/loop-folds.test.ts`'s 1,000-fill held==rebuilt pin runs a full ledger rebuild after every fill: quadratic by design, about 68 s locally. It took the CI unit step from about 102 s to 187 s. It yields after every step, so the CI-1 RPC timeout cannot fire, but it is by far the slowest file. | the next round granted `apps/trader/src/**`: keep the property with far less work (check every fill for the first ~200 fills, then every 10th; or 1,000 fills with sampled checks) |
~~~

Keep (in both texts):

~~~keep
quadratic by design
yields after every step, so the CI-1 RPC timeout cannot fire
every 10th
~~~

**Facts.** Only line 2530 is this row; lines 2531-2534 belong to `LOOPMEM-FOLD`. Kept: the full rebuild per fill, quadratic by design; about 68 s; 102 s to 187 s; the yield that keeps the CI-1 RPC timeout from firing; the owner with both sampling remedies (the first ~200 then every 10th; or 1,000 with sampled checks). Archive only: the evidence cite.

## RW-30: Residual `RECON2-DURABLE`

Old, lines 2535-2535:

~~~old lines=2535-2535
| **RECON2-DURABLE** | Unfilled-order provenance lives only in process memory. The durable-store port (`apps/trader/src/ports.ts`) persists decisions, checkpoints, ledger transactions and PnL snapshots, but no trace, plan or order provenance, so after a restart a cancelled unfilled order's link to its intent is gone: a §6 invariant 4 traceability gap for orders that never filled *(`TRDR-4`, 2026-09-27: the in-memory traces are now a bounded 50k window. Evictions are counted in `seams.retention`, not persisted, so persisting before eviction is the real fix.)* | `docs/handoffs/RECON-2.md` observations | a governance ruling (does §6 require it?) and then a storage round |
~~~

New:

~~~new
| `RECON2-DURABLE` | Unfilled-order provenance lives only in process memory. The durable-store port (`apps/trader/src/ports.ts`) persists decisions, checkpoints, ledger transactions and PnL snapshots, but no trace, plan or order provenance. After a restart, a cancelled unfilled order's link to its intent is gone: a §6 invariant 4 traceability gap for orders that never filled. Since `TRDR-4` the in-memory traces are a bounded 50k window; evictions are counted in `seams.retention`, not persisted, so persisting before eviction is the real fix. | a governance ruling (does §6 require it?), then a storage round |
~~~

Keep (in both texts):

~~~keep
persists decisions, checkpoints, ledger transactions and PnL snapshots
persisting before eviction is the real fix
does §6 require it?
~~~

**Facts.** Kept: memory-only provenance; what the durable-store port persists and what it does not; the §6 invariant 4 gap for orders that never filled; the bounded 50k window since `TRDR-4`; evictions counted in `seams.retention`, not persisted; persisting before eviction as the real fix; the governance question "does §6 require it?". Archive only: the evidence cite.

## RW-31: Residual `TRDR4-LIVESETTLE`

Old, lines 2507-2510:

~~~old lines=2507-2510
| **TRDR4-LIVESETTLE** | A LIVE-ADAPTER obligation, out of PAPER scope. `TRDR-4` settles an order when it is terminal and its booked shares equal its filled shares. At a real venue trades settle asynchronously (MATCHED → MINED → CONFIRMED, or RETRYING → FAILED; `docs/venue/verified-2026-09-16.md`). Before a live adapter exists:
  - settlement must also require every trade of the order to be CONFIRMED or FAILED, and a §9.17 reconciliation to have passed;
  - the adapter must surface the orders a refused plan left behind (in `ordersSnapshot()` or in the refused result), carrying `plannedOrderId`.
The loud path already covers a late fill in the meantime | `docs/handoffs/TRDR-4.md` | the live-adapter work package |
~~~

New:

~~~new
| `TRDR4-LIVESETTLE` | A live-adapter obligation, outside PAPER. `TRDR-4` settles an order when it is terminal and its booked shares equal its filled shares. At a real venue, trades settle asynchronously (MATCHED → MINED → CONFIRMED, or RETRYING → FAILED; `verified-2026-09-16.md`). Before a live adapter exists: settlement must also require every trade of the order to be CONFIRMED or FAILED, and a §9.17 reconciliation to have passed; and the adapter must surface the orders a refused plan left behind (in `ordersSnapshot()` or in the refused result), carrying `plannedOrderId`. Meanwhile the loud path covers a late fill. | the live-adapter work package |
~~~

Keep (in both texts):

~~~keep
its booked shares equal its filled shares
MATCHED → MINED → CONFIRMED, or RETRYING → FAILED
a §9.17 reconciliation to have passed
carrying plannedOrderId
~~~

**Facts.** Kept: outside PAPER; the existing settlement conditions (terminal, booked shares equal filled shares); the asynchronous states; both added conditions (every trade CONFIRMED or FAILED, and a passed §9.17 reconciliation), stated as additions; surfacing left-behind orders in `ordersSnapshot()` or the refused result with `plannedOrderId`; the loud path for late fills. Archive only: the evidence cite.

## RW-32: Residual `TRDR4-ORPHAN`

Old, lines 2511-2511:

~~~old lines=2511-2511
| **TRDR4-ORPHAN** | An order that a partly refused plan left resting is ownerless. It keeps its reservation, allocator and time-in-force entries until it goes terminal, and its market is halted (`UNATTRIBUTED_ACTIVITY`). That is the fail-closed direction, but clearing it is manual operator reconciliation. The Incident Controller (§9.9) could offer a SAFETY_CANCEL of the held orders (§6 invariant 13); that is a design addition *(`SIM-1`, 2026-09-27: the simulator now reports partial execution per order, so the trader OWNS what was booked. This halt is now DEFENSIVE only — reachable only by a venue that refuses while holding unlisted orders, a future live adapter — and is pinned through a double.)* | `docs/handoffs/TRDR-4.md` | an operator-tooling round, or moot once `LOOPMEM-SIM` makes the venue report partial execution |
~~~

New:

~~~new
| `TRDR4-ORPHAN` | An order left resting by a partly refused plan is ownerless. It keeps its reservation, allocator and time-in-force entries until it goes terminal, and its market halts (`UNATTRIBUTED_ACTIVITY`): fail-closed, but clearing it is manual operator reconciliation. The Incident Controller (§9.9) could offer a SAFETY_CANCEL of the held orders (§6 invariant 13), a design addition. Since `SIM-1` the simulator reports partial execution per order, so this halt is defensive only: reachable only by a venue that refuses while holding unlisted orders (a future live adapter); pinned through a double. | row: an operator-tooling round, or moot once `LOOPMEM-SIM` makes the venue report partial execution (`SIM-1` did so for the simulator; a live adapter still could reach it) |
~~~

Keep (in both texts):

~~~keep
reservation, allocator and time-in-force entries
SAFETY_CANCEL
refuses while holding unlisted orders
moot once LOOPMEM-SIM makes the venue report partial execution
~~~

**Facts.** Kept: ownerless order; reservation, allocator and time-in-force entries held until terminal; the market halt; manual reconciliation; the optional SAFETY_CANCEL design (§9.9, §6 invariant 13); `SIM-1`'s change to defensive-only with the exact reachability condition; the double pin. The owner is quoted as "row:" with the `LOOPMEM-SIM` mootness condition, plus a note that `SIM-1` met it for the simulator only.

## RW-33: Residual `TRDR4-GAUGES`

Old, lines 2512-2512:

~~~old lines=2512-2512
| **TRDR4-GAUGES** | `packages/observability` does not export the new `seams.orders` / `seams.retention` counters as gauges. Evictions, unowned fills and settle mismatches are visible on `/health` only *(`SIM-2`, 2026-09-27: also the venue's `retention()` counters, including `awaitingAcknowledgment` and `evictedIds.refused`.)* | `docs/handoffs/TRDR-4.md` | the next observability round (additions only) |
~~~

New:

~~~new
| `TRDR4-GAUGES` | `packages/observability` does not export as gauges the `seams.orders`/`seams.retention` counters, or the venue's `retention()` counters (including `awaitingAcknowledgment` and `evictedIds.refused`). Evictions, unowned fills and settle mismatches are visible on `/health` only. | the next observability round (additions only) |
~~~

Keep (in both texts):

~~~keep
awaitingAcknowledgment
Evictions, unowned fills and settle mismatches are visible on /health only
~~~

**Facts.** Kept: which counters are not exported as gauges, including the venue's `retention()` counters `awaitingAcknowledgment` and `evictedIds.refused`; the three named signals visible on `/health` only; the owner. Archive only: the evidence cite.

## RW-34: Residual `TRDR4-CITES`

Old, lines 2513-2513:

~~~old lines=2513-2513
| **TRDR4-CITES** | `test/unit/control-api/response-encoder-bound.test.ts` cites `health-door.ts:181` and `:77`, which are now `:242` and `:82` (`:181` had already drifted at base). The claim itself still holds | `docs/handoffs/TRDR-4.md` | the next round touching `test/unit/control-api/**` (documentation only) |
~~~

New:

~~~new
| `TRDR4-CITES` | `test/unit/control-api/response-encoder-bound.test.ts` cites `health-door.ts:181` and `:77`, now `:242` and `:82`. The claim itself still holds. | the next round touching `test/unit/control-api/**` (documentation only) |
~~~

Keep (in both texts):

~~~keep
response-encoder-bound.test.ts
(documentation only)
~~~

**Facts.** Kept: the test file, both drifted cites and their current lines, that the claim holds, and the documentation-only owner. Archive only: "(`:181` had already drifted at base)".

## RW-35: Residual `RISK2-R1`

Old, lines 2491-2491:

~~~old lines=2491-2491
| **RISK2-R1** | `apps/trader/src/pipeline.ts:99-103`'s RULE stands (the composition root may not re-derive disposition from tags) but its premise sentence "`packages/risk` decides disposition from the intent TYPE" is superseded | `docs/handoffs/RISK-2.md` residual 3 | `BOOT-1` (same grant extension) |
~~~

New:

~~~new
| `RISK2-R1` | `apps/trader/src/pipeline.ts:99-103`'s rule stands (the composition root may not re-derive disposition from tags), but its premise ("`packages/risk` decides disposition from the intent TYPE") is superseded. | row: `BOOT-1` (merged `0d09eb5`; the row was never marked closed) |
~~~

Keep (in both texts):

~~~keep
the composition root may not re-derive disposition from tags
decides disposition from the intent TYPE
~~~

**Facts.** Kept: the rule (no re-derivation of disposition from tags) and the superseded premise. The owner is `BOOT-1` ("same grant extension"), which merged (`0d09eb5`), but the row was never marked closed; the brief says so and does not resolve it.

## RW-36: Residual `TRDR2-R8`

Old, lines 2538-2538:

~~~old lines=2538-2538
| **TRDR2-R8** | A parenthesized type alias (`type X = (never); value as X`) evades the trader cast census, `eslint` AND `tsc` — `resolveTypeText` does not strip parentheses; one-line fix plus a self-test | `docs/handoffs/TRDR-2.md` residual 2 | the next round touching `test/unit/trader/**` |
~~~

New:

~~~new
| `TRDR2-R8` | A parenthesized type alias (`type X = (never); value as X`) evades the trader cast census, eslint and tsc, because `resolveTypeText` does not strip parentheses. One-line fix plus a self-test. | the next round touching `test/unit/trader/**` |
~~~

Keep (in both texts):

~~~keep
resolveTypeText does not strip parentheses
one-line fix plus a self-test
~~~

**Facts.** Kept: the parenthesized alias, the three tools it evades, the cause (`resolveTypeText` does not strip parentheses), the one-line fix plus a self-test, the owner. Archive only: the evidence cite.

## RW-37: Residual `TRDR2 residual 7`

Old, lines 2540-2540:

~~~old lines=2540-2540
| **TRDR2 residual 7** | `persistDecision`, `saveCheckpoint` and `appendLedgerTransaction` remain typecheck-pinned with no round trip of their own — `GOV-2B` R8 (real-infrastructure integration for the trader's adapters) is HALF discharged: `TRDR-2` round-tripped `writePnlSnapshot` only. Plus `TRDR2-R9` (a sentence claiming "nothing else in the app writes SQL at all" while `appendLedgerTransaction` does, through WP-040's ledger repository) and `TRDR2-R10` (eleven paper-trader harness aliases with no importer), both INFO | `docs/handoffs/TRDR-2.md` residual 7 | `BOOT-1`'s acceptance (a decision AND a fill end to end with every durable write landing) covers the first two round trips if it lands as specified; `appendLedgerTransaction` and the two INFOs to the next `apps/trader` round |
~~~

New:

~~~new
| `TRDR2 residual 7` | `persistDecision`, `saveCheckpoint` and `appendLedgerTransaction` are typecheck-pinned with no round trip of their own. `GOV-2B` R8 (real-infrastructure integration for the trader's adapters) is half discharged: `TRDR-2` round-tripped `writePnlSnapshot` only. INFOs: `TRDR2-R9`, a sentence claiming "nothing else in the app writes SQL at all" while `appendLedgerTransaction` does (through WP-040's ledger repository); `TRDR2-R10`, eleven paper-trader harness aliases with no importer. | row: `BOOT-1`'s acceptance (a decision AND a fill end to end with every durable write landing) covers the first two round trips if it lands as specified; `appendLedgerTransaction` and the two INFOs go to the next `apps/trader` round. (`BOOT-1` merged; the row was not updated.) |
~~~

Keep (in both texts):

~~~keep
if it lands as specified
a decision AND a fill end to end with every durable write landing
nothing else in the app writes SQL at all
eleven paper-trader harness aliases
~~~

**Facts.** Kept: the three typecheck-pinned writes; `GOV-2B` R8 half discharged, with what R8 is and what `TRDR-2` round-tripped; both INFOs with their content; the owner in full, including BOOT-1's acceptance clause and "if it lands as specified". `BOOT-1` merged, but the row was not updated; the brief says so and does not resolve it.

## RW-38: Residual `BOOT1-R6`

Old, lines 2561-2561:

~~~old lines=2561-2561
| **BOOT1-R6 (out of BOOT-1's grant)** | `health.loop.decisionsPersisted` counts OUTBOX APPENDS (`loop.ts:925/929`), incremented before `#flushOutbox` (`loop.ts:1660`) attempts the write — the BOOT-1 reviewer read it at **1 with zero rows persisted**, twice; it ships as `trader_decisions_persisted_total` (`packages/observability/src/control/samples.ts:107`). A §6 invariant 3 counter that reports a rejected decision as persisted | the BOOT-1 review | the next `loop.ts` round (count on `written.ok`, or rename) |
~~~

New:

~~~new
| `BOOT1-R6` | `health.loop.decisionsPersisted` counts outbox appends, incremented before `#flushOutbox` attempts the write: the BOOT-1 reviewer read 1 with zero rows persisted, twice. It ships as `trader_decisions_persisted_total`: a §6 invariant 3 counter that reports a rejected decision as persisted. Outside BOOT-1's grant. | the next `loop.ts` round (count on `written.ok`, or rename) |
~~~

Keep (in both texts):

~~~keep
with zero rows persisted
a §6 invariant 3 counter that reports a rejected decision as persisted
count on written.ok, or rename
~~~

**Facts.** Kept: counts outbox appends before the write; read at 1 with zero rows persisted, twice; shipped as `trader_decisions_persisted_total`; the §6 invariant 3 consequence; out of BOOT-1's grant; the owner with both remedies. Archive only: the `loop.ts` and `samples.ts` line cites.

## RW-39: Residual `BOOT1-R11`

Old, lines 2563-2563:

~~~old lines=2563-2563
| **BOOT1-R11 (out of BOOT-1's grant)** | `test/integration/control-api/trader-health-shape.test.ts:169` asserts `toContain("WP-220 accepted residual")` and passes only because the corrected caveat QUOTES that phrase — the assertion no longer measures what its name says; `apps/trader/README.md:144-160` still states the WP-220 posture verbatim | the BOOT-1 review | the next control-api round (pin `SUPERSEDED (RISK-2, 133eac1)`); the next round granted `apps/trader/README.md` |
~~~

New:

~~~new
| `BOOT1-R11` | `test/integration/control-api/trader-health-shape.test.ts:169` asserts `toContain("WP-220 accepted residual")` and passes only because the corrected caveat quotes that phrase, so it no longer measures what its name says. `apps/trader/README.md:144-160` still states the WP-220 posture verbatim. | the next control-api round (pin `SUPERSEDED (RISK-2, 133eac1)`); the next round granted `apps/trader/README.md` |
~~~

Keep (in both texts):

~~~keep
no longer measures what its name says
SUPERSEDED (RISK-2, 133eac1)
~~~

**Facts.** Kept: the assertion and why it passes; that it no longer measures its name; the stale README lines; both owners, with the replacement pin `SUPERSEDED (RISK-2, 133eac1)`. Archive only: "out of BOOT-1's grant" (in the id cell).

## RW-40: Residual `BOOT1 fill-link severing`

Old, lines 2564-2564:

~~~old lines=2564-2564
| **BOOT1 fill-link severing** | `accounting.ledger_transactions.fill_id`/`order_id` bound NULL by `BOOT-1` (`postgres-store.ts:278-302`): the trader persists no `execution.*` rows (`execution.fills.order_id` and `execution.orders.plan_id` are NOT NULL, so no minimal row is honest). `fill-posting.ts:277-285` carries the fill id nowhere else, so one fill's durable transactions share only `occurred_at`/market/account/environment; two fills at one instant are indistinguishable; §6 invariant 8's rebuild FROM DURABLE ROWS cannot reproduce per-fill economics. Not lost: per-asset balances, per-instance attribution, the in-memory ledger and `loop.traces()`. `expect(execution.fills).toHaveLength(0)` (`durable-trader-first-fill-postgres.test.ts:713-715`) trips the day a round persists the chain — that failure is the instruction to delete the NULL binding | `docs/handoffs/BOOT-1.md` | the execution-chain persistence round (Wave 3, `WP-260`+) |
~~~

New:

~~~new
| `BOOT1 fill-link severing` | `accounting.ledger_transactions.fill_id`/`order_id` are bound NULL by `BOOT-1`: the trader persists no `execution.*` rows (`execution.fills.order_id` and `execution.orders.plan_id` are NOT NULL, so no minimal row is honest). One fill's durable transactions share only `occurred_at`, market, account and environment, and two fills at one instant are indistinguishable. So §6 invariant 8's rebuild from durable rows cannot reproduce per-fill economics. Not lost: per-asset balances, per-instance attribution, the in-memory ledger and `loop.traces()`. `expect(execution.fills).toHaveLength(0)` in `durable-trader-first-fill-postgres.test.ts` trips the day a round persists the chain; that failure is the instruction to delete the NULL binding. | the execution-chain persistence round (Wave 3, `WP-260`+) |
~~~

Keep (in both texts):

~~~keep
two fills at one instant are indistinguishable
Not lost: per-asset balances, per-instance attribution, the in-memory ledger and loop.traces()
that failure is the instruction to delete the NULL binding
~~~

**Facts.** Kept: the NULL binding; no `execution.*` rows and why (NOT NULL columns); what one fill's transactions share; the same-instant indistinguishability; the §6 invariant 8 consequence; what is not lost; the tripwire assertion and that its failure is the instruction to delete the NULL binding; the owner. Archive only: the `postgres-store.ts` and `fill-posting.ts` line cites and the test's line numbers.

## RW-41: Residual `BOOT1 pool leak`

Old, lines 2565-2565:

~~~old lines=2565-2565
| **BOOT1 pool leak (out of grant)** | `packages/storage-postgres/src/testing/fixtures.ts:36-55` `createMigratedContext.close()` is only `db.destroy()`; `migrateUp` uses the raw `pg` pool and Kysely 0.29.5 `RuntimeDriver.destroy()` returns early when `#initPromise` is unset, so a context that never queried through `context.db` leaks the pool (two uncaught `57P01` at container stop, reproduced by the reviewer). Fix: `await pool.end()` in `close()` | the BOOT-1 review (r1 and r2) | the next round granted `packages/storage-postgres/src/testing/**` |
~~~

New:

~~~new
| `BOOT1 pool leak` | `packages/storage-postgres/src/testing/fixtures.ts`'s `createMigratedContext.close()` only calls `db.destroy()`. `migrateUp` uses the raw `pg` pool, and Kysely 0.29.5's `RuntimeDriver.destroy()` returns early when `#initPromise` is unset. So a context that never queried through `context.db` leaks the pool (two uncaught `57P01` at container stop, reproduced). Fix: `await pool.end()` in `close()`. Outside BOOT-1's grant. | the next round granted `packages/storage-postgres/src/testing/**` |
~~~

Keep (in both texts):

~~~keep
Kysely 0.29.5
RuntimeDriver.destroy()
57P01
await pool.end()
~~~

**Facts.** Kept: `close()` only destroys the Kysely instance; the raw-pool and Kysely 0.29.5 `RuntimeDriver.destroy()` mechanism; the leak condition; the two uncaught `57P01`; the fix; out of grant. Archive only: the `fixtures.ts` line range and "r1 and r2".

## RW-42: Residual `BOOT1 unchecked shared facts`

Old, lines 2566-2566:

~~~old lines=2566-2566
| **BOOT1 unchecked shared facts** | The registration check does not compare `strategy.instances.status` (a PAUSED or RETIRED instance with a RUNNING run passes), `default_ownership_mode`/`evaluation_priority`, `catalog.market_tokens`, `parameters_version` — listed in `postgres-registration.ts`'s header table; no registration CLI exists (two-step operator registration through WP-040's `registerMarket`/`createDefinition`/`createConfig`/`createInstance`/`startRun`) | `docs/handoffs/BOOT-1.md` | the next `apps/trader` round; a registration CLI is Wave 3 operator tooling |
~~~

New:

~~~new
| `BOOT1 unchecked shared facts` | The registration check does not compare `strategy.instances.status` (a PAUSED or RETIRED instance with a RUNNING run passes), `default_ownership_mode`/`evaluation_priority`, `catalog.market_tokens` or `parameters_version`; they are listed in `postgres-registration.ts`'s header table. (The row's "no registration CLI exists" predates `REGISTER-1`.) | row: the next `apps/trader` round; a registration CLI is Wave 3 operator tooling (`REGISTER-1` has since added a registration command) |
~~~

Keep (in both texts):

~~~keep
a PAUSED or RETIRED instance with a RUNNING run passes
a registration CLI is Wave 3 operator tooling
~~~

**Facts.** Kept: the four unchecked facts, with the PAUSED/RETIRED plus RUNNING example; the header-table source; the owner, including "a registration CLI is Wave 3 operator tooling", quoted as "row:". "no registration CLI exists" and its two-step procedure predate `REGISTER-1` (merged `7f1ebc0`); the brief flags that. The config-parameter hash check is `BOOT1-CONFIGPARAMS`, closed by `OUTAGE-1`.

## RW-43: Residual `TRDR3-R1`

Old, lines 2567-2567:

~~~old lines=2567-2567
| **TRDR3-R1 (golden `realizedPnl` null)** | `test/replay-golden/paper-e2e/paper-e2e-run.json` `health.accounting.realizedPnl` is `{account: null, byInstance: {}}` while the durable path serves the ledger's value: `test/e2e/support/harness.ts:96,202-208` builds the trader on a bare `MemoryTraderStore` and the PnL observer is attached late in `apps/trader/src/main.ts` (`attachRealizedPnl`) rather than inside `createPaperTrader` — two composition paths disagree on one observed field. Fix: one line in `apps/trader/src/trader.ts` (wrap the store, attach the book) + delete the late attach in `main.ts` + regenerate the golden; expected flip derived and verified by the reviewer: `{account: "-1.2", byInstance: {"e18f5c20-2000-7a20-8b00-000000000002": "-1.2"}}`, nothing else | `docs/handoffs/TRDR-3.md` deviation 1; the review | a follow-up round owning `apps/trader/src/trader.ts` (candidate `TRDR-3-FU1`, with R2/R3 below; orchestrator authorization after `UNIV-4`) |
~~~

New:

~~~new
| `TRDR3-R1` | The paper golden's `health.accounting.realizedPnl` is `{account: null, byInstance: {}}` while the durable path serves the ledger's value. The e2e harness builds the trader on a bare `MemoryTraderStore`, and `main.ts` attaches the PnL observer late (`attachRealizedPnl`) instead of inside `createPaperTrader`: two composition paths disagree on one observed field. Fix: one line in `apps/trader/src/trader.ts` (wrap the store, attach the book), delete the late attach in `main.ts`, and regenerate the golden. The expected flip, derived and verified by the reviewer: `{account: "-1.2", byInstance: {"e18f5c20-2000-7a20-8b00-000000000002": "-1.2"}}`, and nothing else. | a follow-up round owning `apps/trader/src/trader.ts` (candidate `TRDR-3-FU1`, with R2/R3; orchestrator authorization after `UNIV-4`) |
~~~

Keep (in both texts):

~~~keep
{account: null, byInstance: {}}
delete the late attach in main.ts
e18f5c20-2000-7a20-8b00-000000000002
nothing else
a follow-up round owning apps/trader/src/trader.ts
with R2/R3
~~~

**Facts.** Kept: the golden's value `{account: null, byInstance: {}}`; the two disagreeing composition paths and why; the three-step fix; the full expected flip with the instance id; "nothing else"; the owner with "owning `apps/trader/src/trader.ts`" and "with R2/R3". Archive only: the `harness.ts` line cites.

## RW-44: Residual `TRDR3-R2`

Old, lines 2568-2568:

~~~old lines=2568-2568
| **TRDR3-R2 (health-server timeout enforcement)** | `apps/trader/src/health-server.ts:408-413` sets `headersTimeout`/`requestTimeout` 5 s but leaves `server.connectionsCheckingInterval` at Node's 30 s default, which is the cadence those timeouts are enforced at — the reviewer's 8-socket partial-header probe got its first 200 at 33 s. Loopback-only, PAPER, no write path; during the window the control API's refresh fails fast (`current 0`, `reads_total{UNAVAILABLE}`), so no dashboard lies. One line (`connectionsCheckingInterval = 1_000`) + restate the bound in the header and the handoff | the TRDR-3 review LOW-1 | `TRDR-3-FU1` |
~~~

New:

~~~new
| `TRDR3-R2` | `apps/trader/src/health-server.ts` sets `headersTimeout`/`requestTimeout` to 5 s but leaves `server.connectionsCheckingInterval` at Node's 30 s default, the cadence at which those timeouts are enforced: an 8-socket partial-header probe got its first 200 at 33 s. Loopback only, PAPER, no write path. Meanwhile the control API's refresh fails fast (`current 0`, `reads_total{UNAVAILABLE}`), so no dashboard lies. Fix: one line (`connectionsCheckingInterval = 1_000`), and restate the bound in the header and the handoff. | `TRDR-3-FU1` |
~~~

Keep (in both texts):

~~~keep
30 s default
first 200 at 33 s
no write path
so no dashboard lies
restate the bound in the header and the handoff
~~~

**Facts.** Kept: the two 5 s timeouts; the 30 s enforcement cadence; the 8-socket probe's first 200 at 33 s; loopback, PAPER, no write path; the control API failing fast so no dashboard lies; the one-line fix and the obligation to restate the bound. Archive only: the `health-server.ts` line range.

## RW-45: Residual `TRDR3-R3`

Old, lines 2569-2569:

~~~old lines=2569-2569
| **TRDR3-R3 (stale READMEs held stale by pins)** | `apps/control-api/README.md:109,118-120` ("nothing in the shipped process calls `refresh()`; no poller exists yet"), `infra/grafana/control/README.md:38,88` ("Realized PnL" still in the PENDING panels table), `apps/trader/README.md:322-323` ("a value rather than a metrics endpoint") are FALSE since `da9c58e`, and `test/integration/control-api/example-config-and-startup.test.ts:60-63` + `packages/observability/src/control/dashboards.test.ts:304-308` REQUIRE the sentence "does not expose an HTTP health endpoint today" — the BOOT-1 R11 class; `TRADER_HEALTH_BIND`/`TRADER_HEALTH_PORT` are documented nowhere outside code and the handoff | the TRDR-3 review LOW-3 | `TRDR-3-FU1` (READMEs and pins flipped together) |
~~~

New:

~~~new
| `TRDR3-R3` | Three READMEs are false since `da9c58e`: `apps/control-api/README.md` ("nothing in the shipped process calls `refresh()`; no poller exists yet"), `infra/grafana/control/README.md` ("Realized PnL" still in the PENDING panels table) and `apps/trader/README.md` ("a value rather than a metrics endpoint"). Two tests (`example-config-and-startup.test.ts`, `dashboards.test.ts`) require the sentence "does not expose an HTTP health endpoint today": the BOOT-1 R11 class. `TRADER_HEALTH_BIND`/`TRADER_HEALTH_PORT` are documented nowhere outside code and the handoff. | `TRDR-3-FU1` (READMEs and pins flipped together) |
~~~

Keep (in both texts):

~~~keep
no poller exists yet
does not expose an HTTP health endpoint today
documented nowhere outside code and the handoff
READMEs and pins flipped together
~~~

**Facts.** Kept: the three README identities with their false claims; the two pinning tests; the required stale sentence; the BOOT-1 R11 class; the undocumented variables, "nowhere outside code and the handoff"; the owner with "flipped together". Archive only: the README and test line numbers.

## RW-46: Residual `TRDR3-R4/R5/R7`

Old, lines 2570-2570:

~~~old lines=2570-2570
| **TRDR3-R4/R5/R7** | (R4) the operations dashboard lacks the `control_trader_health_current` stat the trading dashboard gained; (R5) `apps/control-api/control-api.config.example.json:3` `bindPort: 9465` collides with `infra/prometheus/recorder-scrape.yaml:34`'s compaction target — the new fragment targets 9466 to avoid it; (R7) `apps/control-api/src/health-door.ts:133` says "Bounded: at most 4096 instances" over an unbounded `z.record` (`:136`; the practical bound is the http source's 4 MiB body) | the TRDR-3 review | the next `apps/control-api`/`infra` round |
~~~

New:

~~~new
| `TRDR3-R4/R5/R7` | (R4) The operations dashboard lacks the `control_trader_health_current` stat the trading dashboard gained. (R5) The control API example's `bindPort: 9465` collides with `infra/prometheus/recorder-scrape.yaml`'s compaction target; the new fragment targets 9466 to avoid it. (R7) `apps/control-api/src/health-door.ts:133` says "Bounded: at most 4096 instances" over an unbounded `z.record`; the practical bound is the http source's 4 MiB body. | the next `apps/control-api`/`infra` round |
~~~

Keep (in both texts):

~~~keep
targets 9466 to avoid it
unbounded z.record
4 MiB body
~~~

**Facts.** Kept: R4's missing stat; R5's collision with the compaction target and the new fragment's 9466; R7's false bound, the unbounded `z.record` and the actual 4 MiB bound. Archive only: the config and scrape file line numbers.

## RW-47: Residual `SNAP1-KEYSET`

Old, lines 2621-2621:

~~~old lines=2621-2621
| **SNAP1-KEYSET** | The loop's written-keys set (SNAP-1's insert-or-replace identity) grows without bound, one entry per snapshot instant, for the life of the process. This is a small regression against `TRDR-4`'s bounded loop. The set only needs the current event's instant(s) plus what `SNAP1-R2`'s backwards-timestamp rule requires. It is empty after a restart, which is harmless: a restart is a new run | `docs/handoffs/SNAP-1.md` | the next `apps/trader` round (after `CORE-MOVE`: the file moves) |
~~~

New:

~~~new
| `SNAP1-KEYSET` | The loop's written-keys set (`SNAP-1`'s insert-or-replace identity) grows by one entry per snapshot instant for the life of the process: a small regression against `TRDR-4`'s bounded loop. It only needs the current event's instant(s) plus what `SNAP1-R2`'s backwards-timestamp rule requires. It is empty after a restart, which is harmless: a restart is a new run. | row: the next `apps/trader` round (after `CORE-MOVE`: the file moves; `CORE-MOVE` has since merged) |
~~~

Keep (in both texts):

~~~keep
SNAP1-R2's backwards-timestamp rule
a restart is a new run
after CORE-MOVE: the file moves
~~~

**Facts.** Kept: unbounded per snapshot instant; the regression against `TRDR-4`; what the set needs (the current event's instants plus `SNAP1-R2`'s backwards-timestamp rule); empty after a restart, harmless because a restart is a new run; the owner with its `CORE-MOVE` qualification, quoted as "row:" because `CORE-MOVE` has merged.

## RW-48: Residual `SNAP1-MINOR`

Old, lines 2622-2622:

~~~old lines=2622-2622
| **SNAP1-MINOR** | A replaced row keeps its first `computed_at`, and no health counter counts replacements. The double does not refuse an `as_of` that PostgreSQL refuses (for example, year 0000, which `normalizeToStrictUtc` accepts), and other PostgreSQL-accepted spellings key as themselves. There is also the crash-between-harvests window, and unowned fills still write no virtual snapshot (pre-existing) | `docs/handoffs/SNAP-1.md` | the next `apps/trader` round |
~~~

New:

~~~new
| `SNAP1-MINOR` | A replaced row keeps its first `computed_at`, and no health counter counts replacements. The double does not refuse an `as_of` that PostgreSQL refuses (for example year 0000, which `normalizeToStrictUtc` accepts), and other PostgreSQL-accepted spellings key as themselves. There is a crash window between harvests. Unowned fills still write no virtual snapshot (pre-existing). | the next `apps/trader` round |
~~~

Keep (in both texts):

~~~keep
year 0000
other PostgreSQL-accepted spellings key as themselves
virtual snapshot
~~~

**Facts.** Kept: first `computed_at` kept; no replacement counter; the double does not refuse what PostgreSQL refuses (year 0000, which `normalizeToStrictUtc` accepts); other PostgreSQL-accepted spellings key as themselves; the crash window between harvests; no VIRTUAL snapshot for unowned fills (pre-existing). Archive only: the evidence cite.

## RW-49: Residual `REGISTER1-LOWS`

Old, lines 2605-2605:

~~~old lines=2605-2605
| **REGISTER1-LOWS** | (L1) `REGISTER_REFUSED_BY_DATABASE` says "the database refused a row" when the failing statement was the duplicate-check SELECT on an UNMIGRATED database; the outcome is correct. (L2) `REGISTER_DEFINITION_MISMATCH` and `REGISTER_CONFIG_MISMATCH` have no test (verified by hand). (L3) `--help`'s exit-code table does not name every 78 code. (L4) a flag VALUE of exactly `-h`/`--help` prints the usage | `docs/handoffs/REGISTER-1.md` (Fable r1) | the next `apps/trader/src/register` round |
~~~

New:

~~~new
| `REGISTER1-LOWS` | (L1) `REGISTER_REFUSED_BY_DATABASE` says "the database refused a row" when the failing statement was the duplicate-check SELECT on an unmigrated database; the outcome is correct. (L2) `REGISTER_DEFINITION_MISMATCH` and `REGISTER_CONFIG_MISMATCH` have no test (verified by hand). (L3) `--help`'s exit-code table does not name every 78 code. (L4) A flag value of exactly `-h`/`--help` prints the usage. | the next `apps/trader/src/register` round |
~~~

Keep (in both texts):

~~~keep
duplicate-check SELECT on an
REGISTER_DEFINITION_MISMATCH and REGISTER_CONFIG_MISMATCH have no test
does not name every 78 code
prints the usage
~~~

**Facts.** Kept: all four LOWs as named in the row: the misleading refusal on an unmigrated database with the duplicate-check SELECT and the correct outcome; the two untested mismatch codes; the incomplete 78 table; `-h`/`--help` as a flag value printing usage. Archive only: the evidence cite (Fable r1).

## RW-50: Residual `OUTAGE1-LOWS`

Old, lines 2612-2612:

~~~old lines=2612-2612
| **OUTAGE1-LOWS** | (1) The trader-level outage tests pin "halts within T" but not the read deadline specifically; the event-bus suite pins it deterministically. (2) The recorded docker-restart halt is an artifact of Testcontainers re-mapping the port; with a fixed port a fast restart RECOVERS, as designed. (3) `startup()`'s subscribe catch labels any non-`EventBusUnavailableError` as `TRADER_EVENT_SUBSCRIPTION_REFUSED` (78) | `docs/handoffs/OUTAGE-1.md` | the next `apps/trader` round |
~~~

New:

~~~new
| `OUTAGE1-LOWS` | (1) The trader-level outage tests pin "halts within T" but not the read deadline itself; the event-bus suite pins that deterministically. (2) The recorded docker-restart halt is an artifact of Testcontainers re-mapping the port; with a fixed port a fast restart recovers, as designed. (3) `startup()`'s subscribe catch labels any error that is not an `EventBusUnavailableError` as `TRADER_EVENT_SUBSCRIPTION_REFUSED` (78). | the next `apps/trader` round |
~~~

Keep (in both texts):

~~~keep
the event-bus suite pins
with a fixed port a fast restart
TRADER_EVENT_SUBSCRIPTION_REFUSED (78)
~~~

**Facts.** Kept: all three items: the read deadline pinned only in the event-bus suite (deterministically); the Testcontainers port artifact and fixed-port recovery; the mislabeling catch condition (any non-`EventBusUnavailableError`) and its code 78. Archive only: the evidence cite.

## RW-51: Residual `UNIV4-R1`

Old, lines 2571-2571:

~~~old lines=2571-2571
| **UNIV4-R1 (attribution by request)** | The lifecycle feed attributes a polled body to the configured market by REQUEST, not by content: D-30 does not record `conditionId` on the `GET /markets/{id}` response, so the door records it and never compares it. A mis-pointed `gammaMarketId` opens THIS market on ANOTHER market's readiness, silently, and nothing here can notice. Disclosed in the feed header, the compose README (operator obligation to verify `gammaMarketId`) and the handoff | `docs/handoffs/UNIV-4.md` known_risks 6a; the r0 review MEDIUM-2 | the next venue round (record S-D34's `{id}` semantics and example body) → then the feed refuses a mismatched poll with an incident |
~~~

New:

~~~new
| `UNIV4-R1` | The lifecycle feed attributes a polled body to the configured market by request, not by content: D-30 does not record `conditionId` on the `GET /markets/{id}` response, so the door records it and never compares it. A mis-pointed `gammaMarketId` opens this market on another market's readiness, silently. Disclosed in the feed header, the compose README (operators must verify `gammaMarketId`) and the handoff. | the next venue round (record S-D34's `{id}` semantics and example body), then the feed refuses a mismatched poll with an incident |
~~~

Keep (in both texts):

~~~keep
D-30 does not record conditionId
record S-D34's {id} semantics and example body
with an incident
~~~

**Facts.** Kept: attribution by request, not content; the basis (D-30 does not record `conditionId` on the response; recorded, never compared); the silent mis-pointing consequence; where it is disclosed, including the operator obligation; the owner with S-D34's `{id}` semantics and example body, then refusal with an incident. Archive only: the evidence cite.

## RW-52: Residual `UNIV4-R2`

Old, lines 2572-2572:

~~~old lines=2572-2572
| **UNIV4-R2 (trader lifecycle unguarded)** | `apps/trader/src/loop.ts:577-580` marks OPEN/CLOSING on receipt; `market-state.ts:151` `markLifecycle` is unguarded; `pipeline.ts:340-347` then maps a RESOLVED market re-marked OPEN/CLOSING to `ACTIVE`/`CLOSE_ONLY` instead of `HALTED`. Two routes reach it: a same-instant replayed `MarketOpened` (UNIV-4's ledger, after a failed confirmation write); an R4 observed `MarketClosing` landing up to one poll interval AFTER the WebSocket's `MarketResolved` (two independent producers). The universe fold is correct (same-instant → unchanged; closing on RESOLVED → refused). Also: the strategy receives `onMarketClosing` with `secondsRemaining ≈ 0` (UNIV4-R3) — its cutoffs read `closeTimeMs` from configuration | the UNIV-4 reviews (r1 LOW-R3) | the next `apps/trader` round: rank-guard `markLifecycle` (never regress from RESOLVED) |
~~~

New:

~~~new
| `UNIV4-R2` | The trader's `markLifecycle` is unguarded: `loop.ts` marks OPEN/CLOSING on receipt, and `pipeline.ts` then maps a RESOLVED market re-marked OPEN/CLOSING to `ACTIVE`/`CLOSE_ONLY` instead of `HALTED`. Two routes reach it: a same-instant replayed `MarketOpened` (UNIV-4's ledger, after a failed confirmation write), and an R4 observed `MarketClosing` that lands up to one poll interval after the WebSocket's `MarketResolved` (two independent producers). The universe fold is correct (same instant: unchanged; closing on RESOLVED: refused). Also UNIV4-R3: the strategy receives `onMarketClosing` with `secondsRemaining ≈ 0`; its cutoffs read `closeTimeMs` from configuration. | the next `apps/trader` round: rank-guard `markLifecycle` (never regress from RESOLVED) |
~~~

Keep (in both texts):

~~~keep
Two routes reach it
The universe fold is correct
never regress from RESOLVED
~~~

**Facts.** Kept: the unguarded mark and the wrong mapping; both routes; the correct universe fold; UNIV4-R3 with `closeTimeMs` from configuration; the owner with the rank-guard remedy. Archive only: the `loop.ts`, `market-state.ts` and `pipeline.ts` line cites.

## RW-53: Residual `UNIV4-R4/R5`

Old, lines 2573-2573:

~~~old lines=2573-2573
| **UNIV4-R4/R5 (what a poll cannot tell)** | (R4) a hold-back caused by a failed CONFIRMATION write with a healthy publisher is released only by the next epoch (two PAGEs raised; a same-epoch retry when not halted would release it); (R5) poll latency ≤ one `pollIntervalMs` — a market closed between polls is seen late, closed-and-reopened within one interval is unseen; the venue's `endDate`/`startDate` are deliberately NOT used (no documented semantics; a schedule, not an observation); `publisher.ts:461`'s halt detail "the event remains in the WAL" is false for derived lifecycle events (the feed's own incident states the truth; owner's wording) | `docs/handoffs/UNIV-4.md` known_risks; the r2 review | the next `apps/data-gateway` round |
~~~

New:

~~~new
| `UNIV4-R4/R5` | (R4) A hold-back caused by a failed confirmation write, with a healthy publisher, is released only by the next epoch (two PAGEs raised); a same-epoch retry when not halted would release it. (R5) Poll latency is up to one `pollIntervalMs`: a market closed between polls is seen late, and one closed and reopened within one interval is unseen. The venue's `endDate`/`startDate` are deliberately not used: they have no documented semantics and are a schedule, not an observation. `publisher.ts:461`'s halt detail "the event remains in the WAL" is false for derived lifecycle events (the feed's own incident states the truth). | the next `apps/data-gateway` round |
~~~

Keep (in both texts):

~~~keep
with a healthy publisher
a same-epoch retry when not halted would release it
within one interval is unseen
deliberately not used
a schedule, not an observation
~~~

**Facts.** Kept: R4's hold-back with a healthy publisher, two PAGEs, and the same-epoch retry remedy; R5's latency bound, the late close, the unseen close-and-reopen, and why `endDate`/`startDate` are deliberately unused; the false WAL halt detail. Archive only: "owner's wording".

## RW-54: Residual `N8`

Old, lines 2547-2547:

~~~old lines=2547-2547
| **N8 (WP-240 r1 M-1/M-2/M-3)** | Three review-round-1 findings on the control API, live and untested: **M-1** pausing an instance the control plane has never known answers `200 PAUSED` (the shipped composition never calls `register()`; a prior is synthesized), contradicting its own `CONTROL_NOT_ENGAGED` release rule; **M-2** `TraderHealthCache.refresh()` is never called by the shipped process, so an `http` health source is accepted, validated and dead; **M-3** an authenticated READ-only operator can exhaust the audit log through pre-authorization forbidden-key refusal records and thereby disable every mutation **including the §14.1 kill switch** (fail-closed; demonstrated at capacity 3 in five requests). Nine LOWs (L-1…L-9) and N-4 sit behind them | `docs/handoffs/WP-240.md` "Accepted findings → owned follow-ups" | M-1, M-3 and the LOWs: the next bounded `apps/control-api` round; **M-2 CLOSED 2026-09-17 by `TRDR-3` (`da9c58e`)** — refresh-on-read on every authorized `/v1/health`/`/v1/metrics` read, single-flight, `http` source only; L-9 (no rate bound) is now load-bearing on the request path (TRDR3-R8/R9) |
~~~

New:

~~~new
| `N8` | Control API, `WP-240` review round 1, live and untested. M-1: pausing an instance the control plane never knew answers `200 PAUSED` (the shipped composition never calls `register()`; a prior is synthesized), contradicting its own `CONTROL_NOT_ENGAGED` release rule. M-3: an authenticated read-only operator can exhaust the audit log through pre-authorization forbidden-key refusal records, and so disable every mutation, including the §14.1 kill switch (fail-closed; shown at capacity 3 in five requests). Nine LOWs (L-1 to L-9) and N-4 sit behind them. M-2 closed 2026-09-17 by `TRDR-3` (`da9c58e`). L-9 (no rate bound) is now load-bearing on the request path (TRDR3-R8/R9). | M-1, M-3 and the LOWs: the next bounded `apps/control-api` round |
~~~

Keep (in both texts):

~~~keep
a prior is synthesized
CONTROL_NOT_ENGAGED
pre-authorization forbidden-key refusal records
(no rate bound)
~~~

**Facts.** Kept: live and untested; M-1 with its mechanism (no `register()`; a synthesized prior) and the `CONTROL_NOT_ENGAGED` conflict; M-3 with its mechanism (pre-authorization forbidden-key refusal records), the kill-switch consequence and the capacity-3, five-request demonstration; nine LOWs and N-4; M-2 closed by `TRDR-3`; L-9 (no rate bound) load-bearing (TRDR3-R8/R9); the owner split. Archive only: M-2's refresh-on-read mechanism.

## RW-55: Residual `G-03`

Old, lines 2548-2548:

~~~old lines=2548-2548
| **G-03 (soak job specs)** | `test/soak/recorder` ships four job scripts — `soak:run`, `soak:smoke`, `soak:evaluate`, `soak:compare-books` — and only `soak:smoke` is gated (`ci.yml:72-73`, `test:soak-smoke`); `soak:evaluate` and `soak:compare-books` are evidence-producing jobs that run nowhere until an operator runs them, and `soak:evaluate` is PENDING in every record that names it (no evidence windows exist) | `docs/handoffs/GOV-2B-wave-2-closeout.md` G-03; `test/soak/recorder/package.json` | the elapsed-soak human item H4 (`WP-140` row); gating the two jobs is a `ci.yml` decision for the orchestrator |
~~~

New:

~~~new
| `G-03` | `test/soak/recorder` ships four job scripts: `soak:run`, `soak:smoke`, `soak:evaluate` and `soak:compare-books`. Only `soak:smoke` is gated (`test:soak-smoke` in CI). `soak:evaluate` and `soak:compare-books` produce evidence but run only when an operator runs them. `soak:evaluate` is PENDING in every record that names it (no evidence windows exist). | the elapsed-soak human item H4 (`WP-140`); gating the two jobs is the orchestrator's `ci.yml` decision |
~~~

Keep (in both texts):

~~~keep
soak:run
no evidence windows exist
~~~

**Facts.** Kept: the four job scripts; only `soak:smoke` gated; the two evidence jobs unrun until an operator runs them; `soak:evaluate` PENDING with no evidence windows; the owner split. Archive only: the `ci.yml` line numbers and the evidence cites.

## RW-56: Residual `SIM-BALANCE`

Old, lines 2514-2514:

~~~old lines=2514-2514
| **SIM-BALANCE** | `SimulatedVenue` has no cash or position sufficiency check: cash can go negative, and a SELL of shares the account does not hold books a negative position (`PP-6`). The real venue refuses insufficient balance. Upstream risk is what prevents it today | LOOPMEM-SIM scoping (`wf_8524bc0f-1b8`) | a simulation round after `SIM-2` |
~~~

New:

~~~new
| `SIM-BALANCE` | `SimulatedVenue` has no cash or position sufficiency check: cash can go negative, and a SELL of shares the account does not hold books a negative position (`PP-6`). The real venue refuses insufficient balance. Upstream risk prevents it today. | a simulation round after `SIM-2` |
~~~

Keep (in both texts):

~~~keep
cash can go negative
The real venue refuses insufficient balance
~~~

**Facts.** Kept: no sufficiency check; negative cash and a negative position from an unheld SELL (`PP-6`); the real venue refuses; upstream risk prevents it today. Archive only: the scoping workflow id.

## RW-57: Residual `SIM-ATTEMPT`

Old, lines 2515-2515:

~~~old lines=2515-2515
| **SIM-ATTEMPT** | A submission attempt is one per PLAN today. §9.11's idempotent protocol reads per SIGNED ORDER. Minting one per order would churn every deterministic id in the paper-e2e and backtest goldens (`PP-11`) | LOOPMEM-SIM scoping | the OMS / live-adapter work package |
~~~

New:

~~~new
| `SIM-ATTEMPT` | One submission attempt per plan today; §9.11's idempotent protocol reads per signed order. Minting one per order would churn every deterministic id in the paper-e2e and backtest goldens (`PP-11`). | the OMS / live-adapter work package |
~~~

Keep (in both texts):

~~~keep
paper-e2e and backtest goldens
~~~

**Facts.** Kept: one attempt per plan; §9.11 per signed order; the churn of every deterministic id in the paper-e2e and backtest goldens (`PP-11`). Archive only: the evidence cite.

## RW-58: Residual `SIM1-BASKET`

Old, lines 2516-2516:

~~~old lines=2516-2516
| **SIM1-BASKET** | BASKET partial handling is unreachable in production. `CoreLoop.#economicsFor` supplies fee and slippage estimates for POSITION intents only, so the risk engine refuses every BASKET (`RISK_EDGE_INPUTS_MISSING`). Nothing consumes the plan's `failurePolicy` (ABANDON / PROTECTED_UNWIND / HOLD_FILLED_LEGS). `SIM-1` makes a basket partial fail CLOSED (a halt), pinned through a disclosed `vi.mock` seam | `docs/handoffs/SIM-1.md` | a round that makes baskets reachable: basket economics plus a `failurePolicy` consumer |
~~~

New:

~~~new
| `SIM1-BASKET` | BASKET partial handling is unreachable in production. `CoreLoop.#economicsFor` supplies fee and slippage estimates for POSITION intents only, so risk refuses every BASKET (`RISK_EDGE_INPUTS_MISSING`), and nothing consumes the plan's `failurePolicy` (ABANDON / PROTECTED_UNWIND / HOLD_FILLED_LEGS). `SIM-1` makes a basket partial fail closed (a halt), pinned through a disclosed `vi.mock` seam. | a round that makes baskets reachable: basket economics plus a `failurePolicy` consumer |
~~~

Keep (in both texts):

~~~keep
RISK_EDGE_INPUTS_MISSING
ABANDON / PROTECTED_UNWIND / HOLD_FILLED_LEGS
disclosed vi.mock seam
basket economics plus a failurePolicy consumer
~~~

**Facts.** Kept: unreachable in production; the cause (POSITION-only economics; `RISK_EDGE_INPUTS_MISSING`); the unconsumed `failurePolicy` values; `SIM-1`'s fail-closed halt through a disclosed `vi.mock` seam; the owner with both parts of the fix.

## RW-59: Residual `SIM1-CANCELDEBIT`

Old, lines 2517-2517:

~~~old lines=2517-2517
| **SIM1-CANCELDEBIT** | The simulator charges a market cancel's live-target count UP FRONT. The dated venue report describes admission plus a per-success debit. The difference is small, and the simulator is conservative | `docs/handoffs/SIM-1.md` (Codex r4 residual) | a simulation round (with `SIM-BALANCE`) |
~~~

New:

~~~new
| `SIM1-CANCELDEBIT` | The simulator charges a market cancel's live-target count up front; the dated venue report describes admission plus a per-success debit. The difference is small, and the simulator is conservative. | a simulation round (with `SIM-BALANCE`) |
~~~

Keep (in both texts):

~~~keep
admission plus a per-success debit
~~~

**Facts.** Kept: up-front charge; the venue report's admission plus per-success debit; small and conservative. Archive only: the evidence cite (Codex r4).

## RW-60: Residual `SIM1-LOOKAHEAD`

Old, lines 2518-2518:

~~~old lines=2518-2518
| **SIM1-LOOKAHEAD** | A Tier-1 DELAYED order's disposition is still computed AT SUBMISSION, from `timeline.bookAt(matchableAtNs)`. That is a pre-existing look-ahead question the scoping flagged, unchanged by `SIM-1`. Tier 1 only, and not in production PAPER | `docs/handoffs/SIM-1.md` | a Tier-1 fidelity round, with an ADR-012 reading |
~~~

New:

~~~new
| `SIM1-LOOKAHEAD` | A Tier-1 DELAYED order's disposition is still computed at submission, from `timeline.bookAt(matchableAtNs)`: a pre-existing look-ahead question, unchanged by `SIM-1`. Tier 1 only; not in production PAPER. | a Tier-1 fidelity round, with an ADR-012 reading |
~~~

Keep (in both texts):

~~~keep
timeline.bookAt(matchableAtNs)
look-ahead question
~~~

**Facts.** Kept: computed at submission from `timeline.bookAt(matchableAtNs)`, which is why it is a look-ahead question; pre-existing and unchanged by `SIM-1`; Tier 1 only, not production PAPER; the owner. Archive only: "the scoping flagged".

## RW-61: Residual `SIM1-PRICEVALID`

Old, lines 2519-2519:

~~~old lines=2519-2519
| **SIM1-PRICEVALID** | A hand-built planned order is not validated against the price range. Planner-built orders are | `docs/handoffs/SIM-1.md` (Codex residual) | a ruling first (is it the venue's job or the planner's?) |
~~~

New:

~~~new
| `SIM1-PRICEVALID` | A hand-built planned order is not validated against the price range (planner-built orders are). | a ruling first: is it the venue's job or the planner's? |
~~~

Keep (in both texts):

~~~keep
Planner-built orders are
is it the venue's job or the planner's?
~~~

**Facts.** Kept in full: the missing validation for hand-built orders, planner-built orders validated, and the ruling-first owner.

## RW-62: Residual `SIM2-TIER1-TRADES`

Old, lines 2520-2520:

~~~old lines=2520-2520
| **SIM2-TIER1-TRADES** | Tier-1 `#trades` is still unbounded, and so is Tier-1 per-trade band cost (`VS-07`, O(R·T²)). Trimming to the earliest live `restingFromNs` is NOT byte-safe: a later order can rest at an instant the venue already holds a trade for. That is pinned in `test/unit/simulation/venue-sim2.test.ts`. Tier 1 is unreachable from the shipped trader (Tier 0), so the cost falls on backtests only | `docs/handoffs/SIM-2.md` | a Tier-1 round: an incremental band fold, with an absolute base offset |
~~~

New:

~~~new
| `SIM2-TIER1-TRADES` | Tier-1 `#trades` is unbounded, and so is Tier-1 per-trade band cost (`VS-07`, O(R·T²)). Trimming to the earliest live `restingFromNs` is not byte-safe: a later order can rest at an instant the venue already holds a trade for (pinned in `venue-sim2.test.ts`). Tier 1 is unreachable from the shipped trader (Tier 0), so the cost falls on backtests only. | a Tier-1 round: an incremental band fold, with an absolute base offset |
~~~

Keep (in both texts):

~~~keep
O(R·T²)
a later order can rest at an instant the venue already holds a trade for
an incremental band fold, with an absolute base offset
~~~

**Facts.** Kept: `#trades` and band cost unbounded (`VS-07`, O(R·T²)); why trimming to the earliest live `restingFromNs` is not byte-safe; the pin; Tier 0 in the shipped trader, so backtests only; the owner's incremental-fold remedy with an absolute base offset.

## RW-63: Residual `SIM2-FILTER`

Old, lines 2521-2521:

~~~old lines=2521-2521
| **SIM2-FILTER** | The never-forgetting duplicate-id filter (2^24 bits, about 2 MiB) can refuse a NEW id on a false positive. Such a refusal is loud and counted. The probability is about 1% after roughly 1.75 M folded ids, and folding starts only after 150 k acknowledged orders; at saturation every new id is refused (a fail-closed denial of service on an extremely long run). `evictedIdFilterBits` is the knob | `docs/handoffs/SIM-2.md` | revisit if a run ever approaches 10^6 orders |
~~~

New:

~~~new
| `SIM2-FILTER` | The never-forgetting duplicate-id filter (2^24 bits, about 2 MiB) can refuse a new id on a false positive; the refusal is loud and counted. The probability is about 1% after roughly 1.75 M folded ids; folding starts only after 150k acknowledged orders. At saturation every new id is refused (a fail-closed denial of service on an extremely long run). `evictedIdFilterBits` is the knob. | revisit if a run ever approaches 10^6 orders |
~~~

Keep (in both texts):

~~~keep
2^24 bits
150
at saturation every new id is refused
evictedIdFilterBits
~~~

**Facts.** Kept: never-forgetting, 2^24 bits, about 2 MiB; loud and counted; about 1% after about 1.75 M folded ids; folding starts only after 150k acknowledged orders; saturation refuses every new id (fail-closed denial of service); the `evictedIdFilterBits` knob; the owner. Archive only: the evidence cite.

## RW-64: Residual `BRACKET1-TPRACE`

Old, lines 2574-2578:

~~~old lines=2574-2578
| **BRACKET1-TPRACE** | Pre-existing, disclosed in the static-bracket README by `BRACKET-1a`. The `(PARTIALLY_OPEN|OPEN, *_FILL)` family:
  - (a) A take-profit is still LIVE when a late entry fill resizes it, and the resize's cancel loses the race to a fill. The fill is refused with `SB.ILLEGAL_TRANSITION` and the instance pauses, fail-closed, with the fill unfolded. At base the view-first order gave `UNATTRIBUTED_FILL`; either way the instance pauses.
  - (b) A LIVE entry's fill arrives while the bracket is `OPEN`.

It needs an edge or a ruling. One option: exit settlement does not move into `OPEN` while the entry is still live. | `docs/handoffs/BRACKET-1a.md` residuals (implementer r2 known_risks, reviewer r3 residual) | the next static-bracket round |
~~~

New:

~~~new
| `BRACKET1-TPRACE` | Pre-existing; disclosed in the static-bracket README by `BRACKET-1a`. The `(PARTIALLY_OPEN\|OPEN, *_FILL)` family. (a) A take-profit is still live when a late entry fill resizes it, and the resize's cancel loses the race to a fill: the fill is refused with `SB.ILLEGAL_TRANSITION`, and the instance pauses, fail-closed, with the fill unfolded (at base the view-first order gave `UNATTRIBUTED_FILL`; either way it pauses). (b) A live entry's fill arrives while the bracket is `OPEN`. It needs an edge or a ruling; one option: exit settlement does not move into `OPEN` while the entry is still live. | the next static-bracket round |
~~~

Keep (in both texts):

~~~keep
the resize's cancel loses the race to a fill
with the fill unfolded
exit settlement does not move into OPEN while the entry is still live
~~~

**Facts.** Kept: pre-existing and disclosed in the README; the family; (a) with the race, the refusal, the pause with the fill unfolded, and the base's view-first `UNATTRIBUTED_FILL`; (b); the edge-or-ruling need and the one option. Archive only: the evidence cite.

## RW-65: Residual `BRACKET1-IDLESSVIEW`

Old, lines 2579-2579:

~~~old lines=2579-2579
| **BRACKET1-IDLESSVIEW** | An id-less protective reduce whose FIRST view is terminal and partly filled is ignored by D5. Its fill then names it, but the track stays WORKING until a terminal view is re-delivered by id. This is unreachable under the trader's fills-before-views delivery (`loop.ts` `#harvestFills` before `#deliverOrderViews`), and R2's composition obligation carries the same assumption. The fix would be to re-read `ctx.orders()` by id for a tracked exit whose view is terminal | `docs/handoffs/BRACKET-1a.md` residuals | the next static-bracket round |
~~~

New:

~~~new
| `BRACKET1-IDLESSVIEW` | An id-less protective reduce whose first view is terminal and partly filled is ignored by D5. Its fill then names it, but the track stays WORKING until a terminal view is re-delivered by id. Unreachable under the trader's fills-before-views delivery (`#harvestFills` before `#deliverOrderViews`); R2's composition obligation carries the same assumption. The fix: re-read `ctx.orders()` by id for a tracked exit whose view is terminal. | the next static-bracket round |
~~~

Keep (in both texts):

~~~keep
the track stays WORKING until a terminal view is re-delivered by id
R2's composition obligation carries the same assumption
re-read ctx.orders() by id
~~~

**Facts.** Kept: ignored by D5; the fill names it but the track stays WORKING until a terminal view is re-delivered by id; unreachable under fills-before-views delivery; R2's shared assumption; the `ctx.orders()` fix. Archive only: the evidence cite.

## RW-66: Residual `RISK-2 item 7`

Old, lines 2559-2559:

~~~old lines=2559-2559
| **RISK-2 item 7 (three members)** | (i) `RISK2-R5` — an obsolete four-row table retained in `packages/strategies/static-bracket/README.md`; (ii) the complement-leg reclassification — a strategy that establishes exposure by SELLING a token it holds is now also an EXIT, sound within §9.8's own measures but disclosed at the site and not exercised end to end (the contract-owner question it raises: gating a covered sale on its DIRECTIONAL effect needs a net-directional-exposure measure §9.8 does not define); (iii) `planEntry` tags `immediate_order_type` unconditionally, so a PASSIVE entry hits the same order-type collision the exits just escaped | `docs/handoffs/RISK-2.md` residual 7 | (i) **CLOSED by `BRACKET-1a`** (merged `11969f3`, 2026-09-28): the obsolete table was removed. (iii) the next `packages/strategies/static-bracket/**` round (explicitly re-owned by `BRACKET-1a`, not ridden). (ii) the contract owner, as a §9.8 question |
~~~

New:

~~~new
| `RISK-2 item 7` | (i) Closed by `BRACKET-1a`: the obsolete `RISK2-R5` table was removed. (ii) The complement-leg reclassification: a strategy that establishes exposure by selling a token it holds is now also an EXIT. That is sound within §9.8's own measures, disclosed at the site and not exercised end to end. Gating a covered sale on its directional effect needs a net-directional-exposure measure §9.8 does not define. (iii) `planEntry` tags `immediate_order_type` unconditionally, so a PASSIVE entry hits the same order-type collision the exits just escaped. | (ii) the contract owner, as a §9.8 question; (iii) the next `packages/strategies/static-bracket/**` round (re-owned by `BRACKET-1a`) |
~~~

Keep (in both texts):

~~~keep
sound within §9.8's own measures
not exercised end to end
a net-directional-exposure measure §9.8 does not define
the same order-type collision the exits just escaped
~~~

**Facts.** Kept: (i) closed by `BRACKET-1a`, with what it was; (ii) the reclassification, "sound within §9.8's own measures", disclosed and not exercised end to end, and the missing net-directional-exposure measure; (iii) the unconditional tag and the collision; the owners, with (iii) re-owned by `BRACKET-1a`. Archive only: "not ridden" and the `RISK2-R5` table's location.

## RW-67: Residual `BRACKET1B-RECON`

Old, lines 2587-2592:

~~~old lines=2587-2592
| **BRACKET1B-RECON** | Disclosed limits of the per-bracket reconciler (`BRACKET-1b`), each loud rather than silent where it matters:
  - FEE records are not individually tied to their fills (fee totals are compared through fills and snapshots);
  - the single-bracket path does not check the PnL stream's order (no single-bracket row reads it);
  - same-event fill ties keep the fill-id convention;
  - there is no per-bracket engine checkpoint in the artifact;
  - two internal guards are unreachable and unpinned. | `docs/handoffs/BRACKET-1b.md` residuals (implementer r2 known_risks; reviewer r3) | the next `test/e2e/**` round |
~~~

New:

~~~new
| `BRACKET1B-RECON` | Disclosed limits of the per-bracket reconciler (`BRACKET-1b`), each loud rather than silent where it matters: fee records are not individually tied to their fills (fee totals are compared through fills and snapshots); the single-bracket path does not check the PnL stream's order (no single-bracket row reads it); same-event fill ties keep the fill-id convention; there is no per-bracket engine checkpoint in the artifact; two internal guards are unreachable and unpinned. | the next `test/e2e/**` round |
~~~

Keep (in both texts):

~~~keep
each loud rather than silent where it matters
the single-bracket path does not check the PnL stream's order
same-event fill ties keep the fill-id convention
no per-bracket engine checkpoint
two internal guards are unreachable and unpinned
~~~

**Facts.** Kept: all five disclosed limits, word for word in substance, and "each loud rather than silent where it matters". The r0 brief said "and four more"; r1 names them. Archive only: the evidence cite.

## RW-68: Residual `BRACKET1C-LOWS`

Old, lines 2601-2601:

~~~old lines=2601-2601
| **BRACKET1C-LOWS** | `BR1C-R1-L1`: the durable round trip's fixture-schedule tests do not pin `core_net_pnl`, `gross_trading_pnl`, `capital_committed` or `worst_case_resolution_pnl`. The values were read back and are correct. `BR1C-R1-L2`: the read-back's SQL predicates are not load-bearing; one database per scenario scopes the rows | `docs/handoffs/BRACKET-1c.md` review | L1 **CLOSED by `SNAP-1`** (merged `fff844d`); L2 stays with the next paper-trader integration round |
~~~

New:

~~~new
| `BRACKET1C-LOWS` | L1 closed (`SNAP-1`). L2: the read-back's SQL predicates are not load-bearing; one database per scenario scopes the rows. | L2: the next paper-trader integration round |
~~~

Keep (in both texts):

~~~keep
one database per scenario scopes the rows
~~~

**Facts.** Kept: L1 closed by `SNAP-1`; L2 with its reason (one database per scenario scopes the rows); the owner. Archive only: L1's detail (which values were unpinned).

## RW-69: Residual `GATE1-M1`

Old, lines 2541-2541:

~~~old lines=2541-2541
| **GATE1-M1** | `test:replay` is a hand-maintained positional list; vitest fails only when the TOTAL filtered set is empty, so if ONE named file is renamed or moved the gate drops it and still exits 0 — the N4 defect can silently return. Proven by the reviewer | `docs/handoffs/GATE-1.md` residual 1 | a round granted `test/unit/**` (a guard test asserting both golden files exist by path, or one directory named in the script) |
~~~

New:

~~~new
| `GATE1-M1` | `test:replay` is a hand-maintained positional list. Vitest fails only when the whole filtered set is empty, so if one named file is renamed or moved the gate drops it and still exits 0: the N4 defect can silently return (proven by the reviewer). | a round granted `test/unit/**` (a guard test asserting both golden files exist by path, or one directory named in the script) |
~~~

Keep (in both texts):

~~~keep
hand-maintained positional list
renamed or moved
a guard test asserting both golden files exist by path, or one directory named in the script
~~~

**Facts.** Kept: the positional list; vitest's all-filtered-empty exception; the renamed or moved file route; exit 0; the N4 defect; proven by the reviewer; the owner with both remedies. Archive only: the evidence cite.

## RW-70: Residual `TC-LOCAL-FLAKE`

Old, lines 2602-2602:

~~~old lines=2602-2602
| **TC-LOCAL-FLAKE** | Local Testcontainers flakiness observed by the `BACKTEST-2` implementer: 2 of 5 local `trader test:integration` runs failed on infrastructure (Redis "Connection is closed" at `RedisStreamsEventTransport.connect` in test setup; testcontainers "Failed to connect to Reaper"), in different files each time. The orchestrator's gate runs and GitHub CI were green. A CI flake of the same shape would read as a red build | `docs/handoffs/BACKTEST-2.md` (implementer tests_run) | watch CI; a paper-trader integration round may add connect retries or container readiness waits |
~~~

New:

~~~new
| `TC-LOCAL-FLAKE` | Seen by the `BACKTEST-2` implementer: 2 of 5 local `trader test:integration` runs failed on infrastructure (Redis "Connection is closed" at `RedisStreamsEventTransport.connect` in test setup; testcontainers "Failed to connect to Reaper"), in a different file each time. The orchestrator's gate runs and GitHub CI were green. A CI flake of the same shape would read as a red build. | watch CI; a paper-trader integration round may add connect retries or container readiness waits |
~~~

Keep (in both texts):

~~~keep
Connection is closed
Failed to connect to Reaper
may add connect retries or container readiness waits
~~~

**Facts.** Kept: who saw it; 2 of 5 runs; both exact errors and where; a different file each time; the green orchestrator gates and GitHub CI; the red-build consequence; the owner with the optional retries or readiness waits.

## RW-71: Residual `LINT1-TSC`

Old, lines 2553-2553:

~~~old lines=2553-2553
| **LINT1-TSC** | Nothing in CI compiles `tsconfig.lint.json`. A future import that resolves OUTSIDE its `paths` (for example through a suite's `baseUrl`, which the lint program lacks) would get an error type, and `no-floating-promises` would silently skip that module's promises. The drift pin guards `paths` only. At `e3a3389` all 4,636 imports resolve. Inherent limits, recorded rather than queued: `void` opt-outs need no reason comment, and a promise typed as `any` is not seen | `docs/handoffs/LINT-1.md` (implementer known_risks; Codex r1 residuals) | a round granted `.github/workflows/ci.yml`: add a gated `pnpm exec tsc -p tsconfig.lint.json --noEmit` step, keeping CI-2's drift pin satisfied |
~~~

New:

~~~new
| `LINT1-TSC` | Nothing in CI compiles `tsconfig.lint.json`. An import that resolves outside its `paths` (for example through a suite's `baseUrl`, which the lint program lacks) gets an error type, and `no-floating-promises` silently skips that module's promises. The drift pin guards `paths` only. At `e3a3389` all 4,636 imports resolve. Recorded, not queued: `void` opt-outs need no reason comment, and a promise typed as `any` is not seen. | a round granted `.github/workflows/ci.yml`: add a gated `pnpm exec tsc -p tsconfig.lint.json --noEmit` step, keeping CI-2's drift pin satisfied |
~~~

Keep (in both texts):

~~~keep
The drift pin guards paths only
all 4,636 imports resolve
pnpm exec tsc -p tsconfig.lint.json --noEmit
keeping CI-2's drift pin satisfied
~~~

**Facts.** Kept: nothing compiles `tsconfig.lint.json`; the outside-`paths` route via `baseUrl`; the error type and the silent skip; the drift pin guards `paths` only; 4,636 imports at `e3a3389`; the two inherent limits, recorded rather than queued; the owner with the exact `tsc` step and the CI-2 drift-pin condition.

## RW-72: Residual `DEPS1-VITEST`

Old, lines 2610-2610:

~~~old lines=2610-2610
| **DEPS1-VITEST** | Two MODERATE advisories remain in vitest / @vitest/mocker 3.2.7 (`>=2.1.0 <4.1.11`). They are test-only and below CI's high threshold. Clearing them needs a vitest major, which is not lockfile-only | `DEPS-1` review (INFO N2) | a tooling round |
~~~

New:

~~~new
| `DEPS1-VITEST` | Two moderate advisories remain in vitest / @vitest/mocker 3.2.7 (`>=2.1.0 <4.1.11`). They are test-only and below CI's high threshold. Clearing them needs a vitest major, which is not lockfile-only. | a tooling round |
~~~

Keep (in both texts):

~~~keep
@vitest/mocker 3.2.7
>=2.1.0 <4.1.11
not lockfile-only
~~~

**Facts.** Kept: two moderate advisories; vitest / @vitest/mocker 3.2.7; the range `>=2.1.0 <4.1.11`; test-only; below the high threshold; a vitest major, not lockfile-only. Archive only: the evidence cite (DEPS-1 review INFO N2).

## RW-73: Residual `BUNDLE1-LOWS`

Old, lines 2614-2620:

~~~old lines=2614-2620
| **BUNDLE1-LOWS** | Six LOW items, all queued:
  - (1) ADR-018 should record the third pattern (ESM + `createRequire`) and why CJS was rejected;
  - (2) `packages/storage-postgres`'s default migrations directory resolves relative to the bundle (latent);
  - (3) the entry guards key on the file name, so a renamed bundle exits 0 silently;
  - (4) the pin covers only `build` scripts that start with `esbuild `;
  - (5) the pin couples to the example config's market count;
  - (6) process: one unprefixed pnpm command rewrote shared-hardlink metadata (observable state verified; the main checkout still holds `js-yaml@4.3.1`) | `docs/handoffs/BUNDLE-1.md` | (1) the next docs round (with the ADR-022 discharge note); (2)–(5) the next tooling or apps round |
~~~

New:

~~~new
| `BUNDLE1-LOWS` | Six LOWs. (1) ADR-018 should record the third pattern (ESM + `createRequire`) and why CJS was rejected. (2) `packages/storage-postgres`'s default migrations directory resolves relative to the bundle (latent). (3) The entry guards key on the file name, so a renamed bundle exits 0 silently. (4) The pin covers only `build` scripts that start with `esbuild `. (5) The pin couples to the example config's market count. (6) Process: one unprefixed pnpm command rewrote shared-hardlink metadata (observable state verified; the main checkout still holds `js-yaml@4.3.1`). [`DOCS-1.md`](docs/handoffs/DOCS-1.md) says `DOCS-1` covered (1); the row was not updated. | (1) the next docs round (with the ADR-022 discharge note); (2)-(5) the next tooling or apps round |
~~~

Keep (in both texts):

~~~keep
only build scripts that start with esbuild
couples to the example config's market count
js-yaml@4.3.1
why CJS was rejected
~~~

**Facts.** Kept: all six items as named, including (4) the `esbuild `-prefix-only coverage, (5) the coupling to the example config's market count and (6) the metadata rewrite with the `js-yaml@4.3.1` observation; the owners. The r0 brief summarized (4)-(6); r1 names them. The row still assigns (1) to the next docs round, while `docs/handoffs/DOCS-1.md` says `DOCS-1` covered it; the brief reports both and does not resolve it.

## RW-74: Residual `GATE1-R3`

Old, lines 2549-2549:

~~~old lines=2549-2549
| **GATE1-R3 (discharged locally)** | `js-yaml 4.3.2` HAS executed here: `GATE-1`'s post-merge `pnpm install --frozen-lockfile --offline` at `0434c82` materialized `node_modules/.pnpm/js-yaml@4.3.2` (`docs/handoffs/GATE-1.md`, "every one re-run green"), and every lint gate since — TRDR-2, RISK-2, GOV-2C — ran on it. *(Corrected 2026-09-16 in the GOV-2C governance flip, review finding GOV2C-r1-1; the row previously read "`js-yaml 4.3.2` has never executed here: the bump was lockfile-only, local `node_modules` still holds 4.3.1, and every gate run so far used it" — true at GATE-1's candidate tip, false once its post-merge install ran, and copied without re-dating.)* The remaining unknown is only the first real CI run's fresh install | `docs/handoffs/GATE-1.md` residual 3 | H2 (the first real CI run) |
~~~

New:

~~~new
| `GATE1-R3` | `js-yaml 4.3.2` has run locally since `GATE-1`'s post-merge `pnpm install --frozen-lockfile --offline` at `0434c82`; every lint gate since ran on it. The remaining unknown was the first real CI run's fresh install. | H2, discharged 2026-09-26 by `CI-1`; the row was not closed |
~~~

Keep (in both texts):

~~~keep
pnpm install --frozen-lockfile --offline
the first real CI run's fresh install
~~~

**Facts.** Kept: 4.3.2 has run locally since `GATE-1`'s post-merge install at `0434c82`; every lint gate since; the remaining unknown. The owner is H2, which `CI-1` discharged on 2026-09-26; the row itself was never closed, and the brief says both. Archive only: the GOV-2C correction note.

## RW-75: Residual `N3`

Old, lines 2542-2542:

~~~old lines=2542-2542
| **N3 (execution-planner half)** | `GOV-2A`'s 2026-09-04 ruling: `packages/execution-planner/src/refusals.ts:178-187` claims "every public entry point of this package promises a typed result" while `buyLimitPrice`/`sellLimitPrice` (`src/price.ts`) throw `InvalidDecimalStringError` on non-canonical input; to be "corrected in text or guarded in code by the next bounded round touching each package". The trigger fired unmet: `WP-180-FU2` (`625c83b`, 2026-09-04 16:58, two hours after `GOV-2A` merged) edited `refusals.ts` itself (the import at `:17`) and left the claim. The `features` half is corrected by this round (`packages/features/src/inputs.ts`, comment only, superseded text quoted at the site). **The ruling's compliance mechanism failed because nothing checks it**: it lived in one paragraph of the record below and in `docs/handoffs/GOV-2A.md` `follow_up` 8, and no packet, gate or review checklist reads either | `docs/handoffs/GOV-2A.md` `follow_up` 8; `docs/handoffs/WP-190.md` R1-L1; `docs/contracts/schema-boundary.md` §5 item 13 | the next bounded grant on `packages/execution-planner/**` — and every packet dispatched for that package must now quote this row |
~~~

New:

~~~new
| `N3` | `GOV-2A`'s 2026-09-04 ruling: `packages/execution-planner/src/refusals.ts:178-187` claims every public entry point returns a typed result, but `buyLimitPrice`/`sellLimitPrice` (`src/price.ts`) throw `InvalidDecimalStringError` on non-canonical input. The claim is to be corrected in text or guarded in code; its first trigger (`WP-180-FU2`) fired unmet. | the next bounded grant on `packages/execution-planner/**`; every packet dispatched for that package must quote the archived row |
~~~

Keep (in both texts):

~~~keep
InvalidDecimalStringError on non-canonical input
every packet dispatched for that package must
~~~

**Facts.** Kept: the ruling date; the claim and the throwing functions with `InvalidDecimalStringError` on non-canonical input; correct in text or guard in code; the unmet `WP-180-FU2` trigger; the owner with "every packet dispatched for that package must quote" (now "the archived row"). The `features` half (corrected by GOV-2C) and the failed-compliance history are in Deviations > N3 and the archive.

## RW-76: Residual `N2`

Old, lines 2543-2543:

~~~old lines=2543-2543
| **N2 (order-book)** | `docs/contracts/schema-boundary.md` §3's `packages/order-book` row said "scalar parses only … no object parse, so no adoption/loss"; `book.ts:191` and `:265` both `safeParse` caller-supplied `input.payload` against object schemas and read `parsed.data`. Corrected in the contract by this round; the severity is unchanged because the reachability of a defeat on those two doors has NOT been measured | `docs/contracts/schema-boundary.md` §3 (the corrected row) | the next bounded grant on `packages/order-book/**`, which owes the measurement first |
~~~

New:

~~~new
| `N2` | `packages/order-book` `book.ts:191` and `:265` `safeParse` caller-supplied `input.payload` against object schemas and read `parsed.data`. The contract row is corrected (`schema-boundary.md` §3). The severity is unchanged, because whether a defeat on those two doors is reachable has not been measured. | the next bounded grant on `packages/order-book/**`, which owes the measurement first |
~~~

Keep (in both texts):

~~~keep
read parsed.data
the severity is unchanged
which owes the measurement first
~~~

**Facts.** Kept: the two doors, the caller-supplied payload, the object schemas and `parsed.data`; the corrected contract row; the unchanged severity and its reason; the measure-first owner. Archive only: the contract's old wording.

## RW-77: Residual `R8-1`

Old, lines 2544-2544:

~~~old lines=2544-2544
| **R8-1** | Every `Object.defineProperty` outside `packages/risk`/`capital-allocator` still passes an ordinary descriptor literal, which throws under an inherited `get` | the record below; `docs/contracts/schema-boundary.md` §5 item 12 (owner now named) | the detector/tooling round (§5 item 6) |
~~~

New:

~~~new
| `R8-1` | Every `Object.defineProperty` outside `packages/risk`/`capital-allocator` still passes an ordinary descriptor literal, which throws under an inherited `get`. | the detector/tooling round (`§5 item 6`) |
~~~

Keep (in both texts):

~~~keep
ordinary descriptor literal
throws under an inherited get
~~~

**Facts.** Kept: the ordinary descriptor literal outside `packages/risk`/`capital-allocator`, the inherited-`get` failure, and the owner. Archive only: the source cites (the record; `schema-boundary.md` §5 item 12).

## RW-78: Residual `§5 item 6`

Old, lines 2545-2545:

~~~old lines=2545-2545
| **§5 item 6** | The detector/tooling round — a `.safeParse`-on-unmaterialized-value detector and alias/cast/indirection hardening for the census and source scans (`WP-160` R1-N3, `WP-180` R9-1, R8-2 folded), plus the F15/F16/F17 checker implementation — deliberately last and deliberately not a CI gate today | `docs/contracts/schema-boundary.md` §5 item 6; `dependency-direction.md` §3 F15–F17 | unassigned; the orchestrator authorizes it |
~~~

New:

~~~new
| `§5 item 6` | The detector/tooling round: a `.safeParse`-on-unmaterialized-value detector; alias/cast/indirection hardening for the census and source scans (folding in `WP-160` R1-N3, `WP-180` R9-1 and R8-2); and the F15/F16/F17 checker. Deliberately last, and deliberately not a CI gate today. | unassigned; the orchestrator authorizes it |
~~~

Keep (in both texts):

~~~keep
alias/cast/indirection hardening
R9-1
deliberately not a CI gate today
~~~

**Facts.** Kept: the detector, the alias/cast/indirection hardening with the three folded findings (`WP-160` R1-N3, `WP-180` R9-1, R8-2), the F15/F16/F17 checker, "deliberately last" and "deliberately not a CI gate today", and the owner. Archive only: the source cites.

## RW-79: Residual `H8 track` -> Human items > H8

Old, lines 2624-2647:

~~~old lines=2624-2647
| **H8 track (`H8-GOV` → `CORE-MOVE` → `BACKTEST-2`)** | **COMPLETE 2026-09-28: B3 CLOSED** (`H8-GOV` `bb58edb`, `DEPCHECK-1` `d7f2906`, `CORE-MOVE` `33b7d0b`, `BACKTEST-2` `fd12be0`). Owed: the ADR-022 discharge note, in the next docs round. RULED by the user 2026-09-28: **option A**. Extract the paper core (the `createPaperTrader`/`CoreLoop` import closure: 24 files, about 10.9k lines, reaching only layer-0/1 packages plus zod, with no adapter, Node built-in, clock or process global — REPRODUCED) into a new layer-1 package that both `apps/trader` and `apps/backtest-cli` build from. Three rounds:
  - (1) **`H8-GOV`**:
    - `dependency-direction.md` §2, §2.1 (about 11 cited same-layer rows) and §6;
    - the pinned allowlist test;
    - a work-plan ratification, including the new path in WP-260/270/300 `forbidden_paths`;
    - ADR-022;
    - ideally F10 enforcement and a guard against relative cross-app imports (probe P8: `apps/backtest-cli/src` → `../../trader/src` passes `check:deps` today).
  - (2) **`CORE-MOVE`**: move only, about 40 files, with re-export facades and goldens BYTE-IDENTICAL. It needs an exclusive window: no other `apps/trader/src` grant in flight.
  - (3) **`BACKTEST-2`**:
    - the CLI's `run` command builds the real core;
    - one shared venue builder replaces main.ts's three test copies;
    - BT1-R1, BT1-R2 and BT1-R3.
  Open for `H8-GOV`'s scoping: the package name, a strategy-agnostic core (D4), the ADR's form, and ordering against `FOLD-2`.
  **Scoped 2026-09-28** (read-only workflow `wf_5375df07-cc2`: the contract/checker, move-plan and governance lenses, plus a synthesis).
  **User rulings (2026-09-28):**
    - the package is **`@polymarket-bot/trading-core`**;
    - **ADR-022 is written**;
    - the **H1 blockers go first** (`BUNDLE-1`, `SNAP-1`), then `H8-GOV` → an optional checker-hardening round → `CORE-MOVE` → `BACKTEST-2`;
    - **D4** (a strategy-agnostic core) waits for a second strategy, with S18 carrying a sunset clause;
    - **`FOLD-2`** runs after `BACKTEST-2`.
  **Key scoping facts:**
    - `H8-GOV` must STAGE the §2 fence line and rows S8–S18 in an unparsed form, because the checker fails closed on a package without a manifest. `CORE-MOVE` activates them.
    - `CORE-MOVE` moves 37 files byte-identical, re-points 2 tests, and cuts 63 lines from main.ts. Facades keep all 27 importers.
    - Two pinned tooling tests change (`dependency-direction.test.ts` :1017-1030 and :654-662). Option B (an app→app exception) was rejected; option C's wording is the interim state (see B3). | scoping `wf_b7a8d34d-4f9` h8 lens | after the BRACKET rounds |
~~~

New:

~~~new
- **H8**: ruled 2026-09-28, option A: extract the paper core into the layer-1 package `@polymarket-bot/trading-core`. Done by the `H8 track` (`H8-GOV` → `DEPCHECK-1` → `CORE-MOVE` → `BACKTEST-2`); `B3` is closed. Rulings still in force (user, 2026-09-28): D4, a strategy-agnostic core, waits for a second strategy, with S18 (the `trading-core` → `static-bracket` same-layer edge) carrying a sunset clause; `FOLD-2` runs after `BACKTEST-2`.
`BRACKET-1c`. The `H8 track` is complete; its rulings still in force are under
~~~

Keep (in both texts):

~~~keep
option A
@polymarket-bot/trading-core
waits for a second strategy
FOLD-2 runs after BACKTEST-2
~~~

**Facts.** COMPLETE; B3 closed. The r0 brief listed it in the open residual table; r1 moves it to Human items > H8. Kept: option A, the package name `@polymarket-bot/trading-core`, the four rounds, and the rulings still in force (D4 waits for a second strategy, with S18's sunset clause; `FOLD-2` after `BACKTEST-2`). S18 is named as the `trading-core` → `static-bracket` same-layer edge (`dependency-direction.md` §2.1). Archive only: "Owed: the ADR-022 discharge note" (discharged: `ADR022-DISCHARGE`, closed by `DOCS-1`), the extraction measurements, the per-round scope lists, the other rulings (ADR-022 written; H1 blockers first) and the key scoping facts.

## RW-80: Residual `Human items`

Old, lines 2648-2648:

~~~old lines=2648-2648
| **Human items** | **H1** a live-data paper run (after `BOOT-1` — and NOT attemptable until **B10** is closed: nothing produces `MarketOpened`, so the run would never leave `PENDING`); ~~**H2** a real GitHub Actions run~~ **DISCHARGED 2026-09-26 by `CI-1`** (PR #1 run `36282501033`, every gate green on GitHub; see `## Resolved evidence items`); **H3** a real Grafana import (**PERFORMED 2026-09-29** with H1 run 1: a real Prometheus and Grafana, the dashboards imported and rendering live values; graded by the closeout); **H1 run 1 ATTEMPTED 2026-09-29**, halted fail-closed on throughput, and is re-run after `THROUGHPUT-1`; *(2026-09-28, the user: the fresh read-only Wave 2 closeout audit runs AFTER H1 and H3. H5 is RULED (one demonstrated run). H7 is RATIFIED.)* **H4** elapsed soak evidence (Wave 1's carry-over, `WP-140` row); **H6** the authorization rows and round order (the orchestrator's, ongoing); ~~**H8**~~ **RULED 2026-09-28 by the user (option A; the H8 track in the residual queue; B3 accepted as qualified in the interim)** — as recorded 2026-09-16: the ruling `BACKTEST-1` needs to close **B3**: move the paper-core composition (`createPaperTrader`/`CoreLoop`, today in `apps/trader`) below layer 3 so both roots can construct it, or rule a cited §2.1 exception — `dependency-direction.md` §2 "Nothing may depend on an app" is the contract at stake | `docs/handoffs/GOV-2B-wave-2-closeout.md` "What only the human can discharge" | human |
~~~

New:

~~~new
- **H1**, the live-data paper run. Run 1 (2026-09-29, [`H1-RUN-1.md`](docs/handoffs/H1-RUN-1.md)) was registered with `REGISTER-1`, and its `gammaMarketId` was verified against both venue APIs. It ran 34 min on live data: 37,546 decisions and checkpoints, read back clean. It then halted fail-closed (`TRANSPORT_RESYNC_REQUIRED`) at the window open: the trader could not keep pace (about 35 decisions/s against about 735 events/s). No entry was evaluated. Re-run after `THROUGHPUT-2`.
- **H2**, a real CI run: discharged 2026-09-26 by `CI-1` (PR #1 run `36282501033`, every gate green).
- **H3**, a real Prometheus and Grafana: performed 2026-09-29 with H1 run 1. The fresh closeout grades it.
- **H4**, elapsed soak evidence: open. It is the `WP-140` gate, which closes only through the runbook §7 governance procedure after a real ≥24h soak.
- **H5**: ruled 2026-09-28: one demonstrated run. The runbook §7 "Wave 2 closeout" check "Static Bracket runs in replay and live-data paper mode through the same code" (`:509` at `f43efe6`) is discharged by one supervised live-data paper session through the real stack (gateway → Redis → trader → PostgreSQL) that produces decisions and reads back clean. Sustained accumulation is the post-closeout activity the same section describes next (`:514` at `f43efe6`).
- **H6**, the authorization rows and round order: the orchestrator's, ongoing.
- **H7**: ratified 2026-09-28 (`H7` above).
- **`§5 item 6`**: no owner yet; the orchestrator authorizes it.
- **The fresh read-only Wave 2 closeout audit** runs after H1 and H3 (user, 2026-09-28). It follows the runbook §10 wave closeout procedure (the old row cited §14, `:906` at `f43efe6`).
~~~

Keep (in both texts):

~~~keep
DISCHARGED 2026-09-26 by CI-1
the fresh read-only Wave 2 closeout audit runs AFTER H1 and H3
the authorization rows and round order
~~~

**Facts.** The old row holds three generations (2026-09-16, 2026-09-28, 2026-09-29); the brief states the latest of each item. Superseded inside the row: H1 "NOT attemptable until B10 is closed" (B10 closed 2026-09-17) and "re-run after `THROUGHPUT-1`" (now after `THROUGHPUT-2`); H8's 2026-09-16 wording and "B3 accepted as qualified in the interim" (see the `H8 track` pair). H2, H3, H4, H6 and the closeout-audit order are kept. H5's ruling text comes from the `H5` closeout row; its runbook cites are pinned to `f43efe6` and named by section. H4's closing rule comes from the `WP-140` row. §5 item 6's owner is a human item in the old header (line 5).

## RW-81: Residual `Wave 3 authorization (conditional)`

Old, lines 2649-2652:

~~~old lines=2649-2652
| **Wave 3 authorization (conditional)** | **The user, 2026-09-30:** "Just in case you end up finishing wave 3 blockers, please proceed with orchestrating wave 3 work itself." The orchestrator may start Wave 3 packages (`WP-260` first, then the workplan chain) **only after both of these hold**:
  - the fresh Wave 2 closeout audit (runbook :906) grades Wave 2 CLOSED;
  - `VENUE-3` merges (the phase-3 start gate).
Every Wave 3 package stays PAPER-only, built with fixtures, mocks and fault injection (runbook §8, "Critical rule"): no production wallet, signer, API credential or real-order test. If the closeout does not grade Wave 2 CLOSED, only the agent-closable blockers it names are worked, and Wave 3 does not start. | the user | orchestrator |
~~~

New:

~~~new
The user authorized Wave 3 on 2026-09-30, on a condition. The orchestrator may
start Wave 3 packages (`WP-260` first, then the work-plan chain) only when both
hold:
- the fresh Wave 2 closeout audit grades Wave 2 CLOSED;
- `VENUE-3` has merged (the phase-3 start gate).
Every Wave 3 package stays PAPER-only, built with fixtures, mocks and fault
injection (runbook §8, "Critical rule"): no production wallet, signer, API
credential or real-order test. If the closeout does not grade Wave 2 CLOSED, only
the agent-closable blockers it names are worked, and Wave 3 does not start.
~~~

Keep (in both texts):

~~~keep
grades Wave 2 CLOSED
no production wallet, signer, API credential or real-order test
Wave 3 does not start
~~~

**Facts.** Kept: both conditions, the order (`WP-260` first), PAPER-only with fixtures, mocks and fault injection, every prohibition, and the fallback. Archive only: the user's quoted words. "(runbook :906)" moved to the closeout-audit line under Human items, pinned to `f43efe6`.

## RW-82: Cross-package record, reconciled (still-live list)

Old, lines 2654-2692:

~~~old lines=2654-2692
### The cross-package record below, reconciled (2026-09-15)

The record's closing sentence — "every finding it names is still live on
`main`" — was written on 2026-09-04 and is now mostly false in the direction a
reader would hope: most of what it names has been closed by a merged door with
an independent review. It is kept verbatim as the evidence of what was found;
this list says what has happened to each named finding since. **Still live:**
`packages/domain` (frozen root cause — closed at each door per ADR-020 §3,
never itself edited, by design); `packages/order-book` (LIVE by inheritance,
and N2 above); the `features` INPUT-side records (prototype-bearing, no live
consumer route, `WP-160-FU1` review r1 N2); R8-1; §5 item 6; the two totality
claims (one corrected here, one open above); and every closed door's own
disclosed residuals, each owned in its handoff (`REC-1`'s D2-not-performed on
its doors and the `config-door` format-check follow-up; `CLOB-1`'s
`Array.prototype` arrays and the shared-materializer question → ADR-020
governance; `UNIV-3`'s direct-export caller-input round; `SETL-2`'s follow-up
hardening; `WP-060-FU1`'s `redis/transport.ts` epoch-cursor follow-up; the
`isFreshOrdinaryContainer` round for zod's own array assembly; the
strategy-runtime `modelOutputs` split collapse). **Closed, by which merge:**
`packages/ledger` and `packages/pnl` → `WP-200-FU1` `a30fec8` (2026-09-05);
`packages/strategy-runtime` → `WP-170-FU1` `d89841d` (2026-09-06);
`apps/data-gateway`'s two measured rows, `packages/binance-adapter`,
`packages/coinbase-adapter` and `packages/polymarket-public` rtds → `REC-1`
`327cae7` (2026-09-06); `packages/features` output side → `WP-160-FU1`
`5faf16b` (2026-09-06); `packages/polymarket-public` CLOB → `CLOB-1` `eb0c586`
(2026-09-07); `packages/settlement` → `SETL-1` `af991ee` + `SETL-2` `6142e66`
(2026-09-07); `packages/universe` → `UNIV-1` `4d7443b` + `UNIV-2` `f90ff05` +
`UNIV-3` `cbc1ed3` (2026-09-07); `packages/event-bus` → `WP-060-FU1` `d869868`
(2026-09-11); the `divDecimal` explicit-options hazard and the index-name
family → `WP-020-FU1` `edf6b1d` (2026-09-05); the mirror collapse →
`WP-180-FU2` `625c83b` (2026-09-04); ADR-021 end to end → `WP-180-FU3`
`8c14b47`, `ALLOC-1` `d9f70a6`, `TRDR-1` `65ae56c`; the inherited-`toJSON`
route the tally paragraph of `schema-boundary.md` §3 recorded as an OPEN
successor obligation → `SER-0` `9a44167` (measurement) and `SER-1` `c065d63`,
`SER-2` `0d8b6a0`, `SER-3` `603a49c` (2026-09-15; `schema-boundary.md` §5
item 11). The authoritative per-row state remains `docs/contracts/schema-boundary.md`
§3 (2 LIVE / 13 CLOSED / 5 outside, recounted 2026-09-11, unchanged by this
round).

~~~

New:

~~~new
The authority is `docs/contracts/schema-boundary.md` §3 (2 LIVE / 13 CLOSED / 5
outside, recounted 2026-09-11). Still live from the cross-package record
(reconciled 2026-09-15):
- `packages/domain`: the frozen root cause. It is closed at each door (ADR-020 §3) and never edited, by design.
- `packages/order-book`: live by inheritance, and `N2`.
- The `features` INPUT-side records: prototype-bearing, no live consumer route (`WP-160-FU1` r1 N2).
- `R8-1`, `§5 item 6`, and the open totality claim `N3`.
- Each closed door's disclosed residuals, owned in its handoff: `REC-1` (D2 not performed; the `config-door` format check), `CLOB-1` (`Array.prototype` arrays; the shared-materializer question, for ADR-020 governance), `UNIV-3` (the direct-export caller-input round), `SETL-2` (follow-up hardening), `WP-060-FU1` (the `redis/transport.ts` epoch cursor), the `isFreshOrdinaryContainer` round (zod's own array assembly), and the strategy-runtime `modelOutputs` split collapse.
~~~

Keep (in both texts):

~~~keep
isFreshOrdinaryContainer
modelOutputs split collapse
2 LIVE / 13 CLOSED / 5 outside
~~~

**Facts.** Kept: the whole "Still live" list and the authority with its counts. "one corrected here" (the `features` totality claim, corrected by GOV-2C) is closed, so only `N3` is listed. Archive only: the "Closed, by which merge" list; every merge it names is in the Work packages table. The 2026-09-03 record below it (lines 2693-2912) is history, archived whole.

## RW-83: Wave 2 qualification

Old, lines 2355-2365:

~~~old lines=2355-2365


Eleven rows in the table above — `WP-150`, `WP-160`, `WP-170`, `WP-180`,
`WP-190`, `WP-200`, `WP-210`, `WP-220`, `WP-230`, `WP-240`, `WP-250` — read
**Complete** without qualification, and the header sentence says "Wave 2
package work COMPLETE". Both are true of exactly one thing: **each package met
its OWN acceptance criteria**, which `GOV-2B` re-verified on 2026-09-15 against
a named, currently-passing test per criterion, with every merge SHA an ancestor
of `main`. A reader who takes those rows to mean "the paper core works end to
end" will be wrong, and the closeout found that no row says so. The
qualification is placed here, where the wave is met as a whole, rather than in
~~~

Old, lines 2400-2439:

~~~old lines=2400-2439
   pointed `test:replay` at real files. What remains: `GATE1-M1` — the
   `test:replay` list is hand-maintained and can silently shrink back to the
   N4 defect (below).

3. **No gate has ever run anywhere but one laptop.** `git remote -v` is EMPTY
   across the whole history (re-verified 2026-09-15 by this round);
   `.github/workflows/ci.yml` has never executed once; every gate claimed in
   every row of this file — Wave 0, Wave 1 and Wave 2 — was run locally by the
   orchestrator, an implementer or a reviewer on one machine. "Post-merge gates
   green" in any row means exactly that and nothing more (`GOV-2B` H2; also
   `## Pending external evidence`). The Testcontainers-backed integration
   suites ran only in the sessions where Docker was available.
   *(Superseded 2026-09-26 by `CI-1`: the repository gained a GitHub remote,
   `adriancova/polymarket-bot-v2`. Its first run, `36279491795` on `926cd08`,
   failed at "Unit tests" with every test passing and skipped seven gates;
   PR #1 run `36282501033` on `fad38e2` ran every gate on a GitHub-hosted
   runner and all passed, the six integration suites included. Counts in rows
   dated before 2026-09-26 remain laptop numbers.)*

Two further facts a reader should carry: Wave 2's completion **unblocks nothing
new**. *(Restated 2026-09-15 in GOV-2C remediation r1, review finding GOV2C-1.
The sentence previously read: "`GOV-2B` parsed the `depends_on` graph and no
package depends on `WP-150`…`WP-250` except `WP-250` itself and `WP-360`" —
copied from the closeout and FALSE as a literal claim: re-parsing
`docs/spec/polymarket-bot-workplan.yaml` at `1aa2238`, `WP-270` depends on
`[WP-190, WP-200, WP-260]`, `WP-290` on `[WP-200, WP-270, WP-280]`, `WP-300`
on `[WP-000, WP-200, WP-260]` and `WP-360` on `[WP-210, WP-350]`, besides the
intra-wave edges.)* The true statement, and the one the conclusion rests on:
exactly four packages outside Wave 2 depend directly on a Wave 2 package —
`WP-270`, `WP-290`, `WP-300` (phase-3) and `WP-360` (phase-4) — and **every one
of them also depends on `WP-260`**, directly (`WP-270`, `WP-300`) or
transitively (`WP-290` via `WP-270`; `WP-360` via `WP-350` → `WP-340` → the
phase-3 chain), so closing Wave 2 releases none of them; `WP-260` itself is
held by wave ordering and the signer boundary, not by any Wave 2 row. And the four
completion records `WP-220`, `WP-230`, `WP-240` and `WP-250` do not carry the
eight required handoff fields as labelled sections (`## Deviations from
specification`, N6), so a reader looking for a `known_risks` heading in them
will not find one — their residuals are under "Accepted disclosed residuals"
and "Follow-ups (owned)".

~~~

New:

~~~new
A Wave 2 row that reads "Complete" means the package met its own acceptance
criteria (re-verified by `GOV-2B` on 2026-09-15). It does not mean the paper core
works end to end. Closing Wave 2 releases no new package: the four packages
outside Wave 2 that depend directly on a Wave 2 package (`WP-270`, `WP-290`,
`WP-300`, `WP-360`) all also depend on `WP-260`, directly or transitively.
`WP-260` itself is held by wave ordering and the signer boundary. Gate counts in
rows dated before 2026-09-26 come from one laptop; CI first ran with `CI-1`.
Full text:
[`wave-2-qualification.md`](docs/status-archive/wave-2-qualification.md).
~~~

Keep (in both texts):

~~~keep
held by wave ordering and the signer boundary
~~~

**Facts.** Kept: what "Complete" means; that closing Wave 2 releases nothing, with the four packages and the direct or transitive `WP-260` dependency; that `WP-260` is held by wave ordering and the signer boundary; laptop-only counts before 2026-09-26. Archive only: fact 1 (the §7 grading as of 2026-09-15; the current grading is in Current phase), fact 2 (the evidence tree ungated until `GATE-1`; its remainder is `GATE1-M1`), the GOV2C-1 correction note, and the N6 heading note (in the N6 deviation line).

## RW-84: Deviation (line 2915)

Old, lines 2915-2915:

~~~old lines=2915-2915
- Root `eslint.config.mjs` was outside WP-010's literal `allowed_paths`; ratified into WP-010 ownership (see completion record).
~~~

New:

~~~new
- `WP-010`: the root `eslint.config.mjs` was outside its `allowed_paths`; ratified into WP-010 ownership.
~~~

Keep (in both texts):

~~~keep
ratified into WP-010 ownership
~~~

**Facts.** Kept: outside WP-010's `allowed_paths`, ratified into WP-010 ownership. Archive only: "(see completion record)".

## RW-85: Deviation (line 2916)

Old, lines 2916-2916:

~~~old lines=2916-2916
- Node 24 pin is `engines: ">=24"` + CI `node-version: 24` + runtime smoke assertion, not an exact `.nvmrc` pin; acceptable for WP-010, tighten later if needed.
~~~

New:

~~~new
- `WP-010`: Node 24 is pinned by `engines: ">=24"`, CI `node-version: 24` and a runtime smoke assertion, not an exact `.nvmrc`. Acceptable; tighten later if needed.
~~~

Keep (in both texts):

~~~keep
tighten later if needed
~~~

**Facts.** Kept: the three pin mechanisms, no exact `.nvmrc`, acceptable, tighten later if needed. Nothing else in the bullet.

## RW-86: Deviation (line 2917)

Old, lines 2917-2917:

~~~old lines=2917-2917
- WP-000 verification report filename: workplan literally names `docs/venue/verified-2026-08-18.md` (plan-generation date), but handoff §1.2 requires `verified-YYYY-MM-DD.md` dated to the actual verification. **Ratified by orchestrator 2026-08-24**: the report is `docs/venue/verified-2026-08-24.md`; the workplan literal is treated as a template dated at plan generation. Flagged by independent review (M2) as requiring explicit ratification — recorded here.
~~~

New:

~~~new
- `WP-000`: the venue report is `docs/venue/verified-2026-08-24.md`, not the work plan's literal `verified-2026-08-18.md`. Ratified by the orchestrator 2026-08-24. The rule: handoff §1.2 requires `verified-YYYY-MM-DD.md` dated to the actual verification; a work-plan literal is a template dated at plan generation.
~~~

Keep (in both texts):

~~~keep
dated to the actual verification
template dated at plan generation
~~~

**Facts.** Kept: the actual and literal filenames, the ratification date, and the rule (handoff §1.2's actual-verification date; a work-plan literal is a template dated at plan generation). Archive only: the independent review's M2 flag that asked for explicit ratification.

## RW-87: Deviation (line 2918)

Old, lines 2918-2918:

~~~old lines=2918-2918
- **N6 — four Wave 2 completion records carry none of the required handoff fields as labelled sections (recorded 2026-09-15 by `GOV-2C`; `GOV-2B` N6).** `docs/handoffs/WP-220.md`, `WP-230.md`, `WP-240.md` and `WP-250.md` are written as "completion records" with the sections Lifecycle / Gates / Accepted disclosed residuals / Follow-ups (owned) (WP-250: "The acceptance criteria, as frozen" / "Key findings recorded" / "Accepted residuals / notes"), whereas every primary record from `WP-000` through `WP-210` carries `summary`, `files_changed`, `tests_run`, `assumptions`, `deviations`, `known_risks`, `follow_up`, `commit_sha` as headings. **Measured extent, wider than the closeout's four** (a heading grep over `docs/handoffs/` at `1aa2238`): the completion-record form is also used by every follow-up record except `WP-180-FU2` (which carries seven of eight, lacking `assumptions`) — `WP-020-FU1`, `WP-060-FU1`, `WP-160-FU1`, `WP-170-FU1`, `WP-180-FU3`, `WP-200-FU1`, `WP-200-FU2` — and by every bounded round since 2026-09-06 that is not a governance round: `REC-1`, `ALLOC-1`, `TRDR-1`, `TRDR-2`, `UNIV-1/2/3`, `SETL-1/2`, `CLOB-1`, `SER-0/1/2/3`, `GATE-1`, `RISK-2`. Only `GOV-1B/1C/1D/2A` carry the eight; `GOV-2B` is an audit report. So the four are not outliers; the form became the de facto standard for bounded rounds from 2026-09-05. The content is present under other names (residuals, gates, the merge and candidate SHAs in the header) and each record was the input to an independent review that accepted it, so this is recorded as a **dated deviation from `protected-contracts.md` §6's form**, not rewritten — the records are history and are the evidence their reviews were run against. Also resolved here, because the deviation cannot be graded without it: the two controlling documents DISAGREE on the field list — `docs/spec/polymarket-bot-workplan.yaml` `required_handoff_fields` lists seven (it transcribes handoff §18.2's packet template) and `AGENTS.md` "Required work-package handoff" lists eight (adding `commit_sha`). **`AGENTS.md` controls** — it is the repository operating rule that binds every agent, it is a strict superset, `commit_sha` is the one field the §18.4 merge protocol cannot verify a record without, and `protected-contracts.md` §6 already reads the two as a union of eight. The resolution is recorded as a dated comment above `required_handoff_fields` in the work plan (the list itself is not edited: a governance round writes ratification entries, not plan data). What this round does NOT decide, because it is the human's H7 item and the measured extent makes it a practice change rather than four exceptions: whether the completion-record form is sanctioned as an alternative with a stated mapping onto the eight fields (Lifecycle → `commit_sha`/`files_changed`; Gates → `tests_run`; Accepted disclosed residuals → `known_risks`; Follow-ups (owned) → `follow_up`; with `assumptions` and `deviations` the two fields the form most often leaves implicit), or whether the eight labelled sections are required again from the next dispatch. Until the orchestrator rules, the eight-field list in `AGENTS.md` is the requirement as written, and a record in the other form is a disclosed deviation, not a compliant record.
~~~

New:

~~~new
- **N6**: four Wave 2 records, and most bounded rounds since 2026-09-05, use the completion-record form instead of the eight labelled fields. Recorded 2026-09-15 (`GOV-2C`); `AGENTS.md`'s eight fields control; the form was ratified by the user 2026-09-28 (H7).
~~~

Keep (in both texts):

~~~keep
completion-record form
~~~

**Facts.** Kept: the form, the extent (four Wave 2 records plus most bounded rounds from 2026-09-05), recorded by GOV-2C, `AGENTS.md` controls. "ratified 2026-09-28 (H7)" comes from the H7 row. Archive only: the per-record list, the field mapping, the work-plan comment detail.

## RW-88: Deviation (line 2919)

Old, lines 2919-2919:

~~~old lines=2919-2919
- **N7 — ten Wave 2 merges and `GATE-1` touched the protected `pnpm-lock.yaml`; one was ratified in the work plan (recorded and ratified 2026-09-15 by `GOV-2C`; `GOV-2B` N7).** Measured at `main` `1aa2238` by `git log --first-parent main -- pnpm-lock.yaml` and a per-merge diff against each merge's first parent: **ten of the eleven Wave 2 merges** touched the lockfile — `WP-150` `70c7f1f` (+13), `WP-200` `7e75f9a` (+38), `WP-170` `9d0971b` (+11), `WP-180` `98a6cc1` (+32), `WP-190` `5aa11e3` (+7), `WP-160` `3d49946` (+13), `WP-210` `bebdd85` (+23), `WP-220` `b8f7864` (+7), `WP-230` `8425e03` (+58), `WP-240` `0e7227d` (+25) — every one insertions-only with every hunk inside the `importers:` section (workspace `link:` entries and already-pinned dev-tool references; no new `packages:`/`snapshots:` entry); `WP-250` `ce7fbe0` did not touch it. *(The closeout wrote "nine of eleven"; the measurement says ten — the closeout undercounted by one, and the packet's "ten Wave 2-era merges (nine plus GATE-1)" carried the undercount. Recorded so the number quoted is the measured one.)* Each touch was disclosed in the package's handoff and verified in its row here (the `WP-230` and `WP-240` rows say RATIFIED outright), but `protected-contracts.md` §5 step 2 — the dated entry inside the package's `allowed_paths` — was written only for `WP-220` (2026-09-05). **Ratified retroactively**, on the `WP-220` precedent (itself on `WP-020`'s): nine dated entries now sit in the work plan's `WP-150`…`WP-240` `allowed_paths`, each quoting the measured insertion count and stating the entry was absent when the package ran. The pattern is ratified as a PATTERN: a package declaring its own workspace and dev dependencies may update its own importer block, and future packages cite this entry instead of re-litigating. **`GATE-1` `0434c82` is different and is recorded, not ratified here**: its touch is a 4+/4− SUBSTITUTION in the `packages:` and `snapshots:` sections (`js-yaml 4.3.1 → 4.3.2`, clearing `GHSA-2883-xcg3-v3hh`), not an importer block; it was authorized for exactly that purpose in its `IMPLEMENTATION_STATUS.md` row, reviewed (all 405 lockfile keys diffed, the integrity hash checked against the registry, `--frozen-lockfile` proven to accept the pin), and `GATE-1` has no work-plan entry to carry a §5 step-2 comment — the ledger row is its ratification. A version bump of a transitive dependency is a different shape from an importer-block addition and does not fall under the pattern ratified above. *(Coverage limit, GOV-2C remediation r1, GOV2C-9: seven further Wave 2-era first-parent lockfile touches were made by rounds that have NO work-plan entry to carry a §5 step-2 comment — `WP-180-FU2` `625c83b`, `WP-200-FU1` `a30fec8`, `WP-020-FU1` `edf6b1d`, `WP-170-FU1` `d89841d`, `SER-1` `c065d63`, `SER-2` `0d8b6a0`, `SER-3` `603a49c` — each disclosed and importer-block-only (measured: six insertions-only; `WP-020-FU1`'s is the one-line exact pin of `decimal.js`, `^10.6.0` → `10.6.0`, in `packages/decimal`'s importer block), and `WP-180-FU2`'s is additionally ratified in `dependency-direction.md` §2.1's mirror-collapse subsection); the pattern ratified here covers them by precedent, but the work-plan entry that would record it does not exist for them, and this ledger row is the only place that says so.)*
~~~

New:

~~~new
- **N7**: ten Wave 2 merges touched `pnpm-lock.yaml` importer blocks. Ratified 2026-09-15 as a pattern (`GOV-2C`): a package that declares its own workspace and dev dependencies may update its own importer block, and later packages cite that entry. Seven more touches by rounds with no work-plan entry are covered by precedent only. `GATE-1`'s `js-yaml` substitution is recorded, not covered by the pattern.
~~~

Keep (in both texts):

~~~keep
may update its own importer block
precedent
~~~

**Facts.** Kept: ten merges, importer blocks, the pattern and its rule (a package declaring its own workspace and dev dependencies may update its own importer block; later packages cite the entry), the seven further touches covered by precedent only, and `GATE-1`'s substitution recorded but not covered. Archive only: per-merge insertion counts, the "nine of eleven" correction and the seven rounds' names.

## RW-89: Deviation (line 2920)

Old, lines 2920-2920:

~~~old lines=2920-2920
- **N9 — `WP-200` declares an `allowed_path` that does not exist (recorded 2026-09-15 by `GOV-2C`; `GOV-2B` N9).** `docs/spec/polymarket-bot-workplan.yaml` `WP-200` `allowed_paths` names `test/integration/ledger/**`; `WP-200` (merged `7e75f9a`) wrote no such tree and none exists at `main` `1aa2238` (`test/integration/` holds `control-api`, `data-gateway`, `event-bus`, `paper-trader`, `parquet`, `postgres`). A grant that authorizes nothing is not a deviation; it is recorded by a dated comment at the entry and here so a later reader does not go looking for the tree.
~~~

New:

~~~new
- **N9**: `WP-200`'s `allowed_paths` names `test/integration/ledger/**`, which does not exist. Recorded 2026-09-15. A grant that authorizes nothing is not a deviation.
~~~

Keep (in both texts):

~~~keep
A grant that authorizes nothing is not a deviation
~~~

**Facts.** Kept: the nonexistent path, the date, and the rule that a grant authorizing nothing is not a deviation. Archive only: the list of trees that do exist and the dated-comment location.

## RW-90: Deviation (line 2921)

Old, lines 2921-2921:

~~~old lines=2921-2921
- **N11 — `BACKTEST-1` touched the protected root `package.json` (one line) under a grant that omitted it (recorded and ratified 2026-09-16 by the orchestrator at merge `b462501`).** The row's ACCEPTANCE required "the determinism assertion wired into `pnpm test:replay`", and that script lives in the protected root `package.json`; the row's path column listed `apps/backtest-cli/**`, `packages/simulation/**`, `test/unit/simulation/**`, `test/replay-golden/**` and the lockfile's importer blocks, not `package.json`. Measured: `git diff 1aa2238 eb0b1ee -- package.json` is one changed line, the `test:replay` list gaining `test/unit/simulation/backtest-static-bracket-replay.test.ts`; nothing else in the file. The orchestrator's packet, not the implementer, is at fault; the reviewer recorded the touch in its scope check without flagging it. Ratified for that line only — the same positional list `GATE1-M1` already names as hand-maintained. Owner of the class: the orchestrator (every acceptance criterion that names a script must grant the file the script lives in).
~~~

New:

~~~new
- **N11**: `BACKTEST-1` changed one line of the protected root `package.json` (`test:replay`). Ratified 2026-09-16 for that line. The orchestrator owns the class: every acceptance criterion that names a script must grant the file the script lives in.
~~~

Keep (in both texts):

~~~keep
every acceptance criterion that names a script must grant the file the script lives in
~~~

**Facts.** Kept: the one line, the ratification date and scope, and the orchestrator's class obligation (every acceptance criterion that names a script must grant the file the script lives in). Archive only: the grant's path list and the measurement command.

## RW-91: Deviation (line 2922)

Old, lines 2922-2922:

~~~old lines=2922-2922
- **N3 — a ruling's compliance mechanism failed, twice (recorded 2026-09-15 by `GOV-2C`; `GOV-2B` N3).** `GOV-2A` ruled on 2026-09-04 that two totality claims be corrected or guarded "by the next bounded round touching each package". Both triggers fired unmet: `WP-180-FU2` (`625c83b`, 2026-09-04 16:58) touched `packages/execution-planner/src/refusals.ts` two hours after the ruling merged and left the claim at `:178-187`; `WP-160-FU1` (`5faf16b`, 2026-09-06) touched `packages/features` and left `inputs.ts`'s "never throws" — its own record, `docs/handoffs/WP-160-FU1.md` follow-up 3, states only that R1-L1 and R1-L2 "remain open, untouched here" and gives no reason; `inputs.ts` WAS inside that round's grant (`packages/features/**`), so this was not a path constraint. *(GOV-2C remediation r1, GOV2C-7: the first version spliced that sentence with follow-up 1's "Doc paths were outside this round's grant", which refers to the contract-document flips, not to `inputs.ts`, and so implied a justification the record does not offer.)* The mechanism failed because **nothing checks a ruling expressed as "by the next round touching X"**: it is not in any packet template, gate or review checklist, and its only records were one paragraph in this file's cross-package subsection and `GOV-2A`'s `follow_up` 8. This round corrects the `features` claim (comment only, superseded text quoted at the site) and records the `execution-planner` claim in `## Open blockers` with the instruction that every packet for that package quote the row. The systemic fix — a ruling with a "next round touching X" trigger must ALSO be written into that package's work-plan entry as a dated comment, where a packet author reads it — is proposed, not applied: `GOV-2C`'s grant on the work plan is ratification entries only, and `packages/execution-planner` has no open package entry to carry it.
~~~

New:

~~~new
- **N3**: a ruling of the form "by the next round touching X" failed twice, because nothing checks it. The systemic fix (a dated comment in the package's work-plan entry) is proposed, not applied: `GOV-2C`'s work-plan grant covered ratification entries only.
~~~

Keep (in both texts):

~~~keep
is proposed, not applied
~~~

**Facts.** Kept: the mechanism failure, the proposed and unapplied systemic fix, and why it was not applied (`GOV-2C`'s work-plan grant covered ratification entries only). Archive only: the two trigger events (`WP-180-FU2` `625c83b`; `WP-160-FU1` `5faf16b`) and the GOV2C-7 correction; the open half is the `N3` residual row.

## RW-92: Pending external evidence: the CI bullet

Old, lines 2926-2926:

~~~old lines=2926-2926
- `.github/workflows/ci.yml`: YAML-validated only — a real GitHub Actions run is pending. *(Strengthened 2026-09-15 by `GOV-2C`, `GOV-2B` H2: this is not merely pending — `git remote -v` is EMPTY across the whole history, so the workflow has never executed once, and every gate claimed in every row of this file was run on one laptop. `GATE-1` made `pnpm run audit` exit 0 and gated `test/e2e/**` by a CI step, so a first real run is no longer known to fail at `ci.yml:58`; whether it passes is unknown until it runs.)* *(DISCHARGED 2026-09-26 by `CI-1` — see `## Resolved evidence items`.)*
~~~

New:

~~~new
- The real GitHub Actions run (2026-09-26, `CI-1`). The first run (`36279491795`, on `926cd08`) failed at "Unit tests" on a vitest worker RPC timeout, with all 7217 tests passing, and skipped seven gates. PR #1 run `36282501033` passed every job, the six integration suites included.
~~~

**Facts.** Discharged 2026-09-26 by `CI-1`; the bullet already said so. It leaves Pending and appears once, under Resolved (MOVE-MAP sends it there). Archive only: its history ("`git remote -v` is EMPTY", strengthened by GOV-2C; the `ci.yml:58` note).

## RW-93: Pending external evidence: C-2 reopen

Old, lines 2928-2928:

~~~old lines=2928-2928
- **The register's C-2 reopen condition is MET (recorded 2026-09-17 at the `VENUE-2` merge; `verified-2026-09-16.md` D-15).** `docs/contracts/protected-contracts.md` (C-2, `:254`) reads "any venue assertion of equivalence or conversion … authorizes an explicit recorded conversion, never a fold"; the venue now asserts a conversion mechanism — the pUSD page: "standard ERC-20 wrapper that represents a USDC claim. Wrapping and unwrapping are enforced onchain by the `CollateralOnramp` and `CollateralOfframp` contracts", `_asset` "Must be USDC.e"; the bridge deposit page ("wrapped into pUSD via the Collateral Onramp") and the resolution page ("receives the released USDC.e collateral, wraps it into pUSD") agree. Three names are in play (USDC / USDC native / USDC.e) and the Bridge API labels the pUSD address `"symbol": "USDC"`. The report records and does not act; the operative rulings (ADR-006 fail-closed) are unaffected. **Owner: the register/ADR-006 contract owner** — a dated amendment recording the conversion, in a governance round with `docs/adr/**` and `docs/contracts/protected-contracts.md` in grant. Also for that owner: U-11 (D-20) — the SDK's closed five-value `UmaResolutionStatus` enum at both commits while the docs still say nullable string.
~~~

New:

~~~new
- **C-2's reopen condition is met** (2026-09-17, `VENUE-2`; `verified-2026-09-16.md` D-15). The register's C-2 says any venue assertion of equivalence or conversion authorizes an explicit recorded conversion, never a fold. The venue now documents a conversion: pUSD is an ERC-20 wrapper representing a USDC claim, wrapped and unwrapped onchain by the `CollateralOnramp` and `CollateralOfframp` contracts, and its `_asset` must be USDC.e. The bridge deposit and resolution pages agree. Three names are in play (USDC, USDC native, USDC.e), and the Bridge API labels the pUSD address `"symbol": "USDC"`. The report records this and does not act; the ADR-006 fail-closed rulings are unaffected. Owner: the register/ADR-006 contract owner, through a dated amendment recording the conversion, in a governance round with `docs/adr/**` and `docs/contracts/protected-contracts.md` in grant. Also for that owner: U-11 (D-20), the SDK's closed five-value `UmaResolutionStatus` enum at both commits against the docs' nullable string.
~~~

Keep (in both texts):

~~~keep
an explicit recorded conversion, never a fold
CollateralOnramp
at both commits
a dated amendment recording the conversion
~~~

**Facts.** Kept: the date and source (D-15); the register rule "an explicit recorded conversion, never a fold"; the conversion mechanism with both contracts and USDC.e; that the bridge and resolution pages agree; the three names and the Bridge API label; records-and-does-not-act; ADR-006 unaffected; the owner and the amendment's form; U-11 (D-20) at both commits. Archive only: the verbatim venue quotes and the register line cite (`protected-contracts.md` C-2 `:254`).

## RW-94: Pending external evidence: H4 (new line)

New:

~~~new
- **H4**, the ≥24h soak for `WP-140` ([Human items](#human-items)).
~~~

**Facts.** New cross-reference: the soak was pending only in the `WP-140` row and the Human items row.

## RW-95: Resolved evidence items

Old, lines 2932-2933:

~~~old lines=2932-2933
- `.github/workflows/ci.yml` real GitHub Actions run (2026-09-26, `CI-1`): the first run on the new remote (`36279491795`, push of `926cd08`) FAILED at "Unit tests" — 331 files / 7217 tests passed, then `[vitest-worker]: Timeout calling "onTaskUpdate"` (a synchronous child process blocked the worker past vitest's 60 s RPC timeout) — and the fail-fast chain skipped seven gates. After `CI-1`, PR #1 run `36282501033` (`pull_request`, head `fad38e2`): all three jobs `success` — typecheck, lint, check:deps, unit 332 / 7221, e2e, replay, fault, contract, soak-smoke, audit, all six integration suites (Testcontainers on the runner), the compose health job and the python job.
- `docker-compose.yml` runtime validation (2026-08-22): Docker 29.1.2 / Compose v2.40.3 became available; `docker compose config` valid, `docker compose up -d --wait` brought both services to healthy (`pg_isready` accepting connections, `redis-cli ping` → PONG), both ports confirmed bound to 127.0.0.1 only. Host ports made overridable (`PMB_POSTGRES_PORT`, `PMB_REDIS_PORT`, defaults 5432/6379 unchanged) because this machine has a native PostgreSQL on 5432; validated with `PMB_POSTGRES_PORT=15432`. Stack torn down after verification.
~~~

New:

~~~new
- The real GitHub Actions run (2026-09-26, `CI-1`). The first run (`36279491795`, on `926cd08`) failed at "Unit tests" on a vitest worker RPC timeout, with all 7217 tests passing, and skipped seven gates. PR #1 run `36282501033` passed every job, the six integration suites included.
- `docker-compose.yml` runtime validation (2026-08-22): both services healthy, both ports bound to 127.0.0.1 only. Host ports are overridable (`PMB_POSTGRES_PORT`, `PMB_REDIS_PORT`).
~~~

Keep (in both texts):

~~~keep
36279491795
127.0.0.1 only
~~~

**Facts.** Archive only: the job-by-job list for PR #1 (typecheck, lint, check:deps, unit 332 / 7221, e2e, replay, fault, contract, soak-smoke, audit, compose health, python), head `fad38e2`, the 331-file count and the 60 s RPC-timeout cause, the Docker/Compose versions, the default ports and the `PMB_POSTGRES_PORT=15432` validation, and the teardown. Kept: both runs with ids, the failure and the pass.

## RW-96: Accepted evidence

Old, lines 2320-2320:

~~~old lines=2320-2320
- WP-010 automated gate: install/typecheck/lint/test pass on `main` at `12ce0ab` (2026-08-22), reproduced independently by the adversarial reviewer at `1bca7cf`.
~~~

New:

~~~new
- Accepted evidence: the `WP-010` automated gate (install, typecheck, lint, test) passed on `main` at `12ce0ab` (2026-08-22), reproduced independently by the adversarial reviewer at `1bca7cf`.
~~~

Keep (in both texts):

~~~keep
reproduced independently by the adversarial reviewer
~~~

**Facts.** Moved under Resolved evidence items. Kept: install/typecheck/lint/test, `main` at `12ce0ab` (2026-08-22), reproduced independently by the adversarial reviewer at `1bca7cf`.
