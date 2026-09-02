/**
 * Deterministic test doubles for the gateway's own ports.
 *
 * Dev-only, following the `./testing` convention every upstream package uses.
 * Nothing here is exported from the package barrel; the colocated unit tests
 * and `test/integration/data-gateway/**` import it directly (the integration
 * runner aliases `@polymarket-bot/data-gateway/testing` to this file).
 */

import type {
  CancelScheduled,
  GatewayClock,
  GatewayIdSource,
  GatewayTimers,
} from "../ports.js";
import { uuidV7At } from "../system.js";

export { MemoryEventTransport } from "./memory-transport.js";
export {
  createObservingWalFileSystem,
  type FileSystemObservations,
  type ObservingWalFileSystem,
} from "./observing-file-system.js";

/** A clock the test moves by hand. Monotonic ns derives from the same steps. */
export class ManualGatewayClock implements GatewayClock {
  #nowMs: number;
  #monotonicNs: bigint;

  constructor(startMs = 1_760_000_000_000) {
    this.#nowMs = startMs;
    this.#monotonicNs = BigInt(startMs) * 1_000_000n;
  }

  nowMs(): number {
    return this.#nowMs;
  }

  monotonicNs(): bigint {
    return this.#monotonicNs;
  }

  advance(milliseconds: number): void {
    this.#nowMs += milliseconds;
    this.#monotonicNs += BigInt(milliseconds) * 1_000_000n;
  }
}

/**
 * Deterministic ids: sequential UUIDs and clock-derived UUIDv7 event ids.
 *
 * `seed` distinguishes one *process lifetime* from another, so a test that
 * models a restart gets a genuinely different `gatewayEpoch` — which is what a
 * real restart produces (§7.1) — while staying reproducible.
 */
export function deterministicIdSource(seed = 0): GatewayIdSource {
  let uuidCounter = seed * 0x1000;
  let eventCounter = 0;
  return {
    newUuid: () => {
      uuidCounter += 1;
      return `00000000-0000-4000-8000-${uuidCounter.toString(16).padStart(12, "0")}`;
    },
    newEventId: (atMs: number) => {
      eventCounter += 1;
      const counter = eventCounter;
      let cursor = 0;
      return uuidV7At(atMs, () => {
        cursor += 1;
        return (counter * 31 + cursor * 7) % 256;
      });
    },
  };
}

interface ScheduledTask {
  readonly id: number;
  readonly dueAtMs: number;
  readonly run: () => void;
  readonly interval: number | undefined;
}

/**
 * Timers driven by an attached {@link ManualGatewayClock}: `advance()` fires
 * everything due, in due order.
 */
export class ManualGatewayTimers implements GatewayTimers {
  readonly #clock: ManualGatewayClock;
  #tasks: ScheduledTask[] = [];
  #nextId = 1;

  constructor(clock: ManualGatewayClock) {
    this.#clock = clock;
  }

  setTimeout(handler: () => void, delayMs: number): CancelScheduled {
    const id = this.#nextId;
    this.#nextId += 1;
    this.#tasks.push({
      id,
      dueAtMs: this.#clock.nowMs() + Math.max(0, delayMs),
      run: handler,
      interval: undefined,
    });
    return () => {
      this.#tasks = this.#tasks.filter((task) => task.id !== id);
    };
  }

  setInterval(handler: () => void, intervalMs: number): CancelScheduled {
    const id = this.#nextId;
    this.#nextId += 1;
    this.#tasks.push({
      id,
      dueAtMs: this.#clock.nowMs() + Math.max(1, intervalMs),
      run: handler,
      interval: Math.max(1, intervalMs),
    });
    return () => {
      this.#tasks = this.#tasks.filter((task) => task.id !== id);
    };
  }

  /** Advances the clock and fires everything that came due, in order. */
  advance(milliseconds: number): void {
    const target = this.#clock.nowMs() + milliseconds;
    for (;;) {
      const due = this.#tasks
        .filter((task) => task.dueAtMs <= target)
        .sort((a, b) => a.dueAtMs - b.dueAtMs)[0];
      if (due === undefined) break;
      // Move the clock to the task's due time so handlers observe it.
      const step = due.dueAtMs - this.#clock.nowMs();
      if (step > 0) this.#clock.advance(step);
      if (due.interval === undefined) {
        this.#tasks = this.#tasks.filter((task) => task.id !== due.id);
      } else {
        this.#tasks = this.#tasks.map((task) =>
          task.id === due.id ? { ...task, dueAtMs: due.dueAtMs + due.interval! } : task,
        );
      }
      due.run();
    }
    const remainder = target - this.#clock.nowMs();
    if (remainder > 0) this.#clock.advance(remainder);
  }

  get pendingTasks(): number {
    return this.#tasks.length;
  }
}
