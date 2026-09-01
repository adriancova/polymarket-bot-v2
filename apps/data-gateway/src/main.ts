/**
 * Runnable entry point: `pnpm --filter @polymarket-bot/data-gateway start`.
 *
 * Composition per the research-worker precedent (WP-130): esbuild bundles
 * this file, because the repository has no runtime build story for TS
 * workspace imports (`tsc && node dist` fails with ERR_MODULE_NOT_FOUND).
 *
 * Environment (all values are paths, sizes, or public endpoints; NOTHING here
 * is or can be a credential — the gateway consumes public, unauthenticated
 * data only, and the config schema is strict):
 *
 * - `GATEWAY_CONFIG_PATH`      (required) JSON file matching `GatewayConfigSchema`.
 * - `GATEWAY_REDIS_URL`        (default `redis://127.0.0.1:6379`) the WP-060
 *                              transport's Redis, e.g. from
 *                              `infra/compose/data-gateway/compose.yaml`.
 * - `GATEWAY_RETENTION_EVENTS` (default 100000) transport retention bound.
 *                              ADR-003: a safety parameter, not a tuning knob —
 *                              size it against the worst tolerated trader
 *                              restart.
 * - `GATEWAY_CLEANUP_DEADLINE_MS` (default 10000) hard deadline for both
 *                              cleanup paths — fatal startup and signal
 *                              shutdown (round 4, `run.ts` module header). If
 *                              a resource's cleanup hangs or rejects while
 *                              holding a referenced handle, the process
 *                              force-exits nonzero when this expires instead
 *                              of wedging. A safety parameter, not a tuning
 *                              knob.
 *
 * ## Recording does not depend on the transport (§4.2, review H5)
 *
 * The transport connection is attempted, but it is NOT a precondition for
 * starting. If it fails, the gateway is built on
 * `UnavailableEventTransport`, publication is put into the terminal halt (PAGE
 * incident included) that a mid-run outage produces, and the WAL and every
 * public feed start anyway. A recorder restarted while Redis is down records
 * every frame; round 1 exited and recorded nothing.
 *
 * ## The process stays alive by OWNERSHIP, not by accident (review R2-H5)
 *
 * Every timer in this app is unref'd (`systemGatewayTimers`), so a running
 * gateway whose transport is down and whose feeds are all waiting to reconnect
 * would otherwise hold nothing referenced — and at `e9cee46` the recording-only
 * process really did print its banner and then EXIT 0 on its own, unable to
 * ever reconnect and record. `DataGateway.start()` therefore acquires a
 * REFERENCED lifetime handle through the `lifetime` port
 * (`systemGatewayLifetime()` here) and `stop()` releases it exactly once.
 *
 * ## Fatal startup releases everything it acquired (review R3-H1)
 *
 * The mirror image of R2-H5: at `45c231c` a fatal error AFTER the transport
 * connected — a WAL that would not open — logged `data-gateway: fatal`, set
 * the exit code, and then sat forever on the connected transport's referenced
 * socket, which nothing closed. Startup is now TRANSACTIONAL
 * (`runGatewaySequence` in `./run.ts`): on any fatal startup error, every
 * resource acquired so far is released exactly once — the transport directly
 * if the gateway does not exist yet, or via `gateway.stop()` (journal,
 * transport, lifetime anchor) if it does — before the error reaches the
 * handler below. The intended contract therefore holds in BOTH directions:
 * the process runs until a shutdown signal, or until a startup defect it
 * cannot record through (missing or invalid configuration, or a WAL that will
 * not open) makes it exit loudly, promptly, with a nonzero code.
 *
 * ## The cleanup itself is deadline-guarded (round 4)
 *
 * Transactional release assumed the cleanup calls COMPLETE. A transport whose
 * `close()` rejected before releasing its referenced handle produced the
 * fatal log and then the original hang, because a cleanup failure was only
 * logged and `process.exitCode = 1` moves nothing that is still referenced.
 * Both cleanup paths (fatal startup and signal shutdown) now arm a REFERENCED
 * hard-deadline timer (`GATEWAY_CLEANUP_DEADLINE_MS`, default 10 s) that
 * forces `process.exit(1)` if cleanup does not complete, and is cleared when
 * it does — see `run.ts` for the invariant and the both-paths decision.
 *
 * Safety: this process reads no signer, wallet, or API key, submits no order,
 * and cannot be configured to. The repository defaults `MAX_RUN_MODE=PAPER`,
 * `ALLOW_REAL_ORDERS=false`, `LIVE_MICRO_MAX_ORDER_NOTIONAL=0`,
 * `LIVE_MICRO_MAX_ACCOUNT_EXPOSURE=0` are untouched by this app.
 */

import { readFile } from "node:fs/promises";

import { createWebSocketFactory } from "@polymarket-bot/binance-adapter";
import { nodeWebSocketFactory } from "@polymarket-bot/coinbase-adapter";
import { RedisStreamsEventTransport } from "@polymarket-bot/event-bus";
import { globalHttpClient, globalWebSocketFactory } from "@polymarket-bot/polymarket-public";
import { nodeWalFileSystem } from "@polymarket-bot/storage-wal";

