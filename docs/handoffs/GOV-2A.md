# GOV-2A completion record — cross-package schema-boundary governance round

- **State**: candidate for review (doc-only), **remediation round 1 applied**. Not
  merged, not marked complete.
- **Base**: `main` `2d7e7da`; round-1 candidate `bc15d25` (branch
  `worktree-agent-a9d317e245f6f9a01`); this tip is the round-1 remediation commit
  on top of it. §10 below is the finding-by-finding record of that remediation.
- **Round type**: contract-owner governance round. **DOC-ONLY** — no `packages/**`,
  `apps/**`, `test/**`, `tools/**`, `db/**`, `python/**`, `.github/**`,
  `docs/venue/**`, `package.json`, or `pnpm-lock.yaml` path was touched.
- **Dispatch note**: the first dispatch of this packet was killed by an API session
  limit during its read phase with **zero** work product; this record is entirely
  the second, fresh dispatch's work, from the identical packet.

---

## summary

Ruled on the repository-wide `zod`-boundary class that `WP-180` measured and
escalated, closed `GOV-1D`'s deferred C-2 conformance ratification against
`WP-200`'s merged state, and settled three carried contract questions. Eight
items, all executed:

1. **The escalation record is widened** (`IMPLEMENTATION_STATUS.md` → `## Open
   blockers` → "Cross-package risk"): the rounds-6-8 classes now sit beside the
   round-9/10 classes (`optin`/`optout` required-key waiver, inherited `when`,
   `values`, cold-lazy poisoning, the measured refusal-composition bound), the
   batch-2B corroborations, and one class **no package had recorded** — that
   `z.strictObject` is not a mitigation and the **non-enumerable** form of the
   pollution defeats it.
2. **Every merged raw-`zod` boundary is audited, mechanically.** Boundaries found
   by grep; verdicts established by **executed probes** in a `/dev/shm` scratch
   copy of `main` `2d7e7da` (`pnpm install --frozen-lockfile`, `zod@4.4.3`
   confirmed from the resolved store). **Live fail-opens in twelve packages and one
   app** *(count corrected in remediation round 1 — §10 LOW-1; the first pass said
   "five packages and one app", undercounting rows its own table already carried
   and three rows that round-1 review overturned)*, each with a severity and a
   named owner — including two that defeat the
   recorded `WP-040` obligation **F16**, one that defeats an ADR-016 identifier
   rule inside `WP-170`, one that defeats the gateway's `dataLossBoundMs` startup
   check, and the frozen §7.5 `DecisionResultSchema`, whose **every required key
   can be supplied from `Object.prototype`**.
3. **Mirrors: RULED (a)** — collapse to one canonical implementation in
   `packages/risk` behind a §2.1 same-layer edge; duplication-with-drift-guard is
   **not** ratified as permanent. The rows are written verbatim and
   pre-authorised; they are not listed *as table rows* because `GOV-2A`
   reproduced, mechanically, that doing so keeps `check:deps` PASS at 34/41 while
   failing `test/unit/tooling/dependency-direction.test.ts:801` — a path this
   round may not touch. §6.1 item 5 predicted exactly this; its own rule (row and
   pinned assertion move together) assigns it to the implementing package.
4. **Layer-1 Node built-ins: RULED** as a bounded, enumerated allowlist
   (`dependency-direction.md` §2.2 + new **F17**), with five properties a binding
   must satisfy and an exhaustive per-package table, verified against a census of
   every non-test `node:` import in the workspace.
5. **C-2 ratification: CLOSED** by a dated, append-only ADR-006 §7 second
   amendment against merged `7e75f9a`. Items 1-2 and ruling 5 **CONFORMANT and
   mechanically enforced**; item 3 conformant on the denomination, with its
   source-provenance half recorded as an unexercised obligation with an owner.
6. **`WP-040` obligations F12/F17/F18/F19 RE-ASSIGNED** to their Wave-3 owners —
   F12/F18/F19 → `WP-300`, F17 → `WP-270`, F19's break arm co-owned by `WP-290` —
   registered as `protected-contracts.md` §8.1 **R-9** so the next orchestrator
   sees it.
7. **Batch-2B corroborations folded in**, each independently reproduced:
   `divDecimal`'s explicit-options throw (with the repo-wide call-site census and
   an end-to-end probe of its one explicit-options caller), `WP-160` R1-L3
   (measured adoption in `selectIndexedValues`), R8-1 (`expect` throws under
   `Object.prototype.get`), the detector-dodgeability class (R1-N3/R9-1, with
   R8-2 **folded** into it), and `WP-190` R1-L1, which is **ruled** rather than
   deferred: totality claims scope to composed entries, and two packages must
   correct their claim text or guard their helpers.
8. This record, with the audit table and every probe transcript.

The decision itself is [ADR-020](../adr/ADR-020-schema-parse-boundary-integrity.md);
its normative companion is [`docs/contracts/schema-boundary.md`](../contracts/schema-boundary.md).

---

## files_changed

**8 files, all in the packet's allowed paths** — 3 new, 5 modified. *(Corrected
in remediation round 1 — §10 LOW-3. The first pass said "9 files … New (2) …
Modified (7)": it double-counted (the `docs/adr/README.md` /
`docs/contracts/*` parenthetical below is a note about files already listed, not
a ninth file) and it listed this record itself as modified when it is new.
Reproduce with `git diff --name-only 2d7e7da..<tip>`, which prints exactly
eight paths, and `git diff --name-status 2d7e7da..<tip>`, which marks three of
them `A`.)*

New (3):

- `docs/adr/ADR-020-schema-parse-boundary-integrity.md` — the ruling.
- `docs/contracts/schema-boundary.md` — the normative companion: door
  definition (D1-D4), measured-class table, per-package audit, owners.
- `docs/handoffs/GOV-2A.md` — this record.

Modified (5):

- `docs/adr/ADR-006-actual-ledger-versus-virtual-allocation.md` — **+89/−0**, a
  dated second §7 amendment appended before §8. Append-only, verified by
  `git diff --numstat` (89 insertions, **zero** deletions): the original decision
  text and the 2026-09-03 amendment are byte-preserved.
- `docs/adr/README.md` — ADR-020 index row; ADR-006's index row annotated with
  the second amendment; `schema-boundary.md` added to the companion-contract list.
- `docs/contracts/dependency-direction.md` — the §2.1 pre-authorised
  mirror-collapse ruling; new §2.2 (Node built-in allowlist); new §3 **F17**
  (scoped to production imports in remediation round 1, with the test-file
  census and the F17-versus-rule-3 reconciliation added to §2.2);
  `Related` header line extended.
- `docs/contracts/protected-contracts.md` — §8.1 rows **R-9** (the `WP-040`
  obligation re-assignment, plus the round-1 grant-time flag on F19) and
  **R-10** (the schema-boundary class); a dated closing note on the §8 **C-2**
  row.
- `IMPLEMENTATION_STATUS.md` — **only** the "Cross-package risk" record under
  `## Open blockers`. No table row, no header, no other section.

*(`docs/adr/README.md` and `docs/contracts/*` are the only protected paths
touched; both are inside the packet's grant. This parenthetical is a note about
files already listed above, not a further file.)*

Lockfile: untouched (`git diff` empty). No `package.json` anywhere was modified.

---

## tests_run

Probes ran **only** in `/dev/shm/gov2a`, a scratch copy of `main` `2d7e7da`
(`git archive HEAD | tar -x`), installed with `pnpm install --frozen-lockfile`
(35 workspace projects, 325 packages, lockfile up to date). `zod@4.4.3` confirmed
from `node_modules/.pnpm/zod@4.4.3`. Ten probe files, **49 assertions, 46 pass /
3 fail** — the three failures are *my own hypotheses being refuted* (B2, B3, B5,
where `z.strictObject` fails closed on the enumerable form), and they are the
finding that produced probe F. Nothing in the repository was modified to make a
probe pass.

