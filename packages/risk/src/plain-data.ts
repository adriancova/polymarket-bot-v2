/**
 * THE DATA-RECORD BOUNDARY — adversarial review rounds 4 and 5.
 *
 * CANONICAL, AND THE ONLY COPY (`WP-180-FU2`, 2026-09-04). This module used to
 * be DUPLICATED into `packages/capital-allocator` and
 * `packages/execution-planner`, byte-identical below the marker and bound by a
 * drift test. `GOV-2A` ruled the duplication out — a security mechanism that
 * must be fixed in three places, in three grants, is the wrong shape for a
 * security mechanism — and collapsed the three copies here. Both consumers now
 * import it as `@polymarket-bot/risk/plain-data` across the
 * `docs/contracts/dependency-direction.md` §2.1 **S3** / **S4** same-layer
 * edges; the module is reachable only through this package's `exports` map
 * (F16). Nothing below this header changed in the collapse itself — the body
 * was byte for byte what review rounds 4-9 left here, and the ONE later change
 * is `WP-020-FU1`'s append widening (proposition 4b and {@link appendData}),
 * which is why `test/unit/execution-planner/mirrors.test.ts`'s body pin was
 * re-derived in that round. That test is also the DELETION guard: it fails if a
 * copy of this body reappears under any other package's `src`.
 *
 * WHY THIS MODULE EXISTS. Round 3 replaced a list of identity fields with a
 * WALK over the record about to be emitted. Round 4 found the walk's
 * ENUMERATION PRIMITIVE had become the new list: `Object.entries` sees only
 * enumerable, own, string-keyed properties, so three shapes slipped past it —
 * a non-enumerable property, a property on the object's PROTOTYPE, and an
 * accessor (which `Object.entries` does not skip but INVOKES, so a throwing
 * getter escaped a function whose whole contract is a typed result). Worse, the
 * property test walked the same way, so it could never see what the product
 * missed.
 *
 * The lesson generalizes past any particular primitive: a JavaScript object is
 * not the same thing as a data record. It can hide state behind enumerability,
 * inherit it, compute it on read, change it between two reads, or throw when
 * asked. So this package stops treating caller-supplied objects as records.
 * {@link readPlainData} READS a value into a record — a fresh tree of plain
 * objects, arrays and primitives, every property an own, enumerable, data
 * property — or refuses with the reason and the path. Everything downstream
 * (identity validation, arithmetic, emission) then operates on that tree, where
 * "what a walk can see" and "what the value carries" are the same set.
 *
 * WHAT IT REFUSES, AND WHY EACH IS NOT RECORD DATA:
 *
 * - a `Proxy`, refused FIRST, before any other operation touches it (see the
 *   claim below). A `Proxy` is not a value; it is a program that answers
 *   questions about a value, and it may answer differently each time, omit a
 *   property, describe one it does not have, or throw;
 * - a NON-PLAIN PROTOTYPE (anything but `Object.prototype`, `Array.prototype`
 *   or `null`). An inherited property is state the container does not own, and
 *   `Object.freeze` cannot freeze it: the round-4 probe froze a record and then
 *   changed the value it reported by editing the prototype afterwards. Refusing
 *   the shape outright is what makes "the emitted record is deeply immutable"
 *   true rather than approximately true;
 * - an ACCESSOR property. A getter is code, not data. It may throw, may return
 *   a different value on the next call (the validate-then-emit TOCTOU), and may
 *   have side effects. This module never invokes one: values are taken from
 *   property DESCRIPTORS, so a hostile getter is refused without ever running;
 * - a FUNCTION, SYMBOL or BIGINT value, and a SYMBOL-KEYED property. None can
 *   be a field of a persisted record; dropping them silently is the failure
 *   mode this whole review chain is about;
 * - a property named `__proto__` ({@link FORBIDDEN_KEY}) — the one name a
 *   `strictObject` in this repository provably cannot report as unrecognized,
 *   with the measurement recorded at that constant;
 * - a CYCLE, a SPARSE array, and nesting deeper than {@link MAX_DEPTH}. A
 *   record is a finite tree.
 *
 * WHAT IT DOES NOT REFUSE: a NON-ENUMERABLE own data property is READ, not
 * rejected. Hiding a field from enumeration does not make it disappear from the
 * value, so materializing it (as an ordinary own enumerable property) is what
 * lets the identity rules see it — the round-4 probe's uppercase market id
 * comes back as a `RISK_UUID_NOT_CANONICAL` refusal naming its exact path,
 * which is a better answer than a shape refusal.
 *
 * ---------------------------------------------------------------------------
 * THE CLAIM THIS MODULE MAKES, AND EXACTLY WHAT IT RESTS ON (round 5)
 * ---------------------------------------------------------------------------
 *
 * Round 4 wrote, without qualification, that "no caller code runs inside the
 * boundary at all". Review round 5 falsified it: a `Proxy` is caller code
 * wearing the shape of data, and `Object.getPrototypeOf`, `Reflect.ownKeys` and
 * `Object.getOwnPropertyDescriptor` all invoke its traps. A nested `Proxy` in an
 * otherwise valid record was accepted after NINE trap invocations; a trap could
 * omit a property or describe one that is not there; a trap result carrying
 * getters ran four of them inside `Object.getOwnPropertyDescriptor` itself; and
 * an array `Proxy` whose `length` answered with a throwing `@@toPrimitive`
 * turned the refusal-construction site into an escape hatch for an exception.
 *
 * The claim is now stated as three separate propositions, in decreasing order
 * of how much they rest on:
 *
 * 1. **NO CODE CARRIED BY THE INSPECTED VALUE IS INVOKED HERE.** No getter, no
 *    setter, no `Proxy` trap, no `@@toPrimitive`, no `toString`. Three
 *    mechanisms, all necessary:
 *    - values come from property DESCRIPTORS, never from a property read, so a
 *      getter is refused rather than run;
 *    - a `Proxy` is refused by {@link isProxyValue} BEFORE any reflective
 *      operation reaches it. **Portable JavaScript cannot do this**: every
 *      reflective operation on a `Proxy` runs a trap, so a portable check
 *      already IS the thing it is trying to avoid. `node:util`'s `types.isProxy`
 *      is a V8-level type predicate that consults no trap, and this package may
 *      import it (see {@link isProxyValue});
 *    - properties of the materialized tree are created with
 *      `Object.defineProperty` — `CreateDataProperty` semantics — so no
 *      INHERITED setter runs either. Round 5's first BLOCKER was exactly this:
 *      `out[key] = value` for `key = "__proto__"` invoked
 *      `Object.prototype.__proto__`'s setter, which set the emitted object's
 *      prototype instead of creating a field on it.
 *
 *    What proposition 1 does NOT cover, stated so it is not another absolute:
 *    it assumes the intrinsics are genuine — that `Object`, `Reflect`,
 *    `Array.prototype` and `util.types` have not been replaced process-wide. A
 *    process in which they have been replaced has already lost, and no boundary
 *    inside it can help. It is a different threat model from "a caller handed us
 *    a hostile value", which is the one this module answers.
 *
 * 2. **TOTALITY IS UNCONDITIONAL.** Nothing here throws, for any input,
 *    whatever proposition 1 assumes. Every reflective operation is wrapped and
 *    turns into a refusal at a named path; refusal text is built with
 *    {@link describeValue}, which never coerces a caller-derived value; and the
 *    public entry points of this package carry an outer containment guard, so a
 *    contract that promises a typed result keeps it even if an assumption above
 *    is wrong.
 *
 * 3. **THE OUTPUT IS PLAIN OWN FROZEN DATA, WHATEVER THE INPUT DID.** The value
 *    returned is a fresh tree this module built one `defineProperty` at a time
 *    from primitives it had already classified. It is not the caller's object,
 *    it shares no object with it, and no post-return edit the caller can make —
 *    to a prototype, to a getter, to a trap — reaches it.
 *
 * 4. **AN ABSENT FIELD IS ABSENT** (added in review round 6). The materialized
 *    tree has NO PROTOTYPE, so no read of it — dotted, computed, by a schema, by
 *    anything — can be answered by `Object.prototype`. Proposition 2's totality
 *    assumption was read too widely in round 5: ADDING a property to
 *    `Object.prototype` does not replace an intrinsic, and review round 6 ruled
 *    it in scope. It is a fail-open, not a curiosity — see {@link emptyRecord}
 *    for the measured `zod` transcript in which an inherited optional field is
 *    ADOPTED into the parse output as though the caller had supplied it.
 *
 * 4b. **AND NO PROPERTY THIS MODULE WRITES IS ANSWERED BY A PROTOTYPE EITHER**
 *    (`WP-020-FU1`, executing `WP-200-FU1`'s round-1 GRANT-AND-WIDEN ruling).
 *    Proposition 4 closed the READS. The WRITES had one hole left: this module
 *    accumulated into ordinary arrays with `Array.prototype.push`, which is
 *    `Set`, which consults the prototype chain FOR THE INDEX NAME. Every append
 *    now goes through {@link appendData}, where the measurement, the 23 call
 *    sites, and the reason `defineProperty` is the right primitive are
 *    recorded.
 *
 * 5. **THE VALIDATED VALUE IS THE VALUE THIS MODULE READ** (review round 7).
 *    A schema is asked a QUESTION — is this acceptable? — and its answer is
 *    `success`. Its OUTPUT is a different object, which the library assembles by
 *    assignment on an object it created with `{}`, and round 6 measured two ways
 *    that assembly is not trustworthy under prototype augmentation: it ADOPTS an
 *    inherited field, and an inherited GET-ONLY accessor makes the assignment
 *    fail so a field silently VANISHES. Round 6 answered the second by REFUSING
 *    a parse output smaller than the input, and review round 7 ruled that wrong:
 *    the refusal fired on a valid `CANCEL` whose own input was intact, trapping
 *    it for an artefact of somebody else's output assembly (§6 invariant 13).
 *
 *    So no door reads the library's output any more. Each door validates the
 *    materialized tree and then USES THE MATERIALIZED TREE, which is own data
 *    with no prototype, built here one `defineProperty` at a time. Adoption and
 *    loss both become unreachable rather than detected, and the loss check is
 *    gone with them. What a schema legitimately CONTRIBUTES — a `.default()` —
 *    is applied by {@link withSchemaDefaults} from a table the door declares,
 *    because that value is not the caller's and cannot be taken from the read.
 *    `test/unit/risk/schema-output.test.ts` binds each door's table to its
 *    schema and fails if a schema starts producing a value no table declares.
 *
 * IT REPORTS THE STRINGS IT READ. The read yields an inventory of every string
 * it materialized, with the path and the property names on the way down. The
 * package's ADR-016 §2 identity rules consume that inventory instead of walking
 * again, so IDENTITY VALIDATION performs no traversal of its own and cannot be
 * blind in a different way than the read.
 *
 * (Round 4 wrote that more broadly — "exactly ONE traversal primitive in the
 * emission path". Review round 5 correctly narrowed it: `deepFreeze` in
 * `guards.ts` and the `Object.entries` in `exposure-limits.ts` are also
 * traversals. Both now run only on values this module has already materialized
 * or that a schema has already validated, and `deepFreeze` is descriptor-based
 * for the same reason this module is — but the honest claim is about identity
 * traversal, not about the package.)
 */

