# Runbook: the independent emergency CLI (`ops-cli`, WP-330)

Handoff §14.2, §9.18 and §15; ADR-008 §6; ADR-033 D1 item 4. Code:
`apps/ops-cli/src/emergency/`.

## Status: PAPER only

- **Every venue-touching command runs WP-260's signer gate first.** It refuses
  in PAPER, BACKTEST, SHADOW and REPLAY. It also refuses when the mode is above
  `MAX_RUN_MODE`, or when `ALLOW_REAL_ORDERS` is not exactly `true`. Under the
  repository defaults, every command refuses before it reads anything.
- **This repository binds no emergency credential and no venue** (`main.ts`).
  - The credential source answers `NO_EMERGENCY_CREDENTIAL_SOURCE`.
  - The venue answers `NO_LIVE_VENUE_BINDING`.
  - The live composition binds both after ADR-033 D5 and the live-micro gate.

## Running it from a shell

The CLI ships as an ADR-018 app-local esbuild bundle, `apps/ops-cli/dist/main.mjs`.
Its code imports workspace packages, so ADR-018 §4 requires the bundle; a
`tsc` build of it cannot run (`ERR_MODULE_NOT_FOUND`).

**Build it before you need it.** Run this from the repository root, ahead of
any incident:

```sh
pnpm --filter @polymarket-bot/ops-cli build
```

Then run the bundle with Node directly:

```sh
node apps/ops-cli/dist/main.mjs --help
node apps/ops-cli/dist/main.mjs cancel-all --account <ref> --operator <ref> --reason "<why>" --dry-run --audit-log /var/lib/pmb/ops-audit.jsonl
```

- The process's exit code is the CLI's own (see "Exit codes").
- The bundle needs nothing from the repository at run time. It can be copied,
  renamed, or linked from a `bin` directory, and it still runs: its entry guard
  compares the module's URL with the file Node runs, resolving symlinks. It does
  not test a file name.
- Output is safe to pipe, for example to `head`. A closed output (`EPIPE`) does
  not stop a command part-way: the command runs to its end, and the audit log
  still gets its `OUTCOME` record.

`pnpm --filter @polymarket-bot/ops-cli start <command> …` also works. It is
slower: it typechecks, then builds, then runs, which takes about 10 s on the
development laptop. pnpm runs it in `apps/ops-cli/`, so a relative
`--audit-log` or `OPS_CLI_CONFIG` path resolves there. Pass absolute paths.

**The pins.**
- `test/unit/tooling/app-bundles-load.test.ts` builds the bundle with the
  app's own `build` script and runs it as a child process. With PAPER and no
  credential, each emergency command must:
  - refuse with `RUN_MODE_REFUSED` (exit 4);
  - leave exactly two audit records, `INVOKED` then `OUTCOME`.
- `test/integration/ops-cli/` runs the bundle against a real PostgreSQL. Both
  records land in `ops.config_change_audit` through the bundled driver.
- `verify-venue` keeps its own `tsc` path: its code imports no workspace
  package.

## Commands

```text
ops-cli cancel-order <venue-order-id>                      --account <ref> --operator <ref> --reason <text> [--dry-run] [--confirm <scope>]
ops-cli cancel-market <condition-id> [--asset <token-id>]  (same options)
ops-cli cancel-all                                         (same options)
ops-cli stop-heartbeat                                     (same options)
ops-cli account-snapshot                                   --account <ref> --operator <ref> [--reason <text>]
ops-cli reconcile                                          --account <ref> --operator <ref> [--reason <text>]
every command: [--audit-log <path>]  (else OPS_CLI_AUDIT_LOG; one of them is required)
```

A command the gate permits prints, in order:
- **PLAN**: what will happen;
- **CONFIRMATION**: for destructive commands;
- **RESULT**: what happened;
- **UNKNOWN**: what is not known;
- **AUDIT**;
- **OUTCOME**: the exit name and code.

A section it prints is never left empty silently: an empty one says `none`.

