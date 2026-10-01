# `apps/control-api` — control API and paper dashboards (`WP-240`)

The handoff §4.1 process that "owns authenticated operational controls and read
APIs" and **"never has the signing key"**.

**PAPER only.** There is no venue connection, no order path, no wallet
operation, and no signer. §11's run-mode ceiling is a startup value read from
the environment; **no route, body field or query parameter of this API names a
run mode**, so it cannot be raised through the control API — which is what §11
requires of it.

## What it does

| Route | Grant | What it is |
| --- | --- | --- |
| `GET /v1/run-state` | `READ` | the run mode, the process maximum, the repository ceiling, and the statement that none of them is writable here |
| `GET /v1/strategies` | `READ` | every strategy instance the control plane knows, with its run state |
| `GET /v1/kill-switch` | `READ` | every latched §14.1 kill switch |
| `GET /v1/health` | `READ` | the last trader health report that passed the door, verbatim |
| `GET /v1/metrics` | `READ` | Prometheus text exposition for the three dashboards |
| `POST /v1/strategies/:instanceId/pause` | `STRATEGY_CONTROL` | pause a **registered** instance |
| `POST /v1/strategies/:instanceId/resume` | `STRATEGY_CONTROL` | resume a **registered** instance |
| `POST /v1/kill-switch` | `KILL_SWITCH` | engage a §14.1 switch (scope × action) |
| `POST /v1/kill-switch/release` | `KILL_SWITCH` | release one, **against evidence** |

Every mutating route takes a `reason`, because §14.1 requires one in the audit
record and a reason the API could invent would be a reason nobody gave.

**This table is the router's own** (`CONTROL-1`). `api.ts` dispatches through
`CONTROL_API_ROUTE_TABLE` and nothing else, `CONTROL_API_ROUTES` is derived
from it, and `example-config-and-startup.test.ts` checks the rows above against
it, method, path and grant. A known path under the wrong method is
`405 CONTROL_METHOD_NOT_ALLOWED` with an `Allow` header; an unknown path is
`404 CONTROL_NO_SUCH_ROUTE`.

### Unknown instances are refused (`CONTROL-1`, `WP-240` r1 M-1)

A pause or resume of an instance the control plane has not registered is
refused `409 CONTROL_UNKNOWN_INSTANCE` and audited as a refusal, the way a
release of a switch nobody engaged is refused `409 CONTROL_NOT_ENGAGED`.
**The shipped process registers no instance**, because no seam reaches a
running trader's strategies yet (see "the composition obligation" below):
answering `200 PAUSED` for an instance this process cannot control would let an
operator read a halt that never took effect. `ControlPlane.register` remains the
composition seam for the future wiring that knows the trader's instance set.

### What a request must look like (`CONTROL-1`)

- **The `:instanceId` parameter** is percent-decoded through a total door
  (`instance-id.ts`): a malformed escape is `400
  CONTROL_INVALID_ROUTE_PARAMETER`, never a 500. The DECODED id must be 1-256
  characters, with no `/` (so `%2F` cannot smuggle one in) and no control
  character.
- **A request body must be declared** `Content-Type: application/json`
  (optionally `charset=utf-8`), or it is refused `415
  CONTROL_UNSUPPORTED_MEDIA_TYPE` before it is parsed. A body-less request needs
  no content type.
- **The server's timeouts are explicit** (`CONTROL_HTTP_TIMEOUTS` in
  `http.ts`): 10 s for the headers, 30 s for the whole request, 5 s keep-alive,
  checked every second. Node's defaults are not relied on.

## The three acceptance criteria, and where each is enforced

### 1. "Control API cannot raise mode above process maximum."

Two halves, and the first is the strong one:

- **Unrepresentable.** There is no request that expresses it. Every body is a
  closed object (`z.strictObject`) and none of them has a run-mode field.
  `GET /v1/run-state` is the only route that mentions a mode at all, and it
  reads.
- **Refused by name, and audited.** A body naming `runMode`, `maxRunMode`,
  `allowRealOrders`, either live-micro cap, `signer`, or any other key in
  `FORBIDDEN_CONTROL_KEYS` (at any depth) is refused `403
  CONTROL_MODE_RAISE_REFUSED` with a message that says why, and an increment of
  `control_mode_raise_attempts_refused_total`, for EVERY authenticated caller.
  When the caller holds a mutation grant (`STRATEGY_CONTROL` or `KILL_SWITCH`),
  the attempt is also an audit record (`MODE_RAISE_ATTEMPT` / `REFUSED`). When
  it holds none, it is counted and not audited; the refusal says so (see
  "The audit budget"). This is redundant with the closed grammar on purpose:
  the refusal SAYS something, and the attempt becomes evidence.
