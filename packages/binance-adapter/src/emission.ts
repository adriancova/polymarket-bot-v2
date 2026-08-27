/**
 * What this adapter hands to the gateway: an envelope with the gateway's own
 * fields left off.
 *
 * THE DIVISION OF LABOUR IS ADR-002's, NOT THIS PACKAGE'S CHOICE. ADR-002 §1
 * makes `gatewayEpoch` and `ingestSeq` REQUIRED on every envelope and §2.1 makes
 * `(gatewayEpoch, ingestSeq)` the *only* ordering authority: "`gatewayEpoch` is a
 * UUID assigned at gateway startup; `ingestSeq` is monotonic within that epoch…
 * Nothing else defines dispatch order." Handoff §9.1 assigns them, along with
 * `eventId`, to the gateway. An adapter that filled them in would be inventing a
 * position in a total order it cannot see, so {@link AdapterEmission} omits
 * them — not as a convenience, but so the type makes the mistake impossible.
 *
 * WHAT THE ADAPTER DOES OWN, and why each field is here:
 *
 * | Field | Why the adapter, and not the gateway |
 * | --- | --- |
 * | `source` | Fixed to `"binance"`; ADR-002 §5 makes the envelope `source` authoritative and the payload `venue` a restatement of it, and this package can only produce Binance events. |
 * | `sourceChannel` | The Binance stream name. Only the component that owns the wire format knows it. |
 * | `venueTimestamp` | Present only when the venue actually supplied one. `bookTicker` supplies none, so top-of-book emissions omit it. |
 * | `receivedAt` / `receivedMonotonicNs` | The receipt observation, taken at the socket. Taking it later would measure the queue, not the wire. |
 * | `connectionId` / `subscriptionGeneration` | The provenance chain §7.1 requires; the reconnect manager is what knows the generation. |
 * | `payload` | Already validated against the frozen contract (see below). |
 *
 * THE PAYLOAD IS VALIDATED HERE, AGAINST THE FROZEN CONTRACT. An emission is
 * only constructed through {@link buildEmission}, which parses the payload with
 * the contract's own `payloadSchema`. A defect in this adapter therefore fails at
 * the adapter with a typed error, instead of producing a record the gateway must
 * reject later (ADR-002 Consequences: a rejected envelope "needs routing, not
 * swallowing", and the cheapest rejection is the one that never happens).
 */

import {
  checkEnvelopePayloadProvenance,
  type EventContractLike,
  type ProvenancePayload,
} from "@polymarket-bot/domain";
import type { z } from "zod";

import { BinancePayloadError } from "./errors.js";
import type { ReceiptStamp } from "./time.js";

/**
 * The envelope `source` for every event this package produces (§7.1, ADR-002 §5).
 */
export const BINANCE_EVENT_SOURCE = "binance" as const;

/** Provenance the reconnect manager attaches to every emission. */
export type EmissionProvenance = {
  readonly connectionId: string;
  /** Incremented on every resubscription (§7.1, ADR-002 §2.4). */
  readonly subscriptionGeneration: number;
};

/**
 * One normalized event, ready for the gateway to envelope.
 *
 * Every field is a §7.1 envelope field with the same name, so the gateway copies
 * rather than maps.
 */
export type AdapterEmission<TPayload = unknown> = {
  readonly eventType: string;
  readonly schemaVersion: number;
  readonly source: typeof BINANCE_EVENT_SOURCE;
  readonly sourceChannel: string;
  /** Absent when the venue supplied no timestamp for this frame. */
  readonly venueTimestamp?: string;
  readonly receivedAt: string;
  readonly receivedMonotonicNs: string;
  readonly connectionId: string;
  readonly subscriptionGeneration: number;
  readonly payload: TPayload;
};

/** Inputs to {@link buildEmission}. */
export type EmissionInput<TPayload> = {
  readonly contract: EventContractLike;
  readonly sourceChannel: string;
  readonly venueTimestamp?: string | undefined;
  readonly receipt: ReceiptStamp;
  readonly provenance: EmissionProvenance;
  readonly payload: TPayload;
};

/**
 * Builds one emission, validating the payload against its frozen contract.
 *
 * `venueTimestamp` is spread conditionally rather than assigned `undefined`:
 * `exactOptionalPropertyTypes` is on repository-wide, and "the key is present
 * with the value `undefined`" is a different document from "the key is absent"
 * once the value is serialized. ADR-001 §8.1 is the same rule one layer down —
 * "absence and `null` are different facts, and this repository does not conflate
 * them".
 */
export function buildEmission<TPayload>(input: EmissionInput<TPayload>): AdapterEmission<TPayload> {
  const parsed = input.contract.payloadSchema.safeParse(input.payload);
  if (!parsed.success) {
    throw new BinancePayloadError(
      `normalized ${input.contract.eventType} payload failed its frozen domain schema: ${formatIssues(parsed.error)}`,
      {
        eventType: input.contract.eventType,
        schemaVersion: input.contract.schemaVersion,
        sourceChannel: input.sourceChannel,
      },
    );
  }

  // The payload schema alone cannot catch this: `ReferenceVenueSchema` accepts
  // every reference venue, so a payload restating `venue: "coinbase"` parses
  // cleanly and would only be caught later, by the envelope schema the gateway
  // applies. ADR-002 §5 makes the envelope `source` authoritative and requires
  // the disagreement to be unrepresentable; `packages/domain`'s own provenance
  // helper documents this exact boundary — "a gateway assembling a frame before
  // it emits one" — so it is applied here, where the two halves are first known
  // together, rather than one layer downstream.
  const provenance = checkEnvelopePayloadProvenance(
    { source: BINANCE_EVENT_SOURCE, eventType: input.contract.eventType },
    parsed.data as ProvenancePayload,
  );
  if (!provenance.ok) {
    throw new BinancePayloadError(
      `${provenance.message}; the envelope source is authoritative (§7.1, ADR-002 §5)`,
      {
        eventType: input.contract.eventType,
        sourceChannel: input.sourceChannel,
        payloadVenue: provenance.payloadVenue,
      },
    );
  }

  return {
    eventType: input.contract.eventType,
    schemaVersion: input.contract.schemaVersion,
    source: BINANCE_EVENT_SOURCE,
    sourceChannel: input.sourceChannel,
    ...(input.venueTimestamp === undefined ? {} : { venueTimestamp: input.venueTimestamp }),
    receivedAt: input.receipt.receivedAt,
    receivedMonotonicNs: input.receipt.receivedMonotonicNs,
    connectionId: input.provenance.connectionId,
    subscriptionGeneration: input.provenance.subscriptionGeneration,
    payload: parsed.data as TPayload,
  };
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 8)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}
