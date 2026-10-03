/**
 * `audit-text.ts` — the escape every audit record's text goes through, and the
 * bound refusal text is cut to (`CONTROL-1b`, follow-up 3c).
 *
 * The characters under test are built from their CODE POINTS, so this file's
 * own source holds none of them raw.
 */

import { describe, expect, it } from "vitest";

import type { ControlAuditRecord } from "@polymarket-bot/observability";

import {
  AUDIT_IDENTIFIER_MAX_TEXT,
  AUDIT_REASON_MAX_TEXT,
  AUDIT_TEXT_ELLIPSIS,
  auditSafeDocument,
  auditSafeRecord,
  boundAuditText,
  escapeAuditText,
} from "./audit-text.js";

const cp = (code: number): string => String.fromCodePoint(code);
const NUL = cp(0);
const ESC = cp(0x1b);
const RLO = cp(0x202e);
const LS = cp(0x2028);
const HIGH = String.fromCharCode(0xd800);
const LOW = String.fromCharCode(0xdc00);
const EMOJI = cp(0x1f600);
const BACKSLASH = "\\";

/** The inverse of {@link escapeAuditText}: every `\u{HEX}` back to its code point. */
function decode(text: string): string {
  return text.replace(/\\u\{([0-9A-F]+)\}/gu, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)));
}

/** A code point a stored audit text must never hold raw. */
const UNSAFE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

