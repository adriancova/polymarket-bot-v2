/**
 * Replay normalizers for the backtest composition root.
 *
 * Handoff §8.4: replay consumes "the same **normalized event envelopes**" the
 * live process consumed. Normalization belongs to the venue adapters (layer 2),
 * so `packages/simulation` takes a {@link ReplayNormalizer} port and this app —
 * the composition root — supplies one.
 *
 * Three are shipped:
 *
 * - {@link recordedFrameNormalizer}: verification only. It performs NO venue
 *   interpretation; it envelopes the recorded frame as-is so a dataset's
 *   ordering, checksums and counts can be verified without a market directory.
 *   Its `normalizerVersion` says so in its name, so a dataset pinned to a real
 *   normalizer refuses it (`REPLAY_MANIFEST_PIN_MISMATCH`).
 * - {@link polymarketMarketNormalizer}: the REAL `@polymarket-bot/polymarket-public`
 *   market-channel normalizer.
 * - {@link normalizedEnvelopeNormalizer} (BACKTEST-1): replays a recording of
 *   the NORMALIZED §7.4 stream — the envelopes the paper core consumes — rather
 *   than raw venue frames. Each recorded frame carries what the gateway ADDED
 *   to a raw frame (the routing pair, the channel, the venue instant it read
 *   and the normalized payload); provenance is the frame's own. Every envelope
 *   it emits is validated against the frozen `packages/domain` contract before
 *   delivery, through a prototype-free arena copy (schema-boundary §6 rule 1).
 *   It exists because two events the Static Bracket round trip needs —
 *   `MarketOpened` and `MarketClosing` — have NO raw-frame origin on any venue
 *   channel and no producer in this repository yet, so a raw-frame dataset
 *   cannot drive the core through a lifecycle at all.
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

import { DOMAIN_EVENT_REGISTRY } from "@polymarket-bot/domain";
import { prototypeFreeParser } from "@polymarket-bot/risk/schema-arena";
import {
  deriveReplayEventId,
  ownFrozenTree,
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

/**
 * `normalizerVersion` of the normalized-envelope replay normalizer.
 *
 * The name states what the recording IS — the §7.4 normalized stream, not raw
 * venue frames — so a raw-frame dataset pinned to a venue normalizer refuses
 * this one (`REPLAY_MANIFEST_PIN_MISMATCH`) instead of being "replayed" by a
 * reader that would have treated its raw text as an envelope.
 */
export const NORMALIZED_ENVELOPE_NORMALIZER_VERSION = "backtest-cli/normalized-envelope/v1";

/**
 * Builds one envelope from the recorded frame and the fields a normalizer
 * derived.
 *
 * `venueTimestamp` is a REQUIRED own key whose value may be `undefined`
 * (BT1-R4, `BACKTEST-2`): it used to be optional, so an input that carried
 * none read it off `Object.prototype`, and the §4 item 5 battery
 * (`normalizer-battery.test.ts`) measured an inherited `venueTimestamp` being
 * ADOPTED into every envelope whose recording had none.
 */
function envelopeFrom(input: {
  readonly record: ReplayRecord;
  readonly eventId: string;
  readonly eventType: string;
  readonly schemaVersion: number;
  readonly source: EventEnvelope<unknown>["source"];
  readonly sourceChannel: string;
  readonly venueTimestamp: string | undefined;
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
            venueTimestamp: undefined,
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
            venueTimestamp: event.provenance.venueTimestamp,
            payload: event.payload,
          }),
        );
      }
      return { ok: true, envelopes };
    },
  };
}

// ---------------------------------------------------------------------------
// The normalized-envelope replay normalizer (BACKTEST-1)
// ---------------------------------------------------------------------------

/**
 * What one recorded frame of a normalized-stream recording carries in its
 * `payloadUtf8`: the fields the gateway ADDED to the raw frame it normalized.
 *
 * Provenance — `gatewayEpoch`, `ingestSeq`, `receivedAt`, `receivedMonotonicNs`,
 * `connectionId`, `subscriptionGeneration` — is NOT restated here. The frame
 * already carries it, `DatasetEventSource` re-checks it, and a second copy
 * inside the payload would be a second authority on the one thing a replay
 * must copy verbatim (module header, "Provenance is copied, never restated").
 * `eventId` is likewise absent: §12.4 derives it from the recorded identity.
 */
