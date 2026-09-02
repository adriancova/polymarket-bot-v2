# Protected contracts and change control

Owner: `WP-030`
Authority: `docs/spec/polymarket-bot-orchestrator-handoff.md` §1.1, §1.3, §5.1,
§18; `docs/spec/polymarket-bot-workplan.yaml` (`protected_paths`,
`required_handoff_fields`); `AGENTS.md`
Related: [`domain.md`](./domain.md) §9,
[`dependency-direction.md`](./dependency-direction.md),
[`docs/adr/README.md`](../adr/README.md)

---

## 1. What "protected" means

A protected path is a **shared integration surface**. More than one work package
depends on it, so a unilateral change there is not a local decision — it is a
change to everyone else's assumptions.

Handoff §5.1:

> Each work package declares allowed paths. A subagent must not modify another
> package's owned path without orchestrator approval. Shared contracts in
> `packages/domain`, database migrations, and root configuration are protected
> integration surfaces.

`AGENTS.md` restates the operative half: "Do not modify shared contracts merely
to make local implementation easier", and handoff §18.3: "Do not edit protected
contracts to make local code easier."

## 2. The protected paths

Verbatim from `docs/spec/polymarket-bot-workplan.yaml` → `protected_paths`:

| Path | Why it is protected | Frozen? |
| --- | --- | --- |
| `packages/domain/**` | The versioned contracts every package consumes | **Yes** — frozen on `WP-020` acceptance |
| `packages/decimal/**` | The exact-decimal foundation and the canonical hash | **Yes** — frozen on `WP-020` acceptance |
| `db/migrations/**` | The persisted schema and its constraints; migrations are forward-only history | Not yet written (`WP-040`) |
| `docs/adr/**` | The accepted architecture decisions themselves | **Yes** — see §4 |
| `pnpm-lock.yaml` | Exact, reproducible dependency resolution for every package | Mechanical updates only, ratified per §5 |
| `package.json` (root) | Workspace scripts, engines, and the shared gate entry points | Root-owned |
| `tsconfig.base.json` | Repository-wide TypeScript strictness | Root-owned |
| `docker-compose.yml` | Local infrastructure baseline | Root-owned |
| `eslint.config.mjs` | The root lint gate for every package (ratified 2026-08-23) | Root-owned |

Two more surfaces behave as protected even though they are not in that list, and
are recorded here so the rule is not discovered the hard way:

| Path | Rule |
| --- | --- |
| `docs/venue/verified-YYYY-MM-DD.md` | After merge, a verification report is a **frozen dated snapshot**. A new verification round writes a **new dated file** (handoff §1.2); it does not edit a merged one. Pre-merge remediation of an in-flight report is normal and is what produced the 2026-08-26 amendments inside `verified-2026-08-24.md`. |
| `docs/handoffs/WP-<ID>.md` | The auditable record of a completed package. Amended only by that package's own remediation rounds, before merge. |

`IMPLEMENTATION_STATUS.md` is **orchestrator-owned**. It appears in several work
packages' `allowed_paths`, but in practice the orchestrator records completion,
review verdicts, and deviations. An implementing agent should leave it alone
unless its packet explicitly says otherwise — `WP-000`, `WP-020`, and `WP-030`
were all instructed not to touch it.

## 3. What a change to a frozen contract requires

For `packages/domain/**` and `packages/decimal/**`
([`domain.md`](./domain.md) §9):

1. An **accepted ADR** under `docs/adr/`.
2. **Orchestrator approval** and a work package that owns the path.
3. An explicit statement of the **schema-version consequence for recorded data**
   (ADR-002 §3: every change to an emitted field set increments `schemaVersion`,
   and old versions stay registered).

The following are specification changes, not implementation details, and may
never be done to make a local implementation easier:

- weakening a canonicalization rule (ADR-001 §2–§4);
- accepting `number` for an economic field (handoff §7.3, ADR-001 §7);
- relaxing the strict-boundary decision or the strict-object decision
  ([`domain.md`](./domain.md) §3.2, §7);
- changing the canonical-hash domain tag, preimage layout, or hash-input grammar
  (ADR-001 §4 — requires a `v1` bump as well).

