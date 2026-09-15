/**
 * THE JSON BYTES OF OWN DATA — `JSON.stringify` restated over own data only.
 *
 * CANONICAL HOME (`SER-1`, 2026-09-15). This is the ECMA-262 25.5.2 restatement
 * that `packages/event-bus`'s `encodeWireJson` already was (`d99c2ac`,
 * `WP-060-FU1` review round 4), moved to the package the `GOV-2A` ruling named
 * as the repository's one own-data home (`docs/contracts/dependency-direction.md`
 * §2.1, mirror-collapse subsection). It is reachable only as
 * `@polymarket-bot/risk/plain-json` through this package's `exports` map — a
 * sibling of `./plain-data`, not part of the risk engine's root surface.
 *
 * ## The route this closes
 *
 * `JSON.stringify` resolves `toJSON` through the value's PROTOTYPE CHAIN:
 * `SerializeJSONProperty` performs `GetV(value, "toJSON")` for every value of
 * type Object **or BigInt**. So an inherited `toJSON` — installed on
 * `Object.prototype` or `Array.prototype` by plain assignment OR by a
 * non-enumerable `defineProperty` — replaces the serialized bytes of EVERY
 * object and EVERY array that keeps `Array.prototype`, and one on
 * `BigInt.prototype` (or `Object.prototype`, one link further up) turns the
 * `TypeError` a bigint is owed into accepted substituted bytes: a VERDICT flip,
 * not just a byte change. Six contexts: {`Object.prototype`, `Array.prototype`,
 * `BigInt.prototype`} × {enumerable assignment, non-enumerable `defineProperty`}.
 *
 * Measured at `main` `d6e05bf` and independently reproduced (`SER-0`,
 * `docs/handoffs/SER-0-sweep.md`); the accounting keys this round routes here:
 *
 * ```text
 * ledger/balance.ts     attributionBucketKey   every (account, asset) bucket collapses to ONE
 *                                              key; a cross-account parity breach (A -5
 *                                              unattributed, B +5) is ACCEPTED where clean
 *                                              refuses LEDGER_ATTRIBUTION_PARITY_BROKEN
 * ledger/balance.ts     legKeyOfValidated      all legs under ONE key net to zero, so ANY
 *                                              balanced transaction passes as an exact
 *                                              compensating reversal of ANY target
 * ledger/projections.ts balanceLineKey         every entry lands on one zero-sum line, the
 *                                              zero-drop deletes it: the balance book is EMPTY
 * ledger/projections.ts virtualPositionKey     every instance's positions fold into one line
 * pnl/state.ts          key2 (pnlCompositeKey) schedule-versioned fee buckets and per-program
 *                                              buckets merge; the §9.16 breakdowns come back EMPTY
 * ledger/projections.ts stableStringify        clean for in-type scalars; an out-of-type bigint
 * pnl/serialize.ts        (scalar/key branch)  flips from TypeError to accepted "INJECTED" bytes
 * ```
 *
 * The hijackable container at every site is the array literal the site itself
 * builds — no caller has to supply anything. The precondition is ambient
 * prototype state, which ADR-020 §6 binds a conforming door against ("no
 * refusal, cancel, or permission decision may vary with ambient prototype
 * state"). Shadowing `toJSON` with an own property on each array was rejected
 * at `d99c2ac` for leaving the bigint route open and for being consumer-visible
 * (`readPlainData` refuses a non-index own property on an array).
 *
 * ## What it must reproduce
 *
 * ECMA-262 25.5.2 with no replacer, BYTE FOR BYTE in a clean process, on plain
 * data: `QuoteJSONString` escaping including lone surrogates (the ES2019
 * well-formed rule); `SerializeJSONNumber` (`ToString(Number)` on the primitive —
 * a specification operation with no method lookup; a non-finite number is
 * `null`; `-0` is `0`); own enumerable string keys in ordinary key order
 * (`Object.keys`, which is the `EnumerableOwnProperties` `JSON.stringify` uses:
 * integer-like keys ascending, then insertion order); arrays by their own
 * `length` and own index members (a hole or an `undefined` element is `null`);
 * `undefined` omitted as an object member; and the `indent` gap behaviour of
 * `JSON.stringify(value, null, indent)` exactly — `{\n<indent>"k": v,\n…\n}`, a
 * `": "` separator, and empty containers staying `{}` / `[]`.
 * `test/unit/risk/plain-json.test.ts` asserts the byte-identity differentially
 * over a generated grammar corpus, for every `indent` in {0, 1, 2, 4}, and the
 * six-context invariance with the injected `toJSON` counted (it must run ZERO
 * times).
 *
 * ## Where it deliberately differs from `JSON.stringify` — every difference is a REFUSAL
 *
 * A difference is never a different byte string; it is a typed {@link NotPlainJson}
 * naming the path, so a caller that promised a string either gets the bytes
 * `JSON.stringify` would have produced in a clean process, or a refusal.
 *
 * - **`undefined` at the root** is refused. `JSON.stringify(undefined)` answers
 *   with NO text at all, which a function returning `string` cannot do.
 * - **A function or a symbol value** is refused rather than OMITTED. Silently
 *   dropping recorded data is what handoff §8.3 forbids (the choice
 *   `encodeWireJson` made).
 * - **A bigint** is refused with the typed error, never a `TypeError` that first
 *   consulted `Object.prototype.toJSON` through `BigInt.prototype`.
 * - **An accessor property** is refused rather than invoked. Values come from
 *   OWN DATA DESCRIPTORS (`Object.getOwnPropertyDescriptor`), never from a
 *   property read, so a getter is code this module never runs.
 * - **PLAIN CONTAINERS ONLY.** An object whose prototype is neither
 *   `Object.prototype` nor `null` — and is not an array with `Array.prototype`
 *   or `null` — is refused. `JSON.stringify` turns a `Date` into a string via
 *   its `toJSON`, unwraps a `Number`/`String`/`Boolean` wrapper, and turns a
 *   `Map`, a `Set` or a class instance into `{}`, silently, at a value-bearing
 *   site. Failing closed IS the point: this encoder exists so that bytes are a
 *   function of own data alone, and an object whose meaning lives on its
 *   prototype has no own-data meaning to emit.
 * - **Depth.** A container nested at or beyond `maxDepth` is refused
 *   (`MAX_DEPTH` from `./plain-data.ts`, 64, by default; the event-bus passes
 *   16). A cyclic structure therefore terminates at the bound instead of
 *   recursing — a cycle is data with no finite JSON text, so a refusal is the
 *   honest answer. The bound is only a bound while the walk can REACH it: the
 *   walk is recursive (`serializeValue` ↔ `serializeObject`/`serializeArray`,
 *   two frames per level), so a `maxDepth` the JS stack cannot honour would
 *   let a deep chain or a cycle escape as an untyped `RangeError: Maximum call
 *   stack size exceeded` before the typed refusal — the `SER-1` review measured
 *   exactly that with `maxDepth: 100000`. The supported domain therefore has a
 *   CEILING, {@link MAX_PLAIN_JSON_DEPTH} (256), refused at option validation.
 *   Measured on Node 24 with the default stack: a chain of 1,000 containers
 *   encodes and 2,000 overflow in the reviewer's harness; ~2,550 is the first
 *   overflow inside this repository's vitest worker. 256 sits at about a
 *   quarter of the shallowest depth measured to encode, and every consumer's
 *   bound is at most `MAX_DEPTH` (64), a quarter of the ceiling again.
 *
 * Two `JSON.stringify` behaviours are KEPT, stated so they are not mistaken for
 * omissions: a non-enumerable own property is not a member (that is
 * `EnumerableOwnProperties`), and an array's non-index own properties are not
 * elements (that is `SerializeJSONArray`). Neither consults a prototype.
 *
 * ## Options are not data
 *
 * The two claims above — byte-identity on plain data, and a typed
 * {@link NotPlainJson} for every difference — are stated WITHIN the supported
 * option domain: `indent` an integer from 0 to 10, `maxDepth` an integer from 1
 * to {@link MAX_PLAIN_JSON_DEPTH}. An option outside its domain is a
 * `RangeError` thrown before any traversal, not a refusal: an option is the
 * caller's own literal, so a wrong one is a programming error, and there is no
 * `path` in the VALUE to name. `JSON.stringify` would have answered an
 * out-of-domain `indent` anyway — it clamps 11 to 10 and truncates 1.5 to 1 —
 * and silently honouring a clamped literal is the kind of quiet substitution
 * this module exists to refuse. `test/unit/risk/plain-json.test.ts` pins both
 * sides of each domain.
 *
 * ## What this module does not claim
 *
 * It does not detect a `Proxy`. The reflective operations it performs
 * (`getPrototypeOf`, `keys`, `getOwnPropertyDescriptor`) run a `Proxy`'s traps,
 * so a `Proxy` handed here yields whatever its traps answer, or throws whatever
 * they throw — exactly as `encodeWireJson` did. `./plain-data.ts`'s
 * `isProxyValue` is the repository's one sanctioned `node:util` binding
 * (`dependency-direction.md` §2.2, per binding) and is private to that module;
 * every consumer of this encoder hands it a container it built itself or a
 * tree `readPlainData`/`readOwnWireValue` already materialized, which is why
 * the residual is stated rather than closed here. As in `plain-data.ts`,
 * proposition 1, the intrinsics are assumed genuine: a process in which
 * `Object.keys` itself has been replaced has already lost.
 */

