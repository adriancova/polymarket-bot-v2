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
 * this package's arithmetic MEANS. Measured at base `b4ce0aa`, against
 * `decimal.js@10.6.0`, with nothing hostile in the INPUT — every input below is
 * a canonical decimal string this repository produces on its ordinary paths:
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
 * EVERY MEASUREMENT IN THIS FILE IS A STATEMENT ABOUT ONE BUILD OF ONE LIBRARY,
 * which is why `packages/decimal/package.json` now declares the EXACT version
 * `10.6.0` rather than the range `^10.6.0` it declared through round 0
 * (`WP-020-FU1` review round 1, N1). A caret range let a routine `pnpm update`
 * change the library this module compensates for without changing a line of this
 * repository, and every number below would then be describing a defect that had
 * moved. The lockfile already resolved to `10.6.0`, so the pin moved no bytes; it
 * removed a silent route. ADR-020 §7 makes the upgrade itself a contract change,
 * and `prototype-guard.test.ts` fails if the library stops being broken.
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
 * 1. **NOTHING HAPPENS IN AN HONEST PROCESS.** The two intrinsics are checked
 *    by two different exact tests, neither of which mutates anything:
 *
 *    - `Array.prototype` is an ARRAY, so `Array.prototype.length === 0` decides
 *      it outright — `[[DefineOwnProperty]]` raises `length` past every array
 *      index it defines and `ArraySetLength` will not lower it past a
 *      non-configurable one.
 *    - `Object.prototype` is an ordinary object, so the scan bails out on its
 *      FIRST own property name. `Object.getOwnPropertyNames` returns array-index
 *      keys first, in ascending numeric order (the specification's
 *      `OrdinaryOwnPropertyKeys`), so "the first name is not an index" proves
 *      there is no index-named own property below 2^32-1 — and no digit array in
 *      this package can be longer than that.
 *
 *    A clean process therefore performs ONE `getOwnPropertyNames` call, ONE
 *    regular-expression test, and ONE `length` read per operation, and MUTATES
 *    NOTHING. That is what makes honest-path byte-identity structural rather
 *    than tested-for.
 * 2. **THE WINDOW RUNS NO OTHER CODE.** JavaScript is single-threaded and
 *    `decimal.js`'s arithmetic invokes no callback, no getter of ours, and
 *    nothing asynchronous, so no code observes the neutralized intrinsics
 *    except the operation this module is protecting.
 * 3. **RESTORATION IS EXACT AND UNCONDITIONAL.** Every change is recorded with
 *    the ORIGINAL descriptor copied field by field into a prototype-free object
 *    (never the descriptor object `Object.getOwnPropertyDescriptor` returned,
 *    which inherits from `Object.prototype` and would therefore be re-read
 *    through the very chain this module distrusts — ADR-020 §1 class 8), and
 *    undone in reverse order in a `finally`. `Array.prototype.length` is part of
 *    that restoration: deleting an index does not lower an array's length, and
 *    `Array.prototype` is itself an array.
 * 4. **IT INVENTS NO VALUE, AND IT HAS EXACTLY ONE REFUSAL.** Every reflective
 *    operation is wrapped, so no engine call can throw out of this module. When
 *    a name can be neither neutralized nor shadowed, the module does NOT run the
 *    operation unguarded: it restores the intrinsics and calls the caller's
 *    `refuse` (this package passes `HostilePrototypeError`). See the residual
 *    below for exactly which states reach it and why the alternative was worse.
 *
 * ## HONEST-PATH COST, measured (`WP-020-FU1` review round 1, finding M2)
 *
 * The guard is on every arithmetic and tick entry point, so its cost is a
 * property of the package and is disclosed rather than assumed negligible.
 * Nanoseconds per operation, median of three runs of best-of-five trials of
 * 200 000 iterations each, Node 24.13.0, `decimal.js@10.6.0`, clean process,
 * the same five operations the round-1 reviewer measured:
 *
 * ```text
 *                  base b4ce0aa   round 0 (37fa983)    round 1 (this tip)
 *   addDecimal            936           2413  2.58x          1343  1.43x
 *   subDecimal            945           2435  2.58x          1345  1.42x
 *   mulDecimal           1092           2520  2.31x          1429  1.31x
 *   divDecimal           2500           3889  1.56x          2773  1.11x
 *   compareDecimal        581           2083  3.58x           973  1.67x
 *
 *   guard overhead     (none)      1389 … 1502 ns       273 … 407 ns
 * ```
 *
 * ROUND 0 PAID ABOUT 1450 ns PER OPERATION, and that destabilized a root gate:
 * `test/unit/ledger/schema-boundary.test.ts` timed out at vitest's 5 s default,
 * three runs out of three, in the round-1 reviewer's scratch tree. The cost was
 * two `getOwnPropertyNames` calls (1269 ns of it, micro-benchmarked), and
 * **1068 ns of THAT was `Object.getOwnPropertyNames(Array.prototype)` alone** —
 * it materializes forty strings, every call, to look at the first one.
 * Replacing it with the `Array.prototype.length` equivalence (3.4 ns, and
 * EXACT — see `arrayPrototypeIndexNames`) is the whole M2 fix.
 *
 * WHAT REMAINS is `Object.getOwnPropertyNames(Object.prototype)`, 248 ns for
 * twelve strings, and NO SOUND CHEAPER TEST EXISTS for an ordinary object. The
 * alternatives were measured rather than guessed:
 *
 * ```text
 *   Object.keys(Object.prototype).length === 0      7.7 ns   UNSOUND
 *     sees only ENUMERABLE names; every pollution shape measured in this
 *     repository is non-enumerable, which is what `defineProperty` defaults to.
 *   Object.hasOwn(Object.prototype, "0")            7.5 ns   UNSOUND
 *     answers for ONE index; a `decimal.js` digit array can hold a hole at any
 *     index below its length, and the header's own transcript fabricates at
 *     index 1 and exhausts the heap at index 2.
 *   a cached clean own-key COUNT                  ~248 ns    NO GAIN
 *     still needs the call that allocates the array.
 * ```
 *
 * The language offers no way to read only the first own key of an ordinary
 * object, so correctness stays primary and the 248 ns is stated rather than
 * traded away. `test/unit/decimal/arithmetic-fold.test.ts` pins that none of
 * this moved a value, and the three timing-marginal batteries
 * (`test/unit/ledger/schema-boundary.test.ts`,
 * `test/unit/ledger/schema-boundary-pnl.test.ts`,
 * `test/unit/risk/inherited-state.test.ts`) now declare an explicit
 * `testTimeout` instead of inheriting the 5 s default — the pnl one because it
 * went RED on the round-1 full-suite run, not as a precaution.
 *
 * WHAT IT DOES NOT COVER, stated precisely rather than claimed away:
 *
 * - A **non-configurable, non-writable data property** or a **non-configurable
 *   accessor** at an index name on `Object.prototype` cannot be redefined at
 *   all. This module falls back to SHADOWING that name on `Array.prototype`,
 *   which covers every index read and write `decimal.js` performs (its digit
 *   containers are arrays), and the fallback was MEASURED rather than assumed —
 *   ALL FIVE non-configurable shapes at `Object.prototype["0"]` answer
 *   byte-identically to a clean process at this tip:
 *
 *   ```text
 *   Object.prototype["0"], non-configurable      round 1 tip
 *     writable data                              byte-identical (neutralized in place)
 *     read-only data                             byte-identical (shadowed)
 *     get-only accessor                          byte-identical (shadowed)
 *     set-only accessor                          byte-identical (shadowed)
 *     get/set accessor pair                      byte-identical (shadowed)
 *   ```
 *
 *   NOTHING PINNED THAT UNTIL ROUND 1. Deleting the shadow fallback left all 869
 *   tests green while four of those five FABRICATED — `addDecimal("1", "2")`
 *   answered `"990"`. `test/unit/decimal/unneutralizable-shapes.test.ts` now
 *   kills that mutation: with the fallback gone, the four turn from
 *   `byte-identical` into the refusal below, which is a different answer and
 *   therefore a failure. (At round 0's tip there was no refusal to turn into,
 *   which is why they fabricated instead.)
 *
 * - THE ONE REMAINING CASE is the same shape on `ARRAY.prototype` itself, where
 *   there is no lower link to shadow from. Round 0 measured three of the five
 *   shapes and concluded the residual "fails closed: an untyped `TypeError`,
 *   never a fabricated value". THAT WAS FALSE. All five, measured at base
 *   `b4ce0aa` and at round 0's tip `37fa983` — identical at both, so this was
 *   never a regression, only an unmeasured claim:
 *
 *   ```text
 *   Array.prototype["0"], non-configurable    base b4ce0aa AND round 0 tip
 *     writable data      addDecimal("100","-100")   "0" -> "9"       FABRICATED
 *                        (round 0 tip: byte-identical, neutralized in place)
 *     read-only data     TypeError: Cannot assign to read only property '0'
 *     get-only accessor  TypeError: Cannot set property 0 … which has only a getter
 *     set-only accessor  mulDecimal("2","3")        "6" -> "0"       FABRICATED
 *                        mulDecimal("0.37","100")  "37" -> "0"       FABRICATED
 *                        compareDecimal("5","4")     1 -> 0          FABRICATED
 *                        isTickConformant("0.37","0.01")
 *                          -> InvalidTickSizeError 'tick size must be strictly
 *                             positive, received "0.01"' — WRONG-TYPED, about a
 *                             tick size that is strictly positive
 *     get/set pair       addDecimal("100","-100")   "0" -> "9"       FABRICATED
 *                        addDecimal("1","2")        "3" -> "990"     FABRICATED
 *                        subDecimal("50","50")      "0" -> "9"       FABRICATED
 *   ```
 *
 *   AT THIS TIP THE RESIDUAL IS A REFUSAL. Every non-configurable index-name
 *   shape on `Array.prototype` that cannot be neutralized in place — read-only
 *   data and all three accessor shapes — is REFUSED with
 *   `HostilePrototypeError` (`DECIMAL_HOSTILE_PROTOTYPE`), never computed. The
 *   non-configurable WRITABLE data shape is still neutralized in place and still
 *   answers byte-identically. Nothing else is claimed: the refusal is an
 *   AVAILABILITY outcome, it is what a corrupted `Array.prototype` costs, and
 *   reaching that state needs in-process code that has permanently corrupted the
 *   intrinsic — in which case no array anywhere in the process behaves and this
 *   package is not the thing that is broken. What it is NOT any more is a
 *   fabricated monetary value.
 * - Index names at or above 2^32-1 are not array indices, so they neither raise
 *   `Array.prototype.length` nor sort before the string keys, and neither exact
 *   test in property 1 sees them. A `decimal.js` digit array cannot reach that
 *   length (it would need more than four billion words), so no read can consult
 *   one.
 * - It says nothing about NAMED properties. `Object.prototype.set` is the
 *   `divDecimal` explicit-options hazard, closed separately in
 *   `arithmetic.ts`; `Object.prototype.get` is the descriptor-literal hazard,
 *   closed here by building every descriptor with `Object.create(null)`.
 *
 * Purity: no I/O, no clock, no randomness, no import — which is why the refusal
 * arrives as a CALLBACK rather than as an error class this module constructs.
 * `docs/contracts/dependency-direction.md` §3 F15 binds this package to
 * `decimal.js` and `node:crypto`; this module imports neither.
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
 * The array-index names `Array.prototype` owns, or {@link NO_NAMES}.
 *
 * `Array.prototype` IS AN ARRAY, and that gives an exact answer for the price of
 * one property read. `[[DefineOwnProperty]]` on an Array exotic object raises
 * `length` to `index + 1` whenever an array index is defined, and `ArraySetLength`
 * refuses to lower `length` past a non-configurable element — so
 *
 * ```text
 * Array.prototype.length === 0   ⟺   Array.prototype owns no array-index name
 * ```
 *
 * is a specification equivalence, not a heuristic, over the whole array-index
 * range (`0 … 2^32-2`). The converse direction is the safe one anyway: a
 * `length` somebody merely ASSIGNED (`Array.prototype.length = 5`, no elements)
 * is a false positive that costs one full scan and then answers {@link NO_NAMES}
 * from the first-name bail-out below.
 *
 * WHY IT IS WORTH A SEPARATE FUNCTION (`WP-020-FU1` review round 1, finding M2).
 * `Object.getOwnPropertyNames(Array.prototype)` materializes FORTY strings and
 * measured **1068 ns** per call on the round-1 bench machine — five times the
 * whole rest of the honest path, and 84% of the guard's total per-operation cost.
 * The `length` read measured **3.4 ns**. That one substitution is the M2 fix; the
 * module header carries the before/after per-operation table.
 *
 * The read cannot throw and cannot run caller code: `length` is an own,
 * non-configurable data property of every Array exotic object, so it can never
 * be replaced by an accessor and `Get` never leaves the object.
 */
