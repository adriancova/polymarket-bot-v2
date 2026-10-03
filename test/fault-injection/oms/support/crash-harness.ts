/**
 * The OMS crash harness (WP-270 fault injection; handoff §16.6: "Kill trader
 * before order transmission", "Kill trader after transmission but before
 * response persistence").
 *
 * Every port call an incarnation makes is counted, in order: store
 * transactions and loads, signing, transmissions, cancels, cipher calls,
 * reservation calls and reconciliation requests. A run kills the process at
 * the k-th call, either BEFORE it (the call never happens) or AFTER it (its
 * effect stands: a committed transaction, an order the venue now holds, a
 * reservation made, a request delivered; the process never sees the answer).
 * A dead incarnation's every later port call throws, so it can neither write
 * nor send. The world (venue, inventory, store) carries on, and a fresh
 * incarnation restarts through the store port.
 *
 * Nothing here reaches a network, a key or a signer: the venue is the
 * simulated world, the cipher is the mock, the inventory is WP-300's
 * in-memory `ReservationService`.
 */

import {
  OrderManager,
  type OmsReservationPort,
  type OmsStore,
  type OmsVenuePort,
  type OrderManagerDependencies,
  type PayloadCipher,
  type ReconciliationRequest,
  type ReconciliationRequester,
  type VenueMode,
} from "../../../../packages/oms/src/index.js";
import { restoreFakeSignedOrder } from "../../../unit/oms/support/fake-venue.js";
import { PUSD, realInventory } from "../../../unit/oms/support/harness.js";
import { idSource, tokenSource } from "../../../unit/oms/support/ids.js";
import { MemoryStore } from "../../../unit/oms/support/memory-store.js";
import { MockCipher } from "../../../unit/oms/support/mock-cipher.js";
import { SimWorld } from "../../../unit/oms/support/world.js";

export interface KillPlan {
  readonly at: number;
  readonly phase: "before" | "after";
}

export class Killed extends Error {}

/** The world that survives every crash. */
export interface Universe {
  readonly world: SimWorld;
  readonly store: MemoryStore;
  readonly cipher: MockCipher;
  readonly inventory: ReturnType<typeof realInventory>;
  readonly requests: ReconciliationRequest[];
  readonly newId: () => string;
  readonly requestToken: () => string;
  readonly mode: { value: VenueMode };
  /** How many held attempts the drain resent (the same signed order) after the restart. */
  retransmittedAfterRestart: number;
}

export function universe(): Universe {
  return {
    retransmittedAfterRestart: 0,
    world: new SimWorld(),
    store: new MemoryStore(),
    cipher: new MockCipher(),
    inventory: realInventory({ pusd: "1000", yes: "0" }),
    requests: [],
    newId: idSource(0x9),
    requestToken: tokenSource("fault"),
    mode: { value: "NORMAL" },
  };
}

export class Incarnation {
  alive = true;
  calls = 0;
  readonly trace: string[] = [];
  manager: OrderManager | null = null;
  readonly #plan: KillPlan | null;

  constructor(plan: KillPlan | null) {
    this.#plan = plan;
  }

  /** Count one port call; kill before or after it as planned. */
  async call<T>(name: string, run: () => Promise<T>): Promise<T> {
    if (!this.alive) throw new Killed("dead incarnation");
    this.calls += 1;
    this.trace.push(name);
    const here = this.#plan !== null && this.#plan.at === this.calls;
    if (here && this.#plan?.phase === "before") {
      this.alive = false;
      throw new Killed(`killed before ${name}`);
    }
    const result = await run();
    if (here) {
      this.alive = false;
      throw new Killed(`killed after ${name}`);
    }
    return result;
  }

  callSync<T>(name: string, run: () => T): T {
    if (!this.alive) throw new Killed("dead incarnation");
    this.calls += 1;
    this.trace.push(name);
    const here = this.#plan !== null && this.#plan.at === this.calls;
    if (here && this.#plan?.phase === "before") {
      this.alive = false;
      throw new Killed(`killed before ${name}`);
    }
    const result = run();
    if (here) {
      this.alive = false;
      throw new Killed(`killed after ${name}`);
    }
    return result;
  }
}

