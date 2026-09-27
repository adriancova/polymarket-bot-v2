/**
 * The halt controller — handoff §4.2 failure boundaries and §9.9's action
 * ladder, plus the `WP-200` composition-root obligation.
 *
 * §9.9 is explicit that the Incident Controller — "not the ordinary risk gate"
 * — originates operational safety actions, and `WP-200`'s round-2 follow-up 2
 * assigns the enforcement to whoever composes the process:
 *
 * > "A composition-root convention for reading `unexplainedMovements` alongside
 * > `unattributedActivity` when it loads history from the WP-040 tables. The
 * > projection states the obligation; **§9.9 says halting is the composition
 * > root's act**, and no composition root exists yet."
 *   — `docs/handoffs/WP-200.md`
 *
 * This module is that composition root's act. `haltOnLedgerProjection` reads
 * BOTH sections of a `packages/ledger` projection — `unattributedActivity`
 * (§6 invariant 7's arrivals, whose `haltRequired` is the unwaivable literal
 * `true`) and `unexplainedMovements` (the section `WP-200` round 2 added and
 * whose reader had nowhere to live) — and halts the affected market on either.
 *
 * ## What "halt" means here, precisely
 *
 * A halt is a LATCH, not a flag that policy can clear. Once a scope is halted:
 *
 * - the core loop makes **no trading decision** for it: no strategy is
 *   evaluated, no intent is risk-checked, no plan is built and nothing is
 *   submitted. A fill or an order view that arrives afterwards — including one
 *   whose OWN iteration latched the halt — is still BOOKED and is **not**
 *   delivered to the strategy (`loop.ts` §"No trading decision on stale or
 *   absent state" lists the four gates, and
 *   `health.loop.deliveriesSuppressedByHalt` counts what they withheld);
 * - the reason and the instant are retained and reported on the health surface;
 * - only an explicit operator act (a new run) clears it. `release` exists for
 *   the ACCOUNT-scope resync case that §7.1 defines — "a restart or detected
 *   gap requires a new authoritative snapshot before affected markets resume" —
 *   and it demands the same evidence the transport does, so a caller cannot
 *   un-stick a halt merely by wanting the events to flow again.
 *
 * ## §4.2 is the source of the failure classes
 *
 * > "A Redis outage stops publication and therefore halts trading… A PostgreSQL
 * > outage stops new trading decisions and order submission."
 *
 * Both are GLOBAL halts here, because both mean the process can no longer know
 * the state it would decide from: the first removes the event stream that keeps
 * books current, the second removes the durable record §6 invariant 3 requires
 * for every decision. Deciding on stale or absent state is precisely what §4.2
 * forbids, so the controller refuses to and says which boundary it hit.
 */

import type { LedgerProjection } from "@polymarket-bot/ledger";

/** §14.1's kill-switch scopes, as this controller latches them. */
export type HaltScope =
  | { readonly kind: "GLOBAL" }
  | { readonly kind: "MARKET"; readonly marketId: string }
  | { readonly kind: "STRATEGY_INSTANCE"; readonly instanceId: string };

/**
 * Why the process (or a market, or an instance) stopped making decisions.
 *
 * Every code names the boundary it came from, so an operator reading the health
 * surface can tell a §4.2 infrastructure boundary from a §6 invariant 7
 * accounting break from a §8.3 backpressure refusal without reading prose.
 */
export type HaltReasonCode =
  /** §4.2: the event transport (Redis) failed. No fresh market state exists. */
  | "TRANSPORT_UNAVAILABLE"
  /** §4.2 / ADR-003 §3.3: retention removed events this consumer never read. */
  | "TRANSPORT_RESYNC_REQUIRED"
  /** §4.2: the durable store (PostgreSQL) failed. §6 invariant 3 cannot be met. */
  | "STORE_UNAVAILABLE"
  /** §8.3: a bounded queue refused an event; dropping it is forbidden. */
  | "QUEUE_BACKPRESSURE"
  /** §6 invariant 7 / §9.15: actual activity arrived with no attribution. */
  | "UNATTRIBUTED_ACTIVITY"
  /** `WP-200` round 2: an actual movement no transaction explains. */
  | "UNEXPLAINED_ACTUAL_MOVEMENT"
  /** §9.15: the ledger refused a posting; the accounting record is incomplete. */
  | "LEDGER_POSTING_REFUSED"
  /** §6 invariant 6: a cancel never reached a terminal fact within its bound. */
  | "CANCEL_UNRESOLVED"
  /**
   * §7.7 / SIM-1 ruling R3: the venue executed a BASKET plan only in part, and
   * nothing in this process consumes the basket's `failurePolicy` yet. The
   * booked legs are owned and known; what to do with them is the decision.
   * Judged from each booked order's own outcome, an ACCEPTED plan included
   * (SIM-1 r2, `SIM1-R2-1`; `basket-execution.ts`).
   */
  | "BASKET_PARTIALLY_EXECUTED"
  /**
   * SIM-1 r1 (`SIM1-R1-1`): the execution venue refused to be positioned at a
   * recorded event, or could not APPLY what recorded time settled (a DELAYED
   * order's disposition, `SIMULATED_VENUE_DISPOSITION_NOT_APPLIED`). Its
   * account no longer answers for what the venue model says happened, so the
   * account state is unknown — §9.9's `RECONCILE_ACCOUNT` rung.
   */
  | "VENUE_OBSERVATION_FAILED"
  /** The strategy runtime could not persist a decision or its checkpoint. */
  | "RUNTIME_PERSISTENCE_FAILED"
  /** An event arrived that the trader cannot read as a §7.1 envelope. */
  | "EVENT_UNREADABLE"
  /** A book refused an update, so the local book is no longer authoritative. */
  | "BOOK_DESYNCHRONIZED"
  /** An operator-requested stop. */
  | "OPERATOR_HALT";

