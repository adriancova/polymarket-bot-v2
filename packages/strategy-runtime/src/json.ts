/**
 * Checkpointable JSON: the value grammar strategy state (and every
 * `statePatch`) must satisfy, plus the canonical serialization that makes
 * state byte-comparable (§12.4) and checkpoint hashes well-defined (§10.3
 * `state_checkpoints.state_hash` is computed by the store over these exact
 * bytes).
 *
 * The grammar below is the CURRENT, verified behavior. It is stated as three
 * separate axes because a JavaScript value can be un-checkpointable because of
 * what it IS, because of how its properties are DEFINED, or because reading it
 * at all RUNS CODE that the runtime does not control.
 *
 * Accepted values: `null`, booleans, finite numbers (excluding `-0`), strings,
 * arrays, and plain objects (prototype `Object.prototype` or `null`), acyclic,
 * nested at most `MAX_MATERIALIZED_DEPTH` containers deep.
 *
 * Rejected values, with a stated path: `undefined`, functions, symbol VALUES,
 * bigints, `NaN`/`Infinity`, negative zero (it silently becomes `0` through a
 * JSON round trip — a value that changes identity when persisted is refused,
 * not tolerated), class instances / `Date` / `Map` / `Set` (their JSON forms
 * lose information silently), circular structures, and structures nested deeper
 * than the stated bound.
 *
 * Rejected own-property FORMS, with a stated path — every one of these is a
 * property that canonical serialization would drop or transform silently:
 * - **symbol KEYS** (`{ [Symbol("k")]: 1 }`): invisible to `Object.keys`, so
 *   they never reach the output bytes;
 * - **non-enumerable properties** (`Object.defineProperty(o, "k", { value })`):
 *   likewise invisible to `Object.keys` and to `JSON.stringify`;
 * - **accessor (getter/setter) properties**: `JSON.stringify` calls the
 *   getter, so the bytes record a COMPUTED value that returns as a plain data
 *   property — and a getter reading mutable state can serialize differently on
 *   two passes over the same object, which is exactly the §12.4 divergence
 *   these functions exist to prevent;
 * - **non-index own properties on an array** (`Object.assign([1], { x: 2 })`,
 *   or a symbol key on an array): JSON serializes arrays positionally, so such
 *   properties are dropped.
 * An array HOLE is rejected too, by the value axis: reading the missing index
 * yields `undefined`, which is already refused (and it must be — the canonical
 * serializer would emit the invalid text `[1,,3]` for `[1, , 3]`).
 *
 * The third axis — how the value is OBTAINED. A Proxy (or any other exotic
 * object) can satisfy every check on the two axes above and still run arbitrary
 * strategy code on each property access, returning different answers to the
 * validator and to the serializer. No inspection can decide that: whatever a
 * trap answered, it may answer differently next time. So the boundary does not
 * try to DETECT an exotic value — it MATERIALIZES. `materializeCheckpointableJson`
 * reads every own property exactly ONCE and builds a fresh, plain, inert copy
 * as it validates; the copy is what the runtime keeps, freezes, serializes,
 * checkpoints and persists, and the caller's original is never read again. A
 * trap that throws during that read is not a crash but a stated refusal, and a
 * trap that lies can only lie into a copy that has already been validated as
 * data.
 *
 * DATED CORRECTION — 2026-09-02, remediation round 1 (review finding M1). The
 * previous version of this header said "Rejected … symbols", which was true
 * only of symbol *values*. Symbol *keys* were NOT rejected: both the validator
 * and the serializer enumerated with `Object.keys`, which cannot see them, so
 * `{ visible: 1, [Symbol("lost")]: 2 }` validated as `problem: null` and
 * serialized to `{"visible":1}` — silent state loss for any direct caller of
 * the exported utility, and (reproduced end to end) a nested symbol key rode
 * an accepted `statePatch` into live in-memory instance state while the
 * checkpoint bytes dropped it, so the restored instance and the live one
 * disagreed. Non-enumerable and accessor properties had the same hole. All of
 * these forms are refused as of this correction, and the grammar above now
 * describes the behavior the tests pin
 * (`test/unit/strategy-runtime/json-own-properties.test.ts`).
 *
 * DATED CORRECTION — 2026-09-02, remediation round 2 (review round 2's HIGH
 * finding). The round-1 correction above is left exactly as it was written, but
 * its framing — "the grammar below is the CURRENT, verified behavior", stated
 * over two axes — was INCOMPLETE, and the gap was not a missing property form
 * but a missing question. Round 1 inspected own-property DESCRIPTORS, which is
 * the right check for an ordinary object and no check at all for an exotic one:
 * a `Proxy` presenting `Object.prototype` and plain enumerable data descriptors
 * passed the whole grammar. Reproduced verbatim before the fix, with a proxy
 * whose `get` trap throws once something has frozen it:
 *
 *     validator=null
 *     first=Error:POST_FREEZE_PROXY_GET
 *     second=DECIDED
 *     sequences=[0,0]
 *     checkpoints=[0]
 *     status=ACTIVE
 *
 * `checkpointableJsonProblem({ nested: proxy })` returned `null`; the runtime
 * accepted the patch, persisted the decision, and only then threw out of
 * `evaluate()` while freezing the state — leaving a durable decision with no
 * checkpoint and an evaluation sequence that the next callback re-used. Two
 * neighbouring routes were swept in the same probe and were equally live: a
 * proxy whose trap throws EAGERLY made this very function throw instead of
 * returning a problem (`validator/eager=Error:EAGER_PROXY_GET`), and a hostile
 * returned decision made `DecisionResultSchema.safeParse` throw. As of this
 * correction the walk materializes (third axis above), every caller-supplied
 * property access is wrapped, and these functions are TOTAL: they return a
 * problem string, never a throw. Pinned by
 * `test/unit/strategy-runtime/json-exotic-values.test.ts` and the runtime-side
 * ordering tests in `test/unit/strategy-runtime/decision-commit-ordering.test.ts`.
 *
 * DATED CORRECTION — 2026-09-03, remediation round 3 (review round 3's MEDIUM
 * 1 and LOW). Round 2's claim that these functions "are TOTAL: they return a
 * problem string, never a throw" was FALSE in three independent ways, all
 * reproduced verbatim against the round-2 code:
 *
 *     materializer=THREW:TypeError:Cannot perform 'IsArray' on a proxy that has been revoked
 *     validator=THREW:TypeError:Cannot perform 'IsArray' on a proxy that has been revoked
 *     throwingCause=THREW:TypeError:Cannot perform 'getPrototypeOf' on a proxy that has been revoked
 *     depth=3500 materializer=THREW:RangeError: Maximum call stack size exceeded validator=THREW:RangeError: Maximum call stack size exceeded
 *
 * 1. `Array.isArray` was called OUTSIDE the `attempt()` guard on the reasoning
 *    that it "pierces a Proxy to its target and cannot be trapped". True of
 *    traps; false of a REVOKED proxy, on which every internal method throws.
 * 2. The refusal path itself was partial: `describeCause` evaluated
 *    `cause instanceof Error`, which walks the thrown value's prototype chain —
 *    so a trap that threw a revoked proxy made the error FORMATTER throw. That
 *    function now lives in `describe.ts` and is total.
 * 3. The walk was recursive, so ORDINARY plain data nested ~3,500 deep
 *    exhausted the stack in both functions and in `restoreCheckpoint`, which
 *    parses caller-supplied bytes and walks the result.
 *
 * Two changes answer 3, deliberately, because they answer different questions.
 * The walk (and `canonicalJsonStringify`, and `deepFreeze`) is now ITERATIVE
 * over an explicit heap stack, so no legal input can exhaust the call stack;
 * and the walk ALSO refuses at `MAX_MATERIALIZED_DEPTH` containers, because the
 * bound is a CONTRACT this boundary owes the consumers it does not control —
 * `JSON.parse`/`JSON.stringify` in the composition root, the store's `jsonb`
 * column, any future recursive reader of state — while the iterative walk is
 * merely how the bound is enforced by a stated refusal instead of by whichever
 * stack frame happens to blow first.
 *
 * Also in that round, `checkpointableJsonProblem` was REMOVED from this module
 * and from the package's public API. It was the validate-then-retain shape
 * whose last internal caller (`restoreCheckpoint`) now keeps the materialized
 * copy instead; keeping an exported predicate that invites the exact workflow
 * round 2's HIGH came from would have preserved the footgun for the sake of an
 * API no accepted work package depends on. Callers validate by materializing
 * and keeping the copy.
 *
 * DATED CORRECTION — 2026-09-03, remediation round 4 (review round 4's MEDIUM
 * 1). Round 3's claim that these functions are total was still not true of one
 * argument it never considered: the exported `materializeCheckpointableJson`
 * took a caller-supplied DIAGNOSTIC `path`, and building a refusal interpolated
 * it. Reproduced verbatim against the round-3 code:
 *
 *     materializeCheckpointableJson(1n, Symbol(...))  → threw TypeError:
 *       Cannot convert a Symbol value to a string
 *     path.toString() throws                          → escaped Error:
 *       PATH_TOSTRING
 *
 * That argument was missing from round 3's 25-row entry-point sweep because the
 * sweep enumerated ENTRY POINTS and their VALUES, not signatures. The `path`
 * argument is now INTERNAL — the exported wrappers take the value alone, and
 * the pathed forms (`materializeCheckpointableJsonAt`,
 * `materializeEvaluationViewAt`, `materializeImmutableParamsAt`) are not
 * re-exported from `index.ts` — and every diagnostic label is normalized
 * through the total `describeLabel` before it is used. The boundary list is now
 * DERIVED from the sources by
 * `test/unit/strategy-runtime/boundary-surface.test.ts`, which reads every
 * exported function's every parameter out of the TypeScript AST (a defaulted
 * parameter like this one is invisible to `Function.length`, which is why a
 * runtime enumeration would have missed it again) and fails when a new one
 * appears unclassified.
 *
 * A THIRD grammar was added in the same round: `IMMUTABLE_PARAMS`, for the
 * instance params (`runtime.ts`). See review round 4's HIGH 2 and the grammar
 * table below.
 *
 * Note on numbers: a checkpoint value may be a non-economic number (a counter,
 * a flag). ECONOMIC values inside strategy state must be canonical decimal
 * strings by §6 invariant 1 — that is a strategy-discipline rule reviewed with
 * the strategy (the domain deliberately types `statePatch` as opaque).
 *
 * ---------------------------------------------------------------------------
 * WP-170-FU1 (2026-09-05) — D1 IS NOW A PROTOTYPE-FREE MATERIALIZATION (D4)
 * ---------------------------------------------------------------------------
 *
 * `docs/contracts/schema-boundary.md` §1 D1/D4. This walk always COPIED, which
 * defeated adoption and loss on the value it read. What it did not do was build
 * the copy safely or emit it safely, and three defeats were reproduced at base
 * `53e9f62` against exactly this module:
 *
 * ```text
 * C1  Object.prototype.marketId = { get(){…} }        (NE, get-only)
 *       validateEvaluationInput(valid input)
 *       clean → ok:true    polluted → THREW TypeError:
 *         "Cannot set property marketId of #<Object> which has only a getter"
 *       — an ESCAPED throw out of a function whose contract is "Never throws".
 * C2  Object.prototype.marketId = { get(){…}, set(){…} }  (NE, accepting)
 *       materializeEvaluationViewAt({ marketId:"x", other:1 })
 *       clean → {"marketId":"x","other":1}
 *       polluted → {"other":1}   setterCalls=1
 *       — the copy LOST a property the input carried, and caller code ran
 *         inside the door.
 * C3  Object.prototype.get = 1                         (NE data)
 *       materializeEvaluationViewAt(JSON.parse('{"__proto__":{"a":1}}'))
 *       clean → ok:true    polluted → THREW TypeError: "Getter must be a
 *         function: 1"  — the object-literal DESCRIPTOR is read with
 *         HasProperty, so it walks the chain (`plain-data.ts`, round 8).
 * D1  Object.prototype.sourceEvent = {…}               (NE data)
 *       runtime.evaluate(valid input with NO sourceEvent)
 *       clean → record.sourceEvent = undefined
 *       polluted → the persisted record names an event that never existed
 *       — the OUTPUT side: `buildRecord` reads `input.sourceEvent` off the
 *         emitted snapshot, and an ordinary snapshot answers from the chain.
 *         §6 invariant 4's traceability chain, fabricated.
 * ```
 *
 * All four are one cause: the copy was an ORDINARY container, appended to by
 * ASSIGNMENT, with descriptors written as object literals. Since this round
 * every object copy is `Object.create(null)`, every append is
 * `Object.defineProperty` with the prototype-free descriptor from
 * `@polymarket-bot/risk/plain-data` (the §2.1 **S7** edge), and the emitted
 * tree therefore answers an absent key `undefined` whatever a caller has put on
 * `Object.prototype`.
 *
 * ARRAYS KEEP `Array.prototype`, deliberately and with the residual stated. A
 * severed array is still an array exotic object, but it has no `map`, `filter`
 * or `forEach` — and these copies are handed to STRATEGY code, which iterates
 * them. So an array copy keeps its prototype and only its APPEND is changed
 * from `push` (which is `Set`, and `Set` consults the chain for the INDEX name
 * — the `WP-020-FU1`/`WP-200-FU1` index-`"0"` family) to `defineProperty` on
 * the index name. What remains open, and is not this package's to close, is an
 * inherited property at an index name being visible through an EMPTY array copy
 * (`copy[0]`): that is the same index-name family the queued `packages/risk`
 * grant-and-widen round owns.
 *
 * ---------------------------------------------------------------------------
 * WP-170-FU1 REMEDIATION ROUND 1 (2026-09-06) — THE DECISION GRAMMAR DROPS AN
 * OWN `__proto__` KEY, BECAUSE THE LIBRARY NEVER VALIDATED ONE
 * ---------------------------------------------------------------------------
 *
 * Review round 1, MEDIUM 1. `WP-170-FU1`'s D3 rebuild takes the decision the
 * record carries from the MATERIALIZED TREE instead of from `parsed.data`. That
 * is the §1 D3 rule and it is right — but it silently changed what happens to a
 * key the LIBRARY skips rather than validates.
 *
 * MECHANISM, read out of the pinned `zod@4.4.3` rather than inferred:
 * `v4/core/schemas.cjs:798-801` (the strict object's unknown-key walk) and
 * `:1527` (the record walk) each begin with `if (key === "__proto__") continue;`
 * — the library SKIPS that name at EVERY level, in objects and records alike.
 * It is neither refused as an unrecognized key nor validated against a value
 * schema, and `parsed.data` therefore never carried it. Base `53e9f62` emitted
 * `parsed.data`, so the key vanished; the tip emitted the materialized tree, so
 * it landed in the persisted `record.decision`.
 *
 * Reproduced at tip `4c1bcde`, no pollution needed — a strategy return with an
 * own enumerable `__proto__` data property, which is exactly what `JSON.parse`
 * of a model's output produces:
 *
 * ```text
 *                                 base 53e9f62        tip 4c1bcde
 *   modelOutputs.__proto__ = {…}   DROPPED             EMITTED into the record
 *   modelOutputs.__proto__ = 1.5   DROPPED             EMITTED — a NUMBER, in a
 *                                                      field whose value schema
 *                                                      is string|boolean|null
 *   intents[0].__proto__   = {…}   DROPPED             EMITTED, and forwarded
 *   decision.__proto__     = {…}   DROPPED             DROPPED (DECISION_FIELD_NAMES)
 *   statePatch.__proto__   = {…}   KEPT                KEPT   (base == tip)
 * ```
 *
 * The fix is the reviewer's recommended option (a) — drop the own key in the
 * materializer's object frames — SCOPED BY THAT LAST ROW. Base parity is what
 * option (a) is for, and base did NOT drop the key from `statePatch` (it never
 * travelled through `parsed.data`; the checkpointable walk emitted it as data,
 * which `test/unit/strategy-runtime/state-patch-attribution.test.ts` and
 * `json-exotic-values.test.ts` both pin). Dropping it in every grammar would
 * therefore have RE-BROKEN parity in the other direction and required weakening
 * two existing pins. So the drop is one GRAMMAR AXIS (`dropOwnProtoKey`), true
 * on the new {@link DECISION_VIEW} grammar alone — the grammar the decision and
 * its `modelOutputs` are materialized under — and false everywhere else.
 *
 * A NON-ENUMERABLE own `__proto__` is still REFUSED rather than dropped: the
 * drop is applied to the walked (enumerable) key list only, after the
 * hidden-own-property check, so the loss rule that refuses every invisible own
 * property is untouched. Base refused it there too, one step earlier.
 */

