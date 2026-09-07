/**
 * Envelope adapter: a recorded §7.1 envelope in, a projection input out.
 *
 * The projection folds PAYLOADS; the ordering fields live on the ENVELOPE. This
 * module is the one place that reads an envelope, and it does so through the
 * frozen `DOMAIN_EVENT_REGISTRY`, which routes on `(eventType, schemaVersion)`
 * and validates against the contract that pair identifies — including the §7.1
 * provenance agreement. Re-implementing that routing here would give the
 * universe layer a second, drifting opinion about what a valid event is.
 *
 * It does NOT hand on the library's output. `./envelope-door.ts` (`UNIV-2`,
 * `schema-boundary.md` §5 item 9b) materializes the envelope prototype-free
 * first, contains the contract's routing and refusal construction, re-states
 * what §7.1 declares, and emits prototype-free — because an envelope-layer
 * adoption arrives at `applyMarketLifecycleEvent` as a GENUINE OWN KEY that its
 * own door provably cannot see. Measured at base: under a non-enumerable
 * inherited `outcome`, an envelope whose payload carried none RESOLVED the
 * market through the doored fold.
 *
 * Non-lifecycle events (book, reference, feed) are refused rather than ignored:
 * a caller handing a `BookSnapshot` to the universe projection has made a wiring
 * mistake, and silence would hide it.
 */

import { ownRecord } from "./caller-door.js";
import { openLifecycleEnvelope } from "./envelope-door.js";
import { universeFailure, universeOk, universeRefusal, type UniverseResult } from "./errors.js";
import {
  MARKET_LIFECYCLE_EVENT_TYPES,
  type EventOrder,
  type MarketLifecycleEventType,
  type MarketLifecycleInput,
} from "./lifecycle.js";

const LIFECYCLE_EVENT_TYPES = new Set<string>(MARKET_LIFECYCLE_EVENT_TYPES);

/** The projection input carried by an envelope, plus the identifiers it names. */
export interface EnvelopeLifecycleInput extends MarketLifecycleInput {
  readonly order: EventOrder;
  /** The market the payload names, so the caller need not re-read the payload. */
  readonly internalMarketId: string;
}

/**
 * Converts a recorded envelope into a projection input.
 *
 * Refuses an envelope that fails the frozen contract, and one whose event type
 * this projection does not fold.
 */
export function marketLifecycleInputFromEnvelope(
  value: unknown,
): UniverseResult<EnvelopeLifecycleInput> {
  const opened = openLifecycleEnvelope(value);
  if (!opened.ok) {
    if (opened.contractError !== undefined) {
      return universeFailure(
        universeRefusal(
          "UNIVERSE_INPUT_INVALID",
          `envelope failed the frozen domain contract: ${opened.contractError.message}`,
          { errorName: opened.contractError.name },
        ),
      );
    }
    const issues = opened.issues ?? [];
    return universeFailure(
      universeRefusal("UNIVERSE_INPUT_INVALID", `envelope is invalid: ${issues.join("; ")}`, {
        issues,
      }),
    );
  }

  const envelope = opened.value;
  if (!LIFECYCLE_EVENT_TYPES.has(envelope.eventType)) {
    return universeFailure(
      universeRefusal(
        "UNIVERSE_EVENT_UNSUPPORTED",
        `${envelope.eventType} is not a market lifecycle event; the universe projection folds only ${MARKET_LIFECYCLE_EVENT_TYPES.join(", ")}`,
        { eventType: envelope.eventType },
      ),
    );
  }

  // An OWN read of the materialized payload: the door already guaranteed there
  // is no chain here, and this keeps that guarantee visible at the call site.
  const payload = envelope.payload as object;
  const internalMarketId = Object.hasOwn(payload, "internalMarketId")
    ? (payload as { readonly internalMarketId?: unknown }).internalMarketId
    : undefined;
  /* c8 ignore next 10 -- unreachable: every lifecycle contract requires the field. */
  if (typeof internalMarketId !== "string") {
    return universeFailure(
      universeRefusal(
        "UNIVERSE_INPUT_INVALID",
        "lifecycle payload carries no internal market id",
        { eventType: envelope.eventType },
      ),
    );
  }

  return universeOk(
    ownRecord<EnvelopeLifecycleInput>({
      eventType: envelope.eventType as MarketLifecycleEventType,
      payload: envelope.payload,
      order: envelope.order,
      internalMarketId,
    }),
  );
}
