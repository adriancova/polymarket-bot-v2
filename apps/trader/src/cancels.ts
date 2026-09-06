/**
 * Cancel reconciliation — `WP-220` composition-root obligation 10.
 *
 * > "10. **Cancel reconciliation is the OMS/composition root's job.** An
 * > unconfirmed cancel has no in-package timeout: if the venue acknowledges but
 * > never confirms, the instance waits in `SB.AWAITING_CANCEL_CONFIRMATION`
 * > with the stop, holding timeout and close cutoff **deferred**… **The root
 * > must resolve every cancel to a terminal fact — confirmed, rejected, or
 * > `SILENCE_EXCEEDED` via `submission_unknown_after_ms`** — the §6 invariant 6
 * > family, same as the awaiting-fill posture."
 *   — `packages/strategies/static-bracket/README.md`
 *
 * The obligation is sharp and so is this module: every cancel this process
 * requests is REGISTERED here, and every registered cancel reaches exactly one
 * of three terminal facts. There is no fourth outcome and no path that forgets
 * one.
 *
 * ## Why `SILENCE_EXCEEDED` is not a rejection
 *
 * §6 invariant 6: "**Unknown submission state is never treated as rejection.**
 * Reconcile using the persisted signed order/order hash before any retry with a
 * new salt." A cancel that timed out is UNKNOWN, not refused: the venue may
 * have processed it. So `SILENCE_EXCEEDED` is its own terminal fact, it carries
 * the §9.9 recommendation `RECONCILE_ACCOUNT`, and the trader latches a
 * `CANCEL_UNRESOLVED` halt for the affected market rather than assuming the
 * order still works. §6 invariant 12 says the same thing from the other side:
 * "No blind flatten. Unknown position or book state causes cancel and
 * reconciliation before any protected reduction action."
 *
 * ## Why the deadline is measured in RECORDED time
 *
 * `submission_unknown_after_ms` is the strategy's configured bound and the loop
 * evaluates it against the instant of the event being processed, not a wall
 * clock. Under replay that makes the timeout fire at exactly the same recorded
 * event every time (§12.4), and in a live PAPER run the clock port supplies the
 * arrival instant — the same code, the same rule.
 *
 * ## Deterministic sweep order
 *
 * `sweep` walks pending cancels in registration order, so two runs over the
 * same events resolve the same cancels in the same sequence. A `Map`'s
 * insertion order is that registration order.
 */

/** The three terminal facts a cancel may reach. There is no fourth. */
export type CancelResolution = "CONFIRMED" | "REJECTED" | "SILENCE_EXCEEDED";

export interface PendingCancel {
  readonly cancelId: string;
  readonly executionPlanId: string;
  readonly instanceId: string;
  readonly marketId: string;
  readonly orderIds: readonly string[];
  /** Strict-UTC instant the cancel was requested at, from the loop's clock. */
  readonly requestedAt: string;
  readonly requestedAtEpochMs: number;
  /** The strategy's `entry.execution.submission_unknown_after_ms`. */
  readonly silenceBoundMs: number;
}

export interface ResolvedCancel {
  readonly cancel: PendingCancel;
  readonly resolution: CancelResolution;
  readonly detail: string;
  readonly resolvedAt: string;
  /**
   * The §9.9 rung this resolution recommends.
   *
   * A confirmation recommends nothing. A rejection means the order is still
   * live and the safety action did not happen, so resting orders must be
   * cancelled again from a reconciled view. Silence means the state is UNKNOWN,
   * which is §9.9's "Account state unknown → reconcile" row.
   */
  readonly recommendation: "NONE" | "CANCEL_RESTING_ORDERS" | "RECONCILE_ACCOUNT";
}

export interface CancelLedgerMetrics {
  readonly pending: number;
  readonly requested: number;
  readonly confirmed: number;
  readonly rejected: number;
  readonly silenceExceeded: number;
}

const RECOMMENDATION_FOR: Readonly<
  Record<CancelResolution, ResolvedCancel["recommendation"]>
