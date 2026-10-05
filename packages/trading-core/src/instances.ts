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
 * ## What `SHADOW` means in THIS process (review round 2, HIGH-1)
 *
 * **Observe-only.** A `SHADOW` instance is registered, ordered, evaluated in its
 * §8.2 position and its `DecisionResult`s are persisted — ADR-011 §5's "they
 * evaluate, produce decisions, and write records" — and `loop.ts` routes NONE of
 * its intents: no allocator commitment, no plan, no order, no fill. That is the
 * other half of the same sentence ("they do not consume venue rate limits,
 * because they submit nothing") and the only honest reading available here,
 * because this process holds ONE cash balance, ONE ledger and ONE venue. ADR-011
 * §1's "independent accounting" needs a second book, and there is not one; a
 * non-owner routed into the shared one is a live trade wearing a shadow label,
 * which is precisely the defect that made this paragraph necessary.
 *
 * ## One instance, many windows (`ROLLOVER-1`, ADR-030 Decision 4)
 *
 * A series-bound instance trades every window its series admits, each with its
 * OWN runtime (fresh per-window strategy state) and all under the instance's
 * one run. So a registration is keyed by its {@link RegisteredInstance.key}:
 * the `instanceId` for a market-bound instance — exactly as before — and
 * `<instanceId>|<marketId>` for one window of a series-bound one
 * ({@link windowRegistrationKey}). Everything that routes to a RUNTIME (an
 * order's owner, a fill's delivery, an order view, a PnL stream) uses the key;
 * everything that names the INSTANCE (risk, the allocator, halts, the ledger's
 * claims) still uses `instanceId`. A torn-down window's registrations leave
 * the evaluation order ({@link InstanceRegistry.retireMarket}); their identity
 * stays readable ({@link InstanceRegistry.identityOf}) for the PnL stream that
 * outlives them, and nothing else of them is kept.
 *
 * The registry holds no clock, no I/O and no venue surface. It owns the
 * `StrategyInstanceRuntime` handle each instance evaluates through and the
 * instance's configured identity, and nothing else.
 */

import type { StrategyInstanceRuntime } from "@polymarket-bot/strategy-runtime";

/**
 * `OWNER` trades; `SHADOW` observes.
 *
 * See the module header: a `SHADOW` instance evaluates and persists decisions,
 * and `loop.ts` routes none of its intents (§6 invariant 11, ADR-011 §5).
 */
export type Ownership = "OWNER" | "SHADOW";

export interface RegisteredInstance {
  /**
   * `ROLLOVER-1`: the registration key — `instanceId` for a market-bound
   * instance, `<instanceId>|<marketId>` for one window of a series-bound one.
   * DERIVED by {@link InstanceRegistry.register} from `instanceId`, `marketId`
   * and {@link RegisteredInstance.window}, never taken from its input — so a
   * registration built by spreading another one cannot carry a stale key.
   */
  readonly key: string;
  /** `ROLLOVER-1`: whether this is one WINDOW of a series-bound instance. */
  readonly window: boolean;
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

/**
 * What {@link InstanceRegistry.register} takes: everything but the key, which
 * it derives. `window` absent or `false`: a market-bound instance, keyed by
 * its `instanceId`, exactly as before.
 */
export type InstanceRegistration = Omit<RegisteredInstance, "key" | "window"> & {
  readonly window?: boolean;
};

/** `ROLLOVER-1`: the registration key of one window of a series-bound instance. */
export function windowRegistrationKey(instanceId: string, marketId: string): string {
  return `${instanceId}|${marketId}`;
}

/** The identity a retired registration keeps, for the PnL stream that outlives it. */
export interface RegistrationIdentity {
  readonly key: string;
  readonly instanceId: string;
  readonly runId: string;
  readonly marketId: string;
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
  /** Keyed by {@link RegisteredInstance.key}. */
  readonly #instances = new Map<string, RegisteredInstance>();
  readonly #owners = new Map<string, string>();
  /** `ROLLOVER-1`: retired window registrations' identities, by key. */
  readonly #retired = new Map<string, RegistrationIdentity>();
  /**
   * Recomputed on registration — a startup act, and since `ROLLOVER-1` also a
   * window's admission and teardown: a few per window, not a hot path.
   */
  #ordered: readonly RegisteredInstance[] = Object.freeze([]);

  register(input: InstanceRegistration): RegisterResult {
    const window = input.window === true;
    const key = window ? windowRegistrationKey(input.instanceId, input.marketId) : input.instanceId;
    const instance: RegisteredInstance = Object.freeze({ ...input, key, window });
    if (this.#instances.has(instance.key) || this.#retired.has(instance.key)) {
      return {
        ok: false,
        code: "DUPLICATE_INSTANCE",
        detail: `instance ${instance.instanceId} is already registered (key ${instance.key})`,
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
    this.#instances.set(instance.key, instance);
    this.#ordered = Object.freeze([...this.#instances.values()].sort(compareInstances));
    return { ok: true };
  }

  /**
   * `ROLLOVER-1`: retires every WINDOW registration of `marketId` (a key other
   * than its instance id) — the window is torn down (ADR-030 Decision 4.4).
   * Its owner claim is released, it leaves the evaluation order, and only its
   * identity is kept. A market-bound registration is never retired. Answers how
   * many were.
   */
  retireMarket(marketId: string): number {
    let retired = 0;
    for (const [key, instance] of [...this.#instances]) {
      if (instance.marketId !== marketId || !instance.window) continue;
      this.#instances.delete(key);
      this.#retired.set(key, Object.freeze({ key, instanceId: instance.instanceId, runId: instance.runId, marketId }));
      if (this.#owners.get(marketId) === instance.instanceId && instance.ownership === "OWNER") {
        this.#owners.delete(marketId);
      }
      retired += 1;
    }
    if (retired > 0) this.#ordered = Object.freeze([...this.#instances.values()].sort(compareInstances));
    return retired;
  }

  /** The identity of a live or retired registration, by key. */
  identityOf(key: string): RegistrationIdentity | undefined {
    const live = this.#instances.get(key);
    if (live !== undefined) return { key, instanceId: live.instanceId, runId: live.runId, marketId: live.marketId };
    return this.#retired.get(key);
  }

  /** Every registered instance in §8.2 order. */
  evaluationOrder(): readonly RegisteredInstance[] {
    return this.#ordered;
  }

  /** Instances subscribed to one market, in §8.2 order. */
  forMarket(marketId: string): readonly RegisteredInstance[] {
    return Object.freeze(this.#ordered.filter((instance) => instance.marketId === marketId));
  }

  /** A live registration by its key (the `instanceId` for a market-bound instance). */
  get(key: string): RegisteredInstance | undefined {
    return this.#instances.get(key);
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
