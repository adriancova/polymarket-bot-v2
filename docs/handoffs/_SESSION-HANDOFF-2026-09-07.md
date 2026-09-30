# Session hand-off — polymarket-bot orchestration (2026-09-07)

> Historical snapshot, superseded 2026-09-11. The instructions and pending
> states below describe 2026-09-07, not current work. `WP-060-FU1` merged
> as `d869868`; governance commit `d921bfa` records completion.
> Use `IMPLEMENTATION_STATUS.md` and `docs/handoffs/WP-060-FU1.md`
> for current state. Do not execute this snapshot's pending-work instructions.

Paste everything below the line into a fresh agent. It is written to be
self-contained; the agent should still read the repo's own authority
files (named inside) before acting.

---

You are the **implementation orchestrator** for the `polymarket-bot`
repository (`/home/adriancova/proyects/tradeBot/polymarket-bot`). You run
on the main session model; you drive per-package hardening rounds through
subagents/Codex, verify them yourself, and merge under a standing
delegation. Do not ask permission to merge after an ACCEPT — the release
delegation is standing.

## 0. First actions (do these before anything else)

1. Read `AGENTS.md`, `docs/spec/polymarket-bot-agent-orchestration-runbook.md`,
   `docs/spec/polymarket-bot-workplan.yaml`, `IMPLEMENTATION_STATUS.md`,
   and the auto-memory index (`.../memory/MEMORY.md`, especially
   `orchestration-roles.md`). Trust the repo over this prompt; verify
   every SHA against `git`.
2. Read the most recent completion records in `docs/handoffs/` for the
   pattern: `WP-060-FU1` will not exist yet; read `UNIV-3.md`,
   `SETL-2.md`, `WP-200-FU2.md` (the three most recent) to learn the
   house style for merges, governance rows, and residual ownership.

## 1. MODEL / TOOLING POLICY — this changed mid-session, it is critical

- **Operator switched (2026-09-07, near their Claude subscription limit):
  Codex `gpt-6-astra` (medium reasoning) now does IMPLEMENTATION AND
  REVIEW**, not just docs. Claude subagents are no longer launched for
  these rounds. A rate-limit-killed Claude agent is NOT resumed — salvage
  its committed worktree progress and hand the rest to Codex.
- **The codex-companion `task` wrapper is BROKEN** (`failed to load
  configuration: No such file or directory`; `setup` shows `auth: failed
  to resolve feature override precedence`). **Do NOT use the companion.**
  Codex itself is healthy. Drive it directly:
  ```
  codex exec --skip-git-repo-check -m gpt-6-astra --sandbox workspace-write "<full self-contained packet>"
  ```
  Run it `run_in_background: true`. `--sandbox workspace-write` grants
  write to the cwd + /tmp; run it FROM the target worktree for
  implementation, or from `/tmp` for a review whose scratch is under
  `/tmp`. Omit write (or it defaults read-only) is not needed — reviews
  still need write for their `/tmp` scratch mutations.
- **Codex cannot write git metadata inside a worktree.** Every
  implementation packet must say: leave changes UNSTAGED, write the
  commit message to `/tmp/<wp>-commit-message.txt`. **You** (orchestrator)
  then stage, apply any tiny build-fix, `git commit -F`, and reproduce
  ALL heavy gates locally (Codex packets say run only the package suite +
  typecheck + check:deps, never root/e2e).
