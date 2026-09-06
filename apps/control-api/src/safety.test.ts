/**
 * Startup safety — acceptance 1's startup half, and §15's name rule.
 *
 * Every case drives the real `checkControlApiSafety` over a record. Nothing
 * here touches `process.env`, so no test can prove the check by arranging the
 * very thing it detects.
 */

import { describe, expect, it } from "vitest";

import {
  CONTROL_API_RUN_MODE,
  REPOSITORY_MAXIMUM_RUN_MODE,
  checkControlApiSafety,
} from "./safety.js";

const codes = (env: Readonly<Record<string, string | undefined>>): readonly string[] => {
  const outcome = checkControlApiSafety(env);
  return outcome.ok ? [] : outcome.violations.map((violation) => violation.code);
};

describe("the untouchable defaults", () => {
  it("names PAPER as both the repository ceiling and this process's mode", () => {
    expect(REPOSITORY_MAXIMUM_RUN_MODE).toBe("PAPER");
    expect(CONTROL_API_RUN_MODE).toBe("PAPER");
  });

  it("accepts a clean PAPER environment", () => {
    const outcome = checkControlApiSafety({
      RUN_MODE: "PAPER",
      MAX_RUN_MODE: "PAPER",
      ALLOW_REAL_ORDERS: "false",
      LIVE_MICRO_MAX_ORDER_NOTIONAL: "0",
      LIVE_MICRO_MAX_ACCOUNT_EXPOSURE: "0",
      CONTROL_API_CONFIG: "/etc/control-api.json",
    });
    expect(outcome).toEqual({ ok: true, runMode: "PAPER" });
  });

  it("accepts an environment that sets none of them (the defaults are the floor)", () => {
    expect(checkControlApiSafety({}).ok).toBe(true);
  });
});