> **Disclosure added in remediation round 1 (§10 NOTE-2).** Those ten round-1
> probe files lived **only** in `/dev/shm/gov2a`, which no longer exists, and
> they were never committed. Their sources are therefore **not recoverable**,
> and the "49 assertions, 46 pass / 3 fail" count above **cannot be re-derived
> from this record** — it is kept because a superseded claim is corrected in
> place rather than erased (`protected-contracts.md` §4), not because it is
> independently checkable. What survives of round 1 is the transcripts below and
> the fact that round-1 review reproduced every LIVE row from them, several
> verbatim. The three probes added in remediation round 1 are committed **in
> full, as source**, in **Appendix A**, together with the sandbox recipe and the
> exact command, so they are re-runnable by anyone. The standing rule this sets
> for later rounds: **a probe that is cited is a probe whose source is
> committed.**

Remediation round 1 added **three probe files, 44 measured parse/decode outcomes**
(M: 5, N: 32, O: 7), all passing, run against a `/dev/shm/gov2arem` scratch copy
of this candidate tree. That tree is byte-identical to `main` `2d7e7da` outside
`docs/` and `IMPLEMENTATION_STATUS.md` (verified:
`git diff --stat 2d7e7da..<tip> -- . ':!docs' ':!IMPLEMENTATION_STATUS.md'` is
**empty**), so the new probes measure exactly the code the round-1 audit
measured. Transcripts: §10.

Gates **run at this tip**, all green (in a `/dev/shm` scratch copy of the tip,
`git archive` + `pnpm install --frozen-lockfile`; this worktree carries no
`node_modules`):

| Gate | Result |
| --- | --- |
| `pnpm test` (root) | **212 files / 4966 tests, all pass** — exactly the base counts. The load-bearing gate for a doc-only round (`GOV-1D` precedent) |
| `pnpm check:deps` | **PASS — 34 packages / 41 edges**, allowlist still exactly `S0, S1, S2`. The §2.1 and §2.2 prose is inert to the parser, which is heading-scoped (`sectionOf`: only `### Layer <n>` assigns packages, only `### 2.1` parses edges) |
| `test/unit/tooling/dependency-direction.test.ts` | **187/187 pass** with the edited contract (run in the sandbox); the pinned allowlist assertion is untouched |
| `pnpm typecheck` | exit 0 |
| `pnpm lint` | exit 0 |
| `pnpm install --frozen-lockfile` | clean; `git diff --stat pnpm-lock.yaml` **EMPTY** |
| `git diff --name-only 2d7e7da..<tip>` | exactly the **eight** files listed under `files_changed` — allowed paths only, no new file outside them |
| `IMPLEMENTATION_STATUS.md` diff | **one** hunk at default context (`@@ -1653,17 +1653,175 @@ that parses venue payloads.`), **four** at `-U0` (`@@ -1655,0 +1656,40 @@`, `@@ -1661,0 +1702,110 @@`, `@@ -1664 +1814 @@`, `@@ -1666 +1816,9 @@`). Every one is inside the Cross-package risk record: no table row, no header, no other section. *(Corrected in remediation round 1 — §10 LOW-3. The first pass claimed "two hunks" and quoted two headers that reproduce at neither context setting; the line numbers below shift again with this remediation's own edits, so the durable check is the **confinement**, which `git diff -U0` shows directly: every hunk lands between the record's first line and the `## Deviations from specification` heading that follows it.)* |
| ADR append-only | `git diff --numstat` = **89 insertions, 0 deletions**. Proven cryptographically: deleting the inserted span (tip lines 391-479) reproduces the base byte-for-byte — SHA-256 `d969e3d8e1a1913add9cc9a8f441097d10585c1ad81d0be2c7915dcb0381c80a` on both sides. **30 588 base bytes, 36 640 tip, 6 052 inserted** *(byte counts corrected in remediation round 1 — §10 LOW-3; the first pass wrote 30 288 / 36 307 / 6 019, which `wc -c` on `git show 2d7e7da:…` and `git show <tip>:…` refutes. The SHA-256 was and is **correct**, and was re-verified: `git show <tip>:… \| sed '391,479d' \| sha256sum` prints it.)* |

**Negative control, run deliberately.** Adding S3/S4 as real §2.1 table rows in
the sandbox: `check:deps` **PASS 34/41** with both rows parsed and
cross-validated against §2, and `dependency-direction.test.ts:801` **FAILS**
(`["S0","S1","S2"]` vs `["S0","S1","S2","S3","S4"]`). Reverted. This is the
evidence for the §2.1 pre-authorisation shape, not an assumption about it.

**Safety.** No credential, signer, wallet, network call, or live claim. No
run-mode default, `ALLOW_REAL_ORDERS`, or live-micro cap was touched anywhere in
this change. Nothing here is observational.

---

## Per-package audit — `main` `2d7e7da`, 2026-09-04

The authoritative table (with door names, severities and owners) is
[`docs/contracts/schema-boundary.md`](../contracts/schema-boundary.md) §3. Summary:

| Package / app | Verdict | The measured consequence | Owner |
| --- | --- | --- | --- |
| `packages/domain` (frozen) | **LIVE** | `Uuidv7Schema`/`IsoTimestampSchema` accept garbage under `skipChecks`; every required `DecisionResult` key is prototype-satisfiable | closed at each door, not by editing the frozen package |
| `packages/ledger` (WP-200) | **LIVE ×2** | WP-040 **F16** defeated (fill booked with no market); non-canonical id + malformed timestamp admitted | `WP-200-FU1` |
| `packages/pnl` (WP-200) | **LIVE** | same classes + an **escaped `TypeError`** from a cold first parse, after which the schema is permanently poisoned | `WP-200-FU1` |
| `packages/strategy-runtime` (WP-170) | **LIVE** | materialize-first defeats adoption/loss, but ADR-016 canonicality and the timestamp grammar stop being enforced | `WP-170-FU1` |
| `apps/data-gateway` | **LIVE ×2** | `dataLossBoundMs` startup check silently passes; "at least one feed" satisfied by a phantom feed | `WP-120-FU1` |
| `packages/event-bus` | **LIVE** | Redis wire envelope with `eventId: "not-a-uuid"` accepted. Returns the caller's object, so no adoption/loss | `WP-060-FU1` |
| `packages/coinbase-adapter` | **LIVE (routing)** | missing required `channel` supplied from the prototype | recorder-pipeline round |
| `packages/polymarket-public` (rtds) | **LIVE (routing)** | missing required `type` supplied from the prototype | recorder-pipeline round |
| `packages/features` (WP-160) | **LIVE (output side)** | `selectIndexedValues` members adopt `reason`/`value`; destined for PostgreSQL indexing | `WP-160-FU1` |
| `packages/binance-adapter` | **LIVE** *(was CONTAINED; corrected in remediation round 1, probe M)* | a trade frame whose declared `q` is absent from the wire decodes as `TRADE` with `quantityRaw: "999999"` from the prototype; `unknownFields` stays empty, which is what makes it silent, not what makes it safe. It reaches `normalizeTrade`'s `size` and the dedup fingerprint | recorder-pipeline round |
| `packages/settlement` | **LIVE** *(was NOT REACHED; corrected in remediation round 1, probe N)* | all **14** required keys of a sample spec adopt from `Object.prototype`, including `resolutionSource`, `comparison`, `strikeSource` — and `verification`, so a spec naming no review at all parses `VERIFIED` and `isReviewedSettlementSpec` returns `true` | next bounded grant on `packages/settlement/**` |
| `packages/universe` | **LIVE** *(was NOT REACHED; corrected in remediation round 1, probe O)* | a `MarketResolved` payload with `outcome` deleted resolves the market from the prototype (`RESOLVED`/`YES_WIN`); `resolvedAt` and the `conditionId` identity key are adoptable too | next bounded grant on `packages/universe/**` |
| `packages/order-book` | **LIVE (inherited)** | scalar domain-schema parses only; no object parse | next bounded grant |
| `packages/risk`, `packages/capital-allocator`, `packages/execution-planner` | **CLOSED** | D1-D4; probe K3 confirms the arena still refuses what the raw schema accepts | — |
| `storage-*`, `observability` | **n/a — outside the class** *(was CONTAINED; corrected in remediation round 1)* | none of the four imports `zod` or contains a schema parse; every `.parse(` is `JSON.parse`/`Date.parse`. The round-1 verdict described doors that do not exist | none; recorded |

