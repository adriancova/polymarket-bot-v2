# GOV-1C — contract-owner governance round at Wave 1 closeout

- **Package:** `GOV-1C`, an orchestrator-authorized bounded governance package
  (`IMPLEMENTATION_STATUS.md`, authorized and dispatched 2026-09-02; the
  mechanism is `docs/contracts/protected-contracts.md` §3.1 on the `GOV-1B`
  precedent, now recorded as a §5 precedent row of its own).
- **Base:** `4f20acf77e0bdbb51537303b71ef3ceab95e6d0a` — `main` tip at
  dispatch (all of Wave 1 merged; the C-4 phase-2 start-gate re-check
  recorded). Verified before editing.
- **Branch:** `worktree-agent-af74389cafb5f2d46`, isolated worktree.
- **Date:** 2026-09-02.
- **Review:** independent adversarial review is required before merge. The
  implementing agent did not review its own work (`AGENTS.md`).
- **Scope discipline:** this round **rules**; it does not implement. Two
  narrowly-bounded non-documentation exceptions were dispatched and are
  proved below: comment-only edits in two frozen domain modules
  (stripped-transpile hash proof) and one edit to
  `tools/check-dependency-direction.mjs` (mutation proof). No adapter, app,
  database, root config, lockfile, or test file was touched.

---

## Item 1 — The ADR-016 UUID boundary rule: REFUSE, not normalize

**The question** (assigned to this round by `GOV-1B` review LOW-2, carried in
`IMPLEMENTATION_STATUS.md`): ADR-016 §2's consequence sentence prescribed both
behaviors at once — a future component receiving an external UUID "lowercases
it at its adapter boundary, **and** a mixed-case value is that adapter's typed
failure". Normalize and refuse are opposites; a future adapter could cite
either half.

**Ruling.** **Refuse.** A UUID-shaped identifier arriving from a FUTURE
external input surface (config, control API, import tooling, replay input —
uniformly) must already be canonical lowercase; a mixed-case or otherwise
non-canonical spelling is a **typed refusal carrying the raw value** at that
surface — never a case-fold. Reasons, in the amendment's own words: every UUID
in these contracts is generated in-process, so a correct external caller
round-trips bytes and refusal **rejects nothing a correct caller sends** (the
ADR-015 property); folding would create a second accepted spelling and an
evidence-vs-interpretation split in recorded data; the established direction
is fail-closed (`WP-110` hardening, ADR-015), and — unlike the decimal case,
where venues documentedly emit `"1.50"` — no external system is documented or
expected to re-case these identifiers, so a fold buys interoperability with
nothing known. The amendment is honest about the counter-case: RFC 9562 makes
hex input case-insensitive and the grammar is ASCII-only, so folding would be
*technically* safe — the rule is repository **boundary hardening** in
ADR-015's sense, not a claim about UUID semantics. A stated reopen condition
requires evidence of a real re-casing external system **and** a superseding
ADR that handles raw-vs-folded evidence.

**Files changed.** `docs/adr/ADR-016-ratified-inferred-domain-shapes.md` —
header amendments line; the original §2 bullet kept and marked; a dated
amendment block with the four-part ruling. `docs/contracts/protected-contracts.md`
§8.1 — new row **R-8**, registered and CLOSED (the LOW-2 item previously
lived only in `IMPLEMENTATION_STATUS.md`). No code changed; the frozen schemas
already accept lowercase only; **no emitted field set changed, therefore
`schemaVersion` is unchanged** (ADR-002 §3).

---

## Item 2a — ADR-014 comment pointers in the frozen domain event modules

The `GOV-1B` `follow_up` 2 / register **R-7b** debt: the ruling that
`takerSide` names the aggressor order's own side was not visible at the two
places an implementer reads the contract.

**Edit.** `packages/domain/src/events/book.ts` — the field comment
`/** Taker side when the venue reports it. */` on
`PublicTradeObservedPayloadSchema.takerSide` replaced by the ADR-014
vocabulary (BID ⇔ taker buying; not the side consumed; omit-not-guess; dated,
citing the ADR and R-7b). `packages/domain/src/events/reference.ts` — the
previously uncommented `ReferenceTradeObservedPayloadSchema.takerSide` gains
the same pointer (plus the §3 per-venue-mapping reference, since the
reference events are the cross-venue surface).

**Comment-only proof — the `GOV-1B` `book.ts` method, verbatim results:**