interface RecordedNormalizedEnvelope {
  readonly eventType: string;
  readonly schemaVersion: number;
  readonly sourceChannel: string;
  /** Own, always present: `undefined` when the recording carries none (BT1-R4). */
  readonly venueTimestamp: string | undefined;
  readonly payload: unknown;
}

/**
 * **D2** — one warmed arena copy of every registered contract's envelope
 * schema, built at module load (the `apps/trader/src/event-door.ts` pattern:
 * "no lazy is ever forced cold"). Every §7.4 contract, not only the ones the
 * core consumes, because this normalizer replays whatever the recording
 * carries and lets the core's own door decide what it consumes.
 */
const ENVELOPE_DOORS: ReadonlyMap<string, { safeParse(value: unknown): { success: boolean } }> =
  (() => {
    const doors = new Map<string, { safeParse(value: unknown): { success: boolean } }>();
    for (const contract of DOMAIN_EVENT_REGISTRY.contracts) {
      doors.set(
        `${contract.eventType}@${String(contract.schemaVersion)}`,
        prototypeFreeParser(contract.envelopeSchema),
      );
    }
    return doors;
  })();

function readRecordedNormalizedEnvelope(
  value: unknown,
):
  | { readonly ok: true; readonly recorded: RecordedNormalizedEnvelope }
  | { readonly ok: false; readonly reason: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "a recorded normalized envelope is a JSON object" };
  }
  const record = value as Record<string, unknown>;
  const eventType = record["eventType"];
  const schemaVersion = record["schemaVersion"];
  const sourceChannel = record["sourceChannel"];
  const venueTimestamp = record["venueTimestamp"];
  if (typeof eventType !== "string" || eventType === "") {
    return { ok: false, reason: "the recorded envelope names no eventType" };
  }
  if (
    typeof schemaVersion !== "number" ||
    !Number.isSafeInteger(schemaVersion) ||
    schemaVersion < 1
  ) {
    return { ok: false, reason: "the recorded envelope's schemaVersion is not a positive integer" };
  }
  if (typeof sourceChannel !== "string" || sourceChannel === "") {
    return { ok: false, reason: "the recorded envelope names no sourceChannel" };
  }
  if (venueTimestamp !== undefined && typeof venueTimestamp !== "string") {
    return { ok: false, reason: "the recorded envelope's venueTimestamp is not a string" };
  }
  if (!Object.hasOwn(record, "payload")) {
    return { ok: false, reason: "the recorded envelope carries no payload" };
  }
  return {
    ok: true,
    recorded: {
      eventType,
      schemaVersion,
      sourceChannel,
      venueTimestamp,
      payload: record["payload"],
    },
  };
}

/**
 * Replays a recording of the NORMALIZED §7.4 stream — one recorded frame, one
 * envelope, validated against its frozen contract before it is delivered.
 *
 * Conformance statement (`docs/contracts/schema-boundary.md` §4), because this
 * is a NEW boundary and §6 rule 1 binds it:
 *
 * 1. **D1** — the recorded payload is decoded by `packages/simulation`'s
 *    strict-JSON reader into a prototype-free tree; nothing here reads a
 *    declared key off a prototype.
 * 2. **D2** — the built envelope is parsed against a warmed ARENA COPY of the
 *    contract's own `envelopeSchema` ({@link ENVELOPE_DOORS}), which is the
 *    check the core's door will repeat on arrival.
 * 3. **D3** — the envelope this normalizer emits is built from the decoded
 *    tree and the frame; the schema's output is discarded.
 * 4. **D4** — it is emitted prototype-free and deep-frozen (`ownFrozenTree`).
 * 5. **The bound — a battery WAS RUN, and is pinned** (BT1-R4, `BACKTEST-2`;
 *    `normalizer-battery.test.ts`). Every frame of the committed fixture and
 *    one refused frame of each refusal kind below, under 33 inherited keys on
 *    `Object.prototype` (every declared key, the eleven zod state keys §2
 *    measured, the numeric names `"0"`, `"1"`, `"-1"`), each as a
 *    non-enumerable data property and as a get-only accessor. Pinned: no
 *    throw escapes; permission never widens (no refused frame is accepted);
 *    every accepted envelope is byte-identical to the clean run's,
 *    prototype-free and frozen. What may vary is availability, and the test
 *    pins exactly where: under a get-only numeric name (`"0"`, `"1"`) every
 *    frame is refused (fail closed) — `packages/simulation`'s identity reader
 *    refuses, and its strict-JSON parser throws from `Array.push`
 *    (`strict-json.ts`, outside this app), which the containment below turns
 *    into a refusal. The battery's first run found two defects in THIS door,
 *    both fixed here: an inherited `venueTimestamp` was ADOPTED into every
 *    envelope whose recording had none (see {@link envelopeFrom}); and zod's
 *    refusal construction THREW out of `safeParse` under an inherited
 *    `value`, `writable`, `_zod`, `get` or `set` (the §2 error-construction
 *    class), which escaped as an exception.
 *
 * A contract the registry does not carry, a payload the contract refuses, or
 * a `source` outside the §7.1 vocabulary is a REFUSAL of the frame — the
 * replay stops with the reason (§8.3) rather than delivering an envelope the
 * core would halt on or silently skip. So is ANY throw from the reads below
 * (ADR-020's 2026-09-06 containment amendment): a door that cannot finish
 * reading a frame refuses it, and the replay stops with a
 * `REPLAY_NORMALIZER_REFUSED` naming the frame, never an escaped exception.
 */
