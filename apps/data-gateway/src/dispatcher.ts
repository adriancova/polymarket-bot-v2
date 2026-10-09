/**
 * The single funnel from adapter output to the transport.
 *
 * ## What "one step" does and does not guarantee (round-1 review L1)
 *
 * Assignment and submission happen in ONE SYNCHRONOUS TURN: no `await`
 * separates `sequencer.next()` from `publisher.enqueue()`, so no other
 * dispatch can interleave between them and SUBMISSION ORDER IS ASSIGNMENT
 * ORDER. That — and only that — is what the transport's
 * strictly-increasing-per-epoch publish rule needs, and it is what
 * `publisher.ts` relies on.
 *
 * It does NOT guarantee that every assigned sequence reaches the transport.
 * Envelope validation runs BETWEEN assignment and submission, so a draft that
 * fails its frozen contract consumes its `ingestSeq` and publishes nothing:
 * a bad draft followed by two good ones publishes 2 and 3 with 1 absent.
 * Round 1 described this as "assign and submit in one step", which read as if
 * that hole could not occur. It can, and it is loud: the rejection is counted
 * (`envelopeRejections`), reported to the observer, and opens a
 * `GATEWAY_ENVELOPE_REJECTED` incident.
 *
 * A hole is not a breach of the ordering contract. Raw WAL frames draw from
 * the SAME counter (`sequencer.ts`), so a published stream's `ingestSeq` is
 * non-contiguous BY DESIGN and a consumer that read contiguity as a
 * completeness check would already be wrong — completeness lives in the WAL,
 * and the transport's own resync arithmetic watches its publication ordinals,
 * not `ingestSeq`.
 *
 * Validation is deliberately not moved before assignment: `completeEnvelope`
 * validates the COMPLETE envelope, identity included, so validating first
 * would mean validating a different document than the one published — a
 * weaker check bought with a stronger-sounding sentence.
 *
 * ## Rejections are routed, never swallowed
 *
 * ADR-002 Consequences: the typed failure opens a `DataQualityIncidentOpened`
 * via the incident registry — whose own envelope goes through this same funnel
 * — and is counted. The recursion terminates because an incident draft that
 * itself fails contract validation is counted and reported through the
 * observer only.
 *
 * ## A frame's loss is published BEFORE the frame (`THROUGHPUT-1c` r6, R6-H1)
 *
 * One venue frame becomes several events, and the trader may read a frame's
 * accepted events as evidence that the delivery path is whole (ADR-023: a
 * market-channel frame on a delivery session vouches for every book on that
 * session). If the gateway refuses ONE of a frame's events here, the frame
 * lost part of what the venue sent, and the consumer must learn of that loss
 * before any of the frame's siblings can close an evaluation. `dispatch`
 * cannot promise that: it sees one event at a time, so a refused LATER event
 * opens its incident after the earlier siblings were already submitted (an
 * adapter-accepted venue `timestamp` whose ISO form has a five-digit year —
 * a timestamp sent in microseconds — did exactly that, and an opted-in
 * trader approved two orders on the book whose change was lost).
 *
 * {@link GatewayDispatcher.dispatchFrame} takes the whole frame. It assigns
 * and validates EVERY event, exactly as `dispatch` would, before it submits
 * any. When all pass, it submits them in that order: the same sequences, ids
 * and documents as one `dispatch` per event, nothing else changes. When any
 * is refused, nothing assigned in that pass is submitted: the
 * `GATEWAY_ENVELOPE_REJECTED` incident is opened FIRST (at the frame's first
 * receipt, so receipt instants never run backwards in the stream), and only
 * then are the accepted events assigned fresh sequences, re-validated with
 * those sequences, and submitted. The first pass's sequences become holes,
 * which the module header above already allows. What is validated is still
 * exactly what is published: every submitted envelope passed
 * `completeEnvelope` with its own final identity.
 *
 * The registry deduplicates an open incident per `(scope, reasonCode)`, so a
 * later frame's loss inside the same gateway epoch publishes no second
 * incident; the consumer's taint from the first one is for the whole epoch
 * (ADR-023 D2 rule 4). A consumer that did not see the first one is ADR-023's
 * accepted X2 gap, bounded by its ceiling.
 *
 * ## A frame too large for one transport call (`THROUGHPUT-1c` r7, R7-H1)
 *
 * The publisher submits a frame of up to
 * {@link GatewayPublisher.atomicFrameEnvelopes} envelopes in ONE transport
 * call (`publisher.ts`, "Frame-atomic runs"), so such a frame is published
 * whole or not at all. A LARGER frame is published across several calls. If
 * publication halts between two of them (an outage), the stream ends with a
 * PREFIX of the frame, and the trader closes that prefix as a whole frame:
 * its events would vouch for every book on their session, including a book
 * whose change was in the lost tail. The gateway cannot report that loss
 * after the fact, because publication has halted.
 *
 * So {@link GatewayDispatcher.dispatchFrame} reports the RISK ahead of the
 * frame. When a frame has more entries than the publisher submits in one
 * call, and publication has not halted, a `GATEWAY_FRAME_SPLIT` incident
 * naming no market is opened BEFORE any of the frame's events is assigned a
 * sequence, stamped with the frame's first receipt. A consumer that reads it
 * taints the gateway epoch (ADR-023 D2 rule 4) before any of the frame's
 * events can close an evaluation, whether or not the tail is later lost.
 * The incident's registry key is closed again at once, so EVERY such frame
 * is preceded by its own incident: a consumer that joined the epoch late
 * still meets one ahead of the frame, so this route is not left to the X2
 * bound. Its severity is `LOG`: nothing was lost, and the incident exists to
 * taint. With the Redis transport the threshold is 1 024 envelopes, i.e. one
 * venue message of more than a thousand normalized events (in the H1 burst
 * the largest Polymarket frame has 2 events, and the largest frame of any
 * source has 65). When publication has already halted, nothing of the frame
 * can be published, so no incident is opened.
 */

