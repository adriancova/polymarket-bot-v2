/**
 * THE GAMMA MARKET-STATE DOOR (`UNIV-4`, closeout blocker B10): read one
 * `GET /markets/{id}` body into plain OWN data, interpret ONLY the six fields
 * the venue documents, record every other top-level scalar without
 * interpreting it, and answer the documented readiness predicate.
 *
 * ## The whole licence, quoted (`docs/venue/verified-2026-09-16.md` D-30)
 *
 * The venue PUSHES no open/close/closing signal: the market WebSocket's
 * lifecycle events are exactly `new_market` and `market_resolved` (§3, U-12).
 * It DOCUMENTS a polled surface, `GET https://gamma-api.polymarket.com/markets/{id}`
 * (S-D34, the Gamma OpenAPI; also the `market-details` page S-D23), returning
 * a `Market` whose state fields are
 * `MarketState { active, closed, archived, acceptingOrders, enableOrderBook,
 * negRisk, startDate, endDate, closedTime }` — ALL nullable — and the
 * documented readiness predicate
 * **`isTradeReady = active && !closed && acceptingOrders`** (S-D23 lines
 * 227–231). Six fields carry documented semantics (S-D23 field table, lines
 * 302–307 and 876):
 *
 * - `active` — "Market is deployed and not archived."
 * - `closed` — "Market has resolved or been closed, so no further trading is
 *   possible."
 * - `acceptingOrders` — "Order book is open for new limit and market orders."
 * - `restricted` — "Market is geo-restricted for some jurisdictions."
 * - `archived` — "Market is archived and read-only: no trading, no resolution
 *   updates."
 * - `gameStartTime` — "Scheduled start time of the underlying game for a
 *   sports market."
 *
 * `acceptingOrdersTimestamp`, `ready`, `funded`, `automaticallyActive`,
 * `clearBookOnStart`, `manualActivation`, `closedTime`, `enableOrderBook`,
 * `startDate`, `endDate`, `umaEndDate`, `new`, `startDateIso`, `endDateIso`
 * carry NO documented semantics beyond their names: this door reads and
 * records them; nothing in this package interprets them. In particular
 * `endDate` is a schedule, not an observation. A polled field is a statement
 * about the venue's catalog at poll time, NOT an observed closure event
 * (register U-12 stands). Nothing beyond these facts is licensed here.
 *
 * ## What is interpreted and what is recorded
 *
 * {@link GammaMarketState} carries the six documented fields, each typed
 * `boolean | null` (`gameStartTime`: `string | null`). An ABSENT field is
 * `null`: the OpenAPI marks every one of them nullable, and a door that
 * refused a body for lacking `acceptingOrders` would refuse what the venue is
 * documented to send. `recorded` is a plain record of every OTHER top-level
 * scalar (string, number, boolean, null) exactly as the venue spelled it —
 * evidence for an operator and for the journaled raw body, never an
 * authority any derivation reads. Nested values (`clobTokenIds`, `events`,
 * `feeSchedule`, …) are not carried; the gateway journals the raw body.
 *
 * ## Top-level passthrough, argued and pinned
 *
 * The repository's convention for its OWN contracts is `z.strictObject`. It
 * is the wrong tool for this INBOUND venue shape: the Gamma `Market` object
 * gains and loses properties between SDK releases (D-19: `marketMakerAddress`
 * and every AMM field removed, `version` and `comboStatus` added; §10.5: the
 * OpenAPI is a SUBSET of what the SDK models). A strict door would refuse the
 * next Gamma release outright — the "door that REFUSES what the venue
 * actually sends" defect class. Unknown top-level keys are therefore ADMITTED
 * and recorded; only the six documented fields are type-checked. The contract
 * suite pins both halves (an extra key is admitted and lands in `recorded`; a
 * non-boolean `active` is refused).
 *
 * ## One refusal the venue could trigger, disclosed (r1, LOW-4)
 *
 * The materializer this door shares with the CLOB door, `readOwnWireValue`,
 * refuses a value nested deeper than `MAX_WIRE_DEPTH` (16) levels — the
 * whole body, not the deep member. A `Market` whose nested metadata (an
 * `events[]` entry, a `feeSchedule`, anything the OpenAPI lists as an
 * object) ever exceeds that depth would be refused as `invalid`, the poll
 * would fail loudly (`GATEWAY_LIFECYCLE_STATE_INVALID`), and nothing would be
 * derived — a fail-closed drift refusal, the same residual the CLOB door
 * records in `docs/handoffs/CLOB-1.md`. Every documented value sits at the
 * top level, so the cap is far from anything the venue publishes today; it
 * is stated here because a depth cap is a door that can refuse what the
 * venue sends.
 *
 * ## The readiness predicate fails closed on `null`
 *
 * The venue's snippet, evaluated in JavaScript on a body whose `closed` is
 * `null`, would answer TRUE (`!null === true`). This door answers FALSE
 * whenever any of the three fields is `null`: a market whose closed-ness the
 * venue did not state is not a market this repository asserts open. That is
 * the one place the door is STRICTER than the literal expression, and it is
 * stated and pinned rather than left to the reader.
 *
 * ## No `zod` schema, deliberately
 *
 * The documented shape is six nullable scalars. A door that re-states every
 * documented type on its own reads (below) is COMPLETE for it, so a library
 * parse would add nothing but the library's own defeat surface — and its
 * refusal composition: `zod@4.4.3`'s `ZodError` constructor runs
 * `JSON.stringify` over its issues, which under an inherited `toJSON` ran the
 * hook once per refusal when this door was first written with a schema
 * (measured, `test/contract/polymarket-public/gamma-market-state.test.ts`
 * section 4). The contract suite's SDK-anchor guard also requires every
 * EXPORTED object schema to be anchored to the official SDK at the pinned
 * commit with a field count read from its source; the SDK's modifiers for
 * `restricted` and `gameStartTime` are not recorded in the repository
 * (`docs/venue/verified-2026-09-16.md` D-30 records the SDK parsing seven
 * state fields, not these two), so an honest anchor could not be written.
 * The documented types are therefore declared once, in
 * {@link GAMMA_MARKET_DOCUMENTED_FIELDS}, and the door is derived from that
 * table. Every other venue door in this package keeps its schema; this one is
 * the first hand-written one and says so.
 *
 * ## What this door performs, stated per `docs/contracts/schema-boundary.md` §4
 *
 * - **D1 — materialize prototype-free before judging.** The body is rebuilt
 *   with `../venue/wire-door.ts`'s {@link readOwnWireValue}: own descriptors
 *   only, at every level, so an inherited `acceptingOrders: true` on
 *   `Object.prototype` is never read and an ABSENT own field stays `null`.
 * - **D2 — NOT APPLICABLE, and disclosed.** There is no library parse on
 *   this path (above), so there is no library state to defeat; the judgement
 *   is the door's own reads of the materialized tree against the documented
 *   type table, in full.
 * - **D3 — take values from the materialized tree.** Every emitted value is
 *   read from the tree by own-property access.
 * - **D4 — emit prototype-free.** The verdict, the state and the `recorded`
 *   record are null-prototype and frozen.
 * - **Refusal construction is the door's own.** No library renders a
 *   refusal; the issue strings are built by concatenation over primitives.
 *   `JSON.parse` of a text body runs inside containment. The door is TOTAL:
 *   it never throws, and a value whose containers throw from a `Proxy` trap
 *   is refused, not escaped.
 * - **The bound (§4 item 5)** is pinned by the contract suite under the six
 *   inherited-`toJSON` contexts and under an inherited `acceptingOrders`: the
 *   verdict for a body without an own `acceptingOrders` stays `null`,
 *   readiness stays FALSE, admitted AND refused verdicts are byte-identical
 *   to the clean ones, and the injected `toJSON` runs zero times.
 */

