/**
 * Runtime guard for `jsonb` documents that may carry economic values.
 *
 * §6 invariant 1 and `docs/contracts/domain.md` §3.2/§4: an economic value has
 * exactly one representation, and a JavaScript `number` is not it. The column
 * types enforce that for columns; this file enforces it *inside* the documents,
 * where a signed order carries its price, an intent carries its size, and an
 * order event carries its fill quantity.
 *
 * A type alone is not enough here. `DecimalSafeJsonInput` protects code that
 * goes through these definitions with `tsc`, but a `jsonb` payload typically
 * arrives from `JSON.parse` of something a venue or an operator produced, where
 * `{"price": 0.42}` is already a double by the time TypeScript sees it as
 * `unknown`. The check is a deep walk at the repository boundary: it costs a
 * traversal of a small document, and it buys the guarantee that no
 * binary-floating-point economic value is ever persisted.
 *
 * Deliberately NOT guarded, and why (the documented allowlist):
 *
 *   * `strategy.definitions.params_schema` — a JSON Schema. `{"maximum": 5}` is
 *     a schema keyword, not a price; the parameters it validates are guarded.
 *   * `execution.submission_attempts.response_payload` and
 *     `execution.rate_limit_snapshots.headers` — verbatim venue evidence. They
 *     are recorded as observed and are never read as economic truth; forcing a
 *     re-encoding would make the record no longer what the venue sent.
 *
 * `strategy.decisions.model_outputs` used to be on that list as "model scores,
 * not money". That was wrong twice over: the frozen contract
 * (`packages/domain/src/decision.ts`, ADR-005, handoff §7.5) types a model
 * output as `DecimalString | string | boolean | null` and rejects a JavaScript
 * number outright; and an edge, a probability, or a fair value is precisely what
 * sizing and the risk thresholds are computed from, so a double there becomes a
 * rounding error in an order. It is guarded here like every other
 * economics-bearing document, and `internal.jsonb_contains_number()` rejects it
 * in the database as well (migration 0004), for writers that never pass through
 * this package.
 *
 * Everything else that can hold a price, a size, a fee, or a balance goes
 * through `assertDecimalSafeJson()`.
 *
 * ## The guard JUDGES, the repository ENCODES, `pg` receives TEXT (`SER-2`)
 *
 * The guard above returns the SAME object reference it judged. Until `SER-2`
 * every repository then handed that object to Kysely, and `pg@8.23.0`
 * (`lib/utils.js` `prepareObject`) serialized it at bind time: a plain
 * `val.toPostgres` property GET (an inherited-lookup route of its own) and
 * then `JSON.stringify`, which resolves `toJSON` through the value's
 * PROTOTYPE CHAIN. `docs/handoffs/SER-0-sweep.md` measured that end to end
 * through real Kysely → `pg` `prepareValue`, in six contexts
 * ({`Object.prototype`, `Array.prototype`, `BigInt.prototype`} × {enumerable
 * assignment, non-enumerable `defineProperty`}): a document the guard PASSED
 * was stored as the injected `toJSON`'s answer, and a `bigint` inside an
 * unguarded document — refused by `JSON.stringify` with a `TypeError` in a
 * clean process — became accepted bytes. A STRING parameter never reaches
 * `prepareObject` (measured invariant in all six contexts), which closes both
 * routes at once.
 *
 * So the rule, one sentence: **every `jsonb` write hands `pg` text.** The
 * guard stays exactly where it is and keeps judging the object; the
 * repository then calls {@link encodeJsonbText}, which produces the bytes with
 * `@polymarket-bot/risk/plain-json`'s `encodePlainJson` — ECMA-262 25.5.2
 * over OWN DATA only, byte-identical to a clean `JSON.stringify` for plain
 * data — and binds the string. The column input types
 * (`schema/columns.ts` `JsonInput`, `DecimalSafeJsonInput`) admit `string`
 * for exactly this reason. A document the encoder refuses (a `bigint`, a
 * function or symbol, an accessor, a `Date`/`Map`/class instance, a container
 * nested past the default depth, `undefined` at the root) is a
 * {@link DecimalSafeJsonError} — the package's existing "not storable"
 * vocabulary — never a driver `TypeError` and never silently substituted
 * bytes: `BIGINT` maps to `ECONOMIC_JSON_NUMBER` (what `walk()` already says
 * of a bigint) and every other refusal kind to `ECONOMIC_JSON_MALFORMED`
 * (what `walk()` already says of a value JSON cannot represent).
 */

import { encodePlainJson, PLAIN_JSON_REFUSAL_KINDS } from "@polymarket-bot/risk/plain-json";
import type { PlainJsonRefusalKind } from "@polymarket-bot/risk/plain-json";

import { DecimalSafeJsonError } from "./errors.js";
import type { DecimalSafeJsonInput } from "./schema/columns.js";

/**
 * Rejects any `number` inside a JSON document bound for an economic column.
 *
 * @param value - The document, as an object or as pre-serialized JSON text.
 *   Text is parsed and checked too: serializing first must not be a way around
 *   the rule.
 * @param field - The column this document is bound for, named in the error so
 *   the operator learns *which* payload was rejected.
 *
 * @throws {DecimalSafeJsonError} when the document contains a number at any
 *   depth, or when pre-serialized text is not valid JSON.
 */
export function assertDecimalSafeJson(value: unknown, field: string): void {
  if (value === null || value === undefined) {
    return;
  }

  if (typeof value === "string") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch (cause) {
      throw new DecimalSafeJsonError(
        "ECONOMIC_JSON_MALFORMED",
        `${field} was given pre-serialized JSON that does not parse.`,
        field,
        "",
        { cause },
      );
    }
    walk(parsed, field, "");
    return;
  }

  walk(value, field, "");
}

