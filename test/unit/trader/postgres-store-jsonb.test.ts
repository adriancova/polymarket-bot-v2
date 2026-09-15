/**
 * `SER-2`: `PostgresTraderStore.persistDecision` binds `model_outputs` and
 * `state_patch` as TEXT — the documents' own bytes — never as objects `pg`
 * would serialize through the prototype chain.
 *
 * `docs/handoffs/SER-0-sweep.md` measured the site
 * (`pg-strategy-decisions-model-outputs-state-patch`) reproducing under all
 * six inherited-`toJSON` contexts and REFUTED its reach at HEAD: the runtime's
 * materializer emits null-prototype trees, which no `Object.prototype.toJSON`
 * can reach. Its ARRAYS keep `Array.prototype`, though, and the repository
 * rule is one sentence — every `jsonb` write hands `pg` text — so the site is
 * routed for uniformity and pinned here exactly as the repositories are
 * (`test/unit/storage-postgres/jsonb-text-binding.test.ts`): against a
 * capturing stand-in for the Kysely handle, install → `await` → capture a
 * string → restore in a `finally` → assert.
 *
 * `apps/trader` has no other unit test of this adapter (its header discloses
 * "typecheck-pinned only"); this file is the adapter's first, and it reaches
 * no PostgreSQL. The `PortResult` boundary is pinned too: an encoder refusal
 * is `UNAVAILABLE` port data carrying the storage package's typed error name,
 * like every other failure `#contained` turns into data.
 */

import { describe, expect, it } from "vitest";

import { PostgresTraderStore } from "../../../apps/trader/src/adapters/postgres-store.js";
import type {
  DecisionRecord,
  DecisionTelemetry,
} from "../../../packages/strategy-runtime/src/index.js";
import { createCapturingDatabase } from "../storage-postgres/support/capturing-db.js";
import {
  renderDivergences,
  sweepInheritedToJsonAsync,
} from "../storage-postgres/support/inherited-tojson-async.js";

const MODEL_OUTPUTS = { edge: "0.012", probability: "0.51", stale: false, note: null } as const;
const STATE_PATCH = { lastFair: "0.51", ladder: ["a", "b"], nested: { count: "3" } } as const;
const TELEMETRY: DecisionTelemetry = { evaluationDurationUs: 1200 };

function record(
  decision: { readonly modelOutputs?: Record<string, unknown>; readonly statePatch?: Record<string, unknown> },
): DecisionRecord {
  return {
    decisionContractVersion: 1,
    runId: "0190a3e0-0000-7000-8000-000000000001",
    instanceId: "0190a3e0-0000-7000-8000-000000000002",
    marketId: "0190a3e0-0000-7000-8000-000000000003" as DecisionRecord["marketId"],
    evaluationSeq: 7,
    callback: "onFeatures",
    attribution: "STRATEGY",
    evaluatedAt: "2026-06-29T17:15:57.300Z",
    decision: {
      decisionType: "hold",
      reasonCodes: ["NO_EDGE"],
      featureSnapshotRef: "snap-1",
      intents: [],
      ...decision,
    } as DecisionRecord["decision"],
  };
}

/** The materializer's shape: null-prototype objects, arrays keeping `Array.prototype`. */
function nullPrototypeTree(): { readonly modelOutputs: Record<string, unknown>; readonly statePatch: Record<string, unknown> } {
  const define = (target: object, key: string, value: unknown): void => {
    Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
  };
  const modelOutputs = Object.create(null) as Record<string, unknown>;
  define(modelOutputs, "edge", "0.012");
  define(modelOutputs, "stale", false);
  const ladder: unknown[] = [];
  define(ladder, "0", "a");
  define(ladder, "1", "b");
  const nested = Object.create(null) as Record<string, unknown>;
  define(nested, "count", "3");
  const statePatch = Object.create(null) as Record<string, unknown>;
  define(statePatch, "ladder", ladder);
  define(statePatch, "nested", nested);
  return { modelOutputs, statePatch };
}