import {
  isOwnWireRecord,
  type OwnWireRecord,
  readOwnWireValue,
} from "../venue/wire-door.js";

/** The documented wire type of one interpreted field; every one is nullable and may be absent. */
export type GammaMarketDocumentedType = "boolean" | "string";

/**
 * The six documented fields, in the field table's order, with the type the
 * venue documents for each (S-D23 `MarketState`: `boolean | null`;
 * `gameStartTime`: an `IsoDateTimeString`, carried as `string | null`). This
 * table IS the door's contract: the door is derived from it, and the
 * contract suite reads it.
 */
export const GAMMA_MARKET_DOCUMENTED_FIELDS = Object.freeze([
  Object.freeze({ key: "active", type: "boolean" }),
  Object.freeze({ key: "closed", type: "boolean" }),
  Object.freeze({ key: "acceptingOrders", type: "boolean" }),
  Object.freeze({ key: "restricted", type: "boolean" }),
  Object.freeze({ key: "archived", type: "boolean" }),
  Object.freeze({ key: "gameStartTime", type: "string" }),
] as const) satisfies readonly { readonly key: string; readonly type: GammaMarketDocumentedType }[];

export type GammaMarketDocumentedField = (typeof GAMMA_MARKET_DOCUMENTED_FIELDS)[number]["key"];

/** A raw top-level scalar of the `Market` object, recorded as the venue spelled it. */
export type GammaRecordedScalar = string | number | boolean | null;

/**
 * One `Market` body after the door.
 *
 * Absent is `null` for every interpreted field. `recorded` carries every
 * other top-level scalar and is NOT an authority: nothing in this repository
 * may derive behaviour from a key it holds.
 */
export interface GammaMarketState {
  readonly active: boolean | null;
  readonly closed: boolean | null;
  readonly archived: boolean | null;
  readonly acceptingOrders: boolean | null;
  readonly restricted: boolean | null;
  /** Documented as a scheduled instant; carried verbatim, no format asserted. */
  readonly gameStartTime: string | null;
  readonly recorded: Readonly<Record<string, GammaRecordedScalar>>;
}

export type GammaMarketVerdict =
  | { readonly status: "ok"; readonly state: GammaMarketState }
  | { readonly status: "invalid"; readonly issues: readonly string[] };