import { ownDataDescriptor } from "@polymarket-bot/risk/plain-data";

import { describeCause, describeLabel } from "./describe.js";

/**
 * The maximum nesting the materializing boundary accepts, in containers
 * (objects/arrays), counted from the value handed in.
 *
 * Chosen 2026-09-03 (remediation round 3). 64 is far beyond any legitimate
 * strategy state — a `statePatch` is a shallow record of scalars, and the
 * deepest structure any view in this package's contracts describes is four
 * containers (input → books → yes → bids → level) — and far below the depth at
 * which the consumers of these bytes get into trouble: V8's `JSON.stringify`
 * and `JSON.parse` are recursive in places, PostgreSQL parses `jsonb` under
 * `max_stack_depth`, and the composition root may hand state to any of them.
 * A structure deeper than this is refused with a stated path, which is a bug
 * report; the alternative is a `RangeError` at whatever depth the machine
 * happens to fail, which is not.
 */
export const MAX_MATERIALIZED_DEPTH = 64;

const PLAIN_OBJECT_PROTOTYPES = new Set<object | null>([Object.prototype, null]);

/** The inert data a materialized value is made of. */
export type CheckpointableJson =
  | null
  | boolean
  | number
  | string
  | readonly CheckpointableJson[]
  | { readonly [key: string]: CheckpointableJson };

