/**
 * Offline test doubles for the Coinbase adapter's ports.
 *
 * Published as a subpath (`@polymarket-bot/coinbase-adapter/testing`) so the
 * contract suite under `test/contract/coinbase` can drive the connection manager
 * without a network, a real clock, or a real timer. Every double is fully
 * controlled by the test: time only advances when a test advances it, and a
 * frame only arrives when a test delivers it.
 *
 * These are the reason the acceptance criterion "tests run OFFLINE" is
 * structural rather than a promise: the manager takes its socket factory as a
 * constructor argument, and the test hands it one that cannot reach a network.
 */

import type {
  CoinbaseRawFrame,
  CoinbaseSocket,
  CoinbaseSocketFactory,
  CoinbaseSocketListener,
  MonotonicClock,
  Timer,
  TimerHandle,
  WallClock,
} from "../ports.js";

/** A wall clock a test steps by hand. */
export class ManualWallClock implements WallClock {
  #currentMs: number;

  constructor(startIso = "2026-08-27T00:00:00.000Z") {
    const parsed = Date.parse(startIso);
    if (Number.isNaN(parsed)) {
      throw new RangeError(`ManualWallClock needs a parseable ISO time, received "${startIso}"`);
    }
    this.#currentMs = parsed;
  }

  nowIso(): string {
    return new Date(this.#currentMs).toISOString();
  }

  advanceMs(deltaMs: number): void {
    this.#currentMs += deltaMs;
  }
}

/** A monotonic clock a test steps by hand, in nanoseconds. */
export class ManualMonotonicClock implements MonotonicClock {
  #currentNs: bigint;

  constructor(startNs = 0n) {
    this.#currentNs = startNs;
  }

  nowNs(): bigint {
    return this.#currentNs;
  }

  advanceMs(deltaMs: number): void {
    this.#currentNs += BigInt(deltaMs) * 1_000_000n;
  }

  advanceNs(deltaNs: bigint): void {
    this.#currentNs += deltaNs;
  }
}

type ScheduledTask = {
  readonly id: number;
  readonly dueAtMs: number;
  readonly run: () => void;
  cancelled: boolean;
};

/**
 * A timer whose queue a test drains explicitly.
 *
 * Deliberately not tied to a clock: a test that wants both to move together
 * calls `advanceMs` on each. Keeping them separate makes it possible to fire a
 * staleness poll at an exact simulated staleness.
 */
export class ManualTimer implements Timer {
  #nowMs = 0;
  #nextId = 0;
  #tasks: ScheduledTask[] = [];

  schedule(delayMs: number, run: () => void): TimerHandle {
    const task: ScheduledTask = {
      id: this.#nextId++,
      dueAtMs: this.#nowMs + delayMs,
      run,
      cancelled: false,
    };
    this.#tasks.push(task);
    return {
      cancel: (): void => {
        task.cancelled = true;
      },
    };
  }

  /** Tasks scheduled and not yet run or cancelled. */
  get pending(): number {
    return this.#tasks.filter((task) => !task.cancelled).length;
  }

  /**
   * Advances simulated time and runs everything that came due, oldest first.
   *
   * A task that schedules another task is honoured only if the new task also
   * comes due inside the same advance, which mirrors a real event loop and stops
   * a self-rescheduling poll from spinning forever.
   */
  advanceMs(deltaMs: number): void {
    const target = this.#nowMs + deltaMs;
    for (;;) {
      const due = this.#tasks
        .filter((task) => !task.cancelled && task.dueAtMs <= target)
        .sort((a, b) => a.dueAtMs - b.dueAtMs || a.id - b.id);
      const next = due[0];
      if (next === undefined) {
        break;
      }
      this.#tasks = this.#tasks.filter((task) => task !== next);
      this.#nowMs = next.dueAtMs;
      next.run();
    }
    this.#nowMs = target;
  }
}

/** One socket a test opened through {@link FakeCoinbaseSocketFactory}. */
export class FakeCoinbaseSocket implements CoinbaseSocket {
  readonly endpoint: string;
  readonly listener: CoinbaseSocketListener;
  /** Every frame the adapter sent, in order. Assert on it to check subscriptions. */
  readonly sent: string[] = [];
  closed = false;
  opened = false;

  constructor(endpoint: string, listener: CoinbaseSocketListener) {
    this.endpoint = endpoint;
    this.listener = listener;
  }

  send(text: string): void {
    this.sent.push(text);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.listener.onClose({ code: 1000, reason: "closed by client" });
  }

  /** Simulates the connection opening. */
  open(): void {
    this.opened = true;
    this.listener.onOpen();
  }

  /** Delivers one frame to the adapter. */
  deliver(frame: CoinbaseRawFrame): void {
    this.listener.onFrame(frame);
  }

  /** Simulates the server or the network dropping the connection. */
  dropConnection(code = 1006, reason = "abnormal closure"): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.listener.onClose({ code, reason });
  }

  /** Simulates a transport-level error, which a real socket follows with a close. */
  failWith(error: unknown): void {
    this.listener.onError(error);
  }
}

export type FakeCoinbaseSocketFactoryOptions = {
  /**
   * Report the connection open from INSIDE `connect()`, before it returns.
   *
   * A real transport may do this — an already-connected bridge, an in-process
   * mock, a client that completes its handshake during construction — and it is
   * the one timing in which the manager has no socket handle to act on yet.
   * Nothing the manager does on `onOpen` may depend on `connect()` having
   * returned, and this option is how that is testable offline.
   */
  readonly openOnConnect?: boolean;
};

/** Socket factory that opens {@link FakeCoinbaseSocket}s and reaches no network. */
export class FakeCoinbaseSocketFactory implements CoinbaseSocketFactory {
  /** Every socket ever opened, in order. */
  readonly sockets: FakeCoinbaseSocket[] = [];
  readonly #openOnConnect: boolean;

  constructor(options: FakeCoinbaseSocketFactoryOptions = {}) {
    this.#openOnConnect = options.openOnConnect ?? false;
  }

  connect(endpoint: string, listener: CoinbaseSocketListener): CoinbaseSocket {
    const socket = new FakeCoinbaseSocket(endpoint, listener);
    this.sockets.push(socket);
    if (this.#openOnConnect) {
      socket.open();
    }
    return socket;
  }

  /** The most recently opened socket. */
  get current(): FakeCoinbaseSocket {
    const socket = this.sockets.at(-1);
    if (socket === undefined) {
      throw new Error("no socket has been opened yet");
    }
    return socket;
  }
}