Strictly **additive** work — registering a contract for a genuinely new event
type, adding a new optional field under a new schema version, adding tests —
still requires orchestrator approval and path ownership, but does not by itself
reopen an accepted ADR ([`domain.md`](./domain.md) §9).

### 3.1 Who owns a frozen package after its authoring package closes

`WP-020` froze `packages/domain` and `packages/decimal` and then completed, so no
standing work package owns those paths. That is deliberate, not an oversight, and
it is **not** an answer of "nobody may touch them" — a defect in a frozen
contract still has to be fixable.

The answer, recorded here because Wave 0's architectural audit found it
unwritten (finding M2, 2026-08-26): **a post-freeze change to a protected package
is executed as an orchestrator-authorized bounded repair package.** Its shape is
fixed:

1. **A named, bounded scope.** The dispatch packet enumerates the findings to fix
   and the allowed paths, and ratifies them per §5. No adjacent redesign, no
   "while I was in there".
2. **The §3 gate in full.** An accepted ADR covering the change (an existing one
   if it already decides the point, a new one if it does not), orchestrator
   approval, and an explicit statement of the **schema-version consequence for
   recorded data** — including the statement "no emitted field set changed,
   therefore `schemaVersion` is unchanged" when that is the case (ADR-002 §3).
3. **An independent review gate.** The implementing agent may not review its own
   repair (§6; `AGENTS.md`), and the handoff record lands before merge.
4. **A handoff record** under `docs/handoffs/`, finding by finding.

The `docs/handoffs/wave-0-closeout-remediation.md` package is the first instance
and is the precedent to cite. It also fixes the boundaries of the mechanism: a
comment-only clarification inside a frozen file (the C-1/U-1 markers in
`packages/domain/src/events/book.ts`) is inside it — the change is verified
comment-only by diff and bumps no version — while any change to a schema, a type,
an emitted field set, or an arithmetic result is a contract change that needs its
own ADR statement even inside such a package.

A work package that *inherits* a protected path in its own `allowed_paths`
(`WP-070` and later packets that extend the contracts) uses the ordinary route in
§3 instead; this section is for the case where **no** package owns the path.

## 4. ADRs are themselves protected

`docs/adr/**` is a protected path, so:

- An accepted ADR is **not edited to reflect a changed decision**. It is
  superseded by a new record and its `Status` line points at the successor
  (`docs/adr/README.md` → Status vocabulary).
- Corrections of fact — a broken link, a wrong section number, a citation that
  does not support its claim — are made in place and noted, because leaving a
  false citation standing is worse than an edit.
- ADR-001 through ADR-012 are **reserved** by handoff §20 for their listed titles
  and may not be renumbered or repurposed.
- Any change here needs orchestrator approval and an owning work package.

## 5. The ratification mechanism (with precedent)

