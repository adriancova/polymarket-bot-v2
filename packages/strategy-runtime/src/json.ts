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
 * Note on numbers: a checkpoint value may be a non-economic number (a counter,
 * a flag). ECONOMIC values inside strategy state must be canonical decimal
 * strings by §6 invariant 1 — that is a strategy-discipline rule reviewed with
 * the strategy (the domain deliberately types `statePatch` as opaque).
 */

import { describeCause } from "./describe.js";

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
  /** Tail of the refusal a throwing caller-supplied operation produces. */
  readonly exoticTail: string;
  /** The "this is not a plain object" refusal, in this grammar's words. */
  readonly plainObjectRule: string;
}

const CHECKPOINTABLE_JSON: Grammar = {
  acceptUndefined: false,
  acceptNonFiniteNumbers: false,
  acceptAccessors: false,
  perKeyDescriptor: true,
  maxDepth: MAX_MATERIALIZED_DEPTH,
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
  exoticTail:
    "a view whose property access executes code that throws cannot be read into the inert " +
    "snapshot the runtime evaluates against",
  plainObjectRule:
    "only plain objects and arrays can be read into an evaluation-input snapshot",
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
 * value that cannot be formatted, and arbitrarily deep ordinary data.
 */
export function materializeCheckpointableJson(
  value: unknown,
  path = "$",
): MaterializeCheckpointableJsonResult {
  const result = materializeWith(value, path, CHECKPOINTABLE_JSON);
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
export function materializeEvaluationView(value: unknown, path = "$"): MaterializeResult {
  return materializeWith(value, path, EVALUATION_VIEW);
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
        stack.push(step.frame);
        hasCompleted = false;
        continue;
      }
    }

    const frame = stack[stack.length - 1];
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
  return {
    ok: true,
    frame: {
      kind: "object",
      container: source,
      source: source as Record<PropertyKey, unknown>,
      keys: walked,
      path,
      copy: {},
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
    frame.copy.push(value);
    return;
  }
  const key = frame.keys[frame.index - 1];
  if (key === undefined) {
    return;
  }
  if (key === "__proto__") {
    // `defineProperty`, not assignment: an own `__proto__` data property (which
    // `JSON.parse` can produce and JSON serialization does emit) would trigger
    // the inherited setter under `copy[key] = …` and silently move the property
    // into the prototype instead of the copy. Every other key takes the plain
    // assignment, which produces exactly the same writable/enumerable/
    // configurable data property on a fresh object at a fraction of the cost.
    Object.defineProperty(frame.copy, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    return;
  }
  frame.copy[key] = value;
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
        stack.push(openSerializeFrame(current));
        hasCompleted = false;
        continue;
      }
    }

    const frame = stack[stack.length - 1];
    if (frame === undefined) {
      return completed;
    }
    if (hasCompleted) {
      if (frame.kind === "array") {
        frame.parts.push(completed);
      } else {
        const key = frame.keys[frame.index - 1] ?? "";
        frame.parts.push(`${JSON.stringify(key)}:${completed}`);
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
        frame.parts.push("");
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
    Object.freeze(asObject);
    for (const key of Reflect.ownKeys(asObject)) {
      stack.push((asObject as Record<PropertyKey, unknown>)[key]);
    }
  }
  return value;
}
