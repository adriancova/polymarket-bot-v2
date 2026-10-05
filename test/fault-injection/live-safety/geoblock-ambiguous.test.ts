/**
 * The packet's fault "a geoblock answer is ambiguous"; work-plan acceptance
 * "Ambiguous geoblock result blocks new live entries" (handoff §6 invariant
 * 18; ADR-008 §7; `docs/venue/verified-2026-09-30.md` §10.1 and W.6). The
 * endpoint is never called: the port is a fake, and the network tripwire
 * guards the file.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NOT_BLOCKED } from "../../../apps/trader/src/live-safety/fakes.test-support.js";
import { installNetworkTripwire, type NetworkTripwire } from "../../../packages/polymarket-secure/src/testing/network-tripwire.js";

import { liveProcess } from "./support/live-process.js";

let tripwire: NetworkTripwire;
beforeEach(() => {
  tripwire = installNetworkTripwire();
});
afterEach(() => {
  const refused = tripwire.refused();
  tripwire.uninstall();
  expect(refused).toEqual([]);
});

const REDUCTION = { kind: "REDUCTION", marketId: "0190a3e0-0000-7000-8000-00000000000c", instanceId: "0190a3e0-0000-7000-8000-00000000000a" } as const;

describe("an ambiguous geoblock answer blocks new live entries", () => {
  for (const [name, body] of [
    ["an undocumented extra field", { ...NOT_BLOCKED, tier: "close-only" }],
    ["blocked as the string 'false'", { ...NOT_BLOCKED, blocked: "false" }],
    ["a missing country", { blocked: false, ip: "192.0.2.10", region: "" }],
    ["an empty body", {}],
    ["a non-JSON page", "<html>Access denied</html>"],
  ] as const) {
    it(`${name}: new entries blocked; reductions, transmission and the heartbeat untouched`, async () => {
      const live = await liveProcess();
      await live.step(6_000);
      expect(live.entryReasons()).toEqual([]);
      live.geoblock.body = body;
      await live.safety.refreshEligibility();
      expect(live.entryReasons().some((reason) => reason.startsWith("GEOBLOCK_AMBIGUOUS_"))).toBe(true);
      expect(live.safety.gate(REDUCTION).permitted).toBe(true);
      expect(live.safety.gate(REDUCTION).permitted).toBe(true);
      const sends = live.transport.requests.length;
      await live.step(10_000);
      expect(live.transport.requests.length - sends).toBe(2);
      expect(live.entryReasons().some((reason) => reason.startsWith("GEOBLOCK_AMBIGUOUS_"))).toBe(true);
    });
  }

  it("a failed check, a blocked answer, a stale answer and the account's closed-only mode each block new entries", async () => {
    const live = await liveProcess();
    await live.step(6_000);
    live.geoblock.failing = true;
    await live.safety.refreshEligibility();
    expect(live.entryReasons()).toEqual(["GEOBLOCK_FAILED"]);
    live.geoblock.failing = false;
    live.geoblock.body = { blocked: true, ip: "198.51.100.20", country: "US", region: "NY" };
    await live.safety.refreshEligibility();
    expect(live.entryReasons()).toEqual(["GEOBLOCK_BLOCKED"]);
    expect(live.safety.status().eligibility.geoblockTier).toBe("UNDETERMINED");
    live.geoblock.body = NOT_BLOCKED;
    live.closedOnly.body = { closed_only: true };
    await live.safety.refreshEligibility();
    expect(live.entryReasons()).toEqual(["ACCOUNT_CLOSED_ONLY"]);
    live.closedOnly.body = { closed_only: false };
    await live.safety.refreshEligibility();
    expect(live.entryReasons()).toEqual([]);
    // A hung endpoint never answers: the last answer is not trusted past the 60 s maximum age.
    live.geoblock.hanging = true;
    live.closedOnly.hanging = true;
    await live.step(30_000);
    expect(live.entryReasons()).toEqual([]);
    await live.step(31_000);
    expect(live.entryReasons()).toEqual(["GEOBLOCK_STALE", "ACCOUNT_CLOSED_ONLY_STALE"]);
    expect(live.geoblock.calls).toBeGreaterThan(0);
  });
});
