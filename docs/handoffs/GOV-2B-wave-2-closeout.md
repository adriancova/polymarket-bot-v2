# GOV-2B — Wave 2 closeout audit (runbook §10)

**Run:** 2026-09-15, read-only, on `main` at `b9bacc1`. Six independent agents:
four auditors over §10 steps 1-8 (acceptance matrix + merge SHAs; the §7 exit
checklist; gates and CI coverage; unresolved findings, drift, evidence-gating and
run mode), then the §10:718 second architectural-consistency pass and a
completeness critic. No agent modified any file.

# VERDICT: WAVE 2 IS NOT CLOSED

Every one of the eleven Wave 2 packages passes its own acceptance criteria — the
matrix pass verified all eleven merge SHAs as ancestors of `main` with matching
subjects, and evidenced every criterion against a named, currently-passing test.
**The wave does not close because three seams where those packages must COMPOSE
do not hold, and two of them are invisible to any per-package review precisely
because each package is individually correct.**

## The §7 exit checklist, item by item

| # | Checklist item | Verdict |
|---|---|---|
| 1 | Full paper pipeline works end to end | **NOT MET** — what works end to end is the all-doubles harness |
| 2 | Replaying the same dataset produces identical results | MET WITH QUALIFICATION |
| 3 | Ledger rebuild equals incremental projections | MET WITH QUALIFICATION |
| 4 | Static Bracket runs in replay **and live-data paper mode** through the same code | **NOT MET** — neither half |
| 5 | Dashboards expose decisions, risk vetoes, simulated fills, and PnL | **NOT MET** — PnL is a text panel with no targets, and no `trader_*` series has a producer |
| 6 | No real signer is installed | MET (verified from the lockfile and code, not the status file) |
| 7 | Maximum run mode remains `PAPER` | MET (verified from `safety.ts`, with the honest limit that nothing has ever been deployed) |

Wave 2's checklist, unlike Wave 1's (runbook:418), carries **no "or explicitly
pending" carve-out**, so an unevidenced item is NOT MET rather than deferred.

## Blocking findings

**B1 (BLOCKER, code) — the assembled durable paper trader GLOBAL-HALTS on its
first fill.** `apps/trader/src/adapters/postgres-store.ts:233-236` inserts
`toPnlSnapshotRow`'s camelCase keys into the snake_case `accounting.pnl_snapshots`
columns behind `.values(row as never)`, with no `CamelCasePlugin` registered
(`packages/storage-postgres/src/database.ts:22-26`). Compiled against the
repository's own Kysely, the emitted SQL is literally
`insert into "accounting"."pnl_snapshots" ("scope", "accountRef", "grossTradingPnl", "asOf") values ($1, $2, $3, $4)`
— quoted camelCase identifiers naming columns that do not exist. PostgreSQL
rejects it; `#contained` converts the throw to `UNAVAILABLE`; `loop.ts:1523-1530`
escalates that to a GLOBAL `STORE_UNAVAILABLE` halt; `loop.ts:1421` runs it after
every fill. The `as never` cast is exactly what suppressed the compile error that
would have caught this — the two sibling inserts in the same file write explicit
snake_case and need no cast. The critic confirmed independently that this is the
repository's **only** production writer of that table. Coverage is zero: every
reference to `writePnlSnapshot` outside it is the in-memory double.
*The doubles are not a weaker proxy for the real adapter; they are masking a live
defect in it.*

**B2 (BLOCKER, code) — no protective exit can clear the risk seam, so no realized
round trip is reachable.** `static-bracket` emits exits as POSITION
(`decide.ts:770/1614/1798`); `packages/risk` classifies POSITION as ENTRY
(`intent-view.ts:147`); `engine.ts:594-612`'s entry-only positive-net-edge gate
then refuses the exit for a missing `expectedNetEdge` that an exit can never
declare. The committed golden records it: `refusedExits 1`,
`RISK_EDGE_INPUTS_MISSING`, `realizedPnl "0"`. Both packages pass their own
criteria; the composition does not hold.

**B3 (BLOCKER, code) — CHECK-4's replay half does not exist.**
`apps/backtest-cli/package.json` declares only `polymarket-public`, `simulation`
and `storage-parquet`, so the strategy, runtime, risk, planner and ledger are not
reachable from the shipped replay root, and `coreLoop` is never supplied anywhere
in the repository (five hits, all declaration or pass-through).

**B4 (BLOCKER, human + code) — CHECK-4's live-data half has never been run.**
`RedisMarketEventFeed` appears in two files and has no test; the Postgres adapter
self-discloses that no database was ever reached. B1 means such a run would halt
on its first fill today.

**B5 (HIGH) — dashboards.** "Realized PnL" is a `type: text` panel with an empty
targets list; the only PnL series in `metric-families.ts:374` is a record COUNT.
No `trader_*` series has a runtime producer: `apps/trader` serves no HTTP, no
Prometheus job scrapes the control API, nothing provisions a Grafana.

**B6 (HIGH, evidence) — the evidence runs in no gate.** WP-250's six
`test/e2e/**` suites — the Phase-2 evidence for four of the seven checklist items
— are absent from `test/vitest.config.ts`'s include list and from every CI step.
They pass only because auditors invoked them by hand. The critic adds that this
tree is also the repository's only mechanical tripwire for the outstanding
residual backlog, so the gap costs regression detection as well as acceptance
evidence.

**B7 (BLOCKER because the step fails, tooling) — `pnpm run audit` exits 1**
(GHSA-2883-xcg3-v3hh in js-yaml, dev-only transitive via eslint), and `ci.yml:58`
runs it before the integration step, so §10 step 4 "run full CI" cannot succeed.
Reproduced at `b9bacc1`: `true audit exit=1`.

