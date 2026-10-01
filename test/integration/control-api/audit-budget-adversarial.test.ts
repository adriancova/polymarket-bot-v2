/**
 * `CONTROL-1` — the M-3 INVARIANT under a SEEDED, RANDOMIZED adversarial
 * request sequence.
 *
 * > No request sequence from an actor without mutation authority can prevent
 * > an authorized actor's kill-switch engage, or any other safety-direction
 * > action, from being executed and audited.
 *
 * Three properties, each checked over many seeds (a failure message names its
 * seed, so a failing sequence replays exactly):
 *
 * 1. **The invariant as stated.** Actors WITHOUT mutation authority — an
 *    anonymous caller, a wrong token, a `READ`-only operator — send a random
 *    sequence: any method, any path (known, unknown, malformed parameters),
 *    any body (forbidden keys in random case and depth, valid control bodies,
 *    junk). The audit log never grows, and afterwards an authorized GLOBAL
 *    engage and a pause both apply and are audited. This holds with NO
 *    reserve at all (`auditSafetyReserve` 0), at `WP-240` r1's capacity 3:
 *    it is the mutation-authority gate in `api.ts`, not the budget.
 * 2. **The stronger property the budget adds.** Actors that DO hold mutation
 *    grants — an operator with `STRATEGY_CONTROL` only, and a `KILL_SWITCH`
 *    holder doing everything except engage — join the sequence, with a
 *    capacity small enough that the ordinary tier is certainly exhausted
 *    (asserted, so the property is not vacuous). An authorized engage
 *    afterwards still applies and is audited: nothing but an applied engage
 *    can use the last `R` records.
 * 3. **Acceptance 2 throughout.** After EVERY request: the control plane's
 *    state changed only if exactly one `APPLIED` record was appended for it,
 *    a `200` mutation's `auditRecordId` is that record, and no actor without
 *    mutation authority ever appended anything.
 * 4. **A `KILL_SWITCH` holder's own engages cannot spend the reserve on a
 *    repeat or a weakening** (`CONTROL-1` r1, closing `CONTROL1-J-M1`). The
 *    switcher engages random actions at two scopes, releases them, and the
 *    other actors fill the ordinary tier. After every request an INDEPENDENT
 *    oracle checks that only a strengthening (a new switch, an escalation to
 *    `FULL_HALT`, a `RUNNING → PAUSED` pause) sits in the reserved band, and
 *    that no `FULL_HALT` was relaxed except by a release; at the end a new
 *    switch still engages.
 *
 * Driven through the handler seam for volume (thousands of requests), and one
 * seed again over REAL HTTP so the transport is shown to change no answer.
 */

import { describe, expect, it } from "vitest";

import {
  CONTROL_API_ROUTE_TABLE,
  FORBIDDEN_CONTROL_KEYS,
  type ApiRequest,
  type ApiResponse,
} from "@polymarket-bot/control-api";
import { FAKE_OPERATOR_TOKEN, FAKE_READER_TOKEN, bearer, createHarness } from "@polymarket-bot/control-api/testing";

import { serveControlApi } from "./support/client.js";

/** mulberry32: a tiny, well-known, seedable PRNG. Deterministic per seed. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

type Random = () => number;
const pick = <T>(random: Random, items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;

const STRATEGIST_TOKEN = "fake-paper-strategist-token-not-a-credential-0003";
const KILL_SWITCH_TOKEN = "fake-paper-killswitch-token-not-a-credential-0004";

const OPERATORS = [
  { operatorId: "operator-a", token: FAKE_OPERATOR_TOKEN, grants: ["READ", "STRATEGY_CONTROL", "KILL_SWITCH"] as const },
  { operatorId: "reader-b", token: FAKE_READER_TOKEN, grants: ["READ"] as const },
  { operatorId: "strategist-c", token: STRATEGIST_TOKEN, grants: ["READ", "STRATEGY_CONTROL"] as const },
  { operatorId: "switcher-d", token: KILL_SWITCH_TOKEN, grants: ["READ", "KILL_SWITCH"] as const },
];

const REGISTERED = ["sb-1", "sb-2", "sb-3"] as const;

/** An authorization header for each adversary class. */
const ANONYMOUS_HEADERS: readonly (string | undefined)[] = [
  undefined,
  "",
  "Bearer ",
  "Basic b3BlcmF0b3ItYTpwYXNzd29yZA==",
  bearer("not-a-configured-token-and-not-a-credential-00000"),
  bearer(FAKE_OPERATOR_TOKEN.toUpperCase()),
];

