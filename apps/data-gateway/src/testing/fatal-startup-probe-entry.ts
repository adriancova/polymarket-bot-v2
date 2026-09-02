/**
 * Subprocess probe entry for round-3 review finding R3-H1 — dev-only.
 *
 * R3-H1 needs a MAIN-SHAPED composition whose transport is CONNECTED and
 * holds a referenced handle when a fatal startup error strikes. The real
 * bundle cannot produce that in this repository's test environment: the only
 * permitted loopback endpoints are CLOSED ports (no Redis server, no
 * listening stub — nothing may accept a connection), and a failed connect
 * takes the R2-H5 `UnavailableEventTransport` path, which holds nothing
 * referenced and therefore cannot leak. This entry runs the EXACT sequence
 * `main.ts` runs — the same `runGatewaySequence`, the same system ports
 * (including the real lifetime anchor), the same real filesystem and socket
 * factories, the same fatal handler shape — substituting ONE thing: the
 * transport is an in-memory `MemoryEventTransport` wrapped with
 *
 * - one deliberately REFERENCED interval handle, standing in for the
 *   connected Redis client's socket (the handoff itself documents that
 *   socket as referenced), and
 * - a close-counting `close()` that logs `[probe] transport.close() call N`
 *   and clears the handle, so the spawning test can assert exactly-once
 *   disposal from stderr.
 *
 * At `45c231c` (pre-fix) this process logs `data-gateway: fatal` and then
 * HANGS on the referenced handle — the reviewer's exit-124 shape. With the
 * transactional startup it exits 1 promptly, with exactly one close call.
 *
 * The fatal scenario is injected purely through configuration, exactly as it
 * would strike in production:
 *
 * - WAL-open failure: `wal.rootPath` pointing at an existing regular FILE
 *   (the real `nodeWalFileSystem`'s `mkdir` fails with `ENOTDIR`), striking
 *   inside `DataGateway.create()` — after the transport "connected".
 * - `start()` failure: a `ws://` Coinbase endpoint, which the real adapter
 *   refuses inside `start()` — after `create()` succeeded (never dialled).
 *
 * SAFETY: identical to `main.ts` — public, unauthenticated data only; no
 * credential, signer, wallet, or order surface; nothing here can open a
 * network connection (the in-memory transport replaces the only client, the
 * fatal error strikes before any feed dials, and every configured endpoint in
 * the spawning tests is a closed loopback port anyway).
 */

import { readFile } from "node:fs/promises";

import { createWebSocketFactory } from "@polymarket-bot/binance-adapter";
import { nodeWebSocketFactory } from "@polymarket-bot/coinbase-adapter";
import type { MarketEventTransport } from "@polymarket-bot/event-bus";
import { globalHttpClient, globalWebSocketFactory } from "@polymarket-bot/polymarket-public";
import { nodeWalFileSystem } from "@polymarket-bot/storage-wal";

import { parseGatewayConfig } from "../config.js";
import { GatewayConfigurationError } from "../errors.js";
import { GatewayJournal } from "../journal.js";
import { parseCleanupDeadlineMs, runGatewaySequence } from "../run.js";
import {
  systemGatewayClock,
  systemGatewayIdSource,
  systemGatewayLifetime,
  systemGatewayTimers,
} from "../system.js";
import { MemoryEventTransport } from "./memory-transport.js";

/** Matches the lifetime anchor: the handle's existence is the point. */
const REFERENCED_HANDLE_INTERVAL_MS = 2_147_483_647;

/**
 * An in-memory transport that models what matters about a CONNECTED Redis
 * transport for R3-H1: it owns one referenced handle that only `close()`
 * releases, and `close()` reports every call to stderr for the exactly-once
 * assertion.
 */
function connectedReferencedTransport(): MarketEventTransport {
  const inner = new MemoryEventTransport();
  // Round 4: `GATEWAY_PROBE_TRANSPORT_CLOSE=reject-holding-handle` models the
  // round-4 finding's transport — `close()` REJECTS before releasing its
  // referenced handle, so a failed cleanup leaves the handle alive. The
  // default ("resolve") is the round-3 behavior, unchanged. Round 5 (M-1)
  // adds "resolve-after-50ms": a HEALTHY close that merely takes 50 ms — the
  // reviewer's legitimate-cleanup shape, which a valid deadline must never
  // punish (and which an unvalidated `NaN` deadline force-exited after ~4 ms).
  const closeMode = process.env["GATEWAY_PROBE_TRANSPORT_CLOSE"] ?? "resolve";
  // Deliberately NOT unref'd: this is the connected socket's stand-in.
  const handle = setInterval(() => {
    // The handle's existence, not this callback, is the point.
  }, REFERENCED_HANDLE_INTERVAL_MS);
  let closeCalls = 0;
  return {
    transportId: inner.transportId,
    retention: inner.retention,
    publish: (stream, envelope) => inner.publish(stream, envelope),
    subscribe: (options) => inner.subscribe(options),
    streamMetrics: (stream) => inner.streamMetrics(stream),
    close: async (): Promise<void> => {
      closeCalls += 1;
      console.error(`[probe] transport.close() call ${String(closeCalls)}`);
      if (closeMode === "reject-holding-handle") {
        throw new Error("injected transport close rejection (handle still referenced)");
      }
      if (closeMode === "resolve-after-50ms") {
        // A LEGITIMATE close that takes 50 ms (round 5, M-1): resolves and
        // releases the handle, just not instantly.
        await new Promise<void>((resolveDelay) => {
          setTimeout(resolveDelay, 50);
        });
      }
      clearInterval(handle);
      await inner.close();
    },
  };
}