Path conflicts are expected: a package's mandated deliverable sometimes lives at
a path its literal `allowed_paths` does not name. The rule is **report, do not
silently edit** (`AGENTS.md`: "Report conflicts or missing information; never
silently invent venue behavior"; handoff §1.1: "No subagent may silently resolve
a conflict").

The mechanism, in order:

1. The implementing agent **reports** the conflict with evidence, rather than
   editing outside its packet or working around the deliverable.
2. The orchestrator **ratifies** by adding a **dated comment** above the entry in
   `docs/spec/polymarket-bot-workplan.yaml`, inside that package's
   `allowed_paths` (and `protected_paths` where the path is also a shared
   surface). The comment names the date and the reason.
3. The decision is **recorded** in `IMPLEMENTATION_STATUS.md`, under the package's
   completion record or under "Deviations from specification".
4. The implementing agent records it in its handoff under `deviations`.

Ratification is a **precedent**, not a one-off: a later package facing the same
shape of conflict cites the earlier ratification rather than re-litigating it.

### Precedents to date

| Date | Path | Package | Reason | Cited by |
| --- | --- | --- | --- | --- |
| 2026-08-23 | `eslint.config.mjs` | `WP-010` | ESLint flat config must sit at the repo root to serve the mandated lint gate; also added to `protected_paths` | the `pnpm-lock.yaml`/`WP-020` ratification |
| 2026-08-24 | `docs/venue/verified-2026-08-24.md` filename | `WP-000` | The workplan literal named `verified-2026-08-18.md` (plan-generation date), but handoff §1.2 requires the **actual verification date**; the literal is treated as a template | any future venue report |
| 2026-08-24 | `docs/handoffs/WP-000.md` | `WP-000` | Round-2 adversarial review finding M4: the complete structured handoff must be committed in-repo so independent review can verify it **pre-merge** (`WP-010` precedent) | `WP-020`, `WP-030` |
| 2026-08-26 | `pnpm-lock.yaml` | `WP-020` | Adding the package's own declared dependencies mechanically updates the root lockfile; permitted **for that purpose only** (explicitly citing the `eslint.config.mjs` precedent) | future packages adding declared dependencies |
| 2026-08-26 | `docs/handoffs/WP-020.md` | `WP-020` | In-repo handoff for pre-merge review (`WP-000` M4 precedent) | `WP-030` |
| 2026-08-26 | `docs/handoffs/WP-030.md` | `WP-030` | Same (`WP-000`/`WP-010`/`WP-020` precedent) | future packages |
| 2026-08-26 | An enumerated bounded set: `docs/adr/ADR-001*`, `docs/adr/ADR-002*`, both files in `docs/contracts/` named in §8.1, `packages/domain/src/events/book.ts` (**comment-only**), `packages/decimal/src/{tick,arithmetic,errors}.ts` + their tests, the single root `package.json` `ops:verify-venue` script line, `apps/ops-cli/package.json`, `apps/ops-cli/src/verify-venue/**`, `pnpm-lock.yaml` (mechanical only), `docs/handoffs/wave-0-closeout-remediation.md` | Wave 0 closeout remediation | The findings to repair sit in four protected surfaces that **no open work package owns** (`WP-020` and `WP-030` are both closed). Ratified in the dispatch packet, per §3.1, with the per-path narrowings stated in the packet itself | future bounded repair packages; `GOV-1B` |
| 2026-08-28 | `docs/adr/**` (new ADR-013–016 and dated in-place amendments to ADR-002 §7/§8, ADR-012 §5.8, and `README.md`), `docs/contracts/protected-contracts.md` (§5, §8, §8.1, §9), `docs/contracts/dependency-direction.md` (§2, §2.1, §3, §5, §6), `packages/domain/src/events/book.ts` (**comment-only**, hash-proved), `docs/handoffs/GOV-1B.md` | `GOV-1B` contract-owner governance round | The contract-owner items batch 1B accumulated (C-1/U-1 ratification, the `takerSide` vocabulary, the `ConditionIdSchema` cap, the R-3 inferences, the `WP-015` contract follow-ups) all land in protected surfaces **no open work package owns** — `WP-020`, `WP-030` and `WP-015` are all closed. Authorized in `IMPLEMENTATION_STATUS.md` and dispatched with an enumerated scope, on the §3.1 bounded-repair shape and the 2026-08-26 precedent above; independently reviewed before merge, and forbidden from editing any adapter it ruled on | future governance rounds |

Two lessons the precedents encode:

- A **protected** path may still be inside a package's `allowed_paths` for a
  bounded, stated purpose (`eslint.config.mjs`, `pnpm-lock.yaml`). "Protected"
  means *change-controlled*, not *untouchable*.
- A workplan literal that contradicts the handoff is resolved **in the handoff's
  favour**, and the resolution is written down rather than assumed (the venue
  report filename).

## 6. The handoff-record requirement

Every completed work package commits `docs/handoffs/WP-<ID>.md` **before merge**,
so an independent reviewer can verify the claims against the diff rather than
against a chat transcript. This began as a review finding on `WP-000`
(round-2, M4) and is now standing practice (`WP-010`, `WP-020`, `WP-030`).

Required fields — `docs/spec/polymarket-bot-workplan.yaml`
(`required_handoff_fields`) plus `AGENTS.md`:

```text
summary
files_changed
tests_run
assumptions
deviations
known_risks
follow_up
commit_sha
```

Rules that make the record worth reading:

- **The implementing agent may not perform the final adversarial review**
  (`AGENTS.md`; handoff §18.1). The record is input to review, not a substitute.
- Claims must be **precise**. `WP-020`'s round-2 review raised a LOW finding
  purely on handoff imprecision (a wrong file count, a negative-test matrix
  claimed wider than the tests, an imprecise description of a test-suite change).
  The fix was to make the claims true, not to narrow them.
- **Deviations are disclosed, including inconvenient ones.** `WP-000`'s record
  discloses a scope extension and a deliberate relaxation and flags both for the
  reviewer's verdict, plus a round-3→round-4 fact reversal recorded rather than
  quietly dropped.
- **No unearned claims.** No soak, execution probe, or live result may be claimed
  without real evidence (`AGENTS.md`; handoff §16.7).

## 7. Merge protocol

Handoff §18.4:

1. Subagent completes branch/worktree.
2. Subagent produces the required handoff.
3. Orchestrator reviews diff and test evidence.
4. **Verification subagent runs targeted adversarial review.**
5. Orchestrator merges.
6. Full typecheck and relevant integration suite run.
7. `IMPLEMENTATION_STATUS.md` and the task graph update.

Definition of done (§21) additionally requires: typecheck and lint pass, unit
tests pass, required integration/contract tests pass, **no forbidden dependency
direction is introduced**, **no economic field uses JavaScript `number`**, and
the handoff lists assumptions and deviations. "Code exists" is not equivalent to
"safe to trade."

## 8. Open venue-fact register

Venue facts are volatile (handoff §1.2) and the verification report is the
authority for them (`docs/venue/verified-2026-08-24.md`). The items below are
**open**: each is either an unresolved conflict between sources or a fact the
verification could not confirm. **None may be asserted as settled behavior.**

**One exception, added 2026-08-28:** a row whose Status begins **`CLOSED`**
names the ratifying ADR and the date, and *is* settled behavior. Closed rows stay
in this table rather than being deleted, because the audit trail — what was open,
who closed it, and on what evidence — is the point of the register. Everything
else in the table remains open, and the rule below still applies to it.

| Item | Status | Report section | Owned by | Recorded in |
| --- | --- | --- | --- | --- |
| **C-1 / U-1** `price_change` absolute-size and zero-removal semantics | **CLOSED 2026-08-28 by [ADR-013](../adr/ADR-013-book-price-change-absolute-size-confirmed.md).** Confirmed against current official documentation: `price_change.size` is the "New aggregate size (0 means level removed)"; the message is a delta in *which levels it reports*, not in arithmetic. `WP-070` obtained the confirmation on 2026-08-27 (its mandated acceptance criterion) and the contract-owner round re-verified it independently on 2026-08-28. **`WP-150` may now treat it as truth.** Two limits carry forward: the confirmation is **documentary, not observational** (no live observation is claimed anywhere), and the citing page — `https://docs.polymarket.com/api-reference/wss/market` — is **not in the frozen report's source index**, so the next dated report owes it (handoff §1.2; `WP-070` `follow_up` 3) | §3, §11, §12 (the report is a frozen snapshot and keeps its original wording; superseded on this point by current official documentation under handoff §1.1) | Closed. Residual ownership: the next venue-verification round re-verifies the fact and indexes the page | [ADR-013](../adr/ADR-013-book-price-change-absolute-size-confirmed.md); ADR-002 §8 (dated amendment); ADR-012 §5.8 (dated amendment); and the now-CONFIRMED comment markers on the module header and the `size` field of `packages/domain/src/events/book.ts`, where an implementer actually reads the contract (comment-only, replacing the 2026-08-26 closeout M2 UNVERIFIED markers) |
| **C-2** USDC (fees page) vs pUSD (rebate/reward pages) denomination | **Unresolved** official-source inconsistency; report records both verbatim and picks neither | §6, §11 | `WP-200` and the fee/reward accounting work | ADR-006 §7 |
| **C-3** `MATCHED_NOT_BROADCASTED` scope: docs list it on the user stream, SDK says REST-only | Modeled REST-only per §1.1 source precedence; **docs claim unresolved** | §4, §11 | `WP-280` must re-check | ADR-007 §12 |
| **C-4** Review-claimed archived-SDK references on quickstart/overview | **Not reproduced** on re-check; recorded so the discrepancy is auditable. Re-checked 2026-08-27 by the orchestrator at the Wave-1 batch-1B phase gate (governance edit, recorded in IMPLEMENTATION_STATUS.md): still not reproduced — `/trading/quickstart` ("Place Your First Order") demonstrates only the unified `@polymarket/client` (`createSecureClient`, `@polymarket/client/viem`); `/trading/overview` names no SDK package | §11 | Re-check satisfied for the Wave-1 batch-1B gate (2026-08-27) AND the phase-2 start gate (2026-09-02, orchestrator governance edit: still not reproduced — `/trading/quickstart` demonstrates only the unified client, now observed in BOTH languages: TS `@polymarket/client` (`createSecureClient`, `@polymarket/client/viem`) and Python `polymarket` (`AsyncSecureClient`, a new observation this check); `/trading/overview` names no SDK); next re-check at the phase-3 start gate | — |
| **U-2** Server-side disconnect/timeout when the client misses `PING` | Undocumented | §12 | `WP-070`, `WP-120` — treat as unknown | ADR-002 Evidence; ADR-004 Evidence |
| **U-3** Maximum `assets_ids` per market-channel subscription | Undocumented | §12 | `WP-070`, `WP-120` subscription planning | ADR-002 Evidence |
| **U-4** Exhaustive order-placement error-code enumeration | Only example causes documented | §2.4, §12 | `WP-260`/`WP-270` — unknown codes are first-class UNKNOWN | ADR-007 §6 |
| **U-5 residual** CTF Exchange / Negative Risk CTF Exchange settlement-contract addresses | Not on the retrieved page | §12 | `WP-300` | ADR-006 Evidence; ADR-009 Evidence |
| **U-6** 50/50 resolution outcome and post-open on-chain clarification | **Not confirmable**; the resolution page was not captured. Handoff-asserted only | §11, §12 | `WP-110` must verify before settlement-spec implementation | ADR-009 §5 |
| **U-7** Published `@polymarket/client` npm version | Not observable; everything is pinned to SDK commit `7fdbed4…` instead | §1, §12 | `WP-260` pins with a fresh check | ADR-007 §12; ADR-010 §4 |
| **U-9** HTTP 425 response body during a matching-engine restart | No body documented; key on the status code alone | §9, §12 | `WP-260`/`WP-310` | ADR-007 §7 |
| **No dedicated dispute event** | `DISPUTED` is non-terminal and has no venue-observed transition event | — (design gap, not a venue claim) | `WP-110`; add `MarketDisputed` under a new schema version if evidence appears | ADR-009 §4 |
| **Same-account / same-signer matching behavior** (added review round 1) | Undocumented. The report gives the fee formula and per-signer rate limits but says nothing about whether the matching engine matches two orders from one account, nor whether any self-trade prevention exists | — (the report is silent; §6 covers fees only) | `WP-260`/`WP-310`; ADR-011 §6 requires the answer before any multi-live-owner design is discussable | ADR-011 §3 |
| **Arbitration between callers sharing one signer's token buckets** (added review round 1) | Undocumented. §8 documents the buckets, token costs, and all-or-nothing batch admission, but no ordering or priority rule between competing callers | §8 (silent on arbitration) | `WP-310` rate-limit scheduling, which must implement §6 invariant 13's priority itself | ADR-011 §3 |

Rule for all of these: **an ADR, a schema, or a code comment may state the item
and its unverified status; none may state the underlying behavior as fact.** If a
future work package needs a venue fact this register does not contain, it records
a gap for the next verification round — it does not fetch and improvise
(`AGENTS.md`).

### 8.1 Open repository-internal items (not venue facts)

Added 2026-08-26 by the Wave 0 closeout remediation. These are **our** open
items, not the venue's: a duplication, an unratified inference, a dropped
follow-up. They are registered here for the same reason as §8's venue items — an
item nobody wrote down is an item nobody owns — but they are kept in a separate
table so the venue-fact register stays a venue-fact register.

| # | Item | Status | Owned by | Recorded in |
| --- | --- | --- | --- | --- |
| **R-1** | **The canonical-decimal grammar exists twice.** `apps/ops-cli/src/verify-venue/fixtures.ts` (`CANONICAL_DECIMAL_RE`, plus its own `[0, 1]` price predicate) and `packages/decimal/src/canonical.ts` (`CANONICAL_PATTERN`) independently implement handoff §7.3 / ADR-001 §2. The fixture catalog deliberately does not depend on the contract packages, so the duplication is not simply removable | **Open**, and now **pinned**: `apps/ops-cli/src/verify-venue/canonical-grammar.test.ts` asserts the two agree over a pinned vector table plus a systematic sweep, and asserts the single documented divergence (`packages/decimal` also enforces `MAX_DECIMAL_STRING_LENGTH`). Drift now fails a gate instead of surfacing as a wrong fixture verdict | Whichever package resolves **R-2**; until then, any change to either grammar updates both and keeps the test passing | ADR-001 §2; the test's module header |
| **R-2** | **Hand-transcribed stand-in schemas are load-bearing.** `WP-000`'s `checks.ts` transcribes official SDK schemas by hand; a transcription error is a silent verification error. `WP-000` recorded the follow-up ("replace the contract-shaped stand-in schemas with generated or canonical domain schemas so hand transcription of the SDK is no longer load-bearing") against `WP-020`/`packages/domain`, where it lapsed when `WP-020` shipped without it | **Open**; revived here so it stops depending on a closed package's follow-up list | The **`WP-070`** packet, for the venue-adjacent schemas it owns; the orchestrator carries it into that packet's acceptance criteria | `docs/handoffs/WP-000.md` → `follow_up`; ADR-002 §7 |
| **R-3** | **Inferred shapes recorded but never ratified.** `domain.md` §8 records the inferences behind the frozen contracts; §10 names which ADR ratified which. Four §8 rows appear in no ratifying ADR: `TokenId` = canonical unsigned integer string with no leading zeros; **UUIDs lowercase only**; incident `severity` = `LOG`/`NOTIFY`/`PAGE`; and event **payload field sets beyond §7.4's event-type names** (§7.4 lists types only, so the payload shapes are this repository's design) | **DONE 2026-08-28 by ratification** — [ADR-016](../adr/ADR-016-ratified-inferred-domain-shapes.md) accepts all four **as decided**, in the orchestrator governance round this row named as one of its two possible owners. No code changed and no `schemaVersion` moved; each now has a supersession path it did not have before | Closed. `domain.md` was **not** edited, exactly as this row directed: it already states the inferences "so review can challenge them" | [ADR-016](../adr/ADR-016-ratified-inferred-domain-shapes.md); `domain.md` §8 (unchanged), §10 (cross-reference row still owed — see **R-7**) |
| **R-4** | **`verify-venue` wiring (report §15).** The frozen verification report's §15 recorded the wiring of `runVenueVerification()` into a CLI entry point and the root `ops:verify-venue` script as owed follow-up, in three numbered items | **DONE for items 2 and 3, and for item 1 in substance** (2026-08-26, closeout finding L11): `apps/ops-cli/src/verify-venue/main.ts` is the entry point, `apps/ops-cli` gains a `verify-venue` script, the root script runs it, and the command stays offline-only. `pnpm ops:verify-venue` runs offline and exits 0. **Residue:** §15 item 1 asks for the subcommand in `apps/ops-cli/src/index.ts`, which was outside the repair package's allowed paths; a dedicated entry module was used instead. Wiring a subcommand *router* in `index.ts` — once `ops-cli` has more than one command — is left to the owning package. Recorded **here** because the merged report is a frozen dated snapshot (§2) and is not edited to say so | Residue: the owning package for `apps/ops-cli/**` (`WP-330`, or an earlier authorized packet). The phase-gate re-verification (handoff §1.2) writes a **new** dated report and states its own §15 | `main.ts` module header; `docs/handoffs/wave-0-closeout-remediation.md` |

