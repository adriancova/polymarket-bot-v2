---
title: Polymarket Crypto Trading Platform — Orchestrator Implementation Handoff
version: 2.0.0
status: Implementation baseline
date: 2026-08-18
audience: Orchestrator agent and coding subagents
supersedes: polymarket-bot-design.md Draft v1
primary_language: TypeScript
maximum_default_run_mode: PAPER
---

# Polymarket Crypto Trading Platform — Orchestrator Implementation Handoff

## 0. Executive directive

Build a reliable, event-driven trading platform for Polymarket crypto prediction markets. The platform must support independently configurable strategies, deterministic replay, live-data paper trading, execution calibration, tightly capped live-micro trading, complete auditability, and later expansion into momentum, hold-to-resolution, scalp, market-making, and coordinated-arbitrage strategies.

This is an **implementation handoff**, not an invitation to improvise a different architecture. The orchestrator owns integration quality and may delegate work, but it must preserve the contracts, invariants, phase gates, and safety controls in this document.

The implementation must begin in **paper-only mode**. Real order submission remains disabled until the live-micro gate is intentionally unlocked after human review and venue verification.

### 0.1 First deliverable

The first useful production deployment is not a trading bot. It is an always-on **Market Data Gateway and Recorder** that:

1. Discovers and tracks the selected rolling crypto-market series.
2. Records Polymarket public market data plus external reference feeds without silent gaps.
3. Publishes normalized events to the trading process.
4. Produces replayable, checksummed datasets.
5. Detects feed stalls and reconstruction errors.

The first complete trading deliverable is a **paper-trading Static Bracket strategy** running through the same strategy, risk, execution-planning, OMS, ledger, and PnL paths later used for real orders.

### 0.2 Non-negotiable safety boundary

The repository must ship with all of the following defaults:

```text
MAX_RUN_MODE=PAPER
ALLOW_REAL_ORDERS=false
LIVE_MICRO_MAX_ORDER_NOTIONAL=0
LIVE_MICRO_MAX_ACCOUNT_EXPOSURE=0
```

A production signer must never be required to run tests, backtests, the recorder, paper trading, or the control plane. A real signer is mounted only into the live execution process after the live-micro gate is approved.

The software must not bypass geographic restrictions, platform controls, sanctions controls, or account eligibility checks. Before any real order, the live adapter must perform the venue's current geographic-eligibility check and fail closed on ambiguity.

---

## 1. Authority and change control

### 1.1 Source precedence

When sources conflict, use this order:

1. Current official Polymarket API documentation and current official SDK behavior for venue facts.
2. This implementation handoff for product architecture and system invariants.
3. Accepted Architecture Decision Records in `docs/adr/`.
4. Versioned domain contracts in `packages/domain` and database migrations.
5. Executable tests and fixtures.
6. The original product design document for rationale and historical context.

No subagent may silently resolve a conflict. It must report the conflict to the orchestrator, cite the evidence, and either update an ADR or stop the affected work package.

### 1.2 Venue facts are volatile

At the start of each implementation phase, a verification subagent must re-check, against official sources:

- The supported unified SDK and minimum runtime version.
- Order request and response schemas.
- Order types and expiration rules.
- Market and user WebSocket schemas.
- Heartbeat behavior.
- Fee and reward parameters.
- Per-market trading parameters.
- IP and per-signer rate limits.
- Matching-engine restricted modes.
- Geographic restrictions.
- Position split, merge, and redemption workflows.
- Chainlink/RTDS symbols, windows, and stream behavior.

The verified findings are committed to `docs/venue/verified-YYYY-MM-DD.md`, with sanitized contract fixtures under `test/fixtures/venue/`.

### 1.3 Architecture changes

The following require an ADR and orchestrator approval:

- Changing the production language.
- Replacing the official Polymarket SDK with hand-written signing or an unofficial SDK.
- Changing event ordering semantics.
- Changing numeric representation.
- Allowing a strategy to perform I/O or submit orders directly.
- Changing the ledger source of truth.
- Allowing more than one active live strategy owner per market.
- Changing the live-enablement mechanism.
- Adding a hot standby capable of order submission.
- Removing any reconciliation, heartbeat, geoblock, or kill-switch control.

---

## 2. Locked architecture decisions

| Area | Decision |
|---|---|
| Production/replay language | TypeScript on Node.js 24 or newer, pinned in the repository |
| Research language | Python for statistics, notebooks, calibration, and Parquet analysis; never a second strategy implementation |
| Package manager | `pnpm` workspace with an exact lockfile |
| Polymarket integration | Official unified `@polymarket/client`; archived CLOB clients are forbidden |
| Process shape | Modular-monolith trading process plus independent Market Data Gateway/Recorder |
| Active trader | Exactly one fenced live order writer per account/signer |
| Public market-data transport | Bounded Redis Streams transport in v1, behind a transport interface |
| Operational database | PostgreSQL; no raw high-frequency archive dependency on PostgreSQL |
| Raw archive | Append-only local WAL, compacted into checksummed Parquet in object storage |
| Research query | DuckDB/Polars over Parquet |
| Hot coordination | Redis for streams, kill-switch state, health leases, and fencing—not for monetary truth |
| Numeric representation | Canonical decimal strings at boundaries; exact decimal arithmetic internally; no JavaScript `number` for prices, sizes, fees, balances, or PnL |
| Strategy contract | Deterministic, synchronous, side-effect-free strategies return `DecisionResult` objects containing zero or more intents |
| Execution boundary | Strategies emit intents; risk, allocation, execution planning, OMS, and venue adapters own orders |
| Environments | `BACKTEST`, `PAPER`, `SHADOW`, `EXECUTION_PROBE`, `LIVE_MICRO`, `LIVE` |
| Initial market ownership | One active live strategy owner per market; no cross-strategy account netting in v1 |
| Accounting | Append-only event ledger; actual wallet state separated from virtual strategy attribution |
| Simulation | Same strategy and core engine code; only clock, event source, and execution venue are swapped |
| Fail-safe | Halt entries, cancel orders, reconcile, then manage known positions; never blindly flatten on unknown state |
| High availability | Supervisor restart and independent cancel utility; no order-submitting hot standby in v1 |
| UI | Operational API and Grafana first; no custom polished frontend required for v1 |

### 2.1 Recommended libraries

The exact versions must be pinned after the venue verification spike.

```text
Runtime and validation:
  TypeScript strict mode
  zod
  decimal.js (or an ADR-approved exact-decimal equivalent)

Database:
  pg
  Kysely or another SQL-first typed query layer

Testing:
  Vitest
  fast-check
  Testcontainers

Operations:
  pino
  OpenTelemetry
  prom-client
  ioredis

Wallet and venue:
  @polymarket/client
  viem where required by the official SDK
```

Do not add a framework merely because a subagent prefers it. Every dependency in the live trading process must have a concrete purpose.

---

## 3. Scope and non-goals

### 3.1 In scope

- Rolling crypto market discovery and lifecycle tracking.
- Polymarket public market WebSocket ingestion.
- Polymarket authenticated order/trade updates.
- Binance and Coinbase reference streams.
- Chainlink TWAP through Polymarket RTDS, where relevant.
- Raw frame recording and replay datasets.
- Local Level 2 books and market features.
- Strategy plug-ins and immutable strategy configurations.
- Capital allocation and risk gates.
- Execution planning, OMS, partial fills, retries, cancellations, and reconciliation.
- Collateral and outcome-token inventory tracking.
- Split, merge, and redeem operations.
- Fee, reward, settlement, ledger, position, and PnL accounting.
- Backtest, paper, shadow, execution-probe, live-micro, and live modes.
- Static Bracket as the first end-to-end strategy.
- Observability, control API, kill switches, and independent emergency cancellation.

### 3.2 Explicitly out of scope for the first production release

- Colocated or microsecond HFT.
- Multi-account or multi-signer throughput scaling.
- Cross-account capital allocation.
- Multi-strategy netting within one market.
- Autonomous strategy generation or self-modifying code.
- Automatic parameter promotion based only on backtest results.
- Full custom web UI.
- Options-implied-volatility integration.
- Market making at meaningful size.
- Multi-leg arbitrage that assumes atomic execution.
- Autonomous funding, bridging, deposits, or withdrawals.
- Bypassing geographic, regulatory, platform, or account restrictions.

---

## 4. System architecture

