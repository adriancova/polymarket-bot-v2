/**
 * Self-test of the TEST-ONLY network tripwire (WP-260 r1, finding M2). Every
 * leg the tripwire claims to cover is exercised here, so removing a leg fails
 * THIS suite (which runs in the root `pnpm test`), not only the contract
 * suite:
 *
 * - `fetch` is refused and recorded; a fixture responder answers and is
 *   recorded separately;
 * - `new WebSocket(...)` throws synchronously and is recorded;
 * - `net.connect` and `tls.connect` (both through `net.Socket.prototype.connect`)
 *   throw and are recorded;
 * - `uninstall` restores every original, and is idempotent.
 *
 * Every target is the loopback address and a closed port: even if a leg
 * were missing, nothing would leave this machine.
 */

import net from "node:net";
import tls from "node:tls";

import { afterEach, describe, expect, it } from "vitest";

import { installNetworkTripwire, NetworkTripwireError, type NetworkTripwire } from "./network-tripwire.js";

const LOOPBACK_CLOSED_PORT = 9;

let tripwire: NetworkTripwire | undefined;
afterEach(() => {
  tripwire?.uninstall();
  tripwire = undefined;
});

describe("the network tripwire blocks and records every leg it claims", () => {
  it("fetch: refused and recorded", async () => {
    tripwire = installNetworkTripwire();
    await expect(fetch(`http://127.0.0.1:${LOOPBACK_CLOSED_PORT}/x`)).rejects.toBeInstanceOf(NetworkTripwireError);
    expect(tripwire.refused()).toEqual([{ via: "fetch", target: `http://127.0.0.1:${LOOPBACK_CLOSED_PORT}/x` }]);
    expect(tripwire.answered()).toEqual([]);
  });

  it("fetch: a fixture responder answers from memory, and is recorded as answered", async () => {
    tripwire = installNetworkTripwire({ responder: (url) => (url.endsWith("/fixture") ? new Response("ok") : undefined) });
    expect(await (await fetch("http://127.0.0.1/fixture")).text()).toBe("ok");
    expect(tripwire.answered()).toEqual([{ via: "fetch", target: "http://127.0.0.1/fixture" }]);
    expect(tripwire.refused()).toEqual([]);
  });

  it("WebSocket: construction throws synchronously and is recorded", () => {
    tripwire = installNetworkTripwire();
    const url = `ws://127.0.0.1:${LOOPBACK_CLOSED_PORT}/`;
    expect(() => new WebSocket(url)).toThrow(NetworkTripwireError);
    expect(tripwire.refused()).toEqual([{ via: "WebSocket", target: url }]);
  });

  it("net.connect (TCP): throws and is recorded", () => {
    tripwire = installNetworkTripwire();
    expect(() => net.connect({ host: "127.0.0.1", port: LOOPBACK_CLOSED_PORT })).toThrow(NetworkTripwireError);
    expect(tripwire.refused()).toEqual([{ via: "net.Socket.connect", target: `127.0.0.1:${LOOPBACK_CLOSED_PORT}` }]);
  });

  it("tls.connect (TLS): throws and is recorded through the same socket leg", () => {
    tripwire = installNetworkTripwire();
    expect(() => tls.connect({ host: "127.0.0.1", port: LOOPBACK_CLOSED_PORT })).toThrow(NetworkTripwireError);
    expect(tripwire.refused().map((attempt) => attempt.via)).toEqual(["net.Socket.connect"]);
  });

  it("uninstall restores fetch, WebSocket and net.Socket.prototype.connect, and is idempotent", () => {
    const originals = { fetch: globalThis.fetch, WebSocket: globalThis.WebSocket, connect: net.Socket.prototype.connect };
    const installed = installNetworkTripwire();
    expect(globalThis.fetch).not.toBe(originals.fetch);
    expect(globalThis.WebSocket).not.toBe(originals.WebSocket);
    expect(net.Socket.prototype.connect).not.toBe(originals.connect);
    installed.uninstall();
    installed.uninstall();
    expect(globalThis.fetch).toBe(originals.fetch);
    expect(globalThis.WebSocket).toBe(originals.WebSocket);
    expect(net.Socket.prototype.connect).toBe(originals.connect);
  });
});