```text
tool     node_modules/typescript 5.9.3 (the repository's own)
options  { removeComments: true, target: ES2022, module: ESNext }

packages/domain/src/events/book.ts
  base   4f20acf   sha256 e281fcc53582dc151ec068b2256db46f0b02e068510a6a62250e7cd5539c762c  2380 bytes
  after  working   sha256 e281fcc53582dc151ec068b2256db46f0b02e068510a6a62250e7cd5539c762c  2380 bytes
  diff   byte-identical (cmp exit 0)

packages/domain/src/events/reference.ts
  base   4f20acf   sha256 77bcc46a71f784523316c045f2e352f4002b717d1ad22efee38c6dbae7a0ecfa  2122 bytes
  after  working   sha256 77bcc46a71f784523316c045f2e352f4002b717d1ad22efee38c6dbae7a0ecfa  2122 bytes
  diff   byte-identical (cmp exit 0)
```

(The `book.ts` base hash equals the after-hash `GOV-1B` recorded for its own
comment-only edit — continuity across rounds.) Corroborating: filtering the
`git diff` for `packages/domain` down to non-comment lines leaves **zero**
lines (every added/removed line begins with a JSDoc marker). No schema, type,
export, or emitted field set changed; **`schemaVersion` unchanged**; the
domain test suite is untouched and passes unchanged.

---

## Item 2b — `domain.md` §10 rows for ADR-013…016

`GOV-1B` `follow_up` 3 / register **R-7a**. `docs/contracts/domain.md` §10
gains a dated, explicitly-additive second table naming the four 2026-08-28
ADRs, each mapped to the exact place in this document (or its frozen modules)
it ratifies, including ADR-016's 2026-09-02 refinement. No §1–§9 decision is
changed. **R-7 is closed as DONE** in `protected-contracts.md` §8.1 with both
halves' evidence named.

---

## Item 2c — Venue-report re-issue: `docs/venue/verified-2026-09-02.md`

A **new dated file** (the frozen-report rule, `protected-contracts.md` §2),
explicitly a **bounded re-issue** and not a §1.2 phase-gate re-verification.
Every page on the round's enumerated list was re-fetched by me on 2026-09-02,
read-only and unauthenticated, with status + bytes + redirect count + body
SHA-256 recorded per fetch (the `GOV-1B` evidence standard); there were **no**
could-not-refetch cases. Highlights:

| Item | Result |
| --- | --- |
| AsyncAPI market page indexed | HTTP 200, **44 794 bytes — byte-count-identical to `GOV-1B`'s 2026-08-28 fetch**; all ten load-bearing quotes present, with occurrence counts |
| Market-WSS URL drift | the frozen report's URL now returns **HTTP 308** → `…/market-data/realtime-data#market-stream` (followed: 200); dated and recorded |
| E18 (`full_accuracy_value`) | the D-1 scale statement present verbatim (divide by 10^18; numeric `value` display-only) with the `"65000500000000000000000"` example |
| RTDS timestamp shape | `"timestamp": 1785178800000` examples plus the two-timestamps meaning statement; frozen report §10.3's "unix ms" corroborated — both authorities agree |
| `GET /book` OpenAPI | all **ten** `OrderBookSummary` properties still `required`; the bid/ask-ordering contradiction between the OpenAPI and the prose page **still published, both sides quoted**; the SDK `.nullish()` divergence for `timestamp`/`last_trade_price` re-affirmed as the recorded posture |

The report also records the gaps still owed to the next full round (the
resolution page, the market-by-id page, and the full §1.2 re-verification).
The register's C-1/U-1 row gained a dated note that the source-index debt is
paid; the frozen 2026-08-24 report is not edited.

**Fetch evidence (verbatim):**

```text
curl -sS -L  https://docs.polymarket.com/api-reference/wss/market.md
  → final 200, 44794 bytes, 0 redirects, fetched 2026-09-02T15:25:15Z
    sha256 92a02634755fd92cc1c4a3f798ea64f050f76670e677003a9a595d8a8f4c616a
curl -sS -L  https://docs.polymarket.com/market-data/chainlink-twap.md
  → final 200, 16406 bytes, 0 redirects, fetched 2026-09-02T15:25:23Z
    sha256 6b8ffab6fb0fd7c8818a2921f66a920d653deb7b84e22dce91d2a70cf4ddbed9
curl -sS -L  https://docs.polymarket.com/api-reference/market-data/get-order-book.md
  → final 200, 5690 bytes, 0 redirects, fetched 2026-09-02T15:25:26Z
    sha256 fd98e9bea50208a07d4ea51a8d03e2048cb6cbf4db70149fb17deda8770815f7
curl -sS -L  https://docs.polymarket.com/market-data/prices-order-books.md
  → final 200, 33342 bytes, 0 redirects, fetched 2026-09-02T15:25:32Z
    sha256 e07d519101255305527d6464feee5c8f81d3937580a3f9ab6e29aad8fa1fec68
curl -sS     https://docs.polymarket.com/market-data/websocket/market-channel
  → 308, redirect_url=https://docs.polymarket.com/market-data/realtime-data#market-stream
curl -sS -L  (same URL, followed)
  → final 200, 1959547 bytes, 1 redirect, fetched 2026-09-02T15:25:36Z
curl -sS -L  https://docs.polymarket.com/api-spec/clob-openapi.yaml
  → final 200, 215862 bytes, 0 redirects, fetched 2026-09-02T15:25:44Z
    sha256 82529177635db366c31a08777355b4b95c392a427298c3ba68904b937d4594da
```

