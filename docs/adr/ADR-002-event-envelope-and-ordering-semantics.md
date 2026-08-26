# ADR-002: Event envelope and ordering semantics

- **Status:** Accepted
- **Date:** 2026-08-26
- **Recorded by:** `WP-030`
- **Implemented by:** `WP-020` (envelope, contracts, registry — done and frozen);
  `WP-060`, `WP-070`–`WP-100`, `WP-120` (producers); `WP-210` (replay)
- **Supersedes / Superseded by:** none

## Context

Handoff §7.1 specifies the event envelope; §8.1–§8.4 specify the ordering
semantics that ride on it; §1.3 makes "changing event ordering semantics" an
ADR-gated change. `WP-020` implemented the envelope and 22 event contracts and
asked for ratification of several derived decisions
(`docs/handoffs/WP-020.md` → `follow_up` 2 and 10; `IMPLEMENTATION_STATUS.md`
WP-020 completion record → "Items deferred to WP-030 ADRs").

The open questions this ADR settles:

1. Which envelope fields are required, given that §7.1 shows a TypeScript type
   whose optionality markers are the only statement of the matter.
2. How `schemaVersion` evolves, given that every contract rejects unknown keys.
3. Whether the top-level payload key `venue` is reserved, and what wins when a
   payload's provenance disagrees with the envelope's.
4. The `TradingParametersChanged` vocabulary, including `status`, `open_time`,
   and `close_time`.
5. Which `WP-000` fixture narrowings a **runtime** parser must not inherit.
6. What remains unverified about the venue's book-update semantics.

## Decision

### 1. The §7.1 envelope, as implemented, is the contract

Every normalized event carries the §7.1 envelope. Two field groups deserve
explicit statements:

- **`gatewayEpoch` and `ingestSeq` are REQUIRED.** §7.1 types both as
  non-optional and states "`gatewayEpoch + ingestSeq` defines the exact order
  consumed during one gateway epoch". An envelope missing either has no position
  in the total order and therefore cannot be replayed (§8.4). The contract
  rejects it rather than assigning a position later.
- **Bigint-like fields are canonical unsigned integer strings**
  (`ingestSeq`, `receivedMonotonicNs`, `rawRecordOffset`). JavaScript `number`
  cannot hold them exactly (ADR-001 §7).

