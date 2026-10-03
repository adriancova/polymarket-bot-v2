/**
 * WP-280 acceptance (safety): NO SOCKET OPENS IN PAPER.
 *
 * `createUserStreamManager` runs WP-260's run-mode gate before it reads the
 * transport. For every context a PAPER, BACKTEST, SHADOW or replay process
 * could present (and for every unreadable one), construction throws
 * `SignerBoundaryRefusal` and:
 *
 * - the transport is never touched: it is a Proxy that records every trap,
 *   and records none;
 * - a transport that WOULD dial the real user channel (`new WebSocket(...)`)
 *   never does, and WP-260's network tripwire records no attempt.
 *
 * NON-VACUOUS: with a live-SHAPED context the same dialling transport IS
 * reached on `start()`, and the tripwire DOES record (and refuse) the dial;
 * and the recording Proxy does record accesses when the gate permits.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SignerBoundaryRefusal } from "../errors.js";
import { signerGateContextFromSafetyFlags } from "../run-mode-gate.js";
import { installNetworkTripwire, type NetworkTripwire } from "../testing/network-tripwire.js";

import { createUserStreamManager, type UserStreamOutput } from "./manager.js";
import type { AuthenticatedUserSocketPort, UserSocketConnection, UserSocketHandlers } from "./socket-port.js";
import { ManualTimers } from "./testing/fake-socket-port.js";
import { FIXTURE_MARKET, LIVE_SHAPED_CONTEXT } from "./testing/harness.js";
import { USER_CHANNEL_URL } from "./venue-facts.js";

let tripwire: NetworkTripwire;
beforeEach(() => {
  tripwire = installNetworkTripwire();
});
afterEach(() => {
  tripwire.uninstall();
});

/** A transport that would open the real user channel if it were ever asked to. */
class DiallingTransport implements AuthenticatedUserSocketPort {
  dials = 0;

  connect(handlers: UserSocketHandlers): UserSocketConnection {
    this.dials += 1;
    const socket = new (globalThis as unknown as { WebSocket: new (url: string) => unknown }).WebSocket(USER_CHANNEL_URL);
    void socket;
    void handlers;
    throw new Error("unreachable: the tripwire refuses the dial");
  }
}

/** A Proxy around `target` that records every trap. */
function recording<T extends object>(target: T): { readonly proxy: T; readonly traps: string[] } {
  const traps: string[] = [];
  const handler: ProxyHandler<T> = {};
  for (const trap of ["get", "has", "ownKeys", "getOwnPropertyDescriptor", "getPrototypeOf", "apply", "construct", "set", "defineProperty"] as const) {
    (handler as Record<string, unknown>)[trap] = (...args: unknown[]) => {
      traps.push(trap);
      return (Reflect[trap] as (...a: unknown[]) => unknown)(...args);
    };
  }
  return { proxy: new Proxy(target, handler), traps };
}

const REFUSED_CONTEXTS: readonly [string, unknown][] = [
  ["PAPER (the repository default)", { runMode: "PAPER", maximumRunMode: "PAPER", allowRealOrders: false }],
  ["PAPER with allowRealOrders true", { runMode: "PAPER", maximumRunMode: "LIVE", allowRealOrders: true }],
  ["BACKTEST", { runMode: "BACKTEST", maximumRunMode: "PAPER", allowRealOrders: false }],
  ["SHADOW", { runMode: "SHADOW", maximumRunMode: "LIVE", allowRealOrders: true }],
  ["REPLAY (not a §11 mode)", { runMode: "REPLAY", maximumRunMode: "LIVE", allowRealOrders: true }],
  ["LIVE_MICRO above a PAPER maximum", { runMode: "LIVE_MICRO", maximumRunMode: "PAPER", allowRealOrders: true }],
  ["LIVE_MICRO with the string 'true'", { runMode: "LIVE_MICRO", maximumRunMode: "LIVE_MICRO", allowRealOrders: "true" }],
  ["the defaults read from an empty environment record", signerGateContextFromSafetyFlags({})],
  ["RUN_MODE=PAPER from flags", signerGateContextFromSafetyFlags({ RUN_MODE: "PAPER" })],
  ["no context", undefined],
  ["a getter context", Object.defineProperty({}, "runMode", { get: () => "LIVE_MICRO", enumerable: true })],
];

describe("no socket opens in PAPER (or any non-live mode)", () => {
  for (const [label, runModeContext] of REFUSED_CONTEXTS) {
    it(`${label}: construction is refused before the transport is read`, () => {
      const dialling = new DiallingTransport();
      const { proxy, traps } = recording(dialling);
      const timers = recording(new ManualTimers());
      const outputs: UserStreamOutput[] = [];
      expect(() =>
        createUserStreamManager({
          runModeContext,
          transport: proxy,
          timers: timers.proxy,
          markets: [FIXTURE_MARKET],
          onOutput: (output) => outputs.push(output),
        }),
      ).toThrow(SignerBoundaryRefusal);
      expect(traps).toEqual([]);
      expect(timers.traps).toEqual([]);
      expect(dialling.dials).toBe(0);
      expect(outputs).toEqual([]);
      expect(tripwire.refused()).toEqual([]);
    });
  }

  it("an options bag whose run-mode context is a getter is refused without invoking it", () => {
    let invoked = 0;
    const options = {
      transport: new DiallingTransport(),
      timers: new ManualTimers(),
      markets: [FIXTURE_MARKET],
      onOutput: () => undefined,
    };
    Object.defineProperty(options, "runModeContext", {
      enumerable: true,
      get: () => {
        invoked += 1;
        return LIVE_SHAPED_CONTEXT;
      },
    });
    expect(() => createUserStreamManager(options as never)).toThrow(SignerBoundaryRefusal);
    expect(invoked).toBe(0);
    expect(tripwire.refused()).toEqual([]);
  });

  it("refusal reasons are WP-260's fixed codes (PAPER: RUN_MODE_REQUIRES_NO_SIGNER, REAL_ORDERS_NOT_ALLOWED)", () => {
    try {
      createUserStreamManager({
        runModeContext: { runMode: "PAPER", maximumRunMode: "PAPER", allowRealOrders: false },
        transport: new DiallingTransport(),
        timers: new ManualTimers(),
        markets: [FIXTURE_MARKET],
        onOutput: () => undefined,
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SignerBoundaryRefusal);
      expect((error as SignerBoundaryRefusal).reasons).toEqual(["RUN_MODE_REQUIRES_NO_SIGNER", "REAL_ORDERS_NOT_ALLOWED"]);
    }
  });

  it("NON-VACUOUS: with a live-shaped context the dialling transport is reached on start, and the tripwire sees the dial", () => {
    const dialling = new DiallingTransport();
    const { proxy, traps } = recording(dialling);
    const outputs: UserStreamOutput[] = [];
    const manager = createUserStreamManager({
      runModeContext: LIVE_SHAPED_CONTEXT,
      transport: proxy,
      timers: new ManualTimers(),
      markets: [FIXTURE_MARKET],
      onOutput: (output) => outputs.push(output),
    });
    expect(traps.length).toBeGreaterThan(0);
    expect(dialling.dials).toBe(0);
    manager.start();
    expect(dialling.dials).toBe(1);
    expect(tripwire.refused()).toEqual([{ via: "WebSocket", target: USER_CHANNEL_URL }]);
    // The refused dial is a lost connection, and requests reconciliation like any other.
    expect(outputs.flatMap((output) => (output.kind === "RECONCILIATION_REQUESTED" ? [output.request.cause] : []))).toEqual(["CONNECT_FAILED"]);
    manager.stop();
  });
});
