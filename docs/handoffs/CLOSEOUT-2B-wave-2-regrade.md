# CLOSEOUT-2B: Wave 2 re-grade after DURABLE-1 (runbook §10)

**Date:** 2026-09-30. Read-only, in the detached worktree `polymarket-bot-closeout-2b` at `9ce53a1` (`9ce53a122897696b8ee549bf894234971bd0d5b1`, which equals `main`).

**Agents:**
- **Opus auditor:** `scratchpad/closeout-2b/opus.md`, with probes and logs in `opus-probes/`.
- **Codex gpt-6-astra auditor:** `scratchpad/closeout-2b/astra.md`, with probes in `/tmp/closeout-2b-astra/`.
- **Synthesis (this report):** it re-ran Opus's probe suite itself (`scratchpad/closeout-2b/synth/probes-rerun.log`).

**Audit hygiene:**
- No tracked file was edited.
- The worktree's `git status` is clean.
- No `polymarket-bot-trader-*` container, protected port or `~/pmb-h1/` was touched.

**Baseline:** CLOSEOUT-2 (`docs/handoffs/CLOSEOUT-2-wave-2-closeout.md`, audited at `8fde4df`). It stands except where this report changes it.

# VERDICT: WAVE 2 IS NOT CLOSED

**Why it is not closed:**
- The economic half of X1 is fixed: every placement, fill and ledger write now waits for its decision to be durable.
- The criterion set for this audit is literal: *"A venue_submit or ledger_write before the originating decision is durable anywhere = X1 OPEN."*
- DURABLE-1 deliberately exempts CANCEL from its own decision's durability barrier. This is its LOW-1 finding, still awaiting the user's ruling.
- Both auditors and I observed a CANCEL `venue_submit` before its decision was durable, on every shipped run path.
- So X1 is **OPEN, narrowed to the CANCEL exemption**.

**What closes it:** a single user ruling.
- **If the user accepts LOW-1**, no code round is needed. Item 1 then becomes MET WITH QUALIFICATION and the wave closes.
- **If the user rejects LOW-1**, one bounded round (a one-condition edit, per `DURABLE-1.md` follow_up) and a gates-plus-probe re-check are required.

## X1 status: OPEN (narrowed), LOW technical severity, closable by a ruling

**Closed for every economic effect.**

**The mechanism:**
- Every non-CANCEL intent goes through `#persistDecisionsBeforePlacement()` before it gets an id, an allocation, a risk check, a reservation or a submit (`packages/trading-core/src/loop.ts:1898`).
- If that write fails, the loop latches a GLOBAL `STORE_UNAVAILABLE` halt and refuses the placement.
- The only production file changed between `8fde4df` and `9ce53a1` is `loop.ts`. `git diff --stat` shows the other five changed files are tests or test support.

**E-01 reproduced in both arms:**
- The run on `9ce53a1` records only the refusal, with `fills=0`, `transactions=0`, `persistedIntentDecisions=0` and `halt=STORE_UNAVAILABLE`, in the per-row and the group-commit arm.
- The probe's old `fills > 0` assertion now fails, as expected.
- Evidence: `opus-probes/e01.log`, astra C2B-02, and my re-run.

**New orderings, 9ce53a1 vs base:**

| Ordering | Opus (9ce53a1 / base) | Astra (9ce53a1) |
|---|---|---|
| Frame path (ADR-024) | P1 `3-4\|5-6` framing: 0 violations / violations | Frame-close entry held and then refused: 0 submits and 0 ledger writes |
| Loop-originated `onFill` exit | P2: every POSITION submit had a durable origin / fails | Take-profit held until its decision was persisted |
| Protective reduce | P2 (seq 8) clean / fails | Reduce held and then refused: no effect |
| Group commit mid-batch | P3: while a commit was held in flight, 0 submits and 0 ledger writes / violations | Completing the earlier commit did not release the entry; its own commit was needed |
| Hung store | P3b: 0 submits and 0 fills in both arms / fails | n/a |
| Backtest root | P5 on the shipped `runBacktest` over the golden: 12/12 decisions durable, 0 placement violations / violations | Reduce refused; `STORE_UNAVAILABLE` |

My re-run of Opus's suite gave 17 passes and 6 failures:
- **4 of the failures are the expected E-01 inversions:** its `fills > 0` assertions now fail.
- **The other 2 are vacuous P1 framings** (`4-5-6` and `all`). They emit no intent on base either, so they are evidence neither way.
- **Across all runs, 35 POSITION submits had `originDurable:true`.** Zero non-CANCEL submits had `originDurable:false`.