import { describeValue, MAX_DEPTH, ownDataDescriptor } from "./plain-data.js";

/**
 * Why a value could not be encoded: a CLOSED vocabulary, exported as a frozen
 * list so a consumer can classify a refusal by an own-data read of its `kind`
 * (no `instanceof`, no prototype walk — `packages/event-bus/src/brand.ts`
 * records why that matters at a containment boundary).
 */
export const PLAIN_JSON_REFUSAL_KINDS = Object.freeze([
  "UNDEFINED_ROOT",
  "BIGINT",
  "EXECUTABLE",
  "ACCESSOR",
  "NON_PLAIN",
  "DEPTH",
] as const);

export type PlainJsonRefusalKind = (typeof PLAIN_JSON_REFUSAL_KINDS)[number];

/**
 * The typed refusal: the value at `path` is not plain JSON data.
 *
 * `kind` is the closed classification above; `problem` is the reason in this
 * module's own words (the `{ path, problem }` shape of `plain-data.ts`); the
 * `message` is `"<path>: <problem>"`. The three fields are defined as OWN data
 * properties through `ownDataDescriptor` rather than assigned, so constructing
 * a refusal never runs an inherited setter (`plain-data.ts`, review round 5).
 */
export class NotPlainJson extends Error {
  declare readonly kind: PlainJsonRefusalKind;
  declare readonly path: string;
  declare readonly problem: string;