function randomCase(random: Random, key: string): string {
  return [...key].map((character) => (random() < 0.5 ? character.toUpperCase() : character)).join("");
}

function forbiddenBody(random: Random): Record<string, unknown> {
  const key = randomCase(random, pick(random, FORBIDDEN_CONTROL_KEYS));
  const value = pick(random, ["LIVE", true, "100", { nested: "x" }, null]);
  const shape = Math.floor(random() * 4);
  if (shape === 0) return { [key]: value, reason: "adversarial" };
  if (shape === 1) return { config: { [key]: value }, reason: "adversarial" };
  if (shape === 2) return { a: [{ b: { [key]: value } }] };
  return { scope: "GLOBAL", scopeRef: null, action: "FULL_HALT", reason: "adversarial", [key]: value };
}

function randomBody(random: Random): unknown {
  const kind = Math.floor(random() * 9);
  switch (kind) {
    case 0:
      return undefined;
    case 1:
    case 2:
      return forbiddenBody(random);
    case 3:
      return { reason: pick(random, ["a stated reason", "x", "maintenance window"]) };
    case 4:
      return {
        scope: pick(random, ["GLOBAL", "MARKET", "ACCOUNT", "STRATEGY_INSTANCE", "EVERYTHING"]),
        scopeRef: pick(random, [null, "market-1", "sb-1", ""]),
        action: pick(random, ["FULL_HALT", "HALT_NEW_ENTRIES", "CANCEL_ALL", "SELL_EVERYTHING"]),
        reason: "adversarial engage",
      };
    case 5:
      return {
        scope: pick(random, ["GLOBAL", "MARKET"]),
        scopeRef: pick(random, [null, "market-1"]),
        authoritativeSnapshotApplied: pick(random, [true, false]),
        reason: "adversarial release",
      };
    case 6:
      return pick(random, [1, "x", [], null, true]);
    case 7:
      return { reason: 42 };
    default:
      return { reason: "ok reason", extra: pick(random, ["force", "override"]) };
  }
}

function randomPath(random: Random): string {
  if (random() < 0.75) {
    const route = pick(random, CONTROL_API_ROUTE_TABLE);
    const parameter = pick(random, [
      ...REGISTERED,
      "never-registered",
      "%ZZ",
      "%E0%A4%A",
      "a%2Fb",
      "sb%00",
      "x".repeat(300),
      "sb%20one",
    ]);
    return route.path.replace(":instanceId", parameter);
  }
  return pick(random, ["/", "/v1", "/v1/nope", "//v1/run-state", "/V1/KILL-SWITCH", "/v1/kill-switch/release/x", "/v1/run-mode"]);
}

interface Adversary {
  readonly name: string;
  readonly mutationAuthority: boolean;
  header(random: Random): string | undefined;
}

const NO_AUTHORITY: readonly Adversary[] = [
  { name: "anonymous", mutationAuthority: false, header: (random) => pick(random, ANONYMOUS_HEADERS) },
  { name: "reader-b", mutationAuthority: false, header: () => bearer(FAKE_READER_TOKEN) },
];

const WITH_AUTHORITY: readonly Adversary[] = [
  { name: "strategist-c", mutationAuthority: true, header: () => bearer(STRATEGIST_TOKEN) },
  { name: "switcher-d", mutationAuthority: true, header: () => bearer(KILL_SWITCH_TOKEN) },
];

