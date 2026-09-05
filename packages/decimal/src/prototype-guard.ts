/**
 * THE INDEX-NAME BOUNDARY — `WP-020-FU1`.
 *
 * WHY THIS MODULE EXISTS. `decimal.js` represents a number as an ARRAY of
 * base-1e7 digit words, and its algorithms both READ that array where it has a
 * HOLE and WRITE to an index the array does not own yet. Both operations
 * consult the prototype chain:
 *
 * - a read of a hole is `Get`, which walks `Array.prototype` and then
 *   `Object.prototype`;
 * - a write to an absent index is `Set`, which walks the same chain looking for
 *   an inherited accessor or a non-writable data property before it creates an
 *   own property.
 *
 * So ONE property at an array-index NAME on `Object.prototype` changes what
 * this package's arithmetic MEANS. Measured at base `b4ce0aa`, against the
 * pinned `decimal.js@10.6.0`, with nothing hostile in the INPUT — every input
 * below is a canonical decimal string this repository produces on its ordinary
 * paths:
 *
 * ```text
 * Object.prototype["0"] = "9"            (non-enumerable data, writable)
 *   addDecimal("100", "-100")   "0"    -> "9"           FABRICATED
 *   subDecimal("50", "50")      "0"    -> "9"           FABRICATED
 *   subDecimal("0.3", "0.3")    "0"    -> "0.0000009"   FABRICATED
 *
 * Object.prototype["1"] = "9"            (same shape)
 *   divDecimal("1", "3")   "0.3333…"  -> "3.333333633333333333333333333333333"
 *   divDecimal("2", "4")   "0.5"      -> "5.000000225"
 *
 * Object.prototype["0"] = get-only accessor
 *   22 of 24 probed operations THROW `TypeError: Cannot set property 0 …`,
 *   including `addDecimal("1", "2")` — the class is NOT confined to
 *   exactly-zero results.
 *
 * Object.prototype["0"] = read-only data
 *   22 of 24 THROW `TypeError: Cannot assign to read only property '0' …`
 *
 * Object.prototype["0"] = get/set accessor pair
 *   `addDecimal("100", "-100")` does not return: the library loops.
 *
 * Object.prototype["2"] = "9"            (non-enumerable data, writable)
 *   `mulDecimal("123456789", "987654321")` exhausts the heap.
 * ```
 *
 * The root cause is one pattern, repeated across the library's arithmetic. In
 * `P.minus` (`decimal.mjs`), after the digit-wise subtraction:
 *
 * ```js
 * for (; xd[0] === 0; xd.shift()) --e;   // strips every leading zero word
 * if (!xd[0]) return new Ctor(0);        // "the result is zero"
 * ```
 *
 * On an exactly-zero result `xd` is emptied, so `xd[0]` is a HOLE — and the
 * "is it zero?" test is answered by `Object.prototype["0"]`. With `"9"` there,
 * the library concludes the result is NOT zero and renders a number nobody
 * computed. The same class covers the writes (`xd[len++] = 0`,
 * `x.d.push(...)`), which is why the accessor and read-only shapes throw
 * instead, and why a `set` trap can make the library loop.
 *
 * WHAT THIS MODULE DOES. It makes the read of a hole answer what the
 * specification says a hole is — `undefined` — and the write to an absent index
 * create an own property, by NEUTRALIZING every array-index-named own property
 * of `Object.prototype` and `Array.prototype` for the duration of one
 * arithmetic operation, and restoring each one exactly afterwards. It does not
 * inspect, sanitise, or reject the caller's values: it removes the ambient
 * state the library would otherwise read.
 *
 * FOUR PROPERTIES, STATED SO THEY CAN BE CHECKED:
 *
 * 1. **NOTHING HAPPENS IN AN HONEST PROCESS.** The scan bails out on the FIRST
 *    own property name of each intrinsic. `Object.getOwnPropertyNames` returns
 *    array-index keys first, in ascending numeric order (the specification's
 *    `OrdinaryOwnPropertyKeys`, which both intrinsics use), so "the first name
 *    is not an index" proves there is no index-named own property below
 *    2^32-1 — and no digit array in this package can be longer than that.
 *    A clean process therefore performs two `getOwnPropertyNames` calls and two
 *    regular-expression tests per operation and MUTATES NOTHING. That is what
 *    makes honest-path byte-identity structural rather than tested-for.
 * 2. **THE WINDOW RUNS NO OTHER CODE.** JavaScript is single-threaded and
 *    `decimal.js`'s arithmetic invokes no callback, no getter of ours, and
 *    nothing asynchronous, so no code observes the neutralized intrinsics
 *    except the operation this module is protecting.
 * 3. **RESTORATION IS EXACT AND UNCONDITIONAL.** Every change is recorded with
 *    the ORIGINAL descriptor copied field by field into a prototype-free object
 *    (never the descriptor object `Object.getOwnPropertyDescriptor` returned,
 *    which inherits from `Object.prototype` and would therefore be re-read
 *    through the very chain this module distrusts — ADR-020 §1 class 8), and
 *    undone in reverse order in a `finally`.
 * 4. **IT NEVER THROWS OF ITS OWN ACCORD.** Every reflective operation is
 *    wrapped. A name it cannot neutralize is left alone, which is the base
 *    behaviour for that name and never worse than it.
 *
 * WHAT IT DOES NOT COVER, stated precisely rather than claimed away:
 *
 * - A **non-configurable, non-writable data property** or a **non-configurable
 *   accessor** at an index name on `Object.prototype` cannot be redefined at
 *   all. This module falls back to SHADOWING that name on `Array.prototype`,
 *   which covers every index read and write `decimal.js` performs (its digit
 *   containers are arrays), and the fallback was MEASURED rather than assumed —
 *   all three non-configurable shapes at `Object.prototype["0"]` answer
 *   byte-identically to a clean process at this tip.
 *
 *   THE ONE REMAINING CASE is the same shape on `ARRAY.prototype` itself, where
 *   there is no lower link to shadow from. Measured at this tip:
 *
 *   ```text
 *   Array.prototype["0"], non-configurable            tip
 *     writable data                                   byte-identical (neutralized in place)
 *     read-only data     TypeError: Cannot assign to read only property '0'
 *     get-only accessor  TypeError: Cannot set property 0 … which has only a getter
 *   ```
 *
 *   Both remaining rows FAIL CLOSED: an untyped `TypeError`, never a fabricated
 *   value. Reaching that state requires an attacker who has PERMANENTLY
 *   corrupted `Array.prototype`, in which case no array anywhere in the process
 *   can be appended to and this package is not the thing that is broken.
 * - Index names at or above 2^32-1 are not array indices for ordering purposes
 *   and sort after the string keys, so the fast-path bail-out in property 1
 *   does not see them. A `decimal.js` digit array cannot reach that length (it
 *   would need more than four billion words), so no read can consult one.
 * - It says nothing about NAMED properties. `Object.prototype.set` is the
 *   `divDecimal` explicit-options hazard, closed separately in
 *   `arithmetic.ts`; `Object.prototype.get` is the descriptor-literal hazard,
 *   closed here by building every descriptor with `Object.create(null)`.
 *
 * Purity: no I/O, no clock, no randomness, no import. `docs/contracts/
 * dependency-direction.md` §3 F15 binds this package to `decimal.js` and
 * `node:crypto`; this module imports neither.
 */

