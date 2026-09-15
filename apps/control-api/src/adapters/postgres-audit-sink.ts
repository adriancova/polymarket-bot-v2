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
import { encodePlainJson } from "@polymarket-bot/risk/plain-json";
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
 * Presents an audit state document as a `jsonb` INPUT: the document's JSON
 * TEXT, encoded from its own data.
 *
 * The columns take an object or a pre-serialized string — `internal`'s
 * `JsonInput` — and this hands `pg` the STRING (`SER-3`, 2026-09-15). Handed
 * an object, `pg@8.23.0`'s `prepareValue` → `prepareObject` first consults an
 * inherited `toPostgres` and then `JSON.stringify`s through the prototype
 * chain, so an inherited `Object.prototype`/`Array.prototype` `toJSON`
 * replaced the §14.1 `prior_state`/`resulting_state` and
 * `previous_value`/`new_value` documents with substituted bytes — measured at
 * `main` `d6e05bf` and reproduced independently
 * (`docs/handoffs/SER-0-sweep.md`, `pg-ops-audit-state-documents`; the chain
 * was cut at the driver's bind-time `valueMapper`, the last transformation
 * before the wire). A string primitive never reaches `prepareObject`, which
 * closes both lookups; the parameter's type is inferred from the column, so
 * PostgreSQL parses the text as `jsonb` on insert (the `SER-2` TEXT rule the
 * `storage-postgres` repositories follow; like the rest of this file, not
 * executed against a live database here).
 * `encodePlainJson` (`@polymarket-bot/risk/plain-json`) is byte-identical to a
 * clean `JSON.stringify` for plain data — the same document the driver would
 * have produced in a clean process — and never consults `toJSON`.
 *
 * An {@link AuditStateDocument} may also be a bare string, boolean, `null` or
 * array. Every document this package writes IS an object; the `{ value }`
 * wrap is KEPT for one that is not, so the stored document is the same one
 * the object route stored (a labelled wrap rather than a bare scalar), and a
 * `null` document still lands as the JSON object `{"value":null}` in a
 * NOT NULL column rather than as SQL `NULL`.
 *
 * A document the encoder refuses throws, which `append` reports as
 * `AUDIT_SINK_UNAVAILABLE`: the mutation does not happen. Fail closed. A class
 * instance, an accessor and a function are all outside `AuditStateDocument`'s
 * type; ONE refusable shape is not, and is named rather than left implicit
 * (`SER-3` review round 1, the container sweep): an `Array` SUBCLASS satisfies
 * `readonly AuditStateDocument[]`, and `pg` would have serialized it.
 *
 * Every document this sink writes comes from `ControlPlane`, a concrete class
 * with `#` private fields — so it is nominally typed and no foreign
 * implementation can be substituted. Its documents' containers are ordinary
 * BECAUSE EACH PRODUCER MAKES THEM SO, which is a property of those producers
 * rather than of the type: `runStateDocument`, `strategyDocument`,
 * `killSwitchDocument` and `killSwitchAbsent` are object literals over strings,
 * and `refuseModeRaise` — the ONE place a caller's container reaches a document
 * — rebuilds it with `[...keys]`. Round 1 stated the property without
 * establishing it there, and it did not hold: that site built `attemptedKeys`
 * with `keys.map(...)`, which preserves a caller's `Array` subclass, so this
 * sink refused (`NON_PLAIN` at `value.attemptedKeys`) a record `pg` wrote.
 * Fixed in round 2 (N1) and pinned by
 * `test/unit/control-api/outbound-container-species.test.ts`.
 *
 * THE RESIDUAL, precisely: a caller that drives this sink DIRECTLY with a
 * hand-built record whose state document carries a foreign container (an
 * `Array` subclass, the one refusable shape inside `AuditStateDocument`'s
 * type). Nothing in this repository does — `ControlPlane` is the only producer
 * — and no deep re-materialization is available here that would not also decide
 * what a `Date` or a `Map` means, which is the decision the own-data encoder
 * exists to refuse. So it is stated rather than hidden.
 *
 * NOTE ON DECIMALS: `AuditStateDocument` excludes `number` at every depth by
 * construction, which is the same property `packages/storage-postgres`'s
 * `assertDecimalSafeJson` enforces at runtime for the economics-bearing
 * columns. These two `ops` columns are ordinary `jsonb`, so the exclusion is
 * this package's own discipline rather than the database's.
 */
function asJsonInput(document: AuditStateDocument): JsonInput {
  const wrapped: unknown =
    typeof document === "object" && document !== null && !Array.isArray(document)
      ? document
      : { value: document };
  return encodePlainJson(wrapped);
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
