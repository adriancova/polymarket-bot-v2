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
 *   (`http`, `https`, `tls`, `ws`, database drivers) goes through.
 *
 * A test asserts `attempts()` is empty at the end, so a stray call fails the
 * test even when the caller swallowed the thrown error.
 *
 * A test that needs the SDK to see an HTTP RESPONSE (the contract tests)
 * installs a `responder` for `fetch`: it answers from in-memory fixtures and
 * is still recorded; it never delegates to the real `fetch`.
 */

import net from "node:net";

export interface NetworkAttempt {
  readonly via: "fetch" | "WebSocket" | "net.Socket.connect";
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
    const first = args[0];
    const target =
      typeof first === "object" && first !== null
        ? `${String((first as { host?: unknown }).host ?? "")}:${String((first as { port?: unknown }).port ?? (first as { path?: unknown }).path ?? "")}`
        : String(first);
    refused.push({ via: "net.Socket.connect", target });
    throw new NetworkTripwireError(`network tripwire: net.Socket.connect(${target}) refused`);
  };

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
    },
  };
}
