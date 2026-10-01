/**
 * The ADR-017 §3 strict-JSON reading profile, for the artifacts `STORAGE-1`
 * reads on its deletion path: research-tier and pin dataset manifests, pin
 * records, research pointers and the operator's files.
 *
 * ADR-017 §3 states the profile "so a second reader implements the same
 * refusals **deliberately** rather than inheriting whatever its JSON library
 * happens to accept". `JSON.parse` resolves a duplicate key last-wins and
 * replaces an invalid UTF-8 sequence with U+FFFD; under either, a second
 * spelling of a pinned field (`"fidelity"` twice, say) is an undetected
 * override of a checksummed claim, and the TypeScript and Python readers would
 * read the same bytes differently. So, as `parse_strict_json` does in
 * `python/research/compaction/manifest.py`:
 *
 * 1. **UTF-8 bytes only.** Decoded with a fatal decoder: an invalid sequence,
 *    an overlong form or an encoded surrogate is refused. A `\uD800`-style
 *    escape that would leave an unpaired surrogate is refused too, so every
 *    decoded string re-encodes to UTF-8.
 * 2. **RFC 8259 literals only.** `NaN`, `Infinity` and `-Infinity` are not
 *    grammar here, so they are refused by construction.
 * 3. **Unique object keys.** A duplicate key is refused, never resolved.
 *
 * `__proto__` as a member name is refused as well: no artifact this package
 * reads has such a field, and an ordinary object cannot carry it as data.
 *
 * Every refusal is a {@link StrictJsonError}; a caller turns it into its own
 * typed failure (a document that violates the profile is malformed, never
 * best-effort parsed).
 */

/** A document is not in the ADR-017 §3 strict-JSON profile. */
export class StrictJsonError extends Error {
  readonly at: number;

  constructor(message: string, at: number) {
    super(message);
    this.name = "StrictJsonError";
    this.at = at;
  }
}

const FATAL_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

const MAX_DEPTH = 256;

class Parser {
  readonly #text: string;
  #index = 0;

  constructor(text: string) {
    this.#text = text;
  }

  fail(message: string): never {
    throw new StrictJsonError(`not strict JSON (ADR-017 §3): ${message} at character ${String(this.#index)}`, this.#index);
  }

  whitespace(): void {
    while (this.#index < this.#text.length) {
      const code = this.#text.charCodeAt(this.#index);
      if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) this.#index += 1;
      else return;
    }
  }

