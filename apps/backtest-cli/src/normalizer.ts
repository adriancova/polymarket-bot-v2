/**
 * Replay normalizers for the backtest composition root.
 *
 * Handoff §8.4: replay consumes "the same **normalized event envelopes**" the
 * live process consumed. Normalization belongs to the venue adapters (layer 2),
 * so `packages/simulation` takes a {@link ReplayNormalizer} port and this app —
 * the composition root — supplies one.
 *
 * Two are shipped:
 *
 * - {@link recordedFrameNormalizer}: verification only. It performs NO venue
 *   interpretation; it envelopes the recorded frame as-is so a dataset's
 *   ordering, checksums and counts can be verified without a market directory.
 *   Its `normalizerVersion` says so in its name, so a dataset pinned to a real
 *   normalizer refuses it (`REPLAY_MANIFEST_PIN_MISMATCH`).
 * - {@link polymarketMarketNormalizer}: the REAL `@polymarket-bot/polymarket-public`
 *   market-channel normalizer.
 *
 * ## Provenance is copied, never restated
 *
 * Every envelope takes `(gatewayEpoch, ingestSeq, receivedAt, receivedMonotonicNs)`
 * verbatim from the recorded frame. `DatasetEventSource` re-checks all four and
 * refuses an envelope that differs, so a normalizer cannot quietly renumber the
 * stream. `eventId` is derived from the recorded identity
 * ({@link deriveReplayEventId}) rather than minted, because §12.4 requires a
 * replay to be byte-identical and a random id is not.
 *
 * ## A normalization problem is a refusal, never a dropped event
 *
 * §8.3 forbids dropping a recorded market event silently. If the venue
 * normalizer reports a problem for a frame, this normalizer refuses that frame
 * and the replay stops with the reason — it does not emit the events it managed
 * to produce and move on.
 *
 * ## Boundary note (ADR-020 §3)
 *
 * The recorded payload is decoded with `packages/simulation`'s strict-JSON
 * reader, which builds a PROTOTYPE-FREE tree as it parses. That is D1 applied at
 * this app's boundary: the value handed to the adapter's own `zod` door is a
 * tree with no prototype chain to read a declared key off. It does not turn that
 * door into a conforming one — `docs/contracts/schema-boundary.md` §3 records
 * `packages/polymarket-public` as LIVE and §5 item 3 assigns the fix to the
 * recorder-pipeline hardening round — but it does mean this replay path does not
 * hand it a value with an inherited-property surface.
 */

import {
  deriveReplayEventId,
  parseStrictJsonText,
  type EventEnvelope,
  type NormalizeOutcome,
  type ReplayNormalizer,
  type ReplayRecord,
  type Sha256HexDigest,
} from "@polymarket-bot/simulation";
import {
  normalizeMarketEvents,
  type MarketNormalizationContext,
  type NormalizedPublicMarketEvent,
} from "@polymarket-bot/polymarket-public";

/** The §7.1 `source` vocabulary. Mirrored here so a bad recorded value refuses. */
const EVENT_SOURCES: readonly string[] = ["polymarket", "binance", "coinbase", "rtds", "internal"];

/**
 * `normalizerVersion` of the verification-only normalizer.
 *
 * The name states what it is, so a dataset pinned to a real normalizer refuses
 * it rather than being "verified" by a component that never interpreted a frame.
 */
export const RECORDED_FRAME_NORMALIZER_VERSION = "backtest-cli/recorded-frame-passthrough/v1";

/** `normalizerVersion` of the Polymarket market-channel replay normalizer. */
export const POLYMARKET_MARKET_NORMALIZER_VERSION = "polymarket-public/market-channel/v1";

function envelopeFrom(input: {
  readonly record: ReplayRecord;
  readonly eventId: string;
  readonly eventType: string;
  readonly schemaVersion: number;
  readonly source: EventEnvelope<unknown>["source"];
  readonly sourceChannel: string;
  readonly venueTimestamp?: string;
  readonly payload: unknown;
}): EventEnvelope<unknown> {
  const frame = input.record.frame;
  return {
    eventId: input.eventId,
    eventType: input.eventType,
    schemaVersion: input.schemaVersion,
    source: input.source,
    sourceChannel: input.sourceChannel,
    ...(input.venueTimestamp === undefined ? {} : { venueTimestamp: input.venueTimestamp }),
    receivedAt: frame.receivedAt,
    receivedMonotonicNs: frame.receivedMonotonicNs,
    gatewayEpoch: frame.gatewayEpoch,
    ingestSeq: frame.ingestSeq,
    ...(frame.connectionId === "" ? {} : { connectionId: frame.connectionId }),
    subscriptionGeneration: frame.subscriptionGeneration,
    rawSegmentId: input.record.segmentId,
    rawRecordOffset: String(input.record.segmentRecordIndex),
    payload: input.payload,
  };
}

