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
 * The slice of WP-290's `ReconciliationCoordinator` the lapse recovery uses
 * (ADR-033 D6 step 3–4): `trigger` holds the account and queues a run but
 * starts none; `reconcile` runs nothing (`NOT_RUN`) while a run is in
 * progress, which `status().running` reports. The coordinator owns no timer.
 */
export interface SafetyCoordinator {
  trigger(trigger: "POSITION_BALANCE_DISCREPANCY"): void;
  reconcile(): Promise<{ readonly runs: readonly SafetyRunReport[]; readonly resumed: boolean }>;
  status(): { readonly running: boolean };
}

/** The order-heartbeat controller, as the composition reads it (`OrderHeartbeatController`). */
export interface HeartbeatView {
  isLapsed(): boolean;
}

/** Where the composition records what it did (lapses, stops, conflicts). Append-only; a failure is reported, never thrown. */
export interface LiveSafetyJournal {
  record(entry: LiveSafetyRecord): void;
}

/** §14.4's pages this composition raises. */
export type LiveSafetyPage =
  | "HEARTBEAT_HEALTH_LEASE_FAILED_WHILE_ORDERS_MAY_EXIST"
  | "LIVE_FENCING_CONFLICT"
  | "KILL_SWITCH_STATE_UNREADABLE";

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
  | { readonly kind: "KILL_SWITCH_CANCEL_REQUESTED"; readonly directive: string; readonly accepted: boolean; readonly atMs: number }
  | { readonly kind: "FENCE_ACQUIRED"; readonly fencingToken: string; readonly atMs: number }
  | { readonly kind: "FENCE_LOST"; readonly reason: string; readonly atMs: number };