**B8 (MEDIUM, governance) — the ledger contradicts itself where the closeout must
read it as authority.** `IMPLEMENTATION_STATUS.md:1629-1631` says
`## Open blockers` / `None.`, immediately followed by a 219-line record whose own
closing text says it "stays open … since every finding it names is still live on
`main`".

**G-01 (BLOCKER, governance — found only by the completeness critic) — the
phase-2 venue gate was never run.** Handoff §1.2 requires a twelve-item
re-verification against official sources at the start of each implementation
phase, committed as `docs/venue/verified-YYYY-MM-DD.md`. Every Wave 2 package is
`phase: phase-2`. The only full report is `verified-2026-08-24.md` from phase-0;
the two later files state in their own scope paragraphs that they are "a bounded
re-issue, not a full handoff-§1.2 phase-gate re-verification", and
`verified-2026-09-02.md` §7 item 3 records the full re-verification as still owed
"at the next phase gate".

## What Wave 2's completion unblocks

**Nothing that was not already unblocked.** The `depends_on` graph was parsed
programmatically: no package anywhere in the plan depends on WP-150…WP-250 except
WP-250 itself and WP-360. WP-260's three edges (WP-000, WP-020, WP-030) are all
Wave 0 and were satisfied before Wave 2 began; it is held by **wave ordering and
the signer boundary**, and closing Wave 2 changes only the first. WP-270…WP-340
are blocked behind WP-260 transitively.

**Consequence for the gate:** because the graph releases nothing new, the cost of
not closing Wave 2 today is only that WP-260 stays wave-deferred — a low price
for fixing B1 and B2 first, and B1 in particular is a defect on the durable
storage path that Wave 3's live-micro infrastructure would build directly on.

## Non-blocking queue (recorded, owners named)

N1 the golden's `pnlRecords` counter/array 2× disagreement (NOT ESTABLISHED as a
defect; one bounded check owed). N2 `schema-boundary.md` §3's basis sentence for
`packages/order-book` is wrong ("scalar parses only" vs two object `safeParse`
calls at `book.ts:191/:265`). N3 GOV-2A's totality-claim ruling has already had
its trigger fire once unmet in `packages/features`. N4 `test:replay`'s
`test/replay-golden` positional matches zero test files. N5 the CI step labelled
"Testcontainers — PostgreSQL and Redis" chains six suites of which two use
containers. N6 four Wave 2 handoffs carry none of the eight
`required_handoff_fields` as labeled sections (and the two controlling documents
disagree on the field list). N7 nine of eleven Wave 2 merges touched the protected
`pnpm-lock.yaml` with only one ratified. N8 three WP-240 r1 findings live and
untested, including an audit-log exhaustion path that can disable the §14.1 kill
switch. N9 WP-200 declares an `allowed_path` that does not exist. N10 the
accumulated contract-owner docs debt queued as follow-up 1 by sixteen handoffs.
G-03 the soak tree's three job specs, only one gated. G-13 the status file
presents eleven unqualified Complete rows over "Open blockers: None."

## Rounds this audit recommends (scope, owner, order)

R7 (tooling, trivial) lockfile bump to clear the audit gate → **R1** (code) the
`pnl_snapshots` column binding, deleting the `as never` so the compiler checks it
→ **R2** (code) the risk protective-reduction seam, choosing explicitly between
`static-bracket` emitting §7.7 REDUCE_POSITION and `packages/risk` recognizing a
reducing POSITION (the composition root may NOT re-derive disposition from tags;
`pipeline.ts:99-103` forbids it and is right to) → **R8** (code) real-
infrastructure integration for the trader's two adapters, which is the round that
would have caught B1 → **R3** (code) the backtest replay composition root → R4
(code) the trader HTTP health endpoint and an exact-decimal PnL producer → R5
(infra + human) a Prometheus scrape job, a provisioned Grafana and a real import
→ R6 (tooling) gate `test/e2e/**` and `test:replay` → R9 (governance + docs) the
ledger-integrity and contract-owner round → R10 (code, Wave 3 precondition) the
trader read path, without which §6 invariant 8's rebuildability is unreachable in
the composed system.

## What only the human can discharge

**H1** a live-data paper run (after R1, R2, R8). **H2** a real GitHub Actions run
— settled negatively and more strongly than the status file states: `git remote -v`
is EMPTY across the whole history, so `ci.yml` has never executed once and every
gate claimed for every Wave 2 package was run on one laptop. **H3** a real Grafana
import. **H4** elapsed soak evidence (Wave 1's carry-over, not a Wave 2
condition). **H5** a governance ruling on the runbook:509-vs-514 ordering tension
— whether one demonstrated live-data run discharges :509, or whether sustained
accumulation is the post-closeout activity :514 describes. **H6** the
authorization rows and the round order. **H7** ratification of four surfaced
process deviations (the four handoffs' field format, the nine lockfile touches,
the four root-wiring commits without recorded reviewer sign-off, and the two SER
confirming reviews that ran as Claude adversarial-reviewers because Codex's
content filter refused the packet four times across two models).

## Audit confidence

HIGH on the verdict and on B1-B4, each established by executing against the
source rather than by reading claims: the camelCase SQL was compiled and printed;
the halt path traced `loop.ts:1421` → `:1523-1530`; the ENTRY-disposition refusal
traced `decide.ts` → `intent-view.ts:147` → `engine.ts:594-612` and corroborated
in the committed golden; the empty `coreLoop` confirmed by grep and by
`apps/backtest-cli`'s dependency list. HIGH on the unblocked-packages answer,
which is a property of the parsed graph rather than a judgement. MEDIUM on B5's
severity grading. The critic re-verified the three most load-bearing claims
independently and all three held.