**What a probe result means.** Nothing on the wire can write `Object.prototype`;
every finding needs code already executing in the process. They say *"this check
is not load-bearing against an attacker already inside the process"*, not *"a
venue can turn this off"*. They matter because several are the **only**
enforcement of a recorded obligation, an identifier rule, or a durability bound —
and the recorder pipeline runs unattended.

---

## Probe transcripts (trimmed)

Verbatim `console.log` output. `NE` = non-enumerable inherited property; `EN` =
enumerable; `NEGET` = non-enumerable get-only accessor.

### A — the nine classes, re-measured against the sandbox's own `zod@4.4.3`

```text
A1 clean: {"a":"x"}
A1 polluted: {"a":"x","b":"inherited"}                      ← ADOPTION
A2 polluted: {"data":{"a":"x"},"ownB":false}                ← LOSS
A3 clean: {"flag":true,"own":true}
A3 polluted: {"own":false}                                  ← DEFAULT DEFEATED
A4 clean: "refused"
A4 polluted: "ACCEPTED {\"id\":\"not-a-uuid\",\"when\":\"definitely-not-a-timestamp\"}"
A5 polluted defineProperty: "TypeError: Invalid property descriptor. Cannot both
   specify accessors and a value or writable attribute, #<Object>"
A6 clean (jitless): "refused (required key enforced)"
A6 warm+compiled, pair: "refused"          ← the fastpass bakes optin/optout
A6 jitless, pair: "ACCEPTED {\"a\":\"x\"}"  ← the interpreted parser IS fooled
A6 COLD first parse, pair: "ACCEPTED {\"a\":\"x\"}"
A7 clean: "refused (custom check ran)"
A7 polluted when=()=>false: "ACCEPTED (check skipped)"
A8 polluted FIRST parse: "THREW TypeError: Cannot read properties of undefined
   (reading 'values')"
A8 same copy, clean process, LATER parse: "THREW Error: Invalid discriminated
   union option at index \"0\""                              ← PERSISTENT poisoning
A9 clean: "success" / A9 polluted values: "refused"          ← fails CLOSED
```

### F — the variant nobody had recorded: non-enumerable defeats `strictObject`

```text
F1 enumerable unknown key:      "refused (unrecognized_keys)"
F1 NON-enumerable unknown key:  "ACCEPTED"
F2 clean:                       ["LEDGER_INPUT_INVALID"]
F2 skipChecks ENUMERABLE:       ["LEDGER_INPUT_INVALID"]     ← bounces off strictObject
F2 skipChecks NON-ENUMERABLE:   {"ACCEPTED":{"id":"totally-not-a-uuid",
                                             "at":"yesterday-ish"}}
F3 clean:                       ["LEDGER_MARKET_REQUIRED"]
F3 NON-enumerable marketId:     {"ACCEPTED":"018f3a5c-1111-7000-8000-000000000001"}
F4 get-only NON-enumerable flag:{"own":false}
```

### B / E — `packages/ledger` and `packages/pnl` (WP-200, merged `7e75f9a`)

```text
B1 clean: [["LEDGER_MARKET_REQUIRED",{"ledgerTransactionId":"…0001",
   "orderId":null,"fillId":"018f3a5c-5555-7000-8000-000000000001"}]]
B1 inherited marketId: {"verdict":"ACCEPTED",
   "marketId":"018f3a5c-1111-7000-8000-000000000001"}        ← F16 DEFEATED
E5 clean: [["LEDGER_INPUT_INVALID",{"issues":[
   "ledgerTransactionId: must be a lowercase canonical UUIDv7",
   "occurredAt: Invalid ISO datetime"]}]]
E5 skipChecks=true (enumerable): [["LEDGER_INPUT_INVALID",{"issues":[
   "entries.0: Unrecognized key: \"skipChecks\"", …]}]]      ← the strictObject artefact
E3 union warm + polluted: [["owner","unrecognized_keys",
   "Unrecognized key: \"denominationAsset\""]]
(D3, run before the union was warm) THREW TypeError: Cannot read properties of
   undefined (reading 'values')  at zod/v4/core/schemas.js:822
   ← PnlRecordSchema, a discriminatedUnion, on a COLD first parse under
     enumerable pollution: an ESCAPED throw from a door documenting typed refusals
```

### K — C-2 conformance of merged WP-200, and the discriminating arena control

```text
K1 shape-valid: true
K1 netByAsset: {"pUSD":"-5","USDC":"5"}                       ← two buckets, no netting
K1 checkPerAssetBalance: [["LEDGER_UNBALANCED_ASSET",{"assetId":"pUSD",
   "netImbalance":"-5"}],["LEDGER_UNBALANCED_ASSET",{"assetId":"USDC",
   "netImbalance":"5"}]]
K1 Ledger.append: ["LEDGER_UNBALANCED_ASSET","LEDGER_UNBALANCED_ASSET",
   "LEDGER_ATTRIBUTION_PARITY_BROKEN"]     ← an implicit conversion is UNBOOKABLE
K2 reward tx naming its asset: true
K2 reward tx with NO assetId: ["LEDGER_INPUT_INVALID"]        ← item 1 enforced
K3 clean raw/arena:       [false,false]
K3 skipChecks raw/arena:  [true,false]     ← THE CONTROL: same domain schema; the
                                             raw copy fails open, the arena copy
                                             still refuses
K4 clean unknownFields: [] / K4 polluted unknownFields: []    ← binance CONTAINED
```

### G — `packages/domain`, `event-bus`, `strategy-runtime`, `apps/data-gateway`

```text
G1 Uuidv7Schema('NOT-A-UUID') clean/polluted:        [false,true]
G1 Uuidv7Schema('018F3A5C-…') uppercase clean/polluted: [false,true]
G1 IsoTimestampSchema('yesterday') clean/polluted:   [false,true]

G2 clean: "THROWS EventBusEnvelopeError: value is not a valid §7.1 event envelope"
G2 skipChecks (non-enum): {"ACCEPTED":{"eventId":"not-a-uuid",
                                       "receivedAt":"yesterday"}}
G2b correlationId clean/inherited: [null,null]   ← returns the caller's object

G3 baseline (valid input): {"ok":true}
G3 bad evaluatedAt, clean:      {"ok":false,"detail":"evaluatedAt must be an
                                 ISO-8601 timestamp"}
G3 bad evaluatedAt, skipChecks: {"ok":true}
G3 non-canonical marketId, clean: {"ok":false,"detail":"market.marketId must be a
   canonical lowercase UUIDv7 — a non-canonical UUID-shaped identifier is refused,
   never case-folded (ADR-016)"}
G3 non-canonical marketId, skipChecks: {"ok":true}      ← ADR-016 not enforced

G4 clean (tick 5000 > fsync 250): "THROWS GatewayConfigurationError:
   tickIntervalMs must be at or below wal.fsyncIntervalMs …"
G4 get-only inherited tickIntervalMs: {"ACCEPTED":true}  ← check silently skipped
G4b clean (no feed configured): "THROWS GatewayConfigurationError: at least one
   feed must be configured …"
G4b inherited `binance` feed block: {"ACCEPTED":true}
```

