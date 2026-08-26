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

| Item | Status | Report section | Owned by | Recorded in |
| --- | --- | --- | --- | --- |
| **C-1 / U-1** `price_change` absolute-size and zero-removal semantics | Documentation gap; handoff §23 assumption retained **provisionally** | §3, §11, §12 | `WP-070` must confirm before `WP-150` treats it as truth | ADR-002 §8; ADR-012 §5.8 |
| **C-2** USDC (fees page) vs pUSD (rebate/reward pages) denomination | **Unresolved** official-source inconsistency; report records both verbatim and picks neither | §6, §11 | `WP-200` and the fee/reward accounting work | ADR-006 §7 |
| **C-3** `MATCHED_NOT_BROADCASTED` scope: docs list it on the user stream, SDK says REST-only | Modeled REST-only per §1.1 source precedence; **docs claim unresolved** | §4, §11 | `WP-280` must re-check | ADR-007 §12 |
| **C-4** Review-claimed archived-SDK references on quickstart/overview | **Not reproduced** on re-check; recorded so the discrepancy is auditable | §11 | Re-check both pages at the next phase gate | — |
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

## 9. Fixture-only narrowings must not become runtime behavior

The `WP-000` fixture catalog is deliberately stricter than the official SDK in
several places, because an undocumented value in a frozen documentation-derived
snapshot would be an invention. **A runtime parser that inherits that strictness
rejects valid venue traffic.**

The binding list lives in ADR-002 §7 and the underlying evidence in
`docs/venue/verified-2026-08-24.md` §17 and §7.1. Summary of the rule:

- Accept `null` wherever the SDK declares `.nullish()`.
- Accept any hex condition id `ConditionIdResponseSchema` accepts (no 31/32-byte
  bound at runtime).
- Accept both the JSON-number and decimal-string forms for Gamma decimal fields
  and normalize (ADR-001 §8.2).
- Treat `.default([])` arrays as absent-or-array — and note this is **not** a
  narrowing: an explicit `null` genuinely fails to parse there.
- Treat the whole rewards block and its keys as optional.

## 10. Quick reference: who may change what

| Change | Needs |
| --- | --- |
| A contract in `packages/domain` or `packages/decimal` | Accepted ADR + orchestrator approval + schema-version consequence stated |
| A new migration in `db/migrations/**` | Owning work package (`WP-040`+) + orchestrator approval; forward-only |
| An accepted ADR's decision | A **new** ADR that supersedes it |
| An accepted ADR's factual error | In-place correction, noted, with orchestrator approval |
| A root config or the lockfile | Owning package + ratification per §5 if outside literal `allowed_paths` |
| A merged venue report | A **new** dated report (handoff §1.2) |
| Any of the four safety defaults | A recorded **human** gate first (ADR-010; `AGENTS.md`) — never an agent decision |
