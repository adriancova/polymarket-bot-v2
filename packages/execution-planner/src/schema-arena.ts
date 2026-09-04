/**
 * THE PARSING ARENA — WP-190's copy.
 *
 * DUPLICATED, NOT SHARED, from `@polymarket-bot/risk`'s `src/schema-arena.ts`
 * (WP-180 adversarial review rounds 8–9), exactly as
 * `@polymarket-bot/capital-allocator` already duplicates it: sharing a module
 * between two layer-1 packages needs a same-layer edge that
 * `docs/contracts/dependency-direction.md` §2.1 does not list (F13), and this
 * package may not widen a frozen contract to make its own life easier. The
 * copies are byte-identical below this header (WP-180 R7-1 precedent); this
 * package's `README.md` (§ "Mirrored modules") and the WP-190 handoff record
 * the third duplication for the contract owner's cross-package
 * schema-boundary governance round.
 *
 * WHY THIS PACKAGE NEEDS IT. The planner validates §7.7 intents with the
 * FROZEN DOMAIN SCHEMAS (`IntentSchema`, `IsoTimestampSchema`,
 * `InternalMarketIdSchema`) rather than re-deriving them — and any `zod` parse
 * is exposed to the measured round-8/9 classes: an inherited setter invoked
 * while the library assembles an output this package discards, an inherited
 * `skipChecks` disabling every format check, an inherited `when` skipping
 * every custom check, and a cold first parse poisoned by one enumerable
 * `Object.prototype` property. Each domain door schema is therefore wrapped by
 * {@link prototypeFreeParser} at module load (which also WARMS the copy —
 * `warmNode` — while the process is clean).
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

/**
 * A `zod` CHECK instance — `.min()`, `.max()`, a `.refine()` — described the
 * same way. A check has `check` where a schema node has `run`, and review
 * round 9 measured why the arena must copy rather than share them: the parse
 * path reads `ch._zod.def.when` to decide whether a check runs at all, a shared
 * check's def is an ordinary library literal, and one inherited
 * `when: () => false` on `Object.prototype` silently skipped every custom check
 * in every door (a `strategyInstanceId` of `"has whitespace"` VALIDATED at the
 * round-8 tip).
 */
interface ArenaCheck {
  readonly _zod: {
    readonly def: Record<string, unknown>;
    readonly constr: new (def: unknown) => ArenaCheck;
    readonly check: (payload: ArenaPayload) => unknown;
  };
}

/** One memo per build: original node → copy, original check → copy. */
interface ArenaMemo {
  readonly nodes: WeakMap<object, ArenaNode>;
  readonly checks: WeakMap<object, ArenaCheck>;
}

/** A fresh container for slots, with no prototype and therefore no inheritance. */
function emptySlots(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>;
}

/**
 * Severs an ORDINARY container's prototype chain, so an absent field answers
 * `undefined` — the clean-process answer — instead of whatever a caller has put
 * on `Object.prototype`. This is review round 9's class fix: the library keeps
 * per-instance state in ordinary object literals (`_zod`, its `bag`, the
 * rebuilt `shape`, the `propValues` table) and its parse path reads OPTIONAL
 * fields off them (`optin`, `optout`, `values`, `when`, …), so every such read
 * on a copy was a prototype walk. Two were measured as live fail-opens
 * (transcripts in the module header); the fix removes the chain those reads
 * walked rather than pinning the two names that happened to be caught.
 *
 * FAILS LOUDLY, BY DESIGN. When `requiredFor` is given, the container is one
 * the arena's correctness DEPENDS on being an ordinary own-data object — a
 * copy's `_zod`. If a `zod` upgrade ever ships one inheriting from anything but
 * `Object.prototype` (state moved onto a class prototype, say), severing would
 * silently discard that state — so this throws at BUILD TIME instead, which is
 * module load, before any door can answer. Without `requiredFor` the container
 * is merely hardened when it is ordinary and left alone otherwise (a `Set`, a
 * `Map`, a `RegExp` are the library's own typed values and keep their
 * prototypes).
 */