| **R-5** | **`ConditionIdSchema`'s 200-character cap contradicted §9's "no length bound".** §9 and ADR-002 §7 required a runtime parser to "accept **any** hex condition id the SDK accepts"; the frozen `ConditionIdSchema` (`NonEmptyStringSchema`, `MAX_IDENTIFIER_LENGTH` = 200) makes that literally unsatisfiable. Raised as `WP-070` review round 1 finding **M2** and carried by the orchestrator as contract-owner item 3. Registered here 2026-08-28 because the flag had no row in this table | **CLOSED 2026-08-28 by [ADR-015](../adr/ADR-015-repository-identifier-bound.md).** The bound is ruled a deliberate repository-wide **boundary-hardening** decision (`domain.md` §7), not a venue-fact narrowing — real condition ids are 66 characters. The rule is reworded (§9 below and ADR-002 §7): no 31/32-byte narrowing; accept any SDK-accepted hex id **up to the bound**; beyond it a **typed refusal** is the correct adapter behavior. `WP-070`'s shipped behaviour is ratified as conforming and its "discharged in substance, not literally" caveat is superseded | Closed. Raising the bound later requires ADR + a bounded repair package owning `packages/domain/**` (§3.1) + a stated `schemaVersion` consequence (ADR-015 §6) | [ADR-015](../adr/ADR-015-repository-identifier-bound.md); ADR-002 §7 (amended row); §9 below; `packages/polymarket-public/README.md` §4.1 |
| **R-6** | **`takerSide` had no defined vocabulary.** The frozen `takerSide: BookSideSchema.optional()` is documented only as "Taker side when the venue reports it", so `BID` could name the taker's own order side or the book side consumed — opposite readings. Batch 1B shipped three different outcomes into that gap (`WP-070` maps taker-perspective `BUY → BID`; `WP-090` inverts a documented maker side; `WP-080` omits under `BNC-U5`) | **CLOSED 2026-08-28 by [ADR-014](../adr/ADR-014-taker-side-names-the-aggressor-order-side.md).** `takerSide` names the **aggressor order's own side**: `BID` ⇔ the taker was buying, `ASK` ⇔ the taker was selling — *not* the side of the book consumed. Conformance verified in code: **`WP-070` conforms**, **`WP-090` conforms** (maker `SELL → BID`), **`WP-080` conforms by omission** | Closed as a contract question. **Two follow-ups are owed and are not closed by it:** (a) **MANDATORY, `packages/binance-adapter`** — map `m` under the ruling and remove the now-inverse `BOOK_SIDE_CONSUMED` convention, before any consumer wires `takerSide` (ADR-014 §7); (b) `WP-090`'s `U-CB-3` (is Coinbase's `side` really the maker's?) stays open on its own merits — the ruling does not touch it | [ADR-014](../adr/ADR-014-taker-side-names-the-aggressor-order-side.md); `docs/handoffs/WP-070.md` (remediation round 1 `follow_up` 2), `WP-080.md` (`BNC-U5`), `WP-090.md` (`known_risks` 1) |
| **R-7** | **Two documentation residues owed to `docs/contracts/domain.md`.** (a) §10's ADR cross-reference table does not name ADR-013–ADR-016, so the §8/§10 ratification map is incomplete for the four rows R-3 just closed and for the identifier bound. (b) The frozen event modules state `takerSide` as "Taker side when the venue reports it" (`book.ts`) and with no comment at all (`reference.ts`), so ADR-014's ruling is not visible where an implementer reads the contract | **Open, and deliberately so.** The 2026-08-28 governance round's allowed paths covered `docs/adr/**`, the registers here, and a comment-only edit confined to `book.ts`'s C-1/U-1 markers. A governance round may not widen its own allowed paths to finish its own paperwork | (a) the next package owning `docs/contracts/domain.md` (additive rows only); (b) the next **bounded repair package** owning `packages/domain/**` (§3.1) — comment-only, hash-proved, no version bump | [ADR-014](../adr/ADR-014-taker-side-names-the-aggressor-order-side.md) Consequences; [ADR-016](../adr/ADR-016-ratified-inferred-domain-shapes.md) Consequences; `docs/handoffs/GOV-1B.md` |

