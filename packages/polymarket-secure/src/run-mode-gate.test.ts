/**
 * The run-mode gate (ADR-010 §2–§3). Exhaustive over the §11 modes, plus the
 * unreadable and non-§11 inputs (REPLAY, lower case, strings for booleans,
 * getters, proxies, extra keys).
 */

import { RUN_MODES, RUN_MODE_REQUIRES_LIVE_SIGNER, runModeExceeds, type RunMode } from "@polymarket-bot/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SignerBoundaryRefusal } from "./errors.js";
import { assertSignerGate, evaluateSignerGate, signerGateContextFromSafetyFlags } from "./run-mode-gate.js";
import { installNetworkTripwire, type NetworkTripwire } from "./testing/network-tripwire.js";

let tripwire: NetworkTripwire;
beforeEach(() => {
  tripwire = installNetworkTripwire();
});
afterEach(() => {
  tripwire.uninstall();
  expect(tripwire.refused()).toEqual([]);
});

describe("evaluateSignerGate — every §11 combination", () => {
  const cases: { runMode: RunMode; maximumRunMode: RunMode; allowRealOrders: boolean }[] = [];
  for (const runMode of RUN_MODES) {
    for (const maximumRunMode of RUN_MODES) {
      for (const allowRealOrders of [false, true]) cases.push({ runMode, maximumRunMode, allowRealOrders });
    }
  }

  it.each(cases)("%o", (input) => {
    const verdict = evaluateSignerGate(input);
    const expected =
      RUN_MODE_REQUIRES_LIVE_SIGNER[input.runMode] &&
      !runModeExceeds(input.runMode, input.maximumRunMode) &&
      input.allowRealOrders;
    expect(verdict.permitted).toBe(expected);
  });

  it("permits only the three live-signer modes, and only with real orders allowed and a high enough maximum", () => {
    const permitted = cases.filter((input) => evaluateSignerGate(input).permitted);
    expect(permitted.map((input) => input.runMode).sort()).toEqual(
      ["EXECUTION_PROBE", "EXECUTION_PROBE", "EXECUTION_PROBE", "LIVE", "LIVE_MICRO", "LIVE_MICRO"].sort(),
    );
    for (const input of permitted) expect(input.allowRealOrders).toBe(true);
  });
});

describe("evaluateSignerGate — refusals for non-live and unreadable contexts", () => {
  it.each(["BACKTEST", "PAPER", "SHADOW"] as const)("refuses %s even with a LIVE maximum and real orders allowed", (runMode) => {
    const verdict = evaluateSignerGate({ runMode, maximumRunMode: "LIVE", allowRealOrders: true });
    expect(verdict).toEqual({ permitted: false, reasons: ["RUN_MODE_REQUIRES_NO_SIGNER"] });
  });

  it.each(["REPLAY", "paper", "live", "LIVE ", "", "PAPER\u0000"])("refuses the non-§11 run mode %j", (runMode) => {
    const verdict = evaluateSignerGate({ runMode, maximumRunMode: "LIVE", allowRealOrders: true });
    expect(verdict.permitted).toBe(false);
    if (!verdict.permitted) expect(verdict.reasons).toContain("RUN_MODE_UNKNOWN");
  });

  it("refuses the repository defaults (MAX_RUN_MODE=PAPER, ALLOW_REAL_ORDERS=false) whatever the run mode claims", () => {
    for (const runMode of RUN_MODES) {
      const verdict = evaluateSignerGate({ runMode, maximumRunMode: "PAPER", allowRealOrders: false });
      expect(verdict.permitted).toBe(false);
      if (!verdict.permitted) expect(verdict.reasons).toContain("REAL_ORDERS_NOT_ALLOWED");
    }
  });

  it("refuses a live mode above the process maximum", () => {
    const verdict = evaluateSignerGate({ runMode: "LIVE", maximumRunMode: "LIVE_MICRO", allowRealOrders: true });
    expect(verdict).toEqual({ permitted: false, reasons: ["RUN_MODE_ABOVE_MAXIMUM"] });
  });

  it.each([["true"], [1], ["yes"], [null], [undefined]])("refuses allowRealOrders=%j (only the boolean true)", (allowRealOrders) => {
    const verdict = evaluateSignerGate({ runMode: "LIVE_MICRO", maximumRunMode: "LIVE_MICRO", allowRealOrders });
    expect(verdict).toEqual({ permitted: false, reasons: ["REAL_ORDERS_NOT_ALLOWED"] });
  });

  it("refuses an unknown maximum", () => {
    const verdict = evaluateSignerGate({ runMode: "LIVE_MICRO", maximumRunMode: "UNLIMITED", allowRealOrders: true });
    expect(verdict).toEqual({ permitted: false, reasons: ["MAXIMUM_RUN_MODE_UNKNOWN"] });
  });

  const permittedShape = { runMode: "LIVE_MICRO", maximumRunMode: "LIVE_MICRO", allowRealOrders: true };
  const unreadable: [string, unknown][] = [
    ["undefined", undefined],
    ["null", null],
    ["a string", "LIVE_MICRO"],
    ["an array", ["LIVE_MICRO", "LIVE_MICRO", true]],
    ["an extra key", { ...permittedShape, note: "x" }],
    ["a missing key", { runMode: "LIVE_MICRO", maximumRunMode: "LIVE_MICRO" }],
    ["a class instance", Object.assign(Object.create({ inherited: true }) as object, permittedShape)],
    ["inherited fields", Object.create(permittedShape) as object],
    [
      "a getter",
      Object.defineProperty({ maximumRunMode: "LIVE_MICRO", allowRealOrders: true }, "runMode", {
        get: () => "LIVE_MICRO",
        enumerable: true,
      }),
    ],
    [
      "a proxy that reports accessors",
      new Proxy(
        {},
        {
          ownKeys: () => ["allowRealOrders", "maximumRunMode", "runMode"],
          getOwnPropertyDescriptor: (_target, key) => ({
            configurable: true,
            enumerable: true,
            get: () => (key === "allowRealOrders" ? true : "LIVE_MICRO"),
          }),
        },
      ),
    ],
  ];

  it.each(unreadable)("refuses %s as CONTEXT_UNREADABLE", (_label, input) => {
    expect(evaluateSignerGate(input)).toEqual({ permitted: false, reasons: ["CONTEXT_UNREADABLE"] });
  });

  it("the permitted shape itself passes (so the unreadable cases above are not vacuous)", () => {
    expect(evaluateSignerGate({ ...permittedShape }).permitted).toBe(true);
  });

  it("assertSignerGate throws a SignerBoundaryRefusal carrying reasons and no context value", () => {
    const secretLookingMode = "LIVE-sk-fake-0123456789abcdef";
    try {
      assertSignerGate({ runMode: secretLookingMode, maximumRunMode: "PAPER", allowRealOrders: false });
      expect.unreachable("the gate must refuse");
    } catch (error) {
      expect(error).toBeInstanceOf(SignerBoundaryRefusal);
      const refusal = error as SignerBoundaryRefusal;
      expect(refusal.reasons).toEqual(["RUN_MODE_UNKNOWN", "REAL_ORDERS_NOT_ALLOWED"]);
      expect(JSON.stringify(refusal)).not.toContain(secretLookingMode);
      expect(refusal.message).not.toContain(secretLookingMode);
    }
  });
});