```mermaid
flowchart TD
    PMW[Polymarket Market WS] --> GW
    GAMMA[Gamma / Market Metadata] --> GW
    BIN[Binance WS] --> GW
    CB[Coinbase WS] --> GW
    RTDS[Polymarket RTDS / Chainlink TWAP] --> GW

    subgraph GATEWAY[Market Data Gateway / Recorder]
      GW[Feed adapters and normalization]
      RAWQ[Bounded raw-frame queue]
      WAL[Append-only WAL]
      PUB[Redis Streams publisher]
      COMPACT[WAL compactor]
      GW --> RAWQ --> WAL
      GW --> PUB
      WAL --> COMPACT
    end

    COMPACT --> PARQUET[Parquet / Object Storage]
    PUB --> CORE

    subgraph CORE[Single Active Trading Process]
      BOOK[Local books]
      UNIVERSE[Universe + Settlement Specs]
      FEATURES[Feature engine]
      STRATEGIES[Strategy runtime]
      ALLOC[Capital allocator]
      RISK[Scenario risk]
      PLAN[Execution planner]
      OMS[OMS]
      INV[Collateral and inventory manager]
      VENUE[Execution venue adapter]
      USER[Authenticated user stream]
      RECON[Reconciler]
      LEDGER[Actual ledger + virtual allocations]
      PNL[PnL and analytics projections]

      CORE --> BOOK
      CORE --> UNIVERSE
      BOOK --> FEATURES
      UNIVERSE --> FEATURES
      FEATURES --> STRATEGIES
      STRATEGIES --> ALLOC --> RISK --> PLAN --> OMS
      INV <--> OMS
      OMS --> VENUE
      USER --> OMS
      USER --> RECON
      RECON --> LEDGER
      OMS --> LEDGER
      INV --> LEDGER
      LEDGER --> PNL
    end

    VENUE --> CLOB[Polymarket CLOB]
    CLOB --> USER

    PARQUET --> REPLAY[Replay source]
    REPLAY --> SIM[Simulated venue]
    SIM --> CORE

    CONTROL[Control API / Kill Switch] --> CORE
    CORE --> PG[(PostgreSQL)]
    CONTROL --> PG
    CORE --> METRICS[Prometheus / OTel / Grafana]
```

### 4.1 Process topology

V1 consists of these deployable processes:

```text
apps/data-gateway
  Owns public market/reference subscriptions.
  Records raw frames.
  Publishes normalized events.
  Continues running across trader deploys.

apps/trader
  Owns the live deterministic event loop.
  Runs books, features, strategies, risk, OMS, user stream,
  heartbeat, reconciliation, ledger projections, and live execution.

apps/control-api
  Owns authenticated operational controls and read APIs.
  Never has the signing key.

apps/research-worker
  Compacts WAL segments, creates Parquet manifests,
  computes offline metrics, and runs Python research jobs.

apps/cli
  Venue verification, replay, reconciliation, dataset validation,
  independent cancel-all, and operational repair commands.
```

### 4.2 Failure boundaries

- A trader deployment must not interrupt public data recording.
- A Parquet or object-storage outage must not immediately stop recording; WAL continues until a configured hard capacity threshold.
- A Redis outage stops publication and therefore halts trading, but the recorder continues writing WAL.
- A PostgreSQL outage stops new trading decisions and order submission. Heartbeats stop, causing venue-side cancellation of open orders.
- A control-API outage must not stop an already healthy trader, but the independent cancel CLI must remain usable.
- A trader crash must stop the order heartbeat and must not leave an order-submitting standby active.

---

## 5. Repository layout and ownership

```text
/
├── apps/
│   ├── data-gateway/
│   ├── trader/
│   ├── control-api/
│   ├── research-worker/
│   ├── backtest-cli/
│   └── ops-cli/
├── packages/
│   ├── domain/
│   ├── config/
│   ├── decimal/
│   ├── event-bus/
│   ├── storage-postgres/
│   ├── storage-wal/
│   ├── storage-parquet/
│   ├── polymarket-public/
│   ├── polymarket-secure/
│   ├── binance-adapter/
│   ├── coinbase-adapter/
│   ├── universe/
│   ├── settlement/
│   ├── order-book/
│   ├── features/
│   ├── strategy-sdk/
│   ├── strategy-runtime/
│   ├── capital-allocator/
│   ├── risk/
│   ├── execution-planner/
│   ├── oms/
│   ├── inventory/
│   ├── ledger/
│   ├── pnl/
│   ├── simulation/
│   ├── observability/
│   ├── testkit/
│   └── strategies/
│       └── static-bracket/
├── python/
│   ├── pyproject.toml
│   ├── research/
│   ├── calibration/
│   └── reports/
├── db/
│   ├── migrations/
│   └── seeds/
├── infra/
│   ├── compose/
│   ├── grafana/
│   ├── prometheus/
│   └── otel/
├── docs/
│   ├── adr/
│   ├── contracts/
│   ├── runbooks/
│   ├── venue/
│   └── experiments/
├── test/
│   ├── fixtures/
│   ├── replay-golden/
│   ├── integration/
│   ├── fault-injection/
│   └── e2e/
├── pnpm-workspace.yaml
├── package.json
├── tsconfig.base.json
├── docker-compose.yml
├── AGENTS.md
└── IMPLEMENTATION_STATUS.md
```

### 5.1 Path ownership rule

Each work package declares allowed paths. A subagent must not modify another package's owned path without orchestrator approval. Shared contracts in `packages/domain`, database migrations, and root configuration are protected integration surfaces.

### 5.2 Dependency direction

Allowed dependency direction:

```text
adapters / infrastructure
        ↓
application modules
        ↓
domain contracts and decimal types
```

Forbidden:

```text
packages/domain importing adapters, PostgreSQL, Redis, SDKs, or process globals
strategies importing venue clients, Redis, PostgreSQL, or filesystem APIs
ledger importing strategy implementations
simulation importing a live signer
```

Circular package dependencies fail CI.

---

## 6. Core invariants

These are enforced through tests and, where possible, database constraints.

1. **No binary floating point for economics.** Prices, sizes, balances, fees, and PnL are decimal strings at boundaries and exact decimals internally.
2. **Strategies have no side effects.** No network, database, filesystem, environment, global clock, or unseeded randomness access.
3. **Every strategy callback produces exactly one persisted `DecisionResult`.** The runtime, not strategy code, guarantees this.
4. **Every fill is traceable:** `fill → order → submission attempt → execution plan → intent → decision → feature snapshot → source event`.
5. **Order state and settlement state are separate.** A match is not the same as confirmed on-chain settlement.
6. **Unknown submission state is never treated as rejection.** Reconcile using the persisted signed order/order hash before any retry with a new salt.
7. **Actual account state and virtual strategy attribution are separate.** Unexplained activity goes to `UNATTRIBUTED` and halts the affected market.
8. **Positions, balances, and PnL projections are rebuildable from append-only events.** Mutable projections are not the monetary source of truth.
9. **Market rules, settlement specs, fee schedules, tick sizes, minimum sizes, and delays are versioned.** Historical runs use historical parameters.
10. **Partial fills are first-class.** Exit quantity is based on confirmed actual allocation, never requested entry size.
11. **One active live strategy owns a market in v1.** Other strategies may observe or run in shadow mode.
12. **No blind flatten.** Unknown position or book state causes cancel and reconciliation before any protected reduction action.
13. **Safety cancellation outranks new order placement.** Rate-limit scheduling reflects this priority.
14. **Core strategy PnL excludes discretionary rewards.** Realized rebates/rewards are reported separately and may be added to all-in PnL.
15. **Replay follows information arrival order.** It must not use future venue timestamps unavailable to the live process.
16. **Live order authority is fenced.** Only the holder of the current account fencing token may submit or refresh heartbeats.
17. **A real key cannot be loaded by paper or backtest processes.** Startup validation rejects this configuration.
18. **Venue eligibility is checked before real trading.** A blocked, close-only, failed, or ambiguous result prevents new live entries.

---

## 7. Domain contracts

All contracts live in `packages/domain`, use Zod schemas, expose inferred TypeScript types, and include an explicit `schemaVersion`.

### 7.1 Event envelope

```ts
export type EventEnvelope<TPayload> = {
  eventId: string;                 // UUIDv7
  eventType: string;
  schemaVersion: number;
  source: "polymarket" | "binance" | "coinbase" | "rtds" | "internal";
  sourceChannel: string;

  venueTimestamp?: string;         // ISO-8601 when supplied by source
  receivedAt: string;              // wall-clock ISO-8601
  receivedMonotonicNs: string;     // bigint serialized as string

  gatewayEpoch: string;            // UUID assigned at gateway startup
  ingestSeq: string;               // monotonic bigint within epoch
  connectionId?: string;
  subscriptionGeneration?: number;

  rawSegmentId?: string;
  rawRecordOffset?: string;
  correlationId?: string;
  causationId?: string;

  payload: TPayload;
};
```

`gatewayEpoch + ingestSeq` defines the exact order consumed during one gateway epoch. A resubscription creates a new `subscriptionGeneration`. A restart or detected gap requires a new authoritative snapshot before affected markets resume.

### 7.2 Canonical identifiers

```ts
type InternalMarketId = string;     // UUIDv7
type ConditionId = string;          // venue string
type TokenId = string;               // venue integer encoded as string
type VenueOrderId = string;         // order hash/string
type VenueTradeId = string;
type StrategyRunId = string;
type DecisionId = string;
type IntentId = string;
type ExecutionPlanId = string;
type SubmissionAttemptId = string;
```


