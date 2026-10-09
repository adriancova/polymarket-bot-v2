/**
 * The halt controller — handoff §4.2 failure boundaries, plus the `WP-200`
 * composition-root obligation.
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
 * A halt is a LATCH, not a flag that policy can clear, and EVERY HALT ENDS THE
 * RUN (`C1-HALTS`, the user's ruling of 2026-10-08): whatever its scope, the
 * pump stops at the next boundary and the process exits `EXIT_CODES.halted`
 * (75); the operator starts a NEW run (`BOOT-1`). Until the pump stops:
 *
 * - the core loop makes **no trading decision** for the halted scope: no
 *   strategy is evaluated, no intent is risk-checked, no plan is built and
 *   nothing is submitted (and risk check 1 refuses every placement anywhere,
 *   `runStatePermitsIntent` being `!anyHalt`). A fill or an order view that
 *   arrives afterwards — including one whose OWN iteration latched the halt —
 *   is still BOOKED and is **not** delivered to the strategy (`loop.ts`
 *   §"No trading decision on stale or absent state" lists the four gates, and
 *   `health.loop.deliveriesSuppressedByHalt` counts what they withheld);
 * - the reason and the instant are retained and reported on the health surface.
 *
 * Nothing in this process releases a halt. The {@link HaltScope} and its
 * market or instance id are DIAGNOSTIC data: they say what tripped, and the
 * durable halt row (`apps/trader/src/halt-record.ts`) carries them as the
 * columns the research worker's retention evidence reads. They do not narrow
 * the stop. (Until `C1-HALTS` a §9.9 "action" rung was attached to each record
 * and a `release` method existed; neither was ever acted on, so both were
 * removed rather than kept as promises.)
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
  /**
   * `FOLD-1` (§6 invariant 8, ADR-006 §1 "A rebuild from zero must equal the
   * incremental state"): the loop's HELD accounting state — the ledger view it
   * advances per posting, or a PnL stream it advances per record — differs,
   * on serialized bytes, from its rebuild from zero (`folds.ts`). The
   * positions this process decides from are then not the ledger's, so it
   * makes no further decision anywhere: GLOBAL, `FULL_HALT`. The held state
   * is replaced by the rebuild, so the accounting that continues under the
   * halt reads the ledger's truth.
   */
  | "ACCOUNTING_REBUILD_MISMATCH"
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
   * account state is unknown — §9.9's `RECONCILE_ACCOUNT` rung. SIM-2: also
   * when the venue can no longer answer for state the loop reads from it —
   * the fills since the loop's cursor (its bounded fill history evicted them,
   * `SIMULATED_VENUE_HISTORY_EVICTED`), or an order the loop owns, holds or
   * watches and has NOT acknowledged (a venue must hold such an order, so it
   * evicted it regardless, or never held it). The loop reads no history, so
   * it cannot rebuild what is missing.
   */
  | "VENUE_OBSERVATION_FAILED"
  /** The strategy runtime could not persist a decision or its checkpoint. */
  | "RUNTIME_PERSISTENCE_FAILED"
  /** An event arrived that the trader cannot read as a §7.1 envelope. */
  | "EVENT_UNREADABLE"
  /**
   * `C1-HALTS`: a book refused an update for a reason that signals a contract
   * or programming fault — the payload names a token or market this book is
   * not, or fails its own frozen contract, or a trading parameter contradicts
   * an applied one (`book-refusals.ts`, class FAULT). A book that merely fell
   * out of step with the venue (no baseline yet, a newer generation, another
   * epoch) is NOT a halt: it waits for its next snapshot.
   */
  | "BOOK_DESYNCHRONIZED";

export interface HaltRecord {
  /** What tripped: diagnostic only — every halt ends the run (module header). */
  readonly scope: HaltScope;
  readonly code: HaltReasonCode;
  readonly detail: string;
  /** Strict-UTC instant from the injected clock. Never a wall-clock read here. */
  readonly at: string;
}

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
 * detail of the record that transaction produced; it changes no scope or
 * code, and a halt latched earlier for the same scope keeps its first record,
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
