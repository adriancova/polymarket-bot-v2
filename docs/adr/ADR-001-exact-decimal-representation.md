# ADR-001: Exact decimal representation

- **Status:** Accepted
- **Date:** 2026-08-26
- **Recorded by:** `WP-030`
- **Implemented by:** `WP-020` — implementation exists and is frozen
  (`packages/decimal`, `packages/domain`; see `docs/contracts/domain.md`)
- **Supersedes / Superseded by:** none
- **Amendments:** 2026-10-05 (`V2-0`): §8 gains item 6, the bounded binary64
  rule for Data API v2 sizes read through the SDK, ruled by the user.
  `V2-6` implements it; not yet.

## Context

Handoff §2 locks the numeric representation: "Canonical decimal strings at
boundaries; exact decimal arithmetic internally; no JavaScript `number` for
prices, sizes, fees, balances, or PnL." Handoff §6 invariant 1 restates it as an
invariant enforced by tests and, where possible, database constraints. Handoff
§1.3 makes "changing numeric representation" an ADR-gated change.

Two things were left open by the specification and are settled here.

1. **The library.** Handoff §2.1 names "`decimal.js` (or an ADR-approved
   exact-decimal equivalent)". This ADR is that approval.
2. **The exact grammar and its boundaries.** Handoff §7.3 gives seven validation
   rules in prose, including one that applies *only* to hashing ("Normalize
   redundant leading/trailing zeros **before hashing**"). It does not give a
   grammar, a hash preimage, a precision, or a rounding mode. `WP-020` derived
   these and asked for ratification (`docs/handoffs/WP-020.md` → `follow_up` 2).

The venue makes this concrete rather than academic. Order price and size decimal
precision depends on the market's tick size (tick `0.01` → price 2 dp; `0.001` →
3 dp; `0.0001` → 4 dp; size 2 dp) and raw maker/taker amounts are six-decimal
integers (venue report §2.1). Trading fees are computed as
`fee = C × feeRate × p × (1 − p)` and rounded to 5 decimal places with a minimum
charged fee of `0.00001` (venue report §6). The Chainlink TWAP feed publishes
both a floating `value` and a string `full_accuracy_value` (venue report §10.3).
None of these survive a round trip through IEEE-754 binary floating point
intact.

## Decision

### 1. Library

`decimal.js` is the exact-decimal implementation, and it is the **only** runtime
dependency of `packages/decimal` besides `node:crypto` (used for a pure,
synchronous SHA-256; the package performs no I/O). The resolved version is
pinned by `pnpm-lock.yaml` (`decimal.js@10.6.0` at the time of `WP-020`).
Replacing it, or adding a second arithmetic implementation anywhere in the
repository, requires a new ADR.

`packages/decimal` sits below `packages/domain` and does not import it
(`docs/contracts/dependency-direction.md`).

### 2. Canonical grammar (handoff §7.3)

```text
canonical    := "-"? integerPart ( "." fractionPart )?
integerPart  := "0" | [1-9] [0-9]*
fractionPart := [0-9]* [1-9]
```

plus: canonical zero is exactly `"0"`, never `"-0"`.

This grammar is the literal reading of §7.3: no scientific notation, no leading
`+`, canonical zero `"0"`, no trailing decimal point, and no redundant leading or
trailing zeros. It is the only form any schema in `packages/domain` accepts.

Additional constraints that ride on the same type:

- `PriceString` and `ProbabilityString` are constrained to `[0, 1]` ("Price must
  be in `[0, 1]` where context requires", §7.3). Reference-venue spot prices
  (Binance, Coinbase, Chainlink) are **not** `PriceString` values — the unit
  interval is a property of a Polymarket outcome-token probability, not of a spot
  price.
- Tick conformance is checked with exact modulo arithmetic (§7.3): both operands
  are scaled to integers by the larger of their decimal-place counts and an
  integer modulo is taken. A non-positive tick size is a typed error.

### 3. Three grammars, deliberately distinct

§7.3 states one relaxation and states its other prohibitions unconditionally.
That produces exactly three grammars, and this ADR ratifies keeping them apart:

| Grammar | Entry point | Accepts | Used by |
| --- | --- | --- | --- |
| canonical | `assertCanonicalDecimalString`, every Zod economic schema | the canonical form only | every contract boundary |
| hash input | `normalizeHashableDecimalString` | canonical **plus** redundant leading zeros, trailing fractional zeros, signed/padded zero | `canonicalDecimalHash`, `canonicalDecimalPreimage` |
| venue input | `normalizeDecimalString` | the above **plus** `"+1.5"`, `"1."`, `".5"` | adapters that own a venue wire format |

**The boundary never coerces.** There is no implicit normalization anywhere in
`packages/domain`. An adapter that receives a non-canonical venue spelling must
call `normalizeDecimalString` explicitly, in the adapter, and pass the *result*
across the boundary.

Rationale for strictness, given that a normalizer exists:

- One value has exactly one representation inside the system, so `===`, map keys,
  database uniqueness constraints, and canonical hashes all agree.
- A silently coerced value hides an integration bug. If a venue starts sending a
  different spelling we want a typed error at the adapter, not a quiet change of
  representation deep inside the ledger.
- Coercion inside a schema makes validation non-idempotent: `parse(parse(x))`
  could differ from `parse(x)` in what it accepts.

**The hash grammar is not the venue grammar.** Hashing accepts only what §7.3
sanctions normalizing before hashing. `"+1.5"`, `"1."`, `".5"`, `"1e5"`, and
non-strings raise a typed error rather than producing a digest, because hashing a
§7.3-forbidden spelling would make that spelling reachable through a persisted
identity.

### 4. Canonical hash

```text
value
  → normalizeHashableDecimalString(value)
  → "polymarket-bot/decimal/v1:" + canonicalForm      (UTF-8 preimage)
  → SHA-256
  → lowercase hex
```

- The domain tag `polymarket-bot/decimal/v1` is a constant prefix. It
  domain-separates a decimal digest from a digest computed over some other
  payload that happens to serialize to the same characters.
- `canonicalDecimalPreimage` exposes the exact bytes, so any digest is
  reproducible by hand
  (`printf 'polymarket-bot/decimal/v1:1.5' | sha256sum`). Two golden digests are
  pinned in `packages/decimal/src/hash.test.ts`.
- Every spelling §7.3 permits normalizing shares one digest: `"1.5"`, `"1.50"`,
  `"01.5"`, `"0001.500000"`; and `"0"`, `"-0"`, `"0.0"`, `"-0.000"`, `"00"`.
- **Changing the domain tag (including its `v1` segment), the preimage layout, or
  the hash-input grammar requires a new ADR and a bump of the `v1` segment**,
  because each changes which digests exist and therefore what a persisted digest
  means.
- SHA-256 is collision-*resistant*, not collision-free. Nothing in this
  repository claims a proof of non-collision; the property test provides sampled
  evidence only.

### 5. Arithmetic, precision, and rounding

| Operation | Precision | Rounding |
| --- | --- | --- |
| `addDecimal`, `subDecimal`, `mulDecimal` | `EXACT_PRECISION` (1e9 significant digits) | **never rounds**; a breach throws `DecimalInexactError` |
| `divDecimal` | `DIVISION_PRECISION` = 34 significant digits, overridable per call | `ROUND_HALF_EVEN`, overridable per call |
| `divDecimalExact` | probes 200 significant digits | never rounds; throws `DecimalInexactError` when the quotient does not terminate |
| `compareDecimal` | exact | n/a |

- All arithmetic is string in, string out. A JavaScript `number` argument throws
  `InvalidDecimalStringError`; it is never coerced.
- Addition, subtraction, and multiplication of decimals are exact operations, so
  the implementation refuses to round rather than silently truncating a result.
- Division is the only operation that can fail to terminate, so it is the only
  one with a default precision and rounding mode. 34 significant digits is the
  IEEE-754-2008 `decimal128` coefficient width — wide enough that no realistic
  price/size/fee quotient loses information, and a fixed, documented number
  rather than an ad-hoc one. `ROUND_HALF_EVEN` is chosen because it is unbiased
  over repeated roundings, which matters when a division feeds an accumulated
  balance.
- Both are overridable per call, because a caller that owns a rounding rule must
  state it explicitly (see 6).
- `MAX_DECIMAL_STRING_LENGTH` = 1024 characters bounds any decimal string. This
  is boundary hygiene for a process that parses untrusted venue frames, not a
  venue fact; it is far above any real economic value.

**Typed errors: class and code agree, and a bad argument is not an inexactness**
(added 2026-08-26 by the Wave 0 closeout remediation, finding L9; defect fixes
under this ADR, additive to the error union — no arithmetic result, canonical
grammar, hash preimage, or golden digest changes):

- `DecimalInexactError` / `DECIMAL_INEXACT` means a **result** could not be
  represented exactly: a non-terminating quotient, a result past
  `EXACT_PRECISION`, or a result longer than `MAX_DECIMAL_STRING_LENGTH`.
- An out-of-range **argument** is reported separately. `divDecimal`'s `precision`
  option must be an integer in `[1, EXACT_PRECISION]`; a violation raises
  `DecimalRangeError` with the new code `DECIMAL_INVALID_PRECISION`. It
  previously raised `DecimalInexactError`, which told the caller a false story
  about what failed. `DecimalRangeError` therefore carries two codes and callers
  branch on the code: `DECIMAL_OUT_OF_RANGE` is a fact about an economic value,
  `DECIMAL_INVALID_PRECISION` is a caller-argument defect.
- Every `InvalidTickSizeError` carries `DECIMAL_INVALID_TICK`. One internal
  invariant guard in `tick.ts` carried `DECIMAL_INEXACT`, so a class-based and a
  code-based observer would have disagreed about the same failure.
- The class ↔ code pairing is written down in `packages/decimal/src/errors.ts`
  and asserted for every reachable throw site in
  `packages/decimal/src/errors.test.ts`.

### 6. Money rounding is *not* owned by `packages/decimal`

Fee rounding, payout rounding, and tick-rounding **direction** are deliberately
absent from the decimal package. They are policy owned by the component that owns
the rule — the fee model, the PnL engine, the execution planner — and that
component must pass an explicit rounding mode. A default rounding rule buried in
a shared arithmetic helper is how an unreviewed economic policy spreads.

Concretely: the venue's own fee rounding (5 decimal places, minimum charged fee
`0.00001`, venue report §6) is a **versioned venue parameter snapshot**, not a
constant in `packages/decimal`, and historical runs must use the historical
snapshot (handoff §6 invariant 9, §9.13, §12.5).

