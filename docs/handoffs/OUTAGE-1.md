# OUTAGE-1: pre-H1 outage hardening

Branch `outage-1` on base `586b9e2`, merged into `main` as `143ad8d` (`--no-ff`) on 2026-09-29.

- **Authorization:** the user's pre-H1 choice "Outage hardening" (2026-09-28).
- **Process:** the HARDENING LOOP (workflow `wf_ac2d132c-160`, run in parallel with `REGISTER-1`).
  - The first implementer was killed by an account session limit mid-work. A fresh Opus implementer continued its uncommitted work under a continuation notice, reviewed every hunk, and kept its design.
  - The verifier was a Claude Fable adversarial-reviewer, because the evidence stops and starts containers.
- **Commit:** `776b031`, the one commit, accepted on its first review.

## Outcome
**(1) `B1-R1-REDIS-UNCAUGHT`.** `startup()` never throws.
- An unreachable Redis is refused as `TRADER_REDIS_UNAVAILABLE` with exit 69 (`infrastructureUnavailable`), before any database pool exists.
- A refused URL is `TRADER_REDIS_URL_REFUSED` (78).
- A refused subscription is 69 or `TRADER_EVENT_SUBSCRIPTION_REFUSED` (78).
- No credentials are logged. The shipped bundle refuses with exit 69 and no stack trace.

**(2) `BOOT1-R7`.**
- **Root cause:** after a container stop, ioredis parks the in-flight command in its resend-on-reconnect queue, so `receive` never settled.
- **Fix:** a response deadline in `packages/event-bus`.
  - `responseTimeoutMs`, default 5000, valid range [1, 600000].
  - For the command connection, ioredis `commandTimeout`.
  - Blocking reads are raced against `waitMs + T`, and only the I/O is raced, so an abandoned read never moves the position.
  - The handshake is bounded by `connectTimeoutMs + T`.
  - The trader reads `TRADER_REDIS_RESPONSE_TIMEOUT_MS`, accepting 100..60000; anything else is refused with 78.
- **Result:** an outage latches a GLOBAL `TRANSPORT_UNAVAILABLE` `FULL_HALT` within T, and the process exits 75.
- **Not an outage:** an idle stream, a slow server answering within T, and a partition healing within T.

| Fault (measured from the fault) | Halt | Exit |
| --- | --- | --- |
| container stopped, default T | +4.7 s | +4.7 s |
| idle for 5T, then stopped (T = 1 s) | +0.7 s after the stop | +0.7 s |
| `docker pause`, T = 1 s | +1.0 s | +3.0 s |
| `docker pause`, default T | +5.0 s | +15.0 s |

Nothing was traded or written after any halt.

**(3) `BOOT1-CONFIGPARAMS`.** `verifyRegisteredRows` reads `strategy.configs.parameters` and compares it with `instances[].params` canonically:
- keys in any order;
- arrays ordered;
- scalars exact, with a number equal to its decimal string.

A mismatch is `TRADER_REGISTRATION_MISMATCH` (78), naming each JSON Pointer and both values. A missing config row is `_MISSING`.

## Review (Fable r1: ACCEPT)
- `OUT1-R1-HALT-NOT-DURABLE` MEDIUM: the halt is not persisted, because `TraderStore` has no halt write. It was disclosed and STOPPED per the packet, and is queued.
- `OUT1-R1-READ-DEADLINE-PIN-PROBABILISTIC` LOW.
- `OUT1-R1-RESTART-NOTE` LOW: with a fixed port, a fast restart RECOVERS.
- `OUT1-R1-SUBSCRIBE-CATCHALL` LOW.

## Evidence
- **Gates at `776b031`:**
  - unit 357/7689;
  - e2e 8/206;
  - replay 3/17;
  - control-api 10/87;
  - event-bus integration 9/99;
  - data-gateway integration 12/94;
  - trader integration 19/147, twice.
- **Non-vacuity:**
  - with the base event-bus and feed, the outage scenarios hang (76 s, 64 s, 64 s);
  - with the base registration check, a parameter mismatch starts instead of being refused.
- **CI:** PR #20 run `36539709687`, green.

## Integration with REGISTER-1
On the combined tree, REGISTER-1's non-vacuity test expected `_MISMATCH` for an unregistered `configId`. With (3), that case is `_MISSING`. The orchestrator fixed the assertion on the `register-1` branch; see `docs/handoffs/REGISTER-1.md`.

## commit_sha
- Implementation: `776b031b96498a274fcf6c4efb4cc7385bd34b93`.
- Merge: `143ad8d`.

# Appendix A — implementer handoff, r0 (verbatim)

# OUTAGE-1 — implementer handoff, round 0

Worktree `/home/adriancova/proyects/tradeBot/polymarket-bot-outage-1`, branch `outage-1`, base `586b9e2`, ONE commit `776b031b96498a274fcf6c4efb4cc7385bd34b93`. Not pushed.

## summary

All three items are implemented and proved. Everything was run by me in this session.

### (1) `B1-R1-REDIS-UNCAUGHT`: an unreachable Redis at startup is a documented refusal

- `startup()` now contains both `RedisStreamsEventTransport.connect` and `transport.subscribe`:
  - unreachable Redis → `REFUSING TO START: TRADER_REDIS_UNAVAILABLE: … (Redis) at redis://host:port could not be reached …`, then the cause chain on one line; exit **69** (`EXIT_CODES.infrastructureUnavailable`);
  - a URL the transport refuses → `TRADER_REDIS_URL_REFUSED`, exit 78;
  - a refused subscription → 69 if Redis is unavailable, otherwise `TRADER_EVENT_SUBSCRIPTION_REFUSED` (78). Everything opened so far is closed.
