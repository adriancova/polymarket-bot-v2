# REGISTER-1: an operator registration command for the paper trader

Branch `register-1` on base `586b9e2`, merged into `main` as `7f1ebc0` (`--no-ff`) on 2026-09-29.

- **Authorization:** the user's pre-H1 choice "Registration command" (2026-09-28).
- **Placement (orchestrator's ruling):** a separate entry point in the trader app. `apps/ops-cli` is WP-330's.
- **Process:** the HARDENING LOOP (workflow `wf_ac2d132c-160`, run in parallel with `OUTAGE-1`).
  - The first implementer was killed by a session limit. A fresh one continued its uncommitted work under a continuation notice.
  - The orchestrator first checked the mutant runner's backups, and every file was intact.
  - The verifier was a Claude Fable adversarial reviewer, because the evidence uses real PostgreSQL and the built bundle.

| Commit | Content |
| --- | --- |
| `f59603c` | r0 (accepted on first review) |
| `a4c1c91` | the orchestrator merged `main` (OUTAGE-1, `143ad8d`) into the branch |
| `ebf88ab` | an orchestrator integration fix, independently checked (Appendix C) |
| `7f1ebc0` | the merge |

## Outcome
**The command.** `pnpm --filter @polymarket-bot/trader run register -- <flags>`, whose bundle is `dist/register.mjs`.
- **Input.** It reads the trader document as a TEMPLATE, with the minted ids absent. Flags supply the venue facts the schema cannot carry.
- **Before any connection:** safety first, then the trader's configuration door and a dry in-memory assembly.
- **Registration.** It registers the market (with its tokens and parameter history v1), the definition (static-bracket 1.1.0), the config (the parameters exactly as the document states them, each number as its decimal string, sha256 as `parameters_hash`), the instance, and the run (PAPER, RUNNING). All of it goes through the WP-040 repositories in ONE transaction; the repositories' own transactions become savepoints.
- **Refusals.** A re-run is refused (`REGISTER_DUPLICATE`, 78). The definition and config are reused when they agree.
- **Output.** The completed document is written with O_EXCL and never overwrites a file. One JSON line of ids goes to stdout. It prints the `gammaMarketId` reminder (UNIV4-R1) and does not verify the id.
- **Unchanged:** `build`, `start` and `main.ts`.

## Evidence
- **Testcontainers.** Register, then `assembleDurableTrader`, which reports `registration: OK`, and the trader decides. The suite also covers a re-run, reuse, an existing `--out`, an unsafe environment, a template that carries ids, a malformed template, one-transaction rollback and three connection-cut outcomes. 14 tests.
- **Built bundle, by hand.** It registered; refused a re-run (78); refused an existing `--out` (73); and refused an unsafe environment (78). The real trader bundle, started on the completed document, reported `registration: OK`.
- **Mutation.** 18/18 mutants killed.
- **Integrated branch** (with OUTAGE-1): typecheck 0, lint 0, trader integration 20/161, twice.
- **CI.** PR #21 run `36541460345`:
  - attempt 1 failed only on OUTAGE-1's PARTITION outage test, a timing race queued as `OUTAGE-2`;
  - attempt 2 was green.

## Reviews
- **Fable r1 of `f59603c`: ACCEPT**, with 4 LOW findings, queued as `REGISTER1-LOWS`:
  - R1-L1: the wording of `REGISTER_REFUSED_BY_DATABASE` on an unmigrated database;
  - R1-L2: the definition and config mismatch refusals have no test (verified by hand);
  - R1-L3: the `--help` exit-code table omits some 78 codes;
  - R1-L4: a flag value of exactly `-h` or `--help` prints the usage.
- **Integration fix `ebf88ab`: Fable ACCEPT.** The assertion set is a strict superset and every assertion is mutation-proved. The merge brought exactly OUTAGE-1's diff.

## commit_sha
- Implementation: `f59603c`.
- Integration: `ebf88ab`.
- Merge: `7f1ebc0`.

# Appendix A: implementer handoff, r0 (verbatim)

# REGISTER-1 r0 — implementer handoff

## plan (written before any structural change by the first implementer; kept)

Prerequisites verified: worktree `polymarket-bot-register-1` on `register-1` at base
`586b9e2` (= main), clean; Docker server 29.1.2 with `postgres:16.6-alpine` and
`redis:7.4.2-alpine` cached; `outage-1` has no commit yet (so no Redis-unreachable
trader case is added to `app-bundles-load.test.ts`). Every repository function the
command needs is exported by `@polymarket-bot/storage-postgres` (`createCatalogRepository`
`.registerMarket`, `createStrategyRepository` `.createDefinition/.createConfig/
.createInstance/.startRun`), so no STOP.

Design (to be argued in the module headers and pinned by tests):

1. **Input = the trader configuration document as a TEMPLATE** (exactly one market,
   one instance, the five minted identity fields ABSENT) **plus required flags** for the
   facts the document does not carry (`--instance-name`, `--question-title`,
   `--neg-risk`, `--trading-delay-seconds`, `--lifecycle-state`, `--yes-label`,
   `--no-label`, `--code-commit`, `--created-by`) and `--out`. The trader schema is
   strict, so these cannot live inside the document.
2. **Order:** `--help` (pure text) → `checkPaperTraderSafety(env)` FIRST → flags →
   `DATABASE_URL` → `--out` must not exist → template read/parse → identities absent →
   `parseTraderConfig` (placeholder ids) → `parametersVersion` must be 1 → canonical
   parameters → a DRY ASSEMBLY in memory (`buildSimulatedVenue` + `createPaperTrader`
   with `InMemoryTraderStore`, the trader's own doors) → only then a database
   connection.
3. **Atomic:** one connection, one transaction. The WP-040 repositories open their
   own transactions (`registerMarket`, `createConfig`), which Kysely cannot nest, so
   the command hands them a handle whose `begin/commit/rollback` become a SAVEPOINT of
   the one outer transaction (any other transaction-control text is refused, fail
   closed). Any failure → ROLLBACK → nothing registered. Motivation: `definitions`,
   `configs`, `market_parameter_history` are append-only, so a partial registration
   could never be cleaned up.
4. **Re-run = REFUSED** (`REGISTER_DUPLICATE`, exit 78): a registered condition id,
   token id, or PAPER instance name. `strategy.definitions` (static-bracket 1.1.0) and
   `strategy.configs` (same parameters hash) are content-addressed immutable rows and
   are REUSED when they agree, refused when they disagree.
5. **Parameters:** the instance's `params` exactly as the document states them, every
   JSON number (safe integers only) rendered as its decimal string (the
   `assertDecimalSafeJson` guard refuses numbers); hash = sha256 of the exact stored
   text — identical to BOOT-1's `support/registration.ts` rendering, pinned by a test
   that compares both rows.
6. **Output:** the completed document written with `wx` (never overwrites) inside the
   transaction window, before COMMIT, removed if COMMIT fails; one JSON line of ids on
   stdout; progress + the UNIV4-R1 `gammaMarketId` reminder on stderr.
7. **Entry:** `apps/trader/src/register/main.ts`, bundled by a new `build:register`
   script to `dist/register.mjs` (same esbuild flags and `createRequire` banner as
   `build`), run by a new `register` script. `build`/`start` untouched.
8. **Tests:** `test/integration/paper-trader/register-command-postgres.test.ts`
   (Testcontainers: round trip → `assembleDurableTrader` → `registration: OK` → the
   trader decides; rows vs BOOT-1's hand registration; re-run refused; existing `--out`;
   unsafe env refuses before any connection (TCP listener proof + zero rows); atomic
   rollback on a last-step failure; definition/config reuse; template with ids;
   malformed template); a unit file under `apps/trader/src/register/` for usage/flags;
   `app-bundles-load.test.ts` extended to every esbuild script (drift guard) with
   `--help` and unsafe-env cases for the new bundle.

## continuation plan (second implementer, 2026-09-29 — the first was killed by a session limit)

State found: uncommitted work on `register-1` at base `586b9e2`; every modified or new file
is inside the allowed paths; the killed run had finished its 13-mutant pass (all KILLED,
each file restored — verified `cmp` against the runner's `.bak` copies). OUTAGE-1 still has
no commit on `main` or on `outage-1`, so no Redis-unreachable trader case is added.

Keep the design above. Changes before committing:

1. **Post-COMMIT reporting cannot lie.** Today a throw from `log`/`print` after COMMIT falls
   into the transaction's catch ("REGISTER_DATABASE_UNAVAILABLE … nothing was registered") —
   false once COMMIT succeeded. Report after COMMIT in a guarded step that says the rows
   committed; exit 0 stays "registered, document written". Pinned in the integration file.
2. **The entry guard survives a rename.** `import.meta.url.endsWith("/register.mjs")` is the
   ADR-018 renamed-bundle residual (a renamed copy exits 0 silently — for a registration
   command that is a false success code). Compare `import.meta.url` with the file URL of
   `realpath(process.argv[1])` instead; pinned by a bundle case run from a renamed copy in a
   directory whose name holds a space.
3. **`--help` states the working directory.** Relative `--template`/`--out` resolve against
   the process's cwd, which under `pnpm --filter … run register` is `apps/trader` (to be
   measured). Say so; recommend absolute paths.
4. `test/integration/paper-trader/vitest.config.ts`'s "SIX files" header is not edited
   (OUTAGE-1 adds container files in the same suite concurrently; a same-hunk edit would
   conflict) — recorded as a follow-up for the orchestrator.
5. Re-run everything myself: the mutation pass (extended for 1–2), the non-vacuity probe, the
   built bundle by hand against a throwaway migrated PostgreSQL (+ the trader bundle on the
   completed document), and every gate (trader integration twice). One commit.

(The continuation plan's items 1-4 were done; while doing item 1's review of the COMMIT path,
two further defects were found in the inherited code and fixed — see `deviations`.)

---

## summary

`REGISTER-1` adds the operator registration command H1 step 1 lacked. It is a separate
entry point of the trader app, per the orchestrator's placement ruling:
`apps/trader/src/register/main.ts`, bundled by a new `build:register` script to
`dist/register.mjs` with `build`'s esbuild flags and `createRequire` banner byte for byte,
and run by a new `register` script. `build`, `start`, `apps/trader/src/main.ts` and
`adapters/**` are untouched.

- **Input.** The trader configuration document itself, as a TEMPLATE. It holds exactly one
  market and one instance, with the five minted identities absent (`markets[0].marketId`;
  `instances[0].instanceId`, `.runId`, `.configId`, `.marketId`). The facts the strict
  trader schema cannot carry are REQUIRED flags with no defaults: the question, `negRisk`,
  the order delay, the lifecycle state, the outcome labels, the code commit, `created_by`
  and the instance name.
  - Why the document itself: the rows and the document then agree by construction, not
    because an operator copied values between two files.
  - Before any connection, the template must pass the trader's own configuration door
    (`parseTraderConfig`) and a dry assembly in memory (`buildSimulatedVenue` +
    `createPaperTrader` over `InMemoryTraderStore`). The dry assembly covers risk policy,
    allocator caps and the strategy's parameter validator.
- **Safety first.** `checkPaperTraderSafety(env)` runs before any file is read or any
  connection is attempted. Anything but a safe PAPER environment exits 78, and only PAPER
  rows are ever written.
- **Rows.** Written through the WP-040 repositories only: `registerMarket`,
  `createDefinition`, `createConfig`, `createInstance`, `startRun`. Never
  `createTradingChain`.
  - **One transaction.** The repositories' own transactions become SAVEPOINTs of one outer
    transaction on one pinned connection, and any other transaction-control statement is
    refused (fail closed).
  - **Parameters.** Stored EXACTLY as the document states them, each number as its decimal
    string. `parameters_hash` is the sha256 of that exact text. This is the same row
    BOOT-1's hand registration writes for the same document (pinned).
  - **Definition.** `static-bracket` 1.1.0, state schema 2, decision contract 1. Pinned to
    the strategy package's exports AND to what the assembled trader then writes.
- **Re-run is REFUSED.** A registered `conditionId`, token id or PAPER instance name is
  `REGISTER_DUPLICATE`: exit 78, nothing written, the existing ids named.
  - Why refuse rather than be idempotent: the market and the instance are identities, and a
    silent reuse could shadow another deployment. Three of the tables are append-only, so a
    wrong row could never be removed.
  - The content-addressed definition and config are REUSED when they agree, and refused on
    disagreement.
- **Output.** The completed document is written with `O_EXCL` (never overwrites) before
  COMMIT, and removed if the COMMIT is refused. One JSON line of ids goes to stdout;
  progress and refusals go to stderr. The UNIV4-R1 reminder says the command does NOT
  verify a `gammaMarketId`.
- **Proved against real PostgreSQL 16.6** (Testcontainers):
  - register → `assembleDurableTrader` → `registration: OK` → the trader DECIDES, with its
    decisions and checkpoints landing against the registered rows;
  - by hand with the BUILT bundle against a throwaway database I migrated myself, followed
    by the REAL trader bundle on the completed document, which answered `registration: OK`.
- **Mutation.** 18 mutants, all KILLED, each by the pin that names it.

## files_changed

Commit `f59603c`: 11 files, +3977/−16.

| file | status | lines |
| --- | --- | --- |
| `apps/trader/src/register/main.ts` | new | 757 |
| `apps/trader/src/register/arguments.ts` | new | 185 |
| `apps/trader/src/register/template.ts` | new | 381 |
| `apps/trader/src/register/registration.ts` | new | 426 |
| `apps/trader/src/register/one-transaction.ts` | new | 288 |
| `apps/trader/src/register/register.test.ts` | new, unit | 385 |
| `apps/trader/package.json` | +2: `build:register`, `register` | — |
| `test/unit/tooling/app-bundles-load.test.ts` | +259/−16 | — |
| `test/integration/paper-trader/register-command-postgres.test.ts` | new | 848 |
| `test/integration/paper-trader/support/register-command.ts` | new | 395 |
| `infra/compose/trader/README.md` | +67, docs only | — |

- **`main.ts`.** The command:
  - the order of operations, the exit codes and `--help`;
  - `writeExclusive`;
  - COMMIT failure classification: a refused COMMIT versus one whose outcome is unknown;
  - `reportRegistered`, which is total;
  - `isProcessEntry`, the entry guard.
- **`arguments.ts`.** The flags: all required, strict `parseArgs`, a repeated flag refused,
  one leading `--` dropped.
- **`template.ts`.** The template, the trader's door, the dry assembly, the canonical
  parameters and `completeDocument`.
- **`registration.ts`.** The duplicate check, definition and config reuse, and the five
  repository calls.
- **`one-transaction.ts`.** One pinned connection and one outer transaction, the SAVEPOINT
  rewrite, and the client `error` listener.
- **`register.test.ts`.** 36 unit tests.
- **`app-bundles-load.test.ts`.** Changes:
  - `SECONDARY_ENTRIES`;
  - the drift guard now covers EVERY `esbuild` script of every app;
  - a check that the secondary build equals `build` with only the entry and the outfile
    changed;
  - 4 new cases for `trader:register`: `--help`, an unsafe env, a usage error, and a
    RENAMED copy in a directory whose name holds a space;
  - `runAs` support.

  Every removed line is harness plumbing generalised from `BundledApp` to `BundleKey`. No
  `expect` was changed or removed.
- **`register-command-postgres.test.ts`.** 14 tests.
- **`support/register-command.ts`.** Template, flags and runner helpers, the connection
  counter, and the connection-cutting proxy.
- **`README.md`.** "Registering the run first (`REGISTER-1`)".

## tests_run

All were run by me in `/home/adriancova/proyects/tradeBot/polymarket-bot-register-1` at the
final tree (`f59603c`'s content). Docker 29.1.2 was available. Every gate exited 0.

| gate | result |
| --- | --- |
| `pnpm run typecheck` | exit 0 |
| `pnpm run lint` | exit 0 |
| `pnpm run check:deps` | exit 0 |
| `pnpm run test` | **354 files / 7677 tests**, exit 0 |
| `pnpm run test:e2e` | 8 files / 206 tests, exit 0 |
| `pnpm run test:replay` | 3 files / 17 tests, exit 0 |
| `pnpm --filter @polymarket-bot/control-api test:integration` | 10 files / 87 tests, exit 0 |
| `pnpm --filter @polymarket-bot/trader test:integration`, run 1 | **18 files / 152 tests**, exit 0 (`register-command-postgres.test.ts`: 14 tests) |
| `pnpm --filter @polymarket-bot/trader test:integration`, run 2 | **18 files / 152 tests**, exit 0 (`register-command-postgres.test.ts`: 14 tests) |

The unit total grows by +1 file and +43 tests from this package: `register.test.ts` adds 36,
and `app-bundles-load.test.ts` goes from 15 to 22. The base therefore computes to 353/7634;
that base was not re-run. The trader integration suite gains +1 file and +14 tests.

**New tests (names):**

- `apps/trader/src/register/register.test.ts` (36 tests).
  - **"the flags":**
    - parses every flag;
    - requires every flag and reports all at once;
    - refuses 10 bad values (`it.each`);
    - refuses a negative delay in `--flag=value` form;
    - refuses a flag given twice;
    - ignores ONE leading `--`, and no other;
    - strict parsing;
    - offers every lifecycle state but RESOLVED;
    - `--help`/`-h`.
  - **"the --help text says what the command does":**
    - documents every flag and nothing else;
    - lists every exit code;
    - does NOT verify a `gammaMarketId`, and a re-run is refused;
    - relative paths resolve against `apps/trader` under pnpm.
  - **"the refusals before any connection":**
    - `--help` in any env;
    - an unsafe env is refused FIRST;
    - a usage error is 64;
    - `DATABASE_URL` has no default.
  - **"the entry guard is keyed on the file Node runs, not on its name".**
  - **"the completed document is written exclusively"** (`O_EXCL`).
  - **"the canonical parameters":** key order and decimal strings; non-safe-integers
    refused; `__proto__` kept as a key; params must be an object.
  - **"the savepoint rewrite rule":** maps begin/commit/rollback; REFUSES all other
    transaction control; forwards everything else.
  - **"the shipped example configuration is a usable template".**
- `test/integration/paper-trader/register-command-postgres.test.ts` (14 tests).
  - **Composition:**
    - registers through the WP-040 repositories; the completed document assembles, passes
      the registration check, and the trader DECIDES;
    - writes each row as the document and the flags state it, including the config row
      BOOT-1's hand registration writes;
    - REFUSES a re-run;
    - REUSES the definition and the config (market, instance and run are new);
    - a failure to REPORT after COMMIT is said as that, and exits 0;
    - is ONE transaction: a failure at the LAST repository call leaves zero rows.
  - **Connection cuts:**
    - cut DURING a repository call: exit 69, nothing registered, and the process survives
      pg's client `error` event;
    - cut AFTER the server COMMITTED: an UNKNOWN outcome, the rows landed, and the KEPT
      document passes the trader's check;
    - cut INSTEAD of the COMMIT: an UNKNOWN outcome, nothing landed, the trader refuses the
      KEPT document, and a re-run after deleting it registers.
  - **Refusals before connecting:**
    - an UNSAFE environment is refused before any connection is ATTEMPTED (a counting
      listener, with its control);
    - never overwrites an existing `--out`;
    - refuses a template that NAMES identities;
    - refuses malformed templates, or ones the trader's doors refuse (8 cases).
  - **Non-vacuity:** a `configId` the run does not pin is `TRADER_REGISTRATION_MISMATCH`;
    a `runId` nothing registered is `_MISSING`.
- `test/unit/tooling/app-bundles-load.test.ts` (+7 tests).
  - **"EVERY script of every app that runs esbuild is covered here":** the main builds and
    each secondary entry.
  - **`trader:register`, build:** its build is the app's build with only the entry and the
    outfile changed, and its run script runs that file.
  - **"every secondary entry has at least one case".**
  - **`trader:register` cases** (4):
    - `--help`;
    - an UNSAFE env is refused;
    - a usage error;
    - a RENAMED copy in a directory whose name holds a space still runs its safety check.

**Mutation (my own run, final code; runner `mutants/run2.py`, results
`mutants/result-final.txt`).** 18 of 18 mutants were KILLED. Every file was restored
byte-identically, checked by sha256 against `mutants/pre-final.sha`.

| mutant | killed by |
| --- | --- |
| M1: savepoint rewrite off | the ONE-transaction test |
| M2: wrong `configId` in the document | the round trip |
| M3: hash not over the stored text | the rows vs BOOT-1 test |
| M4: safety skipped | the UNSAFE test |
| M5: duplicate check off | the re-run test |
| M6: mirrored state-schema drift | the round trip |
| M7: repeated flag | unit |
| M8: no `O_EXCL` | unit |
| M9: identities not checked | the has-ids test |
| M10: dry assembly skipped | the malformed test |
| M11: other transaction control forwarded | unit |
| M12: non-canonical numbers | the rows vs BOOT-1 test |
| M13: wrong `runId` | the round trip |
| M14: post-COMMIT report failure misreported | the report test |
| M15: name-keyed entry guard | the renamed-bundle case |
| M16: guard without realpath | unit |
| M17: no client `error` listener | the run fails with 3 unhandled `Error: Connection terminated unexpectedly` |
| M18: unknown-outcome COMMIT removes the document | the cut-after-COMMIT test |

**Acceptance 2: non-vacuity probe.** I applied two changes and ran the round-trip test:

- in `main.ts`, the completed document names `configId: ids.definitionId`;
- in the test, the one document-level assertion `completedInstance.configId === ids.configId`
  was removed, so the trader's check is the catcher.

The trader's own registration check refused:

```
REFUSING TO START: TRADER_REGISTRATION_MISMATCH: 1 row(s) the configuration names exist but disagree with it about a fact both state; refused rather than resolved, because choosing a winner here would silently discard a value the operator did set
  strategy.runs 01a0ebf9-3b7f-78f7-8e58-c19da493bfbe: the row pins config 01a0ebf9-3b7d-7ef6-8eb3-77602ba54944 but the configuration states configId 01a0ebf9-3b7a-703d-ad7a-2fe5bd7cf3c7 (§9.6: a run executes the config it was started with)
```

Both files were restored byte-identically (sha256). The permanent non-vacuity test also
pins `TRADER_REGISTRATION_MISMATCH` and `_MISSING` on broken completed documents.

**Acceptance 3: the built bundle by hand.** Setup:

- a throwaway `postgres:16.6-alpine` (`reg1-hand-pg`, credentials `reg1`/`reg1-throwaway`,
  127.0.0.1:63387);
- migrated by me with `packages/storage-postgres/src/cli/migrate.ts`, esbuild-bundled into
  scratch so nothing was written under `packages/`, run with `--all --directory=db/migrations`;
  0001 through 0009 went up;
- the bundle built with `pnpm --filter @polymarket-bot/trader build:register`;
- the template is `trader.config.example.json` with the five ids removed.

Full outputs are in `handrun/hand-output.txt`, `handrun/trader-output.txt` and
`handrun/cut-output.txt`.

```
=== 1. register                                           (exit=0)
safety: OK — run mode PAPER, ceiling PAPER, real orders disabled
template: OK — …/handrun/template.json: condition "REPLACE-WITH-A-REAL-CONDITION-ID", run seed 424242, account "paper-account"; the trader's configuration door and its composition root accepted it in memory
database: connected (DATABASE_URL; credentials not printed); one transaction open
catalog.markets: registered market_id 01a0ebff-9d83-7674-9462-1d7123f4cdeb (condition_id "REPLACE-WITH-A-REAL-CONDITION-ID"; tokens YES 1, NO 2; parameters version 1) — not yet committed
strategy.definitions: registered definition_id 01a0ebff-9d89-7444-9c46-74f07656f419 (static-bracket 1.1.0, state schema 2, decision contract 1) — not yet committed
strategy.configs: registered config_id 01a0ebff-9d8c-7c7d-8ce1-5e74e6069406 (version 1, parameters_hash f60a9135e367235dd23c81bcbd2f6521ce534a2b27e187260848769fcaf201b3) — not yet committed
strategy.instances: registered instance_id 01a0ebff-9d8d-7508-8887-9b9745c9039e (PAPER, "static-bracket-h1-hand", account_ref "paper-account", LIVE_OWNER, priority 0) — not yet committed
strategy.runs: started run_id 01a0ebff-9d8e-7496-9415-908fcfb055bd (PAPER, RUNNING, run_seed 424242, code_commit "586b9e24bfa221adff4eeda1ad19283456a17372") — not yet committed
committed: catalog.markets 01a0ebff-9d83-…, strategy.definitions 01a0ebff-9d89-…, strategy.configs 01a0ebff-9d8c-… v1, strategy.instances 01a0ebff-9d8d-…, strategy.runs 01a0ebff-9d8e-… — in one transaction
completed trader configuration written to …/handrun/completed.json (start the trader with TRADER_CONFIG_PATH=…/handrun/completed.json)
REMINDER (UNIV4-R1): this command did NOT verify any gammaMarketId — nothing in this repository can. Before the run, verify BY HAND that the data gateway's lifecycle block names the market whose conditionId is "REPLACE-WITH-A-REAL-CONDITION-ID", against GET https://gamma-api.polymarket.com/markets/{id}; a mis-pointed id opens this market on another market's readiness, silently.
{"registered":true,"marketId":"01a0ebff-9d83-7674-9462-1d7123f4cdeb","definitionId":"01a0ebff-9d89-7444-9c46-74f07656f419","definitionReused":false,"configId":"01a0ebff-9d8c-7c7d-8ce1-5e74e6069406","configVersion":1,"configReused":false,"instanceId":"01a0ebff-9d8d-7508-8887-9b9745c9039e","runId":"01a0ebff-9d8e-7496-9415-908fcfb055bd","completedDocument":"…/handrun/completed.json"}
=== 2. re-run, new --out                                  (exit=78; again.json not created)
REFUSING TO REGISTER: REGISTER_DUPLICATE: 4 identity(ies) this registration would create already exist, so nothing was written: …
  catalog.markets: condition_id "REPLACE-WITH-A-REAL-CONDITION-ID" is already registered as market_id 01a0ebff-9d83-7674-9462-1d7123f4cdeb
  catalog.market_tokens: token_id 1 is already registered to market_id 01a0ebff-9d83-…
  catalog.market_tokens: token_id 2 is already registered to market_id 01a0ebff-9d83-…
  strategy.instances: the PAPER instance_name "static-bracket-h1-hand" is already registered as instance_id 01a0ebff-9d8d-…
=== 3. existing --out                                     (exit=73; sha256 1f770740… before and after)
REFUSING TO REGISTER: REGISTER_OUTPUT_NOT_CREATABLE: …/handrun/completed.json already exists, and this command never overwrites a file; nothing was registered
=== 4. unsafe environment                                 (exit=78; unsafe.json not created)
REFUSING TO REGISTER: REGISTER_UNSAFE_ENVIRONMENT: the environment is not safe for a PAPER trader (§6 invariant 17, §15, ADR-010 §1), and this command registers only what that trader may run. No file was read and no connection was attempted.
  PAPER_RUN_MODE_CEILING_RAISED: MAX_RUN_MODE=LIVE …
  PAPER_RUN_MODE_NOT_PERMITTED: RUN_MODE=LIVE …
  PAPER_REAL_ORDERS_ENABLED: ALLOW_REAL_ORDERS=true …
  PAPER_LIVE_MICRO_CAP_NONZERO: LIVE_MICRO_MAX_ORDER_NOTIONAL=5 …
  PAPER_LIVE_MICRO_CAP_NONZERO: LIVE_MICRO_MAX_ACCOUNT_EXPOSURE=5 …
```

- **Rows read back with `psql`:**
  - **market:** `0.01`/`5`/`f`/`0`/`OPEN`, 12:00 to 12:15 UTC, parameters version 1;
  - **tokens:** `1` YES Up, `2` NO Down;
  - **definition:** static-bracket 1.1.0 / 2 / 1;
  - **config:** v1, `created_by` `register-1-hand-run`, parameters holding every number as
    a decimal string;
  - **instance:** PAPER, `paper-account`, LIVE_OWNER, 0, ACTIVE;
  - **run:** PAPER, RUNNING, `424242`, the HEAD commit, state schema 2.
- **Completed document minus the five ids == template:** True.
- **Hash.** `parameters_hash` recomputed by hand from the template's document-order
  rendering is `f60a9135…`, which matches.
- **The REAL trader bundle** (`pnpm --filter @polymarket-bot/trader build`, then
  `node dist/main.mjs`) was run with `TRADER_CONFIG_PATH` set to the completed document, a
  throwaway `redis:7.4.2-alpine` and the same database:

  ```
  safety: OK — run mode PAPER, ceiling PAPER, real orders disabled
  configuration: OK — 1 market(s), 1 instance(s), environment PAPER
  health endpoint: NOT configured (…)
  registration: OK — 1 market(s), 1 instance(s) and their run(s) exist and agree with the configuration
  manifest: 0 01a0ebff-9d8d-7508-8887-9b9745c9039e OWNER priority=0 market=01a0ebff-9d83-7674-9462-1d7123f4cdeb
  ```

  It then idled with no publisher until `timeout -s TERM 15` stopped it (exit 124).
- **Cut at COMMIT with the bundle.** The built bundle ran behind `handrun/cut-proxy.mjs`,
  which forwards the outer COMMIT, waits for the server's answer, then cuts the client:
  - **built bundle:** `REGISTER_COMMIT_OUTCOME_UNKNOWN: the connection failed during COMMIT
    (Error: Connection terminated unexpectedly) … The completed document was KEPT at
    …/cut-a.json …`, exit 69, and the rows landed (`0xhand-cut-a`);
  - **probe bundle** built from the source WITHOUT the listener, then restored
    byte-identically: `node:events:486 throw er; // Unhandled 'error' event … Error:
    Connection terminated unexpectedly … Emitted 'error' event on Client2 instance at:
    Client2._handleErrorEvent …`, exit 1, with no report.
- **Cleanup.** `reg1-hand-pg` and `reg1-hand-redis` were stopped (`--rm`), and
  `apps/trader/dist/` was removed. It is gitignored and held only the bundles built here.
  `git status` is clean. No process I started is running.
- **Containers not mine.** `adriancova-db-1` (up 25 h), and a `pensive_zhukovsky`
  PostgreSQL plus a ryuk that appeared during my run, most likely OUTAGE-1's tests. None was
  touched.

**Working directory under pnpm (measured).** Command:
`pnpm --filter @polymarket-bot/trader run register -- … --out package.json`, run from the
repository root. It answered `REGISTER_OUTPUT_NOT_CREATABLE:
/…/polymarket-bot-register-1/apps/trader/package.json already exists`, exit 73. So the
working directory is `apps/trader`, and the `--` reached the script and was dropped. This is
stated in `--help` and the README.

**`--help`, verbatim** (the committed bundle, `env -i`, exit 0, empty stderr):

```
usage: register --template <file> --out <file>
                --instance-name <name> --question-title <text>
                --neg-risk <true|false> --trading-delay-seconds <seconds>
                --lifecycle-state <DISCOVERED|OPEN|CLOSING|CLOSED>
                --yes-label <label> --no-label <label>
                --code-commit <commit> --created-by <who>
       register --help
       (pnpm --filter @polymarket-bot/trader run register -- <flags>; one
       leading "--" is ignored)

Registers ONE PAPER market, strategy instance and run for the paper trader
(apps/trader), and writes the COMPLETED trader configuration document that the
trader's startup registration check (BOOT-1) accepts. The rows are written
through the WP-040 repositories (registerMarket, createDefinition,
createConfig, createInstance, startRun) in ONE database transaction: either
every row lands and the document is written, or nothing is registered.

Environment:
  DATABASE_URL  the migrated WP-040 database, the same variable the trader
                reads. Required; its value is never printed.
  MAX_RUN_MODE=PAPER ALLOW_REAL_ORDERS=false LIVE_MICRO_MAX_ORDER_NOTIONAL=0
  LIVE_MICRO_MAX_ACCOUNT_EXPOSURE=0
                the trader's own PAPER safety check runs FIRST, on the
                environment, before any file is read or any connection is
                attempted. Anything but a safe PAPER environment exits 78.

Input:
  --template <file>
      The trader configuration document (the schema the trader reads from
      TRADER_CONFIG_PATH) with exactly one market and one instance, and the
      minted identities ABSENT: markets[0].marketId and instances[0].instanceId,
      .runId, .configId and .marketId. markets[0].parametersVersion must be 1.
      Before any connection it must pass the trader's configuration door and
      the trader's own composition root, in memory (risk policy, allocator
      caps, the strategy's parameter validator).
  --out <file>
      Where the completed document is written. Must not exist: it is never
      overwritten. Its directory must exist.
      Both paths resolve against the working directory, which under pnpm
      (pnpm --filter @polymarket-bot/trader run register) is apps/trader, not
      the directory pnpm was started in: pass absolute paths.
  --instance-name <name>
      strategy.instances.instance_name; unique among PAPER instances. A letter,
      then letters, digits, _ . : or -; at most 64 characters.
  --question-title <text>
      catalog.markets.question_title: the market's question, as the venue
      states it.
  --neg-risk <true|false>
      The market's negRisk flag, as the venue states it.
  --trading-delay-seconds <seconds>
      The market's order delay in whole seconds (0 or more), as the venue
      states it.
  --lifecycle-state <DISCOVERED|OPEN|CLOSING|CLOSED>
      catalog.markets.lifecycle_state at registration.
  --yes-label <label>, --no-label <label>
      The outcome labels of the YES token (yesTokenId) and the NO token
      (noTokenId), as the venue lists them.
  --code-commit <commit>
      strategy.runs.code_commit: the commit the trader is built from
      (git rev-parse HEAD).
  --created-by <who>
      strategy.configs.created_by: who is registering.

What it registers:
  catalog.markets        NEW: the document's conditionId, tickSize,
                         minimumOrderSize, openTime and closeTime, the flags'
                         venue facts, parameter history version 1, and the two
                         catalog.market_tokens (yesTokenId YES, noTokenId NO).
  strategy.definitions   static-bracket 1.1.0 (state schema 2, decision contract 1),
                         the one strategy the trader runs. REUSED when it is
                         already registered with the same versions.
  strategy.configs       the instance's params exactly as the document states
                         them, each number as its decimal string; sha256 of that
                         text as parameters_hash. REUSED when the same
                         parameters are already registered for the definition.
  strategy.instances     NEW: PAPER, accounting.accountRef, ownership
                         (OWNER -> LIVE_OWNER, SHADOW -> SHADOW),
                         evaluationPriority.
  strategy.runs          NEW: PAPER, RUNNING, the document's runSeed, the
                         code commit.

Running it again is REFUSED: a registered conditionId, token id or PAPER
instance name is a duplicate, and nothing is written (exit 78). A new run for
an existing instance is not this command's (BOOT-1: startRun, then point the
document's runId at it).

Output:
  Progress and refusals on stderr. On success, ONE JSON line on stdout with the
  minted ids and the path written. Then start the trader with
  TRADER_CONFIG_PATH=<the --out file>.

It does NOT verify a gammaMarketId (UNIV4-R1). Nothing in this repository can:
before the run, verify BY HAND that the data gateway's lifecycle block names
the market whose conditionId the document states, against
GET https://gamma-api.polymarket.com/markets/{id}.

Exit codes:
  0   registered, and the completed document written
  64  usage error; nothing was read or opened
  69  the database could not be reached or stopped answering; nothing
      registered, UNLESS the connection died during the COMMIT itself
      (REGISTER_COMMIT_OUTCOME_UNKNOWN): then the completed document is KEPT
      and the command says how to tell whether its rows landed
  70  a defect in this command; nothing registered
  73  --out exists or cannot be created; nothing registered
  78  unsafe environment, refused template, duplicate registration, or rows
      the database refused; nothing registered
```

## assumptions

- **The migrated database.** `DATABASE_URL` names a database already migrated by
  `db:migrate`; the command does not migrate. It reads the same variable the trader reads.
- **The definition row.** It pins static-bracket 1.1.0, state schema 2, decision contract 1:
  the one strategy `createPaperTrader` runs, and the `decisionContractVersion: 1` that
  `main.ts` hands the store.
  - `apps/trader` does not declare `@polymarket-bot/strategy-static-bracket`, and the
    lockfile is outside the grant, so the values are MIRRORED.
  - The integration test pins them against the package's exports and against what the
    assembled trader writes.
- **Ownership mapping.** `OWNER` → `LIVE_OWNER`, `SHADOW` → `SHADOW`. BOOT-1's check does
  not compare ownership. The trader enum is `OWNER|SHADOW`; the DB enum is
  `LIVE_OWNER|SHADOW|OBSERVER`.
- **`RESOLVED` is not offered.** `registerMarket` records no resolution time, which
  `markets_resolved_has_timestamp` requires.
- **Column grammars are enforced by the database, not pre-checked.** This covers the
  instance-name grammar (`internal.code`) and the 1–200 character identifiers. A violation
  rolls the ONE transaction back and exits 78 (`REGISTER_REFUSED_BY_DATABASE`, pinned with a
  201-character `--code-commit` at the last write).
- **OUTAGE-1.** It had no commit on `main` or on `outage-1` when I ran. Following the packet,
  the Redis-unreachable trader bundle case was NOT added.

## deviations

- **I continued a killed implementer's uncommitted work.** The first REGISTER-1 implementer
  was killed by an account session limit mid-round.
  - I inspected every file it left: all inside the allowed paths.
  - Its 13-mutant pass had finished, and every mutated file had been restored; I verified
    this with `cmp` against the runner's backups.
  - I reviewed the design and code in full and kept them.
  - I re-ran every gate and every mutant myself: none of its results are claimed here.
- **What I changed on top of it:**
  1. **A defect: a dropped connection crashed the command.** A checked-out `pg` client whose
     connection ends unexpectedly emits `error`, and `pg-pool` removes its idle listener on
     acquire. So a connection lost mid-registration was an uncaught exception: exit 1 with a
     stack trace, and no rollback message or report. Shown with the bundle above, and by
     M17's 3 unhandled errors. Fixed with a listener in `one-transaction.ts`.
  2. **A defect: the unknown-outcome COMMIT deleted the document.** When the connection died
     during COMMIT, the command deleted the completed document although its rows might have
     landed. That left the operator with committed rows, no document, and a re-run refused
     as a duplicate. The document is now KEPT for an unknown outcome, and the message names
     the arbiter (the trader's own registration check) and both remedies. `--help` exit 69
     and the `REGISTER_EXIT_CODES` docs said "nothing registered" unconditionally; now
     corrected.
  3. **A throw from reporting after COMMIT was misreported.** It fell into the
     pre-COMMIT catch, which says "the database stopped answering … nothing was registered".
     It is now `reportRegistered`: total, says `REGISTER_REPORT_FAILED`, and exits 0.
  4. **The entry guard is keyed on the file Node runs, not on `endsWith("/register.mjs")`.**
     A renamed copy would otherwise exit 0 silently, ADR-018's recorded residual. For a
     registration command that is a false success code. Pinned by a renamed-copy bundle
     case.
  5. **`--help` and the README now state the pnpm working directory** (measured) and ask
     for absolute paths.
  6. **Tests added:** 3 connection-cut scenarios and a byte-relaying cutting proxy in
     support, a report-failure test, entry-guard unit tests, and a help-text pin.
- **Not edited: the header of `test/integration/paper-trader/vitest.config.ts`.** It says
  "SIX files" need Docker, which is now seven. The packet grants new test files and support
  there, and OUTAGE-1 adds container tests to the same suite concurrently, so an edit to
  that one comment block would collide. Left for the orchestrator (follow-up).
- **The "no connection" pins use a counting TCP listener with a control, not a SQL log.**
  They prove no connection is ATTEMPTED, which is stronger than "no SQL".

## known_risks

- **Hash convention.** `parameters_hash` is the sha256 of the document-order text the
  command SENDS. jsonb reorders keys, so `sha256(parameters::text)` does NOT equal it
  (measured: `hash_of_jsonb_text = f`). This is also true of BOOT-1's hand registration. A
  checker such as OUTAGE-1's `BOOT1-CONFIGPARAMS` must compare content canonically, or
  re-render in the document's key order, not re-hash the jsonb text.
- **A killed process between the document write and COMMIT** (SIGKILL, power loss) leaves
  the completed document with no rows. The trader refuses it as
  `TRADER_REGISTRATION_MISSING`, and a re-run needs a new `--out` or the file deleted. It is
  safe, but not self-cleaning.
- **A connection lost while no statement is in flight**, for example during the document
  write, surfaces at COMMIT as "outcome unknown", although the COMMIT was never sent. The
  kept document and the trader's check still give the right answer.
- **"The trader decides" is proven in-process only.** The integration test drives
  `assembleDurableTrader` with ingested events. The hand run shows the real trader bundle
  reaching `registration: OK`, but there was no event publisher, so no decision was made in
  that process.
- **The dry assembly's scope.** It runs `createPaperTrader` in memory with placeholder ids.
  A future trader-side check that needs the database is not covered by it, but is by the
  trader's own startup.
- **Not run: the README's `jq` step 1** (`jq` is not installed here). The expression is
  standard `del(…)`; the unit test and the hand run build the same template with Python and
  TypeScript.
- **Not verified:** a real `gammaMarketId` (UNIV4-R1, by design) and GitHub CI (the
  orchestrator's step).

## follow_up

1. **The operator checklist page.** Write it from the `--help` above (packet item 4). Point
   H1 step 1 at `pnpm --filter @polymarket-bot/trader run register -- …` with absolute
   paths.
2. **OUTAGE-1 / `BOOT1-CONFIGPARAMS`.** Compare `strategy.configs.parameters` against the
   document's params rendered with numbers as decimal strings. Compare canonically (key
   order), since jsonb reorders keys. Do not recompute the hash over `parameters::text`.
3. **After OUTAGE-1 merges:** add its Redis-unreachable trader bundle case to
   `app-bundles-load.test.ts` (sequenced by the orchestrator), and update
   `test/integration/paper-trader/vitest.config.ts`'s header count ("SIX files" → include
   `register-command-postgres.test.ts`) in whichever round lands second.
4. **Possible later commands, recorded as out of scope and refused as duplicates today:**
   - a second RUN for an existing instance (BOOT-1's remedy after a run holds decisions:
     `startRun` + repoint `runId`);
   - a second instance on a registered market.
5. **ADR-018.** The trader, control-api and backtest-cli entry guards keep the renamed-bundle
   residual. `isProcessEntry` here is a pattern they could adopt; that is not this grant's.

## commit_sha

`f59603cc5a10cab8d91bb7a2f9ffa203a59ba823` (`f59603c`), on branch `register-1`, base
`586b9e2`. One commit, not pushed.

# Appendix B: Fable adversarial-reviewer report, r1 (verbatim)

VERDICT: ACCEPT

# REGISTER-1 — verification round 1 (Fable adversarial reviewer)

Candidate `f59603cc5a10cab8d91bb7a2f9ffa203a59ba823` (branch `register-1`, one commit on base `586b9e2`). Review worktree `/home/adriancova/proyects/tradeBot/polymarket-bot-register-1-review`, detached at the candidate. Gates: `/tmp/claude-1000/-home-adriancova-proyects-tradeBot-polymarket-bot/083749fa-1d4c-4735-b241-48f81129d71c/scratchpad/register-1/gates-r1.txt`. Evidence (gate logs, hand-run outputs, mutant summaries): `…/scratchpad/register-1/fable-r1-evidence/`.

Every acceptance criterion of the packet holds against real PostgreSQL 16.6 and the built bundle; the handoff's claims reproduced one for one, including its measured working directory, its hash, its hand-run outputs and the three mutants I spot-checked. The findings below are all LOW: wording, an untested (but working) refusal pair, a `--help` enumeration gap and a flag-value quirk. None blocks H1 step 1.

## Findings

[SEVERITY LOW] R1-L1: `REGISTER_REFUSED_BY_DATABASE` says "the database refused a row" when the statement that failed was the duplicate-check SELECT on an UNMIGRATED database.
Evidence: built bundle against a freshly created, unmigrated database → `REFUSING TO REGISTER: REGISTER_REFUSED_BY_DATABASE: the database refused a row (error: relation "catalog.markets" does not exist; SQLSTATE 42P01); the one transaction was rolled back, so nothing was registered`, exit 78, no output file (correct outcome, imprecise wording; `--help`'s 78 line says "rows the database refused"). File: `apps/trader/src/register/main.ts` `writeFailed`, `refusedByDatabase`. Remediation (minimal): branch on SQLSTATE class `42` (`42P01` undefined_table) with a line naming the remedy (`DATABASE_URL` is not migrated: run `db:migrate`), or say "refused a statement" rather than "a row".

[SEVERITY LOW] R1-L2: `REGISTER_DEFINITION_MISMATCH` and `REGISTER_CONFIG_MISMATCH` have no test; verified by hand to work.
Evidence: planted `static-bracket 1.1.0` with `state_schema_version 1` → `REGISTER_DEFINITION_MISMATCH … state_schema_version 1 (the trader runs 2)`, exit 78, zero rows, no file. Planted a config carrying the template's hash `f60a9135…` with other content → `REGISTER_CONFIG_MISMATCH … stored: {"strategy":"static-bracket","version":"1"} / document: {…}`, exit 78, zero new rows, no file. Neither `register-command-postgres.test.ts` nor `register.test.ts` pins either code or its no-write property; the handoff's 18-mutant table has no mutant for them. File: `apps/trader/src/register/registration.ts` `registerRows`. Remediation: one Testcontainers case that pre-registers a drifted definition through `createStrategyRepository(db).createDefinition` (a repository, so no `createTradingChain`) and a config with a forged hash through `createConfig`, then asserts both codes, exit 78 and `ZERO_ROWS`.

[SEVERITY LOW] R1-L3: `--help`'s exit-code table lists 78 as "unsafe environment, refused template, duplicate registration, or rows the database refused", which does not name `REGISTER_NO_DATABASE`, `REGISTER_DEFINITION_MISMATCH` or `REGISTER_CONFIG_MISMATCH` (all 78).
Evidence: `USAGE` in `apps/trader/src/register/main.ts` versus `REGISTER_EXIT_CODES.refused` return sites (`REGISTER_NO_DATABASE` at the `DATABASE_URL` check; the two mismatches from `registerRows`). The unit pin "lists every exit code" checks the numbers, not the reasons. Remediation: add "a missing DATABASE_URL, or a registered definition/config that disagrees" to the 78 line.

[SEVERITY LOW] R1-L4: `asksForHelp` scans every argv token, so a flag VALUE that is exactly `-h` or `--help` prints the usage and exits 0 instead of registering.
Evidence: `apps/trader/src/register/arguments.ts` `asksForHelp` = `argv.some(token => token === "--help" || token === "-h")`; e.g. `--no-label -h` cannot be expressed. Harmless (exit 0 with the usage, nothing written, nothing read), but undocumented. Remediation: treat `--help`/`-h` only when it is the first token or when `parseArgs` reports it as an option (add `help: { type: "boolean", short: "h" }` to OPTIONS), or state the rule in `--help`.

## Earlier findings re-check
None: this is the first review.

## Round trip
- New test run twice as part of the gates: `pnpm --filter @polymarket-bot/trader test:integration` → 18 files / 152 tests, exit 0, both runs; `register-command-postgres.test.ts` 14/14 both times (24.3 s, 15.8 s).
- The test's round trip is the real thing: `runRegisterCommand` (the exact function the bundle's process shell calls) → fresh migrated Testcontainers database → the written document handed unchanged to `assembleDurableTrader` → `registration: OK` → six ingested events → `decisionsPersisted ≥ 1`, an `enter` decision and a checkpoint under the minted `run_id`/`instance_id`/`market_id`. No row is seeded outside the command; `createTradingChain` appears nowhere in the new files (grep).
- By hand with the BUILT bundle (`build:register`'s exact esbuild line, outfile in scratch): throwaway `postgres:16.6-alpine`, migrated by me with the bundled `migrate.ts` (`--all`, 0001–0009 up), template = `trader.config.example.json` minus the five ids. Exit 0; stderr shows safety → template → connected → the five repository lines "not yet committed" → `committed: … in one transaction` → the written path → the UNIV4-R1 reminder; stdout one JSON line with the ids. Rows 1/2/1/1/1/1/1.
- Then the REAL trader bundle (`build`'s esbuild line) on the completed document with a throwaway `redis:7.4.2-alpine` and the same database: `safety: OK`, `configuration: OK`, `registration: OK — 1 market(s), 1 instance(s) and their run(s) exist and agree with the configuration`, `manifest: 0 <instanceId> OWNER priority=0 market=<marketId>`; idled with no publisher until SIGTERM at 20 s (exit 124). The trader deciding is proven in-process by the test (as the handoff says); the bundle process had no publisher.
- Non-vacuity (acceptance 2): the permanent test breaks `configId` and `runId` on the completed document and gets `TRADER_REGISTRATION_MISMATCH` (`the row pins config … but the configuration states configId …`) and `TRADER_REGISTRATION_MISSING`; the control document assembles. The handoff's probe (document names `definitionId` as `configId`, document-level assertion removed, the trader refuses) is consistent with that pin.

## Rows
Read back with `psql` from the hand registration:
- `catalog.markets`: `condition_id REPLACE-WITH-A-REAL-CONDITION-ID`, `question_title` = flag, `tick_size 0.01`, `minimum_order_size 5`, `trading_delay_seconds 0`, `neg_risk f`, `lifecycle_state OPEN`, `open/close 2026-03-04 12:00/12:15+00`, `current_parameters_version 1`, `resolved_at NULL`.
- `catalog.market_tokens`: `1 YES Up`, `2 NO Down`. `market_parameter_history`: one row, version 1, `source polymarket`.
- `strategy.definitions`: `static-bracket 1.1.0`, state schema 2, decision contract 1 — equal to `STATIC_BRACKET_NAME/VERSION/STATE_SCHEMA_VERSION` (read from `packages/strategies/static-bracket/src`) and to `main.ts`'s `decisionContractVersion: 1`; the test pins all three against the package exports AND against what the assembled trader writes.
- `strategy.configs`: v1, `parameters_hash f60a9135e367235dd23c81bcbd2f6521ce534a2b27e187260848769fcaf201b3`, `created_by` = flag, `parameters` = the document's params with EVERY number a decimal string (`"version":"1"`, `"cooldown_seconds":"30"`, `"order_validity_ms":"30000"`, …). Recomputed by hand: sha256 of `JSON.stringify(params rendered in document order)` = `f60a9135…` (match). `sha256(parameters::text)` ≠ hash (jsonb reorders keys) — the handoff's known risk, confirmed; OUTAGE-1's `BOOT1-CONFIGPARAMS` must compare canonically.
- `strategy.instances`: PAPER, `paper-account`, `LIVE_OWNER`, priority 0, `ACTIVE`, pinned to the definition and config. `strategy.runs`: PAPER, `RUNNING`, `run_seed 424242`, `code_commit` = the candidate SHA, `state_schema_version 2`, `ended_at NULL`.
- Versus BOOT-1's hand registration (`support/registration.ts`): the test registers the same params through both and asserts `parameters` and `parameters_hash` equal (`hashOf` is sha256-hex of the same `JSON.stringify` text). Instance and run columns agree with BOOT-1's shape (`LIVE_OWNER`/0/`ACTIVE`, PAPER/RUNNING/424242). The definition differs on purpose: BOOT-1's fixture writes `static-bracket-<label> 0.1.0`/schema 1 (a test label), the command writes the strategy's real name/version/schema, which is what the trader's checkpoints then carry (pinned).
- Completed document minus the five ids == template (byte-equal JSON); ids are the first keys of each object; `markets[0].marketId == instances[0].marketId`.

## Hazards
All by hand with the built bundle unless stated:
- Re-run (same template, new `--out`): `REGISTER_DUPLICATE: 4 identity(ies) …` naming the market, both tokens and the PAPER instance name, exit 78, no file, row counts unchanged. Different instance name, same market: 3 duplicates named, refused. (Test: also the "same name, other market" case.)
- Unsafe environment (all four defaults weakened) with a NONEXISTENT template and a closed-port `DATABASE_URL`: `REGISTER_UNSAFE_ENVIRONMENT … No file was read and no connection was attempted.` with every violation code, exit 78, no file — a read would have shown `TEMPLATE_UNREADABLE`, a connection `DATABASE_UNAVAILABLE`; neither appeared. The test proves "no connection ATTEMPTED" with a counting listener plus a control that does connect.
- Existing `--out` (the completed document itself): exit 73 before `database: connected`, file sha256 unchanged. Nonexistent `--out` directory: exit 73. `O_EXCL` at write time pinned by the unit test.
- Partial failure: 201-character `--code-commit` passes the CLI and is refused at `startRun`, the LAST write, after four "registered … not yet committed" lines → `REGISTER_REFUSED_BY_DATABASE … SQLSTATE 23514`, exit 78, all seven tables at zero rows, no file. Kysely 0.29.5's `PostgresDriver` sends exactly `begin`/`commit`/`rollback` (read in `dist/dialect/postgres/postgres-driver.js`), so the savepoint rewrite covers the repositories' transactions; `Transaction.transaction()` throws, as the module says.
- Connection cuts (test, byte-relaying proxy): cut during `startRun` → 69, zero rows, process survives pg's `error` event; cut after the server's COMMIT answer → 69 `REGISTER_COMMIT_OUTCOME_UNKNOWN`, rows landed, KEPT document accepted by the trader; cut instead of COMMIT → 69, zero rows, trader refuses the kept document, delete-and-rerun registers.
- Concurrency (double invocation of the same fresh market, in parallel): one exit 0, the other `REGISTER_REFUSED_BY_DATABASE … markets_condition_id_unique; SQLSTATE 23505`, exit 78, no second file, exactly one market row: the database backstops the unlocked duplicate check.
- Malformed input: not-JSON → `TEMPLATE_UNREADABLE`; a float in params → `TEMPLATE_NOT_REGISTRABLE … 30.5 is not a safe integer` (decimal rule kept: numbers become exact decimal strings or are refused); the test adds an array, two instances, `environment: LIVE`, a strategy the validator refuses, a raised live-micro cap, `parametersVersion 2` — all refused before any connection.
- A document with ids (the shipped example itself): `TEMPLATE_HAS_IDENTITIES` naming all five fields, exit 78.
- Unreachable database: 69 `REGISTER_DATABASE_UNAVAILABLE (ECONNREFUSED)`. No `DATABASE_URL`: 78 `REGISTER_NO_DATABASE`. Unmigrated database: see R1-L1.
- Mutation spot-check (3 of the handoff's 18, register test file only, each file restored and sha256-verified): savepoint rewrite off → 4 tests fail (the one-transaction test and all three cuts); unknown-outcome COMMIT removes the document → both COMMIT-cut tests fail; a throw while reporting after COMMIT propagates → the report test fails.

## Bundle
- `build:register` is `build` with only the entry and the outfile changed (same flags, same `createRequire` banner, byte for byte — pinned by the new drift test); `build`/`start` are byte-identical to base (diff: two added lines only). `register` = typecheck + build:register + `node ./dist/register.mjs`.
- `app-bundles-load.test.ts`: 22 tests pass; the drift guard now scans EVERY `esbuild ` script of every app (non-vacuity: it must find `trader/build`); 4 cases for `trader:register` (`--help`; unsafe env refused with nothing read; usage error after `safety: OK`; a RENAMED copy in a directory with a space still refuses). No `expect` removed (grep of the diff); existing case titles unchanged.
- Built and run by the gates in `apps/trader/dist` (2.3 MB): no args → `safety: OK` then `REGISTER_USAGE` listing every flag, exit 64 (also under `env -i`: the safety defaults are PAPER, the trader's own behaviour); `--help` → 107 lines on stdout, empty stderr, exit 0. `dist/` deleted afterwards.
- Entry guard by hand: renamed copy in a directory with a space, a symlink with a space, and a relative `./` invocation all refuse with 78; importing the module runs nothing; CONTROL: the trader's own bundle renamed exits 0 silently (ADR-018's residual, which the register command does not share).
- Working directory under pnpm, measured: `pnpm --filter @polymarket-bot/trader run register -- … --out package.json` → `REGISTER_OUTPUT_NOT_CREATABLE: …/apps/trader/package.json already exists`, exit 73 (pnpm reports it as `ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL`); the leading `--` reached the script and was dropped, as `--help` says.

## Honesty
- The command does NOT claim to verify `gammaMarketId`: `--help` says "It does NOT verify a gammaMarketId (UNIV4-R1). Nothing in this repository can", and every success prints `REMINDER (UNIV4-R1): this command did NOT verify any gammaMarketId …` naming the document's `conditionId` (seen in the hand run and pinned by the test and the bundle case).
- `--help` is accurate to the behaviour on every point I measured: order (safety first, before any file or connection), required flags with no defaults, `--out` never overwritten and its directory must exist, absolute paths under pnpm, instance-name grammar (= `internal.code`: `^[A-Za-z][A-Za-z0-9_.:-]*$`, ≤ 64), `RESOLVED` excluded (the `markets_resolved_has_timestamp` reason is real), reuse rules, re-run refused, exit 69's COMMIT exception, exit 73/78 semantics. Gaps: R1-L3 (78's enumeration), R1-L4 (`-h` as a value).
- The handoff reports its deviations (a continued killed run; five defects found and fixed on top; the deliberately unedited "SIX files" header) and its risks (hash convention vs jsonb text; SIGKILL between write and COMMIT; "decides" proven in-process only; `jq` not run) accurately. Its numbers (354/7677, 8/206, 3/17, 10/87, 18/152 twice, 36 + 22 unit tests, 14 integration tests) all reproduced.

## Scope and pins
- `git diff --name-only 586b9e2 f59603c`: 11 paths — `apps/trader/src/register/{main,arguments,template,registration,one-transaction,register.test}.ts` (new), `apps/trader/package.json` (+2 scripts), `test/unit/tooling/app-bundles-load.test.ts`, `test/integration/paper-trader/register-command-postgres.test.ts` and `support/register-command.ts` (new), `infra/compose/trader/README.md` (+67 docs lines). All inside the allowed set; `scope_violations` empty.
- Root `package.json`, `pnpm-lock.yaml`, `eslint.config.mjs` unchanged. `apps/trader/src/main.ts`, `adapters/**`, `packages/**`, `db/**`, `docs/**`, `.github/**` untouched. `register/main.ts` imports nothing from `main.ts`.
- No `.skip`, `.only`, `eslint-disable`, `ts-ignore`, `ts-expect-error` in the added lines. No type assertion in `register/` (the cast-scan suite walks `apps/trader/src`, and `pnpm run test` passed).
- Safety defaults untouched; the command hard-codes `environment: "PAPER"` for the instance and the run, and the template must pass `parseTraderConfig`, which refuses `environment: LIVE` (tested). No credential, signer, venue call or real order anywhere in the new code.

## Gates
All exit 0 (details in `gates-r1.txt`): typecheck; lint; check:deps; test 354 files / 7677 tests; test:e2e 8 / 206; test:replay 3 / 17; control-api integration 10 / 87; trader integration 18 / 152, twice, with `register-command-postgres.test.ts` 14/14 both times; `build:register` built; the bundle with no args exits 64 and with `--help` exits 0; `dist/` removed.

## Not verified
- GitHub CI (the orchestrator's step).
- A real `gammaMarketId` (UNIV4-R1, by design) and any real venue fact: the hand run used the example's placeholder `conditionId` and token ids 1/2.
- The README's `jq` step (jq is not installed here either); the expression is standard `del(…)` and the unit test builds the same template in TypeScript.
- The trader DECIDING from the bundle process (no publisher); proven in-process by the test only.
- 15 of the handoff's 18 mutants (3 spot-checked, all killed as claimed).

## Residuals
- `test/integration/paper-trader/vitest.config.ts`'s header still says "SIX files" need Docker (now seven); deliberately left for the round that lands after OUTAGE-1 (handoff follow-up 3).
- A SIGKILL between the document write and COMMIT leaves a document that names no rows; the trader refuses it as `TRADER_REGISTRATION_MISSING` and a re-run needs a new `--out` (handoff known risk; safe, not self-cleaning).
- The duplicate check takes no lock; a concurrent second registration is refused by the unique constraints with 78 rather than `REGISTER_DUPLICATE` (measured; correct outcome, different code).
- The definition/config reuse does not compare `params_schema` or `description` of an existing definition (descriptive columns only).
- `--help` runs after `pnpm run typecheck && build:register` under the `register` script (~40 s before the usage prints); the bundle's own `--help` is instant.

## Restoration and processes
- Review worktree at `f59603cc5a10cab8d91bb7a2f9ffa203a59ba823`; `git status --porcelain` empty; `git diff --stat` against the candidate empty; the three mutated files restored and sha256-verified against pre-mutation hashes; `apps/trader/dist` absent. No commit was made.
- Containers I started (`reg1-review-pg`, `reg1-review-redis`, both `--rm`) are stopped and gone. The Testcontainers containers and ryuk seen during the review belonged to my gate/mutant runs (all finished) or to OUTAGE-1's concurrent data-gateway suite in another worktree, which I did not touch. No process with its cwd in the review worktree is running.
- The review scratch directory `…/scratchpad/register-1/review-scratch/` was deleted; the text evidence was moved to `…/scratchpad/register-1/fable-r1-evidence/`.

REPORT COMPLETE

# Appendix C: independent check of the orchestrator integration fix `ebf88ab` (Fable)

VERDICT: ACCEPT

Scope: ebf88ab (the HEAD of register-1, the orchestrator's integration fix) and its merge parent a4c1c91, in /home/adriancova/proyects/tradeBot/polymarket-bot-register-1. The review was read-only, except for temporary mutation probes on one tracked file; each was restored byte-identically and sha256-verified.

1. The assertion set against verifyRegisteredRows at HEAD. The diff touches only test/integration/paper-trader/register-command-postgres.test.ts, at lines 796 and 816-821:
- the `it` title;
- a 4-line comment;
- the code assertion, changed from _MISMATCH to _MISSING;
- ONE added line asserting `strategy.configs: no row with config_id ${otherConfig}`.

The run-pin assertion, the runId case and the control are unchanged.

Traced in postgres-registration.ts `verify()`:
- the strategy.runs block pushes the run-pin mismatch;
- the strategy.configs block pushes "strategy.configs: no row with config_id …";
- in the precedence, missing wins, giving TRADER_REGISTRATION_MISSING with the issues ordered [...missing, ...mismatched, ...notResumable], so the run-pin line IS emitted under _MISSING.

`assembleDurableTrader` logs the code line and then each issue, and exits with 78 for both _MISSING and _MISMATCH.

WEAKENING: none. The new set is a strict superset of the refusal lines:
- old: {code, run-pin};
- new: {code, configs-missing, run-pin}.

MUTATION EVIDENCE (single test; file restored after each; sha256 equal to HEAD):
- Mutant A (run-pin check disabled): FAILS at the run-pin line.
- Mutant B (configs missing.push disabled): FAILS at the configs-missing line; the output shows only the run-pin line, under _MISMATCH.
- Mutant C (both): FAILS at `expect(result.ok).toBe(false)`, because the broken document assembled.

2. MERGE a4c1c91.
- `git diff f59603c a4c1c91` is byte-identical to `git diff 586b9e2 143ad8d` (16 files, +2500/-28).
- The symmetric diff also holds.
- There is no overlap between the two rounds' paths.
- Only the test file changed from a4c1c91 to HEAD.

3. TEST RUN:
- register-command-postgres 14/14;
- registered-config-parameters-postgres 5/5;
- 19/19 in total, exit 0, with no unhandled errors in the clean run;
- tsc on the paper-trader tsconfig: exit 0;
- eslint on the touched files: exit 0.

FINDINGS (all INFO):
- R1-INT-1: the full-suite figure of 161 was not independently reproduced by this review.
- R1-INT-2: the mutant runs print a pre-existing "terminating connection" unhandled-error block after the real assertion failure (the fixture's close behaviour, documented in the test).
- R1-INT-3: no stale prose promises _MISMATCH.

CLEANLINESS: the worktree is clean at ebf88ab, and no container is left running.