import type { EventEnvelope } from "@polymarket-bot/domain";
import type { IncidentSeverity } from "@polymarket-bot/domain";

import type { CompletedEnvelope, EnvelopeDraft } from "./envelope.js";
import { completeEnvelope, rawFrameCausationId } from "./envelope.js";
import type { IncidentRegistry } from "./incidents.js";
import type { GatewayClock, GatewayIdSource, GatewayReceipt } from "./ports.js";
import { takeReceipt } from "./ports.js";
import type { GatewayPublisher, PublishOutcome } from "./publisher.js";
import type { IngestSequencer } from "./sequencer.js";

export interface DispatchContext {
  /** The receipt stamp of the underlying frame; taken fresh when absent. */
  readonly receipt?: GatewayReceipt;
  /** The recorded raw frame this event derives from, for §6 invariant 4. */
  readonly rawFrameIngestSeq?: string | undefined;
}

export interface DispatcherObserver {
  /** A completed envelope failed its frozen contract; the draft is preserved. */
  onEnvelopeRejected?(rejection: { readonly detail: string; readonly draft: EnvelopeDraft }): void;
  /** Every gateway-opened incident, whether or not its envelope publishes. */
  onIncident?(incident: {
    readonly incidentId: string;
    readonly reasonCode: string;
    readonly severity: IncidentSeverity;
    readonly detail: string;
    readonly feedId?: string | undefined;
  }): void;
}

/** One event of a frame handed to {@link GatewayDispatcher.dispatchFrame}. */
export interface FrameDispatchEntry {
  readonly draft: EnvelopeDraft;
  readonly context?: DispatchContext;
}

/** One draft after its identity was assigned and its envelope completed. */
interface AssignedDraft {
  readonly draft: EnvelopeDraft;
  readonly context: DispatchContext;
  readonly receipt: GatewayReceipt;
  readonly eventId: string;
  readonly completed: CompletedEnvelope;
}

