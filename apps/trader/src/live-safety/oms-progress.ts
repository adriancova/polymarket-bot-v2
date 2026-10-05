/**
 * The OMS health input's evidence (WP-320 r1, finding I5; handoff §9.18 "OMS";
 * ADR-008 §3: "a lease on HEALTH, not on liveness").
 *
 * WP-270's `OrderManager` exposes one health fact, `faulted`, and sets it only
 * when a store write REJECTS. A write that never settles — a hung
 * persistence call, a wedged connection — leaves `faulted` false for ever,
 * and every operation queued behind it (the OMS serializes its writes) waits
 * with it. Reading `faulted === false` and stamping it "now" therefore proved
 * the OMS healthy while it was wedged (r1 I5): liveness standing in for
 * health.
 *
 * This monitor sits on the OMS's own store instead. The composition passes
 * the OMS's store through {@link OmsProgressMonitor.store} before it opens the
 * `OrderManager` (every persistence call the OMS makes goes through
 * `OmsStore.apply`, and its recovery through `OmsStore.load`), and may pass
 * any other asynchronous OMS port call through {@link OmsProgressMonitor.track}.
 * Each call is timed on the monotonic clock from the instant before it was
 * made until it settles, either way. Venue calls are NOT tracked: their
 * latency is the venue's, bounded by the secure client's response bound
 * (WP-260), and a slow venue answer is not an unhealthy OMS; a stopped
 * heartbeat would cancel every resting order for it.
 *
 * The evidence ({@link OmsProgressMonitor.reading}):
 *
 * - no store instrumented: `STORE_NOT_INSTRUMENTED` — fail closed, a
 *   composition that skipped the wrapper proves nothing;
 * - a call whose start could not be timed (an unreadable clock) is pending:
 *   `OPERATION_UNTIMED`;
 * - otherwise: healthy, proved at the START of the oldest call still pending,
 *   or at `now` when none is. A call that does not settle within the OMS
 *   input's maximum age therefore fails the health lease, and the heartbeat
 *   stops (criterion "unhealthy-but-running process stops heartbeat").
 *
 * The OMS's `faulted` flag is still read by the composition, and still fails
 * the input at once. What this cannot see (disclosed): a wedge INSIDE the OMS
 * that is not a pending store call (WP-270's `OrderManager` serializes every
 * durable write through `OmsStore.apply`, so a stuck persistence chain shows
 * here; a call stuck on another port shows only if the composition tracks
 * that port). An in-OMS attestation (a timestamp of its own last completed
 * operation) would need a `packages/oms` change, outside this package's
 * grant.
 *
 * Nothing here performs I/O of its own, reads a wall clock or holds a
 * credential.
 */

import type { HealthProofReading } from "./health-lease.js";
import type { MonotonicClock } from "./ports.js";

/** The slice of WP-270's `OmsStore` the monitor wraps (structural; `port-conformance.test.ts` pins the real one). */
export interface OmsStoreLike<TWrites, TSnapshot> {
  apply(writes: TWrites): Promise<void>;
  load(): Promise<TSnapshot>;
}

export class OmsProgressMonitor {
  readonly #clock: MonotonicClock;
  /** Pending calls: id → start (monotonic), or −∞ when the start could not be timed. */
  readonly #pending = new Map<number, number>();
  #nextId = 0;
  #storeAttached = false;

  constructor(options: { readonly clock: MonotonicClock }) {
    if (typeof options !== "object" || options === null || typeof options.clock !== "object" || options.clock === null) {
      throw new TypeError("OmsProgressMonitor needs a monotonic clock");
    }
    this.#clock = options.clock;
  }

  /** The OMS's store, with every `apply` and `load` timed. Pass the RESULT to `OrderManager.open`. */
  store<TWrites, TSnapshot>(store: OmsStoreLike<TWrites, TSnapshot>): OmsStoreLike<TWrites, TSnapshot> {
    this.#storeAttached = true;
    return Object.freeze({
      apply: (writes: TWrites): Promise<void> => this.track(() => store.apply(writes)),
      load: (): Promise<TSnapshot> => this.track(() => store.load()),
    });
  }

  /** Run `operation`, timed from the instant before it starts until it settles (resolved, rejected or thrown). */
  track<T>(operation: () => Promise<T>): Promise<T> {
    this.#nextId += 1;
    const id = this.#nextId;
    this.#pending.set(id, this.#now() ?? Number.NEGATIVE_INFINITY);
    let pending: Promise<T>;
    try {
      pending = Promise.resolve(operation());
    } catch (error) {
      this.#pending.delete(id);
      return Promise.reject(error instanceof Error ? error : new Error("the OMS port threw"));
    }
    return pending.finally(() => {
      this.#pending.delete(id);
    });
  }

  /** How many tracked calls have not settled. */
  pendingCount(): number {
    return this.#pending.size;
  }

  /** The OMS input's evidence at `nowMs` (module header). */
  reading(nowMs: number): HealthProofReading {
    if (!this.#storeAttached) return Object.freeze({ healthy: false as const, reason: "STORE_NOT_INSTRUMENTED" });
    let oldest = nowMs;
    for (const startedAtMs of this.#pending.values()) {
      if (!Number.isFinite(startedAtMs)) return Object.freeze({ healthy: false as const, reason: "OPERATION_UNTIMED" });
      if (startedAtMs < oldest) oldest = startedAtMs;
    }
    return Object.freeze({ healthy: true as const, provenAtMs: oldest });
  }

  #now(): number | null {
    try {
      const value = this.#clock.monotonicMs();
      return typeof value === "number" && Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  }
}
