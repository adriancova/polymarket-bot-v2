/**
 * THE STATE-SIDE DOOR — `docs/contracts/schema-boundary.md` §5 item 9(c).
 *
 * ## The class this closes
 *
 * `UNIV-1` closed the §7.4 PAYLOAD boundary and `UNIV-2` closed the CALLER-INPUT
 * boundaries. Both left the third side open, and `UNIV-1`'s review named it
 * (r1 MED-1): the STATE the doored functions fold the payload INTO is read with
 * `.` on a prototype-bearing `MarketProjection`. Five of its fields are
 * optional, so five questions the projection answers "no" to are answerable by
 * `Object.prototype`. Re-measured at base `c2c0733`, both pollution variants,
 * every cell:
 *
 * ```text
 * inherited rulesVersionId="rv-ghost" -> applyRulesChanged APPLIES over a rules
 *   hole where clean refuses UNIVERSE_RULES_VERSION_MISMATCH
 * inherited rulesVersionId=<the verdict's> -> evaluateMarketReadiness returns
 *   modelDependentActivationAllowed=true with NO refusals, where clean returns
 *   false + UNIVERSE_SETTLEMENT_RULES_VERSION_DRIFT   <- §9.2 activation
 * inherited openedAt=<the event's> -> MarketOpened is swallowed as idempotent;
 *   the market never leaves DISCOVERED
 * inherited openedAt=<another> -> MarketOpened refused UNIVERSE_LIFECYCLE_CONFLICT
 * inherited resolvedAt=<the event's> -> a SECOND resolution of an already
 *   resolved market is accepted as idempotent where clean refuses
 *   UNIVERSE_TERMINAL_OUTCOME_CONFLICT
 * inherited closesAt -> MarketClosing swallowed; effectiveCloseInstant answers
 *   an instant no event carried, and effectiveLifecycleState derives CLOSED
 * inherited lastEventOrder={gatewayEpoch,ingestSeq:"999"} -> every fresh event
 *   is dropped UNIVERSE_EVENT_REPLAYED
 * ```
 *
 * ## What this door performs, stated per `schema-boundary.md` §4
 *
 * - **D1 — the projection is read as OWN data before it is folded.**
 *   {@link openOwnProjection} rebuilds the caller's projection with
 *   `Object.create(null)` from its own ENUMERABLE data descriptors, refusing an
 *   accessor without invoking it. Own-enumerable is not an arbitrary choice: it
 *   is exactly what `{...projection}` — the spread every arm already used to
 *   build the next projection — copies, so an honest fold is unchanged while a
 *   non-enumerable own field can no longer be READ by a guard that would not
 *   PROPAGATE it. The five optional fields are then absent when the projection
 *   does not carry them, which is the whole class.
 * - **D2 — not performed, disclosed**, for the reason `./lifecycle-door.ts`
 *   gives (no severed arena is reachable without a forbidden edge). The
 *   compensation for the FORMATS the payload door left unstated is
 *   {@link restateDeclaredFormats}, which re-states the instant and decimal
 *   grammars — through `./grammar.ts`, which recomposes them from the frozen
 *   schemas' own artifacts rather than writing a second opinion.
 * - **D3** — the arms fold the READ record, never the caller's object.
 * - **D4** — {@link openEventOrder} emits the stored `lastEventOrder`
 *   prototype-free and frozen, so `last.gatewayEpoch` and `last.ingestSeq` — the
 *   §7.1 replay guard's two inputs — cannot be answered by `Object.prototype`
 *   on the NEXT fold either.
 *
 * ## What this door deliberately does not do
 *
 * The projection's nested values (`identity`, `seriesBinding`, `clarifications`,
 * `parameters`) are carried by REFERENCE, not copied: on every path that builds
 * a projection in this package they are already prototype-free or frozen
 * (`readDeclaredFields` emits `Object.create(null)`; `ownEmit` builds the
 * clarification records; `./parameters-door.ts` emits the parameter snapshot),
 * and copying them would change object identity for no measured gain. A
 * hand-built projection whose nested `identity` is prototype-bearing is
 * therefore still readable through its chain — disclosed, and out of the row's
 * class, which is the projection's OWN five optional fields.
 *
 * ## Deployment reading, required whenever this class is quoted
 *
 * Nothing on the wire can write `Object.prototype`: every row above needs code
 * already executing in the process. They still matter because what they reach is
 * the irreversible terminal transition, the §9.2 model-dependent activation
 * gate, and the §7.1 replay guard.
 */

