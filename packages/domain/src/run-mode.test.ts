import { describe, expect, it } from "vitest";

import { RunModeNotPermittedError } from "./errors.js";
import {
  RUN_MODES,
  RUN_MODE_PLACES_REAL_ORDERS,
  RUN_MODE_RANK,
  RUN_MODE_REQUIRES_LIVE_SIGNER,
  RunModeSchema,
  assertRunModeWithinMaximum,
  compareRunMode,
  isRunModeWithinMaximum,
  runModeExceeds,
  runModesWithinMaximum,
  type RunMode,
} from "./run-mode.js";

describe("run modes (handoff §11)", () => {
  it("declares exactly the six specified modes in escalation order", () => {
    expect(RUN_MODES).toEqual([
      "BACKTEST",
      "PAPER",
      "SHADOW",
      "EXECUTION_PROBE",
      "LIVE_MICRO",
      "LIVE",
    ]);
    expect(RunModeSchema.options).toEqual([...RUN_MODES]);
    expect(RunModeSchema.safeParse("DRY_RUN").success).toBe(false);
    expect(RunModeSchema.safeParse("live").success).toBe(false);
  });

  it("ranks the modes consistently with their declaration order", () => {
    RUN_MODES.forEach((mode, index) => {
      expect(RUN_MODE_RANK[mode]).toBe(index);
    });
  });

  it("orders modes strictly", () => {
    expect(compareRunMode("BACKTEST", "PAPER")).toBe(-1);
    expect(compareRunMode("PAPER", "PAPER")).toBe(0);
    expect(compareRunMode("LIVE", "LIVE_MICRO")).toBe(1);
    expect(compareRunMode("SHADOW", "EXECUTION_PROBE")).toBe(-1);
  });

  it("permits every mode at or below the maximum", () => {
    expect(runModesWithinMaximum("PAPER")).toEqual(["BACKTEST", "PAPER"]);
    expect(runModesWithinMaximum("BACKTEST")).toEqual(["BACKTEST"]);
    expect(runModesWithinMaximum("LIVE")).toEqual([...RUN_MODES]);
  });

  it("blocks every mode above the process maximum", () => {
    const maximum: RunMode = "PAPER";
    for (const mode of ["SHADOW", "EXECUTION_PROBE", "LIVE_MICRO", "LIVE"] as const) {
      expect(runModeExceeds(mode, maximum)).toBe(true);
      expect(isRunModeWithinMaximum(mode, maximum)).toBe(false);
      expect(() => assertRunModeWithinMaximum(mode, maximum)).toThrow(RunModeNotPermittedError);
    }
    for (const mode of ["BACKTEST", "PAPER"] as const) {
      expect(runModeExceeds(mode, maximum)).toBe(false);
      expect(assertRunModeWithinMaximum(mode, maximum)).toBe(mode);
    }
  });

  it("reports the requested and maximum modes on the error", () => {
    try {
      assertRunModeWithinMaximum("LIVE", "PAPER");
      throw new Error("expected assertRunModeWithinMaximum to throw");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(RunModeNotPermittedError);
      const typed = error as RunModeNotPermittedError;
      expect(typed.code).toBe("RUN_MODE_EXCEEDS_MAXIMUM");
      expect(typed.requested).toBe("LIVE");
      expect(typed.maximum).toBe("PAPER");
    }
  });

  it("marks exactly the real-execution modes from the §11 table", () => {
    expect(RUN_MODE_PLACES_REAL_ORDERS).toEqual({
      BACKTEST: false,
      PAPER: false,
      SHADOW: false,
      EXECUTION_PROBE: true,
      LIVE_MICRO: true,
      LIVE: true,
    });
  });

  it("marks exactly the live-signer modes from the §11 table", () => {
    expect(RUN_MODE_REQUIRES_LIVE_SIGNER).toEqual({
      BACKTEST: false,
      PAPER: false,
      SHADOW: false,
      EXECUTION_PROBE: true,
      LIVE_MICRO: true,
      LIVE: true,
    });
  });

  it("keeps PAPER free of real orders and of a live signer", () => {
    // Guards the repository-wide paper-only default (AGENTS.md safety section).
    expect(RUN_MODE_PLACES_REAL_ORDERS.PAPER).toBe(false);
    expect(RUN_MODE_REQUIRES_LIVE_SIGNER.PAPER).toBe(false);
    expect(runModesWithinMaximum("PAPER").some((mode) => RUN_MODE_PLACES_REAL_ORDERS[mode])).toBe(
      false,
    );
  });
});
