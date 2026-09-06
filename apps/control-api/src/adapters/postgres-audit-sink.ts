/**
 * The durable audit sink — `WP-040`'s §10.6 `ops` tables, bound to
 * `WP-240`'s {@link ControlAuditSink} port.
 *
 * ## NO POSTGRESQL WAS REACHED (disclosed)
 *
 * Docker is absent from the development environment this package was built in,
 * exactly as `WP-210` and `WP-230` recorded for their own database work
 * (`apps/trader/src/adapters/postgres-store.ts`: "typecheck-pinned only… no
 * integration evidence is claimed"). This binding is the same: the table names,
 * the column names and the enum values come from
 * `packages/storage-postgres`'s shipped table types, so a rename upstream fails
 * `pnpm typecheck` — but **nothing here has been executed against a live
 * database, and no integration evidence is claimed for it.**
 *
 * `WP-240`'s acceptance-2 evidence is at the PORT, against the real control
 * plane and the real in-memory append-only log
 * (`test/integration/control-api/acceptance-2-every-mutation-audited.test.ts`),
 * which is the `WP-120`/`WP-230` precedent for this class of claim.
 *
 * ## Why the two tables, and which record goes where
 *
 * §10.6 gives the `ops` schema two audit tables and they mean different things:
 *
 * - `kill_switch_events` — "Global, market, or instance actions". Its columns
 *   are §14.1's five required fields plus the scope and action ENUMS, and its
 *   `kill_switch_events_scope_ref` CHECK encodes "a scoped switch must say what
 *   it is scoped to; a GLOBAL one must not". Kill-switch engage and release go
 *   here.
 * - `config_change_audit` — "Human and automated changes", keyed by the target
 *   the change addressed. A strategy pause/resume is a change to
 *   `strategy.instances`, and a refused mode-raise attempt is a change to
 *   nothing at all that an operator nevertheless attempted; both go here.
 *
 * A refused kill-switch request also goes to `config_change_audit` rather than
 * to `kill_switch_events`, because that table's semantics are "an action
 * happened" and its prior/resulting states are the switch's — writing a row
 * whose two states are identical would be recording a change that did not
 * occur in the table an operator reads to find changes that did.
 *
 * ## What this adapter does not do
 *
 * It does not read. It does not update or delete — the tables are append-only
 * by trigger and would refuse it anyway (`internal.enforce_append_only`). It
 * holds no credential of its own: the caller hands it a `Kysely` handle, so
 * connection configuration is the composition root's business and no
 * credential-shaped name is read in this file.
 */

import type {
  AuditAppendResult,
  AuditStateDocument,
  ControlAuditRecord,
  ControlAuditSink,
} from "@polymarket-bot/observability";
import type {
  JsonInput,
  KillSwitchActionValue,
  KillSwitchScopeValue,
  PolymarketBotDatabase,
  RunModeValue,
} from "@polymarket-bot/storage-postgres";

import { CONTROL_KILL_SWITCH_ACTIONS, CONTROL_KILL_SWITCH_SCOPES } from "../vocabulary.js";

export interface PostgresAuditSinkOptions {
  readonly db: PolymarketBotDatabase;
  /**
   * The §10.8 environment discriminator every `ops` row carries.
   *
   * Supplied by the composition root rather than defaulted: a row that claims
   * the wrong environment is a row that mis-files an operator action, and a
   * default here would be a value nobody chose.
   */
  readonly environment: RunModeValue;
}

/**
 * Presents an audit state document as a `jsonb` INPUT.
 *
 * The columns take an object (or a pre-serialized string) — `internal`'s
 * `JsonInput` — while an {@link AuditStateDocument} may also be a bare string,
 * boolean, `null` or array. Every document this package writes IS an object;
 * the wrap exists so that a future one which is not still lands as a row rather
 * than as a type error at the call site, and it labels what it wrapped instead
 * of stringifying it.
 *
 * NOTE ON DECIMALS: `AuditStateDocument` excludes `number` at every depth by
 * construction, which is the same property `packages/storage-postgres`'s
 * `assertDecimalSafeJson` enforces at runtime for the economics-bearing
 * columns. These two `ops` columns are ordinary `jsonb`, so the exclusion is
 * this package's own discipline rather than the database's.
 */
function asJsonInput(document: AuditStateDocument): JsonInput {
  if (typeof document === "object" && document !== null && !Array.isArray(document)) {
    return document as JsonInput;
  }
  return { value: document } as unknown as JsonInput;
}

