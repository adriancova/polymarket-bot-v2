/**
 * Book freshness by delivery-path liveness — `THROUGHPUT-1c`, ADR-023.
 *
 * ## The question this module answers
 *
 * "As of which instant can this process vouch for this book?" Before ADR-023
 * the answer was the instant of the book's last CHANGE (`book.asOf`), so a
 * quiet book on a busy, healthy connection read stale two seconds after its
 * last change (H1 run 1: 54% of all decisions paused on `SB.STALE_BOOK`).
 *
 * Under the basis `CONNECTION_CONFIRMED` the answer is the LATER of
 *
 * - the book's last applied update (`receivedAt`), and
 * - the `receivedAt` of the latest market-channel event this process consumed
 *   on the SAME delivery session that delivered that update — the same
 *   `(gatewayEpoch, connectionId, subscriptionGeneration)` —
 *
 * and nothing else. What that instant proves, and what it does not, is ADR-023
 * D1: it proves that the delivery path for this book's subscription (venue
 * socket → gateway → stream → this process) delivered a frame at that
 * instant; it does NOT prove that the venue had no unsent change for this
 * token (no official source states cross-asset ordering or delivery
 * completeness for the market channel; ADR-023 §2). The bound
 * (`maximum_book_age_ms`, `venueBookMaxAgeMs`) is what limits that residual,
 * exactly as it limited the same residual under the last-change rule.
 *
 * ## When the basis falls back to the last change (fail closed)
 *
 * Every one of these answers the book's own last-change instant, which is the
 * pre-ADR-023 rule and therefore never more permissive than it:
 *
 * 1. the basis is `LAST_CHANGE` (the default: an absent configuration block);
 * 2. the book's last update carried no `connectionId` or no
 *    `subscriptionGeneration` (a REST snapshot, or recorded data without the
 *    §7.1 session fields) — there is no session to be confirmed by;
 * 3. no confirmation is known for the session — never seen, or evicted from
 *    the bounded table;
 * 4. the session's GATEWAY EPOCH is TAINTED: a data-quality incident that
 *    names no market arrived from that epoch. The gateway opens exactly such
 *    incidents when it suppresses a frame's events (a WAL refusal), cannot
 *    normalize a frame, or sees a heartbeat stall, so from then on "another
 *    token's frame arrived" no longer implies "this token's frames are being
 *    delivered". The taint covers every session of the epoch, LATER ONES
 *    INCLUDED, and is never lifted: the gateway deduplicates an open incident
 *    per `(scope, reasonCode)` and closes almost none, so a repeat after a
 *    reconnect publishes nothing and a per-session taint would leave the new
 *    session looking clean while its frames are suppressed (ADR-023 D2.4). Only
 *    a new gateway epoch (a restart) starts clean;
 * 5. the market has an active data-quality incident of its own.
 *
 * A disconnection, a lost heartbeat, a gateway stall or a gateway restart
 * needs no rule of its own: each one stops the confirmations, so the book ages
 * out within its bound (ADR-023 D3).
 *
 * PURE STATE, NO CLOCK. Every instant arrives from an event's own `receivedAt`,
 * already normalised to strict UTC by `time.ts`; replay reproduces it exactly.
 */

/** ADR-023 D4: the two freshness bases a trader configuration may name. */
export const BOOK_FRESHNESS_BASES = Object.freeze(["LAST_CHANGE", "CONNECTION_CONFIRMED"] as const);
export type BookFreshnessBasis = (typeof BOOK_FRESHNESS_BASES)[number];

/** The basis an absent `bookFreshness` block selects: the pre-ADR-023 rule. */
export const DEFAULT_BOOK_FRESHNESS_BASIS: BookFreshnessBasis = "LAST_CHANGE";

/**
 * The event types whose arrival is a confirmation: exactly the market-channel
 * data events this process consumes, each derived from one frame the venue
 * socket delivered (`book`, `price_change`, `last_trade_price`). Feed-health
 * events are not frames from the venue, and an event type this process does
 * not consume never reaches here.
 */
export const CONFIRMING_EVENT_TYPES: ReadonlySet<string> = new Set([
  "BookSnapshot",
  "BookLevelChanged",
  "PublicTradeObserved",
]);

/** The only source whose market-channel sessions confirm books. */
export const CONFIRMING_SOURCE = "polymarket";

/**
 * How many delivery sessions the table remembers. A session is one
 * `(gatewayEpoch, connectionId, subscriptionGeneration)`; a healthy run has a
 * handful. Past the bound the OLDEST is forgotten, and a book on a forgotten
 * session falls back to its last change (rule 3) — the bound can only make the
 * answer stricter.
 */
export const MAXIMUM_TRACKED_SESSIONS = 1_024;

