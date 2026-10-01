/**
 * `CONTROL-1` r1 — `CONTROL1-J-M1`: a repeated or weakening kill-switch engage
 * cannot spend the audit reserve, and so cannot block a stronger halt. Over
 * REAL HTTP, through `support/client.ts` (the composition `main.ts` builds,
 * with registered instances so pauses can be measured too);
 * `shipped-root-engage-reserve.test.ts` drives the same sequences through
 * `main.ts`'s `startup()` itself.
 *
 * ## The finding (both verifiers, over real HTTP, at round-0 commit `3097d39`)
 *
 * Every applied engage was admitted under the top budget tier, and an engage
 * over an engaged switch overwrote it unconditionally. So:
 *
 * - **H1a** (C=3, R=1): engage `FULL_HALT` 200 → release 503 (ordinary tier
 *   full) → `HALT_NEW_ENTRIES` 200 → `HALT_NEW_ENTRIES` 200 → `FULL_HALT` 503.
 *   The switch was left WEAKENED and the full halt could not be restored.
 * - **H1b** (C=12, R=2): with the ordinary tier full, six IDENTICAL engages
 *   went 200,200,200,200,503,503 — three no-op repeats spent all 2R reserved
 *   records, after which a GLOBAL or MARKET `FULL_HALT`, and a pause, were 503.
 * - **H1c** (C=12, R=2): with the ordinary tier full, the evidence-bearing
 *   release was 503 but the weakening engage was 200 — an un-halting path past
 *   the release gate.
 *
 * Each test below FAILS at `3097d39` (the `CONTROL-1` r1 handoff records the
 * run) and passes once an engage that repeats is refused
 * `CONTROL_ALREADY_IN_STATE`, one that would leave `FULL_HALT` is refused
 * `CONTROL_ENGAGE_WOULD_WEAKEN`, and only a new switch or an escalation to
 * `FULL_HALT` is admitted under the kill-switch tier.
 */

import { afterEach, describe, expect, it } from "vitest";

import { serveControlApi, type ServedApi } from "./support/client.js";

const SWITCHER = "fake-paper-switcher-token-not-a-credential-r1-0004";
const STRATEGIST = "fake-paper-strategist-token-not-a-credential-r1-0005";

const OPERATORS = [
  { operatorId: "switcher-d", token: SWITCHER, grants: ["READ", "KILL_SWITCH"] as const },
  { operatorId: "strategist-c", token: STRATEGIST, grants: ["READ", "STRATEGY_CONTROL"] as const },
];

let served: ServedApi | undefined;

afterEach(async () => {
  await served?.server.close();
  served = undefined;
});

async function start(auditCapacity: number, auditSafetyReserve: number): Promise<ServedApi> {
  served = await serveControlApi({ operators: OPERATORS, auditCapacity, auditSafetyReserve });
  served.controlPlane.register("sb-1", "2026-10-01T00:00:00.000Z");
  return served;
}

type Action = "HALT_NEW_ENTRIES" | "CANCEL_ALL" | "CANCEL_MARKET" | "MANAGE_POSITIONS_ONLY" | "FULL_HALT";

/** One engage by the KILL_SWITCH holder; answers `status` or `status code`. */
async function engage(api: ServedApi, action: Action, scope = "GLOBAL", scopeRef: string | null = null): Promise<string> {
  const response = await api.call("POST", "/v1/kill-switch", {
    token: SWITCHER,
    body: { scope, scopeRef, action, reason: `engage ${action}` },
  });
  return answer(response.status, response.json());
}

async function release(api: ServedApi, scope = "GLOBAL", scopeRef: string | null = null): Promise<string> {
  const response = await api.call("POST", "/v1/kill-switch/release", {
    token: SWITCHER,
    body: { scope, scopeRef, authoritativeSnapshotApplied: true, reason: "reconciled against a snapshot" },
  });
  return answer(response.status, response.json());
}

