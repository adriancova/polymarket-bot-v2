/**
 * THE CONFIGURATION DOOR: read the operator's file into plain OWN data, judge
 * it inside a containment, and build the gateway's configuration from what the
 * operator actually wrote.
 *
 * ## Why this module exists
 *
 * `docs/adr/ADR-020-schema-parse-boundary-integrity.md` §1: at the pinned
 * `zod@4.4.3` a key the schema DECLARES is read off the prototype chain when
 * the input lacks it (class 1, adoption), and a get-only inherited accessor
 * defeats a schema's own `.default()` — the parse succeeds and the defaulted
 * key never lands as an own property (class 3).
 *
 * `docs/contracts/schema-boundary.md` §3 records this app as **LIVE ×2** and
 * `REC-1` reproduced both at base `5128d6c`:
 *
 * 1. a get-only inherited `tickIntervalMs` defeats the `.default()`
 *    (`Object.hasOwn(config, "tickIntervalMs")` is `false`, the read returns
 *    the accessor's value), so the `dataLossBoundMs` startup check — the one
 *    that keeps the WAL's published data-loss bound from being a false claim —
 *    silently passes on a configuration that must fail;
 * 2. an inherited `binance` block satisfies "at least one feed must be
 *    configured", so a gateway configured to record NOTHING starts.
 *
 * The audit `REC-1` ran over the rest of the door found the same two classes on
 * `wal.fsyncIntervalMs` (the value the data-loss bound is computed against),
 * on the `rtds` and `coinbase` blocks, and on the `markets` presence check.
 *
 * ## What this door performs, stated per ADR-020 §4
 *
 * - **D1 — materialize prototype-free before parsing.** {@link readOwnConfig}
 *   rebuilds the value with `Object.create(null)` from own DESCRIPTORS only, at
 *   every level. A get-only inherited accessor is not read; an inherited block
 *   is not present.
 * - **D2 — NOT PERFORMED, and disclosed.** The severed, warmed arena lives in
 *   `packages/risk`, and this door does not consume it. *(Corrected by `SER-3`,
 *   2026-09-15: this sentence used to say a gateway → `risk` edge was forbidden
 *   outright. That is not what the contract says — the edge is layer 3 → layer
 *   1, DOWNWARD, so §2.1's same-layer rules do not apply and `check:deps`
 *   accepts it; `apps/control-api` has declared the same edge since `WP-240`.
 *   `SER-3` added `@polymarket-bot/risk` to this app for ONE subpath, the
 *   own-data JSON encoder `./plain-json`, consumed by `publisher.ts` alone.
 *   What has NOT changed is D2: the arena is still not consumed here, and
 *   pasting either door module is still forbidden by the deletion guard in
 *   `test/unit/execution-planner/mirrors.test.ts`. Adopting the arena is a
 *   decision for a round that owns this door, not a side effect of an encoder
 *   round.)* The library's own state reads therefore remain defeatable here.
 *   The door answers that for the two classes this round owns by never taking a
 *   value from the library at all: see D3.
 * - **D3 — take values from the materialized tree.** {@link ownGatewayConfig}
 *   builds the configuration from the tree, never from `parsed.data`, and
 *   applies the schema's `.default()`s itself for keys the operator genuinely
 *   did not write. The default VALUES are the named constants the schema
 *   itself is written in ({@link GATEWAY_DEFAULTS}), so there is one source of
 *   truth per default and `./config.test.ts` pins that the door's table covers
 *   every `.default()` the schema declares.
 * - **D4 — emit prototype-free.** The returned configuration and every block
 *   inside it have a null prototype, so a later `config.rtds?.updateStalenessMs
 *   ?? fallback` cannot be answered by `Object.prototype`.
 * - **Refusal construction is contained** (ADR-020 amendment 2026-09-06):
 *   `zod` builds a refusal's issues lazily per call even on a warm schema, and
 *   that path reads through the prototype chain, so `safeParse(INVALID)` can
 *   THROW while assembling them. {@link containedConfigParse} runs the parse
 *   AND the issue rendering inside one `try`, so an invalid configuration is
 *   always a `GatewayConfigurationError` and never an escaped `TypeError`.
 *
 * ## Deployment reading, required whenever the §3 row is quoted
 *
 * Nothing in a configuration FILE can write `Object.prototype`. Both rows need
 * code already executing in the process; they say these checks are not
 * load-bearing against an attacker already inside it, not that an operator file
 * can turn them off. They matter because this is an unattended startup path and
 * one of the two checks is the only thing keeping a published durability bound
 * honest.
 *
 * ## No credential surface, unchanged
 *
 * `GatewayConfigSchema` is strict at every level and this door adds no key that
 * the schema does not declare: it fills declared defaults and copies declared
 * values. There is still no field anywhere in this app that could carry
 * authentication material (§0.2, ADR-010).
 */

