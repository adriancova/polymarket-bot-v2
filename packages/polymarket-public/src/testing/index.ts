/**
 * Deterministic test doubles for every port this package depends on.
 *
 * Exported as a subpath (`@polymarket-bot/polymarket-public/testing`) so the
 * contract suite under `test/contract/polymarket-public/**` can drive a full
 * feed lifecycle with no network, no real clock, and no randomness — which is
 * what lets those tests run offline and identically on every machine.
 *
 * SAFETY: nothing here holds or accepts a credential. There is no authenticated
 * surface in this package to double.
 */

import type {
  DiscoveredMarketRegistration,
  ObservedNewMarket,
  ObservedTickSizeChange,
  PublicHttpClient,
  PublicHttpRequest,
  PublicHttpResponse,
  PublicMarketClock,
  PublicMarketDirectory,
  PublicMarketIdentity,
  PublicMarketTimers,
  PublicWebSocket,
  PublicWebSocketCloseInfo,
  PublicWebSocketFactory,
  PublicWebSocketHandlers,
  TradingParameterVersionAssignment,
} from "../ports.js";

// --------------------------------------------------------------------------
// clock and timers
// --------------------------------------------------------------------------

interface ScheduledTask {
  readonly id: number;
  readonly handler: () => void;
  readonly intervalMs: number | undefined;
  dueAtMs: number;
}

/**
 * A clock and a timer wheel driven entirely by {@link ManualScheduler.advance}.
 *
 * No real time passes, so a test can watch a feed sit idle for ten minutes and
 * go stale in under a millisecond, and the assertion is on the exact number of
 * heartbeats sent rather than on a tolerance.
 */
export class ManualScheduler {
  #wallMs: number;
  #monotonicMs = 0;
  #nextId = 1;
  readonly #tasks = new Map<number, ScheduledTask>();

  constructor(startWallMs = Date.UTC(2026, 7, 27, 12, 0, 0)) {
    this.#wallMs = startWallMs;
  }

  get clock(): PublicMarketClock {
    return {
      nowMs: () => this.#wallMs,
      monotonicMs: () => this.#monotonicMs,
    };
  }

  get timers(): PublicMarketTimers {
    return {
      setTimeout: (handler, delayMs) => this.#schedule(handler, delayMs, undefined),
      setInterval: (handler, intervalMs) => this.#schedule(handler, intervalMs, intervalMs),
    };
  }

  /** Number of live timers, so a test can assert nothing was left running. */
  get pendingTimerCount(): number {
    return this.#tasks.size;
  }

  /**
   * Advances time, firing every task that comes due, in due order.
   *
   * Tasks scheduled while advancing are honoured within the same call if they
   * come due inside the window, which is what makes a reconnect chain testable
   * in one step.
   */
  advance(ms: number): void {
    const target = this.#monotonicMs + ms;
    for (;;) {
      const next = this.#nextDue(target);
      if (next === undefined) break;
      const delta = next.dueAtMs - this.#monotonicMs;
      this.#monotonicMs += delta;
      this.#wallMs += delta;
      if (next.intervalMs === undefined) {
        this.#tasks.delete(next.id);
      } else {
        next.dueAtMs = this.#monotonicMs + next.intervalMs;
      }
      next.handler();
    }
    const remaining = target - this.#monotonicMs;
    this.#monotonicMs += remaining;
    this.#wallMs += remaining;
  }

  #nextDue(targetMs: number): ScheduledTask | undefined {
    let candidate: ScheduledTask | undefined;
    for (const task of this.#tasks.values()) {
      if (task.dueAtMs > targetMs) continue;
      if (candidate === undefined || task.dueAtMs < candidate.dueAtMs) candidate = task;
    }
    return candidate;
  }

  #schedule(handler: () => void, delayMs: number, intervalMs: number | undefined): () => void {
    const id = this.#nextId;
    this.#nextId += 1;
    this.#tasks.set(id, {
      id,
      handler,
      intervalMs,
      dueAtMs: this.#monotonicMs + delayMs,
    });
    return () => {
      this.#tasks.delete(id);
    };
  }
}

// --------------------------------------------------------------------------
// socket
// --------------------------------------------------------------------------

/** Drives one fake socket from the test's side. */
export class FakeWebSocket {
  readonly url: string;
  readonly sent: string[] = [];
  closedByClient = false;
  #open = false;
  #closed = false;
  readonly #handlers: PublicWebSocketHandlers;