import { types } from "node:util";

/**
 * Whether `value` is a `Proxy`, WITHOUT running any of its traps.
 *
 * WHY A NODE BUILT-IN, AND WHY IT IS PERMITTED HERE. There is no portable
 * JavaScript predicate for this. `Object.getPrototypeOf`, `Reflect.ownKeys`,
 * `Object.getOwnPropertyDescriptor`, `Object.isFrozen`, `in`, and every other
 * reflective operation are trapped, so any portable probe hands control to the
 * caller — which is the thing being prevented. `util.types.isProxy` is a
 * V8-level type check (`value->IsProxy()`); it consults no handler, works on a
 * REVOKED proxy, and works on a proxy created in another realm.
 *
 * The import is inside this package's grant and inside the dependency contract:
 * `packages/risk` and `packages/capital-allocator` are both layer 1
 * (`docs/contracts/dependency-direction.md` §2), and layer 1 has no import
 * allowlist — only layer 0 does (§3 F15 binds `packages/decimal` to `decimal.js`
 * and `node:crypto`; the §3 F14 purity rule binds `packages/domain`,
 * `packages/strategies/**`, `packages/ledger` and `packages/simulation`, none of
 * which is either package here). And on the substance rather than the letter: a
 * type predicate is not I/O. It opens no connection, reads no clock, touches no
 * filesystem, consumes no entropy, and is a pure function of its argument, so
 * the package's own "no I/O, no clock, no network, no credential surface"
 * description still holds exactly as written.
 *
 * This reasoning is package-scoped by construction: it turns on which layer the
 * importing package sits in and which §3 rows bind it, so it establishes nothing
 * about any other package's import budget.
 */