function severOrdinaryChain(container: unknown, requiredFor: string | undefined): void {
  if (container === null || typeof container !== "object") {
    if (requiredFor !== undefined) {
      throw new Error(
        `${SCHEMA_ARENA_ERROR}: ${requiredFor} is not an object, so the library has changed` +
          " the internal layout this arena is pinned to. Re-measure before upgrading.",
      );
    }
    return;
  }
  const chain = Object.getPrototypeOf(container);
  if (chain === Object.prototype) {
    Object.setPrototypeOf(container, null);
    return;
  }
  if (chain !== null && requiredFor !== undefined) {
    throw new Error(
      `${SCHEMA_ARENA_ERROR}: ${requiredFor} inherits from an unexpected prototype. Severing` +
        " it could silently discard library state, so this fails the build instead —" +
        " re-measure the pinned internals before upgrading the library.",
    );
  }
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
 * One slot of a schema DEFINITION or of a copy's `_zod` container, by name.
 *
 * A plain read, deliberately: the library stores an object schema's `shape`
 * behind a memoizing GETTER (and several `_zod` slots behind lazy getters), so
 * a descriptor read would hand back the accessor instead of the value. Nothing
 * caller-supplied is reachable here — these are the definition objects the
 * library built at module load from this repository's own schema declarations,
 * or `_zod` containers the arena has already severed. `name` is either an OWN
 * name of `source` (taken from `Object.getOwnPropertyNames` on the calling
 * line) or, in {@link warmNode} only, a possibly-absent slot on a container
 * whose prototype is `null` — where an absent read answers `undefined` without
 * consulting any chain.
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
 * A PURE check instance: it has `check` and no `run`. A string-format schema is
 * BOTH a schema node and a check — it carries `run` — so {@link arenaSlot}
 * classifies it as a node first, and its def (where its `when` would live) is
 * already the prototype-free copy. This predicate is only for the residents of
 * a definition's `checks` array: `min_length`, `max_length`, `greater_than`,
 * `custom` and their kin.
 */
function isArenaCheck(value: unknown): value is ArenaCheck {
  if (value === null || typeof value !== "object") return false;
  const internals = (value as { _zod?: unknown })._zod;
  if (internals === null || typeof internals !== "object") return false;
  const slots = internals as { def?: unknown; constr?: unknown; check?: unknown; run?: unknown };
  return (
    slots.run === undefined &&
    typeof slots.check === "function" &&
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

/** One definition slot, with every schema OR CHECK inside it replaced by its copy. */
function arenaSlot(value: unknown, memo: ArenaMemo): unknown {
  if (isArenaNode(value)) return arenaNode(value, memo);
  if (isArenaCheck(value)) return arenaCheck(value, memo);
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
 * One CHECK of the parsing copy: same rule, prototype-free definition.
 *
 * Round 8 carried check instances over SHARED, and round 9 measured the
 * consequence: the parse path reads `ch._zod.def.when` before running a check,
 * a shared check's def is an ordinary library literal, and one inherited
 * `when: () => false` skipped every custom check in every door — a live
 * fail-open (module header). A shared def cannot be severed without mutating
 * the library's own schema, so the check is COPIED exactly as a node is: the
 * library's own constructor, a definition with no prototype, and a `_zod`
 * container that cannot answer through a chain.
 */
function arenaCheck(original: ArenaCheck, memo: ArenaMemo): ArenaCheck {
  const built = memo.checks.get(original);
  if (built !== undefined) return built;
  const def = original._zod.def;
  const arenaDef = emptySlots();
  for (const name of Object.getOwnPropertyNames(def)) {
    defineSlot(arenaDef, name, arenaSlot(readSlot(def, name), memo));
  }
  const copy = new original._zod.constr(arenaDef);
  memo.checks.set(original, copy);
  severOrdinaryChain(copy._zod, "the _zod container of a check copy");
  // A refinement built with the BASE check class keeps its RULE in instance
  // state rather than in its definition (`_zod.check` is assigned directly, so
  // reconstructing from the definition alone loses it — measured:
  // `ch._zod.check is not a function` on every door). Carry every missing OWN
  // DATA slot over from the original: the rule function is shared, which is
  // exactly what round 8 already accepted for every check, and the slot lands
  // on a severed container. An ACCESSOR instance slot would mean the library
  // keeps check state in a shape this arena has never measured, so that fails
  // the build instead of guessing.
  const originalSlots = original._zod as unknown as Record<string, unknown>;
  const copySlots = copy._zod as unknown as Record<string, unknown>;
  for (const name of Object.getOwnPropertyNames(originalSlots)) {
    if (name === "def" || Object.hasOwn(copySlots, name)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(originalSlots, name);
    if (descriptor === undefined) continue;
    if (!Object.hasOwn(descriptor, "value")) {
      throw new Error(
        `${SCHEMA_ARENA_ERROR}: a check instance carries the accessor slot "${name}", which` +
          " the arena has never measured. Re-measure before upgrading the library.",
      );
    }
    defineSlot(copySlots, name, descriptor.value);
  }
  return copy;
}

/**
 * Forces every LAZILY BUILT parse structure of a fresh copy NOW — at build
 * time, which is module load, which is clean by definition — and severs the
 * chains of the ordinary containers the library rebuilt along the way.
 *
 * WHY (review round 9, the cold-first-parse trap). On the FIRST parse the
 * library rebuilds an object schema's `shape` as an ordinary spread literal,
 * walks it with `for…in` to compute `propValues`, and builds the
 * discriminated-union discriminator map from those tables. `for…in` on an
 * ordinary object ENUMERATES inherited enumerable names, so one enumerable
 * data property on `Object.prototype` made a cold first parse throw — and the
 * half-computed lazy is then POISONED, so every later parse of that copy fails
 * too, clean or not (both measured; module header). One probe parse with an
 * object-shaped value forces all of it while the process is clean: the `shape`
 * getter, the normalized key tables, `propValues`, and the discriminator map
 * (`disc` is reached whenever the discriminated union sees ANY object). The
 * probe's verdict is discarded; a throw here is a BUILD failure, which is the
 * loud outcome this module prefers to an unprotected parse.
 */
function warmNode(copy: ArenaNode): void {
  copy._zod.run({ value: {}, issues: [] }, emptySlots());
  // The library memoized `shape` as an ordinary `{ ...sh }` spread on the
  // copy's own definition during the probe; sever it so no later walk or read
  // of it can meet an inherited name.
  const def = copy._zod.def;
  if (Object.hasOwn(def, "shape")) severOrdinaryChain(readSlot(def, "shape"), undefined);
  // Reading `propValues` forces that lazy for node kinds the probe could not
  // reach it on; the table it returns is an ordinary literal, so sever it too.
  const slots = copy._zod as unknown as Record<string, unknown>;
  severOrdinaryChain(readSlot(slots, "propValues"), undefined);
  severOrdinaryChain(readSlot(slots, "bag"), undefined);
}

/**
 * One node of the parsing copy: same kind, same definition, protected payload.
 *
 * The definition handed to the library's own constructor has NO PROTOTYPE
 * either, which closes a second class of the same defect: the library reads
 * optional definition slots (`checks`, `catchall`, `error`) at construction
 * time, and on an ordinary definition object an absent slot is answered by
 * `Object.prototype`.
 *
 * Since round 9 the copy's `_zod` INSTANCE-SLOT container is severed as well —
 * the parse path reads `optin`, `optout`, `values`, `pattern` and `propValues`
 * off it, and on an ordinary container every absent one of those was a
 * prototype walk (`optin`+`optout` together waived required keys; module
 * header) — and the copy is WARMED so no lazy structure is left for a polluted
 * first parse to build ({@link warmNode}).
 */
function arenaNode(original: ArenaNode, memo: ArenaMemo): ArenaNode {
  const built = memo.nodes.get(original);
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
  memo.nodes.set(original, copy);
  severOrdinaryChain(copy._zod, `the _zod container of a "${type}" copy`);
  const libraryRun = copy._zod.run;
  copy._zod.run = (payload: ArenaPayload, ctx: object): unknown =>
    libraryRun(arenaPayload(payload), arenaContext(ctx));
  warmNode(copy);
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
  const memo: ArenaMemo = {
    nodes: new WeakMap<object, ArenaNode>(),
    checks: new WeakMap<object, ArenaCheck>(),
  };
  return arenaNode(schema, memo) as unknown as T;
}