export type MaterializeCheckpointableJsonResult =
  | { readonly ok: true; readonly value: CheckpointableJson }
  | { readonly ok: false; readonly problem: string };

/** A materialization that may carry values only an evaluation view may hold. */
export type MaterializeResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly problem: string };

/**
 * The axes on which the two grammars this module implements differ. Both walk
 * the same way, read every caller-supplied property exactly once, and copy;
 * they disagree only about which values a copy may hold.
 */
interface Grammar {
  /** Views use `undefined` for an absent optional; checkpoint bytes cannot. */
  readonly acceptUndefined: boolean;
  /** A view may carry a non-economic `NaN`; checkpoint bytes may not. */
  readonly acceptNonFiniteNumbers: boolean;
  /**
   * Accessor properties. Refused for checkpointable state (the bytes would
   * record a computed value that returns as data). ACCEPTED for evaluation
   * views, where the getter is invoked exactly once inside a guard and the
   * result is copied — the divergence hazard is closed by reading once, not by
   * refusing a producer that exposes a computed view.
   */
  readonly acceptAccessors: boolean;
  /**
   * Read one own-property DESCRIPTOR per key (the checkpointable grammar needs
   * it: an accessor must be refused WITHOUT invoking its getter, which is a
   * round-1 property with its own test). The view grammar accepts accessors, so
   * the only thing a descriptor would tell it is enumerability — which
   * `Object.keys` versus `Reflect.ownKeys` answers in two calls per object
   * instead of one per key. Same refusals, measurably cheaper on the per-tick
   * path; see the round-3 benchmark in `docs/handoffs/WP-170.md`.
   */
  readonly perKeyDescriptor: boolean;
  readonly maxDepth: number;
  /**
   * Drop an own ENUMERABLE `__proto__` data property instead of copying it.
   *
   * True for {@link DECISION_VIEW} only, and for one measured reason (module
   * header, remediation round 1): `zod@4.4.3` SKIPS that key at every level
   * (`v4/core/schemas.cjs:798-801` and `:1527`), so a decision's `__proto__` was
   * never validated by anything and never reached base `53e9f62`'s
   * `parsed.data`. A D3 rebuild that emits the materialized tree would emit it,
   * which is an unvalidated, contract-forbidden value in the persisted record.
   * Dropping it here restores exact base byte-parity for the decision subtree.
   *
   * FALSE for the other three grammars, also by measurement: base KEPT the key
   * in `statePatch` (it never travelled through a parse output), and both the
   * checkpoint bytes and the direct materializer contract pin that.
   */
  readonly dropOwnProtoKey: boolean;
  /** Tail of the refusal a throwing caller-supplied operation produces. */
  readonly exoticTail: string;
  /** The "this is not a plain object" refusal, in this grammar's words. */
  readonly plainObjectRule: string;
}

/**
 * The one own key name {@link Grammar.dropOwnProtoKey} is about. Named once so
 * the drop and the tests that pin it cannot drift apart.
 */
const PROTO_KEY = "__proto__";

const CHECKPOINTABLE_JSON: Grammar = {
  acceptUndefined: false,
  acceptNonFiniteNumbers: false,
  acceptAccessors: false,
  perKeyDescriptor: true,
  maxDepth: MAX_MATERIALIZED_DEPTH,
  dropOwnProtoKey: false,
  exoticTail:
    "a value whose property access executes code (a Proxy or other exotic object) is not checkpointable",
  plainObjectRule: "only plain objects are checkpointable",
};

