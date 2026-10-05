/**
 * WP-260's obligation on WP-330: use its secure client and redaction through
 * its public API only. Here the cancel half of the emergency venue IS WP-260's
 * client: built by its own test factory (the same construction path as the
 * real one: the run-mode gate first, then the handle checks), over its
 * scripted fake SDK and its key-less mock signer. Nothing reaches a venue.
 */

import type { SecureVenueClient, SignerGateContext } from "@polymarket-bot/polymarket-secure";
import {
  createFakeSdkFactory,
  createMockSignerHandle,
  createSecureVenueClientForTesting,
  FAKE_SDK_CREDENTIALS,
  installNetworkTripwire,
  MOCK_SIGNER_ADDRESS,
  type FakeSdkScript,
  type NetworkTripwire,
} from "@polymarket-bot/polymarket-secure/testing";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from "vitest";

import { ACCOUNT, args, DESTRUCTIVE_REASON, harness, order, PAPER_FLAGS, phases, testConfiguration } from "./harness.test-support.js";
import type { EmergencyCancelClient, EmergencyVenueFactory } from "./ports.js";
import { runOpsCli } from "./run.js";

let tripwire: NetworkTripwire;
beforeEach(() => {
  tripwire = installNetworkTripwire();
});
afterEach(() => {
  tripwire.uninstall();
  expect(tripwire.refused()).toEqual([]);
});

/** A venue factory whose cancels are WP-260's client, built with the gate context the CLI hands it. */
function secureVenues(h: ReturnType<typeof harness>, script: FakeSdkScript): { readonly factory: EmergencyVenueFactory; readonly sdk: ReturnType<typeof createFakeSdkFactory> } {
  const sdk = createFakeSdkFactory(script);
  return {
    sdk,
    factory: {
      open: async ({ gate, onRateLimitUpdate }: { readonly gate: SignerGateContext; readonly onRateLimitUpdate: Parameters<EmergencyVenueFactory["open"]>[0]["onRateLimitUpdate"] }) => {
        const cancels: SecureVenueClient = await createSecureVenueClientForTesting({ runModeContext: { ...gate }, signer: createMockSignerHandle().handle, onRateLimitUpdate }, sdk.factory);
        return { kind: "OPEN" as const, venue: { cancels, reads: h.venue.reads } };
      },
    },
  };
}

describe("WP-260: the cancel path is WP-260's secure client", () => {
  it("a SecureVenueClient IS an EmergencyCancelClient (compile time)", () => {
    expectTypeOf<SecureVenueClient>().toMatchTypeOf<EmergencyCancelClient>();
  });

  it("cancel-all runs end to end over WP-260's client: its cancelAll reaches the (fake) SDK once, its answer is mapped and reported", async () => {
    const h = harness();
    h.venue.add(order("o-1"), order("o-2"));
    const { factory, sdk } = secureVenues(h, {
      cancelAll: () => {
        for (const entry of h.venue.open()) entry.status = "CANCELED";
        // The SDK's OrderId is a branded string; the fake answers plain text, as the wire does.
        return { canceled: ["o-1", "o-2"], notCanceled: {} } as never;
      },
    });
    const outcome = await runOpsCli(h.deps(args("cancel-all", ...DESTRUCTIVE_REASON, "--confirm", `cancel-all:${ACCOUNT}`), { venues: factory }));
    expect(outcome.exitName).toBe("COMPLETED");
    expect(sdk.recorder.calls.get("cancelAll")).toBe(1);
    expect(h.text()).toContain("answer COMPLETED: canceled 2 [o-1, o-2]");
    // The budget draws on the signer WP-260's client reports (identity, not secret).
    expect(h.text()).toContain(`signer ${MOCK_SIGNER_ADDRESS}`);
    // The SDK object's L2 credential (FAKE, held the way the real SDK holds it) never surfaces.
    for (const value of Object.values(FAKE_SDK_CREDENTIALS)) {
      expect(h.text()).not.toContain(value);
      expect(JSON.stringify(h.audit.records)).not.toContain(value);
    }
  });

  it("an SDK failure is WP-260's typed, redacted UNKNOWN: the CLI reports it, completes the grant, and reads venue truth again", async () => {
    const h = harness();
    h.venue.add(order("o-1"));
    const { factory } = secureVenues(h, {
      cancelAll: () => {
        throw new Error(`socket hang up near ${FAKE_SDK_CREDENTIALS.secret}`);
      },
      cancelOrders: (request: { orderIds: string[] }) => {
        for (const id of request.orderIds) {
          const entry = h.venue.orders.get(id);
          if (entry !== undefined) entry.status = "CANCELED";
        }
        return { canceled: request.orderIds, notCanceled: {} } as never;
      },
    });
    const outcome = await runOpsCli(h.deps(args("cancel-all", ...DESTRUCTIVE_REASON, "--confirm", `cancel-all:${ACCOUNT}`), { venues: factory }));
    expect(h.text()).toContain("DELETE /cancel-all: sent");
    expect(h.text()).toMatch(/answer UNKNOWN \(UNKNOWN, effect UNKNOWN\)/u);
    expect(h.text()).not.toContain(FAKE_SDK_CREDENTIALS.secret);
    // o-1 is still listed (the fake SDK applied nothing), so the by-id sweep goes through WP-260's cancelOrders too.
    expect(h.text()).toContain("DELETE /orders (1 id): sent");
    expect(outcome.exitName).toBe("COMPLETED");
  });

  it("CX330-R1-02: WP-260's own close awaits the SDK's closeSubscriptions() unbounded; one that never settles still lets cancel-all end, with its OUTCOME recorded", async () => {
    const h = harness({ configuration: testConfiguration({ venueAnswerBoundMs: 50 }) });
    h.venue.add(order("o-1"));
    const { factory, sdk } = secureVenues(h, {
      cancelAll: () => {
        for (const entry of h.venue.open()) entry.status = "CANCELED";
        return { canceled: ["o-1"], notCanceled: {} } as never;
      },
      closeSubscriptions: () => new Promise(() => undefined),
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      runOpsCli(h.deps(args("cancel-all", ...DESTRUCTIVE_REASON, "--confirm", `cancel-all:${ACCOUNT}`), { venues: factory })),
      new Promise<"HUNG">((resolve) => (timer = setTimeout(() => resolve("HUNG"), 3_000))),
    ]);
    clearTimeout(timer);
    expect(outcome).not.toBe("HUNG");
    expect(outcome).toMatchObject({ exitName: "COMPLETED" });
    expect(sdk.recorder.calls.get("closeSubscriptions")).toBe(1);
    expect(phases(h.audit.records)).toEqual(["INVOKED", "ACTING", "OUTCOME"]);
    expect(h.text()).toContain("release: the venue client did not finish releasing within 50 ms");
  });

  it("WP-260's own gate stands behind the CLI's: a factory handed a PAPER context refuses to build the client", async () => {
    const sdk = createFakeSdkFactory();
    const paper = { runMode: PAPER_FLAGS["RUN_MODE"], maximumRunMode: PAPER_FLAGS["MAX_RUN_MODE"], allowRealOrders: false };
    await expect(createSecureVenueClientForTesting({ runModeContext: paper, signer: createMockSignerHandle().handle }, sdk.factory)).rejects.toMatchObject({ name: "SignerBoundaryRefusal" });
    expect(sdk.recorder.factoryCalls).toEqual([]);
  });
});