import { MarketDiscoveredPayloadSchema } from "@polymarket-bot/domain";

import {
  IDENTIFIER,
  UNSIGNED_INTEGER_STRING,
  declaredField,
  openOwnValue,
  ownRecord,
  readDeclaredFields,
  type DeclaredField,
  type DoorRead,
} from "./caller-door.js";
import { isIsoTimestamp, isPositiveDecimalString } from "./grammar.js";
import { declaredKeysOf, ownDataDescriptor } from "./lifecycle-door.js";
import type { EventOrder, MarketLifecycleEventType, MarketProjection } from "./lifecycle.js";

// ---------------------------------------------------------------------------
// D1: the projection, read as own data
// ---------------------------------------------------------------------------

/**
 * A projection read as own data: null prototype, frozen, own values only.
 *
 * Typed as `MarketProjection` because it carries exactly the fields the caller's
 * projection carried — this door narrows what can be READ, never what the type
 * says is there.
 */
export type OwnProjection = MarketProjection;

/** The keys a fold cannot proceed without, and the shape each must have. */
const REQUIRED_STRUCTURE: readonly (readonly [string, (value: unknown) => boolean])[] = [
  ["identity", (value) => typeof value === "object" && value !== null],
  ["clarifications", (value) => Array.isArray(value)],
  ["parameters", (value) => typeof value === "object" && value !== null],
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads one own ENUMERABLE data property, refusing an accessor without invoking
 * it.
 *
 * Enumerability is the spread's own rule (see the header): a non-enumerable own
 * property was never propagated into the next projection, so reading one would
 * mean a guard could see a fact the fold then silently dropped.
 */
function ownEnumerableValue(
  container: object,
  key: string,
): { readonly present: boolean; readonly value: unknown; readonly accessor: boolean } {
  const descriptor = Object.getOwnPropertyDescriptor(container, key);
  if (descriptor === undefined || descriptor.enumerable !== true) {
    return { present: false, value: undefined, accessor: false };
  }
  // `Object.hasOwn`, not `in`: with an inherited `value` every accessor
  // descriptor would read as a data descriptor.
  if (!Object.hasOwn(descriptor, "value")) {
    return { present: false, value: undefined, accessor: true };
  }
  return { present: true, value: descriptor.value, accessor: false };
}

/**
 * D1. Reads a caller-supplied projection into a fresh prototype-free record of
 * its own enumerable data, or says why it is not one.
 *
 * `lastEventOrder` is materialized one level deeper, because `./lifecycle.ts`'s
 * replay guard reads `last.gatewayEpoch` and `BigInt(last.ingestSeq)` off it:
 * an order record whose absent `gatewayEpoch` `Object.prototype` answers is a
 * guard comparing against a value no event carried.
 */
export function openOwnProjection(projection: unknown): DoorRead<OwnProjection> {
  if (!isRecord(projection)) {
    return { ok: false, issues: ["(root): a market projection is a record"] };
  }
  const out = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(projection)) {
    const member = ownEnumerableValue(projection, key);
    if (member.accessor) {
      return {
        ok: false,
        issues: [
          `${key}: an accessor property: a getter is code rather than recorded state, and it is refused without being invoked`,
        ],
      };
    }
    // An own `undefined` is read as ABSENT — the verdict every door in this
    // package already gives it, and the one that cannot diverge from absence.
    if (!member.present || member.value === undefined) {
      continue;
    }
    if (key === "lastEventOrder") {
      const order = openEventOrder(member.value);
      if (!order.ok) {
        return { ok: false, issues: order.issues };
      }
      Object.defineProperty(out, key, ownDataDescriptor(order.value));
      continue;
    }
    Object.defineProperty(out, key, ownDataDescriptor(member.value));
  }
  for (const [key, isShape] of REQUIRED_STRUCTURE) {
    if (!isShape(out[key])) {
      // At base an absent `clarifications`/`parameters` was answered by
      // `Object.prototype` or threw a bare `TypeError` out of a function that
      // returns a typed result. Both become one typed refusal.
      return { ok: false, issues: [`${key}: the projection carries no usable ${key}`] };
    }
  }
  return { ok: true, value: Object.freeze(out) as unknown as OwnProjection };
}

