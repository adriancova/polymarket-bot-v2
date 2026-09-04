# `@polymarket-bot/capital-allocator`

Owner: `WP-180`
Authority: `docs/spec/polymarket-bot-orchestrator-handoff.md` §9.7 (Capital
Allocator), §9.10 (reserve before submission), §9.14 (prevent double
reservation), §6 invariants 1/7/10, §11 (run modes)
Related: [`docs/handoffs/WP-180.md`](../../docs/handoffs/WP-180.md),
[ADR-011](../../docs/adr/ADR-011-one-live-owner-per-market-policy.md),
[ADR-016](../../docs/adr/ADR-016-ratified-inferred-domain-shapes.md)

Pure layer-1 logic. **No I/O, no clock, no network, no credential.** Every
monetary and size value is an exact decimal string (§6 invariant 1).

---

## 1. The central rule

§9.7: the allocator "tracks commitments from both positions and open orders".
Every exposure entry therefore carries the two components **separately**, plus
their exact sum:

```ts
{ openOrderCommitted, positionCommitted, combined }
```

and every cap compares against `combined`. **A limit fully consumed by open
orders blocks a new commitment even with zero positions, and vice versa** — the
work plan's acceptance criterion 1, probed at the reservation gate in
`src/allocator.test.ts` and at the intent gate in `test/unit/risk/`.

What counts as committed pUSD exposure:

| Item | Contributes |
| --- | --- |
| a position | its `costBasis` — capital already spent |
| an open **BUY** order | `price × shares` — capital contractually committed, because the order can fill at any moment |
| an applied live **BUY** reservation | its `cost` (§9.10: reserve before submission) |
| an open **SELL** order or SELL reservation | `"0"` — it reserves *outcome tokens*, tracked by the inventory accounting, not by the pUSD table |

## 2. State is a value

`createAllocatorState` validates and derives; transitions return **new deeply
frozen** states; nothing mutates. An in-place edit throws.

Boundary semantics a caller must wire correctly:

- `availableCollateral` is pUSD committed **nowhere** — the caller's number must
  already exclude funds held against the supplied open orders. This package
  derives `reservedCollateral` (§9.7's "reserved pUSD") from open BUY orders plus
  applied live BUY reservations.
- Positions and orders carry a **per-instance** attribution, and inventory
  checks are instance-scoped, so one strategy cannot spend another's tokens
  (§6 invariant 7).
- A state whose sell orders reserve more tokens than the owning instance holds
  is **refused at construction** (§9.14).

### 2.1 Consuming a state — its caller-supplied parts have a `null` prototype

**Read this before consuming a state or a verdict downstream.** Everything this
package took from a caller is the *materialized* tree
(`@polymarket-bot/risk/plain-data`), so
it is created with `Object.create(null)`; the containers this package builds
itself are ordinary objects. Measured, and pinned by
`test/unit/risk/public-surface.test.ts`:

| Value | Prototype |
| --- | --- |
| `state` itself, `state.liveOwners` | `Object.prototype` (built here) |
| `state.positions[i]`, `state.openOrders[i]`, and their `scope` | **`null`** (materialized from the caller) |
| the caps object `parseAllocatorCaps` returns | **`null`** (materialized from the caller) |

So on a materialized member use `Object.hasOwn(value, key)`, not
`value.hasOwnProperty(key)`, and do not use `value instanceof Object` as an
"is this an object" test. `JSON.stringify`, `Object.keys`, `in`, dotted reads and
destructuring all behave normally. A **spread or a `structuredClone` RESTORES
`Object.prototype`**, which silently gives up the guarantee that an absent field
reads as absent — re-harden or re-validate a copy before reading optional fields
off it. The same guidance, in full, is in `packages/risk/README.md` §6.1.

## 3. Caps

§9.7: "Initial defaults should reflect user-defined caps rather than hardcoded
historical examples." So:

| Cap | Default | Caller may set |
| --- | --- | --- |
| `globalAccountCap` | **required**, no default | yes |
| `perStrategyCap` | **required**, no default | yes |
| `perMarketCap`, `perSeriesCap`, `perUnderlyingCap`, `perResolutionWindowCap` | optional, no default | yes |
| `liveMicroMaxOrderNotional` | **`"0"`** | **no — fenced** |
| `liveMicroMaxAccountExposure` | **`"0"`** | **no — fenced** |

### The live-micro fence

> **Corrected 2026-09-02 (remediation round 1).** This section previously said
> only that the live-micro defaults "mirror the untouchable repository safety
> defaults" and that "nothing in this package raises them implicitly". That was
> true and *insufficient*: adversarial review round 1 (HIGH) found the caps
> accepted any caller-supplied nonzero value, which made this package a
> **weakening vector** for defaults `AGENTS.md` declares non-weakenable. The
> original wording is preserved here rather than quietly replaced.

`AGENTS.md` declares `LIVE_MICRO_MAX_ORDER_NOTIONAL=0` and
`LIVE_MICRO_MAX_ACCOUNT_EXPOSURE=0` **non-weakenable**. A live-micro cap other
than the exact canonical `"0"` is therefore **refused outright** —
`CAPITAL_LIVE_MICRO_CAP_NOT_PERMITTED` — at three layers, so no caller path
reaches a raised floor:

1. `AllocatorCapsSchema` carries the fence as a schema refinement, so parsing
   directly cannot bypass it;
2. `parseAllocatorCaps` applies it separately, so a raised floor reports its own
   typed code rather than a generic schema failure;
3. `evaluateReservation` re-applies it at the enforcement site for **every** run
   mode and accounting mode, so a hand-built caps object is unusable — no
   reservation is evaluated against caps that weaken a safety default.

Values are compared by exact canonical spelling, so a non-canonical or
unparseable value refuses too (fail closed, and the comparison cannot throw).

**A cap must be an OWN DATA property at the exact floor** (review round 6). Three
readings are refused where round 5 accepted them, and each was reachable:
a value only an INHERITED property supplies (the fence saw "absent, therefore
fine" while `src/reserve.ts` read the inherited value as the cap); an ACCESSOR
(a getter is code, not a cap); and anything unreadable, including a `Proxy` —
`nonFloorLiveMicroCapFields` used to THROW on one out of a public export.
"Absent" now means *unreachable on the whole prototype chain*, and
`parseAllocatorCaps` additionally refuses when a fenced field is missing from
its own validated output, which an inherited get-only accessor can cause by
making the validator's assignment of the default fail.

**Enabling live-micro capacity is a separate, explicitly authorized, fenced
later-phase work package** with its own human approval and its own fencing
authority — never an argument to this one. Until such a package exists, this
package grants no real-order capacity at all: with the floors in place, any
positive-notional commitment in a real-order run mode (`EXECUTION_PROBE`,
`LIVE_MICRO`, `LIVE`) is refused
(`CAPITAL_LIVE_MICRO_ORDER_NOTIONAL_EXCEEDED` /
`CAPITAL_LIVE_MICRO_EXPOSURE_EXCEEDED`).

A cap configured for a scope dimension the request cannot be attributed to
**fails closed** (`CAPITAL_SCOPE_KEY_MISSING`): an unattributable request cannot
be proven within the cap.

**And the parse that reaches the fence is prototype-free too** (review round 8).
Every door in this package — `parseAllocatorCaps`, `createAllocatorState`,
`evaluateReservation` — validates through a **parsing copy** of its schema
(`@polymarket-bot/risk/schema-arena`) whose output assembly and parse context have no
prototype. Two measured consequences, both closed here: an inherited SETTER can
no longer be invoked while the library assembles an output these doors discard
(it aborted the parse when it threw), and an inherited `skipChecks` can no longer
turn the library's own format checks into no-ops — which, at the round-7 tip,
made a malformed decimal validate. The fence's three layers are unchanged and
still apply in the same order.

## 3.1 Exposure snapshots: sparse, and sparse is not zero

`exposureSnapshot` is sparse by construction — a scope with no positions,
orders, or reservations simply has no row. **A consumer enforcing a cap must
not read that absence as zero**: `@polymarket-bot/risk`'s §9.8 check 15 refuses
it (`RISK_EXPOSURE_ENTRY_MISSING`) rather than passing a cap against unmeasured
exposure (adversarial review round 1, BLOCKER 2 — that fail-open substitution
was a real limit bypass).

`exposureSnapshotCovering(state, coverage)` is how a composition root turns
"I am about to query these scopes" into a snapshot that **answers** for every
one of them, adding an explicit zero entry for any key the state does not
otherwise mention. The zeros are exact: only the snapshot is sparse, the
allocator state is complete, so a key it does not mention genuinely holds
nothing.

**A scope key is a `CodeString`, so an inherited property name is admissible
input** (adversarial review round 5, the sweep behind that round's first
BLOCKER). Every table here is therefore read with `ownEntry` and written with
`setOwn` (`src/guards.ts`), never with `table[key]`: `"constructor"` answers the
`Object` constructor rather than `undefined`, so the accumulator would have read
an intrinsic as an existing entry and written commitment components onto it,
`exposureSnapshotCovering` would have skipped the explicit zero it exists to
guarantee, and the risk side's `RISK_EXPOSURE_ENTRY_MISSING` would have read the
same intrinsic as a measurement.

**Round 5's sweep was incomplete, and the gap was a fail-open** (adversarial
review round 6, BLOCKER 1). It missed three reads in `src/reserve.ts` and one in
`src/exposure.ts`, and the ownership read is the most serious defect in this
package's history: `state.liveOwners[req.marketId]` walks the prototype chain, so
an **inherited** owner authorized a LIVE commitment where
`CAPITAL_LIVE_OWNERSHIP_MISSING` was owed. It was reproduced twice — once with a
caller-built `liveOwners`, and once with a state THIS LIBRARY built and a single
non-enumerable `Object.prototype` property spelled as the market's UUID. The
same class made a SELL with **zero holdings** see `held=1000` through a
two-answer getter on the composite inventory key. All four sites are own reads
now, and the sweep is no longer a sweep: `test/unit/risk/prototype-access.test.ts`
asks the TypeScript compiler for every computed access, `in`, spread and
`Object.assign` in both packages and fails the build, naming the site, unless it
is an own-property primitive or a registered exception with a reason.
`test/unit/risk/inherited-state.test.ts` adds the behavioural half: every public
door is re-run with `Object.prototype` carrying one extra property, and the
answer must be unchanged or a typed refusal. That test found one more hole no
syntactic rule would have: the live-micro fence read an **absent** field as
"fine" while the enforcement site in `src/reserve.ts` read the same INHERITED
value as the cap — a weakening of an `AGENTS.md` floor by prototype augmentation
alone. "Absent" now means *unreachable*, and anything unreadable is reported as
non-floor.

## 4. Reservations

- `evaluateReservation` answers "may this commitment be made" and changes
  nothing.
- `applyReservation` **re-evaluates against the state it is given** and returns a
  new frozen state, so a stale verdict cannot overspend.
- `releaseReservation` returns the capacity.

**V1 does not net opposing strategy intents** (§9.7). A LIVE commitment requires
the requesting instance to be the recorded live owner of the market (ADR-011);
a conflicting owner — or **no owner at all** — is a refusal, never a silent
claim. `SHADOW` commitments are accounted in the instance's own independent
shadow book and never touch live collateral, live inventory, or live caps; the
independence holds in both directions.

## 5. Reason codes — the PACKAGE-OWNED vocabulary

**The vocabulary has exactly 19 codes**, all listed below.

Stable `CodeString`-shaped identifiers, safe as metric labels (§14.3). Adding a
code is additive; changing the meaning of one is not. The list is exported at
runtime as `CAPITAL_REFUSAL_CODES`, its cardinality as
`CAPITAL_REFUSAL_CODE_COUNT`, and `CAPITAL_REFUSAL_CODES_ARE_EXHAUSTIVE` is a
compile-time proof that the list covers the whole `CapitalRefusalCode` union.
`packages/capital-allocator/src/allocator.test.ts` fails if the count drifts, or
if this section stops documenting exactly the declared set.

> **Added 2026-09-02 (remediation round 1).** The runtime list, the count, and
> the exhaustiveness proof are new: `docs/handoffs/WP-180.md` claimed the
> allocator codes were "enumerated at runtime" when only the risk package's were
> (adversarial review round 1, MEDIUM, on the neighbouring cardinality claim).
> `CAPITAL_LIVE_MICRO_CAP_NOT_PERMITTED` was added by the HIGH fix in the same
> round, taking the total from 18 to 19.

| Code | Meaning |
| --- | --- |
| `CAPITAL_INPUT_INVALID` | Input failed its schema (shape, decimal grammar, id grammar). |
| `CAPITAL_UUID_NOT_CANONICAL` | A UUID-shaped id arrived non-lowercase. ADR-016 §2: refuse, never case-fold. |
| `CAPITAL_DUPLICATE_IDENTIFIER` | Two positions, orders, or reservations share an id. |
| `CAPITAL_UNKNOWN_RESERVATION` | The named reservation does not exist in this state. |
| `CAPITAL_OVERSELL_UNBACKED` | Open sell orders reserve more tokens than the instance holds (§9.14). |
| `CAPITAL_COLLATERAL_INSUFFICIENT` | A buy commitment exceeds available (unreserved) pUSD. |
| `CAPITAL_INVENTORY_INSUFFICIENT` | A sell reservation exceeds the instance's unreserved holdings (§6 invariant 10). |
| `CAPITAL_GLOBAL_CAP_EXCEEDED` | The global account cap. |
| `CAPITAL_STRATEGY_CAP_EXCEEDED` | The per-strategy cap. |
| `CAPITAL_MARKET_CAP_EXCEEDED` | The per-market cap. |
| `CAPITAL_SERIES_CAP_EXCEEDED` | The per-series cap. |
| `CAPITAL_UNDERLYING_CAP_EXCEEDED` | The per-underlying cap. |
| `CAPITAL_RESOLUTION_WINDOW_CAP_EXCEEDED` | The per-resolution-window cap. |
| `CAPITAL_SCOPE_KEY_MISSING` | A scope cap is configured but the request carries no attribution for it (fail closed). |
| `CAPITAL_LIVE_OWNERSHIP_CONFLICT` | Another instance is the live owner of this market (ADR-011). |
| `CAPITAL_LIVE_OWNERSHIP_MISSING` | No live owner is recorded; a live commitment needs one. |
| `CAPITAL_LIVE_MICRO_ORDER_NOTIONAL_EXCEEDED` | A real-order-mode commitment above the live-micro per-order cap (always `"0"`). |
| `CAPITAL_LIVE_MICRO_EXPOSURE_EXCEEDED` | A real-order-mode commitment above the live-micro account-exposure cap (always `"0"`). |
| `CAPITAL_LIVE_MICRO_CAP_NOT_PERMITTED` | A caller supplied a live-micro cap other than the exact `"0"` floor. `AGENTS.md` declares both non-weakenable; raising them is a separate authorized work package, not a caller argument. See §3's fence. |

## 6. Known boundary

A pre-existing **position supplied without a scope attribution** does not appear
in the series / underlying / resolution-window exposure tables. That is a
caller-side data gap rather than a silent pass: the reservation gate still fails
closed on the **request** side (`CAPITAL_SCOPE_KEY_MISSING`) whenever a cap is
configured for a dimension the request cannot be attributed to, so a new
commitment cannot be admitted under an unmeasurable cap. Attributing historical
positions is the caller's responsibility.

## 7. Dependency boundary

Declares `@polymarket-bot/decimal` and `@polymarket-bot/domain` (both layer 0),
`zod`, and — since 2026-09-04 — `@polymarket-bot/risk`, a layer-1 peer, across
the `docs/contracts/dependency-direction.md` §2.1 **S3** same-layer edge.

**What that edge carries, and what it may never carry.** Exactly the two
prototype-free parse-door modules, `@polymarket-bot/risk/plain-data` and
`@polymarket-bot/risk/schema-arena`, reached through `packages/risk`'s `exports`
map (F16). `GOV-2A`'s mirror-collapse ruling is explicit that **no rule, policy,
or evaluation logic may travel this edge**: this package's caps, exposure
accounting, reservation lifecycle and live-micro fence are its own, and a future
need to import a risk *decision* from here is a different problem with a
different answer. `packages/risk` still consumes this package's snapshot and
verdict **structurally** rather than through an edge, so the graph stays acyclic
(F9) and the port is still pinned by `test/unit/risk/ports.test.ts`.

`src/plain-data.ts` and `src/schema-arena.ts` used to be **duplicated** here,
byte-identical below their headers and bound by a drift test. `GOV-2A` ruled the
duplication out — a security mechanism that must be fixed in three places, in
three grants, is the wrong shape for a security mechanism — and `WP-180-FU2`
deleted both copies. `test/unit/execution-planner/mirrors.test.ts` is now a
DELETION guard: it fails if either module's body reappears in any package
outside `packages/risk`.

**Which exports are TOTAL, and which propagate** (review round 6, BLOCKER 3).
Round 5's handoff claimed "no public function throws for any input"; the
reviewer falsified it, and `exposureSnapshot` and `nonFloorLiveMicroCapFields`
were two of the five names. The surface is now enumerated export by export in
`test/unit/risk/public-surface.test.ts`, which fails if an export is added
without a classification:

- **TOTAL** — every `unknown` door (`parseAllocatorCaps`, `createAllocatorState`,
  `evaluateReservation`, `applyReservation`, `releaseReservation`), plus
  `withLiveOwner`, the live-micro fence (`nonFloorLiveMicroCapFields`,
  `liveMicroCapRefusals`), the refusal constructors and `inventoryKey`. Each is
  handed a `Proxy` whose every trap throws and must answer with a typed refusal.
- **PROPAGATES, deliberately** — `exposureSnapshot`,
  `exposureSnapshotCovering`, `shadowExposureSnapshot`, `heldSharesByKey`,
  `reservedSharesByKey`. Their result types cannot express a refusal, so
  containing them would mean returning an EMPTY snapshot or an EMPTY inventory
  table — which reads as zero committed exposure and zero reserved shares, the
  two most dangerous numbers in this package. They are called inside `contained`
  at every in-repository site, so no public ANSWER of this package is an
  exception. The test runs each hostile call and requires it to throw, so the
  classification is measured rather than asserted.

**No Node built-in is imported here any more, and that is now the audit.** This
package used to hold one — `import { types } from "node:util";` in its copy of
`src/plain-data.ts`, used only as `types.isProxy`, the one thing portable
JavaScript cannot do because every reflective operation on a `Proxy` runs a
trap. The 2026-09-04 collapse (`WP-180-FU2`) deleted that copy, so the built-in
now lives once, in `packages/risk`, where
`docs/contracts/dependency-direction.md` §2.2 enumerates it. This package's
production sources import **zero** `node:` specifiers, and
`test/unit/risk/freshness.test.ts` asserts that as an EQUALITY over both
packages rather than as an absence: the census lists exactly
`risk/plain-data.ts` and nothing else. A type predicate performs no I/O either
way — this package still opens no connection, reads no clock and holds no
credential. Since review round 6 that pin is **AST-based**: the previous
version matched a regular expression and was bypassable four ways (`const t =
types`, `const { isDate } = types`, `types["isDate"]`, and a bare reference).
The audit now resolves the import to its local binding and classifies every
reference to it, so an alias, a destructuring and a computed access are each
reported.