  constructor(url: string, handlers: PublicWebSocketHandlers) {
    this.url = url;
    this.#handlers = handlers;
  }

  /** The socket surface the feed holds. */
  get socket(): PublicWebSocket {
    return {
      send: (data: string) => {
        this.sent.push(data);
      },
      close: () => {
        this.closedByClient = true;
        // A real socket emits `close` after `close()` is called; modelling that
        // faithfully is what exercises the feed's reentrancy on the stale path.
        this.emitClose({ code: 1000, reason: "client close" });
      },
    };
  }

  get isOpen(): boolean {
    return this.#open && !this.#closed;
  }

  /**
   * The raw callbacks the feed installed, for stale-callback tests.
   *
   * The `emit*` helpers below model a well-behaved transport: they will not
   * deliver a second close, and `emitOpen` marks the socket open. A real
   * transport is under no such obligation — it can deliver a queued frame, a
   * late error, or a second close for a socket the client has already
   * abandoned — and the feed must survive exactly that (round-1 finding H1).
   * Reaching for these is how a test plays the badly-behaved transport.
   */
  get handlers(): PublicWebSocketHandlers {
    return this.#handlers;
  }

  /** Every frame the feed sent, parsed as JSON where possible. */
  get sentFrames(): readonly unknown[] {
    return this.sent.map((raw) => {
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        return raw;
      }
    });
  }

  emitOpen(): void {
    this.#open = true;
    this.#handlers.onOpen();
  }

  emitMessage(data: string): void {
    this.#handlers.onMessage(data);
  }

  emitJson(value: unknown): void {
    this.emitMessage(JSON.stringify(value));
  }

  emitError(error: unknown): void {
    this.#handlers.onError(error);
  }

  emitClose(info: PublicWebSocketCloseInfo = {}): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#handlers.onClose(info);
  }
}

export interface FakeWebSocketFactoryOptions {
  /**
   * Runs INSIDE the factory call, before the handle is returned.
   *
   * A transport is not obliged to open asynchronously: a pooled or already-open
   * connection can call `onOpen` — or deliver a queued frame, or fail — while
   * the caller is still waiting for the socket object. `emitOpen()` from here
   * plays exactly that transport, which is what round-2 finding H1 was about:
   * the feed published `FeedConnected` and sent no subscription, because it had
   * no handle to send on yet. A test that never sets this gets the ordinary
   * asynchronous transport, which is every real one.
   */
  readonly onCreate?: (socket: FakeWebSocket) => void;
}

/** A socket factory that records every socket it creates. */
export function fakeWebSocketFactory(options: FakeWebSocketFactoryOptions = {}): {
  readonly factory: PublicWebSocketFactory;
  readonly sockets: FakeWebSocket[];
  latest(): FakeWebSocket;
} {
  const sockets: FakeWebSocket[] = [];
  const factory: PublicWebSocketFactory = (url, handlers) => {
    const fake = new FakeWebSocket(url, handlers);
    sockets.push(fake);
    options.onCreate?.(fake);
    return fake.socket;
  };
  return {
    factory,
    sockets,
    latest: () => {
      const last = sockets.at(-1);
      if (last === undefined) throw new Error("no socket has been created yet");
      return last;
    },
  };
}

/** Sequential connection ids, so a test can assert on them. */
export function sequentialConnectionIds(prefix = "conn"): () => string {
  let index = 0;
  return () => {
    index += 1;
    return `${prefix}-${String(index)}`;
  };
}

// --------------------------------------------------------------------------
// market directory
// --------------------------------------------------------------------------

/** A market the fake catalogue knows, or is willing to register. */
export interface TestMarketDefinition {
  readonly internalMarketId: string;
  readonly conditionId: string;
  readonly yesTokenId: string;
  readonly noTokenId: string;
  readonly seriesId?: string;
}

export interface StaticMarketDirectoryOptions {
  /** Markets already in the catalogue. */
  readonly known?: readonly TestMarketDefinition[];
  /** Markets the catalogue will accept when announced, keyed by condition id. */
  readonly registrable?: readonly TestMarketDefinition[];
  /** When false, every parameter-version assignment is declined. */
  readonly assignsParameterVersions?: boolean;
}

