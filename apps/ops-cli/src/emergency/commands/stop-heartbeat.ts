/**
 * stop-heartbeat (handoff §14.2; ADR-033 D1 item 4: "`ops-cli stop-heartbeat`
 * (§14.2). The command and its guidance are `WP-330`'s"; WP-320).
 *
 * NO HEARTBEAT TRANSPORT EXISTS, AND THIS COMMAND WRITES NONE (ADR-033 D2,
 * D5). It never sends, withholds or forges a heartbeat. It stops the trader's
 * heartbeat the one way WP-320 provides: it REVOKES THE FENCING LEASE through
 * WP-320's `FencingLeaseStore.revoke`. Then:
 *
 * 1. the holder's next renewal finds the lease LOST; its fencing authority
 *    latches lost (WP-320 `fencing-authority.ts`: `RENEW_LOST`), at the latest
 *    at its local deadline, at most `FENCING_LEASE_MAX_TTL_MS` after its last
 *    successful renewal;
 * 2. the heartbeat gate fails, and the controller sends nothing more
 *    (ADR-033 D1 items 2, 5);
 * 3. the venue cancels every open order under those credentials 10 s after
 *    the last valid heartbeat, up to 5 s later for its sweep: 10–15 s
 *    (ADR-033 D6; ADR-008 §4; S-D17, quoted from WP-320's
 *    `HEARTBEAT_VENUE_FACTS.TIMEOUT_AND_SWEEP`). DOCUMENTARY ONLY: no round
 *    has observed it.
 *
 * In PAPER (and BACKTEST, SHADOW, REPLAY) the command prints that guidance
 * and REFUSES before touching the database: a PAPER process holds no live
 * lease (the `fencing_leases_real_modes_only` CHECK; WP-320's store refuses to
 * acquire one) and sends no heartbeat. The refusal is the CLI's own signer
 * gate, run first: `FencingLeaseStore.revoke` itself takes no run mode.
 *
 * In a live mode the command reads the realm's ACTIVE lease, prints it, asks
 * for the scope `stop-heartbeat:<account>:<lease-id>`, writes the `ACTING`
 * record, and revokes exactly that lease (a lease that changed since it was
 * read is not revoked: `revoke` matches it by id and ACTIVE).
 */

import { HEARTBEAT_TIMEOUT_MS, HEARTBEAT_VENUE_FACTS, VENUE_CANCELLATION_CHECK_INTERVAL_MS } from "@polymarket-bot/polymarket-secure";
import { FENCING_LEASE_MAX_TTL_MS, FENCING_REASON_MAX_LENGTH } from "@polymarket-bot/storage-postgres";

import { scopeDescription, scopeText } from "../confirmation.js";
import { confirmThenRecord, type CommandContext, type CommandResult } from "../context.js";
import type { FencingLeaseAccessFactory } from "../ports.js";
import { SECTIONS, type Printer } from "../printer.js";

const SECONDS = 1000;

/** The guidance, printed by every stop-heartbeat invocation, before the gate's verdict. */
export function stopHeartbeatGuidance(): readonly string[] {
  const fact = HEARTBEAT_VENUE_FACTS.TIMEOUT_AND_SWEEP;
  const earliest = HEARTBEAT_TIMEOUT_MS / SECONDS;
  const latest = (HEARTBEAT_TIMEOUT_MS + VENUE_CANCELLATION_CHECK_INTERVAL_MS) / SECONDS;
  const lease = FENCING_LEASE_MAX_TTL_MS / SECONDS;
  return [
    "stop-heartbeat revokes the account's ACTIVE fencing lease (WP-320 FencingLeaseStore.revoke). It sends no heartbeat request and withholds none: no heartbeat transport exists in this repository, and this CLI writes none (ADR-033 D2, D5)",
    "1. the lease holder's next renewal finds the lease LOST; its fencing authority latches lost, at the latest at its local deadline, at most " +
      `${String(lease)} s after its last successful renewal (FENCING_LEASE_MAX_TTL_MS)`,
    "2. the heartbeat gate then fails, and the holder sends no further order heartbeat (ADR-033 D1)",
    `3. the venue then cancels every open order under those CLOB API credentials ${String(earliest)}–${String(latest)} s after the last valid heartbeat (ADR-033 D6). Documented, not observed: "${fact.quote}" (${fact.source} ${fact.section})`,
    `so allow up to about ${String(lease + latest)} s from the revoke, then VERIFY with account-snapshot: never assume the orders are gone. To cancel at once, use cancel-all (it does not need the lease)`,
    "revoking also blocks the holder from submitting (the database refuses an attempt under a revoked lease, WP-320); a successor can take over only after waiting out the bound (ADR-008: failover is not instant)",
  ];
}

export function printStopHeartbeatGuidance(printer: Printer): void {
  printer.section(SECTIONS.GUIDANCE, stopHeartbeatGuidance());
}

function revocationReason(operator: string, reason: string | null): string {
  const text = `ops-cli stop-heartbeat by ${operator}: ${reason ?? "(no reason)"}`;
  return text.length > FENCING_REASON_MAX_LENGTH ? text.slice(0, FENCING_REASON_MAX_LENGTH) : text;
}

