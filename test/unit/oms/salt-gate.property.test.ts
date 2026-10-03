/**
 * WP-270 acceptance 2, as a seeded interleaving property with an INDEPENDENT
 * oracle (`support/world.ts`): "New salt is not created before authoritative
 * reconciliation", for every path that could re-sign, under interleavings.
 *
 * The generator interleaves, across two execution groups:
 * - submissions (single and batched) whose transmissions end in any of the
 *   port's outcomes: accepted live or delayed, rejected, a post-only refusal,
 *   not sent, every unknown kind (timeout, socket, 401, 425, 429, `unmatched`,
 *   a throw), or a HANG that stays travelling until the world settles it;
 * - watchdog timeouts on hung transmissions, and their late answers;
 * - reconciliation reads made at one moment and delivered later, out of
 *   order, for current, superseded or dead incarnations' requests; and
 *   UNRESOLVED answers;
 * - retransmissions of the same signed order, abandonments, transmissions of
 *   recovered SIGNED attempts, cancels, venue-side matches and late fill
 *   deliveries, venue-mode changes, resumes;
 * - the same calls (abandon, retransmit, transmit a SIGNED attempt, declare a
 *   transmission lost) aimed at ANY attempt, eligible or not, so that the
 *   oracle, not the OMS's own view, judges every one the OMS accepts (r1,
 *   OP-R1-01);
 * - process crashes between operations AND inside a store transaction, each
 *   followed by a restart through the store port.
 *
 * After every step the oracle's S1-S3, S5 and S6 must hold; at the end S4 (never
 * forgotten), and a truthful drain resolves every attempt (liveness). Each
 * failure reproduces from its seed, and a failing seed prints its step trace
 * and final state.
 */

import { describe, expect, it } from "vitest";

import {
  OrderManager,
  type OmsStore,
  type OrderManagerDependencies,
  type ReconciliationRequest,
  type StoreWrite,
  type VenueMode,
} from "../../../packages/oms/src/index.js";

import { restoreFakeSignedOrder } from "./support/fake-venue.js";
import { NO, PUSD, YES, group, realInventory, ticket } from "./support/harness.js";
import { idSource, tokenSource } from "./support/ids.js";
import { MemoryStore } from "./support/memory-store.js";
import { MockCipher } from "./support/mock-cipher.js";
import { BEHAVIORS, SimWorld, type Behavior, type ReadAnswer } from "./support/world.js";

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Incarnation {
  alive: boolean;
  manager: OrderManager;
}

const GROUPS = [group(9001, { tokenId: YES, plannedShares: "1000" }), group(9002, { tokenId: NO, plannedShares: "1000" })];

async function flush(): Promise<void> {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
}

