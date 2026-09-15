/**
 * THE CONTROL API'S BODIES AND AUDIT DOCUMENTS DO NOT DEPEND ON AN INHERITED `toJSON` (`SER-3`).
 *
 * MEASURED AT `main` `d6e05bf` (`SER-0`, reproduced independently):
 *
 * - `apps/control-api/src/api.ts`'s `json()` was `JSON.stringify(value, null, 2)`
 *   for EVERY response body. Under an inherited `Object.prototype.toJSON` a
 *   state read, the kill-switch list and a mutation receipt were the bare
 *   injected string; under `Array.prototype` the kill-switch list read
 *   `{"killSwitches": "INJECTED"}` while a switch was ENGAGED — the body an
 *   operator reads to decide whether a halt is in force.
 * - `apps/control-api/src/adapters/postgres-audit-sink.ts` handed the §14.1
 *   `prior_state`/`resulting_state` and `previous_value`/`new_value` documents
 *   to `pg` as OBJECTS, and `pg`'s `prepareObject` `JSON.stringify`s through
 *   the prototype chain: the durable audit of a kill switch recorded the
 *   injected string as both states.
 *
 * - `apps/control-api/src/http.ts`'s two transport-level refusal bodies (`413`
 *   `CONTROL_BODY_TOO_LARGE`, `400` `CONTROL_BODY_NOT_JSON`) took the same
 *   route. `SER-0` graded them NOTE (message-only); this round encoded them
 *   from own data for uniformity — every byte the server writes takes one
 *   route — and `controlRefusalBody` is the function both sites call.
 *
 * Each `it` runs its scenario clean and under ALL SIX contexts and requires
 * the bytes — the response body; the strings handed to the database — to be
 * identical to the clean ones, the decision (status code; the row written)
 * unchanged, and the injected `toJSON` invoked ZERO times. It fails at the
 * base commit and passes once the sites encode from own data
 * (`@polymarket-bot/risk/plain-json`). The protocol is
 * `test/unit/ledger/inherited-tojson.ts`'s.
 *
 * ## Why the window is microtask-only, and why that is load-bearing
 *
 * MEASURED in this repository's vitest configuration (forks pool, tinypool
 * `postMessage`): an inherited `Object.prototype.toJSON` left installed across
 * a MACROTASK corrupts vitest's own worker IPC — the probe's main process
 * failed in `deserialize` with `ERR_INVALID_ARG_TYPE` ("Received an instance
 * of Object") because the serialized buffer had been replaced by the injected
 * string. That is why `test/unit/ledger/inherited-tojson.ts` is synchronous.
 *
 * The API's `handle` is async, so this file carries an async variant of the
 * window — and it is SOUND only because every await in the scenario resolves
 * on a MICROTASK: the harness's control plane, audit log
 * (`InMemoryControlAuditLog.append` → `Promise.resolve(...)`) and health
 * source (`InMemoryTraderHealthSource.read` → `Promise.resolve(...)`) touch no
 * timer, no socket and no file. The microtask queue is drained to empty before
 * any timer callback runs, so vitest's batched task-update flush cannot
 * interleave. Nothing inside the window logs. A future scenario that awaits a
 * timer or I/O here would be a different (and unsound) test.
 */

import { describe, expect, it } from "vitest";

import type { AuditStateDocument, ControlAuditRecord } from "../../../packages/observability/src/index.js";
import type { PolymarketBotDatabase } from "../../../packages/storage-postgres/src/index.js";

import { PostgresControlAuditSink } from "../../../apps/control-api/src/adapters/postgres-audit-sink.js";
import type { ApiRequest } from "../../../apps/control-api/src/api.js";
import { controlRefusalBody } from "../../../apps/control-api/src/http.js";
import {
  bearer,
  createHarness,
  FAKE_OPERATOR_TOKEN,
  healthDocument,
} from "../../../apps/control-api/src/testing/index.js";
import { renderDivergences, sweepInheritedToJson, TOJSON_CONTEXTS } from "../ledger/inherited-tojson.js";
import type { ToJsonContext } from "../ledger/inherited-tojson.js";

// ---------------------------------------------------------------------------
// An async window with the same protocol as the synchronous harness
// ---------------------------------------------------------------------------

/**
 * Installs the counting `toJSON`, awaits `run`, restores in a `finally`.
 * Every `await` inside `run` must be microtask-only (promise resolution): a
 * timer or I/O would let unrelated code serialize inside the window.
 */