function arrayPrototypeIndexNames(): readonly string[] {
  if (Array.prototype.length === 0) return NO_NAMES;
  return indexNamesOwnedBy(Array.prototype);
}

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
 *
 * FALSE MEANS "THE ENGINE REFUSED", and the caller must not compute after it.
 * `ValidateAndApplyPropertyDescriptor` permits exactly two edits to a
 * non-configurable property: writing `[[Value]]` and clearing `[[Writable]]`,
 * and both only for a data property that is still writable. So the answer is
 * `true` for a non-configurable WRITABLE data property (measured: it is
 * neutralized in place and the process answers byte-identically to a clean one)
 * and `false` for a non-configurable READ-ONLY data property and for every
 * non-configurable ACCESSOR — data↔accessor conversion is forbidden outright.
 * This function does not restate those rules; it asks the engine and reports
 * what it said, which cannot drift from the specification a future engine
 * implements.
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

/** Membership, without `Array.prototype.includes` — this module distrusts that chain. */
function includesName(names: readonly string[], name: string): boolean {
  for (const candidate of names) {
    if (candidate === name) return true;
  }
  return false;
}

/**
 * Neutralizes both intrinsics and reports the names it COULD NOT neutralize.
 *
 * An empty answer means every array-index name on both prototypes now reads as
 * a hole and absorbs a write. A non-empty answer means at least one name would
 * still be consulted by `decimal.js`, so the operation must not run: see
 * {@link withNeutralIndexNames}.
 */