### L — the frozen §7.5 `DecisionResultSchema` (consumed at `runtime.ts:918`)

```text
L1 minimal: ["decisionType","reasonCodes","featureSnapshotRef","intents"]
L2 strip+inherit decisionType     → clean/polluted: [false,true]
L2 strip+inherit reasonCodes      → clean/polluted: [false,true]
L2 strip+inherit featureSnapshotRef → clean/polluted: [false,true]
L2 strip+inherit intents          → clean/polluted: [false,true]
L2c get-only reasonCodes: {"own":false}
```

EVERY required key of the one persisted `DecisionResult` (§6 invariant 3) is
satisfiable from `Object.prototype`.

### I / H — the recorder-pipeline adapters

```text
H1 clean:                             {"a":"x"}
H1 inherited ENUMERABLE unknown key:  {"a":"x","zzInjected":"from-prototype"}
H1 inherited NON-enumerable:          {"a":"x"}          ← looseObject adopts EN only
I2 clean keys:    ["e","E","s","t","p","q","T","m"]
I2 polluted keys: ["e","E","s","t","p","q","T","m","zzInjected"]
I3 missing `type` clean/inherited:    [false,"update"]   ← rtds routing field
I4 missing `channel` clean/inherited: [false,"ticker"]   ← coinbase routing field
I3b bad twap payload clean/skipChecks: [false,false]     ← numeric type checks hold
```

### J — batch-2B corroborations

```text
J1 clean default / clean explicit: ["0.6666666666666666666666666666666667","0.6667"]
J1 polluted DEFAULT path:          "0.6666666666666666666666666666666667"
J1 polluted EXPLICIT-options path: "THROWS TypeError: Cannot set property set of
   #<Object> which has only a getter"

J2 clean default:            {"ok":true,…,"volumeWeightedAveragePrice":"0.094",…}
J2 clean explicit-options:   {"ok":true,…,"volumeWeightedAveragePrice":"0.094",…}
J2 polluted default:         {"ok":true,…,"volumeWeightedAveragePrice":"0.094",…}
J2 polluted explicit-options:"THROWS TypeError: Cannot set property set of
   #<Object> which has only a getter"
   ← executablePrice(book, {side, shares, division}) — the repo's ONE
     explicit-options divDecimal caller, end-to-end

J3 clean: [{"id":"f1","version":"1","status":"OK","value":"42"},
           {"id":"f2","version":"1","status":"ABSENT"}]
J3 inherited `reason` (non-enum): [{"id":"f1","status":"OK",
   "reason":"INJECTED_BY_PROTOTYPE"},{"id":"f2","status":"ABSENT",
   "reason":"INJECTED_BY_PROTOTYPE"}]        ← even the OK member gains a reason
J3b inherited `value` (non-enum): [{"id":"f1",…,"value":"42"},
   {"id":"f2","status":"ABSENT","value":"999999"}]  ← an ABSENT member gains a value

J4 expect() under Object.prototype.get: "THROWS TypeError: Invalid property
   descriptor…"                                     ← R8-1, tooling layer
```

### `divDecimal` call-site census (mechanical, repo-wide)

```text
packages/features/src/decimal-policy.ts:79   divDecimal(numerator, denominator)   default
packages/features/src/decimal-policy.ts:89   divDecimal(value, "1")               default
packages/pnl/src/state.ts:320                divDecimal(mul(...), lot.shares)     default
packages/order-book/src/executable-price.ts:116
                                             divDecimal(totalCost, requested,
                                                        request.division)  ← EXPLICIT-capable
```

Confirms `WP-160`'s claim (its own two sites are default-path) and identifies the
one caller that can reach the hazardous path.

---

## assumptions

1. **`IMPLEMENTATION_STATUS.md` is orchestrator-owned.** This round edited exactly
   one record in it, as its packet directs, and nothing else.
2. **The packet's eight items are the whole scope.** Other open register items
   (`R-1`…`R-8`) were read for context and left alone.
3. **`zod@4.4.3` is pinned and the pin holds.** Every measured class is a property
   of that version. ADR-020 §7 makes an upgrade a contract change precisely
   because these measurements do not survive it automatically.
4. **The `/dev/shm` sandbox is a faithful copy of `main`.** `git archive HEAD |
   tar -x` plus a frozen install; the resolved `zod` version was read back from
   the store rather than assumed.
5. **Wave-3 owner assignment (item 6) was read off the work plan**, not inferred
   from names: `WP-300` owns `packages/inventory/**` and the reservation service
   and wallet-operation state machine; `WP-270` owns `packages/oms/**` and the
   submission-attempt protocol; `WP-290` owns the break taxonomy.
6. ~~**"Not reached by probe" is reported as such.** `packages/universe` and
   `packages/settlement` are marked exposed-by-structure and **unconfirmed**; I
   did not upgrade a structural reading into a measurement.~~ **Superseded
   2026-09-04 in remediation round 1 (§10 MEDIUM-1).** Reporting the gap honestly
   was right; leaving it was not — the round's own rule is *probe, don't assume*,
   and both doors were reachable. Both are now **measured LIVE** (probes N and
   O). The residual assumption is narrower and is stated in `known_risks` 2: the
   sweep covers one sample spec and one event type per package, not every door.

---

## deviations

1. **Two register rows and a C-2 note were added to
   `docs/contracts/protected-contracts.md`, beyond the ADR and contract edits the
   packet enumerates.** `docs/contracts/**` is inside the grant, and §8.1 exists
   for exactly this ("an item nobody wrote down is an item nobody owns"). Item 6
   had no other durable home: the only part of `IMPLEMENTATION_STATUS.md` this
   round may touch is the Cross-package risk record, and a Wave-3 obligation
   re-assignment does not belong inside a schema-boundary record.
2. **A new ADR *and* a new contract document were created**, where the packet's
   allowed paths permit either. The split follows the ADR-006/`domain.md`
   precedent: the ADR holds the decision and may not be edited later, while the
   audit table and the owner list will change as each follow-up lands, and those
   belong in a contract document.
3. **The §2.1 rows are pre-authorised in prose rather than listed as table rows.**
   Justified above and proven by the negative control. This is a *decision*, not a
   hedge: the ruling is (a), the rows are written verbatim, the canonical source
   is named, and the owner and migration path are fixed. Only the mechanical act
   of listing is deferred, to the change that can also update the pinned test.
4. **Item 3's "one row" became two.** §2.1 rows are ordered pairs and the
   collapse has two consumers, so one row cannot express it. Recorded rather than
   silently reinterpreted.
5. **`WP-190` R1-L1 was RULED, though the packet made ruling optional.** Deferring
   it again would make every future handoff re-litigate what "public entry point"
   means; the ruling costs two text corrections and settles it.
6. **Three probe assertions fail in the committed transcript set.** They encode
   hypotheses the measurements refuted (`strictObject` fails closed on the
   enumerable form). Kept and reported rather than smoothed away — they are what
   led to probe F and to the sharpest finding in the round.