describe("signerGateContextFromSafetyFlags", () => {
  it("THIS test process (a paper/test process) is refused, read from its real environment", () => {
    const verdict = evaluateSignerGate(signerGateContextFromSafetyFlags(process.env));
    expect(verdict.permitted).toBe(false);
  });

  it("refuses the repository defaults exactly as shipped (ADR-010 §1)", () => {
    const verdict = evaluateSignerGate(
      signerGateContextFromSafetyFlags({
        RUN_MODE: "PAPER",
        MAX_RUN_MODE: "PAPER",
        ALLOW_REAL_ORDERS: "false",
        LIVE_MICRO_MAX_ORDER_NOTIONAL: "0",
        LIVE_MICRO_MAX_ACCOUNT_EXPOSURE: "0",
      }),
    );
    expect(verdict).toEqual({ permitted: false, reasons: ["RUN_MODE_REQUIRES_NO_SIGNER", "REAL_ORDERS_NOT_ALLOWED"] });
  });

  it("an absent RUN_MODE is unknown, an absent MAX_RUN_MODE is PAPER, and only the exact string \"true\" allows real orders", () => {
    expect(signerGateContextFromSafetyFlags({})).toEqual({
      runMode: undefined,
      maximumRunMode: "PAPER",
      allowRealOrders: false,
    });
    expect(signerGateContextFromSafetyFlags({ ALLOW_REAL_ORDERS: "TRUE" }).allowRealOrders).toBe(false);
    expect(signerGateContextFromSafetyFlags({ ALLOW_REAL_ORDERS: "1" }).allowRealOrders).toBe(false);
    expect(signerGateContextFromSafetyFlags({ ALLOW_REAL_ORDERS: "true" }).allowRealOrders).toBe(true);
    expect(evaluateSignerGate(signerGateContextFromSafetyFlags({})).permitted).toBe(false);
  });

  it("reads only the three run-mode flags: a record full of secret names changes nothing and is not echoed", () => {
    const flags = {
      RUN_MODE: "PAPER",
      POLYMARKET_PRIVATE_KEY: "0xfake-private-key-must-not-be-read",
      POLY_API_KEY: "fake-api-key",
      POLY_PASSPHRASE: "fake-passphrase",
    };
    const context = signerGateContextFromSafetyFlags(flags);
    expect(Object.keys(context).sort()).toEqual(["allowRealOrders", "maximumRunMode", "runMode"]);
    expect(JSON.stringify(context)).not.toContain("fake");
  });
});
