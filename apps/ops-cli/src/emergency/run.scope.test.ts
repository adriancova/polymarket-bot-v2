/**
 * The credential boundary (handoff §15) and E-16 ("venue-truth reads are per
 * credential"): the emergency credential must act for the account the
 * operator named and confirmed. A credential for another account is refused
 * before the venue is opened (`SCOPE_MISMATCH`); a missing credential source,
 * venue binding or configuration each stop the command before anything is
 * sent, with its own exit code.
 */

import { installNetworkTripwire, type NetworkTripwire } from "@polymarket-bot/polymarket-secure/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EXIT_CODES } from "./exit-codes.js";
import { ACCOUNT, args, DESTRUCTIVE_REASON, harness, order } from "./harness.test-support.js";
import { runOpsCli } from "./run.js";

let tripwire: NetworkTripwire;
beforeEach(() => {
  tripwire = installNetworkTripwire();
});
afterEach(() => {
  tripwire.uninstall();
  expect(tripwire.refused()).toEqual([]);
});

const CANCEL_ALL = args("cancel-all", ...DESTRUCTIVE_REASON, "--confirm", `cancel-all:${ACCOUNT}`);

describe("the emergency credential acts for the named account, or nothing is sent", () => {
  it("a credential for ANOTHER account: SCOPE_MISMATCH, and the venue is never opened", async () => {
    const h = harness();
    h.venue.add(order("o-1"));
    let opened = 0;
    const outcome = await runOpsCli(
      h.deps(CANCEL_ALL, {
        credentials: { load: () => Promise.resolve({ kind: "LOADED" as const, credential: { accountRef: "acct-someone-else" } }) },
        venues: {
          open: () => {
            opened += 1;
            return Promise.resolve({ kind: "OPEN" as const, venue: h.venue.binding() });
          },
        },
      }),
    );
    expect(outcome.exitName).toBe("SCOPE_MISMATCH");
    expect(outcome.exitCode).toBe(EXIT_CODES.SCOPE_MISMATCH);
    expect(opened).toBe(0);
    expect(h.venue.calls).toEqual([]);
    expect(h.text()).toContain(`the emergency credential acts for account acct-someone-else, not ${ACCOUNT}: nothing was sent`);
  });

  it("a credential whose account cannot be read (an accessor): SCOPE_MISMATCH; the accessor never runs", async () => {
    const h = harness();
    let ran = false;
    const credential = {};
    Object.defineProperty(credential, "accountRef", {
      enumerable: true,
      get() {
        ran = true;
        return ACCOUNT;
      },
    });
    const outcome = await runOpsCli(h.deps(CANCEL_ALL, { credentials: { load: () => Promise.resolve({ kind: "LOADED" as const, credential: credential as { accountRef: string } }) } }));
    expect(outcome.exitName).toBe("SCOPE_MISMATCH");
    expect(ran).toBe(false);
  });

  it("the credential source is told the account and the gate's verdict, and nothing else", async () => {
    const h = harness();
    const seen: unknown[] = [];
    await runOpsCli(
      h.deps(CANCEL_ALL, {
        credentials: {
          load: (request) => {
            seen.push(request);
            return Promise.resolve({ kind: "UNAVAILABLE" as const, reason: "NO_EMERGENCY_CREDENTIAL_SOURCE" });
          },
        },
      }),
    );
    expect(seen).toEqual([{ accountRef: ACCOUNT, gate: { runMode: "LIVE_MICRO", maximumRunMode: "LIVE_MICRO", allowRealOrders: true } }]);
  });

  it("no credential source: CREDENTIALS_UNAVAILABLE; a source that throws: the same, with no text of its error", async () => {
    const unavailable = harness();
    const outcome = await runOpsCli(unavailable.deps(CANCEL_ALL, { credentials: { load: () => Promise.resolve({ kind: "UNAVAILABLE" as const, reason: "NO_EMERGENCY_CREDENTIAL_SOURCE" }) } }));
    expect(outcome.exitName).toBe("CREDENTIALS_UNAVAILABLE");
    const throwing = harness();
    const thrown = await runOpsCli(throwing.deps(CANCEL_ALL, { credentials: { load: () => Promise.reject(new Error("vault said: token=SECRET-xyz")) } }));
    expect(thrown.exitName).toBe("CREDENTIALS_UNAVAILABLE");
    expect(throwing.text()).not.toContain("SECRET-xyz");
  });

  it("no venue binding: CREDENTIALS_UNAVAILABLE; an unparseable reason is never echoed", async () => {
    const h = harness();
    const outcome = await runOpsCli(h.deps(CANCEL_ALL, { venues: { open: () => Promise.resolve({ kind: "UNAVAILABLE" as const, reason: "binding failed: key=SECRET-abc" }) } }));
    expect(outcome.exitName).toBe("CREDENTIALS_UNAVAILABLE");
    expect(h.text()).toContain("no venue binding: UNSPECIFIED");
    expect(h.text()).not.toContain("SECRET-abc");
  });

  it("an invalid configuration: CONFIGURATION_REFUSED, before any credential is asked for", async () => {
    const h = harness({ configuration: { schema: "something-else" } });
    const outcome = await runOpsCli(h.deps(CANCEL_ALL));
    expect(outcome.exitName).toBe("CONFIGURATION_REFUSED");
    expect(outcome.exitCode).toBe(EXIT_CODES.CONFIGURATION_REFUSED);
    expect(h.touched).toEqual(["configuration"]);
  });
});