/**
 * A canonical array-index property NAME (`"0"`, `"12"`, never `"01"`, never
 * `"1.0"`). The same grammar `packages/risk/src/plain-data.ts` uses, and the
 * same one `test/unit/ledger/schema-boundary.test.ts` classifies with.
 */
const ARRAY_INDEX_NAME = /^(?:0|[1-9][0-9]*)$/u;

/** Nothing to neutralize — a shared empty result, so the fast path allocates nothing extra. */
const NO_NAMES: readonly string[] = Object.freeze([]);

/**
 * Appends to an array with `CreateDataProperty` semantics.
 *
 * `Array.prototype.push` is `Set`, and this module runs precisely when `Set` at
 * an index name is the thing that is broken: the first `push` onto an empty
 * array throws under a get-only `Object.prototype["0"]`. A guard defeated by
 * the condition it guards against is not a guard. (The same reasoning, and the
 * same helper, as `test/unit/ledger/pollution.ts`'s `appendData`.)
 */
function appendData<T>(target: T[], value: T): void {
  const descriptor = bareDescriptor();
  descriptor["value"] = value;
  descriptor["writable"] = true;
  descriptor["enumerable"] = true;
  descriptor["configurable"] = true;
  Object.defineProperty(target, `${target.length}`, descriptor);
}

