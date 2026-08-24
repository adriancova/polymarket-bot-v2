/**
 * WP-000 venue verification CLI skeleton.
 *
 * Enumerates the handoff SS1.2 verification checks, loads and structurally
 * validates the sanitized fixtures frozen under `test/fixtures/venue/`, and
 * reports results.
 *
 * Hard constraints:
 * - Never hits the network.
 * - Never places an order (PAPER-only defaults are untouched).
 * - Never loads or requires a credential, wallet, or signer.
 *
 * NOT yet wired into `apps/ops-cli/src/index.ts` or the root
 * `ops:verify-venue` script: the CLI entry point and root package.json are
 * outside WP-000's allowed paths. Wiring is recorded as follow-up work.
 */
import { VENUE_CHECKS, VERIFICATION_REPORT_PATH } from "./checks.js";
import type { VenueCheck } from "./checks.js";
import { loadFixture } from "./fixtures.js";
import type { FixtureValidationResult } from "./fixtures.js";

export interface CheckResult {
  readonly check: VenueCheck;
  readonly ok: boolean;
  readonly fixtureResults: readonly FixtureValidationResult[];
}

export interface VenueVerificationReport {
  readonly reportPath: string;
  readonly ok: boolean;
  readonly results: readonly CheckResult[];
}

/** Runs every check against local fixtures only. */
export function runVenueVerification(): VenueVerificationReport {
  const results: CheckResult[] = VENUE_CHECKS.map((check) => {
    const fixtureResults = check.fixtures.map((relativePath) =>
      loadFixture(relativePath, check.requiredPayloadKeys),
    );
    return {
      check,
      ok: fixtureResults.every((result) => result.ok),
      fixtureResults,
    };
  });
  return {
    reportPath: VERIFICATION_REPORT_PATH,
    ok: results.every((result) => result.ok),
    results,
  };
}

/** Renders a human-readable summary of a verification run. */
export function formatVenueVerificationReport(
  report: VenueVerificationReport,
): string {
  const lines: string[] = [
    `Venue verification report: ${report.reportPath}`,
    `Overall: ${report.ok ? "PASS" : "FAIL"}`,
  ];
  for (const result of report.results) {
    const marker = result.ok ? "PASS" : "FAIL";
    const coverage =
      result.check.kind === "fixture"
        ? result.check.fixtures.join(", ")
        : "documented in report only";
    lines.push(
      `[${marker}] ${result.check.id} (report section ${result.check.reportSection}): ${coverage}`,
    );
    for (const fixtureResult of result.fixtureResults) {
      for (const error of fixtureResult.errors) {
        lines.push(`       ${fixtureResult.relativePath}: ${error}`);
      }
    }
  }
  return lines.join("\n");
}
