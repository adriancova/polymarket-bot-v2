# `@polymarket-bot/storage-postgres`

Owner: `WP-040`
Authority: `docs/spec/polymarket-bot-orchestrator-handoff.md` §10 (database
model), §10.7 (required constraints), §10.8 (environment separation), §2 (`pg`
plus a SQL-first typed query layer), §5.2 (dependency direction)
Related ADRs: [ADR-006](../../docs/adr/ADR-006-actual-ledger-versus-virtual-allocation.md),
[ADR-007](../../docs/adr/ADR-007-signed-order-idempotency-and-unknown-submissions.md),
[ADR-008](../../docs/adr/ADR-008-live-writer-fencing-and-heartbeat-health-lease.md),
[ADR-011](../../docs/adr/ADR-011-one-live-owner-per-market-policy.md)

---

## 1. What lives where

| Path | Contents |
| --- | --- |
| `db/migrations/**` | Plain SQL, one forward and one rollback file per version |
| `src/migrations` | The migration loader and runner |
| `src/schema` | Kysely typed table definitions for every table |
| `src/repositories` | Typed repositories for the shared records |
| `src/testing` | Testcontainers helpers and fixtures (dev-only) |
| `test/integration/postgres` | The integration suite (owned by this package's work) |

## 2. Commands

Root scripts are wired by the orchestrator at merge. Until then:

```bash
# Apply every pending migration (reads DATABASE_URL)
pnpm --filter @polymarket-bot/storage-postgres db:migrate

# Show applied/pending state
pnpm --filter @polymarket-bot/storage-postgres db:migrate -- --status

# Roll back (default one step)
pnpm --filter @polymarket-bot/storage-postgres db:migrate -- --down --steps=1
pnpm --filter @polymarket-bot/storage-postgres db:migrate -- --down --all

# Integration suite (requires Docker; starts one throwaway PostgreSQL)
pnpm --filter @polymarket-bot/storage-postgres test:integration
```

`db:migrate` compiles to `dist/` first: Node's type stripping cannot resolve the
`.js` specifiers that `NodeNext` requires, so the CLI is built rather than run
from source.

## 3. The migration mechanism, and why it is plain SQL

Every §10.7 constraint is DDL — domains, partial unique indexes, constraint
triggers, deferred constraint triggers. A migration DSL would either fail to
express them or would carry them as embedded SQL strings, adding a dependency
that buys nothing and making the constraints harder to review. Kysely ships a
migrator, but its migrations are TypeScript modules that must be compiled before
they run, which would make `db:migrate` depend on a build of the very package
that owns the schema.

Runner properties:

- **One writer.** A session advisory lock serializes concurrent runners.
- **Atomic per migration.** Each migration and its bookkeeping row share one
  transaction.
- **Applied migrations are immutable, in both directions.** The SHA-256 of the
  forward SQL *and* of its rollback are recorded when it is applied, and both are
  re-checked: forward before applying anything, rollback before rolling anything
  back. Editing an applied migration is an error, not something to reconcile —
  and an edited `.down.sql` is exactly how a "clean" rollback stops being clean.
- **Rollback is symmetric.** `migrateDown` runs the recorded rollbacks newest
  first. A full rollback leaves only `migrations.schema_migrations`.

## 4. Schemas

The six semantic schemas of §10 (`catalog`, `data`, `strategy`, `execution`,
`accounting`, `ops`), plus two infrastructure schemas that hold no business
records:

- `internal` — shared domains, enumerations, and trigger functions.
- `migrations` — the runner's bookkeeping table.

## 5. Economic values are text, not `numeric`

Prices, sizes, fees, balances, and PnL are stored as TEXT in the canonical
decimal grammar of §7.3, behind PostgreSQL domains that reject every other
spelling (`internal.decimal_string`, `internal.non_negative_decimal_string`,
`internal.positive_decimal_string`, `internal.price_string`).

`numeric` was rejected for storage because it accepts `1.50` and `1.5` as two
spellings of one value and returns whichever scale it stored — which would break
the "one value has exactly one representation" property that equality, unique
constraints, and canonical hashes depend on (`docs/contracts/domain.md` §3.2).

Constraint triggers still aggregate in `numeric` (`amount::numeric`), which is
arbitrary-precision decimal. No value passes through a floating-point type
anywhere in this package, and no repository signature accepts or returns a
JavaScript `number` for an economic field.

The same rule applies **inside** `jsonb` documents. A signed order, an intent,
an order event, and a strategy parameter set all carry economic values in the
document rather than in a column, so those inputs are typed
`DecimalSafeJsonInput` (no `number` at any depth) and are deep-checked at the
repository boundary by `assertDecimalSafeJson()` — including when the document
arrives pre-serialized, because `JSON.stringify` must not be a way around the
rule. Two kinds of payload are deliberately exempt and say why in `src/json.ts`:
`params_schema` (a JSON Schema, where `maximum` is a keyword), and
`response_payload` / `rate_limit_snapshots.headers` (verbatim venue evidence,
never read as economic truth).

`decisions.model_outputs` used to be exempt as "model scores, not money"; it is
not. §7.5 and ADR-005 type a model output as
`DecimalString | string | boolean | null`, an edge or a probability is what
sizing and the risk thresholds are computed from, and the database rejects a
JSON number there as well (`decisions_model_outputs_decimal_safe`, built on
`internal.jsonb_contains_number()`).

Timestamps cross the boundary as ISO-8601 strings, never as `Date`: connections
run with `TimeZone=UTC` and `DateStyle=ISO`, and `src/timestamps.ts` converts
exactly, throwing rather than guessing if a session was configured otherwise.

## 6. How each §10.7 constraint is enforced

| §10.7 requirement | Mechanism |
| --- | --- |
| UUIDv7 or equivalent sortable ids | `internal.uuid_v7` domain on every internal primary key, checking **both** the version and the variant nibble; `internal.uuid_generate_v7()` server-side default; `uuidV7()` client-side |
| `orders(venue_order_id)` unique where not null, scoped by environment/account | partial unique index `orders_venue_order_id_unique (environment, account_ref, venue_order_id) NULLS NOT DISTINCT` |
| fills unique on `(venue_trade_id, venue_order_id, allocation discriminator)` | `fills_venue_identity_unique … NULLS NOT DISTINCT`, additionally scoped by environment/account (§10.8) |
| `submission_attempts(expected_order_hash)` unique where known | partial unique index `submission_attempts_expected_order_hash_unique` |
| Immutable strategy configs and market rule versions | append-only triggers on `strategy.configs` and `catalog.market_rule_versions` |
| Append-only event and ledger tables | `internal.forbid_update_delete()` on UPDATE, DELETE, and TRUNCATE; `internal.forbid_truncate()` on the mutable projections whose rows other invariants depend on |
| Every live order references a valid fencing token | CHECK + composite foreign key to `(lease, token)` + `internal.assert_valid_fencing_reference()`, which reads the lease **under a row lock** and judges expiry by the **database clock** — plus composite foreign keys binding the order's `environment`/`account_ref` to its plan, so the discriminator the CHECK reads cannot disagree with the authorizing chain |
| Fill allocation sum equals fill quantity | immediate trigger (never exceed) + deferred constraint trigger (equal at COMMIT) |
| Ledger transaction balances to zero per asset | deferred constraint trigger on both `ledger_transactions` and `ledger_entries` |
| No negative available balance | `GENERATED ALWAYS` `available_amount` + `balance_projection_no_negative_available` CHECK, with `reserved_amount` recomputed from `inventory_reservations` by trigger and **validated on every write** by `accounting.assert_reserved_amount_matches_reservations()` (`PMB08`); the row's key (`account_ref`, `environment`, `asset_id`) is immutable (`balance_projection_immutable_key`, `PMB02`), so a balance cannot be moved to a key with no reservations instead of being rewritten |
| One active live owner per market | partial unique index `market_ownership_one_active_live_owner` keyed by `(market_id, internal.execution_realm(environment))`, with `environment` bound to the owning instance by composite foreign key |
| Exactly one fenced live writer per account (§2, ADR-008) | partial unique index `fencing_leases_one_active_holder (account_ref, internal.execution_realm(environment))`, plus `fencing_leases_real_modes_only` so no simulated run mode can hold a live lease at all |
| A fencing token is never reused (ADR-008 §1) | monotonicity is checked against `ops.fencing_token_high_water`, which only ever increases per `(account_ref, execution_realm)` and may not be lowered, deleted, or truncated — so erasing lease rows cannot re-open a token; the lease state machine is forward-only (`fencing_leases_forward_only`, `PMB10`), so a released, revoked, or expired lease cannot be reactivated with its old token; and `ops.fencing_leases` rejects DELETE and TRUNCATE outright |
| A fill belongs to the account of the order it fills | composite foreign key on a **never-NULL** generated `account_key` (`coalesce(account_ref, '')`) on both sides, so a NULL child account cannot skip the binding the way MATCH SIMPLE allowed |
| A ledger transaction agrees with what it books | composite foreign keys binding `environment` and `account_ref` to the referenced order, fill, wallet operation, and reconciliation run, `market_id` to the referenced order and fill, plus `(fill_id, order_id)`; scoped to rows that reference one, so external clearing, manual adjustments, and resolutions still stand alone |
| A ledger transaction that books an order or a fill names its market | `ledger_transactions_execution_link_has_market` CHECK, which is what makes the MATCH SIMPLE market keys above unskippable: `market_id` is nullable, so an execution-linked transaction could otherwise omit it, skip the binding, and disappear from every market-scoped ledger query while still balancing and still being append-only. Orders and fills both carry a NOT NULL `market_id`, so the value is never unknown; the repository input type requires it at compile time for the same shapes |
| A ledger transaction that books a market-bearing wallet operation names *that* market | `accounting.assert_ledger_wallet_operation_market()` (`PMB12`), a NOT DEFERRABLE constraint trigger that reads the operation **under a row lock** and requires `market_id` to equal the operation's whenever the operation has one. A composite key cannot express this: MATCH SIMPLE skips a NULL child market (the round-3 defect, one column across), MATCH FULL would forbid booking a marketless operation at all, and any key would additionally forbid a transaction from naming a market the operation merely did not record. The operation's own `market_id` is immutable, which is what keeps the check true after the append-only transaction is committed. An operation that genuinely has no market (`APPROVE_ERC20`, `APPROVE_ERC1155`, a collateral `TRANSFER`) constrains nothing; `ops.reconciliation_runs` has no market column at all, so that link needs no analogue |
| Decision → plan → attempt → order → fill (§9.11) | `orders_submission_requires_attempt` (an order that reaches a submitted state, carries a venue identity, a submission timestamp, or any fill names the attempt that signed it). The exempt states are `PLANNED` and the three terminal states an order reaches by being abandoned before transmission — **not** `SIGNED`: §9.11 creates the attempt at step 1, signs at step 2, persists the signed payload at step 3, and commits `SIGNED` only at step 4, so the attempt necessarily exists first. Supported by `execution.assert_fill_order_has_submission_attempt()` (`PMB11`) on the fill side, and `orders_submission_attempt_attach_only` (`PMB02`), which lets an attempt be attached once and never detached |

### 6.0 The environment discriminator is derived, never declared

`environment` and `account_ref` appear on many tables, and on none of them are
they an independent value a caller supplies. They are bound down the chain by
composite foreign keys:

```
instances(instance_id, environment)
  ← runs        ← plans ← orders, submission_attempts ← fills
instances(instance_id, account_ref)
  ← plans       ← orders, submission_attempts ← fills
```

The reason is specific rather than tidiness. The constraints that matter read a
row's own discriminator: the live-order fencing CHECK asks "is this order in a
real-order run mode", and the one-live-owner index is keyed by the realm of the
ownership row. A caller that could write `PAPER` on a row belonging to a `LIVE`
plan or a `LIVE` instance could therefore submit a live order with no fencing
token, or take a second live ownership of one market, without violating a single
constraint. The repositories read the value from the parent in the same
statement that writes the child, and the foreign keys make the same thing true
for every other writer.

### 6.1 Append-only: triggers, not privileges

Enforcement is by trigger because a privilege grant binds only non-owner roles.
Migrations run as the table owner, and a superuser is unconstrained either way, so
`REVOKE UPDATE, DELETE` would leave the exact writer that matters unconstrained.
A `BEFORE UPDATE OR DELETE` trigger rejects the statement for every role.

Revoking write privileges from a least-privilege application role is a
complementary deployment control and is recommended:

```sql
-- Deployment-time hardening, not a substitute for the triggers.
revoke update, delete on all tables in schema execution, accounting, ops from <app_role>;
grant insert, select on all tables in schema execution, accounting, ops to <app_role>;
grant update on
  execution.orders, execution.submission_attempts,
  accounting.balance_projection, accounting.inventory_reservations,
  accounting.actual_position_projection, accounting.virtual_position_projection,
  accounting.pnl_snapshots, accounting.wallet_operations,
  catalog.markets, catalog.series, catalog.settlement_specs,
  catalog.reference_instruments, data.raw_segments, data.data_quality_incidents,
  strategy.instances, strategy.runs, strategy.market_ownership,
  ops.fencing_leases, ops.incidents, ops.reconciliation_runs,
  ops.reconciliation_breaks
to <app_role>;
```

Role creation is a deployment concern and is deliberately not in a migration:
roles are cluster-global, so creating them here would make one database's
migration mutate state shared with every other database on the server.

### 6.2 Enforced in the repository layer, not in the database

Two §10.7-adjacent properties could not be expressed as a database constraint:

- **A monotonic fencing token is allocated without a gap-free sequence.** The
  monotonicity itself *is* a database constraint (`ops.assert_fencing_token_monotonic`
  rejects any token that is not above every token ever issued for the account and
  execution realm). What the database cannot do alone is *choose* the next token;
  `acquireLease` reads the high-water mark under a transaction-scoped advisory
  lock. Without the lock two acquirers would read the same mark and one would be
  rejected by the trigger — correct, but as a constraint violation rather than a
  wait.
- **A `jsonb` document's interior.** The document is already a JavaScript value
  by the time it reaches this boundary, so `{"price": 0.42}` has been a double
  since before the statement existed, and `assertDecimalSafeJson()` rejects it
  where it can still be attributed to the caller that produced it. That is why
  the guard is here and not only in the database — but where the vocabulary is
  narrow enough to state in SQL, it is *also* a constraint:
  `internal.jsonb_contains_number()` rejects a JSON number anywhere inside
  `strategy.decisions.model_outputs` for every writer.

Everything else in §10.7 is a database constraint, and each is tested against a
writer that does **not** go through this package's repositories
(`test/integration/postgres/authority-bypass.test.ts` for the round-1 findings,
`authority-bypass-round2.test.ts`, `-round3`, and `-round4` for the later ones —
every sequence in all four was reproduced against the reviewed schema before it
was closed).

### 6.3 Which account column is the position, and which is the label

`accounting.ledger_transactions.account_ref` and
`accounting.ledger_entries.account_ref` are different facts and are not bound to
each other:

- the **header** account is the initiating scope — whose action produced this
  event — and is what the composite keys bind to the order, fill, wallet
  operation, or reconciliation run it books;
- the **entry** account is where value actually moved, one per leg. A transfer
  between two accounts is one transaction with legs in two of them, which is why
  the legs are deliberately unbound to the header.

So anything reading a position, a balance, or a net movement reads the *entry*
account. `netByAsset()` does; it used to filter the header, which returned every
leg of a transfer the queried account initiated — netting `A -10, B +10` to zero
for `A` and returning nothing for `B`. The per-asset balance check
(`accounting.assert_ledger_transaction_balanced()`) is per transaction and per
asset, deliberately not per account: a transfer balances across the two accounts,
not within either.

## 7. Environment separation (§10.8)

One semantic model. Every environment-scoped row carries an `environment`
discriminator over the six §11 run modes, and `internal.execution_realm()`
groups them: `EXECUTION_PROBE`, `LIVE_MICRO`, and `LIVE` share the `REAL` realm,
while `BACKTEST`, `PAPER`, and `SHADOW` each get their own. That is what lets a
shadow instance own a market the live instance also owns without either blocking
the other, while a `LIVE` and a `LIVE_MICRO` owner of one market still collide.

Separating live operational storage from large backtest output is a deployment
decision (a different connection or database), never a different model.

The realm is also what scopes live authority. One ACTIVE fencing lease per
account per **realm** (not per run mode), because `EXECUTION_PROBE`,
`LIVE_MICRO`, and `LIVE` submit real orders with the same venue credentials and
the venue cannot tell two of our processes apart (ADR-008 §4); and no fencing
lease at all in a simulated run mode, because "paper mode cannot acquire a live
fencing lease" (ADR-008 §2, ADR-010). Fencing tokens are monotonic across the
realm too, so a `LIVE_MICRO` takeover of an account a `LIVE` process was fencing
continues one sequence rather than starting a parallel one.

## 8. Safety

This package holds no credential, contacts no venue, and enables no run mode.
`internal.run_mode` is a discriminator column, not an enablement mechanism
(ADR-010). The integration suite's only credentials are the throwaway ones
Testcontainers generates for a container that lives for the duration of the run.
