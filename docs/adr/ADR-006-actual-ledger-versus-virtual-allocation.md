# ADR-006: Actual ledger versus virtual allocation

- **Status:** Accepted
- **Date:** 2026-08-26
- **Recorded by:** `WP-030`
- **Implemented by:** `WP-040` (schemas and constraints), `WP-200` (ledger,
  allocations, projections, PnL) — **not yet implemented**
- **Supersedes / Superseded by:** none
- **Amendments:** 2026-09-03 (`GOV-1D`) — §7 gains a dated block discharging
  its own **item 4**: C-2 (USDC vs pUSD) is **RESOLVED as a documentation
  inconsistency**, on four independently re-fetched official pages. The
  resolution does **not** authorize folding the two denominations; §7 items
  1–3 are unchanged and binding, and distinct asset identifiers remain
  mandatory. The original §7 text is unedited; the register row is
  `docs/contracts/protected-contracts.md` §8 **C-2**, and the fetch evidence is
  `docs/venue/verified-2026-09-03.md`. The amendment also records one drift the
  re-fetch found: the liquidity-rewards page now names **no** settlement token,
  so the Evidence section's phrase "each in pUSD" is no longer supported for
  that program.

## Context

Handoff §2 locks the accounting model: "Append-only event ledger; actual wallet
state separated from virtual strategy attribution." Handoff §6 invariant 7 makes
the separation an invariant with a hard consequence — "Unexplained activity goes
to `UNATTRIBUTED` and halts the affected market" — and invariant 8 makes every
projection rebuildable from append-only events. Handoff §1.3 makes "changing the
ledger source of truth" an ADR-gated change. Handoff §9.15 gives the model.

Two forces make this non-optional. First, the venue nets at the account level:
one wallet, one signer, one balance, one inventory per outcome token (venue
report §10.2). Any per-strategy view is therefore a **derived attribution**, not
a fact the venue can confirm. Second, real money moves for reasons the trader did
not cause — a manual transfer, a reward payout, a wallet operation from another
tool — and a system that silently absorbs those into strategy PnL is lying.

## Decision

### 1. The append-only ledger is the monetary source of truth

- Model: `ledger_transactions` + `ledger_entries` (§9.15, §10.5).
- **Every ledger transaction balances to zero per asset**, using explicit
  external-clearing accounts (§9.15, §10.7). Assets include pUSD **and each
  outcome token ID** — an outcome token is an asset, not a quantity annotation on
  a cash entry.
- The tables are append-only. Updates are forbidden except on explicitly mutable
  projections (§10.7).
- **Projections are not truth.** `actual_position_projection`,
  `virtual_position_projection`, `balance_projection`, and `pnl_snapshots` are
  rebuildable views (§6 invariant 8, §10.5). A rebuild from zero must equal the
  incremental state (work-plan `WP-200` acceptance).
- **Redis is never monetary truth** (§2). It holds streams, kill-switch state,
  health leases, and fencing.

### 2. Scopes, and the meaning of each

The §9.15 scopes are fixed:

| Scope | Meaning |
| --- | --- |
| `ACTUAL_ACCOUNT` | What the wallet/venue actually holds. Reconcilable against venue truth. |
| `VIRTUAL_STRATEGY` | Attribution of actual holdings to a strategy instance. Never independently spendable. |
| `UNATTRIBUTED` | Actual activity with no attribution. **Always an incident.** |
| `EXTERNAL_CLEARING` | The counter-account that lets a one-sided real-world movement balance to zero per asset. |
| `FEE_EXPENSE` | Fees paid. |
| `REWARD_INCOME` | Rewards and rebates actually received. |

**Virtual allocation never creates or destroys value.** The sum of
`VIRTUAL_STRATEGY` plus `UNATTRIBUTED` holdings for an asset equals the
`ACTUAL_ACCOUNT` holding for that asset. Attribution is a partition of a real
balance, never a parallel balance.

### 3. Unattributed activity halts the affected market

Any actual balance change lacking attribution is allocated to `UNATTRIBUTED`
**and the affected market is halted** (§6 invariant 7, §9.15). This is not a
warning-level event: it is a paging alert (§14.4 "Unattributed actual position")
and an incident-controller action (§9.9).

