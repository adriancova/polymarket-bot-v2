/**
 * The control plane — the state an operator can change through this API, and
 * the rule that makes `WP-240` acceptance 2 true by construction.
 *
 * ## AUDIT FIRST, THEN APPLY
 *
 * > "Every mutation is audited."
 *
 * The only way to make that a property rather than a habit is to put the audit
 * append on the path to the mutation. Every method here:
 *
 * 1. computes the PRIOR state,
 * 2. computes the RESULTING state,
 * 3. appends the audit record and **awaits the result**,
 * 4. applies the change **only if the append succeeded**.
 *
 * So a full audit log, a reused record id, or an unreachable durable sink each
 * stop the mutation. That is the fail-closed direction: an unauditable control
 * plane is a control plane that does nothing, not one that acts in the dark.
 * `control-plane.test.ts` proves it by injecting a sink that refuses and
 * observing that the state did not move.
 *
 * REFUSALS ARE AUDITED TOO — for an actor with MUTATION AUTHORITY. A refused
 * mutation is an operator fact — someone tried and the system said no — and an
 * audit log that records only successes cannot answer "who has been probing
 * this". Every refusal this class writes is for a caller `api.ts` has already
 * authorized for the mutation's grant, or — for {@link ControlPlane.refuseModeRaise}
 * — for a caller holding at least one mutation grant. That includes a request
 * refused BEFORE it reached a mutation method — at the transport, the route
 * parameter or the body door — which `api.ts` records through
 * {@link ControlPlane.refuseRequest} once authentication and the route's
 * authorization have passed (`CONTROL-1` r1, closing `CONTROL1-J-M2`). ONE
 * refusal of such a caller writes nothing: the GATED refusal ("One unsettled
 * protected append per state key", below), which offers no record because an
 * earlier record of the same switch or instance is still in flight
 * (`README.md`, "What writes NOTHING", item 7; `CONTROL-1b` r2, closing
 * `CONTROL1B-R2-J-L1`). A caller
 * with NO mutation authority writes nothing here at all (`CONTROL-1`, closing
 * `WP-240` r1 M-3): an unauthenticated request never reaches this class, an
 * unauthorized one is refused before it, and a READ-only operator's mode-raise
 * attempt is COUNTED through {@link ControlPlane.countModeRaiseWithoutAudit}
 * and never appended. An audit log a caller without mutation authority could
 * append to is one it could exhaust, and this one refuses mutations — the kill
 * switch included — when it is full. `README.md`, "The audit budget", states
 * the whole design; `audit-budget.ts` is its second half.
 *
 * ## An engage never repeats and never weakens (`CONTROL-1` r1, `CONTROL1-J-M1`)
 *
 * An engage over a switch that is already engaged at the same scope:
 *
 * - with the SAME action is refused `CONTROL_ALREADY_IN_STATE`, as a repeated
 *   pause is — an audit log full of no-ops is one nobody reads, and a no-op
 *   must not spend the capacity a real halt needs;
 * - that would move the switch AWAY from `FULL_HALT` is refused
 *   `CONTROL_ENGAGE_WOULD_WEAKEN`: relaxing a full halt is a release, and a
 *   release requires evidence (§9.17), so it goes through
 *   {@link ControlPlane.releaseKillSwitch};
 * - that changes it TO `FULL_HALT` is an escalation, applied;
 * - that changes it between two actions §14.1 does not order is applied, as at
 *   `WP-240` — but the audit budget admits it in the ORDINARY tier, so it can
 *   never use the reserve (`vocabulary.ts`, `STRONGEST_KILL_SWITCH_ACTION`).
 *
 * ## Mutations are serialized per state key (`CONTROL-1` r1, `CONTROL1-J-L2`)
 *
 * "Audit first, then apply" reads the prior, AWAITS the append, then applies.
 * With a sink that does I/O, two mutations of one instance could otherwise
 * both read the same prior and both be audited as the change — two `APPLIED`
 * pauses of one `RUNNING` instance, the second a no-op recorded as a halt.
 * Every mutation therefore runs under a per-key lock (`strategy:<id>`,
 * `kill-switch:<scope>:<ref>`): mutations of one instance or one switch run one
 * at a time, in arrival order, and mutations of different keys still proceed
 * concurrently, so a slow append for one instance never queues a kill-switch
 * engage behind it. A lock entry exists only while a mutation of its key is in
 * flight, so the map cannot grow with the ids callers try.
 *
 * The KEY is the state a mutation reads, and nothing narrower or wider
 * (`CONTROL-1b`, closing `CONTROL1-R2-J-L2`): an engage and a release of one
 * switch take the SAME lock, whatever action the engage names, because each
 * reads that switch's prior — so an escalation and a release sent together
 * apply one after the other, and the release's record shows the switch it
 * really released. Two different switches (a `MARKET` scope at two refs, or
 * `GLOBAL` and a scoped one) take different locks and do not wait on each
 * other. `control-plane.test.ts` pins both directions with a slow sink.
 *
 * ## An append is bounded (`CONTROL-1b`, closing `CONTROL-1` follow-up 3a)
 *
 * With a durable sink, an append that never settles used to hold its state
 * key's lock for ever, queueing every later mutation of that instance or
 * switch behind it — the kill switch included. Each append is now raced
 * against a bound, {@link ControlPlaneOptions.auditAppendTimeoutMs} (default
 * {@link AUDIT_APPEND_TIMEOUT_MS}):
 *
 * - **The bound expires first.** The append is treated as UNWRITTEN: the
 *   mutation is refused `503 CONTROL_NOT_AUDITABLE`, its state is unmoved, it
 *   is counted `NOT_AUDITED`, and its lock is released, so the next mutation
 *   of the key proceeds. Audit first, then apply, fail closed — unchanged.
 * - **The sink answers later.** Nothing is applied, ever: the mutation's
 *   continuation returned its refusal when the bound expired. If the answer is
 *   a failure, the audit already tells the truth. If a REFUSED record landed,
 *   it is a true record of a refusal. If an APPLIED record landed, the audit
 *   now says a change happened that did not — so this class appends a VOID
 *   record beside it: `REFUSED`, the same action and target, actor
 *   {@link CONTROL_PLANE_VOID_ACTOR} (`AUTOMATED`), the voided record's prior
 *   state unchanged, and `voidsRecordId` naming it. The two are counted
 *   `LANDED_LATE` and `VOIDED` on `control_mutations_total`
 *   ({@link LATE_APPEND_OUTCOMES}), so an APPLIED record with no void beside
 *   it — no record source, or a void the sink refused — is VISIBLE as their
 *   difference rather than silent.
 * - **The audit budget** (`audit-budget.ts`) sits BEHIND this race, so a
 *   timed-out append keeps its budget slot until the sink settles it: the
 *   budget counts a record that may still land, and can never admit more than
 *   the capacity. A timed-out ORDINARY append therefore occupies only the
 *   ordinary tier and cannot reach the reserve. A timed-out PROTECTED append —
 *   a STRENGTHENING engage (the kill-switch reserve) or a halting pause (the
 *   safety-direction tier) — holds a protected slot while in flight and, if it
 *   LANDS, spends that record for good although its mutation did not happen;
 *   its void is an ordinary record, refused when the ordinary tier is full.
 *   Unlike a real halt, it leaves the switch or instance as it was, so the
 *   operator's natural retry is again a strengthening engage or a halting
 *   pause. An append whose sink NEVER answers keeps its slot for the life of
 *   the process; {@link ControlPlane.unsettledAuditAppends} counts them.
 * - **One unsettled protected append per state key** (`CONTROL-1b` r1, closing
 *   `CONTROL1B-R1-J-M1`). At round 0 every retry of a timed-out halt took
 *   another protected slot, so retrying ONE GLOBAL `FULL_HALT` through a stall
 *   spent the whole reserve, and after the sink recovered no switch was
 *   engaged and a fresh halt was refused `503`. Now, while a protected append
 *   of a switch or instance is unsettled, a new protected mutation of that same
 *   switch or instance is refused `503 CONTROL_NOT_AUDITABLE` WITHOUT an
 *   append, so it takes no budget slot; it is counted `NOT_AUDITED`. The gate
 *   lifts when the sink answers the earlier append, whatever it answers.
 *   Exactly: per switch or instance, at most ONE timed-out protected append is
 *   ever in flight. Retries sent while it is unsettled cost nothing; each
 *   timed-out protected append that later LANDS costs one protected record. So
 *   a stall the sink answers late costs one record per switch (or instance)
 *   whose append timed out, however often it was retried — on top of the
 *   record the real engage or pause spends once the sink answers in time; a
 *   sink that answers late EVERY time costs one per late answer. A
 *   mutation that would write an ORDINARY record (a release, a resume, a
 *   refusal, an unordered action change) is never gated, and other switches
 *   and instances are not affected. The price: an append the sink NEVER
 *   answers keeps that one switch's strengthening engages (or that instance's
 *   pauses) refused for the life of the process, as it keeps its slot — a
 *   durable sink must therefore settle every append (README, "An append is
 *   bounded").
 *
 * ## Every record's text is escaped once (`CONTROL-1b`, follow-up 3c)
 *
 * Every record — mutation, refusal, mode-raise attempt or void — is built from
 * the raw values and then passed through `audit-text.ts`'s `auditSafeRecord`
 * before any sink sees it: NUL, lone surrogates and every control, format or
 * separator code point become a visible `\u{HEX}` escape, injectively. So a
 * caller's bytes can never make a `jsonb` append fail, and the in-memory log
 * and the PostgreSQL tables hold the same text. The state this class holds is
 * not rewritten; only what the audit shows is.
 *
 * ## Unknown instances are refused, not fabricated (`CONTROL-1`, M-1)
 *
 * A pause or resume of an instance this control plane has never registered is
 * refused `CONTROL_UNKNOWN_INSTANCE` and audited as `REFUSED`, the way a release
 * of a switch nobody engaged is refused `CONTROL_NOT_ENGAGED`. At `WP-240` the
 * plane synthesized a `RUNNING` prior for such an id and answered `200
 * PAUSED`; the shipped composition registers no instance at all, so every
 * pause it served was a halt of nothing that an operator would read as a halt
 * that took effect. An unknown id now inserts nothing, so the instance map —
 * and the `control_strategy_*` metric cardinality — grows only through
 * {@link ControlPlane.register}, which is composition (`WP-240` r1 L-8).
 *
 * ## Acceptance 1: there is nothing here that raises a mode
 *
 * This class has no field, no method and no parameter that names a run mode.
 * The ceiling is read once from `safety.ts` at construction and exposed only
 * through {@link ControlPlane.runState}. {@link ControlPlane.refuseModeRaise}
 * exists solely to RECORD an attempt that the HTTP layer already refused —
 * it changes nothing, and it is the only place `MODE_RAISE_ATTEMPT` is written.
 *
 * ## Determinism
 *
 * No clock, no id generator. Every instant and every audit record id is
 * supplied by the caller, so a test drives the same sequence twice and gets the
 * same audit log byte for byte.
 */

