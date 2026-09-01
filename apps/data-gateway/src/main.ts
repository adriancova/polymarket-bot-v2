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
 * The process therefore exits ONLY on a defect it cannot record through: a
 * missing or invalid configuration, or a failure to open the WAL itself.
 *
 * Safety: this process reads no signer, wallet, or API key, submits no order,
 * and cannot be configured to. The repository defaults `MAX_RUN_MODE=PAPER`,
 * `ALLOW_REAL_ORDERS=false`, `LIVE_MICRO_MAX_ORDER_NOTIONAL=0`,
 * `LIVE_MICRO_MAX_ACCOUNT_EXPOSURE=0` are untouched by this app.
 */

import { readFile } from "node:fs/promises";

import { createWebSocketFactory } from "@polymarket-bot/binance-adapter";
import { nodeWebSocketFactory } from "@polymarket-bot/coinbase-adapter";
import type { MarketEventTransport } from "@polymarket-bot/event-bus";
import { RedisStreamsEventTransport } from "@polymarket-bot/event-bus";
import { globalHttpClient, globalWebSocketFactory } from "@polymarket-bot/polymarket-public";
import { nodeWalFileSystem } from "@polymarket-bot/storage-wal";

import { parseGatewayConfig } from "./config.js";
import { GatewayConfigurationError } from "./errors.js";
import { DataGateway } from "./gateway.js";
import {
  systemGatewayClock,
  systemGatewayIdSource,
  systemGatewayTimers,
} from "./system.js";
import { UnavailableEventTransport } from "./unavailable-transport.js";

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

  // §4.2: the transport is NOT a precondition for recording. A failure here
  // becomes a terminal publication halt after the gateway is built, never an
  // exit — see `unavailable-transport.ts`.
  let transportFailure: string | undefined;
  let transport: MarketEventTransport;
  try {
    transport = await RedisStreamsEventTransport.connect({
      connection: { url: redisUrl },
      retention: { maxEvents: retentionEvents },
    });
  } catch (error) {
    transportFailure = error instanceof Error ? error.message : String(error);
    console.error(
      `[transport] the event bus was unreachable at startup (${transportFailure}); publication will be halted and RECORDING WILL CONTINUE`,
    );
    transport = new UnavailableEventTransport(transportFailure, {
      maxEvents: retentionEvents,
    });
  }

  const gateway = await DataGateway.create(config, {
    clock: systemGatewayClock(),
    ids: systemGatewayIdSource(),
    timers: systemGatewayTimers(),
    walFileSystem: nodeWalFileSystem(),
    transport,
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
  });

  if (transportFailure !== undefined) {
    // Same terminal halt, same PAGE incident, same operator story as a mid-run
    // outage — but the WAL below is already open and the feeds start next.
    gateway.haltPublication(
      "EVENT_BUS_UNAVAILABLE",
      `the event bus was unreachable at startup (${transportFailure}); recording continues and a restart is required once the bus is back`,
    );
  }

  gateway.start();
  console.error(
    `data-gateway running: epoch ${gateway.gatewayEpoch}, stream ${config.streamName}, wal ${config.wal.rootPath}${
      transportFailure === undefined ? "" : " — PUBLICATION HALTED, RECORDING ONLY"
    }`,
  );

  const shutdown = (): void => {
    console.error("data-gateway: shutting down");
    void gateway.stop().then(
      () => {
        process.exitCode = 0;
      },
      (error: unknown) => {
        console.error("data-gateway: shutdown error", error);
        process.exitCode = 1;
      },
    );
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
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
  console.error("data-gateway: fatal", error);
  process.exitCode = 1;
});
