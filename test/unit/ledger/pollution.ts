/**
 * The pollution harness the two WP-200-FU1 batteries share.
 *
 * WHY IT EXISTS. `docs/contracts/schema-boundary.md` §2 enumerates nine
 * measured classes and §4 says what a conforming door must state: which of
 * D1-D4 it performs, and **the bound** — under its pollution battery,
 * permission never varies, a refusal is byte-identical, and no throw escapes
 * (ADR-020 §6). "It uses `strictObject`" is not a statement of conformance, and
 * neither is a hand-picked probe. This module is the machinery that makes the
 * claim mechanical: it derives its key material FROM THE INPUTS rather than
 * from a hand-written list, applies every measured shape to every name, and
 * reports every scenario whose answer moved.
 *
 * TWO RULES IT FOLLOWS, both learned the expensive way by `WP-180` and
 * `GOV-2A`:
 *
 * 1. **No assertion runs inside the polluted window.** `expect` builds property
 *    descriptors, and an inherited `get` makes every `Object.defineProperty`
 *    throw (`GOV-2A` probe J4 / `WP-180` R8-1), so a battery that asserts while
 *    polluted measures its own assertion library. Every scenario here collects
 *    a STRING, the prototype is restored in a `finally`, and the comparison
 *    happens afterwards.
 * 2. **An intrinsic is never replaced.** A name that is an OWN property of
 *    `Object.prototype` (`constructor`, `toString`, `valueOf`, …) is dropped
 *    from the material: defining it would clobber the intrinsic and the
 *    `delete` that restores would remove it from the process for good. Names
 *    that are own properties of `Array.prototype` — `values` is the one that
 *    matters here — are KEPT, because an array finds its own prototype's member
 *    first and nothing is shadowed.
 */

/** Own property names of `Object.prototype`: defining one would clobber it. */
const OBJECT_PROTOTYPE_OWN: ReadonlySet<string> = new Set(
  Object.getOwnPropertyNames(Object.prototype),
);

/**
 * Every `_zod` instance slot the pinned library reads on its parse path, plus
 * the parse-context switches, the definition/check switches, and the payload
 * fields the abort logic reads.
 *
 * THE CONSULTED-SLOT AUDIT, RE-STATED FOR THESE PACKAGES. This list is the one
 * `test/unit/risk/inherited-state.test.ts` re-derives mechanically from the
 * shipped `zod@4.4.3` source, and it is repeated here rather than imported
 * because these two packages consume the DOOR, not that package's test suite.
 * `schema-boundary.test.ts` re-derives it AGAIN from the same shipped source
 * and fails if this copy does not cover the extraction, so a `zod` upgrade that
 * consults a new slot fails HERE as well as there (ADR-020 §7: an upgrade is a
 * contract change, never a lockfile-only edit).
 */
export const ZOD_PARSE_STATE_NAMES: readonly string[] = [
  // `_zod` instance slots.
  "bag",
  "check",
  "constr",
  "def",
  "deferred",
  "innerType",
  "onattach",
  "optin",
  "optout",
  "parent",
  "parse",
  "pattern",
  "propValues",
  "qin",
  "run",
  "traits",
  "values",
  "version",
  // Parse-context switches.
  "skipChecks",
  "direction",
  "jitless",
  "async",
  // Definition and check switches read during a parse.
  "when",
  "abort",
  "coerce",
  "catchall",
  "unionFallback",
  "inclusive",
  "discriminator",
  // Payload/issue fields the abort logic reads.
  "aborted",
  "continue",
  // The discriminated union's memoized discriminator map.
  "disc",
];

/** The descriptor attribute names an `Object.defineProperty` literal is read for. */
export const DESCRIPTOR_ATTRIBUTE_NAMES: readonly string[] = [
  "get",
  "set",
  "value",
  "writable",
  "enumerable",
  "configurable",
];

/**
 * Every candidate property name derived from `value`: its own keys at every
 * depth, and its string values (a value in one record is a key in another).
 *
 * Derived, not enumerated, for the reason `WP-180` gives after eight rounds of
 * hand-written site lists: a hand-written list always misses one.
 */
