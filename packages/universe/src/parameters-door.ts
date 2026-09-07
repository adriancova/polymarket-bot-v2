/**
 * THE PARAMETER-OBSERVATION DOOR — `docs/contracts/schema-boundary.md` §5 item
 * 9(c), `UNIV-2` r1 MED-1 and MED-2.
 *
 * ## The two rows this closes
 *
 * **MED-1, the OUTPUT side.** `./parameters.ts` compares two snapshots to decide
 * what changed, and it read them with `previous[field]` / `next[field]` where
 * `next` is `zod`'s ordinary, `Object.prototype`-bearing output. An absent
 * optional (`openTime`, `closeTime`, `feeScheduleRef`) was therefore answered by
 * the prototype. Re-measured at base `c2c0733` on the REGISTRY path — where
 * `UNIV-2`'s door has already materialized the input, so `zod`'s output carries
 * no own `openTime` — the adoption is purely on the output side:
 *
 * ```text
 * clean  v1 changedParameters = [tick_size,minimum_order_size,trading_delay,neg_risk,status]
 * inherited openTime/closeTime/feeScheduleRef (non-enumerable):
 *        v1 changedParameters = [...,fee_schedule,...,open_time,close_time,status]
 *          -> three categories nobody observed, in an IMMUTABLE recorded version
 * previous carries openTime, next drops it, inherited openTime = previous':
 *        clean records v2 [open_time]; polluted REFUSES UNIVERSE_PARAMETERS_UNCHANGED
 *          -> a real parameter change is answered "nothing changed"
 * previous carries closeTime, next drops it and changes tickSize:
 *        clean emits changedParameters [tick_size,close_time];
 *        polluted emits [tick_size]  -> the §7.4 payload loses a category
 * stored snapshot, absent closeTime:
 *        effectiveCloseInstant clean=undefined, polluted=2000-01-01T00:00:00Z
 *          -> a scheduled close no observation carried, in BOTH variants
 * ```
 *
 * **MED-2, the `skipChecks` defeat.** With a non-enumerable inherited
 * `skipChecks`, base admitted `tickSize:"-9"`, `minimumOrderSize:"0"`,
 * `tradingDelaySeconds:-5` and `openTime:"yesterday"` into an IMMUTABLE recorded
 * parameter version (§6 invariant 9's economic record), and `tickSize:"1.50"`
 * reached `equalsDecimal` and threw `InvalidDecimalStringError` out of a direct
 * `appendParameterVersion` (`UNIV-1` NOTE-2).
 *
 * ## What this door performs, stated per `schema-boundary.md` §4
 *
 * - **D1 — NOT performed here, and that is deliberate.** `./registry.ts` already
 *   materializes the observation before `./parameters.ts` sees it
 *   (`openParameterObservation`, `UNIV-2`), and `./registration-door.ts` records
 *   why the schema itself must keep judging the caller's tree: it owns the
 *   documented `UniverseValidationError` THROW contract, and moving the parse
 *   would move a verdict this grant must preserve. What this module adds is read
 *   from OWN properties, so the direct-call path gets the same protection
 *   without a second parse.
 * - **D2 — the compensation.** {@link restateObservation} re-states, on its own
 *   reads, every presence, type, bound, vocabulary, FORMAT and cross-field rule
 *   `ParameterObservationSchema` declares — including `strictObject`'s "no other
 *   keys". The two formats come from `./grammar.ts`, which recomposes them from
 *   the frozen schemas' own artifacts. A failure raises the module's OWN
 *   `UniverseValidationError`, so the throw contract is unchanged.
 * - **D3** — {@link readObservation} takes every stored value from the own read,
 *   never from `zod`'s output.
 * - **D4** — the snapshot and the observation are emitted with
 *   `Object.create(null)` and frozen, IN THE FROZEN SCHEMA'S OWN KEY ORDER
 *   (measured: `zod`'s `strictObject` output is in shape order, not input
 *   order), so the stored bytes do not move and
 *   `version.parameters.closeTime === undefined` can no longer be answered by
 *   `Object.prototype`.
 *
 * ## What this door does NOT re-state
 *
 * `InternalMarketIdSchema` on the history's market id (`./parameters.ts` parses
 * it directly and that verdict is unchanged), and the UUID pattern inside it.
 * Disclosed, as in every other door in this package.
 */

import { MAX_IDENTIFIER_LENGTH, EventSourceSchema } from "@polymarket-bot/domain";

import { isIsoTimestamp, isPositiveDecimalString } from "./grammar.js";
import { ownDataDescriptor } from "./lifecycle-door.js";
import { MarketLifecycleStateSchema } from "./lifecycle-state.js";
import { instantMilliseconds } from "./time.js";