  document(): unknown {
    this.whitespace();
    const value = this.value(0);
    this.whitespace();
    if (this.#index !== this.#text.length) this.fail("trailing content after the document");
    return value;
  }

  value(depth: number): unknown {
    if (depth > MAX_DEPTH) this.fail("the document nests too deeply");
    const char = this.#text[this.#index];
    switch (char) {
      case "{":
        return this.object(depth);
      case "[":
        return this.array(depth);
      case '"':
        return this.string();
      case "t":
        return this.literal("true", true);
      case "f":
        return this.literal("false", false);
      case "n":
        return this.literal("null", null);
      default:
        if (char === "-" || (char !== undefined && char >= "0" && char <= "9")) return this.number();
        return this.fail(char === undefined ? "unexpected end of the document" : `unexpected character ${JSON.stringify(char)}`);
    }
  }

  literal(word: string, value: unknown): unknown {
    if (this.#text.startsWith(word, this.#index)) {
      this.#index += word.length;
      return value;
    }
    return this.fail("an unknown literal (only true, false and null are JSON)");
  }

  number(): number {
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(this.#text.slice(this.#index));
    if (match === null) return this.fail("a malformed number");
    this.#index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) this.fail("a number outside the finite range");
    return value;
  }

  string(): string {
    // The opening quote.
    this.#index += 1;
    let out = "";
    for (;;) {
      if (this.#index >= this.#text.length) this.fail("an unterminated string");
      const code = this.#text.charCodeAt(this.#index);
      if (code === 0x22) {
        this.#index += 1;
        break;
      }
      if (code < 0x20) this.fail("a control character inside a string");
      if (code !== 0x5c) {
        out += this.#text[this.#index];
        this.#index += 1;
        continue;
      }
      const escape = this.#text[this.#index + 1];
      this.#index += 2;
      switch (escape) {
        case '"':
          out += '"';
          break;
        case "\\":
          out += "\\";
          break;
        case "/":
          out += "/";
          break;
        case "b":
          out += "\b";
          break;
        case "f":
          out += "\f";
          break;
        case "n":
          out += "\n";
          break;
        case "r":
          out += "\r";
          break;
        case "t":
          out += "\t";
          break;
        case "u": {
          const unit = this.hex4();
          if (unit >= 0xd800 && unit <= 0xdbff) {
            if (this.#text[this.#index] !== "\\" || this.#text[this.#index + 1] !== "u") {
              this.fail("an unpaired surrogate escape");
            }
            this.#index += 2;
            const low = this.hex4();
            if (low < 0xdc00 || low > 0xdfff) this.fail("an unpaired surrogate escape");
            out += String.fromCharCode(unit, low);
          } else if (unit >= 0xdc00 && unit <= 0xdfff) {
            this.fail("an unpaired surrogate escape");
          } else {
            out += String.fromCharCode(unit);
          }
          break;
        }
        default:
          this.fail("an invalid escape");
      }
    }
    return out;
  }

  hex4(): number {
    const digits = this.#text.slice(this.#index, this.#index + 4);
    if (!/^[0-9A-Fa-f]{4}$/u.test(digits)) this.fail("a malformed \\u escape");
    this.#index += 4;
    return Number.parseInt(digits, 16);
  }

  array(depth: number): unknown[] {
    this.#index += 1;
    const out: unknown[] = [];
    this.whitespace();
    if (this.#text[this.#index] === "]") {
      this.#index += 1;
      return out;
    }
    for (;;) {
      this.whitespace();
      out.push(this.value(depth + 1));
      this.whitespace();
      const next = this.#text[this.#index];
      this.#index += 1;
      if (next === "]") return out;
      if (next !== ",") this.fail("a missing comma or closing bracket in an array");
    }
  }

  object(depth: number): Record<string, unknown> {
    this.#index += 1;
    const out: Record<string, unknown> = {};
    const seen = new Set<string>();
    this.whitespace();
    if (this.#text[this.#index] === "}") {
      this.#index += 1;
      return out;
    }
    for (;;) {
      this.whitespace();
      if (this.#text[this.#index] !== '"') this.fail("an object key that is not a string");
      const key = this.string();
      if (key === "__proto__") this.fail('the member name "__proto__"');
      if (seen.has(key)) this.fail(`the duplicate key ${JSON.stringify(key)}`);
      seen.add(key);
      this.whitespace();
      if (this.#text[this.#index] !== ":") this.fail("a missing colon after an object key");
      this.#index += 1;
      this.whitespace();
      out[key] = this.value(depth + 1);
      this.whitespace();
      const next = this.#text[this.#index];
      this.#index += 1;
      if (next === "}") return out;
      if (next !== ",") this.fail("a missing comma or closing brace in an object");
    }
  }
}

/** Parse a JSON document from text under the strict profile's grammar rules (2 and 3). */
export function parseStrictJsonText(text: string): unknown {
  return new Parser(text).document();
}

/**
 * Parse a JSON document from its bytes under the full ADR-017 §3 profile:
 * strict UTF-8, RFC 8259 literals, unique keys. Throws {@link StrictJsonError}.
 */
export function parseStrictJsonBytes(bytes: Uint8Array): unknown {
  let text: string;
  try {
    text = FATAL_UTF8.decode(bytes);
  } catch {
    throw new StrictJsonError("not strict JSON (ADR-017 §3): the bytes are not valid UTF-8", 0);
  }
  return parseStrictJsonText(text);
}
