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
 * - DNS (`dns.lookup`, `dns.promises.lookup`, `dns.resolve4`, a `Resolver`
 *   and a `dns/promises` `Resolver`, and a named ESM import) throws and is
 *   recorded (WP-260 r2, finding L-R2-3);
 * - UDP (`dgram` `connect` and `send`) throws and is recorded (L-R2-3);
 * - `uninstall` restores every original, and is idempotent.
 *
 * Every target is the loopback address and a closed port: even if a leg
 * were missing, nothing would leave this machine.
 */

import dgram from "node:dgram";
import dns, { lookup as namedLookup } from "node:dns";
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

  it("DNS (L-R2-3): lookup, promises.lookup, resolve4 and both Resolver classes throw and are recorded", async () => {
    tripwire = installNetworkTripwire();
    expect(() => dns.lookup("localhost", () => undefined)).toThrow(NetworkTripwireError);
    expect(() => namedLookup("localhost", () => undefined)).toThrow(NetworkTripwireError);
    expect(() => dns.promises.lookup("localhost")).toThrow(NetworkTripwireError);
    expect(() => dns.resolve4("localhost", () => undefined)).toThrow(NetworkTripwireError);
    expect(() => new dns.Resolver().resolve4("localhost", () => undefined)).toThrow(NetworkTripwireError);
    expect(() => new dns.promises.Resolver().resolve4("localhost")).toThrow(NetworkTripwireError);
    expect(tripwire.refused()).toEqual([
      { via: "dns", target: "lookup(localhost)" },
      { via: "dns", target: "lookup(localhost)" },
      { via: "dns", target: "lookup(localhost)" },
      { via: "dns", target: "resolve4(localhost)" },
      { via: "dns", target: "resolve4(localhost)" },
      { via: "dns", target: "resolve4(localhost)" },
    ]);
  });

  it("UDP (L-R2-3): dgram connect and send throw and are recorded", () => {
    tripwire = installNetworkTripwire();
    const socket = dgram.createSocket("udp4");
    try {
      expect(() => socket.connect(LOOPBACK_CLOSED_PORT, "127.0.0.1")).toThrow(NetworkTripwireError);
      expect(() => socket.send("x", LOOPBACK_CLOSED_PORT, "127.0.0.1")).toThrow(NetworkTripwireError);
    } finally {
      socket.close();
    }
    expect(tripwire.refused()).toEqual([
      { via: "dgram", target: `connect(${LOOPBACK_CLOSED_PORT},127.0.0.1)` },
      { via: "dgram", target: `send(x,${LOOPBACK_CLOSED_PORT},127.0.0.1)` },
    ]);
  });

  it("uninstall restores every DNS and UDP method exactly (own or inherited)", () => {
    const resolverPrototype = dns.Resolver.prototype as unknown as Record<string, unknown>;
    const before = {
      lookup: dns.lookup,
      promisesLookup: dns.promises.lookup,
      resolve4: dns.resolve4,
      resolverOwn: Object.getOwnPropertyDescriptor(resolverPrototype, "resolve4"),
      send: dgram.Socket.prototype.send,
      connect: dgram.Socket.prototype.connect,
    };
    const installed = installNetworkTripwire();
    expect(dns.lookup).not.toBe(before.lookup);
    installed.uninstall();
    expect(dns.lookup).toBe(before.lookup);
    expect(dns.promises.lookup).toBe(before.promisesLookup);
    expect(dns.resolve4).toBe(before.resolve4);
    expect(Object.getOwnPropertyDescriptor(resolverPrototype, "resolve4")).toEqual(before.resolverOwn);
    expect(dgram.Socket.prototype.send).toBe(before.send);
    expect(dgram.Socket.prototype.connect).toBe(before.connect);
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
