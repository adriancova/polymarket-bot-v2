/**
 * `@polymarket-bot/observability` — the platform's pure observability surface.
 *
 * Two subtrees, both layer-1 application-module code with no I/O, no clock, no
 * workspace dependency and no Node built-in in production source (F17):
 *
 * - `./recorder` (`WP-140`) — recorder metric families, the exposition
 *   renderer, validation-finding classes, book comparison, soak-evidence
 *   evaluation;
 * - `./control` (`WP-240`) — the platform metric-family table for the
 *   `trader_*` / `control_*` surfaces, the producer→sample mapping, a
 *   family-table-generic renderer, the append-only control audit surface, the
 *   Grafana dashboard contract, and the shared PAPER safety vocabulary.
 *
 * `WP-140` left wiring `./recorder` into this entry point as a follow-up,
 * because `packages/observability/src/index.ts` was a `WP-010` scaffold outside
 * its allowed paths:
 *
 * > "NOTE: `packages/observability/src/index.ts` (the package entry point) is a
 * > `WP-010` scaffold outside `WP-140`'s allowed paths, so this module is not
 * > re-exported from it yet."
 *   — `packages/observability/src/recorder/index.ts`
 *
 * `WP-240` owns `packages/observability/**` and had to replace this scaffold to
 * export its own surface, so the recorder wiring is done in the same edit. No
 * recorder source or test changed; the existing path-alias consumers (the soak
 * harness) still resolve exactly as before, and the package now has one entry
 * point instead of one entry point and a convention.
 */

export * from "./recorder/index.js";
export * from "./control/index.js";