import type { z } from "zod";

/** Deepest nesting a configuration may have. */
export const MAX_CONFIG_DEPTH = 24;

/** A record this module built: no prototype, own data properties only. */
export type OwnRecord = Readonly<Record<string, unknown>>;

/** The outcome of reading a configuration value as plain own data. */
export type OwnConfigRead =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly detail: string };

/** Internal signal: this value is not plain data and the read stops here. */
class NotConfigData extends Error {}

function dataDescriptor(value: unknown): PropertyDescriptor {
  // Prototype-free: an inherited `get` makes every object-literal descriptor
  // throw (ADR-020 §1 class 8), and a door that cannot define its own
  // properties would fail open by crashing.
  const descriptor: PropertyDescriptor = Object.create(null);
  descriptor.value = value;
  descriptor.enumerable = true;
  descriptor.writable = false;
  descriptor.configurable = false;
  return descriptor;
}

/** A fresh record with no prototype. */
function emptyOwn(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>;
}

function defineData(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, dataDescriptor(value));
}

/** Reads one own DATA property, refusing an accessor without invoking it. */
function ownValueOf(
  container: object,
  key: string,
): { readonly present: boolean; readonly value: unknown } {
  const descriptor = Object.getOwnPropertyDescriptor(container, key);
  if (descriptor === undefined) {
    return { present: false, value: undefined };
  }
  // `Object.hasOwn`, not `in`: with an inherited `value` every accessor
  // descriptor would read as a data descriptor.
  if (!Object.hasOwn(descriptor, "value")) {
    throw new NotConfigData(
      `configuration key "${key}" is an accessor property: configuration is data, and a getter is code that can answer differently on a second read`,
    );
  }
  return { present: true, value: descriptor.value };
}

function readMember(value: unknown, depth: number): unknown {
  if (value === null) {
    return null;
  }
  // `undefined` is read as ABSENT: it is not JSON, and "present but undefined"
  // must not diverge from "absent" on a prototype-free tree.
  if (value === undefined) {
    return undefined;
  }
  const kind = typeof value;
  if (kind === "string" || kind === "number" || kind === "boolean") {
    return value;
  }
  if (kind !== "object") {
    throw new NotConfigData(`a configuration carries data, not a ${kind}`);
  }
  if (depth >= MAX_CONFIG_DEPTH) {
    throw new NotConfigData(`nested deeper than ${String(MAX_CONFIG_DEPTH)} levels`);
  }
  const container = value as object;
  const prototype: unknown = Object.getPrototypeOf(container);
  if (Array.isArray(container)) {
    if (prototype !== null && prototype !== Array.prototype) {
      throw new NotConfigData("an array with a non-plain prototype is not configuration data");
    }
    return readArrayInto(container, depth);
  }
  if (prototype !== null && prototype !== Object.prototype) {
    throw new NotConfigData(
      "a non-plain prototype: an inherited property is state the configuration does not own, and an operator did not write it",
    );
  }
  return readObjectInto(container, depth);
}

function readObjectInto(container: object, depth: number): OwnRecord {
  const out = emptyOwn();
  for (const key of Reflect.ownKeys(container)) {
    if (typeof key === "symbol") {
      throw new NotConfigData("a symbol-keyed property is not configuration data");
    }
    if (key === "__proto__") {
      throw new NotConfigData('a "__proto__" property, which no copy can carry faithfully');
    }
    const member = ownValueOf(container, key);
    if (!member.present) {
      continue;
    }
    const read = readMember(member.value, depth + 1);
    if (read !== undefined) {
      defineData(out, key, read);
    }
  }
  return out;
}

function readArrayInto(container: object, depth: number): readonly unknown[] {
  const lengthMember = ownValueOf(container, "length");
  const length = lengthMember.value;
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) {
    throw new NotConfigData("an array whose length is not a count");
  }
  const out: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const member = ownValueOf(container, String(index));
    if (!member.present) {
      throw new NotConfigData("a sparse array: a configuration list has no holes");
    }
    Object.defineProperty(out, String(index), dataDescriptor(readMember(member.value, depth + 1)));
  }
  return out;
}