import {
  type AuditAppendResult,
  type AuditStateDocument,
  type ControlAuditAction,
  type ControlAuditOutcome,
  type ControlAuditRecord,
  type ControlAuditSink,
} from "@polymarket-bot/observability";

import { auditBudgetTier } from "./audit-budget.js";
import { auditSafeRecord, boundAuditText } from "./audit-text.js";
import { instanceIdProblem } from "./instance-id.js";
import {
  CONTROL_ACTOR_KIND,
  STRONGEST_KILL_SWITCH_ACTION,
  type ControlKillSwitchAction,
  type ControlKillSwitchScope,
} from "./vocabulary.js";

/** A strategy instance's run state, as the control plane holds it. */
export type StrategyRunState = "RUNNING" | "PAUSED";

export interface StrategyInstanceState {
  readonly instanceId: string;
  readonly state: StrategyRunState;
  /** Why it is in this state, from the operator who put it there. */
  readonly reason: string;
  /** When it entered this state. Caller-supplied instant. */
  readonly since: string;
  /** Who put it there. An operator id, never a token. */
  readonly actor: string;
}

export interface KillSwitchState {
  readonly scope: ControlKillSwitchScope;
  /** `null` only for `GLOBAL` — the §10.6 `kill_switch_events_scope_ref` rule. */
  readonly scopeRef: string | null;
  readonly action: ControlKillSwitchAction;
  readonly reason: string;
  readonly since: string;
  readonly actor: string;
}

/** The run state this API reports. Read-only in every sense. */
export interface RunStateView {
  readonly runMode: string;
  readonly maximumRunMode: string;
  readonly repositoryMaximumRunMode: string;
  readonly allowRealOrders: false;
  /**
   * Stated as a literal so it appears on the wire, not merely in a document:
   * the ceiling is not writable through this API.
   */
  readonly runModeIsWritable: false;
  readonly signerLoaded: false;
}

export type MutationRefusalCode =
  /** The audit sink refused; the mutation therefore did not happen. */
  | "CONTROL_NOT_AUDITABLE"
  /** The instance is already in the requested state. */
  | "CONTROL_ALREADY_IN_STATE"
  /** A scoped kill switch must name its scope; GLOBAL must not. */
  | "CONTROL_SCOPE_REF_MISMATCH"
  /** No such kill switch is engaged. */
  | "CONTROL_NOT_ENGAGED"
  /** A release without the evidence a release requires. */
  | "CONTROL_RELEASE_EVIDENCE_MISSING"
  /**
   * No such strategy instance is registered (`CONTROL-1`, M-1). The strategy
   * twin of {@link MutationRefusalCode} `CONTROL_NOT_ENGAGED`.
   */
  | "CONTROL_UNKNOWN_INSTANCE"
  /**
   * The engage would move an engaged switch away from `FULL_HALT`
   * (`CONTROL-1` r1, `CONTROL1-J-M1`): relaxing a full halt is a release, and a
   * release requires evidence.
   */
  | "CONTROL_ENGAGE_WOULD_WEAKEN";

/**
 * Whether a refusal's record reached the audit log.
 *
 * `api.ts` words its mode-raise `403` from this, so that refusal never CLAIMS
 * an audit record that the sink refused to write.
 */
