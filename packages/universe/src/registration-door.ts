/**
 * THE REGISTRATION DOORS — `docs/contracts/schema-boundary.md` §5 item 9(a).
 *
 * One door per caller-input boundary in `./registry.ts`. Each performs the four
 * steps `./caller-door.ts` documents (D1 materialize, contained judge, D3 take
 * every emitted value from the materialized tree, D4 emit prototype-free), and
 * each states below what it does NOT re-state.
 *
 * ## The base measurement (`989d41d`, real base code, both variants)
 *
 * | door | cells that adopted at base |
 * | --- | --- |
 * | `registerSeries` | 9/9 declared keys, incl. a fabricated approved `binding` |
 * | `registerMarket` | 7/7 identity keys + `identity`/`parameters`/`metadataVersion` |
 * | `approveSeries` | `seriesId`, `approvedBy`, `approvedAt` |
 * | `bindMarketToSeries` | all four, in BOTH variants |
 * | `recordMarketParameters` | 3/3 observation keys + 8/8 snapshot members |
 * | `applyMarketEvent` | `eventType`, `payload`, `order`, in BOTH variants |
 * | `recordMarketOutcomeState` | `outcomeState`, `observedAt`, `observedBy`, BOTH variants |
 *
 * The sharpest three, verbatim from the transcript in `docs/handoffs`:
 * a series stored with `{"approved":true,"approvedBy":"ghost"}` after which
 * `bindMarketToSeries` returned OK; `registerMarket(registry, {})` registering
 * a whole market; and `"tickSize":"0.99"` — an ECONOMIC parameter — landing in
 * an immutable recorded parameter version.
 *
 * ## What these doors deliberately do NOT change
 *
 * - **The parameter observation is materialized, not re-stated.**
 *   `./parameters.ts` owns that schema and THROWS `UniverseValidationError` on
 *   an invalid observation (its documented contract, and the verdict every
 *   existing caller sees). Materializing closes the whole adoption class —
 *   including all eight snapshot members — because the tree handed to `zod` has
 *   no chain to read; re-stating it here would change an honest THROW into a
 *   refusal and move a verdict this grant must preserve. The library's own
 *   output assembly (the ADR-020 "loss" class) therefore still runs inside
 *   `./parameters.ts`. Owner: the `packages/universe` state-side follow-up.
 * - **`metadataVersion`, `approvedBy` and `approvedAt` are read, not judged.**
 *   Base validates none of them (`input.metadataVersion ?? 1` flows straight
 *   into the projection; the two review facts flow straight into the binding
 *   `approvedSeriesBinding` builds). A re-statement here would be STRICTER than
 *   base and would refuse inputs base accepts. Their ADOPTION is closed; their
 *   validation is a separate, disclosed question.
 * - **Formats are not re-stated** (the UUIDv7 pattern, the token-id and
 *   condition-id grammars, the `CodeString` character class, the full ISO-8601
 *   shape), exactly as in `./lifecycle-door.ts`. With `zod`'s checks intact the
 *   frozen schemas enforce them; under an inherited `skipChecks` the verdict is
 *   base-identical rather than improved.
 */

import type { MarketDiscoveredPayload } from "@polymarket-bot/domain";

import {
  CODE_STRING,
  DETAIL_STRING,
  FLAG,
  IDENTIFIER,
  INSTANT,
  NON_EMPTY_STRING,
  asOwnRecord,
  contained,
  declaredField,
  openOwnValue,
  ownRecord,
  readDeclaredFields,
  readOwnFields,
  type DeclaredField,
  type DoorRead,
} from "./caller-door.js";
import { MarketIdentitySchema, type MarketIdentity } from "./identity.js";
import { containedParse, type OwnRecord } from "./lifecycle-door.js";
import type { EventOrder, MarketLifecycleEventType, MarketLifecycleInput } from "./lifecycle.js";
import { SeriesDefinitionSchema, type SeriesDefinition } from "./series.js";

// ---------------------------------------------------------------------------
// The declared tables. `./registration-door.test.ts` derives each one from the
// frozen schema's own shape and fails when the two disagree, so a key added to
// a schema without being doored fails the suite.
// ---------------------------------------------------------------------------

