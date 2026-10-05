/**
 * A lapsed heartbeat, the composition's half (WP-320; ADR-033 D6, "When a
 * lapse starts" and "When a lapse ends", steps 1–5, as written).
 *
 * The controller (`@polymarket-bot/polymarket-secure`'s order-heartbeat
 * controller) reports `LAPSE_STARTED` and `LAPSE_ENDED`. This class turns
 * them into the OMS and coordinator calls D6 names, and holds the ENTRY BLOCK
 * that `entry-gate.ts` reads. Both clocks are the SAME monotonic clock: the
 * composition passes one clock to the controller and to this class.
 *
 * ## When a lapse starts (D6)
 *
 * 1. Record the lapse, with its cause and start, and with the heartbeat
 *    gate's refusal reasons at that moment. A lapse while the health lease
 *    fails (or an explicit stop, which acts through it, is in force) and
 *    orders may exist pages "Heartbeat health lease failed while orders may
 *    exist" (§14.4). Orders may exist unless the OMS is readable, not
 *    faulted, and every order it tracks is terminal.
 * 2. Send every open order with a venue order id to `RECONCILING` through
 *    `OrderManager.requestOrderReconciliation` (reason `MANUAL_REQUEST`, so the
 *    lapse record is what names the cause). WP-290's coordinator raises each
 *    request as `POSITION_BALANCE_DISCREPANCY` and pauses new submissions at
 *    once (§9.17 step 1); `resume()` refuses while any is `RECONCILING`.
 * 3. LATCH the block on new live entries. The block starts latched: the
 *    controller starts lapsed (cause `STARTUP`).
 *
 * Every lapse start advances the RECOVERY EPOCH, which voids any recovery in
 * progress (step 5).
 *
 * ## When a lapse ends (D6)
 *
 * 1. Record the end.
 * 2. Re-request each open order with a venue order id that is not already
 *    `RECONCILING` (the OMS refuses one that is: its request from the lapse
 *    stays outstanding).
 * 3. Raise `POSITION_BALANCE_DISCREPANCY` through
 *    `ReconciliationCoordinator.trigger` at the confirmation, and again
 *    {@link VENUE_CANCELLATION_CHECK_INTERVAL_MS} (5 s) after it.
 * 4. Keep the block latched until a QUALIFYING run completes, passes and
 *    resumes the OMS (§9.17 step 8: a `RunReport` with status `PASSED` and
 *    `resumed: true`). From 5 s after the confirmation this class calls
 *    `reconcile()` itself (the coordinator owns no timer), and keeps calling:
 *    - **Qualifying (ADR-033 r4 LOW R4-W1, "started" used for two times).**
 *      A run qualifies when the `reconcile()` CALL that ran it was made at
 *      least 5 s after the confirmation, by the monotonic clock read just
 *      before the call. Every run of such a call starts after the call, so
 *      this is the conservative of D6's two readings: no run that started
 *      earlier can count, even when its report arrives later. Only this
 *      class's own calls are judged; a pass reported by any other caller's
 *      call never ends the calls.
 *    - **After a `NOT_RUN` (R4-L1).** A call made while another is in
 *      progress runs nothing. So this class does not call while the
 *      coordinator's `status().running` says a call is in progress: it polls
 *      it every `notRunPollMs` until that call has ended, and then calls AT
 *      ONCE, whether or not a trigger is pending. A call that still returns
 *      `NOT_RUN` (another caller claimed the run in between) is treated the
 *      same way. There is no other spacing after a `NOT_RUN`.
 *    - **After a qualifying run that does not pass and resume**, the next
 *      call waits `failedRunSpacingMs` (D6: "the composition may space its
 *      calls").
 * 5. Lift the block only if the heartbeat has not lapsed again by then: the
 *    epoch is unchanged AND the controller reports itself not lapsed at the
 *    moment of lifting. A new lapse voids the recovery, and its own end
 *    starts another.
 *
 * No new §9.17 trigger is used, and "submission unknown" is not (D6).
 *
 * ## D6's coordinator, re-cited on `main` (ADR033-REVIEW follow_up 2; `WP-290` merged at `7a53988`)
 *
 * By symbol, in `packages/oms/src/reconciliation/coordinator.ts`:
 * `ReconciliationCoordinator.trigger` (holds — `#hold`, which calls
 * `OrderManager.pause` — and queues one pending entry per kind; starts no run),
 * `ReconciliationCoordinator.reconcile` (claims the run synchronously, and
 * returns `NOT_RUN` "a run is already in progress" while one is), `status()`
 * (`running`, `pendingTriggers`), `#runOnce` (reads its start time, then
 * `#retryCadence`, then `#takeTriggers`, then `#readAll`), `#workArrivedDuring`
 * (a pending trigger makes the run rerun instead of resuming) and the hold
 * epoch checked in `#finish` before `resume()`; the `omsRequester` that raises
 * an OMS `ORDER_STATE` request as `POSITION_BALANCE_DISCREPANCY`. In
 * `packages/oms/src/order-manager.ts`: `OrderManager.requestOrderReconciliation`
 * (open states ACKNOWLEDGED, LIVE, DELAYED, PARTIALLY_FILLED, CANCEL_PENDING;
 * reason code `MANUAL_REQUEST`; `OMS_ILLEGAL_TRANSITION` otherwise) and `resume`
 * (`#resumeBlocker`: refused while any order is `RECONCILING`). The D6 tests run
 * against both, unmocked (`test/fault-injection/live-safety/heartbeat-lapse-recovery.test.ts`).
 */