**The residual that keeps X1 open, a CANCEL submitted before its own decision is durable:**
- **What happens:** a CANCEL's `venue_submit` reaches the venue while its own decision is not yet durable.
- **Where it was observed:** paper-e2e (origin seq 6), two-brackets (seq 5), the framed `onMarketClosing` cancel, and the backtest golden (seq 6). It occurs in both arms. My re-run shows 7 CANCEL submits with `originDurable:false`.
- **Code:**
  - At `loop.ts:1880-1897`, a CANCEL waits only for decisions that are already staged, not for its own.
  - The exemption is pinned as intended behaviour by `test/e2e/durable-decision-protective-reduce.test.ts:170,199-221`.
- **Recorded status:** disclosed in `docs/handoffs/DURABLE-1.md:7-9` as LOW-1, "user ruling owed". `IMPLEMENTATION_STATUS.md` records no ruling (grep shows none at `9ce53a1`).

## Where the auditors disagreed, and how I resolved it

**The disagreement:** Opus said "X1 CLOSED" with F1 as a MEDIUM precondition for closing the wave. Astra said "X1 OPEN" with C2B-01 rated LOW.

**What they agree on:**
- **The facts.** Both observed the same CANCEL-before-durable submits. Both found no non-CANCEL violation.
- **The consequence.** Both say the user's LOW-1 ruling is required before Wave 2 is declared closed (opus.md F1 "Required"; astra.md C2B-04 follow_up).

**The disagreement is only over the label.** I re-ran the probes (`synth/probes-rerun.log`) and confirmed the CANCEL rows. I adopted astra's label for three reasons:
- The criterion for this audit names *any* `venue_submit`. An auditor cannot narrow it to non-CANCEL; only the user can.
- CLOSEOUT-2's own regression requirement is worded the same way ("no `venue_submit` or `ledger_write` may occur before the originating decision is durable").
- Handoff §8.1 (`docs/spec/polymarket-bot-orchestrator-handoff.md:674-685`) puts persist before any submit. §6 invariant 13 (`:428`, "Safety cancellation outranks new order placement") supports the exemption, but that is a ruling for the user to make and record, not for an auditor to infer (AGENTS.md: "Accepted ADRs may refine … may not silently override the handoff").

**Severity:** I grade the residual technically LOW, as astra does. A CANCEL places, fills and books nothing, and every CANCEL was already submitted this way on base. It is nevertheless **gating**, because it is the only thing that stands between the wave and closure.

## §7 item 1 re-graded: NOT MET, pending one ruling (it was NOT MET on the blocker X1)

- The economic seam is fixed and proven in both arms and on six orderings.
- The success-path evidence from CLOSEOUT-2 is untouched:
  - BRACKET-1c durable 3/3;
  - BOOT-1 9/9;
  - five live H1 windows.
- The trader integration suite passes 194/194 (both auditors).
- **If the user accepts LOW-1,** item 1 becomes **MET WITH QUALIFICATION**, with these qualifications:
  - (a) The live fill → ledger → PnL half has never run on live data, because the settlement veto holds (B-F1/N2).
  - (b) The store failure is shown only by injection or a PostgreSQL trigger, never by a real connection loss (opus F3; `DURABLE-1.md` known_risks).
  - (c) The R2-LOW-7 and LOW-3 residuals (below).

## Regression check of §7 items 2-5 and 7: none found

| Gate | Opus | Astra |
|---|---|---|
| `test:replay` | 3 files / 17 tests passed (`opus-probes/replay.log`) | 17/17 |
| `test:e2e` | 9 files / 212 passed (`e2e.log`) | 212/212 |
| trader `test:integration` | 193/194 on the first run (Redis container start, environmental), then 194/194 on a re-run (`trader-int-2.log`) | 194/194 |
| `pnpm test` / `check:deps` | 7817 passed / exit 0 | not run |

**Goldens:** `git diff --quiet 8fde4df 9ce53a1 -- test/replay-golden` is clean. The tree hash is `c9fd8e8b…` at both SHAs (I re-checked it).

**Safety and risk:** `git diff --quiet 8fde4df 9ce53a1 -- packages/trading-core/src/safety.ts packages/risk` is clean (re-checked). `docs/spec` is unchanged.

**CI:** run `36737224770` on `9ce53a1` completed with **success** (`gh run list`, checked by me). This supersedes opus F6, "in progress".

**Item grades:**

