/**
 * TEST-ONLY network tripwire (work-plan `WP-260` acceptance: "Ordinary tests
 * use mocks/fixtures, not real orders"; handoff §16.3: "Contract tests must
 * not place real orders in ordinary CI").
 *
 * While installed, every way this package's code (or the SDK it wraps) could
 * reach a network throws and is counted:
 *
 * - `globalThis.fetch` (the SDK's HTTP client, `ky`, calls it);
 * - `globalThis.WebSocket` (the SDK's realtime managers construct it);
 * - `net.Socket.prototype.connect`, which every TCP and TLS client in Node
 *   (`http`, `https`, `tls`, `ws`, database drivers) goes through;
 * - DNS: every `lookup*`, `resolve*` and `reverse` function of `node:dns` and
 *   `node:dns/promises`, and the same methods of both `Resolver` classes
 *   (a name lookup is itself a network query, and can leak the name);
 * - UDP: `dgram.Socket.prototype.send` and `.connect`.
 *
 * Named ESM imports of `node:dns` see the replacements too:
 * `module.syncBuiltinESMExports()` runs after installing and after restoring.
 *
 * A test asserts `attempts()` is empty at the end, so a stray call fails the
 * test even when the caller swallowed the thrown error.
 *
 * A test that needs the SDK to see an HTTP RESPONSE (the contract tests)
 * installs a `responder` for `fetch`: it answers from in-memory fixtures and
 * is still recorded; it never delegates to the real `fetch`.
 */

import dgram from "node:dgram";
import dns from "node:dns";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";

export interface NetworkAttempt {
  readonly via: "fetch" | "WebSocket" | "net.Socket.connect" | "dns" | "dgram";
  readonly target: string;
}

export class NetworkTripwireError extends Error {
  override readonly name = "NetworkTripwireError";
}

export interface NetworkTripwire {
  /** Attempts that were refused (not answered by a responder). */
  refused(): readonly NetworkAttempt[];
  /** Requests answered by the fixture responder. */
  answered(): readonly NetworkAttempt[];
  /** Restore the originals. Idempotent. */
  uninstall(): void;
}

export type FetchResponder = (url: string, init: RequestInit | undefined) => Response | undefined;

function describeTarget(input: unknown): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (typeof Request !== "undefined" && input instanceof Request) return input.url;
  return "[unrecognised fetch input]";
}

/** A DNS function name the tripwire refuses (every query-making function). */
const DNS_QUERY = /^(?:lookup|lookupService|resolve[A-Za-z0-9]*|reverse)$/u;

interface Patched {
  readonly target: Record<string, unknown>;
  readonly key: string;
  /** The original OWN descriptor, or `undefined` when the method was inherited. */
  readonly original: PropertyDescriptor | undefined;
}

/**
 * Replace `target[key]` with a refusing function, remembering how to restore
 * it exactly (an inherited method is shadowed, then the shadow is deleted).
 */
function patch(patched: Patched[], target: Record<string, unknown>, key: string, refuse: (...args: unknown[]) => never): void {
  patched.push({ target, key, original: Object.getOwnPropertyDescriptor(target, key) });
  Object.defineProperty(target, key, { configurable: true, enumerable: true, writable: true, value: refuse });
}

function dnsQueryKeys(target: object): string[] {
  const keys = new Set<string>();
  for (let object: object | null = target; object !== null && object !== Object.prototype; object = Object.getPrototypeOf(object) as object | null) {
    for (const key of Object.getOwnPropertyNames(object)) {
      if (DNS_QUERY.test(key) && typeof (target as Record<string, unknown>)[key] === "function") keys.add(key);
    }
  }
  return [...keys];
}

/**
 * Install the tripwire. With a `responder`, a `fetch` whose response the
 * responder returns is answered from memory; every other attempt throws.
 */
