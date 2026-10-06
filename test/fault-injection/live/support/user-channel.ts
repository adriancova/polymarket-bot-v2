/**
 * WP-340: the authenticated user channel of ONE process incarnation, bound to
 * the mock CLOB, with chaos. It implements WP-280's
 * `AuthenticatedUserSocketPort` (the port the real `createUserStreamManager`
 * reaches the venue through), so the manager, its normalizer, its
 * projections, its gap requests and its reconnects are all the real WP-280
 * code. Nothing opens a socket; no credential exists: the "auth" the port
 * would add to the subscription frame is absent, and `isAccountOwner`
 * affirms only the API-key placeholder the mock venue writes on our orders.
 *
 * TRANSPORT FACTS MODELLED (`verified-2026-09-16.md` §4, unchanged on
 * 2026-09-30 §W.4): the subscription frame is sent right after the
 * connection opens; `PING` is answered `PONG`; dynamic `subscribe` /
 * `unsubscribe` operations change the market set; nothing missed while
 * disconnected is ever replayed.
 *
 * CHAOS (the packet's "drop, reorder, duplicate and delay WP-280's
 * events, and drop the socket at the worst moments"): every frame the venue
 * publishes passes {@link ChannelChaos.policy}, which may deliver it, drop
 * it, deliver it twice, or hold it back (a later frame then overtakes it).
 * {@link MockUserChannel.dropSocket} ends the current connection with a
 * classified cause; {@link ChannelChaos.dropAfter} ends it right after a
 * chosen frame is delivered. Every frame arrives through the shared time
 * line (`setTimeout`), never synchronously inside the venue call that
 * produced it.
 *
 * TIMING IS AN ASSUMPTION (A8 in `mock-clob.ts`; report §3.2): a frame
 * reaches the process only when the time line turns, so it always trails the
 * synchronous REST answer of the request that caused it. The venue documents
 * no ordering between a REST answer and the push of the same change.
 * WP340-F1's route 3 (`findings.test.ts`) rests on this ordering; routes 1
 * and 2 do not.
 */

import type {
  AuthenticatedUserSocketPort,
  UserSocketCloseCause,
  UserSocketConnection,
  UserSocketHandlers,
} from "../../../../packages/polymarket-secure/src/user-stream/index.js";
import { OUR_OWNER } from "../../reconciliation/support/wp280.js";

import type { ClobTime, MockClob, PublishedFrame } from "./mock-clob.js";

export type ChaosVerdict = "DELIVER" | "DROP" | "DUPLICATE" | { readonly delayMs: number };

export interface ChannelChaos {
  /** Decide each published frame's fate (default: deliver). */
  policy: (frame: PublishedFrame) => ChaosVerdict;
  /** Drop the socket right after delivering a frame for which this answers true. */
  dropAfter: ((frame: PublishedFrame) => boolean) | null;
  /** The cause a chaos drop reports. */
  dropCause: UserSocketCloseCause;
}

export function deliverAll(): ChannelChaos {
  return { policy: () => "DELIVER", dropAfter: null, dropCause: "TRANSPORT_ERROR" };
}

interface Connection {
  readonly handlers: UserSocketHandlers;
  open: boolean;
  closed: boolean;
  unsubscribe: (() => void) | null;
  readonly markets: Set<string>;
}

export class MockUserChannel implements AuthenticatedUserSocketPort {
  readonly #clob: MockClob;
  readonly #time: ClobTime;
  readonly #credential: string;
  readonly #alive: () => boolean;
  readonly #connections: Connection[] = [];
  chaos: ChannelChaos;
  /** Every frame the process's manager was handed, in order (text and venue sequence). */
  readonly delivered: { readonly seq: number; readonly text: string }[] = [];
  readonly dropped: number[] = [];
  connects = 0;
  pings = 0;

  constructor(options: { readonly clob: MockClob; readonly time: ClobTime; readonly credential: string; readonly alive?: () => boolean; readonly chaos?: ChannelChaos }) {
    this.#clob = options.clob;
    this.#time = options.time;
    this.#credential = options.credential;
    this.#alive = options.alive ?? ((): boolean => true);
    this.chaos = options.chaos ?? deliverAll();
  }

