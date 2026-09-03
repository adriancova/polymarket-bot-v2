# GOV-1D — contract-owner governance round: resolving C-2 (USDC vs pUSD)

- **Package:** `GOV-1D`, an orchestrator-authorized bounded governance package
  (the mechanism is `docs/contracts/protected-contracts.md` §3.1 on the
  `GOV-1B`/`GOV-1C` precedent, now recorded as a §5 precedent row of its own).
- **Base:** `fdf78e6` — `main` tip at dispatch. Verified with
  `git log --oneline -1` before editing.
- **Branch:** `worktree-agent-a46e703b5804f33c2`, isolated worktree.
- **Date:** 2026-09-03.
- **Review:** independent adversarial review is required before merge. The
  implementing agent did not review its own work (`AGENTS.md`). **This round is
  not marked complete.**
- **Scope discipline:** this round has **one job** — discharge ADR-006 §7 item
  4 by resolving register item C-2 against then-current official documentation
  and recording the resolution as a dated amendment. It **rules**; it does not
  implement. **Documentation-only: no runtime behavior changed and no code
  changed.** Not one path under `packages/**`, `apps/**`, `test/**`, `db/**`,
  `tools/**`, any `package.json`, or `pnpm-lock.yaml` was touched — unlike
  `GOV-1C`, this round took **no** non-documentation exception at all.

---

## Why this round exists

