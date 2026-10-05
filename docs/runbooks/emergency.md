# Runbook: the independent emergency CLI (`ops-cli`, WP-330)

Handoff §14.2, §9.18 and §15; ADR-008 §6; ADR-033 D1 item 4. Code:
`apps/ops-cli/src/emergency/`.

## Status: PAPER only, and not yet runnable from a shell

- **Every venue-touching command runs WP-260's signer gate first.** It refuses
  in PAPER, BACKTEST, SHADOW and REPLAY. It also refuses when the mode is above
  `MAX_RUN_MODE`, or when `ALLOW_REAL_ORDERS` is not exactly `true`. Under the
  repository defaults, every command refuses before it reads anything.
- **This repository binds no emergency credential and no venue** (`main.ts`).
  - The credential source answers `NO_EMERGENCY_CREDENTIAL_SOURCE`.
  - The venue answers `NO_LIVE_VENUE_BINDING`.
  - The live composition binds both after ADR-033 D5 and the live-micro gate.
- **No shell entry point yet.** `main.ts` imports workspace packages, so
  ADR-018 §4 requires an esbuild bundle. Adding one needs two things outside
  WP-330's paths:
  - a grant on `test/unit/tooling/app-bundles-load.test.ts`, which pins that
    ops-cli ships no bundle;
  - an `esbuild` devDependency.

  The `verify-venue` script is unchanged. The commands run in-process in the
  tests (`main.test.ts`, `test/integration/ops-cli/`).

## Commands

```text
ops-cli cancel-order <venue-order-id>                --account <ref> --operator <ref> --reason <text> [--dry-run] [--confirm <scope>]
ops-cli cancel-market <condition-id> [--asset <id>]  (same options)
ops-cli cancel-all                                   (same options)
ops-cli stop-heartbeat                               (same options)
ops-cli account-snapshot                             --account <ref> --operator <ref> [--reason <text>]
ops-cli reconcile                                    --account <ref> --operator <ref> [--reason <text>]
every command: [--audit-log <path>]  (else OPS_CLI_AUDIT_LOG; one of them is required)
```

Each command prints, in order:
- **PLAN**: what will happen;
- **CONFIRMATION**: for destructive commands;
- **RESULT**: what happened;
- **UNKNOWN**: what is not known;
- **AUDIT**;
- **OUTCOME**: the exit name and code.

No section is ever left out; an empty one says `none`.

| Command | Venue endpoint (cited) | Verified afterwards by |
| --- | --- | --- |
| `cancel-order` | `DELETE /order` | a read of the order by id (`/data/order`) |
| `cancel-market` | `DELETE /cancel-market-orders`, with `market`, and `asset_id` if given | a re-read of the open orders. This needs `--asset`: the open-orders read carries tokens, not markets |
| `cancel-all` | `DELETE /cancel-all`, then `DELETE /orders` by id for any order still listed | a re-read of the open orders after each step |
| `account-snapshot` | `/data/orders`, `/v2/positions`, the on-chain collateral balance, `/v2/approvals` | — |
| `reconcile` | WP-290's reads | — |
| `stop-heartbeat` | none: it revokes the fencing lease in PostgreSQL | the lease row |

The facts behind each endpoint are in `venue-facts.ts`, and every quote there
is checked against its dated report:
- `docs/venue/verified-2026-09-30.md` §2.5, C-11, E-05, E-14, E-15, E-16, §W.3;
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
| `cancel-order` | `cancel-order:<venue-order-id>` |
| `cancel-market` | `cancel-market:<condition-id>`, or `cancel-market:<condition-id>:<asset-id>` |
| `cancel-all` | `cancel-all:<account>` |
| `stop-heartbeat` | `stop-heartbeat:<account>:<fencing-lease-id>`: the lease as read now. A confirmation for an older lease never matches |

## Exit codes

| Code | Name | Meaning |
| --- | --- | --- |
| 0 | `COMPLETED` | Everything asked for happened, as the answers and the verification read show |
| 1 | `INTERNAL_ERROR` | An unexpected failure. Treat the account as unknown, and run `account-snapshot` or `reconcile` |
| 2 | `USAGE` | The arguments do not parse; nothing was done |
| 3 | `CONFIRMATION_REFUSED` | No valid scoped confirmation; nothing was done |
| 4 | `RUN_MODE_REFUSED` | WP-260's signer gate refused; nothing was done |
| 5 | `AUDIT_UNAVAILABLE` | The audit log could not record the invocation before acting; nothing was done |
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

A cancel command's exit is decided by the evidence, in this order:
1. If every request was unsent or refused, the exit is `VENUE_REFUSED`.
2. If a complete verification read exists, it decides: `COMPLETED` when nothing
   targeted is still open, and `NOT_ALL_CANCELED` otherwise.
3. Without one, the answers decide:
   - any lost answer gives `UNKNOWN`;
   - any order answered not canceled, or any request not sent, gives
     `NOT_ALL_CANCELED`;
   - otherwise the exit is `COMPLETED`.

`cancel-order` treats a read by id that finds the order as its verification:
`CANCELED`, or still open.

## The audit log (local first, database second)

Every invocation appends JSON Lines records (schema
`polymarket-bot/ops-cli-audit@1`) to the local log. This includes usage errors
when a log is named, and refusals. Each record is written in one `write` on an
`O_APPEND | O_NOFOLLOW` descriptor, `fsync`ed, then closed. A new file is
created with mode 0600, and its directory is `fsync`ed.

| Record | When |
| --- | --- |
| `INVOKED` | After the gate is evaluated, before any configuration, credential, database or venue is touched. It carries the gate's verdict |
| `ACTING` | Immediately before the first cancel or the revoke. It carries the confirmed scope and the plan |
| `OUTCOME` | After the result is known. It carries the exit, the attempts and bounded id lists |

A record that cannot be made durable stops the command before it acts. Records
hold only allow-listed fields. WP-260's `redactForLog` runs over them, and the
own-data JSON encoder writes the bytes. Do not paste a secret into `--reason`:
it is free text, and it is recorded as typed.

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
`FencingLeaseStore.revoke`. Then:

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
| A halt port | Halts are recorded, not delivered |

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
  the credential source or the venue binding. Past it, a cancel is UNKNOWN
  (it may still apply) and a read is missing, never empty. The CLI never hangs
  on a silent venue.
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