---

## Item 2d — the F14 rename in `tools/check-dependency-direction.mjs`

**What was found before editing, and it changes the deliverable's shape:**
`GOV-1B` `follow_up` 5 offered two exits — "rename … **updating
`test/unit/tooling/dependency-direction.test.ts` in the same change**; or
record the alias as permanent" — and the reason is a hard fact:
that suite (a **forbidden path** for this round, and the round's gate is that
no test file may change) pins the id **structurally**: ~30
`toContain("FAIL [F-OPAQUE]")` output assertions, five
`toEqual(["F-OPAQUE"])` / `entry.rule === "F-OPAQUE"` assertions on the JSON
report's `rule` field, and two `not.toContain("F-OPAQUE")` negative
assertions. A strict swap of the emitted id therefore **cannot** pass the
round's own gates. See `deviations` 1.

**What was done — the rename on every surface the pinned suite leaves free,
with the alias load-bearing rather than decorative:**

- Human-readable findings now lead with **`FAIL [F14]`**, and each carries an
  `id:` traceability line naming the legacy spelling (which is what keeps the
  pinned `toContain` assertions true — the alias line contains the literal
  `FAIL [F-OPAQUE]`).
- The failure summary counts under **`F14xN`**.
- The JSON report now carries **both ids**: `contractRule: "F14"` added
  alongside the untouched machine field `rule: "F-OPAQUE"` (the pinned one).
- The finding's `doc:` citation corrected from `§6 rule 3` to
  **`§3 (F14, emitted under the accepted alias F-OPAQUE)`** — F14 has been a
  §3 row since `GOV-1B`.
- `--help`, the PASS text, and the module header document the F14/alias state.
- The contract row (`dependency-direction.md` §3 F14, consequence 3) is
  updated to describe exactly this state and to define the remaining tooling
  follow-up: swap the machine `rule` field **and** the pinned suite in one
  change.

**Mutation proof (verbatim).** An F14-catchable construct (a dynamic
`import()` with a non-literal specifier) was placed in a purity-restricted
package as a scratch file, the tool run on both surfaces, and the file
removed (see `deviations` 6 for why the live worktree rather than a workspace
copy):

```text
$ printf 'declare const dyn: string;\nexport const load = () => import(dyn);\n' \
    > packages/simulation/src/gov1c-mutation-probe.ts
$ node tools/check-dependency-direction.mjs
FAIL [F14] packages/simulation (packages/simulation/src/gov1c-mutation-probe.ts:2)
       uses a dynamic `import()` whose specifier is a non-literal expression; in
       `packages/simulation` the imported module must be statically readable, or
       rules F1-F8/F11 cannot be evaluated at all
   id: contract §3 row F14; the machine `rule` field and pre-2026-09-02 output
       spell this finding FAIL [F-OPAQUE] (accepted alias, §3 F14)
  doc: docs/contracts/dependency-direction.md §3 (F14, emitted under the
       accepted alias F-OPAQUE); ADR-005 §1
  fix: import the module statically, or receive the capability through
       StrategyContext/a constructor argument
FAILED: 1 violation(s) [F14x1]        exit=1
$ node tools/check-dependency-direction.mjs --json   # violations[0], abridged:
  { "rule": "F-OPAQUE", "contractRule": "F14", "subject": "packages/simulation",
    "location": "packages/simulation/src/gov1c-mutation-probe.ts:2", … }
$ rm packages/simulation/src/gov1c-mutation-probe.ts
$ node tools/check-dependency-direction.mjs ; echo exit=$?
PASS …  exit=0
$ git status --porcelain packages/simulation
(empty — no residue)
```

(Wrapped here for the page; the tool emits each of the FAIL/`id:`/`doc:`
blocks on the line structure shown in §"formatReport".) After the edit:
`pnpm check:deps` **PASS — 34 packages, 24 edges** (the dispatch-required
counts), and the pinned tooling suite passes **unchanged: 187/187**.

---

## Item 2e — the `dependency-direction.md` §6.1 rulings (and §3 F15/F16)

`GOV-1B` `follow_up` 6. Every §6.1 item now carries a dated ruling; the item
descriptions are kept verbatim as history:

1. **The positive callee-resolution rule (`WP-015` `follow_up` 8): NOT
   adopted, with a binding tripwire.** Not adopted because the frozen
   `packages/domain` itself dispatches dynamically by design — every
   `schema.parse(...)`, registry lookup, and structural-contract callback has
   a callee that is a parameter or property value — so the rule as drafted
   floods the package it most needs to protect, and a rule waived wholesale
   for frozen code enforces nothing. The tripwire is the binding half: **the
   next F14-class escape spelling the existing enumerations do not catch is
   closed by adopting a total rule, in the closing change, as a mandatory §3
   row — declining a second time is not available.**