Not every invocation reaches a command:
- **Stopped before any command runs:** a usage error, no audit log, an
  `INVOKED` record that cannot be written, or the gate's refusal. It prints no
  PLAN, RESULT or UNKNOWN. It prints what stopped it (the usage, AUDIT, RUN
  MODE, and stop-heartbeat's GUIDANCE), that nothing was read or sent, and the
  OUTCOME.
- **Stopped part-way:** its `ACTING` record cannot be written, or an unexpected
  failure. It prints the sections it reached, what stopped it, and the OUTCOME.

| Command | Venue endpoint (cited) | Verified afterwards by |
| --- | --- | --- |
| `cancel-order` | `DELETE /order` | a read of the order by id (`/data/order`) |
| `cancel-market` | `DELETE /cancel-market-orders`, with `market`, and `asset_id` if given | a re-read of the open orders. This needs `--asset`: the open-orders read carries tokens, not markets |
| `cancel-all` | `DELETE /cancel-all`, then `DELETE /orders` by id for any order still listed | a re-read of the open orders after each step |
| `account-snapshot` | `/data/orders`, `/v2/positions`, the on-chain collateral balance, `/v2/approvals` | — |
| `reconcile` | WP-290's reads | — |
| `stop-heartbeat` | none: it revokes the fencing lease in PostgreSQL | the lease row |

`--asset` takes a token id in canonical decimal, as `account-snapshot` prints
it. A `0x` id is refused as a usage error. The verification compares
`--asset`, as text, with the token of every order the open-orders read lists,
and that read lists decimal token ids only. The venue documents no hex token
lexeme: its one hex example is a placeholder, and a V2 position id is a decimal
string on the wire (`docs/venue/verified-2026-10-05.md` §12, U-13 resolved:
"Keep the selected ID as a decimal string", S-D02). A hex `--asset` would
select nothing in that read, so `cancel-market`
could report `COMPLETED` while an order in that token was still open. Convert
a hex id to decimal before you pass it.

The facts behind each endpoint are in `venue-facts.ts`, and every quote there
is checked against its dated report:
- `docs/venue/verified-2026-09-30.md` §2.1, §2.5, C-11, E-05, E-14, E-15, E-16, §W.3, U-13 (U-13 is resolved by `docs/venue/verified-2026-10-05.md` §12: decimal);
- `docs/venue/verified-2026-09-16.md` §5 and D-21.

## Confirmation (destructive commands)

A destructive command acts only after the operator names its scope:
- interactively, by typing the scope text when asked; or
- non-interactively, with `--confirm` set to exactly that text.

`--dry-run` prints the plan and the exact `--confirm` value, then does nothing.
`--yes`, `-y`, `--force`, `--non-interactive` and `--assume-yes` are refused as
usage errors. With no `--confirm` and no terminal, the command refuses; it
never waits.

| Command | Scope text |
| --- | --- |
| `cancel-order` | `cancel-order:<venue-order-id>@<account>` |
| `cancel-market` | `cancel-market:<condition-id>@<account>`, or `cancel-market:<condition-id>:<asset-id>@<account>` |
| `cancel-all` | `cancel-all:<account>` |
| `stop-heartbeat` | `stop-heartbeat:<account>:<fencing-lease-id>`: the lease as read now. A confirmation for an older lease never matches |

Every scope text names the account, so a scripted `--confirm` for one account
is refused under another `--account`.

`--confirm` can carry every scope the CLI prints. The longest is a
`cancel-order` scope with a 200-character order id and a 200-character
account: 414 characters, which is exactly the length `--confirm` accepts.

## Exit codes

| Code | Name | Meaning |
| --- | --- | --- |
| 0 | `COMPLETED` | Everything asked for happened, as far as the evidence shows. For a cancel this is either a complete verification read, or, when that read failed, the answers alone (rule 3 below). The OUTCOME record's `verified` says which, and the UNKNOWN section names the failed read |
| 1 | `INTERNAL_ERROR` | An unexpected failure. Treat the account as unknown, and run `account-snapshot` or `reconcile` |
| 2 | `USAGE` | The arguments do not parse; nothing was done |
| 3 | `CONFIRMATION_REFUSED` | No valid scoped confirmation; nothing was done |
| 4 | `RUN_MODE_REFUSED` | WP-260's signer gate refused; nothing was done |
| 5 | `AUDIT_UNAVAILABLE` | The audit log could not make a record durable before acting; nothing was done. The failed record's line may still be in the log (see "The audit log") |
| 6 | `CREDENTIALS_UNAVAILABLE` | No emergency credential, or no venue binding; nothing was sent |
| 7 | `SCOPE_MISMATCH` | The credential acts for another account than `--account`; nothing was sent |
| 8 | `NOT_ALL_CANCELED` | The venue answered, but a targeted order is still open or was answered not canceled |
| 9 | `UNKNOWN` | An answer was lost, or did not come within `venueAnswerBoundMs`, and the state afterwards could not be read. Some or all of it may have applied |
| 10 | `DRY_RUN` | The plan was shown; nothing was done |
| 11 | `BUDGET_REFUSED` | The rate-limit budget refused, or would not grant within `maxBudgetWaitMs`; nothing was sent |
| 12 | `VENUE_REFUSED` | Every request was unsent or refused unapplied |
| 13 | `READ_INCOMPLETE` | A read-only command could not read all of venue truth |
| 14 | `RECONCILE_BREAKS` | `reconcile` found breaks. Nothing was resumed or released |
| 15 | `NOTHING_TO_DO` | `stop-heartbeat` found no ACTIVE lease, or the lease ended before the revoke |
| 16 | `DATABASE_UNAVAILABLE` | `stop-heartbeat` could not reach the lease store |
| 17 | `CONFIGURATION_REFUSED` | The ops configuration is missing or invalid |
| 18 | `OUTCOME_UNRECORDED` | The command ran, but its `OUTCOME` record could not be written. The output names the command's own outcome and is the only record of it. If the log holds this invocation's `ACTING` record, **the action may already have happened**, unless the output lists that `ACTING` line as not durable. Read the account (`account-snapshot`) before acting again |

`OUTCOME_UNRECORDED` replaces the command's own exit whenever the `OUTCOME`
record is missing, so exit 0 always means the outcome is on the record.

A cancel command's exit is decided by the evidence, in this order:
1. If every request was unsent or refused, the exit is `VENUE_REFUSED`.
2. If a complete verification read exists, it decides: `COMPLETED` when nothing
   targeted is still open, and `NOT_ALL_CANCELED` otherwise.
3. Without one, the answers decide:
   - any lost answer gives `UNKNOWN`;
   - any order answered not canceled, or any request not sent, gives
     `NOT_ALL_CANCELED`;
   - otherwise the exit is `COMPLETED`, unverified (`verified: false`).

`cancel-order` treats a read by id that finds the order as its verification:
`CANCELED`, or still open.

## The audit log (local first, database second)

Every invocation appends JSON Lines records (schema
`polymarket-bot/ops-cli-audit@1`) to the local log. This includes usage errors
when a log is named, and refusals. Each record is written in one `write` on an
`O_APPEND | O_NOFOLLOW` descriptor, `fsync`ed, then closed. A new file is
created with mode 0600. Then the log's directory is `fsync`ed, for every
record, not only when the file is created: a log file that already exists does
not prove that its directory entry is durable.

| Record | When |
| --- | --- |
| `INVOKED` | After the gate is evaluated, before any configuration, credential, lease store or venue is touched. It carries the gate's verdict |
| `ACTING` | Immediately before the first cancel or the revoke. It carries the confirmed scope and the plan |
| `OUTCOME` | After the result is known, and before anything is released. It carries the exit, totals over every attempt, and bounded samples of the ids |

A record that cannot be made durable before acting stops the command
(`AUDIT_UNAVAILABLE`). An `OUTCOME` that cannot be written exits
`OUTCOME_UNRECORDED` (18), and the output says whether the command may already
have acted.

An append can fail after its line reached the file, for example when the
file's `fsync` or the directory's `fsync` fails. Its line may then be in the
log without being durable.
- The CLI never reuses that line's sequence number.
- The AUDIT section names the line, and the `OUTCOME` record lists it under
  `auditNotDurable`.
- Such a line records nothing done. In particular, an `ACTING` line listed
  there sent nothing: a command acts only after its `ACTING` record is durable.
- A short write (`SHORT_WRITE`) leaves only part of the line: a fragment that
  does not parse. So may a crash in the middle of a write. The next append
  reads the file's last byte, and when it is not a newline it writes one
  before its record. The fragment then stays on a line of its own, and the
  record after it parses, in the same invocation or a later one. This check
  is best effort: when the file cannot be read, or its path now names another
  file, the record is written as before. The check and the write are also
  separate operations, so another invocation can write between them (below).

Read the log line by line. A line that does not parse holds a fragment, and it
can also hold a complete record (`CX330-R5-01`, WP-330 round 5). Two
invocations appending to one log at the same time can interleave:
1. invocation A finds that the log ends with a newline;
2. invocation B then leaves a fragment (a `SHORT_WRITE`);
3. A's `ACTING` or `OUTCOME` record is written onto the fragment's line.

A's record is durable all the same, and A may have acted. So a line that does
not parse is not proof that nothing was done: read the whole line for a joined
record. An empty line carries nothing (two invocations writing to one log at
the same instant may leave one).

Corrected 2026-10-06 (`RECORDS-W3`, `CLOSEOUT-3` L2): was 'A line that does
not parse is such a fragment and records nothing done'.

The invocation's durable `OUTCOME` record is authoritative. When there is
none, the exit code and the printed output are.

**Every record is bounded by construction** below 256 KiB, whatever the
number of orders or batches. Ids keep the order-id alphabet and at most 200
characters. An id list keeps 200 samples and its count. A cancel command's
`OUTCOME` itemizes at most 20 attempts, by counts, with totals over all of
them. Free text has a fixed length. A sweep of 3,000 orders keeps its full
`OUTCOME`. Should a record still be too large, the `OUTCOME` is written with
the exit alone and `detailOmitted: "RECORD_TOO_LARGE"`.

The log's path must be a regular file. A symlink is refused, not followed
(`O_NOFOLLOW`). A FIFO is refused at once, not waited on (`O_NONBLOCK`).

The log's directory must be readable as well as writable by the operator,
because the CLI opens it read-only to `fsync` it. A directory it cannot sync
refuses every invocation with `AUDIT_UNAVAILABLE` (exit 5) and the code
`DIRECTORY_SYNC_FAILED`. Mode 0300 (writable, not readable) is such a
directory. Before the emergency, use a directory owned by the operator with
mode 0700.

Records hold only allow-listed fields. WP-260's `redactForLog` runs over them,
and the own-data JSON encoder writes the bytes. `--reason` is free text,
recorded as typed, with one exception: a reason that assigns a value to a
credential-like name (`NAME=value` or `NAME: value`, where NAME reads as a key,
token, secret, passphrase, signature or the like, by WP-260's
`isSensitiveKey`) is refused as a usage error and is neither repeated nor
recorded. `--account` and `--operator` are refused the same way. A bare secret
with no name cannot be told from prose: do not paste one. A usage error repeats an unknown command or option only when it reads as
a command word (lowercase letters and hyphens).

When `OPS_CLI_DATABASE_URL` is set, each record is also appended to
`ops.config_change_audit`, with the same id. The change kind is
`OPS_CLI_<COMMAND>_<PHASE>`.
- This copy is started after the local write and is **not awaited before
  acting**. A dead or hung database delays nothing.
- At the end the CLI waits up to 3 s, prints how many copies landed, and
  releases its connections within 2 s.

## Independence (§14.2)

`cancel-all` reads only venue truth (the open orders) and uses only the
emergency credential.
- It never touches the trader's process, memory or database, or the fencing
  lease.
- The package declares no trader, trading-core or control-api dependency, and
  `source-hygiene.test.ts` pins that.
- The proofs:
  - `run.cancel-all.test.ts` runs it with a database that never answers, and
    with one that refuses everything;
  - `test/integration/ops-cli/` runs it with a real refused connection.

## Rate limits (WP-310)

- **Budget.** Every request is granted by WP-310's `RateLimitBudget` first:
  - cancels as `EMERGENCY_CANCEL`;
  - reads as `RECONCILIATION_READ`.
- **Canceled count.** `clob.cancel_all` and `clob.cancel_market_orders` are
  completed with the venue's canceled count (D-21). When an answer is lost, the
  count is the number of orders listed before the cancel: a conservative
  over-debit.
- **Batch size.** A `DELETE /orders` batch carries at most the cancel bucket's
  burst minus the emergency headroom. It never carries more than 1,000 ids
  (C-11). On the dated snapshot's Standard tier that is 120.
  - The size is recomputed before every batch. It follows the tier the venue
    reports (`Poly-RateLimit-Tier`, applied by WP-310), on the cancel-all's
    answer or on any batch's, and the snapshot in effect at that instant. The
    plan prints the size at plan time; the RESULT says when it changed.
  - A batch the budget refuses unsent as `COST_EXCEEDS_CAPACITY`, because the
    capacity fell while it waited (a later snapshot took effect), is split
    again at the new size. This happens at most 8 times per sweep. Any other
    batch that is not sent stops the sweep, and the output says why.
- **Debt and waiting.** The plan prints the D-21 debt estimate. Every grant is
  waited for up to `maxBudgetWaitMs`. A request that would wait longer is not
  sent, and the output says so.
- **Cold start.** A new process starts with empty buckets, because it cannot
  see what the trader spent on the same signer.
- **The IP budget is per process.** The trader, the data gateway and this CLI
  share the host's IP, but not one budget (WP-310 known risk).

## stop-heartbeat

No heartbeat transport exists in this repository, and this CLI writes none
(ADR-033 D2, D5). `stop-heartbeat` revokes the ACTIVE fencing lease of the
account in this process's run-mode realm, through WP-320's
`FencingLeaseStore.revoke`. It reads only that realm. When it finds no lease
there, it says that other realms were not inspected: run it with the trader's
`RUN_MODE`. Then:

1. The holder's next renewal finds the lease LOST, and its fencing authority
   latches lost. At the latest this happens at its local deadline: at most
   `FENCING_LEASE_MAX_TTL_MS` (60 s) after its last successful renewal.
2. The heartbeat gate then fails, and the holder sends no further heartbeat
   (ADR-033 D1).
3. The venue cancels every open order under those CLOB API credentials 10–15 s
   after the last valid heartbeat (ADR-033 D6; S-D17, as quoted by WP-320's
   `HEARTBEAT_VENUE_FACTS`). This is documented, not observed.

So allow about 75 s, then verify with `account-snapshot`. To cancel at once,
use `cancel-all`. In PAPER the command prints this guidance and refuses.

Note that `FencingLeaseStore.revoke` itself takes no run mode. The CLI's own
signer gate is the PAPER refusal, and the database CHECK
(`fencing_leases_real_modes_only`) means no PAPER lease exists to revoke.

## reconcile (read-only)

It runs WP-290's real `ReconciliationCoordinator` once. Every write is bound to
a port that refuses and records:

| Bound to | Effect |
| --- | --- |
| An empty, read-only OMS view (this CLI holds no trader memory) | `resume()` is refused (`OMS_RESUME_BLOCKED`) |
| A journal in memory | Nothing reaches the trader's journal |
| A holdings port | Bookings are refused |

`releaseQuarantine` is never called. Every venue order reads as unattributed
here by construction. Without a ledger projection source (none is bound yet),
holdings are not compared, and the run cannot pass.

## The ops configuration (`OPS_CLI_CONFIG`)

The file has schema `polymarket-bot/ops-cli-configuration@1` and four fields:
- `rateLimitSnapshots`: WP-310 snapshots. They must define the operations the
  CLI uses: `clob.cancel_order`, `clob.cancel_orders`,
  `clob.cancel_market_orders`, `clob.cancel_all`, `clob.data_orders`,
  `clob.get_order`, `clob.get_trades`, `data.v2.positions` and
  `data.v2.approvals`. The dated contract snapshot has no `data.v2.approvals`;
  the operator must add it, or approvals are not read.
- `maxBudgetWaitMs`: the longest one rate-limit grant is waited for.
- `venueAnswerBoundMs`: the longest one answer is waited for, from the venue,
  the credential source or the venue binding, and the longest the venue
  client's release is waited for. Past it, a cancel is UNKNOWN (it may still
  apply) and a read is missing, never empty. The CLI does not hang on a silent
  venue: the venue client and the lease store (2 s) are released only after
  the `OUTCOME` record is written, each bounded, and a release that does not
  finish is reported and changes nothing.
- `reconciliation`: the collateral asset, the three durations and the required
  spenders. It has no defaults.

It is read only after the gate permits the process.

## The credential boundary (§15)

`EmergencyCredentialPort` is the CLI's own port. It is not the trader's signer
handle, and it reads no environment variable. When a live binding is written,
it must do four things:
- load from a mount reachable by the ops host only, never the trader's runtime
  mount;
- be asked only after the gate permits the process;
- return a credential that names the account it acts for. The CLI refuses a
  credential for another account (`SCOPE_MISMATCH`), because venue reads and
  cancels are per credential (E-16);
- expose nothing else to the CLI.

The environment names the CLI reads are `OPS_CLI_AUDIT_LOG`, `OPS_CLI_CONFIG`
and `OPS_CLI_DATABASE_URL`, plus `RUN_MODE`, `MAX_RUN_MODE` and
`ALLOW_REAL_ORDERS` for the gate. None is sensitive by WP-260's
`isSensitiveKey`.
