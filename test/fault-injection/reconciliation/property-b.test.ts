/**
 * WP-290 r6: the seeded randomized property (`support/property.ts`), seeds 1001 to 2000 of 4000. Four files run the
 * 4000 seeds in parallel workers; each seed checks every oracle after every step.
 */

import { describe, expect, it } from "vitest";

import { runSeed, type SeedResult } from "./support/property.js";

const FIRST = 1001;
const LAST = 2000;
const BATCH = 125;

describe(`WP-290 r6: the seeded randomized property over the venue, the OMS, the ledger and the journal (seeds ${String(FIRST)}-${String(LAST)})`, () => {
  for (let start = FIRST; start <= LAST; start += BATCH) {
    const end = Math.min(LAST, start + BATCH - 1);
    it(`seeds ${String(start)}-${String(end)}: R1, R2, R3, no resolution or resume under a touched read, no lost or collapsed halt obligation`, async () => {
      const failures: SeedResult[] = [];
      let resumes = 0;
      let runs = 0;
      let exemptions = 0;
      for (let seed = start; seed <= end; seed += 1) {
        // Yield to the event loop between seeds (the worker's own messages run meanwhile).
        await new Promise<void>((resolve) => setImmediate(resolve));
        const result = await runSeed(seed);
        resumes += result.resumes;
        runs += result.runs;
        exemptions += result.exemptions;
        if (result.violations.length > 0) failures.push(result);
      }
      const first = failures[0];
      expect(failures.map((failure) => failure.seed), first === undefined ? "" : `seed ${String(first.seed)}: ${first.violations.join(" | ")}\n  steps: ${first.steps.join(" ; ")}`).toEqual([]);
      // Non-vacuity: the seeds reached runs and resumes.
      expect(runs).toBeGreaterThan(end - start);
      expect(resumes).toBeGreaterThan(0);
      expect(exemptions).toBeGreaterThanOrEqual(0);
    }, 600_000);
  }
});