### 7.3 Exact decimal types

At API and persistence boundaries:

```ts
type DecimalString = string;
type PriceString = DecimalString;
type SharesString = DecimalString;
type MoneyString = DecimalString;
type ProbabilityString = DecimalString;
```

Validation rules:

- No scientific notation.
- No leading `+`.
- Canonical zero is `"0"`.
- No trailing decimal point.
- Normalize redundant leading/trailing zeros before hashing.
- Price must be in `[0, 1]` where context requires.
- Tick conformance is checked with exact modulo arithmetic.

No domain schema accepts `number` for an economic field.

### 7.4 Normalized market events

Minimum event types:

```text
MarketDiscovered
MarketMetadataChanged
MarketRulesChanged
MarketOpened
MarketClosing
MarketResolved
MarketClarificationObserved
TradingParametersChanged

BookSnapshot
BookLevelChanged
BestBidAskChanged
PublicTradeObserved

ReferenceTradeObserved
ReferenceTopOfBookChanged
ReferenceTwapObserved

FeedConnected
FeedDisconnected
FeedStale
FeedGapDetected
FeedResynchronized
DataQualityIncidentOpened
DataQualityIncidentClosed
```

### 7.5 Strategy callback result

A strategy does not call a logger. Each callback returns one result:

```ts
export type DecisionResult = {
  decisionType: "enter" | "exit" | "quote" | "hold" | "skip" | "cancel" | "reduce";
  reasonCodes: string[];
  featureSnapshotRef: string;
  modelOutputs?: Record<string, DecimalString | string | boolean | null>;
  statePatch?: Record<string, unknown>;
  intents: Intent[];
  nextWakeupAt?: string;
};
```

The runtime adds timing, run, market, event, and strategy identifiers and persists exactly one decision record after the callback returns.

### 7.6 Strategy context

```ts
export interface StrategyContext {
  now(): string;
  market(): Readonly<MarketView>;
  book(outcome: "YES" | "NO"): Readonly<OrderBookView>;
  features(): Readonly<FeatureSnapshot>;
  position(): Readonly<VirtualPositionView>;
  orders(): readonly StrategyOrderView[];
  riskBudget(): Readonly<RiskBudgetView>;
  params<T>(): Readonly<T>;
  state<T>(): Readonly<T>;
  rng(): SeededRandom;
}
```

No context method performs network or database I/O. The runtime constructs the context from current in-memory state.

### 7.7 Intent types

#### Position intent

```ts
export type PositionIntent = {
  type: "POSITION";
  intentId: string;
  marketId: string;
  direction: "YES" | "NO";
  targetMode: "DELTA" | "ABSOLUTE";
  targetShares: SharesString;

  maximumBuyPrice?: PriceString;
  minimumSellPrice?: PriceString;
  maximumTotalCost?: MoneyString;

  urgency: "PASSIVE" | "NORMAL" | "AGGRESSIVE" | "IMMEDIATE";
  liquidityPreference: "MAKER_ONLY" | "MAKER_PREFERRED" | "TAKER_OK" | "TAKER_ONLY";
  partialFillPolicy: "REJECT" | "ACCEPT_ANY" | "ACCEPT_MINIMUM";
  minimumFillShares?: SharesString;
  validUntil: string;

  expectedProbability?: ProbabilityString;
  expectedNetEdge?: MoneyString;
  tags: string[];
};
```

#### Quote intent

```ts
export type QuoteIntent = {
  type: "QUOTE";
  intentId: string;
  marketId: string;
  bids: readonly QuoteLevel[];
  asks: readonly QuoteLevel[];
  postOnly: true;
  quoteLifetimeMs: number;
  replaceThresholdTicks: number;
  maximumInventory: SharesString;
  tags: string[];
};
```

#### Coordinated basket intent

```ts
export type BasketIntent = {
  type: "BASKET";
  intentId: string;
  legs: readonly BasketLeg[];
  maximumCombinedCost: MoneyString;
  minimumLockedEdge: MoneyString;
  legRiskLimit: MoneyString;
  failurePolicy: "ABANDON" | "PROTECTED_UNWIND" | "HOLD_FILLED_LEGS";
  validUntil: string;
};
```

Basket execution is coordinated, not assumed atomic.

#### Cancel and reduction intents

```ts
export type CancelIntent = {
  type: "CANCEL";
  marketId?: string;
  orderIds?: readonly string[];
  reason: string;
};

export type ReducePositionIntent = {
  type: "REDUCE_POSITION";
  marketId: string;
  targetShares: SharesString;
  urgency: "NORMAL" | "AGGRESSIVE" | "IMMEDIATE";
  minimumSellPrice?: PriceString;
  maximumBuyPrice?: PriceString;
  reason: string;
};
```

A risk veto never silently mutates an intent. A resize creates a new approved-intent record linked to the original.

---

## 8. Event loop and ordering semantics

### 8.1 Live processing

The trader uses one deterministic core event loop:

```text
receive normalized event
  → validate schema
  → update local market/account state
  → update feature snapshots
  → invoke subscribed strategies in stable configured order
  → persist DecisionResults
  → allocate capital
  → run risk checks
  → create execution plans
  → update OMS / submit eligible actions
  → persist resulting events and projections
```

The core loop must never wait on external I/O. Database writes, Redis reads, and venue calls are handled through bounded adapters and completion events. The loop may synchronously append to a local journal/outbox only if benchmarked within the latency budget.

### 8.2 Stable strategy order

Subscribed strategies are evaluated by:

```text
market ownership priority
strategy instance priority
strategy instance UUID
```

The order is stable and recorded in the run manifest. V1 prevents multiple live owners of one market, but shadow instances may still evaluate after the owner.

### 8.3 Backpressure

Every queue is bounded and exposes:

```text
current depth
maximum depth
oldest message age
messages dropped
producer blocked time
consumer lag
```

Dropping trading or raw market events silently is forbidden. If a critical queue cannot accept an event, affected trading halts and a data-quality incident opens.

### 8.4 Replay ordering

Replay consumes the same normalized event envelopes in the exact recorded dispatch order. It must not sort solely by venue timestamp. Dataset manifests include all segment checksums, gateway epochs, event ranges, and excluded data-quality windows.

---

## 9. Component specifications

### 9.1 Market Data Gateway and Recorder

Responsibilities:

- Maintain public Polymarket market WebSocket subscriptions.
- Maintain Binance and Coinbase reference subscriptions.
- Maintain RTDS Chainlink TWAP subscriptions required by active settlement specs.
- Normalize messages without adding trading logic.
- Assign `gatewayEpoch`, `ingestSeq`, receipt timestamps, and connection metadata.
- Enqueue exact raw frames to the WAL writer before publication.
- Publish normalized events through the transport interface.
- Detect per-connection and per-asset staleness.
- Resubscribe and obtain authoritative snapshots after gaps.
- Rotate WAL segments and expose compaction manifests.
- Continue recording while the trader is redeployed.

Raw frame record:

```ts
export type RawFrameRecord = {
  gatewayEpoch: string;
  ingestSeq: string;
  source: string;
  endpoint: string;
  connectionId: string;
  subscriptionGeneration: number;
  receivedAt: string;
  receivedMonotonicNs: string;
  payloadUtf8: string;
  payloadSha256: string;
};
```

WAL requirements:

- Append-only JSONL or another ADR-approved recoverable format.
- Rotate by size and time.
- Periodic `fsync`, not one `fsync` per frame.
- File header includes schema version and gateway epoch.
- File footer or sidecar includes record count and SHA-256.
- Recovery truncates only an incomplete final record.
- Compaction never deletes a WAL segment until Parquet upload and checksum verification succeed.

Publication requirements:

- Transport interface supports publish, subscribe, consumer checkpoint, and bounded retention.
- Redis Streams is the initial implementation.
- Trader lag beyond configured retention is a hard resynchronization event, not silent catch-up from an incomplete stream.
- Benchmark gateway receipt-to-trader dispatch p99; target under 5 ms on the deployment host.

### 9.2 Universe Service

Responsibilities:

- Discover current and upcoming crypto markets.
- Group ephemeral markets into stable series such as `btc-15m-updown`.
- Store both outcome tokens, condition ID, event ID, tick size, minimum size, `negRisk`, fee schedule, trading delay, open/close timestamps, and raw metadata.
- Version market parameters on every change.
- Bind each reviewed series to a `SettlementSpec`.
- Emit lifecycle events.
- Reject model-dependent strategy activation on unverified settlement specs.
- Perform per-market eligibility and readiness checks.

Series binding is configuration, not heuristic-only. The system may suggest a series match, but a new market pattern is not auto-approved for live trading.

### 9.3 Settlement Specification and Payoff Models

Required settlement-spec fields:

```text
settlement_spec_id
series_id
rules_version_id
resolution_source
reference_symbol
observation_type:
  TERMINAL_SPOT | TWAP | VWAP | EVENT_RESULT | MANUAL_ORACLE
window_seconds
window_start_rule
window_end_rule
comparison:
  GT | GTE | LT | LTE
strike_source
reference_open_source
timestamp_boundary
rounding_rule
fallback_source
dispute_policy
clarification_policy
verified_by
verified_at
```

Required outcome states:

```text
YES_WIN
NO_WIN
SPLIT_50_50
CANCELLED
DISPUTED
PENDING
PENDING_CLARIFICATION
```

Payoff models are selected by settlement spec:

```text
TerminalSpotBinaryModel
TwapBinaryModel
ReferenceOpenUpDownModel
ThresholdByDateModel
```

A terminal-spot model must not be used for a TWAP-settled market.

### 9.4 Local Order Book

Requirements:

- Maintain independent books for both outcome tokens.
- Apply snapshots and absolute-size price changes exactly as documented by the venue.
- Store prices and quantities as exact decimals.
- Track best bid, ask, spread, depth, hash, last update, and staleness.
- Reject updates from a stale subscription generation.
- Expose executable price for a requested quantity.
- Validate reconstructed state against periodic REST snapshots.
- Invalidate or reprice affected orders when tick size changes.

The implementation must not invent a venue sequence number. It may use internal ingest order, venue timestamps, and venue-provided hashes.

### 9.5 Feature Engine

Feature definitions are registered and versioned. Minimum v1 features:

```text
Polymarket:
  best bid / ask
  midpoint
  spread
  depth at configured levels
  volume-weighted executable buy/sell price
  order-book imbalance
  microprice
  recent trade direction and volume

External:
  Binance returns: 250ms, 1s, 5s, 30s
  Coinbase returns: 250ms, 1s, 5s, 30s
  cross-venue midpoint difference
  cross-venue direction agreement
  EWMA realized volatility
  Chainlink 30s/60s TWAP where configured

Lifecycle:
  time to close
  time since open
  market duration
  reference-open distance

Quality:
  age of every input feed
  active data-quality incident flags
```

A `FeatureSnapshot` is immutable and content-addressed. High-frequency snapshots may live in the event archive; important action decisions store a durable snapshot reference plus selected indexed values in PostgreSQL.

### 9.6 Strategy Runtime

Responsibilities:

- Load a strategy definition and immutable configuration.
- Validate parameters against JSON Schema/Zod.
- Own per-instance state and deterministic seeded RNG.
- Invoke synchronous callbacks.
- Enforce evaluation-time watchdogs.
- Persist exactly one `DecisionResult` per evaluation.
- Checkpoint strategy state after defined transitions.
- Restore compatible state on restart.
- Start a new run for every code, config, model, feature, or state-schema change.

Strategy callbacks:

```ts
export interface Strategy<TParams, TState> {
  readonly name: string;
  readonly version: string;
  readonly paramsSchema: unknown;
  readonly stateSchemaVersion: number;

  onStart(ctx: StrategyContext): DecisionResult;
  onMarketOpen(ctx: StrategyContext): DecisionResult;
  onFeatures(ctx: StrategyContext): DecisionResult;
  onFill(ctx: StrategyContext, fill: StrategyFill): DecisionResult;
  onOrderUpdate(ctx: StrategyContext, order: StrategyOrderView): DecisionResult;
  onTimer(ctx: StrategyContext): DecisionResult;
  onMarketClosing(ctx: StrategyContext, secondsRemaining: number): DecisionResult;
  onMarketResolved(ctx: StrategyContext, resolution: ResolutionView): DecisionResult;
  onStop(ctx: StrategyContext, reason: string): DecisionResult;
}
```

### 9.7 Capital Allocator

Tracks commitments from both positions and open orders:

```text
account equity
available pUSD
reserved pUSD
outcome-token inventory
reserved outcome tokens
per-instance allocation
per-market exposure
per-series exposure
per-underlying exposure
per-resolution-window exposure
worst-case contractual loss
```

Initial defaults should reflect user-defined caps rather than hardcoded historical examples. The allocator must support a global account cap, per-strategy cap, and live-micro cap.

V1 does not net opposing strategy intents. It rejects conflicting live ownership and preserves independent shadow accounting.

### 9.8 Risk Engine

Pre-trade checks, cheapest first:

1. Run and strategy state permit the intent.
2. Run mode is within process maximum.
3. Real-order enablement and fencing are valid when applicable.
4. Venue geographic eligibility permits the action.
5. Market is active and accepting orders.
6. Settlement spec is verified for the strategy type.
7. Required feeds are fresh and healthy.
8. Book is synchronized.
9. Current trading parameters are known.
10. Price conforms to tick and configured bounds.
11. Size meets minimum and economic floor.
12. Expected net edge remains positive after fees, slippage, and risk buffer.
13. Requested quantity respects participation limits.
14. Balance, allowance, inventory, and reservations are sufficient.
15. Per-order, per-market, per-instance, per-series, per-underlying, and global limits pass.
16. Worst-case contractual loss passes.
17. Scenario loss passes.
18. Self-trade and duplicate-intent guards pass.
19. Rate-limit headroom remains above safety reserve.
20. Time-to-close policy permits entry or reduction.

Primary risk measures:

```text
maximum contractual loss
mark-to-liquidation PnL
worst-case resolution PnL
gross capital committed
exposure by underlying and resolution window
scenario loss under spot, volatility, time, and liquidity shocks
```

Model-derived delta/gamma are secondary analytics, not the primary hard limit.

### 9.9 Incident Controller

The Incident Controller—not the ordinary risk gate—originates operational safety actions.

Action ladder:

```text
HALT_NEW_ENTRIES
CANCEL_RESTING_ORDERS
RECONCILE_ACCOUNT
MANAGE_KNOWN_POSITIONS_ONLY
PROTECTED_REDUCE
HOLD_TO_RESOLUTION
FULL_HALT
```

The selected action depends on the failure class. Examples:

| Failure | Default action |
|---|---|
| External reference feed stale, Polymarket healthy | Cancel signal-dependent quotes; halt new entries |
| Polymarket book stale | Cancel resting orders; no blind aggressive orders |
| User stream lost, REST healthy | Pause submissions; reconcile through REST |
| Submission response lost | Reconcile using persisted signed order/order hash |
| Position known near close | Apply configured protected exit or explicit resolution-hold policy |
| Account state unknown | Stop heartbeat, cancel, reconcile, full halt |

### 9.10 Execution Planner

Converts approved intents into immutable execution plans.

Responsibilities:

- Select economic leg while respecting actual available inventory.
- Select maker/taker policy.
- Calculate exact tick-conforming prices.
- Calculate capped marketable limits for immediate execution.
- Slice orders.
- Define cancel/replace hysteresis.
- Define deadline and escalation policy.
- Define partial-fill handling.
- Define coordinated-basket leg-risk and unwind policy.
- Estimate fees, slippage, and expected proceeds.
- Reserve collateral/inventory before submission.

Execution hierarchy:

```text
Decision
  → Intent
  → Approved Intent
  → Execution Plan
  → Execution Group
  → Submission Attempt
  → Venue Order
  → Order Event
  → Fill
  → Fill Allocation
  → Settlement Event
```

### 9.11 OMS

Order state machine:

```text
PLANNED
SIGNED
SENDING
ACKNOWLEDGED
LIVE
DELAYED
PARTIALLY_FILLED
FILLED
CANCEL_PENDING
CANCELED
REJECTED
SUBMISSION_UNKNOWN
RECONCILING
EXPIRED
```

Trade settlement state machine:

```text
MATCHED
MINED
CONFIRMED
RETRYING
FAILED
```

Idempotent submission protocol:

1. Create `submission_attempt_id`.
2. Create and sign the complete venue order locally.
3. Persist signed payload, salt, expected order hash/identifier, and execution-plan link.
4. Commit state `SIGNED`.
5. Mark `SENDING` and transmit.
6. Persist response or timeout.
7. On lost response, mark `SUBMISSION_UNKNOWN`.
8. Query authoritative orders and trades using the known signed-order identity.
9. Retry the same signed order only when safe and supported.
10. Never create a new salt until the prior attempt is authoritatively absent, canceled, or terminal.

Do not assume the venue supports an arbitrary client-order-ID field.

### 9.12 Secure Venue Adapter

Responsibilities:

- Wrap only the official unified SDK.
- Expose an internal narrow interface.
- Isolate all signer access.
- Place, cancel, query, and heartbeat orders.
- Subscribe to the authenticated user channel.
- Handle current order response statuses, including delayed responses.
- Track asynchronous trade settlement.
- Handle current error taxonomy.
- Detect matching-engine restart, cancel-only, and post-only modes.
- Consume current rate-limit headers and per-signer warning headers.
- Perform geographic eligibility checks before live entries.

The rest of the codebase must not import `@polymarket/client` directly.

### 9.13 Rate-Limit Budget

Maintain separate budgets by:

```text
IP endpoint class
signer
order bucket
cancel bucket
relayer bucket
```

Priority order:

```text
1. Order heartbeat
2. Emergency cancel and cancel-all
3. Reconciliation and account-truth reads
4. Risk-reducing orders
5. Stale quote cancellation
6. New orders
7. Metadata refresh and analytics
```

Limits are configuration snapshots with source and effective time. Do not hardcode the example values in the product design.

### 9.14 Collateral and Inventory Manager

Responsibilities:

- Track actual and reserved pUSD.
- Track actual and reserved outcome tokens.
- Prevent double reservation.
- Prepare inventory before maker quoting.
- Split collateral into complete outcome sets.
- Merge balanced outcome sets.
- Redeem resolved positions.
- Track allowances and trading approvals.
- Track relayer transaction lifecycle.
- Reconcile all wallet operations.
- Estimate capital lock-up.

Wallet operation state:

```text
PLANNED
SUBMITTED
MINED
CONFIRMED
FAILED
UNKNOWN
RECONCILING
```

Supported operation types:

```text
APPROVE_ERC20
APPROVE_ERC1155
SPLIT
MERGE
REDEEM
TRANSFER
```

No autonomous deposit, withdrawal, or bridge behavior in v1.

### 9.15 Ledger and Position Projections

The ledger is append-only. Recommended model:

```text
ledger_transactions
ledger_entries
```

Every ledger transaction balances to zero **per asset** using explicit external-clearing accounts. Assets include pUSD and each outcome token ID.

Scopes:

```text
ACTUAL_ACCOUNT
VIRTUAL_STRATEGY
UNATTRIBUTED
EXTERNAL_CLEARING
FEE_EXPENSE
REWARD_INCOME
```

Events include:

```text
order reservation
reservation release
trade principal
outcome-token receipt/delivery
platform fee
maker rebate payout
taker rebate payout
liquidity reward
split
merge
redeem
deposit observed
withdrawal observed
manual adjustment
reconciliation correction
resolution
```

Actual and virtual position projections are rebuilt from ledger entries and fill allocations. Any actual balance change lacking attribution is allocated to `UNATTRIBUTED`, and the affected market is halted.

### 9.16 PnL Engine

Maintain:

```text
gross trading PnL
core net PnL excluding discretionary rewards
all-in PnL including realized rewards
realized PnL
unrealized PnL at midpoint
unrealized PnL at model value
unrealized PnL at liquidation value
worst-case resolution PnL
fees paid
reward estimates
realized rewards
capital committed
```

Reward estimates are never booked as realized. Fee and reward schedules are versioned per market where available.

### 9.17 Reconciler

Triggers:

```text
startup
periodic timer
user-stream reconnect
market-stream gap
submission unknown
wallet-operation unknown
manual request
position/balance discrepancy
```

Procedure:

1. Pause new submissions.
2. Read open orders.
3. Read recent trades and settlement statuses.
4. Read positions, balances, allowances, and relevant wallet operations.
5. Compare authoritative state to projections.
6. Emit append-only reconciliation events.
7. Resolve or quarantine discrepancies.
8. Resume only after all required invariants pass.

### 9.18 Heartbeat and fencing

- Only the active fenced trader may send order heartbeats.
- The heartbeat health lease requires recent proof from market data, user data, event loop, OMS, database, reconciler, and kill-switch state.
- A process that is alive but unhealthy must stop heartbeats.
- The independent cancel CLI can cancel without relying on trader memory.
- Redis is not sufficient as the only fence. Use a PostgreSQL advisory lock or lease with a monotonic fencing token persisted with every live submission.

---

## 10. Database model

Use PostgreSQL schemas to separate concerns while preserving one logical model.

### 10.1 `catalog`

| Table | Purpose |
|---|---|
| `series` | Stable rolling market families |
| `markets` | Internal market identity and current projection |
| `market_tokens` | Outcome token mapping |
| `market_rule_versions` | Immutable full rules and hashes |
| `market_clarifications` | Additional context observed after opening |
| `settlement_specs` | Structured, reviewed payoff semantics |
| `market_parameter_history` | Tick, minimum size, delay, `negRisk`, fees, status |
| `fee_schedule_snapshots` | Current and historical fee parameters |
| `reward_program_snapshots` | Maker/taker/liquidity-reward rules |
| `reference_instruments` | Binance, Coinbase, RTDS symbol mappings |

### 10.2 `data`

| Table | Purpose |
|---|---|
| `raw_segments` | WAL/Parquet segment metadata and checksums |
| `dataset_manifests` | Exact input segments and exclusions for replay |
| `data_quality_incidents` | Gaps, staleness, corruption, resync windows |
| `book_checkpoints` | Sparse authoritative book anchors, not full raw history |
| `feature_sets` | Feature definition versions |
| `feature_snapshot_index` | References to content-addressed feature records |

Raw high-frequency events live primarily in WAL/Parquet, not indefinitely in PostgreSQL.

### 10.3 `strategy`

| Table | Purpose |
|---|---|
| `definitions` | Strategy name, code version, schemas |
| `configs` | Immutable validated configuration versions |
| `instances` | Named deployments and ownership rules |
| `runs` | Code/config/data/model/environment pinning |
| `state_checkpoints` | Versioned strategy state |
| `decisions` | One record per strategy evaluation |
| `intents` | Original strategy intents |
| `approved_intents` | Risk-approved/resized variants |

### 10.4 `execution`

| Table | Purpose |
|---|---|
| `plans` | Immutable execution plans |
| `groups` | Slices or coordinated legs |
| `submission_attempts` | Persisted signed payloads and uncertainty state |
| `orders` | Current order projection |
| `order_events` | Append-only order lifecycle |
| `intent_order_links` | Many-to-many attribution |
| `fills` | Deduplicated fill facts |
| `fill_allocations` | Actual fill ownership by virtual strategy |
| `trade_settlements` | Match-to-confirmation lifecycle |
| `rate_limit_snapshots` | Observed budgets and headers |

### 10.5 `accounting`

| Table | Purpose |
|---|---|
| `ledger_transactions` | Event-level accounting transaction |
| `ledger_entries` | Per-asset balanced entries |
| `actual_position_projection` | Rebuildable wallet position view |
| `virtual_position_projection` | Rebuildable strategy attribution |
| `balance_projection` | Actual and reserved balances |
| `inventory_reservations` | Funds/tokens reserved for plans/orders |
| `wallet_operations` | Split, merge, redeem, approve, transfer |
| `wallet_operation_events` | Append-only operation lifecycle |
| `reward_estimates` | Non-realized estimates |
| `reward_payouts` | Actual observed payouts |
| `pnl_snapshots` | Rebuildable reporting projection |

### 10.6 `ops`

| Table | Purpose |
|---|---|
| `risk_events` | Vetoes, breakers, exposure violations |
| `incidents` | Operational incident lifecycle |
| `reconciliation_runs` | Reconciliation attempts |
| `reconciliation_breaks` | Individual mismatches |
| `kill_switch_events` | Global, market, or instance actions |
| `config_change_audit` | Human and automated changes |
| `fencing_leases` | Active live-writer lease and token |
| `health_snapshots` | Optional sampled subsystem health |

### 10.7 Required constraints

- UUIDv7 or equivalent sortable IDs for internal records.
- `orders(venue_order_id)` unique where not null, scoped by environment/account.
- `fills(venue_trade_id, venue_order_id, allocation discriminator)` unique.
- `submission_attempts(expected_order_hash)` unique where known.
- Immutable strategy configs and market rule versions.
- Append-only event and ledger tables; updates are forbidden except explicitly mutable projections.
- Every live order references a valid fencing token.
- Every fill allocation sum equals the actual fill quantity.
- Every ledger transaction balances to zero per asset.
- No negative available balance after reservations.
- Only one active live owner per market.

### 10.8 Logical versus physical environment separation

Use one semantic schema and generated types, but separate live operational storage from large backtest output. Backtests may write to a research PostgreSQL database or Parquet/DuckDB while preserving the same field definitions.

A parameter sweep must never contend with live order, ledger, heartbeat, or reconciliation writes.

---

## 11. Run modes

| Mode | Data | Execution | Credentials | Purpose |
|---|---|---|---|---|
| `BACKTEST` | Historical replay | Simulated | None | Deterministic research and regression |
| `PAPER` | Live | Simulated | Public only | Validate signal, state, risk, and operations |
| `SHADOW` | Live | Simulated beside another run | Public only | Counterfactual comparison |
| `EXECUTION_PROBE` | Live | Tiny real calibration orders | Live signer | Measure latency, queue/fills, cancels, markout |
| `LIVE_MICRO` | Live | Real, hard capped | Live signer | End-to-end real-money validation |
| `LIVE` | Live | Real | Live signer | Normal production allocation |

A process has a maximum allowed mode. It cannot be raised through the control API above the startup maximum.

---

## 12. Simulation and research

### 12.1 Swappable infrastructure

