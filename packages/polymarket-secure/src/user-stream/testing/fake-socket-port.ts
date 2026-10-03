/**
 * TEST-ONLY doubles for the user stream (WP-280): a scripted authenticated-
 * socket port and a manual clock. Nothing here opens a socket, holds a
 * credential, or reads a clock: frames are delivered by the test, from
 * offline fixtures, and time moves only when the test advances it.
 *
 * Not exported from any package entry point; imported only by test files
 * (`user-stream/test-only-imports.test.ts` enforces it).
 */

import type { UserStreamTimers } from "../manager.js";
import type { AuthenticatedUserSocketPort, UserSocketCloseCause, UserSocketConnection, UserSocketHandlers } from "../socket-port.js";

export type SentFrame =
  | { readonly kind: "subscribe"; readonly markets: readonly string[] }
  | { readonly kind: "update"; readonly operation: "subscribe" | "unsubscribe"; readonly markets: readonly string[] }
  | { readonly kind: "ping" };

export class FakeUserSocketConnection implements UserSocketConnection {
  readonly sent: SentFrame[] = [];
  closeCalls = 0;
  /** Make the next call of this method throw. */
  failNext: "subscribe" | "update" | "ping" | "close" | null = null;

  constructor(readonly handlers: UserSocketHandlers) {}

  #maybeFail(kind: "subscribe" | "update" | "ping" | "close"): void {
    if (this.failNext === kind) {
      this.failNext = null;
      throw new Error(`fake ${kind} failure`);
    }
  }

  subscribe(markets: readonly string[]): void {
    this.#maybeFail("subscribe");
    // Exactly what the manager handed over: nothing but condition ids.
    this.sent.push({ kind: "subscribe", markets: [...markets] });
  }

  updateSubscription(operation: "subscribe" | "unsubscribe", markets: readonly string[]): void {
    this.#maybeFail("update");
    this.sent.push({ kind: "update", operation, markets: [...markets] });
  }

  ping(): void {
    this.#maybeFail("ping");
    this.sent.push({ kind: "ping" });
  }

  close(): void {
    this.closeCalls += 1;
    this.#maybeFail("close");
  }

  // -- driven by the test ------------------------------------------------------

  open(): void {
    this.handlers.opened();
  }

  deliver(text: string): void {
    this.handlers.frame(text);
  }

  drop(cause: UserSocketCloseCause): void {
    this.handlers.closed(cause);
  }
}

export interface FakeUserSocketPortOptions {
  /** The owner the fake "authenticates" as; `null` makes every maker leg OTHER. Omit `isAccountOwner` entirely with `ownerCheck: false`. */
  readonly accountOwner?: string | null;
  readonly ownerCheck?: boolean;
}

export class FakeUserSocketPort implements AuthenticatedUserSocketPort {
  readonly connections: FakeUserSocketConnection[] = [];
  connectCalls = 0;
  /** Make the next `connect` throw. */
  failNextConnect = false;
  /** Called inside `connect`, before it returns (to test synchronous handler calls). */
  duringConnect: ((connection: FakeUserSocketConnection) => void) | null = null;
  readonly isAccountOwner?: (owner: string) => boolean;

  constructor(options: FakeUserSocketPortOptions = {}) {
    if (options.ownerCheck !== false) {
      const owner = options.accountOwner ?? null;
      this.isAccountOwner = (candidate: string): boolean => owner !== null && candidate === owner;
    }
  }

  connect(handlers: UserSocketHandlers): UserSocketConnection {
    this.connectCalls += 1;
    if (this.failNextConnect) {
      this.failNextConnect = false;
      throw new Error("fake connect failure");
    }
    const connection = new FakeUserSocketConnection(handlers);
    this.connections.push(connection);
    this.duringConnect?.(connection);
    return connection;
  }

  get latest(): FakeUserSocketConnection {
    const connection = this.connections.at(-1);
    if (connection === undefined) throw new Error("no connection yet");
    return connection;
  }
}

interface Scheduled {
  readonly at: number;
  readonly order: number;
  readonly callback: () => void;
}

/** A manual clock: timers fire only inside {@link ManualTimers.advance}, in due order. */
export class ManualTimers implements UserStreamTimers {
  #now: number;
  #order = 0;
  readonly #queue = new Map<number, Scheduled>();

  constructor(startMs = Date.UTC(2026, 9, 3, 12, 0, 0)) {
    this.#now = startMs;
  }

  now(): number {
    return this.#now;
  }

  setTimeout(callback: () => void, delayMs: number): unknown {
    this.#order += 1;
    const id = this.#order;
    this.#queue.set(id, { at: this.#now + delayMs, order: id, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === "number") this.#queue.delete(handle);
  }

  pendingCount(): number {
    return this.#queue.size;
  }

  /** Move time forward by `ms`, firing every timer that falls due, earliest first. */
  advance(ms: number): void {
    const target = this.#now + ms;
    for (;;) {
      let next: [number, Scheduled] | undefined;
      for (const entry of this.#queue) {
        if (entry[1].at > target) continue;
        if (next === undefined || entry[1].at < next[1].at || (entry[1].at === next[1].at && entry[1].order < next[1].order)) next = entry;
      }
      if (next === undefined) break;
      this.#queue.delete(next[0]);
      this.#now = next[1].at;
      next[1].callback();
    }
    this.#now = target;
  }
}
