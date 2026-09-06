/**
 * The control API's WIRE doors — ADR-020 §5 / `docs/contracts/schema-boundary.md`
 * §6 rule 1: "A new or substantially rewritten boundary opened after this date
 * conforms on arrival."
 *
 * Every value this process parses arrives from an HTTP client. That is the
 * caller/wire exposure class ADR-020 §4 ranks highest — "a fail-open here
 * changes what the system accepts" — and this API's job is to accept operator
 * CONTROLS, so a fail-open here changes what an operator can make the platform
 * do. Every door in this file therefore performs all four steps.
 *
 * ## Conformance statement (schema-boundary §4)
 *
 * 1. **D1 — materialize prototype-free before parsing.** `readPlainData` from
 *    `@polymarket-bot/risk/plain-data` takes the caller's value apart with
 *    DESCRIPTORS, refuses anything that is not plain own data (a getter, a
 *    proxy, a function, a cycle, an inherited key), and returns a tree with no
 *    prototype. Nothing downstream reads a property off the caller's object.
 * 2. **D2 — parse through the severed, warmed arena.** `prototypeFreeParser`
 *    from `@polymarket-bot/risk/schema-arena` builds each parsing copy at
 *    MODULE LOAD, so no lazy is ever forced cold (the "cold-lazy poisoning"
 *    class, which permanently poisons a schema object for the whole process).
 * 3. **D3 — values come from the materialized tree.** The schema ANSWERS
 *    whether the document is valid; the value a door returns is read from the
 *    materialized tree, never from `parsed.data`.
 * 4. **D4 — emit prototype-free.** Returned values are assembled on
 *    `Object.create(null)` and deep-frozen.
 * 5. **The bound (ADR-020 §6).** Composition may vary; PERMISSION MAY NOT.
 *    `doors.test.ts` runs the pollution battery and asserts that a request
 *    refused clean is refused polluted and one accepted clean carries the same
 *    values polluted.
 *
 * ## Why the canonical door and not a local copy
 *
 * `docs/contracts/dependency-direction.md` §2 puts `apps/control-api` in layer
 * 3 and `packages/risk` in layer 1, so the edge is DOWNWARD and permitted
 * outright. `packages/risk` exports `./plain-data` and `./schema-arena` through
 * its `exports` map, so this is an entry-point import and not a deep one (F16).
 * And `WP-180-FU2`'s repo-wide deletion guard walks `apps/*`, so pasting a copy
 * is a contract violation rather than a shortcut. `apps/trader/src/config.ts`
 * and `apps/trader/src/event-door.ts` are the two shipped precedents.
 *
 * ## The outer guard is not decoration
 *
 * The warmed arena protects the PARSE; it does not protect `zod`'s own ERROR
 * CONSTRUCTION, which builds property descriptors from object literals and
 * throws `TypeError` under an inherited `Object.prototype.get` (the "descriptor
 * literals" class). Without the guard, a malformed request would raise out of
 * the one function whose entire job is to answer "this request is malformed" —
 * and on an HTTP surface that is a 500 where a 400 belongs. Every door is
 * TOTAL.
 */

import { readPlainData } from "@polymarket-bot/risk/plain-data";
import { prototypeFreeParser } from "@polymarket-bot/risk/schema-arena";

export type DoorRefusalCode =
  /** D1: the value is not a finite tree of plain own data. */
  | "REQUEST_NOT_DATA"
  /** D2: the value failed its schema. */
  | "REQUEST_INVALID";

export interface DoorRefusal {
  readonly code: DoorRefusalCode;
  readonly detail: string;
  readonly issues: readonly string[];
}

export type DoorResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: DoorRefusal };

interface ParserLike {
  safeParse(value: unknown): { success: boolean } | { success: false; error: unknown };
}

interface ZodIssueLike {
  readonly path: readonly PropertyKey[];
  readonly message: string;
}

function issueStrings(error: unknown): readonly string[] {
  if (typeof error !== "object" || error === null || !Object.hasOwn(error, "issues")) return [];
  const issues = (error as { issues: unknown }).issues;
  if (!Array.isArray(issues)) return [];
  return issues.map((issue) => {
    const typed = issue as ZodIssueLike;
    const path = Array.isArray(typed.path) ? typed.path.map(String).join(".") : "";
    return `${path}: ${String(typed.message)}`;
  });
}

/** Deep-freezes a materialized tree (D4). */
export function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  for (const key of Object.getOwnPropertyNames(value)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return Object.freeze(value);
}

/**
 * Builds a door from a schema. The arena copy is created ONCE, here, and the
 * caller is expected to call this at module load — never inside a handler.
 */
export function buildDoor<Value>(
  schema: unknown,
  what: string,
  read: (materialized: unknown) => Value,
): (input: unknown) => DoorResult<Value> {
  const parser = prototypeFreeParser(schema) as ParserLike;
  return (input: unknown): DoorResult<Value> => {
    try {
      const plain = readPlainData(input, what);
      if (!plain.ok) {
        return {
          ok: false,
          refusal: {
            code: "REQUEST_NOT_DATA",
            detail:
              `the ${what} is not a data record: a request body is a finite tree of plain own ` +
              "data, so hidden, inherited, computed or unreadable state is refused rather than " +
              "inspected (fail closed)",
            issues: plain.problems.map((problem) => `${problem.path}: ${problem.problem}`),
          },
        };
      }
      const materialized = plain.value;
      const parsed = parser.safeParse(materialized);
      if (!parsed.success) {
        return {
          ok: false,
          refusal: {
            code: "REQUEST_INVALID",
            detail: `the ${what} failed its schema`,
            issues: issueStrings((parsed as { error: unknown }).error),
          },
        };
      }
      // D3/D4 — the materialized tree is the answer; the schema only judged it.
      return { ok: true, value: deepFreeze(read(materialized)) };
    } catch (cause) {
      return {
        ok: false,
        refusal: {
          code: "REQUEST_NOT_DATA",
          detail:
            `reading the ${what} failed unexpectedly and was contained (fail closed); a request ` +
            "this process cannot evaluate is not a request it may act on",
          issues: [cause instanceof Error ? cause.message : String(cause)],
        },
      };
    }
  };
}

/** Reads an own string from a materialized tree, or `undefined`. */
export function ownString(record: unknown, key: string): string | undefined {
  if (typeof record !== "object" || record === null) return undefined;
  if (!Object.hasOwn(record, key)) return undefined;
  const value = (record as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

/** Reads an own number from a materialized tree, or `undefined`. */
export function ownNumber(record: unknown, key: string): number | undefined {
  if (typeof record !== "object" || record === null) return undefined;
  if (!Object.hasOwn(record, key)) return undefined;
  const value = (record as Record<string, unknown>)[key];
  return typeof value === "number" ? value : undefined;
}

/** Reads an own boolean from a materialized tree, or `undefined`. */
export function ownBoolean(record: unknown, key: string): boolean | undefined {
  if (typeof record !== "object" || record === null) return undefined;
  if (!Object.hasOwn(record, key)) return undefined;
  const value = (record as Record<string, unknown>)[key];
  return typeof value === "boolean" ? value : undefined;
}

/** Reads an own record from a materialized tree, or `undefined`. */
export function ownRecord(record: unknown, key: string): unknown {
  if (typeof record !== "object" || record === null) return undefined;
  if (!Object.hasOwn(record, key)) return undefined;
  return (record as Record<string, unknown>)[key];
}