The system does **not** guess an attribution to keep trading. Handoff §2's
fail-safe applies: "Halt entries, cancel orders, reconcile, then manage known
positions; never blindly flatten on unknown state."

### 4. Fill allocation

- Every fill allocation sum equals the actual fill quantity (§10.7); allocations
  can never exceed the fill (§16.2).
- **Exit quantity comes from confirmed actual allocation, never from requested
  entry size** (§6 invariant 10). Partial fills are first-class.
- Attribution is many-to-many between intents and orders (`execution.intent_order_links`,
  §10.4), because one order may serve more than one intent and one intent may be
  sliced across orders (§9.10).

### 5. Recognition points and settlement state

**Order state and settlement state are separate** (§6 invariant 5): a match is
not confirmed on-chain settlement.

Venue-grounded: an accepted order response may precede settlement transaction
hashes, and the SDK's `TradeStatus` enumerates six states —
`MATCHED_NOT_BROADCASTED`, `MATCHED`, `MINED`, `CONFIRMED` (terminal success),
`RETRYING`, `FAILED` (terminal failure) (venue report §4). A `delayed` order
response is explicitly "a pending order rather than a fill", with zero
making/taking amounts and empty trade ids (venue report §2.2, verbatim).

Decision:

1. Trade principal and outcome-token movement are recognized from the venue's
   authoritative trade record, and **the settlement state is carried on the
   ledger transaction**.
2. A settlement that reaches `FAILED` produces a **compensating append-only
   reversal**, never an edit or a delete of the original entries (§10.7).
3. A `delayed` order response never produces a fill entry.
4. `MATCHED_NOT_BROADCASTED` is treated per ADR-007 (REST-only per SDK source
   precedence, **pending `WP-280` re-check** — venue report §11 conflict C-3).

### 6. Fees, rebates, and rewards

- **Core strategy PnL excludes discretionary rewards.** Realized rebates and
  rewards are reported separately and may be added to an all-in PnL figure
  (§6 invariant 14, §9.16).
- **Reward estimates are never booked as realized** (§9.16). An estimate is
  analytics; only an observed payout creates a `REWARD_INCOME` entry
  (`reward_estimates` and `reward_payouts` are separate tables, §10.5).
- Fee and reward schedules are **versioned per market where available** (§9.16,
  §6 invariant 9) and are configuration snapshots with a source and an effective
  time (§9.13). They are never hardcoded.

Venue grounding, all as of the verification date and all volatile:

- Fees are **taker-only**: `fee = C × feeRate × p × (1 − p)`, symmetric around
  `p = 0.5`, rounded to 5 decimal places, minimum charged fee `0.00001`; makers
  pay no fees; taker `feeRate` for Crypto was `0.07` (venue report §6).
- The three incentive programs are **not** one mechanism, and each is stated here
  only as far as the report supports it (venue report §6):
  - **Maker rebates** are **pool-shared**: funded from taker fees, with payout
    `(your_fee_equivalent / total_fee_equivalent) × rebate_pool` per market,
    distributed **daily at midnight UTC** in pUSD, minimum `$1` pUSD accrual.
  - **Taker rebates** are **tiered**, not pool-shared: the rebate percentage
    follows a tier of 30-day weighted volume `wV` (Bronze `$2k`/3% through
    Obsidian `$10M+`/50%), with a **daily** pUSD payout, `$1` minimum, and no
    backfill. The report states the payout is daily; it does **not** state a
    midnight-UTC settlement time for this program, and none is assumed here.
  - **Liquidity rewards** are **daily midnight-UTC** payouts to maker addresses,
    `$1` minimum, scored from one-minute samples (10,080 per weekly epoch) by the
    quadratic score `S(v,s) = ((v − s)/v)² · b` — a score accumulated over a
    period, not a credit attached to a fill.

  The property this ADR depends on is the one all three share: each is computed
  over a **period** from **aggregate** activity and paid on a **daily cycle**, so
  none is attributable to a single fill at fill time. That is exactly why an
  estimate may not be booked as realized, and why a simulator may not credit a
  rebate per simulated fill (ADR-012).