/** `SeriesBindingApprovalSchema` — the §9.2 review gate, as a discriminated union. */
const SERIES_BINDING_ARMS: Readonly<Record<string, readonly DeclaredField[]>> = Object.freeze({
  false: Object.freeze([declaredField("approved", FLAG)]),
  true: Object.freeze([
    declaredField("approved", FLAG),
    declaredField("approvedBy", NON_EMPTY_STRING),
    declaredField("approvedAt", INSTANT),
  ]),
});

/** `SeriesDefinitionSchema`, in the frozen schema's own key order. */
export const SERIES_DEFINITION_FIELDS: readonly DeclaredField[] = Object.freeze([
  declaredField("seriesId", IDENTIFIER),
  declaredField("seriesKey", CODE_STRING),
  declaredField("displayName", NON_EMPTY_STRING),
  declaredField("underlyingSymbol", CODE_STRING),
  declaredField("cadence", CODE_STRING, false),
  declaredField("description", DETAIL_STRING, false),
  declaredField(
    "binding",
    Object.freeze({ kind: "variant", discriminator: "approved", arms: SERIES_BINDING_ARMS }),
  ),
  declaredField("activeSettlementSpecId", IDENTIFIER, false),
  declaredField("active", FLAG),
]);

/** `MarketIdentitySchema`, in the frozen schema's own key order. */
export const MARKET_IDENTITY_FIELDS: readonly DeclaredField[] = Object.freeze([
  declaredField("internalMarketId", IDENTIFIER),
  declaredField("conditionId", NON_EMPTY_STRING),
  declaredField("venueEventId", NON_EMPTY_STRING, false),
  declaredField("venueMarketSlug", NON_EMPTY_STRING, false),
  declaredField("yesTokenId", NON_EMPTY_STRING),
  declaredField("noTokenId", NON_EMPTY_STRING),
  declaredField("questionTitle", DETAIL_STRING, false),
]);

/**
 * `MarketRegistrationInput` — a caller record with no schema, so its declared
 * table is the door's own, and `./registration-door.test.ts` pins it against
 * the interface.
 */
export const MARKET_REGISTRATION_KEYS: readonly string[] = Object.freeze([
  "identity",
  "parameters",
  "metadataVersion",
]);

/** `approveSeries`'s input record. */
export const SERIES_APPROVAL_KEYS: readonly string[] = Object.freeze([
  "seriesId",
  "approvedBy",
  "approvedAt",
]);

/** `bindMarketToSeries`'s input record. */
export const SERIES_BINDING_KEYS: readonly string[] = Object.freeze([
  "internalMarketId",
  "seriesId",
  "approvedBy",
  "approvedAt",
]);

/** `MarketLifecycleInput`, as `applyMarketEvent` receives it. */
export const LIFECYCLE_INPUT_KEYS: readonly string[] = Object.freeze([
  "eventType",
  "payload",
  "order",
]);

/** `EventOrder` (§7.1 ordering; `ingestSeq` is compared with `BigInt`). */
export const EVENT_ORDER_KEYS: readonly string[] = Object.freeze(["gatewayEpoch", "ingestSeq"]);

/** `ObservedOutcomeStateInput`. */
export const OBSERVED_OUTCOME_STATE_KEYS: readonly string[] = Object.freeze([
  "outcomeState",
  "observedAt",
  "observedBy",
]);

// ---------------------------------------------------------------------------
// The doors
// ---------------------------------------------------------------------------

/**
 * `registerSeries`'s door.
 *
 * Step order matters and is the same as `./lifecycle-door.ts`'s: the frozen
 * schema judges the MATERIALIZED tree first, so an honest-but-wrong definition
 * keeps the schema's own message byte for byte; the declared read then rebuilds
 * the definition from that same tree.
 */
export function openSeriesDefinition(value: unknown): DoorRead<SeriesDefinition> {
  return contained(() => {
    const own = openOwnValue(value);
    if (!own.ok) {
      return own as DoorRead<SeriesDefinition>;
    }
    const parsed = containedParse(SeriesDefinitionSchema, own.value);
    if (!parsed.ok) {
      return { ok: false, issues: parsed.issues };
    }
    const read = readDeclaredFields(SERIES_DEFINITION_FIELDS, own.value);
    return read.ok
      ? { ok: true, value: read.value as unknown as SeriesDefinition }
      : { ok: false, issues: read.issues };
  }, "series definition");
}