export type ModeRaiseAuditOutcome =
  | { readonly audited: true }
  | {
      readonly audited: false;
      readonly code: string;
      readonly detail: string;
      /**
       * `true` when the sink did not ANSWER within the append bound
       * (`CONTROL-1b`): the record was not confirmed, and may still land — a
       * refusal's record landing late is still a true record of a refusal.
       * `false` when the sink or the budget refused it outright.
       */
      readonly unconfirmed: boolean;
    };

/** The same answer, for {@link ControlPlane.refuseRequest}. */
export type RefusalAuditOutcome = ModeRaiseAuditOutcome;

/**
 * Where a request to a mutating route was refused before it reached a
 * mutation method (`CONTROL-1` r1, `CONTROL1-J-M2`).
 *
 * - `TRANSPORT` — `http.ts`'s `413`, `415` or `400` (not JSON);
 * - `ROUTE_PARAMETER` — the `:instanceId` door (`instance-id.ts`);
 * - `REQUEST_BODY` — the route's body door (`api.ts`, `doors.ts`);
 * - `NOT_WIRED` — `C1-OPS`: no trader observes this process's mutations
 *   (`ControlApiOptions.mutationsReachTrader` false), answered `501`.
 */
export type RequestRefusalStage = "TRANSPORT" | "ROUTE_PARAMETER" | "REQUEST_BODY" | "NOT_WIRED";

/** What {@link ControlPlane.refuseRequest} records about one such refusal. */
export interface RequestRefusal {
  /** The refusal code the caller received, e.g. `CONTROL_REQUEST_INVALID`. */
  readonly code: string;
  readonly detail: string;
  /** The issues the caller received; the record keeps a bounded prefix. */
  readonly issues: readonly string[];
}

/** The mutating audit actions — every action except `MODE_RAISE_ATTEMPT`. */
export type MutatingAuditAction = Exclude<ControlAuditAction, "MODE_RAISE_ATTEMPT">;

/**
 * How many of a refusal's issues (or a mode-raise attempt's keys) its audit
 * record keeps, and how long each may be — in UTF-16 code units of the
 * STORED, escaped text, `…` included, cut only between code points
 * (`audit-text.ts`, `boundAuditText`).
 */
export const REFUSAL_AUDIT_MAX_ISSUES = 8;
export const REFUSAL_AUDIT_MAX_TEXT = 256;

/**
 * The default bound on one audit append, in milliseconds (`CONTROL-1b`; module
 * header, "An append is bounded"). Generous for an in-process log or a
 * loopback PostgreSQL insert, and short enough that a stalled sink answers an
 * operator `503` in seconds rather than holding the request — and the state
 * key's lock — for as long as the sink hangs.
 */
export const AUDIT_APPEND_TIMEOUT_MS = 5_000;

/** The largest bound {@link ControlPlaneOptions.auditAppendTimeoutMs} accepts. */
export const AUDIT_APPEND_TIMEOUT_MAX_MS = 60_000;

/** Why `timeoutMs` is not a usable append bound, or `undefined`. */
export function auditAppendTimeoutProblem(timeoutMs: number): string | undefined {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > AUDIT_APPEND_TIMEOUT_MAX_MS) {
    return (
      `the audit append bound must be an integer from 1 to ${String(AUDIT_APPEND_TIMEOUT_MAX_MS)} ms; ` +
      `received ${String(timeoutMs)}`
    );
  }
  return undefined;
}

/**
 * The actor a VOID record names (module header, "An append is bounded"): the
 * record is written by this process about its own refusal, not by the
 * operator whose request it was, so it is `AUTOMATED`, the other §10.6
 * `actor_kind`.
 */
export const CONTROL_PLANE_VOID_ACTOR = "control-api";

/**
 * The `control_mutations_total` outcomes an append that outlived its bound adds
 * (module header). `LANDED_LATE` counts APPLIED records that landed after their
 * mutation was refused; `VOIDED` counts the void records written for them. Their
 * difference is the number of such records the audit holds with no void beside
 * them.
 */
export const LATE_APPEND_OUTCOMES = ["LANDED_LATE", "VOIDED"] as const;

/** The clock and id source a VOID record needs (module header). */
export interface AuditRecordSource {
  /** Strict-UTC instant. */
  now(): string;
  /** A fresh, sortable, unique audit record id. */
  nextAuditRecordId(): string;
}

export type MutationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: MutationRefusalCode; readonly detail: string };

/**
 * The evidence a kill-switch release requires.
 *
 * The literal `true` is the point, and it is the same shape
 * `apps/trader`'s `HaltController.release` demands and `packages/event-bus`
 * demands for a hard-resync acknowledgement: §9.17 requires reconciliation
 * before resuming, and a release that could be requested without evidence would
 * be a release that permits the silent catch-up ADR-003 §3.3 forbids.
 *
 * **What this process can and cannot promise.** Engaging or releasing a switch
 * here changes THIS process's authoritative record and writes the §10.6 audit
 * row. Whether a running trader observes it depends on a seam that does not yet
 * exist in this repository — see `README.md`, "the composition obligation".
 * Nothing in this file claims otherwise.
 */
export interface KillSwitchRelease {
  readonly authoritativeSnapshotApplied: true;
  readonly reason: string;
}

/** Everything a mutation needs that this class refuses to invent. */
export interface MutationContext {
  /** The authenticated operator id. Never a token. */
  readonly actor: string;
  /** Caller-supplied instant (the process clock lives at the edge). */
  readonly at: string;
  /** Caller-supplied audit record id; sortable and unique per §10.7. */
  readonly auditRecordId: string;
  readonly reason: string;
}

export interface ControlPlaneOptions {
  readonly audit: ControlAuditSink;
  readonly runMode: string;
  readonly maximumRunMode: string;
  readonly repositoryMaximumRunMode: string;
  /**
   * The bound on one audit append (`CONTROL-1b`). Absent:
   * {@link AUDIT_APPEND_TIMEOUT_MS}. A value outside 1 to
   * {@link AUDIT_APPEND_TIMEOUT_MAX_MS} is a composition defect and THROWS.
   */
  readonly auditAppendTimeoutMs?: number;
  /**
   * Where a VOID record's instant and id come from (module header, "An append
   * is bounded"). `main.ts` and the test harnesses pass the API's environment.
   * Absent, an APPLIED record that lands after its bound is COUNTED
   * (`LANDED_LATE`) and not voided — so a composition that binds a sink which
   * can be slow must supply it.
   */
  readonly auditRecordSource?: AuditRecordSource;
}

/** What one bounded append answered (`ControlPlane.#write`). */
interface WriteOutcome {
  readonly result: AuditAppendResult;
  /** True when the bound expired first; `result` is then this class's own refusal. */
  readonly timedOut: boolean;
}

function scopeKey(scope: ControlKillSwitchScope, scopeRef: string | null): string {
  return `${scope}:${scopeRef ?? ""}`;
}

export class ControlPlane {
  readonly #audit: ControlAuditSink;
  readonly #runMode: string;
  readonly #maximumRunMode: string;
  readonly #repositoryMaximumRunMode: string;