export interface DispatcherMetrics {
  readonly dispatched: number;
  readonly envelopeRejections: number;
}

export class GatewayDispatcher {
  readonly #clock: GatewayClock;
  readonly #ids: GatewayIdSource;
  readonly #sequencer: IngestSequencer;
  readonly #publisher: GatewayPublisher;
  readonly #incidents: IncidentRegistry;
  readonly #observer: DispatcherObserver;
  #dispatched = 0;
  #envelopeRejections = 0;

  constructor(options: {
    readonly clock: GatewayClock;
    readonly ids: GatewayIdSource;
    readonly sequencer: IngestSequencer;
    readonly publisher: GatewayPublisher;
    readonly incidents: IncidentRegistry;
    readonly observer?: DispatcherObserver;
  }) {
    this.#clock = options.clock;
    this.#ids = options.ids;
    this.#sequencer = options.sequencer;
    this.#publisher = options.publisher;
    this.#incidents = options.incidents;
    this.#observer = options.observer ?? {};
  }

  /**
   * Assigns, completes, validates, and submits one event.
   *
   * Synchronous up to the submission; the returned promise reports the publish
   * outcome and never rejects. A validation failure between the assignment and
   * the submission consumes the sequence and publishes nothing — see the
   * module header for exactly what that does and does not break.
   */
  dispatch(draft: EnvelopeDraft, context: DispatchContext = {}): Promise<PublishOutcome> {
    const assigned = this.#assign(draft, context);
    if (!assigned.completed.ok) {
      return this.#reject(assigned.draft, assigned.completed.detail);
    }
    return this.#submit(assigned.completed.envelope);
  }

