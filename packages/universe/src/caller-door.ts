/**
 * THE CALLER-INPUT DOOR MACHINERY: read a caller-supplied record into plain OWN
 * data, restate what its frozen schema declares, and emit prototype-free.
 *
 * ## Why this module exists
 *
 * `./lifecycle-door.ts` (`UNIV-1`) closed ONE of this package's boundaries: the
 * §7.4 payload consumed by `applyMarketLifecycleEvent`. Its own handoff
 * disclosed, and `docs/contracts/schema-boundary.md` §3 records, that the
 * package's OTHER boundaries were still open, and `UNIV-2` re-measured every
 * one of them at base `989d41d`:
 *
 * - `registerSeries` adopts all NINE declared keys of `SeriesDefinitionSchema`
 *   from `Object.prototype`, **including `binding`** — a series stored with
 *   `{approved: true, approvedBy: "ghost", approvedAt: …}` that no reviewer
 *   ever granted, after which `bindMarketToSeries` binds a market to it. The
 *   §9.2 rule "series binding is configuration, not heuristic-only" is enforced
 *   by exactly that flag.
 * - `registerMarket` adopts all SEVEN declared keys of `MarketIdentitySchema` —
 *   the binding `WP-040`'s `markets_immutable_identity` trigger exists to
 *   protect — and its own input record's `identity`, `parameters` and
 *   `metadataVersion`: `registerMarket(registry, {})` REGISTERED A MARKET.
 * - `approveSeries` reads the two review facts (`approvedBy`, `approvedAt`) and
 *   even the `seriesId` it approves off the prototype.
 * - `bindMarketToSeries` does the same in BOTH pollution variants (no schema is
 *   involved, so `strictObject` cannot even fail it closed).
 * - `recordMarketParameters` adopts the observation and every member of the
 *   parameter snapshot, including the ECONOMIC `tickSize` (`"0.99"` landed in a
 *   recorded, immutable parameter version).
 * - `applyMarketEvent` / `recordMarketOutcomeState` adopt their input records:
 *   `applyMarketEvent(registry, id, {})` OPENED a market at an instant from the
 *   prototype, and `recordMarketOutcomeState(registry, id, {})` recorded
 *   `DISPUTED`, both in BOTH variants.
 *
 * ## What this module provides, stated per `schema-boundary.md` §4
 *
 * - **D1** is `./lifecycle-door.ts`'s {@link readOwnPayload}, reused rather than
 *   re-implemented; {@link openOwnValue} only adds the refusal wording.
 * - **D2 is NOT PERFORMED and is disclosed**, for the same reason `UNIV-1` gave:
 *   a severed warmed arena lives in `packages/risk`, this package has no §2.1
 *   edge to it (`pnpm check:deps`) and may not paste it (the repo-wide deletion
 *   guard). The compensation is {@link readDeclaredFields}: on a door whose
 *   emitted record this module builds, the PRESENCE, type, bounds and
 *   vocabularies the frozen schema declares are re-stated on this module's own
 *   reads, so they hold with every `zod` check switched off. What is not
 *   re-stated is listed per door in `./registration-door.ts` and
 *   `./envelope-door.ts`.
 * - **D3** — every emitted value comes from the materialized tree, never from
 *   `parsed.data`.
 * - **D4** — {@link readDeclaredFields} emits with `Object.create(null)` and
 *   `./lifecycle-door.ts`'s {@link ownDataDescriptor}, frozen: an absent
 *   optional field cannot be answered by `Object.prototype` at the READING end
 *   either (measured cell: `eligibility.ts` asks
 *   `input.series.activeSettlementSpecId === undefined` before it lets a
 *   model-dependent activation through).
 * - **Refusal construction is contained** — `./lifecycle-door.ts`'s
 *   {@link containedParse}, and {@link contained} for the paths that do not run
 *   a `safeParse` directly. Measured at base: an inherited `get`, `value`,
 *   `_zod` or `message` turned `registerSeries`'s, `registerMarket`'s and
 *   `recordMarketParameters`'s clean refusal into an escaping `TypeError`.
 *
 * ## Deployment reading, required whenever this class is quoted
 *
 * Nothing on the wire can write `Object.prototype`: every row above needs code
 * already executing in the process. The rows say "this check is not
 * load-bearing against an attacker already inside the process", not "a caller
 * can turn this off". They still matter because what they reach is a human
 * review gate (§9.2), an immutable identity binding (`WP-040`), and a recorded
 * economic parameter (§6 invariant 9).
 */

