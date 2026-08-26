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
| `canonical.ts` | Canonical decimal-string grammar, strict validation, lenient normalization, digit accessors |
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
| No scientific notation | `"1e5"`, `"1E5"`, `"1e-5"` are rejected everywhere |
| No leading `+` | `"+1"` is rejected |
| Canonical zero is `"0"` | `"-0"`, `"0.0"`, `"00"`, `"-0.00"` are rejected; all normalize to `"0"` |
| No trailing decimal point | `"1."` is rejected |
| Normalize redundant zeros before hashing | `"01.50"` is rejected; it normalizes to `"1.5"` and hashes as `"1.5"` |
| Price in `[0, 1]` where context requires | `PriceStringSchema` / `ProbabilityStringSchema` enforce the unit interval |
| Tick conformance by exact modulo | `isTickConformant` scales to integers and takes an integer modulo |

Additional non-canonical spellings that are also rejected at the boundary:
`".5"`, `""`, `"NaN"`, `"Infinity"`, `" 1"`, `"1 "`, `"1,5"`, `"1.2.3"`,
`"0x1f"`, and every non-string value including `number` and `bigint`.

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
value → normalizeDecimalString(value) → "polymarket-bot/decimal/v1:" + canonical → SHA-256 → lowercase hex
```

- Deterministic: the same value always produces the same digest.
- Representation-independent: `"1.5"`, `"1.50"`, `"01.5"`, `"+1.5"` share one
  digest; `"0"`, `"-0"`, `"0.000"`, `"+0"` share one digest.
- Domain-separated: the constant prefix prevents a decimal digest from
  colliding with a digest computed over some other payload that happens to
  serialize to the same characters. Changing the prefix (including its `v1`
  segment) changes every persisted digest and therefore requires an ADR.

`canonicalDecimalPreimage` exposes the exact bytes that are hashed so a digest
can be reproduced by hand (`printf 'polymarket-bot/decimal/v1:1.5' | sha256sum`).

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
must fail validation.

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

Increment when a change is not backward compatible for an existing consumer or
for already-recorded data:

- removing or renaming a field;
- narrowing a type, an enum, or a constraint;
- making an optional field required;
- changing the meaning or the unit of an existing field.

Adding a new **optional** field with no meaning change may reuse the current
version.

### 5.3 Registry usage

```ts
import { DOMAIN_EVENT_REGISTRY } from "@polymarket-bot/domain";

const envelope = DOMAIN_EVENT_REGISTRY.parseEnvelope(frame); // throws typed errors
const result = DOMAIN_EVENT_REGISTRY.safeParseEnvelope(frame); // non-throwing
```

- `lookup` / `require` / `has` resolve `(eventType, schemaVersion)`.
- `versionsOf` / `latestVersionOf` expose the registered versions of a type.
- `parseEnvelope` routes on the envelope's own `eventType` and `schemaVersion`,
  then validates against that contract's pinned envelope schema. An unregistered
  pair raises `UnknownEventContractError`; a schema failure raises
  `EventValidationError` with the formatted issue list.
- `parsePayload` validates a payload independently of an envelope.

**Old versions stay registered.** Replay consumes historical envelopes in
recorded order (§8.4) and must validate them against the schema they were
recorded with, so adding version 2 of an event never removes version 1.
`createEventSchemaRegistry` refuses duplicate `(eventType, schemaVersion)`
registrations.

---

## 6. Boundary hygiene constraints

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

## 7. Refinements and inferred shapes

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
| Incident `severity` | `LOG` / `NOTIFY` / `PAGE` | reuses the §14.4 alert vocabulary |
| Book events | no synthetic sequence number | §9.4 forbids inventing a venue sequence number; ordering comes from `gatewayEpoch + ingestSeq` |

---

## 8. Contract freeze

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
