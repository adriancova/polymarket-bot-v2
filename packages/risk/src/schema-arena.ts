/**
 * THE PARSING ARENA — adversarial review round 8.
 *
 * CANONICAL, AND THE ONLY COPY (`WP-180-FU2`, 2026-09-04). This module used to
 * be DUPLICATED into `packages/capital-allocator` and
 * `packages/execution-planner`, byte-identical below the shared-body marker and
 * bound by a drift test. `GOV-2A` ruled the duplication out and collapsed the
 * three copies here. Both consumers now import it as
 * `@polymarket-bot/risk/schema-arena` across the
 * `docs/contracts/dependency-direction.md` §2.1 **S3** / **S4** same-layer
 * edges; the module is reachable only through this package's `exports` map
 * (F16). Nothing below the shared-body marker changed in the collapse — the
 * body is byte for byte what review rounds 8-9 left here.
 * `test/unit/execution-planner/mirrors.test.ts` is now the DELETION guard: it
 * fails if a copy of this body reappears under any other package's `src`.
 *
 * WHY THIS MODULE EXISTS. Round 7 established that a schema is asked a QUESTION
 * and that its OUTPUT is not evidence: every door validates the materialized
 * tree and then uses the materialized tree. Review round 8 found that rule
 * NECESSARY BUT NOT SUFFICIENT, with a probe this module exists to answer:
 * discarding the library's output does not stop the library from BUILDING it,
 * and it builds it by ASSIGNMENT — `newResult[key] = value` — onto an object it
 * created with `{}`. An ordinary object inherits from `Object.prototype`, so
 * that assignment consults the prototype chain and invokes an inherited SETTER.
 *
 * Measured against the pinned `zod@4.4.3`, at the round-8 tip, with ONE
 * non-enumerable configurable accessor on `Object.prototype` and a VALID
 * `CANCEL` carrying its own `intent.reason`:
 *
 * ```text
 * Object.prototype.reason = { set() { throw … } }
 *   evaluateIntent(cancel)  → approved=false, ["RISK_INPUT_INVALID"], setterCalls=1
 * ```
 *
 * The cancel was trapped (§6 invariant 13) by a failure inside somebody else's
 * output assembly — an output this package does not read. An ACCEPTING setter
 * was invoked three times across one direct validation and one evaluation: the
 * answer survived, but a caller-supplied prototype was reading every validated
 * field this package holds.
 *
 * WHY THE OBVIOUS FIX IS A FAIL-OPEN, MEASURED RATHER THAN ARGUED. "The
 * assembly threw, so ignore it and answer VALID" is unsound, because the
 * library interleaves per-key VALIDATION with per-key ASSIGNMENT: the throw
 * aborts the parse, and every key after it is never validated at all. The probe,
 * verbatim:
 *
 * ```text
 * schema = z.strictObject({ a: z.strictObject({ reason: z.string() }), b: z.string() })
 * value  = { a: { reason: "ok" }, b: 42 }        // INVALID: `b` is a number
 * clean                       → success: false
 * Object.prototype.reason throws → THREW after 1 setter call, issues seen: []
 * ```
 *
 * Answering "valid" there admits an input nobody validated. So the fix cannot be
 * to tolerate the assembly. **The assembly has to stop being able to reach a
 * polluted prototype at all**, which is what this module does.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DOES
 * ---------------------------------------------------------------------------
 *
 * {@link prototypeFreeParser} returns a PARSING COPY of a schema: the same
 * validation, node for node, with two differences that are invisible to a
 * caller and decisive under prototype augmentation.
 *
 * 1. **THE ASSEMBLY TARGET HAS NO PROTOTYPE.** Every node in the copy runs with
 *    a payload whose `value` is an accessor: when the library assigns a FRESH,
 *    EMPTY ordinary container to it — which is exactly how it starts assembling
 *    an object, a record or an array — the arena substitutes a prototype-FREE
 *    one. Every subsequent `payload.value[key] = …` then creates an own data
 *    property on an object with no prototype chain, so no inherited setter is
 *    consulted, none is invoked, and none can throw. The copy is used only to
 *    ASK the question; its output is discarded exactly as before.
 *
 * 2. **THE PARSE CONTEXT HAS NO PROTOTYPE.** The library's own context object is
 *    an ordinary `{ async: false }`, and the library reads OPTIONAL switches off
 *    it — `ctx.skipChecks`, `ctx.direction`, `ctx.jitless`. Those reads walk the
 *    prototype chain, and round 8 measured the consequence at the reviewed tip:
 *
 *    ```text
 *    Object.prototype.skipChecks = true   (one non-enumerable data property)
 *      validateEvaluationInput({ …, evaluatedAt: "definitely-not-a-timestamp" })
 *        clean → ok:false      polluted → ok:TRUE      ← every format check SKIPPED
 *      validateEvaluationInput({ …, intent.marketId: "not-a-uuid" })
 *        clean → ok:false      polluted → ok:TRUE
 *    ```
 *
 *    That is a live FAIL-OPEN, found by this round and closed by it: the arena
 *    hands the library a null-prototype context copy, so an unset switch reads
 *    `undefined` whatever the caller put on `Object.prototype`.
 *
 * The copy also forces `jitless` on that context. The library has two object
 * parsers: a compiled one that assembles into a LOCAL `{}` no caller can reach,
 * and an interpreted one that assembles into `payload.value` — the arena's
 * accessor. Only the second can be protected, so the arena selects it. This is
 * a documented per-parse option (`ctx.jitless`), not a monkey-patch.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT IS NOT
 * ---------------------------------------------------------------------------
 *
 * - **It is not a validator.** Not one validation rule is reimplemented here:
 *   every node of the copy is constructed by the library itself, from the
 *   library's own definition, so the copy's VERDICT is the library's verdict.
 *   `test/unit/risk/schema-arena.test.ts` asserts that equivalence
 *   differentially — same `success`, same issue paths and codes — over every
 *   door schema and a corpus of valid and invalid values.
 * - **It never mutates a shared schema.** The frozen domain contracts
 *   (`IntentSchema` and everything under it) are CLONED, never touched: a
 *   process-wide monkey-patch of a shared contract object would be a far worse
 *   defect than the one this fixes. The originals keep the library's behaviour,
 *   and a test asserts they still do.
 * - **It is not open-ended.** The walk FAILS CLOSED: a node whose `type` is not
 *   in {@link ARENA_NODE_TYPES} throws at build time, which is module load.
 *   Adding a `.transform()`, a `.pipe()`, a `.catch()` or a `z.lazy()` to a door
 *   schema is therefore a loud failure rather than a silently unprotected node.
 *   (`z.lazy` is also the only way a schema graph could be cyclic; excluding it
 *   is what makes the recursion below total.)
 *
 * The one module it imports is `plain-data.ts`, for the two PROTOTYPE-FREE
 * DESCRIPTOR builders: a descriptor written as an object literal is itself read
 * through the prototype chain, and round 8 measured an inherited `get` turning
 * every `Object.defineProperty` in this repository into a `TypeError`.
 *
 * ---------------------------------------------------------------------------
 * REVIEW ROUND 9 — the library's own STATE CONTAINERS are ordinary objects too
 * ---------------------------------------------------------------------------
 *
 * Round 9 found the surviving members of the same class INSIDE the instances
 * this module builds. The library keeps per-node state in `inst._zod` — an
 * ordinary object literal (`core.cjs`, `$constructor.init`) — and its parse
 * path READS OPTIONAL FIELDS off that container: `el._zod.optin` and
 * `el._zod.optout` decide whether a MISSING REQUIRED KEY is an error
 * (`schemas.cjs`, `handlePropertyResult`), `def.keyType._zod.values` decides
 * whether a record takes the enum-keyed path, and a check's `_zod.def.when`
 * decides whether the check RUNS AT ALL. On a copy those reads walked the chain
 * to `Object.prototype`, and two were measured as LIVE FAIL-OPENS at the
 * round-8 tip:
 *
 * ```text
 * Object.prototype.optin = "optional", Object.prototype.optout = "optional"
 *   validateEvaluationInput(entry minus evaluatedAt)
 *     clean → ok:false      polluted → ok:TRUE     ← required key waived
 *   (either name alone does NOT flip: handlePropertyResult needs the pair)
 * Object.prototype.when = () => false
 *   validateEvaluationInput(strategyInstanceId: "has whitespace")
 *     clean → ok:false      polluted → ok:TRUE     ← the custom check skipped
 * ```
 *
 * THE FIX IS THE CLASS, NOT THE TWO NAMES. Every `_zod` container the arena
 * builds — schema nodes AND check instances — has its prototype SEVERED after
 * construction ({@link severOrdinaryChain}), so an absent instance slot answers
 * `undefined` exactly as it does on a clean process, whatever a caller has put
 * on `Object.prototype`. Check instances, which round 8 carried over SHARED,
 * are now COPIED with prototype-free definitions for the same reason: the
 * `when` read is `ch._zod.def.when`, and a shared check's def is an ordinary
 * library literal this module must not mutate.
 *
 * Round 9's second finding is the LAZY parse structures. On the FIRST parse of
 * a copy the library rebuilds an object schema's `shape` as an ordinary spread
 * literal and walks it with `for…in` to compute `propValues` and the
 * discriminated-union `disc` map — so ONE ENUMERABLE inherited data property
 * (`Object.prototype.zzUnrelated = 1`) made a COLD first parse throw
 * (`TypeError … reading 'values'`), the containment guard turned that into an
 * input refusal, and a VALID CANCEL was trapped (§6 invariant 13). Measured
 * worse: the aborted lazy is POISONED — every LATER parse of that copy then
 * fails too, clean or not. {@link warmNode} therefore forces every lazy
 * structure at BUILD TIME — module load, which is clean by definition — and
 * then severs the chains of the rebuilt ordinary containers, so a cold-process
 * first parse under enumerable pollution answers byte-identically to a clean
 * one.
 *
 * THE COUPLING, STATED. This module reads three `zod@4.4.3` internals —
 * `_zod.def`, `_zod.constr` and `_zod.run` — and one documented parse option,
 * `ctx.jitless`; since round 9 it also RELIES on `_zod` being an ordinary
 * own-data container (guarded LOUDLY: {@link severOrdinaryChain} throws at
 * build if the library ever ships `_zod` inheriting from anything but
 * `Object.prototype`). That is a version-pinned coupling and it is deliberate:
 * the alternative is to reimplement object, array, record and union semantics
 * in this package, which is the larger risk by far. A version bump that changes
 * those internals fails the arena's own non-vacuity tests first, loudly, before
 * anything else runs — and the slot-name audit in
 * `test/unit/risk/inherited-state.test.ts` re-derives the consulted `_zod`
 * field set from the library's SHIPPED SOURCE, so a new consulted field arrives
 * as a failing test rather than as a silent hole.
 *
 * THE RESIDUAL, STATED PLAINLY. What a silent degradation would look like if a
 * member of the class remains: the library builds a fresh ORDINARY container
 * during a parse (not at build time, so warming cannot reach it), reads an
 * optional switch off it, and the copy's verdict quietly follows the polluted
 * chain. Every such container shipped in `zod@4.4.3` is built ONCE, lazily,
 * and memoized — which is why warming closes them — but a future version that
 * builds one PER PARSE would reopen the class until the slot-name audit or the
 * differential tests catch the change. Under the frozen pin, no such container
 * remains: the payloads are the arena's, the context is the arena's, the defs,
 * `_zod` containers, rebuilt shapes, `propValues` tables and bags are severed,
 * and the sweep measures the doors under pollution of every consulted name.
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
