/**
 * `PROVENANCE-1` — the durable halt record (`OUT1-R1-HALT-NOT-DURABLE`).
 *
 * A halt is a LATCH in this process (`@polymarket-bot/trading-core`'s
 * `HaltController`): every halt, at any scope, stops the pump, and the
 * process exits `EXIT_CODES.halted` (75). Before this round the halt was
 * recorded only in the process's own log and exit snapshot; nothing wrote
 * `ops.incidents` or `ops.risk_events`, so:
 *
 * - a halt that exits fast was invisible after the fact (`H1R1-HALT-INVISIBLE`:
 *   H1's trader exited between two Prometheus scrapes);
 * - the research worker, which reads a window's halts from `ops.incidents`
 *   (ADR-028 Decision 3.1: "a window is pinned if it had … a halt"), read none.
 *
 * Here every latched halt becomes `ops.incidents` rows, written by `startup()`
 * after the pump stops and BEFORE the process closes its connections and
 * exits. The shape is the existing table's (`db/migrations/0007_ops.up.sql`);
 * nothing is added to it.
 *
 * ## The rows of one halt
 *
 * | Column | Value |
 * | --- | --- |
 * | `incident_key` | `TRADER_HALT:<scope kind>` — `TRADER_HALT:GLOBAL`, `TRADER_HALT:MARKET`, `TRADER_HALT:STRATEGY_INSTANCE` |
 * | `failure_class` | the halt's reason code (`TRANSPORT_UNAVAILABLE`, `STORE_UNAVAILABLE`, …): §9.9's failure class |
 * | `action` | the halt's §9.9 rung (`FULL_HALT`, `RECONCILE_ACCOUNT`, …), as the controller selected it |
 * | `severity` | `PAGE`: every halt stops this process |
 * | `status` | `OPEN`: only an operator resolves it |
 * | `environment` | `PAPER`, the one mode this process runs in |
 * | `account_ref` | the configuration's `accounting.accountRef` |
 * | `detail` | the halt's own detail, bounded to `internal.detail`'s 2000 characters |
 * | `opened_at` | the halt's instant (`HaltRecord.at`): the loop's event-time instant, the frame the window classifier compares with a window's range |
 *
 * And the scope, in the columns the research worker's reader matches
 * (`apps/research-worker` `postgresTraderEvidence`: `market_id` = the window's
 * market, OR `market_id` NULL with `instance_id` one of the window's):
 *
 * - `MARKET` → one row, `market_id` set, `instance_id` NULL;
 * - `STRATEGY_INSTANCE` → one row, `instance_id` set, `market_id` NULL;
 * - `GLOBAL` → ONE ROW PER CONFIGURED INSTANCE, `instance_id` set, `market_id`
 *   NULL. A GLOBAL halt halts every instance this process runs, and the table
 *   has no run or process column, so a row with neither id would be
 *   attributable to no trader; each row states the halt of one instance
 *   (`incident_key` keeps the GLOBAL scope visible). A configuration with no
 *   instance — which `parseTraderConfig` does not admit — would get one row
 *   with neither.
 *
 * ## When the database is the failed dependency
 *
 * The write is BOUNDED ({@link HALT_RECORD_DEADLINE_MS};
 * `PostgresTraderStore.recordHalts`), and its outcome never changes the exit
 * code: the halt is latched and logged before this runs, and nothing trades
 * after it. So:
 *
 * - PostgreSQL refused or reset (down, or the cause of a `STORE_UNAVAILABLE`
 *   halt): the write fails at once, `HALT RECORD NOT DURABLE` is logged, and
 *   the process exits 75 as before;
 * - PostgreSQL answers slowly: the transaction's own `statement_timeout` is
 *   the bound, so the server cancels the insert;
 * - PostgreSQL does not answer at all (frozen, partitioned): the call returns
 *   at the bound, `HALT RECORD UNCONFIRMED` is logged (the rows may or may
 *   not exist), the write's connection is DESTROYED (`PROVENANCE-1` r1,
 *   `PROV1-R1-02`: left checked out, it held the PostgreSQL close, and so the
 *   process's exit, until the server answered), and the process goes on to
 *   close and exit 75.
 *
 * Fail-closed behaviour is not weakened to get the row written: no retry, no
 * wait past the bound, no change to the exit code. What the close can still
 * wait on is what it waited on before this round: a trading commit already
 * in flight on a silent server (`pg` sets no client-side query timeout), and
 * — new here, and bounded — a connection the pool was still opening for the
 * record at the bound, which the pool's own connection timeout ends.
 */

import type { HaltRecord, TraderConfig } from "@polymarket-bot/trading-core";
import { TRADER_RUN_MODE } from "@polymarket-bot/trading-core";

import { boundedDetail } from "./adapters/postgres-store.js";

/**
 * How long the halt record may take before the process goes on to exit.
 * The same order as the Redis bound's default (`DEFAULT_RESPONSE_TIMEOUT_MS`,
 * 5000): a healthy PostgreSQL answers this transaction in milliseconds.
 */
export const HALT_RECORD_DEADLINE_MS = 5_000;

