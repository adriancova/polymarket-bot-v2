/**
 * TEST SUPPORT (imported only by `*.test.ts` files, here and in
 * `test/fault-injection/live-safety/**`): a manual clock and timer queue, a
 * fake heartbeat transport that records every request and answers from a
 * script, and the WP-310 contract snapshot as a budget. Nothing here reaches a
 * network, a key or a signer: the "transport" is an in-memory queue. PAPER
 * only.
 */

import { RateLimitBudget } from "../rate-limit/budget.js";

import type { HeartbeatClock, HeartbeatEvent, HeartbeatTimers } from "./controller.js";
import type { HeartbeatRequest, OrderHeartbeatTransport } from "./protocol.js";

/** A live-SHAPED literal context: it only ever reaches fakes (the `createSecureVenueClientForTesting` convention). */
export const LIVE_SHAPED_CONTEXT = Object.freeze({ runMode: "LIVE_MICRO", maximumRunMode: "LIVE_MICRO", allowRealOrders: true });

/** 2026-10-01T00:00:00Z: inside the contract snapshot's effective period. */
export const EPOCH_START_MS = Date.UTC(2026, 9, 1, 0, 0, 0);

/**
 * The WP-310 contract snapshot (`rate-limits-2026-09-30`), which defines `clob.heartbeat` (kind `HEARTBEAT`), relative
 * to the repository root. A TEST reads it (this package's non-test sources may not import a filesystem module:
 * `source-hygiene.test.ts`) and hands the document to {@link budgetFrom}.
 */
export const CONTRACT_SNAPSHOT_PATH = "test/contract/rate-limits/fixtures/rate-limits-2026-09-30.snapshot.json";

export function budgetFrom(snapshot: unknown): RateLimitBudget {
  const created = RateLimitBudget.create([snapshot]);
  if (!created.ok) throw new Error(`the snapshot did not load: ${created.refusal.message}`);
  return created.value;
}

interface Scheduled {
  readonly at: number;
  readonly order: number;
  readonly callback: () => void;
}

/**
 * One manual time line: the monotonic clock, an epoch clock that can be stepped on its own (a wall-clock step),
 * and a timer queue on the monotonic clock.
 */
export class ManualTime implements HeartbeatClock, HeartbeatTimers {
  #monotonic: number;
  #epochOffset: number;
  #order = 0;
  readonly #queue = new Map<number, Scheduled>();
  /** A monotonic reading override (a faulty clock), consumed once. */
  #faultyReadings: number[] = [];

  constructor(startMonotonicMs = 1_000_000) {
    this.#monotonic = startMonotonicMs;
    this.#epochOffset = EPOCH_START_MS - startMonotonicMs;
  }

  monotonicMs(): number {
    const faulty = this.#faultyReadings.shift();
    return faulty ?? this.#monotonic;
  }

  epochMs(): number {
    return this.#monotonic + this.#epochOffset;
  }

  /** The current monotonic time, without consuming a faulty reading. */
  get now(): number {
    return this.#monotonic;
  }

  /** The next `monotonicMs()` reading returns `value` (e.g. a value BEHIND the clock: a step backwards). */
  injectReading(value: number): void {
    this.#faultyReadings.push(value);
  }

  /** Step the WALL clock (the epoch) by `deltaMs`; the monotonic clock is untouched. */
  stepWallClock(deltaMs: number): void {
    this.#epochOffset += deltaMs;
  }

  /** Move the monotonic clock BACKWARDS (a faulty monotonic source). */
  stepMonotonicBack(deltaMs: number): void {
    this.#monotonic -= deltaMs;
  }

  setTimeout(callback: () => void, delayMs: number): unknown {
    this.#order += 1;
    const id = this.#order;
    this.#queue.set(id, { at: this.#monotonic + delayMs, order: id, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === "number") this.#queue.delete(handle);
  }

  pendingTimers(): number {
    return this.#queue.size;
  }

  /** Fire every timer due within `ms`, earliest first, letting answers settle after each. */
  async advance(ms: number): Promise<void> {
    const target = this.#monotonic + ms;
    for (;;) {
      await settle();
      let next: [number, Scheduled] | undefined;
      for (const entry of this.#queue) {
        if (entry[1].at > target) continue;
        if (next === undefined || entry[1].at < next[1].at || (entry[1].at === next[1].at && entry[1].order < next[1].order)) next = entry;
      }
      if (next === undefined) break;
      this.#queue.delete(next[0]);
      if (next[1].at > this.#monotonic) this.#monotonic = next[1].at;
      next[1].callback();
    }
    if (target > this.#monotonic) this.#monotonic = target;
    await settle();
  }
}

/** Let every pending promise continuation run. */
export async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
}

export interface RecordedRequest {
  readonly heartbeatId: string;
  readonly atMs: number;
}

/** What the fake answers one request with: an answer now, a deferred answer, or a throw. */
export type ScriptedAnswer = { readonly answer: unknown } | { readonly defer: true } | { readonly throws: true };

export function ok(heartbeatId: string): ScriptedAnswer {
  return { answer: { kind: "RESPONSE", httpStatus: 200, body: { heartbeat_id: heartbeatId } } };
}

export function invalidId(expected: string): ScriptedAnswer {
  return { answer: { kind: "RESPONSE", httpStatus: 400, body: { error_msg: "Invalid Heartbeat ID", heartbeat_id: expected } } };
}

/**
 * The fake transport. Answers each request from `script` in order; once it is exhausted, from `fallback`
 * (default: a fresh confirmed id per request). Every request is recorded with its monotonic time.
 */
export class FakeHeartbeatTransport implements OrderHeartbeatTransport {
  readonly requests: RecordedRequest[] = [];
  readonly script: ScriptedAnswer[] = [];
  fallback: (request: HeartbeatRequest, index: number) => ScriptedAnswer = (_request, index) => ok(`sanitized-heartbeat-id-${String(1000 + index)}`);
  readonly #deferred: { resolve: (value: unknown) => void }[] = [];
  readonly #time: ManualTime;

  constructor(time: ManualTime) {
    this.#time = time;
  }

  async send(request: HeartbeatRequest): Promise<unknown> {
    const index = this.requests.length;
    this.requests.push({ heartbeatId: request.heartbeatId, atMs: this.#time.now });
    const scripted = this.script.shift() ?? this.fallback(request, index);
    if ("throws" in scripted) throw new Error("transport failure (synthetic)");
    if ("defer" in scripted) {
      return new Promise<unknown>((resolve) => {
        this.#deferred.push({ resolve });
      });
    }
    return scripted.answer;
  }

  /** Answer the oldest deferred request. */
  resolveDeferred(answer: unknown): void {
    const next = this.#deferred.shift();
    if (next === undefined) throw new Error("no deferred heartbeat request");
    next.resolve(answer);
  }

  deferredCount(): number {
    return this.#deferred.length;
  }
}

/** A gate whose answer the test sets. */
export class SwitchableGate {
  answer: unknown = { permitted: true };
  evaluations = 0;

  evaluate(): unknown {
    this.evaluations += 1;
    return this.answer;
  }
}

/** Every event, in order, and helpers to read them. */
export class EventLog {
  readonly events: HeartbeatEvent[] = [];
  readonly listener = (event: HeartbeatEvent): void => {
    this.events.push(event);
  };

  kinds(): string[] {
    return this.events.map((event) => event.kind);
  }

  of<K extends HeartbeatEvent["kind"]>(kind: K): Extract<HeartbeatEvent, { kind: K }>[] {
    return this.events.filter((event): event is Extract<HeartbeatEvent, { kind: K }> => event.kind === kind);
  }
}