function isProxyValue(value: object): boolean {
  return types.isProxy(value);
}

/** Deepest nesting a record may have. A record is data, not a data structure. */
export const MAX_DEPTH = 64;

/**
 * A TOTAL description of a value, for refusal text.
 *
 * NEVER COERCES. Round 5's escape was `String(reported)` on an array `length`
 * a `Proxy` had made a hostile object: `String` invokes `@@toPrimitive`, so
 * building the REFUSAL ran caller code and threw out of the boundary. This
 * helper only ever converts a PRIMITIVE (whose `ToString` is defined by the
 * specification with no method lookup) and describes anything else by its type.
 */
export function describeValue(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "undefined":
      return "undefined";
    case "string":
      return value.length > 64 ? `a ${String(value.length)}-character string` : `"${value}"`;
    case "number":
    case "boolean":
    case "bigint":
      return `${value}`;
    case "symbol":
      return "a symbol";
    case "function":
      return "a function";
    default:
      return "an object";
  }
}

/** One reason a value could not be read as record data, and where it sat. */
export interface PlainDataProblem {
  readonly path: string;
  readonly problem: string;
}

/** One string the read materialized. */
export interface PlainDataString {
  /** Dotted/indexed path from the root, for refusal evidence. */
  readonly path: string;
  /** Property names on the way down, array indices excluded. */
  readonly keys: readonly string[];
  readonly value: string;
}

export type PlainDataRead =
  | {
      readonly ok: true;
      /** A fresh tree of plain objects, arrays and primitives. */
      readonly value: unknown;
      readonly strings: readonly PlainDataString[];
    }
  | { readonly ok: false; readonly problems: readonly PlainDataProblem[] };

interface ReadState {
  readonly problems: PlainDataProblem[];
  readonly strings: PlainDataString[];
  /** Objects on the CURRENT path, so a shared sub-object is not a cycle. */
  readonly ancestors: WeakSet<object>;
}

/**
 * Reads `value` into plain own data, or reports every reason it is not a record.
 *
 * `path` names the root in the problem and string paths (`"record"`).
 *
 * TOTAL. The outer guard is the last line of proposition 2 above: the walk below
 * already wraps every reflective operation, and this catches anything an
 * assumption of ours got wrong, so no caller of this module can receive an
 * exception where the contract promises a result.
 */