/** `ops.incidents.incident_key` per halt scope kind. */
export const HALT_INCIDENT_KEYS = Object.freeze({
  GLOBAL: "TRADER_HALT:GLOBAL",
  MARKET: "TRADER_HALT:MARKET",
  STRATEGY_INSTANCE: "TRADER_HALT:STRATEGY_INSTANCE",
} as const);

/** One `ops.incidents` row of a halt, in the table's own column names. */
export interface HaltIncidentRow {
  readonly incident_key: (typeof HALT_INCIDENT_KEYS)[keyof typeof HALT_INCIDENT_KEYS];
  readonly environment: typeof TRADER_RUN_MODE;
  readonly account_ref: string | null;
  readonly severity: "PAGE";
  readonly status: "OPEN";
  readonly failure_class: string;
  readonly action: HaltRecord["action"];
  readonly market_id: string | null;
  readonly instance_id: string | null;
  readonly detail: string;
  readonly opened_at: string;
}

/** The `ops.incidents` rows of every latched halt (see the module header). */
export function haltIncidentRows(
  halts: readonly HaltRecord[],
  context: {
    readonly accountRef: string | null;
    readonly instanceIds: readonly string[];
  },
): readonly HaltIncidentRow[] {
  const rows: HaltIncidentRow[] = [];
  for (const halt of halts) {
    const base = {
      environment: TRADER_RUN_MODE,
      account_ref: context.accountRef,
      severity: "PAGE" as const,
      status: "OPEN" as const,
      failure_class: halt.code,
      action: halt.action,
      detail: boundedDetail(halt.detail),
      opened_at: halt.at,
    };
    switch (halt.scope.kind) {
      case "MARKET":
        rows.push(
          Object.freeze({ ...base, incident_key: HALT_INCIDENT_KEYS.MARKET, market_id: halt.scope.marketId, instance_id: null }),
        );
        break;
      case "STRATEGY_INSTANCE":
        rows.push(
          Object.freeze({
            ...base,
            incident_key: HALT_INCIDENT_KEYS.STRATEGY_INSTANCE,
            market_id: null,
            instance_id: halt.scope.instanceId,
          }),
        );
        break;
      case "GLOBAL": {
        const instanceIds = context.instanceIds.length === 0 ? [null] : context.instanceIds;
        for (const instanceId of instanceIds) {
          rows.push(
            Object.freeze({ ...base, incident_key: HALT_INCIDENT_KEYS.GLOBAL, market_id: null, instance_id: instanceId }),
          );
        }
        break;
      }
    }
  }
  return Object.freeze(rows);
}

/** What the bounded write answered (`PostgresTraderStore.recordHalts`). */
export type HaltRecordOutcome =
  | { readonly status: "written"; readonly rows: number }
  | { readonly status: "failed"; readonly detail: string }
  | { readonly status: "unconfirmed"; readonly detail: string };

/**
 * Writes every latched halt's rows through `write`, bounded, and logs what
 * happened. Never throws; answers `undefined` when no halt is latched (and
 * writes nothing). The caller exits with the same code whatever this answers.
 */
export async function recordHaltsBeforeExit(input: {
  readonly halts: readonly HaltRecord[];
  readonly config: Pick<TraderConfig, "accounting" | "instances" | "seriesInstances">;
  readonly write: (rows: readonly HaltIncidentRow[], deadlineMs: number) => Promise<HaltRecordOutcome>;
  readonly log: (line: string) => void;
  readonly deadlineMs?: number;
}): Promise<HaltRecordOutcome | undefined> {
  if (input.halts.length === 0) return undefined;
  const deadlineMs = input.deadlineMs ?? HALT_RECORD_DEADLINE_MS;
  const rows = haltIncidentRows(input.halts, {
    accountRef: input.config.accounting.accountRef,
    // `ROLLOVER-1`: a GLOBAL halt names every instance, series-bound ones included.
    instanceIds: [...input.config.instances, ...(input.config.seriesInstances ?? [])].map((instance) => instance.instanceId),
  });
  let outcome: HaltRecordOutcome;
  try {
    outcome = await input.write(rows, deadlineMs);
  } catch (cause) {
    // The store's write is total; this is the belt.
    outcome = { status: "failed", detail: cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause) };
  }
  switch (outcome.status) {
    case "written":
      input.log(
        `halt record: ${String(outcome.rows)} row(s) written to ops.incidents for ` +
          `${String(input.halts.length)} halt(s) (${input.halts
            .map((halt) => `${halt.scope.kind} ${halt.code}`)
            .join(", ")})`,
      );
      break;
    case "failed":
      input.log(
        `HALT RECORD NOT DURABLE: the halt could not be written to ops.incidents (${outcome.detail}); ` +
          "the halt is latched and logged above, nothing trades after it, and the process exits halted " +
          "regardless (fail closed)",
      );
      break;
    case "unconfirmed":
      input.log(
        `HALT RECORD UNCONFIRMED: ${outcome.detail}; the halt is latched and logged above, nothing ` +
          "trades after it, and the process exits halted regardless (fail closed)",
      );
      break;
  }
  return outcome;
}