### 7. The USDC / pUSD denomination question is UNRESOLVED

The official pages disagree in denomination language: the fees page states
trading fees are "calculated in USDC" with a minimum charged fee of
"0.00001 USDC", while the maker-rebate, taker-rebate, and liquidity-reward pages
denominate payouts in **pUSD** (venue report §6, and conflict **C-2** in §11).
The `WP-000` report records both statements verbatim and deliberately does not
pick one.

**This ADR does not resolve it either**, and no implementation may resolve it by
assumption. Binding rules until it is resolved:

1. Every ledger entry carries an **explicit asset identifier**. There is no
   implicit "cash" asset.
2. **USDC and pUSD may not be treated as interchangeable.** If a conversion
   exists, it is an explicit, recorded ledger transaction with its own evidence —
   not an equality baked into a type.
3. A fee or rebate entry is denominated in the unit asserted by the source it was
   derived from, and that source is recorded with the versioned fee/reward
   snapshot (§9.13).
4. **`WP-200` and the fee/reward accounting work must resolve C-2 against
   then-current official documentation before implementation**, and record the
   resolution as an amendment here.

What *is* verified: the collateral backing an outcome-token pair. "Every YES and
NO pair is backed by exactly $1 of collateral locked through the CTF contracts",
with the pUSD, Conditional Tokens, and CTF collateral-adapter contract addresses
recorded verbatim (venue report §10.2). Buying consumes pUSD; selling requires
outcome-token inventory (venue report §10.2).

**Amendment, 2026-09-03 (`GOV-1D`): item 4 is discharged. C-2 is RESOLVED as a
documentation inconsistency — and the resolution keeps the denominations
distinct.**

**Who performed the mandated verification, and why not `WP-200`.** Item 4 above
assigns the verification to "`WP-200` and the fee/reward accounting work".
`WP-200` **refused it and escalated**, correctly: resolving C-2 requires
fetching current official pages and recording the result in `docs/adr/**`, and
neither is inside that package's grant (`docs/handoffs/WP-200.md` `deviations`
3, `follow_up` 1). Rather than let the mandate lapse or be discharged by
assumption, the contract owner executed it in this orchestrator-authorized
governance round. `WP-200` shipped in conformance with items 1–3 in the
meantime — explicit asset identifiers, USDC and pUSD as two ids no code path
treats as interchangeable, no implicit "cash" asset, no cross-denomination sum
— so this amendment **ratifies** that behavior and changes no code.

**Method and evidence.** Four read-only, unauthenticated GETs performed on
**2026-09-03**, each recorded with URL, HTTP status, byte count, SHA-256, and
timestamp in the new dated report
[`docs/venue/verified-2026-09-03.md`](../venue/verified-2026-09-03.md) §1: all
four **HTTP 200** — `trading/fees.md` (8 128 bytes), `programs/maker-rebates.md`
(5 945), `programs/taker-rebates.md` (7 769), `programs/liquidity-rewards.md`
(7 191). All four pages were reachable; no page in scope was unretrievable.
The retrieval was independently cross-checked against a separate fetch of the
same four URLs on the same date: identical statuses, byte counts, and digests.
Every claim below is **documentary**; nothing here is observational, and no
credential, key, or authenticated endpoint was used.

**Finding 1 — the inconsistency persists in current documentation.** It is not
an artifact of the frozen 2026-08-24 snapshot. The fees page still says USDC
(12 occurrences, no mention of pUSD); the maker-rebates and taker-rebates pages
still say pUSD (9 and 7 occurrences, no mention of USDC).

**Finding 2 — its shape is a documentation-copy artifact: the same quantity,
formula, and rounding floor described under two names.** Verbatim, from
`trading/fees.md` and `programs/maker-rebates.md` respectively:

> Taker fees are calculated in **USDC** and vary based on the share price. The
> fee amount in **USDC** is symmetric around 50% probability — a trade at 30¢
> incurs the same dollar fee as a trade at 70¢.

