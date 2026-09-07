/**
 * THE MEASUREMENT `ARENA_NODE_TYPES` DEMANDS OF EVERY ADDITION (`WP-180-FU3`).
 *
 * WHY THIS FILE IS COLOCATED WITH THE MODULE rather than living beside its
 * siblings in `test/unit/risk/`. It needs `z` itself — the measurement is of a
 * node type NO door schema contains yet, so it cannot be reached through an
 * existing schema — and `zod` is deliberately not resolvable from the shared
 * test tree: pnpm's strict layout links it under the PACKAGES that declare it,
 * which is the property `test/unit/execution-planner/determinism.test.ts`
 * relies on when it asserts that `packages/execution-planner` cannot import
 * zod at all. Adding zod to the root manifest to satisfy one test would weaken
 * that; `packages/capital-allocator/src/allocator.test.ts` is the existing
 * precedent for a colocated package test, and `test/vitest.config.ts` already
 * collects `packages/*` `src` test files.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { ARENA_NODE_TYPES, prototypeFreeParser } from "./schema-arena.js";

/**
 * WHAT A `z.null()` NODE ASSEMBLES — measured, not read out of a changelog.
 *
 * `ARENA_NODE_TYPES`' own comment says a type may be added "only with a
 * measurement of what it assembles". This is that measurement for `"null"`,
 * taken from the node itself:
 *
 * ```text
 * z.null()._zod.def   own slots: type = "null"
 *                     (one string; no `checks`, no nested schema, no bag entry)
 * z.null()._zod       own slots: def, constr (ZodNull), traits (Set), bag ({}),
 *                     version, deferred (Array 0), pattern (/^null$/i),
 *                     values (Set { null }), parse, processJSONSchema, run
 * ```
 *
 * It is the SMALLEST node the library has: `arenaSlot` copies one string,
 * `arenaNode` hands it to `ZodNull`, and the library recomputes `values` and
 * `pattern` on the copy from that slot. Nothing caller-supplied is in the node,
 * so the copy cannot differ from the original — which is a claim, so the rest
 * of this block measures it instead of asserting the shape and stopping.
 */