```ts
interface Clock {
  now(): string;
  monotonicNs(): bigint;
}

interface MarketEventSource {
  events(): AsyncIterable<EventEnvelope<unknown>>;
}

interface ExecutionVenue {
  submit(plan: ExecutionPlan): Promise<ExecutionResult>;
  cancel(command: CancelCommand): Promise<CancelResult>;
  queryAccountState(): Promise<AccountSnapshot>;
}
```

Everything between event input and the `ExecutionVenue` interface is shared.

### 12.2 Fill models

#### Tier 0 — pipeline smoke model

- Immediate orders consume the observed top/depth without latency.
- Maker orders fill on touch/trade-through.
- Never used for deployment decisions.

#### Tier 1 — latency and queue-estimated model

Immediate orders:

1. Add sampled decision, signing, network, and venue latency.
2. Replay market events during the delay.
3. Execute against resulting depth.
4. Apply FAK/FOK/limit semantics and historical fee parameters.

Resting orders:

- Estimate quantity ahead at placement.
- Decrement according to observed trades.
- Apply optimistic/base/conservative cancellation assumptions.
- Report a result band, not one falsely precise fill result.

#### Execution calibration model

Actual execution-probe and live-micro observations fit conditional models for:

```text
fill probability
fill latency
cancel effectiveness
partial-fill distribution
slippage
post-fill markout
```

Paper fills do **not** count as independent evidence that the fill simulator is correct.

### 12.3 Markouts

Markouts are diagnostics and calibration inputs. Do not subtract an additional markout penalty from a replay path that already includes the subsequent adverse price movement. Produce separate stress scenarios when desired.

Required horizons:

```text
100ms
500ms
1s
5s
30s
300s
resolution
```

### 12.4 Determinism

A fixed dataset, code commit, config, feature version, model version, simulator version, and seed must produce byte-identical:

```text
decisions
intents
risk results
execution plans
simulated order events
fills
ledger events
PnL outputs
```

CI runs a small golden replay on every change to core contracts.

### 12.5 Dataset manifests

Every replay run pins:

```text
raw segment IDs and checksums
normalizer version
feature-set version
excluded incident windows
start/end event identity
run seed
fill-model version and parameters
latency-model version and parameters
fee/reward snapshot versions
settlement-spec versions
```

### 12.6 Evaluation methodology

Standard outputs:

- Time-based train/validation/holdout split.
- Block-bootstrap confidence intervals.
- Effective sample size.
- Parameter sweep count and multiple-comparison warning.
- Core PnL at modeled costs, 1.5× costs, and 2× costs.
- Results with and without discretionary rewards.
- Performance by volatility, liquidity, spread, time-to-close, and market series.
- Calibration curves and Brier score for probability models.
- Predicted versus actual fill and slippage distributions.

Decision-log queries may answer local filter questions. Stateful counterfactual PnL requires a full deterministic replay.

---

## 13. First strategy: Static Bracket

### 13.1 Purpose

Static Bracket is the first end-to-end strategy because it exercises:

- Market-series binding.
- Entry triggers.
- Maker and taker execution policies.
- Partial fills.
- Exit creation from actual fill allocation.
- Stop, timeout, close cutoff, and resolution-hold policies.
- Order cancel/replace.
- PnL and reconciliation.

It is not presumed profitable.

### 13.2 Configuration

```yaml
strategy: static-bracket
version: 1

market_selector:
  series_id: btc-15m-updown
  direction: YES

entry:
  trigger_basis: executable_ask
  trigger_price_lte: "0.35"
  size_shares: "50"
  maximum_total_cost: "18"

  execution:
    liquidity_preference: MAKER_PREFERRED
    passive_price: "0.35"
    convert_to_aggressive_after_ms: 0
    maximum_buy_price: "0.35"
    immediate_order_type: FAK
    partial_fill_policy: ACCEPT_MINIMUM
    minimum_fill_shares: "10"

exit:
  take_profit:
    price: "0.50"
    liquidity_preference: MAKER_ONLY
    post_only: true

  stop:
    trigger_basis: executable_bid
    trigger_price_lte: "0.27"
    minimum_sell_price: "0.26"
    urgency: AGGRESSIVE

  maximum_holding_seconds: 180
  entry_cutoff_before_close_seconds: 45
  exit_cutoff_before_close_seconds: 20
  final_policy: PROTECTED_REDUCE
  allow_resolution_hold: false

reentry:
  maximum_entries_per_market: 1
  cooldown_seconds: 30

risk:
  maximum_position_shares: "50"
  maximum_contractual_loss: "18"
  maximum_slippage: "1"
  maximum_book_participation: "0.05"
```

### 13.3 State machine

```text
DORMANT
  → ARMED
  → ENTRY_PLANNED
  → ENTRY_WORKING
  → PARTIALLY_OPEN
  → OPEN
  → EXIT_PLANNED
  → EXIT_WORKING
  → CLOSED

Any state:
  → PAUSED
  → HALTED

Working orders:
  → CANCEL_PENDING
  → CANCELED | REJECTED | SUBMISSION_UNKNOWN
```

Rules:

- Exit size equals actual allocated filled size.
- A partial fill can transition to `PARTIALLY_OPEN` and create a proportional exit only after allocation.
- Maximum entries count actual entry executions, not merely intents.
- A stop on stale data is forbidden; incident policy applies first.
- End-of-market behavior is an explicit configured policy.

### 13.4 Acceptance tests

- Entry at exact threshold.
- No entry one tick above threshold.
- Tick-size change while resting.
- Partial entry and proportional exit.
- Entry response lost and later reconciled live.
- Stop trigger with healthy book.
- Stale-book stop does not blind-flatten.
- Market close cutoff.
- Resolution hold allowed and disallowed.
- YES/NO economic-leg comparison with and without inventory.
- Fee-aware rejection when expected edge is insufficient.
- Deterministic replay.

---

## 14. Operational controls and observability

### 14.1 Kill switch scopes

```text
GLOBAL
ACCOUNT
MARKET
STRATEGY_INSTANCE
```

Actions:

```text
HALT_NEW_ENTRIES
CANCEL_ALL
CANCEL_MARKET
MANAGE_POSITIONS_ONLY
FULL_HALT
```

Every change is append-only audited with actor, reason, timestamp, prior state, and resulting state.

### 14.2 Independent emergency CLI

Required commands:

```text
ops-cli verify-venue
ops-cli geoblock-check
ops-cli account-snapshot
ops-cli reconcile
ops-cli cancel-order <id>
ops-cli cancel-market <condition-id>
ops-cli cancel-all
ops-cli stop-heartbeat
ops-cli validate-dataset <manifest>
ops-cli replay <manifest> <config>
```

`cancel-all` must use only current credentials and venue truth; it must not require the trader database to be healthy.

### 14.3 Metrics

Minimum metric families:

```text
feed:
  messages/sec
  staleness by source/instrument
  reconnects
  resyncs
  data-quality incidents

latency:
  source-to-gateway
  gateway-to-trader
  event-loop
  strategy evaluation
  decision-to-submit
  submit-to-ack
  ack-to-fill
  fill-to-confirmation

execution:
  orders by state
  partial fills
  maker/taker ratio
  cancel effectiveness
  post-only rejects
  unknown submissions
  matching-engine modes

risk:
  exposure versus limits
  scenario loss
  vetoes by reason
  incident-controller state

accounting:
  reconciliation breaks
  unattributed activity
  ledger imbalance attempts
  actual-versus-virtual allocation

simulation fidelity:
  predicted-versus-actual fill rate
  fill latency
  slippage
  markout

recorder:
  WAL queue depth
  bytes written
  fsync latency
  segment age
  compaction lag
  object upload status
```

### 14.4 Alerts

**Page:**

- Account state unknown.
- Reconciliation mismatch.
- Unknown submission unresolved.
- Heartbeat health lease failed while orders may exist.
- Unattributed actual position.
- Data gateway unable to record or publish.
- Ledger invariant failure.
- Live fencing conflict.

**Notify:**

- Feed reconnect or resync.
- Elevated venue errors.
- Matching-engine restricted mode.
- Rate-limit pressure.
- Strategy auto-paused.
- Simulation/live divergence.

**Log:**

- Ordinary vetoes.
- Normal cancels.
- Expected partial fills.

---

## 15. Security requirements

- Production private key is never committed, logged, copied to fixtures, or mounted into non-live processes.
- Secrets are injected from a secrets manager or protected runtime mount.
- Logs redact API keys, passphrases, signatures, signed order payloads, and private wallet material.
- Signed order payloads persisted for idempotency are encrypted at rest and access-controlled.
- Control API uses authentication and explicit authorization for live-mode, kill-switch, config, and wallet-operation actions.
- No public network exposure for PostgreSQL, Redis, or internal metrics endpoints.
- Independent cancel credentials are protected separately from the main service runtime where practical.
- Dependency lockfiles and vulnerability scanning run in CI.
- Live SDK upgrades require contract tests and an execution-probe canary.
- A paper environment cannot reference production secret names.

---

## 16. Testing strategy

