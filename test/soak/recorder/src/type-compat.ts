/**
 * Compile-time pin: the exporter's structural input types accept the REAL
 * exported metric shapes (`WP-140`).
 *
 * `packages/observability` (layer 1) may not import `apps/data-gateway` or
 * `apps/research-worker` (layer 3, F10/F12 —
 * `docs/contracts/dependency-direction.md`), so its input types are
 * structural mirrors. THIS file, in the soak test tree where both sides are
 * reachable, is what keeps the mirrors honest: if either producer renames,
 * retypes, or removes a field the exporter reads, `pnpm run typecheck` in
 * `test/soak/recorder` fails here, naming the field.
 *
 * Type-only imports; nothing is executed and no runtime edge exists.
 */

import type { GatewayMetrics } from "@polymarket-bot/data-gateway";
import type { ResearchWorkerMetrics } from "@polymarket-bot/research-worker";

import type {
  RecorderCompactionMetricsInput,
  RecorderGatewayMetricsInput,
} from "../../../../packages/observability/src/recorder/index.js";

/** The real gateway snapshot must be assignable to the exporter's input. */
export const acceptsGatewayMetrics = (
  metrics: GatewayMetrics,
): RecorderGatewayMetricsInput => metrics;

/** The real research-worker snapshot must be assignable likewise. */
export const acceptsCompactionMetrics = (
  metrics: ResearchWorkerMetrics,
): RecorderCompactionMetricsInput => metrics;
