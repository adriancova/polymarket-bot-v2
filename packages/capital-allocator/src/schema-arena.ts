/**
 * THE PARSING ARENA — adversarial review round 8.
 *
 * DUPLICATED, NOT SHARED, from `@polymarket-bot/risk`'s `src/schema-arena.ts`,
 * for the same reason `plain-data.ts` and `guards.ts` are duplicated in this
 * package: sharing a module between two layer-1 packages needs a same-layer
 * edge that `docs/contracts/dependency-direction.md` §2.1 does not list, and a
 * remediation may not widen a frozen contract to make its own life easier. The
 * two copies are byte-identical below this header, both are covered by the
 * drift test in `test/unit/risk/public-surface.test.ts`, and
 * `docs/handoffs/WP-180.md` records the duplication (R7-1) so a future contract
 * owner can collapse them with one §2.1 row.
 *
 * WHY THIS PACKAGE NEEDS IT. `parseAllocatorCaps`, `createAllocatorState` and
 * `evaluateReservation` each validate a materialized tree with a `zod` schema,
 * so each one had the round-8 defect: the library assembles an output this
 * package discards, by assignment onto an ordinary object, and that assignment
 * invokes whatever an inherited setter puts in its way. The caps door is the
 * one where it matters most — the `AGENTS.md` live-micro floors are fenced
 * there — so the fix is applied to every door of this package, not only to the
 * one a reviewer probed.
 *
 * Everything below is the risk package's text, kept verbatim so the two copies
 * can be diffed.
 */

// ---- shared body: byte-identical with the mirrored copy ---------------------

import { ownAccessorDescriptor, ownDataDescriptor } from "./plain-data.js";

/** The prefix every arena build failure carries, so a test can bind to it. */
export const SCHEMA_ARENA_ERROR = "schema arena";

/**
 * Every `zod` node type the arena knows how to copy.
 *
 * FAIL CLOSED, AND MEASURED IN BOTH DIRECTIONS. This list is not aspirational:
 * `schema-arena.test.ts` walks every door schema of both packages and requires
 * the set of types it finds to be EXACTLY this list, so a type that disappears
 * is removed and a type that appears is either added deliberately or fails the
 * build. A node type absent from it cannot be copied, and an uncopyable node is
 * an unprotected assembly — the state this module exists to make unreachable.
 */
export const ARENA_NODE_TYPES: readonly string[] = [
  "array",
  "boolean",
  "default",
  "enum",
  "literal",
  "never",
  "number",
  "object",
  "optional",
  "readonly",
  "record",
  "string",
  "union",
  "unknown",
];

/** The payload the library hands from one schema node to the next. */
interface ArenaPayload {
  value: unknown;
  issues: unknown[];
}

/**
 * A `zod` schema node, described STRUCTURALLY so this module imports nothing.
 *
 * The three members are the whole of the coupling: the node's definition, the
 * constructor that builds another node of the same kind from a definition, and
 * the entry point a parent node calls.
 */
interface ArenaNode {
  readonly _zod: {
    readonly def: Record<string, unknown>;
    readonly constr: new (def: unknown) => ArenaNode;
    run: (payload: ArenaPayload, ctx: object) => unknown;
  };
}

/** A fresh container for slots, with no prototype and therefore no inheritance. */
function emptySlots(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>;
}

/**
 * Creates `name` on `target` as an OWN data property.
 *
 * `Object.defineProperty`, never `target[name] = value`, for the same reason
 * `plain-data.ts` gives: assignment is `Set`, and `Set` consults the prototype
 * chain. `target` here always has a `null` prototype already, so this is
 * belt-and-braces — but the whole point of this module is that the belt is not
 * enough on its own.
 *
 * The DESCRIPTOR comes from `plain-data.ts` and has no prototype either: a
 * descriptor written as an object literal is read with `HasProperty`, so an
 * inherited `get` turns every `defineProperty` in this repository into a
 * `TypeError` (measured — see {@link ownDataDescriptor}).
 */
function defineSlot(target: Record<string, unknown>, name: string, value: unknown): void {
  Object.defineProperty(target, name, ownDataDescriptor(value));
}