/** Deterministic PRNG (mulberry32), so a failure reproduces. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const ALPHABET = ["a", "Z", "é", "中", BACKSLASH, "u", "{", "}", "0", "5", "C", "D", "8", NUL, ESC, RLO, LS, HIGH, LOW, EMOJI, cp(0x7f), cp(0x85), cp(0xad), cp(0xfeff), cp(0xe0041)];

function randomText(next: () => number, maxLength: number): string {
  const length = Math.floor(next() * (maxLength + 1));
  let out = "";
  for (let index = 0; index < length; index += 1) out += ALPHABET[Math.floor(next() * ALPHABET.length)] ?? "a";
  return out;
}

describe("escapeAuditText", () => {
  it("leaves ordinary text byte-identical — letters, emoji, and ordinary backslashes", () => {
    for (const text of ["", "maintenance", "café 中文 " + EMOJI, "C:\\path\\to", "a\\nb", "\\u0041", "\\u{", "u{0}", "{}\\"]) {
      // `\u{` IS rewritten (its backslash), so it is excluded from "ordinary".
      if (text.includes("\\u{")) continue;
      expect(escapeAuditText(text), JSON.stringify(text)).toBe(text);
    }
  });

  it("writes each control, format, separator and lone-surrogate code point as \\u{HEX}", () => {
    const cases: readonly (readonly [number, string])[] = [
      [0x0, "\\u{0}"],
      [0x9, "\\u{9}"],
      [0xa, "\\u{A}"],
      [0x1b, "\\u{1B}"],
      [0x7f, "\\u{7F}"],
      [0x85, "\\u{85}"],
      [0xad, "\\u{AD}"],
      [0x200b, "\\u{200B}"],
      [0x202e, "\\u{202E}"],
      [0x2028, "\\u{2028}"],
      [0x2029, "\\u{2029}"],
      [0xfeff, "\\u{FEFF}"],
      [0xe0041, "\\u{E0041}"],
    ];
    for (const [code, escaped] of cases) expect(escapeAuditText(`x${cp(code)}y`), code.toString(16)).toBe(`x${escaped}y`);
    expect(escapeAuditText(`x${HIGH}y`)).toBe("x\\u{D800}y");
    expect(escapeAuditText(`x${LOW}y`)).toBe("x\\u{DC00}y");
    // A REVERSED pair is two lone surrogates; a real pair is one code point, kept.
    expect(escapeAuditText(`${LOW}${HIGH}`)).toBe("\\u{DC00}\\u{D800}");
    expect(escapeAuditText(`${HIGH}${String.fromCharCode(0xde00)}`)).toBe(cp(0x10200));
  });

  it("is INJECTIVE: a caller who TYPES \\u{0} is not a caller who sent a NUL", () => {
    expect(escapeAuditText(NUL)).toBe("\\u{0}");
    expect(escapeAuditText("\\u{0}")).toBe("\\u{5C}u{0}");
    expect(escapeAuditText(`${BACKSLASH}${NUL}`)).toBe("\\\\u{0}");
    expect(decode(escapeAuditText(`${BACKSLASH}${NUL}`))).toBe(`${BACKSLASH}${NUL}`);
    // Escaping twice is NOT escaping once — which is why the chokepoint does it exactly once.
    expect(escapeAuditText(escapeAuditText(NUL))).not.toBe(escapeAuditText(NUL));
  });

  it("round-trips 5000 seeded strings, and never emits an unsafe code point", () => {
    const next = prng(0xc0_17_1b);
    for (let index = 0; index < 5_000; index += 1) {
      const text = randomText(next, 24);
      const escaped = escapeAuditText(text);
      expect(decode(escaped), JSON.stringify(text)).toBe(text);
      expect(UNSAFE.test(escaped), JSON.stringify(text)).toBe(false);
    }
  });
});

describe("boundAuditText", () => {
  it("returns the text itself when its escaped form fits — exactly at the bound included", () => {
    expect(boundAuditText("a".repeat(256), 256)).toBe("a".repeat(256));
    expect(boundAuditText(`${"a".repeat(251)}${NUL}`, 256)).toBe(`${"a".repeat(251)}${NUL}`);
  });

  it("cuts between code points: a surrogate pair is never split, so a bound never MAKES a lone surrogate", () => {
    const text = `${"a".repeat(254)}${EMOJI}tail`;
    expect(boundAuditText(text, 256)).toBe(`${"a".repeat(254)}${AUDIT_TEXT_ELLIPSIS}`);
    expect(boundAuditText(`${"a".repeat(253)}${EMOJI}tail`, 256)).toBe(`${"a".repeat(253)}${EMOJI}${AUDIT_TEXT_ELLIPSIS}`);
  });

  it("measures the ESCAPED form, and never cuts inside an escape", () => {
    const cut = boundAuditText(NUL.repeat(400), 256);
    expect(cut).toBe(`${NUL.repeat(51)}${AUDIT_TEXT_ELLIPSIS}`);
    expect(escapeAuditText(cut).length).toBe(256);
  });

  it("holds for 5000 seeded strings and bounds: the stored form fits, and is an escaped PREFIX of the input", () => {
    const next = prng(0x1b_0b0);
    for (let index = 0; index < 5_000; index += 1) {
      const text = randomText(next, 30);
      const max = 1 + Math.floor(next() * 40);
      const bounded = boundAuditText(text, max);
      const stored = escapeAuditText(bounded);
      expect(stored.length, `${JSON.stringify(text)} @ ${String(max)}`).toBeLessThanOrEqual(max);
      if (bounded === text) continue;
      expect(bounded.endsWith(AUDIT_TEXT_ELLIPSIS)).toBe(true);
      const prefix = bounded.slice(0, -AUDIT_TEXT_ELLIPSIS.length);
      expect(text.startsWith(prefix), JSON.stringify(text)).toBe(true);
      // The cut is on a code-point boundary of the input.
      expect([...prefix].join("")).toBe([...text].slice(0, [...prefix].length).join(""));
    }
  });

  it("reads no further than the bound: a megabyte costs what the bound costs", () => {
    const huge = "x".repeat(1_048_576);
    expect(boundAuditText(huge, 256)).toBe(`${"x".repeat(255)}${AUDIT_TEXT_ELLIPSIS}`);
  });

  it("refuses a bound below one", () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) expect(() => boundAuditText("x", bad), String(bad)).toThrow(RangeError);
  });
});

describe("auditSafeDocument and auditSafeRecord", () => {
  it("rebuild ORDINARY containers, escape every string and key, and keep booleans and null", () => {
    class Items extends Array<string> {}
    const items = new Items();
    items.push(`k${NUL}`);
    const document = auditSafeDocument({ [`key${RLO}`]: items, flag: true, none: null, nested: { inner: [LS] } });
    expect(document).toEqual({ "key\\u{202E}": ["k\\u{0}"], flag: true, none: null, nested: { inner: ["\\u{2028}"] } });
    const values = document as Record<string, unknown>;
    expect(Object.getPrototypeOf(values["key\\u{202E}"])).toBe(Array.prototype);
  });

  it("keep a `__proto__` key as DATA", () => {
    const parsed = JSON.parse('{"__proto__": "x", "a": "b"}') as Record<string, string>;
    expect(Object.hasOwn(parsed, "__proto__")).toBe(true);
    const document = auditSafeDocument(parsed) as Record<string, unknown>;
    expect(Object.hasOwn(document, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(document)).toBe(Object.prototype);
    expect(Object.keys(document)).toEqual(["__proto__", "a"]);
  });

  it("escape every string field of a record, and pass the closed vocabularies through", () => {
    const raw: ControlAuditRecord = {
      recordId: "01930000-0000-7000-8000-000000000001",
      action: "KILL_SWITCH_ENGAGE",
      outcome: "APPLIED",
      actor: `op${ESC}`,
      actorKind: "HUMAN",
      scope: "MARKET",
      scopeRef: `m${HIGH}`,
      reason: `r${NUL}`,
      priorState: { engaged: "false" },
      resultingState: { reason: `r${NUL}` },
      at: "2026-10-01T00:00:00.000Z",
    };
    expect(auditSafeRecord(raw)).toEqual({
      ...raw,
      actor: "op\\u{1B}",
      scopeRef: "m\\u{D800}",
      reason: "r\\u{0}",
      resultingState: { reason: "r\\u{0}" },
    });
    expect(auditSafeRecord({ ...raw, scopeRef: null }).scopeRef).toBeNull();
  });

  it("cut actor, scopeRef and reason to their §10.6 column domains AFTER escaping, and keep the whole value in the documents", () => {
    const longRef = `m${RLO.repeat(100)}`;
    const reason = NUL.repeat(1_024);
    const raw: ControlAuditRecord = {
      recordId: "01930000-0000-7000-8000-000000000001",
      action: "KILL_SWITCH_ENGAGE",
      outcome: "APPLIED",
      actor: `op${ESC.repeat(100)}`,
      actorKind: "HUMAN",
      scope: "MARKET",
      scopeRef: longRef,
      reason,
      priorState: { engaged: "false", scopeRef: longRef },
      resultingState: { engaged: "true", scopeRef: longRef, reason },
      at: "2026-10-01T00:00:00.000Z",
    };
    const safe = auditSafeRecord(raw);
    expect(AUDIT_IDENTIFIER_MAX_TEXT).toBe(200);
    expect(AUDIT_REASON_MAX_TEXT).toBe(2_000);
    expect(safe.scopeRef?.length).toBeLessThanOrEqual(AUDIT_IDENTIFIER_MAX_TEXT);
    expect(safe.scopeRef?.endsWith(AUDIT_TEXT_ELLIPSIS)).toBe(true);
    expect(safe.actor.length).toBeLessThanOrEqual(AUDIT_IDENTIFIER_MAX_TEXT);
    expect(safe.reason.length).toBeLessThanOrEqual(AUDIT_REASON_MAX_TEXT);
    expect(safe.reason).toBe(`${"\\u{0}".repeat(399)}${AUDIT_TEXT_ELLIPSIS}`);
    // The documents are unbounded jsonb: the WHOLE escaped value is kept there.
    expect((safe.resultingState as Record<string, string>)["scopeRef"]).toBe(escapeAuditText(longRef));
    expect((safe.resultingState as Record<string, string>)["reason"]).toBe(escapeAuditText(reason));
    // Ordinary values the API accepts are never cut.
    const ordinary = { ...raw, actor: "operator-a", scopeRef: "x".repeat(200), reason: "r".repeat(1_024) };
    expect(auditSafeRecord(ordinary)).toMatchObject({ actor: "operator-a", scopeRef: "x".repeat(200), reason: "r".repeat(1_024) });
  });
});
