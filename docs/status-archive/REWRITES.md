# Status archive: rewrites

<!-- rewrites-base: f43efe61d6501b0e49adc08b037f00b72937d294 -->

Every live sentence of `IMPLEMENTATION_STATUS.md` at `f43efe6` that the brief restates, as old -> new pairs. The old text is also archived verbatim, so preservation does not depend on this file; it lets a reviewer check each rewrite.

Each entry has:

- `old` blocks: base lines, verbatim. Line numbers refer to the pinned `rewrites-base` above, so they stay valid after the archive is re-cut. A block quoting a later cut names it (`~~~old base=<sha> lines=a-b`).
- a `new` block: the brief's lines.
- a `keep` block (for every open or live row): phrases that must occur in both the old and the new text.
- a **Facts** account. It identifies the facts the new text keeps, and locates each omitted fact in another brief section or the archive. "Row" means the archived row; "archive only" means the fact is only in the archive.
- `excerpt` blocks (in place of `old`, entries RW-97 onward): part of a base line, verbatim. They pair the live residuals of a Complete package row whose line stays declared `complete-row` below, or of a completion-record item declared `record-item`.
- `drop` blocks (r4): `<verbatim fragment> => <reason>` lines, one per residual clause the brief does not carry. The reason is `closed-by` a Complete package, `brief:` the brief heading where the fact already is, or `history:` with why it owes nothing.
- no `new` block (r6: RW-102 and RW-105): everything the entry carried until r5 was closed before the cut. Its drop lines give the evidence, and its declaration no longer says `carried`.

What the checks prove, and what they do not. `tools/records/check-preservation.py` checks that:

- each old block is verbatim, each excerpt and drop fragment is base text, and each new line is in the brief (C6);
- every base line is paired or declared below (C8);
- no two entries share a Facts account (C9);
- each keep phrase is in both texts (C10);
- each archive file named in a Facts account holds at least one of that entry's old or excerpt lines (C11);
- a `complete-row` whose base row mentions a residual or follow-up carries a checked disposition (C12);
- a Facts reference "<brief heading> (RW-NN)" points at an entry whose new lines sit under that heading (C13);
- a history range holds no completion-record item that names an obligation; each such item is declared `record-item` with a disposition (C14);
- every residual clause of a dispositioned row or record item, and of every excerpt, holds an accounting marker: a keep phrase, a queued or listed id, a closing package, or a drop fragment (C15);
- a clause accounted for by a keep phrase keeps its code spans and measured numbers (such as `248ns`) in the entry's new text, or names them in a drop line (C16).

C15 checks that a clause holds a marker, not that the marker covers the whole clause. For example, cutting "off-host needs TLS and stronger credentials." to "off-host needs TLS." still passes. Reviewers must check the rest of each clause. Whether a rewrite, a disposition or a drop reason is true is a review question; the checks do not decide it.

## Coverage: base lines not included in a rewrite pair

Every non-blank base line is either in an entry's old block or declared here, with one of these kinds:

| Kind | What it declares | Checked by |
| --- | --- | --- |
| `verbatim` | The line is in the brief unchanged. | C8: the line is in the brief. |
| `complete-row` | A Complete or Superseded package row. Its one-line brief row is derived as the table-header entry says. | C8: the range is exactly that package row, Complete or Superseded in the base row's status cell and in the brief. |
| `closed-row` | A closed, done or ruled residual or blocker row, named in the brief's closed lists. | C8: the range is exactly that row, named in the brief's closed lists, and closed in the base (see below). |
| `history` | No live content: the range holds no package or blocker row, and no record item that matches C14's obligation pattern. | C14: no such record item lies inside. |
| `record-item` | Exactly one bullet or paragraph of a completion record that names an obligation. | C14: the range is one item, with a disposition. |

**Dispositions.** A `complete-row` whose base row mentions a residual, a follow-up, or a queued, owed, carried or deferred item ends with a disposition after " — ". So does every `record-item`. Its clauses are separated by "; ":

- `carried RW-NN`: an entry below pairs an excerpt of its live residuals;
- `queued` or `listed` ids: named in the brief's Open blockers, Human items or Deviations;
- `closed-by` packages: Complete in the brief;
- `none:` with a reason.

A row that names owned or carried residuals needs more than `none:` (C12). A `record-item` that names carried items or obligations may not be `none:` alone (C14).

**Closed in the base.** For a `closed-row`, C8 takes the base row as closed when a one-line row's last cell begins with a bold closure word (CLOSED, COMPLETE, DONE, RULED, DISCHARGED, MOOT, RATIFIED, SUPERSEDED), when a multi-line row holds such a bold phrase, or when the id is a package that is Complete in the base.

A row that is closed in part and still carries such a marker can pass this test while open. For example, at the first cut `H1R1-FRAME-ATOMICITY` was RULED, yet open until `THROUGHPUT-2` merged. The brief's open tables and the pairing rule catch it only if the brief still lists it. That remains a review question.

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
35-35 complete-row `GOV-1B` — closed-by `GOV-1C` (its scope items 1-2: the ADR-016 UUID rule and follow-ups 2-6)
36-36 complete-row `WP-130`
37-37 complete-row `WP-080-FU1` — carried RW-97; closed-by `GOV-1C` (the packages/domain ADR-014 comment pointer)
38-38 complete-row `WP-120`
40-40 complete-row `GOV-1C` — carried RW-98
41-41 complete-row `WP-150` — none: review history (the residual surface r2 found closed in r3)
42-42 complete-row `WP-170` — carried RW-99
43-43 complete-row `WP-180` — carried RW-100; queued `R8-1`, `§5 item 6`; closed-by `GOV-2A` (R6-1/R5-1 and the round-9/10 classes)
44-44 complete-row `WP-200` — closed-by `WP-200-FU1` (the memoisation LOW), `WP-230` (halt enforcement at the composition root)
45-45 complete-row `WP-210` — carried RW-101; closed-by `WP-230` (observeTrade, cashBalance)
46-46 complete-row `WP-180-FU2` — none: NOTE-1 was ratified in the record, and the schema-boundary §1 staleness was corrected before the cut (`7d798f5`, RW-102)
47-47 complete-row `WP-220` — carried RW-103; closed-by `RISK-2`, `WP-230`, `WP-020-FU1`
48-48 complete-row `WP-200-FU1` — carried RW-104; closed-by `WP-020-FU1`
49-49 complete-row `GOV-2A` — closed-by `GOV-2A` (its remediation r1 9e4421f adopted both review NOTEs, RW-105)
50-50 complete-row `GOV-1D` — closed-by `GOV-2A` (C-2 ratification against 7e75f9a, and F12/F17/F18/F19 reassigned)
51-51 complete-row `WP-160` — carried RW-138; listed `§5 item 6`; closed-by `WP-160` (the packet carried WP-150's follow-ups into this package), `WP-160-FU1` (R1-L3), `GOV-2A` (R1-N1), `GOV-2C` (R1-L2's "never throws" wording)
52-53 complete-row `WP-190` — carried RW-106; queued `N3`; closed-by `WP-180-FU2` (R1-N4), `GOV-2A` (R1-N2)
54-54 complete-row `WP-020-FU1` — carried RW-107; closed-by `WP-180-FU3`, `WP-200-FU2`, `GOV-2C`
55-55 complete-row `WP-230` — carried RW-108; closed-by `ALLOC-1`, `TRDR-1`, `RISK-2`
56-56 complete-row `WP-170-FU1` — carried RW-109; listed `isFreshOrdinaryContainer`; closed-by `WP-180-FU3` (the ARENA_NODE_TYPES widening)
57-57 complete-row `WP-240` — carried RW-110; queued `N8`; closed-by `TRDR-3` (M-2)
58-58 complete-row `WP-250` — carried RW-111; closed-by `RISK-2`, `BRACKET-1a` (F1)
59-59 complete-row `WP-180-FU3` — carried RW-112; listed `isFreshOrdinaryContainer`; closed-by `GOV-2C` (the doc follow-ups)
60-60 complete-row `WP-160-FU1` — carried RW-113; listed `WP-160-FU1`; closed-by `GOV-2C` (the doc flip)
61-61 complete-row `REC-1` — carried RW-114; listed `REC-1`; closed-by `CLOB-1`, `GOV-2C`
62-62 complete-row `ALLOC-1` — carried RW-115; closed-by `TRDR-1` (L1, L2)
63-63 complete-row `TRDR-1` — carried RW-116
64-64 complete-row `UNIV-1` — carried RW-117; closed-by `UNIV-2`, `UNIV-3`
65-65 complete-row `SETL-1` — carried RW-118; closed-by `SETL-2`
66-66 complete-row `CLOB-1` — carried RW-119; listed `CLOB-1`
67-67 complete-row `UNIV-2` — carried RW-120; closed-by `UNIV-3`
68-68 complete-row `SETL-2` — listed `SETL-2` (its owned residuals, under Schema boundary)
69-69 complete-row `UNIV-3` — listed `UNIV-3` (its owned residuals, under Schema boundary)
70-70 complete-row `WP-060-FU1` — carried RW-121; listed `WP-060-FU1`
71-71 complete-row `WP-200-FU2` — none: it executed WP-020-FU1 follow-up 2 and names no residual of its own
72-72 complete-row `SER-1` — carried RW-122
73-73 complete-row `SER-2` — carried RW-123
74-74 complete-row `SER-3` — carried RW-124; closed-by `GOV-2C` (N4)
75-75 complete-row `GOV-2B`
76-76 complete-row `TRDR-2` — carried RW-125; closed-by `BOOT-1` (B9, the main.ts:292 cast, and TRDR2-R8), `CI-1` (N5)
77-77 complete-row `RISK-2` — queued `RISK-2 item 7`; closed-by `BRACKET-1a` (residual 5)
78-78 complete-row `GATE-1` — carried RW-126; queued `GATE1-M1`; closed-by `CI-1` (GATE1-R4, the fail-fast chain, and GATE1-R3, the first real CI run)
79-79 complete-row `BOOT-1` — queued `B9`, `BOOT1 unchecked shared facts`, `BOOT1 pool leak`, `BOOT1-R6`, `BOOT1-R11`; listed `BOOT1-R7`; closed-by `REGISTER-1` (the registration CLI)
80-80 complete-row `BACKTEST-1` — carried RW-139; listed `B3`, `BT1-R1..R4`
81-81 complete-row `GOV-2C` — listed `N3`; none: the header-strike note is moot, because LOGS-1 replaced the header
83-83 complete-row `UNIV-4` — carried RW-140; queued `UNIV4-R1`, `UNIV4-R2`, `UNIV4-R4/R5`
84-84 complete-row `TRDR-3` — queued `TRDR3-R1`, `TRDR3-R2`, `TRDR3-R3`, `TRDR3-R4/R5/R7`
85-85 complete-row `CI-1` — listed `CI1-L1`, `CI1-L2`, `CI1-L3`, `CI1-L4`, `CI1-L5`
86-86 complete-row `RECON-1` — listed `RECON1-SCAN`, `RECON1-ORIGIN`, `RECON1-TEXT`, `RECON1-EDGE`
87-87 complete-row `CI-2` — listed `CI2-L5-2`, `CI2-L5-3`
88-88 complete-row `RECON-2` — queued `RECON2-DURABLE`; listed `RECON2-LOOPMEM`, `RECON2-EVENTHOP`, `RECON2-README`
89-94 complete-row `LINT-1` — queued `LINT1-TSC`
95-126 complete-row `TRDR-4` — queued `TRDR4-LIVESETTLE`, `TRDR4-ORPHAN`, `TRDR4-GAUGES`, `TRDR4-CITES`, `LOOPMEM-FOLD`; listed `LOOPMEM-SIM`
127-164 complete-row `SIM-1` — queued `SIM1-BASKET`, `SIM1-CANCELDEBIT`, `SIM1-LOOKAHEAD`, `SIM1-PRICEVALID`; closed-by `SIM-2`
165-190 complete-row `SIM-2` — queued `SIM2-TIER1-TRADES`, `SIM2-FILTER`, `TRDR4-GAUGES`; listed `SIM2-E2E-MSG`
191-227 complete-row `FOLD-1` — queued `FOLD-2`, `LOOPMEM-FOLD`, `RECON2-DURABLE`
228-290 complete-row `BRACKET-1a` — queued `BRACKET1-TPRACE`, `BRACKET1-IDLESSVIEW`; closed-by `BRACKET-1b`, `BRACKET-1c`
291-341 complete-row `BRACKET-1b` — queued `BRACKET1B-RECON`
342-388 complete-row `BRACKET-1c` — queued `BRACKET1C-LOWS`; listed `BOOT1-CONFIGPARAMS`
389-418 complete-row `BUNDLE-1` — queued `BUNDLE1-LOWS`; listed `B1-R1-REDIS-UNCAUGHT`
419-456 complete-row `SNAP-1` — queued `SNAP1-KEYSET`, `SNAP1-MINOR`
457-496 complete-row `H8-GOV` — none: its follow_up mentions are dated work-plan notes it wrote, and it names no residual of its own
497-530 complete-row `DEPCHECK-1` — listed `DC1-R1-L1`
531-570 complete-row `CORE-MOVE`
571-615 complete-row `BACKTEST-2` — queued `TC-LOCAL-FLAKE`
616-627 complete-row `DOCS-1` — none: the only match is its scope title, "documentation owed by the H8 track", which it discharged
628-650 complete-row `OUTAGE-1` — queued `OUT1-R1-HALT-NOT-DURABLE`, `OUTAGE1-LOWS`
651-672 complete-row `REGISTER-1` — closed-by `OUTAGE-2`
673-705 complete-row `OUTAGE-2`
706-717 complete-row `THROUGHPUT-1a`
718-725 complete-row `THROUGHPUT-1b` — none: the match is a design sentence ("consecutive queued envelopes"), not a residual
737-737 complete-row `DEPS-1` — queued `DEPS1-VITEST`
772-774 verbatim
776-801 history completion-records-wave-1.md
802-805 record-item — carried RW-99
806-815 record-item — carried RW-99; closed-by `WP-230`, `WP-220`
816-823 history completion-records-wave-1.md
824-831 record-item — none: the seven HIGH were closed before the merge
832-837 history completion-records-wave-1.md
838-842 record-item — closed-by `WP-200-FU1` (the memoisation LOW)
843-845 record-item — closed-by `WP-230` (halt enforcement at the composition root)
846-853 history completion-records-wave-1.md
854-871 record-item — none: review rounds, M1 closed and r3 ACCEPT
872-877 record-item — none: orchestrator reproductions (evidence)
878-891 record-item — none: what shipped, its obligations are the next record item (892-901)
892-901 record-item — carried RW-127; closed-by `WP-160`, `WP-210`
902-919 history completion-records-wave-1.md
920-936 record-item — listed `§5 item 6`; none: what shipped, F15/F16 checker enforcement is the listed item's
937-945 record-item — carried RW-128; closed-by `WP-220`, `WP-210`, `WP-230`
946-951 history completion-records-wave-1.md
952-954 record-item — none: closeout checklist evidence
955-981 history completion-records-wave-1.md
982-992 record-item — listed `VENUE-3`; none: the phase-2 re-check was executed, the phase-3 one is VENUE-3's
993-1018 history completion-records-wave-1.md
1019-1021 record-item — carried RW-129
1022-1030 record-item — carried RW-129
1031-1038 history completion-records-wave-1.md
1039-1045 record-item — none: a design description
1046-1083 history completion-records-wave-1.md
1084-1092 record-item — carried RW-130
1093-1130 history completion-records-wave-1.md
1131-1140 record-item — carried RW-131
1141-1143 history completion-records-wave-1.md
1144-1151 record-item — none: the implementation record
1152-1165 record-item — none: fixes shipped, each residual pinned as a passing test
1166-1169 history completion-records-wave-1.md
1170-1173 record-item — none: the round-8 judgments
1174-1178 history completion-records-wave-1.md
1179-1187 record-item — carried RW-132; closed-by `WP-210` (the payoff_model migration 0009)
1188-1190 history completion-records-wave-1.md
1191-1198 record-item — none: the implementation record
1199-1203 record-item — none: review round 1, remediated
1204-1214 record-item — none: review round 2 ACCEPT, the residual NOTE is documented behaviour
1215-1221 history completion-records-wave-1.md
1222-1226 record-item — closed-by `WP-120` (the binding obligations it carried)
1227-1235 history completion-records-wave-1.md
1236-1245 record-item — none: the phase-start re-check was executed, and the next one ran on 2026-09-02
1246-1247 history completion-records-wave-1.md
1248-1257 record-item — closed-by `WP-070` (its packet carried these obligations)
1259-1354 history wave-1-batch-1b-in-flight.md
1355-1362 record-item — carried RW-142
1363-1379 record-item — closed-by `GOV-1B` (the takerSide ruling, ADR-014)
1380-1403 record-item — closed-by `WP-120` (its identity obligation)
1404-1421 record-item — closed-by `WP-120` (the unique-id and registration contract)
1422-1441 history wave-1-batch-1b-in-flight.md
1442-1458 record-item — closed-by `WP-120` (the four-part identity contract)
1459-1479 record-item — closed-by `WP-120` (the unresolved-attempt deadline)
1480-1494 history wave-1-batch-1b-in-flight.md
1495-1511 record-item — closed-by `WP-120` (the NONE-after-FeedDisconnected reading)
1512-1526 record-item — closed-by `WP-120` (the failed-attempt reading)
1527-1545 record-item — closed-by `WP-120` (the rejected-PENDING-CLOSE accounting)
1546-1555 history wave-1-batch-1b-in-flight.md
1556-1568 record-item — closed-by `WP-120` (the binding obligations)
1569-1578 record-item — closed-by `GOV-1B` (ADR-014), `WP-080-FU1` (the adapters converged)
1579-1582 history wave-1-batch-1b-in-flight.md
1583-1596 record-item — closed-by `GOV-1B` (ADR-013 ratified C-1/U-1)
1597-1618 history wave-1-batch-1b-in-flight.md
1619-1645 record-item — closed-by `GOV-1B` (contract-owner item 3, ADR-015), `WP-150` (robust to the recorded GET /book ordering contradiction)
1646-1670 history wave-1-batch-1b-in-flight.md
1671-1692 record-item — closed-by `WP-120` (recovery keys off feed.openGap)
1693-1710 record-item — none: review round 3, remediated
1711-1731 history wave-1-batch-1b-in-flight.md
1732-1744 record-item — none: the NOTE's stale comment is gone, at f43efe6 git grep finds "never carried by an event" only in docs
1745-1755 record-item — closed-by `GOV-1B` (contract-owner items 1-3)
1756-1762 record-item — closed-by `GOV-1B` (ADR-013, ADR-014, ADR-015)
1764-1793 history completion-records-wave-0.md
1794-1803 record-item — carried RW-133; closed-by `WP-120`
1804-1812 history completion-records-wave-0.md
1813-1831 record-item — closed-by `WP-120` (its durable-consumer obligations)
1832-1849 record-item — closed-by `WP-120` (its obligations, now explicit)
1850-1912 history completion-records-wave-0.md
1913-1916 record-item — carried RW-134; closed-by `WP-200`
1917-1948 history completion-records-wave-0.md
1949-1955 record-item — carried RW-135
1956-1963 record-item — closed-by `GOV-1C` (it ruled the §6.1 items, and its item-1 tripwire is carried in RW-128)
1964-1986 history completion-records-wave-0.md
1987-1991 record-item — carried RW-136; closed-by `WP-120`, `WP-130`
1992-1996 history completion-records-wave-0.md
1997-2002 record-item — none: the implementation record
2003-2008 record-item — none: review rounds, ACCEPT
2009-2019 history completion-records-wave-0.md
2020-2023 record-item — carried RW-137
2024-2031 history completion-records-wave-0.md
2032-2035 record-item — carried RW-137
2036-2044 history completion-records-wave-0.md
2045-2049 record-item — carried RW-137
2050-2057 history completion-records-wave-0.md
2058-2062 record-item — closed-by `WP-030` (the venue payload-key NOTE)
2063-2072 history completion-records-wave-0.md
2073-2077 record-item — closed-by `WP-030` (the deferred ADR items)
2078-2087 history completion-records-wave-0.md
2089-2116 history wave-0-closeout-and-reviews.md
2117-2128 record-item — none: fixed by the Wave 0 closeout remediation, merged as b8e5eab
2129-2136 history wave-0-closeout-and-reviews.md
2137-2175 record-item — none: review history, WP-030 merged
2177-2222 record-item — none: review history, WP-020 merged
2224-2309 record-item — none: review history, WP-000 merged
2310-2313 history wave-0-closeout-and-reviews.md
2314-2316 record-item — none: superseded by the WP-000 completion record
2317-2318 history wave-0-closeout-and-reviews.md
2322-2345 history wave-2-qualification.md
2346-2346 record-item — none: a superseded header quote
2347-2349 history wave-2-qualification.md
2350-2350 record-item — none: a superseded header quote
2351-2353 history wave-2-qualification.md
2354-2354 record-item — none: a superseded header quote
2366-2368 history wave-2-qualification.md
2369-2391 record-item — none: the brief's Current phase and Wave 2 qualification state what is still open (§7 items 1, 4 and 5, B4, B5)
2392-2399 history wave-2-qualification.md
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
2693-2736 history cross-package-schema-risk.md
2737-2741 record-item — listed `R8-1`
2742-2763 history cross-package-schema-risk.md
2764-2772 record-item — closed-by `GOV-2A` (the round-9/10 classes were folded into it)
2773-2802 history cross-package-schema-risk.md
2803-2809 record-item — closed-by `WP-160-FU1`
2810-2815 record-item — listed `R8-1`
2816-2820 history cross-package-schema-risk.md
2821-2823 record-item — listed `§5 item 6`
2824-2833 record-item — listed `N3`
2835-2846 record-item — closed-by `WP-200-FU1`, `WP-170-FU1`, `REC-1`, `WP-160-FU1`, `CLOB-1`, `SETL-2`, `UNIV-3`, `WP-060-FU1`; listed `§5 item 6`
2847-2851 history cross-package-schema-risk.md
2852-2855 record-item — closed-by `WP-200-FU1`
2856-2860 history cross-package-schema-risk.md
2861-2863 record-item — closed-by `REC-1`
2864-2877 history cross-package-schema-risk.md
2878-2883 record-item — none: what a probe result means, not an obligation
2885-2897 record-item — none: the ADR-020 ruling, whose live items are under Schema boundary
2898-2911 history cross-package-schema-risk.md
2913-2913 verbatim
2924-2924 verbatim
2930-2930 verbatim
2935-2940 verbatim
~~~