export interface HaltRecord {
  readonly scope: HaltScope;
  readonly code: HaltReasonCode;
  readonly detail: string;
  /** Strict-UTC instant from the injected clock. Never a wall-clock read here. */
  readonly at: string;
  /**
   * The §9.9 action this failure class selects.
   *
   * A recommendation the operator and the (later) Incident Controller act on;
   * this module performs only the part §9.9 assigns to the process itself —
   * making no further trading decision for the scope.
   */
  readonly action:
    | "HALT_NEW_ENTRIES"
    | "CANCEL_RESTING_ORDERS"
    | "RECONCILE_ACCOUNT"
    | "MANAGE_KNOWN_POSITIONS_ONLY"
    | "PROTECTED_REDUCE"
    | "HOLD_TO_RESOLUTION"
    | "FULL_HALT";
}

/**
 * The §9.9 action each failure class selects.
 *
 * Every entry is `FULL_HALT` or a strictly weaker rung, and the mapping is
 * data so a reviewer can read the whole policy at once instead of chasing
 * branches. `UNATTRIBUTED_ACTIVITY` maps to `RECONCILE_ACCOUNT` because §9.9's
 * table gives "account state unknown" exactly that treatment before the full
 * halt, and the scope-level latch already stops decisions either way.
 */
const ACTION_FOR: Readonly<Record<HaltReasonCode, HaltRecord["action"]>> = Object.freeze({
  TRANSPORT_UNAVAILABLE: "FULL_HALT",
  TRANSPORT_RESYNC_REQUIRED: "FULL_HALT",
  STORE_UNAVAILABLE: "FULL_HALT",
  QUEUE_BACKPRESSURE: "FULL_HALT",
  UNATTRIBUTED_ACTIVITY: "RECONCILE_ACCOUNT",
  UNEXPLAINED_ACTUAL_MOVEMENT: "RECONCILE_ACCOUNT",
  LEDGER_POSTING_REFUSED: "FULL_HALT",
  CANCEL_UNRESOLVED: "MANAGE_KNOWN_POSITIONS_ONLY",
  BASKET_PARTIALLY_EXECUTED: "MANAGE_KNOWN_POSITIONS_ONLY",
  VENUE_OBSERVATION_FAILED: "RECONCILE_ACCOUNT",
  RUNTIME_PERSISTENCE_FAILED: "FULL_HALT",
  EVENT_UNREADABLE: "FULL_HALT",
  BOOK_DESYNCHRONIZED: "CANCEL_RESTING_ORDERS",
  OPERATOR_HALT: "FULL_HALT",
});

function scopeKey(scope: HaltScope): string {
  switch (scope.kind) {
    case "GLOBAL":
      return "GLOBAL";
    case "MARKET":
      return `MARKET:${scope.marketId}`;
    case "STRATEGY_INSTANCE":
      return `STRATEGY_INSTANCE:${scope.instanceId}`;
  }
}

/**
 * Evidence a caller must produce to release a halt — at ANY scope.
 *
 * The literal `true` is the point, and it is the same shape
 * `packages/event-bus` demands for a hard-resync acknowledgement: §7.1 makes an
 * authoritative snapshot mandatory after a gap, so a release that could be
 * requested without one would be a release that permits the silent catch-up
 * ADR-003 §3.3 forbids.
 *
 * SCOPE (review round 2, note N1). This paragraph used to say "an ACCOUNT-level
 * halt" while {@link HaltController.release} accepted any {@link HaltScope} —
 * `GLOBAL`, `MARKET` and `STRATEGY_INSTANCE` — and demanded the same evidence
 * for each. The implementation is the correct one and the sentence was the
 * stale half: §9.17 requires reconciliation before resuming whatever the halt's
 * scope, and a market-scoped halt released without an authoritative snapshot is
 * the same silent catch-up on a smaller surface. Documented as it behaves.
 */
export interface HaltRelease {
  readonly authoritativeSnapshotApplied: true;
  readonly reason: string;
}

/**
 * The process's halt latch.
 *
 * Deterministic and clock-free: the instant on every record is supplied by the
 * caller (the §12.1 `Clock` port), so a replay of the same events produces the
 * same halt records byte for byte.
 */
export class HaltController {
  readonly #halts = new Map<string, HaltRecord>();