export function candidateKeys(value: unknown, extra: readonly string[] = []): readonly string[] {
  const found = new Set<string>(extra);
  const walk = (node: unknown, depth: number): void => {
    if (depth > 8 || node === null || typeof node !== "object") {
      if (typeof node === "string" && node.length > 0 && node.length < 64) found.add(node);
      return;
    }
    for (const key of Object.getOwnPropertyNames(node)) {
      if (Array.isArray(node) && key === "length") continue;
      if (!Array.isArray(node)) found.add(key);
      const descriptor = Object.getOwnPropertyDescriptor(node, key);
      if (descriptor !== undefined && Object.hasOwn(descriptor, "value")) {
        walk(descriptor.value, depth + 1);
      }
    }
  };
  walk(value, 0);
  return [...found].filter((name) => !OBJECT_PROTOTYPE_OWN.has(name) && name !== "__proto__");
}

/** One shape of pollution, applied to one name. */
export interface PollutionShape {
  readonly name: string;
  readonly install: (property: string) => void;
}

/** A plausible canonical UUIDv7, so an ADOPTED identifier looks legitimate. */
export const ATTRACTIVE_UUID = "01936f00-0000-7000-8000-0000000000ff";

function define(property: string, descriptor: PropertyDescriptor): void {
  Object.defineProperty(Object.prototype, property, descriptor);
}

/**
 * The measured classes of `docs/contracts/schema-boundary.md` §2, as shapes.
 *
 * `data-NE-*` is the adoption class in the form the contract calls "the one to
 * design against"; `data-E-1` is the enumerable variant AND the cold-lazy
 * trigger; `accessor-get-only` is loss and defeated defaults; `accessor-throws`
 * is the totality probe; `fn-false` covers an inherited `when`; and `get`/`set`
 * reached through the name material cover the descriptor-literal class.
 */
export const POLLUTION_SHAPES: readonly PollutionShape[] = [
  {
    name: "data-NE-uuid",
    install: (property) =>
      define(property, {
        value: ATTRACTIVE_UUID,
        writable: true,
        enumerable: false,
        configurable: true,
      }),
  },
  {
    name: "data-NE-true",
    install: (property) =>
      define(property, { value: true, writable: true, enumerable: false, configurable: true }),
  },
  {
    name: "data-NE-optional",
    install: (property) =>
      define(property, {
        value: "optional",
        writable: true,
        enumerable: false,
        configurable: true,
      }),
  },
  {
    name: "data-E-1",
    install: (property) =>
      define(property, { value: 1, writable: true, enumerable: true, configurable: true }),
  },
  {
    name: "accessor-get-only",
    install: (property) =>
      define(property, {
        get: () => ATTRACTIVE_UUID,
        enumerable: false,
        configurable: true,
      }),
  },
  {
    name: "accessor-throws",
    install: (property) =>
      define(property, {
        get: () => {
          throw new Error("hostile getter");
        },
        enumerable: false,
        configurable: true,
      }),
  },
  {
    name: "fn-false",
    install: (property) =>
      define(property, {
        value: () => false,
        writable: true,
        enumerable: false,
        configurable: true,
      }),
  },
];

/** One thing to measure: a name, and a function producing a comparable string. */
export interface Scenario {
  readonly name: string;
  readonly run: () => string;
}

/**
 * How an answer moved, in ADR-020 §6's own vocabulary.
 *
 * - `PERMISSION` — something polluted was ADMITTED that clean refused, or an
 *   accepted value's monetary content changed. **This is the class that must be
 *   empty.** It is what "permission never varies" means.
 * - `AVAILABILITY` — a clean acceptance became a refusal. Fail-closed: nothing
 *   is admitted, nothing is invented. `GOV-2A` recorded the `values` class this
 *   way ("fails closed (availability, not permission)") and the same reading
 *   applies here. Allowed, but ENUMERATED, so it cannot grow silently.
 * - `COMPOSITION` — a refusal became a DIFFERENT refusal. ADR-020 §6 permits
 *   this in as many words ("refusal *composition* may vary"); enumerated for
 *   the same reason.
 * - `ESCAPE` — an exception left a function whose contract is a typed result.
 *   **Must be empty**: it is the other half of the §6 bound.
 */