import { MAX_CODE_LENGTH, MAX_DETAIL_LENGTH, MAX_IDENTIFIER_LENGTH } from "@polymarket-bot/domain";

import { ownDataDescriptor, readOwnPayload, type OwnRecord } from "./lifecycle-door.js";
import { instantMilliseconds } from "./time.js";

/** What a door read produced, or the rendered issues that stopped it. */
export type DoorRead<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly string[] };

/**
 * The shapes this machinery re-states (the D2 compensation).
 *
 * Every entry names a frozen schema's own declaration. Nothing here invents a
 * vocabulary or a bound: the two length bounds are the frozen constants, and a
 * vocabulary is copied FROM the schema's `options` at module load by the caller
 * that declares the field.
 */
export type DeclaredShape =
  /** `Uuidv7Schema` — a non-empty string; the UUIDv7 PATTERN is not re-stated. */
  | { readonly kind: "identifier" }
  /** `NonEmptyStringSchema` / `TokenIdSchema` / `CodeStringSchema` — a bounded non-empty string. */
  | { readonly kind: "boundedString"; readonly maximum: number }
  /** `IsoTimestampSchema` — a non-empty string that names a parseable instant. */
  | { readonly kind: "instant" }
  /** `z.boolean()`. */
  | { readonly kind: "flag" }
  /** `z.int().nonnegative()` / `z.int().positive()`. */
  | { readonly kind: "integer"; readonly minimum: number }
  /**
   * `UnsignedBigIntStringSchema` — a canonical unsigned integer string.
   *
   * The one FORMAT this machinery re-states, and it is re-stated because the
   * door's own emitted `order.ingestSeq` is handed to `BigInt(...)` by
   * `./lifecycle.ts`'s replay guard, which THROWS on anything else.
   */
  | { readonly kind: "unsignedIntegerString"; readonly maximum: number }
  /** A `z.enum` — the options are read from the frozen schema by the declaring door. */
  | { readonly kind: "vocabulary"; readonly options: readonly string[] }
  /** A nested object with its own declared fields. */
  | { readonly kind: "record"; readonly fields: readonly DeclaredField[] }
  /**
   * A `z.discriminatedUnion` — the arm is chosen by the OWN value of the
   * discriminator, so a discriminator the record does not carry selects no arm.
   */
  | {
      readonly kind: "variant";
      readonly discriminator: string;
      readonly arms: Readonly<Record<string, readonly DeclaredField[]>>;
    }
  /**
   * Present, and judged elsewhere.
   *
   * Used for the §7.1 envelope's `payload`, whose shape belongs to the contract
   * the envelope routes to and, downstream, to `./lifecycle-door.ts`. The door
   * still re-states that it is PRESENT and is a record.
   */
  | { readonly kind: "opaqueRecord" };

/** One declared key of a caller-supplied record. */
export interface DeclaredField {
  readonly key: string;
  readonly shape: DeclaredShape;
  /** Whether the frozen schema requires it. Verified against the schema in the suite. */
  readonly required: boolean;
}

/** Declares one field. Frozen, because a read table that can be edited is not a table. */
export function declaredField(key: string, shape: DeclaredShape, required = true): DeclaredField {
  return Object.freeze({ key, shape: Object.freeze(shape), required });
}

/** Shorthands for the shapes this package's schemas use. */
export const IDENTIFIER: DeclaredShape = Object.freeze({ kind: "identifier" });
export const INSTANT: DeclaredShape = Object.freeze({ kind: "instant" });
export const FLAG: DeclaredShape = Object.freeze({ kind: "flag" });
export const NON_EMPTY_STRING: DeclaredShape = Object.freeze({
  kind: "boundedString",
  maximum: MAX_IDENTIFIER_LENGTH,
});
export const CODE_STRING: DeclaredShape = Object.freeze({
  kind: "boundedString",
  maximum: MAX_CODE_LENGTH,
});
export const DETAIL_STRING: DeclaredShape = Object.freeze({
  kind: "boundedString",
  maximum: MAX_DETAIL_LENGTH,
});
export const NON_NEGATIVE_INTEGER: DeclaredShape = Object.freeze({ kind: "integer", minimum: 0 });
export const POSITIVE_INTEGER: DeclaredShape = Object.freeze({ kind: "integer", minimum: 1 });
export const UNSIGNED_INTEGER_STRING: DeclaredShape = Object.freeze({
  kind: "unsignedIntegerString",
  maximum: 40,
});
export const OPAQUE_RECORD: DeclaredShape = Object.freeze({ kind: "opaqueRecord" });

