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
 *    than merely close, WITH ONE QUALIFICATION THE `SER-3` REVIEW MEASURED AND
 *    THIS FILE NOW PINS (round 1, L-residual): the alignment holds at the ROOT
 *    depth. `json()` does not encode a door's output at the root — `#health()`
 *    wraps it as `{ available, reads, report, note }` — so a tree the door
 *    accepts at exactly `MAX_DEPTH` is one level too deep once embedded, and
 *    the encoder refuses it. The composition is therefore safe today because
 *    of BOUND 1 (the health schema is a fixed handful of levels), not because
 *    the two bounds compose at arbitrary nesting. The third block below is the
 *    reviewer's measurement, executable: `readPlainData(chain(64))` is
 *    accepted and `encodePlainJson({ report: accepted })` refuses.
 *
 * THE CONTAINER TYPES `json()` RECEIVES (the M2 sweep, review round 1). The
 * defect the review found in `polymarket-public` was a caller's `Array`
 * SUBCLASS reaching the encoder through a species-preserving `map`, refused
 * where `JSON.stringify` serialized. Swept here, by tracing every value
 * `json()` embeds (`api.ts:309/:313/:318/:396/:413/:430/:436`):
 *
 * - `ControlPlane` and `TraderHealthCache` are CONCRETE CLASSES with `#`
 *   private fields, so they are nominally typed: no foreign implementation is
 *   assignable to `ControlApiOptions`, and their own containers are ordinary
 *   (`[...map.values()]`, frozen object literals) or null-prototype records
 *   (`sortedCounts`, `readCounts`), which the encoder accepts exactly as
 *   `JSON.stringify` serialized them. The fourth block pins the null-prototype
 *   record, which is a REAL production container on the `/v1/health` body.
 * - The ONE value from outside is the trader health report, and it reaches
 *   `last()` through `TraderHealthSource.read()`, whose three in-repo
 *   implementations all obtain it from the door (`health-source.ts`, `parse`).
 *   `readPlainData` MATERIALIZES a fresh tree, so no container the document
 *   supplied — subclass, null prototype or class instance — survives into a
 *   response body. The second block pins that with a null-prototype document.
 *   The door's own refusal of a non-plain prototype is PRE-EXISTING (`doors.ts`
 *   is untouched by `SER-3`), not a bound this round moved.
 *
 * The residual, stated rather than hidden: `TraderHealthSource` is an exported
 * interface, so a composition that implements it WITHOUT the door and returns a
 * report with a foreign container gets a `CONTROL_INTERNAL_ERROR` where base
 * answered 200. No deep re-materialization is available that would not also
 * decide what a `Date` or a `Map` means — the decision the own-data encoder
 * exists to refuse — so the contract is stated on the interface
 * (`health-source.ts`) instead.
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

describe("the container TYPES a response body can carry (the SER-3 review's M2 sweep)", () => {
  it("a null-prototype health document is materialized by the door and encodes as base did", async () => {
    // `readPlainData` accepts a null prototype and builds a FRESH tree, so the
    // document's own containers never reach `json()`. A null-prototype object
    // is the case `JSON.stringify` also serializes normally, which is why it is
    // the fixture that would expose a refusal-where-base-encoded.
    const { api, health, healthSource } = createHarness();
    const document = Object.assign(Object.create(null) as object, healthDocument());
    expect(Object.getPrototypeOf(document)).toBe(null);
    healthSource.set(document);
    expect((await health.refresh()).outcome).toBe("OK");

    const response = await api.handle({
      method: "GET",
      path: "/v1/health",
      authorization: bearer(FAKE_OPERATOR_TOKEN),
      body: undefined,
    });
    expect(response.status).toBe(200);
    // Base's bytes: the clean-process encoding of what the body parses to.
    expect(response.body).toBe(`${JSON.stringify(JSON.parse(response.body), null, 2)}\n`);
    const body = JSON.parse(response.body) as { available: boolean; report: unknown };
    expect(body.available).toBe(true);
    expect(body.report).toEqual(healthDocument());
  });

  it("an Array SUBCLASS inside the document is refused AT THE DOOR, which is where base refused it too", async () => {
    // Pre-existing, and not this round's: `buildDoor`/`readPlainData` refuse a
    // non-plain prototype and are untouched by `SER-3`. The point of pinning it
    // is that the refusal happens at the DOOR — the read is counted, the last
    // good report is retained, and the response still encodes — rather than
    // becoming a 500 from the response encoder.
    class Queues extends Array<unknown> {}
    const { api, health, healthSource } = createHarness();
    healthSource.set(healthDocument());
    expect((await health.refresh()).outcome).toBe("OK");

    const base = healthDocument();
    healthSource.set({ ...base, queues: new Queues(...base.queues) });
    const refused = await health.refresh();
    expect(refused.outcome).toBe("REFUSED");

    const response = await api.handle({
      method: "GET",
      path: "/v1/health",
      authorization: bearer(FAKE_OPERATOR_TOKEN),
      body: undefined,
    });
    expect(response.status).toBe(200);
    expect((JSON.parse(response.body) as { report: unknown }).report).toEqual(base);
  });

  it("the null-prototype counters this process really builds encode exactly as base encoded them", async () => {
    // `readCounts()` and `sortedCounts()` return `Object.create(null)` records
    // (`health-source.ts`, `api.ts`), and they are embedded in the `/v1/health`
    // body. The encoder accepts a null prototype for the same reason
    // `JSON.stringify` does: it has no inherited meaning to consult.
    const { api, health, healthSource } = createHarness();
    healthSource.set(healthDocument());
    await health.refresh();
    expect(Object.getPrototypeOf(health.readCounts())).toBe(null);

    const response = await api.handle({
      method: "GET",
      path: "/v1/health",
      authorization: bearer(FAKE_OPERATOR_TOKEN),
      body: undefined,
    });
    expect((JSON.parse(response.body) as { reads: unknown }).reads).toEqual({ OK: 1 });
    expect(response.body).toBe(`${JSON.stringify(JSON.parse(response.body), null, 2)}\n`);
  });
});

describe("the two bounds compose at the ROOT depth only (the review's measurement, pinned)", () => {
  it("a tree the door accepts at exactly MAX_DEPTH is refused once it is EMBEDDED one level deeper", () => {
    const accepted = readPlainData(chain(MAX_DEPTH), "value");
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    // At the root: encodable, byte-identically to the clean process.
    expect(encodePlainJson(accepted.value, { indent: 2 })).toBe(
      JSON.stringify(chain(MAX_DEPTH), null, 2),
    );
    // Embedded the way `#health()` embeds a report: refused.
    expect(() => encodePlainJson({ report: accepted.value }, { indent: 2 })).toThrow();
    // `JSON.stringify` has no depth bound at all, so base encoded both.
    expect(() => JSON.stringify({ report: accepted.value }, null, 2)).not.toThrow();
    // What makes today's composition safe is BOUND 1, not the alignment: the
    // health schema's deepest accepted document is a handful of levels.
    const deepest = readPlainData(healthDocument(), "value");
    expect(deepest.ok).toBe(true);
    expect(depthOf(healthDocument())).toBeLessThan(10);
  });
});

/** The deepest container nesting in `value`; a scalar is depth 0. */
function depthOf(value: unknown): number {
  if (typeof value !== "object" || value === null) return 0;
  let deepest = 0;
  for (const member of Object.values(value)) deepest = Math.max(deepest, depthOf(member));
  return deepest + 1;
}
