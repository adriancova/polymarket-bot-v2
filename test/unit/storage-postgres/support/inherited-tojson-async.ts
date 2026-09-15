/**
 * The ASYNC form of the six-context inherited-`toJSON` harness
 * (`test/unit/ledger/inherited-tojson.ts`), for `SER-2`'s durable-bytes pins.
 *
 * Every repository write in `packages/storage-postgres`, the WAL writer's
 * `drain`/`close`, a Parquet compaction and the trader's `persistDecision` are
 * `async`: the site under measurement runs after one or more `await`s of the
 * fake it is driven against. The sync harness cannot reach it, so this module
 * restates the same protocol over a promise — INSTALL, `await` the call,
 * capture a STRING, RESTORE in a `finally`, and only then assert — with the
 * same six contexts and the same injected-`toJSON` call count.
 *
 * The precondition the sync harness states holds here with one more clause:
 * nothing inside the window may reach vitest's IPC (no `expect`, no
 * `console`), and every promise awaited inside the window must be one the
 * test's own in-memory fake resolves, so the only code that runs while the
 * prototype is polluted is the test's continuation and the code under
 * measurement. `test/unit/simulation/doors.test.ts` (`underPollutionAsync`)
 * is the precedent for holding pollution across an awaited in-memory fake.
 */

import { TOJSON_CONTEXTS } from "../../ledger/inherited-tojson.js";
import type { ToJsonContext, ToJsonDivergence } from "../../ledger/inherited-tojson.js";

export { TOJSON_CONTEXTS };
export type { ToJsonContext, ToJsonDivergence };

/** `withInheritedToJson`, awaiting `run`. Restores in a `finally` whatever `run` does. */
export async function withInheritedToJsonAsync<T>(
  context: ToJsonContext,
  run: () => Promise<T>,
): Promise<{ readonly result: T; readonly calls: number }> {
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
    result = await run();
  } finally {
    Reflect.deleteProperty(context.target, "toJSON");
    if (previous !== undefined) Object.defineProperty(context.target, "toJSON", previous);
  }
  return { result, calls };
}

/**
 * A throw-safe description of one awaited call: `ok:<string>` or
 * `threw:<name>:<code>:<message>` — the error's own `name`, its own `code` (a
 * storage error's stable code, or `-`), and its message. Read as own data
 * where a prototype could answer instead.
 */
export async function outcomeAsync(run: () => Promise<string>): Promise<string> {
  try {
    return `ok:${await run()}`;
  } catch (error) {
    return `threw:${describeThrown(error)}`;
  }
}

/** The sync twin, for a scenario whose call is synchronous. */
export function outcomeSync(run: () => string): string {
  try {
    return `ok:${run()}`;
  } catch (error) {
    return `threw:${describeThrown(error)}`;
  }
}

function describeThrown(error: unknown): string {
  if (typeof error !== "object" || error === null) return "non-error";
  const name = ownOrInherited(error, "name");
  const code = ownOrInherited(error, "code");
  const message = ownOrInherited(error, "message");
  return `${name ?? "?"}:${code ?? "-"}:${message ?? ""}`;
}

/** A string-valued property read through the ordinary lookup; `undefined` otherwise. */
function ownOrInherited(target: object, key: string): string | undefined {
  const value: unknown = (target as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

/** One async scenario: a name and a renderer that resolves to a comparable string. */
export interface AsyncToJsonScenario {
  readonly name: string;
  readonly render: () => Promise<string>;
}

/**
 * Runs every scenario clean, then under each of the six contexts, and returns
 * every answer that moved OR any context in which the injected `toJSON` ran.
 * An empty `divergences` is the pin.
 */
export async function sweepInheritedToJsonAsync(
  scenarios: readonly AsyncToJsonScenario[],
): Promise<{
  readonly clean: ReadonlyMap<string, string>;
  readonly divergences: readonly ToJsonDivergence[];
}> {
  const clean = new Map<string, string>();
  for (const scenario of scenarios) clean.set(scenario.name, await outcomeAsync(scenario.render));
  const divergences: ToJsonDivergence[] = [];
  for (const context of TOJSON_CONTEXTS) {
    const run = await withInheritedToJsonAsync(context, async () => {
      const answers: { readonly name: string; readonly answer: string }[] = [];
      for (const scenario of scenarios) {
        answers.push({ name: scenario.name, answer: await outcomeAsync(scenario.render) });
      }
      return answers;
    });
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
