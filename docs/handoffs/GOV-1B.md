# GOV-1B — contract-owner governance round after Wave 1 batch 1B

- **Package:** `GOV-1B`, an orchestrator-authorized bounded governance package
  (`IMPLEMENTATION_STATUS.md`; the mechanism is
  `docs/contracts/protected-contracts.md` §3.1, on the 2026-08-26 Wave-0-closeout
  precedent, now recorded as a §5 precedent row of its own).
- **Base:** `7b7694370cd6c71c233fff17db8f55adc14c36b1` (`main` tip; all of batch 1B
  merged). Verified before editing.
- **Branch:** `worktree-agent-a2fda1388250a1546`, isolated worktree.
- **Date:** 2026-08-28.
- **Review:** independent adversarial review is required before merge. The
  implementing agent did not review its own work (`AGENTS.md`).
- **Scope discipline:** this round **rules**; it does not implement. No adapter,
  test, app, database, root config, or lockfile was touched. Divergences found in
  shipped code became recorded follow-ups, not edits.

---

## Item 1 — Ratify C-1 / U-1 (book `price_change` absolute size, zero removal)

**Evidence.** Re-fetched the confirming page **myself** on 2026-08-28, read-only
and unauthenticated, independently of `WP-070`'s 2026-08-27 retrieval:

```text
curl -sS -L https://docs.polymarket.com/api-reference/wss/market.md
→ HTTP 200, 44 794 bytes, no redirect
```

Verbatim strings located in the served AsyncAPI document (line numbers are into
the retrieved document):

| Quote | Where |
| --- | --- |
| `New aggregate size (0 means level removed)` | `price_change` → `price_changes[].size`, at **two** places (the payload and the message schema) |
| `Price level affected` | `price_change` → `price_changes[].price` |
| `Delta update to orderbook price levels when an order is placed or cancelled` | the `price_change` operation |
| `Orderbook price level delta update` | the `price_change` payload |
| `Full orderbook snapshot sent on subscribe or after a trade` | the `book` operation |
| `Aggregated buy orders by price level` | `book` → `bids` |
| `Total size at this price level` | `book` → `bids[].size` / `asks[].size` |
| `Hash of the orderbook content` | `book` → `hash` |

The page has **not** drifted from what `WP-070` recorded; every quote in its
handoff is present verbatim. The `WP-070` round-1 reviewer's caveat — it
confirmed the delta semantics but "could not extract the exact nested quote
through its extractor" — is **closed by this fetch**, which read the nested
`price_changes[].size` description directly, at both occurrences.

**Ruling.** `price_change` carries the **new aggregate size** at the named level;
`"0"` removes the level. "Delta" names *which levels are reported*, not
arithmetic: a consumer **replaces** the level's size and never adds or subtracts.
C-1/U-1 are **closed**; `WP-150` may treat this as truth. The confirmation is
**documentary, not observational**, and the fact stays volatile (handoff §1.2).
No emitted field set changed, so **`schemaVersion` is unchanged**.

**Files changed.**

- **New** `docs/adr/ADR-013-book-price-change-absolute-size-confirmed.md` — the
  ratification, with quotes, dates, limits, and the §8.4 remedy restated.
- `docs/adr/ADR-002-…md` §8 — a **dated amendment block** recording that its own
  §8.3 condition is discharged. The original §8.1–§8.4 text is left exactly as
  written; the matching Consequences bullet is marked discharged in place; the
  header gains an amendments change log.
