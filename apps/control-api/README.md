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
| `GET /v1/health` | `READ` | the last trader health report that passed the door, verbatim, and the open trader halts in `ops.incidents` (`CONTROL-2`) |
| `GET /v1/metrics` | `READ` | Prometheus text exposition for the three dashboards |
| `POST /v1/strategies/:instanceId/pause` | `STRATEGY_CONTROL` | pause a **registered** instance |
| `POST /v1/strategies/:instanceId/resume` | `STRATEGY_CONTROL` | resume a **registered** instance |
| `POST /v1/kill-switch` | `KILL_SWITCH` | engage a §14.1 switch (scope × action) |
| `POST /v1/kill-switch/release` | `KILL_SWITCH` | release one, **against evidence** |

Every mutating route takes a `reason`, because §14.1 requires one in the audit
record and a reason the API could invent would be a reason nobody gave.

**In the shipped PAPER process the four `POST` routes answer `501
CONTROL_NOT_WIRED`** (`C1-OPS`). No trader reads this process's controls (see
"the composition obligation" below), so an engage answered `200` would report
a halt nobody observes. The refusal comes after authentication, the
mode-raise refusal and authorization, and it is audited like any other refused
mutation. Stop a PAPER trader with Ctrl-C or SIGTERM
([`docs/runbooks/paper-operations.md`](../../docs/runbooks/paper-operations.md)).
`ControlApiOptions.mutationsReachTrader` is required: `main.ts` passes `false`,
and the test harnesses pass `true` so the control plane below stays measured.

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
(Since `C1-OPS` the shipped process answers `501 CONTROL_NOT_WIRED` before a
pause reaches the plane; the `409` is what a composition with
`mutationsReachTrader: true` and no registered instance answers.)

### What a request must look like (`CONTROL-1`)

- **The `:instanceId` parameter** is percent-decoded through a total door
  (`instance-id.ts`): a malformed escape is `400
  CONTROL_INVALID_ROUTE_PARAMETER`, never a 500. The DECODED id must be 1-256
  characters, with no `/` (so `%2F` cannot smuggle one in) and no control
  character.
- **A request body must be declared** `Content-Type: application/json`
  (optionally `charset=utf-8`), or it is refused `415
  CONTROL_UNSUPPORTED_MEDIA_TYPE` and never acted on. A body-less request needs
  no content type. Like the `413` (too large) and the `400` (not JSON), the
  `415` is DECIDED by the transport but ANSWERED by the API, after
  authentication and the route's authorization (`CONTROL-1` r1): an anonymous
  caller gets `401` whatever its body, and an authorized operator's refusal on
  a mutating route is audited (see "2. Every mutation is audited"). An
  undeclared body that parses as JSON is still read for one purpose — the
  by-name refusal of a forbidden key below.
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
  `control_mode_raise_attempts_refused_total`, for EVERY authenticated caller —
  whatever content type the body declared, as long as it parses as JSON.
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
mutation is an operator fact. **Every refusal of a request an authenticated
operator was authorized to send to a mutating route is audited**, wherever it
happens (`CONTROL-1` r1, closing `CONTROL1-J-M2`) — **save ONE, the gated
refusal, item 7 of the list below** (`CONTROL-1b` r2, closing
`CONTROL1B-R2-J-L1`):

- at the transport: `413` too large, `415` undeclared, `400` not JSON;
- at the route parameter: `400 CONTROL_INVALID_ROUTE_PARAMETER`, recorded with
  NO `scopeRef` (an id that failed its door is never written as one);
- at the body door: `400 CONTROL_REQUEST_INVALID` / `CONTROL_REQUEST_NOT_DATA`
  — including a release with `authoritativeSnapshotApplied: false` or without
  it, whose record's `refusalIssues` name the field;
- at the control plane: `409`, and a `503 CONTROL_NOT_AUDITABLE` whose
  record the sink or the audit budget refused or did not confirm in time — the
  record offered IS the audit, and nothing lands (below).

Each is one `REFUSED` record for the route's action, in the audit budget's
ORDINARY tier, carrying the refusal code, its detail and at most eight issues
of at most 256 characters, and nothing the caller spelled beyond them. Since
`CONTROL-1b` the 256 is measured on the STORED, escaped text and the cut falls
only between code points, and a mutation-grant holder's mode-raise record is
bounded the same way (below).

What writes NOTHING, exhaustively:

1. a request that never authenticated (`401`; counted on
   `control_authentication_failures_total`);
2. a request the router does not serve (`404`, `405`): authorization is per
   route, and there is no route;
3. an authenticated request whose grants do not cover the route (`403
   CONTROL_UNAUTHORIZED`; counted on `control_authorization_failures_total`);
4. a mode-raise attempt from a caller that holds **no mutation grant** (counted
   on `control_mode_raise_attempts_refused_total`);
5. a transport refusal (`413`/`415`/`400`) on a READ route: a read is never
   audited, accepted or refused;
6. a request the HTTP server refuses before any handler runs: Node's own `408`
   (the timeouts above) or `400` for a malformed HTTP message, and a client
   that disconnects before its body arrives;