  isAccountOwner(owner: string): boolean {
    return owner === OUR_OWNER;
  }

  connect(handlers: UserSocketHandlers): UserSocketConnection {
    if (!this.#alive()) throw new Error("dead incarnation");
    this.connects += 1;
    const connection: Connection = { handlers, open: false, closed: false, unsubscribe: null, markets: new Set() };
    this.#connections.push(connection);
    // The transport opens asynchronously, on the time line.
    this.#time.setTimeout(() => {
      if (connection.closed || !this.#alive()) return;
      connection.open = true;
      handlers.opened();
    }, 0);
    return {
      subscribe: (markets: readonly string[]): void => {
        this.#guard(connection);
        for (const market of markets) connection.markets.add(market);
        connection.unsubscribe?.();
        connection.unsubscribe = this.#clob.subscribe({
          credential: this.#credential,
          markets: connection.markets,
          push: (frame) => this.#route(connection, frame),
        });
      },
      updateSubscription: (operation: "subscribe" | "unsubscribe", markets: readonly string[]): void => {
        this.#guard(connection);
        for (const market of markets) {
          if (operation === "subscribe") connection.markets.add(market);
          else connection.markets.delete(market);
        }
      },
      ping: (): void => {
        this.#guard(connection);
        this.pings += 1;
        this.#time.setTimeout(() => {
          if (connection.open && !connection.closed && this.#alive()) connection.handlers.frame("PONG");
        }, 0);
      },
      close: (): void => {
        this.#end(connection, null);
      },
    };
  }

  #guard(connection: Connection): void {
    if (!this.#alive()) throw new Error("dead incarnation");
    if (connection.closed) throw new Error("the connection is closed");
  }

  #route(connection: Connection, frame: PublishedFrame): void {
    if (connection.closed) return;
    const verdict = this.chaos.policy(frame);
    if (verdict === "DROP") {
      this.dropped.push(frame.seq);
      return;
    }
    const delay = typeof verdict === "object" ? verdict.delayMs : 0;
    const copies = verdict === "DUPLICATE" ? 2 : 1;
    for (let copy = 0; copy < copies; copy += 1) {
      this.#time.setTimeout(() => {
        if (connection.closed || !connection.open || !this.#alive()) {
          this.dropped.push(frame.seq);
          return;
        }
        this.delivered.push({ seq: frame.seq, text: frame.text });
        connection.handlers.frame(frame.text);
        if (copy === copies - 1 && this.chaos.dropAfter?.(frame) === true) this.#end(connection, this.chaos.dropCause);
      }, delay);
    }
  }

  #end(connection: Connection, cause: UserSocketCloseCause | null): void {
    if (connection.closed) return;
    connection.closed = true;
    connection.open = false;
    connection.unsubscribe?.();
    connection.unsubscribe = null;
    if (cause !== null) connection.handlers.closed(cause);
  }

  /** End every open connection of this process with `cause` (the venue or the network dropped it). */
  dropSocket(cause: UserSocketCloseCause = "TRANSPORT_ERROR"): number {
    let dropped = 0;
    for (const connection of this.#connections) {
      if (connection.closed) continue;
      this.#end(connection, cause);
      dropped += 1;
    }
    return dropped;
  }

  /** A dead process's sockets: the venue sees them go, and nothing is delivered to them again. */
  sever(): void {
    for (const connection of this.#connections) {
      connection.closed = true;
      connection.open = false;
      connection.unsubscribe?.();
      connection.unsubscribe = null;
    }
  }

  /** Deliver a raw text frame the venue never documented to every open connection, on the time line. */
  inject(text: string): void {
    for (const connection of this.#connections) {
      if (!connection.open || connection.closed) continue;
      this.#time.setTimeout(() => {
        if (connection.open && !connection.closed && this.#alive()) connection.handlers.frame(text);
      }, 0);
    }
  }

  openConnections(): number {
    return this.#connections.filter((connection) => connection.open && !connection.closed).length;
  }
}