2. **Rule 3 applies to test files inside purity-restricted packages: YES** —
   the checker's shipped behavior becomes the documented decision. A strategy
   test that needs time uses an injected manual clock (the repository's
   existing pattern); fixtures enter as imported modules or inline literals.
   Consequence stated for `WP-220`: a genuine need that cannot be met this
   way is a cited contract change first, never a checker workaround.
3. **Computed property reads stay non-fail-closed**, preserving the accepted
   `table[key]` ruling; the `f[parts.join("")]` residual is disclosed,
   accepted, and covered by item 1's tripwire.
4. **CLOSED by writing the rows: §3 F15** (the `packages/decimal` import
   allowlist — basis `domain.md` §1) **and §3 F16** (no cross-package deep
   import around an `exports` map — basis: all 28 workspace packages declare
   one, verified this round, and Node/`NodeNext` already refuse unexported
   subpaths). Both rows state plainly that the §6 check does not evaluate
   them yet; per §6.1 item 4's own rule the cited rows now precede any
   implementation. See `deviations` 3.
5. **The §2.1-pin note stands unchanged** (reviewed; not a defect).

§2 and §2.1 — the machine-parsed sections — were **not touched**;
`pnpm check:deps` parses the edited contract and passes.

---

## Item 3 — `causationId` registered as a contract (`domain.md` §11)

`WP-120` `follow_up` 4 / its `known_risks` 3. New **§11 "Registered producer
conventions"** in `docs/contracts/domain.md` (my call as contract owner, per
the dispatch's option): §11.1 registers the gateway's

```text
causationId := "raw:" <gatewayEpoch> ":" <ingestSeq>
```

with the component grammars, the referent semantics (the WAL `RawFrameRecord`
carrying that dedup identity — what makes §6 invariant 4's chain terminate in
bytes on disk), an unambiguous parsing rule (first/last `:`, robust even to a
hypothetical `:` inside an epoch string, the same corner the compactor's
unit-separator dedup key guards), the **opacity rule** (an unregistered
prefix is the §7.1 baseline — opaque, not an error), and the extension
authority: **new registered formats are contract-owner changes to §11 —
orchestrator-approved, additive, one prefix per referent kind, never reused
or redefined**; producers may not invent parseable conventions without
registering them first; consumers (`WP-210`, `WP-230`) may rely on exactly
the registered set. The envelope field stays schema-opaque; **no schema
changed, `schemaVersion` unchanged** (stated in the section itself).
Evidence: `apps/data-gateway/src/envelope.ts` (`rawFrameCausationId`),
`sequencer.ts`, ADR-002 §2.

---

## Item 4 — ADR-017: the dataset-manifest and retention-receipt contract

`WP-130` follow-ups 7/9/10/11/12/13; `WP-140`'s reliance. New accepted
**ADR-017** pins, citing the shipped implementation as evidence and changing
no code: **(1)** the two per-segment digest roles — `segmentSha256` =
WAL-chain identity of the checksummed span vs `segmentFileSha256` =
deletion-time identity of the whole file — **per-WAL-version** (the coverage
split is a `polymarket-bot/wal/v1` fact; a future WAL version restates both
in the same change), with the store-side verification boundary stated
(presence/grammar checkable forever; the value provable only pre-deletion);
**(2)** `nullable` = Parquet **repetition** (`OPTIONAL`/`REQUIRED`),
validated bidirectionally; **(3)** the strict-JSON reading profile (UTF-8
only incl. the unpaired-surrogate refusal; RFC 8259 literals only; unique
keys) so a second reader implements the refusals deliberately; **(4)** the
retention receipt's **reporting-not-proof** role (the proof is the persisted,
re-verified manifest; a missing receipt is never evidence a deletion did not
happen; no per-segment deletion state may enter the immutable manifest).

---

## Item 5 — WAL cross-epoch chronology: ruled, not invented

`WP-130` `follow_up` 8. `docs/contracts/wal-format.md` gains dated **§12.1**
(plus an open-items row): **epochs are identity, not chronology.** The format
defines no cross-epoch order; a compaction batch is **single-epoch** (the
shipped `CrossEpochOrderError` refusal is ratified); mixed-epoch
*directories* remain legal (a restart in place produces one) — only ordering
claims are out of contract. The subsection enumerates, each with its
evidence, what may NOT be used as chronology: epoch-id UUIDv7 bits or lexical
order (`WP-130` round-1 M1 reproduced the fabrication), header/frame wall
clocks (not monotonic across boots; `receivedMonotonicNs` is per-process),
and file names/listings (§2 opacity; ADR-004 §5). The reopen path requires
**new recorded evidence** — e.g. a monotonic epoch-succession record, which
is a format change — and an ADR-004 amendment with a `walSchemaVersion` bump
**before** implementation. The conservative ruling the dispatch named,
verbatim in effect.