async function main(): Promise<void> {
  const configPath = process.env["GATEWAY_CONFIG_PATH"];
  if (configPath === undefined || configPath === "") {
    console.error("GATEWAY_CONFIG_PATH is required (a JSON file matching GatewayConfigSchema)");
    process.exitCode = 1;
    return;
  }
  const config = parseGatewayConfig(JSON.parse(await readFile(configPath, "utf8")));

  // Round 5 (M-2): `GATEWAY_PROBE_JOURNAL_CLOSE=never-settle` models a WAL
  // disposal that never settles, striking inside `DataGateway.create()`'s own
  // post-open cleanup — the one cleanup await the round-4 deadline did not
  // cover (the sequence's deadline armed only after `create()` rejected,
  // which a never-settling close prevents forever). Dev-only prototype patch:
  // no production seam exists to replace the internal journal in a bundled
  // subprocess, and adding one for a test's sake would be worse.
  if (process.env["GATEWAY_PROBE_JOURNAL_CLOSE"] === "never-settle") {
    GatewayJournal.prototype.close = function neverSettlingClose(): Promise<void> {
      console.error("[probe] journal.close() will never settle (injected)");
      return new Promise<void>(() => {
        // Deliberately never settles.
      });
    };
  }

  // Round 5 (M-2): `GATEWAY_PROBE_OMIT_PORT=polymarket` omits the Polymarket
  // feed's ports so a config that enables that feed makes `#buildFeeds()`
  // throw AFTER the journal opened — the post-open construction refusal of
  // the reviewer's regression, injected without touching any source.
  const omitPolymarketPorts = process.env["GATEWAY_PROBE_OMIT_PORT"] === "polymarket";

  await runGatewaySequence({
    config,
    // The one substitution (see the header): resolves — the transport is
    // CONNECTED — and owns a referenced handle until close().
    connectTransport: () => Promise.resolve(connectedReferencedTransport()),
    retentionEvents: 100_000,
    // Round 4: same knob `main.ts` exposes, so the deadline tests run fast.
    // Round 5 (M-1): the same fail-closed parser, too.
    cleanupDeadlineMs: parseCleanupDeadlineMs(process.env["GATEWAY_CLEANUP_DEADLINE_MS"]),
    ports: {
      clock: systemGatewayClock(),
      ids: systemGatewayIdSource(),
      timers: systemGatewayTimers(),
      lifetime: systemGatewayLifetime(),
      walFileSystem: nodeWalFileSystem(),
      ...(omitPolymarketPorts
        ? {}
        : {
            polymarketSocketFactory: globalWebSocketFactory(),
            polymarketHttpClient: globalHttpClient(),
          }),
      rtdsSocketFactory: globalWebSocketFactory(),
      binanceSocketFactory: createWebSocketFactory(),
      coinbaseSocketFactory: nodeWebSocketFactory,
    },
    host: {
      logError: (line, detail) => {
        if (detail === undefined) {
          console.error(line);
        } else {
          console.error(line, detail);
        }
      },
      registerShutdownSignals: (handler) => {
        process.once("SIGINT", handler);
        process.once("SIGTERM", handler);
      },
      setExitCode: (code) => {
        process.exitCode = code;
      },
      // Round 4: identical to `main.ts` — referenced timer, forced exit.
      armCleanupDeadline: (delayMs, onExpiry) => {
        const handle = setTimeout(onExpiry, delayMs);
        return () => {
          clearTimeout(handle);
        };
      },
      forceExit: (code) => {
        process.exit(code);
      },
    },
  });
}

main().catch((error: unknown) => {
  if (error instanceof GatewayConfigurationError) {
    console.error(`data-gateway: ${error.message}`);
    console.error(JSON.stringify(error.details, null, 2));
    process.exitCode = 1;
    return;
  }
  console.error("data-gateway: fatal", error);
  process.exitCode = 1;
});
