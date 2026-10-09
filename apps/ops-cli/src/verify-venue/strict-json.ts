/**
 * V2-9 round 7: the strict reader every file of the venue fixture tree goes
 * through (`tree-scan.ts`, and `fixtures.ts` `loadFixture`).
 *
 * The orchestrator's 2026-10-08 ruling: what the scanner cannot parse, decode
 * or normalize fails the gate with a named reason. `readFileSync(…, "utf8")`
 * replaces an invalid byte by U+FFFD, and `JSON.parse` keeps only the last
 * value of a repeated key, so both lose what the committed bytes hold before
 * any rule reads them (V2-9-R7-02). This reader loses nothing:
 *
 * - the bytes decode as UTF-8 with `fatal: true`; a byte-order mark is kept,
 *   so the parser refuses it as a character outside the grammar;
 * - the text parses by RFC 8259 exactly (no comment, no trailing comma, no
 *   other whitespace than space, tab, line feed and carriage return);
 * - an object that repeats a key is refused, by name and path;
 * - a string that is not well-formed Unicode (a lone surrogate, which a
 *   `\uD800` escape can write) is refused, since no normalization reads it.
 *
 * No import: `fixtures.ts`, `captures.ts` and `tree-scan.ts` may all use it.
 */

/** A JSON value as this reader returns it. */
export type StrictJson =
  | null
  | boolean
  | number
  | string
  | StrictJson[]
  | { [key: string]: StrictJson };

/** Why a text is not one strict JSON document (named, never skipped). */
export class StrictJsonError extends Error {
  /**
   * `syntax`: not JSON; `duplicate-key`: an object repeats a key;
   * `ill-formed-string`: a string is not well-formed Unicode.
   */
  readonly kind: "syntax" | "duplicate-key" | "ill-formed-string";

  constructor(kind: StrictJsonError["kind"], message: string) {
    super(message);
    this.name = "StrictJsonError";
    this.kind = kind;
  }
}