async function withInheritedToJsonAsync<T>(
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

/** A throw-safe rendering of an async scenario, mirroring the harness's `outcome`. */
async function outcomeAsync(run: () => Promise<string>): Promise<string> {
  try {
    return `ok:${await run()}`;
  } catch (error) {
    return `threw:${error instanceof Error ? error.message : "non-error"}`;
  }
}

/**
 * Runs an async scenario clean, then under each context; every polluted
 * rendering must equal the clean one with zero injected calls. Returns the
 * clean rendering for the non-vacuity checks outside the windows.
 */
async function pinAsync(render: () => Promise<string>): Promise<string> {
  const clean = await outcomeAsync(render);
  for (const context of TOJSON_CONTEXTS) {
    const polluted = await withInheritedToJsonAsync(context, () => outcomeAsync(render));
    expect(polluted.result, context.name).toBe(clean);
    expect(polluted.calls, context.name).toBe(0);
  }
  return clean;
}

// ---------------------------------------------------------------------------
// Scenarios (no JSON.stringify inside any renderer)
// ---------------------------------------------------------------------------

function request(overrides: Partial<ApiRequest> = {}): ApiRequest {
  return {
    method: "GET",
    path: "/v1/run-state",
    authorization: bearer(FAKE_OPERATOR_TOKEN),
    body: undefined,
    ...overrides,
  };
}

const ENGAGE = {
  scope: "MARKET",
  scopeRef: "market-1",
  action: "CANCEL_MARKET",
  reason: "book desynchronised",
};

/**
 * A fresh API per call (the scripted environment makes the receipts
 * deterministic): engage a kill switch, then read the list, the run state,
 * the health report and a refusal. Renders every status and body.
 */
async function apiBodies(): Promise<string> {
  const { api, health, healthSource } = createHarness();
  healthSource.set(healthDocument());
  await health.refresh();
  const responses = [
    await api.handle(request({ method: "POST", path: "/v1/kill-switch", body: ENGAGE })),
    await api.handle(request({ path: "/v1/kill-switch" })),
    await api.handle(request({ path: "/v1/run-state" })),
    await api.handle(request({ path: "/v1/health" })),
    await api.handle(request({ path: "/v1/nope" })),
  ];
  return responses.map((response) => `${String(response.status)}${response.body}`).join("");
}

/** A fake Kysely handle that captures every row `insertInto(...).values(row).execute()` would write. */
function capturingDb(): { readonly db: PolymarketBotDatabase; readonly rows: { table: string; row: Record<string, unknown> }[] } {
  const rows: { table: string; row: Record<string, unknown> }[] = [];
  const db = {
    insertInto: (table: string) => ({
      values: (row: Record<string, unknown>) => ({
        execute: () => {
          rows.push({ table, row });
          return Promise.resolve([]);
        },
      }),
    }),
  };
  return { db: db as unknown as PolymarketBotDatabase, rows };
}

const PRIOR: AuditStateDocument = { engaged: false, action: null, since: ["never"] };
const RESULTING: AuditStateDocument = { engaged: true, action: "CANCEL_MARKET", since: ["2026-09-05T00:00:01.000Z"] };

function record(overrides: Partial<ControlAuditRecord>): ControlAuditRecord {
  return {
    recordId: "01930000-0000-7000-8000-000000000001",
    action: "KILL_SWITCH_ENGAGE",
    outcome: "APPLIED",
    actor: "operator-a",
    actorKind: "HUMAN",
    scope: "MARKET",
    scopeRef: "market-1",
    reason: "book desynchronised",
    priorState: PRIOR,
    resultingState: RESULTING,
    at: "2026-09-05T00:00:01.000Z",
    ...overrides,
  };
}

/** Appends an engage, a strategy pause and a refused engage; renders the jsonb inputs handed to pg. */
async function auditRows(): Promise<string> {
  const { db, rows } = capturingDb();
  const sink = new PostgresControlAuditSink({ db, environment: "PAPER" });
  const results = [
    await sink.append(record({})),
    await sink.append(
      record({
        recordId: "01930000-0000-7000-8000-000000000002",
        action: "STRATEGY_PAUSE",
        scope: "CONTROL_PLANE",
        scopeRef: "sb-1",
        priorState: "RUNNING",
        resultingState: null,
      }),
    ),
    await sink.append(record({ recordId: "01930000-0000-7000-8000-000000000003", outcome: "REFUSED" })),
  ];
  const documents = rows.map(({ table, row }) =>
    [
      table,
      ...["prior_state", "resulting_state", "previous_value", "new_value"]
        .filter((column) => column in row)
        .map((column) => `${column}=${typeof row[column]}:${String(row[column])}`),
    ].join(""),
  );
  return `${results.map((result) => (result.ok ? "ok" : result.code)).join(",")}${documents.join("")}`;
}

// ---------------------------------------------------------------------------
// The pins
// ---------------------------------------------------------------------------

describe("control-api response bodies under an inherited toJSON (SER-3)", () => {
  it("every body — a mutation receipt, the kill-switch list, the run state, the health report, a refusal — is the clean-process body", async () => {
    const clean = await pinAsync(apiBodies);
    expect(clean.startsWith("ok:")).toBe(true);
    const responses = clean.slice(3).split("").map((entry) => entry.split(""));
    expect(responses.map((entry) => entry[0])).toEqual(["200", "200", "200", "200", "404"]);
    // Outside every window: the clean bodies ARE `JSON.stringify(value, null, 2)` + "\n"
    // of the parsed value, and they carry the decisions an operator reads.
    for (const [, body] of responses) {
      expect(body).toBe(`${JSON.stringify(JSON.parse(body ?? ""), null, 2)}\n`);
    }
    const killSwitches = JSON.parse(responses[1]?.[1] ?? "") as { killSwitches: readonly { scope: string }[] };
    expect(killSwitches.killSwitches).toHaveLength(1);
    expect(killSwitches.killSwitches[0]?.scope).toBe("MARKET");
    const receipt = JSON.parse(responses[0]?.[1] ?? "") as { auditRecordId: string };
    expect(receipt.auditRecordId).toBe("01930000-0000-7000-8000-000000000001");
    const runState = JSON.parse(responses[2]?.[1] ?? "") as { allowRealOrders: boolean; runModeIsWritable: boolean };
    expect(runState.allowRealOrders).toBe(false);
    expect(runState.runModeIsWritable).toBe(false);
    const health = JSON.parse(responses[3]?.[1] ?? "") as { available: boolean };
    expect(health.available).toBe(true);
  });

  it("the transport-level 413 and 400 refusal bodies are the clean-process bodies (http.ts, uniformity)", () => {
    // SYNCHRONOUS window: `controlRefusalBody` is the function both `http.ts`
    // sites call, so this drives the site itself without holding pollution
    // across socket I/O (see this file's header for why that matters).
    const sweep = sweepInheritedToJson([
      {
        name: "413",
        render: () => controlRefusalBody("CONTROL_BODY_TOO_LARGE", "a request body may not exceed 256 bytes", []),
      },
      {
        name: "400",
        render: () =>
          controlRefusalBody("CONTROL_BODY_NOT_JSON", "the request body is not JSON", [
            "Unexpected token 'o', \"not json {{{\" is not valid JSON",
          ]),
      },
    ]);
    expect(renderDivergences(sweep.divergences)).toEqual([]);
    expect(sweep.clean.get("413")).toBe(
      `ok:${JSON.stringify({
        code: "CONTROL_BODY_TOO_LARGE",
        detail: "a request body may not exceed 256 bytes",
        issues: [],
      })}\n`,
    );
    expect(sweep.clean.get("400")).toBe(
      `ok:${JSON.stringify({
        code: "CONTROL_BODY_NOT_JSON",
        detail: "the request body is not JSON",
        issues: ["Unexpected token 'o', \"not json {{{\" is not valid JSON"],
      })}\n`,
    );
  });
});

describe("the durable audit sink hands pg TEXT encoded from own data (SER-3)", () => {
  it("prior/resulting states and previous/new values are strings, byte-identical to the clean-process documents, in every context", async () => {
    const clean = await pinAsync(auditRows);
    const [results, ...documents] = clean.slice(3).split("");
    expect(results).toBe("ok,ok,ok");
    // Outside every window: the strings handed to the driver are exactly the
    // clean-process `JSON.stringify` of the documents (the `{ value }` wrap
    // kept for a non-object document), on the table §10.6 assigns.
    expect(documents).toEqual([
      [
        "ops.kill_switch_events",
        `prior_state=string:${JSON.stringify(PRIOR)}`,
        `resulting_state=string:${JSON.stringify(RESULTING)}`,
      ].join(""),
      [
        "ops.config_change_audit",
        `previous_value=string:${JSON.stringify({ value: "RUNNING" })}`,
        `new_value=string:${JSON.stringify({ value: null })}`,
      ].join(""),
      [
        "ops.config_change_audit",
        `previous_value=string:${JSON.stringify(PRIOR)}`,
        `new_value=string:${JSON.stringify(RESULTING)}`,
      ].join(""),
    ]);
  });

  it("a document the encoder refuses is reported as AUDIT_SINK_UNAVAILABLE: the mutation does not happen", async () => {
    const { db, rows } = capturingDb();
    const sink = new PostgresControlAuditSink({ db, environment: "PAPER" });
    const result = await sink.append(
      record({ resultingState: { when: new Date(0) } as unknown as AuditStateDocument }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("AUDIT_SINK_UNAVAILABLE");
    expect(result.detail).toContain("value.when");
    expect(rows).toEqual([]);
  });
});
