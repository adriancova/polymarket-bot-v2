/**
 * The control-plane AUDIT record and its append-only sink — `WP-240`
 * acceptance 2 ("Every mutation is audited"), handoff §14.1 ("Every change is
 * append-only audited with actor, reason, timestamp, prior state, and
 * resulting state"), §10.6 (`ops.kill_switch_events`, `ops.config_change_audit`).
 *
 * ## The record's five required fields are non-optional, by type
 *
 * §14.1 names five: actor, reason, timestamp, prior state, resulting state.
 * `db/migrations/0007_ops.up.sql` makes all five `not null` "for that reason".
 * {@link ControlAuditRecord} does the same in the type system — no `?`, no
 * union with `undefined` — so a caller that has not got a prior state does not
 * compile, rather than writing an audit row that cannot answer what changed.
 *
 * ## Why the sink is a PORT and the in-memory implementation lives here
 *
 * The WP-040 `ops` tables exist and are the intended durable home; the binding
 * to them is `apps/control-api/src/adapters/postgres-audit-sink.ts`, because
 * this package is layer 1 and may not import `packages/storage-postgres`
 * (layer 2 — that edge is F12). What lives here is the record shape, the port,
 * and an in-memory append-only implementation, which is:
 *
 * - the only sink a PAPER deployment with no database can use, and a PAPER
 *   deployment must still be auditable;
 * - the sink every test uses, so acceptance 2 is proven by executing the real
 *   control plane rather than by asserting that an unexecuted SQL string looks
 *   right.
 *
 * ## The bound REFUSES; it never drops
 *
 * An audit sink that discards its oldest record to make room turns "every
 * mutation is audited" into "every recent mutation is audited", and the
 * mutations you lose are the ones from the incident that filled the log. So
 * {@link InMemoryControlAuditLog} has an explicit capacity and returns a
 * REFUSAL at the bound. The control plane audits BEFORE it applies and applies
 * only on success, so a full audit log stops the control plane from mutating
 * anything — fail closed, and visible on `control_audit_append_failures_total`.
 *
 * ## Purity
 *
 * Layer 1: no clock, no I/O, no Node built-in (F17). Every instant is supplied
 * by the caller, and every record id is supplied by the caller, so two
 * identical runs produce identical logs.
 */

/**
 * What a control-plane mutation DID, as a closed vocabulary.
 *
 * Closed rather than free text because the audit log is queried by an operator
 * during an incident and a free-text action is a field nobody can filter on.
 * `MODE_RAISE_ATTEMPT` is not a control the API offers — it is the record of a
 * request that TRIED to raise a run mode, enable real orders, raise a
 * live-micro cap or reference a signer, and was refused by name. `WP-240`
 * acceptance 1 requires that refusal; this is where it becomes evidence.
 */
export const CONTROL_AUDIT_ACTIONS = [
  "STRATEGY_PAUSE",
  "STRATEGY_RESUME",
  "KILL_SWITCH_ENGAGE",
  "KILL_SWITCH_RELEASE",
  "MODE_RAISE_ATTEMPT",
] as const;

export type ControlAuditAction = (typeof CONTROL_AUDIT_ACTIONS)[number];

/**
 * Whether the mutation happened.
 *
 * Both outcomes are audited. A refused mutation is an operator fact — someone
 * tried, and the system said no — and an audit log that records only successes
 * cannot answer "who has been probing this".
 */
export const CONTROL_AUDIT_OUTCOMES = ["APPLIED", "REFUSED"] as const;
export type ControlAuditOutcome = (typeof CONTROL_AUDIT_OUTCOMES)[number];

/** §10.6 `actor_kind`. A control-API caller is a HUMAN operator by definition. */
export const CONTROL_ACTOR_KINDS = ["HUMAN", "AUTOMATED"] as const;
export type ControlActorKind = (typeof CONTROL_ACTOR_KINDS)[number];

/**
 * One append-only audit record.
 *
 * `priorState` and `resultingState` are JSON-shaped documents, mirroring the
 * `jsonb` columns of `ops.kill_switch_events`. They are stated as
 * `AuditStateDocument` (a bounded JSON value with **no `number`**) for the same
 * reason `packages/storage-postgres`'s `DecimalSafeJson` exists: a control
 * state document may one day carry an amount, and a JSON number is the
 * representation §6 invariant 1 forbids for economics. Counts that genuinely
 * are integers are written as their decimal string here; nothing in the control
 * plane needs arithmetic on them.
 */