/** How a refusal names each re-stated shape. */
export function describeShape(shape: DeclaredShape): string {
  switch (shape.kind) {
    case "identifier":
      return "a non-empty identifier";
    case "boundedString":
      return "a non-empty string within the declared length bound";
    case "instant":
      return "an instant that parses";
    case "flag":
      return "a boolean";
    case "integer":
      return shape.minimum > 0 ? "a positive integer" : "a non-negative integer";
    case "unsignedIntegerString":
      return "a canonical unsigned integer string";
    case "vocabulary":
      return `one of ${shape.options.join(", ")}`;
    case "record":
      return "a record";
    case "variant":
      return `a record carrying ${shape.discriminator}`;
    case "opaqueRecord":
      return "a record";
  }
}

/** The canonical unsigned-integer grammar, copied from `UnsignedBigIntStringSchema`. */
const UNSIGNED_INTEGER = /^(?:0|[1-9][0-9]*)$/u;

function boundedString(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" && value.length >= 1 && value.length <= maximum
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pathOf(path: string, key: string): string {
  return path === "" ? key : `${path}.${key}`;
}

/**
 * D3 + D4. Builds the record a door emits, entirely from the materialized tree,
 * with a null prototype and frozen.
 *
 * Every declared key is read here — including the ones the caller of the door
 * does not consume — because a key adopted from the prototype changes
 * ACCEPTANCE even when it changes no stored field: at base, deleting any one of
 * the required keys is refused clean and every one of them is satisfiable from
 * `Object.prototype`.
 */
export function readDeclaredFields(
  fields: readonly DeclaredField[],
  source: unknown,
  path = "",
): DoorRead<OwnRecord> {
  if (!isRecord(source)) {
    return { ok: false, issues: [`${path === "" ? "(root)" : path}: expected a record`] };
  }
  const out = Object.create(null) as Record<string, unknown>;
  const issues: string[] = [];
  for (const field of fields) {
    // The materialized tree has no prototype, so this read cannot inherit.
    if (!Object.hasOwn(source, field.key)) {
      if (field.required) {
        issues.push(`${pathOf(path, field.key)}: the record carries no ${field.key}`);
      }
      continue;
    }
    const read = readShape(field.shape, source[field.key], pathOf(path, field.key));
    if (!read.ok) {
      issues.push(...read.issues);
      continue;
    }
    Object.defineProperty(out, field.key, ownDataDescriptor(read.value));
  }
  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return { ok: true, value: Object.freeze(out) };
}

function readShape(shape: DeclaredShape, value: unknown, path: string): DoorRead<unknown> {
  const refuse = (): DoorRead<unknown> => ({
    ok: false,
    issues: [`${path}: the record's own ${path} is not ${describeShape(shape)}`],
  });
  switch (shape.kind) {
    case "identifier":
      // No maximum: `Uuidv7Schema` declares none, and a re-statement may never
      // be STRICTER than the schema it re-states.
      return typeof value === "string" && value.length >= 1 ? { ok: true, value } : refuse();
    case "boundedString": {
      const text = boundedString(value, shape.maximum);
      return text === undefined ? refuse() : { ok: true, value: text };
    }
    case "instant": {
      const text = typeof value === "string" && value.length >= 1 ? value : undefined;
      // An instant that does not parse is one this package's own comparisons
      // (`./time.ts`) fall back to string equality on.
      return text !== undefined && instantMilliseconds(text) !== undefined
        ? { ok: true, value: text }
        : refuse();
    }
    case "flag":
      return typeof value === "boolean" ? { ok: true, value } : refuse();
    case "integer":
      return typeof value === "number" && Number.isSafeInteger(value) && value >= shape.minimum
        ? { ok: true, value }
        : refuse();
    case "unsignedIntegerString": {
      const text = boundedString(value, shape.maximum);
      return text !== undefined && UNSIGNED_INTEGER.test(text) ? { ok: true, value: text } : refuse();
    }
    case "vocabulary":
      return typeof value === "string" && shape.options.includes(value)
        ? { ok: true, value }
        : refuse();
    case "record":
      return readDeclaredFields(shape.fields, value, path);
    case "variant": {
      if (!isRecord(value)) {
        return refuse();
      }
      // The DISCRIMINATOR is read as an own property too: at base a
      // `binding` whose `approved` came from `Object.prototype` selected the
      // approved arm (and, on a cold union, threw
      // `propValues[key].add is not a function` out of the function).
      if (!Object.hasOwn(value, shape.discriminator)) {
        return {
          ok: false,
          issues: [
            `${pathOf(path, shape.discriminator)}: the record carries no ${shape.discriminator}`,
          ],
        };
      }
      const arm = shape.arms[String(value[shape.discriminator])];
      if (arm === undefined) {
        return {
          ok: false,
          issues: [
            `${pathOf(path, shape.discriminator)}: the record's own ${shape.discriminator} names no declared variant`,
          ],
        };
      }
      return readDeclaredFields(arm, value, path);
    }
    case "opaqueRecord":
      return isRecord(value) ? { ok: true, value } : refuse();
  }
}

/**
 * D1, with this package's refusal wording.
 *
 * TOTAL: {@link readOwnPayload} never throws, including on a `RangeError` from a
 * pathologically deep input.
 */
export function openOwnValue(value: unknown): DoorRead<unknown> {
  const own = readOwnPayload(value);
  return own.ok ? { ok: true, value: own.value } : { ok: false, issues: [`(root): ${own.detail}`] };
}

/**
 * The value as a record, or an EMPTY prototype-free record.
 *
 * A caller record that is not an object reads every declared key as `undefined`
 * at base (`input.identity` on a string is `undefined`, not an error), and the
 * refusal that follows belongs to the schema that is handed that `undefined` —
 * so the doors keep that verdict instead of inventing an earlier one.
 */
export function asOwnRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : (Object.create(null) as Record<string, unknown>);
}

