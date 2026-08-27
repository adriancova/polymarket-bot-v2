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
 */

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