export function readPlainData(value: unknown, path: string): PlainDataRead {
  const state: ReadState = { problems: [], strings: [], ancestors: new WeakSet() };
  let read: unknown;
  try {
    read = readInto(value, path, [], 0, state);
  } catch {
    return {
      ok: false,
      problems: [
        {
          path,
          problem:
            "reading it as data failed unexpectedly; a value that cannot be read is refused rather than emitted (fail closed)",
        },
      ],
    };
  }
  if (state.problems.length > 0) return { ok: false, problems: state.problems };
  return { ok: true, value: read, strings: state.strings };
}

function readInto(
  value: unknown,
  path: string,
  keys: readonly string[],
  depth: number,
  state: ReadState,
): unknown {
  if (value === null) return null;
  const kind = typeof value;
  if (kind === "string") {
    appendData(state.strings, { path, keys, value: value as string });
    return value;
  }
  if (kind === "number" || kind === "boolean" || kind === "undefined") return value;
  if (kind !== "object") {
    appendData(state.problems, { path, problem: `a record carries data, not a ${kind}` });
    return undefined;
  }

  const container = value as object;

  // FIRST, BEFORE ANY REFLECTIVE OPERATION. Everything below this line — the
  // prototype read, the key list, every descriptor — is trapped on a `Proxy`,
  // so the check that a value is not one has to come before all of them, and
  // has to be trap-free itself. See {@link isProxyValue}.
  let proxied: boolean;
  try {
    proxied = isProxyValue(container);
  } catch {
    appendData(state.problems, { path, problem: "it could not be classified as data" });
    return undefined;
  }
  if (proxied) {
    appendData(state.problems, {
      path,
      problem:
        "a Proxy: a record is data, and a Proxy is code that answers questions about data — it may answer differently on a second read, omit a property, describe one it does not have, or throw",
    });
    return undefined;
  }

  if (state.ancestors.has(container)) {
    appendData(state.problems, { path, problem: "a cycle: a record is a finite tree of data" });
    return undefined;
  }
  if (depth >= MAX_DEPTH) {
    appendData(state.problems, { path, problem: `nested deeper than ${MAX_DEPTH} levels` });
    return undefined;
  }

  let prototype: unknown;
  try {
    prototype = Object.getPrototypeOf(container);
  } catch {
    appendData(state.problems, { path, problem: "its prototype could not be read" });
    return undefined;
  }

  let isArray: boolean;
  try {
    isArray = Array.isArray(container);
  } catch {
    appendData(state.problems, { path, problem: "it could not be classified as data" });
    return undefined;
  }

  if (prototype !== null && prototype !== (isArray ? Array.prototype : Object.prototype)) {
    appendData(state.problems, {
      path,
      problem:
        "a non-plain prototype: an inherited property is state the record does not own, and freezing the record cannot freeze it",
    });
    return undefined;
  }

  state.ancestors.add(container);
  try {
    return isArray
      ? readArray(container, path, keys, depth, state)
      : readObject(container, path, keys, depth, state);
  } finally {
    state.ancestors.delete(container);
  }
}

/** The own string keys of `container`, or `undefined` if they cannot be read. */
function ownStringKeys(
  container: object,
  path: string,
  state: ReadState,
): readonly string[] | undefined {
  let ownKeys: readonly (string | symbol)[];
  try {
    ownKeys = Reflect.ownKeys(container);
  } catch {
    appendData(state.problems, { path, problem: "its own property names could not be read" });
    return undefined;
  }
  const stringKeys: string[] = [];
  for (const key of ownKeys) {
    if (typeof key === "symbol") {
      appendData(state.problems, {
        path,
        problem: `a symbol-keyed property (${String(key)}) is not record data`,
      });
      continue;
    }
    appendData(stringKeys, key);
  }
  return stringKeys;
}

/**
 * The DATA value of one own property, or `undefined` with a problem recorded.
 *
 * Reads the descriptor rather than the property, so a getter is refused without
 * being invoked. `container` is known not to be a `Proxy` by the time this runs
 * (see {@link readInto}), so the descriptor object comes from the specification
 * rather than from a trap — which is what makes reading `"value" in descriptor`
 * and `descriptor.value` safe: on a trap result, `Object.getOwnPropertyDescriptor`
 * itself runs the caller's getters while normalizing it (round 5).
 */
function ownDataValue(
  container: object,
  key: string,
  path: string,
  state: ReadState,
): { readonly present: boolean; readonly value?: unknown } {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(container, key);
  } catch {
    appendData(state.problems, { path, problem: "its property descriptor could not be read" });
    return { present: false };
  }
  if (descriptor === undefined) return { present: false };
  // `Object.hasOwn`, NOT `"value" in descriptor` (review round 6). The descriptor
  // is a fresh ordinary object, but an ordinary object inherits from
  // `Object.prototype`, and `in` answers for an INHERITED name: with
  // `Object.prototype.value` defined, every ACCESSOR descriptor would have read
  // as a data descriptor and this function would have accepted `undefined` as
  // the field's value instead of refusing the getter. Found by the round-6
  // census, not by a reviewer — see `test/unit/risk/prototype-access.test.ts`.
  if (!Object.hasOwn(descriptor, "value")) {
    appendData(state.problems, {
      path,
      problem:
        "an accessor property: a getter is code, not data — it can throw, can answer differently on a second read, and cannot be frozen",
    });
    return { present: false };
  }
  return { present: true, value: descriptor.value };
}