> Taker fees are calculated in **pUSD** and vary based on the share price. The
> fee amount in **pUSD** is symmetric around 50% probability — a trade at 30¢
> incurs the same dollar fee as a trade at 70¢.

The two sentences are identical except for the token name. So are the precision
sentences — "The smallest fee charged is **0.00001 USDC**" versus "The smallest
fee charged is 0.00001 pUSD", with the same `0.00001` magnitude and the same
"rounded to 5 decimal places" rule — and the formula is the same expression
(`fee = C × feeRate × p × (1 - p)` versus `fee_equivalent = C × feeRate × p ×
(1 - p)`). Three further corroborations are recorded in the report §3.3: the
rebate page states in its own words that rebates use "the **same formula as
taker fees**"; it **defers to the fees page for the numeric tables** ("For
detailed fee tables for each market category, see the [Fees](/trading/fees)
page") — i.e. the pUSD page sends the reader to the USDC page for the same
tables; and both pages embed the **identical** fee-curve chart asset
(`datawrapper-chart-dJ74e`).

**Finding 3 — no page asserts an equivalence.** Searched across all four
bodies, **no fetched page states that USDC and pUSD are the same asset, states
any conversion rate or mechanism between them, or gives a contract address
linking them** (report §3.4). The only "equivalent" strings are the rebate
formula's `fee_equivalent`/`total_fee_equivalent` scoring weights. The one
adjacent use of the name — "no Polymarket fees to deposit or withdraw USDC" —
names USDC as the **deposit/withdrawal** asset, a different referent from both
the fee unit and §10.2's pUSD collateral, and **no fetched page relates the
two**.

**Finding 4 — drift, disclosed: the liquidity-rewards page now names no
settlement token.** Frozen report §11 characterizes C-2 as covering the
"maker-rebates, taker-rebates, and liquidity-rewards pages"; as of this
retrieval the liquidity-rewards page contains **zero** occurrences of the
substring `usd` in any case. Its minimum is stated as "The minimum reward
payout is **\$1**" — a dollar figure with no token. **C-2's live scope is
therefore narrower than the frozen report describes:** the inconsistency today
is fees (USDC) versus the two *rebate* pages (pUSD). The frozen report is not
edited (`protected-contracts.md` §2); current official documentation controls
(handoff §1.1). **This amendment is also the correction-of-fact note that
`docs/adr/README.md` and `protected-contracts.md` §4 require for this ADR's own
Evidence section**, whose phrase "maker rebates …, taker rebates …, and
liquidity rewards … — each in pUSD with a $1 minimum accrual" is, as of
2026-09-03, **no longer supported for liquidity rewards**. The Evidence text is
left as the dated 2026-08-24 snapshot it declares itself to be.

**The ruling.** C-2 is **RESOLVED**, and resolved *against* folding:

1. **C-2 reads as a documentation inconsistency — a copy artifact.** The venue
   describes one quantity — the taker fee, and the rebate computed from it —
   under two names, with identical arithmetic and an identical rounding floor.
   On the recorded evidence, the parallel prose supports reading the divergence
   as a documentation artifact rather than as two differently-sized quantities.
   *(Corrected 2026-09-03 by the orchestrator, disclosed pre-merge: the review
   found the original wording — "a documentation inconsistency, not an economic
   one" — asserted more than the evidence establishes. The parallel prose
   strongly supports the copy-artifact reading but does not establish economic
   reality. Stated as a reading, the operative rulings below are unchanged: by
   known-risk 1 they hold either way.)*
2. **That does not make them one asset, and this ADR does not rule that they
   are.** A shared magnitude is not an asserted identity of the underlying
   token. Finding 3 is decisive: inferring an on-chain equivalence from prose
   parallelism would be **inventing venue behavior** (`AGENTS.md`), which is
   forbidden however plausible the inference feels.
3. **Item 2 stands unchanged and binding: USDC and pUSD may not be treated as
   interchangeable.** Distinct asset identifiers remain **mandatory**. No code
   path may sum, net, or substitute across them, and no type may bake in an
   equality. **If a conversion exists, it is an explicit, recorded ledger
   transaction with its own evidence** — evidence this round looked for and did
   not find.
