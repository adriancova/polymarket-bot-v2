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
 * — for a caller holding at least one mutation grant. A caller with NO
 * mutation authority writes nothing here at all (`CONTROL-1`, closing
 * `WP-240` r1 M-3): an unauthenticated request never reaches this class, an
 * unauthorized one is refused before it, and a READ-only operator's mode-raise
 * attempt is COUNTED through {@link ControlPlane.countModeRaiseWithoutAudit}
 * and never appended. An audit log a caller without mutation authority could
 * append to is one it could exhaust, and this one refuses mutations — the kill
 * switch included — when it is full. `README.md`, "The audit budget", states
 * the whole design; `audit-budget.ts` is its second half.
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
  type AuditStateDocument,
  type ControlAuditAction,
  type ControlAuditOutcome,
  type ControlAuditRecord,
  type ControlAuditSink,
} from "@polymarket-bot/observability";

import { instanceIdProblem } from "./instance-id.js";
import { CONTROL_ACTOR_KIND, type ControlKillSwitchAction, type ControlKillSwitchScope } from "./vocabulary.js";

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
  | "CONTROL_UNKNOWN_INSTANCE";

/**
 * Whether a refused mode-raise attempt reached the audit log.
 *
 * `api.ts` words its `403` from this, so the refusal never CLAIMS an audit
 * record that the sink refused to write.
 */
export type ModeRaiseAuditOutcome =
  | { readonly audited: true }
  | { readonly audited: false; readonly code: string; readonly detail: string };

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

  constructor(options: ControlPlaneOptions) {
    this.#audit = options.audit;
    this.#runMode = options.runMode;
    this.#maximumRunMode = options.maximumRunMode;
    this.#repositoryMaximumRunMode = options.repositoryMaximumRunMode;
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
    return this.#setStrategyState(instanceId, "PAUSED", "STRATEGY_PAUSE", context);
  }

  /** Resumes a strategy instance. */
  async resumeStrategy(
    instanceId: string,
    context: MutationContext,
  ): Promise<MutationResult<StrategyInstanceState>> {
    return this.#setStrategyState(instanceId, "RUNNING", "STRATEGY_RESUME", context);
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
    const appended = await this.#append(
      "MODE_RAISE_ATTEMPT",
      "REFUSED",
      context,
      "CONTROL_PLANE",
      null,
      ceiling,
      ceiling,
      // `[...keys]`, NOT `keys.map(...)`: an array-literal spread is an
      // ORDINARY array whatever species the caller passed, where
      // `Array.prototype.map` PRESERVES it (ECMA-262 `ArraySpeciesCreate`) —
      // and `readonly string[]` is satisfied by an `Array` SUBCLASS with no
      // cast. This container goes into the §14.1 audit record, which
      // `adapters/postgres-audit-sink.ts` serializes with the own-data
      // encoder; that encoder refuses a container whose prototype is neither
      // `Array.prototype` nor `null`, and this control plane AUDITS BEFORE IT
      // APPLIES — so a foreign species here would refuse a record `pg` wrote.
      // (`SER-3` review round 2, N1: the same spelling and the same reason as
      // `packages/polymarket-public/src/venue/frames.ts`'s `assets_ids`.)
      // `test/unit/control-api/outbound-container-species.test.ts` pins it.
      // The trade-off (`SER-3` residual 6 / N4, recorded 2026-09-15 by
      // `GOV-2C`): the spread reads the caller's ITERATOR where base's
      // `.map()` read INDICES, so an `Array` subclass overriding
      // `Symbol.iterator` changes the recorded VALUES — never the species, so
      // the encoder is satisfied and nothing refuses — accepted because this
      // list is §14.1 audit DIAGNOSTICS rather than a decision (the 403 is
      // decided by `forbiddenControlKeysIn` walking the body), whereas
      // `packages/polymarket-public/src/rtds/frames.ts` went the other way
      // with an index walk because its values are load-bearing for an
      // outbound protocol frame.
      { attemptedKeys: [...keys] },
    );
    return appended.ok
      ? { audited: true }
      : { audited: false, code: appended.refusal.code, detail: appended.refusal.detail };
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
  ): Promise<
    | { readonly ok: true }
    | {
        readonly ok: false;
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
    const appended = await this.#audit.append(record);
    // The COUNTER records what happened, which is not always what was asked
    // for. An append that failed means the mutation did NOT happen, so it is
    // counted under its own outcome rather than under `APPLIED` — the metric
    // an operator reads must not say a change was applied when the control
    // plane refused to apply it. `NOT_AUDITED` is a metric label only; the
    // AUDIT vocabulary stays the two outcomes §14.1's record can carry, since
    // by definition no record was written for this one.
    const measured = appended.ok ? outcome : "NOT_AUDITED";
    this.#mutations.set(
      `${action}|${measured}`,
      (this.#mutations.get(`${action}|${measured}`) ?? 0) + 1,
    );
    if (appended.ok) return { ok: true };

    this.#auditAppendFailures += 1;
    return {
      ok: false,
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