function neutralizeIntrinsics(
  objectNames: readonly string[],
  arrayNames: readonly string[],
  undo: Undo[],
): readonly string[] {
  const unneutralizable: string[] = [];
  const neutralizedOnArray: string[] = [];
  for (const name of arrayNames) {
    if (neutralizeInPlace(Array.prototype, name, undo)) appendData(neutralizedOnArray, name);
    else appendData(unneutralizable, `Array.prototype["${name}"]`);
  }
  for (const name of objectNames) {
    if (neutralizeInPlace(Object.prototype, name, undo)) continue;
    // It will not be given up where it lives, so answer it ONE LINK DOWN.
    if (shadowOnArrayPrototype(name, undo)) continue;
    // The shadow was declined. The only reason it can be declined is that
    // `Array.prototype` already OWNS the name — in which case that own property
    // is what `decimal.js` will read, and it is harmless exactly when the loop
    // above neutralized it. Anything else (a non-extensible `Array.prototype`,
    // a `defineProperty` the engine rejected) leaves the name live.
    if (includesName(neutralizedOnArray, name)) continue;
    appendData(unneutralizable, `Object.prototype["${name}"]`);
  }
  return unneutralizable;
}

/**
 * Called instead of the operation when a name cannot be neutralized.
 *
 * It receives the offending names already rendered (`Array.prototype["0"]`) and
 * MUST NOT RETURN: the whole point is that no value is computed. The refusal
 * lives with the caller because this module owns no error taxonomy and imports
 * nothing (see the module header's purity note); `packages/decimal`'s own
 * `HostilePrototypeError` is what the package passes.
 */