/**
 * A property descriptor with NO PROTOTYPE.
 *
 * `Object.defineProperty` reads a descriptor's fields with `HasProperty`, which
 * walks the prototype chain, so an object-literal descriptor MEANS something
 * different once `Object.prototype.get` exists (ADR-020 §1 class 8: the call
 * answers `TypeError: Getter must be a function` instead of defining anything).
 * Every descriptor this module builds or restores is prototype-free.
 */
function bareDescriptor(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>;
}

/** The six fields a property descriptor may carry, in specification order. */
const DESCRIPTOR_FIELDS: readonly string[] = Object.freeze([
  "value",
  "writable",
  "get",
  "set",
  "enumerable",
  "configurable",
]);

/**
 * A prototype-free copy of a descriptor, carrying only the fields it OWNS.
 *
 * "Only the fields it owns" is the whole point: writing an absent field as
 * `undefined` is not the same as leaving it out — `Object.defineProperty` reads
 * an ABSENT field as "leave this attribute alone" and a present `undefined` one
 * as `false`, so a copy that fills in blanks would silently un-enumerate the
 * property it is meant to restore unchanged.
 */
function ownDescriptorCopy(descriptor: PropertyDescriptor): Record<string, unknown> {
  const copy = bareDescriptor();
  const source = descriptor as Record<string, unknown>;
  // Assignment is safe on a null-prototype target and nowhere else here: `Set`
  // cannot find an inherited accessor to invoke.
  for (const field of DESCRIPTOR_FIELDS) {
    if (Object.hasOwn(source, field)) copy[field] = source[field];
  }
  return copy;
}

/** One change to undo when the protected operation finishes. */
type Undo =
  | {
      readonly kind: "define";
      readonly target: object;
      readonly name: string;
      readonly descriptor: Record<string, unknown>;
    }
  | { readonly kind: "delete"; readonly target: object; readonly name: string }
  | { readonly kind: "arrayLength"; readonly length: number };

/**
 * The array-index names `target` owns, or {@link NO_NAMES}.
 *
 * The FIRST-NAME bail-out is property 1 of the module header and it is a
 * specification guarantee, not a heuristic: `OrdinaryOwnPropertyKeys` lists
 * array-index keys before every other string key, so a non-index first name
 * proves there is no index-named own property to find. Both intrinsics this
 * module scans use it (`Array.prototype` is an Array exotic object, and Array
 * does not override `[[OwnPropertyKeys]]`).
 */
function indexNamesOwnedBy(target: object): readonly string[] {
  let names: readonly string[];
  try {
    names = Object.getOwnPropertyNames(target);
  } catch {
    return NO_NAMES;
  }
  const first = names[0];
  if (first === undefined || !ARRAY_INDEX_NAME.test(first)) return NO_NAMES;
  const found: string[] = [];
  for (const name of names) {
    if (ARRAY_INDEX_NAME.test(name)) appendData(found, name);
  }
  return found;
}

