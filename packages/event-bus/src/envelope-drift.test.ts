/**
 * Fail-closure on schema drift.
 *
 * `envelope-door.ts` derives its field predicates from the frozen schema's own
 * `_zod.def` at module load. That is only safe while the derivation is
 * EQUIVALENT to what zod runs; where it cannot be, the module must refuse to
 * load rather than serve a weaker predicate. These tests drive that refusal.
 *
 * Technique: the guards run at module-evaluation time, so they are unreachable
 * through the public surface. Each case mocks `@polymarket-bot/domain` BY ITS
 * RESOLVED PATH with a schema-shaped stand-in (plain `{_zod:{def}}` objects —
 * the door reads nothing else), resets the module registry, and asserts the
 * dynamic `import()` of the door REJECTS. The control case proves the mock is
 * actually in effect: an unmodified stand-in still loads and derives the same
 * field keys.
 *
 * `pinnedShape` records what the current schema really contains, so each case
 * doubles as evidence that the guard it drives cannot fire on the pinned schema
 * and therefore changes no accept/refuse verdict today.
 */
import { createRequire } from "node:module";

import { UnknownPayloadEventEnvelopeSchema as real } from "@polymarket-bot/domain";
import { afterEach, describe, expect, it, vi } from "vitest";

const DOMAIN = createRequire(import.meta.url).resolve("@polymarket-bot/domain");
const UNSUPPORTED = /unsupported envelope schema definition/u;

function ownMemberOf(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && Object.hasOwn(value, key)
    ? (value as Record<string, unknown>)[key] : undefined;
}
function definitionOf(schema: unknown): Record<string, unknown> {
  return ownMemberOf(ownMemberOf(schema, "_zod"), "def") as Record<string, unknown>;
}
/** The minimal shape the door reads: `schema._zod.def`. */
function node(def: unknown): unknown {
  return { _zod: { def } };
}

const realDef = definitionOf(real);
const realShape = realDef["shape"] as Record<string, unknown>;

/** The real envelope def with one field's schema swapped out. */
function standIn(key: string, field: unknown): unknown {
  return node({ ...realDef, shape: { ...realShape, [key]: field } });
}

async function importDoorWith(schema: unknown) {
  vi.resetModules();
  vi.doMock(DOMAIN, async () => ({
    ...await vi.importActual<Record<string, unknown>>(DOMAIN),
    UnknownPayloadEventEnvelopeSchema: schema,
  }));
  return import("./envelope-door.js");
}

afterEach(() => {
  vi.doUnmock(DOMAIN);
  vi.resetModules();
});

/** What the pinned schema actually contains, walked the way the door walks it. */
function pinnedShape(): {
  formats: string[]; patternFlags: string[]; coerced: string[];
  optionalWrappersWithChecks: string[]; nonStringEnumEntries: string[];
} {
  const formats = new Set<string>();
  const patternFlags = new Set<string>();
  const coerced: string[] = [];
  const optionalWrappersWithChecks: string[] = [];
  const nonStringEnumEntries: string[] = [];
  const walk = (name: string, field: unknown): void => {
    const def = definitionOf(field);
    const type = ownMemberOf(def, "type");
    if (ownMemberOf(def, "coerce") !== undefined && ownMemberOf(def, "coerce") !== false) coerced.push(name);
    if (type === "optional") {
      const wrapping = ownMemberOf(def, "checks");
      if (wrapping !== undefined && (!Array.isArray(wrapping) || wrapping.length > 0)) {
        optionalWrappersWithChecks.push(name);
      }
      walk(name, ownMemberOf(def, "innerType"));
      return;
    }
    if (type === "enum") {
      const entries = ownMemberOf(def, "entries") as Record<string, unknown>;
      for (const key of Object.keys(entries)) {
        if (typeof entries[key] !== "string") nonStringEnumEntries.push(`${name}.${key}`);
      }
    }
    const checks = ownMemberOf(def, "checks");
    for (const entry of [def, ...(Array.isArray(checks) ? checks.map(definitionOf) : []) as unknown[]]) {
      if (ownMemberOf(entry, "check") !== "string_format") continue;
      formats.add(String(ownMemberOf(entry, "format")));
      const pattern = ownMemberOf(entry, "pattern");
      patternFlags.add(pattern instanceof RegExp ? pattern.flags : "NOT-A-REGEXP");
    }
  };
  for (const key of Object.keys(realShape)) walk(key, realShape[key]);
  return {
    formats: [...formats].sort(), patternFlags: [...patternFlags].sort(),
    coerced, optionalWrappersWithChecks, nonStringEnumEntries,
  };
}

