/**
 * TEST SUPPORT (imported only by `*.test.ts` files in this directory).
 *
 * A SYNTHETIC restricted-mode snapshot: numbers chosen to be distinct from
 * the venue's (two minutes, 1 s, 30 s), so every test shows behaviour comes
 * from the snapshot. The documented snapshot is in
 * `test/contract/rate-limits/fixtures/`.
 */

import { RESTRICTED_MODE_CONFIGURATION_SCHEMA } from "./configuration.js";
import { VenueModeDetector } from "./detector.js";

/** 2026-10-01T00:00:00Z. Instants are written as ISO literals below: layer-1 sources build no `Date`. */
export const T0 = Date.UTC(2026, 9, 1, 0, 0, 0);

export type Doc = { [key: string]: unknown };

export function modeSnapshot(overrides: Doc = {}): Doc {
  return {
    schema: RESTRICTED_MODE_CONFIGURATION_SCHEMA,
    snapshotId: "synthetic-modes-a",
    effectiveFrom: "2026-09-30T23:59:00Z",
    source: {
      documents: [{ url: "https://example.invalid/synthetic-modes", retrievedAt: "2026-09-30T23:58:00Z" }],
      report: "synthetic test snapshot (no venue values)",
      policyAuthority: "WP-310 unit tests",
    },
    postOnlyWindowMs: 5000,
    restartBackoff: { initialMs: 100, multiplier: 3, capMs: 1000 },
    tradingUnavailableBackoff: { initialMs: 2000, multiplier: 2, capMs: 10_000 },
    ...overrides,
  };
}

export function detectorOf(...documents: Doc[]): VenueModeDetector {
  const created = VenueModeDetector.create(documents.length === 0 ? [modeSnapshot()] : documents);
  if (!created.ok) throw new Error(created.problems.join("; "));
  return created.value;
}