export interface ControlAuditRecord {
  /** Caller-supplied, sortable, unique. §10.7 requires UUIDv7 in the database. */
  readonly recordId: string;
  readonly action: ControlAuditAction;
  readonly outcome: ControlAuditOutcome;
  /** The operator id. NEVER a token, and never any part of one. */
  readonly actor: string;
  readonly actorKind: ControlActorKind;
  /** §14.1 scope, or `CONTROL_PLANE` for a record with no §14.1 scope. */
  readonly scope: string;
  /** What the scope names — an instance id, a market id, an account ref. */
  readonly scopeRef: string | null;
  readonly reason: string;
  readonly priorState: AuditStateDocument;
  readonly resultingState: AuditStateDocument;
  /** Strict-UTC instant from the caller's clock. */
  readonly at: string;
}

/**
 * A JSON document with no `number` at any depth.
 *
 * The exclusion is structural, not a runtime check: a caller cannot write a
 * `number` into one of these without a type error.
 */
export type AuditStateDocument =
  | string
  | boolean
  | null
  | readonly AuditStateDocument[]
  | { readonly [key: string]: AuditStateDocument };

export type AuditAppendResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: AuditRefusalCode; readonly detail: string };

export type AuditRefusalCode =
  /** The sink is at its bound. The mutation must not proceed. */
  | "AUDIT_CAPACITY_EXHAUSTED"
  /** A record with this id already exists. Append-only means append-once. */
  | "AUDIT_RECORD_ID_REUSED"
  /** The durable sink refused or was unreachable. */
  | "AUDIT_SINK_UNAVAILABLE";

/**
 * The port the control plane writes through.
 *
 * `append` is asynchronous because the durable implementation talks to
 * PostgreSQL. It is TOTAL: an implementation reports failure as data rather
 * than throwing, so "audit, then apply" is a branch the control plane can
 * take rather than an exception it might not catch.
 */
export interface ControlAuditSink {
  append(record: ControlAuditRecord): Promise<AuditAppendResult>;
}

/**
 * An append-only, bounded, in-memory audit log.
 *
 * Append-only is enforced, not documented: {@link records} returns a frozen
 * copy of frozen records, there is no delete, no update and no truncate, and a
 * reused record id is refused (the same append-once property
 * `internal.enforce_append_only` gives the `ops` tables).
 */
export class InMemoryControlAuditLog implements ControlAuditSink {
  readonly #records: ControlAuditRecord[] = [];
  readonly #ids = new Set<string>();
  readonly #capacity: number;

  /**
   * @param capacity Maximum records. Reaching it refuses further appends and
   *   therefore stops the control plane from mutating anything. There is no
   *   default: a bound chosen by this class would be a bound nobody decided.
   */
  constructor(capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new RangeError(
        `audit log capacity must be a positive safe integer; received ${String(capacity)}`,
      );
    }
    this.#capacity = capacity;
  }

  append(record: ControlAuditRecord): Promise<AuditAppendResult> {
    if (this.#ids.has(record.recordId)) {
      return Promise.resolve({
        ok: false,
        code: "AUDIT_RECORD_ID_REUSED",
        detail:
          `audit record ${record.recordId} already exists; an append-only log appends ONCE, ` +
          "and a reused id would overwrite the evidence of an earlier mutation",
      });
    }
    if (this.#records.length >= this.#capacity) {
      return Promise.resolve({
        ok: false,
        code: "AUDIT_CAPACITY_EXHAUSTED",
        detail:
          `the audit log is at its bound of ${String(this.#capacity)} records; it REFUSES rather ` +
          "than evicting, because the records an eviction would lose are the ones from the " +
          "incident that filled the log — so the mutation does not happen either",
      });
    }
    this.#records.push(Object.freeze(record));
    this.#ids.add(record.recordId);
    return Promise.resolve({ ok: true });
  }

  /** Every record, in append order. A frozen copy: callers cannot mutate the log. */
  records(): readonly ControlAuditRecord[] {
    return Object.freeze([...this.#records]);
  }

  get size(): number {
    return this.#records.length;
  }

  get capacity(): number {
    return this.#capacity;
  }
}