Rule for this table: an entry leaves it only by being **done** (with the evidence
named, as R-4 does) or by being **ratified** in an ADR — never by being quietly
dropped when the package that raised it closes, which is exactly how R-2 was
lost. As in §8, a **closed** row stays in the table with its ratifying ADR and
date; the history is what makes the register worth keeping.

## 9. Fixture-only narrowings must not become runtime behavior

The `WP-000` fixture catalog is deliberately stricter than the official SDK in
several places, because an undocumented value in a frozen documentation-derived
snapshot would be an invention. **A runtime parser that inherits that strictness
rejects valid venue traffic.**

The binding list lives in ADR-002 §7 and the underlying evidence in
`docs/venue/verified-2026-08-24.md` §17 and §7.1. Summary of the rule — every
item below is an obligation of the **adapter**, the component that owns the
venue wire format:

- Accept `null` wherever the SDK declares `.nullish()`, **and map it to absent
  before the domain boundary**.
- **No 31/32-byte narrowing:** accept any hex condition id
  `ConditionIdResponseSchema` accepts, **up to the repository identifier bound**
  (`MAX_IDENTIFIER_LENGTH` = 200 — [ADR-015](../adr/ADR-015-repository-identifier-bound.md)),
  and **beyond the bound refuse with a typed problem carrying the raw frame**,
  never a truncation, a silent drop, or a frame-losing throw. *(Wording amended
  2026-08-28 by `GOV-1B`. This bullet previously read "accept any hex condition
  id `ConditionIdResponseSchema` accepts (no 31/32-byte bound at runtime)",
  which the frozen `ConditionIdSchema` makes unsatisfiable — register item
  **R-5**, `WP-070` review round 1 finding M2. The narrowing being rejected is
  unchanged; only the unbounded phrasing is corrected, per §4's
  correction-of-fact rule.)*
