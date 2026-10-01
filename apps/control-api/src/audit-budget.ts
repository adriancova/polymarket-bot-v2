/**
 * The AUDIT BUDGET — `CONTROL-1`'s second half of the fix for `WP-240` r1
 * **M-3** (audit-log exhaustion could disable the kill switch).
 *
 * ## The problem a single bound has
 *
 * The audit log refuses at its bound rather than evicting (`packages/
 * observability`'s `InMemoryControlAuditLog`: the records an eviction would
 * lose are the ones from the incident that filled the log), and the control
 * plane audits BEFORE it applies. Both are right, and together they mean that
 * whoever can append the LAST record decides whether the next kill-switch
 * engage can happen. At `WP-240` a READ-only operator could append (M-3);
 * `api.ts` now makes that impossible (an actor with no mutation grant appends
 * nothing). That closes the finding as stated — but it leaves the same shape
 * one credential up: an operator holding `STRATEGY_CONTROL` and not
 * `KILL_SWITCH` could still fill the log with refusals and resumes, and disable
 * a control it has no authority over.
 *
 * ## The design: three tiers over one capacity
 *
 * With capacity `C` and a configured safety reserve `R` (`auditSafetyReserve`,
 * required, `1 ≤ R` and `2R < C`):
 *
 * | Record | May fill the log up to |
 * | --- | --- |
 * | `KILL_SWITCH_ENGAGE` / `APPLIED` | `C` |
 * | `STRATEGY_PAUSE` / `APPLIED` | `C − R` |
 * | everything else — every `REFUSED` record, every resume, every release | `C − 2R` |
 *
 * So:
 *
 * - **Nothing but an applied kill-switch engage can use the last `R` records.**
 *   Only an operator holding `KILL_SWITCH` can produce one, and each one is a
 *   switch that really engaged.
 * - **Nothing but an applied safety-direction action can use the `R` before
 *   those.** A pause applies only to a registered `RUNNING` instance, and
 *   pausing it again is a refusal (ordinary tier), so once the ordinary tier is
 *   full a `STRATEGY_CONTROL` holder can consume at most one reserved record per
 *   registered instance — and each one is a halt that took effect.
 * - **The direction a full ordinary tier fails in is SAFE.** Resumes and
 *   releases are ordinary: once it is full they are refused `503`, so the
 *   platform can still be halted and cannot be un-halted until the log is
 *   rotated. That is the fail-closed direction §14.1 wants from a kill switch.
 * - **Nothing here weakens "audit first, then apply".** A record the budget
 *   refuses is a refusal of the APPEND (`AUDIT_CAPACITY_EXHAUSTED`), and the
 *   control plane turns it into `503 CONTROL_NOT_AUDITABLE` with the state
 *   unmoved. A refusal whose record the budget refuses is still refused — it
 *   is counted `NOT_AUDITED` — and nothing changed, so nothing happened
 *   unaudited.
 *
 * The tier is read from the RECORD (`action`, `outcome`), which the control
 * plane builds from the method it is executing; a request body cannot choose
 * it. `#admitted` counts appends the inner sink ACCEPTED; an append in flight
 * holds its slot from before the inner call until it settles, so concurrent
 * appends cannot overshoot a tier, and an inner refusal or throw releases it.
 *
 * ## Why a decorator, here
 *
 * `packages/observability` owns the log and is outside this round's grant; the
 * budget is a property of THIS process's composition, so it wraps the port
 * (`ControlAuditSink`) rather than changing the log. `main.ts` and the test
 * harness build the same composition through {@link createBudgetedAuditLog}.
 */

import {
  InMemoryControlAuditLog,
  type AuditAppendResult,
  type ControlAuditRecord,
  type ControlAuditSink,
} from "@polymarket-bot/observability";

/** The three tiers, from the most protected to the least. */
export const AUDIT_BUDGET_TIERS = ["KILL_SWITCH_ENGAGE", "SAFETY_DIRECTION", "ORDINARY"] as const;
export type AuditBudgetTier = (typeof AUDIT_BUDGET_TIERS)[number];

/**
 * The tier a record is admitted under. Read from the record the control plane
 * built, never from a request.
 */
export function auditBudgetTier(record: Pick<ControlAuditRecord, "action" | "outcome">): AuditBudgetTier {
  if (record.outcome !== "APPLIED") return "ORDINARY";
  if (record.action === "KILL_SWITCH_ENGAGE") return "KILL_SWITCH_ENGAGE";
  if (record.action === "STRATEGY_PAUSE") return "SAFETY_DIRECTION";
  return "ORDINARY";
}