/**
 * `approveSeries`'s door: the candidate definition, built prototype-free from
 * the stored series and the two review facts the caller supplied.
 *
 * The candidate is built with a null prototype BEFORE the frozen schema sees
 * it, which is what closes the base row: at base the candidate was
 * `{...series, binding}` — an ordinary object — so `zod` answered every key the
 * stored series did not carry from `Object.prototype`, and the two review facts
 * themselves were read off the caller's prototype chain.
 */
export function openApprovedSeriesDefinition(
  stored: SeriesDefinition,
  approvedBy: unknown,
  approvedAt: unknown,
): DoorRead<SeriesDefinition> {
  return contained(() => {
    const fields = Object.create(null) as Record<string, unknown>;
    for (const field of SERIES_DEFINITION_FIELDS) {
      if (field.key === "binding") {
        continue;
      }
      if (Object.hasOwn(stored, field.key)) {
        fields[field.key] = (stored as unknown as Record<string, unknown>)[field.key];
      }
    }
    // An absent review fact is left ABSENT rather than written as `undefined`:
    // `zod` renders both as "expected string, received undefined", so the
    // refusal message is the one base produced.
    fields["binding"] = ownRecord({ approved: true, approvedBy, approvedAt });
    const candidate = ownRecord<OwnRecord>(fields);
    const parsed = containedParse(SeriesDefinitionSchema, candidate);
    if (!parsed.ok) {
      return { ok: false, issues: parsed.issues };
    }
    const read = readDeclaredFields(SERIES_DEFINITION_FIELDS, candidate);
    return read.ok
      ? { ok: true, value: read.value as unknown as SeriesDefinition }
      : { ok: false, issues: read.issues };
  }, "series approval");
}

/**
 * `registerMarket`'s identity door — the binding `WP-040`'s
 * `markets_immutable_identity` trigger protects.
 *
 * The cross-field rule (`yesTokenId !== noTokenId`) is re-stated because it is
 * a `.superRefine`, and a custom check is skipped wholesale by an inherited
 * `when` (ADR-020 §1 class 6). Two markets sharing an outcome token make every
 * book update ambiguous, and the registry's own token index would hold one
 * entry for two markets.
 */
export function openMarketIdentity(value: unknown): DoorRead<MarketIdentity> {
  return contained(() => {
    const own = openOwnValue(value);
    if (!own.ok) {
      return own as DoorRead<MarketIdentity>;
    }
    const parsed = containedParse(MarketIdentitySchema, own.value);
    if (!parsed.ok) {
      return { ok: false, issues: parsed.issues };
    }
    const read = readDeclaredFields(MARKET_IDENTITY_FIELDS, own.value);
    if (!read.ok) {
      return { ok: false, issues: read.issues };
    }
    const identity = read.value as unknown as MarketIdentity;
    if (identity.yesTokenId === identity.noTokenId) {
      return {
        ok: false,
        issues: ["noTokenId: the YES and NO outcome tokens must be different tokens"],
      };
    }
    return { ok: true, value: identity };
  }, "market identity");
}

/** What `registerMarket` reads out of its own input record. */
export interface OwnMarketRegistrationInput {
  readonly identity: unknown;
  readonly parameters: unknown;
  readonly metadataVersion: unknown;
}

/**
 * `registerMarket`'s input door.
 *
 * At base `registerMarket(registry, {})` registered a market whose identity AND
 * parameter observation both came from `Object.prototype`, and an inherited
 * `metadataVersion: 77` landed in the projection.
 */
export function openMarketRegistrationInput(
  value: unknown,
): DoorRead<OwnMarketRegistrationInput> {
  const own = openOwnValue(value);
  if (!own.ok) {
    return own as DoorRead<OwnMarketRegistrationInput>;
  }
  const read = readOwnFields(
    asOwnRecord(own.value),
    MARKET_REGISTRATION_KEYS,
    "a market registration",
  );
  if (!read.ok) {
    return { ok: false, issues: read.issues };
  }
  return {
    ok: true,
    value: {
      identity: read.value["identity"],
      parameters: read.value["parameters"],
      metadataVersion: read.value["metadataVersion"],
    },
  };
}

/** What the two approval doors read out of their input records. */
export interface OwnApprovalInput {
  readonly seriesId: unknown;
  readonly internalMarketId: unknown;
  readonly approvedBy: unknown;
  readonly approvedAt: unknown;
}