const EVALUATION_VIEW: Grammar = {
  acceptUndefined: true,
  acceptNonFiniteNumbers: true,
  acceptAccessors: true,
  perKeyDescriptor: false,
  maxDepth: MAX_MATERIALIZED_DEPTH,
  dropOwnProtoKey: false,
  exoticTail:
    "a view whose property access executes code that throws cannot be read into the inert " +
    "snapshot the runtime evaluates against",
  plainObjectRule:
    "only plain objects and arrays can be read into an evaluation-input snapshot",
};

/**
 * The evaluation-view grammar as the RETURNED DECISION is read under: identical
 * on every value axis, and different on exactly one property axis — an own
 * enumerable `__proto__` is DROPPED rather than copied.
 *
 * Why a separate grammar rather than a flag on the view one: the input snapshot
 * and the decision are read by the same walk but land in different places. The
 * decision is what §6 invariant 3 persists, and the library that validates it
 * skips `__proto__` at every level, so copying the key emits a value nothing
 * checked. The INPUT snapshot's handling of the same key is base behaviour this
 * round did not measure a defect in, and changing it would be an unmeasured
 * permission change on the producer side. One axis, two grammars, both stated.
 */
const DECISION_VIEW: Grammar = {
  ...EVALUATION_VIEW,
  dropOwnProtoKey: true,
};

/**
 * The instance params (§9.6 "IMMUTABLE configuration"), added 2026-09-03 in
 * remediation round 4 (review round 4's HIGH 2).
 *
 * Why params need a grammar of their own, and why they differ from the other
 * two on exactly one axis:
 *
 * - like checkpointable state, ACCESSORS are refused. A getter on params is a
 *   value that is recomputed on every read, and `ctx.params()` is read inside
 *   callbacks: the reviewer's probe read one five times across two evaluations
 *   and got five different answers through a `Object.isFrozen === true` object.
 *   Refusing the accessor is what makes "the config id determines the params"
 *   true rather than aspirational;
 * - like evaluation views, `undefined` and non-finite numbers are ACCEPTED. A
 *   params value never enters checkpoint bytes, a record, or a replay
 *   comparison, so the two rules that exist to protect those bytes (`undefined`
 *   has no JSON form; `NaN` in state is a replay divergence) buy nothing here
 *   and would refuse a schema that legitimately leaves an optional field
 *   `undefined`.
 *
 * Everything else follows from materializing: a `Map`, a `Set`, a `Date`, a
 * class instance, a function, a `Proxy` with a non-plain prototype and a
 * symbol-keyed or non-enumerable property are all refused by a rule that
 * already existed, and a `Proxy` over a plain object is COPIED rather than
 * refused — the copy is inert, so its traps can never run again.
 */
const IMMUTABLE_PARAMS: Grammar = {
  acceptUndefined: true,
  acceptNonFiniteNumbers: true,
  acceptAccessors: false,
  perKeyDescriptor: true,
  maxDepth: MAX_MATERIALIZED_DEPTH,
  dropOwnProtoKey: false,
  exoticTail:
    "params whose property access executes code cannot be taken into runtime ownership as " +
    "the run's immutable configuration (§9.6)",
  plainObjectRule:
    "only plain objects and arrays can be taken into runtime ownership as params — a Map, a " +
    "Set, a Date or a class instance is internally mutable or accessor-bearing, so it would " +
    "let the caller change what ctx.params() answers after the run started",
};

/**
 * Validates a caller-supplied value against the grammar above AND returns a
 * fresh, plain, inert copy of it — one single walk, so the thing validated and
 * the thing kept are the same thing.
 *
 * This is the checkpointable-state BOUNDARY. A caller that keeps the original
 * instead of the returned copy has not crossed it: the original may be a Proxy
 * whose traps answer one way during validation and another way afterwards, and
 * no amount of inspection can rule that out. Every own key, descriptor and
 * value here is read exactly ONCE and inside a guard, so a hostile or merely
 * broken value yields a stated problem rather than a throw. **Never throws** —
 * and since remediation round 3 that claim covers a revoked `Proxy`, a thrown
 * value that cannot be formatted, and arbitrarily deep ordinary data, and since
 * round 4 it is not qualified by a second argument either: the diagnostic path
 * this walk reports is the runtime's own (see `ROOT_PATH` below).
 */
export function materializeCheckpointableJson(
  value: unknown,
): MaterializeCheckpointableJsonResult {
  return materializeCheckpointableJsonAt(value, ROOT_PATH);
}

/**
 * The diagnostic path a PUBLIC materialization reports. The public functions
 * take no path argument (round 4, MEDIUM 1): a caller-supplied path is not part
 * of the value contract, and interpolating one is an operation on caller data
 * inside a function that promises never to throw.
 */
const ROOT_PATH = "$";

/**
 * The pathed form, for the runtime's own call sites, which name the field they
 * are materializing (`statePatch`, `rngState`, `state`, `patches[3]`). NOT
 * re-exported from `index.ts`; the path is normalized through the total
 * `describeLabel` regardless, so no internal caller can reopen MEDIUM 1 either.
 * **Never throws.**
 */
export function materializeCheckpointableJsonAt(
  value: unknown,
  path: string,
): MaterializeCheckpointableJsonResult {
  const result = materializeWith(value, describeLabel(path), CHECKPOINTABLE_JSON);
  return result.ok ? { ok: true, value: result.value as CheckpointableJson } : result;
}

/**
 * The same walk under the evaluation-view grammar: the inert snapshot the
 * runtime takes of ONE evaluation's input before it invokes anything.
 *
 * Internal to the package (it is not re-exported from `index.ts`): the public
 * way to hand the runtime an input is `evaluate()`, which acquires this
 * snapshot itself. **Never throws.**
 */
export function materializeEvaluationViewAt(value: unknown, path: string): MaterializeResult {
  return materializeWith(value, describeLabel(path), EVALUATION_VIEW);
}

/**
 * `THROUGHPUT-1a` — PREPARED evaluation views. PERFORMANCE ONLY: an
 * evaluation whose input carries a prepared view is the evaluation the raw
 * view produces.
 *
 * A trader hands the runtime both outcomes' order-book views on every
 * evaluation, and a book changes only when an event for its token arrives, so
 * the unchanged side was re-materialized and re-frozen (hundreds of levels)
 * on every call. {@link prepareEvaluationView} reads a view ONCE, under the
 * very grammar `acquireEvaluationInput` reads the input with, and answers that
 * inert copy deep-frozen and registered in a `WeakMap` this module owns. Met
 * again inside an input — at a depth where its containers stay within the
 * grammar's bound — the walk answers the registered copy itself instead of
 * copying it once more (the copy it would make is equal to it: plain data the
 * runtime built, no accessor, nothing a read could change), and
 * {@link deepFreeze} skips it (it is frozen all the way down already).
 *
 * A value the grammar would REFUSE is returned unchanged (unprepared), so the
 * evaluation refuses it exactly as before. Registration is by identity in a
 * module-owned map: nothing a caller builds, and no Proxy, can pass for a
 * prepared view, and the check runs no caller code.
 */
