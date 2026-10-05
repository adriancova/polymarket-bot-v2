/**
 * WP-320's obligation on WP-330 (ADR-033 D1 item 4; D2; D6): stop-heartbeat
 * guidance means revoking the fencing lease through WP-320's
 * `FencingLeaseStore.revoke`, so the holder's authority latches lost and its
 * heartbeat stops; the venue cancels resting orders 10–15 s later. No
 * transport exists, and the CLI writes none. In PAPER it explains and refuses
 * (`run.gate.test.ts`). Here: the live-shaped path, over an in-memory lease
 * store with the real store's two operations; the real store against
 * PostgreSQL is `test/integration/ops-cli/`.
 */

import { HEARTBEAT_VENUE_FACTS } from "@polymarket-bot/polymarket-secure";
import { installNetworkTripwire, type NetworkTripwire } from "@polymarket-bot/polymarket-secure/testing";
import type { FencingLeaseStore } from "@polymarket-bot/storage-postgres";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from "vitest";

import { stopHeartbeatGuidance } from "./commands/stop-heartbeat.js";
import { EXIT_CODES } from "./exit-codes.js";
import { ACCOUNT, args, DESTRUCTIVE_REASON, fakeLeases, harness, LEASE_ID, OPERATOR, phases } from "./harness.test-support.js";
import type { FencingLeaseAccess } from "./ports.js";
import { runOpsCli } from "./run.js";

let tripwire: NetworkTripwire;
beforeEach(() => {
  tripwire = installNetworkTripwire();
});
afterEach(() => {
  tripwire.uninstall();
  expect(tripwire.refused()).toEqual([]);
});

const SCOPE = `stop-heartbeat:${ACCOUNT}:${LEASE_ID}`;
const stop = (...extra: string[]): string[] => args("stop-heartbeat", ...DESTRUCTIVE_REASON, ...extra);