### 16.1 Unit tests

- Decimal normalization and arithmetic.
- Tick rounding in both directions.
- Fee precision and rounding.
- Settlement payoff models.
- Book update application.
- Feature calculations.
- Strategy state transitions.
- Risk reason codes.
- Execution-plan construction.
- Ledger balancing.

### 16.2 Property tests

- No accepted order violates tick size.
- Fees are non-negative and symmetric where the fee curve requires.
- Partial fills never allocate more than actual fill quantity.
- Ledger transactions balance per asset.
- Reservations never create negative availability.
- Position projection rebuilt from events equals incremental projection.
- Cancel/replace sequences preserve total outstanding quantity constraints.
- Every terminal order path releases unused reservations.

### 16.3 Contract tests

Using sanitized official examples and captured non-sensitive responses:

- Public market discovery.
- Market WebSocket events.
- User WebSocket order/trade events.
- Limit and market order response parsing.
- Delayed-order responses.
- Matching-engine restart and restricted modes.
- Heartbeat protocol.
- Current rate-limit headers.
- Position split/merge/redeem transaction handles.
- Geoblock response parsing.

Contract tests must not place real orders in ordinary CI.

### 16.4 Integration tests

Use Testcontainers for PostgreSQL and Redis. Test:

- Gateway → Redis Stream → trader event flow.
- Trader restart and strategy-state restore.
- Database transaction rollback.
- OMS unknown-submission reconciliation against a mock venue.
- User-stream disconnect and REST recovery.
- Inventory reservation and release.
- Ledger and PnL rebuild.
- Control kill switch.

### 16.5 Replay golden tests

A fixed recorded fixture produces byte-identical decisions, plans, fills, ledger entries, and PnL.

### 16.6 Fault injection

Required scenarios:

- Kill trader before order transmission.
- Kill trader after transmission but before response persistence.
- Kill trader after match but before user-stream update.
- Drop user-stream messages.
- Stall one market subscription while socket remains open.
- Corrupt the final WAL record.
- Fill disk or exceed configured WAL capacity.
- Redis outage.
- PostgreSQL outage.
- Matching-engine `425` restart.
- Cancel-only and post-only mode.
- Heartbeat response invalid/expired.
- Duplicate and out-of-order events.
- Tick-size change with live orders.
- Clarification or settlement-spec change.

### 16.7 Soak tests

Time-based operational gates cannot be faked by an agent. The orchestrator must mark them `PENDING_EXTERNAL_EVIDENCE` until real elapsed-time evidence exists.

---

## 17. Phase plan and hard gates

### Phase 0 — Repository and venue verification

Deliver:

- Monorepo skeleton.
- CI and local compose.
- Domain/decimal conventions.
- Venue verification report and fixtures.
- Initial ADRs.

Automated gate:

- Clean install from lockfile.
- Typecheck, lint, unit tests.
- No production credentials required.
- Official unified SDK smoke client compiles.

### Phase 1 — Recording-ready

Deliver:

- Market Data Gateway/Recorder.
- Polymarket public market feed.
- Binance/Coinbase feeds.
- RTDS TWAP feed.
- Universe and settlement-spec storage.
- WAL, compaction, Parquet manifests.
- Data-quality monitoring.
- Replay event source.

Automated gate:

- Recorded deltas reconstruct fixture books exactly.
- Gap detection suspends and resynchronizes.
- WAL crash recovery succeeds.
- Segment checksums validate.
- Replay preserves dispatch order.

Operational gate:

- Sustained recording soak with no unexplained gaps.
- Book reconstruction agrees with independent snapshots.
- Storage growth and latency measured.

### Phase 2 — Paper-ready core

Deliver:

- Strategy runtime.
- Feature engine.
- Capital allocator and risk.
- Execution planner.
- Simulated OMS/venue.
- Ledger, positions, PnL.
- Static Bracket.
- Control and dashboards.

Automated gate:

- Determinism golden test passes.
- Fee/PnL property tests pass.
- Static Bracket passes all state-machine scenarios.
- Ledger rebuild equals incremental state.
- No live signer code path is reachable.

Operational gate:

- Paper run across reviewed market series.
- Zero unexplained state divergence.
- Decision and veto analytics are usable.

### Phase 3 — Live-micro-ready infrastructure

Deliver:

- Secure venue adapter.
- Authenticated user stream.
- OMS signed-order persistence and unknown-state recovery.
- Reconciler.
- Inventory manager.
- Heartbeat health lease.
- Geographic eligibility check.
- Fencing.
- Independent cancel CLI.
- Matching-engine restricted-mode handling.

Automated gate:

- Full mock-venue fault-injection suite passes.
- Production signer remains absent from CI.
- Live maximum defaults remain zero.
- Startup with ambiguous account state enters cancel-only/full-halt.

Human gate:

- Architecture and security review.
- Current venue docs reverified.
- Account/wallet flow manually verified.
- Live-micro caps explicitly configured.

### Phase 4 — Execution probes

Deliver:

- Tiny real maker/taker calibration plans.
- Actual latency/fill/cancel/markout dataset.
- Execution-model calibration report.

Gate:

- No unexplained order or balance discrepancy.
- Predicted and actual distributions are compared honestly.
- Maker strategy promotion remains blocked without actual evidence.

### Phase 5 — Live micro

Deliver:

- One strategy, one reviewed series, tiny capital.
- Runbook-driven operation.
- Daily reconciliation and review.

Gate:

- Effective sample size and regime coverage are reported.
- Core PnL and all-in PnL are separated.
- Fill/slippage divergence is within approved bounds.
- Zero unresolved account discrepancies.
- Scale follows a written schedule, never intuition.

### Phase 6 — Additional strategies

Recommended order:

```text
1. Hold to Resolution
2. Spot Momentum
3. Scalp / Instant Flip
4. Fast Fair-Value Divergence
5. Passive Market Maker
6. Coordinated arbitrage
```

Each strategy receives its own paper, execution-probe where needed, and live-micro graduation.

---

## 18. Orchestrator operating protocol

### 18.1 Orchestrator responsibilities

The orchestrator must:

- Maintain `IMPLEMENTATION_STATUS.md`.
- Maintain the dependency graph and phase gates.
- Create one task packet per subagent.
- Freeze shared contracts before parallel implementation.
- Prevent overlapping path ownership.
- Review every subagent handoff.
- Run integration tests after merges.
- Resolve contract conflicts centrally.
- Refuse to mark time-based gates complete without evidence.
- Keep live execution disabled unless a human explicitly approves the live-micro gate.

The orchestrator must not delegate final integration judgment to the same subagent that implemented a component.

### 18.2 Subagent task-packet template

Every subagent prompt must contain:

```markdown
# Work Package <ID>: <Title>

## Goal
A single measurable outcome.

## Allowed paths
Exact directories/files the agent may modify.

## Forbidden paths
Shared contracts or unrelated modules it may not change.

## Prerequisites
Merged work packages and contract versions.

## Required inputs
Schemas, fixtures, ADRs, and interfaces.

## Deliverables
Files, migrations, tests, docs, and commands.

## Acceptance criteria
Executable and observable conditions.

## Required handoff
- Summary
- Files changed
- Tests run and results
- Assumptions
- Deviations
- Known risks
- Follow-up work
```

### 18.3 Subagent rules

- Do not redesign beyond the task packet.
- Do not add live credentials or real-order tests.
- Do not edit protected contracts to make local code easier.
- Do not suppress failing tests.
- Do not replace exact decimals with numbers.
- Do not mock away the central behavior being tested.
- Do not claim a real-world soak or live result occurred.
- Report blockers with evidence instead of guessing.
- Leave the repository buildable and tests passing.

### 18.4 Merge protocol

1. Subagent completes branch/worktree.
2. Subagent produces required handoff.
3. Orchestrator reviews diff and test evidence.
4. Verification subagent runs targeted adversarial review.
5. Orchestrator merges.
6. Full typecheck and relevant integration suite run.
7. `IMPLEMENTATION_STATUS.md` and task graph update.

### 18.5 Parallelism rules

Safe to parallelize after contracts freeze:

- Public venue adapters and database migrations.
- Binance and Coinbase adapters.
- Observability and control read APIs.
- Simulator and feature calculations against stable contracts.

Do not parallelize without explicit coordination:

- Domain contracts and their consumers.
- OMS and secure venue adapter.
- Ledger and fill allocation.
- Strategy runtime and decision persistence.
- Inventory reservations and execution planning.
- Fencing, heartbeat, and live submission.

---

## 19. Work-package dependency plan

The companion YAML file contains the machine-readable graph. The canonical work packages are summarized here.

### Wave 0 — Freeze foundations

| ID | Work package | Depends on |
|---|---|---|
| `WP-000` | Venue verification and fixtures | None |
| `WP-010` | Monorepo, CI, compose, quality gates | None |
| `WP-020` | Domain contracts and exact decimals | `WP-010` |
| `WP-030` | Initial ADRs and contract documentation | `WP-000`, `WP-020` |