export type DivergenceKind = "PERMISSION" | "AVAILABILITY" | "COMPOSITION" | "ESCAPE";

/** One divergence: which scenario moved, under which name and shape. */
export interface Divergence {
  readonly kind: DivergenceKind;
  readonly scenario: string;
  readonly property: string;
  readonly shape: string;
  readonly clean: string;
  readonly polluted: string;
}

function classify(clean: string, polluted: string): DivergenceKind {
  if (polluted === THREW || clean === THREW) return "ESCAPE";
  const cleanRefused = clean.startsWith("REFUSED");
  const pollutedRefused = polluted.startsWith("REFUSED");
  if (cleanRefused && pollutedRefused) return "COMPOSITION";
  if (!cleanRefused && pollutedRefused) return "AVAILABILITY";
  return "PERMISSION";
}

/** The marker a scenario returns when an exception escaped the door. */
export const THREW = "THREW";

/** Renders divergences for an assertion message, one line each. */
export function render(divergences: readonly Divergence[]): readonly string[] {
  return divergences.map(
    (divergence) =>
      `${divergence.kind} | ${divergence.scenario} | ${divergence.property} | ` +
      `${divergence.shape}: ${divergence.clean} -> ${divergence.polluted}`,
  );
}

/**
 * Appends to an array WITHOUT `push`, for use inside the polluted window.
 *
 * `Array.prototype.push` is `Set`, and `Set` consults the prototype chain for
 * the INDEX name — so with a get-only accessor at `Object.prototype["5"]`, the
 * sixth `push` throws `Cannot set property 5 of #<Object> which has only a
 * getter`. That is the same class as everything this battery measures, and the
 * first draft of this harness was defeated by it while recording a divergence
 * (measured: the sweep threw at `divergences.push`). `defineProperty` has
 * `CreateDataProperty` semantics and consults nothing.
 */
function appendData<T>(target: T[], value: T): void {
  const descriptor = Object.create(null) as PropertyDescriptor;
  descriptor.value = value;
  descriptor.writable = true;
  descriptor.enumerable = true;
  descriptor.configurable = true;
  Object.defineProperty(target, `${target.length}`, descriptor);
}

function runQuietly(scenario: Scenario): string {
  try {
    return scenario.run();
  } catch {
    // NOT `String(error)`: coercing a caller-derived thrown value is itself a
    // place caller code runs (`plain-data.ts`'s `describeValue` exists for this).
    return THREW;
  }
}

/**
 * Runs every scenario clean, then under every (name × shape) pollution, and
 * returns every answer that moved.
 *
 * An empty result is the ADR-020 §6 bound, mechanically: **permission never
 * varies, the refusal is byte-identical, and no throw escapes** — because the
 * scenario strings carry the ok flag, the refusal codes, and the monetary
 * outcome, and a throw would have produced the string `THREW`, which no clean
 * baseline is allowed to be.
 */
export function sweep(
  scenarios: readonly Scenario[],
  properties: readonly string[],
  shapes: readonly PollutionShape[] = POLLUTION_SHAPES,
): readonly Divergence[] {
  const baseline = new Map<string, string>();
  for (const scenario of scenarios) baseline.set(scenario.name, runQuietly(scenario));
  const divergences: Divergence[] = [];
  for (const property of properties) {
    for (const shape of shapes) {
      let installed = false;
      try {
        shape.install(property);
        installed = true;
        for (const scenario of scenarios) {
          const polluted = runQuietly(scenario);
          const clean = baseline.get(scenario.name) ?? "";
          if (polluted !== clean) {
            appendData(divergences, {
              kind: classify(clean, polluted),
              scenario: scenario.name,
              property,
              shape: shape.name,
              clean,
              polluted,
            });
          }
        }
      } finally {
        if (installed) {
          delete (Object.prototype as Record<string, unknown>)[property];
        }
      }
    }
  }
  return divergences;
}

/**
 * The `optin`/`optout` PAIR, which is the only class that needs two names at
 * once: `handlePropertyResult` reads both before it waives a required key, and
 * either name alone does not flip it (`WP-180` round 9).
 */