### 7. No economic field ever accepts `number`

Every economic schema is built on `z.string()`, so a `number`, `bigint`,
`Number` object, or numeric-looking object fails before any canonicalization
check runs (handoff §7.3: "No domain schema accepts `number` for an economic
field").

Non-economic integers remain JavaScript numbers (`schemaVersion`,
`subscriptionGeneration`, `quoteLifetimeMs`, `replaceThresholdTicks`,
`stalenessMs`, `windowSeconds`). Bigint-like values (`ingestSeq`,
`receivedMonotonicNs`, `rawRecordOffset`) are canonical unsigned integer strings,
because `number` cannot hold them exactly.

### 8. Adapter obligations at the venue edge

These follow from 3 and 7 and are stated so no adapter has to re-derive them.
Each cites the venue report; none is asserted on this ADR's own authority.

1. **Empty-string optional decimals.** The CLOB WebSocket serializes an absent
   optional decimal as the empty string `""` — the SDK's
   `OptionalDecimalStringSchema` treats it as an accepted value, not a malformed
   one, for `fee_rate_bps`, `best_bid`, `best_ask`, `spread`, `min_order_size`,
   `tick_size`, `old_tick_size`, and `last_trade_price` (venue report §4). An
   adapter must map `""` to *absent* before the boundary. It must not pass `""`
   to the canonical parser and must not invent `"0"` in its place — an absent
   best bid is not a zero best bid.

   The same division applies to `null`: where the SDK declares a field
   `.nullish()`, the **adapter** accepts `null` and maps it to *absent* before
   the boundary, and `packages/domain` stays strict — it never accepts `null`
   for a venue-derived field
   ([ADR-002](./ADR-002-event-envelope-and-ordering-semantics.md) §7 carries the
   binding list). Absence and `null` are different facts on the wire; past the
   boundary they are one fact — *absent*.
2. **JSON-number decimals on Gamma.** Some Gamma reward fields legitimately
   arrive as JSON numbers on the raw wire while the SDK-parsed value a
   `@polymarket/client` consumer observes is always a decimal string; the SDK
   bridges them with
   `DecimalishSchema = z.union([DecimalStringSchema, z.number().transform(...)])`
   (venue report §7.1). An adapter must accept both input forms and normalize to
   a canonical decimal string before the boundary. It must **not** copy the
   `WP-000` fixture catalog's parsed-layer-only strictness into a runtime parser
   — see [ADR-002](./ADR-002-event-envelope-and-ordering-semantics.md) §7
   ("Fixture-only narrowings must not be inherited by runtime parsers") and
   `docs/venue/verified-2026-08-24.md` §7.1.
3. **Full-accuracy TWAP.** RTDS TWAP updates carry both `value` (a JSON number)
   and `full_accuracy_value` (a string integer) (venue report §10.3). The
   exact-decimal ingestion path must use `full_accuracy_value` and must never
   read `value`.
4. **Six-decimal integer amounts.** Raw signed-order `makerAmount`/`takerAmount`
   are six-decimal integers, and price/size precision is tick-dependent (venue
   report §2.1). Conversion between the canonical decimal form and the venue's
   integer encoding belongs to `packages/polymarket-secure` (handoff §9.12) and
   must be exact in both directions.
5. **Denomination is not a decimal concern.** The official pages describe fees in
   USDC and rebate/reward payouts in pUSD (venue report §6, conflict C-2 in §11).
   That conflict is **unresolved** and is carried by ADR-006; no decimal helper
   may imply the two are interchangeable.

**Amendment, 2026-10-05 (`V2-0`): item 6, ruled by the user.**
- **The ruling.** The user ruled on 2026-10-05, in the session, on
  `VENUE-4`'s plan: "ADR-001 §8: the bounded binary64 rule" for Data API v2
  sizes read through the SDK. `docs/handoffs/VENUE-4.md` records it ("The
  user's rulings on this plan (2026-10-05)", item 3).
- **The rule** is the plan's (`docs/venue/protocol-v2-migration-plan.md`
  §5 item 6 and §7.1 S4). Its facts are `docs/venue/verified-2026-10-05.md`,
  cited by id.
- **Its standing.** Unlike items 1-5, item 6 does not follow from §3 and §7.
  It is a ruling, and the user's ruling is its authority.

6. **Data API v2 sizes read through the SDK: the bounded binary64 rule.**
   - **Why a rule is needed.**
     - The Data API types sizes as JSON `number`, `format: double` (F-77).
     - The SDK parses each body with `response.json()`, and turns each
       number into `String(value)` (F-78). So `1e3` arrives as `"1000"`.
     - The SDK offers no hook before that parse (F-78). The venue's lexeme is
       gone before any adapter sees it, so no adapter on this path can check
       it.
   - **Scope.** The sizes of the Data API v2 account reads that
     `packages/polymarket-secure` makes through the SDK: the `/v2/positions`
     sizes reconciliation reads (plan `V2-6`). It does not cover:
     - prices or other ratios, which the reconciliation port never reads;
     - CLOB `/data/trades`, whose `price` and `size` are strings (F-78);
     - our own doors, which read raw bodies;
     - `/v2/resolutions` payouts, which ADR-009 §8 governs (note of
       2026-10-05).
   - **The domain D,** checked on the SDK's string: a canonical (§2)
     non-negative decimal below 10^9, with at most 6 fractional digits.
     Such a decimal has at most 15 significant digits. Six decimals is the
     venue's base unit: "`1_000_000` is one pUSD or one share" (F-73).
   - **The rule.**
     - A size whose SDK string is in D is accepted as that string. It is
       already canonical, so it crosses the boundary unchanged. The adapter
       neither normalizes nor rounds it.
     - Aliases and underflow are accepted as their double's string (F-78):
       `1e3` and `1E3` give `"1000"`; `0.99999999999999999` gives `"1"`;
       `1e-400`, `-1e-400` and `-0` give `"0"`.
     - Every string outside D is refused, and the whole read with it, as a
       rejection or as an answer the door refuses. The adapter never drops
       the row. For example, `999999999999999.06` gives `"999999999999999"`,
       and `1e400` gives `"Infinity"`: both are refused (F-78).
   - **The bound, and its argument** (INF, checked by the probes in F-78).
     - Each member m of D prints back unchanged from its nearest double x.
       F-78's probe found 0 mismatches over 4 000 007 members, in four
       spellings each.
     - A lexeme L whose string is m therefore parses to the same x. L and m
       each lie within half a unit in the last place (ulp) of x, so
       |L − m| ≤ ulp(x).
     - Below 10^9, ulp(x) is at most 2^-23 share, about 1.2 × 10^-7. That
       is under half a base unit. F-78's probe found 0 violations over
       1 500 000 seeded lexemes, in exact decimal arithmetic.
     - So a whole number of base units below 10^9 shares is read exactly,
       whatever its spelling. An on-chain balance is always one (F-73).
     - A value more than 2^-23 share from every whole base unit is refused.
     - A value nearer than that to a whole base unit may be read as that
       base unit. This is the precision the rule gives up, and the ruling
       accepts it.
   - **Handoff §6 invariant 1** ("No binary floating point for
     economics").
     - Our code uses no binary floating point here. It receives a decimal
       string; the binary64 step is inside the SDK, as under item 2. INF
       (plan §5 item 6): the rule is consistent with the invariant's text.
     - It still departs from exact venue amounts. The string may differ
       from the venue's lexeme, within the bound above. The user's ruling
       is the authority for that departure. It is an ADR because §1.3 gates
       "Changing numeric representation".
     - §2's grammar and §7 are unchanged. No domain schema accepts a
       `number`.
   - **The other branch is not taken.** An exact boundary before
     `response.json()` would need its own ADR (plan §7.1 S4, "The
     alternative"). The ruling does not need it.
   - **Tests** (plan `V2-6` acceptance 2), through fake `fetch` bodies:
     - every value of D round-trips unchanged;
     - the aliases and underflow above are accepted as their double's
       string;
     - the plan's listed lexemes are refused;
     - a seeded property test shows every accepted size within 2^-23 share
       of its lexeme, in exact decimal arithmetic.
   - **Mode.** It changes nothing above PAPER. It enables no mode, loosens
     no default and adds no binding. No process in this repository binds
     the read (plan `V2-6`, "Allowed paths").

## Consequences

- **Persisted digests are load-bearing.** Any change to the domain tag, the
  preimage layout, or the hash-input grammar invalidates or changes the meaning
  of every stored decimal digest and requires an ADR plus a `v1` bump.
- **A previously-accepted forbidden spelling now throws.** A caller that hands
  `"+1.5"` or `"1."` straight to `canonicalDecimalHash` gets a typed error, not a
  digest. That is intended, and it means adapters must call
  `normalizeDecimalString` explicitly.
- **`divDecimalExact` is bounded, not omniscient.** A quotient that terminates but
  needs more than 200 significant digits raises `DecimalInexactError` rather than
  returning a value. Conservative by design; still a bound, not a proof.
- **`MAX_DECIMAL_STRING_LENGTH` is visible in behavior.** A multiplication whose
  exact result exceeds 1024 characters raises a typed error instead of returning a
  value.
- **Rounding decisions cannot hide.** Because the decimal package has no money
  rounding, a component that needs one has to write it down, which puts it in
  front of a reviewer.
- **`decimal.js` is now a contract dependency, not an implementation detail.** A
  major upgrade needs a contract-level review of precision and rounding behavior,
  not a mechanical bump.
- **The `[0, 1]` price bound is a domain constraint, not a venue-asserted one.**
  It follows from the outcome-token model (every YES/NO pair is backed by exactly
  $1 of collateral through the CTF contracts — venue report §10.2). If the venue
  ever publishes a price outside the unit interval, the adapter fails loudly
  rather than clamping.

## Evidence

**Primary specification** (`docs/spec/polymarket-bot-orchestrator-handoff.md`):

- §2 — locked numeric representation; `pnpm` workspace with an exact lockfile.
- §2.1 — "`decimal.js` (or an ADR-approved exact-decimal equivalent)".
- §1.3 — changing numeric representation requires an ADR and orchestrator
  approval.
- §6 invariant 1 — no binary floating point for economics.
- §6 invariant 9 — market rules, fee schedules, tick sizes, and minimum sizes are
  versioned; historical runs use historical parameters.
- §7.3 — decimal boundary types and the seven validation rules, including
  "Normalize redundant leading/trailing zeros before hashing" and "No domain
  schema accepts `number` for an economic field".
- §9.12 — the rest of the codebase must not import `@polymarket/client` directly.
- §9.13, §12.5 — limits and fee/reward parameters are versioned configuration
  snapshots, not constants.
- §16.1 — unit tests for decimal normalization, arithmetic, tick rounding, and fee
  precision.

**Venue facts** (`docs/venue/verified-2026-08-24.md`, verified 2026-08-24;
snapshot, must be re-verified at each phase start per handoff §1.2):

- §2.1 — price/size decimal precision is tick-dependent (2/3/4 dp price, 2 dp
  size); raw maker/taker amounts are six-decimal integers.
- §4 — the CLOB WebSocket serializes absent optional decimals as `""`
  (`OptionalDecimalStringSchema`), listing the affected fields.
- §6 — `fee = C × feeRate × p × (1 − p)`, rounded to 5 decimal places, minimum
  charged fee `0.00001`; taker-only fees. Snapshot as of 2026-08-24.
- §7 — tick size is dynamic and must always be read from the market.
- §7.1 — the market-details page's three tabs disagree on reward numeric
  representation; the SDK's `DecimalishSchema` accepts `string | number` and
  always outputs a decimal string.
- §10.2 — every YES/NO pair is backed by exactly $1 of collateral through the CTF
  contracts.
- §10.3 — RTDS TWAP payload carries `value` (number) and `full_accuracy_value`
  (string integer).
- §11 conflict **C-2** — official pages denominate fees in USDC and
  rebates/rewards in pUSD. **Unresolved**; carried by ADR-006. This ADR asserts no
  resolution.

**Implementation and prior handoffs:**

- `docs/contracts/domain.md` §3.1–§3.5, §4 — the implemented grammar, the
  three-grammar split, precision/rounding table, hashing, tick conformance, and
  the "economic fields never accept `number`" evidence.
- `docs/handoffs/WP-020.md` — `summary` (the implementation as built),
  `deviations` 2–4, `known_risks` 4–7 (division probe bound, string-length bound,
  preimage now load-bearing, hash grammar narrower than venue grammar), and
  `follow_up` 2 (the explicit request that this ADR ratify these decisions).
- `docs/handoffs/WP-000.md` — `follow_up`: "`WP-020`/`packages/domain`: when the
  reward settings get a canonical schema, accept BOTH forms on input (the SDK's
  own `DecimalishSchema` does) and normalize to a decimal string, rather than
  copying this catalog's parsed-layer-only strictness into a runtime parser."

**The amendment of 2026-10-05 (§8 item 6):**

- `docs/venue/verified-2026-10-05.md` F-73 (six-decimal base units), F-77
  (Data API sizes are JSON doubles) and F-78 (the SDK's parse, and the two
  probes).
- `docs/venue/protocol-v2-migration-plan.md` §5 item 6, §7.1 S4, and
  `V2-6` acceptance 2.
- `docs/handoffs/VENUE-4.md`, "The user's rulings on this plan
  (2026-10-05)", item 3.

**Safety:** this ADR changes no run-mode default. `MAX_RUN_MODE=PAPER`,
`ALLOW_REAL_ORDERS=false`, `LIVE_MICRO_MAX_ORDER_NOTIONAL=0`, and
`LIVE_MICRO_MAX_ACCOUNT_EXPOSURE=0` are unaffected (ADR-010).