---

## Item 6 — ADR-018: the runtime-build convention

`WP-130` `follow_up` 1, reproduced by `WP-120`. New accepted **ADR-018**:
workspace TS apps that must RUN use an **app-local esbuild bundle** —
`build`/`start` declared on the app only, esbuild as the app's own
devDependency, **ESM default, CJS permitted where a CJS-only dependency
forces it and the deviation is disclosed** (the `WP-120`/`ioredis` evidence,
observed-not-predicted, is quoted). The record states why `tsc && node dist`
cannot work here (`.js` specifiers into workspace TS sources; `WP-130`'s
observed `ERR_MODULE_NOT_FOUND`; `apps/ops-cli` survives only while its
executable path imports no workspace package), that bundling changes
packaging never the dependency rules (the §6 check reads source; no
dependency fictions), and that any departure (per-package `dist`, loaders,
root build pipeline) supersedes the ADR. No code changed — both shipped apps
already conform. This forecloses re-litigation in `apps/trader` and later
apps.

---

## Item 7 — `WP-110`'s venue-register rows (and the U-6/ADR-009 closure)

`WP-110` `follow_up` 2, which owed these updates to the register's owner.
`docs/contracts/protected-contracts.md` §8:

- **U-10 (new, UNVERIFIED):** cancellation/void resolution mechanics and
  payout. The venue documents exactly three redemption outcomes and no
  refund path; the shipped `payoutPerShare("CANCELLED")` refusal
  (`SETTLEMENT_CANCELLED_PAYOUT_UNVERIFIED`) is recorded as the correct
  fail-closed behavior, with the operational consequence disclosed.
- **U-11 (new, UNVERIFIED — do not parse):** the `umaResolutionStatus` value
  vocabulary is undocumented (nullable string, both surfaces, observed
  2026-08-28); keying behavior on its values is inventing venue behavior.
- **U-12 (new, UNCONFIRMED):** no `MarketClosed`-equivalent venue signal;
  the projection's `CLOSED` is schedule-derived and scheduled-close-elapsed
  is not venue-confirmed; if a signal appears the answer is a new event type
  under a new `schemaVersion`, never a looser projection.
- **The "No dedicated dispute event" row annotated** with the 2026-08-28
  re-check: a dispute *process* is documented, no consumable transition
  event; `DISPUTED` stays operator-observed; ADR-009 §4's condition still
  unmet.
- **U-6 rewritten as CLOSED** (2026-08-28 by `WP-110`'s mandated
  verification; recorded 2026-09-02), on the C-1/U-1 row pattern, with the
  two carried limits (documentary-not-observational; the page still owed to
  a full report). **ADR-009** gains the matching dated amendment discharging
  its §5.2 marker obligation for the 50/50 payout and confirming §5.3's
  conditional — under the `docs/adr/README.md` bounded exception (second
  use; all four conditions addressed in the amendment text), and explicitly
  NOT touching `CANCELLED` (U-10) or §4. See `deviations` 2.

---

## Item 8 — ADR-019: the soak policy ratified at 24 h, one window, no summing

`WP-140` assumption 1 and `follow_up` 5. New accepted **ADR-019** ratifies the
shipped bar as policy: **24 contiguous hours, a single qualifying window, no
summing of windows** — restarts reset by design; the fail-closed evaluator
semantics (INVALID poisoning, PENDING arithmetic, the conservative
unexplained-gap rule under which even venue-side gaps disqualify pending
operator review) are part of the ratified bar; `QUALIFYING_WINDOW_FOUND`
remains a **candidate** for out-of-band provenance review, never completion.
Because 24 h is ratified — not changed — **the evaluator constant is
untouched and no code changed**; a different threshold or any
window-composition rule now requires superseding ADR-019 plus the reviewed
evaluator edit, in that order. No soak is claimed by this round; none has
been run.

---

## summary

Discharged the eight contract-owner items dispatched at Wave 1 closeout, as
three new accepted ADRs (ADR-017 dataset-manifest/retention-receipt; ADR-018
app-local esbuild runtime builds; ADR-019 the 24 h single-window soak bar),
dated in-place amendments (ADR-016 §2 — external UUID-shaped input is
**refused**, not case-folded; ADR-009 §5 — the U-6 discharge; wal-format
§12.1 — epochs are identity, not chronology, single-epoch compaction
ratified), contract registrations (`domain.md` §11 — the gateway's
`raw:<gatewayEpoch>:<ingestSeq>` causation format with extension authority;
§10 — the ADR-013…016 rows), register updates (U-6 closed; U-10/U-11/U-12
added; R-7 closed; R-8 registered and closed; the GOV-1C §5 precedent row),
the §6.1 rulings (callee-resolution rule declined **with a binding
tripwire**; tests in scope; computed reads stay non-fail-closed; F15/F16
written), a bounded venue-report re-issue (`verified-2026-09-02.md`, six
fetches, no failures, AsyncAPI page byte-identical), the hash-proved ADR-014
comment pointers in the two frozen event modules, and the mutation-proved
F14 id alignment in the dependency-direction tool — with the machine `rule`
field deliberately left as the accepted alias because the pinned unit suite
(a forbidden path) asserts it structurally (`deviations` 1).

