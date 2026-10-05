/**
 * WP-330 r1, CX330-R1-02: releasing what a command opened (the venue client,
 * the lease store) is CLEANUP. It is bounded like every other call to a port
 * the CLI does not control, and it runs only AFTER the OUTCOME record is
 * written and printed, so a close that never settles can neither hold an
 * emergency CLI open nor keep the record of what it did out of the log. At
 * fb9edcc, `dispatch` awaited an unbounded `close()` in a `finally`, before
 * the OUTCOME record: a hung close left only INVOKED and ACTING, forever.
 */

import { installNetworkTripwire, type NetworkTripwire } from "@polymarket-bot/polymarket-secure/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { releaseWithin } from "./bounded.js";
import { LEASE_STORE_RELEASE_MS } from "./commands/stop-heartbeat.js";
import { ACCOUNT, args, DESTRUCTIVE_REASON, fakeLeases, harness, LEASE_ID, order, phases, testConfiguration, type Harness } from "./harness.test-support.js";
import type { EmergencyVenue } from "./ports.js";
import { runOpsCli, type OpsCliOutcome } from "./run.js";

let tripwire: NetworkTripwire;
beforeEach(() => {
  tripwire = installNetworkTripwire();
});
afterEach(() => {
  tripwire.uninstall();
  expect(tripwire.refused()).toEqual([]);
});

const BOUND_MS = 50;
const CANCEL_ALL = args("cancel-all", ...DESTRUCTIVE_REASON, "--confirm", `cancel-all:${ACCOUNT}`);
const NEVER = (): Promise<void> => new Promise<void>(() => undefined);

/** The run's outcome, or HUNG when it has not settled within `withinMs` of wall time. */
async function settledWithin(run: Promise<OpsCliOutcome>, withinMs: number): Promise<OpsCliOutcome | "HUNG"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([run, new Promise<"HUNG">((resolve) => (timer = setTimeout(() => resolve("HUNG"), withinMs)))]);
  } finally {
    clearTimeout(timer);
  }
}

/** The fake venue, with its cancel binding's `close` replaced. */
function venueWithClose(h: Harness, close: () => Promise<void>): EmergencyVenue {
  return { cancels: { ...h.venue.cancels, close }, reads: h.venue.reads };
}

