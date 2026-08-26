/**
 * CLI entry point for the offline venue verification run.
 *
 * Wires `runVenueVerification()` (WP-000) to the root `ops:verify-venue`
 * script, which was still a NOT IMPLEMENTED stub — Wave 0 closeout finding
 * L11. Report §15 recorded the wiring as owed follow-up; the register entry in
 * `docs/contracts/protected-contracts.md` §8 records that it is now done (the
 * merged report is a frozen snapshot and is not edited).
 *
 * Behavior:
 * - reads local fixtures and the frozen report only (no network, no credential,
 *   no order — the hard constraints stated in `index.ts` apply unchanged);
 * - prints the human-readable summary produced by
 *   `formatVenueVerificationReport`;
 * - exits 0 when the run passes and 1 when it does not, via
 *   `venueVerificationExitCode`.
 *
 * `process.exitCode` is assigned rather than calling `process.exit()`, so the
 * summary is fully flushed before the process ends.
 *
 * INVOCATION. Node 24 executes TypeScript by erasing types, but it does NOT
 * rewrite a `./foo.js` specifier to `./foo.ts` (verified on Node v24.13.0:
 * `ERR_MODULE_NOT_FOUND`), and this module tree is written with the `.js`
 * specifiers `verbatimModuleSyntax` + `NodeNext` require. The package script
 * therefore compiles with `tsc` first and runs the emitted
 * `dist/verify-venue/main.js`:
 *
 *   apps/ops-cli   `verify-venue`: tsc && node ./dist/verify-venue/main.js
 *   root           `ops:verify-venue`: pnpm --filter @polymarket-bot/ops-cli run verify-venue
 */
import {
  formatVenueVerificationReport,
  runVenueVerification,
  venueVerificationExitCode,
} from "./index.js";

const report = runVenueVerification();
console.log(formatVenueVerificationReport(report));
process.exitCode = venueVerificationExitCode(report);