import { parseGatewayConfig } from "./config.js";
import { GatewayConfigurationError } from "./errors.js";
import { DEFAULT_CLEANUP_DEADLINE_MS, runGatewaySequence } from "./run.js";
import {
  systemGatewayClock,
  systemGatewayIdSource,
  systemGatewayLifetime,
  systemGatewayTimers,
} from "./system.js";

async function main(): Promise<void> {
  const configPath = process.env["GATEWAY_CONFIG_PATH"];
  if (configPath === undefined || configPath === "") {
    console.error("GATEWAY_CONFIG_PATH is required (a JSON file matching GatewayConfigSchema)");
    process.exitCode = 1;
    return;
  }
  const config = parseGatewayConfig(JSON.parse(await readFile(configPath, "utf8")));

  const redisUrl = process.env["GATEWAY_REDIS_URL"] ?? "redis://127.0.0.1:6379";
  const retentionEvents = Number(process.env["GATEWAY_RETENTION_EVENTS"] ?? "100000");
  const cleanupDeadlineMs = Number(
    process.env["GATEWAY_CLEANUP_DEADLINE_MS"] ?? String(DEFAULT_CLEANUP_DEADLINE_MS),
  );

  await runGatewaySequence({
    config,
    cleanupDeadlineMs,
    connectTransport: () =>
      RedisStreamsEventTransport.connect({
        connection: { url: redisUrl },
        retention: { maxEvents: retentionEvents },
      }),
    retentionEvents,
    ports: {
      clock: systemGatewayClock(),
      ids: systemGatewayIdSource(),
      timers: systemGatewayTimers(),
      // R2-H5: the referenced counterweight to the unref'd timers above. The
      // gateway acquires it in start() and releases it in stop(), so this
      // process lives until a shutdown signal even when every feed is in
      // reconnect wait and the transport holds no socket.
      lifetime: systemGatewayLifetime(),
      walFileSystem: nodeWalFileSystem(),
      polymarketSocketFactory: globalWebSocketFactory(),
      polymarketHttpClient: globalHttpClient(),
      rtdsSocketFactory: globalWebSocketFactory(),
      binanceSocketFactory: createWebSocketFactory(),
      coinbaseSocketFactory: nodeWebSocketFactory,
      observer: {
        onIncident: (incident) => {
          console.error(
            `[incident] ${incident.severity} ${incident.reasonCode} (${incident.incidentId}): ${incident.detail}`,
          );
        },
        onPublicationHalted: (halt) => {
          console.error(
            `[halt] publication halted (${halt.cause}) at ingestSeq ${halt.haltedAtIngestSeq}: ${halt.detail}`,
          );
          console.error(
            "[halt] the halt is TERMINAL for this gateway epoch and RECORDING CONTINUES; recovery is a process restart — see infra/compose/data-gateway/README.md",
          );
        },
        onPublishRejected: (rejection) => {
          console.error(
            `[publish] the transport refused ingestSeq ${rejection.ingestSeq}: ${rejection.detail}`,
          );
        },
        onRecordingFailure: (failure) => {
          console.error(`[wal] recording failure (${failure.reason}): ${failure.detail}`);
        },
      },
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
      // Round 4: the cleanup hard-deadline. Deliberately NOT unref'd — the
      // second exception to the unref-everything policy, alongside the
      // lifetime anchor (`run.ts` documents why the reference is the point).
      armCleanupDeadline: (delayMs, onExpiry) => {
        const handle = setTimeout(onExpiry, delayMs);
        return () => {
          clearTimeout(handle);
        };
      },
      // Only a cleanup deadline's expiry reaches this: a cleanup that hung or
      // failed holding a referenced handle cannot exit by draining the loop.
      forceExit: (code) => {
        process.exit(code);
      },
    },
  });
}

main().catch((error: unknown) => {
  if (error instanceof GatewayConfigurationError) {
    // The most common startup failure, and the one whose detail an operator
    // actually needs: WHICH field, and why. The schema is strict, so an
    // unknown key (including a JSON "comment") is reported here too.
    console.error(`data-gateway: ${error.message}`);
    console.error(JSON.stringify(error.details, null, 2));
    process.exitCode = 1;
    return;
  }
  // R3-H1: by the time an error arrives here, `runGatewaySequence` has
  // already RUN the cleanup for every resource startup acquired (transport,
  // journal, lifetime anchor). When that cleanup completed, nothing
  // referenced remains and setting the exit code IS the exit. When it did
  // not — a close that rejected or hung while holding its referenced handle
  // (round 4) — the cleanup deadline armed inside the sequence is still
  // running and forces exit 1 at its expiry, so this line is never the last
  // word on a wedged process.
  console.error("data-gateway: fatal", error);
  process.exitCode = 1;
});
