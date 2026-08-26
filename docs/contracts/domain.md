# Domain contracts and exact decimal types

Owner: `WP-020`
Packages: `packages/domain` (`@polymarket-bot/domain`), `packages/decimal` (`@polymarket-bot/decimal`)
Authority: `docs/spec/polymarket-bot-orchestrator-handoff.md` §5.2, §6, §7, §11, §16
Status: frozen on WP-020 acceptance — see [Contract freeze](#contract-freeze)

---

## 1. Package purposes

### `@polymarket-bot/decimal`

The exact-decimal foundation. It owns one question: *what is a legal economic
value, and how is it computed without binary floating point?*

| Module | Responsibility |
| --- | --- |
| `canonical.ts` | The three decimal grammars (canonical, hash input, venue input), strict validation, normalization, digit accessors |
| `arithmetic.ts` | `add` / `sub` / `mul` / `div` / `compare` and sign helpers, string in, string out |
| `hash.ts` | Deterministic SHA-256 over the canonical form |
| `tick.ts` | Exact tick conformance by integer modulo |
| `errors.ts` | Typed errors with stable `code` values |

Dependencies: `decimal.js` and `node:crypto` only. `node:crypto` is used for a
pure, synchronous SHA-256 computation; the package performs no I/O.

### `@polymarket-bot/domain`

The frozen versioned contracts every other package consumes.

| Module | Handoff section |
| --- | --- |
| `envelope.ts` | §7.1 event envelope |
| `identifiers.ts` | §7.2 canonical identifiers |
| `decimals.ts` | §7.3 decimal boundary types |
| `events/**` | §7.4 normalized market events (all 22) |
| `decision.ts` | §7.5 strategy callback result |
| `intents.ts` | §7.7 intent types |
| `provenance.ts` | §7.1 envelope/payload provenance agreement |
| `run-mode.ts` | §11 run modes |
| `registry.ts`, `schema-version.ts` | schema versioning utilities |
| `primitives.ts`, `errors.ts` | shared non-economic primitives and typed errors |

Dependencies: `zod` and `@polymarket-bot/decimal`. Nothing else.

Out of scope for WP-020, deliberately absent: `StrategyContext` and the §7.6
view interfaces (owned by WP-170), storage, adapters, and any I/O.

---

## 2. Dependency direction

Handoff §5.2 permits exactly one direction:

```text
adapters / infrastructure
        ↓
application modules
        ↓
domain contracts and decimal types
```

`packages/domain` importing an adapter, PostgreSQL, Redis, an SDK, or a process
global is forbidden. Concretely, in this package:

- No `import` of any Node built-in (not even `node:crypto`).
- No `process`, `globalThis`, environment access, clock access, or randomness.
- Everything is a declaration; no function in `packages/domain` performs I/O.

`packages/decimal` sits one level below `packages/domain` and does not import it.

---

## 3. Canonical decimal strings

### 3.1 The rules (handoff §7.3)

```text
canonical    := "-"? integerPart ( "." fractionPart )?
integerPart  := "0" | [1-9] [0-9]*
fractionPart := [0-9]* [1-9]
```

plus: canonical zero is exactly `"0"` (never `"-0"`).

| Rule (§7.3) | Effect |
| --- | --- |
| No scientific notation | `"1e5"`, `"1E5"`, `"1e-5"` are rejected everywhere, including as hash input |
| No leading `+` | `"+1"` is rejected at the boundary AND as hash input |
| Canonical zero is `"0"` | `"-0"`, `"0.0"`, `"00"`, `"-0.00"` are rejected at the boundary; all normalize to `"0"` |
| No trailing decimal point | `"1."` is rejected at the boundary AND as hash input |
| Normalize redundant zeros before hashing | `"01.50"` is rejected at the boundary; it normalizes to `"1.5"` and hashes as `"1.5"` |
| Price in `[0, 1]` where context requires | `PriceStringSchema` / `ProbabilityStringSchema` enforce the unit interval |
| Tick conformance by exact modulo | `isTickConformant` scales to integers and takes an integer modulo |

Additional non-canonical spellings that are also rejected at the boundary:
`".5"`, `""`, `"NaN"`, `"Infinity"`, `" 1"`, `"1 "`, `"1,5"`, `"1.2.3"`,
`"0x1f"`, and every non-string value including `number` and `bigint`.

### 3.1.1 Three grammars, deliberately distinct

§7.3 states one relaxation — "normalize redundant leading/trailing zeros
**before hashing**" — and states its other prohibitions unconditionally. That
produces exactly three grammars, and conflating them is how a forbidden form
would leak in:

| Grammar | Entry point | Accepts | Used by |
| --- | --- | --- | --- |
| canonical | `assertCanonicalDecimalString`, every Zod economic schema | the canonical form only | every contract boundary |
| hash input | `normalizeHashableDecimalString` | canonical **plus** redundant leading zeros, trailing fractional zeros, signed/padded zero | `canonicalDecimalHash`, `canonicalDecimalPreimage` |
| venue input | `normalizeDecimalString` | the above **plus** `"+1.5"`, `"1."`, `".5"` | adapters that own a venue wire format |

The hash grammar is not the venue grammar. Hashing accepts only what §7.3
sanctions normalizing, so `"+1.5"`, `"1."`, `".5"`, `"1e5"`, and non-strings
throw a typed error rather than producing a digest. A venue value spelled in a
forbidden way must be passed through `normalizeDecimalString` explicitly, in the
adapter, and the *result* hashed — the hashing path never does it silently.

Typed error codes for the hash-input rejections: `DECIMAL_LEADING_PLUS`,
`DECIMAL_TRAILING_POINT`, `DECIMAL_MISSING_INTEGER_PART`,
`DECIMAL_SCIENTIFIC_NOTATION`, `DECIMAL_EMPTY`, `DECIMAL_NOT_A_STRING`,
`DECIMAL_MALFORMED`.

### 3.2 Strict boundary, explicit normalization

**Boundary schemas accept ONLY the canonical form.** There is no implicit
coercion anywhere in `packages/domain`.

**`normalizeDecimalString` is the one sanctioned way to accept venue
spellings.** It is a separate, explicitly-called function that belongs in the
adapter owning a wire format. It accepts a leading `+`, redundant leading
zeros, trailing fractional zeros, `-0` spellings, `".5"` (→ `"0.5"`), and
`"1."` (→ `"1"`), and returns the canonical form. It still rejects scientific
notation, whitespace, empty strings, `"NaN"`, `"Infinity"`, and non-strings.

Why strict, given that normalization exists?

- One value has exactly one representation inside the system, so `===`, map
  keys, database uniqueness constraints, and canonical hashes all agree.
- A silently coerced value hides a real integration bug: if a venue starts
  sending a different spelling, we want a typed error at the adapter, not a
  quiet change of representation deep inside the ledger.
- Coercion in a schema would make validation non-idempotent (`parse(parse(x))`
  could differ from `parse(x)` in what it accepts).

Both directions are covered by tests: canonical values are accepted, every
non-canonical spelling is rejected, and `normalizeDecimalString` maps each
spelling to the canonical form.

### 3.3 Arithmetic, precision, and rounding

All arithmetic takes canonical strings and returns canonical strings. A
JavaScript `number` argument throws `InvalidDecimalStringError`.

| Operation | Precision | Rounding |
| --- | --- | --- |
| `addDecimal`, `subDecimal`, `mulDecimal` | `EXACT_PRECISION` (1e9 significant digits) | never rounds; a breach throws `DecimalInexactError` |
| `divDecimal` | `DIVISION_PRECISION` = 34 significant digits, overridable per call | `ROUND_HALF_EVEN`, overridable per call |
| `divDecimalExact` | probes `EXACT_DIVISION_PROBE_PRECISION` = 200 significant digits | never rounds; throws `DecimalInexactError` when the quotient does not terminate |
| `compareDecimal` | exact | n/a |

Inputs are bounded by `MAX_DECIMAL_STRING_LENGTH` (1024 characters) — a
pathological-input guard for a process that parses untrusted venue frames, far
above any real economic value. Division by zero throws
`DecimalDivisionByZeroError`.

Money rounding rules (fees, payouts, tick rounding direction) are deliberately
**not** defined in this package. They belong to the components that own those
rules and must pass an explicit rounding mode.

### 3.4 Canonical hashing

```text
value → normalizeHashableDecimalString(value) → "polymarket-bot/decimal/v1:" + canonical → SHA-256 → lowercase hex
```

**Preimage** — unchanged since the first WP-020 implementation:
`CANONICAL_DECIMAL_HASH_DOMAIN + ":" + canonicalForm`, UTF-8, where
`CANONICAL_DECIMAL_HASH_DOMAIN` is the literal `polymarket-bot/decimal/v1`.
`canonicalDecimalPreimage` exposes those exact bytes so a digest can be
reproduced by hand (`printf 'polymarket-bot/decimal/v1:1.5' | sha256sum`), and
two golden digests are pinned in `packages/decimal/src/hash.test.ts`.

**Accepted input** is the hash-input grammar of §3.1.1, not the venue grammar:

- Deterministic: the same value always produces the same digest.
- Representation-independent across the spellings §7.3 permits normalizing:
  `"1.5"`, `"1.50"`, `"01.5"`, `"0001.500000"` share one digest; `"0"`, `"-0"`,
  `"0.0"`, `"-0.000"`, `"00"` share one digest.
- **Forbidden forms are rejected, not silently accepted**: `"+1.5"`, `"+0"`,
  `"1."`, `".5"`, `"-.5"`, `"1e5"`, `""`, and every non-string throw a typed
  `InvalidDecimalStringError`. Hashing a value §7.3 forbids would make the
  forbidden spelling reachable through a persisted identity.
- Domain-separated: the constant prefix makes it computationally infeasible for
  a decimal digest to coincide with a digest computed over some other payload
  that happens to serialize to the same characters. Changing the prefix
  (including its `v1` segment), the preimage layout, **or the hash-input
  grammar** changes what digests exist and therefore requires an ADR.

**On collisions.** SHA-256 is collision-*resistant*, not collision-free. No
finite test can prove that two distinct canonical values never share a digest;
the property test provides sampled non-collision evidence (500 generated pairs
per run) and fails loudly if the preimage ever stops distinguishing two distinct
canonical values. Nothing in this package claims impossibility.

### 3.5 Tick conformance

`isTickConformant(value, tickSize)` scales both operands to exact integers by
the larger of their decimal-place counts and takes an integer modulo. No
floating point and no division rounding is involved, so `"0.07"` on a `"0.01"`
grid is conformant, where `0.07 % 0.01` in IEEE-754 is not. A non-positive tick
size throws `InvalidTickSizeError`.

---

## 4. Economic fields never accept `number`

Every economic schema is built on `z.string()`, so a `number`, `bigint`,
`Number` object, or numeric-looking object fails before any canonicalization
check runs. This is asserted generically in the tests: for every one of the 22
event contracts, replacing *any* string-valued field with a JavaScript number
must fail validation. The mutation walk is **recursive** — it enumerates every
string path in a sample payload including inside nested objects and arrays
(`bids.0.price`, `affectedMarketIds.0`, `changedParameters.0`), rebuilds the
payload immutably at that path, and requires rejection. The walk itself is
covered by its own tests, so it cannot regress to a shallow scan and start
passing vacuously.

| Contract type | Schema | Range |
| --- | --- | --- |
| `DecimalString` | `DecimalStringSchema` | unconstrained sign |
| `PriceString` | `PriceStringSchema` | `[0, 1]` |
| `ProbabilityString` | `ProbabilityStringSchema` | `[0, 1]` |
| `SharesString` | `SharesStringSchema` | unconstrained sign (a `DELTA` target may be negative) |
| `MoneyString` | `MoneyStringSchema` | unconstrained sign (PnL may be negative) |
| — | `NonNegativeSharesStringSchema`, `NonNegativeMoneyStringSchema`, `PositiveDecimalStringSchema` | for caps, limits, and sizes |

Reference-venue spot prices (Binance, Coinbase) are **not** `PriceString`
values: they are non-negative decimals, because the `[0, 1]` constraint applies
to Polymarket outcome-token probabilities.

Integers that are *not* economic values remain JavaScript numbers:
`schemaVersion`, `subscriptionGeneration`, `quoteLifetimeMs`,
`replaceThresholdTicks`, `stalenessMs`, `windowSeconds`, and the versioned
parameter counters. Bigint-like values (`ingestSeq`, `receivedMonotonicNs`,
`rawRecordOffset`) are canonical unsigned integer strings because `number`
cannot hold them exactly.

---

## 5. Versioning policy

### 5.1 Where the version lives

- **Events**: `schemaVersion` is a required envelope field (§7.1). Each event
  contract pins `eventType` and `schemaVersion` to literals, so a payload can
  never be validated under the wrong type or version. The payload does not
  duplicate the version: two copies of one fact eventually disagree, and the
  envelope copy is the one a consumer must read before it can choose a payload
  schema.
- **Non-event contracts** (`DecisionResult`, the intent types): §7.5 and §7.7
  specify exact field lists with no version field, so adding one would
  contradict the specification. Their versions are exported constants indexed by
  `DOMAIN_CONTRACT_VERSIONS` in `schema-version.ts`. A component that persists
  one of these structures persists the matching version alongside it.

Everything frozen by WP-020 is at version `1`.

### 5.2 When `schemaVersion` increments

**Every change to the emitted field set increments `schemaVersion`.** There is
no "an additive optional field may reuse the current version" exemption.

This is forced by the strict-object decision (§7 below): every contract in this
package rejects unknown keys, because silently stripping a field on the
recording path would violate §8.3. Under strict rejection, an "additive" change
is not backward compatible in the direction that matters:

- a consumer still running the previous build of v1 would **reject** a document
  a newer producer emitted as v1 with the extra key — the change breaks exactly
  the consumers it was supposed to be safe for;
- `(eventType, schemaVersion)` would no longer identify one historical schema.
  Two different field sets sharing one registry key makes recorded data
  ambiguous on replay (§8.4, §12.5): given a v1 row you could not tell which v1
  it is.

So a new version is required for all of:

- **adding a field, optional or required**;
- removing or renaming a field;
- widening or narrowing a type, an enum, or a constraint;
- making an optional field required, or a required field optional;
- changing the meaning or the unit of an existing field.

Changes that do not alter what a producer may emit or a consumer must accept —
documentation, error-message wording, internal refactoring — do not increment.

When a version is added, the previous version's contract **stays registered**
(§5.3). This is exercised by an evolution test in
`packages/domain/src/registry.test.ts`: it registers v1 and v2 of a contract
where v2 adds an optional field, and asserts that a v2 document fails v1
parsing, that v1 documents still parse under v1, and that both versions resolve
from the registry.

### 5.2.1 `schemaVersion` is validated at runtime

`SchemaVersion` is statically just `number`, so the type system alone would
allow `0`, `-1`, `1.5`, `NaN`, or `Infinity` into a contract definition — keys
no envelope could ever route to, which would also shadow real versions in
`versionsOf` / `latestVersionOf`. `assertSchemaVersion` enforces "positive
**safe** integer" and is called both by `defineEventContract` and by
`createEventSchemaRegistry` (because `EventContractLike` is structural, a caller
can hand-assemble a contract and bypass the constructor). A violation throws
`InvalidSchemaVersionError` at startup.

**Safe, not merely integral.** `Number.isInteger(9007199254740992)` is `true`,
but `SchemaVersionSchema` is `z.int()`, which accepts only the safe-integer
range — and `EventEnvelopeRoutingSchema` parses an incoming `schemaVersion`
through that same schema. Had construction used `Number.isInteger`, a contract
could be registered under a key no envelope could ever route to; above
`Number.MAX_SAFE_INTEGER` two "different" versions are not even distinct
(`2**53 + 1 === 2**53`), so they would collide on one registry key. Construction
and routing therefore use one definition of the valid range, pinned by a test
that walks the boundary (`Number.MAX_SAFE_INTEGER`, `+1`, `1e21`) through
`assertSchemaVersion`, `isSchemaVersion`, and `SchemaVersionSchema` together.

### 5.3 Registry usage

```ts
import { DOMAIN_EVENT_REGISTRY } from "@polymarket-bot/domain";

const envelope = DOMAIN_EVENT_REGISTRY.parseEnvelope(frame); // throws typed errors
const result = DOMAIN_EVENT_REGISTRY.safeParseEnvelope(frame); // non-throwing
```

- `lookup` / `require` / `has` resolve `(eventType, schemaVersion)`.
- `versionsOf` / `latestVersionOf` expose the registered versions of a type.
- `parseEnvelope` routes on the envelope's own `eventType` and `schemaVersion`,
  then validates against that contract's pinned envelope schema — including the
  §6.3 provenance agreement, which that schema carries. An unregistered pair
  raises `UnknownEventContractError`; a schema failure raises
  `EventValidationError` with the formatted issue list. `parseEnvelope`
  additionally re-checks provenance itself and raises
  `EventProvenanceMismatchError` for a contract whose envelope schema was
  hand-assembled rather than built by `pinnedEventEnvelopeSchema`;
  `safeParseEnvelope` returns all three failures as typed values.
- `parsePayload` validates a payload independently of an envelope. A payload
  alone cannot know its envelope, so this path cannot check provenance — that is
  what makes the envelope-level enforcement necessary.

**Old versions stay registered.** Replay consumes historical envelopes in
recorded order (§8.4) and must validate them against the schema they were
recorded with, so adding version 2 of an event never removes version 1.
`createEventSchemaRegistry` refuses duplicate `(eventType, schemaVersion)`
registrations and rejects a non-positive-integer `schemaVersion` (§5.2.1).
Together with §5.2 this makes `(eventType, schemaVersion)` a total, injective
key into the historical schemas: exactly one field set per key, and every key
ever emitted stays resolvable.

---

## 6. Invariants the contracts encode

A contract that can express a state the architecture forbids is a latent bug:
someone eventually writes that document, and the reviewer of the consuming code
has to re-derive the invariant from the specification. Where the handoff states
an invariant unconditionally, these contracts make the violating document
unrepresentable.

### 6.1 A detected gap always requires an authoritative snapshot

§7.1: "a restart or detected gap requires a new authoritative snapshot before
affected markets resume." §9.1: the gateway must "resubscribe and obtain
authoritative snapshots after gaps." Neither is conditional.

| Field | Type | Consequence |
| --- | --- | --- |
| `FeedGapDetected.requiresAuthoritativeSnapshot` | `z.literal(true)` | a gap event cannot waive the snapshot requirement |
| `FeedResynchronized.authoritativeSnapshotApplied` | `z.literal(true)` | a resynchronization cannot assert recovery it did not perform |

The fields are kept rather than dropped because they make the obligation
explicit in every recorded frame; pinning them means they can only ever record
the obligation, never waive it. A feed that reconnected but has *not* yet
applied a snapshot is still in the gap state: that is recorded as
`FeedConnected` alongside the still-open `FeedGapDetected` /
`DataQualityIncidentOpened`, not as a `FeedResynchronized`.

Both fields carry the same negative matrix in `events/events.test.ts` —
`false`, `"true"`, `"false"`, `1`, `0`, `null`, `undefined`, and omission — so
neither can be quietly relaxed to `z.boolean()` without a failing test.

### 6.2 `MarketResolved` carries a terminal outcome only

`MarketOutcomeStateSchema` is the full §9.3 vocabulary and remains the right
type for "what settlement state is this market in" (the catalog and settlement
layer, the payoff models). `MarketResolved` uses the terminal subset
`TerminalMarketOutcomeStateSchema` — `YES_WIN`, `NO_WIN`, `SPLIT_50_50`,
`CANCELLED` — because the event asserts that the payoff is determined.

**Ruling on `DISPUTED`: excluded.** A dispute is an in-flight process, not an
outcome; a disputed market has no determined payoff, so a `MarketResolved`
carrying `DISPUTED` would assert a resolution that has not happened and would
invite a settlement consumer to compute a payoff from it. When the dispute
concludes the market resolves to one of the four terminal states and
`MarketResolved` is emitted then. The dispute stays fully observable as market
*state*, and through `MarketClarificationObserved` and
`DataQualityIncidentOpened`. `PENDING` and `PENDING_CLARIFICATION` are excluded
for the same reason. `CANCELLED` is included: it is terminal and its payoff (a
refund) is determined. `isTerminalMarketOutcomeState` and
`NON_TERMINAL_MARKET_OUTCOME_STATES` are exported so consumers branch
explicitly.

### 6.3 Envelope `source` is the authoritative provenance

The envelope `source` (§7.1) is what the gateway assigns alongside
`gatewayEpoch`, `ingestSeq`, and the connection metadata, and what the raw-frame
record ties back to. Nothing in a payload may override it.

Reference-feed payloads nonetheless restate the origin as `venue`, because a
consumer may hold a payload without its envelope (a projection, a feature
snapshot, a persisted row). To keep the restatement from contradicting the
authority:

- `ReferenceVenueSchema` is derived from the §7.1 `source` vocabulary
  (`REFERENCE_VENUES` is `satisfies readonly EventSource[]`), so a payload
  `venue` is always a legal envelope `source` and the two cannot drift. No
  mapping table is invented — they are the same tokens.
- `assertEnvelopePayloadProvenance(envelope, payload)` /
  `checkEnvelopePayloadProvenance` (`provenance.ts`) are pure declarations that
  reject a payload `venue` differing from the envelope `source`, raising
  `EventProvenanceMismatchError`. A payload that does not restate its origin
  passes, as does a payload that is not an object. A caller turns a mismatch
  into a `DataQualityIncidentOpened` event and a metric; this package performs
  no I/O.
- **The rule is enforced by the contract, not only by those helpers.**
  `eventEnvelopeSchema` and `pinnedEventEnvelopeSchema` attach
  `envelopeProvenanceRefinement` (`envelope.ts`), so every registered contract's
  envelope schema rejects a contradicting pair with an issue on `payload.venue`,
  and so does the canonical `DOMAIN_EVENT_REGISTRY.parseEnvelope` /
  `safeParseEnvelope` path built on it. A helper a caller must remember to
  invoke is not an invariant; a contract that cannot express the violating
  document is. `parseEnvelope` repeats the check for the same reason it repeats
  `assertSchemaVersion` — `EventContractLike` is structural, so a hand-assembled
  contract can carry an envelope schema that never applied the refinement.
  Tests pin all twelve mismatched combinations (three reference events × the
  four other §7.1 sources) through the registry, plus the matching pairs.

### 6.4 `TradingParametersChanged` addresses the whole versioned parameter set

§9.2 versions tick size, minimum size, `negRisk`, fee schedule, trading delay,
and open/close timestamps — not only tick size and minimum size. The event
therefore carries:

| Field | Purpose |
| --- | --- |
| `parametersVersion` (+ optional `previousParametersVersion`) | monotonic ordinal, for ordering and comparison (§6 invariant 9) |
| `parameterVersionRef` | opaque handle to the authoritative versioned parameter snapshot held by the catalog |
| `changedParameters` | non-empty array over the vocabulary below |
| `tickSize?`, `minimumOrderSize?` | optional convenience detail for the two values nearly every consumer needs without a catalog round trip |

`TradingParameterKindSchema` is exactly the union of two cited handoff lists,
with nothing invented and nothing dropped:

| Category | Source |
| --- | --- |
| `tick_size`, `minimum_order_size`, `fee_schedule`, `trading_delay`, `neg_risk`, `open_time`, `close_time` | §9.2 — the Universe Service stores "tick size, minimum size, `negRisk`, fee schedule, trading delay, open/close timestamps" and versions them on every change |
| `status` | §10.1 — `market_parameter_history` is "Tick, minimum size, delay, `negRisk`, fees, status" |

`status` is kept although §9.2 does not name it: §10.1 versions it in the
parameter-history table, and an event that could not name it would leave a
versioned column with no change notification. `open_time` / `close_time` are the
scheduled open/close *parameters*, which can be rescheduled; they are not
duplicates of `MarketOpened` / `MarketClosing`, which record that the transition
was actually observed.

The detailed snapshot deliberately belongs to the catalog layer. Encoding a fee
schedule or a `negRisk` shape in a frozen contract would freeze a volatile venue
fact (§1.2) before WP-000 has produced the evidence for it. Tick size and
minimum size are optional because a change to, say, the fee schedule alone need
not restate them, and a producer that cannot supply them must omit them rather
than guess; `parameterVersionRef` remains the authoritative source.

---

## 7. Boundary hygiene constraints

These bounds are not venue facts. They are boundary hygiene for a process that
parses untrusted frames, and they keep metric-label cardinality and database
column widths predictable:

| Constant | Value | Applies to |
| --- | --- | --- |
| `MAX_DECIMAL_STRING_LENGTH` | 1024 | any decimal string |
| `MAX_IDENTIFIER_LENGTH` | 200 | identifier-like strings |
| `MAX_CODE_LENGTH` | 64 | reason codes, tags, feed ids, series ids |
| `MAX_DETAIL_LENGTH` | 2000 | human-readable operational text |

Code strings additionally match `^[A-Za-z][A-Za-z0-9_.:-]*$` so they are safe as
a Prometheus label value (§14.3 labels metrics by reason code).

Contract objects are validated as **strict** objects: an unknown key is an
error, not something to strip. Silently dropping a field on the recording path
would violate §8.3, and a new field is a schema-version decision.

---

## 8. Refinements and inferred shapes

Recorded explicitly so review can challenge them. None of these contradicts the
handoff; each fills a gap the handoff leaves open.

| Item | Decision | Rationale |
| --- | --- | --- |
| `QuoteLevel` | `{ price: PriceString, shares: SharesString (non-negative) }` | §7.7 references the type without defining it |
| `BasketLeg` | `{ marketId, direction, targetShares, maximumBuyPrice?, minimumSellPrice? }` | §7.7 references the type without defining it |
| `marketId` in intents | validated as `InternalMarketId` (UUIDv7) | §7.2 makes `InternalMarketId` the canonical market identifier |
| `TokenId` | canonical unsigned integer string, no leading zeros | §7.2 says "venue integer encoded as string"; adapters normalize first, as they do for decimals |
| Internal ids without a §7.2 format (`StrategyRunId`, `DecisionId`, `IntentId`, `ExecutionPlanId`, `SubmissionAttemptId`) | bounded non-empty strings | §7.2 does not pin a format; inventing one would be a silent contract |
| UUIDs | lowercase only | one representation per identifier; all UUIDs here are generated in-process |
| Cost/limit caps (`maximumTotalCost`, `maximumInventory`, `maximumCombinedCost`, `legRiskLimit`, `minimumFillShares`) | non-negative | a negative magnitude cap is a bug, not a strategy |
| Event payload fields beyond §7.4's names | minimal identifier + versioned-parameter sets | §7.4 lists event types only; payload shapes are our design, informed by §9.1–§9.4 |
| `MarketOutcomeState` | the §9.3 required outcome states | reuses the specified vocabulary instead of inventing one |
| `MarketResolved.outcome` | the terminal subset only (`DISPUTED` excluded) | §6.2 — the event asserts a determined payoff |
| Feed gap/resync flags | `z.literal(true)`, not `z.boolean()` | §6.1 — the §7.1/§9.1 invariant is unconditional |
| `ReferenceVenue` | derived from the §7.1 `source` enum | §6.3 — a payload restatement must be comparable to the authority |
| `parameterVersionRef` | opaque bounded string, catalog-owned addressing | §6.4 — the snapshot shape is a volatile venue fact (§1.2) pending WP-000 |
| `changedParameters` | non-empty enum array over the §9.2 categories | §6.4 — names *what* changed without freezing fee/`negRisk` shapes |
| Incident `severity` | `LOG` / `NOTIFY` / `PAGE` | reuses the §14.4 alert vocabulary |
| Book events | no synthetic sequence number | §9.4 forbids inventing a venue sequence number; ordering comes from `gatewayEpoch + ingestSeq` |

---

## 9. Contract freeze

Once WP-020 is accepted, `packages/domain` and `packages/decimal` are protected
integration surfaces (workplan `protected_paths`, handoff §5.1).

- A change to any contract in these packages requires an **accepted ADR** under
  `docs/adr/` and orchestrator approval, and must state the schema-version
  consequence for recorded data.
- No package may modify a shared contract to make its own implementation easier
  (`AGENTS.md`, execution rules).
- Weakening a canonicalization rule, accepting `number` for an economic field,
  or relaxing the strict-boundary decision is a specification change, not an
  implementation detail.

Strictly additive work — registering a contract for a genuinely new event type,
adding a new optional field under a new schema version, adding tests — still
requires orchestrator approval and path ownership, but does not by itself
reopen an accepted ADR.