const PREPARED_VIEWS = new WeakMap<object, { readonly height: number }>();

/** Prepares one evaluation-input view (see {@link PREPARED_VIEWS}). **Never throws.** */
export function prepareEvaluationView(view: unknown): unknown {
  const materialized = materializeWith(view, "view", EVALUATION_VIEW);
  if (!materialized.ok || materialized.value === null || typeof materialized.value !== "object") {
    return view;
  }
  const tree = deepFreeze(materialized.value);
  PREPARED_VIEWS.set(tree, { height: containerHeight(tree) });
  return tree;
}

/** Containers on the longest root-to-leaf path of a tree the runtime built (1 for a flat one). */
function containerHeight(root: object): number {
  let deepest = 0;
  const stack: { readonly container: object; readonly depth: number }[] = [{ container: root, depth: 1 }];
  while (stack.length > 0) {
    const top = stack.pop();
    if (top === undefined) break;
    if (top.depth > deepest) deepest = top.depth;
    for (const member of Object.values(top.container)) {
      if (member !== null && typeof member === "object") {
        appendOwn(stack, { container: member as object, depth: top.depth + 1 });
      }
    }
  }
  return deepest;
}

/**
 * The same walk under the DECISION grammar: the inert copy the runtime takes of
 * the value a strategy callback returned, before the door parses it and before
 * D3 reads the persisted decision back off it.
 *
 * Identical to {@link materializeEvaluationViewAt} except that an own
 * enumerable `__proto__` is dropped rather than copied — the key the pinned
 * `zod@4.4.3` skips at every level, so nothing ever validated it and base
 * `53e9f62` never emitted it (module header, remediation round 1).
 *
 * Internal to the package (not re-exported from `index.ts`). **Never throws.**
 */
export function materializeDecisionViewAt(value: unknown, path: string): MaterializeResult {
  return materializeWith(value, describeLabel(path), DECISION_VIEW);
}

/**
 * The same walk under the immutable-params grammar: the inert copy the runtime
 * takes of the parsed params ONCE at creation, which is what `ctx.params()`
 * answers with for the whole life of the run.
 *
 * Internal to the package. **Never throws.**
 */
export function materializeImmutableParamsAt(value: unknown, path: string): MaterializeResult {
  return materializeWith(value, describeLabel(path), IMMUTABLE_PARAMS);
}

function fail(problem: string): { readonly ok: false; readonly problem: string } {
  return { ok: false, problem };
}

/**
 * Performs ONE property-access operation on a caller-supplied object. Every
 * such operation can run code the runtime does not control (a Proxy trap, an
 * exotic host object) — including `Array.isArray`, which cannot be trapped but
 * DOES throw on a revoked proxy (round 3, MEDIUM 1) — so every one of them is
 * wrapped: the boundary refuses, it does not propagate.
 */
function attempt<T>(
  path: string,
  operation: string,
  grammar: Grammar,
  read: () => T,
): { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problem: string } {
  try {
    return { ok: true, value: read() };
  } catch (cause) {
    return fail(`${path}: ${operation} threw (${describeCause(cause)}) — ${grammar.exoticTail}`);
  }
}

/**
 * Appends `value` to `target` as an OWN DATA property at the index name.
 *
 * `Object.defineProperty`, never `target.push(value)` — WP-170-FU1, and it is
 * the walks' OWN bookkeeping arrays this is about, not only the copies they
 * build. `push` is `Set`, and `Set` consults the prototype chain for the INDEX
 * NAME. Measured at base `53e9f62` with ONE non-enumerable accessor at `"0"` on
 * `Object.prototype`:
 *
 * ```text
 * Object.prototype["0"] = { get: () => "X", set() {} }
 *   materializeEvaluationViewAt({})              → THREW TypeError:
 *     "Cannot read properties of undefined (reading 'length')"
 *   materializeEvaluationViewAt({ a: 1 })        → the same
 *   materializeEvaluationViewAt([])              → the same
 *   materializeEvaluationViewAt({ list:["a"] })  → the same
 * ```
 *
 * The mechanism, because "an index name" sounds harmless: `stack.push(frame)`
 * found the inherited SETTER, so no own `"0"` was created — while `length`
 * still became 1 — and the very next `stack[stack.length - 1]` was answered by
 * the inherited GETTER with the string `"X"`. The walk then read `frame.keys`
 * off a string and threw out of a boundary whose whole contract is that it does
 * not throw. Every container shape was affected, `{}` included.
 *
 * `defineProperty` has `CreateDataProperty` semantics: it defines on the object
 * itself and consults no setter, inherited or otherwise. The array keeps
 * `Array.prototype` — `pop`, `join` and `length` maintenance are all still the
 * ordinary ones — and the descriptor is the prototype-free one from
 * `plain-data.ts` for the reason recorded there.
 */
function appendOwn<T>(target: T[], value: T): void {
  Object.defineProperty(target, String(target.length), ownDataDescriptor(value));
}

/**
 * The top of a work stack, or `undefined` when it is empty.
 *
 * The length is checked FIRST. `stack[stack.length - 1]` on an empty array is a
 * property read of `"-1"`, which walks the chain exactly like an index name
 * does; an inherited `"-1"` would have been read as a frame. Cheap, total, and
 * it removes a name from the reachable key material rather than pinning it.
 *
 * LOAD-BEARING, AND PINNED SINCE REMEDIATION ROUND 1 (review round 1, LOW 1).
 * Reverting this to `stack[stack.length - 1]` SURVIVED the whole package suite
 * at tip `4c1bcde`. Under one non-enumerable `Object.prototype["-1"]` the
 * mutant reads the inherited value as a frame the moment the stack drains —
 * with a FRAME-SHAPED value it then loops forever (the reviewer measured >120s,
 * a hang no `testTimeout` can interrupt because the loop is synchronous), and
 * with any other value it throws a `TypeError` out of a walk whose whole
 * contract is that it does not throw. `schema-door.test.ts` pins the SECOND
 * shape on purpose: the mutant fails in milliseconds there, where pinning the
 * first would have hung the suite instead of failing it.
 */
function topOf<T>(stack: readonly T[]): T | undefined {
  return stack.length === 0 ? undefined : stack[stack.length - 1];
}

/** One open container in the iterative walk. */
type Frame =
  | {
      readonly kind: "array";
      readonly container: object;
      readonly source: readonly unknown[];
      readonly length: number;
      readonly path: string;
      readonly copy: unknown[];
      index: number;
    }
  | {
      readonly kind: "object";
      readonly container: object;
      readonly source: Record<PropertyKey, unknown>;
      readonly keys: readonly PropertyKey[];
      readonly path: string;
      readonly copy: Record<PropertyKey, unknown>;
      index: number;
    };

type BeginResult =
  | { readonly ok: true; readonly frame: Frame }
  | { readonly ok: true; readonly frame: null; readonly value: unknown }
  | { readonly ok: false; readonly problem: string };

type NextChildResult =
  | { readonly ok: true; readonly done: true }
  | { readonly ok: true; readonly done: false; readonly value: unknown; readonly path: string }
  | { readonly ok: false; readonly problem: string };

