/**
 * Leaf validators over MATERIALIZED values.
 *
 * Every function here receives values that have already been read into plain
 * own data (`plain-data.ts` / `pluck.ts`), so a plain property access cannot
 * run caller code and an absent field cannot be answered by a prototype.
 * Decimal grammar goes straight to `@polymarket-bot/decimal`'s
 * `explainCanonicalDecimalString` — a direct function call, not a schema, so
 * economic-field validation shares no code path with any `zod` parse.
 *
 * The record-shape validators collect PROBLEM STRINGS (path: reason) and the
 * doors turn a non-empty list into one typed refusal carrying all of them —
 * the caller sees every defect at once instead of one per attempt.
 */

import {
  compareDecimal,
  explainCanonicalDecimalString,
  type DecimalRange,
} from "@polymarket-bot/decimal";

import { describeValue } from "./plain-data.js";
import { uuidShapedNotCanonical } from "./guards.js";

export interface Problem {
  readonly path: string;
  readonly problem: string;
}

/** Push a problem; returns `undefined` so callers can `return fail(...)`. */
export function problem(problems: Problem[], path: string, text: string): undefined {
  problems.push({ path, problem: text });
  return undefined;
}

/** The value if it is a materialized record (plain object, not array). */
export function asRecord(
  value: unknown,
  path: string,
  problems: Problem[],
): Readonly<Record<string, unknown>> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return problem(problems, path, `expected a record, received ${describeValue(value)}`);
  }
  return value as Readonly<Record<string, unknown>>;
}

/** The value if it is an array. */
export function asArray(
  value: unknown,
  path: string,
  problems: Problem[],
): readonly unknown[] | undefined {
  if (!Array.isArray(value)) {
    return problem(problems, path, `expected an array, received ${describeValue(value)}`);
  }
  return value as readonly unknown[];
}

/**
 * Enforces a CLOSED key set on a materialized record: an unknown key is a
 * problem, never silently carried or dropped (the WP-180 emission rule,
 * applied at this package's inputs and outputs alike).
 */
export function requireKnownKeys(
  record: Readonly<Record<string, unknown>>,
  path: string,
  known: ReadonlySet<string>,
  problems: Problem[],
): void {
  for (const key of Object.keys(record)) {
    if (!known.has(key)) {
      problem(problems, `${path}.${key}`, "an unrecognized field (closed key set; fail closed)");
    }
  }
}

/** A bounded non-empty string, with the ADR-016 §2 canonical-UUID refusal. */
export function asIdentifier(
  value: unknown,
  path: string,
  problems: Problem[],
  maxLength = 200,
): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    return problem(
      problems,
      path,
      `expected a non-empty string of at most ${String(maxLength)} characters, received ${describeValue(value)}`,
    );
  }
  if (uuidShapedNotCanonical(value)) {
    return problem(
      problems,
      path,
      "UUID-shaped but not canonical lowercase (ADR-016 §2: refuse, never case-fold)",
    );
  }
  return value;
}

/** A canonical decimal string in the given range. */
export function asDecimal(
  value: unknown,
  path: string,
  problems: Problem[],
  range?: DecimalRange,
): string | undefined {
  if (typeof value !== "string") {
    return problem(problems, path, `expected a canonical decimal string, received ${describeValue(value)}`);
  }
  const explained = explainCanonicalDecimalString(value, range === undefined ? undefined : { range });
  if (explained !== null) {
    return problem(problems, path, explained);
  }
  return value;
}

/** A canonical decimal strictly inside the open unit interval (0, 1). */
export function asOpenUnitPrice(
  value: unknown,
  path: string,
  problems: Problem[],
): string | undefined {
  const decimal = asDecimal(value, path, problems, "UNIT_INTERVAL");
  if (decimal === undefined) return undefined;
  if (compareDecimal(decimal, "0") <= 0 || compareDecimal(decimal, "1") >= 0) {
    return problem(
      problems,
      path,
      `a tradeable price must lie strictly inside (0, 1); received "${decimal}"`,
    );
  }
  return decimal;
}

/** A non-negative safe integer (counters and tick counts, never economics). */
export function asNonNegativeInteger(
  value: unknown,
  path: string,
  problems: Problem[],
): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return problem(problems, path, `expected a non-negative safe integer, received ${describeValue(value)}`);
  }
  return value;
}

/** A strictly positive safe integer (durations and counts, never economics). */
export function asPositiveInteger(
  value: unknown,
  path: string,
  problems: Problem[],
): number | undefined {
  const integer = asNonNegativeInteger(value, path, problems);
  if (integer === undefined) return undefined;
  if (integer === 0) {
    return problem(problems, path, "expected a strictly positive integer, received 0");
  }
  return integer;
}

/** One of a closed vocabulary. */
export function asMember<T extends string>(
  value: unknown,
  path: string,
  vocabulary: readonly T[],
  problems: Problem[],
): T | undefined {
  if (typeof value !== "string" || !(vocabulary as readonly string[]).includes(value)) {
    return problem(
      problems,
      path,
      `expected one of ${vocabulary.map((entry) => `"${entry}"`).join(", ")}, received ${describeValue(value)}`,
    );
  }
  return value as T;
}
