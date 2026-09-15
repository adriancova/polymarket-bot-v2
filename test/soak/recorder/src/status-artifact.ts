/**
 * The bytes of the `soak-status.json` artifact the `soak:evaluate` job writes
 * (`WP-140`), encoded from OWN DATA (`SER-3`, 2026-09-15).
 *
 * This repository's safety rule treats the soak artifacts as REAL evidence
 * ("do not claim that a soak … occurred without real evidence"), and at base
 * the job wrote them with `JSON.stringify(…, null, 2)`, which resolves `toJSON`
 * through the prototype chain. Measured at `main` `d6e05bf` and reproduced
 * independently (`docs/handoffs/SER-0-sweep.md`,
 * `extra-soak-status-artifact-arrays`): under an inherited
 * `Object.prototype.toJSON` the whole artifact was the bare string
 * `"POLLUTED"`; under `Array.prototype` the `recordFiles` and `reasons` arrays
 * were. The status the job COMPUTED was right; the status it WROTE was not.
 *
 * `encodePlainJson` (`@polymarket-bot/risk/plain-json`) is byte-identical to
 * the clean `JSON.stringify(value, null, 2)` for plain data and never consults
 * `toJSON`. The artifact is plain by construction: strings, the file list, and
 * the evaluator's frozen result. A value the encoder refuses throws, and the
 * job fails rather than writing a status it cannot stand behind.
 *
 * Lives in `src/` (the `wal-frames.ts` precedent) so the job body and the
 * six-context pin in `soak-smoke.test.ts` drive ONE writer.
 */

import { encodePlainJson } from "../../../../packages/risk/src/plain-json.js";
import type { SoakEvaluation } from "../../../../packages/observability/src/recorder/index.js";

/** What the job records next to the evidence: when, where, which files, and the verdict. */
export interface SoakStatusArtifact {
  readonly generatedAt: string;
  readonly evidenceDir: string;
  readonly recordFiles: readonly string[];
  readonly evaluation: SoakEvaluation;
}

/** The artifact's file bytes: pretty-printed JSON with a trailing newline. */
export function renderSoakStatusArtifact(artifact: SoakStatusArtifact): string {
  return `${encodePlainJson(artifact, { indent: 2 })}\n`;
}
