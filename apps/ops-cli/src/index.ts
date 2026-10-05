/**
 * `@polymarket-bot/ops-cli`: the operations CLI.
 *
 * - `verify-venue/` (WP-000): the offline venue verification run, wired to the
 *   root `ops:verify-venue` script.
 * - `emergency/` (WP-330): the independent emergency commands (cancel-order,
 *   cancel-market, cancel-all, account-snapshot, reconcile, stop-heartbeat).
 *
 * PAPER only: nothing here loads a credential or reaches a venue by default.
 */
export const workspacePackageName = "@polymarket-bot/ops-cli" as const;

export * from "./emergency/index.js";
