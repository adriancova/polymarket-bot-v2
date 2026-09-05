/**
 * The ADR-017 §3 strict-JSON reading profile, implemented deliberately.
 *
 * ADR-017 §3 states the profile "so a second reader implements the same
 * refusals **deliberately** rather than inheriting whatever its JSON library
 * happens to accept". This module is that second reader:
 *
 * 1. **UTF-8 bytes only.** The document is decoded by {@link decodeUtf8Strict},
 *    which refuses overlong encodings, truncated sequences, surrogate code
 *    points encoded as UTF-8, and scalar values above `U+10FFFF`. A JSON
 *    `\uD800` escape that would produce an unpaired surrogate is refused too, so
 *    the decoded string always re-encodes to the bytes it came from.
 * 2. **RFC 8259 literals only.** `NaN`, `Infinity` and `-Infinity` are not
 *    grammar here, so they are refused by construction rather than by a flag.
 * 3. **Unique object keys.** A duplicate key is refused, never resolved
 *    last-wins: under last-wins a second spelling of a pinned field is an
 *    undetected override of a checksummed claim.
 *
 * It is ALSO the D1 materializer for this door: the parser builds objects with
 * `Object.create(null)` and `Object.defineProperty` as it goes, so there is no
 * intermediate `JSON.parse` result whose `__proto__` key or inherited members
 * could reach anything. `__proto__` as a member NAME is refused — the one name
 * a faithful prototype-free copy cannot carry without changing meaning.
 *
 * Numbers are returned as JavaScript numbers ONLY when they are safe integers or
 * exactly representable; a number that is not is returned as a
 * {@link JsonBigNumber} carrying its verbatim lexeme, so an economic value can
 * never silently become a float. No economic value in this repository is a JSON
 * number, and this is what makes that checkable rather than assumed.
 */

import { ownDataDescriptor } from "./refusals.js";

/** A JSON number whose lexeme is preserved because a `number` would lose it. */
export interface JsonBigNumber {
  readonly kind: "json-number";
  readonly lexeme: string;
}

/** One reason a document is not in the profile. */
export interface StrictJsonProblem {
  readonly at: number;
  readonly problem: string;
}

export type StrictJsonOutcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly problem: StrictJsonProblem };

function problem(at: number, message: string): StrictJsonOutcome {
  return { ok: false, problem: { at, problem: message } };
}

// ---------------------------------------------------------------------------
// UTF-8
// ---------------------------------------------------------------------------

/**
 * Decodes UTF-8 bytes into a string, refusing every sequence a strict decoder
 * must refuse. Hand-written so the refusals are the contract's, not a host
 * decoder's defaults.
 */
export function decodeUtf8Strict(
  bytes: Uint8Array,
): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly at: number } {
  // Total in the ADR-020 §6 sense: a caller that is not holding bytes gets the
  // outcome's `ok: false`, never an exception.
  if (!(bytes instanceof Uint8Array)) return { ok: false, at: 0 };
  let out = "";
  let index = 0;
  while (index < bytes.length) {
    const first = bytes[index] ?? 0;
    if (first < 0x80) {
      out += String.fromCharCode(first);
      index += 1;
      continue;
    }
    let needed: number;
    let codePoint: number;
    let lowerBound: number;
    if (first >= 0xc2 && first <= 0xdf) {
      needed = 1;
      codePoint = first & 0x1f;
      lowerBound = 0x80;
    } else if (first >= 0xe0 && first <= 0xef) {
      needed = 2;
      codePoint = first & 0x0f;
      lowerBound = 0x800;
    } else if (first >= 0xf0 && first <= 0xf4) {
      needed = 3;
      codePoint = first & 0x07;
      lowerBound = 0x10000;
    } else {
      // 0x80..0xC1 (continuation byte or overlong two-byte lead) and 0xF5..0xFF.
      return { ok: false, at: index };
    }
    if (index + needed >= bytes.length) {
      // Truncated sequence: the continuation bytes the lead promised are absent.
      return { ok: false, at: index };
    }
    for (let offset = 1; offset <= needed; offset += 1) {
      const continuation = bytes[index + offset] ?? 0;
      if ((continuation & 0xc0) !== 0x80) return { ok: false, at: index + offset };
      codePoint = (codePoint << 6) | (continuation & 0x3f);
    }
    if (codePoint < lowerBound) return { ok: false, at: index };
    if (codePoint > 0x10ffff) return { ok: false, at: index };
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) return { ok: false, at: index };
    out += String.fromCodePoint(codePoint);
    index += needed + 1;
  }
  return { ok: true, text: out };
}