No runtime behavior changed anywhere; no `schemaVersion` moved; no safety
default was touched (diff swept — see `tests_run`).

## files_changed

**New (5):**

| File | Purpose |
| --- | --- |
| `docs/adr/ADR-017-dataset-manifest-and-retention-receipt-artifact-contract.md` | Item 4 |
| `docs/adr/ADR-018-app-local-esbuild-runtime-build-convention.md` | Item 6 |
| `docs/adr/ADR-019-soak-evidence-threshold-policy.md` | Item 8 |
| `docs/venue/verified-2026-09-02.md` | Item 2c (bounded re-issue) |
| `docs/handoffs/GOV-1C.md` | this record |

**Modified (9):**

| File | Change |
| --- | --- |
| `docs/adr/ADR-016-ratified-inferred-domain-shapes.md` | header amendments line; §2 bullet marked; dated REFUSE amendment (item 1) |
| `docs/adr/ADR-009-settlement-spec-and-payoff-model-selection.md` | header amendments line; §5 dated discharge block (item 7) |
| `docs/adr/README.md` | index rows ADR-017/018/019 + ADR-016 amendment note; the bounded-exception "only use" sentence corrected (second use recorded) |
| `docs/contracts/domain.md` | §10 dated additive rows (item 2b); new §11 (item 3) |
| `docs/contracts/dependency-direction.md` | §3 F14 consequence 3 updated to the shipped state; new §3 rows F15/F16; §5 decimal row F15 note; §6.1 dated rulings (items 2d/2e) |
| `docs/contracts/wal-format.md` | dated §12.1 cross-epoch ruling + open-items row (item 5) |
| `docs/contracts/protected-contracts.md` | §5 GOV-1C precedent row; §8 U-6 CLOSED, dispute row annotated, U-10/U-11/U-12, C-1/U-1 dated index note; §8.1 R-7 closed, R-8 added+closed (items 1/2c/7) |
| `packages/domain/src/events/book.ts` | **comment-only** ADR-014 pointer (hash-proved, item 2a) |
| `packages/domain/src/events/reference.ts` | **comment-only** ADR-014 pointer (hash-proved, item 2a) |
| `tools/check-dependency-direction.mjs` | item 2d only: F14 lead id + `id:` alias line in human output; `contractRule` in JSON; `doc:` citation fixed; help/PASS/header text (mutation-proved) |

**Not touched** (verified by `git status`/`git diff --name-only` against
`4f20acf`): every package source except the two comment-only files, all of
`test/**`, `apps/**`, `db/**`, `.github/**`, root configs, `pnpm-lock.yaml`,
`package.json` (all of them), `IMPLEMENTATION_STATUS.md`, the workplan, and
`docs/venue/verified-2026-08-24.md`.

## tests_run

| Gate | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | exit 0; lockfile untouched (no dependency changed) |
| `pnpm typecheck` | exit 0, all packages incl. the gateway/soak trees |
| `pnpm lint` | exit 0 |
| `pnpm test` (baseline, pre-edit, this worktree at `4f20acf`) | **3451 passed / 122 files** — equal to the dispatch-required main counts |
| `pnpm test` (after all edits) | **3451 passed / 122 files** — identical counts; no test file changed |
| `pnpm check:deps` | exit 0 — **34 packages, 24 edges**, allowlist S0/S1/S2 (the dispatch-required counts), after the tool edit and against the edited contract |
| `pnpm ops:verify-venue` | exit 0 (the tool pins `docs/venue/verified-2026-08-24.md`; the new dated report does not and must not affect it) |
| `pnpm --filter @polymarket-bot/polymarket-public test:contract` | exit 0 — **583 passed** (spot check) |
| `pnpm vitest run test/unit/tooling/dependency-direction.test.ts` | **187 passed / 187** — the pinned suite, unchanged, after the tool edit |
| Stripped-transpile proofs (`book.ts`, `reference.ts`) | **identical** sha256 + bytes (verbatim in item 2a) |
| F14 mutation proof | violation caught → exit 1 with `FAIL [F14]` + both JSON ids; restored → exit 0, no residue (verbatim in item 2d) |
| Safety sweep | `git diff 4f20acf` plus the five new files grepped for `MAX_RUN_MODE`, `ALLOW_REAL_ORDERS`, `LIVE_MICRO_MAX_ORDER_NOTIONAL`, `LIVE_MICRO_MAX_ACCOUNT_EXPOSURE` and live-enablement terms — **zero hits in the tracked diff; the only hit anywhere is this table row naming the terms**. No safety default is stated, restated, or weakened by any edit of this round |