`source` is the enumerated set `polymarket | binance | coinbase | rtds | internal`
(§7.1). `sourceChannel`, `connectionId`, `subscriptionGeneration`,
`rawSegmentId`, `rawRecordOffset`, `correlationId`, and `causationId` carry the
provenance chain that makes §6 invariant 4 ("every fill is traceable … back to
source event") checkable.

### 2. Ordering authority

1. **`(gatewayEpoch, ingestSeq)` is the ordering key.** `gatewayEpoch` is a UUID
   assigned at gateway startup; `ingestSeq` is monotonic within that epoch
   (§7.1). Nothing else defines dispatch order.
2. **Replay consumes the recorded dispatch order and must not sort by venue
   timestamp** (§8.4, §6 invariant 15). A venue timestamp is data, not an order.
   Replay must not use future venue timestamps that were unavailable to the live
   process.
3. **No invented venue sequence number.** Handoff §9.4 forbids it. Book events
   carry no synthetic sequence field. Ordering comes from
   `(gatewayEpoch, ingestSeq)`; venue-provided hashes and timestamps are
   validation aids, not ordering keys.
4. **A resubscription creates a new `subscriptionGeneration`; a restart or a
   detected gap requires a new authoritative snapshot before affected markets
   resume** (§7.1, §9.1). This is unconditional, so the contracts pin
   `FeedGapDetected.requiresAuthoritativeSnapshot` and
   `FeedResynchronized.authoritativeSnapshotApplied` to the literal `true`: a gap
   event cannot waive the obligation, and a resynchronization event cannot assert
   recovery it did not perform. A feed that reconnected but has not yet applied a
   snapshot is recorded as `FeedConnected` alongside the still-open gap and
   data-quality incident, not as a `FeedResynchronized`.
5. **Dropping a trading or raw market event silently is forbidden** (§8.3). A
   critical queue that cannot accept an event halts affected trading and opens a
   data-quality incident. A *rejected* envelope is therefore not a silent drop
   either: the validation failure must be routed to `DataQualityIncidentOpened`
   with the raw frame preserved (see Consequences).
6. **Strategy evaluation order is stable and recorded**: market ownership
   priority, then strategy instance priority, then strategy instance UUID (§8.2),
   recorded in the run manifest.

### 3. Strict objects, and version-per-emitted-field-set-change

**Every contract validates as a strict object: an unknown key is an error, not
something to strip.** Silently dropping a field on the recording path would
violate §8.3, and a new field is a schema-version decision rather than an
accident.

**Every change to the emitted field set increments `schemaVersion`.** There is no
"an additive optional field may reuse the current version" exemption. This is
forced by strict rejection:

- A consumer still running the previous build of v1 would **reject** a document a
  newer producer emitted as v1 with an extra key — the change breaks exactly the
  consumers it was supposed to be safe for.
- `(eventType, schemaVersion)` would stop identifying one historical schema. Two
  different field sets under one registry key make recorded data ambiguous on
  replay (§8.4, §12.5): given a v1 row you could not tell which v1 it is.

A new version is therefore required for all of: adding a field (optional or
required); removing or renaming a field; widening or narrowing a type, enum, or
constraint; making an optional field required or a required field optional; and
changing the meaning or unit of an existing field. Documentation, error wording,
and internal refactoring do not increment.

### 4. The `(eventType, schemaVersion)` registry

1. The pair is a **total, injective key** into the historical schemas: exactly
   one field set per key, and every key ever emitted stays resolvable.
2. **Old versions stay registered.** Replay validates a historical envelope
   against the schema it was recorded with (§8.4), so adding v2 never removes v1.
3. `schemaVersion` is validated at runtime as a **positive safe integer**, at
   both contract construction and registry insertion, against exactly the range
   the envelope routing schema accepts. Above `Number.MAX_SAFE_INTEGER` two
   "different" versions are not distinct values, so they would collide on one
   registry key.
4. Non-event contracts (`DecisionResult`, the five intent types) carry no version
   *field* — §7.5 and §7.7 specify exact field lists, and adding one would
   contradict the specification. Their versions are exported constants
   (`DOMAIN_CONTRACT_VERSIONS`); a component that persists one of these
   structures persists the matching version alongside it.

### 5. `venue` is a RESERVED top-level payload key

**The envelope `source` is the authoritative provenance.** It is what the gateway
assigns alongside `gatewayEpoch`, `ingestSeq`, and the connection metadata, and
what the raw-frame record ties back to (§7.1, §9.1). Nothing in a payload may
override it.

Reference-feed payloads nonetheless restate the origin as `venue`, because a
consumer may hold a payload without its envelope (a projection, a feature
snapshot, a persisted row). To keep the restatement from contradicting the
authority:

1. **`venue` is reserved, repository-wide, as a top-level payload key meaning
   "the origin restated from the envelope `source`".** No present or future
   payload may use that key with any other meaning. A payload needing a different
   venue-shaped concept must choose a different name (for example
   `settlementVenue`, `executionVenue`).
2. The reference-venue vocabulary is **derived from** the §7.1 `source`
   vocabulary, not mapped to it, so the two cannot drift.
3. **The rule is enforced by the contract, not by a helper a caller must
   remember.** The envelope schema itself rejects an envelope whose `source` and
   `payload.venue` disagree, and the registry's parse path re-checks it, because
   the contract type is structural and a hand-assembled contract could carry an
   envelope schema that never applied the refinement.
4. A payload that does not restate its origin is legal and unaffected.

This ratifies the note the `WP-020` round-3 review left for this ADR
(`IMPLEMENTATION_STATUS.md`, WP-020 completion record).

### 6. `TradingParametersChanged` vocabulary

The event addresses the whole versioned parameter set, not just tick and minimum
size. It carries:

| Field | Purpose |
| --- | --- |
| `parametersVersion` (+ optional `previousParametersVersion`) | monotonic ordinal for ordering and comparison (§6 invariant 9) |
| `parameterVersionRef` | opaque handle to the authoritative versioned snapshot held by the catalog |
| `changedParameters` | non-empty array over the vocabulary below |
| `tickSize?`, `minimumOrderSize?` | optional convenience detail for the two values nearly every consumer needs without a catalog round trip |

**The vocabulary is exactly the union of two cited handoff lists, with nothing
invented and nothing dropped:**

| Member | Citation |
| --- | --- |
| `tick_size`, `minimum_order_size`, `fee_schedule`, `trading_delay`, `neg_risk`, `open_time`, `close_time` | §9.2 — the Universe Service stores "tick size, minimum size, `negRisk`, fee schedule, trading delay, open/close timestamps" and versions them on every change |
| `status` | §10.1 — `market_parameter_history` is "Tick, minimum size, delay, `negRisk`, fees, status" |

**`status` is ratified** although §9.2's prose omits it: §10.1 versions it in the
parameter-history table, and an event that could not name it would leave a
versioned column with no change notification.

**`open_time` / `close_time` are ratified as parameters, not duplicates.** They
are the *scheduled* open and close, which can be rescheduled. `MarketOpened` and
`MarketClosing` record that a transition was actually observed. A rescheduling
with no observed transition must be expressible, and a transition must not be
implied by a schedule change.

**The detailed snapshot stays in the catalog layer.** Encoding a fee-schedule or
`negRisk` shape into a frozen contract would freeze a volatile venue fact
(§1.2). The venue publishes these as per-market fields that must be read rather
than assumed — tick size is dynamic and "must always be read from the market",
minimum order size is `market.trading.minimumOrderSize`, the trading delay is
`market.trading.secondsDelay`, and negative risk is `market.state.negRisk` with
event-level augmentation (venue report §7). Tick-size changes are additionally
pushed on the market channel as `tick_size_change` with `old_tick_size` /
`new_tick_size` (venue report §3). `tickSize` and `minimumOrderSize` are optional
on the event because a change to, say, the fee schedule alone need not restate
them, and a producer that cannot supply them must omit them rather than guess.

### 7. Fixture-only narrowings must not be inherited by runtime parsers

`WP-000` froze a documentation-derived fixture catalog whose validators are
deliberately **stricter** than the official SDK in several places. That
strictness is correct for a frozen snapshot, where an undocumented value would be
an invention. It is **wrong for a runtime parser**, which would reject valid
venue traffic. This ADR makes the boundary explicit and binding:

| Narrowing in the `WP-000` fixture catalog | Runtime rule |
| --- | --- |
| SDK `.nullish()` fields rejected when `null` — e.g. `MarketBookEventSchema.hash`, `timestamp`, `neg_risk`, and every `OptionalDecimalStringSchema` field (venue report §17) | A runtime parser and `packages/domain` **must accept `null`** wherever the SDK declares `.nullish()`, and map it to absent. |
| `conditionId` narrowed to 31/32 bytes, while the SDK's `ConditionIdResponseSchema` "validates hex syntax without constraining the condition ID byte length" (venue report §7.1) | A runtime parser **must accept any hex condition id the SDK accepts**. Rejecting a valid one at runtime drops real venue data rather than failing a fixture test. |
| Reward decimals modeled only at the SDK-parsed layer (venue report §7.1) | An adapter **must accept both** the raw JSON-number form and the decimal-string form and normalize to canonical decimal (ADR-001 §8.2). |
| `clobRewards`, `rewardsMinSize`, `rewardsMaxSpread` required and non-null, `clobRewards[].endDate` key-required, while the SDK marks all four `.nullish()` (venue report §7, §7.1) | A runtime model **must treat all four as optional**; a real market may omit the whole rewards block. |

Two non-narrowings, recorded so they are not "relaxed" by mistake:

- `transactionsHashes` and `tradeIDs` on an order response are
  `z.array(...).default([])` in the SDK: the key may be absent and the default
  `[]` is substituted, but an explicit `null` genuinely **fails** to parse (venue
  report §2.2, §17). Accepting `null` there would be a defect, not a relaxation.
- RTDS `filters` has exactly two documented forms — omitted, or the exact compact
  JSON string. `null` is not among them (venue report §10.3, §17).

The general rule: **absence and `null` are different facts, and this repository
does not conflate them** (venue report §17). A contract that accepts `null` where
no source documents one is inventing venue behavior, which `AGENTS.md` forbids;
a contract that rejects `null` where the SDK declares `.nullish()` drops real
data.

### 8. Book-update semantics remain provisional (UNVERIFIED)

Handoff §23 states that public market data includes "absolute price-level
changes", and §9.4 requires the local book to "apply snapshots and absolute-size
price changes exactly as documented by the venue".

**The venue documentation does not currently state this.** The market-channel
page defines `price_change.size` as a `DecimalString` without stating
absolute-versus-delta semantics or that `size: "0"` removes a level (venue report
§3, conflict **C-1** in §11, unverified item **U-1** in §12).

Decision:

1. The handoff's architectural assumption is retained **provisionally**, per
   handoff §1.1's conflict procedure, and is marked UNVERIFIED wherever it
   appears.
2. `BookLevelChanged` payload semantics are documented as "absolute size at the
   level, where `"0"` removes the level" **with that unverified status attached**.
3. **`WP-070` must confirm the semantics** against the official SDK's
   book-maintenance code and/or live observation *before* `WP-150` treats it as
   truth. Until then no code may claim the semantics are verified, and the
   simulator inherits the same uncertainty (ADR-012).
4. If confirmation shows delta semantics instead, the fix is a new
   `schemaVersion` for the affected book contracts under §3 of this ADR — not a
   reinterpretation of recorded v1 data.

### 9. Where the terminal-outcome ruling lives

`MarketResolved` carries a **terminal outcome only** (`YES_WIN`, `NO_WIN`,
`SPLIT_50_50`, `CANCELLED`), while the full §9.3 vocabulary remains the type for
market *state*. The ruling that `DISPUTED` is non-terminal, and the follow-up
about the absent dedicated dispute event, are owned by
[ADR-009](./ADR-009-settlement-spec-and-payoff-model-selection.md).

## Consequences

- **A gateway that starts emitting an extra field fails validation** until a new
  schema version is registered. That is the intended trade for never silently
  stripping recorded data, but it makes producer/consumer upgrade ordering a real
  deployment concern. A schema-migration runbook (dual-publish or upgrade
  ordering, and how long both versions stay registered) is still owed by the
  gateway/storage packages.
- **Rejected envelopes need routing, not swallowing.** Because provenance and
  strictness are enforced *in the contract*, a mislabeled or malformed frame now
  fails to parse. The gateway work package must catch the typed failure, emit
  `DataQualityIncidentOpened`, increment a metric, and preserve the raw frame. A
  rejected envelope that becomes a silent drop violates §8.3.
- **Reserving `venue` costs a name.** Any future payload needing a different
  venue-shaped concept must pick another key. That is cheap; a key whose meaning
  depends on the event type is not.
- **`parameterVersionRef` is an unresolved seam** until the catalog layer exists
  (`WP-110`, `WP-040`). No consumer can dereference it yet. This is deliberate —
  the alternative was freezing a fee-schedule shape before venue evidence
  existed.
- **The book contract is not yet trustworthy for order-book reconstruction.**
  Until `WP-070` resolves C-1/U-1, any component that reconstructs depth is
  building on a provisional reading of the venue.
- **The ordering key is gateway-assigned, so gateway identity matters.** Two
  gateways publishing into one stream must use distinct `gatewayEpoch` values and
  a consumer must not interleave epochs as though they were one sequence.

## Evidence

**Primary specification** (`docs/spec/polymarket-bot-orchestrator-handoff.md`):

- §1.2 — venue facts are volatile; per-market trading parameters are re-verified
  each phase.
- §1.3 — changing event ordering semantics requires an ADR.
- §6 invariant 4 — every fill is traceable back to the source event.
- §6 invariant 9 — market rules, settlement specs, fee schedules, tick sizes,
  minimum sizes, and delays are versioned; historical runs use historical
  parameters.
- §6 invariant 15 — replay follows information arrival order and must not use
  future venue timestamps.
- §7.1 — the envelope; `gatewayEpoch + ingestSeq` defines the exact order;
  resubscription creates a new `subscriptionGeneration`; a restart or detected gap
  requires a new authoritative snapshot.
- §7.4 — the 22 minimum event types, including `TradingParametersChanged`.
- §7.5, §7.7 — `DecisionResult` and the intent types specify exact field lists
  with no version field.
- §8.1–§8.4 — the deterministic core loop, stable strategy order, bounded queues
  and the prohibition on silent drops, and replay dispatch order.
- §9.1 — gateway responsibilities: assign `gatewayEpoch`, `ingestSeq`, receipt
  timestamps, connection metadata; resubscribe and obtain authoritative snapshots
  after gaps.
- §9.2 — the Universe Service stores and versions tick size, minimum size,
  `negRisk`, fee schedule, trading delay, and open/close timestamps.
- §9.4 — apply snapshots and absolute-size price changes exactly as documented by
  the venue; the implementation must not invent a venue sequence number.
- §10.1 — `market_parameter_history` covers "Tick, minimum size, delay,
  `negRisk`, fees, status".
- §12.5 — dataset manifests pin normalizer and feature-set versions.
- §23 — handoff-time venue notes, explicitly flagged there as requiring
  reverification.

**Venue facts** (`docs/venue/verified-2026-08-24.md`, verified 2026-08-24;
snapshot, re-verify each phase per handoff §1.2):

- §3 — market-channel event set (`book`, `price_change`, `tick_size_change`,
  `last_trade_price`, enhanced `best_bid_ask`, `new_market`, `market_resolved`);
  `PING`/`PONG` application heartbeat every 10 s; **`price_change.size`
  absolute-versus-delta semantics are NOT stated by the docs**.
- §4 — user-channel raw wire schemas; optional decimals serialize as `""`;
  `outcome_index`/`bucket_index` are integers; `timestamp`/`match_time` etc. are
  digit strings; `NewMarketEventSchema` and `MarketResolvedEventSchema` are
  distinct discriminated shapes.
- §7 — per-market parameters: dynamic tick size, `minimumOrderSize`,
  `secondsDelay`, `negRisk`, reward settings.
- §7.1 — the three published reward layers and `DecimalishSchema`; the
  `conditionId` byte-length narrowing recorded as deliberate.
- §11 conflict **C-1** — `price_change` size semantics: documentation gap;
  handoff assumption retained provisionally; `WP-070` must confirm.
- §12 unverified **U-1** — same item, listed as unverified with what was checked.
- §12 unverified **U-2**, **U-3** — server-side timeout on missed `PING`s, and
  maximum `assets_ids` per subscription, are both undocumented. Neither is
  assumed here; subscription planning (`WP-070`, `WP-120`) must treat both as
  unknown.
- §17 — optionality versus nullability: the three source modifiers
  (`.default([])`, `.nullish()`, `.nullable()`), the complete documented-nullable
  list, and the explicit statement that the fixture narrowings are "NOT
  appropriate for a runtime parser".

**Implementation and prior handoffs:**

- `docs/contracts/domain.md` §5.1–§5.3 (versioning and registry), §6.1 (gap/resync
  literals), §6.3 (provenance authority and contract-level enforcement), §6.4
  (`TradingParametersChanged` with the per-category citation table), §7 (strict
  objects and boundary hygiene), §8 (inferred shapes).
- `docs/handoffs/WP-020.md` — Review round 1 HIGH-2/HIGH-3/MEDIUM-1/MEDIUM-4,
  Review round 2 MEDIUM-1/MEDIUM-2/MEDIUM-3, `known_risks` 2 and 11–12, and
  `follow_up` 2, 8, 9, 10.
- `docs/handoffs/WP-000.md` — `known_risks` entries recording that the fixture
  `null` narrowing and the `conditionId` narrowing "must NOT be inherited" by a
  runtime parser, and the matching `follow_up` items for `WP-020`/`WP-070`/
  `WP-280`.
- `IMPLEMENTATION_STATUS.md` — WP-020 completion record: "NOTE — WP-030 ADR
  should reserve top-level payload key `venue` for provenance", and the
  deferred-ADR list.

**Safety:** this ADR changes no run-mode default (ADR-010).