import type { LiveSafetyAlerts, LiveSafetyJournal, MonotonicClock, SafetyCoordinator, SafetyOms, SafetyOrderView, SafetyTimers, HeartbeatView } from "./ports.js";

/**
 * S-D17: "The cancellation check runs every five seconds, so cancellation may
 * occur up to five seconds after the timeout" (`docs/venue/verified-2026-09-16.md`
 * §5; documentary only). Mirrors `@polymarket-bot/polymarket-secure`'s
 * `VENUE_CANCELLATION_CHECK_INTERVAL_MS`, which `apps/trader` cannot import;
 * `test/fault-injection/live-safety/port-conformance.test.ts` pins the two equal.
 */
export const VENUE_CANCELLATION_CHECK_INTERVAL_MS = 5_000;

/** The OMS states `requestOrderReconciliation` reconciles (WP-270: an open order with a known venue order id). */
const RECONCILABLE_STATES: readonly string[] = ["ACKNOWLEDGED", "LIVE", "DELAYED", "PARTIALLY_FILLED", "CANCEL_PENDING"];
/** WP-270's terminal order states: an order in one of them cannot rest at the venue. */
const TERMINAL_STATES: readonly string[] = ["FILLED", "CANCELED", "REJECTED", "EXPIRED"];

export class LapseRecoveryConfigurationError extends Error {
  override readonly name = "LapseRecoveryConfigurationError";
  constructor(readonly field: string) {
    super(`lapse recovery configuration refused: ${field}`);
    Object.freeze(this);
  }
}

export interface LapseRecoveryOptions {
  readonly oms: SafetyOms;
  readonly coordinator: SafetyCoordinator;
  readonly clock: MonotonicClock;
  readonly timers: SafetyTimers;
  readonly journal: LiveSafetyJournal;
  readonly alerts: LiveSafetyAlerts;
  /** The controller, once attached; `null` until then (the block stays latched). */
  readonly heartbeat: () => HeartbeatView | null;
  /** How often to look whether another `reconcile()` call has ended, after a `NOT_RUN` (R4-L1). */
  readonly notRunPollMs: number;
  /** The wait after a qualifying run that does not pass and resume. */
  readonly failedRunSpacingMs: number;
  /** Every report this class's own calls receive (the composition proves the RECONCILER health input from them). */
  readonly onReport?: (report: { readonly runs: readonly { readonly status: string; readonly resumed: boolean }[] }) => void;
  /**
   * The heartbeat gate's refusal reasons AT THIS MOMENT (empty when it permits). A lapse is recorded with them as
   * well as with the controller's cause: the deadline can fall before the next tick asks the gate, and a failed
   * health lease or an explicit stop in force at the lapse is what pages.
   */
  readonly gateReasonsNow?: () => readonly string[];
}

export interface LapseEventStart {
  readonly cause: string;
  readonly gateReasons: readonly string[];
  readonly atMs: number;
}

export class LapseRecovery {
  readonly #options: LapseRecoveryOptions;
  #epoch = 0;
  /** The epoch whose lapse end has been handled: a second end for one epoch starts nothing. */
  #endedEpoch = -1;
  #latched = true;
  #closed = false;
  readonly #handles = new Set<unknown>();