function walk(value: unknown, field: string, path: string): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return;
  }

  if (typeof value === "number") {
    throw new DecimalSafeJsonError(
      "ECONOMIC_JSON_NUMBER",
      `${field}${path} is the JavaScript number ${String(value)}. ` +
        "A document that may carry economic values holds them as canonical decimal " +
        "strings; a number cannot represent one exactly (§6 invariant 1).",
      field,
      path,
    );
  }

  if (typeof value === "bigint") {
    throw new DecimalSafeJsonError(
      "ECONOMIC_JSON_NUMBER",
      `${field}${path} is a bigint, which JSON cannot represent. Use a decimal string.`,
      field,
      path,
    );
  }

  if (Array.isArray(value)) {
    for (const [index, element] of value.entries()) {
      walk(element, field, `${path}[${String(index)}]`);
    }
    return;
  }

  if (typeof value === "object") {
    for (const [key, element] of Object.entries(value)) {
      walk(element, field, `${path}.${key}`);
    }
    return;
  }

  // `undefined`, a function, or a symbol: `JSON.stringify` would drop it
  // silently, so the stored document would not be the one the caller wrote.
  throw new DecimalSafeJsonError(
    "ECONOMIC_JSON_MALFORMED",
    `${field}${path} is ${typeof value}, which is not representable in JSON.`,
    field,
    path,
  );
}

/**
 * Checks a document and returns it, for use directly in an insert.
 *
 * Returning the value keeps the guard on the same line as the write, so a new
 * economic payload cannot be added with the check "meant to be added later".
 */
export function decimalSafeJson(
  value: DecimalSafeJsonInput,
  field: string,
): DecimalSafeJsonInput {
  assertDecimalSafeJson(value, field);
  return value;
}

/**
 * The `kind` of the own-data encoder's refusal, read as OWN DATA, or
 * `undefined` for anything else that was thrown.
 *
 * Not `instanceof NotPlainJson`: the refusal is classified by the closed
 * vocabulary it carries, so the classification consults no prototype
 * (`packages/event-bus/src/envelope-door.ts` records why that matters at a
 * containment boundary). A thrown value that is not an object, carries no own
 * data `kind`, or whose descriptor read throws, is "not the encoder's
 * refusal" and is re-thrown untouched by the caller.
 */
function plainJsonRefusalKind(error: unknown): PlainJsonRefusalKind | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(error, "kind");
  } catch {
    return undefined;
  }
  if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) return undefined;
  const kind: unknown = descriptor.value;
  return typeof kind === "string" && PLAIN_JSON_REFUSAL_KINDS.includes(kind as PlainJsonRefusalKind)
    ? (kind as PlainJsonRefusalKind)
    : undefined;
}

/** An own string data property of `error`, or the empty string. */
function ownStringOf(error: object, key: string): string {
  const descriptor = Object.getOwnPropertyDescriptor(error, key);
  if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) return "";
  return typeof descriptor.value === "string" ? descriptor.value : "";
}

/**
 * The encoder names the root `value` and a member `value.a[0].b`; this
 * package's `walk()` names the root `` (empty) and a member `.a[0].b`, with
 * the column in `field`. One convention for the operator.
 */
function repositoryPath(encoderPath: string): string {
  return encoderPath.startsWith("value") ? encoderPath.slice("value".length) : encoderPath;
}

/**
 * The TEXT a `jsonb` column receives for `document`: the bytes of its own
 * data, or `null` for `null`, or the caller's own bytes for a string.
 *
 * This is the "repository ENCODES" half of the header's rule. Call it AFTER
 * the guard (where the column has one) and hand its answer to Kysely in place
 * of the object, so `pg` binds a string and never serializes through the
 * prototype chain. A string is passed through untouched — it is already the
 * bytes the caller chose to store, and `assertDecimalSafeJson` has parsed and
 * judged it where the column is guarded.
 *
 * @param document - The object, pre-serialized text, or `null`.
 * @param field - The column, named in the refusal.
 * @throws {DecimalSafeJsonError} `ECONOMIC_JSON_NUMBER` for a `bigint` at any
 *   depth; `ECONOMIC_JSON_MALFORMED` for every other refusal of the own-data
 *   encoder (`undefined` root, function or symbol, accessor, non-plain
 *   container, depth).
 */
export function encodeJsonbText(
  document: string | Readonly<Record<string, unknown>>,
  field: string,
): string;
export function encodeJsonbText(
  document: string | Readonly<Record<string, unknown>> | null,
  field: string,
): string | null;
export function encodeJsonbText(
  document: string | Readonly<Record<string, unknown>> | null,
  field: string,
): string | null {
  if (document === null) return null;
  if (typeof document === "string") return document;
  try {
    return encodePlainJson(document);
  } catch (error) {
    const kind = plainJsonRefusalKind(error);
    if (kind === undefined) throw error;
    const refusal = error as object;
    const path = repositoryPath(ownStringOf(refusal, "path"));
    const problem = ownStringOf(refusal, "problem");
    if (kind === "BIGINT") {
      throw new DecimalSafeJsonError(
        "ECONOMIC_JSON_NUMBER",
        `${field}${path} is a bigint, which JSON cannot represent. Use a decimal string.`,
        field,
        path,
        { cause: error },
      );
    }
    throw new DecimalSafeJsonError(
      "ECONOMIC_JSON_MALFORMED",
      `${field}${path} is not representable in JSON (${kind}): ${problem}`,
      field,
      path,
      { cause: error },
    );
  }
}
