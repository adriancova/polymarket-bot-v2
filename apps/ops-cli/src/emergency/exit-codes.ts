/**
 * One exit code per outcome (WP-330 design requirement 1). A script can tell
 * every outcome apart without parsing the output, and the codes for "nothing
 * was done" are separate from the codes for "something was done, or may have
 * been".
 *
 * | Code | Name | Meaning | Was anything sent to the venue or written to the lease? |
 * | --- | --- | --- | --- |
 * | 0 | `COMPLETED` | Everything asked for happened, as far as the evidence shows. For a cancel: a complete verification read shows nothing targeted still open; OR, when no complete verification read could be made, every answer was COMPLETED and named nothing not canceled (UNVERIFIED: the UNKNOWN section says the read failed, and the OUTCOME record carries `verified: false`). For account-snapshot: every read complete. For reconcile: the run passed. For stop-heartbeat: the lease was revoked | a cancel or the revoke: yes; account-snapshot and reconcile: reads only |
 * | 1 | `INTERNAL_ERROR` | An unexpected failure inside the CLI; treat the account as UNKNOWN and reconcile | maybe |
 * | 2 | `USAGE` | The arguments do not parse | no |
 * | 3 | `CONFIRMATION_REFUSED` | No valid scoped confirmation | no |
 * | 4 | `RUN_MODE_REFUSED` | WP-260's signer gate refused (PAPER, BACKTEST, SHADOW, REPLAY, above the maximum, real orders not allowed) | no |
 * | 5 | `AUDIT_UNAVAILABLE` | The local audit log could not make a record durable (written, fsynced, its directory fsynced) before acting. A line whose append failed after its write may be in the log all the same: it is not durable and records nothing done (WP-330 r3, WP330-V3-01) | no |
 * | 6 | `CREDENTIALS_UNAVAILABLE` | No emergency credential, or no venue binding for it | no |
 * | 7 | `SCOPE_MISMATCH` | The credential belongs to another account than the one named | no |
 * | 8 | `NOT_ALL_CANCELED` | The venue answered, and at least one order was not canceled or is still listed | yes |
 * | 9 | `UNKNOWN` | An answer was lost or unreadable, and the state afterwards could not be read: some or all may have applied | maybe |
 * | 10 | `DRY_RUN` | The plan was shown; nothing was done | no |
 * | 11 | `BUDGET_REFUSED` | The rate-limit budget refused, or its wait exceeded the bound, before anything was sent | no |
 * | 12 | `VENUE_REFUSED` | The venue refused or never received every cancel; nothing was canceled | no effect |
 * | 13 | `READ_INCOMPLETE` | A read-only command could not read all of the account's venue truth | no |
 * | 14 | `RECONCILE_BREAKS` | reconcile completed and found breaks; nothing was resumed or released | no |
 * | 15 | `NOTHING_TO_DO` | stop-heartbeat: the realm has no ACTIVE, unexpired lease | no |
 * | 16 | `DATABASE_UNAVAILABLE` | stop-heartbeat: the fencing lease store could not be reached | no |
 * | 17 | `CONFIGURATION_REFUSED` | The ops configuration (rate-limit snapshot, reconciliation policy) is missing or invalid | no |
 * | 18 | `OUTCOME_UNRECORDED` | The command ran, but its OUTCOME record could not be made durable: the printed output, which names the command's own outcome and whether its ACTING record was made durable, is the only record of what happened. When the log holds this invocation's ACTING record, the action MAY ALREADY HAVE HAPPENED (WP-330 r1, WP330-V1-01) | maybe |
 *
 * `OUTCOME_UNRECORDED` replaces the command's own exit whenever its OUTCOME
 * record is missing, so exit 0 always means the outcome is on the record.
 */

export const EXIT_CODES = Object.freeze({
  COMPLETED: 0,
  INTERNAL_ERROR: 1,
  USAGE: 2,
  CONFIRMATION_REFUSED: 3,
  RUN_MODE_REFUSED: 4,
  AUDIT_UNAVAILABLE: 5,
  CREDENTIALS_UNAVAILABLE: 6,
  SCOPE_MISMATCH: 7,
  NOT_ALL_CANCELED: 8,
  UNKNOWN: 9,
  DRY_RUN: 10,
  BUDGET_REFUSED: 11,
  VENUE_REFUSED: 12,
  READ_INCOMPLETE: 13,
  RECONCILE_BREAKS: 14,
  NOTHING_TO_DO: 15,
  DATABASE_UNAVAILABLE: 16,
  CONFIGURATION_REFUSED: 17,
  OUTCOME_UNRECORDED: 18,
} as const);

export type ExitName = keyof typeof EXIT_CODES;
export type ExitCode = (typeof EXIT_CODES)[ExitName];

export function exitCodeOf(name: ExitName): ExitCode {
  return EXIT_CODES[name];
}