**The re-cut at `8fde4df`.** After the first cut, `main` edited the old file in three commits: `8fc0eb1` (the `LOGS-1` row), `9d270a9` (`VENUE-3` Complete, and four `V3-*` residual rows) and `d2ab6dc` (`THROUGHPUT-2` Complete). Each inserted or changed line is covered at the re-cut:

- RW-144 pairs the `VENUE-3` row, RW-145 the `LOGS-1` row, and RW-146 to RW-149 the four `V3-*` rows;
- the block below declares the `THROUGHPUT-2` row, whose live residuals RW-143 carries;
- no completion record was added or changed, so no new `record-item` is owed (C14).

~~~unpaired base=8fde4dffa9546dc7570f1e53653242c568669c58
738-755 complete-row `THROUGHPUT-2` — carried RW-143
~~~

- New navigation text with no old counterpart: the brief's intro paragraph, the "Authorized now" intro, the Work packages intro, the Open blockers pointers, the Venue drift intro and the Archive section.

## RW-01: Header: "Last updated"

Old, lines 3-3:

~~~old lines=3-3
Last updated: 2026-09-15  
~~~

New:

~~~new
Last updated: 2026-09-30 (content as of `8fde4df`; restructured by LOGS-1)  
~~~

**Facts.** The date is refreshed to the restructure date, 2026-09-30. The old header date (2026-09-15) was stale: the file holds records dated up to 2026-09-30. "content as of `8fde4df`" names the cut: the first cut was `f43efe6`, and the archive was re-cut at `8fde4df` for LOGS-1's pending merge.

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
- **Next:** H1 run 2, then the fresh read-only closeout audit (after H1 and H3). `THROUGHPUT-2` is Complete (`7d59fd3`), but it missed its throughput targets.
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
- "re-run after `THROUGHPUT-1`" (2026-09-29) is superseded inside the base file by the `THROUGHPUT-2` row (2026-09-30: "H1 is re-run afterwards"); the brief says "after `THROUGHPUT-2`". At the re-cut (`8fde4df`) `THROUGHPUT-2` is Complete, so "Next" names H1 run 2; its missed targets are in RW-143.
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
| `WP-140` | Recorder observability and soak harness | Implementation complete; automated checks complete; the evidence gate is unmet until the ≥24h soak (H4) | `735d330` + wiring `5757ef3` | [WP-140](docs/handoffs/WP-140.md) |
- **H4**, elapsed soak evidence: open. It is the `WP-140` gate, which closes only through the runbook §7 governance procedure after a real ≥24h soak.
~~~

Keep (in both texts):

~~~keep
Implementation complete; automated checks complete
runbook §7 governance procedure
after a real ≥24h soak
~~~

**Facts.** Kept: "Implementation complete; automated checks complete", the external evidence still pending (the brief says the evidence gate is unmet until the ≥24h soak, H4; the old "gate open" meant not yet passed), and the closing rule (the runbook §7 governance procedure after a real ≥24h soak, now under Human items > H4). Not carried: the implementation chain, the four review and three remediation rounds, and the Codex session id (archive).

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

## RW-07: Work packages: `THROUGHPUT-2` (live at `f43efe6`; Complete at the re-cut)

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
| `THROUGHPUT-2` | evaluate once per venue frame: no half-applied book states; reach the H1 burst rate | Complete (2026-09-30) | `7d59fd3` | [THROUGHPUT-2](docs/handoffs/THROUGHPUT-2.md) |
~~~

**Facts.** Re-cut at `8fde4df`: the row went Complete on 2026-09-30 (merged `7d59fd3`), so its Ready-state bullet left "Authorized now" and the one-line row now reads Complete. Its live residuals at the cut are carried by RW-143. Until the re-cut the brief kept: Ready (authorized) 2026-09-30; the goal and both "Why" facts (`H1R1-FRAME-ATOMICITY`; evaluation about 82% of CPU); kept and changed semantics; scope (1)-(4) item by item, with "ONLY" and "only if proven bit-identical"; the targets; base `229d58a`; HARDENING LOOP; the Fable verifier; before `THROUGHPUT-1c`; H1 afterwards; the full gate, including the green CI run on GitHub; the 2026-09-30 merge-on-ACCEPT ruling, which moves only the ratification after the merge. Not carried then: the user's quoted words, the dependencies (both complete), and the allowed and forbidden paths (the archived row).

## RW-08: Work packages: `VENUE-3` (live at `f43efe6`; Complete at the re-cut)

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
| `VENUE-3` | the phase-3 venue gate: the Wave 3 start re-verification, including the C-4 re-check and a fresh SDK pin check | Complete (2026-09-30) | `6a15131` | [VENUE-3](docs/handoffs/VENUE-3.md) |
~~~