/**
 * The door shared by `approveSeries` and `bindMarketToSeries`.
 *
 * Both write a human review into the registry, and at base BOTH read the
 * approver, the instant, and even the ids they act on off `Object.prototype` —
 * in both pollution variants, because no `zod` schema stands between the
 * caller's record and the stored binding.
 */
export function openApprovalInput(value: unknown, keys: readonly string[]): DoorRead<OwnApprovalInput> {
  const own = openOwnValue(value);
  if (!own.ok) {
    return own as DoorRead<OwnApprovalInput>;
  }
  const read = readOwnFields(asOwnRecord(own.value), keys, "an approval");
  if (!read.ok) {
    return { ok: false, issues: read.issues };
  }
  return {
    ok: true,
    value: {
      seriesId: read.value["seriesId"],
      internalMarketId: read.value["internalMarketId"],
      approvedBy: read.value["approvedBy"],
      approvedAt: read.value["approvedAt"],
    },
  };
}

/**
 * `recordMarketParameters`' and `registerMarket`'s observation door: D1 only.
 *
 * The materialized tree goes to `./parameters.ts` exactly as the caller's value
 * did, so the throw contract and every message are unchanged — and the whole
 * adoption class is closed, because a prototype-free tree has no chain for the
 * frozen schema to read a missing `tickSize`, `status` or `observedAt` from.
 */
export function openParameterObservation(value: unknown): DoorRead<unknown> {
  return openOwnValue(value);
}

/**
 * `applyMarketEvent`'s input door.
 *
 * SHALLOW by design: `payload` is handed on untouched to
 * `./lifecycle-door.ts`, which materializes and judges it. `order` IS rebuilt
 * prototype-free, because `./lifecycle.ts` stores it as `lastEventOrder` and
 * then reads `last.gatewayEpoch` and `BigInt(order.ingestSeq)` off it — a
 * record whose absent `gatewayEpoch` `Object.prototype` can answer is a replay
 * guard that compares against a value no event carried.
 */
export function openLifecycleEventInput(value: unknown): DoorRead<MarketLifecycleInput> {
  const read = readOwnFields(asOwnRecord(value), LIFECYCLE_INPUT_KEYS, "a market lifecycle input");
  if (!read.ok) {
    return read as DoorRead<MarketLifecycleInput>;
  }
  const rawOrder = read.value["order"];
  let order: EventOrder | undefined;
  if (rawOrder !== undefined) {
    const own = openOwnValue(rawOrder);
    if (!own.ok) {
      return { ok: false, issues: own.issues };
    }
    const fields = readOwnFields(asOwnRecord(own.value), EVENT_ORDER_KEYS, "an event order");
    if (!fields.ok) {
      return { ok: false, issues: fields.issues };
    }
    order = ownRecord<EventOrder>({
      gatewayEpoch: fields.value["gatewayEpoch"],
      ingestSeq: fields.value["ingestSeq"],
    });
  }
  // D4 as well: the record `./lifecycle.ts` receives is prototype-free, so its
  // own `input.order === undefined` test cannot be answered by the prototype
  // either.
  return {
    ok: true,
    value: ownRecord<MarketLifecycleInput>({
      eventType: read.value["eventType"] as MarketLifecycleEventType,
      payload: read.value["payload"],
      order,
    }),
  };
}

/**
 * `recordMarketOutcomeState`'s input door.
 *
 * At base `recordMarketOutcomeState(registry, id, {})` recorded `DISPUTED` from
 * the prototype in BOTH variants — the one state §9.3 lets an operator assert,
 * asserted by nobody.
 */
export function openObservedOutcomeStateInput(value: unknown): DoorRead<OwnRecord> {
  return readOwnFields(asOwnRecord(value), OBSERVED_OUTCOME_STATE_KEYS, "an observed outcome state");
}

/**
 * D4 for the §7.4 `MarketDiscovered` payload this package emits.
 *
 * `seriesId` is the optional field a consumer reads as
 * `event.seriesId === undefined` to decide whether the market has an APPROVED
 * series binding, and an ordinary object answers that question from
 * `Object.prototype`.
 */
export function ownDiscoveredEvent(
  fields: Readonly<Record<string, unknown>>,
): MarketDiscoveredPayload {
  return ownRecord<MarketDiscoveredPayload>(fields);
}