/**
 * D4. A projection this package BUILDS, emitted prototype-free and frozen.
 *
 * The output-side half of the same row: `applyMarketLifecycleEvent` returns a
 * projection, and a consumer asks it `projection.rulesVersionId === undefined`
 * — `./eligibility.ts` does exactly that, and so does every operator view. An
 * ordinary object answers that question from `Object.prototype`, which is how
 * the class survives a door that only fixed the READ.
 *
 * IDEMPOTENT: a record this function already built is returned unchanged, so
 * storing an unmodified projection back into the registry does not replace it
 * with a copy and object identity survives an idempotent fold.
 */
export function ownProjectionRecord(projection: MarketProjection): MarketProjection {
  const source = projection as unknown as Record<string, unknown>;
  if (Object.getPrototypeOf(source) === null && Object.isFrozen(source)) {
    return projection;
  }
  const out = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    Object.defineProperty(out, key, ownDataDescriptor(source[key]));
  }
  return Object.freeze(out) as unknown as MarketProjection;
}

/**
 * The read surface with one more field, still prototype-free.
 *
 * Used for the §7.1 ordering field the fold writes before it dispatches: the
 * NEXT guard to read `lastEventOrder` must read it off a record with no chain,
 * exactly like the one {@link openOwnProjection} produced.
 */
export function withOwnField(own: OwnProjection, key: string, value: unknown): OwnProjection {
  const out = Object.create(null) as Record<string, unknown>;
  const source = own as unknown as Record<string, unknown>;
  let replaced = false;
  for (const existing of Object.keys(source)) {
    // Key ORDER is the spread's: an existing key keeps its position and a new
    // one is appended, so `{...own, [key]: value}` and this record enumerate
    // identically and the emitted projection's bytes do not move.
    const member = existing === key ? value : source[existing];
    replaced = replaced || existing === key;
    Object.defineProperty(out, existing, ownDataDescriptor(member));
  }
  if (!replaced) {
    Object.defineProperty(out, key, ownDataDescriptor(value));
  }
  return Object.freeze(out) as unknown as OwnProjection;
}

/**
 * One field of a projection, read as own enumerable data.
 *
 * The TOTAL form, for the readers that answer a question rather than a result
 * (`effectiveCloseInstant`, `evaluateMarketReadiness`): an absent field, an own
 * `undefined`, and an accessor all read as `undefined`, which is the same answer
 * an unpolluted process gives.
 */
export function ownProjectionField(projection: unknown, key: string): unknown {
  if (!isRecord(projection)) {
    return undefined;
  }
  const member = ownEnumerableValue(projection, key);
  return member.present ? member.value : undefined;
}

// ---------------------------------------------------------------------------
// The §7.1 event order (UNIV-2 r1 LOW — the `ingestSeq` re-statement gap)
// ---------------------------------------------------------------------------

/**
 * `EventOrder`, with the SAME shapes `./envelope-door.ts` already declares for
 * the two §7.1 ordering keys it reads off an envelope.
 *
 * `ingestSeq` is `UNSIGNED_INTEGER_STRING` because `./lifecycle.ts`'s replay
 * guard hands it to `BigInt(...)`, which THROWS on anything else. Measured at
 * base `c2c0733` through `applyMarketEvent`, with no pollution at all:
 *
 * ```text
 * order={"gatewayEpoch":"…"}            -> TypeError: Cannot convert undefined to a BigInt
 * order={…,"ingestSeq":5.5}             -> RangeError: … not an integer
 * order={…,"ingestSeq":"0x10"}          -> accepted, and ordered as 16
 * order={"ingestSeq":"9"}               -> accepted, and the replay guard is
 *                                          skipped entirely: an absent
 *                                          gatewayEpoch reads as a NEW epoch
 * ```
 *
 * `applyMarketEvent` returns a typed result and no caller in this repository
 * wraps it in a `try`, so the first two are availability defeats; the last two
 * are ordering defeats. All four become one typed refusal.
 */
export const EVENT_ORDER_FIELDS: readonly DeclaredField[] = Object.freeze([
  declaredField("gatewayEpoch", IDENTIFIER),
  declaredField("ingestSeq", UNSIGNED_INTEGER_STRING),
]);

/** D1 + the re-statement + D4 for one `EventOrder`. */
export function openEventOrder(value: unknown): DoorRead<EventOrder> {
  const own = openOwnValue(value);
  if (!own.ok) {
    return own as DoorRead<EventOrder>;
  }
  const read = readDeclaredFields(EVENT_ORDER_FIELDS, own.value);
  if (!read.ok) {
    return { ok: false, issues: read.issues };
  }
  return {
    ok: true,
    value: ownRecord<EventOrder>({
      gatewayEpoch: read.value["gatewayEpoch"],
      ingestSeq: read.value["ingestSeq"],
    }),
  };
}

