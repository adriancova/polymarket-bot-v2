# GOV-2A completion record — cross-package schema-boundary governance round

- **State**: candidate for review (doc-only). Not merged, not marked complete.
- **Base**: `main` `2d7e7da`; branch `worktree-agent-a9d317e245f6f9a01`
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
   confirmed from the resolved store). **Live fail-opens in five packages and one
   app**, each with a severity and a named owner — including two that defeat the
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

**9 files, all in the packet's allowed paths.**

New (2):

- `docs/adr/ADR-020-schema-parse-boundary-integrity.md` — the ruling.
- `docs/contracts/schema-boundary.md` — the normative companion: door
  definition (D1-D4), measured-class table, per-package audit, owners.

Modified (7):

- `docs/adr/ADR-006-actual-ledger-versus-virtual-allocation.md` — **+89/−0**, a
  dated second §7 amendment appended before §8. Append-only, verified by
  `git diff --numstat` (89 insertions, **zero** deletions): the original decision
  text and the 2026-09-03 amendment are byte-preserved.
- `docs/adr/README.md` — ADR-020 index row; ADR-006's index row annotated with
  the second amendment; `schema-boundary.md` added to the companion-contract list.
- `docs/contracts/dependency-direction.md` — the §2.1 pre-authorised
  mirror-collapse ruling; new §2.2 (Node built-in allowlist); new §3 **F17**;
  `Related` header line extended.
- `docs/contracts/protected-contracts.md` — §8.1 rows **R-9** (the `WP-040`
  obligation re-assignment) and **R-10** (the schema-boundary class); a dated
  closing note on the §8 **C-2** row.
- `docs/handoffs/GOV-2A.md` — this record.
- `IMPLEMENTATION_STATUS.md` — **only** the "Cross-package risk" record under
  `## Open blockers`. No table row, no header, no other section.
- *(`docs/adr/README.md` and `docs/contracts/*` are the only protected paths
  touched; both are inside the packet's grant.)*

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

Gates **run at this tip**, in this worktree, all green:

| Gate | Result |
| --- | --- |
| `pnpm test` (root) | **212 files / 4966 tests, all pass** — exactly the base counts. The load-bearing gate for a doc-only round (`GOV-1D` precedent) |
| `pnpm check:deps` | **PASS — 34 packages / 41 edges**, allowlist still exactly `S0, S1, S2`. The §2.1 and §2.2 prose is inert to the parser, which is heading-scoped (`sectionOf`: only `### Layer <n>` assigns packages, only `### 2.1` parses edges) |
| `test/unit/tooling/dependency-direction.test.ts` | **187/187 pass** with the edited contract (run in the sandbox); the pinned allowlist assertion is untouched |
| `pnpm typecheck` | exit 0 |
| `pnpm lint` | exit 0 |
| `pnpm install --frozen-lockfile` | clean; `git diff --stat pnpm-lock.yaml` **EMPTY** |
| `git diff --name-only 2d7e7da` | `IMPLEMENTATION_STATUS.md`, `docs/adr/ADR-006-…md`, `docs/adr/README.md`, `docs/contracts/dependency-direction.md`, `docs/contracts/protected-contracts.md` (+ 3 untracked new files, all in `docs/`) — allowed paths only |
| `IMPLEMENTATION_STATUS.md` diff | two hunks, both inside the Cross-package risk record (`@@ -1655,2 +1655,40 @@` and `@@ -1661,7 +1699,109 @@`). No table row, no header, no other section |
| ADR append-only | `git diff --numstat` = **89 insertions, 0 deletions**. Proven cryptographically: deleting the inserted span from the tip file reproduces the base byte-for-byte — SHA-256 `d969e3d8e1a1913add9cc9a8f441097d10585c1ad81d0be2c7915dcb0381c80a` on both sides (30 288 base bytes, 36 307 tip, 6 019 inserted) |

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
| `packages/binance-adapter` | **CONTAINED** | `looseObject` adopts, but `decodeFrame` reads named fields and `unknownFields` stays empty | recorder-pipeline round |
| `packages/universe`, `packages/settlement` | **NOT REACHED** | doors refused on shape before any format check; `parsed.data` consumption is structurally exposed and is **assumed**, not proven | must probe, not assume |
| `packages/order-book` | **LIVE (inherited)** | scalar domain-schema parses only; no object parse | next bounded grant |
| `packages/risk`, `packages/capital-allocator`, `packages/execution-planner` | **CLOSED** | D1-D4; probe K3 confirms the arena still refuses what the raw schema accepts | — |
| `storage-*`, `observability` | **CONTAINED** | internally-constructed values, parsed defensively | recorded |

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
6. **"Not reached by probe" is reported as such.** `packages/universe` and
   `packages/settlement` are marked exposed-by-structure and **unconfirmed**; I
   did not upgrade a structural reading into a measurement.

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

---

## known_risks

1. **The audit is a floor, not a proof.** It probes one representative door per
   package with one pollution shape per class. `WP-180` needed nine probe
   campaigns and ~7,000 pollution states to bound *two* packages; a package marked
   CONTAINED here is "not shown to fail open by these probes", not "safe".
2. **`packages/universe` and `packages/settlement` are unconfirmed.** Their doors
   refused on shape before reaching a format check, so my probes are inconclusive.
   `universe/lifecycle.ts` consumes `parsed.data` at ten sites and is structurally
   the adoption class. Their owners **must probe, not read**.
3. **Every finding is still live on `main`.** This round records and assigns; it
   fixes nothing. The window between this ruling and the last follow-up is a
   window in which the escalation record is accurate and the code is not fixed.
4. **The staged plan can rot.** Six follow-ups across five owners, none of them
   currently authorized. R-10's register rule ("an entry leaves this table only by
   being done or ratified") is the only thing preventing quiet expiry.
5. **F17 is not machine-checked**, like F15 and F16 before it. A layer-1 package
   can add `node:fs` today and only review will catch it. The enumeration is
   accurate as of `2d7e7da` and was verified by census; it will drift.
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
   `apps/data-gateway/**`: the two routing adoptions and the gateway's two
   defeated startup checks. One round; they share a deployment story.
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
9. **`WP-040` obligations, re-assigned** (register `R-9`): **F12, F18, F19 →
   `WP-300`**; **F17 → `WP-270`**; **F19's reconciliation-break arm → `WP-290`**.
   Each owner discharges its rows in its own review and records it.
10. **The fee/reward accounting work** owes ADR-006 §7 item 3's provenance half:
    the versioned §9.13 snapshot that makes the source page and retrieval date
    travel with a fee or reward entry. The `scheduleVersionRef` /
    `programVersionRef` hooks exist; no builder emits one.
11. **Orchestrator**: record this round in `IMPLEMENTATION_STATUS.md`'s work-package
    table (this round may not edit it), and note that the Cross-package risk record
    is now **discharged as an audit and open as a remediation**.

---

## commit_sha

One commit on branch `worktree-agent-a9d317e245f6f9a01`, based on `2d7e7da`. Its
SHA is reported in the agent's returned handoff — a commit cannot contain its own
hash.

**Not merged. Not marked complete.** A strict adversarial review follows on this
tip and, per `AGENTS.md`, it may not be performed by this agent.