  constructor(options: LapseRecoveryOptions) {
    const bounded = (value: unknown): boolean => typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 60_000;
    if (!bounded(options.notRunPollMs)) throw new LapseRecoveryConfigurationError("notRunPollMs");
    if (!bounded(options.failedRunSpacingMs)) throw new LapseRecoveryConfigurationError("failedRunSpacingMs");
    this.#options = options;
  }

  /** The D6 entry block: latched from construction (the controller starts lapsed) and by every lapse. */
  blocksNewEntries(): boolean {
    return this.#latched;
  }

  epoch(): number {
    return this.#epoch;
  }

  /** D6 "When a lapse starts", steps 1–3. */
  onLapseStarted(event: LapseEventStart): void {
    if (this.#closed) return;
    this.#epoch += 1;
    const epoch = this.#epoch;
    // Step 3 first: the block is latched before anything is awaited.
    this.#latched = true;
    this.#clearTimers();
    // Step 1.
    const reasons = [...event.gateReasons];
    for (const reason of this.#gateReasonsNow()) if (!reasons.includes(reason)) reasons.push(reason);
    this.#record({ kind: "LAPSE_STARTED", cause: event.cause, gateReasons: Object.freeze(reasons), atMs: event.atMs, epoch });
    const healthFailed = reasons.some((reason) => reason.startsWith("HEALTH_") || reason.startsWith("STOPPED_"));
    if (healthFailed && this.#ordersMayExist()) {
      this.#page("HEARTBEAT_HEALTH_LEASE_FAILED_WHILE_ORDERS_MAY_EXIST", `heartbeat lapsed (${reasons.join(", ")}) while orders may exist`);
    }
    // Step 2.
    void this.#requestOpenOrders(epoch, false);
  }

  /** D6 "When a lapse ends", steps 1–5. `confirmedAtMs` is the controller's confirmation instant (the same monotonic clock). */
  onLapseEnded(event: { readonly confirmedAtMs: number }): void {
    if (this.#closed || this.#endedEpoch === this.#epoch) return;
    const epoch = this.#epoch;
    this.#endedEpoch = epoch;
    const confirmedAtMs = event.confirmedAtMs;
    // Step 1.
    this.#record({ kind: "LAPSE_ENDED", confirmedAtMs, epoch });
    // Step 2: re-request each open order not already RECONCILING.
    void this.#requestOpenOrders(epoch, true);
    // Step 3, at the confirmation.
    this.#trigger(epoch);
    // Steps 3 (again) and 4, from 5 s after the confirmation.
    const qualifyFromMs = confirmedAtMs + VENUE_CANCELLATION_CHECK_INTERVAL_MS;
    const now = this.#now();
    const delay = now === null ? VENUE_CANCELLATION_CHECK_INTERVAL_MS : Math.max(0, qualifyFromMs - now);
    this.#after(delay, () => {
      if (this.#epoch !== epoch || this.#closed) return;
      this.#trigger(epoch);
      void this.#reconcileUntilQualifyingPass(epoch, qualifyFromMs);
    });
  }

  close(): void {
    this.#closed = true;
    this.#clearTimers();
  }

  // -------------------------------------------------------------------------

  async #reconcileUntilQualifyingPass(epoch: number, qualifyFromMs: number): Promise<void> {
    const { coordinator } = this.#options;
    while (this.#epoch === epoch && this.#latched && !this.#closed) {
      // R4-L1: a call while another is in progress runs nothing; wait for it to end, then call at once.
      if (this.#running()) {
        await this.#sleep(this.#options.notRunPollMs);
        continue;
      }
      const calledAtMs = this.#now();
      if (calledAtMs === null) {
        await this.#sleep(this.#options.failedRunSpacingMs);
        continue;
      }
      if (calledAtMs < qualifyFromMs) {
        // A timer that fired early: wait out the rest of the 5 s.
        await this.#sleep(qualifyFromMs - calledAtMs);
        continue;
      }
      let report: { readonly runs: readonly { readonly status: string; readonly resumed: boolean }[]; readonly resumed: boolean } | null;
      try {
        report = await coordinator.reconcile();
      } catch {
        report = null;
      }
      const runs = report === null ? [] : [...report.runs];
      if (report !== null) {
        try {
          this.#options.onReport?.(report);
        } catch {
          // The listener's failure is not the recovery's.
        }
      }
      const passed = runs.some((run) => run.status === "PASSED" && run.resumed);
      const notRun = runs.length > 0 && runs.every((run) => run.status === "NOT_RUN");
      this.#record({
        kind: "LAPSE_RECONCILE_CALLED",
        atMs: calledAtMs,
        qualifying: true,
        outcome: report === null ? "THREW" : passed ? "PASSED_AND_RESUMED" : notRun ? "NOT_RUN" : "NOT_PASSED",
        epoch,
      });
      // A new lapse while the call ran voids this recovery (step 5).
      if (this.#epoch !== epoch || this.#closed) return;
      if (passed) {
        this.#lift(epoch);
        return;
      }
      if (notRun && this.#running()) continue;
      await this.#sleep(this.#options.failedRunSpacingMs);
    }
  }

  /** Step 5: lift only if no new lapse began, and the controller is not lapsed at this moment. */
  #lift(epoch: number): void {
    if (this.#epoch !== epoch || this.#closed) return;
    const heartbeat = this.#options.heartbeat();
    let lapsed = true;
    try {
      lapsed = heartbeat === null ? true : heartbeat.isLapsed() !== false;
    } catch {
      lapsed = true;
    }
    // `isLapsed()` reports a due lapse synchronously (the controller emits LAPSE_STARTED), which advances the epoch.
    if (lapsed || this.#epoch !== epoch) return;
    this.#latched = false;
    this.#record({ kind: "ENTRY_BLOCK_LIFTED", atMs: this.#now() ?? 0, epoch });
  }

  #trigger(epoch: number): void {
    try {
      this.#options.coordinator.trigger("POSITION_BALANCE_DISCREPANCY");
    } catch {
      // A coordinator that throws holds nothing: the block stays latched, and the reconcile calls find it.
    }
    this.#record({ kind: "LAPSE_TRIGGER_RAISED", atMs: this.#now() ?? 0, epoch });
  }

  async #requestOpenOrders(epoch: number, skipReconciling: boolean): Promise<void> {
    let orders: readonly SafetyOrderView[];
    try {
      orders = this.#options.oms.orders();
    } catch {
      return;
    }
    for (const order of orders) {
      if (order.venueOrderId === null) continue;
      if (skipReconciling && order.state === "RECONCILING") continue;
      if (!RECONCILABLE_STATES.includes(order.state)) continue;
      let accepted = false;
      try {
        accepted = (await this.#options.oms.requestOrderReconciliation(order.orderId)).ok === true;
      } catch {
        accepted = false;
      }
      this.#record({ kind: "LAPSE_RECONCILIATION_REQUESTED", orderId: order.orderId, accepted, epoch });
    }
  }

  #gateReasonsNow(): readonly string[] {
    try {
      return this.#options.gateReasonsNow?.() ?? [];
    } catch {
      return ["GATE_UNREADABLE"];
    }
  }