async function runSeed(seed: number, steps: number): Promise<{ violations: readonly string[]; stats: Record<string, number> }> {
  const random = prng(seed);
  const pick = <T,>(items: readonly T[]): T | undefined => (items.length === 0 ? undefined : items[Math.floor(random() * items.length)]);
  const stats: Record<string, number> = {};
  const trace: string[] = [];
  const count = (key: string): void => {
    stats[key] = (stats[key] ?? 0) + 1;
    trace.push(key);
  };
  const world = new SimWorld();
  world.groupOfToken.set(YES, GROUPS[0]?.executionGroupId as string);
  world.groupOfToken.set(NO, GROUPS[1]?.executionGroupId as string);
  world.nextBehavior = () => {
    const roll = random();
    // Weighted toward the restart path (425: the only one with a retransmission) and toward hangs.
    const behavior: Behavior = roll < 0.25 ? "ACCEPT_LIVE" : roll < 0.4 ? "UNKNOWN_425" : roll < 0.47 ? "HANG" : (pick(BEHAVIORS) as Behavior);
    count(`behavior:${behavior}`);
    return behavior;
  };
  world.existsOnUnknown = () => random() < 0.5;
  const store = new MemoryStore();
  const cipher = new MockCipher();
  const inventory = realInventory({ pusd: "1000000", yes: "0" });
  const newId = idSource(0x7);
  const requestToken = tokenSource(`s${String(seed)}`);
  const requests: ReconciliationRequest[] = [];
  const queued: ReadAnswer[] = [];
  const fills: { salt: string; shares: string; venueOrderId: string; id: string }[] = [];
  const pending: Promise<unknown>[] = [];
  const mode: { value: VenueMode } = { value: "NORMAL" };
  const deliveredFills = new Set<string>();
  const deliveredCenti = new Map<string, number>();
  let killAtNextWrite = false;
  let fillCounter = 0;
  let ticketCounter = 0;

  const incarnate = async (): Promise<Incarnation> => {
    const inc = { alive: true } as Incarnation;
    const guard = (): void => {
      if (!inc.alive) throw new Error("dead incarnation");
    };
    const storePort: OmsStore = {
      apply: async (writes: readonly StoreWrite[]) => {
        guard();
        if (killAtNextWrite) {
          killAtNextWrite = false;
          inc.alive = false;
          // Half the time the transaction commits before the process dies (an ambiguous commit).
          if (random() < 0.5) await store.apply(writes);
          throw new Error("killed inside a transaction");
        }
        return store.apply(writes);
      },
      load: async () => {
        guard();
        return store.load();
      },
    };
    const venue = world.venuePort(() => inc.alive);
    const deps: OrderManagerDependencies = {
      venue: {
        ...venue,
        // The venue mode can change while an order is being signed (WP-310's detector runs independently):
        // the signed order is then held back, SIGNED, until it is transmitted or abandoned.
        createLimitOrder: async (request) => {
          const outcome = await venue.createLimitOrder(request);
          if (random() < 0.08) {
            mode.value = "TRADING_UNAVAILABLE";
            count("modeFlipDuringSigning");
          }
          return outcome;
        },
      },
      restoreSignedOrder: restoreFakeSignedOrder,
      store: storePort,
      cipher: {
        encrypt: async (text) => {
          guard();
          return cipher.encrypt(text);
        },
        decrypt: async (payload) => {
          guard();
          return cipher.decrypt(payload);
        },
      },
      reservations: {
        reserve: async (input) => {
          guard();
          return inventory.service.reserve(input);
        },
        consume: async (input) => {
          guard();
          return inventory.service.consume(input);
        },
        release: async (input) => {
          guard();
          return inventory.service.release(input);
        },
      },
      reconciler: {
        request: (request) => {
          guard();
          requests.push(request);
        },
      },
      newId,
      requestToken,
      venueMode: () => mode.value,
      collateralAssetId: PUSD,
    };
    const opened = await OrderManager.open(deps);
    if (!opened.ok) {
      // Killed during startup recovery: start again from whatever was committed.
      if (!inc.alive) {
        count("killedDuringRecovery");
        return incarnate();
      }
      throw new Error(`seed ${String(seed)}: open refused ${opened.refusal.code}`);
    }
    inc.manager = opened.value;
    return inc;
  };

  let inc = await incarnate();
  for (const g of GROUPS) await inc.manager.registerGroup(g);

  const restart = async (): Promise<void> => {
    inc.alive = false;
    for (const hang of world.hangs) hang.live = false;
    inc = await incarnate();
    count("restart");
  };

  // S6: every abandonment the OMS accepts is reported to the oracle (also one inside a killed transaction,
  // which may have committed). The oracle decides from what the harness caused, not from the OMS's view.
  const abandon = async (m: OrderManager, attemptId: string, salt: string, label: string): Promise<void> => {
    const result = await m.abandonAttempt(attemptId);
    if (result.ok || !inc.alive) world.abandonAccepted(salt);
    count(result.ok ? label : `${label}:${result.refusal.code}`);
  };

  const newTicket = (index: number) => {
    ticketCounter += 1;
    return ticket(GROUPS[index] as (typeof GROUPS)[number], { n: 100_000 + seed * 1000 + ticketCounter, shares: "1" });
  };

  for (let step = 0; step < steps; step += 1) {
    if (!inc.alive || inc.manager.faulted) await restart();
    const m = inc.manager;
    const roll = random();
    if (roll < 0.2) {
      count("submit");
      const op = m.submit(newTicket(random() < 0.5 ? 0 : 1));
      pending.push(op);
      await flush();
    } else if (roll < 0.25) {
      count("batch");
      pending.push(m.submitBatch([newTicket(0), newTicket(1)]));
      await flush();
    } else if (roll < 0.4) {
      // Read now (truthfully), deliver now or later.
      const request = random() < 0.7 ? requests.at(-1 - Math.floor(random() * Math.min(3, requests.length))) : pick(requests);
      if (request !== undefined) {
        const read = world.read(request);
        if (random() < 0.5) queued.push(read);
        else {
          const result = await m.applyReconciliation(read.answer);
          // An answer delivered into a call that died inside a store transaction may have been applied
          // durably (an ambiguous commit): it counts, but still only if its read was fresh.
          if (result.ok || !inc.alive) world.answerAccepted(read);
          count(result.ok ? "answer:accepted" : `answer:${result.refusal.code}`);
        }
      }
    } else if (roll < 0.5) {
      const index = Math.floor(random() * queued.length);
      const read = queued[index];
      if (read !== undefined) {
        queued.splice(index, 1);
        const result = await m.applyReconciliation(read.answer);
        if (result.ok || !inc.alive) world.answerAccepted(read);
        count(result.ok ? "queued:accepted" : `queued:${result.refusal.code}`);
      }
    } else if (roll < 0.53) {
      const request = pick(requests);
      if (request !== undefined) await m.applyReconciliation({ requestId: request.requestId, submissionAttemptId: request.submissionAttemptId, verdict: "UNRESOLVED" });
    } else if (roll < 0.6) {
      if (world.hangs.length > 0) {
        count("settle");
        world.settleHang(Math.floor(random() * world.hangs.length), random() < 0.7);
        await flush();
      }
    } else if (roll < 0.64) {
      // Usually a transmission in flight; sometimes ANY attempt (the OMS must refuse the others).
      const any = random() < 0.3;
      const flying = any ? m.attempts() : m.attempts().filter((attempt) => attempt.inFlight && attempt.state === "SENDING");
      const target = pick(flying);
      if (target !== undefined) {
        const result = await m.declareTransmissionLost(target.submissionAttemptId);
        count(any ? `declareLostAny:${result.ok ? "ok" : result.refusal.code}` : "declareLost");
      }
    } else if (roll < 0.69) {
      // Usually an attempt the OMS reports held absent; sometimes ANY attempt, eligible or not.
      const any = random() < 0.35;
      const held = any ? m.attempts() : m.attempts().filter((attempt) => attempt.absentConfirmed);
      const target = pick(held);
      if (target !== undefined) {
        if (random() < 0.6) {
          count(any ? "retransmitAny" : "retransmit");
          const op = m.retransmitSameSignedOrder(target.submissionAttemptId);
          if (any) void op.then((result) => count(`retransmitAny:${result.ok ? "ok" : result.refusal.code}`));
          pending.push(op);
          await flush();
        } else {
          await abandon(m, target.submissionAttemptId, target.salt, any ? "abandonAny" : "abandonAbsent");
        }
      }
    } else if (roll < 0.72) {
      // Usually a SIGNED attempt; sometimes ANY attempt, eligible or not.
      const any = random() < 0.35;
      const signed = any ? m.attempts() : m.attempts().filter((attempt) => attempt.state === "SIGNED");
      const target = pick(signed);
      if (target !== undefined) {
        if (random() < 0.5) {
          count(any ? "transmitAny" : "transmitSigned");
          const op = m.transmitSigned(target.submissionAttemptId);
          if (any) void op.then((result) => count(`transmitAny:${result.ok ? "ok" : result.refusal.code}`));
          pending.push(op);
          await flush();
        } else {
          await abandon(m, target.submissionAttemptId, target.salt, any ? "abandonAny" : "abandonSigned");
        }
      }
    } else if (roll < 0.78) {
      const open = m.orders().filter((order) => order.venueOrderId !== null && ["LIVE", "DELAYED", "PARTIALLY_FILLED", "ACKNOWLEDGED", "RECONCILING"].includes(order.state));
      const target = pick(open);
      if (target !== undefined) {
        count("cancel");
        await m.requestCancel(target.orderId);
      }
    } else if (roll < 0.84) {
      const live = [...world.orders.values()].filter((order) => order.status === "LIVE" && order.matched < order.original);
      const target = pick(live);
      if (target !== undefined) {
        const matched = world.match(target.salt, 1 + Math.floor(random() * 100));
        if (matched !== undefined) {
          fillCounter += 1;
          fills.push({ salt: target.salt, shares: matched.shares, venueOrderId: matched.venueOrderId, id: `f${String(seed)}-${String(fillCounter)}` });
        }
      }
    } else if (roll < 0.9) {
      const index = Math.floor(random() * fills.length);
      const fill = fills[index];
      if (fill !== undefined) {
        const result = await m.recordFill({
          venueTradeId: fill.id,
          venueOrderId: fill.venueOrderId,
          shares: fill.shares,
          price: "0.5",
          liquidityRole: "MAKER",
          matchedAt: "2026-10-03T00:00:00Z",
        });
        // An undeliverable fill (its order not yet identified) stays queued for later. A fill delivered into a
        // call that died inside a store transaction may have been applied (an ambiguous commit): it counts once,
        // and stays queued so its redelivery is deduplicated.
        if (result.ok || !inc.alive) {
          if (result.ok) fills.splice(index, 1);
          if (!deliveredFills.has(fill.id)) {
            deliveredFills.add(fill.id);
            deliveredCenti.set(fill.salt, (deliveredCenti.get(fill.salt) ?? 0) + Math.round(Number(fill.shares) * 100));
          }
          if ((deliveredCenti.get(fill.salt) ?? 0) >= 100) world.filledAccepted(fill.salt);
        }
        count(result.ok ? "fill:accepted" : `fill:${result.refusal.code}`);
      }
    } else if (roll < 0.93) {
      mode.value = random() < 0.8 ? "NORMAL" : random() < 0.5 ? "POST_ONLY" : "TRADING_UNAVAILABLE";
    } else if (roll < 0.95) {
      m.resume();
    } else if (roll < 0.98) {
      await restart();
    } else {
      count("killInsideWrite");
      killAtNextWrite = true;
      // Sometimes the kill lands inside the next startup's recovery writes.
      if (random() < 0.4) await restart();
    }
    await flush();
    if (world.violations.length > 0) {
      // A failing seed prints its own step trace and final state (no switch: it fails the test anyway).
      console.log(`seed ${String(seed)} trace:\n${trace.join("\n")}`);
      console.log(JSON.stringify([...world.ledger.values()], null, 1));
      console.log(JSON.stringify(inc.manager.attempts(), null, 1));
      return { violations: world.violations, stats };
    }
  }

  // Drain: settle every travelling transmission, restart once, then answer truthfully until nothing is unresolved.
  killAtNextWrite = false;
  mode.value = "NORMAL";
  while (world.hangs.length > 0) world.settleHang(0, true);
  await flush();
  await restart();
  for (let round = 0; round < 12; round += 1) {
    const m = inc.manager;
    await m.retryReconciliationRequests();
    for (const attempt of m.attempts()) {
      if (attempt.absentConfirmed) await abandon(m, attempt.submissionAttemptId, attempt.salt, "drainAbandon");
      if (attempt.state === "SIGNED") await abandon(m, attempt.submissionAttemptId, attempt.salt, "drainAbandon");
      const request = [...requests].reverse().find((candidate) => candidate.submissionAttemptId === attempt.submissionAttemptId);
      if (request !== undefined && attempt.currentRequestId === request.requestId) {
        const read = world.read(request);
        const result = await m.applyReconciliation(read.answer);
        if (result.ok) world.answerAccepted(read);
      }
    }
    for (const fill of [...fills]) {
      const result = await m.recordFill({ venueTradeId: fill.id, venueOrderId: fill.venueOrderId, shares: fill.shares, price: "0.5", liquidityRole: "MAKER", matchedAt: "2026-10-03T00:00:00Z" });
      if (result.ok) fills.splice(fills.indexOf(fill), 1);
    }
    await flush();
  }
  world.checkNeverForgotten(new Set(inc.manager.attempts().map((attempt) => attempt.salt)));
  const unresolved = inc.manager.attempts().filter((attempt) => ["SENDING", "SUBMISSION_UNKNOWN", "RECONCILING"].includes(attempt.state));
  if (unresolved.length > 0) world.fail(`liveness: ${String(unresolved.length)} attempts still unresolved after a truthful drain`);
  const transient = inc.manager.orders().filter((order) => ["PLANNED", "SIGNED", "SENDING", "SUBMISSION_UNKNOWN", "RECONCILING", "CANCEL_PENDING"].includes(order.state));
  if (transient.length > 0) world.fail(`liveness: orders left transient after a truthful drain: ${transient.map((order) => order.state).join(",")}`);
  void pending;
  return { violations: world.violations, stats };
}