7. **Remediation round 1 rippled beyond the four documents LOW-1 names.** Fixing
   a verdict changes every place that quotes it, so three further corrections
   were made inside the same allowed paths, each a consequence of a finding
   rather than new scope: `protected-contracts.md` **R-10**'s package list (it
   enumerated the same headline as eight packages), `schema-boundary.md` §5 item
   3 (binance's finding named in the recorder round it was already assigned to)
   and a new §5 item 7 with a matching `follow_up` 9 (a LIVE HIGH row with no
   staged owner would be a fresh gap, which R-10's own rule forbids). The
   "~7,000 pollution states" → "~7,000-call battery" correction (NOTE-4) was
   applied to ADR-020 §6 and its Evidence list as well as to the status record,
   because the same WP-180 fact is quoted in all three and correcting one would
   leave the others contradicting it.

---

## known_risks

1. **The audit is a floor, not a proof.** It probes one representative door per
   package with one pollution shape per class. `WP-180` needed nine probe
   campaigns and a ~7,000-call tuned pollution battery to bound *two* packages; a
   package marked CONTAINED here is "not shown to fail open by these probes", not
   "safe". **Round-1 review proved this the hard way**: of the three negative
   verdicts in the table, *all three* were wrong — `binance-adapter` (CONTAINED),
   `settlement` and `universe` (NOT REACHED). A negative verdict in an audit like
   this deserves more scepticism than a positive one, because a positive verdict
   carries a transcript and a negative one carries an argument.
2. ~~**`packages/universe` and `packages/settlement` are unconfirmed.**~~
   **Closed 2026-09-04 in remediation round 1: both are measured LIVE** (probes N
   and O). The residual is narrower: probe N sweeps the required keys of **one**
   sample spec (`terminalSpotSpecSample()`) and probe O exercises **one** event
   type (`MarketResolved`) of the eight `applyMarketLifecycleEvent` folds, at
   three keys. The other seven folds and the `registerSeries` / series-binding
   doors are structurally the same class and remain **unmeasured**; their owner
   still must probe, not read.
3. **Every finding is still live on `main`.** This round records and assigns; it
   fixes nothing. The window between this ruling and the last follow-up is a
   window in which the escalation record is accurate and the code is not fixed.
4. **The staged plan can rot.** Six follow-ups across five owners, none of them
   currently authorized. R-10's register rule ("an entry leaves this table only by
   being done or ratified") is the only thing preventing quiet expiry.
5. **F17 is not machine-checked**, like F15 and F16 before it. A layer-1 package
   can add `node:fs` to a production file today and only review will catch it.
   The enumeration is accurate as of `2d7e7da` and was verified by census; it
   will drift. **And the rule as first drafted was already violated by merged
   code**: remediation round 1 measured six layer-1 *test* files importing
   un-enumerated built-ins, so F17 is now explicitly production-only, with §2.2
   carrying the census and the reconciliation against §6.1 item 2 (which rules
   test files **in** scope for rule 3). A later round that machine-checks F17
   inherits that scope decision and must not silently widen it — widening it
   would fail six merged files on day one, which is the failure mode §6.1 item 1
   ruled against.
6. **The C-2 ratification holds in an unpolluted process.** Stated in the
   amendment itself. Items 1-2 and ruling 5 rest on per-asset arithmetic that no
   measured class touches, which is why they hold — but the door in front of them
   is defeatable, and `WP-200-FU1` is the retrofit.
7. **ADR-020 deliberately ships no CI gate.** That is a judgment: a gate every
   merged package fails gets waived wholesale. If the follow-ups stall, the
   repository has a rule with nothing enforcing it — which is worse than it looks,
   because a *stated* rule invites the assumption that it is *checked*.
8. **The mirror collapse creates a real edge.** `packages/execution-planner` and
   `packages/capital-allocator` will depend on `packages/risk` at run time. The
   §2.1 basis text narrows the consumed surface to the parse door, but nothing
   mechanical enforces that narrowing today.

---

## follow_up

1. **`WP-200-FU1`** (bounded; `packages/{ledger,pnl}/**` + their tests) — the
   D1-D4 door on `validateTransactionInput`, `allocateFill`, `buildFillPosting`
   and the PnL record parses; close the cold-lazy escaped throw on
   `PnlRecordSchema`; a regression per finding. Also carries `WP-200`'s existing
   LOW residual (the deep-freeze memoisation set added to before the freeze
   succeeds). **Highest priority: monetary path, and it defeats a recorded
   `WP-040` obligation.**
2. **`WP-170-FU1`** — D2/D3 on `packages/strategy-runtime`'s existing
   materializer, covering the `DecisionResult` parse (`runtime.ts:918`) and the
   six scalar identifier parses in `input.ts`.
3. **Recorder-pipeline hardening round** —
   `packages/{polymarket-public,binance-adapter,coinbase-adapter}/**` and
   `apps/data-gateway/**`: the two routing adoptions, **binance's declared-key
   adoption (probe M)**, and the gateway's two defeated startup checks. One
   round; they share a deployment story.
4. **`WP-160-FU1`** — route `selectIndexedValues` members through
   `ownFrozenTree`/`ownPlainCopy`. **Must land before any consumer indexes
   snapshot values into PostgreSQL.**
5. **A bounded `packages/decimal` round** — move `divDecimal`'s explicit-options
   path to module-load-time constructors, as the default path already does, so
   `executablePrice(…, {division})` stops throwing under `Object.prototype.set`
   pollution.
6. **`WP-180-FU2` / mirror collapse** — the §2.1 migration, including moving S3/S4
   into the table and updating `test/unit/tooling/dependency-direction.test.ts`'s
   pinned allowlist **in the same change**. Acceptance is behavioural: every
   `WP-180`/`WP-190` pollution battery passes against the single implementation.
7. **One detector-hardening round** — alias/cast/indirection resolution for the
   census and source scans (`WP-160` R1-N3, `WP-180` R9-1), with R8-2's dotted-
   write gate folded in, plus the F15/F16/F17 checker implementation and a
   `.safeParse`-on-unmaterialized-value detector. **Deliberately last.**
8. **Two totality-claim corrections** under the `WP-190` R1-L1 ruling:
   `packages/execution-planner/src/refusals.ts:180-187` and
   `packages/features/src/inputs.ts:686-690` — correct the claim text or guard the
   helper, in the next bounded round touching each package.
9. **Two bounded grants, `packages/settlement/**` and `packages/universe/**`**
   *(added in remediation round 1, when both rows became LIVE —
   `schema-boundary.md` §5 item 7)*: the D1-D4 door on
   `safeParseSettlementSpec`/`parseSettlementSpec` and on
   `applyMarketLifecycleEvent`'s ten `parsed.data` sites, a regression per
   measured row, and a probe of the doors this round did **not** reach (the
   other seven lifecycle folds, the series-binding doors, non-sampled spec
   shapes). Settlement ranks with follow-up 1: its **review gate is itself
   adoptable**.
10. **`WP-040` obligations, re-assigned** (register `R-9`): **F12, F18, F19 →
    `WP-300`**; **F17 → `WP-270`**; **F19's reconciliation-break arm → `WP-290`**.
    Each owner discharges its rows in its own review and records it. **Flagged in
    remediation round 1 (§10 NOTE-3): F19's insert path has no wallet-operations
    repository yet and neither `WP-300` nor `WP-290` owns
    `packages/storage-postgres/**`, so that grant needs a bounded path widening
    or an explicit split, decided when it is written.**
11. **The fee/reward accounting work** owes ADR-006 §7 item 3's provenance half:
    the versioned §9.13 snapshot that makes the source page and retrieval date
    travel with a fee or reward entry. The `scheduleVersionRef` /
    `programVersionRef` hooks exist; no builder emits one.
12. **Orchestrator**: record this round in `IMPLEMENTATION_STATUS.md`'s work-package
    table (this round may not edit it), and note that the Cross-package risk record
    is now **discharged as an audit and open as a remediation**.

---

## 10. Remediation round 1 (2026-09-04) — the negative side of the audit

Round-1 review (in-harness, adversarial) returned **CHANGES REQUIRED**: 1 HIGH, 3
MEDIUM, 4 LOW, 4 NOTE. Its positive verdicts stand — every LIVE row reproduced,
several verbatim; the C-2 ratification verified cryptographically; the §2.1
mirror staging legitimate, negative control reproduced; the §2.2 built-in census
exhaustive. **Every defect was on the audit's negative side: the rows that said
"not a problem".** That is the durable lesson and it is recorded in
`known_risks` 1.

| Finding | Ruling | What changed |
| --- | --- | --- |
| **HIGH-1** — `binance-adapter` is not CONTAINED | **UPHELD**, reproduced (probe M) | `schema-boundary.md` §3 row rewritten to **LIVE / MEDIUM**, same owner; the effect chain (`normalize.ts:108`, `sequence.ts:298`) stated; named in §5 item 3 and `follow_up` 3 |
| **MEDIUM-1** — settlement verdict and reason both wrong; universe unmeasured | **UPHELD**, both measured (probes N, O) | both rows rewritten to **LIVE / HIGH** from measurement; new §5 item 7 and `follow_up` 9 give them owners; `assumptions` 6 and `known_risks` 2 corrected |
| **MEDIUM-2** — the storage row asserts doors that do not exist | **UPHELD**, censused | row rewritten to **n/a — outside the class**, with the `zod`-absence census and every `.parse(` site classified |
| **MEDIUM-3** — F17 violated by merged code the day it ships | **UPHELD**, censused | F17 scoped to **production (non-test) source files** in the rule text; §2.2 carries the test-file census and the explicit reconciliation with §6.1 item 2 (F17 = runtime import surface; rule 3 = purity, which holds everywhere) |
| **LOW-1** — headline undercount | **UPHELD**, recounted | **twelve packages + one app**, enumerated in `schema-boundary.md` §3 and quoted identically in ADR-020, `IMPLEMENTATION_STATUS.md`, this record, and (ripple) `protected-contracts.md` R-10 |
| **LOW-2** — detached ADR index row | **UPHELD** | blank line at `docs/adr/README.md:101` deleted; the ADR-020 row now joins the index table |
| **LOW-3** — stale handoff numbers | **UPHELD**, all three re-measured | `files_changed` → 8 files / 3 new / 5 modified; the hunk claim replaced with what actually reproduces (1 hunk default, 4 at `-U0`) plus the durable confinement check; ADR-006 byte counts → 30 588 / 36 640 / 6 052 (the SHA-256 was correct and was re-verified) |
| **LOW-4** — wrong cross-reference | **UPHELD** | ADR-020 §5 now cites `schema-boundary.md` **§5** |
| **NOTE-1** — one-directional collision note | **ADOPTED** | the F17 row now carries the reciprocal `WP-040`-F17 id-namespace note pointing at `protected-contracts.md` R-9 |
| **NOTE-2** — commit the probe sources | **ADOPTED, with a disclosure** | the three new probes are committed in full (**Appendix A**) with the sandbox recipe and command; the round-1 sources are **unrecoverable** and that is stated in `tests_run` rather than papered over |
| **NOTE-3** — F19 grant-time flag | **ADOPTED** | recorded in `protected-contracts.md` R-9 and in `follow_up` 10 |
| **NOTE-4** — calls ≠ states | **ADOPTED** | "~7,000-call tuned pollution battery" (WP-180's wording) in the status record, and the same correction in ADR-020 §6 / Evidence |

### Probe transcripts — remediation round 1

Sandbox: `git archive HEAD | tar -x -C /dev/shm/gov2arem`,
`pnpm --dir /dev/shm/gov2arem install --frozen-lockfile`, `zod@4.4.3` read back
from `/dev/shm/gov2arem/node_modules/.pnpm/zod@4.4.3`. Run with
`pnpm --dir /dev/shm/gov2arem exec vitest run --config /dev/shm/gov2arem/probe/vitest.config.ts`.
Sources: Appendix A. `NE` = non-enumerable inherited property.

#### M — `packages/binance-adapter`: a DECLARED key supplied from the prototype

```text
M1 clean frame:                  {"kind":"TRADE","quantityRaw":"0.5","unknownFields":[],"reason":null}
M2 `q` deleted, clean prototype: {"kind":"MALFORMED","unknownFields":[],"reason":"SCHEMA_MISMATCH"}
M3 `q` deleted, NE inherited q:  {"kind":"TRADE","quantityRaw":"999999","unknownFields":[],"reason":null}
M4 normalizeTrade of M3:         {"ok":true,"size":"999999"}
M5 tradeIdentity of M3:          "64000.25|999999|1700000000000|false"
```

The round-1 audit ran only H1/I2 — *unknown*-key adoption through `looseObject`,
where the non-enumerable form is not adopted and `unknownFields` stays empty —
and read that as containment. M3 is the class the coinbase and rtds rows were
ruled LIVE on, and `decodeFrame`'s "reads named fields explicitly"
(`frames.ts:469-472`) is the mechanism that delivers it. M4/M5 are why it
matters: the fabricated quantity becomes the normalized `size` and the dedup
identity of a recorded trade.

#### N — `packages/settlement`: required-key adoption sweep

```text
N0 sample own keys (16): seriesId,specVersion,rulesVersionId,referenceSymbol,timestampBoundary,
   roundingRule,fallbackSource,disputePolicy,clarificationPolicy,verification,settlementSpecId,
   resolutionSource,observationType,comparison,strikeSource,payoffModel
N0 clean parse: {"ok":true,"detail":"ACCEPTED"}
N1 required keys for this sample: 14/16          ← rulesVersionId and payoffModel are optional here
N2 ADOPTABLE from Object.prototype: 14/14 — seriesId,specVersion,referenceSymbol,timestampBoundary,
   roundingRule,fallbackSource,disputePolicy,clarificationPolicy,verification,settlementSpecId,
   resolutionSource,observationType,comparison,strikeSource
N3 still refused: (none)
  resolutionSource: clean=REFUSED  NE-inherited=ACCEPTED
     adopted="Example reference exchange terminal print at the close instant."
  comparison:       clean=REFUSED  NE-inherited=ACCEPTED  adopted="GTE"
  strikeSource:     clean=REFUSED  NE-inherited=ACCEPTED
     adopted="The strike stated in the market rules text."
  settlementSpecId: clean=REFUSED  NE-inherited=ACCEPTED
     adopted="01936f00-0000-7000-8000-00000000c001"
  verification:     clean=REFUSED  NE-inherited=ACCEPTED  adopted={"status":"UNVERIFIED"}
  (the remaining nine required keys behave identically; full sweep in the probe source)
N4 no `verification` own key, NE inherited VERIFIED:
   {"ok":true,"verification":{"status":"VERIFIED","verifiedBy":"nobody",
    "verifiedAt":"2026-08-28T00:00:00Z"},"isReviewed":true}
```

Round 1 wrote "refused on type/shape before any format check ran". That answers a
*format-check* question; adoption is a different class and a ~30-line sweep
reaches it. **N4 is the sharp one**: `isReviewedSettlementSpec` is the gate on
model-dependent activation, and a spec that names no review at all passes it.

#### O — `packages/universe`: `parsed.data` consumed at nine sites

```text
O1 MarketResolved complete, clean:      {"ok":true,"lifecycleState":"RESOLVED",
                                         "outcomeState":"YES_WIN","resolvedAt":"2026-08-28T12:15:30Z"}
O2 `outcome` deleted, clean prototype:  {"ok":false,"codes":["UNIVERSE_INPUT_INVALID"]}
O3 `outcome` deleted, NE inherited:     {"ok":true,"lifecycleState":"RESOLVED",
                                         "outcomeState":"YES_WIN","resolvedAt":"2026-08-28T12:15:30Z"}
O4 `conditionId` deleted, clean:        {"ok":false,"codes":["UNIVERSE_INPUT_INVALID"]}
O5 `conditionId` deleted, NE inherited: {"ok":true,"lifecycleState":"RESOLVED",
                                         "outcomeState":"NO_WIN","resolvedAt":"2026-08-28T12:15:30Z"}
O6 `resolvedAt` deleted, clean:         {"ok":false,"codes":["UNIVERSE_INPUT_INVALID"]}
O7 `resolvedAt` deleted, NE inherited:  {"ok":true,"lifecycleState":"RESOLVED",
                                         "outcomeState":"CANCELLED","resolvedAt":"2099-01-01T00:00:00Z"}
```

O3 is a **terminal outcome reached from the prototype** — the transition
`lifecycle.ts` rule 1 restricts to `MarketResolved` and the frozen contract
restricts to four states. O5 defeats `checkIdentity`, the guard that exists to
refuse an event naming a different market. O7 records a resolution instant no
event carried.

#### Mechanical censuses (no probe needed)

```text
storage-postgres / storage-wal / storage-parquet / observability
  `zod` in package.json:        none of the four
  `from "zod"` in src/:         none of the four
  every `.parse(` in src/:      JSON.parse or Date.parse only —
    storage-postgres: json.ts:65 (JSON), timestamps.ts:63 (Date)
    storage-wal:      segment-format.ts:294, manifest.ts:347, manifest.test.ts:45 (JSON), raw-frame.ts:149 (Date)
    storage-parquet:  4 Date.parse (compactor.ts:759, wal-format.ts:517,
                      testing/index.ts:43, compactor.test.ts:582) + JSON.parse sites
    observability:    6 Date.parse (soak-evidence.ts:290,293,525,526,
                      soak-evidence.test.ts:17, render.test.ts:271) + JSON.parse sites

layer-0/1 `node:` imports in TEST files, at 2d7e7da
  NOT enumerated by §2.2 (would violate F17 as first drafted):
    packages/universe/src/seeds.test.ts                      node:fs, node:path, node:url
    packages/universe/src/settlement-binding.test.ts         node:fs, node:path, node:url
    packages/settlement/src/seeds.test.ts                    node:fs, node:path, node:url
    packages/observability/src/recorder/infra-consistency.test.ts    node:fs, node:path, node:url
    packages/observability/src/recorder/validation-findings.test.ts  node:fs, node:path, node:url
    packages/capital-allocator/src/allocator.test.ts         node:fs, node:path, node:url
  enumerated for their package (not violations either way):
    packages/decimal/src/hash.test.ts                        node:crypto
    packages/features/src/snapshot.test.ts                   node:crypto
  NON-test census re-run: unchanged — exactly the five files §2.2 lists, plus decimal's.

WP-040 F19 grant-time check
  packages/storage-postgres/src/repositories/: balances, catalog, fencing, fills,
    ledger, orders, ownership, strategy — no wallet-operations repository
  WP-300 allowed_paths: packages/inventory/**, test/unit/inventory/**,
    test/contract/wallet-operations/**            → no packages/storage-postgres/**
  WP-290 allowed_paths: packages/oms/src/reconciliation/**,
    packages/ledger/src/reconciliation/**, test/fault-injection/reconciliation/**,
    docs/runbooks/reconciliation.md               → no packages/storage-postgres/**
  F18 runtime enforcement EXISTS: db/migrations/0006_accounting.up.sql:297,
    accounting.assert_ledger_wallet_operation_market → errcode PMB12
```

---

## Appendix A — probe sources (remediation round 1), verbatim

Committed so the transcripts above are re-runnable. Each file goes at
`probe/<name>` in a `/dev/shm` scratch copy; nothing in the repository is
modified. **Each block below is byte-identical to the file that produced the
transcript above** — verified by extracting the block and `diff`-ing it against
the executed file, all four empty. The probes were written first and the
document quotes them, not the other way round. Assertions are deliberately **not** used inside the polluted window
(`expect` builds property descriptors and throws under `Object.prototype.get` —
probe J4/R8-1): each probe collects strings, restores the prototype in a
`finally`, and logs afterwards.

### `probe/vitest.config.ts`

```ts
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export default defineConfig({
  test: {
    include: ["probe/**/*.probe.test.ts"],
    root: repoRoot,
    passWithNoTests: false,
  },
});
```

### `probe/m-binance-declared-key.probe.test.ts`

```ts
import { test } from "vitest";

import {
  decodeFrame,
  normalizeTrade,
  tradeIdentity,
} from "../packages/binance-adapter/src/index.js";

const CLEAN_TRADE = JSON.stringify({
  e: "trade", E: 1_700_000_000_000, s: "BTCUSDT", t: 12_345,
  p: "64000.25", q: "0.5", T: 1_700_000_000_000, m: false,
});

const NO_Q_TRADE = JSON.stringify({
  e: "trade", E: 1_700_000_000_000, s: "BTCUSDT", t: 12_345,
  p: "64000.25", T: 1_700_000_000_000, m: false,
});

function describeFrame(frame: unknown): string {
  const f = frame as Record<string, unknown>;
  return JSON.stringify({
    kind: f["kind"],
    quantityRaw: f["quantityRaw"],
    unknownFields: f["unknownFields"],
    reason: f["reason"] ?? null,
  });
}

test("M — binance declared-key adoption", () => {
  const lines: string[] = [];

  lines.push(`M1 clean frame:                  ${describeFrame(decodeFrame(CLEAN_TRADE))}`);
  lines.push(`M2 \`q\` deleted, clean prototype: ${describeFrame(decodeFrame(NO_Q_TRADE))}`);

  let polluted: unknown;
  let normalized = "";
  let fingerprint = "";
  Object.defineProperty(Object.prototype, "q", {
    value: "999999", enumerable: false, configurable: true, writable: true,
  });
  try {
    polluted = decodeFrame(NO_Q_TRADE);
    const frame = polluted as {
      kind: string; priceRaw: string; quantityRaw: string;
      tradeTimeEpoch: number; buyerIsMaker: boolean;
    };
    if (frame.kind === "TRADE") {
      const result = normalizeTrade(frame as never, { timeUnit: "MILLISECOND" });
      normalized = JSON.stringify(
        result.ok
          ? { ok: true, size: (result.payload as { size?: unknown }).size }
          : { ok: false, failures: (result as { failures?: unknown }).failures },
      );
      fingerprint = tradeIdentity({
        priceRaw: frame.priceRaw,
        quantityRaw: frame.quantityRaw,
        tradeTimeEpoch: frame.tradeTimeEpoch,
        buyerIsMaker: frame.buyerIsMaker,
      });
    }
  } finally {
    delete (Object.prototype as Record<string, unknown>)["q"];
  }

  lines.push(`M3 \`q\` deleted, NE inherited q:  ${describeFrame(polluted)}`);
  lines.push(`M4 normalizeTrade of M3:         ${normalized}`);
  lines.push(`M5 tradeIdentity of M3:          ${JSON.stringify(fingerprint)}`);

  for (const line of lines) {
    console.log(line);
  }
});
```

### `probe/n-settlement-sweep.probe.test.ts`

```ts
import { test } from "vitest";

import {
  isReviewedSettlementSpec,
  safeParseSettlementSpec,
} from "../packages/settlement/src/index.js";
import { terminalSpotSpecSample } from "../packages/settlement/src/testing/index.js";

type Spec = Record<string, unknown>;

function outcome(value: unknown): { ok: boolean; detail: string } {
  const result = safeParseSettlementSpec(value);
  if (result.ok) {
    return { ok: true, detail: "ACCEPTED" };
  }
  const refusal = result.refusal as { code: string; details: { issues?: readonly string[] } };
  return { ok: false, detail: `${refusal.code}: ${(refusal.details.issues ?? []).join(" | ")}` };
}

test("N — settlement required-key adoption sweep", () => {
  const lines: string[] = [];
  const sample = terminalSpotSpecSample() as unknown as Spec;
  const keys = Object.keys(sample);

  lines.push(`N0 sample own keys (${String(keys.length)}): ${keys.join(",")}`);
  lines.push(`N0 clean parse: ${JSON.stringify(outcome(sample))}`);

  const adoptable: string[] = [];
  const refused: string[] = [];
  const cleanRefusalCodes: string[] = [];
  const rows: string[] = [];

  for (const key of keys) {
    const stripped: Spec = { ...sample };
    delete stripped[key];

    const clean = outcome(stripped);
    if (clean.ok) {
      rows.push(`  ${key}: NOT REQUIRED for this sample (clean parse still ACCEPTED)`);
      continue;
    }
    cleanRefusalCodes.push(key);

    let pollutedOk = false;
    let adoptedValue: unknown;
    Object.defineProperty(Object.prototype, key, {
      value: sample[key], enumerable: false, configurable: true, writable: true,
    });
    try {
      const result = safeParseSettlementSpec(stripped);
      pollutedOk = result.ok;
      if (result.ok) {
        adoptedValue = (result.spec as unknown as Spec)[key];
      }
    } finally {
      delete (Object.prototype as Spec)[key];
    }

    if (pollutedOk) {
      adoptable.push(key);
      rows.push(
        `  ${key}: clean=REFUSED  NE-inherited=ACCEPTED  adopted=${JSON.stringify(adoptedValue)}`,
      );
    } else {
      refused.push(key);
      rows.push(`  ${key}: clean=REFUSED  NE-inherited=REFUSED`);
    }
  }

  lines.push(
    `N1 required keys for this sample: ${String(cleanRefusalCodes.length)}/${String(keys.length)}`,
  );
  lines.push(
    `N2 ADOPTABLE from Object.prototype: ${String(adoptable.length)}/${String(cleanRefusalCodes.length)} — ${adoptable.join(",")}`,
  );
  lines.push(`N3 still refused: ${refused.length === 0 ? "(none)" : refused.join(",")}`);
  lines.push(...rows);

  const unverifiable: Spec = { ...sample };
  delete unverifiable["verification"];
  let n4 = "";
  Object.defineProperty(Object.prototype, "verification", {
    value: { status: "VERIFIED", verifiedBy: "nobody", verifiedAt: "2026-08-28T00:00:00Z" },
    enumerable: false, configurable: true, writable: true,
  });
  try {
    const result = safeParseSettlementSpec(unverifiable);
    n4 = JSON.stringify({
      ok: result.ok,
      verification: result.ok ? (result.spec as unknown as Spec)["verification"] : null,
      isReviewed: result.ok ? isReviewedSettlementSpec(result.spec) : null,
    });
  } finally {
    delete (Object.prototype as Spec)["verification"];
  }
  lines.push(`N4 no \`verification\` own key, NE inherited VERIFIED: ${n4}`);

  for (const line of lines) {
    console.log(line);
  }
});
```

### `probe/o-universe.probe.test.ts`

```ts
import { test } from "vitest";

import {
  applyMarketLifecycleEvent,
  createParameterHistory,
  UNBOUND_SERIES_BINDING,
  type MarketLifecycleInput,
  type MarketProjection,
} from "../packages/universe/src/index.js";
import {
  SAMPLE_MARKET_ID,
  marketIdentitySample,
  parameterObservationSample,
} from "../packages/universe/src/testing/index.js";

const CONDITION_ID = marketIdentitySample().conditionId;
const MARKET_REF = { internalMarketId: SAMPLE_MARKET_ID, conditionId: CONDITION_ID } as const;

function openedProjection(): MarketProjection {
  const discovered: MarketProjection = {
    identity: marketIdentitySample(),
    seriesBinding: UNBOUND_SERIES_BINDING,
    lifecycleState: "DISCOVERED",
    outcomeState: "PENDING",
    metadataVersion: 1,
    clarifications: [],
    parameters: createParameterHistory(SAMPLE_MARKET_ID, parameterObservationSample()),
  };
  const result = applyMarketLifecycleEvent(discovered, {
    eventType: "MarketOpened",
    payload: { ...MARKET_REF, openedAt: "2026-08-28T12:00:00Z" },
  });
  if (!result.ok) {
    throw new Error("fixture setup failed");
  }
  return result.value.projection;
}

function describe(result: ReturnType<typeof applyMarketLifecycleEvent>): string {
  if (!result.ok) {
    return JSON.stringify({ ok: false, codes: result.refusals.map((refusal) => refusal.code) });
  }
  const projection = result.value.projection;
  return JSON.stringify({
    ok: true,
    lifecycleState: projection.lifecycleState,
    outcomeState: projection.outcomeState,
    resolvedAt: projection.resolvedAt ?? null,
  });
}

function run(input: MarketLifecycleInput): string {
  return describe(applyMarketLifecycleEvent(openedProjection(), input));
}

test("O — universe lifecycle declared-key adoption", () => {
  const lines: string[] = [];

  lines.push(`O1 MarketResolved complete, clean:        ${run({
    eventType: "MarketResolved",
    payload: { ...MARKET_REF, outcome: "YES_WIN", resolvedAt: "2026-08-28T12:15:30Z" },
  })}`);
  lines.push(`O2 \`outcome\` deleted, clean prototype:    ${run({
    eventType: "MarketResolved",
    payload: { ...MARKET_REF, resolvedAt: "2026-08-28T12:15:30Z" },
  })}`);

  let o3 = "";
  Object.defineProperty(Object.prototype, "outcome", {
    value: "YES_WIN", enumerable: false, configurable: true, writable: true,
  });
  try {
    o3 = run({
      eventType: "MarketResolved",
      payload: { ...MARKET_REF, resolvedAt: "2026-08-28T12:15:30Z" },
    });
  } finally {
    delete (Object.prototype as Record<string, unknown>)["outcome"];
  }
  lines.push(`O3 \`outcome\` deleted, NE inherited:       ${o3}`);

  lines.push(`O4 \`conditionId\` deleted, clean:          ${run({
    eventType: "MarketResolved",
    payload: {
      internalMarketId: SAMPLE_MARKET_ID,
      outcome: "NO_WIN",
      resolvedAt: "2026-08-28T12:15:30Z",
    },
  })}`);
  let o5 = "";
  Object.defineProperty(Object.prototype, "conditionId", {
    value: CONDITION_ID, enumerable: false, configurable: true, writable: true,
  });
  try {
    o5 = run({
      eventType: "MarketResolved",
      payload: {
        internalMarketId: SAMPLE_MARKET_ID,
        outcome: "NO_WIN",
        resolvedAt: "2026-08-28T12:15:30Z",
      },
    });
  } finally {
    delete (Object.prototype as Record<string, unknown>)["conditionId"];
  }
  lines.push(`O5 \`conditionId\` deleted, NE inherited:   ${o5}`);

  lines.push(`O6 \`resolvedAt\` deleted, clean:           ${run({
    eventType: "MarketResolved",
    payload: { ...MARKET_REF, outcome: "CANCELLED" },
  })}`);
  let o7 = "";
  Object.defineProperty(Object.prototype, "resolvedAt", {
    value: "2099-01-01T00:00:00Z", enumerable: false, configurable: true, writable: true,
  });
  try {
    o7 = run({
      eventType: "MarketResolved",
      payload: { ...MARKET_REF, outcome: "CANCELLED" },
    });
  } finally {
    delete (Object.prototype as Record<string, unknown>)["resolvedAt"];
  }
  lines.push(`O7 \`resolvedAt\` deleted, NE inherited:    ${o7}`);

  for (const line of lines) {
    console.log(line);
  }
});
```

---

## commit_sha

Two commits on the candidate branch, based on `main` `2d7e7da`: the round-1
candidate `bc15d25`, and one remediation commit on top of it. The remediation
SHA is reported in the agent's returned handoff — a commit cannot contain its own
hash.

**Not merged. Not marked complete.** A second adversarial review follows on this
tip and, per `AGENTS.md`, it may not be performed by this agent.