  readonly #strategies = new Map<string, StrategyInstanceState>();
  readonly #killSwitches = new Map<string, KillSwitchState>();

  #modeRaiseAttemptsRefused = 0;
  #auditAppendFailures = 0;
  readonly #mutations = new Map<string, number>();

  /**
   * The tail of each state key's mutation queue (module header, "Mutations are
   * serialized per state key"). An entry exists only while a mutation of its
   * key is in flight.
   */
  readonly #locks = new Map<string, Promise<void>>();

  /** The bound on one audit append (module header, "An append is bounded"). */
  readonly #appendTimeoutMs: number;
  readonly #recordSource: AuditRecordSource | undefined;
  /** Appends that outlived their bound and have not settled yet. */
  #unsettledAppends = 0;
  /**
   * PROTECTED appends (a strengthening engage, a halting pause) that outlived
   * their bound and have not settled, by state key (module header, "One
   * unsettled protected append per state key"). An entry exists only while
   * such an append is in flight.
   */
  readonly #unsettledProtected = new Map<string, number>();

  constructor(options: ControlPlaneOptions) {
    const timeoutMs = options.auditAppendTimeoutMs ?? AUDIT_APPEND_TIMEOUT_MS;
    const problem = auditAppendTimeoutProblem(timeoutMs);
    if (problem !== undefined) throw new RangeError(problem);
    this.#audit = options.audit;
    this.#runMode = options.runMode;
    this.#maximumRunMode = options.maximumRunMode;
    this.#repositoryMaximumRunMode = options.repositoryMaximumRunMode;
    this.#appendTimeoutMs = timeoutMs;
    this.#recordSource = options.auditRecordSource;
  }

  /** The bound on one audit append, in milliseconds. */
  get auditAppendTimeoutMs(): number {
    return this.#appendTimeoutMs;
  }

  /**
   * Appends that outlived their bound and whose sink has not answered yet
   * (module header). Each is a record that may still land.
   */
  get unsettledAuditAppends(): number {
    return this.#unsettledAppends;
  }

  /**
   * Whether an APPLIED record that lands after its bound is VOIDED — that is,
   * whether this control plane was composed with an
   * {@link ControlPlaneOptions.auditRecordSource}. `main.ts` reports it at
   * startup, so the shipped composition's wiring is visible and pinned
   * (`CONTROL-1b` r1, closing `CONTROL1B-R1-J-L1`).
   */
  get voidsLateAppliedRecords(): boolean {
    return this.#recordSource !== undefined;
  }

  /**
   * Registers an instance this control plane may pause.
   *
   * NOT a mutation an operator performs — it is composition, done at startup
   * from configuration, before any request is served. It writes no audit record
   * because nothing changed for an operator: an instance the control plane does
   * not know is an instance it cannot pause, and registering it grants no one
   * anything.
   *
   * The id must satisfy the route parameter's grammar (`instance-id.ts`), so
   * every registered instance is one `POST /v1/strategies/:instanceId/…` can
   * address. An id it cannot is a composition defect, and it THROWS at startup
   * rather than registering an instance no operator could ever pause.
   *
   * The shipped composition (`main.ts`) registers NONE: no seam reaches a
   * running trader's strategies yet (`README.md`, "the composition
   * obligation"), and registering an id this process cannot control would make
   * a `200 PAUSED` a claim about nothing (`CONTROL-1`, M-1).
   */
  register(instanceId: string, at: string): void {
    const problem = instanceIdProblem(instanceId);
    if (problem !== undefined) {
      throw new RangeError(`cannot register strategy instance: ${problem}`);
    }
    if (this.#strategies.has(instanceId)) return;
    this.#strategies.set(
      instanceId,
      Object.freeze({
        instanceId,
        state: "RUNNING",
        reason: "registered at startup",
        since: at,
        actor: "system",
      }),
    );
  }

  runState(): RunStateView {
    return Object.freeze({
      runMode: this.#runMode,
      maximumRunMode: this.#maximumRunMode,
      repositoryMaximumRunMode: this.#repositoryMaximumRunMode,
      allowRealOrders: false as const,
      runModeIsWritable: false as const,
      signerLoaded: false as const,
    });
  }

  strategies(): readonly StrategyInstanceState[] {
    return Object.freeze(
      [...this.#strategies.values()].sort((left, right) =>
        left.instanceId < right.instanceId ? -1 : left.instanceId > right.instanceId ? 1 : 0,
      ),
    );
  }

  killSwitches(): readonly KillSwitchState[] {
    return Object.freeze(
      [...this.#killSwitches.entries()]
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([, value]) => value),
    );
  }

  get modeRaiseAttemptsRefused(): number {
    return this.#modeRaiseAttemptsRefused;
  }

  get auditAppendFailures(): number {
    return this.#auditAppendFailures;
  }

