/**
 * The strategy-instance registry and the §8.2 stable evaluation order.
 *
 * > "Subscribed strategies are evaluated by:
 * >
 * > ```text
 * > market ownership priority
 * > strategy instance priority
 * > strategy instance UUID
 * > ```
 * >
 * > The order is stable and **recorded in the run manifest**. V1 prevents
 * > multiple live owners of one market, but shadow instances may still evaluate
 * > after the owner."
 *   — handoff §8.2
 *
 * Three things follow, and all three are enforced here rather than assumed:
 *
 * 1. **The comparator is total.** Ownership first (`OWNER` before `SHADOW`),
 *    then priority ascending, then instance UUID ascending. The third key is
 *    what makes the order TOTAL: two instances can share an ownership and a
 *    priority, but not a UUID, so no pair is ever incomparable and the sort is
 *    deterministic without relying on the input order.
 * 2. **The order is recorded.** `manifest()` emits it as data — the same list,
 *    in the same order, that `evaluationOrder()` walks — so the run manifest
 *    §8.2 requires is produced by the same code that decides the order rather
 *    than by a second description of it.
 * 3. **One live owner per market (§6 invariant 11, ADR-011).** Registration
 *    REFUSES a second `OWNER` for a market. The refusal is a startup failure,
 *    not a warning: `packages/capital-allocator` rejects conflicting live
 *    ownership too, and a process that started with two owners would be a
 *    process whose §8.2 order is the only thing keeping them apart.
 *
 * The registry holds no clock, no I/O and no venue surface. It owns the
 * `StrategyInstanceRuntime` handle each instance evaluates through and the
 * instance's configured identity, and nothing else.
 */

import type { StrategyInstanceRuntime } from "@polymarket-bot/strategy-runtime";

export type Ownership = "OWNER" | "SHADOW";

export interface RegisteredInstance {
  readonly instanceId: string;
  readonly runId: string;
  readonly configId: string;
  readonly marketId: string;
  readonly ownership: Ownership;
  readonly evaluationPriority: number;
  readonly runtime: StrategyInstanceRuntime;
  /**
   * The outcome side this instance's configuration binds
   * (`market_selector.direction`).
   *
   * It selects which of the market's two books the feature snapshot is computed
   * over: the executable-price features describe ONE token's ladder, and an
   * instance configured on `NO` whose trigger read the `YES` book would be
   * comparing its threshold against a price for the other outcome.
   */
  readonly direction: "YES" | "NO";
  /** The strategy's own validated params, kept for the seams that read tags. */
  readonly params: unknown;
  /** `entry.execution.immediate_order_type`, resolved at registration. */
  readonly immediateOrderType: "GTC" | "GTD" | "FAK" | "FOK";
  /** `entry.execution.submission_unknown_after_ms`, the §6 invariant 6 bound. */
  readonly submissionUnknownAfterMs: number;
}

export type RegisterResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: "DUPLICATE_INSTANCE" | "MARKET_ALREADY_OWNED";
      readonly detail: string;
    };

/** `OWNER` sorts before `SHADOW`: §8.2's "market ownership priority". */
const OWNERSHIP_RANK: Readonly<Record<Ownership, number>> = Object.freeze({
  OWNER: 0,
  SHADOW: 1,
});

/** The §8.2 comparator, total and stated once. */
export function compareInstances(left: RegisteredInstance, right: RegisteredInstance): number {
  const byOwnership = OWNERSHIP_RANK[left.ownership] - OWNERSHIP_RANK[right.ownership];
  if (byOwnership !== 0) return byOwnership;
  const byPriority = left.evaluationPriority - right.evaluationPriority;
  if (byPriority !== 0) return byPriority;
  return left.instanceId < right.instanceId ? -1 : left.instanceId > right.instanceId ? 1 : 0;
}

/** One row of the §8.2 run manifest. */
export interface ManifestRow {
  readonly position: number;
  readonly instanceId: string;
  readonly runId: string;
  readonly marketId: string;
  readonly ownership: Ownership;
  readonly evaluationPriority: number;
}

export class InstanceRegistry {
  readonly #instances = new Map<string, RegisteredInstance>();
  readonly #owners = new Map<string, string>();
  /** Recomputed on registration; registration is a startup act, not a hot path. */
  #ordered: readonly RegisteredInstance[] = Object.freeze([]);

  register(instance: RegisteredInstance): RegisterResult {
    if (this.#instances.has(instance.instanceId)) {
      return {
        ok: false,
        code: "DUPLICATE_INSTANCE",
        detail: `instance ${instance.instanceId} is already registered`,
      };
    }
    if (instance.ownership === "OWNER") {
      const existing = this.#owners.get(instance.marketId);
      if (existing !== undefined) {
        return {
          ok: false,
          code: "MARKET_ALREADY_OWNED",
          detail:
            `market ${instance.marketId} is already owned by instance ${existing}; ` +
            "§6 invariant 11 and ADR-011 permit exactly one live owner per market in v1, " +
            "and a second one is refused at startup rather than resolved at evaluation time",
        };
      }
      this.#owners.set(instance.marketId, instance.instanceId);
    }
    this.#instances.set(instance.instanceId, instance);
    this.#ordered = Object.freeze([...this.#instances.values()].sort(compareInstances));
    return { ok: true };
  }

  /** Every registered instance in §8.2 order. */
  evaluationOrder(): readonly RegisteredInstance[] {
    return this.#ordered;
  }

  /** Instances subscribed to one market, in §8.2 order. */
  forMarket(marketId: string): readonly RegisteredInstance[] {
    return Object.freeze(this.#ordered.filter((instance) => instance.marketId === marketId));
  }

  get(instanceId: string): RegisteredInstance | undefined {
    return this.#instances.get(instanceId);
  }

  /** The market's live owner, if it has one. */
  ownerOf(marketId: string): string | undefined {
    return this.#owners.get(marketId);
  }

  /**
   * The §8.2 run manifest: the evaluation order as data.
   *
   * Emitted from `evaluationOrder()` itself, so the manifest cannot describe an
   * order the loop does not use.
   */
  manifest(): readonly ManifestRow[] {
    return Object.freeze(
      this.#ordered.map((instance, position) =>
        Object.freeze({
          position,
          instanceId: instance.instanceId,
          runId: instance.runId,
          marketId: instance.marketId,
          ownership: instance.ownership,
          evaluationPriority: instance.evaluationPriority,
        }),
      ),
    );
  }
}