/** The two frozen vocabularies, copied from the schemas' own options at load. */
const LIFECYCLE_STATES: readonly string[] = Object.freeze([...MarketLifecycleStateSchema.options]);
const EVENT_SOURCES: readonly string[] = Object.freeze([...EventSourceSchema.options]);

/** The shapes `MarketParametersSchema` and `ParameterObservationSchema` declare. */
type FieldShape =
  /** `PositiveDecimalStringSchema` — canonical, greater than zero. */
  | "positiveDecimal"
  /** `z.boolean()`. */
  | "flag"
  /** `NonNegativeIntegerSchema` — `z.int().nonnegative()`. */
  | "nonNegativeInteger"
  /** `NonEmptyStringSchema` — bounded, non-empty. */
  | "boundedString"
  /** `IsoTimestampSchema` — the full ISO-8601 shape, with a designator or offset. */
  | "instant"
  /** `MarketLifecycleStateSchema`. */
  | "lifecycleState"
  /** `EventSourceSchema`. */
  | "eventSource"
  /** `MarketParametersSchema` — the nested snapshot. */
  | "parameterSnapshot";

interface DeclaredParameterField {
  readonly key: string;
  readonly shape: FieldShape;
  readonly required: boolean;
}

function field(key: string, shape: FieldShape, required = true): DeclaredParameterField {
  return Object.freeze({ key, shape, required });
}

/**
 * `MarketParametersSchema`, IN THE FROZEN SCHEMA'S OWN KEY ORDER.
 *
 * The order is load-bearing twice over: it is the order `zod` emits, so the
 * stored JSON does not move, and `./parameters-door.test.ts` derives this table
 * from the schema's own shape and fails when the two disagree — so a field added
 * to the frozen snapshot without being re-stated here fails the suite instead of
 * silently becoming un-doored.
 */
export const PARAMETER_SNAPSHOT_FIELDS: readonly DeclaredParameterField[] = Object.freeze([
  field("tickSize", "positiveDecimal"),
  field("minimumOrderSize", "positiveDecimal"),
  field("negRisk", "flag"),
  field("tradingDelaySeconds", "nonNegativeInteger"),
  field("feeScheduleRef", "boundedString", false),
  field("openTime", "instant", false),
  field("closeTime", "instant", false),
  field("status", "lifecycleState"),
]);

/** `ParameterObservationSchema`, in the frozen schema's own key order. */
export const PARAMETER_OBSERVATION_FIELDS: readonly DeclaredParameterField[] = Object.freeze([
  field("parameters", "parameterSnapshot"),
  field("observedAt", "instant"),
  field("source", "eventSource"),
]);

