/**
 * The ports the live-safety composition reaches the rest of the process
 * through (WP-320). Each is STRUCTURAL: `apps/trader` declares no dependency
 * on `@polymarket-bot/oms` or `@polymarket-bot/polymarket-secure` (adding one
 * is outside this package's grant), so the slices it uses are mirrored here,
 * and `test/fault-injection/live-safety/**` proves at compile time that the
 * real `OrderManager`, `ReconciliationCoordinator` and order-heartbeat
 * controller satisfy them (`port-conformance.test.ts`).
 *
 * Nothing here performs I/O, reads a clock or holds a credential.
 */

/** The process's monotonic clock, in milliseconds. Every age in this directory is measured on it. */
export interface MonotonicClock {
  monotonicMs(): number;
}

export interface SafetyTimers {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** One OMS order, as WP-270's `OrderView` carries it (the fields used here). */
export interface SafetyOrderView {
  readonly orderId: string;
  readonly state: string;
  readonly venueOrderId: string | null;
  readonly marketId: string;
}

/**
 * The slice of WP-270's `OrderManager` the lapse recovery uses (ADR-033 D6):
 * its orders, and `requestOrderReconciliation`, which sends an open order with
 * a venue order id to `RECONCILING` with reason `MANUAL_REQUEST` and refuses
 * one already `RECONCILING` (`OMS_ILLEGAL_TRANSITION`).
 */
export interface SafetyOms {
  readonly faulted: boolean;
  orders(): readonly SafetyOrderView[];
  requestOrderReconciliation(orderId: string): Promise<{ readonly ok: boolean }>;
}

/** One run of WP-290's coordinator, as its `RunReport` carries it (the fields used here). */
export interface SafetyRunReport {
  readonly status: string;
  readonly resumed: boolean;
}

/**
 * The slice of WP-290's `ReconciliationCoordinator` the composition uses.
 * The lapse recovery (ADR-033 D6 step 3–4): `trigger` holds the account and
 * queues a run but starts none; `reconcile` runs nothing (`NOT_RUN`) while a
 * run is in progress, which `status().running` reports. The coordinator owns
 * no timer. The live gate (C1-OMS06): `quarantinedBreaks`.
 */
export interface SafetyCoordinator {
  trigger(trigger: "POSITION_BALANCE_DISCREPANCY"): void;
  reconcile(): Promise<{ readonly runs: readonly SafetyRunReport[]; readonly resumed: boolean }>;
  status(): { readonly running: boolean };
  /**
   * The journal's QUARANTINED breaks, read at every call: the gate's reconciliation halts are derived from them (a
   * MARKET-scope break with a market halts that market, any other the account). It THROWS when the journal cannot be
   * read, never answering an empty list in its place: the gate then refuses new entries (`HALTS_UNREADABLE`).
   */
  quarantinedBreaks(): readonly { readonly scope: string; readonly marketId: string | null }[];
}

/** The order-heartbeat controller, as the composition reads it (`OrderHeartbeatController`). */
export interface HeartbeatView {
  isLapsed(): boolean;
}

/** Where the composition records what it did (lapses, stops, conflicts). Append-only; a failure is reported, never thrown. */
export interface LiveSafetyJournal {
  record(entry: LiveSafetyRecord): void;
}

/**
 * The pages this composition raises: §14.4's "Heartbeat health lease failed while orders may exist" and "Live fencing
 * conflict", and four of this package's own for kill-switch enforcement (§14.4 lists no kill-switch page): the rows
 * could not be read (r1 I10); a kill switch's cancel went unanswered past its deadline (r3 J2); an order in a switch's
 * scope stayed `CANCEL_PENDING` past that deadline, so its cancel's answer never came beneath the OMS and its
 * reconciliation was requested (r4 CX320-R4-01); and an engaged switch's reference is not in its scope's canonical
 * form (r4 R4-L1).
 */
export type LiveSafetyPage =
  | "HEARTBEAT_HEALTH_LEASE_FAILED_WHILE_ORDERS_MAY_EXIST"
  | "LIVE_FENCING_CONFLICT"
  | "KILL_SWITCH_STATE_UNREADABLE"
  | "KILL_SWITCH_CANCEL_UNANSWERED"
  | "KILL_SWITCH_CANCEL_STRANDED"
  | "KILL_SWITCH_SCOPE_REF_NOT_CANONICAL";

export interface LiveSafetyAlerts {
  page(page: LiveSafetyPage, detail: string): void;
}

export type LiveSafetyRecord =
  | { readonly kind: "LAPSE_STARTED"; readonly cause: string; readonly gateReasons: readonly string[]; readonly atMs: number; readonly epoch: number }
  | { readonly kind: "LAPSE_ENDED"; readonly confirmedAtMs: number; readonly epoch: number }
  | { readonly kind: "LAPSE_RECONCILIATION_REQUESTED"; readonly orderId: string; readonly accepted: boolean; readonly epoch: number }
  | { readonly kind: "LAPSE_TRIGGER_RAISED"; readonly atMs: number; readonly epoch: number }
  | { readonly kind: "LAPSE_RECONCILE_CALLED"; readonly atMs: number; readonly qualifying: boolean; readonly outcome: string; readonly epoch: number }
  | { readonly kind: "ENTRY_BLOCK_LIFTED"; readonly atMs: number; readonly epoch: number }
  | { readonly kind: "HEARTBEAT_STOP_ENGAGED"; readonly source: string; readonly reason: string; readonly atMs: number }
  | { readonly kind: "HEARTBEAT_STOP_RELEASED"; readonly source: string; readonly operatorRef: string; readonly atMs: number }
  | {
      readonly kind: "KILL_SWITCH_CANCEL_REQUESTED";
      readonly directive: string;
      /** `live-safety.ts`, "Kill-switch cancels": the pass of the cancel obligation this request discharges (r2 X3). */
      readonly pass: "FIRST" | "CONFIRMING" | "AFTER_SETTLE" | "RETAINED";
      /** The attempt's number (r3 J2): one per request, increasing. */
      readonly attempt: number;
      /** Answered `true`, answered otherwise (or threw), or abandoned unanswered past its deadline (r3 J2). */
      readonly outcome: "ACCEPTED" | "REFUSED" | "ABANDONED";
      readonly accepted: boolean;
      /**
       * Whether the OMS still showed an order resting, or that may rest, in the directive's scope when the outcome was
       * recorded (r4 CX320-R4-01): an `ACCEPTED` with `true` is a request the port took, NOT a scope that is clear.
       */
      readonly scopeStillResting: boolean;
      readonly atMs: number;
    }
  | {
      /** An abandoned attempt answered after all (r3 J2): the answer discharged nothing. */
      readonly kind: "KILL_SWITCH_CANCEL_LATE_ANSWER_DISCARDED";
      readonly directive: string;
      readonly attempt: number;
      readonly pass: "FIRST" | "CONFIRMING" | "AFTER_SETTLE" | "RETAINED";
      readonly accepted: boolean;
      readonly atMs: number;
    }
  | {
      /**
       * r4 CX320-R4-01: an order the OMS showed `CANCEL_PENDING` for at least the cancel deadline, in the scope of an
       * engaged switch's cancel obligation, was sent to WP-270's `requestOrderReconciliation`, which clears a cancel
       * whose answer never came (its late answer is then recorded only) so the obligation can cancel it again.
       */
      readonly kind: "KILL_SWITCH_STRANDED_CANCEL_RECONCILIATION_REQUESTED";
      readonly directive: string;
      readonly orderId: string;
      /** The monotonic instant a kill-switch read first saw it `CANCEL_PENDING`, continuously since. */
      readonly cancelPendingSinceMs: number;
      readonly accepted: boolean;
      readonly atMs: number;
    }
  | { readonly kind: "FENCE_ACQUIRED"; readonly fencingToken: string; readonly atMs: number }
  | { readonly kind: "FENCE_LOST"; readonly reason: string; readonly atMs: number };
