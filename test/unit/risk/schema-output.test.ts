/**
 * THE MECHANISM, PART 4 — a schema may not contribute a value nobody declared.
 *
 * WHY THIS EXISTS (review round 7). Every door of both packages now takes its
 * validated data from the tree `readPlainData` MATERIALIZED, and uses the
 * library only for its `success` answer. That is what closed the round-7
 * BLOCKER: round 6 refused any parse output smaller than the input, and the
 * reviewer's probe showed a valid `CANCEL` refused (`lost:
 * ["input.intent.reason"]`) for an artefact of the library's own output
 * assembly, with the caller's `intent.reason` intact the whole time.
 *
 * But "the validated value IS the value we read" is only true while the schema
 * contributes NOTHING OF ITS OWN. A `.default()`, a `.transform()`, a `.pipe()`,
 * a `.catch()` or a `z.coerce` makes the parse output legitimately differ from
 * the input, and a door that ignored the output would then silently drop that
 * contribution. So the property is machine-checked here rather than assumed:
 *
 * - for the four doors that take the read directly (five until C1-RISK deleted
 *   the resize request), every node of the schema
 *   must be NON-PRODUCING. One `.transform()` added anywhere fails this test;
 * - for the two doors whose schemas do declare defaults, the declared default
 *   PATHS AND VALUES must equal the door's own table, which is what
 *   `withSchemaDefaults` applies. Adding a default to a schema without adding it
 *   to the table fails, and so does the reverse.
 *
 * FAIL CLOSED ON THE UNKNOWN. The walk classifies every node by the label
 * `zod` gives it and fails on any label it does not recognize, so a future
 * construct cannot be silently treated as harmless. It reads `_zod.def`, which
 * is internal to the pinned `zod@4.4.3`: if a version bump changes that shape,
 * this test fails loudly instead of passing vacuously — and the non-vacuity
 * tests below would fail first.
 */

import { describe, expect, it } from "vitest";

import {
  ALLOCATOR_CAPS_DEFAULTS,
  AllocatorCapsSchema,
  LIVE_MICRO_CAP_FIELDS,
  LIVE_MICRO_CAP_FLOOR,
} from "../../../packages/capital-allocator/src/caps.js";
import {
  AllocatorStateInputSchema,
  ScopeAttributionSchema,
  createAllocatorState,
} from "../../../packages/capital-allocator/src/state.js";
import { ReservationRequestSchema } from "../../../packages/capital-allocator/src/reserve.js";
import { ApprovedIntentRecordSchema } from "../../../packages/risk/src/approved-intent.js";
import { RiskEvaluationInputSchema } from "../../../packages/risk/src/inputs.js";
import { readPlainData } from "../../../packages/risk/src/plain-data.js";
import { RISK_POLICY_DEFAULTS, RiskPolicySchema } from "../../../packages/risk/src/policy.js";
import { entryInput } from "./fixtures.js";

// ---------------------------------------------------------------------------
// the walk
// ---------------------------------------------------------------------------

/** One node of a schema tree, at the DATA path it governs. */
interface SchemaNode {
  /** `zod`'s own label: `def.type`, or `check:<name>` for a validator. */
  readonly label: string;
  /** Dotted data path (`"scenario.requiredKinds"`), `""` at the root. */
  readonly path: string;
  /** `def.defaultValue` when the node is a `default`. */
  readonly defaultValue?: unknown;
  /** True when the node declares input coercion. */
  readonly coerces: boolean;
}