function randomRequest(random: Random, adversaries: readonly Adversary[]): { request: ApiRequest; adversary: Adversary } {
  const adversary = pick(random, adversaries);
  let method = pick(random, ["GET", "POST", "POST", "POST", "PUT", "DELETE", "HEAD"]);
  const path = randomPath(random);
  // The ONE thing the budget property excludes: an APPLIED kill-switch engage.
  // A switcher's POST /v1/kill-switch is turned into a GET, so every other
  // request a kill-switch holder can send stays in the sequence.
  if (adversary.name === "switcher-d" && path === "/v1/kill-switch" && method === "POST") method = "GET";
  return {
    adversary,
    request: { method, path, authorization: adversary.header(random), body: randomBody(random) },
  };
}

type Harness = ReturnType<typeof createHarness>;

function stateOf(harness: Harness): string {
  return JSON.stringify({
    strategies: harness.controlPlane.strategies(),
    killSwitches: harness.controlPlane.killSwitches(),
  });
}

function receiptId(response: ApiResponse): unknown {
  try {
    return (JSON.parse(response.body) as Record<string, unknown>)["auditRecordId"];
  } catch {
    return undefined;
  }
}

/** Sends one request and checks acceptance 2 and the no-authority rule around it. */
async function sendChecked(harness: Harness, request: ApiRequest, adversary: Adversary, label: string): Promise<ApiResponse> {
  const recordsBefore = harness.audit.records().length;
  const stateBefore = stateOf(harness);
  const response = await harness.api.handle(request);
  const appended = harness.audit.records().slice(recordsBefore);
  const stateAfter = stateOf(harness);

  if (!adversary.mutationAuthority) {
    expect(appended, `${label}: an actor without mutation authority appended`).toEqual([]);
  }
  const applied = appended.filter((record) => record.outcome === "APPLIED");
  if (stateAfter !== stateBefore) {
    // A state change happened ONLY with exactly one APPLIED record for it.
    expect(applied, `${label}: a state change without exactly one APPLIED record`).toHaveLength(1);
    expect(response.status, label).toBe(200);
    expect(receiptId(response), label).toBe(applied[0]?.recordId);
  } else {
    expect(applied, `${label}: an APPLIED record with no state change`).toEqual([]);
  }
  expect(appended.length, `${label}: more than one record for one request`).toBeLessThanOrEqual(1);
  expect(response.status, `${label}: a 500`).not.toBe(500);
  return response;
}

async function engageAsAuthorizedOperator(harness: Harness, label: string): Promise<void> {
  const operator = { name: "operator-a", mutationAuthority: true, header: () => bearer(FAKE_OPERATOR_TOKEN) };
  const engage = await sendChecked(
    harness,
    {
      method: "POST",
      path: "/v1/kill-switch",
      authorization: bearer(FAKE_OPERATOR_TOKEN),
      body: { scope: "GLOBAL", scopeRef: null, action: "FULL_HALT", reason: "incident: halt everything" },
    },
    operator,
    `${label} final engage`,
  );
  expect(engage.status, `${label}: the authorized engage was not executed`).toBe(200);
  const last = harness.audit.records().at(-1);
  expect(last, `${label}: the engage was not audited`).toMatchObject({
    action: "KILL_SWITCH_ENGAGE",
    outcome: "APPLIED",
    actor: "operator-a",
  });
  expect(harness.controlPlane.killSwitches().some((entry) => entry.scope === "GLOBAL")).toBe(true);
}

const SEEDS = Array.from({ length: 24 }, (_, index) => 0x5eed0000 + index * 7919);