/** The JSON path of an object member: `.key`, or `["key"]` when it is not an identifier. */
export function memberPath(path: string, key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

/** A lone surrogate: a high one not followed by a low one, or a low one not preceded by a high one. */
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Whether a string is well-formed Unicode (ES2024 `isWellFormed`, which ES2023's lib lacks). */
export function isWellFormedUnicode(text: string): boolean {
  return !LONE_SURROGATE_RE.test(text);
}

const WHITESPACE = new Set([" ", "\t", "\n", "\r"]);
const NUMBER_RE = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

/**
 * Parses one strict JSON document (RFC 8259), refusing a repeated key and an
 * ill-formed string. Throws `StrictJsonError` with the path of the failure.
 */
export function parseStrictJson(text: string): StrictJson {
  let index = 0;
  const fail = (kind: StrictJsonError["kind"], message: string): never => {
    throw new StrictJsonError(kind, message);
  };
  const skipWhitespace = (): void => {
    while (index < text.length && WHITESPACE.has(text[index] as string)) {
      index += 1;
    }
  };
  const syntax = (expected: string): never =>
    fail(
      "syntax",
      index >= text.length
        ? `expected ${expected} at the end of the text`
        : `expected ${expected} at offset ${index}, found ${JSON.stringify(text[index])}`,
    );
  const parseString = (path: string): string => {
    // The caller has seen the opening quote.
    index += 1;
    let value = "";
    for (;;) {
      if (index >= text.length) {
        syntax("a closing quote");
      }
      const char = text[index] as string;
      if (char === '"') {
        index += 1;
        break;
      }
      if (char.charCodeAt(0) < 0x20) {
        fail("syntax", `an unescaped control character in a string at offset ${index} (${path})`);
      }
      if (char !== "\\") {
        value += char;
        index += 1;
        continue;
      }
      const escape = text[index + 1];
      if (escape === "u") {
        const hex = text.slice(index + 2, index + 6);
        if (!/^[0-9A-Fa-f]{4}$/.test(hex)) {
          fail("syntax", `a \\u escape without four hex digits at offset ${index} (${path})`);
        }
        value += String.fromCharCode(Number.parseInt(hex, 16));
        index += 6;
        continue;
      }
      const decoded = escape === undefined ? undefined : ESCAPES[escape];
      if (decoded === undefined) {
        fail("syntax", `an invalid escape at offset ${index} (${path})`);
      }
      value += decoded;
      index += 2;
    }
    if (!isWellFormedUnicode(value)) {
      fail(
        "ill-formed-string",
        `${path}: a string that is not well-formed Unicode (a lone surrogate), which no reading can normalize`,
      );
    }
    return value;
  };
  const parseValue = (path: string): StrictJson => {
    skipWhitespace();
    const char = text[index];
    if (char === "{") {
      index += 1;
      const object: { [key: string]: StrictJson } = {};
      const seen = new Set<string>();
      skipWhitespace();
      if (text[index] === "}") {
        index += 1;
        return object;
      }
      for (;;) {
        skipWhitespace();
        if (text[index] !== '"') {
          syntax("a key string");
        }
        const key = parseString(`${path} key`);
        if (seen.has(key)) {
          fail(
            "duplicate-key",
            `${memberPath(path, key)}: the key ${JSON.stringify(key)} occurs twice in one object; a lenient parse keeps only the last value, so an earlier one would escape every rule`,
          );
        }
        seen.add(key);
        skipWhitespace();
        if (text[index] !== ":") {
          syntax('":"');
        }
        index += 1;
        // `defineProperty`, so a key such as `__proto__` is an own member.
        Object.defineProperty(object, key, {
          value: parseValue(memberPath(path, key)),
          enumerable: true,
          writable: true,
          configurable: true,
        });
        skipWhitespace();
        if (text[index] === ",") {
          index += 1;
          continue;
        }
        if (text[index] === "}") {
          index += 1;
          return object;
        }
        syntax('"," or "}"');
      }
    }
    if (char === "[") {
      index += 1;
      const array: StrictJson[] = [];
      skipWhitespace();
      if (text[index] === "]") {
        index += 1;
        return array;
      }
      for (;;) {
        array.push(parseValue(`${path}[${array.length}]`));
        skipWhitespace();
        if (text[index] === ",") {
          index += 1;
          continue;
        }
        if (text[index] === "]") {
          index += 1;
          return array;
        }
        syntax('"," or "]"');
      }
    }
    if (char === '"') {
      return parseString(path);
    }
    for (const [literal, value] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (text.startsWith(literal, index)) {
        index += literal.length;
        return value;
      }
    }
    NUMBER_RE.lastIndex = index;
    const number = NUMBER_RE.exec(text);
    if (number === null) {
      return syntax("a JSON value");
    }
    index += number[0].length;
    return Number(number[0]);
  };
  const value = parseValue("$");
  skipWhitespace();
  if (index < text.length) {
    syntax("the end of the document");
  }
  return value;
}

/**
 * Decodes bytes as UTF-8, strictly: an invalid sequence throws, and a
 * byte-order mark is kept (the parser then refuses it).
 */
export function decodeStrictUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}

/** One document of a strictly read file: the whole file, or one `.jsonl` line. */
export interface StrictDocument {
  /** The document's root path: `$`, or `$[n]` for line `n + 1` of a `.jsonl` file. */
  readonly path: string;
  readonly value: StrictJson;
}

/** A file read strictly: its documents, or why it cannot be read. */
export type StrictFile =
  | { readonly ok: true; readonly documents: readonly StrictDocument[] }
  | { readonly ok: false; readonly reason: string };

/**
 * Reads a fixture file's bytes strictly: UTF-8 with `fatal`, then one strict
 * JSON document, or, for a `.jsonl` file, one strict JSON document per line
 * (a final line feed allowed, no empty line). Never throws.
 */
export function readStrictJsonFile(relativePath: string, bytes: Uint8Array): StrictFile {
  let text: string;
  try {
    text = decodeStrictUtf8(bytes);
  } catch {
    return {
      ok: false,
      reason: "not valid UTF-8, so the scanner cannot decode it and the gate fails closed (round 7)",
    };
  }
  const parse = (documentText: string, path: string): StrictDocument => {
    try {
      return { path, value: parseStrictJson(documentText) };
    } catch (error: unknown) {
      if (error instanceof StrictJsonError) {
        // A located message names its path from the document root (`$…`);
        // a syntax message gains the document's own path.
        throw new StrictJsonError(
          error.kind,
          error.message.startsWith("$") ? `${path}${error.message.slice(1)}` : `${path}: ${error.message}`,
        );
      }
      throw error;
    }
  };
  try {
    if (!relativePath.endsWith(".jsonl")) {
      return { ok: true, documents: [parse(text, "$")] };
    }
    const lines = text.split("\n");
    if (lines.at(-1) === "") {
      lines.pop();
    }
    return { ok: true, documents: lines.map((line, index) => parse(line, `$[${index}]`)) };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      reason: `not strict JSON${relativePath.endsWith(".jsonl") ? " lines" : ""} (${message}), so the scanner cannot read it and the gate fails closed (round 7)`,
    };
  }
}