### Wave 1 — Recording platform

| ID | Work package | Depends on |
|---|---|---|
| `WP-040` | PostgreSQL schemas and migrations | `WP-020` |
| `WP-050` | WAL, segment manifests, recovery | `WP-020` |
| `WP-060` | Redis Streams transport | `WP-020`, `WP-010` |
| `WP-070` | Polymarket public adapter | `WP-000`, `WP-020` |
| `WP-080` | Binance adapter | `WP-020` |
| `WP-090` | Coinbase adapter | `WP-020` |
| `WP-100` | RTDS Chainlink TWAP adapter | `WP-000`, `WP-020` |
| `WP-110` | Universe and settlement specs | `WP-000`, `WP-040` |
| `WP-120` | Data gateway integration | `WP-050` through `WP-110` |
| `WP-130` | Parquet compactor and dataset manifests | `WP-050`, `WP-040` |
| `WP-140` | Recorder observability and soak harness | `WP-120`, `WP-130` |

### Wave 2 — Deterministic paper core

| ID | Work package | Depends on |
|---|---|---|
| `WP-150` | Local order books | `WP-020`, `WP-070` |
| `WP-160` | Feature engine | `WP-150`, `WP-080`, `WP-090`, `WP-100` |
| `WP-170` | Strategy SDK and runtime | `WP-020`, `WP-040` |
| `WP-180` | Capital allocator and risk | `WP-020`, `WP-040` |
| `WP-190` | Execution planner contracts | `WP-020`, `WP-180` |
| `WP-200` | Append-only ledger and projections | `WP-040`, `WP-020` |
| `WP-210` | Simulation clock, replay source, sim venue | `WP-130`, `WP-150`, `WP-190`, `WP-200` |
| `WP-220` | Static Bracket strategy | `WP-160`, `WP-170`, `WP-210` |
| `WP-230` | Paper trader integration | `WP-120`, `WP-160` through `WP-220` |
| `WP-240` | Control API and dashboards | `WP-040`, `WP-230` |
| `WP-250` | Determinism and paper E2E verification | `WP-230`, `WP-240` |

### Wave 3 — Live-micro infrastructure

| ID | Work package | Depends on |
|---|---|---|
| `WP-260` | Secure SDK adapter and signer boundary | `WP-000`, `WP-020` |
| `WP-270` | OMS and signed-order persistence | `WP-190`, `WP-200`, `WP-260` |
| `WP-280` | Authenticated user stream | `WP-000`, `WP-260`, `WP-270` |
| `WP-290` | Reconciliation | `WP-200`, `WP-270`, `WP-280` |
| `WP-300` | Inventory and wallet operations | `WP-000`, `WP-200`, `WP-260` |
| `WP-310` | Rate-limit budgets and restricted modes | `WP-000`, `WP-260`, `WP-270` |
| `WP-320` | Heartbeat, fencing, geoblock, kill controls | `WP-260`, `WP-290`, `WP-310` |
| `WP-330` | Independent emergency ops CLI | `WP-260`, `WP-290`, `WP-320` |
| `WP-340` | Live-micro fault-injection suite | `WP-270` through `WP-330` |

### Wave 4 — Calibration and promotion

| ID | Work package | Depends on |
|---|---|---|
| `WP-350` | Execution-probe planner and hard caps | `WP-340` |
| `WP-360` | Fill/slippage/markout calibration pipeline | `WP-210`, `WP-350` |
| `WP-370` | Live-micro promotion report | `WP-360` plus human evidence |

---

## 20. Required ADRs

Create these before their related implementation is merged:

```text
ADR-001 Exact decimal representation
ADR-002 Event envelope and ordering semantics
ADR-003 Gateway-to-trader transport
ADR-004 WAL format, durability, and compaction
ADR-005 Strategy purity and DecisionResult contract
ADR-006 Actual ledger versus virtual allocation
ADR-007 Signed-order idempotency and unknown submissions
ADR-008 Live-writer fencing and heartbeat health lease
ADR-009 SettlementSpec and payoff-model selection
ADR-010 Run-mode enablement and production key boundary
ADR-011 One-live-owner-per-market policy
ADR-012 Simulation fill-model evidence hierarchy
```

ADRs document the locked decision and evidence. They are not an excuse to reopen every design choice.

---

## 21. Definition of done

A work package is complete only when:

- Its required code, tests, migrations, and docs exist.
- Typecheck and lint pass.
- Unit tests pass.
- Required integration/contract tests pass.
- No forbidden dependency direction is introduced.
- No economic field uses JavaScript `number`.
- Errors are typed and observable.
- Metrics and structured logs exist for operational components.
- Failure behavior is tested, not merely documented.
- The subagent handoff lists assumptions and deviations.
- The orchestrator updates status and dependency state.

A phase is complete only when every automated gate passes and every operational/human gate has real evidence or remains explicitly pending.

“Code exists” is not equivalent to “safe to trade.”

---

## 22. Initial implementation commands

The orchestrator should converge on a developer experience similar to:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm test:integration
pnpm test:replay
pnpm db:migrate
pnpm dev:infra
pnpm dev:gateway
pnpm dev:paper
pnpm ops:verify-venue
pnpm ops:validate-dataset --manifest <path>
```

Python research:

```bash
uv sync --frozen
uv run pytest
uv run python -m research.report --run-id <id>
```

Exact commands may change through `WP-010`, but CI and local development must use the same entry points.

---

## 23. Venue implementation notes current at handoff

These notes must be reverified at build time.

- Use the current official unified TypeScript SDK package, `@polymarket/client`, rather than archived CLOB clients.
- Current public market data includes book snapshots, absolute price-level changes, tick-size changes, last-trade events, and optional best-bid/ask and lifecycle events.
- The authenticated user stream reports order changes and trade settlement states such as matched, mined, confirmed, retrying, and failed.
- Order matches settle asynchronously; an accepted order response may precede settlement transaction hashes.
- Resting-order safety should use the order-heartbeat endpoint. If valid heartbeats stop, venue-owned open orders are canceled after the documented timeout/check interval.
- Order types include GTC, GTD, FOK, and FAK; post-only applies only to resting limit types.
- Per-market tick size is dynamic and must be read rather than enumerated from old assumptions.
- Rate limits include IP-level throttling and separate per-signer order/cancel token buckets. Limits and enforcement status can change.
- Matching-engine restarts can return HTTP 425 and are followed by a post-only period; cancel-only/post-only responses require mode-aware behavior.
- Buying consumes pUSD; selling requires outcome-token inventory. Split, merge, and redeem are first-class wallet operations.
- Resolution can include a rare 50/50 outcome and may receive on-chain clarification after trading begins.
- Current Chainlink TWAP integration provides 30-second and 60-second windows through RTDS; settlement specs must determine whether those feeds are relevant to a specific series.
- Real order placement must perform the current geographic eligibility check.

---

## 24. Official references

Reverify these links at the start of each implementation phase:

- API overview: https://docs.polymarket.com/getting-started/api
- SDK migration/unified SDK: https://docs.polymarket.com/getting-started/migrate-from-previous-sdks
- Official TypeScript SDK: https://github.com/Polymarket/ts-sdk
- Market WebSocket: https://docs.polymarket.com/market-data/websocket/market-channel
- User WebSocket: https://docs.polymarket.com/market-data/websocket/user-channel
- Place orders: https://docs.polymarket.com/trading/place-orders
- Manage orders and heartbeat: https://docs.polymarket.com/trading/manage-orders
- Real-time order updates: https://docs.polymarket.com/trading/realtime-order-updates
- Rate limits: https://docs.polymarket.com/api-reference/rate-limits
- Per-signer trading limits: https://docs.polymarket.com/api-reference/trading-rate-limits
- Matching-engine restarts: https://docs.polymarket.com/trading/matching-engine
- Fees: https://docs.polymarket.com/trading/fees
- Maker rebates: https://docs.polymarket.com/programs/maker-rebates
- Taker rebates: https://docs.polymarket.com/programs/taker-rebates
- Liquidity rewards: https://docs.polymarket.com/programs/liquidity-rewards
- Position management: https://docs.polymarket.com/trading/positions/manage
- CTF overview: https://docs.polymarket.com/trading/ctf/overview
- Resolution: https://docs.polymarket.com/concepts/resolution
- Chainlink TWAP: https://docs.polymarket.com/market-data/chainlink-twap
- Geographic restrictions: https://docs.polymarket.com/api-reference/geoblock

---

## 25. Final instruction to the orchestrator

Start with `WP-000` and `WP-010` in parallel. Do not assign implementation of the secure live adapter, OMS, or signer boundary until venue fixtures and domain contracts have been reviewed and frozen. Do not let subagents create independent interpretations of prices, order state, fill state, settlement, or ledger accounting.

Optimize first for:

```text
correctness
recoverability
auditability
data quality
simulation honesty
operational safety
```

Only then optimize latency and strategy breadth.