function frozenOwn<T extends object>(entries: Readonly<Record<string, unknown>>): Readonly<T> {
  const built = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(entries)) {
    const descriptor = Object.create(null) as PropertyDescriptor;
    descriptor.value = entries[key];
    descriptor.enumerable = true;
    descriptor.writable = false;
    descriptor.configurable = false;
    Object.defineProperty(built, key, descriptor);
  }
  return Object.freeze(built) as Readonly<T>;
}

function invalid(issues: readonly string[]): GammaMarketVerdict {
  return frozenOwn<GammaMarketVerdict>({ status: "invalid", issues: Object.freeze([...issues]) });
}

function isScalar(value: unknown): value is GammaRecordedScalar {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

/**
 * The door's own reading of one documented field against its documented
 * type: absent → `null`; `null` → `null`; the documented primitive →
 * itself; anything else → an issue.
 */
function ownDocumented(
  record: OwnWireRecord,
  key: GammaMarketDocumentedField,
  type: GammaMarketDocumentedType,
  issues: string[],
): boolean | string | null {
  if (!Object.hasOwn(record, key)) {
    return null;
  }
  const value = record[key];
  if (value === null || typeof value === type) {
    return value as boolean | string | null;
  }
  issues.push(`${key}: documented as a nullable ${type}; got ${describeType(value)}`);
  return null;
}

function ownNullableBoolean(
  record: OwnWireRecord,
  key: Exclude<GammaMarketDocumentedField, "gameStartTime">,
  issues: string[],
): boolean | null {
  const value = ownDocumented(record, key, "boolean", issues);
  return typeof value === "string" ? null : value;
}

function ownNullableString(
  record: OwnWireRecord,
  key: "gameStartTime",
  issues: string[],
): string | null {
  const value = ownDocumented(record, key, "string", issues);
  return typeof value === "boolean" ? null : value;
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value === "object" ? "an object" : typeof value;
}

const DOCUMENTED_KEY_SET: ReadonlySet<string> = new Set<string>(
  GAMMA_MARKET_DOCUMENTED_FIELDS.map((field) => field.key),
);

/**
 * Reads one already-parsed `Market` value through the door. TOTAL: never
 * throws. A non-object body (an array, a scalar, `null`) is refused.
 */
export function readGammaMarket(value: unknown): GammaMarketVerdict {
  const read = readOwnWireValue(value);
  if (!read.ok) {
    return invalid([`<root>: ${read.detail}`]);
  }
  if (!isOwnWireRecord(read.value)) {
    return invalid(["<root>: a Market is a JSON object; the body is not one"]);
  }
  const record = read.value;

  // The door's own reads (D3), against the documented type table, in full.
  const issues: string[] = [];
  const active = ownNullableBoolean(record, "active", issues);
  const closed = ownNullableBoolean(record, "closed", issues);
  const archived = ownNullableBoolean(record, "archived", issues);
  const acceptingOrders = ownNullableBoolean(record, "acceptingOrders", issues);
  const restricted = ownNullableBoolean(record, "restricted", issues);
  const gameStartTime = ownNullableString(record, "gameStartTime", issues);
  if (issues.length > 0) {
    return invalid(issues);
  }

  const recordedEntries: Record<string, GammaRecordedScalar> = Object.create(null) as Record<
    string,
    GammaRecordedScalar
  >;
  for (const key of Object.keys(record)) {
    if (DOCUMENTED_KEY_SET.has(key)) continue;
    const member = record[key];
    if (isScalar(member)) {
      const descriptor = Object.create(null) as PropertyDescriptor;
      descriptor.value = member;
      descriptor.enumerable = true;
      descriptor.writable = false;
      descriptor.configurable = false;
      Object.defineProperty(recordedEntries, key, descriptor);
    }
  }

  const state = frozenOwn<GammaMarketState>({
    active,
    closed,
    archived,
    acceptingOrders,
    restricted,
    gameStartTime,
    recorded: Object.freeze(recordedEntries),
  });
  return frozenOwn<GammaMarketVerdict>({ status: "ok", state });
}

/**
 * Reads one response BODY (UTF-8 text) through the door: `JSON.parse` inside
 * containment, then {@link readGammaMarket}. TOTAL: never throws.
 */
export function readGammaMarketBody(bodyUtf8: string): GammaMarketVerdict {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyUtf8);
  } catch (error) {
    return invalid([
      `<root>: the body is not JSON (${error instanceof Error ? error.message : "unparsable"})`,
    ]);
  }
  return readGammaMarket(parsed);
}

/**
 * The documented readiness predicate, `active && !closed && acceptingOrders`,
 * evaluated FAIL-CLOSED: TRUE only when `active === true`, `closed === false`
 * and `acceptingOrders === true`. A `null` in any of the three is FALSE
 * (module header: stricter than the literal expression on `closed: null`).
 * Pure; reads nothing but the three documented fields — `restricted`,
 * `archived` and every recorded scalar are deliberately NOT consulted.
 */
export function isGammaMarketTradeReady(state: GammaMarketState): boolean {
  return state.active === true && state.closed === false && state.acceptingOrders === true;
}
