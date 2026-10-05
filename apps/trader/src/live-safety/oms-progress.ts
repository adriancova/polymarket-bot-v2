/**
 * The OMS health input's evidence (WP-320 r1, finding I5; r2, finding X4;
 * handoff §9.18 "OMS"; ADR-008 §3: "a lease on HEALTH, not on liveness").
 *
 * WP-270's `OrderManager` exposes one health fact, `faulted`, and sets it only
 * when a store write REJECTS. A call that never settles — a hung persistence
 * call, a wedged connection, a reservation journal append that never
 * acknowledges — leaves `faulted` false for ever, and every operation queued
 * behind it waits with it. Reading `faulted === false` and stamping it "now"
 * therefore proved the OMS healthy while it was wedged (r1 I5): liveness
 * standing in for health.
 *
 * ## Which OMS ports are timed, and why exactly these
 *
 * `OrderManager.open` takes its dependencies as one object
 * (`OrderManagerDependencies`, `packages/oms/src/order-manager.ts`). Its
 * ASYNCHRONOUS ports — the ones the OMS awaits, and so the ones a hung call
 * can wedge it on — are exactly four:
 *
 * | Port | Awaited by the OMS for | Timed here |
 * | --- | --- | --- |
 * | `store` (`apply`, `load`) | every durable write; recovery | YES, {@link OmsProgressMonitor.store} |
 * | `reservations` (`reserve`, `consume`, `release`) | WP-300's reservation service, whose `#mutate` waits for its journal append and acknowledgement chain | YES, {@link OmsProgressMonitor.reservations} (r2 X4) |
 * | `cipher` (`encrypt`, `decrypt`) | sealing a signed payload before it is persisted; opening it to retransmit | YES, {@link OmsProgressMonitor.cipher} (r2 X4) |
 * | `venue` (`createLimitOrder`, `postOrder`, `postOrders`, `cancelOrder`) | the venue's answers | NO (below) |
 *
 * Every other dependency (`restoreSignedOrder`, `reconciler.request`,
 * `newId`, `requestToken`, `venueMode`) is synchronous: a call that never
 * returns blocks the event loop, which the EVENT_LOOP input sees.
 *
 * At round 1 only the store was timed, and a reservation that never answered
 * left the OMS wedged inside `submit` with nothing tracked pending: the input
 * read healthy and the heartbeat ran on (r2 X4, reproduced with the real OMS).
 * Now coverage is part of the evidence: {@link OmsProgressMonitor.reading}
 * proves NOTHING until all three persistence ports have been wrapped (fail
 * closed: unknown coverage is no evidence). The composition passes its
 * dependencies through {@link OmsProgressMonitor.dependencies} (or each port
 * through its wrapper) and opens the `OrderManager` over the RESULT.
 * `port-conformance.test.ts` pins, at compile time, that the real
 * `OrderManagerDependencies` has no asynchronous port beyond these four, so a
 * port WP-270 adds later fails that check until it is classified here.
 *
 * Venue calls are not timed as OMS health. A slow venue answer is the venue's
 * latency, not an unhealthy OMS, and a stopped heartbeat would cancel every
 * resting order for it. Correction (r2 O4): WP-260's secure client puts NO
 * deadline of its own on a venue call (`venue-client.ts` awaits the SDK port
 * with no timeout or abort signal; `error-mapping.ts` only maps an SDK
 * `TimeoutError` when the SDK raises one), so a venue call is bounded only by
 * whatever the SDK's HTTP client is configured with. A hung PLACEMENT is
 * visible elsewhere: the fenced venue tracks every placement it hands to the
 * venue until it settles, and a kill switch's cancel obligation is held open
 * while one in its scope is pending (`live-safety.ts`, r2 X3). WP-270 makes
 * its venue calls outside its serialized store chain, so a hung venue call
 * does not wedge persistence.
 *
 * ## The evidence ({@link OmsProgressMonitor.reading})
 *
 * - a persistence port not instrumented: `STORE_NOT_INSTRUMENTED`,
 *   `RESERVATIONS_NOT_INSTRUMENTED` or `CIPHER_NOT_INSTRUMENTED` (the first
 *   missing) — fail closed;
 * - a call whose start could not be timed (an unreadable clock) is pending:
 *   `OPERATION_UNTIMED`;
 * - otherwise: healthy, proved at the START of the oldest call still pending,
 *   or at `now` when none is. A call that does not settle within the OMS
 *   input's maximum age therefore fails the health lease, and the heartbeat
 *   stops (criterion "unhealthy-but-running process stops heartbeat").
 *
 * The OMS's `faulted` flag is still read by the composition, and still fails
 * the input at once. What this cannot see (disclosed): a wedge INSIDE the OMS
 * that is not a pending port call (a promise the OMS itself never settles).
 * An in-OMS attestation (a timestamp of its own last completed operation)
 * would need a `packages/oms` change, outside this package's grant.
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

/** WP-270's `OmsReservationPort` (WP-300's `ReservationService`, structurally). */
export interface OmsReservationsLike<TReserve, TConsume, TRelease, TResult> {
  reserve(request: TReserve): Promise<TResult>;
  consume(input: TConsume): Promise<TResult>;
  release(input: TRelease): Promise<TResult>;
}