export function sweepRequiredKeyWaiver(
  scenarios: readonly Scenario[],
): readonly Divergence[] {
  const baseline = new Map<string, string>();
  for (const scenario of scenarios) baseline.set(scenario.name, runQuietly(scenario));
  const divergences: Divergence[] = [];
  try {
    for (const property of ["optin", "optout"]) {
      define(property, {
        value: "optional",
        writable: true,
        enumerable: false,
        configurable: true,
      });
    }
    for (const scenario of scenarios) {
      const polluted = runQuietly(scenario);
      const clean = baseline.get(scenario.name) ?? "";
      if (polluted !== clean) {
        appendData(divergences, {
          kind: classify(clean, polluted),
          scenario: scenario.name,
          property: "optin+optout",
          shape: "data-NE-optional-pair",
          clean,
          polluted,
        });
      }
    }
  } finally {
    delete (Object.prototype as Record<string, unknown>)["optin"];
    delete (Object.prototype as Record<string, unknown>)["optout"];
  }
  return divergences;
}

/**
 * A short, comparable description of a `LedgerResult`/`PnlResult`.
 *
 * It carries BOTH halves of the ADR-020 §6 bound: the permission (`REFUSED` vs
 * `OK`, and the refusal CODES, which are the permission's vocabulary) and the
 * monetary outcome (the canonical rendering of the value). Refusal MESSAGES and
 * issue lists are deliberately excluded — §6 permits refusal *composition* to
 * vary, and a battery that pinned composition would fail for a reason the
 * contract allows.
 */
export function describeResult(result: unknown): string {
  const outcome = result as {
    readonly ok: boolean;
    readonly refusals?: readonly { readonly code: string }[];
    readonly value?: unknown;
  };
  if (!outcome.ok) {
    return `REFUSED ${(outcome.refusals ?? []).map((refusal) => refusal.code).join(",")}`;
  }
  return `OK ${canonical(outcome.value)}`;
}

/**
 * A prototype-free accumulator for the oracle below.
 *
 * THE HARNESS IS SUBJECT TO ITS OWN FINDINGS, and this one was found by running
 * it: the first draft of {@link canonical} accumulated into an ordinary `{}`
 * with `out[key] = value`, and under an inherited get-only `price` that
 * assignment THREW — so the battery reported a divergence for `allocateFill`
 * that the door did not have (measured both ways: probe W1 shows the door
 * returning `OK price=0.4` under exactly that pollution). A measuring
 * instrument that is defeated by the thing it measures reports the instrument.
 */
function plainAccumulator(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>;
}

function put(target: Record<string, unknown>, key: string, value: unknown): void {
  const descriptor = Object.create(null) as PropertyDescriptor;
  descriptor.value = value;
  descriptor.writable = true;
  descriptor.enumerable = true;
  descriptor.configurable = true;
  Object.defineProperty(target, key, descriptor);
}

/**
 * A canonical, order-stable JSON rendering: the byte oracle the scenarios
 * compare on. `Map`/`Set` are rendered as sorted entry lists so a container's
 * insertion order cannot make two equal states look different.
 */
export function canonical(value: unknown): string {
  const render = (node: unknown): unknown => {
    if (node instanceof Map) {
      const out = plainAccumulator();
      put(out, "@map", [...node.entries()].map(([k, v]) => [render(k), render(v)]).sort(byJson));
      return out;
    }
    if (node instanceof Set) {
      const out = plainAccumulator();
      put(out, "@set", [...node.values()].map(render).sort(byJson));
      return out;
    }
    if (Array.isArray(node)) return node.map(render);
    if (node === null || typeof node !== "object") return node;
    const out = plainAccumulator();
    for (const key of Object.getOwnPropertyNames(node).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(node, key);
      if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) continue;
      put(out, key, render(descriptor.value));
    }
    return out;
  };
  return JSON.stringify(render(value));
}

function byJson(a: unknown, b: unknown): number {
  const left = JSON.stringify(a);
  const right = JSON.stringify(b);
  return left < right ? -1 : left > right ? 1 : 0;
}