  /** Latches a halt. A repeat for the same scope keeps the FIRST record. */
  halt(scope: HaltScope, code: HaltReasonCode, detail: string, at: string): HaltRecord {
    const key = scopeKey(scope);
    const existing = this.#halts.get(key);
    if (existing !== undefined) return existing;
    const record: HaltRecord = Object.freeze({
      scope,
      code,
      detail,
      at,
      action: ACTION_FOR[code],
    });
    this.#halts.set(key, record);
    return record;
  }

  /** The global halt record, if the process is globally halted. */
  globalHalt(): HaltRecord | undefined {
    return this.#halts.get("GLOBAL");
  }

  /** True when no decision may be made for this market. */
  isMarketHalted(marketId: string): boolean {
    return this.#halts.has("GLOBAL") || this.#halts.has(`MARKET:${marketId}`);
  }

  /** True when no decision may be made for this instance. */
  isInstanceHalted(instanceId: string, marketId: string): boolean {
    return (
      this.isMarketHalted(marketId) || this.#halts.has(`STRATEGY_INSTANCE:${instanceId}`)
    );
  }

  /** True when the process is halted at any scope at all. */
  get anyHalt(): boolean {
    return this.#halts.size > 0;
  }

  /** Every latched halt, ordered by scope key so the health surface is stable. */
  records(): readonly HaltRecord[] {
    return Object.freeze(
      [...this.#halts.entries()]
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([, record]) => record),
    );
  }

  /**
   * Releases one scope, against evidence.
   *
   * Answers whether anything was released, so a caller cannot mistake an
   * acknowledgement of a halt that never existed for a recovery.
   */
  release(scope: HaltScope, evidence: HaltRelease): boolean {
    if (evidence.authoritativeSnapshotApplied !== true) return false;
    return this.#halts.delete(scopeKey(scope));
  }
}

/**
 * The `WP-200` composition-root obligation, discharged.
 *
 * Reads BOTH accounting sections of a ledger projection and halts the affected
 * market for each finding. The two are read TOGETHER — that is the whole of the
 * obligation — because they answer different questions:
 *
 * - `unattributedActivity` is an actual balance change with no strategy
 *   attribution. `WP-200` makes the `ACTUAL_ARRIVAL` arm carry the literal
 *   `haltRequired: true` so no code path can waive it, and a `REATTRIBUTION` is
 *   a remediation that must NOT re-raise the alarm it is fixing;
 * - `unexplainedMovements` is an actual movement no appended transaction
 *   explains — a different break, and one whose reader `WP-200` explicitly left
 *   to the composition root.
 *
 * Returns the halts it raised so the caller can report them; the controller has
 * already latched them.
 *
 * `notes` (`TRDR-4`, optional) maps a `ledgerTransactionId` to a sentence the
 * caller knows and the projection does not — the loop passes one for a fill
 * whose owner lookup MISSED (an unknown order, or a settled one whose tombstone
 * names a PROBABLE owner). The note is appended to the `UNATTRIBUTED_ACTIVITY`
 * detail of the record that transaction produced; it changes no scope, code or
 * action, and a halt latched earlier for the same scope keeps its first record,
 * as every repeat does.
 */
export function haltOnLedgerProjection(
  controller: HaltController,
  projection: LedgerProjection,
  at: string,
  notes?: ReadonlyMap<string, string>,
): readonly HaltRecord[] {
  const raised: HaltRecord[] = [];

  for (const record of projection.unattributedActivity) {
    // A `REATTRIBUTION` is the REMEDIATION for an earlier arrival and moves no
    // actual holding (`WP-200` assumption 2). Halting on it would make every
    // fix re-raise the alarm it is fixing, so only the arrival latches.
    if (record.activityKind !== "ACTUAL_ARRIVAL") continue;
    raised.push(
      controller.halt(
        record.affectedMarketId === null
          ? { kind: "GLOBAL" }
          : { kind: "MARKET", marketId: record.affectedMarketId },
        "UNATTRIBUTED_ACTIVITY",
        `unattributed actual activity on ${record.assetId} (${record.amount}) in ` +
          `transaction ${record.ledgerTransactionId}; §9.15 halts the affected market and ` +
          "§6 invariant 7 keeps actual and virtual separate until it is reconciled" +
          noteFor(notes, record.ledgerTransactionId),
        at,
      ),
    );
  }

  for (const record of projection.unexplainedMovements) {
    raised.push(
      controller.halt(
        record.affectedMarketId === null
          ? { kind: "GLOBAL" }
          : { kind: "MARKET", marketId: record.affectedMarketId },
        "UNEXPLAINED_ACTUAL_MOVEMENT",
        `an actual movement of ${record.unexplained} ${record.assetId} in transaction ` +
          `${record.ledgerTransactionId} is explained by no attribution leg; the composition ` +
          "root reads this section alongside unattributedActivity (WP-200 follow-up 2)",
        at,
      ),
    );
  }

  return Object.freeze(raised);
}

function noteFor(notes: ReadonlyMap<string, string> | undefined, ledgerTransactionId: string): string {
  const note = notes?.get(ledgerTransactionId);
  return note === undefined ? "" : ` — ${note}`;
}