/** A fake catalogue that records what the adapter asked it. */
export interface StaticMarketDirectory extends PublicMarketDirectory {
  readonly registrations: ObservedNewMarket[];
  readonly parameterChanges: ObservedTickSizeChange[];
  /** Adds a market after construction, e.g. to simulate late discovery. */
  add(definition: TestMarketDefinition): void;
}

/** A UUIDv7-shaped identifier, deterministic in `index`. */
export function testInternalMarketId(index: number): string {
  const suffix = index.toString(16).padStart(12, "0");
  return `0199f0a0-0000-7000-8000-${suffix}`;
}

/** Builds a deterministic market definition. */
export function testMarket(index: number): TestMarketDefinition {
  const conditionSuffix = index.toString(16).padStart(2, "0");
  return {
    internalMarketId: testInternalMarketId(index),
    conditionId: `0x${"0".repeat(62)}${conditionSuffix}`,
    yesTokenId: `${String(index)}0000000000000000000000000000000000000001`,
    noTokenId: `${String(index)}0000000000000000000000000000000000000002`,
  };
}

export function staticMarketDirectory(
  options: StaticMarketDirectoryOptions = {},
): StaticMarketDirectory {
  const byToken = new Map<string, PublicMarketIdentity>();
  const registrable = new Map<string, TestMarketDefinition>();
  const registrations: ObservedNewMarket[] = [];
  const parameterChanges: ObservedTickSizeChange[] = [];
  const versions = new Map<string, number>();
  const assigns = options.assignsParameterVersions ?? true;

  const identityOf = (definition: TestMarketDefinition): PublicMarketIdentity => ({
    internalMarketId: definition.internalMarketId,
    conditionId: definition.conditionId,
    yesTokenId: definition.yesTokenId,
    noTokenId: definition.noTokenId,
  });

  const add = (definition: TestMarketDefinition): void => {
    const identity = identityOf(definition);
    byToken.set(definition.yesTokenId, identity);
    byToken.set(definition.noTokenId, identity);
  };

  for (const definition of options.known ?? []) add(definition);
  for (const definition of options.registrable ?? []) {
    registrable.set(definition.conditionId, definition);
  }

  return {
    registrations,
    parameterChanges,
    add,
    identityForToken: (tokenId) => byToken.get(tokenId),
    registerDiscoveredMarket: (
      observation: ObservedNewMarket,
    ): DiscoveredMarketRegistration | undefined => {
      registrations.push(observation);
      const definition = registrable.get(observation.conditionId);
      if (definition === undefined) return undefined;
      add(definition);
      return {
        identity: identityOf(definition),
        metadataVersion: 1,
        ...(definition.seriesId === undefined ? {} : { seriesId: definition.seriesId }),
      };
    },
    assignTradingParameterVersion: (
      change: ObservedTickSizeChange,
    ): TradingParameterVersionAssignment | undefined => {
      parameterChanges.push(change);
      if (!assigns) return undefined;
      const key = change.identity.internalMarketId;
      const previous = versions.get(key);
      const next = (previous ?? 0) + 1;
      versions.set(key, next);
      return {
        parametersVersion: next,
        ...(previous === undefined ? {} : { previousParametersVersion: previous }),
        parameterVersionRef: `${change.identity.conditionId}:params:${String(next)}`,
      };
    },
  };
}

// --------------------------------------------------------------------------
// http
// --------------------------------------------------------------------------

/** A recorded HTTP exchange. */
export interface StubHttpExchange {
  readonly request: PublicHttpRequest;
}

/** An HTTP client that answers from a routing function and records requests. */
export function stubHttpClient(
  respond: (request: PublicHttpRequest) => PublicHttpResponse | Promise<PublicHttpResponse>,
): { readonly client: PublicHttpClient; readonly exchanges: StubHttpExchange[] } {
  const exchanges: StubHttpExchange[] = [];
  const client: PublicHttpClient = async (request) => {
    exchanges.push({ request });
    return await respond(request);
  };
  return { client, exchanges };
}

/** Convenience: a client that always answers `200` with the given JSON. */
export function jsonHttpClient(value: unknown): {
  readonly client: PublicHttpClient;
  readonly exchanges: StubHttpExchange[];
} {
  return stubHttpClient(() => ({ status: 200, body: JSON.stringify(value) }));
}