/**
 * A DATA DESCRIPTOR WITH NO PROTOTYPE (review round 8).
 *
 * WHY THE DESCRIPTOR ITSELF IS A BOUNDARY. `Object.defineProperty(o, k, { value,
 * writable: true, … })` passes an ORDINARY OBJECT LITERAL, and the specification
 * reads a descriptor's fields with `HasProperty` — which walks the prototype
 * chain. So one property on `Object.prototype` changes what every descriptor in
 * this package MEANS, and this round measured the consequence on the round-7
 * tip, with a valid `CANCEL` and nothing else:
 *
 * ```text
 * Object.prototype.get = "1000"            → evaluateIntent THREW
 *                                             (TypeError: Getter must be a function)
 * Object.prototype.get = () => "1000"      → evaluateIntent THREW
 *                                             (Cannot both specify accessors and a value)
 * Object.prototype.set = …                 → the same, both shapes
 * ```
 *
 * THREW, not refused: the containment guard catches the failure and then builds
 * a refusal, and building a refusal defines properties too — so the second
 * attempt threw out of `evaluateIntent` itself. That is round 6's non-negotiable
 * totality claim broken, and a trapped cancel, from a name nothing in the sweep's
 * key material named. The descriptor is therefore built here, with NO PROTOTYPE:
 * an absent field is absent, and no caller can add one.
 *
 * Every property this package defines goes through this function or
 * {@link ownAccessorDescriptor}, so the fix is structural rather than a list of
 * call sites.
 */
export function ownDataDescriptor(value: unknown): PropertyDescriptor {
  const descriptor = Object.create(null) as PropertyDescriptor;
  // Assignment is safe HERE and nowhere else in this module: the target has no
  // prototype, so `Set` cannot find an inherited accessor to invoke.
  descriptor.value = value;
  descriptor.writable = true;
  descriptor.enumerable = true;
  descriptor.configurable = true;
  return descriptor;
}

/**
 * An ACCESSOR DESCRIPTOR WITH NO PROTOTYPE — the mirror of
 * {@link ownDataDescriptor}, for the one place this repository defines an
 * accessor (`schema-arena.ts`'s parse payload).
 *
 * The same measurement applies with the roles swapped: an inherited `value` or
 * `writable` makes an accessor descriptor invalid, and `Object.defineProperty`
 * answers with a `TypeError` rather than a refusal.
 */
export function ownAccessorDescriptor(
  get: () => unknown,
  set: (value: unknown) => void,
): PropertyDescriptor {
  const descriptor = Object.create(null) as PropertyDescriptor;
  descriptor.get = get;
  descriptor.set = set;
  descriptor.enumerable = true;
  descriptor.configurable = true;
  return descriptor;
}

/**
 * Creates `key` on the materialized object as an OWN ENUMERABLE DATA property.
 *
 * `Object.defineProperty`, never `out[key] = value` — review round 5's first
 * BLOCKER. Assignment is `Set`, which consults the prototype chain: for
 * `key = "__proto__"` it finds `Object.prototype`'s accessor and invokes its
 * SETTER, so the value became the emitted object's PROTOTYPE and no own
 * property was created at all. The result reported `plainPrototype: false` and
 * `prototypeFrozen: false`, and adding a field to that prototype after the call
 * returned changed what the "frozen, validated" record reported — bypassing both
 * identity validation and deep immutability at once. `defineProperty` has
 * `CreateDataProperty` semantics: it defines on the object itself and consults
 * no setter, inherited or otherwise.
 *
 * The DESCRIPTOR is built by {@link ownDataDescriptor} rather than written as a
 * literal here, for the reason measured there (review round 8).
 */
function defineDataProperty(out: object, key: string, value: unknown): void {
  Object.defineProperty(out, key, ownDataDescriptor(value));
}

/**
 * Appends to one of THIS MODULE'S OWN arrays, with `CreateDataProperty`
 * semantics. Never `Array.prototype.push` (`WP-020-FU1`).
 *
 * `push` is `Set`, and `Set` at an index the array does not own yet consults
 * the PROTOTYPE CHAIN — for the INDEX NAME. So an inherited get-only accessor
 * at `Object.prototype["0"]` makes the FIRST append to an empty array throw
 * `TypeError: Cannot set property 0 of #<Object> which has only a getter`, and
 * a read-only inherited data property at the same name makes it throw too. It
 * is the same class as everything else in this module's header, one link
 * further down the chain than the reads it already closes, and it is not
 * hypothetical: `WP-200-FU1` measured it through the ledger door, on an HONEST
 * input, at base `761db76` versus its tip:
 *
 * ```text
 * get-only accessor at Object.prototype["0"]       base 761db76   tip 7d5ac34
 *   Ledger.empty("PAPER")                          OK             LedgerConfigurationError
 *   Ledger.rebuild("PAPER", [])                    OK             LedgerConfigurationError
 *   emptyPnlState(valid identity)                  bare TypeError PnlConfigurationError
 * ```
 *
 * Every one of those is this function's absence: `readPlainData`'s outer guard
 * caught the append's `TypeError` and turned an honest call into a refusal. The
 * direction was always fail-closed — nothing was ever admitted or invented —
 * but a door whose AVAILABILITY varies with ambient prototype state has not met
 * ADR-020 §6 either, and `WP-200-FU1`'s review round 1 ruled the whole append
 * surface in scope rather than the one line it had measured. The surface is:
 * `state.strings`, `state.problems`, `stringKeys`, `unfilled`, `copyPlainData`'s
 * `items`, and `readArray`'s output — 23 call sites, all through here.
 *
 * `Object.defineProperty` has `CreateDataProperty` semantics: it defines on the
 * array itself and consults no inherited accessor, and it maintains `length`
 * exactly as `push` would. The descriptor is built by {@link ownDataDescriptor}
 * for the round-8 reason recorded there. (The same fix, and the same reasoning,
 * as `test/unit/ledger/pollution.ts`'s own `appendData` — a harness that was
 * defeated by this class while measuring it.)
 */
