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
import { DataGateway } from "./gateway.js";
import {
  systemGatewayClock,
  systemGatewayIdSource,
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

  const transport = await RedisStreamsEventTransport.connect({
    connection: { url: redisUrl },
    retention: { maxEvents: retentionEvents },
  });

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
      },
      onRecordingFailure: (failure) => {
        console.error(`[wal] recording failure (${failure.reason}): ${failure.detail}`);
      },
    },
  });

  gateway.start();
  console.error(
    `data-gateway running: epoch ${gateway.gatewayEpoch}, stream ${config.streamName}, wal ${config.wal.rootPath}`,
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