/** Start an incarnation over the universe, with a kill plan (or none). `undefined` if it died while opening. */
export async function start(u: Universe, plan: KillPlan | null): Promise<Incarnation> {
  const inc = new Incarnation(plan);
  const venue = u.world.venuePort(() => inc.alive);
  const venuePort: OmsVenuePort = {
    createLimitOrder: (request) => inc.call("venue.sign", () => venue.createLimitOrder(request)),
    postOrder: (order) => inc.call("venue.post", () => venue.postOrder(order)),
    postOrders: (orders) => inc.call("venue.postBatch", () => venue.postOrders(orders)),
    cancelOrder: (orderId) => inc.call("venue.cancel", () => venue.cancelOrder(orderId)),
  };
  const store: OmsStore = {
    apply: (writes) => inc.call(`store.apply[${writes.map((w) => w.kind).join(",")}]`, () => u.store.apply(writes)),
    load: () => inc.call("store.load", () => u.store.load()),
  };
  const cipher: PayloadCipher = {
    encrypt: (text) => inc.call("cipher.encrypt", () => u.cipher.encrypt(text)),
    decrypt: (payload) => inc.call("cipher.decrypt", () => u.cipher.decrypt(payload)),
  };
  const reservations: OmsReservationPort = {
    reserve: (input) => inc.call("inventory.reserve", () => u.inventory.service.reserve(input)),
    consume: (input) => inc.call("inventory.consume", () => u.inventory.service.consume(input)),
    release: (input) => inc.call("inventory.release", () => u.inventory.service.release(input)),
  };
  const reconciler: ReconciliationRequester = {
    request: (request) =>
      inc.callSync("reconciler.request", () => {
        u.requests.push(request);
      }),
  };
  const deps: OrderManagerDependencies = {
    venue: venuePort,
    restoreSignedOrder: restoreFakeSignedOrder,
    store,
    cipher,
    reservations,
    reconciler,
    newId: u.newId,
    requestToken: u.requestToken,
    venueMode: () => u.mode.value,
    collateralAssetId: PUSD,
  };
  const opened = await OrderManager.open(deps);
  if (opened.ok) inc.manager = opened.value;
  else if (inc.alive) throw new Error(`open refused while alive: ${opened.refusal.code}`);
  return inc;
}

/**
 * Restart (repeatedly, if a kill plan is still pending in the universe it is
 * not: restarts carry no plan) and drive everything to a resolved state with
 * a truthful reconciler. Returns the final incarnation.
 */
export async function restartAndDrain(u: Universe, deliverFills: (manager: OrderManager) => Promise<void>): Promise<Incarnation> {
  const inc = await start(u, null);
  const manager = inc.manager;
  if (manager === null) throw new Error("a restart with no kill plan must open");
  u.world.nextBehavior = () => "ACCEPT_LIVE";
  // S6: every abandonment the OMS accepts is checked by the oracle.
  const abandon = async (attemptId: string, salt: string): Promise<void> => {
    const result = await manager.abandonAttempt(attemptId);
    if (result.ok) u.world.abandonAccepted(salt);
  };
  for (let round = 0; round < 12; round += 1) {
    await manager.retryReconciliationRequests();
    for (const attempt of manager.attempts()) {
      if (attempt.absentConfirmed) {
        // §9.11 step 9 after a restart (r1, OP-R1-03): resume, then resend the SAME signed order on the
        // documented restart path; abandon only if the OMS refuses that.
        if (manager.paused) manager.resume();
        const resent = await manager.retransmitSameSignedOrder(attempt.submissionAttemptId);
        if (resent.ok) u.retransmittedAfterRestart += 1;
        else await abandon(attempt.submissionAttemptId, attempt.salt);
      }
      if (attempt.state === "SIGNED") {
        if (manager.paused) manager.resume();
        // A recovered, never-transmitted signed order is sent as it is (no re-signing), or abandoned.
        if (attempt.signedPayloadAvailable) await manager.transmitSigned(attempt.submissionAttemptId);
        else await abandon(attempt.submissionAttemptId, attempt.salt);
      }
      const request = [...u.requests].reverse().find((candidate) => candidate.submissionAttemptId === attempt.submissionAttemptId);
      if (request !== undefined && attempt.currentRequestId === request.requestId) {
        const read = u.world.read(request);
        const result = await manager.applyReconciliation(read.answer);
        if (result.ok) u.world.answerAccepted(read);
      }
    }
    await deliverFills(manager);
  }
  return inc;
}