  /** Mutation attempts by `action|outcome`, sorted, for the metrics surface. */
  mutationCounts(): readonly {
    readonly action: string;
    readonly outcome: string;
    readonly count: number;
  }[] {
    return Object.freeze(
      [...this.#mutations.entries()]
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, count]) => {
          const [action = "", outcome = ""] = key.split("|");
          return { action, outcome, count };
        }),
    );
  }

  // --- the mutations --------------------------------------------------------

  /** Pauses a strategy instance. §14.1 `STRATEGY_INSTANCE` scope, config class. */
  async pauseStrategy(
    instanceId: string,
    context: MutationContext,
  ): Promise<MutationResult<StrategyInstanceState>> {
    return this.#serialized(strategyLockKey(instanceId), () =>
      this.#setStrategyState(instanceId, "PAUSED", "STRATEGY_PAUSE", context),
    );
  }

  /** Resumes a strategy instance. */
  async resumeStrategy(
    instanceId: string,
    context: MutationContext,
  ): Promise<MutationResult<StrategyInstanceState>> {
    return this.#serialized(strategyLockKey(instanceId), () =>
      this.#setStrategyState(instanceId, "RUNNING", "STRATEGY_RESUME", context),
    );
  }

  /**
   * Runs `mutation` after every earlier mutation of the same `key` has
   * settled, and before any later one starts (module header). The queue's
   * links never reject — each is a promise this method resolves in `finally`
   * — so one failed mutation cannot wedge its key.
   */
  async #serialized<T>(key: string, mutation: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => settled);
    this.#locks.set(key, tail);
    try {
      await previous;
      return await mutation();
    } finally {
      release();
      if (this.#locks.get(key) === tail) this.#locks.delete(key);
    }
  }

  /** How many state keys have a mutation in flight (`CONTROL-1` r1; for tests). */
  get mutationsInFlight(): number {
    return this.#locks.size;
  }

  async #setStrategyState(
    instanceId: string,
    next: StrategyRunState,
    action: ControlAuditAction,
    context: MutationContext,
  ): Promise<MutationResult<StrategyInstanceState>> {
    const prior = this.#strategies.get(instanceId);
    if (prior === undefined) {
      // `CONTROL-1`, M-1: REFUSE, exactly as `releaseKillSwitch` refuses a
      // switch nobody engaged. No prior is fabricated and nothing is inserted.
      return this.#refuse(action, context, "STRATEGY_INSTANCE", instanceId, strategyUnknown(instanceId), {
        code: "CONTROL_UNKNOWN_INSTANCE",
        detail:
          `strategy instance ${instanceId} is not registered with this control plane; answering ` +
          `'${next}' here would let an operator mistake a change to an instance nothing runs for a ` +
          "change that took effect (the shipped composition registers no instance until a seam " +
          "reaches a running trader's strategies — README, 'the composition obligation')",
      });
    }

    if (prior.state === next) {
      return this.#refuse(action, context, "STRATEGY_INSTANCE", instanceId, strategyDocument(prior), {
        code: "CONTROL_ALREADY_IN_STATE",
        detail:
          `strategy instance ${instanceId} is already ${next}; the request is refused rather than ` +
          "recorded as a change, because an audit log full of no-ops is an audit log nobody reads",
      });
    }

    const resulting: StrategyInstanceState = Object.freeze({
      instanceId,
      state: next,
      reason: context.reason,
      since: context.at,
      actor: context.actor,
    });

    const appended = await this.#append(
      action,
      "APPLIED",
      context,
      "STRATEGY_INSTANCE",
      instanceId,
      strategyDocument(prior),
      strategyDocument(resulting),
      undefined,
      strategyLockKey(instanceId),
    );
    if (!appended.ok) return appended.refusal;

    this.#strategies.set(instanceId, resulting);
    return { ok: true, value: resulting };
  }

  /** Engages a §14.1 kill switch. */
  async engageKillSwitch(
    request: {
      readonly scope: ControlKillSwitchScope;
      readonly scopeRef: string | null;
      readonly action: ControlKillSwitchAction;
    },
    context: MutationContext,
  ): Promise<MutationResult<KillSwitchState>> {
    const key = scopeKey(request.scope, request.scopeRef);
    return this.#serialized(killSwitchLockKey(key), () => this.#engage(key, request, context));
  }

  async #engage(
    key: string,
    request: {
      readonly scope: ControlKillSwitchScope;
      readonly scopeRef: string | null;
      readonly action: ControlKillSwitchAction;
    },
    context: MutationContext,
  ): Promise<MutationResult<KillSwitchState>> {
    const prior = this.#killSwitches.get(key);
    const priorDocument = prior === undefined ? killSwitchAbsent(request.scope, request.scopeRef) : killSwitchDocument(prior);

    // §10.6 `kill_switch_events_scope_ref`: "A scoped switch must say what it
    // is scoped to; a GLOBAL one must not." Enforced HERE as well as in the
    // database, because an insert that fails at the audit step would refuse
    // the mutation with a database error instead of an operator-legible one.
    const globalWithRef = request.scope === "GLOBAL" && request.scopeRef !== null;
    const scopedWithoutRef = request.scope !== "GLOBAL" && request.scopeRef === null;
    if (globalWithRef || scopedWithoutRef) {
      return this.#refuse(
        "KILL_SWITCH_ENGAGE",
        context,
        request.scope,
        request.scopeRef,
        priorDocument,
        {
          code: "CONTROL_SCOPE_REF_MISMATCH",
          detail: globalWithRef
            ? "a GLOBAL kill switch names no scope reference (§10.6 kill_switch_events_scope_ref)"
            : `a ${request.scope} kill switch must name what it is scoped to (§10.6 kill_switch_events_scope_ref)`,
        },
      );
    }

    // `CONTROL-1` r1, `CONTROL1-J-M1` (module header, "An engage never repeats
    // and never weakens"): the two overwrites that are not engages are refused,
    // in the ORDINARY tier, before anything is recorded as applied.
    if (prior !== undefined && prior.action === request.action) {
      return this.#refuse("KILL_SWITCH_ENGAGE", context, request.scope, request.scopeRef, priorDocument, {
        code: "CONTROL_ALREADY_IN_STATE",
        detail:
          `the ${request.scope} kill switch for ${request.scopeRef ?? "the global scope"} is already ` +
          `engaged at ${request.action}; the request is refused rather than recorded as a change, because ` +
          "an audit log full of no-ops is an audit log nobody reads — and a no-op must not spend the " +
          "audit capacity a real halt needs",
      });
    }
    if (prior?.action === STRONGEST_KILL_SWITCH_ACTION) {
      return this.#refuse("KILL_SWITCH_ENGAGE", context, request.scope, request.scopeRef, priorDocument, {
        code: "CONTROL_ENGAGE_WOULD_WEAKEN",
        detail:
          `the ${request.scope} kill switch for ${request.scopeRef ?? "the global scope"} is engaged at ` +
          `${STRONGEST_KILL_SWITCH_ACTION}; engaging ${request.action} over it would RELAX it, and relaxing a ` +
          "full halt is a release: POST /v1/kill-switch/release with authoritativeSnapshotApplied: true " +
          "(§9.17), then engage the action wanted",
      });
    }

    const resulting: KillSwitchState = Object.freeze({
      scope: request.scope,
      scopeRef: request.scopeRef,
      action: request.action,
      reason: context.reason,
      since: context.at,
      actor: context.actor,
    });

    const appended = await this.#append(
      "KILL_SWITCH_ENGAGE",
      "APPLIED",
      context,
      request.scope,
      request.scopeRef,
      priorDocument,
      killSwitchDocument(resulting),
      undefined,
      killSwitchLockKey(key),
    );
    if (!appended.ok) return appended.refusal;

    this.#killSwitches.set(key, resulting);
    return { ok: true, value: resulting };
  }

  /** Releases a §14.1 kill switch, against evidence. */
  async releaseKillSwitch(
    request: {
      readonly scope: ControlKillSwitchScope;
      readonly scopeRef: string | null;
      readonly release: KillSwitchRelease;
    },
    context: MutationContext,
  ): Promise<MutationResult<{ readonly released: KillSwitchState }>> {
    const key = scopeKey(request.scope, request.scopeRef);
    return this.#serialized(killSwitchLockKey(key), () => this.#release(key, request, context));
  }

  async #release(
    key: string,
    request: {
      readonly scope: ControlKillSwitchScope;
      readonly scopeRef: string | null;
      readonly release: KillSwitchRelease;
    },
    context: MutationContext,
  ): Promise<MutationResult<{ readonly released: KillSwitchState }>> {
    const prior = this.#killSwitches.get(key);
    const priorDocument =
      prior === undefined ? killSwitchAbsent(request.scope, request.scopeRef) : killSwitchDocument(prior);

    if (request.release.authoritativeSnapshotApplied !== true) {
      return this.#refuse("KILL_SWITCH_RELEASE", context, request.scope, request.scopeRef, priorDocument, {
        code: "CONTROL_RELEASE_EVIDENCE_MISSING",
        detail:
          "a release requires authoritativeSnapshotApplied: true — §9.17 requires reconciliation " +
          "before resuming, and a release requestable without evidence permits the silent " +
          "catch-up ADR-003 §3.3 forbids",
      });
    }

    if (prior === undefined) {
      return this.#refuse("KILL_SWITCH_RELEASE", context, request.scope, request.scopeRef, priorDocument, {
        code: "CONTROL_NOT_ENGAGED",
        detail:
          `no ${request.scope} kill switch is engaged for ${request.scopeRef ?? "the global scope"}; ` +
          "answering 'released' here would let an operator mistake an acknowledgement of a switch " +
          "that never existed for a recovery",
      });
    }

    const appended = await this.#append(
      "KILL_SWITCH_RELEASE",
      "APPLIED",
      context,
      request.scope,
      request.scopeRef,
      priorDocument,
      killSwitchAbsent(request.scope, request.scopeRef),
      undefined,
      killSwitchLockKey(key),
    );
    if (!appended.ok) return appended.refusal;

    this.#killSwitches.delete(key);
    return { ok: true, value: { released: prior } };
  }

  /**
   * Records an authenticated request that tried to raise a run mode, enable
   * real orders, raise a live-micro cap, or name a signer.
   *
   * It changes nothing. The HTTP layer has already refused the request; this
   * makes the attempt EVIDENCE (§14.1's append-only audit) and increments the
   * counter the operations dashboard shows. Acceptance 1's "refused by name and
   * audited" is this method plus `vocabulary.ts`'s key list.
   *
   * Its caller holds at least one MUTATION grant: `api.ts` routes an attempt
   * from a caller without one to {@link ControlPlane.countModeRaiseWithoutAudit}
   * instead (`CONTROL-1`, M-3). It RETURNS whether the record was written, so
   * the refusal an operator reads never claims an audit the sink refused — an
   * ordinary record is refused once the audit budget's ordinary tier is full
   * (`audit-budget.ts`), and the request is refused by name either way.
   */
  async refuseModeRaise(
    keys: readonly string[],
    context: MutationContext,
  ): Promise<ModeRaiseAuditOutcome> {
    this.#modeRaiseAttemptsRefused += 1;
    const ceiling = runStateDocument(this.runState());
    // BOUNDED (`CONTROL-1b`, closing `CONTROL-1` follow-up 3b). At `CONTROL-1`
    // this record carried every forbidden key a body named and a reason
    // holding the request's whole path — bounded only by the transport, so a
    // mutation-authorized caller chose how large a record it wrote. It now
    // keeps what the other refusal records keep:
    //
    // - `attemptedKeys`: at most `REFUSAL_AUDIT_MAX_ISSUES` keys of at most
    //   `REFUSAL_AUDIT_MAX_TEXT` code units each, built by an INDEX WALK into
    //   an array literal (`boundedList`). That container is ORDINARY whatever
    //   species the caller passed — `Array.prototype.map` would have PRESERVED
    //   it (ECMA-262 `ArraySpeciesCreate`), and `adapters/postgres-audit-sink.ts`'s
    //   own-data encoder refuses a container whose prototype is neither
    //   `Array.prototype` nor `null`, which would refuse a record `pg` wrote
    //   (`SER-3` review round 2, N1; pinned by
    //   `test/unit/control-api/outbound-container-species.test.ts`). The index
    //   walk also reads INDICES, as base's `.map()` did, rather than a
    //   caller-overridable iterator — so the `SER-3` residual 6 / N4 trade-off
    //   the earlier `[...keys]` spread made (`GOV-2C`, 2026-09-15) is gone: the
    //   recorded values are the array's own elements.
    // - `attemptedKeyCount`: the number of keys named, present EXACTLY when the
    //   list was cut — so a record naming eight or fewer keys is byte-identical
    //   to the one `CONTROL-1` wrote (the byte pin above);
    // - the reason, cut to `REFUSAL_AUDIT_MAX_TEXT` (`api.ts` builds it from a
    //   bounded path and a bounded key list, so the cut is a second fence).
    const attemptedKeys = boundedList(keys);
    const appended = await this.#append(
      "MODE_RAISE_ATTEMPT",
      "REFUSED",
      { ...context, reason: bounded(context.reason) },
      "CONTROL_PLANE",
      null,
      ceiling,
      ceiling,
      keys.length > REFUSAL_AUDIT_MAX_ISSUES
        ? { attemptedKeys, attemptedKeyCount: String(keys.length) }
        : { attemptedKeys },
    );
    return appended.ok
      ? { audited: true }
      : {
          audited: false,
          code: appended.refusal.code,
          detail: appended.refusal.detail,
          unconfirmed: appended.timedOut,
        };
  }

  /**
   * Counts a refused mode-raise attempt from a caller WITHOUT mutation
   * authority, and writes NOTHING (`CONTROL-1`, closing `WP-240` r1 M-3).
   *
   * The HTTP layer has already refused the request by name. The attempt still
   * moves `control_mode_raise_attempts_refused_total`, so a reader repeatedly
   * trying is visible; it is not appended, because a READ-only credential that
   * could append could fill the log, and a full log refuses every mutation,
   * the kill switch included. The difference between that counter and
   * `control_mutations_total{action="MODE_RAISE_ATTEMPT"}` is exactly the
   * attempts this method counted.
   */
  countModeRaiseWithoutAudit(): void {
    this.#modeRaiseAttemptsRefused += 1;
  }

  /**
   * Records a request to a MUTATING route that was refused before it reached
   * a mutation method — at the transport, the route parameter or the body door
   * (`CONTROL-1` r1, closing `CONTROL1-J-M2`).
   *
   * It changes nothing and reads no state: the request never named a change
   * this class could evaluate. `api.ts` calls it only AFTER authentication and
   * the route's authorization, so its caller holds the route's mutation grant
   * and an actor without mutation authority still writes nothing (`WP-240` r1
   * M-3). The record is `REFUSED`, so the audit budget admits it in the
   * ORDINARY tier; a record the budget or the sink refuses is counted
   * `NOT_AUDITED`, the refusal stands, and the return value says which
   * happened.
   *
   * What the record keeps is bounded whatever the request carried: the
   * operator's id, the route's action, the target the route parameter named
   * when it passed its door (never a caller's undecoded bytes), the refusal
   * code and detail, and at most {@link REFUSAL_AUDIT_MAX_ISSUES} issues of at
   * most {@link REFUSAL_AUDIT_MAX_TEXT} characters each.
   */
  async refuseRequest(
    action: MutatingAuditAction,
    target: { readonly scope: string; readonly scopeRef: string | null },
    stage: RequestRefusalStage,
    refusal: RequestRefusal,
    context: MutationContext,
  ): Promise<RefusalAuditOutcome> {
    // Nothing was read and nothing changed, so prior and resulting are one
    // document saying so.
    const state: AuditStateDocument = { refusedAt: stage, stateRead: "false" };
    const appended = await this.#append(action, "REFUSED", context, target.scope, target.scopeRef, state, state, {
      refusalCode: bounded(refusal.code),
      refusalDetail: bounded(refusal.detail),
      refusalIssues: boundedList(refusal.issues),
      refusalIssueCount: String(refusal.issues.length),
    });
    return appended.ok
      ? { audited: true }
      : {
          audited: false,
          code: appended.refusal.code,
          detail: appended.refusal.detail,
          unconfirmed: appended.timedOut,
        };
  }

  // --- the audit path -------------------------------------------------------

  async #refuse(
    action: ControlAuditAction,
    context: MutationContext,
    scope: string,
    scopeRef: string | null,
    state: AuditStateDocument,
    refusal: { readonly code: MutationRefusalCode; readonly detail: string },
  ): Promise<{ readonly ok: false; readonly code: MutationRefusalCode; readonly detail: string }> {
    await this.#append(action, "REFUSED", context, scope, scopeRef, state, state, {
      refusalCode: refusal.code,
      refusalDetail: refusal.detail,
    });
    return { ok: false, code: refusal.code, detail: refusal.detail };
  }

  async #append(
    action: ControlAuditAction,
    outcome: ControlAuditOutcome,
    context: MutationContext,
    scope: string,
    scopeRef: string | null,
    priorState: AuditStateDocument,
    resultingState: AuditStateDocument,
    extra?: Readonly<Record<string, AuditStateDocument>>,
    /**
     * The state key whose lock the caller holds — passed by the three methods
     * that write an APPLIED record (module header, "One unsettled protected
     * append per state key"). Absent for a refusal, which is always ordinary.
     */
    stateKey?: string,
  ): Promise<
    | { readonly ok: true }
    | {
        readonly ok: false;
        /** True when the append outlived its bound (module header). */
        readonly timedOut: boolean;
        readonly refusal: {
          readonly ok: false;
          readonly code: MutationRefusalCode;
          readonly detail: string;
        };
      }
  > {
    const record: ControlAuditRecord = {
      recordId: context.auditRecordId,
      action,
      outcome,
      actor: context.actor,
      actorKind: CONTROL_ACTOR_KIND,
      scope,
      scopeRef,
      reason: context.reason,
      priorState,
      resultingState:
        extra === undefined
          ? resultingState
          : mergeDocuments(resultingState, extra),
      at: context.at,
    };
    // `CONTROL-1b` r1 (closing `CONTROL1B-R1-J-M1`; module header, "One
    // unsettled protected append per state key"). The tier is the audit
    // budget's own reading of THIS record, so "protected" here means exactly
    // what would take a protected slot there. Checked under the key's lock, and
    // registered by `#write` before that lock is released, so the next
    // mutation of the key always sees it.
    const protectedKey = stateKey !== undefined && auditBudgetTier(record) !== "ORDINARY" ? stateKey : undefined;
    if (protectedKey !== undefined && this.#unsettledProtected.has(protectedKey)) {
      this.#count(action, "NOT_AUDITED");
      return {
        ok: false,
        timedOut: false,
        refusal: {
          ok: false,
          code: "CONTROL_NOT_AUDITABLE",
          detail:
            `an earlier ${action} of this ${scope === "STRATEGY_INSTANCE" ? "strategy instance" : "kill switch"} ` +
            `is UNSETTLED: its audit append outlived the ${String(this.#appendTimeoutMs)} ms bound and the sink ` +
            "has not answered it yet. Until it does, this one is refused WITHOUT an audit append: each " +
            "attempt that timed out and then landed would spend another record of the audit reserve a halt " +
            "needs, although nothing was applied. The mutation did NOT happen; retry once the sink answers " +
            "(README, 'An append is bounded')",
        },
      };
    }
    const { result: appended, timedOut } = await this.#write(record, protectedKey);
    // The COUNTER records what happened, which is not always what was asked
    // for. An append that failed means the mutation did NOT happen, so it is
    // counted under its own outcome rather than under `APPLIED` — the metric
    // an operator reads must not say a change was applied when the control
    // plane refused to apply it. `NOT_AUDITED` is a metric label only; the
    // AUDIT vocabulary stays the two outcomes §14.1's record can carry, since
    // by definition no record was written for this one. An append that
    // outlived its bound is `NOT_AUDITED` too: this control plane treated it as
    // unwritten and refused (module header, "An append is bounded").
    this.#count(action, appended.ok ? outcome : "NOT_AUDITED");
    if (appended.ok) return { ok: true };

    this.#auditAppendFailures += 1;
    return {
      ok: false,
      timedOut,
      refusal: {
        ok: false,
        code: "CONTROL_NOT_AUDITABLE",
        detail:
          `the audit append was refused (${appended.code}): ${appended.detail}. The mutation did ` +
          "NOT happen — this control plane audits before it applies, so an unauditable control " +
          "plane does nothing rather than acting in the dark",
      },
    };
  }

  #count(action: ControlAuditAction, outcome: string): void {
    this.#mutations.set(`${action}|${outcome}`, (this.#mutations.get(`${action}|${outcome}`) ?? 0) + 1);
  }

  /**
   * Hands `raw` to the sink ESCAPED, exactly once (`audit-text.ts`, the
   * chokepoint), and waits at most the append bound for the answer (module
   * header, "An append is bounded").
   *
   * - The sink answers in time: its answer, as at `CONTROL-1`. A sink that
   *   throws or rejects in time still rejects here — the port is total by
   *   contract, and a broken sink stays visible as `CONTROL_INTERNAL_ERROR`
   *   rather than being re-labelled.
   * - The bound expires first: this class's own refusal,
   *   `AUDIT_SINK_UNAVAILABLE`, and the caller refuses the mutation. The sink's
   *   eventual answer is handed to {@link ControlPlane.#settledLate}, which can
   *   only ever WRITE (a void record) — never apply.
   *
   * `protectedKey` names the state key of a PROTECTED record (module header,
   * "One unsettled protected append per state key"): when the bound expires it
   * is registered as unsettled — synchronously, before the caller's lock is
   * released — and it is cleared when the sink answers, whatever it answers.
   */
  #write(raw: ControlAuditRecord, protectedKey?: string): Promise<WriteOutcome> {
    // A synchronous throw from the sink propagates from here, as it did when
    // the append was awaited directly.
    const pending = this.#audit.append(auditSafeRecord(raw));
    return new Promise<WriteOutcome>((resolve, reject) => {
      let answered = false;
      const timer = setTimeout(() => {
        answered = true;
        this.#unsettledAppends += 1;
        if (protectedKey !== undefined) {
          this.#unsettledProtected.set(protectedKey, (this.#unsettledProtected.get(protectedKey) ?? 0) + 1);
        }
        resolve({
          timedOut: true,
          result: {
            ok: false,
            code: "AUDIT_SINK_UNAVAILABLE",
            detail:
              `the audit sink did not answer within the ${String(this.#appendTimeoutMs)} ms append bound, ` +
              "so the record is UNCONFIRMED and is treated as unwritten. If an APPLIED record lands " +
              "later, this process appends a REFUSED record voiding it when the sink and the audit budget " +
              "admit one — a void is an ordinary record, so a full ordinary tier refuses it, and " +
              "control_mutations_total LANDED_LATE minus VOIDED counts the APPLIED records left unvoided " +
              "(README, 'An append is bounded')",
          },
        });
      }, this.#appendTimeoutMs);
      Promise.resolve(pending).then(
        (result) => {
          if (!answered) {
            answered = true;
            clearTimeout(timer);
            resolve({ result, timedOut: false });
            return;
          }
          this.#unsettledAppends -= 1;
          this.#settleProtected(protectedKey);
          this.#settledLate(raw, result);
        },
        (cause: unknown) => {
          if (!answered) {
            answered = true;
            clearTimeout(timer);
            reject(cause);
            return;
          }
          // A late throw: the sink says nothing landed. `NOT_AUDITED` stands.
          this.#unsettledAppends -= 1;
          this.#settleProtected(protectedKey);
        },
      );
    });
  }

  /** The sink answered a timed-out protected append: its key's gate lifts. */
  #settleProtected(protectedKey: string | undefined): void {
    if (protectedKey === undefined) return;
    const remaining = (this.#unsettledProtected.get(protectedKey) ?? 0) - 1;
    if (remaining > 0) this.#unsettledProtected.set(protectedKey, remaining);
    else this.#unsettledProtected.delete(protectedKey);
  }

  /**
   * The sink answered an append AFTER its bound expired and its mutation was
   * refused (module header). Nothing here applies anything: the mutation's
   * continuation has already returned its refusal and released its lock.
   *
   * - A late REFUSAL of the append, or a late REFUSED record landing: the audit
   *   already tells the truth (nothing landed, or a refusal that happened).
   * - A late APPLIED record landing: the audit now holds `APPLIED` for a
   *   mutation that did not happen. It is counted `LANDED_LATE`, and a VOID
   *   record is appended: `REFUSED`, same action and target, naming the
   *   voided record's id, its prior state unchanged. The void is counted
   *   `VOIDED` once its own append lands. Without a record source, or when the
   *   void cannot be written, the late record stays counted and unvoided.
   *
   * TOTAL: it never throws and leaves no rejection unhandled.
   */
  #settledLate(raw: ControlAuditRecord, result: AuditAppendResult): void {
    // `accepted`, not `result.ok`: a sink that breaks the port's type and
    // resolves something else LATE must not throw here, where nothing would
    // catch it (an unhandled rejection can stop the process).
    if (!accepted(result) || raw.outcome !== "APPLIED") return;
    this.#count(raw.action, "LANDED_LATE");
    const source = this.#recordSource;
    if (source === undefined) return;
    let pending: Promise<AuditAppendResult>;
    try {
      const voidRecord = voidRecordFor(raw, source.now(), source.nextAuditRecordId(), this.#appendTimeoutMs);
      pending = Promise.resolve(this.#audit.append(auditSafeRecord(voidRecord)));
    } catch {
      return;
    }
    pending.then(
      (voided) => {
        if (accepted(voided)) this.#count(raw.action, "VOIDED");
      },
      () => undefined,
    );
  }
}