`WP-200`'s adversarial review returned a HIGH finding: ADR-006 §7 item 4
("**`WP-200` and the fee/reward accounting work must resolve C-2 against
then-current official documentation before implementation**, and record the
resolution as an amendment here") is an unsatisfied prerequisite blocking
`WP-200`'s closure.

`WP-200`'s implementer **refused to discharge it and escalated** — the right
call, and worth recording as the precedent it is. Its `deviations` 3, verbatim
in substance: resolving C-2 requires fetching current official Polymarket pages
(no network use was permitted there, and inventing a venue fact is forbidden)
and recording the amendment requires editing `docs/adr/**`, outside that
package's `allowed_paths`. It obeyed §7 items 1–3 instead, so that a later
resolution would be a pure addition, and raised the item as `follow_up` 1.

This round is the authorized discharge. `WP-200` is in remediation on its own
branch; **no package code was read for edit and none was touched**. (Its
handoff was read **read-only** via `git show wp-200-remediation-round1:docs/
handoffs/WP-200.md`, because that file does not exist on this round's base.)

---

## The evidence

### Fetches — my own, independently re-performed

The dispatch supplied an orchestrator evidence note and instructed me to
**re-fetch independently rather than rely on it**. I did. Four read-only,
unauthenticated `curl -sS -L` GETs of public documentation pages on
**2026-09-03**, 03:15:06–03:15:41 UTC. No credential, no API key, no
authenticated endpoint, no order, no socket.

| # | URL | HTTP | Bytes | Redirects | Fetched (UTC) | SHA-256 |
| --- | --- | --- | --- | --- | --- | --- |
| F1 | `https://docs.polymarket.com/trading/fees.md` | 200 | 8 128 | 0 | 03:15:14Z | `8e246189f6ca85b8b8782e1d76a769cf98672a98c4c63d8bbe6150d659db8d7c` |
| F2 | `https://docs.polymarket.com/programs/maker-rebates.md` | 200 | 5 945 | 0 | 03:15:27Z | `8d2c6562bd1b3376bc3fc1557a60efef5aa3c1d856c7f8dcc405139a07e9ba2a` |
| F3 | `https://docs.polymarket.com/programs/taker-rebates.md` | 200 | 7 769 | 0 | 03:15:35Z | `4781bad02aacd3a7599ddb31381eb4fc9cb4bd8f783701ac62ffbf1fc364af34` |
| F4 | `https://docs.polymarket.com/programs/liquidity-rewards.md` | 200 | 7 191 | 0 | 03:15:41Z | `27e11fc522c0aa9ee586e838add32b176a27ec5e216a7d18f27a2298e62efc63` |

**All four pages were reachable.** No page in scope was unretrievable, so the
"say so explicitly rather than falling back silently" case did not arise.

**Comparison against the orchestrator's recorded fetches — reported honestly:**

- **HTTP status, byte count, and SHA-256 prefix agree for all four pages.** Two
  independent retrievals of the same four URLs on the same date returned
  byte-identical bodies. No content drift.
- **One discrepancy, and it is a counting-method difference, not drift.** The
  orchestrator's note tallies "11 / 7 / 7 / 0" under the heading "occurrence
  counts". Those are **matching-line** counts. The true occurrence counts are
  **12 / 9 / 7 / 0**: F1 line 45 carries `USDC` twice, and F2 lines 30 and 98
  carry `pUSD` twice each. Since the bodies are byte-identical, this is a
  labelling imprecision in the tally rather than a fact in dispute. Both
  figures are recorded in `docs/venue/verified-2026-09-03.md` §2 so either can
  be re-derived. I flag it because the packet asked me to report drift rather
  than assume agreement, and because a reviewer re-running `grep -c` will
  reproduce the orchestrator's numbers, not mine.

### What the pages say

Full verbatim quotes are in `docs/venue/verified-2026-09-03.md` §3. The load-
bearing findings:

1. **The inconsistency persists in current documentation** — it is not an
   artifact of the frozen 2026-08-24 snapshot. Fees page: USDC only. Both
   rebate pages: pUSD only.
2. **Its shape is a documentation-copy artifact.** The fees page's and the
   maker-rebates page's sentences are identical **except for the token name**
   ("Taker fees are calculated in USDC/pUSD … The fee amount in USDC/pUSD is
   symmetric around 50% probability — a trade at 30¢ incurs the same dollar fee
   as a trade at 70¢"), as are their precision sentences (same `0.00001`
   magnitude, same 5-decimal rule), and the formula is the same expression.
3. **Three corroborations I added beyond the dispatch's evidence note**, each
   independently checkable against the digested bodies:
   - the rebate page says in its own words that rebates use "the **same formula
     as taker fees**";
   - it **defers to the fees page for the numeric tables** ("For detailed fee
     tables for each market category, see the [Fees](/trading/fees) page") —
     the pUSD page sends the reader to the USDC page for the same tables;
   - **both pages embed the identical fee-curve chart asset**
     (`id="datawrapper-chart-dJ74e"`, same `src`), byte-for-byte the same embed
     line on the USDC page and the pUSD page.
4. **No page asserts an equivalence.** Searched for `convert`, `equivalen`,
   `1:1`, `one-to-one`, `peg`, `wrap`, `bridge`, `same token/asset/currency`:
   **no assertion relating USDC to pUSD**, no conversion rate or mechanism, no
   linking contract address. The only "equivalent" strings are the rebate
   formula's `fee_equivalent`/`total_fee_equivalent` scoring weights.
5. **A drift the dispatch's evidence note did not draw out** (see
   `deviations` 2): `programs/liquidity-rewards.md` contains **zero**
   occurrences of the substring `usd` in any case. It names **no settlement
   token at all** — "The minimum reward payout is **\$1**". The frozen report
   §11 characterizes C-2 as covering the "maker-rebates, taker-rebates, and
   **liquidity-rewards** pages [denominating] payouts in pUSD"; that is no
   longer true of the third page.

---

## The ruling

**C-2 is RESOLVED as a documentation inconsistency that does NOT authorize
folding the two denominations.** I reached this independently from the fetched
evidence; it agrees with the dispatch's proposed reading, and the one place my
reading goes further is finding 5 / ruling 5 below.

1. **C-2 is a documentation inconsistency, not an economic one.** One quantity,
   two names, identical arithmetic and rounding floor.
2. **That does not make them one asset, and the ADR does not rule that they
   are.** A shared magnitude is not an asserted identity of the underlying
   token. Finding 4 is decisive: inferring an on-chain equivalence from prose
   parallelism would be inventing venue behavior (`AGENTS.md`).
3. **§7 item 2 stands unchanged: distinct asset identifiers remain mandatory.**
   No summing, netting, or substitution across them; any conversion is an
   explicit recorded ledger transaction with its own evidence — evidence this
   round looked for and did not find.
4. **§7 item 3 stands unchanged, and the discharge sharpens it.** A fee derived
   from `trading/fees.md` is recorded in **USDC**; a maker or taker rebate
   derived from `programs/*-rebates.md` is recorded in **pUSD**; the source
   page and its retrieval date travel with the entry (§9.13).
5. **Liquidity rewards have no source-asserted denomination, and none may be
   assumed.** This is the one obligation the discharge *adds* rather than
   ratifying. A reward-schedule snapshot from that page records its
   denomination as **not asserted by the source**; it may **not** default to
   pUSD because the sibling programs do. §6's existing rule supplies the safe
   path — only an **observed payout** creates a `REWARD_INCOME` entry, and the
   observation carries the asset actually received. If an observed payout's
   asset cannot be determined, the correct outcome is the one §3 and §9.15
   already mandate: `UNATTRIBUTED` and a halt of the affected market, **not** a
   guessed denomination.

**`WP-200`'s shipped behavior is ratified as conforming** and no code changed.

**What the ruling does NOT do** (stated in the amendment itself, so no later
reader can borrow more from it than it says): it does not assert USDC and pUSD
are the same on-chain asset *nor that they are different* — it records that no
fetched page says either; it does not authorize folding, collapsing to a single
"cash" asset, or an implicit conversion; it does not state a conversion rate;
it does not change §7 items 1–3 or any other section; it changes no run-mode
default; and it claims nothing observational.

**Reopen condition:** any venue assertion of equivalence or conversion — a page
stating the two are the same asset, a conversion rate or mechanism, a linking
contract address, or documentation of the funding path from deposited USDC into
pUSD collateral. Such evidence authorizes modeling an **explicit recorded
conversion transaction** under item 2, **never a fold**, and requires a
superseding amendment stating how historical entries in the two denominations
are read. A narrower trigger: if the venue names a settlement token for
liquidity rewards, ruling 5's "not asserted by the source" lapses for that
program.

---

## The bounded venue-fetch exception (third use), walked

`docs/adr/README.md`'s exception is bounded by four conditions. The amendment
walks all four in its own text; in brief:

1. **Handoff §1.1 ranks current official documentation above the in-repo
   report**, so the ADR asserts nothing on its own authority — and where the
   current pages contradict the frozen report (finding 5), they control by that
   same rule.
2. **URL, retrieval date, and verbatim quotes are carried**, with documentary
   confirmation distinguished from observation. Every finding is documentary
   and labelled so; status, bytes, and SHA-256 per fetch let a reviewer
   re-fetch and diff.
3. **The frozen report is still cited** for the item's origin and prior status
   (`verified-2026-08-24.md` §6, §11 C-2) **and is not edited**. Finding 5's
   drift is recorded beside it, not written into it.
4. **The gap is still recorded.** All four pages are already in the frozen
   report's §14 source index, so no new source-index debt is incurred; the
   debts that *are* incurred are enumerated in `verified-2026-09-03.md` §5.

**One honest note on fit, flagged for the reviewer** (also stated in the
amendment and in the README sentence): the exception's text describes "a venue
fact that **a work package's own mandated** verification obtained". Here the
mandate is ADR-006 §7 item 4 and it named `WP-200`, whose grant made both the
fetch and the amendment impossible; the contract owner executed the same
mandate in its place. The shape is otherwise identical to the first two uses
(ADR-013 §7; ADR-009 §5's 2026-09-02 amendment) — a *ratifying* record of a
*mandated* verification, not an ADR fetching a fact it merely wanted. See
`deviations` 1.

---

## summary

Discharged ADR-006 §7 item 4 — the unsatisfied prerequisite blocking `WP-200`'s
closure — by independently re-fetching the four official pages that constitute
register item **C-2** and ruling on what they say. **C-2 is RESOLVED as a
documentation inconsistency (a documentation-copy artifact: the same quantity,
formula, and `0.00001` rounding floor described under two names) that does NOT
authorize folding the denominations**, because no fetched page asserts an
equivalence, a conversion, or a linking contract address. Distinct asset
identifiers remain mandatory (§7 item 2 unchanged); a conversion must be an
explicit recorded ledger transaction with its own evidence; each entry is
denominated in the unit its source asserts (§7 item 3 unchanged), with the
source recorded alongside. `WP-200`'s shipped behavior is ratified as
conforming.

One drift was found and disclosed rather than smoothed over: the
liquidity-rewards page now names **no** settlement token, narrowing C-2's live
scope and creating a **new fail-closed obligation** — that program has no
source-asserted denomination and may not default to pUSD.

Recorded as a dated amendment in ADR-006 §7 (original decision text unedited),
a CLOSED C-2 register row, a new dated bounded venue report, the README
bounded-exception third-use sentence, a §5 precedent row, and this handoff.

**No runtime behavior changed; no code changed; no `schemaVersion` moved; no
safety default was touched** (diff swept — see `tests_run`).

## files_changed

**New (2):**

| File | Purpose |
| --- | --- |
| `docs/venue/verified-2026-09-03.md` | The bounded dated report: four fetches with status/bytes/SHA-256/date, verbatim quotes, the occurrence-count reconciliation, the liquidity-rewards drift, and the gaps owed |
| `docs/handoffs/GOV-1D.md` | this record |

**Modified (3):**

| File | Change |
| --- | --- |
| `docs/adr/ADR-006-actual-ledger-versus-virtual-allocation.md` | header `Amendments:` line; a dated 2026-09-03 amendment block appended at the end of §7 (the original §7 text, including items 1–4 and the "What *is* verified" paragraph, is **unedited**) |
| `docs/adr/README.md` | the bounded-exception use-count sentence extended to record the third use and its imperfect fit; the ADR-006 index row annotated with the amendment |
| `docs/contracts/protected-contracts.md` | §8 **C-2** row rewritten as **CLOSED** on the C-1/U-1 and U-6 pattern; new §5 precedent row for this round |

**Not touched** (verified by `git status` and `git diff --name-only fdf78e6`):
every path under `packages/**`, `apps/**`, `test/**`, `db/**`, `tools/**`,
`.github/**`; every `package.json`; `pnpm-lock.yaml`; root configs;
`IMPLEMENTATION_STATUS.md`; the workplan; and **both frozen venue reports**
(`verified-2026-08-24.md`, `verified-2026-09-02.md`) — cited, never edited. No
sibling remediation's paths (`WP-170`, `WP-180`, `WP-200`) were touched.

## tests_run

| Gate | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | **exit 0**; `git diff --stat pnpm-lock.yaml` empty — lockfile untouched |
| `pnpm typecheck` | **exit 0** |
| `pnpm lint` | **exit 0** |
| `pnpm check:deps` | **exit 0 — PASS, 34 packages, 26 declared workspace edges**, allowlist S0/S1/S2 (the dispatch-required counts) |
| `pnpm test` (baseline, pre-edit, this worktree at `fdf78e6`) | **130 files / 3536 tests passed** — equal to the dispatch-required main counts |
| `pnpm test` (after all edits) | **130 files / 3536 tests passed** — counts **exactly unchanged**; no test file changed |
| `pnpm ops:verify-venue` | **exit 0** (the tool pins `docs/venue/verified-2026-08-24.md`; the new dated report does not and must not affect it) |
| Path sweep | `git diff --name-only fdf78e6` = exactly the three modified docs; the sole untracked file is the new report. Zero hits under `packages/**`, `apps/**`, `test/**`, `pnpm-lock.yaml`, any `package.json` |
| Frozen-report sweep | `git diff --name-only fdf78e6 -- docs/venue/` is **empty** — neither frozen report was edited |
| Safety sweep | all four edited/new files grepped for `MAX_RUN_MODE`, `ALLOW_REAL_ORDERS`, `LIVE_MICRO_MAX_ORDER_NOTIONAL`, `LIVE_MICRO_MAX_ACCOUNT_EXPOSURE` — **zero hits**. A broader sweep for live-enablement terms across the new report returns exactly one hit: its own negative attestation ("no credential, no API key, no authenticated endpoint"). No safety default is stated, restated, or weakened by any edit of this round |

**Not run and not claimed:** `pnpm test:compose`, `pnpm audit` (no dependency
changed), any soak, execution probe, live gate, or observational venue claim.
Network access was exactly the four read-only, unauthenticated documentation
GETs recorded above.

## assumptions

1. `IMPLEMENTATION_STATUS.md` is orchestrator-owned; this round records its
   ruling in the ADR, the register, the venue report, and this handoff, and
   leaves that file alone (including the `GOV-1D` row and the C-2 closure
   note).
2. The dispatch's single item is the whole scope. **No other open register item
   was ruled on** — C-3, U-2…U-5, U-7, U-9, U-10, U-11, U-12, R-1, R-2 and the
   two "added review round 1" rows are all untouched, as are ADR-006 §§1–6 and
   §§8–9.
3. "The GOV-1B evidence standard" for fetches is read as `GOV-1C` read it: the
   exact command shape, HTTP status, byte count, and date per fetch, with body
   SHA-256 added so an adversarial reviewer can re-fetch and diff.
4. The dispatch's "34 packages / 26 edges" and "130 files / 3536 tests" were
   verified against the clean base **before** editing (both held), so the
   post-edit runs prove the edits changed nothing rather than merely matching a
   stale expectation.
5. Adding a §5 precedent row is treated as in-scope: `protected-contracts.md`
   is an authorized path, §5 states that "ratification is a **precedent**, not
   a one-off", and `GOV-1B`/`GOV-1C` each recorded their own row. See
   `deviations` 3.
6. The `.md` served-source form of each page is treated as the same document as
   the rendered URL the frozen report §14 indexes. The rendered pages were not
   separately fetched.

## deviations

1. **The bounded venue-fetch exception is used by the contract owner in a
   package's place, which is a hair outside its literal wording. Disclosed as
   this round's most reviewer-relevant judgement call.** The exception covers
   "a venue fact that **a work package's own mandated** verification obtained".
   The mandate here (ADR-006 §7 item 4) named `WP-200`, which could not execute
   it. The alternatives were: leave item 4 permanently undischargeable and
   `WP-200` permanently blocked; or let `WP-200` discharge it by assumption,
   which is exactly the invention `AGENTS.md` forbids and which its implementer
   rightly refused. I took the third course — the contract owner performs the
   mandated verification and records it — and wrote the imperfect fit into both
   the amendment and the README sentence rather than papering over it. **The
   reviewer should judge whether this was right**; the two rejected
   alternatives are named here and in the amendment.
2. **The ruling goes beyond the dispatch's proposed reading on liquidity
   rewards, because the evidence required it.** The dispatch's suggested
   consequence read "a rebate derived from `programs/*-rebates.md` is recorded
   in pUSD". That is correct for the two rebate pages but **wrong for
   liquidity rewards**, whose current page asserts no unit at all. Recording
   pUSD there would have been precisely the invented venue fact the packet
   forbids. So ruling 5 adds a fail-closed obligation the dispatch did not
   anticipate, and the amendment states it as an obligation on the fee/reward
   accounting work rather than a footnote. This also means **ADR-006's Evidence
   phrase "each in pUSD" is no longer supported for that program**; per
   `protected-contracts.md` §4 the amendment is the correction-of-fact note,
   and the original snapshot text is left unedited.
3. **`protected-contracts.md` gained a §5 precedent row in addition to the C-2
   row.** Deliverable 2 names only the C-2 row. The §5 row follows the
   `GOV-1B`/`GOV-1C` pattern exactly and the file is an authorized path, but it
   is an addition to the literal deliverable and is therefore **severable**
   without affecting the ruling.
4. **`docs/adr/README.md` gained an index-row annotation as well as the
   use-count sentence.** The grant permits the README "only if the
   bounded-exception use count sentence needs updating" — it did, and I also
   annotated the ADR-006 index row (the `ADR-016` precedent from `GOV-1C`) so
   the amendment is discoverable from the index. **Severable**; the use-count
   sentence is the load-bearing half.
5. **`docs/handoffs/WP-200.md` was read from another branch.** It does not
   exist on this round's base, so it was read **read-only** via `git show
   wp-200-remediation-round1:docs/handoffs/WP-200.md`. Nothing on that branch
   or in that worktree was written, and no `WP-200` path appears in this
   round's diff.
6. **The occurrence-count discrepancy with the orchestrator's note is reported
   rather than reconciled silently** (12/9/7/0 occurrences vs 11/7/7/0
   matching lines). The bodies are byte-identical, so nothing turns on it, but
   the packet asked for honest drift reporting and a reviewer re-running the
   orchestrator's command will see the orchestrator's numbers.

## known_risks

1. **The "documentation-copy artifact" characterization is an inference about
   *why* the docs disagree, not a venue fact.** It is well-supported (identical
   prose, formula, floor, chart asset, and an explicit cross-reference), but it
   remains a reading of documentation. The ruling is deliberately built so that
   **nothing depends on the inference being right**: the binding half is that
   the denominations stay distinct, which holds whether the divergence is a
   copy artifact or two genuinely different tokens. A reviewer who rejects the
   characterization should still reach the same operative rules.
2. **The conservative ruling has a real cost, and it is the cost ADR-006 §7's
   Consequences already named.** Fee and reward entries cannot be summed with
   collateral balances without an explicit conversion that does not yet exist.
   If USDC and pUSD *are* in fact the same asset, the ledger carries two ids
   for one thing until the venue says so. That is the deliberate trade: a
   wrong fold silently corrupts monetary truth, while a wrong split is visible
   and reversible.
3. **Ruling 5 will bite the first liquidity-reward payout.** By design — the
   `UNATTRIBUTED` + halt path is §3's designed sensitivity — but an operator
   meeting it without reading this amendment will experience it as a defect.
   The register row and the amendment both state the intended response
   (model the source, do not widen the tolerance).
4. **The fetched pages are volatile and the ruling is dated.** `verified-2026-
   09-03.md` re-verifies only C-2's **denomination language** and the fee
   formula/precision sentences it rests on; it explicitly must not be cited for
   fee rates, rebate percentages, tier thresholds, category weights, or reward
   allocations, even though those strings appear in the digested bodies.
5. **The liquidity-rewards page carries a possibly-lapsed seasonal promotion**
   (a "\$1M" allocation block scoped "through the month of August"). The report
   notes it and makes **no** claim about whether it is still funded; a reader
   who mistakes those tables for current parameters would over-claim.
6. **Two bounded venue re-issues now exist (2026-09-02, 2026-09-03) and neither
   discharges the §1.2 phase gate.** The new report says so explicitly, but the
   accumulation of bounded reports raises the chance a future reader treats
   them as a full round. They do not compose.
7. **This round ruled on an implementation it could not modify or test.**
   `WP-200`'s conformance to §7 items 1–3 is established by reading its
   handoff, not by executing its code — its branch is in flight and its paths
   are forbidden here. The ratification statement should be re-checked against
   `WP-200`'s final merged state.

## follow_up

1. **`WP-200` / the fee/reward accounting work:** apply the ruling — per-source
   denomination with the source recorded (USDC for fees, pUSD for maker/taker
   rebates), and **no default unit for liquidity rewards** (ruling 5). The
   blocking prerequisite is now discharged; `WP-200`'s `follow_up` 1 can be
   retired against this amendment.
2. **Next full venue-verification round (phase-3 start gate):** the two gaps in
   `verified-2026-09-03.md` §5 — whether the venue names a settlement token for
   liquidity rewards, and **the funding path from deposited USDC to pUSD
   collateral**, which is the single most likely place a real relationship
   between the two would be stated and is exactly the evidence §7 item 2
   requires before any conversion may be modeled. The `verified-2026-09-02.md`
   §7 gaps carry forward unpaid.
3. **Whoever models a USDC↔pUSD conversion, if evidence ever appears:** it is
   an explicit recorded ledger transaction plus a superseding ADR-006
   amendment stating how historical entries in both denominations are read —
   never a fold, and never a type-level equality.
4. **Orchestrator:** record this round in `IMPLEMENTATION_STATUS.md` (C-2
   closed; the ADR-006 amendment; the §5 precedent row; the new dated report;
   `WP-200`'s HIGH finding discharged) and re-check the `WP-200` conformance
   ratification (`known_risks` 7) against its final merged state.
5. **Any future round citing the bounded venue-fetch exception:** read
   `deviations` 1 first — the third use stretched "a work package's own
   mandated verification" to cover a contract owner acting in that package's
   place. If the reviewer accepts it, the README sentence is the precedent; if
   not, the exception's wording needs amending rather than re-stretching.

## commit_sha

Two commits on branch `worktree-agent-a46e703b5804f33c2`, both based on
`fdf78e6`: the implementation commit (the amendment, the register, the venue
report, and this handoff), then a SHA-record commit that writes the
implementation SHA into this table — a commit cannot contain its own hash.

| Commit | SHA |
| --- | --- |
| governance round (ADR-006 §7 amendment, README, C-2 register row + §5 precedent, `verified-2026-09-03.md`, this handoff) | *(written by the SHA-record commit below)* |
| SHA record (branch tip) | reported in the agent's reply |

**The branch tip is the commit to review.** This round is **not** marked
complete: a strict adversarial review follows, and it should re-fetch the four
URLs and re-read the quotes.
