/**
 * WP-260's obligation on WP-330: every venue-touching command passes
 * `assertSignerGate` before reading anything else, and refuses in PAPER,
 * BACKTEST, SHADOW and REPLAY. stop-heartbeat refuses the same way, after
 * printing its guidance (WP-320 / ADR-033 D1 item 4).
 *
 * "Before reading anything else" is pinned by the ports: in a refused process
 * the configuration, the emergency credential, the venue and the lease store
 * are never touched, and the network tripwire records nothing. Only the
 * audit trail is written (INVOKED, OUTCOME).
 */

import { installNetworkTripwire, type NetworkTripwire } from "@polymarket-bot/polymarket-secure/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EXIT_CODES } from "./exit-codes.js";
import { COMMANDS, isDestructive, type CommandName } from "./grammar.js";
import { args, DESTRUCTIVE_REASON, harness, LIVE_FLAGS, PAPER_FLAGS, phases, CONDITION } from "./harness.test-support.js";
import { runOpsCli } from "./run.js";

let tripwire: NetworkTripwire;
beforeEach(() => {
  tripwire = installNetworkTripwire();
});
afterEach(() => {
  tripwire.uninstall();
  expect(tripwire.refused()).toEqual([]);
});

function argvOf(command: CommandName): string[] {
  const operand = command === "cancel-order" ? ["order-1"] : command === "cancel-market" ? [CONDITION] : [];
  return args(command, ...operand, ...(isDestructive(command) ? [...DESTRUCTIVE_REASON, "--confirm", "anything"] : []));
}

const REFUSED_CONTEXTS: readonly (readonly [string, Readonly<Record<string, string | undefined>>, string])[] = [
  ["PAPER (the repository defaults)", PAPER_FLAGS, "RUN_MODE_REQUIRES_NO_SIGNER"],
  ["BACKTEST", { RUN_MODE: "BACKTEST", MAX_RUN_MODE: "LIVE", ALLOW_REAL_ORDERS: "true" }, "RUN_MODE_REQUIRES_NO_SIGNER"],
  ["SHADOW", { RUN_MODE: "SHADOW", MAX_RUN_MODE: "LIVE", ALLOW_REAL_ORDERS: "true" }, "RUN_MODE_REQUIRES_NO_SIGNER"],
  ["REPLAY (not a §11 run mode)", { RUN_MODE: "REPLAY", MAX_RUN_MODE: "LIVE", ALLOW_REAL_ORDERS: "true" }, "RUN_MODE_UNKNOWN"],
  ["no RUN_MODE at all", { MAX_RUN_MODE: "LIVE", ALLOW_REAL_ORDERS: "true" }, "RUN_MODE_UNKNOWN"],
  ["a live mode above the default maximum (PAPER)", { RUN_MODE: "LIVE_MICRO", ALLOW_REAL_ORDERS: "true" }, "RUN_MODE_ABOVE_MAXIMUM"],
  ["a live mode without real orders allowed", { RUN_MODE: "LIVE_MICRO", MAX_RUN_MODE: "LIVE_MICRO", ALLOW_REAL_ORDERS: "false" }, "REAL_ORDERS_NOT_ALLOWED"],
  ['ALLOW_REAL_ORDERS spelled "TRUE"', { RUN_MODE: "LIVE_MICRO", MAX_RUN_MODE: "LIVE_MICRO", ALLOW_REAL_ORDERS: "TRUE" }, "REAL_ORDERS_NOT_ALLOWED"],
];

describe("the signer gate runs first, for every command", () => {
  for (const command of COMMANDS) {
    for (const [label, flags, reason] of REFUSED_CONTEXTS) {
      it(`${command} in ${label}: RUN_MODE_REFUSED, and no configuration, credential, venue or lease is touched`, async () => {
        const h = harness();
        let leasesOpened = 0;
        const outcome = await runOpsCli(
          h.deps(argvOf(command), {
            runModeFlags: flags,
            leases: {
              open: () => {
                leasesOpened += 1;
                return Promise.reject(new Error("touched"));
              },
            },
          }),
        );
        expect(outcome.exitName).toBe("RUN_MODE_REFUSED");
        expect(outcome.exitCode).toBe(EXIT_CODES.RUN_MODE_REFUSED);
        expect(h.touched).toEqual([]);
        expect(leasesOpened).toBe(0);
        expect(h.venue.calls).toEqual([]);
        expect(h.text()).toContain(reason);
        expect(h.text()).toContain("REFUSED by WP-260's signer gate");
        // Audited, refusal included.
        expect(phases(h.audit.records)).toEqual(["INVOKED", "OUTCOME"]);
        expect(h.audit.records[0]?.detail["gate"]).toMatchObject({ permitted: false });
        expect(h.audit.records[1]?.detail["exit"]).toBe("RUN_MODE_REFUSED");
        expect(h.audit.records.every((record) => record.runMode === null)).toBe(true);
      });
    }
  }

  it("stop-heartbeat in PAPER explains, then refuses: the guidance precedes the refusal, and the lease store is never opened", async () => {
    const h = harness();
    const outcome = await runOpsCli(h.deps(argvOf("stop-heartbeat"), { runModeFlags: PAPER_FLAGS }));
    expect(outcome.exitName).toBe("RUN_MODE_REFUSED");
    const text = h.text();
    const guidance = text.indexOf("GUIDANCE:");
    const refusal = text.indexOf("REFUSED by WP-260's signer gate");
    expect(guidance).toBeGreaterThan(-1);
    expect(refusal).toBeGreaterThan(guidance);
    expect(text).toContain("revokes the account's ACTIVE fencing lease");
    expect(text).toContain("10–15 s after the last valid heartbeat");
    expect(text).toContain("no heartbeat transport exists in this repository");
    expect(text).toContain("there is nothing to revoke");
  });

  it("CONTROL: the same invocations in a live-shaped context pass the gate and reach the ports", async () => {
    const h = harness();
    const outcome = await runOpsCli(h.deps(argvOf("account-snapshot"), { runModeFlags: LIVE_FLAGS }));
    expect(outcome.exitName).toBe("COMPLETED");
    expect(h.touched).toEqual(["configuration", "credentials", "venues"]);
    expect(h.audit.records.at(-1)?.runMode).toBe("LIVE_MICRO");
  });

  it("the gate is evaluated before the INVOKED record: a refusal is recorded with its reasons", async () => {
    const h = harness();
    await runOpsCli(h.deps(argvOf("cancel-all"), { runModeFlags: PAPER_FLAGS }));
    expect(h.audit.records[0]?.detail["gate"]).toEqual({ permitted: false, reasons: ["RUN_MODE_REQUIRES_NO_SIGNER", "REAL_ORDERS_NOT_ALLOWED"] });
  });
});