/**
 * Whether a sink's answer is an acceptance — read defensively, because on the
 * LATE path (`ControlPlane.#settledLate`) nothing above it would catch a throw.
 */
function accepted(result: unknown): boolean {
  return typeof result === "object" && result !== null && (result as { readonly ok?: unknown }).ok === true;
}

/**
 * The record that VOIDS an APPLIED record which landed after its bound (module
 * header, "An append is bounded"). Built from the voided record's RAW fields,
 * so the one escape the chokepoint applies makes its `voidsRecordId`, target
 * and prior state equal, byte for byte, to what the sink holds for the record
 * it voids.
 */
function voidRecordFor(
  voided: ControlAuditRecord,
  at: string,
  recordId: string,
  timeoutMs: number,
): ControlAuditRecord {
  return {
    recordId,
    action: voided.action,
    outcome: "REFUSED",
    actor: CONTROL_PLANE_VOID_ACTOR,
    actorKind: "AUTOMATED",
    scope: voided.scope,
    scopeRef: voided.scopeRef,
    reason:
      `VOID of audit record ${voided.recordId}: its append outlived the ${String(timeoutMs)} ms bound, so ` +
      `its ${voided.action} was refused and NOT applied; the record landed afterwards`,
    priorState: voided.priorState,
    resultingState: mergeDocuments(voided.priorState, {
      voidsRecordId: voided.recordId,
      voidsOutcome: voided.outcome,
      voidsActor: voided.actor,
      refusalCode: "CONTROL_NOT_AUDITABLE",
      refusalDetail:
        `the append of audit record ${voided.recordId} did not settle within the ${String(timeoutMs)} ms ` +
        `bound, so the ${voided.action} it records was refused 503 CONTROL_NOT_AUDITABLE and NOT applied; ` +
        "the record landed afterwards, and this record VOIDS its APPLIED outcome",
    }),
    at,
  };
}