describe("envelope schema drift fails the door closed", () => {
  it("controls for the mock: an unmodified stand-in still loads", async () => {
    const door = await importDoorWith(standIn("eventId", realShape["eventId"]));
    expect([...door.ENVELOPE_FIELD_KEYS]).toEqual(Object.keys(realShape));
    // And the derived predicate still behaves, so the stand-in is a real load.
    expect(door.matchesEnvelopeField("eventId", "12345678-1234-7123-8123-123456789abc")).toBe(true);
    expect(door.matchesEnvelopeField("eventId", "not-a-uuid")).toBe(false);
  });

  it("records that no pinned-schema shape can trip any of these guards", () => {
    // Evidence that every guard below is unreachable for the current schema, so
    // none of them changes an accept/refuse verdict.
    expect(pinnedShape()).toEqual({
      formats: ["datetime", "regex"],
      patternFlags: ["", "u"],
      coerced: [],
      optionalWrappersWithChecks: [],
      nonStringEnumEntries: [],
    });
  });

  // C1 — the `optional` branch returns before reading the wrapper's own checks,
  // so `.optional().refine(…)` would derive from the inner type alone.
  it("refuses a check attached to an optional wrapper", async () => {
    const inner = definitionOf(realShape["connectionId"])["innerType"];
    await expect(importDoorWith(standIn("connectionId", node({
      type: "optional", innerType: inner, checks: [node({ check: "custom" })],
    })))).rejects.toThrow(UNSUPPORTED);
  });

  // C2 — `g`/`y` change what `pattern.test` matches, so stripping them to make a
  // reusable copy is fail-open: a sticky `/abc/y` would accept "xabc".
  it.each(["y", "g", "gu"])("refuses a regex pattern carrying the %s flag", async flags => {
    await expect(importDoorWith(standIn("eventId", node({
      type: "string",
      checks: [node({ check: "string_format", format: "regex", pattern: new RegExp("abc", flags) })],
    })))).rejects.toThrow(UNSUPPORTED);
  });

  it("still derives the same pattern when only inert flags are present", async () => {
    const door = await importDoorWith(standIn("eventId", node({
      type: "string",
      checks: [node({ check: "string_format", format: "regex", pattern: /^[a-z]+$/u })],
    })));
    expect(door.matchesEnvelopeField("eventId", "abc")).toBe(true);
    expect(door.matchesEnvelopeField("eventId", "xabc9")).toBe(false);
  });

  // C3a — the derivation never coerces, so a coercing def would make it stricter
  // than the schema, refusing inputs the schema accepts.
  it.each([["string"], ["number"]])("refuses a coercing %s def", async type => {
    await expect(importDoorWith(standIn("eventId", node({ type, coerce: true }))))
      .rejects.toThrow(UNSUPPORTED);
  });

  it("accepts an explicit coerce:false, which is not coercion", async () => {
    const door = await importDoorWith(standIn("eventId", node({ type: "string", coerce: false })));
    expect(door.matchesEnvelopeField("eventId", "anything")).toBe(true);
    expect(door.matchesEnvelopeField("eventId", 1)).toBe(false);
  });

  // C3b — a numeric TypeScript enum carries reverse-mapping keys whose values
  // are the member NAMES; treating those as members widens the membership test.
  it("refuses enum entries whose values are not all strings", async () => {
    await expect(importDoorWith(standIn("source", node({
      type: "enum", entries: { Polymarket: 0, 0: "Polymarket" },
    })))).rejects.toThrow(UNSUPPORTED);
  });

  // C4 — the allowlist is a list of formats whose `pattern` has been VERIFIED to
  // be the validator zod runs. Everything else fails the load because it has NOT
  // been verified — NOT because it is necessarily replaced. Round 4 corrected an
  // earlier blanket claim that "excluded means replaced", which is false:
  //
  //   - `ipv6` and `cidrv6` DO replace `_zod.check` after
  //     `$ZodStringFormat.init` installed the pattern test, and then never
  //     consult the pattern (zod's source comments `regexes.cidrv6` "not used
  //     for validation"). `base64` replaces it with `isValidBase64`, which does
  //     not consult `regexes.base64` either. For these three the pattern really
  //     is decorative;
  //   - `base64url` replaces it too, but the replacement `isValidBase64URL`
  //     DOES test `regexes.base64url` and then requires a valid base64 decode
  //     as well, so its pattern is consulted and is strictly WEAKER than the
  //     validator — which is exactly why deriving from it would be fail-open;
  //   - `email` ($ZodEmail) adds no replacement at all, so its pattern IS its
  //     validator. It is refused anyway, and deliberately: the pinned schema
  //     uses no `email`, nothing here has verified it in context, and an
  //     unverified format must re-enter the analysis rather than inherit a
  //     permission from a blanket claim.
  //
  // What every row below asserts is therefore the same thing: a format outside
  // the verified allowlist fails the load rather than deriving a predicate.
  it.each(["ipv6", "cidrv6", "base64", "base64url", "email"])(
    "refuses the unverified %s string format rather than deriving from its pattern", async format => {
      await expect(importDoorWith(standIn("eventId", node({
        type: "string",
        checks: [node({ check: "string_format", format, pattern: /^.*$/u })],
      })))).rejects.toThrow(UNSUPPORTED);
    });

  it.each(["regex", "datetime"])("still derives the allowlisted %s format", async format => {
    const door = await importDoorWith(standIn("eventId", node({
      type: "string",
      checks: [node({ check: "string_format", format, pattern: /^ok$/u })],
    })));
    expect(door.matchesEnvelopeField("eventId", "ok")).toBe(true);
    expect(door.matchesEnvelopeField("eventId", "nope")).toBe(false);
  });

  it("refuses a string_format check with no readable format", async () => {
    await expect(importDoorWith(standIn("eventId", node({
      type: "string", checks: [node({ check: "string_format", pattern: /^ok$/u })],
    })))).rejects.toThrow(UNSUPPORTED);
  });
});