- **At startup**, `safety.ts` refuses a `MAX_RUN_MODE` above `PAPER` — it never
  clamps — and refuses a `RUN_MODE` that places real orders or needs a signer,
  reporting **every** reason rather than the first.

### 2. "Every mutation is audited."

The control plane **audits first and applies only on success**:

```text
compute prior state → compute resulting state → append the audit record
                                                       │
                                        refused ───────┴─────── ok
                                           │                     │
                                  the mutation does           apply
                                     NOT happen
```

So a full audit log (or a full tier of it, below), a reused record id, or an
unreachable durable sink each stop the mutation (`503 CONTROL_NOT_AUDITABLE`).
**The log refuses at its bound rather than evicting**: the records an eviction
would lose are the ones from the incident that filled it.

REFUSALS are audited too, for a caller with mutation authority: a refused
mutation is an operator fact. Three documented exceptions write nothing:

1. a request that never authenticated (counted on
   `control_authentication_failures_total`);
2. an authenticated request whose grants do not cover the route (counted on
   `control_authorization_failures_total`);
3. a mode-raise attempt from a caller that holds **no mutation grant** (counted
   on `control_mode_raise_attempts_refused_total`).

None of the three attempted a mutation at the plane. A caller who could append
the audit log's records without mutation authority could fill it, and a full
log refuses every mutation, the kill switch included (`WP-240` r1 M-3).

A refusal whose record the audit budget refuses is still a refusal: nothing
changed, and it is counted `control_mutations_total{outcome="NOT_AUDITED"}`.

## The audit budget (`CONTROL-1`, closing `WP-240` r1 M-3)

**The finding.** At `WP-240`, a READ-only operator could fill the audit log. The
forbidden-key refusal ran before authorization and audited every attempt. The
log refuses at its bound, and the control plane audits before it applies, so a
full log refused every mutation. That included the §14.1 kill switch: five
requests at capacity 3 did it. `CONTROL-1` reproduced it at base `98a814b`.

**The invariant this package now holds:**

> No request sequence from an actor without mutation authority can prevent an
> authorized actor's kill-switch engage, or any other safety-direction action,
> from being executed and audited.

Every mutation is still audited, and a mutation the sink cannot record is still
refused. The design has two layers.

1. **No audit footprint without mutation authority** (`api.ts`). An actor that
   holds no mutation grant writes **no** audit record, whatever it sends. Its
   mode-raise attempts are refused by name and counted, and the refusal says
   they were "counted and NOT audited" because the operator "holds no mutation
   grant". This layer alone carries the invariant: it holds with no reserve at
   all.