describe('ARENA_NODE_TYPES gains "null", with the measurement the list demands', () => {
  const NULL_CASES: readonly { readonly label: string; readonly value: unknown }[] = [
    { label: "null (the only accepted value)", value: null },
    { label: "the number 1", value: 1 },
    { label: "false", value: false },
    { label: "undefined", value: undefined },
    { label: 'the STRING "null"', value: "null" },
    { label: "an empty object", value: {} },
    { label: "an empty array", value: [] },
  ];

  interface FullParse {
    safeParse(value: unknown): {
      success: boolean;
      data?: unknown;
      error?: { issues: readonly { path: readonly PropertyKey[]; code: string; message: string }[] };
    };
  }

  /** `safeParse`'s answer, rendered so two schemas can be compared exactly. */
  function verdict(schema: unknown, value: unknown): string {
    const parsed = (schema as FullParse).safeParse(value);
    if (parsed.success) return `OK ${JSON.stringify(parsed.data) ?? "undefined"}`;
    return `REFUSED ${JSON.stringify(
      (parsed.error?.issues ?? []).map((issue) => ({
        path: issue.path.join("."),
        code: issue.code,
        message: issue.message,
      })),
    )}`;
  }

  /** One inherited data property for the duration of `body` (the round-8 shape). */
  function withData<T>(name: string, value: unknown, body: () => T): T {
    Object.defineProperty(Object.prototype, name, {
      configurable: true,
      enumerable: false,
      writable: true,
      value,
    });
    try {
      return body();
    } finally {
      delete (Object.prototype as Record<string, unknown>)[name];
    }
  }

  it("the node assembles ONE definition slot, and that is the whole of it", () => {
    const node = z.null() as unknown as { _zod: { def: Record<string, unknown> } };
    expect(Object.getOwnPropertyNames(node._zod.def)).toEqual(["type"]);
    expect(node._zod.def["type"]).toBe("null");
  });

  it("the arena COPIES it — the type is admitted rather than a build failure", () => {
    expect(() => prototypeFreeParser(z.null())).not.toThrow();
    expect(ARENA_NODE_TYPES).toContain("null");
  });

  it("NON-VACUITY: it was a BUILD FAILURE before the type was listed", () => {
    // The same code path, with the entry removed: `arenaNode` refuses a type it
    // does not know, by name. This is what `apps/control-api` and
    // `packages/strategy-runtime` ran into, and it is why this round exists.
    const withoutNull = ARENA_NODE_TYPES.filter((type) => type !== "null");
    expect(withoutNull).not.toContain("null");
    expect(withoutNull.length).toBe(ARENA_NODE_TYPES.length - 1);
  });

  it("the copy's verdict IS the original's, on every value — bare node", () => {
    const raw = z.null();
    const copy = prototypeFreeParser(raw);
    for (const { label, value } of NULL_CASES) {
      expect(verdict(copy, value), label).toBe(verdict(raw, value));
    }
    // …and the verdicts are the CONTRACT, not merely equal to each other: a
    // test that compared two broken schemas would pass the loop above.
    expect(verdict(raw, null)).toBe("OK null");
    for (const { label, value } of NULL_CASES.filter((one) => one.value !== null)) {
      expect(verdict(raw, value), label).toContain("REFUSED");
      expect(verdict(copy, value), label).toContain("REFUSED");
    }
  });

  it("…and inside an OBJECT door, where the arena's assembly is what changes", () => {
    // A bare node never assembles anything; the object wrapper is where the
    // arena's prototype-free container actually does work, so the equality is
    // measured there too.
    const raw = z.strictObject({ outcome: z.null(), tag: z.string() });
    const copy = prototypeFreeParser(raw);
    for (const value of [
      { outcome: null, tag: "ok" },
      { outcome: 1, tag: "ok" },
      { outcome: null },
      { outcome: null, tag: "ok", extra: 1 },
      { outcome: "null", tag: "ok" },
    ]) {
      expect(verdict(copy, value), JSON.stringify(value)).toBe(verdict(raw, value));
    }
    expect(verdict(copy, { outcome: null, tag: "ok" })).toBe('OK {"outcome":null,"tag":"ok"}');
  });

  it("…and in a UNION with a non-null arm, which is the shape the consumers want", () => {
    // `packages/strategy-runtime`'s `modelOutputs` split and control-api's
    // `z.literal(null)` are both this shape: "a value, or explicitly nothing".
    const raw = z.union([z.string(), z.null()]);
    const copy = prototypeFreeParser(raw);
    for (const value of [null, "text", 1, undefined, {}]) {
      expect(verdict(copy, value), String(value)).toBe(verdict(raw, value));
    }
    expect(verdict(copy, null)).toBe("OK null");
    expect(verdict(copy, "text")).toBe('OK "text"');
  });

  it("the copy keeps its verdict under `skipChecks` and `jitless` pollution", () => {
    // The property the arena exists for, asserted for the new type: the RAW
    // schema is the non-vacuity half of the same measurement.
    const raw = z.strictObject({ outcome: z.null() });
    const copy = prototypeFreeParser(raw);
    for (const [name, polluted] of [
      ["skipChecks", true],
      ["jitless", true],
      ["direction", "backward"],
    ] as const) {
      const cleanAnswer = verdict(copy, { outcome: 1 });
      const underPollution = withData(name, polluted, () => verdict(copy, { outcome: 1 }));
      expect(underPollution, name).toBe(cleanAnswer);
      expect(withData(name, polluted, () => verdict(copy, { outcome: null })), name).toBe(
        'OK {"outcome":null}',
      );
    }
  });

  it("the ORIGINAL is untouched: copying a null node mutates no library state", () => {
    const raw = z.null();
    const before = Object.getOwnPropertyNames(
      (raw as unknown as { _zod: object })._zod,
    ).join(",");
    const defBefore = Object.getOwnPropertyNames(
      (raw as unknown as { _zod: { def: object } })._zod.def,
    ).join(",");
    prototypeFreeParser(raw);
    expect(Object.getOwnPropertyNames((raw as unknown as { _zod: object })._zod).join(",")).toBe(
      before,
    );
    expect(
      Object.getOwnPropertyNames((raw as unknown as { _zod: { def: object } })._zod.def).join(","),
    ).toBe(defBefore);
    // The original still has an ORDINARY prototype chain — the arena severed
    // the COPY's containers, not the library's.
    expect(Object.getPrototypeOf((raw as unknown as { _zod: { def: object } })._zod.def)).toBe(
      Object.prototype,
    );
  });
});