export function installNetworkTripwire(options: { readonly responder?: FetchResponder } = {}): NetworkTripwire {
  const refused: NetworkAttempt[] = [];
  const answered: NetworkAttempt[] = [];
  const originalFetch = globalThis.fetch;
  const hadWebSocket = Object.prototype.hasOwnProperty.call(globalThis, "WebSocket");
  const originalWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;
  // The prototype method is replaced here and restored by `uninstall`.
  const socketPrototype = net.Socket.prototype as unknown as { connect: (...args: unknown[]) => unknown };
  const originalConnect = socketPrototype.connect;

  const trippedFetch = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const target = describeTarget(input);
    const response = options.responder?.(target, init);
    if (response !== undefined) {
      answered.push({ via: "fetch", target });
      return response;
    }
    refused.push({ via: "fetch", target });
    throw new NetworkTripwireError(`network tripwire: fetch(${target}) refused`);
  };
  globalThis.fetch = trippedFetch as typeof fetch;

  class TrippedWebSocket {
    constructor(url: unknown) {
      refused.push({ via: "WebSocket", target: String(url) });
      throw new NetworkTripwireError(`network tripwire: new WebSocket(${String(url)}) refused`);
    }
  }
  (globalThis as { WebSocket?: unknown }).WebSocket = TrippedWebSocket;

  socketPrototype.connect = function trippedConnect(...args: unknown[]): never {
    // `net.connect` / `tls.connect` pass Node's normalised `[options, cb]`
    // array as the first argument; a direct call passes the options.
    const first = Array.isArray(args[0]) ? (args[0] as unknown[])[0] : args[0];
    const target =
      typeof first === "object" && first !== null
        ? `${String((first as { host?: unknown }).host ?? "")}:${String((first as { port?: unknown }).port ?? (first as { path?: unknown }).path ?? "")}`
        : String(first);
    refused.push({ via: "net.Socket.connect", target });
    throw new NetworkTripwireError(`network tripwire: net.Socket.connect(${target}) refused`);
  };

  const patched: Patched[] = [];
  const dnsTargets: Record<string, unknown>[] = [
    dns as unknown as Record<string, unknown>,
    dns.promises as unknown as Record<string, unknown>,
    dns.Resolver.prototype as unknown as Record<string, unknown>,
    dns.promises.Resolver.prototype as unknown as Record<string, unknown>,
  ];
  for (const target of dnsTargets) {
    for (const key of dnsQueryKeys(target)) {
      patch(patched, target, key, (...args: unknown[]): never => {
        const description = `${key}(${typeof args[0] === "string" ? args[0] : typeof args[0]})`;
        refused.push({ via: "dns", target: description });
        throw new NetworkTripwireError(`network tripwire: dns ${description} refused`);
      });
    }
  }
  const udpPrototype = dgram.Socket.prototype as unknown as Record<string, unknown>;
  for (const key of ["send", "connect"]) {
    patch(patched, udpPrototype, key, (...args: unknown[]): never => {
      const description = `${key}(${args.map((arg) => (typeof arg === "string" || typeof arg === "number" ? String(arg) : typeof arg)).join(",")})`;
      refused.push({ via: "dgram", target: description });
      throw new NetworkTripwireError(`network tripwire: dgram ${description} refused`);
    });
  }
  syncBuiltinESMExports();

  let installed = true;
  return {
    refused: () => [...refused],
    answered: () => [...answered],
    uninstall: () => {
      if (!installed) return;
      installed = false;
      globalThis.fetch = originalFetch;
      if (hadWebSocket) {
        (globalThis as { WebSocket?: unknown }).WebSocket = originalWebSocket;
      } else {
        delete (globalThis as { WebSocket?: unknown }).WebSocket;
      }
      socketPrototype.connect = originalConnect;
      for (const { target, key, original } of patched.reverse()) {
        if (original === undefined) {
          delete target[key];
        } else {
          Object.defineProperty(target, key, original);
        }
      }
      syncBuiltinESMExports();
    },
  };
}