  constructor(kind: PlainJsonRefusalKind, path: string, problem: string) {
    super(`${path}: ${problem}`);
    // `name` is non-enumerable, as on every built-in error; the descriptor has
    // no prototype, so editing it consults nothing.
    const name = ownDataDescriptor("NotPlainJson");
    name.enumerable = false;
    Object.defineProperty(this, "name", name);
    Object.defineProperty(this, "kind", ownDataDescriptor(kind));
    Object.defineProperty(this, "path", ownDataDescriptor(path));
    Object.defineProperty(this, "problem", ownDataDescriptor(problem));
  }
}

/**
 * The CEILING of the supported `maxDepth` domain (the default stays
 * {@link MAX_DEPTH}, 64). The walk is recursive, two frames per level, so a
 * bound the stack cannot reach is not a bound: the header's Depth entry records
 * the measurement (1,000 levels encode, 2,000 overflow on Node 24's default
 * stack) and why 256 — about a quarter of the shallowest depth measured to
 * encode, four times the deepest bound any consumer passes — is the ceiling.
 * A larger `maxDepth` is a `RangeError` at option validation.
 */
export const MAX_PLAIN_JSON_DEPTH = 256;

/** Options of {@link encodePlainJson}. Domains: see "Options are not data" in the header. */
export interface PlainJsonOptions {
  /**
   * Deepest container nesting accepted; the root container is depth 0. An
   * integer from 1 to {@link MAX_PLAIN_JSON_DEPTH}; default {@link MAX_DEPTH}.
   */
  readonly maxDepth?: number;
  /** `0` (default) is compact; `1`–`10` is the `JSON.stringify(value, null, indent)` gap. */
  readonly indent?: number;
}

/** The largest gap `JSON.stringify` honours; a larger `indent` is clamped there, so it is refused here. */
const MAX_INDENT = 10;

/** The own DATA value of `key` on `options`, or `undefined`. Never inherited, never a getter. */
function ownOption(options: PlainJsonOptions | undefined, key: keyof PlainJsonOptions): unknown {
  if (options === undefined || options === null || typeof options !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(options, key);
  if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) return undefined;
  return descriptor.value;
}

