/**
 * The fill seam — `WP-220` composition-root obligations 5 (second half) and 8.
 *
 * > "**Fills must be delivered AT MOST ONCE.** A `StrategyFill` is settlement
 * > evidence, and the fold that consumes it ADDS: redelivering one fill of 50
 * > shares makes the instance believe it holds 100… This package cannot tell a
 * > redelivered fill from a second real one — §7.7 gives a fill no identity the
 * > strategy could deduplicate on beyond its order id, and one order
 * > legitimately fills many times — so **de-duplicating the fill stream is the
 * > composition root's obligation** (`WP-230`)."
 *
 * > "**A confirmed fill is delivered even while the instance is PAUSED**… A root
 * > that withholds fills from a paused instance leaves it believing it holds
 * > less than it does — the one direction this package cannot defend against,
 * > because it never sees the event."
 *   — `packages/strategies/static-bracket/README.md`
 *
 * ## The identity the strategy does not have, and this seam does
 *
 * `StrategyFill` carries `(orderId, marketId, outcome, side, price, shares,
 * fee?, filledAt)` and no identifier of its own, which is why the strategy
 * cannot deduplicate: two genuine partial fills of one order at one price in
 * one millisecond are indistinguishable from one fill delivered twice.
 *
 * The VENUE's fill has an identity — `packages/simulation`'s `SimulatedFill`
 * carries `simulatedFillId`, and a live adapter carries the venue's own
 * `VenueTradeId` (§7.2). This seam sits where that identity is still available,
 * keys on it, and hands the identity-free `StrategyFill` downstream exactly
 * once. That is the whole mechanism, and it is why the deduplication has to
 * live here rather than one layer lower.
 *
 * ## What "at most once" means for the LEDGER too
 *
 * The same `admit` answer gates the accounting path. A redelivered fill that
 * reached `buildFillPosting` would append a second balanced transaction for one
 * real movement — the ledger is append-only (ADR-006 §1), so that posting could
 * only be corrected by a compensating reversal, never removed. One seam, one
 * decision, both consumers.
 *
 * ## Bounded memory, and what the bound costs
 *
 * The seen-set is bounded (`maximumRemembered`). A fill id evicted from it
 * would be re-admitted if it were redelivered afterwards, so the bound is a
 * REAL limit and is stated rather than hidden: it is sized from the run's
 * expected fill count, eviction is oldest-first, and the count of evictions is
 * reported so an operator can see the seam approaching its bound instead of
 * discovering a double-count. A run that evicts is a run whose bound is too
 * small, and `evictions > 0` on the health surface says so — literally:
 * `HealthSnapshot.seams.fills.evictions`, which `CoreLoop.health()` reads from
 * {@link FillDeduplicator.metrics}.
 *
 * > **Corrected 2026-09-05 (remediation round 1).** The last sentence was a
 * > claim about a surface that did not exist: `metrics()` had no caller outside
 * > this seam's own unit test, so an eviction was reported NOWHERE an operator
 * > could see it (review round 1, MEDIUM-2).
 */

import type { StrategyFill } from "@polymarket-bot/strategy-sdk";

export interface IdentifiedFill {
  /** The venue's own identity for this fill. Never the strategy's view. */
  readonly venueFillId: string;
  /** The instance this fill is attributed to (§6 invariant 7). */
  readonly instanceId: string;
  /** The §9.6 payload the strategy's `onFill` receives. */
  readonly fill: StrategyFill;
}

export type FillAdmission =
  | { readonly admitted: true }
  | {
      readonly admitted: false;
      readonly reason: "DUPLICATE_FILL";
      readonly detail: string;
    };

export interface FillDeduplicatorMetrics {
  readonly remembered: number;
  readonly maximumRemembered: number;
  readonly admitted: number;
  readonly refused: number;
  /**
   * Fill ids forgotten because the bound was reached.
   *
   * Non-zero means the seam can no longer prove at-most-once for the whole run.
   * It is surfaced, not swallowed.
   */
  readonly evictions: number;
}

/**
 * The at-most-once gate for the fill stream.
 *
 * Deterministic and clock-free: admission depends only on the sequence of ids
 * it has been shown, so a replay of the same fills produces the same answers.
 */
export class FillDeduplicator {
  readonly maximumRemembered: number;
  /** Insertion-ordered, which is what makes oldest-first eviction exact. */
  readonly #seen = new Set<string>();
  #admitted = 0;
  #refused = 0;
  #evictions = 0;