// ---------------------------------------------------------------------------
// The metadata version, judged by the schema that will have to carry it
// ---------------------------------------------------------------------------

/**
 * `MarketDiscoveredPayloadSchema`'s OWN `metadataVersion` field (§7.4's
 * `VersionSchema` — `z.int().positive()`), reached through its shape.
 *
 * Read as an own property, so a `zod` whose internals moved degrades to the
 * restatement below rather than throwing at module load.
 */
const METADATA_VERSION_SCHEMA: { readonly safeParse: (value: unknown) => { success: boolean } } | undefined =
  (() => {
    const schema: unknown = MarketDiscoveredPayloadSchema;
    if (typeof schema !== "object" || schema === null || !Object.hasOwn(schema, "shape")) {
      return undefined;
    }
    const shape = (schema as Record<string, unknown>)["shape"];
    if (typeof shape !== "object" || shape === null || !Object.hasOwn(shape, "metadataVersion")) {
      return undefined;
    }
    const field = (shape as Record<string, unknown>)["metadataVersion"];
    return typeof field === "object" &&
      field !== null &&
      typeof (field as { safeParse?: unknown }).safeParse === "function"
      ? (field as { readonly safeParse: (value: unknown) => { success: boolean } })
      : undefined;
  })();

/**
 * The metadata version a registration may carry, defaulted the way base
 * defaulted it (`?? 1`).
 *
 * This is a BOUNDED tightening and nothing more (`UNIV-2` r1 disclosed it as an
 * undecided validation question; item 9(c) decides only the half that is
 * already decided elsewhere): the value is refused HERE exactly when the
 * `MarketDiscovered` payload this package emits would refuse it THERE. The
 * schema is asked first so the message is the contract's own; the own-read
 * restatement of `z.int().positive()` follows, because a check is switchable
 * off and an integer test is not.
 */
export function openMetadataVersion(value: unknown): DoorRead<number> {
  if (value === undefined) {
    return { ok: true, value: 1 };
  }
  const refusal: DoorRead<number> = {
    ok: false,
    issues: [
      "metadataVersion: the emitted MarketDiscovered payload declares a positive integer version",
    ],
  };
  if (METADATA_VERSION_SCHEMA !== undefined) {
    let accepted = false;
    try {
      accepted = METADATA_VERSION_SCHEMA.safeParse(value).success;
    } catch {
      // Refusal construction is a prototype-reading path (ADR-020 amendment).
      return refusal;
    }
    if (!accepted) {
      return refusal;
    }
  }
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? { ok: true, value }
    : refusal;
}

// ---------------------------------------------------------------------------
// D2 compensation: the two formats the payload door left unstated
// ---------------------------------------------------------------------------

/**
 * Re-states the FORMATS `./lifecycle-door.ts` discloses it does not re-state,
 * for the keys of one arm.
 *
 * The census is the DOOR'S OWN (`declaredKeysOf`), not a second table: a key
 * added to a frozen payload schema is doored and format-checked by the same
 * declaration, so the two cannot drift. Only the two shapes whose residual was
 * measured are re-stated here — `instant` (UNIV-1 r1 MED-2: the terminal
 * transition reached under an inherited `skipChecks`) and `decimalString`
 * (UNIV-1 r1 NOTE-2: `InvalidDecimalStringError` escaping out of the fold). The
 * identifier and code-string patterns remain unstated and are disclosed in
 * `./lifecycle-door.ts`'s header.
 *
 * With `zod`'s checks intact this refuses nothing the frozen schema accepted:
 * `./grammar.test.ts` proves it differentially, in both directions.
 */
export function restateDeclaredFormats(
  eventType: MarketLifecycleEventType,
  payload: Readonly<Record<string, unknown>>,
): readonly string[] {
  const issues: string[] = [];
  for (const entry of declaredKeysOf(eventType)) {
    if (!Object.hasOwn(payload, entry.key)) {
      continue;
    }
    const value = payload[entry.key];
    if (entry.shape === "instant" && !isIsoTimestamp(value)) {
      issues.push(
        `${entry.key}: the event's own ${entry.key} is not an ISO-8601 instant with a UTC designator or offset`,
      );
    }
    if (entry.shape === "decimalString" && !isPositiveDecimalString(value)) {
      issues.push(
        `${entry.key}: the event's own ${entry.key} is not a canonical decimal string greater than zero`,
      );
    }
  }
  return issues;
}