function answer(status: number, body: unknown): string {
  return status === 200 ? "200" : `${String(status)} ${String((body as Record<string, unknown>)["code"])}`;
}

/** The strategist fills the ORDINARY tier with audited refusals (unknown-instance pauses). */
async function fillOrdinary(api: ServedApi, requests: number): Promise<void> {
  for (let index = 0; index < requests; index += 1) {
    const response = await api.call("POST", `/v1/strategies/unknown-${String(index)}/pause`, {
      token: STRATEGIST,
      body: { reason: "filling the ordinary tier" },
    });
    expect(response.status).toBe(409);
  }
  expect(api.auditBudget.admitted).toBeGreaterThanOrEqual(api.auditBudget.limitFor("ORDINARY"));
}

function switchActions(api: ServedApi): readonly string[] {
  return api.controlPlane.killSwitches().map((entry) => `${entry.scope}:${entry.scopeRef ?? ""}:${entry.action}`);
}

describe("CONTROL1-J-M1: no repeated or weakening engage can spend the reserve", () => {
  it("H1a (C=3, R=1): the weakening engages are REFUSED, the full halt stands, and new switches still engage", async () => {
    const api = await start(3, 1);
    const sequence = [
      await engage(api, "FULL_HALT"),
      await release(api),
      await engage(api, "HALT_NEW_ENTRIES"),
      await engage(api, "HALT_NEW_ENTRIES"),
      await engage(api, "FULL_HALT"),
    ];
    expect(sequence).toEqual([
      "200",
      "503 CONTROL_NOT_AUDITABLE",
      "409 CONTROL_ENGAGE_WOULD_WEAKEN",
      "409 CONTROL_ENGAGE_WOULD_WEAKEN",
      "409 CONTROL_ALREADY_IN_STATE",
    ]);
    expect(switchActions(api)).toEqual(["GLOBAL::FULL_HALT"]);
    // The kill-switch tier was never touched by the refusals: both of its
    // records are still there for switches that really engage.
    expect(await engage(api, "FULL_HALT", "MARKET", "m-1")).toBe("200");
    expect(await engage(api, "HALT_NEW_ENTRIES", "MARKET", "m-2")).toBe("200");
    expect(api.audit.records().map((record) => `${record.action}|${record.outcome}`)).toEqual([
      "KILL_SWITCH_ENGAGE|APPLIED",
      "KILL_SWITCH_ENGAGE|APPLIED",
      "KILL_SWITCH_ENGAGE|APPLIED",
    ]);
  });

  it("H1b (C=12, R=2): identical re-engages are REFUSED, so a pause and both FULL_HALTs still fit", async () => {
    const api = await start(12, 2);
    await fillOrdinary(api, 20);
    expect(api.audit.records()).toHaveLength(8);

    const repeats: string[] = [];
    for (let index = 0; index < 6; index += 1) repeats.push(await engage(api, "HALT_NEW_ENTRIES"));
    expect(repeats).toEqual(["200", ...Array<string>(5).fill("409 CONTROL_ALREADY_IN_STATE")]);
    expect(api.audit.records()).toHaveLength(9);

    const pause = await api.call("POST", "/v1/strategies/sb-1/pause", {
      token: STRATEGIST,
      body: { reason: "incident: pause sb-1" },
    });
    expect(pause.status).toBe(200);
    expect(await engage(api, "FULL_HALT")).toBe("200");
    expect(await engage(api, "FULL_HALT", "MARKET", "m-1")).toBe("200");
    expect(switchActions(api)).toEqual(["GLOBAL::FULL_HALT", "MARKET:m-1:FULL_HALT"]);
    expect(api.audit.records()).toHaveLength(12);
  });

  it("H1c (C=12, R=2): with release 503, the weakening engage is REFUSED too — no un-halting path past the release gate", async () => {
    const api = await start(12, 2);
    expect(await engage(api, "FULL_HALT")).toBe("200");
    await fillOrdinary(api, 20);
    expect(await release(api)).toBe("503 CONTROL_NOT_AUDITABLE");
    for (const weaker of ["HALT_NEW_ENTRIES", "CANCEL_ALL", "CANCEL_MARKET", "MANAGE_POSITIONS_ONLY"] as const) {
      expect(await engage(api, weaker), weaker).toBe("409 CONTROL_ENGAGE_WOULD_WEAKEN");
    }
    expect(switchActions(api)).toEqual(["GLOBAL::FULL_HALT"]);
    // The same is true with ROOM in the ordinary tier: relaxing a full halt
    // is a release, against evidence, whatever the budget says.
    const roomy = await serveControlApi({ operators: OPERATORS, auditCapacity: 64, auditSafetyReserve: 2 });
    try {
      expect(await engage(roomy, "FULL_HALT")).toBe("200");
      expect(await engage(roomy, "CANCEL_ALL")).toBe("409 CONTROL_ENGAGE_WOULD_WEAKEN");
      expect(switchActions(roomy)).toEqual(["GLOBAL::FULL_HALT"]);
      expect(roomy.audit.records().map((record) => `${record.action}|${record.outcome}`)).toEqual([
        "KILL_SWITCH_ENGAGE|APPLIED",
        "KILL_SWITCH_ENGAGE|REFUSED",
      ]);
    } finally {
      await roomy.server.close();
    }
  });

  it("an UNORDERED change is applied while the ordinary tier has room, refused 503 once it is full; an escalation still fits", async () => {
    const api = await start(12, 2);
    expect(await engage(api, "HALT_NEW_ENTRIES")).toBe("200");
    // With room: WP-240's overwrite, admitted ORDINARY.
    expect(await engage(api, "CANCEL_ALL")).toBe("200");
    expect(switchActions(api)).toEqual(["GLOBAL::CANCEL_ALL"]);
    await fillOrdinary(api, 20);
    // Full: the unordered change is ordinary, so it is 503 — like a release.
    expect(await engage(api, "HALT_NEW_ENTRIES")).toBe("503 CONTROL_NOT_AUDITABLE");
    expect(await engage(api, "MANAGE_POSITIONS_ONLY")).toBe("503 CONTROL_NOT_AUDITABLE");
    expect(switchActions(api)).toEqual(["GLOBAL::CANCEL_ALL"]);
    // The escalation is a strengthening, and the reserve is there for it.
    expect(await engage(api, "FULL_HALT")).toBe("200");
    expect(switchActions(api)).toEqual(["GLOBAL::FULL_HALT"]);
  });

  it("once the ordinary tier is full, one scope takes at most TWO reserved records — an engage and an escalation", async () => {
    const api = await start(16, 5);
    await fillOrdinary(api, 20);
    const admitted = api.auditBudget.admitted;
    const sequence: string[] = [];
    for (const action of [
      "HALT_NEW_ENTRIES",
      "CANCEL_ALL",
      "MANAGE_POSITIONS_ONLY",
      "HALT_NEW_ENTRIES",
      "FULL_HALT",
      "FULL_HALT",
      "CANCEL_MARKET",
      "HALT_NEW_ENTRIES",
    ] as const) {
      sequence.push(await engage(api, action, "MARKET", "m-9"));
    }
    expect(sequence).toEqual([
      "200",
      "503 CONTROL_NOT_AUDITABLE",
      "503 CONTROL_NOT_AUDITABLE",
      "409 CONTROL_ALREADY_IN_STATE",
      "200",
      "409 CONTROL_ALREADY_IN_STATE",
      "409 CONTROL_ENGAGE_WOULD_WEAKEN",
      "409 CONTROL_ENGAGE_WOULD_WEAKEN",
    ]);
    expect(api.auditBudget.admitted - admitted).toBe(2);
  });
});