  constructor(options: { readonly maximumRemembered: number }) {
    if (!Number.isSafeInteger(options.maximumRemembered) || options.maximumRemembered < 1) {
      throw new RangeError(
        "the fill deduplicator needs a positive integral bound; an unbounded seen-set is a " +
          "memory leak and a bound of zero is no seam at all",
      );
    }
    this.maximumRemembered = options.maximumRemembered;
  }

  /**
   * Admits a fill exactly once, keyed on the VENUE's identity.
   *
   * Answers data, never throws: a duplicate is an expected operational
   * condition (a transport redelivery, a reconnect replay), not an exception.
   */
  admit(venueFillId: string): FillAdmission {
    if (venueFillId.length === 0) {
      // An identity-free fill cannot be deduplicated, and admitting it would
      // silently reintroduce exactly the double-count this seam exists to stop.
      this.#refused += 1;
      return {
        admitted: false,
        reason: "DUPLICATE_FILL",
        detail:
          "a fill arrived with no venue identity; the at-most-once seam keys on the venue's " +
          "own fill id and refuses a fill it cannot key (fail closed — WP-220 obligation 5)",
      };
    }
    if (this.#seen.has(venueFillId)) {
      this.#refused += 1;
      return {
        admitted: false,
        reason: "DUPLICATE_FILL",
        detail:
          `fill ${venueFillId} has already been delivered; the strategy's fold ADDS, so a ` +
          "redelivery would make the instance believe it holds twice what it does " +
          "(WP-220 obligation 5)",
      };
    }
    if (this.#seen.size >= this.maximumRemembered) {
      const oldest = this.#seen.values().next();
      if (!oldest.done) {
        this.#seen.delete(oldest.value);
        this.#evictions += 1;
      }
    }
    this.#seen.add(venueFillId);
    this.#admitted += 1;
    return { admitted: true };
  }

  metrics(): FillDeduplicatorMetrics {
    return Object.freeze({
      remembered: this.#seen.size,
      maximumRemembered: this.maximumRemembered,
      admitted: this.#admitted,
      refused: this.#refused,
      evictions: this.#evictions,
    });
  }
}

/**
 * Obligation 8, stated as a predicate so the loop cannot forget it.
 *
 * A confirmed fill is delivered to its instance **whatever the instance's
 * status is** — including `PAUSED`. `packages/strategy-runtime`'s `evaluate()`
 * REFUSES a paused instance (`INSTANCE_PAUSED`) without invoking the callback,
 * so the delivery this obligation demands is not an `evaluate()` call: it is
 * the accounting fold, which the strategy performs in `onFill` when it is
 * active and which the ROOT must still record when it is not.
 *
 * What the loop does with a paused instance's fill, and why:
 *
 * - the LEDGER posting happens regardless. The money moved; §6 invariant 8
 *   makes the ledger the rebuildable source of truth, and a paused strategy
 *   does not un-move it;
 * - the strategy is offered the fill, and a `REFUSED / INSTANCE_PAUSED`
 *   outcome is RECORDED rather than treated as an error. The strategy's own
 *   `SB.FILL_FOLDED_WHILE_PAUSED` posture exists for the case where the
 *   runtime does invoke it;
 * - the fill is never withheld and never discarded, because "a root that
 *   withholds fills from a paused instance leaves it believing it holds less
 *   than it does — the one direction this package cannot defend against".
 *
 * ## PAUSED is not HALTED, and the difference is the whole of §4.2
 *
 * A PAUSED instance is a RUNTIME state: the instance still belongs to a scope
 * this process can reason about, so it is offered the fill and the runtime's
 * own refusal is the answer. A HALTED scope is a §4.2 state: this process can
 * no longer know the state it would decide from, so it makes NO trading
 * decision for that scope and the offer does not happen at all
 * (`loop.ts`; `health.loop.deliveriesSuppressedByHalt` counts it).
 *
 * The half this obligation exists to protect is untouched either way, because
 * it is the ACCOUNTING half: the ledger posting, the cash update and the PnL
 * fold are unconditional. What a halted instance loses is the chance to ACT on
 * a fill — which is exactly what §4.2 takes away, and it is restored by a new
 * run rebuilt from the ledger, not by delivering the callback anyway.
 */
export const FILLS_ARE_DELIVERED_WHILE_PAUSED = true as const;