/**
 * Encodes a string to UTF-8 bytes, refusing an unpaired surrogate.
 *
 * The exact inverse of {@link decodeUtf8Strict}, hand-written for the same
 * reason: a host encoder substitutes `U+FFFD` for an unpaired surrogate, and a
 * substitution inside a checksum verification turns a corrupted record into a
 * merely different one. Used to re-derive a recorded frame's `payloadSha256`
 * from its `payloadUtf8` — the per-record half of §8.4's checksum obligation.
 */
export function encodeUtf8Strict(
  text: string,
): { readonly ok: true; readonly bytes: Uint8Array } | { readonly ok: false; readonly at: number } {
  if (typeof text !== "string") return { ok: false, at: 0 };
  const out: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    let codePoint = unit;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = index + 1 < text.length ? text.charCodeAt(index + 1) : 0;
      if (low < 0xdc00 || low > 0xdfff) return { ok: false, at: index };
      codePoint = (unit - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return { ok: false, at: index };
    }
    if (codePoint < 0x80) {
      out.push(codePoint);
    } else if (codePoint < 0x800) {
      out.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint < 0x10000) {
      out.push(0xe0 | (codePoint >> 12), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f));
    } else {
      out.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }
  return { ok: true, bytes: Uint8Array.from(out) };
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

const WHITESPACE = new Set([0x20, 0x09, 0x0a, 0x0d]);

class Reader {
  #text: string;
  #index = 0;

  constructor(text: string) {
    this.#text = text;
  }

  get index(): number {
    return this.#index;
  }

  atEnd(): boolean {
    return this.#index >= this.#text.length;
  }

  peek(): number {
    return this.#text.charCodeAt(this.#index);
  }

  take(): number {
    const code = this.#text.charCodeAt(this.#index);
    this.#index += 1;
    return code;
  }

  slice(from: number, to: number): string {
    return this.#text.slice(from, to);
  }

  skipWhitespace(): void {
    while (!this.atEnd() && WHITESPACE.has(this.peek())) {
      this.#index += 1;
    }
  }
}

/** Parses UTF-8 bytes under the ADR-017 §3 profile. */
export function parseStrictJsonBytes(bytes: Uint8Array): StrictJsonOutcome {
  if (!(bytes instanceof Uint8Array)) {
    return problem(0, "a strict-JSON document is read from bytes");
  }
  const decoded = decodeUtf8Strict(bytes);
  if (!decoded.ok) {
    return problem(
      decoded.at,
      "the document is not valid UTF-8; ADR-017 §3 item 1 refuses it rather than substituting a replacement character",
    );
  }
  return parseStrictJsonText(decoded.text);
}

/** Parses a decoded string under the ADR-017 §3 profile. */
export function parseStrictJsonText(text: string): StrictJsonOutcome {
  if (typeof text !== "string") {
    return problem(0, "a strict-JSON document is read from text");
  }
  const reader = new Reader(text);
  reader.skipWhitespace();
  const value = parseValue(reader, 0);
  if (!value.ok) return value;
  reader.skipWhitespace();
  if (!reader.atEnd()) {
    return problem(reader.index, "trailing content after the top-level JSON value");
  }
  return value;
}

const MAX_JSON_DEPTH = 64;

function parseValue(reader: Reader, depth: number): StrictJsonOutcome {
  if (depth > MAX_JSON_DEPTH) {
    return problem(reader.index, `nested deeper than ${String(MAX_JSON_DEPTH)} levels`);
  }
  if (reader.atEnd()) return problem(reader.index, "a JSON value was expected");
  const code = reader.peek();
  switch (code) {
    case 0x7b:
      return parseObject(reader, depth);
    case 0x5b:
      return parseArray(reader, depth);
    case 0x22:
      return parseString(reader);
    case 0x74:
      return parseLiteral(reader, "true", true);
    case 0x66:
      return parseLiteral(reader, "false", false);
    case 0x6e:
      return parseLiteral(reader, "null", null);
    default:
      return parseNumber(reader);
  }
}