4. **Item 3 stands unchanged, and item 4's discharge sharpens it.** A fee or
   rebate entry is denominated in the unit **asserted by the source it was
   derived from**, and that source is recorded alongside it with the versioned
   fee/reward snapshot (§9.13). Concretely: a **fee** derived from
   `trading/fees.md` is recorded in **USDC**; a **maker or taker rebate**
   derived from `programs/maker-rebates.md` or `programs/taker-rebates.md` is
   recorded in **pUSD**; and in both cases the source page and its retrieval
   date travel with the entry.
5. **Liquidity rewards have no source-asserted denomination, and none may be
   assumed** (finding 4). This is the one place the discharge *adds* an
   obligation rather than ratifying an existing one. A reward-schedule snapshot
   derived from the liquidity-rewards page records its denomination as **not
   asserted by the source** — it may not default to pUSD merely because the
   sibling programs do. §6's existing rule supplies the safe path: only an
   **observed payout** creates a `REWARD_INCOME` entry, and the observation
   itself carries the asset actually received, which is evidence rather than
   inference. If a payout is observed whose asset cannot be determined, the
   correct outcome is the one §3 and §9.15 already mandate — `UNATTRIBUTED` and
   a halt of the affected market — **not** a guessed denomination.

**What this ruling does NOT do**, stated plainly so no later reader can borrow
more from it than it says:

- It does **not** assert that USDC and pUSD are the same on-chain asset, nor
  that they are different ones. It records that **no fetched page says either**.
- It does **not** authorize folding the two denominations, collapsing them into
  a single "cash" asset, or introducing an implicit conversion. Item 1's
  explicit-asset-identifier rule and item 2's non-interchangeability rule are
  untouched.
- It does **not** state a conversion rate. There is no evidence for one.
- It does **not** change §7 items 1, 2, or 3, and it changes **no other section
  of this ADR** — §6's fee/rebate/reward mechanics, the scope table in §2, and
  the wallet-operation rules in §8 are all unaffected.