describe("ACCEPTANCE 1 (startup half): the ceiling cannot be raised", () => {
  it.each(["LIVE", "LIVE_MICRO", "EXECUTION_PROBE"])(
    "REFUSES MAX_RUN_MODE=%s — it is above the repository maximum",
    (mode) => {
      expect(codes({ MAX_RUN_MODE: mode })).toEqual(["PAPER_RUN_MODE_CEILING_RAISED"]);
    },
  );

  it("NEVER CLAMPS: a raised ceiling refuses, it does not silently become PAPER", () => {
    const outcome = checkControlApiSafety({ MAX_RUN_MODE: "LIVE" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.violations[0]?.detail).toContain("never clamped");
  });

  it("REFUSES an unreadable ceiling rather than defaulting it", () => {
    expect(codes({ MAX_RUN_MODE: "SUPER_LIVE" })).toEqual([
      "PAPER_RUN_MODE_CEILING_UNREADABLE",
    ]);
  });

  it.each(["LIVE", "LIVE_MICRO", "EXECUTION_PROBE"])(
    "REFUSES RUN_MODE=%s by name — it places real orders or needs a live signer",
    (mode) => {
      const outcome = checkControlApiSafety({ RUN_MODE: mode });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.violations.map((violation) => violation.code)).toContain(
        "PAPER_RUN_MODE_NOT_PERMITTED",
      );
      // The signer sentence is present for every one of the three, alongside
      // the ceiling sentence rather than instead of it.
      expect(outcome.violations.map((violation) => violation.detail).join("\n")).toContain(
        "never has the signing key",
      );
    },
  );

  it("REFUSES a permitted-but-different mode: this process serves exactly one", () => {
    for (const mode of ["BACKTEST", "SHADOW"]) {
      expect(codes({ RUN_MODE: mode })).toEqual(["PAPER_RUN_MODE_NOT_PERMITTED"]);
    }
  });

  it("reports EVERY reason a mode is impermissible, not the first", () => {
    // RUN_MODE=LIVE both exceeds the ceiling AND needs a signer. An operator
    // shown only the ceiling would raise it and meet the signer refusal next.
    const outcome = checkControlApiSafety({ RUN_MODE: "LIVE" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.violations).toHaveLength(2);
    expect(outcome.violations.map((violation) => violation.detail).join("\n")).toContain(
      "exceeds the process maximum",
    );
    // …and it does NOT also add "is not PAPER", which would be a third sentence
    // saying nothing the first two did not.
    expect(
      outcome.violations.filter((violation) => violation.detail.includes("is not PAPER")),
    ).toHaveLength(0);
  });

  it("REFUSES ALLOW_REAL_ORDERS anything but false", () => {
    expect(codes({ ALLOW_REAL_ORDERS: "true" })).toEqual(["PAPER_REAL_ORDERS_ENABLED"]);
    expect(codes({ ALLOW_REAL_ORDERS: "1" })).toEqual(["PAPER_REAL_ORDERS_ENABLED"]);
    expect(codes({ ALLOW_REAL_ORDERS: "false" })).toEqual([]);
  });

  it("REFUSES a non-zero live-micro cap, either of them", () => {
    expect(codes({ LIVE_MICRO_MAX_ORDER_NOTIONAL: "1" })).toEqual([
      "PAPER_LIVE_MICRO_CAP_NONZERO",
    ]);
    expect(codes({ LIVE_MICRO_MAX_ACCOUNT_EXPOSURE: "0.01" })).toEqual([
      "PAPER_LIVE_MICRO_CAP_NONZERO",
    ]);
    expect(codes({ LIVE_MICRO_MAX_ORDER_NOTIONAL: "0", LIVE_MICRO_MAX_ACCOUNT_EXPOSURE: "0" })).toEqual(
      [],
    );
  });
});

describe("§15: a paper environment cannot reference a production secret name", () => {
  it("REFUSES each enumerated class under its own code", () => {
    expect(codes({ POLYMARKET_PRIVATE_KEY: "" })).toEqual([
      "PAPER_PRODUCTION_SECRET_NAME_PRESENT",
    ]);
    expect(codes({ POLY_ADDRESS: "0x0" })).toEqual(["PAPER_PRODUCTION_ACCOUNT_NAME_PRESENT"]);
    expect(codes({ POLYMARKET_BUILDER_CODE: "x" })).toEqual([
      "PAPER_BUILDER_ATTRIBUTION_PRESENT",
    ]);
    expect(codes({ SOME_SIGNING_KEY: "material" })).toEqual([
      "PAPER_CREDENTIAL_SHAPED_NAME_PRESENT",
    ]);
  });

  it("NEVER prints a scanned value", () => {
    const secret = "must-not-appear-anywhere-in-a-refusal";
    const outcome = checkControlApiSafety({
      POLYMARKET_PRIVATE_KEY: secret,
      SOME_PASSPHRASE: secret,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    for (const violation of outcome.violations) {
      expect(violation.detail).not.toContain(secret);
    }
  });
});

describe("totality", () => {
  it("reports EVERY violation, not the first", () => {
    const outcome = checkControlApiSafety({
      MAX_RUN_MODE: "LIVE",
      ALLOW_REAL_ORDERS: "true",
      LIVE_MICRO_MAX_ORDER_NOTIONAL: "5",
      POLYMARKET_PRIVATE_KEY: "x",
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(new Set(outcome.violations.map((violation) => violation.code))).toEqual(
      new Set([
        "PAPER_RUN_MODE_CEILING_RAISED",
        "PAPER_REAL_ORDERS_ENABLED",
        "PAPER_LIVE_MICRO_CAP_NONZERO",
        "PAPER_PRODUCTION_SECRET_NAME_PRESENT",
      ]),
    );
  });

  it("does not read the ambient environment: an inherited name changes nothing", () => {
    const inherited = Object.create({ POLYMARKET_PRIVATE_KEY: "x" }) as Record<string, string>;
    inherited["RUN_MODE"] = "PAPER";
    expect(checkControlApiSafety(inherited).ok).toBe(true);
  });
});