function appendData<T>(target: T[], value: T): void {
  Object.defineProperty(target, `${target.length}`, ownDataDescriptor(value));
}

/**
 * The one property NAME a record may not carry, and the measured reason.
 *
 * `defineDataProperty` alone makes `__proto__` an honest own data property, and
 * that closes the prototype-hijack half of round 5's first BLOCKER. But
 * materializing it faithfully then exposed a second problem, found by probing
 * rather than by reading: **`zod`'s `strictObject` is blind to exactly this one
 * key.** Measured against the version this repository pins, with the property
 * created by `defineProperty` so it is genuinely own and enumerable:
 *
 * ```text
 * KEY __proto__:        success=true   parsed output keys = ["a"]   (dropped)
 * KEY constructor:      success=false  Unrecognized key: "constructor"
 * KEY prototype:        success=false  Unrecognized key: "prototype"
 * KEY toString:         success=false  Unrecognized key: "toString"
 * KEY hasOwnProperty:   success=false  Unrecognized key: "hasOwnProperty"
 * KEY valueOf:          success=false  Unrecognized key: "valueOf"
 * KEY __defineGetter__: success=false  Unrecognized key: "__defineGetter__"
 * KEY then / length / name: success=false  Unrecognized key
 * ```
 *
 * So a field under this name is the one field a strict schema in this
 * repository CANNOT refuse and CANNOT report — and this package's whole
 * emission contract is that an unexpected field is refused rather than dropped.
 * A record therefore may not carry the name at all: it is refused HERE, where
 * the refusal is explicit and names the path, rather than left to a validator
 * that silently ignores it.
 *
 * Nothing legitimate is lost. No shape in this repository declares a
 * `__proto__` field; `JSON.parse` is the only ordinary way to produce one, and
 * a payload that does is not a record this package should be emitting.
 */
const FORBIDDEN_KEY = "__proto__";

/**
 * A fresh object with NO PROTOTYPE, for the materialized tree.
 *
 * WHY NOT `{}` (review round 6). An ordinary object literal inherits from
 * `Object.prototype`, so "this record does not carry that field" and "nobody has
 * put that name on `Object.prototype`" became the same question. They are not
 * the same question, and the difference is a FAIL-OPEN. Measured against the
 * pinned `zod`, with `Object.prototype.b` defined non-enumerably:
 *
 * ```text
 * schema = z.strictObject({ a: z.string(), b: z.string().optional() })
 * schema.safeParse({ a: "x" })            → { a: "x", b: "inherited" }   ← ADOPTED
 * schema.safeParse(nullPrototype{a:"x"})  → { a: "x" }
 * ```
 *
 * So a validator handed an ordinary object ADOPTS an inherited value as though
 * the caller had supplied it — an absent `venueEligibility` would arrive as
 * `"ELIGIBLE"` and §9.8 check 4 would pass on a fact nobody supplied. The
 * materialized tree therefore has no prototype at all: absence stays absence,
 * for the schema and for every later read, whatever syntax that read uses.
 *
 * This is also what makes the round-6 BLOCKERs' class closed rather than their
 * three sites patched: an own-property helper fixes a COMPUTED read, and this
 * fixes every DOTTED read of input data as well.
 */
function emptyRecord(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>;
}

/** The own DATA value of `key`, or `undefined`. Never an accessor, never inherited. */
function dataValue(container: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(container, key);
  if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) return undefined;
  return descriptor.value;
}

/**
 * One value a SCHEMA supplies when the caller's field is absent — a `.default()`.
 *
 * `path` is the field's position in the validated tree (`["economics",
 * "riskBuffer"]`), and `value` is what the schema declares. It is the ONLY kind
 * of content a door takes from anywhere but the materialized read, and it comes
 * from the door's own declared table rather than from the library's output —
 * see proposition 5 in the module header, and the measurement below.
 */
export interface SchemaDefault {
  readonly path: readonly string[];
  readonly value: unknown;
}

/** A validated tree with its schema's defaults applied, or the paths it could not fill. */
export type DefaultedData =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly unfilled: readonly string[] };