- `docs/adr/ADR-012-…md` §5.8 — the same treatment (its text "is **not
  documented**" had become false). Two obligations restated: a pre-2026-08-28
  simulation report keeps the marker it was produced under, and the confirmation
  is not observational.
- `docs/adr/README.md` — index row; plus a **narrow, bounded exception** to the
  "an ADR does not fetch venue documentation" rule, for a *ratifying* ADR
  recording a fact a work package's **mandated** verification obtained from
  current official documentation (four conditions, all met here). See
  `deviations` 1.
- `docs/contracts/protected-contracts.md` §8 — the C-1/U-1 row rewritten as
  **CLOSED**, with evidence, the ADR, the `WP-150` release, and the two limits;
  §8's preamble gains the rule that a `CLOSED` row is settled behavior and stays
  in the table for the audit trail.
- `packages/domain/src/events/book.ts` — **comment-only**: the module-header
  UNVERIFIED block and the `size` field marker replaced with the confirmed
  status, the quotes, the citation, and the surviving obligations. Hash proof
  below.

**Follow-ups recorded.** The citing page is **not in the frozen report's source
index**; the next dated verification report owes it (ADR-013 §6; `WP-070`
`follow_up` 3 already asks for the re-issue).

---

## Item 2 — Rule the `takerSide` vocabulary

**Evidence (read in shipped code on 2026-08-28, not taken from handoffs).**

| Package | Function | Behavior |
| --- | --- | --- |
| `packages/polymarket-public/src/normalize/values.ts` | `normalizeVenueSide` | `"BUY" → "BID"`, `"SELL" → "ASK"`, anything else invalid. The venue field is documented **"From taker's perspective"** (verified in my own fetch of the market-channel page, `last_trade_price.side`, `enumValues: [BUY, SELL]`) |
| `packages/coinbase-adapter/src/normalize.ts` | `takerSideFromDocumentedMakerSide` | `{ SELL: "BID", BUY: "ASK" }` over the documented **maker** side; unknown → omitted plus an anomaly; raw value preserved as `venueDetail.venueSide` with `venueSideMeaning: "MAKER"` |
| `packages/binance-adapter/src/normalize.ts` | `takerSideFor` | `OMIT` (default) → absent; `TAKER_ORDER_DIRECTION` → `m=true → "ASK"`; `BOOK_SIDE_CONSUMED` → `m=true → "BID"` |

**Ruling (ADR-014).** `takerSide` names the **aggressor order's own side**:
**`BID` ⇔ the taker was buying**, **`ASK` ⇔ the taker was selling**. It is **not**
the side of the book consumed — a buying taker consumes resting *asks* and is
still `BID`. Equivalently, it is the side the taker's order would have rested on.
Per-venue mappings are tabulated so an adapter test can be written from them,
including Binance's `m = true → ASK`. Absence rules are unchanged (omit rather
than guess; unknown wire value is first-class UNKNOWN); a value may **not** be
emitted under any other convention. The field is **not renamed** (`WP-070`
`follow_up` 2's `takerOrderSide` option is declined, with the reason).
`schemaVersion` unchanged.

**Conformance verdicts.**

- **`WP-070` CONFORMS** — the ruling adopts the convention it shipped.
- **`WP-090` CONFORMS** — maker `SELL → BID` is exactly "the taker was buying".
  **No remediation is owed**, and its own `U-CB-3` risk (is Coinbase's `side`
  really the maker's?) is untouched and still open on its own merits.
- **`WP-080` conforms by omission**, and carries **one non-conforming reachable
  path**: `BOOK_SIDE_CONSUMED` now emits the inverse of a ruled meaning.

**Files changed.** New `docs/adr/ADR-014-taker-side-names-the-aggressor-order-side.md`;
`docs/adr/README.md` index row; `docs/contracts/protected-contracts.md` §8.1 new
row **R-6** (closed, with both follow-ups named).
`docs/contracts/domain.md` was **not** edited — see `deviations` 2.

**Follow-ups recorded.**

1. **MANDATORY, bounded, `packages/binance-adapter`** — map `m` under the ruling,
   **remove `BOOK_SIDE_CONSUMED`** (or make it unreachable), state whether the
   default becomes the mapping or stays `OMIT`, and close `BNC-U5` in the
   package's venue-fact table. Before any consumer wires `takerSide`.
2. The ruling is not yet visible at the code site
   (`packages/domain/src/events/{book,reference}.ts`): a comment-only pointer is
   owed by the next bounded package owning `packages/domain/**` (register row
   **R-7**).

---

## Item 3 — Reconcile the `ConditionIdSchema` cap with §9

**Evidence.** `packages/domain/src/primitives.ts`: `MAX_IDENTIFIER_LENGTH = 200`,
`NonEmptyStringSchema = z.string().min(1).max(MAX_IDENTIFIER_LENGTH)`;
`identifiers.ts`: `ConditionIdSchema = VenueIdentifierSchema = NonEmptyStringSchema`.
`docs/contracts/domain.md` §7 states the bound's purpose verbatim: "These bounds
are **not venue facts**. They are boundary hygiene for a process that parses
untrusted frames, and they keep metric-label cardinality and database column
widths predictable." The venue report §7.1 records that the SDK "validates hex
syntax without constraining the condition ID byte length". `WP-070` ships ≤ 200
accepted / > 200 refused as a typed `INVALID_CONDITION_ID` problem carrying the
raw frame, asserted at 4/42/66/98/200 accepted and 201 rejected.

**Ruling (ADR-015).** The 200-character cap is a deliberate **repository-wide
boundary-hardening** decision, not a venue-fact narrowing — a real condition id
is 66 characters, so the bound rejects nothing real (which is exactly what
distinguishes it from the 31/32-byte narrowing, which would have). The rule is
reworded to: **no 31/32-byte narrowing; accept any SDK-accepted hex id up to the
repository identifier bound (`MAX_IDENTIFIER_LENGTH` = 200, ADR-015); beyond it a
typed refusal is the correct adapter behavior** — never truncation, silent drop,
or a frame-losing throw. The bound applies to *every* identifier-like domain
string. Raising it later requires an ADR **and** a bounded repair package owning
`packages/domain/**` **and** a stated `schemaVersion` consequence. `WP-070` is
ratified as conforming and its "in substance, not literally" caveat is
superseded. **I did not judge the cap wrong**, so no domain-modifying follow-up
is raised for it.

**Files changed.** New `docs/adr/ADR-015-repository-identifier-bound.md`;
`docs/adr/ADR-002-…md` §7 condition-id row reworded in place with a dated
amendment note; `docs/contracts/protected-contracts.md` §9 second bullet reworded
the same way, plus new register row **R-5** (closed); `docs/adr/README.md` index
row.

**Follow-ups recorded.** None owed. The residual is stated as a known risk: a
201-character identifier is data loss by policy, loudly and with the frame
preserved.

---

## Item 4 — Ratify the four R-3 inferred shapes

**Evidence.** `docs/contracts/protected-contracts.md` §8.1 **R-3** and its own
disposition ("each needs an ADR to accept it as decided, amend it, or record it
as provisional", owned by "the next ADR-modifying package, or an orchestrator
governance round"); `docs/contracts/domain.md` §8's four rows; the frozen code
(`TokenIdSchema`'s `^(?:0|[1-9][0-9]*)$`; `UUID_PATTERN`/`UUID_V7_PATTERN`
lowercase with pinned version/variant nibbles; `IncidentSeveritySchema =
z.enum(["LOG","NOTIFY","PAGE"])`); and handoff **§14.4**, read for this record —
it defines exactly three alert tiers, **Page / Notify / Log**, which is what makes
the severity vocabulary a reuse rather than an invention.

**Ruling (ADR-016).** All four **accepted as decided**, each with the reason it is
right rather than merely shipped, the consequences that bind, and what would have
to be true to reopen it. The payload-field-set row is ratified **as a design
decision** with five stated boundaries — notably that ratifying the design is not
ratifying every field as correct, and that it grants **no** additive-field
exemption from ADR-002 §3. No code changed; `schemaVersion` unchanged.

**Files changed.** New `docs/adr/ADR-016-ratified-inferred-domain-shapes.md`;
`docs/contracts/protected-contracts.md` §8.1 **R-3** → DONE-by-ratification with
the ADR named; `docs/adr/README.md` index row. `docs/contracts/domain.md` **not**
edited — R-3 directs exactly that.

**Follow-ups recorded.** `domain.md` §10's cross-reference table does not yet name
ADR-013–016 (register row **R-7**, owned by the next package owning that file).

---

## Item 5 — `WP-015` contract follow-ups (`dependency-direction.md`)

**Parser read first.** `tools/check-dependency-direction.mjs` parses §2 and §2.1
from this document **at run time**: `### Layer <n> — …` subsections assign a
package by (a) a backticked path in a table row's first cell, (b) a path token
inside a fenced block, or (c) the prose form `` `<path>` … member of this layer ``;
§2.1 rows need ≥ 3 cells with `` `from` → `to` `` and a numeric layer. A package
assigned **twice** — including once by fence and once by prose — is a `CHK`
error, and every §2.1 row must parse and cross-validate against §2.

**(a) §2/§2.1 machine-readable in place** (`follow_up` 1). The
`packages/strategies/**` class entry moved from prose **into the Layer 1 fence**,
and the surrounding prose was rewritten so it no longer matches the prose form —
otherwise the package would be assigned twice and the gate would fail. §6 gained
a table stating exactly which shapes the check parses and the two edit hazards
that fail closed.

**Mutation proof that the new form is load-bearing:** deleting the fence line
makes `pnpm check:deps` fail with **two** errors — `CHK` (§2.1 row S2 names a
class §2 classifies nowhere) and `F-CLOSED`
(`packages/strategies/static-bracket` unclassified). Restored; the check passes
again. The §2.1 rows S0/S1/S2 are byte-identical to base, so the three
`test/unit/tooling` mutation tests that anchor on their exact text still apply.

**(b) F-OPAQUE numbered** (`follow_up` 6). Added as **F14** in the §3 table, with
its source stated as §5.2 + ADR-005 §1 read as intent, plus three explicit
consequences: it forbids *holding* the capability (not only using it); it is
deliberately noisy for contrived wrapping (noisy-never-silent); and the check
emits it under the pre-existing id `F-OPAQUE`, which is recorded as an accepted
alias — **renaming the id in the tool and its tests is a tooling follow-up, not a
contract change**, and is not done here because `tools/**` and `test/**` are
forbidden paths for this package. `F-CLOSED` and `CHK` are documented as *not*
rules of §3.

**(c) Stale §5/§6 owner text** (`follow_up` 7). §5's "No automated
dependency-direction or cycle check exists yet" and "nothing today evaluates the
§2 layer assignment or the §2.1 edge list" are corrected in place with a new
table row naming the tool, the root script, and the CI step (verified: `check:deps`
in the root `package.json`, and the "Dependency direction and package boundaries"
step in `.github/workflows/ci.yml` between lint and unit tests). §6's title and
lead now say the check exists, and **Owner: not yet assigned** becomes
**Owner: `WP-015`** (merged).

**Finding of fact — no new §2.1 row is evidenced.** All three batch-1B adapters
(`packages/polymarket-public`, `packages/binance-adapter`,
`packages/coinbase-adapter`) declare exactly `@polymarket-bot/decimal` and
`@polymarket-bot/domain` (**layer 0**) as `dependencies`, and their
`devDependencies` are `@types/node`, `typescript`, `vitest` — **none a workspace
member**. **No adapter takes a `devDependency` on `packages/testkit` or on any
other layer-2 package**, so batch 1B created **no same-layer edge** and §2.1 is
unchanged. The `packages/testkit` case flagged in §2.1 remains unevidenced.

The §6 graph paragraph was **factually stale** as a result (it claimed "three
`workspace:*` dependencies" and "exactly two edges"); the check now counts **34
packages / 11 edges**. It is corrected in place with a per-edge table and the
finding of fact, per `protected-contracts.md` §4. See `deviations` 3.

**`follow_up` 8 recorded as open.** New **§6.1 "Open contract-owner items about
this document"** records the positive callee-resolution rule as **OPEN and
deliberately not implemented**, with the reason (it needs a numbered §3 rule
*and* it flags every dynamically-dispatched call in a restricted package, which
is contract-level policy, not a tooling preference). §6.1 also records
`follow_up` 2 (do rule-3 scans apply to a strategy's own tests?), `follow_up` 9
(computed property reads), `follow_up` 3/4 (deep imports; `packages/decimal`'s
allowlist), and the fact that `test/unit/tooling/dependency-direction.test.ts`
pins the allowlist ids to `["S0","S1","S2"]`, so adding a §2.1 row requires
changing that test in the same change. See `deviations` 4.

---

## Comment-only proof for `packages/domain/src/events/book.ts`

Method: the Wave-0-closeout method — transpile base and working versions with the
repository's own `typescript` and `removeComments: true`, compare.

```text
tool     node_modules/typescript 5.9.3 (the repository's own)
options  { removeComments: true, target: ES2022, module: ESNext }

base    7b76943  sha256 e281fcc53582dc151ec068b2256db46f0b02e068510a6a62250e7cd5539c762c  2380 bytes
after   working  sha256 e281fcc53582dc151ec068b2256db46f0b02e068510a6a62250e7cd5539c762c  2380 bytes
diff    byte-identical
```

Corroborating: every added or removed line in `git diff` for that file begins
with a JSDoc continuation ` *` — filtering those out leaves an empty diff. No
schema, type, export, or emitted field set changed, so **`schemaVersion` is
unchanged** (ADR-002 §3). The domain suite is untouched (no test file appears in
the diff) and passes unchanged.

---

## summary

Discharged the five contract-owner items Wave 1 batch 1B accumulated, as four new
accepted ADRs plus dated in-place amendments and register updates:

- **ADR-013** ratifies C-1/U-1 (absolute aggregate size, `"0"` removes the level)
  after an independent re-fetch of the confirming official page; ADR-002 §8 and
  ADR-012 §5.8 are marked discharged, the §8 register row is CLOSED, and the
  frozen `book.ts` markers now read CONFIRMED (comment-only, hash-proved).
- **ADR-014** rules that `takerSide` names the **aggressor order's own side**
  (`BID` = the taker was buying). `WP-070` and `WP-090` are verified conforming;
  a **mandatory** bounded follow-up is recorded for `packages/binance-adapter`.
- **ADR-015** rules the 200-character identifier bound a boundary-hardening
  decision and rewords the §9 / ADR-002 §7 narrowing rule so what `WP-070` ships
  is also the literal rule.
- **ADR-016** ratifies the four unratified `domain.md` §8 inferences, closing
  register item **R-3**.
- `dependency-direction.md` §2/§2.1 are made machine-readable in place (mutation-
  proved), `F-OPAQUE` is numbered **F14**, the stale §5/§6 owner text is
  corrected, and §6.1 records the open contract-owner items including `WP-015`
  `follow_up` 8, which is deliberately **not** implemented.

No code behavior changed anywhere; no `schemaVersion` moved; no safety default
was touched.

## files_changed

**New (4):**

| File | Purpose |
| --- | --- |
| `docs/adr/ADR-013-book-price-change-absolute-size-confirmed.md` | Item 1 ruling |
| `docs/adr/ADR-014-taker-side-names-the-aggressor-order-side.md` | Item 2 ruling |
| `docs/adr/ADR-015-repository-identifier-bound.md` | Item 3 ruling |
| `docs/adr/ADR-016-ratified-inferred-domain-shapes.md` | Item 4 ruling |

**Modified (6):**

| File | Change |
| --- | --- |
| `docs/adr/README.md` | four index rows; the bounded venue-fact exception for a ratifying ADR |
| `docs/adr/ADR-002-event-envelope-and-ordering-semantics.md` | §7 condition-id row reworded (ADR-015); §8 dated amendment (ADR-013); Consequences bullet marked discharged; header change log |
| `docs/adr/ADR-012-simulation-fill-model-evidence-hierarchy.md` | §5.8 dated amendment; header change log |
| `docs/contracts/protected-contracts.md` | §5 precedent row for this round; §8 preamble `CLOSED` rule + C-1/U-1 row; §8.1 R-3 done-by-ratification and new rows R-5/R-6/R-7; §9 condition-id bullet reworded |
| `docs/contracts/dependency-direction.md` | §2 class entry into the fence; §3 new **F14**; §5 enforcement table row + correction; §6 title/lead/graph facts/parsed shapes/owner; new §6.1 |
| `packages/domain/src/events/book.ts` | **comment-only** C-1/U-1 markers → CONFIRMED (hash-proved) |

Plus this handoff, `docs/handoffs/GOV-1B.md`.

**Not touched** (verified by `git diff --name-only 7b76943..HEAD`): every package
except the comment-only `book.ts` line range, all of `tools/**`, `test/**`,
`apps/**`, `db/**`, `.github/**`, root configs, `pnpm-lock.yaml`,
`IMPLEMENTATION_STATUS.md`, the workplan, and
`docs/venue/verified-2026-08-24.md`.

## tests_run

| Gate | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | exit 0; lockfile untouched (no dependency changed) |
| `pnpm typecheck` | exit 0, all packages |
| `pnpm lint` | exit 0 |
| `pnpm test` | exit 0 — **2250 passed / 2250**, 72 files. No test file changed; the domain suite is untouched |
| `pnpm check:deps` | exit 0 — 34 packages, 11 edges, allowlist S0/S1/S2 |
| `pnpm ops:verify-venue` | exit 0 — report validation OK, overall PASS |
| `book.ts` stripped-transpile hash | **identical** (see the proof section) |
| Contract mutation probe (extra) | removing the new fence class entry makes `check:deps` fail `CHK` + `F-CLOSED`; restored and passing |

**Not run and not claimed:** `pnpm test:compose`, `pnpm audit` (no dependency
changed), and any soak, execution probe, live gate, or observational venue claim.
The only network access was the single read-only documentation fetch in item 1.

## assumptions

1. `IMPLEMENTATION_STATUS.md` is orchestrator-owned; this round records its
   register/ADR changes here and in `docs/contracts/**`, and leaves that file for
   the orchestrator (including retiring "contract-owner items 1–3" and the
   `GOV-1B` row).
2. The dispatch packet's list of five items is the whole scope. Adjacent open
   register items were **not** ruled on — in particular **R-2** (the SDK-anchor
   mechanism, assigned to `WP-070`), which may now be dischargeable but was not
   in this packet.
3. "Current official Polymarket documentation" for item 1 means the page
   `WP-070` cited, re-fetched. I did not attempt to enumerate other pages that
   might contradict it beyond the two corroborating pages `WP-070` lists.
4. `docs/adr/**` numbering continues from ADR-012, per `README.md` (ADR-001–012
   are reserved by handoff §20).
5. The Binance mapping in ADR-014 §3 follows from Binance's documented `m`
   ("Is the buyer the market maker?") as recorded by `WP-080`; I did not re-fetch
   Binance's documentation, and the ruling does not depend on it — if `m`'s
   meaning were different, the ruling stands and that row changes.

## deviations

1. **`docs/adr/README.md` gained a bounded exception to its own "an ADR does not
   fetch venue documentation" rule.** Ratifying C-1/U-1 *is* recording a venue
   fact from a page the frozen report does not index, which the rule as written
   forbids. Rather than violate it silently or refuse a ratification the workplan
   mandated, the exception is written down with four conditions (handoff §1.1
   precedence; URL + date + verbatim quotes and documentary-vs-observational
   honesty; the frozen report still cited and unedited; the gap still recorded).
   **This is a governance-rule edit and deserves the reviewer's specific
   attention.**
2. **`docs/contracts/domain.md` was not edited at all.** The packet allowed a
   minimal additive clarification for item 2 "only if strictly required", and
   preferred the ADR as the ruling's home. It is not strictly required — ADR-014
   §1–§3 is precise enough for an adapter test — so the file is untouched, and
   the two documentation residues (its §10 map, and a comment-only pointer in the
   frozen event modules) are registered as **R-7** instead of being left implicit.
3. **Two in-place factual corrections beyond the literal follow-up text**, both
   inside allowed paths and both because leaving a false statement standing is
   worse than an edit (`protected-contracts.md` §4): the §6 graph paragraph
   ("three `workspace:*` dependencies … exactly two edges" → 34 packages / 11
   edges, with a per-edge table), and ADR-002's Consequences bullet about the
   book contract.
4. **§6.1 records five open items, not only `follow_up` 8.** The packet named
   item 8; adding `WP-015`'s other genuinely-open contract-owner questions (2, 3,
   4, 9) to the same table costs nothing and serves the register's own rule that
   an unwritten item is an unowned item. Nothing about them is *decided* here.
5. **F14's id is not aligned in the tool.** The contract row records `F-OPAQUE`
   as an accepted alias and names the rename as a tooling follow-up, because
   `tools/**` and `test/**` are forbidden paths for this package. A reader of the
   check's output therefore sees `F-OPAQUE`, not `F14`, until that lands.

## known_risks

1. **Item 1 rests on one vendor page, which has already moved once.** The URL the
   2026-08-24 report cites now redirects; the confirming AsyncAPI page is newer
   than the frozen report and outside its source index. If it disappears without
   a successor, the item should reopen rather than rest on a quote in an ADR.
   Mitigation: ADR-013 §6 makes the next verification round own it.
2. **The confirmation is documentary.** Nothing in the repository has *observed*
   a `price_change` frame. A venue whose documentation is wrong would now be
   believed by `WP-150`. Mitigation: ADR-002 §8.4's new-`schemaVersion` remedy is
   restated in three places, and the snapshot/hash reconciliation discipline is
   unchanged.
3. **ADR-014 makes `WP-090`'s `U-CB-3` risk sharper, not safer.** If Coinbase's
   `side` is not the maker's side, every Coinbase `takerSide` is inverted — and
   it is now inverted *against a defined meaning*, so cross-venue features would
   combine it with correctly-signed Polymarket data. The mitigation is the one
   `WP-090` already built (one named function, raw value preserved), plus its
   open validation follow-up.
4. **`packages/binance-adapter` currently exposes a reachable non-conforming
   path** (`BOOK_SIDE_CONSUMED`). Nothing consumes it today and the default is
   `OMIT`, but the mandatory follow-up must land before any consumer wires
   `takerSide`.
5. **A 201-character venue identifier is refused by policy.** Remote, but it
   would stop the affected market rather than degrade. ADR-015 §6 is the only
   route to raise the bound and requires a `schemaVersion` statement.
6. **The `dependency-direction.md` §2/§2.1 tables are program input.** They are
   now more explicit, but the parser still recognises an enumerated set of
   Markdown shapes. §6's new "shapes the check parses" table reduces, and does
   not remove, the risk that a well-meaning reformat breaks the gate. It fails
   closed when it does.
7. **This round ruled on adapters it could not test.** Conformance verdicts were
   established by reading shipped code and its tests, not by executing new
   assertions against the ruling — writing those tests is the adapters' packages'
   work, in forbidden paths here.

## follow_up

1. **MANDATORY — `packages/binance-adapter` owner (bounded package):** bring the
   adapter under ADR-014 — map `m` (`true → ASK`, `false → BID`), **remove
   `BOOK_SIDE_CONSUMED`**, state the default, close `BNC-U5`. Before any consumer
   wires `takerSide`. (Register **R-6**.)
2. **Next bounded package owning `packages/domain/**`:** comment-only pointer to
   ADR-014 on `takerSide` in `book.ts` and `reference.ts` (hash-proved, no
   version bump). (Register **R-7b**.)
3. **Next package owning `docs/contracts/domain.md`:** add §10 cross-reference
   rows for ADR-013–ADR-016. Additive only. (Register **R-7a**.)
4. **Next venue-verification round:** re-verify the `price_change` semantics and
   put `https://docs.polymarket.com/api-reference/wss/market` in the new dated
   report's source index; also carries `WP-070` `follow_up` 3 (the `GET /book`
   OpenAPI and the bid/ask-ordering contradiction).
5. **Tooling package owning `tools/check-dependency-direction.mjs`:** rename the
   emitted rule id `F-OPAQUE` → `F14` (contract §3), updating
   `test/unit/tooling/dependency-direction.test.ts` in the same change; or record
   the alias as permanent.
6. **Contract owner, next round:** decide `dependency-direction.md` §6.1 items 1–4
   — above all `WP-015` `follow_up` 8's positive callee-resolution rule, which is
   the only durable fix for F14's residuals and needs a numbered §3 row plus
   acceptance of its noise trade-off.
7. **Orchestrator:** record this round in `IMPLEMENTATION_STATUS.md` (contract-
   owner items 1–3 discharged; register R-3/R-5/R-6 closed, R-7 open; the
   mandatory `WP-080` follow-up scheduled), and reflect the new
   `protected-contracts.md` §5 precedent row.
8. **`WP-150`:** may now build on the confirmed book semantics (ADR-013), and
   should assert the replace-not-accumulate rule (ADR-013 §2) in its own tests.

## commit_sha

Two commits on branch `worktree-agent-a2fda1388250a1546`, both based on
`7b7694370cd6c71c233fff17db8f55adc14c36b1`:

| Commit | SHA |
| --- | --- |
| governance round (the four ADRs, the amendments, the registers, the comment-only `book.ts` edit, this handoff) | `be45ad3c7a4d0aff2c6f2a29c7a5cc2a7507202a` |
| SHA record (branch tip) | reported in the agent's reply |

A commit cannot contain its own hash, so the first commit's SHA is written by the
second, whose tree differs from it only in this table. **The branch tip is the
commit to review.**