function isKillSwitchScope(value: string): value is KillSwitchScopeValue {
  return (CONTROL_KILL_SWITCH_SCOPES as readonly string[]).includes(value);
}

function isKillSwitchAction(value: string): value is KillSwitchActionValue {
  return (CONTROL_KILL_SWITCH_ACTIONS as readonly string[]).includes(value);
}

export class PostgresControlAuditSink implements ControlAuditSink {
  readonly #db: PolymarketBotDatabase;
  readonly #environment: RunModeValue;

  constructor(options: PostgresAuditSinkOptions) {
    this.#db = options.db;
    this.#environment = options.environment;
  }

  async append(record: ControlAuditRecord): Promise<AuditAppendResult> {
    try {
      const engaged =
        record.outcome === "APPLIED" &&
        (record.action === "KILL_SWITCH_ENGAGE" || record.action === "KILL_SWITCH_RELEASE");
      if (engaged && isKillSwitchScope(record.scope)) {
        await this.#appendKillSwitch(record, record.scope);
      } else {
        await this.#appendConfigChange(record);
      }
      return { ok: true };
    } catch (cause) {
      // The durable sink refusing is a MUTATION THAT DID NOT HAPPEN: the
      // control plane audits before it applies. Reported as data so the caller
      // can say so, rather than thrown into a request handler.
      return {
        ok: false,
        code: "AUDIT_SINK_UNAVAILABLE",
        detail: `the ops audit tables refused or were unreachable: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      };
    }
  }

  async #appendKillSwitch(
    record: ControlAuditRecord,
    scope: KillSwitchScopeValue,
  ): Promise<void> {
    // The §14.1 action is carried on the resulting state for an engage and is
    // absent for a release (the switch is gone). A release records the action
    // that was released, which the prior state carries.
    const action = readAction(record) ?? "FULL_HALT";
    await this.#db
      .insertInto("ops.kill_switch_events")
      .values({
        kill_switch_event_id: record.recordId,
        scope,
        scope_ref: record.scopeRef,
        action,
        environment: this.#environment,
        actor: record.actor,
        actor_kind: record.actorKind,
        reason: record.reason,
        prior_state: asJsonInput(record.priorState),
        resulting_state: asJsonInput(record.resultingState),
        incident_id: null,
        occurred_at: record.at,
      })
      .execute();
  }

  async #appendConfigChange(record: ControlAuditRecord): Promise<void> {
    await this.#db
      .insertInto("ops.config_change_audit")
      .values({
        config_change_id: record.recordId,
        actor: record.actor,
        actor_kind: record.actorKind,
        change_kind: `${record.action}_${record.outcome}`,
        target_schema: targetSchemaFor(record),
        target_table: targetTableFor(record),
        target_id: record.scopeRef,
        previous_value: asJsonInput(record.priorState),
        new_value: asJsonInput(record.resultingState),
        reason: record.reason,
        environment: this.#environment,
        occurred_at: record.at,
      })
      .execute();
  }
}

function readAction(record: ControlAuditRecord): KillSwitchActionValue | undefined {
  for (const document of [record.resultingState, record.priorState]) {
    if (typeof document !== "object" || document === null || Array.isArray(document)) continue;
    const value = (document as Record<string, unknown>)["action"];
    if (typeof value === "string" && isKillSwitchAction(value)) return value;
  }
  return undefined;
}

function targetSchemaFor(record: ControlAuditRecord): string {
  switch (record.action) {
    case "STRATEGY_PAUSE":
    case "STRATEGY_RESUME":
      return "strategy";
    case "KILL_SWITCH_ENGAGE":
    case "KILL_SWITCH_RELEASE":
      return "ops";
    case "MODE_RAISE_ATTEMPT":
      // A mode-raise attempt targets nothing that exists: §11's ceiling is a
      // process startup value with no table. `internal` is the schema that
      // holds the run-mode vocabulary, and naming it is more honest than
      // inventing a target the attempt could have reached.
      return "internal";
  }
}

function targetTableFor(record: ControlAuditRecord): string {
  switch (record.action) {
    case "STRATEGY_PAUSE":
    case "STRATEGY_RESUME":
      return "instances";
    case "KILL_SWITCH_ENGAGE":
    case "KILL_SWITCH_RELEASE":
      return "kill_switch_events";
    case "MODE_RAISE_ATTEMPT":
      return "run_mode";
  }
}
