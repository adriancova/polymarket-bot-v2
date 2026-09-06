/**
 * Authentication and explicit authorization — §15, under the INTERPRETATION
 * `auth.ts` states.
 *
 * The load-bearing assertions are: a token never appears anywhere a caller can
 * see, an unknown token is refused, and authenticating grants nothing.
 */

import { describe, expect, it } from "vitest";

import { OPERATOR_GRANTS, OperatorRegistry, hasGrant } from "./auth.js";

const TOKEN = "fake-paper-operator-token-not-a-credential-0001";
const OTHER = "fake-paper-readonly-token-not-a-credential-0002";

const registry = new OperatorRegistry([
  { operatorId: "operator-a", token: TOKEN, grants: ["READ", "KILL_SWITCH"] },
  { operatorId: "reader-b", token: OTHER, grants: ["READ"] },
]);

describe("OperatorRegistry", () => {
  it("authenticates a configured bearer token and returns the OPERATOR, not the token", () => {
    const result = registry.authenticate(`Bearer ${TOKEN}`);
    expect(result).toEqual({
      ok: true,
      operator: { operatorId: "operator-a", grants: ["READ", "KILL_SWITCH"] },
    });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("REFUSES an absent header", () => {
    expect(registry.authenticate(undefined)).toEqual({ ok: false, reason: "MISSING_CREDENTIAL" });
    expect(registry.authenticate("")).toEqual({ ok: false, reason: "MISSING_CREDENTIAL" });
  });

  it("REFUSES a non-bearer scheme as MISSING, and a broken Bearer as MALFORMED", () => {
    expect(registry.authenticate(`Basic ${TOKEN}`)).toEqual({
      ok: false,
      reason: "MISSING_CREDENTIAL",
    });
    expect(registry.authenticate("Bearer")).toEqual({ ok: false, reason: "MALFORMED_CREDENTIAL" });
    expect(registry.authenticate("Bearer ")).toEqual({ ok: false, reason: "MALFORMED_CREDENTIAL" });
  });

  it("REFUSES an unknown token, a near-miss, and a prefix", () => {
    expect(registry.authenticate("Bearer not-a-configured-token")).toEqual({
      ok: false,
      reason: "UNKNOWN_CREDENTIAL",
    });
    expect(registry.authenticate(`Bearer ${TOKEN}x`)).toEqual({
      ok: false,
      reason: "UNKNOWN_CREDENTIAL",
    });
    expect(registry.authenticate(`Bearer ${TOKEN.slice(0, -1)}`)).toEqual({
      ok: false,
      reason: "UNKNOWN_CREDENTIAL",
    });
  });

  it("NEVER echoes any part of what was presented", () => {
    const presented = "a-token-that-must-not-appear-in-any-refusal";
    const result = registry.authenticate(`Bearer ${presented}`);
    expect(JSON.stringify(result)).not.toContain(presented);
    expect(JSON.stringify(result)).not.toContain(presented.slice(0, 8));
  });

  it("HOLDS NO TOKEN: nothing reachable on the registry serialises one", () => {
    expect(JSON.stringify(registry)).not.toContain(TOKEN);
    expect(JSON.stringify(registry.operatorIds())).not.toContain(TOKEN);
    // The ids are not secret and ARE reported — that is what the audit log
    // names.
    expect(registry.operatorIds()).toEqual(["operator-a", "reader-b"]);
    expect(registry.size).toBe(2);
  });

  it("distinguishes two operators by their own tokens", () => {
    expect(registry.authenticate(`Bearer ${OTHER}`)).toMatchObject({
      ok: true,
      operator: { operatorId: "reader-b" },
    });
  });

  it("authenticates nobody when nobody is configured", () => {
    const empty = new OperatorRegistry([]);
    expect(empty.authenticate(`Bearer ${TOKEN}`)).toEqual({
      ok: false,
      reason: "UNKNOWN_CREDENTIAL",
    });
  });
});

describe("explicit authorization (§15)", () => {
  it("grants nothing by authenticating: each grant is checked on its own", () => {
    const reader = registry.authenticate(`Bearer ${OTHER}`);
    expect(reader.ok).toBe(true);
    if (!reader.ok) return;
    expect(hasGrant(reader.operator, "READ")).toBe(true);
    expect(hasGrant(reader.operator, "KILL_SWITCH")).toBe(false);
    expect(hasGrant(reader.operator, "STRATEGY_CONTROL")).toBe(false);
  });

  it("declares exactly the grants this API implements — and no live-mode one", () => {
    expect([...OPERATOR_GRANTS]).toEqual(["READ", "STRATEGY_CONTROL", "KILL_SWITCH"]);
    // §15 names four action classes. Two are implemented above; the other two
    // are UNREPRESENTABLE, so there is no grant for them and there could not be
    // a request that used one.
    expect(OPERATOR_GRANTS as readonly string[]).not.toContain("LIVE_MODE");
    expect(OPERATOR_GRANTS as readonly string[]).not.toContain("WALLET_OPERATION");
  });

  it("freezes the grant list a caller receives", () => {
    const result = registry.authenticate(`Bearer ${TOKEN}`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.isFrozen(result.operator)).toBe(true);
    expect(Object.isFrozen(result.operator.grants)).toBe(true);
  });
});