function parseLiteral(reader: Reader, lexeme: string, value: unknown): StrictJsonOutcome {
  const start = reader.index;
  if (reader.slice(start, start + lexeme.length) !== lexeme) {
    return problem(
      start,
      `only the RFC 8259 literals true, false and null are accepted (ADR-017 §3 item 2)`,
    );
  }
  for (let index = 0; index < lexeme.length; index += 1) reader.take();
  return { ok: true, value };
}

function parseObject(reader: Reader, depth: number): StrictJsonOutcome {
  reader.take(); // `{`
  const out = Object.create(null) as Record<string, unknown>;
  const seen = new Set<string>();
  reader.skipWhitespace();
  if (!reader.atEnd() && reader.peek() === 0x7d) {
    reader.take();
    return { ok: true, value: out };
  }
  for (;;) {
    reader.skipWhitespace();
    if (reader.atEnd() || reader.peek() !== 0x22) {
      return problem(reader.index, "an object member name must be a JSON string");
    }
    const key = parseString(reader);
    if (!key.ok) return key;
    const name = key.value as string;
    if (name === "__proto__") {
      return problem(
        reader.index,
        'a "__proto__" member name is refused: it is the one name a prototype-free copy cannot carry without changing meaning',
      );
    }
    if (seen.has(name)) {
      return problem(
        reader.index,
        `duplicate object key ${JSON.stringify(name)}; ADR-017 §3 item 3 refuses it rather than resolving last-wins`,
      );
    }
    seen.add(name);
    reader.skipWhitespace();
    if (reader.atEnd() || reader.take() !== 0x3a) {
      return problem(reader.index, "an object member needs a ':' between its name and value");
    }
    reader.skipWhitespace();
    const value = parseValue(reader, depth + 1);
    if (!value.ok) return value;
    Object.defineProperty(out, name, ownDataDescriptor(value.value));
    reader.skipWhitespace();
    if (reader.atEnd()) return problem(reader.index, "an object was not closed");
    const next = reader.take();
    if (next === 0x7d) return { ok: true, value: out };
    if (next !== 0x2c) return problem(reader.index, "object members are separated by ','");
  }
}

function parseArray(reader: Reader, depth: number): StrictJsonOutcome {
  reader.take(); // `[`
  const out: unknown[] = [];
  reader.skipWhitespace();
  if (!reader.atEnd() && reader.peek() === 0x5d) {
    reader.take();
    return { ok: true, value: out };
  }
  for (;;) {
    reader.skipWhitespace();
    const value = parseValue(reader, depth + 1);
    if (!value.ok) return value;
    out.push(value.value);
    reader.skipWhitespace();
    if (reader.atEnd()) return problem(reader.index, "an array was not closed");
    const next = reader.take();
    if (next === 0x5d) return { ok: true, value: out };
    if (next !== 0x2c) return problem(reader.index, "array members are separated by ','");
  }
}

function parseString(reader: Reader): StrictJsonOutcome {
  reader.take(); // `"`
  let out = "";
  for (;;) {
    if (reader.atEnd()) return problem(reader.index, "a string was not closed");
    const code = reader.take();
    if (code === 0x22) return { ok: true, value: out };
    if (code === 0x5c) {
      if (reader.atEnd()) return problem(reader.index, "a string escape was not completed");
      const escape = reader.take();
      switch (escape) {
        case 0x22:
          out += '"';
          break;
        case 0x5c:
          out += "\\";
          break;
        case 0x2f:
          out += "/";
          break;
        case 0x62:
          out += "\b";
          break;
        case 0x66:
          out += "\f";
          break;
        case 0x6e:
          out += "\n";
          break;
        case 0x72:
          out += "\r";
          break;
        case 0x74:
          out += "\t";
          break;
        case 0x75: {
          const unit = readHex4(reader);
          if (unit === undefined) {
            return problem(reader.index, "a \\u escape needs four hexadecimal digits");
          }
          if (unit >= 0xdc00 && unit <= 0xdfff) {
            return problem(
              reader.index,
              "a lone low surrogate escape does not re-encode to UTF-8 (ADR-017 §3 item 1)",
            );
          }
          if (unit >= 0xd800 && unit <= 0xdbff) {
            if (reader.atEnd() || reader.take() !== 0x5c || reader.atEnd() || reader.take() !== 0x75) {
              return problem(
                reader.index,
                "an unpaired high surrogate escape does not re-encode to UTF-8 (ADR-017 §3 item 1)",
              );
            }
            const low = readHex4(reader);
            if (low === undefined || low < 0xdc00 || low > 0xdfff) {
              return problem(
                reader.index,
                "a high surrogate escape must be followed by a low surrogate escape",
              );
            }
            out += String.fromCharCode(unit, low);
            break;
          }
          out += String.fromCharCode(unit);
          break;
        }
        default:
          return problem(reader.index, "unrecognised string escape");
      }
      continue;
    }
    if (code < 0x20) {
      return problem(reader.index, "an unescaped control character in a string");
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      // A well-formed surrogate pair from the UTF-8 decoder; keep both units.
      if (reader.atEnd()) return problem(reader.index, "an unpaired surrogate in a string");
      const low = reader.take();
      if (low < 0xdc00 || low > 0xdfff) {
        return problem(reader.index, "an unpaired surrogate in a string");
      }
      out += String.fromCharCode(code, low);
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      return problem(reader.index, "an unpaired surrogate in a string");
    }
    out += String.fromCharCode(code);
  }
}

