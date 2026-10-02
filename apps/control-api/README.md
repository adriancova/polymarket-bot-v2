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
- `engage-reserve.test.ts` and `shipped-root-engage-reserve.test.ts` are the
  verifiers' three `CONTROL1-J-M1` sequences, over HTTP and through the shipped
  `main.ts`; each fails at the round-0 commit.
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
adapter. `test/integration/control-api/acceptance-3-no-signer.test.ts` asserts
that by scanning the shipped source of both trees, and additionally asserts that
`packages/polymarket-secure` is absent from this package's dependency manifest.
Its load scan also covers this package's test suites and `infra/grafana/**`
(`CONTROL-1`, N-4). Since `CONTROL-1b` it reads each file's SYNTAX TREE with
TypeScript's own parser (`test/integration/control-api/support/module-loads.ts`)
instead of a regular expression — which a line comment or an escaped specifier
had walked past (`CONTROL1-R2-J-L1`):

- every load form — static and type-only imports, re-exports, `import x =
  require()`, `import()` types, dynamic `import()`, `require()` in any calling
  spelling, `process.getBuiltinModule()`, vitest's `vi.importActual()` /
  `importMock()` / `mock()` / `doMock()`, triple-slash and AMD references,
  JSDoc `@import`, and `declare module` — is read as the EVALUATED string
  literal, so comments are inert and escapes resolve as the runtime resolves
  them. Since `CONTROL-1b` r2 only the REAL calling forms are loads — `require`
  as itself or as `module.require`, with one argument; `getBuiltinModule` off
  `process`; vitest's loaders off `vi` or `vitest` — and any other `.require`
  is a named loader: round 1 read `ts.sys.require(baseDir, moduleName)` as a
  load of the BASE, and the venue SDK loaded through it (`CONTROL1B-R2-J-H2`);
- every executable extension is read with its own grammar — `.ts`, `.mts`,
  `.cts`, `.tsx`, `.js`, `.mjs`, `.cjs`, `.jsx` — and JSON with JSON's, and
  EVERY entry of a scanned tree is classified: a file that is not code, JSON
  or an inert kind (`.md`, `.gitkeep`), a symbolic link, or a `node_modules`
  directory fails (`CONTROL-1b` r1, closing `CONTROL1B-R1-J-H2`: `.tsx` and
  `.jsx` files were never opened, and a computed import in a `.tsx` helper
  loaded the secure adapter) — and since `CONTROL-1b` r3 an inert kind is
  admitted only in `infra/grafana`, the one scanned tree that holds no code:
  the CommonJS loader runs a `.md` file as JavaScript;
- each literal is judged by WHERE IT LANDS (`support/load-judge.ts`;
  `CONTROL-1b` r1, closing `CONTROL1B-R1-J-H1`): a relative, absolute or
  `file:` path by the file it reaches — read both as the CommonJS loader reads
  it and, percent-decoded, as the ES loader does, through every symbolic link —
  which may not be inside `packages/polymarket-secure`, pass through
  `node_modules`, name a signing package, or be anything but code or JSON; a
  bare name by the package each vitest alias and `node_modules` resolution
  makes of it; a builtin by an allowlist of modules that cannot load or run
  code (`node:vm`, `node:module`, `node:child_process`, `node:worker_threads`
  and the rest fail — `CONTROL1B-R1-J-L2`); and `data:`, other URL schemes and
  `#imports` fail as unplaceable. A bare name must also be on an explicit
  package-AND-subpath list (`PERMITTED_BARE_SPECIFIERS`: `vitest`, `zod`, the
  workspace packages these trees use; `vitest/config` in the three runner
  configs only; `typescript` in the scanner only) — `vitest/node`'s
  `createViteServer().ssrLoadModule` and ESLint's `overrideConfigFile` load any
  path they are handed, and the round-2 verifiers loaded the secure adapter and
  the venue SDK through each (`CONTROL1B-R2-J-H2`);