describe("WP-320: stop-heartbeat revokes the fencing lease, and only that", () => {
  it("WP-320's FencingLeaseStore is a FencingLeaseAccess (compile time): the CLI calls its revoke and current, nothing else", () => {
    expectTypeOf<FencingLeaseStore>().toMatchTypeOf<FencingLeaseAccess>();
  });

  it("it reads the realm's ACTIVE lease for the account in the process's run mode, revokes exactly that lease, with the operator and reason on the row", async () => {
    const h = harness();
    const leases = fakeLeases();
    const outcome = await runOpsCli(h.deps(stop("--confirm", SCOPE), { leases: leases.factory }));
    expect(outcome.exitName).toBe("COMPLETED");
    expect(leases.currentCalls).toEqual([{ accountRef: ACCOUNT, environment: "LIVE_MICRO" }]);
    expect(leases.revoked).toEqual([{ fencingLeaseId: LEASE_ID, reason: `ops-cli stop-heartbeat by ${OPERATOR}: ${DESTRUCTIVE_REASON[1] ?? ""}` }]);
    expect(leases.closed).toBe(1);
    expect(phases(h.audit.records)).toEqual(["INVOKED", "ACTING", "OUTCOME"]);
    // Nothing reaches the venue: no credential, no venue, no heartbeat request.
    expect(h.touched).toEqual([]);
    expect(h.venue.calls).toEqual([]);
    expect(h.text()).toContain(`lease ${LEASE_ID} REVOKED`);
  });

  it("the guidance states the mechanism and the timing, quoting WP-320's cited fact, and says no transport is written", () => {
    const text = stopHeartbeatGuidance().join("\n");
    expect(text).toContain("FencingLeaseStore.revoke");
    expect(text).toContain("its fencing authority latches lost");
    expect(text).toContain("10–15 s after the last valid heartbeat (ADR-033 D6)");
    expect(text).toContain(HEARTBEAT_VENUE_FACTS.TIMEOUT_AND_SWEEP.quote);
    expect(text).toContain(HEARTBEAT_VENUE_FACTS.TIMEOUT_AND_SWEEP.source);
    expect(text).toContain("at most 60 s after its last successful renewal (FENCING_LEASE_MAX_TTL_MS)");
    expect(text).toContain("no heartbeat transport exists in this repository, and this CLI writes none (ADR-033 D2, D5)");
    expect(text).toContain("VERIFY with account-snapshot");
  });

  it("the guidance is printed on every invocation, before anything else is decided", async () => {
    const h = harness();
    const leases = fakeLeases();
    await runOpsCli(h.deps(stop("--dry-run"), { leases: leases.factory }));
    const text = h.text();
    expect(text.indexOf("GUIDANCE:")).toBeGreaterThan(-1);
    expect(text.indexOf("GUIDANCE:")).toBeLessThan(text.indexOf("PLAN (what will happen):"));
    expect(leases.revoked).toEqual([]);
  });

  it("the heartbeat id is never printed or audited", async () => {
    const h = harness();
    const leases = fakeLeases();
    await runOpsCli(h.deps(stop("--confirm", SCOPE), { leases: leases.factory }));
    expect(h.text()).not.toContain("hb-rotating-id-not-printed");
    expect(JSON.stringify(h.audit.records)).not.toContain("hb-rotating-id-not-printed");
    expect(h.text()).toContain("a venue heartbeat id is recorded (not printed)");
  });

  it("no ACTIVE lease: NOTHING_TO_DO, nothing revoked", async () => {
    const h = harness();
    const leases = fakeLeases(null);
    const outcome = await runOpsCli(h.deps(stop("--confirm", SCOPE), { leases: leases.factory }));
    expect(outcome.exitName).toBe("NOTHING_TO_DO");
    expect(outcome.exitCode).toBe(EXIT_CODES.NOTHING_TO_DO);
    expect(leases.revoked).toEqual([]);
    // WP-330 r1 (WP330-V1-04): only this process's realm was read, and the output says any other was not.
    expect(leases.currentCalls).toEqual([{ accountRef: ACCOUNT, environment: "LIVE_MICRO" }]);
    expect(h.text()).toContain("no ACTIVE, unexpired lease is held for this account in the LIVE_MICRO realm");
    expect(h.text()).toContain("whether a lease is held for this account in ANOTHER run-mode realm: only the LIVE_MICRO realm (this process's RUN_MODE) was read");
  });

  it("the lease ended between the read and the revoke: NOTHING_TO_DO, reported", async () => {
    const h = harness();
    const leases = fakeLeases();
    const factory = leases.factory;
    const outcome = await runOpsCli(
      h.deps(stop("--confirm", SCOPE), {
        leases: {
          open: async () => {
            const opened = await factory.open();
            if (opened.kind !== "OPEN") return opened;
            return {
              ...opened,
              leases: {
                current: opened.leases.current.bind(opened.leases),
                revoke: (input: { readonly fencingLeaseId: string; readonly reason: string }) => {
                  leases.lease = null; // the holder released it meanwhile
                  return opened.leases.revoke(input);
                },
              },
            };
          },
        },
      }),
    );
    expect(outcome.exitName).toBe("NOTHING_TO_DO");
    expect(h.text()).toContain("had already ended when the revoke ran");
  });

  it("the lease store is unreachable: DATABASE_UNAVAILABLE, nothing done", async () => {
    const h = harness();
    const outcome = await runOpsCli(h.deps(stop("--confirm", SCOPE), { leases: { open: () => Promise.resolve({ kind: "UNAVAILABLE" as const, reason: "NO_DATABASE_CONFIGURED" }) } }));
    expect(outcome.exitName).toBe("DATABASE_UNAVAILABLE");
    expect(outcome.exitCode).toBe(EXIT_CODES.DATABASE_UNAVAILABLE);
  });

  it("a revoke that throws: UNKNOWN (it may have applied)", async () => {
    const h = harness();
    const leases = fakeLeases();
    const outcome = await runOpsCli(
      h.deps(stop("--confirm", SCOPE), {
        leases: {
          open: async () => {
            const opened = await leases.factory.open();
            if (opened.kind !== "OPEN") return opened;
            return { ...opened, leases: { current: opened.leases.current.bind(opened.leases), revoke: () => Promise.reject(new Error("connection reset")) } };
          },
        },
      }),
    );
    expect(outcome.exitName).toBe("UNKNOWN");
  });
});
