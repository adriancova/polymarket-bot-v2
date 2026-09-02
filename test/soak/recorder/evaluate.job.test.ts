/**
 * The soak-evidence evaluation JOB (`WP-140`) — run via
 * `pnpm --dir test/soak/recorder run soak:evaluate`.
 *
 * Reads every `soak-window-*.json` under the evidence directory
 * (`SOAK_EVIDENCE_DIR`, default `./evidence`), evaluates the set with the
 * fail-closed evaluator, and writes the machine-visible status artifacts
 * next to the records:
 *
 *   - `soak-status.json` — the full evaluation (status, windows, reasons);
 *   - `soak-status.prom` — the same as Prometheus exposition text
 *     (`recorder_soak_*`), ready for a node_exporter textfile collector.
 *
 * An empty or missing evidence directory is not an error: it is exactly the
 * honest state — **PENDING** — and the job writes it as such. The best any
 * evidence set can reach is QUALIFYING_WINDOW_FOUND — a structurally
 * qualifying CANDIDATE window whose provenance the evaluator cannot verify
 * (shared filesystem trust domain); completing the external-evidence gate is
 * a governance record in IMPLEMENTATION_STATUS.md, never this job's output.
 * No assertion here requires anything beyond truthful reporting.
 *
 * (Vitest is the repository's execution vehicle for TypeScript jobs in test
 * trees — the WP-020/WP-120/WP-130 precedent; there is no runtime build for
 * workspace TS outside esbuild-bundled apps.)
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  evaluateSoakEvidence,
  renderExposition,
  soakMetricSamples,
} from "../../../packages/observability/src/recorder/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const evidenceDir = process.env["SOAK_EVIDENCE_DIR"] ?? resolve(here, "evidence");

describe("soak evidence evaluation job", () => {
  it("evaluates the evidence directory and writes the status artifacts", () => {
    mkdirSync(evidenceDir, { recursive: true });
    const recordFiles = readdirSync(evidenceDir)
      .filter((name) => name.startsWith("soak-window-") && name.endsWith(".json"))
      .sort();
    const records: unknown[] = [];
    for (const file of recordFiles) {
      const path = join(evidenceDir, file);
      try {
        records.push(JSON.parse(readFileSync(path, "utf8")));
      } catch {
        // Fail-closed: a file that is not even JSON still reaches the
        // evaluator (as an unparseable value) so the set goes INVALID
        // instead of the bad file being skipped.
        records.push(`unparseable JSON in ${file}`);
      }
    }

    const evaluation = evaluateSoakEvidence(records, Date.now());

    const statusPath = join(evidenceDir, "soak-status.json");
    writeFileSync(
      statusPath,
      `${JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          evidenceDir,
          recordFiles,
          evaluation,
        },
        null,
        2,
      )}\n`,
    );
    const promPath = join(evidenceDir, "soak-status.prom");
    writeFileSync(promPath, renderExposition(soakMetricSamples(evaluation)));

    // The job's own honesty requirements — NOT a demand that the soak be
    // done. The domain has no completion-shaped state: the best is a
    // candidate for out-of-band provenance review.
    expect(["PENDING", "QUALIFYING_WINDOW_FOUND", "INVALID"]).toContain(evaluation.status);
    expect(JSON.stringify(evaluation)).not.toContain("SATISFIED");
    expect(evaluation.thresholdMs).toBeGreaterThan(0);
    if (recordFiles.length === 0) {
      expect(evaluation.status).toBe("PENDING");
      expect(evaluation.validWindows).toBe(0);
    }
    // The status artifact must state the status it computed.
    const written = JSON.parse(readFileSync(statusPath, "utf8")) as {
      evaluation: { status: string };
    };
    expect(written.evaluation.status).toBe(evaluation.status);
    const prom = readFileSync(promPath, "utf8");
    expect(prom).toContain(`recorder_soak_status_info{status="${evaluation.status}"} 1`);

    // Operator-facing summary in the job log.
    console.error(`soak:evaluate — status ${evaluation.status}`);
    for (const reason of evaluation.reasons) {
      console.error(`  ${reason}`);
    }
    console.error(`  artifacts: ${statusPath} / ${promPath}`);
  });
});
