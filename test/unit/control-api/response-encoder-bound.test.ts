/**
 * THE RESPONSE ENCODER MAY NOT REFUSE WHERE BASE ENCODED (`SER-3`, audited
 * against the `SER-2` review's HIGH).
 *
 * The rule the remediation is held to: no input a real producer can supply may
 * make a production encoder refuse where base `JSON.stringify` (no depth
 * bound) succeeded. `api.ts`'s `json()` is the site, and ONE value it embeds
 * comes from outside this process: the trader health report
 * (`api.ts` `#health()` → `TraderHealthCache.last()`). Everything else in a
 * response body is the control plane's own frozen state, a mutation receipt,
 * or a refusal record built here from strings.
 *
 * Two bounds make a refusal unreachable, and both are pinned below:
 *
 * 1. THE SCHEMA'S BOUND. A health document reaches `last()` only through
 *    `readTraderHealthReport` (`apps/control-api/src/health-door.ts:181`),
 *    whose schema is a FIXED shape — no `z.unknown()`, `z.any()`, `z.lazy(`
 *    or `.passthrough()`; its one `z.record(` (`health-door.ts:77`) maps
 *    string keys to a `Counter`, so it adds one level and cannot nest. A
 *    document deeper than that shape is REFUSED at the door, `last()` keeps
 *    the previous report, and `json()` never sees it.
 * 2. THE DOOR'S BOUND, which is the encoder's. `buildDoor`
 *    (`apps/control-api/src/doors.ts:114`) materializes with `readPlainData`,
 *    which refuses at `depth >= MAX_DEPTH` (`packages/risk/src/plain-data.ts:354`,
 *    `MAX_DEPTH` 64 at `:216`). `encodePlainJson` refuses at `depth >= maxDepth`
 *    with the SAME default constant — the same predicate, the same depth
 *    convention, the same module. So the two bounds are exactly aligned rather
 *    than merely close: every tree any door in this process accepts is a tree
 *    `json()` can encode, with no off-by-one at the boundary. That is the
 *    property this file pins, because it is what makes the audit's answer
 *    "safe" hold for every door-materialized value, not just today's schema.
 */

import { describe, expect, it } from "vitest";

import { MAX_DEPTH, readPlainData } from "../../../packages/risk/src/plain-data.js";
import { encodePlainJson } from "../../../packages/risk/src/plain-json.js";
import { bearer, createHarness, FAKE_OPERATOR_TOKEN, healthDocument } from "../../../apps/control-api/src/testing/index.js";

/** A chain of `levels` nested containers with a scalar at the bottom. */
function chain(levels: number): unknown {
  let node: unknown = "leaf";
  for (let index = 0; index < levels; index += 1) node = { nest: node };
  return node;
}

describe("every tree this process's doors accept, the response encoder can encode", () => {
  it("the door's depth bound and the encoder's are the same predicate and the same constant", () => {
    expect(MAX_DEPTH).toBe(64);
    // The deepest tree `readPlainData` accepts. The root container is depth 0,
    // so a chain of MAX_DEPTH containers is the boundary case.
    const deepest = chain(MAX_DEPTH);
    const accepted = readPlainData(deepest, "value");
    expect(accepted.ok, JSON.stringify(accepted.ok ? [] : accepted.problems)).toBe(true);
    if (!accepted.ok) return;
    // The encoder accepts exactly that tree — no off-by-one at the boundary —
    // and produces the clean-process bytes for it.
    expect(encodePlainJson(accepted.value, { indent: 2 })).toBe(JSON.stringify(deepest, null, 2));

    // And one level deeper, the DOOR refuses first, so nothing that deep can
    // reach a response body at all.
    const tooDeep = readPlainData(chain(MAX_DEPTH + 1), "value");
    expect(tooDeep.ok).toBe(false);
    if (tooDeep.ok) return;
    expect(tooDeep.problems.map((problem) => problem.problem).join("\n")).toContain(
      "nested deeper than 64 levels",
    );
  });

  it("a health document past the schema's shape is refused at the door, so the health body is the previous report", async () => {
    const { api, health, healthSource } = createHarness();
    healthSource.set(healthDocument());
    await health.refresh();
    const good = await api.handle({
      method: "GET",
      path: "/v1/health",
      authorization: bearer(FAKE_OPERATOR_TOKEN),
      body: undefined,
    });
    expect(good.status).toBe(200);
    expect((JSON.parse(good.body) as { available: boolean }).available).toBe(true);

    // 200 levels: past the encoder's default bound, past the door's, and well
    // inside what `JSON.parse` accepts off a wire — the `SER-2` shape.
    healthSource.set({ ...(healthDocument() as object), halts: chain(200) });
    const refused = await health.refresh();
    expect(refused.outcome).not.toBe("OK");

    // The response still encodes, still answers 200, and still carries the
    // last report that passed — the decision base reached, unchanged. The one
    // thing that moved is the read-outcome counter, which is the point of
    // retaining the last good report rather than emptying the dashboard.
    const after = await api.handle({
      method: "GET",
      path: "/v1/health",
      authorization: bearer(FAKE_OPERATOR_TOKEN),
      body: undefined,
    });
    expect(after.status).toBe(200);
    const before = JSON.parse(good.body) as Record<string, unknown>;
    const now = JSON.parse(after.body) as Record<string, unknown>;
    expect(now["available"]).toBe(true);
    expect(now["report"]).toEqual(before["report"]);
    expect(now["reads"]).toEqual({ OK: 1, [String(refused.outcome)]: 1 });
    // And it is still the clean-process encoding of what it parses to.
    expect(after.body).toBe(`${JSON.stringify(now, null, 2)}\n`);
  });

  it("the report the door DID accept encodes byte-identically to the clean-process body", async () => {
    const { api, health, healthSource } = createHarness();
    healthSource.set(healthDocument());
    await health.refresh();
    const response = await api.handle({
      method: "GET",
      path: "/v1/health",
      authorization: bearer(FAKE_OPERATOR_TOKEN),
      body: undefined,
    });
    expect(response.body).toBe(`${JSON.stringify(JSON.parse(response.body), null, 2)}\n`);
    const body = JSON.parse(response.body) as { report: { queues: readonly unknown[] } };
    // Non-vacuity: the body really does carry the door-materialized report.
    expect(body.report.queues.length).toBeGreaterThan(0);
  });
});