/**
 * How many tainted gateway epochs are remembered. One per gateway restart that
 * reported an incident; past the bound EVERY epoch is treated as tainted
 * (forgetting a taint would be the permissive direction).
 */
export const MAXIMUM_TAINTED_EPOCHS = 1_024;

/** One instant, in both of the forms the loop carries. */
export interface ConfirmedInstant {
  readonly iso: string;
  readonly epochMs: number;
}

/** The session fields of an envelope, as read by the loop. */
export interface SessionFields {
  readonly eventType: string;
  readonly source?: string;
  readonly gatewayEpoch: string;
  readonly connectionId?: string;
  readonly subscriptionGeneration?: number;
}

interface SessionRecord {
  latest: ConfirmedInstant;
  readonly gatewayEpoch: string;
}

/**
 * The session key of an envelope, or `undefined` when it has no session.
 *
 * `\u0000` cannot occur in any of the three fields (the §7.1 grammars), so the
 * key is injective.
 */
export function sessionKeyOf(envelope: SessionFields): string | undefined {
  if (envelope.connectionId === undefined || envelope.subscriptionGeneration === undefined) {
    return undefined;
  }
  return `${envelope.gatewayEpoch}\u0000${envelope.connectionId}\u0000${String(envelope.subscriptionGeneration)}`;
}

/**
 * Per-session confirmations and per-epoch taints. One per process; fed every
 * consumed event in stream order.
 */
export class DeliverySessionLiveness {
  readonly #sessions = new Map<string, SessionRecord>();
  readonly #taintedEpochs = new Set<string>();
  /** Set when the tainted-epoch table overflowed: every epoch is tainted. */
  #everyEpochTainted = false;

  /**
   * Records a consumed event. Only a confirming event (type, source and both
   * session fields) moves anything.
   */
  observe(envelope: SessionFields, at: ConfirmedInstant): void {
    if (!CONFIRMING_EVENT_TYPES.has(envelope.eventType)) return;
    if (envelope.source !== CONFIRMING_SOURCE) return;
    const key = sessionKeyOf(envelope);
    if (key === undefined) return;
    const existing = this.#sessions.get(key);
    if (existing !== undefined) {
      existing.latest = at;
      return;
    }
    this.#sessions.set(key, { latest: at, gatewayEpoch: envelope.gatewayEpoch });
    if (this.#sessions.size > MAXIMUM_TRACKED_SESSIONS) {
      const oldest = this.#sessions.keys().next();
      if (oldest.done !== true) this.#sessions.delete(oldest.value);
    }
  }

  /**
   * Rule 4: a data-quality incident naming no market taints its gateway
   * epoch — every session of it, known now or first seen later — for good.
   */
  taintGatewayEpoch(gatewayEpoch: string): void {
    if (this.#taintedEpochs.has(gatewayEpoch)) return;
    if (this.#taintedEpochs.size >= MAXIMUM_TAINTED_EPOCHS) {
      this.#everyEpochTainted = true;
      return;
    }
    this.#taintedEpochs.add(gatewayEpoch);
  }

  /** Whether a gateway epoch is tainted (rule 4). */
  isEpochTainted(gatewayEpoch: string): boolean {
    return this.#everyEpochTainted || this.#taintedEpochs.has(gatewayEpoch);
  }

  /** The latest confirmation of a session whose epoch is untainted, if any. */
  confirmation(sessionKey: string): ConfirmedInstant | undefined {
    const record = this.#sessions.get(sessionKey);
    if (record === undefined || this.isEpochTainted(record.gatewayEpoch)) return undefined;
    return record.latest;
  }

  /** How many sessions are remembered (diagnostics and tests). */
  get size(): number {
    return this.#sessions.size;
  }
}

/**
 * The instant a book is vouched for, under a basis. `lastChange` is the book's
 * own last applied update; `undefined` when the book has none (the caller
 * keeps its existing fallback).
 */
export function bookConfirmedAt(input: {
  readonly basis: BookFreshnessBasis;
  readonly lastChange: ConfirmedInstant | undefined;
  readonly sessionKey: string | undefined;
  readonly marketHasActiveIncident: boolean;
  readonly liveness: DeliverySessionLiveness;
}): ConfirmedInstant | undefined {
  const { lastChange } = input;
  if (lastChange === undefined) return undefined;
  if (input.basis !== "CONNECTION_CONFIRMED") return lastChange;
  if (input.marketHasActiveIncident) return lastChange;
  if (input.sessionKey === undefined) return lastChange;
  const confirmed = input.liveness.confirmation(input.sessionKey);
  if (confirmed === undefined) return lastChange;
  // The later of the two. A confirmation recorded under a clock that stepped
  // backwards cannot move the answer before the book's own update.
  return confirmed.epochMs > lastChange.epochMs ? confirmed : lastChange;
}
