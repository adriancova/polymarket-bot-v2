/**
 * WP-000 venue verification CLI skeleton.
 *
 * Enumerates the handoff SS1.2 verification checks, loads and structurally
 * validates the sanitized fixtures frozen under `test/fixtures/venue/`,
 * validates the frozen verification report (existence, required sections,
 * official-domain citations), and reports results.
 *
 * Hard constraints:
 * - Never hits the network.
 * - Never places an order (PAPER-only defaults are untouched).
 * - Never loads or requires a credential, wallet, or signer.
 *
 * Documented-only checks (no fixture) are reported as DOCUMENTED — backed by
 * the report section — never as vacuous PASS, and overall success requires
 * both a valid report and at least one fixture-backed PASS.
 *
 * NOT yet wired into `apps/ops-cli/src/index.ts` or the root
 * `ops:verify-venue` script: the CLI entry point and root package.json are
 * outside WP-000's allowed paths. Wiring is recorded as follow-up work (see
 * report section 15).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { VENUE_CHECKS, VERIFICATION_REPORT_PATH } from "./checks.js";
import type { VenueCheck } from "./checks.js";
import { REPO_ROOT, loadFixture } from "./fixtures.js";
import type { FixtureValidationResult } from "./fixtures.js";

export type CheckStatus = "PASS" | "FAIL" | "DOCUMENTED";

export interface CheckResult {
  readonly check: VenueCheck;
  readonly status: CheckStatus;
  readonly errors: readonly string[];
  readonly fixtureResults: readonly FixtureValidationResult[];
}

export interface ReportValidationResult {
  readonly ok: boolean;
  readonly errors: readonly string[];
}

export interface VenueVerificationReport {
  readonly reportPath: string;
  readonly reportValidation: ReportValidationResult;
  readonly ok: boolean;
  readonly results: readonly CheckResult[];
}

/** Sections every frozen verification report must contain. */
const REQUIRED_REPORT_SECTIONS: readonly string[] = [
  ...new Set(VENUE_CHECKS.map((check) => check.reportSection)),
  "11",
  "12",
  "13",
];

const OFFICIAL_CITATION_PREFIXES = [
  "https://docs.polymarket.com/",
  "https://github.com/Polymarket/",
  "https://polymarket.com/",
] as const;

function sectionHeadingRegExp(section: string): RegExp {
  return new RegExp(`^#{2,3} ${section.replace(/\./g, "\\.")}[. ]`, "m");
}

export function reportHasSection(content: string, section: string): boolean {
  return sectionHeadingRegExp(section).test(content);
}

/**
 * Validates the report content: required sections present, an UNVERIFIED
 * section exists, and every http(s) citation targets an official domain.
 */
export function validateVerificationReport(
  content: string,
): ReportValidationResult {
  const errors: string[] = [];
  for (const section of REQUIRED_REPORT_SECTIONS) {
    if (!reportHasSection(content, section)) {
      errors.push(`report missing required section ${section}`);
    }
  }
  if (!content.includes("UNVERIFIED")) {
    errors.push("report must carry an explicit UNVERIFIED inventory");
  }
  const urls = content.match(/https?:\/\/[^\s)\]>`"']+/g) ?? [];
  for (const url of urls) {
    if (
      !OFFICIAL_CITATION_PREFIXES.some((prefix) => url.startsWith(prefix))
    ) {
      errors.push(`non-official citation: ${url}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/** Reads and validates the frozen report file from the repository. */
export function loadAndValidateReport(
  reportPath: string = VERIFICATION_REPORT_PATH,
): { content: string | null; validation: ReportValidationResult } {
  let content: string;
  try {
    content = readFileSync(join(REPO_ROOT, reportPath), "utf8");
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: null,
      validation: {
        ok: false,
        errors: [`verification report unavailable: ${message}`],
      },
    };
  }
  return { content, validation: validateVerificationReport(content) };
}

/** Runs every check against local fixtures and the frozen report only. */
export function runVenueVerification(): VenueVerificationReport {
  const { content, validation } = loadAndValidateReport();
  const results: CheckResult[] = VENUE_CHECKS.map((check) => {
    if (check.kind === "documented") {
      const documented =
        content !== null && reportHasSection(content, check.reportSection);
      return {
        check,
        status: documented ? ("DOCUMENTED" as const) : ("FAIL" as const),
        errors: documented
          ? []
          : [
              `documented-only check has no evidence: report section ${check.reportSection} not found`,
            ],
        fixtureResults: [],
      };
    }
    if (check.fixtures.length === 0) {
      return {
        check,
        status: "FAIL" as const,
        errors: ["fixture-kind check declares no fixture files"],
        fixtureResults: [],
      };
    }
    const fixtureResults = check.fixtures.map((relativePath) =>
      loadFixture(relativePath, check.payloadSchema),
    );
    const ok = fixtureResults.every((result) => result.ok);
    return {
      check,
      status: ok ? ("PASS" as const) : ("FAIL" as const),
      errors: fixtureResults.flatMap((result) =>
        result.errors.map((error) => `${result.relativePath}: ${error}`),
      ),
      fixtureResults,
    };
  });
  const hasFixtureEvidence = results.some(
    (result) => result.status === "PASS",
  );
  const noFailures = results.every((result) => result.status !== "FAIL");
  return {
    reportPath: VERIFICATION_REPORT_PATH,
    reportValidation: validation,
    ok: validation.ok && noFailures && hasFixtureEvidence,
    results,
  };
}

/** Exit-code mapping for CLI integration (0 = pass, 1 = fail). */
export function venueVerificationExitCode(
  report: VenueVerificationReport,
): 0 | 1 {
  return report.ok ? 0 : 1;
}

/** Renders a human-readable summary of a verification run. */
export function formatVenueVerificationReport(
  report: VenueVerificationReport,
): string {
  const lines: string[] = [
    `Venue verification report: ${report.reportPath}`,
    `Report validation: ${report.reportValidation.ok ? "OK" : "INVALID"}`,
    ...report.reportValidation.errors.map((error) => `  ${error}`),
    `Overall: ${report.ok ? "PASS" : "FAIL"}`,
  ];
  for (const result of report.results) {
    const coverage =
      result.check.kind === "fixture"
        ? result.check.fixtures.join(", ")
        : "report-documented only (no fixture evidence)";
    lines.push(
      `[${result.status}] ${result.check.id} (report section ${result.check.reportSection}): ${coverage}`,
    );
    for (const error of result.errors) {
      lines.push(`       ${error}`);
    }
  }
  return lines.join("\n");
}