describe("CX330-R1-02: the venue client is released after the OUTCOME record, bounded", () => {
  it("a close that NEVER settles: cancel-all still ends, COMPLETED; the OUTCOME was durable before close was even called; the output says the release did not finish", async () => {
    const h = harness({ configuration: testConfiguration({ venueAnswerBoundMs: BOUND_MS }) });
    h.venue.add(order("o-1"), order("o-2"));
    const atClose: string[][] = [];
    const venue = venueWithClose(h, () => {
      atClose.push(phases(h.audit.records));
      return NEVER();
    });
    const outcome = await settledWithin(runOpsCli(h.deps(CANCEL_ALL, { venues: { open: () => Promise.resolve({ kind: "OPEN" as const, venue }) } })), 3_000);
    expect(outcome).not.toBe("HUNG");
    expect(outcome).toMatchObject({ exitName: "COMPLETED", exitCode: 0 });
    expect(h.venue.open()).toEqual([]);
    expect(phases(h.audit.records)).toEqual(["INVOKED", "ACTING", "OUTCOME"]);
    expect(atClose).toEqual([["INVOKED", "ACTING", "OUTCOME"]]);
    const text = h.text();
    expect(text).toContain(`release: the venue client did not finish releasing within ${String(BOUND_MS)} ms; the CLI ends anyway`);
    // The release is reported after the OUTCOME section: it cannot change it.
    expect(text.indexOf("release: the venue client")).toBeGreaterThan(text.indexOf("OUTCOME:\n  - COMPLETED (exit 0)"));
  });

  it("a close that settles is released once, after the OUTCOME record, and nothing is reported about it", async () => {
    const h = harness();
    h.venue.add(order("o-1"));
    const atClose: string[][] = [];
    const venue = venueWithClose(h, () => {
      atClose.push(phases(h.audit.records));
      return Promise.resolve();
    });
    const outcome = await runOpsCli(h.deps(args("account-snapshot"), { venues: { open: () => Promise.resolve({ kind: "OPEN" as const, venue }) } }));
    expect(outcome.exitName).toBe("COMPLETED");
    expect(atClose).toEqual([["INVOKED", "OUTCOME"]]);
    expect(h.text()).not.toContain("release:");
  });

  it("a close that THROWS (synchronously): the outcome stands, and the output says the release failed", async () => {
    const h = harness();
    h.venue.add(order("o-1"));
    const venue = venueWithClose(h, () => {
      throw new Error("close exploded with SECRET-in-message");
    });
    const outcome = await runOpsCli(h.deps(CANCEL_ALL, { venues: { open: () => Promise.resolve({ kind: "OPEN" as const, venue }) } }));
    expect(outcome.exitName).toBe("COMPLETED");
    expect(phases(h.audit.records)).toEqual(["INVOKED", "ACTING", "OUTCOME"]);
    expect(h.text()).toContain("release: the venue client failed to release; the CLI ends anyway");
    expect(h.text()).not.toContain("SECRET-in-message");
  });

  it("a binding with no readable identity whose close also never settles: CREDENTIALS_UNAVAILABLE within the bound, nothing sent", async () => {
    const h = harness({ configuration: testConfiguration({ venueAnswerBoundMs: BOUND_MS }) });
    h.venue.add(order("o-1"));
    const base = venueWithClose(h, NEVER);
    const cancels = Object.defineProperty({ ...base.cancels }, "identity", {
      get: () => {
        throw new Error("no identity");
      },
    });
    const venue: EmergencyVenue = { cancels, reads: base.reads };
    const outcome = await settledWithin(runOpsCli(h.deps(CANCEL_ALL, { venues: { open: () => Promise.resolve({ kind: "OPEN" as const, venue }) } })), 3_000);
    expect(outcome).not.toBe("HUNG");
    expect(outcome).toMatchObject({ exitName: "CREDENTIALS_UNAVAILABLE" });
    expect(h.venue.calls).toEqual([]);
    expect(phases(h.audit.records)).toEqual(["INVOKED", "OUTCOME"]);
  });
});

describe("CX330-R1-02: the lease store is released after the OUTCOME record, bounded", () => {
  it("stop-heartbeat with a lease store whose close NEVER settles: it ends within LEASE_STORE_RELEASE_MS, the revoke and the OUTCOME recorded", async () => {
    const h = harness();
    const leases = fakeLeases();
    const atClose: string[][] = [];
    const outcome = await settledWithin(
      runOpsCli(
        h.deps(args("stop-heartbeat", ...DESTRUCTIVE_REASON, "--confirm", `stop-heartbeat:${ACCOUNT}:${LEASE_ID}`), {
          leases: {
            open: async () => {
              const opened = await leases.factory.open();
              if (opened.kind !== "OPEN") return opened;
              return {
                ...opened,
                close: () => {
                  atClose.push(phases(h.audit.records));
                  return NEVER();
                },
              };
            },
          },
        }),
      ),
      LEASE_STORE_RELEASE_MS + 3_000,
    );
    expect(outcome).not.toBe("HUNG");
    expect(outcome).toMatchObject({ exitName: "COMPLETED" });
    expect(leases.revoked).toHaveLength(1);
    expect(atClose).toEqual([["INVOKED", "ACTING", "OUTCOME"]]);
    expect(h.text()).toContain(`release: the fencing lease store did not finish releasing within ${String(LEASE_STORE_RELEASE_MS)} ms`);
  });
});

describe("releaseWithin", () => {
  it("RELEASED, UNANSWERED after the bound, FAILED on a throw or a rejection; never throws", async () => {
    expect(await releaseWithin(1_000, () => Promise.resolve())).toBe("RELEASED");
    expect(await releaseWithin(20, NEVER)).toBe("UNANSWERED");
    expect(await releaseWithin(1_000, () => Promise.reject(new Error("refused")))).toBe("FAILED");
    expect(
      await releaseWithin(1_000, () => {
        throw new Error("sync");
      }),
    ).toBe("FAILED");
  });
});