**Not run and not claimed:** `pnpm test:compose`, `pnpm audit` (no dependency
changed), any soak, execution probe, live gate, or observational venue claim.
Network access was exactly the six read-only documentation fetches of item 2c.

## assumptions

1. `IMPLEMENTATION_STATUS.md` is orchestrator-owned; this round records its
   register/ADR changes here and in `docs/contracts/**` and leaves that file
   alone (including the `GOV-1C` row flip and the LOW-2 retirement).
2. The dispatch packet's eight items are the whole scope. Adjacent open
   register items were not ruled on — in particular **R-2** (SDK-anchor
   stand-ins) and **C-2/C-3/U-2…U-9**, none of which was in the packet.
3. "The GOV-1B §evidence standard" for fetches is read as: the exact command
   shape, HTTP status, byte count, and date per fetch; body SHA-256s are
   added on top so the adversarial reviewer can diff a re-fetch.
4. The dispatch's "34 packages / 24 edges" for `check:deps` was verified
   against the clean base **before** editing (it held), so the counts gate
   proves the tool edit changed no graph semantics rather than merely
   matching a stale expectation.
5. ADR numbering continues from ADR-016 (ADR-001–012 reserved by handoff
   §20; 013–016 taken); no renumbering.
6. For item 3 the "your call" option was exercised in favor of `domain.md`
   (new §11) rather than a standalone contract file, because `causationId`
   is a §7.1 envelope field and `domain.md` is where its consumers already
   look; the section is additive and self-contained.

## deviations

1. **Item 2d is a dual-surface rename, not a strict swap — disclosed as the
   round's most reviewer-relevant deviation.** The dispatch says "rename the
   emitted id"; the round's gates say "no test file may change" and "counts
   must equal main's 3451/122"; and the pinned suite asserts the legacy id
   structurally (~30 `toContain("FAIL [F-OPAQUE]")`, five
   `rule === "F-OPAQUE"` JSON assertions, two `not.toContain`). Those
   constraints are jointly unsatisfiable by a strict swap, which is exactly
   why `GOV-1B` `follow_up` 5 required the test update **in the same
   change**. Rather than break the gate, break the path rule, or return the
   item untouched, the rename was executed on every free surface (human lead
   id, summary, `doc:` citation, help, JSON `contractRule`) with the alias
   left as the machine `rule` field, and the contract row now defines the
   residual swap as a single tooling change (tool + pinned suite together).
   The reviewer should judge whether this middle course was right; the two
   rejected alternatives are named above.
2. **Item 7 went beyond its literal wording by closing U-6 and amending
   ADR-009.** The packet's item 7 asks for "the register rows for WP-110's
   non-confirmations"; `WP-110` `follow_up` 2 — the same handoff section —
   also owed the register's owner the U-6 closure and the ADR-009 §5.2
   marker-lifting. Adding the three non-confirmation rows while leaving the
   same pass's confirmation row stale would have left a false "Not
   confirmable / WP-110 must verify" standing in the register
   (`protected-contracts.md` §4: leaving a false statement standing is worse
   than an edit; the `GOV-1B` deviation-3 precedent). The ADR-009 amendment
   is the **second use of the `docs/adr/README.md` bounded venue-fact
   exception** (a ratifying record of a work package's *mandated*
   verification); the amendment text walks all four conditions, and the
   README's "only use" sentence is corrected. **This deserves the reviewer's
   specific attention**, and both edits are severable if judged out of scope.
3. **§6.1 item 4 was closed by writing two new numbered rules (F15/F16)**
   rather than re-registering it. "Close what is closable by documentation"
   is the packet's instruction and §6.1 item 4's own rule demands the cited
   row exist before implementation; but a new forbidden-edge row is new
   contract surface, so it is flagged: F15's basis is the frozen `domain.md`
   §1 allowlist; F16's basis is the verified fact that all 28 workspace
   packages declare `exports` maps plus platform encapsulation. Neither is
   implemented in the check (stated in both rows); both are severable.
4. **The register gained dated annotations beyond the new rows** — the
   C-1/U-1 row's source-index-debt note and the dispute row's re-check
   annotation — both in-place factual updates to open/closed register rows
   under §4, not reinterpretations.
5. **`domain.md` §10's addition is a second dated table, not rows appended
   to the `WP-030` table**, so the original table remains verbatim what
   `WP-030` wrote and the additive boundary (R-7a: "additive rows only") is
   visible in the file itself.