/** WP-270's `PayloadCipher`. */
export interface OmsCipherLike<TSealed> {
  encrypt(plaintext: string): Promise<TSealed>;
  decrypt(payload: TSealed): Promise<string>;
}

/** The three persistence ports of an OMS dependency object, as {@link OmsProgressMonitor.dependencies} reads them. */
export interface OmsPersistenceDependencies {
  readonly store: OmsStoreLike<never, unknown>;
  readonly reservations: OmsReservationsLike<never, never, never, unknown>;
  readonly cipher: OmsCipherLike<unknown>;
}

/** The persistence ports every OMS health proof requires to be instrumented, in the order they are reported. */
export const OMS_INSTRUMENTED_PORTS = Object.freeze(["store", "reservations", "cipher"] as const);
export type OmsInstrumentedPort = (typeof OMS_INSTRUMENTED_PORTS)[number];

const NOT_INSTRUMENTED: Readonly<Record<OmsInstrumentedPort, string>> = Object.freeze({
  store: "STORE_NOT_INSTRUMENTED",
  reservations: "RESERVATIONS_NOT_INSTRUMENTED",
  cipher: "CIPHER_NOT_INSTRUMENTED",
});

export class OmsProgressMonitor {
  readonly #clock: MonotonicClock;
  /** Pending calls: id → start (monotonic), or −∞ when the start could not be timed. */
  readonly #pending = new Map<number, number>();
  readonly #instrumented = new Set<OmsInstrumentedPort>();
  #nextId = 0;

  constructor(options: { readonly clock: MonotonicClock }) {
    if (typeof options !== "object" || options === null || typeof options.clock !== "object" || options.clock === null) {
      throw new TypeError("OmsProgressMonitor needs a monotonic clock");
    }
    this.#clock = options.clock;
  }

  /** The OMS's store, with every `apply` and `load` timed. Pass the RESULT to `OrderManager.open`. */
  store<TWrites, TSnapshot>(store: OmsStoreLike<TWrites, TSnapshot>): OmsStoreLike<TWrites, TSnapshot> {
    this.#instrumented.add("store");
    return Object.freeze({
      apply: (writes: TWrites): Promise<void> => this.track(() => store.apply(writes)),
      load: (): Promise<TSnapshot> => this.track(() => store.load()),
    });
  }

  /** The OMS's reservation port, with every `reserve`, `consume` and `release` timed (r2 X4). Pass the RESULT. */
  reservations<TReserve, TConsume, TRelease, TResult>(
    port: OmsReservationsLike<TReserve, TConsume, TRelease, TResult>,
  ): OmsReservationsLike<TReserve, TConsume, TRelease, TResult> {
    this.#instrumented.add("reservations");
    return Object.freeze({
      reserve: (request: TReserve): Promise<TResult> => this.track(() => port.reserve(request)),
      consume: (input: TConsume): Promise<TResult> => this.track(() => port.consume(input)),
      release: (input: TRelease): Promise<TResult> => this.track(() => port.release(input)),
    });
  }

  /** The OMS's payload cipher, with every `encrypt` and `decrypt` timed (r2 X4). Pass the RESULT. */
  cipher<TSealed>(port: OmsCipherLike<TSealed>): OmsCipherLike<TSealed> {
    this.#instrumented.add("cipher");
    return Object.freeze({
      encrypt: (plaintext: string): Promise<TSealed> => this.track(() => port.encrypt(plaintext)),
      decrypt: (payload: TSealed): Promise<string> => this.track(() => port.decrypt(payload)),
    });
  }

  /**
   * The OMS's whole dependency object, with its three persistence ports instrumented and everything else as given.
   * Pass the RESULT to `OrderManager.open`.
   */
  dependencies<TDeps extends OmsPersistenceDependencies>(deps: TDeps): TDeps {
    const instrumented: OmsPersistenceDependencies = {
      store: this.store(deps.store),
      reservations: this.reservations(deps.reservations),
      cipher: this.cipher(deps.cipher),
    };
    // Each wrapper has exactly its port's methods, with the same parameters and results, so the object is still a TDeps.
    return Object.freeze({ ...deps, ...instrumented }) as TDeps;
  }

  /** Which persistence ports have been instrumented (for the composition's own startup check). */
  instrumented(): readonly OmsInstrumentedPort[] {
    return Object.freeze(OMS_INSTRUMENTED_PORTS.filter((port) => this.#instrumented.has(port)));
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
    for (const port of OMS_INSTRUMENTED_PORTS) {
      if (!this.#instrumented.has(port)) return Object.freeze({ healthy: false as const, reason: NOT_INSTRUMENTED[port] });
    }
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
