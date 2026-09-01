/**
 * The single funnel from adapter output to the transport.
 *
 * Assignment (eventId, ingestSeq) and submission happen in ONE synchronous
 * step, which is what keeps the transport's strictly-increasing-per-epoch
 * publish rule satisfiable: two async feed callbacks can interleave, but a
 * sequence value is submitted the moment it is assigned, so submission order
 * IS assignment order (see `publisher.ts`).
 *
 * A rejected envelope is routed, never swallowed (ADR-002 Consequences): the
 * typed failure opens a `DataQualityIncidentOpened` via the incident registry
 * — whose own envelope goes through this same funnel — and is counted. The
 * recursion terminates because an incident draft that itself fails contract
 * validation is counted and reported through the observer only.
 */

import type { EventEnvelope } from "@polymarket-bot/domain";
import type { IncidentSeverity } from "@polymarket-bot/domain";

import type { EnvelopeDraft } from "./envelope.js";
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
   * Synchronous up to the submission; the returned promise reports the
   * publish outcome and never rejects.
   */
  dispatch(draft: EnvelopeDraft, context: DispatchContext = {}): Promise<PublishOutcome> {
    const receipt = context.receipt ?? takeReceipt(this.#clock);
    const completed = completeEnvelope(draft, {
      eventId: this.#ids.newEventId(receipt.nowMs),
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
    if (!completed.ok) {
      this.#envelopeRejections += 1;
      this.#observer.onEnvelopeRejected?.({ detail: completed.detail, draft });
      this.openIncident({
        scope: "envelope",
        reasonCode: "GATEWAY_ENVELOPE_REJECTED",
        severity: "NOTIFY",
        detail: completed.detail,
      });
      return Promise.resolve({
        published: false,
        reason: "transport-rejected",
        detail: completed.detail,
      });
    }
    this.#dispatched += 1;
    return this.#publisher.enqueue(completed.envelope);
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
    );
  }

  /** Closes the registry key so a recurrence opens a fresh incident. */
  markIncidentClosed(scope: string, reasonCode: string): void {
    this.#incidents.markClosed(scope, reasonCode);
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
