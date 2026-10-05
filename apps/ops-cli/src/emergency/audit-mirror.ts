/**
 * The audit trail's database copy: each local record appended to
 * `ops.config_change_audit` ("Human and automated changes", handoff §10.6),
 * when a database is configured. Best effort and never awaited before acting
 * (`audit-log.ts`): §14.2's cancel path does not depend on the database.
 *
 * Column mapping (`db/migrations/0007_ops.up.sql`):
 *
 * | Column | Value |
 * | --- | --- |
 * | `config_change_id` | the record's own id (UUIDv7), so the local and database copies join |
 * | `actor` / `actor_kind` | the `--operator`, `HUMAN` |
 * | `change_kind` | `OPS_CLI_<COMMAND>_<PHASE>`, e.g. `OPS_CLI_CANCEL_ALL_ACTING` |
 * | `target_schema` / `target_table` | `venue` / `orders` for the cancels; `venue` / `account` for the reads; `ops` / `fencing_leases` for stop-heartbeat |
 * | `target_id` | the order id, the condition id, or the account |
 * | `previous_value` | `null` |
 * | `new_value` | the whole record, as the local log holds it (redacted, own-data JSON text) |
 * | `reason` | the `--reason`, or a fixed sentence for a read-only command without one |
 * | `environment` | the run mode the gate permitted, else `null` |
 * | `occurred_at` | the record's instant |
 *
 * The table is append-only by trigger (`internal.enforce_append_only`); this
 * adapter only inserts. It holds no credential: the composition hands it a
 * `Kysely` handle.
 */

import { RUN_MODES, type PolymarketBotDatabase, type RunModeValue } from "@polymarket-bot/storage-postgres";

import { encodeAuditDocument, type AuditMirror, type AuditRecord } from "./audit-log.js";

const NO_REASON = "ops-cli read-only command; the operator gave no reason";

function changeKind(record: AuditRecord): string {
  const command = (record.command ?? "unparsed").toUpperCase().replace(/[^A-Z0-9]+/gu, "_");
  return `OPS_CLI_${command}_${record.phase}`.slice(0, 64);
}

function target(record: AuditRecord): { readonly schema: string; readonly table: string; readonly id: string | null } {
  const detailTarget = record.detail["target"];
  const id = typeof detailTarget === "string" && detailTarget.length > 0 && detailTarget.length <= 200 ? detailTarget : record.accountRef;
  switch (record.command) {
    case "cancel-order":
    case "cancel-market":
    case "cancel-all":
      return { schema: "venue", table: "orders", id };
    case "stop-heartbeat":
      return { schema: "ops", table: "fencing_leases", id };
    default:
      return { schema: "venue", table: "account", id };
  }
}

function environmentOf(record: AuditRecord): RunModeValue | null {
  return record.runMode !== null && (RUN_MODES as readonly string[]).includes(record.runMode) ? (record.runMode as RunModeValue) : null;
}

export function createPostgresAuditMirror(db: PolymarketBotDatabase): AuditMirror {
  return Object.freeze({
    async append(record: AuditRecord): Promise<void> {
      const where = target(record);
      await db
        .insertInto("ops.config_change_audit")
        .values({
          config_change_id: record.recordId,
          actor: record.operator ?? "ops-cli-unidentified-operator",
          actor_kind: "HUMAN",
          change_kind: changeKind(record),
          target_schema: where.schema,
          target_table: where.table,
          target_id: where.id,
          previous_value: null,
          new_value: encodeAuditDocument(record),
          reason: record.reason ?? NO_REASON,
          environment: environmentOf(record),
          occurred_at: record.at,
        })
        .execute();
    },
  });
}