/**
 * The JSON text of `value`, read as own data only.
 *
 * Returns exactly the bytes `JSON.stringify(value, null, indent)` returns in a
 * clean process for plain data, and throws {@link NotPlainJson} for everything
 * the module header lists. Throws a `RangeError` for an option outside its
 * domain (`indent` 0–10, `maxDepth` 1–{@link MAX_PLAIN_JSON_DEPTH}) BEFORE
 * `value` is touched — an option is the caller's own literal, not a value to
 * refuse.
 */
export function encodePlainJson(value: unknown, options?: PlainJsonOptions): string {
  const maxDepthOption = ownOption(options, "maxDepth");
  const indentOption = ownOption(options, "indent");
  const maxDepth = maxDepthOption === undefined ? MAX_DEPTH : maxDepthOption;
  const indent = indentOption === undefined ? 0 : indentOption;
  if (
    typeof maxDepth !== "number" || !Number.isSafeInteger(maxDepth) ||
    maxDepth < 1 || maxDepth > MAX_PLAIN_JSON_DEPTH
  ) {
    throw new RangeError(`encodePlainJson: maxDepth must be an integer from 1 to ${String(MAX_PLAIN_JSON_DEPTH)}`);
  }
  if (typeof indent !== "number" || !Number.isSafeInteger(indent) || indent < 0 || indent > MAX_INDENT) {
    throw new RangeError(`encodePlainJson: indent must be an integer from 0 to ${String(MAX_INDENT)}`);
  }
  const gap = " ".repeat(indent);
  const encoded = serializeValue(value, "value", 0, maxDepth, gap, "");
  if (encoded === undefined) {
    throw new NotPlainJson(
      "UNDEFINED_ROOT",
      "value",
      "undefined has no JSON text: JSON.stringify answers with no string at all, which a function returning a string cannot",
    );
  }
  return encoded;
}

/** `\uXXXX`, lowercase, as `UnicodeEscape` specifies. */
function unicodeEscape(code: number): string {
  return `\\u${code.toString(16).padStart(4, "0")}`;
}

/**
 * `QuoteJSONString` (ECMA-262 25.5.2.2), for keys and string values alike.
 *
 * A well-formed surrogate PAIR is one code point and is emitted raw; a LONE
 * surrogate is escaped (the ES2019 well-formed-`JSON.stringify` rule). Runs of
 * unescaped code units are copied with one `slice`, so the common case does no
 * per-character concatenation.
 */
function quoteJsonString(value: string): string {
  let out = "\"";
  let plainFrom = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    let escape: string;
    if (code === 0x22) escape = "\\\"";
    else if (code === 0x5c) escape = "\\\\";
    else if (code === 0x08) escape = "\\b";
    else if (code === 0x09) escape = "\\t";
    else if (code === 0x0a) escape = "\\n";
    else if (code === 0x0c) escape = "\\f";
    else if (code === 0x0d) escape = "\\r";
    else if (code < 0x20) escape = unicodeEscape(code);
    else if (code >= 0xd800 && code <= 0xdfff) {
      if (code <= 0xdbff && index + 1 < value.length) {
        const trailing = value.charCodeAt(index + 1);
        if (trailing >= 0xdc00 && trailing <= 0xdfff) {
          index += 1;
          continue;
        }
      }
      escape = unicodeEscape(code);
    } else continue;
    out += value.slice(plainFrom, index) + escape;
    plainFrom = index + 1;
  }
  return `${out}${value.slice(plainFrom)}"`;
}

/** The own DATA value of one property, or absence. Never invokes an accessor. */
function ownMember(
  container: object,
  key: string,
  path: string,
): { readonly present: boolean; readonly value: unknown } {
  const descriptor = Object.getOwnPropertyDescriptor(container, key);
  if (descriptor === undefined) {
    return { present: false, value: undefined };
  }
  // `Object.hasOwn`, NOT `"value" in descriptor` — the descriptor is an ordinary
  // object, and `in` answers for an inherited `Object.prototype.value`
  // (`plain-data.ts`, review round 6).
  if (!Object.hasOwn(descriptor, "value")) {
    throw new NotPlainJson(
      "ACCESSOR",
      path,
      "an accessor property: a getter is code, not data — JSON.stringify would invoke it, and this encoder reads own data only",
    );
  }
  return { present: true, value: descriptor.value };
}