export async function runStopHeartbeat(context: CommandContext, leasesFactory: FencingLeaseAccessFactory): Promise<CommandResult> {
  const { parsed, printer, gate } = context;
  let opened: Awaited<ReturnType<FencingLeaseAccessFactory["open"]>>;
  try {
    opened = await leasesFactory.open();
  } catch {
    opened = { kind: "UNAVAILABLE", reason: "OPEN_FAILED" };
  }
  if (opened.kind !== "OPEN") {
    printer.section(SECTIONS.PLAN, [`read the ACTIVE fencing lease of ${parsed.accountRef} in the ${gate.runMode} realm`]);
    printer.section(SECTIONS.RESULT, [`nothing was done: the fencing lease store is unavailable (${opened.reason})`]);
    printer.section(SECTIONS.UNKNOWN, ["whether a lease is held, and by whom"]);
    return { exit: "DATABASE_UNAVAILABLE", result: { reason: opened.reason } };
  }
  try {
    let lease;
    try {
      lease = await opened.leases.current(parsed.accountRef, gate.runMode);
    } catch {
      printer.section(SECTIONS.PLAN, [`read the ACTIVE fencing lease of ${parsed.accountRef} in the ${gate.runMode} realm`]);
      printer.section(SECTIONS.RESULT, ["nothing was done: the lease could not be read"]);
      printer.section(SECTIONS.UNKNOWN, ["whether a lease is held, and by whom"]);
      return { exit: "DATABASE_UNAVAILABLE", result: { reason: "READ_FAILED" } };
    }
    if (lease === null) {
      printer.section(SECTIONS.PLAN, [`read the ACTIVE fencing lease of ${parsed.accountRef} in the ${gate.runMode} realm`]);
      printer.section(SECTIONS.RESULT, [
        "nothing was done: no ACTIVE, unexpired lease is held for this account and realm, so no holder may heartbeat under the fence (ADR-008 §2)",
      ]);
      printer.section(SECTIONS.UNKNOWN, [
        "whether a process heartbeats WITHOUT the fence: only the fence's holder may (§6 invariant 16); repeated invalid-id 400s would page as a live fencing conflict (ADR-008 §4). Verify the open orders with account-snapshot",
      ]);
      return { exit: "NOTHING_TO_DO", result: { lease: null } };
    }
    const scope = scopeText(parsed, lease.fencingLeaseId);
    printer.section(SECTIONS.PLAN, [
      `the ACTIVE lease of ${parsed.accountRef} (${gate.runMode} realm): ${lease.fencingLeaseId}, holder ${lease.holderId}, fencing token ${lease.fencingToken}, expires ${lease.expiresAt} (database clock), ${lease.heartbeatId === null ? "no venue heartbeat id recorded" : "a venue heartbeat id is recorded (not printed)"}`,
      `revoke exactly that lease, with the reason recorded on the row: "${revocationReason(parsed.operator, parsed.reason)}"`,
      "nothing is sent to the venue, and no order is canceled by this command itself",
      `scope to confirm: ${scope}`,
    ]);
    const go = await confirmThenRecord(context, scope, scopeDescription(parsed, lease.fencingLeaseId), { target: lease.fencingLeaseId, holderId: lease.holderId });
    if (go !== "GO") {
      printer.section(SECTIONS.RESULT, ["nothing was revoked"]);
      printer.section(SECTIONS.UNKNOWN, []);
      return go;
    }
    let revoked: boolean;
    try {
      revoked = await opened.leases.revoke({ fencingLeaseId: lease.fencingLeaseId, reason: revocationReason(parsed.operator, parsed.reason) });
    } catch {
      printer.section(SECTIONS.RESULT, [`the revoke of ${lease.fencingLeaseId} failed or was not answered`]);
      printer.section(SECTIONS.UNKNOWN, ["whether the lease was revoked: read it again (a revoke is idempotent: an ended lease answers false)"]);
      return { exit: "UNKNOWN", result: { target: lease.fencingLeaseId, revoked: null } };
    }
    if (!revoked) {
      printer.section(SECTIONS.RESULT, [`lease ${lease.fencingLeaseId} had already ended when the revoke ran: nothing was revoked`]);
      printer.section(SECTIONS.UNKNOWN, ["whether a new lease has been granted since: run stop-heartbeat again to read the current one"]);
      return { exit: "NOTHING_TO_DO", result: { target: lease.fencingLeaseId, revoked: false } };
    }
    printer.section(SECTIONS.RESULT, [
      `lease ${lease.fencingLeaseId} REVOKED (holder ${lease.holderId}): its next renewal finds it LOST, and its heartbeat stops`,
      `expect the venue's cancellation of resting orders ${String(HEARTBEAT_TIMEOUT_MS / SECONDS)}–${String((HEARTBEAT_TIMEOUT_MS + VENUE_CANCELLATION_CHECK_INTERVAL_MS) / SECONDS)} s after the last valid heartbeat, which itself comes at most ${String(FENCING_LEASE_MAX_TTL_MS / SECONDS)} s after the holder's last renewal`,
    ]);
    printer.section(SECTIONS.UNKNOWN, [
      "when the holder's heartbeat actually stops, and when the venue actually cancels: both are inferred from documentation, not observed. Verify with account-snapshot",
      "whether the holder process is healthy enough to notice: a holder that cannot renew at all stops at its local deadline anyway (WP-320)",
    ]);
    return { exit: "COMPLETED", result: { target: lease.fencingLeaseId, revoked: true, holderId: lease.holderId } };
  } finally {
    await opened.close().catch(() => undefined);
  }
}