**Facts.** Re-cut at `8fde4df`: the row went Complete on 2026-09-30 (merged `6a15131`), so its Ready-state bullet left "Authorized now"; the Complete row's live facts are paired by RW-144. Until the re-cut the brief kept: Ready (authorized) 2026-09-30; `VENUE-2`'s shape; the full §1.2 re-verification against `verified-2026-09-16.md` with every drift row quoted, sourced, and given a consequence and an owner; every Wave 3 surface in the list; the documentary-only rule, including that the geoblock endpoint is not called; parallel with `THROUGHPUT-2`; the `venue-verifier` implementer; the re-fetching Fable verifier; the gate, including the green CI run on GitHub. Not carried then: the user's quoted words, the dependency (`THROUGHPUT-1a`, complete), and the allowed and forbidden paths (archive).

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
`verified-2026-09-16.md` fed these to later rounds; they have no row of their own. Owners are from `docs/handoffs/VENUE-2.md` follow_up and the report's §16.3.
- D-13: a per-market `feeSchedule {rate, exponent, takerOnly, rebateRate}`, while `packages/simulation/src/fees.ts` models only `exponent = 1`. Owner: `packages/simulation` (ADR-012) and fee/reward accounting.
- D-17: the minimum-order-size unit conflict (market details say "USDC notional", place-orders says "shares"; static-bracket `decide.ts` compares shares). Register conflict C-7. Owner: `packages/strategies/static-bracket` and `packages/universe`, with venue evidence.
- D-02: SDK 0.6.0 → 0.10.0 with breaking changes (`WP-260`). `VENUE-3` re-checked the pin: `@polymarket/client` **0.11.0** exactly, npm `latest`. Do NOT pin the unreleased head `6842ffa4`. The five-step fresh check is in `verified-2026-09-30.md` §W.1.
- D-15 and D-20: see [Pending external evidence](#pending-external-evidence). D-30 is B10's basis (closed).
- The offline gate does not consume the phase-2 report: `apps/ops-cli`'s validator pins the frozen report only (`checks.ts:69`) and pins `effective_date` to 2026-08-24 (`checks.ts:249-252`), as of `8fde4df`. Report §15 items 1-4. Owner: the `apps/ops-cli/**` package (`WP-330` or an earlier authorized packet).
- U-17 and U-16: the semantics of `feeSchedule.exponent ≠ 1` and the rounding direction are still undocumented. Owner: as D-13; `roundingMode` stays caller-declared.
- U-15: Protocol V2 is documented only in SDK source. Owners: `WP-260`, `WP-300`, and the universe/data-gateway line that first reads Gamma `version`.
- Handoff §24 has three redirecting links (D-07, D-11, D-25). Owner: the orchestrator or register owner (update or annotate them).
~~~

Keep (in both texts):

~~~keep
models only exponent = 1
the minimum-order-size UNIT conflict
SDK 0.6.0 → 0.10.0 with breaking changes
validator pins the frozen report only (checks.ts:69)
pins effective_date to 2026-08-24
§15 items 1-4
U-17
U-16
documented only in SDK source
three redirecting links (D-07, D-11, D-25)
~~~

**Facts.** `VENUE-2` is a Complete row, but two of its parts are live and have no residual row: the "Facts that feed the next rounds" and the "Residuals (owned, `docs/handoffs/VENUE-2.md` follow_up 1-10 and §16.3)". The brief carries D-13, D-17 (C-7) and D-02, and points D-15/D-20 at Pending external evidence. It carries every owned residual: the `apps/ops-cli` validator pins (`checks.ts:69`; `effective_date` 2026-08-24 at `:249-252`; report §15 items 1-4), U-17 and U-16 undocumented, U-15 (Protocol V2 only in SDK source), and handoff §24's three redirecting links (D-07, D-11, D-25). The phase-3 start gate's own report was owed at `f43efe6`; `VENUE-3` delivered it (Complete at the re-cut, `8fde4df`), so the brief drops that bullet, and the D-02 line states the pin `VENUE-3` checked (RW-144). The owners come from `VENUE-2.md` follow_up 1, 3-6, 9 and 10 and report §16.3 items 3-6 and 8; the row names only those two sources. Not carried: the rest of the row (the chain, the review, the 31 drift rows, the source index, the gates, the superseded authorization text), which is history in `work-packages-rounds.md`.

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
Open items are closeout blockers, residual rows, venue drift carried forward, residuals recorded in Complete package rows, obligations in completion records, and human items ([below](#human-items)). Full rows, evidence and history: [`open-blockers-2026-09.md`](docs/status-archive/open-blockers-2026-09.md) (search for the id). The cross-package schema-boundary findings (zod adoption and loss) are in [`cross-package-schema-risk.md`](docs/status-archive/cross-package-schema-risk.md); what is still live from them is listed under [Schema boundary](#schema-boundary-still-live).
~~~

**Facts.** Reorganized, not copied: the old intro listed closeout blockers, the residual queue and the reconciled cross-package findings; the brief lists closeout blockers, residual rows, carried-forward venue drift, residuals recorded in Complete package rows and human items, and moves the cross-package findings to the Schema boundary subsection. The correction note (GOV-2C, 2026-09-15: the section once read "None.") is history in `open-blockers-2026-09.md`.

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
| `B5` | **Code half (R4) closed** by `TRDR-3` (`da9c58e`). **Infra half (R5), i.e. H3:** performed 2026-09-29 with H1 run 1 (a real Prometheus scraped the control API; a real Grafana imported and rendered the three dashboards). The fresh closeout grades it. No test validates the scrape fragment (`infra/prometheus/control-api-scrape.yaml`). | human (H3) |
~~~

Keep (in both texts):

~~~keep
CODE HALF (R4) CLOSED
no test validates the
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
| `H7` | **Ratified** by the user, 2026-09-28 ("Ratify all"). It covers the N6 field format; four root-wiring commits without recorded reviewer sign-off (`5b73461`, `af059d7`, `80126e8`, `da37a0c`); the SER confirming reviews run by Claude after Codex's content filter refused the packet; N11. Also the Fable verifiers for container- and spawn-heavy rounds (`BRACKET-1c`, `BUNDLE-1`, `DEPCHECK-1`; the `CI-2` precedent), the `DEPCHECK-1` grant widening (`CI2-L5-2/3`) and the `DOCS-1` authorization. The archived state cell reads "PARTLY DONE"; it predates the ruling. | no open owner: the archived owner (human/orchestrator, for three questions) became historical at ratification |
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
Closed: `B3` (`BACKTEST-2` `fd12be0`, 2026-09-28), `B10` (`UNIV-4` `7c08af7`), `G-01` (`VENUE-2` `d6aedee`), `H5` (ruled 2026-09-28: one demonstrated run). Closed earlier: `B1`'s cause (`TRDR-2` `f3da220`), `B2` (`RISK-2` `133eac1`), `B6`, `B7` and N4 (`GATE-1` `0434c82`), `B8` with N2 (the contract correction; the `N2` measurement is open), N3 (features), N6, N7, N9, N10 and G-13 (`GOV-2C`). N5 closed later (`CI-1`).
~~~

**Facts.** All closed or ruled; the brief keeps the id, the closing package and SHA. Archive only: B3's narrowing history and interim "accepted as qualified" wording, B10's defect detail, G-01's source list, and the GOV2C-2 correction note about N5. G-01's surfaced items: D-15 and D-20 are under Pending external evidence, D-13, D-17 and D-02 under Venue drift carried forward (RW-10), D-30 is B10's closed basis. H5's ruling text is under Human items. `B8`'s SHA is in the table (`GOV-2C` `33c36f9`).

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
Open rows only, one line each. An owner beginning "row:" is quoted from the archived row and may be stale; the cell says why. File:line citations are as of `8fde4df`.
| Id | Residual | Owner |
~~~

**Facts.** The heading's parenthetical is dropped. The Evidence column is dropped: each archived row keeps it. New: the "row:" owner convention and the rule that file:line cites are as of the cut (`f43efe6`, then `8fde4df` after the re-cut; K33 checks each one there).

## RW-19: Residual `H1R1-FRAME-ATOMICITY` (closed at the re-cut)

Old, lines 2607-2607:

~~~old lines=2607-2607
| **H1R1-FRAME-ATOMICITY** | Every venue market-channel frame in the H1 burst produced exactly TWO `BookLevelChanged` events, one per token of the pair (85,547 events from 42,774 frames), and the trader evaluates after EACH. So half of all evaluations see a half-applied frame, a book state that never existed at the venue. Evaluating once per frame (per `causationId`) would be truer and halve the work, but it changes "one decision per event" (WP-170's exactly-one-decision criteria) | `docs/handoffs/H1-RUN-1.md` finding 2 | **RULED 2026-09-30** (the user): `THROUGHPUT-2` evaluates once per frame |
~~~

**Facts.** Kept: two events per frame, one per token; 85,547 events from 42,774 frames; the half-applied book; once per `causationId`; the WP-170 criterion it changes; the 2026-09-30 ruling and what it ruled (`THROUGHPUT-2` evaluates once per frame). Archive only: the evidence cite (`H1-RUN-1.md` finding 2). Until the re-cut it was carried as open, because the ruled fix was in flight in `THROUGHPUT-2`. At `8fde4df` `THROUGHPUT-2` is Complete (`7d59fd3`): on the H1 burst all 42,955 half-applied-state decisions are gone. So the brief moves the id to the closed list under Residual queue, and this entry has no new block. The closed-list entry carries the closure's two qualifiers: ADR-024 is accepted only provisionally, pending the user's ratification, and its D2 exception still evaluates a stream prefix truncated inside a frame once, half-applied, before the trader halts.

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
| `FOLD-PNL2TOKEN` | A silent PnL gap: when an instance holds both tokens of a market, only the filled token is marked (`packages/trading-core/src/loop.ts:3118-3122`, in `#stagePnlSnapshot`). | a PnL correctness round (unreachable with a single-token Static Bracket) |
~~~

Keep (in both texts):

~~~keep
only the filled token is marked
unreachable with a single-token Static Bracket
~~~

**Facts.** Kept verbatim in substance, with the single-token unreachability in the owner cell. r7 corrects the approximate cite `loop.ts` about :2607-2612 (unowned-fill code at `f43efe6`) to `packages/trading-core/src/loop.ts` lines 2958-2962, where `#stagePnlSnapshot` marks only the filled token (verifier finding D3). `THROUGHPUT-2` moved that code; at the re-cut (`8fde4df`) the lines are 3118-3122. Archive only: the evidence cite (FOLD-1 scoping).

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
| `TRDR4-LIVESETTLE` | A live-adapter obligation, outside PAPER. `TRDR-4` settles an order when it is terminal and its booked shares equal its filled shares. At a real venue, trades settle asynchronously (MATCHED → MINED → CONFIRMED, or RETRYING → FAILED; `verified-2026-09-16.md`). Before a live adapter exists: settlement must also require every trade of the order to be CONFIRMED or FAILED, and a §9.17 reconciliation to have passed. The adapter must also surface the orders a refused plan left behind (in `ordersSnapshot()` or in the refused result), carrying `plannedOrderId`. Meanwhile the loud path covers a late fill. | the live-adapter work package |
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
| `TRDR4-CITES` | `test/unit/control-api/response-encoder-bound.test.ts` cites stale lines `health-door.ts:181` and `:77`. At `8fde4df` they are `:301` (`readTraderHealthReport`) and `:83` (the first `z.record(`). Its "one `z.record(`" wording is stale too: `FOLD-1` found that the door now nests records two levels deeper, to a fixed depth. | the next round touching `test/unit/control-api/**` (documentation only) |
~~~

Keep (in both texts):

~~~keep
response-encoder-bound.test.ts
(documentation only)
~~~

**Facts.** Kept: the test file, both drifted cites, and the documentation-only owner. r7 gives the cites' lines at `f43efe6` (`:301` and `:83`); the re-cut pins them at `8fde4df`, where `health-door.ts` is unchanged, so the lines are the same. The row's `:242` and `:82` were the lines at `TRDR-4`'s time (verifier finding D3). r7 drops "The claim itself still holds": `docs/handoffs/FOLD-1.md` line 261 found the "one `z.record(`" wording stale, because the door now nests records. Archive only: "(`:181` had already drifted at base)".

## RW-35: Residual `RISK2-R1`: closed before the cut (r7)

Old, lines 2491-2491:

~~~old lines=2491-2491
| **RISK2-R1** | `apps/trader/src/pipeline.ts:99-103`'s RULE stands (the composition root may not re-derive disposition from tags) but its premise sentence "`packages/risk` decides disposition from the intent TYPE" is superseded | `docs/handoffs/RISK-2.md` residual 3 | `BOOT-1` (same grant extension) |
~~~

r7 found this row closed before the cut, so this entry holds no new text. The brief names `RISK2-R1` in the Residual queue's closed list.

**Facts.** Nothing is owed. `BOOT-1` (`7263c13`) corrected the premise sentence: `docs/handoffs/BOOT-1.md` item 4 says `pipeline.ts`'s premise was corrected sentence by sentence, with the superseded text quoted. At `f43efe6` the comment is at `packages/trading-core/src/pipeline.ts` lines 100-104 (the file moved with `CORE-MOVE`); it keeps the rule and quotes the superseded premise. r1-r6 carried the row as open with the stale path `apps/trader/src/pipeline.ts:99-103` (verifier finding D3, r7).

## RW-36: Residual `TRDR2-R8`: closed before the cut (r7)

Old, lines 2538-2538:

~~~old lines=2538-2538
| **TRDR2-R8** | A parenthesized type alias (`type X = (never); value as X`) evades the trader cast census, `eslint` AND `tsc` — `resolveTypeText` does not strip parentheses; one-line fix plus a self-test | `docs/handoffs/TRDR-2.md` residual 2 | the next round touching `test/unit/trader/**` |
~~~

r7 found this row closed before the cut, so this entry holds no new text. The brief names `TRDR2-R8` in the Residual queue's closed list.

**Facts.** Nothing is owed. `BOOT-1` fixed it: `docs/handoffs/BOOT-1.md` line 66 says TRDR2-R8, the parenthesized-alias evasion, is closed. At `f43efe6`, `test/unit/trader/query-boundary-cast-scan.test.ts` strips balanced surrounding parentheses (`unparenthesized`, lines 245-249) and says "closed by `BOOT-1`". r1-r6 carried the row as open (found in r7 while re-checking D3).

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
| `BOOT1-R11` | `test/integration/control-api/trader-health-shape.test.ts:353` asserts `toContain("WP-220 accepted residual")` and passes only because the corrected caveat quotes that phrase, so it no longer measures what its name says. `apps/trader/README.md:144-160` still states the WP-220 posture verbatim. | the next control-api round (pin `SUPERSEDED (RISK-2, 133eac1)`); the next round granted `apps/trader/README.md` |
~~~

Keep (in both texts):

~~~keep
no longer measures what its name says
SUPERSEDED (RISK-2, 133eac1)
~~~

**Facts.** Kept: the assertion and why it passes (at `f43efe6` the assertion is on line 353, not 169; r7, verifier finding D3); that it no longer measures its name; the stale README lines; both owners, with the replacement pin `SUPERSEDED (RISK-2, 133eac1)`. Archive only: "out of BOOT-1's grant" (in the id cell).

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
| `TRDR3-R4/R5/R7` | (R4) The operations dashboard lacks the `control_trader_health_current` stat the trading dashboard gained. (R5) The control API example's `bindPort: 9465` collides with `infra/prometheus/recorder-scrape.yaml`'s compaction target; the new fragment targets 9466 to avoid it. (R7) `apps/control-api/src/health-door.ts:238` says "Bounded: at most 4096 instances" over an unbounded `z.record`; the practical bound is the http source's 4 MiB body. | the next `apps/control-api`/`infra` round |
~~~

Keep (in both texts):

~~~keep
targets 9466 to avoid it
unbounded z.record
4 MiB body
~~~

**Facts.** Kept: R4's missing stat; R5's collision with the compaction target and the new fragment's 9466; R7's false bound, the unbounded `z.record` and the actual 4 MiB bound. r7 corrects R7's cite from `:133` to `:238`, its line at `f43efe6` (verifier finding D3). Archive only: the config and scrape file line numbers.

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
| `UNIV4-R4/R5` | (R4) A hold-back caused by a failed confirmation write, with a healthy publisher, is released only by the next epoch (two PAGEs raised); a same-epoch retry when not halted would release it. (R5) Poll latency is up to one `pollIntervalMs`: a market closed between polls is seen late, and one closed and reopened within one interval is unseen. The venue's `endDate`/`startDate` are deliberately not used: they have no documented semantics and are a schedule, not an observation. `apps/data-gateway/src/publisher.ts:633`'s halt detail "the event remains in the WAL" is false for derived lifecycle events (the feed's own incident states the truth). | the next `apps/data-gateway` round |
~~~

Keep (in both texts):

~~~keep
with a healthy publisher
a same-epoch retry when not halted would release it
within one interval is unseen
deliberately not used
a schedule, not an observation
~~~

**Facts.** Kept: R4's hold-back with a healthy publisher, two PAGEs, and the same-epoch retry remedy; R5's latency bound, the late close, the unseen close-and-reopen, and why `endDate`/`startDate` are deliberately unused; the false WAL halt detail. r7 corrects its cite from `publisher.ts:461` (a blank line at `f43efe6`) to `apps/data-gateway/src/publisher.ts:589` (verifier finding D3). `THROUGHPUT-2` moved the line; at the re-cut (`8fde4df`) it is `:633`. Archive only: "owner's wording".

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
| `BRACKET1-TPRACE` | Pre-existing; disclosed in the static-bracket README by `BRACKET-1a`. The `(PARTIALLY_OPEN\|OPEN, *_FILL)` family. (a) A take-profit is still live when a late entry fill resizes it, and the resize's cancel loses the race to a fill. The fill is refused with `SB.ILLEGAL_TRANSITION`, and the instance pauses, fail-closed, with the fill unfolded (at base the view-first order gave `UNATTRIBUTED_FILL`; either way it pauses). (b) A live entry's fill arrives while the bracket is `OPEN`. It needs an edge or a ruling; one option: exit settlement does not move into `OPEN` while the entry is still live. | the next static-bracket round |
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
| `BRACKET1B-RECON` | Disclosed limits of the per-bracket reconciler (`BRACKET-1b`), each loud rather than silent where it matters. Fee records are not individually tied to their fills (fee totals are compared through fills and snapshots). The single-bracket path does not check the PnL stream's order (no single-bracket row reads it). Same-event fill ties keep the fill-id convention. There is no per-bracket engine checkpoint in the artifact. Two internal guards are unreachable and unpinned. | the next `test/e2e/**` round |
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

## RW-74: Residual `GATE1-R3`: closed before the cut (r8)

Old, lines 2549-2549:

~~~old lines=2549-2549
| **GATE1-R3 (discharged locally)** | `js-yaml 4.3.2` HAS executed here: `GATE-1`'s post-merge `pnpm install --frozen-lockfile --offline` at `0434c82` materialized `node_modules/.pnpm/js-yaml@4.3.2` (`docs/handoffs/GATE-1.md`, "every one re-run green"), and every lint gate since — TRDR-2, RISK-2, GOV-2C — ran on it. *(Corrected 2026-09-16 in the GOV-2C governance flip, review finding GOV2C-r1-1; the row previously read "`js-yaml 4.3.2` has never executed here: the bump was lockfile-only, local `node_modules` still holds 4.3.1, and every gate run so far used it" — true at GATE-1's candidate tip, false once its post-merge install ran, and copied without re-dating.)* The remaining unknown is only the first real CI run's fresh install | `docs/handoffs/GATE-1.md` residual 3 | H2 (the first real CI run) |
~~~

r8 found this row closed before the cut, so this entry holds no new text. The brief names `GATE1-R3` in the Residual queue's closed list.

**Facts.** Nothing is owed. The row's only open point was the first real CI run's fresh install, owned by H2. `CI-1` discharged H2 on 2026-09-26: `docs/handoffs/CI-1.md` records PR #1 run `36282501033` with all three jobs `success` and says "(`H2` DISCHARGED)". That run installed from the lockfile, which pins `js-yaml@4.3.2` at `f43efe6`. r1-r7 carried the row as open with the owner "H2, discharged 2026-09-26 by `CI-1`; the row was not closed" (verifier finding R8-01). Archive only: the GOV-2C correction note.

## RW-75: Residual `N3`

Old, lines 2542-2542:

~~~old lines=2542-2542
| **N3 (execution-planner half)** | `GOV-2A`'s 2026-09-04 ruling: `packages/execution-planner/src/refusals.ts:178-187` claims "every public entry point of this package promises a typed result" while `buyLimitPrice`/`sellLimitPrice` (`src/price.ts`) throw `InvalidDecimalStringError` on non-canonical input; to be "corrected in text or guarded in code by the next bounded round touching each package". The trigger fired unmet: `WP-180-FU2` (`625c83b`, 2026-09-04 16:58, two hours after `GOV-2A` merged) edited `refusals.ts` itself (the import at `:17`) and left the claim. The `features` half is corrected by this round (`packages/features/src/inputs.ts`, comment only, superseded text quoted at the site). **The ruling's compliance mechanism failed because nothing checks it**: it lived in one paragraph of the record below and in `docs/handoffs/GOV-2A.md` `follow_up` 8, and no packet, gate or review checklist reads either | `docs/handoffs/GOV-2A.md` `follow_up` 8; `docs/handoffs/WP-190.md` R1-L1; `docs/contracts/schema-boundary.md` §5 item 13 | the next bounded grant on `packages/execution-planner/**` — and every packet dispatched for that package must now quote this row |
~~~

New:

~~~new
| `N3` | `GOV-2A`'s 2026-09-04 ruling: `packages/execution-planner/src/refusals.ts:178-187` claims every public entry point returns a typed result, but `buyLimitPrice`/`sellLimitPrice` (`src/price.ts`) throw `InvalidDecimalStringError` on non-canonical input. The composed entries (`buildExecutionPlan`, `sealExecutionPlan`) are total (`WP-190` R1-L1). The claim is to be corrected in text or guarded in code; its first trigger (`WP-180-FU2`) fired unmet. | the next bounded grant on `packages/execution-planner/**`; every packet dispatched for that package must quote the archived row |
~~~

Keep (in both texts):

~~~keep
InvalidDecimalStringError on non-canonical input
every packet dispatched for that package must
~~~

**Facts.** Kept: the ruling date; the claim and the throwing functions with `InvalidDecimalStringError` on non-canonical input; correct in text or guard in code; the unmet `WP-180-FU2` trigger; the owner with "every packet dispatched for that package must quote" (now "the archived row"). r8 adds `WP-190` R1-L1's qualifier, which r1-r7 dropped: the composed entries (`buildExecutionPlan`, `sealExecutionPlan`) are total (`docs/handoffs/WP-190.md` known_risks; verifier finding CX-R8-01). The `features` half (corrected by GOV-2C) and the failed-compliance history are in Deviations > N3 and the archive.

## RW-76: Residual `N2`

Old, lines 2543-2543:

~~~old lines=2543-2543
| **N2 (order-book)** | `docs/contracts/schema-boundary.md` §3's `packages/order-book` row said "scalar parses only … no object parse, so no adoption/loss"; `book.ts:191` and `:265` both `safeParse` caller-supplied `input.payload` against object schemas and read `parsed.data`. Corrected in the contract by this round; the severity is unchanged because the reachability of a defeat on those two doors has NOT been measured | `docs/contracts/schema-boundary.md` §3 (the corrected row) | the next bounded grant on `packages/order-book/**`, which owes the measurement first |
~~~

New:

~~~new
| `N2` | `packages/order-book` `book.ts:284` and `:361` `safeParse` caller-supplied `input.payload` against object schemas and read `parsed.data`. The contract row is corrected (`schema-boundary.md` §3). The severity is unchanged, because whether a defeat on those two doors is reachable has not been measured. | the next bounded grant on `packages/order-book/**`, which owes the measurement first |
~~~

Keep (in both texts):

~~~keep
read parsed.data
the severity is unchanged
which owes the measurement first
~~~

**Facts.** Kept: the two doors (r7 corrects their lines to `:284` and `:361` at `f43efe6`, from `:191` and `:265`; verifier finding D3), the caller-supplied payload, the object schemas and `parsed.data`; the corrected contract row; the unchanged severity and its reason; the measure-first owner. Archive only: the contract's old wording.

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
Closed, done or ruled (full rows in the archive): `RISK-2 residual 5`, `RISK2-R6`, `RISK2-R2`, `RISK2-R3`, `RISK2-R4`, `RECON1-SCAN`, `RECON1-ORIGIN`, `RECON1-TEXT`, `RECON1-EDGE`, `RECON2-LOOPMEM`, `LOOPMEM-SIM` (remainder: the `SIM-*` rows above), `SIM2-E2E-MSG`, `RECON2-EVENTHOP`, `RECON2-README`, `N5`, `N1`, `GATE1-R4`, `CI1-L1`, `CI1-L2`, `CI1-L3`, `CI1-L4`, `CI1-L5`, `CI2-L5-2`, `CI2-L5-3`, `BT1-R1..R4`, `BOOT1-R7`, `BRACKET-1b`, `BRACKET1C-SNAPKEY`, `M18`, `BOOT1-CONFIGPARAMS`, `ADR022-DISCHARGE`, `DC1-R1-L1`, `B1-R1-REDIS-UNCAUGHT`, `BRACKET-1c`, `H1R1-FRAME-ATOMICITY` (closed by `THROUGHPUT-2`, `7d59fd3`: it evaluates once per frame. ADR-024 is accepted provisionally, pending the user's ratification. Its D2 exception remains: a stream prefix truncated inside a frame, a corruption path, is evaluated once, half-applied, and the trader then halts), `RISK2-R1` and `TRDR2-R8` (both closed by `BOOT-1` before the cut), and `GATE1-R3` (closed by `CI-1` before the cut: H2's first real CI run). The `H8 track` is complete; its rulings still in force are under [Human items](#human-items).
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
- **H5**: ruled 2026-09-28: one demonstrated run. The runbook §7 "Wave 2 closeout" check "Static Bracket runs in replay and live-data paper mode through the same code" (`:509` at `f43efe6`) is discharged by one supervised live-data paper session. That session runs through the real stack (gateway → Redis → trader → PostgreSQL), produces decisions and reads back clean. Sustained accumulation is the post-closeout activity the same section describes next (`:514` at `f43efe6`).
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
The user authorized Wave 3 on 2026-09-30. The orchestrator may start `WP-260` first, then the work-plan chain, only when both hold:
- the fresh Wave 2 closeout audit grades Wave 2 CLOSED;
- `VENUE-3` has merged (the phase-3 start gate): met on 2026-09-30 (`6a15131`).
Every Wave 3 package stays PAPER-only, built with fixtures, mocks and fault injection (runbook §8, "Critical rule"): no production wallet, signer, API credential or real-order test. If the closeout does not grade Wave 2 CLOSED, only the agent-closable blockers it names are worked, and Wave 3 does not start.
~~~

Keep (in both texts):

~~~keep
may start
WP-260 first
grades Wave 2 CLOSED
no production wallet, signer, API credential or real-order test
Wave 3 does not start
~~~

**Facts.** Kept: the permission ("may start", not a commitment), both conditions, the order (`WP-260` first), PAPER-only with fixtures, mocks and fault injection, every prohibition, and the fallback. Archive only: the user's quoted words. "(runbook :906)" moved to the closeout-audit line under Human items, pinned to `f43efe6`. At the re-cut (`8fde4df`) `VENUE-3` is Complete, so its condition is marked met; the closeout condition is still open.

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
The authority is `docs/contracts/schema-boundary.md` §3 (2 LIVE / 13 CLOSED / 5 outside, recounted 2026-09-11). Still live from the cross-package record (reconciled 2026-09-15):
- `packages/domain`: the frozen root cause. It is closed at each door (ADR-020 §3) and never edited, by design.
- `packages/order-book`: live by inheritance, and `N2`.
- The `features` INPUT-side records: prototype-bearing, no live consumer route (`WP-160-FU1` r1 N2).
- `R8-1`, `§5 item 6`, and the open totality claim `N3`.
- Each closed door's disclosed residuals, owned in its handoff: `REC-1` (D2 not performed; the `config-door` format check), `CLOB-1` (`Array.prototype` arrays; the shared-materializer question, for ADR-020 governance), `UNIV-3` (the direct-export caller-input round). Also `SETL-2` (follow-up hardening), `WP-060-FU1` (the `redis/transport.ts` epoch cursor), the `isFreshOrdinaryContainer` round (zod's own array assembly), and the strategy-runtime `modelOutputs` split collapse.
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
A Wave 2 row that reads "Complete" means the package met its own acceptance criteria (re-verified by `GOV-2B` on 2026-09-15). It does not mean the paper core works end to end. Closing Wave 2 releases no new package: the four packages outside Wave 2 that depend directly on a Wave 2 package (`WP-270`, `WP-290`, `WP-300`, `WP-360`) all also depend on `WP-260`, directly or transitively. `WP-260` itself is held by wave ordering and the signer boundary. Gate counts in rows dated before 2026-09-26 come from one laptop; CI first ran with `CI-1`. Full text: [`wave-2-qualification.md`](docs/status-archive/wave-2-qualification.md).
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
- **N3**: a ruling of the form "by the next round touching X" failed twice, because nothing checks it. The systemic fix (a dated comment in the package's work-plan entry) is proposed, not applied: `GOV-2C`'s work-plan grant covered ratification entries only, and `packages/execution-planner` has no open package entry to carry it.
~~~

Keep (in both texts):

~~~keep
is proposed, not applied
has no open package entry to carry it
~~~

**Facts.** Kept: the mechanism failure, the proposed and unapplied systemic fix, and both reasons it was not applied (`GOV-2C`'s work-plan grant covered ratification entries only, and `packages/execution-planner` has no open package entry to carry it). Archive only: the two trigger events (`WP-180-FU2` `625c83b`; `WP-160-FU1` `5faf16b`) and the GOV2C-7 correction; the open half is the `N3` residual row.

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

## RW-97: Complete row `WP-080-FU1`: residuals still owned

Excerpt of base line 37:

~~~excerpt lines=37-37
Residuals (disclosed): LOW — §1's biconditional parser remains whole-document/first-match (no duplicate exists in the ADR today; dormant future-edit risk; optional follow-up to span-scope to `### 1`–`### 2`); NOTE — §7-duplicate precondition intentionally couples the historical probe suite to the ADR wording.
Carried follow-ups: optional §1 parser span-scoping; the packages/domain ADR-014 comment pointer remains owed by the next bounded package owning packages/domain/**; cross-venue aggressor-imbalance comparison once two adapters' trades land in one store (bears on WP-090's open U-CB-3)
~~~

New:

~~~new
- `WP-080-FU1`: §1's biconditional parser remains whole-document/first-match (LOW). It is a dormant future-edit risk: no duplicate exists in the ADR today. Optional follow-up: §1 parser span-scoping, to `### 1`–`### 2`. A cross-venue aggressor-imbalance comparison is owed once two adapters' trades land in one store; it bears on WP-090's open U-CB-3.
~~~

Keep (in both texts):

~~~keep
biconditional parser remains whole-document
cross-venue aggressor-imbalance comparison
U-CB-3
§1 parser span-scoping
whole-document/first-match
dormant future-edit risk
no duplicate exists in the ADR today
~~~

Not carried:

~~~drop lines=37-37
NOTE — §7-duplicate precondition intentionally couples the historical probe suite to the ADR wording => history: a deliberate coupling, not an obligation
the packages/domain ADR-014 comment pointer remains owed by the next bounded package owning packages/domain/** => closed-by `GOV-1C` (its scope item 2 added the pointer)
~~~

**Facts.** Kept: the LOW §1 parser residual, whole-document/first-match and dormant (no duplicate exists in the ADR today; r5 restores both qualifiers), with its optional follow-up, §1 parser span-scoping, and the cross-venue comparison tied to U-CB-3. The drop lines give the rest: the NOTE on the §7-duplicate precondition is a deliberate coupling, and `GOV-1C` added the packages/domain ADR-014 comment pointer (its scope item 2). The rest of the row is history in `work-packages-waves-0-2.md`.

## RW-98: Complete row `GOV-1C`: residuals still owned

Excerpt of base line 40:

~~~excerpt lines=40-40
(D1) 2d is a dual-surface rename (human id F14, machine `rule` keeps accepted alias F-OPAQUE — a strict swap is jointly unsatisfiable with the no-test-change gate because the pinned tooling suite structurally asserts the legacy id; tool+suite swap registered as a bounded follow-up)
~~~

New:

~~~new
- `GOV-1C`: the F14 rename is dual-surface: the human id is F14, but the machine `rule` keeps accepted alias F-OPAQUE. A strict swap cannot pass the no-test-change gate, because the pinned tooling suite asserts the legacy id. The tool+suite swap is a bounded follow-up: a future tooling grant changes the tool and its pinned `test/unit/tooling` assertions together.
~~~

Keep (in both texts):

~~~keep
dual-surface
machine rule keeps accepted alias F-OPAQUE
tool+suite swap
asserts the legacy id
no-test-change gate
~~~

**Facts.** Kept: deviation D1's open half, the machine `rule` alias, why a strict swap fails (the no-test-change gate and the pinned suite that asserts the legacy id; r5 restores it), and the registered tool+suite swap. The completion record's own carried follow-ups (lines 937-945) are a record item with their own entry, RW-128. The eight scope items were this round's work and are history in `work-packages-waves-0-2.md`.

## RW-99: Complete row `WP-170`: residuals still owned

Excerpt of base line 42, and the completion record's items at lines 802-805 and 806-815:

~~~excerpt lines=42-42
Two LOW residuals carried — see completion record.
~~~

~~~excerpt lines=802-805
- **Residuals (LOW)**: the depth-memo's refusal-WORDING precision is observable but
  unfixtured; and one refusal branch documented as unreachable is reachable from a compiling
  fixture (`interface Callable { (value: unknown): string }`) though the mechanism FAILED
  CLOSED and hid nothing — taxonomy corrected pre-merge by disclosed edit `ef2368e`.
~~~

~~~excerpt lines=806-815
- **Carried follow-ups** (owners): fixture those two branches (next toucher of the
  derivation); prove each battery adapter calls the callable it names; enumerate callables
  handed out as ARGUMENTS (frontier confirmed correctly drawn but open); the refined
  read-discipline rule distinguishing caller data from stateful ports, total predicates and
  explicitly partial APIs; WP-230 must supply fresh-or-copied views, pass plain checkpoint
  documents, not swallow `StrategyContextRevokedError`, and surface
  `PARAMS_NOT_MATERIALIZABLE` / `EVALUATION_SEQ_EXHAUSTED`; WP-220 authors must know the
  context is invocation-scoped, state deeper than 64 containers is refused, and derived
  structures belong on the strategy object; consider promoting the derivation to shared
  test infrastructure.
~~~

New:

~~~new
- `WP-170`: two LOW residuals. The depth-memo's refusal-wording precision is observable but unfixtured. One refusal branch documented as unreachable is reachable from a compiling fixture (`interface Callable { (value: unknown): string }`); it failed closed and hid nothing, and `ef2368e` corrected the taxonomy before the merge. Owed by the next toucher of the derivation: fixture those two branches; prove each battery adapter calls the callable it names; enumerate callables handed out as arguments (the frontier is correctly drawn but open). Also owed: the refined read-discipline rule (caller data vs stateful ports, total predicates, explicitly partial APIs). Optional: promote the derivation to shared test infrastructure.
~~~

Keep (in both texts):

~~~keep
refusal-wording precision is observable but unfixtured
reachable from a compiling fixture
fixture those two branches
prove each battery adapter calls the callable it names
two LOW residuals
enumerate callables handed out as arguments
read-discipline rule
shared test infrastructure
hid nothing
correctly drawn but open
~~~

**Facts.** The row defers to its completion record, so the entry quotes both. Kept: the two LOW residuals, with the compiling fixture, the fail-closed outcome that hid nothing, and the `ef2368e` taxonomy correction (r5 restores these three); the follow-ups owed by the next toucher of the derivation, with the open frontier (r5); the refined read-discipline rule and the optional promotion to shared test infrastructure. The obligations addressed to `WP-230` and `WP-220` are closed by those packages (the record item's disposition). History: `completion-records-wave-1.md` and `work-packages-waves-0-2.md`.

## RW-100: Complete row `WP-180`: residuals still owned

Excerpts of base line 43:

~~~excerpt lines=43-43
**Genuine residual (contract gap, for a future contract-owner round):** annotate which identifier `OpenOrderCommitmentSchema.orderId` and `PortfolioOpenOrderSchema.orderId` carry, so this is settled as a fact rather than a reading.
**Carried residuals/follow-ups** (owners): R6-1 layer-1 `node:util` import (open, non-blocking); R8-1 descriptor literals repo-wide; R8-2 dotted-write syntactic gate; R9-1 census indirection detector (alias/cast) for scope item 8;
~~~

New:

~~~new
- `WP-180`: a contract gap for a future contract-owner round: annotate which identifier `OpenOrderCommitmentSchema.orderId` and `PortfolioOpenOrderSchema.orderId` carry, so this is settled as a fact rather than a reading. A disclosed known risk: `QuoteIntent` has no expected-edge field, so under the default `requirePositiveNetEdgeForEntries: true` every quote intent is refused with `RISK_EDGE_INPUTS_MISSING`. R8-1, R8-2 and R9-1 are in `R8-1` and `§5 item 6` above.
~~~

Keep (in both texts):

~~~keep
annotate which identifier OpenOrderCommitmentSchema.orderId and PortfolioOpenOrderSchema.orderId carry
QuoteIntent has no expected-edge field
every quote intent is refused with RISK_EDGE_INPUTS_MISSING
settled as a fact rather than a reading
~~~

~~~excerpt lines=43-43
Disclosed known risk: `QuoteIntent` has no expected-edge field, so under the default `requirePositiveNetEdgeForEntries: true` every quote intent is refused with `RISK_EDGE_INPUTS_MISSING`.
~~~

Not carried:

~~~drop lines=43-43
R6-1 layer-1 `node:util` import (open, non-blocking) => closed-by `GOV-2A` (its §2.2 built-in allowlist)
R8-2 dotted-write syntactic gate => brief: Residual queue — `§5 item 6`
R9-1 census indirection detector (alias/cast) for scope item 8 => brief: Residual queue — `§5 item 6`
**R9-2 + L10-1 + N10-1/N10-2 — fold the round-9/10 residual classes => closed-by `GOV-2A` (the cross-package schema-boundary governance round)
N10-3 (M7 not independently re-run => history: a review note on how a mutant was killed; no owner
N10-4 (cold-worker coldness rests on vitest per-file isolation => history: a disclosed test-method note; no owner
whether layer 1 may import Node built-ins at all => closed-by `GOV-2A` (the §2.2 built-in allowlist)
a digit-leading UUID `strategyInstanceId` refuses as `RISK_INPUT_INVALID` => closed-by `ALLOC-1`, `TRDR-1` (ADR-021, discharged end to end)
a cancel cannot bypass input validation itself, so a cancel whose `approvedIntentId` violates ADR-016 => history: review round 3 recorded "the reported `approvedIntentId` case CLOSED"
~~~

**Facts.** Kept: the orderId contract gap and its purpose (a fact, not a reading; r5), and the disclosed known risk that every default-policy quote intent is refused with `RISK_EDGE_INPUTS_MISSING` (r4 restores it). R8-1, R8-2 and R9-1 are the brief's `R8-1` and `§5 item 6` rows. The drop lines give each other residual's closure: R6-1/R5-1 and the round-9/10 classes went to `GOV-2A`; the digit-leading `strategyInstanceId` to `ALLOC-1` and `TRDR-1`; the `approvedIntentId` cancel case closed in review round 3; two review notes have no owner. The ten-round review record is history in `work-packages-waves-0-2.md`.

## RW-101: Complete row `WP-210`: residuals still owned

Excerpt of base line 45:

~~~excerpt lines=45-45
Carried residuals (r5's 3 LOW + 3 NOTE, all pre-existing or no-live-route, owners in `docs/handoffs/WP-210.md`): R5-L1 LoadedDataset container mutability, R5-L3 the unvalidated atEvent anchor, the NaN-sentinel parse-don't-coerce note — all → WP-230/next bounded simulation grant; segmentFileSha256 + compacted-object registration → migration owner; fee rounding direction → venue verification; §12.1 port-interface landing → contract owner recording.
~~~

New:

~~~new
- `WP-210`: r5's 3 LOW + 3 NOTE are carried; all are pre-existing or have no live route. R5-L1 (the LoadedDataset container mutability), R5-L3 (the unvalidated atEvent anchor) and the NaN-sentinel parse-don't-coerce note go to the next bounded simulation grant. The migration owner owns the segmentFileSha256 + compacted-object registration. Fee rounding direction waits on venue verification (U-16 above).
~~~

Keep (in both texts):

~~~keep
LoadedDataset container mutability
the unvalidated atEvent anchor
segmentFileSha256 + compacted-object registration
3 LOW + 3 NOTE
~~~

Not carried:

~~~drop lines=45-45
fee rounding direction → venue verification => brief: Venue drift carried forward — U-16
owners in `docs/handoffs/WP-210.md` => brief: Work packages (the WP-210 row links the handoff)
§12.1 port-interface landing → contract owner recording => closed-by `H8-GOV` (r6: docs/contracts/dependency-direction.md §2.1 row S15 records the three §12.1 interfaces Clock, MarketEventSource and ExecutionVenue in packages/simulation, citing docs/handoffs/WP-210.md deviation 3; `CORE-MOVE` activated the row)
~~~

**Facts.** Kept: every carried residual that is still open, with its owner, one sentence each, and that all six are pre-existing or have no live route (r5 restores the count and the qualifier). `WP-230`'s row records observeTrade wired and cashBalance parsed-not-coerced, and the dataset freeze and atEvent carried forward, so the brief names the next bounded simulation grant for those. Fee rounding direction is U-16 under Venue drift. r6 finds the §12.1 recording done before the cut: WP-210's follow_up 6 asked for a line in `dependency-direction.md` §2.1, and `H8-GOV`'s row S15 is that line. History: `work-packages-waves-0-2.md`.

## RW-102: Complete row `WP-180-FU2`: nothing still owed (r6)

r6 found the one residual r1-r5 carried already closed before the cut, so this entry holds no excerpt and no new text. The row's declaration is `none:` with the evidence.

Not carried:

~~~drop lines=46-46
which also carries the schema-boundary §1 staleness (outside grant, next governance ride) => history: corrected before the cut by `7d798f5` (2026-09-05, "§1 mirror-collapse correction"): `docs/contracts/schema-boundary.md` §1, lines 27-37, carries the dated "(Corrected 2026-09-05 …)" note naming `WP-180-FU2` and `625c83b`
NOTE-1 (risk README §8 edit sits outside the grant's literal allowed_paths — legitimate ripple) => history: a grant-edge note, ratified in the record
~~~

**Facts.** Nothing is owed. r1-r5 carried the schema-boundary §1 staleness to "the next governance ride", but `7d798f5`, an ancestor of `f43efe6`, already wrote that correction (verifier finding I2, r6). NOTE-1 was ratified in the record. The row also discharges WP-190 R1-N4 and the mirror-collapse ruling. The chain and the review are history in `work-packages-waves-0-2.md`.

## RW-103: Complete row `WP-220`: residuals still owned

Excerpt of base line 47:

~~~excerpt lines=47-47
Accepted disclosed residuals + owned follow-ups (execution-planner buildReductionPlan maximumBuyPrice/unnamed-sides; domain ADR ReducePositionIntent.direction; risk protective-reduction recognition; WP-230 composition-root obligations 1–10; the decimal round) recorded in `docs/handoffs/WP-220.md`.
~~~

New:

~~~new
- `WP-220`: follow-ups in `docs/handoffs/WP-220.md`: execution-planner buildReductionPlan maximumBuyPrice/unnamed-sides, and a domain ADR on `ReducePositionIntent.direction`.
~~~

Keep (in both texts):

~~~keep
buildReductionPlan maximumBuyPrice/unnamed-sides
ReducePositionIntent.direction
~~~

**Facts.** Kept: the two follow-ups no later row closes. Closed elsewhere: risk protective-reduction recognition (`RISK-2`), the composition-root obligations 1-10 (`WP-230`), the decimal round (`WP-020-FU1`). The four review rounds are history in `work-packages-waves-0-2.md`.

## RW-104: Complete row `WP-200-FU1`: residuals still owned

Excerpts of base line 48:

~~~excerpt lines=48-48
Follow-ups routed: the packages/risk GRANT-AND-WIDEN round (next in queue, carries this round's base/tip measurements), the packages/decimal round (r1 NOTE-1 + WP-220 r1 M2 + GOV-2A follow-up 5), the schema-boundary §3 LIVE→CLOSED row flips (contract-owner ride, EXECUTED 2026-09-05: `7d798f5` + corrective `e060f70` after a Codex confirming round on gpt-6-astra — the first Astra round of this run — returned exactly one MEDIUM, two remaining stale mirror-shape sites, closed with the reviewer's own site list; arithmetic, ADR-020 framing, and closure support all independently confirmed), the pnl helper census, r2's two doc-wording LOWs.
Rulings: availability class GRANT-AND-WIDEN (the packages/risk grant should cover the WHOLE append surface with CreateDataProperty appends + an index-"0" regression); applyPnlRecord state RESIDUAL-accept; transitive node:util RESIDUAL, no governance note owed
~~~

New:

~~~new
- `WP-200-FU1`: routed follow-ups still owed: the pnl helper census, and r2's two doc-wording LOWs. The `applyPnlRecord` state is accepted as a residual. Known risks: the `…OfValidated` cores are an internal pre-D1 surface (not re-exported; internal use unpinned). The ports guard is a text guard, which a dynamic specifier evades.
~~~

Keep (in both texts):

~~~keep
the pnl helper census
r2's two doc-wording LOWs
applyPnlRecord state
OfValidated cores are an internal pre-D1 surface
internal use unpinned
ports guard is a text guard
~~~

~~~excerpt lines=48-48
Known risks for r2: the `…OfValidated` cores are an internal pre-D1 surface (pinned not-re-exported, internal use unpinned); ports guard is a text guard (dynamic-specifier evasion, S3/S4-precedent shape).
~~~

Not carried:

~~~drop lines=48-48
completion record with residuals and owned follow-ups: `docs/handoffs/WP-200-FU1.md`) => history: the completion record's path
Rulings: availability class GRANT-AND-WIDEN => closed-by `WP-020-FU1` (its (d): the whole append surface)
transitive node:util RESIDUAL, no governance note owed => history: a ruling that owes nothing
the packages/risk GRANT-AND-WIDEN round (next in queue => closed-by `WP-020-FU1` (its merge discharged WP-200-FU1 follow-ups 1-2)
the packages/decimal round (r1 NOTE-1 => closed-by `WP-020-FU1` (its merge discharged WP-200-FU1 follow-ups 1-2)
the schema-boundary §3 LIVE→CLOSED row flips (contract-owner ride, EXECUTED 2026-09-05: `7d798f5` + corrective `e060f70` => history: executed 2026-09-05
~~~

**Facts.** Kept: the two routed follow-ups no later row records, the accepted `applyPnlRecord` state residual, and the two r2 known risks: the internal `…OfValidated` surface and the text-only ports guard (r4 restores both; `docs/handoffs/WP-200-FU1.md` lines 83-87 keep them). Closed elsewhere: the risk GRANT-AND-WIDEN round, the decimal round and NOTE-1 (`WP-020-FU1` (a)-(d)); the §3 row flips were executed (`7d798f5`, `e060f70`). History: `work-packages-waves-0-2.md`.

## RW-105: Complete row `GOV-2A`: nothing still owed (r6)

r6 found the two review NOTEs r1-r5 carried already closed by `GOV-2A`'s own remediation r1, so this entry holds no excerpt and no new text.

Not carried:

~~~drop lines=49-49
F17 id collision ruled acceptable-with-cross-reference (reciprocal note owed) => closed-by `GOV-2A` (remediation r1 9e4421f: docs/handoffs/GOV-2A.md line 604 records NOTE-1 ADOPTED, and docs/contracts/dependency-direction.md line 663 carries the reciprocal id-namespace note to `WP-040` F17)
probe sources not committed (inline them) => closed-by `GOV-2A` (remediation r1 9e4421f: docs/handoffs/GOV-2A.md line 605 records NOTE-2 ADOPTED; the probe sources are in its Appendix A, and the round-1 sources are disclosed as unrecoverable)
F19 grant-time path-widening flag => closed-by `GOV-2A` (NOTE-3 ADOPTED: recorded in protected-contracts.md R-9)
calls≠states => closed-by `GOV-2A` (NOTE-4 ADOPTED: the wording corrected)
~~~

**Facts.** Nothing is owed. r1-r5 carried "reciprocal note owed" and "inline them" as open, but the base row itself says remediation r1 `9e4421f` "fixed all eleven" with "probe sources committed re-runnable", and the record's review table (lines 604-607 of `docs/handoffs/GOV-2A.md`) marks all four NOTEs ADOPTED (verifier finding I1, r6). GOV-2A's rulings (the F12/F17/F18/F19 reassignment, C-2 ratification) are history in `work-packages-waves-0-2.md`.

## RW-106: Complete row `WP-190`: residuals still owned

Excerpt of base line 52:

~~~excerpt lines=52-52
Carried: **R1-L1** deferred LOW — exported `buyLimitPrice`/`sellLimitPrice` (price.ts:149,185) throw on non-canonical decimal input against the refusals.ts totality claim (composed entries ARE total; fix or scope the claim — next bounded package or governance round); **R1-N2** `node:util` now in a third package AND a new file (pluck.ts:28,58) — governance round; **R1-N3** defensively-dead CANCEL arm in build.ts:707-712 (fail-safe); **R1-N4** third mirror duplication (collapsible with one §2.1 row — governance round).
~~~

New:

~~~new
- `WP-190`: R1-N3, a defensively-dead CANCEL arm in `build.ts:707-712` (fail-safe). R1-L1 is `N3` above.
~~~

Keep (in both texts):

~~~keep
defensively-dead CANCEL arm in build.ts:707-712
~~~

Not carried:

~~~drop lines=52-52
**R1-L1** deferred LOW — exported `buyLimitPrice`/`sellLimitPrice` => brief: Residual queue — `N3`
composed entries ARE total => brief: Residual queue — `N3` (the composed entries `buildExecutionPlan` and `sealExecutionPlan` are total)
**R1-N2** `node:util` now in a third package AND a new file => closed-by `GOV-2A` (the §2.2 built-in allowlist)
**R1-N4** third mirror duplication => closed-by `WP-180-FU2` (it discharged R1-N4)
~~~

**Facts.** Kept: R1-N3. R1-L1 is the brief's `N3` row, including its qualifier that the composed entries are total (r8; r1-r7 dropped it, verifier finding CX-R8-01). Closed elsewhere: R1-N4 (`WP-180-FU2` discharged it) and R1-N2 (`node:util`, the `GOV-2A` built-in allowlist). History: `work-packages-waves-0-2.md`.

## RW-107: Complete row `WP-020-FU1`: residuals still owned

Excerpt of base line 54:

~~~excerpt lines=54-54
Residual risks: compareDecimal still 1.67× (remaining 248ns is the one sound `getOwnPropertyNames(Object.prototype)`); the double-guard on two delegating entry points (follow-up); the 10.3s ledger battery file (split candidate, WP-200 owner).
~~~

New:

~~~new
- `WP-020-FU1`: residual risks: `compareDecimal` still 1.67× slower (the remaining 248ns is the one sound `getOwnPropertyNames(Object.prototype)`); the double-guard on two delegating entry points (a follow-up); the 10.3s ledger battery file (a split candidate; WP-200 owner).
~~~

Keep (in both texts):

~~~keep
compareDecimal still 1.67×
the double-guard on two delegating entry points
the 10.3s ledger battery file
remaining 248ns is the one sound getOwnPropertyNames(Object.prototype)
~~~

Not carried:

~~~drop lines=54-54
one coverage LOW — the dual-intrinsic refusal-restoration pin — owed to the risk remainder round => closed-by `WP-180-FU3` (the risk remainder round)
Completion record with residuals and owned follow-ups: `docs/handoffs/WP-020-FU1.md` => history: the completion record's path
risk-remainder round, ledger/pnl accumulators, schema-boundary §2 index-name row (contract-owner) => closed-by `WP-180-FU3`, `WP-200-FU2`, `GOV-2C`
~~~

**Facts.** Kept: the three residual risks, with the cause of the 248ns remainder, the one sound `getOwnPropertyNames(Object.prototype)` (r5 restores it). Closed elsewhere: the dual-intrinsic pin (`WP-180-FU3`), the ledger/pnl accumulators (`WP-200-FU2`), and the schema-boundary row updates (the contract-owner docs round, `GOV-2C`). History: `work-packages-waves-0-2.md`.

## RW-108: Complete row `WP-230`: residuals still owned

Excerpt of base line 55:

~~~excerpt lines=55-55
Completion record with residuals and owned follow-ups: `docs/handoffs/WP-230.md` (notably: the strategyInstanceId contract-owner ruling queued; the risk-seam ENTRY-disposition follow-up; r3 LOW-1/NOTE-1 folded into WP-240; the arena-error-construction schema-boundary §2 candidate row).
N3 dispositioned (fail-closed at the reservation; the first BASKET emitter owes the probe).
New known risks: SHADOW has no execution semantics until an independent-book design lands (README follow-up 4); the ownership gate is structural-not-typed with the LIVE arm as backstop.
Known risks: unknown-submission holds both reservations deliberately, now VISIBLE via `seams.reservations.open`; the partial-fill double-count between posting and terminal state (fail-closed); the SHADOW covering snapshot built locally from `EXPOSURE_ZERO` (package publishes LIVE-only builder — follow-up); the ledger schema-boundary battery timeout flake CHARACTERIZED as pre-existing load-sensitivity (fails identically at the baseline shape with the new files excluded; passes isolated)
Follow-ups: the flake budget (WP-200 owner), `shadowExposureSnapshotCovering` (capital-allocator), §7.7 QuoteLevel outcome-token ADR, live-owner attribution for history-loaded positions.
~~~

New:

~~~new
- `WP-230` follow-ups: the flake budget (WP-200 owner); `shadowExposureSnapshotCovering` (capital-allocator); a §7.7 QuoteLevel outcome-token ADR. Also: live-owner attribution for history-loaded positions. Known risks: SHADOW has no execution semantics until an independent-book design lands (README follow-up 4). The ownership gate is structural, not typed, with the LIVE arm as backstop. An unknown submission holds both reservations deliberately, now visible via `seams.reservations.open`. The partial-fill double-count between posting and terminal state fails closed. The SHADOW covering snapshot is built locally from `EXPOSURE_ZERO`, because the package publishes a LIVE-only builder (the `shadowExposureSnapshotCovering` follow-up). The ledger schema-boundary battery timeout flake is pre-existing load-sensitivity: it fails identically at the baseline shape with the new files excluded, and passes isolated. N3 is fail-closed at the reservation; the first BASKET emitter owes the probe.
~~~

Keep (in both texts):

~~~keep
shadowExposureSnapshotCovering
§7.7 QuoteLevel outcome-token ADR
live-owner attribution for history-loaded positions
SHADOW has no execution semantics until an independent-book design lands
the first BASKET emitter owes the probe
partial-fill double-count between posting and terminal state
with the LIVE arm as backstop
holds both reservations deliberately
now VISIBLE via seams.reservations.open
built locally from EXPOSURE_ZERO
LIVE-only builder
pre-existing load-sensitivity
fails identically at the baseline shape with the new files excluded
passes isolated
fail-closed at the reservation
~~~

Not carried:

~~~drop lines=55-55
observeTrade WIRED, cashBalance parsed-not-coerced, dataset-freeze/atEvent carried forward => brief: Residuals recorded in Complete package rows — WP-210 (R5-L1 and R5-L3, the next bounded simulation grant)
WP-200 halt-enforcement reads BOTH ledger sections together => history: done by this package
`immediate_order_type` RESOLVED => history: resolved by this package
Completion record with residuals and owned follow-ups: `docs/handoffs/WP-230.md` => brief: Work packages (the WP-230 row links the handoff)
the strategyInstanceId contract-owner ruling queued => closed-by `ALLOC-1`, `TRDR-1` (ADR-021)
the risk-seam ENTRY-disposition follow-up => closed-by `RISK-2`
the arena-error-construction schema-boundary §2 candidate row => history: written before the cut by the contract-owner round `dfac304` (2026-09-06): `docs/contracts/schema-boundary.md` §2, line 79, is the row "Error construction *(measured by `WP-230` review r1; independently confirmed)*", with the ADR-020 amendment
r3 LOW-1/NOTE-1 folded into WP-240 => brief: Residuals recorded in Complete package rows — WP-240 (WP-230 r3 LOW-1/NOTE-1 stay carried)
~~~

**Facts.** Kept: every follow-up and known risk the row names that is still open, each with its detail. r5 restores four details r4 dropped: the reservations are visible via `seams.reservations.open`; the SHADOW covering snapshot is built locally from `EXPOSURE_ZERO` because the package publishes a LIVE-only builder; the flake is characterized as pre-existing load-sensitivity; and N3 is fail-closed at the reservation. Closed elsewhere: the strategyInstanceId ruling (`ALLOC-1`, `TRDR-1`) and the risk-seam ENTRY disposition (`RISK-2`). r6 drops the §2 candidate row: `dfac304` wrote it (schema-boundary.md line 79) before the cut. r3 LOW-1/NOTE-1 are carried by `WP-240`, below. The packet and the review rounds are history in `work-packages-waves-0-2.md`.

## RW-109: Complete row `WP-170-FU1`: residuals still owned

Excerpt of base line 56:

~~~excerpt lines=56-56
Known risks: the `values` defeat stays open (fail-closed; closes with the queued risk `ARENA_NODE_TYPES` widening, after which the whole modelOutputs split collapses);
NEW DISCLOSURE (r2 verifies the three-way identity): an own `__proto__` inside the input's `sourceEvent` reaches the persisted `record.sourceEvent` verbatim at base AND candidate AND remediated tip — pre-existing, producer-side, deliberately untouched (a permission change there needs its own measured round; follow-up 3).
Completion record with residuals and owners: `docs/handoffs/WP-170-FU1.md` (notably: the `values` residual and the modelOutputs-split collapse ride the queued packages/risk remainder round; the schema-boundary §3 strategy-runtime row flip rides the queued contract-owner round; the input-snapshot `__proto__` permission decision is a named future round).
~~~

New:

~~~new
- `WP-170-FU1`: the `values` defeat stays open (fail-closed). The `ARENA_NODE_TYPES` widening it waited on landed in `WP-180-FU3` (`8c14b47`), so it now closes with the strategy-runtime modelOutputs split collapse (Schema boundary above). The input-snapshot `__proto__` permission decision is a named future round (follow-up 3): an own `__proto__` inside the input's `sourceEvent` reaches the persisted `record.sourceEvent` verbatim. This is pre-existing, producer-side and deliberately untouched: a permission change there needs its own measured round.
~~~

Keep (in both texts):

~~~keep
the values defeat stays open
ARENA_NODE_TYPES widening
modelOutputs split collapse
input-snapshot __proto__ permission decision is a named future round
reaches the persisted record.sourceEvent verbatim
pre-existing, producer-side
deliberately untouched
needs its own measured round
~~~

Not carried:

~~~drop lines=56-56
fail-closed; closes with the queued risk `ARENA_NODE_TYPES` widening => closed-by `WP-180-FU3` (8c14b47 grew ARENA_NODE_TYPES with "null"; docs/contracts/schema-boundary.md line 117 says the residual now closes with the strategy-runtime-side modelOutputs split collapse)
DECISION_VIEW/EVALUATION_VIEW differ on exactly one axis, pinned both directions => history: a pinned design fact, not an obligation
Completion record with residuals and owners: `docs/handoffs/WP-170-FU1.md` => brief: Work packages (the WP-170-FU1 row links the handoff)
~~~

**Facts.** Kept: the open `values` defeat with its closing condition, as the contract states it at the cut: the widening landed in `WP-180-FU3` (`8c14b47`), and the split collapse remains (r6; r1-r5 still called the widening queued), and the `__proto__` permission decision with the fact it rests on and why it was left alone (pre-existing, producer-side, a permission change needs its own measured round; r5). The schema-boundary §3 row flip rode the docs round. The review rounds are history in `work-packages-waves-0-2.md`.

## RW-110: Complete row `WP-240`: residuals still owned

Excerpt of base line 57:

~~~excerpt lines=57-57
D3 a second exposition renderer (WP-140's is closure-bound; collapse is a follow-up);
REPORTED-NOT-PATCHED: WP-230 r3 LOW-1/NOTE-1 stay carried (the packet ruled apps/trader read-only — they move to the future apps/trader grant that also serves the health endpoint + safety-table collapse);
KNOWN RISKS (disclosed, honest): postgres audit sink typecheck-pinned ONLY (no Docker; NO integration evidence claimed; `randomUUID()` v4 vs `internal.uuid_v7` domain conflict documented in code — durable composition must use `uuidV7()`); the trader-health seam is caller/wire input NOT wired to a trader (apps/trader exposes no HTTP health endpoint; `control_trader_health_available` reads 0 and the first panel says so); an engaged kill switch does not reach a running trader (no IPC seam in-repo — composition obligation, seam design queued); in-memory audit log not durable (correct for PAPER-no-database; Postgres port ready); bearer-token model loopback-PAPER-sized (no rotation/expiry; off-host needs TLS + stronger credentials); dashboards never imported into a real Grafana (validated as JSON only).
~~~

~~~excerpt lines=57-57
FOUR pending panels each with a named owner (realized-PnL → future apps/trader grant; replay-determinism metric → future simulation/backtest-cli grant; predicted-vs-actual → WP-290/phase-4; markout → future simulation/research grant), machine-checked against `PENDING_PRODUCER_PANELS` both directions.
~~~

New:

~~~new
- `WP-240`, beyond `N8`: D3, a second exposition renderer (WP-140's is closure-bound; collapse is a follow-up). An engaged kill switch does not reach a running trader (no IPC seam in-repo; a composition obligation; seam design queued). The in-memory audit log is not durable (correct for PAPER without a database; the Postgres port is ready). The postgres audit sink is typecheck-pinned only, with no integration evidence (no Docker). It mints ids with `randomUUID()` (v4), which conflicts with the `internal.uuid_v7` domain (documented in code), so durable composition must use `uuidV7()` (`apps/control-api/src/main.ts:80-90`). The bearer-token model is sized for loopback PAPER: no rotation or expiry; off-host needs TLS and stronger credentials. Two fidelity panels stay pending, each with a named owner, machine-checked against `PENDING_PRODUCER_PANELS`: predicted-vs-actual (WP-290/phase-4) and markout (a future simulation/research grant). The third pending panel, replay-determinism, is `WP-250`'s F2 (next bullet). WP-230 r3 LOW-1/NOTE-1 stay carried, reported but not patched: the packet ruled apps/trader read-only, so they move to the future apps/trader grant (the record also routes the safety-table collapse there).
~~~

Keep (in both texts):

~~~keep
collapse is a follow-up
an engaged kill switch does not reach a running trader
seam design queued
in-memory audit log
correct for PAPER
WP-230 r3 LOW-1/NOTE-1 stay carried
typecheck-pinned
randomUUID()
internal.uuid_v7
durable composition must use uuidV7()
bearer-token model
off-host needs TLS
closure-bound
composition obligation
Postgres port
documented in code
the packet ruled apps/trader read-only
safety-table collapse
predicted-vs-actual
WP-290/phase-4
markout
simulation/research grant
PENDING_PRODUCER_PANELS
~~~

Not carried:

~~~drop lines=57-57
the trader-health seam is caller/wire input NOT wired to a trader => closed-by `TRDR-3` (the trader health endpoint; M-2 closed)
realized-PnL → future apps/trader grant => closed-by `TRDR-3` (the "Realized PnL" panel binds a produced family; PENDING_PRODUCER_PANELS lists three panels at f43efe6)
replay-determinism metric → future simulation/backtest-cli grant => brief: Residuals recorded in Complete package rows — WP-250 (F2, the replay-determinism panel's producer, with its owner: a future packages/simulation or apps/backtest-cli grant)
dashboards never imported into a real Grafana => brief: Human items — H3 (a real Grafana imported and rendered the dashboards, 2026-09-29)
~~~

**Facts.** Kept: the design follow-ups outside `N8`, and every open known risk: the in-memory audit log (the Postgres port is ready); the typecheck-pinned postgres sink with its `randomUUID()` v4 vs `internal.uuid_v7` conflict (at `f43efe6`, `apps/control-api/src/main.ts` lines 80-90 still mint ids with `randomUUID()`); and the loopback-PAPER bearer-token model. r5 restores the qualifiers r4 dropped: WP-140's renderer is closure-bound, the kill-switch seam is a composition obligation, the v4/v7 conflict is documented in code, and LOW-1/NOTE-1 were reported, not patched, because the packet ruled apps/trader read-only. M-1, M-3, the LOWs and N-4 are the brief's `N8` row. r6 adds the two other pending panels, predicted-vs-actual (`WP-290`/phase-4) and markout (a future simulation/research grant), which r1-r5 neither carried nor dropped (verifier finding I6); `packages/observability/src/control/dashboards.ts` still declares both at `f43efe6`. The realized-PnL panel closed with `TRDR-3`, and the replay-determinism panel is WP-250's F2; r8 names its owner there, as `PENDING_PRODUCER_PANELS` does at `f43efe6` (a future `packages/simulation` or `apps/backtest-cli` grant; verifier finding CX-R8-02). r7 writes "Two fidelity panels", not "Two more", and points to WP-250's F2 for the third (verifier finding D5). M-2 and the unwired trader-health seam closed with `TRDR-3`, and H3 imported the dashboards into a real Grafana. Not carried: N-1 (the family count, reconciled in the record) and the deferred root wiring (ratified at merge). History: `work-packages-waves-0-2.md`.

## RW-111: Complete row `WP-250`: residuals still owned

Excerpts of base line 58:

~~~excerpt lines=58-58
F2 the replay-determinism panel's producer stays PENDING with its named owner. Completion record: `docs/handoffs/WP-250.md` (incl. the next-e2e-touch pin follow-ups: exact-count assertions — this round PROVED prose can desynchronize — the `"50"` pin, the LOW-3 tightening).
~~~

New:

~~~new
- `WP-250`: F2, the replay-determinism panel's producer stays PENDING with its named owner: a future `packages/simulation` or `apps/backtest-cli` grant. `WP-250` could not add the producer (hard-forbidden paths: its allowed paths forbid `packages/**` and `apps/**`). The next-e2e-touch pin follow-ups in `docs/handoffs/WP-250.md`: exact-count assertions (this round proved prose can desynchronize), the `"50"` pin, the LOW-3 tightening. A disclosed known risk: the `SHARED_BOOK_ACCOUNTING_MODE` backstop is read-in-source only.
~~~

Keep (in both texts):

~~~keep
replay-determinism panel's producer stays PENDING
next-e2e-touch pin follow-ups
the LOW-3 tightening
stays PENDING with its named owner
SHARED_BOOK_ACCOUNTING_MODE backstop
read-in-source only
hard-forbidden paths
prose can desynchronize
~~~

~~~excerpt lines=58-58
Known risks: F1 no realized round trip reachable (above); F2 the replay-determinism dashboard panel still has no producer (hard-forbidden paths — stays PENDING with its named owner); the `SHARED_BOOK_ACCOUNTING_MODE` backstop read-in-source only, disclosed.
~~~

Not carried:

~~~drop lines=58-58
F1 no realized round trip reachable (above) => closed-by `RISK-2`, `BRACKET-1a`
~~~

**Facts.** Kept: F2 with its reason (hard-forbidden paths) and, since r8, its named owner: a future `packages/simulation` or `apps/backtest-cli` grant (base line 57, RW-110; `packages/observability/src/control/dashboards.ts` at `f43efe6`), the next-e2e-touch pin follow-ups with the reason for exact counts (prose can desynchronize; r5 restores both reasons), and the known risk that the `SHARED_BOOK_ACCOUNTING_MODE` backstop is read-in-source only. F1 (no realized round trip) closed with `RISK-2` and `BRACKET-1a`. The golden, the scenario and the review are history in `work-packages-waves-0-2.md`.

## RW-112: Complete row `WP-180-FU3`: residuals still owned

Excerpt of base line 59:

~~~excerpt lines=59-59
Residuals owned (docs/handoffs/WP-180-FU3.md): zod array-assembly availability residual (18 rows/intrinsic, fail-closed; isFreshOrdinaryContainer widening is a designed round with capital-allocator/ledger/pnl/strategy-runtime in scope); r1 N1 ownEntry guard untested (pre-existing); r1 N2 lots.ts:151 sort sentence; r1 N3 ADR-016 §2 evidence shape for this one field now issues-based — NO live consumer loses anything (Codex-corrected in the docs round: no live path reads details for this refusal at all; the loop records refusal codes only, loop.ts:1088–1091), ADR-016 dated amendment recorded; r1 N4 approved-intent five identity fields as one deferred decision.
~~~

New:

~~~new
- `WP-180-FU3`: review r1 left three items open. In r1 N1, the ownEntry guard is untested (pre-existing). In r1 N2, the `lots.ts:151` sort sentence is owed. r1 N4 treats the approved-intent five identity fields as one deferred decision. The zod array-assembly availability residual (18 rows/intrinsic, fail-closed) is the `isFreshOrdinaryContainer` round (Schema boundary above). That widening is a designed round with capital-allocator/ledger/pnl/strategy-runtime in scope.
~~~

Keep (in both texts):

~~~keep
ownEntry guard
untested (pre-existing)
lots.ts:151 sort sentence
approved-intent five identity fields as one deferred decision
zod array-assembly availability residual
18 rows/intrinsic, fail-closed
capital-allocator/ledger/pnl/strategy-runtime in scope
~~~

Not carried:

~~~drop lines=59-59
r1 N3 ADR-016 §2 evidence shape for this one field now issues-based => history: ADR-016's dated amendment is recorded, and no live consumer loses anything
~~~

**Facts.** Kept: N1, N2 and N4 (r8 writes each as a sentence, not a fragment chain; verifier finding CX-R8-03), and the zod array-assembly availability residual with its size (18 rows/intrinsic, fail-closed) and the `isFreshOrdinaryContainer` round's four-package scope (r4 restores both). N3's ADR-016 amendment is recorded. The queued doc follow-ups went to the contract-owner docs round (`GOV-2C`). History: `work-packages-rounds.md`.

## RW-113: Complete row `WP-160-FU1`: residuals still owned

Excerpt of base line 60:

~~~excerpt lines=60-60
Residuals with owners: R1-L1 the `snapshotReference` `as`-cast weakens the base structural typecheck (2 tests kill every wrong shape today; typed intermediate owned by the next features round); R1-L2 deep-vs-shallow unpinned (non-aliasing assertion owed when a consumer starts indexing); R1-N1 the returned array keeps Array.prototype (pre-existing, measured IDENTICAL at base; owner: the future WP indexing selected values into PostgreSQL); R1-N2 input-side/control-flow records remain prototype-bearing (SUCCESS wrapper, validateFeatureInput, materializeInput, parseUtcTimestamp — correctly out of the output-side grant; shallow own-property emitter design owned by a bounded GOV-2A successor round).
~~~

New:

~~~new
- `WP-160-FU1`: R1-L1, the `snapshotReference` `as`-cast weakens the base structural typecheck; 2 tests kill every wrong shape today, and a typed intermediate is owned by the next features round. R1-L2, deep-vs-shallow unpinned: a non-aliasing assertion is owed when a consumer starts indexing. R1-N1, the returned array keeps Array.prototype (pre-existing, measured identical at base); owner: the future WP indexing selected values into PostgreSQL. R1-N2: the input-side/control-flow records remain prototype-bearing (the SUCCESS wrapper, validateFeatureInput, materializeInput, parseUtcTimestamp), correctly outside the output-side grant. Owner: the shallow own-property emitter design, owned by a bounded GOV-2A successor round.
~~~

Keep (in both texts):

~~~keep
snapshotReference as-cast weakens the base structural typecheck
deep-vs-shallow unpinned
the future WP indexing selected values into PostgreSQL
remain prototype-bearing
SUCCESS wrapper, validateFeatureInput, materializeInput, parseUtcTimestamp
shallow own-property emitter design
bounded GOV-2A successor round
2 tests kill every wrong shape today
measured identical at base
output-side grant
~~~

Not carried:

~~~drop lines=60-60
flip schema-boundary §3 `packages/features` (output side) + GOV-2A §5 item 4 to executed => closed-by `GOV-2C` (the doc flip)
~~~

**Facts.** Kept: R1-L1, R1-L2 and R1-N1 with owners, and R1-N2 with its four named records and its owner, the shallow own-property emitter design in a bounded GOV-2A successor round. r5 restores the qualifiers: 2 tests kill every wrong shape today (R1-L1), R1-N1 is pre-existing and measured identical at base, and R1-N2 is correctly outside the output-side grant. The doc flip went to the docs round (`GOV-2C`); the sequencing note was discharged when `REC-1` ran. History: `work-packages-rounds.md`.

## RW-114: Complete row `REC-1`: residuals still owned

Excerpt of base line 61:

~~~excerpt lines=61-61
Residuals owned in docs/handoffs/REC-1.md (gateway format-check restatement; coinbase nested .min(1); exotic-key fail-closed refusals venue-unreachable; ownControlId absent/malformed conflation; 8 downstream uncontained .safeParse; no coinbase/rtds byte cap; unprofiled per-frame cost — operator soak; four near-parallel doors).
~~~

New:

~~~new
- `REC-1` (`docs/handoffs/REC-1.md`): the gateway format-check restatement; coinbase nested .min(1); exotic-key fail-closed refusals, venue-unreachable; ownControlId absent/malformed conflation; 8 downstream uncontained .safeParse; no coinbase/rtds byte cap; unprofiled per-frame cost (operator soak); four near-parallel doors.
~~~

Keep (in both texts):

~~~keep
coinbase nested .min(1)
ownControlId absent/malformed conflation
8 downstream uncontained .safeParse
no coinbase/rtds byte cap
four near-parallel doors
~~~

Not carried:

~~~drop lines=61-61
§3 recorder rows + tally + §5 item 3 EXECUTED + the CLOB grant entry => closed-by `GOV-2C` (the docs round)
~~~

**Facts.** Kept: all eight owned residuals. D2-not-performed and the config-door check are also under Schema boundary. The CLOB grant ran as `CLOB-1`; the doc follow-ups went to `GOV-2C`. History: `work-packages-rounds.md`.

## RW-115: Complete row `ALLOC-1`: residuals still owned

Excerpt of base line 62:

~~~excerpt lines=62-62
Residuals owned (docs/handoffs/ALLOC-1.md): r1 L1 the trader's UuidAndCodeString is version- AND variant-blind (bad-version ids pass startup, refused mid-run by risk — fail-closed; TRDR-1 must TIGHTEN to real Uuidv7Schema, not merely relax) + L2 its stale refusal text — BOTH TRDR-1 obligations; N1/N2 comment staleness (next allocator round); N3 unparsed withLiveOwner surfaces (zero non-test callers); N4 the arena/skipChecks pin gap (behavior reviewer-verified correct; coverage owed).
~~~

New:

~~~new
- `ALLOC-1`: ALLOC-1's review N1/N2 report comment staleness; the next allocator round owns them. Its N3 reports unparsed `withLiveOwner` surfaces, which have zero non-test callers. Its N4 reports the arena/skipChecks pin gap. The behavior is reviewer-verified correct, but its coverage is still owed.
~~~

Keep (in both texts):

~~~keep
comment staleness
next allocator round
unparsed withLiveOwner surfaces
zero non-test callers
the arena/skipChecks pin gap
reviewer-verified correct
~~~

Not carried:

~~~drop lines=62-62
ADR-021 second amendment (allocator corrected; evidence-shape non-change; the cap-evasion finding) => closed-by `GOV-2C` (the docs round)
WP-180-FU3 follow-up 1 done => history: done
~~~

**Facts.** Kept: N1-N4, with N4's verified behavior (r5). r7 turns the clause chain into sentences (verifier finding D2). The brief writes "ALLOC-1's review N1/N2", "Its N3" and "Its N4", because `GOV-2B`'s N2, N3 and N4 are different items. L1 and L2 were `TRDR-1`'s obligations, and `TRDR-1` is Complete. The ADR-021 doc follow-ups went to `GOV-2C`. History: `work-packages-rounds.md`.

## RW-116: Complete row `TRDR-1`: residuals still owned

Excerpt of base line 63:

~~~excerpt lines=63-63
Residuals owned (docs/handoffs/TRDR-1.md): the phase-2 report R1 narrative addendum (orchestrator, docs round — counts remain true); docs/adr/README.md:102; the comment-staleness round's fixtures/scenario prose; the local `Uuid` version-blindness asymmetry for runId/configId/marketId (the five-identity-fields decision class, with WP-180-FU3 r1 N4).
~~~

New:

~~~new
- `TRDR-1`: the comment-staleness round's fixtures/scenario prose; the local `Uuid` version-blindness asymmetry for runId/configId/marketId (the five-identity-fields decision class, with WP-180-FU3 r1 N4).
~~~

Keep (in both texts):

~~~keep
local Uuid version-blindness asymmetry for runId/configId/marketId
the comment-staleness round's fixtures/scenario prose
~~~

Not carried:

~~~drop lines=63-63
the phase-2 report R1 narrative addendum (orchestrator, docs round — counts remain true) => history: written before the cut by `e6548cf` (2026-09-07): `docs/experiments/phase-2-verification.md` line 461, "Addendum (2026-09-07): §2 R1 is RESOLVED"
docs/adr/README.md:102 => history: corrected before the cut by `e6548cf`: the ADR-021 row no longer says "stays until it lands" and reads DISCHARGED
~~~

**Facts.** Kept: the two owned residuals still open: the comment-staleness prose (`test/unit/risk/fixtures.ts` still describes the letter-leading workaround at `f43efe6`) and the local `Uuid` asymmetry. r6 drops the phase-2 R1 addendum and the `docs/adr/README.md:102` fix: `e6548cf`, the ADR-021 discharge round for the TRDR-1 merge, did both before the cut. The tripwire retirement is history in `work-packages-rounds.md`.

## RW-117: Complete row `UNIV-1`: residuals still owned

Excerpt of base line 64:

~~~excerpt lines=64-64
Residuals owned (docs/handoffs/UNIV-1.md): **r1 MED-1 the projection-side dot-read class** (five optional MarketProjection fields; a rules-hole advance under pollution — base-identical, out of the §3 row's scope; owner: a universe STATE-SIDE follow-up, the analogue of WP-160-FU1, recorded BEFORE the next universe grant); r1 MED-2 (header corrected pre-merge); the un-doored envelope layer (adoption arrives as genuine OWN keys the door provably cannot see — reviewer-reproduced end-to-end); **the registry registration doors, newly measured and reviewer-reproduced** (registerSeries adopts five keys incl. a fabricated approved-by-"ghost" binding; registerMarket adopts all four identity keys) — owner: a bounded registration-doors grant; LOW-2 drifts (two unpinned), LOW-3 unfrozen lists, NOTE-2 the decimal throw escaping the function.
~~~

New:

~~~new
- `UNIV-1`: two minor items stay open. LOW-3: the function emits unfrozen lists. NOTE-2: the decimal throw escaping the function is base-identical. `docs/handoffs/UNIV-1.md` names the `packages/universe` follow-up as their owner; `UNIV-3` ran that round, and its record names neither item.
~~~

Keep (in both texts):

~~~keep
LOW-3
unfrozen lists
NOTE-2
the decimal throw escaping the function
~~~

Not carried:

~~~drop lines=64-64
**r1 MED-1 the projection-side dot-read class** => closed-by `UNIV-3` (the 9c state-side round)
r1 MED-2 (header corrected pre-merge) => history: corrected before the merge
the un-doored envelope layer => closed-by `UNIV-2`
**the registry registration doors, newly measured and reviewer-reproduced** => closed-by `UNIV-2`
LOW-2 drifts (two unpinned) => closed-by `UNIV-3` (schema-boundary §5 item 9(c) lists "the unpinned fail-closed drifts" as EXECUTED by UNIV-3)
~~~

**Facts.** Kept: LOW-3 and NOTE-2, one sentence each, with the owner `docs/handoffs/UNIV-1.md` names (the `packages/universe` follow-up). r5 finds LOW-2 closed: `docs/contracts/schema-boundary.md` §5 item 9(c), the state-side follow-up, lists "the unpinned fail-closed drifts" and records (c) as EXECUTED by `UNIV-3`. Neither that item nor `docs/handoffs/UNIV-3.md` names LOW-3 or NOTE-2, so they stay. Closed elsewhere: MED-1, the projection dot-read class (`UNIV-3`, the 9c queue); the envelope layer and the registration doors (`UNIV-2`); MED-2 was corrected before merge. History: `work-packages-rounds.md`.

## RW-118: Complete row `SETL-1`: residuals still owned

Excerpt of base line 65:

~~~excerpt lines=65-65
Residuals owned (docs/handoffs/SETL-1.md): the observation/evaluation door (evaluateSettlement dot-reads; un-doored SettlementObservationSchema — next grant); cold-lazy poisoning contained-not-cured (fail-closed availability; D2/ADR-020); THREE measured zod facts for the §2 class table (the cold-only durable waiver; the cold-discriminatedUnion `status` trigger; durable poisoning); one corpus value for single-group case drift; r1 N3 left alone with an argued call; the reviewer's own recorded method gap (grammar-corpus sweeps for future door reviews).
~~~

New:

~~~new
- `SETL-1`: cold-lazy poisoning contained-not-cured (fail-closed availability; D2/ADR-020); the reviewer's method gap: grammar-corpus sweeps for future door reviews.
~~~

Keep (in both texts):

~~~keep
cold-lazy poisoning contained-not-cured
grammar-corpus sweeps for future door reviews
~~~

Not carried:

~~~drop lines=65-65
the observation/evaluation door (evaluateSettlement dot-reads; un-doored SettlementObservationSchema — next grant) => closed-by `SETL-2`
one corpus value for single-group case drift => closed-by `SETL-2` (it added six)
r1 N3 left alone with an argued call => history: left alone with an argued call
THREE measured zod facts for the §2 class table => history: recorded before the cut by the contract-owner round `5efbb87` (2026-09-07): `docs/contracts/schema-boundary.md` §2, line 80, the row "Waiver reach + durability; the `status` trigger *(measured by `SETL-1` …)*", holds all three
~~~

**Facts.** Kept: the contained poisoning and the method gap. r6 drops the three zod facts: `5efbb87` put all three in schema-boundary.md §2 before the cut (verifier finding I3). The observation/evaluation door closed with `SETL-2`; the case-drift corpus value too (`SETL-2` added six). r1 N3 was left alone with an argued call. History: `work-packages-rounds.md`.

## RW-119: Complete row `CLOB-1`: residuals still owned

Excerpt of base line 66:

~~~excerpt lines=66-66
Review corrections on the record: own `__proto__` is JSON-REACHABLE (fail-closed refusal, relabelled); 4 of 5 base-passing boundary tests do not discriminate base from tip (the D2 compensation is REAL by the reviewer's cold-module matrix; the warm test evidence → follow-up hardening). Residual owners in docs/handoffs/CLOB-1.md.
~~~

New:

~~~new
- `CLOB-1`: 4 of 5 base-passing boundary tests do not discriminate base from tip; the warm test evidence goes to follow-up hardening. The D2 compensation is real by the reviewer's cold-module matrix. Other owners: `docs/handoffs/CLOB-1.md`.
~~~

Keep (in both texts):

~~~keep
do not discriminate base from tip
follow-up hardening
D2 compensation is REAL by the reviewer's cold-module matrix
~~~

Not carried:

~~~drop lines=66-66
own `__proto__` is JSON-REACHABLE (fail-closed refusal, relabelled) => history: a review correction on the record
~~~

**Facts.** Kept: the non-discriminating tests and the hardening they are owed, and that the D2 compensation is real by the reviewer's cold-module matrix (r5). The `Array.prototype` arrays and the shared-materializer question are under Schema boundary. History: `work-packages-rounds.md`.

## RW-120: Complete row `UNIV-2`: residuals still owned

Excerpt of base line 67:

~~~excerpt lines=67-67
Residual owners: the `parameters.ts` output-side adoption (r1 MED-1), the `skipChecks` observation defeat (MED-2), the unjudged review facts (`approvedBy`/`metadataVersion`; `bindMarketToSeries` unguarded — LOW), and the registration-door `ingestSeq` re-statement gap (LOW) → the item 9c state-side round; the PERMANENT cold-`discriminatedUnion` cache poisoning (fail-closed, base-parity, SETL-1's class) → ADR-020 governance.
~~~

New:

~~~new
- `UNIV-2`: the PERMANENT cold-`discriminatedUnion` cache poisoning (fail-closed, base-parity, SETL-1's class), for ADR-020 governance.
~~~

Keep (in both texts):

~~~keep
cold-discriminatedUnion cache poisoning
ADR-020 governance
~~~

Not carried:

~~~drop lines=67-67
the `parameters.ts` output-side adoption (r1 MED-1) => closed-by `UNIV-3` (the item 9c state-side round)
the `skipChecks` observation defeat (MED-2) => closed-by `UNIV-3` (the item 9c state-side round)
the unjudged review facts (`approvedBy`/`metadataVersion`; `bindMarketToSeries` unguarded — LOW) => closed-by `UNIV-3` (the item 9c state-side round)
the registration-door `ingestSeq` re-statement gap (LOW) => closed-by `UNIV-3` (the item 9c state-side round)
~~~

**Facts.** Kept: the permanent cache poisoning for ADR-020 governance. The other four residuals went to the item 9c state-side round, `UNIV-3`, which closed that queue. History: `work-packages-rounds.md`.

## RW-121: Complete row `WP-060-FU1`: residuals still owned

Excerpt of base line 70:

~~~excerpt lines=70-70
Residuals (owned, in `docs/handoffs/WP-060-FU1.md`): an inherited `venue` fail-closes an array-payload envelope via zod's refinement; `redis/transport.ts` still keys the epoch cursor on the caller's object (no live route); the door's per-byte copy cost; the new fail-closed refusals (depth 16+, non-plain payload members); `encodeWireJson` is guarded by a differential corpus.
~~~

New:

~~~new
- `WP-060-FU1`: `redis/transport.ts` still keys the epoch cursor on the caller's object (no live route). An inherited `venue` fail-closes an array-payload envelope via zod's refinement. Also: the door's per-byte copy cost; the new fail-closed refusals (depth 16+, non-plain payload members). `encodeWireJson` is guarded by a differential corpus.
~~~

Keep (in both texts):

~~~keep
an inherited venue fail-closes an array-payload envelope via zod's refinement
per-byte copy cost
depth 16+, non-plain payload members
encodeWireJson is guarded by a differential corpus
keys the epoch cursor on the caller's object (no live route)
~~~

Not carried:

~~~drop lines=70-70
Residuals (owned, in `docs/handoffs/WP-060-FU1.md`) => brief: Work packages (the WP-060-FU1 row links the handoff)
~~~

**Facts.** Kept: all five owned residuals, including the `redis/transport.ts` epoch cursor keyed on the caller's object (no live route), which r3 had left to the Schema boundary summary. The implementer and reviewer list is history in `work-packages-rounds.md`.

## RW-122: Complete row `SER-1`: residuals still owned

Excerpt of base line 72:

~~~excerpt lines=72-72
Residuals (owned, `docs/handoffs/SER-1.md`): Proxy undetected by design; structural classification forgeable only through a Proxy trap (precondition pinned); the ceiling is a stack-budget argument; explicit-`undefined` oracle text preserved; the reviewer's sandbox could not run the root suite (EPERM) — orchestrator-reproduced.
~~~

New:

~~~new
- `SER-1`: Proxy undetected by design; structural classification forgeable only through a Proxy trap (precondition pinned); the ceiling is a stack-budget argument; explicit-`undefined` oracle text preserved.
~~~

Keep (in both texts):

~~~keep
Proxy undetected by design
forgeable only through a Proxy trap
the ceiling is a stack-budget argument
explicit-undefined oracle text preserved
~~~

Not carried:

~~~drop lines=72-72
the reviewer's sandbox could not run the root suite (EPERM) — orchestrator-reproduced => history: a process fact, orchestrator-reproduced
Residuals (owned, `docs/handoffs/SER-1.md`) => brief: Work packages (the SER-1 row links the handoff)
~~~

**Facts.** Kept: the four design residuals. Not carried: the reviewer's sandbox EPERM note (a process fact, orchestrator-reproduced). History: `work-packages-rounds.md`.

## RW-123: Complete row `SER-2`: residuals still owned

Excerpt of base line 73:

~~~excerpt lines=73-73
Residuals (owned, `docs/handoffs/SER-2.md`): the `details.record` format change for malformed segments is disclosed and nothing pinned the old shape; `excludedSegments[].gatewayEpoch` stays unbounded (pre-existing, size only, never a refusal); `parseDatasetManifest`'s cast is the one hole in the compiler-checked claim; `storage-wal`'s `SegmentIssue.details` still holds the raw discriminator (safe today — a fatally-issued segment gets no manifest — with the trigger named); the shape vocabulary is imitable by the text it describes.
~~~

New:

~~~new
- `SER-2` (`docs/handoffs/SER-2.md`): the `details.record` format change for malformed segments is disclosed, and nothing pinned the old shape. `excludedSegments[].gatewayEpoch` stays unbounded (pre-existing, size only, never a refusal). Owner: a later `storage-parquet` round. `parseDatasetManifest`'s cast (`dataset-manifest.ts:457`) is the one hole in the compiler-checked claim. Owner: `packages/storage-parquet`. `storage-wal`'s `SegmentIssue.details` still holds the raw discriminator. It is safe today: a fatally-issued segment gets no manifest. The trigger is any consumer that routes `SegmentIssue.details` or `WalError.details` through `encodePlainJson`. Owner: whoever adds it. The shape vocabulary is imitable by the text it describes.
~~~

Keep (in both texts):

~~~keep
the details.record format change
nothing pinned the old shape
excludedSegments[].gatewayEpoch stays unbounded
pre-existing, size only, never a refusal
parseDatasetManifest's cast
the one hole in the compiler-checked claim
SegmentIssue.details still holds the raw discriminator
a fatally-issued segment gets no manifest
the shape vocabulary is imitable by the text it describes
~~~

**Facts.** Kept: all five residuals of the row. The row names its owner as the handoff; the brief adds, from `docs/handoffs/SER-2.md` residuals 2-4, each owner, the cast's site (`dataset-manifest.ts:444-457`, the return at :457) and the named trigger. The row says only "with the trigger named". Not carried: the H1/M1 review, the evidence and the gates. The Codex process deviation is ratified under `H7`. History: `work-packages-rounds.md`.

## RW-124: Complete row `SER-3`: residuals still owned

Excerpt of base line 74:

~~~excerpt lines=74-74
Seven residuals owned (`docs/handoffs/SER-3.md`), all accepted with reasons: `runtime.ts` `jsonBody`; `TraderHealthSource` (a foreign source skipping the door yields 500 where base answered 200 — closure is a brand in `observability`); the audit sink's direct-caller path; `enqueue` (verdict-equivalent under both transports); the RTDS hole divergence; the iterator-vs-index VALUES divergence at `control-plane.ts:440` (ordinary species, encoder satisfied, diagnostics not decisions — **N4** owes one sentence at the site, carried by the docs round); and `encodePlainJson`'s `Proxy` residual.
~~~

New:

~~~new
- `SER-3` (`docs/handoffs/SER-3.md`) has seven residuals, all accepted with reasons. (1) `runtime.ts` `jsonBody`. (2) `TraderHealthSource`: a foreign source skipping the door yields 500 where base answered 200. The closure is a brand in `observability`: brand `TraderHealthReportInput` (`metric-shapes.ts:196`), outside SER-3's paths. (3) The audit sink's direct-caller path. (4) `enqueue`, verdict-equivalent under both transports. (5) The RTDS hole divergence. (6) The iterator-vs-index VALUES divergence at `control-plane.ts:440`: ordinary species, encoder satisfied, diagnostics not decisions. SER-3's N4, the one sentence owed at that site by the docs round, was added by `GOV-2C`. (7) `encodePlainJson`'s `Proxy` residual.
~~~

Keep (in both texts):

~~~keep
runtime.ts jsonBody
a foreign source skipping the door yields 500 where base answered 200
closure is a brand in observability
the audit sink's direct-caller path
verdict-equivalent under both transports
the RTDS hole divergence
control-plane.ts:440
ordinary species, encoder satisfied, diagnostics not decisions
encodePlainJson's Proxy residual
~~~

**Facts.** Kept: all seven residuals, one short sentence each (r4 splits the r3 clause chain). N4 is closed: the row says it "owes one sentence at the site, carried by the docs round", and `GOV-2C`'s row records "N4's one sentence at `control-plane.ts:440`" as shipped (the comment is in `apps/control-api/src/control-plane.ts` at `f43efe6`). The brief writes "SER-3's N4" to tell it from `GOV-2B`'s `test:replay` N4. From `docs/handoffs/SER-3.md` residual 2 and its follow-up, the brief adds the brand's target, `TraderHealthReportInput`, at `packages/observability/src/control/metric-shapes.ts:196`. Not carried: the M2/N1-N3 review chain, the eight container shapes, and the gates. The Codex process deviation is ratified under `H7`. History: `work-packages-rounds.md`.

## RW-125: Complete row `TRDR-2`: residuals still owned

Excerpt of base line 76:

~~~excerpt lines=76-76
Residuals (owned, `docs/handoffs/TRDR-2.md`): B9/BOOT-1; **TRDR2-R8** a parenthesized type alias still evades the census, `eslint` AND `tsc` (undisclosed until now, one-line fix, owner = next round touching `test/unit/trader/**`); two census holes disclosed and pinned; `main.ts:292`'s cast; DB domain constraints invisible to the compiler; **three** of six integration suites now need Docker so GATE-1's N5 label (which says two) is stale.
~~~

New:

~~~new
- `TRDR-2`: DB domain constraints invisible to the compiler; two census holes disclosed and pinned.
~~~

Keep (in both texts):

~~~keep
DB domain constraints invisible to the compiler
two census holes disclosed and pinned
~~~

Not carried:

~~~drop lines=76-76
`main.ts:292`'s cast => closed-by `BOOT-1` (it deleted the venue as unknown as cast: docs/handoffs/BOOT-1.md line 65; apps/trader/src/main.ts lines 541-545 at f43efe6 hand the venue over uncast)
**three** of six integration suites now need Docker so GATE-1's N5 label (which says two) is stale => closed-by `CI-1` (N5)
**TRDR2-R8** a parenthesized type alias still evades the census => closed-by `BOOT-1` (docs/handoffs/BOOT-1.md line 66: TRDR2-R8 is closed; test/unit/trader/query-boundary-cast-scan.test.ts strips the parentheses at f43efe6)
~~~

**Facts.** Kept: the two residuals no other row carries and no later row closes. r6 drops the `main.ts:292` cast: `BOOT-1` deleted it. `TRDR2-R8` closed with `BOOT-1` before the cut; r1-r6 queued it as open (RW-36, r7). B9 closed with `BOOT-1`; the N5 label went stale and closed with `CI-1`. History: `work-packages-rounds.md`.

## RW-126: Complete row `GATE-1`: residuals still owned

Excerpt of base line 78:

~~~excerpt lines=78-78
Residuals (owned, `docs/handoffs/GATE-1.md`): **GATE1-M1** `test:replay`'s hand-maintained file list can silently shrink back to the N4 defect (proven; the complete fix needs a grant over `test/unit/**`); the vitest `projects` route existed and was declined for root-count stability, not impossible; js-yaml 4.3.2 first executes on the merge CI run; the `node` job remains one fail-fast chain so B7's STRUCTURAL cause survives its instance; and both gate homes are editable by future packages with neither self-checking.
~~~

New:

~~~new
- `GATE-1`: both gate homes are editable by future packages. No test pins which suites `test/vitest.config.ts` includes. `ci.yml` is partly pinned since `CI-2`: `test/unit/tooling/ci-step-split.test.ts` fails when a gate that runs a root script is deleted or loses its `if:` condition.
~~~

Keep (in both texts):

~~~keep
both gate homes are editable by future packages
~~~

Not carried:

~~~drop lines=78-78
the `node` job remains one fail-fast chain so B7's STRUCTURAL cause survives its instance => closed-by `CI-1` (GATE1-R4: every node gate is if: ${{ !cancelled() && steps.install.outcome == 'success' }})
the vitest `projects` route existed and was declined for root-count stability, not impossible => history: a recorded choice, not an obligation
js-yaml 4.3.2 first executes on the merge CI run => closed-by `CI-1` (GATE1-R3: H2's first real CI run, PR #1 run 36282501033, installed from the lockfile and passed every gate)
~~~

**Facts.** Kept: the editable gate homes, narrowed to what is still unguarded. r6 measured the narrowing: deleting the Lint gate from `ci.yml` fails 3 of 32 tests in `test/unit/tooling/ci-step-split.test.ts` (the `CI-2` pin), so "a deleted CI step fails no test" no longer holds for a root-script gate. The fail-fast chain is GATE1-R4, closed by `CI-1`. `GATE1-M1` is a residual row. `GATE1-R3` closed with `CI-1` before the cut (RW-74, r8); the declined vitest `projects` route is a recorded choice, not an obligation. History: `work-packages-rounds.md`.

## RW-127: Completion record `WP-150`: obligations still owed

Excerpt of the record item at base lines 892-901:

~~~excerpt lines=892-901
- **Carried follow-ups** (owners): root devDependency + bare-specifier import
  for the golden test (orchestrator, at a future bounded root-wiring grant —
  the current relative import tests the public entry, not package-specifier
  resolution); WP-120 composition root MUST stamp gap-closing REST snapshots
  via the fetcher context (pinned by test name); WP-160 notes (division
  options; absent-vs-zero on empty sides); WP-210 reuses serializeBook
  (versioned polymarket-bot/order-book/v1) rather than inventing a second
  canonical form; WP-070 follow_up 6 (best_bid/best_ask carriage) open,
  unblocked; the renamed obligation test's long name is load-bearing
  documentation — future renames must preserve the recorded obligation.
~~~

New:

~~~new
- `WP-150`: owed by the orchestrator, at a future bounded root-wiring grant: a root devDependency + bare-specifier import for the golden test (the current relative import tests the public entry, not package-specifier resolution). A WP-120 composition root MUST stamp gap-closing REST snapshots via the fetcher context (pinned by test name). WP-070 follow_up 6 (best_bid/best_ask carriage) is open and unblocked. The renamed obligation test's long name is load-bearing: future renames must preserve the recorded obligation.
~~~

Keep (in both texts):

~~~keep
root devDependency + bare-specifier import for the golden test
MUST stamp gap-closing REST snapshots via the fetcher context
WP-070 follow_up 6 (best_bid/best_ask carriage)
future renames must preserve the recorded obligation
tests the public entry, not package-specifier resolution
~~~

**Facts.** Kept: the bare-specifier golden import (orchestrator) and why it is owed (the relative import does not test package-specifier resolution; r5), the gap-closing snapshot stamping obligation, WP-070 follow_up 6, and the load-bearing test name. The WP-160 notes and WP-210's reuse of `serializeBook` went to those packages, both Complete. New in r4 (J-01): r3 declared this record history. History: `completion-records-wave-1.md`.

## RW-128: Completion record `GOV-1C`: obligations still owed

Excerpt of the record item at base lines 937-945:

~~~excerpt lines=937-945
- **Carried follow-ups** (owners): bounded tooling package swapping the
  machine `rule` field to F14 together with the pinned suite assertions,
  and implementing F15/F16 (future bounded grant, tool + test/unit/tooling
  in one change); WP-220 brings tests inside the purity scan; the §6.1
  item-1 callee-resolution tripwire binds future reviewers; next full
  venue verification round adds the resolution page + market-by-id to the
  source index; first market-by-id consumer treats U-11 as opaque; WP-300
  keeps the U-10 CANCELLED refusal; apps/trader builds per ADR-018;
  WP-210/WP-230 parse causationId per domain.md §11 only.
~~~

New:

~~~new
- `GOV-1C`: the §6.1 item-1 callee-resolution tripwire binds future reviewers. The first market-by-id consumer treats U-11 as opaque. `WP-300` must keep the U-10 CANCELLED refusal.
~~~

Keep (in both texts):

~~~keep
callee-resolution tripwire binds future reviewers
first market-by-id consumer treats U-11 as opaque
the U-10 CANCELLED refusal
~~~

Not carried:

~~~drop lines=937-945
bounded tooling package swapping the => brief: Residuals recorded in Complete package rows — GOV-1C (the tool+suite swap); F15/F16 are `§5 item 6`'s
venue verification round adds the resolution page + market-by-id to the => closed-by `VENUE-2` (verified-2026-09-16.md indexes both)
apps/trader builds per ADR-018 => closed-by `WP-230`, `BUNDLE-1` (the trader bundle; BUNDLE1-LOWS (1) holds the open ADR-018 note)
~~~

**Facts.** Kept: the §6.1 item-1 tripwire, U-11 opaque for a market-by-id consumer, and WP-300's U-10 CANCELLED refusal (the verifiers named the last two; r3 declared this record history). The record's "WP-300 keeps" is an obligation on a package not yet built, so the brief writes "must keep" (r5). The tool swap is the brief's GOV-1C bullet, and F15/F16 are `§5 item 6`. `VENUE-2` indexed the resolution page and market-by-id. WP-220's purity-scan item and the causationId parsing rule went to Complete packages. History: `completion-records-wave-1.md`.

## RW-129: Completion record `WP-140`: obligations still owed

Excerpts of the record items at base lines 1019-1021 and 1022-1030:

~~~excerpt lines=1019-1021
- Residual (LOW, disclosed): the guarantee-wording denylist is a
  four-pattern heuristic narrowed by positive pins — novel promissory
  phrasing needs human review at doc-change time.
~~~

~~~excerpt lines=1022-1030
- **Follow-ups carried**: wire the exporter into the processes (apps
  owner — loopback listeners rendering `renderRecorderMetrics`); trim
  the compose README's duplicated restart procedure; observability
  manifest wiring (barrel re-export, vitest devDep hygiene); the REAL
  soak after deployment (then size admission bounds, profile compactor
  memory, benchmark §9.1 p99 from its evidence); the 24h threshold and
  window-composition rule remain orchestrator-ratifiable if a different
  bar is intended; `data.raw_segments` → WP-210 (operator decision
  2026-09-02).
~~~

New:

~~~new
- `WP-140`: a LOW residual. The guarantee-wording denylist is a four-pattern heuristic narrowed by positive pins, so novel promissory phrasing needs human review at doc-change time. Follow-ups: wire the exporter into the processes (apps owner: loopback listeners rendering `renderRecorderMetrics`); trim the compose README's duplicated restart procedure; observability manifest wiring (barrel re-export, vitest devDep hygiene). The REAL soak comes after deployment (H4); from its evidence: size admission bounds, profile compactor memory, benchmark §9.1 p99. The 24h threshold and window-composition rule remain orchestrator-ratifiable if a different bar is intended.
~~~

Keep (in both texts):

~~~keep
four-pattern heuristic
novel promissory phrasing needs human review at doc-change time
wire the exporter into the processes
trim the compose README's duplicated restart procedure
observability manifest wiring (barrel re-export, vitest devDep hygiene)
size admission bounds, profile compactor memory, benchmark §9.1 p99
24h threshold and window-composition rule remain orchestrator-ratifiable
narrowed by positive pins
if a different bar is intended
after deployment
~~~

Not carried:

~~~drop lines=1022-1030
`data.raw_segments` → WP-210 (operator decision => brief: Residuals recorded in Complete package rows — WP-210 (the segmentFileSha256 + compacted-object registration, owned by the migration owner)
~~~

**Facts.** Kept: the LOW residual (novel promissory wording needs human review), with the pins that narrow the heuristic, and every carried follow-up, including the post-soak sizing, profiling and §9.1 p99 work, the soak's timing (after deployment) and the ratification's condition (r5 restores the last three). `data.raw_segments` passed to WP-210, whose row routes the registration to the migration owner. New in r4 (J-01). History: `completion-records-wave-1.md`.

## RW-130: Completion record `WP-120`: obligations still owed

Excerpt of the record item at base lines 1084-1092:

~~~excerpt lines=1084-1092
- **Follow-ups carried**: WP-140 recorder runbook (bidirectional exit
  contract; deadline and `[disposal]` operator signals; liveness alarming;
  queue metrics charting; admission-bound sizing from soak data);
  `GATEWAY_RETENTION_EVENTS` fail-closed parsing; adapter-level
  `socket.close()` guards (packages/polymarket-public, packages/
  coinbase-adapter — outside WP-120 paths); `runGatewaySequence` reuse for
  any future composition root; the `causationId` format's contract
  registration; `docker compose config` validation of the compose fragment
  (Docker unavailable in this environment — never claimed run).
~~~

New:

~~~new
- `WP-120`: the WP-140 recorder runbook still owes the bidirectional exit contract, the deadline and `[disposal]` operator signals, liveness alarming, queue metrics charting, and admission-bound sizing from soak data. Also owed: `GATEWAY_RETENTION_EVENTS` fail-closed parsing; adapter-level `socket.close()` guards (`packages/polymarket-public`, `packages/coinbase-adapter`, outside WP-120 paths); `runGatewaySequence` reuse for any future composition root. `docker compose config` validation of the compose fragment has never run (Docker unavailable in that environment).
~~~

Keep (in both texts):

~~~keep
bidirectional exit contract
admission-bound sizing from soak data
GATEWAY_RETENTION_EVENTS fail-closed parsing
adapter-level socket.close() guards
runGatewaySequence reuse for any future composition root
docker compose config validation of the compose fragment
outside WP-120 paths
Docker unavailable
~~~

Not carried:

~~~drop lines=1084-1092
the `causationId` format's contract => closed-by `GOV-1C` (domain.md §11, the causationId contract)
~~~

**Facts.** Kept: the recorder-runbook items, fail-closed `GATEWAY_RETENTION_EVENTS` parsing, the adapter `socket.close()` guards (outside WP-120 paths; r5), `runGatewaySequence` reuse, and the never-run compose validation with its reason (r5). `GOV-1C` registered the `causationId` contract. New in r4 (J-01). History: `completion-records-wave-1.md`.

## RW-131: Completion record `WP-130`: obligations still owed

Excerpt of the record item at base lines 1131-1140:

~~~excerpt lines=1131-1140
- **Follow-ups carried**: WAL contract owner must define cross-epoch
  chronology or rule mixed-epoch directories out (compactor refuses
  until then); a dataset-manifest ADR pinning the two digest roles,
  `nullable` = repetition semantics, and the strict-JSON profile
  (UTF-8-only, RFC 8259 literals, unique keys); WP-140 memory/deletion
  profiling; replace the operator incident file with the
  `data_quality_incidents` query; persist `CompactionResult.manifest`
  to `data.*`; repo-wide runtime-build convention (esbuild precedent);
  periodic dependency review + ADR before any upgrade that changes
  archived bytes.
~~~

New:

~~~new
- `WP-130`: WP-140 memory/deletion profiling is owed, in the soak. Also owed: replace the operator incident file with the `data_quality_incidents` query; persist `CompactionResult.manifest` to `data.*`; periodic dependency review + ADR before any upgrade that changes archived bytes.
~~~

Keep (in both texts):

~~~keep
WP-140 memory/deletion profiling
replace the operator incident file with the data_quality_incidents query
persist CompactionResult.manifest to data.*
periodic dependency review + ADR before any upgrade that changes archived bytes
~~~

Not carried:

~~~drop lines=1131-1140
WAL contract owner must define cross-epoch => closed-by `GOV-1C` (wal-format §12.1: epochs are identity, single-epoch compaction ratified)
a dataset-manifest ADR pinning the two digest roles => closed-by `GOV-1C` (ADR-017)
repo-wide runtime-build convention (esbuild precedent) => closed-by `GOV-1C` (ADR-018)
~~~

**Facts.** Kept: the memory/deletion profiling, the incident query, persisting the compaction manifest, and the dependency-review rule. `GOV-1C` settled the cross-epoch chronology, the dataset-manifest ADR and the runtime-build convention. New in r4 (J-01). History: `completion-records-wave-1.md`.

## RW-132: Completion record `WP-110`: obligations still owed

Excerpt of the record item at base lines 1179-1187:

~~~excerpt lines=1179-1187
- **Follow-ups carried**: composition root (WP-120/WP-160/WP-170) must
  narrow `SettlementActivationVerdict` into the discriminated view (the
  wiring site is where assignability becomes a type error);
  `catalog.settlement_specs.payoff_model NOT NULL` divergence owned by
  the migration owner; venue-register rows for WP-110's non-confirmations;
  a `MarketClosed`-equivalent venue signal remains unconfirmed; seed
  loader and a human-reviewed spec for `btc-15m-updown` before any
  model-dependent use; matcher fixture U+200B escapes must not be
  reformatted to literals.
~~~

New:

~~~new
- `WP-110`: a composition root must narrow `SettlementActivationVerdict` into the discriminated view at its wiring site, where assignability becomes a type error. A `MarketClosed`-equivalent venue signal remains unconfirmed. A seed loader and a human-reviewed spec for `btc-15m-updown` come before any model-dependent use. Matcher fixture U+200B escapes must not be reformatted to literals.
~~~

Keep (in both texts):

~~~keep
narrow SettlementActivationVerdict into the discriminated view
MarketClosed-equivalent venue signal remains unconfirmed
human-reviewed spec for btc-15m-updown
U+200B escapes must not be reformatted to literals
where assignability becomes a type error
~~~

Not carried:

~~~drop lines=1179-1187
venue-register rows for WP-110's non-confirmations => closed-by `GOV-1C` (register rows U-10, U-11 and U-12)
`catalog.settlement_specs.payoff_model NOT NULL` divergence owned by => closed-by `WP-210` (migration 0009 dropped NOT NULL and added the ADR-009 compatibility CHECK; the immutability trigger is unchanged)
~~~

**Facts.** Kept: the verdict narrowing and why it belongs at the wiring site (r5), the unconfirmed `MarketClosed`-equivalent signal (`VENUE-2`'s D-30 says the push-signal gap stands), the human-reviewed spec before model use, and the U+200B fixture rule (the verifiers named it). Closed: the `payoff_model NOT NULL` divergence. The base `WP-210` row (line 45) records migration 0009 with both ADR-009 §2 halves, and `db/migrations/0009_catalog_payoff_model_optional.up.sql` drops NOT NULL and adds the CHECK (r5; r4 carried it as owed). This is a fact about the repository, not about any deployed database. `GOV-1C` added the register rows. History: `completion-records-wave-1.md`.

## RW-133: Completion record `WP-060`: the unmeasured p99 target

Excerpt of the record item at base lines 1794-1803:

~~~excerpt lines=1794-1803
- Binding obligations recorded for consumers (WP-060 handoff follow_up):
  WP-120 must dedup on `(gatewayEpoch, ingestSeq)` (NOT `eventId`), keep one
  stable durable consumer id per role, publish each epoch from one process
  sequentially, route `resync-required` to the halt path with a
  `DataQualityIncidentOpened` + authoritative snapshot, treat
  `EVENT_BUS_PUBLISH_QUEUE_FULL`/`EventBusUnavailableError` as
  halt-plus-incident signals, and size `maxQueuedPublishes`/retention
  deliberately (retention sizing belongs in the operational runbook). WP-140
  exports queue depth/max/oldest-age pairs from process memory. The 5 ms p99
  gateway-to-trader target remains an unmeasured target (ADR-003 §5).
~~~

New:

~~~new
- `WP-060`: the 5 ms p99 gateway-to-trader target remains an unmeasured target (ADR-003 §5).
~~~

Keep (in both texts):

~~~keep
5 ms p99 gateway-to-trader target remains an unmeasured target
~~~

Not carried:

~~~drop lines=1794-1803
exports queue depth/max/oldest-age pairs from process memory => history: `WP-140` shipped the exporter (its row reads implementation complete)
~~~

**Facts.** Kept: the unmeasured 5 ms p99 target (ADR-003 §5). The consumer obligations were `WP-120`'s, and WP-140 shipped the queue exporter. New in r4 (J-01). History: `completion-records-wave-0.md`.

## RW-134: Completion record `WP-040`: the attempt-row obligation

Excerpt of the record item at base lines 1913-1916:

~~~excerpt lines=1913-1916
- Obligations recorded for consumers: F13/F16-F20 (WP-200: carry the market on
  ledger postings; resolve wallet-operation market before insert; net positions
  from ledger_entries.account_ref; attempt row before SIGNED order — WP-320
  same); R9-R21 risk register accurate and owned.
~~~

New:

~~~new
- `WP-040`: `WP-320` must write the attempt row before a SIGNED order (WP-040's consumer obligations F13/F16-F20).
~~~

Keep (in both texts):

~~~keep
attempt row before
SIGNED order
WP-320
~~~

Not carried:

~~~drop lines=1913-1916
R9-R21 risk register accurate and owned => history: the register's state at the merge
~~~

**Facts.** Kept: the attempt row before a SIGNED order, which binds `WP-320`. `WP-320` is a phase-3 package not yet built, and the record states a consumer obligation, so the brief writes "must write" (r5). The other F13/F16-F20 obligations were `WP-200`'s. New in r4 (J-01). History: `completion-records-wave-0.md`.

## RW-135: Completion record `WP-015`: the checker's documented limits

Excerpt of the record item at base lines 1949-1955:

~~~excerpt lines=1949-1955
- **Honest terminal position** (WP-015 handoff, re-affirmed at merge): a
  name-enumeration static scanner is provably non-total. After ten rounds no
  ORDINARY-CODE (non-reflective, single-file, statically-named, plausibly-
  accidental) silent synchronous forbidden-load route is known; the remaining
  residuals — reflective acquisition (`Reflect.get`), runtime-computed member
  names, and cross-file capability injection — are inherent to the architecture
  and documented, not one-more-spelling gaps.
~~~

New:

~~~new
- `WP-015`: the dependency checker is a name-enumeration static scanner, so it is provably non-total. Its remaining residuals are inherent to the architecture and documented: reflective acquisition (`Reflect.get`), runtime-computed member names, and cross-file capability injection.
~~~

Keep (in both texts):

~~~keep
provably non-total
reflective acquisition (Reflect.get), runtime-computed member names, and cross-file capability injection
inherent to the architecture
~~~

Not carried:

~~~drop lines=1949-1955
After ten rounds no => history: the review outcome at the merge (no ordinary-code route was known)
~~~

**Facts.** Kept: the scanner is provably non-total, and its three documented residual classes, which are inherent to the architecture (r5). The ten-round outcome is history. New in r4 (J-01). History: `completion-records-wave-0.md`.

## RW-136: Completion record `WP-050`: unprofiled retention memory

Excerpt of the record item at base lines 1987-1991:

~~~excerpt lines=1987-1991
- **Binding obligations on consumers** (carry into WP-120/WP-130 packets):
  dedup on `(gatewayEpoch, ingestSeq)` is MANDATORY (duplicates are the normal
  fault-boundary outcome by design); the gateway drives `drain()`/`tick()` and
  routes refusals/faults to incidents; retention memory (one segment's records,
  64 MiB default bound) is reasoned-not-profiled — profile in WP-140 soak.
~~~

New:

~~~new
- `WP-050`: WAL retention memory (one segment's records, 64 MiB default bound) is reasoned-not-profiled; profile it in the WP-140 soak.
~~~

Keep (in both texts):

~~~keep
reasoned-not-profiled
64 MiB default bound
~~~

Not carried:

~~~drop lines=1987-1991
the gateway drives `drain()`/`tick()` and => closed-by `WP-120` (the gateway)
~~~

**Facts.** Kept: the retention memory bound is reasoned, not profiled, and belongs in the soak. The dedup and drive obligations were `WP-120`'s and `WP-130`'s. New in r4 (J-01). History: `completion-records-wave-0.md`.

## RW-137: Completion records `WP-030`, `WP-000`: venue items still owed

Excerpts of the record items at base lines 2020-2023, 2032-2035 and 2045-2049:

~~~excerpt lines=2020-2023
- Open items registered for later packages: dependency-check CI owner; venue-fact
  gaps (same-account matching, shared-bucket arbitration, Binance/Coinbase
  framing → WP-080/WP-090, U-6 50/50 mechanics → WP-110, U-7 SDK pin → WP-260,
  C-1/U-1 → WP-070, C-2 → ledger/fees, C-3 → WP-280).
~~~

~~~excerpt lines=2032-2035
- Independent adversarial reviews (fresh Codex session per round): rounds 1–5
  CHANGES REQUIRED, round 6 **ACCEPT** (session `01a03d73-8ad1-7b23-929d-9f93703b67ef`;
  0 blocker/high/medium; residual LOW: `conditionId` 31/32-byte fixture narrowing —
  runtime parsers must NOT inherit it; NOTE: report §17 wording, self-corrected).
~~~

~~~excerpt lines=2045-2049
- Open venue conflicts/unverified items carried to WP-030/later packages:
  C-1/U-1 (price_change zero-removal semantics → WP-070), C-2 (USDC vs pUSD
  denomination → ledger/fee packages), C-3 (MATCHED_NOT_BROADCASTED layering →
  WP-280), U-7 (npm version pin → WP-260), plus fixture-only narrowings that
  runtime adapters must not inherit (SDK `.nullish()` fields, conditionId length).
~~~

New:

~~~new
- `WP-000`, `WP-030`: C-3 (MATCHED_NOT_BROADCASTED layering) goes to `WP-280`, and U-7 (the npm version pin) to `WP-260`. Two venue-fact gaps stay registered: same-account matching and shared-bucket arbitration. Runtime parsers must NOT inherit the fixture-only narrowings (SDK `.nullish()` fields, the 31/32-byte `conditionId`).
~~~

Keep (in both texts):

~~~keep
same-account matching
shared-bucket arbitration
C-3 (MATCHED_NOT_BROADCASTED layering
runtime parsers must NOT inherit
U-7
~~~

Not carried:

~~~drop lines=2020-2023
Open items registered for later packages: dependency-check CI owner => closed-by `WP-015`
~~~

~~~drop lines=2032-2035
round 6 **ACCEPT** (session `01a03d73-8ad1-7b23-929d-9f93703b67ef` => history: the accepting review session
~~~

**Facts.** Kept: C-3 for `WP-280`, U-7 for `WP-260`, the two registered venue-fact gaps, and the rule that runtime parsers do not inherit the fixture-only narrowings. Closed elsewhere: the dependency-check owner (`WP-015`), the Binance and Coinbase framing (`WP-080`, `WP-090`), U-6 (`WP-110`) and C-1/U-1 (`WP-070`, then ADR-013); C-2 is under Pending external evidence. New in r4 (J-01). History: `completion-records-wave-0.md`.

## RW-138: Complete row `WP-160`: residuals still owned

Excerpt of base line 51:

~~~excerpt lines=51-51
Carried: **R1-L1** contract doc overclaims timestamp canonicality (0-3 fractional digits accepted → up to four spellings of one instant, DISTINCT addresses; determinism holds, dedupe misses); **R1-L2** exported `validateFeatureInput` "never throws" unenforced on non-materialized trees (composed entry IS total); **R1-L3 the substantive one** — `selectIndexedValues` members are ordinary literals, measured ADOPTION under pollution, destined for PostgreSQL indexing — close before any consumer indexes values; **R1-N1** node:crypto layer-1 (third built-in instance, governance round); **R1-N2** Array.prototype pollution fails CLOSED; **R1-N3** regex wall-clock scan dodgeable in principle (compensated; same class as WP-180 R9-1).
~~~

New:

~~~new
- `WP-160`: R1-L1, the contract doc overclaims timestamp canonicality: 0-3 fractional digits are accepted, so one instant has up to four spellings and DISTINCT addresses (determinism holds, dedupe misses). R1-L2's wording is corrected: `GOV-2C` scoped exported `validateFeatureInput`'s "never throws" to a materialized tree (comment only, `packages/features/src/inputs.ts:744-765`). The boundary stays: a direct caller must materialize first, and the composed entry is total.
~~~

Keep (in both texts):

~~~keep
overclaims timestamp canonicality
determinism holds, dedupe misses
never throws
composed entry is total
~~~

Not carried:

~~~drop lines=51-51
**R1-L3 the substantive one** => closed-by `WP-160-FU1` (features output-side hardening)
**R1-N1** node:crypto layer-1 => closed-by `GOV-2A` (the §2.2 built-in allowlist)
**R1-N2** Array.prototype pollution fails CLOSED => history: it fails closed; no owner
**R1-N3** regex wall-clock scan dodgeable in principle => brief: Residual queue — `§5 item 6` (it folds in WP-160 R1-N3)
~~~

**Facts.** Kept: R1-L1 (the timestamp canonicality overclaim) and R1-L2's standing boundary: a direct caller of `validateFeatureInput` must materialize first; the composed entry is total. R1-L2's wording defect is closed: `GOV-2C` corrected the comment (base lines 81 and 2922; `packages/features/src/inputs.ts` lines 744-765 say "Corrected 2026-09-15 by `GOV-2C`"), and the brief's closeout list already names "N3 (features)" closed (verifier finding I4, r6). r3 disposed of this row as closed by its own packet, which carried only WP-150's follow-ups; C15 found these two. Closed elsewhere: R1-L3 (`WP-160-FU1`), R1-N1 (`GOV-2A`); R1-N3 is `§5 item 6`. History: `work-packages-waves-0-2.md`.

## RW-139: Complete row `BACKTEST-1`: the run-mode label

Excerpt of base line 80:

~~~excerpt lines=80-80
Residuals (owned, `docs/handoffs/BACKTEST-1.md`, written by the orchestrator at merge since the grant carried no handoff path — N6 class): BT1-R1 a stale README sentence; BT1-R2 run pins are asserted against the core's config, not derived from it; BT1-R3 the driver keeps delivering after a halt where the pump exits — unpinned; BT1-R4 the normalizer states no §4 item 5 pollution battery (the reviewer ran one: sound); the `run_mode=BACKTEST` label names the ROOT while the core it drives is hard-wired PAPER.
~~~

New:

~~~new
- `BACKTEST-1`: the `run_mode=BACKTEST` label names the ROOT, while the core it drives is hard-wired PAPER.
~~~

Keep (in both texts):

~~~keep
run_mode=BACKTEST label names the ROOT
hard-wired PAPER
~~~

Not carried:

~~~drop lines=80-80
BT1-R1 a stale README sentence => brief: Residual queue — the closed list (`BT1-R1..R4`)
BT1-R2 run pins are asserted against the core's config => brief: Residual queue — the closed list (`BT1-R1..R4`)
BT1-R3 the driver keeps delivering after a halt => brief: Residual queue — the closed list (`BT1-R1..R4`)
BT1-R4 the normalizer states no §4 item 5 pollution battery => brief: Residual queue — the closed list (`BT1-R1..R4`)
the instance ends PAUSED after its exit, which the round must report rather than hide => closed-by `BRACKET-1a`
~~~

**Facts.** Kept: the `run_mode=BACKTEST` label names the root while the core is hard-wired PAPER; C15 found it. BT1-R1..R4 are closed, and `BRACKET-1a` closed residual 5. History: `work-packages-rounds.md`.

## RW-140: Complete row `UNIV-4`: residuals still owned

Excerpt of base line 83:

~~~excerpt lines=83-83
Residuals (owned, `docs/handoffs/UNIV-4.md` + the residual queue below): **UNIV4-R1** the polled body is never checked to belong to the configured market (D-30 does not record `conditionId` on the response — a mis-pointed `gammaMarketId` opens THIS market on ANOTHER's readiness, silently; the next venue round must record S-D34's `{id}` semantics and example body, then a mismatch refuses the poll); **UNIV4-R2** the trader's `markLifecycle` is unguarded — a same-instant replayed `MarketOpened`, or an R4 `MarketClosing` landing up to one interval after the WebSocket's `MarketResolved`, regresses RESOLVED to OPEN/CLOSING → ACTIVE/CLOSE_ONLY instead of HALTED (the universe fold is correct; trader owner: rank-guard it); **UNIV4-R3** the strategy receives `onMarketClosing` with `secondsRemaining ≈ 0` (its cutoffs read configuration); **UNIV4-R4** a hold-back caused by a failed CONFIRMATION write with a healthy publisher is released only by the next epoch (loud: two PAGEs); **UNIV4-R5** poll latency ≤ one interval (a market closed between polls is seen late; closed-and-reopened within an interval unseen); the venue's `endDate` deliberately NOT used (no documented semantics); an existing config with `polymarket` markets and no `lifecycle` block reproduces B10 — now a NOTIFY incident at start; the operator runbook for ledger repair; `test/fixtures/venue/markets/**` stays empty; `publisher.ts:461`'s "remains in the WAL" wording is false for derived events (owner's wording; the feed's incident states the truth).
~~~

New:

~~~new
- `UNIV-4`: an existing config with `polymarket` markets and no `lifecycle` block reproduces B10; it is now a NOTIFY incident at start. Owed: the operator runbook for ledger repair. `test/fixtures/venue/markets/**` stays empty. UNIV4-R1 to R5 are in the residual queue.
~~~

Keep (in both texts):

~~~keep
no lifecycle block reproduces B10
now a NOTIFY incident at start
the operator runbook for ledger repair
test/fixtures/venue/markets/** stays empty
~~~

Not carried:

~~~drop lines=83-83
**UNIV4-R3** the strategy receives `onMarketClosing` => brief: Residual queue — `UNIV4-R2` (its row names UNIV4-R3)
**UNIV4-R4** a hold-back caused by a failed CONFIRMATION write => brief: Residual queue — `UNIV4-R4/R5`
**UNIV4-R5** poll latency ≤ one interval => brief: Residual queue — `UNIV4-R4/R5`
the venue's `endDate` deliberately NOT used => brief: Residual queue — `UNIV4-R4/R5`
`publisher.ts:461`'s "remains in the WAL" wording is false for derived events => brief: Residual queue — `UNIV4-R4/R5`
~~~

**Facts.** Kept: the B10-reproducing config (now a NOTIFY incident), the owed ledger-repair runbook, and the empty venue-markets fixture directory; C15 found them. UNIV4-R1 to R5 are the brief's residual rows. History: `work-packages-rounds.md`.

## RW-141: Residual clauses not carried, for rows whose disposition carries nothing

Drop lines for Complete rows and record items that carry no entry of their own. Each names where the clause went.

Not carried:

~~~drop lines=35-35
ADR-016 UUID boundary rule for future external input => closed-by `GOV-1C` (its scope item 1)
GOV-1B follow-ups 2-6 (ADR-014 comment pointers => closed-by `GOV-1C` (its scope items 2-6)
~~~

~~~drop lines=44-44
the deep-freeze memoisation set is added to BEFORE the freeze succeeds => closed-by `WP-200-FU1` (the memoisation LOW)
owner: the next bounded grant touching `packages/{ledger,pnl}/src/immutable.ts` => closed-by `WP-200-FU1`
halt enforcement is an INTEGRATION obligation => closed-by `WP-230` (it reads both ledger sections)
the composition-root convention is owed by whoever builds it => closed-by `WP-230`
~~~

~~~drop lines=50-50
WP-200's C-2 conformance ratification is DEFERRED => closed-by `GOV-2A` (C-2 ratified against 7e75f9a)
~~~

~~~drop lines=71-71
every functional `.push(` in `packages/ledger/src` (35 sites) => history: the work this package did
~~~

~~~drop lines=79-79
a `PAUSED` instance with a RUNNING run passes => brief: Residual queue — `BOOT1 unchecked shared facts`
no registration CLI — two-step operator registration => closed-by `REGISTER-1`
the R10 read path would turn `RUN_NOT_RESUMABLE` into a resume => brief: Closeout blockers — `B9` (resume, R10, is Wave 3's)
the `createMigratedContext.close()` pool leak => brief: Residual queue — `BOOT1 pool leak`
R6/R7/R11 (out of grant, in the residual queue) => brief: Residual queue — `BOOT1-R6`, `BOOT1-R11`; `BOOT1-R7` is closed
~~~

~~~drop lines=81-81
header line 5 carries two strikes and two dated notes => history: moot, LOGS-1 replaced the header
~~~

~~~drop lines=84-84
**TRDR3-R4** the operations dashboard lacks the `current` stat => brief: Residual queue — `TRDR3-R4/R5/R7`
**TRDR3-R5** the 9465 port collision => brief: Residual queue — `TRDR3-R4/R5/R7`
**TRDR3-R7** a door comment claims a 4096-instance bound => brief: Residual queue — `TRDR3-R4/R5/R7`
**TRDR3-R8/R9** WP-240 L-9 => brief: Residual queue — `N8` (L-9 is load-bearing, TRDR3-R8/R9)
~~~

~~~drop lines=228-290
the protective reduce gets an order track, so an instance survives its own exit) => history: the package's own scope title
~~~

~~~drop lines=838-842
the deep-freeze memoisation set is added to BEFORE the freeze => closed-by `WP-200-FU1` (the memoisation LOW)
it does not reach monetary state today and the helper is not exported => closed-by `WP-200-FU1`
~~~

~~~drop lines=843-845
halt enforcement is an INTEGRATION obligation => closed-by `WP-230` (it reads both ledger sections)
the composition-root convention is owed by whoever builds it => closed-by `WP-230`
~~~

~~~drop lines=1204-1214
series eviction clears an outstanding gap obligation => history: documented behaviour with no owner
reappearance reports => history: documented behaviour with no owner
~~~

~~~drop lines=1222-1226
handle both interval fields => closed-by `WP-120` (the binding obligations)
acknowledgement is never an authoritative resync downstream => closed-by `WP-120`
~~~

~~~drop lines=1956-1963
follow_up 8 — replace the => closed-by `GOV-1C` (it ruled the §6.1 items, including follow_up 8)
~~~

**Facts.** C15 needs every residual clause of a dispositioned row accounted for. These rows carry no entry, so their clauses are dropped here, each with its closing package or its line in the brief. Added in r4 (J-02).

## RW-142: Completion record `WP-080`: the UNVERIFIED register (r7)

Excerpt of the record item at base lines 1355-1362:

~~~excerpt lines=1355-1362
- Implemented by `wp-implementer` (Opus) on branch `worktree-agent-a24ead9170631b1c6`,
  base `145fc32`; chain `cff20ba` (impl) → `be5d67a` (handoff). 48 files, all
  allowed; lockfile +16/−0. Orchestrator reproduced gates: root 1902/1902,
  contract 108/108 (offline), check:deps PASS. 15 venue facts cited from the
  official `binance/binance-spot-api-docs` (2026-08-27); ADR-004 framing item
  answered (JSON endpoints carry JSON; the binary SBE path is a different,
  key-required host, refused by construction); UNVERIFIED register BNC-U1..U6.
  Review round 1 dispatched.
~~~

New:

~~~new
- `WP-080`: the Binance UNVERIFIED register BNC-U1..U6 is still open in part. `BNC-U1`, `BNC-U2`, `BNC-U3`, `BNC-U4` and `BNC-U6` stay in `BINANCE_UNVERIFIED` (`packages/binance-adapter/src/venue.ts:236`), each with conservative handling. They cover the frame opcode, trade-id contiguity, bookTicker update-id monotonicity, empty-side representation and integer precision. ADR-014 closed `BNC-U5`. `WP-080`'s follow_up 3 asked the first `WP-120` connectivity work to settle `BNC-U1` by observation. `WP-120` is Complete, and no closure evidence was found at the cut, so that observation is still owed. The record names no later owner.
~~~

Keep (in both texts):

~~~keep
UNVERIFIED register BNC-U1..U6
~~~

Not carried:

~~~drop lines=1355-1362
- Implemented by `wp-implementer` (Opus) => history: who implemented it, on which branch
chain `cff20ba` (impl) → `be5d67a` (handoff) => history: the commit chain; `WP-080`'s merge `d0d66bf` is in its Work packages row
48 files, all => history: the diff size
lockfile +16/−0 => history: the diff size
Orchestrator reproduced gates => history: gates reproduced at the time
15 venue facts cited from the => history: the venue facts are in docs/handoffs/WP-080.md
ADR-004 framing item => history: answered (JSON endpoints carry JSON), recorded in ADR-004
Review round 1 dispatched. => history: the review ran; `WP-080` is Complete
~~~

**Facts.** The base mentions the register only in this in-flight record item, and the `WP-080` row carries no residual, so r1-r6 declared the range history (verifier finding D1, r7). The register is live at `f43efe6`: `packages/binance-adapter/src/venue.ts` line 236 lists `BNC-U1`, `BNC-U2`, `BNC-U3`, `BNC-U4` and `BNC-U6` in `BINANCE_UNVERIFIED`, and `BINANCE_RESOLVED` holds only `BNC-U5` (ADR-014). `docs/handoffs/WP-080.md` lines 457-460 (follow_up 3) give `BNC-U1`'s observation to the first `WP-120` connectivity work, and lines 2274-2276 list it as still open. No later record closes it. History: `wave-1-batch-1b-in-flight.md`.

## RW-143: Complete row `THROUGHPUT-2` (re-cut at `8fde4df`): the missed targets and the provisional ADR

Excerpts, lines 738-755 of the re-cut `8fde4df`:

~~~excerpt base=8fde4dffa9546dc7570f1e53653242c568669c58 lines=738-755
**Throughput:** 1.4×, 764–808 events/s; paced max lag 9–38 s (median about 19 s; base about 45 s).
**The targets were NOT met** (943 events/s, 5 s); the ranked options are in the record.
ADR-024 is **accepted provisionally**, pending the user's ratification.
The user ratifies afterwards, and a rejection is reverted by a follow-up round.
~~~

New:

~~~new
- `THROUGHPUT-2`: **the targets were NOT met** (943 events/s, 5 s). Throughput rose 1.4×, to 764–808 events/s; the paced max lag was 9–38 s (median about 19 s; base about 45 s). The ranked options are in the record, and so are the review's two LOWs, `TP2-R2-L1` and `TP2-R2-L2`. ADR-024 is **accepted provisionally**, pending the user's ratification; a rejection is reverted by a follow-up round.
- **ADR-024** (`THROUGHPUT-2`): accepted provisionally on 2026-09-30, pending the user's ratification.
~~~

Keep (in both texts):

~~~keep
764–808 events/s
median about 19 s; base about 45 s
The targets were NOT met
the ranked options are in the record
ADR-024 is accepted provisionally, pending the user's ratification
a rejection is reverted by a follow-up round
~~~

**Facts.** `THROUGHPUT-2` went Complete on `main` after the first cut (`d2ab6dc`), so it is declared at the re-cut. Its row names two live items: the missed throughput targets, and ADR-024's provisional acceptance. Both are carried under "Residuals recorded in Complete package rows", with the measured range (1.4×, 764–808 events/s; paced max lag 9–38 s, median about 19 s, base about 45 s) and the targets (943 events/s, 5 s). The ratification is also a Human items bullet. The row's correctness result (all 42,955 half-applied-state decisions gone, the 46,666 remaining equal to base) closes `H1R1-FRAME-ATOMICITY` (RW-19). The merge (`7d59fd3`) and the record link are in the Work packages row (RW-07). The brief points to the review's two LOWs, `TP2-R2-L1` and `TP2-R2-L2`, which the record carries to its follow-up. Not carried: the chain (`6be3eae` → `3b3f752`), the review findings' text, the CI run (PR #27 run `36686967040`) and the superseded authorization text, which are history in `work-packages-rounds.md`.

## RW-144: Complete row `VENUE-3` (re-cut at `8fde4df`)

Old, lines 756-768 of the re-cut `8fde4df`:

~~~old base=8fde4dffa9546dc7570f1e53653242c568669c58 lines=756-768
| `VENUE-3` (the phase-3 venue gate: the Wave 3 start re-verification, including the C-4 re-check and a fresh SDK pin check) | **Complete (2026-09-30)**: merged `6a15131` (`--no-ff`; `8375f2d` → `3625a66`). Fable r1 CHANGES REQUIRED (1 MEDIUM: the §14 index omitted four fetches; 3 LOW) → r2 **ACCEPT** (1 LOW). CI: PR #26 run `36675617008`. Report: `docs/venue/verified-2026-09-30.md`. The twelve §1.2 items: 7 UNCHANGED, 5 DRIFT (SDK, fees, matching engine, geoblock, RTDS). There are 17 drift rows E-01…E-17, conflicts C-9…C-14, and unverified items U-18…U-22, from 120 fetches, each SHA-256-indexed. **The phase-3 venue gate is OPEN.** **WP-260 SDK pin:** `@polymarket/client` **0.11.0** exactly, npm `latest`, whose build attestation names commit `d527956f47cf…`. Do NOT pin the unreleased head `6842ffa4`. The five-step fresh check is in §W.1. C-4 is still not reproduced. Record: `docs/handoffs/VENUE-3.md`. *(As authorized:* **Ready (authorized) 2026-09-30.**) The user: "Just in case you end up finishing wave 3 blockers, please proceed with orchestrating wave 3 work itself." It runs in parallel with `THROUGHPUT-2`, because its paths are disjoint. The implementer is the `venue-verifier` agent. HARDENING LOOP; verifier: a Fable adversarial-reviewer that re-fetches every source.

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
| `VENUE-3` | the phase-3 venue gate: the Wave 3 start re-verification, including the C-4 re-check and a fresh SDK pin check | Complete (2026-09-30) | `6a15131` | [VENUE-3](docs/handoffs/VENUE-3.md) |
- `THROUGHPUT-2` and `VENUE-3` are Complete (2026-09-30); see [Work packages](#work-packages). `VENUE-3` met the phase-3 venue gate.
- D-02: SDK 0.6.0 → 0.10.0 with breaking changes (`WP-260`). `VENUE-3` re-checked the pin: `@polymarket/client` **0.11.0** exactly, npm `latest`. Do NOT pin the unreleased head `6842ffa4`. The five-step fresh check is in `verified-2026-09-30.md` §W.1.
- The phase-3 report, `docs/venue/verified-2026-09-30.md` (`VENUE-3`), has its own drift rows E-01…E-17, conflicts C-9…C-14 and unverified items U-18…U-22, each with an owner in the report. The four with a residual row are the `V3-*` rows above. C-4 is still not reproduced.
~~~

Keep (in both texts):

~~~keep
0.11.0
npm latest
Do NOT pin the unreleased head 6842ffa4
five-step fresh check
E-01…E-17
C-4 is still not reproduced
~~~

**Facts.** `VENUE-3` went Complete on `main` after the first cut (`9d270a9`). It names no residual clause, so it needs no C12 disposition; it is paired here because the brief carries its live facts. Kept: Complete (2026-09-30), merged `6a15131` with its record link; the WP-260 pin (`@polymarket/client` 0.11.0 exactly, npm `latest`; not the unreleased head `6842ffa4`); the five-step fresh check in §W.1; the drift rows, conflicts and unverified items, each owned in the report; C-4 still not reproduced. The gate result is stated as met, not "OPEN" (K15). The four residual rows it produced are RW-146 to RW-149. Not carried: the chain (`8375f2d` → `3625a66`), the review, the CI run (PR #26 run `36675617008`), the per-item verdict counts, the 120 fetches, the attestation commit, and the superseded authorization text and scope, which are history in `work-packages-rounds.md`.

## RW-145: Work packages: `LOGS-1` (live: in merge; re-cut at `8fde4df`)

Old, lines 769-777 of the re-cut `8fde4df`:

~~~old base=8fde4dffa9546dc7570f1e53653242c568669c58 lines=769-777
| `LOGS-1` (records: make `IMPLEMENTATION_STATUS.md` a brief, with the full history archived verbatim) | **Ready (authorized) 2026-09-30** by the user: "an audit on this files and your recommendation and implementation of said recommendation … perhaps we want a full detail file, and then some sort of brief".

**Design (the orchestrator's recommendation):**
  - historical records are evidence, so they MOVE verbatim to `docs/status-archive/` and are never rewritten;
  - this file keeps its name, becomes the brief, and has its LIVE text rewritten plainly;
  - `docs/handoffs/INDEX.md` and a writing standard `docs/handoffs/README.md`;
  - a committed preservation proof (`tools/records/`).

Base `f43efe6`, loop `wf_57d03812-d59`: a read-only audit, then an Opus implementer, then a Fable reviewer. **At merge, the orchestrator re-applies every governance edit made on `main` since `f43efe6`, using `MOVE-MAP.md`.** | — | IMPLEMENTATION_STATUS.md, docs/status-archive/**, docs/handoffs/{INDEX,README}.md (new), tools/records/**, one sentence each in AGENTS.md/CLAUDE.md. Forbidden: existing handoffs, docs/spec, docs/adr, docs/venue, docs/contracts, code. | Fable review (preservation) + green CI |
~~~

New:

~~~new
| `LOGS-1` | records: make `IMPLEMENTATION_STATUS.md` a brief, with the full history archived verbatim | **Ready (authorized)** 2026-09-30; in merge | — | — |
- **`LOGS-1`**: Ready (authorized) by the user, 2026-09-30; now in merge.
  - Goal: make this file a brief. Historical records are evidence, so they move verbatim to `docs/status-archive/` and are never rewritten. It adds `docs/handoffs/INDEX.md`, a writing standard (`docs/handoffs/README.md`) and a committed preservation proof (`tools/records/`).
  - Base `f43efe6`. At merge, the orchestrator re-applies every governance edit made on `main` since `f43efe6`, using `MOVE-MAP.md`: this re-cut is at `8fde4df`.
  - Gate: a Fable review of the preservation, and a green CI run on GitHub.
~~~

Keep (in both texts):

~~~keep
historical records are evidence
a committed preservation proof
Fable review
re-applies every governance edit made on main since f43efe6, using MOVE-MAP.md
~~~

**Facts.** The `LOGS-1` row was added on `main` after the first cut (`8fc0eb1`), so it is paired at the re-cut. Kept: Ready (authorized) 2026-09-30, now in merge; the design (historical records move verbatim and are never rewritten; this file becomes the brief; the handoff index and writing standard; a committed preservation proof); base `f43efe6`; the re-application of every governance edit made on `main` since `f43efe6`, using `MOVE-MAP.md`; the gate, with its reviewer (the base's "Fable review (preservation) + green CI": a Fable review of the preservation, and a green CI run on GitHub). Not carried: the user's quoted words, the loop id `wf_57d03812-d59`, the audit-implementer-reviewer order, and the allowed and forbidden paths (the archived row).

## RW-146: Residual `V3-C13-REFERENCE-TWAP` (added after the first cut; re-cut at `8fde4df`)

Old, lines 2619-2623 of the re-cut `8fde4df`:

~~~old base=8fde4dffa9546dc7570f1e53653242c568669c58 lines=2619-2623
| **V3-C13-REFERENCE-TWAP** | **A ruling is needed (the user).** The venue moved its reference/TWAP prices from the public RTDS feed to an AUTHENTICATED service, PolyBolt (`wss://ws-live-v2.polymarket.com/ws`), which requires CLOB API credentials. The PAPER rules forbid those credentials.
  - The 30-second TWAP window has no replacement, and prices are now decimal strings.
  - The old RTDS price topics are due for removal "one month after 0.11.0", about 2026-10-23 by the verifier's arithmetic (U-20; not a venue statement).
  - Nothing running today uses RTDS: the trader's reference venue is Binance, and the example configs do not enable RTDS.
  - Affected: the RTDS adapter, the data gateway's `rtds` block, the settlement ADR-009 §6 30-second window, and the `rtds/twap-update` fixture. | `docs/venue/verified-2026-09-30.md` E-09…E-12, C-13 | the user rules; then the owners act on E-09…E-12 |
~~~

New:

~~~new
| `V3-C13-REFERENCE-TWAP` | A ruling is needed from the user. The venue moved its reference/TWAP prices from the public RTDS feed to an authenticated service, PolyBolt (`wss://ws-live-v2.polymarket.com/ws`), which requires CLOB API credentials; the PAPER rules forbid those credentials. The 30-second TWAP window has no replacement, and prices are now decimal strings. The old RTDS price topics are due for removal "one month after 0.11.0": about 2026-10-23 by the verifier's arithmetic (U-20; not a venue statement). Nothing running today uses RTDS: the trader's reference venue is Binance, and the example configs do not enable RTDS. Affected: the RTDS adapter, the data gateway's `rtds` block, ADR-009 §6's 30-second window, and the `rtds/twap-update` fixture. | the user rules; then the owners act on E-09…E-12 (`verified-2026-09-30.md` C-13) |
~~~

Keep (in both texts):

~~~keep
PolyBolt
The 30-second TWAP window has no replacement
about 2026-10-23 by the verifier's arithmetic
Nothing running today uses RTDS
the rtds/twap-update fixture
~~~

**Facts.** Added on `main` by `9d270a9` (from `VENUE-3`). Kept: the ruling the user owes; the move to PolyBolt (`wss://ws-live-v2.polymarket.com/ws`) and its CLOB API credentials, which PAPER forbids; the lost 30-second window and the decimal-string prices; the removal date as the verifier's arithmetic (U-20), not a venue statement; that nothing running uses RTDS; every affected surface. The owner cell adds the report's conflict id (C-13). Archive only: the evidence cite (`verified-2026-09-30.md` E-09…E-12).

## RW-147: Residual `V3-E15-DATA-API-V1-SUNSET` (added after the first cut; re-cut at `8fde4df`)

Old, lines 2624-2624 of the re-cut `8fde4df`:

~~~old base=8fde4dffa9546dc7570f1e53653242c568669c58 lines=2624-2624
| **V3-E15-DATA-API-V1-SUNSET** | The Data API v1 shuts down **2026-10-24**. `WP-290` (reconciliation) and `WP-330` (the ops CLI) must use the `/v2` routes. Check whether any current code calls v1 | `verified-2026-09-30.md` E-15 | WP-290/WP-330 packets; the orchestrator greps for v1 use before 2026-10-24 |
~~~

New:

~~~new
| `V3-E15-DATA-API-V1-SUNSET` | The Data API v1 shuts down 2026-10-24. `WP-290` (reconciliation) and `WP-330` (the ops CLI) must use the `/v2` routes. Check whether any current code calls v1. | the `WP-290` and `WP-330` packets; the orchestrator greps for v1 use before 2026-10-24 |
~~~

Keep (in both texts):

~~~keep
Data API v1 shuts down
2026-10-24
must use the /v2 routes
~~~

**Facts.** Added on `main` by `9d270a9` (from `VENUE-3`). Kept: the shutdown date, both packages and their `/v2` obligation, the instruction to check whether any current code calls v1 (kept as an instruction, not a status), and the orchestrator's grep before the date. Archive only: the evidence cite (E-15).

## RW-148: Residual `V3-C12-HEARTBEAT-ADR` (added after the first cut; re-cut at `8fde4df`)

Old, lines 2625-2625 of the re-cut `8fde4df`:

~~~old base=8fde4dffa9546dc7570f1e53653242c568669c58 lines=2625-2625
| **V3-C12-HEARTBEAT-ADR** | The SDK has no order-heartbeat method, but the handoff says both to wrap only the SDK AND to send order heartbeats. This needs an ADR before `WP-320` | `verified-2026-09-30.md` C-12, E-17 | the orchestrator, before WP-320 |
~~~

New:

~~~new
| `V3-C12-HEARTBEAT-ADR` | The SDK has no order-heartbeat method, but the handoff says both to wrap only the SDK and to send order heartbeats. This needs an ADR before `WP-320` (`verified-2026-09-30.md` C-12, E-17). | the orchestrator, before `WP-320` |
~~~

Keep (in both texts):

~~~keep
no order-heartbeat method
to wrap only the SDK
before WP-320
~~~

**Facts.** Added on `main` by `9d270a9` (from `VENUE-3`). Kept: the missing SDK heartbeat method, the handoff's two instructions, the ADR it needs, and the owner (the orchestrator, before `WP-320`). The evidence cite (C-12, E-17) moved into the residual cell.

## RW-149: Residual `V3-FIXTURES` (added after the first cut; re-cut at `8fde4df`)

Old, lines 2626-2626 of the re-cut `8fde4df`:

~~~old base=8fde4dffa9546dc7570f1e53653242c568669c58 lines=2626-2626
| **V3-FIXTURES** | Three venue fixtures are stale or contested: `fees` (`samples_per_epoch` 10080, now 1,440/day), `restricted-modes` (the 503 cancel-only text changed; C-9) and `rtds/twap-update` (a deprecated source). `ops:verify-venue` still passes, because it pins the 2026-08-24 snapshot. Also C-11: the batch-cancel limit (1,000 vs 3,000); use ≤ 1,000 | `verified-2026-09-30.md` §15, C-9, C-11 | the fixture owner, and the WP-270 packet |
~~~

New:

~~~new
| `V3-FIXTURES` | Three venue fixtures are stale or contested: `fees` (`samples_per_epoch` 10080; now 1,440 a day), `restricted-modes` (the 503 cancel-only text changed; C-9) and `rtds/twap-update` (a deprecated source). `ops:verify-venue` still passes, because it pins the 2026-08-24 snapshot. C-11: the batch-cancel limit is contested (1,000 vs 3,000); use ≤ 1,000. | the fixture owner, and the `WP-270` packet |
~~~

Keep (in both texts):

~~~keep
Three venue fixtures are stale or contested
samples_per_epoch
ops:verify-venue still passes
because it pins the 2026-08-24 snapshot
use ≤ 1,000
~~~

**Facts.** Added on `main` by `9d270a9` (from `VENUE-3`). Kept: the three fixtures and why each is stale or contested (C-9 included); why `ops:verify-venue` still passes; C-11 and the ≤ 1,000 rule; both owners. Archive only: the evidence cite (§15, C-9, C-11).