function strategyLockKey(instanceId: string): string {
  return `strategy:${instanceId}`;
}

function killSwitchLockKey(key: string): string {
  return `kill-switch:${key}`;
}

/**
 * `text`, cut so that the STORED (escaped) form is at most
 * {@link REFUSAL_AUDIT_MAX_TEXT} UTF-16 code units, `…` included, and only
 * between code points (`audit-text.ts`, `boundAuditText`; `CONTROL-1b`). At
 * `CONTROL-1` it cut by `String.prototype.slice`, which can split a surrogate
 * pair and so MAKE a lone surrogate — a record `jsonb` refuses.
 */
function bounded(text: string): string {
  return boundAuditText(text, REFUSAL_AUDIT_MAX_TEXT);
}

/**
 * A bounded prefix of `items` — a refusal's issues, a mode-raise attempt's
 * keys — as an ORDINARY array of strings whatever species the caller passed:
 * an index walk into a literal, for the reason
 * {@link ControlPlane.refuseModeRaise}'s comment gives (a foreign container
 * species in a §14.1 document would make the Postgres sink refuse the record).
 */
function boundedList(items: readonly string[]): readonly string[] {
  const out: string[] = [];
  const count = Math.min(items.length, REFUSAL_AUDIT_MAX_ISSUES);
  for (let index = 0; index < count; index += 1) out.push(bounded(String(items[index])));
  return out;
}

