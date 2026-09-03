/**
 * `readOwnFieldsOnce` — the package's one way to take a snapshot of the fields
 * of a caller-supplied object.
 *
 * Added 2026-09-03 in remediation round 3. Three consecutive review rounds
 * found the same shape of defect on a new surface each time, and every instance
 * of it reduced to one of two mistakes: reading a caller's property MORE THAN
 * ONCE (so the value that was validated and the value that was used could
 * differ), or reading it OUTSIDE a guard in a function whose contract says it
 * never throws. This helper makes both impossible at the surfaces that use it:
 * every named field is read exactly once, inside a guard, into an inert record
 * that every later step consumes.
 *
 * What it deliberately does NOT do: walk. A field's VALUE may still be an
 * exotic object; a caller that intends to keep or inspect one materializes it
 * (`json.ts`). This is the shallow half — identifiers, versions, function
 * references, byte strings — where materialization would be the wrong shape
 * because the values are not data the runtime copies (a callback is a function;
 * a port is an object with methods).
 *
 * A missing or non-object owner yields all-`undefined` fields rather than a
 * throw, so `restoreCheckpoint(null as never, …)` and
 * `createStrategyInstanceRuntime({} as never)` refuse like any other malformed
 * argument.
 */

import { describeCause } from "./describe.js";

export type FieldSnapshot<K extends string> =
  | { readonly ok: true; readonly fields: Readonly<Record<K, unknown>> }
  | { readonly ok: false; readonly field: K; readonly problem: string };

export function readOwnFieldsOnce<K extends string>(
  owner: unknown,
  label: string,
  fields: readonly K[],
): FieldSnapshot<K> {
  const snapshot = {} as Record<K, unknown>;
  const readable = owner !== null && (typeof owner === "object" || typeof owner === "function");
  for (const field of fields) {
    if (!readable) {
      snapshot[field] = undefined;
      continue;
    }
    try {
      snapshot[field] = (owner as Record<string, unknown>)[field];
    } catch (cause) {
      return {
        ok: false,
        field,
        problem:
          `${label}.${field} could not be read (${describeCause(cause)}) — an argument whose ` +
          "property access executes code is refused, not propagated",
      };
    }
  }
  return { ok: true, fields: snapshot };
}
