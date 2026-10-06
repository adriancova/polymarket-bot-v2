/**
 * WP-340 r1: the security and recovery report
 * (`docs/experiments/phase-3-verification.md`) and the suite's own hygiene,
 * pinned where round 1's joint review found them wrong:
 *
 * - J2: §9 cross-references every open Wave 3 residual row, WP300-PERSIST
 *   and WP300C-OBLIGATIONS included, with WP300C's duties; §2 and §8 state the
 *   surviving-inventory assumption the reservation checks rest on, and mark
 *   wallet-operation restart recovery unverified;
 * - J3: §5 states every population of WP340-F1 releases with the counts the
 *   suites pin (`support/expected-releases.ts`), and their totals;
 * - J5: no bare `console.log` anywhere in the suite; every count line is a
 *   labelled `console.info("WP-340 …")`;
 * - J6: ADR-008 §5 is quoted for what it says, and the stronger restriction
 *   is the harness's own;
 * - J7: the route-3 sequence is not called "common", and the push timing is
 *   an assumption (A8; the A-list itself is pinned in `mock-venue-facts`).
 *
 * Pure text: nothing reaches a network (the tripwire is installed all the same).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installNetworkTripwire, type NetworkTripwire } from "../../../packages/polymarket-secure/src/testing/index.js";

import { F1_RELEASES, F1_RELEASES_R0_SUITES } from "./support/expected-releases.js";

let tripwire: NetworkTripwire;
beforeEach(() => {
  tripwire = installNetworkTripwire();
});
afterEach(() => {
  const refused = tripwire.refused();
  tripwire.uninstall();
  expect(refused).toEqual([]);
});

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const REPORT = readFileSync(path.join(REPO_ROOT, "docs/experiments/phase-3-verification.md"), "utf8");

/** The text of the report's section `## <n>.` up to the next `## ` heading. */
function section(n: number): string {
  const start = REPORT.indexOf(`\n## ${String(n)}. `);
  expect(start, `section ${String(n)}`).toBeGreaterThan(0);
  const end = REPORT.indexOf("\n## ", start + 1);
  return REPORT.slice(start, end < 0 ? undefined : end);
}

function suiteFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const full = path.join(directory, name);
    if (statSync(full).isDirectory()) return name === "node_modules" ? [] : suiteFiles(full);
    return name.endsWith(".ts") ? [full] : [];
  });
}

describe("WP-340 r1: the security and recovery report", () => {
  it("J2: §9 cross-references every open Wave 3 residual row, WP300-PERSIST and WP300C-OBLIGATIONS with their duties", () => {
    const residuals = section(9);
    for (const id of [
      "WP270-DECISIONS",
      "WP290-RESIDUALS",
      "WP300-PERSIST",
      "WP300C-OBLIGATIONS",
      "WP310-LOWS",
      "WP320-FOLLOWUPS",
      "WP330-LOWS",
      "CAP1-RESIDUALS",
      "ROLLOVER1-RESIDUALS",
      "V3-C12-HEARTBEAT-ADR",
      "WP340-F1",
    ]) {
      expect(residuals, id).toContain(`| \`${id}\` |`);
    }
    // WP300C's duties beyond the CSPRNG, named.
    for (const duty of ["CSPRNG", "retryReconciliationRequests", "outstandingReconciliationRequests()", "drawn tokens", "requestId"]) expect(residuals, duty).toContain(duty);
    expect(residuals).toContain("wallet-operation restart recovery is unverified");
  });

  it("J2: §2 and §8 state the surviving-inventory assumption the reservation checks rest on", () => {
    for (const n of [2, 8]) {
      expect(section(n), `section ${String(n)}`).toContain("surviving-inventory assumption");
      expect(section(n), `section ${String(n)}`).toContain("WP300-PERSIST");
    }
    expect(section(8)).toContain("`WalletOperationManager` is not composed");
  });

  it("J3: §5 states every population of WP340-F1 releases the suites pin, and the totals", () => {
    const findings = section(5);
    const rows: readonly [string, string, number][] = [
      ["Crash matrix, no-crash baselines", "mid-order-crash.test.ts", F1_RELEASES.crashMatrixBaselines],
      ["Crash matrix, kill runs", "mid-order-crash.test.ts", F1_RELEASES.crashMatrixKilled],
      ["Crash named pins (one baseline)", "mid-order-crash.test.ts", F1_RELEASES.crashNamedPins],
      ["Crash property", "mid-order-crash.property.test.ts", F1_RELEASES.crashProperty],
      ["Stream named (route 2)", "lost-stream-events.test.ts", F1_RELEASES.streamNamed],
      ["Stream property", "lost-stream-events.property.test.ts", F1_RELEASES.streamProperty],
      ["Release-driver pins (r1)", "release-driver.test.ts", F1_RELEASES.releaseDriver],
    ];
    for (const [label, file, count] of rows) expect(findings, label).toContain(`| ${label} | \`${file}\` | ${String(count)} |`);
    expect(F1_RELEASES_R0_SUITES, "the round-1 verifiers measured 284 on the r0 suites").toBe(284);
    expect(findings).toContain(`| **The r0 suites** | | **${String(F1_RELEASES_R0_SUITES)}** |`);
    expect(findings).toContain(`| **Total** | | **${String(F1_RELEASES_R0_SUITES + F1_RELEASES.releaseDriver)}** |`);
  });

  it("J6: ADR-008 §5 is quoted for what it says; the stronger restriction is the harness's design choice", () => {
    const adr = readFileSync(path.join(REPO_ROOT, "docs/adr/ADR-008-live-writer-fencing-and-heartbeat-health-lease.md"), "utf8").replace(/\s+/gu, " ");
    const words = "may not submit orders or send heartbeats while another holder is live";
    expect(adr).toContain(words);
    expect(section(2).replace(/\s+/gu, " ")).toContain(words);
    expect(REPORT).not.toMatch(/may not run an OMS or reconciler against the account \(ADR-008/u);
  });

  it("J7: route 3 is not called common; the push timing it rests on is assumption A8", () => {
    expect(REPORT).not.toMatch(/common, fault-free/u);
    expect(section(5)).toContain("A8");
  });
});

describe("WP-340 r1 (J5): the suite's own hygiene", () => {
  it("no bare console.log anywhere in the suite; every console line is a labelled `console.info(\"WP-340 …\")`", () => {
    const files = suiteFiles(HERE);
    expect(files.length).toBeGreaterThan(20);
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const [index, line] of text.split("\n").entries()) {
        const at = `${path.relative(HERE, file)}:${String(index + 1)}`;
        if (/console\.(log|warn|error|debug)\(/u.test(line)) offenders.push(`${at}: ${line.trim()}`);
        if (/console\.info\(/u.test(line) && !/console\.info\(`WP-340 /u.test(line)) offenders.push(`${at}: ${line.trim()}`);
      }
    }
    // This file names the patterns it forbids only inside regular expressions and prose.
    expect(offenders.filter((entry) => !entry.startsWith("report.test.ts:"))).toEqual([]);
  });
});