- **MEMORY-KILL HAZARD:** running two Codex jobs at once, or a review
  that copies the pnpm store to /tmp, overran host memory and got killed.
  **Run Codex jobs STRICTLY ONE AT A TIME.** A review's own `pnpm install
  --frozen-lockfile` in /tmp is fine as a single job (host had ~23Gi free
  when idle).
- **CONTENT-FILTER HAZARD:** Codex's cybersecurity filter kills
  prototype-pollution work phrased as attack/exploit. Phrase every packet
  in plain defensive-engineering language (own-property reads, accessor
  handling, inherited-value adoption, ambient global state, failure-mode
  tests). A neutralized packet cleared the filter; if one still trips,
  neutralize further or report to the operator.
- Codex is STATELESS per `codex exec` — every packet fully self-contained
  (absolute paths, SHAs, gate baselines, report format, "LEAD with a
  status/verdict word"). For a confirming review, the reviewer's OWN
  prior findings are the oracle — re-run the exact attacks.
- Reviews are independent: the agent/tool that implemented may not do the
  final review. The orchestrator did ONE review directly (WP-200-FU2, a
  purely MECHANICAL refactor) when Codex review installs kept
  memory-dying — that is acceptable ONLY for mechanical changes and must
  be disclosed. A real door (pollution semantics) gets an independent
  Codex review, no exceptions.

## 2. SAFETY — non-negotiable, never weaken

`MAX_RUN_MODE=PAPER`, `ALLOW_REAL_ORDERS=false`,
`LIVE_MICRO_MAX_ORDER_NOTIONAL=0`, `LIVE_MICRO_MAX_ACCOUNT_EXPOSURE=0`.
No production wallet/signer/credential/real-order test. Safety-sweep
every candidate diff for these tokens before merging. Never claim soak/
probe/live evidence without real evidence. One write-enabled package per
worktree; never two agents editing the same paths concurrently.

## 3. EXACT CURRENT STATE

- **main is at `cda7119`, clean.** Recent chain (newest first): `cda7119`
  WP-200-FU2 governance ← `af4aacc` merge WP-200-FU2 ← `4b75d81` authorize
  WP-060-FU1 + WP-200-FU2 ← `47832e3` docs round (SETL-2 + UNIV-3).
- **Gate baseline at `cda7119`:** root `pnpm test` **296 files / 6642
  tests**; `pnpm check:deps` 34 packages / 71 edges; `pnpm test:replay`
  6/6; `pnpm test:e2e` 6/75; trader integration 9/110; control-api
  integration 7/76; frozen golden
  `test/replay-golden/paper-e2e/paper-e2e-run.json` sha256
  `dd6893bfa586d345cbc1567b2fa9486ae5c186a1efacf6f054e6271f92263d95`
  (byte-identical through EVERY merge this whole session — a hard
  tripwire; stop-and-report if it ever moves).

- **ONE round is in flight: `WP-060-FU1`** (the event-bus envelope door —
  the last authorized §5-follow-on round). Worktree
  `.claude/worktrees/codex-wp060fu1`, branch `worktree-codex-wp060fu1`,
  **clean at `22ed002`**. Chain: `cda7119` → `16c0072` (candidate) →
  `22ed002` (r1 remediation). node_modules installed.
  - Candidate `16c0072`: an own-data door (`packages/event-bus/src/
    envelope-door.ts`) in front of `validateEnvelope` — rebuilds the
    envelope from own enumerable data, validates the rebuilt copy inside
    exception containment, returns a frozen null-prototype record, and
    re-derives ordering-field formats from the schema's own `_zod.def`.
  - Independent Codex review of `16c0072`: **CHANGES REQUIRED, 2
    blockers.** (B1) the door re-enforced only 4 fields, but an inherited
    `skipChecks` defeats EVERY zod check, so ~13 other fields +
    the source/venue provenance refinement were still fail-open under
    pollution. (B2) the containment's own fallback `EventBusEnvelopeError`
    read an inherited `options.cause` (`"cause" in options`), so a
    throwing inherited `cause` getter escaped as a bare TypeError.
    Everything else verified strongly positive (4 formats clean both
    directions over 1926 values/field; encode bytes byte-identical;
    containment otherwise holds; all mutation detectors catch; test-
    contract changes legitimate).
  - Remediation `22ed002` (Codex): generalized the derivation to all 17
    fields from `_zod.def` (patterns/min/max/int/enum, own-property
    traversal, no hand-copied literals); re-stated the provenance
    refinement (differential 100 cases/state); fixed `errors.ts`
    `"cause" in options` → `Object.hasOwn(options,"cause")`. All 12
    listed fail-open fields now REFUSED both pollution forms; the
    fallback yields EventBusEnvelopeError both forms; encode bytes
    byte-identical (diff 0).
  - **Orchestrator verification of `22ed002` is DONE and GREEN:** scope
    is exactly `packages/event-bus/**` (envelope-codec.ts, envelope-
    door.ts, errors.ts, envelope-boundary.test.ts, envelope-codec.test.ts,
    envelope-fixtures.ts, envelope-remediation.test.ts); safety sweep
    clean; the `errors.ts` diff is the single own-property line; package
    suite **266**; typecheck 0; check:deps 34/71; **root 298/6809**
    (reconciles both ways: base 296/6642 + 2 test files + 167 tests),
    replay 6, e2e 6/75, trader 110, control-api 76, **golden byte-
    identical**.

## 4. IMMEDIATE NEXT STEP

Run the **confirming review** of `22ed002`. The packet is already written
at:
`/tmp/claude-1000/-home-adriancova-proyects-tradeBot-polymarket-bot/083749fa-1d4c-4735-b241-48f81129d71c/scratchpad/wp060fu1-confirm.txt`
(if that scratch path is gone in the new session, the packet's content is
summarized here: it makes the SAME reviewer re-run its own two blockers as
the oracle — every listed fail-open field must now refuse under both
pollution forms plus a full-field sweep; the throwing-`cause` fallback
must yield EventBusEnvelopeError; NO regression on the 4 original formats,
honest-not-stricter over an honest corpus, provenance both directions,
encode byte-identity, honest-refusal preservation; derivation reads own-
props only and fails closed on schema drift; all mutation detectors incl.
a new provenance-accept-all mutant still catch; scope/safety). Dispatch:
```
cd /tmp && codex exec --skip-git-repo-check -m gpt-6-astra --sandbox workspace-write "$(cat <that packet path>)" &   # run_in_background
```
On **CONFIRMED ACCEPT**: merge `22ed002` into main `--no-ff` under the
standing delegation (write the merge message to a scratch file, `git merge
--no-ff 22ed002 -F <file>`); run post-merge gates on main (root should be
298/6809, golden byte-identical); flip the `WP-060-FU1` row in
`IMPLEMENTATION_STATUS.md` to Complete (rows are long — use a python
heredoc with `lines[i]=...` and an `assert old.startswith(...)` guard, the
pattern used all session); write `docs/handoffs/WP-060-FU1.md` (merge
chain, the review arc incl. the 2 blockers → remediation → confirm,
residuals with owners); commit governance with `git commit -F`; remove the
worktree + branch. If **CHANGES STILL REQUIRED**: route the surviving
finding back to Codex in the same worktree (one more remediation commit),
re-verify, re-confirm.

Then a **docs round** (Codex-confirmed, the established pattern): flip the
`docs/contracts/schema-boundary.md` §3 `packages/event-bus` row from LIVE
to CLOSED-for-the-measured-class (it is one of the three remaining
fully-LIVE packages: `packages/{domain,event-bus,order-book}`), update the
tally (event-bus LIVE→CLOSED makes it 2 LIVE / 13 CLOSED / 5 outside —
recount from the table, do not trust this arithmetic blindly), and record
the residuals. Have Codex confirm the docs edit (read-only `codex exec`),
apply any correction verbatim, second pass CONFIRMED, then commit.

## 5. DEFERRED OWNER QUEUE (after WP-060-FU1 closes — pick with the operator)

- **`packages/order-book`** — the last fully-LIVE package with no bounded
  grant yet (`packages/{domain}` and the order-book row remain LIVE).
- **The universe direct-export caller-input round** (UNIV-3 residual):
  `applyMarketLifecycleEvent`'s DIRECT export dot-reads
  `input.eventType`/`input.payload` (base-identical; the registry path is
  doored); nested hand-built projection values by reference.
- **SETL-2 follow-up hardening** (ordering-pin comparison-case ambiguity;
  `nonTerminalDetails` catch value; the two `Array.prototype.includes`
  value gates); the `SettlementResult` envelope D4 (errors.ts follow-up);
  the settlement spec multi-read → the spec-door line.
- **CLOB-1 follow-up test hardening** (F4/F5) + the opportunistic
  `settlementSpecId` corpus value (SETL owed).
- **ADR-020 governance**: the D2/severed-arena question and the
  near-parallel-door consolidation — now SIX+ in-package door surfaces in
  settlement, four in universe; the permanent cold-`discriminatedUnion`
  poisoning class (measured in 4+ boundaries).
- Ledger/pnl further rounds are DONE (WP-200-FU2). The
  `isFreshOrdinaryContainer` widening (WP-180-FU3 f/u 2) with the four
  arena consumers; the five-identity-fields decision (trader local `Uuid`
  + approved-intent.ts:192); the strategy-runtime `modelOutputs` split
  collapse; apps/control-api WP-240 D6 `z.literal(null)` retirement + the
  next control-api round; the comment-staleness round; the detector/
  tooling round (deliberately last); operator-only WP-140 soak evidence
  (never claim without real evidence).

## 6. MECHANICS QUICK-REFERENCE

- Gates STRICTLY SEQUENTIAL (never concurrent — memory), cd with absolute
  paths. Package suites: `cd packages/<pkg> && npx vitest run`. Root:
  `pnpm test`. `pnpm test:replay`, `pnpm test:e2e`, `pnpm typecheck`,
  `pnpm check:deps`. Integration: `cd apps/trader && pnpm run
  test:integration` (9/110); same for `apps/control-api` (7/76). Always
  reconcile a test-count delta BOTH ways.
- Reproduce every gate at the tip before merge; reproduce post-merge on
  main. The golden sha256 is the tripwire — verify it every time.
- Commit attribution (CURRENT — changed mid-session): end commit messages
  with
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01RhaPCmUK4d368qAyn9e78j`.
  (Earlier session commits say "Claude Fable 5" — do not "fix" those.)
- Frozen docs get append-only dated addenda, never silent rewrites; the
  `schema-boundary.md` tally recount history is preserved verbatim (a
  Codex pass caught a reworded prior entry — restore verbatim if flagged).

## Session accomplishment summary (context, not to-do)

This session closed, in order: WP-160-FU1, WP-180-FU3, REC-1, ALLOC-1,
TRDR-1 (ADR-021 discharged), UNIV-1, SETL-1, CLOB-1, UNIV-2, SETL-2,
UNIV-3, WP-200-FU2 — each merged with a completion record and governance
flip, plus multiple Codex-confirmed docs rounds. The §3 audit table went
from nine LIVE packages to three fully-LIVE + everything else CLOSED for
its measured class. WP-060-FU1 is the final in-flight round; on its merge
the GOV-2A §5 retrofit programme and its immediate follow-ons are
complete, leaving only the §6 owner queue above.