export interface AuditBudgetOptions {
  /** The total number of records the wrapped sink may be asked to hold. */
  readonly capacity: number;
  /**
   * `R`: records only an applied kill-switch engage may use, and `R` more only
   * an applied safety-direction action may use. `0` is accepted HERE — it is
   * the single-bound behaviour of `WP-240`, which unit suites still measure —
   * and REFUSED by the configuration door (`config.ts`), so a deployment
   * cannot run without the reserve.
   */
  readonly safetyReserve: number;
}

/** Why a budget is unusable, or `undefined`. Shared with the config door. */
export function auditBudgetProblem(options: AuditBudgetOptions): string | undefined {
  const { capacity, safetyReserve } = options;
  if (!Number.isSafeInteger(capacity) || capacity <= 0) {
    return `the audit capacity must be a positive safe integer; received ${String(capacity)}`;
  }
  if (!Number.isSafeInteger(safetyReserve) || safetyReserve < 0) {
    return `the audit safety reserve must be a non-negative safe integer; received ${String(safetyReserve)}`;
  }
  if (2 * safetyReserve >= capacity) {
    return (
      `the audit safety reserve ${String(safetyReserve)} leaves no ordinary tier in a capacity of ` +
      `${String(capacity)}: twice the reserve must be below the capacity`
    );
  }
  return undefined;
}

/**
 * A {@link ControlAuditSink} decorator that admits each record against its
 * tier's limit (module header).
 */
export class SafetyReservedAuditSink implements ControlAuditSink {
  readonly #inner: ControlAuditSink;
  readonly #capacity: number;
  readonly #safetyReserve: number;
  #admitted = 0;
  #inFlight = 0;

  constructor(inner: ControlAuditSink, options: AuditBudgetOptions) {
    const problem = auditBudgetProblem(options);
    if (problem !== undefined) throw new RangeError(problem);
    this.#inner = inner;
    this.#capacity = options.capacity;
    this.#safetyReserve = options.safetyReserve;
  }

  get capacity(): number {
    return this.#capacity;
  }

  get safetyReserve(): number {
    return this.#safetyReserve;
  }

  /** Appends the wrapped sink accepted through this budget. */
  get admitted(): number {
    return this.#admitted;
  }

  /** The highest record count a record of `tier` may bring the log to. */
  limitFor(tier: AuditBudgetTier): number {
    switch (tier) {
      case "KILL_SWITCH_ENGAGE":
        return this.#capacity;
      case "SAFETY_DIRECTION":
        return this.#capacity - this.#safetyReserve;
      case "ORDINARY":
        return this.#capacity - 2 * this.#safetyReserve;
    }
  }

  async append(record: ControlAuditRecord): Promise<AuditAppendResult> {
    const tier = auditBudgetTier(record);
    const limit = this.limitFor(tier);
    // Check AND take the slot in one synchronous step: nothing can interleave
    // between them, so two concurrent appends cannot both take the last slot.
    if (this.#admitted + this.#inFlight >= limit) {
      return {
        ok: false,
        code: "AUDIT_CAPACITY_EXHAUSTED",
        detail:
          `the audit log's ${tier} tier is full (${String(this.#admitted)} of ${String(this.#capacity)} ` +
          `records; this tier may fill it to ${String(limit)}). The last ${String(this.#safetyReserve)} ` +
          "records are reserved for kill-switch engages and the " +
          `${String(this.#safetyReserve)} before them for safety-direction actions, so that nothing ` +
          "but a halt can use the capacity a halt needs (README, 'The audit budget')",
      };
    }
    this.#inFlight += 1;
    let result: AuditAppendResult;
    try {
      result = await this.#inner.append(record);
    } catch (cause) {
      // The port is TOTAL by contract; a sink that throws anyway is reported as
      // unavailable, and the slot is released, rather than leaking either.
      result = {
        ok: false,
        code: "AUDIT_SINK_UNAVAILABLE",
        detail: `the audit sink threw: ${cause instanceof Error ? cause.message : String(cause)}`,
      };
    } finally {
      this.#inFlight -= 1;
    }
    if (result.ok) this.#admitted += 1;
    return result;
  }
}

/**
 * The composition `main.ts` and the test harness both build: an in-memory,
 * append-only log of `capacity` records behind a {@link SafetyReservedAuditSink}
 * of the same capacity. `log` is what the read and metrics surfaces count;
 * `sink` is what the control plane writes through.
 */
export function createBudgetedAuditLog(options: AuditBudgetOptions): {
  readonly log: InMemoryControlAuditLog;
  readonly sink: SafetyReservedAuditSink;
} {
  const problem = auditBudgetProblem(options);
  if (problem !== undefined) throw new RangeError(problem);
  const log = new InMemoryControlAuditLog(options.capacity);
  return { log, sink: new SafetyReservedAuditSink(log, options) };
}