function mergeDocuments(
  base: AuditStateDocument,
  extra: Readonly<Record<string, AuditStateDocument>>,
): AuditStateDocument {
  if (typeof base !== "object" || base === null || Array.isArray(base)) {
    return { value: base, ...extra };
  }
  return { ...base, ...extra };
}

function strategyDocument(state: StrategyInstanceState): AuditStateDocument {
  return {
    instanceId: state.instanceId,
    state: state.state,
    reason: state.reason,
    since: state.since,
    actor: state.actor,
  };
}

/** The prior state of an instance the control plane does not know (M-1). */
function strategyUnknown(instanceId: string): AuditStateDocument {
  return { known: "false", instanceId };
}

function killSwitchDocument(state: KillSwitchState): AuditStateDocument {
  return {
    engaged: "true",
    scope: state.scope,
    scopeRef: state.scopeRef,
    action: state.action,
    reason: state.reason,
    since: state.since,
    actor: state.actor,
  };
}

function killSwitchAbsent(scope: string, scopeRef: string | null): AuditStateDocument {
  return { engaged: "false", scope, scopeRef };
}

function runStateDocument(view: RunStateView): AuditStateDocument {
  return {
    runMode: view.runMode,
    maximumRunMode: view.maximumRunMode,
    repositoryMaximumRunMode: view.repositoryMaximumRunMode,
    // Written as strings, not booleans-as-numbers: the audit document type
    // excludes `number` at every depth for the reason its own comment gives.
    allowRealOrders: "false",
    runModeIsWritable: "false",
    signerLoaded: "false",
  };
}