6. **The 2d mutation probe ran in the live worktree, not a copied
   workspace.** The tool needs the whole workspace shape (manifests,
   contract, `node_modules` TypeScript) to run, so a faithful scratch copy
   is the worktree itself; the probe was a single added file, deleted after,
   with `git status` shown empty for the package. The handoff quotes the
   full sequence so the reviewer can replay it in three commands.

## known_risks

1. **The dual-id state in the check's JSON output is a standing sharp edge.**
   Until the tooling follow-up lands, a JSON consumer that keys on `rule`
   sees `F-OPAQUE` while the human output says `F14`; the contract row and
   the tool's help text both document it, and `contractRule` exists precisely
   so new consumers key on the contract id — but a grep-based consumer of
   the *human* output looking for the legacy id will now match only the
   `id:` traceability line.
2. **The §6.1 item-1 tripwire is a governance promise, not a mechanism.**
   Nothing detects "an escape class the enumerations do not catch" except
   the next adversarial reviewer; if one is found and the closing change
   does not adopt the total rule, only the contract text convicts it.
3. **The UUID refusal (item 1) is a rule about surfaces that do not exist
   yet.** Its first real test comes with the control API / config surfaces;
   a future implementer who finds refusal too strict must supersede, not
   soften — the reopen condition is written for exactly that argument.
4. **ADR-017 pins per-`v1` digest coverage.** If a WAL v2 lands and its
   author misses §1.1's same-change amendment duty, a compactor could carry
   a stale coverage assumption; the binding sentence exists, but nothing
   mechanical enforces it.
5. **The venue re-issue is bounded, and its boundedness could be misread.**
   `verified-2026-09-02.md` states three times that it does not discharge
   the phase-gate re-verification; a reader citing it as "the current full
   report" would still over-claim. The frozen 2026-08-24 report remains the
   baseline for everything off the five-item list.
6. **U-11's "do not parse" has no enforcement point yet** — no shipped code
   reads `umaResolutionStatus`. The row exists so the first package that
   touches the market-by-id surface inherits an obligation instead of a
   temptation.
7. **This round ruled on implementations it could not modify or test**
   (compactor, evaluator, gateway, apps). Conformance statements were
   established by reading shipped code and merged handoffs; where the ADRs
   pin behavior, the pins were checked against the cited sources on
   2026-09-02, not re-executed.

## follow_up

1. **Tooling package owning `tools/check-dependency-direction.mjs` AND
   `test/unit/tooling/dependency-direction.test.ts` (one change):** swap the
   machine `rule` field to `F14` and the suite's pinned assertions together
   (drop or keep `contractRule` as it sees fit, updating §3 F14 consequence
   3); in the same or a sibling change, implement §3 **F15** and **F16** in
   the check (both rows exist and say "not yet implemented").
2. **`WP-220` (first strategy package):** tests are inside the purity scan
   (§6.1 ruling 2) — manual clocks, module-import fixtures; a need that
   cannot be met that way is a cited contract change first.
3. **Every future adversarial review of a purity-restricted package:** the
   §6.1 item-1 tripwire — a new escape class mandates the total
   callee-resolution rule in the closing change.
4. **Next full venue-verification round (phase-3 start gate):** the
   resolution page and the market-by-id page into the source index
   (`verified-2026-09-02.md` §7); re-verify the five bounded items as part
   of the full pass; C-4's next re-check is already scheduled there.
5. **Whichever package first consumes the market-by-id surface:**
   `umaResolutionStatus` is opaque (U-11) until a vocabulary is documented.
6. **`WP-300` / settlement accounting:** U-10 — the `CANCELLED` refusal
   stands until the venue documents a mechanic; lifting it needs that
   evidence plus an ADR-009 amendment.
7. **`apps/trader` and later runnable apps:** follow ADR-018 (bundle
   per app; disclose a forced CJS choice).
8. **Replay/backtest owners (`WP-210`, `WP-230`):** parse `causationId` per
   `domain.md` §11.1 only; treat unregistered prefixes as opaque.
9. **Orchestrator:** record this round in `IMPLEMENTATION_STATUS.md` (the
   eight items; R-7/R-8 closed; U-6 closed; U-10/U-11/U-12 opened; LOW-2
   retired; the §5 precedent row), and schedule follow-up 1 as a small
   bounded tooling package.

## commit_sha

Two commits on branch `worktree-agent-af74389cafb5f2d46`, both based on
`4f20acf77e0bdbb51537303b71ef3ceab95e6d0a`: the implementation commit
(everything above including this handoff), then a SHA-record commit that
writes the implementation SHA into this table — a commit cannot contain its
own hash.

| Commit | SHA |
| --- | --- |
| governance round (the three ADRs, the amendments, the registers, the venue re-issue, the comment-only domain edits, the tool edit, this handoff) | `573a8a1498e4cc841ff643a06be3c81de681501f` |
| SHA record (branch tip) | reported in the agent's reply |

**The branch tip is the commit to review.**
