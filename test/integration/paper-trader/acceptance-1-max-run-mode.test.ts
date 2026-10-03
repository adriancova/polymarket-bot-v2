/**
 * `WP-230` ACCEPTANCE CRITERION 1: **`MAX_RUN_MODE=PAPER` is enforced.**
 *
 * "Enforced" is tested as three separate claims, because a process that merely
 * *reads* `PAPER` and carries on would satisfy a weaker reading:
 *
 * 1. a configured ceiling ABOVE `PAPER` REFUSES STARTUP — it is not clamped,
 *    not warned about, and not ignored;
 * 2. a configured RUN MODE above the process maximum refuses, and so does any
 *    mode that places real orders or needs a live signer, BY NAME;
 * 3. the other three `AGENTS.md` floors — `ALLOW_REAL_ORDERS=false` and both
 *    live-micro caps at `0` — refuse on the same terms, because a ceiling
 *    enforced while the caps are open would enforce nothing.
 *
 * The refusal is a STARTUP refusal in every case: `createPaperTrader` answers
 * `TRADER_UNSAFE_ENVIRONMENT` and constructs no loop, no venue binding and no
 * strategy instance.
 */

import { describe, expect, it } from "vitest";

import {
  REPOSITORY_MAXIMUM_RUN_MODE,
  TRADER_RUN_MODE,
  checkPaperTraderSafety,
  createPaperTrader,
} from "@polymarket-bot/trader";

import { assemble, safeEnvironment, traderConfig } from "./support/fixture.js";
import { assembleOrThrow } from "./support/run.js";

function withEnv(overrides: Record<string, string | undefined>): Record<string, string | undefined> {
  return { ...safeEnvironment(), ...overrides };
}

describe("acceptance 1 — MAX_RUN_MODE=PAPER is enforced", () => {
  it("the repository ceiling and the process run mode are both PAPER", () => {
    expect(REPOSITORY_MAXIMUM_RUN_MODE).toBe("PAPER");
    expect(TRADER_RUN_MODE).toBe("PAPER");
  });

  it("a healthy PAPER environment starts and reports its ceiling on the health surface", () => {
    const run = assembleOrThrow();
    const health = run.trader.loop.health();
    expect(health.runMode).toBe("PAPER");
    expect(health.maximumRunMode).toBe("PAPER");
  });

  it.each(["SHADOW", "EXECUTION_PROBE", "LIVE_MICRO", "LIVE"])(
    "REFUSES STARTUP when MAX_RUN_MODE is raised to %s — never clamped",
    (mode) => {
      const { result } = assemble({ env: withEnv({ MAX_RUN_MODE: mode }) });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.refusal.code).toBe("TRADER_UNSAFE_ENVIRONMENT");
      expect(result.refusal.issues.join("\n")).toContain("PAPER_RUN_MODE_CEILING_RAISED");
    },
  );

  it("REFUSES an unreadable ceiling rather than defaulting it", () => {
    const outcome = checkPaperTraderSafety(withEnv({ MAX_RUN_MODE: "TURBO" }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.violations.map((violation) => violation.code)).toContain(
      "PAPER_RUN_MODE_CEILING_UNREADABLE",
    );
  });

  it.each(["EXECUTION_PROBE", "LIVE_MICRO", "LIVE"])(
    "REFUSES RUN_MODE=%s by name — it places real orders or needs a live signer",
    (mode) => {
      const outcome = checkPaperTraderSafety(
        withEnv({ MAX_RUN_MODE: "PAPER", RUN_MODE: mode }),
      );
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.violations.map((violation) => violation.code)).toContain(
        "PAPER_RUN_MODE_NOT_PERMITTED",
      );
    },
  );

  it("REFUSES ALLOW_REAL_ORDERS=true", () => {
    const { result } = assemble({ env: withEnv({ ALLOW_REAL_ORDERS: "true" }) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.issues.join("\n")).toContain("PAPER_REAL_ORDERS_ENABLED");
  });

  it.each(["LIVE_MICRO_MAX_ORDER_NOTIONAL", "LIVE_MICRO_MAX_ACCOUNT_EXPOSURE"])(
    "REFUSES a raised %s — the caps are floors, not tuning knobs",
    (cap) => {
      const { result } = assemble({ env: withEnv({ [cap]: "1" }) });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.refusal.issues.join("\n")).toContain("PAPER_LIVE_MICRO_CAP_NONZERO");
    },
  );

  it("refuses BEFORE the configuration is even parsed — an unsafe environment stops everything", () => {
    // The configuration handed in is DELIBERATELY invalid. If safety ran after
    // the configuration door, the answer would be `TRADER_CONFIG_REFUSED`; the
    // ordering §6 invariant 17 requires makes it `TRADER_UNSAFE_ENVIRONMENT`.
    const result = createPaperTrader({
      env: withEnv({ MAX_RUN_MODE: "LIVE" }),
      config: { nonsense: true },
      clock: { now: () => "2026-03-04T12:00:00.000Z", monotonicNs: () => 0n },
      venue: {
        observe: () => ({ ok: true }),
        observeTrade: () => ({ ok: true }),
        submit: async () => {
          throw new Error("unreachable: startup must refuse before any venue call");
        },
        fillsSince: () => ({ ok: true, value: { fills: [], next: 0 } }),
        orderById: () => undefined,
        orderByPlannedId: () => undefined,
        acknowledgeTerminal: () => false,
      },
      store: {
        persistDecision: async () => ({ ok: true, value: null }),
        saveCheckpoint: async () => ({ ok: true, value: null }),
        appendLedgerTransaction: async () => ({ ok: true, value: null }),
        writePnlSnapshot: async () => ({ ok: true, value: null }),
        replacePnlSnapshot: async () => ({ ok: true, value: null }),
        persistRiskRefusal: async () => ({ ok: true, value: null }),
        close: async () => undefined,
      },
      idNamespace: "acceptance-1",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe("TRADER_UNSAFE_ENVIRONMENT");
  });

  it("the configuration document cannot raise the ceiling — it has no field for one", () => {
    const config = traderConfig({ maxRunMode: "LIVE" });
    const { result } = assemble({ config });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // A strict object: an unrecognised key is a refusal, so a configuration that
    // *tried* to state a ceiling is rejected rather than silently ignored.
    expect(result.refusal.code).toBe("TRADER_CONFIG_REFUSED");
  });
});