/**
 * D1. Reads a configuration value into a fresh prototype-free tree of plain
 * data, or says why it is not one. TOTAL: never throws.
 */
export function readOwnConfig(value: unknown): OwnConfigRead {
  try {
    return { ok: true, value: readMember(value, 0) };
  } catch (error: unknown) {
    return {
      ok: false,
      detail:
        error instanceof NotConfigData
          ? error.message
          : "reading the configuration as data failed unexpectedly; a configuration that cannot be read is refused rather than started from (fail closed)",
    };
  }
}

/** Whether a value is a record this door materialized. */
export function isOwnRecord(value: unknown): value is OwnRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One issue, in the shape `GatewayConfigurationError` has always carried. */
export interface ConfigIssue {
  readonly path: string;
  readonly message: string;
}

export type ContainedConfigParse =
  | { readonly ok: true }
  | { readonly ok: false; readonly issues: readonly ConfigIssue[] };

/** Anything with `zod`'s `safeParse` shape. */
interface ConfigSchema {
  readonly safeParse: (
    value: unknown,
  ) => { readonly success: true } | { readonly success: false; readonly error: z.ZodError };
}

/**
 * Runs the schema AND renders its issues inside one containment.
 *
 * ADR-020's 2026-09-06 amendment: a warm schema still constructs its issues
 * lazily per refusal, and that construction reads through the prototype chain.
 * A configuration defect must fail startup with a typed error, never with an
 * escaped exception from the reporting path.
 */
export function containedConfigParse(schema: ConfigSchema, value: unknown): ContainedConfigParse {
  try {
    const result = schema.safeParse(value);
    if (result.success) {
      return { ok: true };
    }
    return {
      ok: false,
      issues: result.error.issues.map((issue) => ({
        path: issue.path.map((part) => String(part)).join("."),
        message: issue.message,
      })),
    };
  } catch {
    return {
      ok: false,
      issues: [
        {
          path: "",
          message:
            "the configuration schema could not judge this value (its refusal could not be constructed); refused",
        },
      ],
    };
  }
}

/**
 * Every `.default()` `GatewayConfigSchema` declares, by the block it lives in.
 *
 * D3 obligation: the library's output assembly is what class 3 defeats, so the
 * door applies the defaults itself, into its OWN prototype-free record. The
 * values are the same named constants the schema is written in — there is one
 * source of truth per default, and `./config.test.ts` pins that this table
 * covers exactly the keys the schema defaults.
 *
 * A `Map`, not an object literal: a lookup for a block name this table does not
 * carry must answer "no defaults", and an object literal would answer from
 * `Object.prototype`.
 */
export type BlockDefaults = ReadonlyMap<string, readonly (readonly [string, unknown])[]>;

/**
 * D3/D4. Builds the configuration from the materialized tree, filling the
 * declared defaults for keys the operator genuinely did not write.
 *
 * `rootDefaults` are the top-level `.default()`s; `blockDefaults` are the
 * per-block ones. A block that is ABSENT from the tree stays absent — filling
 * it would invent a feed — except for the blocks named in
 * `alwaysPresentBlocks`, whose whole object the schema defaults.
 */
export function ownGatewayConfig(
  tree: OwnRecord,
  rootDefaults: readonly (readonly [string, unknown])[],
  blockDefaults: BlockDefaults,
  alwaysPresentBlocks: readonly string[],
): OwnRecord {
  const out = emptyOwn();
  for (const key of Object.keys(tree)) {
    const defaults = blockDefaults.get(key);
    const value = tree[key];
    defineData(
      out,
      key,
      defaults !== undefined && isOwnRecord(value) ? withBlockDefaults(value, defaults) : value,
    );
  }
  for (const [key, value] of rootDefaults) {
    if (!Object.hasOwn(out, key)) {
      defineData(out, key, value);
    }
  }
  for (const key of alwaysPresentBlocks) {
    if (!Object.hasOwn(out, key)) {
      defineData(out, key, withBlockDefaults(emptyOwn(), blockDefaults.get(key) ?? []));
    }
  }
  return out;
}

function withBlockDefaults(
  block: OwnRecord,
  defaults: readonly (readonly [string, unknown])[],
): OwnRecord {
  const out = emptyOwn();
  // `block` is already prototype-free, so this copies exactly what it carries.
  for (const key of Object.keys(block)) {
    defineData(out, key, block[key]);
  }
  for (const [key, value] of defaults) {
    if (!Object.hasOwn(out, key)) {
      defineData(out, key, value);
    }
  }
  return out;
}