describe("M-3 invariant: actors WITHOUT mutation authority cannot block a safety action (no reserve needed)", () => {
  it.each(SEEDS)("seed %i: 300 random requests, then a pause and an engage both apply and are audited", async (seed) => {
    const random = prng(seed);
    // WP-240 r1's capacity, and NO reserve: the gate alone carries this.
    const harness = createHarness({ auditCapacity: 3, auditSafetyReserve: 0, operators: OPERATORS });
    for (const id of REGISTERED) harness.controlPlane.register(id, "2026-10-01T00:00:00.000Z");
    let readerModeRaises = 0;
    for (let step = 0; step < 300; step += 1) {
      const { request, adversary } = randomRequest(random, NO_AUTHORITY);
      const response = await sendChecked(harness, request, adversary, `seed ${String(seed)} step ${String(step)}`);
      if (adversary.name === "reader-b" && response.body.includes('"CONTROL_MODE_RAISE_REFUSED"')) readerModeRaises += 1;
    }
    // NOT VACUOUS: the sequence really sent the M-3 vector — far more reader
    // mode-raise refusals than the capacity of 3 that WP-240 r1 filled with five.
    expect(readerModeRaises, `seed ${String(seed)}`).toBeGreaterThan(10);
    expect(harness.audit.records(), `seed ${String(seed)}`).toEqual([]);

    const pause = await harness.api.handle({
      method: "POST",
      path: "/v1/strategies/sb-1/pause",
      authorization: bearer(FAKE_OPERATOR_TOKEN),
      body: { reason: "incident: pause sb-1" },
    });
    expect(pause.status, `seed ${String(seed)}: the authorized pause`).toBe(200);
    await engageAsAuthorizedOperator(harness, `seed ${String(seed)}`);
    expect(harness.audit.records().map((record) => `${record.action}|${record.outcome}`)).toEqual([
      "STRATEGY_PAUSE|APPLIED",
      "KILL_SWITCH_ENGAGE|APPLIED",
    ]);
  });
});

describe("the budget: even actors WITH mutation grants cannot use the kill-switch tier without engaging", () => {
  it.each(SEEDS)("seed %i: 400 random requests from every actor class except an engage, then an engage applies", async (seed) => {
    const random = prng(seed ^ 0xa5a5a5a5);
    // Capacity 12, reserve 2: ordinary ≤ 8, pauses ≤ 10, engages ≤ 12.
    const harness = createHarness({ auditCapacity: 12, auditSafetyReserve: 2, operators: OPERATORS });
    for (const id of REGISTERED) harness.controlPlane.register(id, "2026-10-01T00:00:00.000Z");
    for (let step = 0; step < 400; step += 1) {
      const { request, adversary } = randomRequest(random, [...NO_AUTHORITY, ...WITH_AUTHORITY]);
      await sendChecked(harness, request, adversary, `seed ${String(seed)} step ${String(step)}`);
    }
    // NOT VACUOUS: the ordinary tier really was exhausted by the sequence…
    expect(harness.auditBudget.admitted, `seed ${String(seed)}: the ordinary tier was never filled`).toBeGreaterThanOrEqual(
      harness.auditBudget.limitFor("ORDINARY"),
    );
    // …and nothing in it was an engage, so the kill-switch tier is untouched.
    expect(harness.audit.records().some((record) => record.action === "KILL_SWITCH_ENGAGE" && record.outcome === "APPLIED")).toBe(false);
    expect(harness.auditBudget.admitted).toBeLessThanOrEqual(harness.auditBudget.limitFor("SAFETY_DIRECTION"));
    // No actor without mutation authority appears in the log at all.
    expect(harness.audit.records().every((record) => ["strategist-c", "switcher-d"].includes(record.actor))).toBe(true);

    await engageAsAuthorizedOperator(harness, `seed ${String(seed)}`);
  });

  it("a seed whose sequence also fills the SAFETY tier with real pauses still leaves the engage its R records", async () => {
    // Deterministic worst case: the ordinary tier filled by refusals, then the
    // safety tier filled by applied pauses of registered instances.
    const harness = createHarness({ auditCapacity: 8, auditSafetyReserve: 2, operators: OPERATORS });
    for (const id of REGISTERED) harness.controlPlane.register(id, "2026-10-01T00:00:00.000Z");
    const strategist = WITH_AUTHORITY[0] as Adversary;
    for (let index = 0; index < 10; index += 1) {
      await sendChecked(
        harness,
        { method: "POST", path: "/v1/kill-switch", authorization: bearer(STRATEGIST_TOKEN), body: { runMode: "LIVE" } },
        strategist,
        `fill ${String(index)}`,
      );
    }
    expect(harness.auditBudget.admitted).toBe(4);
    for (const id of REGISTERED) {
      await sendChecked(
        harness,
        { method: "POST", path: `/v1/strategies/${id}/pause`, authorization: bearer(STRATEGIST_TOKEN), body: { reason: "halt" } },
        strategist,
        `pause ${id}`,
      );
    }
    // Two pauses fit (C − R = 6); the third is refused 503, and nothing moved for it.
    expect(harness.controlPlane.strategies().map((entry) => entry.state)).toEqual(["PAUSED", "PAUSED", "RUNNING"]);
    expect(harness.auditBudget.admitted).toBe(6);
    await engageAsAuthorizedOperator(harness, "worst case");
    expect(harness.auditBudget.admitted).toBe(7);
  });
});