- It does **not** change any run-mode default, credential boundary, or safety
  ceiling (ADR-010), and it changes **no code** — the `WP-200` handoff
  **reports** that its shipped behavior conforms. That report is evidence of
  intent and escalation, not proof of code conformance: `WP-200` was still
  remediating HIGH findings when this amendment was written, and its own
  handoff says the final state must be re-checked. **Conformance ratification
  is deferred to `WP-200`'s final code review and merged state.**
  *(Corrected 2026-09-03 by the orchestrator, disclosed pre-merge: the review
  found the original wording ratified conformance on the strength of an
  in-flight sibling branch's handoff alone.)*
- It claims nothing **observational**: no payout was observed, no balance was
  read, no transaction was inspected. The fact stays volatile (handoff §1.2)
  and each phase gate re-verifies it.

**Recorded under the `docs/adr/README.md` bounded venue-fetch exception (third
use).** All four conditions, walked explicitly:

1. **Handoff §1.1 already ranks current official documentation above the
   in-repo report**, so this ADR asserts nothing on its own authority — it
   records what the venue's own current pages say, and where they contradict
   the frozen report (finding 4) the current pages control by that same rule.
2. **The record carries the URL, the retrieval date, and verbatim quotes**, and
   distinguishes documentary confirmation from observation: every finding above
   is documentary and is labelled so; report §1 additionally carries HTTP
   status, byte count, and SHA-256 per fetch so a reviewer can re-fetch and
   diff.
3. **The frozen report is still cited for the item's origin and prior status**
   — `verified-2026-08-24.md` §6 and §11 C-2 — **and is not edited**
   (`protected-contracts.md` §2). Finding 4's drift is recorded as drift beside
   it, not written into it.
4. **The gap is still recorded for the next verification round.** All four
   pages are already in the frozen report's §14 source index, so this round
   incurs no new source-index debt; the debts it *does* incur are enumerated in
   `verified-2026-09-03.md` §5 — the liquidity-rewards denomination, the
   undocumented deposited-USDC-to-pUSD-collateral funding path, and the
   standing §1.2 full re-verification.

One honest note on the exception's fit, for the reviewer: its text describes "a
venue fact that **a work package's own mandated** verification obtained". Here
the mandate is this ADR's own §7 item 4 and it named `WP-200`, but `WP-200`'s
grant made the fetch and the amendment impossible, so the contract owner
executed the same mandate in its place. The shape is otherwise identical to the
first two uses (ADR-013 §7 for ADR-002 §8.3's mandate; ADR-009 §5's 2026-09-02
amendment for ADR-009 §5.2's own mandate) — a *ratifying* record of a
*mandated* verification, not an ADR fetching a fact it merely wanted.

**Reopen condition.** This resolution is reopened by **a venue assertion of
equivalence or conversion** — any official page that states USDC and pUSD are
the same asset, states a conversion rate or mechanism between them, publishes a
contract address linking them, or documents the funding path from deposited
USDC into pUSD collateral. Such evidence does **not** by itself authorize
folding: it authorizes modeling an **explicit, recorded conversion transaction**
under item 2, and it requires a superseding amendment here that states how
recorded historical entries in the two denominations are to be read. The
narrower re-scoping trigger is finding 4 — if the venue names a settlement
token for liquidity rewards, ruling 5's "not asserted by the source" lapses for
that program and the register row is updated with that evidence.

### 8. Wallet operations are ledger transactions

Split, merge, redeem, approve, and transfer are first-class wallet operations
(§9.14, §10.5) and each is a **balanced per-asset ledger transaction**:

- **Split** moves value from the pUSD asset into a complete YES/NO outcome-token
  set; **merge** is its inverse; **redeem** claims pUSD for winning tokens after
  resolution (venue report §10.2).
- Wallet operations have their own state machine including `UNKNOWN` and
  `RECONCILING` (§9.14). An `UNKNOWN` wallet operation triggers reconciliation
  (work-plan `WP-300` acceptance) and, until resolved, its effect is not asserted
  in a projection.
- No autonomous deposit, withdrawal, or bridging in v1 (§9.14, §3.2). Observed
  deposits and withdrawals are recorded as actual-account events (§9.15) —
  observing is not initiating.

### 9. Reservations

Reservations for plans and orders (`inventory_reservations`, §10.5) constrain
availability but are not spends. Required properties: no double reservation
(§9.14), **no negative available balance after reservations** (§10.7), and every
terminal order path releases unused reservations (§16.2). Open orders *and*
positions both consume limits (work-plan `WP-180` acceptance) — a reservation
that stops constraining before the order is terminal is a hole in the capital
allocator (§9.7).

## Consequences

- **Two write paths per economic event.** An actual-account entry plus a virtual
  attribution is more work than one balance update, and it is the only way §6
  invariant 7 can be checked rather than hoped for.
- **`UNATTRIBUTED` will fire in normal operation.** A daily reward payout that
  arrives before its schedule is modeled, or a manual wallet action, will halt a
  market. That is the designed sensitivity; the response is to model the source,
  not to widen the tolerance.
- **The C-2 denomination question blocks a clean fee/reward model.** Until it is
  resolved, fee and reward entries carry the denomination of their source and
  cannot be summed with collateral balances without an explicit conversion.
  Recorded as an open item in `docs/contracts/protected-contracts.md`.
- **Compensating reversals make history noisier than a mutable balance.** That is
  the cost of an auditable ledger, and §10.7 forbids the alternative.
- **Rebuild must stay fast enough to be usable.** Invariant 8 is only enforceable
  if a full rebuild is routinely executed; if rebuild becomes too slow to run,
  the invariant quietly stops being tested. `WP-200` should treat rebuild time as
  a tracked property.
- **Attribution remains necessary even with one live owner per market**
  (ADR-011). One owner bounds *intentional* activity; it does not bound
  wallet-level activity from outside the trader.

## Evidence

**Primary specification** (`docs/spec/polymarket-bot-orchestrator-handoff.md`):

- §1.3 — changing the ledger source of truth requires an ADR.
- §2 — append-only event ledger; actual wallet state separated from virtual
  strategy attribution; Redis is not for monetary truth; the fail-safe ladder.
- §3.2 — autonomous funding, bridging, deposits, and withdrawals are out of scope.
- §6 invariants 5, 7, 8, 10, 14.
- §9.7 — the capital allocator tracks commitments from both positions and open
  orders.
- §9.9 — incident action ladder; "Account state unknown → stop heartbeat, cancel,
  reconcile, full halt".
- §9.10 — the execution hierarchy through fill allocation and settlement events.
- §9.13 — limits are configuration snapshots with source and effective time.
- §9.14 — collateral and inventory manager; wallet-operation states and types.
- §9.15 — the ledger model, the scope list, and the event list; "Any actual
  balance change lacking attribution is allocated to `UNATTRIBUTED`, and the
  affected market is halted."
- §9.16 — PnL measures; "Reward estimates are never booked as realized. Fee and
  reward schedules are versioned per market where available."
- §9.17 — reconciliation triggers and procedure.
- §10.5 — the `accounting` schema tables.
- §10.7 — required constraints: append-only event and ledger tables; every fill
  allocation sum equals the actual fill quantity; every ledger transaction
  balances to zero per asset; no negative available balance after reservations.
- §14.4 — paging alerts include unattributed actual position and ledger invariant
  failure.
- §16.2 — property tests: ledger transactions balance per asset; reservations
  never create negative availability; position projection rebuilt from events
  equals incremental projection; every terminal order path releases unused
  reservations.

**Venue facts** (`docs/venue/verified-2026-08-24.md`, verified 2026-08-24;
snapshot, re-verify each phase per handoff §1.2):

- §2.2 — order response statuses; **verbatim**: a `delayed` response "is accepted
  but has not matched yet … Treat it as a pending order rather than a fill."
- §4 — six SDK `TradeStatus` settlement states; asynchronous on-chain settlement.
- §6 — fee formula, 5-decimal rounding, `0.00001` minimum charged fee, taker-only
  fees, per-category taker rates; maker rebates (pool-shared, daily at midnight
  UTC), taker rebates (tiered by 30-day weighted volume, daily payout, no stated
  time), and liquidity rewards (daily at midnight UTC) — each in pUSD with a $1
  minimum accrual. **All volatile program parameters, snapshot 2026-08-24.**
- §10.2 — split/merge/redeem semantics; "Every YES and NO pair is backed by
  exactly $1 of collateral locked through the CTF contracts"; buying consumes
  pUSD and selling requires outcome-token inventory; published Polygon contract
  addresses (pUSD, Conditional Tokens, CtfCollateralAdapter,
  NegRiskCtfCollateralAdapter).
- §11 conflict **C-2** — USDC (fees page) versus pUSD (rebate/reward pages)
  denomination. **UNRESOLVED**; interpretation deferred to the ledger and
  fee/rebate accounting packages. Carried by this ADR §7.
- §11 conflict **C-3** — `MATCHED_NOT_BROADCASTED` scope; modeled REST-only per
  SDK source precedence, **pending `WP-280` re-check**. Owned by ADR-007.
- §12 unverified **U-5 residual** — additional exchange-contract addresses (CTF
  Exchange / Negative Risk CTF Exchange) were not on the retrieved page and must
  be re-verified in `WP-300`.

**Implementation and prior handoffs:**

- `docs/handoffs/WP-000.md` — `known_risks`: "C-2: official pages use USDC (fees)
  vs pUSD (rebates/rewards) denomination language; interpretation deferred to
  ledger/fee accounting packages"; `follow_up`: "Ledger/fee packages: resolve the
  C-2 denomination question."
- `docs/contracts/domain.md` §4 — `MoneyString` and `SharesString` are unconstrained
  in sign (PnL may be negative; a `DELTA` target may be negative), which the ledger
  relies on for compensating reversals.

**Safety:** this ADR changes no run-mode default (ADR-010). It introduces no
credential and no wallet operation; §9.14's operations are implemented by `WP-300`
under the same PAPER-only ceiling.