/**
 * Applies a schema's own DEFAULTS to the materialized tree, in place.
 *
 * WHY THE DEFAULTS ARE NOT TAKEN FROM THE PARSE OUTPUT (review round 7).
 * Proposition 5 says the validated value is the value this module read; a
 * default is the one thing that value cannot contain, because the caller did not
 * supply it. Reading it back off the library's output is exactly what
 * proposition 5 forbids, and the reason is measured, not theoretical — with a
 * get-only `Object.prototype.d` and a schema declaring `d` with a default:
 *
 * ```text
 * z.strictObject({ a: z.string(), d: z.string().default("FLOOR") })
 *   .safeParse(nullPrototype{ a: "x" })
 *     → success: true, own keys of the output: ["a"], output.d === "inherited"
 * ```
 *
 * The default was never assigned (the inherited accessor is get-only), the key
 * is not own, and the READ of it walks the prototype chain to the attacker's
 * value. Round 6's loss check could not see this at all: the field is missing
 * from the INPUT too, so nothing was "lost". Measured consequences at the
 * round-6 tip, with one get-only property on `Object.prototype` and no hostile
 * input whatsoever:
 *
 * ```text
 * "requireVerifiedSettlementForEntries" → §9.8 check 6 SKIPPED: an entry with
 *                                          unverified settlement was APPROVED
 * "requirePositiveNetEdgeForEntries"    → §9.8 check 12 SKIPPED: an entry with
 *                                          a NEGATIVE net edge was APPROVED
 * "maxRunMode"                          → §9.8 check 2 silently gone: a LIVE run
 *                                          mode no longer exceeds the maximum
 * ```
 *
 * So the door declares its defaults and this function applies them to the tree
 * it already owns. `undefined` counts as absent, which is `zod`'s own rule for
 * when a default applies. The value is COPIED per call ({@link copyPlainData}),
 * so two parses never share a mutable object, and it is defined with
 * `CreateDataProperty` semantics like every other property of the tree.
 *
 * FAIL CLOSED: if the container a default belongs to is missing or is not a
 * record, the path is reported as `unfilled` and the door refuses. A successful
 * parse should make that unreachable — every defaulted field in this repository
 * sits under a REQUIRED object — and an unreachable state that arrives anyway is
 * not a state to guess in.
 */
export function withSchemaDefaults(
  read: unknown,
  defaults: readonly SchemaDefault[],
): DefaultedData {
  const unfilled: string[] = [];
  for (const entry of defaults) {
    const target = targetOf(read, entry.path);
    if (target === undefined) {
      appendData(unfilled, entry.path.join("."));
      continue;
    }
    if (dataValue(target.container, target.key) !== undefined) continue;
    defineDataProperty(target.container, target.key, copyPlainData(entry.value, 0));
  }
  if (unfilled.length > 0) return { ok: false, unfilled };
  return { ok: true, value: read };
}

/**
 * The record that would OWN the last name of `path`, with that name.
 *
 * NO ELEMENT ACCESS. The walk carries the pending name instead of indexing
 * `path`, so this module still contains no numeric `element-read` — the census
 * in `test/unit/risk/prototype-access.test.ts` reports zero of them in product
 * code, and the pollution sweep's exclusion of array-index NAMES rests on that
 * being true (`test/unit/risk/inherited-state.test.ts`, `ARRAY_INDEX`).
 */
function targetOf(
  read: unknown,
  path: readonly string[],
): { readonly container: object; readonly key: string } | undefined {
  let current: unknown = read;
  let pending: string | undefined;
  for (const name of path) {
    if (pending !== undefined) {
      if (current === null || typeof current !== "object" || Array.isArray(current)) return undefined;
      current = dataValue(current, pending);
    }
    pending = name;
  }
  if (pending === undefined) return undefined;
  if (current === null || typeof current !== "object" || Array.isArray(current)) return undefined;
  return { container: current, key: pending };
}

/**
 * A fresh, prototype-free, own-DATA copy of a value THIS REPOSITORY declared.
 *
 * Used only for a {@link SchemaDefault}'s value, which is a literal in one of
 * this package's own modules — so this is about aliasing (two parses must not
 * share one mutable array), not about hostility. Arrays stay arrays: a default
 * such as the four required scenario kinds is iterated downstream.
 */
function copyPlainData(value: unknown, depth: number): unknown {
  if (value === null || typeof value !== "object" || depth >= MAX_DEPTH) return value;
  if (Array.isArray(value)) {
    const items: unknown[] = [];
    for (const item of value as readonly unknown[]) {
      appendData(items, copyPlainData(item, depth + 1));
    }
    return items;
  }
  const out = emptyRecord();
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) continue;
    defineDataProperty(out, key, copyPlainData(descriptor.value, depth + 1));
  }
  return out;
}

/**
 * A frozen, prototype-free, own-DATA copy of a refusal's `details`.
 *
 * TOTAL FOR ANY VALUE (review round 6, BLOCKER 3). The refusal constructors
 * used `{ ...details }`, which is an own-only READ but still runs a `Proxy`'s
 * `ownKeys` and `getOwnPropertyDescriptor` traps and invokes any GETTER on the
 * object: `riskRefusal(code, message, proxyDetails)` THREW out of a public
 * export whose entire purpose is to be the way this package says "no".
 *
 * A refusal is EVIDENCE, so nothing is silently dropped: an accessor, an
 * unreadable descriptor and a `__proto__` name are not copied — they are code,
 * a failure and an unvalidatable name respectively — and their COUNT is
 * recorded under `detailsUnreadable`, so the evidence says that it is
 * incomplete rather than pretending it is not.
 */