/** How a refusal names each re-stated shape. */
const SHAPE_DESCRIPTIONS: Readonly<Record<FieldShape, string>> = Object.freeze({
  positiveDecimal: "a canonical decimal string greater than zero",
  flag: "a boolean",
  nonNegativeInteger: "a non-negative integer",
  boundedString: "a non-empty string within the declared length bound",
  instant: "an ISO-8601 instant with a UTC designator or offset",
  lifecycleState: `one of ${LIFECYCLE_STATES.join(", ")}`,
  eventSource: `one of ${EVENT_SOURCES.join(", ")}`,
  parameterSnapshot: "a parameter snapshot",
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * One own DATA property, refusing an accessor without invoking it.
 *
 * An observation is recorded ECONOMIC data (§6 invariant 9); a getter on
 * `tickSize` is code, and code that runs during validation can answer
 * differently when the value is later stored.
 */
function ownMember(
  container: object,
  key: string,
): { readonly present: boolean; readonly value: unknown; readonly accessor: boolean } {
  const descriptor = Object.getOwnPropertyDescriptor(container, key);
  if (descriptor === undefined) {
    return { present: false, value: undefined, accessor: false };
  }
  if (!Object.hasOwn(descriptor, "value")) {
    return { present: false, value: undefined, accessor: true };
  }
  // An own `undefined` reads as ABSENT, the verdict `zod` gives it for an
  // `.optional()` field and the one that cannot diverge from absence.
  return { present: descriptor.value !== undefined, value: descriptor.value, accessor: false };
}

function shapeHolds(shape: FieldShape, value: unknown): boolean {
  switch (shape) {
    case "positiveDecimal":
      return isPositiveDecimalString(value);
    case "flag":
      return typeof value === "boolean";
    case "nonNegativeInteger":
      return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
    case "boundedString":
      return typeof value === "string" && value.length >= 1 && value.length <= MAX_IDENTIFIER_LENGTH;
    case "instant":
      return isIsoTimestamp(value);
    case "lifecycleState":
      return typeof value === "string" && LIFECYCLE_STATES.includes(value);
    case "eventSource":
      return typeof value === "string" && EVENT_SOURCES.includes(value);
    case "parameterSnapshot":
      return isRecord(value);
  }
}

function pathOf(path: string, key: string): string {
  return path === "" ? key : `${path}.${key}`;
}

/**
 * Reads one declared record as OWN data and re-states what its frozen schema
 * declares. Returns the prototype-free record, or the issues that stopped it.
 */
function readDeclared(
  fields: readonly DeclaredParameterField[],
  source: unknown,
  path: string,
  issues: string[],
): Record<string, unknown> | undefined {
  if (!isRecord(source)) {
    issues.push(`${path === "" ? "(root)" : path}: expected a record`);
    return undefined;
  }
  const out = Object.create(null) as Record<string, unknown>;
  const declared = new Set(fields.map((entry) => entry.key));
  for (const key of Object.keys(source)) {
    if (!declared.has(key)) {
      // `strictObject`'s own rule, re-stated: an undeclared key is refused.
      issues.push(`${pathOf(path, key)}: unrecognized key`);
    }
  }
  for (const entry of fields) {
    const member = ownMember(source, entry.key);
    if (member.accessor) {
      issues.push(
        `${pathOf(path, entry.key)}: an accessor property: a getter is code rather than observed data, and it is refused without being invoked`,
      );
      continue;
    }
    if (!member.present) {
      if (entry.required) {
        issues.push(`${pathOf(path, entry.key)}: the observation carries no ${entry.key}`);
      }
      continue;
    }
    if (entry.shape === "parameterSnapshot") {
      const nested = readDeclared(
        PARAMETER_SNAPSHOT_FIELDS,
        member.value,
        pathOf(path, entry.key),
        issues,
      );
      if (nested === undefined) {
        continue;
      }
      restateSnapshotCrossField(nested, pathOf(path, entry.key), issues);
      Object.defineProperty(out, entry.key, ownDataDescriptor(Object.freeze(nested)));
      continue;
    }
    if (!shapeHolds(entry.shape, member.value)) {
      issues.push(
        `${pathOf(path, entry.key)}: the observation's own ${entry.key} is not ${SHAPE_DESCRIPTIONS[entry.shape]}`,
      );
      continue;
    }
    Object.defineProperty(out, entry.key, ownDataDescriptor(member.value));
  }
  return out;
}

/**
 * `MarketParametersSchema`'s `.superRefine`, re-stated.
 *
 * A custom check is skipped WHOLESALE by an inherited `when` (ADR-020 §1 class
 * 6), so the one cross-field rule the snapshot declares is re-stated on this
 * module's own reads, with the frozen schema's own message.
 */
function restateSnapshotCrossField(
  snapshot: Record<string, unknown>,
  path: string,
  issues: string[],
): void {
  const openTime = snapshot["openTime"];
  const closeTime = snapshot["closeTime"];
  if (typeof openTime !== "string" || typeof closeTime !== "string") {
    return;
  }
  const open = instantMilliseconds(openTime);
  const close = instantMilliseconds(closeTime);
  if (open !== undefined && close !== undefined && close <= open) {
    issues.push(`${pathOf(path, "closeTime")}: the scheduled close must be after the scheduled open`);
  }
}

/** What the door read: the observation as own, prototype-free, frozen data. */
export type ObservationRead =
  | { readonly ok: true; readonly value: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly issues: readonly string[] };

/**
 * D2 + D3 + D4. Re-states the frozen observation schema on own reads and emits
 * the observation prototype-free.
 *
 * Runs AFTER `ParameterObservationSchema` has accepted the value. For own
 * data-shaped values, intact checks agree with the schema. Accessor-shaped
 * members are refused even when their getter value would validate. The suite
 * pins this distinction and proves per-field non-vacuity under an
 * inherited `skipChecks`.
 */
export function restateObservation(value: unknown): ObservationRead {
  const issues: string[] = [];
  const read = readDeclared(PARAMETER_OBSERVATION_FIELDS, value, "", issues);
  if (read === undefined || issues.length > 0) {
    return { ok: false, issues: Object.freeze(issues) };
  }
  return { ok: true, value: Object.freeze(read) };
}

/**
 * One field of a parameter snapshot, read as OWN data.
 *
 * Used by `./parameters.ts`'s comparison, which is the MED-1 row itself: an
 * absent optional must answer `undefined`, not whatever `Object.prototype`
 * holds, for a snapshot this package did not build (the exported
 * `changedParameterKinds` takes two caller-supplied snapshots).
 */
export function ownSnapshotField(snapshot: unknown, key: string): unknown {
  if (!isRecord(snapshot)) {
    return undefined;
  }
  const member = ownMember(snapshot, key);
  return member.present ? member.value : undefined;
}