- Accept both the JSON-number and decimal-string forms for Gamma decimal fields
  and normalize (ADR-001 §8.2).
- Treat `.default([])` arrays as absent-or-array — and note this is **not** a
  narrowing: an explicit `null` genuinely fails to parse there.
- Treat the whole rewards block and its keys as optional.
- Accept either trade-status spelling on either layer, every epoch-like form the
  SDK accepts, and an unrecognized free-string `side`/`status` value as
  first-class UNKNOWN (ADR-002 §7 states each with its `checks.ts` citation).

**`packages/domain` is not the place any of this happens.** The frozen contracts
are strict by decision (`domain.md` §3.2, §7): optional means the key may be
absent, no venue-derived field is nullable (no schema uses `.nullable()`), and
the boundary never coerces. The one place `null` is an accepted *value* is
`ModelOutputValueSchema` (`DecimalString | string | boolean | null`), which the
handoff §7.5 specifies literally — a strategy's own model output, not a venue
wire value, and not an encoding of absence. An
adapter that forwards a raw `null` — or a raw non-canonical decimal spelling —
into a domain schema has skipped its own job; the typed parse failure is the
intended outcome, not a contract defect.

Wording correction (Wave 0 closeout finding H1, 2026-08-26): ADR-002 §7 and this
section previously said a runtime parser **"and `packages/domain`"** must accept
`null`, which contradicted ADR-001 §8.1 and the frozen code. Both are corrected
in place per §4 ("Corrections of fact … are made in place and noted").
`docs/venue/verified-2026-08-24.md` §17 carries the same phrasing and is **not**
edited — a merged report is a frozen dated snapshot (§2). On this architectural
point the report is **superseded by ADR-001 §8.1 and ADR-002 §7** under the
handoff §1.1 authority order: the report governs venue facts (these fields are
`.nullish()` and real traffic may carry `null` — unchanged and binding), the
handoff and its ADRs govern which internal component absorbs them.

## 10. Quick reference: who may change what

| Change | Needs |
| --- | --- |
| A contract in `packages/domain` or `packages/decimal` | Accepted ADR + orchestrator approval + schema-version consequence stated |
| Anything in a frozen package when **no** work package owns the path | The bounded repair package of §3.1 (enumerated scope + the §3 gate + independent review + handoff) |
| A new migration in `db/migrations/**` | Owning work package (`WP-040`+) + orchestrator approval; forward-only |
| An accepted ADR's decision | A **new** ADR that supersedes it |
| An accepted ADR's factual error | In-place correction, noted, with orchestrator approval |
| A root config or the lockfile | Owning package + ratification per §5 if outside literal `allowed_paths` |
| A merged venue report | A **new** dated report (handoff §1.2) |
| Any of the four safety defaults | A recorded **human** gate first (ADR-010; `AGENTS.md`) — never an agent decision |