/**
 * The walk. ITERATIVE over an explicit stack (round 3): recursion made the
 * boundary throw `RangeError` on ordinary deep data, which is precisely the
 * "never throws" claim the contract makes. The explicit stack also makes the
 * depth bound a first-class check rather than a property of the machine.
 */
function materializeWith(root: unknown, rootPath: string, grammar: Grammar): MaterializeResult {
  const ancestors = new Set<object>();
  const stack: Frame[] = [];
  // The pending child is held in two locals rather than an object, so the walk
  // allocates nothing per property beyond the copy itself.
  let pendingValue: unknown = root;
  let pendingPath = rootPath;
  let hasPending = true;
  let completed: unknown;
  let hasCompleted = false;

  for (;;) {
    if (hasPending) {
      const step = beginValue(pendingValue, pendingPath, grammar, ancestors, stack.length);
      hasPending = false;
      pendingValue = undefined;
      if (!step.ok) {
        return step;
      }
      if (step.frame === null) {
        completed = step.value;
        hasCompleted = true;
      } else {
        ancestors.add(step.frame.container);
        appendOwn(stack, step.frame);
        hasCompleted = false;
        continue;
      }
    }

    const frame = topOf(stack);
    if (frame === undefined) {
      return { ok: true, value: completed };
    }
    if (hasCompleted) {
      attachChild(frame, completed);
      hasCompleted = false;
    }
    const next = nextChild(frame, grammar);
    if (!next.ok) {
      return next;
    }
    if (next.done) {
      stack.pop();
      ancestors.delete(frame.container);
      completed = frame.copy;
      hasCompleted = true;
      continue;
    }
    pendingValue = next.value;
    pendingPath = next.path;
    hasPending = true;
  }
}

function beginValue(
  value: unknown,
  path: string,
  grammar: Grammar,
  ancestors: Set<object>,
  depth: number,
): BeginResult {
  switch (typeof value) {
    case "boolean":
    case "string":
      return { ok: true, frame: null, value };
    case "number":
      if (!grammar.acceptNonFiniteNumbers) {
        if (!Number.isFinite(value)) {
          return fail(`${path}: non-finite number ${String(value)}`);
        }
        if (Object.is(value, -0)) {
          return fail(`${path}: negative zero does not survive a JSON round trip`);
        }
      }
      return { ok: true, frame: null, value };
    case "undefined":
      return grammar.acceptUndefined
        ? { ok: true, frame: null, value: undefined }
        : fail(`${path}: undefined is not representable in JSON`);
    case "bigint":
      return fail(`${path}: bigint is not representable in JSON`);
    case "function":
      return fail(`${path}: functions are not representable in JSON`);
    case "symbol":
      return fail(`${path}: symbols are not representable in JSON`);
    case "object": {
      if (value === null) {
        return { ok: true, frame: null, value: null };
      }
      if (ancestors.has(value)) {
        return fail(`${path}: circular structure`);
      }
      if (depth >= grammar.maxDepth) {
        return fail(
          `${path}: nesting exceeds the maximum of ${String(grammar.maxDepth)} containers this ` +
            "boundary materializes — deeper structures are refused rather than handed to " +
            "consumers whose own recursion limits are unknown",
        );
      }
      // `THROUGHPUT-1a`: a prepared view is already this walk's answer under
      // its own grammar, wherever its deepest container stays in bounds (see
      // `PREPARED_VIEWS`).
      if (grammar === EVALUATION_VIEW) {
        const prepared = PREPARED_VIEWS.get(value);
        if (prepared !== undefined && depth + prepared.height - 1 < grammar.maxDepth) {
          return { ok: true, frame: null, value };
        }
      }
      // `typeof` is the only operation performed on the value before this
      // point, and it is the only one that cannot run caller code. Everything
      // below — including `Array.isArray`, which throws on a REVOKED proxy —
      // goes through `attempt`.
      const isArray = attempt(path, "testing whether the value is an array", grammar, () =>
        Array.isArray(value),
      );
      if (!isArray.ok) {
        return isArray;
      }
      if (isArray.value) {
        return openArrayFrame(value as readonly unknown[], path, grammar);
      }
      const prototype = attempt(path, "reading the prototype", grammar, () =>
        Object.getPrototypeOf(value),
      );
      if (!prototype.ok) {
        return prototype;
      }
      if (!PLAIN_OBJECT_PROTOTYPES.has(prototype.value as object | null)) {
        return fail(`${path}: ${grammar.plainObjectRule}`);
      }
      return openObjectFrame(value, path, grammar);
    }
    default:
      return fail(`${path}: unsupported value`);
  }
}

function openArrayFrame(source: readonly unknown[], path: string, grammar: Grammar): BeginResult {
  const length = attempt(path, "reading length", grammar, () => source.length);
  if (!length.ok) {
    return length;
  }
  if (
    typeof length.value !== "number" ||
    !Number.isSafeInteger(length.value) ||
    length.value < 0
  ) {
    return fail(`${path}: array length is not a non-negative safe integer`);
  }
  const shapeProblem = arrayOwnPropertyProblem(source, path, length.value, grammar);
  if (shapeProblem !== null) {
    return fail(shapeProblem);
  }
  return {
    ok: true,
    frame: {
      kind: "array",
      container: source,
      source,
      length: length.value,
      path,
      copy: [],
      index: 0,
    },
  };
}

function openObjectFrame(source: object, path: string, grammar: Grammar): BeginResult {
  // `Reflect.ownKeys`, NOT `Object.keys`: the point of this walk is to see
  // every own property canonical serialization would silently drop or
  // transform. `Object.keys` cannot see symbol keys or non-enumerable
  // properties, which is precisely how they used to slip through.
  const keys = attempt(path, "enumerating own keys", grammar, () => Reflect.ownKeys(source));
  if (!keys.ok) {
    return keys;
  }
  let walked: readonly PropertyKey[] = keys.value;
  if (!grammar.perKeyDescriptor) {
    // The view grammar accepts accessors, so it needs to know only which keys
    // are enumerable strings — two intrinsic calls instead of one descriptor
    // read per key. The refusals are the same ones the per-key check produces;
    // identifying WHICH key offends is deferred to the (cold) failure path.
    const enumerable = attempt(path, "enumerating own keys", grammar, () => Object.keys(source));
    if (!enumerable.ok) {
      return enumerable;
    }
    if (enumerable.value.length !== keys.value.length) {
      return fail(hiddenOwnPropertyProblem(source, path, keys.value, enumerable.value, grammar));
    }
    walked = enumerable.value;
  }
  if (grammar.dropOwnProtoKey) {
    // MEDIUM 1, remediation round 1. Dropped HERE rather than in
    // `attachChild`, so the key's VALUE is never read either: the walk performs
    // one caller-supplied read per key it keeps, and a key nothing will ever
    // validate is not a key worth reading.
    //
    // `enumerableWalked` is the point: the list filtered is the one
    // `Object.keys` produced, so a NON-ENUMERABLE own `__proto__` is still
    // REFUSED by the hidden-own-property check above rather than dropped here.
    // A grammar that read per-key descriptors instead would be filtering the
    // full `Reflect.ownKeys` list and would skip that refusal, so the drop is
    // deliberately confined to the branch where the two agree — and the only
    // grammar that sets the flag ({@link DECISION_VIEW}) is in that branch.
    const enumerableWalked = grammar.perKeyDescriptor ? null : walked;
    if (enumerableWalked !== null && enumerableWalked.includes(PROTO_KEY)) {
      walked = enumerableWalked.filter((key) => key !== PROTO_KEY);
    }
  }
  return {
    ok: true,
    frame: {
      kind: "object",
      container: source,
      source: source as Record<PropertyKey, unknown>,
      keys: walked,
      path,
      // D1/D4: the assembly target has NO PROTOTYPE, so no append can consult
      // an inherited accessor and no consumer of the emitted copy can be
      // answered from `Object.prototype` (transcripts C1/C2/D1 in the header).
      copy: Object.create(null) as Record<PropertyKey, unknown>,
      index: 0,
    },
  };
}