/**
 * A verification-only normalizer: one envelope per recorded frame, no venue
 * interpretation at all.
 */
export function recordedFrameNormalizer(digest: Sha256HexDigest): ReplayNormalizer {
  return {
    normalizerVersion: RECORDED_FRAME_NORMALIZER_VERSION,
    normalize(record: ReplayRecord): NormalizeOutcome {
      if (!EVENT_SOURCES.includes(record.frame.source)) {
        return {
          ok: false,
          reason: `the recorded frame names source ${JSON.stringify(record.frame.source)}, which is not one of the §7.1 event sources`,
        };
      }
      const eventId = deriveReplayEventId(digest, {
        gatewayEpoch: record.frame.gatewayEpoch,
        ingestSeq: record.frame.ingestSeq,
        receivedAt: record.frame.receivedAt,
        index: 0,
      });
      if (!eventId.ok) return { ok: false, reason: eventId.refusal.message };
      return {
        ok: true,
        envelopes: [
          envelopeFrom({
            record,
            eventId: eventId.value,
            eventType: "RawFrameRecorded",
            schemaVersion: 1,
            source: record.frame.source as EventEnvelope<unknown>["source"],
            sourceChannel: record.frame.endpoint === "" ? "recorded" : record.frame.endpoint,
            payload: record.frame.payloadUtf8,
          }),
        ],
      };
    },
  };
}

/** Options for the Polymarket market-channel replay normalizer. */
export interface PolymarketNormalizerOptions {
  readonly digest: Sha256HexDigest;
  readonly context: MarketNormalizationContext;
}

/** The real `@polymarket-bot/polymarket-public` market-channel normalizer. */
export function polymarketMarketNormalizer(
  options: PolymarketNormalizerOptions,
): ReplayNormalizer {
  return {
    normalizerVersion: POLYMARKET_MARKET_NORMALIZER_VERSION,
    normalize(record: ReplayRecord): NormalizeOutcome {
      if (record.frame.source !== "polymarket") {
        return {
          ok: false,
          reason: `this normalizer reads the Polymarket market channel and the frame names source ${JSON.stringify(record.frame.source)}`,
        };
      }
      const decoded = parseStrictJsonText(record.frame.payloadUtf8);
      if (!decoded.ok) {
        return { ok: false, reason: `the recorded payload is not strict JSON: ${decoded.problem.problem}` };
      }
      const values = Array.isArray(decoded.value) ? decoded.value : [decoded.value];
      const normalization = normalizeMarketEvents(values, {
        ...options.context,
        ...(record.frame.connectionId === "" ? {} : { connectionId: record.frame.connectionId }),
        subscriptionGeneration: record.frame.subscriptionGeneration,
      });
      if (normalization.problems.length > 0) {
        const first = normalization.problems[0];
        return {
          ok: false,
          reason: `the venue normalizer refused the recorded frame (${String(first?.code)}: ${String(first?.detail)}); §8.3 forbids dropping a recorded market event silently`,
        };
      }
      const envelopes: EventEnvelope<unknown>[] = [];
      for (let index = 0; index < normalization.events.length; index += 1) {
        const event = normalization.events[index] as NormalizedPublicMarketEvent;
        const eventId = deriveReplayEventId(options.digest, {
          gatewayEpoch: record.frame.gatewayEpoch,
          ingestSeq: record.frame.ingestSeq,
          receivedAt: record.frame.receivedAt,
          index,
        });
        if (!eventId.ok) return { ok: false, reason: eventId.refusal.message };
        envelopes.push(
          envelopeFrom({
            record,
            eventId: eventId.value,
            eventType: event.eventType,
            schemaVersion: event.schemaVersion,
            source: "polymarket",
            sourceChannel: event.provenance.sourceChannel,
            ...(event.provenance.venueTimestamp === undefined
              ? {}
              : { venueTimestamp: event.provenance.venueTimestamp }),
            payload: event.payload,
          }),
        );
      }
      return { ok: true, envelopes };
    },
  };
}