/**
 * `CONTROL-1` r1, closing `CONTROL1-J-M1` — an INDEPENDENT oracle for what may
 * occupy the reserved band: an applied engage that engaged a switch where
 * none was or escalated one to `FULL_HALT`, or an applied pause of a `RUNNING`
 * instance. Written from the documents, not by calling `auditBudgetTier`, so a
 * tier function that admitted a repeat or a weakening would be caught here.
 */
function earnsTheReserve(record: { action: string; outcome: string; priorState: unknown; resultingState: unknown }): boolean {
  if (record.outcome !== "APPLIED") return false;
  const prior = record.priorState as Record<string, unknown>;
  const resulting = record.resultingState as Record<string, unknown>;
  if (record.action === "KILL_SWITCH_ENGAGE") {
    if (prior["engaged"] === "false") return true;
    return prior["action"] !== "FULL_HALT" && resulting["action"] === "FULL_HALT";
  }
  if (record.action === "STRATEGY_PAUSE") return prior["state"] === "RUNNING" && resulting["state"] === "PAUSED";
  return false;
}

const SWITCH_ACTIONS = ["HALT_NEW_ENTRIES", "CANCEL_ALL", "CANCEL_MARKET", "MANAGE_POSITIONS_ONLY", "FULL_HALT"] as const;
const SWITCH_SCOPES: readonly (readonly [string, string | null])[] = [
  ["GLOBAL", null],
  ["MARKET", "market-1"],
];