export type IndexNameRefusal = (unneutralizable: readonly string[]) => never;

/**
 * Runs `operation` with every array-index name on `Object.prototype` and
 * `Array.prototype` neutralized, and restores them afterwards.
 *
 * Returns whatever `operation` returns and propagates whatever it throws.
 *
 * IT ADDS EXACTLY ONE FAILURE MODE, and only where the alternative is worse
 * (`WP-020-FU1` review round 1, finding M1). When a name cannot be neutralized
 * AND cannot be shadowed, this function calls `refuse` instead of `operation`.
 * The state that reaches it is a non-configurable read-only data property or a
 * non-configurable accessor at an index name on `Array.prototype`, where there
 * is no lower link to shadow from. Round 0 documented that residual as "fails
 * closed: an untyped `TypeError`, never a fabricated value", and round 1
 * measured that claim FALSE for two of the five shapes: a non-configurable
 * `get`/`set` PAIR made `addDecimal("100", "-100")` answer `"9"`, and a
 * non-configurable SET-ONLY accessor made `mulDecimal("2", "3")` answer `"0"`
 * and `compareDecimal("5", "4")` answer `0` — five comparing EQUAL to four, on a
 * layer-0 monetary surface. `refuse` converts every one of those into a typed
 * refusal, computed by nobody. The intrinsics are restored BEFORE it is called,
 * so the refusal is built in the process's own ambient state and never inside
 * the window.
 */
export function withNeutralIndexNames<T>(operation: () => T, refuse: IndexNameRefusal): T {
  const objectNames = indexNamesOwnedBy(Object.prototype);
  const arrayNames = arrayPrototypeIndexNames();
  if (objectNames.length === 0 && arrayNames.length === 0) return operation();

  const undo: Undo[] = [];
  let unneutralizable: readonly string[] = NO_NAMES;
  // Recorded FIRST so it is restored LAST — after the shadows are deleted,
  // because deleting an index does not lower an array's length and
  // `Array.prototype` is itself an array.
  appendData<Undo>(undo, { kind: "arrayLength", length: Array.prototype.length });
  try {
    unneutralizable = neutralizeIntrinsics(objectNames, arrayNames, undo);
    if (unneutralizable.length === 0) return operation();
  } finally {
    undoAll(undo);
  }
  return refuse(unneutralizable);
}
