/**
 * The ADR-017 §3 strict-JSON profile (`STORAGE-1` round 1, J3): the refusals
 * the Python reader's `parse_strict_json` makes, made deliberately.
 */

import { describe, expect, it } from "vitest";

import { StrictJsonError, parseStrictJsonBytes, parseStrictJsonText } from "./strict-json.js";

describe("parseStrictJsonBytes", () => {
  it("reads ordinary JSON exactly as JSON.parse does", () => {
    const text = '{"a":[1,-2.5e3,true,false,null,"x\\u00e9\\ud83d\\ude00\\n"],"b":{"c":{}},"d":[]}';
    expect(parseStrictJsonText(text)).toStrictEqual(JSON.parse(text));
    expect(parseStrictJsonBytes(Buffer.from(" [0] ", "utf8"))).toStrictEqual([0]);
  });

  it.each([
    ['{"a":1,"a":2}', /duplicate key "a"/u],
    ['{"o":{"k":1,"k":1}}', /duplicate key "k"/u],
    ['{"__proto__":{}}', /__proto__/u],
    ["[NaN]", /unexpected character/u],
    ["[Infinity]", /unexpected character/u],
    ["[-Infinity]", /malformed number/u],
    ['["\\ud800"]', /unpaired surrogate/u],
    ['["\\udc00"]', /unpaired surrogate/u],
    ["[1,]", /unexpected character/u],
    ["[01]", /trailing|missing comma/u],
    ['{"a":1}x', /trailing content/u],
    ["﻿{}", /unexpected character/u],
    ['["a\tb"]', /control character/u],
    ["[1e999]", /finite range/u],
  ])("refuses %s", (text, message) => {
    expect(() => parseStrictJsonText(text)).toThrow(StrictJsonError);
    expect(() => parseStrictJsonText(text)).toThrow(message);
  });

  it("refuses bytes that are not UTF-8: a bad continuation, an overlong form, an encoded surrogate", () => {
    for (const bytes of [[0x22, 0xc3, 0x28, 0x22], [0x22, 0xc0, 0xaf, 0x22], [0x22, 0xed, 0xa0, 0x80, 0x22]]) {
      expect(() => parseStrictJsonBytes(Uint8Array.from(bytes))).toThrow(/not valid UTF-8/u);
    }
  });
});