  #ordersMayExist(): boolean {
    try {
      if (this.#options.oms.faulted) return true;
      return this.#options.oms.orders().some((order) => !TERMINAL_STATES.includes(order.state));
    } catch {
      return true;
    }
  }

  #running(): boolean {
    try {
      return this.#options.coordinator.status().running !== false;
    } catch {
      return true;
    }
  }

  #now(): number | null {
    try {
      const value = this.#options.clock.monotonicMs();
      return Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  }

  #after(delayMs: number, callback: () => void): void {
    const handle = this.#options.timers.setTimeout(() => {
      this.#handles.delete(handle);
      callback();
    }, delayMs);
    this.#handles.add(handle);
  }

  #sleep(delayMs: number): Promise<void> {
    return new Promise((resolve) => {
      this.#after(delayMs, resolve);
    });
  }

  #clearTimers(): void {
    for (const handle of this.#handles) {
      try {
        this.#options.timers.clearTimeout(handle);
      } catch {
        // Ignored: a timer that fires into a voided epoch does nothing.
      }
    }
    this.#handles.clear();
  }

  #record(entry: Parameters<LiveSafetyJournal["record"]>[0]): void {
    try {
      this.#options.journal.record(entry);
    } catch {
      // The journal's failure is reported by the journal; the block's state does not depend on it.
    }
  }

  #page(page: Parameters<LiveSafetyAlerts["page"]>[0], detail: string): void {
    try {
      this.#options.alerts.page(page, detail);
    } catch {
      // A pager that throws loses the page; nothing here depends on it.
    }
  }
}
