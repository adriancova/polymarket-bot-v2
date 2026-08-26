/**
 * Envelope/payload provenance agreement — handoff §7.1.
 *
 * ## The envelope is authoritative
 *
 * `EventEnvelope.source` is where an event came from. The gateway assigns it
 * alongside `gatewayEpoch`, `ingestSeq`, `connectionId`, and the receipt
 * timestamps (§9.1), and the raw-frame record ties back to it. Nothing in a
 * payload may override it.
 *
 * Some payloads nonetheless restate the origin — the reference-feed events
 * carry `venue` — because a consumer may hold a payload without its envelope
 * (a projection, a feature snapshot, a persisted row). A restatement that can
 * disagree with the authoritative field is a data-quality hazard: two readers
 * of the same event would attribute it to different venues.
 *
 * These helpers are pure declarations, like everything else in this package:
 * no I/O, no clock, no logging. A caller turns a mismatch into a
 * `DataQualityIncidentOpened` event and a metric.
 *
 * ## Where the rule is enforced
 *
 * The rule is NOT optional and NOT only available to callers that remember to
 * invoke it. `eventEnvelopeSchema` / `pinnedEventEnvelopeSchema` (`./envelope.ts`)
 * attach it as a schema-level refinement, so every registered contract's
 * envelope schema — and therefore the canonical
 * `DOMAIN_EVENT_REGISTRY.parseEnvelope` path — rejects a document whose two
 * provenance fields contradict each other. `parseEnvelope` re-checks the pair
 * itself, because `EventContractLike` is structural and a hand-assembled
 * contract can carry an envelope schema that was not built by those helpers.
 * These exported helpers remain for boundaries that hold an envelope and a
 * payload that were never validated together (a projection joined to a
 * persisted row, a gateway assembling a frame before it emits one).
 */

import { EventProvenanceMismatchError } from "./errors.js";

/** The envelope fields this check needs. Structural, so any envelope satisfies it. */
export interface ProvenanceEnvelope {
  readonly source: string;
  readonly eventType?: string;
}

/** A payload that may restate its origin. */
export interface ProvenancePayload {
  readonly venue?: unknown;
}

export type ProvenanceCheckResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly envelopeSource: string;
      readonly payloadVenue: string;
      readonly message: string;
    };

/**
 * Non-throwing provenance check.
 *
 * Returns `{ ok: true }` when the payload does not restate its origin at all,
 * or when its `venue` equals the envelope `source`. A payload `venue` that is
 * present but not a string is reported as a mismatch: it cannot agree with the
 * envelope, and silently ignoring it would defeat the point of the check.
 *
 * A payload that is not an object cannot restate anything, so it passes. This
 * is checked with `typeof` rather than assumed, because the transport-level
 * envelope schema validates an unknown payload and `"venue" in payload` throws
 * on a primitive.
 */
export function checkEnvelopePayloadProvenance(
  envelope: ProvenanceEnvelope,
  payload: ProvenancePayload | null | undefined,
): ProvenanceCheckResult {
  if (typeof payload !== "object" || payload === null) {
    return { ok: true };
  }
  if (!("venue" in payload) || payload.venue === undefined) {
    return { ok: true };
  }
  const venue = payload.venue;
  const rendered = typeof venue === "string" ? venue : `(${typeof venue})`;
  if (typeof venue === "string" && venue === envelope.source) {
    return { ok: true };
  }
  return {
    ok: false,
    envelopeSource: envelope.source,
    payloadVenue: rendered,
    message: `payload venue "${rendered}" contradicts envelope source "${envelope.source}"`,
  };
}

/**
 * Throwing provenance check.
 *
 * @throws {EventProvenanceMismatchError} when the payload restates an origin
 * that differs from the authoritative envelope `source`.
 */
export function assertEnvelopePayloadProvenance(
  envelope: ProvenanceEnvelope,
  payload: ProvenancePayload | null | undefined,
): void {
  const outcome = checkEnvelopePayloadProvenance(envelope, payload);
  if (outcome.ok) {
    return;
  }
  throw new EventProvenanceMismatchError(
    outcome.envelopeSource,
    outcome.payloadVenue,
    envelope.eventType ?? "event",
  );
}
