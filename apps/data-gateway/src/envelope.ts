/**
 * Envelope completion: an adapter draft becomes a validated §7.1 envelope.
 *
 * Every adapter deliberately stops short of the envelope — it supplies the
 * event type, schema version, source, channel, venue timestamp, connection id,
 * and generation, and leaves `eventId`, `gatewayEpoch`, `ingestSeq`, and the
 * receipt stamps to the gateway (ADR-002 §1/§2.1). This module is where the
 * two halves meet.
 *
 * The completed envelope is validated against the FROZEN domain contract via
 * `DOMAIN_EVENT_REGISTRY` before anything downstream sees it. ADR-002's
 * Consequences bind the failure path: "Rejected envelopes need routing, not
 * swallowing. … The gateway work package must catch the typed failure, emit
 * `DataQualityIncidentOpened`, increment a metric, and preserve the raw
 * frame." `completeEnvelope` therefore returns a discriminated result rather
 * than throwing: the caller owns the incident and holds the raw frame.
 */

import type { EventEnvelope, EventSource } from "@polymarket-bot/domain";
import { DOMAIN_EVENT_REGISTRY } from "@polymarket-bot/domain";

import type { GatewayReceipt } from "./ports.js";

/**
 * What every adapter hands the gateway for one normalized event.
 *
 * The field names are the §7.1 envelope's own, so completion copies rather
 * than maps (the WP-080 `AdapterEmission` and WP-090 `CoinbaseEnvelopeDraft`
 * shapes are both structurally assignable to this).
 */
export interface EnvelopeDraft {
  readonly eventType: string;
  readonly schemaVersion: number;
  readonly source: EventSource;
  readonly sourceChannel: string;
  readonly venueTimestamp?: string | undefined;
  readonly connectionId?: string | undefined;
  readonly subscriptionGeneration?: number | undefined;
  readonly payload: unknown;
}

/** The gateway-assigned half of the envelope. */
export interface EnvelopeAssignment {
  readonly eventId: string;
  readonly gatewayEpoch: string;
  readonly ingestSeq: string;
  readonly receipt: GatewayReceipt;
  /**
   * The §7.1 causation reference, when the event derives from a recorded raw
   * frame: `raw:<gatewayEpoch>:<ingestSeq of the raw frame>`. This is what
   * makes "fill → … → source event" (§6 invariant 4) checkable — the raw
   * frame's WAL record carries exactly that `(gatewayEpoch, ingestSeq)`.
   */
  readonly causationId?: string | undefined;
}

export type CompletedEnvelope =
  | { readonly ok: true; readonly envelope: EventEnvelope<unknown> }
  | {
      readonly ok: false;
      /** Stable code for metrics; the registry's typed failure rides on `error`. */
      readonly code: "ENVELOPE_CONTRACT_REJECTED";
      readonly detail: string;
      readonly error: unknown;
      /** The draft exactly as the adapter produced it, preserved as evidence. */
      readonly draft: EnvelopeDraft;
    };

/** The `causationId` naming a recorded raw frame's dedup identity. */
export function rawFrameCausationId(gatewayEpoch: string, rawIngestSeq: string): string {
  return `raw:${gatewayEpoch}:${rawIngestSeq}`;
}

/**
 * Completes and validates one envelope.
 *
 * `exactOptionalPropertyTypes` discipline: optional fields are spread
 * conditionally, never assigned `undefined` — "the key is present with the
 * value `undefined`" is a different document from "the key is absent" once
 * serialized (ADR-001 §8.1, restated by WP-080's `buildEmission`).
 */
export function completeEnvelope(
  draft: EnvelopeDraft,
  assignment: EnvelopeAssignment,
): CompletedEnvelope {
  const candidate: EventEnvelope<unknown> = {
    eventId: assignment.eventId,
    eventType: draft.eventType,
    schemaVersion: draft.schemaVersion,
    source: draft.source,
    sourceChannel: draft.sourceChannel,
    ...(draft.venueTimestamp === undefined ? {} : { venueTimestamp: draft.venueTimestamp }),
    receivedAt: assignment.receipt.receivedAt,
    receivedMonotonicNs: assignment.receipt.receivedMonotonicNs,
    gatewayEpoch: assignment.gatewayEpoch,
    ingestSeq: assignment.ingestSeq,
    ...(draft.connectionId === undefined ? {} : { connectionId: draft.connectionId }),
    ...(draft.subscriptionGeneration === undefined
      ? {}
      : { subscriptionGeneration: draft.subscriptionGeneration }),
    ...(assignment.causationId === undefined ? {} : { causationId: assignment.causationId }),
    payload: draft.payload,
  };

  const parsed = DOMAIN_EVENT_REGISTRY.safeParseEnvelope(candidate);
  if (parsed.ok) {
    return { ok: true, envelope: parsed.envelope };
  }
  return {
    ok: false,
    code: "ENVELOPE_CONTRACT_REJECTED",
    detail:
      parsed.error instanceof Error
        ? `${draft.eventType}@${String(draft.schemaVersion)}: ${parsed.error.message}`
        : `${draft.eventType}@${String(draft.schemaVersion)}: envelope failed its frozen contract`,
    error: parsed.error,
    draft,
  };
}