| Item | Grade |
|---|---|
| 2 | MET WITH QUALIFICATION, unchanged |
| 3 | MET WITH QUALIFICATION, unchanged |
| 4 | MET WITH QUALIFICATION, unchanged |
| 5 | MET WITH QUALIFICATION, unchanged. The only surface delta is that a boundary refusal is now counted as `RISK_RUN_STATE_BLOCKS`, on failure only (LOW-4). |
| 6 | MET, unchanged |
| 7 | MET, unchanged |

## Findings

**[LOW, gating] X1-R: the CANCEL exemption (DURABLE-1 LOW-1)**
- As described above.
- **Required:** the user rules on LOW-1, together with the A01 `cancelsFirst` routing-order ruling (`DURABLE-1.md:9`).

**[LOW] R2-LOW-7 and LOW-3: disclosed residuals**
- **R2-LOW-7:** a later decision's CANCEL waits on an earlier decision's placement-boundary write (`loop.ts:1898` → `:3613/:3617`).
- **LOW-3:** in group mode, a decision and its checkpoint can commit in separate transactions. Opus P3 observed the commit split `[2]`, then `[3..6]`.
- **Status:** both are harmless while `restoreFrom` has no production caller.
- **Required:** owners must be named before a production restore path or WP-270.

**[LOW] Durability shown by injection only**
- The evidence is a PostgreSQL trigger and store-port wrappers. No connection loss mid-commit has been exercised (opus F3).

**[LOW] Placement latency unverified**
- The loop now awaits a store round trip per intent-bearing decision.
- The bench exercises this path once in 46,666 decisions (LOW-6), and the lag result is UNVERIFIED (`DURABLE-1.md` r2 LAG). This does not regress a §7 item.

**[INFO] Flaky trader-integration test**
- `redis-outage-halts-postgres-redis.test.ts` failed once, under concurrent container load.
- It passed 4/4 when re-run alone and 194/194 in the full re-run (opus F5). Astra saw 194/194 on its first run.
- DURABLE-1 does not touch that file.

**[INFO] N1 (E-02) still reproduces on `9ce53a1`**
- With the clock at 12:30 against a 12:15 close, the entry is approved and filled (`opus-probes/e01.log`, third case).
- This is unchanged, as expected.

## CLOSEOUT-2 carried findings

**N1-N11:** unchanged. DURABLE-1 touches only `loop.ts`'s decision-write timing and tests. Of these, only N1 was re-probed, and it still reproduces.

**L1-L9, I1, and the GOV-2B re-grade B1-B10/R/H:** unchanged.

**One addition to the follow-ups:** `DURABLE-1.md` follow_up says the trader integration `vitest.config.ts` header still counts six container files; there are now seven. This is an L3-class stale label.

## Runbook §10 step 10: exact packages now unblocked

**None, while the verdict is NOT CLOSED.**

The work plan is unchanged since `8fde4df` (`git diff --quiet … -- docs/spec`), so CLOSEOUT-2's dependency derivation stands:
- **On closure, exactly one package is released: `WP-260`.** Its dependencies, WP-000, WP-020 and WP-030, are merged.
- **Its attached preconditions:**
  - L7, a mechanical guard that keeps signing libraries out of `trading-core`, lands with or before it;
  - N1 and N8 are owned before WP-270;
  - WP-270 writes its signed-attempt rows after the DURABLE-1 boundary (`DURABLE-1.md` follow_up).
- **Nothing else is released.** WP-270, WP-280, WP-290, WP-300, WP-310, WP-320, WP-330, WP-340, WP-350, WP-360 and WP-370 all sit behind WP-260, directly or transitively.

## What closes the wave now

1. **The user rules on LOW-1** (the CANCEL exemption) **and on A01** (`cancelsFirst`).
   - **If both are accepted:** record the ruling in `IMPLEMENTATION_STATUS.md` (or an ADR). WAVE 2 IS CLOSED WITH QUALIFICATIONS, and no re-audit is needed; this report's item-1 grade then reads MET WITH QUALIFICATION.
   - **If LOW-1 is rejected:** one round makes a CANCEL wait for its own record, keeping §6 invariant 13 in mind. Then re-run the gates and the probe suite.

## The user's ruling (2026-09-30)
Asked whether a CANCEL may go out before its own decision is durable, the user answered **"Yes, cancels go first"**, the option both verifiers recommended. Recorded as a ruled deviation from handoff §8.1's literal order: a CANCEL places and books nothing, so it never waits on the store. Within one decision, cancels route before placements (`cancelsFirst`). With this ruling `X1` is CLOSED and **Wave 2 is CLOSED WITH QUALIFICATIONS**. Exactly `WP-260` is released.