/**
 * One slot of a schema DEFINITION, by name.
 *
 * A plain read, deliberately: the library stores an object schema's `shape`
 * behind a memoizing GETTER, so a descriptor read would hand back the accessor
 * instead of the shape. Nothing caller-supplied is reachable here — these are
 * the definition objects the library built at module load from this
 * repository's own schema declarations — and `name` is always an OWN name of
 * `source`, taken from `Object.getOwnPropertyNames` on the line that calls this.
 */
function readSlot(source: Record<string, unknown>, name: string): unknown {
  return source[name];
}

function isArenaNode(value: unknown): value is ArenaNode {
  if (value === null || typeof value !== "object") return false;
  const internals = (value as { _zod?: unknown })._zod;
  if (internals === null || typeof internals !== "object") return false;
  const slots = internals as { def?: unknown; constr?: unknown; run?: unknown };
  return (
    typeof slots.run === "function" &&
    typeof slots.constr === "function" &&
    slots.def !== null &&
    typeof slots.def === "object"
  );
}

/**
 * Whether `value` is a FRESH, EMPTY ordinary container — the shape the library
 * assigns to `payload.value` when it begins assembling an object or an array.
 *
 * Deliberately narrow. A value that is already prototype-free, or that carries
 * any property, is left exactly as it is: the arena replaces the library's
 * assembly CONTAINER and nothing else, so no validated value is ever
 * substituted, reshaped or copied on its way through.
 */
function isFreshOrdinaryContainer(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) {
    return (
      Object.getPrototypeOf(value) === Array.prototype && (value as readonly unknown[]).length === 0
    );
  }
  return (
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.getOwnPropertyNames(value).length === 0 &&
    Object.getOwnPropertySymbols(value).length === 0
  );
}

/** The same container, with no prototype: an array stays an array. */
function prototypeFreeContainer(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items: unknown[] = [];
    // An array with no prototype is still an array exotic object: `length`
    // stays own and self-maintaining, and `Array.isArray` still answers true.
    // What it no longer has is a chain for `items[0] = …` to walk.
    Object.setPrototypeOf(items, null);
    return items;
  }
  return emptySlots();
}

/**
 * The payload a node in the copy actually runs on.
 *
 * `value` is an ACCESSOR, and that accessor is the whole mechanism: the library
 * assigns its fresh assembly container to `payload.value`, the arena stores a
 * prototype-free one instead, and every `payload.value[key] = …` that follows
 * lands on an object with no prototype chain. The library uses the payload this
 * function returns — it reads its result rather than the object it passed in —
 * so nothing is copied back.
 */
function arenaPayload(payload: ArenaPayload): ArenaPayload {
  const arena = emptySlots();
  let held: unknown = payload.value;
  Object.defineProperty(
    arena,
    "value",
    ownAccessorDescriptor(
      (): unknown => held,
      (next: unknown): void => {
        held = isFreshOrdinaryContainer(next) ? prototypeFreeContainer(next) : next;
      },
    ),
  );
  defineSlot(arena, "issues", payload.issues);
  return arena as unknown as ArenaPayload;
}

/** Contexts this module built, so a polluted `jitless` cannot forge one. */
const ARENA_CONTEXTS = new WeakSet<object>();
/** One arena context per library context, so nesting allocates nothing. */
const ARENA_CONTEXT_OF = new WeakMap<object, object>();

/**
 * A prototype-free copy of the library's parse context, with `jitless` set.
 *
 * The copy exists because the library reads OPTIONAL switches off this object
 * and an ordinary object answers those reads from `Object.prototype` —
 * `skipChecks` alone turned every format check in every door into a no-op at the
 * reviewed tip (transcript in the module header). Only OWN DATA properties are
 * carried over: an accessor on a context is not something the library puts
 * there.
 *
 * Membership is remembered in a `WeakSet` rather than detected by reading
 * `ctx.jitless`, because reading `jitless` off an ordinary object is itself a
 * prototype read — an inherited `jitless: true` would otherwise let a polluted
 * context through untouched.
 */