/**
 * Replaces `target[name]` with a writable `undefined` data property, recording
 * the original for restoration. Returns whether the name is now neutral.
 *
 * The replacement keeps the original's `enumerable` and `configurable`
 * attributes, because a `configurable: true` in the replacement is REJECTED for
 * a non-configurable property — and a non-configurable but WRITABLE data
 * property can have its value changed, which is the only reason that case is
 * covered at all.
 */
function neutralizeInPlace(target: object, name: string, undo: Undo[]): boolean {
  let current: PropertyDescriptor | undefined;
  try {
    current = Object.getOwnPropertyDescriptor(target, name);
  } catch {
    return false;
  }
  // Gone between the scan and now: nothing inherited can answer for it.
  if (current === undefined) return true;
  const saved = ownDescriptorCopy(current);
  const neutral = bareDescriptor();
  neutral["value"] = undefined;
  neutral["writable"] = true;
  neutral["enumerable"] = saved["enumerable"];
  neutral["configurable"] = saved["configurable"];
  try {
    Object.defineProperty(target, name, neutral);
  } catch {
    return false;
  }
  appendData<Undo>(undo, { kind: "define", target, name, descriptor: saved });
  return true;
}

/**
 * Shadows `name` on `Array.prototype`, for a name `Object.prototype` owns and
 * will not give up (a non-configurable accessor or read-only data property).
 *
 * `decimal.js` keeps its digits in ARRAYS, so a writable `undefined` at the
 * same name one link down the chain answers every read and absorbs every write
 * before `Object.prototype` is ever consulted.
 */
function shadowOnArrayPrototype(name: string, undo: Undo[]): boolean {
  if (Object.hasOwn(Array.prototype, name)) return false;
  const shadow = bareDescriptor();
  shadow["value"] = undefined;
  shadow["writable"] = true;
  shadow["enumerable"] = false;
  shadow["configurable"] = true;
  try {
    Object.defineProperty(Array.prototype, name, shadow);
  } catch {
    return false;
  }
  appendData<Undo>(undo, { kind: "delete", target: Array.prototype, name });
  return true;
}

/**
 * Undoes every recorded change, in reverse order.
 *
 * TOTAL. A restoration that fails cannot be reported from here and must not
 * abort the restorations after it, so each is attempted independently. By
 * construction none can fail: this module only ever changed properties it had
 * just proved redefinable, and only ever created configurable ones.
 */
function undoAll(undo: readonly Undo[]): void {
  for (let index = undo.length - 1; index >= 0; index -= 1) {
    const entry = undo[index];
    if (entry === undefined) continue;
    try {
      if (entry.kind === "define") {
        Object.defineProperty(entry.target, entry.name, entry.descriptor);
      } else if (entry.kind === "delete") {
        Reflect.deleteProperty(entry.target, entry.name);
      } else {
        Array.prototype.length = entry.length;
      }
    } catch {
      // Documented in the doc comment above: unreachable by construction, and
      // there is no channel from here that would not itself be a new hazard.
    }
  }
}

/**
 * Runs `operation` with every array-index name on `Object.prototype` and
 * `Array.prototype` neutralized, and restores them afterwards.
 *
 * Returns whatever `operation` returns and propagates whatever it throws; this
 * function adds no failure mode of its own.
 */
export function withNeutralIndexNames<T>(operation: () => T): T {
  const objectNames = indexNamesOwnedBy(Object.prototype);
  const arrayNames = indexNamesOwnedBy(Array.prototype);
  if (objectNames.length === 0 && arrayNames.length === 0) return operation();

  const undo: Undo[] = [];
  // Recorded FIRST so it is restored LAST — after the shadows are deleted,
  // because deleting an index does not lower an array's length and
  // `Array.prototype` is itself an array.
  appendData<Undo>(undo, { kind: "arrayLength", length: Array.prototype.length });
  try {
    for (const name of arrayNames) neutralizeInPlace(Array.prototype, name, undo);
    for (const name of objectNames) {
      if (!neutralizeInPlace(Object.prototype, name, undo)) shadowOnArrayPrototype(name, undo);
    }
    return operation();
  } finally {
    undoAll(undo);
  }
}