/** One OWN member of a `zod` internal object, or `undefined`. */
function slot(container: unknown, key: string): unknown {
  if (container === null || typeof container !== "object") return undefined;
  const record = container as Record<string, unknown>;
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/**
 * Every node of a schema tree, by DATA path.
 *
 * TOTAL AND SLOT-BLIND. It does not enumerate `zod`'s child slots by name —
 * `shape`, `innerType`, `element`, `options`, `checks`, `in`, `out` — because a
 * hand-written slot list is the round-4 failure in a different costume: the
 * enumeration primitive becomes the list. It walks EVERY own property of every
 * `def` and descends into anything carrying `_zod`, so a slot this repository
 * has never used is still walked. Only `shape` is special-cased, and only to
 * name the path.
 */
function schemaNodes(schema: unknown): readonly SchemaNode[] {
  const nodes: SchemaNode[] = [];
  const onPath = new WeakSet<object>();
  const visit = (node: unknown, path: string, depth: number): void => {
    if (depth > 64 || node === null || typeof node !== "object") return;
    if (onPath.has(node)) return;
    const zod = slot(node, "_zod");
    if (zod === null || typeof zod !== "object") return;
    const def = slot(zod, "def");
    if (def === null || typeof def !== "object") return;
    const record = def as Record<string, unknown>;
    const label = Object.hasOwn(record, "type")
      ? String(slot(record, "type"))
      : Object.hasOwn(record, "check")
        ? `check:${String(slot(record, "check"))}`
        : "UNLABELLED";
    nodes.push({
      label,
      path,
      ...(Object.hasOwn(record, "defaultValue")
        ? { defaultValue: slot(record, "defaultValue") }
        : {}),
      coerces: slot(record, "coerce") === true,
    });
    onPath.add(node);
    for (const key of Object.getOwnPropertyNames(record)) {
      const child = slot(record, key);
      if (key === "shape" && child !== null && typeof child === "object") {
        for (const name of Object.getOwnPropertyNames(child)) {
          visit(slot(child, name), path === "" ? name : `${path}.${name}`, depth + 1);
        }
        continue;
      }
      if (Array.isArray(child)) {
        for (const item of child) visit(item, path, depth + 1);
      } else if (child !== null && typeof child === "object") {
        visit(child, path, depth + 1);
      }
    }
    onPath.delete(node);
  };
  visit(schema, "", 0);
  return nodes;
}

/**
 * Labels that carry NO value of their own: they describe or constrain data the
 * caller supplied, and the parse output for them is the input.
 *
 * `readonly` is here deliberately: `zod`'s `.readonly()` FREEZES its output, and
 * freezing is not a change of content. Doors take the unfrozen materialized tree
 * and freeze what they emit themselves (`deepFreeze` / `Object.freeze`).
 */
const NON_PRODUCING_LABELS: ReadonlySet<string> = new Set([
  "object",
  "array",
  "record",
  "tuple",
  "union",
  "intersection",
  "optional",
  "nullable",
  "nonoptional",
  "readonly",
  "string",
  "number",
  "boolean",
  "bigint",
  "literal",
  "enum",
  "never",
  "null",
  "undefined",
  "unknown",
  "any",
  "date",
  "check:custom",
  "check:greater_than",
  "check:less_than",
  "check:min_length",
  "check:max_length",
  "check:length_equals",
  "check:string_format",
  "check:multiple_of",
  "check:number_format",
]);

/** Labels that DO contribute a value, and therefore need a declared table. */
const PRODUCING_LABELS: ReadonlySet<string> = new Set([
  "default",
  "prefault",
  "transform",
  "pipe",
  "catch",
  "success",
  "check:overwrite",
]);

function classify(nodes: readonly SchemaNode[]): {
  readonly unknownLabels: readonly string[];
  readonly producing: readonly SchemaNode[];
} {
  const unknownLabels: string[] = [];
  const producing: SchemaNode[] = [];
  for (const node of nodes) {
    if (PRODUCING_LABELS.has(node.label) || node.coerces) {
      producing.push(node);
      continue;
    }
    if (!NON_PRODUCING_LABELS.has(node.label)) unknownLabels.push(`${node.label} at "${node.path}"`);
  }
  return { unknownLabels, producing };
}

// ---------------------------------------------------------------------------
// the doors
// ---------------------------------------------------------------------------

/** The four doors whose validated value IS the materialized read, verbatim. */
const READ_IS_THE_VALUE: readonly { readonly name: string; readonly schema: unknown }[] = [
  { name: "RiskEvaluationInputSchema (validateEvaluationInput / evaluateIntent)", schema: RiskEvaluationInputSchema },
  { name: "ApprovedIntentRecordSchema (sealApprovedIntentRecord)", schema: ApprovedIntentRecordSchema },
  { name: "AllocatorStateInputSchema (createAllocatorState)", schema: AllocatorStateInputSchema },
  { name: "ReservationRequestSchema (evaluateReservation)", schema: ReservationRequestSchema },
];

/** The two doors whose schema contributes defaults, with the table that applies them. */
const DECLARED_DEFAULTS: readonly {
  readonly name: string;
  readonly schema: unknown;
  readonly table: readonly { readonly path: readonly string[]; readonly value: unknown }[];
}[] = [
  { name: "RiskPolicySchema (parseRiskPolicy)", schema: RiskPolicySchema, table: RISK_POLICY_DEFAULTS },
  { name: "AllocatorCapsSchema (parseAllocatorCaps)", schema: AllocatorCapsSchema, table: ALLOCATOR_CAPS_DEFAULTS },
];

describe("THE MECHANISM: a schema contributes nothing a door does not apply", () => {
  it("the walk is non-vacuous: it reaches the leaves of the deepest door schema", () => {
    const nodes = schemaNodes(RiskEvaluationInputSchema);
    expect(nodes.length).toBeGreaterThan(100);
    // named data paths, not just a root node
    expect(nodes.map((node) => node.path)).toContain("context.venueEligibility");
    expect(nodes.map((node) => node.path)).toContain("portfolio.openOrders");
    expect(nodes.some((node) => node.label === "object" && node.path === "")).toBe(true);
  });

  it("the walk SEES a value-producing node when one is added (the check is not a tautology)", () => {
    const withTransform = ScopeAttributionSchema.transform((value) => value);
    const transformed = classify(schemaNodes(withTransform));
    expect(transformed.producing.length + transformed.unknownLabels.length).toBeGreaterThan(0);

    const withDefault = ScopeAttributionSchema.default({});
    const defaulted = classify(schemaNodes(withDefault));
    expect(defaulted.producing.map((node) => node.label)).toContain("default");

    const withCatch = ScopeAttributionSchema.catch({});
    const caught = classify(schemaNodes(withCatch));
    expect(caught.producing.length + caught.unknownLabels.length).toBeGreaterThan(0);
  });

  for (const door of READ_IS_THE_VALUE) {
    it(`${door.name}: every node is non-producing, so the read IS the validated value`, () => {
      const { unknownLabels, producing } = classify(schemaNodes(door.schema));
      expect({ unknownLabels, producing }).toEqual({ unknownLabels: [], producing: [] });
    });
  }

  for (const door of DECLARED_DEFAULTS) {
    it(`${door.name}: the schema's defaults are exactly the door's declared table`, () => {
      const { unknownLabels, producing } = classify(schemaNodes(door.schema));
      expect(unknownLabels).toEqual([]);
      const fromSchema = producing
        .map((node) => ({ label: node.label, path: node.path, value: node.defaultValue }))
        .sort((left, right) => left.path.localeCompare(right.path));
      const fromTable = door.table
        .map((entry) => ({ label: "default", path: entry.path.join("."), value: entry.value }))
        .sort((left, right) => left.path.localeCompare(right.path));
      expect(fromSchema).toEqual(fromTable);
    });
  }

  it("the caps table defaults EXACTLY the two fenced fields, at the AGENTS.md floor", () => {
    // The one table where a wrong value is a weakened safety floor rather than a
    // wrong configuration, so it is bound to `LIVE_MICRO_CAP_FIELDS` as well.
    expect(ALLOCATOR_CAPS_DEFAULTS.map((entry) => entry.path.join("."))).toEqual([
      ...LIVE_MICRO_CAP_FIELDS,
    ]);
    for (const entry of ALLOCATOR_CAPS_DEFAULTS) {
      expect(entry.value).toBe(LIVE_MICRO_CAP_FLOOR);
    }
    expect(LIVE_MICRO_CAP_FLOOR).toBe("0");
  });

  it("MEASURED, not only walked: the parse output equals the materialized read", () => {
    // The walk is a claim about the schema's SHAPE. This is the same claim as a
    // measurement on the fully-passing fixture: what the library returns and what
    // the door uses carry the same data, so replacing one with the other changed
    // no value.
    const read = readPlainData(entryInput(), "input");
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const parsed = RiskEvaluationInputSchema.safeParse(read.value);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).toEqual(read.value);
  });

  it("MEASURED: the allocator state door agrees with its schema too", () => {
    const input = {
      accountEquity: "1000",
      availableCollateral: "1000",
      positions: [],
      openOrders: [],
      liveOwners: [],
    };
    const read = readPlainData(input, "state");
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const parsed = AllocatorStateInputSchema.safeParse(read.value);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).toEqual(read.value);
    // and the door itself accepts it, so the equality is about a LIVE path
    expect(createAllocatorState(input).ok).toBe(true);
  });
});
