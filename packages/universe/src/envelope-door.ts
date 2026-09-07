/**
 * THE ENVELOPE DOOR — `docs/contracts/schema-boundary.md` §5 item 9(b).
 *
 * ## The defeat this closes, and why it is not the lifecycle door's
 *
 * `UNIV-1` closed `applyMarketLifecycleEvent`: the §7.4 payload is materialized
 * prototype-free before `zod` sees it, so a declared key the payload does not
 * carry cannot be answered by `Object.prototype`. That door is sound about the
 * value it is GIVEN — and `./envelope.ts` used to give it the wrong one.
 *
 * `DOMAIN_EVENT_REGISTRY.safeParseEnvelope` parses the caller's LIVE envelope
 * and returns `zod`'s own output. A declared key read off the prototype during
 * that parse lands in that output as a GENUINE OWN PROPERTY, and the payload
 * handed on to the lifecycle door is then indistinguishable from one the
 * envelope really carried. `UNIV-1`'s reviewer reproduced this END TO END at
 * the tip, and `UNIV-2` reproduced it again at base `989d41d`:
 *
 * ```text
 * inherited payload.outcome non-enum: converted OK; payload OWN outcome="YES_WIN";
 *   fold=OK lifecycleState=RESOLVED outcomeState=YES_WIN
 * inherited payload.resolvedAt non-enum: … fold=OK lifecycleState=RESOLVED
 *   resolvedAt=2099-01-01T00:00:00Z
 * inherited payload non-enum: (the WHOLE payload from the prototype)
 *   fold=OK lifecycleState=RESOLVED resolvedAt=2099-01-01T00:00:00Z
 * ```
 *
 * The projection's ONE irreversible transition, reached through a doored
 * function, from a value the envelope did not carry. The sweep found the same
 * for all 10 required and all 7 optional envelope keys — including
 * `gatewayEpoch` and `ingestSeq`, the §7.1 ORDERING keys the replay guard
 * compares (`order={"ingestSeq":"999"}` from the prototype).
 *
 * ## What this door performs, stated per `schema-boundary.md` §4
 *
 * - **D1** — {@link readOwnPayload} (`./lifecycle-door.ts`) materializes the
 *   whole envelope, payload included, before the frozen registry sees it.
 * - **D2 — NOT PERFORMED, disclosed** (no severed arena is reachable from this
 *   package: `dependency-direction.md` has no universe → risk edge). The
 *   compensation is {@link ENVELOPE_FIELDS}: this door re-states, on its own
 *   reads, the presence and shape the §7.1 envelope schema declares for all 17
 *   keys, so an envelope missing a declared key is refused with every `zod`
 *   check switched off.
 * - **D3** — `eventType`, `payload` and both ordering fields are taken from the
 *   materialized tree, never from `parsed.envelope`.
 * - **D4** — the emitted input and its `order` are built with
 *   `Object.create(null)` and frozen, so the record handed to
 *   `applyMarketLifecycleEvent` cannot answer `payload`, `eventType` or
 *   `order.ingestSeq` from the prototype either.
 * - **Refusal construction is contained** — measured at base: an inherited
 *   `get`, `value` or `_zod` turned this function's clean
 *   `UNIVERSE_INPUT_INVALID` into an escaping `TypeError`
 *   (`Cannot read properties of undefined (reading 'has')`), and `message`
 *   turned it into `Cannot assign to read only property 'message'`.
 *   `safeParseEnvelope` itself re-throws anything that is not one of its three
 *   typed errors, so the containment has to live here.
 *
 * ## What this door does NOT re-state (owned residual)
 *
 * The envelope FORMATS that are not presence, bound, or vocabulary: the UUID
 * and UUIDv7 patterns on `eventId`/`gatewayEpoch`, the `CodeString` character
 * class on `eventType`, and the full ISO-8601 shape on the two instants (only
 * that an instant PARSES is re-stated). `ingestSeq`/`receivedMonotonicNs`/
 * `rawRecordOffset` ARE re-stated to the canonical unsigned-integer grammar,
 * because `./lifecycle.ts`'s replay guard hands `ingestSeq` to `BigInt(...)`,
 * which throws on anything else. The payload's own declared keys are
 * `./lifecycle-door.ts`'s obligation, not this one's: this door only guarantees
 * that what arrives there is what the envelope actually carried.
 */

import { DOMAIN_EVENT_REGISTRY, EventSourceSchema } from "@polymarket-bot/domain";

import {
  CODE_STRING,
  IDENTIFIER,
  INSTANT,
  NON_EMPTY_STRING,
  NON_NEGATIVE_INTEGER,
  OPAQUE_RECORD,
  POSITIVE_INTEGER,
  UNSIGNED_INTEGER_STRING,
  declaredField,
  openOwnValue,
  ownRecord,
  readDeclaredFields,
  type DeclaredField,
} from "./caller-door.js";
import type { EventOrder } from "./lifecycle.js";