/**
 * `SerializeJSONProperty`: the text of one value, or `undefined` for "no text".
 *
 * `indentation` is the specification's `state.indent` — the gap repeated once
 * per enclosing container — carried as a parameter rather than mutable state.
 */
function serializeValue(
  value: unknown,
  path: string,
  depth: number,
  maxDepth: number,
  gap: string,
  indentation: string,
): string | undefined {
  if (value === null) return "null";
  switch (typeof value) {
    case "undefined":
      return undefined;
    case "boolean":
      return value ? "true" : "false";
    case "number":
      // `String(number)` is `Number::toString`, a specification operation on the
      // primitive — no method lookup, so no prototype is consulted. A non-finite
      // number is `null`, exactly as `SerializeJSONNumber` says; `-0` is `"0"`.
      return Number.isFinite(value) ? String(value) : "null";
    case "string":
      return quoteJsonString(value);
    case "bigint":
      // `JSON.stringify` reaches a `TypeError` here too, but only AFTER consulting
      // `BigInt.prototype` → `Object.prototype` for `toJSON`.
      throw new NotPlainJson("BIGINT", path, "a bigint has no JSON representation");
    case "object":
      break;
    default:
      // `JSON.stringify` OMITS a function or a symbol (no text for a member, a
      // `null` element in an array). Dropping data silently is what §8.3
      // forbids, so this is a refusal rather than the omission.
      throw new NotPlainJson(
        "EXECUTABLE",
        path,
        `${describeValue(value)} is code, not data: JSON.stringify would drop it silently, and dropped data is refused instead`,
      );
  }
  if (depth >= maxDepth) {
    throw new NotPlainJson("DEPTH", path, `nested deeper than ${String(maxDepth)} levels`);
  }
  const container = value as object;
  const array = Array.isArray(container);
  const prototype: unknown = Object.getPrototypeOf(container);
  if (prototype !== null && prototype !== (array ? Array.prototype : Object.prototype)) {
    throw new NotPlainJson(
      "NON_PLAIN",
      path,
      "a non-plain container: its prototype is neither Object.prototype nor null, so its meaning lives on the prototype (a Date, a Map, a class instance, a wrapper object) and JSON.stringify would emit a method's answer or `{}` rather than its data",
    );
  }
  return array
    ? serializeArray(container, path, depth, maxDepth, gap, indentation)
    : serializeObject(container, path, depth, maxDepth, gap, indentation);
}

/** `SerializeJSONObject`: own enumerable string keys in order; `undefined` omitted. */
function serializeObject(
  container: object,
  path: string,
  depth: number,
  maxDepth: number,
  gap: string,
  stepback: string,
): string {
  const indentation = stepback + gap;
  let out = "";
  let members = 0;
  for (const key of Object.keys(container)) {
    const memberPath = `${path}.${key}`;
    const member = ownMember(container, key, memberPath);
    if (!member.present) continue;
    const encoded = serializeValue(member.value, memberPath, depth + 1, maxDepth, gap, indentation);
    if (encoded === undefined) continue;
    if (members > 0) out += gap === "" ? "," : `,\n${indentation}`;
    out += `${quoteJsonString(key)}:${gap === "" ? "" : " "}${encoded}`;
    members += 1;
  }
  if (members === 0) return "{}";
  return gap === "" ? `{${out}}` : `{\n${indentation}${out}\n${stepback}}`;
}

/** `SerializeJSONArray`: `length` elements; a hole or `undefined` is `null`. */
function serializeArray(
  container: object,
  path: string,
  depth: number,
  maxDepth: number,
  gap: string,
  stepback: string,
): string {
  const indentation = stepback + gap;
  const length = ownMember(container, "length", `${path}.length`).value as number;
  let out = "";
  for (let index = 0; index < length; index += 1) {
    const memberPath = `${path}[${String(index)}]`;
    const member = ownMember(container, String(index), memberPath);
    const encoded = member.present
      ? serializeValue(member.value, memberPath, depth + 1, maxDepth, gap, indentation)
      : undefined;
    if (index > 0) out += gap === "" ? "," : `,\n${indentation}`;
    out += encoded ?? "null";
  }
  if (length === 0) return "[]";
  return gap === "" ? `[${out}]` : `[\n${indentation}${out}\n${stepback}]`;
}