describe("CONTROL1-J-M1: a KILL_SWITCH holder's own engages and releases cannot spend the reserve on a repeat or a weakening", () => {
  it.each(SEEDS)("seed %i: 400 random engages, releases and refusals; the band holds only strengthenings; a new halt still engages", async (seed) => {
    const random = prng(seed ^ 0x3c3c3c3c);
    // Capacity 20, reserve 6: ordinary ≤ 8. Once it is full, two scopes can
    // take at most 2 + 2 strengthening engages and three registered instances
    // at most 3 pauses — 15 < 20, so a NEW switch must still fit at the end.
    const harness = createHarness({ auditCapacity: 20, auditSafetyReserve: 6, operators: OPERATORS });
    for (const id of REGISTERED) harness.controlPlane.register(id, "2026-10-01T00:00:00.000Z");
    const switcher = WITH_AUTHORITY[1] as Adversary;
    let refusedNonStrengthening = 0;

    for (let step = 0; step < 400; step += 1) {
      const label = `seed ${String(seed)} step ${String(step)}`;
      const roll = random();
      const [scope, scopeRef] = pick(random, SWITCH_SCOPES);
      let request: ApiRequest;
      let adversary: Adversary;
      if (roll < 0.5) {
        adversary = switcher;
        request = {
          method: "POST",
          path: "/v1/kill-switch",
          authorization: bearer(KILL_SWITCH_TOKEN),
          body: { scope, scopeRef, action: pick(random, SWITCH_ACTIONS), reason: "adversarial engage" },
        };
      } else if (roll < 0.62) {
        adversary = switcher;
        request = {
          method: "POST",
          path: "/v1/kill-switch/release",
          authorization: bearer(KILL_SWITCH_TOKEN),
          body: { scope, scopeRef, authoritativeSnapshotApplied: true, reason: "adversarial release" },
        };
      } else {
        ({ request, adversary } = randomRequest(random, [...NO_AUTHORITY, ...WITH_AUTHORITY]));
      }

      const before = new Map(harness.controlPlane.killSwitches().map((entry) => [`${entry.scope}:${entry.scopeRef ?? ""}`, entry.action]));
      const response = await sendChecked(harness, request, adversary, label);
      const after = new Map(harness.controlPlane.killSwitches().map((entry) => [`${entry.scope}:${entry.scopeRef ?? ""}`, entry.action]));
      const code = response.status === 200 ? "" : String((JSON.parse(response.body) as Record<string, unknown>)["code"]);
      if (code === "CONTROL_ALREADY_IN_STATE" || code === "CONTROL_ENGAGE_WOULD_WEAKEN") refusedNonStrengthening += 1;

      // A FULL_HALT is never RELAXED by an engage: it stays, or a 200 release removed it.
      for (const [key, action] of before) {
        if (action !== "FULL_HALT") continue;
        const now = after.get(key);
        if (now === undefined) {
          expect(request.path, `${label}: ${key} left FULL_HALT other than by a release`).toBe("/v1/kill-switch/release");
          expect(response.status, label).toBe(200);
        } else {
          expect(now, `${label}: ${key} was relaxed from FULL_HALT by an engage`).toBe("FULL_HALT");
        }
      }
      // Nothing but a strengthening sits in the reserved band (the oracle above).
      const band = harness.audit.records().slice(harness.auditBudget.limitFor("ORDINARY"));
      for (const record of band) {
        expect(earnsTheReserve(record), `${label}: ${record.action}|${record.outcome} is in the reserved band`).toBe(true);
      }
    }

    // NOT VACUOUS: the ordinary tier was exhausted, and the switcher really did
    // send repeats and weakenings that were refused.
    expect(harness.auditBudget.admitted, `seed ${String(seed)}`).toBeGreaterThanOrEqual(harness.auditBudget.limitFor("ORDINARY"));
    expect(refusedNonStrengthening, `seed ${String(seed)}`).toBeGreaterThan(20);

    // A NEW switch still engages and is audited.
    const fresh = await sendChecked(
      harness,
      {
        method: "POST",
        path: "/v1/kill-switch",
        authorization: bearer(FAKE_OPERATOR_TOKEN),
        body: { scope: "MARKET", scopeRef: "market-final", action: "FULL_HALT", reason: "incident: a new halt" },
      },
      { name: "operator-a", mutationAuthority: true, header: () => bearer(FAKE_OPERATOR_TOKEN) },
      `seed ${String(seed)} final engage`,
    );
    expect(fresh.status, `seed ${String(seed)}: the new halt was not executed`).toBe(200);
    expect(harness.audit.records().at(-1)).toMatchObject({ action: "KILL_SWITCH_ENGAGE", outcome: "APPLIED", scopeRef: "market-final" });
  });
});

describe("one seed over REAL HTTP: the transport changes no answer", () => {
  it("seed 0x5eed0000: readers and anonymous callers cannot block the engage, over the wire", async () => {
    const served = await serveControlApi({ auditCapacity: 3, auditSafetyReserve: 1, operators: OPERATORS });
    try {
      for (const id of REGISTERED) served.controlPlane.register(id, "2026-10-01T00:00:00.000Z");
      const random = prng(0x5eed0000);
      for (let step = 0; step < 150; step += 1) {
        const { request } = randomRequest(random, NO_AUTHORITY);
        const header = request.authorization;
        const token = header?.startsWith("Bearer ") === true ? header.slice("Bearer ".length) : undefined;
        // Non-bearer headers cannot be spelled by the client helper; an
        // absent token is the same class (no usable credential).
        const response = await served.call(request.method, request.path, {
          ...(token === undefined || token === "" ? {} : { token }),
          ...(request.body === undefined ? {} : { body: request.body }),
        });
        expect(response.status, `step ${String(step)}`).not.toBe(500);
        expect(served.audit.records(), `step ${String(step)}`).toEqual([]);
      }
      const engage = await served.call("POST", "/v1/kill-switch", {
        token: FAKE_OPERATOR_TOKEN,
        body: { scope: "GLOBAL", scopeRef: null, action: "FULL_HALT", reason: "incident: halt everything" },
      });
      expect(engage.status).toBe(200);
      expect(served.audit.records().map((record) => `${record.actor}|${record.action}|${record.outcome}`)).toEqual([
        "operator-a|KILL_SWITCH_ENGAGE|APPLIED",
      ]);
    } finally {
      await served.server.close();
    }
  });
});