- Why 69: it is the PostgreSQL boundary's code (`TRADER_REGISTRATION_UNREADABLE`), and the remedy class is the same. Nothing in the document is wrong; a dependency is unreachable. The refusal happens BEFORE any database pool exists.
- Credentials are never logged: the endpoint is printed as `scheme://host:port` only.

### (2) `BOOT1-R7`: a Redis outage mid-run halts within a stated, configurable bound

**Root cause (measured by the first implementer with `DEBUG=ioredis:*`, re-confirmed here by the base-restored runs):**
- After `docker stop`, ioredis parks the in-flight command in its resend-on-reconnect queue (`prevCommandQueue`). The `maxRetriesPerRequest` flush never touches that queue.
- A half-open handshake never closes.
- So `subscription.receive` never settles.
- `maxRetriesPerRequest` and `enableOfflineQueue` therefore cannot bound it.

**Also found this round:** ioredis 6's own `blockingTimeout` RESOLVES a timed-out blocking command with `null` (`Command.js` `setBlockingTimeout`). An `XREAD` caller reads that as "no events", so a partition would look idle forever. It was rejected on that evidence.

**Mechanism: a response deadline in `packages/event-bus`.** `RedisConnectionOptions.responseTimeoutMs` defaults to 5000 and is validated as an integer in [1, 600000]; anything else is refused, never clamped.
- **Command connection:** ioredis `commandTimeout = T`. Its timer lives on the command object, so it also fires for a parked command.
- **A subscription's blocking-read connection:** each `XREAD` is raced against `waitMs + T` (new `redis/deadline.ts`).
  - Only the I/O is raced: the position is never advanced by an abandoned read.
  - A legitimate `BLOCK` wait is never cut short.
- **Handshake:** bounded by `connectTimeoutMs + T`.
- **Courtesy `QUIT`:** sent only to a `ready` connection, bounded by T, then always `disconnect()`.