export function normalizedEnvelopeNormalizer(digest: Sha256HexDigest): ReplayNormalizer {
  return {
    normalizerVersion: NORMALIZED_ENVELOPE_NORMALIZER_VERSION,
    normalize(record: ReplayRecord): NormalizeOutcome {
      try {
        return normalizeRecordedEnvelope(digest, record);
      } catch (error) {
        return {
          ok: false,
          reason:
            `reading the recorded envelope threw (${error instanceof Error ? error.name : typeof error}); ` +
            "the door refuses a frame it cannot finish reading rather than deliver it or let the " +
            "exception escape (ADR-020 containment)",
        };
      }
    },
  };
}

/** {@link normalizedEnvelopeNormalizer}'s reads, uncontained; the caller contains them. */
function normalizeRecordedEnvelope(digest: Sha256HexDigest, record: ReplayRecord): NormalizeOutcome {
  if (!EVENT_SOURCES.includes(record.frame.source)) {
    return {
      ok: false,
      reason: `the recorded frame names source ${JSON.stringify(record.frame.source)}, which is not one of the §7.1 event sources`,
    };
  }
  const decoded = parseStrictJsonText(record.frame.payloadUtf8);
  if (!decoded.ok) {
    return {
      ok: false,
      reason: `the recorded payload is not strict JSON: ${decoded.problem.problem}`,
    };
  }
  const read = readRecordedNormalizedEnvelope(decoded.value);
  if (!read.ok) return { ok: false, reason: read.reason };
  const recorded = read.recorded;
  const door = ENVELOPE_DOORS.get(`${recorded.eventType}@${String(recorded.schemaVersion)}`);
  if (door === undefined) {
    return {
      ok: false,
      reason:
        `the recorded envelope names ${recorded.eventType}@${String(recorded.schemaVersion)}, ` +
        "which is not a registered packages/domain event contract",
    };
  }
  const eventId = deriveReplayEventId(digest, {
    gatewayEpoch: record.frame.gatewayEpoch,
    ingestSeq: record.frame.ingestSeq,
    receivedAt: record.frame.receivedAt,
    index: 0,
  });
  if (!eventId.ok) return { ok: false, reason: eventId.refusal.message };
  const envelope = ownFrozenTree(
    envelopeFrom({
      record,
      eventId: eventId.value,
      eventType: recorded.eventType,
      schemaVersion: recorded.schemaVersion,
      source: record.frame.source as EventEnvelope<unknown>["source"],
      sourceChannel: recorded.sourceChannel,
      venueTimestamp: recorded.venueTimestamp,
      payload: recorded.payload,
    }),
  );
  if (!door.safeParse(envelope).success) {
    return {
      ok: false,
      reason:
        `the recorded ${recorded.eventType}@${String(recorded.schemaVersion)} envelope failed ` +
        "its frozen packages/domain contract; §8.3 forbids delivering it silently altered or " +
        "dropping it",
    };
  }
  return { ok: true, envelopes: [envelope] };
}
