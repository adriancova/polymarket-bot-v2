/**
 * The inherited-`toJSON` harness the `SER-1` accounting-key pins share
 * (`test/unit/ledger/inherited-tojson.test.ts`, `test/unit/pnl/inherited-tojson.test.ts`).
 *
 * THE CLASS. `JSON.stringify` resolves `toJSON` through the value's PROTOTYPE
 * CHAIN (ECMA-262 25.5.2 `SerializeJSONProperty` looks it up for every value
 * of type Object or BigInt), so a `toJSON` inherited from `Object.prototype`
 * or `Array.prototype` replaces the bytes of ANY object and ANY array, and one
 * on `BigInt.prototype` turns a bigint's `TypeError` into accepted bytes. Six
 * contexts, as measured by `SER-0`: three prototypes × {enumerable assignment,
 * non-enumerable `defineProperty`}.
 *
 * THE PROTOCOL, which `test/unit/ledger/pollution.ts` also follows: install,
 * call, capture a STRING, RESTORE in a `finally`, and only then assert. An
 * inherited `toJSON` left installed corrupts vitest's own IPC serialization,
 * and `expect` inside the window would measure the assertion library. Nothing
 * a scenario renders inside the window may call `JSON.stringify` — that is the
 * function under suspicion — so the renderers here build strings by
 * concatenation over primitives.
 */

export interface ToJsonContext {
  readonly name: string;
  readonly target: object;
  readonly enumerable: boolean;
}

/** The six measured contexts, in the order `SER-0` reported them. */
export const TOJSON_CONTEXTS: readonly ToJsonContext[] = [
  { name: "Object.prototype/enumerable", target: Object.prototype, enumerable: true },
  { name: "Object.prototype/non-enumerable", target: Object.prototype, enumerable: false },
  { name: "Array.prototype/enumerable", target: Array.prototype, enumerable: true },
  { name: "Array.prototype/non-enumerable", target: Array.prototype, enumerable: false },
  { name: "BigInt.prototype/enumerable", target: BigInt.prototype, enumerable: true },
  { name: "BigInt.prototype/non-enumerable", target: BigInt.prototype, enumerable: false },
];

/**
 * Installs a counting `toJSON` on the context's prototype, runs, restores, and
 * reports how often the injected function ran. "Enumerable" is a literal
 * assignment; "non-enumerable" is a `defineProperty` with a prototype-free
 * descriptor.
 */
export function withInheritedToJson<T>(
  context: ToJsonContext,
  run: () => T,
): { readonly result: T; readonly calls: number } {
  let calls = 0;
  const injected = (): string => {
    calls += 1;
    return "INJECTED";
  };
  const previous = Object.getOwnPropertyDescriptor(context.target, "toJSON");
  if (context.enumerable) {
    (context.target as { toJSON?: unknown }).toJSON = injected;
  } else {
    const descriptor = Object.create(null) as PropertyDescriptor;
    descriptor.value = injected;
    descriptor.enumerable = false;
    descriptor.writable = true;
    descriptor.configurable = true;
    Object.defineProperty(context.target, "toJSON", descriptor);
  }
  let result: T;
  try {
    result = run();
  } finally {
    Reflect.deleteProperty(context.target, "toJSON");
    if (previous !== undefined) Object.defineProperty(context.target, "toJSON", previous);
  }
  return { result, calls };
}

/**
 * A throw-safe description of one call: the string it produced, or the
 * message it threw with. Allocation-only; never formats a caller value.
 */
export function outcome(run: () => string): string {
  try {
    return `ok:${run()}`;
  } catch (error) {
    return `threw:${error instanceof Error ? error.message : "non-error"}`;
  }
}

/**
 * One scenario: a name and a renderer that returns a comparable string WITHOUT
 * `JSON.stringify`.
 */
export interface ToJsonScenario {
  readonly name: string;
  readonly render: () => string;
}

/** One divergence between the clean answer and a polluted one. */
export interface ToJsonDivergence {
  readonly scenario: string;
  readonly context: string;
  readonly clean: string;
  readonly polluted: string;
  readonly calls: number;
}

/**
 * Runs every scenario clean, then under each of the six contexts, and returns
 * every answer that moved OR any context in which the injected `toJSON` ran at
 * all. An empty result is the pin: the decision and its bytes are invariant
 * under ambient prototype state, and no `JSON.stringify` over an object, array
 * or bigint ran on the path.
 */
export function sweepInheritedToJson(
  scenarios: readonly ToJsonScenario[],
): { readonly clean: ReadonlyMap<string, string>; readonly divergences: readonly ToJsonDivergence[] } {
  const clean = new Map<string, string>();
  for (const scenario of scenarios) clean.set(scenario.name, outcome(scenario.render));
  const divergences: ToJsonDivergence[] = [];
  for (const context of TOJSON_CONTEXTS) {
    const run = withInheritedToJson(context, () =>
      scenarios.map((scenario) => ({ name: scenario.name, answer: outcome(scenario.render) })));
    for (const entry of run.result) {
      const baseline = clean.get(entry.name) ?? "";
      if (entry.answer !== baseline || run.calls !== 0) {
        divergences.push({
          scenario: entry.name,
          context: context.name,
          clean: baseline,
          polluted: entry.answer,
          calls: run.calls,
        });
      }
    }
  }
  return { clean, divergences };
}

/** Renders divergences for an assertion message, one line each. */
export function renderDivergences(divergences: readonly ToJsonDivergence[]): readonly string[] {
  return divergences.map(
    (divergence) =>
      `${divergence.scenario} | ${divergence.context} | calls=${String(divergence.calls)}: ` +
      `${divergence.clean} -> ${divergence.polluted}`,
  );
}