  /**
   * Dispatches the events of ONE venue frame, reporting a loss BEFORE the
   * frame (module header, "A frame's loss is published BEFORE the frame").
   *
   * Every entry is assigned and validated before any is submitted. All valid:
   * submitted in order, exactly as one {@link dispatch} per entry would have
   * submitted them. Any refused: the `GATEWAY_ENVELOPE_REJECTED` incident is
   * opened first, at the first entry's receipt; the accepted entries are then
   * re-assigned (fresh sequences, the same ids and receipts), re-validated
   * and submitted in their order. Synchronous up to the last submission, like
   * {@link dispatch}; one outcome per entry, in entry order, never rejecting.
   *
   * A frame with more entries than the publisher submits in one transport
   * call is preceded by a `GATEWAY_FRAME_SPLIT` incident, opened before
   * anything else of the frame (module header, "A frame too large for one
   * transport call").
   */
  dispatchFrame(entries: readonly FrameDispatchEntry[]): readonly Promise<PublishOutcome>[] {
    if (entries.length > this.#publisher.atomicFrameEnvelopes && !this.#publisher.halted) {
      this.#reportSplitFrame(entries);
    }
    const assigned = entries.map((entry) => this.#assign(entry.draft, entry.context ?? {}));
    const details: string[] = [];
    for (const entry of assigned) {
      if (!entry.completed.ok) details.push(entry.completed.detail);
    }
    if (details.length === 0) {
      const outcomes: Promise<PublishOutcome>[] = [];
      for (const entry of assigned) {
        if (entry.completed.ok) outcomes.push(this.#submit(entry.completed.envelope));
      }
      return outcomes;
    }

    // The frame lost events. Each refusal is counted and observed, as in
    // `dispatch`; the ONE incident naming the loss goes ahead of the frame.
    for (const entry of assigned) {
      if (entry.completed.ok) continue;
      this.#envelopeRejections += 1;
      this.#observer.onEnvelopeRejected?.({ detail: entry.completed.detail, draft: entry.draft });
    }
    const first = assigned[0];
    this.openIncident(
      {
        scope: "envelope",
        reasonCode: "GATEWAY_ENVELOPE_REJECTED",
        severity: "NOTIFY",
        detail:
          `${String(details.length)} of a frame's ${String(entries.length)} events failed their ` +
          "frozen contract and were not published; this incident precedes the frame's " +
          `accepted events: ${details.join("; ")}`,
      },
      undefined,
      first === undefined ? {} : { receipt: first.receipt },
    );

    return assigned.map((entry): Promise<PublishOutcome> => {
      if (!entry.completed.ok) {
        return Promise.resolve({
          published: false,
          reason: "transport-rejected",
          detail: entry.completed.detail,
        });
      }
      // Re-assigned AFTER the incident, so the stream's order is the
      // incident first. Same id and receipt; a fresh sequence, validated.
      const reassigned = this.#assign(entry.draft, entry.context, entry.eventId);
      if (!reassigned.completed.ok) {
        return this.#reject(entry.draft, reassigned.completed.detail);
      }
      return this.#submit(reassigned.completed.envelope);
    });
  }

  /**
   * Assigns one draft its identity and completes (validates) its envelope.
   * The id is minted BEFORE the sequence is drawn, as it always was, so the
   * ids and sequences of a frame dispatched whole equal those of one
   * `dispatch` per event. `eventId` is passed only by a re-assignment, which
   * keeps the id of a document that was never submitted.
   */
  #assign(draft: EnvelopeDraft, context: DispatchContext, eventId?: string): AssignedDraft {
    const receipt = context.receipt ?? takeReceipt(this.#clock);
    const id = eventId ?? this.#ids.newEventId(receipt.nowMs);
    const completed = completeEnvelope(draft, {
      eventId: id,
      gatewayEpoch: this.#sequencer.gatewayEpoch,
      ingestSeq: this.#sequencer.next(),
      receipt,
      ...(context.rawFrameIngestSeq === undefined
        ? {}
        : {
            causationId: rawFrameCausationId(
              this.#sequencer.gatewayEpoch,
              context.rawFrameIngestSeq,
            ),
          }),
    });
    return { draft, context: { ...context, receipt }, receipt, eventId: id, completed };
  }

  /**
   * Opens the `GATEWAY_FRAME_SPLIT` incident ahead of a frame the publisher
   * cannot submit in one call (r7, R7-H1), then closes its registry key so
   * the next such frame opens its own. It is stamped with the frame's first
   * receipt, so receipt instants never run backwards in the stream.
   */
  #reportSplitFrame(entries: readonly FrameDispatchEntry[]): void {
    const firstReceipt = entries[0]?.context?.receipt;
    this.openIncident(
      {
        scope: "frame",
        reasonCode: "GATEWAY_FRAME_SPLIT",
        severity: "LOG",
        detail:
          `a frame of ${String(entries.length)} events is more than the ` +
          `${String(this.#publisher.atomicFrameEnvelopes)} the publisher submits in one transport call, ` +
          "so it is published across several calls, and a publication halt between two of them " +
          "would publish only a prefix; this incident precedes the frame",
      },
      undefined,
      firstReceipt === undefined ? {} : { receipt: firstReceipt },
    );
    this.#incidents.markClosed("frame", "GATEWAY_FRAME_SPLIT");
  }

  /** Counts, observes and routes one refused draft (the single-event path). */
  #reject(draft: EnvelopeDraft, detail: string): Promise<PublishOutcome> {
    this.#envelopeRejections += 1;
    this.#observer.onEnvelopeRejected?.({ detail, draft });
    this.openIncident({
      scope: "envelope",
      reasonCode: "GATEWAY_ENVELOPE_REJECTED",
      severity: "NOTIFY",
      detail,
    });
    return Promise.resolve({
      published: false,
      reason: "transport-rejected",
      detail,
    });
  }