/**
 * A SHALLOW own read of one caller record's declared keys.
 *
 * Used where the door must not copy the value it is reading: `applyMarketEvent`
 * hands its `payload` on to `./lifecycle-door.ts`, which materializes it
 * itself, so materializing here as well would only move the refusal wording of
 * an exotic payload from the lifecycle door to this one. The three keys of the
 * input RECORD are read as own DATA properties (an accessor is refused without
 * being invoked, exactly as D1 does), so none of them can come from the
 * prototype.
 */
export function readOwnFields(
  value: unknown,
  keys: readonly string[],
  what: string,
): DoorRead<OwnRecord> {
  if (!isRecord(value)) {
    return { ok: false, issues: [`(root): ${what} is a record`] };
  }
  const out = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) {
      continue;
    }
    // `Object.hasOwn`, not `in`: with an inherited `value` every accessor
    // descriptor would read as a data descriptor.
    if (!Object.hasOwn(descriptor, "value")) {
      return {
        ok: false,
        issues: [
          `${key}: an accessor property: a getter is code rather than caller data, and it is refused without being invoked`,
        ],
      };
    }
    if (descriptor.value === undefined) {
      // An own `undefined` is read as ABSENT — the verdict `zod` already gives
      // it, and the one that cannot later diverge from absence.
      continue;
    }
    Object.defineProperty(out, key, ownDataDescriptor(descriptor.value));
  }
  return { ok: true, value: Object.freeze(out) };
}

/** Builds one of this package's emitted records: null prototype, frozen. */
export function ownRecord<T>(fields: Readonly<Record<string, unknown>>): T {
  const out = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(fields)) {
    const value = fields[key];
    if (value === undefined) {
      continue;
    }
    Object.defineProperty(out, key, ownDataDescriptor(value));
  }
  return Object.freeze(out) as T;
}

/**
 * Runs `run` inside a containment, so a throw becomes a refusal.
 *
 * ADR-020's 2026-09-06 amendment: the warmed arena protects the parse, not
 * `zod`'s ERROR CONSTRUCTION, which is built lazily per call even on a warm
 * schema and reads through the prototype chain. Measured at base on these very
 * doors: an inherited `get`, `value`, `_zod` or `message` turned the clean
 * refusal of a malformed series definition, market identity or parameter
 * observation into an escaping `TypeError`, and an inherited `approved`
 * during a COLD `discriminatedUnion` build threw
 * `propValues[key].add is not a function`. Every one of these functions returns
 * a typed result and no caller in this repository wraps it in a `try`, so a
 * throw here is an availability defeat.
 */
export function contained<T>(run: () => DoorRead<T>, what: string): DoorRead<T> {
  try {
    return run();
  } catch {
    return {
      ok: false,
      issues: [
        `(root): the contract could not judge this ${what} (its refusal could not be constructed); refused`,
      ],
    };
  }
}
