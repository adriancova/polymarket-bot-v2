/**
 * SELECTIVE, TRAP-FREE FIELD EXTRACTION — the §6 invariant-13 mechanism.
 *
 * "Safety cancellation outranks new order placement", and the WP-190 packet's
 * binding reading of WP-180's round-8 BLOCKER: **a malformed-input refusal
 * must never be converted into, or block, a valid CANCEL disposition.**
 *
 * `readPlainData` is all-or-nothing: it walks the WHOLE value, so one hostile
 * or malformed field anywhere — a throwing getter on `record.worstCase`, a
 * `Proxy` under `inputs.markets[2].book` — refuses the whole read. That is the
 * right behaviour for a placement (fail closed on anything). For a CANCEL it
 * is exactly the trap invariant 13 forbids: a refusal born from a field the
 * cancel never needed would block the cancel.
 *
 * So the cancel path does not read whole documents. It PLUCKS each field it
 * actually consumes — walking own DATA descriptors only, never invoking a
 * getter, refusing a `Proxy` before any reflective operation touches it (the
 * same trap-free `util.types.isProxy` predicate `plain-data.ts` uses, and for
 * the same measured reason: no portable predicate exists) — and then
 * materializes just that subtree through `readPlainData`. A hostile sibling
 * field is never touched, so it can neither throw nor refuse.
 *
 * A pluck that fails is still a typed refusal — for THAT field. What this
 * module removes is only the coupling between a cancel and the fields the
 * cancel does not consume. Nothing here converts a refusal into a cancel.
 */

import { types } from "node:util";

import { readPlainData, type PlainDataRead } from "@polymarket-bot/risk/plain-data";

/** One step failed: where, and why the container could not answer it as data. */
export interface PluckProblem {
  readonly path: string;
  readonly problem: string;
}

export type PluckResult =
  | { readonly ok: true; readonly read: PlainDataRead & { readonly ok: true } }
  | { readonly ok: false; readonly problem: PluckProblem };

/** The own DATA descriptor value of `key`, refusing traps and accessors. */
function ownStep(
  container: unknown,
  key: string,
  path: string,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly problem: PluckProblem } {
  if (container === null || typeof container !== "object") {
    return {
      ok: false,
      problem: { path, problem: "the container is not an object, so the field cannot exist" },
    };
  }
  // Trap-free, BEFORE any reflective operation (see `plain-data.ts`,
  // `isProxyValue`): every reflective operation on a `Proxy` runs a trap.
  let proxied: boolean;
  try {
    proxied = types.isProxy(container);
  } catch {
    return { ok: false, problem: { path, problem: "the container could not be classified as data" } };
  }
  if (proxied) {
    return {
      ok: false,
      problem: { path, problem: "the container is a Proxy: code, not data (fail closed)" },
    };
  }
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(container, key);
  } catch {
    return { ok: false, problem: { path, problem: "the property descriptor could not be read" } };
  }
  if (descriptor === undefined) {
    return { ok: false, problem: { path, problem: "the field is absent (own properties only; nothing is read through a prototype chain)" } };
  }
  if (!Object.hasOwn(descriptor, "value")) {
    return {
      ok: false,
      problem: { path, problem: "an accessor property: a getter is code, not data (never invoked, refused instead)" },
    };
  }
  return { ok: true, value: descriptor.value };
}

/**
 * Plucks `keys` step by step from `root`, then materializes ONLY the reached
 * subtree. `rootPath` names the root in problem paths (`"record"`).
 *
 * Absent-versus-present distinction is preserved: a missing final key is
 * reported as a problem; callers that accept absence use {@link pluckOptional}.
 */
export function pluck(root: unknown, rootPath: string, keys: readonly string[]): PluckResult {
  let current: unknown = root;
  let path = rootPath;
  for (const key of keys) {
    const step = ownStep(current, key, `${path}.${key}`);
    if (!step.ok) return { ok: false, problem: step.problem };
    current = step.value;
    path = `${path}.${key}`;
  }
  const read = readPlainData(current, path);
  if (!read.ok) {
    const first = read.problems[0];
    return {
      ok: false,
      problem:
        first === undefined
          ? { path, problem: "the field could not be read as data" }
          : { path: first.path, problem: first.problem },
    };
  }
  return { ok: true, read };
}