  #submit(envelope: EventEnvelope<unknown>): Promise<PublishOutcome> {
    this.#dispatched += 1;
    return this.#publisher.enqueue(envelope);
  }

  /**
   * Opens a gateway incident and dispatches its envelope.
   *
   * Suppressed repeats are counted by the registry; the observer sees every
   * genuine open regardless of whether the transport is still reachable —
   * which is the delivery that keeps working during a transport outage, so it
   * is the one path every incident MUST take.
   *
   * `buildDraft` lets a feed driver supply the adapter's own incident payload
   * (so the published event carries the adapter's provenance and reason
   * vocabulary) without bypassing the registry's dedup or the observer. It is
   * the single funnel: there is no other way to open an incident.
   *
   * `context` is the incident envelope's own dispatch context; only
   * {@link dispatchFrame} passes one (the frame's first receipt).
   */
  openIncident(
    input: {
      readonly scope: string;
      readonly reasonCode: string;
      readonly severity: IncidentSeverity;
      readonly detail: string;
      readonly feedId?: string | undefined;
    },
    buildDraft?: (incidentId: string) => EnvelopeDraft,
    context: DispatchContext = {},
  ): void {
    const outcome = this.#incidents.open({
      scope: input.scope,
      reasonCode: input.reasonCode,
      severity: input.severity,
      detail: input.detail,
      atMs: this.#clock.nowMs(),
      feedId: input.feedId,
    });
    if (!outcome.opened) {
      return;
    }
    this.#observer.onIncident?.({
      incidentId: outcome.incidentId,
      reasonCode: input.reasonCode,
      severity: input.severity,
      detail: input.detail,
      feedId: input.feedId,
    });
    // The incident's own envelope goes through the ordinary funnel. If IT is
    // rejected, `dispatch` counts the rejection and notifies the observer but
    // opens no second incident for the same scope+reason while this one is
    // open — the registry's dedup is what terminates the recursion.
    void this.dispatch(
      buildDraft === undefined ? outcome.draft : buildDraft(outcome.incidentId),
      context,
    );
  }

  /**
   * Closes the registry key so a recurrence opens a fresh incident, and —
   * `C1-HALTS` (DQ-CLOSE) — when that closed an OPEN incident, publishes its
   * `DataQualityIncidentClosed` through the ordinary funnel. Until then no
   * producer published a close, so a consumer's active set only grew: the
   * trader paused a market for its life on one transient poll failure. A key
   * that was not open publishes nothing, so a caller may call this on every
   * success.
   */
  markIncidentClosed(scope: string, reasonCode: string): void {
    const incidentId = this.#incidents.markClosed(scope, reasonCode);
    if (incidentId === undefined) return;
    void this.dispatch(
      this.#incidents.closedDraft({ incidentId, scope, reasonCode, atMs: this.#clock.nowMs() }),
    );
  }

  /**
   * `C1-HALTS` r1 (L4): replaces the OPEN incident for a key with a fresh one
   * (a new id and detail), publishing the new incident's open BEFORE the old
   * one's close, so a consumer never sees the key's condition with no active
   * incident between them. Closing first, then opening, left that gap: the
   * trader un-paused the market at the close. With no open incident for the
   * key this is {@link openIncident}.
   */
  replaceIncident(
    input: Parameters<GatewayDispatcher["openIncident"]>[0],
    buildDraft?: (incidentId: string) => EnvelopeDraft,
  ): void {
    const previous = this.#incidents.markClosed(input.scope, input.reasonCode);
    this.openIncident(input, buildDraft);
    if (previous === undefined) return;
    void this.dispatch(
      this.#incidents.closedDraft({
        incidentId: previous,
        scope: input.scope,
        reasonCode: input.reasonCode,
        atMs: this.#clock.nowMs(),
      }),
    );
  }

  get incidents(): IncidentRegistry {
    return this.#incidents;
  }

  metrics(): DispatcherMetrics {
    return { dispatched: this.#dispatched, envelopeRejections: this.#envelopeRejections };
  }
}

/** Re-exported for feed drivers that build event envelopes directly. */
export type { EventEnvelope };