async function bind(
  decision: { readonly modelOutputs?: Record<string, unknown>; readonly statePatch?: Record<string, unknown> },
): Promise<{ readonly result: string; readonly modelOutputs: unknown; readonly statePatch: unknown }> {
  const capture = createCapturingDatabase();
  const store = new PostgresTraderStore({ db: capture.db, decisionContractVersion: 1 });
  const outcome = await store.persistDecision(record(decision), TELEMETRY);
  return {
    result: outcome.ok ? "ok" : `${outcome.failure.kind}:${outcome.failure.detail}`,
    modelOutputs: capture.bound("strategy.decisions", "model_outputs"),
    statePatch: capture.bound("strategy.decisions", "state_patch"),
  };
}

function describeBound(value: unknown): string {
  return typeof value === "string" ? `text:${value}` : `${typeof value}:${String(value)}`;
}

describe("PostgresTraderStore.persistDecision binds model_outputs and state_patch as text (SER-2)", () => {
  it("binds STRINGS whose bytes are the documents' own JSON, and null for an absent document", async () => {
    const both = await bind({ modelOutputs: { ...MODEL_OUTPUTS }, statePatch: { ...STATE_PATCH } });
    expect(both.result).toBe("ok");
    expect(typeof both.modelOutputs).toBe("string");
    expect(typeof both.statePatch).toBe("string");
    expect(both.modelOutputs).toBe(JSON.stringify(MODEL_OUTPUTS));
    expect(both.statePatch).toBe(JSON.stringify(STATE_PATCH));

    const neither = await bind({});
    expect(neither.result).toBe("ok");
    expect(neither.modelOutputs).toBeNull();
    expect(neither.statePatch).toBeNull();
  });

  it("encodes the materializer's null-prototype trees, arrays included", async () => {
    const bound = await bind(nullPrototypeTree());
    expect(bound.result).toBe("ok");
    expect(bound.modelOutputs).toBe('{"edge":"0.012","stale":false}');
    expect(bound.statePatch).toBe('{"ladder":["a","b"],"nested":{"count":"3"}}');
  });

  it("binds the same text under all six inherited-toJSON contexts, the injected toJSON never invoked", async () => {
    const sweep = await sweepInheritedToJsonAsync([
      {
        name: "plain literals",
        render: async () => {
          const bound = await bind({ modelOutputs: { ...MODEL_OUTPUTS }, statePatch: { ...STATE_PATCH } });
          return `${bound.result}|${describeBound(bound.modelOutputs)}|${describeBound(bound.statePatch)}`;
        },
      },
      {
        name: "null-prototype tree with Array.prototype arrays",
        render: async () => {
          const bound = await bind(nullPrototypeTree());
          return `${bound.result}|${describeBound(bound.modelOutputs)}|${describeBound(bound.statePatch)}`;
        },
      },
      {
        name: "absent documents",
        render: async () => {
          const bound = await bind({});
          return `${bound.result}|${describeBound(bound.modelOutputs)}|${describeBound(bound.statePatch)}`;
        },
      },
    ]);
    expect(renderDivergences(sweep.divergences)).toEqual([]);
    expect(sweep.clean.get("plain literals")).toBe(
      `ok:ok|text:${JSON.stringify(MODEL_OUTPUTS)}|text:${JSON.stringify(STATE_PATCH)}`,
    );
    expect(sweep.clean.get("absent documents")).toBe("ok:ok|object:null|object:null");
  });

  it("turns an encoder refusal into UNAVAILABLE port data naming the typed error, in every context", async () => {
    // A bigint cannot come out of the decision contract, but the port boundary
    // is what §4.2 halts on, so the shape of the refusal is pinned: no throw,
    // no row, the storage package's typed error named in the detail.
    const sweep = await sweepInheritedToJsonAsync([
      {
        name: "bigint inside state_patch",
        render: async () => {
          const bound = await bind({ statePatch: { counter: { n: 1n } } });
          return `${bound.result}|${describeBound(bound.modelOutputs)}|${describeBound(bound.statePatch)}`;
        },
      },
    ]);
    expect(renderDivergences(sweep.divergences)).toEqual([]);
    expect(sweep.clean.get("bigint inside state_patch")).toBe(
      "ok:UNAVAILABLE:the durable store could not persist a decision: DecimalSafeJsonError: " +
        "decisions.state_patch.counter.n is a bigint, which JSON cannot represent. Use a decimal string." +
        "|undefined:undefined|undefined:undefined",
    );
  });
});