function arenaContext(ctx: unknown): object {
  const given = ctx !== null && typeof ctx === "object" ? (ctx as object) : undefined;
  if (given !== undefined && ARENA_CONTEXTS.has(given)) return given;
  if (given !== undefined) {
    const cached = ARENA_CONTEXT_OF.get(given);
    if (cached !== undefined) return cached;
  }
  const arena = emptySlots();
  if (given !== undefined) {
    for (const name of Object.getOwnPropertyNames(given)) {
      const descriptor = Object.getOwnPropertyDescriptor(given, name);
      if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) continue;
      defineSlot(arena, name, descriptor.value);
    }
  }
  defineSlot(arena, "jitless", true);
  ARENA_CONTEXTS.add(arena);
  if (given !== undefined) ARENA_CONTEXT_OF.set(given, arena);
  return arena;
}

/** One definition slot, with every schema inside it replaced by its copy. */
function arenaSlot(value: unknown, memo: WeakMap<object, ArenaNode>): unknown {
  if (isArenaNode(value)) return arenaNode(value, memo);
  if (Array.isArray(value)) {
    const items: unknown[] = [];
    for (const item of value as readonly unknown[]) items.push(arenaSlot(item, memo));
    return items;
  }
  if (value === null || typeof value !== "object") return value;
  // Only an ORDINARY object can be a container of schemas here (an object
  // schema's `shape`). Anything else — a library check instance, a `Set`, a
  // `Map` — is a value of the library's own, and is carried over untouched.
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;
  const mapped = emptySlots();
  for (const name of Object.getOwnPropertyNames(value as Record<string, unknown>)) {
    defineSlot(
      mapped,
      name,
      arenaSlot(readSlot(value as Record<string, unknown>, name), memo),
    );
  }
  return mapped;
}

/**
 * One node of the parsing copy: same kind, same definition, protected payload.
 *
 * The definition handed to the library's own constructor has NO PROTOTYPE
 * either, which closes a second class of the same defect: the library reads
 * optional definition slots (`checks`, `catchall`, `error`) at construction
 * time, and on an ordinary definition object an absent slot is answered by
 * `Object.prototype`.
 */
function arenaNode(original: ArenaNode, memo: WeakMap<object, ArenaNode>): ArenaNode {
  const built = memo.get(original);
  if (built !== undefined) return built;
  const def = original._zod.def;
  const type = readSlot(def, "type");
  if (typeof type !== "string" || !ARENA_NODE_TYPES.includes(type)) {
    throw new Error(
      `${SCHEMA_ARENA_ERROR}: a door schema contains the node type ${
        typeof type === "string" ? `"${type}"` : "<none>"
      }, which the arena cannot copy. A node it cannot copy is a parse it cannot` +
        " protect, so this fails the build rather than validating through an unprotected" +
        " assembly. Add the type to ARENA_NODE_TYPES only with a measurement of what it" +
        " assembles.",
    );
  }
  const arenaDef = emptySlots();
  for (const name of Object.getOwnPropertyNames(def)) {
    defineSlot(arenaDef, name, arenaSlot(readSlot(def, name), memo));
  }
  const copy = new original._zod.constr(arenaDef);
  memo.set(original, copy);
  const libraryRun = copy._zod.run;
  copy._zod.run = (payload: ArenaPayload, ctx: object): unknown =>
    libraryRun(arenaPayload(payload), arenaContext(ctx));
  return copy;
}

/**
 * A PARSING COPY of `schema` whose output assembly has no prototype chain.
 *
 * Use it wherever a door asks a schema whether a materialized tree is
 * acceptable. The answer is the library's own; what changes is that neither the
 * answer nor the process can be affected by what a caller has put on
 * `Object.prototype`.
 *
 * The returned value has the SAME TYPE as the schema it copies, so
 * `.safeParse()` keeps its inferred result type and a door's code does not
 * change shape. It is deliberately NOT exported from either package: it is a
 * parsing detail, and the public schema stays the one consumers can infer types
 * from.
 */
export function prototypeFreeParser<T>(schema: T): T {
  if (!isArenaNode(schema)) {
    throw new Error(
      `${SCHEMA_ARENA_ERROR}: the value handed to the arena is not a schema node (no _zod.def/constr/run)`,
    );
  }
  return arenaNode(schema, new WeakMap<object, ArenaNode>()) as unknown as T;
}
