/**
 * WP-000 venue verification CLI skeleton.
 *
 * Enumerates the handoff SS1.2 verification checks, loads and structurally
 * validates the sanitized fixtures frozen under `test/fixtures/venue/`,
 * validates the frozen verification report (existence, required sections,
 * a per-section official citation, official-domain-only citations, and
 * commit-pinned SDK links), and reports results.
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

import {
  SDK_PERMALINK_PREFIX,
  SDK_REFERENCE_COMMIT,
  VENUE_CHECKS,
  VERIFICATION_REPORT_PATH,
} from "./checks.js";
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

/** Extracts a section's text: from its heading to the next ##/### heading. */
export function reportSectionText(
  content: string,
  section: string,
): string | null {
  const match = sectionHeadingRegExp(section).exec(content);
  if (match === null) {
    return null;
  }
  const start = match.index;
  const rest = content.slice(start + match[0].length);
  const next = /^#{2,3} /m.exec(rest);
  return next === null
    ? content.slice(start)
    : content.slice(start, start + match[0].length + next.index);
}

/**
 * A section carries evidence only when it contains its OWN citation to an
 * official Polymarket domain.
 *
 * `UNVERIFIED` is a status annotation, never evidence: it records that a fact
 * could not be established from an official source, so accepting it in place
 * of a citation would let a report of entirely unverified claims pass. A
 * section that legitimately cannot cite an official source must be listed in
 * `CITATION_EXEMPT_SECTIONS` with a rationale.
 */
export function reportSectionHasOfficialCitation(
  content: string,
  section: string,
): boolean {
  const text = reportSectionText(content, section);
  if (text === null) {
    return false;
  }
  return OFFICIAL_CITATION_PREFIXES.some((prefix) => text.includes(prefix));
}

/**
 * Sections that carry no venue fact and therefore cannot cite a venue source.
 * The list is exhaustive and each entry states why; there is no generic escape
 * hatch. Documented-ABSENCE venue facts (for example the undocumented HTTP 425
 * response body, report item U-9) are NOT exempt: the section that records the
 * absence must still cite the official page on which the body is absent.
 */
export const CITATION_EXEMPT_SECTIONS: readonly {
  readonly section: string;
  readonly rationale: string;
}[] = [
  {
    section: "13",
    rationale:
      "safety attestation: an assertion about this repository's own behavior (no orders, no credentials, no authenticated calls), not a venue fact, so no venue source exists to cite",
  },
];

function isCitationExempt(section: string): boolean {
  return CITATION_EXEMPT_SECTIONS.some((entry) => entry.section === section);
}

const SDK_BLOB_URL_RE =
  /https:\/\/github\.com\/Polymarket\/ts-sdk\/blob\/[^\s)\]>`"']+/g;

/**
 * Validates the report content: required sections present, every non-exempt
 * required section carries its own official citation, an UNVERIFIED inventory
 * exists, at least one official citation exists overall, every http(s)
 * citation targets an official domain, and every SDK source link is pinned to
 * the frozen reference commit rather than a mutable branch.
 */
export function validateVerificationReport(
  content: string,
): ReportValidationResult {
  const errors: string[] = [];
  for (const section of REQUIRED_REPORT_SECTIONS) {
    if (!reportHasSection(content, section)) {
      errors.push(`report missing required section ${section}`);
      continue;
    }
    if (
      !isCitationExempt(section) &&
      !reportSectionHasOfficialCitation(content, section)
    ) {
      errors.push(
        `report section ${section} has no official citation of its own (UNVERIFIED is a status annotation, not evidence)`,
      );
    }
  }
  if (!content.includes("UNVERIFIED")) {
    errors.push("report must carry an explicit UNVERIFIED inventory");
  }
  const urls = content.match(/https?:\/\/[^\s)\]>`"']+/g) ?? [];
  if (urls.length === 0) {
    errors.push("report contains headings but no citations");
  }
  for (const url of urls) {
    if (
      !OFFICIAL_CITATION_PREFIXES.some((prefix) => url.startsWith(prefix))
    ) {
      errors.push(`non-official citation: ${url}`);
    }
  }
  for (const url of content.match(SDK_BLOB_URL_RE) ?? []) {
    if (!url.startsWith(SDK_PERMALINK_PREFIX)) {
      errors.push(
        `SDK citation is not pinned to reference commit ${SDK_REFERENCE_COMMIT}: ${url}`,
      );
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
        content !== null &&
        reportSectionHasOfficialCitation(content, check.reportSection);
      return {
        check,
        status: documented ? ("DOCUMENTED" as const) : ("FAIL" as const),
        errors: documented
          ? []
          : [
              `documented-only check has no evidence: report section ${check.reportSection} is missing or lacks its own official citation`,
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
      loadFixture(relativePath, check.payloadSpec),
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