**Trader wiring:**
- `TRADER_REDIS_RESPONSE_TIMEOUT_MS` is optional: default 5000, accepted range 100..60000 (canonical integer). Anything else → `TRADER_REDIS_RESPONSE_TIMEOUT_REFUSED`, 78, before anything is opened.
- The process logs the bound in force.
- **Semantics (stated and measured):**
  - the halt latches GLOBAL `TRANSPORT_UNAVAILABLE` (`FULL_HALT`) within T of the first Redis command the outage leaves unanswered;
  - `startup()` returns 75 at most 2T after the halt (one bound per connection's courtesy `QUIT`), plus the PostgreSQL close;
  - an interruption the server answers within T is NOT an outage (a slow server, or a partition that heals within T).
- `redis-feed.ts`: the halt detail now carries the error's cause chain (bounded to 3 links). An operator reads "Command timed out" or "no reply to a read within N ms", not only the wrapper.
- **Why 5 s:** a healthy Redis answers these commands in well under 1 ms, and an idle poll is answered in ms. 5 s absorbs GC pauses and brief reconnects, yet the default worst case to exit is about 15 s: seconds, not minutes.

### (3) `BOOT1-CONFIGPARAMS`: registered parameters are checked

- `verifyRegisteredRows` reads `strategy.configs (config_id, parameters)` for the configured config ids and compares them CANONICALLY with `instances[].params`:
  - object keys are a set; arrays are ordered;
  - strings, booleans and `null` compare exactly;
  - a JSON number equals its `String(n)`. This is the only form the decimal-guarded row can hold: `assertDecimalSafeJson` refuses numbers.
- A difference → `TRADER_REGISTRATION_MISMATCH`, exit 78, naming each difference by JSON Pointer with both values (at most 10 are listed, then "and N more").
- A missing config row → `_MISSING`.
- Nesting deeper than 64 levels fails CLOSED, so the check is total.
- `parameters_hash` is NOT compared: no document specifies its derivation, and the fixtures hash arbitrary labels.
- Note: PostgreSQL `jsonb` reorders keys on storage. Key-order independence was therefore already a precondition for every existing registration to pass.

### Measured times (trader integration run 2; runs 1 and 2 and the standalone runs agree)

| Scenario | Halt | `startup()` returned |
|---|---|---|
| Container STOPPED, default T=5000 | +4655 ms after `stop()` returned (bound T + 1 s = 6000) | +4656 ms (bound 3T + 1 s = 16000) |
| Idle 5000 ms (5T at T=1000): no halt, then STOPPED | +717 ms | +717 ms |
| PARTITION (frozen hop, sockets open), T=1000 | +1001 ms | +3003 ms: exactly 3T, the worst case, because both connections still report ready and each gets its bounded QUIT |

Real `docker pause`, measured with a scratch probe (not committed), from the pause command:

| Scenario | Halt | Exit 75 |
|---|---|---|
| T=1000, after events | +995 ms | +3031 ms |
| T=1000, idle | +984 ms | +3023 ms |
| Default T, after events | +4999 ms | +15027 ms (3T plus the PostgreSQL close, as stated) |
| `docker restart` | +5068 ms | +5068 ms |

The `docker restart` changed the mapped port, so the trader could not reconnect. No decision was persisted after any fault.

### Shipped bundle, built and run by hand

Environment for both runs: the safe env, the example config, and an unreachable PostgreSQL. `dist/` was deleted afterwards.

**Run 1: `REDIS_URL=redis://bundle:not-a-real-secret@127.0.0.1:1`** (rebuilt from the committed tree `776b031`)

```
safety: OK — run mode PAPER, ceiling PAPER, real orders disabled
configuration: OK — 1 market(s), 1 instance(s), environment PAPER
health endpoint: NOT configured (TRADER_HEALTH_BIND and TRADER_HEALTH_PORT are unset); no HTTP surface will be bound and a control API's http health source has nothing to read
event transport bound: every Redis command must answer within 5000 ms (TRADER_REDIS_RESPONSE_TIMEOUT_MS unset; the default); a Redis outage latches a GLOBAL TRANSPORT_UNAVAILABLE halt within that bound of the first command it leaves unanswered, and the process exits 75 at most 10000 ms after the halt (one bound for each connection's courtesy QUIT) plus the PostgreSQL close (§4.2)
REFUSING TO START: TRADER_REDIS_UNAVAILABLE: the event transport (Redis) at redis://127.0.0.1:1 could not be reached. §4.2 makes Redis a trading-halt boundary, so the process refuses rather than starts without it (fail closed). No database connection was opened and no row was read
  EventBusUnavailableError: could not connect to the event transport; caused by Error: Connection is closed.
EXIT CODE: 69
```

No stack trace, and no credential.

**Run 2: a listener that accepts and never answers, T=1000.** This build predates only the bound line's final wording; the code is otherwise identical.
- The refusal (same two lines, exit 69) was printed 3.16 s after start. That is ioredis 6's own ~3 s handshake window; the transport's `connectTimeoutMs + T` deadline is the backstop behind it.
- The process exited at 5.17 s, because ioredis's connector waits 2 s before destroying the half-open socket after `disconnect()`.

**Proposed case for REGISTER-1 or the orchestrator to add to `app-bundles-load.test.ts`:**
- env: `SAFE_PAPER_DEFAULTS` + `TRADER_CONFIG_PATH: TRADER_EXAMPLE_CONFIG`, `REDIS_URL: "redis://127.0.0.1:1"`, `DATABASE_URL: "postgres://bundle:bundle@127.0.0.1:1/bundle"`;
- `exitCode: TRADER_EXIT_CODES.infrastructureUnavailable`;
- `printed: ["REFUSING TO START: TRADER_REDIS_UNAVAILABLE: the event transport (Redis) at redis://127.0.0.1:1 could not be reached."]`;
- `notPrinted: ["registration:", "    at "]`.

The existing trader cases in that file still pass: it ran inside `pnpm run test`.

## files_changed

Source (allowed paths):
- `packages/event-bus/src/redis/client.ts`: `responseTimeoutMs`, `DEFAULT_RESPONSE_TIMEOUT_MS`, `MAX_RESPONSE_TIMEOUT_MS`, `resolveResponseTimeoutMs`, connection role, commandTimeout, handshake deadline, bounded QUIT.
- `packages/event-bus/src/redis/deadline.ts` (new): `withDeadline`.
- `packages/event-bus/src/redis/subscription.ts`: the read deadline; close passes the bound.
- `packages/event-bus/src/redis/transport.ts`: validates the bound at connect; roles; close passes the bound.
- `packages/event-bus/src/redis/index.ts`: exports the two constants.
- `packages/event-bus/src/testing/container.ts`: `startFreezableRedisProxy` (a test helper: a hop that goes silent without closing).
- `apps/trader/src/main.ts`: step 2c (`readRedisResponseTimeout`, `REDIS_RESPONSE_TIMEOUT_ENV`, `REDIS_RESPONSE_TIMEOUT_RANGE`); the contained connect and subscribe; `EXIT_CODES` docs.
- `apps/trader/src/adapters/redis-feed.ts`: the cause chain in the halt detail.
- `apps/trader/src/adapters/postgres-registration.ts`: the `strategy.configs` read; `compareRegisteredParameters`.

New tests (named):
- `packages/event-bus/src/redis/deadline.test.ts` (4)
- `packages/event-bus/src/redis/client.test.ts` (13)
- `test/unit/trader/startup-redis-refusal.test.ts` (23)
- `test/unit/trader/registered-parameters.test.ts` (15)
- `test/integration/event-bus/response-deadline.test.ts` (18)
- `test/integration/paper-trader/redis-outage-halts-postgres-redis.test.ts` (4):
  - the container stopped mid-run (default T);
  - idle for 5T, then stopped (T=1000);
  - a partition (T=1000);
  - a subscription refusal (78).
- `test/integration/paper-trader/registered-config-parameters-postgres.test.ts` (5):
  - max entries 1 vs 2 through the real `startup()` → 78;
  - the same params, including reversed key order → OK;
  - an extra key, a missing key and `"0.50"` vs `"0.5"` → each refused and named.

No file under trading-core, control-api, `db/**`, `docs/**`, REGISTER-1's paths or any protected path was touched. `git diff --name-only 586b9e2 HEAD` was checked against the grant.

## tests_run

All exit 0 unless stated.

- **`pnpm run typecheck`**: exit 0.
- **`pnpm run lint`**: exit 0.
- **`pnpm run check:deps`**: exit 0.
- **`pnpm run test`**: 357 files / 7689 tests passed. That includes the 4 new unit files (55 tests) and `test/unit/tooling/app-bundles-load.test.ts`.
- **`pnpm run test:e2e`**: 8 files / 206 tests.
- **`pnpm run test:replay`**: 3 files / 17 tests.
- **`pnpm --filter @polymarket-bot/control-api test:integration`**: 10 files / 87 tests.
- **`pnpm --filter @polymarket-bot/event-bus test:integration`**: 9 files / 99 tests (the new `response-deadline.test.ts` has 18).
- **`pnpm --filter @polymarket-bot/data-gateway test:integration`**: 12 files / 94 tests. Run because the transport changed; the publisher's delivery, ordering and resync suites are unchanged and green.
- **`pnpm --filter @polymarket-bot/trader test:integration`**, run 1: 19 files / 147 tests.
- **`pnpm --filter @polymarket-bot/trader test:integration`**, run 2: 19 files / 147 tests. The BOOT-1, TRDR-3, BRACKET-1c, two-level and UNIV-4 Postgres files all pass under the new params check.

**Non-vacuity A.** I restored `packages/event-bus/src/redis/{client,index,subscription,transport}.ts` and `apps/trader/src/adapters/redis-feed.ts` from 586b9e2 byte-identically and moved `deadline.ts` aside. `main.ts` and the test helper were kept. Results:
- the outage file: 3 FAILED "STILL RUNNING":
  - stopped: `startup() had not returned 76000 ms after the Redis container was stopped — BOOT1-R7 …`;
  - idle-then-stopped;
  - partition.
- The subscription-refusal case passed; it is `main.ts` wiring.
- Also `response-deadline.test.ts` `-t "non-blocking receive fails|accepts and never answers"`: both timed out at 60 000 ms.
- Restored from a tar backup; `sha256sum -c` gave OK for all 7 files.

**Non-vacuity B.** I restored base `postgres-registration.ts`. Results:
- the headline case failed with "the process STARTED on parameters its registered config does not hold" (the verdict was STARTED, not 78);
- the three variants assembled (`expected true to be false`);
- the reversed-key control passed.
- Restored; `sha256sum -c` OK.

**Scratch probe (not committed):** real `docker pause` (T=1000 with events, T=1000 idle, default T) and `docker restart`, with the times as above. All returned 75, and there were no decisions after the fault.

**`TC-LOCAL-FLAKE`:** not observed in any run this session. The new container tests carry a bounded readiness retry in their own setup only: 5 attempts, 400 ms apart, on the publisher/probe connect.

## assumptions

- Exit 69 for Redis-unreachable, matching PostgreSQL's `_UNREADABLE` (same remedy class). A URL or subscription the transport REFUSES is a configuration refusal (78), not an outage.
- "Within a bound" is T to the halt, measured from the first command the outage leaves unanswered. The trader's idle loop polls continuously, so that command is issued within milliseconds of the fault. The exit follows at most 2T later, plus the PostgreSQL close.
- An interruption shorter than T is not an outage: it recovers and the trader continues. That is pinned at the event-bus level (slow server; partition that heals).
- A registrant stores the strategy's numbers as `String(n)` and its strings verbatim, as `support/registration.ts` does. REGISTER-1 must do the same (see follow_up).
- `instances[].params` is `z.unknown()` in the config door, so the compared document is the operator's verbatim.

## deviations

- **I continued a KILLED implementer's uncommitted work** (killed by an account session limit). It left the source changes for items 1-3 and one test file, `redis-outage-halts-postgres-redis.test.ts`, uncommitted.
  - I reviewed every hunk against its plan and the grant. No probe or mutant was left in a tracked file, and nothing was outside the allowed paths, so nothing was reverted.
  - I kept its design, and re-ran and extended its evidence.
  - I added: the freezable hop, the partition scenario, the event-bus deadline suite, the params integration suite and all unit tests.
  - I also refactored its outage test to shared helpers. Its default-bound scenario now uses the literal 5000 (pinned to the constant after the outage), so that with base restored it fails by the hang and not on a missing export.
  - I made the startup bound log line precise ("at most 2T after the halt … plus the PostgreSQL close"), since the pause probe measured 3T + 27 ms.
- **STOPPED sub-item: "the halt … read back from PostgreSQL"** is not met. The trader persists no halt anywhere:
  - `TraderStore` has no halt write;
  - `ops.risk_events` and `ops.incidents` exist but have no writer in `apps/trader`.
  - Adding one needs `apps/trader/src/adapters/postgres-store.ts`, which is outside the grant, and a port method beyond "halt code/bound only".
  - The test instead reads the halt from the process's exit snapshot and HALT line, reads the last durable writes back from PostgreSQL, and proves that no row was written after the halt.
- **"No order placed after the outage"** is shown on the process's own counters (plans, submissions, fills and ledger unchanged) and on the durable rows. The paper process writes no `execution.orders` row at all (`RECON2-DURABLE`), so there is no order table to read.
- **The bundle case** is not added to `app-bundles-load.test.ts`, per the packet: that file is REGISTER-1's. The output is quoted above, with a ready-made case.

## known_risks

- **Default worst case under a partition is 3T ≈ 15 s to exit.** The halt latches at T; the other 2T is spent on the courtesy QUITs to connections that still report ready. Trading stops at the halt either way.
- **A blocked event loop can cause a false halt.** If the event loop is blocked longer than T while a command is in flight, Node runs the expired timer before the socket's reply, which gives a false `Command timed out`. It is not observed; the pump has no long synchronous section while a command is in flight, and T=5 s. The 100 ms floor on the env bound is the operator's risk to take.
- **The publisher is also bounded.** `commandTimeout` applies to every `RedisStreamsEventTransport`, so the data-gateway's publisher too. A publish unanswered for 5 s now fails, and the gateway halts publication (its documented response to any publish failure) instead of stalling behind the producer queue.
  - This is ADR-003 §4-consistent.
  - A timed-out publish has an ambiguous outcome (the server may apply it after a partition heals). The gateway's halt is terminal, so it does not retry.
  - The existing write-pause tests use 400 and 500 ms and are green.
- **The params check is exact on strings:** `"0.50"` ≠ `"0.5"`. A registrant that normalizes decimals would be refused (fail-closed, but an operator surprise).
- `ioredis` internals (the parked `prevCommandQueue`, the 3 s handshake window, `blockingTimeout` resolving null) were observed on 6.0.0. An upgrade could shift which layer fires first. The transport's own deadline remains the backstop, and the tests pin the bound, not the layer.

## follow_up

- **REGISTER-1 / orchestrator:** add the bundle case above to `app-bundles-load.test.ts`. REGISTER-1's registration command must store the strategy document with numbers as `String(n)` and strings verbatim, or it will be refused by `TRADER_REGISTRATION_MISMATCH`. A single shared helper would be better; there is currently a copy in `test/integration/paper-trader/support/registration.ts`.
- **A durable halt record:** a `TraderStore` write to `ops.risk_events` or `ops.incidents` needs a grant on `postgres-store.ts` and the port.
- **Optional:** skip the courtesy QUIT on a connection known to hold an abandoned command, cutting the partition worst case from 3T to about T.
- `IMPLEMENTATION_STATUS.md` rows `BOOT1-R7`, `B1-R1-REDIS-UNCAUGHT` and `BOOT1-CONFIGPARAMS` can be updated by the orchestrator after review; `docs/**` was not touched.
- The trader's idle loop busy-polls Redis: `receive` with `waitMs` 0, about 2000 polls/s measured in the probes. This is pre-existing and not changed here; a small `waitMs` would cut the load without affecting the bound (the deadline is `waitMs + T`).

## commit_sha

`776b031b96498a274fcf6c4efb4cc7385bd34b93`

# Appendix B — Fable adversarial-reviewer report, r1 (verbatim)

VERDICT: ACCEPT

# OUTAGE-1 — independent verification, round 1 (Claude Fable)

Candidate `776b031b96498a274fcf6c4efb4cc7385bd34b93` on `outage-1`, base `586b9e2`, one commit (`git log --oneline 586b9e2..776b031` = the single OUTAGE-1 commit). Review worktree `/home/adriancova/proyects/tradeBot/polymarket-bot-outage-1-review`, detached at the candidate; the review started from a clean tree at 586b9e2 (nothing was dirty). Docker was available (required).

ACCEPT is given with ONE MEDIUM finding that needs the orchestrator's ruling, not a code round: the packet's "halt read back from PostgreSQL" sub-item is unmet by grant, was STOPPED on and disclosed per the packet's own rule, and cannot be closed inside OUTAGE-1's paths. Every claim in the handoff that I could re-run held, including the timings.

## Findings

[SEVERITY MEDIUM] OUT1-R1-HALT-NOT-DURABLE: The packet's item-2 acceptance sub-item "asserts that the halt and the last durable writes read back from PostgreSQL" is met only for the writes, not for the halt. The trader persists no halt record anywhere: `packages/trading-core/src/ports.ts` (`TraderStore`) has no halt write, and no repository under `packages/storage-postgres/src/repositories/` nor anything under `apps/trader/src/` references `ops.incidents` or `ops.risk_events` (grep verified). `test/integration/paper-trader/redis-outage-halts-postgres-redis.test.ts` reads the halt from the exit snapshot (`health: {…}`) and the `HALT GLOBAL TRANSPORT_UNAVAILABLE (FULL_HALT)` line, and reads back from PostgreSQL only the halt's consequence (decisions, checkpoints, ledger transactions, entries and PnL snapshots unchanged after the halt). This is disclosed in the handoff (`deviations`) and in the test header, and the implementer STOPPED on it as the packet instructs, because a halt write needs `apps/trader/src/adapters/postgres-store.ts` and a port method, both outside the grant. It is not a safety defect: the halt is fail-closed, latched, logged, and exit 75 is documented. Remediation: an orchestrator ruling — either accept the deviation and queue a durable halt record (a `TraderStore` write to `ops.incidents`/`ops.risk_events`; grant on `postgres-store.ts` and `ports.ts`) as a follow-up package, or extend OUTAGE-1's grant and require a remediation commit. If the deviation is not accepted, this verdict becomes CHANGES REQUIRED.

[SEVERITY LOW] OUT1-R1-READ-DEADLINE-PIN-PROBABILISTIC: The three trader-level outage scenarios pin "the process halts within T" but not the READ deadline specifically. Evidence: with mutant M1 applied (only `withDeadline` removed from `RedisStreamSubscription.#read` in `packages/event-bus/src/redis/subscription.ts`, `commandTimeout` kept), the full trader integration suite ran: the "container stopped, default T" scenario failed as intended (`STILL RUNNING` at 76 000 ms), but the IDLE-then-stopped scenario (halt +734 ms) and the PARTITION scenario (halt +1002 ms) still PASSED, because the trader's idle poll issues two round trips per poll (`XREAD` on the blocking-read connection, then `readStreamState` on the command connection) and the outage happened to land on the command connection, whose `commandTimeout` fired. The event-bus suite pins the read deadline deterministically (under M1, `response-deadline.test.ts` "a non-blocking receive fails", "a blocking receive is NOT cut short" and "an abandoned read never moves the position" all timed out), so the layered proof is complete and the pin holds. Remediation: none required this round; optionally a sentence in the trader test's header saying the trader-level scenarios pin the bound, not the layer, so a future reader does not over-read them.

[SEVERITY LOW] OUT1-R1-RESTART-NOTE: The handoff's `docker restart` row ("halt +5068 ms") is an artifact of Testcontainers re-mapping the host port on restart, which the handoff itself says. Measured here with a FIXED host port (`docker run -p 127.0.0.1:<port>:6379`, `docker restart -t 1`, 527 ms; default T=5000): the process RECOVERS — no halt, the three remaining events are consumed (6/6 processed) and the entry fills; `ioredis` resends the parked `XREAD` from `prevCommandQueue` on the reconnect (`event_handler.js` ready handler, verified in the installed 6.0.0) and the deadline set at the first issue is kept (`Command.setTimeout` guards on an existing timer). This matches the stated semantics ("an interruption the server answers within T is not an outage"). No code change; recorded so the handoff's table is not read as "a restart halts".

[SEVERITY LOW] OUT1-R1-SUBSCRIBE-CATCHALL: In `startup()` (`apps/trader/src/main.ts`, the `transport.subscribe` catch), every error that is not an `EventBusUnavailableError` — a `EventBusCheckpointError`, an `EventBusConfigurationError`, but also an unexpected programming error — is reported as `TRADER_EVENT_SUBSCRIPTION_REFUSED` (78) with the wording "the event transport refused the subscription". It fails closed, closes everything opened, and never throws (the pinned checkpoint case passes), so this is a labelling nit only. Remediation: none required; a later round could name the class of the cause in the line.

## Earlier findings re-check

None: this is the first review.

## Outage bound (packet A)

Gate runs (the candidate's own test, run twice inside `pnpm --filter @polymarket-bot/trader test:integration`; both green, both printed the measurements):
- Container STOPPED, default T=5000: `stop()` took 407 / 459 ms; after `stop()` returned, pump halted at +4631 / +4575 ms (bound T+1 s = 6000), `startup()` returned at +4632 / +4576 ms (bound 3T+1 s).
- IDLE 5000 ms at T=1000 (no halt), then STOPPED: halt +685 / +740 ms, return +686 / +740 ms.
- PARTITION (frozen hop), T=1000: halt +1000 / +1001 ms, return +3000 / +3002 ms (= 3T: both connections report ready, so each gets its bounded QUIT).
These agree with the handoff's table.

My mutations of the scenario, all through the REAL `startup()`, a real PostgreSQL and a real Redis container (a scratch test file, untracked, deleted afterwards), each verdict from the process's own exit code, `pump stopped:` line and exit snapshot:
- Stop BEFORE the first event (T=1000): HALTS. Halt +740 ms after `stop()` returned, return +741 ms, exit 75, `[["GLOBAL","TRANSPORT_UNAVAILABLE","FULL_HALT"]]`, 0 decisions.
- Stop BETWEEN events (3 of 6 processed, T=1000): HALTS. Halt +756 ms, return +756 ms, exit 75; counters at exit equal those read before the stop (eventsProcessed 3, nothing else moved); durable row counts unchanged.
- Real `docker pause` after the six events (T=1000): HALTS. Halt +1002 ms after the pause command, return +3005 ms (3T), exit 75; the detail carries the transport's own cause ("no reply to a read within 1000 ms (its own 0 ms wait plus the 1000 ms response bound)"); counters and rows unchanged (7 decisions, 2 ledger transactions before and after). No hang.
- `docker pause` for 826 ms then unpause, T=2000 (an interruption shorter than the bound): RECOVERS. No halt, healthy, the six events published after the heal are processed and the entry fills (eventsProcessed 6, fillsObserved 1, ledgerTransactions 2).
- `docker pause` for 1500 ms then unpause, T=1000 (longer than the bound, then the server comes back): HALTS and the halt is a LATCH. Halt +1003 ms, return +1532 ms (the QUITs were answered once unpaused), exit 75; six events published after the unpause were never consumed (eventsProcessed 0 at exit, 0 decisions).
- Fixed-port `docker restart` (527 ms) within the default bound: RECOVERS (see OUT1-R1-RESTART-NOTE).
Every case matches the handoff's stated semantics and §4.2 "A Redis outage stops publication and therefore halts trading": a server that stops answering for longer than T halts the process; one that answers within T does not.

## No false halts (packet B)

- Idle stream longer than the bound: the candidate's IDLE scenario (5T at T=1000, Redis up, nothing published) did not halt in either gate run (health reported no halts and healthy); the event-bus suite's "non-blocking polls spread over five bounds all answer idle" and "a blocking read whose wait is LONGER than T returns idle" both passed (the blocking read genuinely waited 4T).
- Ordinary blocking-read latency: a legitimate `BLOCK` wait is never cut short — the deadline is `waitMs + T` (`subscription.ts` `#read`), pinned by "a blocking receive is NOT cut short: it fails only after its own wait plus T".
- A slow Redis: `pauseServerWrites` at T/2 → the publish waits and succeeds; my pause-826-ms-at-T=2000 probe is the same claim at the trader level. Neither trips the bound.
- Known residual, documented by the implementer: an event loop blocked longer than T while a command is in flight would produce a false "Command timed out". The pump has no long synchronous section while a command is in flight; the 100 ms floor of `TRADER_REDIS_RESPONSE_TIMEOUT_MS` is the operator's risk.

## Fail-closed (packet C)

- Nothing trades after the outage: verified structurally (`apps/trader/src/pump.ts`: a failed poll latches the halt and returns before any drain; the drain is awaited before the commit, so no durable write is in flight when a poll fails) and by measurement (the candidate's `expectNothingTradedOrWrittenAfter`, plus my P2/P3/P5 probes: plans, submissions, fills, ledger transactions and the PostgreSQL rows unchanged; no row after the halt instant).
- The halt code and action durable: NOT met — see OUT1-R1-HALT-NOT-DURABLE. The halt is read from the exit snapshot and the HALT line; its consequence is read from PostgreSQL.
- Exit code documented: `EXIT_CODES.halted` (75) carries the OUTAGE-1 note; the bound line the process logs states T, 2T-after-halt and the PostgreSQL close; the module header states 3T from the unanswered command. The measurements agree with both.

## Startup refusal (packet D)

- Source `startup()`: `test/unit/trader/startup-redis-refusal.test.ts` (23 tests, in `pnpm run test`) — 69 with the documented line, no `at ` line, no credential, no `registration:` line (no pool opened); wrong scheme → `TRADER_REDIS_URL_REFUSED` 78; not-a-URL → 78 without echoing the value; the bound door (refused values, own-property read).
- BUILT bundle, built by me from the candidate (`pnpm --filter @polymarket-bot/trader build`, esbuild, exit 0) and run twice with the safe env and the example config:
  - `REDIS_URL=redis://bundle:not-a-real-secret@127.0.0.1:1`: the four OK lines, then `REFUSING TO START: TRADER_REDIS_UNAVAILABLE: the event transport (Redis) at redis://127.0.0.1:1 could not be reached. …`, `  EventBusUnavailableError: could not connect to the event transport; caused by Error: Connection is closed.`, `EXIT CODE: 69`. 0 stack lines, 0 occurrences of the secret. Identical to the handoff's quote.
  - A loopback listener that accepts and never answers, `TRADER_REDIS_RESPONSE_TIMEOUT_MS=1000`: the same refusal, exit 69 after 5164 ms (the handoff measured 5.17 s), 0 stack lines, no secret.
  - `dist/` deleted afterwards (verified absent).
- `startup()` never throws on this path: the unit file awaits `startup()` directly in every case.

## Parameters check (packet E)

- Registered `maximum_entries_per_market` "1" vs document 2 → `TRADER_REGISTRATION_MISMATCH`, 78, `/reentry/maximum_entries_per_market: the registered row holds "1" but the configuration states 2`, exactly one difference named, no subscription, no row written (the candidate's integration test; green in both gate runs). Under mutant M3 (`compareRegisteredParameters` returning `[]`) the same case reports `the process STARTED on parameters its registered config does not hold` and the three variants fail `expected true to be false`; the unit file loses 11 of 15.
- Key order only: every object reversed at every depth → `registration: OK` (canonical). PostgreSQL `jsonb` reorders keys on storage anyway, so this was already a precondition of every existing registration.
- Numeric string versus number — what the stored JSON holds, read back from a real row: `maximum_entries_per_market` → `["string","1"]`, `version` → `["string","1"]`, `exit.take_profit.price` → `["string","0.50"]`. The registered side holds STRINGS only (`assertDecimalSafeJson` in `packages/storage-postgres/src/repositories/strategy.ts:114` refuses a number at any depth), the document holds the strategy's numbers, and the rule `number ≡ String(n)` is symmetric (`{n:1}` vs `{n:"1"}` and the reverse both `[]`; `0.1+0.2` vs `"0.30000000000000004"` and `1e-7` vs `"1e-7"` agree). Edge: `-0` vs `"-0"` is refused (`String(-0)` is `"0"`); harmless for strategy parameters.
- Extra key → `/reentry/note: the registered row holds "registered only" but the configuration has no such field`; missing key → `/exit/allow_resolution_hold: the configuration states false but the registered row has no such field`; `"0.50"` vs `"0.5"` → refused and named. A JSON-parsed `__proto__` key is compared as an own key (probed).
- The existing BOOT-1 / TRDR-3 / BRACKET-1c / two-level / UNIV-4 PostgreSQL files pass under the new check in both gate runs (19 files / 147 tests each).

## Transport (packet F)

- The change: `responseTimeoutMs` (validated at connect, default 5000, refused outside [1, 600000]); `commandTimeout` on the COMMAND connection only; the subscription's blocking-read connection races each `XREAD` against `waitMs + T` (`withDeadline`, I/O only — the position is advanced only from a reply the caller received); handshake bounded by `connectTimeoutMs + T`; the courtesy `QUIT` sent only to a `ready` connection and bounded, then `disconnect()` always. `RedisStreamSubscription` is constructed only in `transport.ts`; `createRedisClient`/`closeRedisClient` gained optional parameters (the testing helpers call them with the old shapes; typecheck green).
- Delivery, ordering and resync semantics are untouched: `#read` only wraps the same promise; `receive`'s continuity check, `#idleOrResync`, checkpointing and the resync path are unchanged lines. "An abandoned read never moves the position" is pinned with a late reply after a heal (all three events delivered once, `deliveredTotal` 3).
- The `ioredis` account (parked `prevCommandQueue`, never flushed by `MaxRetriesPerRequestError`, resent on `ready`, `commandTimeout` timer living on the command and kept across the resend, `blockingTimeout` resolving `null`) was checked against the installed ioredis 6.0.0 (`built/redis/event_handler.js`, `built/Command.js`, `built/Redis.js`).
- Behaviour change for the gateway publisher, disclosed by the implementer: a publish unanswered for T now fails (`EventBusUnavailableError`) and the gateway halts publication, per ADR-003 §4. It is not tighter than the existing refused-connection path (`maxRetriesPerRequest` 5 flushes in about 1 s); it only bounds the stall path that used to hang. `pnpm --filter @polymarket-bot/data-gateway test:integration`: 12 files / 94 tests green; `pnpm --filter @polymarket-bot/event-bus test:integration`: 9 files / 99 tests green (the new `response-deadline.test.ts` is 18).
- Mutants at this level: M2 (`commandTimeout` removed) → publish, checkpoint and subscribe all time out; M4 (`closeRedisClient` without the ready guard and the deadline) → "closing a transport whose server went silent" times out. Each restored and sha256-verified.

## Scope and pins (packet G)

- `git diff --name-only 586b9e2 776b031`: 16 paths, all inside the grant (`packages/event-bus/**` ×7 incl. `testing/container.ts`; `apps/trader/src/main.ts`; `apps/trader/src/adapters/{redis-feed,postgres-registration}.ts`; `test/integration/event-bus/**` ×1; `test/integration/paper-trader/**` ×2; `test/unit/**` ×2). No trading-core, control-api, `db/**`, `docs/**`, REGISTER-1 or protected path. `package.json`, `pnpm-lock.yaml`, `eslint.config.mjs` unchanged. `main.ts` changes are the startup refusals (connect and subscribe contained), the bound door and its log line, and documentation — within "startup refusal / outage exit only".
- No existing test file was modified: all eight test files are ADDED (`--diff-filter=A`); `container.ts` is +112/−0. No assertion weakened.
- No `.skip`, `.only`, `.todo`, `eslint-disable`, `ts-ignore` or `ts-expect-error` in any changed file.
- Safety defaults untouched; every scenario runs with the safe env, `environment` PAPER, throwaway container credentials; no wallet, signer, credential or real order.

## Gates

All exit 0 (details in `gates-r1.txt`): typecheck (48 s); lint (17 s); check:deps (2 s); `pnpm run test` 357 files / 7689 tests (76 s; includes the 4 new unit files: 23 + 15 + 13 + 4); test:e2e 8 / 206; test:replay 3 / 17; control-api integration 10 / 87; trader integration run 1: 19 / 147 (27 s) and run 2: 19 / 147 (27 s), both running `redis-outage-halts-postgres-redis.test.ts` (4) and `registered-config-parameters-postgres.test.ts` (5) with the measurements above; event-bus integration 9 / 99; data-gateway integration 12 / 94. Counts equal the handoff's.

## Not verified

- No soak, no live gate, no execution probe; nothing here is live evidence.
- The `ioredis` observations are on 6.0.0; a different version could move which layer fires first (the transport's own deadline remains the backstop).
- The bundle case for `app-bundles-load.test.ts` is not pinned in this package (the file is REGISTER-1's); the handoff supplies the case and I reproduced its output by hand.
- GitHub CI is the orchestrator's step.
- Non-vacuity "A" as the implementer ran it (the whole base transport restored) was not repeated; my finer mutants (M1, M2, M4) cover the same mechanism per layer.

## Residuals (not findings)

- Default worst case under a partition is 3T (~15 s at the default) to exit: T to the halt, then a bounded QUIT on each of two connections that still report ready. Trading stops at the halt.
- The trader's idle loop busy-polls (`receive` with `waitMs` 0, ~2000 polls/s); pre-existing, not changed here; a small `waitMs` would cut the load without touching the bound.
- The gateway's bounded publish deserves a sentence in ADR-003/the transport docs in the owed docs round (`docs/**` was forbidden here).
- REGISTER-1's registration command must store numbers as `String(n)` and strings verbatim (as `support/registration.ts` does) or its registrations will be refused by `TRADER_REGISTRATION_MISMATCH`; the handoff says so.
- The `-t` filter given through `pnpm --filter … test:integration -- -t …` was not forwarded to vitest (the whole suite ran); this cost time only and is what exposed OUT1-R1-READ-DEADLINE-PIN-PROBABILISTIC.

## Restoration

- Review worktree at `776b031b96498a274fcf6c4efb4cc7385bd34b93`, `git status --porcelain` empty, all 1415 tracked files byte-identical to the pre-probe sha256 baseline (`sha256sum -c`), the scratch probe file deleted, `apps/trader/dist/` deleted. No commit made.
- Every mutant was applied and restored by script with a per-file sha256 check ("restored OK" ×6).
- Containers: every Testcontainers container from the gates, mutants and probes is gone; the fixed-port `redis:7.4.2-alpine` container for the restart probe was removed (`docker rm -f`); `docker ps -a` shows nothing beyond the host's pre-existing unrelated containers. REGISTER-1's worktrees and containers were never touched.
- Processes: no vitest, bundle, listener or runner process of mine remains.

REPORT COMPLETE