describe("acceptance 2: no new salt before authoritative reconciliation (seeded interleavings, independent oracle)", () => {
  it("holds for 500 seeds x 90 steps, with every path exercised", async () => {
    const totals: Record<string, number> = {};
    for (let seed = 1; seed <= 500; seed += 1) {
      const { violations, stats } = await runSeed(seed, 90);
      expect(violations, `seed ${String(seed)}`).toEqual([]);
      for (const [key, value] of Object.entries(stats)) totals[key] = (totals[key] ?? 0) + value;
    }
    console.log(`salt-gate property totals: ${JSON.stringify(totals)}`);
    // Non-vacuity: every path the property claims to cover was actually taken.
    for (const key of [
      "submit",
      "batch",
      "restart",
      "killInsideWrite",
      "settle",
      "declareLost",
      "retransmit",
      "abandonAbsent",
      "transmitSigned",
      "abandonSigned",
      // r1 (OP-R1-01): calls aimed at ineligible attempts were made and refused, so the oracle judged the rest.
      "abandonAny:OMS_ILLEGAL_TRANSITION",
      "retransmitAny:OMS_RETRANSMIT_NOT_SUPPORTED",
      "transmitAny:OMS_ILLEGAL_TRANSITION",
      "declareLostAny:OMS_ILLEGAL_TRANSITION",
      "modeFlipDuringSigning",
      "killedDuringRecovery",
      "answer:OMS_RECONCILIATION_NOT_QUIESCENT",
      "answer:OMS_RECONCILIATION_IN_FLIGHT",
      "fill:OMS_STORE_WRITE_FAILED",
      "cancel",
      "fill:accepted",
      "answer:accepted",
      "queued:accepted",
      "queued:OMS_RECONCILIATION_SUPERSEDED",
      "answer:OMS_RECONCILIATION_UNBOUND",
      ...BEHAVIORS.map((behavior) => `behavior:${behavior}`),
    ]) {
      expect(totals[key] ?? 0, key).toBeGreaterThan(0);
    }
  }, 120_000);
});