7. **the GATED refusal** (`CONTROL-1b` r1; named here at r2, closing
   `CONTROL1B-R2-J-L1`): a strengthening engage of a kill switch, or a halting
   pause of an instance, while an earlier such append of the SAME switch or
   instance is still unsettled ("An append is bounded", below). It is refused
   `503 CONTROL_NOT_AUDITABLE` WITHOUT offering any record to the sink: a
   record per retry would queue behind the append the sink has not answered and
   take a budget slot each, which is the reserve exhaustion this gate exists to
   prevent. It is counted `control_mutations_total{outcome="NOT_AUDITED"}` and
   is NOT an audit-append failure (none was attempted); its `503` detail says
   it was refused without an append.

A mutation-grant holder's mode-raise attempt is the one thing audited before
routing: it is recorded whatever route it named, so items 2 and 5 never apply
to it. None of items 1–6 attempted a mutation an authorized operator could
make. Item 7 did, and is refused because an earlier attempt's record may still
land; the operator retries once the sink answers. A caller
who could append the audit log's records without mutation authority could fill
it, and a full log refuses every mutation, the kill switch included (`WP-240`
r1 M-3).

A refusal whose record the audit budget refuses is still a refusal: nothing
changed, the caller gets the same answer, and it is counted
`control_mutations_total{outcome="NOT_AUDITED"}`.

### An append is bounded (`CONTROL-1b`)

With a durable sink, an append that never settled used to hold its instance's
or switch's lock for ever, queueing every later mutation of it — the kill
switch included. Each append is now raced against a bound,
`ControlPlaneOptions.auditAppendTimeoutMs` (default `AUDIT_APPEND_TIMEOUT_MS`,
5 s; 1 ms to 60 s):

- **The bound expires first.** The record is UNCONFIRMED and treated as
  unwritten: the mutation is refused `503 CONTROL_NOT_AUDITABLE`, its state is
  unmoved, it is counted `NOT_AUDITED`, and its lock is released. A refusal
  whose record times out still stands with its own answer; a mode-raise
  attempt's `403` then says its record was "NOT confirmed … and may still
  land" rather than claiming either outcome.
- **The sink answers later.** Nothing is ever applied late. A late failure
  leaves the audit true (nothing landed); a late REFUSED record is a true
  record of a refusal. A late APPLIED record would say a change happened that
  did not, so the control plane appends a **void record** beside it:
  `REFUSED`, the same action and target, actor `control-api` (`AUTOMATED`), the
  voided record's prior state unchanged, and `voidsRecordId` naming it — when
  the sink and the audit budget admit it. **A void is not guaranteed:** it is
  an ORDINARY record, so a full ordinary tier refuses it, as does a sink that
  is still failing, and a composition with no record source writes none. Both
  are counted — `control_mutations_total{outcome="LANDED_LATE"}` and
  `{outcome="VOIDED"}` — so an APPLIED record with no void beside it is
  visible as their difference. A durable reader joins on `voidsRecordId`: the
  late row is in `ops.kill_switch_events` (or `ops.config_change_audit`), its
  void in `ops.config_change_audit`. A late record can also land AFTER a later
  record of the same switch, so log order is not apply order; the void
  resolves which records took effect.
- **The budget sits behind the race.** A timed-out append keeps its budget slot
  until the sink settles it, so the budget never admits more than its capacity.
  A timed-out ORDINARY append occupies only the ordinary tier and cannot reach
  the reserve. A timed-out PROTECTED append — a strengthening engage (the
  kill-switch reserve) or a halting pause (the safety-direction tier) — holds a
  protected slot while in flight and, if it lands, spends that record for good
  although nothing was applied. That is NOT what a real halt costs: a real halt
  engages the switch, so its retry is an ordinary `409 CONTROL_ALREADY_IN_STATE`;
  a halt that timed out leaves the switch as it was, so its retry is again a
  strengthening engage. An append whose sink never answers keeps its slot for
  the life of the process (`ControlPlane.unsettledAuditAppends` counts them).
