/**
 * The request grammar's vocabulary — §14.1's scopes and actions, and the
 * forbidden-key scan behind acceptance 1's "refused by name".
 *
 * The runtime pin against the WP-040 database enum values is in
 * `vocabulary.database.test.ts`; it lives in its own file because importing the
 * `packages/storage-postgres` barrel loads a database client, and only the file
 * that needs it should pay that.
 */

import { describe, expect, it } from "vitest";

import {
  CONTROL_ACTOR_KIND,
  CONTROL_KILL_SWITCH_ACTIONS,
  CONTROL_KILL_SWITCH_SCOPES,
  FORBIDDEN_CONTROL_KEYS,
  forbiddenControlKeysIn,
} from "./vocabulary.js";

describe("§14.1's vocabulary", () => {
  it("declares exactly the four scopes and the five actions §14.1 lists", () => {
    expect([...CONTROL_KILL_SWITCH_SCOPES]).toEqual([
      "GLOBAL",
      "ACCOUNT",
      "MARKET",
      "STRATEGY_INSTANCE",
    ]);
    expect([...CONTROL_KILL_SWITCH_ACTIONS]).toEqual([
      "HALT_NEW_ENTRIES",
      "CANCEL_ALL",
      "CANCEL_MARKET",
      "MANAGE_POSITIONS_ONLY",
      "FULL_HALT",
    ]);
  });

  it("names a control-API caller a HUMAN operator", () => {
    expect(CONTROL_ACTOR_KIND).toBe("HUMAN");
  });
});

describe("ACCEPTANCE 1: the forbidden control vocabulary", () => {
  it("covers the ceiling, the real-order flag, both caps, and the signer words", () => {
    for (const required of [
      "runmode",
      "max_run_mode",
      "allow_real_orders",
      "live_micro_max_order_notional",
      "live_micro_max_account_exposure",
      "signer",
      "private_key",
      "passphrase",
    ]) {
      expect(FORBIDDEN_CONTROL_KEYS, required).toContain(required);
    }
  });

  it("finds a forbidden key at the TOP level", () => {
    expect(forbiddenControlKeysIn({ runMode: "LIVE", reason: "x" })).toEqual(["runMode"]);
  });

  it("finds a forbidden key NESTED, and inside an array", () => {
    expect(forbiddenControlKeysIn({ config: { maxRunMode: "LIVE" } })).toEqual(["maxRunMode"]);
    expect(forbiddenControlKeysIn({ items: [{ allowRealOrders: true }] })).toEqual([
      "allowRealOrders",
    ]);
  });

  it("matches case-insensitively and returns the key AS WRITTEN, sorted", () => {
    expect(forbiddenControlKeysIn({ RUNMODE: "x", Signer: "y" })).toEqual(["RUNMODE", "Signer"]);
  });

  it("finds nothing in an ordinary control request", () => {
    expect(
      forbiddenControlKeysIn({
        scope: "MARKET",
        scopeRef: "market-1",
        action: "CANCEL_MARKET",
        reason: "book desynchronised",
      }),
    ).toEqual([]);
  });

  it("reads KEYS, never VALUES: a reason may say the words", () => {
    // Refusing on values would make this legitimate reason unwritable.
    expect(
      forbiddenControlKeysIn({
        reason: "halting because we are NOT going LIVE and the signer must stay absent",
      }),
    ).toEqual([]);
  });

  it("reads OWN keys only: an inherited forbidden key is not the caller's", () => {
    Object.defineProperty(Object.prototype, "runMode", {
      value: "LIVE",
      enumerable: false,
      configurable: true,
    });
    try {
      expect(forbiddenControlKeysIn({ reason: "x" })).toEqual([]);
    } finally {
      Reflect.deleteProperty(Object.prototype, "runMode");
    }
  });

  it("terminates on a deeply nested body rather than recursing without bound", () => {
    let deep: Record<string, unknown> = { runMode: "LIVE" };
    for (let index = 0; index < 200; index += 1) deep = { next: deep };
    expect(() => forbiddenControlKeysIn(deep)).not.toThrow();
    // Beyond the depth bound it finds nothing — a bound that refused to
    // terminate would be the denial of service the bound exists to prevent.
    expect(forbiddenControlKeysIn(deep)).toEqual([]);
  });

  it("survives a non-record, a null and a primitive", () => {
    expect(forbiddenControlKeysIn(null)).toEqual([]);
    expect(forbiddenControlKeysIn("runMode")).toEqual([]);
    expect(forbiddenControlKeysIn(42)).toEqual([]);
  });
});
