/**
 * `THROUGHPUT-1a` — a PREPARED evaluation view (`prepareEvaluationView`) is
 * the raw view as far as any evaluation can tell: the acquired input snapshot
 * is equal (deep, and deep-frozen), the persisted decision record and
 * checkpoint are equal, and a value the evaluation grammar refuses is handed
 * back UNCHANGED, so it is refused exactly as before.
 */

import { describe, expect, it } from "vitest";

import { acquireEvaluationInput, prepareEvaluationView } from "../../../packages/strategy-runtime/src/index.js";
import { makeHarness, makeInput, makeViews } from "./helpers.js";

function deepFrozen(value: unknown): boolean {
  if (value === null || typeof value !== "object") return true;
  if (!Object.isFrozen(value)) return false;
  return Object.values(value).every((member) => deepFrozen(member));
}

describe("prepareEvaluationView (THROUGHPUT-1a)", () => {
  it("answers a deep-frozen copy equal to the view, and leaves the view untouched", () => {
    const view = makeViews().books.yes;
    const before = JSON.stringify(view);
    const prepared = prepareEvaluationView(view);
    expect(prepared).not.toBe(view);
    expect(deepFrozen(prepared)).toBe(true);
    expect(JSON.stringify(view)).toBe(before);
    expect(JSON.parse(JSON.stringify(prepared))).toEqual(JSON.parse(before));
  });

  it("an input carrying prepared views acquires the same snapshot as one carrying the raw views", () => {
    const raw = makeInput();
    const views = makeViews().books;
    const prepared = makeInput("onFeatures", {
      books: { yes: prepareEvaluationView(views.yes), no: prepareEvaluationView(views.no) },
    });
    const plain = acquireEvaluationInput(raw);
    const fast = acquireEvaluationInput(prepared);
    expect(plain.ok && fast.ok).toBe(true);
    if (!plain.ok || !fast.ok) return;
    expect(fast.input).toEqual(plain.input);
    expect(JSON.stringify(fast.input)).toBe(JSON.stringify(plain.input));
    expect(deepFrozen(fast.input)).toBe(true);
  });

  it("evaluates identically: the same record, the same checkpoint", () => {
    const views = makeViews().books;
    const withRaw = makeHarness();
    const withPrepared = makeHarness();
    const outcomes = [
      withRaw.runtime.evaluate(makeInput()),
      withPrepared.runtime.evaluate(
        makeInput("onFeatures", {
          books: { yes: prepareEvaluationView(views.yes), no: prepareEvaluationView(views.no) },
        }),
      ),
    ];
    expect(outcomes[0]?.kind).toBe("DECIDED");
    expect(outcomes[1]?.kind).toBe("DECIDED");
    const records = (harness: ReturnType<typeof makeHarness>) =>
      JSON.stringify(harness.sink.calls.map((call) => call.record));
    expect(withRaw.sink.calls).toHaveLength(1);
    expect(records(withPrepared)).toBe(records(withRaw));
    expect(withRaw.store.checkpoints).toHaveLength(1);
    expect(JSON.stringify(withPrepared.store.checkpoints)).toBe(JSON.stringify(withRaw.store.checkpoints));
  });

  it("hands a value the grammar refuses back UNCHANGED, so the evaluation refuses it as before", () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("trap");
        },
      },
    );
    expect(prepareEvaluationView(hostile)).toBe(hostile);
    const cyclic: Record<string, unknown> = { bids: [], asks: [], asOf: "2026-01-02T03:04:05.000Z" };
    cyclic["self"] = cyclic;
    expect(prepareEvaluationView(cyclic)).toBe(cyclic);
    const refusedRaw = acquireEvaluationInput(makeInput("onFeatures", { books: { yes: cyclic, no: cyclic } }));
    expect(refusedRaw.ok).toBe(false);
  });

  it("a prepared view nested past the grammar's depth bound is read as any value (no shortcut)", () => {
    // A tree of nested containers deeper than the bound, whose root is prepared
    // while shallow: met deep inside an input, it must be refused as before.
    let deep: Record<string, unknown> = { leaf: "x" };
    for (let level = 0; level < 60; level += 1) deep = { next: deep };
    const prepared = prepareEvaluationView(deep);
    const input = makeInput("onFeatures", { features: { ...makeViews().features, values: prepared } });
    const raw = makeInput("onFeatures", { features: { ...makeViews().features, values: deep } });
    expect(acquireEvaluationInput(input).ok).toBe(acquireEvaluationInput(raw).ok);
  });
});