export function ownDataDetails(details: unknown): Readonly<Record<string, unknown>> {
  const out = emptyRecord();
  if (details === null || typeof details !== "object") {
    if (details !== undefined) {
      defineDataProperty(out, "detailsNotAnObject", describeValue(details));
    }
    return Object.freeze(out);
  }
  let names: readonly string[];
  try {
    names = Object.getOwnPropertyNames(details);
  } catch {
    defineDataProperty(out, "detailsUnreadable", "its own property names could not be read");
    return Object.freeze(out);
  }
  let skipped = 0;
  for (const name of names) {
    if (name === FORBIDDEN_KEY) {
      skipped += 1;
      continue;
    }
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(details, name);
    } catch {
      skipped += 1;
      continue;
    }
    if (descriptor === undefined) continue;
    if (!Object.hasOwn(descriptor, "value")) {
      skipped += 1;
      continue;
    }
    defineDataProperty(out, name, descriptor.value);
  }
  if (skipped > 0) {
    defineDataProperty(
      out,
      "detailsUnreadable",
      `${String(skipped)} propert${skipped === 1 ? "y" : "ies"} of the supplied details are not own data and were not copied`,
    );
  }
  return Object.freeze(out);
}

function readObject(
  container: object,
  path: string,
  keys: readonly string[],
  depth: number,
  state: ReadState,
): unknown {
  const stringKeys = ownStringKeys(container, path, state);
  if (stringKeys === undefined) return undefined;
  const out: Record<string, unknown> = emptyRecord();
  for (const key of stringKeys) {
    const memberPath = `${path}.${key}`;
    if (key === FORBIDDEN_KEY) {
      appendData(state.problems, {
        path: memberPath,
        problem:
          'a "__proto__" property: it is the one property name a strict schema in this repository cannot report as unrecognized, so a field under it could never be validated — and a record whose extra fields cannot be refused is not a record',
      });
      continue;
    }
    const member = ownDataValue(container, key, memberPath, state);
    if (!member.present) continue;
    defineDataProperty(
      out,
      key,
      readInto(member.value, memberPath, [...keys, key], depth + 1, state),
    );
  }
  return out;
}

/** A canonical array index, as a property name (`"0"`, `"12"`, never `"01"`). */
function arrayIndex(key: string): number | undefined {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(key)) return undefined;
  const index = Number(key);
  return Number.isSafeInteger(index) ? index : undefined;
}

/**
 * The reported `length` of an array, read from its DESCRIPTOR.
 *
 * Not `container.length`. A property READ is `Get`, which is trapped, and round
 * 5's escape was exactly that: an array `Proxy` answered `length` with an object
 * whose `@@toPrimitive` threw. A `Proxy` is refused before this point now, so
 * this is defence in depth — but the descriptor read is the correct primitive
 * for the same reason every other read in this module is one, and it costs
 * nothing.
 */
function reportedLength(
  container: object,
  path: string,
  state: ReadState,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(container, "length");
  } catch {
    appendData(state.problems, { path, problem: "its length could not be read" });
    return { ok: false };
  }
  // `Object.hasOwn`, not `in` — same round-6 reason as {@link ownDataValue}.
  if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
    appendData(state.problems, {
      path,
      problem: "its length is not an own data property, so the array is not data",
    });
    return { ok: false };
  }
  return { ok: true, value: descriptor.value };
}

function readArray(
  container: object,
  path: string,
  keys: readonly string[],
  depth: number,
  state: ReadState,
): unknown {
  const stringKeys = ownStringKeys(container, path, state);
  if (stringKeys === undefined) return undefined;

  const members = new Map<number, unknown>();
  let highest = -1;
  for (const key of stringKeys) {
    if (key === "length") continue;
    const index = arrayIndex(key);
    if (index === undefined) {
      appendData(state.problems, {
        path: `${path}.${key}`,
        problem: "a non-index property on an array is not record data",
      });
      continue;
    }
    const memberPath = `${path}[${index}]`;
    const member = ownDataValue(container, key, memberPath, state);
    if (!member.present) continue;
    members.set(index, readInto(member.value, memberPath, keys, depth + 1, state));
    if (index > highest) highest = index;
  }

  // The length is DERIVED from the index properties that are really there, so a
  // hostile `length` cannot drive an allocation or a loop. It is then compared
  // against the reported length: a mismatch means holes, which a record has not.
  const length = highest + 1;
  if (members.size !== length) {
    appendData(state.problems, { path, problem: "a sparse array: a record has no holes" });
    return undefined;
  }
  const reported = reportedLength(container, path, state);
  if (!reported.ok) return undefined;
  if (reported.value !== length) {
    appendData(state.problems, {
      path,
      // `describeValue`, not `String(...)`: the reported length is a
      // caller-derived value, and coercing one to build a refusal is how round
      // 5's exception escaped.
      problem: `its length (${describeValue(reported.value)}) disagrees with the ${String(length)} elements it carries`,
    });
    return undefined;
  }

  const out: unknown[] = [];
  for (let index = 0; index < length; index += 1) appendData(out, members.get(index));
  return out;
}