- every OTHER literal is judged by what it NAMES (`CONTROL-1b` r2, closing
  `CONTROL1B-R2-J-H1`): each string, each template's text (evaluated and raw),
  each regular expression's body, JSX text, each identifier and, in JSON, each
  key and string value fails when, read as a load from the same file, it would
  be forbidden, or when its path segments — split on `/` and `\`, as written and
  percent-decoded — name `polymarket-secure` or a forbidden package. The
  round-2 verifiers reached `createRequire` without spelling it (built with
  `.join("")`, or `Function` found by enumerating the function prototype) and
  handed it a LITERAL path or package name, which round 1 never judged because
  it was not in a load position;
- every literal PATH — a literal with a path form (`./`, `../`, `.`, `..`,
  `/`, `file:`), and every path quoted inside a literal (code text an
  evaluator could run, its escapes decoded) — is judged where a loader handed
  it would LAND (`CONTROL-1b` r3, closing `CONTROL1B-R3-J-H1`): resolved
  against its own file's directory, as `createRequire(import.meta.url)`,
  `import()` and vitest's loaders resolve it — and, when absolute, as itself
  and under the repository root, as vite reads `/x` (and `/@fs/x`) — as
  written and percent-decoded; a path through `/proc` or `/dev` fails outright
  (as a load, `<target:…>`, too: `/proc/self/cwd` is a different directory in
  each runner); then every EXISTING file a resolver can take there (the path,
  the path with ANY extension added — CommonJS tries one a program registers
  at run time — TypeScript's source for a `.js` name, a directory's manifest
  entries and `index`) must be code or JSON, or the literal fails as
  `<lands:…>`, and the code it reaches outside every scanned tree is scanned
  in turn, exactly as a load's is. Round 2 asked of such a literal only
  whether it NAMED a forbidden target: the round-3 verifiers handed a
  computed `createRequire` the literal paths `./zz-r3-notes.md` (an inert
  file beside the test) and `../../zz-r3-outside.cjs` (code outside every
  tree), each holding one `require` of the venue SDK, which loaded in the
  repository's unit runner with this acceptance green;
- whatever it cannot read FAILS: a computed specifier, a named loader or
  evaluator — `require` aliased, `createRequire`, `eval`, `Module._load`,
  `_compile`, `_extensions` (since r2), `dlopen`, `process.binding`,
  `ShadowRealm`, any `.constructor`,
  `Function` in any VALUE position, and any name beginning `__vite` (vite-node's
  in-scope `__vite_ssr_dynamic_import__`, vitest's `globalThis.__vitest_*__`)
  (`CONTROL-1b` r1, closing `CONTROL1B-R1-J-H3`: an aliased `Function`,
  `(() => {}).constructor` and `getBuiltinModule("node:vm")` each loaded the
  venue SDK past round 0), including any of those names as a string key —
  `import.meta.glob`, a file that does not parse under its extension's
  grammar, or a load that lands on no file when the scan runs (a test that
  WRITES a module and then loads it) — unless an explicit, justified allowlist
  entry covers it exactly (the allowlist holds only the scan's own
  vocabulary — the loader names it detects and, since r2, the forbidden
  targets it judges — and the run-time guard's one `node:module` import);
- the RUNNERS load nothing their imports do not name: the three vitest configs
  that run these trees are a closed world (no setup file, plugin or custom
  environment but the run-time guard's, exactly) whose aliases are judged like
  any path, this package's scripts
  are pinned exactly, and the bundle's tsconfig maps no name; a load or a
  literal path that lands on a file outside every scanned tree and every
  workspace package (a fixture under `test/`, the repository's unit runner
  config) is scanned in turn — and, since `CONTROL-1b` r3, so is one that lands
  in a workspace package where `check:deps` reads nothing (a dot-directory,
  `dist/` and the rest of its skipped directories); and no workspace package a
  load or a literal path lands in declares a forbidden dependency, at any
  depth — its own source is `check:deps`'s (F6, F16);
- planted controls cover every spelling and path form the verifiers used, each
  escape and comment form, each literal form, the round-2 verifiers' five plants
  verbatim, each scanned tree and each code extension — and the round-3
  verifiers' two plants verbatim, ON DISK in a mirror of each scanned tree, in
  each code extension, beside the same plant aimed at an innocuous file.

**The run-time guard (`CONTROL-1b` r2).** A static scan cannot rule out a load
whose loader it does not name AND whose target it does not reach from a
literal (the residual below). So the control API's two integration runners
(`test:integration` and `test:integration:postgres`) install
`test/integration/control-api/support/no-signer-guard.ts`, which refuses the
LANDING itself — a file that lies in the secure adapter or under a forbidden
package's directory — whatever loader reached it:

- a `module.registerHooks` `load` hook (the runner's one setup file) runs for
  every module loaded in the test worker's thread — through `require`,
  `createRequire`, `Module._load`, ESM `import` and `import()` — and throws
  when it is inside `packages/polymarket-secure` or on a path naming a
  forbidden package (which is where pnpm keeps every one of them); being a
  LOAD hook, it also refuses what a test's OWN resolution hook answered;
- a vite `load` hook (the runner's one plugin) refuses the same files when
  vitest's own module graph — `vi.importActual`, `__vite_ssr_dynamic_import__`,
  a test's imports — would load them.

`no-signer-runtime-guard.test.ts` pins both halves in each runner, with loads
written exactly as the static scan cannot read them; each of the five round-2
plants, and the round-3 routes, are refused by it too. It judges where a file
LIES, not what it holds.

**Dated correction (`CONTROL-1b` r3, 2026-10-01).** Round 2 below stated the
static residual as a load whose loader the scan does not name AND "whose
target no literal in the file names", and the guard as refusing a forbidden
file "however it was spelled". Both were wrong. The round-3 verifiers reached
`createRequire` by computed names and handed it a LITERAL path to an inert
`.md` beside the test and to a `.cjs` outside every scanned tree, each holding
a `require` of the venue SDK: the SDK loaded in the repository's unit runner
with this acceptance green (`CONTROL1B-R3-J-H1`). And a COPY of the SDK's files
at a path naming nothing forbidden loaded with the guard installed
(`CONTROL1B-R3-J-L1`). The literal-path form now fails, above. What remains,
stated rather than claimed away:

- **statically:** a load whose loader the scan does not NAME — reached by a
  computed key, by enumeration, by spreading an object that holds one, or
  through a method of a permitted package other than those named above — AND
  whose target the scan does not reach from a literal: a path or name computed
  at run time (from parts, by slicing, from encoded data or from the
  program's own text); a literal joined at run time to a base the program
  supplies (`join(root, "x")`, a `createRequire` anchor other than the file's
  own, a URL base) — the scan resolves a literal path only against its own
  file's directory and, when absolute, the repository root; a value another
  module exports; or a file that does not exist when the scan runs (one a
  test writes, and then loads);
- **at run time, in the two integration runners:** a COPY or hard link of a
  forbidden file at a path that names nothing forbidden (the guard judges
  where a file lies, not what it holds); code read as TEXT and handed to an
  evaluator (or to a load hook a test registers); a module graph a test
  builds itself (its Node-loaded dependencies ARE guarded); another THREAD or
  process (the hook is thread-local, so a `worker_threads` Worker loads
  without it); Node's loader internals called directly
  (`Module._extensions[…]`, which runs no hook; the scan refuses the name);
  and a builtin reached through `process.getBuiltinModule`, which resolves
  nothing;
- **the repository unit runner** (`test/vitest.config.ts`, `WP-010`-owned and
  outside `CONTROL-1b`'s grant) runs `src/**/*.test.ts` and
  `test/unit/control-api/**` WITHOUT the guard: there the static residual
  above stands alone, and a load in it — an unnamed loader handed a path
  computed at run time or joined to a base, a value another module exports, a
  file written at run time — really loads what it reaches;
- as before: a test that OVERWRITES an existing file at run time and then
  loads it (the scan read the earlier text; the guard still refuses what it
  would load, in the integration runners), the deeper dependencies of
  third-party packages, and runner flags outside this package (CI's
  environment, `NODE_OPTIONS`).

**Dated correction (`CONTROL-1b` r2, 2026-10-01).** Round 1 below said what
remained beyond the scan was "a loader reached through a COMPUTED property name
… with a computed path", which implied a LITERAL path was ruled out. It was
not: the round-2 verifiers loaded the venue SDK through a computed loader name
with a literal path, and through `ts.sys.require`, `vitest/node` and ESLint
with every loader name spelled, all with this acceptance green. What remains
now, stated rather than claimed away:

- **statically:** a load whose loader the scan does not NAME — reached by a
  computed key, by enumeration, by spreading an object that holds one, or
  through a method of a permitted package other than those named above — AND
  whose target no literal in the file names (a path or name computed at run
  time, from parts, by slicing, from encoded data or from the program's own
  text, or a value another module exports);
- **at run time, in the two integration runners:** code read as TEXT and
  handed to an evaluator (or to a load hook a test registers), a module graph
  a test builds itself (its Node-loaded dependencies ARE guarded), another
  THREAD or process (the hook is thread-local, so a `worker_threads` Worker
  loads without it), Node's loader internals called directly
  (`Module._extensions[…]`, which runs no hook; the scan refuses the name),
  and a builtin reached through `process.getBuiltinModule`, which resolves
  nothing;
- **the repository unit runner** (`test/vitest.config.ts`, `WP-010`-owned and
  outside `CONTROL-1b`'s grant) runs `src/**/*.test.ts` and
  `test/unit/control-api/**` WITHOUT the guard: there the static residual
  above stands alone;
- as before: a test that OVERWRITES an existing file at run time and then
  loads it (the scan read the earlier text; the guard still refuses what it
  would load, in the integration runners), the deeper dependencies of
  third-party packages, and runner flags outside this package (CI's
  environment, `NODE_OPTIONS`).

(Superseded by the `CONTROL-1b` r3 correction above: the static residual's
second half was stated too narrowly — a computed loader with a LITERAL path to
a file the scan did not read loaded the venue SDK — and the run-time list
omitted a copy or hard link.)

**Dated correction (`CONTROL-1b` r1, 2026-10-01).** Round 0 said that "behind
the scan, none of the forbidden packages even RESOLVES from a scanned tree, so
a load spelled in a way no static scan can read would still find nothing to
load". That held for bare NAMES only: a PATH into `packages/polymarket-secure`
or its `node_modules` really loads, which is how the round-1 verifiers loaded
the secure adapter and the venue SDK with this acceptance green. What remains
beyond the scan, stated rather than claimed away: a loader reached through a
COMPUTED property name (`globalThis[atob(…)]`) with a computed path; a test
that OVERWRITES an existing file at run time and then loads it (the scan read
the file's earlier text); the deeper dependencies of third-party packages; and
runner flags outside this package (CI's environment, `NODE_OPTIONS`).
(Superseded by the `CONTROL-1b` r2 correction above: that residual was stated
too narrowly — a computed loader with a LITERAL path loaded the venue SDK.)

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