/**
 * Names the first own property `Object.keys` cannot see — a symbol key or a
 * non-enumerable one. Only reached on the refusal path, where being precise
 * matters more than being fast.
 */
function hiddenOwnPropertyProblem(
  source: object,
  path: string,
  allKeys: readonly PropertyKey[],
  enumerableKeys: readonly string[],
  grammar: Grammar,
): string {
  const visible = new Set<PropertyKey>(enumerableKeys);
  for (const key of allKeys) {
    if (visible.has(key)) {
      continue;
    }
    if (typeof key === "symbol") {
      return (
        `${path}: symbol-keyed property ${key.toString()} is invisible to JSON serialization ` +
        "and would be dropped silently"
      );
    }
    const formProblem = ownPropertyFormProblem(source, key, path, grammar);
    if (formProblem !== null) {
      return formProblem;
    }
  }
  return `${path}: own properties changed while they were being read`;
}

function attachChild(frame: Frame, value: unknown): void {
  if (frame.kind === "array") {
    // `defineProperty` on the index name, never `push` — see {@link appendOwn}
    // for the measurement. Defining an index property on an array still
    // maintains `length`, so the copy is unchanged in every other respect.
    appendOwn(frame.copy, value);
    return;
  }
  const key = frame.keys[frame.index - 1];
  if (key === undefined) {
    return;
  }
  // `defineProperty` with a PROTOTYPE-FREE descriptor, for EVERY key — not for
  // `__proto__` alone, which is what this used to special-case (WP-170-FU1).
  // Assignment is `Set`: on a prototype-bearing copy it invoked an inherited
  // setter (transcript C2: the copy LOST `marketId` and caller code ran) or
  // threw on a get-only one (C1: an escaped `TypeError` out of a "never
  // throws" boundary). The DESCRIPTOR comes from `plain-data.ts` rather than
  // being written as an object literal here, because a literal descriptor is
  // read with `HasProperty` and walks the chain too (C3: an inherited `get`
  // turned this very call into `TypeError: Getter must be a function`).
  //
  // DEFENCE IN DEPTH, and measured as such: reverting THIS line alone to
  // `frame.copy[key] = value` is behaviourally inert at this tip (mutation M4:
  // the suite stays green), because `openObjectFrame` now hands it a container
  // with no chain for `Set` to walk. C1/C2/C3 are closed by the pair; either
  // half alone is what a future edit would quietly remove, so both are here and
  // the redundancy is stated rather than discovered.
  //
  // The `dropOwnProtoKey` drop is NOT here: it is applied to the key LIST in
  // `openObjectFrame`, so under the decision grammar this function is never
  // reached with `__proto__` and the key's value is never read at all
  // (remediation round 1, MEDIUM 1).
  Object.defineProperty(frame.copy, key, ownDataDescriptor(value));
}

function nextChild(frame: Frame, grammar: Grammar): NextChildResult {
  if (frame.kind === "array") {
    if (frame.index >= frame.length) {
      return { ok: true, done: true };
    }
    const index = frame.index;
    frame.index += 1;
    // The `try`/`catch` is inline rather than through `attempt` on these two
    // reads only: they are the per-property hot path, and the wrapper's closure
    // showed up in the round-3 benchmark. The guarantee is identical — one
    // guarded read per element, refusal rather than propagation.
    let element: unknown;
    try {
      element = frame.source[index];
    } catch (cause) {
      return fail(
        `${frame.path}[${String(index)}]: reading the element threw (${describeCause(cause)}) — ` +
          grammar.exoticTail,
      );
    }
    return { ok: true, done: false, value: element, path: `${frame.path}[${String(index)}]` };
  }

  if (frame.index >= frame.keys.length) {
    return { ok: true, done: true };
  }
  const key = frame.keys[frame.index];
  frame.index += 1;
  if (key === undefined) {
    return fail(`${frame.path}: own key list changed during the walk`);
  }
  if (grammar.perKeyDescriptor) {
    const formProblem = ownPropertyFormProblem(frame.source, key, frame.path, grammar);
    if (formProblem !== null) {
      return fail(formProblem);
    }
  }
  const childPath = `${frame.path}.${String(key)}`;
  let value: unknown;
  try {
    value = frame.source[key];
  } catch (cause) {
    return fail(
      `${childPath}: reading the property value threw (${describeCause(cause)}) — ` +
        grammar.exoticTail,
    );
  }
  return { ok: true, done: false, value, path: childPath };
}

/**
 * Refuses the own-property FORMS the grammar cannot round-trip. Checked BEFORE
 * the property's value is read, so under the checkpointable grammar a getter is
 * never invoked by validation — validating strategy state must not execute
 * strategy code. The descriptor read itself is guarded for the same reason (a
 * Proxy's `getOwnPropertyDescriptor` trap is code too).
 */
function ownPropertyFormProblem(
  owner: object,
  key: PropertyKey,
  path: string,
  grammar: Grammar,
): string | null {
  if (typeof key === "symbol") {
    return (
      `${path}: symbol-keyed property ${key.toString()} is invisible to JSON serialization ` +
      "and would be dropped silently"
    );
  }
  const read = attempt(`${path}.${String(key)}`, "reading the property descriptor", grammar, () =>
    Object.getOwnPropertyDescriptor(owner, key),
  );
  if (!read.ok) {
    return read.problem;
  }
  const descriptor = read.value;
  if (descriptor === undefined) {
    // Unreachable for a plain object; refused rather than assumed away.
    return `${path}.${String(key)}: own property has no descriptor`;
  }
  if (!grammar.acceptAccessors && (descriptor.get !== undefined || descriptor.set !== undefined)) {
    return (
      `${path}.${String(key)}: accessor properties are not checkpointable — serialization ` +
      "would persist a computed value that returns as a plain data property"
    );
  }
  if (!descriptor.enumerable) {
    return (
      `${path}.${String(key)}: non-enumerable property is invisible to JSON serialization ` +
      "and would be dropped silently"
    );
  }
  return null;
}

/**
 * Arrays serialize positionally, so any own property that is not an in-range
 * index (`length` excepted — it is the intrinsic, never a serialized key) is
 * dropped. Index properties themselves must still satisfy the grammar's
 * property-form rules. `length` is read once by the caller and passed in, so a
 * lying `length` cannot report one bound to this check and another to the copy.
 */