/** The frozen `EventSource` vocabulary, read from the schema rather than retyped. */
const EVENT_SOURCES: readonly string[] = Object.freeze([...EventSourceSchema.options]);

/**
 * Every key the §7.1 envelope declares — the required-key sweep, turned into
 * this door's own read list.
 *
 * A key MISSING from this table is a key the door could still adopt, so the
 * table is not allowed to drift: `./envelope-door.test.ts` derives the key set
 * and the required/optional split FROM the frozen contract's `envelopeSchema`
 * (all eight lifecycle contracts share it) and fails when the two disagree.
 */
export const ENVELOPE_FIELDS: readonly DeclaredField[] = Object.freeze([
  declaredField("eventId", IDENTIFIER),
  declaredField("source", Object.freeze({ kind: "vocabulary", options: EVENT_SOURCES })),
  declaredField("sourceChannel", NON_EMPTY_STRING),
  declaredField("venueTimestamp", INSTANT, false),
  declaredField("receivedAt", INSTANT),
  declaredField("receivedMonotonicNs", UNSIGNED_INTEGER_STRING),
  declaredField("gatewayEpoch", IDENTIFIER),
  declaredField("ingestSeq", UNSIGNED_INTEGER_STRING),
  declaredField("connectionId", NON_EMPTY_STRING, false),
  declaredField("subscriptionGeneration", NON_NEGATIVE_INTEGER, false),
  declaredField("rawSegmentId", NON_EMPTY_STRING, false),
  declaredField("rawRecordOffset", UNSIGNED_INTEGER_STRING, false),
  declaredField("correlationId", NON_EMPTY_STRING, false),
  declaredField("causationId", NON_EMPTY_STRING, false),
  declaredField("eventType", CODE_STRING),
  declaredField("schemaVersion", POSITIVE_INTEGER),
  declaredField("payload", OPAQUE_RECORD),
]);

/** What the door read out of a recorded envelope. */
export interface OwnEnvelope {
  readonly eventType: string;
  /** The materialized payload: own data, null prototype, exactly what the envelope carried. */
  readonly payload: unknown;
  readonly order: EventOrder;
}

/** A refusal the caller renders. `contractError` is the frozen contract's own failure. */
export type EnvelopeDoorRead =
  | { readonly ok: true; readonly value: OwnEnvelope }
  | {
      readonly ok: false;
      readonly contractError?: { readonly message: string; readonly name: string };
      readonly issues?: readonly string[];
    };

/**
 * Runs the frozen registry's routing, validation and provenance check inside a
 * containment.
 *
 * `safeParseEnvelope` catches its own three typed errors and RE-THROWS anything
 * else, which is precisely the ADR-020 error-construction class: at base five
 * of ten hostile prototype shapes escaped this function as a `TypeError`.
 */
function containedEnvelopeParse(
  value: unknown,
): { readonly ok: true } | { readonly ok: false; readonly message: string; readonly name: string } {
  try {
    const parsed = DOMAIN_EVENT_REGISTRY.safeParseEnvelope(value);
    if (parsed.ok) {
      return { ok: true };
    }
    return { ok: false, message: parsed.error.message, name: parsed.error.name };
  } catch {
    return {
      ok: false,
      message:
        "the frozen contract could not judge this envelope (its refusal could not be constructed); refused",
      name: "ContainedEnvelopeParseFailure",
    };
  }
}

/**
 * THE DOOR, in the order the steps must happen.
 *
 * 1. **D1** materialize the caller's envelope prototype-free;
 * 2. judge the MATERIALIZED tree against the frozen contract, with the routing,
 *    the validation, the provenance check and the refusal rendering all
 *    contained;
 * 3. **D2 compensation** re-state, on own reads of the same tree, what the §7.1
 *    envelope declares;
 * 4. **D3/D4** build the emitted record from that tree, prototype-free.
 *
 * Step 2 runs before step 3 so an honest refusal keeps the frozen contract's
 * own message, byte for byte.
 */
export function openLifecycleEnvelope(value: unknown): EnvelopeDoorRead {
  const own = openOwnValue(value);
  if (!own.ok) {
    return { ok: false, issues: own.issues };
  }
  const parsed = containedEnvelopeParse(own.value);
  if (!parsed.ok) {
    return { ok: false, contractError: { message: parsed.message, name: parsed.name } };
  }
  const read = readDeclaredFields(ENVELOPE_FIELDS, own.value);
  if (!read.ok) {
    return { ok: false, issues: read.issues };
  }
  return {
    ok: true,
    value: {
      eventType: read.value["eventType"] as string,
      payload: read.value["payload"],
      order: ownRecord<EventOrder>({
        gatewayEpoch: read.value["gatewayEpoch"],
        ingestSeq: read.value["ingestSeq"],
      }),
    },
  };
}
