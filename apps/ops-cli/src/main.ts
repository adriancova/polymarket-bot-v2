/**
 * The shipped entry of `@polymarket-bot/ops-cli` (ADR-018 §1 and §4; WP-330
 * r0, under the orchestrator's 2026-10-05 grant): the independent emergency
 * CLI.
 *
 * - `pnpm --filter @polymarket-bot/ops-cli build` bundles THIS file to
 *   `dist/main.mjs`; `node apps/ops-cli/dist/main.mjs <command> …` runs it
 *   (`start` typechecks, builds and runs it). `docs/runbooks/emergency.md`
 *   is the operator's guide.
 * - WHY A BUNDLE. The emergency commands import workspace packages (WP-260's
 *   signer gate and client, WP-290's coordinator, WP-320's lease store), so
 *   a `tsc` build cannot run (ADR-018 Context: `ERR_MODULE_NOT_FOUND`), and
 *   §4 requires the app-local bundle the moment the executable path imports
 *   one.
 * - WHY THE BANNER. The bundle is ESM, the ADR-018 default, with the trader's
 *   `createRequire` banner (ADR-018's 2026-09-28 addendum). The forcing
 *   dependency is `pg`, reached through `packages/storage-postgres` (the
 *   audit mirror and the fencing lease store): measured without the banner,
 *   the bundle dies at load with `Dynamic require of "events" is not
 *   supported` from `pg/lib/client.js`.
 * - ONE GUARD. This module only hands its own URL to `runIfProcessEntry`,
 *   which compares it with the file Node runs (as given and through
 *   symlinks), never with a file name; the composition module has no
 *   top-level side effect. So the bundle runs exactly one invocation, a
 *   renamed or symlinked copy still runs, and an importer runs nothing.
 *
 * PAPER only in this repository: every venue-touching command runs WP-260's
 * signer gate first, and the composition binds no credential and no venue.
 * `verify-venue` (WP-000) keeps its own `tsc` path.
 */

import { runIfProcessEntry } from "./emergency/main.js";

await runIfProcessEntry(import.meta.url);