2. **A tiered budget over the one capacity** (`audit-budget.ts`,
   `SafetyReservedAuditSink`). With `auditCapacity` `C` and the required
   `auditSafetyReserve` `R` (`1 ≤ R`, `2R < C`):

   | Record | May fill the log up to |
   | --- | --- |
   | `KILL_SWITCH_ENGAGE` / `APPLIED` | `C` |
   | `STRATEGY_PAUSE` / `APPLIED` | `C − R` |
   | every other record: each refusal, resume and release | `C − 2R` |

   The tier is read from the record the control plane builds, never from a
   request. Consequences:
   - Nothing but an applied kill-switch engage can use the last `R` records.
     So even an operator holding `STRATEGY_CONTROL` (a mutation grant, but not
     the kill switch's) cannot disable the kill switch by filling the log.
   - Once the ordinary tier is full, a pause can take at most one reserved
     record per registered instance, and each one is a real halt.
   - **A full ordinary tier fails in the SAFE direction.** Resumes and releases
     are ordinary, so the platform can still be halted and cannot be un-halted
     until the log is rotated.

The pins:

- `test/integration/control-api/m3-audit-exhaustion.test.ts` is the
  reproduction, and it fails at base.
- `audit-budget-adversarial.test.ts` runs a seeded randomized adversary over
  every actor class, with acceptance 2 checked after every request.
- `shipped-root-control-1.test.ts` drives the shipped `main.ts`.
- `src/audit-budget.test.ts` pins the tiers.

**What the budget does not do.** It bounds records, not bytes: a mutation-
authorized caller's mode-raise record carries its request path and the
forbidden keys it named, and both are bounded only by the transport
(`maxRequestBodyBytes`, Node's header limit). It does not make the in-memory
log durable. Neither has changed in this round; both are follow-ups in the
`CONTROL-1` handoff.

Durable home: `WP-040`'s §10.6 `ops.kill_switch_events` (engage/release) and
`ops.config_change_audit` (strategy control, refusals, mode-raise attempts).
That binding is **typecheck-pinned only** — see "no database was reached" below.

### 3. "No signer is loaded."

Nothing in this package or in `packages/observability/src/control` imports,
references or configures a signer, a wallet, a private key or the secure venue
adapter. `test/integration/control-api/acceptance-3-no-signer.test.ts` asserts
that by scanning the shipped source of both trees, and additionally asserts that
`packages/polymarket-secure` is absent from this package's dependency manifest.

## Authentication (§15) — the INTERPRETATION

§15 says only: "Control API uses authentication and explicit authorization for
live-mode, kill-switch, config, and wallet-operation actions." It names no
credential mechanism. `auth.ts` states `WP-240`'s interpretation in full; the
short version:

- a **bearer operator token**, supplied as configuration, compared in constant
  time over SHA-256 digests, never logged, echoed or used as an identifier;
- **explicit grants** per operator, checked per route — authenticating grants
  nothing;
- of §15's four action classes, **kill-switch** and **config** are implemented;
  **live-mode** and **wallet-operation** are *unrepresentable*, which is
  stronger than refused;
- **loopback binding** is what makes a bearer token over plain HTTP acceptable
  here. Exposing this API off-host would need a TLS terminator and a stronger
  credential mechanism, and is out of scope.

## The composition obligation (read this before believing a blank dashboard)

**`apps/trader` does not expose an HTTP health endpoint today.** Its health
state is an in-process value, and `apps/trader/**` is outside `WP-240`'s grant.
What ships here is the consumer half:

- `InMemoryTraderHealthSource` — over a document a composition already holds;
- `HttpTraderHealthSource` — a loopback `GET`, genuinely exercised against a
  real in-process `node:http` server (request, size bound, timeout, non-200,
  malformed body). **No claim is made that a trader is on the other end.**

Until a trader serves that document — AND a composition wires a refresh
(`main.ts` constructs the `TraderHealthCache` but nothing in the shipped
process calls `refresh()`; no poller exists yet — both halves are owed by the
same future wiring) — `control_trader_health_available` reads `0` and the
operations dashboard's first stat panel says so.

Likewise, engaging a kill switch here changes **this process's** authoritative
record and writes the §10.6 audit row. Whether a running trader observes it
depends on a seam that does not exist in this repository yet
(`apps/trader`'s `HaltController` is in-process, and its `release` demands the
same `authoritativeSnapshotApplied: true` evidence this API demands). That
wiring is a documented composition obligation, not something this package
claims.

## No database was reached (disclosed)

Docker is absent from the environment this package was built in, exactly as
`WP-210` and `WP-230` recorded. `src/adapters/postgres-audit-sink.ts` is
**typecheck-pinned only**: its table and column names come from
`packages/storage-postgres`'s shipped types, so a rename upstream fails
`pnpm typecheck` — but nothing in it has been executed against a live database
and no integration evidence is claimed for it. Acceptance 2's evidence is at the
port, against the real control plane and the real append-only log.

## Configuration

`CONTROL_API_CONFIG` names a JSON file. There is no default configuration: a
bind host, an audit bound and an operator set are decisions, not values this
process may choose for a deployment. `control-api.config.example.json` is a
complete, valid example — it parses through the real door in the integration
suite, so it cannot rot.

Every field is required. `bindHost` must be `127.0.0.1`, `::1` or `localhost`
(§15: "No public network exposure for … internal metrics endpoints").
`auditSafetyReserve` (`CONTROL-1`) must be at least 1, and twice it must be
below `auditCapacity` (see "The audit budget"). A configuration written before
`CONTROL-1` lacks it and is refused at startup, naming the field.

The example's token is a placeholder that says so in its own text. **Replace it
before any real use**, and note that this repository's paper posture means there
is nothing behind this API worth stealing: it cannot place an order, move a
wallet, or raise a mode.

## Running it

```sh
CONTROL_API_CONFIG=apps/control-api/control-api.config.example.json \
  pnpm --filter @polymarket-bot/control-api start
```

`start` typechecks, builds an app-local esbuild bundle (ADR-018), and runs it.
`node dist/main.mjs --check` validates the environment and configuration and
exits without binding anything.

## Safety defaults (`AGENTS.md`, ADR-010 §1)

```text
MAX_RUN_MODE=PAPER
ALLOW_REAL_ORDERS=false
LIVE_MICRO_MAX_ORDER_NOTIONAL=0
LIVE_MICRO_MAX_ACCOUNT_EXPOSURE=0
```

`safety.ts` enforces all four: an absent value is read as the safe one, and any
weakened value REFUSES the process at startup — before a configuration file is
opened or a socket bound.

## Dashboards

`infra/grafana/control/` — operations, trading, fidelity. Their README states
the metric→producer map and the four panels that ship PENDING with a named
owner.