- **One unsettled protected append per switch or instance** (`CONTROL-1b` r1,
  closing `CONTROL1B-R1-J-M1`). At round 0 every retry of a timed-out halt took
  another protected slot: retrying one GLOBAL `FULL_HALT` through a stall
  (capacity 10, reserve 2, six ordinary records) left four late APPLIED
  records and no void, no switch engaged, and every further halt `503`. Now,
  while a protected append of a switch or instance is unsettled, a new
  protected mutation of the SAME switch or instance is refused
  `503 CONTROL_NOT_AUDITABLE` **without an append** — it takes no budget slot,
  is counted `NOT_AUDITED`, and is not an audit-append failure, since none was
  attempted. The gate lifts as soon as the sink answers the earlier append,
  whatever it answers. Exactly:
  - per switch or instance, at most ONE timed-out protected append is in
    flight. Retries sent while it is unsettled cost nothing; each timed-out
    protected append that later LANDS costs one protected record. So a stall
    the sink answers late costs one record per switch (or instance) whose
    append timed out, however often it was retried — on top of the record the
    real engage or pause spends once the sink answers in time. A sink that
    answers late EVERY time costs one record per late answer, one at a time;
  - a mutation that writes an ORDINARY record — a release, a resume, a
    refusal, a change between two unordered actions — is never gated, and
    other switches and instances are not affected;
  - **the price:** an append the sink NEVER answers keeps that one switch's
    strengthening engages (or that instance's pauses) refused for the life of
    the process, as it keeps that append's slot — including an ESCALATION: a
    never-settling GLOBAL `HALT_NEW_ENTRIES` append keeps GLOBAL `FULL_HALT`
    refused (`CONTROL1B-R2-J-I1`), while other switches still apply. A durable
    sink must therefore settle every append — for PostgreSQL, a client-side
    statement or query timeout — before it is composed (`CONTROL-1b` handoff,
    follow-up);
  - a gated refusal writes NO record: it is write-nothing item 7 in "2. Every
    mutation is audited", above.

`main.ts`, the test harness and the integration client pass the API's clock and
id source as the void records' `auditRecordSource`, and `main.ts` says so at
startup ("audit append bound 5000ms; an APPLIED record that lands after it gets
a VOID record … when the sink and the audit budget admit one", pinned by
`shipped-root-control-1.test.ts`). The shipped in-memory
log answers at once, so neither path is reachable in the shipped process today;
a durable sink bound later inherits both.

### What an audit record's text can hold (`CONTROL-1b`)

Every record — mutation, refusal, mode-raise attempt or void — passes through
`audit-text.ts`'s `auditSafeRecord` before any sink sees it:

- NUL, lone surrogates and every control, format or line/paragraph separator
  code point (`\p{Cc}`, `\p{Cf}`, `\p{Cs}`, U+2028, U+2029) become a visible
  `\u{HEX}` escape — so a caller's bytes can never make a `jsonb` append fail,
  and `U+202E` or a terminal escape cannot make a record read as something it
  is not. The escape is INJECTIVE: a backslash typed before `u{` is itself
  written `\u{5C}`, so every record can be read back exactly.
- `actor` and `scopeRef` are cut to the `internal.identifier` domain (200) and
  `reason` to `internal.detail` (2000), measured after escaping, because escaping
  lengthens text; the state documents (unbounded `jsonb`) keep the whole value.
  Nothing an ordinary request carries is cut.

The in-memory log and PostgreSQL receive the same record object, so they hold
the same text. The STATE the control plane holds is not rewritten: the record
presents it.

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
   | `KILL_SWITCH_ENGAGE` / `APPLIED` that engages a switch where none was, or escalates one to `FULL_HALT` | `C` |
   | `STRATEGY_PAUSE` / `APPLIED` that moves an instance from `RUNNING` to `PAUSED` | `C − R` |
   | every other record: each refusal, resume and release, and an engage that changes a switch between two actions §14.1 does not order | `C − 2R` |

   The tier is read from the record the control plane builds — its action, its
   outcome and its prior and resulting states — never from a request. A
   protected tier is EARNED by the state change the record shows. Consequences:
   - Nothing but a STRENGTHENING engage can use the last `R` records. So even
     an operator holding `STRATEGY_CONTROL` (a mutation grant, but not the kill
     switch's) cannot disable the kill switch by filling the log — and a
     `KILL_SWITCH` holder cannot spend the reserve on no-ops either.
   - **An engage never repeats and never weakens** (`CONTROL-1` r1, closing
     `CONTROL1-J-M1`). An engage of the action already engaged at that scope is
     refused `409 CONTROL_ALREADY_IN_STATE`; one that would move a switch away
     from `FULL_HALT` is refused `409 CONTROL_ENGAGE_WOULD_WEAKEN` — relaxing a
     full halt is a release, and a release needs evidence. Both refusals are
     ordinary records. §14.1 orders none of its five actions; this package
     orders only `FULL_HALT` above the rest (`vocabulary.ts`,
     `STRONGEST_KILL_SWITCH_ACTION`), so a change between two of the other
     four is applied as it was at `WP-240`, but in the ordinary tier. Once the
     ordinary tier is full, one scope can therefore take at most TWO reserved
     records — an engage and an escalation — until a release, and a release is
     ordinary; plus, with a sink that can outlive the append bound, at most ONE
     more per engage that timed out and then landed (`CONTROL-1b` r1, "One
     unsettled protected append per switch or instance" above).
   - Once the ordinary tier is full, a pause can take at most one reserved
     record per registered instance that is a real halt — plus at most one per
     instance for each pause that timed out and then landed, which halted
     nothing (the same gate). That holds
     under concurrency: the control plane SERIALIZES the mutations of each
     instance and each switch (`CONTROL-1` r1, closing `CONTROL1-J-L2`), so two
     pauses sent at once are one `APPLIED` pause and one
     `CONTROL_ALREADY_IN_STATE`, whatever the audit sink's latency. Different
     instances and switches still proceed concurrently, so a slow append for
     one instance never queues a kill-switch engage behind it.
   - **A full ordinary tier fails in the SAFE direction.** Resumes, releases
     and unordered action changes are ordinary, and relaxing a `FULL_HALT` by
     engage is refused whatever the tier. So the platform can still be halted,
     a switch can still be escalated to `FULL_HALT`, and nothing can be
     released or relaxed until the log is rotated — **while the reserve has
     room**. A `KILL_SWITCH` holder's real halts at many distinct scopes can
     spend the reserve, and a further engage (a GLOBAL `FULL_HALT` included)
     is then `503` (`CONTROL1-R2-J-I1`). The invariant above concerns actors
     WITHOUT mutation authority, and it holds; no slot is held back for one
     final GLOBAL halt, which would be a policy change, not made here.

The pins:

- `test/integration/control-api/m3-audit-exhaustion.test.ts` is the
  reproduction, and it fails at base.
- `audit-budget-adversarial.test.ts` runs a seeded randomized adversary over
  every actor class, with acceptance 2 checked after every request — and,
  since `CONTROL-1` r1, a `KILL_SWITCH` holder's random engages and releases,
  with an independent check that only a strengthening sits in the reserved
  band.
- `engage-reserve.test.ts` is the verifiers' three `CONTROL1-J-M1` sequences,
  over HTTP; it fails at the round-0 commit. (Its shipped-root twin was
  replaced at `C1-OPS` by `src/main.not-wired.test.ts`: the shipped process
  applies no mutation.)
- `authorized-refusals-audited.test.ts` is `CONTROL1-J-M2`: every refusal of
  an authorized request is audited, and nothing else is — save the gated
  refusal, write-nothing item 7, which it pins as writing nothing
  (`CONTROL1B-R2-J-L1`).
- `shipped-root-control-1.test.ts` drives the shipped `main.ts`.
- `src/audit-budget.test.ts` pins the tiers; `src/control-plane.test.ts` pins
  the engage rules and the per-key serialization.

**What the budget does not do.** It bounds records, not bytes — but since
`CONTROL-1b` every record's caller-chosen content is bounded where it is
built. A mutation-authorized caller's mode-raise record keeps at most eight of
the forbidden keys it named (and `attemptedKeyCount` when there were more), and
a reason holding at most 128 characters of the path, cut to 256 overall; the
refusal records `CONTROL-1` r1 added keep the route's template, a refusal code
and detail, and at most eight issues of at most 256 characters. It does not
make the in-memory log durable: no composition binds the PostgreSQL sink yet.

Durable home: `WP-040`'s §10.6 `ops.kill_switch_events` (engage/release) and
`ops.config_change_audit` (strategy control, refusals, mode-raise attempts).
That binding is exercised against a real PostgreSQL by an opt-in suite, and is
bound by no composition — see "The PostgreSQL sink" below.

### 3. "No signer is loaded."

Nothing in this package or in `packages/observability/src/control` imports,
references or configures a signer, a wallet, a private key or the secure venue
adapter, and the package's manifest declares no dependency on
`packages/polymarket-secure`. Since `CONTROL-1b` r4 that property rests on two
AUTHORITATIVE checks, with a test-tree scan beside them as best-effort lint.
"Forbidden" means one place throughout
(`test/integration/control-api/support/forbidden-targets.ts`): the secure
adapter (`packages/polymarket-secure`), the venue SDKs and signing libraries
(`FORBIDDEN_PACKAGES`), the venue SDK's own `ox`, `@polymarket/bindings` and
`@polymarket/types` (`SDK_DEPENDENCY_PACKAGES`, matched exactly), and, since
`CONTROL-2`, the signing closure the SDK signs with: `@noble/curves`,
`@noble/hashes`, `@scure/bip32` and `@scure/bip39` (`SDK_SIGNING_PACKAGES`,
matched exactly).

**1. The shipped artifact (authoritative;
`test/integration/control-api/acceptance-3-shipped-artifact.test.ts`).**

- **The bundle.** This package ships as ONE esbuild bundle, `dist/main.mjs`,
  which `build` makes. The test runs that script's own esbuild invocation — the
  package's `esbuild`, the script's arguments, read in full (another command,
  shell syntax or a metafile of the script's own fails) — adding only
  `--metafile` and writing to a scratch directory, and reads the metafile,
  where every module the bundle holds is an input. No input may lie in the
  secure adapter or under a forbidden package's directory, judged on its path
  and its real path exactly as the run-time guard judges a landing. Every
  input must be this package's `src`, a workspace package it depends on, or a
  third-party package on an exact, justified list (`zod`, `decimal.js` and,
  since `CONTROL-2` r1, the PostgreSQL driver's fifteen: `kysely`, `pg`,
  `pg-cloudflare`, `pg-connection-string`, `pg-int8`, `pg-pool`,
  `pg-protocol`, `pg-types`, `pgpass`, `postgres-array`, `postgres-bytea`,
  `postgres-date`, `postgres-interval`, `split2` and `xtend`; a new one fails
  until it is judged there). Every import the bundle leaves external must be a
  STATIC import of a builtin that cannot load or run code.
- **The PostgreSQL driver (`CONTROL-2` r1).** The trader-halt read needs `pg`,
  which is CommonJS and `require()`s Node builtins — and an ES-module bundle
  can only leave such a require to a run-time loader (the first r1 build died
  at load: "Dynamic require of "events" is not supported"). So `build` aliases
  each builtin the driver requires (`crypto`, `dns`, `events`, `fs`, `net`,
  `path`, `stream`, `string_decoder`, `tls` and `util`, with `util/types`
  through `util`) to a one-line module under `src/driver-shims/` that
  re-exports it, and every such require resolves at BUILD time: the bundle
  holds no `require`, no `import()`, no `createRequire` and no dynamic-require
  helper. `dns`, `string_decoder`, `tls` and `util/types` are not on the
  builtin allowlist; each is admitted for its own shim only, and every shim is
  pinned byte for byte. `pg-native`, pg's optional native binding, is aliased
  to `src/driver-shims/pg-native.ts`, which throws when it is loaded: it never
  ships, pg's JavaScript client never loads it, and under
  `NODE_PG_FORCE_NATIVE=1` the bundle refuses to start. The driver's packages,
  builtins and shims are listed, each justified, in
  `test/integration/control-api/support/driver-shims.ts`; the forbidden
  vocabulary is unchanged.
  Positive controls build the same invocation with an entry that imports the
  secure adapter, directly and through a symbolic link, and each forbidden
  input is named.
- **The production source.** `apps/control-api/src/**`, its tests excluded,
  holds no dynamic-loading primitive at all
  (`test/integration/control-api/support/production-source-rule.ts`, read from
  TypeScript's syntax tree): no `import()` or `require()` but of a string
  literal; no specifier but a relative path that stays in `src`, a permitted
  builtin (`node:vm`, `node:module`, `node:child_process`,
  `node:worker_threads` and the rest are not), a declared dependency, or — in
  a driver shim, and there only — that shim's own builtin; no
  `createRequire`, `eval`, `Function` in a value position, `getBuiltinModule`,
  `constructor`, `getPrototypeOf` or `__proto__`, or Node's loader internals by
  name; `globalThis`, `global`, `process` and `module` only as the object of a
  non-computed property access — the same for one reached as a member of
  another, such as `globalThis.process` (`CONTROL-2`) — and no computed member
  of them but a read of `process.env[…]` or `process.argv[…]`. Each primitive
  is pinned by a plant that fails, in every code extension.
- **What this does not prove.** A deployment that runs anything but
  `dist/main.mjs` is not the shipped artifact. Third-party code in the bundle
  is judged by its package, not read: `zod` v4 compiles object-schema checks
  with `new Function` from the schemas' own shapes, never from a request.
  Workspace packages' source is reviewed code, and `check:deps` holds only
  part of it (`CONTROL-2`, correcting an overstatement): F6 (the venue SDK
  only in `packages/polymarket-secure`) and F16's relative half (no relative
  specifier leaving its package) judge every literal specifier in every
  workspace package, and F14 (no module load a static check cannot read) holds
  only the purity-restricted packages — of the workspace packages this bundle
  holds (`decimal`, `domain`, `observability`, `risk`, `storage-postgres`),
  `packages/domain` alone. A computed load in the other four is no
  `check:deps` finding. And
  the production-source rule is a rule over source text: a computed key on an
  ordinary value can still reach a function's constructor, and a member of a
  global object that is not itself one (`process.mainModule`) can still be
  aliased and indexed. Production source is reviewed code; the rule refuses
  every primitive it can name.

**2. The run-time guard (authoritative in every runner that executes
control-api code; `test/integration/control-api/support/no-signer-guard.ts`).**
It is installed in the repository's unit runner — `test/vitest.config.ts` runs
`apps/control-api/src/**/*.test.ts` and `test/unit/control-api/**/*.test.ts` in
a `control-api` project of their own, and every other test in a project
without it, so `packages/polymarket-secure`'s own tests still load the venue
SDK — and in both control-api integration runners (`test:integration` and
`test:integration:postgres`). Acceptance 3 holds each config to exactly the
guard's one plugin and one setup file, and the unit runner to exactly those two
projects. It refuses the LANDING: a file that lies in the secure adapter or
under a forbidden package's directory, on its path and its real path.

- a `module.registerHooks` `load` hook (the setup file) runs for every module
  loaded in the test worker's thread — through `require`, `createRequire`,
  `Module._load`, ESM `import` and `import()`, and code an evaluator built —
  after resolution, so a directory resolves to its entry and every manifest is
  followed before it judges; being a LOAD hook, it also refuses what a test's
  OWN resolution hook answered;
- a vite `load` hook (the plugin) refuses the same files when vitest's own
  module graph — `vi.importActual`, `__vite_ssr_dynamic_import__`, a test's
  imports — would load them.

`no-signer-runtime-guard.test.ts` pins both halves in each runner (in the unit
runner from `test/unit/control-api/`, and `src/no-signer-guard.test.ts` from
inside `src`), with loads written as the test-tree scan cannot read them: the
round-2 and round-3 routes, and the round-4 ones — a directory named like code,
nested manifests, a path in evaluated code text spelled in legacy octal or long
braced escapes or quoted five layers deep, and a load resolved against the
working directory. **What it does not see:** a copy or hard link of a forbidden
file at a path that names nothing forbidden (it judges where a file lies, not
what it holds); code read as text and evaluated, or handed to a load hook a
test registers itself; a module graph a test builds itself (its Node-loaded
dependencies are guarded); another thread or process (the hook is
thread-local); Node's loader internals that run no hook
(`Module._extensions[…]`); and a builtin reached through
`process.getBuiltinModule`, which resolves nothing.

**3. The test-tree scan (best-effort lint;
`test/integration/control-api/acceptance-3-no-signer.test.ts`,
`support/module-loads.ts`, `support/load-judge.ts`).** It reads every file of
this package's `src`, `packages/observability/src/control`, the control API's
test trees and `infra/grafana` from TypeScript's syntax tree, and fails on what
it can see:

- every load form — static and type-only imports, re-exports, `import x =
  require()`, `import()` types, dynamic `import()`, `require()` in its calling
  spellings, `process.getBuiltinModule()`, vitest's `vi.importActual()` /
  `importMock()` / `mock()` / `doMock()`, triple-slash and AMD references,
  JSDoc `@import`, `declare module` — read as the EVALUATED literal, so
  comments, whitespace and escapes in the literal resolve as the runtime
  resolves them; each file with its own extension's grammar;
- each specifier judged by where it lands: a path by the file it reaches
  (never the secure adapter, `node_modules` or a forbidden package; code or
  JSON only); a bare name by the package aliases and `node_modules` make of it,
  from an exact package-and-subpath list; a builtin from an allowlist of
  modules that cannot load or run code;
- every other literal judged by what it names, and a literal path by where a
  loader handed it would land;
- a computed specifier, a named loader or evaluator, a file that does not
  parse, a load of a file that does not exist when the scan runs — each fails
  unless an exact, justified allowlist entry covers it;
- the runners' configs held to a closed world of keys, this package's scripts
  pinned exactly, and every file a load or literal path lands on outside every
  scanned tree and workspace package scanned in turn.

**Its limits, stated plainly.** It is best-effort lint: no static analysis of
JavaScript is sound against deliberate obfuscation, and it does not claim to be.
It does not see a loader reached by a computed key, by enumeration or found by
value as an evaluator, handed a target computed or joined to a base at run
time; escapes inside evaluated code text beyond the common ones (legacy octal
escapes, braced escapes longer than six digits) or code text quoted more than
four layers deep; crafted directories and manifests (a load or literal path
that lands on a directory, a manifest whose entry is itself a package
directory); a relative path resolved against the working directory or any base
but its own file's directory (and, when absolute, the repository root); a value
another module exports, or a file written at run time; copies or hard links of
a forbidden file; child processes and worker threads; and Node's loader
internals. The run-time guard refuses, in every runner that executes
control-api code, each of these that lands on a forbidden file; copies and hard
links, other threads and processes, and loader internals that run no hook stay
outside it too.

**History.** Round 0 replaced a regular-expression scan, which a line comment
or an escaped specifier walked past (`CONTROL1-R2-J-L1`), with the syntax-tree
scan. Rounds 1 to 4 of `CONTROL-1b` each found a new route past it that loaded
the venue SDK in a test worker — a path load, an unread extension, an
evaluator reached without the watched spelling (r1); a computed loader handed a
literal, and a permitted package's own loader (r2); a literal path to an inert
file and to code outside every tree (r3); a directory landing, exotic escapes
in evaluated text, nested manifests (r4) — and the run-time guard refused every
one where it was installed. Each round's wording of what remained was too
narrow, so on 2026-10-01 the orchestrator withdrew the requirement that the
scan resist every spelling: the bundle, the production-source rule and the
guard are authoritative, and the scan is lint with the limits above.

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

Likewise, no running trader observes this process's kill switches or pauses:
the shipped process composes no durable audit sink, and the PAPER trader reads
no control table. So the shipped process answers every mutating route `501
CONTROL_NOT_WIRED` (`C1-OPS`), and the operations dashboard's "Kill switches
engaged" panel stays `0`. Set `mutationsReachTrader` to `true` only in a
composition that binds a durable sink AND a trader that reads it; that wiring is
a documented composition obligation, not something this package claims.

## Open trader halts (`CONTROL-2`)

A trader halt latches in the trader's own process, which then exits 75; a halt
that exits between two scrapes reached no metric (`H1R1-HALT-INVISIBLE`).
Since `PROVENANCE-1` every halt whose record lands leaves an open
`TRADER_HALT:<scope>` row in `ops.incidents` that outlives the trader.
`src/trader-halts.ts` reads those rows into `GET /v1/health` (its
`traderHalts` section) and `GET /v1/metrics`.

- **What is read.** Every row whose `incident_key`, upper-cased, begins
  `TRADER_HALT:` and whose status is not `RESOLVED` (`OPEN` and `MITIGATING`
  count), in every environment. The trader's three keys are counted by scope;
  any other key in that namespace counts as `UNRECOGNIZED`, and a row whose
  columns are not the trader's shape is counted and listed with its
  irregularities — never dropped. The counts are exact; the newest 50 rows are
  listed, marked `truncated` beyond that.
- **When.** On every AUTHORIZED health or metrics read, single-flight, bounded
  by the source's timeout — the trader-health convention ("Refresh-on-read",
  `api.ts`). An anonymous or unauthorized caller causes no read.
- **Answered by a deadline** (`CTL2-F1`). Every authorized health or metrics
  read answers within 8 s (`READ_REFRESH_DEADLINE_MS`, `api.ts`, "The answer
  deadline"), whatever its trader-health refresh and its halt read do. A
  refresh still in flight then is answered as not current: the halts are
  `UNKNOWN` (reason `OVERDUE`), never an earlier read's `NONE_OPEN`, and
  `control_trader_health_current` is 0. Without the deadline a slow trader or
  database held the answer past Prometheus's scrape timeout: the scrape was
  abandoned, `UNKNOWN` never reached Prometheus, and nothing paged.
- **Fail closed.** Four states: `OPEN`, `NONE_OPEN`, `UNKNOWN` (no read yet, a
  failed or timed-out read, or a result the door refused) and `NOT_CONFIGURED`.
  `NONE_OPEN` comes only from a read that succeeded; nothing is retained across
  a failed read, so an unreadable table is never "no halts". `NONE_OPEN` is
  still not proof of no halt: a halt whose record could not land has no row.
- **Read-only.** The PostgreSQL source (`src/adapters/postgres-trader-halts.ts`)
  runs its two `select`s in one `REPEATABLE READ, READ ONLY` transaction with
  its own `statement_timeout`; it writes nothing and resolves nothing.
- **Metrics, page and panel.** `control_trader_halts_state{state}` (always
  present), `control_trader_halts_open{scope}` (only after a read that
  succeeded) and `control_trader_halt_reads_total{outcome}` are
  `PLATFORM_METRIC_FAMILIES` entries (`packages/observability`, category
  `halts`). `TraderHaltOpenOrUnknown` (`infra/prometheus/trader-alerts.yaml`)
  PAGES at once while the state is `OPEN` or `UNKNOWN`; `NOT_CONFIGURED` does
  not page, and the operations dashboard's "Open trader halts
  (ops.incidents)" panel shows every state.

### Configuring the read (`CONTROL-2` r1)

`traderHalts` is a REQUIRED configuration field:

- `{ "kind": "none" }` reads nothing. The state is `NOT_CONFIGURED`, which
  `/v1/health`, `control_trader_halts_state` and the startup log say, and
  which is never "no halts". The example configuration uses it, so that it
  starts without a database.
- `{ "kind": "postgres", "timeoutMs": 2000 }` reads `ops.incidents` on every
  authorized health and metrics read, each read bounded by `timeoutMs` (1 to
  5000): the server cancels a statement at the bound, and the read answers
  `UNKNOWN` at it whatever the server does.

**Three bounds, in one order** (`CTL2-F1`; pinned by
`test/integration/control-api/trader-halt-shape.test.ts`):

| Bound | Value | Where |
| --- | --- | --- |
| the halt read's longest `timeoutMs` | 5 s | `TRADER_HALT_READ_TIMEOUT_MAX_MS`, `src/adapters/postgres-trader-halts.ts` |
| the API's answer deadline | 8 s | `READ_REFRESH_DEADLINE_MS`, `src/api.ts` |
| the control-api job's `scrape_timeout` | 10 s, stated | `infra/prometheus/control-api-scrape.yaml` |

A deployment that scrapes this API must give the job a `scrape_timeout` above
8 s, as the fragment does; with a shorter one, a slow read again abandons the
scrape and silences `TraderHaltOpenOrUnknown`. `traderHealth.timeoutMs` may
still be up to 60 s: a trader read slower than the deadline is answered as not
current, and the halts are answered without it.

The database URL is not a configuration field, because it carries a
credential. It comes from ONE environment variable,
`CONTROL_API_TRADER_HALTS_DATABASE_URL` (a `postgres://` or `postgresql://`
URL), which `main.ts` reads once, at startup. Its value is never logged, never
part of a refusal and never echoed in a health answer: a driver error that
held the URL or its password would reach either with them replaced by
`<redacted>`. It is the ONLY source of the connection: the PostgreSQL driver,
like libpq, fills a component the URL omits from the `PG*` environment
variables (`PGPASSWORD`, `PGHOST`, `PGSSLMODE`, …), the password file
(`~/.pgpass`) or the process user, so the URL must name a user, a password, a
host and a database, and a `PG*` variable in the environment is refused.

Its AUTHORITY is the only source of the credential and the host
(`CONTROL2-R1-C2`). The driver reads every query parameter as a connection
parameter, and one there replaces the URL's own: `?password=` would be the
password the driver sends, while the redaction above covers the one before the
`@`; `?options=` or `?application_name=` would replace the session's. So the
query may hold one `sslmode`, `disable` (a loopback database) or `verify-full`,
and nothing else. The driver's other modes are refused: it treats `prefer`,
`require` and `verify-ca` as aliases of `verify-full` (and warns that its next
major version weakens them), and `no-verify` would send the password to a
server whose certificate nobody checked.

The driver must read the URL AS WRITTEN (`CONTROL2-R2-C1`). Its parser
(`pg-connection-string`) REWRITES a URL that holds a raw space or a malformed
escape before reading it: it re-escapes every `%`, then restores the escapes
whose two characters are digits. The password it then sends is neither the
URL's as written nor its decoding (`Fake%2FSecret Word` is sent as written,
`Ec%41%zz` as `EcA%zz`), so the redaction above would miss it. So the URL may
hold no raw space and no `%` that does not begin a two-hex-digit escape
(`TRADER_HALTS_URL_DRIVER_REWRITES`, a superset of the driver's own test), and
its user, password, host and database must percent-decode. Write a space as
`%20` and a literal `%` as `%25`.

No component may decode to a NUL either (`CTL2-R3-L1`): `%00`, or a raw NUL,
which the URL parser writes as `%00`. The driver sends the user, the database
and the password as C strings, and reads each field of a server's error up to
its first NUL, so a server would read, and its error could echo, only the part
of the password before the NUL. That prefix is not a form the redaction holds,
and when the `%00` ends the password it is the whole intended credential. So
for every URL admitted, the password the driver sends is the authority's,
percent-decoded and free of NUL, all of which a server reads, and the
redaction covers it; `trader-halt-shape.test.ts` proves it against the real
driver.

The process refuses to start (exit 78), naming the variable and never its
value, when `postgres` has no URL, when the URL is not a PostgreSQL URL or
omits one of those four, when the driver would rewrite it or one of its
components does not decode or decodes to a NUL
(`CONTROL_TRADER_HALTS_URL_ENCODING`), when its query holds anything but one
`sslmode`, when a `PG*` variable is set, and when the URL variable is set while
`traderHalts.kind` is `none`.

**The deployment's duty: a role that can read `ops.incidents` and nothing
else.** Give the URL a role of its own, with `USAGE` on the schema `ops` and
`SELECT` on the one table:

```sql
CREATE ROLE control_api_halt_reader LOGIN PASSWORD '…';
GRANT USAGE ON SCHEMA ops TO control_api_halt_reader;
GRANT SELECT ON ops.incidents TO control_api_halt_reader;
```

Nothing more is needed and nothing more should be granted: the read runs in a
`READ ONLY` transaction, and this process never resolves a halt. A role
without that privilege reads `UNKNOWN`, which pages, rather than "no halts".
The reader's pool holds at most two connections, named
`polymarket-bot-control-api` in `pg_stat_activity`; a connection that fails
while idle is logged (redacted) and dropped, and the next read opens another.

**Stopping** (`CTL2-L2`). On SIGTERM or SIGINT the process closes its server,
then the pool. A database that froze mid-statement holds its connection, and
with it the pool: after 5 s (`TRADER_HALTS_CLOSE_WAIT_MS`) the process ENDS the
connections the pool still holds, which destroys a socket whose statement is
outstanding, and waits 1 s more (`TRADER_HALTS_TERMINATE_WAIT_MS`). Then it
exits: 0 when everything closed, 1 (`EXIT_CODES.stopFailed`) when something did
not, with `control API stop failed: …` (redacted) in its log. Nothing still
referenced keeps a stopped process alive.

**Proven** against a real PostgreSQL by the opt-in suite
(`pnpm --filter @polymarket-bot/control-api test:integration:postgres`, with
Docker; CI does not run it yet):

- `test/integration/control-api/postgres/trader-halts-postgres.test.ts` — the
  trader's own writer, the real API over HTTP, and every state: open,
  resolved and mitigating rows, an unknown scope, irregular rows, many rows, a
  locked table, a role without the privilege, and read-only measured;
- `test/integration/control-api/postgres/shipped-bundle-halts-postgres.test.ts`
  — the SHIPPED bundle, built by `build` and run with `node`, configured for
  `postgres` through a role holding only the privileges above, against a
  database holding an open `TRADER_HALT` row: its `/v1/health` and
  `/v1/metrics` say `OPEN`.

Without a container, `test/integration/control-api/trader-halt-shape.test.ts`
runs the shipped `startup()` and the SHIPPED bundle against loopback servers
that stand in for a database that froze and a trader that never answers: the
scrape is answered `UNKNOWN 1` inside the scrape timeout (`CTL2-F1`), and
SIGTERM exits 0 within the stop's bounds (`CTL2-L2`), while a trader read with
a 60 s bound is still outstanding, which only the shipped exit port can end
(`CTL2-R2-L3`).

## The PostgreSQL sink: reached by an opt-in suite, bound by no composition (disclosed)

Until `CONTROL-1b` this section read "No database was reached": Docker was
absent from the environment this package was built in, and
`src/adapters/postgres-audit-sink.ts` was typecheck-pinned only.

Since `CONTROL-1b`, `test/integration/control-api/postgres/audit-sink-postgres.test.ts`
drives the sink against a Testcontainers PostgreSQL with every migration
applied. It measures that the `ops` tables refuse a RAW record carrying NUL, a
lone surrogate in `jsonb`, or text over the `internal.detail`/`internal.identifier`
domains (and silently replace a lone surrogate in `text`), and that every record
the control plane writes lands, equal field for field to the in-memory log's.

It is **opt-in**: `pnpm --filter @polymarket-bot/control-api
test:integration:postgres`, with Docker. The main integration suite
(`test:integration`, CI's "control-api (no container)" step) excludes it and
starts no container, and CI does not run it yet. **No composition binds the
durable sink**: `main.ts` writes to the in-memory log only, so acceptance 2's
evidence for the shipped process is still at the port, against the real control
plane and the real append-only log.

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
`traderHalts` (`CONTROL-2` r1) is `none` or `postgres` with a `timeoutMs`; a
configuration written before it lacks the field and is refused the same way.
The `postgres` source's database URL is the environment's, not the file's
(see "Configuring the read").

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
exits without binding anything. The example reads no trader halts
(`traderHalts.kind` `none`); to read them, set `postgres` and export
`CONTROL_API_TRADER_HALTS_DATABASE_URL` (see "Configuring the read").

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