> = Object.freeze({
  CONFIRMED: "NONE",
  REJECTED: "CANCEL_RESTING_ORDERS",
  SILENCE_EXCEEDED: "RECONCILE_ACCOUNT",
});

/**
 * Every cancel this process requested, until each reaches a terminal fact.
 *
 * Clock-free: instants and the current time both arrive as arguments.
 */
export class CancelLedger {
  readonly #pending = new Map<string, PendingCancel>();
  #requested = 0;
  #confirmed = 0;
  #rejected = 0;
  #silenceExceeded = 0;

  /** Registers a requested cancel. A repeat of the same id is not re-registered. */
  register(cancel: PendingCancel): void {
    if (this.#pending.has(cancel.cancelId)) return;
    this.#pending.set(cancel.cancelId, cancel);
    this.#requested += 1;
  }

  /** True while this cancel has not reached a terminal fact. */
  isPending(cancelId: string): boolean {
    return this.#pending.has(cancelId);
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  /**
   * Resolves one cancel to a terminal fact.
   *
   * Answers `undefined` when the id is not pending — a resolution for a cancel
   * this process never requested, or a second resolution for one already
   * resolved. Both are reported rather than absorbed, because a venue answering
   * about a cancel we do not know about is itself a reconciliation signal.
   */
  resolve(
    cancelId: string,
    resolution: CancelResolution,
    detail: string,
    at: string,
  ): ResolvedCancel | undefined {
    const cancel = this.#pending.get(cancelId);
    if (cancel === undefined) return undefined;
    this.#pending.delete(cancelId);
    switch (resolution) {
      case "CONFIRMED":
        this.#confirmed += 1;
        break;
      case "REJECTED":
        this.#rejected += 1;
        break;
      case "SILENCE_EXCEEDED":
        this.#silenceExceeded += 1;
        break;
    }
    return Object.freeze({
      cancel,
      resolution,
      detail,
      resolvedAt: at,
      recommendation: RECOMMENDATION_FOR[resolution],
    });
  }

  /**
   * Closes every cancel whose silence bound has elapsed at `nowEpochMs`.
   *
   * Called once per processed event by the core loop, so the bound is evaluated
   * against recorded time and a run that never advances never times a cancel
   * out — which is correct: a bound measured against a clock nobody read is a
   * bound that fires on wall-clock drift.
   *
   * §6 invariant 6 is why the fact is `SILENCE_EXCEEDED` and not `REJECTED`:
   * the venue may have processed the cancel, so the process reconciles rather
   * than assuming either answer.
   */
  sweep(nowEpochMs: number, at: string): readonly ResolvedCancel[] {
    const expired: ResolvedCancel[] = [];
    for (const cancel of [...this.#pending.values()]) {
      if (nowEpochMs - cancel.requestedAtEpochMs < cancel.silenceBoundMs) continue;
      const resolved = this.resolve(
        cancel.cancelId,
        "SILENCE_EXCEEDED",
        `cancel ${cancel.cancelId} for plan ${cancel.executionPlanId} was neither confirmed ` +
          `nor rejected within ${String(cancel.silenceBoundMs)}ms of ${cancel.requestedAt}; ` +
          "§6 invariant 6 forbids reading the silence as a rejection, so the state is UNKNOWN " +
          "and the affected market reconciles (WP-220 obligation 10)",
        at,
      );
      if (resolved !== undefined) expired.push(resolved);
    }
    return Object.freeze(expired);
  }

  /** Every still-unresolved cancel, in registration order. */
  pending(): readonly PendingCancel[] {
    return Object.freeze([...this.#pending.values()]);
  }

  metrics(): CancelLedgerMetrics {
    return Object.freeze({
      pending: this.#pending.size,
      requested: this.#requested,
      confirmed: this.#confirmed,
      rejected: this.#rejected,
      silenceExceeded: this.#silenceExceeded,
    });
  }
}