function arrayOwnPropertyProblem(
  value: readonly unknown[],
  path: string,
  length: number,
  grammar: Grammar,
): string | null {
  const keys = attempt(path, "enumerating own keys", grammar, () => Reflect.ownKeys(value));
  if (!keys.ok) {
    return keys.problem;
  }
  for (const key of keys.value) {
    if (key === "length") {
      continue;
    }
    if (typeof key === "symbol") {
      return (
        `${path}: symbol-keyed property ${key.toString()} on an array is invisible to JSON ` +
        "serialization and would be dropped silently"
      );
    }
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index >= length || String(index) !== key) {
      return (
        `${path}: non-index own property ${String(key)} on an array is dropped by JSON ` +
        "serialization (arrays are serialized positionally)"
      );
    }
    if (grammar.perKeyDescriptor) {
      // Index properties must still be plain enumerable data under the
      // checkpointable grammar. The view grammar copies arrays positionally by
      // index, so an accessor index is read once like any other value and a
      // non-enumerable one is copied rather than dropped — neither can lose
      // data, which is what this check exists to prevent.
      const formProblem = ownPropertyFormProblem(value, key, path, grammar);
      if (formProblem !== null) {
        return formProblem;
      }
    }
  }
  return null;
}

/** One open container in the iterative canonical serialization. */
type SerializeFrame =
  | {
      readonly kind: "array";
      readonly container: object;
      readonly source: readonly unknown[];
      readonly length: number;
      readonly parts: string[];
      index: number;
    }
  | {
      readonly kind: "object";
      readonly container: object;
      readonly source: Record<string, unknown>;
      readonly keys: readonly string[];
      readonly parts: string[];
      index: number;
    };

/**
 * Deterministic JSON serialization: object keys sorted by UTF-16 code units,
 * arrays in order, scalars via `JSON.stringify`. The caller must have
 * MATERIALIZED the value first; this function assumes it and does not re-walk.
 *
 * `Object.keys` is sufficient here BECAUSE of that precondition: materialization
 * refuses every own-property form `Object.keys` cannot see (symbol keys,
 * non-enumerable properties) and every form whose value is computed rather
 * than stored (accessors), so on a materialized value the two enumerations
 * agree. On an UNVALIDATED value they do not — that is the M1 defect, and the
 * reason this precondition is load-bearing rather than decorative.
 *
 * Since remediation round 2 the runtime never hands this function anything but
 * a MATERIALIZED copy, so on the runtime's own path the precondition is
 * satisfied by construction and not merely by discipline: the value being
 * serialized is inert data the runtime built.
 *
 * ITERATIVE since remediation round 3 (MEDIUM 1): deep data is a heap walk, not
 * a stack walk, so this function cannot contribute a `RangeError` to a "never
 * throws" caller. A CYCLE — which the precondition forbids and which the old
 * recursive version reported as stack exhaustion — is refused with a typed
 * `TypeError` naming the precondition, because a silent hang would be worse
 * than either. No runtime path can reach it: every value the runtime serializes
 * was materialized, and materialization refuses cycles.
 */
export function canonicalJsonStringify(value: unknown): string {
  const ancestors = new Set<object>();
  const stack: SerializeFrame[] = [];
  let cursor: { readonly value: unknown } | null = { value };
  let completed = "null";
  let hasCompleted = false;

  for (;;) {
    if (cursor !== null) {
      const current = cursor.value;
      cursor = null;
      if (current === null || typeof current !== "object") {
        completed = JSON.stringify(current) ?? "null";
        hasCompleted = true;
      } else {
        if (ancestors.has(current)) {
          throw new TypeError(
            "canonicalJsonStringify requires a materialized, acyclic value; a circular " +
              "structure has no canonical serialization",
          );
        }
        ancestors.add(current);
        appendOwn(stack, openSerializeFrame(current));
        hasCompleted = false;
        continue;
      }
    }

    // Length-checked, and appended by `defineProperty`, for the reason
    // {@link appendOwn} records: an inherited accessor at an INDEX name
    // defeated `push` on this walk's own stack and parts arrays too.
    const frame = topOf(stack);
    if (frame === undefined) {
      return completed;
    }
    if (hasCompleted) {
      if (frame.kind === "array") {
        appendOwn(frame.parts, completed);
      } else {
        const key = frame.keys[frame.index - 1] ?? "";
        appendOwn(frame.parts, `${JSON.stringify(key)}:${completed}`);
      }
      hasCompleted = false;
    }

    if (frame.kind === "array") {
      if (frame.index >= frame.length) {
        stack.pop();
        ancestors.delete(frame.container);
        completed = `[${frame.parts.join(",")}]`;
        hasCompleted = true;
        continue;
      }
      const index = frame.index;
      frame.index += 1;
      if (!(index in frame.source)) {
        // A HOLE. `Array.prototype.map` (the previous implementation) preserved
        // holes and `join` rendered them as empty strings, which is how the
        // invalid text `[1,,3]` reaches a caller that skipped validation. That
        // behavior is preserved deliberately: the tests pin it as the reason
        // holes must be refused upstream.
        appendOwn(frame.parts, "");
        continue;
      }
      cursor = { value: frame.source[index] };
      continue;
    }

    if (frame.index >= frame.keys.length) {
      stack.pop();
      ancestors.delete(frame.container);
      completed = `{${frame.parts.join(",")}}`;
      hasCompleted = true;
      continue;
    }
    const key = frame.keys[frame.index];
    frame.index += 1;
    if (key === undefined) {
      continue;
    }
    cursor = { value: frame.source[key] };
  }
}

function openSerializeFrame(value: object): SerializeFrame {
  if (Array.isArray(value)) {
    const source = value as readonly unknown[];
    return { kind: "array", container: value, source, length: source.length, parts: [], index: 0 };
  }
  const source = value as Record<string, unknown>;
  return {
    kind: "object",
    container: value,
    source,
    keys: Object.keys(source).sort(),
    parts: [],
    index: 0,
  };
}

/**
 * Recursively freezes a value in place and returns it. Cycle-safe, and
 * ITERATIVE since remediation round 3 so that depth cannot exhaust the stack.
 *
 * This is a PARTIAL function by design: `Object.freeze` on an exotic object can
 * throw (a `preventExtensions` trap may refuse), and reading own properties can
 * run caller code. Every call site inside this package now passes either data
 * the runtime materialized itself or a caller value inside an explicit guard —
 * `deepFreeze` is never the unguarded operation in a "never throws" path.
 */
export function deepFreeze<T>(value: T): T {
  const seen = new Set<object>();
  // `[value]` is an array LITERAL, which creates its own index `"0"` and is
  // therefore safe; every later append goes through {@link appendOwn} for the
  // reason measured there.
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === null || (typeof current !== "object" && typeof current !== "function")) {
      continue;
    }
    const asObject = current as object;
    if (seen.has(asObject)) {
      continue;
    }
    seen.add(asObject);
    // `THROUGHPUT-1a`: a prepared view is frozen all the way down already.
    if (PREPARED_VIEWS.has(asObject)) {
      continue;
    }
    Object.freeze(asObject);
    for (const key of Reflect.ownKeys(asObject)) {
      appendOwn(stack, (asObject as Record<PropertyKey, unknown>)[key]);
    }
  }
  return value;
}
