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
 * completeness for the market channel; ADR-023 §2). That residual is limited
 * by the per-book ceiling `maximumLastChangeAgeMs` (rule 6 below): the
 * extension never vouches for a book whose own last change is older than it.
 * The ordinary bound (`maximum_book_age_ms`, `venueBookMaxAgeMs`) still
 * judges the confirmed age.
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
 *    normalize a frame, refuses one of a frame's envelopes (review round 6,
 *    R6-H1: reported ahead of the frame's accepted events), is about to
 *    publish a frame too large for one transport call (review round 7,
 *    R7-H1: `GATEWAY_FRAME_SPLIT`, ahead of the frame), or sees a
 *    heartbeat stall, so from then on "another token's frame arrived" no
 *    longer implies "this token's frames are being delivered". The taint covers every session of the epoch, LATER ONES
 *    INCLUDED, and is never lifted: the gateway deduplicates an open incident
 *    per `(scope, reasonCode)` and closes almost none, so a repeat after a
 *    reconnect publishes nothing and a per-session taint would leave the new
 *    session looking clean while its frames are suppressed (ADR-023 D2.4). Only
 *    a new gateway epoch (a restart) starts clean. "Never lifted" is WITHIN
 *    THIS PROCESS: a process that starts or restarts inside an epoch whose
 *    incident it did not consume cannot know of the taint (an accepted gap,
 *    ADR-023 D2.4, r1 finding X2), and rule 6's ceiling is what bounds it;
 * 5. the market has an active data-quality incident of its own;
 * 6. the book's OWN last change is older than the configured ceiling
 *    `maximumLastChangeAgeMs` (review round 1, finding X1). Session traffic
 *    proves the session delivers; it never proves that THIS asset's changes
 *    are being delivered (no documented cross-asset ordering or completeness,
 *    ADR-023 §2 N-A/N-B). Without a ceiling, a book whose own delivery
 *    stalled read fresh for as long as sibling assets kept the session busy;
 *    with it, that exposure is at most the ceiling, per book.
 *
 * A disconnection, a lost heartbeat, a gateway stall or a gateway restart
 * needs no rule of its own: each one stops the confirmations, so the book ages
 * out within its bound (ADR-023 D3).
 *
 * ## A confirmation counts only from a frame proven WHOLE (review round 8)
 *
 * Rounds 6, 7 and 8 each found a new place where one venue frame could be
 * cut so that its delivered PREFIX confirmed the session while a change in
 * its lost or unread TAIL was not applied: an envelope refused mid-frame
 * (R6-H1), a frame published across two transport calls with an outage
 * between them (R7-H1), and a frame the trader's feed hands out across two
 * polls (R8-H1: `RedisMarketEventFeed` reads at most `receiveBatchSize`
 * events, and the loop closes a frame at the end of what one drain was
 * handed). Each was closed where it happened, and the next round found
 * another. So the rule is now enforced HERE, at the consumer, whatever any
 * upstream boundary does ({@link FrameCompletionGate}):
 *
 * > No evaluation takes a confirmation from a frame this process has not
 * > PROVEN whole. A frame is proven whole when this process has PROCESSED an
 * > event of the SAME gateway epoch that belongs to ANOTHER frame after it.
 * > Until then the frame's confirmations are held back, never used, and a
 * > frame that is never followed is never used at all (fail closed).
 *
 * Why a later event of the same epoch proves the earlier frame whole, and
 * why nothing weaker is trusted (ADR-023 D2.4, r8):
 *
 * - the gateway submits all of one frame's envelopes CONSECUTIVELY: one
 *   socket message is one synchronous `dispatchFrame` call into ONE FIFO
 *   publisher queue, and the publisher submits in queue order
 *   (`apps/data-gateway/src/publisher.ts`, "Submission order is assignment
 *   order");
 * - EVERY unsuccessful submission halts the epoch's publication for good
 *   ("Every unsuccessful submission halts": no later identity of the epoch
 *   is ever published after a rejection, an outage or an overflow), and a
 *   loss the gateway survives (a WAL refusal, a normalization problem, a
 *   refused envelope, a frame too large for one call) is published as a
 *   no-market incident AHEAD of the frame, which taints the epoch (rule 4);
 * - the stream is read in order and without gaps: a retention gap is a hard
 *   resync, which halts the trader (`apps/trader/src/pump.ts`).
 *
 * So an event of epoch E that follows frame F in this process's delivery
 * order was published after ALL of F, and everything between was delivered
 * to and processed by this loop first. Nothing else is trusted: not a short
 * read, not the end of a batch, not a transport call's size, not the feed's
 * carry. A frame read across two polls, a frame whose tail an outage or a
 * refusal cut off, and a frame at the very end of the stream are all simply
 * NOT YET PROVEN, so their confirmations do not exist for any evaluation.
 *
 * The proof is a pure function of the consumed event SEQUENCE, never of how
 * it was batched, polled or drained, so live, replay and backtest agree on
 * it (ADR-023 D8). The cost is one frame: an evaluation at frame k is vouched
 * for by frame k-1 at the latest, never by frame k itself (ADR-023 §5).
 *
 * ## The process-lag guard (review round 2, finding X9; ADR-023 D7)
 *
 * Every age is still measured in EVENT time, against the evaluating event's
 * `receivedAt` (`CO2-N1` unchanged). But a sibling frame in a BACKLOG proves
 * nothing about the present: a trader processing 09:00 events at 09:30 must
 * not be vouched for by a 09:00 confirmation. So the extension is measured
 * against the LATER of event time and the process clock (the `Clock` port the
 * caller reads): with `lag = max(0, processNow − eventNow)`,
 *
 * - rule 6's ceiling is judged at `eventNow + lag`, and
 * - the confirmation is moved back by `lag` before it is compared with the
 *   last change, so its event-time age equals its process-time age.
 *
 * A lagging trader therefore never gets more than the unguarded
 * `CONNECTION_CONFIRMED` rule would give it at its own process instant. That
 * is not `LAST_CHANGE` parity at every lag (last change 0, confirmation 5000,
 * event 5200, lag 1700: age 1900, fresh, where `LAST_CHANGE` reads 5200); the
 * answer EQUALS `LAST_CHANGE` once the shifted confirmation no longer leads
 * the last change (it never moves before it) or another fallback applies (rule
 * 6, a tainted epoch, no confirmation), and an unreadable process clock turns
 * the extension off. Under a replay clock positioned at each recorded
 * event (the backtest), `lag` is 0 and the answer is the unlagged one: what a
 * live process that kept up with the stream would have computed, not
 * necessarily what a lagging live process did.
 *
 * PURE STATE, NO CLOCK READ HERE. Every instant arrives from an event's own
 * `receivedAt`, already normalised to strict UTC by `time.ts`, or from the
 * caller's reading of its `Clock` port. The answer is a pure function of
 * those inputs, but replay reproduces only the event instants exactly, not a
 * live process's clock readings: a replay clock sits at each event (lag 0).
 * So under an opted-in `CONNECTION_CONFIRMED` basis (ADR-023 D8; review
 * round 5, R5-L1):
 *
 * - a live process that ran behind may have read a book staler than replay
 *   reads it, never fresher (the guard only removes extension);
 * - its feed ages and `featureSnapshotRef` hashes carry its process lag, so
 *   byte parity of its decision records with a replay is NOT guaranteed,
 *   even where every stale/fresh outcome matches (a 3 ms lag changed 12 of 13
 *   records in review). Evaluations that fall back (`LAST_CHANGE`, rule 6, a
 *   tainted epoch, no confirmation) can still match byte for byte;
 * - the epoch taint is state of the process (rule 4), so parity also needs
 *   the same start and restart boundaries.
 *
 * Under the default `LAST_CHANGE` basis no clock is read and nothing is
 * tracked here, so replay parity is as it was before ADR-023.
 */

import { frameKeyOf } from "./frames.js";
import { formatStrictUtc } from "./time.js";

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

/**
 * Review round 8: how many gateway epochs may each hold one frame not yet
 * proven whole ({@link FrameCompletionGate}). A healthy stream has one epoch
 * at a time. Past the bound the OLDEST held frame is forgotten, and its
 * confirmations are never used — the bound can only make the answer
 * stricter.
 */
export const MAXIMUM_UNPROVEN_FRAMES = 1_024;

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
 * Per-session confirmations and per-epoch taints. One per process.
 *
 * Review round 8: {@link DeliverySessionLiveness.observe} records a
 * confirmation that may be USED at once, so the loop never calls it
 * directly. It feeds every consumed event to a {@link FrameCompletionGate},
 * which hands a frame's confirmations to this table only once the frame is
 * proven whole (module header).
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
 * The fields of a consumed envelope the gate reads: its session fields, and
 * the identity `frames.ts` groups frames by (`causationId`, or the dispatch
 * identity `(gatewayEpoch, ingestSeq)`).
 */
export interface FramedSessionFields extends SessionFields {
  readonly ingestSeq: string;
  readonly causationId?: string;
}

/** One frame of one gateway epoch, not yet proven whole, and the confirmations it holds back. */
interface UnprovenFrame {
  readonly frameKey: string;
  /** By session key: the latest confirmation the frame carries for that session. */
  readonly held: Map<string, { readonly fields: SessionFields; readonly at: ConfirmedInstant }>;
}

/**
 * Review round 8 (R8-H1, and the class R6-H1 and R7-H1 belong to): a frame's
 * confirmations reach the {@link DeliverySessionLiveness} table only once the
 * frame is PROVEN WHOLE — when this process processes an event of the SAME
 * gateway epoch that belongs to ANOTHER frame (module header: why that proves
 * it, and why nothing weaker is trusted).
 *
 * Fed EVERY event the loop consumes, in delivery order, right after the event
 * door. For each one, in this order:
 *
 * 1. if the event's gateway epoch holds a frame that is not this event's
 *    frame, that frame is now proven whole: its held confirmations are
 *    recorded in the table;
 * 2. if the event is a confirmation (type, source and both session fields,
 *    as {@link DeliverySessionLiveness.observe} judges them), it is HELD
 *    against its own frame, which is not yet proven.
 *
 * So an evaluation never sees a confirmation from the frame it is evaluating,
 * nor from any frame not followed by another of its epoch: not one read
 * across two polls (R8-H1), not one whose tail a transport outage or a refused
 * envelope cut off (R7-H1, R6-H1), and not the last frame of a stream that
 * stopped. An event that names no frame (impossible behind the event door,
 * which requires `gatewayEpoch` and `ingestSeq`) neither proves nor
 * confirms. Bounded: one held frame per epoch, at most
 * {@link MAXIMUM_UNPROVEN_FRAMES} epochs, and at most
 * {@link MAXIMUM_TRACKED_SESSIONS} sessions per frame; a forgotten frame
 * confirms nothing (stricter, never looser).
 */
export class FrameCompletionGate {
  readonly #liveness: DeliverySessionLiveness;
  /** By gateway epoch, in insertion order (the oldest is forgotten first). */
  readonly #unproven = new Map<string, UnprovenFrame>();

  constructor(liveness: DeliverySessionLiveness) {
    this.#liveness = liveness;
  }

  /** One consumed event, in delivery order (see the class comment). */
  offer(envelope: FramedSessionFields, at: ConfirmedInstant): void {
    const frameKey = frameKeyOf(envelope);
    if (frameKey === undefined) return;
    const epoch = envelope.gatewayEpoch;
    const open = this.#unproven.get(epoch);
    if (open !== undefined && open.frameKey !== frameKey) {
      // A later event of the same epoch, from another frame: everything of
      // `open` was published before it and processed before it (step 1).
      this.#unproven.delete(epoch);
      for (const { fields, at: confirmedAt } of open.held.values()) {
        this.#liveness.observe(fields, confirmedAt);
      }
    }
    if (!CONFIRMING_EVENT_TYPES.has(envelope.eventType)) return;
    if (envelope.source !== CONFIRMING_SOURCE) return;
    const sessionKey = sessionKeyOf(envelope);
    if (sessionKey === undefined) return;
    let frame = this.#unproven.get(epoch);
    if (frame === undefined) {
      frame = { frameKey, held: new Map() };
      this.#unproven.set(epoch, frame);
      if (this.#unproven.size > MAXIMUM_UNPROVEN_FRAMES) {
        const oldest = this.#unproven.keys().next();
        if (oldest.done !== true) this.#unproven.delete(oldest.value);
      }
    }
    // Step 2: held, not recorded. Only what the table reads is kept.
    frame.held.delete(sessionKey);
    frame.held.set(sessionKey, {
      fields: {
        eventType: envelope.eventType,
        source: envelope.source,
        gatewayEpoch: envelope.gatewayEpoch,
        ...(envelope.connectionId === undefined ? {} : { connectionId: envelope.connectionId }),
        ...(envelope.subscriptionGeneration === undefined
          ? {}
          : { subscriptionGeneration: envelope.subscriptionGeneration }),
      },
      at,
    });
    if (frame.held.size > MAXIMUM_TRACKED_SESSIONS) {
      const oldest = frame.held.keys().next();
      if (oldest.done !== true) frame.held.delete(oldest.value);
    }
  }

  /** How many frames are held, not yet proven whole (diagnostics and tests). */
  get unprovenFrames(): number {
    return this.#unproven.size;
  }
}

/**
 * The instant a book is vouched for, under a basis. `lastChange` is the book's
 * own last applied update; `undefined` when the book has none (the caller
 * keeps its existing fallback).
 *
 * `nowEpochMs` is the evaluating instant (event time, exactly the `now` every
 * age is measured against) and `maximumLastChangeAgeMs` the configured
 * per-book ceiling (rule 6): once the book's own last change is MORE than the
 * ceiling before `now`, the answer is the last change itself, so the book's
 * age is its last-change age and the ordinary bound judges it — the
 * pre-ADR-023 rule, never looser.
 *
 * `processNowEpochMs` is the caller's reading of its `Clock` port (the
 * process-lag guard, r2 X9, above): `undefined` or non-finite turns the
 * extension off. It is read only under `CONNECTION_CONFIRMED`.
 */
export function bookConfirmedAt(input: {
  readonly basis: BookFreshnessBasis;
  readonly lastChange: ConfirmedInstant | undefined;
  readonly sessionKey: string | undefined;
  readonly marketHasActiveIncident: boolean;
  readonly liveness: DeliverySessionLiveness;
  readonly nowEpochMs: number;
  readonly processNowEpochMs: number | undefined;
  readonly maximumLastChangeAgeMs: number | undefined;
}): ConfirmedInstant | undefined {
  const { lastChange } = input;
  if (lastChange === undefined) return undefined;
  if (input.basis !== "CONNECTION_CONFIRMED") return lastChange;
  // The process-lag guard (r2, X9). An unreadable process clock is doubt.
  const processNow = input.processNowEpochMs;
  if (processNow === undefined || !Number.isFinite(processNow)) return lastChange;
  const lagMs = Math.max(0, processNow - input.nowEpochMs);
  // Rule 6, judged at the later of event time and process time. An absent
  // ceiling cannot occur under `CONNECTION_CONFIRMED` (the configuration door
  // requires it); if it ever did, the extension is off.
  const ceiling = input.maximumLastChangeAgeMs;
  if (ceiling === undefined || !(input.nowEpochMs + lagMs - lastChange.epochMs <= ceiling)) return lastChange;
  if (input.marketHasActiveIncident) return lastChange;
  if (input.sessionKey === undefined) return lastChange;
  const confirmed = input.liveness.confirmation(input.sessionKey);
  if (confirmed === undefined) return lastChange;
  // The confirmation, moved back by the lag: its event-time age is then its
  // process-time age. The later of that and the last change — a confirmation
  // recorded under a clock that stepped backwards, or one the lag moves
  // before the book's own update, cannot move the answer before that update.
  const guardedMs = confirmed.epochMs - lagMs;
  if (!(guardedMs > lastChange.epochMs)) return lastChange;
  return lagMs === 0 ? confirmed : { iso: formatStrictUtc(guardedMs), epochMs: guardedMs };
}