function readHex4(reader: Reader): number | undefined {
  let value = 0;
  for (let index = 0; index < 4; index += 1) {
    if (reader.atEnd()) return undefined;
    const code = reader.take();
    let digit: number;
    if (code >= 0x30 && code <= 0x39) digit = code - 0x30;
    else if (code >= 0x61 && code <= 0x66) digit = code - 0x61 + 10;
    else if (code >= 0x41 && code <= 0x46) digit = code - 0x41 + 10;
    else return undefined;
    value = value * 16 + digit;
  }
  return value;
}

function parseNumber(reader: Reader): StrictJsonOutcome {
  const start = reader.index;
  if (!reader.atEnd() && reader.peek() === 0x2d) reader.take();
  if (reader.atEnd()) return problem(start, "a JSON number was expected");
  const first = reader.peek();
  if (first === 0x30) {
    reader.take();
  } else if (first >= 0x31 && first <= 0x39) {
    while (!reader.atEnd() && reader.peek() >= 0x30 && reader.peek() <= 0x39) reader.take();
  } else {
    return problem(
      start,
      "a JSON value was expected; NaN, Infinity and -Infinity are not RFC 8259 literals (ADR-017 §3 item 2)",
    );
  }
  if (!reader.atEnd() && reader.peek() === 0x2e) {
    reader.take();
    let digits = 0;
    while (!reader.atEnd() && reader.peek() >= 0x30 && reader.peek() <= 0x39) {
      reader.take();
      digits += 1;
    }
    if (digits === 0) return problem(start, "a fractional part needs at least one digit");
  }
  if (!reader.atEnd() && (reader.peek() === 0x65 || reader.peek() === 0x45)) {
    reader.take();
    if (!reader.atEnd() && (reader.peek() === 0x2b || reader.peek() === 0x2d)) reader.take();
    let digits = 0;
    while (!reader.atEnd() && reader.peek() >= 0x30 && reader.peek() <= 0x39) {
      reader.take();
      digits += 1;
    }
    if (digits === 0) return problem(start, "an exponent needs at least one digit");
  }
  const lexeme = reader.slice(start, reader.index);
  const numeric = Number(lexeme);
  // Accepted as a `number` ONLY when the number round-trips to the document's
  // own lexeme. Anything else (`1.0`, `1e3`, a 20-digit integer) keeps its
  // lexeme, so a value a `number` would change is never silently changed.
  if (Number.isFinite(numeric) && String(numeric) === lexeme) {
    return { ok: true, value: numeric };
  }
  // Round-tripping failed, so a `number` would lose the document's own lexeme.
  const preserved = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(preserved, "kind", ownDataDescriptor("json-number"));
  Object.defineProperty(preserved, "lexeme", ownDataDescriptor(lexeme));
  return { ok: true, value: Object.freeze(preserved) };
}

/** Is this the preserved-lexeme form a non-round-tripping number decodes to? */
export function isJsonBigNumber(value: unknown): value is JsonBigNumber {
  return (
    value !== null &&
    typeof value === "object" &&
    Object.hasOwn(value, "kind") &&
    (value as Record<string, unknown>)["kind"] === "json-number"
  );
}
